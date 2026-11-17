import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Toolkit for the first-person weapon models: procedural surface textures, PBR material library,
// geometry helpers (bevelled side profiles, lathed barrels, rail teeth), a Kit that merges static parts
// into one mesh per material, and the articulated gloved hand.
//
// Gun space: +x right, +y up, forward is -z. Helpers take (x, y, f) with f = metres FORWARD.

// ---- procedural textures -------------------------------------------------------------------------------
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const canvas = (s) => { const c = document.createElement('canvas'); c.width = c.height = s; return c; };
function tex(c, srgb = false) {
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t;
}
// height field (Float32Array, wraps) -> tangent-space normal map
function normalFromHeight(h, S, strength) {
  const c = canvas(S), g = c.getContext('2d'), img = g.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const l = h[y * S + ((x + S - 1) % S)], r = h[y * S + ((x + 1) % S)], u = h[((y + S - 1) % S) * S + x], dn = h[((y + 1) % S) * S + x];
    let nx = (l - r) * strength, ny = (u - dn) * strength, nz = 1; const k = 1 / Math.hypot(nx, ny, nz);
    const i = (y * S + x) * 4; d[i] = (nx * k * 0.5 + 0.5) * 255; d[i + 1] = (ny * k * 0.5 + 0.5) * 255; d[i + 2] = (nz * k * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); return tex(c);
}
function blur(h, S, n = 1) { for (let k = 0; k < n; k++) { const o = h.slice(); for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) h[y * S + x] = (o[y * S + x] * 2 + o[y * S + (x + 1) % S] + o[y * S + (x + S - 1) % S] + o[((y + 1) % S) * S + x] + o[((y + S - 1) % S) * S + x]) / 6; } return h; }

let TEX = null;
function textures() {
  if (TEX) return TEX;
  const S = 256, r = rng(11);
  // fine grain (moulded polymer, parkerised steel)
  const grain = new Float32Array(S * S); for (let i = 0; i < grain.length; i++) grain[i] = r();
  const grainN = normalFromHeight(blur(grain.slice(), S, 1), S, 2.2);
  // cast / bead blasted metal: softer, larger
  const castN = normalFromHeight(blur(grain.slice(), S, 2), S, 3);
  // grip stipple
  const st = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const u = (x % 16) / 16 - 0.5, v = ((y + (Math.floor(x / 16) % 2) * 8) % 16) / 16 - 0.5; st[y * S + x] = Math.max(0, 1 - Math.hypot(u, v) * 3.2); }
  const stippleN = normalFromHeight(st, S, 6);
  // fabric weave
  const wv = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const a = Math.sin((x + y) * Math.PI / 4), b = Math.sin((x - y) * Math.PI / 4); wv[y * S + x] = Math.max(a, b) * 0.5 + r() * 0.25; }
  const weaveN = normalFromHeight(wv, S, 3.5);
  // wear: roughness (g) varies, sparse polished scratches + matching albedo (lighter scuffs, darker oil stains)
  const rc = canvas(S), rg = rc.getContext('2d'), ac = canvas(S), ag = ac.getContext('2d');
  rg.fillStyle = '#d8d8d8'; rg.fillRect(0, 0, S, S); ag.fillStyle = '#e4e4e4'; ag.fillRect(0, 0, S, S);
  for (let i = 0; i < 90; i++) { const x = r() * S, y = r() * S, rad = 8 + r() * 40, v = 150 + r() * 105 | 0; const gr = rg.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, `rgba(${v},${v},${v},.5)`); gr.addColorStop(1, `rgba(${v},${v},${v},0)`); rg.fillStyle = gr; rg.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    const w = 150 + r() * 100 | 0; const g2 = ag.createRadialGradient(x, y, 0, x, y, rad); g2.addColorStop(0, `rgba(${w},${w},${w},.35)`); g2.addColorStop(1, `rgba(${w},${w},${w},0)`); ag.fillStyle = g2; ag.fillRect(x - rad, y - rad, rad * 2, rad * 2); }
  for (let i = 0; i < 160; i++) { const x = r() * S, y = r() * S, a = r() * Math.PI, l = 4 + r() * 26;
    rg.strokeStyle = `rgba(90,90,90,${0.25 + r() * 0.5})`; rg.lineWidth = 0.6 + r(); rg.beginPath(); rg.moveTo(x, y); rg.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); rg.stroke();
    ag.strokeStyle = `rgba(255,255,255,${0.2 + r() * 0.5})`; ag.lineWidth = 0.5 + r() * 0.8; ag.beginPath(); ag.moveTo(x, y); ag.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ag.stroke(); }
  const wearR = tex(rc), wearA = tex(ac, true);
  // walnut
  const wc = canvas(S), wg = wc.getContext('2d'); wg.fillStyle = '#b08a68'; wg.fillRect(0, 0, S, S);
  for (let i = 0; i < 260; i++) { const y = r() * S, v = r(); wg.strokeStyle = v < 0.5 ? `rgba(60,30,12,${0.1 + r() * 0.3})` : `rgba(230,180,130,${0.05 + r() * 0.2})`; wg.lineWidth = 0.5 + r() * 2.5; wg.beginPath(); wg.moveTo(0, y);
    const amp = r() * 5, ph = r() * 6; for (let x = 0; x <= S; x += 8) wg.lineTo(x, y + Math.sin(x * 0.03 + ph) * amp); wg.stroke(); }
  const woodA = tex(wc, true);
  grainN.repeat.set(5, 5); castN.repeat.set(7, 7);
  TEX = { grainN, castN, stippleN, weaveN, wearR, wearA, woodA };
  return TEX;
}

