// 4 minutes of roaming with the player parked out of the way: coverage of every building level,
// no bot stuck, no tunnelling (bodies never overlap a collider), nobody leaves the arena, update cost.
(async () => {
  const g = window.__game, ctx = g.ctx, B = ctx.bots, world = g.world, fail = [], out = {};
  const SECS = window.__roamSecs || 240, dt = 1 / 60; B.config.debug = true; const spikes = [], all = [], ctrlSpikes = [];
  g.player.pos.set(0, 200, 0); g.player.vel.set(0, 0, 0);           // far above: nobody sees the player
  const hold = () => { g.player.pos.set(0, 200, 0); g.player.vel.set(0, 0, 0); };
  const levels = {}; world.buildings.forEach((b, i) => { for (let f = 1; f <= b.floors; f++) levels[`b${i}:L${f}`] = 0; });
  const win = new Map(), minMove = []; let overlaps = 0, outside = 0, maxMs = 0, sumMs = 0, n = 0, maxStepMs = 0;
  const R = 0.35 - 0.02;
  const inside = (b) => { const p = b.pos; for (const c of world.colliders) if (p.x - R < c.max.x && p.x + R > c.min.x && p.y + 0.05 < c.max.y && p.y + 1.75 > c.min.y && p.z - R < c.max.z && p.z + R > c.min.z) return true; return false; };
  const worst = [];
  for (let f = 0; f < SECS * 60; f++) {
    hold();
    let c0 = performance.now(), cx = 0; for (let q = 0; q < 20000; q++) cx += Math.sqrt(q); c0 = performance.now() - c0; if (c0 > 3) ctrlSpikes.push([f, +c0.toFixed(1)]);
    const t0 = performance.now(); g.step(dt); const ms = performance.now() - t0; if (ms > maxStepMs) maxStepMs = ms;
    const u = B.stats.updateMs; sumMs += u; n++; if (u > maxMs) maxMs = u; all.push(u); if (u > 4) spikes.push([f, +u.toFixed(1)]);
    for (const b of B.list) {
      if (!b.alive) continue;
      if (f % 6 === 0 && inside(b)) { overlaps++; if (worst.length < 5) worst.push(['overlap', b.name, b.pos.toArray().map((v) => +v.toFixed(2))]); }
      if (Math.abs(b.pos.x) > 70 || Math.abs(b.pos.z) > 70 || b.pos.y < -1) outside++;
      world.buildings.forEach((bd, i) => {
        if (Math.abs(b.pos.x - bd.x) < bd.w / 2 && Math.abs(b.pos.z - bd.z) < bd.d / 2 && b.body.grounded) {
          const lv = Math.round(b.pos.y / bd.floorHeight); if (lv >= 1 && Math.abs(b.pos.y - lv * bd.floorHeight) < 0.1) levels[`b${i}:L${lv}`]++;
        }
      });
      if (f % (60 * 20) === 0) { // 20 s windows
        const w = win.get(b); if (w) { const d = w.distanceTo(b.pos); minMove.push(d); if (d < 1.5) fail.push(`${b.name} moved only ${d.toFixed(2)} m in 20 s (state ${b.state}) at ${b.pos.toArray().map((v) => v.toFixed(1))}`); }
        win.set(b, b.pos.clone());
      }
    }
    if (f % 600 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  out.levels = levels;
  for (const k in levels) if (!levels[k]) fail.push('never reached ' + k);
  if (overlaps) fail.push(`${overlaps} body/collider overlaps`); if (outside) fail.push(`${outside} out-of-arena samples`);
  out.worst = worst;
  out.minWindowMove = +Math.min(...minMove).toFixed(1);
  all.sort((a, b) => a - b); out.pct = { p50: +all[all.length >> 1].toFixed(3), p99: +all[Math.floor(all.length * 0.99)].toFixed(3), p999: +all[Math.floor(all.length * 0.999)].toFixed(3) };
  out.updateMs = { avg: +(sumMs / n).toFixed(3), max: +maxMs.toFixed(2), maxWholeStep: +maxStepMs.toFixed(2) };
  out.poiVisits = Object.fromEntries(B.pois.map((p) => [p.name, p.visits + (p.fails ? `(f${p.fails})` : '')]));
  out.bots = B.list.map((b) => ({ n: b.name, st: b.state, stuck: b.stats.stuck, repaths: b.stats.repaths, pads: b.stats.pads }));
  out.spikes = spikes.slice(0, 20); out.ctrlSpikes = ctrlSpikes.slice(0, 20); out.stuckLog = B.stuckLog.slice(0, 40).map((a) => a.join(' '));
  out.nav = B.nav.stats; out.fail = fail;
  return out;
})()
