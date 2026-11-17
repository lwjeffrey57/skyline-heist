import * as THREE from 'three';
import { CONFIG } from './destruction/config.js';
import { Grid } from './destruction/grid.js';
import { Debris } from './destruction/debris.js';
import { Decals } from './destruction/decals.js';

// =============================================================================
// DESTRUCTION — piece health, damage marks, adaptive subdivision, debris, structural collapse.
//
// ctx.destruction = {
//   hit(collider, point, normal, damage)      bullet impact on a world piece -> true if something broke
//   explode(point, radius, damage)            radial damage with falloff + occlusion -> number of pieces removed
//   destroy(collider, cause?)                 remove a destructible piece outright
//   config                                    live tuning (see destruction/config.js)
//   stats                                     { pieces, debris, activeDebris, pending, lastMs, maxMs, ... }
//   floating()                                debug: destructible pieces with no support path that are not already falling
// }
// Events emitted: pieceDamaged {collider, point, normal}
//                 pieceDestroyed {collider, center, size, color, cause:{type:'bullet'|'explosion'|'collapse'|'destroy', point, ...}}
//                 pieceSplit {collider, parts:[collider]}   a piece was replaced by smaller ones filling the same volume
//                 debrisImpact {point, speed, size, color}  a heavy chunk hit the ground (rate limited)
//
// How it works: every destructible collider is a "piece". Large pieces are never removed whole by
// local damage: they are cut (guillotine cuts, via world.addBox) so that only the cell around the
// impact / inside the blast goes. Removed pieces become instanced debris chunks. After removals a
// shortest-path pass over the touch graph finds pieces with no load path to an anchor and drops them.
// =============================================================================

const EPS = 0.03, MINOV = 0.04;
const AX = ['x', 'y', 'z'];
const _v = new THREE.Vector3();