// ---- materials --------------------------------------------------------------------------------------------
let MATS = null;
export function materials() {
  if (MATS) return MATS;
  const T = textures();
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const ns = (v) => new THREE.Vector2(v, v);
  MATS = {
    // black anodised aluminium (receivers, rails, scope bodies)
    anod: std({ color: 0x4b4e55, metalness: 0.5, roughness: 0.46, envMapIntensity: 1.25, roughnessMap: T.wearR, map: T.wearA, normalMap: T.castN, normalScale: ns(0.1) }),
    // parkerised / phosphated steel (barrels, muzzle devices)
    steel: std({ color: 0x53565c, metalness: 0.65, roughness: 0.5, envMapIntensity: 1.2, roughnessMap: T.wearR, map: T.wearA, normalMap: T.grainN, normalScale: ns(0.1) }),
    // polished working surfaces (bolts, wear)
    bare: std({ color: 0x8d9094, metalness: 1, roughness: 0.46, roughnessMap: T.wearR }),
    poly: std({ color: 0x34363b, metalness: 0, roughness: 0.78, normalMap: T.grainN, normalScale: ns(0.35) }),
    polyTan: std({ color: 0x8a7150, metalness: 0, roughness: 0.74, normalMap: T.grainN, normalScale: ns(0.4) }),
    polyOD: std({ color: 0x4d5239, metalness: 0, roughness: 0.74, normalMap: T.grainN, normalScale: ns(0.4) }),
    cerakote: std({ color: 0x666b52, metalness: 0.3, roughness: 0.62, roughnessMap: T.wearR, map: T.wearA, normalMap: T.castN, normalScale: ns(0.12) }),
    grip: std({ color: 0x323338, metalness: 0, roughness: 0.85, normalMap: T.stippleN, normalScale: ns(0.9) }),
    gripTan: std({ color: 0x86704c, metalness: 0, roughness: 0.82, normalMap: T.stippleN, normalScale: ns(0.9) }),
    rubber: std({ color: 0x1b1c1e, metalness: 0, roughness: 0.95, normalMap: T.grainN, normalScale: ns(0.5) }),
    wood: new THREE.MeshPhysicalMaterial({ color: 0x8a5a36, metalness: 0, roughness: 0.55, map: T.woodA, normalMap: T.grainN, normalScale: ns(0.08), clearcoat: 0.55, clearcoatRoughness: 0.28 }),
    black: std({ color: 0x030303, metalness: 0.2, roughness: 0.9 }),
    brass: std({ color: 0xc9a253, metalness: 1, roughness: 0.32, roughnessMap: T.wearR }),
    hull: std({ color: 0xa8281c, metalness: 0, roughness: 0.55 }),
    lensCoat: std({ color: 0x1a1030, metalness: 1, roughness: 0.06 }),
    paintWhite: std({ color: 0xd8d6cf, metalness: 0, roughness: 0.6 }),
    paintRed: std({ color: 0xc8261c, metalness: 0, roughness: 0.55 }),
    paintTeal: std({ color: 0x1fb5a3, metalness: 0.1, roughness: 0.5 }),
    paintYellow: std({ color: 0xd8a514, metalness: 0.1, roughness: 0.55, map: T.wearA }),
    tritium: new THREE.MeshStandardMaterial({ color: 0x0a1a08, emissive: 0x7dff5a, emissiveIntensity: 1.1, roughness: 0.4 }),
    // glove + sleeve
    glove: std({ color: 0x3a3b3e, metalness: 0, roughness: 0.9, normalMap: T.weaveN, normalScale: ns(0.8) }),
    leather: std({ color: 0x242527, metalness: 0, roughness: 0.62, normalMap: T.grainN, normalScale: ns(0.6) }),
    tpr: std({ color: 0x4a4b4e, metalness: 0, roughness: 0.7, normalMap: T.grainN, normalScale: ns(0.3) }),
    sleeve: std({ color: 0x3e413c, metalness: 0, roughness: 0.95, normalMap: T.weaveN, normalScale: ns(1.0) }),
  };
  // texel density per material (UV units per metre) used by the box-projected UVs
  const dens = { anod: 9, steel: 12, bare: 14, poly: 20, polyTan: 20, polyOD: 20, cerakote: 9, grip: 34, gripTan: 34, rubber: 20, wood: 5, brass: 14, glove: 70, leather: 30, tpr: 24, sleeve: 42, paintYellow: 10 };
  // edge wear: how much brighter exposed edges get (see Kit.addM)
  const wear = { anod: 2.6, steel: 1.9, cerakote: 2.2, poly: 0.5, polyTan: 0.35, polyOD: 0.4, grip: 0.3, gripTan: 0.25, wood: 0.3, paintYellow: 0.5, rubber: 0.25, tpr: 0.3 };
  for (const k in MATS) { MATS[k].userData.uv = dens[k] || 10; MATS[k].userData.wear = wear[k] || 0; MATS[k].name = k; MATS[k].vertexColors = true; }
  return MATS;
}

