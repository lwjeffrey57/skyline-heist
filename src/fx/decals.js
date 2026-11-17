import * as THREE from 'three';

// Instanced decals: bullet holes, scorch marks and animated ground rings. One draw call.
// World pieces are axis-aligned boxes, so every decal is an axis-aligned quad on a box face that is
// CLIPPED to that face on the CPU (no overhang past edges). Each slot remembers its collider so the
// decal vanishes with the piece (see dropCollider).

export const DECAL_CONCRETE = 0, DECAL_METAL = 1, DECAL_SCORCH = 2, DECAL_RING = 3;
const STRIDE = 20;
const N_HOLES = 256, N_SCORCH = 40, N_RINGS = 24;
export const DECAL_CAP = N_HOLES + N_SCORCH + N_RINGS;

const VERT = /* glsl */`
attribute vec2 aCorner;
attribute vec4 aCenter; // xyz, half-size
attribute vec4 aNormal; // xyz, seed
attribute vec4 aClip;   // u0, u1, v0, v1 (in -1..1 quad space)
attribute vec4 aInfo;   // birth, type, life, alpha
attribute vec4 aTint;   // rgb, -
uniform float uTime; uniform float uFogDensity;
varying vec2 vUv; varying vec4 vInfo; varying vec3 vTint; varying float vFog; varying float vLit;
void main() {
  float age = uTime - aInfo.x; vLit = aTint.w;
  vUv = vec2(0.0); vInfo = vec4(0.0); vTint = vec3(0.0); vFog = 0.0;
  if (aInfo.z <= 0.0 || age < 0.0 || age >= aInfo.z) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 n = aNormal.xyz;
  vec3 t = abs(n.y) > 0.5 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), n));
  vec3 b = cross(n, t);
  vec2 uv = vec2(clamp(aCorner.x, aClip.x, aClip.y), clamp(aCorner.y, aClip.z, aClip.w));
  vec3 p = aCenter.xyz + (t * uv.x + b * uv.y) * aCenter.w;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  mv.xyz += normalize(-mv.xyz) * min(0.004 + dist * 0.0012, 0.2);  // pull toward the eye: no z-fighting at range
  gl_Position = projectionMatrix * mv;
  vUv = uv; vInfo = vec4(age, aInfo.y, aNormal.w, aInfo.w * (1.0 - smoothstep(0.8, 1.0, age / aInfo.z)));
  vTint = aTint.rgb;
  vFog = 1.0 - exp(-uFogDensity * dist);
}`;

