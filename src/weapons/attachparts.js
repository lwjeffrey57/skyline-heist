import * as THREE from 'three';
import { materials, Kit, rbox, tube, pin, lathe, profile, section, roundRect } from './vmkit.js';
import { redDotLens, scopeLens } from './optics.js';
import { attachment } from './attachments.js';

// Attachment geometry. applyAttachments(vm, set, def) rebuilds everything fitted to one viewmodel (called when the
// set changes, never per frame): parts are added at the viewmodel's `mounts`, the default sight / magazine / stock
// they replace is hidden, and vm.sight / vm.lens / vm.eyeR / vm.muzzle follow.
//
// mounts (returned by each viewmodel builder; all optional, coordinates are [x, y, f] in gun space):
//   muzzle { r, small? }                      device goes on at vm.muzzle (r = barrel radius there)
//   optic  { y, f, parent?, oy?, of?, def?, front?, scale? }
//                                             rail top (y) and centre (f), in `parent`'s frame (a moving part such as
//                                             a slide or a feed cover: oy/of = that part's origin in gun space);
//                                             def = the factory sight group hidden when an optic is fitted
//   mag    { group, y, f, ang, w, d, well?, pistol?, lmg?, x? }   base plate of the magazine (a moving group)
//   tube   { y, f, r }                        end of a tubular magazine
//   under  { y, f, small? }                   underside of the fore-end, ahead of the support hand
//   side   { x, y, f } / rail { y, f }        where a laser goes (left side / under a pistol's dust cover)
//   stock  { group, y, f }                    factory stock group and where a replacement starts

let LASER = null, BEAM = null;
function laserMats() {
  if (!LASER) {
    LASER = new THREE.MeshStandardMaterial({ color: 0x1a0504, emissive: 0xff2a14, emissiveIntensity: 5, roughness: 0.4 });
    BEAM = new THREE.MeshBasicMaterial({ color: 0xff3018, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false });
  }
  return LASER;
}

// ---- muzzle devices: origin at the muzzle, +f forward. Returns the length added ---------------------------------
function muzzlePart(part, k, M, r, small) {
  const s = small ? 0.82 : 1;
  if (part === 'suppressor') {
    const R = Math.max(0.0142 * s, r * 1.4), L = (small ? 0.118 : 0.165), ring = [];
    k.add(lathe([[r * 0.9, -0.012], [R * 0.82, -0.008], [R, 0.0], [R, L - 0.006], [R * 0.86, L], [0.0042, L], [0.0042, L - 0.03]], 20), M.anod);
    for (let i = 0; i < 3; i++) ring.push(i);
    for (const i of ring) k.add(lathe([[R + 0.0006, 0.012 + i * 0.008], [R + 0.0006, 0.016 + i * 0.008]], 20), M.steel);
    k.add(lathe([[R + 0.0004, L - 0.03], [R + 0.0004, L - 0.022]], 20), M.cerakote);
    return L;
  }
  if (part === 'compensator') {
    const w = Math.max(0.024 * s, r * 2.5), L = 0.05 * s + 0.004;
    k.add(section(roundRect(w, w * 0.92, w * 0.22, 3), -0.006, L, [0.0048]), M.steel);
    for (let i = 0; i < 3; i++) k.add(rbox(w * 0.5, 0.0016, L * 0.16, 0.0004, 1), M.black, 0, w * 0.462, L * (0.22 + i * 0.26));
    for (const sd of [-1, 1]) k.add(rbox(0.0016, w * 0.34, L * 0.5, 0.0004, 1), M.black, sd * w * 0.502, w * 0.1, L * 0.55);
    return L;
  }
  if (part === 'brake') {
    const w = Math.max(0.036 * s, r * 3.2), h = Math.max(0.022 * s, r * 2.1), L = 0.062;
    k.add(lathe([[r * 1.05, -0.008], [r * 1.2, -0.004], [r * 1.2, 0.006]], 14), M.steel);
    k.add(section(roundRect(w, h, h * 0.24, 3), 0.004, L, [0.005]), M.steel);
    for (let i = 0; i < 2; i++) for (const sd of [-1, 1]) k.add(rbox(0.0018, h * 0.56, 0.015, 0.0004, 1), M.black, sd * w * 0.5, 0, 0.02 + i * 0.024);
    for (let i = 0; i < 2; i++) k.add(rbox(w * 0.62, 0.0016, 0.012, 0.0004, 1), M.black, 0, h * 0.5, 0.02 + i * 0.024);
    return L;
  }
  // long barrel: bright collar, extension, thread protector
  const L = small ? 0.075 : 0.115;
  k.add(lathe([[r * 1.28, -0.01], [r * 1.28, 0.008], [r * 0.96, 0.012], [r * 0.9, L - 0.014], [r * 1.12, L - 0.012], [r * 1.12, L], [0.0046, L], [0.0046, L - 0.03]], 16), M.steel);
  k.add(lathe([[r * 1.3, -0.006], [r * 1.3, 0.004]], 16), M.bare);
  return L;
}

