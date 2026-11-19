import * as THREE from 'three';

// Melee (V): a fast knife strike. Two hits drop a standard guard; an enemy who has not noticed you goes down in one,
// silently — the reward for the quiet opening. A hit carries you a step forward, so it chains with movement.
// Emits `melee { hit, takedown, target }`, plus the usual `impact` / `hitmarker` so effects and markers respond.

const CFG = { range: 2.7, cone: 0.62, damage: 70, cooldown: 0.55, swing: 0.26, strikeAt: 0.09, lunge: 7.5, lungeRange: 4.2 };

export function init(ctx) {
  const { camera, player, events, input, world } = ctx;
  // the knife: a few boxes parented to the camera, shown only while swinging
  const knife = new THREE.Group(); knife.visible = false;
  const steel = new THREE.MeshStandardMaterial({ color: 0xcfd6dd, roughness: 0.25, metalness: 0.9 }), grip = new THREE.MeshStandardMaterial({ color: 0x1e2226, roughness: 0.8 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.012, 0.24), steel); blade.position.z = -0.17;
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.014, 0.2), steel); edge.position.set(0.02, 0, -0.17);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.02, 0.02), grip); guard.position.z = -0.045;
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.036, 0.12), grip); handle.position.z = 0.02;
  const fist = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.09, 0.1), new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.9 })); fist.position.set(0, -0.02, 0.03);
  knife.add(blade, edge, guard, handle, fist); camera.add(knife);
  // a slash arc drawn across the screen for a moment
  const style = document.createElement('style');
  style.textContent = `
    #ml-arc { position: fixed; left: 50%; top: 50%; width: 46vh; height: 46vh; margin: -23vh 0 0 -23vh; pointer-events: none; opacity: 0; border-radius: 50%;
      border: 0.9vh solid transparent; border-top-color: rgba(255,255,255,.92); border-right-color: rgba(255,255,255,.35); filter: drop-shadow(0 0 6px rgba(160,220,255,.7)); }
    #ml-arc.go { animation: ml-slash .22s ease-out; }
    @keyframes ml-slash { 0% { opacity: 0; transform: rotate(-70deg) scale(.8); } 25% { opacity: 1; } 100% { opacity: 0; transform: rotate(55deg) scale(1.08); } }`;
  document.head.appendChild(style);
  const arc = document.createElement('div'); arc.id = 'ml-arc'; ctx.hud.appendChild(arc);

  let cd = 0, t = -1, struck = false;
  const fwd = new THREE.Vector3(), eye = new THREE.Vector3(), to = new THREE.Vector3(), tp = new THREE.Vector3();

  function sound(kind) {
    const dbg = ctx.audio && ctx.audio.debug, ac = dbg && dbg.context, G = dbg && dbg.graph;
    if (!ac || !G || !G.master || ac.state !== 'running') return;
    const now = ac.currentTime, len = kind === 'hit' ? 0.16 : 0.2, buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * len), ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, kind === 'hit' ? 3 : 1.2);
    const n = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(); n.buffer = buf;
    if (kind === 'hit') { f.type = 'lowpass'; f.frequency.value = 900; g.gain.value = 0.5; }
    else { f.type = 'bandpass'; f.Q.value = 2; f.frequency.setValueAtTime(900, now); f.frequency.exponentialRampToValueAtTime(3200, now + 0.09); f.frequency.exponentialRampToValueAtTime(700, now + len); g.gain.value = 0.22; }
    n.connect(f); f.connect(g); g.connect(G.master); n.start(now);
  }

  // the nearest enemy inside reach and roughly in front, with nothing solid in between
  function findTarget(range) {
    let best = null, bd = range;
    for (const o of ctx.targets) {
      if (o === player || !o.alive || !o.takeDamage) continue;
      tp.set(o.pos.x, o.pos.y + (o.height || 1.6) * 0.6, o.pos.z); to.copy(tp).sub(eye); const d = to.length();
      if (d > bd + (o.radius || 0.4)) continue;
      if (to.normalize().dot(fwd) < CFG.cone) continue;
      if (d > 0.6 && !world.lineOfSight(eye, tp)) continue;
      best = o; bd = d;
    }
    return best;
  }
  function strike() {
    const o = findTarget(CFG.range);
    if (!o) { // nothing living in reach: chip whatever is in front
      const h = world.raycast(eye, fwd, CFG.range);
      if (h && ctx.destruction) { ctx.destruction.hit(h.collider, h.point, h.normal, 25); events.emit('impact', { point: h.point, normal: h.normal, kind: 'world', collider: h.collider, damage: 25, by: player, weapon: 'melee' }); sound('hit'); }
      events.emit('melee', { hit: false }); return;
    }
    const unaware = o.alertState === 'unaware' || (o.alertState == null && (o.awareness || 0) < 0.3);
    const takedown = unaware && !o.isTurret && o.kind !== 'drone'; // they never saw it coming
    const dmg = takedown ? Math.max(9999, o.hp + 1) : CFG.damage, before = o.hp;
    tp.set(o.pos.x, o.pos.y + (o.height || 1.6) * 0.6, o.pos.z);
    const point = tp.clone().addScaledVector(fwd, -(o.radius || 0.4)), dir = fwd.clone();
    const res = o.takeDamage(dmg, { source: player, from: eye.clone(), point, dir, weapon: 'melee', headshot: false, silent: takedown });
    if (res === 'blocked') { sound('hit'); events.emit('melee', { hit: false, blocked: true, target: o }); return; } // the blade rings off a shield
    const kill = !o.alive;
    events.emit('impact', { point, normal: dir.clone().negate(), kind: 'flesh', target: o, damage: Math.min(dmg, before), by: player, headshot: false, kill, weapon: 'melee' });
    events.emit('hitmarker', { headshot: false, kill, damage: Math.min(dmg, before) });
    events.emit('melee', { hit: true, takedown, target: o, kill });
    if (takedown && ctx.raid && ctx.raid.toast) ctx.raid.toast('Silent takedown', '#8ff0c8');
    if (player.dipV != null) player.dipV -= 0.5;
    sound('hit');
  }

  return {
    update(dt) {
      cd -= dt;
      const inRaid = !ctx.raid || ctx.raid.state === 'raid';
      if (inRaid && !player.downed && !ctx.uiOpen && cd <= 0 && input.pressed.has('KeyV')) {
        cd = CFG.cooldown; t = 0; struck = false; knife.visible = true;
        arc.classList.remove('go'); void arc.offsetWidth; arc.classList.add('go'); sound('swing');
        camera.getWorldDirection(fwd); eye.copy(camera.position);
        // step in: a target just out of reach pulls you forward into it
        if (findTarget(CFG.lungeRange) && player.state === 'normal') { player.vel.x += fwd.x * CFG.lunge; player.vel.z += fwd.z * CFG.lunge; }
      }
      if (t < 0) return;
      t += dt; const k = Math.min(1, t / CFG.swing), e = 1 - Math.pow(1 - k, 3);
      // a diagonal cut from low right to high left, through the centre of the view
      knife.position.set(0.34 - 0.62 * e, -0.3 + 0.2 * e, -0.42 - 0.2 * Math.sin(k * Math.PI));
      knife.rotation.set(0.5 - 0.7 * e, 0.9 - 1.5 * e, -0.9 + 1.3 * e);
      if (!struck && t >= CFG.strikeAt) { struck = true; camera.getWorldDirection(fwd); eye.copy(camera.position); strike(); }
      if (k >= 1) { t = -1; knife.visible = false; }
    },
  };
}
