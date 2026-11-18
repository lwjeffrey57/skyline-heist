import * as THREE from 'three';
import { getNoiseTexture } from './sky.js';

// Set dressing: furniture inside the buildings, vehicles / street furniture / yard clutter outside, roof plant.
//
// Everything visible is drawn with a few InstancedMeshes that share ONE geometry (a unit box and a unit 12-sided
// cylinder in the same buffer; a per-instance attribute picks which of the two an instance shows) and ONE material
// (instance colour = paint; a per-instance mode makes an instance glow / blink / act as a warning beacon).
//   * interiors: one InstancedMesh per building, hidden beyond INTERIOR_RANGE
//   * outside and on roofs: one InstancedMesh per sector of the site (3 x 3), frustum culled by three
//   * one more InstancedMesh holds the large outdoor boxes that cast shadows
// Solid pieces get a collider through world.addBox (so they are in world.colliders and the spatial index: raycast,
// near, player and guard navigation all see them); the box mesh world.addBox makes is taken out of the scene at
// once, so a collider costs no draw call. A piece's instances are removed when the floor under it is destroyed.

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const lin = (hex, k = 1) => { const c = new THREE.Color(hex); return [c.r * k, c.g * k, c.b * k]; };
const pick = (r, list) => list[Math.floor(r() * list.length)];

// paint
const C = {
  wood: lin(0x9a7448), woodD: lin(0x5e4630), pallet: lin(0xb39a6b), card: lin(0xa98c5e), cardD: lin(0x8a6f48), paper: lin(0xe8e4d8),
  steel: lin(0x7b8087), dsteel: lin(0x2e3136), black: lin(0x121316), white: lin(0xe2dfd6), offwhite: lin(0xc9c5b8), conc: lin(0x9a968e), concD: lin(0x5f5e5c),
  olive: lin(0x59613d), navy: lin(0x2b3a55), teal: lin(0x1f7f80), rust: lin(0x8c4a2c), orange: lin(0xd0661a), yellow: lin(0xd9a520), red: lin(0xa82b22),
  blue: lin(0x2a5a9c), green: lin(0x3f6b3a), mattress: lin(0x8f9a8a), greyblue: lin(0x5c6b7a), rubber: lin(0x1a1a1c), glass: lin(0x16212b),
  sand: lin(0xb7a47c), plant: lin(0x3d6a34), tarp: lin(0x35566b), cream: lin(0xd9cfb8), brown: lin(0x4a3524),
};
// light (HDR: these are emitted as they are)
const G = {
  screen: [0.22, 0.5, 1.1], screenA: [0.9, 0.55, 0.15], ledG: [0.1, 2.6, 0.4], ledA: [2.6, 1.2, 0.1], ledC: [0.1, 1.6, 2.6], ledR: [3.0, 0.15, 0.1],
  warm: [7.5, 4.3, 1.9], white: [8.5, 7.6, 6.2], dim: [1.5, 0.95, 0.45], beacon: [5.5, 2.4, 0.25], teal: [0.3, 2.4, 2.2], window: [2.4, 1.45, 0.62], windowC: [1.2, 1.7, 2.2],
};
const BOXCOLS = [C.card, C.card, C.cardD, C.navy, C.red, C.offwhite, C.olive, C.steel, C.teal, C.yellow];
const DRUMCOLS = [C.blue, C.blue, C.red, C.rust, C.black, C.yellow, C.olive];
const CARCOLS = [C.white, C.offwhite, C.navy, C.olive, C.rust, C.teal, C.yellow, C.greyblue, C.dsteel];

// ---- shared geometry and material ---------------------------------------------------
let BOXG = null, CYLG = null;
function baseGeometry(cyl) {
  if (!BOXG) { BOXG = new THREE.BoxGeometry(1, 1, 1); CYLG = new THREE.CylinderGeometry(0.5, 0.5, 1, 12); for (const g of [BOXG, CYLG]) g.deleteAttribute('uv'); }
  return cyl ? CYLG : BOXG;
}
function propMaterial(U) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.time; sh.uniforms.uAlarm = U.alarm; sh.uniforms.uMacro = { value: getNoiseTexture() };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 iFx;\nvarying vec3 vFx;\nvarying vec3 vPW;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vFx = iFx;
        #ifdef USE_INSTANCING
          vFx.z = fract( sin( dot( instanceMatrix[ 3 ].xyz, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
          vPW = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
        #else
          vPW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uAlarm;\nuniform sampler2D uMacro;\nvarying vec3 vFx;\nvarying vec3 vPW;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float pMode = floor( vFx.y + 0.5 );
        vec3 pGlow = vec3( 0.0 );
        if ( pMode < 0.5 || pMode > 4.5 ) {
          vec4 pN = texture2D( uMacro, vPW.xz * 0.13 + vPW.y * vec2( 0.09, 0.11 ) );
          diffuseColor.rgb *= 0.74 + 0.5 * pN.r;                                   // tone drift
          diffuseColor.rgb *= 1.0 - 0.3 * smoothstep( 0.62, 0.8, pN.g );          // grime blotches
        } else {
          float pG = 1.0;
          if ( pMode < 1.5 ) pG = 1.0;                                             // steady light
          else if ( pMode < 2.5 ) pG = step( 0.3, fract( vFx.z * 7.0 + uTime * ( 0.35 + vFx.z * 2.4 ) ) ); // status LED
          else if ( pMode < 3.5 ) { float pT = floor( uTime * 11.0 + vFx.z * 40.0 ); pG = 0.5 + 0.5 * step( 0.3, fract( sin( pT * 12.9898 ) * 43758.5453 ) ); } // failing tube
          else {                                                                  // warning beacon: lazy amber sweep, red strobe on alarm
            float pSlow = 0.22 + 0.9 * pow( max( 0.0, sin( uTime * 1.5 + vFx.z * 6.2832 ) ), 6.0 );
            float pFast = 0.2 + 1.7 * pow( 0.5 + 0.5 * sin( uTime * 9.5 + vFx.z * 6.2832 ), 2.0 );
            diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 9.0, 0.3, 0.16 ), uAlarm );
            pG = mix( pSlow, pFast, uAlarm );
          }
          pGlow = diffuseColor.rgb * pG; diffuseColor.rgb = vec3( 0.03 );
        }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif ( pMode > 4.5 ) roughnessFactor = pMode > 5.5 ? 0.12 : 0.42;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nif ( pMode > 4.5 && pMode < 5.5 ) metalnessFactor = 1.0;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += pGlow;');
  };
  return mat;
}

// modes: 0 paint, 1 light, 2 status LED, 3 failing light, 4 beacon, 5 bare metal, 6 glass
class Kit {
  // cyl: the kit that takes this kit's cylinders (boxes and cylinders are separate meshes); round = this kit IS a cylinder kit
  constructor(cyl = null, round = false) { this.M = []; this.Cc = []; this.F = []; this.n = 0; this.stack = []; this.mesh = null; this.cy = cyl; this.round = round; this.at(0, 0, 0, 0); }
  at(x, y, z, a = 0) { this.ox = x; this.oy = y; this.oz = z; this.a = a; this.cs = Math.cos(a); this.sn = Math.sin(a); return this; }
  push(lx, lz, da = 0, ly = 0) { this.stack.push([this.ox, this.oy, this.oz, this.a]); return this.at(this.ox + lx * this.cs + lz * this.sn, this.oy + ly, this.oz - lx * this.sn + lz * this.cs, this.a + da); }
  pop() { const s = this.stack.pop(); return this.at(s[0], s[1], s[2], s[3]); }
  put(lx, cy, lz, sx, sy, sz, yaw, pitch, axis, col, shape, mode) {
    const wx = this.ox + lx * this.cs + lz * this.sn, wz = this.oz - lx * this.sn + lz * this.cs, t = this.a + yaw;
    const c = Math.cos(t), s = Math.sin(t), K = shape ? this.cy : this, M = K.M;
    if (axis === 1) M.push(0, -sx, 0, 0, c * sy, 0, -s * sy, 0, s * sz, 0, c * sz, 0);
    else if (axis === 2) M.push(c * sx, 0, -s * sx, 0, s * sy, 0, c * sy, 0, 0, -sz, 0, 0);
    else { const cp = Math.cos(pitch), sp = Math.sin(pitch); M.push(c * sx, 0, -s * sx, 0, s * sp * sy, cp * sy, c * sp * sy, 0, s * cp * sz, -sp * sz, c * cp * sz, 0); }
    M.push(wx, this.oy + cy, wz, 1);
    K.Cc.push(col[0], col[1], col[2]); K.F.push(0, mode, 0); K.n++;
  }
  // x, z = centre in the local frame, y = bottom
  box(x, y, z, w, h, d, col, mode = 0, yaw = 0, pitch = 0) { this.put(x, y + h / 2, z, w, h, d, yaw, pitch, 0, col, 0, mode); }
  // axis 0 = upright (y = bottom, len = height), 1 = lying along local x, 2 = lying along local z (y = bottom of the round)
  cyl(x, y, z, dia, len, col, mode = 0, axis = 0) { this.put(x, y + (axis ? dia : len) / 2, z, dia, len, dia, 0, 0, axis, col, 1, mode); }
  mark() { return [this.n, this.cy ? this.cy.n : 0]; }
  since(m) { const out = []; if (this.n > m[0]) out.push([this, m[0], this.n]); if (this.cy && this.cy.n > m[1]) out.push([this.cy, m[1], this.cy.n]); return out; }
  build(material, { cast = false } = {}) {
    if (!this.n) return null;
    const B = baseGeometry(this.round), g = new THREE.BufferGeometry();
    g.setAttribute('position', B.attributes.position); g.setAttribute('normal', B.attributes.normal); g.setIndex(B.index); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0.87);
    g.setAttribute('iFx', new THREE.InstancedBufferAttribute(new Float32Array(this.F), 3));
    const m = new THREE.InstancedMesh(g, material, this.n);
    m.instanceMatrix.array.set(this.M); m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.Cc), 3);
    m.castShadow = cast; m.receiveShadow = true; m.matrixAutoUpdate = false; m.updateMatrix(); m.computeBoundingSphere();
    this.M = this.Cc = this.F = null; this.mesh = m;
    return m;
  }
  erase(start, end) { if (!this.mesh) return; this.mesh.instanceMatrix.array.fill(0, start * 16, end * 16); this.mesh.instanceMatrix.needsUpdate = true; }
}

