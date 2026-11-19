// Dash (Q): the rush of streaks across the screen, the whoosh, and the ability chip with its cooldown on the HUD.
// The movement itself is in player.js; this listens for its `dash` event.

export function init(ctx) {
  const { player, events } = ctx;
  const style = document.createElement('style');
  style.textContent = `
    #ds-fx { position: fixed; inset: -12%; pointer-events: none; opacity: 0;
      background: repeating-conic-gradient(from 0deg at var(--cx, 50%) 50%, rgba(255,255,255,0) 0deg 2.6deg, rgba(235,245,255,.5) 2.9deg 3.2deg, rgba(255,255,255,0) 3.5deg 7deg);
      -webkit-mask: radial-gradient(ellipse at var(--cx, 50%) 50%, transparent 22%, rgba(0,0,0,.5) 48%, #000 78%); mask: radial-gradient(ellipse at var(--cx, 50%) 50%, transparent 22%, rgba(0,0,0,.5) 48%, #000 78%); }
    #ds-fx.go { animation: ds-rush .38s ease-out; }
    @keyframes ds-rush { 0% { opacity: 0; transform: scale(1); } 18% { opacity: .95; } 100% { opacity: 0; transform: scale(1.35); } }
    #ds-chip { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%); display: flex; align-items: center; gap: 9px; padding: 5px 12px 5px 6px; background: rgba(8,12,16,.5); color: #fff; font-size: 11px; letter-spacing: 2.5px; text-transform: uppercase; pointer-events: none; text-shadow: 0 1px 2px #000; }
    #ds-chip .key { position: relative; width: 26px; height: 26px; display: grid; place-items: center; font-size: 13px; font-weight: 700; letter-spacing: 0; border: 1px solid rgba(255,255,255,.55); overflow: hidden; }
    #ds-chip .key i { position: absolute; left: 0; right: 0; bottom: 0; background: rgba(127,214,255,.55); }
    #ds-chip .key b { position: relative; }
    #ds-chip.wait { opacity: .7; } #ds-chip.wait .key { border-color: rgba(255,255,255,.25); }
    #ds-chip .t { min-width: 26px; font-variant-numeric: tabular-nums; opacity: .8; }
    #ds-chip.ready .key { border-color: #7fd6ff; box-shadow: 0 0 10px rgba(127,214,255,.5); }
    #ds-chip.pop { animation: ds-pop .3s ease-out; }
    @keyframes ds-pop { 0% { transform: translateX(-50%) scale(1.18); } 100% { transform: translateX(-50%) scale(1); } }`;
  document.head.appendChild(style);
  const fx = document.createElement('div'); fx.id = 'ds-fx';
  const chip = document.createElement('div'); chip.id = 'ds-chip'; chip.hidden = true;
  chip.innerHTML = '<div class="key"><i></i><b>Q</b></div><span>Dash</span><span class="t"></span>';
  ctx.hud.appendChild(fx); ctx.hud.appendChild(chip);
  const fill = chip.querySelector('.key i'), tEl = chip.querySelector('.t');
  let wasReady = true, shown = '';

  function whoosh() {
    const dbg = ctx.audio && ctx.audio.debug, ac = dbg && dbg.context, G = dbg && dbg.graph;
    if (!ac || !G || !G.master || ac.state !== 'running') return;
    const len = 0.34, buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * len), ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain(), t = ac.currentTime;
    src.buffer = buf; bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(2600, t + 0.11); bp.frequency.exponentialRampToValueAtTime(380, t + len);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.32, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0008, t + len);
    src.connect(bp); bp.connect(g); g.connect(G.master); src.start(t); src.stop(t + len + 0.02);
  }

  events.on('dash', (e) => {
    fx.style.setProperty('--cx', `${50 + Math.max(-1, Math.min(1, e.side || 0)) * 32}%`); // the streaks rush away from where you are heading
    fx.classList.remove('go'); void fx.offsetWidth; fx.classList.add('go');
    whoosh();
  });

  return {
    update() {
      const inRaid = ctx.raid ? ctx.raid.state === 'raid' : true;
      chip.hidden = !inRaid; if (!inRaid) return;
      const cd = Math.max(0, player.dashCd), ready = cd <= 0;
      const txt = ready ? '' : cd.toFixed(1);
      if (txt !== shown) { shown = txt; tEl.textContent = txt; fill.style.height = `${(1 - cd / (player.dashMax || 3)) * 100}%`; }
      if (ready !== wasReady) { chip.classList.toggle('ready', ready); chip.classList.toggle('wait', !ready); if (ready) { chip.classList.remove('pop'); void chip.offsetWidth; chip.classList.add('pop'); fill.style.height = '0%'; } wasReady = ready; }
    },
  };
}
