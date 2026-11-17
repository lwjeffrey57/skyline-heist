import * as THREE from 'three';

// Rigid debris chunks: one InstancedMesh, fixed pool, hand-rolled physics.
// A chunk is an oriented box that collides through its world AABB against the colliders
// in the grid cell under it, bounces, tips flat, goes to sleep and is eventually recycled.

const FREE = 0, ACTIVE = 1, SLEEP = 2, DYING = 3;
const FADE = 0.6;

function chunkGeometry() {
  // a box with pulled-in corners so fragments read as broken lumps rather than perfect bricks
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const p = g.attributes.position;
  const j = [0.16, 0.05, 0.22, 0.02, 0.19, 0.09, 0.03, 0.24, 0.12, 0.2, 0.01, 0.15, 0.07, 0.23, 0.1, 0.04, 0.18, 0.21, 0.06, 0.13, 0.25, 0.08, 0.17, 0.11];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = ((x > 0 ? 1 : 0) | (y > 0 ? 2 : 0) | (z > 0 ? 4 : 0)) * 3;
    p.setXYZ(i, x * (1 - j[k]), y * (1 - j[k + 1] * 0.6), z * (1 - j[k + 2]));
  }
  g.computeVertexNormals();
  return g;
}

function grainTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), d = x.createImageData(64, 64);
  let s = 1234567;
  for (let i = 0; i < 64 * 64; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const v = 205 + ((s >>> 24) / 255) * 50;
    d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = v; d.data[i * 4 + 3] = 255;
  }
  x.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export class Debris {
  constructor(scene, grid, cfg, onImpact) {
    this.cfg = cfg; this.grid = grid; this.onImpact = onImpact;
    const N = this.N = cfg.max;
    this.state = new Uint8Array(N); this.gen = new Uint8Array(N);
    this.p = new Float32Array(N * 3); this.v = new Float32Array(N * 3); this.w = new Float32Array(N * 3);
    this.h = new Float32Array(N * 3); this.q = new Float32Array(N * 4);
    this.ttl = new Float32Array(N); this.age = new Float32Array(N); this.rest = new Float32Array(N);
    this.cursor = 0; this.active = 0; this.used = 0; this.impacts = 0;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, map: grainTexture() });
    const mesh = this.mesh = new THREE.InstancedMesh(chunkGeometry(), mat, N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.m = mesh.instanceMatrix.array; this.m.fill(0);
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.col = mesh.instanceColor.array;
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
    mesh.name = 'destruction-debris';
    scene.add(mesh);
  }

  pressure() { return this.active / this.N; }

  _alloc() {
    const N = this.N, st = this.state;
    let pick = -1;
    for (let k = 0; k < 32; k++) { const i = (this.cursor + k) % N; if (st[i] === FREE) { pick = i; break; } }
    if (pick < 0) for (let k = 0; k < 32; k++) { const i = (this.cursor + k) % N; if (st[i] !== ACTIVE) { pick = i; break; } }
    if (pick < 0) pick = this.cursor;
    this.cursor = (pick + 1) % N;
    return pick;
  }

  // centre, half sizes, velocity, colour, spin magnitude, life (0 = normal rubble), generation
  spawn(x, y, z, hx, hy, hz, vx, vy, vz, r, g, b, spin = 2, life = 0, gen = 0, q = null) {
    const i = this._alloc(), a = i * 3, o = i * 4;
    this.state[i] = ACTIVE; this.gen[i] = gen;
    this.p[a] = x; this.p[a + 1] = y; this.p[a + 2] = z;
    this.v[a] = vx; this.v[a + 1] = vy; this.v[a + 2] = vz;
    this.h[a] = hx; this.h[a + 1] = hy; this.h[a + 2] = hz;
    this.w[a] = (Math.random() - 0.5) * 2 * spin; this.w[a + 1] = (Math.random() - 0.5) * 2 * spin; this.w[a + 2] = (Math.random() - 0.5) * 2 * spin;
    if (q) { this.q[o] = q[0]; this.q[o + 1] = q[1]; this.q[o + 2] = q[2]; this.q[o + 3] = q[3]; } else { this.q[o] = this.q[o + 1] = this.q[o + 2] = 0; this.q[o + 3] = 1; }
    this.ttl[i] = life > 0 ? life : -1; this.age[i] = 0; this.rest[i] = 0;
    this.col[a] = r; this.col[a + 1] = g; this.col[a + 2] = b;
    this.mesh.instanceColor.needsUpdate = true;
    this._write(i, 1); this.mesh.instanceMatrix.needsUpdate = true;
    return i;
  }

  _write(i, k) {
    const q = this.q, o = i * 4, x = q[o], y = q[o + 1], z = q[o + 2], w = q[o + 3];
    const a = i * 3, sx = this.h[a] * 2 * k, sy = this.h[a + 1] * 2 * k, sz = this.h[a + 2] * 2 * k;
    const x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    const m = this.m, j = i * 16;
    m[j] = (1 - (yy + zz)) * sx; m[j + 1] = (xy + wz) * sx; m[j + 2] = (xz - wy) * sx; m[j + 3] = 0;
    m[j + 4] = (xy - wz) * sy; m[j + 5] = (1 - (xx + zz)) * sy; m[j + 6] = (yz + wx) * sy; m[j + 7] = 0;
    m[j + 8] = (xz + wy) * sz; m[j + 9] = (yz - wx) * sz; m[j + 10] = (1 - (xx + yy)) * sz; m[j + 11] = 0;
    m[j + 12] = this.p[a]; m[j + 13] = this.p[a + 1]; m[j + 14] = this.p[a + 2]; m[j + 15] = 1;
  }

  // wake settled chunks inside a box (their support was removed)
  wakeBox(x0, y0, z0, x1, y1, z1) {
    const st = this.state, p = this.p;
    for (let i = 0; i < this.N; i++) {
      if (st[i] !== SLEEP) continue;
      const a = i * 3;
      if (p[a] < x0 || p[a] > x1 || p[a + 2] < z0 || p[a + 2] > z1 || p[a + 1] < y0 || p[a + 1] > y1) continue;
      st[i] = ACTIVE; this.age[i] = 0; this.rest[i] = 0; this.ttl[i] = -1;
    }
  }

  // shove chunks away from a blast
  kick(x, y, z, radius, speed) {
    const st = this.state, p = this.p, v = this.v, r2 = radius * radius;
    for (let i = 0; i < this.N; i++) {
      if (st[i] !== SLEEP && st[i] !== ACTIVE) continue;
      const a = i * 3, dx = p[a] - x, dy = p[a + 1] - y + 0.3, dz = p[a + 2] - z, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) + 0.2, k = speed * (1 - (d - 0.2) / radius) / d;
      if (st[i] === SLEEP && k * d < 1) continue;
      v[a] += dx * k; v[a + 1] += Math.abs(dy) * k + 1.5; v[a + 2] += dz * k;
      this.w[a] += (Math.random() - 0.5) * 8; this.w[a + 2] += (Math.random() - 0.5) * 8;
      if (st[i] === SLEEP) { st[i] = ACTIVE; this.age[i] = 0; this.rest[i] = 0; this.ttl[i] = -1; }
    }
  }

  _fracture(i, speed) {
    const a = i * 3, o = i * 4, h = this.h, q = this.q;
    const hs = [h[a], h[a + 1], h[a + 2]];
    let a1 = 0; if (hs[1] > hs[a1]) a1 = 1; if (hs[2] > hs[a1]) a1 = 2;
    let a2 = (a1 + 1) % 3; const a3 = (a1 + 2) % 3; if (hs[a3] > hs[a2]) a2 = a3;
    const two = hs[a2] * 2 > this.cfg.breakSize * 0.8;
    const x = q[o], y = q[o + 1], z = q[o + 2], w = q[o + 3];
    // world directions of the local axes
    const R = [
      [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
      [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
      [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
    ];
    const px = this.p[a], py = this.p[a + 1], pz = this.p[a + 2], vx = this.v[a], vy = this.v[a + 1], vz = this.v[a + 2];
    const r = this.col[a], g = this.col[a + 1], b = this.col[a + 2], gen = this.gen[i] + 1, qq = [x, y, z, w];
    const f1 = 0.4 + Math.random() * 0.2, f2 = 0.4 + Math.random() * 0.2;
    this.state[i] = FREE; this.m[i * 16] = this.m[i * 16 + 5] = this.m[i * 16 + 10] = 0;
    for (let s1 = 0; s1 < 2; s1++) for (let s2 = 0; s2 < (two ? 2 : 1); s2++) {
      const nh = hs.slice();
      const k1 = s1 ? 1 - f1 : f1, k2 = two ? (s2 ? 1 - f2 : f2) : 1;
      nh[a1] = hs[a1] * k1; nh[a2] = hs[a2] * k2;
      const o1 = (s1 ? 1 : -1) * (hs[a1] - nh[a1]), o2 = two ? (s2 ? 1 : -1) * (hs[a2] - nh[a2]) : 0;
      const cx = px + R[a1][0] * o1 + R[a2][0] * o2, cy = py + R[a1][1] * o1 + R[a2][1] * o2, cz = pz + R[a1][2] * o1 + R[a2][2] * o2;
      const k = 0.25 * speed;
      this.spawn(cx, cy + 0.02, cz, nh[0] * 0.95, nh[1] * 0.95, nh[2] * 0.95,
        vx + (cx - px) * 1.2 + (Math.random() - 0.5) * k, vy + Math.random() * k * 0.6, vz + (cz - pz) * 1.2 + (Math.random() - 0.5) * k,
        r * (0.9 + Math.random() * 0.15), g * (0.9 + Math.random() * 0.15), b * (0.9 + Math.random() * 0.15), 2.5, 0, gen, qq);
    }
  }

  update(dt) {
    if (dt <= 0) return;
    const N = this.N, st = this.state, cfg = this.cfg, grid = this.grid;
    const P = this.p, V = this.v, W = this.w, H = this.h, Q = this.q;
    const G = cfg.gravity, REST = cfg.restitution;
    let active = 0, used = 0, dirty = false;
    this.impacts = 0;
    for (let i = 0; i < N; i++) {
      const s = st[i];
      if (s === FREE) continue;
      used++;
      if (s === SLEEP) { if ((this.ttl[i] -= dt) <= FADE) st[i] = DYING; continue; }
      if (s === DYING) {
        const t = (this.ttl[i] -= dt);
        if (t <= 0) { st[i] = FREE; const j = i * 16; this.m[j] = this.m[j + 5] = this.m[j + 10] = 0; } else this._write(i, t / FADE);
        dirty = true; continue;
      }
      active++; dirty = true;
      const a = i * 3, o = i * 4;
      let px = P[a], py = P[a + 1], pz = P[a + 2], vx = V[a], vy = V[a + 1], vz = V[a + 2];
      let wx = W[a], wy = W[a + 1], wz = W[a + 2];
      let qx = Q[o], qy = Q[o + 1], qz = Q[o + 2], qw = Q[o + 3];
      const hx = H[a], hy = H[a + 1], hz = H[a + 2];
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (sp > 32) { const k = 32 / sp; vx *= k; vy *= k; vz *= k; }
      const n = Math.min(4, Math.max(1, Math.ceil(sp * dt / 0.22))), h = dt / n;
      let grounded = false, hit = 0;
      for (let sub = 0; sub < n; sub++) {
        vy -= G * h; px += vx * h; py += vy * h; pz += vz * h;
        if (wx !== 0 || wy !== 0 || wz !== 0) {
          const k = 0.5 * h;
          const nx = qx + k * (wx * qw + wy * qz - wz * qy), ny = qy + k * (wy * qw + wz * qx - wx * qz), nz = qz + k * (wz * qw + wx * qy - wy * qx), nw = qw - k * (wx * qx + wy * qy + wz * qz);
          const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
          qx = nx * l; qy = ny * l; qz = nz * l; qw = nw * l;
        }
        const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qz * qw), r02 = 2 * (qx * qz + qy * qw);
        const r10 = 2 * (qx * qy + qz * qw), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qx * qw);
        const r20 = 2 * (qx * qz - qy * qw), r21 = 2 * (qy * qz + qx * qw), r22 = 1 - 2 * (qx * qx + qy * qy);
        const ex = Math.abs(r00) * hx + Math.abs(r01) * hy + Math.abs(r02) * hz;
        const ey = Math.abs(r10) * hx + Math.abs(r11) * hy + Math.abs(r12) * hz;
        const ez = Math.abs(r20) * hx + Math.abs(r21) * hy + Math.abs(r22) * hz;
        let onGround = false;
        const cell = grid.cellAt(px, pz);
        for (let pass = 0; pass < 2; pass++) {
          const list = pass ? grid.big : cell; if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const c = list[k], mn = c.min, mx = c.max;
            const ax = px + ex - mn.x, bx = mx.x - (px - ex); if (ax <= 0 || bx <= 0) continue;
            const ay = py + ey - mn.y, by = mx.y - (py - ey); if (ay <= 0 || by <= 0) continue;
            const az = pz + ez - mn.z, bz = mx.z - (pz - ez); if (az <= 0 || bz <= 0) continue;
            const penx = ax < bx ? ax : bx, peny = ay < by ? ay : by, penz = az < bz ? az : bz;
            if (peny <= penx && peny <= penz) {
              if (peny > 0.45 && !pass) continue; // buried: ignore rather than teleport
              if (by < ay) { // resting on top
                py += by; onGround = true;
                if (vy < 0) { if (-vy > hit) hit = -vy; vy = -vy > 1.4 ? -vy * REST : 0; }
              } else { py -= ay; if (vy > 0) vy = -vy * REST; }
            } else if (penx <= penz) {
              if (penx > 0.45) continue;
              if (ax < bx) { px -= ax; if (vx > 0) vx = -vx * REST; } else { px += bx; if (vx < 0) vx = -vx * REST; }
              vy *= 0.96; vz *= 0.9;
            } else {
              if (penz > 0.45) continue;
              if (az < bz) { pz -= az; if (vz > 0) vz = -vz * REST; } else { pz += bz; if (vz < 0) vz = -vz * REST; }
              vy *= 0.96; vx *= 0.9;
            }
          }
        }
        if (onGround) {
          grounded = true;
          const f = Math.exp(-7 * h); vx *= f; vz *= f;
          const fw = Math.exp(-9 * h); wx *= fw; wy *= fw; wz *= fw;
          // tip over onto a face, preferring the thin axis so plates end up lying flat
          const s0 = Math.abs(r10) / Math.sqrt(hx), s1 = Math.abs(r11) / Math.sqrt(hy), s2 = Math.abs(r12) / Math.sqrt(hz);
          let dx, dy, dz;
          if (s0 >= s1 && s0 >= s2) { dx = r00; dy = r10; dz = r20; } else if (s1 >= s2) { dx = r01; dy = r11; dz = r21; } else { dx = r02; dy = r12; dz = r22; }
          if (dy < 0) { dx = -dx; dy = -dy; dz = -dz; }
          const sn = Math.sqrt(dx * dx + dz * dz);
          if (sn > 0.02) {
            const ang = Math.atan2(sn, dy) * Math.min(1, 9 * h + 0.02), hs = Math.sin(ang * 0.5) / sn, cw = Math.cos(ang * 0.5);
            const bx = -dz * hs, bz = dx * hs; // rotation axis = d x up
            const nx = cw * qx + bx * qw - bz * qy, ny = cw * qy + bz * qx - bx * qz, nz = cw * qz + bz * qw + bx * qy, nw = cw * qw - bx * qx - bz * qz;
            qx = nx; qy = ny; qz = nz; qw = nw;
            this.rest[i] += h * 0.5;
          } else this.rest[i] += h * 3;
        }
      }
      if (hit > 1.5) {
        const k = hit * 0.9 / (hx + hy + hz + 0.1);
        wx += (Math.random() - 0.5) * k; wy += (Math.random() - 0.5) * k * 0.5; wz += (Math.random() - 0.5) * k;
      }
      P[a] = px; P[a + 1] = py; P[a + 2] = pz; V[a] = vx; V[a + 1] = vy; V[a + 2] = vz;
      W[a] = wx; W[a + 1] = wy; W[a + 2] = wz; Q[o] = qx; Q[o + 1] = qy; Q[o + 2] = qz; Q[o + 3] = qw;
      this.age[i] += dt;
      const big = Math.max(hx, hy, hz) * 2;
      if (hit > cfg.breakSpeed && big > cfg.breakSize && this.gen[i] < 2 && this.active < N * 0.55) {
        if (this.onImpact && this.impacts++ < 4) this.onImpact(px, py, pz, hit, big, this.col[a], this.col[a + 1], this.col[a + 2]);
        this._fracture(i, hit);
        continue;
      }
      if (hit > 4 && big > 0.5 && this.onImpact && this.impacts++ < 4) this.onImpact(px, py, pz, hit, big, this.col[a], this.col[a + 1], this.col[a + 2]);
      if (this.ttl[i] > 0) { // short-lived chip
        if ((this.ttl[i] -= dt) <= FADE) { st[i] = DYING; this.ttl[i] = FADE; }
      } else if ((grounded && vx * vx + vy * vy + vz * vz < 0.2 && this.rest[i] > 0.5) || this.age[i] > cfg.activeLife || py < -20) {
        st[i] = SLEEP; this.ttl[i] = cfg.rubbleLife * (0.7 + Math.random() * 0.6);
        V[a] = V[a + 1] = V[a + 2] = 0; W[a] = W[a + 1] = W[a + 2] = 0;
      }
      this._write(i, 1);
    }
    this.active = active; this.used = used;
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