// =====================================================================================
// Pieces. Each spec is drawn in a "wall frame": x runs along the wall (centred on 0), z runs from the wall (0) out
// into the room (D), y is up from the floor. { L, D, H (collider height; 0 = none), tall (wants a solid wall behind),
// soft (never solid), metal, cols (optional list of collider boxes [x0, x1, z0, z1, h]), draw(k, s) } where k is the
// detail kit and s the kit for big shadow-casting boxes (the same kit indoors).
// =====================================================================================
function chair(k, r, x, z, yaw) {
  const c = r() < 0.5 ? C.black : C.navy;
  k.box(x, 0.42, z, 0.44, 0.07, 0.44, c, 0, yaw); k.box(x + Math.sin(yaw) * 0.2, 0.5, z + Math.cos(yaw) * 0.2, 0.42, 0.48, 0.05, c, 0, yaw);
  k.cyl(x, 0.04, z, 0.06, 0.38, C.steel, 5); k.box(x, 0, z, 0.5, 0.04, 0.08, C.dsteel, 0, yaw); k.box(x, 0, z, 0.08, 0.04, 0.5, C.dsteel, 0, yaw);
}
function desk(k, r, x) {
  const top = r() < 0.5 ? C.wood : C.offwhite, ps = r() < 0.5 ? -1 : 1;
  k.box(x, 0.71, 0.4, 1.5, 0.04, 0.74, top);
  k.box(x - 0.72, 0, 0.4, 0.04, 0.71, 0.7, C.steel); k.box(x + 0.72, 0, 0.4, 0.04, 0.71, 0.7, C.steel);
  k.box(x, 0.3, 0.07, 1.4, 0.38, 0.02, C.steel);
  k.box(x + ps * 0.47, 0.08, 0.42, 0.4, 0.6, 0.6, C.dsteel);
  for (let i = 0; i < 3; i++) k.box(x + ps * 0.47, 0.18 + i * 0.19, 0.725, 0.2, 0.02, 0.012, C.steel);
  if (r() < 0.8) {
    const mx = x - ps * 0.2;
    k.box(mx, 0.75, 0.2, 0.22, 0.015, 0.16, C.black); k.box(mx, 0.76, 0.18, 0.04, 0.14, 0.03, C.black); k.box(mx, 0.86, 0.2, 0.54, 0.33, 0.03, C.black);
    if (r() < 0.7) k.box(mx, 0.875, 0.218, 0.5, 0.29, 0.006, r() < 0.75 ? G.screen : G.screenA, r() < 0.12 ? 3 : 1);
    k.box(mx, 0.75, 0.5, 0.42, 0.015, 0.14, C.black);
  }
  if (r() < 0.6) k.box(x + (r() - 0.5), 0.75, 0.3 + r() * 0.3, 0.22, 0.02 + r() * 0.05, 0.3, C.paper, 0, r() * 3);
  if (r() < 0.4) k.cyl(x + (r() - 0.5) * 1.1, 0.75, 0.58, 0.08, 0.1, pick(r, [C.white, C.red, C.navy]));
  if (r() < 0.85) chair(k, r, x + (r() - 0.5) * 0.3, 1.05 + r() * 0.25, (r() - 0.5) * 1.4);
}
const deskRun = (r) => { const n = 2 + Math.floor(r() * 3), L = n * 1.56; return { L, D: 0.78, H: 0.77, draw(k) { for (let i = 0; i < n; i++) desk(k, r, -L / 2 + 0.78 + i * 1.56); } }; };
const deskCluster = (r) => { const n = 1 + Math.floor(r() * 2), L = n * 1.56; return { L, D: 1.56, H: 0.77, draw(k) {
  for (let i = 0; i < n; i++) { const x = -L / 2 + 0.78 + i * 1.56; k.push(x, 0.78, Math.PI); desk(k, r, 0); k.pop(); k.push(x, 0.78, 0); desk(k, r, 0); k.pop(); }
  k.box(0, 0.75, 0.78, L, 0.42, 0.03, C.greyblue);
} }; };
const cabinets = (r) => { const n = 3 + Math.floor(r() * 4), w = 0.47, L = n * w, col = pick(r, [C.steel, C.olive, C.offwhite, C.greyblue]); return { L, D: 0.62, H: 1.33, metal: true, draw(k) {
  for (let i = 0; i < n; i++) { const x = -L / 2 + w * (i + 0.5); k.box(x, 0, 0.31, w - 0.02, 1.32, 0.6, col); for (let j = 0; j < 4; j++) { k.box(x, 0.24 + j * 0.32, 0.62, 0.16, 0.025, 0.02, C.black); k.box(x, 0.045 + j * 0.32, 0.612, w - 0.05, 0.012, 0.008, C.black); } }
  if (r() < 0.6) k.box((r() - 0.5) * (L - 0.5), 1.32, 0.3, 0.36, 0.22, 0.3, pick(r, BOXCOLS), 0, r() * 0.4);
  if (r() < 0.4) { const x = (r() - 0.5) * (L - 0.4); k.cyl(x, 1.32, 0.3, 0.2, 0.18, C.rust); k.box(x, 1.5, 0.3, 0.3, 0.3, 0.3, C.plant, 0, 0.6); }
} }; };
const shelf = (r) => ({ L: 1.8, D: 0.46, H: 2.1, tall: true, metal: true, draw(k) {
  const fr = pick(r, [C.steel, C.dsteel, C.wood]);
  k.box(-0.88, 0, 0.23, 0.04, 2.1, 0.44, fr); k.box(0.88, 0, 0.23, 0.04, 2.1, 0.44, fr); k.box(0, 0, 0.02, 1.76, 2.1, 0.02, fr);
  for (let j = 0; j < 5; j++) {
    const y = 0.08 + j * 0.48; k.box(0, y, 0.23, 1.76, 0.03, 0.44, fr);
    let x = -0.82;
    while (x < 0.7) { const w = 0.12 + r() * 0.4; if (x + w > 0.84) break; if (r() < 0.8) k.box(x + w / 2, y + 0.03, 0.2 + r() * 0.08, w - 0.02, 0.14 + r() * 0.26, 0.28 + r() * 0.1, pick(r, BOXCOLS)); x += w + 0.02; }
  }
} });
const lockers = (r) => { const n = 3 + Math.floor(r() * 4), w = 0.4, L = n * w, col = pick(r, [C.teal, C.steel, C.navy, C.olive, C.rust]); return { L, D: 0.52, H: 1.9, tall: true, metal: true, draw(k) {
  k.box(0, 0.08, 0.26, L, 1.82, 0.5, col); k.box(0, 0, 0.26, L - 0.06, 0.08, 0.44, C.black);
  for (let i = 0; i < n; i++) { const x = -L / 2 + w * (i + 0.5); k.box(x - w / 2 + 0.01, 0.1, 0.512, 0.012, 1.78, 0.006, C.black); for (let j = 0; j < 3; j++) k.box(x, 1.62 + j * 0.05, 0.512, 0.22, 0.015, 0.006, C.black); k.box(x + 0.12, 1.0, 0.52, 0.03, 0.1, 0.02, C.steel, 5); }
  if (r() < 0.6) k.box((r() - 0.5) * (L - 0.5), 1.9, 0.26, 0.4, 0.25, 0.34, C.card);
  if (r() < 0.5) k.box((r() - 0.5) * (L - 0.6), 0, 0.8, 0.9, 0.42, 0.3, C.wood); // bench
} }; };
function bunkAt(k, r, zo) {
  const fr = C.dsteel, bl = pick(r, [C.olive, C.navy, C.greyblue, C.rust]);
  for (const sx of [-1, 1]) for (const z of [0.05, 0.91]) k.box(sx * 1.0, 0, zo + z, 0.05, 1.75, 0.05, fr);
  for (const y of [0.32, 1.22]) {
    k.box(0, y, zo + 0.48, 2.0, 0.05, 0.9, fr); k.box(0, y + 0.05, zo + 0.48, 1.92, 0.13, 0.84, C.mattress); k.box(-0.72, y + 0.18, zo + 0.48, 0.42, 0.08, 0.6, C.offwhite);
    if (r() < 0.85) k.box(0.3 + r() * 0.1, y + 0.18, zo + 0.48, 1.1 + r() * 0.2, 0.05, 0.86, bl);
    k.box(0, y + 0.32, zo + 0.05, 2.0, 0.04, 0.03, fr);
  }
  for (let j = 0; j < 4; j++) k.box(1.0, 0.3 + j * 0.3, zo + 0.75, 0.03, 0.03, 0.3, fr);
  if (r() < 0.5) k.box(-0.5 + r(), 0, zo + 0.48, 0.7, 0.26, 0.4, C.olive); // kit bag under the bed
}
const bunk = (r) => { const n = 1 + Math.floor(r() * 2), L = n * 2.1; return { L, D: 0.96, H: 1.78, metal: true, draw(k) { for (let i = 0; i < n; i++) { k.push(-L / 2 + 1.05 + i * 2.1, 0); bunkAt(k, r, 0); k.pop(); } } }; };
const bunkPair = (r) => ({ L: 2.06, D: 1.94, H: 1.78, metal: true, draw(k) { bunkAt(k, r, 0); bunkAt(k, r, 0.98); } });
const messTable = (r) => ({ L: 2.0, D: 1.7, H: 0.77, draw(k) {
  k.box(0, 0.71, 0.85, 2.0, 0.05, 0.85, C.wood); for (const sx of [-1, 1]) for (const z of [0.5, 1.2]) k.box(sx * 0.9, 0, z, 0.06, 0.71, 0.06, C.dsteel);
  for (const z of [0.15, 1.55]) { k.box(0, 0.42, z, 1.8, 0.05, 0.3, C.wood); for (const sx of [-1, 1]) k.box(sx * 0.8, 0, z, 0.05, 0.42, 0.26, C.dsteel); }
  for (let i = 0; i < 4; i++) { const x = (r() - 0.5) * 1.7, z = 0.55 + r() * 0.6; if (r() < 0.5) k.cyl(x, 0.76, z, 0.08, 0.1, pick(r, [C.white, C.red, C.steel])); else k.box(x, 0.76, z, 0.3, 0.02, 0.22, pick(r, [C.steel, C.paper, C.olive]), 0, r() * 3); }
} });
function palletAt(k, r, x, zc, hMax = 1.5) {
  for (const dz of [-0.42, 0, 0.42]) k.box(x, 0, zc + dz, 1.18, 0.1, 0.1, C.pallet);
  for (let i = 0; i < 5; i++) k.box(x - 0.52 + i * 0.26, 0.1, zc, 0.16, 0.025, 0.98, C.pallet);
  const kind = r();
  if (kind < 0.4) { const col = pick(r, BOXCOLS), rows = 1 + Math.floor(r() * (hMax > 1.2 ? 3 : 2)); for (let j = 0; j < rows; j++) for (const sx of [-0.29, 0.29]) for (const sz of [-0.24, 0.24]) if (j < rows - 1 || r() < 0.8) k.box(x + sx, 0.125 + j * 0.42, zc + sz, 0.56, 0.41, 0.46, r() < 0.8 ? col : pick(r, BOXCOLS)); if (r() < 0.4) k.box(x, 0.13, zc, 1.2, rows * 0.42 - 0.04, 1.0, C.white, 6); return 0.125 + rows * 0.42; }
  if (kind < 0.65) { const rows = 2 + Math.floor(r() * 3); for (let j = 0; j < rows; j++) for (const sx of [-0.28, 0.28]) k.box(x + sx + (r() - 0.5) * 0.06, 0.125 + j * 0.2, zc, 0.54, 0.19, 0.92, r() < 0.85 ? C.sand : C.offwhite, 0, (r() - 0.5) * 0.1); return 0.125 + rows * 0.2; }
  if (kind < 0.85) { const h = 0.8 + r() * 0.5, col = pick(r, [C.wood, C.woodD, C.olive]); k.box(x, 0.125, zc, 1.1, h, 0.92, col); for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(x + sx * 0.53, 0.125, zc + sz * 0.44, 0.06, h, 0.06, C.woodD); k.box(x, 0.125 + h, zc, 1.14, 0.03, 0.96, C.woodD); return 0.155 + h; }
  for (const sx of [-0.3, 0.3]) for (const sz of [-0.24, 0.24]) drum(k, r, x + sx, 0.125, zc + sz, 0.46);
  return 1.0;
}
function drum(k, r, x, y, z, dia = 0.58, col) {
  const c = col || pick(r, DRUMCOLS), h = dia * 1.5;
  k.cyl(x, y, z, dia, h, c); k.cyl(x, y + h * 0.33, z, dia + 0.03, 0.03, c); k.cyl(x, y + h * 0.66, z, dia + 0.03, 0.03, c); k.cyl(x, y + h, z, dia - 0.06, 0.012, C.dsteel);
}
const pallet = (r) => ({ L: 1.24, D: 1.04, H: 0.95, draw(k) { this.H = Math.max(0.6, palletAt(k, r, 0, 0.52)); } });
const palletBlock = (r) => { const n = 2 + Math.floor(r() * 2), L = n * 1.26; return { L, D: 1.04, H: 1.0, draw(k) { let h = 0.6; for (let i = 0; i < n; i++) h = Math.max(h, palletAt(k, r, -L / 2 + 0.63 + i * 1.26, 0.52)); this.H = h; } }; };
function crate(k, r, x, y, z, s, yaw = 0, col) {
  const c = col || pick(r, [C.wood, C.wood, C.woodD, C.olive, C.pallet]);
  k.box(x, y, z, s, s * 0.8, s, c, 0, yaw); k.box(x, y + s * 0.8 - 0.04, z, s + 0.03, 0.05, s + 0.03, C.woodD, 0, yaw); k.box(x, y + 0.03, z, s + 0.03, 0.05, s + 0.03, C.woodD, 0, yaw);
  return s * 0.8 + 0.01;
}
const crates = (r) => { const n = 1 + Math.floor(r() * 2), L = n * 1.12; return { L, D: 1.1, H: 1.0, draw(k) {
  let top = 0;
  for (let i = 0; i < n; i++) { const x = -L / 2 + 0.56 + i * 1.12; let y = crate(k, r, x, 0, 0.55, 1.0); if (r() < 0.55) y += crate(k, r, x + (r() - 0.5) * 0.15, y, 0.55 + (r() - 0.5) * 0.1, 0.72 + r() * 0.2, (r() - 0.5) * 0.5); top = Math.max(top, y); }
  this.H = top;
} }; };
const workbench = (r) => ({ L: 2.0, D: 0.78, H: 0.93, tall: true, draw(k) {
  k.box(0, 0.84, 0.39, 2.0, 0.08, 0.76, C.wood); for (const sx of [-1, 1]) for (const z of [0.08, 0.7]) k.box(sx * 0.92, 0, z, 0.07, 0.84, 0.07, C.dsteel);
  k.box(0, 0.2, 0.39, 1.84, 0.04, 0.66, C.dsteel); k.box(0, 0.92, 0.03, 2.0, 0.95, 0.04, C.cardD);
  for (let i = 0; i < 7; i++) k.box(-0.85 + i * 0.28 + (r() - 0.5) * 0.08, 1.2 + r() * 0.35, 0.06, 0.04 + r() * 0.08, 0.18 + r() * 0.22, 0.02, pick(r, [C.steel, C.red, C.black, C.yellow]));
  k.box(-0.7, 0.92, 0.5, 0.2, 0.14, 0.26, C.blue); k.cyl(-0.7, 1.0, 0.72, 0.05, 0.3, C.steel, 5, 2);
  k.box(0.55, 0.92, 0.4, 0.5, 0.22, 0.26, C.red); k.box(0.55, 1.14, 0.4, 0.3, 0.03, 0.04, C.steel);
  k.box(0.1 + r() * 0.2, 0.24, 0.4, 0.5, 0.3, 0.4, pick(r, BOXCOLS)); k.box(-0.5, 0.24, 0.4, 0.34, 0.22, 0.34, pick(r, BOXCOLS));
  k.box(0.9, 0.92, 0.12, 0.05, 0.5, 0.05, C.dsteel); k.box(0.75, 1.4, 0.2, 0.34, 0.04, 0.12, C.dsteel); k.box(0.75, 1.385, 0.2, 0.28, 0.015, 0.08, G.dim, 1);
} });
const drums = (r) => { const n = 2 + Math.floor(r() * 3), two = r() < 0.4, L = n * 0.64; return { L, D: two ? 1.3 : 0.66, H: 0.9, metal: true, draw(k) {
  for (let i = 0; i < n; i++) { const x = -L / 2 + 0.32 + i * 0.64; drum(k, r, x, 0, 0.33); if (two && r() < 0.8) drum(k, r, x, 0, 0.97); }
  if (r() < 0.3) k.box(0, 0.88, 0.33, 0.5, 0.3, 0.4, pick(r, BOXCOLS), 0, r());
} }; };
function rackAt(k, r, zo) {
  for (const sx of [-1, 1]) for (const z of [0.06, 1.04]) k.box(sx * 1.36, 0, zo + z, 0.09, 3.0, 0.09, C.blue);
  for (const sx of [-1, 1]) for (let j = 0; j < 3; j++) k.box(sx * 1.36, 0.4 + j * 0.95, zo + 0.55, 0.04, 0.04, 0.98, C.blue);
  for (const y of [1.2, 2.3]) {
    for (const z of [0.06, 1.04]) k.box(0, y - 0.12, zo + z, 2.72, 0.12, 0.05, C.orange);
    k.box(0, y, zo + 0.55, 2.66, 0.03, 1.0, C.pallet);
  }
  for (const y of [0, 1.23, 2.33]) for (const sx of [-0.68, 0.68]) {
    const q = r(); if (q < 0.22) continue;
    if (q < 0.6) { const h = 0.4 + r() * 0.45, col = pick(r, BOXCOLS); k.box(sx + (r() - 0.5) * 0.1, y, zo + 0.55, 1.05 + r() * 0.15, h, 0.8 + r() * 0.15, col); }
    else if (q < 0.8) { for (const dx of [-0.3, 0.3]) drum(k, r, sx + dx, y, zo + 0.55, 0.44); }
    else { crate(k, r, sx, y, zo + 0.55, 0.85); }
  }
}
const racking = (r) => { const n = 1 + Math.floor(r() * 2), L = n * 2.8 + 0.02; return { L, D: 1.1, H: 3.0, tall: true, metal: true, draw(k) { for (let i = 0; i < n; i++) { k.push(-L / 2 + 1.41 + i * 2.8, 0); rackAt(k, r, 0); k.pop(); } } }; };
const rackIsland = (r) => ({ L: 2.82, D: 2.24, H: 3.0, metal: true, draw(k) { rackAt(k, r, 0); rackAt(k, r, 1.14); } });
function serverAt(k, r, x, zo, flip) {
  const f = flip ? -1 : 1, zf = zo + (flip ? 0.0 : 1.0), zc = zo + 0.5;
  k.box(x, 0, zc, 0.6, 2.02, 0.98, C.black); k.box(x, 0.06, zf + f * 0.006, 0.52, 1.9, 0.01, C.dsteel);
  for (let j = 0; j < 9; j++) { if (r() < 0.25) continue; const y = 0.16 + j * 0.2; k.box(x, y, zf + f * 0.014, 0.46, 0.012, 0.006, C.steel); const n = 1 + Math.floor(r() * 3); for (let i = 0; i < n; i++) k.box(x - 0.18 + i * 0.07 + r() * 0.02, y + 0.05, zf + f * 0.016, 0.025, 0.025, 0.008, pick(r, [G.ledG, G.ledG, G.ledA, G.ledC, G.ledR]), r() < 0.7 ? 2 : 1); }
}
const serverRow = (r) => { const n = 3 + Math.floor(r() * 5), L = n * 0.62; return { L, D: 1.02, H: 2.03, tall: true, metal: true, draw(k) {
  for (let i = 0; i < n; i++) serverAt(k, r, -L / 2 + 0.31 + i * 0.62, 0.02, false);
  k.box(0, 2.02, 0.5, L, 0.06, 0.3, C.dsteel); k.box(0, 2.08, 0.5, L - 0.1, 0.015, 0.04, G.teal, 1);
} }; };
const serverIsland = (r) => { const n = 3 + Math.floor(r() * 3), L = n * 0.62; return { L, D: 2.04, H: 2.03, metal: true, draw(k) {
  for (let i = 0; i < n; i++) { serverAt(k, r, -L / 2 + 0.31 + i * 0.62, 0.0, true); serverAt(k, r, -L / 2 + 0.31 + i * 0.62, 1.04, false); }
  k.box(0, 2.02, 1.02, L, 0.08, 0.5, C.dsteel); k.box(0, 2.1, 1.02, L - 0.1, 0.015, 0.04, G.teal, 1);
} }; };
const cooling = (r) => ({ L: 1.1, D: 0.8, H: 1.9, tall: true, metal: true, draw(k) {
  k.box(0, 0, 0.4, 1.1, 1.9, 0.78, C.offwhite); for (let j = 0; j < 8; j++) k.box(0, 0.25 + j * 0.09, 0.795, 0.9, 0.03, 0.01, C.dsteel);
  k.box(0.3, 1.5, 0.795, 0.3, 0.16, 0.01, C.black); k.box(0.3, 1.55, 0.802, 0.22, 0.05, 0.004, G.ledC, 1); k.box(-0.3, 1.56, 0.8, 0.03, 0.03, 0.008, G.ledG, 2);
  k.cyl(-0.3, 1.9, 0.4, 0.12, 0.8, C.steel, 5);
} });
const medBed = (r) => ({ L: 2.1, D: 1.5, H: 0.62, metal: true, cols: [[-1.05, 1.05, 0.02, 0.98, 0.62]], draw(k) {
  for (const sx of [-1, 1]) for (const z of [0.08, 0.92]) k.cyl(sx * 0.95, 0, z, 0.05, 0.5, C.steel, 5);
  k.box(0, 0.42, 0.5, 2.0, 0.06, 0.9, C.steel); k.box(0, 0.48, 0.5, 1.9, 0.12, 0.84, C.white); k.box(-0.7, 0.6, 0.5, 0.42, 0.08, 0.56, C.offwhite); k.box(0.3, 0.6, 0.5, 1.0, 0.04, 0.86, C.teal);
  k.box(-1.0, 0.3, 0.5, 0.04, 0.65, 0.9, C.steel); k.box(1.0, 0.3, 0.5, 0.04, 0.4, 0.9, C.steel);
  k.cyl(-1.0, 0, 1.2, 0.03, 1.8, C.steel, 5); k.box(-1.0, 0, 1.2, 0.4, 0.03, 0.4, C.dsteel); k.box(-1.0, 1.55, 1.2, 0.14, 0.22, 0.05, C.white, 6);
  if (r() < 0.7) { k.box(1.02, 0.02, 1.25, 0.03, 1.75, 0.03, C.steel); k.box(1.02, 0.3, 0.72, 0.02, 1.45, 1.4, C.mattress); } // privacy screen
  k.box(0.5, 0, 1.22, 0.42, 0.6, 0.4, C.offwhite); if (r() < 0.6) k.box(0.5, 0.6, 1.22, 0.2, 0.12, 0.2, pick(r, [C.red, C.teal, C.white]));
} });
const medCab = (r) => ({ L: 1.0, D: 0.46, H: 1.9, tall: true, metal: true, draw(k) {
  k.box(0, 0, 0.23, 1.0, 1.9, 0.44, C.white); k.box(0, 1.0, 0.452, 0.9, 0.8, 0.006, C.glass, 6); k.box(0, 1.84, 0.452, 1.0, 0.06, 0.008, C.teal); k.box(0, 0.1, 0.452, 0.012, 0.85, 0.008, C.dsteel);
  for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) if (r() < 0.7) k.box(-0.33 + i * 0.22, 1.05 + j * 0.26, 0.4, 0.14, 0.12 + r() * 0.08, 0.06, pick(r, [C.white, C.teal, C.red, C.offwhite, C.blue]));
} });
const gunRack = (r) => { const n = 1 + Math.floor(r() * 2), L = n * 1.72; return { L, D: 0.42, H: 1.5, metal: true, draw(k) { for (let i = 0; i < n; i++) { k.push(-L / 2 + 0.86 + i * 1.72, 0); gunRackAt(k, r); k.pop(); } } }; };
function gunRackAt(k, r) {
  k.box(0, 0, 0.21, 1.7, 0.12, 0.4, C.dsteel); k.box(0, 0.12, 0.03, 1.7, 1.38, 0.04, C.dsteel); k.box(0, 1.0, 0.2, 1.7, 0.05, 0.2, C.dsteel);
  for (const sx of [-1, 1]) k.box(sx * 0.83, 0, 0.21, 0.04, 1.5, 0.4, C.dsteel);
  for (let i = 0; i < 7; i++) { if (r() < 0.3) continue; const x = -0.66 + i * 0.22; k.box(x, 0.12, 0.2, 0.05, 0.9 + r() * 0.3, 0.07, C.black); k.box(x, 0.12, 0.22, 0.045, 0.3, 0.12, r() < 0.4 ? C.woodD : C.black); }
}
const ammo = (r) => { const n = 1 + Math.floor(r() * 3), L = n * 1.0; return { L, D: 0.62, H: 0.9, metal: true, draw(k) {
  let top = 0;
  for (let i = 0; i < n; i++) { const x = -L / 2 + 0.5 + i, rows = 2 + Math.floor(r() * 3); for (let j = 0; j < rows; j++) { const dx = (r() - 0.5) * 0.06; k.box(x + dx, j * 0.3, 0.31, 0.92, 0.29, 0.56, C.olive); k.box(x + dx, j * 0.3 + 0.1, 0.593, 0.5, 0.08, 0.006, C.yellow); for (const sx of [-1, 1]) k.box(x + dx + sx * 0.3, j * 0.3 + 0.2, 0.595, 0.06, 0.07, 0.012, C.dsteel, 5); } top = Math.max(top, rows * 0.3); }
  this.H = top;
} }; };
const counter = (r) => { const L = 2.4 + Math.floor(r() * 2) * 0.8; return { L, D: 0.74, H: 1.12, draw(k) {
  const col = pick(r, [C.navy, C.woodD, C.greyblue, C.teal]);
  k.box(0, 0.08, 0.37, L, 1.0, 0.66, col); k.box(0, 0, 0.37, L - 0.1, 0.08, 0.6, C.black); k.box(0, 1.08, 0.37, L + 0.08, 0.04, 0.74, C.offwhite);
  k.box(-L / 4, 1.12, 0.3, 0.4, 0.02, 0.3, C.paper, 0, 0.3); if (r() < 0.7) { k.box(L / 4, 1.12, 0.3, 0.2, 0.015, 0.16, C.black); k.box(L / 4, 1.13, 0.3, 0.5, 0.3, 0.03, C.black); k.box(L / 4, 1.145, 0.282, 0.46, 0.26, 0.006, G.screen, 1); }
} }; };
const sofa = (r) => ({ L: 1.9, D: 0.86, H: 0.82, draw(k) {
  const col = pick(r, [C.brown, C.navy, C.olive, C.greyblue]);
  k.box(0, 0.1, 0.45, 1.9, 0.32, 0.8, col); k.box(0, 0.42, 0.13, 1.9, 0.4, 0.22, col); for (const sx of [-1, 1]) k.box(sx * 0.86, 0.42, 0.5, 0.18, 0.2, 0.7, col);
  for (const sx of [-0.45, 0.45]) k.box(sx, 0.42, 0.52, 0.8, 0.08, 0.56, col);
} });
const machine = (r) => ({ L: 2.1, D: 0.92, H: 1.32, metal: true, draw(k) {
  const col = pick(r, [C.green, C.greyblue, C.teal, C.olive]);
  k.box(0, 0, 0.46, 2.0, 0.72, 0.8, col); k.box(0, 0.72, 0.46, 2.1, 0.06, 0.9, C.dsteel); k.box(-0.7, 0.78, 0.46, 0.6, 0.52, 0.6, col); k.cyl(-0.38, 0.9, 0.46, 0.3, 0.14, C.steel, 5, 1);
  k.cyl(0.25, 0.98, 0.46, 0.07, 1.1, C.steel, 5, 1); k.box(0.3, 0.78, 0.46, 0.3, 0.12, 0.5, C.dsteel); k.box(0.85, 0.78, 0.46, 0.22, 0.3, 0.3, col);
  k.box(-0.7, 1.3, 0.46, 0.3, 0.3, 0.12, C.dsteel); k.box(-0.7, 1.4, 0.525, 0.04, 0.04, 0.01, G.ledG, 1); k.box(-0.62, 1.4, 0.525, 0.04, 0.04, 0.01, G.ledR, 2);
} });
// small, never solid
const bins = (r) => ({ L: 0.9, D: 0.45, H: 0, soft: true, draw(k) {
  k.cyl(-0.2, 0, 0.22, 0.32, 0.4, pick(r, [C.dsteel, C.steel, C.navy])); if (r() < 0.7) k.box(0.22, 0, 0.2, 0.34, 0.26, 0.3, pick(r, BOXCOLS), 0, r() * 0.6);
  if (r() < 0.5) k.box(0.2, 0.26, 0.2, 0.26, 0.2, 0.24, pick(r, BOXCOLS), 0, r());
} });
const plant = (r) => ({ L: 0.6, D: 0.5, H: 0, soft: true, draw(k) { k.cyl(0, 0, 0.25, 0.36, 0.4, C.rust); k.cyl(0, 0.4, 0.25, 0.06, 0.5, C.woodD); for (let i = 0; i < 4; i++) k.box((r() - 0.5) * 0.2, 0.7 + i * 0.15, 0.25 + (r() - 0.5) * 0.16, 0.34 - i * 0.05, 0.17, 0.34 - i * 0.05, C.plant, 0, r() * 1.5, (r() - 0.5) * 0.5); } });
const cooler = (r) => ({ L: 0.5, D: 0.42, H: 0, soft: true, draw(k) { k.box(0, 0, 0.2, 0.34, 1.0, 0.34, C.offwhite); k.cyl(0, 1.0, 0.2, 0.28, 0.4, [0.35, 0.6, 0.8], 6); k.box(0, 0.7, 0.375, 0.2, 0.1, 0.01, C.dsteel); } });
const whiteboard = (r) => ({ L: 1.8, D: 0.07, H: 0, soft: true, tall: true, draw(k) {
  k.box(0, 0.95, 0.035, 1.8, 1.1, 0.03, C.steel); k.box(0, 0.99, 0.052, 1.72, 1.02, 0.006, C.white);
  for (let i = 0; i < 6; i++) k.box(-0.7 + r() * 1.3, 1.1 + r() * 0.8, 0.057, 0.15 + r() * 0.5, 0.012, 0.003, pick(r, [C.blue, C.red, C.black, C.green]), 0, 0, 0);
  for (let i = 0; i < 3; i++) k.box(-0.6 + i * 0.5, 1.15 + r() * 0.5, 0.057, 0.2, 0.26, 0.003, pick(r, [C.yellow, C.paper, C.paper]));
} });
const footlockers = (r) => ({ L: 1.9, D: 0.5, H: 0, soft: true, draw(k) { for (const x of [-0.5, 0.5]) { if (r() < 0.25) continue; k.box(x, 0, 0.25, 0.8, 0.36, 0.42, pick(r, [C.olive, C.woodD, C.dsteel])); k.box(x, 0.16, 0.465, 0.1, 0.06, 0.012, C.steel, 5); } } });
const toolchest = (r) => ({ L: 1.0, D: 0.52, H: 1.05, metal: true, draw(k) { k.box(0, 0.1, 0.26, 1.0, 0.94, 0.5, C.red); for (let j = 0; j < 5; j++) { k.box(0, 0.2 + j * 0.17, 0.515, 0.8, 0.02, 0.012, C.steel, 5); k.box(0, 0.13 + j * 0.17, 0.512, 0.94, 0.01, 0.006, C.black); } for (const sx of [-1, 1]) k.cyl(sx * 0.4, 0, 0.26, 0.1, 0.3, C.black, 0, 2); if (r() < 0.6) k.box(0.1, 1.04, 0.26, 0.4, 0.16, 0.24, C.blue); } });

