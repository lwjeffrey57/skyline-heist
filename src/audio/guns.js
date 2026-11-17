// Gunshot source model + environment impulse responses, computed sample by sample (no oscillators).
//
// A recorded gunshot is: (1) a broadband pressure spike ("N-wave": sub-millisecond rise, 1-3 ms body),
// (2) a few tens of ms of turbulent muzzle gas (noise whose bandwidth collapses quickly), (3) a heavily
// damped low-frequency thump, (4) the weapon's action cycling, all (5) soft-clipped by the microphone -
// and then, for most of its duration, (6) the ENVIRONMENT: ground bounce, nearby walls, far slap-backs and a
// long darkening roll outdoors, or a short loud bright ring indoors. Parts 1-5 are baked into each buffer
// here (with per-variant differences); part 6 is two convolution responses the engine crossfades at runtime.
// There are deliberately no pitch sweeps anywhere: they are what makes synthetic guns sound like lasers.

export const GSR = 44100;

class Biquad { // RBJ cookbook, transposed direct form II
  constructor(type, f, q) { this.z1 = 0; this.z2 = 0; this.set(type, f, q); }
  set(type, f, q) {
    const w = (2 * Math.PI * Math.min(f, GSR * 0.45)) / GSR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    let b0, b1, b2; const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; } else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; } else { b0 = al; b1 = 0; b2 = -al; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  run(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}
const jit = (R, x, a) => x * (1 + (R() - 0.5) * 2 * a);

// short metallic transient: a noise tick ringing a few high-Q modes
function clank(out, R, at, gain, modes, tick = 0.0015) {
  const n0 = Math.floor(at * GSR), filt = modes.map((m) => new Biquad('bp', jit(R, m[0], 0.04), m[1])), nt = Math.floor(tick * GSR);
  const len = Math.floor(0.35 * GSR);
  for (let i = 0; i < len && n0 + i < out.length; i++) {
    const x = i < nt ? (R() * 2 - 1) * (1 - i / nt) : 0;
    let y = x * 0.25;
    for (let k = 0; k < filt.length; k++) y += filt[k].run(x) * modes[k][2];
    out[n0 + i] += y * gain;
    if (i > nt * 8 && Math.abs(y) < 1e-5) break;
  }
}

// p: nT (N-wave length ms), nG, crackTau (ms), crackHP, crackG, gasTau (ms), gasF0/gasF1 (Hz), gasFT (ms), gasG,
//    thF (Hz), thQ, thTau (ms), thG, resG, subG, drive, len (s), mech: [[time s, gain, modes]], bounce
// Auditionable voicings (F4 in game). All three pull the weight down out of the hiss region:
// crack band-limited to ~2-5 kHz, a 150-900 Hz body, a firmer low punch and a steep roll-off on top.
export const PROFILES = {
  A: { crackLP: 5200, topLP: 8000, bodyG: 0.55, punch: 1.35, crackM: 1.25, gasM: 0.8, mechM: 0.45, driveM: 1.15, subM: 1.0, tauM: 1.0, send: 0.6, roll: 1.0 },   // real, close, punchy
  B: { crackLP: 4200, topLP: 5800, bodyG: 0.9, punch: 1.2, crackM: 0.7, gasM: 0.55, mechM: 0.3, driveM: 1.3, subM: 0.6, tauM: 0.75, send: 0.3, roll: 0.6 },   // dry, tight, mid-heavy
  C: { crackLP: 5000, topLP: 7500, bodyG: 0.6, punch: 1.8, crackM: 1.0, gasM: 1.0, mechM: 0.4, driveM: 1.2, subM: 1.8, tauM: 1.4, send: 1.0, roll: 1.5 },    // big, boomy, long roll
};

export function gunRaw(R, p, F = PROFILES.A) {
  const n = Math.floor(p.len * Math.max(1, F.tauM * 0.93) * GSR), o = new Float32Array(n);
  // (1) N-wave: instant rise, linear fall through zero, slower recovery
  const T = Math.max(4, Math.floor((jit(R, p.nT, 0.12) / 1000) * GSR));
  for (let i = 0; i < T * 2.4 && i < n; i++) { const x = i / T; o[i] += p.nG * (x < 1 ? 1 - 1.55 * x : -0.55 * (1 - (x - 1) / 1.4)) * (i === 0 ? 0.6 : 1); }
  // crack: broadband noise, gone in a couple of ms, with a quieter "hash" lasting a little longer
  const hp = new Biquad('hp', p.crackHP, 0.7), clp = new Biquad('lp', F.crackLP, 0.8), body = new Biquad('bp', 420, 0.6), tb = 0.022 * F.tauM * GSR, tc = (jit(R, p.crackTau, 0.15) / 1000) * GSR;
  // (2) muzzle gas: noise through a low-pass whose cut-off collapses
  const tg = (jit(R, p.gasTau, 0.15) / 1000) * GSR * F.tauM, tf = (p.gasFT / 1000) * GSR; let g1 = 0, g2 = 0;
  // (3) thump: band-limited noise + a damped resonance kicked by the spike (2-3 cycles, no sweep)
  const thF = jit(R, p.thF, 0.08), bpT = new Biquad('bp', thF, p.thQ), res = new Biquad('bp', thF * 0.85, p.thQ * 1.8), tt = (jit(R, p.thTau, 0.12) / 1000) * GSR * F.tauM;
  const sub = new Biquad('lp', thF * 0.6, 0.7), att = 0.002 * GSR;
  for (let i = 0; i < n; i++) {
    const w = R() * 2 - 1, w2 = R() * 2 - 1;
    let v = clp.run(hp.run(w)) * (Math.exp(-i / tc) + 0.22 * Math.exp(-i / (tc * 5))) * p.crackG * F.crackM * 1.6;
    v += body.run(w) * Math.exp(-i / tb) * F.bodyG * 2.2;
    const fc = p.gasF1 + (p.gasF0 - p.gasF1) * Math.exp(-i / tf), a = 1 - Math.exp((-2 * Math.PI * fc) / GSR);
    g1 += (w2 - g1) * a; g2 += (g1 - g2) * a;
    v += g2 * Math.exp(-i / tg) * Math.min(1, i / 12) * p.gasG * F.gasM * Math.sqrt(8000 / fc);
    const te = Math.exp(-i / tt) * Math.min(1, i / att);
    v += (bpT.run(w) * te * p.thG * 3 + res.run(i < T ? p.nG : 0) * p.resG * 2.5) * F.punch + sub.run(w2) * Math.exp(-i / (tt * 2.2)) * Math.min(1, i / (att * 4)) * p.subG * 4 * F.subM;
    o[i] += v;
  }
  // ground bounce a few ms later (different every variant), inverted and duller
  if (p.bounce) {
    const d = Math.floor((0.0025 + R() * 0.004) * GSR), g = -p.bounce * (0.8 + R() * 0.4); let lp = 0;
    const src = o.slice();
    for (let i = d; i < n; i++) { lp += (src[i - d] - lp) * 0.45; o[i] += lp * g; }
  }
  // (5) overloaded microphone: normalise, then soft-clip so the spike squares off and the body comes up
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(o[i]));
  const k = (p.drive * F.driveM) / pk, nk = Math.tanh(p.drive * F.driveM);
  for (let i = 0; i < n; i++) o[i] = Math.tanh(o[i] * k) / nk;
  // (4) action noise, after the blast
  if (p.mech) for (const m of p.mech) clank(o, R, jit(R, m[0], 0.1), m[1] * F.mechM * (0.8 + R() * 0.4), m[2], m[3]);
  // steep roll-off on top (24 dB/oct): no \"tss\"
  const t1 = new Biquad('lp', F.topLP, 0.6), t2 = new Biquad('lp', F.topLP, 0.9);
  for (let i = 0; i < n; i++) o[i] = t2.run(t1.run(o[i]));
  return o;
}

