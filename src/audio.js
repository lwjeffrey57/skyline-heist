import * as THREE from 'three';
import { SOUNDS, IR, prebuild, renderSound, gunKey, PROFILES } from './audio/synth.js';

// Audio system. Purely reactive (ctx.events). All sounds are synthesised (see audio/synth.js) and
// pre-rendered to buffers in the background at init, so playing one is a single BufferSource scheduled
// at currentTime: the gunshot starts on the frame the 'shot' event arrives.
//
// Graph:   3D voice: src -> gain -> lowpass(distance) -> panner -+-> sfx -> muffle -> master -> limiter -> out
//                                                                 +-> send -> convolver(urban IR) -> muffle
//          2D voice: src -> tilt shelf -> gain -> stereo pan -> sfx (+ send)        (player's own gun, movement)
//          UI voice: same as 2D but straight to master (hit / headshot / kill cut through, never muffled)

// gain, max = concurrent voices of this type, gap = min seconds between triggers, ref = panner refDistance,
// send = reverb amount, rate = random pitch spread, pr = priority (higher steals lower)
const D = {
  gun_rifle: { gain: 0.7, max: 6, gap: 0.03, ref: 7, send: 0.8, rate: 0.03, pr: 9 },
  gun_shotgun: { gain: 0.8, max: 3, gap: 0.05, ref: 8, send: 0.95, rate: 0.03, pr: 9 },
  gun_heavy: { gain: 0.95, max: 3, gap: 0.05, ref: 9, send: 1.2, rate: 0.02, pr: 9 },
  gun_grenade: { gain: 0.7, max: 2, gap: 0.05, ref: 6, send: 0.7, rate: 0.03, pr: 9 },
  gun_bot: { gain: 0.62, max: 5, gap: 0.03, ref: 6, send: 0.55, rate: 0.05, pr: 6 },
  imp_concrete: { gain: 0.5, max: 4, gap: 0.025, ref: 3, send: 0.15, rate: 0.12, pr: 3 },
  imp_metal: { gain: 0.5, max: 4, gap: 0.025, ref: 3.5, send: 0.2, rate: 0.12, pr: 3 },
  imp_energy: { gain: 0.5, max: 3, gap: 0.03, ref: 4, send: 0.15, rate: 0.1, pr: 4 },
  ricochet: { gain: 0.32, max: 2, gap: 0.09, ref: 4, send: 0.3, rate: 0.15, pr: 2 },
  whiz: { gain: 0.75, max: 3, gap: 0.05, ref: 2, send: 0.25, rate: 0.12, pr: 5 },
  explosion: { gain: 1.0, max: 4, gap: 0.04, ref: 14, send: 0.35, rate: 0.08, pr: 10 },
  collapse_s: { gain: 0.5, max: 4, gap: 0.05, ref: 5, send: 0.2, rate: 0.15, pr: 4 },
  collapse_m: { gain: 0.7, max: 3, gap: 0.08, ref: 8, send: 0.25, rate: 0.12, pr: 6 },
  collapse_l: { gain: 0.9, max: 2, gap: 0.15, ref: 12, send: 0.3, rate: 0.08, pr: 8 },
  crack: { gain: 0.4, max: 3, gap: 0.05, ref: 3.5, send: 0.15, rate: 0.15, pr: 2 },
  bot_down: { gain: 0.7, max: 3, gap: 0.03, ref: 6, send: 0.3, rate: 0.08, pr: 7 },
  bot_spawn: { gain: 0.4, max: 2, gap: 0.05, ref: 5, send: 0.3, rate: 0.05, pr: 3 },
  // 2D
  rl_out: { gain: 0.4, max: 2, gap: 0.05, send: 0.04, rate: 0.04, pr: 6 },
  rl_in: { gain: 0.42, max: 3, gap: 0.04, send: 0.04, rate: 0.05, pr: 6 },
  rl_bolt: { gain: 0.44, max: 2, gap: 0.05, send: 0.05, rate: 0.04, pr: 6 },
  switch: { gain: 0.4, max: 1, gap: 0.08, send: 0.03, rate: 0.05, pr: 5 },
  dry: { gain: 0.42, max: 1, gap: 0.06, send: 0.02, rate: 0.05, pr: 5 },
  hit: { gain: 0.5, max: 3, gap: 0.02, send: 0, rate: 0.03, pr: 10 },
  headshot: { gain: 0.9, max: 3, gap: 0.03, send: 0.05, rate: 0, pr: 10 },
  headkill: { gain: 1.0, max: 2, gap: 0.05, send: 0.1, rate: 0, pr: 10 },
  blip: { gain: 0.5, max: 6, gap: 0.02, send: 0.08, rate: 0, pr: 9 },
  tick: { gain: 0.22, max: 4, gap: 0.03, send: 0, rate: 0, pr: 2 },
  casing: { gain: 0.16, max: 4, gap: 0.06, ref: 1.5, send: 0.2, rate: 0.12, pr: 1 },
  shell: { gain: 0.22, max: 2, gap: 0.08, ref: 1.5, send: 0.2, rate: 0.1, pr: 1 },
  kill: { gain: 0.72, max: 2, gap: 0.05, send: 0, rate: 0.015, pr: 10 },
  step: { gain: 0.065, max: 2, gap: 0.3, send: 0.03, rate: 0.04, pr: 1 },
  jump: { gain: 0.26, max: 1, gap: 0.08, send: 0.05, rate: 0.08, pr: 2 },
  land: { gain: 0.5, max: 1, gap: 0.08, send: 0.08, rate: 0.08, pr: 3 },
  slide: { gain: 0.34, max: 1, gap: 0.2, send: 0.05, rate: 0.06, pr: 3 },
  mantle: { gain: 0.36, max: 1, gap: 0.1, send: 0.05, rate: 0.06, pr: 3 },
  pad: { gain: 0.55, max: 1, gap: 0.1, send: 0.15, rate: 0.03, pr: 6 },
  zip_on: { gain: 0.45, max: 1, gap: 0.1, send: 0.1, rate: 0.04, pr: 4 },
  zip_off: { gain: 0.4, max: 1, gap: 0.1, send: 0.1, rate: 0.04, pr: 4 },
  hurt: { gain: 0.6, max: 2, gap: 0.05, send: 0, rate: 0.08, pr: 8 },
  heart: { gain: 0.6, max: 1, gap: 0.2, send: 0, rate: 0.02, pr: 5 },
  death: { gain: 0.6, max: 1, gap: 0.3, send: 0.1, rate: 0, pr: 10 },
  respawn: { gain: 0.35, max: 1, gap: 0.3, send: 0.15, rate: 0, pr: 8 },
  tinnitus: { gain: 0.1, max: 1, gap: 1.5, send: 0, rate: 0.04, pr: 4 },
};
const UI = { hit: 1, headshot: 1, headkill: 1, kill: 1, blip: 1, tick: 1, hurt: 1, heart: 1, tinnitus: 1, death: 1, respawn: 1 };
for (const g of ['gun_rifle', 'gun_shotgun', 'gun_heavy', 'gun_grenade', 'gun_bot']) for (const pr of ['B', 'C']) D[gunKey(g, pr)] = D[g];
const AMB_OUT = 0.07, AMB_IN = 0.04, MUSIC_GAIN = 0.16; // music sits about 20 dB under the player's gunshots
// recorded gunshots (profile 'R'): CC0 files in public/audio, see CREDITS.txt there
const REC = { rec_pistol: ['pistol_1.wav', 'pistol_2.wav', 'pistol_3.wav'], rec_rifle: ['rifle_1.wav', 'rifle_2.wav'], rec_shotgun: ['shotgun_1.wav', 'shotgun_2.wav'], rec_heavy: ['sniper_1.wav', 'sniper_2.wav'], rec_bot: ['distant_1.wav', 'distant_2.wav', 'distant_3.wav'] };
const REC_FOR = { gun_rifle: 'rec_rifle', gun_shotgun: 'rec_shotgun', gun_heavy: 'rec_heavy', gun_bot: 'rec_bot' };
Object.assign(D, {
  rec_pistol: { gain: 0.72, max: 5, gap: 0.03, send: 0.5, rate: 0.03, pr: 9 },
  rec_rifle: { gain: 0.8, max: 6, gap: 0.03, send: 0.5, rate: 0.03, pr: 9 },   // dry recordings: sit them in the world with the runtime reverb
  rec_shotgun: { gain: 1.4, max: 3, gap: 0.05, send: 0.6, rate: 0.03, pr: 9 },
  rec_heavy: { gain: 1.25, max: 3, gap: 0.05, send: 0.25, rate: 0.03, pr: 9 }, // already has a natural tail
  rec_bot: { gain: 0.7, max: 5, gap: 0.03, ref: 6, send: 0.3, rate: 0.04, pr: 6 },
  sub_rifle: { gain: 0.8, max: 3, gap: 0.03, send: 0, rate: 0.03, pr: 8 },
  sub_shotgun: { gain: 0.9, max: 2, gap: 0.05, send: 0, rate: 0.03, pr: 8 },
});
const N3D = 24, N2D = 16;
const REV_OUT = 0.9, REV_IN = 3.6; // wet levels: open city / under a roof (calibrated numerically, see final report)

