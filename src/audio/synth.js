// Procedural sound library. Every sound is a small Web Audio graph built by a recipe function
//   recipe(ac, out, R, v)      ac: any BaseAudioContext, out: destination node, R: seeded rng, v: variant index
// and is rendered ONCE per variant through an OfflineAudioContext into an AudioBuffer (renderSound).
// At runtime the engine only plays buffers, so a gunshot costs one BufferSource and starts on its first
// sample (all transients sit at t = 0 with no attack ramp). Nothing here imitates an existing game.

import { gunSound, snapRaw, irOutdoor, irRoom, PROFILES, subPunch, mechSound } from './guns.js';
export { PROFILES };

export const SR = 44100;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- shared, context-free source material (built once at init) --------------------------------------------
export const NOISE = {}; export const IR = {};
let _curves = {};
export function prebuild() {
  if (NOISE.white) return;
  const R = rng(4242);
  const mk = (sec, ch = 1) => new AudioBuffer({ length: Math.floor(sec * SR), numberOfChannels: ch, sampleRate: SR });
  const w = mk(2), wd = w.getChannelData(0);
  for (let i = 0; i < wd.length; i++) wd[i] = R() * 2 - 1;
  const b = mk(4), bd = b.getChannelData(0);
  let acc = 0, peak = 0;
  for (let i = 0; i < bd.length; i++) { acc = (acc + (R() * 2 - 1) * 0.04) * 0.997; bd[i] = acc; peak = Math.max(peak, Math.abs(acc)); }
  for (let i = 0; i < bd.length; i++) bd[i] /= peak;
  NOISE.white = w; NOISE.brown = b;
  // impulse responses: sparse early slap-backs off buildings + diffuse tail that darkens with time
  const ir = (sec, t60, ch, slaps, seed) => {
    const Q = rng(seed), buf = mk(sec, ch);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c); let lp = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / SR, env = Math.pow(10, (-3 * t) / t60) * Math.min(1, t / 0.012);
        const k = 0.55 * Math.exp(-t * 2.2) + 0.06;          // one-pole coefficient shrinks -> darker late tail
        lp += ((Q() * 2 - 1) - lp) * k; d[i] = lp * env * 0.6;
      }
      for (let s = 0; s < slaps; s++) {
        const t = 0.035 + Q() * 0.26, at = Math.floor(t * SR), g = (0.9 - t * 2) * (Q() < 0.5 ? -1 : 1), wl = 40 + Math.floor(Q() * 120);
        for (let i = 0; i < wl && at + i < d.length; i++) d[at + i] += g * (Q() * 2 - 1) * Math.exp(-i / (wl * 0.3));
      }
    }
    return buf;
  };
  IR.tail = ir(1.5, 1.1, 1, 5, 23);   // baked into explosions
  // runtime environments (see guns.js): open city, and a room for when there is a roof overhead
  const toBuf = (ch) => { const b = mk(ch[0].length / SR, 2); b.copyToChannel(ch[0], 0); b.copyToChannel(ch[1], 1); return b; };
  IR.urban = toBuf(irOutdoor(rng(11)));
  IR.room = toBuf(irRoom(rng(37)));
}
function curve(k) {
  if (_curves[k]) return _curves[k];
  const n = 2048, c = new Float32Array(n), nk = Math.tanh(k);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * k) / nk;
  return (_curves[k] = c);
}

