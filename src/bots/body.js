import * as THREE from 'three';

// =============================================================================
// Bot body: an original "Warden" security android built from primitives.
// Dark under-suit, pale ceramic armour plates, a finned helmet with a glowing
// wrap-around visor, glowing chest core / pack vents in the team colour, and a
// boxy carbine. Fully procedural animation:
//   legs  — two-bone IK driven by a gait cycle synced to ground speed and direction
//   arms  — two-bone IK onto the weapon, which points exactly along the aim direction
//   torso — twists toward the aim, leans into movement, flinches when hit
//   death — knees buckle, the body topples away from the shot, the weapon drops, then it fades
// Local space: +Y up, +Z forward, -X is the bot's right-hand side.
// =============================================================================

const HIP_Y = 0.94, WAIST = 0.08, SHOULDER_Y = 0.44, SHOULDER_X = 0.21, NECK_Y = 0.57;
const ARM1 = 0.3, ARM2 = 0.29, LEG1 = 0.43, LEG2 = 0.42, ANKLE = 0.09, HIP_X = 0.1;
const GUN_POS = new THREE.Vector3(-0.1, 0.4, 0.03), GUN_RELAX_POS = new THREE.Vector3(-0.13, 0.3, 0.06);
const GRIP_R = new THREE.Vector3(0, -0.1, 0.17), GRIP_L = new THREE.Vector3(0.005, -0.065, 0.39);
const DOWN = new THREE.Vector3(0, -1, 0);
const Q_RELAX = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.62, 0.55, 0.15, 'YXZ'));

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3(), v5 = new THREE.Vector3();
const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), q3 = new THREE.Quaternion();
const e1 = new THREE.Euler();

let G = null; // shared geometries
function geos() {
  if (G) return G;
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const cyl = (rt, rb, h, seg = 10) => new THREE.CylinderGeometry(rt, rb, h, seg);
  G = {
    pelvis: box(0.3, 0.17, 0.2), hipPlate: box(0.07, 0.16, 0.16), belt: cyl(0.14, 0.15, 0.06, 12),
    abdomen: cyl(0.135, 0.125, 0.22, 12), chest: box(0.4, 0.3, 0.25), chestPlate: box(0.3, 0.2, 0.07), ribs: box(0.34, 0.07, 0.05),
    core: cyl(0.036, 0.036, 0.03, 6), collar: cyl(0.085, 0.11, 0.07, 12), pack: box(0.27, 0.3, 0.13), vent: box(0.035, 0.17, 0.02),
    shoulder: new THREE.SphereGeometry(0.098, 14, 10), antenna: cyl(0.007, 0.009, 0.36, 5), tip: new THREE.SphereGeometry(0.018, 8, 6),
    helmet: new THREE.SphereGeometry(0.125, 18, 14), visor: new THREE.CylinderGeometry(0.124, 0.118, 0.052, 20, 1, true, -1.25, 2.5),
    jaw: box(0.15, 0.075, 0.1), fin: box(0.022, 0.075, 0.2), ear: cyl(0.04, 0.04, 0.03, 10),
    upperArm: new THREE.CapsuleGeometry(0.05, 0.2, 4, 10), foreArm: cyl(0.058, 0.045, 0.25, 10), bracer: box(0.1, 0.16, 0.085), hand: new THREE.SphereGeometry(0.05, 10, 8),
    thigh: new THREE.CapsuleGeometry(0.078, 0.27, 4, 10), thighPlate: box(0.13, 0.24, 0.05), shin: cyl(0.075, 0.055, 0.38, 10), knee: new THREE.SphereGeometry(0.072, 10, 8),
    shinPlate: box(0.1, 0.26, 0.05), foot: box(0.115, 0.09, 0.27),
    gunBody: box(0.06, 0.11, 0.34), gunStock: box(0.045, 0.09, 0.17), gunShroud: box(0.05, 0.065, 0.22), gunBarrel: cyl(0.016, 0.016, 0.3, 8),
    gunBrake: cyl(0.025, 0.025, 0.07, 8), gunMag: box(0.04, 0.17, 0.075), gunGrip: box(0.04, 0.1, 0.05), gunRail: box(0.014, 0.014, 0.26), gunSight: box(0.03, 0.045, 0.05),
    bar: new THREE.PlaneGeometry(1, 1),
  };
  G.bar.translate(0.5, 0, 0);
  return G;
}

