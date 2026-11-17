import * as THREE from 'three';

// Ejected brass: one pooled InstancedMesh, simple ballistic motion with a couple of floor bounces.
// Emits 'ejectCasing' { position, velocity, weapon } when a casing leaves the gun and
// 'casingBounce' { position, speed, weapon } the first time it hits the floor.

const MAX = 32, LIFE = 2.6;
const KIND = { // length scale, radius scale, colour
  pistol: [0.45, 0.95, 0xd6ad5a], rifle: [1, 1, 0xd6ad5a], sniper: [2.1, 1.45, 0xd6ad5a], shotgun: [1.5, 2.1, 0xb8301f],
};

export function createCasings(ctx) {
  const pts = [[0, 0], [0.0052, 0], [0.0052, 0.003], [0.0046, 0.0036], [0.0052, 0.0044], [0.005, 0.03], [0.0036, 0.036], [0.0034, 0.045], [0.0001, 0.045]];
  const geo = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-5), y - 0.022)), 10);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.9, roughness: 0.3 });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true; mesh.name = 'wp-casings';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const items = [], m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), col = new THREE.Color();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAX; i++) { items.push({ live: false, t: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Vector3(), spin: new THREE.Vector3(), floor: 0, k: KIND.rifle, bounced: 0, weapon: '' }); mesh.setMatrixAt(i, zero); mesh.setColorAt(i, col.set(0xffffff)); }
  ctx.scene.add(mesh);
  let next = 0, active = 0;
  const down = new THREE.Vector3(0, -1, 0);

  function spawn(position, velocity, weapon) {
    const c = items[next]; next = (next + 1) % MAX;
    c.live = true; c.t = 0; c.pos.copy(position); c.vel.copy(velocity); c.weapon = weapon; c.bounced = 0;
    c.k = KIND[weapon] || KIND.rifle;
    c.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    c.spin.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 40);
    const h = ctx.world.raycast(position, down, 6); c.floor = h ? h.point.y : -1e3;
    mesh.setColorAt(items.indexOf(c), col.set(c.k[2])); mesh.instanceColor.needsUpdate = true;
    ctx.events.emit('ejectCasing', { position: position.clone(), velocity: velocity.clone(), weapon });
  }

  function update(dt) {
    active = 0;
    for (let i = 0; i < MAX; i++) {
      const c = items[i]; if (!c.live) continue;
      c.t += dt;
      if (c.t > LIFE) { c.live = false; mesh.setMatrixAt(i, zero); continue; }
      active++;
      c.vel.y -= 14 * dt; c.pos.addScaledVector(c.vel, dt);
      const r = 0.006 * c.k[1];
      if (c.pos.y < c.floor + r && c.vel.y < 0) {
        c.pos.y = c.floor + r;
        if (c.bounced === 0) ctx.events.emit('casingBounce', { position: c.pos.clone(), speed: -c.vel.y, weapon: c.weapon });
        c.bounced++;
        if (-c.vel.y > 0.6) { c.vel.y *= -0.38; c.vel.x *= 0.6; c.vel.z *= 0.6; c.spin.multiplyScalar(0.5); }
        else { c.vel.set(0, 0, 0); c.spin.set(0, 0, 0); c.rot.x = Math.PI / 2; c.rot.z = 0; }
      }
      c.rot.addScaledVector(c.spin, dt);
      const fade = Math.min(1, (LIFE - c.t) / 0.25);
      m.compose(c.pos, q.setFromEuler(e.set(c.rot.x, c.rot.y, c.rot.z)), s.set(c.k[1] * fade, c.k[0] * fade, c.k[1] * fade));
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.visible = active > 0;
  }
  return { spawn, update, mesh };
}
