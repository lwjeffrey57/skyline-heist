import * as THREE from 'three';

// First-person controller. Position is the player's FEET; the body is an
// axis-aligned box (half-width R, height h) swept against the world's boxes.

const R = 0.35;
const STAND = 1.8, CROUCH = 1.0;
const GRAVITY = 24;
const WALK = 5.5, SPRINT = 8.6, CROUCH_SPEED = 3.0;
const JUMP = 8.4;
const STEP = 0.5;
const ZIP_SPEED = 15, ZIP_HANG = 2.1;

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

export class Player {
  constructor(camera, world, input, events = null) {
    this.camera = camera; this.world = world; this.input = input; this.events = events;
    this.team = 'player'; this.radius = R; this.maxHp = 100;
    this.speedScale = 1; this.fovScale = 1; // other systems may set these (e.g. aiming down sights)
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0; this.h = STAND;
    this.baseFov = camera.fov;
    this.respawn();
  }

  respawn() {
    if (this.pickSpawn) this.pickSpawn(); // director.js picks a safe spot
    this.pos.copy(this.world.spawn); this.vel.set(0, 0, 0);
    this.protectT = this.protectTime || 0;
    this.yaw = this.world.spawnYaw || 0; this.pitch = 0; this.h = STAND;
    this.grounded = false; this.sliding = false; this.crouching = false;
    this.state = 'normal'; this.coyote = 0; this.jumpBuffer = 0; this.slideCd = 0; this.mantleCd = 0; this.padCd = 0;
    this.eye = STAND - 0.15; this.stepSmooth = 0; this.dip = 0; this.dipV = 0; this.bob = 0; this.roll = 0; this.strafeLean = 0; this.leanV = 0;
    this.prompt = '';
    this.hp = this.maxHp; this.alive = true; this.hurtT = 99;
  }

  emit(name, data) { if (this.events) this.events.emit(name, data); }
  get height() { return this.h; }

  // info: { from: Vector3 (where the damage came from), source }
  takeDamage(amount, info = {}) {
    if (!this.alive || this.protectT > 0) return;
    this.hp -= amount; this.hurtT = 0;
    this.emit('playerDamaged', { amount, hp: this.hp, ...info });
    if (this.hp <= 0) { this.emit('playerDied', info); this.respawn(); this.emit('playerRespawned', {}); }
  }

  free(x, y, z, h) {
    for (const c of this.world.colliders) {
      if (x - R < c.max.x && x + R > c.min.x && y < c.max.y && y + h > c.min.y && z - R < c.max.z && z + R > c.min.z) return false;
    }
    return true;
  }

  moveAxis(axis, delta) {
    if (delta === 0) return;
    const p = this.pos; p[axis] += delta;
    for (const c of this.world.colliders) {
      if (!(p.x - R < c.max.x && p.x + R > c.min.x && p.y < c.max.y && p.y + this.h > c.min.y && p.z - R < c.max.z && p.z + R > c.min.z)) continue;
      if (axis === 'y') {
        if (delta < 0) { p.y = c.max.y; this.hitGround = true; } else p.y = c.min.y - this.h - 1e-4;
        continue;
      }
      const up = c.max.y - p.y;
      if ((this.grounded || this.coyote > 0) && up > 0 && up <= STEP && this.free(p.x, c.max.y, p.z, this.h)) {
        p.y = c.max.y; this.stepSmooth -= up; continue; // walk up a step
      }
      p[axis] = delta > 0 ? c.min[axis] - R - 1e-4 : c.max[axis] + R + 1e-4;
      this.vel[axis] = 0; this.blocked = true;
    }
  }

  groundBelow(maxDist) {
    const p = this.pos; let best = -Infinity;
    for (const c of this.world.colliders) {
      if (p.x - R < c.max.x && p.x + R > c.min.x && p.z - R < c.max.z && p.z + R > c.min.z
        && c.max.y <= p.y + 1e-4 && c.max.y >= p.y - maxDist && c.max.y > best) best = c.max.y;
    }
    return best;
  }

