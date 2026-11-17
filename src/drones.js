import * as THREE from 'three';

// Hunter drones: an occasional flying enemy. One may be on patrol over the site when you deploy and another joins
// during lockdown. They cruise above the rooftops, notice you by sight like the guards do, then drop to hover
// nearby and fire short bursts. Light armour, loud guns, easy to lose behind a roof.

const CFG = {
  hp: 60, cruiseAlt: 15, combatAbove: 6.5, patrolSpeed: 6.5, combatSpeed: 9, accel: 7,
  sight: 46, noticeTime: 1.3, loseTime: 5, engage: 36, standoff: [11, 17],
  damage: 4, burst: 4, fireRate: 7, burstPause: [1.5, 2.4], reaction: 0.8,
  hitNear: 0.4, hitFar: 0.12, respawn: 70, firstChance: 0.55,
};
const rnd = (a, b) => a + Math.random() * (b - a);

function buildMesh() {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x20252b, roughness: 0.55, metalness: 0.6 });
  const shell = new THREE.MeshStandardMaterial({ color: 0x5b6570, roughness: 0.5, metalness: 0.4 });
  const glow = new THREE.MeshStandardMaterial({ color: 0x180404, emissive: 0xff3b1f, emissiveIntensity: 5 });
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; g.add(m); return m; };
  // a long wedge hull with a single sensor eye, two ducted fans up front on swept arms and one on the tail
  add(new THREE.BoxGeometry(0.42, 0.2, 0.95), shell, 0, 0, 0);
  add(new THREE.ConeGeometry(0.21, 0.5, 4), shell, 0, 0, 0.72, Math.PI / 2, Math.PI / 4, 0);
  add(new THREE.BoxGeometry(0.3, 0.12, 0.5), dark, 0, 0.14, -0.1);
  add(new THREE.SphereGeometry(0.075, 12, 10), glow, 0, -0.02, 0.9);
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.55, 8), dark, 0, -0.16, 0.5, Math.PI / 2, 0, 0); // gun
  add(new THREE.BoxGeometry(0.14, 0.1, 0.2), dark, 0, -0.14, 0.22);
  const rotors = [];
  for (const [x, z, r] of [[-0.62, 0.3, 0.3], [0.62, 0.3, 0.3], [0, -0.78, 0.24]]) {
    add(new THREE.BoxGeometry(Math.abs(x) || 0.08, 0.05, x ? 0.1 : 0.5), dark, x / 2, 0.03, x ? z * 0.6 : z / 2 - 0.2);
    add(new THREE.TorusGeometry(r, 0.035, 8, 20), shell, x, 0.06, z, Math.PI / 2, 0, 0);
    const blade = add(new THREE.BoxGeometry(r * 1.8, 0.012, 0.05), dark, x, 0.06, z); blade.castShadow = false; rotors.push(blade);
  }
  return { group: g, rotors, glow };
}