const stockpile = (r) => { const L = 2.6 + Math.floor(r() * 3) * 1.25, D = r() < 0.5 ? 1.1 : 2.3, h = 1.2 + r() * 0.7, col = pick(r, [C.tarp, C.olive, C.greyblue, C.sand, C.rust]); return { L, D, H: h, draw(k, s) {
  for (let x = -L / 2 + 0.62; x < L / 2; x += 1.25) for (let z = 0.55; z < D; z += 1.15) { for (const dz of [-0.42, 0, 0.42]) k.box(x, 0, z + dz, 1.18, 0.1, 0.1, C.pallet); k.box(x, 0.1, z, 1.16, 0.03, 1.0, C.pallet); }
  s.box(0, 0.13, D / 2, L - 0.06, h - 0.13, D - 0.06, col); k.box(0, h - 0.02, D / 2, L + 0.02, 0.04, D + 0.02, col);
  for (let x = -L / 2 + 0.7; x < L / 2; x += 1.3) { k.box(x, 0.12, D / 2, 0.07, h - 0.08, D + 0.03, C.yellow); k.box(x, h + 0.02, D / 2, 0.07, 0.012, D + 0.03, C.yellow); }
  for (let i = 0; i < 3; i++) if (r() < 0.6) k.box((r() - 0.5) * (L - 1), h + 0.02, 0.3 + r() * (D - 0.6), 0.4 + r() * 0.5, 0.2 + r() * 0.3, 0.4 + r() * 0.3, pick(r, BOXCOLS), 0, r());
} }; };
const THEMES = {
  office: { wall: [[deskRun, 6], [cabinets, 3], [shelf, 3], [sofa, 1.5], [cooler, 0.4], [plant, 0.7], [whiteboard, 2], [bins, 1]], island: [deskCluster, deskCluster, counter] },
  barracks: { wall: [[bunk, 5], [lockers, 4], [footlockers, 2], [cabinets, 1], [bins, 1]], island: [messTable, bunkPair] },
  workshop: { wall: [[workbench, 4], [shelf, 2], [drums, 2], [lockers, 1], [crates, 2], [toolchest, 2], [bins, 1]], island: [pallet, machine, crates, machine] },
  storage: { wall: [[racking, 4], [pallet, 2], [crates, 2], [drums, 2], [shelf, 1], [palletBlock, 2], [stockpile, 2]], island: [palletBlock, stockpile, rackIsland, stockpile] },
  server: { wall: [[serverRow, 5], [cooling, 2], [deskRun, 1], [cabinets, 1], [bins, 1]], island: [serverIsland, serverIsland, deskCluster] },
  armoury: { wall: [[gunRack, 4], [ammo, 4], [lockers, 2], [workbench, 1], [crates, 1], [footlockers, 1]], island: [palletBlock, messTable, crates] },
  infirmary: { wall: [[medBed, 5], [medCab, 3], [deskRun, 1], [cabinets, 1], [cooler, 1], [plant, 1]], island: [counter, messTable] },
  watch: { wall: [[bunk, 2], [lockers, 2], [deskRun, 2], [gunRack, 1], [ammo, 1], [footlockers, 1], [whiteboard, 1]], island: [messTable, counter] },
};
const pickW = (r, list) => { let t = 0; for (const e of list) t += e[1]; let x = r() * t; for (const e of list) { x -= e[1]; if (x <= 0) return e[0]; } return list[0][0]; };

