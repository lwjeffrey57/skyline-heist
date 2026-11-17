import * as THREE from 'three';

// =============================================================================
// SHARED CONTRACT — every system (weapons, bots, destruction, fx, audio, render)
// talks to the others ONLY through `ctx` and the events below.
//
// A system module exports:   init(ctx) -> { update(dt) }      (update is optional)
//
// ctx = {
//   scene, camera, renderer,      three.js objects (camera is in the scene: parent viewmodels to it)
//   view,                         render.js API: { sun, sunDir, composer, setPostEnabled(b) }
//   world,                        see world.js bottom: colliders[], raycast, lineOfSight, overlapSphere,
//                                 removeCollider, addBox, buildings[], pads[], ziplines[], materials, arenaHalf
//   player,                       player.js: pos (feet), vel, yaw, pitch, h, hp, maxHp, alive, team:'player',
//                                 grounded, sliding, crouching, state, speedScale, fovScale, takeDamage()
//   input,                        down(code), pressed (Set, this frame only). Mouse buttons are 'Mouse0','Mouse2'
//   events,                       on(name, fn) / emit(name, data)
//   targets,                      everything that can be shot: { team, alive, pos (feet Vector3), radius,
//                                 height, takeDamage(amount, info) }. The player is in it. Bots add themselves.
//   hitscan(origin, dir, maxDist, ignore)   nearest of world or target ->
//        { type:'world', collider, point, normal, dist } | { type:'target', target, point, normal, dist, headshot } | null
//   hud,                          <div id="hud-root">: add your own DOM here, ids prefixed with your system name
//   destruction,                  { hit(collider, point, normal, damage), explode(point, radius, damage) }
//   time                          seconds since start
// }
//
// A collider (world piece) = { min, max (Vector3), mesh, tag, destructible, mat }
//   tag: ground | wall | pillar | lintel | sill | slab | stair | parapet | container | cover | prop
//
// EVENTS (emit what you cause, listen for what you need; payload fields are Vector3 unless noted)
//   shot            { weapon:string, origin, dir, muzzle, by }         a gun fired (by = shooter target)
//   impact          { point, normal, kind:'world'|'flesh', collider?, target?, damage:number, by }
//   explosion       { point, radius:number, by }
//   reload          { weapon }            weaponSwitch { weapon }         dryFire { weapon }
//   hitmarker       { headshot:boolean, kill:boolean }                    the PLAYER hit a target
//   pieceDamaged    { collider, point, normal }
//   pieceDestroyed  { collider, center, size, color:THREE.Color, cause:{point?} }   a world box was removed
//       cause = { type:'bullet'|'explosion'|'collapse'|'destroy', point, normal?, dir?, radius? }
//   pieceSplit      { collider, parts:[collider] }   a piece was replaced by smaller ones filling the same volume
//   debrisImpact    { point, speed:number, size:number, color }   a heavy debris chunk landed
//   botSpawned { bot, point } / botDied { bot, point, by, headshot } / botDamaged { bot, amount, hp, from }
//   playerDamaged { amount, hp, from? }   playerDied {}   playerRespawned {}
//   jump {}  land { speed }  footstep { speed }  slideStart {}  mantle {}  pad { x, z }  zipStart {}  zipEnd {}
// =============================================================================

export function createEvents() {
  const map = new Map();
  return {
    on(name, fn) { if (!map.has(name)) map.set(name, []); map.get(name).push(fn); },
    emit(name, data = {}) {
      const list = map.get(name); if (!list) return;
      for (const fn of list) { try { fn(data); } catch (e) { console.error(`[event ${name}]`, e); } }
    },
  };
}

const _n = [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1)];

// Ray vs axis-aligned box. Returns { t, normal } for the entry point, or null.
export function rayAABB(o, d, min, max, maxDist = Infinity) {
  let tmin = 0, tmax = maxDist, face = -1;
  const ax = ['x', 'y', 'z'];
  for (let i = 0; i < 3; i++) {
    const a = ax[i], dv = d[a], ov = o[a];
    if (Math.abs(dv) < 1e-9) { if (ov < min[a] || ov > max[a]) return null; continue; }
    let t1 = (min[a] - ov) / dv, t2 = (max[a] - ov) / dv, f = i * 2;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; f = i * 2 + 1; }
    if (t1 > tmin) { tmin = t1; face = f; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (face < 0) return null; // origin inside the box
  return { t: tmin, normal: _n[face] };
}

export function installCombat(ctx) {
  ctx.hitscan = (origin, dir, maxDist = 500, ignore = null) => {
    const w = ctx.world.raycast(origin, dir, maxDist);
    let best = w ? { type: 'world', ...w } : null;
    const min = new THREE.Vector3(), max = new THREE.Vector3();
    for (const t of ctx.targets) {
      if (t === ignore || !t.alive) continue;
      min.set(t.pos.x - t.radius, t.pos.y, t.pos.z - t.radius);
      max.set(t.pos.x + t.radius, t.pos.y + t.height, t.pos.z + t.radius);
      const h = rayAABB(origin, dir, min, max, best ? best.dist : maxDist);
      if (!h) continue;
      const point = origin.clone().addScaledVector(dir, h.t);
      best = { type: 'target', target: t, point, normal: h.normal, dist: h.t, headshot: point.y > t.pos.y + t.height * 0.82 };
    }
    return best;
  };
}
