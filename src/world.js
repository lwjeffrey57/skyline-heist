import * as THREE from 'three';
import { createMaterials } from './materials.js';
import { rayAABB } from './core.js';

// Everything solid in the arena is an axis-aligned box. Each box is its own
// mesh + collider, which is what will let us knock pieces out later.

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxGeo(w, h, d, tile = 4) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, (uv.getX(k) * dims[f][0]) / tile, (uv.getY(k) * dims[f][1]) / tile);
    }
  }
  return g;
}

export function createWorld(scene, renderer) {
  const colliders = [];
  // Spatial index: solid pieces are filed under the 8 m grid cells they touch, so collision and ray checks only look
  // at what is nearby. Very large pieces (the ground, the perimeter walls) sit in a short list that is always checked.
  const CELL = 8, grid = new Map(), big = []; let stamp = 0;
  const cellKey = (cx, cz) => (cx + 2048) * 4096 + (cz + 2048);
  const eachCell = (c, fn) => { for (let cx = Math.floor(c.min.x / CELL); cx <= Math.floor(c.max.x / CELL); cx++) for (let cz = Math.floor(c.min.z / CELL); cz <= Math.floor(c.max.z / CELL); cz++) fn(cellKey(cx, cz)); };
  function indexAdd(c) {
    if (c.max.x - c.min.x > 48 || c.max.z - c.min.z > 48) { c._big = true; big.push(c); return; }
    eachCell(c, (k) => { let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(c); });
  }
  function indexRemove(c) {
    if (c._big) { const i = big.indexOf(c); if (i >= 0) big.splice(i, 1); return; }
    eachCell(c, (k) => { const l = grid.get(k); if (!l) return; const i = l.indexOf(c); if (i >= 0) l.splice(i, 1); });
  }
  const pads = [];
  const ziplines = [];
  const M = createMaterials(renderer);
  // The layout is rolled fresh on every page load (add ?seed=123 to the address to pin one).
  const seedParam = /[?&]seed=(\d+)/.exec(typeof location !== 'undefined' ? location.search : '');
  const seed = seedParam ? Number(seedParam[1]) >>> 0 : (Math.random() * 4294967296) >>> 0;
  const rand = rng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const jit = (r) => (rand() * 2 - 1) * r;

  // y is the BOTTOM of the box.
  // opts: solid (collides), shadow, tag (what kind of piece), destructible, attachTo (a piece's mesh:
  // the new mesh becomes its child, so it disappears with that piece).
  function addBox(cx, y, cz, w, h, d, mat, { solid = true, shadow = true, tag = 'prop', destructible = false, attachTo = null } = {}) {
    const mesh = new THREE.Mesh(boxGeo(w, h, d), mat);
    mesh.position.set(cx, y + h / 2, cz);
    mesh.castShadow = shadow; mesh.receiveShadow = true;
    if (attachTo) { mesh.position.sub(attachTo.position); attachTo.add(mesh); } else scene.add(mesh);
    if (solid) {
      const c = {
        min: new THREE.Vector3(cx - w / 2, y, cz - d / 2),
        max: new THREE.Vector3(cx + w / 2, y + h, cz + d / 2),
        mesh, tag, destructible, mat,
      };
      mesh.userData.collider = c;
      colliders.push(c); indexAdd(c);
    }
    return mesh;
  }
  const B = (tag) => ({ tag, destructible: true }); // building piece

  // ---- ground -------------------------------------------------------------
  const ARENA = 160; // half-size of the whole walled site (320 m across)
  const CORE = 70;   // half-size of the built-up centre; the ring outside it is open approach ground
  {
    const g = new THREE.PlaneGeometry(900, 900);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 225, uv.getY(i) * 225);
    const ground = new THREE.Mesh(g, M.ground);
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    scene.add(ground);
    colliders.push({ min: new THREE.Vector3(-450, -5, -450), max: new THREE.Vector3(450, 0, 450), mesh: ground, tag: 'ground', destructible: false, mat: M.ground });
    indexAdd(colliders[colliders.length - 1]);
  }
  // painted ground markings
  const mark = (x, z, w, d, mat = M.paint) => addBox(x, 0.005, z, w, 0.012, d, mat, { solid: false, shadow: false });
  for (let i = -3; i <= 3; i++) mark(i * 6, 44, 0.25, 9);
  mark(0, 39.4, 36.3, 0.25); mark(0, 12, 30, 0.3); mark(0, -12, 30, 0.3); mark(-15, 0, 0.3, 24); mark(15, 0, 0.3, 24);

  // ---- perimeter ----------------------------------------------------------
  const W = ARENA * 2;
  addBox(0, 0, -ARENA - 0.5, W + 2, 7, 1, M.concreteDark);
  addBox(0, 0, ARENA + 0.5, W + 2, 7, 1, M.concreteDark);
  addBox(-ARENA - 0.5, 0, 0, 1, 7, W, M.concreteDark);
  addBox(ARENA + 0.5, 0, 0, 1, 7, W, M.concreteDark);
  for (const s of [-1, 1]) { // glowing cap strips
    addBox(0, 7, s * (ARENA + 0.5), W, 0.12, 0.3, M.glowTeal, { solid: false, shadow: false });
    addBox(s * (ARENA + 0.5), 7, 0, 0.3, 0.12, W, M.glowTeal, { solid: false, shadow: false });
  }

  // ---- buildings ----------------------------------------------------------
  const FH = 3.6, T = 0.3, SLAB = 0.3;

  function wallRun(alongX, fixed, from, to, y0, groundFloor, accent) {
    const len = to - from;
    const n = Math.max(1, Math.round(len / 4));
    const mw = len / n;
    const doorAt = Math.floor(n / 2);
    for (let i = 0; i < n; i++) {
      const c = from + mw * (i + 0.5);
      const put = (off, y, w, h, mat, tag) => (alongX
        ? addBox(c + off, y0 + y, fixed, w, h, T, mat, B(tag))
        : addBox(fixed, y0 + y, c + off, T, h, w, mat, B(tag)));
      let type = rand() < 0.3 ? 'solid' : 'window';
      if (groundFloor && i === doorAt) type = 'door';
      if (type === 'solid') { put(0, 0, mw, FH, rand() < 0.5 ? accent : M.concrete, 'wall'); continue; }
      const P = 0.5, open = mw - P * 2;
      put(-mw / 2 + P / 2, 0, P, FH, M.concrete, 'pillar');
      put(mw / 2 - P / 2, 0, P, FH, M.concrete, 'pillar');
      const lintel = put(0, 2.5, open, FH - 2.5, M.concrete, 'lintel');
      if (type === 'window') put(0, 0, open, 1.0, accent, 'sill');
      else if (alongX) addBox(c, y0 + 2.42, fixed, open, 0.08, T + 0.06, M.glowAmber, { solid: false, shadow: false, attachTo: lintel });
      else addBox(fixed, y0 + 2.42, c, T + 0.06, 0.08, open, M.glowAmber, { solid: false, shadow: false, attachTo: lintel });
    }
  }

  const buildings = [];
  const lod = []; // per building: the interior meshes that need not be drawn from far away
  // where a building's stair core goes: the middle, a corner, or one end of the floor. Returns its centre.
  function stairSpot(x, z, w, d, mode) {
    const sx = rand() < 0.5 ? -1 : 1, sz = rand() < 0.5 ? -1 : 1;
    if (mode === 'corner') return [x + sx * (w / 2 - 4.5), z + sz * (d / 2 - 3.6)];
    if (mode === 'endX') return [x + sx * (w / 2 - 4.5), z];
    if (mode === 'endZ') return [x, z + sz * (d / 2 - 3.6)];
    return [x, z];
  }
  const anyStair = () => { const r = rand(); return r < 0.25 ? 'centre' : r < 0.6 ? 'corner' : r < 0.8 ? 'endX' : 'endZ'; };
  function building(x, z, w, d, floors, accent, stair = 'centre') {
    const first = colliders.length;
    const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2;
    const [cx, cz] = stairSpot(x, z, w, d, stair);
    const hx0 = cx - 2.7, hx1 = cx + 2.7;
    for (let f = 0; f < floors; f++) {
      const y0 = f * FH;
      wallRun(true, z0 + T / 2, x0, x1, y0, f === 0, accent);
      wallRun(true, z1 - T / 2, x0, x1, y0, f === 0, accent);
      wallRun(false, x0 + T / 2, z0 + T, z1 - T, y0, f === 0, accent);
      wallRun(false, x1 - T / 2, z0 + T, z1 - T, y0, f === 0, accent);

      // U-turn stairs: even floors climb +x in lane A, odd floors climb -x in lane B.
      const lane = f % 2;
      const lz0 = lane === 0 ? cz - 1.7 : cz + 0.1, lz1 = lz0 + 1.6;
      const steps = 15, rise = FH / steps, run = (hx1 - hx0) / steps;
      for (let s = 0; s < steps; s++) {
        const sx = lane === 0 ? hx0 + run * (s + 0.5) : hx1 - run * (s + 0.5);
        addBox(sx, y0, (lz0 + lz1) / 2, run, rise * (s + 1), lz1 - lz0, M.concreteDark, B('stair'));
      }
      // ceiling slab with a hole over this floor's stair lane
      const sy = y0 + FH - SLAB, ix0 = x0 + T, ix1 = x1 - T, iz0 = z0 + T, iz1 = z1 - T;
      const slab = (ax0, ax1, az0, az1) => {
        if (ax1 - ax0 < 0.01 || az1 - az0 < 0.01) return;
        addBox((ax0 + ax1) / 2, sy, (az0 + az1) / 2, ax1 - ax0, SLAB, az1 - az0, M.slab, B('slab'));
      };
      slab(ix0, hx0, iz0, iz1); slab(hx1, ix1, iz0, iz1);
      slab(hx0, hx1, iz0, lz0); slab(hx0, hx1, lz1, iz1);
    }
    // roof parapet
    const ry = floors * FH;
    const front = addBox(x, ry, z0 + T / 2, w, 1.0, T, M.concrete, B('parapet'));
    addBox(x, ry, z1 - T / 2, w, 1.0, T, M.concrete, B('parapet'));
    addBox(x0 + T / 2, ry, z, T, 1.0, d - T * 2, M.concrete, B('parapet'));
    addBox(x1 - T / 2, ry, z, T, 1.0, d - T * 2, M.concrete, B('parapet'));
    addBox(x, ry + 1.0, z0 + T / 2, w, 0.06, T + 0.04, accent === M.teal ? M.glowTeal : M.glowAmber, { solid: false, shadow: false, attachTo: front });
    buildings.push({ x, z, w, d, floors, floorHeight: FH, wallThickness: T, roofY: ry, accent, stairAt: [cx, cz], keep: stair === 'centre' ? null : [[cx - 4.4, cx + 4.4, cz - 3.3, cz + 3.3]] });
    lod.push({ x, z, far: false, meshes: colliders.slice(first).filter((c) => c.tag === 'stair' || (c.tag === 'slab' && c.max.y < ry - 0.1)).map((c) => c.mesh) });
    return ry;
  }

  // four core blocks keep their footprints (the jump pads and ziplines are built around them) but vary in height and colour
  const ACCENTS = [M.teal, M.amber, M.navy, M.cream, M.rust];
  const roofA = building(-28, -10, 20, 16, rand() < 0.65 ? 3 : 2, pick(ACCENTS));
  const roofB = building(26, -18, 16, 14, 1 + Math.floor(rand() * 3), pick(ACCENTS));
  building(22, 26, 14, 12, 1 + Math.floor(rand() * 2), pick(ACCENTS));
  const roofD = building(-30, 32, 12, 12, 1 + Math.floor(rand() * 2), pick(ACCENTS));
  // outer ring: each raid a different set of lots is built on, with different sizes and heights
  {
    const LOTS = [[-48, -42, 12, 12], [48, 46, 14, 12], [50, -12, 12, 12], [-50, -8, 12, 10], [-24, 48, 12, 10], [24, -50, 12, 10], [-50, 26, 12, 10]];
    const order = LOTS.map((l) => [rand(), l]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    const count = 4 + Math.floor(rand() * 3); // 4 to 6 of the 7 lots
    for (const [x, z, mw, md] of order.slice(0, count)) {
      building(x + jit(1), z + jit(1), rand() < 0.5 ? mw : 12, rand() < 0.5 ? md : 10, rand() < 0.45 ? 1 : 2, pick(ACCENTS), anyStair());
    }
  }

  // rooftop units
  addBox(-33, roofA, -14, 3, 1.6, 2.4, M.metal, { tag: 'prop', destructible: true });
  addBox(31, roofB, -22, 2.4, 1.4, 2.4, M.metal, { tag: 'prop', destructible: true });

  // ---- central plaza ------------------------------------------------------
  addBox(0, 0, 0, 14, 1.0, 14, M.slab);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      addBox(0, 0, s * (7 + 0.2 + i * 0.4), 6, 0.75 - i * 0.25, 0.4, M.concreteDark);
      addBox(s * (7 + 0.2 + i * 0.4), 0, 0, 0.4, 0.75 - i * 0.25, 6, M.concreteDark);
    }
  }
  // the strongroom: a sealed bunker on the plaza. Its walls cannot be breached; the door opens with a keycard (raid.js)
  let strongroom = null;
  {
    const Y = 1.0, H = 3.0, T = 0.4, tag = { tag: 'bunker' };
    addBox(0, Y, -2.8, 8, H, T, M.concreteDark, tag);                       // north wall
    addBox(-3.8, Y, 0, T, H, 5.2, M.concreteDark, tag); addBox(3.8, Y, 0, T, H, 5.2, M.concreteDark, tag); // west, east
    addBox(-2.4, Y, 2.8, 3.2, H, T, M.concreteDark, tag); addBox(2.4, Y, 2.8, 3.2, H, T, M.concreteDark, tag); // south, either side of the door
    addBox(0, Y + 2.3, 2.8, 1.6, H - 2.3, T, M.concreteDark, tag);          // lintel
    addBox(0, Y + H, 0, 8.4, 0.3, 6.4, M.slab, tag);                        // roof
    addBox(0, Y + H + 0.3, 2.9, 8.4, 0.1, 0.2, M.glowAmber, { solid: false, shadow: false });
    addBox(0, Y + H - 0.08, 0, 3, 0.06, 0.2, M.glowAmber, { solid: false, shadow: false }); // light strip inside
    const door = addBox(0, Y, 2.8, 1.6, 2.3, 0.24, M.metal, { tag: 'door' });
    addBox(0, Y + 1.15, 2.93, 1.2, 0.08, 0.02, M.glowAmber, { solid: false, shadow: false, attachTo: door });
    strongroom = { door: door.userData.collider, x: 0, y: Y, z: 2.8, open: false, inside: [[-2.3, Y, -1.5], [2.2, Y, -1.4]] };
  }
  addBox(-4.5, 1.0, -4.5, 3, 1.1, 0.4, M.concrete);
  addBox(4.5, 1.0, 4.5, 3, 1.1, 0.4, M.concrete);

  // ---- cover, containers, climbables --------------------------------------
  const blocked = (x0, x1, z0, z1, m, ignore) => colliders.some((c) => c.tag !== 'ground' && c.tag !== ignore && x0 - m < c.max.x && x1 + m > c.min.x && z0 - m < c.max.z && z1 + m > c.min.z);
  const container = (x, y, z, alongX, mat) => {
    const w = alongX ? 6.0 : 2.4, d = alongX ? 2.4 : 6.0;
    if (blocked(x - w / 2, x + w / 2, z - d / 2, z + d / 2, 0.6, 'container')) return null;
    return addBox(x, y, z, w, 2.6, d, mat, { tag: 'container' });
  };
  // container groups: [ground containers..., optional stacked one]; each group appears most raids, shifted a little
  const CONTAINER_MATS = [M.rust, M.navy, M.teal, M.amber, M.cream];
  for (const group of [
    [[-8, 0, 30, true], [-3.5, 0, 33, false], [-8, 2.6, 30.4, true]],
    [[40, 0, 6, false], [43, 0, 4, false], [41.5, 2.6, 5, false]],
    [[-52, 0, 8, true], [-50, 0, 12, true]],
    [[6, 0, -40, true], [14, 0, -42, false], [8, 2.6, -40, true]],
    [[-10, 0, -44, false]],
  ]) {
    if (rand() < 0.2) continue;
    const dx = jit(2), dz = jit(2); let base = null;
    for (const [x, y, z, alongX] of group) {
      if (y > 0 && (!base || rand() < 0.4)) continue; // stacked container only on a placed base, and not always
      const m = container(x + dx, y, z + dz, alongX, pick(CONTAINER_MATS));
      if (y === 0 && m && !base) base = m;
    }
  }
  for (const [x, z, w, d] of [[-14, 18, 5, 0.4], [14, 16, 0.4, 5], [12, -8, 5, 0.4], [-12, -26, 0.4, 5], [36, 40, 5, 0.4], [-46, -34, 5, 0.4], [50, -38, 0.4, 6], [-56, 50, 6, 0.4], [0, 56, 8, 0.4]]) {
    if (rand() < 0.3 || blocked(x - w / 2, x + w / 2, z - d / 2, z + d / 2, 1.0)) continue;
    addBox(x, 0, z, w, 1.2, d, M.concrete, { tag: 'cover', destructible: true });
  }
  // extra cover so crossing open ground is survivable: low barriers (b), tall slabs (s) and blocks (k).
  // Anything that would overlap existing geometry, a jump pad, a spawn point or a zipline landing is skipped.
  {
    const KEEP = [[-13, -10, 3.5], [13, -18, 3.5], [-30, 21.5, 3.5], [0, 22, 3.5], [52, 30, 3.5], [-3, 9.5, 2.5], [46, 20, 2.5],
      [0, 50, 2.5], [-48, 58, 2.5], [48, 58, 2.5], [-62, 20, 2.5], [62, 22, 2.5], [-62, -20, 2.5], [62, -10, 2.5], [-40, -60, 2.5], [0, -60, 2.5], [36, -60, 2.5], [-20, 60, 2.5], [26, 46, 2.5]];
    const SIZE = { b: [3.4, 1.15, 0.6], s: [3.0, 2.3, 0.5], k: [1.8, 1.4, 1.8] };
    const SPOTS = [
      [-6, 44, 'b', 0], [7, 41, 's', 0], [-10, 37, 'k', 0], [9, 33, 'b', 0], [4, 28, 's', 1], [11, 25, 'k', 0],
      [-45, 45, 's', 0], [-44, 30, 'b', 1], [-48, 20, 's', 1], [-42, 8, 'b', 0], [-46, -4, 's', 0], [-45, -20, 'b', 1], [-50, -46, 'b', 0], [-30, -30, 's', 0], [-24, -40, 'b', 0], [-30, -52, 's', 1],
      [44, 48, 'b', 0], [40, 33, 's', 1], [56, 14, 'b', 0], [52, -4, 's', 1], [44, -16, 'b', 0], [42, -28, 's', 0], [30, -36, 'b', 1], [24, -50, 's', 0], [56, -24, 'b', 1],
      [-15, 6, 'b', 1], [15, 3, 'b', 1], [-6, -17, 's', 0], [7, 14, 'k', 0], [-17, 29, 's', 0], [10, -29, 'b', 0], [0, -31, 's', 0], [-2, -50, 'b', 0], [21, 8, 's', 1], [34, 10, 'k', 0], [-20, 46, 'b', 0], [18, 43, 'b', 1], [32, 56, 's', 0], [-34, 55, 'k', 0], [-22, -24, 'k', 0], [36, -4, 'b', 0],
    ];
    for (const [sx, sz, type, rot0] of SPOTS) {
      if (rand() < 0.25) continue; // a quarter of the cover is missing each raid, and the rest shifts and turns
      const x = sx + jit(2.5), z = sz + jit(2.5), rot = rand() < 0.3 ? !rot0 : rot0;
      const [w0, h, d0] = SIZE[type], bw = rot ? d0 : w0, bd = rot ? w0 : d0;
      const x0 = x - bw / 2, x1 = x + bw / 2, z0 = z - bd / 2, z1 = z + bd / 2, m = 1.1;
      if (colliders.some((c) => c.tag !== 'ground' && x0 - m < c.max.x && x1 + m > c.min.x && z0 - m < c.max.z && z1 + m > c.min.z)) continue;
      if (KEEP.some(([px, pz, r]) => px > x0 - r && px < x1 + r && pz > z0 - r && pz < z1 + r)) continue;
      addBox(x, 0, z, bw, h, bd, type === 'k' ? M.concreteDark : M.concrete, { tag: 'cover', destructible: true });
    }
  }

  // ---- outer ring: open ground between the wall and the built-up centre. You deploy at its edge, out of the fight.
  const E = ARENA - 8;
  const spawnPoints = [[0, E], [-90, E], [90, E], [-E, 60], [E, 60], [-E, -60], [E, -60], [-90, -E], [0, -E], [90, -E], [-E, 0], [E, 0]];
  const exitPoints = [[-E, 105], [E, -80], [0, -E], [E, 110], [-E, -85]];
  const outbuildings = [], roads = [], compoundWalls = [], towerZips = [];
  // ---- the compound's bones: an inner wall with gates around the centre, and roads from the outer wall to those gates
  {
    const IW = CORE + 3, PANELS = 18, plen = (IW * 2) / PANELS, WH = 4.2;
    const GATES = { n: [0, 38], s: [0, -38], e: [0], w: [0] }; // gate centres along each side
    const side = (name, fixed, alongX) => {
      for (let k = 0; k < PANELS; k++) {
        const c = -IW + plen * (k + 0.5), gate = GATES[name].some((g) => Math.abs(c - g) < plen * 0.55);
        if (gate) continue; // an open gateway, one panel wide
        const m = alongX ? addBox(c, 0, fixed, plen, WH, 0.4, M.concrete, { tag: 'wall', destructible: true }) : addBox(fixed, 0, c, 0.4, WH, plen, M.concrete, { tag: 'wall', destructible: true });
        compoundWalls.push(m.userData.collider);
      }
      for (const gc of GATES[name]) for (const s of [-1, 1]) { // gate posts with a light on top
        const p = gc + s * plen * 0.56, x = alongX ? p : fixed, z = alongX ? fixed : p;
        addBox(x, 0, z, 0.9, WH + 0.6, 0.9, M.concreteDark, { tag: 'post' });
        addBox(x, WH + 0.6, z, 0.5, 0.12, 0.5, M.glowAmber, { solid: false, shadow: false });
      }
    };
    side('n', -IW, true); side('s', IW, true); side('w', -IW, false); side('e', IW, false);
    // roads: paved lanes kept clear of clutter, so they are the quick way in and the exposed one
    const road = (x, z, wd, dp) => { roads.push([x - wd / 2, x + wd / 2, z - dp / 2, z + dp / 2]); addBox(x, 0.004, z, wd, 0.012, dp, M.concreteDark, { solid: false, shadow: false }); };
    const mid = (IW + ARENA) / 2, len = ARENA - IW;
    road(0, -mid, 7, len); road(0, mid, 7, len); road(-mid, 0, len, 7); road(mid, 0, len, 7);
    const RR = 128; // the ring road runs outside the outposts' yards
    road(38, -(IW + RR) / 2, 6, RR - IW + 3); road(-38, (IW + RR) / 2, 6, RR - IW + 3); // spurs from the side gates to the ring road
    road(0, -RR, RR * 2 + 6, 6); road(0, RR, RR * 2 + 6, 6); road(-RR, 0, 6, RR * 2 + 6); road(RR, 0, 6, RR * 2 + 6);
    for (let d = IW + 6; d < ARENA - 4; d += 12) { mark(0, -d, 0.25, 4); mark(0, d, 0.25, 4); mark(-d, 0, 4, 0.25); mark(d, 0, 4, 0.25); }
  }
  const onRoad = (x0, x1, z0, z1) => roads.some(([a, b, c, d]) => x0 < b && x1 > a && z0 < d && z1 > c);
  {
    const keepClear = spawnPoints.concat(exitPoints);
    const clearOf = (x0, x1, z0, z1, r) => !keepClear.some(([px, pz]) => px > x0 - r && px < x1 + r && pz > z0 - r && pz < z1 + r);
    // a few small sheds: cover on the way in, but no guards are posted in them and they hold no lockers
    for (const [x, z] of [[-140, -106], [140, 20], [48, -141], [-54, 141], [136, -120], [-140, 96], [10, 140], [-136, -20]]) {
      if (rand() < 0.45 || !clearOf(x - 6, x + 6, z - 5, z + 5, 6)) continue;
      building(x + jit(1), z + jit(1), 12, 10, 1, pick(ACCENTS), anyStair());
      outbuildings.push(buildings.pop());
    }
    // outposts: guarded buildings out in the ring, each with its own loot, so the site has more than one place worth raiding
    const LOTS = [[105, 45], [-105, 45], [105, -45], [-105, -45], [45, 105], [-45, 105], [45, -105], [-45, -105]];
    const order = LOTS.map((l) => [rand(), l]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    const TYPES = ['armoury', 'infirmary', 'signal', 'depot', 'watch'].map((t) => [rand(), t]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    for (const [ox, oz] of order.slice(0, 5)) {
      const x = ox + jit(3), z = oz + jit(3);
      building(x, z, rand() < 0.5 ? 14 : 12, rand() < 0.5 ? 12 : 10, rand() < 0.5 ? 1 : 2, pick(ACCENTS), anyStair()); // stays in `buildings`: guards post here and it gets crates
      buildings[buildings.length - 1].outpost = TYPES.pop(); // each outpost has a purpose (raid.js gives it its contents)
      { // a walled yard with two ways in, so you choose which side to come at it from
        const Y = 14, open = [0, 1, 2, 3].map((i) => [rand(), i]).sort((p, q) => p[0] - q[0]).slice(0, 2).map((p) => p[1]);
        for (let sd = 0; sd < 4; sd++) for (const half of [-1, 1]) {
          if (open.includes(sd) && half === 1) continue; // half of this side is left open as an entrance
          const c = half * Y / 2, alongX = sd < 2, fixed = (sd % 2 ? 1 : -1) * Y;
          const m = alongX ? addBox(x + c, 0, z + fixed, Y, 1.7, 0.35, M.concrete, { tag: 'cover', destructible: true }) : addBox(x + fixed, 0, z + c, 0.35, 1.7, Y, M.concrete, { tag: 'cover', destructible: true });
          compoundWalls.push(m.userData.collider);
        }
      }
      for (let k = 0; k < 5; k++) {
        const a = rand() * Math.PI * 2, d = 9 + rand() * 4, cx = x + Math.cos(a) * d, cz = z + Math.sin(a) * d, cont = rand() < 0.4, alongX = rand() < 0.5; // inside the yard
        const bw = cont ? (alongX ? 6 : 2.4) : (alongX ? 3.4 : 0.6), bd = cont ? (alongX ? 2.4 : 6) : (alongX ? 0.6 : 3.4);
        if (blocked(cx - bw / 2, cx + bw / 2, cz - bd / 2, cz + bd / 2, 1.2)) continue;
        addBox(cx, 0, cz, bw, cont ? 2.6 : 1.15, bd, cont ? pick([M.rust, M.navy, M.teal, M.amber, M.cream]) : M.concrete, { tag: cont ? 'container' : 'cover', destructible: !cont });
      }
    }
    // tower blocks: two of the lots the outposts did not take get a large multi-storey building with rooms on every
    // floor, and a zipline from its roof down into the centre
    const tower = (x, z, W2, D2, floors) => {
      building(x, z, W2, D2, floors, pick(ACCENTS), rand() < 0.3 ? 'centre' : 'endZ'); // towers keep their stairs between the partition walls: in the middle or at one end
      const b = buildings[buildings.length - 1]; b.tower = true;
      const sc = b.stairAt[1] - z; // partition doorways line up with wherever the stair core is
      const h = D2 / 2 - 0.3, px = Math.round(W2 / 3.2);
      for (let f = 0; f < floors; f++) for (const sx of [-1, 1]) for (const [z0, z1] of (Math.abs(sc) < 0.1 ? [[-h, -4.1], [-2.3, 2.3], [4.1, h]] : sc < 0 ? [[-h + 6.2, -1.2], [1.2, h]] : [[-h, -1.2], [1.2, h - 6.2]])) // partition walls with doorways, either side of the stair core
        lod[lod.length - 1].meshes.push(addBox(x + sx * px, f * FH, z + (z0 + z1) / 2, 0.25, FH - SLAB, z1 - z0, M.concrete, B('wall')));
      const dl = Math.hypot(x, z) || 1, dx = -x / dl, dz = -z / dl; // toward the middle of the compound
      for (const reach of [50, 42, 34]) {
        const ex = x + dx * reach, ez = z + dz * reach;
        if (blocked(ex - 0.6, ex + 0.6, ez - 0.6, ez + 0.6, 1.5) || onRoad(ex - 1, ex + 1, ez - 1, ez + 1)) continue;
        towerZips.push([new THREE.Vector3(x + dx * (W2 / 2 - 3), b.roofY + 3.4, z + dz * (D2 / 2 - 2.5)), new THREE.Vector3(ex, 5.6, ez), b.roofY]); break;
      }
    };

    // ---- larger building types ------------------------------------------------
    // a straight flight of U-turn stairs for floor f, centred on (cx, cz); returns the hole it needs in the slab above
    const stairFlight = (cx, cz, f) => {
      const y0 = f * FH, hx0 = cx - 2.7, hx1 = cx + 2.7, lane = f % 2, lz0 = lane === 0 ? cz - 1.7 : cz + 0.1, lz1 = lz0 + 1.6;
      const steps = 15, rise = FH / steps, run = (hx1 - hx0) / steps;
      for (let st = 0; st < steps; st++) addBox(lane === 0 ? hx0 + run * (st + 0.5) : hx1 - run * (st + 0.5), y0, (lz0 + lz1) / 2, run, rise * (st + 1), lz1 - lz0, M.concreteDark, B('stair'));
      return [hx0, hx1, lz0, lz1];
    };
    // a floor slab over [ax0..ax1] x [az0..az1] at height sy with rectangular holes cut out of it
    const slabWithHoles = (ax0, ax1, az0, az1, sy, holes) => {
      const xs = [ax0, ax1], zs = [az0, az1];
      for (const [hx0, hx1, hz0, hz1] of holes) { xs.push(Math.max(ax0, Math.min(ax1, hx0)), Math.max(ax0, Math.min(ax1, hx1))); zs.push(Math.max(az0, Math.min(az1, hz0)), Math.max(az0, Math.min(az1, hz1))); }
      xs.sort((a, b) => a - b); zs.sort((a, b) => a - b);
      const inHole = (x, z) => holes.some(([hx0, hx1, hz0, hz1]) => x > hx0 && x < hx1 && z > hz0 && z < hz1);
      for (let j = 0; j < zs.length - 1; j++) {
        if (zs[j + 1] - zs[j] < 0.01) continue;
        let start = null; // merge neighbouring cells along x into one piece
        for (let i = 0; i <= xs.length - 1; i++) {
          const open = i < xs.length - 1 && xs[i + 1] - xs[i] >= 0.01 && !inHole((xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2);
          if (open && start === null) start = xs[i];
          if (!open && start !== null && (i === xs.length - 1 || xs[i + 1] - xs[i] >= 0.01)) { addBox((start + xs[i]) / 2, sy, (zs[j] + zs[j + 1]) / 2, xs[i] - start, SLAB, zs[j + 1] - zs[j], M.slab, B('slab')); start = null; }
        }
      }
    };
    const finishLarge = (x, z, W2, D2, floors, first, accent, extra, levels = floors) => {
      const ry = levels * FH, x0 = x - W2 / 2, x1 = x + W2 / 2, z0 = z - D2 / 2, z1 = z + D2 / 2;
      const front = addBox(x, ry, z0 + T / 2, W2, 1.0, T, M.concrete, B('parapet'));
      addBox(x, ry, z1 - T / 2, W2, 1.0, T, M.concrete, B('parapet'));
      addBox(x0 + T / 2, ry, z, T, 1.0, D2 - T * 2, M.concrete, B('parapet'));
      addBox(x1 - T / 2, ry, z, T, 1.0, D2 - T * 2, M.concrete, B('parapet'));
      addBox(x, ry + 1.0, z0 + T / 2, W2, 0.06, T + 0.04, M.glowAmber, { solid: false, shadow: false, attachTo: front });
      const b = { x, z, w: W2, d: D2, floors, floorHeight: FH, wallThickness: T, roofY: ry, accent, tower: true, ...extra };
      buildings.push(b);
      lod.push({ x, z, far: false, meshes: colliders.slice(first).filter((c) => c.tag === 'stair' || c.tag === 'inner' || (c.tag === 'slab' && c.max.y < ry - 0.1)).map((c) => c.mesh) });
      return b;
    };
    // headquarters: a full-scale building. Open ground-floor hall on columns, an atrium through the middle, two stair
    // cores in opposite corners, and on the upper floors rooms along the long sides with galleries round the atrium.
    const headquarters = (x, z, W2, D2, floors) => {
      const first = colliders.length, accent = pick(ACCENTS);
      const x0 = x - W2 / 2, x1 = x + W2 / 2, z0 = z - D2 / 2, z1 = z + D2 / 2, RD = 7;
      const aw = W2 - 20, ad = D2 - 2 * (RD + 6), atrium = [x - aw / 2, x + aw / 2, z - ad / 2, z + ad / 2];
      const cores = [[x0 + 4.5, z0 + 3.6], [x1 - 4.5, z1 - 3.6]];
      const inner = (cx, y, cz, w, h, d, mat = M.concrete) => addBox(cx, y, cz, w, h, d, mat, { tag: 'inner', destructible: true });
      for (let f = 0; f < floors; f++) {
        const y0 = f * FH;
        wallRun(true, z0 + T / 2, x0, x1, y0, f === 0, accent); wallRun(true, z1 - T / 2, x0, x1, y0, f === 0, accent);
        wallRun(false, x0 + T / 2, z0 + T, z1 - T, y0, f === 0, accent); wallRun(false, x1 - T / 2, z0 + T, z1 - T, y0, f === 0, accent);
        const holes = cores.map(([cx, cz]) => stairFlight(cx, cz, f));
        if (f < floors - 1) holes.push(atrium); // the atrium is open up to the top floor's ceiling
        slabWithHoles(x0 + T, x1 - T, z0 + T, z1 - T, y0 + FH - SLAB, holes);
        if (f === 0) { // the hall: rows of columns to fight between
          for (let cx = x0 + 8; cx <= x1 - 8; cx += 7.5) for (const cz of [z0 + RD + 1, z1 - RD - 1]) inner(cx, 0, cz, 0.7, FH - SLAB, 0.7, M.concreteDark);
          for (const sx of [-1, 1]) inner(x + sx * (aw / 2 - 1), 0, z, 0.5, 1.15, Math.min(ad, 6)); // low walls across the middle
        } else {
          // rooms along both long sides: dividers, and a corridor wall with a doorway into each room
          const n = Math.max(3, Math.round(W2 / 9)), rw = (W2 - 2 * T) / n;
          for (const [zw, zmid, dep] of [[z0 + RD, (z0 + T + z0 + RD) / 2, RD - T], [z1 - RD, (z1 - T + z1 - RD) / 2, RD - T]]) {
            for (let i = 1; i < n; i++) inner(x0 + T + rw * i, y0, zmid, 0.25, FH - SLAB, dep);
            for (let i = 0; i < n; i++) { const c = x0 + T + rw * (i + 0.5), seg = (rw - 1.7) / 2; for (const sd of [-1, 1]) inner(c + sd * (0.85 + seg / 2), y0, zw, seg, FH - SLAB, 0.25, i % 2 ? accent : M.concrete); }
          }
          // a waist-high wall round the atrium: cover for fights across the gap
          const [a0, a1, b0, b1] = atrium;
          inner(x, y0, b0 - 0.1, aw + 0.4, 1.05, 0.2, M.concreteDark); inner(x, y0, b1 + 0.1, aw + 0.4, 1.05, 0.2, M.concreteDark);
          inner(a0 - 0.1, y0, z, 0.2, 1.05, ad, M.concreteDark); inner(a1 + 0.1, y0, z, 0.2, 1.05, ad, M.concreteDark);
        }
      }
      const keep = cores.map(([cx, cz]) => [cx - 4.4, cx + 4.4, cz - 3.3, cz + 3.3]).concat([[atrium[0] - 1.2, atrium[1] + 1.2, atrium[2] - 1.2, atrium[3] + 1.2]]);
      return finishLarge(x, z, W2, D2, floors, first, accent, { hq: true, keep });
    };
    // warehouse: one double-height hall with columns, big doors, and a mezzanine round two sides reached by one stair
    const warehouse = (x, z, W2, D2) => {
      const first = colliders.length, accent = pick(ACCENTS);
      const x0 = x - W2 / 2, x1 = x + W2 / 2, z0 = z - D2 / 2, z1 = z + D2 / 2;
      for (let f = 0; f < 2; f++) {
        const y0 = f * FH;
        wallRun(true, z0 + T / 2, x0, x1, y0, f === 0, accent); wallRun(true, z1 - T / 2, x0, x1, y0, f === 0, accent);
        wallRun(false, x0 + T / 2, z0 + T, z1 - T, y0, f === 0, accent); wallRun(false, x1 - T / 2, z0 + T, z1 - T, y0, f === 0, accent);
      }
      const core = [x0 + 4.5, z0 + 3.6];
      const h0 = stairFlight(core[0], core[1], 0), h1 = stairFlight(core[0], core[1], 1);
      // mezzanine: a 4.5 m gallery along the north and west walls; the rest of the hall is open to the roof
      const MZ = 4.5;
      slabWithHoles(x0 + T, x1 - T, z0 + T, z1 - T, FH - SLAB, [h0, [x0 + T + MZ, x1, z0 + T + MZ, z1]]);
      addBox(x + MZ / 2, FH, z0 + T + MZ + 0.1, W2 - MZ - 2 * T, 1.05, 0.2, M.concreteDark, { tag: 'inner', destructible: true });
      addBox(x0 + T + MZ + 0.1, FH, z + MZ / 2, 0.2, 1.05, D2 - MZ - 2 * T, M.concreteDark, { tag: 'inner', destructible: true });
      slabWithHoles(x0 + T, x1 - T, z0 + T, z1 - T, 2 * FH - SLAB, [h1]);
      for (let cx = x0 + MZ + 5; cx <= x1 - 5; cx += 7) for (const cz of [z - D2 / 6 + MZ / 2, z + D2 / 4 + MZ / 4]) addBox(cx, 0, cz, 0.6, 2 * FH - SLAB, 0.6, M.concreteDark, { tag: 'inner', destructible: true });
      return finishLarge(x, z, W2, D2, 1, first, accent, { warehouse: true, keep: [[core[0] - 4.4, core[0] + 4.4, core[1] - 3.3, core[1] + 3.3]] }, 2); // one furnished floor, two storeys tall
    };

    // the three lots the outposts did not take: one gets the headquarters, the others a tall block each
    {
      const spare = order.slice(5, 8), spur = ([lx, lz]) => (lx === 45 && lz === -105) || (lx === -45 && lz === 105); // a road runs through these two
      const hqLot = spare.find((l) => !spur(l)) || spare[0];
      for (const lot of spare) {
        const [ox, oz] = lot;
        if (lot !== hqLot) { tower(ox + jit(2), oz + jit(2), rand() < 0.5 ? 22 : 18, rand() < 0.5 ? 18 : 16, 3 + Math.floor(rand() * 3)); continue; }
        // long side runs along the ring, centre pulled in so it clears the ring road and the inner wall
        const alongZ = Math.abs(ox) > Math.abs(oz), cx = alongZ ? Math.sign(ox) * 100 : ox, cz = alongZ ? oz : Math.sign(oz) * 100;
        headquarters(cx, cz, alongZ ? 34 : 46, alongZ ? 46 : 34, rand() < 0.5 ? 4 : 3);
      }
    }
    // and two long, lower halls in the corners of the site
    const corners = [[110, 110], [-110, 110], [110, -110], [-110, -110]].map((c) => [rand(), c]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    corners.slice(0, 3).forEach(([cx, cz], i) => { if (i === 1) tower(cx + jit(2), cz + jit(2), 28, 18, rand() < 0.5 ? 3 : 4); else warehouse(cx + jit(2), cz + jit(2), i ? 26 : 32, i ? 18 : 22); });
    // scattered barriers, slabs and containers all the way round
    for (let i = 0; i < 260; i++) {
      const side = Math.floor(rand() * 4), along = (rand() * 2 - 1) * (ARENA - 6), depth = CORE + 4 + rand() * (ARENA - CORE - 12);
      const x = side === 0 ? along : side === 1 ? along : side === 2 ? depth : -depth, z = side === 0 ? depth : side === 1 ? -depth : along;
      const kind = rand(); let bw, bh, bd, mat, tag, destructible = true;
      if (kind < 0.2) { const alongX = rand() < 0.5; bw = alongX ? 6 : 2.4; bd = alongX ? 2.4 : 6; bh = 2.6; mat = pick([M.rust, M.navy, M.teal, M.amber, M.cream]); tag = 'container'; destructible = false; }
      else if (kind < 0.6) { const rot = rand() < 0.5; bw = rot ? 0.6 : 3.4; bd = rot ? 3.4 : 0.6; bh = 1.15; mat = M.concrete; tag = 'cover'; }
      else if (kind < 0.85) { const rot = rand() < 0.5; bw = rot ? 0.5 : 3.0; bd = rot ? 3.0 : 0.5; bh = 2.3; mat = M.concrete; tag = 'cover'; }
      else { bw = bd = 1.8; bh = 1.4; mat = M.concreteDark; tag = 'cover'; }
      if (blocked(x - bw / 2, x + bw / 2, z - bd / 2, z + bd / 2, 1.2) || !clearOf(x - bw / 2, x + bw / 2, z - bd / 2, z + bd / 2, 4) || onRoad(x - bw / 2 - 1, x + bw / 2 + 1, z - bd / 2 - 1, z + bd / 2 + 1)) continue;
      addBox(x, 0, z, bw, bh, bd, mat, { tag, destructible });
    }
  }

  // stepped parkour towers
  for (let i = 0; i < 5; i++) addBox(48 + i * 3.2, 0, -52 + (i % 2) * 2.5, 2.6, 1.2 + i * 1.3, 2.6, i % 2 ? M.teal : M.concreteDark);
  for (let i = 0; i < 4; i++) addBox(-58, 0, -54 + i * 4, 3, 1.5 + i * 1.5, 3, i % 2 ? M.amber : M.concreteDark);

  // ---- jump pads ----------------------------------------------------------
  function pad(x, z, vx, vy, vz) {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 0.16, 40), M.metal);
    base.position.set(x, 0.08, z); base.receiveShadow = true; base.castShadow = true; scene.add(base);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.07, 10, 48), M.glowTeal);
    ring.rotation.x = Math.PI / 2; ring.position.set(x, 0.2, z); scene.add(ring);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.04, 24), M.glowTeal);
    core.position.set(x, 0.18, z); scene.add(core);
    pads.push({ x, z, r: 1.5, y: 0, vel: new THREE.Vector3(vx, vy, vz), ring });
  }
  const launch = (roofY) => Math.sqrt(2 * 24 * (roofY + 2.5)); // just clears the parapet whatever the height
  pad(-13, -10, -5, launch(roofA), 0);     // onto roof A
  pad(13, -18, 5, launch(roofB), 0);       // onto roof B
  pad(-30, 21.5, 0, launch(roofD), 5);     // onto roof D
  pad(0, 22, 0, 15, -12);         // long hop onto the plaza
  pad(52, 30, -14, 17, -6);       // cross-map launch

  // ---- ziplines -----------------------------------------------------------
  function zipline(a, b, groundA, groundB) {
    // posts standing on a roof can be destroyed (and fall with the roof); the zipline goes with them
    const post = (p, g) => {
      const m = addBox(p.x, g, p.z, 0.3, p.y - g + 0.3, 0.3, M.metal, { tag: 'post', destructible: g > 0 });
      addBox(p.x, p.y + 0.3, p.z, 0.5, 0.1, 0.5, M.glowAmber, { solid: false, shadow: false, attachTo: m });
      return m.userData.collider;
    };
    const posts = [post(a, groundA), post(b, groundB)];
    const dir = b.clone().sub(a); const len = dir.length();
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, len, 6), M.glowAmber);
    cable.position.copy(a).addScaledVector(dir, 0.5);
    cable.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    scene.add(cable);
    const zip = { a, b, len, dir: dir.clone().normalize(), cable, dead: false };
    for (const c of posts) c.zipline = zip;
    ziplines.push(zip);
  }
  zipline(new THREE.Vector3(-19.2, roofA + 3.4, -4), new THREE.Vector3(19.2, roofB + 3.4, -13), roofA, roofB);
  zipline(new THREE.Vector3(-25.2, roofD + 3.4, 27.2), new THREE.Vector3(-3, 5.6, 9.5), roofD, 0);
  zipline(new THREE.Vector3(33, roofB + 3.4, -12.2), new THREE.Vector3(46, 8.6, 20), roofB, 0);
  for (const [a, b, roofY] of towerZips) zipline(a, b, roofY, 0);

  // ---- ladders and ascender lines: other ways up the outside of the taller buildings ---------------------
  // A ladder is climbed by walking into it (W up, S down, Space to let go). An ascender is a powered line: E and it
  // hauls you to the roof. Each is { x, z (where you hang), y0, y1 (parapet top), nx, nz (pointing away from the wall),
  // tx, tz (where you step off on the roof), roofY, fast }.
  const ladders = [];
  {
    const rungs = [];
    const place = (b, side, fast) => {
      const alongX = side < 2, sgn = side % 2 ? 1 : -1, len = alongX ? b.w : b.d;
      const off = (rand() < 0.5 ? -1 : 1) * len * (0.28 + rand() * 0.1); // a quarter of the way along: clear of the door in the middle
      const nx = alongX ? 0 : sgn, nz = alongX ? sgn : 0;
      const wx = alongX ? b.x + off : b.x + sgn * b.w / 2, wz = alongX ? b.z + sgn * b.d / 2 : b.z + off; // on the wall face
      const x = wx + nx * 0.55, z = wz + nz * 0.55;
      if (blocked(x - 0.4, x + 0.4, z - 0.4, z + 0.4, 0.05) || onRoad(x - 0.5, x + 0.5, z - 0.5, z + 0.5)) return false;
      if (ladders.some((l) => Math.hypot(l.x - x, l.z - z) < 3)) return false;
      const y1 = b.roofY + 1.0, fx = wx + nx * 0.14, fz = wz + nz * 0.14, lx = alongX ? 1 : 0, lz = alongX ? 0 : 1;
      if (fast) {
        addBox(fx + nx * 0.3, 0, fz + nz * 0.3, 0.05, y1 + 1.3, 0.05, M.glowAmber, { solid: false, shadow: false }); // the line
        addBox(fx + nx * 0.1, y1 + 1.2, fz + nz * 0.1, alongX ? 0.14 : 0.7, 0.14, alongX ? 0.7 : 0.14, M.metal, { solid: false }); // arm over the parapet
        addBox(fx + nx * 0.3, 0, fz + nz * 0.3, 0.5, 0.25, 0.5, M.metal, { solid: false }); // winch at the foot
      } else {
        for (const s of [-0.26, 0.26]) addBox(fx + lx * s, 0, fz + lz * s, 0.06, y1 + 0.5, 0.06, M.metal, { solid: false, shadow: false });
        for (let y = 0.35; y < y1 + 0.3; y += 0.42) rungs.push([fx, y, fz, alongX]);
      }
      ladders.push({ x, z, y0: 0, y1, nx, nz, tx: wx - nx * 1.4, tz: wz - nz * 1.4, roofY: b.roofY, fast });
      return true;
    };
    for (const b of buildings) {
      if (b.roofY < 7) continue; // two storeys and up
      const sides = [0, 1, 2, 3].map((i) => [rand(), i]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
      let n = 0; const want = b.hq ? 3 : b.floors >= 3 || b.warehouse ? 2 : rand() < 0.6 ? 1 : 0;
      for (const sd of sides) { if (n >= want) break; if (place(b, sd, n === 1 || (b.hq && n === 2 ? false : n === 1))) n++; }
    }
    if (rungs.length) { // every rung of every ladder is one instanced mesh
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.52, 0.04, 0.04), M.metal, rungs.length), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), v3 = new THREE.Vector3();
      rungs.forEach(([x, y, z, alongX], i) => { q.setFromAxisAngle(up, alongX ? 0 : Math.PI / 2); im.setMatrixAt(i, m4.compose(v3.set(x, y, z), q, one)); });
      im.instanceMatrix.needsUpdate = true; scene.add(im);
    }
  }

  // ---- distant skyline (visual only) --------------------------------------
  const skyRand = rng(99);
  for (let i = 0; i < 70; i++) {
    const ang = skyRand() * Math.PI * 2, dist = 150 + skyRand() * 230;
    const w = 14 + skyRand() * 26, h = 20 + skyRand() * 110, d = 14 + skyRand() * 26;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M.far);
    m.position.set(Math.cos(ang) * dist, h / 2, Math.sin(ang) * dist);
    scene.add(m);
    if (skyRand() < 0.6) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.6, d * 0.9), skyRand() < 0.5 ? M.glowAmber : M.glowTeal);
      cap.position.set(m.position.x, h + 0.3, m.position.z); scene.add(cap);
    }
  }

  // ---- queries & edits used by the other systems ---------------------------
  const world = {
    colliders, pads, ziplines, ladders, buildings, materials: M, arenaHalf: ARENA, coreHalf: CORE, spawnPoints, exitPoints, outbuildings, roads, compoundWalls, seed, strongroom,
    spawn: new THREE.Vector3(0, 0, 50),
    // nearest solid box along a ray -> { collider, point, normal, dist } or null
    // every solid piece touching the box x0..x1, z0..z1 (any height), written into `out` and returned
    near(x0, x1, z0, z1, out = []) {
      out.length = 0; stamp++;
      for (const c of big) out.push(c);
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const l = grid.get(cellKey(cx, cz)); if (!l) continue;
        for (const c of l) if (c._q !== stamp) { c._q = stamp; out.push(c); }
      }
      return out;
    },
    raycast(origin, dir, maxDist = 500) {
      let best = null;
      const test = (c) => { const h = rayAABB(origin, dir, c.min, c.max, best ? best.dist : maxDist); if (h) best = { collider: c, dist: h.t, normal: h.normal }; };
      for (const c of big) test(c);
      // walk the grid cells the ray crosses, nearest first, and stop once a hit lies before the next cell
      stamp++;
      let cx = Math.floor(origin.x / CELL), cz = Math.floor(origin.z / CELL);
      const ax = Math.abs(dir.x), az = Math.abs(dir.z), sx = dir.x > 0 ? 1 : -1, sz = dir.z > 0 ? 1 : -1;
      const tdx = ax > 1e-9 ? CELL / ax : Infinity, tdz = az > 1e-9 ? CELL / az : Infinity;
      let tx = ax > 1e-9 ? (dir.x > 0 ? (cx + 1) * CELL - origin.x : origin.x - cx * CELL) / ax : Infinity;
      let tz = az > 1e-9 ? (dir.z > 0 ? (cz + 1) * CELL - origin.z : origin.z - cz * CELL) / az : Infinity;
      for (let guard = 0; guard < 600; guard++) {
        const l = grid.get(cellKey(cx, cz));
        if (l) for (const c of l) if (c._q !== stamp) { c._q = stamp; test(c); }
        const next = Math.min(tx, tz);
        if ((best && best.dist <= next) || next > maxDist) break;
        if (tx < tz) { cx += sx; tx += tdx; } else { cz += sz; tz += tdz; }
      }
      if (best) best.point = origin.clone().addScaledVector(dir, best.dist);
      return best;
    },
    // the old exhaustive ray check, kept for verifying the indexed one
    raycastSlow(origin, dir, maxDist = 500) {
      let best = null;
      for (const c of colliders) { const h = rayAABB(origin, dir, c.min, c.max, best ? best.dist : maxDist); if (h) best = { collider: c, dist: h.t, normal: h.normal }; }
      if (best) best.point = origin.clone().addScaledVector(dir, best.dist);
      return best;
    },
    lineOfSight(a, b) {
      const d = b.clone().sub(a), len = d.length();
      return len < 1e-4 || !world.raycast(a, d.divideScalar(len), len - 0.05);
    },
    // boxes touching a sphere
    overlapSphere(p, r) {
      return world.near(p.x - r, p.x + r, p.z - r, p.z + r).filter((c) => {
        const dx = Math.max(c.min.x - p.x, 0, p.x - c.max.x), dy = Math.max(c.min.y - p.y, 0, p.y - c.max.y), dz = Math.max(c.min.z - p.z, 0, p.z - c.max.z);
        return dx * dx + dy * dy + dz * dz <= r * r;
      });
    },
    // take a piece out of the world (mesh and collision)
    removeCollider(c) {
      const i = colliders.indexOf(c); if (i < 0) return false;
      colliders.splice(i, 1); indexRemove(c);
      if (c.mesh) { c.mesh.removeFromParent(); c.mesh.geometry.dispose(); }
      return true;
    },
    // stop drawing the insides of buildings that are far from the camera (they still collide and can still be destroyed)
    updateLOD(cam, range = 110) {
      let hidden = 0;
      for (const g of lod) {
        const far = Math.hypot(g.x - cam.x, g.z - cam.z) > range;
        if (far !== g.far) { g.far = far; for (const m of g.meshes) m.visible = !far; }
        if (far) hidden += g.meshes.length;
      }
      return hidden;
    },
    removeZipline(z) {
      if (z.dead) return;
      z.dead = true; z.cable.removeFromParent();
      const i = ziplines.indexOf(z); if (i >= 0) ziplines.splice(i, 1);
    },
    // add a new solid box at runtime (e.g. rubble); returns the collider
    addBox(cx, y, cz, w, h, d, mat, opts) { return addBox(cx, y, cz, w, h, d, mat, opts).userData.collider; },
  };
  return world;
}