// ---- geometry helpers ----------------------------------------------------------------------------------------
export const rbox = (w, h, d, r = 0.002, s = 2) => { const g = new RoundedBoxGeometry(w, h, d, s, Math.min(r, w / 2.01, h / 2.01, d / 2.01)); g.userData.edges = true; return g; };
// cylinder lying along the barrel axis
export const tube = (r, len, sides = 20, rRear = r) => new THREE.CylinderGeometry(rRear, r, len, sides).rotateX(Math.PI / 2);
// cylinder along x (pins, screws, cross bolts)
export const pin = (r, len, sides = 12) => new THREE.CylinderGeometry(r, r, len, sides).rotateZ(Math.PI / 2);
// revolve [[radius, f], ...] around the barrel axis. Smooth normals; put two points close together for a hard edge.
export function lathe(pts, sides = 24) {
  if (pts[pts.length - 1][1] < pts[0][1]) pts = pts.slice().reverse(); // keep the faces pointing outward
  const g = new THREE.LatheGeometry(pts.map(([r, f]) => new THREE.Vector2(Math.max(r, 1e-5), f)), sides);
  g.rotateX(-Math.PI / 2); return g;
}
// side silhouette [[f, y], ...] extruded across the gun's width with bevelled edges
export function profile(pts, width, bevel = 0.004, holes = [], bevelSegments = 3) {
  const mk = (list, S) => { const s = new S(); list.forEach(([f, y], i) => (i ? s.lineTo(f, y) : s.moveTo(f, y))); s.closePath(); return s; };
  const shape = mk(pts, THREE.Shape);
  for (const h of holes) shape.holes.push(mk(h, THREE.Path));
  const depth = Math.max(1e-4, width - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments, curveSegments: 6 });
  g.translate(0, 0, -depth / 2); g.rotateY(Math.PI / 2);
  g.userData.edges = bevel > 0;
  return g;
}
// cross-section [[x, y], ...] (looking from behind) extruded forward from f0 to f1
export function section(pts, f0, f1, holes = []) {
  const mk = (list, S) => { const s = new S(); list.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y))); s.closePath(); return s; };
  const shape = mk(pts, THREE.Shape);
  for (const h of holes) shape.holes.push(typeof h === 'number' ? new THREE.Path().absarc(0, 0, h, 0, Math.PI * 2, true) : mk(h, THREE.Path));
  const g = new THREE.ExtrudeGeometry(shape, { depth: f1 - f0, bevelEnabled: false, curveSegments: 16 });
  g.translate(0, 0, -f1); return g;
}
export const ngon = (r, n, rot = Math.PI / n) => Array.from({ length: n }, (_, i) => [Math.cos(rot + i * 2 * Math.PI / n) * r, Math.sin(rot + i * 2 * Math.PI / n) * r]);
export function roundRect(w, h, r, n = 4) {
  const pts = [];
  for (const [cx, cy, a0] of [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 1], [-w / 2 + r, -h / 2 + r, 2], [w / 2 - r, -h / 2 + r, 3]])
    for (let i = 0; i <= n; i++) { const a = (a0 + i / n) * Math.PI / 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return pts;
}

