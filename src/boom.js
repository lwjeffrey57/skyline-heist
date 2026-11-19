import * as THREE from 'three';

// Guards are machines: when one is destroyed it sparks for a moment and then blows apart. Drawn to match the ink art
// style: a spiky comic burst and a shock ring with their own black outlines, chunky flat-coloured smoke, and pieces
// of the chassis thrown outwards. Everything is pooled; nothing is created during play.

const MAX = 5, PUFFS = 7, BITS = 11, FUSE = 0.32;
const rnd = (a, b) => a + Math.random() * (b - a);

function burstTexture() { // a jagged star: black outline, orange, yellow, white core
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S; const g = cv.getContext('2d');
  const star = (r0, r1, n, rot, fill) => {
    g.beginPath();
    for (let i = 0; i < n * 2; i++) { const a = rot + (i / (n * 2)) * Math.PI * 2, r = (i % 2 ? r0 : r1) * (0.86 + ((i * 7919) % 13) / 60); g.lineTo(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r); }
    g.closePath(); g.fillStyle = fill; g.fill();
  };
  star(74, 126, 13, 0.1, '#0a0a0e'); star(66, 116, 13, 0.1, '#ff7a1a'); star(48, 88, 11, 0.5, '#ffd23a'); star(26, 54, 9, 0.2, '#fff6d8');
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function ringTexture() { // a thick ring with an ink edge inside and out
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S; const g = cv.getContext('2d');
  for (const [r, w, c] of [[108, 26, '#0a0a0e'], [108, 15, '#fff2cf']]) { g.beginPath(); g.arc(S / 2, S / 2, r, 0, Math.PI * 2); g.lineWidth = w; g.strokeStyle = c; g.stroke(); }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function init(ctx) {
  const { scene, events, player, world } = ctx;
  const burstTex = burstTexture(), ringTex = ringTexture();
  const puffGeo = new THREE.IcosahedronGeometry(1, 0), bitGeo = new THREE.BoxGeometry(1, 1, 1);
  const SMOKE = [0x2b2a33, 0x3a3640, 0x4a4450], down = new THREE.Vector3(0, -1, 0), probe = new THREE.Vector3();
  const light = new THREE.PointLight(0xffb060, 0, 16, 1.6); scene.add(light); // one shared flash, kept in the scene so shaders never recompile
  let lightT = 0; const toCam = new THREE.Vector3();

  const pool = Array.from({ length: MAX }, () => {
    const burst = new THREE.Sprite(new THREE.SpriteMaterial({ map: burstTex, alphaTest: 0.5, fog: false, toneMapped: false }));
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: ringTex, alphaTest: 0.5, fog: false, toneMapped: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    const puffs = Array.from({ length: PUFFS }, (_, i) => { const m = new THREE.Mesh(puffGeo, new THREE.MeshBasicMaterial({ color: SMOKE[i % 3], fog: true })); m.userData.v = new THREE.Vector3(); return m; });
    const bits = Array.from({ length: BITS }, () => { const m = new THREE.Mesh(bitGeo, new THREE.MeshStandardMaterial({ color: 0x33363c, roughness: 0.6, metalness: 0.4, emissive: 0x000000 })); m.castShadow = true; m.userData.v = new THREE.Vector3(); m.userData.w = new THREE.Vector3(); return m; });
    for (const o of [burst, ring, ...puffs, ...bits]) { o.visible = false; scene.add(o); }
    return { burst, ring, puffs, bits, t: -1, fuse: 0, bot: null, pos: new THREE.Vector3(), size: 1, floor: 0 };
  });
  ctx.boom = { pool };
  const gone = new Set(); // destroyed machines whose wreck stays hidden until they are rebuilt

  function boomSound(dist, size) {
    const dbg = ctx.audio && ctx.audio.debug, ac = dbg && dbg.context, G = dbg && dbg.graph;
    if (!ac || !G || !G.master || ac.state !== 'running' || dist > 90) return;
    const vol = Math.min(1, 9 / Math.max(6, dist)) * 0.55 * size, t = ac.currentTime, len = 0.9;
    const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * len), ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.2);
    const n = ac.createBufferSource(), lp = ac.createBiquadFilter(), g = ac.createGain(), o = ac.createOscillator(), og = ac.createGain();
    n.buffer = buf; lp.type = 'lowpass'; lp.frequency.setValueAtTime(2400, t); lp.frequency.exponentialRampToValueAtTime(180, t + 0.6);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.type = 'sine'; o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
    og.gain.setValueAtTime(vol * 1.2, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    n.connect(lp); lp.connect(g); g.connect(G.master); o.connect(og); og.connect(G.master); n.start(t); o.start(t); o.stop(t + 0.55);
  }

  function detonate(e) {
    const b = e.bot, size = e.size, c = e.pos;
    if (b && b.mesh && !b.alive) { gone.add(b); }
    probe.set(c.x, c.y + 0.3, c.z); const h = world.raycast(probe, down, 8); e.floor = h ? h.point.y : c.y - 1;
    e.t = 0;
    e.burst.material.rotation = Math.random() * 6; e.burst.visible = true;
    toCam.copy(ctx.camera.position).sub(c).normalize(); e.burst.position.copy(c).addScaledVector(toCam, 0.9); // in front of its own smoke
    e.ring.position.set(c.x, e.floor + 0.08, c.z); e.ring.visible = true;
    const col = b && b.cfg && b.kindColor != null ? b.kindColor : (e.color || 0xff4a1c);
    e.puffs.forEach((p, i) => { const a = (i / PUFFS) * Math.PI * 2 + Math.random(); p.position.set(c.x + Math.cos(a) * 0.3, c.y + rnd(-0.2, 0.5), c.z + Math.sin(a) * 0.3); p.userData.v.set(Math.cos(a) * rnd(1.2, 2.6), rnd(1.6, 3.4), Math.sin(a) * rnd(1.2, 2.6)); p.userData.s = rnd(0.55, 0.95) * size; p.rotation.set(Math.random() * 3, Math.random() * 3, 0); p.scale.setScalar(0.01); p.visible = true; });
    e.bits.forEach((m, i) => {
      const a = Math.random() * Math.PI * 2, up = rnd(3.5, 8.5), out = rnd(2.5, 7);
      m.position.set(c.x, c.y + rnd(-0.3, 0.4), c.z); m.userData.v.set(Math.cos(a) * out, up, Math.sin(a) * out); m.userData.w.set(rnd(-9, 9), rnd(-9, 9), rnd(-9, 9));
      m.scale.set(rnd(0.1, 0.28) * size, rnd(0.08, 0.2) * size, rnd(0.12, 0.34) * size); m.userData.s0 = m.scale.clone();
      m.material.color.setHex(i % 3 === 0 ? col : i % 3 === 1 ? 0xd9d4c8 : 0x2a2d33); m.material.emissive.setHex(i % 3 === 0 ? col : 0x000000); m.material.emissiveIntensity = i % 3 === 0 ? 1.6 : 0; m.visible = true;
    });
    light.position.copy(c); light.intensity = 60 * size; lightT = 0.22;
    const dist = c.distanceTo(player.pos);
    if (dist < 16 && player.dipV != null) player.dipV -= (1 - dist / 16) * 1.6 * size; // you feel the close ones
    boomSound(dist, size);
    events.emit('robotBoom', { point: c.clone(), size, bot: b });
  }

  events.on('botDied', (ev) => {
    const b = ev.bot; if (!b || !ev.point || b.kind === 'turret' || b.kind === 'drone' || b.faction === 'raider') return; // rival crews are people; turrets and drones already blow up
    let e = pool.find((x) => x.t < 0 && x.fuse <= 0); if (!e) { e = pool[0]; for (const x of pool) if (x.t > e.t) e = x; }
    e.bot = b; e.pos.copy(ev.point); e.pos.y += 0.2; e.size = b.kind === 'heavy' || b.hvt ? 1.45 : b.kind === 'scout' ? 0.85 : 1; e.color = (b.cfg && b.cfg.color) || 0xff4a1c;
    e.fuse = FUSE; e.t = -1;
  });
  events.on('raidEnd', () => { gone.clear(); for (const e of pool) { e.t = -1; e.fuse = 0; for (const o of [e.burst, e.ring, ...e.puffs, ...e.bits]) o.visible = false; } light.intensity = 0; });

  return {
    update(dt) {
      if (lightT > 0) { lightT -= dt; light.intensity *= Math.exp(-dt * 14); if (lightT <= 0) light.intensity = 0; }
      for (const b of gone) { if (b.alive) { gone.delete(b); continue; } if (b.mesh && b.mesh.hide) b.mesh.hide(); }
      for (const e of pool) {
        if (e.fuse > 0) { // the wreck sparks where it is falling, then goes up
          e.fuse -= dt;
          if (e.bot && e.bot.c) e.pos.copy(e.bot.c); else if (e.bot && e.bot.pos) e.pos.set(e.bot.pos.x, e.bot.pos.y + 0.9, e.bot.pos.z);
          if (e.fuse <= 0) detonate(e);
          continue;
        }
        if (e.t < 0) continue;
        e.t += dt; const t = e.t, sz = e.size;
        // burst: snaps out, holds a beat, then is gone
        // hard-edged shapes cannot fade, so the burst snaps out, holds a beat and collapses, like a drawn panel
        const bs = (t < 0.08 ? t / 0.08 : t < 0.24 ? 1 + (t - 0.08) * 0.6 : Math.max(0, 1.1 * (1 - (t - 0.24) / 0.09))) * 4.8 * sz; e.burst.scale.set(Math.max(0.001, bs), Math.max(0.001, bs), 1);
        e.burst.visible = t < 0.33;
        const rs = (1 - Math.pow(1 - Math.min(1, t / 0.45), 3)) * 9 * sz; e.ring.scale.set(rs, rs, 1);
        e.ring.visible = t < 0.42;
        for (const p of e.puffs) {
          if (!p.visible) continue;
          const v = p.userData.v; v.multiplyScalar(Math.exp(-dt * 2.2)); v.y += dt * 0.6; p.position.addScaledVector(v, dt);
          const k = t < 0.18 ? t / 0.18 : Math.max(0, 1 - (t - 0.18) / 1.25); p.scale.setScalar(Math.max(0.001, p.userData.s * (t < 0.18 ? k : 0.35 + 0.65 * k) * (t < 0.18 ? 1 : k > 0 ? 1 : 0)));
          if (t > 1.43) p.visible = false;
        }
        for (const m of e.bits) {
          if (!m.visible) continue;
          const v = m.userData.v, w = m.userData.w; v.y -= 22 * dt; m.position.addScaledVector(v, dt);
          if (m.position.y < e.floor + 0.06 && v.y < 0) { m.position.y = e.floor + 0.06; v.y *= -0.35; v.x *= 0.6; v.z *= 0.6; w.multiplyScalar(0.5); }
          m.rotation.x += w.x * dt; m.rotation.y += w.y * dt; m.rotation.z += w.z * dt;
          if (t > 2.2) { const k = Math.max(0, 1 - (t - 2.2) / 0.6); m.scale.copy(m.userData.s0).multiplyScalar(k); if (k <= 0) m.visible = false; }
        }
        if (t > 2.9) e.t = -1;
      }
    },
  };
}