// ---- building blocks --------------------------------------------------------------------------------------
const E = 0.0001;
function env(ac, t, a, d, peak) { // gain node: (optional) linear attack then exponential decay
  const g = ac.createGain(), p = g.gain;
  if (a > 0) { p.setValueAtTime(0, 0); p.setValueAtTime(0, t); p.linearRampToValueAtTime(peak, t + a); }
  else { if (t > 0) p.setValueAtTime(0, 0); p.setValueAtTime(peak, t); }
  p.exponentialRampToValueAtTime(Math.max(E, peak * 0.001), t + a + d);
  p.linearRampToValueAtTime(0, t + a + d + 0.01);
  return g;
}
function nsrc(ac, R, t, dur, kind = 'white') {
  const s = ac.createBufferSource(); s.buffer = NOISE[kind]; s.loop = true;
  s.start(t, R() * (NOISE[kind].duration - 0.1)); s.stop(t + dur + 0.05);
  return s;
}
function filt(ac, type, f, q = 0.707) { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
function sweep(p, t, f0, f1, dur) { p.setValueAtTime(Math.max(1, f0), t); if (f1 !== f0) p.exponentialRampToValueAtTime(Math.max(1, f1), t + dur); }
// filtered noise hit
function nz(ac, out, R, t, o) {
  const dur = (o.a || 0) + o.d, s = nsrc(ac, R, t, dur, o.kind), f = filt(ac, o.type || 'bandpass', o.f0, o.q || 0.8);
  sweep(f.frequency, t, o.f0, o.f1 || o.f0, o.sd || dur);
  const g = env(ac, t, o.a || 0, o.d, o.g);
  s.connect(f); f.connect(g); g.connect(out);
  return g;
}
// pitched hit
function tn(ac, out, t, o) {
  const os = ac.createOscillator(); os.type = o.type || 'sine';
  sweep(os.frequency, t, o.f0, o.f1 || o.f0, o.sd || o.d * 0.7);
  const g = env(ac, t, o.a || 0, o.d, o.g);
  os.connect(g); g.connect(out); os.start(t); os.stop(t + (o.a || 0) + o.d + 0.05);
  return g;
}
function drive(ac, out, k, pre = 1) {
  const g = ac.createGain(); g.gain.value = pre;
  const ws = ac.createWaveShaper(); ws.curve = curve(k); ws.oversample = '2x';
  g.connect(ws); ws.connect(out); return g;
}
function conv(ac, out, lp, g) { // baked outdoor tail
  const c = ac.createConvolver(); c.normalize = true; c.buffer = IR.tail;
  const f = filt(ac, 'lowpass', lp), gg = ac.createGain(); gg.gain.value = g;
  c.connect(f); f.connect(gg); gg.connect(out); return c;
}
const j = (R, x, amt) => x * (1 + (R() - 0.5) * 2 * amt);

// scattered little noise/thud grains (debris, rubble, grit)
function grains(ac, out, R, n, t0, t1, o) {
  for (let i = 0; i < n; i++) {
    const u = Math.pow(R(), o.bias || 1.6), t = t0 + (t1 - t0) * u, g = o.g * (1 - u * 0.75) * (0.4 + 0.6 * R());
    if (o.thud && R() < o.thud) tn(ac, out, t, { f0: 90 + R() * 160, f1: 50 + R() * 40, d: 0.04 + R() * 0.06, g: g * 1.3 });
    else nz(ac, out, R, t, { f0: o.f[0] + R() * (o.f[1] - o.f[0]), q: 2 + R() * 4, d: 0.015 + R() * (o.len || 0.05), g: g * 2 });
  }
}
function bell(ac, out, t, f, d, g, parts = [1, 2.76, 5.4]) {
  parts.forEach((m, i) => tn(ac, out, t, { f0: f * m, d: d / (1 + i * 0.9), g: g / (1 + i * 1.4) }));
}

// ---- the library ------------------------------------------------------------------------------------------
// name: { d: seconds, n: variants, f: recipe, [stereo], [loop: crossfade seconds], [peak] }
const GUN_N = { gun_rifle: [0.42, 6], gun_shotgun: [0.6, 4], gun_heavy: [0.9, 3], gun_grenade: [0.5, 3], gun_bot: [0.45, 5] };
export const gunKey = (base, prof) => (prof === 'A' ? base : base + '_' + prof);

// ---- background music: 16 bars, 108 bpm, D minor (Dm - Bb - Gm - Am, one bar each), original -----------------
const BPM = 108, BEAT = 60 / BPM, BAR = BEAT * 4, BARS = 16;
function music(ac, out, R) {
  const m = ac.createChannelMerger(2); m.connect(out);
  const L = ac.createGain(), Rr = ac.createGain(); L.connect(m, 0, 0); Rr.connect(m, 0, 1);
  const bus = (pan) => { const g = ac.createGain(), l = ac.createGain(), r = ac.createGain(); l.gain.value = Math.cos((pan + 1) * 0.7854); r.gain.value = Math.sin((pan + 1) * 0.7854); g.connect(l); g.connect(r); l.connect(L); r.connect(Rr); return g; };
  const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const chords = [[50, 62, 65, 69], [46, 62, 65, 70], [43, 62, 67, 70], [45, 60, 64, 69]]; // root, then three voices
  const kick = bus(0), bass = filt(ac, 'lowpass', 420, 3), pad = filt(ac, 'lowpass', 1300, 0.7), arpL = bus(-0.45), arpR = bus(0.45), hat = bus(0.2);
  bass.connect(bus(0)); pad.connect(bus(-0.15)); const pad2 = filt(ac, 'lowpass', 1300, 0.7); pad2.connect(bus(0.15));
  for (let b = 0; b < BARS; b++) {
    const t0 = b * BAR, ch = chords[b % 4], sec = b >> 2; // sections: 0 intro (pad + bass), 1 + kick/hats, 2 + arp, 3 full with a higher arp
    // pad: two detuned voices per note, slow swell, released before the bar line
    for (let v = 1; v < 4; v++) for (const [dst, det] of [[pad, -5], [pad2, 6]]) {
      const os = ac.createOscillator(); os.type = 'sawtooth'; os.frequency.value = hz(ch[v]); os.detune.value = det;
      const g = ac.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.085, t0 + BEAT * 1.2); g.gain.setValueAtTime(0.085, t0 + BAR - BEAT * 0.9); g.gain.linearRampToValueAtTime(0, t0 + BAR - 0.02);
      os.connect(g); g.connect(dst); os.start(t0); os.stop(t0 + BAR);
    }
    for (let e = 0; e < 8; e++) { // bass: eighths on the root, octave on the off-beat, a rest for air
      if (e === 3 || (e === 6 && b % 2 === 0)) continue;
      const t = t0 + e * BEAT * 0.5, n = ch[0] - 12 + (e % 2 === 1 && e !== 1 ? 12 : 0) + (e === 7 && b % 4 === 3 ? -2 : 0);
      tn(ac, bass, t, { type: 'sawtooth', f0: hz(n), a: 0.006, d: BEAT * 0.42, g: 0.42 });
      tn(ac, bass, t, { f0: hz(n), a: 0.006, d: BEAT * 0.45, g: 0.3 });
    }
    if (sec >= 1) for (let q = 0; q < 4; q++) { // soft kick (short drop, no click) + off-beat hats
      const t = t0 + q * BEAT;
      if (!(sec === 1 && b % 4 === 3 && q === 3)) tn(ac, kick, t, { f0: 105, f1: 46, a: 0.003, d: 0.2, g: 0.75, sd: 0.07 });
      nz(ac, hat, R, t + BEAT * 0.5, { type: 'highpass', f0: 7000, a: 0.002, d: 0.035, g: 0.1 });
      if (sec === 3 && q % 2 === 1) nz(ac, hat, R, t + BEAT * 0.75, { type: 'highpass', f0: 8000, a: 0.002, d: 0.02, g: 0.05 });
    }
    if (sec >= 2) for (let s16 = 0; s16 < 16; s16++) { // arp: sixteenths across the chord, with gaps
      if (s16 % 8 === 3 || s16 === 14) continue;
      const pat = [1, 2, 3, 2, 1, 3, 2, 3][s16 % 8], n = ch[pat] + (sec === 3 && s16 % 4 === 2 ? 12 : 0) + (s16 >= 12 && b % 4 === 3 ? 12 : 0);
      tn(ac, s16 % 2 ? arpR : arpL, t0 + s16 * BEAT * 0.25, { type: 'triangle', f0: hz(n + 12), a: 0.004, d: 0.11, g: 0.16 });
    }
  }
}

