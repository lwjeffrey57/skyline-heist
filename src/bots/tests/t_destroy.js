// The world changes under the bots: floors, stairs and walls are removed (with and without the pieceDestroyed
// event), rubble boxes are added. Bots must fall, keep moving, never end up inside geometry or outside the arena.
(async () => {
  const g = window.__game, ctx = g.ctx, B = ctx.bots, world = g.world, ev = ctx.events, nav = B.nav, fail = [], out = {};
  const dt = 1 / 60, V = g.THREE.Vector3; B.config.debug = true;
  const hold = () => { g.player.pos.set(0, 200, 0); g.player.vel.set(0, 0, 0); };
  const R = 0.33;
  const inside = (b) => { const p = b.pos; for (const c of world.colliders) if (p.x - R < c.max.x && p.x + R > c.min.x && p.y + 0.05 < c.max.y && p.y + 1.75 > c.min.y && p.z - R < c.max.z && p.z + R > c.min.z) return c; return null; };
  const remove = (c, withEvent) => { const center = c.min.clone().add(c.max).multiplyScalar(0.5), size = c.max.clone().sub(c.min); world.removeCollider(c); if (withEvent) ev.emit('pieceDestroyed', { collider: c, center, size, color: new g.THREE.Color(1, 1, 1), cause: {} }); };
  const under = (b) => { let best = null; for (const c of world.colliders) { const p = b.pos; if (c.destructible && p.x > c.min.x - 0.3 && p.x < c.max.x + 0.3 && p.z > c.min.z - 0.3 && p.z < c.max.z + 0.3 && Math.abs(c.max.y - p.y) < 0.05) best = c; } return best; };
  hold(); for (let f = 0; f < 60; f++) { hold(); g.step(dt); }

  // 1) a bot standing on the 2nd floor of building 0 must fall when its slab goes
  const b0 = B.list[0], bd = world.buildings[0];
  b0.clearPath(); b0.state = 'patrol'; b0.waitT = 5; b0.pos.set(bd.x - 6, 2 * bd.floorHeight + 0.01, bd.z + 4); b0.vel.set(0, 0, 0);
  for (let f = 0; f < 20; f++) { hold(); g.step(dt); }
  const y0 = b0.pos.y, slab = under(b0);
  if (!slab) fail.push('no slab under test bot'); else remove(slab, true);
  for (let f = 0; f < 90; f++) { hold(); g.step(dt); }
  out.fall = [+y0.toFixed(2), +b0.pos.y.toFixed(2)];
  if (!(b0.pos.y < y0 - 3)) fail.push('bot did not fall when its floor was removed');

  // 2) 90 s of continuous demolition around the bots
  let removed = 0, added = 0, overlaps = 0, outside = 0, sum = 0, n = 0, maxMs = 0; const win = new Map(), worst = [];
  const tags = { slab: 0, stair: 0, wall: 0, pillar: 0, cover: 0, lintel: 0, sill: 0, parapet: 0 };
  for (let f = 0; f < 90 * 60; f++) {
    hold();
    if (f % 20 === 0) {
      const b = B.list[(f / 20) % B.list.length | 0];
      if (b.alive) {
        // what the bot stands on, plus a random destructible piece within 5 m
        const u = under(b); if (u && Math.random() < 0.5) { tags[u.tag]++; remove(u, removed++ % 2 === 0); }
        const near = world.colliders.filter((c) => c.destructible && c.min.x < b.pos.x + 5 && c.max.x > b.pos.x - 5 && c.min.z < b.pos.z + 5 && c.max.z > b.pos.z - 5);
        if (near.length) { const c = near[Math.random() * near.length | 0]; tags[c.tag]++; remove(c, removed++ % 2 === 0); }
        // rubble a few metres ahead of it (never on top of any bot)
        const rx = b.pos.x + (Math.random() - 0.5) * 8, rz = b.pos.z + (Math.random() - 0.5) * 8, s = 0.4 + Math.random() * 0.9;
        if (Math.abs(rx) < 66 && Math.abs(rz) < 66 && !B.list.some((o) => Math.hypot(o.pos.x - rx, o.pos.z - rz) < 1.6)) {
          let gy = -99; for (const c of world.colliders) if (rx > c.min.x && rx < c.max.x && rz > c.min.z && rz < c.max.z && c.max.y <= b.pos.y + 0.3 && c.max.y > gy) gy = c.max.y;
          if (gy > -99) { world.addBox(rx, gy, rz, s, s * (0.5 + Math.random()), s, world.materials.concrete, { tag: 'prop', destructible: true }); added++; }
        }
      }
    }
    g.step(dt); const u = B.stats.updateMs; sum += u; n++; if (u > maxMs) maxMs = u;
    for (const b of B.list) {
      if (!b.alive) continue;
      if (f % 4 === 0) { const c = inside(b); if (c) { overlaps++; if (worst.length < 6) worst.push([b.name, c.tag, b.pos.toArray().map((v) => +v.toFixed(2)), [c.min.y, c.max.y]]); } }
      if (Math.abs(b.pos.x) > 70 || Math.abs(b.pos.z) > 70 || b.pos.y < -1) outside++;
      if (f % (60 * 30) === 0) { const w = win.get(b); if (w && w.distanceTo(b.pos) < 1.5) fail.push(`${b.name} moved ${w.distanceTo(b.pos).toFixed(2)} m in 30 s at ${b.pos.toArray().map((v) => v.toFixed(1))} (${b.state})`); win.set(b, b.pos.clone()); }
    }
    if (f % 600 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  out.removed = removed; out.added = added; out.tags = tags; out.colliders = world.colliders.length;
  if (overlaps) fail.push(overlaps + ' body/collider overlaps'); if (outside) fail.push(outside + ' outside samples');
  out.worst = worst;
  out.updateMs = { avg: +(sum / n).toFixed(3), max: +maxMs.toFixed(1) };
  out.nav = { ...nav.stats, version: nav.version };
  // 3) the grid still matches the world: rebuild a fresh copy of some columns and compare
  let mismatch = 0;
  for (let i = 0; i < 4000; i++) {
    const col = Math.random() * nav.N * nav.N | 0, before = nav.cnt[col], ys = []; for (let k = 0; k < before; k++) ys.push(nav.ys[col * nav.L + k]);
    nav.computeColumn(col);
    if (nav.cnt[col] !== before) mismatch++; else for (let k = 0; k < before; k++) if (Math.abs(nav.ys[col * nav.L + k] - ys[k]) > 1e-4) { mismatch++; break; }
  }
  out.gridMismatch = mismatch; if (mismatch) fail.push('nav grid out of date in ' + mismatch + ' sampled columns');
  out.bots = B.list.map((b) => ({ n: b.name, st: b.state, y: +b.pos.y.toFixed(1), stuck: b.stats.stuck, repaths: b.stats.repaths }));
  out.log = B.stuckLog.filter((a) => !String(a[0]).startsWith('SLOW')).slice(0, 12).map((a) => a.join(' '));
  out.fail = fail;
  return out;
})()
