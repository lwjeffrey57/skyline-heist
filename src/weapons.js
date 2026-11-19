import * as THREE from 'three';
import { WEAPONS, PROJECTILES, GRENADE, FEEL, SCORE } from './weapons/defs.js';
import { buildViewmodel } from './weapons/viewmodels.js';
import { createHud } from './weapons/hud.js';
import { createProjectiles } from './weapons/projectiles.js';
import { createCasings } from './weapons/casings.js';
import { ATTACHMENTS, SLOT_NAMES, attachment, slotsFor, fits, cleanSet, effectiveDef, summary } from './weapons/attachments.js';
import { applyAttachments } from './weapons/attachparts.js';

// Weapons system: gun logic, first-person viewmodel + animation, recoil / camera feel, weapon HUD.
// All tuning lives in ./weapons/defs.js. Contract: see core.js. Effects and sound are made by other
// systems from the events emitted here ('shot', 'impact', 'hitmarker', 'explosion', 'reload', ...).
//
// Events emitted here (player's guns only):
//   shot          { weapon, name, origin, dir, dirs, muzzle, by, pellets, suppressed }   (launcher: projectile:true, no dirs)
//   impact        { point, normal, kind, collider? | target?, damage, by, headshot?, kill?, weapon }
//   hitmarker     { headshot, kill, damage }            killConfirm { headshot, multi, streak, points, target, weapon }
//   reload        { weapon, time, tactical, empty }     time = seconds this reload will take
//   reloadStage   { weapon, stage:'out'|'in'|'charge', tactical }   magazine out / magazine seated / bolt or slide released
//                 ('charge' only on an empty reload; fired in step with the viewmodel animation)
//   reloadDone    { weapon, tactical }   ammo is in the gun        reloadCancel { weapon }   aborted by firing / switching
//   shellInsert   { weapon }             dryFire { weapon }        weaponSwitch { weapon, name }   fireMode { weapon, mode }
//   lowAmmo       { weapon, frac, left } with every shot from the last 30% of a magazine (frac = rounds left / magazine, 0 = empty)
//   attachments   { weapon, set:{ slot: id } }   a gun's attachments changed (setAttachments)
// 'shot' also carries `loud` (1 = normal; a compensator / brake raises it) and, for a weapon with no muzzle blast
// (crossbow), `noFlash: true` and NO `dir` (fx draws nothing for it; `dirs` still holds the line of fire).
// A hand-worked action (lever) reports its cycle as reloadStage { stage:'charge', cycle:true } after each shot.
//
// Attachments: every inventory slot has `base` (the shared def from defs.js, never modified) and `def` (its own
// effective def = base + fitted attachments; the object is stable, it is rewritten in place when the set changes).
// See ./weapons/attachments.js for the catalogue and the API at the bottom of this file.
// Listened for (optional): botStagger { bot?, by?, armorBreak? } -> small ring on the hit marker.

const D2R = Math.PI / 180;
const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const easeOut = (x) => 1 - (1 - x) * (1 - x) * (1 - x);
const smooth = (x) => x * x * (3 - 2 * x);
const STAGE = ['out', 'in', 'charge'];

class Spring {
  constructor(k, d) { this.k = k; this.d = d; this.x = 0; this.v = 0; }
  step(dt, target = 0) {
    const n = Math.max(1, Math.ceil(dt / 0.006)), h = dt / n;
    for (let i = 0; i < n; i++) { this.v += (-this.k * (this.x - target) - this.d * this.v) * h; this.x += this.v * h; }
    return this.x;
  }
  kick(amount, max = Infinity) { this.x = clamp(this.x + amount, -max, max); }
}

// Keep the viewmodel in front of the world: squash its depth toward the near plane (ordering inside the model is kept).
function patchDepth(mat) {
  if (mat.isShaderMaterial) return; // the optic lenses do it in their own shader
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n\tgl_Position.z = mix(gl_Position.z, -gl_Position.w, 0.9);');
  };
  mat.customProgramCacheKey = () => 'wp-vm';
}