export const SOUNDS = {
  sub_rifle: { d: 0.42, n: 3, peak: 0.45, raw: (R) => subPunch('gun_rifle', R) },
  sub_shotgun: { d: 0.6, n: 2, peak: 0.55, raw: (R) => subPunch('gun_shotgun', R) },
  music: { d: BAR * BARS, n: 1, stereo: true, exact: true, peak: 0.8, f: music },

  // gunshots are computed directly (audio/guns.js): N-wave + crack + muzzle gas + damped thump + action, soft-clipped.
  // The environment tail is NOT baked in; the engine convolves it at runtime (city vs room).

  imp_concrete: { d: 0.34, n: 5, f: (ac, o, R) => { nz(ac, o, R, 0, { type: 'highpass', f0: 1500, d: 0.007, g: 0.9 }); tn(ac, o, 0, { f0: j(R, 165, 0.2), f1: 68, d: 0.055, g: 0.8 }); nz(ac, o, R, 0, { f0: 1200 + R() * 1800, d: 0.09, g: 0.7, q: 0.9 }); grains(ac, o, R, 6, 0.02, 0.26, { f: [2000, 5200], g: 0.16 }); } },
  imp_metal: { d: 0.5, n: 5, f: (ac, o, R) => { const f = 900 + R() * 1300; nz(ac, o, R, 0, { type: 'highpass', f0: 4000, d: 0.01, g: 0.8 }); [1, 1.47, 2.09, 2.56, 3.71].forEach((m, i) => tn(ac, o, 0, { f0: f * m * (1 + (R() - 0.5) * 0.02), d: 0.3 / (1 + i * 0.7), g: 0.4 / (1 + i * 0.6) })); tn(ac, o, 0, { f0: 250, f1: 195, d: 0.07, g: 0.6 }); nz(ac, o, R, 0, { f0: f * 2.2, q: 9, d: 0.12, g: 0.8 }); } },
  imp_energy: { d: 0.28, n: 3, f: (ac, o, R) => { tn(ac, o, 0, { type: 'triangle', f0: j(R, 880, 0.1), f1: 2700, d: 0.05, g: 0.5 }); nz(ac, o, R, 0, { f0: 3200, f1: 1400, d: 0.05, g: 0.8, q: 1.2 }); tn(ac, o, 0, { f0: 210, f1: 85, d: 0.07, g: 0.8 }); nz(ac, o, R, 0.01, { type: 'highpass', f0: 6000, d: 0.12, g: 0.1 }); } },
  ricochet: { d: 0.62, n: 4, f: (ac, o, R) => { const f0 = 2200 + R() * 1500, f1 = 550 + R() * 600, d = 0.32 + R() * 0.2; nz(ac, o, R, 0, { type: 'highpass', f0: 3000, d: 0.008, g: 0.5 }); const os = ac.createOscillator(); os.type = 'sine'; sweep(os.frequency, 0, f0, f1, d); const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 28 + R() * 30; lg.gain.value = 60 + R() * 90; lfo.connect(lg); lg.connect(os.frequency); const g = env(ac, 0, 0.006, d, 0.5); os.connect(g); g.connect(o); os.start(0); lfo.start(0); os.stop(d + 0.1); lfo.stop(d + 0.1); nz(ac, o, R, 0, { f0, f1, q: 14, a: 0.005, d, g: 1.6 }); } },
  whiz: { d: 0.12, n: 5, raw: (R) => snapRaw(R) }, // supersonic snap of a near miss
  explosion: { d: 3.5, n: 3, f: (ac, o, R) => {
    const bus = drive(ac, o, 4, 0.85), tail = conv(ac, o, 1500, 0.55), p = ac.createGain(); p.connect(bus); p.connect(tail);
    nz(ac, p, R, 0, { type: 'highpass', f0: 1000, d: 0.035, g: 1.0 });
    nz(ac, p, R, 0, { type: 'lowpass', f0: j(R, 3600, 0.15), f1: 110, d: 0.95, g: 1.25, sd: 0.7, q: 0.6 });
    tn(ac, p, 0, { f0: j(R, 63, 0.08), f1: 25, d: 1.3, g: 1.5, sd: 0.9 });
    tn(ac, p, 0, { type: 'triangle', f0: 112, f1: 38, d: 0.32, g: 0.9 });
    tn(ac, o, 0.02, { f0: 41, f1: 21, d: 1.7, g: 0.5, sd: 1.2 });
    nz(ac, o, R, 0.04, { kind: 'brown', type: 'lowpass', f0: 240, f1: 90, a: 0.06, d: 2.6, g: 0.75, q: 0.5 });
    grains(ac, o, R, 26, 0.22, 2.6, { f: [700, 4200], g: 0.11, thud: 0.3, len: 0.06 });
  } },
  collapse_s: { d: 0.95, n: 3, f: (ac, o, R) => rubble(ac, o, R, 0.8, 11, 320) },
  collapse_m: { d: 2.1, n: 3, f: (ac, o, R) => rubble(ac, o, R, 1.8, 26, 230) },
  collapse_l: { d: 3.8, n: 2, f: (ac, o, R) => rubble(ac, o, R, 3.4, 50, 170) },
  crack: { d: 0.28, n: 4, f: (ac, o, R) => { nz(ac, o, R, 0, { f0: j(R, 1800, 0.25), d: 0.03, g: 1, q: 1 }); tn(ac, o, 0, { f0: j(R, 140, 0.2), f1: 75, d: 0.06, g: 0.8 }); grains(ac, o, R, 4, 0.02, 0.2, { f: [900, 3500], g: 0.2 }); } },

  // reload is three separate cues so the engine can spread them over the weapon's real reload time
  rl_out: { d: 0.3, n: 2, f: (ac, o, R) => { nz(ac, o, R, 0, { type: 'highpass', f0: 3500, d: 0.006, g: 0.7 }); tn(ac, o, 0, { type: 'square', f0: j(R, 1250, 0.05), d: 0.012, g: 0.2 }); tn(ac, o, 0, { f0: 260, f1: 190, d: 0.025, g: 0.5 }); nz(ac, o, R, 0.07, { f0: 1500, f1: 800, a: 0.02, d: 0.1, g: 0.3, q: 1.5 }); } },
  rl_in: { d: 0.2, n: 3, f: (ac, o, R) => { tn(ac, o, 0, { f0: j(R, 185, 0.08), f1: 120, d: 0.04, g: 0.9 }); nz(ac, o, R, 0, { f0: j(R, 900, 0.1), q: 4, d: 0.045, g: 1.4 }); nz(ac, o, R, 0, { type: 'highpass', f0: 3000, d: 0.008, g: 0.8 }); nz(ac, o, R, 0.03, { f0: 2400, q: 6, d: 0.03, g: 0.3 }); } },
  rl_bolt: { d: 0.3, n: 2, f: (ac, o, R) => { nz(ac, o, R, 0, { type: 'highpass', f0: 2500, d: 0.012, g: 0.8 }); tn(ac, o, 0, { f0: 230, f1: 170, d: 0.03, g: 0.5 }); nz(ac, o, R, 0.015, { f0: 1100, f1: 1900, a: 0.01, d: 0.05, g: 0.4, q: 2 }); const t = j(R, 0.085, 0.1); nz(ac, o, R, t, { type: 'highpass', f0: 2200, d: 0.014, g: 1 }); tn(ac, o, t, { f0: j(R, 2400, 0.05), d: 0.07, g: 0.12 }); tn(ac, o, t, { f0: 210, f1: 150, d: 0.04, g: 0.8 }); } },
  switch: { d: 0.34, n: 1, f: (ac, o, R) => { nz(ac, o, R, 0, { f0: 600, f1: 1900, a: 0.05, d: 0.09, g: 0.45, q: 0.9 }); nz(ac, o, R, 0.15, { type: 'highpass', f0: 2800, d: 0.01, g: 0.8 }); tn(ac, o, 0.15, { f0: 240, f1: 170, d: 0.035, g: 0.6 }); tn(ac, o, 0.15, { type: 'square', f0: 1700, d: 0.012, g: 0.12 }); } },
  dry: { d: 0.12, n: 1, f: (ac, o, R) => { nz(ac, o, R, 0, { type: 'highpass', f0: 3000, d: 0.005, g: 0.9 }); tn(ac, o, 0, { type: 'square', f0: 2100, d: 0.012, g: 0.2 }); tn(ac, o, 0, { f0: 320, f1: 260, d: 0.02, g: 0.5 }); } },
  // ---- hit confirmation. Four clearly different sounds, shortest and driest for the commonest event --------
  // body hit: a tight dry tick (click + a damped knock + a small low "thup"). 4 variants; the engine also
  // wanders pitch and level so a burst of hits never sounds like one sample machine-gunned.
  hit: { d: 0.09, n: 4, f: (ac, o, R) => {
    nz(ac, o, R, 0, { type: 'highpass', f0: 4200, d: 0.004, g: 0.9 });
    nz(ac, o, R, 0, { f0: j(R, 1700, 0.08), q: 3, d: 0.018, g: 1.1 });
    tn(ac, o, 0, { type: 'triangle', f0: j(R, 1250, 0.05), f1: 900, d: 0.028, g: 0.7 });
    tn(ac, o, 0, { f0: 190, f1: 110, d: 0.035, g: 0.55 });
  } },
  // headshot: brighter and harder - a crack with a short helmet "tink" (inharmonic, gone in ~90 ms). No long bell.
  headshot: { d: 0.2, n: 3, f: (ac, o, R) => hsCrack(ac, o, R, 1) },
  // kill: low and final - a sub drop, a dull body thud and a short dark two-note confirm underneath
  kill: { d: 0.45, n: 2, f: (ac, o, R) => killThump(ac, o, R, 1) },
  // headshot kill: the crack and the thump together, answered by one clean high ring
  headkill: { d: 0.7, n: 1, f: (ac, o, R) => {
    hsCrack(ac, o, R, 1); killThump(ac, o, R, 0.9);
    bell(ac, o, 0.035, 2637, 0.42, 0.26, [1, 2.0]); tn(ac, o, 0.035, { f0: 2637 * 1.005, d: 0.3, g: 0.07 });
  } },
  // multi-kill note (the engine plays it 2, 3, 4... times, climbing) and the score counter tick
  blip: { d: 0.3, n: 1, f: (ac, o, R) => { nz(ac, o, R, 0, { type: 'highpass', f0: 5000, d: 0.004, g: 0.5 }); bell(ac, o, 0, 1568, 0.22, 0.6, [1, 2, 3.01, 4.1]); tn(ac, o, 0, { type: 'triangle', f0: 784, d: 0.1, g: 0.25 }); } },
  tick: { d: 0.06, n: 1, f: (ac, o, R) => { nz(ac, o, R, 0, { type: 'highpass', f0: 6000, d: 0.003, g: 0.6 }); tn(ac, o, 0, { type: 'triangle', f0: 2400, d: 0.025, g: 0.7 }); tn(ac, o, 0, { f0: 4800, d: 0.015, g: 0.25 }); } },
  casing: { d: 0.4, n: 5, f: (ac, o, R) => {
    const f = 4100 + R() * 1500; let t = 0, g = 1;
    for (let b = 0; b < 3; b++) { [1, 1.52, 2.41].forEach((m, i) => tn(ac, o, t, { f0: f * m * (1 + b * 0.015), d: (0.05 + R() * 0.03) / (i + 1), g: g * 0.5 / (i + 1) })); nz(ac, o, R, t, { type: 'highpass', f0: 5000, d: 0.004, g: g * 0.5 }); t += 0.07 + R() * 0.07 - b * 0.02; g *= 0.45; }
  } },
  shell: { d: 0.4, n: 3, f: (ac, o, R) => {
    let t = 0, g = 1;
    for (let b = 0; b < 2; b++) { nz(ac, o, R, t, { f0: j(R, 1300, 0.15), q: 3, d: 0.02, g: g * 1.4 }); tn(ac, o, t, { f0: j(R, 880, 0.1), f1: 640, d: 0.035, g: g * 0.6 }); tn(ac, o, t, { f0: j(R, 3300, 0.1), d: 0.03, g: g * 0.12 }); t += 0.1 + R() * 0.06; g *= 0.4; }
  } },

  // boot on concrete: a dull low thud and a little scuff. No click, no pitch.
  step: { d: 0.2, n: 6, f: (ac, o, R) => { nz(ac, o, R, 0, { kind: 'brown', type: 'lowpass', f0: 230 + R() * 90, a: 0.004, d: 0.06 + R() * 0.02, g: 1.6, q: 0.6 }); nz(ac, o, R, 0, { f0: 105 + R() * 50, q: 1.4, a: 0.003, d: 0.07, g: 1.6 }); nz(ac, o, R, 0.012 + R() * 0.01, { type: 'lowpass', f0: 650 + R() * 250, a: 0.012, d: 0.05, g: 0.12, q: 0.5 }); } },
  jump: { d: 0.24, n: 1, f: (ac, o, R) => { tn(ac, o, 0, { f0: 120, f1: 70, d: 0.05, g: 0.7 }); nz(ac, o, R, 0, { f0: 380, f1: 950, a: 0.03, d: 0.12, g: 0.6, q: 0.9 }); } },
  land: { d: 0.42, n: 3, f: (ac, o, R) => { tn(ac, o, 0, { f0: j(R, 96, 0.1), f1: 41, d: 0.13, g: 1.1 }); nz(ac, o, R, 0, { type: 'lowpass', f0: 650, d: 0.07, g: 0.9 }); nz(ac, o, R, 0, { f0: 1500, d: 0.03, g: 0.3 }); grains(ac, o, R, 5, 0.03, 0.3, { f: [1500, 4000], g: 0.07 }); } },
  slide: { d: 0.95, n: 1, f: (ac, o, R) => { nz(ac, o, R, 0, { f0: 1100, f1: 600, a: 0.05, d: 0.8, g: 0.8, q: 0.7 }); nz(ac, o, R, 0, { kind: 'brown', type: 'lowpass', f0: 300, a: 0.04, d: 0.7, g: 0.8 }); grains(ac, o, R, 14, 0.02, 0.7, { f: [1500, 5000], g: 0.08, bias: 1 }); } },
  mantle: { d: 0.5, n: 1, f: (ac, o, R) => { tn(ac, o, 0, { f0: 150, f1: 90, d: 0.04, g: 0.7 }); nz(ac, o, R, 0, { f0: 1800, d: 0.02, g: 0.4 }); nz(ac, o, R, 0.04, { f0: 700, f1: 1000, a: 0.04, d: 0.14, g: 0.4, q: 1 }); tn(ac, o, 0.25, { f0: 115, f1: 60, d: 0.06, g: 0.9 }); nz(ac, o, R, 0.25, { f0: 800, d: 0.04, g: 0.4 }); } },
  pad: { d: 0.95, n: 1, f: (ac, o, R) => {
    tn(ac, o, 0, { f0: 84, f1: 44, d: 0.18, g: 1.1 });
    nz(ac, o, R, 0, { f0: 300, f1: 3400, a: 0.03, d: 0.5, g: 0.9, q: 2.2, sd: 0.4 });
    const f = filt(ac, 'lowpass', 400, 4); sweep(f.frequency, 0, 300, 3000, 0.3); f.connect(o);
    tn(ac, f, 0, { type: 'sawtooth', f0: 98, f1: 392, a: 0.01, d: 0.4, g: 0.4, sd: 0.3 });
    tn(ac, f, 0, { type: 'sawtooth', f0: 147.5, f1: 590, a: 0.01, d: 0.4, g: 0.25, sd: 0.3 });
    tn(ac, o, 0.05, { f0: 784, f1: 1568, a: 0.02, d: 0.4, g: 0.12, sd: 0.25 });
  } },
  zip_loop: { d: 2.0, n: 1, loop: 0.4, f: (ac, o, R) => {
    const D = 2.6, g = ac.createGain(); g.gain.value = 0.6; g.connect(o);
    const f = filt(ac, 'lowpass', 900, 2); f.connect(g);
    [82, 123.4, 164.8].forEach((hz, i) => { const os = ac.createOscillator(); os.type = 'sawtooth'; os.frequency.value = hz; const og = ac.createGain(); og.gain.value = 0.2 / (i + 1); os.connect(og); og.connect(f); os.start(0); os.stop(D); });
    const n = nsrc(ac, R, 0, D), bp = filt(ac, 'bandpass', 2300, 3), ng = ac.createGain(); ng.gain.value = 0.5;
    const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 17; lg.gain.value = 0.3; lfo.connect(lg); lg.connect(ng.gain); lfo.start(0); lfo.stop(D);
    n.connect(bp); bp.connect(ng); ng.connect(g);
    const w = nsrc(ac, R, 0, D, 'brown'), wl = filt(ac, 'lowpass', 700), wg = ac.createGain(); wg.gain.value = 1.2; w.connect(wl); wl.connect(wg); wg.connect(g);
  } },
  zip_on: { d: 0.3, n: 1, f: (ac, o, R) => { nz(ac, o, R, 0, { type: 'highpass', f0: 3000, d: 0.008, g: 0.8 }); [1, 1.52, 2.3].forEach((m, i) => tn(ac, o, 0, { f0: 1150 * m, d: 0.16 / (i + 1), g: 0.3 / (i + 1) })); tn(ac, o, 0, { f0: 200, f1: 130, d: 0.05, g: 0.8 }); nz(ac, o, R, 0.03, { f0: 2000, q: 3, d: 0.08, g: 0.5 }); } },
  zip_off: { d: 0.32, n: 1, f: (ac, o, R) => { nz(ac, o, R, 0, { type: 'highpass', f0: 2500, d: 0.008, g: 0.7 }); tn(ac, o, 0, { f0: 900, f1: 700, d: 0.06, g: 0.3 }); tn(ac, o, 0, { f0: 170, f1: 110, d: 0.05, g: 0.7 }); nz(ac, o, R, 0.01, { f0: 1600, f1: 500, a: 0.02, d: 0.2, g: 0.5, q: 1 }); } },

  hurt: { d: 0.38, n: 3, f: (ac, o, R) => { tn(ac, o, 0, { f0: j(R, 150, 0.1), f1: 52, d: 0.1, g: 1.1 }); nz(ac, o, R, 0, { type: 'lowpass', f0: 520, d: 0.09, g: 1.0 }); nz(ac, o, R, 0, { f0: 2400, d: 0.02, g: 0.35 }); tn(ac, o, 0, { f0: j(R, 1150, 0.1), d: 0.2, g: 0.06 }); } },
  heart: { d: 0.42, n: 1, f: (ac, o) => { tn(ac, o, 0, { f0: 64, f1: 42, a: 0.008, d: 0.09, g: 1.0 }); tn(ac, o, 0.17, { f0: 74, f1: 48, a: 0.008, d: 0.08, g: 0.7 }); tn(ac, o, 0, { f0: 128, f1: 84, a: 0.006, d: 0.04, g: 0.25 }); } },
  death: { d: 1.7, n: 1, f: (ac, o, R) => { const f = filt(ac, 'lowpass', 900, 2); sweep(f.frequency, 0, 1400, 90, 1.2); f.connect(o); tn(ac, f, 0, { type: 'sawtooth', f0: 220, f1: 38, a: 0.01, d: 1.3, g: 0.6, sd: 1.1 }); tn(ac, f, 0, { type: 'sawtooth', f0: 164, f1: 29, a: 0.01, d: 1.3, g: 0.4, sd: 1.1 }); tn(ac, o, 0, { f0: 58, f1: 24, d: 1.2, g: 1.0 }); nz(ac, o, R, 0, { type: 'lowpass', f0: 2500, f1: 120, d: 0.9, g: 0.6 }); } },
  respawn: { d: 1.25, n: 1, f: (ac, o, R) => { [330, 495, 660, 990].forEach((f, i) => { tn(ac, o, i * 0.08, { f0: f, a: 0.03, d: 0.7, g: 0.3 }); tn(ac, o, i * 0.08, { f0: f * 2.005, a: 0.03, d: 0.4, g: 0.08 }); }); nz(ac, o, R, 0, { f0: 500, f1: 5200, a: 0.25, d: 0.35, g: 0.25, q: 2, sd: 0.5 }); } },
  bot_down: { d: 0.85, n: 2, f: (ac, o, R) => { const f = filt(ac, 'lowpass', 2000, 3); sweep(f.frequency, 0, 2600, 150, 0.5); f.connect(o); tn(ac, f, 0, { type: 'sawtooth', f0: j(R, 480, 0.1), f1: 45, d: 0.55, g: 0.6, sd: 0.45 }); tn(ac, f, 0, { type: 'square', f0: j(R, 722, 0.1), f1: 60, d: 0.4, g: 0.25, sd: 0.4 }); tn(ac, o, 0, { f0: 120, f1: 40, d: 0.25, g: 0.9 }); nz(ac, o, R, 0, { f0: 2500, f1: 600, d: 0.12, g: 0.7 }); grains(ac, o, R, 9, 0.05, 0.6, { f: [2500, 7000], g: 0.12, len: 0.02 }); } },
  bot_spawn: { d: 0.65, n: 1, f: (ac, o, R) => { const f = filt(ac, 'lowpass', 3000); f.connect(o); tn(ac, f, 0, { type: 'sawtooth', f0: 160, f1: 640, a: 0.05, d: 0.4, g: 0.35, sd: 0.3 }); tn(ac, o, 0.2, { f0: 1280, a: 0.01, d: 0.3, g: 0.2 }); nz(ac, o, R, 0, { f0: 800, f1: 4000, a: 0.2, d: 0.2, g: 0.3, q: 2, sd: 0.35 }); } },
  tinnitus: { d: 2.8, n: 1, peak: 0.5, f: (ac, o) => { tn(ac, o, 0, { f0: 4200, a: 0.06, d: 2.6, g: 0.5 }); tn(ac, o, 0, { f0: 4317, a: 0.06, d: 2.2, g: 0.3 }); } },
  // wind + far city bed (stereo, seamless loop)
  amb: { d: 12, n: 1, stereo: true, loop: 2.0, peak: 0.5, f: (ac, o, R) => {
    const D = 14.2, m = ac.createChannelMerger(2); m.connect(o);
    for (let c = 0; c < 2; c++) {
      const g = filt(ac, 'lowpass', 1100, 0.5); g.connect(m, 0, c);
      // wind: two gusting bands
      for (let k = 0; k < 2; k++) {
        const n = nsrc(ac, R, 0, D, 'brown'), bp = filt(ac, 'bandpass', k ? 520 : 240, 0.9), ng = ac.createGain(); ng.gain.value = k ? 0.5 : 0.9;
        const lfo = ac.createOscillator(), lg = ac.createGain(), lf = ac.createGain();
        lfo.frequency.value = 0.07 + R() * 0.12; lg.gain.value = ng.gain.value * 0.55; lf.gain.value = k ? 220 : 90;
        lfo.connect(lg); lg.connect(ng.gain); lfo.connect(lf); lf.connect(bp.frequency); lfo.start(0); lfo.stop(D);
        n.connect(bp); bp.connect(ng); ng.connect(g);
      }
      // far city: low drone + traffic wash
      [55, 82.6, 110.3].forEach((hz, i) => { const os = ac.createOscillator(); os.frequency.value = hz * (1 + (R() - 0.5) * 0.01); const og = ac.createGain(); og.gain.value = 0.035 / (i + 1); os.connect(og); og.connect(g); os.start(0); os.stop(D); });
      const tr = nsrc(ac, R, 0, D, 'brown'), tl = filt(ac, 'lowpass', 150), tg = ac.createGain(); tg.gain.value = 0.8; tr.connect(tl); tl.connect(tg); tg.connect(g);
    }
  } },
};

