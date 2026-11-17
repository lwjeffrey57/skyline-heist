import * as THREE from 'three';

// Guardian turrets: fixed sentry guns that some raids place at the compound's gates and in outpost yards. They sweep
// an arc and follow the same detection rules as the guards: awareness builds while you are in their view cone with a
// clear line of sight, they open fire only when fully alert, and they forget you once you break their view.
// The eye shows the state: white while sweeping, yellow when suspicious, red when alert.

const CFG = {
  hp: 80, range: 36, fovDeg: 70, sweepDeg: 55, sweepSpeed: 0.5, trackSpeed: 2.2,
  noticeTime: 1.5, loseTime: 4, reaction: 0.5, damage: 4, burst: 6, fireRate: 8, burstPause: [1.1, 1.8],
  hitNear: 0.45, hitFar: 0.15, chance: 0.65, count: [2, 4],
};
const EYE = { unaware: 0xffffff, suspicious: 0xffd24a, alert: 0xff3b1f };
const rnd = (a, b) => a + Math.random() * (b - a);

function buildMesh() {
  const g = new THREE.Group(), head = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x23282e, roughness: 0.55, metalness: 0.6 });
  const shell = new THREE.MeshStandardMaterial({ color: 0x6a5a3a, roughness: 0.6, metalness: 0.3 });
  const eye = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: EYE.unaware, emissiveIntensity: 4 });
  const add = (parent, geo, mat, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
  add(g, new THREE.CylinderGeometry(0.42, 0.55, 0.25, 10), dark, 0, 0.125, 0);
  add(g, new THREE.CylinderGeometry(0.14, 0.2, 0.8, 8), dark, 0, 0.65, 0);
  head.position.y = 1.2; g.add(head);
  add(head, new THREE.BoxGeometry(0.5, 0.34, 0.6), shell, 0, 0, 0);
  add(head, new THREE.BoxGeometry(0.58, 0.1, 0.4), dark, 0, 0.2, -0.05);
  add(head, new THREE.CylinderGeometry(0.045, 0.045, 0.7, 8), dark, -0.11, -0.02, 0.6, Math.PI / 2);
  add(head, new THREE.CylinderGeometry(0.045, 0.045, 0.7, 8), dark, 0.11, -0.02, 0.6, Math.PI / 2);
  add(head, new THREE.SphereGeometry(0.07, 10, 8), eye, 0, 0.09, 0.31);
  return { group: g, head, eye };
}