  tryMantle(fx, fz) {
    const p = this.pos, px = p.x + fx * (R + 0.5), pz = p.z + fz * (R + 0.5);
    let best = Infinity;
    for (const c of this.world.colliders) {
      if (!(px - R < c.max.x && px + R > c.min.x && pz - R < c.max.z && pz + R > c.min.z)) continue;
      const top = c.max.y;
      if (top <= p.y + STEP || top > p.y + 2.5 || top >= best) continue;
      if (this.free(px, top + 0.01, pz, CROUCH) && this.free(p.x, top + 0.01, p.z, CROUCH)) best = top;
    }
    if (best === Infinity) return false;
    this.state = 'mantle';
    this.mFrom = p.clone(); this.mTo = new THREE.Vector3(px, best + 0.01, pz);
    this.mT = 0; this.mDur = 0.22 + (best - p.y) * 0.09;
    this.h = CROUCH; this.crouching = true; this.sliding = false;
    this.mDir = new THREE.Vector3(fx, 0, fz);
    this.emit('mantle', {});
    return true;
  }

  nearestZip() {
    const head = new THREE.Vector3(this.pos.x, this.pos.y + this.h, this.pos.z);
    let best = null;
    for (const z of this.world.ziplines) {
      const raw = THREE.MathUtils.clamp(head.clone().sub(z.a).dot(z.dir), 0, z.len);
      const d = z.a.clone().addScaledVector(z.dir, raw).distanceTo(head);
      const t = THREE.MathUtils.clamp(raw, 1.8, z.len - 1.8);
      if (d < 3.4 && (!best || d < best.d)) best = { z, t, d };
    }
    return best;
  }

  update(dt) {
    const inp = this.input;
    this.slideCd -= dt; this.mantleCd -= dt; this.padCd -= dt;
    if (this.protectT > 0) this.protectT -= dt;
    this.hurtT += dt; if (this.hurtT > 5 && this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + 25 * dt);
    if (inp.pressed.has('Space')) this.jumpBuffer = 0.14; else this.jumpBuffer -= dt;
    if ((inp.pressed.has('KeyK') && !this.noManualRespawn) || this.pos.y < -30) this.respawn();

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const fx = -sin, fz = -cos; // forward on the ground plane
    const mf = (inp.down('KeyW') ? 1 : 0) - (inp.down('KeyS') ? 1 : 0);
    const ms = (inp.down('KeyD') ? 1 : 0) - (inp.down('KeyA') ? 1 : 0);
    let wx = fx * mf + cos * ms, wz = fz * mf - sin * ms;
    const wl = Math.hypot(wx, wz); if (wl > 0) { wx /= wl; wz /= wl; }
    const wantCrouch = inp.down('KeyC') || inp.down('ControlLeft');
    this.prompt = '';

    if (this.state === 'mantle') {
      this.mT += dt / this.mDur;
      const t = Math.min(1, this.mT);
      const up = Math.min(1, t / 0.65), fwd = Math.max(0, (t - 0.45) / 0.55);
      const e = (k) => k * k * (3 - 2 * k);
      this.pos.x = THREE.MathUtils.lerp(this.mFrom.x, this.mTo.x, e(fwd));
      this.pos.z = THREE.MathUtils.lerp(this.mFrom.z, this.mTo.z, e(fwd));
      this.pos.y = THREE.MathUtils.lerp(this.mFrom.y, this.mTo.y, e(up));
      if (t >= 1) {
        this.state = 'normal'; this.vel.set(this.mDir.x * 4.5, 0, this.mDir.z * 4.5);
        this.grounded = true; this.mantleCd = 0.25;
      }
    } else if (this.state === 'zip') {
      const z = this.zip;
      this.zipT += this.zipSign * ZIP_SPEED * dt;
      const pt = z.a.clone().addScaledVector(z.dir, this.zipT);
      this.pos.set(pt.x, pt.y - ZIP_HANG, pt.z);
      this.vel.copy(z.dir).multiplyScalar(this.zipSign * ZIP_SPEED);
      const done = z.dead || this.zipT < 1.8 || this.zipT > z.len - 1.8;
      if (done || this.jumpBuffer > 0) {
        this.state = 'normal'; this.grounded = false; this.mantleCd = 0.15; this.emit('zipEnd', {});
        if (!done) { this.vel.y += 6.5; this.jumpBuffer = 0; }
      }
    } else {
      this.updateNormal(dt, wx, wz, mf, ms, fx, fz, wantCrouch);
    }

    // ---- camera -----------------------------------------------------------
    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.eye = damp(this.eye, this.h - 0.15, 14, dt);
    this.stepSmooth = damp(this.stepSmooth, 0, 16, dt);
    this.dipV += (-180 * this.dip - 22 * this.dipV) * dt; this.dip += this.dipV * dt;
    let bobY = 0, bobX = 0;
    if (this.state === 'normal' && this.grounded && !this.sliding && hs > 1) {
      const prevStep = Math.floor(this.bob * 2 / Math.PI);
      this.bob += hs * dt * 1.55;
      if (Math.floor(this.bob * 2 / Math.PI) !== prevStep) this.emit('footstep', { speed: hs });
      bobY = Math.sin(this.bob * 2) * 0.03 * Math.min(1, hs / SPRINT);
      bobX = Math.sin(this.bob) * 0.014 * Math.min(1, hs / SPRINT); // weight shifting from foot to foot
    }
    // lean into strafes: a slightly springy value in [-1, 1] that overshoots a touch when you stop or reverse
    const sideSpeed = this.vel.x * cos - this.vel.z * sin;
    const leanTarget = this.state === 'normal' && this.grounded && !this.sliding ? THREE.MathUtils.clamp(sideSpeed / WALK, -1, 1) : 0;
    this.leanV += (-110 * (this.strafeLean - leanTarget) - 15 * this.leanV) * dt; this.strafeLean += this.leanV * dt;
    const rollTarget = this.sliding ? 0.07 : this.state === 'zip' ? 0.03 : -this.strafeLean * 0.034;
    this.roll = damp(this.roll, rollTarget, 14, dt);
    const side = this.strafeLean * 0.05 + bobX;
    const cam = this.camera;
    cam.position.set(this.pos.x + cos * side, this.pos.y + this.eye + this.stepSmooth + this.dip + bobY - Math.abs(this.strafeLean) * 0.012, this.pos.z - sin * side);
    cam.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    const fovTarget = this.baseFov * this.fovScale + THREE.MathUtils.clamp((hs - WALK) * 1.9, 0, 16);
    cam.fov = damp(cam.fov, fovTarget, 7, dt); cam.updateProjectionMatrix();
  }

