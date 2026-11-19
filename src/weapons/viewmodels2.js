import * as THREE from 'three';
import { materials, Kit, rbox, tube, pin, lathe, profile, section, ngon, roundRect, rail, screw, sub, offset, buildHand, squeeze, marking } from './vmkit.js';
import { clamp01, seg, ease, eseg, bump, finish, WRAP_CURLS, gripHand, cupHand, GRIP_PTS, TRIGGER } from './vmcommon.js';

// Viewmodels of the four later guns: ROOK-6 revolver, CORMORANT-100 belt gun, KESTREL L7 lever carbine,
// NIGHTJAR crossbow. Same conventions as viewmodels.js (gun space: +x right, +y up, forward is -z; helpers
// take (x, y, f)); each also returns `mounts` for attachments (see attachparts.js).

// =============================================================================
// ROOK-6 — six-shot heavy revolver: steel frame, polished fluted cylinder, walnut grips, ribbed barrel
// =============================================================================
export function buildHandcannon() {
  const M = materials(); const group = new THREE.Group(); const K = new Kit();
  const CY = 0.02, BY = CY + 0.0125, SY = 0.0615, CF = 0.023;
  // frame with the cylinder window, recoil shield, barrel lug with a vented rib
  K.add(profile([[-0.034, 0.0], [-0.026, 0.036], [-0.014, 0.052], [0.068, 0.052], [0.068, -0.004], [0.05, -0.012], [-0.03, -0.012]], 0.018, 0.004,
    [[[0.0, -0.004], [0.046, -0.004], [0.046, 0.044], [0.0, 0.044]]]), M.steel);
  K.add(tube(0.0208, 0.007, 22), M.steel, 0, CY, -0.0045);
  K.add(lathe([[0.0098, 0.066], [0.0098, 0.21], [0.009, 0.214], [0.0055, 0.214], [0.0055, 0.19]], 16), M.steel, 0, BY, 0);
  K.add(profile([[0.068, BY - 0.006], [0.068, BY - 0.027], [0.198, BY - 0.027], [0.212, BY - 0.016], [0.212, BY - 0.006]], 0.015, 0.004), M.steel);
  K.add(rbox(0.008, 0.005, 0.146, 0.001), M.steel, 0, BY + 0.0115, 0.139);
  for (let i = 0; i < 5; i++) K.add(rbox(0.0086, 0.0022, 0.015, 0.0004, 1), M.black, 0, BY + 0.0102, 0.086 + i * 0.026);
  K.add(tube(0.0032, 0.05, 8), M.bare, 0, CY - 0.002, 0.095); // ejector rod
  screw(K, M, -0.0092, 0.004, 0.058, 0.0026); screw(K, M, -0.0092, 0.03, -0.018, 0.0022);
  K.add(rbox(0.004, 0.008, 0.012, 0.0015), M.bare, -0.0105, 0.03, -0.004); // cylinder latch
  // sights: square rear notch on the top strap, ramped front blade with a red insert
  K.add(rbox(0.02, 0.004, 0.016, 0.001), M.steel, 0, 0.054, -0.004);
  for (const s of [-1, 1]) K.add(rbox(0.0062, 0.0066, 0.005, 0.0008), M.steel, s * 0.0068, SY - 0.0018, -0.01);
  K.add(profile([[0.182, BY + 0.013], [0.21, BY + 0.013], [0.207, SY], [0.199, SY]], 0.003, 0.0004), M.steel);
  K.add(rbox(0.0031, 0.0042, 0.0006, 0.0002, 1), M.paintRed, 0, SY - 0.0028, 0.1987);
  // trigger guard, trigger
  K.add(profile([[-0.036, -0.01], [0.052, -0.01], [0.054, -0.018], [0.046, -0.052], [-0.03, -0.056], [-0.04, -0.046]], 0.012, 0.002,
    [[[-0.028, -0.05], [0.04, -0.047], [0.045, -0.015], [-0.03, -0.015]]]), M.steel);
  K.add(profile(TRIGGER, 0.006, 0.0012), M.bare, 0, 0.006, 0.012);
  // walnut grips with a medallion, steel backstrap
  K.add(profile([[-0.03, -0.01], [-0.05, 0.004], [-0.068, -0.012], [-0.082, -0.05], [-0.108, -0.112], [-0.1, -0.128], [-0.056, -0.128], [-0.044, -0.07], [-0.032, -0.036]], 0.031, 0.009, [], 4), M.wood);
  K.add(pin(0.0052, 0.0325, 12), M.brass, 0, -0.045, -0.062);
  K.add(profile([[-0.034, 0.0], [-0.052, 0.008], [-0.072, -0.012], [-0.066, -0.016], [-0.05, -0.002], [-0.034, -0.008]], 0.012, 0.002), M.steel);
  K.build(group);
  { const mk = marking(['ROOK-6', '.45 LONG   TESSEL ARMORY   RK-7733'], 0.06); mk.position.set(-0.0101, BY - 0.012, -0.135); group.add(mk); }
  const muzzle = sub(group, 0, BY, 0.216);
  const eject = sub(group, -0.04, CY - 0.012, -0.03);

  // cylinder on its crane: six chambers, flutes; the cartridge bases show when it is swung out
  const cyl = sub(group, 0, CY, CF);
  { const k = new Kit();
    k.add(lathe([[0.0001, -0.022], [0.0192, -0.022], [0.0205, -0.0195], [0.0205, 0.017], [0.019, 0.022], [0.0001, 0.022]], 26), M.bare);
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 2 - (i + 0.5) * Math.PI / 3;
      k.add(rbox(0.0085, 0.0018, 0.025, 0.0007, 1), M.black, Math.cos(a) * 0.0201, Math.sin(a) * 0.0201, 0.008, 0, 0, a + Math.PI / 2);
      const c = Math.PI / 2 - i * Math.PI / 3;
      k.add(new THREE.CircleGeometry(0.0054, 14), M.black, Math.cos(c) * 0.0125, Math.sin(c) * 0.0125, -0.02205);
    }
    k.add(new THREE.CircleGeometry(0.004, 12), M.steel, 0, 0, -0.0221);
    k.build(cyl); }
  const rounds = [];
  for (let i = 0; i < 6; i++) {
    const c = Math.PI / 2 - i * Math.PI / 3, g = sub(cyl, Math.cos(c) * 0.0125, Math.sin(c) * 0.0125, -0.0223), k = new Kit();
    k.add(new THREE.RingGeometry(0.0016, 0.0056, 16), M.brass); k.add(new THREE.CircleGeometry(0.0016, 10), M.bare);
    k.build(g); rounds.push(g);
  }
  // hammer (pivot at its foot)
  const hammer = sub(group, 0, 0.026, -0.03);
  { const k = new Kit();
    k.add(profile([[0.012, -0.006], [0.014, 0.012], [0.006, 0.02], [-0.012, 0.029], [-0.022, 0.026], [-0.012, 0.019], [-0.004, 0.008], [-0.004, -0.006]], 0.008, 0.0015), M.bare);
    k.build(hammer); }
  // speed loader: six rounds in a ring, held by the left hand during the reload
  const loader = sub(group, -0.04, CY - 0.014, -0.02); const loaderRounds = sub(loader, 0, 0, 0);
  { const k = new Kit();
    k.add(tube(0.015, 0.012, 14), M.poly, 0, 0, -0.024); k.add(tube(0.006, 0.012, 10), M.bare, 0, 0, -0.034);
    k.build(loader);
    const r = new Kit();
    for (let i = 0; i < 6; i++) { const c = Math.PI / 2 - i * Math.PI / 3, x = Math.cos(c) * 0.0125, y = Math.sin(c) * 0.0125;
      r.add(tube(0.0052, 0.024, 10), M.brass, x, y, -0.006); r.add(lathe([[0.0001, 0.02], [0.0036, 0.014], [0.005, 0.006]], 10), M.steel, x, y, 0); }
    r.build(loaderRounds); }
  loader.visible = false;

  const hr = gripHand(M, -0.034, -0.092, { thumb: { dir: [-0.5, 0.2, -0.84], bend: [-0.5, -0.3, 0.2], angle: 0.16 } }); group.add(hr.group);
  const hl = buildHand(M, { right: false, pos: [-0.047, -0.096, -0.118], fwd: [0.3, 0.3, 0.9], palm: [1, 0.05, -0.2], elbow: [-0.42, -0.4, -0.8], curls: WRAP_CURLS, thumb: { dir: [0.04, 0.12, -0.99], bend: [-0.6, 0.1, 0.1], angle: 0.1 } });
  group.add(hl.group);

  finish(group);
  let rlFired = 0;
  return {
    group, muzzle, eject, sight: [0, SY, -0.01], lens: null,
    mounts: { muzzle: { r: 0.0098 }, optic: { y: 0.052, f: 0.022, scale: 0.8 }, rail: { y: BY - 0.027, f: 0.15 } },
    animate(s, out) {
      squeeze(hr.index, s.trigger);
      const c = s.cycle, fired = s.magSize - s.mag;
      let cock = s.mag > 0 ? (fired === 0 ? 1 : eseg(c, 0.28, 0.44)) : 0;
      let spin = fired === 0 ? 0 : fired - 1 + cock, open = 0, lx = 0, ly = 0, lf = 0, from = fired, upto = 6;
      if (!s.rl) {
        // the thumb hauls the hammer back for the next round: the gun rolls and dips with it
        if (s.mag > 0 && fired > 0) { const wb = bump(c, 0.26, 0.46); out.r.x += 0.04 * wb; out.r.z -= 0.035 * wb; out.p.y -= 0.004 * wb; }
        loader.visible = false;
      } else {
        const t = s.rl.t;
        if (t < 0.05) rlFired = fired;
        const tilt = eseg(t, 0, 0.12) * (1 - eseg(t, 0.86, 1));
        out.r.z -= 0.4 * tilt; out.r.x += 0.22 * tilt; out.p.y += 0.04 * tilt; out.p.x -= 0.035 * tilt;
        open = eseg(t, 0.1, 0.17) - eseg(t, 0.8, 0.87);
        const dump = bump(t, 0.15, 0.33); out.r.x += 0.6 * dump; out.p.y += 0.02 * dump; // muzzle up: the empties fall out
        const e = eseg(t, 0.17, 0.3);
        spin = rlFired + (12 - rlFired) * e;
        if (t < 0.24) { from = rlFired; upto = 6; } else if (t < 0.66) { from = 6; } else { from = 0; upto = s.rl.to; }
        // speed loader comes up from below, is pushed home, and leaves empty
        const a = eseg(t, 0.36, 0.56), push = eseg(t, 0.58, 0.66), leave = eseg(t, 0.68, 0.78);
        loader.visible = t > 0.34 && t < 0.78; loaderRounds.visible = t < 0.66;
        offset(loader, -0.05 * (1 - a) - 0.06 * leave, -0.2 * (1 - a) - 0.12 * leave, -0.05 * (1 - push) - 0.03 * leave);
        const seat = bump(t, 0.6, 0.7); out.p.z -= 0.008 * seat; out.r.x -= 0.05 * seat;
        const snap = bump(t, 0.8, 0.9); out.r.z += 0.22 * snap; out.p.x += 0.014 * snap; // flicked shut
        const k = eseg(t, 0.03, 0.1) * (1 - eseg(t, 0.84, 0.94));
        lx = -0.035 * k; ly = -0.04 * k - 0.2 * k * (1 - a) - 0.1 * leave * k; lf = -0.03 * k - 0.04 * k * (1 - push);
        cock = s.rl.to > 0 ? eseg(t, 0.9, 0.98) : 0;
      }
      offset(cyl, -0.04 * open, -0.014 * open, 0);
      cyl.rotation.z = spin * (Math.PI / 3);
      hammer.rotation.x = 0.72 * cock;
      for (let i = 0; i < 6; i++) rounds[i].visible = i >= from && i < upto;
      offset(hl.group, lx, ly, lf);
    },
  };
}

