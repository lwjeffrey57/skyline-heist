// Free-for-all: (1) player parked safe, bots must hunt each other; (2) player exposed, attention on it vs on a single bot.
(async () => {
  const g = window.__game, ctx = g.ctx, B = ctx.bots, pl = g.player, cfg = B.config, ev = ctx.events, fail = [], out = {};
  const dt = 1 / 60, MIN = window.__ffaMin || 4;
  B.setCount(7); cfg.ffa = true;
  const kills = new Map(), deaths = new Map(); let byNull = 0, total = 0, phase = 1;
  const hitsOn = new Map(), shotsAt = new Map();
  ev.on('botDied', (e) => { total++; deaths.set(e.bot.name, (deaths.get(e.bot.name) || 0) + 1); if (!e.by) byNull++; else { const n = e.by === pl ? 'PLAYER' : e.by.name; kills.set(n, (kills.get(n) || 0) + 1); } if (e.by === e.bot) fail.push('self kill'); });
  ev.on('impact', (e) => { if (phase === 2 && e.kind === 'flesh' && e.by && e.by.isBot) { const n = e.target === pl ? 'PLAYER' : e.target.name; hitsOn.set(n, (hitsOn.get(n) || 0) + 1); } });
  ev.on('shot', (e) => { if (phase === 2 && e.by && e.by.isBot && e.by.target) { const t = e.by.target, n = t === pl ? 'PLAYER' : t.name; shotsAt.set(n, (shotsAt.get(n) || 0) + 1); } });
  const all = []; let sum = 0, n = 0, rays0 = B.stats.rays, maxRays = 0, lastRays = rays0; const win = new Map(); let inCombat = 0, samples = 0;
  const run = (secs, hold) => {
    for (let f = 0; f < secs * 60; f++) {
      hold(); g.step(dt);
      const u = B.stats.updateMs; all.push(u); sum += u; n++;
      const r = B.stats.rays - lastRays; lastRays = B.stats.rays; if (r > maxRays) maxRays = r;
      if (f % 30 === 0) for (const b of B.list) { if (b.alive) { samples++; if (b.state === 'combat') inCombat++; } }
      if (f % 1800 === 0) for (const b of B.list) { const w = win.get(b); if (w && b.alive && w.d === b.stats.deaths && w.p.distanceTo(b.pos) < 1) fail.push(`${b.name} moved <1 m in 30 s (${b.state}/${b.mode})`); win.set(b, { p: b.pos.clone(), d: b.stats.deaths }); }
      if (Math.abs(b0.pos.x) > 71) fail.push('out of arena');
    }
  };
  const b0 = B.list[0];
  for (let i = 0; i < 60; i++) { pl.pos.set(0, 250, 0); pl.vel.set(0, 0, 0); pl.protectT = 999; g.step(dt); }
  for (let m = 0; m < MIN; m++) { run(60, () => { pl.pos.set(0, 250, 0); pl.vel.set(0, 0, 0); pl.protectT = 999; pl.hp = 100; }); await new Promise((r) => setTimeout(r, 0)); }
  all.sort((a, b) => a - b);
  out.brawl = { damage: cfg.damage, hp: cfg.hp, minutes: MIN, kills: total, killsPerMin: +(total / MIN).toFixed(1), killsBy: Object.fromEntries(kills), deaths: Object.fromEntries(deaths), byNull,
    combatShare: +(inCombat / samples).toFixed(2), updateMs: { avg: +(sum / n).toFixed(3), p50: +all[all.length >> 1].toFixed(2), p99: +all[Math.floor(all.length * 0.99)].toFixed(2) },
    raysPerFrame: { avg: +((B.stats.rays - rays0) / n).toFixed(2), max: maxRays }, stuck: B.list.map((b) => b.stats.stuck) };
  if (total < MIN * 2) fail.push('too few kills'); if (byNull) fail.push(byNull + ' kills without credit');
  const names = B.list.map((b) => b.name); out.names = names;
  for (const nm of names) if (!kills.get(nm)) fail.push(nm + ' never got a kill');
  // ---- phase 2: player exposed (shielded so the run continues), standing on open ground
  phase = 2; const k0 = total; let tgtPlayer = 0, tgtBots = 0, s2 = 0;
  for (let m = 0; m < MIN; m++) {
    for (let f = 0; f < 3600; f++) {
      pl.pos.set(6, 0, 34); pl.vel.set(0, 0, 0); pl.protectT = 999; pl.hp = 100; g.step(dt);
      if (f % 30 === 0) { s2++; for (const b of B.list) if (b.alive && b.target) { if (b.target === pl) tgtPlayer++; else tgtBots++; } }
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  const botHits = names.map((nm) => hitsOn.get(nm) || 0), botShots = names.map((nm) => shotsAt.get(nm) || 0);
  out.exposed = { minutes: MIN, botKills: total - k0, avgBotsTargetingPlayer: +(tgtPlayer / s2).toFixed(2), avgBotsTargetingEachBot: +(tgtBots / s2 / names.length).toFixed(2),
    shotsAtPlayer: shotsAt.get('PLAYER') || 0, shotsAtEachBot: botShots, hitsOnPlayer: hitsOn.get('PLAYER') || 0, hitsOnEachBot: botHits };
  out.fail = fail; return out;
})()
