import * as THREE from 'three';
import { materials, Kit, rbox, tube, pin, lathe, profile, section, ngon, roundRect, rail, screw, sub, offset, buildHand, squeeze, marking } from './vmkit.js';
import { redDotLens, scopeLens } from './optics.js';

// First-person weapon models (procedural). Gun space: +x right, +y up, forward is -z; helpers take (x, y, f).
// Each builder returns:
//   group      everything
//   muzzle     Object3D at the muzzle tip          eject   Object3D at the ejection port (or null)
//   sight      [x, y, f] the point the eye is brought to when aiming (on the sight axis)
//   lens       { kind:'dot'|'scope', mat } optic lens material driven by weapons.js (or null)
//   body       (scope only) the group hidden while looking through the scope; eyeR = eyepiece lens radius
//   animate(s, out)   s = { time, cycle (s since last shot), mag, magSize, reserve, heat, trigger 0..1,
//                           rl: null | { phase, t 0..1, n, pump, to } },  out = { p, r } extra pose offset

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const ease = (x) => x * x * (3 - 2 * x);
const eseg = (t, a, b) => ease(seg(t, a, b));
const bump = (t, a, b) => Math.sin(Math.PI * seg(t, a, b));

function finish(group) {
  group.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true; } });
}
const GRIP_CURLS = [[0.3, 0.62, 0.35], [1.2, 1.5, 0.9], [1.25, 1.55, 0.9], [1.3, 1.55, 0.9]];
const WRAP_CURLS = [[1.15, 1.5, 0.9], [1.2, 1.5, 0.9], [1.25, 1.55, 0.9], [1.3, 1.55, 0.9]];
const CUP_CURLS = [[0.8, 1.2, 0.75], [0.85, 1.25, 0.8], [0.9, 1.25, 0.8], [0.95, 1.3, 0.8]];
const GRIP_THUMB = { dir: [-0.62, 0.5, -0.6], bend: [-0.7, -0.6, 0.2], angle: 0.42 };
const CUP_THUMB = { dir: [-0.2, 0.72, -0.66], bend: [-0.7, 0.2, -0.2], angle: 0.18 };
// right hand on a pistol grip whose front strap is at (f, y)
const gripHand = (M, f, y, extra = {}) => buildHand(M, { right: true, pos: [0.036, y + 0.02, f - 0.092], fwd: [-0.1, 0.28, 0.95], palm: [-1, 0, -0.12], elbow: [0.3, -0.42, -0.85], curls: GRIP_CURLS, thumb: GRIP_THUMB, trigger: true, ...extra });
// left hand cupping a fore-end from below; (f, y) = centre underside
const cupHand = (M, f, y, extra = {}) => buildHand(M, { right: false, pos: [-0.04, y - 0.017, f - 0.045], fwd: [0.8, 0.12, 0.55], palm: [0, 1, 0], elbow: [-0.36, -0.5, -0.79], curls: CUP_CURLS, thumb: CUP_THUMB, ...extra });

const GRIP_PTS = [[-0.035, -0.022], [-0.09, -0.022], [-0.102, -0.034], [-0.128, -0.14], [-0.12, -0.15], [-0.082, -0.15], [-0.072, -0.11], [-0.052, -0.06], [-0.032, -0.042]];
const shiftPts = (pts, df, dy = 0) => pts.map(([f, y]) => [f + df, y + dy]);
const TRIGGER = [[-0.006, -0.022], [0.002, -0.022], [0.0045, -0.036], [0.0005, -0.05], [-0.0035, -0.05], [-0.002, -0.036]];

