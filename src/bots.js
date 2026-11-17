import * as THREE from 'three';
import { CONFIG, rand } from './bots/config.js';
import { Nav } from './bots/nav.js';
import { Bot } from './bots/bot.js';

// =============================================================================
// Bots system. Contract: init(ctx) -> { update(dt) }   (see core.js)
//
//   src/bots/config.js   every tuning knob (exposed live as ctx.bots.config)
//   src/bots/nav.js      layered grid navigation built from world.colliders, time-sliced A*
//   src/bots/physics.js  bot body sweep (same rules as the player controller)
//   src/bots/body.js     the android mesh + procedural animation
//   src/bots/bot.js      one bot: movement, senses, state machine, aim, fire
//
// ctx.bots = { list, setCount(n), config, nav, pois, stats, alertAll(pos) }
// Events emitted: shot, impact, botSpawned, botDied, botDamaged, guardSuspicious, guardAlert.
// Team mode (config.ffa = false): each bot exposes role, post, awareness, alertState, lastSeenPlayerT.
// =============================================================================

export function init(ctx) {
  const cfg = CONFIG, world = ctx.world, events = ctx.events;
  const t0 = performance.now();
  const nav = new Nav(world, cfg.nav);
  const buildMs = performance.now() - t0;

  const mgr = {
    ctx, cfg, nav, bots: [], attackers: new Set(), time: 0,
    stats: { navBuildMs: buildMs, updateMs: 0, avgMs: 0, maxMs: 0, frames: 0, rays: 0, shots: 0, hits: 0 },
    pois: [], stuckLog: [],
    someoneWaiting(self) { for (const b of mgr.bots) if (b !== self && b.alive && !b.hasToken && mgr.time - b.wantTokenT < 0.6) return true; return false; },
    callOut(bot, pos) {
      for (const o of mgr.bots) {
        if (o === bot || !o.alive || o.state === 'combat') continue;
        if (o.pos.distanceTo(bot.pos) < cfg.alertRadius) { if (cfg.ffa) o.alert(pos, rand(0.35, 1.0)); else o.hear(pos, cfg.hearAwareness.callOut, 'shot', cfg.suspiciousAt + 0.1); } // nearby allies only, and only suspicious
      }
    },
    pickPoi(bot) {
      let best = null, bs = -1;
      for (const p of mgr.pois) {
        if (p.claimedBy && p.claimedBy !== bot && p.claimedBy.alive) continue;
        const d = Math.hypot((p.x0 + p.x1) / 2 - bot.pos.x, (p.z0 + p.z1) / 2 - bot.pos.z);
        const s = (mgr.time - p.lastVisit + 20) * p.weight * (0.4 + Math.random()) / (1 + d * 0.012) / (1 + p.fails * 0.5);
        if (s > bs) { bs = s; best = p; }
      }
      if (!best) return null;
      const id = nav.randomNode(best.x0, best.x1, best.z0, best.z1, best.y0, best.y1, 30);
      if (id < 0) { best.fails++; best.lastVisit = mgr.time; return null; }
      best.claimedBy = bot; best.lastVisit = mgr.time;
      return { poi: best, id };
    },
    poiVisited(p, bot) { p.visits++; p.fails = 0; p.lastVisit = mgr.time; if (p.claimedBy === bot) p.claimedBy = null; },
  };

  // ---- points of interest: every floor and roof of every building, the plaza, a ring of ground areas
  const poi = (name, x0, x1, z0, z1, y0, y1, weight = 1) => mgr.pois.push({ name, x0, x1, z0, z1, y0, y1, weight, lastVisit: -rand(0, 60), visits: 0, fails: 0, claimedBy: null });
  world.buildings.forEach((b, i) => {
    const m = b.wallThickness + 0.8;
    for (let f = 0; f <= b.floors; f++) {
      const y = f * b.floorHeight;
      poi(`building${i}:${f === b.floors ? 'roof' : 'floor' + f}`, b.x - b.w / 2 + m, b.x + b.w / 2 - m, b.z - b.d / 2 + m, b.z + b.d / 2 - m, y - 0.25, y + 0.35, f === 0 ? 0.8 : 1.15);
    }
  });
  poi('plaza', -6, 6, -6, 6, 0.8, 1.2, 1);
  const A = world.arenaHalf - 4;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const s = (A * 2) / 3; poi(`ground${i}${j}`, -A + i * s + 3, -A + (i + 1) * s - 3, -A + j * s + 3, -A + (j + 1) * s - 3, -0.2, 0.4, 0.7);
  }

  // ---- spawning -----------------------------------------------------------
  const eye = new THREE.Vector3(), pt = new THREE.Vector3();
  function findSpawn() {
    const H = world.arenaHalf - 4;
    const others = ctx.targets.filter((t) => t.alive && t.pos); // every living combatant (player and bots)
    let fallback = null, fbD = -1;
    for (let t = 0; t < 70; t++) {
      const id = nav.randomNode(-H, H, -H, H, -0.2, t < 45 ? 0.4 : 30, 6);
      if (id < 0) continue;
      nav.nodePos(id, pt);
      const relax = t < 30 ? 1 : t < 55 ? 0.65 : 0.3;
      let minD = 1e9; for (const o of others) { const d = Math.hypot(pt.x - o.pos.x, pt.z - o.pos.z); if (d < minD) minD = d; }
      if (minD > fbD && minD > 2.5) { fbD = minD; fallback = pt.clone(); }
      if (minD < (cfg.ffa ? cfg.spawnSeparation * 1.6 : cfg.spawnSeparation) * relax) continue;
      const pl = ctx.player;
      if (Math.hypot(pt.x - pl.pos.x, pt.z - pl.pos.z) < cfg.spawnMinDist * relax) continue;
      if (!cfg.ffa && Math.hypot(pt.x - world.spawn.x, pt.z - world.spawn.z) < cfg.spawnMinDist * relax * 0.8) continue;
      if (t < 50) { // out of sight of the nearest few combatants
        pt.y += 1.5; let seen = false, n = 0;
        for (const o of others) {
          if ((!cfg.ffa && o !== pl) || Math.hypot(pt.x - o.pos.x, pt.z - o.pos.z) > 60) continue;
          eye.set(o.pos.x, o.pos.y + 1.6, o.pos.z); if (world.lineOfSight(eye, pt)) { seen = true; break; }
          if (++n >= 6) break;
        }
        pt.y -= 1.5;
        if (seen) continue;
      }
      return pt.clone();
    }
    return fallback;
  }

  // roles: keep the passive share of the LIVING guards at config.passiveShare
  // enemy type: weighted roll among the kinds that are not at their cap; a kind may force the role
  function assignKind(bot) {
    const kinds = cfg.kinds || {};
    if (cfg.ffa || !kinds.grunt) { bot.setKind('grunt'); return; }
    const alive = {}; for (const b of mgr.bots) if (b !== bot && b.alive) alive[b.kind] = (alive[b.kind] || 0) + 1;
    const open = Object.keys(kinds).filter((k) => !(kinds[k].max && (alive[k] || 0) >= kinds[k].max));
    let total = 0; for (const k of open) total += kinds[k].weight || 1;
    let r = Math.random() * total, pickK = 'grunt';
    for (const k of open) { r -= kinds[k].weight || 1; if (r <= 0) { pickK = k; break; } }
    bot.setKind(pickK);
    if (kinds[pickK].role) bot.role = kinds[pickK].role;
  }
  function assignRole(bot) {
    if (cfg.ffa) { bot.role = 'active'; return; }
    let n = 0, p = 0; for (const b of mgr.bots) if (b !== bot && b.alive) { n++; if (b.role === 'passive') p++; }
    bot.role = (p + 1) / (n + 1) <= cfg.passiveShare + 1e-6 ? 'passive' : 'active';
  }
  // a post for a passive guard: a spot in / on a building, away from and unseen by the player
  function findPost() {
    const pl = ctx.player, posts = mgr.pois.filter((q) => q.name.startsWith('building'));
    for (let t = 0; t < 40; t++) {
      const q = posts[Math.random() * posts.length | 0]; if (!q) break;
      const id = nav.randomNode(q.x0, q.x1, q.z0, q.z1, q.y0, q.y1, 6); if (id < 0) continue;
      nav.nodePos(id, pt);
      if (pt.distanceTo(pl.pos) < cfg.spawnMinDist * (t < 25 ? 1 : 0.6)) continue;
      let ok = true; for (const b of mgr.bots) if (b.alive && (b.pos.distanceTo(pt) < cfg.spawnSeparation || (b.role === 'passive' && b.post.distanceTo(pt) < cfg.passiveLoopRadius * 2))) { ok = false; break; }
      if (!ok) continue;
      eye.set(pl.pos.x, pl.pos.y + 1.6, pl.pos.z); pt.y += 1.5; const seen = world.lineOfSight(eye, pt); pt.y -= 1.5;
      if (seen && t < 30) continue;
      return pt.clone();
    }
    return null;
  }

  function setCount(n) {
    n = Math.max(0, Math.min(32, n | 0)); cfg.count = n;
    while (mgr.bots.length > n) {
      const b = mgr.bots.pop(); b.dispose();
      const i = ctx.targets.indexOf(b); if (i >= 0) ctx.targets.splice(i, 1);
    }
    while (mgr.bots.length < n) {
      const b = new Bot(mgr); b.spawnT = mgr.bots.length * 0.15;
      mgr.bots.push(b); ctx.targets.push(b);
    }
  }

  // ---- hearing ------------------------------------------------------------
  const isPlayer = (o) => o && (o === ctx.player || o.team === 'player');
  const isFoe = (o) => (cfg.ffa ? !!o : isPlayer(o));
  const hearAll = (pos, dist, at = pos, by = null) => { for (const b of mgr.bots) if (b !== by && b.alive && b.state !== 'combat' && b.pos.distanceTo(pos) < dist) b.alert(at, rand(0.25, 0.7)); };
  const guards = (fn) => { for (const b of mgr.bots) if (b.alive) fn(b); };
  const he = new THREE.Vector3(), hp2 = new THREE.Vector3();
  // gunshot-like noise at `pos` (team mode): range halves without line of sight (one cached ray per guard)
  function heardShot(b, pos, range) {
    const d = b.pos.distanceTo(pos); if (d > range) return false;
    if (d <= range * cfg.hearNoLosMult) return true;
    if (mgr.time - b.hearLosT > 0.5) { b.hearLosT = mgr.time; he.set(b.pos.x, b.pos.y + 1.6, b.pos.z); hp2.set(pos.x, pos.y, pos.z); b.hearLos = world.lineOfSight(he, hp2); mgr.stats.rays++; }
    return b.hearLos;
  }
  events.on('shot', (e) => {
    if (!e.origin) return;
    if (cfg.ffa) { if (e.by) hearAll(e.origin, cfg.hearShotDist, e.origin, e.by); return; }
    const A = cfg.hearAwareness;
    if (isPlayer(e.by)) { const r = cfg.hearShotDist * (e.suppressed ? cfg.suppressedHearMult : 1); guards((b) => { if (heardShot(b, e.origin, r)) b.hear(e.origin, A.shot, 'shot', cfg.suspiciousAt + 0.1); }); }
    else if (e.by && e.by.isBot) guards((b) => { if (b !== e.by && b.state !== 'combat' && b.pos.distanceTo(e.origin) < cfg.hearAllyShotDist) b.hear(e.origin, A.allyShot, 'shot', cfg.suspiciousAt + 0.05); });
  });
  events.on('impact', (e) => {
    if (!e.point || e.kind !== 'world') return;
    if (cfg.ffa) { if (e.by) hearAll(e.point, cfg.hearImpactDist, e.by.pos || e.point, e.by); return; }
    if (!isPlayer(e.by)) return;
    guards((b) => { if (b.pos.distanceTo(e.point) < cfg.hearImpactDist) { // rounds landing close: look back along the line of fire, not at the shooter's exact spot
      hp2.copy(e.by.pos).sub(e.point); const l = hp2.length() || 1; hp2.multiplyScalar(Math.min(l, 12) / l).add(e.point);
      b.hear(hp2, cfg.hearAwareness.impact, 'shot', cfg.suspiciousAt + 0.1);
    } });
  });
  events.on('explosion', (e) => {
    if (!e.point) return;
    if (cfg.ffa) { hearAll(e.point, cfg.hearShotDist * 0.8, e.by && e.by.pos ? e.by.pos : e.point, e.by); return; }
    guards((b) => { if (heardShot(b, e.point, cfg.hearExplosionDist)) b.hear(e.point, cfg.hearAwareness.explosion, 'shot', cfg.suspiciousAt + 0.1); });
  });
  events.on('footstep', (e) => {
    const pl = ctx.player, sp = e.speed || 0;
    if (cfg.ffa) { if (sp > 6.5) hearAll(pl.pos, cfg.hearStepDist); return; }
    if (pl.crouching) return; // crouch-walking is silent
    const sprint = sp > 6.5, r = sprint ? cfg.hearStepDist : cfg.hearWalkDist;
    guards((b) => { if (b.pos.distanceTo(pl.pos) < r) b.hear(pl.pos, sprint ? cfg.hearAwareness.sprint : cfg.hearAwareness.walk, 'noise'); });
  });
  events.on('land', (e) => {
    const pl = ctx.player; if ((e.speed || 0) <= 9) return;
    if (cfg.ffa) { hearAll(pl.pos, cfg.hearStepDist * 1.3); return; }
    guards((b) => { if (b.pos.distanceTo(pl.pos) < cfg.hearStepDist) b.hear(pl.pos, cfg.hearAwareness.sprint, 'noise'); });
  });
  events.on('pieceDestroyed', (e) => { if (e.collider) nav.colliderRemoved(e.collider); });
  events.on('playerRespawned', () => { for (const b of mgr.bots) b.forget(ctx.player); });

  ctx.bots = {
    list: mgr.bots, setCount, config: cfg, nav, pois: mgr.pois, stats: mgr.stats, stuckLog: mgr.stuckLog,
    alertAll(pos) { for (const b of mgr.bots) if (b.alive) b.alert(pos, rand(0.2, 0.8), true); },
    respawnAll() { for (const b of mgr.bots) { if (b.alive) { b.alive = false; b.releaseToken(); b.clearPath(); b.mesh.hide(); } b.pendingSpawn = true; b.spawnT = 0; } },
  };
  setCount(cfg.count);

  function update(dt) {
    if (!(dt > 0)) return;
    const t = performance.now();
    mgr.time += dt; mgr.rayBudget = cfg.maxRaysPerFrame;
    nav.update(dt);
    const tNav = performance.now() - t;
    if (mgr.bots.length !== cfg.count) setCount(cfg.count);

    for (const b of mgr.bots) {
      if (!b.alive) {
        if (b.pendingSpawn) { b.spawnT -= dt; if (b.spawnT <= 0) { assignRole(b); assignKind(b); const p = (b.role === 'passive' && findPost()) || findSpawn(); if (p) b.spawn(p); else b.spawnT = 0.5; } }
        else if (b.deadT >= cfg.respawnDelay) { b.mesh.hide(); b.pendingSpawn = true; b.spawnT = 0; }
      }
    }
    // keep bodies from stacking: soft push between bots, and away from the player
    const list = mgr.bots, pl = ctx.player;
    for (let i = 0; i < list.length; i++) {
      const a = list[i]; if (!a.alive) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]; if (!b.alive) continue;
        const dx = a.pos.x - b.pos.x, dz = a.pos.z - b.pos.z, d2 = dx * dx + dz * dz;
        if (d2 < 1.0 && Math.abs(a.pos.y - b.pos.y) < 1.8) {
          const d = Math.sqrt(d2) || 0.01, k = (1 - d) / d;
          const ox = d2 < 1e-4 ? 1 : dx * k, oz = d2 < 1e-4 ? 0 : dz * k;
          a.sepX += ox; a.sepZ += oz; b.sepX -= ox; b.sepZ -= oz;
        }
      }
      const dx = a.pos.x - pl.pos.x, dz = a.pos.z - pl.pos.z, d2 = dx * dx + dz * dz;
      if (d2 < 0.81 && d2 > 1e-4 && Math.abs(a.pos.y - pl.pos.y) < 1.8) { const d = Math.sqrt(d2), k = (0.9 - d) / d * 1.5; a.sepX += dx * k; a.sepZ += dz * k; }
    }
    if (cfg.debug) {
      for (const b of mgr.bots) { const tb = performance.now(); b.update(dt); const d = performance.now() - tb; if (d > 3) mgr.stuckLog.push(['SLOW bot', b.name, b.state, d.toFixed(1), 'frame', mgr.stats.frames]); }
      if (tNav > 3) mgr.stuckLog.push(['SLOW nav', tNav.toFixed(1), 'frame', mgr.stats.frames, 'active', !!nav.active, 'q', nav.queue.length]);
    } else for (const b of mgr.bots) b.update(dt);

    const ms = performance.now() - t, s = mgr.stats;
    s.updateMs = ms; s.frames++; s.avgMs += (ms - s.avgMs) / Math.min(s.frames, 600); if (ms > s.maxMs) s.maxMs = ms;
  }

  return { update };
}
