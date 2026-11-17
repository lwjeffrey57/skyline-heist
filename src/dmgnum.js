import * as THREE from 'three';

// Floating damage numbers: every hit you land shows what it did. Pellets and rapid hits on the same target in one
// frame are added together; headshots are gold, killing blows are larger.

const POOL = 14, LIFE = 0.7;

export function init(ctx) {
  const { player, camera, events } = ctx;
  const style = document.createElement('style');
  style.textContent = `
    .dn { position: fixed; left: 0; top: 0; font-size: 15px; font-weight: 700; letter-spacing: 1px; color: #fff; pointer-events: none; white-space: nowrap; will-change: transform, opacity;
      text-shadow: 0 0 4px rgba(0,0,0,.9), 0 1px 2px #000; font-variant-numeric: tabular-nums; }
    .dn.head { color: #ffd23a; }
    .dn.kill { font-size: 20px; }`;
  document.head.appendChild(style);
  const pool = Array.from({ length: POOL }, () => { const el = document.createElement('div'); el.className = 'dn'; el.hidden = true; ctx.hud.appendChild(el); return { el, t: 0, on: false, pos: new THREE.Vector3(), dx: 0 }; });
  const pending = new Map(); // target -> { dmg, head, kill, point }
  let next = 0;

  events.on('impact', (e) => {
    if (e.kind !== 'flesh' || e.by !== player || !e.target || !e.point) return;
    const p = pending.get(e.target) || { dmg: 0, head: false, kill: false, point: e.point.clone() };
    p.dmg += e.damage || 0; p.head = p.head || !!e.headshot; p.kill = p.kill || !!e.kill || e.target.alive === false;
    pending.set(e.target, p);
  });

  const v = new THREE.Vector3();
  return {
    update(dt) {
      for (const p of pending.values()) {
        const n = pool[next]; next = (next + 1) % POOL;
        n.on = true; n.t = 0; n.pos.copy(p.point); n.pos.y += 0.25; n.dx = (Math.random() - 0.5) * 40;
        n.el.textContent = Math.round(p.dmg); n.el.className = `dn${p.head ? ' head' : ''}${p.kill ? ' kill' : ''}`; n.el.hidden = false;
      }
      pending.clear();
      for (const n of pool) {
        if (!n.on) continue;
        n.t += dt; const k = n.t / LIFE;
        if (k >= 1) { n.on = false; n.el.hidden = true; continue; }
        v.copy(n.pos).project(camera);
        if (v.z > 1) { n.el.hidden = true; continue; }
        const x = (v.x * 0.5 + 0.5) * window.innerWidth + n.dx * k, y = (-v.y * 0.5 + 0.5) * window.innerHeight - 46 * k * (2 - k);
        n.el.hidden = false; n.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${(1.25 - 0.25 * Math.min(1, k * 4)).toFixed(2)})`;
        n.el.style.opacity = k < 0.6 ? '1' : String(1 - (k - 0.6) / 0.4);
      }
    },
  };
}