// =============================================================================
// WREN AR-6 — gas carbine: anodised receiver, free-float handguard, tan furniture, reflex sight
// =============================================================================
function buildRifle() {
  const M = materials(); const group = new THREE.Group(); const K = new Kit();
  const BY = 0.048;
  // receivers
  K.add(profile([[-0.16, 0.02], [-0.16, 0.066], [-0.148, 0.078], [0.118, 0.078], [0.126, 0.07], [0.126, 0.02]], 0.044, 0.008), M.anod);
  K.add(profile([[-0.165, 0.024], [0.126, 0.024], [0.126, -0.032], [0.118, -0.04], [0.05, -0.046], [0.044, -0.022], [-0.03, -0.022], [-0.04, -0.034], [-0.092, -0.034], [-0.105, -0.012], [-0.165, -0.004]], 0.038, 0.004), M.anod);
  // buffer tube, castle nut, end plate
  K.add(lathe([[0.0001, -0.362], [0.0135, -0.362], [0.0145, -0.357], [0.0145, -0.165]]), M.anod, 0, 0.05, 0);
  K.add(lathe([[0.0145, -0.184], [0.019, -0.183], [0.019, -0.17], [0.0145, -0.169]], 12), M.steel, 0, 0.05, 0);
  K.add(rbox(0.03, 0.044, 0.004, 0.001), M.steel, 0, 0.04, -0.167);
  // stock
  K.add(profile([[-0.205, 0.074], [-0.375, 0.074], [-0.388, 0.062], [-0.388, -0.07], [-0.37, -0.082], [-0.35, -0.07], [-0.30, 0.0], [-0.215, 0.022], [-0.205, 0.03]], 0.042, 0.007,
    [[[-0.325, 0.012], [-0.365, -0.05], [-0.352, -0.055], [-0.312, 0.002]]]), M.polyTan);
  K.add(rbox(0.044, 0.152, 0.012, 0.004), M.rubber, 0, -0.004, -0.394);
  K.add(rbox(0.012, 0.01, 0.05, 0.003), M.poly, 0, 0.017, -0.255);
  // grip, trigger group
  K.add(profile(GRIP_PTS, 0.032, 0.009), M.gripTan);
  K.add(rbox(0.014, 0.0035, 0.08, 0.001), M.anod, 0, -0.062, 0.003);
  K.add(rbox(0.014, 0.036, 0.0035, 0.001), M.anod, 0, -0.046, 0.043, 0.3);
  K.add(profile(TRIGGER, 0.006, 0.0012), M.steel, 0, 0, 0.004);
  // free-float handguard with slots, barrel nut
  K.add(section(ngon(0.031, 8), 0.126, 0.43, [0.0225]), M.anod, 0, BY, 0);
  K.add(lathe([[0.024, 0.118], [0.026, 0.119], [0.026, 0.127]], 16), M.steel, 0, BY, 0);
  for (let i = 0; i < 6; i++) {
    const f = 0.165 + i * 0.045;
    for (const a of [0, Math.PI, Math.PI / 4, Math.PI * 0.75, -Math.PI / 4, -Math.PI * 0.75]) {
      K.add(rbox(0.0012, 0.0075, 0.03, 0.0004, 1), M.black, Math.cos(a) * 0.0287, BY + Math.sin(a) * 0.0287, f, 0, 0, a);
    }
  }
  rail(K, M.anod, 0.0768, -0.15, 0.428);
  // barrel, gas block, muzzle brake
  K.add(lathe([[0.0092, 0.12], [0.0092, 0.415], [0.0086, 0.42], [0.0082, 0.5], [0.0078, 0.538]], 16), M.steel, 0, BY, 0);
  K.add(lathe([[0.0092, 0.33], [0.013, 0.331], [0.013, 0.36], [0.0092, 0.361]], 12), M.steel, 0, BY, 0);
  K.add(lathe([[0.0078, 0.536], [0.0112, 0.538], [0.0112, 0.548], [0.0098, 0.55], [0.0098, 0.556], [0.0118, 0.558], [0.0118, 0.606], [0.011, 0.61], [0.0052, 0.61], [0.0052, 0.585]], 16), M.steel, 0, BY, 0);
  for (let i = 0; i < 3; i++) K.add(rbox(0.0245, 0.005, 0.0075, 0.001, 1), M.black, 0, BY, 0.57 + i * 0.0125);
  const muzzle = sub(group, 0, BY, 0.612);
  // left side: charging slot, selector, bolt catch, pins
  K.add(rbox(0.001, 0.008, 0.115, 0.0003, 1), M.black, -0.0221, 0.058, 0.03);
  K.add(pin(0.0042, 0.003), M.steel, -0.0195, 0.004, -0.05);
  K.add(rbox(0.0022, 0.0045, 0.018, 0.001), M.steel, -0.021, 0.004, -0.058, 0.5);
  K.add(pin(0.0012, 0.0006, 8), M.paintWhite, -0.0192, 0.013, -0.062);
  K.add(pin(0.0012, 0.0006, 8), M.paintRed, -0.0192, 0.014, -0.04);
  K.add(rbox(0.003, 0.022, 0.011, 0.001), M.steel, -0.0195, 0.016, 0.062);
  screw(K, M, -0.0195, 0.006, 0.105, 0.0032); screw(K, M, -0.0195, 0.002, -0.13, 0.0032); screw(K, M, -0.0195, -0.012, 0.0, 0.002); screw(K, M, -0.0195, -0.002, -0.022, 0.002);
  // right side: ejection port, deflector, forward assist
  K.add(rbox(0.001, 0.016, 0.062, 0.0003, 1), M.black, 0.0221, 0.052, 0.035);
  K.add(rbox(0.006, 0.014, 0.012, 0.002), M.anod, 0.023, 0.052, -0.008);
  K.add(pin(0.005, 0.012), M.steel, 0.024, 0.06, -0.05, 0, 0.5);
  const eject = sub(group, 0.03, 0.052, 0.035);
  // sling sockets
  K.add(new THREE.TorusGeometry(0.0058, 0.0016, 6, 14), M.steel, -0.0215, 0.03, -0.35, 0, Math.PI / 2, 0);
  K.add(new THREE.TorusGeometry(0.0058, 0.0016, 6, 14), M.steel, -0.0295, 0.048, 0.385, 0, Math.PI / 2, 0);
  // folded back-up sights
  K.add(rbox(0.02, 0.006, 0.04, 0.002), M.poly, 0, 0.086, -0.128);
  K.add(rbox(0.02, 0.006, 0.04, 0.002), M.poly, 0, 0.086, 0.4);
  // micro open reflex: slim low mount, small emitter housing, thin rounded window frame (2 mm bezel)
  const OY = 0.108, LF = 0.0285;
  K.add(rbox(0.026, 0.005, 0.044, 0.002), M.anod, 0, 0.0855, 0.012);
  K.add(rbox(0.004, 0.008, 0.03, 0.0015), M.anod, -0.0135, 0.0835, 0.012);
  K.add(pin(0.0026, 0.03, 6), M.steel, 0, 0.0845, 0.012);
  K.add(rbox(0.026, 0.0095, 0.03, 0.0035, 3), M.anod, 0, 0.0925, 0.009);
  K.add(profile([[-0.006, 0.096], [0.024, 0.096], [0.0245, 0.0995], [0.012, 0.0985]], 0.026, 0.001), M.anod); // deck rising to the window
  K.add(section(roundRect(0.03, 0.026, 0.009, 6), LF - 0.0025, LF + 0.0025, [roundRect(0.026, 0.022, 0.007, 6).reverse()]), M.anod, 0, OY, 0);
  K.add(rbox(0.0016, 0.004, 0.006, 0.0006), M.rubber, -0.0134, 0.0935, 0.004); K.add(rbox(0.0016, 0.004, 0.006, 0.0006), M.rubber, -0.0134, 0.0935, 0.014);
  K.add(pin(0.0022, 0.0006, 8), M.steel, 0.0131, 0.0925, 0.009);
  K.add(rbox(0.0006, 0.002, 0.012, 0.0002, 1), M.paintTeal, -0.0131, 0.0895, 0.009);
  K.add(rbox(0.003, 0.002, 0.003, 0.0008), M.black, 0, 0.0975, -0.003); // emitter
  K.build(group);
  { const mk = marking(['WREN AR-6', 'CAL 5.7x33   TESSEL ARMORY   KV-204817'], 0.085); mk.position.set(-0.0196, -0.004, -0.068); group.add(mk); }
  { const mk = marking(['SAFE      FIRE'], 0.03); mk.position.set(-0.0196, 0.0165, 0.051); group.add(mk); }
  const lensMat = redDotLens(0xff2a1a);
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.0265, 0.0225), lensMat); lens.position.set(0, OY, -LF); lens.rotation.x = -0.05; group.add(lens);

  // moving parts
  const mag = sub(group, 0, 0, 0);
  { const k = new Kit(), R = 0.42, f0 = 0.052, yT = -0.005, pts = [];
    for (let i = 0; i <= 8; i++) { const a = i / 8 * 0.42; pts.push([f0 + R - R * Math.cos(a), yT - R * Math.sin(a)]); }
    for (let i = 8; i >= 0; i--) { const a = i / 8 * 0.42; pts.push([f0 + R - (R - 0.06) * Math.cos(a), yT - (R - 0.06) * Math.sin(a)]); }
    k.add(profile(pts, 0.024, 0.003), M.poly);
    for (let i = 2; i <= 7; i++) { const a = i / 8 * 0.42, rr = R - 0.03; k.add(rbox(0.0255, 0.003, 0.05, 0.001, 1), M.poly, 0, yT - rr * Math.sin(a), f0 + R - rr * Math.cos(a), a); }
    for (let i = 3; i <= 6; i++) { const a = i / 8 * 0.42, rr = R - 0.008; k.add(pin(0.0019, 0.0006, 8), M.black, -0.0122, yT - rr * Math.sin(a), f0 + R - rr * Math.cos(a)); }
    k.add(rbox(0.028, 0.008, 0.068, 0.003), M.poly, 0, -0.166, 0.116, 0.41);
    k.add(rbox(0.0285, 0.003, 0.03, 0.001), M.paintTeal, 0, -0.166, 0.116, 0.41);
    k.build(mag); }
  const chg = sub(group, 0, 0, 0);
  { const k = new Kit(); k.add(pin(0.0045, 0.018, 10), M.bare, -0.03, 0.058, 0.075); k.add(rbox(0.004, 0.012, 0.014, 0.002), M.steel, -0.0225, 0.058, 0.075); k.build(chg); }
  const bolt = sub(group, 0, 0, 0);
  { const k = new Kit(); k.add(rbox(0.002, 0.013, 0.05, 0.001), M.bare, 0.0218, 0.052, 0.04); k.build(bolt); }

  const hr = gripHand(M, -0.044, -0.105); group.add(hr.group);
  const hl = cupHand(M, 0.3, BY - 0.0287); group.add(hl.group);

  finish(group);
  return {
    group, muzzle, eject, sight: [0, OY, LF], lens: { kind: 'dot', mat: lensMat },
    animate(s, out) {
      const rc = bump(s.cycle, 0, 0.075);
      let cz = 0.075 * rc;
      squeeze(hr.index, s.trigger);
      let magY = 0, hx = 0, hy = 0, hf = 0;
      if (s.rl) {
        const t = s.rl.t;
        const tilt = eseg(t, 0, 0.13) * (1 - eseg(t, 0.84, 1));
        out.r.z -= 0.42 * tilt; out.r.x += 0.2 * tilt; out.p.y += 0.02 * tilt; out.p.x -= 0.02 * tilt;
        const o = eseg(t, 0.1, 0.24), i = eseg(t, 0.4, 0.58);
        magY = -0.42 * (o - i);
        out.p.y -= 0.02 * bump(t, 0.1, 0.24);
        const seat = bump(t, 0.56, 0.66); out.p.y += 0.018 * seat; out.r.x -= 0.04 * seat;
        const ch = bump(t, 0.7, 0.86);
        cz = 0.075 * ch; out.p.z += 0.02 * ch; out.r.z += 0.12 * ch;
        if (t < 0.62) { const k = eseg(t, 0.02, 0.1) * (1 - eseg(t, 0.58, 0.64)); hf = -0.22 * k; hy = magY * 0.9 - 0.05 * k; hx = 0.04 * k; }
        else { const k = eseg(t, 0.64, 0.7) * (1 - eseg(t, 0.86, 0.96)); hx = 0.012 * k; hy = 0.045 * k; hf = -0.2 * k - 0.07 * ch; }
      }
      chg.position.z = cz; bolt.position.z = cz * 0.8;
      mag.position.y = magY; mag.visible = magY > -0.4;
      offset(hl.group, hx, hy, hf);
    },
  };
}