function hsCrack(ac, o, R, g) {
  const f = j(R, 3100, 0.03);
  nz(ac, o, R, 0, { type: 'highpass', f0: 6000, d: 0.004, g: 1.0 * g });                 // click
  nz(ac, o, R, 0, { f0: 5200, q: 2.5, d: 0.03, g: 1.1 * g });                              // crack
  tn(ac, o, 0, { type: 'triangle', f0: 700, d: 0.016, g: 0.45 * g });                      // knock
  [[1, 0.09, 0.5], [1.52, 0.07, 0.34], [2.33, 0.05, 0.2]].forEach((m) => tn(ac, o, 0.002, { f0: f * m[0], d: m[1], g: m[2] * g })); // tink
}
function killThump(ac, o, R, g) {
  const bus = drive(ac, o, 2.2, 0.8);
  tn(ac, bus, 0, { f0: j(R, 115, 0.05), f1: 48, d: 0.17, g: 1.2 * g, sd: 0.1 });         // sub drop
  nz(ac, bus, R, 0, { kind: 'brown', type: 'lowpass', f0: 210, d: 0.12, g: 1.6 * g, q: 0.6 }); // body
  nz(ac, bus, R, 0, { f0: 520, q: 2, d: 0.03, g: 0.9 * g });                               // knock
  nz(ac, o, R, 0, { type: 'highpass', f0: 3500, d: 0.005, g: 0.5 * g });                   // click
  tn(ac, o, 0.012, { type: 'triangle', f0: 220, a: 0.004, d: 0.2, g: 0.2 * g }); tn(ac, o, 0.012, { type: 'triangle', f0: 164.8, a: 0.004, d: 0.24, g: 0.16 * g });
}
// radio-voiced bark for the android guards: a sawtooth "glottis" through two or three formants, band-limited
// and lightly overdriven like a helmet speaker. Not words - a contour (alert rises then falls, query rises).
function vox(ac, out, R, t, o) {
  const hp = filt(ac, 'highpass', 380, 0.7), lp = filt(ac, 'lowpass', 2900, 0.7); hp.connect(lp); lp.connect(out);
  const dr = drive(ac, hp, 3, 1.2), e = env(ac, t, 0.012, o.d, o.g); e.connect(dr);
  const os = ac.createOscillator(); os.type = 'sawtooth'; sweep(os.frequency, t, o.f0, o.f1, o.d * 0.8);
  const n = nsrc(ac, R, t, o.d), ng = ac.createGain(); ng.gain.value = o.breath || 0.15; n.connect(ng);
  for (const F of o.F) { const b = filt(ac, 'bandpass', F[0], F[1]), g = ac.createGain(); g.gain.value = F[2]; os.connect(b); ng.connect(b); b.connect(g); g.connect(e); }
  os.start(t); os.stop(t + o.d + 0.1);
}
Object.assign(SOUNDS, {
  // ---- gun layers ---------------------------------------------------------------------------------------
  sub_heavy: { d: 0.9, n: 2, peak: 0.6, raw: (R) => subPunch('gun_heavy', R) },
  mech_rifle: { d: 0.2, n: 4, peak: 0.6, raw: (R) => mechSound('rifle', R) },
  mech_pistol: { d: 0.2, n: 3, peak: 0.6, raw: (R) => mechSound('pistol', R) },
  // ---- incoming fire ------------------------------------------------------------------------------------
  // the round going past after its snap: a short falling hiss (doppler), no tone
  flyby: { d: 0.3, n: 4, f: (ac, o, R) => { nz(ac, o, R, 0, { f0: j(R, 3600, 0.15), f1: j(R, 1100, 0.15), q: 3, a: 0.03, d: 0.2, g: 1, sd: 0.18 }); nz(ac, o, R, 0, { type: 'highpass', f0: 5000, a: 0.02, d: 0.08, g: 0.3 }); } },
  // a round hitting an armoured guard: dull thwack + a ceramic "tk"
  imp_body: { d: 0.2, n: 4, f: (ac, o, R) => { nz(ac, o, R, 0, { type: 'lowpass', f0: 1400, f1: 400, d: 0.05, g: 1 }); tn(ac, o, 0, { f0: j(R, 170, 0.1), f1: 80, d: 0.06, g: 0.9 }); nz(ac, o, R, 0, { f0: j(R, 2600, 0.12), q: 5, d: 0.02, g: 0.7 }); nz(ac, o, R, 0, { type: 'highpass', f0: 5000, d: 0.004, g: 0.5 }); } },
  // ---- guards / machines as information -----------------------------------------------------------------
  vox_alert: { d: 0.5, n: 3, f: (ac, o, R) => {
    const p = j(R, 150, 0.1);
    vox(ac, o, R, 0, { f0: p, f1: p * 1.18, d: 0.11, g: 1, F: [[720, 5, 1], [1150, 6, 0.7], [2500, 8, 0.3]] });
    vox(ac, o, R, 0.14, { f0: p * 1.27, f1: p * 0.92, d: 0.22, g: 1, F: [[560, 5, 1], [1700, 7, 0.6], [2500, 8, 0.3]] });
    nz(ac, o, R, 0.39, { type: 'highpass', f0: 2000, d: 0.03, g: 0.2 });
  } },
  vox_sus: { d: 0.36, n: 2, f: (ac, o, R) => { const p = j(R, 118, 0.08); vox(ac, o, R, 0, { f0: p, f1: p * 1.35, d: 0.24, g: 1, F: [[420, 5, 1], [1000, 6, 0.45]] }); nz(ac, o, R, 0.28, { type: 'highpass', f0: 2000, d: 0.025, g: 0.15 }); } },
  vox_hurt: { d: 0.22, n: 3, f: (ac, o, R) => { const p = j(R, 170, 0.1); vox(ac, o, R, 0, { f0: p, f1: p * 0.65, d: 0.13, g: 1, breath: 0.5, F: [[650, 4, 1], [1250, 5, 0.5]] }); } },
  // a guard about to fire: weapon coming up (a short rising servo chirp and a click)
  tell: { d: 0.16, n: 2, f: (ac, o, R) => { const lp = filt(ac, 'lowpass', 2600); lp.connect(o); tn(ac, lp, 0, { type: 'square', f0: j(R, 900, 0.05), f1: 1500, a: 0.01, d: 0.07, g: 0.3, sd: 0.07 }); nz(ac, o, R, 0.085, { type: 'highpass', f0: 2800, d: 0.008, g: 0.8 }); tn(ac, o, 0.085, { f0: 250, f1: 180, d: 0.03, g: 0.5 }); } },
  servo: { d: 0.12, n: 3, f: (ac, o, R) => { nz(ac, o, R, 0, { f0: j(R, 1400, 0.1), q: 6, a: 0.01, d: 0.05, g: 0.8 }); tn(ac, o, 0, { type: 'square', f0: j(R, 310, 0.08), d: 0.04, g: 0.22 }); nz(ac, o, R, 0.05, { type: 'highpass', f0: 4000, d: 0.004, g: 0.5 }); } },
  drone_loop: { d: 1.0, n: 1, loop: 0.25, peak: 0.6, f: (ac, o, R) => {
    const D = 1.4, lp = filt(ac, 'lowpass', 1500, 0.7), am = ac.createGain(); am.gain.value = 0.65; lp.connect(am); am.connect(o);
    const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 43; lg.gain.value = 0.35; lfo.connect(lg); lg.connect(am.gain); lfo.start(0); lfo.stop(D);
    [172, 178.5, 344, 357].forEach((hz, i) => { const os = ac.createOscillator(); os.type = 'sawtooth'; os.frequency.value = hz; const g = ac.createGain(); g.gain.value = i < 2 ? 0.3 : 0.1; os.connect(g); g.connect(lp); os.start(0); os.stop(D); });
    const n = nsrc(ac, R, 0, D), bp = filt(ac, 'bandpass', 3200, 1.2), ng = ac.createGain(); ng.gain.value = 0.3; n.connect(bp); bp.connect(ng); ng.connect(am);
  } },
  // ---- the player's own body / the raid closing in ------------------------------------------------------
  breath: { d: 1.3, n: 2, peak: 0.5, f: (ac, o, R) => { nz(ac, o, R, 0, { f0: j(R, 1100, 0.1), f1: 1600, q: 1.2, a: 0.25, d: 0.25, g: 0.5 }); nz(ac, o, R, 0.6, { f0: j(R, 900, 0.1), f1: 500, q: 1.0, a: 0.12, d: 0.5, g: 0.7 }); } },
  // tension bed: a dark beating drone (no melody, no rhythm of its own); the engine opens and raises it with heat
  tension: { d: 8, n: 1, stereo: true, loop: 1.5, peak: 0.5, f: (ac, o, R) => {
    const D = 9.7, m = ac.createChannelMerger(2); m.connect(o);
    for (let c = 0; c < 2; c++) {
      const g = filt(ac, 'lowpass', 700, 0.5); g.connect(m, 0, c);
      [[41.2 * (c ? 1.004 : 1), 0.5], [61.74 * (c ? 0.997 : 1), 0.18], [82.4 * (c ? 1 : 1.006), 0.09], [123.5 * (c ? 1.003 : 1), 0.04]].forEach((p) => { const os = ac.createOscillator(); os.frequency.value = p[0]; const og = ac.createGain(); og.gain.value = p[1]; os.connect(og); og.connect(g); os.start(0); os.stop(D); });
      const n = nsrc(ac, R, 0, D, 'brown'), nl = filt(ac, 'lowpass', 130), ng = ac.createGain(); ng.gain.value = 0.9;
      const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 0.11 + R() * 0.1; lg.gain.value = 0.45; lfo.connect(lg); lg.connect(ng.gain); lfo.start(0); lfo.stop(D);
      n.connect(nl); nl.connect(ng); ng.connect(g);
      // a thin, slowly beating high partial: unease rather than pitch
      const hi = ac.createOscillator(), hg = ac.createGain(); hi.frequency.value = 1244.5 * (c ? 1.003 : 0.998); hg.gain.value = 0.006; hi.connect(hg); hg.connect(m, 0, c); hi.start(0); hi.stop(D);
    }
  } },
  pulse: { d: 0.3, n: 1, peak: 0.7, f: (ac, o, R) => { tn(ac, o, 0, { f0: 52, f1: 40, a: 0.008, d: 0.16, g: 1 }); nz(ac, o, R, 0, { kind: 'brown', type: 'lowpass', f0: 90, a: 0.006, d: 0.12, g: 0.8 }); } },
  // heat tier went up: one low ominous hit with a dissonant swell under it
  stinger: { d: 2.6, n: 1, peak: 0.8, f: (ac, o, R) => {
    const tail = conv(ac, o, 1200, 0.4), p = ac.createGain(); p.connect(o); p.connect(tail);
    tn(ac, p, 0, { f0: 55, f1: 30, d: 1.6, g: 1.2, sd: 1.2 });
    nz(ac, p, R, 0, { kind: 'brown', type: 'lowpass', f0: 180, f1: 60, d: 1.8, g: 1.2, q: 0.5 });
    const f = filt(ac, 'lowpass', 300, 1.5); sweep(f.frequency, 0, 900, 120, 1.4); f.connect(p);
    [[73.4, 0.35], [77.8, 0.3], [110, 0.15]].forEach((x) => tn(ac, f, 0, { type: 'sawtooth', f0: x[0], a: 0.02, d: 1.6, g: x[1] }));
    nz(ac, p, R, 0, { f0: 2300, q: 12, a: 0.3, d: 1.2, g: 0.12 });
    nz(ac, p, R, 0, { type: 'highpass', f0: 1500, d: 0.02, g: 0.5 });
  } },
});

