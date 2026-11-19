import * as THREE from 'three';
import { Bot, RAIDER_NAMES } from './bot.js';
import { rand, randR, randI } from './config.js';

// =============================================================================
// Squads: who stands where, who walks with whom, and the rival raider crews.
//
// GUARDS are handed a slot from an ordered plan when they (re)spawn:
//   post squads   — a trio on the strongroom plaza, pairs at the armoury / watch post / other outposts, at the gates
//                   of the inner wall and at the tower blocks. They stand at their spot facing outward, look around,
//                   take a few steps, turn to a squadmate now and then. role = 'passive' (leashed to the post).
//   patrol squads — 2-man patrols that walk together between points on the roads (outer) or between the gates and the
//                   plaza (inner), and sometimes stop to talk. role = 'active'.
//   Guards beyond the plan (or taken off their post by aggression) roam and hunt alone as before (squad = null).
// RAIDERS come in squads that enter at the map edge, move together between places worth looting, stop there for a
//   while, fight whatever they meet, and leave through an exit after a few minutes.
//
// A squad = { id, type:'post'|'patrol'|'raid', faction, members[], goal (Vector3), seq, stage, ... }.
// Marching: the squad sets goal and bumps seq; each member walks there (bot.seqDone = seq on arrival) and waits.
// =============================================================================

const V = new THREE.Vector3(), V2 = new THREE.Vector3();
let SQUAD_ID = 1;