// smooth 3D value noise 0..1
function vnoise(x, y, z) {
  const h = (i, j, k) => { const t = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453; return t - Math.floor(t); };
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const L = (a, b, t) => a + (b - a) * t;
  return L(L(L(h(xi, yi, zi), h(xi + 1, yi, zi), sx), L(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), sx), sy),
    L(L(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), sx), L(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), sx), sy), sz);
}
// engraved / painted marking on the LEFT side of a gun: returns a small lit, alpha-tested plane
export function marking(lines, width, opts = {}) {
  const c = canvas(512); c.height = 64 * lines.length; const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height); g.fillStyle = opts.color || '#c9ccd0'; g.textBaseline = 'middle';
  lines.forEach((t, i) => { g.font = `${i === 0 ? 600 : 500} ${i === 0 ? 40 : 30}px "Arial Narrow", Arial, sans-serif`; g.fillText(t, 4, 32 + i * 64, 504); });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({ map: t, transparent: true, alphaTest: 0.25, roughness: 0.6, metalness: 0.2, opacity: opts.opacity ?? 0.8, polygonOffset: true, polygonOffsetFactor: -2 });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width, width * c.height / c.width), mat);
  m.rotation.y = -Math.PI / 2; m.name = 'marking';
  return m;
}

const _m = new THREE.Matrix4(), _e = new THREE.Euler(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();

// Collects parts and builds ONE mesh per material (box-projected UVs so texture density is uniform).
export class Kit {
  constructor() { this.parts = new Map(); }
  addM(geo, mat, matrix) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    // Edge wear, baked per vertex: on bevelled parts the normals that are not axis-aligned ARE the edges and
    // corners. Those get a brighter (worn-through) albedo, broken up by noise so the wear is uneven.
    const n = g.attributes.position.count, col = new Float32Array(n * 3).fill(1), wear = mat.userData.wear || 0;
    if (wear > 0 && geo.userData.edges) {
      const N = g.attributes.normal.array, P = g.attributes.position.array, s = 1 / Math.sqrt(1 + (geo.userData.scale || 0));
      for (let i = 0; i < n; i++) {
        const e = 1 - Math.max(Math.abs(N[i * 3]), Math.abs(N[i * 3 + 1]), Math.abs(N[i * 3 + 2]));
        if (e < 0.03) continue;
        const m = Math.min(1, (e - 0.03) / 0.16) * Math.pow(vnoise(P[i * 3] * 70 + 3.1, P[i * 3 + 1] * 70 + 7.7, P[i * 3 + 2] * 45), 1.6) * 1.9 * s;
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1 + wear * Math.min(1, m);
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (matrix) g.applyMatrix4(matrix);
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat).push(g); return this;
  }
  // position (x, y, f), rotation (rx, ry, rz), optional scale [sx, sy, sz]
  add(geo, mat, x = 0, y = 0, f = 0, rx = 0, ry = 0, rz = 0, sc = null) {
    _m.compose(_p.set(x, y, -f), _q.setFromEuler(_e.set(rx, ry, rz)), sc ? _s.set(sc[0], sc[1], sc[2]) : _s.set(1, 1, 1));
    return this.addM(geo, mat, _m);
  }
  build(parent = new THREE.Group()) {
    for (const [mat, list] of this.parts) {
      let n = 0; for (const g of list) n += g.attributes.position.count;
      const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
      let o = 0;
      for (const g of list) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3); o += g.attributes.position.count; g.dispose(); }
      const d = mat.userData.uv || 10;
      for (let i = 0; i < n; i++) { // box projection
        const ax = Math.abs(nor[i * 3]), ay = Math.abs(nor[i * 3 + 1]), az = Math.abs(nor[i * 3 + 2]);
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        if (ax >= ay && ax >= az) { uv[i * 2] = z * d; uv[i * 2 + 1] = y * d; } else if (ay >= az) { uv[i * 2] = z * d; uv[i * 2 + 1] = x * d; } else { uv[i * 2] = x * d; uv[i * 2 + 1] = y * d; }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const mesh = new THREE.Mesh(geo, mat); mesh.name = mat.name; parent.add(mesh);
    }
    this.parts.clear();
    return parent;
  }
}
export function sub(parent, x = 0, y = 0, f = 0) { const g = new THREE.Group(); g.position.set(x, y, -f); parent.add(g); g.userData.home = g.position.clone(); return g; }
export const offset = (g, dx, dy, df) => g.position.set(g.userData.home.x + dx, g.userData.home.y + dy, g.userData.home.z - df);

