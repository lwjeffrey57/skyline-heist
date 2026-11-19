import * as THREE from 'three';

// =============================================================================
// Shared, pooled pieces of the enemy types' special attacks (see config.js `kinds`):
//   the marksman's aiming laser + muzzle glint (one per marksman, created on first use, reused),
//   the grenadier's grenades: a slow ballistic lob, a landing marker on the ground, the blast.
// Nothing here allocates per frame. Events:
//   enemyGrenade { point, fuse, by, radius, phase:'throw'|'land', from? }   thrown (point = where it is expected to
//                 land, fuse = seconds until it goes off) and again when it comes to rest (fuse = config grenadeFuse)
//   explosion    { point, radius, by, damage, kind:'enemyGrenade' }         the usual explosion event
// =============================================================================

const G = 13;              // gravity of a lobbed grenade (m/s2): low, so the arc is slow and readable
const POOL = 5;
const A = new THREE.Vector3(), B = new THREE.Vector3(), D = new THREE.Vector3(), DOWN = new THREE.Vector3(0, -1, 0);

export function createRoles(mgr) {
  const { ctx } = mgr, world = ctx.world, scene = ctx.scene, events = ctx.events;

  // ---- marksman laser -------------------------------------------------------
  const beamGeo = new THREE.CylinderGeometry(0.4, 1, 1, 6, 1, true); // (thin at the target's end: it must not fill the screen of the one it points at) beamGeo.rotateX(Math.PI / 2); beamGeo.translate(0, 0, 0.5); // unit length along +Z from the origin
  const glintGeo = new THREE.PlaneGeometry(1, 1);
  const lasers = new Map();
  function laserOf(bot) {
    let L = lasers.get(bot); if (L) return L;
    const mat = new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
    const gm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false, depthTest: false, fog: false, toneMapped: false, side: THREE.DoubleSide });
    const sm = new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 1, depthWrite: false, depthTest: false, fog: false, toneMapped: false, side: THREE.DoubleSide });
    L = { beam: new THREE.Mesh(beamGeo, mat), glint: new THREE.Group(), mat, gm, sm, on: false };
    for (const [sx, sy, rz, m] of [[1.3, 0.11, 0, sm], [0.11, 0.7, 0, sm], [0.42, 0.42, Math.PI / 4, sm], [0.2, 0.2, Math.PI / 4, gm]]) { const q = new THREE.Mesh(glintGeo, m); q.rotation.z = rz; q.scale.set(sx, sy, 1); L.glint.add(q); } // a lens flare: a wide streak, a short upright one, a diamond core
    L.beam.frustumCulled = false; L.beam.visible = false; L.glint.visible = false; L.beam.renderOrder = 4; L.glint.renderOrder = 6; for (const q of L.glint.children) q.renderOrder = 6;
    scene.add(L.beam); scene.add(L.glint);
    lasers.set(bot, L); return L;
  }
  // Show the laser from `from` to `to`. k: 0..1 progress of the wind-up, locked: the line is frozen, the shot is coming.
  function laser(bot, from, to, k, locked) {
    const L = laserOf(bot), cam = ctx.camera;
    D.subVectors(to, from); const len = D.length() || 1;
    L.beam.position.copy(from); L.beam.lookAt(to);
    const dc = cam.position.distanceTo(from), w = (locked ? 0.05 : 0.028) * (1 + dc * 0.02);
    L.beam.scale.set(w, w, len);
    L.mat.opacity = locked ? 1 : 0.45 + 0.4 * k; L.mat.color.setHex(locked ? 0xffffff : 0xff2a1a);
    const pulse = locked ? 1.6 : 0.7 + 0.5 * k + 0.2 * Math.sin(mgr.time * (14 + 30 * k));
    L.glint.position.copy(from).addScaledVector(D, 0.25 / len); cam.getWorldQuaternion(L.glint.quaternion);
    L.glint.scale.setScalar(Math.max(1.2, dc * 0.1) * pulse); // (grows with distance: it has to catch the eye from across the site)
    L.beam.visible = L.glint.visible = true; L.on = true;
  }
  function laserOff(bot) { const L = lasers.get(bot); if (L && L.on) { L.on = false; L.beam.visible = false; L.glint.visible = false; } }

  // ---- grenades --------------------------------------------------------------
  const nadeGeo = new THREE.SphereGeometry(0.11, 10, 8), ringGeo = new THREE.RingGeometry(0.93, 1, 40), discGeo = new THREE.CircleGeometry(1, 40), coreGeo = new THREE.RingGeometry(0.1, 0.16, 20);
  ringGeo.rotateX(-Math.PI / 2); discGeo.rotateX(-Math.PI / 2); coreGeo.rotateX(-Math.PI / 2);
  const pool = [];
  for (let i = 0; i < POOL; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a1d20, emissive: 0xff5a1c, emissiveIntensity: 2, roughness: 0.5 });
    const mk = (geo, o) => new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff4a1c, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide }));
    const g = { on: false, mesh: new THREE.Mesh(nadeGeo, mat), mat, marker: new THREE.Group(), ring: mk(ringGeo, 0.9), disc: mk(discGeo, 0.12), core: mk(coreGeo, 0.9),
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), land: new THREE.Vector3(), by: null, fuse: 0, landed: false, resting: false, age: 0, radius: 5, damage: 50, edge: 0.2, structure: 60, fuseLand: 1.6, checkT: 0 };
    g.marker.add(g.ring, g.disc, g.core); g.mesh.visible = false; g.marker.visible = false; g.mesh.castShadow = true; g.marker.renderOrder = 3;
    scene.add(g.mesh); scene.add(g.marker); pool.push(g);
  }

  // Launch velocity to reach `to` from `from` in T seconds; false if the arc is blocked (checked in 6 straight pieces).
  function arc(from, to, T, out) {
    out.set((to.x - from.x) / T, (to.y - from.y) / T + 0.5 * G * T, (to.z - from.z) / T);
    A.copy(from);
    for (let i = 1; i <= 6; i++) {
      const t = T * i / 6; B.set(from.x + out.x * t, from.y + out.y * t - 0.5 * G * t * t, from.z + out.z * t);
      if (i === 6) B.y += 0.35;
      if (!world.lineOfSight(A, B)) return false;
      A.copy(B);
    }
    return true;
  }
  const V0 = new THREE.Vector3(), S0 = new THREE.Vector3(), P1 = new THREE.Vector3(), P2 = new THREE.Vector3(), VEL = new THREE.Vector3(), DIR = new THREE.Vector3();
  // Can `bot` lob a grenade onto `to`? Tries a flat-ish arc first, then a high one. Returns the flight time or 0.
  function solve(bot, to, out = V0) {
    S0.set(bot.pos.x, bot.pos.y + 1.55, bot.pos.z);
    const d = Math.hypot(to.x - S0.x, to.z - S0.z), T = THREE.MathUtils.clamp(0.95 + d * 0.04, 1.2, 2.3);
    mgr.stats.rays += 6;
    if (arc(S0, to, T, out)) return T;
    mgr.stats.rays += 6;
    if (arc(S0, to, T * 1.55, out)) return T * 1.55;
    return 0;
  }
  function canThrow(bot, to) { return solve(bot, to) > 0 && pool.some((g) => !g.on); }

  function throwGrenade(bot, to) {
    const g = pool.find((x) => !x.on); if (!g) return false;
    let T = solve(bot, to, g.vel);
    if (!T) { T = 1.6; g.vel.set((to.x - S0.x) / T, (to.y - S0.y) / T + 0.5 * G * T, (to.z - S0.z) / T); } // the way closed during the wind-up: thrown anyway
    const cfg = bot.cfg;
    g.on = true; g.by = bot; g.pos.copy(S0); g.landed = false; g.resting = false; g.age = 0; g.fuse = 8; g.checkT = 0;
    g.radius = cfg.grenadeRadius; g.damage = cfg.grenadeDamage; g.edge = cfg.grenadeEdge; g.structure = cfg.grenadeStructure; g.fuseLand = cfg.grenadeFuse;
    // where it will come down: fly the same arc ahead of time
    g.land.copy(to); P1.copy(S0); VEL.copy(g.vel);
    for (let i = 0; i < 80; i++) {
      P2.copy(P1).addScaledVector(VEL, 0.05); VEL.y -= G * 0.05;
      DIR.subVectors(P2, P1); const len = DIR.length(), h = len > 1e-5 ? world.raycast(P1, DIR.multiplyScalar(1 / len), len + 0.02) : null;
      if (h) { g.land.copy(h.point); if (h.normal.y < 0.5) { const f = world.raycast(P2.copy(h.point).addScaledVector(h.normal, 0.2), DOWN, 30); if (f) g.land.copy(f.point); } T = (i + 1) * 0.05; break; }
      P1.copy(P2);
    }
    g.mesh.position.copy(g.pos); g.mesh.visible = true;
    g.marker.position.set(g.land.x, g.land.y + 0.06, g.land.z); g.marker.visible = true; g.ring.scale.setScalar(g.radius); g.disc.scale.setScalar(g.radius);
    mgr.stats.grenades = (mgr.stats.grenades || 0) + 1;
    events.emit('enemyGrenade', { point: g.land.clone(), fuse: T + g.fuseLand, by: bot, radius: g.radius, phase: 'throw', from: S0.clone() });
    return true;
  }
  function explode(g) {
    const p = g.pos, by = g.by, r = g.radius;
    for (const t of ctx.targets.slice()) {
      if (!t.alive || t === by) continue;
      if (t.isBot && by && t.faction === by.faction) continue; // its own side stands clear in spirit: no friendly fire
      const h = t.height ?? t.h ?? 1.8;
      const qx = Math.min(Math.max(p.x, t.pos.x - t.radius), t.pos.x + t.radius), qy = Math.min(Math.max(p.y, t.pos.y), t.pos.y + h), qz = Math.min(Math.max(p.z, t.pos.z - t.radius), t.pos.z + t.radius);
      const dist = Math.hypot(p.x - qx, p.y - qy, p.z - qz); if (dist > r) continue;
      A.set(p.x, p.y + 0.15, p.z); B.set(t.pos.x, t.pos.y + h * 0.5, t.pos.z);
      if (!world.lineOfSight(A, B)) { B.y = t.pos.y + h * 0.9; if (!world.lineOfSight(A, B)) continue; }
      const f = dist / r, dmg = g.damage * (1 - (1 - g.edge) * f) * (t.isBot ? mgr.cfg.botVsBotDamage * 0.5 : 1);
      if (t.vel && t.vel.isVector3) { D.set(t.pos.x - p.x, 0, t.pos.z - p.z); const l = D.length() || 1; D.multiplyScalar(1 / l); D.y = 0.5; t.vel.addScaledVector(D, 5 * (1 - f * 0.7)); if (t === ctx.player) t.grounded = false; }
      t.takeDamage(dmg, { from: p.clone(), source: by, headshot: false, explosive: true, weapon: 'enemy_grenade' });
      if (by && by.stats) by.stats.damageDealt += dmg;
    }
    if (ctx.destruction && ctx.destruction.explode) ctx.destruction.explode(p.clone(), r, g.structure);
    events.emit('explosion', { point: p.clone(), radius: r, by, damage: g.damage, kind: 'enemyGrenade' });
  }

  function update(dt) {
    for (let i = 0; i < POOL; i++) {
      const g = pool[i]; if (!g.on) continue;
      g.age += dt;
      if (!g.resting) {
        A.copy(g.pos); g.vel.y -= G * dt; B.copy(g.pos).addScaledVector(g.vel, dt);
        const sp = g.vel.length();
        const dir = D.copy(g.vel).multiplyScalar(1 / (sp || 1)), h = sp > 1e-4 ? world.raycast(A, dir, sp * dt + 0.12) : null;
        if (h) {
          g.pos.copy(h.point).addScaledVector(h.normal, 0.11);
          const vn = g.vel.dot(h.normal); g.vel.addScaledVector(h.normal, -1.3 * vn).multiplyScalar(0.35); // a dead bounce
          if (!g.landed) { g.landed = true; g.fuse = g.fuseLand; }
          if (h.normal.y > 0.5 && g.vel.lengthSq() < 4) { g.resting = true; g.vel.set(0, 0, 0); }
          if (g.resting || h.normal.y > 0.5) {
            g.land.copy(g.pos); g.marker.position.set(g.pos.x, g.pos.y - 0.05, g.pos.z);
            if (!g.told) { g.told = true; events.emit('enemyGrenade', { point: g.pos.clone(), fuse: g.fuse, by: g.by, radius: g.radius, phase: 'land' }); }
          }
        } else g.pos.copy(B);
        g.mesh.rotation.x += 7 * dt; g.mesh.rotation.z += 5 * dt;
        if (g.pos.y < -40) { g.on = false; g.told = false; g.mesh.visible = false; g.marker.visible = false; continue; }
      } else if ((g.checkT -= dt) <= 0) { g.checkT = 0.25; if (!world.raycast(g.pos, DOWN, 0.4)) g.resting = false; } // the floor went
      g.mesh.position.copy(g.pos);
      const left = g.landed ? g.fuse : g.fuseLand + 0.6, hz = left < 0.5 ? 16 : left < 1.1 ? 8 : 4, blink = Math.sin(g.age * hz * Math.PI * 2) > 0;
      g.mat.emissiveIntensity = blink ? 9 : 1.2;
      g.ring.material.opacity = blink ? 1 : 0.55; g.disc.material.opacity = g.landed ? (blink ? 0.3 : 0.16) : 0.1;
      const cs = g.landed ? 1 + (1 - Math.max(0, g.fuse) / g.fuseLand) * (g.radius / 0.16 - 1) : 1; g.core.scale.setScalar(cs); // a ring grows from the grenade to the rim as the fuse burns
      if (g.landed) { g.fuse -= dt; if (g.fuse <= 0) { g.on = false; g.told = false; g.mesh.visible = false; g.marker.visible = false; explode(g); } }
    }
  }
  function clear() { for (const g of pool) { g.on = false; g.told = false; g.mesh.visible = false; g.marker.visible = false; } for (const L of lasers.values()) { L.on = false; L.beam.visible = false; L.glint.visible = false; } }
  function release(bot) { const L = lasers.get(bot); if (!L) return; scene.remove(L.beam); scene.remove(L.glint); L.mat.dispose(); L.gm.dispose(); L.sm.dispose(); lasers.delete(bot); }

  return { laser, laserOff, canThrow, throwGrenade, update, clear, release, grenades: pool, lasers };
}