export function init(ctx) {
  const { player, world, events, scene } = ctx;
  const list = [];
  let active = false, wantCount = 0, respawnT = 0, lockdownAdded = false;
  const eye = new THREE.Vector3(), tmp = new THREE.Vector3(), dir = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);

  function makeDrone() {
    const { group, rotors } = buildMesh(); group.scale.setScalar(1.7); scene.add(group); group.visible = false;
    const d = {
      name: 'Hunter drone', kind: 'drone', team: 'enemy', isDrone: true, alive: false, radius: 1.0, height: 0.8, hp: 0, maxHp: CFG.hp,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), c: new THREE.Vector3(), group, rotors, yaw: 0,
      awareness: 0, alertState: 'unaware', lastSeen: 99, goal: new THREE.Vector3(), goalT: 0, losT: 0, los: false,
      burstLeft: 0, shotT: 0, pauseT: 1, reactT: 0, side: Math.random() < 0.5 ? 1 : -1, fall: 0,
      takeDamage(amount, info = {}) {
        if (!d.alive) return;
        d.hp -= amount; d.awareness = 1; d.alertState = 'alert'; d.lastSeen = 0; // shooting it tells it where you are
        if (d.hp <= 0) kill(d, info);
      },
    };
    list.push(d); ctx.targets.push(d); return d;
  }
  function spawn(d) {
    const a = Math.random() * Math.PI * 2, r = (world.coreHalf || 60) * 0.8;
    d.c.set(Math.cos(a) * r, CFG.cruiseAlt + rnd(0, 4), Math.sin(a) * r);
    if (Math.hypot(d.c.x - player.pos.x, d.c.z - player.pos.z) < 60) d.c.set(-d.c.x, d.c.y, -d.c.z); // arrive from the far side
    d.vel.set(0, 0, 0); d.hp = CFG.hp; d.alive = true; d.awareness = 0; d.alertState = 'unaware'; d.lastSeen = 99; d.goalT = 0; d.fall = 0; d.group.visible = true;
  }
  function kill(d, info) {
    d.alive = false; d.fall = 1; d.alertState = 'unaware'; d.awareness = 0;
    const ground = world.raycast(d.c, down, 80);
    const point = new THREE.Vector3(d.c.x, (ground ? ground.point.y : 0) + 1, d.c.z);
    events.emit('explosion', { point: d.c.clone(), radius: 1.6, by: d, damage: 0, kind: 'drone' });
    events.emit('botDied', { bot: d, point, by: info.source || null, headshot: false }); // counts as a kill and drops a pack
    respawnT = CFG.respawn;
  }

  events.on('raidStart', () => { active = true; lockdownAdded = false; wantCount = Math.random() < CFG.firstChance ? 1 : 0; respawnT = wantCount ? rnd(20, 50) : 0; for (const d of list) { d.alive = false; d.group.visible = false; d.fall = 0; } });
  events.on('raidEnd', () => { active = false; for (const d of list) { d.alive = false; d.group.visible = false; d.fall = 0; } });

  function fire(d, dist) {
    const moving = Math.hypot(player.vel.x, player.vel.z) > 6 ? 0.6 : 1;
    const chance = THREE.MathUtils.lerp(CFG.hitNear, CFG.hitFar, THREE.MathUtils.clamp((dist - 12) / 28, 0, 1)) * moving;
    tmp.set(player.pos.x, player.pos.y + player.height * 0.6, player.pos.z);
    if (Math.random() > chance) tmp.x += rnd(0.8, 1.7) * (Math.random() < 0.5 ? -1 : 1), tmp.y += rnd(-0.4, 0.9), tmp.z += rnd(0.8, 1.7) * (Math.random() < 0.5 ? -1 : 1);
    const muzzle = d.c.clone().addScaledVector(dir.set(Math.sin(d.yaw), -0.15, Math.cos(d.yaw)), 0.7);
    const aim = tmp.clone().sub(muzzle).normalize();
    events.emit('shot', { weapon: 'bot_rifle', origin: muzzle, dir: aim, dirs: [aim], muzzle, by: d });
    const h = ctx.hitscan(muzzle, aim, 80, d);
    if (!h) return;
    if (h.type === 'target' && h.target === player) { player.takeDamage(CFG.damage, { from: muzzle, source: d }); events.emit('impact', { point: h.point, normal: h.normal, kind: 'flesh', target: player, damage: CFG.damage, by: d }); }
    else if (h.type === 'world') { ctx.destruction.hit(h.collider, h.point, h.normal, CFG.damage); events.emit('impact', { point: h.point, normal: h.normal, kind: 'world', collider: h.collider, damage: CFG.damage, by: d }); }
  }

  let tick = 0;
  function update(dt) {
    if (!active) return;
    tick++;
    // population: one may be out from the start; lockdown brings another
    if (ctx.raid && ctx.raid.phase >= 2 && !lockdownAdded) { lockdownAdded = true; wantCount++; respawnT = Math.min(respawnT, 4); }
    const alive = list.filter((d) => d.alive).length;
    if (alive < wantCount) { respawnT -= dt; if (respawnT <= 0) { spawn(list.find((d) => !d.alive && d.fall === 0) || makeDrone()); respawnT = CFG.respawn; } }

    eye.set(player.pos.x, player.pos.y + player.height * 0.8, player.pos.z);
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (d.fall > 0) { // shot down: tumble to the ground, then disappear
        d.vel.y -= 20 * dt; d.c.addScaledVector(d.vel, dt); d.group.position.copy(d.c); d.group.rotation.x += dt * 5; d.group.rotation.z += dt * 3;
        const gh = world.raycast(tmp.set(d.c.x, d.c.y + 0.5, d.c.z), down, 1.2);
        if (gh || d.c.y < 0.2) { d.fall = 0; d.group.visible = false; d.group.rotation.set(0, 0, 0); }
        continue;
      }
      if (!d.alive) continue;
      const dist = d.c.distanceTo(eye);
      // sight: a line-of-sight check a few times a second builds or drains awareness
      if ((tick + i * 3) % 10 === 0) d.los = dist < CFG.sight && !(player.protectT > 0) && world.lineOfSight(d.c, eye);
      if (d.los) { d.awareness = Math.min(1, d.awareness + (dt / CFG.noticeTime) * (player.crouching ? 0.5 : 1) * (dist < 20 ? 1.6 : 1)); d.lastSeen = 0; }
      else { d.lastSeen += dt; if (d.lastSeen > 1) d.awareness = Math.max(0, d.awareness - dt * (d.alertState === 'alert' ? 1 / CFG.loseTime : 0.3)); }
      const was = d.alertState;
      d.alertState = d.awareness >= 1 || (was === 'alert' && d.lastSeen < CFG.loseTime) ? 'alert' : d.awareness >= 0.35 ? 'suspicious' : 'unaware';
      if (d.alertState === 'alert' && was !== 'alert') { d.reactT = CFG.reaction; d.burstLeft = 0; d.pauseT = 0; events.emit('guardAlert', { bot: d }); }

      // where to fly
      let speed = CFG.patrolSpeed;
      if (d.alertState === 'alert') {
        speed = CFG.combatSpeed;
        dir.set(d.c.x - player.pos.x, 0, d.c.z - player.pos.z); const flat = dir.length() || 1; dir.divideScalar(flat);
        const want = THREE.MathUtils.clamp(flat, CFG.standoff[0], CFG.standoff[1]);
        d.goalT -= dt; if (d.goalT <= 0) { d.goalT = rnd(2, 4); if (Math.random() < 0.4) d.side *= -1; }
        d.goal.set(player.pos.x + dir.x * want - dir.z * d.side * 5, player.pos.y + CFG.combatAbove, player.pos.z + dir.z * want + dir.x * d.side * 5); // hold off and circle
      } else {
        d.goalT -= dt;
        if (d.goalT <= 0 || d.c.distanceTo(d.goal) < 4) { const r = (world.coreHalf || 60) - 8; d.goal.set(rnd(-r, r), CFG.cruiseAlt + rnd(0, 4), rnd(-r, r)); d.goalT = rnd(14, 26); }
        if (d.alertState === 'suspicious') { d.goal.set(player.pos.x, CFG.cruiseAlt, player.pos.z); speed = 4; }
      }
      // steer toward the goal; climb over anything in the way and never sink into a roof
      tmp.copy(d.goal).sub(d.c); const gd = tmp.length() || 1; tmp.multiplyScalar(Math.min(1, gd / 4) * speed / gd);
      if ((tick + i) % 6 === 0) {
        d.block = d.vel.lengthSq() > 1 && !!world.raycast(d.c, dir.copy(d.vel).normalize(), 5);
        const g = world.raycast(d.c, down, 60); d.floor = g ? g.point.y : 0;
      }
      if (d.block) tmp.y = Math.max(tmp.y, 5), tmp.x *= 0.3, tmp.z *= 0.3;
      if (d.c.y < (d.floor || 0) + 3.5) tmp.y = Math.max(tmp.y, 4);
      d.vel.x += THREE.MathUtils.clamp(tmp.x - d.vel.x, -CFG.accel * dt, CFG.accel * dt);
      d.vel.y += THREE.MathUtils.clamp(tmp.y - d.vel.y, -CFG.accel * dt, CFG.accel * dt);
      d.vel.z += THREE.MathUtils.clamp(tmp.z - d.vel.z, -CFG.accel * dt, CFG.accel * dt);
      d.c.addScaledVector(d.vel, dt);
      d.pos.set(d.c.x, d.c.y - 0.4, d.c.z);

      // face the player when alert, otherwise the way it is going; bank into the motion
      const wantYaw = d.alertState === 'alert' ? Math.atan2(player.pos.x - d.c.x, player.pos.z - d.c.z) : d.vel.lengthSq() > 0.5 ? Math.atan2(d.vel.x, d.vel.z) : d.yaw;
      let dy = wantYaw - d.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2; d.yaw += dy * Math.min(1, dt * 5);
      const fwd = d.vel.x * Math.sin(d.yaw) + d.vel.z * Math.cos(d.yaw), lat = d.vel.x * Math.cos(d.yaw) - d.vel.z * Math.sin(d.yaw);
      d.group.position.set(d.c.x, d.c.y + Math.sin(ctx.time * 2.3 + i) * 0.08, d.c.z);
      d.group.rotation.set(fwd * 0.035, d.yaw, -lat * 0.04, 'YXZ');
      for (const r of d.rotors) r.rotation.y += dt * 60;

      // weapon
      if (d.alertState === 'alert' && d.los && dist < CFG.engage) {
        if (d.reactT > 0) d.reactT -= dt;
        else if (d.burstLeft > 0) { d.shotT -= dt; if (d.shotT <= 0) { fire(d, dist); d.burstLeft--; d.shotT = 1 / CFG.fireRate; if (d.burstLeft === 0) d.pauseT = rnd(CFG.burstPause[0], CFG.burstPause[1]); } }
        else { d.pauseT -= dt; if (d.pauseT <= 0) { d.burstLeft = CFG.burst; d.shotT = 0; } }
      }
    }
  }

  ctx.drones = { list, config: CFG, spawnNow() { wantCount = Math.max(wantCount, 1); respawnT = 0; } };
  return { update };
}
