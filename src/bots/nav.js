import * as THREE from 'three';
import { H, makeBody, stepBody } from './physics.js';

// =============================================================================
// Layered grid navigation generated from world.colliders.
//
// The arena is cut into square columns (cfg.cell). For every column we find the
// surfaces a bot body can stand on (tops of boxes with 1.8 m of free space above):
// ground, floors, stair steps, roofs... up to cfg.maxLayers per column.
// A node is (column, layer). Edges are implicit, computed from heights:
//   walk  — neighbouring column, height difference <= one step
//   drop  — neighbouring column, lower surface (one-way, costs extra)
//   pad   — a jump pad cell leads to wherever its launch arc lands (simulated)
// The grid is patched incrementally when colliders appear / disappear (a few
// hundred columns per frame), path searches are time-sliced A*.
// =============================================================================

const NAV_R = 0.45;   // clearance radius used for obstacles (body radius 0.35 + margin)
const SUP_R = 0.35;   // = body radius: a column's height is exactly where the real body would stand at its centre
const BLOCK = 0.5;    // obstacles lower than this above a surface are stepped onto
const ES = 0.55;      // max height difference of a walk edge
const BIG = 1e9;
export const PAD_TRIGGER_R = 0.42; // bots only take a pad from (nearly) its centre, so the arc matches the simulated one
const PAD_MASK_R = 0.8;
const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
const GX = [1, 1, -1, -1], GZ = [1, -1, 1, -1], GA = [0, 0, 1, 1], GB = [2, 3, 2, 3];

export class Nav {
  constructor(world, cfg) {
    this.world = world; this.cfg = cfg;
    this.cell = cfg.cell; this.half = world.arenaHalf;
    const N = this.N = Math.round((this.half * 2) / this.cell), L = this.L = cfg.maxLayers;
    const nc = N * N, nn = nc * L;
    this.ys = new Float32Array(nn); this.ceil = new Float32Array(nn); this.cnt = new Uint8Array(nc);
    this.reach = new Uint8Array(nn); this.reachB = new Uint8Array(nn);
    this.padMask = new Uint8Array(nc); this.padLinks = [];
    // collider buckets
    this.BS = 4; this.BO = -this.half - 4; this.BN = Math.ceil((this.half * 2 + 8) / this.BS);
    this.buckets = []; for (let i = 0; i < this.BN * this.BN; i++) this.buckets.push([]);
    this.known = new Map(); this.scanId = 0;
    // dirty columns
    this.dirty = new Uint8Array(nc); this.dirtyList = []; this.pendingRects = [];
    this.version = 0; this.changes = [];
    // A*
    this.g = new Float32Array(nn); this.parent = new Int32Array(nn); this.ptype = new Uint8Array(nn);
    this.mark = new Uint32Array(nn); this.closed = new Uint32Array(nn); this.searchId = 0;
    this.heapCap = 1 << 18; this.heapK = new Float32Array(this.heapCap); this.heapV = new Int32Array(this.heapCap); this.heapN = 0;
    this.sId = new Int32Array(10); this.sCost = new Float32Array(10); this.sType = new Uint8Array(10);
    this.queue = []; this.active = null;
    // flood
    this.fq = new Int32Array(nn); this.fHead = 0; this.fTail = 0; this.flooding = false; this.needFlood = false; this.floodT = 0;
    this.syncT = 0; this.stats = { searches: 0, expansions: 0, failed: 0, rebuiltColumns: 0, floods: 0 };
    this._tMin = new Float32Array(256); this._tMax = new Float32Array(256); this._tSup = new Uint8Array(256); this._c = [];

    this.sync(true);
    while (this.dirtyList.length) this.processDirty(1e9);
    this.startFlood(); this.runFlood(1e9);
    this.buildPads();
    this.startFlood(); this.runFlood(1e9); // again, now that pad arcs are known
    // warm up the JIT on the search code so the first real requests do not hitch
    for (const [a, b] of [[[-60, -60], [60, 60]], [[60, -60], [-60, 60]], [[0, 50], [0, -50]]]) {
      this.requestPath({ x: a[0], y: 0, z: a[1] }, { x: b[0], y: 0, z: b[1] }, () => {});
      for (let i = 0; i < 400 && (this.queue.length || this.active); i++) this.update(0);
    }
    this.stats.searches = 0; this.stats.expansions = 0; this.stats.failed = 0;
  }

