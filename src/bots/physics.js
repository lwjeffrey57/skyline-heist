// Bot body physics: the same swept axis-aligned box, gravity and stair step-up as the
// player controller (player.js), minus crouch / slide / mantle. Position is the FEET.

export const R = 0.35, H = 1.8, GRAVITY = 24, STEP = 0.5, JUMP = 8.4;

const near = [];

function gather(cols, p, reach) {
  near.length = 0;
  const x0 = p.x - R - reach, x1 = p.x + R + reach, z0 = p.z - R - reach, z1 = p.z + R + reach;
  const y0 = p.y - reach - 0.6, y1 = p.y + H + reach + 0.6;
  for (let i = 0, n = cols.length; i < n; i++) {
    const c = cols[i];
    if (x0 < c.max.x && x1 > c.min.x && z0 < c.max.z && z1 > c.min.z && y0 < c.max.y && y1 > c.min.y) near.push(c);
  }
}

function free(x, y, z, h) {
  for (let i = 0; i < near.length; i++) {
    const c = near[i];
    if (x - R < c.max.x && x + R > c.min.x && y < c.max.y && y + h > c.min.y && z - R < c.max.z && z + R > c.min.z) return false;
  }
  return true;
}

export function bodyFree(cols, x, y, z, h = H) {
  for (let i = 0, n = cols.length; i < n; i++) {
    const c = cols[i];
    if (x - R < c.max.x && x + R > c.min.x && y < c.max.y && y + h > c.min.y && z - R < c.max.z && z + R > c.min.z) return false;
  }
  return true;
}

function moveAxis(b, axis, delta) {
  if (delta === 0) return;
  const p = b.pos; p[axis] += delta;
  for (let i = 0; i < near.length; i++) {
    const c = near[i];
    if (!(p.x - R < c.max.x && p.x + R > c.min.x && p.y < c.max.y && p.y + H > c.min.y && p.z - R < c.max.z && p.z + R > c.min.z)) continue;
    if (axis === 'y') {
      if (delta < 0) { p.y = c.max.y; b.hitGround = true; } else p.y = c.min.y - H - 1e-4;
      continue;
    }
    const up = c.max.y - p.y;
    if ((b.grounded || b.coyote > 0) && up > 0 && up <= STEP && free(p.x, c.max.y, p.z, H)) { p.y = c.max.y; continue; }
    p[axis] = delta > 0 ? c.min[axis] - R - 1e-4 : c.max[axis] + R + 1e-4;
    b.vel[axis] = 0; b.blocked = true;
  }
}

export function makeBody(pos, vel) {
  return { pos, vel, grounded: false, coyote: 0, hitGround: false, blocked: false, padCd: 0, landed: false, landSpeed: 0, airTime: 0 };
}

// Advance a body by dt. (wx, wz) is the wished unit direction (or 0,0), maxSpeed the wished speed.
// Returns the jump pad that launched the body this step, or null.
export function stepBody(b, world, dt, wx, wz, maxSpeed, accel = 60, usePads = true, padR = 0) {
  const v = b.vel, p = b.pos;
  b.padCd -= dt;
  let hs = Math.hypot(v.x, v.z);
  if (b.grounded) {
    if (hs > 0) { const drop = Math.max(hs, 2.5) * 8 * dt; const k = Math.max(0, hs - drop) / hs; v.x *= k; v.z *= k; }
    const cur = v.x * wx + v.z * wz, add = Math.min(Math.max(0, maxSpeed - cur), accel * dt);
    v.x += wx * add; v.z += wz * add;
  } else if (wx || wz) {
    const before = Math.max(hs, 3);
    v.x += wx * 14 * dt; v.z += wz * 14 * dt;
    const after = Math.hypot(v.x, v.z);
    if (after > before) { v.x *= before / after; v.z *= before / after; }
  }
  v.y -= GRAVITY * dt; if (v.y < -55) v.y = -55;

  const wasGrounded = b.grounded, fallSpeed = -v.y;
  b.hitGround = false; b.blocked = false; b.landed = false;
  const dist = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)) * dt;
  gather(world.colliders, p, dist + 0.2);
  const n = Math.max(1, Math.ceil(dist / 0.25));
  for (let i = 0; i < n; i++) {
    moveAxis(b, 'x', (v.x * dt) / n);
    moveAxis(b, 'z', (v.z * dt) / n);
    moveAxis(b, 'y', (v.y * dt) / n);
    if (b.hitGround) v.y = 0;
  }
  if (v.y > 0 && !free(p.x, p.y + 0.02, p.z, H)) v.y = 0;

  b.grounded = b.hitGround;
  if (!b.grounded && wasGrounded && v.y <= 0) { // stick to stairs on the way down
    let best = -Infinity;
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (p.x - R < c.max.x && p.x + R > c.min.x && p.z - R < c.max.z && p.z + R > c.min.z
        && c.max.y <= p.y + 1e-4 && c.max.y >= p.y - 0.45 && c.max.y > best) best = c.max.y;
    }
    if (best > -Infinity) { p.y = best; b.grounded = true; v.y = 0; }
  }
  if (b.grounded) {
    b.coyote = 0.12;
    if (!wasGrounded) { b.landed = true; b.landSpeed = fallSpeed; }
    b.airTime = 0;
  } else { b.coyote -= dt; b.airTime += dt; }

  if (usePads && b.padCd <= 0) {
    for (const pad of world.pads) {
      if (Math.abs(p.y - pad.y) < 0.4 && Math.hypot(p.x - pad.x, p.z - pad.z) < (padR || pad.r)) {
        v.x = pad.vel.x; v.z = pad.vel.z; v.y = pad.vel.y; // bots brace: no carried speed, so the arc is predictable
        b.grounded = false; b.coyote = 0; b.padCd = 0.4;
        return pad;
      }
    }
  }
  return null;
}