// ---- outdoor pieces (same frame: x along the length, z across from 0 to D) ---------------
function wheels(k, xs, D, dia = 0.9) { for (const x of xs) for (const z of [0.16, D - 0.16]) { k.cyl(x, 0, z, dia, 0.3, C.rubber, 0, 2); k.cyl(x, dia * 0.25, z + (z < D / 2 ? -0.16 : 0.16), dia * 0.5, 0.02, C.steel, 5, 2); } }
function cab(k, s, r, x, D, col, h = 1.9) { // front of the cab points to +x
  s.box(x, 0.6, D / 2, 1.7, h, D - 0.1, col); k.box(x + 0.86, 0.6 + h * 0.45, D / 2, 0.02, h * 0.42, D - 0.4, C.glass, 6);
  for (const z of [0.045, D - 0.045]) k.box(x + 0.2, 0.6 + h * 0.48, z, 0.8, h * 0.36, 0.02, C.glass, 6);
  k.box(x + 0.9, 0.5, D / 2, 0.14, 0.26, D, C.dsteel); k.box(x + 0.87, 0.85, D / 2, 0.02, 0.4, D * 0.5, C.black);
  const on = r() < 0.2; for (const z of [0.3, D - 0.3]) { k.box(x + 0.875, 0.9, z, 0.02, 0.16, 0.26, on ? G.white : C.offwhite, on ? 1 : 6); k.box(x - 0.86, 0.9, z, 0.02, 0.12, 0.2, C.red); }
  for (const z of [-0.06, D + 0.06]) k.box(x + 0.7, 0.6 + h * 0.5, z, 0.05, 0.3, 0.14, C.black);
}
const truck = (r) => { const D = 2.4, kind = r(), col = pick(r, CARCOLS); return { L: 6.6, D, H: 2.9, metal: true, cols: kind < 0.5 ? [[-3.3, 1.5, 0, D, 2.95], [1.5, 3.3, 0, D, 2.5]] : [[-3.3, 1.5, 0, D, kind < 0.8 ? 1.65 : 2.75], [1.5, 3.3, 0, D, 2.5]], draw(k, s) {
  k.box(-0.2, 0.42, D / 2, 6.2, 0.22, 1.0, C.dsteel); wheels(k, [2.3, -1.5, -2.6], D); cab(k, s, r, 2.4, D, col);
  if (kind < 0.5) { const bc = r() < 0.6 ? C.offwhite : pick(r, CARCOLS); s.box(-0.95, 0.72, D / 2, 4.6, 2.2, D, bc); k.box(-3.26, 0.76, D / 2, 0.02, 2.1, 0.03, C.dsteel); for (const z of [0.3, D - 0.3]) k.box(-3.27, 0.9, z, 0.03, 1.8, 0.04, C.steel, 5); k.box(-0.95, 0.72, D / 2, 4.64, 0.08, D + 0.04, C.dsteel); k.box(-0.95, 1.6, -0.006, 2.6, 0.5, 0.01, col); k.box(-0.95, 1.6, D + 0.006, 2.6, 0.5, 0.01, col); }
  else if (kind < 0.8) { s.box(-0.95, 0.72, D / 2, 4.7, 0.14, D, C.woodD); k.box(1.36, 0.86, D / 2, 0.08, 1.3, D, C.dsteel); for (const z of [0.04, D - 0.04]) k.box(-0.95, 0.86, z, 4.7, 0.3, 0.05, col); const q = r(); if (q < 0.4) { for (const z of [0.5, 1.2, 1.9]) k.cyl(-1.0, 0.86, z, 0.56, 4.2, C.conc, 0, 1); } else if (q < 0.8) { for (let i = 0; i < 3; i++) crate(k, r, -2.4 + i * 1.3 + r() * 0.2, 0.86, 0.7 + r() * 1.0, 0.8 + r() * 0.2, r() * 0.3); } }
  else { s.box(-0.95, 0.72, D / 2, 4.7, 0.14, D, C.dsteel); k.cyl(-0.95, 0.86, D / 2, 1.9, 4.5, pick(r, [C.steel, C.offwhite, C.rust]), 5, 1); for (const x of [-2.6, -0.95, 0.7]) k.cyl(x, 0.84, D / 2, 1.96, 0.08, C.dsteel, 0, 1); k.cyl(-0.95, 2.74, D / 2, 0.5, 0.12, C.dsteel); }
} }; };
const van = (r) => { const D = 2.0, col = pick(r, CARCOLS); return { L: 4.9, D, H: 2.2, metal: true, cols: [[-2.45, 1.4, 0, D, 2.22], [1.4, 2.45, 0, D, 1.3]], draw(k, s) {
  wheels(k, [1.6, -1.5], D, 0.74); s.box(-0.5, 0.36, D / 2, 3.9, 1.85, D, col); s.box(1.9, 0.36, D / 2, 1.0, 0.9, D - 0.06, col);
  k.box(1.52, 1.3, D / 2, 0.5, 0.85, D - 0.3, C.glass, 6, 0, 0); for (const z of [-0.006, D + 0.006]) { k.box(0.9, 1.45, z, 0.8, 0.55, 0.01, C.glass, 6); k.box(-1.0, 1.0, z, 0.02, 1.4, 0.012, C.dsteel); if (r() < 0.5) k.box(-1.0, 1.3, z, 1.6, 0.25, 0.008, C.teal); }
  k.box(2.42, 0.4, D / 2, 0.08, 0.24, D, C.dsteel); for (const z of [0.3, D - 0.3]) { k.box(2.41, 0.95, z, 0.02, 0.14, 0.26, C.offwhite, 6); k.box(-2.46, 1.0, z, 0.02, 0.3, 0.12, C.red); }
  k.box(-2.456, 1.2, D / 2, 0.01, 1.5, 0.02, C.dsteel); if (r() < 0.4) k.box(-0.5, 2.21, D / 2, 2.4, 0.06, 1.3, C.dsteel);
} }; };
const pickup = (r) => { const D = 1.9, col = pick(r, CARCOLS); return { L: 4.8, D, H: 1.75, metal: true, cols: [[-2.4, -0.2, 0, D, 1.12], [-0.2, 2.4, 0, D, 1.75]], draw(k, s) {
  wheels(k, [1.55, -1.5], D, 0.78); s.box(0, 0.38, D / 2, 4.8, 0.66, D, col); s.box(0.55, 1.04, D / 2, 1.6, 0.7, D - 0.1, col); k.box(1.37, 1.1, D / 2, 0.02, 0.56, D - 0.3, C.glass, 6); for (const z of [0.045, D - 0.045]) k.box(0.55, 1.14, z, 1.3, 0.5, 0.02, C.glass, 6);
  for (const z of [0.04, D - 0.04]) k.box(-1.35, 1.04, z, 2.1, 0.08, 0.06, col); k.box(-2.37, 1.04, D / 2, 0.06, 0.08, D, col);
  if (r() < 0.7) crate(k, r, -1.3, 0.66, D / 2, 0.8, r() * 0.4); if (r() < 0.5) drum(k, r, -2.0, 0.66, 0.6, 0.44);
  k.box(2.4, 0.42, D / 2, 0.08, 0.2, D, C.dsteel); for (const z of [0.3, D - 0.3]) { k.box(2.405, 0.82, z, 0.02, 0.12, 0.24, C.offwhite, 6); k.box(-2.405, 0.85, z, 0.02, 0.14, 0.1, C.red); }
} }; };
const forklift = (r) => ({ L: 2.7, D: 1.2, H: 2.1, metal: true, cols: [[-1.2, 0.5, 0, 1.2, 2.12]], draw(k, s) {
  const col = pick(r, [C.yellow, C.orange, C.yellow]);
  k.cyl(-0.75, 0, 0.14, 0.5, 0.24, C.rubber, 0, 2); k.cyl(-0.75, 0, 1.06, 0.5, 0.24, C.rubber, 0, 2); k.cyl(0.25, 0, 0.14, 0.6, 0.26, C.rubber, 0, 2); k.cyl(0.25, 0, 1.06, 0.6, 0.26, C.rubber, 0, 2);
  s.box(-0.35, 0.22, 0.6, 1.6, 0.7, 1.1, col); k.box(-1.0, 0.92, 0.6, 0.36, 0.3, 1.0, C.dsteel); k.box(-0.35, 0.92, 0.6, 0.5, 0.12, 0.5, C.black); k.box(-0.62, 1.04, 0.6, 0.08, 0.45, 0.5, C.black);
  for (const sx of [-1.05, 0.2]) for (const z of [0.1, 1.1]) k.box(sx, 0.92, z, 0.06, 1.14, 0.06, C.dsteel); k.box(-0.42, 2.04, 0.6, 1.36, 0.05, 1.1, C.dsteel);
  for (const z of [0.3, 0.9]) { k.box(0.52, 0.06, z, 0.1, 2.3, 0.1, C.dsteel); k.box(1.1, 0.07, z, 1.1, 0.05, 0.12, C.steel, 5); } k.box(0.52, 1.2, 0.6, 0.06, 0.08, 0.7, C.dsteel); k.box(0.58, 0.1, 0.6, 0.05, 0.6, 0.9, C.dsteel);
  k.box(-1.14, 1.9, 0.6, 0.1, 0.1, 0.1, G.beacon, 4);
} });
const skip = (r) => ({ L: 3.4, D: 1.8, H: 1.35, metal: true, draw(k, s) {
  const col = pick(r, [C.rust, C.blue, C.yellow, C.green, C.dsteel]);
  s.box(0, 0.1, 0.9, 3.1, 1.2, 1.7, col); k.box(0, 1.25, 0.9, 3.4, 0.08, 1.8, col); for (const x of [-1.2, 0, 1.2]) for (const z of [0.03, 1.77]) k.box(x, 0.1, z, 0.1, 1.15, 0.05, C.dsteel);
  for (let i = 0; i < 6; i++) k.box((r() - 0.5) * 2.6, 1.28, 0.3 + r() * 1.2, 0.3 + r() * 0.7, 0.1 + r() * 0.25, 0.3 + r() * 0.5, pick(r, [C.card, C.wood, C.offwhite, C.black, C.tarp]), 0, r() * 3, (r() - 0.5) * 0.5);
} });
const barrierRow = (r) => { const n = 2 + Math.floor(r() * 3), L = n * 2.0, plastic = r() < 0.45; return { L, D: 0.56, H: 0.92, draw(k, s) {
  for (let i = 0; i < n; i++) { const x = -L / 2 + 1.0 + i * 2.0, col = plastic ? (i % 2 ? C.white : C.red) : C.conc; s.box(x, 0, 0.28, 1.94, 0.3, 0.56, col); s.box(x, 0.3, 0.28, 1.94, 0.6, 0.26, col); if (!plastic && r() < 0.5) k.box(x, 0.5, 0.28, 0.9, 0.2, 0.27, C.yellow); }
} }; };
const pipes = (r) => { const col = pick(r, [C.conc, C.conc, C.blue, C.rust, C.dsteel]), len = 4 + r() * 2; return { L: len, D: 2.0, H: 1.22, draw(k) {
  for (const z of [0.36, 1.0, 1.64]) { k.cyl(0, 0.08, z, 0.62, len, col, 0, 1); k.cyl(len / 2 - 0.02, 0.14, z, 0.5, 0.02, C.black, 0, 1); k.cyl(-len / 2 + 0.02, 0.14, z, 0.5, 0.02, C.black, 0, 1); }
  for (const z of [0.68, 1.32]) k.cyl((r() - 0.5) * 0.3, 0.62, z, 0.62, len, col, 0, 1);
  for (const x of [-len / 3, len / 3]) k.box(x, 0, 1.0, 0.14, 0.08, 2.0, C.wood);
} }; };
const reels = (r) => ({ L: 1.5, D: 2.3, H: 1.5, cols: [[-0.75, 0.75, 0, 1.0, 1.5]], draw(k) {
  const cable = pick(r, [C.black, C.orange, C.dsteel]);
  for (const z of [0.06, 0.94]) k.cyl(0, 0, z, 1.5, 0.08, C.wood, 0, 2); k.cyl(0, 0.3, 0.5, 0.9, 0.8, cable, 0, 2);
  if (r() < 0.7) { k.cyl(0.1, 0, 1.75, 1.1, 0.07, C.wood); k.cyl(0.1, 0.07, 1.75, 0.6, 0.5, cable); k.cyl(0.1, 0.57, 1.75, 1.1, 0.07, C.wood); }
} });
const tyres = (r) => ({ L: 1.9, D: 1.0, H: 0.98, draw(k) {
  for (const x of [-0.5, 0.42]) { const n = 3 + Math.floor(r() * 2); for (let j = 0; j < n; j++) k.cyl(x + (r() - 0.5) * 0.08, j * 0.25, 0.5 + (r() - 0.5) * 0.08, 0.84, 0.24, C.rubber); }
  if (r() < 0.6) k.cyl(-0.05, 0, 0.9, 0.84, 0.24, C.rubber, 0, 2);
} });
const generator = (r) => ({ L: 2.3, D: 1.1, H: 1.42, metal: true, draw(k, s) {
  const col = pick(r, [C.yellow, C.green, C.offwhite, C.orange]);
  k.box(0, 0, 0.55, 2.3, 0.14, 1.0, C.dsteel); s.box(0, 0.14, 0.55, 2.1, 1.25, 1.0, col); for (let j = 0; j < 6; j++) k.box(-0.5, 0.4 + j * 0.11, 1.056, 0.8, 0.04, 0.01, C.dsteel);
  k.box(0.6, 0.7, 1.056, 0.5, 0.4, 0.01, C.black); k.box(0.5, 0.95, 1.064, 0.05, 0.05, 0.008, G.ledG, 2); k.box(0.62, 0.95, 1.064, 0.05, 0.05, 0.008, G.ledA, 1);
  k.cyl(-0.8, 1.39, 0.4, 0.12, 0.5, C.dsteel, 5); if (r() < 0.7) for (let i = 0; i < 2; i++) k.box(1.5 + i * 0.4, 0, 0.3 + r() * 0.4, 0.3, 0.44, 0.18, pick(r, [C.red, C.olive]), 0, r());
} });
const cabins = (r) => { const n = 1 + Math.floor(r() * 3), L = n * 1.24, col = pick(r, [C.blue, C.teal, C.green, C.greyblue]); return { L, D: 1.2, H: 2.32, draw(k, s) {
  for (let i = 0; i < n; i++) { const x = -L / 2 + 0.62 + i * 1.24; s.box(x, 0.06, 0.6, 1.16, 2.1, 1.16, col); k.box(x, 2.16, 0.6, 1.22, 0.14, 1.22, C.offwhite); k.box(x, 0, 0.6, 1.2, 0.06, 1.2, C.dsteel); k.box(x, 0.12, 1.185, 0.8, 1.85, 0.01, C.offwhite); k.box(x + 0.3, 1.0, 1.195, 0.06, 0.12, 0.02, C.dsteel, 5); k.box(x, 1.75, 1.19, 0.5, 0.12, 0.008, C.black); }
} }; };
const hoarding = (r) => { const n = 2 + Math.floor(r() * 3), L = n * 2.4; return { L, D: 0.3, H: 2.05, metal: true, draw(k, s) {
  const a = pick(r, [C.blue, C.greyblue, C.green, C.offwhite]), b = r() < 0.5 ? C.offwhite : a;
  for (let i = 0; i < n; i++) { const x = -L / 2 + 1.2 + i * 2.4; s.box(x, 0.12, 0.15, 2.36, 1.9, 0.05, i % 2 ? a : b); k.box(x - 1.2, 0, 0.15, 0.08, 2.05, 0.08, C.dsteel); k.box(x, 0, 0.15, 0.6, 0.12, 0.3, C.conc); }
  k.box(L / 2, 0, 0.15, 0.08, 2.05, 0.08, C.dsteel); k.box(0, 1.9, 0.15, L, 0.06, 0.07, C.dsteel);
} }; };
const sandbags = (r) => { const L = 2.6 + Math.floor(r() * 2) * 1.3; return { L, D: 0.72, H: 1.02, draw(k, s) {
  const n = Math.round(L / 0.65);
  for (let j = 0; j < 4; j++) for (let i = 0; i < n - (j % 2); i++) for (const z of j < 2 ? [0.2, 0.52] : [0.36]) k.box(-L / 2 + 0.33 + i * 0.65 + (j % 2) * 0.32, j * 0.25, z + (r() - 0.5) * 0.04, 0.62, 0.23, 0.32, r() < 0.8 ? C.sand : C.card, 0, (r() - 0.5) * 0.12);
} }; };
const gasCage = (r) => ({ L: 1.6, D: 0.8, H: 1.7, metal: true, draw(k) {
  for (const sx of [-1, 1]) for (const z of [0.04, 0.76]) k.box(sx * 0.77, 0, z, 0.05, 1.7, 0.05, C.yellow); for (const y of [0.1, 0.85, 1.65]) { for (const z of [0.04, 0.76]) k.box(0, y, z, 1.6, 0.04, 0.04, C.yellow); for (const sx of [-1, 1]) k.box(sx * 0.77, y, 0.4, 0.04, 0.04, 0.76, C.yellow); }
  for (let i = 0; i < 5; i++) { const x = -0.6 + i * 0.3, c = pick(r, [C.red, C.steel, C.blue, C.green]); k.cyl(x, 0.06, 0.4 + (i % 2 ? 0.14 : -0.14), 0.24, 1.3, c); k.cyl(x, 1.36, 0.4 + (i % 2 ? 0.14 : -0.14), 0.08, 0.14, C.steel, 5); }
} });
const planter = (r) => ({ L: 2.2, D: 0.9, H: 0.95, draw(k, s) { s.box(0, 0, 0.45, 2.2, 0.8, 0.9, C.conc); k.box(0, 0.8, 0.45, 2.0, 0.04, 0.7, C.brown); for (let i = 0; i < 7; i++) k.box(-0.85 + i * 0.28 + (r() - 0.5) * 0.1, 0.82, 0.45 + (r() - 0.5) * 0.3, 0.34, 0.25 + r() * 0.5, 0.34, C.plant, 0, r() * 1.5); } });
const condenser = (r) => ({ L: 1.1, D: 0.5, H: 0.96, metal: true, draw(k) { k.box(0, 0.12, 0.25, 1.0, 0.82, 0.42, C.offwhite); k.cyl(-0.12, 0.2, 0.465, 0.6, 0.02, C.dsteel, 0, 2); k.cyl(-0.12, 0.42, 0.47, 0.14, 0.03, C.steel, 5, 2); for (const sx of [-1, 1]) k.box(sx * 0.4, 0, 0.25, 0.08, 0.12, 0.44, C.dsteel); k.box(0.42, 0.3, 0.03, 0.04, 2.2, 0.04, C.dsteel); } });
const looseBoxes = (r) => ({ L: 1.4, D: 0.6, H: 0, soft: true, draw(k) { for (let i = 0; i < 3; i++) { const sz = 0.25 + r() * 0.25; k.box(-0.45 + i * 0.45 + (r() - 0.5) * 0.1, 0, 0.3 + (r() - 0.5) * 0.1, sz, sz * (0.6 + r() * 0.5), sz, pick(r, BOXCOLS), 0, r() * 1.5); } if (r() < 0.4) k.cyl(0.5, 0, 0.3, 0.34, 0.45, C.dsteel); } });