  // ---- coordinates --------------------------------------------------------
  ci(v) { return Math.floor((v + this.half) / this.cell); }
  cx(i) { return -this.half + (i + 0.5) * this.cell; }
  nodePos(id, out) {
    const col = (id / this.L) | 0;
    return out.set(this.cx(col % this.N), this.ys[id], this.cx((col / this.N) | 0));
  }

  // node in the column under (x, z) closest in height to y
  nodeAt(x, y, z, yTol = 1.2) {
    const ix = this.ci(x), iz = this.ci(z), N = this.N;
    if (ix < 0 || iz < 0 || ix >= N || iz >= N) return -1;
    const col = iz * N + ix, base = col * this.L;
    let best = -1, bd = yTol;
    for (let k = 0; k < this.cnt[col]; k++) { const d = Math.abs(this.ys[base + k] - y); if (d <= bd) { bd = d; best = base + k; } }
    return best;
  }

  // nearest node around a point (searches a few rings of columns)
  nearestNode(x, y, z, rCells = 3, yTol = 1.3, reachOnly = false) {
    const ix0 = this.ci(x), iz0 = this.ci(z), N = this.N, L = this.L;
    let best = -1, bs = Infinity;
    for (let r = 0; r <= rCells; r++) {
      for (let dz = -r; dz <= r; dz++) {
        const iz = iz0 + dz; if (iz < 0 || iz >= N) continue;
        const edge = Math.abs(dz) === r;
        for (let dx = -r; dx <= r; dx += (edge ? 1 : 2 * r || 1)) {
          const ix = ix0 + dx; if (ix < 0 || ix >= N) continue;
          const col = iz * N + ix, base = col * L;
          for (let k = 0; k < this.cnt[col]; k++) {
            const dy = this.ys[base + k] - y;
            if (dy > yTol || dy < -yTol) continue;
            if (reachOnly && !this.reach[base + k]) continue;
            const ddx = this.cx(ix) - x, ddz = this.cx(iz) - z, s = ddx * ddx + ddz * ddz + dy * dy * 2;
            if (s < bs) { bs = s; best = base + k; }
          }
        }
      }
      if (best >= 0 && r >= 1) break;
    }
    return best;
  }

  // highest node below a point (for bodies in the air)
  nodeBelow(x, y, z) {
    const ix = this.ci(x), iz = this.ci(z), N = this.N;
    if (ix < 0 || iz < 0 || ix >= N || iz >= N) return -1;
    const col = iz * N + ix, base = col * this.L;
    for (let k = this.cnt[col] - 1; k >= 0; k--) if (this.ys[base + k] <= y + 0.3) return base + k;
    return -1;
  }

  // random reachable node inside a box
  randomNode(x0, x1, z0, z1, y0 = -1, y1 = 100, tries = 24) {
    for (let t = 0; t < tries; t++) {
      const ix = this.ci(x0 + Math.random() * (x1 - x0)), iz = this.ci(z0 + Math.random() * (z1 - z0)), N = this.N;
      if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
      const col = iz * N + ix, base = col * this.L;
      for (let k = 0; k < this.cnt[col]; k++) {
        const y = this.ys[base + k];
        if (y >= y0 && y <= y1 && this.reach[base + k] && !(this.padMask[col] && y < 0.45)) return base + k;
      }
    }
    return -1;
  }

  // ---- world -> grid ------------------------------------------------------
  _bi(v) { return Math.max(0, Math.min(this.BN - 1, Math.floor((v - this.BO) / this.BS))); }
  _bucketRange(r, fn) {
    const a = this._bi(r.x0 - 0.5), b = this._bi(r.x1 + 0.5), c = this._bi(r.z0 - 0.5), d = this._bi(r.z1 + 0.5);
    for (let j = c; j <= d; j++) for (let i = a; i <= b; i++) fn(this.buckets[j * this.BN + i]);
  }
  markDirtyRect(x0, x1, z0, z1) {
    const N = this.N;
    const a = Math.max(0, this.ci(x0 - NAV_R - 0.01)), b = Math.min(N - 1, this.ci(x1 + NAV_R + 0.01));
    const c = Math.max(0, this.ci(z0 - NAV_R - 0.01)), d = Math.min(N - 1, this.ci(z1 + NAV_R + 0.01));
    if (a > b || c > d) return;
    for (let iz = c; iz <= d; iz++) for (let ix = a; ix <= b; ix++) {
      const col = iz * N + ix; if (!this.dirty[col]) { this.dirty[col] = 1; this.dirtyList.push(col); }
    }
    this.pendingRects.push({ x0: x0 - 1, x1: x1 + 1, z0: z0 - 1, z1: z1 + 1 });
  }

