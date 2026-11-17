// Bot test runner (headless). Usage:
//   NODE_PATH=$(npm root -g) node src/bots/tests/run.cjs <port> <script.js>[:shot.png] [more ...]  [--size=800x450] [--post]
// Each script is evaluated in the page (may return a Promise of a JSON-able value); if a png is given a screenshot follows.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const args = process.argv.slice(2), port = args.shift();
  const flags = args.filter((a) => a.startsWith('--')), jobs = args.filter((a) => !a.startsWith('--'));
  const size = (flags.find((f) => f.startsWith('--size=')) || '--size=800x450').slice(7).split('x').map(Number);
  const post = flags.includes('--post');
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let code = 0;
  try {
    const p = await b.newPage({ viewport: { width: size[0], height: size[1] } });
    const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await p.goto(`http://localhost:${port}/`);
    await p.waitForFunction(() => window.__game, null, { timeout: 120000 });
    await p.evaluate((post) => { window.__test = true; document.getElementById('overlay').style.display = 'none'; window.__game.view.setPostEnabled(post); for (let i = 0; i < 30; i++) window.__game.step(1 / 60); }, post);
    for (const job of jobs) {
      const [script, png] = job.split(':');
      const res = await p.evaluate(fs.readFileSync(script, 'utf8'));
      console.log(path.basename(script), JSON.stringify(res, null, 1));
      if (res && res.fail && res.fail.length) code = 1;
      if (png) { await p.waitForTimeout(1500); fs.mkdirSync(path.dirname(path.resolve(png)), { recursive: true }); await p.screenshot({ path: png, timeout: 240000 }); }
    }
    console.log('errors', JSON.stringify(errs.slice(0, 10)));
    if (errs.length) code = 1;
  } finally { await b.close(); }
  process.exit(code);
})().catch((e) => { console.error(e); process.exit(2); });