// roof plant
const acUnit = (r) => ({ L: 1.8, D: 1.25, H: 1.3, metal: true, draw(k, s) {
  s.box(0, 0.14, 0.62, 1.7, 1.1, 1.15, C.offwhite); for (const sx of [-1, 1]) k.box(sx * 0.7, 0, 0.62, 0.12, 0.14, 1.2, C.dsteel);
  for (const sx of [-0.42, 0.42]) { k.cyl(sx, 1.24, 0.62, 0.7, 0.06, C.dsteel); k.cyl(sx, 1.28, 0.62, 0.2, 0.04, C.steel, 5); }
  for (let j = 0; j < 6; j++) k.box(0, 0.3 + j * 0.13, 1.2, 1.5, 0.04, 0.012, C.dsteel); k.cyl(0.95, 0.2, 0.3, 0.1, 1.4, C.steel, 5, 2);
} });
const tank = (r) => ({ L: 2.0, D: 2.0, H: 2.72, metal: true, draw(k, s) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(sx * 0.75, 0, 1.0 + sz * 0.75, 0.1, 0.6, 0.1, C.dsteel); k.box(0, 0.56, 1.0, 1.8, 0.08, 1.8, C.dsteel);
  k.cyl(0, 0.64, 1.0, 1.9, 2.0, pick(r, [C.steel, C.offwhite, C.rust, C.greyblue]), 0); for (const y of [1.0, 1.7, 2.3]) k.cyl(0, y, 1.0, 1.95, 0.05, C.dsteel); k.cyl(0, 2.64, 1.0, 1.5, 0.08, C.dsteel); k.cyl(0.98, 0, 1.0, 0.1, 1.4, C.steel, 5);
  s.box(0, 0.64, 1.0, 1.3, 1.9, 1.3, C.dsteel);
} });
function vent(k, r, x, z) { k.cyl(x, 0, z, 0.36, 0.5, C.steel, 5); k.cyl(x, 0.5, z, 0.62, 0.14, C.steel, 5); k.box(x, 0, z, 0.6, 0.05, 0.6, C.dsteel); }
function skylight(k, r, x, z) { k.box(x, 0, z, 1.7, 0.3, 1.2, C.conc); k.box(x, 0.3, z, 1.5, 0.05, 1.0, r() < 0.5 ? G.dim : C.glass, r() < 0.5 ? 1 : 6); }
function solar(k, r, x, z, n) { for (let i = 0; i < n; i++) { k.box(x + i * 1.15, 0.12, z, 1.05, 0.04, 1.7, [0.03, 0.05, 0.12], 6, 0, 0.3); k.box(x + i * 1.15, 0, z + 0.6, 0.06, 0.5, 0.06, C.dsteel); k.box(x + i * 1.15, 0, z - 0.6, 0.06, 0.12, 0.06, C.dsteel); } }
function mast(k, r, x, z, h) {
  for (const [dx, dz] of [[-0.25, -0.25], [0.25, -0.25], [0, 0.3]]) k.box(x + dx * 0.6, 0, z + dz * 0.6, 0.06, h, 0.06, C.steel, 5);
  for (let y = 0.8; y < h; y += 1.4) k.box(x, y, z, 0.5, 0.04, 0.5, C.steel, 5, y);
  k.box(x, h, z, 0.05, 2.0, 0.05, C.red); k.box(x, h + 2.0, z, 0.16, 0.16, 0.16, G.ledR, 4);
  if (r() < 0.8) { k.cyl(x + 0.4, h * 0.62, z, 0.9, 0.08, C.offwhite, 0, 1); k.box(x + 0.2, h * 0.62 + 0.4, z, 0.4, 0.05, 0.05, C.dsteel); }
  if (r() < 0.6) for (const dz of [-0.5, 0.5]) k.box(x, h * 0.85, z + dz, 0.12, 1.2, 0.2, C.offwhite);
}