  // diff world.colliders against what the grid was built from
  sync(initial = false) {
    const cols = this.world.colliders, known = this.known, scan = ++this.scanId;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]; let r = known.get(c);
      if (r) {
        r.scan = scan;
        if (r.x0 === c.min.x && r.y1 === c.max.y && r.z0 === c.min.z && r.x1 === c.max.x && r.y0 === c.min.y && r.z1 === c.max.z) continue;
        this._remove(c, r); known.delete(c); // moved / resized: re-insert
      }
      r = { x0: c.min.x, x1: c.max.x, y0: c.min.y, y1: c.max.y, z0: c.min.z, z1: c.max.z, scan };
      known.set(c, r);
      this._bucketRange(r, (b) => b.push(r));
      if (initial) continue;
      this.markDirtyRect(r.x0, r.x1, r.z0, r.z1);
    }
    if (known.size > cols.length) {
      for (const [c, r] of known) if (r.scan !== scan) { this._remove(c, r); known.delete(c); }
    }
    if (initial) this.markDirtyRect(-this.half, this.half, -this.half, this.half);
  }
  _remove(c, r) {
    this._bucketRange(r, (b) => { const i = b.indexOf(r); if (i >= 0) { b[i] = b[b.length - 1]; b.pop(); } });
    this.markDirtyRect(r.x0, r.x1, r.z0, r.z1);
  }
  // immediate notification (pieceDestroyed): same as waiting for the next sync, just sooner
  colliderRemoved(c) { const r = this.known.get(c); if (r) { this._remove(c, r); this.known.delete(c); } }

  computeColumn(col) {
    const N = this.N, L = this.L, ix = col % N, iz = (col / N) | 0, cx = this.cx(ix), cz = this.cx(iz);
    const list = this.buckets[this._bi(cz) * this.BN + this._bi(cx)];
    let tMin = this._tMin, tMax = this._tMax, tSup = this._tSup, n = 0;
    if (list.length > tMin.length) { tMin = this._tMin = new Float32Array(list.length * 2); tMax = this._tMax = new Float32Array(list.length * 2); tSup = this._tSup = new Uint8Array(list.length * 2); }
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!(r.x0 < cx + NAV_R && r.x1 > cx - NAV_R && r.z0 < cz + NAV_R && r.z1 > cz - NAV_R)) continue;
      tMin[n] = r.y0; tMax[n] = r.y1;
      tSup[n] = (r.x0 < cx + SUP_R && r.x1 > cx - SUP_R && r.z0 < cz + SUP_R && r.z1 > cz - SUP_R) ? 1 : 0; n++;
    }
    const cand = this._c; cand.length = 0;
    for (let i = 0; i < n; i++) {
      if (!tSup[i]) continue;
      const y = tMax[i]; let ok = true;
      for (let k = 0; k < n; k++) if (tMin[k] < y + H && tMax[k] > y + BLOCK) { ok = false; break; }
      if (ok) cand.push(y);
    }
    cand.sort((a, b) => a - b);
    const base = col * L; let m = 0;
    for (let i = 0; i < cand.length && m < L; i++) {
      if (i + 1 < cand.length && cand[i + 1] - cand[i] <= BLOCK) continue; // keep the top of a cluster
      const y = cand[i]; let ce = BIG;
      for (let k = 0; k < n; k++) if (tMin[k] >= y + BLOCK && tMin[k] < ce) ce = tMin[k];
      this.ys[base + m] = y; this.ceil[base + m] = ce; this.reach[base + m] = 1; m++;
    }
    this.cnt[col] = m;
  }

  processDirty(budget) {
    const list = this.dirtyList; let n = 0;
    while (list.length && n < budget) { const col = list.pop(); this.dirty[col] = 0; this.computeColumn(col); n++; }
    this.stats.rebuiltColumns += n;
    if (n && !list.length) {
      this.version++;
      for (const r of this.pendingRects) { r.version = this.version; this.changes.push(r); }
      this.pendingRects.length = 0;
      if (this.changes.length > 96) this.changes.splice(0, this.changes.length - 96);
      this.needFlood = true;
    }
    return n;
  }

  // true if a path whose bounding box is `bb` may be affected by changes newer than `version`
  changedSince(version, bb) {
    if (version >= this.version) return false;
    const ch = this.changes;
    if (!ch.length || ch[0].version > version + 1) return true; // history lost
    for (let i = ch.length - 1; i >= 0 && ch[i].version > version; i--) {
      const r = ch[i]; if (r.x0 < bb.x1 && r.x1 > bb.x0 && r.z0 < bb.z1 && r.z1 > bb.z0) return true;
    }
    return false;
  }

  // ---- jump pads ----------------------------------------------------------
  buildPads() {
    const N = this.N, world = this.world;
    this.padMask.fill(0); this.padLinks.length = 0;
    world.pads.forEach((pad, pi) => {
      const body = makeBody(new THREE.Vector3(pad.x, pad.y + 0.02, pad.z), pad.vel.clone());
      let t = 0;
      for (; t < 7 && !(body.grounded && t > 0.2); t += 1 / 60) stepBody(body, world, 1 / 60, 0, 0, 0, 0, false);
      const to = body.grounded ? this.nearestNode(body.pos.x, body.pos.y, body.pos.z, 3, 0.8) : -1;
      this.padLinks.push({ pad, to, cost: 3 + t * 4, land: body.pos.clone(), time: t });
      const rr = PAD_MASK_R, a = this.ci(pad.x - rr), b = this.ci(pad.x + rr), c = this.ci(pad.z - rr), d = this.ci(pad.z + rr);
      for (let iz = c; iz <= d; iz++) for (let ix = a; ix <= b; ix++) {
        if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
        if (Math.hypot(this.cx(ix) - pad.x, this.cx(iz) - pad.z) <= rr) this.padMask[iz * N + ix] = pi + 1;
      }
    });
  }

  // ---- edges --------------------------------------------------------------
  // successors of a node -> this.sId / sCost / sType (0 walk, 1 drop, 2 pad flight)
  expand(id) {
    const L = this.L, N = this.N, ys = this.ys, ceil = this.ceil, cnt = this.cnt, cell = this.cell;
    const col = (id / L) | 0, ya = ys[id], ca = ceil[id], ix = col % N, iz = (col / N) | 0;
    const sId = this.sId, sCost = this.sCost, sType = this.sType;
    let n = 0;
    if (this.padMask[col] && ya < 0.45) {
      const pl = this.padLinks[this.padMask[col] - 1];
      if (pl && pl.to >= 0) { sId[0] = pl.to; sCost[0] = pl.cost; sType[0] = 2; return 1; }
    }
    const flat = this._flat || (this._flat = new Int32Array(4));
    for (let d = 0; d < 4; d++) {
      flat[d] = -1;
      const nx = ix + DX[d], nz = iz + DZ[d];
      if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
      const b = nz * N + nx, bb = b * L;
      let k = cnt[b] - 1; while (k >= 0 && ys[bb + k] > ya + ES) k--;
      if (k < 0) continue;
      const yb = ys[bb + k], cb = ceil[bb + k];
      if (yb >= ya - ES) {
        if (yb > ya ? ca >= yb + H - 0.01 : cb >= ya + H - 0.01) {
          sId[n] = bb + k; sCost[n] = cell + Math.abs(yb - ya) * 0.4; sType[n] = 0; n++; flat[d] = bb + k;
        }
      } else {
        const drop = ya - yb;
        if (drop <= this.cfg.maxDrop && cb >= ya + H) { sId[n] = bb + k; sCost[n] = cell + 2 + drop * 0.7; sType[n] = 1; n++; }
      }
    }
    for (let d = 0; d < 4; d++) {
      if (flat[GA[d]] < 0 || flat[GB[d]] < 0) continue;
      const nx = ix + GX[d], nz = iz + GZ[d];
      const b = nz * N + nx, bb = b * L;
      let k = cnt[b] - 1; while (k >= 0 && ys[bb + k] > ya + ES) k--;
      if (k < 0) continue;
      const yb = ys[bb + k];
      if (yb < ya - ES) continue;
      if (!(yb > ya ? ca >= yb + H - 0.01 : ceil[bb + k] >= ya + H - 0.01)) continue;
      sId[n] = bb + k; sCost[n] = cell * 1.4142 + Math.abs(yb - ya) * 0.4; sType[n] = 0; n++;
    }
    return n;
  }

  // Can a body walk the straight segment (same level, no drops, no pads)? Conservative.
  lineClear(ax, ay, az, bx, bz, maxLen = 40) {
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    if (len > maxLen) return false;
    const steps = Math.max(1, Math.ceil(len / 0.25)), N = this.N, L = this.L, ys = this.ys, cnt = this.cnt, inv = 1 / this.cell, half = this.half;
    let y = ay;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, fx = (ax + dx * t + half) * inv - 0.5, fz = (az + dz * t + half) * inv - 0.5;
      const ix = Math.floor(fx), iz = Math.floor(fz);
      if (ix < 0 || iz < 0 || ix >= N - 1 || iz >= N - 1) return false;
      let sum = 0;
      for (let q = 0; q < 4; q++) {
        const col = (iz + (q >> 1)) * N + ix + (q & 1), base = col * L;
        let found = false;
        for (let k = cnt[col] - 1; k >= 0; k--) {
          const d = ys[base + k] - y;
          if (d <= 0.62 && d >= -0.62) { sum += ys[base + k]; found = true; break; }
        }
        if (!found) return false;
        if (this.padMask[col] && y < 0.45) return false;
      }
      y = sum * 0.25;
    }
    return true;
  }

  // ---- reachability flood (time-sliced) -----------------------------------
  startFlood() {
    this.reachB.fill(0); this.fHead = 0; this.fTail = 0; this.flooding = true; this.needFlood = false;
    for (const [x, z] of [[0, 50], [0, -58], [58, 0], [-58, 0], [0, 12]]) {
      const id = this.nearestNode(x, 0, z, 6, 0.6);
      if (id >= 0 && !this.reachB[id]) { this.reachB[id] = 1; this.fq[this.fTail++] = id; }
    }
  }
  runFlood(budget) {
    if (!this.flooding) return;
    const fq = this.fq, rb = this.reachB, sId = this.sId;
    while (budget-- > 0 && this.fHead < this.fTail) {
      const n = this.expand(fq[this.fHead++]);
      for (let i = 0; i < n; i++) { const s = sId[i]; if (!rb[s]) { rb[s] = 1; fq[this.fTail++] = s; } }
    }
    if (this.fHead >= this.fTail) {
      this.flooding = false; this.stats.floods++;
      if (this.dirtyList.length === 0 && !this.needFlood) { const t = this.reach; this.reach = this.reachB; this.reachB = t; } else this.needFlood = true;
    }
  }

  // ---- A* -----------------------------------------------------------------
  _push(key, v) {
    if (this.heapN >= this.heapCap) return;
    const K = this.heapK, V = this.heapV; let i = this.heapN++;
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = key; V[i] = v;
  }
  _pop() {
    const K = this.heapK, V = this.heapV, top = V[0], n = --this.heapN;
    if (n > 0) {
      const key = K[n], v = V[n]; let i = 0;
      for (;;) {
        let c = i * 2 + 1; if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = key; V[i] = v;
    }
    return top;
  }
  _h(id) {
    const col = (id / this.L) | 0, dx = Math.abs(col % this.N - this.gx), dz = Math.abs(((col / this.N) | 0) - this.gz);
    return ((dx > dz ? dx + 0.4142 * dz : dz + 0.4142 * dx) * this.cell + Math.abs(this.ys[id] - this.gy) * 0.5) * 1.2;
  }

  // Ask for a path between two world positions. cb(points | null) is called a few frames later.
  // points: [{x, y, z, t, pad}]  t: 0 walk, 1 landing after a drop, 2 landing after a pad flight; pad: launch from this pad
  requestPath(from, to, cb, opts = {}) {
    const req = { fx: from.x, fy: from.y, fz: from.z, tx: to.x, ty: to.y, tz: to.z, cb, cancelled: false, goalId: opts.goalId ?? -1, air: !!opts.air };
    this.queue.push(req);
    return req;
  }
  _begin(req) {
    let s = req.air ? this.nodeBelow(req.fx, req.fy, req.fz) : -1;
    if (s < 0) s = this.nearestNode(req.fx, req.fy, req.fz, 3, 1.3);
    if (s < 0) s = this.nearestNode(req.fx, req.fy, req.fz, 5, 3);
    let g = req.goalId >= 0 ? req.goalId : this.nearestNode(req.tx, req.ty, req.tz, 4, 1.5, true);
    if (g < 0 && req.goalId < 0) g = this.nearestNode(req.tx, req.ty, req.tz, 8, 2.5, true);
    if (s < 0 || g < 0 || g >= this.ys.length) return false;
    const gc = (g / this.L) | 0; if (g - gc * this.L >= this.cnt[gc]) return false;
    this.searchId++; this.heapN = 0; this.start = s; this.goal = g; this.expN = 0;
    this.gx = gc % this.N; this.gz = (gc / this.N) | 0; this.gy = this.ys[g];
    this.g[s] = 0; this.mark[s] = this.searchId; this.parent[s] = -1; this.ptype[s] = 0;
    this._push(this._h(s), s);
    this.stats.searches++;
    return true;
  }
  // returns expansions used
  _run(budget) {
    const sid = this.searchId, g = this.g, mark = this.mark, closed = this.closed, sId = this.sId, sCost = this.sCost, sType = this.sType;
    let used = 0;
    while (used < budget) {
      if (this.heapN === 0 || this.expN > 160000) { this._finish(null); return used; }
      const id = this._pop();
      if (closed[id] === sid) continue;
      closed[id] = sid; used++; this.expN++;
      if (id === this.goal) { this._finish(this._trace()); return used; }
      const n = this.expand(id), gi = g[id];
      for (let i = 0; i < n; i++) {
        const s = sId[i]; if (closed[s] === sid) continue;
        const ng = gi + sCost[i];
        if (mark[s] !== sid || ng < g[s]) { g[s] = ng; mark[s] = sid; this.parent[s] = id; this.ptype[s] = sType[i]; this._push(ng + this._h(s), s); }
      }
    }
    return used;
  }
  _finish(points) {
    const req = this.active; this.active = null;
    this.stats.expansions += this.expN;
    if (!points) this.stats.failed++;
    if (!req.cancelled) req.cb(points);
  }
  _trace() {
    const ids = []; for (let id = this.goal; id >= 0; id = this.parent[id]) { ids.push(id); if (ids.length > 5000) break; }
    ids.reverse();
    const N = this.N, L = this.L, raw = [];
    for (const id of ids) {
      const col = (id / L) | 0;
      raw.push({ x: this.cx(col % N), y: this.ys[id], z: this.cx((col / N) | 0), t: this.ptype[id], pad: null });
    }
    raw[0].t = 0;
    for (let i = 0; i + 1 < raw.length; i++) {
      if (raw[i + 1].t === 2) { const col = (ids[i] / L) | 0; raw[i].pad = this.padLinks[this.padMask[col] - 1].pad; }
    }
    // string pulling: skip waypoints while the straight walk stays clear
    const out = [raw[0]]; let i = 0; const n = raw.length;
    while (i < n - 1) {
      let j = i + 1; const a = raw[i];
      while (j + 1 < n && j + 1 - i <= 80 && raw[j].t === 0 && !raw[j].pad && raw[j + 1].t === 0
        && this.lineClear(a.x, a.y, a.z, raw[j + 1].x, raw[j + 1].z)) j++;
      out.push(raw[j]); i = j;
    }
    return out;
  }

  // ---- per-frame ----------------------------------------------------------
  update(dt) {
    const cfg = this.cfg;
    this.syncT -= dt; if (this.syncT <= 0 && dt > 0) { this.syncT = cfg.syncInterval; this.sync(); }
    if (this.dirtyList.length) this.processDirty(cfg.columnsPerFrame);
    this.floodT -= dt;
    if (this.flooding) this.runFlood(cfg.floodPerFrame);
    else if (this.needFlood && this.floodT <= 0 && !this.dirtyList.length) { this.floodT = cfg.floodInterval; this.buildPads(); this.startFlood(); }
    let budget = cfg.expansionsPerFrame, guard = 0;
    while (budget > 0 && guard++ < 16) {
      if (!this.active) {
        const req = this.queue.shift(); if (!req) break;
        if (req.cancelled) continue;
        this.active = req;
        if (!this._begin(req)) { this.active = null; this.stats.failed++; req.cb(null); budget -= 50; continue; }
      }
      budget -= this._run(budget) + 20;
    }
  }
}
