// Detection display: shows which guards are noticing you and how close they are to spotting you.
// Reads bot.awareness (0..1), bot.alertState ('unaware' | 'suspicious' | 'alert') and bot.role from the bots system.

const RADIUS = 118, MAX = 8;
const COLORS = { unaware: '#ffffff', suspicious: '#ffd24a', alert: '#ff5a4a' };

export function init(ctx) {
  const { player } = ctx;
  const style = document.createElement('style');
  style.textContent = `
    #dt-root { position: fixed; left: 50%; top: 50%; width: 0; height: 0; pointer-events: none; }
    .dt-pip { position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%;
      background: conic-gradient(var(--c) calc(var(--f) * 1%), rgba(255,255,255,.16) 0);
      -webkit-mask: radial-gradient(circle, transparent 6px, #000 7px); mask: radial-gradient(circle, transparent 6px, #000 7px);
      filter: drop-shadow(0 0 2px rgba(0,0,0,.8)); }
    #dt-status { position: fixed; top: 62px; left: 50%; transform: translateX(-50%); font-size: 11px; letter-spacing: 3px; text-transform: uppercase; text-shadow: 0 1px 3px rgba(0,0,0,.8); pointer-events: none; }`;
  document.head.appendChild(style);
  const root = document.createElement('div'); root.id = 'dt-root';
  const status = document.createElement('div'); status.id = 'dt-status';
  ctx.hud.append(root, status);
  const pips = Array.from({ length: MAX }, () => { const d = document.createElement('div'); d.className = 'dt-pip'; d.hidden = true; root.appendChild(d); return d; });

  return {
    update() {
      const inRaid = ctx.raid ? ctx.raid.state === 'raid' : true;
      const bots = inRaid && ctx.bots ? ctx.bots.list : [];
      const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
      let n = 0, worst = 'unaware', top = 0;
      for (const b of bots) {
        if (!b.alive) continue;
        const aw = b.alertState === 'alert' ? 1 : Math.max(0, Math.min(1, b.awareness || 0));
        if (aw < 0.04) continue;
        const st = b.alertState || (aw >= 1 ? 'alert' : 'unaware');
        if (st === 'alert' || (st === 'suspicious' && worst !== 'alert')) worst = st;
        top = Math.max(top, aw);
        if (n >= MAX) continue;
        const dx = b.pos.x - player.pos.x, dz = b.pos.z - player.pos.z;
        const ang = Math.atan2(dx * cos - dz * sin, -dx * sin - dz * cos); // 0 = straight ahead, + = to the right
        const p = pips[n++];
        p.style.transform = `translate(${Math.sin(ang) * RADIUS}px, ${-Math.cos(ang) * RADIUS}px)`;
        p.style.setProperty('--f', (aw * 100).toFixed(0)); p.style.setProperty('--c', COLORS[st] || COLORS.unaware);
        p.hidden = false;
      }
      for (let i = n; i < MAX; i++) pips[i].hidden = true;
      status.hidden = !inRaid;
      if (inRaid) {
        status.textContent = worst === 'alert' ? 'Detected' : worst === 'suspicious' ? 'Suspicious' : top > 0.04 ? 'Being noticed' : 'Hidden';
        status.style.color = worst === 'alert' ? COLORS.alert : worst === 'suspicious' ? COLORS.suspicious : top > 0.04 ? '#fff' : 'rgba(255,255,255,.55)';
      }
    },
  };
}
