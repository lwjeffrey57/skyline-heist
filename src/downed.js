// Downed: running out of health knocks you down instead of killing you. You can crawl and look around while you
// bleed out. Hold F to use a self-revive kit if you carry one; hold X to give up and end it. Being shot while down
// hurries the end. When the bleed-out finishes, the raid is lost exactly as a death was before.

const CFG = { bleed: 25, giveUpRate: 7, hitCost: 0.12, reviveHold: 4, reviveHp: 45, reviveShield: 2.5 };

export function init(ctx) {
  const { player, events, input } = ctx;
  let bleed = 0, hold = 0, lastInfo = null;

  const style = document.createElement('style');
  style.textContent = `
    #dn { position: fixed; inset: 0; pointer-events: none; color: #fff; text-shadow: 0 2px 6px #000; }
    #dn .red { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 55%, rgba(120,0,0,.05) 25%, rgba(140,0,0,.55) 75%, rgba(90,0,0,.85) 100%); animation: dn-pulse 1.1s ease-in-out infinite; }
    @keyframes dn-pulse { 50% { opacity: .72; } }
    #dn .box { position: absolute; left: 50%; top: 30%; transform: translateX(-50%); width: 420px; text-align: center; }
    #dn h2 { margin: 0; font-size: 40px; letter-spacing: 14px; text-transform: uppercase; color: #ff6b5e; }
    #dn .sub { margin-top: 2px; font-size: 12px; letter-spacing: 3px; text-transform: uppercase; opacity: .85; }
    #dn .bar { height: 8px; margin: 12px 0 14px; background: rgba(255,255,255,.16); }
    #dn .bar i { display: block; height: 100%; background: #ff5a4a; }
    #dn .opt { display: flex; align-items: center; gap: 10px; margin: 6px auto; padding: 7px 12px; width: 360px; background: rgba(8,12,16,.6); font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase; text-align: left; }
    #dn .opt kbd { font: inherit; font-weight: 700; padding: 1px 8px; border: 1px solid rgba(255,255,255,.6); }
    #dn .opt .p { flex: 1; height: 4px; background: rgba(255,255,255,.14); } #dn .opt .p b { display: block; height: 100%; width: 0; background: #8ff0c8; }
    #dn .opt.off { opacity: .5; }`;
  document.head.appendChild(style);
  const root = document.createElement('div'); root.id = 'dn'; root.hidden = true;
  root.innerHTML = `<div class="red"></div><div class="box"><h2>Downed</h2><div class="sub">Bleeding out — <span class="t"></span>s</div><div class="bar"><i></i></div>
    <div class="opt rev"><kbd>F</kbd><span class="l"></span><div class="p"><b></b></div></div>
    <div class="opt"><kbd>X</kbd><span>Hold to give up</span></div></div>`;
  ctx.hud.appendChild(root);
  const tEl = root.querySelector('.t'), bar = root.querySelector('.bar i'), rev = root.querySelector('.rev'), revL = rev.querySelector('.l'), revP = rev.querySelector('.p b');

  function end() { // bled out: this is the death the game had before
    player.downed = false; root.hidden = true;
    events.emit('playerDied', lastInfo || {}); player.respawn(); events.emit('playerRespawned', {});
  }
  player.downHook = (info) => {
    if (!ctx.raid || ctx.raid.state !== 'raid') return false; // only in a raid
    player.downed = true; player.hp = 1; bleed = CFG.bleed; hold = 0; lastInfo = info; root.hidden = false;
    events.emit('playerDowned', info || {});
    if (ctx.raid.chime) ctx.raid.chime([220, 165, 110], 0.16, 0.5, 0.22, 'sawtooth');
    return true;
  };
  player.downHit = (amount) => { bleed -= amount * CFG.hitCost; };
  events.on('raidEnd', () => { player.downed = false; root.hidden = true; });

  return {
    update(dt) {
      if (!player.downed) { if (!root.hidden) root.hidden = true; return; }
      const kits = ctx.raid ? ctx.raid.revives : 0;
      bleed -= dt * (input.down('KeyX') ? CFG.giveUpRate : 1);
      if (kits > 0 && input.down('KeyF')) {
        hold += dt;
        if (hold >= CFG.reviveHold && ctx.raid.useRevive()) {
          player.downed = false; player.hp = CFG.reviveHp; player.hurtT = 0; player.protectT = CFG.reviveShield; root.hidden = true;
          events.emit('playerRevived', {});
          if (ctx.raid.chime) ctx.raid.chime([392, 523, 659, 784], 0.08, 0.35, 0.2);
          if (ctx.raid.toast) ctx.raid.toast('Back on your feet', '#8ff0c8');
          return;
        }
      } else hold = Math.max(0, hold - dt * 2);
      if (bleed <= 0) { end(); return; }
      tEl.textContent = Math.ceil(bleed); bar.style.width = `${(bleed / CFG.bleed) * 100}%`;
      rev.classList.toggle('off', kits <= 0);
      revL.textContent = kits > 0 ? `Hold to self-revive (${kits} kit${kits > 1 ? 's' : ''})` : 'No self-revive kit';
      revP.style.width = `${Math.min(1, hold / CFG.reviveHold) * 100}%`;
    },
  };
}
