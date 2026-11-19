import * as THREE from 'three';

// Crossbow bolts you can see: the hit itself is instant (hitscan); this draws a bolt flying the same line and
// leaves it standing in whatever piece of the world it struck for a few seconds. Pooled, no per-frame garbage.

const MAX = 6, SPEED = 120, STAY = 7;

export function createBolts(ctx) {
  const shaft = new THREE.MeshStandardMaterial({ color: 0x1c1d20, metalness: 0.3, roughness: 0.6 });
  const vane = new THREE.MeshStandardMaterial({ color: 0x1fb5a3, roughness: 0.5, emissive: 0x0a4a42, emissiveIntensity: 0.6 });
  const gs = new THREE.CylinderGeometry(0.006, 0.006, 0.42, 6).rotateX(Math.PI / 2);                    // along z, tip at -z
  const gv = new THREE.BoxGeometry(0.002, 0.03, 0.07);
  const items = [];
  const Z = new THREE.Vector3(0, 0, -1), d = new THREE.Vector3();
  function make() {
    const g = new THREE.Group(); g.add(new THREE.Mesh(gs, shaft));
    for (let i = 0; i < 3; i++) { const v = new THREE.Mesh(gv, vane); v.position.z = 0.16; v.rotation.z = i * Math.PI * 2 / 3; v.translateY(0.014); g.add(v); }
    g.visible = false; g.traverse((o) => { o.castShadow = false; }); ctx.scene.add(g);
    return { g, from: new THREE.Vector3(), to: new THREE.Vector3(), len: 1, t: 0, age: 0, state: 0, stick: false }; // state: 0 idle, 1 flying, 2 stuck
  }
  let next = 0;
  // from: muzzle, to: where the shot ended, stick: true if that was a world surface
  function launch(from, to, stick) {
    if (items.length < MAX) items.push(make());
    const b = items[next % items.length]; next++;
    b.from.copy(from); b.to.copy(to); b.len = Math.max(0.01, from.distanceTo(to)); b.t = 0; b.age = 0; b.state = 1; b.stick = stick;
    d.subVectors(to, from).normalize(); b.g.quaternion.setFromUnitVectors(Z, d);
    b.g.position.copy(from); b.g.visible = true; b.g.scale.setScalar(1);
  }
  function update(dt) {
    for (let i = 0; i < items.length; i++) {
      const b = items[i]; if (!b.state) continue;
      if (b.state === 1) {
        b.t += SPEED * dt;
        if (b.t >= b.len) {
          if (!b.stick) { b.state = 0; b.g.visible = false; continue; }
          b.state = 2; b.age = 0;
          d.subVectors(b.from, b.to).normalize(); b.g.position.copy(b.to).addScaledVector(d, 0.13); // buried to a third of its length
        } else b.g.position.lerpVectors(b.from, b.to, b.t / b.len);
      } else {
        b.age += dt;
        if (b.age > STAY) { b.state = 0; b.g.visible = false; } else if (b.age > STAY - 0.4) b.g.scale.setScalar((STAY - b.age) / 0.4);
      }
    }
  }
  return { launch, update };
}
