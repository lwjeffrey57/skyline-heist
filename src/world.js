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
      colliders.push(c);
    }
    return mesh;
  }
  const B = (tag) => ({ tag, destructible: true }); // building piece

  // ---- ground -------------------------------------------------------------
  const ARENA = 70; // half-size
  {
    const g = new THREE.PlaneGeometry(900, 900);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 225, uv.getY(i) * 225);
    const ground = new THREE.Mesh(g, M.ground);
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    scene.add(ground);
    colliders.push({ min: new THREE.Vector3(-450, -5, -450), max: new THREE.Vector3(450, 0, 450), mesh: ground, tag: 'ground', destructible: false, mat: M.ground });
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
  function building(x, z, w, d, floors, accent) {
    const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2;
    const hx0 = x - 2.7, hx1 = x + 2.7;
    for (let f = 0; f < floors; f++) {
      const y0 = f * FH;
      wallRun(true, z0 + T / 2, x0, x1, y0, f === 0, accent);
      wallRun(true, z1 - T / 2, x0, x1, y0, f === 0, accent);
      wallRun(false, x0 + T / 2, z0 + T, z1 - T, y0, f === 0, accent);
      wallRun(false, x1 - T / 2, z0 + T, z1 - T, y0, f === 0, accent);

      // U-turn stairs: even floors climb +x in lane A, odd floors climb -x in lane B.
      const lane = f % 2;
      const lz0 = lane === 0 ? z - 1.7 : z + 0.1, lz1 = lz0 + 1.6;
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
    buildings.push({ x, z, w, d, floors, floorHeight: FH, wallThickness: T, roofY: ry, accent });
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
      building(x + jit(1), z + jit(1), rand() < 0.5 ? mw : 12, rand() < 0.5 ? md : 10, rand() < 0.45 ? 1 : 2, pick(ACCENTS));
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
  addBox(0, 1.0, 0, 2.2, 3.2, 2.2, M.navy);
  addBox(0, 4.2, 0, 2.6, 0.12, 2.6, M.glowAmber, { solid: false, shadow: false });
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
    colliders, pads, ziplines, buildings, materials: M, arenaHalf: ARENA, seed,
    spawn: new THREE.Vector3(0, 0, 50),
    // nearest solid box along a ray -> { collider, point, normal, dist } or null
    raycast(origin, dir, maxDist = 500) {
      let best = null;
      for (const c of colliders) {
        const h = rayAABB(origin, dir, c.min, c.max, best ? best.dist : maxDist);
        if (h) best = { collider: c, dist: h.t, normal: h.normal };
      }
      if (best) best.point = origin.clone().addScaledVector(dir, best.dist);
      return best;
    },
    lineOfSight(a, b) {
      const d = b.clone().sub(a), len = d.length();
      return len < 1e-4 || !world.raycast(a, d.divideScalar(len), len - 0.05);
    },
    // boxes touching a sphere
    overlapSphere(p, r) {
      return colliders.filter((c) => {
        const dx = Math.max(c.min.x - p.x, 0, p.x - c.max.x), dy = Math.max(c.min.y - p.y, 0, p.y - c.max.y), dz = Math.max(c.min.z - p.z, 0, p.z - c.max.z);
        return dx * dx + dy * dy + dz * dz <= r * r;
      });
    },
    // take a piece out of the world (mesh and collision)
    removeCollider(c) {
      const i = colliders.indexOf(c); if (i < 0) return false;
      colliders.splice(i, 1);
      if (c.mesh) { c.mesh.removeFromParent(); c.mesh.geometry.dispose(); }
      return true;
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
