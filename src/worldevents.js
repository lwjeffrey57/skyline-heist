import * as THREE from 'three';

// Things that happen during a raid whether or not you start them, so there is always somewhere worth going:
//  - Supply drops: a crate comes down on a smoke column; everyone on site heads for it. Rich loot, loud place to be.
//  - The site commander: one guard carries a vault keycard and valuables. Their rough position is on your compass.
// ctx.worldEvents = { marks } — marks are { x, z, title, css, active } and are drawn by the compass and the map.

const DROP = { times: [[110, 170], [380, 450]], fall: 14, height: 90, minDist: 45, maxDist: 110 };
const HVT = { at: 45, hpMul: 2.2, markEvery: 8 }; // a mini-boss: more than twice the health of whoever was picked (a heavy is already plated at the front)
const rnd = (a, b) => a + Math.random() * (b - a);

export function init(ctx) {
  const { player, world, events, scene } = ctx;
  const marks = [];
  ctx.worldEvents = { marks };
  let active = false, elapsed = 0, drops = [], dropTimes = [], hvt = null, hvtMark = null, hvtDue = 0, hvtT = 0;

  // drop visuals: a crate under a canopy, and a tall column of signal smoke that stays until the crate is opened
  const crateGeo = new THREE.BoxGeometry(1.3, 1, 1.3), canopyGeo = new THREE.ConeGeometry(2.4, 1.6, 8, 1, true), beamGeo = new THREE.CylinderGeometry(0.5, 1.1, 60, 8, 1, true);
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x3b4a3a, roughness: 0.7, metalness: 0.2 });
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0xe8e2cf, roughness: 0.9, side: THREE.DoubleSide });
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, fog: false });

  // the mini-boss badge that floats over the commander's head: a crowned purple shield with an ink outline
  const badge = (() => {
    const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S; const g = cv.getContext('2d');
    const shield = (k, fill) => { g.beginPath(); g.moveTo(64, 64 - 54 * k); g.lineTo(64 + 46 * k, 64 - 34 * k); g.lineTo(64 + 40 * k, 64 + 18 * k); g.lineTo(64, 64 + 56 * k); g.lineTo(64 - 40 * k, 64 + 18 * k); g.lineTo(64 - 46 * k, 64 - 34 * k); g.closePath(); g.fillStyle = fill; g.fill(); };
    shield(1, '#0a0a0e'); shield(0.86, '#d48bff'); shield(0.7, '#6b2fa8');
    g.fillStyle = '#ffe14a'; g.strokeStyle = '#0a0a0e'; g.lineWidth = 4; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(38, 78); g.lineTo(34, 44); g.lineTo(50, 58); g.lineTo(64, 36); g.lineTo(78, 58); g.lineTo(94, 44); g.lineTo(90, 78); g.closePath(); g.fill(); g.stroke();
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, alphaTest: 0.5, fog: false, toneMapped: false })); sp.visible = false; scene.add(sp); return sp;
  })();

  const say = (html, color) => { if (ctx.raid && ctx.raid.toast) ctx.raid.toast(html, color); };
  const chime = (...a) => { if (ctx.raid && ctx.raid.chime) ctx.raid.chime(...a); };

  function pickSpot() {
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2, d = rnd(DROP.minDist, DROP.maxDist);
      const x = THREE.MathUtils.clamp(player.pos.x + Math.sin(a) * d, -world.arenaHalf + 12, world.arenaHalf - 12), z = THREE.MathUtils.clamp(player.pos.z + Math.cos(a) * d, -world.arenaHalf + 12, world.arenaHalf - 12);
      if (Math.hypot(x - player.pos.x, z - player.pos.z) < DROP.minDist) continue;
      if (world.buildings.concat(world.outbuildings || []).some((b) => Math.abs(x - b.x) < b.w / 2 + 3 && Math.abs(z - b.z) < b.d / 2 + 3)) continue; // open ground only
      if (!player.free(x, 0.05, z, 1.8)) continue;
      return [x, z];
    }
    return null;
  }
  function startDrop() {
    const spot = pickSpot(); if (!spot) return;
    const [x, z] = spot, g = new THREE.Group();
    const crate = new THREE.Mesh(crateGeo, crateMat); crate.position.y = 0.5; crate.castShadow = true;
    const canopy = new THREE.Mesh(canopyGeo, canopyMat); canopy.position.y = 3.2;
    const beam = new THREE.Mesh(beamGeo, beamMat); beam.position.set(x, 30, z);
    g.add(crate, canopy); g.position.set(x, DROP.height, z); scene.add(g, beam);
    const mark = { x, z, title: 'DROP', css: '#ff9a3c', active: true };
    marks.push(mark);
    drops.push({ x, z, g, canopy, beam, mark, t: 0, landed: false, loot: null });
    const where = ctx.raid && ctx.raid.districtAt ? ctx.raid.districtAt(x, z) : '';
    say(`Supply drop coming down${where ? ` — ${where}` : ''}. Everyone on site saw it.`, '#ff9a3c'); chime([520, 390, 520, 390], 0.14, 0.3, 0.2, 'triangle');
    events.emit('supplyDrop', { x, z });
  }
  function land(d) {
    d.landed = true; scene.remove(d.g);
    const raid = ctx.raid;
    if (raid && raid.addLootable) {
      const items = raid.rollContents('vault');
      items.push({ supply: 'armor', name: 'Armour plate' }, { supply: 'medkit', name: 'Medkit' });
      if (Math.random() < 0.5) items.push({ supply: 'key', name: 'Keycard' });
      if (raid.prizeGun) items.push(raid.prizeGun()); // a drop always holds a gun the shop does not sell
      d.loot = raid.addLootable('secure', d.x, 0, d.z, Math.random() * 3, items);
    }
    if (ctx.bots && ctx.bots.hunt) ctx.bots.hunt(new THREE.Vector3(d.x, 0, d.z), 3); // guards go to see what landed
    say('Supply drop is down', '#ff9a3c');
    events.emit('supplyDropLanded', { x: d.x, z: d.z });
  }
  function endDrop(d) { d.mark.active = false; scene.remove(d.beam); scene.remove(d.g); const i = marks.indexOf(d.mark); if (i >= 0) marks.splice(i, 1); }

  function pickHvt() {
    if (!ctx.bots) return;
    const pool = ctx.bots.list.filter((b) => b.alive && b.kind !== 'raider' && (!b.faction || b.faction === 'guard'));
    if (!pool.length) return;
    // prefer a heavy, and someone well away from you
    pool.sort((a, b) => (b.kind === 'heavy') - (a.kind === 'heavy') || Math.hypot(b.pos.x - player.pos.x, b.pos.z - player.pos.z) - Math.hypot(a.pos.x - player.pos.x, a.pos.z - player.pos.z));
    hvt = pool[0]; hvt.hvt = true; hvt.maxHp = Math.round(hvt.maxHp * HVT.hpMul); hvt.hp = hvt.maxHp; hvt.name = 'Site commander';
    hvtMark = { x: hvt.pos.x, z: hvt.pos.z, title: 'COMMANDER', css: '#d48bff', active: true };
    marks.push(hvtMark); hvtT = HVT.markEvery;
    say('The site commander is here, carrying a vault keycard. Heavily armoured — look for the crowned badge. Last known position is on your compass.', '#d48bff'); chime([440, 554, 659], 0.1, 0.3, 0.18, 'triangle');
  }
  function clearHvt() { badge.visible = false; if (hvt) hvt.hvt = false; hvt = null; if (hvtMark) { const i = marks.indexOf(hvtMark); if (i >= 0) marks.splice(i, 1); hvtMark = null; } }

  events.on('raidStart', () => {
    active = true; elapsed = 0; for (const d of drops) endDrop(d); drops = []; clearHvt(); marks.length = 0;
    dropTimes = DROP.times.map(([a, b]) => rnd(a, b)); hvtDue = HVT.at;
  });
  events.on('raidEnd', () => { active = false; for (const d of drops) endDrop(d); drops = []; clearHvt(); marks.length = 0; });
  events.on('botDied', (e) => {
    if (!hvt || e.bot !== hvt) return;
    const mine = e.by === player;
    clearHvt(); // raid.js fills the commander's dropped pack (it sees bot.hvtDrop)
    say(mine ? 'Site commander down — their pack has the keycard' : 'Someone else got to the site commander. Their pack is still where they fell.', '#d48bff');
  });

  events.on('raidersEntered', () => { if (active) { say('Another crew has entered the site', '#e0a83a'); chime([330, 277], 0.16, 0.3, 0.16, 'triangle'); } });
  events.on('raiderSquadDown', () => { if (active) say('A rival crew has been wiped out', '#e0a83a'); });
  events.on('raidersLeaving', () => { if (active) say('A rival crew is heading for an exit with their haul', '#e0a83a'); });

  return {
    update(dt) {
      if (!active || !ctx.raid || ctx.raid.state !== 'raid' || ctx.rangeMode) return;
      elapsed += dt;
      if (dropTimes.length && elapsed >= dropTimes[0]) { dropTimes.shift(); startDrop(); }
      if (hvtDue && elapsed >= hvtDue) { hvtDue = 0; pickHvt(); }
      if (hvt) {
        if (!hvt.alive || !hvt.hvt) clearHvt();
        else { // the badge rides above the head and holds its size on screen out to a distance, so you can pick them out
          const d = Math.hypot(hvt.pos.x - player.pos.x, hvt.pos.z - player.pos.z), k = Math.max(1.15, Math.min(3.4, d / 9));
          badge.visible = true; badge.position.set(hvt.pos.x, hvt.pos.y + (hvt.height || 1.9) + 0.5 + k * 0.25 + Math.sin(elapsed * 3) * 0.05, hvt.pos.z); badge.scale.set(k, k, 1);
          hvtT -= dt; if (hvtT <= 0) { hvtT = HVT.markEvery; hvtMark.x = hvt.pos.x; hvtMark.z = hvt.pos.z; } // a position report every few seconds, not a live tracker
        }
      }
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        if (!d.landed) {
          d.t += dt; const k = Math.min(1, d.t / DROP.fall);
          d.g.position.y = DROP.height * (1 - k); d.g.rotation.y += dt * 0.4; d.canopy.rotation.z = Math.sin(d.t * 1.7) * 0.08;
          if (k >= 1) land(d);
        } else {
          d.beam.material.opacity = 0.18 + Math.sin(elapsed * 2) * 0.05;
          if (!d.loot || d.loot.opened) { endDrop(d); drops.splice(i, 1); }
        }
      }
    },
  };
}
