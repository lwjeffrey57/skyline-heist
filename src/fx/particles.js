import * as THREE from 'three';

// GPU particle system. One draw call per system. Particles are STATELESS on the CPU: a spawn writes
// 28 floats into a ring buffer and the vertex shader integrates position/size/colour from (uTime - birth).
// Nothing is iterated per frame. Blending is premultiplied, so one system mixes additive (fire, sparks)
// and alpha-blended (smoke, dust) particles; each particle carries its own "additive" factor.
//
// NOTE: the quad corners live in `aCorner`; `position` is all zeros on purpose so passes that render the
// scene with an override material (GTAO normal pass) rasterise nothing for these meshes.

export const TILE_GLOW = 0, TILE_SMOKE = 1, TILE_CHIP = 2, TILE_RING = 3, TILE_STAR_A = 4, TILE_STAR_B = 5, TILE_BLAST = 6, TILE_SHARD = 7;
const STRIDE = 28;

// ---- sprite atlas (4x2 tiles; R = alpha mask, G = shading) ----------------------------------------------
let _atlas = null;
export function getAtlas() {
  if (_atlas) return _atlas;
  const T = 128, SW = T * 4, SH = T * 2;
  const data = new Uint8Array(SW * SH * 4);
  let seed = 1337;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // tiny value-noise lattice
  const G = 32, lat = new Float32Array(G * G);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const vn = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = lat[(xi & 31) + (yi & 31) * G], b = lat[((xi + 1) & 31) + (yi & 31) * G];
    const c = lat[(xi & 31) + ((yi + 1) & 31) * G], d = lat[((xi + 1) & 31) + ((yi + 1) & 31) * G];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  const fbm = (x, y) => vn(x, y) * 0.5 + vn(x * 2.1 + 7, y * 2.1 + 3) * 0.3 + vn(x * 4.3 + 1, y * 4.3 + 9) * 0.2;
  // random convex-ish polygon for the chip tile
  const planes = [];
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + rnd() * 0.7; planes.push([Math.cos(a), Math.sin(a), 0.42 + rnd() * 0.3]); }
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // muzzle-flash stars: a hot core plus a few irregular spikes
  const mkSpikes = (n, lo, hi, w) => { const a = [], o = rnd() * 6.28; for (let i = 0; i < n; i++) a.push([o + (i / n) * 6.2832 + (rnd() - 0.5) * 0.7, lo + rnd() * (hi - lo), w * (0.6 + rnd() * 0.8)]); return a; };
  const spikes = { 4: mkSpikes(5, 0.55, 1.0, 0.16), 5: mkSpikes(4, 0.7, 1.0, 0.11).concat(mkSpikes(3, 0.3, 0.5, 0.2)) };
  const star = (sp, u, v, r) => {
    const th = Math.atan2(v, u); let a = Math.exp(-(r * r) / 0.03) * 1.2;
    for (const k of sp) {
      let dth = Math.abs(th - k[0]) % 6.2832; if (dth > 3.1416) dth = 6.2832 - dth;
      const w = k[2] * (0.35 + 0.65 * (1 - Math.min(1, r / k[1])));       // spikes taper to a point
      a += Math.exp(-(dth * dth) / (w * w)) * Math.pow(Math.max(0, 1 - r / k[1]), 1.3) * (0.75 + 0.5 * vn(u * 6 + k[0], v * 6));
    }
    return Math.min(1, a);
  };
  for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 4; tx++) {
    const tile = tx + ty * 4;
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const u = ((x + 0.5) / T) * 2 - 1, v = ((y + 0.5) / T) * 2 - 1, r = Math.hypot(u, v);
      let a = 0, sh = 1;
      if (tile === TILE_GLOW) {
        const f = Math.max(0, 1 - r);
        a = Math.pow(f, 2.4) * 0.75 + Math.pow(f, 9) * 0.6;
      } else if (tile === TILE_SMOKE) {
        const n = fbm(u * 2.6 + 11, v * 2.6 + 5), n2 = fbm(u * 5 + 3, v * 5 + 17);
        a = (1 - ss(0.25, 0.98, r + (n - 0.5) * 0.75)) * (0.6 + 0.4 * n2);
        sh = 0.62 + 0.3 * n2 + v * 0.16; // lit from above (v grows upward on screen)
      } else if (tile === TILE_CHIP) {
        let d = 1;
        for (const p of planes) d = Math.min(d, p[2] - (u * p[0] + v * p[1]));
        a = ss(0, 0.06, d);
        sh = 0.65 + 0.35 * vn(u * 5 + 2, v * 5 + 2) + (u + v) * 0.12;
      } else if (tile === TILE_RING) {
        const d = (r - 0.8) / 0.075;
        a = Math.exp(-d * d) + 0.18 * ss(0.2, 0.8, r) * (1 - ss(0.8, 0.95, r));
      } else if (tile === TILE_STAR_A || tile === TILE_STAR_B) {
        a = star(spikes[tile], u, v, r);
      } else if (tile === TILE_BLAST) {   // ragged ball of burning gas with tendrils
        const n = fbm(u * 3.1 + 40, v * 3.1 + 9), th = Math.atan2(v, u), lobes = 0.62 + 0.3 * vn(th * 2.2 + 5, 3.3) + 0.12 * vn(th * 6 + 1, 8);
        a = (1 - ss(lobes * 0.45, lobes, r + (n - 0.5) * 0.35)) * (0.7 + 0.5 * n) + Math.exp(-(r * r) / 0.05) * 0.5;
        a = Math.min(1, a);
      } else {                            // shard: thin sharp sliver
        const x = Math.abs(u) / 0.22, y = (v + 0.85) / 1.7;
        a = y > 0 && y < 1 ? ss(0, 0.25, 1 - y - x) * (y < 0.08 ? y / 0.08 : 1) : 0;
        sh = 0.7 + 0.3 * (u > 0 ? 1 : 0.55);
      }
      a *= 1 - ss(0.9, 1.0, Math.max(Math.abs(u), Math.abs(v))); // guaranteed clear border (no atlas bleed)
      const i = ((tx * T + x) + (ty * T + y) * SW) * 4;
      data[i] = Math.min(255, Math.max(0, a * 255)); data[i + 1] = Math.min(255, Math.max(0, sh * 255)); data[i + 2] = 0; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, SW, SH, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.needsUpdate = true;
  _atlas = tex;
  return tex;
}

