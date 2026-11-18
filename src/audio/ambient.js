// Sound as information and rising tension. Everything here is driven by game state read each frame
// (who is near, how hot the raid is, how hurt the player is) or by a handful of events, and plays through
// the engine's own voices (A.play2 / A.play3), so volume, mute, the limiter and the damage muffle all apply.
//
//   guards   footsteps you can hear at short range (from each guard's real movement), radio barks on
//            guardSuspicious / guardAlert / botCallout, a weapon-up tell on botTell, grunts on botStagger / hits
//   drones   a rotor hum that grows, pans and rises in pitch when it is hunting
//   turrets  a servo tick: slow sweep when idle, quick when suspicious, rapid when locked on
//   player   breathing under the heartbeat at low health
//   raid     a dark bed that opens with ctx.raid.heat, a pulse that speeds up with it, a stinger on heatTier
//
// A = { play2, play3, usable(name), buffers, graph(), ac(), camera }

const STEP_RANGE = 24, VOX_RANGE = 45, DRONE_RANGE = 70, TURRET_RANGE = 30, N_DRONE = 2;
const BED_MIN = 0.035, BED_MAX = 0.26;

export function createAmbient(ctx, A) {
  const { events, player } = ctx, cam = A.camera;
  const heat01 = () => { const h = (ctx.raid && ctx.raid.heat) || 0; return h > 1 ? 1 : h > 0 ? h : 0; };
  const inRaid = () => !ctx.raid || ctx.raid.state === undefined || ctx.raid.state === 'raid';
  const posOf = (o) => (o && (o.c || o.pos)) || null;
  const dist2 = (p) => { const c = cam.position, x = p.x - c.x, y = p.y - c.y, z = p.z - c.z; return x * x + y * y + z * z; };
  const isMachine = (b) => !!b && ((ctx.drones && ctx.drones.list.includes(b)) || (ctx.turrets && ctx.turrets.list.includes(b)));
  const stats = { steps: 0, vox: 0, servo: 0, pulses: 0, stingers: 0, breaths: 0, bed: 0, droneGain: [0, 0], heat: 0 };

  // ---- guard voices -------------------------------------------------------------------------------------
  const voxT = new WeakMap(); // per guard: time of its last bark, so one guard never talks over itself
  function bark(bot, name, vol = 1, rate = 1, minGap = 0.6) {
    const p = posOf(bot); if (!p || dist2(p) > VOX_RANGE * VOX_RANGE) return;
    const last = voxT.get(bot) || -9; if (ctx.time - last < minGap) return;
    voxT.set(bot, ctx.time); stats.vox++;
    A.play3(name, p.x, (bot.c ? p.y : p.y + 1.6), p.z, vol, 0, rate * (bot.kind === 'heavy' ? 0.84 : 1));
  }
  events.on('guardSuspicious', (e) => { if (e.bot && !isMachine(e.bot)) bark(e.bot, 'vox_sus', 1, 1, 2); });
  events.on('guardAlert', (e) => {
    const b = e.bot; if (!b) return;
    if (isMachine(b)) { const p = posOf(b); if (p && dist2(p) < 60 * 60) { A.play3('tell', p.x, p.y, p.z, 1.2, 0, 1.5); A.play3('tell', p.x, p.y, p.z, 1.2, 0.13, 1.9); } return; } // machines: a two-tone lock-on chirp
    bark(b, 'vox_alert', 1.1, 1, 0.4);
  });
  // optional events from the enemies system (harmless if they never arrive)
  // kind -> [sound, pitch, level]. 'contact' is the full two-syllable alert; the rest are variations of contour.
  const CALL = { contact: ['vox_alert', 1, 1.1], suppressed: ['vox_alert', 1.15, 0.9], cover: ['vox_alert', 1.06, 0.9], reloading: ['vox_alert', 0.86, 0.9], flank: ['vox_alert', 1.12, 1],
    push: ['vox_alert', 0.92, 1.1], hunt: ['vox_alert', 0.8, 1], lost: ['vox_sus', 1, 1], manDown: ['vox_sus', 0.82, 1.1], hit: ['vox_hurt', 0.95, 1], wounded: ['vox_hurt', 0.8, 1.2] };
  events.on('botCallout', (e) => { if (!e.bot || isMachine(e.bot)) return; const c = CALL[e.kind] || CALL.contact; bark(e.bot, c[0], c[2], c[1], 0.5); });
  events.on('botTell', (e) => { const p = posOf(e.bot); if (p && dist2(p) < 50 * 50) A.play3('tell', p.x, p.y + (e.bot.c ? 0 : 1.3), p.z, 1, 0, 1); });
  events.on('botStagger', (e) => { if (e.bot && !isMachine(e.bot)) bark(e.bot, 'vox_hurt', 1.3, 0.9, 0.2); });
  events.on('botDamaged', (e) => { const b = e.bot; if (b && b.alive && !isMachine(b) && Math.random() < 0.6) bark(b, 'vox_hurt', 0.8 + Math.min(0.5, (e.amount || 0) / 80), 1, 0.3); });

  // ---- per-frame trackers -------------------------------------------------------------------------------
  const gait = new WeakMap();   // guard -> { x, z, acc }
  const servoT = new WeakMap(); // turret -> seconds to next tick
  const drones = [];            // persistent loop voices { src, g, lp, pan }
  let bed = null, pulseT = 0, breathT = 0, bedBoost = 0;

  function ensureLoops() {
    const G = A.graph(), ac = A.ac();
    if (!bed && A.usable('tension')) {
      const src = ac.createBufferSource(), lp = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = A.buffers.tension[0]; src.loop = true; lp.type = 'lowpass'; lp.frequency.value = 150; lp.Q.value = 0.6; g.gain.value = 0;
      src.connect(lp); lp.connect(g); g.connect(G.muffle); src.start();
      bed = { src, lp, g };
    }
    if (!drones.length && A.usable('drone_loop')) {
      for (let i = 0; i < N_DRONE; i++) {
        const src = ac.createBufferSource(), g = ac.createGain(), pan = ac.createPanner();
        src.buffer = A.buffers.drone_loop[0]; src.loop = true; g.gain.value = 0;
        pan.panningModel = 'equalpower'; pan.distanceModel = 'inverse'; pan.refDistance = 5; pan.rolloffFactor = 1.3; pan.maxDistance = 10000;
        src.connect(g); g.connect(pan); pan.connect(G.sfx); src.start(0, i * 0.37);
        drones.push({ src, g, pan });
      }
    }
  }

  events.on('heatTier', (e) => {
    const tier = Math.max(1, Math.min(5, e.tier | 0 || 1));
    stats.stingers++; bedBoost = 1;
    A.play2('stinger', 0.6 + tier * 0.08, 0, 0, 1.06 - tier * 0.03);
  });
  events.on('raidEnd', () => { bedBoost = 0; });

  const near = [null, null], nearD = [0, 0];
  return {
    stats,
    update(dt) {
      const ac = A.ac(), now = ac.currentTime, raid = inRaid();
      ensureLoops();

      // guard footsteps: one thud per stride actually walked, only for guards close enough to matter
      const bots = ctx.bots && ctx.bots.list;
      if (bots && raid) for (let i = 0; i < bots.length; i++) {
        const b = bots[i]; if (!b.alive || !b.pos) continue;
        let g = gait.get(b); if (!g) { g = { x: b.pos.x, z: b.pos.z, acc: Math.random() * 0.6 }; gait.set(b, g); }
        const dx = b.pos.x - g.x, dz = b.pos.z - g.z, moved = Math.hypot(dx, dz); g.x = b.pos.x; g.z = b.pos.z;
        if (moved > 1.5 || moved < 1e-4 || dt <= 0) continue; // teleport / standing still
        if (b.body && b.body.grounded === false) continue;
        const sp = moved / dt, stride = sp > 4.2 ? 1.15 : 0.82;
        g.acc += moved;
        if (g.acc < stride) continue;
        g.acc = 0;
        if (dist2(b.pos) > STEP_RANGE * STEP_RANGE) continue;
        stats.steps++;
        A.play3('step_bot', b.pos.x, b.pos.y + 0.1, b.pos.z, (sp > 4.2 ? 1.25 : 0.85) * (b.kind === 'heavy' ? 1.3 : 1), 0, (b.kind === 'heavy' ? 0.85 : 1) * (sp > 4.2 ? 1.05 : 0.95));
      }

      // drones: the nearest two get a rotor voice
      if (drones.length) {
        near[0] = near[1] = null; nearD[0] = nearD[1] = DRONE_RANGE * DRONE_RANGE;
        const list = raid && ctx.drones && ctx.drones.list;
        if (list) for (let i = 0; i < list.length; i++) {
          const d = list[i], p = posOf(d); if (!d.alive || !p) continue;
          const dd = dist2(p);
          if (dd < nearD[0]) { near[1] = near[0]; nearD[1] = nearD[0]; near[0] = d; nearD[0] = dd; } else if (dd < nearD[1]) { near[1] = d; nearD[1] = dd; }
        }
        for (let i = 0; i < N_DRONE; i++) {
          const v = drones[i], d = near[i];
          if (!d) { if (v.on) { v.on = false; v.g.gain.setTargetAtTime(0, now, 0.15); } stats.droneGain[i] = 0; continue; }
          const p = posOf(d), hunting = d.alertState === 'alert', sp = d.vel ? Math.hypot(d.vel.x, d.vel.y, d.vel.z) : 0;
          if (v.pan.positionX) { v.pan.positionX.value = p.x; v.pan.positionY.value = p.y; v.pan.positionZ.value = p.z; } else v.pan.setPosition(p.x, p.y, p.z);
          const gain = hunting ? 0.55 : 0.4;
          v.on = true; v.g.gain.setTargetAtTime(gain, now, 0.2); stats.droneGain[i] = gain;
          v.src.playbackRate.setTargetAtTime((hunting ? 1.16 : d.alertState === 'suspicious' ? 1.06 : 0.96) + Math.min(0.12, sp * 0.015), now, 0.25);
        }
      }

      // turrets: servo ticks, faster the more it knows
      const tl = raid && ctx.turrets && ctx.turrets.list;
      if (tl) for (let i = 0; i < tl.length; i++) {
        const t = tl[i], p = posOf(t); if (!t.alive || !p) continue;
        if (dist2(p) > TURRET_RANGE * TURRET_RANGE) continue;
        let left = (servoT.get(t) || Math.random()) - dt;
        if (left <= 0) {
          const st = t.alertState;
          left = st === 'alert' ? 0.24 : st === 'suspicious' ? 0.55 : 1.5 + Math.random() * 0.4;
          stats.servo++;
          A.play3('servo', p.x, p.y, p.z, st === 'alert' ? 1.3 : st === 'suspicious' ? 1.1 : 0.8, 0, st === 'alert' ? 1.3 : st === 'suspicious' ? 1.12 : 1);
        }
        servoT.set(t, left);
      }

      // low health: laboured breathing between the heartbeats
      const lowK = player.alive && player.hp > 0 && player.hp < player.maxHp * 0.35 ? 1 - player.hp / (player.maxHp * 0.35) : -1;
      if (lowK >= 0) { breathT -= dt; if (breathT <= 0) { breathT = 2.5 - lowK * 0.9; stats.breaths++; A.play2('breath', 0.6 + lowK * 0.5, 0, 0, 1 + lowK * 0.12); } } else breathT = 0.4;

      // tension: bed level / brightness and pulse rate follow heat
      const h = raid && player.alive ? heat01() : 0; stats.heat = h;
      bedBoost = Math.max(0, bedBoost - dt * 0.4);
      if (bed) {
        const target = raid ? BED_MIN + (BED_MAX - BED_MIN) * Math.pow(h, 1.3) + bedBoost * 0.05 : 0;
        stats.bed = target;
        bed.g.gain.setTargetAtTime(target, now, raid ? 1.2 : 0.4);
        bed.lp.frequency.setTargetAtTime(150 + 750 * h + bedBoost * 200, now, 0.8);
        bed.src.playbackRate.setTargetAtTime(1 + h * 0.06, now, 2);
      }
      if (h > 0.25) {
        pulseT -= dt;
        if (pulseT <= 0) { pulseT = 60 / (54 + 74 * h); stats.pulses++; A.play2('pulse', 0.25 + 0.75 * (h - 0.25) / 0.75, 0, 0, 1 + h * 0.12); }
      } else pulseT = 0.5;
    },
  };
}