export function createSquads(mgr, hooks) {
  const { ctx, cfg, nav } = mgr, world = ctx.world, events = ctx.events, pl = ctx.player;
  const raidSquads = [], pending = [], leaving = [];
  let plan = null, flat = [], planT = 0, tickT = 0, kindT = 0;
  const kills = mgr.stats.kills = { guardByRaider: 0, raiderByGuard: 0, guardByPlayer: 0, raiderByPlayer: 0, other: 0 };
  const raidStats = mgr.stats.raiders = { entered: 0, extracted: 0, squadsDown: 0, stops: 0 };

  const nodeNear = (x, y, z, r = 10, yTol = 1.6) => nav.nearestNode(x, y, z, r, yTol, true);
  const busy = (b) => b.state !== 'patrol';

  // ---------------------------------------------------------------------------
  // the guards' plan
  // ---------------------------------------------------------------------------
  function buildPlan() {
    const posts = [], H = world.coreHalf || 70, IW = H + 3;
    const squad = (type, name) => ({ id: SQUAD_ID++, type, name, faction: 'guard', members: [], slots: [], goal: new THREE.Vector3(), seq: 0, seqT: 0, hold: false, holdUntil: 0, talk: false, at: -1, prev: -1, route: null });
    const slot = (q, x, y, z, yaw, kind = null, box = null) => { const s = { squad: q, x, y, z, yaw, kind, box, id: -1, pos: new THREE.Vector3(x, y, z), bot: null, ok: false }; q.slots.push(s); return s; };
    // strongroom / plaza: a trio around it, facing outward
    { const q = squad('post', 'strongroom'), sr = world.strongroom, y = sr ? sr.y : 1;
      for (let i = 0; i < 3; i++) { const a = 0.6 + i * Math.PI * 2 / 3; slot(q, Math.sin(a) * 7.5, y, Math.cos(a) * 7.5, a); }
      posts.push(q); }
    // a building: one guard on its outer side facing the way intruders come, one on the side facing the centre
    const bldg = (b, name) => {
      const q = squad('post', name), l = Math.hypot(b.x, b.z) || 1; let ox = b.x / l, oz = b.z / l; // outward
      if (Math.abs(ox) > Math.abs(oz)) { ox = Math.sign(ox); oz = 0; } else { oz = Math.sign(oz); ox = 0; }
      const ext = (ox ? b.w : b.d) / 2 + 2.4, lat = 2.2;
      slot(q, b.x + ox * ext - oz * lat, 0, b.z + oz * ext + ox * lat, Math.atan2(ox, oz));
      slot(q, b.x - ox * ext + oz * lat, 0, b.z - oz * ext - ox * lat, Math.atan2(-ox, -oz));
      q.b = b; return q;
    };
    const outs = world.buildings.filter((b) => b.outpost), rank = { armoury: 0, watch: 1 };
    outs.sort((a, b) => (rank[a.outpost] ?? 5) - (rank[b.outpost] ?? 5));
    const outSquads = outs.map((b) => {
      const q = bldg(b, b.outpost);
      if (b.outpost === 'armoury') q.slots[0].kind = 'heavy';
      if (b.outpost === 'watch') { // the marksman goes up on the roof (or the top floor) if there is a way up
        const m = (b.wallThickness || 0.3) + 0.8, s = q.slots[0]; s.kind = 'marksman';
        s.box = [b.x - b.w / 2 + m, b.x + b.w / 2 - m, b.z - b.d / 2 + m, b.z + b.d / 2 - m, b.floors * b.floorHeight - 0.3, b.floors * b.floorHeight + 0.4];
      }
      return q;
    });
    const gate = (gx, gz, name) => { // a pair just outside a gateway of the inner wall, either side of the road
      const q = squad('post', name), ox = Math.abs(gx) > Math.abs(gz) ? Math.sign(gx) : 0, oz = ox ? 0 : Math.sign(gz), yaw = Math.atan2(ox, oz);
      for (const s of [-1, 1]) slot(q, gx + ox * 2.6 - oz * 2.4 * s, 0, gz + oz * 2.6 + ox * 2.4 * s, yaw + s * 0.25);
      return q;
    };
    const gates = [[0, -IW], [0, IW], [-IW, 0], [IW, 0], [38, -IW], [-38, IW]];
    const gateSquads = gates.map(([x, z], i) => gate(x, z, 'gate' + i));
    const towers = world.buildings.filter((b) => b.tower && !b.hq).map((b, i) => bldg(b, 'tower' + i));
    const hqB = world.buildings.find((b) => b.hq); if (hqB) posts.push(bldg(hqB, 'hq')); // the headquarters is always held
    posts.push(outSquads[0], outSquads[1], gateSquads[0], outSquads[2], gateSquads[1], outSquads[3], outSquads[4], gateSquads[2], gateSquads[3], towers[0], towers[1], gateSquads[4], gateSquads[5], towers[2], towers[3]);
    // patrol routes
    const inner = [], outer = [];
    const pt = (list, x, z) => { const id = nodeNear(x, 0, z, 8, 1.2); if (id >= 0) { nav.nodePos(id, V); list.push({ x: V.x, y: V.y, z: V.z }); } };
    for (const [gx, gz] of gates) { const ox = Math.abs(gx) > Math.abs(gz) ? Math.sign(gx) : 0, oz = ox ? 0 : Math.sign(gz); pt(inner, gx - ox * 6, gz - oz * 6); }
    for (const [x, z] of [[17, 0], [-17, 0], [0, 17], [0, -17], [44, 44], [-44, 44], [44, -44], [-44, -44], [46, 0], [-46, 0], [0, 46], [0, -46]]) pt(inner, x, z);
    for (const [x0, x1, z0, z1] of world.roads || []) {
      const alongX = x1 - x0 > z1 - z0, a0 = Math.max(-132, alongX ? x0 : z0), a1 = Math.min(132, alongX ? x1 : z1), c = alongX ? (z0 + z1) / 2 : (x0 + x1) / 2;
      const n = Math.max(1, Math.round((a1 - a0) / 30));
      for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n, x = alongX ? a : c, z = alongX ? c : a; if (Math.abs(x) > IW + 6 || Math.abs(z) > IW + 6) pt(outer, x, z); }
    }
    if (inner.length < 3) inner.push(...outer); if (outer.length < 3) outer.push(...inner);
    const out = [];
    let np = 0;
    posts.filter(Boolean).forEach((q, i) => {
      out.push(q);
      if ((i + 1) % Math.max(1, cfg.patrolEvery) === 0 && np < 4 && inner.length >= 3) { const p = squad('patrol', 'patrol' + np); p.route = np % 2 ? outer : inner; slot(p, 0, 0, 0, 0); slot(p, 0, 0, 0, 0); out.push(p); np++; }
    });
    plan = out; flat = []; for (const q of plan) for (const s of q.slots) flat.push(s);
  }

  function resolve(s) { // find the nav node of a post slot (lazily: the nav grid may still be flooding at start-up)
    if (s.ok && s.id >= 0 && nav.reach[s.id]) return true;
    let id = -1;
    if (s.box) { id = nav.randomNode(s.box[0], s.box[1], s.box[2], s.box[3], s.box[4], s.box[5], 40); if (id < 0) id = nav.randomNode(s.box[0], s.box[1], s.box[2], s.box[3], s.box[4] - 3.6, s.box[5] - 2.5, 30); }
    if (id < 0) id = nodeNear(s.x, s.y, s.z, 10, 1.6);
    if (id < 0) id = nodeNear(s.x, s.y, s.z, 16, 3);
    s.id = id; s.ok = id >= 0;
    if (s.ok) nav.nodePos(id, s.pos);
    return s.ok;
  }

  function release(bot) {
    const s = bot.slot, q = bot.squad;
    if (s && s.bot === bot) s.bot = null;
    if (q) { const i = q.members.indexOf(bot); if (i >= 0) q.members.splice(i, 1); }
    bot.slot = null; bot.squad = null; bot.faceBot = null; bot.scanAmp = 1.05;
  }

  // how many of the first `count` slots are posts, and how many of those aggression leaves manned
  function postsAllowed() {
    let n = 0; const c = Math.min(flat.length, cfg.count);
    for (let i = 0; i < c; i++) if (flat[i].squad.type === 'post') n++;
    return Math.ceil(n * cfg.postShare * (1 - 0.75 * mgr.aggr));
  }

  // Give a guard that is about to spawn its place. Returns the slot (bot.role is set), or null = a lone roamer.
  function assignGuard(bot) {
    if (!plan) buildPlan();
    release(bot);
    const c = Math.min(flat.length, cfg.count), allow = postsAllowed();
    let rank = 0;
    for (let i = 0; i < c; i++) {
      const s = flat[i], post = s.squad.type === 'post';
      if (post && rank++ >= allow) continue;
      if (s.bot && s.bot !== bot && mgr.guards.includes(s.bot)) continue;
      if (post && !resolve(s)) continue;
      s.bot = bot; bot.slot = s; bot.squad = s.squad; s.squad.members.push(bot);
      bot.role = post ? 'passive' : 'active';
      return s;
    }
    bot.role = 'active';
    return null;
  }

  // where a guard with a slot appears: at its post / with its patrol, unless the player is near or looking
  function slotSpawn(bot) {
    const s = bot.slot; if (!s) return null;
    const q = s.squad; let p = null;
    if (q.type === 'post') p = s.pos;
    else {
      if (q.at < 0) startPatrol(q);
      const mate = q.members.find((m) => m !== bot && m.alive);
      const src = mate ? mate.pos : q.route[q.at];
      const id = nodeNear(src.x + rand(-1.5, 1.5), src.y, src.z + rand(-1.5, 1.5), 6, 1.3); if (id < 0) return null;
      p = nav.nodePos(id, V2);
    }
    const d = Math.hypot(p.x - pl.pos.x, p.z - pl.pos.z);
    if (d < cfg.spawnMinDist) return null;
    if (d < 70) { V.set(pl.pos.x, pl.pos.y + 1.6, pl.pos.z); const y = p.y; p.y += 1.5; const seen = world.lineOfSight(V, p); p.y = y; if (seen) return null; }
    for (const o of mgr.bots) if (o.alive && o.faction !== 'guard' && o.pos.distanceTo(p) < 25) return null; // not into the middle of a raider squad
    return p;
  }
  function spawned(bot) {
    const s = bot.slot; if (!s) return;
    if (s.squad.type === 'post') { bot.post.copy(s.pos); bot.aimYaw = bot.bodyYaw = bot.scanBase = s.yaw; bot.scanAmp = 0.3; bot.waitT = rand(1, 4); }
    else { bot.seqDone = -1; bot.waitT = rand(0.3, 1.2); }
    if (s.kind && mgr.time - planT > 8) wantKind(s);
  }

  // the armoury's heavy and the watch post's marksman (raid.js may also convert a guard there: never double up)
  function wantKind(s) {
    const b = s.bot; if (!b || !b.alive || b.kind === s.kind) return;
    const other = s.squad.members.find((m) => m !== b && m.alive && m.kind === s.kind);
    if (other && other.slot) { // the right type is here but on the wrong spot: swap places
      const o = other.slot; o.bot = b; s.bot = other; b.slot = o; other.slot = s; b.post.copy(o.pos); other.post.copy(s.pos); b.waitT = other.waitT = 0.2; return;
    }
    if (b.state === 'combat') return;
    const full = b.hp >= b.maxHp - 1; b.setKind(s.kind); b.maxHp = b.cfg.hp; if (full) b.hp = b.maxHp; else b.hp = Math.min(b.hp, b.maxHp); b.role = 'passive';
  }

  function startPatrol(q) { q.at = Math.random() * q.route.length | 0; q.prev = -1; const r = q.route[q.at]; q.goal.set(r.x, r.y, r.z); q.seq++; q.seqT = mgr.time; q.hold = false; }
  function nextPatrolPoint(q) {
    const R = q.route, c = R[q.at]; let best = -1, bs = -1e9;
    for (let i = 0; i < R.length; i++) {
      if (i === q.at) continue;
      const d = Math.hypot(R[i].x - c.x, R[i].z - c.z);
      let s = Math.random() * 30 - Math.abs(d - 32) * 0.9 - (i === q.prev ? 40 : 0);
      for (const o of plan) if (o !== q && o.type === 'patrol' && o.members.length && Math.hypot(R[i].x - o.goal.x, R[i].z - o.goal.z) < 25) s -= 25; // keep the patrols apart
      if (Math.hypot(R[i].x - pl.pos.x, R[i].z - pl.pos.z) < 8) s -= 10;
      if (s > bs) { bs = s; best = i; }
    }
    if (best < 0) return;
    q.prev = q.at; q.at = best; q.goal.set(R[best].x, R[best].y, R[best].z);
  }

  // ---------------------------------------------------------------------------
  // per-bot: what to do next while idle (called from Bot.think, state 'patrol', not moving, waitT <= 0)
  // ---------------------------------------------------------------------------
  function goal(bot) {
    const q = bot.squad; if (!q) return false;
    if (q.type === 'post') return postGoal(bot);
    const now = mgr.time;
    if (q.type === 'patrol' && mgr.aggr > 0.25 && now > bot.huntCdT && Math.random() < mgr.aggr * 0.5 && bot.huntGoal()) return true; // late raid: go looking for the intruder
    if (bot.seqDone !== q.seq) { // walk to where the squad is going
      const i = q.members.indexOf(bot), raid = q.type === 'raid';
      bot.faceBot = null;
      let x = q.goal.x, z = q.goal.z;
      if (i > 0 || raid) { const a = raid ? Math.random() * 6.28 : q.seq * 2.4 + i * 2.1, r = raid ? rand(1, q.spread || 3) : 1.5; x += Math.sin(a) * r; z += Math.cos(a) * r; }
      let id = nodeNear(x, q.goal.y, z, 5, 1.3); if (id < 0) id = nodeNear(q.goal.x, q.goal.y, q.goal.z, 12, 2.5);
      if (id < 0) { bot.seqDone = q.seq; bot.waitT = 1; return true; }
      nav.nodePos(id, V);
      // stragglers hurry, the one in front takes its time: the squad arrives together
      let dMin = 1e9; const dMe = bot.pos.distanceTo(q.goal);
      for (const m of q.members) if (m.alive && m !== bot) dMin = Math.min(dMin, m.pos.distanceTo(q.goal));
      const base = raid ? (q.stage === 'extract' ? bot.cfg.walkSpeed * 1.2 : bot.cfg.walkSpeed * 0.85) : bot.cfg.patrolSpeed;
      const sp = base * (dMe > dMin + 5 ? 1.35 : dMe < dMin - 5 ? 0.8 : 1);
      const seq = q.seq;
      bot.moveTo(V, sp, { goalId: id,
        onArrive: () => { if (q.seq === seq) bot.seqDone = seq; bot.failN = 0; bot.waitT = rand(0.2, 0.6); bot.scanBase = bot.aimYaw; },
        onFail: () => { bot.failN = (bot.failN || 0) + 1; if (bot.failN >= 3 && q.seq === seq) { bot.seqDone = seq; bot.failN = 0; } bot.waitT = 0.8; } });
      return true;
    }
    // at the goal, waiting for the squad's next move
    if (q.type === 'raid') {
      if (q.stage === 'extract') { leaving.push(bot); bot.waitT = 99; return true; } // reached the exit: gone at the next update
      if (q.hold && Math.random() < 0.65) { bot.lootUntil = now + rand(2.5, 5); bot.waitT = bot.lootUntil - now + rand(0.3, 1.2); bot.scanBase = bot.aimYaw + rand(-1, 1); return true; } // down on a knee, going through a crate
      if (q.hold && Math.random() < 0.5) { // shift to another spot
        const id = nav.randomNode(q.goal.x - 4, q.goal.x + 4, q.goal.z - 4, q.goal.z + 4, q.goal.y - 0.6, q.goal.y + 0.6, 6);
        if (id >= 0) { const w = () => { bot.waitT = rand(0.4, 1); bot.scanBase = bot.aimYaw; }; bot.moveTo(nav.nodePos(id, V), bot.cfg.patrolSpeed, { goalId: id, onArrive: w, onFail: w }); return true; }
      }
      bot.scanBase = bot.aimYaw + rand(-1.6, 1.6); bot.waitT = rand(1.5, 3); return true; // keep watch
    }
    const mate = q.members.find((m) => m !== bot && m.alive && !busy(m) && m.pos.distanceTo(bot.pos) < 6);
    bot.faceBot = q.talk && q.hold && mate ? mate : null;
    if (!bot.faceBot) bot.scanBase = bot.aimYaw + rand(-1.2, 1.2);
    bot.waitT = rand(1, 2);
    return true;
  }

  function postGoal(bot) {
    const s = bot.slot; if (!s || !resolve(s)) return false;
    const d = Math.hypot(bot.pos.x - s.pos.x, bot.pos.z - s.pos.z) + Math.abs(bot.pos.y - s.pos.y);
    bot.faceBot = null; bot.scanAmp = 0.3; bot.role = 'passive'; // (a posted guard that was sent hunting is back on its leash)
    const stand = () => { bot.waitT = randR(cfg.postStand); bot.scanBase = s.yaw + rand(-0.5, 0.5); };
    if (d > 1.4) { bot.moveTo(s.pos, d > 25 ? bot.cfg.walkSpeed : bot.cfg.patrolSpeed * (d > 6 ? 1 : 0.7), { goalId: s.id, onArrive: stand, onFail: () => { bot.waitT = 2; s.ok = false; } }); return true; }
    const r = Math.random();
    if (r < 0.18) { // stretch the legs: a few steps along the wall and back
      const id = nav.randomNode(s.pos.x - 3.5, s.pos.x + 3.5, s.pos.z - 3.5, s.pos.z + 3.5, s.pos.y - 0.5, s.pos.y + 0.5, 6);
      if (id >= 0) { const w = () => { bot.waitT = rand(3, 7); bot.scanBase = bot.aimYaw + rand(-0.8, 0.8); }; bot.moveTo(nav.nodePos(id, V), bot.cfg.patrolSpeed * 0.6, { goalId: id, onArrive: w, onFail: w }); return true; }
    } else if (r < 0.4) { // a word with the squadmate
      const mate = s.squad.members.find((m) => m !== bot && m.alive && !busy(m) && m.pos.distanceTo(bot.pos) < 14);
      if (mate) { bot.faceBot = mate; bot.waitT = rand(3, 6); return true; }
    } else if (r < 0.55) { bot.scanBase = s.yaw + rand(-1.6, 1.6); bot.scanAmp = 0.5; bot.waitT = rand(3, 6); return true; } // a long look to one side
    stand();
    return true;
  }

  // ---------------------------------------------------------------------------
  // raiders
  // ---------------------------------------------------------------------------
  function edgePoints() {
    const pts = (world.spawnPoints || []).concat(world.exitPoints || []);
    if (pts.length) return pts;
    const E = world.arenaHalf - 8; return [[0, E], [0, -E], [E, 0], [-E, 0], [E, E * 0.6], [-E, -E * 0.6]];
  }
  function relist() { mgr.bots.length = 0; for (const b of mgr.guards) mgr.bots.push(b); for (const b of mgr.raiders) mgr.bots.push(b); }
  function removeRaider(b) {
    let i = mgr.raiders.indexOf(b); if (i >= 0) mgr.raiders.splice(i, 1);
    i = ctx.targets.indexOf(b); if (i >= 0) ctx.targets.splice(i, 1);
    if (b.squad) { i = b.squad.members.indexOf(b); if (i >= 0) b.squad.members.splice(i, 1); }
    b.dispose(); relist();
  }

  // Send in a squad of n raiders (default: a roll of config.raiders.size). nearPos: enter at the edge point nearest
  // to it; otherwise somewhere far from the player and from the other squads. Returns the new raiders.
  function spawnRaiders(n, nearPos = null, pre = null) {
    if (cfg.ffa) return [];
    const R = cfg.raiders; n = Math.max(1, Math.min(6, (n ?? randI(R.size)) | 0));
    let best = null, bs = -1e9;
    for (const [x, z] of edgePoints()) {
      const dp = Math.hypot(x - pl.pos.x, z - pl.pos.z);
      let s = nearPos ? -Math.hypot(x - nearPos.x, z - nearPos.z) - (dp < 60 ? 500 : 0) : Math.min(dp, R.minPlayerDist * 1.5) + Math.random() * 40 - (dp < R.minPlayerDist ? 300 : 0);
      for (const q of raidSquads) s -= Math.max(0, 90 - Math.hypot(x - q.entry.x, z - q.entry.z)) * (nearPos ? 0.3 : 3);
      if (nodeNear(x, 0, z, 12, 2) < 0) continue;
      if (s > bs) { bs = s; best = [x, z]; }
    }
    if (!best) return [];
    const q = { id: SQUAD_ID++, type: 'raid', name: 'raiders' + SQUAD_ID, faction: 'raider', members: [], size: n, goal: new THREE.Vector3(), seq: 0, seqT: mgr.time, stage: 'move', hold: false, holdUntil: 0,
      leaveAt: mgr.time + randR(R.stay), entry: new THREE.Vector3(best[0], 0, best[1]), visited: [], extracted: 0, fightT: -99, spread: 3, stops: 0 };
    for (let i = 0; i < n; i++) {
      const id = nodeNear(best[0] + rand(-3, 3), 0, best[1] + rand(-3, 3), 8, 2); if (id < 0) continue;
      const b = (pre && pre.pop()) || new Bot(mgr, { faction: 'raider' });
      b.setKind('raider'); b.role = 'active'; b.squad = q;
      if (mgr.raiders.some((o) => o.name === b.name)) b.name = RAIDER_NAMES.find((nm) => !mgr.raiders.some((o) => o.name === nm)) || `Raider-${b.id}`;
      mgr.raiders.push(b); mgr.bots.push(b); ctx.targets.push(b);
      b.spawn(nav.nodePos(id, V)); b.squad = q; b.waitT = rand(0.5, 2); b.aimYaw = b.bodyYaw = b.scanBase = Math.atan2(-best[0], -best[1]);
      q.members.push(b);
    }
    if (!q.members.length) return [];
    raidSquads.push(q); raidStats.entered += q.members.length;
    nextRaidGoal(q);
    events.emit('raidersEntered', { count: q.members.length, squad: q.id, point: q.entry.clone() });
    return q.members.slice();
  }

  function clearRaiders() {
    for (const p of pending) for (const b of p.pre) b.dispose();
    pending.length = 0; leaving.length = 0;
    for (const b of mgr.raiders.slice()) { b.squad = null; removeRaider(b); }
    raidSquads.length = 0; mgr.raidAttackers.clear();
  }
  function schedule() { // raid start
    clearRaiders();
    if (cfg.ffa) return;
    const R = cfg.raiders;
    for (let i = 0; i < R.squads; i++) { // their bodies are built now, while the raid is loading, not when they walk in
      const n = randI(R.size), pre = []; for (let k = 0; k < n; k++) pre.push(new Bot(mgr, { faction: 'raider' }));
      pending.push({ t: mgr.time + randR(R.enterDelay) + i * 8, n, near: null, pre });
    }
  }

  function centroid(q, out) { out.set(0, 0, 0); let n = 0; for (const m of q.members) if (m.alive) { out.add(m.pos); n++; } return n ? out.multiplyScalar(1 / n) : out.copy(q.goal); }

  function nextRaidGoal(q) {
    const c = centroid(q, V2), cands = [];
    for (const b of world.buildings) if (b.outpost || b.tower) cands.push({ x: b.x, y: 0, z: b.z, w: 1.2, b });
    cands.push({ x: 0, y: world.strongroom ? world.strongroom.y : 1, z: 7, w: 0.9 });
    const loot = ctx.raid && ctx.raid.lootables;
    if (loot && loot.length) for (let k = 0; k < 10; k++) { const L = loot[Math.random() * loot.length | 0]; if (L && L.pos && !L.opened && L.kind !== 'bag') cands.push({ x: L.pos.x, y: L.pos.y, z: L.pos.z, w: 0.6, L }); }
    let best = null, bs = -1e9, bid = -1;
    for (const p of cands) {
      const d = Math.hypot(p.x - c.x, p.z - c.z); if (d < 14) continue;
      if (q.visited.some((v) => Math.hypot(v.x - p.x, v.z - p.z) < 18)) continue;
      if (raidSquads.some((o) => o !== q && Math.hypot(o.goal.x - p.x, o.goal.z - p.z) < 40)) continue;
      const s = p.w + Math.random() * 1.6 - d * 0.022;
      if (s > bs) { bs = s; best = p; }
    }
    if (best) {
      const b = best.b;
      if (b) { const m = (b.wallThickness || 0.3) + 1; bid = nav.randomNode(b.x - b.w / 2 + m, b.x + b.w / 2 - m, b.z - b.d / 2 + m, b.z + b.d / 2 - m, -0.3, 0.4, 20); }
      if (bid < 0) bid = nodeNear(best.x, best.y, best.z, 12, 2);
      if (bid < 0 && best.y > 0.5) bid = nodeNear(best.x, 0, best.z, 12, 2);
      q.visited.push({ x: best.x, z: best.z });
    }
    if (!best || bid < 0) { if (!best || q.visited.length > 12) return leave(q); return nextRaidGoal(q); }
    nav.nodePos(bid, q.goal); q.stage = 'move'; q.seq++; q.seqT = mgr.time; q.hold = false; q.spread = 3.5; q.lootable = best.L || null; q.building = best.b || null;
    for (const m of q.members) if (m.alive && !busy(m) && !m.moving) m.waitT = Math.min(m.waitT, rand(0, 0.6));
  }
  function leave(q) {
    let best = null, bd = 1e9; const c = centroid(q, V2);
    const exits = world.exitPoints && world.exitPoints.length ? world.exitPoints : edgePoints();
    for (const [x, z] of exits) { const d = Math.hypot(x - c.x, z - c.z) + (Math.hypot(x - pl.pos.x, z - pl.pos.z) < 30 ? 80 : 0); if (d < bd && nodeNear(x, 0, z, 12, 2) >= 0) { bd = d; best = [x, z]; } }
    if (!best) best = [q.entry.x, q.entry.z];
    const eid = nodeNear(best[0], 0, best[1], 12, 2); if (eid >= 0) nav.nodePos(eid, q.goal); else q.goal.copy(c);
    q.stage = 'extract'; q.seq++; q.seqT = mgr.time; q.hold = false; q.spread = 2;
    for (const m of q.members) if (m.alive && !busy(m)) { m.clearPath(); m.waitT = rand(0, 0.5); }
    events.emit('raidersLeaving', { squad: q.id, count: q.members.filter((m) => m.alive).length, point: q.goal.clone() });
  }
  function extract(bot) { const q = bot.squad; if (q) q.extracted++; raidStats.extracted++; bot.alive = false; bot.releaseToken(); removeRaider(bot); bot.squad = q; }

  function botDied(bot, by) {
    const k = by === pl || (by && by.team === 'player') ? 'Player' : by && by.isBot && by.faction !== bot.faction ? (by.faction === 'raider' ? 'Raider' : 'Guard') : null;
    if (k) kills[bot.faction + 'By' + k] = (kills[bot.faction + 'By' + k] || 0) + 1; else kills.other++;
    const q = bot.squad;
    if (q && q.type === 'raid') { // a crew that is being shot to pieces cuts its raid short
      const alive = q.members.filter((m) => m.alive).length;
      if (alive && alive <= q.size / 2) q.leaveAt = Math.min(q.leaveAt, mgr.time + rand(15, 40));
    }
  }

  // ---------------------------------------------------------------------------
  function update(dt) {
    const now = mgr.time;
    const inRaid = ctx.raid ? ctx.raid.state === 'raid' : true;
    if ((!inRaid || cfg.ffa) && (mgr.raiders.length || pending.length || raidSquads.length)) clearRaiders();
    while (leaving.length) { const b = leaving.pop(); if (b.alive && mgr.raiders.includes(b)) extract(b); }
    for (let i = pending.length - 1; i >= 0; i--) if (now >= pending[i].t) { const p = pending[i]; pending.splice(i, 1); spawnRaiders(p.n, p.near, p.pre); for (const b of p.pre) b.dispose(); }
    for (let i = mgr.raiders.length - 1; i >= 0; i--) { const b = mgr.raiders[i]; if (!b.alive && b.deadT > cfg.raiders.bodyTime + 1) { const q = b.squad; removeRaider(b); b.squad = q; } }
    tickT -= dt; if (tickT > 0) return; tickT = 0.5;

    if (plan && !cfg.ffa) {
      for (const q of plan) {
        if (q.type !== 'patrol' || !q.members.length) continue;
        if (q.at < 0) startPatrol(q);
        let n = 0, arrived = true;
        for (const m of q.members) if (m.alive && !busy(m)) { n++; if (m.seqDone !== q.seq) arrived = false; }
        if (!n) continue;
        if (arrived && !q.hold) { q.hold = true; q.talk = n > 1 && Math.random() < cfg.talkChance; q.holdUntil = now + (q.talk ? rand(6, 12) : rand(1, 3.5)); for (const m of q.members) if (!m.moving) m.waitT = Math.min(m.waitT, 0.2); }
        if ((q.hold && now > q.holdUntil) || now - q.seqT > 110) {
          nextPatrolPoint(q); q.seq++; q.seqT = now; q.hold = false;
          for (const m of q.members) { m.faceBot = null; if (m.alive && !busy(m) && !m.moving) m.waitT = rand(0, 0.5); }
        }
      }
      kindT -= 0.5;
      if (kindT <= 0 && now - planT > 8) { kindT = 2; for (const s of flat) if (s.kind && s.bot && s.squad.type === 'post') wantKind(s); }
    }

    for (let i = raidSquads.length - 1; i >= 0; i--) {
      const q = raidSquads[i];
      let alive = 0, idle = 0, arrived = true;
      for (const m of q.members) if (m.alive) { alive++; if (busy(m)) q.fightT = now; else { idle++; if (m.seqDone !== q.seq) arrived = false; } }
      if (!alive) { // the squad is finished, one way or the other
        if (q.members.some((m) => !m.alive)) continue; // (bodies still fading)
        raidSquads.splice(i, 1);
        if (q.extracted) events.emit('raidersExtracted', { count: q.extracted, squad: q.id, point: q.goal.clone() });
        else { raidStats.squadsDown++; events.emit('raiderSquadDown', { squad: q.id, size: q.size, point: q.goal.clone() }); }
        continue;
      }
      if (q.stage === 'extract') {
        if (now - q.seqT > 150) for (const m of q.members.slice()) if (m.alive && !busy(m) && m.pos.distanceTo(pl.pos) > 50) extract(m); // could not reach the exit: slip away
        continue;
      }
      if (now > q.leaveAt && now - q.fightT > 3) { leave(q); continue; }
      if (!idle) continue;
      if (arrived && !q.hold) {
        q.hold = true; q.stage = 'loot'; q.holdUntil = now + randR(cfg.raiders.lootTime); q.stops++; raidStats.stops++;
        events.emit('raidersLooting', { squad: q.id, point: q.goal.clone(), time: q.holdUntil - now, lootable: q.lootable || null, building: q.building || null });
      }
      if ((q.hold && now > q.holdUntil && now - q.fightT > 3) || (!q.hold && now - q.seqT > 140)) nextRaidGoal(q);
    }
  }

  // aggression rose: guards whose post is no longer manned leave it and roam / hunt
  function applyAggression() {
    if (!plan) return;
    const c = Math.min(flat.length, cfg.count), allow = postsAllowed(); let rank = 0;
    for (let i = 0; i < c; i++) {
      const s = flat[i]; if (s.squad.type !== 'post') continue;
      if (rank++ < allow) continue;
      const b = s.bot; if (!b || !b.alive || b.state === 'combat') continue;
      const K = cfg.kinds && cfg.kinds[b.kind]; if (K && K.role === 'passive') continue;
      release(b); b.role = 'active'; b.waitT = Math.min(b.waitT || 0, 1);
    }
  }
  function reset() { if (!plan) buildPlan(); planT = mgr.time; for (const s of flat) { s.bot = null; s.ok = false; } for (const q of plan) { q.members.length = 0; q.at = -1; q.hold = false; } for (const b of mgr.guards) { b.slot = null; b.squad = null; } }

  return { assignGuard, slotSpawn, spawned, release, goal, spawnRaiders, clearRaiders, schedule, update, botDied, applyAggression, reset, relist, raidSquads, get plan() { if (!plan) buildPlan(); return plan; }, pending };
}