// ---- optics: origin on the rail top at the mount centre. Returns { sight:[x,y,f] local, lens?, eye? ... } ----------
function reddot(k, M, o) {
  const OY = 0.025, LF = 0.0165;
  k.add(rbox(0.026, 0.005, 0.044, 0.002), M.anod, 0, 0.0025, 0);
  k.add(rbox(0.004, 0.008, 0.03, 0.0015), M.anod, -0.0135, 0.0005, 0);
  k.add(pin(0.0026, 0.03, 6), M.steel, 0, 0.0015, 0);
  k.add(rbox(0.026, 0.0095, 0.03, 0.0035, 3), M.anod, 0, 0.0095, -0.003);
  k.add(profile([[-0.018, 0.013], [0.012, 0.013], [0.0125, 0.0165], [0.0, 0.0155]], 0.026, 0.001), M.anod);
  k.add(section(roundRect(0.03, 0.026, 0.009, 6), LF - 0.0025, LF + 0.0025, [roundRect(0.026, 0.022, 0.007, 6).reverse()]), M.anod, 0, OY, 0);
  k.add(rbox(0.0006, 0.002, 0.012, 0.0002, 1), M.paintRed, -0.0131, 0.0065, -0.003);
  k.add(rbox(0.003, 0.002, 0.003, 0.0008), M.black, 0, 0.0145, -0.015);
  const mat = redDotLens(o.color ?? 0xff2a1a, 0);
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.0265, 0.0225), mat); lens.position.set(0, OY, -LF); lens.rotation.x = -0.05;
  return { sight: [0, OY, LF], lens: { kind: 'dot', mat }, meshes: [lens] };
}
function holo(k, M, o) {
  const OY = 0.03, D = 0.042, LF = -0.02 + D; // (everything sits D forward of the mount centre: the window stays off the eye)
  const k0 = k; k = { add: (g, m, x = 0, y = 0, f = 0, ...r) => k0.add(g, m, x, y, f + D, ...r) };
  // squat housing, a window at the back, and a hood (roof + side walls) running forward over it
  k.add(rbox(0.036, 0.012, 0.064, 0.003), M.anod, 0, 0.006, 0);
  k.add(rbox(0.012, 0.006, 0.05, 0.002), M.steel, 0.02, 0.006, 0.0);
  k.add(pin(0.0052, 0.012, 10), M.steel, 0.022, 0.011, -0.02);
  k.add(section(roundRect(0.036, 0.031, 0.004, 3), LF - D - 0.003, LF - D + 0.003, [roundRect(0.031, 0.026, 0.003, 3).reverse()]), M.anod, 0, OY, 0);
  k.add(rbox(0.041, 0.003, 0.058, 0.0012), M.anod, 0, OY + 0.0185, 0.004);
  for (const s of [-1, 1]) k.add(profile([[-0.025, 0.012], [0.033, 0.012], [0.033, 0.03], [0.02, OY + 0.019], [-0.025, OY + 0.019]], 0.003, 0.0008, [[[-0.014, 0.018], [0.018, 0.018], [0.012, OY + 0.012], [-0.014, OY + 0.012]]]), M.anod, s * 0.0195, 0, 0);
  k.add(rbox(0.0006, 0.004, 0.02, 0.0002, 1), M.paintTeal, -0.0182, 0.006, -0.01);
  const mat = redDotLens(o.color ?? 0x45ffa0, 1);
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.031, 0.026), mat); lens.position.set(0, OY, -LF);
  return { sight: [0, OY, LF], lens: { kind: 'dot', mat }, meshes: [lens] };
}
function scope(k, ke, M, o, big) {
  // body (tube, rings, turrets) in k; eyepiece rim in ke: it stays on screen while the eye is at the glass
  const H = big ? 0.034 : 0.03, R = big ? 0.0155 : 0.0165, back = big ? -0.125 : -0.088, front = big ? 0.165 : 0.088, lr = big ? 0.019 : 0.0165, rim = big ? 0.0285 : 0.0245;
  if (big) {
    k.add(lathe([[R, back + 0.02], [R, 0.0], [0.0195, 0.002], [0.0195, 0.034], [R, 0.036], [R, 0.09], [0.026, 0.128], [0.027, 0.132], [0.027, front], [0.0255, front + 0.002], [0.0255, front - 0.022]], 26), M.anod, 0, H, 0);
    k.add(new THREE.CircleGeometry(0.0255, 24), M.lensCoat, 0, H, front - 0.02, 0, Math.PI, 0);
    const turret = lathe([[0.0105, 0], [0.0105, 0.005], [0.0118, 0.006], [0.0118, 0.017], [0.0108, 0.019], [0.0001, 0.019]], 16);
    k.add(turret, M.anod, 0, H + 0.0185, 0.018, Math.PI / 2); k.add(turret, M.anod, 0.0185, H, 0.018, 0, -Math.PI / 2, 0); k.add(turret, M.anod, -0.0185, H, 0.018, 0, Math.PI / 2, 0);
    k.add(new THREE.CylinderGeometry(0.012, 0.012, 0.0014, 16), M.paintWhite, 0, H + 0.03, 0.018);
    for (const f of [-0.045, 0.066]) { k.add(section(roundRect(0.04, 0.04, 0.012, 4), f - 0.007, f + 0.007, [R - 0.0002]), M.anod, 0, H, 0); k.add(rbox(0.022, 0.02, 0.014, 0.002), M.anod, 0, 0.009, f); k.add(pin(0.003, 0.03, 8), M.steel, 0, 0.004, f); }
    k.add(lathe([[R, back + 0.02], [0.0175, back + 0.012], [0.0195, back + 0.002], [0.0195, back]], 26), M.anod, 0, H, 0);
  } else {
    // prism sight: short fat body cast in one piece with its mount, a single top turret
    k.add(lathe([[R, back + 0.006], [R, -0.03], [0.02, -0.026], [0.02, 0.04], [0.0185, 0.044], [0.0185, front - 0.012], [0.0215, front - 0.008], [0.0215, front], [0.02, front + 0.002], [0.02, front - 0.018]], 26), M.cerakote, 0, H, 0);
    k.add(new THREE.CircleGeometry(0.02, 22), M.lensCoat, 0, H, front - 0.016, 0, Math.PI, 0);
    k.add(rbox(0.03, 0.016, 0.06, 0.004), M.cerakote, 0, 0.008, 0.006);
    k.add(pin(0.0032, 0.036, 8), M.steel, 0, 0.005, -0.01); k.add(pin(0.0032, 0.036, 8), M.steel, 0, 0.005, 0.022);
    k.add(lathe([[0.011, 0], [0.011, 0.005], [0.0122, 0.006], [0.0122, 0.014], [0.0001, 0.015]], 16), M.anod, 0, H + 0.019, 0.006, Math.PI / 2);
    k.add(lathe([[R, back + 0.006], [0.018, back + 0.002], [0.018, back]], 26), M.cerakote, 0, H, 0);
  }
  const er = big ? 0.0195 : 0.018;
  ke.add(lathe([[er, back], [rim, back - 0.002], [rim + 0.0008, back - 0.01], [rim - 0.0015, back - 0.013], [lr, back - 0.007], [lr, back]], 30), M.rubber, 0, H, 0);
  const mat = scopeLens(o.style ?? 1);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(lr, 36), mat); lens.position.set(0, H, -back);
  return { sight: [0, H, back], lens: { kind: 'scope', mat }, eyeMeshes: [lens], eyeR: rim + 0.0008 };
}
function irons(k, M, front) {
  const SY = 0.0235, RF = -0.11;
  const one = (f, post) => {
    k.add(rbox(0.02, 0.006, 0.016, 0.002), M.anod, 0, 0.003, f);
    k.add(pin(0.0024, 0.024, 6), M.steel, 0, 0.004, f);
    for (const s of [-1, 1]) k.add(rbox(0.0022, SY + 0.002, 0.008, 0.0006), M.anod, s * 0.0078, (SY + 0.008) / 2, f);
    if (post) { k.add(rbox(0.002, SY - 0.006, 0.002, 0.0004, 1), M.steel, 0, (SY + 0.006) / 2, f); k.add(rbox(0.0021, 0.002, 0.0004, 0.0001, 1), M.tritium, 0, SY - 0.0012, f - 0.0011); }
    else { k.add(new THREE.TorusGeometry(0.0042, 0.0013, 8, 20), M.anod, 0, SY, f); k.add(rbox(0.0026, SY - 0.0042 - 0.006, 0.0026, 0.0004, 1), M.anod, 0, (SY - 0.0042 + 0.006) / 2, f); }
  };
  one(RF, false); one(front, true);
  return { sight: [0, SY, RF] };
}