export function init(ctx) {
  const cfg = CONFIG, S = cfg.support, world = ctx.world, events = ctx.events;
  const grid = new Grid(4, 1.5);
  const debris = new Debris(ctx.scene, grid, cfg.debris, (x, y, z, speed, size, r, g, b) => {
    events.emit('debrisImpact', { point: new THREE.Vector3(x, y, z), speed, size, color: new THREE.Color(r, g, b) });
  });
  const decals = new Decals(ctx.scene, cfg.decals);

  const pieces = new Set(), groups = new Set();
  let statics = [], known = 0, now = 0, nextId = 1, syncStamp = 0, evalStamp = 0, damageEvents = 0;
  let falling = []; // { p, t } scheduled collapses
  const stats = { pieces: 0, debris: 0, activeDebris: 0, pending: 0, lastMs: 0, maxMs: 0, apiMaxMs: 0, supportMaxMs: 0, debrisMaxMs: 0, removed: 0, splits: 0 };

  // ---- helpers ------------------------------------------------------------
  const tagHp = (tag) => cfg.health[tag] ?? cfg.health.default;
  function leafHp(c) {
    const d = [c.max.x - c.min.x, c.max.y - c.min.y, c.max.z - c.min.z].sort((a, b) => b - a);
    return tagHp(c.tag) * Math.min(1.6, Math.max(0.5, Math.sqrt(d[0] * d[1])));
  }
  const carvable = (c, cell) => c.max.x - c.min.x > cell + cfg.minSliver || c.max.y - c.min.y > cell + cfg.minSliver || c.max.z - c.min.z > cell + cfg.minSliver;
  function touching(a, b) {
    const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x); if (ox < -EPS) return false;
    const oy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y); if (oy < -EPS) return false;
    const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z); if (oz < -EPS) return false;
    return (ox > MINOV ? 1 : 0) + (oy > MINOV ? 1 : 0) + (oz > MINOV ? 1 : 0) >= 2;
  }
  function isAnchored(c) {
    for (const s of statics) {
      if (Math.abs(c.min.y - s.max.y) > EPS) continue;
      if (Math.min(c.max.x, s.max.x) - Math.max(c.min.x, s.min.x) > MINOV && Math.min(c.max.z, s.max.z) - Math.max(c.min.z, s.min.z) > MINOV) return true;
    }
    return false;
  }
  function distToBox(p, c) {
    const dx = Math.max(c.min.x - p.x, 0, p.x - c.max.x), dy = Math.max(c.min.y - p.y, 0, p.y - c.max.y), dz = Math.max(c.min.z - p.z, 0, p.z - c.max.z);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  function pieceColor(c) {
    const m = c.mesh && (Array.isArray(c.mesh.material) ? c.mesh.material[0] : c.mesh.material);
    return m && m.color ? m.color.clone() : new THREE.Color(0x888888);
  }
  const link = (a, b) => { a.nbr.push(b); b.nbr.push(a); };
  function unlink(p) {
    for (const q of p.nbr) { const i = q.nbr.indexOf(p); if (i >= 0) { q.nbr[i] = q.nbr[q.nbr.length - 1]; q.nbr.pop(); } }
    p.nbr.length = 0;
  }

  // ---- registry -----------------------------------------------------------
  function makePiece(c) {
    const p = { c, id: nextId++, alive: true, hp: 0, maxHp: 0, spots: [], nbr: [], group: null, cost: 0, anchored: false, pending: false, kids: null, done: 0 };
    p.maxHp = p.hp = leafHp(c);
    c._dp = p; pieces.add(p);
    return p;
  }
  function mergeGroups(a, b) {
    if (a === b) return a;
    if (a.pieces.size < b.pieces.size) { const t = a; a = b; b = t; }
    for (const p of b.pieces) { p.group = a; a.pieces.add(p); }
    a.dirty = a.dirty || b.dirty; groups.delete(b);
    return a;
  }
  const _q = [];
  // take a collider we have not seen before into the grid / piece graph
  function adopt(c) {
    c._dk = true; grid.insert(c);
    if (!c.destructible) { statics.push(c); return; }
    const p = makePiece(c);
    p.anchored = isAnchored(c);
    _q.length = 0;
    grid.query(c.min.x - EPS, c.min.y - EPS, c.min.z - EPS, c.max.x + EPS, c.max.y + EPS, c.max.z + EPS, _q);
    let g = null;
    for (const o of _q) {
      const q = o._dp; if (!q || q === p || !q.alive || !touching(c, o)) continue;
      link(p, q); g = g ? mergeGroups(g, q.group) : q.group;
    }
    if (!g) { g = { pieces: new Set(), dirty: false, cause: new THREE.Vector3() }; groups.add(g); }
    p.group = g; g.pieces.add(p);
  }
  // world.colliders changed behind our back (another system added/removed boxes): reconcile
  function resync() {
    const stamp = ++syncStamp;
    const fresh = [];
    for (const c of world.colliders) { c._ds = stamp; if (!c._dk) fresh.push(c); }
    for (const c of fresh) if (!c.destructible) adopt(c); // anchors first
    for (const c of fresh) if (c.destructible) adopt(c);
    for (const p of [...pieces]) {
      if (p.c._ds === stamp) continue;
      retire(p); p.group.dirty = true; p.group.cause.copy(p.c.min).add(p.c.max).multiplyScalar(0.5);
    }
    statics = statics.filter((s) => (s._ds === stamp ? true : (grid.remove(s), false)));
    if (fresh.some((c) => !c.destructible)) for (const p of pieces) if (!p.anchored) p.anchored = isAnchored(p.c);
    known = world.colliders.length;
  }
  // drop a piece from all bookkeeping (not from the world)
  function retire(p) {
    p.alive = false; pieces.delete(p); p.group.pieces.delete(p);
    unlink(p); grid.remove(p.c);
    for (const s of p.spots) decals.release(s);
  }
  // follow a stale collider (already split) down to the live piece at a point
  function resolve(c, point) {
    if (!c || !c.destructible) return null;
    let p = c._dp;
    if (!p) { if (world.colliders.includes(c)) { resync(); p = c._dp; } if (!p) return null; }
    while (!p.alive && p.kids) {
      let best = null, bd = Infinity;
      for (const k of p.kids) { const d = distToBox(point, k.c); if (d < bd) { bd = d; best = k; } }
      p = best;
    }
    return p.alive ? p : null;
  }

  // ---- subdivision --------------------------------------------------------
  // keep the parent's texture mapping continuous across the new sub-boxes
  function remapUV(parent, child) {
    const pg = parent.geometry, cg = child.geometry;
    const pp = pg.attributes.position, pu = pg.attributes.uv, cp = cg.attributes.position, cu = cg.attributes.uv;
    if (!pp || !pu || !cp || !cu || pp.count !== 24 || cp.count !== 24) return;
    const ox = child.position.x - parent.position.x, oy = child.position.y - parent.position.y, oz = child.position.z - parent.position.z;
    for (let f = 0; f < 6; f++) {
      const i0 = f * 4, i1 = i0 + 1, i2 = i0 + 2;
      const x0 = pp.getX(i0), y0 = pp.getY(i0), z0 = pp.getZ(i0);
      const ux = pp.getX(i1) - x0, uy = pp.getY(i1) - y0, uz = pp.getZ(i1) - z0, ul = ux * ux + uy * uy + uz * uz;
      const vx = pp.getX(i2) - x0, vy = pp.getY(i2) - y0, vz = pp.getZ(i2) - z0, vl = vx * vx + vy * vy + vz * vz;
      if (ul < 1e-9 || vl < 1e-9) continue;
      const a0 = pu.getX(i0), b0 = pu.getY(i0), au = pu.getX(i1) - a0, bu = pu.getY(i1) - b0, av = pu.getX(i2) - a0, bv = pu.getY(i2) - b0;
      for (let k = i0; k < i0 + 4; k++) {
        const x = cp.getX(k) + ox - x0, y = cp.getY(k) + oy - y0, z = cp.getZ(k) + oz - z0;
        const s = (x * ux + y * uy + z * uz) / ul, t = (x * vx + y * vy + z * vz) / vl;
        cu.setXY(k, a0 + s * au + t * av, b0 + s * bu + t * bv);
      }
    }
    cu.needsUpdate = true;
  }
  // move decorative child meshes (trims, glow strips…) onto the sub-pieces, clipped to each
  const _b = new THREE.Box3(), _b2 = new THREE.Box3();
  function transferDecor(parent, kids) {
    const pm = parent.c.mesh; if (!pm || !pm.children.length) return;
    pm.updateMatrixWorld(true);
    const pc = parent.c;
    for (const d of [...pm.children]) {
      _b.setFromObject(d);
      if (_b.isEmpty()) continue;
      const plain = d.isMesh && d.children.length === 0 && Math.abs(d.quaternion.w) > 0.9999;
      if (!plain) { // can't clip: hand it to the sub-piece holding its centre
        _b.getCenter(_v); let best = null, bd = Infinity;
        for (const k of kids) { const dd = distToBox(_v, k.c); if (dd < bd) { bd = dd; best = k; } }
        d.position.add(pm.position).sub(best.c.mesh.position); best.c.mesh.add(d);
        continue;
      }
      for (const k of kids) {
        const kc = k.c; _b2.copy(_b);
        let ok = true;
        for (const a of AX) {
          if (kc.min[a] > pc.min[a] + 1e-4) _b2.min[a] = Math.max(_b2.min[a], kc.min[a]);
          if (kc.max[a] < pc.max[a] - 1e-4) _b2.max[a] = Math.min(_b2.max[a], kc.max[a]);
          if (_b2.max[a] - _b2.min[a] < 1e-3) { ok = false; break; }
        }
        if (!ok) continue;
        const cl = d.clone(false);
        for (const a of AX) {
          const full = _b.max[a] - _b.min[a];
          if (full > 1e-6) cl.scale[a] = d.scale[a] * ((_b2.max[a] - _b2.min[a]) / full);
          cl.position[a] = (_b2.min[a] + _b2.max[a]) / 2 - kc.mesh.position[a];
        }
        kc.mesh.add(cl);
      }
    }
  }

  // Replace a piece by boxes that tile it exactly. boxes: [{min, max}] (Vector3s). Returns the new pieces, in order.
  function replace(p, boxes) {
    const pc = p.c, pm = pc.mesh, mat = pm.material, g = p.group;
    const cand = p.nbr.slice();
    const kids = [];
    for (const b of boxes) {
      const w = b.max.x - b.min.x, h = b.max.y - b.min.y, d = b.max.z - b.min.z;
      const c = world.addBox((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2, w, h, d, mat, { tag: pc.tag, destructible: true, solid: true, shadow: pm.castShadow });
      known++;
      c.min.copy(b.min); c.max.copy(b.max); c.mat = pc.mat; c._dk = true;
      const m = c.mesh; m.receiveShadow = pm.receiveShadow; m.layers.mask = pm.layers.mask; m.renderOrder = pm.renderOrder; m.visible = pm.visible;
      for (const key in pm.userData) if (key !== 'collider') m.userData[key] = pm.userData[key];
      remapUV(pm, m);
      const k = makePiece(c);
      k.group = g; g.pieces.add(k); k.pending = false;
      k.anchored = p.anchored && Math.abs(b.min.y - pc.min.y) < 1e-6 && isAnchored(c);
      grid.insert(c);
      kids.push(k);
    }
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      for (const q of cand) if (touching(k.c, q.c)) link(k, q);
      for (let j = i + 1; j < kids.length; j++) if (touching(k.c, kids[j].c)) link(k, kids[j]);
    }
    // hand damage spots (and their crack marks) to whichever sub-piece they sit on
    for (const s of p.spots) {
      let best = null, bd = Infinity;
      for (const k of kids) { const dd = distToBox(s, k.c); if (dd < bd) { bd = dd; best = k; } }
      best.spots.push(s);
      if (!carvable(best.c, cfg.bulletCell)) best.hp = Math.max(1, best.hp - s.dmg);
      if (s.slot >= 0) decals.set(s, best.c, s.size);
    }
    p.spots = [];
    transferDecor(p, kids);
    retire(p); p.kids = kids;
    if (world.removeCollider(pc)) known--;
    stats.splits++;
    events.emit('pieceSplit', { collider: pc, parts: kids.map((k) => k.c) });
    return kids;
  }
  const boxOf = (c) => ({ min: c.min.clone(), max: c.max.clone() });

  // Cut a cell of about `cell` metres around `pt` out of a large piece; returns the piece that is the cell.
  function carve(p, pt, cell) {
    const cur = boxOf(p.c), out = [];
    const order = [0, 1, 2].sort((a, b) => (cur.max[AX[b]] - cur.min[AX[b]]) - (cur.max[AX[a]] - cur.min[AX[a]]));
    for (const ai of order) {
      const a = AX[ai], lo = cur.min[a], hi = cur.max[a];
      const s = cell * (0.88 + Math.random() * 0.24);
      if (hi - lo <= s + cfg.minSliver) continue;
      let l = Math.min(hi - s, Math.max(lo, pt[a] - s / 2));
      if (l - lo < cfg.minSliver) l = lo;
      let h = l + s; if (hi - h < cfg.minSliver) h = hi;
      if (l > lo) { const b = boxOf(cur); b.max[a] = l; out.push(b); cur.min[a] = l; }
      if (h < hi) { const b = boxOf(cur); b.min[a] = h; out.push(b); cur.max[a] = h; }
    }
    if (!out.length) return p;
    out.push(cur);
    const kids = replace(p, out);
    return kids[kids.length - 1];
  }

  // ---- damage -------------------------------------------------------------
  function spotFor(p, point, normal) {
    const c = p.c, R2 = cfg.clusterRadius * cfg.clusterRadius;
    const x = Math.min(c.max.x, Math.max(c.min.x, point.x)), y = Math.min(c.max.y, Math.max(c.min.y, point.y)), z = Math.min(c.max.z, Math.max(c.min.z, point.z));
    let s = null, bd = Infinity;
    for (const o of p.spots) { const d = (o.x - x) ** 2 + (o.y - y) ** 2 + (o.z - z) ** 2; if (d < bd) { bd = d; s = o; } }
    // when the piece already tracks its maximum number of spots, scattered fire feeds the nearest one
    if (s && (bd < R2 || (p.spots.length >= cfg.maxClusters && bd < R2 * 6))) return s;
    let axis = 0, sign = 1;
    if (normal) {
      const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
      axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2; sign = normal[AX[axis]] >= 0 ? 1 : -1;
    } else { // nearest face
      let best = Infinity;
      for (let a = 0; a < 3; a++) {
        const k = AX[a], v = a === 0 ? x : a === 1 ? y : z;
        if (v - c.min[k] < best) { best = v - c.min[k]; axis = a; sign = -1; }
        if (c.max[k] - v < best) { best = c.max[k] - v; axis = a; sign = 1; }
      }
    }
    s = { x, y, z, dmg: 0, axis, sign, slot: -1, size: 0, flip: 0 };
    if (p.spots.length >= cfg.maxClusters) {
      let wi = 0; for (let i = 1; i < p.spots.length; i++) if (p.spots[i].dmg < p.spots[wi].dmg) wi = i;
      decals.release(p.spots[wi]); p.spots.splice(wi, 1);
    }
    p.spots.push(s);
    return s;
  }

  // Apply local damage. Large pieces lose a cell once one spot has taken enough; small ones have plain health.
  function damagePiece(p, point, normal, dmg, cell, cause) {
    if (!p.alive || p.pending || dmg <= 0) return false;
    const s = spotFor(p, point, normal);
    s.dmg += dmg;
    let frac;
    if (carvable(p.c, cfg.bulletCell)) {
      const thr = tagHp(p.c.tag) * cfg.carveFactor;
      if (s.dmg >= thr) { destroy(carvable(p.c, cell) ? carve(p, s, cell) : p, cause); return true; }
      frac = s.dmg / thr;
    } else {
      p.hp -= dmg;
      if (p.hp <= 0) { destroy(p, cause); return true; }
      frac = 1 - p.hp / p.maxHp;
    }
    s.size = 0.3 + frac * 0.95;
    decals.set(s, p.c, s.size);
    if (damageEvents++ < 12) events.emit('pieceDamaged', { collider: p.c, point: point.clone ? point.clone() : new THREE.Vector3(point.x, point.y, point.z), normal: normal ? normal.clone() : new THREE.Vector3(0, 1, 0) });
    return false;
  }

  // ---- removal + debris ---------------------------------------------------
  function burst(c, color, cause) {
    const D = cfg.debris, type = cause.type;
    const size = [c.max.x - c.min.x, c.max.y - c.min.y, c.max.z - c.min.z];
    const pr = debris.pressure();
    let target = type === 'collapse' ? D.fallChunk : D.chunk, maxN = D.maxPerPiece;
    if (pr > 0.35) { target *= 1.5; maxN = 4; }
    if (pr > 0.6) { target *= 1.5; maxN = 2; }
    const n = size.map((s) => Math.min(4, Math.max(1, Math.round(s / target))));
    while (n[0] * n[1] * n[2] > maxN) { let a = 0; if (n[1] > n[a]) a = 1; if (n[2] > n[a]) a = 2; if (n[a] === 1) break; n[a]--; }
    const cuts = n.map((k, a) => { const arr = [0]; for (let i = 1; i < k; i++) arr.push((i + (Math.random() - 0.5) * 0.5) / k); arr.push(1); return arr.map((t) => c.min[AX[a]] + t * size[a]); });
    const pt = cause.point, r = cause.radius || 1, dir = cause.dir;
    const grey = 0.42;
    for (let i = 0; i < n[0]; i++) for (let j = 0; j < n[1]; j++) for (let k = 0; k < n[2]; k++) {
      const x0 = cuts[0][i], x1 = cuts[0][i + 1], y0 = cuts[1][j], y1 = cuts[1][j + 1], z0 = cuts[2][k], z1 = cuts[2][k + 1];
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
      let vx = 0, vy = 0, vz = 0, spin = 3;
      if (type === 'explosion') {
        let dx = cx - pt.x, dy = cy - pt.y + 0.25, dz = cz - pt.z; const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-3;
        const sp = (cfg.blastSpeed * Math.max(0, 1 - d / r) + 2.5) * (0.55 + Math.random() * 0.8) / d;
        vx = dx * sp + (Math.random() - 0.5) * 2; vy = dy * sp + Math.random() * 2.5; vz = dz * sp + (Math.random() - 0.5) * 2; spin = 6;
      } else if (type === 'bullet' && dir) {
        const sp = 1.2 + Math.random() * 3.6;
        vx = dir.x * sp + (Math.random() - 0.5) * 1.6; vy = dir.y * sp + Math.random() * 1.2; vz = dir.z * sp + (Math.random() - 0.5) * 1.6; spin = 5;
      } else if (type === 'collapse') {
        vx = (Math.random() - 0.5) * 0.7; vz = (Math.random() - 0.5) * 0.7; vy = -Math.random() * 0.5; spin = 0.7;
      } else { vx = (Math.random() - 0.5) * 3; vy = Math.random() * 2; vz = (Math.random() - 0.5) * 3; }
      const sh = 0.7 + Math.random() * 0.2, mix = Math.random() * 0.3;
      debris.spawn(cx, cy, cz, (x1 - x0) * 0.47, (y1 - y0) * 0.47, (z1 - z0) * 0.47, vx, vy, vz,
        (color.r * (1 - mix) + grey * mix) * sh, (color.g * (1 - mix) + grey * mix) * sh, (color.b * (1 - mix) + grey * mix) * sh, spin, 0, type === 'collapse' ? 0 : 1);
    }
    if (type !== 'collapse' && pr < 0.3) { // crumbs
      const m = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < m; i++) {
        const x = c.min.x + Math.random() * size[0], y = c.min.y + Math.random() * size[1], z = c.min.z + Math.random() * size[2];
        const s = 0.04 + Math.random() * 0.09, k = 0.6 + Math.random() * 0.3;
        let vx = (Math.random() - 0.5) * 4, vy = 1 + Math.random() * 4, vz = (Math.random() - 0.5) * 4;
        if (dir) { vx += dir.x * 3; vz += dir.z * 3; } else if (type === 'explosion') { vx += (x - pt.x) * 2.5; vz += (z - pt.z) * 2.5; vy += 2; }
        debris.spawn(x, y, z, s, s * (0.5 + Math.random() * 0.5), s * (0.6 + Math.random() * 0.6), vx, vy, vz, color.r * k, color.g * k, color.b * k, 9, 0, 2);
      }
    }
  }
  function chips(point, normal, color) {
    if (!cfg.chips || debris.pressure() > 0.3) return;
    const m = 1 + (Math.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < m; i++) {
      const s = 0.025 + Math.random() * 0.05, sp = 1.5 + Math.random() * 3, k = 0.6 + Math.random() * 0.35;
      debris.spawn(point.x + normal.x * 0.06, point.y + normal.y * 0.06, point.z + normal.z * 0.06, s, s * 0.6, s * (0.6 + Math.random()),
        normal.x * sp + (Math.random() - 0.5) * 2.5, normal.y * sp + 0.5 + Math.random() * 2, normal.z * sp + (Math.random() - 0.5) * 2.5,
        color.r * k, color.g * k, color.b * k, 12, cfg.debris.chipLife + Math.random() * 2, 2);
    }
  }

  function destroy(p, cause) {
    if (!p || !p.alive) return false;
    const c = p.c, g = p.group, color = pieceColor(c);
    retire(p);
    if (world.removeCollider(c)) known--;
    stats.removed++;
    const center = c.min.clone().add(c.max).multiplyScalar(0.5), size = c.max.clone().sub(c.min);
    if (!cause.point) cause.point = center.clone();
    debris.wakeBox(c.min.x - 0.4, c.min.y - 0.2, c.min.z - 0.4, c.max.x + 0.4, c.max.y + 1.6, c.max.z + 0.4);
    burst(c, color, cause);
    if (cause.type !== 'collapse') { g.dirty = true; g.cause.copy(cause.point); }
    events.emit('pieceDestroyed', { collider: c, center, size, color, cause });
    return true;
  }

  // ---- structural support -------------------------------------------------
  // Cost of carrying q from p: free when q stands on p, grows with how far q's centre sticks out sideways,
  // expensive when q hangs underneath. A piece is supported when its cheapest path to an anchor is <= maxSpan.
  function edgeCost(pc, qc) {
    const cx = (qc.min.x + qc.max.x) / 2, cz = (qc.min.z + qc.max.z) / 2;
    const dx = Math.max(pc.min.x - cx, 0, cx - pc.max.x), dz = Math.max(pc.min.z - cz, 0, cz - pc.max.z), hd = Math.sqrt(dx * dx + dz * dz);
    if (qc.min.y >= pc.max.y - EPS) return Math.max(0, hd - S.restFree);
    if (qc.max.y <= pc.min.y + EPS) return S.hangBase + S.hangFactor * (pc.min.y - (qc.min.y + qc.max.y) / 2) + hd;
    return hd;
  }
  const heapP = [], heapC = [];
  function hpush(p, c) {
    let i = heapP.length; heapP.push(p); heapC.push(c);
    while (i > 0) { const j = (i - 1) >> 1; if (heapC[j] <= c) break; heapP[i] = heapP[j]; heapC[i] = heapC[j]; i = j; }
    heapP[i] = p; heapC[i] = c;
  }
  function hpop() {
    const top = heapP[0], lp = heapP.pop(), lc = heapC.pop(), n = heapP.length;
    if (n) {
      let i = 0;
      for (;;) { let j = i * 2 + 1; if (j >= n) break; if (j + 1 < n && heapC[j + 1] < heapC[j]) j++; if (heapC[j] >= lc) break; heapP[i] = heapP[j]; heapC[i] = heapC[j]; i = j; }
      heapP[i] = lp; heapC[i] = lc;
    }
    return top;
  }
  function evalGroup(g, span = S.maxSpan) {
    const stamp = ++evalStamp;
    heapP.length = heapC.length = 0;
    for (const p of g.pieces) { p.cost = Infinity; if (!p.pending && p.anchored) { p.cost = 0; hpush(p, 0); } }
    while (heapP.length) {
      const c0 = heapC[0], p = hpop();
      if (p.done === stamp || c0 > p.cost) continue;
      p.done = stamp;
      for (const q of p.nbr) {
        if (q.done === stamp || q.pending) continue;
        const nc = p.cost + edgeCost(p.c, q.c);
        if (nc < q.cost && nc <= span) { q.cost = nc; hpush(q, nc); }
      }
    }
    const out = [];
    for (const p of g.pieces) if (p.cost === Infinity && !p.pending) out.push(p);
    return out;
  }
  const isBig = (c) => Math.max(c.max.x - c.min.x, c.max.y - c.min.y, c.max.z - c.min.z) > S.structCell * 1.15;
  function tile(p) {
    const c = p.c, cuts = AX.map((a) => {
      const len = c.max[a] - c.min[a], n = Math.max(1, Math.ceil(len / S.structCell)), arr = [c.min[a]];
      for (let i = 1; i < n; i++) arr.push(c.min[a] + len * (i + (Math.random() - 0.5) * 0.16) / n);
      arr.push(c.max[a]); return arr;
    });
    const boxes = [];
    for (let i = 0; i + 1 < cuts[0].length; i++) for (let j = 0; j + 1 < cuts[1].length; j++) for (let k = 0; k + 1 < cuts[2].length; k++) {
      boxes.push({ min: new THREE.Vector3(cuts[0][i], cuts[1][j], cuts[2][k]), max: new THREE.Vector3(cuts[0][i + 1], cuts[1][j + 1], cuts[2][k + 1]) });
    }
    replace(p, boxes);
    return boxes.length;
  }
  function updateSupport() {
    let evals = 0, tileBudget = S.tileBoxesPerFrame;
    for (const g of groups) {
      if (!g.pieces.size) { groups.delete(g); continue; }
      if (!g.dirty) continue;
      if (evals++ >= S.groupsPerFrame) break;
      g.dirty = false;
      const uns = evalGroup(g);
      if (!uns.length) continue;
      // big unsupported pieces are first broken into tiles; what is still unsupported next pass falls
      let big = false;
      for (const p of uns) if (isBig(p.c)) { big = true; if (tileBudget > 0) tileBudget -= tile(p); }
      if (big) { g.dirty = true; continue; }
      for (const p of uns) {
        p.pending = true;
        const c = p.c, d = Math.hypot((c.min.x + c.max.x) / 2 - g.cause.x, (c.min.y + c.max.y) / 2 - g.cause.y, (c.min.z + c.max.z) / 2 - g.cause.z);
        falling.push({ p, t: now + Math.min(S.delayMax, S.delayBase + d * S.delayPerMeter) + Math.random() * S.delayJitter });
      }
      falling.sort((a, b) => a.t - b.t);
    }
    if (falling.length && falling[0].t <= now) {
      let n = 0, i = 0;
      for (; i < falling.length && falling[i].t <= now && n < S.collapsesPerFrame; i++) {
        const p = falling[i].p;
        if (p.alive) { destroy(p, { type: 'collapse', point: p.group.cause.clone() }); n++; }
      }
      falling.splice(0, i);
    }
  }

  // ---- explosions ---------------------------------------------------------
  // segment a->b against a box shrunk by s
  function segHits(a, b, c, s) {
    let t0 = 0, t1 = 1;
    for (let i = 0; i < 3; i++) {
      const k = AX[i], o = a[k], d = b[k] - o, mn = c.min[k] + s, mx = c.max[k] - s;
      if (mn >= mx) return false;
      if (Math.abs(d) < 1e-9) { if (o < mn || o > mx) return false; continue; }
      let u = (mn - o) / d, v = (mx - o) / d; if (u > v) { const w = u; u = v; v = w; }
      if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) return false;
    }
    return true;
  }
  // split a box against the lethal sphere: parts fully inside die whole, the rim is cut down to blastCell
  function partition(b, C, rk, out) {
    const nx = Math.min(b.max.x, Math.max(b.min.x, C.x)), ny = Math.min(b.max.y, Math.max(b.min.y, C.y)), nz = Math.min(b.max.z, Math.max(b.min.z, C.z));
    const near = Math.hypot(nx - C.x, ny - C.y, nz - C.z);
    if (near >= rk) { b.kill = false; out.push(b); return; }
    const fx = Math.max(C.x - b.min.x, b.max.x - C.x), fy = Math.max(C.y - b.min.y, b.max.y - C.y), fz = Math.max(C.z - b.min.z, b.max.z - C.z);
    if (fx * fx + fy * fy + fz * fz <= rk * rk) { b.kill = true; out.push(b); return; }
    let a = -1, len = cfg.blastCell * 1.5;
    for (let i = 0; i < 3; i++) { const l = b.max[AX[i]] - b.min[AX[i]]; if (l > len) { len = l; a = i; } }
    if (a < 0) {
      b.kill = Math.hypot((b.min.x + b.max.x) / 2 - C.x, (b.min.y + b.max.y) / 2 - C.y, (b.min.z + b.max.z) / 2 - C.z) <= rk;
      out.push(b); return;
    }
    const k = AX[a], cut = b.min[k] + len * (0.5 + (Math.random() - 0.5) * 0.2);
    const b1 = { min: b.min.clone(), max: b.max.clone() }, b2 = { min: b.min.clone(), max: b.max.clone() };
    b1.max[k] = cut; b2.min[k] = cut;
    partition(b1, C, rk, out); partition(b2, C, rk, out);
  }

  function explode(point, radius, damage) {
    const t0 = performance.now();
    if (world.colliders.length !== known) resync();
    const C = point.clone ? point.clone() : new THREE.Vector3(point.x, point.y, point.z), r = radius, D0 = damage * cfg.explosionScale, ex = cfg.falloffExp;
    const fall = (d) => (d >= r ? 0 : Math.pow(1 - d / r, ex));
    const list = grid.query(C.x - r, C.y - r, C.z - r, C.x + r, C.y + r, C.z + r, []);
    const cands = [], blockers = [];
    for (const c of list) {
      const d = distToBox(C, c); if (d >= r) continue;
      blockers.push(c);
      const p = c._dp;
      if (p && p.alive && c.destructible) cands.push({ p, d, T: new THREE.Vector3(Math.min(c.max.x, Math.max(c.min.x, C.x)), Math.min(c.max.y, Math.max(c.min.y, C.y)), Math.min(c.max.z, Math.max(c.min.z, C.z))) });
    }
    cands.sort((a, b) => a.d - b.d);
    for (const k of cands) { // rough occlusion: what stands between the blast and the nearest point of the piece
      let f = 1;
      if (k.d > 0.05) for (const b of blockers) {
        if (b === k.p.c) continue;
        if (C.x > b.min.x - 0.02 && C.x < b.max.x + 0.02 && C.y > b.min.y - 0.02 && C.y < b.max.y + 0.02 && C.z > b.min.z - 0.02 && C.z < b.max.z + 0.02) continue;
        if (segHits(C, k.T, b, 0.03)) { f *= b.destructible ? cfg.occlusion : cfg.staticOcclusion; if (f < 0.05) break; }
      }
      k.f = f;
    }
    const before = stats.removed;
    const cause = () => ({ type: 'explosion', point: C.clone(), radius: r });
    const nrm = (T) => _v.copy(C).sub(T).lengthSq() > 1e-6 ? _v.clone().normalize() : new THREE.Vector3(0, 1, 0);
    for (const k of cands) {
      const p = k.p; if (!p.alive) continue;
      const D = D0 * k.f, c = p.c;
      if (p.pending) { if (D * fall(k.d) > tagHp(c.tag) * 0.5) destroy(p, cause()); continue; }
      if (!carvable(c, cfg.blastCell)) {
        const dc = Math.hypot((c.min.x + c.max.x) / 2 - C.x, (c.min.y + c.max.y) / 2 - C.y, (c.min.z + c.max.z) / 2 - C.z);
        damagePiece(p, k.T, nrm(k.T), D * fall((k.d + dc) / 2), cfg.blastCell, cause());
        continue;
      }
      const href = tagHp(c.tag) * cfg.carveFactor;
      const rk = D > href ? r * (1 - Math.pow(href / D, 1 / ex)) : 0;
      if (rk <= k.d) { damagePiece(p, k.T, nrm(k.T), D * fall(k.d), cfg.blastCell, cause()); continue; }
      const parts = []; partition(boxOf(c), C, rk, parts);
      if (parts.length === 1) { if (parts[0].kill) destroy(p, cause()); else damagePiece(p, k.T, nrm(k.T), D * fall(k.d) * 0.6, cfg.blastCell, cause()); continue; }
      const kids = replace(p, parts);
      for (let i = 0; i < kids.length; i++) {
        const q = kids[i], qc = q.c;
        if (parts[i].kill) { destroy(q, cause()); continue; }
        const T = new THREE.Vector3(Math.min(qc.max.x, Math.max(qc.min.x, C.x)), Math.min(qc.max.y, Math.max(qc.min.y, C.y)), Math.min(qc.max.z, Math.max(qc.min.z, C.z)));
        const dn = T.distanceTo(C), dc = Math.hypot((qc.min.x + qc.max.x) / 2 - C.x, (qc.min.y + qc.max.y) / 2 - C.y, (qc.min.z + qc.max.z) / 2 - C.z);
        // rim pieces keep standing but show the damage
        const dmg = Math.min(D * fall((dn + dc) / 2), (carvable(qc, cfg.bulletCell) ? href : q.hp) * 0.85);
        damagePiece(q, T, nrm(T), dmg, cfg.blastCell, cause());
      }
    }
    debris.kick(C.x, C.y, C.z, r, cfg.blastSpeed * Math.min(1.5, damage / 200));
    const ms = performance.now() - t0; if (ms > stats.apiMaxMs) stats.apiMaxMs = ms;
    return stats.removed - before;
  }

  function hit(collider, point, normal, damage) {
    const t0 = performance.now();
    if (world.colliders.length !== known) resync();
    const p = resolve(collider, point);
    if (!p) return false;
    const n = normal || new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3(-n.x, -n.y, -n.z);
    const color = pieceColor(p.c);
    const broke = damagePiece(p, point, normal, damage * cfg.bulletScale, cfg.bulletCell, { type: 'bullet', point: point.clone ? point.clone() : new THREE.Vector3(point.x, point.y, point.z), normal: n.clone ? n.clone() : n, dir });
    if (!broke && !p.pending) chips(point, n, color);
    const ms = performance.now() - t0; if (ms > stats.apiMaxMs) stats.apiMaxMs = ms;
    return broke;
  }

  // ---- boot ---------------------------------------------------------------
  resync();
  { // pieces too large for the span rule (wide slabs) are tiled once up front so the level starts stable
    let bad = 0, worst = 0;
    for (let round = 0; round < 4; round++) {
      bad = 0; let tiled = 0;
      for (const g of [...groups]) for (const p of evalGroup(g)) { if (isBig(p.c)) { tile(p); tiled++; } else bad++; }
      if (!tiled) break;
    }
    if (bad) { // the level itself spans further than maxSpan allows: widen the limit just enough to hold it up
      for (const g of groups) evalGroup(g, Infinity);
      for (const p of pieces) if (p.cost !== Infinity && p.cost > worst) worst = p.cost;
      S.maxSpan = Math.max(S.maxSpan, worst + S.spanMargin);
      bad = 0; for (const g of groups) bad += evalGroup(g).length;
    }
    worst = 0; for (const p of pieces) if (p.cost !== Infinity && p.cost > worst) worst = p.cost;
    stats.initialWorstCost = worst; stats.splits = 0;
    if (bad) console.warn(`[destruction] ${bad} destructible pieces are not connected to anything anchored`);
  }

  ctx.destruction = {
    hit, explode,
    destroy(collider, cause = {}) {
      const p = resolve(collider, collider ? _v.copy(collider.min).add(collider.max).multiplyScalar(0.5) : _v);
      return destroy(p, { type: 'destroy', ...cause });
    },
    config: cfg, stats,
    // debug / tests
    floating() { let n = 0; for (const g of groups) n += evalGroup(g).length; return n; },
    pieces, groups, debris,
  };

  return {
    update(dt) {
      const t0 = performance.now();
      now += dt; damageEvents = 0;
      if (world.colliders.length !== known) resync();
      updateSupport();
      const t1 = performance.now(); if (t1 - t0 > stats.supportMaxMs) stats.supportMaxMs = t1 - t0;
      debris.update(dt);
      const t2 = performance.now(); if (t2 - t1 > stats.debrisMaxMs) stats.debrisMaxMs = t2 - t1;
      stats.pieces = pieces.size; stats.debris = debris.used; stats.activeDebris = debris.active; stats.pending = falling.length;
      const ms = performance.now() - t0; stats.lastMs = ms; if (ms > stats.maxMs) stats.maxMs = ms;
    },
  };
}