export function init(ctx) {
  const { player, world, events, scene } = ctx;
  const list = [];
  let active = false;
  const eyeP = new THREE.Vector3(), tmp = new THREE.Vector3();

  function make() {
    const { group, head, eye } = buildMesh(); scene.add(group); group.visible = false;
    const t = {
      name: 'Guardian turret', kind: 'turret', team: 'enemy', isTurret: true, alive: false, radius: 0.5, height: 1.5, hp: 0, maxHp: CFG.hp,
      pos: new THREE.Vector3(), c: new THREE.Vector3(), group, head, eye, base: 0, yaw: 0, sweepT: Math.random() * 6,
      awareness: 0, alertState: 'unaware', lastSeen: 99, los: false, burstLeft: 0, shotT: 0, pauseT: 0.5, reactT: 0,
      takeDamage(amount, info = {}) {
        if (!t.alive) return;
        t.hp -= amount; t.awareness = 1; t.alertState = 'alert'; t.lastSeen = 0; // shooting it tells it where you are
        if (t.hp <= 0) {
          t.alive = false; t.alertState = 'unaware'; t.awareness = 0; t.group.visible = false;
          events.emit('explosion', { point: t.c.clone(), radius: 1.4, by: t, damage: 0, kind: 'turret' });
          events.emit('botDied', { bot: t, point: t.c.clone(), by: info.source || null, headshot: false });
        }
      },
    };
    list.push(t); ctx.targets.push(t); return t;
  }

  // candidate posts: just inside each gate of the inner wall, looking out along the approach, and in outpost yards
  function posts() {
    const out = [], IW = (world.coreHalf || 70) + 3;
    for (const [gx, gz, yaw] of [[0, -IW, Math.PI], [38, -IW, Math.PI], [0, IW, 0], [-38, IW, 0], [-IW, 0, -Math.PI / 2], [IW, 0, Math.PI / 2]]) {
      const side = Math.random() < 0.5 ? -3 : 3, inward = 2.5; // inside the gateway itself, so the wall never blocks its view out
      out.push(gz === 0 ? [gx - Math.sign(gx) * inward, side, yaw] : [gx + side, gz - Math.sign(gz) * inward, yaw]);
    }
    for (const b of world.buildings) if (b.outpost) { const sx = Math.random() < 0.5 ? -1 : 1, sz = Math.random() < 0.5 ? -1 : 1; out.push([b.x + sx * 10.5, b.z + sz * 10.5, Math.atan2(sx, sz)]); }
    return out.filter(([x, z]) => player.free(x, 0.01, z, 1.6)).sort(() => Math.random() - 0.5);
  }
  function deploy(n) {
    const spots = posts().slice(0, n);
    spots.forEach(([x, z, yaw], i) => {
      const t = list[i] || make();
      t.pos.set(x, 0, z); t.c.set(x, 1.25, z); t.base = t.yaw = yaw; t.hp = CFG.hp; t.alive = true; t.awareness = 0; t.alertState = 'unaware'; t.lastSeen = 99;
      t.group.position.set(x, 0, z); t.group.visible = true;
    });
  }
  function clear() { for (const t of list) { t.alive = false; t.group.visible = false; t.awareness = 0; t.alertState = 'unaware'; } }

  events.on('raidStart', () => { active = true; clear(); if (Math.random() < CFG.chance) deploy(Math.round(rnd(CFG.count[0], CFG.count[1]))); });
  events.on('raidEnd', () => { active = false; clear(); });

  function fire(t, dist) {
    const moving = Math.hypot(player.vel.x, player.vel.z) > 6 ? 0.6 : 1;
    const chance = THREE.MathUtils.lerp(CFG.hitNear, CFG.hitFar, THREE.MathUtils.clamp((dist - 8) / 26, 0, 1)) * moving;
    tmp.set(player.pos.x, player.pos.y + player.height * 0.6, player.pos.z);
    if (Math.random() > chance) tmp.x += rnd(0.7, 1.6) * (Math.random() < 0.5 ? -1 : 1), tmp.y += rnd(-0.4, 0.8), tmp.z += rnd(0.7, 1.6) * (Math.random() < 0.5 ? -1 : 1);
    const muzzle = t.c.clone().add(new THREE.Vector3(Math.sin(t.yaw) * 0.9, 0, Math.cos(t.yaw) * 0.9));
    const aim = tmp.clone().sub(muzzle).normalize();
    events.emit('shot', { weapon: 'bot_rifle', origin: muzzle, dir: aim, dirs: [aim], muzzle, by: t });
    const h = ctx.hitscan(muzzle, aim, 80, t);
    if (!h) return;
    if (h.type === 'target' && h.target === player) { player.takeDamage(CFG.damage, { from: muzzle, source: t }); events.emit('impact', { point: h.point, normal: h.normal, kind: 'flesh', target: player, damage: CFG.damage, by: t }); }
    else if (h.type === 'world') { ctx.destruction.hit(h.collider, h.point, h.normal, CFG.damage); events.emit('impact', { point: h.point, normal: h.normal, kind: 'world', collider: h.collider, damage: CFG.damage, by: t }); }
  }

  let tick = 0;
  const half = THREE.MathUtils.degToRad(CFG.fovDeg / 2), sweep = THREE.MathUtils.degToRad(CFG.sweepDeg);
  const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
  function update(dt) {
    if (!active) return;
    tick++;
    eyeP.set(player.pos.x, player.pos.y + player.height * 0.8, player.pos.z);
    for (let i = 0; i < list.length; i++) {
      const t = list[i]; if (!t.alive) continue;
      const dx = player.pos.x - t.c.x, dz = player.pos.z - t.c.z, dist = Math.hypot(dx, dz), toPlayer = Math.atan2(dx, dz);
      // sight: inside the cone it is looking through, in range, with a clear line
      if ((tick + i * 4) % 8 === 0) t.los = dist < CFG.range && Math.abs(wrap(toPlayer - t.yaw)) < (t.alertState === 'alert' ? Math.PI * 0.6 : half) && !(player.protectT > 0) && world.lineOfSight(t.c, eyeP);
      if (t.los) { t.awareness = Math.min(1, t.awareness + (dt / CFG.noticeTime) * (player.crouching ? 0.5 : 1) * (dist < 14 ? 1.6 : 1)); t.lastSeen = 0; }
      else { t.lastSeen += dt; if (t.lastSeen > 0.8) t.awareness = Math.max(0, t.awareness - dt * (t.alertState === 'alert' ? 1 / CFG.loseTime : 0.3)); }
      const was = t.alertState;
      t.alertState = t.awareness >= 1 || (was === 'alert' && t.lastSeen < CFG.loseTime) ? 'alert' : t.awareness >= 0.35 ? 'suspicious' : 'unaware';
      if (t.alertState !== was) { t.eye.emissive.setHex(EYE[t.alertState]); if (t.alertState === 'alert') { t.reactT = CFG.reaction; t.burstLeft = 0; t.pauseT = 0; events.emit('guardAlert', { bot: t }); } }
      // aim: sweep its arc when idle, turn toward you when it has noticed something
      let want;
      if (t.alertState === 'unaware') { t.sweepT += dt * CFG.sweepSpeed; want = t.base + Math.sin(t.sweepT) * sweep; } else want = t.los || t.lastSeen < 1.5 ? toPlayer : t.yaw;
      t.yaw += THREE.MathUtils.clamp(wrap(want - t.yaw), -CFG.trackSpeed * dt, CFG.trackSpeed * dt);
      t.head.rotation.y = t.yaw;
      // fire only when fully alert, in view and lined up
      if (t.alertState === 'alert' && t.los && Math.abs(wrap(toPlayer - t.yaw)) < 0.2) {
        if (t.reactT > 0) t.reactT -= dt;
        else if (t.burstLeft > 0) { t.shotT -= dt; if (t.shotT <= 0) { fire(t, dist); t.burstLeft--; t.shotT = 1 / CFG.fireRate; if (t.burstLeft === 0) t.pauseT = rnd(CFG.burstPause[0], CFG.burstPause[1]); } }
        else { t.pauseT -= dt; if (t.pauseT <= 0) { t.burstLeft = CFG.burst; t.shotT = 0; } }
      }
    }
  }

  ctx.turrets = { list, config: CFG, deploy };
  return { update };
}