// =====================================================================================
export function createDressing(ctx, { lamps, ground, sign }) {
  const { scene, world, camera, events } = ctx;
  const Mw = world.materials, H = world.arenaHalf;
  const U = { time: { value: 0 }, alarm: { value: 0 } };
  const mat = propMaterial(U);
  const softMat = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9, metalness: 0 }); // what a bullet "hits" on wood / fabric pieces (never drawn)
  const root = new THREE.Group(); root.name = 'dressing'; scene.add(root);
  const seed = (world.seed ^ 0x5eed1e) >>> 0;
  const FH = 3.6, T = 0.3, SLAB = 0.3, LANE = 1.6;
  const INTERIOR_RANGE = 92, MAX_IN = 300, MAX_OUT = 195;
  const stats = { instances: 0, colliders: 0, collidersIn: 0, collidersOut: 0, meshes: 0, items: 0, vehicles: 0, lamps: 0 };
  const items = []; // { x, z, sy (height of the surface it rests on / hangs from), ranges: [[kit, a, b]], c: [colliders] }
  const hit = (list, x0, x1, z0, z1) => { for (const q of list) if (x0 < q[1] && x1 > q[0] && z0 < q[3] && z1 > q[2]) return true; return false; };

  function solid(x0, x1, y0, y1, z0, z1, metal) {
    const c = world.addBox((x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, y1 - y0 + 0.013, z1 - z0, metal ? Mw.trim : softMat, { tag: 'prop', destructible: false, shadow: false });
    c.mesh.removeFromParent(); c.mesh.visible = false; c.dressing = true; stats.colliders++;
    return c;
  }
  // world box of a wall-frame rectangle [lx0, lx1] x [lz0, lz1] placed at (ox, oz) turned by a (multiples of 90 degrees)
  function rect(ox, oz, a, lx0, lx1, lz0, lz1) {
    const cs = Math.round(Math.cos(a)), sn = Math.round(Math.sin(a));
    const xa = ox + lx0 * cs + lz0 * sn, xb = ox + lx1 * cs + lz1 * sn, za = oz - lx0 * sn + lz0 * cs, zb = oz - lx1 * sn + lz1 * cs;
    return [Math.min(xa, xb), Math.max(xa, xb), Math.min(za, zb), Math.max(za, zb)];
  }
  // draw a spec at a wall-frame origin; returns the item record
  function place(spec, k, s, ox, oy, oz, a, sy = oy) {
    const mk = k.mark(), ms = s.mark();
    k.at(ox, oy, oz, a); if (s !== k) s.at(ox, oy, oz, a);
    spec.draw(k, s);
    const it = { x: 0, z: 0, sy, ranges: k.since(mk), c: [] };
    if (s !== k) it.ranges.push(...s.since(ms));
    const F = rect(ox, oz, a, -spec.L / 2, spec.L / 2, 0, spec.D); it.x = (F[0] + F[1]) / 2; it.z = (F[2] + F[3]) / 2;
    if (!spec.soft && spec.H > 0) {
      for (const [lx0, lx1, lz0, lz1, h] of spec.cols || [[-spec.L / 2, spec.L / 2, 0, spec.D, spec.H]]) { const q = rect(ox, oz, a, lx0, lx1, lz0, lz1); it.c.push(solid(q[0], q[1], oy, oy + h, q[2], q[3], spec.metal)); }
    }
    items.push(it); stats.items++;
    return it;
  }
  const nCols = (spec) => (spec.soft || !(spec.H > 0) ? 0 : (spec.cols ? spec.cols.length : 1));
  const SIDES = { n: [0, 1, 0], s: [Math.PI, -1, 0], w: [Math.PI / 2, 0, 1], e: [-Math.PI / 2, 0, -1] };

  // kits: per sector of the site one for boxes and one for cylinders; interiors add a box kit per building
  const SEC = 3, secCyl = Array.from({ length: SEC * SEC }, () => new Kit(null, true)), secKits = secCyl.map((c) => new Kit(c)), castKit = new Kit();
  const secOf = (x, z) => Math.min(SEC - 1, Math.max(0, Math.floor(((x + H) / (2 * H)) * SEC))) + SEC * Math.min(SEC - 1, Math.max(0, Math.floor(((z + H) / (2 * H)) * SEC)));
  // ---- interiors ------------------------------------------------------------------------
  const groups = []; // { x, z, mesh } per building
  const solidWall = (x, y, z) => world.near(x - 0.05, x + 0.05, z - 0.05, z + 0.05).some((c) => (c.tag === 'wall' || c.tag === 'pillar') && x > c.min.x && x < c.max.x && z > c.min.z && z < c.max.z && y > c.min.y && y < c.max.y);
  function themeFor(b, f, shed, r) {
    if (shed) return r() < 0.5 ? 'storage' : 'workshop';
    if (b.outpost) return { armoury: 'armoury', infirmary: 'infirmary', signal: f === 0 ? 'office' : 'server', depot: f === 0 ? 'storage' : 'office', watch: f === 0 ? 'watch' : 'barracks' }[b.outpost];
    if (b.tower && b.w < 25) return f === 0 ? 'office' : f === b.floors - 1 ? 'server' : (r() < 0.6 ? 'office' : 'barracks');
    if (b.tower) return f === 0 ? 'storage' : f === 1 ? 'workshop' : (r() < 0.5 ? 'office' : 'barracks');
    if (f === 0) return pick(r, ['workshop', 'storage', 'storage', 'office', 'barracks']);
    return pick(r, ['office', 'office', 'barracks', 'barracks', 'server', 'storage']);
  }
  const floorBudget = (b) => (b.w * b.d < 150 ? 5 : b.w * b.d < 300 ? 8 : 10);
  const inside = world.buildings.concat(world.outbuildings || []);
  const budgetScale = Math.min(1, MAX_IN / inside.reduce((t, b) => t + floorBudget(b) * b.floors, 0));
  function furnish(b, bi, shed) {
    const r = rng(seed + bi * 7919 + 13), k = new Kit(secCyl[secOf(b.x, b.z)]);
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
    const ix0 = x0 + T, ix1 = x1 - T, iz0 = z0 + T, iz1 = z1 - T;
    const px = b.tower ? Math.round(b.w / 3.2) : 0;
    for (let f = 0; f < b.floors; f++) {
      const y = f * FH, theme = THEMES[themeFor(b, f, shed, r)];
      const keep = [], furn = [], lanes = [];
      keep.push([b.x - 4.4, b.x + 4.4, b.z - 3.3, b.z + 3.3]); // stair core, its landings and the walk round it
      if (f === 0) { // doorways: the middle bay of every wall
        const n = Math.max(1, Math.round(b.w / 4)), mw = b.w / n, c = x0 + mw * (Math.floor(n / 2) + 0.5), hw = mw / 2 - 0.5 + 0.5;
        keep.push([c - hw, c + hw, z0, iz0 + 2.3], [c - hw, c + hw, iz1 - 2.3, z1]);
        const len = b.d - T * 2, n2 = Math.max(1, Math.round(len / 4)), mw2 = len / n2, c2 = iz0 + mw2 * (Math.floor(n2 / 2) + 0.5), hw2 = mw2 / 2;
        keep.push([x0, ix0 + 2.3, c2 - hw2, c2 + hw2], [ix1 - 2.3, x1, c2 - hw2, c2 + hw2]);
      }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const cx = b.x + sx * (b.w / 2 - 1.6), cz = b.z + sz * (b.d / 2 - 1.6); keep.push([cx - 0.95, cx + 0.95, cz - 0.95, cz + 0.95]); } // loot crate corners
      if (f === b.floors - 1 || (f === 0 && b.outpost === 'signal')) for (const sx of [-1, 1]) { const cx = b.x + sx * (b.w / 2 - 1.6) * 0.55; keep.push([cx - 1.0, cx + 1.0, iz1 - 2.0, iz1]); } // arms lockers / terminal
      if (f === 0 && b.outpost) for (const dx of [-2.2, 2.2]) keep.push([b.x + dx - 0.95, b.x + dx + 0.95, iz0, iz0 + 2.5]);
      const rooms = [];
      if (px) {
        for (const sx of [-1, 1]) for (const zc of [-3.2, 3.2]) keep.push([b.x + sx * px - 1.9, b.x + sx * px + 1.9, b.z + zc - 1.3, b.z + zc + 1.3]); // partition doorways
        rooms.push({ x0: ix0, x1: b.x - px - 0.13, z0: iz0, z1: iz1, inner: 'e' }, { x0: b.x - px + 0.13, x1: b.x + px - 0.13, z0: iz0, z1: iz1, inner: 'we' }, { x0: b.x + px + 0.13, x1: ix1, z0: iz0, z1: iz1, inner: 'w' });
      } else rooms.push({ x0: ix0, x1: ix1, z0: iz0, z1: iz1, inner: '' });
      let budget = Math.max(3, Math.round(floorBudget(b) * budgetScale));
      const fits = (F) => !hit(keep, F[0], F[1], F[2], F[3]) && !hit(furn, F[0], F[1], F[2], F[3]) && !hit(lanes, F[0], F[1], F[2], F[3]);
      const canAfford = (spec) => { const n = nCols(spec); return n === 0 || (budget >= n && stats.collidersIn + n <= MAX_IN); };
      const commit = (spec, ox, oz, a, F, lane) => { const n0 = stats.colliders; place(spec, k, k, ox, y, oz, a); const used = stats.colliders - n0; budget -= used; stats.collidersIn += used; furn.push(F); for (const l of lane) lanes.push(l); };
      for (const room of rooms) {
        // against the walls
        for (const sd of ['n', 's', 'w', 'e'].sort(() => r() - 0.5)) {
          const [a, , ] = SIDES[sd], alongX = sd === 'n' || sd === 's', inner = room.inner.includes(sd);
          const a0 = (alongX ? room.x0 : room.z0) + 0.06, a1 = (alongX ? room.x1 : room.z1) - 0.06;
          let p = a0 + r() * 0.5, guard = 0;
          while (p < a1 - 0.5 && guard++ < 200) {
            let done = false;
            for (let attempt = 0; attempt < 3 && !done; attempt++) {
              const spec = pickW(r, theme.wall)(r), L = spec.L;
              if (p + L > a1 || !canAfford(spec)) continue;
              const c = p + L / 2, ox = alongX ? c : (sd === 'w' ? room.x0 : room.x1), oz = alongX ? (sd === 'n' ? room.z0 : room.z1) : c;
              const F = rect(ox, oz, a, -L / 2, L / 2, 0, spec.D), lane = rect(ox, oz, a, -L / 2, L / 2, spec.D, spec.D + LANE);
              if (F[0] < room.x0 - 0.01 || F[1] > room.x1 + 0.01 || F[2] < room.z0 - 0.01 || F[3] > room.z1 + 0.01) continue;
              if (!fits(F) || hit(furn, lane[0], lane[1], lane[2], lane[3])) continue;
              if (spec.tall && !inner) { // tall pieces only where the wall behind is solid, so windows stay open
                let ok = true; const off = T / 2 + 0.02;
                for (let q = 0.15; q <= L - 0.1 && ok; q += 0.45) { const w = rect(ox, oz, a, -L / 2 + q, -L / 2 + q, -off, -off); ok = solidWall(w[0], y + 1.8, w[2]); }
                if (!ok) continue;
              }
              commit(spec, ox, oz, a, F, [lane]); p += L + (r() < 0.5 ? 0.05 : 0.3 + r() * 0.9); done = true;
            }
            if (!done) p += 0.45;
          }
        }
        // free-standing groups where the room is large enough to walk all the way round them
        const tries = Math.round(((room.x1 - room.x0) * (room.z1 - room.z0)) / 9);
        for (let i = 0; i < tries; i++) {
          const spec = pick(r, theme.island)(r); if (!canAfford(spec)) continue;
          const a = r() < 0.5 ? 0 : Math.PI / 2, w = a ? spec.D : spec.L, d = a ? spec.L : spec.D;
          const cx = room.x0 + LANE + w / 2 + r() * Math.max(0, room.x1 - room.x0 - 2 * LANE - w), cz = room.z0 + LANE + d / 2 + r() * Math.max(0, room.z1 - room.z0 - 2 * LANE - d);
          const F = [cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2], B = [F[0] - LANE, F[1] + LANE, F[2] - LANE, F[3] + LANE];
          if (B[0] < room.x0 || B[1] > room.x1 || B[2] < room.z0 || B[3] > room.z1) continue;
          if (!fits(F) || hit(furn, B[0], B[1], B[2], B[3])) continue;
          const ox = a ? cx - spec.D / 2 : cx, oz = a ? cz : cz - spec.D / 2; // wall-frame origin = middle of the back edge
          commit(spec, ox, oz, a, F, [B]);
        }
        // small things on the floor, hard against a wall
        for (let i = 0; i < 5; i++) {
          const sd = pick(r, ['n', 's', 'w', 'e']), a = SIDES[sd][0], alongX = sd === 'n' || sd === 's', spec = pick(r, [bins, looseBoxes, plant])(r);
          const c = (alongX ? room.x0 : room.z0) + 0.6 + r() * ((alongX ? room.x1 - room.x0 : room.z1 - room.z0) - 1.2);
          const ox = alongX ? c : (sd === 'w' ? room.x0 : room.x1), oz = alongX ? (sd === 'n' ? room.z0 : room.z1) : c, F = rect(ox, oz, a, -spec.L / 2, spec.L / 2, 0, spec.D);
          if (!fits(F)) continue;
          place(spec, k, k, ox, y, oz, a); furn.push(F);
        }
      }
      // overhead: a duct and a pipe run either side of the stair well, hung from the slab above, plus floor scuffs of paper
      const cy = y + FH - SLAB;
      for (const sz of [-1, 1]) {
        const zc = b.z + sz * 2.5, duct = sz < 0;
        for (let xa = ix0 + 0.05; xa < ix1 - 0.5; xa += 3.9) {
          const len = Math.min(3.9, ix1 - 0.05 - xa), a0 = k.mark(); k.at(xa + len / 2, cy, zc, 0);
          if (duct) { k.box(0, -0.42, 0, len, 0.3, 0.46, C.steel, 5); k.box(len / 2 - 0.03, -0.44, 0, 0.05, 0.34, 0.5, C.dsteel); k.box(0, -0.12, 0, 0.04, 0.12, 0.5, C.dsteel); if (r() < 0.4) k.box((r() - 0.5) * len * 0.6, -0.45, 0, 0.5, 0.03, 0.3, C.dsteel); }
          else { k.cyl(0, -0.3, -0.1, 0.09, len, pick(r, [C.rust, C.steel, C.red]), 0, 1); k.cyl(0, -0.24, 0.08, 0.05, len, C.dsteel, 0, 1); k.box(0, -0.2, 0, 0.04, 0.2, 0.3, C.dsteel); }
          items.push({ x: xa + len / 2, z: zc, sy: cy, ranges: k.since(a0), c: [] });
        }
      }
    }
    const m = k.build(mat); if (!m) return;
    root.add(m); stats.instances += k.n; stats.meshes++;
    groups.push({ x: b.x, z: b.z, mesh: m, far: false });
  }
  world.buildings.forEach((b, i) => furnish(b, i, false));
  (world.outbuildings || []).forEach((b, i) => furnish(b, 100 + i, true));

  // ---- outside ----------------------------------------------------------------------------
  const kitAt = (x, z) => secKits[secOf(x, z)];
  const er = rng(seed + 4242);
  const allB = world.buildings.concat(world.outbuildings || []);
  const soft = []; // footprints of outdoor pieces that have no collider
  const keepPts = [];
  for (const p of world.pads) keepPts.push([p.x, p.z, 4.5]);
  for (const zl of world.ziplines) { if (zl.b.y < 12) keepPts.push([zl.b.x, zl.b.z, 4]); if (zl.a.y < 12) keepPts.push([zl.a.x, zl.a.z, 4]); }
  for (const [x, z] of world.exitPoints) keepPts.push([x, z, 7]);
  for (const [x, z] of world.spawnPoints) keepPts.push([x, z, 6]);
  for (const [x, z] of [[-9, 26], [44, 9], [-54, 5], [10, -44], [-10, -40], [52, -46], [-56, -36], [3, 4.5], [-4.5, -3], [30, 40], [-40, 12], [20, -4]]) keepPts.push([x, z, 2.2]); // loot crates on open ground (raid.js)
  for (const b of world.buildings) for (const sx of [-1, 1]) keepPts.push([b.x + sx * (b.w / 2 + 3), b.z + b.d / 2 + 2.5, 2.2]); // sentry gun positions
  const onRoad = (F, m) => world.roads.some(([a, b, c, d]) => F[0] - m < b && F[1] + m > a && F[2] - m < d && F[3] + m > c);
  const nearPt = (F) => keepPts.some(([px, pz, pr]) => px > F[0] - pr && px < F[1] + pr && pz > F[2] - pr && pz < F[3] + pr);
  const _near = [];
  const blocked = (F, m, yLo = 0.05, yHi = 3) => { for (const c of world.near(F[0] - m, F[1] + m, F[2] - m, F[3] + m, _near)) if (c.tag !== 'ground' && F[0] - m < c.max.x && F[1] + m > c.min.x && F[2] - m < c.max.z && F[3] + m > c.min.z && c.max.y > yLo && c.min.y < yHi) return true; return false; };
  const apron = (F, m) => allB.some((b) => F[0] < b.x + b.w / 2 + m && F[1] > b.x - b.w / 2 - m && F[2] < b.z + b.d / 2 + m && F[3] > b.z - b.d / 2 - m);
  const inSite = (F) => F[0] > -H + 1.2 && F[1] < H - 1.2 && F[2] > -H + 1.2 && F[3] < H - 1.2;
  // open ground: clear of everything solid by a walking lane, off the roads, away from doors, pads, exits and loot
  const freeGround = (F, m = LANE, roadM = 0.7) => inSite(F) && !onRoad(F, roadM) && !nearPt(F) && !apron(F, 2.9) && !blocked(F, m) && !hit(soft, F[0] - 0.4, F[1] + 0.4, F[2] - 0.4, F[3] + 0.4) && !(Math.abs((F[0] + F[1]) / 2) < 12 && Math.abs((F[2] + F[3]) / 2) < 12);
  const canOut = (spec) => stats.collidersOut + nCols(spec) <= MAX_OUT;
  function put(spec, ox, oz, a, y = 0, sy = y) {
    const n0 = stats.colliders, it = place(spec, kitAt(ox, oz), castKit, ox, y, oz, a, sy);
    stats.collidersOut += stats.colliders - n0; it.out = true;
    if (!it.c.length) soft.push(rect(ox, oz, a, -spec.L / 2, spec.L / 2, 0, spec.D));
    return it;
  }
  // centred placement: (cx, cz) is the middle of the footprint
  function tryCentred(specFn, cx, cz, a, opts = {}) {
    const spec = typeof specFn === 'function' ? specFn(er) : specFn; if (!canOut(spec)) return null;
    const cs = Math.round(Math.cos(a)), sn = Math.round(Math.sin(a)), ox = cx - (spec.D / 2) * sn, oz = cz - (spec.D / 2) * cs;
    const F = rect(ox, oz, a, -spec.L / 2, spec.L / 2, 0, spec.D);
    if (!freeGround(F, opts.m ?? LANE, opts.roadM ?? 0.7)) return null;
    return put(spec, ox, oz, a);
  }
  const quarter = () => Math.floor(er() * 4) * Math.PI / 2;

  // street lamps and vehicles along the roads
  function lampPost(x, z, dx, dz, flicker) {
    const k = kitAt(x, z), a0 = k.mark(); k.at(x, 0, z, Math.atan2(-dz, dx)); // local +x points at the road
    k.box(0, 0, 0, 0.5, 0.5, 0.5, C.conc); k.cyl(0, 0.5, 0, 0.12, 4.7, C.dsteel); k.box(0.7, 5.1, 0, 1.5, 0.08, 0.1, C.dsteel); k.box(1.3, 5.0, 0, 0.6, 0.1, 0.24, C.dsteel);
    k.box(1.3, 4.97, 0, 0.5, 0.03, 0.18, G.warm, flicker ? 3 : 1);
    items.push({ x, z, sy: 0, ranges: k.since(a0), c: [] }); soft.push([x - 0.3, x + 0.3, z - 0.3, z + 0.3]);
    lamps.push({ pos: new THREE.Vector3(x + dx * 1.3, 4.6, z + dz * 1.3), color: 0xffb873, intensity: 60, parent: null }); stats.lamps++;
  }
  world.roads.forEach(([a, b, c, d], ri) => {
    const alongX = b - a > d - c, len = alongX ? b - a : d - c, half = (alongX ? d - c : b - a) / 2, mx = (a + b) / 2, mz = (c + d) / 2;
    let side = ri % 2 ? 1 : -1;
    for (let t = -len / 2 + 9 + er() * 6; t < len / 2 - 6; t += 22 + er() * 8) { // lamps, alternating sides
      side = -side; const x = alongX ? mx + t : mx + side * (half + 0.9), z = alongX ? mz + side * (half + 0.9) : mz + t, F = [x - 0.3, x + 0.3, z - 0.3, z + 0.3];
      if (!inSite(F) || onRoad(F, 0.2) || nearPt(F) || blocked(F, 0.5) || hit(soft, F[0] - 8, F[1] + 8, F[2] - 8, F[3] + 8)) continue;
      lampPost(x, z, alongX ? 0 : -side, alongX ? -side : 0, er() < 0.1);
    }
    for (let t = -len / 2 + 12 + er() * 16; t < len / 2 - 10; t += 24 + er() * 22) { // parked on the verge
      if (er() < 0.15 || stats.vehicles >= 22) continue;
      const sd = er() < 0.5 ? -1 : 1, fn = pick(er, [truck, truck, van, van, pickup, pickup, forklift]), spec = fn(er), off = half + 0.6 + spec.D / 2;
      const cx = alongX ? mx + t : mx + sd * off, cz = alongX ? mz + sd * off : mz + t, a = (alongX ? 0 : Math.PI / 2) + (er() < 0.5 ? Math.PI : 0);
      if (tryCentred(spec, cx, cz, a, { roadM: 0.3 })) stats.vehicles++;
    }
  });
  // the marked bays inside the south gate
  for (const bx of [-15, -9, -3, 3, 9, 15]) { if (er() < 0.5) continue; if (tryCentred(pick(er, [van, pickup, truck]), bx, 43.6 + er(), er() < 0.5 ? Math.PI / 2 : -Math.PI / 2, { m: 1.0 })) stats.vehicles++; }

  // gates in the inner wall: a sign gantry with beacons, a guard booth, barriers funnelling the road
  const IW = world.coreHalf + 3, PL = (IW * 2) / 18, GATES = [[0, -IW, 1, 'N1'], [38, -IW, 1, 'N2'], [0, IW, 1, 'S1'], [-38, IW, 1, 'S2'], [-IW, 0, 0, 'W1'], [IW, 0, 0, 'E1']];
  GATES.forEach(([gx, gz, alongX, name], gi) => {
    const out = alongX ? Math.sign(gz) : Math.sign(gx), k = kitAt(gx, gz), span = PL * 1.12, a = alongX ? 0 : Math.PI / 2, a0 = k.mark();
    k.at(gx, 0, gz, a); // local x runs along the wall, local z across it
    k.box(0, 4.86, 0, span + 0.9, 0.5, 0.5, C.dsteel); k.box(0, 4.82, 0, span, 0.05, 0.6, C.yellow); k.box(0, 4.2, 0, 3.4, 0.62, 0.12, C.dsteel);
    for (const sx of [-1, 1]) { k.box(sx * (span / 2 - 0.9), 5.36, 0, 0.3, 0.14, 0.3, C.dsteel); k.box(sx * (span / 2 - 0.9), 5.5, 0, 0.24, 0.22, 0.24, G.beacon, 4); k.box(sx * 1.2, 4.14, 0, 0.5, 0.05, 0.22, G.warm, 1); }
    for (const sx of [-1, 1]) for (let j = 0; j < 4; j++) k.box(sx * (span / 2 - 0.02), 0.4 + j * 0.9, 0, 0.94, 0.3, 0.94, j % 2 ? C.black : C.yellow);
    items.push({ x: gx, z: gz, sy: 0, ranges: k.since(a0), c: [] });
    for (const s of [-1, 1]) { // sign faces, both ways
      const c = new THREE.Vector3(gx, 4.51, gz), u = new THREE.Vector3(), n = new THREE.Vector3();
      if (alongX) { u.set(s * 1.6, 0, 0); n.set(0, 0, s * 0.07); } else { u.set(0, 0, -s * 1.6); n.set(s * 0.07, 0, 0); }
      sign(`gate${gi}`, c.add(n), u, new THREE.Vector3(0, 0.27, 0));
    }
    lamps.push({ pos: new THREE.Vector3(gx, 3.9, gz), color: 0xffb873, intensity: 50, parent: null });
    // booth outside the wall, beside the road
    const lat = (gi % 2 ? -1 : 1) * 10.5, bx = alongX ? gx + lat : gx + out * 4.2, bz = alongX ? gz + out * 4.2 : gz + lat;
    tryCentred({ L: 2.4, D: 2.4, H: 2.7, draw(kk, s) {
      s.box(0, 0, 1.2, 2.4, 1.05, 2.4, C.offwhite); s.box(0, 2.3, 1.2, 2.7, 0.16, 2.7, C.dsteel);
      for (const sx of [-1, 1]) for (const z of [0.08, 2.32]) kk.box(sx * 1.14, 1.05, z, 0.12, 1.25, 0.12, C.dsteel);
      kk.box(0, 1.1, 0.03, 2.2, 1.15, 0.02, G.window, 1); kk.box(0, 1.1, 2.37, 2.2, 1.15, 0.02, G.window, 1); kk.box(-1.17, 1.1, 1.2, 0.02, 1.15, 2.2, C.glass, 6); kk.box(1.17, 1.1, 1.2, 0.02, 1.15, 2.2, C.glass, 6);
      kk.box(0, 0.6, -0.02, 1.4, 0.3, 0.02, C.yellow); kk.box(0, 2.46, 1.2, 0.22, 0.2, 0.22, G.beacon, 4);
    } }, bx, bz, a, { m: 1.2, roadM: 0.3 });
    // barriers either side of the road, outside the gate
    for (const sx of [-1, 1]) {
      const spec = barrierRow(er), lx = sx * 4.25, d = 3.5 + spec.L / 2 + er() * 2, cx = alongX ? gx + lx : gx + out * d, cz = alongX ? gz + out * d : gz + lx;
      const aa = alongX ? Math.PI / 2 : 0, cs = Math.round(Math.cos(aa)), sn = Math.round(Math.sin(aa)), ox = cx - (spec.D / 2) * sn, oz = cz - (spec.D / 2) * cs, F = rect(ox, oz, aa, -spec.L / 2, spec.L / 2, 0, spec.D);
      if (canOut(spec) && !blocked(F, 0.3) && !onRoad(F, 0.02) && !nearPt(F)) put(spec, ox, oz, aa);
    }
    // paint: stop bar and chevrons across the threshold, the gate's name on the road
    const gr = (nm, lx, lz, w, d, rot) => (alongX ? ground(nm, gx + lx, gz + out * lz, w, d, rot + (out > 0 ? 0 : Math.PI)) : ground(nm, gx + out * lz, gz + lx, w, d, rot + (out > 0 ? Math.PI / 2 : -Math.PI / 2)));
    gr('zebra', 0, 0.2, 8.4, 0.9, 0); gr('line', 0, 5.2, 6.4, 0.45, 0); gr('stop', 0, 7.6, 4.2, 1.9, 0); gr(`gname${gi}`, 0, 11.5, 3.6, 1.6, 0);
  });

  // outposts: name board, floodlight mast, and yard stock that says what the place is for
  const YARD = { armoury: [sandbags, sandbags, ammo, crates, barrierRow], infirmary: [van, cabins, looseBoxes, planter, generator], signal: [reels, generator, reels, hoarding, gasCage], depot: [stockpile, forklift, crates, palletBlock, drums, skip], watch: [sandbags, barrierRow, tyres, sandbags, cabins] };
  function floodMast(x, z, tx, tz, h = 9) {
    const k = kitAt(x, z), a0 = k.mark(), a = Math.atan2(-(tz - z), tx - x); k.at(x, 0, z, a);
    k.box(0, 0, 0, 0.7, 0.6, 0.7, C.conc); k.cyl(0, 0.6, 0, 0.18, h - 0.6, C.dsteel); k.box(0, h, 0, 0.2, 0.12, 2.4, C.dsteel);
    for (const dz of [-0.9, -0.3, 0.3, 0.9]) { k.box(0.12, h - 0.42, dz, 0.3, 0.4, 0.5, C.dsteel, 0, 0, 0); k.box(0.28, h - 0.4, dz, 0.02, 0.34, 0.44, G.white, 1); }
    items.push({ x, z, sy: 0, ranges: k.since(a0), c: [] }); soft.push([x - 0.4, x + 0.4, z - 0.4, z + 0.4]);
  }
  function signBoard(x, z, a, cell, w = 1.9, h = 0.48) { // a = facing: 0 faces +z, PI/2 faces +x ...
    const k = kitAt(x, z), a0 = k.mark(); k.at(x, 0, z, a);
    for (const sx of [-1, 1]) k.box(sx * (w - 0.1), 0, 0, 0.08, 2.9, 0.08, C.dsteel); k.box(0, 1.9, 0, w * 2 + 0.1, h * 2 + 0.1, 0.06, C.dsteel);
    items.push({ x, z, sy: 0, ranges: k.since(a0), c: [] }); soft.push([x - 0.4, x + 0.4, z - 0.4, z + 0.4]);
    const cs = Math.cos(a), sn = Math.sin(a);
    for (const s of [-1, 1]) sign(cell, new THREE.Vector3(x + sn * 0.04 * s, 1.95, z + cs * 0.04 * s), new THREE.Vector3(cs * w * s, 0, -sn * w * s), new THREE.Vector3(0, h, 0));
  }
  for (const b of world.buildings) {
    if (!b.outpost) continue;
    const dl = Math.hypot(b.x, b.z) || 1, ux = -b.x / dl, uz = -b.z / dl; // toward the middle of the site
    // board out by the nearest stretch of ring road side, mast in a yard corner
    const sxs = Math.abs(ux) > Math.abs(uz) ? [Math.sign(ux), 0] : [0, Math.sign(uz)];
    for (const d of [16, 17.5, 19]) { const x = b.x + sxs[0] * d + sxs[1] * 5, z = b.z + sxs[1] * d + sxs[0] * 5, F = [x - 2, x + 2, z - 2, z + 2]; if (!blocked(F, 0.3) && !onRoad(F, 0.3) && !nearPt(F)) { signBoard(x, z, sxs[0] ? Math.PI / 2 : 0, `op_${b.outpost}`); break; } }
    for (const [cx, cz] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) { const x = b.x + cx * 12.6, z = b.z + cz * 12.6, F = [x - 0.4, x + 0.4, z - 0.4, z + 0.4]; if (!blocked(F, 0.25) && !nearPt(F)) { floodMast(x, z, b.x, b.z); break; } }
    // stock along the inside of the yard wall
    const list = YARD[b.outpost]; let placed = 0;
    for (let i = 0; i < 26 && placed < 6; i++) {
      const sd = Math.floor(er() * 4), t = (er() * 2 - 1) * 10.5, spec = list[(placed + i) % list.length](er); if (!canOut(spec)) continue;
      // back against the yard wall (wall is at +-14, 0.35 thick)
      const wallIn = 14 - 0.2, a = [0, Math.PI, Math.PI / 2, -Math.PI / 2][sd];
      const ox = sd < 2 ? b.x + t : b.x + (sd === 2 ? -wallIn : wallIn), oz = sd < 2 ? b.z + (sd === 0 ? -wallIn : wallIn) : b.z + t;
      const F = rect(ox, oz, a, -spec.L / 2, spec.L / 2, 0.02, spec.D), lane = rect(ox, oz, a, -spec.L / 2 - 0.2, spec.L / 2 + 0.2, spec.D + 0.05, spec.D + LANE);
      if (spec.D > 2.6 || blocked(F, 0.02) || blocked(lane, 0) || nearPt(F) || apron(F, 2.2) || onRoad(F, 0.4) || hit(soft, F[0] - 0.3, F[1] + 0.3, F[2] - 0.3, F[3] + 0.3)) continue;
      if (!blocked(rect(ox, oz, a, -spec.L / 2 + 0.2, spec.L / 2 - 0.2, -0.4, -0.1), 0)) continue; // that stretch of the yard wall is an entrance
      put(spec, ox, oz, a); placed++;
    }
  }

  const roofVents = [];
  // roofs: plant that gives cover up there, clear of the stair opening, the loot crate and anything already standing
  allB.forEach((b) => {
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
    const ry = b.roofY, rk = kitAt(b.x, b.z), lz0 = (b.floors - 1) % 2 === 0 ? b.z - 1.7 : b.z + 0.1;
    const keep = [[b.x - 4.1, b.x + 4.1, lz0 - 1.2, lz0 + 2.8], [b.x - 3.4, b.x + 3.4, z0, z0 + 3.6]];
    for (const p of world.pads) { // where a jump pad throws you onto this roof: leave the whole approach side open
      const tUp = p.vel.y / 24, apex = p.vel.y * tUp / 2, tAir = tUp + Math.sqrt(Math.max(0, 2 * (apex - ry) / 24)), lx = p.x + p.vel.x * tAir, lz = p.z + p.vel.z * tAir;
      if (apex > ry && lx > x0 - 6 && lx < x1 + 6 && lz > z0 - 6 && lz < z1 + 6) keep.push([Math.min(p.x, lx) - 4, Math.max(p.x, lx) + 4, Math.min(p.z, lz) - 4, Math.max(p.z, lz) + 4]);
    }
    const zipNear = (F) => world.ziplines.some((zl) => Math.abs(zl.a.x - (F[0] + F[1]) / 2) < 3.5 && Math.abs(zl.a.z - (F[2] + F[3]) / 2) < 3.5);
    const roofFree = (F, m, edge) => F[0] > x0 + edge && F[1] < x1 - edge && F[2] > z0 + edge && F[3] < z1 - edge && !hit(keep, F[0], F[1], F[2], F[3]) && !blocked(F, m, ry + 1.05, ry + 3) && !zipNear(F);
    let big = 0;
    for (let i = 0; i < 16 && big < (b.w > 15 ? 3 : 2); i++) {
      const spec = (er() < 0.7 ? acUnit : tank)(er), a = quarter(), w = Math.abs(Math.cos(a)) > 0.5 ? spec.L : spec.D, d = Math.abs(Math.cos(a)) > 0.5 ? spec.D : spec.L;
      const cx = x0 + 1.9 + w / 2 + er() * (b.w - 3.8 - w), cz = z0 + 1.9 + d / 2 + er() * (b.d - 3.8 - d), F = [cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2];
      if (!canOut(spec) || !roofFree(F, 1.3, 1.85)) continue;
      const cs = Math.round(Math.cos(a)), sn = Math.round(Math.sin(a)); put(spec, cx - (spec.D / 2) * sn, cz - (spec.D / 2) * cs, a, ry, ry); keep.push([F[0] - 1.3, F[1] + 1.3, F[2] - 1.3, F[3] + 1.3]); big++;
    }
    rk.at(0, ry, 0, 0);
    for (let i = 0; i < 10; i++) {
      const x = x0 + 1 + er() * (b.w - 2), z = z0 + 1 + er() * (b.d - 2), q = er(), F = [x - 0.9, x + 0.9, z - 0.9, z + 0.9], a0 = rk.mark();
      if (!roofFree(F, 0.2, 0.6)) continue;
      if (q < 0.4) { vent(rk, er, x, z); if (er() < 0.35) roofVents.push([x, ry + 0.6, z]); } else if (q < 0.6) skylight(rk, er, x, z); else if (q < 0.8) { if (!roofFree([x - 0.6, x + 3.0, z - 1, z + 1], 0.2, 0.6)) continue; solar(rk, er, x, z, 3); keep.push([x - 0.8, x + 3.2, z - 1.1, z + 1.1]); } else if (b.tower || b.outpost || er() < 0.4) mast(rk, er, x, z, b.outpost === 'signal' ? 9 : 4 + er() * 3); else continue;
      keep.push(F); items.push({ x, z, sy: ry, ranges: rk.since(a0), c: [] });
    }
    for (const sx of [-1, 1]) if (er() < 0.7) { const x = b.x + sx * (b.w / 2 - 0.55); rk.cyl(x, 0.12, b.z + 1, 0.12, b.d - 5, C.steel, 5, 2); for (let z = z0 + 3; z < z1 - 2; z += 2.5) rk.box(x, 0, z + 1, 0.2, 0.12, 0.1, C.dsteel); }
  });

  // the plaza round the strongroom: planters at the corners (cover on the last approach) and two floodlight masts
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const a = er() < 0.5 ? 0 : Math.PI / 2, spec = planter(er), cx = sx * 10.2, cz = sz * 10.2, cs = Math.round(Math.cos(a)), sn = Math.round(Math.sin(a)), ox = cx - (spec.D / 2) * sn, oz = cz - (spec.D / 2) * cs;
    const F = rect(ox, oz, a, -spec.L / 2, spec.L / 2, 0, spec.D);
    if (canOut(spec) && !blocked(F, 1.2) && !nearPt(F)) put(spec, ox, oz, a);
  }
  for (const [x, z] of [[-12.5, 12.5], [12.5, -12.5]]) if (!blocked([x - 0.4, x + 0.4, z - 0.4, z + 0.4], 0.4) && !nearPt([x - 0.4, x + 0.4, z - 0.4, z + 0.4])) floodMast(x, z, 0, 0, 8);

  // clusters of yard clutter: thick near the roads and buildings, thinner out in the open
  const CLUSTER = [[stockpile, 5], [palletBlock, 2], [crates, 2], [drums, 3], [pipes, 2], [reels, 2], [tyres, 2], [skip, 2], [generator, 2], [barrierRow, 3], [cabins, 1], [hoarding, 2], [sandbags, 1], [gasCage, 1], [pallet, 2]];
  const clusterAt = (x, z) => {
    if (stats.collidersOut > MAX_OUT - 30) return false; // keep some for the pieces that stand against the buildings
    const spec = pickW(er, CLUSTER)(er), it = tryCentred(spec, x, z, quarter()); if (!it) return false;
    for (let j = 0; j < 3; j++) if (er() < 0.6) { const an = er() * 6.283, d = 2.6 + er() * 2.2; tryCentred(pick(er, [looseBoxes, bins, pallet, drums, crates, tyres]), x + Math.cos(an) * d, z + Math.sin(an) * d, quarter()); }
    return true;
  };
  world.roads.forEach(([a, b, c, d]) => { // along the roads
    const alongX = b - a > d - c, len = alongX ? b - a : d - c, half = (alongX ? d - c : b - a) / 2, mx = (a + b) / 2, mz = (c + d) / 2;
    for (let t = -len / 2 + 6 + er() * 10; t < len / 2 - 6; t += 13 + er() * 14) { const sd = er() < 0.5 ? -1 : 1, off = half + 4 + er() * 7; clusterAt(alongX ? mx + t : mx + sd * off, alongX ? mz + sd * off : mz + t); }
  });
  for (const b of allB) for (let i = 0; i < 4; i++) { const an = er() * 6.283, d = Math.max(b.w, b.d) / 2 + 6 + er() * 8; clusterAt(b.x + Math.cos(an) * d, b.z + Math.sin(an) * d); }
  for (let i = 0; i < 70; i++) clusterAt((er() * 2 - 1) * (H - 8), (er() * 2 - 1) * (H - 8));
  // every building: things stood against the outside walls, between the doors
  const HUG = [[condenser, 3], [drums, 2], [pallet, 2], [looseBoxes, 2], [crates, 1], [gasCage, 1], [bins, 2], [tyres, 1]];
  const hugWalls = () => allB.forEach((b) => {
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
    const n = Math.max(1, Math.round(b.w / 4)), mw = b.w / n, dc = x0 + mw * (Math.floor(n / 2) + 0.5);
    const len = b.d - T * 2, n2 = Math.max(1, Math.round(len / 4)), mw2 = len / n2, dc2 = z0 + T + mw2 * (Math.floor(n2 / 2) + 0.5);
    for (const sd of ['n', 's', 'w', 'e']) {
      const alongX = sd === 'n' || sd === 's', a = { n: Math.PI, s: 0, w: -Math.PI / 2, e: Math.PI / 2 }[sd]; // facing away from the building
      const lo = alongX ? x0 : z0, hi = alongX ? x1 : z1, door = alongX ? dc : dc2, dh = (alongX ? mw : mw2) / 2 + 0.7;
      let p = lo + 0.3 + er() * 2;
      while (p < hi - 0.8) {
        const spec = pickW(er, HUG)(er), c = p + spec.L / 2;
        if (er() < 0.5 || p + spec.L > hi - 0.2 || (c + spec.L / 2 > door - dh && c - spec.L / 2 < door + dh) || !canOut(spec)) { p += 1.2 + er() * 2; continue; }
        const ox = alongX ? c : (sd === 'w' ? x0 - 0.03 : x1 + 0.03), oz = alongX ? (sd === 'n' ? z0 - 0.03 : z1 + 0.03) : c;
        const F = rect(ox, oz, a, -spec.L / 2, spec.L / 2, 0.02, spec.D), lane = rect(ox, oz, a, -spec.L / 2, spec.L / 2, spec.D + 0.05, spec.D + LANE);
        if (blocked(F, 0.03) || blocked(lane, 0) || nearPt(F) || onRoad(F, 0.3) || hit(soft, F[0], F[1], F[2], F[3])) { p += 1.5; continue; }
        if (spec.H > 1.05 && !solidWall(ox - Math.round(Math.sin(a)) * 0.2, 1.8, oz - Math.round(Math.cos(a)) * 0.2)) { p += 1.0; continue; } // keep windows clear
        put(spec, ox, oz, a); p += spec.L + 0.4 + er() * 3;
      }
    }
  });
  hugWalls();
  // towers get a floodlight mast and a name board of their own
  for (const b of world.buildings) if (b.tower) { const sx = b.x > 0 ? -1 : 1, sz = b.z > 0 ? -1 : 1, x = b.x + sx * (b.w / 2 + 4), z = b.z + sz * (b.d / 2 + 4), F = [x - 0.4, x + 0.4, z - 0.4, z + 0.4]; if (!blocked(F, 0.4) && !onRoad(F, 0.3) && !nearPt(F)) floodMast(x, z, b.x, b.z, 10); }

  // ---- paint and stains on the ground ------------------------------------------------------
  const steamAt = [];
  // under the paint: a poured apron round every building, a slab across every outpost yard and gateway, gravel
  // shoulders along the roads, patches of bare dirt out in the ring -- so the ground is not one sheet of asphalt
  for (const b of allB) { if (b.outpost) ground('pad', b.x, b.z, 28.4, 28.4, 0, true); ground('pad', b.x, b.z, b.w + 5 + er() * 2, b.d + 5 + er() * 2, 0, true); }
  for (const [gx, gz, alongX] of GATES) ground('pad', gx, gz, alongX ? 17 : 12, alongX ? 12 : 17, 0, true);
  world.roads.forEach(([a, b, c, d]) => {
    const alongX = b - a > d - c, len = alongX ? b - a : d - c, wd = alongX ? d - c : b - a, mx = (a + b) / 2, mz = (c + d) / 2;
    for (const sd of [-1, 1]) for (let t = -len / 2 + 5; t < len / 2 - 4; t += 9) { const x = alongX ? mx + t : mx + sd * (wd / 2 + 1.2), z = alongX ? mz + sd * (wd / 2 + 1.2) : mz + t; if (Math.max(Math.abs(x), Math.abs(z)) > H - 2 || onRoad([x - 1, x + 1, z - 1, z + 1], 0)) continue; ground('verge', x, z, 4.5 + er() * 2, 12, (alongX ? Math.PI / 2 : 0) + (er() - 0.5) * 0.2, true); }
  });
  for (let i = 0; i < 120; i++) { const x = (er() * 2 - 1) * (H - 9), z = (er() * 2 - 1) * (H - 9), sz = 7 + er() * 14; if (onRoad([x - sz / 3, x + sz / 3, z - sz / 3, z + sz / 3], 0)) continue; ground(er() < 0.7 ? 'dirt' : 'verge', x, z, sz, sz * (0.6 + er() * 0.6), er() * 6, true); }
  // weeds and grit where nobody sweeps: along the foot of the perimeter wall and the inner wall (never solid)
  {
    const tuft = (x, z) => { const k = kitAt(x, z); k.at(x, 0, z, er() * 6); const n = 2 + Math.floor(er() * 4); for (let i = 0; i < n; i++) { const g = er(); k.box((er() - 0.5) * 0.7, 0, (er() - 0.5) * 0.5, 0.1 + er() * 0.25, 0.12 + er() * er() * 0.6, 0.1 + er() * 0.25, g < 0.5 ? C.plant : g < 0.8 ? C.olive : C.sand, 0, er() * 3, (er() - 0.5) * 0.5); } if (er() < 0.3) k.box(0.3, 0, 0.2, 0.3, 0.07, 0.22, pick(er, [C.conc, C.concD, C.card]), 0, er() * 3); };
    for (const s of [-1, 1]) for (let t = -H + 2; t < H - 2; t += 2.2 + er() * 4) { tuft(t, s * (H - 0.55 - er() * 0.5)); tuft(s * (H - 0.55 - er() * 0.5), t + er()); }
    for (const c of world.compoundWalls || []) { if (er() < 0.45) continue; const alongX = c.max.x - c.min.x > c.max.z - c.min.z, sd = er() < 0.5 ? -1 : 1, t = er(); if (alongX) tuft(c.min.x + t * (c.max.x - c.min.x), (sd < 0 ? c.min.z : c.max.z) + sd * 0.3); else tuft((sd < 0 ? c.min.x : c.max.x) + sd * 0.3, c.min.z + t * (c.max.z - c.min.z)); }
  }
  world.roads.forEach(([a, b, c, d], ri) => {
    const alongX = b - a > d - c, len = alongX ? b - a : d - c, wd = alongX ? d - c : b - a, mx = (a + b) / 2, mz = (c + d) / 2;
    if (ri >= 4) for (let t = -len / 2 + 5; t < len / 2 - 5; t += 9) { // centre dashes on the ring road and the spurs (the four main roads have theirs)
      const x = alongX ? mx + t : mx, z = alongX ? mz : mz + t; if (world.roads.some((q, qi) => qi !== ri && x > q[0] - 1 && x < q[1] + 1 && z > q[2] - 1 && z < q[3] + 1)) continue;
      ground('line', x, z, 0.2, 3.2, alongX ? Math.PI / 2 : 0);
    }
    for (const s of [-1, 1]) for (let t = -len / 2 + 2; t < len / 2 - 2; t += 14) { // worn edge lines
      if (er() < 0.35) continue; const seg = 6 + er() * 7, x = alongX ? mx + t + seg / 2 : mx + s * (wd / 2 - 0.25), z = alongX ? mz + s * (wd / 2 - 0.25) : mz + t + seg / 2;
      ground('yline', x, z, 0.14, seg, alongX ? Math.PI / 2 : 0);
    }
    for (let t = -len / 2 + 10; t < len / 2 - 10; t += 16 + er() * 30) { const q = er(), x = alongX ? mx + t : mx + (er() - 0.5) * wd * 0.5, z = alongX ? mz + (er() - 0.5) * wd * 0.5 : mz + t; if (q < 0.4) ground('skid', x, z, 2.4, 8 + er() * 6, (alongX ? Math.PI / 2 : 0) + (er() - 0.5) * 0.3); else if (q < 0.7) ground('patch', x, z, 2.6, 4.2, alongX ? Math.PI / 2 : 0); else { ground('manhole', x, z, 0.95, 0.95, er() * 6); steamAt.push([x, 0.05, z]); } }
  });
  for (let i = 0; i < 90; i++) { const x = (er() * 2 - 1) * (H - 6), z = (er() * 2 - 1) * (H - 6); if (Math.max(Math.abs(x), Math.abs(z)) < 62) continue; ground(er() < 0.75 ? 'stain' : 'crack', x, z, 3 + er() * 6, 3 + er() * 6, er() * 6); }
  for (const it of items) if (it.out && it.c.length && it.sy === 0 && er() < 0.3) ground('stain', it.x + (er() - 0.5), it.z + (er() - 0.5), 3 + er() * 2.5, 3 + er() * 2.5, er() * 6); // oil and rust under parked things
  for (const b of world.buildings) if (b.outpost === 'depot' || (b.tower && b.w > 25)) { const sz = b.z > 0 ? -1 : 1; for (let i = -1; i <= 1; i++) ground('bay', b.x + i * 7.2, b.z + sz * (b.d / 2 + 5.5), 6.4, 3, sz > 0 ? 0 : Math.PI); }

  // ---- build ---------------------------------------------------------------------------------
  const outMeshes = [];
  for (const k of secKits.concat(secCyl)) { const m = k.build(mat); if (m) { root.add(m); outMeshes.push(m); stats.instances += k.n; stats.meshes++; } }
  { const m = castKit.build(mat, { cast: true }); if (m) { root.add(m); stats.instances += castKit.n; stats.meshes++; } }

  // ---- lit windows on distant buildings ----------------------------------------------------------
  // Up close you see into the rooms. From far away the interiors are not drawn at all (world.updateLOD), so a
  // share of the window openings of a far building show a lit pane instead. One InstancedMesh for the whole site;
  // a building's panes are switched by writing its block of instance matrices.
  const winKit = new Kit(), winGroups = [], panes = [];
  {
    const wr = rng(seed + 99), sills = world.colliders.filter((c) => c.tag === 'sill');
    for (const b of allB) {
      const a0 = winKit.n, ratio = wr() < 0.2 ? 0.1 : 0.25 + wr() * 0.45, cool = wr() < 0.3;
      for (const c of sills) {
        const mx = (c.min.x + c.max.x) / 2, mz = (c.min.z + c.max.z) / 2;
        if (Math.abs(mx - b.x) > b.w / 2 + 0.05 || Math.abs(mz - b.z) > b.d / 2 + 0.05 || c.min.y > b.roofY) continue;
        if (wr() > ratio) continue;
        const alongX = c.max.x - c.min.x > c.max.z - c.min.z, len = (alongX ? c.max.x - c.min.x : c.max.z - c.min.z) - 0.14, col = (wr() < 0.15 ? !cool : cool) ? G.windowC : G.window, k = 0.7 + wr() * 0.7;
        winKit.at(mx, c.max.y, mz, 0); panes.push({ x: mx, y: c.max.y + 0.75, z: mz, i: winKit.n });
        winKit.box(0, 0.04, 0, alongX ? len : 0.05, 1.42, alongX ? 0.05 : len, [col[0] * k, col[1] * k, col[2] * k], wr() < 0.05 ? 3 : 1);
      }
      if (winKit.n > a0) winGroups.push({ x: b.x, z: b.z, a: a0, b: winKit.n, range: 104 + Math.max(b.w, b.d) / 2, on: true });
    }
  }
  const winMesh = winKit.build(mat), winOrig = winMesh ? winMesh.instanceMatrix.array.slice() : null;
  if (winMesh) { root.add(winMesh); winMesh.frustumCulled = false; stats.instances += winKit.n; stats.meshes++; stats.windows = winKit.n; }
  events.on('pieceDestroyed', ({ collider: c }) => { // a pane goes with its wall
    if (!winMesh || !c || !c.min || (c.tag !== 'sill' && c.tag !== 'lintel' && c.tag !== 'pillar')) return;
    for (const p of panes) if (!p.dead && p.x > c.min.x - 1.2 && p.x < c.max.x + 1.2 && p.z > c.min.z - 1.2 && p.z < c.max.z + 1.2 && p.y > c.min.y - 1.9 && p.y < c.max.y + 1.9) { p.dead = true; winOrig.fill(0, p.i * 16, p.i * 16 + 16); winKit.erase(p.i, p.i + 1); }
  });

  // ---- drifting steam, blowing litter, birds: one instanced mesh of camera-facing quads, animated in the shader ----
  let fxMat = null;
  {
    const fr = rng(seed + 555), A = [], B = [];
    for (const [x, y, z] of steamAt.slice(0, 9).concat(roofVents.slice(0, 9))) for (let i = 0; i < 5; i++) { A.push(x, y, z, fr()); B.push(0, 0.8 + fr() * 0.5, 0.16 + fr() * 0.08, 3 + fr() * 2.5); }
    for (let i = 0; i < 44; i++) { const rd = world.roads[Math.floor(fr() * world.roads.length)]; A.push(rd[0] + fr() * (rd[1] - rd[0]) + (fr() - 0.5) * 20, 0, rd[2] + fr() * (rd[3] - rd[2]) + (fr() - 0.5) * 20, fr()); B.push(1, 0.14 + fr() * 0.14, 0.03 + fr() * 0.04, 20 + fr() * 24); }
    const tall = world.buildings.filter((b) => b.tower).slice(0, 3);
    for (const b of tall) for (let i = 0; i < 6; i++) { A.push(b.x * 0.6, b.roofY + 22 + fr() * 14, b.z * 0.6, fr() * 0.25 + i * 0.02); B.push(2, 1.1 + fr() * 0.5, 0.16 + fr() * 0.03, 30 + fr() * 14); }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('iA', new THREE.InstancedBufferAttribute(new Float32Array(A), 4)); g.setAttribute('iB', new THREE.InstancedBufferAttribute(new Float32Array(B), 4));
    g.instanceCount = A.length / 4;
    fxMat = new THREE.ShaderMaterial({
      uniforms: { uTime: U.time, uColor: { value: scene.fog ? scene.fog.color.clone().multiplyScalar(1.15) : new THREE.Color(0.8, 0.75, 0.7) } },
      transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
        uniform float uTime; attribute vec4 iA; attribute vec4 iB; varying vec2 vUv; varying float vAlpha; varying float vType;
        void main() {
          vec3 p = iA.xyz; float seed = iA.w, type = iB.x, size = iB.y, alpha = 1.0, far = 150.0; vec2 q = position.xy;
          if ( type < 0.5 ) {            // steam: rises, spreads, thins
            float life = fract( uTime * iB.z + seed );
            p.y += life * iB.w; p.xz += vec2( sin( seed * 40.0 + life * 3.0 ), cos( seed * 23.0 + life * 2.0 ) ) * 0.4 * life + vec2( 0.9, 0.5 ) * life * life * 1.6;
            size *= 0.5 + life * 2.2; alpha = smoothstep( 0.0, 0.15, life ) * ( 1.0 - life ) * 0.42; far = 130.0;
          } else if ( type < 1.5 ) {     // litter: skips along the ground with the wind
            float life = fract( uTime * iB.z + seed ), c = cos( life * 31.0 + seed * 9.0 ), s = sin( life * 31.0 + seed * 9.0 );
            p.xz += vec2( 0.85, 0.52 ) * ( life - 0.5 ) * iB.w; p.y += 0.07 + abs( sin( life * 26.0 + seed * 10.0 ) ) * 0.45 * sin( life * 3.1416 );
            q = vec2( q.x * c - q.y * s, ( q.x * s + q.y * c ) * ( 0.35 + 0.65 * abs( cos( life * 47.0 ) ) ) );
            alpha = smoothstep( 0.0, 0.04, life ) * smoothstep( 1.0, 0.96, life ); far = 70.0;
          } else {                       // birds: wheel slowly above the towers
            float ang = uTime * iB.z + seed * 6.2832;
            p.xz += vec2( cos( ang ), sin( ang ) ) * iB.w; p.y += sin( uTime * 0.6 + seed * 50.0 ) * 3.0;
            q.x *= 0.35 + 0.65 * abs( sin( uTime * 8.0 + seed * 60.0 ) ); far = 600.0;
          }
          vec4 mv = viewMatrix * vec4( p, 1.0 );
          alpha *= ( 1.0 - smoothstep( far * 0.7, far, - mv.z ) ) * smoothstep( 0.4, 1.6, - mv.z );
          mv.xy += q * size * step( 0.003, alpha );
          vUv = position.xy + 0.5; vAlpha = alpha; vType = type;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; varying vec2 vUv; varying float vAlpha; varying float vType;
        void main() {
          vec3 col = uColor; float a = vAlpha;
          if ( vType < 0.5 ) { float d = length( vUv - 0.5 ) * 2.0; a *= smoothstep( 1.0, 0.1, d ); }
          else if ( vType < 1.5 ) { col = uColor * 0.85; a *= 0.9; }
          else { col = vec3( 0.03 ); a *= step( abs( vUv.y - 0.35 - abs( vUv.x - 0.5 ) * 0.7 ), 0.09 ); }
          if ( a < 0.004 ) discard;
          gl_FragColor = vec4( col, a );
        }`,
    });
    const m = new THREE.Mesh(g, fxMat); m.frustumCulled = false; m.renderOrder = 3; m.name = 'dressing-air'; root.add(m); stats.meshes++; stats.air = g.instanceCount;
  }

  // ---- when the floor under a piece goes, the piece goes with it ---------------------------------
  events.on('pieceDestroyed', ({ collider: c }) => {
    if (!c || c.tag !== 'slab' || !c.min) return;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.x < c.min.x || it.x > c.max.x || it.z < c.min.z || it.z > c.max.z || (Math.abs(it.sy - c.max.y) > 0.06 && Math.abs(it.sy - c.min.y) > 0.06)) continue;
      for (const [k, a, b] of it.ranges) k.erase(a, b);
      for (const col of it.c) world.removeCollider(col);
      items[i] = items[items.length - 1]; items.pop();
    }
  });

  let alarmTier = 1, lastCull = new THREE.Vector3(1e9, 0, 0), frame = 0;
  events.on('heatTier', (e) => { alarmTier = (e && e.tier) || 1; });
  events.on('raidStart', () => { alarmTier = 1; });
  events.on('raidEnd', () => { alarmTier = 1; });
  function cull(cp) {
    for (const g of groups) { const far = Math.hypot(g.x - cp.x, g.z - cp.z) > INTERIOR_RANGE; if (far !== g.far) { g.far = far; g.mesh.visible = !far; } }
    let dirty = false;
    for (const g of winGroups) {
      const on = Math.hypot(g.x - cp.x, g.z - cp.z) > g.range; if (on === g.on) continue;
      g.on = on; dirty = true; const arr = winMesh.instanceMatrix.array;
      if (on) arr.set(winOrig.subarray(g.a * 16, g.b * 16), g.a * 16); else arr.fill(0, g.a * 16, g.b * 16);
    }
    if (dirty) winMesh.instanceMatrix.needsUpdate = true;
  }
  return {
    stats, root, uniforms: U, groups, items,
    update(dt) {
      U.time.value += dt;
      const heat = (ctx.raid && ctx.raid.heat) || 0;
      const target = Math.max(THREE.MathUtils.clamp((heat - 0.38) / 0.36, 0, 1), alarmTier >= 4 ? 1 : alarmTier === 3 ? 0.55 : 0);
      U.alarm.value += (target - U.alarm.value) * Math.min(1, dt * 1.5);
      const cp = camera.position;
      if (frame++ % 20 === 0 || Math.abs(cp.x - lastCull.x) + Math.abs(cp.z - lastCull.z) > 6) { lastCull.copy(cp); cull(cp); }
    },
  };
}