// =============================================================================
// BRAMBLE-8 — pump-action 12 gauge, walnut furniture, ghost-ring sights
// =============================================================================
function buildShotgun() {
  const M = materials(); const group = new THREE.Group(); const K = new Kit();
  const BY = 0.05, SY = 0.088;
  K.add(profile([[-0.10, -0.03], [-0.10, 0.05], [-0.085, 0.074], [0.19, 0.074], [0.2, 0.064], [0.2, -0.008], [0.11, -0.034], [-0.02, -0.034]], 0.04, 0.006), M.steel);
  K.add(rbox(0.001, 0.02, 0.07, 0.0003, 1), M.black, 0.0201, 0.05, 0.07);
  const eject = sub(group, 0.028, 0.05, 0.07);
  K.add(profile([[-0.115, -0.034], [-0.03, -0.034], [-0.03, -0.04], [-0.042, -0.066], [-0.1, -0.066], [-0.118, -0.045]], 0.012, 0.0015,
    [[[-0.104, -0.04], [-0.04, -0.04], [-0.048, -0.06], [-0.098, -0.06]]]), M.poly);
  K.add(profile(TRIGGER, 0.006, 0.0012), M.steel, 0, -0.012, -0.068);
  K.add(pin(0.004, 0.044, 10), M.steel, 0, -0.03, -0.022);
  screw(K, M, -0.0201, 0.0, 0.03, 0.003); screw(K, M, -0.0201, 0.008, 0.15, 0.003);
  K.add(rbox(0.001, 0.012, 0.05, 0.0003, 1), M.black, -0.0201, 0.05, 0.1); // slide channel
  // barrel, magazine tube, clamp
  K.add(lathe([[0.0113, 0.2], [0.0113, 0.3], [0.0108, 0.68], [0.0113, 0.682], [0.0113, 0.692], [0.0094, 0.692], [0.0094, 0.66]], 18), M.steel, 0, BY, 0);
  K.add(lathe([[0.0128, 0.2], [0.0128, 0.6]], 18), M.steel, 0, 0.02, 0);
  K.add(lathe([[0.0128, 0.6], [0.0138, 0.602], [0.0138, 0.622], [0.012, 0.628], [0.0001, 0.628]], 18), M.anod, 0, 0.02, 0);
  K.add(section(roundRect(0.032, 0.062, 0.015, 6), 0.585, 0.597), M.steel, 0, 0.035, 0);
  screw(K, M, -0.0162, 0.035, 0.591, 0.0028);
  // heat shield (perforated)
  { const g = new THREE.LatheGeometry([new THREE.Vector2(0.0158, 0.225), new THREE.Vector2(0.0158, 0.5)], 16, -Math.PI / 2 - 1.25, 2.5); g.rotateX(-Math.PI / 2);
    const mat = M.steel.clone(); mat.side = THREE.DoubleSide; mat.userData = M.steel.userData; mat.name = 'shield'; K.add(g, mat, 0, BY, 0);
    for (let i = 0; i < 9; i++) for (const a of [-0.75, 0, 0.75]) K.add(rbox(0.0045, 0.0008, 0.012, 0.0003, 1), M.black, Math.sin(a) * 0.0159, BY + Math.cos(a) * 0.0159, 0.25 + i * 0.028, 0, 0, -a); }
  // sights: front blade with ears, rear ghost ring with wings
  K.add(rbox(0.01, 0.014, 0.034, 0.002), M.steel, 0, BY + 0.016, 0.66);
  K.add(profile([[0.652, 0.07], [0.668, 0.07], [0.662, SY], [0.6545, SY]], 0.0028, 0.0004), M.steel);
  K.add(rbox(0.0017, 0.0017, 0.0005, 0.0002, 1), M.tritium, 0, SY - 0.0022, 0.6542);
  for (const s of [-1, 1]) K.add(profile([[0.648, 0.07], [0.672, 0.07], [0.668, 0.093], [0.652, 0.093]], 0.002, 0.0004), M.steel, s * 0.0085, 0, 0, 0, 0, -s * 0.12);
  K.add(rbox(0.024, 0.008, 0.032, 0.002), M.steel, 0, 0.0775, -0.06);
  K.add(new THREE.TorusGeometry(0.0058, 0.0017, 8, 22), M.steel, 0, SY, -0.06);
  K.add(rbox(0.004, 0.004, 0.006, 0.001), M.steel, 0, SY - 0.0085, -0.06);
  for (const s of [-1, 1]) K.add(profile([[-0.074, 0.08], [-0.046, 0.08], [-0.05, 0.1], [-0.07, 0.1]], 0.002, 0.0004), M.steel, s * 0.0115, 0, 0);
  // shell saddle on the left of the receiver
  K.add(rbox(0.004, 0.03, 0.13, 0.0015), M.poly, -0.0225, 0.03, 0.07);
  for (let i = 0; i < 5; i++) {
    K.add(new THREE.CylinderGeometry(0.0098, 0.0098, 0.046, 14), M.hull, -0.034, 0.036, 0.02 + i * 0.025);
    K.add(new THREE.CylinderGeometry(0.0102, 0.0102, 0.012, 14), M.brass, -0.034, 0.007, 0.02 + i * 0.025);
    K.add(rbox(0.012, 0.012, 0.0215, 0.002), M.poly, -0.03, 0.03, 0.02 + i * 0.025);
  }
  // walnut stock with pistol-grip wrist, recoil pad
  K.add(profile([[-0.10, 0.05], [-0.16, 0.05], [-0.22, 0.036], [-0.43, 0.014], [-0.43, -0.098], [-0.40, -0.098], [-0.26, -0.05], [-0.225, -0.06], [-0.19, -0.125], [-0.15, -0.125], [-0.125, -0.055], [-0.10, -0.03]], 0.04, 0.012, [], 4), M.wood);
  K.add(rbox(0.04, 0.116, 0.018, 0.006), M.rubber, 0, -0.042, -0.437);
  K.add(rbox(0.041, 0.118, 0.003, 0.001), M.black, 0, -0.042, -0.4285);
  K.build(group);
  { const mk = marking(['BRAMBLE-8   12 GA', 'TESSEL ARMORY   BR-55103'], 0.075); mk.position.set(-0.0204, 0.06, -0.075); group.add(mk); }
  const muzzle = sub(group, 0, BY, 0.694);

  // pump: grooved walnut fore-end + action bars + bolt
  const pump = sub(group, 0, 0.02, 0.39);
  { const k = new Kit(), pts = [[0.019, -0.09], [0.0225, -0.084]];
    for (let i = 0; i < 16; i++) { const f = -0.078 + i * 0.0104; pts.push([0.0242, f], [0.0242, f + 0.0064], [0.0226, f + 0.0072], [0.0226, f + 0.0096]); }
    pts.push([0.0225, 0.086], [0.019, 0.092]);
    k.add(lathe(pts, 20), M.wood, 0, 0, 0, 0, 0, 0, [1, 1.14, 1]);
    for (const s of [-1, 1]) k.add(rbox(0.003, 0.008, 0.2, 0.001), M.steel, s * 0.0145, 0.012, -0.18);
    k.build(pump); }
  const bolt = sub(group, 0, 0, 0);
  { const k = new Kit(); k.add(rbox(0.002, 0.017, 0.06, 0.001), M.bare, 0.0198, 0.05, 0.075); k.build(bolt); }

  const hr = gripHand(M, -0.142, -0.105); group.add(hr.group);
  const hl = cupHand(M, 0.0, -0.0276); pump.add(hl.group);

  finish(group);
  return {
    group, muzzle, eject, sight: [0, SY, -0.06], lens: null,
    animate(s, out) {
      const c = s.cycle;
      let pz = (s.mag > 0 || c < 0.5) ? eseg(c, 0.1, 0.23) - eseg(c, 0.27, 0.42) : 0;
      if (c > 0.08 && c < 0.46) { out.r.x += 0.05 * pz; out.p.z += 0.012 * pz; out.r.z += 0.05 * pz; }
      squeeze(hr.index, s.trigger);
      let lx = 0, ly = 0, lf = 0;
      if (s.rl) {
        const { phase, t } = s.rl;
        const tilt = phase === 'start' ? ease(t) : phase === 'end' ? 1 - eseg(t, 0.35, 1) : 1;
        out.r.z += 0.5 * tilt; out.r.x += 0.22 * tilt; out.p.y += 0.035 * tilt; out.p.x -= 0.035 * tilt;
        if (phase === 'loop') {
          const push = bump(t, 0.3, 0.75);
          out.p.y += 0.012 * push; out.r.x += 0.03 * push; out.p.z -= 0.006 * push;
          ly = -0.14 * (1 - eseg(t, 0.05, 0.5)) - 0.1 * eseg(t, 0.75, 1) - 0.03; lf = -0.27 + 0.07 * eseg(t, 0.4, 0.6); lx = 0.03;
        } else if (phase === 'start') { ly = -0.17 * t; lf = -0.27 * t; lx = 0.03 * t; }
        else {
          const k = 1 - eseg(t, 0, 0.3); ly = -0.17 * k; lf = -0.27 * k; lx = 0.03 * k;
          if (s.rl.pump) pz = eseg(t, 0.3, 0.55) - eseg(t, 0.6, 0.9);
        }
      }
      pump.position.z = -0.39 + 0.085 * pz; bolt.position.z = 0.07 * pz;
      offset(hl.group, lx, ly, lf);
    },
  };
}

