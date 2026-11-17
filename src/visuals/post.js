import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Custom post passes. All work on the HDR linear scene buffer.
//   ScenePost  : depth-only ambient occlusion (half res, bilateral blur) + sun shafts (quarter res) +
//                screen-space reflections on the wet ground, composited
//   TAAPass    : temporal anti-aliasing (jitter is applied by render.js), reprojection from depth,
//                variance clipping, fast response to anything that suddenly gets brighter (flashes, tracers)
//   FinishPass : weapon depth of field when aiming, auto exposure, highlight roll-off + filmic tone map,
//                colour grade, vignette, light sharpen, grain/dither -> sRGB
// First-person weapons squash their depth to < 0.1 (weapons.js); that is the "viewmodel pixel" test used here.

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }';
const DEPTH = /* glsl */`
uniform sampler2D tDepth; uniform float uNear; uniform float uFar; uniform vec2 uInvProj;
float viewZ( vec2 uv ) { float d = textureLod( tDepth, uv, 0.0 ).x; return ( uNear * uFar ) / ( ( uFar - uNear ) * d - uFar ); }
vec3 viewPos( vec2 uv ) { float z = viewZ( uv ); return vec3( ( uv * 2.0 - 1.0 ) * uInvProj * - z, z ); }
`;

const mat = (uniforms, fragmentShader, extra = {}) => new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader, depthTest: false, depthWrite: false, toneMapped: false, ...extra });
// draw a full-screen material without clearing (keeps the scene depth attached to the composer buffers intact)
function blit(renderer, fsq, material, target) {
  const ac = renderer.autoClear; renderer.autoClear = false;
  fsq.material = material; renderer.setRenderTarget(target); fsq.render(renderer);
  renderer.autoClear = ac;
}
const rt = (w, h, type = THREE.UnsignedByteType, opts = {}) => new THREE.WebGLRenderTarget(w, h, { type, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, ...opts });

export class ScenePost extends Pass {
  constructor(camera, sunDir) {
    super();
    this.camera = camera; this.sunDir = sunDir;
    this.aoEnabled = true; this.raysEnabled = true; this.aoSamples = 10; this.ssrEnabled = true; this.temporal = false; this.frame = 0; this.sceneDepth = null; this.source = null;
    this.aoRT = rt(1, 1); this.aoRT2 = rt(1, 1);
    this.maskRT = rt(1, 1, THREE.HalfFloatType); this.raysRT = rt(1, 1, THREE.HalfFloatType);
    const depthU = () => ({ tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 1000 }, uInvProj: { value: new THREE.Vector2() } });

    this.aoMat = mat({ ...depthU(), uTexel: { value: new THREE.Vector2() }, uProjY: { value: 1 }, uAspect: { value: 1 }, uRadius: { value: 0.75 }, uPhase: { value: 0 } }, /* glsl */`
      #define SAMPLES 10
      ${DEPTH}
      uniform vec2 uTexel; uniform float uProjY; uniform float uAspect; uniform float uRadius; uniform float uPhase; varying vec2 vUv;
      // reconstruct from exact depth texel centres (the buffer is point sampled)
      vec3 vp( vec2 uv ) { vec2 res = 2.0 / uTexel; return viewPos( ( floor( uv * res ) + 0.5 ) / res ); }
      float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
      void main() {
        float d0 = textureLod( tDepth, vUv, 0.0 ).x;
        if ( d0 >= 0.99999 || d0 < 0.1 ) { gl_FragColor = vec4( 1.0 ); return; } // sky / first-person weapon
        vec2 t = uTexel * 0.5; // one full-resolution texel
        vec3 P = vp( vUv );
        vec3 Pr = vp( vUv + vec2( t.x, 0.0 ) ), Pl = vp( vUv - vec2( t.x, 0.0 ) );
        vec3 Pu = vp( vUv + vec2( 0.0, t.y ) ), Pd = vp( vUv - vec2( 0.0, t.y ) );
        vec3 dx = abs( Pr.z - P.z ) < abs( P.z - Pl.z ) ? Pr - P : P - Pl;
        vec3 dy = abs( Pu.z - P.z ) < abs( P.z - Pd.z ) ? Pu - P : P - Pd;
        vec3 N = normalize( cross( dx, dy ) );
        float rv = min( uRadius * uProjY * 0.5 / - P.z, 0.16 );
        vec2 rUv = vec2( rv / uAspect, rv );
        float rot = fract( ign( gl_FragCoord.xy ) + uPhase ) * 6.2831853, occ = 0.0, R2 = uRadius * uRadius;
        for ( int i = 0; i < SAMPLES; i ++ ) {
          float r = ( float( i ) + 0.5 ) / float( SAMPLES ), a = rot + float( i ) * 2.39996323;
          vec3 v = vp( vUv + vec2( cos( a ), sin( a ) ) * r * rUv ) - P;
          float vv = dot( v, v ), vn = dot( v, N ) - 0.012 * - P.z - 0.01;
          float f = max( R2 - vv, 0.0 ) / R2;
          occ += f * f * f * max( vn / ( vv + 0.0008 ), 0.0 );
        }
        float ao = clamp( 1.0 - occ * ( 1.9 * uRadius / float( SAMPLES ) ), 0.0, 1.0 );
        ao = mix( ao, 1.0, smoothstep( 45.0, 130.0, - P.z ) );
        gl_FragColor = vec4( ao, ao, ao, 1.0 );
      }`);

