// Guards react to being shot: the hit shoves them, breaks off the burst they were firing and holds their fire for a
// moment. Headshots and heavy rounds stagger them for longer.

export function init(ctx) {
  const { player, events } = ctx;
  events.on('impact', (e) => {
    const t = e.target;
    if (e.kind !== 'flesh' || e.by !== player || !t || !t.isBot || !t.alive) return;
    const dx = t.pos.x - player.pos.x, dz = t.pos.z - player.pos.z, d = Math.hypot(dx, dz) || 1;
    const push = Math.min(4.5, (e.damage || 0) * 0.07) * (t.kind === 'heavy' ? 0.4 : 1); // heavies barely move
    if (t.vel) { t.vel.x += (dx / d) * push; t.vel.z += (dz / d) * push; }
    const hold = (e.headshot ? 0.75 : 0.4) * (t.kind === 'heavy' ? 0.5 : 1);
    t.burstLeft = 0; t.pauseT = Math.max(t.pauseT || 0, hold);
    t.staggerT = hold;
  });
  return {};
}