// Picatinny-style rail: dovetail base + evenly spaced teeth. Along the barrel from f0 to f1, top surface at y + 0.0062.
const TOOTH = [[-0.0078, 0], [-0.0106, 0.0026], [-0.0106, 0.0046], [-0.0088, 0.0062], [0.0088, 0.0062], [0.0106, 0.0046], [0.0106, 0.0026], [0.0078, 0]];
export function rail(kit, mat, y, f0, f1, x = 0, rz = 0) {
  const n = Math.floor((f1 - f0) / 0.01);
  const tooth = section(TOOTH, 0, 0.0052);
  const base = section([[-0.0078, 0], [-0.0098, 0.002], [-0.0098, 0.0032], [0.0098, 0.0032], [0.0098, 0.002], [0.0078, 0]], f0, f1);
  _q.setFromEuler(_e.set(0, 0, rz));
  kit.addM(base, mat, _m.compose(_p.set(x, y, 0), _q, _s.set(1, 1, 1)));
  for (let i = 0; i < n; i++) kit.addM(tooth, mat, _m.compose(_p.set(x, y, -(f0 + 0.0035 + i * 0.01)), _q, _s.set(1, 1, 1)));
}
// screw / pin head seen from the side (axis along x)
export function screw(kit, M, x, y, f, r = 0.003, side = -1) {
  kit.add(pin(r, 0.002, 10), M.steel, x, y, f);
  kit.add(rbox(0.0006, r * 1.5, r * 0.35, 0.0001, 1), M.black, x + side * 0.0009, y, f, 0.6);
}

// =================================================================================================================
// Gloved hand + forearm.
// Built as a RIGHT hand in its own frame: fingers point -z, the back of the hand faces +x, the thumb side is +y.
// (A left hand is the same thing mirrored.)  opts:
//   right        false for the left hand
//   pos          wrist position in gun space [x, y, f]
//   fwd, palm    directions (gun space [x, y, f]) the fingers point and the palm faces
//   elbow        direction from wrist to elbow (gun space)
//   curls        per finger [index, middle, ring, pinky]: [knuckle, middle joint, tip joint] radians
//   thumb        { dir:[x,y,z] hand space, bend:[x,y,z], angle }
//   trigger      true: the index finger is jointed (returned as .index) so it can squeeze
// =================================================================================================================
const FINGERS = [
  { y: 0.031, z: -0.094, L: [0.044, 0.027, 0.023], r: 0.0105 },
  { y: 0.010, z: -0.098, L: [0.048, 0.031, 0.024], r: 0.011 },
  { y: -0.011, z: -0.094, L: [0.044, 0.029, 0.023], r: 0.0105 },
  { y: -0.031, z: -0.084, L: [0.035, 0.022, 0.021], r: 0.0095 },
];
const Y = new THREE.Vector3(0, 1, 0);
function capsule(kit, mat, a, b, r) {
  const d = b.clone().sub(a), len = d.length();
  _m.compose(a.clone().addScaledVector(d, 0.5), _q.setFromUnitVectors(Y, d.multiplyScalar(1 / len)), _s.set(1, 1, 1));
  kit.addM(new THREE.CapsuleGeometry(r, len, 4, 12), mat, _m);
}

