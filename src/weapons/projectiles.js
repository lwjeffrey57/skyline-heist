import * as THREE from 'three';
import { PROJECTILES } from './defs.js';
import { buildGrenadeMesh } from './viewmodels.js';

// Bouncing explosive projectiles: a sphere swept against the world's AABBs in small substeps.
// hooks: { onBlastHit(target, damage, killed), onBlast(point, radius) }

const _q = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Vector3();

export function createProjectiles(ctx, hooks = {}) {
  const list = [];
  const { world, events, player } = ctx;

  function spawn(kind, origin, dir, inherit = null) {
    const def = PROJECTILES[kind];
    const mesh = buildGrenadeMesh(kind);
    const vel = dir.clone(); vel.y += def.up; vel.normalize().multiplyScalar(def.speed);
    if (inherit) { vel.x += inherit.x * 0.6; vel.z += inherit.z * 0.6; vel.y += Math.max(0, inherit.y) * 0.4; }
    const p = {
      kind, def, mesh, pos: origin.clone(), vel, r: def.radius, age: 0, fuse: def.fuse, bounces: 0, by: player,
      spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(18), resting: false, dead: false,
    };
    mesh.position.copy(p.pos); mesh.lookAt(p.pos.clone().add(vel));
    ctx.scene.add(mesh);
    list.push(p);
    events.emit('projectile', { projectile: p, kind, by: player });
    return p;
  }

  function collide(p, cands) {
    let hit = false;
    for (const c of cands) {
      _q.set(Math.min(Math.max(p.pos.x, c.min.x), c.max.x), Math.min(Math.max(p.pos.y, c.min.y), c.max.y), Math.min(Math.max(p.pos.z, c.min.z), c.max.z));
      _d.subVectors(p.pos, _q);
      const d2 = _d.lengthSq();
      if (d2 >= p.r * p.r) continue;
      let pen;
      if (d2 > 1e-10) { const d = Math.sqrt(d2); _n.copy(_d).multiplyScalar(1 / d); pen = p.r - d; }
      else { // centre is inside the box: leave through the nearest face
        let best = Infinity; _n.set(0, 1, 0);
        for (const a of ['x', 'y', 'z']) {
          const lo = p.pos[a] - c.min[a], hi = c.max[a] - p.pos[a];
          if (lo < best) { best = lo; _n.set(0, 0, 0); _n[a] = -1; }
          if (hi < best) { best = hi; _n.set(0, 0, 0); _n[a] = 1; }
        }
        pen = best + p.r;
      }
      p.pos.addScaledVector(_n, pen + 1e-4);
      const vn = p.vel.dot(_n);
      if (vn < 0) {
        const speed = -vn;
        p.vel.addScaledVector(_n, -(1 + p.def.bounce) * vn);
        // friction on the tangential part
        const vn2 = p.vel.dot(_n);
        _c.copy(p.vel).addScaledVector(_n, -vn2).multiplyScalar(1 - p.def.friction);
        p.vel.copy(_c).addScaledVector(_n, vn2);
        if (speed > 1.2) {
          p.bounces++;
          p.spin.multiplyScalar(0.6);
          if (p.bounces === 1 && p.def.fuseAfterBounce > 0) p.fuse = Math.min(p.fuse, p.age + p.def.fuseAfterBounce);
          events.emit('grenadeBounce', { point: p.pos.clone(), normal: _n.clone(), speed, kind: p.kind, collider: c });
        } else if (_n.y > 0.7 && p.vel.lengthSq() < 0.6) { p.vel.set(0, 0, 0); p.resting = true; }
      }
      hit = true;
    }
    return hit;
  }

  function hitsTarget(p) {
    for (const t of ctx.targets) {
      if (!t.alive || t === p.by) continue;
      const qx = Math.min(Math.max(p.pos.x, t.pos.x - t.radius), t.pos.x + t.radius);
      const qy = Math.min(Math.max(p.pos.y, t.pos.y), t.pos.y + t.height);
      const qz = Math.min(Math.max(p.pos.z, t.pos.z - t.radius), t.pos.z + t.radius);
      if ((p.pos.x - qx) ** 2 + (p.pos.y - qy) ** 2 + (p.pos.z - qz) ** 2 < p.r * p.r) return t;
    }
    return null;
  }

  // Blast: damage targets (line of sight, linear falloff), knock them back, then wreck the world.
  function explode(point, blast, by, kind = 'explosion', direct = null) {
    const head = new THREE.Vector3(), mid = new THREE.Vector3(), src = point.clone();
    for (const t of ctx.targets.slice()) {
      if (!t.alive) continue;
      const h = t.height ?? 1.8;
      const qx = Math.min(Math.max(point.x, t.pos.x - t.radius), t.pos.x + t.radius);
      const qy = Math.min(Math.max(point.y, t.pos.y), t.pos.y + h);
      const qz = Math.min(Math.max(point.z, t.pos.z - t.radius), t.pos.z + t.radius);
      const dist = Math.hypot(point.x - qx, point.y - qy, point.z - qz);
      if (dist > blast.radius) continue;
      mid.set(t.pos.x, t.pos.y + h * 0.5, t.pos.z); head.set(t.pos.x, t.pos.y + h * 0.9, t.pos.z);
      if (t !== direct && !world.lineOfSight(src, mid) && !world.lineOfSight(src, head)) continue;
      const f = dist / blast.radius;
      let dmg = blast.damage * (1 - (1 - blast.edge) * f);
      if (t === by) dmg *= blast.selfMult;
      // knockback (rocket-jump friendly)
      if (t.vel && t.vel.isVector3) {
        _d.subVectors(mid, point); const l = _d.length() || 1; _d.multiplyScalar(1 / l); _d.y = Math.max(_d.y, 0.25) + 0.35; _d.normalize();
        const k = blast.knock * (1 - f * 0.7);
        t.vel.addScaledVector(_d, k);
        if (t === player) { player.grounded = false; }
      }
      const was = t.alive;
      t.takeDamage(dmg, { from: point.clone(), source: by, headshot: false, explosive: true });
      if (hooks.onBlastHit) hooks.onBlastHit(t, dmg, was && !t.alive, kind);
    }
    ctx.destruction.explode(point.clone(), blast.radius, blast.structure);
    events.emit('explosion', { point: point.clone(), radius: blast.radius, by, damage: blast.damage, kind });
    if (hooks.onBlast) hooks.onBlast(point, blast.radius);
  }

  function update(dt) {
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.age += dt;
      let boom = p.age >= p.fuse, direct = null;
      if (!boom && !p.resting) {
        const speed = p.vel.length();
        const cands = world.overlapSphere(p.pos, speed * dt + p.r + 0.6 + p.def.gravity * dt * dt);
        const n = Math.min(60, Math.max(1, Math.ceil((speed * dt) / (p.r * 0.7))));
        const h = dt / n;
        for (let k = 0; k < n && !boom; k++) {
          p.vel.y -= p.def.gravity * h;
          p.pos.addScaledVector(p.vel, h);
          collide(p, cands);
          if (p.def.impactTargets) { direct = hitsTarget(p); if (direct) boom = true; }
          if (p.resting) break;
        }
        if (p.pos.y < -40) { p.dead = true; }
      } else if (p.resting) {
        // the floor may have been blown away under it
        if (!world.overlapSphere(p.pos, p.r + 0.02).length) p.resting = false;
      }
      if (!p.resting) { p.mesh.rotation.x += p.spin.x * dt; p.mesh.rotation.y += p.spin.y * dt; p.mesh.rotation.z += p.spin.z * dt; }
      p.mesh.position.copy(p.pos);
      const left = p.fuse - p.age;
      p.mesh.userData.light.emissiveIntensity = Math.sin(p.age * (left < 0.6 ? 60 : 22)) > 0 ? 7 : 0.6;
      if (boom || p.dead) {
        list.splice(i, 1); p.dead = true;
        p.mesh.removeFromParent();
        p.mesh.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); } });
        if (boom) explode(p.pos, p.def.blast, p.by, p.kind, direct);
      }
    }
  }

  return { list, spawn, update, explode };
}