// =============================================================================
// LONGHAND .50 — bolt-action chassis rifle with a telescopic sight
// =============================================================================
function buildSniper() {
  const M = materials(); const group = new THREE.Group(); const body = new THREE.Group(); group.add(body);
  const K = new Kit();
  const BY = 0.045, SY = 0.108;
  // action, chassis, rail
  K.add(lathe([[0.0001, -0.15], [0.016, -0.15], [0.0172, -0.145], [0.0172, 0.15], [0.016, 0.155]], 20), M.steel, 0, BY, 0);
  K.add(rbox(0.001, 0.014, 0.075, 0.0003, 1), M.black, 0.0172, BY + 0.004, 0.02, 0, 0, 0.3);
  const eject = sub(group, 0.026, BY + 0.01, 0.02);
  K.add(profile([[-0.13, -0.022], [-0.13, 0.034], [0.43, 0.034], [0.45, 0.022], [0.45, -0.002], [0.13, -0.022]], 0.046, 0.006), M.cerakote);
  for (let i = 0; i < 6; i++) for (const s of [-1, 1]) K.add(rbox(0.001, 0.009, 0.034, 0.0003, 1), M.black, s * 0.0232, 0.014, 0.175 + i * 0.046);
  screw(K, M, -0.0232, 0.008, 0.1, 0.003); screw(K, M, -0.0232, 0.008, -0.1, 0.003);
  rail(K, M.anod, 0.0608, -0.13, 0.17);
  // heavy fluted barrel + brake
  K.add(lathe([[0.0165, 0.15], [0.0158, 0.2], [0.0128, 0.46], [0.0112, 0.79]], 20), M.steel, 0, BY, 0);
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + 0.52; K.add(rbox(0.0034, 0.001, 0.2, 0.0004, 1), M.black, Math.cos(a) * 0.01395, BY + Math.sin(a) * 0.01395, 0.33, 0, 0, a + Math.PI / 2); }
  K.add(section(roundRect(0.032, 0.025, 0.007), 0.785, 0.87), M.steel, 0, BY, 0);
  for (let i = 0; i < 3; i++) K.add(rbox(0.0335, 0.012, 0.013, 0.002, 1), M.black, 0, BY, 0.805 + i * 0.024);
  K.add(tube(0.0066, 0.002, 12), M.black, 0, BY, 0.8705);
  const muzzle = sub(group, 0, BY, 0.875);
  // grip, trigger
  K.add(profile(shiftPts(GRIP_PTS, -0.04), 0.032, 0.009), M.grip);
  K.add(rbox(0.014, 0.0035, 0.075, 0.001), M.anod, 0, -0.062, -0.037);
  K.add(rbox(0.014, 0.036, 0.0035, 0.001), M.anod, 0, -0.045, 0.0, 0.3);
  K.add(profile(TRIGGER, 0.006, 0.0012), M.steel, 0, 0, -0.036);
  // skeleton stock, cheek riser, butt pad
  K.add(profile([[-0.13, 0.034], [-0.47, 0.034], [-0.47, -0.105], [-0.44, -0.11], [-0.41, -0.062], [-0.2, -0.022], [-0.13, -0.022]], 0.036, 0.005,
    [[[-0.25, 0.014], [-0.42, 0.014], [-0.42, -0.045], [-0.27, -0.012]]]), M.cerakote);
  K.add(rbox(0.04, 0.022, 0.13, 0.009, 3), M.poly, 0, 0.06, -0.33);
  for (const f of [-0.29, -0.37]) K.add(new THREE.CylinderGeometry(0.004, 0.004, 0.03, 8), M.bare, 0, 0.042, f);
  K.add(rbox(0.04, 0.15, 0.02, 0.006), M.rubber, 0, -0.035, -0.484);
  K.add(rbox(0.036, 0.14, 0.006, 0.001), M.anod, 0, -0.035, -0.472);
  // folded bipod
  for (const s of [-1, 1]) { K.add(lathe([[0.006, 0.19], [0.006, 0.36], [0.0075, 0.362], [0.0075, 0.4], [0.0001, 0.402]], 10), M.anod, s * 0.017, -0.012, 0); }
  K.add(rbox(0.05, 0.014, 0.03, 0.004), M.anod, 0, -0.008, 0.19);
  // scope tube, turrets, rings, objective
  K.add(lathe([[0.015, -0.115], [0.015, 0.018], [0.02, 0.02], [0.02, 0.056], [0.015, 0.058], [0.015, 0.13], [0.0275, 0.19], [0.029, 0.195], [0.029, 0.275], [0.0272, 0.277], [0.0272, 0.25]], 28), M.anod, 0, SY, 0);
  K.add(new THREE.CircleGeometry(0.0272, 28), M.lensCoat, 0, SY, 0.252, 0, Math.PI, 0);
  const turret = lathe([[0.0115, 0], [0.0115, 0.006], [0.0128, 0.007], [0.0128, 0.02], [0.0118, 0.022], [0.0001, 0.022]], 18);
  K.add(turret, M.anod, 0, SY + 0.019, 0.038, Math.PI / 2);          // elevation (up)
  K.add(turret, M.anod, 0.019, SY, 0.038, 0, -Math.PI / 2, 0);        // windage (right)
  K.add(turret, M.anod, -0.019, SY, 0.038, 0, Math.PI / 2, 0);        // parallax (left)
  K.add(new THREE.CylinderGeometry(0.01295, 0.01295, 0.0014, 18), M.paintRed, 0, SY + 0.0275, 0.038);
  for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; K.add(rbox(0.0006, 0.004, 0.0004, 0.0001, 1), M.paintWhite, Math.sin(a) * 0.0129, SY + 0.034, 0.038 + Math.cos(a) * 0.0129, 0, a, 0); }
  for (const f of [-0.07, 0.092]) {
    K.add(section(ngon(0.0195, 16), f - 0.008, f + 0.008, [0.0149]), M.anod, 0, SY, 0);
    K.add(rbox(0.024, 0.026, 0.016, 0.002), M.anod, 0, SY - 0.028, f);
    K.add(rbox(0.008, 0.012, 0.016, 0.002), M.anod, 0, SY + 0.0215, f);
    for (const s of [-1, 1]) screw(K, M, s * 0.0122, SY - 0.03, f, 0.003, s);
    K.add(new THREE.CylinderGeometry(0.0022, 0.0022, 0.002, 8), M.steel, 0, SY + 0.028, f);
  }
  // ocular housing, zoom ring, eyecup base
  K.add(lathe([[0.015, -0.115], [0.017, -0.125], [0.019, -0.14], [0.0225, -0.155], [0.0225, -0.165]], 28), M.anod, 0, SY, 0);
  { const knurl = [[0.0225, -0.165]]; for (let i = 0; i < 6; i++) { const f = -0.166 - i * 0.0025; knurl.push([0.0238, f], [0.0238, f - 0.0012], [0.0228, f - 0.0014], [0.0228, f - 0.0024]); }
    K.add(lathe(knurl, 28), M.anod, 0, SY, 0); }
  K.add(lathe([[0.0225, -0.181], [0.0225, -0.2], [0.0245, -0.202], [0.0255, -0.2145]], 28), M.rubber, 0, SY, 0);
  K.add(rbox(0.003, 0.003, 0.006, 0.001), M.paintWhite, 0, SY + 0.0238, -0.172);
  K.build(body);
  { const mk = marking(['LONGHAND .50', 'TESSEL ARMORY   LH-0931'], 0.07); mk.position.set(-0.0234, 0.02, 0.03); body.add(mk); }

  // eyepiece: stays visible when looking through the scope
  const eye = new THREE.Group(); group.add(eye);
  // (only the eyecup rim behind the lens: anything in front of the glass would be seen through it)
  { const k = new Kit();
    k.add(lathe([[0.0255, -0.2145], [0.031, -0.217], [0.0318, -0.226], [0.0295, -0.229], [0.0212, -0.223], [0.0212, -0.2145]], 32), M.rubber, 0, SY, 0);
    k.build(eye); }
  const lensMat = scopeLens();
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.0212, 40), lensMat); lens.position.set(0, SY, 0.2145); eye.add(lens);

  const mag = sub(body, 0, 0, 0);
  { const k = new Kit(); k.add(rbox(0.03, 0.07, 0.088, 0.004), M.poly, 0, -0.05, 0.05); k.add(rbox(0.032, 0.008, 0.092, 0.003), M.poly, 0, -0.087, 0.05);
    for (let i = 0; i < 3; i++) k.add(rbox(0.031, 0.003, 0.07, 0.001, 1), M.poly, 0, -0.04 - i * 0.014, 0.05); k.build(mag); }
  const bolt = sub(body, 0, BY, -0.1);
  { const k = new Kit();
    k.add(tube(0.0095, 0.085, 14), M.bare, 0, 0, 0.03);
    k.add(lathe([[0.0001, -0.03], [0.011, -0.03], [0.012, -0.026], [0.012, -0.012]], 14), M.steel, 0, 0, 0);
    k.add(new THREE.CylinderGeometry(0.0048, 0.0058, 0.05, 10), M.steel, 0.034, -0.012, -0.018, 0, 0, Math.PI / 2 + 0.5);
    k.add(new THREE.SphereGeometry(0.0115, 14, 10), M.poly, 0.058, -0.025, -0.018);
    k.build(bolt); }

  const hr = gripHand(M, -0.084, -0.105); body.add(hr.group);
  const hl = cupHand(M, 0.2, -0.016); body.add(hl.group);

  finish(group);
  return {
    group, muzzle, eject, sight: [0, SY, -0.2145], lens: { kind: 'scope', mat: lensMat }, body, eyeR: 0.0318,
    animate(s, out) {
      squeeze(hr.index, s.trigger);
      let lift = 0, pull = 0, rx = 0, ry = 0, rf = 0;
      const boltAnim = (t) => {
        lift = eseg(t, 0, 0.2) - eseg(t, 0.8, 1); pull = eseg(t, 0.2, 0.45) - eseg(t, 0.55, 0.8);
        out.r.z -= 0.1 * lift; out.r.x += 0.04 * lift; out.p.z += 0.015 * pull; out.p.x += 0.006 * lift;
        rx = 0.035 * lift; ry = 0.105 * lift; rf = 0.03 - 0.075 * pull;
      };
      if (!s.rl && s.cycle > 0.2 && s.cycle < 0.85 && s.mag > 0) boltAnim((s.cycle - 0.2) / 0.65);
      let magY = 0, lx = 0, ly = 0, lf = 0;
      if (s.rl) {
        const t = s.rl.t;
        const tilt = eseg(t, 0, 0.12) * (1 - eseg(t, 0.88, 1));
        out.r.z -= 0.35 * tilt; out.r.x += 0.16 * tilt; out.p.y += 0.02 * tilt;
        const o = eseg(t, 0.1, 0.22), i = eseg(t, 0.36, 0.52);
        magY = -0.4 * (o - i);
        const seat = bump(t, 0.5, 0.6); out.p.y += 0.02 * seat; out.r.x -= 0.04 * seat;
        if (t > 0.62 && t < 0.9) boltAnim((t - 0.62) / 0.28);
        const k = eseg(t, 0.02, 0.1) * (1 - eseg(t, 0.56, 0.64));
        lf = -0.15 * k; ly = magY * 0.85 - 0.04 * k; lx = 0.04 * k;
      }
      bolt.rotation.z = lift * 1.0; bolt.position.z = 0.1 + pull * 0.08;
      mag.position.y = magY; mag.visible = magY > -0.38;
      offset(hl.group, lx, ly, lf);
      offset(hr.group, rx, ry, rf);
    },
  };
}