// near-miss: the bullet's own shock wave. A tiny N-wave and a few ms of hiss; no tone.
export function snapRaw(R) {
  const n = Math.floor(0.12 * GSR), o = new Float32Array(n), T = 6 + Math.floor(R() * 5), hp = new Biquad('hp', 2500, 0.7), lp = new Biquad('lp', 500, 0.7);
  for (let i = 0; i < T * 2.4; i++) { const x = i / T; o[i] += x < 1 ? 1 - 1.55 * x : -0.55 * (1 - (x - 1) / 1.4); }
  const tc = 0.0012 * GSR, th = (0.012 + R() * 0.01) * GSR;
  for (let i = 0; i < n; i++) { const w = R() * 2 - 1; o[i] += hp.run(w) * (0.7 * Math.exp(-i / tc) + 0.1 * Math.exp(-i / th)) + lp.run(w) * 0.5 * Math.exp(-i / (0.015 * GSR)) * Math.min(1, i / 40); }
  for (let i = 0; i < n; i++) o[i] = Math.tanh(o[i] * 2.5);
  return o;
}

const METAL = { // [Hz, Q, gain]
  carrier: [[1850, 14, 1], [3100, 18, 0.8], [4700, 20, 0.5], [640, 6, 0.9]],
  home: [[2300, 16, 1], [3900, 20, 0.6], [900, 6, 0.8]],
  spring: [[705, 45, 1], [1420, 50, 0.45]],
  clunk: [[420, 8, 1], [1150, 10, 0.6], [2600, 14, 0.3]],
};
export const GUNS = {
  // 5.56-class carbine: sharp crack, short thump, fast clatter and a faint buffer-spring ring
  gun_rifle: { len: 0.42, nT: 0.55, nG: 1.0, crackTau: 1.1, crackHP: 1800, crackG: 1.0, gasTau: 11, gasF0: 9000, gasF1: 700, gasFT: 9, gasG: 0.5,
    thF: 118, thQ: 1.3, thTau: 38, thG: 0.5, resG: 0.5, subG: 0.12, drive: 3.2, bounce: 0.35,
    mech: [[0.036, 0.055, METAL.carrier], [0.062, 0.05, METAL.home], [0.04, 0.012, METAL.spring, 0.004]] },
  // 12-gauge: wider, lower, longer
  gun_shotgun: { len: 0.6, nT: 1.5, nG: 1.0, crackTau: 2.2, crackHP: 900, crackG: 0.75, gasTau: 30, gasF0: 5200, gasF1: 380, gasFT: 22, gasG: 0.75,
    thF: 78, thQ: 1.2, thTau: 85, thG: 0.9, resG: 0.8, subG: 0.3, drive: 4.2, bounce: 0.3 },
  // .50: huge crack, deep long concussion
  gun_heavy: { len: 0.9, nT: 1.0, nG: 1.2, crackTau: 2.0, crackHP: 1400, crackG: 1.1, gasTau: 40, gasF0: 8000, gasF1: 300, gasFT: 30, gasG: 0.8,
    thF: 56, thQ: 1.2, thTau: 130, thG: 1.1, resG: 1.0, subG: 0.6, drive: 5.5, bounce: 0.3 },
  // launcher: no crack; a soft pulse ringing the tube (a real, short resonance) and a clunk
  gun_grenade: { len: 0.5, nT: 3.5, nG: 0.5, crackTau: 1.5, crackHP: 900, crackG: 0.2, gasTau: 16, gasF0: 1600, gasF1: 300, gasFT: 14, gasG: 0.5,
    thF: 74, thQ: 1.4, thTau: 60, thG: 0.5, resG: 0.6, subG: 0.2, drive: 1.8, bounce: 0.2, tube: [[205, 5, 1], [430, 6, 0.45], [690, 7, 0.2]],
    mech: [[0.095, 0.06, METAL.clunk]] },
  // enemy carbine: a little larger and duller than the player's so the two never blur together
  gun_bot: { len: 0.45, nT: 0.75, nG: 1.0, crackTau: 1.4, crackHP: 1400, crackG: 0.9, gasTau: 15, gasF0: 7000, gasF1: 550, gasFT: 12, gasG: 0.6,
    thF: 98, thQ: 1.3, thTau: 50, thG: 0.6, resG: 0.6, subG: 0.15, drive: 3.0, bounce: 0.35, mech: [[0.045, 0.04, METAL.carrier]] },
};
export function gunSound(name, R, prof = 'A') {
  const p = GUNS[name], o = gunRaw(R, p, PROFILES[prof] || PROFILES.A);
  if (p.tube) { // excite the tube modes with the launch pulse
    const f = p.tube.map((m) => new Biquad('bp', jit(R, m[0], 0.03), m[1])), nT = Math.floor(0.004 * GSR);
    for (let i = 0; i < o.length; i++) { const x = i < nT ? (R() * 2 - 1) * 0.5 + 1 - i / nT : 0; let y = 0; for (let k = 0; k < f.length; k++) y += f[k].run(x) * p.tube[k][2]; o[i] += y * 0.55; }
  }
  return o;
}