export function buildHand(M, o) {
  const right = o.right !== false;
  const v3 = (a) => new THREE.Vector3(a[0], a[1], -a[2]);
  const F = v3(o.fwd).normalize(), Pn = v3(o.palm); Pn.addScaledVector(F, -Pn.dot(F)).normalize();
  const Zo = F.clone().negate(), Xo = right ? Pn.clone().negate() : Pn.clone(), Yo = new THREE.Vector3().crossVectors(Zo, Xo);
  const outer = new THREE.Group(); outer.name = right ? 'handR' : 'handL';
  outer.matrix.makeBasis(Xo, Yo, Zo); outer.quaternion.setFromRotationMatrix(outer.matrix); outer.position.copy(v3(o.pos));
  outer.userData.home = outer.position.clone();
  const inner = new THREE.Group(); if (!right) inner.scale.x = -1; outer.add(inner);

  const kit = new Kit();
  // palm, heel pads, back-of-hand shell, knuckle guard
  kit.add(rbox(0.031, 0.088, 0.094, 0.0145, 3), M.glove, 0, 0, 0.047);
  kit.addM(new THREE.SphereGeometry(0.021, 14, 10), M.leather, _m.compose(_p.set(-0.011, 0.028, -0.032), _q.identity(), _s.set(0.75, 0.95, 1.45)));
  kit.addM(new THREE.SphereGeometry(0.019, 14, 10), M.leather, _m.compose(_p.set(-0.009, -0.03, -0.036), _q.identity(), _s.set(0.7, 0.8, 1.6)));
  kit.add(rbox(0.007, 0.064, 0.05, 0.003), M.tpr, 0.0145, 0.0, 0.047);
  kit.add(rbox(0.013, 0.078, 0.026, 0.0062, 3), M.tpr, 0.014, 0.001, 0.09);
  for (let i = 0; i < 4; i++) kit.add(rbox(0.004, 0.013, 0.02, 0.002), M.leather, 0.0205, FINGERS[i].y * 0.98, 0.09);
  // wrist cuff + strap
  kit.addM(new THREE.CylinderGeometry(0.0375, 0.039, 0.05, 20).rotateX(Math.PI / 2), M.glove, _m.compose(_p.set(0, 0, 0.016), _q.identity(), _s.set(0.8, 1, 1)));
  kit.addM(new THREE.CylinderGeometry(0.0392, 0.0392, 0.022, 20, 1, false, 0.3, Math.PI * 1.1).rotateX(Math.PI / 2), M.leather, _m.compose(_p.set(0, 0, 0.022), _q.identity(), _s.set(0.82, 1.01, 1)));
  kit.add(rbox(0.004, 0.02, 0.02, 0.0015), M.tpr, 0.031, 0.006, -0.022);

  // fingers
  const curls = o.curls;
  let index = null;
  FINGERS.forEach((fg, i) => {
    const c = curls[i];
    const splay = (1.5 - i) * 0.035;
    if (i === 0 && o.trigger) { // jointed: nested groups, one mesh per bone
      let parent = inner; const joints = [];
      let base = new THREE.Vector3(-0.002, fg.y, fg.z);
      for (let j = 0; j < 3; j++) {
        const g = new THREE.Group(); g.position.copy(base); g.rotation.y = c[j]; if (j === 0) g.rotation.x = -splay; parent.add(g);
        const k = new Kit(); capsule(k, M.glove, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -fg.L[j]), fg.r * (1 - 0.07 * j));
        if (j === 0) k.add(rbox(0.004, 0.012, 0.022, 0.0015), M.tpr, 0.0095, 0, 0.024);
        k.build(g); joints.push(g); parent = g; base = new THREE.Vector3(0, 0, -fg.L[j]);
      }
      index = { joints, rest: c.slice() };
      return;
    }
    let p = new THREE.Vector3(-0.002, fg.y, fg.z), th = 0;
    for (let j = 0; j < 3; j++) {
      th += c[j];
      const d = new THREE.Vector3(-Math.sin(th), Math.sin(splay) * Math.cos(th), -Math.cos(th)).normalize();
      const q = p.clone().addScaledVector(d, fg.L[j]);
      capsule(kit, M.glove, p, q, fg.r * (1 - 0.07 * j));
      if (j === 0) { // padded back of the first bone
        const mid = p.clone().addScaledVector(d, fg.L[j] * 0.5), nrm = new THREE.Vector3(Math.cos(th), 0, -Math.sin(th));
        _m.makeBasis(nrm, Y, new THREE.Vector3().crossVectors(nrm, Y)); _m.setPosition(mid.addScaledVector(nrm, fg.r * 0.85));
        kit.addM(rbox(0.004, 0.012, 0.022, 0.0015), M.tpr, _m);
      }
      p = q;
    }
  });
  // thumb: three bones bending from `dir` toward `bend`
  {
    const t = o.thumb, d0 = new THREE.Vector3(...t.dir).normalize(), b = new THREE.Vector3(...t.bend); b.addScaledVector(d0, -b.dot(d0)).normalize();
    let p = new THREE.Vector3(-0.008, 0.036, -0.026);
    [[0.036, 0.0145], [0.034, 0.0122], [0.028, 0.011]].forEach(([L, r], j) => {
      const a = t.angle * j, d = d0.clone().multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a));
      const q = p.clone().addScaledVector(d, L); capsule(kit, j === 0 ? M.leather : M.glove, p, q, r); p = q;
    });
  }
  kit.build(inner);

  // forearm: knit cuff, then a fabric sleeve with folds, a raised seam and a cuff tab; bent at the wrist toward the elbow
  {
    const len = 0.42, geo = new THREE.CylinderGeometry(0.053, 0.037, len, 32, 56, true);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), a = Math.atan2(z, x), s = (len / 2 - y) / len; // s: 0 at the wrist
      let fold = 0.0058 * Math.sin(y * 44 + 2.9 * Math.sin(a * 2 + y * 8)) * (0.3 + s * 1.1)   // big drape folds, deeper toward the elbow
        + 0.0032 * Math.sin(a * 4 + y * 19 + Math.sin(y * 31)) + 0.0016 * Math.sin(a * 11 - y * 70)  // creases
        + 0.004 * Math.exp(-Math.pow((s - 0.07) / 0.02, 2))                                          // gathered just above the cuff
        - (s < 0.045 ? 0.0045 : 0)                                                                    // hem tucks into the cuff
        + 0.0022 * Math.exp(-Math.pow(Math.atan2(Math.sin(a - 2.2), Math.cos(a - 2.2)) / 0.07, 2));  // seam
      const k = 1 + fold / Math.hypot(x, z);
      pos.setXYZ(i, x * k * 0.84, y, z * k);
    }
    geo.computeVertexNormals();
    const uvd = M.sleeve.userData.uv; const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.3 * uvd, uv.getY(i) * len * uvd);
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3));
    const arm = new THREE.Group();
    arm.add(new THREE.Mesh(geo, M.sleeve));
    const k = new Kit(), top = len / 2;
    // ribbed knit cuff
    const ribs = []; for (let i = 0; i <= 14; i++) ribs.push(new THREE.Vector2(0.0372 + (i % 2 ? 0.0011 : 0) + i * 0.00012, top - 0.03 + i * 0.0026));
    k.addM(new THREE.LatheGeometry(ribs, 26), M.glove, new THREE.Matrix4().makeScale(0.86, 1, 1));
    // adjustment tab with a press stud
    k.addM(rbox(0.004, 0.03, 0.022, 0.0015), M.sleeve, new THREE.Matrix4().makeTranslation(0.0335, top - 0.045, 0.006));
    k.addM(new THREE.CylinderGeometry(0.0032, 0.0032, 0.002, 10).rotateZ(Math.PI / 2), M.steel, new THREE.Matrix4().makeTranslation(0.036, top - 0.038, 0.006));
    k.build(arm);
    // elbow direction in the hand's frame
    const e = v3(o.elbow).normalize().applyQuaternion(outer.quaternion.clone().invert()); if (!right) e.x *= -1;
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), e);
    arm.position.set(0, 0, 0.03).addScaledVector(e, len / 2 - 0.01);
    inner.add(arm);
  }
  return { group: outer, index };
}
// squeeze the trigger finger: k 0..1
export function squeeze(index, k) {
  if (!index) return;
  index.joints[1].rotation.y = index.rest[1] + 0.22 * k; index.joints[2].rotation.y = index.rest[2] + 0.12 * k;
}