// =============================================================================
// DOORKNOCKER — six-shot revolving 40 mm launcher with a ladder sight
// =============================================================================
function buildLauncher() {
  const M = materials(); const group = new THREE.Group(); const K = new Kit();
  const DY = 0.02, CR = 0.042, BY = DY + CR, SY = 0.142;
  // frame: recoil shield spine, top strap, bottom strap, barrel trunnion, axis pin
  K.add(profile([[-0.12, -0.035], [-0.12, 0.018], [-0.075, 0.066], [-0.02, 0.094], [0.022, 0.094], [0.022, 0.07], [0.0, 0.066], [0.0, -0.03], [-0.03, -0.045]], 0.032, 0.006), M.anod);
  K.add(rbox(0.024, 0.012, 0.2, 0.004), M.anod, 0, 0.088, 0.1);
  K.add(rbox(0.022, 0.01, 0.2, 0.004), M.anod, 0, -0.043, 0.1);
  K.add(profile([[0.163, -0.048], [0.163, 0.094], [0.2, 0.094], [0.2, -0.03], [0.19, -0.048]], 0.07, 0.01), M.anod);
  K.add(tube(0.006, 0.15, 10), M.bare, 0, DY, 0.09);
  screw(K, M, -0.0162, 0.02, -0.05, 0.0035); screw(K, M, -0.0162, 0.03, -0.075, 0.003); screw(K, M, -0.0352, 0.02, 0.18, 0.0035);
  K.add(rbox(0.003, 0.012, 0.03, 0.001), M.steel, -0.017, 0.07, -0.02); // cylinder latch
  // barrel with band, bore
  K.add(lathe([[0.0245, 0.19], [0.0245, 0.2], [0.027, 0.202], [0.027, 0.23], [0.0245, 0.232], [0.0245, 0.47], [0.0265, 0.472], [0.0265, 0.502], [0.0205, 0.502], [0.0205, 0.42]], 26), M.steel, 0, BY, 0);
  K.add(lathe([[0.0249, 0.3], [0.0249, 0.316]], 26), M.paintYellow, 0, BY, 0);
  K.add(new THREE.CircleGeometry(0.0205, 20), M.black, 0, BY, 0.42, 0, Math.PI, 0);
  const muzzle = sub(group, 0, BY, 0.505);
  // handguard + vertical foregrip
  K.add(profile([[0.2, -0.022], [0.2, 0.045], [0.44, 0.045], [0.46, 0.034], [0.46, 0.012], [0.3, -0.022]], 0.05, 0.009), M.polyOD);
  for (let i = 0; i < 4; i++) for (const s of [-1, 1]) K.add(rbox(0.001, 0.007, 0.03, 0.0003, 1), M.black, s * 0.0252, 0.02, 0.25 + i * 0.045);
  K.add(profile([[0.3, -0.02], [0.345, -0.02], [0.35, -0.12], [0.34, -0.13], [0.31, -0.13], [0.302, -0.12]], 0.034, 0.011), M.grip);
  // ladder sight on the top strap, front post with ears
  K.add(rbox(0.026, 0.006, 0.02, 0.002), M.steel, 0, 0.097, 0.12);
  for (const s of [-1, 1]) K.add(rbox(0.002, 0.066, 0.0025, 0.0006, 1), M.steel, s * 0.012, 0.131, 0.12);
  K.add(rbox(0.026, 0.0025, 0.0025, 0.0006, 1), M.steel, 0, 0.164, 0.12);
  for (let i = 0; i < 4; i++) {
    const y = SY - i * 0.011;
    for (const s of [-1, 1]) K.add(rbox(0.009, 0.0016, 0.002, 0.0004, 1), M.steel, s * 0.0075, y, 0.12);
    K.add(rbox(0.0025, 0.0012, 0.0005, 0.0002, 1), M.paintWhite, -0.0125, y, 0.1188);
  }
  K.add(profile([[0.462, BY + 0.026], [0.478, BY + 0.026], [0.472, SY], [0.4685, SY]], 0.003, 0.0005), M.steel);
  K.add(rbox(0.0018, 0.0018, 0.0005, 0.0002, 1), M.tritium, 0, SY - 0.0025, 0.4682);
  for (const s of [-1, 1]) K.add(profile([[0.458, BY + 0.026], [0.482, BY + 0.026], [0.476, SY + 0.006], [0.464, SY + 0.006]], 0.002, 0.0004), M.steel, s * 0.01, 0, 0, 0, 0, -s * 0.15);
  // grip, trigger, wire stock
  K.add(profile(shiftPts(GRIP_PTS, -0.045, -0.012), 0.032, 0.009), M.grip);
  K.add(rbox(0.014, 0.0035, 0.07, 0.001), M.anod, 0, -0.074, -0.045);
  K.add(rbox(0.014, 0.036, 0.0035, 0.001), M.anod, 0, -0.058, -0.008, 0.3);
  K.add(profile(TRIGGER, 0.006, 0.0012), M.steel, 0, -0.012, -0.044);
  for (const s of [-1, 1]) K.add(lathe([[0.0055, -0.36], [0.0055, -0.12]], 10), M.steel, s * 0.012, 0.03, 0);
  K.add(rbox(0.04, 0.115, 0.022, 0.007), M.rubber, 0, 0.0, -0.37);
  K.add(rbox(0.034, 0.03, 0.03, 0.006), M.polyOD, 0, 0.03, -0.345);
  K.add(rbox(0.034, 0.022, 0.02, 0.004), M.anod, 0, 0.03, -0.122);
  K.build(group);
  { const mk = marking(['DOORKNOCKER 40', 'DK-1177'], 0.03); mk.position.set(-0.0354, 0.07, -0.181); group.add(mk); }

  // drum
  const drum = sub(group, 0, DY, 0.09);
  { const k = new Kit();
    k.add(lathe([[0.0001, -0.065], [0.056, -0.065], [0.058, -0.062], [0.058, 0.062], [0.056, 0.065], [0.0001, 0.065]], 30), M.steel);
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 2 - (i + 0.5) * Math.PI / 3;
      k.add(rbox(0.016, 0.003, 0.085, 0.0014), M.anod, Math.cos(a) * 0.0575, Math.sin(a) * 0.0575, 0.005, 0, 0, a + Math.PI / 2);
      const c = Math.PI / 2 - i * Math.PI / 3;
      k.add(new THREE.CircleGeometry(0.0205, 20), M.black, Math.cos(c) * CR, Math.sin(c) * CR, -0.0653);
      k.add(new THREE.CircleGeometry(0.0205, 20), M.black, Math.cos(c) * CR, Math.sin(c) * CR, 0.0653, 0, Math.PI, 0);
    }
    k.build(drum); }
  const rounds = [];
  for (let i = 0; i < 6; i++) {
    const c = Math.PI / 2 - i * Math.PI / 3, g = sub(drum, Math.cos(c) * CR, Math.sin(c) * CR, -0.0656), k = new Kit();
    k.add(new THREE.RingGeometry(0.0045, 0.0195, 20), M.brass); k.add(new THREE.CircleGeometry(0.0045, 12), M.bare, 0, 0, 0);
    k.add(new THREE.RingGeometry(0.0186, 0.0198, 20), M.steel, 0, 0, -0.0002);
    k.build(g); rounds.push(g);
  }

  const hr = gripHand(M, -0.089, -0.117); group.add(hr.group);
  const hl = buildHand(M, { right: false, pos: [-0.036, -0.108, 0.3 - 0.096], fwd: [0.1, 0.25, 0.95], palm: [1, 0, -0.1], elbow: [-0.34, -0.4, -0.85], curls: WRAP_CURLS, thumb: GRIP_THUMB }); group.add(hl.group);

  finish(group);
  return {
    group, muzzle, eject: null, sight: [0, SY, 0.12], lens: null,
    animate(s, out) {
      squeeze(hr.index, s.trigger);
      const fired = s.magSize - s.mag;
      let spin = fired === 0 ? 0 : (fired - 1 + ease(clamp01(s.cycle / 0.14))) * (Math.PI / 3);
      let dx = 0, lx = 0, ly = 0, lf = 0, lit = s.mag;
      if (s.rl) {
        const t = s.rl.t;
        const tilt = eseg(t, 0, 0.12) * (1 - eseg(t, 0.86, 1));
        out.r.z += 0.45 * tilt; out.r.x += 0.25 * tilt; out.p.y += 0.03 * tilt; out.p.x -= 0.02 * tilt;
        const open = eseg(t, 0.1, 0.2) - eseg(t, 0.72, 0.82);
        dx = -0.09 * open;
        spin = fired * (Math.PI / 3) * (1 - eseg(t, 0.2, 0.7)) + eseg(t, 0.2, 0.7) * Math.PI * 4;
        lit = Math.max(s.mag, Math.min(s.magSize, Math.floor(seg(t, 0.22, 0.68) * (s.rl.to + 1))));
        const snap = bump(t, 0.76, 0.86); out.r.z -= 0.1 * snap; out.p.x += 0.012 * snap;
        const k = eseg(t, 0.04, 0.14) * (1 - eseg(t, 0.8, 0.9));
        lx = -0.05 * k; ly = 0.1 * k + 0.012 * Math.sin(seg(t, 0.22, 0.68) * Math.PI * 6) * k; lf = -0.2 * k;
      }
      drum.position.x = dx; drum.position.y = DY - Math.abs(dx) * 0.3;
      drum.rotation.z = spin;
      // loaded chambers show a cartridge base; the fired ones (and during reload, the not-yet-filled ones) are empty
      for (let i = 0; i < 6; i++) rounds[i].visible = s.rl ? i < lit : i >= fired;
      offset(hl.group, lx, ly, lf);
    },
  };
}