// ---- magazine ------------------------------------------------------------------------------------------------------
function magPart(part, k, M, m) {
  if (m.lmg) { // a deeper box clipped under the standard one
    k.add(rbox(0.076, 0.05, 0.129, 0.006), M.polyOD, m.x, m.y - 0.022, m.f);
    k.add(rbox(0.0768, 0.012, 0.1298, 0.001, 1), M.paintRed, m.x, m.y - 0.03, m.f);
    return;
  }
  const dn = (L) => [m.y - Math.cos(m.ang) * L, m.f + Math.sin(m.ang) * L]; // a point L below the base plate, along the magazine
  if (part === 'extmag') {
    const L = m.pistol ? 0.036 : m.ang ? 0.062 : 0.045, [y, f] = dn(L / 2 + 0.003), [y2, f2] = dn(L + 0.006);
    k.add(rbox(m.w - 0.002, L, m.d - 0.004, 0.003), M.steel, 0, y, f, m.ang);
    k.add(rbox(m.w + 0.002, 0.008, m.d + 0.002, 0.003), M.poly, 0, y2, f2, m.ang);
    for (let i = 0; i < 3; i++) { const [yy, ff] = dn(0.01 + i * (L - 0.012) / 2.6); k.add(rbox(m.w - 0.0015, 0.0024, m.d - 0.0036, 0.0006, 1), M.black, 0, yy, ff, m.ang); }
  } else if (part === 'fastmag') {
    const [y, f] = dn(-0.012), [y2, f2] = dn(0.014);
    k.add(rbox(m.w + 0.003, 0.016, m.d + 0.003, 0.003), M.paintYellow, 0, y, f, m.ang);
    k.add(new THREE.TorusGeometry(0.011, 0.003, 6, 14), M.paintYellow, 0, y2, f2, 0, Math.PI / 2, 0);
  }
}
function drumPart(k, M, m) {
  const [wf, wy] = m.well;
  k.add(rbox(0.024, 0.07, 0.058, 0.003), M.poly, 0, wy - 0.03, wf, 0.12);
  for (const s of [-1, 1]) {
    k.add(pin(0.047, 0.03, 26), M.poly, s * 0.02, wy - 0.098, wf + 0.012);
    k.add(pin(0.04, 0.004, 26), M.steel, s * 0.0365, wy - 0.098, wf + 0.012);
    k.add(pin(0.009, 0.006, 10), M.bare, s * 0.0395, wy - 0.098, wf + 0.012);
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; k.add(rbox(0.002, 0.004, 0.028, 0.0006, 1), M.poly, s * 0.0385, wy - 0.098 + Math.sin(a) * 0.026, wf + 0.012 + Math.cos(a) * 0.026, -a); }
  }
}
function tubePart(k, M, m) {
  k.add(lathe([[m.r + 0.0012, -0.012], [m.r + 0.0012, 0.004], [m.r, 0.006], [m.r, 0.088], [m.r * 0.86, 0.092], [0.0001, 0.092]], 14), M.bare, 0, m.y, m.f);
  k.add(lathe([[m.r + 0.0016, 0.07], [m.r + 0.0016, 0.08]], 14), M.steel, 0, m.y, m.f);
}

