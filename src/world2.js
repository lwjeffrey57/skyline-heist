import * as THREE from 'three';
import { createMaterials } from './materials.js';
import { rayAABB } from './core.js';

// THE FIXED MAP (blockout). Shares its building kit with world.js; only the layout differs.
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
  // Blockout surfaces: flat colour over a one-metre grid, so scale reads at a glance and nothing looks finished.
  // Walls are pale, floors mid-grey, the ground dark, cover a warm yellow so it stands out, districts their own colour.
  {
    const gridTex = (() => {
      const S2 = 256, cv = document.createElement('canvas'); cv.width = cv.height = S2; const g2 = cv.getContext('2d');
      g2.fillStyle = '#ffffff'; g2.fillRect(0, 0, S2, S2);
      g2.strokeStyle = 'rgba(0,0,0,.16)'; g2.lineWidth = 2; for (let i = 0; i <= 4; i++) { g2.beginPath(); g2.moveTo(i * 64, 0); g2.lineTo(i * 64, S2); g2.moveTo(0, i * 64); g2.lineTo(S2, i * 64); g2.stroke(); }
      g2.strokeStyle = 'rgba(0,0,0,.3)'; g2.lineWidth = 4; g2.strokeRect(0, 0, S2, S2);
      const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
    })();
    const flat = (hex, rough = 0.92) => new THREE.MeshStandardMaterial({ color: hex, map: gridTex, roughness: rough, metalness: 0 });
    Object.assign(M, { ground: flat(0x4d5257), concrete: flat(0xc9c5bb), concreteDark: flat(0x8d9199), slab: flat(0xa7a9a6),
      rust: flat(0xc8553a), navy: flat(0x3f6aa8), teal: flat(0x3fa89a), amber: flat(0xe0a23a), cream: flat(0xe6dcc0) });
  }
  // The layout is rolled fresh on every page load (add ?seed=123 to the address to pin one).
  const seedParam = /[?&]seed=(\d+)/.exec(typeof location !== 'undefined' ? location.search : '');
  const seed = seedParam ? Number(seedParam[1]) >>> 0 : 20261119; // a fixed, hand-designed layout: the same every raid
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
  const ARENA = 110; // half-size of the whole walled site (220 m across)
  const CORE = 44;   // half-size of the built-up centre; the ring outside it is open approach ground
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
  // base: the height of the ground the building stands on (a raised plateau), 0 on the flat
  function building(x, z, w, d, floors, accent, stair = 'centre', base = 0) {
    const first = colliders.length;
    const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2;
    const [cx, cz] = stairSpot(x, z, w, d, stair);
    const hx0 = cx - 2.7, hx1 = cx + 2.7;
    for (let f = 0; f < floors; f++) {
      const y0 = base + f * FH;
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
    const ry = base + floors * FH;
    const front = addBox(x, ry, z0 + T / 2, w, 1.0, T, M.concrete, B('parapet'));
    addBox(x, ry, z1 - T / 2, w, 1.0, T, M.concrete, B('parapet'));
    addBox(x0 + T / 2, ry, z, T, 1.0, d - T * 2, M.concrete, B('parapet'));
    addBox(x1 - T / 2, ry, z, T, 1.0, d - T * 2, M.concrete, B('parapet'));
    addBox(x, ry + 1.0, z0 + T / 2, w, 0.06, T + 0.04, accent === M.teal ? M.glowTeal : M.glowAmber, { solid: false, shadow: false, attachTo: front });
    buildings.push({ x, z, w, d, floors, floorHeight: FH, wallThickness: T, roofY: ry, baseY: base, accent, stairAt: [cx, cz], keep: stair === 'centre' ? null : [[cx - 4.4, cx + 4.4, cz - 3.3, cz + 3.3]] });
    lod.push({ x, z, far: false, meshes: colliders.slice(first).filter((c) => c.tag === 'stair' || (c.tag === 'slab' && c.max.y < ry - 0.1)).map((c) => c.mesh) });
    return ry;
  }

  // four core blocks keep their footprints (the jump pads and ziplines are built around them) but vary in height and colour
  const ACCENTS = [M.teal, M.amber, M.navy, M.cream, M.rust];

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

  const blocked = (x0, x1, z0, z1, m, ignore) => colliders.some((c) => c.tag !== 'ground' && c.tag !== ignore && x0 - m < c.max.x && x1 + m > c.min.x && z0 - m < c.max.z && z1 + m > c.min.z);
  const outbuildings = [], roads = [], compoundWalls = [], towerZips = [];
  const spawnPoints = [], exitPoints = [], gates = [], ramparts = [], PADS = [], ZIPS = [];
  const road = (x, z, wd, dp) => { roads.push([x - wd / 2, x + wd / 2, z - dp / 2, z + dp / 2]); addBox(x, 0.004, z, wd, 0.012, dp, M.concreteDark, { solid: false, shadow: false }); };
  const onRoad = (x0, x1, z0, z1) => roads.some(([a, b, c, d]) => x0 < b && x1 > a && z0 < d && z1 > c);
  {
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

    // =====================================================================================================
    // THE LAYOUT. North is -z. Four sides, each with its own colour and purpose, around a walled core:
    //   north  Freight Row (rust)   container yard, warehouse, a covered service alley
    //   east   Exchange (navy)      the office campus astride the road
    //   south  Depot (cream)        supply dump, an overlook terrace, the infirmary
    //   west   Works (amber)        a tower block, a warehouse, the armoury
    // Every side offers three ways to the core: the ROAD (fast, exposed, checkpoints), the YARDS (cover and
    // patrols, through a side gate) and the QUIET WAY (hidden, slow, ends at a crawl-through breach in the wall).
    // The spire over the strongroom is visible from everywhere: it is where you are going.
    // =====================================================================================================
    const IW = CORE + 3, WH = 4.2, cover = { tag: 'cover', destructible: true };
    spawnPoints.push(...[[-50, -103], [62, -103], [-60, 103], [55, 103], [-103, -62], [-103, 62], [103, -64], [103, 68]]);
    exitPoints.push(...[[0, -104], [104, 0], [0, 104], [-104, 0], [100, 100]]);
    gates.push(...[[0, -IW, Math.PI], [-28, -IW, Math.PI], [0, IW, 0], [28, IW, 0], [-IW, 0, -Math.PI / 2], [IW, 0, Math.PI / 2]]); // x, z, facing outward (guards and turrets post here)

    // ---- small pieces ------------------------------------------------------------------------------------
    const barrier = (x, z, alongX) => addBox(x, 0, z, alongX ? 3.4 : 0.6, 1.15, alongX ? 0.6 : 3.4, M.concrete, cover);
    const slab = (x, z, alongX, len = 3, h = 2.3) => addBox(x, 0, z, alongX ? len : 0.5, h, alongX ? 0.5 : len, M.concrete, cover);
    const block = (x, z) => addBox(x, 0, z, 1.8, 1.4, 1.8, M.concreteDark, cover);
    const cont = (x, z, alongX, mat, stacked) => {
      const w = alongX ? 6 : 2.4, d = alongX ? 2.4 : 6;
      addBox(x, 0, z, w, 2.6, d, mat, { tag: 'container' });
      if (stacked) addBox(x + (alongX ? 0.6 : 0), 2.6, z + (alongX ? 0 : 0.6), w, 2.6, d, stacked, { tag: 'container' });
    };
    const clear = (x0, x1, z0, z1, m = 1.2) => !blocked(x0, x1, z0, z1, m) && !onRoad(x0 - 1, x1 + 1, z0 - 1, z1 + 1);
    // a knot of cover: an L of tall slabs, a low barrier and a block. rot turns it a quarter each step
    const cluster = (x, z, rot = 0) => {
      if (!clear(x - 3, x + 3, z - 3, z + 3, 0.6)) return;
      const R = [[1, 0, 0, 1], [0, 1, -1, 0], [-1, 0, 0, -1], [0, -1, 1, 0]][rot % 4], p = (dx, dz) => [x + dx * R[0] + dz * R[1], z + dx * R[2] + dz * R[3]];
      const ax = rot % 2 === 0;
      let q = p(0, -1.6); slab(q[0], q[1], ax, 3.4); q = p(-1.7, 0.2); slab(q[0], q[1], !ax, 3.2); q = p(2.2, 1.6); barrier(q[0], q[1], ax); q = p(-0.2, 2.4); block(q[0], q[1]);
    };
    // a checkpoint: staggered barriers and a guard hut's worth of wall, so the road cannot be run in a straight line
    const checkpoint = (x, z, alongX) => {
      if (alongX) { barrier(x - 1.6, z - 1.9, false); barrier(x + 1.6, z + 1.9, false); slab(x - 4.2, z + 5.2, true, 3, 2.3); slab(x + 4.2, z - 5.2, true, 3, 2.3); }
      else { barrier(x - 1.9, z - 1.6, true); barrier(x + 1.9, z + 1.6, true); slab(x + 5.2, z - 4.2, false, 3, 2.3); slab(x - 5.2, z + 4.2, false, 3, 2.3); }
    };
    // a raised platform you can fight from: steps up at both ends, a low wall along its edges
    const terrace = (cx, cz, w, d, h) => {
      addBox(cx, 0, cz, w, h, d, M.slab, { tag: 'slab' });
      const n = Math.ceil(h / 0.3), run = 0.55;
      for (const sd of [-1, 1]) for (let s = 0; s < n; s++) addBox(cx + sd * (w / 2 + run * (n - s - 0.5)), 0, cz, run, (h / n) * (s + 1), Math.min(d, 5), M.concreteDark, { tag: 'stair' });
      for (const sz of [-1, 1]) addBox(cx, h, cz + sz * (d / 2 - 0.2), w, 1.0, 0.4, M.concrete, cover);
    };
    // raised ground: a flat-topped plateau with broad steps up the sides you name ('n', 's', 'e', 'w')
    const plateau = (cx, cz, w, d, h, sides) => {
      addBox(cx, 0, cz, w, h, d, M.slab, { tag: 'slab' });
      const n = Math.ceil(h / 0.3), run = 0.55, wide = 8;
      for (const sd of sides) for (let s2 = 0; s2 < n; s2++) {
        const out = run * (n - s2 - 0.5), hh = (h / n) * (s2 + 1);
        if (sd === 'n') addBox(cx, 0, cz - d / 2 - out, wide, hh, run, M.concreteDark, { tag: 'stair' });
        if (sd === 's') addBox(cx, 0, cz + d / 2 + out, wide, hh, run, M.concreteDark, { tag: 'stair' });
        if (sd === 'w') addBox(cx - w / 2 - out, 0, cz, run, hh, wide, M.concreteDark, { tag: 'stair' });
        if (sd === 'e') addBox(cx + w / 2 + out, 0, cz, run, hh, wide, M.concreteDark, { tag: 'stair' });
      }
      for (const [ex, ez, ew, ed] of [[cx, cz - d / 2 + 0.2, w, 0.4], [cx, cz + d / 2 - 0.2, w, 0.4], [cx - w / 2 + 0.2, cz, 0.4, d], [cx + w / 2 - 0.2, cz, 0.4, d]]) { // a low wall round the edge, open where the steps are
        const side = ed < 1 ? (ez < cz ? 'n' : 's') : (ex < cx ? 'w' : 'e');
        if (!sides.includes(side)) { addBox(ex, h, ez, ew, 1.0, ed, M.concrete, cover); continue; }
        const along = ed < 1, len = (along ? w : d), seg = (len - wide - 1) / 2;
        for (const q of [-1, 1]) { const off = q * (wide / 2 + 0.5 + seg / 2); if (along) addBox(cx + off, h, ez, seg, 1.0, 0.4, M.concrete, cover); else addBox(ex, h, cz + off, 0.4, 1.0, seg, M.concrete, cover); }
      }
    };
    const outpost = (x, z, w, d, floors, type, accent, stair = 'corner', base = 0) => {
      building(x, z, w, d, floors, accent, stair, base);
      buildings[buildings.length - 1].outpost = type;
      if (!base) for (const [sx, sz] of [[-1, -1], [1, 1]]) { // two corner walls: a yard with open sides
        const m1 = addBox(x + sx * (w / 2 + 4), 0, z + sz * (d / 2 + 1), 0.35, 1.7, 10, M.concrete, cover), m2 = addBox(x + sx * (w / 2 - 0.5), 0, z + sz * (d / 2 + 6), 9, 1.7, 0.35, M.concrete, cover);
        compoundWalls.push(m1.userData.collider, m2.userData.collider);
      }
    };

    // ---- the inner wall: gates on the roads and the yard side, a crawl-through breach on the quiet side ------
    const wallSide = (alongX, fixed, openings) => { // openings: [centre, width, 'gate' | 'breach']
      const put = (c, len, y, h, tag = 'wall') => { const m = alongX ? addBox(c, y, fixed, len, h, 0.4, M.concrete, { tag, destructible: true }) : addBox(fixed, y, c, 0.4, h, len, M.concrete, { tag, destructible: true }); compoundWalls.push(m.userData.collider); };
      const cuts = openings.slice().sort((a, b) => a[0] - b[0]); let at = -IW;
      for (const [c, wd, kind] of cuts.concat([[IW, 0, 'end']])) {
        const to = c - wd / 2; let from = at;
        while (to - from > 0.05) { const len = Math.min(24, to - from); put(from + len / 2, len, 0, WH); from += len; } // in pieces short enough to knock holes in
        if (kind === 'breach') put(c, wd, 1.15, WH - 1.15, 'lintel'); // a gap you have to crouch through
        if (kind === 'gate') for (const s of [-1, 1]) { const p = c + s * (wd / 2 + 0.45), px = alongX ? p : fixed, pz = alongX ? fixed : p; addBox(px, 0, pz, 0.9, WH + 0.6, 0.9, M.concreteDark, { tag: 'post' }); addBox(px, WH + 0.6, pz, 0.5, 0.12, 0.5, M.glowAmber, { solid: false, shadow: false }); }
        at = c + wd / 2;
      }
    };
    wallSide(true, -IW, [[0, 6, 'gate'], [-28, 4.5, 'gate'], [16.5, 1.7, 'breach']]);   // north
    wallSide(true, IW, [[0, 6, 'gate'], [28, 4.5, 'gate'], [-36, 1.7, 'breach']]);     // south
    wallSide(false, -IW, [[0, 6, 'gate'], [24, 4.5, 'gate'], [-42, 1.7, 'breach']]);   // west
    wallSide(false, IW, [[0, 6, 'gate'], [-24, 4.5, 'gate'], [30, 1.7, 'breach']]);    // east

    // ---- roads -------------------------------------------------------------------------------------------
    const mid = (IW + ARENA) / 2, len = ARENA - IW;
    road(0, -mid, 7, len); road(0, mid, 7, len); road(-mid, 0, len, 7); road(mid, 0, len, 7);
    road(-28, -IW - 7, 5, 14); road(28, IW + 7, 5, 14); road(-IW - 7, 24, 14, 5); road(IW + 7, -24, 14, 5); // short spurs out of the side gates
    for (let dd = IW + 6; dd < ARENA - 4; dd += 12) { mark(0, -dd, 0.25, 4); mark(0, dd, 0.25, 4); mark(-dd, 0, 4, 0.25); mark(dd, 0, 4, 0.25); }

    // ---- the core ----------------------------------------------------------------------------------------
    // the spire: a mast over the strongroom, lit all the way up. Wherever you are, it tells you where the centre is.
    addBox(0, 1, -5.4, 2.2, 47, 2.2, M.concreteDark, { tag: 'bunker' });
    for (let y = 9; y < 46; y += 7) addBox(0, y, -5.4, 2.5, 0.35, 2.5, M.glowAmber, { solid: false, shadow: false });
    addBox(0, 48, -5.4, 5, 1.2, 5, M.glowAmber, { solid: false, shadow: false }); addBox(0, 49.2, -5.4, 0.5, 7, 0.5, M.metal, { solid: false, shadow: false });
    const roofA = building(-25, -24, 20, 16, 3, M.teal, 'corner');
    const roofB = building(25, -23, 16, 16, 2, M.teal, 'endX');
    building(24, 25, 16, 14, 2, M.teal, 'corner');
    const roofD = building(-25, 25, 14, 14, 3, M.teal, 'endZ');
    PADS.push([-11, -24, -5, Math.sqrt(2 * 24 * (roofA + 2.5)), 0], [-25, 14, 0, Math.sqrt(2 * 24 * (roofD + 2.5)), 5]);
    ZIPS.push([new THREE.Vector3(-16.5, roofA + 3.4, -24), new THREE.Vector3(18.5, roofB + 3.4, -23), roofA, roofB]);
    // cover on the streets round the plaza: each gate looks down a street with something to hide behind
    barrier(0, -32, true); slab(-6, -38, false, 3); block(7, -36); barrier(0, 32, true); slab(6, 38, false, 3); block(-7, 36);
    barrier(-32, 0, false); slab(-38, 6, true, 3); block(-36, -7); barrier(32, 0, false); slab(38, -6, true, 3); block(36, 7);
    cont(4, 14, true, M.rust); cont(-8, -13, false, M.navy); cont(12, -4, false, M.amber, M.cream);
    addBox(-4.5, 1.0, -4.5, 3, 1.1, 0.4, M.concrete); addBox(4.5, 1.0, 4.5, 3, 1.1, 0.4, M.concrete);

    // ---- NORTH: Freight Row --------------------------------------------------------------------------------
    { // the yards: rows of containers west of the road, with lanes between them and gaps to cut through
      const MATS = [M.rust, M.navy, M.rust, M.cream, M.rust, M.teal];
      [-97, -87, -77, -67].forEach((z, r) => { let i = 0; for (let x = -76; x <= -14; x += 8.6, i++) { if ((i * 3 + r * 5) % 7 === 0 || (i * 3 + r * 5) % 7 === 3 || Math.hypot(x + 50, z + 103) < 17) continue; cont(x, z, true, MATS[(i + r) % 6], (i + r) % 3 === 0 ? MATS[(i + r + 2) % 6] : null); } });
    }
    outpost(-92, -92, 12, 10, 2, 'signal', M.rust);
    plateau(92, -92, 26, 24, 3.0, ['w', 's']); outpost(92, -92, 12, 10, 2, 'watch', M.navy, 'endX', 3.0); // the watch post stands on a hill: the highest ground on the site
    warehouse(46, -80, 32, 22);
    { // the quiet way: a walled service alley from the edge to the breach, roofed over in the middle
      for (const x of [13.6, 19.4]) for (const [z0, z1] of x > 15 ? [[-100, -76], [-72, -52]] : [[-100, -76], [-76, -52]]) addBox(x, 0, (z0 + z1) / 2, 0.4, 3.2, z1 - z0, M.concrete, { tag: 'wall', destructible: true });
      addBox(16.5, 3.2, -76, 6.2, 0.3, 20, M.slab, { tag: 'slab', destructible: true });
      block(15.2, -90); block(17.8, -62);
    }
    checkpoint(0, -76, false);
    for (const [x, z, r] of [[-62, -56, 0], [-44, -55, 1], [-12, -58, 2], [30, -57, 3], [62, -60, 0], [84, -64, 1], [-40, -105, 3]]) cluster(x, z, r);

    // ---- EAST: the Exchange — the office campus, two wings joined by bridges over the road ---------------------
    {
      const cx = 80, gap = 6.5;
      const main = headquarters(cx, gap + 23, 34, 46, 5), annex = headquarters(cx, -(gap + 17), 34, 34, 4);
      main.name = 'Campus — main wing'; annex.name = 'Campus — annex'; main.campus = annex.campus = true; annex.annex = true;
      const cut = (x0, x1, z0, z1, y0, y1) => {
        for (let k = colliders.length - 1; k >= 0; k--) {
          const c = colliders[k];
          if (c.tag !== 'wall' && c.tag !== 'pillar' && c.tag !== 'sill') continue;
          if (c.max.x <= x0 || c.min.x >= x1 || c.max.z <= z0 || c.min.z >= z1 || c.max.y <= y0 || c.min.y >= y1) continue;
          colliders.splice(k, 1); indexRemove(c); if (c.mesh) { c.mesh.removeFromParent(); c.mesh.geometry.dispose(); }
        }
      };
      const BR = [[cx - 4.2, 1], [cx + 4.2, 2], [cx - 4.2, 3]];
      for (const [bx, f] of BR) {
        const y = f * FH, blen = gap * 2, hw = 1.7;
        cut(bx - hw, bx + hw, gap - 0.1, gap + T + 0.1, y + 0.05, y + 2.45); cut(bx - hw, bx + hw, -gap - T - 0.1, -gap + 0.1, y + 0.05, y + 2.45);
        addBox(bx, y - SLAB, 0, hw * 2, SLAB, blen, M.slab, { tag: 'slab', destructible: true });
        for (const sd of [-1, 1]) addBox(bx + sd * (hw - 0.1), y, 0, 0.2, 1.1, blen, M.concreteDark, cover);
        addBox(bx, y + 2.7, 0, hw * 2 + 0.3, 0.16, blen, M.metal, { solid: false });
      }
      main.bridges = annex.bridges = BR;
      for (const [bx] of BR) { main.keep.push([bx - 2.3, bx + 2.3, gap, gap + 7.4]); annex.keep.push([bx - 2.3, bx + 2.3, -gap - 7.4, -gap]); }
      checkpoint(cx - 22, 0, true); checkpoint(cx + 23, 0, true);
      // the quiet way: a screened lane between the inner wall and the main wing, ending at the breach
      // the service arcade: in from the east edge along a walled lane south of the main wing, then north under a roofed gallery
      const wl = (x0, x1, z0, z1) => addBox((x0 + x1) / 2, 0, (z0 + z1) / 2, Math.max(0.4, x1 - x0), 3.2, Math.max(0.4, z1 - z0), M.concrete, { tag: 'wall', destructible: true });
      wl(54.8, 55.2, 12, 32); wl(54.8, 55.2, 36, 54.8);                       // the gallery's outer wall, with a doorway toward the wing
      wl(55, 78, 54.4, 54.8); wl(82, 100, 54.4, 54.8);                        // the lane's north wall, with a gap at the wing's back door
      wl(47.4, 73.7, 60.2, 60.6); wl(73.7, 100, 60.2, 60.6);                  // the lane's south wall
      wl(47.2, 47.6, 47.2, 60.4);                                             // closes the lane's west end, so it turns north into the gallery
      addBox(51.1, 3.2, 44.4, 7.6, 0.3, 20.8, M.slab, { tag: 'slab', destructible: true }); // gallery roof
      addBox(78, 3.2, 57.5, 22, 0.3, 6.2, M.slab, { tag: 'slab', destructible: true });      // lane roof
      for (const z of [38, 44, 50]) addBox(53.4, 0, z, 0.6, 3.2, 0.6, M.concreteDark, { tag: 'pillar', destructible: true }); // a row of columns down the gallery
      block(92, 58.8); block(66, 56.2);
    }
    for (const [x, z, r] of [[62, -52, 0], [80, -56, 1], [100, -58, 2], [100, 76, 1], [58, -12, 2]]) cluster(x, z, r);

    // ---- SOUTH: the Depot ------------------------------------------------------------------------------------
    plateau(36, 72, 28, 26, 1.5, ['n', 'w']); outpost(36, 72, 14, 12, 2, 'depot', M.cream, 'endZ', 1.5); // the supply dump is on a raised loading apron
    outpost(-76, 62, 12, 10, 1, 'infirmary', M.cream);
    terrace(-36, 76, 30, 16, 2.4); // the overlook: see the south gate and the supply dump before you commit
    slab(-27, 57, false, 14, 2.6); slab(-45, 54, false, 8, 2.6); // screens between the terrace and the breach
    cont(54.5, 62, false, M.cream); cont(58.5, 62, false, M.rust, M.cream); cont(12, 58, true, M.navy); cont(60, 84, true, M.cream, M.teal);
    for (let i = 0; i < 4; i++) barrier(14 + i * 6, 92, i % 2 === 0); // a vehicle park
    checkpoint(0, 76, false);
    for (const [x, z, r] of [[86, 62, 2], [-58, 84, 0], [-60, 50, 1], [-12, 96, 2], [-8, 84, 3]]) cluster(x, z, r);
    building(90, 90, 12, 10, 1, M.cream, 'corner'); outbuildings.push(buildings.pop()); // a shed by the corner exit

    // ---- WEST: the Works -------------------------------------------------------------------------------------
    tower(-78, -27, 22, 18, 4);
    warehouse(-80, 28, 26, 18);
    plateau(-92, 92, 24, 22, 1.5, ['n', 'e']); outpost(-92, 92, 12, 10, 2, 'armoury', M.amber, 'corner', 1.5); // the armoury sits up on a plinth
    checkpoint(-76, 0, true);
    { // the quiet way: a walled lane from the west edge, past the foot of the tower, to the breach
      for (const z of [-44.9, -39.1]) for (const [x0, x1] of [[-100, -76], [-76, -52]]) addBox((x0 + x1) / 2, 0, z, x1 - x0, 3.2, 0.4, M.concrete, { tag: 'wall', destructible: true });
      addBox(-80, 3.2, -42, 18, 0.3, 6.2, M.slab, { tag: 'slab', destructible: true }); block(-92, -43.6); block(-62, -40.4);
    }
    for (let i = 0; i < 5; i++) addBox(-60 - i * 2.6, 0, 52 + (i % 2) * 2.2, 2.4, 1.0 + i * 0.9, 2.4, i % 2 ? M.amber : M.concreteDark, cover); // stepped stacks: a climb onto the warehouse side
    for (const [x, z, r] of [[-98, 14, 3], [-58, -58, 0], [-98, -52, 1], [-62, 46, 2], [-100, 56, 3], [-60, 78, 0]]) cluster(x, z, r);

    // ---- HEIGHT ------------------------------------------------------------------------------------------
    // The rampart: a walkway along the inside of the inner wall, all the way round, with a parapet facing out.
    // High ground over every approach and over the core's streets; stairs up beside each main gate, and no rail
    // on the inner edge, so getting down is a drop.
    {
      const DY = WH, DW = 3, lenSide = IW * 2, piece = lenSide / 4;
      for (const [alongX, sgn] of [[true, -1], [true, 1], [false, -1], [false, 1]]) for (let k = 0; k < 4; k++) {
        const c = -IW + piece * (k + 0.5), f = sgn * IW, inner = sgn * (IW - 0.2 - DW / 2);
        if (alongX) { addBox(c, DY - 0.3, inner, piece, 0.3, DW, M.slab, { tag: 'slab', destructible: true }); addBox(c, DY, f, piece, 1.1, 0.4, M.concrete, cover); }
        else { addBox(inner, DY - 0.3, c, DW, 0.3, piece, M.slab, { tag: 'slab', destructible: true }); addBox(f, DY, c, 0.4, 1.1, piece, M.concrete, cover); }
      }
      // sentry posts on the walkway, a pair over each main gate, looking out: [x, y, z, facing]
      const wy = IW - 0.2 - DW / 2;
      ramparts.push([[-5, DY, -wy, Math.PI], [5, DY, -wy, Math.PI]], [[-5, DY, wy, 0], [5, DY, wy, 0]], [[-wy, DY, -5, -Math.PI / 2], [-wy, DY, 5, -Math.PI / 2]], [[wy, DY, -5, Math.PI / 2], [wy, DY, 5, Math.PI / 2]]);
      const n = Math.ceil(DY / 0.3), run = 0.55, edge = IW - 0.2 - DW; // steps rise along the wall and finish level with the walkway
      for (const [alongX, sgn, from, dir] of [[true, -1, 6, 1], [true, 1, -6, -1], [false, -1, -6, -1], [false, 1, 6, 1]]) for (let st = 0; st < n; st++) {
        const a = from + dir * run * (st + 0.5), b = sgn * (edge - 1), h = (DY / n) * (st + 1);
        if (alongX) addBox(a, 0, b, run, h, 2, M.concreteDark, { tag: 'stair' }); else addBox(b, 0, a, 2, h, run, M.concreteDark, { tag: 'stair' });
      }
    }
    // Footbridges over the roads: a deck at first-floor height with steps up. They break the long view down the road
    // and give whoever holds one a commanding position over the checkpoint.
    const footbridge = (x, z, alongX, stairsBoth) => { // the deck runs across the road
      const H = 3.6, half = 8, n = 12, run = 0.55;
      if (alongX) addBox(x, H - 0.3, z, half * 2, 0.3, 3, M.slab, { tag: 'slab', destructible: true }); else addBox(x, H - 0.3, z, 3, 0.3, half * 2, M.slab, { tag: 'slab', destructible: true });
      for (const sd of [-1, 1]) { if (alongX) addBox(x, H, z + sd * 1.4, half * 2, 1.0, 0.2, M.concreteDark, cover); else addBox(x + sd * 1.4, H, z, 0.2, 1.0, half * 2, M.concreteDark, cover); }
      for (const sd of stairsBoth ? [-1, 1] : [-1]) for (let st = 0; st < n; st++) {
        const a = sd * (half + run * (n - st - 0.5)), h = (H / n) * (st + 1);
        if (alongX) addBox(x + a, 0, z, run, h, 3, M.concreteDark, { tag: 'stair' }); else addBox(x, 0, z + a, 3, h, run, M.concreteDark, { tag: 'stair' });
      }
      for (const sd of [-1, 1]) { const px = alongX ? x + sd * 5 : x, pz = alongX ? z : z + sd * 5; addBox(px, 0, pz, 0.6, H - 0.3, 0.6, M.concreteDark, { tag: 'pillar' }); }
    };
    footbridge(0, -61, true, false);  // north: steps on the yard side only; the alley side is a drop
    footbridge(0, 62, true, true);    // south
    footbridge(-62, 0, false, true);  // west

    // ---- SKYLINE: one tall thing per side, so a glance tells you which district you are looking at -----------------
    for (const x of [-82, -11]) addBox(x, 0, -82, 1.6, 19, 1.6, M.amber, { tag: 'post' });                    // north: a gantry crane over the yard
    addBox(-46.5, 19, -82, 73, 1.6, 2.4, M.amber, { solid: false }); addBox(-40, 14.5, -82, 3, 4.5, 3, M.concreteDark, { solid: false, shadow: false });
    for (const x of [58, 66, 74]) { addBox(x, 0, 97, 6, 17, 6, M.cream, { tag: 'bunker' }); addBox(x, 17, 97, 6.4, 0.5, 6.4, M.concreteDark, { solid: false }); } // south: grain silos
    addBox(-99, 0, -10, 3.2, 34, 3.2, M.concreteDark, { tag: 'bunker' });                                    // west: the works chimney
    for (const y of [10, 20, 30]) addBox(-99, y, -10, 3.5, 1.2, 3.5, M.amber, { solid: false, shadow: false });
    addBox(-99, 34, -10, 3.6, 0.6, 3.6, M.glowAmber, { solid: false, shadow: false });

    // ---- ARRIVAL: each way in starts under an arch in its district's colour, facing the centre ------------------
    for (const [sx, sz] of spawnPoints) {
      const ns = Math.abs(sz) > Math.abs(sx), mat = ns ? (sz < 0 ? M.rust : M.cream) : (sx < 0 ? M.amber : M.navy);
      const ax = ns ? sx : sx - Math.sign(sx) * 7, az = ns ? sz - Math.sign(sz) * 7 : sz;
      for (const sd of [-1, 1]) { const px = ns ? ax + sd * 2.6 : ax, pz = ns ? az : az + sd * 2.6; if (!blocked(px - 0.5, px + 0.5, pz - 0.5, pz + 0.5, 0.1)) addBox(px, 0, pz, 0.9, 4.4, 0.9, mat, { tag: 'post' }); }
      addBox(ax, 4.4, az, ns ? 6.1 : 0.9, 0.8, ns ? 0.9 : 6.1, mat, { solid: false });
    }

  }

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
  for (const [x, z, vx, vy, vz] of PADS) pad(x, z, vx, vy, vz);
  for (const [a, b, ga, gb] of ZIPS) zipline(a, b, ga, gb);
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
    colliders, pads, ziplines, ladders, buildings, materials: M, arenaHalf: ARENA, coreHalf: CORE, spawnPoints, exitPoints, outbuildings, roads, compoundWalls, seed, strongroom, gates, ramparts, fixed: true, blockout: true,
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