const VERT = /* glsl */`
attribute vec2 aCorner;
attribute vec4 aPos;   // xyz, birth
attribute vec4 aVel;   // xyz, life
attribute vec4 aCol0;  // rgb, alpha
attribute vec4 aCol1;  // rgb, additive at birth
attribute vec4 aSize;  // size0, size1, rot0, rotSpeed
attribute vec4 aPhys;  // gravity, drag, stretch, tile
attribute vec4 aMisc;  // fadeIn, additive at death, floorY, fadeOut start
uniform float uTime;
uniform float uFogDensity;
varying vec2 vUv; varying vec4 vCol; varying float vAdd; varying float vFog; varying float vStreak;
void main() {
  float age = uTime - aPos.w, life = aVel.w;
  float t = age / max(life, 1e-4);
  vUv = vec2(0.0); vCol = vec4(0.0); vAdd = 0.0; vFog = 0.0; vStreak = 0.0;
  if (life <= 0.0 || t < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float drag = aPhys.y;
  float k = drag > 0.001 ? (1.0 - exp(-drag * age)) / drag : age;
  float gk = drag > 0.001 ? (age - k) / drag : 0.5 * age * age;
  vec3 p = aPos.xyz + aVel.xyz * k;
  p.y -= aPhys.x * gk;
  float onFloor = step(p.y, aMisc.z);
  p.y = max(p.y, aMisc.z);
  vec3 vel = aVel.xyz * exp(-drag * age); vel.y -= aPhys.x * k;
  vel *= 1.0 - onFloor;
  float e = 1.0 - (1.0 - t) * (1.0 - t);
  float s = mix(aSize.x, aSize.y, e);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vec2 off;
  if (aPhys.z > 0.0) {
    vec3 vv = (viewMatrix * vec4(vel, 0.0)).xyz;
    float sp = length(vv.xy);
    vec2 d = sp > 1e-4 ? vv.xy / sp : vec2(0.0, 1.0);
    s = max(s, -mv.z * 0.0016);                           // streaks stay at least ~1.5 px wide at range
    float len = s + sp * aPhys.z; vStreak = 1.0;
    off = d * aCorner.y * len * 0.5 + vec2(d.y, -d.x) * aCorner.x * s * 0.5;
  } else {
    float rot = aSize.z + aSize.w * age;
    float c = cos(rot), sn = sin(rot);
    off = vec2(aCorner.x * c - aCorner.y * sn, aCorner.x * sn + aCorner.y * c) * s * 0.5;
  }
  mv.xy += off;
  gl_Position = projectionMatrix * mv;
  float tile = aPhys.w;
  vec2 tuv = vec2(mod(tile, 4.0), floor(tile * 0.25 + 0.01));
  vUv = (tuv + aCorner * 0.5 + 0.5) * vec2(0.25, 0.5);
  float dist = -mv.z;
  float a = aCol0.a * min(1.0, t / max(aMisc.x, 1e-4) + step(aMisc.x, 0.0005)) * (1.0 - smoothstep(aMisc.w, 1.0, t));
  a *= smoothstep(0.08, 0.12 + s * 0.7, dist);            // never slam a huge sprite through the near plane
  vCol = vec4(exp(mix(log(max(aCol0.rgb, 1e-3)), log(max(aCol1.rgb, 1e-3)), t)), a);   // geometric: HDR fire cools through red, not grey
  vAdd = mix(aCol1.a, aMisc.y, t);
  vFog = 1.0 - exp(-uFogDensity * dist);   // uFogDensity already includes the height term (see fx.js)
}`;