    this.blurMat = mat({ ...depthU(), tAO: { value: null }, uDir: { value: new THREE.Vector2() } }, /* glsl */`
      ${DEPTH}
      uniform sampler2D tAO; uniform vec2 uDir; varying vec2 vUv;
      void main() {
        float z0 = viewZ( vUv ), sum = textureLod( tAO, vUv, 0.0 ).r, w = 1.0;
        for ( int i = -3; i <= 3; i ++ ) {
          if ( i == 0 ) continue;
          vec2 uv = vUv + uDir * float( i );
          float k = max( 0.0, 1.0 - abs( viewZ( uv ) - z0 ) / ( 0.04 * - z0 + 0.03 ) ) * ( 1.0 - abs( float( i ) ) * 0.2 );
          sum += textureLod( tAO, uv, 0.0 ).r * k; w += k;
        }
        gl_FragColor = vec4( vec3( sum / w ), 1.0 );
      }`);

    this.maskMat = mat({ tDiffuse: { value: null }, tDepth: { value: null }, uSun: { value: new THREE.Vector2() }, uAspect: { value: 1 } }, /* glsl */`
      uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform vec2 uSun; uniform float uAspect; varying vec2 vUv;
      void main() {
        float sky = step( 0.99999, texture2D( tDepth, vUv ).x );
        vec3 c = min( texture2D( tDiffuse, vUv ).rgb, vec3( 12.0 ) );
        float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
        float w = smoothstep( 1.1, 0.0, length( ( vUv - uSun ) * vec2( uAspect, 1.0 ) ) );
        gl_FragColor = vec4( c * sky * smoothstep( 1.4, 4.0, l ) * w * w, 1.0 );
      }`);

    this.raysMat = mat({ tMask: { value: null }, uSun: { value: new THREE.Vector2() } }, /* glsl */`
      uniform sampler2D tMask; uniform vec2 uSun; varying vec2 vUv;
      float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
      void main() {
        const int N = 22;
        vec2 delta = ( uSun - vUv ) * ( 0.92 / float( N ) );
        vec2 uv = vUv + delta * ign( gl_FragCoord.xy );
        vec3 acc = vec3( 0.0 ); float decay = 1.0;
        for ( int i = 0; i < N; i ++ ) { acc += textureLod( tMask, uv, 0.0 ).rgb * decay; decay *= 0.955; uv += delta; }
        gl_FragColor = vec4( acc / float( N ), 1.0 );
      }`);