  updateNormal(dt, wx, wz, mf, ms, fx, fz, wantCrouch) {
    const v = this.vel, inp = this.input;
    let hs = Math.hypot(v.x, v.z);
    const sprinting = inp.down('ShiftLeft') && mf > 0 && !this.crouching;
    let jumped = false;

    if (this.grounded) {
      // start / stop sliding (also when landing with crouch held)
      if (!this.sliding && wantCrouch && (!this.crouching || this.justLanded) && hs > 6.2) {
        this.sliding = true; this.emit('slideStart', {});
        if (this.slideCd <= 0 && hs > 0) { const b = Math.min(hs + 3.2, 13.5) / hs; v.x *= b; v.z *= b; this.slideCd = 1.1; }
      }
      if (this.sliding && (!wantCrouch || hs < 3.6)) this.sliding = false;
      this.crouching = wantCrouch || this.sliding;

      if (this.sliding) {
        const drop = 4.2 * dt; hs = Math.hypot(v.x, v.z);
        if (hs > 0) { const k = Math.max(0, hs - drop) / hs; v.x *= k; v.z *= k; }
        // gentle steering: rotate velocity toward the input direction
        if (wx || wz) { const s = Math.hypot(v.x, v.z); v.x += wx * 6 * dt; v.z += wz * 6 * dt; const n = Math.hypot(v.x, v.z); if (n > 0) { v.x *= s / n; v.z *= s / n; } }
      } else {
        hs = Math.hypot(v.x, v.z);
        if (hs > 0) { const drop = Math.max(hs, 2.2) * 8 * dt; const k = Math.max(0, hs - drop) / hs; v.x *= k; v.z *= k; }
        // a body has inertia: backing up and side-stepping are a little slower than running forward
        const dirScale = mf < 0 ? 0.84 : mf === 0 && ms !== 0 ? 0.92 : 1;
        const max = (this.crouching ? CROUCH_SPEED : sprinting ? SPRINT : WALK) * this.speedScale * dirScale;
        const cur = v.x * wx + v.z * wz, add = Math.min(Math.max(0, max - cur), 78 * dt);
        v.x += wx * add; v.z += wz * add;
      }
    } else {
      this.crouching = wantCrouch; this.sliding = false;
      // air control: steer freely, but never gain speed beyond what you had
      const before = Math.max(hs, WALK);
      v.x += wx * 22 * dt; v.z += wz * 22 * dt;
      const after = Math.hypot(v.x, v.z);
      if (after > before) { v.x *= before / after; v.z *= before / after; }
    }

    if (this.jumpBuffer > 0 && (this.grounded || this.coyote > 0)) {
      v.y = JUMP; this.grounded = false; this.coyote = 0; this.jumpBuffer = 0; jumped = true; this.emit('jump', {});
    }
    v.y -= GRAVITY * dt; if (v.y < -55) v.y = -55;

    // body height (only stand up if there is headroom)
    const wantH = this.crouching ? CROUCH : STAND;
    if (wantH < this.h) this.h = wantH;
    else if (wantH > this.h) { if (this.free(this.pos.x, this.pos.y + 1e-3, this.pos.z, STAND)) this.h = STAND; else this.crouching = true; }

    // sweep
    const wasGrounded = this.grounded, fallSpeed = -v.y;
    this.justLanded = false;
    this.hitGround = false; this.blocked = false;
    const dist = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)) * dt;
    const n = Math.max(1, Math.ceil(dist / 0.25));
    for (let i = 0; i < n; i++) {
      this.moveAxis('x', (v.x * dt) / n);
      this.moveAxis('z', (v.z * dt) / n);
      const vy = v.y; this.moveAxis('y', (vy * dt) / n);
      if (this.hitGround) v.y = 0;
    }
    // head bump
    if (v.y > 0 && !this.free(this.pos.x, this.pos.y + 0.02, this.pos.z, this.h)) v.y = 0;

    this.grounded = this.hitGround;
    if (!this.grounded && wasGrounded && !jumped && v.y <= 0) {
      const g = this.groundBelow(0.45); // stick to stairs on the way down
      if (g > -Infinity) { this.stepSmooth += this.pos.y - g; this.pos.y = g; this.grounded = true; v.y = 0; }
    }
    if (this.grounded) {
      this.coyote = 0.12;
      if (!wasGrounded) {
        this.justLanded = true; this.emit('land', { speed: fallSpeed });
        this.dipV -= Math.min(fallSpeed, 26) * 0.11;
      }
    } else this.coyote -= dt;

    // jump pads
    if (this.padCd <= 0) {
      for (const p of this.world.pads) {
        if (Math.abs(this.pos.y - p.y) < 0.4 && Math.hypot(this.pos.x - p.x, this.pos.z - p.z) < p.r) {
          v.x = v.x * 0.35 + p.vel.x; v.z = v.z * 0.35 + p.vel.z; v.y = p.vel.y;
          this.grounded = false; this.coyote = 0; this.sliding = false; this.padCd = 0.4; p.pulse = 1; this.emit('pad', { x: p.x, z: p.z });
        }
      }
    }

    // mantle
    if (!this.grounded && this.blocked && mf > 0 && v.y > -14 && this.mantleCd <= 0) this.tryMantle(fx, fz);

    // ziplines
    const near = this.nearestZip();
    if (near && this.state === 'normal') {
      this.prompt = '<b>E</b> — ride zipline';
      if (inp.pressed.has('KeyE')) {
        const look = new THREE.Vector3(fx * Math.cos(this.pitch), Math.sin(this.pitch), fz * Math.cos(this.pitch));
        this.emit('zipStart', {});
        this.state = 'zip'; this.zip = near.z; this.zipT = near.t; this.zipSign = look.dot(near.z.dir) >= 0 ? 1 : -1;
        if (near.t <= 1.81) this.zipSign = 1; if (near.t >= near.z.len - 1.81) this.zipSign = -1;
        this.sliding = false; this.crouching = false; this.h = STAND; this.grounded = false;
      }
    }
  }

  get label() {
    if (this.state === 'zip') return 'zipline';
    if (this.state === 'mantle') return 'climb';
    if (this.sliding) return 'slide';
    if (!this.grounded) return 'air';
    if (this.crouching) return 'crouch';
    return Math.hypot(this.vel.x, this.vel.z) > WALK + 0.5 ? 'sprint' : 'run';
  }
}