// =============================================================================
// CORMORANT-100 — belt-fed machine gun: stamped steel receiver, hinged feed cover, olive ammunition box
// =============================================================================
export function buildLmg() {
  const M = materials(); const group = new THREE.Group(); const K = new Kit();
  const BY = 0.05, TOP = 0.078, SY = 0.128, HF = 0.17;
  // receiver: long stamped box, pressed ribs, rivets
  K.add(profile([[-0.17, -0.002], [-0.17, 0.07], [-0.162, TOP], [0.2, TOP], [0.21, 0.07], [0.21, 0.004], [0.19, -0.02], [-0.03, -0.02], [-0.04, -0.032], [-0.095, -0.032], [-0.11, -0.012]], 0.05, 0.005), M.steel);
  for (const s of [-1, 1]) {
    K.add(rbox(0.003, 0.012, 0.17, 0.0012), M.steel, s * 0.0252, 0.022, 0.09);
    K.add(rbox(0.003, 0.01, 0.1, 0.0012), M.steel, s * 0.0252, 0.05, -0.1);
  }
  for (let i = 0; i < 5; i++) screw(K, M, -0.0256, 0.066, -0.14 + i * 0.075, 0.0024);
  K.add(rbox(0.0012, 0.02, 0.06, 0.0003, 1), M.black, -0.0256, 0.058, 0.06); // feed port
  K.add(rbox(0.0012, 0.012, 0.11, 0.0003, 1), M.black, -0.0256, 0.03, -0.05); // charging slot
  K.add(rbox(0.044, 0.0016, 0.1, 0.0004, 1), M.black, 0, TOP + 0.0002, 0.02);   // feed tray (seen with the cover open)
  K.add(rbox(0.05, 0.07, 0.006, 0.002), M.steel, 0, 0.036, -0.172);
  // heavy barrel in a trunnion, slotted conical flash hider
  K.add(lathe([[0.021, 0.2], [0.021, 0.238], [0.0125, 0.244], [0.0125, 0.4], [0.0115, 0.405], [0.0105, 0.63]], 18), M.steel, 0, BY, 0);
  K.add(lathe([[0.0105, 0.628], [0.013, 0.632], [0.0185, 0.69], [0.0165, 0.692], [0.008, 0.66]], 16), M.steel, 0, BY, 0);
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.78; K.add(rbox(0.004, 0.0016, 0.034, 0.0005, 1), M.black, Math.cos(a) * 0.0155, BY + Math.sin(a) * 0.0155, 0.664, 0, 0, a + Math.PI / 2); }
  const muzzle = sub(group, 0, BY, 0.694);
  // gas tube, gas block with a winged front sight tower
  K.add(lathe([[0.007, 0.21], [0.007, 0.5]], 10), M.steel, 0, BY - 0.025, 0);
  K.add(rbox(0.026, 0.052, 0.03, 0.004), M.steel, 0, BY - 0.011, 0.505);
  for (const s of [-1, 1]) K.add(profile([[0.494, BY + 0.012], [0.516, BY + 0.012], [0.511, SY + 0.005], [0.499, SY + 0.005]], 0.002, 0.0004), M.steel, s * 0.0095, 0, 0, 0, 0, -s * 0.1);
  K.add(rbox(0.0022, SY - BY - 0.012, 0.0022, 0.0004, 1), M.steel, 0, (SY + BY + 0.012) / 2, 0.505);
  // bipod folded forward under the barrel
  for (const s of [-1, 1]) { K.add(lathe([[0.0048, 0.52], [0.0048, 0.655], [0.007, 0.657], [0.007, 0.675], [0.0001, 0.677]], 10), M.steel, s * 0.013, BY - 0.034, 0); }
  K.add(rbox(0.04, 0.012, 0.018, 0.003), M.steel, 0, BY - 0.034, 0.522);
  // handguard with cooling slots, heat shield over the barrel, carry handle folded to the left
  K.add(profile([[0.21, -0.016], [0.21, 0.034], [0.42, 0.034], [0.44, 0.024], [0.44, 0.002], [0.4, -0.016]], 0.052, 0.008), M.poly);
  for (let i = 0; i < 4; i++) for (const s of [-1, 1]) K.add(rbox(0.001, 0.008, 0.03, 0.0003, 1), M.black, s * 0.0262, 0.012, 0.25 + i * 0.045);
  K.add(rbox(0.03, 0.004, 0.19, 0.0015), M.steel, 0, BY + 0.0155, 0.34);
  for (let i = 0; i < 7; i++) K.add(rbox(0.012, 0.0045, 0.012, 0.0004, 1), M.black, 0, BY + 0.0156, 0.265 + i * 0.025);
  K.add(tube(0.0075, 0.085, 10), M.poly, -0.04, BY + 0.01, 0.325);
  for (const f of [0.287, 0.363]) K.add(rbox(0.02, 0.006, 0.008, 0.002), M.steel, -0.03, BY + 0.01, f);
  // grip, trigger guard, trigger
  K.add(profile(GRIP_PTS, 0.032, 0.009), M.grip);
  K.add(rbox(0.014, 0.0035, 0.08, 0.001), M.steel, 0, -0.062, 0.003);
  K.add(rbox(0.014, 0.036, 0.0035, 0.001), M.steel, 0, -0.046, 0.043, 0.3);
  K.add(profile(TRIGGER, 0.006, 0.0012), M.bare, 0, 0, 0.004);
  K.build(group);
  { const mk = marking(['CORMORANT-100', '6.5x40 BELT   TESSEL ARMORY   CM-60412'], 0.085); mk.position.set(-0.0258, 0.047, 0.115); group.add(mk); }
  const eject = sub(group, 0.03, 0.01, 0.06);

  // feed cover, hinged at the front; carries the rail and the rear sight
  const cover = sub(group, 0, TOP, HF);
  { const k = new Kit();
    k.add(profile([[-0.33, 0.0], [-0.33, 0.016], [-0.32, 0.022], [-0.012, 0.022], [0.0, 0.012], [0.0, 0.0]], 0.048, 0.004), M.steel);
    rail(k, M.anod, 0.022, -0.31, -0.03);
    k.add(rbox(0.03, 0.008, 0.016, 0.002), M.bare, 0, 0.01, -0.333); // latch
    k.add(pin(0.004, 0.054, 10), M.bare, 0, 0.004, -0.004);          // hinge pin
    k.build(cover); }
  const optDef = sub(cover, 0, 0, 0);
  { const k = new Kit(), f = -0.12 - HF, y = SY - TOP;
    k.add(rbox(0.022, 0.006, 0.03, 0.002), M.steel, 0, 0.031, f);
    for (const s of [-1, 1]) k.add(rbox(0.003, 0.03, 0.012, 0.001), M.steel, s * 0.0095, 0.044, f);
    k.add(new THREE.TorusGeometry(0.0046, 0.0015, 8, 20), M.steel, 0, y, f);
    k.add(rbox(0.003, y - 0.0046 - 0.034, 0.003, 0.0005, 1), M.steel, 0, (y - 0.0046 + 0.034) / 2, f);
    k.build(optDef); }
  // ammunition box under the receiver, belt up into the feed port
  const box = sub(group, 0, 0, 0);
  { const k = new Kit();
    k.add(rbox(0.072, 0.1, 0.125, 0.006), M.polyOD, -0.03, -0.075, 0.09);
    k.add(rbox(0.075, 0.009, 0.128, 0.003), M.polyOD, -0.03, -0.0235, 0.09);
    k.add(rbox(0.0728, 0.014, 0.1258, 0.001, 1), M.paintYellow, -0.03, -0.098, 0.09);
    for (const f of [0.045, 0.135]) k.add(rbox(0.0735, 0.07, 0.004, 0.001), M.polyOD, -0.03, -0.065, f);
    k.add(rbox(0.02, 0.012, 0.03, 0.003), M.steel, -0.005, -0.018, 0.09); // hanger
    k.build(box);
    const mk = marking(['100 RDS', 'BALL  6.5'], 0.06, { color: '#e8d9a0' }); mk.position.set(-0.0663, -0.06, -0.09); box.add(mk); }
  const belt = sub(group, 0, 0, 0);
  { const k = new Kit();
    for (let i = 0; i < 5; i++) {
      const y = -0.014 + i * 0.02, x = -0.034 + (i > 2 ? (i - 2) * 0.004 : 0) - (i === 0 ? 0.004 : 0);
      k.add(tube(0.0043, 0.03, 10), M.brass, x, y, 0.052); k.add(lathe([[0.0001, 0.086], [0.003, 0.078], [0.0042, 0.067]], 10), M.bare, x, y, 0);
      k.add(rbox(0.0105, 0.016, 0.012, 0.002), M.black, x, y + 0.006, 0.05);
    }
    k.build(belt); }
  const chg = sub(group, 0, 0, 0);
  { const k = new Kit(); k.add(pin(0.0046, 0.02, 10), M.bare, -0.035, 0.03, -0.01); k.add(rbox(0.004, 0.014, 0.016, 0.002), M.steel, -0.0265, 0.03, -0.01); k.build(chg); }
  // fixed stock (its own group: a stock attachment replaces it)
  const stock = sub(group, 0, 0, 0);
  { const k = new Kit();
    k.add(profile([[-0.172, 0.068], [-0.38, 0.068], [-0.4, 0.058], [-0.4, -0.075], [-0.385, -0.085], [-0.36, -0.07], [-0.31, 0.0], [-0.172, 0.004]], 0.04, 0.007,
      [[[-0.235, 0.046], [-0.36, 0.046], [-0.37, -0.03], [-0.325, 0.016]]]), M.poly);
    k.add(rbox(0.042, 0.15, 0.012, 0.004), M.rubber, 0, -0.006, -0.406);
    k.add(rbox(0.032, 0.004, 0.06, 0.0015), M.steel, 0, 0.071, -0.36);
    k.build(stock); }

  const hr = gripHand(M, -0.044, -0.105); group.add(hr.group);
  const hl = cupHand(M, 0.31, -0.016); group.add(hl.group);

  finish(group);
  return {
    group, muzzle, eject, sight: [0, SY, -0.12], lens: null,
    mounts: {
      muzzle: { r: 0.012 }, optic: { parent: cover, y: 0.0282, f: -HF, oy: TOP, of: HF, def: optDef },
      mag: { group: box, lmg: true, x: -0.03, y: -0.125, f: 0.09 },
      under: { y: -0.016, f: 0.392 }, side: { x: -0.0275, y: 0.012, f: 0.41 }, stock: { group: stock, y: 0.036, f: -0.175 },
    },
    animate(s, out) {
      squeeze(hr.index, s.trigger);
      const c = s.cycle, rc = bump(c, 0, 0.07);
      let boxY = 0, cov = 0, cz = 0, hx = 0, hy = 0, hf = 0, beltOn = s.mag > 0, feed = s.mag > 0 ? 1 - seg(c, 0, 0.06) : 0;
      if (s.rl) {
        const t = s.rl.t, tac = !!s.rl.tac, end = s.rl.end || 1;
        const tilt = eseg(t, 0, 0.08) * (1 - eseg(t, end - 0.12, end));
        out.r.z -= 0.36 * tilt; out.r.x += 0.14 * tilt; out.p.y += 0.03 * tilt; out.p.x -= 0.012 * tilt;
        // box off, cover up, new box on, belt laid in the tray, cover slammed, (empty: charged)
        const o = eseg(t, 0.08, 0.16), i = eseg(t, 0.38, 0.5);
        boxY = -0.45 * (o - i);
        const strip = bump(t, 0.08, 0.18); out.p.y -= 0.02 * strip; out.r.z -= 0.04 * strip;
        cov = eseg(t, 0.2, 0.28) - eseg(t, 0.63, 0.69);
        const seat = bump(t, 0.46, 0.56); out.p.y += 0.022 * seat; out.r.x -= 0.04 * seat;
        const slam = bump(t, 0.66, 0.75); out.p.y -= 0.022 * slam; out.r.x -= 0.07 * slam;
        const ch = tac ? 0 : bump(t, 0.76, 0.9), rel = tac ? 0 : bump(t, 0.84, 0.92);
        cz = 0.09 * ch; out.p.z += 0.02 * ch - 0.012 * rel; out.r.z += 0.1 * ch;
        beltOn = t > 0.57 || (t < 0.1 && s.mag > 0); feed = 0;
        const wA = eseg(t, 0.02, 0.08) * (1 - eseg(t, 0.17, 0.21)) + eseg(t, 0.33, 0.38) * (1 - eseg(t, 0.5, 0.54));
        const wB = eseg(t, 0.18, 0.22) * (1 - eseg(t, 0.29, 0.34)) + eseg(t, 0.51, 0.56) * (1 - eseg(t, 0.7, 0.75));
        const wC = tac ? 0 : eseg(t, 0.72, 0.77) * (1 - eseg(t, 0.9, 0.96));
        hx = 0.04 * wB; hy = (-0.07 + boxY * 0.9) * wA + (0.12 + 0.06 * cov) * wB + 0.05 * wC; hf = -0.2 * wA - 0.27 * wB - (0.32 + cz) * wC;
      }
      box.position.y = boxY; box.visible = boxY > -0.43;
      cover.rotation.x = -1.1 * cov - (s.rl ? 0 : 0.012 * rc);
      chg.position.z = cz;
      belt.visible = beltOn; belt.position.y = -0.02 * feed;
      offset(hl.group, hx, hy, hf);
    },
  };
}

