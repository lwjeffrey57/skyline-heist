import * as THREE from 'three';

// =============================================================================
// Bot body: an original "Warden" security android built from primitives.
// Dark under-suit, pale ceramic armour plates, a finned helmet with a glowing
// wrap-around visor, glowing chest core / pack vents in the team colour, and a
// boxy carbine. Fully procedural animation:
//   legs  — two-bone IK driven by a gait cycle synced to ground speed and direction
//   arms  — two-bone IK onto the weapon, which points exactly along the aim direction
//   torso — twists toward the aim, leans into movement
//   hits  — spring-driven reactions by zone: torso recoils and twists away from the shot, the head snaps on
//           headshots, a leg hit buckles the hips; a stagger drops the weapon off target and hunches the body
//   tell  — between bursts the carbine sits at low ready; it snaps up and the visor flares just before firing
//   death — a parameterised procedural fall (see die()): crumple, topple, spin, tumble, thrown ... every one is
//           randomised (fall axis, twist, limb rest pose), the weapon is knocked away, then the body fades
// Local space: +Y up, +Z forward, -X is the bot's right-hand side.
// =============================================================================

const HIP_Y = 0.94, WAIST = 0.08, SHOULDER_Y = 0.44, SHOULDER_X = 0.21, NECK_Y = 0.57;
const ARM1 = 0.3, ARM2 = 0.29, LEG1 = 0.43, LEG2 = 0.42, ANKLE = 0.09, HIP_X = 0.1;
const GUN_POS = new THREE.Vector3(-0.1, 0.4, 0.03), GUN_RELAX_POS = new THREE.Vector3(-0.13, 0.3, 0.06);
const GRIP_R = new THREE.Vector3(0, -0.1, 0.17), GRIP_L = new THREE.Vector3(0.005, -0.065, 0.39);
const DOWN = new THREE.Vector3(0, -1, 0);
const Q_RELAX = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.62, 0.55, 0.15, 'YXZ'));

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
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
    this.legHit = [0, 0];
    // death parameters (filled by die())
    this.dp = { style: 'topple', delay: 0, sink: 0.36, sinkT: 0.3, end: Math.PI / 2, yaw: 0, yawV: 0, flail: 0.5, flX: 0, flZ: 0, torsoX: 0.4, torsoY: 0, torsoZ: 0.1, headX: 0.5, headY: 0, headZ: 0.3,
      arm: [new THREE.Vector3(), new THREE.Vector3()], legX: [0, 0], legY: [0, 0], legZ: [0, 0], bounce: 0, bounceV: 0 };
    this.reset();
  }

  reset() {
    this.phase = Math.random() * 6; this.visY = null; this.mx = 0; this.mz = 1; this.sn = 0; this.air = 0;
    this.flP = 0; this.flR = 0; this.flPV = 0; this.flRV = 0; this.kick = 0; this.aimBlend = 0; this.twist = 0; this.lean = 0; this.leanS = 0;
    this.flY = 0; this.flYV = 0; this.hdP = 0; this.hdPV = 0; this.hdR = 0; this.hdRV = 0; this.hdY = 0; this.hdYV = 0; this.dip = 0; this.dipV = 0;
    this.stagS = 0; this.crouch = 0; this.tellS = 0; this.limpS = 0; this.legHit[0] = 0; this.legHit[1] = 0; this.glow = -1; this.setGlow(0);
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
  // side (-1..1): where across the body the round landed (+ = its left) -> the torso twists away from it
  // zone: 'torso' | 'head' | 'leg'
  flinch(lx, lz, strength = 1, side = 0, zone = 'torso') {
    const k = zone === 'leg' ? 0.45 : 1;
    this.flPV = clamp(this.flPV + lz * 5.5 * strength * k, -11, 11); this.flRV = clamp(this.flRV - lx * 5.5 * strength * k, -11, 11);
    this.flYV = clamp(this.flYV + side * -lz * 9 * strength * k + side * 2 * strength, -12, 12);
    if (zone === 'head') { // the head whips with the shot, the torso follows
      this.hdPV = clamp(this.hdPV + lz * 11 * strength, -13, 13); this.hdRV = clamp(this.hdRV - lx * 11 * strength, -13, 13);
      this.hdYV = clamp(this.hdYV + (side || (Math.random() - 0.5)) * 9 * strength, -12, 12);
    } else if (zone === 'leg') this.legBuckle(side, strength);
  }
  // a leg was hit: the hips drop and roll over that leg, the torso pitches forward to catch the balance
  legBuckle(side, strength = 1) {
    const i = side >= 0 ? 0 : 1; // leg[0] is the left (+x) one
    this.legHit[i] = Math.min(1, this.legHit[i] + 0.7 * strength);
    this.dipV = Math.max(-3.2, this.dipV - 1.9 * strength); this.flPV = clamp(this.flPV + 3.2 * strength, -11, 11);
  }
  fireKick() { this.kick = 1; }

  // Start the collapse. o = { lx, lz: local direction the body is driven toward (the shot / blast / its own momentum),
  //   style: 'topple' | 'crumple' | 'snapback' | 'slump' | 'spin' | 'blown' | 'tumble' | 'thrown', force (0..1.5),
  //   side (-1..1: where across the body the round landed), vel (world velocity), dirX, dirZ (world shot direction) }
  // Every style randomises its fall axis, twist and the limb pose the body comes to rest in.
  die(o = {}, lz0, vel0) {
    if (typeof o === 'number') o = { lx: o, lz: lz0, vel: vel0 }; // old signature: die(lx, lz, worldVel)
    const P = this.dp, R = (a, b) => a + Math.random() * (b - a), force = o.force ?? 0.6, side = o.side || 0;
    let lx = o.lx || 0, lz = o.lz ?? -1, fallV = R(1.3, 2.3);
    const style = P.style = o.style || 'topple';
    P.delay = 0; P.sink = R(0.3, 0.4); P.sinkT = 0.3; P.end = Math.PI / 2 + R(-0.05, 0.04); P.yaw = 0; P.yawV = -side * R(1.2, 2.6) + R(-0.9, 0.9); P.flail = R(0.4, 0.7);
    P.torsoX = R(0.1, 0.5); P.torsoY = R(-0.35, 0.35); P.torsoZ = R(-0.2, 0.2); P.headX = R(-0.1, 0.5); P.headY = R(-0.6, 0.6); P.headZ = R(-0.35, 0.35);
    P.bounce = 0; P.bounceV = 0;
    switch (style) {
      case 'crumple': P.delay = R(0.07, 0.13); P.sink = R(0.42, 0.52); P.sinkT = 0.2; fallV = R(1.0, 1.5); P.flail = 0.15; P.torsoX = R(0.35, 0.7); P.yawV *= 0.5; lx += R(-0.5, 0.5); break;
      case 'slump': P.delay = R(0.2, 0.32); P.sink = R(0.42, 0.52); P.sinkT = 0.3; fallV = R(0.7, 1.1); P.flail = 0.2; { const a = R(-1.1, 1.1); lx = Math.sin(a); lz = Math.cos(a); } P.torsoX = R(0.3, 0.6); break;
      case 'snapback': P.sink = R(0.14, 0.24); fallV = R(3.0, 3.8) + force; P.flail = R(0.8, 1.1); P.torsoX = R(-0.25, 0.1); P.headX = R(-0.6, -0.2); break;
      case 'spin': P.yawV = (side ? -Math.sign(side) : Math.random() < 0.5 ? 1 : -1) * R(4.2, 6.5); fallV = R(1.0, 1.6); P.sink = R(0.3, 0.45); P.flail = R(0.6, 0.9); break;
      case 'blown': P.sink = R(0.18, 0.28); fallV = R(2.6, 3.4) + force * 0.8; P.flail = R(0.8, 1.1); P.yawV = -side * R(2, 3.5) + R(-1, 1); P.torsoX = R(-0.2, 0.25); break;
      case 'tumble': P.sink = R(0.2, 0.3); fallV = R(2.8, 3.6) + force; P.flail = R(0.7, 1.0); P.torsoX = R(0, 0.3); P.yawV = R(-1.6, 1.6); break;
      case 'thrown': P.sink = R(0.1, 0.2); fallV = 3.6 + 2.2 * force + R(0, 1); P.flail = 1.1; P.yawV = R(-3.5, 3.5) - side * 2; P.torsoX = R(-0.3, 0.3); P.end = Math.PI / 2; break;
      default: lx += R(-0.35, 0.35); lz += R(-0.2, 0.2);
    }
    for (let i = 0; i < 2; i++) {
      const sgn = this.arm[i].s;
      P.arm[i].set(sgn * R(0.2, 0.52), R(-0.12, 0.42), R(-0.05, 0.12)); // hand rest spot in torso space (pulled to the floor side later)
      P.legX[i] = R(0.0, 0.16); P.legY[i] = Math.random() < 0.4 ? R(0.12, 0.34) : R(0, 0.05); P.legZ[i] = R(-0.12, 0.16);
    }
    const l = Math.hypot(lx, lz) || 1; lx /= l; lz /= l;
    P.flX = lx; P.flZ = lz;
    this.dead = true; this.deadT = 0; this.fall = 0.05; this.fallV = fallV; this.limp = 0;
    this.fallAxis.set(lz, 0, -lx);
    // the weapon is knocked out of the hands: tossed with the shot, spinning
    this.root.updateMatrixWorld(true);
    this.scene.attach(this.gun); this.gunLoose = true; this.gunRest = false;
    this.gunVel.set((Math.random() - 0.5) * 1.8 + (o.dirX || 0) * 2.4 * force, 1.4 + 1.6 * force * Math.random(), (Math.random() - 0.5) * 1.8 + (o.dirZ || 0) * 2.4 * force);
    if (o.vel) this.gunVel.addScaledVector(o.vel, 0.6);
    this.gunSpin.set((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 7).multiplyScalar(0.7 + force * 0.6);
    this.bar.visible = false; this.setGlow(0);
  }
  // refine a death that has just started with where the killing round landed
  deathHint(zone, side) {
    if (!this.dead || this.deadT > 0.05) return;
    const P = this.dp;
    if (zone === 'leg' && (P.style === 'topple' || P.style === 'slump' || P.style === 'crumple')) { // the leg goes: down over it, forward
      const lx = (side >= 0 ? 0.55 : -0.55) + (Math.random() - 0.5) * 0.3, lz = 0.85, l = Math.hypot(lx, lz);
      P.flX = lx / l; P.flZ = lz / l; this.fallAxis.set(P.flZ, 0, -P.flX); P.delay = Math.max(P.delay, 0.12); P.sink = Math.max(P.sink, 0.46);
    } else if (P.style === 'topple' || P.style === 'blown') P.yawV += -side * (1.2 + Math.random() * 1.6);
  }
  setGlow(k) {
    if (this.glow === k) return; this.glow = k;
    this.mats.visor.emissiveIntensity = 4.5 + 13 * k; this.mats.accent.emissiveIntensity = 4.5 + 5 * k;
  }

  // s: { pos, bodyYaw, aimYaw, aimPitch, vel, grounded, aiming (0..1 target), hp01, showBar, camera, floorY,
  //      stag (0..1 staggered), crouch (0..1 ducked), tell (0..1 about to fire / firing), limp (0..1 hurt leg) }
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
    // hit reactions that reach the legs: stagger, duck, a buckling / limping leg
    const st = this.stagS = damp(this.stagS, s.stag || 0, (s.stag || 0) > this.stagS ? 30 : 8, dt);
    const cr = this.crouch = damp(this.crouch, s.crouch || 0, (s.crouch || 0) > this.crouch ? 14 : 7, dt);
    const lp = this.limpS = damp(this.limpS, s.limp || 0, 8, dt);
    this.dipV += (-110 * this.dip - 13 * this.dipV) * dt; this.dip = clamp(this.dip + this.dipV * dt, -0.3, 0.08);
    const lh0 = this.legHit[0] = damp(this.legHit[0], 0, 3.2, dt), lh1 = this.legHit[1] = damp(this.legHit[1], 0, 3.2, dt), lhs = lh0 - lh1;
    const limpDip = lp * 0.05 * Math.max(0, Math.sin(this.phase + (lhs < 0 ? Math.PI : 0)));
    const hipY = HIP_Y - 0.05 * sn - (speed > 6.5 ? 0.03 : 0) + bob - 0.02 * this.air + Math.sin(performance.now() * 0.0017 + this.phase0()) * 0.004
      - 0.3 * cr - 0.11 * st + this.dip - limpDip - 0.07 * Math.max(lh0, lh1);
    this.hips.position.set(Math.sin(this.phase) * 0.018 * sn + lhs * 0.05, hipY, -0.05 * cr);
    this.hips.rotation.set(0, Math.sin(this.phase) * 0.1 * sn * this.mz, lhs * 0.2);

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
    this.flYV += (-120 * this.flY - 13 * this.flYV) * dt; this.flY += this.flYV * dt;
    this.hdPV += (-170 * this.hdP - 13 * this.hdPV) * dt; this.hdP += this.hdPV * dt;
    this.hdRV += (-170 * this.hdR - 13 * this.hdRV) * dt; this.hdR += this.hdRV * dt;
    this.hdYV += (-170 * this.hdY - 13 * this.hdYV) * dt; this.hdY += this.hdYV * dt;
    this.flP = clamp(this.flP, -0.8, 0.8); this.flR = clamp(this.flR, -0.7, 0.7); this.flY = clamp(this.flY, -0.85, 0.85);
    this.hdP = clamp(this.hdP, -0.85, 0.85); this.hdR = clamp(this.hdR, -0.7, 0.7); this.hdY = clamp(this.hdY, -0.9, 0.9);
    this.kick = damp(this.kick, 0, 18, dt);
    const tl = this.tellS = damp(this.tellS, s.tell || 0, (s.tell || 0) > this.tellS ? 26 : 5, dt);
    this.setGlow(tl < 0.02 ? 0 : Math.round(tl * 20) / 20);
    const aimT = s.aiming * (1 - 0.8 * st);
    const ab = this.aimBlend = damp(this.aimBlend, aimT, aimT > this.aimBlend ? 17 : 9, dt);
    this.torso.rotation.set(this.lean + this.flP + 0.05 * (1 - ab) - s.aimPitch * 0.25 * ab + 0.36 * cr + 0.3 * st + 0.05 * tl, this.twist * 0.6 + this.flY, -this.leanS + this.flR + (s.stagX || 0) * -0.22 * st - lhs * 0.12, 'YXZ');
    this.head.rotation.set(-s.aimPitch * 0.55 + this.flP * 0.6 - this.lean * 0.6 + this.hdP - 0.3 * cr + 0.28 * st, this.twist * 0.4 + this.hdY + this.flY * 0.3, this.flR * 0.5 + this.hdR, 'YXZ');

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
    this.deadT += dt; const t = this.deadT, P = this.dp;
    // legs give way first (sink), then the body goes over like an inverted pendulum about a randomised axis,
    // twisting about its own length (yaw) as it falls
    let down = this.fall >= P.end;
    if (!down && t >= P.delay) {
      this.fallV += (13 * Math.sin(this.fall) + 2.5) * dt; this.fall += this.fallV * dt;
      if (this.fall >= P.end) {
        this.fall = P.end; down = true;
        P.bounceV = Math.min(2.2, this.fallV * 0.22); // the impact: a small bounce, the limbs settle
        this.fallV = 0;
      }
    }
    P.bounceV += (-90 * P.bounce - 11 * P.bounceV) * dt; P.bounce += P.bounceV * dt;
    P.yaw += P.yawV * dt; P.yawV = damp(P.yawV, 0, down ? 9 : 1.2, dt);
    const k = Math.min(1, t / P.sinkT), kk = k * k * (3 - 2 * k);
    this.limp = kk;
    q1.setFromAxisAngle(this.fallAxis, this.fall - Math.max(0, P.bounce) * 0.5); q2.setFromAxisAngle(v1.set(0, 1, 0), P.yaw);
    this.tilt.quaternion.copy(q1).multiply(q2);
    // which way is the floor, seen from the body? (decides how high it lies and where the limbs come to rest)
    const dn = v5.set(0, -1, 0).applyQuaternion(q3.copy(this.tilt.quaternion).invert());
    const dnx = dn.x, dnz = dn.z, flat = Math.sin(Math.min(this.fall, Math.PI / 2));
    this.tilt.position.y = flat * (0.2 - 0.1 * dnz + 0.05 * Math.abs(dnx)) + Math.max(0, P.bounce) * 0.25;
    const hipY = HIP_Y - P.sink * kk * (1 - 0.8 * flat * flat); // the legs give way, then stretch out as the body goes flat
    this.hips.position.set(0, hipY, -0.1 * kk);
    this.hips.rotation.set(0, 0, 0);
    const fl = P.flail * Math.sin(Math.min(1, this.fall / P.end) * Math.PI) * (down ? 0 : 1), sr = 1 - Math.exp(-6 * dt);
    this.torso.rotation.x += (P.torsoX * (dnz > 0 ? 0.4 : 1) - fl * 0.25 * P.flZ - this.torso.rotation.x) * sr;
    this.torso.rotation.y += (P.torsoY - this.torso.rotation.y) * sr; this.torso.rotation.z += (P.torsoZ - this.torso.rotation.z) * sr;
    const hr = 1 - Math.exp(-5 * dt), hx = P.headX - fl * 0.6 * P.flZ - dnz * 0.25 * flat;
    this.head.rotation.x += (hx - this.head.rotation.x) * hr; this.head.rotation.y += (P.headY - this.head.rotation.y) * hr; this.head.rotation.z += (P.headZ + fl * 0.5 * P.flX - this.head.rotation.z) * hr;
    for (let i = 0; i < 2; i++) {
      const L = this.leg[i];
      v4.set(L.s * (HIP_X + P.legX[i] * kk) + dnx * 0.05 * flat, P.legY[i] * kk * flat, P.legZ[i] * kk + dnz * 0.07 * flat - fl * 0.12 * P.flZ); L.foot.lerp(v4, 1 - Math.exp(-10 * dt));
      v3.set(L.s * HIP_X, hipY - 0.05, -0.1 * kk);
      v4.copy(L.foot); v4.y += ANKLE;
      v5.set(L.s * (0.2 + 0.12 * kk + 0.9 * flat), 0, 1 - flat * (1 + 0.5 * dnz)); // lying: knees splay sideways, away from the floor
      solveJoint(v3, v4, LEG1, LEG2, v5, v5);
      pointLimb(L.th, v3, v5); pointLimb(L.sh, v5, v4);
      L.ft.position.copy(v4).addScaledVector(DOWN, ANKLE);
      L.ft.rotation.x = damp(L.ft.rotation.x, 0.5 * flat, 6, dt);
    }
    for (let i = 0; i < 2; i++) { // arms: thrown out against the fall, then slack on the floor
      const A = this.arm[i], T = P.arm[i];
      v4.set(T.x - fl * 0.3 * P.flX + dnx * 0.1 * flat, T.y + fl * 0.3, T.z - fl * 0.3 * P.flZ + dnz * 0.13 * flat);
      A.hand.lerp(v4, 1 - Math.exp(-9 * dt));
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