const classCache = new Map();
function gunFor(id) {
  let c = classCache.get(id);
  if (c) return c;
  const s = String(id || '').toLowerCase();
  c = /bot|enemy|drone/.test(s) ? 'gun_bot' : /shot|scatter|pump/.test(s) ? 'gun_shotgun' : /grenade|launcher|rocket|\bgl\b|explos/.test(s) ? 'gun_grenade'
    : /heavy|snip|rail|precision|marksman|cannon|dmr/.test(s) ? 'gun_heavy' : 'gun_rifle';
  classCache.set(id, c);
  return c;
}

export function init(ctx) {
  const { events, camera, world } = ctx, player = ctx.player;
  const AC = window.AudioContext || window.webkitAudioContext;
  const buffers = {};   // name -> AudioBuffer[]
  const state = {};     // name -> { last: time of last trigger, v: last variant, live: count }
  for (const k in SOUNDS) { buffers[k] = []; state[k] = { last: -1, v: 0, live: 0, rep: 0 }; }
  for (const k in REC) { buffers[k] = []; state[k] = { last: -1, v: 0, live: 0, rep: 0 }; }
  const recStatus = {};
  let ac = null, G = null, volume = 0.55, muted = false, played = 0, dropped = 0;
  let profile = 'R', musicOn = false, musicVol = 1; // music is off unless the player turns it on with M
  const synthProf = () => (profile === 'R' ? 'A' : profile); // R falls back to A wherever no recording is available
  // storage key bumped to v2: a choice of A/B/C made before the recordings existed is forgotten once
  try { const p = localStorage.getItem('au-gun-profile-v2'); if (p === 'R' || PROFILES[p]) profile = p; if (localStorage.getItem('au-music-v2') === '1') musicOn = true; } catch (e) { /* storage unavailable */ }

  // ---- pre-render everything now (no user gesture needed for offline contexts) ---------------------------
  let ready = Promise.resolve(false), recReady = Promise.resolve(), loadRecs = () => Promise.resolve();
  if (AC && window.OfflineAudioContext) {
    try {
      prebuild(); // noise + impulse responses, synchronously, so nothing is generated on the first shot
      const jobs = [];
      // gunplay loop first, secondary sounds after
      const order = ['gun_rifle', 'hit', 'headshot', 'headkill', 'kill', 'imp_concrete', 'imp_metal', 'gun_shotgun', 'gun_heavy', 'gun_grenade', 'gun_bot', 'imp_energy', 'dry', 'rl_out', 'rl_in', 'rl_bolt', 'switch'];
      for (const k in SOUNDS) if (!order.includes(k)) order.push(k);
      order.splice(order.indexOf('music'), 1); order.push('music');
      for (const k of order) if (!SOUNDS[k].gun || SOUNDS[k].gun === synthProf()) for (let v = 0; v < SOUNDS[k].n; v++) jobs.push([k, v]);
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const [k, v] = jobs[next++];
          try { buffers[k][v] = await renderSound(k, v); } catch (e) { console.error('[audio] render failed', k, e); }
        }
      };
      ready = Promise.all([worker(), worker(), worker()]).then(() => true);
      // recorded shots: fetched and decoded in the background; until then (or on failure) profile A plays instead
      const dec = new window.OfflineAudioContext(1, 1, 44100);
      const loadRec = async (key, i, file) => {
        try {
          const r = await fetch(new URL('audio/' + file, document.baseURI));
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const b = await dec.decodeAudioData(await r.arrayBuffer());
          if (!b || b.length < 64) throw new Error('empty');
          buffers[key][i] = b; recStatus[file] = 'ok';
        } catch (e) { recStatus[file] = 'failed: ' + (e && e.message); }
      };
      loadRecs = (map = REC) => Promise.all(Object.keys(map).flatMap((k) => map[k].map((f, i) => loadRec(k, i, f))));
      recReady = loadRecs();
    } catch (e) { console.error('[audio] init failed', e); }
  }

  // ---- realtime graph (built on the first user gesture) --------------------------------------------------
  function onEnded() { const v = this._v; if (v && v.src === this) { v.src = null; v.busy = false; state[v.name].live--; } }
  function start() {
    if (!AC) return;
    if (ac) { if (ac.state !== 'running') ac.resume(); return; }
    try { ac = new AC({ latencyHint: 'interactive' }); } catch (e) { ac = new AC(); }
    const master = ac.createGain(); master.gain.value = muted ? 0 : volume;
    const lim = ac.createDynamicsCompressor();
    lim.threshold.value = -9; lim.knee.value = 8; lim.ratio.value = 10; lim.attack.value = 0.002; lim.release.value = 0.16;
    const outG = ac.createGain(); outG.gain.value = 0.9;
    const analyser = ac.createAnalyser(); analyser.fftSize = 1024;
    master.connect(lim); lim.connect(outG); outG.connect(ac.destination); outG.connect(analyser);
    const muffle = ac.createBiquadFilter(); muffle.type = 'lowpass'; muffle.frequency.value = 20000; muffle.Q.value = 0.5; muffle.connect(master);
    const duck = ac.createGain(); duck.connect(muffle);
    const sfx = ac.createGain(); sfx.connect(duck);
    const ui = ac.createGain(); ui.connect(master);
    // two spaces fed by the same send bus: open city (long, sparse slap-backs) and room (short, dense, loud)
    const rev = ac.createGain();
    const cOut = ac.createConvolver(); cOut.buffer = IR.urban; const revOut = ac.createGain(); revOut.gain.value = REV_OUT;
    const cIn = ac.createConvolver(); cIn.buffer = IR.room; const revIn = ac.createGain(); revIn.gain.value = 0;
    const tail = ac.createGain(); tail.connect(duck); // pulled down between rounds of automatic fire so tails never pile up
    rev.connect(cOut); cOut.connect(revOut); revOut.connect(tail); rev.connect(cIn); cIn.connect(revIn); revIn.connect(tail);
    const music = ac.createGain(); music.gain.value = 0; const musicDuck = ac.createGain(); music.connect(musicDuck); musicDuck.connect(master);
    const amb = ac.createGain(); amb.gain.value = 0; amb.connect(muffle);
    const v3 = [], v2 = [];
    for (let i = 0; i < N3D; i++) {
      const g = ac.createGain(), lp = ac.createBiquadFilter(), pan = ac.createPanner(), send = ac.createGain();
      lp.type = 'lowpass'; lp.Q.value = 0.5;
      pan.panningModel = 'equalpower'; pan.distanceModel = 'inverse'; pan.maxDistance = 10000; pan.rolloffFactor = 1;
      g.connect(lp); lp.connect(pan); pan.connect(sfx); pan.connect(send); send.connect(rev);
      v3.push({ g, lp, pan, send, src: null, busy: false, name: '', t: 0, pr: 0 });
    }
    for (let i = 0; i < N2D; i++) {
      const sh = ac.createBiquadFilter(), g = ac.createGain(), pan = ac.createStereoPanner(), send = ac.createGain(), toSfx = ac.createGain(), toUi = ac.createGain();
      sh.type = 'highshelf'; sh.frequency.value = 2600;
      sh.connect(g); g.connect(pan); pan.connect(toSfx); pan.connect(toUi); toSfx.connect(sfx); toUi.connect(ui); pan.connect(send); send.connect(rev);
      v2.push({ sh, g, pan, send, toSfx, toUi, src: null, busy: false, name: '', t: 0, pr: 0 });
    }
    G = { master, lim, analyser, muffle, sfx, duck, ui, rev, revOut, revIn, tail, music, musicDuck, musicSrc: null, amb, v3, v2, ambSrc: null, zip: null, zipG: null };
  }
  const resume = () => start();
  events.on('userGesture', resume);
  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);

  // ---- voices --------------------------------------------------------------------------------------------
  function grab(pool, name, d, now) {
    const st = state[name];
    if (now - st.last < d.gap) { dropped++; return null; }
    let v = null;
    if (st.live >= d.max) { // retrigger: recycle the oldest voice of this type
      for (let i = 0; i < pool.length; i++) { const c = pool[i]; if (c.busy && c.name === name && (!v || c.t < v.t)) v = c; }
    }
    if (!v) for (let i = 0; i < pool.length; i++) if (!pool[i].busy) { v = pool[i]; break; }
    if (!v) { // steal the least important, oldest voice
      for (let i = 0; i < pool.length; i++) { const c = pool[i]; if (!v || c.pr < v.pr || (c.pr === v.pr && c.t < v.t)) v = c; }
      if (v.pr > d.pr) { dropped++; return null; }
    }
    if (v.busy && v.src) { v.src.onended = null; try { v.src.stop(); } catch (e) { /* not started */ } state[v.name].live--; }
    st.last = now; st.live++;
    v.busy = true; v.name = name; v.t = now; v.pr = d.pr;
    return v;
  }
  function source(v, name, d, when, rateMul) {
    const list = buffers[name], st = state[name], n = list.length;
    if (REC[name]) { // recordings: random, but never the same take more than twice running
      let pick = Math.floor(Math.random() * n);
      if (pick === st.v && st.rep >= 2) pick = (pick + 1 + Math.floor(Math.random() * (n - 1))) % n;
      st.rep = pick === st.v ? st.rep + 1 : 1; st.v = pick;
    } else st.v = n > 1 ? (st.v + 1 + Math.floor(Math.random() * (n - 1))) % n : 0; // never the same variant twice in a row
    const src = ac.createBufferSource();
    src.buffer = list[st.v];
    src.playbackRate.value = (1 + (Math.random() - 0.5) * 2 * d.rate) * rateMul;
    src._v = v; src.onended = onEnded; v.src = src;
    played++;
    return src;
  }
  const complete = (name) => { const b = buffers[name], n = REC[name] ? REC[name].length : SOUNDS[name].n; if (!b || b.length !== n) return false; for (let i = 0; i < n; i++) if (!b[i]) return false; return true; };
  const usable = (name) => G && ac.state === 'running' && complete(name);
  // which buffer set a weapon class plays right now
  const gunName = (base) => { if (profile === 'R') { const r = REC_FOR[base]; if (r && complete(r)) return r; } return gunKey(base, synthProf()); };

  // positional one-shot. delay (s) models the speed of sound for far events.
  function play3(name, x, y, z, vol = 1, delay = 0, rateMul = 1, occluded = false) {
    if (!usable(name)) return;
    const d = D[name], now = ac.currentTime, v = grab(G.v3, name, d, now);
    if (!v) return;
    const cp = camera.position, dist = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
    const src = source(v, name, d, now, rateMul);
    v.g.gain.value = d.gain * vol * (0.92 + Math.random() * 0.16) * (occluded ? 0.6 : 1);
    v.lp.frequency.value = (600 + 19000 / (1 + (dist / 28) * (dist / 28))) * (occluded ? 0.3 : 1);
    v.pan.refDistance = d.ref;
    if (v.pan.positionX) { v.pan.positionX.value = x; v.pan.positionY.value = y; v.pan.positionZ.value = z; } else v.pan.setPosition(x, y, z);
    v.send.gain.value = d.send * (0.7 + Math.min(1.6, dist / 30));
    src.connect(v.g); src.start(now + delay);
  }
  // non-positional one-shot (the player's own actions). tilt = random high-shelf dB spread for timbre variety
  function play2(name, vol = 1, pan = 0, tilt = 0, rateMul = 1, delay = 0, sendMul = 1) {
    if (!usable(name)) return;
    const d = D[name], now = ac.currentTime, v = grab(G.v2, name, d, now);
    if (!v) return;
    const src = source(v, name, d, now, rateMul);
    v.sh.gain.value = tilt ? (Math.random() - 0.5) * 2 * tilt : 0;
    v.g.gain.cancelScheduledValues(now); v.g.gain.value = d.gain * vol * (tilt ? 0.94 + Math.random() * 0.12 : 1);
    v.pan.pan.value = pan;
    const isUi = UI[name] === 1;
    v.toUi.gain.value = isUi ? 1 : 0; v.toSfx.gain.value = isUi ? 0 : 1;
    v.send.gain.value = d.send * sendMul;
    src.connect(v.sh); src.start(now + delay);
    return v;
  }
  // briefly dull the world (nearby blast / heavy damage); recovers over `rec` seconds
  function muffleHit(freq, rec) {
    if (!G || ac.state !== 'running') return;
    const p = G.muffle.frequency, now = ac.currentTime;
    p.cancelScheduledValues(now); p.setValueAtTime(freq, now); p.exponentialRampToValueAtTime(20000, now + rec);
  }

  // pull the world down for a moment so a confirmation cue cuts through gunfire
  function duckWorld(depth, hold) {
    if (!G || ac.state !== 'running') return;
    const p = G.duck.gain, now = ac.currentTime;
    p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); p.linearRampToValueAtTime(depth, now + 0.012); p.setTargetAtTime(1, now + hold, 0.09);
  }

  // ---- events --------------------------------------------------------------------------------------------
  const va = new THREE.Vector3(), vb = new THREE.Vector3();
  const camDist = (p) => p.distanceTo(camera.position);
  const isMetal = (c) => !!c && (c.tag === 'container' || c.mat === world.materials.metal || (c.mat && c.mat.metalness > 0.5));

  let lastOwn = -9, streak = 0, ownV = null, ownSrc = null;
  const REC_PF = { send: 1, roll: 1 };
  events.on('shot', (e) => {
    const name = gunFor(e.weapon);
    if (e.by === player) { // close, full, centred (slightly toward the gun hand)
      // sustained automatic fire: later rounds sit a touch lower and drier so the burst stays punchy, not a wash
      const now = ac ? ac.currentTime : 0, rapid = now - lastOwn < 0.22;
      streak = rapid ? Math.min(streak + 1, 12) : 0; lastOwn = now;
      const isPistol = e.weapon === 'pistol';
      const quiet = e.suppressed ? 0.3 : 1; // suppressed shots: much quieter, and no low-end layer
      const key = isPistol && profile === 'R' && complete('rec_pistol') ? 'rec_pistol' : gunName(name), rec = !!REC[key], PF = rec ? REC_PF : PROFILES[synthProf()], auto = name === 'gun_rifle' && !isPistol;
      // sustained fire: fade the previous round's long recorded buffer ~250 ms after it started, so voices never pile up
      if (rapid && ownV && ownV.busy && ownV.src === ownSrc) { ownV.g.gain.setTargetAtTime(0, now + 0.15, 0.03); try { ownSrc.stop(now + 0.32); } catch (err) { /* already stopped */ } }
      ownV = play2(key, quiet * (rapid ? 0.97 - Math.min(0.08, streak * 0.01) : 1.05) * (rec ? Math.pow(10, (Math.random() - 0.5) * 0.1) : 1), 0.06, rec ? 1 : 2 + Math.min(1, streak * 0.15), 1 + (!rec && streak > 3 ? (Math.random() - 0.5) * 0.03 : 0), 0, PF.send * (rapid ? 0.7 : 1));
      ownSrc = ownV ? ownV.src : null;
      if (e.suppressed) { /* no sub layer */ } else if (rec && key === 'rec_pistol') play2('sub_rifle', 0.55); else if (rec && key === 'rec_rifle') play2('sub_rifle', rapid ? 0.9 : 1); else if (rec && key === 'rec_shotgun') play2('sub_shotgun'); // low-end the close-mic recordings lack
      if (G && ac.state === 'running') {
        // cut the previous round's tail, hold it down while the trigger is held; the roll returns after the last shot
        const tg = G.tail.gain, md = G.musicDuck.gain;
        tg.cancelScheduledValues(now);
        if (rapid && auto) { tg.setTargetAtTime(0.22, now, 0.008); tg.setTargetAtTime(PF.roll > 1 ? 1.15 : 1, now + 0.12, 0.1 + 0.1 * PF.roll); }
        else { tg.setTargetAtTime(0.5, now, 0.005); tg.setTargetAtTime(PF.roll > 1 ? 1.15 : 1, now + 0.03, 0.06); }
        md.cancelScheduledValues(now); md.setTargetAtTime(streak > 2 ? 0.55 : 0.8, now, 0.03); md.setTargetAtTime(1, now + 0.35, 0.3);
      }
      if (name === 'gun_shotgun') play2('rl_bolt', 0.75, 0.1, 0, 0.82, 0.3);       // pump
      else if (name === 'gun_heavy') play2('rl_bolt', 0.8, 0.1, 0, 0.7, 0.42);     // bolt
      return;
    }
    const m = e.muzzle || e.origin; if (!m) return;
    const dist = camDist(m);
    play3(gunName(name), m.x, m.y, m.z, 1, Math.min(0.3, dist / 343));
    // near miss: the round passes close to the listener's head
    const o = e.origin || m, d = e.dir; if (!d) return;
    const cp = camera.position, t = (cp.x - o.x) * d.x + (cp.y - o.y) * d.y + (cp.z - o.z) * d.z;
    if (t > 4) {
      va.copy(o).addScaledVector(d, t);
      const miss = va.distanceTo(cp);
      if (miss < 3.2 && miss > 0.25 && ac && ac.currentTime - state.whiz.last > D.whiz.gap && !world.raycast(o, d, t)) play3('whiz', va.x, va.y, va.z, 1.1 - miss * 0.2, 0, 1);
    }
  });
  events.on('impact', (e) => {
    const p = e.point; if (!p) return;
    const dist = camDist(p); if (dist > 90) return;
    const delay = dist > 25 ? Math.min(0.25, dist / 343) : 0, big = e.damage > 60 ? 1.35 : 1;
    if (e.kind === 'flesh') { if (e.target !== player) play3('imp_energy', p.x, p.y, p.z, big, delay); return; }
    const metal = isMetal(e.collider);
    play3(metal ? 'imp_metal' : 'imp_concrete', p.x, p.y, p.z, big, delay, big > 1 ? 0.8 : 1);
    if (Math.random() < (metal ? 0.4 : 0.14)) play3('ricochet', p.x, p.y, p.z, 1, delay + 0.01);
  });
  events.on('explosion', (e) => {
    const p = e.point; if (!p) return;
    const dist = camDist(p), R = e.radius > 0 ? e.radius : 5;
    vb.copy(camera.position);
    const occl = dist > 6 && !world.lineOfSight(va.set(p.x, p.y + 0.5, p.z), vb);
    play3('explosion', p.x, p.y, p.z, Math.min(1.3, 0.7 + R * 0.06), Math.min(0.45, dist / 343), 1.08 - Math.min(0.2, R * 0.016), occl);
    const prox = 1 - dist / (R * 2.4);
    if (prox > 0.15) { muffleHit(900 - prox * 600, 1.2 + prox * 2); if (prox > 0.4) play2('tinnitus', prox); }
  });
  // stop cues that were scheduled ahead (reload interrupted by a weapon switch)
  function cancel(name) {
    if (!G) return;
    for (const v of G.v2) if (v.busy && v.name === name && v.src) { v.src.onended = null; try { v.src.stop(); } catch (err) { /* */ } v.src = null; v.busy = false; state[name].live--; }
    state[name].last = -1;
  }
  events.on('reload', (e) => {
    const t = e.time > 0.2 ? e.time : 1.2;
    play2('rl_out');
    if (gunFor(e.weapon) === 'gun_shotgun') return;     // shells arrive one by one via shellInsert / reloadDone
    play2('rl_in', 1, 0, 0, 1, t * 0.52);
    state.rl_bolt.last = -1; play2('rl_bolt', 1, 0, 0, 1, Math.max(t * 0.52 + 0.15, t * 0.86 - 0.1));
  });
  events.on('shellInsert', () => play2('rl_in', 0.9, 0, 0, 1.12));
  events.on('reloadDone', (e) => { if (gunFor(e.weapon) === 'gun_shotgun') play2('rl_bolt', 0.8, 0.1, 0, 0.82); });
  events.on('ejectCasing', (e) => {
    const p = e.position || e.pos || player.pos, sg = gunFor(e.weapon) === 'gun_shotgun';
    // it lands near the feet a moment later
    play3(sg ? 'shell' : 'casing', p.x + (Math.random() - 0.5), player.pos.y + 0.05, p.z + (Math.random() - 0.5), 1, 0.36 + Math.random() * 0.2);
  });
  events.on('fireMode', () => play2('dry', 0.8, 0, 0, 1.3));
  events.on('grenadeThrow', () => play2('jump', 1, 0.1, 0, 1.25));
  events.on('grenadeBounce', (e) => { const p = e.point; if (p) play3('crack', p.x, p.y, p.z, Math.min(1, 0.3 + (e.speed || 4) / 14), 0, 1.5); });
  events.on('weaponSwitch', () => { cancel('rl_in'); cancel('rl_bolt'); play2('switch'); });
  events.on('dryFire', () => play2('dry'));
  // One kill = one confirmation, whichever of hitmarker{kill} / killConfirm arrives first (they come in the
  // same frame); the later one only adds what the first could not know (multi-kill notes).
  let killT = -9, killMulti = 0, scoreT = -9;
  const SCALE = [0, 2, 4, 7, 9, 12, 14, 16]; // semitone steps the multi-kill notes climb
  function killCue(headshot, multi, streak) {
    if (!ac) return;
    const now = ac.currentTime, fresh = now - killT > 0.09;
    if (fresh) {
      killT = now; killMulti = 1;
      const up = Math.pow(2, (Math.min(multi - 1, 5) * 2 + Math.min(streak, 8) * 0.25) / 12);
      if (headshot) { play2('headkill'); duckWorld(0.45, 0.25); } // the signature itself is never re-pitched
      else { play2('kill', 1, 0, 0, up); duckWorld(0.62, 0.15); }
    }
    // double / triple / ...: that many extra notes, each higher, louder with the count
    for (let i = killMulti; i < Math.min(multi, 7); i++) play2('blip', 0.7 + i * 0.08, 0, 0, Math.pow(2, SCALE[i] / 12), 0.13 + (i - 1) * 0.075);
    if (multi > killMulti) killMulti = multi;
  }
  events.on('killConfirm', (e) => killCue(!!e.headshot, e.multi > 0 ? e.multi : 1, e.streak || 0));
  // points counting up: a few rising ticks, more for bigger awards
  events.on('score', (e) => {
    const pts = e.points || 0; if (pts <= 0) return;
    if (!ac || ac.currentTime - scoreT < 0.12) return; scoreT = ac.currentTime; // rate limit
    const n = Math.max(1, Math.min(6, Math.round(pts / 60))), base = 1 + Math.min(0.5, (e.multi > 1 ? e.multi - 1 : 0) * 0.08);
    for (let i = 0; i < n; i++) { state.tick.last = -1; play2('tick', 0.8, 0, 0, base * (1 + i * 0.06), 0.22 + i * 0.045); }
  });
  events.on('hitmarker', (e) => {
    if (e.kill) killCue(!!e.headshot, 1, 0);
    else if (e.headshot) { play2('headshot'); duckWorld(0.55, 0.1); }
    else play2('hit');
  });
  events.on('pieceDamaged', (e) => { const p = e.point; if (p && camDist(p) < 70) play3('crack', p.x, p.y, p.z); });
  events.on('pieceDestroyed', (e) => {
    const c = e.collider, s = e.size;
    let x, y, z, vol = 1;
    if (e.center) { x = e.center.x; y = e.center.y; z = e.center.z; } else if (c && c.min) { x = (c.min.x + c.max.x) / 2; y = (c.min.y + c.max.y) / 2; z = (c.min.z + c.max.z) / 2; } else return;
    if (typeof s === 'number') vol = s * s * s; else if (s && s.x !== undefined) vol = s.x * s.y * s.z; else if (c && c.min) vol = (c.max.x - c.min.x) * (c.max.y - c.min.y) * (c.max.z - c.min.z);
    const dist = Math.hypot(x - camera.position.x, y - camera.position.y, z - camera.position.z);
    const name = vol > 14 ? 'collapse_l' : vol > 1.6 ? 'collapse_m' : 'collapse_s';
    play3(name, x, y, z, Math.min(1.3, 0.6 + Math.cbrt(vol) * 0.2), Math.min(0.4, dist / 343));
  });
  events.on('botDied', (e) => { const p = e.point || (e.bot && e.bot.pos); if (p) play3('bot_down', p.x, p.y + (e.point ? 0 : 1), p.z); });
  events.on('botSpawned', (e) => { const p = e.bot && e.bot.pos; if (p) play3('bot_spawn', p.x, p.y + 1, p.z); });
  events.on('playerDamaged', (e) => {
    const a = e.amount || 10;
    let pan = 0;
    if (e.from && e.from.isVector3) pan = Math.max(-0.7, Math.min(0.7, Math.sin(Math.atan2(e.from.x - player.pos.x, -(e.from.z - player.pos.z)) + player.yaw)));
    play2('hurt', Math.min(1.2, 0.6 + a / 60), pan);
    if (a > 30) muffleHit(1400, 0.8);
  });
  events.on('playerDied', () => { play2('death'); muffleHit(350, 1.6); });
  events.on('playerRespawned', () => play2('respawn', 1, 0, 0, 1, 0.35));
  events.on('jump', () => play2('jump'));
  events.on('land', (e) => { const sp = e.speed || 0; if (sp > 2.5) play2('land', Math.min(1.3, 0.35 + sp / 16), 0, 0, 1.1 - Math.min(0.25, sp / 60)); });
  let foot = 1;
  let stepT = -9;
  events.on('footstep', (e) => {
    if (!ac) return;
    const sp = e.speed || 5, sprint = sp > 7, now = ac.currentTime;
    if (now - stepT < (sprint ? 0.35 : 0.52)) return; // one per stride: ~1.9 steps/s walking, ~2.8 sprinting
    stepT = now; foot = -foot;
    play2('step', sprint ? 1.35 : 1, foot * 0.06, 0, sprint ? 1.04 : 0.96);
  });
  events.on('slideStart', () => play2('slide'));
  events.on('mantle', () => play2('mantle'));
  events.on('pad', () => play2('pad'));
  let zipOn = false;
  function zipStop() {
    zipOn = false;
    if (G && G.zip) { const now = ac.currentTime; G.zipG.gain.setTargetAtTime(0, now, 0.05); G.zip.stop(now + 0.3); G.zip = null; G.zipG = null; }
  }
  events.on('zipStart', () => {
    play2('zip_on'); zipOn = true;
    if (!usable('zip_loop') || G.zip) return;
    const s = ac.createBufferSource(), g = ac.createGain(), now = ac.currentTime;
    s.buffer = buffers.zip_loop[0]; s.loop = true; g.gain.value = 0; g.gain.setTargetAtTime(0.3, now, 0.08);
    s.connect(g); g.connect(G.sfx); s.start(now);
    G.zip = s; G.zipG = g;
  });
  events.on('zipEnd', () => { play2('zip_off'); zipStop(); });

  // ---- public API ----------------------------------------------------------------------------------------
  const applyMusic = (tc = 0.15) => { if (G) G.music.gain.setTargetAtTime(musicOn ? MUSIC_GAIN * musicVol : 0, ac.currentTime, tc); };
  // small on-screen note for the audio keys
  const label = document.createElement('div'); label.id = 'au-label';
  label.style.cssText = 'position:fixed;left:50%;top:14%;transform:translateX(-50%);font:600 13px system-ui,sans-serif;letter-spacing:2px;color:#fff;background:rgba(10,14,18,.6);padding:6px 12px;border-radius:6px;pointer-events:none;opacity:0;transition:opacity .3s';
  if (ctx.hud) ctx.hud.appendChild(label);
  let labelT = 0;
  const say = (t) => { label.textContent = t; label.style.opacity = 1; clearTimeout(labelT); labelT = setTimeout(() => { label.style.opacity = 0; }, 1600); };
  const NAMES = { R: 'R  RECORDED', A: 'A  CLOSE / PUNCHY', B: 'B  DRY / TIGHT', C: 'C  BIG / BOOMY' };
  function setGunProfile(name) {
    if (name !== 'R' && !PROFILES[name]) return false;
    profile = name;
    try { localStorage.setItem('au-gun-profile-v2', name); } catch (e) { /* ignore */ }
    for (const k in SOUNDS) if (SOUNDS[k].gun === synthProf() && !buffers[k].length) { // render this voicing on first use
      for (let v = 0; v < SOUNDS[k].n; v++) renderSound(k, v).then((b) => { buffers[k][v] = b; }).catch((e) => console.error('[audio] render failed', k, e));
    }
    return true;
  }
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'F4') { e.preventDefault(); const o = ['R', 'A', 'B', 'C']; setGunProfile(o[(o.indexOf(profile) + 1) % 4]); say('GUN SOUND  ' + NAMES[profile]); }
    else if (e.code === 'KeyM') { musicOn = !musicOn; applyMusic(); try { localStorage.setItem('au-music-v2', musicOn ? '1' : '0'); } catch (err) { /* ignore */ } say(musicOn ? 'MUSIC ON' : 'MUSIC OFF'); }
  });
  const applyVol = () => { if (G) G.master.gain.setTargetAtTime(muted ? 0 : volume, ac.currentTime, 0.02); };
  ctx.audio = {
    setVolume(v) { volume = Math.max(0, Math.min(1, +v || 0)); applyVol(); },
    mute(b) { muted = !!b; applyVol(); },
    setGunProfile,
    get gunProfile() { return profile; },
    setMusicVolume(v) { musicVol = Math.max(0, Math.min(2, +v || 0)); applyMusic(); },
    setMusic(b) { musicOn = !!b; applyMusic(); },
    get volume() { return volume; },
    // for tests / tooling
    debug: {
      ready, buffers, defs: D, sounds: SOUNDS, gunFor, start, recStatus, gunName, REC,
      get recReady() { return recReady; }, reloadRecs(map) { for (const k in map) buffers[k] = []; return loadRecs(map); },
      get context() { return ac; },
      get graph() { return G; },
      get indoor() { return indoor; },
      counts() { let b3 = 0, b2 = 0; if (G) { for (const v of G.v3) if (v.busy) b3++; for (const v of G.v2) if (v.busy) b2++; } return { played, dropped, busy3d: b3, busy2d: b2, state: ac ? ac.state : 'none', latency: ac ? ac.baseLatency : null }; },
      stats() { const o = {}; for (const k in buffers) o[k] = buffers[k].map((b) => b && b._stats); return o; },
    },
  };

  // ---- per-frame: listener, ambience, heartbeat ----------------------------------------------------------
  const fw = new THREE.Vector3(), up = new THREE.Vector3();
  let beatT = 0, lowHp = false, roofT = 0, indoor = -1;
  const UPV = new THREE.Vector3(0, 1, 0);
  return {
    update(dt) {
      if (!G || ac.state !== 'running') return;
      const L = ac.listener, p = camera.position;
      fw.set(0, 0, -1).applyQuaternion(camera.quaternion); up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      if (L.positionX) {
        L.positionX.value = p.x; L.positionY.value = p.y; L.positionZ.value = p.z;
        L.forwardX.value = fw.x; L.forwardY.value = fw.y; L.forwardZ.value = fw.z;
        L.upX.value = up.x; L.upY.value = up.y; L.upZ.value = up.z;
      } else { L.setPosition(p.x, p.y, p.z); L.setOrientation(fw.x, fw.y, fw.z, up.x, up.y, up.z); }

      roofT -= dt;
      if (roofT <= 0) { // is there a roof over the listener? swap the environment tail accordingly
        roofT = 0.25;
        const h = world.raycast(p, UPV, 40), now = h ? 1 : 0;
        if (now !== indoor) {
          indoor = now; const t = ac.currentTime;
          G.revIn.gain.setTargetAtTime(now ? REV_IN : 0, t, 0.12); G.revOut.gain.setTargetAtTime(now ? 0.15 : REV_OUT, t, 0.12);
          G.amb.gain.setTargetAtTime(now ? AMB_IN : AMB_OUT, t, 0.5);
        }
      }
      if (!G.musicSrc && usable('music')) { // start the loop once it has been rendered
        const s = ac.createBufferSource(); s.buffer = buffers.music[0]; s.loop = true; s.connect(G.music); s.start(); G.musicSrc = s; applyMusic(2);
      }
      if (!G.ambSrc && usable('amb')) { // start the bed once its buffer exists
        const s = ac.createBufferSource(); s.buffer = buffers.amb[0]; s.loop = true; s.connect(G.amb); s.start();
        G.amb.gain.setTargetAtTime(indoor === 1 ? AMB_IN : AMB_OUT, ac.currentTime, 1.5); G.ambSrc = s;
      }
      if (zipOn && player.state !== 'zip') zipStop();
      if (G.zip) G.zip.playbackRate.value = 0.85 + Math.min(0.5, Math.hypot(player.vel.x, player.vel.y, player.vel.z) / 40);

      const low = player.alive && player.hp > 0 && player.hp < player.maxHp * 0.35;
      if (low) {
        beatT -= dt;
        if (beatT <= 0) { const k = 1 - player.hp / (player.maxHp * 0.35); beatT = 0.95 - k * 0.38; play2('heart', 0.6 + k * 0.5); }
      } else beatT = 0;
      if (low !== lowHp) { lowHp = low; G.sfx.gain.setTargetAtTime(low ? 0.8 : 1, ac.currentTime, 0.3); }
    },
  };
}