// ---- environment impulse responses (stereo) ---------------------------------------------------------------
function burst(d, R, at, len, gain, lpK) { // a diffuse reflection: a short shaped noise packet
  const n0 = Math.floor(at * GSR), n = Math.max(2, Math.floor(len * GSR)); let lp = 0;
  for (let i = 0; i < n && n0 + i < d.length; i++) { const e = Math.sin((Math.PI * (i + 0.5)) / n); lp += ((R() * 2 - 1) - lp) * lpK; d[n0 + i] += lp * e * e * gain / Math.sqrt(lpK); }
}
// open city: nearby walls, slap-backs off distant facades, then a long roll that darkens as it decays
export function irOutdoor(R) {
  const sec = 2.8, n = Math.floor(sec * GSR), ch = [new Float32Array(n), new Float32Array(n)];
  const near = [], far = [];
  for (let i = 0; i < 6; i++) near.push([0.014 + i * 0.008 + R() * 0.006, 0.42 - i * 0.045, R()]);
  for (let i = 0; i < 8; i++) far.push([0.11 + i * 0.055 + R() * 0.04, 0.5 * Math.exp(-i * 0.27), R()]);
  for (let c = 0; c < 2; c++) {
    const d = ch[c];
    for (const t of near) burst(d, R, t[0] + c * 0.0007, 0.002 + R() * 0.003, t[1] * (c ? t[2] : 1 - t[2]) * 1.6 + t[1] * 0.25, 0.6);
    for (const t of far) burst(d, R, t[0] + (c ? 0.002 : 0) * t[2], 0.05 + t[0] * 0.22, t[1] * 0.3 * (0.35 + (c ? t[2] : 1 - t[2])), Math.max(0.06, 0.4 - t[0] * 0.6));
    // diffuse roll: -60 dB in ~2.3 s, cut-off sliding from ~3 kHz to ~250 Hz, slowly undulating
    let l1 = 0, l2 = 0, wob = 0, wt = 0;
    for (let i = 0; i < n; i++) {
      const t = i / GSR, fc = 240 + 3000 * Math.exp(-t / 0.55), a = 1 - Math.exp((-2 * Math.PI * fc) / GSR);
      l1 += ((R() * 2 - 1) - l1) * a; l2 += (l1 - l2) * a;
      if (i % 2048 === 0) wt = R() * 2 - 1; wob += (wt - wob) * 0.0006;
      const env = Math.pow(10, (-3 * t) / 2.3) * Math.min(1, t / 0.09) * (1 + 0.5 * wob);
      d[i] += l2 * env * 0.2 * Math.sqrt(3200 / fc);
    }
    for (let i = n - 2000; i < n; i++) d[i] *= (n - i) / 2000;
  }
  return ch;
}
// room: dense bright early reflections right on top of the shot, then a short loud ring
export function irRoom(R) {
  const sec = 0.95, n = Math.floor(sec * GSR), ch = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    const d = ch[c];
    let t = 0.0022 + R() * 0.001;
    for (let k = 0; k < 34; k++) { burst(d, R, t, 0.0006 + R() * 0.0012, (k % 2 ? -1 : 1) * 0.75 * Math.exp(-t / 0.035), 0.85); t += (0.0012 + R() * 0.0028) * (1 + k * 0.035); }
    let l1 = 0;
    for (let i = 0; i < n; i++) {
      const tt = i / GSR, fc = 2600 + 6500 * Math.exp(-tt / 0.25), a = 1 - Math.exp((-2 * Math.PI * fc) / GSR);
      l1 += ((R() * 2 - 1) - l1) * a;
      d[i] += l1 * Math.pow(10, (-3 * tt) / 0.62) * Math.min(1, tt / 0.012) * 0.3;
    }
    for (let i = n - 1000; i < n; i++) d[i] *= (n - i) / 1000;
  }
  return ch;
}

// low-end layer for the recorded rifle / shotgun (their close-mic recordings carry almost nothing below 150 Hz):
// the synthesised shot of the same weapon, low-passed at 160 Hz
export function subPunch(name, R) {
  const o = gunSound(name, R, 'A'), a = new Biquad('lp', 160, 0.7), b = new Biquad('lp', 160, 0.7);
  for (let i = 0; i < o.length; i++) o[i] = b.run(a.run(o[i]));
  return o;
}