// =============================================================================
// KESTREL L7 — lever-action carbine: brass receiver, octagonal barrel, walnut furniture, buckhorn sights
// =============================================================================
export function buildLever() {
  const M = materials(); const group = new THREE.Group(); const K = new Kit();
  const BY = 0.045, SY = 0.082, TY = BY - 0.0195;
  // receiver (brass) with side plate, loading gate, ejection port
  K.add(profile([[-0.09, -0.014], [-0.09, 0.048], [-0.078, 0.064], [0.1, 0.064], [0.11, 0.056], [0.11, 0.002], [0.07, -0.016], [-0.04, -0.016]], 0.03, 0.005), M.brass);
  K.add(rbox(0.012, 0.0012, 0.05, 0.0004, 1), M.black, 0, 0.0642, 0.02);
  K.add(rbox(0.0012, 0.012, 0.034, 0.0004, 1), M.black, 0.0152, 0.012, 0.03);
  screw(K, M, -0.0152, 0.03, 0.07, 0.003); screw(K, M, -0.0152, 0.006, -0.02, 0.0026); screw(K, M, -0.0152, 0.04, -0.06, 0.0026);
  K.add(rbox(0.012, 0.004, 0.06, 0.0015), M.brass, 0, 0.0465, -0.11); // tang
  const eject = sub(group, 0.004, 0.072, 0.02);
  // octagonal barrel, crown, magazine tube with a band, fore-end with a steel cap
  K.add(section(ngon(0.0105, 8), 0.1, 0.58), M.steel, 0, BY, 0);
  K.add(lathe([[0.0102, 0.578], [0.0096, 0.585], [0.0052, 0.585], [0.0052, 0.56]], 12), M.steel, 0, BY, 0);
  K.add(lathe([[0.0078, 0.1], [0.0078, 0.5], [0.0068, 0.504], [0.0001, 0.504]], 12), M.steel, 0, TY, 0);
  K.add(section(roundRect(0.026, 0.046, 0.011, 5), 0.468, 0.48), M.steel, 0, BY - 0.009, 0);
  K.add(lathe([[0.0168, 0.11], [0.0185, 0.13], [0.0185, 0.3], [0.0168, 0.332]], 18), M.wood, 0, BY - 0.013, 0, 0, 0, 0, [1, 1.12, 1]);
  K.add(lathe([[0.0172, 0.33], [0.0176, 0.332], [0.0176, 0.345], [0.013, 0.348]], 18), M.steel, 0, BY - 0.013, 0, 0, 0, 0, [1, 1.12, 1]);
  const muzzle = sub(group, 0, BY, 0.587);
  // sights: buckhorn rear on the receiver, brass bead on a blade
  K.add(rbox(0.014, 0.003, 0.026, 0.0012), M.steel, 0, 0.065, -0.05);
  for (const s of [-1, 1]) K.add(profile([[-0.055, 0.0655], [-0.045, 0.0655], [-0.047, SY + 0.0035], [-0.052, SY + 0.0035]], 0.003, 0.0005), M.steel, s * 0.0052, 0, 0, 0, 0, s * 0.18);
  K.add(profile([[0.548, BY + 0.0105], [0.576, BY + 0.0105], [0.568, SY - 0.0006], [0.562, SY - 0.0006]], 0.0026, 0.0004), M.steel);
  K.add(new THREE.SphereGeometry(0.0024, 10, 8), M.brass, 0, SY - 0.0012, 0.5625);
  // walnut stock with a straight wrist, brass butt plate
  K.add(profile([[-0.086, 0.046], [-0.14, 0.044], [-0.22, 0.03], [-0.42, 0.014], [-0.425, -0.092], [-0.395, -0.098], [-0.27, -0.052], [-0.2, -0.036], [-0.13, -0.03], [-0.086, -0.014]], 0.036, 0.012, [], 4), M.wood);
  K.add(rbox(0.037, 0.112, 0.008, 0.003), M.brass, 0, -0.04, -0.428);
  K.add(profile(TRIGGER, 0.006, 0.0012), M.steel, 0, 0.004, -0.028);
  K.build(group);
  { const mk = marking(['KESTREL L7', '.41 LEVER   TESSEL ARMORY   KL-22761'], 0.07, { color: '#3a2c12', opacity: 0.9 }); mk.position.set(-0.0153, 0.03, -0.03); group.add(mk); }

  // lever: trigger guard + finger loop, pivots at the front of the receiver
  const PF = 0.04, PY = -0.014;
  const lever = sub(group, 0, PY, PF);
  { const k = new Kit(), L = (pts) => pts.map(([f, y]) => [f - PF, y - PY]);
    k.add(profile(L([[0.04, -0.014], [0.04, -0.02], [0.004, -0.024], [0.006, -0.05], [-0.05, -0.054], [-0.062, -0.052], [-0.07, -0.088], [-0.152, -0.092], [-0.168, -0.07], [-0.16, -0.034], [-0.066, -0.03], [-0.062, -0.016]]), 0.011, 0.002,
      [L([[-0.056, -0.022], [-0.05, -0.048], [-0.002, -0.046], [-0.004, -0.024]]), L([[-0.153, -0.04], [-0.16, -0.068], [-0.15, -0.086], [-0.078, -0.082], [-0.072, -0.038]])]), M.steel);
    k.build(lever); }
  // bolt (slides back out of the receiver as the lever opens) and hammer
  const bolt = sub(group, 0, 0, 0);
  { const k = new Kit(); k.add(rbox(0.013, 0.011, 0.07, 0.003), M.bare, 0, 0.055, -0.06); k.build(bolt); }
  const hammer = sub(group, 0, 0.04, -0.092);
  { const k = new Kit(); k.add(profile([[0.007, -0.004], [0.009, 0.008], [0.003, 0.015], [-0.009, 0.022], [-0.016, 0.019], [-0.009, 0.013], [-0.004, 0.005], [-0.004, -0.004]], 0.008, 0.0015), M.steel); k.build(hammer); }

  const hr = gripHand(M, -0.118, -0.102); group.add(hr.group);
  const hl = cupHand(M, 0.265, BY - 0.013 - 0.0207); group.add(hl.group);

  finish(group);
  return {
    group, muzzle, eject, sight: [0, SY, -0.05], lens: null,
    mounts: { muzzle: { r: 0.0105 }, optic: { y: 0.064, f: 0.045 }, tube: { y: TY, f: 0.504, r: 0.0078 } },
    animate(s, out) {
      const c = s.cycle;
      squeeze(hr.index, s.trigger);
      // every shot: lever thrown down and forward, bolt back (cocking the hammer), lever home
      let lv = (s.mag > 0 || c < 0.5) ? eseg(c, 0.1, 0.22) - eseg(c, 0.27, 0.4) : 0;
      if (c > 0.06 && c < 0.44) { out.r.x -= 0.07 * lv; out.p.y -= 0.014 * lv; out.r.z += 0.07 * lv; out.p.z += 0.01 * lv; }
      let ham = eseg(c, 0.1, 0.2);
      let lx = 0, ly = 0, lf = 0;
      if (s.rl) {
        const { phase, t } = s.rl;
        const tilt = phase === 'start' ? ease(t) : phase === 'end' ? 1 - eseg(t, 0.35, 1) : 1;
        out.r.z += 0.5 * tilt; out.r.x += 0.2 * tilt; out.p.y += 0.035 * tilt; out.p.x -= 0.035 * tilt;
        ham = 1;
        if (phase === 'loop') {
          const push = bump(t, 0.3, 0.75);
          out.p.y += 0.01 * push; out.r.x += 0.025 * push; out.p.z -= 0.006 * push;
          ly = -0.13 * (1 - eseg(t, 0.05, 0.5)) - 0.1 * eseg(t, 0.75, 1) - 0.02; lf = -0.245 + 0.06 * eseg(t, 0.4, 0.6); lx = 0.035;
        } else if (phase === 'start') { ly = -0.15 * t; lf = -0.245 * t; lx = 0.035 * t; }
        else {
          const k = 1 - eseg(t, 0, 0.3); ly = -0.15 * k; lf = -0.245 * k; lx = 0.035 * k;
          lv = s.rl.pump ? eseg(t, 0.3, 0.55) - eseg(t, 0.6, 0.9) : 0;
        }
      }
      lever.rotation.x = 0.85 * lv; bolt.position.z = 0.05 * lv; hammer.rotation.x = 0.75 * Math.max(ham, lv);
      offset(hr.group, 0, -0.05 * lv, 0.028 * lv);
      offset(hl.group, lx, ly, lf);
    },
  };
}

