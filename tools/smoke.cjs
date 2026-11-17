// Headless check. Usage:
//   NODE_PATH=$(npm root -g) node tools/smoke.cjs <port> [script.js] [out.png]
// Loads the game, optionally runs script.js in the page (it may use window.__game and must
// evaluate to a JSON-able value or a Promise of one), prints the result and any page errors, saves a screenshot.
// In the page: __game.step(dt) advances the simulation; __game.input.keys / .pressed fake input;
// __game.player.pos / yaw / pitch place the camera. No GPU here: ~20 fps is normal, judge visuals from screenshots.
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const [port = '5173', script, out = 'shots/smoke.png'] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(`http://localhost:${port}/`);
  await p.waitForFunction(() => window.__game, null, { timeout: 90000 });
  await p.evaluate(() => { window.__test = true; document.getElementById('overlay').style.display = 'none'; for (let i = 0; i < 30; i++) window.__game.step(1 / 60); });
  if (script) console.log('result', JSON.stringify(await p.evaluate(fs.readFileSync(script, 'utf8'))));
  await p.waitForTimeout(2500);
  fs.mkdirSync(require('path').dirname(out), { recursive: true });
  await p.screenshot({ path: out, timeout: 150000 });
  console.log('errors', JSON.stringify(errs.slice(0, 10)));
  await b.close();
})();