export function init(ctx) {
  const { player, input, events, camera, world } = ctx;

  // ---- inventory + viewmodels ------------------------------------------------
  const vmRoot = new THREE.Group(); vmRoot.name = 'wp-viewmodel';
  camera.add(vmRoot);
  const dress = (o) => { if (o.isMesh) { patchDepth(o.material); o.renderOrder = o.material.isShaderMaterial || o.material.transparent ? 12 : 10; } };
  const inv = WEAPONS.map((base) => {
    const vm = buildViewmodel(base.id);
    const pose = new THREE.Group(); pose.add(vm.group); pose.visible = false; vmRoot.add(pose);
    vm.group.traverse(dress);
    const sight = vm.sight, def = effectiveDef(base, null, player.baseFov);
    return {
      base, def, att: {}, attLabel: '', supVis: !!def.suppressed, vm, pose, mag: def.mag, reserve: def.reserve, mode: def.modes[0], regenT: 0,
      hip: new THREE.Vector3(def.view.hip[0], def.view.hip[1], -def.view.hip[2]),
      adsPos: new THREE.Vector3(-sight[0], -sight[1], -(def.view.adsDist ?? 0.24) + sight[2]),
    };
  });
  // Rebuild one slot's effective def (in place: other systems hold on to `def`) and dress its viewmodel.
  function refit(it, fill = false) {
    const ext = it.def.suppressed; // may have been set from outside (raid.js: the pistol-suppressor upgrade)
    const d = effectiveDef(it.base, it.att, player.baseFov);
    for (const k in it.def) delete it.def[k];
    Object.assign(it.def, d);
    if (!it.base.suppressed && ext !== undefined) it.def.suppressed = ext;
    dressVm(it);
    if (fill) { it.mag = d.mag; it.reserve = d.reserve; }
    else { if (it.mag > d.mag + 1) { it.reserve += it.mag - d.mag; it.mag = d.mag; } it.reserve = Math.min(it.reserve, d.reserve); }
    if (!d.modes.includes(it.mode)) it.mode = d.modes[0];
    it.attLabel = SLOT_NAMES.filter((s) => it.att[s]).map((s) => attachment(it.att[s]).short).join('  ');
  }
  function dressVm(it) {
    const d = it.def, vm = it.vm, vis = { ...it.att };
    it.supVis = !!d.suppressed;
    // a suppressor that came from outside the attachment system (base upgrade) is still shown on the gun
    if (it.supVis && !it.base.suppressed && !vis.muzzle && vm.mounts.muzzle) vis.muzzle = 'suppressor';
    for (const n of applyAttachments(vm, vis, d)) n.traverse(dress);
    const sight = vm.sight;
    let adsDist = d.view.adsDist ?? 0.24;
    // an optic that sits further forward / back than the factory sight: keep the gun where it was, within reason
    if (sight !== vm.base.sight && !d.ads.scope) adsDist = clamp(adsDist + (sight[2] - vm.base.sight[2]), 0.14, 0.42);
    it.hip.set(d.view.hip[0], d.view.hip[1], -d.view.hip[2]);
    it.adsPos.set(-sight[0], -sight[1], -adsDist + sight[2]);
  }

  const S = {
    idx: 0, last: 1, pending: -1, state: 'equip', t: 0, // state: equip | ready | holster | reload
    rl: null, ads: 0, sprint: 0, lower: 0,
    nextFire: 0, burstLeft: 0, lastShot: -10, spray: 0, bloom: 0, heat: 0, cueT: 0, cueW: '',
    fireBuf: 0, spread: 0, shots: 0,
    grenades: GRENADE.charges, grenT: 0, throwT: -1, thrown: false,
    lastPitch: player.pitch, lastYaw: player.yaw,
    bobAmp: 0, scopeKick: 0, ejects: [], trig: 0, lean: 0, leanV: 0, slideK: 0, zipK: 0,
    wasAds: false, adsFull: false, clickT: -10,
  };
  const rec = { tp: 0, ty: 0, ap: 0, ay: 0 }; // aim recoil (radians): target / applied. ty > 0 = to the right
  const sp = {
    kz: new Spring(520, 34), krx: new Spring(480, 30), krz: new Spring(380, 24), kry: new Spring(380, 26), // shot kick
    kx: new Spring(700, 30), ky: new Spring(700, 30), // shot jolt (sideways / vertical shake of the gun)
    climb: new Spring(95, 15), // slow muzzle rise that builds over a burst, then settles
    y: new Spring(190, 17), rx: new Spring(170, 16), rz: new Spring(150, 15), // body motion (jump, land, slide)
    camP: new Spring(420, 30), camY: new Spring(420, 30), camR: new Spring(300, 22), // camera punch
  };
  const sway = { x: 0, y: 0, mx: 0, mz: 0, vy: 0 };
  // look sway: under-damped, so the gun trails a turn and swings a little past centre when the turn stops (weight)
  const sw = { rx: new Spring(150, 13), ry: new Spring(150, 13), rz: new Spring(110, 11) };
  const shake = { t: 0, amp: 0 };
  const out = { p: new THREE.Vector3(), r: new THREE.Vector3() };
  // the reload pose that was on screen when a reload ended early (cancelled / cut short by firing): eased out, never popped
  const carry = { p: new THREE.Vector3(), r: new THREE.Vector3(), lp: new THREE.Vector3(), lr: new THREE.Vector3(), k: 0 };
  // reused every frame (no per-frame garbage)
  const animRl = { phase: '', t: 0, n: 0, pump: false, to: 0, tac: false, end: 1 };
  const animS = { time: 0, cycle: 0, mag: 0, magSize: 0, reserve: 0, heat: 0, rl: null, mode: '', trigger: 0 };
  const hudS = { att: '', w: null, idx: 0, inv: null, mag: 0, reserve: 0, mode: '', spreadPx: 0, ads: 0, adsScope: false, sight: true, reload: -1, sprint: 0, hidden: false, comboLeft: 0, grenades: 0, grenMax: 0, grenCharge: 0, scopePx: null };
  const scopeS = { x: 0, y: 0, r: 0, a: 0 };
  const _ev = new THREE.Vector3(), _ep = new THREE.Vector3();
  const cur = () => inv[S.idx];
  const DIGITS = inv.map((_, i) => 'Digit' + (i + 1));

  const hud = createHud(ctx, WEAPONS);
  const casings = createCasings(ctx);
  const proj = createProjectiles(ctx, {
    onBlastHit(t, dmg, killed, kind) { if (t !== player) { if (killed) onKill({ target: t, headshot: false, dist: t.pos.distanceTo(player.pos), weapon: kind === 'frag' ? GRENADE.name : 'DOORKNOCKER', blast: true }); events.emit('hitmarker', { headshot: false, kill: killed }); hud.hit({ headshot: false, kill: killed }); } },
    onBlast(point, radius) {
      const d = point.distanceTo(camera.position);
      const k = clamp(1 - d / (radius * 3.5), 0, 1);
      if (k > 0) { shake.t = 0.45; shake.amp = Math.max(shake.amp, FEEL.explosionShake * k * k); sp.camP.kick(0.03 * k); sp.y.kick(-0.03 * k); sp.rz.kick((Math.random() - 0.5) * 0.2 * k); }
    },
  });

  // ---- kills + arcade score ------------------------------------------------------
  const score = { total: 0, streak: 0, kills: 0, headshots: 0, multi: 0, bestStreak: 0, lastKillT: -99 };
  ctx.score = score;
  // info: { target, headshot, dist, weapon (display name), blast }
  function onKill(info) {
    const headshot = !!info.headshot;
    for (const w of inv) w.reserve = Math.min(w.def.reserve, w.reserve + w.def.killRefund);
    camera.fov -= headshot ? FEEL.headshotKillFovPunch : FEEL.killFovPunch; // quick zoom pop
    score.kills++; if (headshot) score.headshots++;
    score.streak++; score.bestStreak = Math.max(score.bestStreak, score.streak);
    score.multi = ctx.time - score.lastKillT <= SCORE.multiWindow ? score.multi + 1 : 1;
    score.lastKillT = ctx.time;
    const mult = Math.min(SCORE.streakMultMax, 1 + (score.streak - 1) * SCORE.streakMult);
    const parts = [], add = (reason, pts, cls, label) => parts.push({ reason, points: Math.round(pts * mult / 5) * 5, cls, label: label || SCORE.labels[reason] });
    add('kill', SCORE.kill, '');
    if (headshot) add('headshot', SCORE.headshot, 'wp-gold');
    if (info.blast) add('blast', SCORE.blast, 'wp-hot');
    else if (info.dist >= SCORE.longRangeDist) add('longRange', SCORE.longRange, 'wp-cyan');
    else if (info.dist <= SCORE.pointBlankDist) add('pointBlank', SCORE.pointBlank, 'wp-cyan');
    const m = SCORE.multi[Math.min(5, score.multi)];
    if (m) add('multikill', m[1], 'wp-hot', m[0]);
    if (score.streak % SCORE.streakEvery === 0) add('streak', SCORE.streakBonus, 'wp-gold', `${score.streak} ${SCORE.labels.streak}`);
    let points = 0;
    for (const p of parts) { score.total += p.points; points += p.points; events.emit('score', { points: p.points, reason: p.reason, total: score.total, streak: score.streak, multi: score.multi }); }
    events.emit('killConfirm', { headshot, multi: score.multi, streak: score.streak, points, target: info.target, weapon: info.weapon });
    hud.scoreKill({ parts, total: score.total, streak: score.streak, mult, multi: score.multi, multiName: m ? m[0] : '', multiPoints: m ? parts.find((p) => p.reason === 'multikill').points : 0,
      weaponName: info.weapon, targetName: String((info.target && info.target.name) || 'HOSTILE').toUpperCase(), headshot, points });
  }
  events.on('playerDied', () => { score.streak = 0; score.multi = 0; score.lastKillT = -99; hud.died(); });

  // ---- state changes -----------------------------------------------------------
  function switchTo(i, instant = false) {
    if (i === S.idx && S.pending < 0 || i === S.pending || i < 0 || i >= inv.length) return;
    if (inv[i].locked) return; // not carried right now (raid.js sets this)
    if (i === S.idx) { S.pending = -1; if (S.state === 'holster') { S.state = 'equip'; S.t = (1 - S.t / FEEL.holster) * cur().def.equip * 0.5; } return; }
    S.pending = i; endReload(true); S.burstLeft = 0;
    if (instant) { raise(); return; }
    if (S.state !== 'holster') { S.state = 'holster'; S.t = 0; }
  }
  function raise() {
    cur().pose.visible = false;
    S.last = S.idx; S.idx = S.pending; S.pending = -1;
    S.state = 'equip'; S.t = 0; S.spray = 0; S.bloom = 0; S.rl = null; carry.k = 0; S.ejects.length = 0;
    rec.tp = rec.ty = rec.ap = rec.ay = 0;
    cur().pose.visible = true;
    events.emit('weaponSwitch', { weapon: cur().def.id, name: cur().def.name });
  }
  // a reload ends (finished, cancelled, cut short): whatever pose it was in is eased out by `carry`
  function endReload(cancelled = false) {
    if (!S.rl) return;
    const w = cur();
    if (cancelled) events.emit('reloadCancel', { weapon: w.def.id });
    carry.p.copy(carry.lp); carry.r.copy(carry.lr); carry.k = 1;
    S.rl = null;
  }
  function startReload() {
    const w = cur(), r = w.def.reload;
    if (S.state !== 'ready' || w.mag >= w.def.mag || w.reserve <= 0) return false;
    S.state = 'reload'; S.burstLeft = 0;
    // tactical reload: rounds left, so one stays chambered (mag + 1) and the charge is skipped
    const tac = r.type === 'mag' && !!r.tactical && w.mag > 0;
    S.rl = r.type === 'shell' ? { type: 'shell', phase: 'start', t: 0, n: 0, pump: w.mag === 0, done: false, stop: false }
      : { type: 'mag', phase: 'mag', t: 0, done: false, to: Math.min(w.def.mag, w.mag + w.reserve), tac, end: tac ? r.tactical : 1, stage: 0, spent: w.def.mag - w.mag };
    events.emit('reload', { weapon: w.def.id, time: r.type === 'shell' ? r.start + r.shell : r.time * S.rl.end, tactical: tac, empty: w.mag === 0 });
    return true;
  }
  function updateReload(dt) {
    const w = cur(), r = w.def.reload, rl = S.rl;
    if (rl.type === 'mag') {
      // a fresh click with rounds in the gun, before the new magazine is seated, aborts the reload and fires
      const charge = r.stages && r.stages[2] != null ? r.stages[2] : Math.min(0.9, r.commit + 0.12);
      const fireAt = rl.tac ? r.commit + 0.06 : r.stages ? charge + 0.1 : r.commit + 0.12;
      if (ctx.time - S.clickT < 0.05 && S.fireBuf > 0) { // a fresh click
        const wait = (fireAt - rl.t) * r.time;
        // ...when the gun is nearly ready again: kept, and fired the moment it is
        if (wait < 0.35) S.fireBuf = Math.max(S.fireBuf, wait + 0.06);
        // ...with rounds still in the gun and the new magazine not close to seated: abort the reload and fire
        else if (!rl.done && w.mag > 0) {
          endReload(true); S.state = 'ready';
          S.nextFire = Math.max(S.nextFire, ctx.time + FEEL.reloadCancel); S.fireBuf = FEEL.reloadCancel + 0.08;
          return;
        }
      }
      rl.t += dt / r.time;
      while (rl.stage < (rl.tac ? 2 : 3)) {
        const at = r.stages ? r.stages[rl.stage] : rl.stage === 0 ? 0.12 : rl.stage === 1 ? r.commit : charge;
        if (at == null) { rl.stage++; continue; } // this gun has no such step
        if (rl.t < at) break;
        events.emit('reloadStage', { weapon: w.def.id, stage: STAGE[rl.stage], tactical: rl.tac });
        if (rl.stage === 0 && r.dump && w.vm.eject) dumpCases(w, rl.spent);
        rl.stage++;
      }
      if (!rl.done && rl.t >= r.commit) {
        rl.done = true;
        const n = Math.min(w.def.mag + (rl.tac ? 1 : 0) - w.mag, w.reserve); w.mag += n; w.reserve -= n;
        events.emit('reloadDone', { weapon: w.def.id, tactical: rl.tac });
      }
      // ammo is in: a buffered click cuts the rest of the animation short (after the charge on an empty reload)
      if (rl.t >= rl.end || (rl.done && S.fireBuf > 0 && rl.t > fireAt)) { S.state = 'ready'; endReload(); }
      return;
    }
    if (S.fireBuf > 0 && w.mag > 0) rl.stop = true; // firing interrupts
    if (rl.stop) S.fireBuf = Math.max(S.fireBuf, 0.05); // ...and the click is kept until the gun is up
    if (rl.phase === 'start') { rl.t += dt / r.start; if (rl.t >= 1) { rl.phase = 'loop'; rl.t = 0; rl.done = false; } }
    else if (rl.phase === 'loop') {
      rl.t += dt / r.shell;
      if (!rl.done && rl.t >= r.insert) { rl.done = true; w.mag++; w.reserve--; rl.n++; events.emit('shellInsert', { weapon: w.def.id }); }
      if (rl.t >= 1 || (rl.stop && (rl.done || rl.t < 0.2))) {
        if (rl.stop || w.mag >= w.def.mag || w.reserve <= 0) { rl.phase = 'end'; rl.t = rl.stop && !rl.pump ? 0.5 : 0; }
        else { rl.t = 0; rl.done = false; }
      }
    } else { rl.t += dt / r.end; if (rl.t >= 1 || (rl.stop && !rl.pump && rl.t > 0.6)) { S.state = 'ready'; endReload(); } }
  }

  // revolver: the spent cases fall out together when the cylinder is opened
  function dumpCases(it, n) {
    camera.updateMatrixWorld(true);
    it.vm.eject.getWorldPosition(_ep);
    for (let i = 0; i < n; i++) {
      _ev.set((Math.random() - 0.5) * 0.9, -0.6 - Math.random() * 0.8, (Math.random() - 0.5) * 0.9).add(player.vel);
      casings.spawn(_ep, _ev, it.def.id);
    }
  }

  // ---- shooting -------------------------------------------------------------------
  const _dir = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3(), _d = new THREE.Vector3(), _m = new THREE.Vector3();
  function aimBasis() {
    const p = clamp(player.pitch + sp.camP.x, -1.55, 1.55), y = player.yaw + sp.camY.x;
    _dir.set(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
    _right.set(Math.cos(y), 0, -Math.sin(y));
    _up.crossVectors(_right, _dir);
  }
  function spreadDir(angleRad, a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random())) {
    const t = Math.tan(angleRad) * r;
    return _d.copy(_dir).addScaledVector(_right, Math.cos(a) * t).addScaledVector(_up, Math.sin(a) * t).normalize().clone();
  }
  function muzzlePos(origin) {
    camera.updateMatrixWorld(true);
    cur().vm.muzzle.getWorldPosition(_m);
    const to = _m.clone().sub(origin), len = to.length();
    if (len > 1e-3) { to.multiplyScalar(1 / len); const h = world.raycast(origin, to, len + 0.05); if (h) _m.copy(origin).addScaledVector(to, Math.max(0, h.dist - 0.08)); }
    return _m.clone();
  }

  function bullet(w, origin, dir, agg) {
    const hit = ctx.hitscan(origin, dir, w.range, player);
    if (!hit) return;
    const [f0, f1, fm] = w.falloff;
    let dmg = w.damage * lerp(1, fm, clamp((hit.dist - f0) / (f1 - f0), 0, 1));
    if (hit.type === 'world') {
      ctx.destruction.hit(hit.collider, hit.point, hit.normal, dmg);
      events.emit('impact', { point: hit.point, normal: hit.normal.clone(), kind: 'world', collider: hit.collider, damage: dmg, by: player, weapon: w.id });
    } else {
      const t = hit.target;
      let head = !!hit.headshot;
      if (head && w.headR) {
        // closest approach of the bullet's line to the target's vertical centre line (seen from above)
        const ox = t.pos.x - origin.x, oz = t.pos.z - origin.z, dl = Math.hypot(dir.x, dir.z);
        if (dl > 1e-4 && Math.abs(ox * dir.z - oz * dir.x) / dl > w.headR) head = false;
      }
      if (head) dmg *= w.headMult;
      t.takeDamage(dmg, { from: origin.clone(), source: player, headshot: head, weapon: w.id });
      const kill = !t.alive;
      events.emit('impact', { point: hit.point, normal: hit.normal.clone(), kind: 'flesh', target: t, damage: dmg, by: player, headshot: head, kill, weapon: w.id });
      agg.hit = true; agg.head = agg.head || head; agg.kill = agg.kill || kill; agg.dmg += dmg;
      if (head) agg.heads.add(t);
      if (kill) agg.kills.push({ target: t, dist: hit.dist });
    }
  }

  function fire() {
    const it = cur(), w = it.def;
    it.mag--; S.shots++;
    aimBasis();
    const origin = camera.position.clone();
    const aim = _dir.clone();
    const muzzle = muzzlePos(origin);
    const spreadRad = S.spread * D2R;
    const dirs = [];
    if (w.projectile) {
      const d = spreadDir(spreadRad);
      dirs.push(d);
      // start just ahead of the camera (or at the camera if a wall is right there)
      const start = origin.clone().addScaledVector(d, 0.6).addScaledVector(_right, 0.1).addScaledVector(_up, -0.1);
      const to = start.clone().sub(origin), len = to.length(); to.multiplyScalar(1 / len);
      if (world.raycast(origin, to, len + 0.15)) start.copy(origin).addScaledVector(d, 0.05);
      events.emit('shot', { weapon: w.id, name: w.name, origin, dir: d, muzzle, by: player, projectile: true });
      proj.spawn(w.projectile, start, d, player.vel);
    } else {
      // shotgun: one pellet near the centre, the rest on a jittered ring pattern so the spread is consistent
      for (let i = 0; i < w.pellets; i++) {
        if (w.pellets === 1) dirs.push(spreadDir(spreadRad));
        else if (i === 0) dirs.push(spreadDir(spreadRad, undefined, Math.random() * 0.2));
        else { const inner = i <= 3; const n = inner ? 3 : w.pellets - 4; const k = inner ? i - 1 : i - 4;
          dirs.push(spreadDir(spreadRad, (k / n) * Math.PI * 2 + S.shots * 1.3 + (Math.random() - 0.5) * 0.7, (inner ? 0.42 : 0.86) + (Math.random() - 0.5) * 0.26)); }
      }
      const shot = { weapon: w.id, name: w.name, origin, dir: w.pellets === 1 ? dirs[0] : aim, dirs, muzzle, by: player, pellets: w.pellets, suppressed: !!(w.suppressed || w.attSuppressed), loud: w.loud || 1 };
      if (w.noFlash) { shot.dir = undefined; shot.noFlash = true; } // no muzzle blast: fx skips a shot that has no `dir`
      events.emit('shot', shot);
      const agg = { hit: false, head: false, kill: false, dmg: 0, heads: new Set(), kills: [] };
      for (const d of dirs) bullet(w, origin, d, agg);
      // a kill counts as a headshot kill if any pellet of this shot hit that target's head
      for (const k of agg.kills) onKill({ target: k.target, headshot: agg.heads.has(k.target), dist: k.dist, weapon: w.name });
      if (agg.kills.length) agg.head = agg.kills.some((k) => agg.heads.has(k.target));
      if (agg.hit) { const hm = { headshot: agg.head, kill: agg.kill, damage: agg.dmg }; events.emit('hitmarker', hm); hud.hit(hm); }
    }

    // ---- recoil: aim kick follows the weapon's pattern -------------------------
    const r = w.recoil, pat = r.pattern;
    const pi = S.spray < pat.length ? S.spray : pat.length - r.loop + ((S.spray - pat.length) % r.loop);
    let mult = lerp(1, r.adsMult, S.ads) * D2R;
    if (player.crouching && player.grounded && !player.sliding) mult *= r.crouchMult;
    rec.tp += (pat[pi][0] + (Math.random() - 0.5) * 2 * r.jitter) * mult;
    rec.ty += (pat[pi][1] + (Math.random() - 0.5) * 2 * r.jitter) * mult;
    S.spray++;
    // ---- visual kick --------------------------------------------------------------
    // every other shot of a spray kicks a little harder and rolls the other way: sustained fire gets a rhythm
    const beat = S.spray % 2 ? 1 + FEEL.kickRhythm : 1 - FEEL.kickRhythm, side = S.spray % 2 ? 1 : -1;
    const k = w.kick, a = lerp(1, w.ads.scope ? 0.15 : 0.55, S.ads) * beat;
    sp.kz.kick(k.z * a, k.z * 2.2); sp.krx.kick(k.rx * a, k.rx * 2.2);
    sp.krz.kick(side * (0.35 + Math.random() * 0.65) * k.roll, k.roll * 2); sp.kry.kick((Math.random() - 0.5) * k.roll * 0.8, k.roll);
    sp.climb.kick(k.climb * lerp(1, 0.5, S.ads), k.climbMax);
    if (k.jolt) { const j = k.jolt * lerp(1, 0.35, S.ads); sp.kx.kick((Math.random() - 0.5) * 2 * j, j * 2); sp.ky.kick((0.3 + Math.random() * 0.7) * j, j * 2); }
    if (w.mag >= 4 && it.mag <= w.mag * FEEL.lowAmmo) events.emit('lowAmmo', { weapon: w.id, frac: it.mag / w.mag, left: it.mag });
    if (w.cycleCue) { S.cueT = ctx.time + w.cycleCue; S.cueW = w.id; }
    if (w.eject) S.ejects.push({ t: ctx.time + w.eject.delay, w });
    S.trig = 1;
    sp.camP.kick(k.cam, k.cam * 2.5); sp.camR.kick((Math.random() - 0.5) * 2 * k.camRoll, k.camRoll * 2);
    camera.fov += k.fov * lerp(1, 0.5, S.ads);
    S.scopeKick = Math.min(0.2, S.scopeKick + k.z * 0.9);
    const sus = w.spread.sustain;
    // sustained fire that settles: past `after` rounds the bloom ceiling comes down a step per shot
    if (sus && S.spray >= sus.after) S.bloom = Math.max(sus.bloomMax, Math.min(S.bloom, w.spread.bloomMax) - sus.rate);
    else S.bloom = Math.min(w.spread.bloomMax, S.bloom + w.spread.bloom * (it.mode === 'burst' ? 0.6 : 1));
    S.heat = Math.min(1, S.heat + (w.modes.includes('auto') ? 0.06 : 0.45));
    S.lastShot = ctx.time; S.fireBuf = 0;
  }

  function tryFire(dt) {
    const it = cur(), w = it.def;
    const down = input.down('Mouse0');
    const ready = S.state === 'ready' && S.sprint < 0.2 && player.state !== 'mantle' && S.throwT < 0 && S.lower < 0.3;
    if (!ready) return;
    const mode = it.mode;
    let n = 0;
    while (n < 4) {
      if (ctx.time < S.nextFire) break;
      let want;
      if (S.burstLeft > 0) want = true;
      else if (mode === 'auto') want = down || S.fireBuf > 0;
      else want = S.fireBuf > 0;
      if (!want) break;
      if (it.mag <= 0) {
        S.burstLeft = 0;
        if (S.fireBuf > 0) { S.fireBuf = 0; if (!startReload()) events.emit('dryFire', { weapon: w.id }); }
        break;
      }
      const base = Math.max(S.nextFire, ctx.time - dt); // carry the remainder so the rate of fire is exact at any frame rate
      if (mode === 'burst') {
        if (S.burstLeft <= 0) S.burstLeft = w.burst.count;
        S.burstLeft--;
        S.nextFire = base + 60 / w.burst.rpm + (S.burstLeft === 0 ? w.burst.gap : 0);
      } else S.nextFire = base + 60 / w.rpm;
      fire(); n++;
      if (S.state !== 'ready') break;
    }
  }

  function throwGrenade() {
    aimBasis();
    const origin = camera.position.clone();
    const start = origin.clone().addScaledVector(_dir, 0.5).addScaledVector(_right, -0.22).addScaledVector(_up, -0.12);
    const to = start.clone().sub(origin), len = to.length(); to.multiplyScalar(1 / len);
    if (world.raycast(origin, to, len + 0.15)) start.copy(origin).addScaledVector(_dir, 0.05);
    events.emit('grenadeThrow', { origin: start.clone(), dir: _dir.clone(), by: player });
    proj.spawn('frag', start, _dir.clone(), player.vel);
  }

  function stepSlot(from, dir) { for (let k = 1; k < inv.length; k++) { const j = (from + dir * k + inv.length * k) % inv.length; if (!inv[j].locked) return j; } return from; }

  // ---- player reactions --------------------------------------------------------
  events.on('jump', () => { sp.y.v -= 0.55; sp.rx.v += 1.1; });
  events.on('land', ({ speed = 6 }) => { const k = clamp(speed / 14, 0.25, 1.4); sp.y.v -= 1.25 * k; sp.rx.v -= 1.6 * k; sp.rz.v += (Math.random() - 0.5) * 1.2 * k; sp.camP.kick(-0.012 * k); });
  events.on('slideStart', () => { sp.rz.v += 2.2; sp.y.v -= 0.5; });
  events.on('mantle', () => { sp.y.v -= 0.6; });
  events.on('pad', () => { sp.y.v -= 1.6; sp.rx.v += 2.2; });
  events.on('zipStart', () => { sp.rz.v -= 1.6; });
  events.on('playerDamaged', ({ from, amount = 10 }) => {
    hud.damage(from, amount);
    const k = clamp(amount / 40, 0.2, 1);
    sp.camR.kick((Math.random() - 0.5) * 0.05 * k); sp.camP.kick(0.012 * k); sp.rz.v += (Math.random() - 0.5) * 2 * k;
  });
  // optional: the enemies system may emit botStagger { bot, by?, armorBreak? } when a hit staggers a guard / breaks armour
  events.on('botStagger', (e) => { if (e && e.by && e.by !== player) return; if (hud.stagger) hud.stagger(e || {}); });
  events.on('playerRespawned', () => {
    for (const w of inv) { w.mag = w.def.mag; w.reserve = w.def.reserve; }
    S.grenades = GRENADE.charges; S.grenT = 0; S.throwT = -1;
    rec.tp = rec.ty = rec.ap = rec.ay = 0; S.spray = 0; S.bloom = 0; S.ads = 0; S.burstLeft = 0; S.fireBuf = 0;
    S.lastPitch = player.pitch; S.lastYaw = player.yaw;
    const first = Math.max(0, inv.findIndex((v) => !v.locked)); // the first weapon actually carried
    if (S.idx !== first) { S.pending = first; raise(); } else { S.state = 'equip'; S.t = 0; S.rl = null; carry.k = 0; }
  });

  cur().pose.visible = true;
  events.emit('weaponSwitch', { weapon: cur().def.id, name: cur().def.name });

  // ==============================================================================
  function update(dt) {
    if (dt <= 0) return;
    const time = ctx.time;
    let it = cur(), w = it.def;
    const hs = Math.hypot(player.vel.x, player.vel.z);

    // ---- what did the mouse do this frame (everything that isn't our recoil) ----
    let lookX = clamp(player.yaw - S.lastYaw, -0.5, 0.5), lookY = clamp(player.pitch - S.lastPitch, -0.5, 0.5);
    // pulling against the recoil "uses it up", so recovery never drags the aim past where you put it
    if (lookY < 0 && rec.ap > 0) { const c = Math.min(-lookY, rec.ap); rec.ap -= c; rec.tp = Math.max(0, rec.tp - c); }
    if (lookX * rec.ay > 0) { const c = Math.sign(rec.ay) * Math.min(Math.abs(lookX), Math.abs(rec.ay)); rec.ay -= c; rec.ty = Math.abs(rec.ty) > Math.abs(c) && rec.ty * c > 0 ? rec.ty - c : 0; }

    // ---- input ---------------------------------------------------------------------
    if (input.pressed.has('Mouse0')) { S.fireBuf = FEEL.fireBuffer; S.clickT = time; } else S.fireBuf -= dt;
    // a click made while the gun is still coming up is kept until it is up
    if ((S.state === 'equip' || S.state === 'holster') && S.fireBuf > -0.15 && S.fireBuf <= 0.03 && time - S.clickT < 0.4) S.fireBuf = 0.03;
    if (input.pressed.size) for (let i = 0; i < inv.length; i++) if (input.pressed.has(DIGITS[i])) switchTo(i);
    const tgt = S.pending >= 0 ? S.pending : S.idx;
    if (input.pressed.has('WheelDown')) switchTo(stepSlot(tgt, 1));
    if (input.pressed.has('WheelUp')) switchTo(stepSlot(tgt, -1));
    if (input.pressed.has('KeyQ')) switchTo(S.last);
    if (input.pressed.has('KeyR')) startReload();
    if (input.pressed.has('KeyB') && w.modes.length > 1) {
      it.mode = w.modes[(w.modes.indexOf(it.mode) + 1) % w.modes.length]; S.burstLeft = 0;
      events.emit('fireMode', { weapon: w.id, mode: it.mode });
    }
    if (input.pressed.has('KeyG') && S.throwT < 0 && S.grenades > 0 && player.state !== 'mantle') { S.throwT = 0; S.thrown = false; S.grenades--; }

    // ---- state machine ---------------------------------------------------------------
    S.t += dt;
    if (S.state === 'holster' && S.t >= FEEL.holster) { raise(); it = cur(); w = it.def; }
    else if (S.state === 'equip' && S.t >= w.equip) S.state = 'ready';
    else if (S.state === 'reload') updateReload(dt);
    if (S.cueT > 0 && time >= S.cueT) { S.cueT = 0; if (S.cueW === w.id && S.state !== 'holster') events.emit('reloadStage', { weapon: w.id, stage: 'charge', tactical: false, cycle: true }); }
    if (!!w.suppressed !== it.supVis) dressVm(it); // (suppressor upgrade switched from outside)
    if (S.state === 'ready' && it.mag === 0 && it.reserve > 0 && time - S.lastShot > Math.min(0.45, 60 / w.rpm * 0.6) && S.throwT < 0) startReload();

    if (S.throwT >= 0) {
      S.throwT += dt;
      if (!S.thrown && S.throwT >= GRENADE.throwDelay) { S.thrown = true; throwGrenade(); sp.camP.kick(-0.012); sp.rx.v -= 1.5; }
      if (S.throwT >= GRENADE.throwTime) S.throwT = -1;
    }
    if (S.grenades < GRENADE.charges) { S.grenT += dt; if (S.grenT >= GRENADE.recharge) { S.grenT = 0; S.grenades++; } } else S.grenT = 0;
    for (const v of inv) if (v.def.reserveRegen && v.reserve < v.def.reserve) { v.regenT += dt; if (v.regenT >= v.def.reserveRegen) { v.regenT = 0; v.reserve++; } }

    // ---- stance: sprint / aim ------------------------------------------------------------
    const fireHeld = input.down('Mouse0'), adsHeld = input.down('Mouse2');
    const sprintInput = input.down('ShiftLeft') && input.down('KeyW') && !player.crouching && player.state === 'normal';
    const combat = fireHeld || S.fireBuf > 0 || adsHeld || S.burstLeft > 0 || time - S.lastShot < 0.25 || S.throwT >= 0;
    const sprinting = sprintInput && !combat && hs > FEEL.walkSpeed + 0.4 && S.state !== 'reload';
    S.sprint = sprinting ? Math.min(1, S.sprint + dt / 0.16) : Math.max(0, S.sprint - dt / w.sprintOut);
    const canAds = adsHeld && (S.state === 'ready' || S.state === 'equip' && S.t > w.equip * 0.5) && player.state !== 'mantle' && S.throwT < 0 && S.sprint < 0.6;
    // front-loaded and finite: most of the travel happens in the first third of ads.time, in both directions
    { const T = canAds ? w.ads.time : w.ads.time * 0.8, k = 2.5 / T, c = k / 11.2;
      S.ads = canAds ? Math.min(1, S.ads + ((1 - S.ads) * k + c) * dt) : Math.max(0, S.ads - (S.ads * k + c) * dt); }
    if (canAds !== S.wasAds) { S.wasAds = canAds; sp.krz.kick(canAds ? -0.03 : 0.022); sp.y.v += canAds ? 0.12 : -0.1; }
    if ((S.ads >= 1) !== S.adsFull) { S.adsFull = S.ads >= 1; if (S.adsFull) { sp.krx.kick(-0.009); sp.kz.kick(0.004); } }
    const adsE = S.ads;
    S.lower = damp(S.lower, player.state === 'mantle' ? 1 : 0, 16, dt);

    // ---- spread ----------------------------------------------------------------------------
    const s = w.spread;
    if (time - S.lastShot > (s.delay ?? 60 / w.rpm + 0.03)) S.bloom = Math.max(0, S.bloom - s.decay * dt);
    if (time - S.lastShot > w.recoil.delay + 0.18 && S.burstLeft <= 0) S.spray = 0;
    const air = !player.grounded && player.state === 'normal';
    let spread = lerp(s.hip, s.ads, adsE)
      + ((hs > 0.6 ? s.move * Math.min(1.5, hs / FEEL.walkSpeed) : 0) + (air ? s.air : 0) + (player.sliding ? s.slide : 0)) * lerp(1, s.adsMoveMult, adsE)
      + S.bloom * lerp(s.hipBloom ?? 1, s.adsBloom ?? 0.4, adsE);
    if (player.crouching && player.grounded && !player.sliding) spread *= s.crouch;
    S.spread = spread;

    // ---- fire ------------------------------------------------------------------------------
    tryFire(dt);
    it = cur(); w = it.def;

    // ---- aim recoil: snap toward the target, then recover ----------------------------------
    {
      const r = w.recoil;
      if (time - S.lastShot > r.delay) { const k = Math.exp(-r.recover * dt); rec.tp *= k; rec.ty *= k; }
      const k = 1 - Math.exp(-r.snap * dt);
      const dp = (rec.tp - rec.ap) * k, dy = (rec.ty - rec.ay) * k;
      rec.ap += dp; rec.ay += dy;
      const before = player.pitch;
      player.pitch = clamp(player.pitch + dp, -1.5, 1.5); player.yaw -= dy;
      const lost = dp - (player.pitch - before); // hit the look-up limit
      if (Math.abs(lost) > 1e-6) { rec.ap -= lost; rec.tp = Math.min(rec.tp, rec.ap); }
      S.lastPitch = player.pitch; S.lastYaw = player.yaw;
    }

    // ---- camera: punch + shake on top of the player's camera -------------------------------------
    sp.camP.step(dt); sp.camY.step(dt); sp.camR.step(dt);
    let shx = 0, shy = 0, shr = 0;
    if (shake.t > 0) {
      shake.t -= dt; const a = shake.amp * clamp(shake.t / 0.45, 0, 1) ** 2;
      shx = Math.sin(time * 71) * a; shy = Math.sin(time * 93 + 1.3) * a; shr = Math.sin(time * 57 + 2.1) * a * 0.6;
      if (shake.t <= 0) shake.amp = 0;
    }
    camera.rotation.set(clamp(player.pitch + sp.camP.x + shx, -1.56, 1.56), player.yaw + sp.camY.x + shy, player.roll + sp.camR.x + shr, 'YXZ');
    // aiming: snappier zoom than the player's own FOV smoothing
    player.fovScale = lerp(1, w.ads.fov, adsE);
    if (S.ads > 0) {
      const target = player.baseFov * player.fovScale + clamp((hs - FEEL.walkSpeed) * 1.9, 0, 16);
      camera.fov = damp(camera.fov, target, 16, dt);
    }
    camera.updateProjectionMatrix();
    player.speedScale = w.mobility * (sprintInput && combat ? FEEL.walkSpeed / FEEL.sprintSpeed : 1) * lerp(1, w.ads.move, adsE);

    proj.update(dt);

    // ---- brass ------------------------------------------------------------------------------------------
    for (let i = S.ejects.length - 1; i >= 0; i--) {
      const e = S.ejects[i]; if (time < e.t) continue;
      S.ejects.splice(i, 1);
      if (!it.vm.eject || e.w !== w) continue;
      camera.updateMatrixWorld(true);
      aimBasis();
      const v = e.w.eject.vel;
      _ev.set(0, 0, 0).addScaledVector(_right, v[0] * (0.75 + Math.random() * 0.5)).addScaledVector(_up, v[1] * (0.75 + Math.random() * 0.5)).addScaledVector(_dir, -v[2] * (0.75 + Math.random() * 0.5)).add(player.vel);
      casings.spawn(it.vm.eject.getWorldPosition(_ep), _ev, e.w.id);
    }
    casings.update(dt);
    S.trig = input.down('Mouse0') && S.state === 'ready' && it.mag > 0 && it.mode === 'auto' ? Math.max(S.trig, 0.7) : Math.max(0, S.trig - dt * 9);

    // ---- viewmodel pose ------------------------------------------------------------------------------
    S.heat = Math.max(0, S.heat - dt * (w.modes.includes('auto') ? 0.5 : 1.2));
    S.scopeKick = damp(S.scopeKick, 0, 9, dt);
    for (const k in sp) if (!k.startsWith('cam')) sp[k].step(dt);
    const hipK = 1 - 0.85 * adsE; // how much loose motion survives while aiming
    // sway: the gun lags behind the look direction
    const rx = lookX / dt, ry = lookY / dt;
    sw.ry.step(dt, clamp(-rx * 0.024, -0.1, 0.1));
    sw.rx.step(dt, clamp(-ry * 0.024, -0.08, 0.08));
    sw.rz.step(dt, clamp(rx * 0.032, -0.13, 0.13));
    sway.x = damp(sway.x, clamp(rx * 0.004, -0.02, 0.02), 12, dt);
    sway.y = damp(sway.y, clamp(-ry * 0.004, -0.02, 0.02), 12, dt);
    // movement: lean against strafing, lag on vertical speed
    const vr = player.vel.x * Math.cos(player.yaw) - player.vel.z * Math.sin(player.yaw);
    const vf = -player.vel.x * Math.sin(player.yaw) - player.vel.z * Math.cos(player.yaw);
    sway.mx = damp(sway.mx, clamp(vr / 8, -1, 1), 9, dt);
    // strafe weight shift: a soft, slightly under-damped spring chases the strafe lean, so the gun trails the
    // move, settles, and overshoots a little when you stop or reverse
    { const target = Number.isFinite(player.strafeLean) ? clamp(player.strafeLean, -1, 1) : clamp(vr / FEEL.walkSpeed, -1, 1);
      const n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n;
      for (let i = 0; i < n; i++) { S.leanV += ((target - S.lean) * FEEL.strafeSpring - S.leanV * FEEL.strafeDamp) * h; S.lean += S.leanV * h; } }
    sway.mz = damp(sway.mz, clamp(vf / 9, -1, 1), 9, dt);
    sway.vy = damp(sway.vy, clamp(player.vel.y * 0.0035, -0.04, 0.035), 12, dt);
    // bob
    const moving = player.grounded && !player.sliding && hs > 1 && player.state === 'normal';
    S.bobAmp = damp(S.bobAmp, moving ? Math.min(1.3, hs / FEEL.walkSpeed) : 0, 10, dt);
    const ph = player.bob, bA = S.bobAmp * (1 + S.sprint * 0.9);
    const bobX = Math.cos(ph) * 0.0085 * bA, bobY = -Math.abs(Math.sin(ph)) * 0.011 * bA + 0.005 * bA, bobR = Math.cos(ph) * 0.012 * bA;
    const breathe = Math.sin(time * 1.7) * 0.0022, breathe2 = Math.sin(time * 1.1 + 1) * 0.0016;
    const slide = player.sliding ? 1 : 0, zip = player.state === 'zip' ? 1 : 0;
    S.slideK = damp(S.slideK, slide, 12, dt); S.zipK = damp(S.zipK, zip, 10, dt);

    out.p.set(0, 0, 0); out.r.set(0, 0, 0);
    if (S.rl) { const a = animRl, l = S.rl; a.phase = l.phase; a.t = Math.min(1, l.t); a.n = l.n; a.pump = l.pump; a.to = l.to; a.tac = !!l.tac; a.end = l.end || 1; }
    animS.time = time; animS.cycle = time - S.lastShot; animS.mag = it.mag; animS.magSize = w.mag; animS.reserve = it.reserve; animS.heat = S.heat;
    animS.rl = S.rl ? animRl : null; animS.mode = it.mode; animS.trigger = S.trig;
    it.vm.animate(animS, out);
    carry.lp.copy(out.p); carry.lr.copy(out.r);
    if (carry.k > 0) { carry.k = Math.max(0, carry.k - dt / 0.12); const e = smooth(carry.k); out.p.addScaledVector(carry.p, e); out.r.addScaledVector(carry.r, e); }

    // equip / holster / grenade throw / lowered
    let drop = S.lower;
    if (S.state === 'equip') drop = Math.max(drop, 1 - easeOut(clamp(S.t / w.equip, 0, 1)));
    else if (S.state === 'holster') drop = Math.max(drop, smooth(clamp(S.t / FEEL.holster, 0, 1)));
    const th = S.throwT >= 0 ? Math.sin(Math.PI * clamp(S.throwT / GRENADE.throwTime, 0, 1)) : 0;

    const P = it.pose.position, R = it.pose.rotation, se = smooth(S.sprint);
    P.copy(it.hip).lerp(it.adsPos, adsE);
    P.x += sp.kx.x + (bobX + sway.x - S.lean * FEEL.strafeShift - S.leanV * FEEL.strafeTrail + breathe2) * hipK + out.p.x - 0.05 * se - 0.03 * th + 0.02 * S.slideK * hipK;
    P.y += sp.ky.x + (bobY + sway.y + sway.vy + breathe) * hipK + sp.y.x * (1 - 0.6 * adsE) + out.p.y - 0.045 * se - 0.3 * drop - 0.07 * th - 0.02 * S.slideK * hipK;
    P.z += sp.kz.x + sway.mz * 0.012 * hipK + out.p.z + 0.04 * se + 0.08 * drop;
    R.set(
      sp.krx.x + sp.climb.x + (sw.rx.x + sp.rx.x * 0.12) * hipK + out.r.x - 0.2 * se - 0.95 * drop - 0.25 * th,
      sp.kry.x + sw.ry.x * hipK + out.r.y + 0.72 * se + 0.3 * drop + 0.35 * th,
      sp.krz.x + (sw.rz.x + bobR + S.lean * FEEL.strafeRoll + sp.rz.x * 0.1 + 0.32 * S.slideK - 0.2 * S.zipK) * hipK + out.r.z + 0.18 * se + 0.25 * drop + 0.3 * th,
      'YXZ');
    // viewmodel has its own field of view: counter-scale against the camera's
    const vmFov = lerp(w.view.fov, w.ads.vmFov, adsE);
    const k = Math.tan(camera.fov * 0.5 * D2R) / Math.tan(vmFov * 0.5 * D2R);
    vmRoot.scale.set(k, k, 1);
    // optics
    const lens = it.vm.lens;
    let scopePx = null;
    if (w.ads.scope) { // keep the eyepiece off the near plane when the rifle kicks back
      const lensZ = P.z - it.vm.sight[2]; if (lensZ > -0.099) P.z += -0.099 - lensZ;
    }
    camera.updateMatrixWorld(true);
    const pxPerRad = (window.innerHeight * 0.5) / Math.tan(camera.fov * 0.5 * D2R);
    if (lens && lens.kind === 'dot') {
      // the dot sits on the sight axis; fully aimed, that axis IS the line of fire (screen centre)
      _d.set(0, 0, -1).applyEuler(R);
      lens.mat.uniforms.uAxis.value.set(_d.x / -_d.z, _d.y / -_d.z).multiplyScalar(1 - adsE);
      lens.mat.uniforms.uK.value = k;
    } else if (lens && lens.kind === 'scope') {
      const open = smooth(clamp((S.ads - 0.8) / 0.2, 0, 1));
      const looking = open > 0.02;
      it.vm.body.visible = !looking; // nothing of the rifle is in focus (or in the way) while the eye is at the glass
      lens.mat.uniforms.uOpen.value = open * (1 - Math.min(0.5, S.scopeKick * 2.5));
      lens.mat.uniforms.uShadow.value.set(
        clamp(-sw.ry.x * 7 - sp.kry.x * 6 + sway.mx * 0.06 + Math.sin(time * 0.9) * 0.012, -0.6, 0.6),
        clamp(sw.rx.x * 7 + sp.krx.x * 4 + sp.y.x * 3 + sway.vy * 6 + Math.sin(time * 1.3) * 0.01, -0.6, 0.6));
      if (looking) {
        _m.set(it.vm.sight[0], it.vm.sight[1], -it.vm.sight[2]); it.vm.group.localToWorld(_m); _m.applyMatrix4(camera.matrixWorldInverse);
        scopePx = scopeS; scopeS.x = (_m.x / -_m.z) * pxPerRad; scopeS.y = (-_m.y / -_m.z) * pxPerRad; scopeS.r = (it.vm.eyeR * k / -_m.z) * pxPerRad; scopeS.a = open;
      }
    }

    // ---- HUD -------------------------------------------------------------------------------------
    let reload = -1;
    if (S.rl) reload = S.rl.type === 'mag' ? Math.min(1, S.rl.t / S.rl.end) : clamp((it.mag + (S.rl.phase === 'loop' && !S.rl.done ? S.rl.t * 0.9 : 0)) / w.mag, 0, 1);
    const h = hudS;
    h.att = it.attLabel; h.w = w; h.idx = S.idx; h.inv = inv; h.mag = it.mag; h.reserve = it.reserve; h.mode = it.mode;
    h.spreadPx = Math.tan(S.spread * D2R) * pxPerRad; h.ads = S.ads; h.adsScope = !!w.ads.scope; h.sight = w.id !== 'launcher'; h.reload = reload; h.sprint = S.sprint;
    h.hidden = S.state === 'holster' || player.state === 'mantle';
    h.comboLeft = 1 - (time - score.lastKillT) / SCORE.multiWindow;
    h.grenades = S.grenades; h.grenMax = GRENADE.charges; h.grenCharge = S.grenT / GRENADE.recharge; h.scopePx = scopePx;
    hud.update(h, dt);
  }

  // ---- attachments ---------------------------------------------------------------------------------------
  const slotOf = (weaponId) => inv.find((v) => v.base.id === weaponId) || null;
  // Replace a gun's whole set. `set` = { slot: attachmentId | null }; anything that does not fit is dropped.
  // opts.fill: also refill magazine and reserve to the new sizes (use it from the stash; mid-raid leave it off:
  // a bigger magazine then has to be reloaded to be filled, a smaller one hands its extra rounds back to the reserve).
  // Returns the set that was actually fitted.
  function setAttachments(weaponId, set, opts = {}) {
    const it = slotOf(weaponId); if (!it) return {};
    it.att = cleanSet(weaponId, set);
    if (it === cur()) { // mid-raid on the gun in hand: whatever it was doing is cut short
      if (S.rl) endReload(true);
      if (S.state === 'reload') S.state = 'ready';
      S.burstLeft = 0; S.spray = 0;
    }
    refit(it, !!opts.fill);
    events.emit('attachments', { weapon: weaponId, set: { ...it.att } });
    return { ...it.att };
  }

  // public API for other systems / tests
  ctx.weapons = {
    // attachments: catalogue [{ id, name, short, slot, desc, fits, tier, price, mods }], and per-gun sets
    attachments: ATTACHMENTS,
    attachment,                                                  // (id) -> catalogue entry | null
    slotsFor,                                                    // (weaponId) -> ['muzzle', 'optic', ...] ([] = takes none)
    fits,                                                        // (attId, weaponId) -> boolean
    getAttachments(weaponId) { const it = slotOf(weaponId); return it ? { ...it.att } : {}; },
    setAttachments,
    // (weaponId) -> numbers for UI: { damage, rpm, mag, reserve, reload, reloadTactical, ads, adsFov, zoom, adsMove,
    //   mobility, recoilV, recoilH, recoil, hipSpread, range:[start,end], suppressed, scope, attachments, slots,
    //   def (the full effective def), base (the same numbers for the bare gun) }.
    // Pass a second argument { slot: id } to preview a set without fitting it.
    effective(weaponId, preview) {
      const it = slotOf(weaponId); if (!it) return null;
      const d = preview ? effectiveDef(it.base, cleanSet(weaponId, preview), player.baseFov) : it.def;
      return { ...summary(d), slots: slotsFor(weaponId), def: d, base: summary(it.base) };
    },
    defs: WEAPONS, inventory: inv, state: S, recoil: rec, projectiles: proj.list,
    get current() { return cur(); },
    switchTo, reload: startReload,
    addAmmo(frac = 1) { for (const v of inv) v.reserve = Math.min(v.def.reserve, v.reserve + Math.ceil(v.def.reserve * frac)); },
    explode: (point, kind = 'frag') => proj.explode(point, PROJECTILES[kind].blast, player, kind),
  };

  return { update };
}
