// Real-mouse check of the Traders and Base tabs.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:5173/'); await p.waitForFunction(() => window.__game, null, { timeout: 90000 });
  await p.evaluate(() => { const r = window.__game.ctx.raid, s = r.stash; Object.assign(s, { credits: 3000, grid: [], pack: [], w: [null, null], b: [null], upgrades: {}, tasks: {}, streak: 0 }); r.menu.normalise();
    for (const [name, tier, value] of [['Fuse Pack', 'common', 20], ['Ration Tin', 'common', 12], ['Copper Spool', 'common', 15], ['Field Dressing Case', 'uncommon', 80], ['Cable Reel', 'common', 30]]) r.menu.addToStash({ t: 'loot', name, tier, value }); r.menu.render(); });
  const st = () => p.evaluate(() => { const s = window.__game.ctx.raid.stash; return { cr: s.credits, grid: s.grid.filter(Boolean).map((i) => i.name || i.id || i.t + (i.size || '')), up: Object.keys(s.upgrades), tasks: JSON.stringify(s.tasks) }; });
  await p.locator('[data-tab="traders"]').click(); await p.waitForTimeout(200); await p.screenshot({ path: 'shots/traders.png' });
  console.log('traders', await p.locator('#iv .card').count(), JSON.stringify(await p.locator('[data-claim]').allTextContents()));
  await p.locator('[data-claim="vance"]').click(); await p.locator('[data-claim="ilse"]').click();
  console.log('afterClaim', JSON.stringify(await st()));
  await p.locator('[data-tab="base"]').click(); await p.waitForTimeout(200); await p.screenshot({ path: 'shots/base.png' });
  await p.locator('[data-build="med"]').click(); await p.locator('[data-build="locker"]').click();
  console.log('afterBuild', JSON.stringify(await st()));
  // raid-side tracking and effects
  const raid = await p.evaluate(() => { const g = window.__game, c = g.ctx, r = c.raid, q = g.player, s = r.stash; s.upgrades.health = true; s.upgrades.scout = true; s.upgrades.time = true;
    r.deploy(); for (let i = 0; i < 5; i++) g.step(1 / 60);
    const out = { maxHp: q.maxHp, hp: q.hp, medkits: r.medkits, reveal: Math.round(r.revealT), clock: Math.round(r.timeLeft) };
    const t = r.lootables.find((L) => L.kind === 'terminal'); c.bots.setCount(0);
    if (t) { q.pos.set(t.pos.x, t.pos.y, t.pos.z - 1.3); q.vel.set(0, 0, 0); q.yaw = Math.PI; q.pitch = -0.1; for (let i = 0; i < 230; i++) { q.protectT = 999; g.input.keys = new Set(['KeyF']); g.step(1 / 60); } g.input.keys.clear(); }
    out.ilse = JSON.stringify(s.tasks.ilse); return out; });
  console.log('raid', JSON.stringify(raid));
  console.log('errors', JSON.stringify(errs.slice(0, 6)));
  await b.close();
})();