// ---- grips / laser / stocks -----------------------------------------------------------------------------------------
function underPart(part, k, M, small) {
  const s = small ? 0.85 : 1;
  k.add(rbox(0.024, 0.008, 0.042, 0.002), M.anod, 0, -0.004, 0);
  k.add(pin(0.003, 0.03, 8), M.steel, 0, -0.004, 0);
  if (part === 'vgrip') {
    k.add(profile([[-0.016, -0.006], [0.016, -0.006], [0.013, -0.09 * s], [0.006, -0.098 * s], [-0.01, -0.098 * s], [-0.016, -0.09 * s]], 0.027, 0.01), M.grip);
    k.add(rbox(0.028, 0.006, 0.03, 0.002), M.poly, 0, -0.1 * s, -0.001);
  } else if (part === 'agrip') {
    k.add(profile([[-0.062, -0.006], [0.036, -0.006], [0.04, -0.014], [-0.012, -0.05 * s], [-0.05, -0.05 * s], [-0.066, -0.02]], 0.03, 0.008), M.polyTan);
    for (let i = 0; i < 4; i++) k.add(rbox(0.0305, 0.003, 0.003, 0.0006, 1), M.black, 0, -0.022 - i * 0.006, -0.0 - i * 0.009, -0.6);
  } else { // brace pod: a collar and two splayed legs with rubber feet
    k.add(rbox(0.036, 0.016, 0.03, 0.004), M.steel, 0, -0.014, 0);
    for (const sd of [-1, 1]) {
      k.add(new THREE.CylinderGeometry(0.0046, 0.0046, 0.13, 10), M.bare, sd * 0.034, -0.078, 0.012, -0.18, 0, sd * 0.36);
      k.add(new THREE.CylinderGeometry(0.0062, 0.0062, 0.04, 10), M.steel, sd * 0.024, -0.05, 0.007, -0.18, 0, sd * 0.36);
      k.add(new THREE.SphereGeometry(0.0085, 10, 8), M.rubber, sd * 0.057, -0.139, 0.024);
    }
  }
}
function laserPart(g, k, M, under) {
  laserMats();
  if (under) { k.add(rbox(0.02, 0.016, 0.04, 0.004), M.anod, 0, -0.01, 0); k.add(rbox(0.021, 0.003, 0.012, 0.001), M.steel, 0, -0.001, 0); }
  else { k.add(rbox(0.016, 0.018, 0.05, 0.004), M.anod, -0.009, 0, 0); k.add(rbox(0.004, 0.012, 0.03, 0.001), M.steel, 0.0, 0, 0); k.add(pin(0.0036, 0.006, 8), M.paintRed, -0.019, 0.002, -0.012); }
  const x = under ? 0 : -0.009, y = under ? -0.01 : 0, f = under ? 0.0202 : 0.0252;
  const tip = new THREE.Mesh(new THREE.CircleGeometry(0.0042, 12), LASER); tip.position.set(x, y, -f); tip.rotation.y = Math.PI;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.0004, 0.0009, 0.7, 5, 1, true).rotateX(Math.PI / 2), BEAM); beam.position.set(x, y, -f - 0.35);
  tip.frustumCulled = beam.frustumCulled = false;
  g.add(tip, beam);
}
function stockPart(part, k, M) {
  if (part === 'lightstock') { // a bare strut and a small butt hook
    k.add(tube(0.0075, 0.2, 10), M.bare, 0, 0.012, -0.1);
    k.add(rbox(0.022, 0.03, 0.03, 0.006), M.steel, 0, 0.012, -0.012);
    k.add(profile([[-0.19, 0.03], [-0.212, 0.03], [-0.214, -0.07], [-0.2, -0.08], [-0.192, -0.066]], 0.026, 0.005), M.steel);
    k.add(rbox(0.028, 0.1, 0.008, 0.003), M.rubber, 0, -0.022, -0.217);
  } else { // slab stock: raised cheek pad, thick recoil pad, a weight in the toe
    k.add(profile([[0.0, 0.03], [-0.2, 0.034], [-0.222, 0.024], [-0.222, -0.105], [-0.205, -0.116], [-0.17, -0.1], [-0.12, -0.028], [0.0, -0.014]], 0.044, 0.008), M.polyTan);
    k.add(rbox(0.046, 0.026, 0.13, 0.01, 3), M.rubber, 0, 0.042, -0.115);
    k.add(rbox(0.046, 0.15, 0.024, 0.008), M.rubber, 0, -0.04, -0.234);
    for (const f of [-0.15, -0.185]) k.add(pin(0.007, 0.046, 10), M.steel, 0, -0.07, f);
  }
}

