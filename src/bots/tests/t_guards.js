// Guard detection (team mode, inside a raid): roles, awareness, hearing, engage range.
(async () => {
  const g = window.__game, ctx = g.ctx, B = ctx.bots, pl = g.player, cfg = B.config, ev = ctx.events, world = g.world, nav = B.nav, V = g.THREE.Vector3, fail = [], out = {};
  const dt = 1 / 60;
  ctx.raid.deploy();
  const keep = () => { pl.protectT = 999; pl.hp = 100; if (ctx.raid) ctx.raid.timeLeft = 400; };
  const sky = () => { pl.pos.set(0, 250, 0); pl.vel.set(0, 0, 0); keep(); };
  // (e) every guard shot: distance to what it is shooting at
  let shots = 0, maxShotDist = 0; const evs = { guardSuspicious: 0, guardAlert: 0 };
  ev.on('shot', (e) => { if (e.by && e.by.isBot) { shots++; const t = e.by.visible && e.by.target ? e.by.target.pos : e.by.lastSeen; const d = e.by.pos.distanceTo(t); if (d > maxShotDist) maxShotDist = d; } });
  ev.on('guardSuspicious', () => evs.guardSuspicious++); ev.on('guardAlert', () => evs.guardAlert++);
  for (let f = 0; f < 240; f++) { sky(); g.step(dt); }
  const roles = () => { const a = B.list.filter((b) => b.alive); return [a.filter((b) => b.role === 'passive').length, a.filter((b) => b.role === 'active').length]; };

  // ---- (a) hidden and silent for 3 minutes
  let alerts = 0, maxAw = 0, maxPostDist = 0, sus = 0; const moved = new Map(B.list.map((b) => [b, 0])), last = new Map(B.list.map((b) => [b, b.pos.clone()]));
  out.rolesAtStart = roles();
  for (let f = 0; f < 180 * 60; f++) {
    sky(); g.step(dt);
    for (const b of B.list) { if (!b.alive) continue;
      if (b.alertState === 'alert') alerts++; if (b.alertState === 'suspicious') sus++; if (b.awareness > maxAw) maxAw = b.awareness;
      if (b.role === 'passive') { const d = Math.hypot(b.pos.x - b.post.x, b.pos.z - b.post.z); if (d > maxPostDist) maxPostDist = d; }
      if (f % 60 === 0) { moved.set(b, moved.get(b) + last.get(b).distanceTo(b.pos)); last.get(b).copy(b.pos); } }
    if (f % 1200 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  out.a = { alertFrames: alerts, suspiciousFrames: sus, maxAwareness: +maxAw.toFixed(2), passiveMaxDistFromPost: +maxPostDist.toFixed(1), loopRadius: cfg.passiveLoopRadius,
    travelled: B.list.map((b) => b.role[0] + ':' + Math.round(moved.get(b))), shots };
  if (alerts || sus) fail.push('(a) guard became aware of a hidden, silent player'); if (maxPostDist > cfg.passiveLoopRadius + 1) fail.push('(a) passive guard left its loop');
  if (shots) fail.push('(a) shots fired');

  // ---- (b) role split through kills and respawns
  const rd = cfg.respawnDelay; cfg.respawnDelay = 3; const splits = [roles().join('/')];
  for (let round = 0; round < 5; round++) {
    const alive = B.list.filter((b) => b.alive), k = 1 + (round % 3);
    for (let i = 0; i < k; i++) { const v = alive.splice(Math.random() * alive.length | 0, 1)[0]; v.takeDamage(1000, {}); }
    for (let f = 0; f < 6 * 60; f++) { sky(); g.step(dt); }
    const r = roles(); splits.push(r.join('/')); if (r[0] !== r[1] || r[0] + r[1] !== B.list.length) fail.push('(b) split ' + r.join('/'));
  }
  cfg.respawnDelay = rd; out.b = { splits };

  // ---- (c) sight: one guard held in place on a clear lane
  B.setCount(1); for (let f = 0; f < 30; f++) { sky(); g.step(dt); }
  const b = B.list[0], a = new V(), c = new V();
  const lane = (d) => { for (let t = 0; t < 6000; t++) {
    const id = nav.randomNode(-64, 64, -64, 64, -0.1, 0.1, 4); if (id < 0) continue;
    const P = nav.nodePos(id, new V()), ang = Math.random() * 6.283, Q = P.clone().add(new V(Math.sin(ang) * d, 0, Math.cos(ang) * d));
    if (Math.abs(Q.x) > 66 || Math.abs(Q.z) > 66 || nav.nodeAt(Q.x, 0, Q.z, 0.1) < 0) continue;
    let ok = true; for (const h of [0.2, 1.0, 1.7]) { a.set(Q.x, 1.62, Q.z); c.set(P.x, h, P.z); if (!world.lineOfSight(a, c)) ok = false; }
    if (ok) return { P, Q }; } return null; };
  const hold = (L, role) => { b.role = role; b.pos.copy(L.Q); b.post.copy(L.Q); b.vel.set(0, 0, 0); b.clearPath(); b.state = 'patrol'; b.waitT = 1e9; b.awareness = 0; b.susActed = false; b.target = null; b.visible = false; b.lastCombatT = -99; b.releaseToken();
    b.aimYaw = b.bodyYaw = Math.atan2(L.P.x - L.Q.x, L.P.z - L.Q.z); b.scanBase = b.aimYaw; };
  const trial = (L, role, crouch, secs) => {
    hold(L, role); const s0 = shots; let tSus = null, tAlert = null, tShot = null, aw = 0;
    if (crouch) g.input.keys.add('KeyC'); else g.input.keys.delete('KeyC');
    for (let f = 0; f < secs * 60; f++) {
      pl.pos.copy(L.P); pl.vel.set(0, 0, 0); keep(); b.hp = b.maxHp; if (b.state === 'patrol') { b.scanPhase = -b.t * 0.75; b.waitT = 1e9; }
      g.step(dt); const t = (f + 1) * dt; if (b.awareness > aw) aw = b.awareness;
      if (tSus === null && b.alertState !== 'unaware') tSus = t; if (tAlert === null && b.alertState === 'alert') tAlert = t; if (tShot === null && shots > s0) tShot = t;
      if (tShot !== null && t > tShot + 1) break;
    }
    g.input.keys.delete('KeyC'); for (let f = 0; f < 40; f++) { sky(); g.step(dt); } b.forget(pl);
    return { suspiciousAt: tSus && +tSus.toFixed(2), alertAt: tAlert && +tAlert.toFixed(2), firstShotAt: tShot && +tShot.toFixed(2), maxAwareness: +aw.toFixed(2), shots: shots - s0 };
  };
  const L60 = lane(60), L30 = lane(30), L40 = lane(40);
  out.c = {};
  if (L60) { out.c.at60 = trial(L60, 'active', false, 40); if (out.c.at60.shots || out.c.at60.alertAt) fail.push('(c) engaged at 60 m'); } else out.c.at60 = 'no lane';
  if (L30) { const s = trial(L30, 'active', false, 40), cr = trial(L30, 'active', true, 60); out.c.at30standing = s; out.c.at30crouched = cr; out.c.crouchRatio = +(cr.alertAt / s.alertAt).toFixed(2);
    if (!s.firstShotAt) fail.push('(c) no engagement at 30 m'); if (!(cr.alertAt > s.alertAt * 1.5)) fail.push('(c) crouch not slower'); } else out.c.at30 = 'no lane';
  if (L40) { out.c.passiveAt40 = trial(L40, 'passive', false, 30); if (out.c.passiveAt40.alertAt) fail.push('(c) passive noticed beyond its sight range'); }

  // ---- (d) hearing: passive guard, shots 29 m away without line of sight; then 80 m away
  const spot = (from, d, wantLos) => { for (let t = 0; t < 4000; t++) { const ang = Math.random() * 6.283, x = from.x + Math.sin(ang) * d, z = from.z + Math.cos(ang) * d; if (Math.abs(x) > 66 || Math.abs(z) > 66) continue;
    if (nav.nodeAt(x, 0, z, 0.1) < 0 || nav.reach[nav.nodeAt(x, 0, z, 0.1)] === 0) continue; a.set(from.x, from.y + 1.6, from.z); c.set(x, 1.4, z); if (world.lineOfSight(a, c) === wantLos) return new V(x, 0, z); } return null; };
  let post = null; for (let t = 0; t < 200 && !post; t++) { const q = B.pois.filter((p) => p.name.includes('floor0'))[t % 11]; const id = q ? nav.randomNode(q.x0, q.x1, q.z0, q.z1, q.y0, q.y1, 8) : -1; if (id >= 0) { const p = nav.nodePos(id, new V()); if (Math.abs(p.x) < 30 && Math.abs(p.z) < 30) post = p; } }
  out.d = {};
  const hearTrial = (d, secs) => {
    hold({ Q: post, P: post.clone().add(new V(1, 0, 0)) }, 'passive'); b.waitT = 3;
    for (let f = 0; f < 60; f++) { sky(); g.step(dt); }
    const src = spot(b.pos, d, false); if (!src) return 'no spot';
    const d0 = b.pos.distanceTo(src); let closest = d0, tSus = null, state = b.state;
    for (let f = 0; f < secs * 60; f++) {
      sky(); if (f < 30 && f % 5 === 0) ev.emit('shot', { weapon: 'rifle', origin: new V(src.x, 1.5, src.z), dir: new V(0, 0, 1), muzzle: src.clone(), by: pl });
      pl.protectT = 999; g.step(dt); const dd = b.pos.distanceTo(src); if (dd < closest) closest = dd; if (tSus === null && b.alertState !== 'unaware') tSus = (f + 1) * dt; if (f === 60) state = b.state + '/' + b.investMode;
    }
    const r = { startDist: +d0.toFixed(1), suspiciousAfter: tSus && +tSus.toFixed(2), stateAt1s: state, closestApproach: +closest.toFixed(1), awareness: +b.awareness.toFixed(2) };
    for (let f = 0; f < 30; f++) { sky(); g.step(dt); } b.forget(pl); b.state = 'patrol'; b.clearPath(); return r;
  };
  if (post) {
    out.d.shots29mNoLos = hearTrial(29, 30); out.d.shots80m = hearTrial(80, 8);
    const n = out.d.shots29mNoLos, far = out.d.shots80m;
    if (typeof n === 'object' && !(n.suspiciousAfter !== null && n.closestApproach < 8)) fail.push('(d) did not investigate shots at 29 m');
    if (typeof far === 'object' && (far.suspiciousAfter !== null || far.awareness > 0)) fail.push('(d) reacted to shots 80 m away');
  } else out.d = 'no post found';

  // ---- (e) two minutes of real fighting: player exposed on the ground, shielded; nobody may fire from beyond engageRange
  B.setCount(6); const s1 = shots; for (let f = 0; f < 60; f++) { sky(); g.step(dt); }
  let alertSeen = 0;
  for (let f = 0; f < 120 * 60; f++) { pl.pos.set(4, 0, 30); pl.vel.set(0, 0, 0); keep(); if (f % 240 === 0) ev.emit('shot', { weapon: 'rifle', origin: new V(4, 1.5, 30), dir: new V(0, 0, 1), muzzle: new V(4, 1.5, 30), by: pl }); pl.protectT = 999;
    g.step(dt); if (f % 60 === 0) alertSeen = Math.max(alertSeen, B.list.filter((x) => x.alive && x.alertState === 'alert').length); if (f % 1200 === 0) await new Promise((r) => setTimeout(r, 0)); }
  out.e = { shotsInFight: shots - s1, maxShotDistance: +maxShotDist.toFixed(1), engageRange: cfg.engageRange, maxGuardsAlertAtOnce: alertSeen, events: evs,
    hud: B.list.map((x) => [x.name, x.role, x.alertState, +x.awareness.toFixed(2), +Math.min(999, x.lastSeenPlayerT).toFixed(1)].join(' ')) };
  if (maxShotDist > cfg.engageRange + 0.5) fail.push('(e) shot fired beyond engageRange'); if (shots - s1 === 0) fail.push('(e) nobody engaged an exposed, firing player');
  out.fail = fail; return out;
})()