const FRAG = /* glsl */`
uniform vec3 uLight; uniform vec3 uFogColor; uniform float uTime;
varying vec2 vUv; varying vec4 vInfo; varying vec3 vTint; varying float vFog; varying float vLit;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float r = length(vUv);
  if (r >= 1.0) discard;
  float age = vInfo.x, type = vInfo.y, seed = vInfo.z;
  vec2 dir = vUv / max(r, 1e-4);
  float an = noise(dir * 2.3 + seed * 17.0);
  float an2 = noise(dir * 5.0 + seed * 31.0);
  vec3 col = vec3(0.0), glow = vec3(0.0); float a = 0.0;
  if (type < 0.5) {            // concrete: dark pit, pale chipped crater, hairline cracks
    float pit = 1.0 - smoothstep(0.16, 0.27, r * (0.8 + 0.45 * an));
    float crater = 1.0 - smoothstep(0.35, 0.8, r * (0.8 + 0.45 * an2));
    float crack = pow(abs(sin(atan(vUv.y, vUv.x) * 2.5 + seed * 40.0 + an * 3.0)), 90.0) * (1.0 - smoothstep(0.3, 0.9, r));
    vec3 chip = mix(vTint, vec3(0.5, 0.48, 0.45), 0.4) * (0.8 + 0.4 * noise(vUv * 9.0 + seed)) * uLight * vLit * 1.05;
    col = mix(chip, vec3(0.01), max(pit, crack * 0.85));
    a = max(pit, max(crater * 0.6, crack * 0.55));
    glow = vec3(3.0, 1.1, 0.25) * pit * exp(-age * 9.0);
  } else if (type < 1.5) {     // metal: punched hole, bare bright rim, soot halo, cooling glow
    float pit = 1.0 - smoothstep(0.14, 0.2, r * (0.9 + 0.25 * an));
    float rim = (1.0 - smoothstep(0.24, 0.4, r * (0.85 + 0.4 * an2))) * (1.0 - pit);
    float soot = (1.0 - smoothstep(0.3, 1.0, r * (0.8 + 0.5 * an))) * 0.45;
    col = mix(vec3(0.015), vec3(0.62, 0.64, 0.68) * uLight * vLit * (0.7 + 0.5 * an2), rim);
    a = max(pit, max(rim * 0.9, soot));
    glow = vec3(5.0, 1.6, 0.3) * (1.0 - smoothstep(0.1, 0.45, r)) * exp(-age * 2.8);
  } else if (type < 2.5) {     // scorch: ragged soot with radial streaks and dying embers
    float n = noise(vUv * 3.0 + seed * 9.0) * 0.6 + noise(vUv * 8.0 + seed * 3.0) * 0.4;
    float streak = noise(vec2(atan(vUv.y, vUv.x) * 5.0, seed * 7.0));
    float body = 1.0 - smoothstep(0.12, 0.98, r + (n - 0.5) * 0.45 + (streak - 0.5) * 0.3 * r);
    col = mix(vec3(0.03, 0.026, 0.022), vec3(0.008), body);
    a = body * 0.9 * min(1.0, age * 12.0);
    float ember = smoothstep(0.62, 0.9, noise(vUv * 14.0 + seed * 5.0)) * (1.0 - smoothstep(0.1, 0.7, r));
    glow = vec3(6.0, 1.7, 0.25) * ember * exp(-age * 0.9) * (0.7 + 0.3 * sin(uTime * 9.0 + seed * 50.0 + r * 20.0));
  } else {                     // expanding ring (shockwave / pad pulse): additive
    float prog = clamp(age * vTint.r, 0.0, 1.0);   // vTint.r = 1 / duration for rings
    float e = 1.0 - (1.0 - prog) * (1.0 - prog);
    float d = (r - e * 0.92) / (0.05 + 0.1 * prog);
    float band = exp(-d * d) * (1.0 - prog) * (1.0 - prog);
    float inner = (1.0 - smoothstep(0.0, e * 0.92, r)) * 0.12 * (1.0 - prog);
    glow = vec3(vTint.g, vTint.b, fract(seed) * 8.0) * (band + inner);
    a = 0.0;
  }
  a *= vInfo.w;
  float keep = 1.0 - vFog;
  gl_FragColor = vec4((col * a + glow * vInfo.w) * keep, a * keep);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Decals {
  constructor() {
    this.data = new Float32Array(DECAL_CAP * STRIDE);
    this.owner = new Array(DECAL_CAP).fill(null);
    this.live = 0;
    const ib = this.ib = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    ib.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    ['aCenter', 'aNormal', 'aClip', 'aInfo', 'aTint'].forEach((n, i) => g.setAttribute(n, new THREE.InterleavedBufferAttribute(ib, 4, i * 4)));
    g.instanceCount = DECAL_CAP;
    this.uniforms = {
      uTime: { value: 0 }, uFogColor: { value: new THREE.Color() }, uFogDensity: { value: 0.003 }, uLight: { value: new THREE.Vector3(1, 1, 1) },
    };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 5; this.mesh.matrixAutoUpdate = false; this.mesh.name = 'fx-decals';
    this.heads = [0, 0, 0]; this.time = 0; this.light = 1;
  }

  // type picks the ring (holes / scorch / rings). collider (optional) clips the quad to the hit face.
  add(type, px, py, pz, nx, ny, nz, half, life, alpha, collider, tr = 0, tg = 0, tb = 0, seedExtra = 0) {
    const grp = type === DECAL_SCORCH ? 1 : type === DECAL_RING ? 2 : 0;
    const base = grp === 0 ? 0 : grp === 1 ? N_HOLES : N_HOLES + N_SCORCH, n = grp === 0 ? N_HOLES : grp === 1 ? N_SCORCH : N_RINGS;
    const i = base + this.heads[grp]; this.heads[grp] = (this.heads[grp] + 1) % n;
    const d = this.data, o = i * STRIDE;
    let u0 = -1, u1 = 1, v0 = -1, v1 = 1;
    if (collider && collider.min) {
      // same basis as the shader: t = +X for floors/ceilings, cross(up, n) for walls; b = cross(n, t)
      const mn = collider.min, mx = collider.max, inv = 1 / half;
      if (Math.abs(ny) > 0.5) {          // t = +x, b = (0,0,-ny)
        u0 = (mn.x - px) * inv; u1 = (mx.x - px) * inv;
        if (ny > 0) { v0 = (pz - mx.z) * inv; v1 = (pz - mn.z) * inv; } else { v0 = (mn.z - pz) * inv; v1 = (mx.z - pz) * inv; }
        py = ny > 0 ? mx.y : mn.y;
      } else if (Math.abs(nx) > 0.5) {   // t = (0,0,-nx), b = +y
        if (nx > 0) { u0 = (pz - mx.z) * inv; u1 = (pz - mn.z) * inv; } else { u0 = (mn.z - pz) * inv; u1 = (mx.z - pz) * inv; }
        v0 = (mn.y - py) * inv; v1 = (mx.y - py) * inv;
      } else if (Math.abs(nz) > 0.5) {   // t = (nz,0,0), b = +y
        if (nz > 0) { u0 = (mn.x - px) * inv; u1 = (mx.x - px) * inv; } else { u0 = (px - mx.x) * inv; u1 = (px - mn.x) * inv; }
        v0 = (mn.y - py) * inv; v1 = (mx.y - py) * inv;
      }
      u0 = Math.max(-1, u0); u1 = Math.min(1, u1); v0 = Math.max(-1, v0); v1 = Math.min(1, v1);
      if (u0 >= u1 || v0 >= v1) return -1;
    }
    d[o] = px; d[o + 1] = py; d[o + 2] = pz; d[o + 3] = half;
    d[o + 4] = nx; d[o + 5] = ny; d[o + 6] = nz; d[o + 7] = Math.floor(Math.random() * 97) + seedExtra;
    d[o + 8] = u0; d[o + 9] = u1; d[o + 10] = v0; d[o + 11] = v1;
    d[o + 12] = this.time; d[o + 13] = type; d[o + 14] = life; d[o + 15] = alpha;
    d[o + 16] = tr; d[o + 17] = tg; d[o + 18] = tb; d[o + 19] = this.light;
    this.owner[i] = collider || null;
    this.ib.needsUpdate = true;
    return i;
  }

  // additive expanding ring; colour is HDR rgb
  ring(px, py, pz, nx, ny, nz, radius, duration, r, g, b, intensity = 1) {
    // rings pack: tint.r = 1/duration, tint.g = red, tint.b = green, blue rides in the seed fraction (b/8)
    return this.add(DECAL_RING, px, py, pz, nx, ny, nz, radius, duration, intensity, null, 1 / duration, r, g, Math.min(0.999, b / 8));
  }

  // remove everything stuck to a world piece that no longer exists
  dropCollider(c) {
    const ow = this.owner, d = this.data; let hit = false;
    for (let i = 0; i < DECAL_CAP; i++) if (ow[i] === c) { ow[i] = null; d[i * STRIDE + 14] = 0; hit = true; }
    if (hit) this.ib.needsUpdate = true;
    return hit;
  }

  countLive() {
    let n = 0; const d = this.data;
    for (let i = 0; i < DECAL_CAP; i++) { const life = d[i * STRIDE + 14]; if (life > 0 && this.time - d[i * STRIDE + 12] < life) n++; }
    return n;
  }

  setTime(t) { this.time = t; this.uniforms.uTime.value = t; }
}