function dispose(o) {
  o.traverse((m) => { if (m.isMesh) { m.geometry.dispose(); if (m.material.isShaderMaterial) m.material.dispose(); } });
  if (o.parent) o.parent.remove(o);
}

export function clearAttachments(vm) {
  const st = vm.att; if (!st) return;
  for (const o of st.nodes) dispose(o);
  for (const fn of st.undo) fn();
  vm.sight = vm.base.sight; vm.lens = vm.base.lens; vm.eyeR = vm.base.eyeR;
  vm.muzzle.position.z = vm.base.muzzleZ;
  vm.body.visible = true;
  vm.att = null;
}

// set: { slot: attachment id } (already checked against the gun). Returns the nodes that were added.
export function applyAttachments(vm, set, def) {
  if (!vm.base) vm.base = { sight: vm.sight, lens: vm.lens, eyeR: vm.eyeR, muzzleZ: vm.muzzle.position.z, animate: vm.animate };
  clearAttachments(vm);
  const M = materials(), mt = vm.mounts, st = vm.att = { nodes: [], undo: [], follow: null, eye: null };
  const node = (parent, x, y, f, scale = 1) => { const g = new THREE.Group(); g.position.set(x, y, -f); g.scale.setScalar(scale); parent.add(g); st.nodes.push(g); return g; };
  const hide = (o) => { if (!o || !o.visible) return; o.visible = false; st.undo.push(() => { o.visible = true; }); };

  for (const slot in set) {
    const a = attachment(set[slot]); if (!a) continue;
    const k = new Kit();
    if (slot === 'muzzle' && mt.muzzle) {
      const mz = vm.muzzle, g = node(mz.parent, mz.position.x, mz.position.y, -vm.base.muzzleZ);
      const L = muzzlePart(a.part, k, M, mt.muzzle.r, mt.muzzle.small); k.build(g);
      mz.position.z = vm.base.muzzleZ - L;
    } else if (slot === 'optic' && mt.optic) {
      const m = mt.optic, parent = m.parent || vm.body, sc = m.scale || 1, g = node(parent, 0, m.y, m.f, sc);
      const o = (def && def.optic) || {};
      let r;
      if (a.part === 'reddot') r = reddot(k, M, o);
      else if (a.part === 'holo') r = holo(k, M, o);
      else if (a.part === 'irons') r = irons(k, M, (m.front ?? m.f + 0.3) - m.f);
      else {
        // the eyepiece lives outside `body` (which is hidden at the glass) and follows the part the scope sits on
        const eye = new THREE.Group(); vm.group.add(eye); st.nodes.push(eye);
        const ge = new THREE.Group(); ge.position.set(0, m.y, -m.f); ge.scale.setScalar(sc); eye.add(ge);
        const ke = new Kit(); r = scope(k, ke, M, o, a.part === 'scope4'); ke.build(ge);
        for (const ms of r.eyeMeshes) ge.add(ms);
        if (m.parent) { st.follow = m.parent; st.eye = eye; eye.position.copy(m.parent.position); eye.quaternion.copy(m.parent.quaternion); }
        vm.eyeR = r.eyeR * sc;
      }
      k.build(g);
      if (r.meshes) for (const ms of r.meshes) g.add(ms);
      hide(m.def);
      vm.sight = [0, (m.oy || 0) + m.y + r.sight[1] * sc, (m.of || 0) + m.f + r.sight[2] * sc];
      vm.lens = r.lens || null;
    } else if (slot === 'magazine') {
      if (mt.tube) { tubePart(k, M, mt.tube); k.build(node(vm.body, 0, 0, 0)); }
      else if (mt.mag) {
        const m = mt.mag;
        if (a.part === 'drum' && m.well) { for (const c of m.group.children.slice()) hide(c); drumPart(k, M, m); }
        else magPart(a.part, k, M, m);
        k.build(node(m.group, 0, 0, 0));
      }
    } else if (slot === 'grip') {
      if (a.part === 'laser') {
        const m = mt.side || mt.rail; if (!m) continue;
        const g = node(vm.body, m.x || 0, m.y, m.f); laserPart(g, k, M, !mt.side); k.build(g);
      } else if (mt.under) { const m = mt.under; underPart(a.part, k, M, m.small); k.build(node(vm.body, 0, m.y, m.f)); }
    } else if (slot === 'stock' && mt.stock) {
      const m = mt.stock; hide(m.group); stockPart(a.part, k, M); k.build(node(vm.body, 0, m.y, m.f));
    }
  }
  // a scope riding on a moving part: keep its eyepiece on that part
  const base = vm.base.animate;
  vm.animate = st.follow ? (s, out) => { base(s, out); st.eye.position.copy(st.follow.position); st.eye.quaternion.copy(st.follow.quaternion); } : base;
  for (const o of st.nodes) o.traverse((m) => { if (m.isMesh) { m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true; } });
  return st.nodes;
}