    this.compMat = mat({
      ...depthU(), tDiffuse: { value: null }, tAO: { value: null }, tRays: { value: null }, uAO: { value: 1 }, uRays: { value: 0 }, uRayTexel: { value: new THREE.Vector2() },
      uSSR: { value: 0 }, uMacro: { value: null }, uCamWorld: { value: new THREE.Matrix4() }, uUp: { value: new THREE.Vector3() }, uProj: { value: new THREE.Vector2() }, uPhase: { value: 0 },
    }, /* glsl */`
      ${DEPTH}
      uniform sampler2D tDiffuse; uniform sampler2D tAO; uniform sampler2D tRays; uniform float uAO; uniform float uRays; uniform vec2 uRayTexel;
      uniform float uSSR; uniform sampler2D uMacro; uniform mat4 uCamWorld; uniform vec3 uUp; uniform vec2 uProj; uniform float uPhase; varying vec2 vUv;
      float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
      vec2 toUv( vec3 p ) { return ( p.xy * uProj / - p.z ) * 0.5 + 0.5; }
      void main() {
        vec3 c = textureLod( tDiffuse, vUv, 0.0 ).rgb;
        if ( uAO > 0.0 ) {
          float ao = texture2D( tAO, vUv ).r;
          float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
          // occlusion mostly affects ambient light: fade it on brightly lit / emissive pixels
          float k = uAO * ( 1.0 - 0.65 * smoothstep( 0.35, 1.6, l ) );
          c *= mix( 1.0, ao * ao, k );
        }
        // reflections in the puddles: the ground is the plane y = 0 and its wet mask is the same world-space
        // noise the ground material uses (materials.js SURF_WET), so no G-buffer is needed
        if ( uSSR > 0.0 ) {
          float d = textureLod( tDepth, vUv, 0.0 ).x;
          if ( d > 0.1 && d < 0.9999 ) {
            vec3 P = viewPos( vUv ); vec3 W = ( uCamWorld * vec4( P, 1.0 ) ).xyz;
            if ( abs( W.y ) < 0.05 && - P.z < 90.0 ) {
              float lod = log2( 1.0 + ( - P.z ) * 0.035 );
              vec2 mc = W.xz * 0.037;
              float sW = textureLod( uMacro, mc * 0.21 + 0.37, lod - 2.2 ).a * 0.7 + textureLod( uMacro, mc, lod ).g * 0.3 - 0.035;
              float wet = smoothstep( 0.555, 0.60, sW );
              if ( wet > 0.02 ) {
                vec3 V = normalize( P ), R = reflect( V, uUp );
                float fres = 0.04 + 0.96 * pow( 1.0 - max( dot( - V, uUp ), 0.0 ), 5.0 );
                float t = 0.0, stepLen = max( 0.12, - P.z * 0.035 ), hit = 0.0; vec2 huv = vUv; vec3 p;
                float jit = fract( ign( gl_FragCoord.xy ) + uPhase );
                p = P + R * stepLen * jit;
                for ( int i = 0; i < 20; i ++ ) {
                  p += R * stepLen; stepLen *= 1.22;
                  if ( p.z > - 0.1 ) break;
                  vec2 uv = toUv( p );
                  if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) break;
                  float sd = textureLod( tDepth, uv, 0.0 ).x;
                  if ( sd < 0.1 ) continue; // never reflect the first-person weapon
                  float sz = ( uNear * uFar ) / ( ( uFar - uNear ) * sd - uFar );
                  float dz = sz - p.z; // > 0: the scene is in front of the ray
                  if ( dz > 0.0 && dz < stepLen * 1.6 + 0.4 ) { hit = 1.0; huv = uv; break; }
                }
                if ( hit > 0.0 ) {
                  vec2 e = min( huv, 1.0 - huv ); float edge = smoothstep( 0.0, 0.08, min( e.x, e.y ) );
                  vec3 rc = min( textureLod( tDiffuse, huv, 0.0 ).rgb, vec3( 6.0 ) );
                  c = mix( c, rc * 0.85, wet * fres * edge * uSSR * smoothstep( 90.0, 60.0, - P.z ) );
                }
              }
            }
          }
        }
        if ( uRays > 0.0 ) {
          vec2 o = uRayTexel * 1.5;
          c += ( texture2D( tRays, vUv + o ).rgb + texture2D( tRays, vUv - o ).rgb + texture2D( tRays, vUv + vec2( o.x, - o.y ) ).rgb + texture2D( tRays, vUv + vec2( - o.x, o.y ) ).rgb ) * ( 0.25 * uRays );
        }
        gl_FragColor = vec4( min( c, vec3( 48.0 ) ), 1.0 ); // keep explosions from blowing the bloom / history up
      }`);
    this.fsq = new FullScreenQuad(null);
    this._v = new THREE.Vector3();
  }

  setSize(w, h) {
    const hw = Math.max(1, Math.ceil(w / 2)), hh = Math.max(1, Math.ceil(h / 2));
    this.aoRT.setSize(hw, hh); this.aoRT2.setSize(hw, hh);
    const qw = Math.max(1, Math.ceil(w / 4)), qh = Math.max(1, Math.ceil(h / 4));
    this.maskRT.setSize(qw, qh); this.raysRT.setSize(qw, qh); this.compMat.uniforms.uRayTexel.value.set(1 / qw, 1 / qh);
    this.w = w; this.h = h;
  }

  draw(renderer, material, target) { blit(renderer, this.fsq, material, target); }

  render(renderer, writeBuffer, readBuffer) {
    // the scene (colour + depth) lives in its own target so no later pass ever writes to a buffer whose depth it reads
    if (this.source) readBuffer = this.source;
    const cam = this.camera, depth = readBuffer.depthTexture;
    const P = cam.projectionMatrix.elements;
    const setDepth = (m) => { const u = m.uniforms; u.tDepth.value = depth; u.uNear.value = cam.near; u.uFar.value = cam.far; u.uInvProj.value.set(1 / P[0], 1 / P[5]); };
    const comp = this.compMat.uniforms;
    this.sceneDepth = depth; this.frame++;
    const phase = this.temporal ? (this.frame * 0.61803398875) % 1 : 0;

    if (this.aoEnabled && depth) {
      const a = this.aoMat; setDepth(a);
      if (this._aoS !== this.aoSamples) { a.fragmentShader = a.fragmentShader.replace(/#define SAMPLES \d+/, `#define SAMPLES ${this.aoSamples}`); a.needsUpdate = true; this._aoS = this.aoSamples; }
      a.uniforms.uPhase.value = phase; a.uniforms.uTexel.value.set(2 / this.w, 2 / this.h); a.uniforms.uProjY.value = P[5]; a.uniforms.uAspect.value = cam.aspect;
      this.draw(renderer, a, this.aoRT);
      const b = this.blurMat; setDepth(b);
      b.uniforms.tAO.value = this.aoRT.texture; b.uniforms.uDir.value.set(2 / this.w, 0); this.draw(renderer, b, this.aoRT2);
      b.uniforms.tAO.value = this.aoRT2.texture; b.uniforms.uDir.value.set(0, 2 / this.h); this.draw(renderer, b, this.aoRT);
      comp.tAO.value = this.aoRT.texture; comp.uAO.value = 1;
    } else comp.uAO.value = 0;

    // sun shafts: only when the sun is in front of the camera
    let rays = 0;
    if (this.raysEnabled && depth) {
      const v = this._v.copy(this.sunDir).multiplyScalar(1000).add(cam.position).applyMatrix4(cam.matrixWorldInverse);
      if (v.z < 0) {
        v.applyMatrix4(cam.projectionMatrix);
        const sx = v.x * 0.5 + 0.5, sy = v.y * 0.5 + 0.5;
        const off = Math.max(Math.abs(v.x), Math.abs(v.y));
        rays = THREE.MathUtils.clamp((1.7 - off) / 0.6, 0, 1);
        if (rays > 0) {
          const m = this.maskMat.uniforms; m.tDiffuse.value = readBuffer.texture; m.tDepth.value = depth; m.uSun.value.set(sx, sy); m.uAspect.value = cam.aspect;
          this.draw(renderer, this.maskMat, this.maskRT);
          const r = this.raysMat.uniforms; r.tMask.value = this.maskRT.texture; r.uSun.value.set(sx, sy);
          this.draw(renderer, this.raysMat, this.raysRT);
          comp.tRays.value = this.raysRT.texture;
        }
      }
    }
    comp.uRays.value = rays * 0.4;
    setDepth(this.compMat);
    comp.uSSR.value = this.ssrEnabled && depth && this.macro ? 1 : 0;
    if (comp.uSSR.value) {
      comp.uMacro.value = this.macro; comp.uCamWorld.value.copy(cam.matrixWorld); comp.uPhase.value = phase;
      comp.uUp.value.set(0, 1, 0).transformDirection(cam.matrixWorldInverse); comp.uProj.value.set(P[0], P[5]);
    }
    comp.tDiffuse.value = readBuffer.texture;
    this.draw(renderer, this.compMat, this.renderToScreen ? null : writeBuffer);
  }
}

export class TAAPass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera; this.depthSource = null; // () => scene depth texture
    this.histA = rt(1, 1, THREE.HalfFloatType); this.histB = rt(1, 1, THREE.HalfFloatType);
    this.reset = true; this.prevVP = new THREE.Matrix4(); this.curVP = new THREE.Matrix4(); this.inv = new THREE.Matrix4();
    this.proj = new THREE.Matrix4(); // un-jittered projection, set by render.js every frame
    this.material = mat({
      tDiffuse: { value: null }, tHist: { value: null }, tDepth: { value: null }, uReproj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() }, uReset: { value: 1 },
    }, /* glsl */`
      uniform sampler2D tDiffuse; uniform sampler2D tHist; uniform sampler2D tDepth; uniform mat4 uReproj; uniform vec2 uTexel; uniform float uReset; varying vec2 vUv;
      float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
      vec3 tm( vec3 c ) { return c / ( 1.0 + luma( c ) ); }      // reversible tone map: stops bright pixels dominating
      vec3 itm( vec3 c ) { return c / max( 1.0 - luma( c ), 0.02 ); }
      vec3 cur( vec2 o ) { return tm( textureLod( tDiffuse, vUv + o * uTexel, 0.0 ).rgb ); }
      // 5-tap Catmull-Rom: keeps the history sharp while it is resampled under motion
      vec3 history( vec2 uv ) {
        vec2 sp = uv / uTexel, tc = floor( sp - 0.5 ) + 0.5, f = sp - tc;
        vec2 w0 = f * ( - 0.5 + f * ( 1.0 - 0.5 * f ) ), w1 = 1.0 + f * f * ( - 2.5 + 1.5 * f ), w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f ) ), w3 = f * f * ( - 0.5 + 0.5 * f );
        vec2 w12 = w1 + w2, t0 = ( tc - 1.0 ) * uTexel, t3 = ( tc + 2.0 ) * uTexel, t12 = ( tc + w2 / w12 ) * uTexel;
        vec4 r = vec4( textureLod( tHist, vec2( t12.x, t0.y ), 0.0 ).rgb, 1.0 ) * ( w12.x * w0.y )
               + vec4( textureLod( tHist, vec2( t0.x, t12.y ), 0.0 ).rgb, 1.0 ) * ( w0.x * w12.y )
               + vec4( textureLod( tHist, vec2( t12.x, t12.y ), 0.0 ).rgb, 1.0 ) * ( w12.x * w12.y )
               + vec4( textureLod( tHist, vec2( t3.x, t12.y ), 0.0 ).rgb, 1.0 ) * ( w3.x * w12.y )
               + vec4( textureLod( tHist, vec2( t12.x, t3.y ), 0.0 ).rgb, 1.0 ) * ( w12.x * w3.y );
        return max( r.rgb / r.a, 0.0 );
      }
      void main() {
        vec3 c = cur( vec2( 0.0 ) );
        if ( uReset > 0.5 ) { gl_FragColor = vec4( itm( c ), 1.0 ); return; }
        // nearest depth in a cross: edges follow the foreground object
        float d = textureLod( tDepth, vUv, 0.0 ).x;
        d = min( d, min( min( textureLod( tDepth, vUv + vec2( uTexel.x, 0.0 ), 0.0 ).x, textureLod( tDepth, vUv - vec2( uTexel.x, 0.0 ), 0.0 ).x ),
                         min( textureLod( tDepth, vUv + vec2( 0.0, uTexel.y ), 0.0 ).x, textureLod( tDepth, vUv - vec2( 0.0, uTexel.y ), 0.0 ).x ) ) );
        bool vm = d < 0.1; // first-person weapon: moves with the camera, so its history is in the same place on screen
        vec2 prev = vUv;
        if ( ! vm ) { vec4 q = uReproj * vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 ); prev = q.xy / q.w * 0.5 + 0.5; }
        // neighbourhood statistics for variance clipping
        vec3 m1 = c, m2 = c * c, mn = c, mx = c, s;
        s = cur( vec2( 1.0, 0.0 ) ); m1 += s; m2 += s * s; mn = min( mn, s ); mx = max( mx, s );
        s = cur( vec2( - 1.0, 0.0 ) ); m1 += s; m2 += s * s; mn = min( mn, s ); mx = max( mx, s );
        s = cur( vec2( 0.0, 1.0 ) ); m1 += s; m2 += s * s; mn = min( mn, s ); mx = max( mx, s );
        s = cur( vec2( 0.0, - 1.0 ) ); m1 += s; m2 += s * s; mn = min( mn, s ); mx = max( mx, s );
        s = cur( vec2( 1.0, 1.0 ) ); m1 += s; m2 += s * s; mn = min( mn, s ); mx = max( mx, s );
        s = cur( vec2( - 1.0, 1.0 ) ); m1 += s; m2 += s * s; mn = min( mn, s ); mx = max( mx, s );
        s = cur( vec2( 1.0, - 1.0 ) ); m1 += s; m2 += s * s; mn = min( mn, s ); mx = max( mx, s );
        s = cur( vec2( - 1.0, - 1.0 ) ); m1 += s; m2 += s * s; mn = min( mn, s ); mx = max( mx, s );
        vec3 mean = m1 / 9.0, sd = sqrt( max( m2 / 9.0 - mean * mean, 0.0 ) );
        float motion = length( ( prev - vUv ) / uTexel );
        float gamma = vm ? 1.0 : mix( 1.6, 1.0, clamp( motion * 0.5, 0.0, 1.0 ) ); // tighter clip while moving = less ghosting
        vec3 lo = max( mn, mean - sd * gamma ), hi = min( mx, mean + sd * gamma );
        vec3 h = tm( history( prev ) );
        vec3 hc = clamp( h, lo, hi );
        float a = vm ? 0.18 : mix( 0.07, 0.16, clamp( motion * 0.25, 0.0, 1.0 ) );
        if ( prev.x < 0.0 || prev.x > 1.0 || prev.y < 0.0 || prev.y > 1.0 ) a = 1.0;
        // anything that just became much brighter (muzzle flash, tracer, spark) shows at once instead of fading in
        float lc = luma( c ), lh = luma( hc );
        a = max( a, 0.85 * smoothstep( 0.6, 0.85, ( lc - lh ) / max( lc, 0.001 ) ) * step( 0.12, lc ) );
        gl_FragColor = vec4( itm( mix( hc, c, a ) ), 1.0 );
      }`);
    this.copyMat = mat({ tDiffuse: { value: null } }, 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ gl_FragColor = textureLod( tDiffuse, vUv, 0.0 ); }');
    this.fsq = new FullScreenQuad(null);
  }

  setSize(w, h) { this.histA.setSize(w, h); this.histB.setSize(w, h); this.material.uniforms.uTexel.value.set(1 / w, 1 / h); this.reset = true; }

  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera, u = this.material.uniforms;
    this.curVP.multiplyMatrices(this.proj, cam.matrixWorldInverse);
    u.uReproj.value.multiplyMatrices(this.prevVP, this.inv.copy(this.curVP).invert());
    u.tDiffuse.value = readBuffer.texture; u.tHist.value = this.histA.texture; u.tDepth.value = this.depthSource ? this.depthSource() : null;
    u.uReset.value = this.reset || !u.tDepth.value ? 1 : 0;
    blit(renderer, this.fsq, this.material, this.histB);
    const t = this.histA; this.histA = this.histB; this.histB = t;
    this.prevVP.copy(this.curVP); this.reset = false;
    this.copyMat.uniforms.tDiffuse.value = this.histA.texture;
    blit(renderer, this.fsq, this.copyMat, this.renderToScreen ? null : writeBuffer);
  }
}

