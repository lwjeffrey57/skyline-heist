// Behaviour: fight (range keeping, strafing, cover when hurt), lose the player -> chase -> search -> give up, and hearing.
(async () => {
  const g = window.__game, ctx = g.ctx, B = ctx.bots, pl = g.player, cfg = B.config, world = g.world, fail = [], out = {};
  const dt = 1 / 60, V = g.THREE.Vector3; cfg.respawnDelay = 3;
  const eye = new V(), tp = new V();
  const los = (b) => { eye.set(b.pos.x, b.pos.y + 1.62, b.pos.z); tp.set(pl.pos.x, pl.pos.y + 1.1, pl.pos.z); return world.lineOfSight(eye, tp); };
  // ---- 1) 45 s fight against a player who shoots back (simulated damage) but never dies
  const st = { engageT: 0, coverT: 0, coverHidden: 0, coverArrivedT: 0, speedSum: 0, n: 0, distSum: 0, visT: 0, tokens: 0, maxTokens: 0 };
  let seenBy = 0;
  for (let f = 0; f < 45 * 60; f++) {
    pl.pos.set(0, 0, 50); pl.vel.set(0, 0, 0); pl.hp = 100;
    if (f % 90 === 45) { const c = B.list.filter((b) => b.alive && b.state === 'combat' && b.visible); if (c.length) c[Math.random() * c.length | 0].takeDamage(28, { from: pl.pos, source: pl }); }
    g.step(dt);
    let tk = 0;
    for (const b of B.list) {
      if (!b.alive || b.state !== 'combat') continue;
      if (b.hasToken) tk++;
      st.n++; st.speedSum += Math.hypot(b.vel.x, b.vel.z); st.distSum += b.pos.distanceTo(pl.pos); if (b.visible) st.visT++;
      if (b.mode === 'cover') { st.coverT++; if (!b.moving) { st.coverArrivedT++; if (!los(b)) st.coverHidden++; } } else st.engageT++;
    }
    st.tokens += tk; if (tk > st.maxTokens) st.maxTokens = tk;
    if (f % 600 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  seenBy = B.list.filter((b) => b.state === 'combat').length;
  out.fight = { botsInCombatAtEnd: seenBy, avgSpeed: +(st.speedSum / st.n).toFixed(2), avgDist: +(st.distSum / st.n).toFixed(1), coverShare: +(st.coverT / st.n).toFixed(2),
    hiddenWhenInCover: +(st.coverHidden / Math.max(1, st.coverArrivedT)).toFixed(2), visibleShare: +(st.visT / st.n).toFixed(2), avgShooters: +(st.tokens / (45 * 60)).toFixed(2), maxShooters: st.maxTokens,
    shots: B.stats.shots, hits: B.stats.hits, deaths: B.list.reduce((a, b) => a + b.stats.deaths, 0) };
  if (!st.n) fail.push('no bot ever fought'); if (st.maxTokens > cfg.maxAttackers) fail.push('too many shooters');
  if (st.coverT === 0) fail.push('nobody took cover'); if (st.speedSum / st.n < 0.5) fail.push('bots do not move in combat');
  // ---- 2) the player vanishes: chase -> search -> patrol
  const seq = new Map(B.list.map((b) => [b, [b.state]])); let allPatrol = null;
  for (let f = 0; f < 60 * 60; f++) {
    pl.pos.set(0, 200, 0); pl.vel.set(0, 0, 0); pl.hp = 100; g.step(dt);
    for (const b of B.list) { const s = seq.get(b); if (s && s[s.length - 1] !== b.state) s.push(b.state); }
    if (allPatrol === null && B.list.every((b) => !b.alive || b.state === 'patrol')) { allPatrol = f / 60; break; }
  }
  out.afterVanish = { backToPatrolAfter: allPatrol, sequences: [...seq.values()].map((s) => s.join('>')) };
  if (allPatrol === null) fail.push('bots never gave up');
  if (![...seq.values()].some((s) => s.includes('chase') && s.includes('search'))) fail.push('no chase->search sequence seen');
  // ---- 3) hearing: a player shot far from everyone draws nearby bots
  for (let f = 0; f < 120; f++) { pl.pos.set(0, 200, 0); g.step(dt); }
  const src = B.list.find((b) => b.alive).pos.clone().add(new V(14, 0, 6)); src.x = Math.max(-60, Math.min(60, src.x)); src.z = Math.max(-60, Math.min(60, src.z));
  const d0 = B.list.map((b) => b.pos.distanceTo(src));
  ctx.events.emit('shot', { weapon: 'test', origin: src.clone(), dir: new V(0, 0, 1), muzzle: src.clone(), by: pl });
  const heard = B.list.filter((b) => b.state === 'investigate').length; let closest = d0.slice();
  for (let f = 0; f < 15 * 60; f++) { pl.pos.set(0, 200, 0); g.step(dt); B.list.forEach((b, i) => { const d = b.pos.distanceTo(src); if (d < closest[i]) closest[i] = d; }); }
  out.hearing = { heard, startDist: d0.map((d) => Math.round(d)), closest: closest.map((d) => Math.round(d)) };
  if (!heard) fail.push('nobody heard the shot'); if (!closest.some((d, i) => d0[i] > 10 && d < 7)) fail.push('nobody came to investigate');
  out.fail = fail; return out;
})()