// =============================================================================
// MARTLET-9 — striker-fired service pistol: steel slide on a polymer frame, two-handed grip
// =============================================================================
function buildPistol() {
  const M = materials(); const group = new THREE.Group(); const K = new Kit();
  const BY = 0.03, SY = 0.0515;
  // polymer frame: dust cover with accessory rail, trigger guard, grip with beavertail
  K.add(profile([[-0.022, -0.004], [0.112, -0.004], [0.112, 0.013], [-0.078, 0.013], [-0.09, 0.009], [-0.084, -0.02], [-0.106, -0.114], [-0.1, -0.122], [-0.056, -0.122], [-0.04, -0.05], [-0.034, -0.03]], 0.027, 0.005), M.poly);
  K.add(profile([[-0.036, -0.004], [0.052, -0.004], [0.054, -0.012], [0.046, -0.046], [-0.03, -0.05], [-0.04, -0.04]], 0.013, 0.002,
    [[[-0.03, -0.009], [0.045, -0.009], [0.04, -0.041], [-0.028, -0.044]]]), M.poly);
  for (let i = 0; i < 3; i++) K.add(rbox(0.028, 0.004, 0.005, 0.0008, 1), M.black, 0, -0.0035, 0.07 + i * 0.012);
  K.add(profile([[-0.086, -0.03], [-0.1, -0.105], [-0.062, -0.105], [-0.046, -0.05], [-0.05, -0.03]], 0.0285, 0.004), M.grip); // textured grip panels
  K.add(profile(TRIGGER, 0.006, 0.0012), M.steel, 0, 0.012, 0.012);
  // controls + pins (left side)
  K.add(rbox(0.003, 0.005, 0.03, 0.001), M.steel, -0.0142, 0.008, -0.012);         // slide stop
  K.add(rbox(0.003, 0.006, 0.01, 0.001), M.steel, -0.0142, 0.005, 0.035);          // takedown lever
  K.add(pin(0.0036, 0.004, 10), M.poly, -0.0135, -0.012, -0.034);                  // magazine release
  screw(K, M, -0.0137, 0.002, 0.02, 0.0018); screw(K, M, -0.0137, 0.004, -0.06, 0.0018);
  // barrel (seen when the slide is back), guide rod
  K.add(lathe([[0.0001, -0.02], [0.0066, -0.02], [0.0066, 0.117], [0.0045, 0.1175], [0.0045, 0.1]], 14), M.bare, 0, BY, 0);
  K.add(tube(0.0035, 0.1, 8), M.steel, 0, 0.018, 0.06);
  K.build(group);
  const muzzle = sub(group, 0, BY, 0.12);
  const eject = sub(group, 0.017, 0.044, 0.018);

  // slide: serrations, ejection port, barrel hood, striker plate, sights
  const slide = sub(group, 0, 0, 0);
  { const k = new Kit();
    k.add(profile([[-0.08, 0.0135], [-0.08, 0.04], [-0.075, 0.0455], [0.11, 0.0455], [0.116, 0.04], [0.116, 0.0135]], 0.0265, 0.0045, [], 3), M.steel);
    for (const s of [-1, 1]) {
      for (let i = 0; i < 7; i++) k.add(rbox(0.0008, 0.019, 0.0022, 0.0003, 1), M.black, s * 0.0134, 0.03, -0.07 + i * 0.0052, 0.22);
      for (let i = 0; i < 4; i++) k.add(rbox(0.0008, 0.017, 0.0022, 0.0003, 1), M.black, s * 0.0134, 0.03, 0.085 + i * 0.0052, 0.22);
    }
    k.add(rbox(0.013, 0.0012, 0.034, 0.0004, 1), M.black, 0.005, 0.0456, 0.018);          // ejection port (top right)
    k.add(rbox(0.0012, 0.012, 0.034, 0.0004, 1), M.black, 0.0131, 0.038, 0.018);
    k.add(rbox(0.011, 0.0016, 0.022, 0.0004, 1), M.bare, 0.004, 0.0452, 0.022);           // barrel hood
    k.add(rbox(0.016, 0.022, 0.0012, 0.0004, 1), M.black, 0, 0.03, -0.0802);              // striker plate
    k.add(new THREE.CircleGeometry(0.0072, 14), M.black, 0, BY, 0.1162, 0, Math.PI, 0);   // muzzle bushing
    // rear notch sight (two posts) and front post, tritium dots facing the shooter
    // low, open rear sight: two slim ears with a wide notch between them, so the target stays visible around the front post
    k.add(rbox(0.022, 0.0022, 0.012, 0.001), M.steel, 0, 0.0464, -0.066);
    for (const s of [-1, 1]) { k.add(rbox(0.0042, 0.0034, 0.009, 0.0007), M.steel, s * 0.0088, SY - 0.0017, -0.066); k.add(new THREE.CircleGeometry(0.0008, 10), M.tritium, s * 0.0088, SY - 0.0016, -0.0706); }
    k.add(profile([[0.098, 0.0455], [0.11, 0.0455], [0.108, SY], [0.1015, SY]], 0.0024, 0.0004), M.steel); // slim front post
    k.add(new THREE.CircleGeometry(0.00105, 12), M.tritium, 0, SY - 0.0014, 0.1012);
    k.build(slide);
    const mk = marking(['MARTLET-9', '9x19   TESSEL ARMORY   MT-31877'], 0.06); mk.position.set(-0.01335, 0.03, -0.02); slide.add(mk); }

  // magazine (drops along the grip angle)
  const mag = sub(group, 0, 0, 0);
  { const k = new Kit();
    k.add(profile([[-0.08, -0.02], [-0.102, -0.118], [-0.064, -0.118], [-0.046, -0.02]], 0.02, 0.002), M.steel);
    k.add(profile([[-0.109, -0.119], [-0.106, -0.13], [-0.056, -0.13], [-0.054, -0.119]], 0.029, 0.003), M.poly);
    k.build(mag); }

  // firing thumb lies low along the left of the frame (clear of the slide)
  const hr = gripHand(M, -0.034, -0.088, { thumb: { dir: [-0.5, 0.2, -0.84], bend: [-0.5, -0.3, 0.2], angle: 0.16 } }); group.add(hr.group);
  // support hand wrapped around the firing hand from the left, thumb forward along the frame
  const hl = buildHand(M, { right: false, pos: [-0.047, -0.092, -0.118], fwd: [0.3, 0.3, 0.9], palm: [1, 0.05, -0.2], elbow: [-0.42, -0.4, -0.8], curls: WRAP_CURLS, thumb: { dir: [0.04, 0.12, -0.99], bend: [-0.6, 0.1, 0.1], angle: 0.1 } });
  group.add(hl.group);

  finish(group);
  let wasEmpty = false;
  return {
    group, muzzle, eject, sight: [0, SY + 0.0016, -0.066], lens: null,
    animate(s, out) {
      squeeze(hr.index, s.trigger);
      // slide: reciprocates on every shot, locks back on an empty magazine until the reload releases it
      let sz = 0.042 * bump(s.cycle, 0, 0.07);
      if (s.mag === 0 && !s.rl && s.cycle > 0.035) sz = 0.038;
      let magD = 0, lx = 0, ly = 0, lf = 0;
      if (s.rl) {
        const t = s.rl.t;
        if (t < 0.05) wasEmpty = s.mag === 0;
        const tilt = eseg(t, 0, 0.14) * (1 - eseg(t, 0.82, 1));
        out.r.z -= 0.5 * tilt; out.r.x += 0.3 * tilt; out.p.y += 0.035 * tilt; out.p.x -= 0.02 * tilt;
        const o = eseg(t, 0.08, 0.22), i = eseg(t, 0.36, 0.54);
        magD = o - i;
        out.p.y -= 0.012 * bump(t, 0.08, 0.2);
        const seat = bump(t, 0.52, 0.62); out.p.y += 0.02 * seat; out.r.x -= 0.05 * seat;
        if (wasEmpty) { sz = 0.038 * (1 - eseg(t, 0.72, 0.76)); const rel = bump(t, 0.72, 0.84); out.r.x -= 0.04 * rel; out.p.z -= 0.008 * rel; }
        const k = eseg(t, 0.03, 0.1) * (1 - eseg(t, 0.6, 0.72));
        lx = -0.01 * k; ly = -0.33 * magD - 0.04 * k; lf = -0.07 * magD - 0.03 * k;
      }
      slide.position.z = sz;
      mag.position.set(0, -0.36 * magD, 0.075 * magD); mag.visible = magD < 0.97;
      offset(hl.group, lx, ly, lf);
    },
  };
}

