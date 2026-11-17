// Drives the inventory screen with a real mouse: buy, drag to weapon slot and pack, deploy, extract, sell.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:5173/'); await p.waitForFunction(() => window.__game, null, { timeout: 90000 });
  await p.evaluate(() => { const r = window.__game.ctx.raid, s = r.stash; Object.assign(s, { credits: 3000, grid: [], pack: [], w: [null, null], upgrades: {}, extracted: 0, lost: 0, best: 0 });
    s.grid = []; r.menu.normalise(); r.menu.addToStash({ t: 'loot', name: 'Servo Core', tier: 'rare', value: 320 }); r.menu.addToStash({ t: 'loot', name: 'Fuse Pack', tier: 'common', value: 20 }); r.menu.render(); });
  const centre = async (sel) => { const bx = await p.locator(sel).first().boundingBox(); return [bx.x + bx.width / 2, bx.y + bx.height / 2]; };
  const dragTo = async (from, to) => { const [x1, y1] = await centre(from), [x2, y2] = await centre(to); await p.mouse.move(x1, y1); await p.mouse.down(); await p.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 }); await p.mouse.move(x2, y2, { steps: 4 }); await p.mouse.up(); };
  const st = () => p.evaluate(() => { const s = window.__game.ctx.raid.stash; const n = (it) => it && (it.id || it.name || it.t); return { cr: s.credits, grid: s.grid.filter(Boolean).map(n), pack: s.pack.filter(Boolean).map(n), w: s.w.map(n) }; });
  console.log('visible', await p.evaluate(() => window.__game.ctx.raid.menu.visible));
  await p.locator('[data-buy="0"]').click(); await p.locator('[data-buy="7"]').click(); await p.locator('[data-buy="8"]').click();
  console.log('bought', JSON.stringify(await st()));
  await dragTo('[data-zone="stash"][data-i="2"]', '[data-zone="w"][data-i="0"]');   // rifle -> weapon slot
  await dragTo('[data-zone="stash"][data-i="3"]', '[data-zone="pack"][data-i="0"]'); // medkit -> pack
  await dragTo('[data-zone="stash"][data-i="4"]', '[data-zone="pack"][data-i="1"]'); // plate -> pack
  await dragTo('[data-zone="stash"][data-i="0"]', '[data-zone="w"][data-i="1"]');   // loot -> weapon slot: must be refused
  await dragTo('[data-zone="stash"][data-i="1"]', '[data-zone="sell"]');            // sell the Fuse Pack (+20)
  console.log('arranged', JSON.stringify(await st()));
  await p.mouse.move(640, 300); await p.waitForTimeout(300); await p.screenshot({ path: 'shots/inv.png' });
  await p.locator('[data-act="deploy"]').click(); await p.waitForTimeout(800);
  const raid = await p.evaluate(() => { const g = window.__game, c = g.ctx, r = c.raid, q = g.player; window.__test = true;
    const run = (n, keys) => { for (let i = 0; i < n; i++) { q.protectT = 999; if (keys) g.input.keys = new Set(keys); g.step(1 / 60); } g.input.keys.clear(); };
    const out = { state: r.state, menu: r.menu.visible, unlocked: c.weapons.inventory.filter((v) => !v.locked).map((v) => v.def.id), medkits: r.medkits, armor: r.armor, overlay: getComputedStyle(document.getElementById('overlay')).display };
    c.bots.setCount(0); const L = r.lootables.find((x) => x.kind !== 'locker'); q.pos.set(L.pos.x + 0.9, L.pos.y, L.pos.z); q.vel.set(0, 0, 0); q.yaw = Math.PI / 2; q.pitch = -0.5; run(2); run(200, ['KeyF']); run(200);
    const K = r.lootables.find((x) => x.kind === 'locker'); out.lockerGun = K.items[0].weapon; q.pos.set(K.pos.x, K.pos.y, K.pos.z - 1.3); q.yaw = Math.PI; q.pitch = -0.1; run(2); run(170, ['KeyF']); run(120);
    out.raidPack = r.pack.length; const z = r.zones.find((zn) => zn.active); q.pos.set(z.x, 0, z.z); q.vel.set(0, 0, 0); for (let i = 0; i < 420 && r.state === 'raid'; i++) run(1);
    out.end = r.state; return out; });
  console.log('raid', JSON.stringify(raid)); console.log('after', JSON.stringify(await st()));
  console.log('errors', JSON.stringify(errs.slice(0, 8)));
  await b.close();
})();