export class FinishPass extends Pass {
  constructor() {
    super();
    this.autoExposure = true;
    // key/comp: exposure = key * avgLuminance^-comp, clamped to [min, max]; up/down = adaptation speed (1/s)
    this.exposure = { key: 0.235, comp: 0.6, min: 0.62, max: 2.6, up: 1.8, down: 0.9, fixed: 1.0 };
    this.depthSource = null; this.dof = 0; // 0..1, set by render.js while aiming
    this.camera = null;
    this.lumRT = rt(32, 32, THREE.HalfFloatType, { minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true });
    this.adaptA = rt(1, 1, THREE.HalfFloatType, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.adaptB = rt(1, 1, THREE.HalfFloatType, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.first = true;

    // Metering. Luminance is clamped low so a muzzle flash or explosion barely moves the average, sky and the
    // first-person weapon count for less than the world, and the centre of the view counts for more.
    this.lumMat = mat({ tDiffuse: { value: null }, tDepth: { value: null }, uHasDepth: { value: 0 } }, /* glsl */`
      uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform float uHasDepth; varying vec2 vUv;
      void main() {
        float s = 0.0, ws = 0.0;
        for ( int y = 0; y < 4; y ++ ) for ( int x = 0; x < 4; x ++ ) {
          vec2 uv = vUv + ( vec2( float( x ), float( y ) ) - 1.5 ) / 128.0;
          vec3 c = textureLod( tDiffuse, uv, 0.0 ).rgb;
          float w = 1.0;
          if ( uHasDepth > 0.5 ) { float d = textureLod( tDepth, uv, 0.0 ).x; w = d >= 0.99999 ? 0.3 : ( d < 0.1 ? 0.5 : 1.0 ); }
          s += log( clamp( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.004, 2.5 ) ) * w; ws += w;
        }
        vec2 d = vUv - 0.5; float w = ( 1.0 - 0.75 * smoothstep( 0.1, 0.5, length( d ) ) ) * ws / 16.0;
        gl_FragColor = vec4( s / ws * w, w, 0.0, 1.0 );
      }`);
    this.adaptMat = mat({ tLum: { value: null }, tPrev: { value: null }, uUp: { value: 1 }, uDown: { value: 1 }, uFirst: { value: 1 }, uKey: { value: 0.2 }, uComp: { value: 0.7 }, uMin: { value: 0.5 }, uMax: { value: 2 } }, /* glsl */`
      uniform sampler2D tLum; uniform sampler2D tPrev; uniform float uUp; uniform float uDown; uniform float uFirst; uniform float uKey; uniform float uComp; uniform float uMin; uniform float uMax; varying vec2 vUv;
      void main() {
        vec4 l = textureLod( tLum, vec2( 0.5 ), 5.0 );
        float avg = exp( l.r / max( l.g, 0.0001 ) );
        float target = clamp( uKey * pow( avg, - uComp ), uMin, uMax );
        float prev = texture2D( tPrev, vec2( 0.5 ) ).r;
        float k = uFirst > 0.5 ? 1.0 : ( target > prev ? uUp : uDown ); // eyes open up faster than they stop down
        gl_FragColor = vec4( mix( prev, target, k ), avg, 0.0, 1.0 );
      }`);
    this.material = mat({
      tDiffuse: { value: null }, tExposure: { value: null }, tDepth: { value: null }, uFixed: { value: 0 }, uSpeed: { value: 0 }, uTime: { value: 0 },
      uTexel: { value: new THREE.Vector2() }, uSharpen: { value: 0.35 }, uGrain: { value: 1 },
      uDof: { value: 0 }, uNear: { value: 0.08 }, uFar: { value: 3000 }, uAspect: { value: 1 },
    }, /* glsl */`
      uniform sampler2D tDiffuse; uniform sampler2D tExposure; uniform sampler2D tDepth; uniform float uFixed; uniform float uSpeed; uniform float uTime;
      uniform vec2 uTexel; uniform float uSharpen; uniform float uGrain; uniform float uDof; uniform float uNear; uniform float uFar; uniform float uAspect; varying vec2 vUv;
      vec3 fmFit( vec3 v ) { vec3 a = v * ( v + 0.0245786 ) - 0.000090537; vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081; return a / b; }
      vec3 filmic( vec3 color ) {
        const mat3 I = mat3( vec3( 0.59719, 0.07600, 0.02840 ), vec3( 0.35458, 0.90834, 0.13383 ), vec3( 0.04823, 0.01566, 0.83777 ) );
        const mat3 O = mat3( vec3( 1.60475, -0.10208, -0.00327 ), vec3( -0.53108, 1.10813, -0.07276 ), vec3( -0.07367, -0.00605, 1.07602 ) );
        color = I * ( color / 0.6 ); color = fmFit( color ); return clamp( O * color, 0.0, 1.0 );
      }
      float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
      // circle of confusion of a first-person weapon pixel: the part of the gun close to the eye goes soft when aiming
      float coc( vec2 uv ) {
        float d = textureLod( tDepth, uv, 0.0 ).x;
        if ( d >= 0.1 ) return 0.0;
        d *= 10.0; // undo the viewmodel depth squash
        float dist = ( uNear * uFar ) / ( uFar - ( uFar - uNear ) * d );
        return clamp( ( 0.40 - dist ) / 0.22, 0.0, 1.0 );
      }
      const vec2 disc[12] = vec2[12]( vec2( 0.29, 0.0 ), vec2( -0.37, 0.34 ), vec2( 0.06, -0.64 ), vec2( 0.46, 0.6 ), vec2( -0.86, -0.09 ), vec2( 0.8, -0.52 ),
        vec2( -0.2, 1.0 ), vec2( -0.54, -0.98 ), vec2( 1.13, 0.35 ), vec2( -1.15, 0.54 ), vec2( 0.55, -1.2 ), vec2( 0.4, 1.3 ) );
      void main() {
        vec2 c = vUv - 0.5; float r2 = dot( c, c );
        float ca = ( 0.0006 + 0.004 * uSpeed ) * r2 * 4.0;
        vec3 mid = textureLod( tDiffuse, vUv, 0.0 ).rgb;
        vec3 col = vec3( textureLod( tDiffuse, vUv + c * ca, 0.0 ).r, mid.g, textureLod( tDiffuse, vUv - c * ca, 0.0 ).b );
        float blurred = 0.0;
        if ( uDof > 0.0 ) {
          // scatter-as-gather near blur: a tap contributes if ITS blur disc reaches this pixel, so the soft
          // receiver spreads over the background while the sight picture and the world stay sharp
          float self = coc( vUv ) * uDof, maxR = 0.008;
          float a = ign( gl_FragCoord.xy ) * 6.2831853; mat2 rot = mat2( cos( a ), sin( a ), - sin( a ), cos( a ) );
          vec3 acc = vec3( 0.0 ); float wsum = 0.0;
          for ( int i = 0; i < 12; i ++ ) {
            vec2 o = rot * disc[ i ] * ( maxR / 1.35 ); vec2 uv = vUv + vec2( o.x / uAspect, o.y );
            float w = smoothstep( 0.0, 0.25, coc( uv ) * uDof - length( disc[ i ] ) / 1.35 + 0.12 );
            acc += textureLod( tDiffuse, uv, 0.0 ).rgb * w; wsum += w;
          }
          float keep = max( 1.0 - self * 1.6, 0.0 ) * 6.0 + 0.6;
          col = ( col * keep + acc ) / ( keep + wsum ); mid = col; blurred = clamp( wsum / 6.0, 0.0, 1.0 );
        }
        if ( uSharpen > 0.0 ) {
          vec3 blur = ( textureLod( tDiffuse, vUv + vec2( uTexel.x, 0.0 ), 0.0 ).rgb + textureLod( tDiffuse, vUv - vec2( uTexel.x, 0.0 ), 0.0 ).rgb
                      + textureLod( tDiffuse, vUv + vec2( 0.0, uTexel.y ), 0.0 ).rgb + textureLod( tDiffuse, vUv - vec2( 0.0, uTexel.y ), 0.0 ).rgb ) * 0.25;
          vec3 hi = textureLod( tDiffuse, vUv, 0.0 ).rgb - blur; float lim = 0.18 * ( dot( mid, vec3( 0.333 ) ) + 0.05 );
          col = max( col + clamp( hi, - lim, lim ) * uSharpen * ( 1.0 - blurred ), 0.0 );
        }
        float ev = uFixed > 0.0 ? uFixed : texture2D( tExposure, vec2( 0.5 ) ).r;
        col *= ev;
        col *= 1.0 - smoothstep( 0.16, 0.98, r2 * 1.9 ) * ( 0.30 + 0.22 * uSpeed );
        // highlight roll-off: very bright sources (muzzle flash, explosion cores, the sun) are compressed along
        // their own hue before the film curve, so they keep colour instead of clipping to flat white
        float pk = max( col.r, max( col.g, col.b ) );
        if ( pk > 1.6 ) col *= ( 1.6 + ( pk - 1.6 ) / ( 1.0 + ( pk - 1.6 ) * 0.22 ) ) / pk;
        vec3 film = filmic( col );
        pk = max( col.r, max( col.g, col.b ) );
        vec3 hue = col / max( pk, 0.0001 ) * filmic( vec3( pk ) ).r;
        col = mix( film, hue, 0.4 * smoothstep( 0.8, 3.0, pk ) );
        // grade: gentle contrast, cool shadows / warm highlights, a touch of saturation
        float l = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
        col = mix( col, col * col * ( 3.0 - 2.0 * col ), 0.16 );
        col *= mix( vec3( 0.93, 1.0, 1.08 ), vec3( 1.05, 1.0, 0.95 ), smoothstep( 0.0, 0.55, l ) );
        col = mix( vec3( dot( col, vec3( 0.2126, 0.7152, 0.0722 ) ) ), col, 1.07 );
        col = clamp( col, 0.0, 1.0 );
        col = mix( col * 12.92, 1.055 * pow( col, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, col ) );
        vec2 gp = gl_FragCoord.xy + fract( uTime * vec2( 7.31, 3.17 ) ) * 517.0;
        float n = fract( sin( dot( gp, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) - 0.5;
        col += n * ( 1.0 / 255.0 + 0.007 * uGrain * ( 1.0 - l ) );
        gl_FragColor = vec4( col, 1.0 );
      }`);
    this.fsq = new FullScreenQuad(null);
  }

  setSize(w, h) { this.material.uniforms.uTexel.value.set(1 / w, 1 / h); this.material.uniforms.uAspect.value = w / h; }

  render(renderer, writeBuffer, readBuffer, dt) {
    const u = this.material.uniforms, e = this.exposure, depth = this.depthSource ? this.depthSource() : null;
    dt = dt || 0.016;
    if (this.autoExposure) {
      const lu = this.lumMat.uniforms; lu.tDiffuse.value = readBuffer.texture; lu.tDepth.value = depth; lu.uHasDepth.value = depth ? 1 : 0;
      blit(renderer, this.fsq, this.lumMat, this.lumRT);
      const a = this.adaptMat.uniforms;
      a.tLum.value = this.lumRT.texture; a.tPrev.value = this.adaptA.texture;
      a.uFirst.value = this.first ? 1 : 0; a.uUp.value = 1 - Math.exp(-dt * e.up); a.uDown.value = 1 - Math.exp(-dt * e.down);
      a.uKey.value = e.key; a.uComp.value = e.comp; a.uMin.value = e.min; a.uMax.value = e.max;
      blit(renderer, this.fsq, this.adaptMat, this.adaptB);
      const t = this.adaptA; this.adaptA = this.adaptB; this.adaptB = t;
      this.first = false;
      u.tExposure.value = this.adaptA.texture; u.uFixed.value = 0;
    } else u.uFixed.value = e.fixed;
    u.tDepth.value = depth; u.uDof.value = depth ? this.dof : 0;
    if (this.camera) { u.uNear.value = this.camera.near; u.uFar.value = this.camera.far; }
    u.tDiffuse.value = readBuffer.texture; u.uTime.value = (u.uTime.value + dt) % 100;
    blit(renderer, this.fsq, this.material, this.renderToScreen ? null : writeBuffer);
  }
}
