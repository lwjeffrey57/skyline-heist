// Stationary player at the spawn: bots must find and damage it; then kill / respawn checks and event payload checks.
(async () => {
  const g = window.__game, ctx = g.ctx, B = ctx.bots, ev = ctx.events, pl = g.player, fail = [], out = {};
  const dt = 1 / 60; let time = 0;
  const cnt = { shot: 0, flesh: 0, world: 0, spawned: 0, died: 0, damaged: 0, playerDamaged: 0, playerDied: 0, badShot: 0, dmg: 0 };
  let firstDamage = null; const lifetimes = []; let lifeStart = 0;
  ev.on('shot', (e) => { if (e.weapon !== 'bot_rifle') return; cnt.shot++; if (!(e.origin && e.dir && e.muzzle && e.by && e.by.team === 'enemy' && Math.abs(e.dir.length() - 1) < 1e-3)) cnt.badShot++; });
  ev.on('impact', (e) => { if (e.by && e.by.team === 'enemy') { if (!(e.point && e.normal && e.damage > 0)) cnt.badShot++; if (e.kind === 'flesh') cnt.flesh++; else if (e.kind === 'world' && e.collider) cnt.world++; else cnt.badShot++; } });
  ev.on('botSpawned', (e) => { cnt.spawned++; if (!e.bot || !e.point) fail.push('bad botSpawned'); });
  ev.on('botDied', (e) => { cnt.died++; if (!e.bot || !e.point) fail.push('bad botDied'); });
  ev.on('botDamaged', () => cnt.damaged++);
  ev.on('playerDamaged', (e) => { cnt.playerDamaged++; cnt.dmg += e.amount; if (firstDamage === null) firstDamage = time; });
  ev.on('playerDied', () => { cnt.playerDied++; lifetimes.push(+(time - lifeStart).toFixed(1)); lifeStart = time; });
  const states = {};
  const SECS = window.__combatSecs || 150;
  let sum = 0, n = 0;
  for (let f = 0; f < SECS * 60; f++) {
    g.step(dt); time += dt; sum += B.stats.updateMs; n++;
    if (f % 30 === 0) for (const b of B.list) if (b.alive) states[b.state] = (states[b.state] || 0) + 1;
    if (f % 600 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  out.firstDamageAt = firstDamage; out.playerLifetimes = lifetimes; out.counts = { ...cnt }; out.states = states;
  out.accuracy = +(cnt.flesh / Math.max(1, cnt.shot)).toFixed(2); out.avgUpdateMs = +(sum / n).toFixed(3);
  out.dpsOnPlayer = +(cnt.dmg / SECS).toFixed(1);
  if (firstDamage === null) fail.push('player never damaged');
  if (cnt.badShot) fail.push('malformed shot/impact events: ' + cnt.badShot);
  if (!cnt.world) fail.push('no world impacts from misses');

  // ---- kill every bot, check the target contract ----
  const V = g.THREE.Vector3;
  const died0 = cnt.died, spawned0 = cnt.spawned;
  for (const b of B.list) { if (b.alive) b.takeDamage(40, { from: pl.pos, source: pl }); }
  out.afterHit = B.list.map((b) => Math.round(b.hp));
  const victim = B.list.find((b) => b.alive);
  const vp = victim.pos.clone();
  for (const b of B.list) b.takeDamage(1000, { from: pl.pos, source: pl, headshot: true });
  if (B.list.some((b) => b.alive)) fail.push('bot still alive after lethal damage');
  if (cnt.died - died0 !== B.list.length) fail.push('botDied count ' + (cnt.died - died0));
  const o = new V(vp.x + 3, vp.y + 1, vp.z), h = ctx.hitscan(o, new V(-1, 0, 0), 6, null);
  if (h && h.type === 'target' && h.target === victim) fail.push('dead bot blocks shots');
  if (!ctx.targets.includes(victim)) fail.push('bot not in ctx.targets');
  for (let f = 0; f < (B.config.respawnDelay + 2) * 60; f++) g.step(dt);
  out.aliveAfterRespawn = B.list.filter((b) => b.alive).length;
  if (out.aliveAfterRespawn !== B.list.length) fail.push('not all bots respawned');
  if (cnt.spawned - spawned0 !== B.list.length) fail.push('botSpawned count ' + (cnt.spawned - spawned0));
  out.respawnDistToPlayer = B.list.map((b) => Math.round(b.pos.distanceTo(pl.pos)));
  // setCount
  B.setCount(8); for (let f = 0; f < 180; f++) g.step(dt);
  if (B.list.length !== 8 || ctx.targets.filter((t) => t.team === 'enemy').length !== 8) fail.push('setCount(8) failed');
  B.setCount(2); for (let f = 0; f < 30; f++) g.step(dt);
  if (B.list.length !== 2 || ctx.targets.filter((t) => t.team === 'enemy').length !== 2) fail.push('setCount(2) failed');
  B.setCount(6);
  out.fail = fail;
  return out;
})()