// =============================================================================
// NIGHTJAR — compact crossbow: split limbs with cams, a flight rail, an olive housing; the string is live
// =============================================================================
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1);
function span(obj, ax, ay, az, bx, by, bz) { // stretch a unit-length rod (along z) between two points
  _a.set(bx - ax, by - ay, bz - az); const len = _a.length();
  obj.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  obj.quaternion.setFromUnitVectors(_z, _a.multiplyScalar(1 / (len || 1)));
  obj.scale.set(1, 1, len);
}
export function buildCrossbow() {
  const M = materials(); const group = new THREE.Group(); const K = new Kit();
  const BY = 0.052, SY = 0.104, RF = 0.44, LX = 0.03, TIPX = 0.108, TIPF = -0.05, LATCH = 0.07;
  // housing + fore-end, flight rail with a groove, riser block, foot stirrup
  K.add(profile([[-0.14, -0.012], [-0.14, 0.046], [-0.125, 0.06], [0.03, 0.06], [0.05, 0.044], [0.24, 0.03], [0.24, 0.014], [0.08, -0.022], [-0.03, -0.022], [-0.04, -0.034], [-0.092, -0.034], [-0.105, -0.014]], 0.04, 0.006), M.polyOD);
  K.add(rbox(0.026, 0.016, 0.44, 0.003), M.anod, 0, 0.04, 0.23);
  K.add(rbox(0.006, 0.001, 0.4, 0.0003, 1), M.black, 0, 0.0482, 0.24);
  K.add(rbox(0.07, 0.022, 0.05, 0.005), M.anod, 0, 0.036, RF);
  K.add(new THREE.TorusGeometry(0.034, 0.0032, 6, 18, Math.PI), M.steel, 0, 0.034, RF + 0.022, -Math.PI / 2);
  for (const s of [-1, 1]) screw(K, M, s * 0.0352, 0.04, RF, 0.0035, s);
  rail(K, M.anod, 0.06, -0.12, 0.02);
  K.add(rbox(0.03, 0.012, 0.03, 0.003), M.steel, 0, 0.056, 0.055); // string latch
  for (let i = 0; i < 3; i++) for (const s of [-1, 1]) K.add(rbox(0.001, 0.006, 0.03, 0.0003, 1), M.black, s * 0.0202, 0.02 + i * 0.0, 0.1 + i * 0.045);
  // grip, guard, trigger
  K.add(profile(GRIP_PTS, 0.032, 0.009), M.grip);
  K.add(rbox(0.014, 0.0035, 0.08, 0.001), M.anod, 0, -0.062, 0.003);
  K.add(rbox(0.014, 0.036, 0.0035, 0.001), M.anod, 0, -0.046, 0.043, 0.3);
  K.add(profile(TRIGGER, 0.006, 0.0012), M.steel, 0, 0, 0.004);
  K.build(group);
  { const mk = marking(['NIGHTJAR', 'TESSEL ARMORY   NJ-0418'], 0.07); mk.position.set(-0.0203, 0.03, 0.06); group.add(mk); }
  const muzzle = sub(group, 0, BY, 0.47);

  // limbs (flex around their root), cams at the tips
  const limbs = [-1, 1].map((s) => {
    const g = sub(group, s * LX, 0.05, RF), k = new Kit();
    k.add(profile([[0.01, 0.0], [0.016, 0.03], [0.002, 0.076], [-0.044, 0.114], [-0.057, 0.104], [-0.016, 0.068], [-0.006, 0.03], [-0.014, 0.0]], 0.02, 0.004), M.poly, 0, 0, 0, 0, 0, -s * Math.PI / 2);
    k.add(new THREE.CylinderGeometry(0.014, 0.014, 0.009, 16), M.bare, s * TIPX, 0, TIPF);
    k.add(new THREE.CylinderGeometry(0.004, 0.004, 0.026, 8), M.steel, s * TIPX, 0, TIPF);
    k.add(rbox(0.012, 0.024, 0.02, 0.003), M.anod, s * 0.012, 0, 0.0);
    k.build(g); return g;
  });
  const strings = [0, 1].map(() => { const g = new THREE.Group(); new Kit().add(tube(0.0015, 1, 6), M.paintWhite).build(g); group.add(g); return g; });
  // bolt: carbon shaft, steel head, bright vanes
  const bolt = sub(group, 0, BY, LATCH);
  { const k = new Kit();
    k.add(tube(0.0032, 0.345, 8), M.anod, 0, 0, 0.176);
    k.add(lathe([[0.0001, 0.385], [0.005, 0.356], [0.0032, 0.346]], 8), M.bare);
    k.add(tube(0.0038, 0.01, 8), M.paintTeal, 0, 0, 0.004);
    for (let i = 0; i < 3; i++) { const a = Math.PI / 2 + i * Math.PI * 2 / 3; k.add(rbox(0.0009, 0.012, 0.045, 0.0003, 1), M.paintTeal, Math.cos(a) * 0.0075, Math.sin(a) * 0.0075, 0.04, 0, 0, a - Math.PI / 2); }
    k.build(bolt); }
  // skeleton stock (own group), default sights: rear aperture + hooded front pin (own group)
  const stock = sub(group, 0, 0, 0);
  { const k = new Kit();
    k.add(profile([[-0.14, 0.046], [-0.36, 0.046], [-0.375, 0.036], [-0.375, -0.075], [-0.36, -0.085], [-0.335, -0.07], [-0.29, -0.01], [-0.14, -0.01]], 0.034, 0.006,
      [[[-0.2, 0.03], [-0.345, 0.03], [-0.35, -0.03], [-0.305, 0.008]]]), M.polyOD);
    k.add(rbox(0.036, 0.13, 0.012, 0.004), M.rubber, 0, -0.02, -0.381);
    k.add(rbox(0.036, 0.012, 0.09, 0.005), M.rubber, 0, 0.052, -0.27);
    k.build(stock); }
  const optDef = sub(group, 0, 0, 0);
  { const k = new Kit();
    k.add(rbox(0.02, 0.008, 0.024, 0.002), M.anod, 0, 0.0702, -0.08);
    k.add(rbox(0.003, SY - 0.0045 - 0.074, 0.003, 0.0005, 1), M.steel, 0, (SY - 0.0045 + 0.074) / 2, -0.08);
    k.add(new THREE.TorusGeometry(0.005, 0.0016, 8, 20), M.steel, 0, SY, -0.08);
    k.add(rbox(0.014, 0.008, 0.016, 0.002), M.anod, 0, 0.057, RF - 0.01);
    k.add(rbox(0.0022, SY - 0.061, 0.0022, 0.0004, 1), M.steel, 0, (SY + 0.061) / 2, RF - 0.01);
    k.add(new THREE.TorusGeometry(0.0095, 0.0014, 6, 20), M.steel, 0, SY, RF - 0.01);
    k.add(new THREE.SphereGeometry(0.0016, 8, 6), M.tritium, 0, SY, RF - 0.01);
    k.build(optDef); }

  const hr = gripHand(M, -0.044, -0.105); group.add(hr.group);
  const hl = cupHand(M, 0.165, -0.004); group.add(hl.group);

  finish(group);
  return {
    group, muzzle, eject: null, sight: [0, SY, -0.08], lens: null,
    mounts: { optic: { y: 0.0662, f: -0.05, def: optDef }, under: { y: 0.01, f: 0.225, small: true }, side: { x: -0.0145, y: 0.03, f: 0.31 }, stock: { group: stock, y: 0.018, f: -0.14 } },
    animate(s, out) {
      squeeze(hr.index, s.trigger);
      const c = s.cycle;
      // draw: 1 = string latched, 0 = at rest. After the shot it snaps forward and rings for a moment.
      let d = s.mag > 0 ? 1 : 0, wob = 0, boltOn = s.mag > 0, bx = 0, by = 0, bf = 0, lx = 0, ly = 0, lf = 0;
      if (s.mag === 0 && c < 0.35) wob = Math.sin(c * 95) * Math.exp(-c * 13) * 0.03;
      if (s.rl) {
        const t = s.rl.t;
        const tilt = eseg(t, 0, 0.1) * (1 - eseg(t, 0.86, 1));
        out.r.x -= 0.2 * tilt; out.r.z += 0.14 * tilt; out.p.y -= 0.02 * tilt; out.p.x -= 0.02 * tilt;
        d = eseg(t, 0.14, 0.5);
        const pull = bump(t, 0.14, 0.52); out.p.z += 0.016 * pull; out.r.x += 0.03 * pull;
        const click = bump(t, 0.47, 0.57); out.r.x -= 0.035 * click; out.p.y -= 0.006 * click;
        const e = eseg(t, 0.56, 0.72);
        boltOn = t > 0.55; bx = -0.07 * (1 - e); by = 0.05 * (1 - e); bf = -0.05 * (1 - e);
        const seat = bump(t, 0.68, 0.78); out.p.z -= 0.006 * seat;
        // left hand: to the string, back with it to the latch, then over the rail with the bolt
        const w1 = eseg(t, 0.03, 0.13) * (1 - eseg(t, 0.5, 0.56)), w2 = eseg(t, 0.54, 0.6) * (1 - eseg(t, 0.74, 0.84));
        const nf = 0.39 - (0.39 - LATCH) * d;
        lx = 0.03 * (w1 + w2); ly = 0.07 * w1 + (0.09 + by) * w2; lf = (nf - 0.165 - 0.02) * w1 + (0.03 + bf) * w2;
      }
      // limbs bend with the draw; the string runs tip - nock - tip
      const flex = 0.17 * d - wob * 2;
      const cs = Math.cos(flex), sn = Math.sin(flex);
      const tx = LX + TIPX * cs - (-TIPF) * sn, tf = RF + TIPF * cs - TIPX * sn * 1.0; // right tip (x, f)
      limbs[0].rotation.y = flex; limbs[1].rotation.y = -flex;
      const nf = tf - (tf - LATCH) * d + wob;
      span(strings[0], -tx, BY, -tf, 0, BY, -nf);
      span(strings[1], tx, BY, -tf, 0, BY, -nf);
      bolt.visible = boltOn; offset(bolt, bx, by, bf);
      offset(hl.group, lx, ly, lf);
    },
  };
}
