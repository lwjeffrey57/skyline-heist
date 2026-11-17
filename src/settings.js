// Player settings (saved in the browser) and the pause screen. Escape frees the mouse; the game stops until Resume.

const DEFAULTS = { sens: 1, fov: 88, volume: 0.55, quality: 'high' };

export function init(ctx) {
  const { player, view } = ctx;
  const s = { ...DEFAULTS };
  try { Object.assign(s, JSON.parse(localStorage.getItem('sh-settings') || '{}')); } catch { /* storage unavailable */ }
  const save = () => { try { localStorage.setItem('sh-settings', JSON.stringify(s)); } catch { /* storage unavailable */ } };
  function apply() {
    player.baseFov = s.fov;
    if (ctx.audio && ctx.audio.setVolume) ctx.audio.setVolume(s.volume);
    if (view.setQuality && view.quality !== s.quality) view.setQuality(s.quality);
  }
  ctx.settings = s;

  const style = document.createElement('style');
  style.textContent = `
    .set { display: grid; grid-template-columns: auto 1fr 44px; gap: 7px 12px; align-items: center; font-size: 12px; letter-spacing: 1px; text-align: left; }
    .set input[type=range] { width: 100%; accent-color: #ffc56b; }
    .set select { font: inherit; color: #fff; background: #151a21; border: 1px solid rgba(255,255,255,.25); padding: 3px 6px; grid-column: 2 / 4; }
    .set output { font-variant-numeric: tabular-nums; opacity: .8; text-align: right; }
    #overlay #settings { margin: 0 auto 18px; width: 340px; padding: 12px 14px; background: rgba(255,255,255,.05); cursor: default; }
    #overlay .abandon { display: inline-block; margin-left: 12px; padding: 10px 18px; border: 1px solid rgba(255,138,112,.6); color: #ff8a70; font-weight: 700; letter-spacing: 2px; cursor: pointer; }`;
  document.head.appendChild(style);

  // builds the controls into any container (the pause screen and the inventory both show them)
  ctx.mountSettings = (host) => {
    host.innerHTML = `<div class="set">
      <label>Mouse sensitivity</label><input type="range" data-k="sens" min="0.2" max="3" step="0.05"><output></output>
      <label>Field of view</label><input type="range" data-k="fov" min="70" max="105" step="1"><output></output>
      <label>Volume</label><input type="range" data-k="volume" min="0" max="1" step="0.05"><output></output>
      <label>Graphics</label><select data-k="quality"><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
    </div>`;
    const show = (inp) => { const o = inp.nextElementSibling; if (o && o.tagName === 'OUTPUT') o.textContent = inp.dataset.k === 'volume' ? `${Math.round(inp.value * 100)}%` : inp.dataset.k === 'sens' ? `${Number(inp.value).toFixed(2)}×` : inp.value; };
    host.querySelectorAll('[data-k]').forEach((inp) => {
      inp.value = s[inp.dataset.k]; show(inp);
      inp.addEventListener('input', () => { s[inp.dataset.k] = inp.type === 'range' ? Number(inp.value) : inp.value; show(inp); apply(); save(); });
      for (const ev of ['mousedown', 'click', 'keydown']) inp.addEventListener(ev, (e) => e.stopPropagation()); // adjusting a setting must not resume or drag
    });
  };

  // the old start screen becomes the pause screen (the inventory is what you see first now)
  const overlay = document.getElementById('overlay'), card = document.getElementById('card');
  if (overlay && card) {
    card.querySelector('h1').textContent = 'Paused';
    const sub = card.querySelector('.sub'); if (sub) sub.textContent = 'The raid is waiting for you';
    const go = document.getElementById('go'); go.textContent = 'Resume';
    const box = document.createElement('div'); box.id = 'settings'; card.insertBefore(box, document.getElementById('keys'));
    ctx.mountSettings(box);
    const ab = document.createElement('div'); ab.className = 'abandon'; ab.textContent = 'Abandon raid'; go.after(ab);
    ab.addEventListener('click', (e) => { e.stopPropagation(); if (ctx.raid && ctx.raid.state === 'raid') { ctx.raid.endRaid('mia'); overlay.click(); } });
    box.addEventListener('click', (e) => e.stopPropagation());
  }
  apply();
  if (ctx.raid && ctx.raid.menu && ctx.raid.menu.visible) ctx.raid.menu.render();
  return {};
}
