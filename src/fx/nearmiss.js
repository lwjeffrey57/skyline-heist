// How close does a round fired by someone else pass the listener's head? Shared by fx (suppression overlay)
// and audio (snap / fly-by) so both agree on what counts as a near miss.
//   e   a `shot` event { origin, muzzle, dir, end? }      cp  camera position      out  receives the closest point
// Returns the miss distance in metres, or -1 when the round is not a near miss candidate: fired from closer
// than 4 m, travelling away, stopped by the world (or its target) before reaching the listener, or a direct hit.
export const NEAR_MISS = 3.2;
export function nearMiss(e, cp, world, out) {
  const o = e.origin || e.muzzle, d = e.dir;
  if (!o || !d) return -1;
  const t = (cp.x - o.x) * d.x + (cp.y - o.y) * d.y + (cp.z - o.z) * d.z;
  if (t <= 4) return -1;
  out.set(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
  const miss = Math.hypot(out.x - cp.x, out.y - cp.y, out.z - cp.z);
  if (miss >= NEAR_MISS || miss < 0.25) return -1;
  if (e.end) { const ex = e.end.x - o.x, ey = e.end.y - o.y, ez = e.end.z - o.z; if (ex * ex + ey * ey + ez * ez < t * t) return -1; }
  else if (world.raycast(o, d, t)) return -1;
  return miss;
}
