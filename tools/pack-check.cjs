// Real-mouse check of backpacks (menu slot) and the in-raid pack screen (Tab, drag to drop).
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:5173/'); await p.waitForFunction(() => window.__game, null, { timeout: 90000 });
  await p.evaluate(() => { const r = window.__game.ctx.raid, s = r.stash; Object.assign(s, { credits: 5000, grid: [], pack: [], w: [null, null], b: [null], upgrades: {} }); r.menu.normalise(); r.menu.render(); });
  const centre = async (sel) => { const bx = await p.locator(sel).first().boundingBox(); return [bx.x + bx.width / 2, bx.y + bx.height / 2]; };
  const dragTo = async (from, to) => { const [x1, y1] = await centre(from), [x2, y2] = await centre(to); await p.mouse.move(x1, y1); await p.mouse.down(); await p.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 }); await p.mouse.move(x2, y2, { steps: 4 }); await p.mouse.up(); };
  const bagIdx = await p.evaluate(() => [...document.querySelectorAll('[data-buy]')].findIndex((e) => e.textContent.includes('Sling')));
  await p.locator(`[data-buy="${bagIdx}"]`).click();
  await dragTo('[data-zone="stash"][data-i="0"]', '[data-zone="bag"][data-i="0"]');
  console.log('menu', JSON.stringify(await p.evaluate(() => { const s = window.__game.ctx.raid.stash; return { bag: s.b[0], packSlots: s.pack.length, credits: s.credits, slotsShown: document.querySelectorAll('[data-zone="pack"]').length }; })));
  await p.screenshot({ path: 'shots/bagmenu.png' });
  await p.locator('[data-act="deploy"]').click(); await p.waitForTimeout(1500);
  await p.evaluate(() => { const g = window.__game, r = g.ctx.raid; g.ctx.bots.setCount(0); g.player.protectTime = 999; g.player.protectT = 999;
    r.pack.push({ name: 'Servo Core', tier: 'rare', value: 320 }, { name: 'Fuse Pack', tier: 'common', value: 20 }, { name: 'Data Slate', tier: 'uncommon', value: 120 }); });
  console.log('raid', JSON.stringify(await p.evaluate(() => { const r = window.__game.ctx.raid; return { state: r.state, size: r.packSize(), bonus: r.bagBonus }; })));
  await p.keyboard.press('Tab'); await p.waitForTimeout(700);
  console.log('open', JSON.stringify(await p.evaluate(() => ({ open: window.__game.ctx.raid.packOpen, tiles: document.querySelectorAll('#rd-packui .iv-tile').length, slots: document.querySelectorAll('#rd-packui [data-pi]').length }))));
  await p.screenshot({ path: 'shots/packui.png' });
  const loot0 = await p.evaluate(() => window.__game.ctx.raid.lootables.length);
  await dragTo('#rd-packui [data-pi="1"]', '#rd-packui [data-drop]');   // drop the Fuse Pack
  await dragTo('#rd-packui [data-pi="0"]', '#rd-packui [data-pi="1"]'); // swap the two that remain
  console.log('after', JSON.stringify(await p.evaluate((n) => { const r = window.__game.ctx.raid; return { pack: r.pack.map((i) => i.name), droppedBags: r.lootables.length - n }; }, loot0)));
  await p.keyboard.press('Tab'); await p.waitForTimeout(500);
  console.log('closed', JSON.stringify(await p.evaluate(() => ({ open: window.__game.ctx.raid.packOpen, hidden: document.getElementById('rd-packui').hidden }))));
  console.log('errors', JSON.stringify(errs.slice(0, 8)));
  await b.close();
})();
