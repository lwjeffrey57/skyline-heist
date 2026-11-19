import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createDressing } from './visuals/dressing.js';

// Detail geometry. Nothing here collides.
//   * anything that belongs to a destructible piece is a CHILD of that piece's mesh (one merged mesh per
//     piece and material), so it disappears with it
//   * everything else is merged / instanced into a handful of static meshes
//   * practical lights: many emissive fixtures, a small pool of real PointLights that follows the camera

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- geometry helpers -----------------------------------------------------------
const FACES = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];
// Collects boxes / quads / arbitrary geometries and merges them into one BufferGeometry
// (attributes: position, normal, uv in metres/4, aFace = face size for the edge shader).
class Batch {
  constructor() { this.p = []; this.n = []; this.uv = []; this.f = []; this.idx = []; this.extra = []; }
  box(x, y, z, w, h, d, uvOff = 0) {
    const half = [w / 2, h / 2, d / 2], c = [x, y, z];
    for (const [n, u, v] of FACES) {
      const hu = Math.abs(u[0]) * half[0] + Math.abs(u[1]) * half[1] + Math.abs(u[2]) * half[2];
      const hv = Math.abs(v[0]) * half[0] + Math.abs(v[1]) * half[1] + Math.abs(v[2]) * half[2];
      const hn = Math.abs(n[0]) * half[0] + Math.abs(n[1]) * half[1] + Math.abs(n[2]) * half[2];
      const base = this.p.length / 3;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        for (let k = 0; k < 3; k++) this.p.push(c[k] + n[k] * hn + u[k] * hu * su + v[k] * hv * sv);
        this.n.push(n[0], n[1], n[2]);
        this.uv.push(((su + 1) * hu) / 4 + uvOff, ((sv + 1) * hv) / 4 + uvOff * 0.7);
        this.f.push(uvOff ? 0 : hu * 2, uvOff ? 0 : hv * 2);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return this;
  }
  // textured quad: centre c, half-axes u and v (world vectors), uv rect [u0, v0, u1, v1]
  quad(c, u, v, rect = [0, 0, 1, 1]) {
    const n = new THREE.Vector3().crossVectors(u, v).normalize(), base = this.p.length / 3;
    const pts = [[-1, -1, rect[0], rect[1]], [1, -1, rect[2], rect[1]], [1, 1, rect[2], rect[3]], [-1, 1, rect[0], rect[3]]];
    for (const [su, sv, tu, tv] of pts) {
      this.p.push(c.x + u.x * su + v.x * sv, c.y + u.y * su + v.y * sv, c.z + u.z * su + v.z * sv);
      this.n.push(n.x, n.y, n.z); this.uv.push(tu, tv); this.f.push(0, 0);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return this;
  }
  geo(g, matrix) { // any three geometry (gets no edge data)
    g = g.index ? g.toNonIndexed() : g.clone(); if (matrix) g.applyMatrix4(matrix);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    g.setAttribute('aFace', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    this.extra.push(g); return this;
  }
  get empty() { return this.p.length === 0 && this.extra.length === 0; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aFace', new THREE.Float32BufferAttribute(this.f, 2));
    g.setIndex(this.idx);
    if (!this.extra.length) return g;
    const all = this.p.length ? [g.toNonIndexed(), ...this.extra] : this.extra;
    return mergeGeometries(all, false);
  }
  mesh(material, { cast = false, receive = true } = {}) {
    const m = new THREE.Mesh(this.build(), material);
    m.castShadow = cast; m.receiveShadow = receive; m.matrixAutoUpdate = false; m.updateMatrix();
    return m;
  }
}

// ---- canvas atlases ---------------------------------------------------------------
function makeAtlas(renderer, size, draw, wide = 1) {
  const c = document.createElement('canvas'); c.height = size; c.width = size * wide;
  const g = c.getContext('2d'); const rects = {};
  // cell(name, x, y, w, h, fn): fn draws inside a translated/clipped cell
  const cell = (name, x, y, w, h, fn) => {
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.translate(x, y); fn(g, w, h); g.restore();
    const e = 1.5 / size, W = size * wide; rects[name] = [x / W + e / wide, 1 - (y + h) / size + e, (x + w) / W - e / wide, 1 - y / size - e];
  };
  draw(cell, g);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return { texture: t, rects };
}
const wear = (g, w, h, rand, amount = 900) => { // knock speckles and scratches out of fresh paint
  g.save(); g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < amount; i++) { g.globalAlpha = 0.25 + rand() * 0.6; const s = 1 + rand() * rand() * 9; g.fillRect(rand() * w, rand() * h, s, s * (0.4 + rand())); }
  for (let i = 0; i < amount / 30; i++) { g.globalAlpha = 0.5; g.fillRect(rand() * w, rand() * h, 20 + rand() * 120, 1 + rand() * 2); }
  g.restore();
};

export function init(ctx) {
  const { scene, world, view, camera, renderer } = ctx;
  const M = world.materials;
  const rand = rng(2024);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const lamps = []; // { pos, color, intensity, parent (mesh or null) }
  let children = 0;
  // ?nodecor=1 switches the set dressing (visuals/dressing.js) and the distance culls below off, for before / after comparisons
  const NODECOR = /[?&]nodecor=1/.test(typeof location !== 'undefined' ? location.search : '') || !!ctx.world.blockout; // a blockout map is played bare
  // small detail meshes that hang off level pieces, grouped by where they are so they can be hidden when far away
  const kidGroups = new Map(); // key -> { x, z, range, far, meshes }
  const kid = (m, key, x, z, range) => { let g = kidGroups.get(key); if (!g) kidGroups.set(key, (g = { x, z, range, far: false, meshes: [] })); g.meshes.push(m); return m; };

  // ---- 0. hide the placeholder skyline that world.js builds (replaced below) -------
  for (const o of scene.children) {
    if (!o.isMesh || o.userData.collider) continue;
    const far = Math.hypot(o.position.x, o.position.z) > 140;
    if (o.material === M.far || (far && (o.material === M.glowAmber || o.material === M.glowTeal))) o.visible = false;
  }

  // ---- 1. edge data for every level box (drives bevel / edge wear in materials.js) --
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || o.geometry.type !== 'BoxGeometry' || o.geometry.attributes.aFace) return;
    const p = o.geometry.parameters; if (o.geometry.attributes.position.count !== 24) return;
    const dims = [[p.depth, p.height], [p.depth, p.height], [p.width, p.depth], [p.width, p.depth], [p.width, p.height], [p.width, p.height]];
    const a = new Float32Array(48);
    for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) { a[(f * 4 + i) * 2] = dims[f][0]; a[(f * 4 + i) * 2 + 1] = dims[f][1]; }
    o.geometry.setAttribute('aFace', new THREE.BufferAttribute(a, 2));
  });

  // ---- atlases ----------------------------------------------------------------------
  const BRANDS = ['KORVAN FREIGHT', 'HALDEN LINES', 'NORDWEN CARGO', 'TESSERA', 'VANTA-9 LOGISTICS'];
  const font = (px, weight = 800) => `${weight} ${px}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
  const wallAtlas = makeAtlas(renderer, 1024, (cell) => {
    const r = rng(5);
    BRANDS.forEach((name, i) => cell(`brand${i}`, 0, i * 104, 1024, 104, (g, w, h) => {
      g.fillStyle = '#f4f1e8'; g.font = font(70); g.textBaseline = 'middle';
      g.fillRect(8, 20, 46, 64); g.clearRect(20, 32, 22, 40); // invented box mark
      g.fillText(name, 70, h / 2 + 4, w - 300);
      g.font = font(26, 600); g.fillText(`${['KVN', 'HLD', 'NRW', 'TSR', 'VN9'][i]}U ${100000 + Math.floor(r() * 899999)} ${Math.floor(r() * 9)}`, w - 280, 34);
      g.fillText('MAX GROSS 30 480 KG', w - 280, 72);
      wear(g, w, h, r, 700);
    }));
    ['A', 'B', 'C', 'D'].forEach((L, i) => cell(`block${i}`, i * 256, 528, 256, 256, (g, w, h) => {
      g.fillStyle = '#f1ede2'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = font(200, 900); g.fillText(L, w / 2, h / 2 + 18);
      g.font = font(26, 700); g.fillText('BLOCK', w / 2, 30);
      g.fillRect(24, 50, w - 48, 6); g.fillRect(24, h - 20, w - 48, 6);
      wear(g, w, h, r, 900);
    }));
    ['01', '02', '03', '04', '05', '06', '07', '08'].forEach((L, i) => cell(`num${i}`, (i % 4) * 256, 784 + Math.floor(i / 4) * 120, 256, 120, (g, w, h) => {
      g.fillStyle = '#e9e5da'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = font(92, 900);
      g.fillText(`S-${L}`, w / 2, h / 2 + 6); wear(g, w, h, r, 500);
    }));
    // sign plates (right half): gate names, what each outpost is
    ['N1', 'N2', 'S1', 'S2', 'W1', 'E1'].forEach((L, i) => cell(`gate${i}`, 1024 + (i % 2) * 512, Math.floor(i / 2) * 100, 512, 90, (g, w, h) => {
      g.fillStyle = '#15171b'; g.fillRect(0, 0, w, h); g.fillStyle = '#e9a321'; g.fillRect(0, 0, w, 7); g.fillRect(0, h - 7, w, 7);
      g.textBaseline = 'middle'; g.font = font(60, 900); g.fillText(`GATE ${L}`, 22, h / 2 + 3);
      g.fillStyle = '#e8e2d0'; g.font = font(20, 700); g.fillText('INNER COMPOUND', 300, 32); g.fillText('STOP · SHOW PASS', 300, 60);
      wear(g, w, h, r, 260);
    }));
    [['armoury', 'ARMOURY', '#7a2a22'], ['infirmary', 'INFIRMARY', '#1d6a6b'], ['signal', 'SIGNAL STATION', '#24364f'], ['depot', 'SUPPLY DEPOT', '#8a5a14'], ['watch', 'WATCH POST', '#3d4a33']].forEach(([key, label, bg], i) => cell(`op_${key}`, 1024 + (i % 2) * 512, 310 + Math.floor(i / 2) * 134, 512, 128, (g, w, h) => {
      g.fillStyle = bg; g.fillRect(0, 0, w, h); g.strokeStyle = '#efe9d8'; g.lineWidth = 5; g.strokeRect(8, 8, w - 16, h - 16);
      g.fillStyle = '#efe9d8'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = font(62, 900); g.fillText(label, w / 2, 52, w - 40);
      g.font = font(19, 700); g.fillText(`OUTPOST 0${i + 1} · AUTHORISED STAFF ONLY`, w / 2, 100);
      wear(g, w, h, r, 420);
    }));
  }, 2);
  const groundAtlas = makeAtlas(renderer, 1024, (cell) => {
    const r = rng(9);
    cell('hazard', 0, 0, 512, 512, (g, w, h) => { // chevron ring around a jump pad
      g.translate(w / 2, h / 2);
      for (let i = 0; i < 28; i++) { g.rotate((Math.PI * 2) / 28); g.fillStyle = i % 2 ? '#e9a321' : '#16181b'; g.beginPath(); g.moveTo(190, -24); g.lineTo(246, -12); g.lineTo(246, 34); g.lineTo(190, 22); g.fill(); }
      g.strokeStyle = '#e8e2d0'; g.lineWidth = 5; g.beginPath(); g.arc(0, 0, 180, 0, 7); g.stroke();
      g.translate(-w / 2, -h / 2); wear(g, w, h, r, 2600);
    });
    cell('arrow', 512, 0, 256, 512, (g, w, h) => {
      g.fillStyle = '#ece6d4'; g.beginPath(); g.moveTo(w / 2, 20); g.lineTo(w - 30, 200); g.lineTo(w / 2 + 34, 200); g.lineTo(w / 2 + 34, h - 20); g.lineTo(w / 2 - 34, h - 20); g.lineTo(w / 2 - 34, 200); g.lineTo(30, 200); g.fill();
      wear(g, w, h, r, 1500);
    });
    cell('manhole', 768, 0, 256, 256, (g, w, h) => {
      g.translate(w / 2, h / 2); g.fillStyle = '#1b1c1e'; g.beginPath(); g.arc(0, 0, 122, 0, 7); g.fill();
      g.fillStyle = '#4a4b4d'; g.beginPath(); g.arc(0, 0, 110, 0, 7); g.fill();
      g.strokeStyle = '#2a2b2d'; g.lineWidth = 7;
      for (let i = -4; i <= 4; i++) { g.beginPath(); g.moveTo(i * 24, -100); g.lineTo(i * 24, 100); g.stroke(); g.beginPath(); g.moveTo(-100, i * 24); g.lineTo(100, i * 24); g.stroke(); }
      g.lineWidth = 12; g.strokeStyle = '#3a3b3d'; g.beginPath(); g.arc(0, 0, 104, 0, 7); g.stroke();
    });
    cell('drain', 768, 256, 256, 128, (g, w, h) => {
      g.fillStyle = '#2b2c2e'; g.fillRect(4, 4, w - 8, h - 8); g.fillStyle = '#0c0c0d';
      for (let i = 0; i < 9; i++) g.fillRect(18 + i * 25, 16, 13, h - 32);
    });
    cell('stain', 768, 384, 256, 256, (g, w, h) => {
      for (let i = 0; i < 26; i++) { const x = w / 2 + (r() - 0.5) * 120, y = h / 2 + (r() - 0.5) * 120, rad = 20 + r() * 70; const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, 'rgba(8,8,10,0.34)'); gr.addColorStop(1, 'rgba(8,8,10,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); }
    });
    cell('skid', 0, 512, 256, 512, (g, w, h) => {
      for (const x0 of [70, 170]) for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(6,6,8,${0.05 + r() * 0.07})`; const x = x0 + (r() - 0.5) * 26; g.fillRect(x, 20 + r() * 80, 4 + r() * 10, h - 60 - r() * 200); }
    });
    cell('clear', 256, 512, 512, 256, (g, w, h) => {
      g.fillStyle = '#ece6d4'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = font(120, 900);
      g.fillText('KEEP', w / 2, 70); g.fillText('CLEAR', w / 2, 186); wear(g, w, h, r, 2200);
    });
    cell('bay', 256, 768, 512, 256, (g, w, h) => {
      g.strokeStyle = '#e9a321'; g.lineWidth = 14; g.strokeRect(14, 14, w - 28, h - 28);
      g.fillStyle = '#e9a321'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = font(110, 900); g.fillText('LOADING', w / 2, h / 2 + 6);
      wear(g, w, h, r, 2600);
    });
    cell('patch', 768, 640, 256, 384, (g, w, h) => { // asphalt repair patch
      g.fillStyle = 'rgba(14,14,16,0.5)'; g.fillRect(10, 10, w - 20, h - 20);
      g.strokeStyle = 'rgba(5,5,6,0.7)'; g.lineWidth = 6; g.strokeRect(10, 10, w - 20, h - 20);
    });
    // road paint (right half)
    cell('line', 1024, 0, 64, 512, (g, w, h) => { g.fillStyle = '#e6e0cf'; g.fillRect(0, 0, w, h); wear(g, w, h, r, 420); });
    cell('yline', 1100, 0, 64, 512, (g, w, h) => { g.fillStyle = '#d99a1c'; g.fillRect(0, 0, w, h); wear(g, w, h, r, 520); });
    cell('zebra', 1180, 0, 840, 96, (g, w, h) => {
      g.fillStyle = '#16181b'; g.fillRect(0, 0, w, h); g.fillStyle = '#e9a321';
      for (let x = -h; x < w; x += 96) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 48, h); g.lineTo(x + 48 + h, 0); g.lineTo(x + h, 0); g.fill(); }
      wear(g, w, h, r, 1500);
    });
    cell('stop', 1180, 110, 512, 232, (g, w, h) => { g.fillStyle = '#ece6d4'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = font(230, 900); g.fillText('STOP', w / 2, h / 2 + 14, w - 20); wear(g, w, h, r, 2000); });
    ['N1', 'N2', 'S1', 'S2', 'W1', 'E1'].forEach((L, i) => cell(`gname${i}`, 1180 + (i % 2) * 420, 350 + Math.floor(i / 2) * 150, 400, 140, (g, w, h) => {
      g.fillStyle = '#e9a321'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = font(120, 900); g.fillText(`GATE ${L}`, w / 2, h / 2 + 8, w - 20); wear(g, w, h, r, 1300);
    }));
    // large tonal patches that go UNDER the paint: poured concrete aprons, bare dirt, gravel shoulders
    cell('pad', 1700, 110, 330, 230, (g, w, h) => {
      g.fillStyle = 'rgba(168,164,154,0.5)'; g.fillRect(6, 6, w - 12, h - 12);
      for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(${r() < 0.5 ? '40,40,42' : '205,200,190'},${0.03 + r() * 0.05})`; const sz = 6 + r() * 40; g.fillRect(6 + r() * (w - 12 - sz), 6 + r() * (h - 12 - sz), sz, sz * (0.4 + r())); }
      g.strokeStyle = 'rgba(20,20,22,0.55)'; g.lineWidth = 2; for (let i = 1; i < 5; i++) { g.beginPath(); g.moveTo(6 + (i * (w - 12)) / 5, 6); g.lineTo(6 + (i * (w - 12)) / 5, h - 6); g.stroke(); } for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(6, 6 + (i * (h - 12)) / 4); g.lineTo(w - 6, 6 + (i * (h - 12)) / 4); g.stroke(); }
      g.lineWidth = 3; g.strokeStyle = 'rgba(15,15,17,0.6)'; g.strokeRect(6, 6, w - 12, h - 12);
    });
    for (const [name, x0, tone] of [['dirt', 1410, '92,74,52'], ['verge', 1640, '120,112,98']]) cell(name, x0, 800, 220, 220, (g, w, h) => {
      for (let i = 0; i < 60; i++) { const x = w / 2 + (r() - 0.5) * 120, y = h / 2 + (r() - 0.5) * 120, rad = 22 + r() * 50; const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, `rgba(${tone},0.22)`); gr.addColorStop(1, `rgba(${tone},0)`); g.fillStyle = gr; g.fillRect(0, 0, w, h); }
      for (let i = 0; i < 500; i++) { const an = r() * 6.28, d = r() * r() * 92; g.fillStyle = `rgba(${r() < 0.5 ? '30,26,20' : '170,160,140'},${0.15 + r() * 0.3})`; g.fillRect(w / 2 + Math.cos(an) * d, h / 2 + Math.sin(an) * d, 1 + r() * 2.5, 1 + r() * 2.5); }
    });
    cell('crack', 1180, 800, 220, 220, (g, w, h) => {
      g.strokeStyle = 'rgba(6,6,8,0.75)'; g.lineCap = 'round';
      for (let i = 0; i < 5; i++) { let x = w / 2 + (r() - 0.5) * 40, y = h / 2 + (r() - 0.5) * 40, an = r() * 6.28; g.lineWidth = 1.5 + r() * 2; g.beginPath(); g.moveTo(x, y); for (let j = 0; j < 9; j++) { an += (r() - 0.5) * 1.3; x += Math.cos(an) * 12; y += Math.sin(an) * 12; g.lineTo(x, y); if (j > 4) g.lineWidth *= 0.8; } g.stroke(); }
    });
  }, 2);
  const decalOpts = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, roughness: 0.82, metalness: 0 };
  const wallDecalMat = new THREE.MeshStandardMaterial({ map: wallAtlas.texture, ...decalOpts, opacity: 0.86 });
  const groundDecalMat = new THREE.MeshStandardMaterial({ map: groundAtlas.texture, ...decalOpts, opacity: 0.9 });

  // ---- 2. containers: corrugated steel, door gear, stencilled (invented) operator names
  let ci = 0;
  for (const c of world.colliders) {
    if (c.tag !== 'container' || !c.mesh) continue;
    c.mesh.material = M.containerFor(c.mat); c.mat = c.mesh.material; // same hue, so debris colours still match
    const sx = c.max.x - c.min.x, sy = c.max.y - c.min.y, sz = c.max.z - c.min.z, alongX = sx > sz;
    const len = alongX ? sx : sz, wid = alongX ? sz : sx;
    const P = (a, y, n) => (alongX ? V(a, y, n) : V(n, y, a)); // a = along the long axis, n = across
    const decal = new Batch();
    const brand = wallAtlas.rects[`brand${ci % BRANDS.length}`];
    for (const s of [-1, 1]) {
      const u = alongX ? V(s * 2.3, 0, 0) : V(0, 0, -s * 2.3);
      decal.quad(P(-0.3 * s * (alongX ? 1 : -1), sy / 2 - 0.62, s * (wid / 2 + 0.012)), u, V(0, 0.235, 0), brand);
    }
    const cmx = (c.min.x + c.max.x) / 2, cmz = (c.min.z + c.max.z) / 2;
    const dm = decal.mesh(wallDecalMat); c.mesh.add(dm); children++; kid(dm, `c${ci}`, cmx, cmz, 120);
    const gear = new Batch(), e = len / 2 + 0.03;
    const B = (a, y, n, la, h, ln) => (alongX ? gear.box(a, y, n, la, h, ln, 0.3) : gear.box(n, y, a, ln, h, la, 0.3));
    for (const n of [-0.85, -0.3, 0.3, 0.85]) { B(e, 0, n, 0.045, sy - 0.24, 0.045); B(e + 0.02, -0.25, n + 0.07, 0.03, 0.05, 0.16); }
    for (const y of [-sy / 2 + 0.2, sy / 2 - 0.2]) for (const n of [-0.85, -0.3, 0.3, 0.85]) B(e, y, n, 0.07, 0.09, 0.11);
    B(e - 0.02, 0, 0, 0.03, sy - 0.2, 0.03); // door split
    for (const s of [-1, 1]) for (const cn of [-1, 1]) for (const cy of [-1, 1]) B(s * (len / 2 - 0.09), cy * (sy / 2 - 0.06), cn * (wid / 2 - 0.08), 0.2, 0.14, 0.18); // corner castings
    c.mesh.add(kid(gear.mesh(M.trim), `g${ci}`, cmx, cmz, 75)); children++;
    ci++;
  }

  // ---- 3. buildings: frames, copings, lamps, wall hardware --------------------------
  const pieces = world.colliders.filter((c) => c.mesh && c.destructible);
  const size = (c, k) => c.max[k] - c.min[k];
  const mid = (c) => V((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2);
  const buildingOf = (c) => {
    const m = mid(c);
    return world.buildings.find((b) => Math.abs(m.x - b.x) <= b.w / 2 + 0.01 && Math.abs(m.z - b.z) <= b.d / 2 + 0.01 && m.y < b.roofY + 2);
  };
  // which way is "outside" for a wall piece: +1 / -1 along its thin axis
  const facing = (c, b) => {
    const alongX = size(c, 'x') > size(c, 'z'), m = mid(c);
    return { alongX, out: alongX ? (m.z > b.z ? 1 : -1) : (m.x > b.x ? 1 : -1) };
  };
  let curB = null; // the building whose pieces are being dressed
  const attach = (c, batch, material, opts) => {
    if (batch.empty) return null; const m = batch.mesh(material, opts); c.mesh.add(m); children++;
    if (curB) { const far = material === wallDecalMat || material === M.glowWarm; kid(m, `${world.buildings.indexOf(curB)}${far ? 'f' : 'n'}`, curB.x, curB.z, (far ? 150 : 82) + Math.max(curB.w, curB.d) / 2); }
    return m;
  };
  const sills = pieces.filter((c) => c.tag === 'sill');
  const lettered = new Set();

  for (const c of pieces) {
    const b = buildingOf(c); if (!b) continue;
    const bi = world.buildings.indexOf(b); curB = b;
    if (c.tag === 'lintel') {
      const { alongX, out } = facing(c, b), th = b.wallThickness, len = alongX ? size(c, 'x') : size(c, 'z');
      const m = mid(c), hy = size(c, 'y') / 2, bat = new Batch();
      const B = (a, y, n, la, h, ln) => (alongX ? bat.box(a, y, n, la, h, ln, 0.17) : bat.box(n, y, a, ln, h, la, 0.17));
      const isWindow = sills.some((s) => Math.abs((s.min.x + s.max.x) / 2 - m.x) < 0.05 && Math.abs((s.min.z + s.max.z) / 2 - m.z) < 0.05 && Math.abs(s.max.y - (c.min.y - 1.5)) < 0.05);
      if (isWindow) {
        const top = -hy, bot = -hy - 1.5, bar = 0.06, dep = 0.12;
        B(0, top - 0.05, 0, len, 0.10, 0.2);                       // shutter housing
        B(0, bot + bar / 2, 0, len, bar, dep);                     // frame
        for (const s of [-1, 1]) B(s * (len / 2 - bar / 2), (top + bot) / 2, 0, bar, 1.5 - 0.02, dep);
        B(0, bot + 0.02, out * (th / 2 + 0.05), len + 0.12, 0.04, 0.16); // outside ledge
      } else {
        // door: jambs, threshold, cable from the light above the door
        const floorY = -hy - 2.5;
        for (const s of [-1, 1]) B(s * (len / 2 - 0.045), -hy - 1.25, 0, 0.09, 2.5, th + 0.1);
        B(0, floorY + 0.012, 0, len, 0.024, th + 0.36);
        B(len / 2 - 0.3, hy * 0.2, out * (th / 2 + 0.03), 0.28, 0.2, 0.06);
        lamps.push({ pos: m.clone().add(alongX ? V(0, -hy - 0.35, out * 1.1) : V(out * 1.1, -hy - 0.35, 0)), color: 0xffa85a, intensity: 15, parent: c.mesh });
      }
      attach(c, bat, M.trim);
    } else if (c.tag === 'parapet') {
      if (c.mesh.children.length) continue; // the front one carries the building's glow strip
      const alongX = size(c, 'x') > size(c, 'z'), bat = new Batch();
      if (alongX) bat.box(0, 0.5 + 0.025, 0, size(c, 'x'), 0.05, size(c, 'z') + 0.1, 0.4);
      else bat.box(0, 0.5 + 0.025, 0, size(c, 'x') + 0.1, 0.05, size(c, 'z') + 0.2, 0.4);
      attach(c, bat, M.trim, { cast: false });
    } else if (c.tag === 'wall') {
      const { alongX, out } = facing(c, b), th = b.wallThickness, bat = new Batch(), roll = rand();
      const B = (a, y, n, la, h, ln) => (alongX ? bat.box(a, y, n, la, h, ln, 0.23) : bat.box(n, y, a, ln, h, la, 0.23));
      const n0 = out * (th / 2);
      const side = `${bi}:${alongX ? 'x' : 'z'}:${out}`;
      if (!lettered.has(side) && c.min.y > 1) {
        // big stencilled block letter, once per facade
        lettered.add(side);
        const d = new Batch(), u = alongX ? V(-out * 1.25, 0, 0) : V(0, 0, out * 1.25);
        d.quad(alongX ? V(0, 0.1, n0 + 0.012 * out) : V(n0 + 0.012 * out, 0.1, 0), u.multiplyScalar(-1), V(0, 1.25, 0), wallAtlas.rects[`block${bi % 4}`]);
        attach(c, d, wallDecalMat);
      } else if (roll < 0.4) {
        // louvred vent
        const a = (rand() - 0.5) * 1.6, y = 0.7 + rand() * 0.5;
        B(a, y, n0 + out * 0.02, 0.8, 0.5, 0.04);
        for (let i = 0; i < 5; i++) B(a, y - 0.18 + i * 0.09, n0 + out * 0.055, 0.7, 0.025, 0.05);
      } else if (roll < 0.75) {
        // conduit + junction box
        const a = (rand() < 0.5 ? -1 : 1) * (0.9 + rand() * 0.7), hy = size(c, 'y') / 2;
        B(a, 0, n0 + out * 0.035, 0.045, hy * 2, 0.045);
        B(a, -0.3 + rand() * 0.8, n0 + out * 0.06, 0.26, 0.36, 0.12);
        B(a + 0.4, hy - 0.5, n0 + out * 0.035, 0.8, 0.04, 0.04);
        for (const y of [-1.2, 1.3]) B(a, y, n0 + out * 0.03, 0.1, 0.03, 0.06);
      }
      attach(c, bat, M.trim);
    }
  }
  // ceiling lights: the two largest slab pieces of every floor get a fixture
  const byFloor = new Map();
  for (const c of pieces) {
    if (c.tag !== 'slab') continue; const b = buildingOf(c); if (!b) continue;
    const key = `${world.buildings.indexOf(b)}:${c.min.y.toFixed(1)}`;
    if (!byFloor.has(key)) byFloor.set(key, []); byFloor.get(key).push(c);
  }
  for (const list of byFloor.values()) {
    list.sort((a, b2) => size(b2, 'x') * size(b2, 'z') - size(a, 'x') * size(a, 'z'));
    for (const c of list.slice(0, 2)) {
      curB = buildingOf(c);
      const alongX = size(c, 'x') > size(c, 'z'), hy = size(c, 'y') / 2;
      const housing = new Batch(), glow = new Batch();
      if (alongX) { housing.box(0, -hy - 0.035, 0, 1.5, 0.07, 0.24, 0.3); glow.box(0, -hy - 0.075, 0, 1.36, 0.02, 0.15); }
      else { housing.box(0, -hy - 0.035, 0, 0.24, 0.07, 1.5, 0.3); glow.box(0, -hy - 0.075, 0, 0.15, 0.02, 1.36); }
      attach(c, housing, M.trim); attach(c, glow, M.glowWarm);
      lamps.push({ pos: mid(c).add(V(0, -hy - 0.5, 0)), color: 0xffd2a4, intensity: 20, parent: c.mesh });
    }
  }
  curB = null;
  // detail on the solid rooftop units that world.js places
  for (const c of world.colliders) {
    if (c.tag !== 'prop' || c.mat !== M.metal || !c.mesh || c.min.y < 3 || size(c, 'y') > 2.5 || size(c, 'x') < 1.5) continue;
    const w = size(c, 'x'), h = size(c, 'y'), d = size(c, 'z'), bat = new Batch();
    for (let i = 0; i < 7; i++) bat.box(0, -h / 2 + 0.3 + i * 0.13, d / 2 + 0.02, w * 0.8, 0.03, 0.05, 0.2);
    bat.geo(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 20), new THREE.Matrix4().makeTranslation(-w / 4, h / 2 + 0.04, 0));
    bat.geo(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 20), new THREE.Matrix4().makeTranslation(w / 4, h / 2 + 0.04, 0));
    bat.geo(new THREE.CylinderGeometry(0.07, 0.07, 1.6, 8), new THREE.Matrix4().makeTranslation(w / 2 + 0.1, -h / 2 + 0.8, -d / 4));
    bat.box(0, -h / 2 + 0.04, 0, w + 0.2, 0.08, d + 0.2, 0.2);
    c.mesh.add(bat.mesh(M.trim, { cast: true })); children++;
  }

  // ---- 4. static dressing: perimeter, yard furniture, ground decals -----------------
  const H = world.arenaHalf, WALL_H = 7;
  const conc = new Batch(), trim = new Batch(), glowW = new Batch(), glowA = new Batch(), yellow = new Batch();
  for (const s of [-1, 1]) {
    for (let i = -6; i <= 6; i++) { // pilasters + kerb along the inside of the perimeter wall
      conc.box(i * 10 + 5 * (i < 0 ? 1 : -1) * 0 , WALL_H / 2, s * (H - 0.13), 0.7, WALL_H, 0.26);
      conc.box(s * (H - 0.13), WALL_H / 2, i * 10, 0.26, WALL_H, 0.7);
    }
    conc.box(0, 0.16, s * (H - 0.2), H * 2, 0.32, 0.4); conc.box(s * (H - 0.2), 0.16, 0, 0.4, 0.32, H * 2);
    conc.box(0, WALL_H - 0.5, s * (H - 0.06), H * 2, 0.22, 0.12); conc.box(s * (H - 0.06), WALL_H - 0.5, 0, 0.12, 0.22, H * 2);
    // service pipes + cable tray
    for (const [y, r] of [[5.2, 0.07], [5.42, 0.045]]) {
      trim.box(0, y, s * (H - 0.34), H * 2 - 1, r * 2, r * 2, 0.3); trim.box(s * (H - 0.34), y, 0, r * 2, r * 2, H * 2 - 1, 0.3);
    }
    for (let i = -6; i <= 6; i++) { trim.box(i * 10 + 2.5, 5.3, s * (H - 0.3), 0.08, 0.5, 0.16, 0.3); trim.box(s * (H - 0.3), 5.3, i * 10 + 2.5, 0.16, 0.5, 0.08, 0.3); }
    // wall-top flood lamps every 20 m
    for (let i = -3; i <= 3; i++) {
      const p = i * 20 + 10 * 0;
      trim.box(p, WALL_H + 0.45, s * (H - 0.1), 0.08, 0.9, 0.08, 0.3); trim.box(p, WALL_H + 0.9, s * (H - 0.55), 0.12, 0.08, 1.0, 0.3); trim.box(p, WALL_H + 0.82, s * (H - 1.0), 0.5, 0.14, 0.3, 0.3);
      glowW.box(p, WALL_H + 0.74, s * (H - 1.0), 0.42, 0.03, 0.22);
      trim.box(s * (H - 0.1), WALL_H + 0.45, p, 0.08, 0.9, 0.08, 0.3); trim.box(s * (H - 0.55), WALL_H + 0.9, p, 1.0, 0.08, 0.12, 0.3); trim.box(s * (H - 1.0), WALL_H + 0.82, p, 0.3, 0.14, 0.5, 0.3);
      glowW.box(s * (H - 1.0), WALL_H + 0.74, p, 0.22, 0.03, 0.42);
    }
  }
  // wheel stops at the parking lines near spawn, bollards beside the plaza steps (all knee-high or thinner)
  for (let i = -3; i < 3; i++) { conc.box(i * 6 + 3, 0.07, 48.3, 1.8, 0.14, 0.3); yellow.box(i * 6 + 3, 0.145, 48.3, 1.5, 0.012, 0.1, 0.5); }
  for (const [x, z] of [[-3.4, 9.2], [3.4, 9.2], [-3.4, -9.2], [3.4, -9.2], [9.2, -3.4], [9.2, 3.4], [-9.2, -3.4], [-9.2, 3.4]]) {
    trim.geo(new THREE.CylinderGeometry(0.07, 0.08, 0.9, 10), new THREE.Matrix4().makeTranslation(x, 0.45, z));
    glowA.geo(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 10), new THREE.Matrix4().makeTranslation(x, 0.8, z));
  }
  // plaza monolith: metal collar + base plate
  trim.box(0, 1.03, 0, 2.5, 0.06, 2.5, 0.2); trim.box(0, 4.1, 0, 2.3, 0.1, 2.3, 0.2);

  const statics = new THREE.Group(); statics.name = 'decor-static'; scene.add(statics);
  const addStatic = (batch, material, opts) => { if (!batch.empty) statics.add(batch.mesh(material, opts)); };

  // ground decals (one mesh)
  const gd = new Batch(), gdUnder = new Batch(), GY = 0.021;
  const ground = (name, x, z, w, d, rot = 0, under = false) => {
    if (!groundAtlas.rects[name]) return;
    const c = Math.cos(rot), s = Math.sin(rot);
    (under ? gdUnder : gd).quad(V(x, GY, z), V((c * w) / 2, 0, (-s * w) / 2), V((-s * d) / 2, 0, (-c * d) / 2), groundAtlas.rects[name]);
  };
  for (const p of world.pads) ground('hazard', p.x, p.z, 5.2, 5.2, rand() * 6);
  ground('arrow', 0, 34, 1.6, 4.2, 0); ground('arrow', -22, 14, 1.6, 4.2, 0.9); ground('arrow', 24, 4, 1.6, 4.2, -1.2); ground('arrow', 30, -34, 1.6, 4.2, 2.4);
  ground('clear', 0, 27.5, 5, 2.5, 0); ground('clear', -13, -15.5, 4, 2, Math.PI); ground('clear', 46, 30, 4, 2, 1.2);
  ground('bay', -8, 36, 7, 3.2, 0); ground('bay', 47, 5, 6, 2.8, Math.PI / 2); ground('bay', 9, -35.5, 7, 3.2, Math.PI); ground('bay', -51, 15.5, 7, 3, 0);
  for (const [x, z] of [[8, 46], [-20, 4], [20, -2], [-44, -20], [40, -30], [56, 16], [-12, 50], [-46, 44], [2, -30], [34, 52]]) ground('manhole', x, z, 0.95, 0.95, rand() * 6);
  for (const [x, z, r] of [[-66, 0, 0], [66, 20, 0], [0, 66, 1.57], [20, -66, 1.57], [-66, -40, 0], [-30, 66, 1.57]]) ground('drain', x, z, 0.5, 1.0, r + 1.57);
  for (let i = 0; i < 26; i++) { const x = (rand() - 0.5) * 124, z = (rand() - 0.5) * 124; ground('stain', x, z, 3 + rand() * 5, 3 + rand() * 5, rand() * 6); }
  for (const [x, z, r] of [[5, 40, 0.2], [-18, 44, -0.3], [28, 12, 1.3], [-40, 2, 1.7], [-4, -22, 0.1], [44, -14, 0.5], [18, 58, 1.5]]) ground('skid', x, z, 2.6, 9 + rand() * 5, r);
  for (const [x, z, r] of [[14, 36, 0.1], [-36, 14, 1.6], [38, -44, 0.3], [-22, -40, 1.5], [54, 44, 0.0]]) ground('patch', x, z, 3.2, 5, r);
  // furniture, vehicles, street furniture, roof plant (adds its own paint to the two decal batches)
  const wd = new Batch();
  let dressing = null;
  if (!NODECOR) {
    try { dressing = createDressing(ctx, { lamps, ground, sign: (name, c, u, v) => { if (wallAtlas.rects[name]) wd.quad(c, u, v, wallAtlas.rects[name]); } }); } catch (e) { console.error('[decor] dressing failed', e); }
    // stair treads are indoors, under a roof: they do not need to be drawn into the sun's shadow maps
    for (const c of world.colliders) if (c.tag === 'stair' && c.mesh) c.mesh.castShadow = false;
  }
  { // one mesh: the under-layer patches first, so the paint is drawn over them
    const base = gdUnder.p.length / 3;
    for (const k of ['p', 'n', 'uv', 'f']) gdUnder[k] = gdUnder[k].concat(gd[k]);
    for (const i of gd.idx) gdUnder.idx.push(i + base);
    const m = gdUnder.mesh(groundDecalMat); m.renderOrder = -5; statics.add(m);
  }
  // sector numbers along the perimeter wall
  for (let i = 0; i < 8; i++) {
    const side = i % 4, k = i < 4 ? -30 : 30, r = wallAtlas.rects[`num${i}`], hw = 2.6, hh = 1.2, e = H - 0.02;
    if (side === 0) wd.quad(V(k, 3.4, -e), V(hw, 0, 0), V(0, hh, 0), r);
    if (side === 1) wd.quad(V(e, 3.4, k), V(0, 0, hw), V(0, hh, 0), r);
    if (side === 2) wd.quad(V(k, 3.4, e), V(-hw, 0, 0), V(0, hh, 0), r);
    if (side === 3) wd.quad(V(-e, 3.4, k), V(0, 0, -hw), V(0, hh, 0), r);
  }
  statics.add(wd.mesh(wallDecalMat));

  // ---- 5. beyond the wall: container yard, cranes, light masts, skyline --------------
  { // container stacks (instanced)
    const g = new Batch().box(0, 0, 0, 6, 2.6, 2.4).build();
    const N = 150, inst = new THREE.InstancedMesh(g, M.containerCream, N);
    const cols = [0x9c4a2a, 0x24364f, 0x1f8a8c, 0xd98a1f, 0xd9cfb8, 0x6b2f2a, 0x3d5a45, 0x8c8f93].map((h) => new THREE.Color(h));
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), r2 = rng(77); let n = 0;
    const yawQ = (a) => q.setFromAxisAngle(V(0, 1, 0), a);
    for (let side = 0; side < 4 && n < N; side++) {
      for (let row = 0; row < 2; row++) for (let k = -5; k <= 5 && n < N; k++) {
        if (r2() < 0.3) continue;
        const along = k * 13 + (r2() - 0.5) * 3, off = H + 7 + row * 5 + r2() * 1.2, stack = 2 + Math.floor(r2() * 4);
        for (let s = 0; s < stack && n < N; s++) {
          const x = side === 0 ? along : side === 1 ? off : side === 2 ? along : -off;
          const z = side === 0 ? -off : side === 1 ? along : side === 2 ? off : along;
          m4.compose(V(x + (r2() - 0.5) * 0.3, 1.3 + s * 2.6, z + (r2() - 0.5) * 0.3), yawQ(side % 2 ? Math.PI / 2 : 0), V(1, 1, 1));
          inst.setMatrixAt(n, m4); inst.setColorAt(n, cols[Math.floor(r2() * cols.length)]); n++;
        }
      }
    }
    inst.count = n; inst.instanceMatrix.needsUpdate = true; if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = false; inst.receiveShadow = false; inst.frustumCulled = false; inst.matrixAutoUpdate = false;
    statics.add(inst);
  }
  const beacons = new Batch();
  const crane = (cx, cz, rot, span, hgt) => { // gantry crane
    const b = new Batch(), leg = 0.9;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) b.box(sx * span / 2, hgt / 2, sz * 6, leg, hgt, leg, 0.3);
      b.box(sx * span / 2, hgt * 0.45, 0, 0.5, 0.5, 12, 0.3); b.box(sx * span / 2, hgt - 1, 0, 0.7, 0.7, 12, 0.3); b.box(sx * span / 2, 0.6, 0, 1.4, 1.2, 14, 0.3);
    }
    for (const sz of [-1, 1]) b.box(-span * 0.12, hgt + 1.2, sz * 3.2, span * 1.5, 2.2, 0.9, 0.3);
    for (let i = -4; i <= 6; i++) b.box(i * span * 0.12 - span * 0.12 + span * 0.06, hgt + 1.2, 0, 0.3, 0.3, 6.4, 0.3);
    b.box(span * 0.18, hgt + 3.2, 0, 4, 2.4, 5, 0.3); b.box(span * 0.18, hgt - 6, 0, 0.12, 14, 0.12, 0.3); b.box(span * 0.18, hgt - 13.4, 0, 6.2, 0.5, 2.6, 0.3);
    b.box(-span * 0.5, hgt + 6, 0, 0.6, 9, 0.6, 0.3);
    const m = b.mesh(M.amber, { cast: false, receive: false });
    m.position.set(cx, 0, cz); m.rotation.y = rot; m.updateMatrix(); statics.add(m);
    const top = V(-span * 0.5, hgt + 10.7, 0).applyAxisAngle(V(0, 1, 0), rot).add(V(cx, 0, cz));
    beacons.box(top.x, top.y, top.z, 0.5, 0.5, 0.5);
  };
  crane(H + 22, -24, Math.PI / 2, 26, 30); crane(-H - 20, 30, Math.PI / 2, 24, 26); crane(-30, -H - 24, 0, 28, 34);
  for (const [x, z] of [[H + 5, H + 5], [-H - 5, H + 5], [H + 5, -H - 5], [-H - 5, -H - 5], [0, H + 6], [H + 6, 0], [-H - 6, 0], [0, -H - 6]]) { // light masts
    trim.box(x, 12, z, 0.45, 24, 0.45, 0.3); trim.box(x, 24.2, z, 3.2, 0.3, 0.5, 0.3); trim.box(x, 24.2, z, 0.5, 0.3, 3.2, 0.3);
    const dx = -Math.sign(x) * 0.5, dz = -Math.sign(z) * 0.5;
    for (const o of [-1.2, 0, 1.2]) { glowW.box(x + o, 23.85, z + dz, 0.7, 0.4, 0.7); glowW.box(x + dx, 23.85, z + o, 0.7, 0.4, 0.7); }
  }
  addStatic(conc, M.concreteDark, { cast: true }); addStatic(trim, M.trim, { cast: true });
  addStatic(glowW, M.glowWhite); addStatic(glowA, M.glowAmber); addStatic(yellow, M.amber);

  { // skyline: one instanced mesh, facade + lit windows drawn in the shader
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.0 });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vSky;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 skSc = vec3( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ), length( instanceMatrix[ 2 ].xyz ) );
          vSky = vec3( uv.x * ( abs( normal.x ) > 0.5 ? skSc.z : skSc.x ), uv.y * skSc.y, abs( normal.y ) > 0.5 ? -1.0 : floor( fract( instanceMatrix[ 3 ].x * 0.137 + instanceMatrix[ 3 ].z * 0.719 ) * 90.0 ) + 10.0 + normal.x * 3.0 + normal.z * 7.0 );`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
          varying vec3 vSky;
          float skHash( vec2 p ) { p = fract( p * vec2( 0.1031, 0.1030 ) ); p += dot( p, p.yx + 33.33 ); return fract( ( p.x + p.y ) * p.y ); }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          vec3 skEmit = vec3( 0.0 );
          float skStyle = skHash( vec2( floor( vSky.z + 0.5 ), 1.0 ) );
          vec2 skG = vSky.xy / vec2( mix( 2.6, 5.0, skStyle ), 3.8 );
          float skAA = clamp( 1.3 - max( fwidth( skG.x ), fwidth( skG.y ) ) * 2.2, 0.0, 1.0 );
          if ( vSky.z >= 0.0 ) {
            vec2 skCell = floor( skG ), skF = fract( skG );
            float skWin = smoothstep( 0.08, 0.14, skF.x ) * smoothstep( 0.92, 0.86, skF.x ) * smoothstep( 0.22, 0.28, skF.y ) * smoothstep( 0.86, 0.8, skF.y );
            skWin = mix( skWin, smoothstep( 0.22, 0.28, skF.y ) * smoothstep( 0.86, 0.8, skF.y ), step( 0.7, skStyle ) ) * skAA; // some towers have ribbon glazing
            float skR = skHash( skCell + vSky.z ), skFloor = skHash( vec2( skCell.y, vSky.z ) );
            float skLit = step( 0.94 - 0.22 * step( 0.8, skFloor ), skR );
            vec3 skCol = mix( vec3( 1.0, 0.66, 0.32 ), vec3( 0.7, 0.88, 1.0 ), step( 0.8, skHash( skCell * 1.7 + 3.1 ) ) );
            diffuseColor.rgb *= mix( 1.0, 0.4, skWin );
            skEmit = skCol * skWin * skLit * ( 0.5 + 1.0 * skR );
            roughnessFactor = mix( roughnessFactor, 0.15, skWin );
          }`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += skEmit;');
    };
    const g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, 0.5, 0);
    const N = 420, inst = new THREE.InstancedMesh(g, mat, N), r3 = rng(99), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    let n = 0;
    const put = (x, y, z, w, h, d, yaw, c) => { if (n >= N) return; m4.compose(V(x, y, z), q.setFromAxisAngle(V(0, 1, 0), yaw), V(w, h, d)); inst.setMatrixAt(n, m4); inst.setColorAt(n, c); n++; };
    const tones = [0x6d737d, 0x7a726a, 0x59616d, 0x857b6e, 0x4c535e, 0x637073, 0x8a8278];
    for (let i = 0; i < 120; i++) {
      const near = i < 26, ang = r3() * Math.PI * 2, dist = near ? H + 65 + r3() * 45 : H + 130 + r3() * 300; // always beyond the wall, however large the site is
      const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist, yaw = r3() * Math.PI;
      const sunAz = Math.atan2(view.sunDir.z, view.sunDir.x), dAz = Math.abs(Math.atan2(Math.sin(ang - sunAz), Math.cos(ang - sunAz)));
      const w = 16 + r3() * 26, d = 16 + r3() * 26; let h = near ? 12 + r3() * 20 : 26 + r3() * r3() * 130 + (dist > 330 ? 30 : 0);
      if (dAz < 0.24) h = Math.min(h, dist * 0.2); // keep the sun disc clear of towers
      col.setHex(tones[Math.floor(r3() * tones.length)]).multiplyScalar(0.75 + r3() * 0.4);
      const kind = r3();
      put(x, 0, z, w, h, d, yaw, col);
      if (!near && kind < 0.4) { // setbacks
        put(x, h, z, w * 0.72, h * (0.12 + r3() * 0.2), d * 0.72, yaw, col);
        if (r3() < 0.5) put(x, h * 1.2, z, w * 0.4, h * 0.14, d * 0.4, yaw, col);
      } else if (!near && kind < 0.6) { // twin slab
        put(x + Math.cos(yaw) * w * 0.3, 0, z - Math.sin(yaw) * w * 0.3, w * 0.5, h * (1.1 + r3() * 0.25), d * 0.8, yaw, col);
      } else if (kind < 0.8) { // plant room + mast
        put(x, h, z, w * 0.4, 4 + r3() * 4, d * 0.5, yaw, col);
      }
      if (!near && h > 90) { const mh = 18 + r3() * 26; put(x, h, z, 1.2, mh, 1.2, yaw, col); beacons.box(x, h + mh + 0.8, z, 1.8, 1.8, 1.8); }
    }
    inst.count = n; inst.instanceMatrix.needsUpdate = true; inst.instanceColor.needsUpdate = true;
    inst.castShadow = false; inst.receiveShadow = false; inst.frustumCulled = false; inst.matrixAutoUpdate = false;
    statics.add(inst);
  }

  addStatic(beacons, new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2a1a, emissiveIntensity: 12, fog: false }));

  // ---- 6. practical light pool --------------------------------------------------------
  const POOL = 4, pool = [];
  for (let i = 0; i < POOL; i++) { const l = new THREE.PointLight(0xffc58a, 0, 10, 1.8); l.castShadow = false; scene.add(l); pool.push({ light: l, lamp: null }); }
  const lampColor = new THREE.Color();
  function assignLamps() {
    const cp = camera.getWorldPosition(V(0, 0, 0));
    const live = lamps.filter((l) => !l.parent || l.parent.parent);
    for (const l of live) l.d = l.pos.distanceTo(cp);
    live.sort((a, b) => a.d - b.d);
    const budget = Math.min(POOL, view.lampBudget ?? POOL);
    const next = live[budget] ? live[budget].d : 60;
    for (let i = 0; i < POOL; i++) {
      const slot = pool[i], lamp = i < budget ? live[i] : null;
      slot.lamp = lamp;
      if (!lamp) { slot.light.intensity = 0; continue; }
      // fade a light out before it is handed to another fixture, so the swap is never visible
      const fade = THREE.MathUtils.clamp((Math.min(next, 46) - lamp.d) / 5, 0, 1);
      slot.light.position.copy(lamp.pos); slot.light.color.set(lamp.color); slot.light.intensity = lamp.intensity * fade;
    }
  }
  assignLamps();

  ctx.events.on('pieceDestroyed', () => { if (view.shadowsDirty) view.shadowsDirty(); });
  // ---- 7. distance culls and the site-wide alarm look ---------------------------------------
  const kids = [...kidGroups.values()];
  const lastCull = new THREE.Vector3(1e9, 0, 0); let frame = 0, alarmOn = false;
  function cullKids(cp) {
    let hidden = 0;
    for (const g of kids) {
      const far = Math.hypot(g.x - cp.x, g.z - cp.z) > g.range;
      if (far !== g.far) { g.far = far; for (const m of g.meshes) m.visible = !far; }
      if (far) hidden += g.meshes.length;
    }
    info.hiddenChildren = hidden;
  }
  const AMBER = new THREE.Color(0xffa53a), RED = new THREE.Color(0xff2a14);
  const info = { children, lamps: lamps.length, dressing: dressing ? dressing.stats : null, hiddenChildren: 0 };
  ctx.decor = { info, dressing };
  return {
    info,
    update(dt) {
      assignLamps();
      if (NODECOR) return;
      if (dressing) {
        dressing.update(dt);
        // as the heat rises the amber site lighting (door lights, parapet strips, gate lamps) goes red and starts to pulse
        const a = dressing.uniforms.alarm.value;
        if (a > 0.004 || alarmOn) {
          alarmOn = a > 0.004;
          M.glowAmber.emissive.lerpColors(AMBER, RED, a);
          M.glowAmber.emissiveIntensity = 5 * (1 + a * (0.35 + 0.65 * Math.sin(ctx.time * 6.5)));
        }
      }
      const cp = camera.position;
      if (frame++ % 20 === 0 || Math.abs(cp.x - lastCull.x) + Math.abs(cp.z - lastCull.z) > 6) { lastCull.copy(cp); cullKids(cp); }
    },
  };
}