function rubble(ac, o, R, dur, n, lp) {
  nz(ac, o, R, 0, { f0: j(R, 1500, 0.2), d: 0.035, g: 0.9, q: 1 });
  tn(ac, o, 0, { f0: j(R, 125, 0.15), f1: 48, d: 0.09 + dur * 0.03, g: 1.0 });
  // rolling low rumble with tremolo
  const s = nsrc(ac, R, 0, dur, 'brown'), f = filt(ac, 'lowpass', lp, 0.6), g = env(ac, 0, 0.03 + dur * 0.04, dur * 0.95, 1.5);
  const trem = ac.createGain(); trem.gain.value = 0.7;
  const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 9 + R() * 6; lg.gain.value = 0.3; lfo.connect(lg); lg.connect(trem.gain); lfo.start(0); lfo.stop(dur + 0.1);
  s.connect(f); f.connect(g); g.connect(trem); trem.connect(o);
  if (dur > 1.5) tn(ac, o, 0.05, { f0: 52, f1: 30, a: 0.05, d: dur * 0.6, g: 0.6 });
  grains(ac, o, R, n, 0.03, dur * 0.9, { f: [450, 2600], g: 0.5, thud: 0.45, len: 0.06, bias: 1.3 });
  nz(ac, o, R, 0.02, { type: 'highpass', f0: 3200, a: 0.05, d: dur * 0.8, g: 0.07 });
}

