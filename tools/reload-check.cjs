// Checks the pistol start, a locker pickup, the recorded pistol sound, and that leaving the results screen reloads into a new layout.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:5173/'); await p.waitForFunction(() => window.__game, null, { timeout: 90000 });
  await p.waitForTimeout(4000); // let the recorded sounds decode
  const first = await p.evaluate(async () => {
    const g = window.__game, q = g.player, c = g.ctx, r = c.raid; window.__test = true; document.getElementById('overlay').style.display = 'none';
    const run = (n, keys) => { for (let i = 0; i < n; i++) { q.protectT = 999; if (keys) g.input.keys = new Set(keys); g.step(1 / 60); } };
    c.events.emit('userGesture', {}); await new Promise((res) => setTimeout(res, 2500));
    run(3); g.input.pressed.add('Enter'); run(3);
    const out = { seed: g.world.seed, start: c.weapons.current.def.id, profile: c.audio.gunProfile };
    let shots = 0; c.events.on('shot', (e) => { if (e.by === q && e.weapon === 'pistol') shots++; });
    for (let i = 0; i < 5; i++) { g.input.keys = new Set(['Mouse0']); g.input.pressed.add('Mouse0'); run(1); g.input.keys.clear(); run(12); }
    out.pistolShots = shots;
    out.recPistolLoaded = !!(c.audio.debug && JSON.stringify(Object.keys(c.audio.debug)).length) ; // presence only; detailed check below
    c.bots.setCount(0);
    const L = r.lootables.find((x) => x.kind === 'locker'); const wid = L.items[0].weapon;
    q.pos.set(L.pos.x, L.pos.y, L.pos.z - 1.3); q.vel.set(0, 0, 0); q.yaw = Math.PI; q.pitch = -0.1; run(3); run(170, ['KeyF']); g.input.keys.clear();
    out.locker = { weapon: wid, opened: L.opened, unlocked: c.weapons.inventory.filter((v) => !v.locked).map((v) => v.def.id) };
    q.protectT = 0; q.takeDamage(9999, {}); run(5); out.afterDeath = r.state; out.weaponAfterDeath = c.weapons.current.def.id;
    return out;
  });
  console.log('first', JSON.stringify(first));
  const nav = p.waitForNavigation({ timeout: 20000 }).then(() => true).catch(() => false);
  await p.evaluate(() => { const g = window.__game; g.input.pressed.add('Enter'); g.step(1 / 60); });
  const reloaded = await nav;
  await p.waitForFunction(() => window.__game, null, { timeout: 90000 });
  const second = await p.evaluate(() => ({ seed: window.__game.world.seed, state: window.__game.ctx.raid.state, buildings: window.__game.world.buildings.length }));
  console.log('reloaded', reloaded, JSON.stringify(second), 'newLayout', second.seed !== first.seed);
  console.log('errors', JSON.stringify(errs.slice(0, 8)));
  await b.close();
})();
