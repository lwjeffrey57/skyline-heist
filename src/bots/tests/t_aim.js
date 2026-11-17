// Accuracy calibration: one bot held in place on a clear lane; measured hit rate vs a still and a strafing player
// at several ranges, plus time-to-kill on a stationary 100 hp player. Uses the live config.
(async () => {
  const g = window.__game, ctx = g.ctx, B = ctx.bots, pl = g.player, cfg = B.config, world = g.world, nav = B.nav, V = g.THREE.Vector3, out = {};
  const dt = 1 / 60; B.setCount(1); cfg.maxAttackers = 1;
  cfg.combatSpeed = 0.01; cfg.sprintSpeed = 0.01; cfg.retreatHp = -1; cfg.regenDelay = 1e9;
  for (let i = 0; i < 40; i++) g.step(dt);
  const b = B.list[0];
  // find a clear lane of length d: player at P (strafing +-4 m sideways), bot at P + dir * d
  const a = new V(), c = new V();
  const lane = (d) => {
    for (let t = 0; t < 4000; t++) {
      const id = nav.randomNode(-62, 62, -62, 62, -0.1, 0.1, 4); if (id < 0) continue;
      const P = nav.nodePos(id, new V()), ang = Math.random() * Math.PI * 2, dir = new V(Math.sin(ang), 0, Math.cos(ang)), Q = P.clone().addScaledVector(dir, d);
      if (Math.abs(Q.x) > 64 || Math.abs(Q.z) > 64 || nav.nodeAt(Q.x, 0, Q.z, 0.1) < 0) continue;
      const side = new V(dir.z, 0, -dir.x); let ok = true;
      for (const s of [-4.4, -2, 0, 2, 4.4]) for (const h of [0.15, 1.0, 1.7]) {
        a.set(Q.x, 1.62, Q.z); c.copy(P).addScaledVector(side, s); if (nav.nodeAt(c.x, 0, c.z, 0.1) < 0) ok = false; c.y = h;
        if (!world.lineOfSight(a, c)) ok = false;
      }
      if (ok) return { P, Q, side };
    }
    return null;
  };
  const place = (L) => {
    b.pos.copy(L.Q); b.vel.set(0, 0, 0); b.clearPath(); b.state = 'patrol'; b.waitT = 1e9; b.awareness = 0; b.lastCombatT = -99; b.releaseToken(); b.mag = cfg.magSize; b.reloadT = 0;
    b.aimYaw = b.bodyYaw = Math.atan2(L.P.x - L.Q.x, L.P.z - L.Q.z); b.scanBase = b.aimYaw; b.scanPhase = -b.t * 0.75;
  };
  const frame = (L, x, vx) => {
    pl.pos.copy(L.P).addScaledVector(L.side, x); pl.vel.copy(L.side).multiplyScalar(vx); pl.hp = 100; pl.protectT = 0; b.hp = b.maxHp; b.hurtT = 99;
    g.step(dt);
  };
  const rate = (L, speed, secs) => {
    place(L); let x = 0, dir = 1, s0 = null, h0 = 0, steady = 0;
    for (let f = 0; f < secs * 60; f++) {
      x += dir * speed * dt; if (Math.abs(x) > 4) dir = -Math.sign(x);
      frame(L, x, dir * speed);
      if (s0 === null && b.stats.shots > 0 && !b.firstBurst) { s0 = b.stats.shots; h0 = b.stats.hits; } // skip the first burst: "settled" rate
    }
    const sh = b.stats.shots - (s0 || 0), hi = b.stats.hits - h0;
    return { shots: sh, rate: +(hi / Math.max(1, sh)).toFixed(3) };
  };
  const ttk = (L, damage, trials) => {
    cfg.damage = damage; const ts = [], tAll = [];
    for (let k = 0; k < trials; k++) {
      place(L); const d0 = b.stats.damageDealt, s0 = b.stats.shots; let tFirst = null, t = 0;
      while (t < 600) { frame(L, 0, 0); t += dt; if (tFirst === null && b.stats.shots > s0) tFirst = t; if (b.stats.damageDealt - d0 >= 100) break; }
      ts.push(t - tFirst); tAll.push(t);
      for (let f = 0; f < 30; f++) { pl.pos.set(0, 300, 0); g.step(dt); } b.forget();
    }
    ts.sort((x, y) => x - y); const avg = (q) => +(q.reduce((x, y) => x + y, 0) / q.length).toFixed(1);
    return { fromFirstShot: avg(ts), fromSpotted: avg(tAll), min: +ts[0].toFixed(1), max: +ts[ts.length - 1].toFixed(1) };
  };
  const curve = (d) => { const c = cfg.accuracyByRange; for (let i = 1; i < c.length; i++) if (d <= c[i][0]) return +(c[i - 1][1] + (c[i][1] - c[i - 1][1]) * (d - c[i - 1][0]) / (c[i][0] - c[i - 1][0])).toFixed(3); };
  const lanes = {};
  for (const d of [8, 15, 25, 40, 60]) {
    const L = lanes[d] = lane(d); if (!L) { out['d' + d] = 'no clear lane'; continue; }
    const st = rate(L, 0, 240), mv = rate(L, 5.5, 240);
    out['d' + d] = { model: curve(d), still: st.rate, stillShots: st.shots, strafe: mv.rate, strafeShots: mv.shots };
    await new Promise((r) => setTimeout(r, 0));
  }
  out.ttk = {};
  for (const d of [15, 40]) for (const dm of [4, 7]) { if (lanes[d]) out.ttk[`${d}m dmg${dm}`] = ttk(lanes[d], dm, 12); await new Promise((r) => setTimeout(r, 0)); }
  return out;
})()
