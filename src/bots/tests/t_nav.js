// nav sanity: build time, node counts, reachability of every building level, pad links, sample path timings
(async () => {
  const g = window.__game, ctx = g.ctx, nav = ctx.bots.nav, out = {};
  out.navBuildMs = +ctx.bots.stats.navBuildMs.toFixed(1);
  let nodes = 0, reach = 0; for (let c = 0; c < nav.N * nav.N; c++) for (let k = 0; k < nav.cnt[c]; k++) { nodes++; if (nav.reach[c * nav.L + k]) reach++; }
  out.nodes = nodes; out.reach = reach; out.colliders = g.world.colliders.length;
  out.pois = ctx.bots.pois.map((p) => { const id = nav.randomNode(p.x0, p.x1, p.z0, p.z1, p.y0, p.y1, 60); return p.name + ':' + (id >= 0 ? 'ok' : 'NONE'); }).filter((s) => s.endsWith('NONE'));
  out.pads = nav.padLinks.map((l) => ({ to: l.to >= 0, land: l.land.toArray().map((v) => +v.toFixed(1)), t: +l.time.toFixed(2) }));
  // path from the player spawn to the roof of each building
  const V = g.THREE.Vector3, res = [];
  for (const b of g.world.buildings) {
    const goal = nav.randomNode(b.x - 3, b.x + 3, b.z - b.d / 2 + 1.5, b.z + b.d / 2 - 1.5, b.roofY - 0.2, b.roofY + 0.3, 200);
    if (goal < 0) { res.push('no roof node'); continue; }
    const to = nav.nodePos(goal, new V());
    const t0 = performance.now(); let pts = 'pending';
    const e0 = nav.stats.expansions;
    nav.requestPath(new V(0, 0, 50), to, (p) => { pts = p; }, { goalId: goal });
    let frames = 0; while (pts === 'pending' && frames < 500) { nav.update(1 / 60); frames++; }
    res.push({ roofY: b.roofY, len: pts ? pts.length : null, frames, ms: +(performance.now() - t0).toFixed(1), exp: nav.stats.expansions - e0, pad: pts ? pts.some((p) => p.pad) : null });
  }
  out.roofPaths = res;
  return out;
})()