const FRAG = /* glsl */`
uniform sampler2D uAtlas;
uniform vec3 uFogColor;
uniform vec3 uLight;
varying vec2 vUv; varying vec4 vCol; varying float vAdd; varying float vFog; varying float vStreak;
void main() {
  vec4 tex = texture2D(uAtlas, vUv);
  float a = mix(tex.r, pow(tex.r, 0.62), vStreak) * vCol.a;   // streaks get a fat, hot core
  if (a < 0.003) discard;
  vec3 lit = vCol.rgb * tex.g * uLight;
  vec3 c = mix(lit, vCol.rgb, vAdd);
  c = mix(c, uFogColor, vFog * (1.0 - vAdd));
  a *= mix(1.0, 1.0 - vFog, vAdd);
  gl_FragColor = vec4(c * a, a * (1.0 - vAdd));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

let _u = 0, _v = 0, _w = 0;
function randDir() { // uniform on the sphere, into _u,_v,_w
  const z = Math.random() * 2 - 1, a = Math.random() * 6.2831853, r = Math.sqrt(1 - z * z);
  _u = r * Math.cos(a); _v = z; _w = r * Math.sin(a);
}
const rr = (a) => a[0] + (a[1] - a[0]) * Math.random();

// A preset describes a family of particles. All ranges are [min, max].
const DEF = {
  tile: TILE_GLOW, life: [0.3, 0.5], speed: [1, 2], spread: 1, size0: [0.1, 0.1], size1: [0.1, 0.1],
  col0: [1, 1, 1], col1: [1, 1, 1], colVar: 0, alpha: [1, 1], add0: 0, add1: 0, gravity: 0, drag: 0, stretch: 0,
  rot: 1, rotSpeed: 0, fadeIn: 0, fadeOut: 0.5, jitter: 0, tint: 0, lift: 0,
};
export function preset(o) { return Object.assign({}, DEF, o); }

export class Particles {
  constructor(capacity, renderOrder) {
    this.cap = capacity; this.head = 0; this.spawned = 0;
    this.data = new Float32Array(capacity * STRIDE);
    const ib = this.ib = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    ib.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    ['aPos', 'aVel', 'aCol0', 'aCol1', 'aSize', 'aPhys', 'aMisc'].forEach((n, i) => g.setAttribute(n, new THREE.InterleavedBufferAttribute(ib, 4, i * 4)));
    g.instanceCount = capacity;
    this.uniforms = {
      uTime: { value: 0 }, uAtlas: { value: getAtlas() }, uFogColor: { value: new THREE.Color(0.8, 0.75, 0.68) },
      uFogDensity: { value: 0.003 }, uLight: { value: new THREE.Vector3(1, 1, 1) },
    };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = renderOrder; this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false; this.mesh.receiveShadow = false;
    this.mesh.name = 'fx-particles';
    // pooled update ranges (three clears the array after each upload; we re-push these two objects)
    this.r0 = { start: 0, count: 0 }; this.r1 = { start: 0, count: 0 }; this.wrapped = false; this.full = false;
    this.time = 0;
    this.light = 1; // multiplier for non-additive colour (set by fx.js: darker under roofs)
  }

  _mark(i) {
    const ib = this.ib, rs = ib.updateRanges, r0 = this.r0, r1 = this.r1, at = i * STRIDE;
    ib.needsUpdate = true;
    if (rs.length === 0) { r0.start = at; r0.count = STRIDE; rs.push(r0); this.wrapped = false; this.full = false; return; }
    if (this.full) return;
    if (!this.wrapped) {
      if (at === r0.start + r0.count) { r0.count += STRIDE; return; }
      if (i === 0) { this.wrapped = true; r1.start = 0; r1.count = STRIDE; rs.push(r1); return; }
    } else if (at === r1.start + r1.count && at + STRIDE < r0.start) { r1.count += STRIDE; return; }
    rs.length = 0; r0.start = 0; r0.count = this.cap * STRIDE; rs.push(r0); this.full = true;
  }

  // Low-level spawn; returns the write offset so callers can tweak fields.
  raw(x, y, z, vx, vy, vz, life, s0, s1) {
    const i = this.head; this.head = (i + 1) % this.cap; this.spawned++;
    const d = this.data, o = i * STRIDE;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = this.time;
    d[o + 4] = vx; d[o + 5] = vy; d[o + 6] = vz; d[o + 7] = life;
    d[o + 16] = s0; d[o + 17] = s1;
    this._mark(i);
    return o;
  }

  // n particles of preset P at (x,y,z), thrown around direction (dx,dy,dz).
  // scale multiplies sizes, tint ({r,g,b} or null) is blended in by P.tint, floorY stops falling particles.
  burst(P, n, x, y, z, dx, dy, dz, scale = 1, tint = null, floorY = -1e4, speedMul = 1, ivx = 0, ivy = 0, ivz = 0) {
    const d = this.data, sp = Math.min(1, P.spread), dw = 1 - sp, hemi = P.spread === 1, tk = tint ? P.tint : 0;
    for (let k = 0; k < n; k++) {
      randDir();
      let vx = dx * dw + _u * sp, vy = dy * dw + _v * sp, vz = dz * dw + _w * sp;
      if (hemi) { // hemisphere around the direction
        const dot = _u * dx + _v * dy + _w * dz;
        if (dot < 0) { vx -= 2 * dot * dx; vy -= 2 * dot * dy; vz -= 2 * dot * dz; }
      }
      const l = Math.hypot(vx, vy, vz) || 1, s = (rr(P.speed) * speedMul) / l;
      vx = vx * s + ivx; vy = vy * s + P.lift + ivy; vz = vz * s + ivz;
      let px = x, py = y, pz = z;
      if (P.jitter > 0) { const j = P.jitter * scale; px += (Math.random() - 0.5) * j; py += (Math.random() - 0.5) * j; pz += (Math.random() - 0.5) * j; }
      const s0 = rr(P.size0) * scale;
      const o = this.raw(px, py, pz, vx, vy, vz, rr(P.life), s0, rr(P.size1) * scale);
      const cv = (1 - P.colVar * Math.random()) * (P.add0 >= 0.8 ? 1 : this.light);
      let r0 = P.col0[0], g0 = P.col0[1], b0 = P.col0[2], r1 = P.col1[0], g1 = P.col1[1], b1 = P.col1[2];
      if (tk > 0) {
        r0 += (tint.r * r0 * 2.2 - r0) * tk; g0 += (tint.g * g0 * 2.2 - g0) * tk; b0 += (tint.b * b0 * 2.2 - b0) * tk;
        r1 += (tint.r * r1 * 2.2 - r1) * tk; g1 += (tint.g * g1 * 2.2 - g1) * tk; b1 += (tint.b * b1 * 2.2 - b1) * tk;
      }
      d[o + 8] = r0 * cv; d[o + 9] = g0 * cv; d[o + 10] = b0 * cv; d[o + 11] = rr(P.alpha);
      d[o + 12] = r1 * cv; d[o + 13] = g1 * cv; d[o + 14] = b1 * cv; d[o + 15] = P.add0;
      d[o + 18] = P.rot ? Math.random() * 6.2831853 : 0; d[o + 19] = P.rotSpeed ? (Math.random() - 0.5) * 2 * P.rotSpeed : 0;
      d[o + 20] = P.gravity; d[o + 21] = P.drag; d[o + 22] = P.stretch; d[o + 23] = P.tile;
      d[o + 24] = P.fadeIn; d[o + 25] = P.add1; d[o + 26] = floorY; d[o + 27] = P.fadeOut;
    }
  }

  // scale colour / alpha of the last n spawned particles (per-shot variation without new presets)
  tweak(n, r, g, b, alpha = 1) {
    const d = this.data;
    for (let k = 1; k <= n; k++) {
      const o = ((this.head - k + this.cap) % this.cap) * STRIDE;
      d[o + 8] *= r; d[o + 9] *= g; d[o + 10] *= b; d[o + 11] *= alpha; d[o + 12] *= r; d[o + 13] *= g; d[o + 14] *= b;
    }
  }

  setTime(t) { this.time = t; this.uniforms.uTime.value = t; }
}