// two-bone IK: joint position for a chain S -> T with bone lengths l1, l2, bending toward `pole`
function solveJoint(S, T, l1, l2, pole, out) {
  v1.subVectors(T, S);
  let d = v1.length(); if (d < 1e-4) { v1.set(0, -1, 0); d = 1e-4; }
  v1.divideScalar(d);
  d = Math.min(d, l1 + l2 - 1e-3);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  v2.copy(pole).addScaledVector(v1, -pole.dot(v1));
  if (v2.lengthSq() < 1e-6) v2.set(0, 0, 1); v2.normalize();
  return out.copy(S).addScaledVector(v1, a).addScaledVector(v2, h);
}
function pointLimb(group, from, to) {
  group.position.copy(from);
  v1.subVectors(to, from).normalize();
  group.quaternion.setFromUnitVectors(DOWN, v1);
}

export class BotBody {
  constructor(scene, accentColor) {
    this.scene = scene;
    const g = geos();
    const M = this.mats = {
      suit: new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.82, metalness: 0.1 }),
      armor: new THREE.MeshStandardMaterial({ color: 0x343a44, roughness: 0.42, metalness: 0.65 }),
      plate: new THREE.MeshStandardMaterial({ color: 0xd3cbbb, roughness: 0.5, metalness: 0.08 }),
      accent: new THREE.MeshStandardMaterial({ color: 0x180804, emissive: accentColor, emissiveIntensity: 4.5, roughness: 0.4 }),
      gun: new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.38, metalness: 0.85 }),
    };
    M.visor = M.accent.clone(); M.visor.side = THREE.DoubleSide;
    this.matList = Object.values(M);
    const add = (parent, geo, mat, x = 0, y = 0, z = 0, shadow = true) => {
      const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = shadow; m.userData.sh = shadow; m.receiveShadow = true; parent.add(m); return m;
    };
    const grp = (parent, x = 0, y = 0, z = 0) => { const o = new THREE.Group(); o.position.set(x, y, z); parent.add(o); return o; };

    this.root = new THREE.Group(); scene.add(this.root);
    this.tilt = grp(this.root);
    this.hips = grp(this.tilt, 0, HIP_Y, 0);
    add(this.hips, g.pelvis, M.suit, 0, -0.02, 0);
    add(this.hips, g.belt, M.armor, 0, 0.07, 0);
    add(this.hips, g.hipPlate, M.plate, 0.165, -0.03, 0); add(this.hips, g.hipPlate, M.plate, -0.165, -0.03, 0);

    const T = this.torso = grp(this.hips, 0, WAIST, 0);
    add(T, g.abdomen, M.suit, 0, 0.11, 0);
    add(T, g.ribs, M.armor, 0, 0.15, 0.1, false);
    add(T, g.chest, M.armor, 0, 0.33, 0);
    add(T, g.chestPlate, M.plate, 0, 0.36, 0.115).rotation.x = -0.12;
    const core = add(T, g.core, M.accent, 0, 0.37, 0.158, false); core.rotation.x = Math.PI / 2;
    add(T, g.collar, M.suit, 0, 0.5, 0);
    add(T, g.pack, M.armor, 0, 0.33, -0.185);
    add(T, g.vent, M.accent, 0.075, 0.33, -0.255, false); add(T, g.vent, M.accent, -0.075, 0.33, -0.255, false);
    for (const s of [1, -1]) { const sp = add(T, g.shoulder, M.plate, s * 0.235, 0.465, 0); sp.scale.set(1.12, 0.85, 1.15); }
    const ant = add(T, g.antenna, M.gun, 0.1, 0.62, -0.21, false); ant.rotation.z = -0.1;
    add(T, g.tip, M.accent, 0.118, 0.8, -0.21, false);

    const Hd = this.head = grp(T, 0, NECK_Y, 0);
    add(Hd, g.helmet, M.plate, 0, 0.1, 0).scale.set(0.95, 1.04, 1.08);
    add(Hd, g.visor, M.visor, 0, 0.105, 0.012, false).scale.set(0.99, 1, 1.1);
    add(Hd, g.jaw, M.armor, 0, 0.015, 0.075);
    add(Hd, g.fin, M.armor, 0, 0.215, -0.03);
    for (const s of [1, -1]) add(Hd, g.ear, M.armor, s * 0.118, 0.09, -0.01).rotation.z = Math.PI / 2;

    // weapon (origin = the stock against the shoulder, pointing +Z)
    const W = this.gun = grp(T);
    add(W, g.gunStock, M.gun, 0, -0.012, 0.065);
    add(W, g.gunBody, M.gun, 0, 0, 0.3);
    add(W, g.gunShroud, M.armor, 0, 0.005, 0.56);
    add(W, g.gunBarrel, M.gun, 0, 0.012, 0.7).rotation.x = Math.PI / 2;
    add(W, g.gunBrake, M.gun, 0, 0.012, 0.84).rotation.x = Math.PI / 2;
    add(W, g.gunMag, M.plate, 0, -0.125, 0.33).rotation.x = 0.18;
    add(W, g.gunGrip, M.gun, 0, -0.095, 0.17).rotation.x = -0.25;
    add(W, g.gunRail, M.accent, 0, 0.064, 0.34, false);
    add(W, g.gunSight, M.gun, 0, 0.075, 0.2, false);

    // arms (IK, torso space)
    this.arm = [];
    for (const s of [-1, 1]) { // -1 = right (weapon hand), 1 = left (support hand)
      const up = grp(T), lo = grp(T);
      add(up, g.upperArm, M.suit, 0, -ARM1 / 2, 0);
      add(lo, g.foreArm, M.suit, 0, -0.125, 0);
      add(lo, g.bracer, M.plate, 0, -0.12, -0.012);
      add(lo, g.hand, M.suit, 0, -ARM2 + 0.01, 0);
      this.arm.push({ s, up, lo, S: new THREE.Vector3(s * SHOULDER_X, SHOULDER_Y, 0), pole: new THREE.Vector3(s * 0.7, -1, -0.25), hand: new THREE.Vector3() });
    }
    // legs (IK, root space)
    this.leg = [];
    for (const s of [1, -1]) {
      const th = grp(this.tilt), sh = grp(this.tilt), ft = grp(this.tilt);
      add(th, g.thigh, M.suit, 0, -LEG1 / 2, 0);
      add(th, g.thighPlate, M.plate, s * 0.02, -0.2, 0.062);
      add(sh, g.knee, M.armor, 0, 0, 0.02);
      add(sh, g.shin, M.suit, 0, -0.2, 0);
      add(sh, g.shinPlate, M.plate, 0, -0.2, 0.045);
      add(ft, g.foot, M.armor, 0, 0.045, 0.045);
      this.leg.push({ s, th, sh, ft, foot: new THREE.Vector3(s * HIP_X, 0, 0) });
    }

    // health bar (world-space, faces the camera, shown for a few seconds after damage)
    this.bar = new THREE.Group(); this.bar.visible = false; scene.add(this.bar);
    const bm = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, fog: false, toneMapped: false });
    const bg = new THREE.Mesh(g.bar, bm(0x05070a, 0.65)); bg.scale.set(0.66, 0.085, 1); bg.position.x = -0.33; this.bar.add(bg);
    this.barFill = new THREE.Mesh(g.bar, bm(accentColor, 0.95)); this.barFill.scale.set(0.62, 0.05, 1); this.barFill.position.set(-0.31, 0, 0.002); this.bar.add(this.barFill);
    this.bar.renderOrder = 5;

    this.gunVel = new THREE.Vector3(); this.gunSpin = new THREE.Vector3();
    this.fallAxis = new THREE.Vector3(1, 0, 0);
    this.reset();
  }

  reset() {
    this.phase = Math.random() * 6; this.visY = null; this.mx = 0; this.mz = 1; this.sn = 0; this.air = 0;
    this.flP = 0; this.flR = 0; this.flPV = 0; this.flRV = 0; this.kick = 0; this.aimBlend = 0; this.twist = 0; this.lean = 0; this.leanS = 0;
    this.dead = false; this.deadT = 0; this.fall = 0; this.fallV = 0; this.limp = 0; this.gunLoose = false; this.gunRest = false;
    this.tilt.quaternion.identity(); this.tilt.position.set(0, 0, 0);
    this.torso.add(this.gun); this.gun.scale.setScalar(1);
    this.setOpacity(1);
    this.root.visible = true; this.gun.visible = true; this.bar.visible = false;
    this.setShadows(true);
  }

  setShadows(on) {
    const f = (o) => { if (o.isMesh) o.castShadow = on && o.userData.sh; };
    this.root.traverse(f); this.gun.traverse(f);
  }

  setOpacity(o) {
    if (this.opacity === o) return; this.opacity = o;
    for (const m of this.matList) { m.transparent = o < 1; m.opacity = o; m.depthWrite = o > 0.5; }
  }

  hide() { this.root.visible = false; this.gun.visible = false; this.bar.visible = false; }

  // impulse in the bot's local frame (lx: toward its left, lz: forward) — positive lz = hit from behind
  flinch(lx, lz, strength = 1) { this.flPV += lz * 5.5 * strength; this.flRV += -lx * 5.5 * strength; }
  fireKick() { this.kick = 1; }

  // start the collapse; (lx, lz) = local direction the body should fall toward
  die(lx, lz, worldVel) {
    this.dead = true; this.deadT = 0; this.fall = 0.05; this.fallV = 1.6; this.limp = 0;
    const l = Math.hypot(lx, lz) || 1; this.fallAxis.set(lz / l, 0, -lx / l);
    // drop the weapon: hand it over to the scene with a little toss
    this.root.updateMatrixWorld(true);
    this.scene.attach(this.gun); this.gunLoose = true; this.gunRest = false;
    this.gunVel.set((Math.random() - 0.5) * 1.5, 1.6, (Math.random() - 0.5) * 1.5); if (worldVel) this.gunVel.addScaledVector(worldVel, 0.6);
    this.gunSpin.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 6);
    this.bar.visible = false;
  }

  // s: { pos, bodyYaw, aimYaw, aimPitch, vel, grounded, aiming (0..1 target), hp01, showBar, camera, floorY }
  update(dt, s) {
    const root = this.root;
    // smooth the vertical snap of stair steps
    if (this.visY === null || Math.abs(this.visY - s.pos.y) > 0.7) this.visY = s.pos.y;
    this.visY = s.grounded ? damp(this.visY, s.pos.y, 20, dt) : s.pos.y;
    root.position.set(s.pos.x, this.visY, s.pos.z);
    root.rotation.y = s.bodyYaw;

    if (this.dead) { this.updateDeath(dt, s); return; }

    // ---- gait -------------------------------------------------------------
    const sin = Math.sin(s.bodyYaw), cos = Math.cos(s.bodyYaw);
    const lf = s.vel.x * sin + s.vel.z * cos, ls = s.vel.x * cos - s.vel.z * sin; // forward / leftward speed
    const speed = Math.hypot(lf, ls);
    const sn = this.sn = damp(this.sn, Math.min(1, speed / 5.5), 10, dt);
    if (speed > 0.3) { this.mx = damp(this.mx, ls / speed, 12, dt); this.mz = damp(this.mz, lf / speed, 12, dt); }
    const stepLen = 0.55 + 0.07 * speed;
    this.phase += dt * Math.PI * speed / stepLen;
    this.air = damp(this.air, s.grounded ? 0 : 1, s.grounded ? 14 : 8, dt);
    const amp = stepLen * 0.46 * Math.min(1, speed / 1.2), liftH = 0.07 + 0.035 * sn + (speed > 6.5 ? 0.05 : 0);
    const bob = Math.cos(this.phase * 2) * 0.028 * sn;
    const hipY = HIP_Y - 0.05 * sn - (speed > 6.5 ? 0.03 : 0) + bob - 0.02 * this.air + Math.sin(performance.now() * 0.0017 + this.phase0()) * 0.004;
    this.hips.position.set(Math.sin(this.phase) * 0.018 * sn, hipY, 0);
    this.hips.rotation.set(0, Math.sin(this.phase) * 0.1 * sn * this.mz, 0);

    for (let i = 0; i < 2; i++) {
      const L = this.leg[i], ph = this.phase + (i ? Math.PI : 0), p = Math.sin(ph), c = Math.cos(ph);
      const lift = Math.max(0, c) * liftH * Math.min(1, speed / 1.0);
      v3.set(L.s * HIP_X + this.mx * amp * p, lift, this.mz * amp * p);
      // airborne: tuck one leg, trail the other
      v4.set(L.s * (HIP_X + 0.02), i ? 0.2 : 0.1, i ? 0.16 : -0.14);
      L.foot.copy(v3).lerp(v4, this.air);
      v3.set(this.hips.position.x + L.s * HIP_X, hipY - 0.05, 0);       // hip joint
      v4.copy(L.foot); v4.y += ANKLE;                                    // ankle
      // out of reach (trailing foot of a long stride): pull the ankle in, which lifts the heel naturally
      let over = 0; { const dd = v4.distanceTo(v3), mx = (LEG1 + LEG2) * 0.985; if (dd > mx) { over = dd - mx; v4.sub(v3).multiplyScalar(mx / dd).add(v3); } }
      v5.set(L.s * 0.12 + this.mx * 0.3, 0, 1);                          // knees forward
      solveJoint(v3, v4, LEG1, LEG2, v5, v5);
      pointLimb(L.th, v3, v5); pointLimb(L.sh, v5, v4);
      // straighten leg if the target was out of reach (keeps the foot attached)
      L.ft.position.copy(v4).addScaledVector(DOWN, ANKLE);
      L.ft.rotation.set((Math.max(0, c) * 0.3 + Math.max(0, -p) * 0.55 * Math.max(0, -c + 0.3)) * sn * this.mz + Math.min(0.6, over * 4) * this.mz + this.air * 0.4, 0, 0);
    }

    // ---- torso ------------------------------------------------------------
    let tw = s.aimYaw - s.bodyYaw; tw = Math.atan2(Math.sin(tw), Math.cos(tw));
    this.twist = damp(this.twist, THREE.MathUtils.clamp(tw, -1.1, 1.1), 14, dt);
    this.lean = damp(this.lean, lf * 0.028, 8, dt); this.leanS = damp(this.leanS, ls * 0.014, 8, dt);
    this.flPV += (-140 * this.flP - 15 * this.flPV) * dt; this.flP += this.flPV * dt;
    this.flRV += (-140 * this.flR - 15 * this.flRV) * dt; this.flR += this.flRV * dt;
    this.kick = damp(this.kick, 0, 18, dt);
    const ab = this.aimBlend = damp(this.aimBlend, s.aiming, 9, dt);
    this.torso.rotation.set(this.lean + this.flP + 0.05 * (1 - ab) - s.aimPitch * 0.25 * ab, this.twist * 0.6, -this.leanS + this.flR, 'YXZ');
    this.head.rotation.set(-s.aimPitch * 0.55 + this.flP * 0.6 - this.lean * 0.6, this.twist * 0.4, this.flR * 0.5, 'YXZ');

    // ---- weapon + arms ----------------------------------------------------
    // torso world orientation = root yaw * hips * torso
    q1.setFromAxisAngle(v1.set(0, 1, 0), s.bodyYaw).multiply(this.hips.quaternion).multiply(this.torso.quaternion);
    q2.setFromEuler(e1.set(-s.aimPitch - this.kick * 0.035, s.aimYaw, 0, 'YXZ'));
    q3.copy(q1).invert().multiply(q2);                 // aim direction in torso space
    this.gun.quaternion.copy(Q_RELAX).slerp(q3, ab);
    this.gun.position.copy(GUN_RELAX_POS).lerp(GUN_POS, ab);
    this.gun.position.y += bob * 0.4; this.gun.position.z -= this.kick * 0.035;
    for (const A of this.arm) {
      A.hand.copy(A.s < 0 ? GRIP_R : GRIP_L).applyQuaternion(this.gun.quaternion).add(this.gun.position);
      solveJoint(A.S, A.hand, ARM1, ARM2, A.pole, v5);
      v3.copy(A.S); v4.copy(A.hand);
      // clamp the hand to arm's reach so the forearm never stretches
      pointLimb(A.up, v3, v5); pointLimb(A.lo, v5, v4);
    }

    // ---- health bar -------------------------------------------------------
    if (s.showBar) {
      this.bar.visible = true;
      this.bar.position.set(s.pos.x, this.visY + 2.08, s.pos.z);
      this.bar.quaternion.copy(s.camera.quaternion);
      const d = s.camera.position.distanceTo(this.bar.position), k = THREE.MathUtils.clamp(d / 14, 0.9, 3.2);
      this.bar.scale.setScalar(k);
      this.barFill.scale.x = 0.62 * Math.max(0.001, s.hp01);
    } else this.bar.visible = false;
  }

  phase0() { return this._p0 ?? (this._p0 = Math.random() * 10); }

  updateDeath(dt, s) {
    this.deadT += dt; const t = this.deadT;
    // topple like an inverted pendulum whose legs have given way
    if (this.fall < Math.PI / 2) {
      this.fallV += (13 * Math.sin(this.fall) + 2.5) * dt; this.fall += this.fallV * dt;
      if (this.fall >= Math.PI / 2) { this.fall = Math.PI / 2; if (this.fallV > 2.5) { this.fallV *= -0.22; this.fall += this.fallV * dt; } else this.fallV = 0; }
    } else this.fall = Math.PI / 2;
    const k = Math.min(1, t / 0.3), kk = k * k * (3 - 2 * k);
    this.limp = kk;
    this.tilt.quaternion.setFromAxisAngle(this.fallAxis, this.fall);
    this.tilt.position.y = Math.sin(this.fall) * 0.15;
    const hipY = HIP_Y - 0.36 * kk;
    this.hips.position.set(0, hipY, -0.1 * kk);
    this.hips.rotation.set(0, 0, 0);
    this.torso.rotation.x = damp(this.torso.rotation.x, 0.42, 6, dt); this.torso.rotation.z = damp(this.torso.rotation.z, 0.12, 6, dt);
    this.head.rotation.x = damp(this.head.rotation.x, 0.5, 5, dt); this.head.rotation.z = damp(this.head.rotation.z, 0.3, 5, dt);
    for (let i = 0; i < 2; i++) {
      const L = this.leg[i];
      v4.set(L.s * (HIP_X + 0.06 * kk), 0, (i ? 0.2 : 0.02) * kk); L.foot.lerp(v4, 1 - Math.exp(-10 * dt));
      v3.set(L.s * HIP_X, hipY - 0.05, -0.1 * kk);
      v4.copy(L.foot); v4.y += ANKLE;
      v5.set(L.s * (0.2 + 0.5 * kk), 0, 1);
      solveJoint(v3, v4, LEG1, LEG2, v5, v5);
      pointLimb(L.th, v3, v5); pointLimb(L.sh, v5, v4);
      L.ft.position.copy(v4).addScaledVector(DOWN, ANKLE);
    }
    for (const A of this.arm) { // arms go slack
      v4.set(A.s * 0.34, 0.0, 0.14); A.hand.lerp(v4, 1 - Math.exp(-9 * dt));
      solveJoint(A.S, A.hand, ARM1, ARM2, A.pole, v5);
      v3.copy(A.S); pointLimb(A.up, v3, v5); pointLimb(A.lo, v5, A.hand);
    }
    // dropped weapon
    if (this.gunLoose && !this.gunRest) {
      const g = this.gun; this.gunVel.y -= 24 * dt; g.position.addScaledVector(this.gunVel, dt);
      g.rotation.x += this.gunSpin.x * dt; g.rotation.y += this.gunSpin.y * dt; g.rotation.z += this.gunSpin.z * dt;
      if (g.position.y <= s.floorY + 0.05 && this.gunVel.y < 0) {
        g.position.y = s.floorY + 0.05;
        if (this.gunVel.y < -2.5) { this.gunVel.y *= -0.25; this.gunVel.x *= 0.5; this.gunVel.z *= 0.5; this.gunSpin.multiplyScalar(0.4); }
        else { this.gunRest = true; g.rotation.set(0, g.rotation.y, Math.PI / 2); }
      }
    } else if (this.gunLoose && this.gun.position.y > s.floorY + 0.3) { this.gunRest = false; this.gunVel.set(0, 0, 0); }
    // fade out
    const f = THREE.MathUtils.clamp((t - s.fadeStart) / s.fadeTime, 0, 1);
    if (f > 0 && this.opacity === 1) this.setShadows(false);
    this.setOpacity(1 - f);
    if (f >= 1) this.hide();
  }

  dispose() {
    this.scene.remove(this.root); this.scene.remove(this.bar); this.gun.removeFromParent();
    for (const m of this.matList) m.dispose();
    this.barFill.material.dispose();
  }
}