// ---- offline rendering ------------------------------------------------------------------------------------
export async function renderSound(name, variant = 0, OAC = (globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext)) {
  prebuild();
  const S = SOUNDS[name], ch = S.stereo ? 2 : 1, xf = S.loop || 0;
  let h = 7; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  let buf;
  if (S.raw) { const d = S.raw(rng(h + variant * 7919), variant); buf = { getChannelData: () => d }; }
  else {
    const ac = new OAC(ch, Math.ceil((S.d + xf) * SR), SR);
    S.f(ac, ac.destination, rng(h + variant * 7919), variant);
    buf = await ac.startRendering();
  }
  const len = Math.min(Math.round(S.d * SR), buf.getChannelData(0).length), xn = Math.floor(xf * SR);
  let peak = 0, last = 0;
  const chans = [];
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    if (xn) for (let i = 0; i < xn; i++) { const k = i / xn; d[i] = d[i] * Math.sqrt(k) + d[len + i] * Math.sqrt(1 - k); } // loop crossfade (equal power)
    for (let i = 0; i < len; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; if (a > 0.0008) last = Math.max(last, i); }
    chans.push(d);
  }
  // trim leading silence (oversampled shaper / convolver add a few samples) so the transient IS sample 0
  let lead = 0;
  if (!xn && !S.exact) { const d0 = chans[0], lim = Math.min(len, Math.floor(0.03 * SR)), th = peak * 0.02; while (lead < lim && Math.abs(d0[lead]) < th) lead++; if (lead >= lim) lead = 0; }
  const n = xn || S.exact ? len : Math.max(64, Math.min(len, last + Math.floor(0.01 * SR)) - lead), out = new AudioBuffer({ length: n, numberOfChannels: ch, sampleRate: SR });
  const k = peak > 0 ? (S.peak || 0.9) / peak : 0, fade = xn || S.exact ? 0 : Math.min(n, Math.floor(0.008 * SR));
  let sum = 0, onset = -1;
  for (let c = 0; c < ch; c++) {
    const d = chans[c], o = out.getChannelData(c);
    for (let i = 0; i < n; i++) { const v = (d[i + lead] || 0) * k * (i >= n - fade ? (n - i) / fade : 1); o[i] = v; sum += v * v; if (onset < 0 && c === 0 && Math.abs(v) > 0.25) onset = i; }
  }
  out._stats = { dur: n / SR, peak: peak * k, rms: Math.sqrt(sum / (n * ch)), lead, onsetMs: (onset / SR) * 1000 };
  return out;
}

for (const prof of ['A', 'B', 'C']) for (const g in GUN_N) SOUNDS[gunKey(g, prof)] = { d: GUN_N[g][0] * (prof === 'C' ? 1.3 : 1), n: GUN_N[g][1], gun: prof, raw: (R) => gunSound(g, R, prof) };