const BUILDERS = { pistol: buildPistol, rifle: buildRifle, shotgun: buildShotgun, sniper: buildSniper, launcher: buildLauncher };
// variants reuse a model with a different finish (materials are cloned so the original gun keeps its colours)
const MODEL_FOR = { smg: ['rifle', [1.5, 1.28, 0.85]], dmr: ['rifle', [0.82, 1.12, 0.72]], slug_shotgun: ['shotgun', [1.2, 0.72, 0.78]] };
export function buildViewmodel(id) {
  const variant = MODEL_FOR[id];
  if (!variant) return BUILDERS[id]();
  const vm = BUILDERS[variant[0]](), [r, g, b] = variant[1], done = new Map();
  vm.group.traverse((o) => {
    if (!o.isMesh || !o.material || !o.material.isMeshStandardMaterial || o.material.emissiveIntensity > 1) return;
    if (!done.has(o.material)) { const m = o.material.clone(); m.color.setRGB(m.color.r * r, m.color.g * g, m.color.b * b); done.set(o.material, m); }
    o.material = done.get(o.material);
  });
  return vm;
}

// the bouncing grenade body (world object). kind: 'launcher' | 'frag'
export function buildGrenadeMesh(kind) {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: kind === 'frag' ? 0x3a4030 : 0x2a2d30, metalness: 0.5, roughness: 0.5 });
  const light = new THREE.MeshStandardMaterial({ color: 0x050505, emissive: kind === 'frag' ? 0xff5533 : 0xffc928, emissiveIntensity: 5, roughness: 0.4 });
  if (kind === 'frag') {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), body); b.scale.y = 1.15; g.add(b);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.077, 0.077, 0.014, 14), light); g.add(band);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.034, 0.05, 10), new THREE.MeshStandardMaterial({ color: 0x8c949e, metalness: 1, roughness: 0.35 })); cap.position.y = 0.095; g.add(cap);
  } else {
    const pts = [[0.0001, -0.09], [0.03, -0.08], [0.052, -0.05], [0.06, -0.01], [0.06, 0.06], [0.064, 0.062], [0.064, 0.085], [0.0001, 0.085]].map(([r, y]) => new THREE.Vector2(r, y));
    const b = new THREE.Mesh(new THREE.LatheGeometry(pts, 14), body); b.rotation.x = Math.PI / 2; g.add(b);
    const nose = new THREE.Mesh(new THREE.LatheGeometry(pts.slice(0, 3), 14), new THREE.MeshStandardMaterial({ color: 0xd8a514, metalness: 0.3, roughness: 0.45 })); nose.rotation.x = Math.PI / 2; nose.scale.setScalar(1.01); g.add(nose);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0615, 0.0615, 0.016, 14), light); band.rotation.x = Math.PI / 2; band.position.z = 0.02; g.add(band);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.userData.light = light;
  return g;
}
