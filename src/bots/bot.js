import * as THREE from 'three';
import { BotBody } from './body.js';
import { makeBody, stepBody, JUMP } from './physics.js';
import { PAD_TRIGGER_R } from './nav.js';
import { rand, randR, randI } from './config.js';

// One enemy bot: body physics, path following, senses, state machine, aim and fire.
// It is also the `target` object pushed into ctx.targets (team, alive, pos, radius, height, takeDamage).
//
// Being shot (see takeDamage / hitAt / stagger / suppress / die):
//   every hit   -> a flinch on the body in the direction of the shot, scaled by damage, by zone (head / torso / leg)
//   leg hit     -> stumble and a slowed, limping walk for a moment (slowT)
//   heavy hit   -> stagger(): a shotgun blast, a big round, a headshot or sustained automatic fire breaks off the burst
//                  and stops the guard moving for stagT seconds (then stagImmT seconds of immunity: no stun-lock)
//   near misses -> suppress(): the guard ducks, hesitates and shoots worse for a moment
//   death       -> die() picks a fall from the killing shot (see body.js die()) and throws the physics body with it
// Fairness: every burst is announced by a tell (weapon snaps up from low ready, visor flares) for cfg.tellTime.
//
// ENEMY TYPES (bot.special, from config kinds[...].set.special; see config.js for the numbers):
//   'shield'      shieldCheck(): bullets from the front arc are stopped while bot.shieldUp (takeDamage returns 'blocked',
//                 emits impact { kind:'shield', blocked:true }); feet, flanks, back, shots from above and blasts get through
//   'rusher'      thinkRush(): run (zigzag) -> windup (tell) -> lunge (committed line, melee once) -> recover. bot.rush.phase
//   'marksman'    fireSnipe(): laser wind-up (bot.aimT > 0, bot.locked for the last moment) -> one heavy round; cancelSnipe()
//   'grenadier'   grenadeTick(): wind-up (bot.grenWind > 0) -> roles.throwGrenade(); otherwise a weak rifleman
//   'suppressor'  the normal burst code with a long tell (spool) and rounds fired down the aim line in a cone

const EYE = 1.62;
const TMP = new THREE.Vector3(), TMP2 = new THREE.Vector3(), TMP3 = new THREE.Vector3();
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
let NEXT_ID = 1;
export const RAIDER_NAMES = ['Ash', 'Bram', 'Cinder', 'Dune', 'Flint', 'Gale', 'Husk', 'Jackal', 'Moth', 'Rust', 'Thorn', 'Vole', 'Sorrel', 'Tarn', 'Brack', 'Okra'];
const CALLSIGNS = ['Vex', 'Orrin', 'Kade', 'Juno', 'Brask', 'Sable', 'Tiber', 'Nyx', 'Rook', 'Quill', 'Marlo', 'Dax', 'Fenn', 'Ibis', 'Corvo', 'Lumen', 'Pike', 'Wren', 'Zell', 'Garr', 'Mosk', 'Tamsin', 'Udo', 'Yara'];
const tH = (t) => t.h ?? t.height ?? 1.8;
const tAir = (t) => t.grounded === false || (t.body && !t.body.grounded) || !!t.sliding || t.state === 'zip';
const ZERO = new THREE.Vector3();

export class Bot {
  // Give this guard an enemy type: its own view of the config (overrides on top of the shared one), size and colour.
  setKind(name) {
    const base = this.mgr.cfg, K = (name === 'raider' ? base.raiders && base.raiders.kind : base.kinds && base.kinds[name]) || { set: {}, mul: {}, scale: 1, color: base.accentColor };
    const c = Object.create(base);
    for (const k in K.set) c[k] = K.set[k];
    for (const k in K.mul) Object.defineProperty(c, k, { get: () => base[k] * K.mul[k], enumerable: true });
    c.color = K.color ?? base.accentColor;
    this.cfg = c; this.kind = name; this.kindLabel = K.label || 'Guard'; this.special = c.special || null;
    const sc = K.scale || 1, wide = K.wide || 1;
    this.height = this.baseHeight = 1.8 * sc; this.radius = 0.35 * Math.max(1, wide);
    this.mesh.root.scale.set(sc * wide, sc, sc * wide); this.mesh.mats.accent.emissive.setHex(c.color); this.mesh.mats.visor.emissive.setHex(c.color);
    if (this.mesh.barFill) this.mesh.barFill.material.color.setHex(c.color);
    this.mesh.setOutfit(K.outfit || name);
    this.resetRole();
    if (this.alive) { this.burstLeft = 0; this.telling = false; this.mag = Math.min(this.mag || c.magSize, c.magSize); this.prefRange = randR(c.preferredRange); } // converted while alive (raid.js, squads.js)
  }

  // per-type attack state (see the header): cleared on spawn and when the type changes
  resetRole() {
    const R = this.rush || (this.rush = { phase: 'run', t: 0, dx: 0, dz: 1, hit: false, zig: 1, zigT: 0, repT: 0 });
    R.phase = 'run'; R.t = 0; R.hit = false; R.zigT = 0; R.repT = 0;
    this.shieldUp = false; this.shieldDownT = 0; this.blockPend = 0; this.blockT = -1; this.blockSrc = null; this.blockWeapon = null; this.blocked = 0;
    this.aimT = 0; this.locked = false; this.losLostT = 0; this.snipeCd = 0; this.grenCd = 2 + Math.random() * 3; this.grenWind = 0;
    if (this.mgr.roles) this.mgr.roles.laserOff(this);
  }

  constructor(mgr, opts = {}) {
    this.mgr = mgr; this.ctx = mgr.ctx; this.cfg = mgr.cfg; this.nav = mgr.nav;
    this.id = NEXT_ID++;
    // faction: 'guard' (the site's security) | 'raider' (a rival crew). Hostile to each other and both to the player.
    this.faction = opts.faction || 'guard';
    const used = new Set(mgr.bots.map((b) => b.name)), raider = this.faction === 'raider';
    this.name = (raider ? RAIDER_NAMES : CALLSIGNS).find((n) => !used.has(n)) || `${raider ? 'Raider' : 'Warden'}-${this.id}`; // stable callsign, kept across respawns
    // squad (see squads.js): the post / patrol / raider group this bot belongs to, its slot in it, how far it has followed the squad's orders
    this.squad = null; this.slot = null; this.seqDone = -1; this.far = false; this.lodAcc = Math.random() * 0.08;
    this.foe = null; this.foeVis = false; this.foeRevealT = -99; this.concernPl = false; this.scanAmp = 1.05; this.faceBot = null; this.lootUntil = -99; this.simN = 0;
    this.mem = new Map(); this.target = null; this.lastAttacker = null; this.lastAttackT = -99; this.scanI = 0;
    // ---- target contract ----
    this.team = 'enemy'; this.alive = false; this.isBot = true;
    this.pos = new THREE.Vector3(0, -100, 0); this.vel = new THREE.Vector3();
    this.radius = 0.35; this.height = 1.8; this.hp = 0; this.maxHp = this.cfg.hp;
    this.takeDamage = this.takeDamage.bind(this);

    this.body = makeBody(this.pos, this.vel);
    this.mesh = new BotBody(this.ctx.scene, raider ? this.cfg.raiders.kind.color : this.cfg.accentColor, raider ? 'raider' : 'guard'); this.mesh.hide();
    this.kind = 'grunt'; this.kindLabel = 'Guard';
    this.state = 'dead'; this.deadT = 0; this.pendingSpawn = true;
    this.goal = new THREE.Vector3(); this.lastSeen = new THREE.Vector3(); this.lastSeenVel = new THREE.Vector3(); this.alertPos = new THREE.Vector3();
    this.lookPt = new THREE.Vector3(); this.stuckPos = new THREE.Vector3();
    this.aimDir = new THREE.Vector3(0, 0, 1);
    this.hitDir = new THREE.Vector3(0, 0, 1); this.baseHeight = 1.8; this.huntPos = new THREE.Vector3();
    this.special = null; this.blockFrom = new THREE.Vector3(); this.lockPt = new THREE.Vector3(); this.grenAim = new THREE.Vector3(); this.resetRole();
    this.animState = { pos: this.pos, vel: this.vel, bodyYaw: 0, aimYaw: 0, aimPitch: 0, grounded: true, aiming: 0, hp01: 1, showBar: false, camera: this.ctx.camera, floorY: 0, fadeStart: 2, fadeTime: 1.2, stag: 0, stagX: 0, crouch: 0, tell: 0, limp: 0, shield: 0, spin: 0, claw: 0, throw: 0 };
    this.percT = Math.random() * this.cfg.perceptionInterval;
    // guard detection (team mode): role, awareness of the player, alert state — read by the HUD
    this.role = 'active'; this.post = new THREE.Vector3(); this.awareness = 0; this.alertState = 'unaware'; this.lastSeenPlayerT = Infinity;
    this.stim = new THREE.Vector3(); this.sightT = -1e9; this.susActed = false; this.evT = { guardSuspicious: -99, guardAlert: -99, raiderSuspicious: -99, raiderAlert: -99 }; this.hearLos = true; this.hearLosT = -99;
    this.stats = { shots: 0, hits: 0, damageDealt: 0, deaths: 0, repaths: 0, stuck: 0, pads: 0 };
  }

  // ===========================================================================
  // life cycle
  // ===========================================================================
  spawn(p) {
    const cfg = this.cfg;
    this.pos.copy(p); this.vel.set(0, 0, 0);
    Object.assign(this.body, { grounded: false, coyote: 0, padCd: 0, airTime: 0 });
    this.maxHp = cfg.hp; this.hp = cfg.hp; this.alive = true; this.pendingSpawn = false; this.hurtT = 99; this.deadT = 0;
    this.state = 'patrol'; this.waitT = rand(0.2, 1.5); this.t = 0;
    this.clearPath(); this.padFlight = false; this.stuckT = 0; this.stuckN = 0; this.checkT = Math.random() * 0.4;
    this.aimYaw = this.bodyYaw = Math.random() * Math.PI * 2; this.aimPitch = 0; this.scanBase = this.aimYaw; this.scanPhase = Math.random() * 6;
    this.errYaw = 0; this.errPitch = 0; this.errTY = 0; this.errTP = 0; this.errT = 0; this.settle = 0; this.flinchErr = 0; this.aimOff = 1; this.recoil = 0;
    this.visible = false; this.awareness = 0; this.seenT = 0; this.unseenT = 99; this.lastSeenTime = -99; this.lastCombatT = -99;
    this.mode = 'engage'; this.modeT = 0; this.reposT = 0; this.evalJob = null; this.strafeSign = Math.random() < 0.5 ? 1 : -1;
    this.hasToken = false; this.tokenT = 0; this.tokenCd = 0; this.wantTokenT = -9; this.reactT = 0;
    this.burstLeft = 0; this.shotT = 0; this.pauseT = 0; this.mag = cfg.magSize; this.reloadT = 0;
    this.alertState = 'unaware'; this.lastSeenPlayerT = Infinity; this.sightT = -1e9; this.susActed = false; this.investMode = 'go'; this.post.copy(p); this.hearLosT = -99;
    this.firstBurst = true; this.missSide = 0; this.mem.clear(); this.target = null; this.lastAttacker = null; this.lastAttackT = -99;
    this.prefRange = randR(cfg.preferredRange); this.searchT = 0; this.investT = 0; this.lookMove = false; this.poi = null;
    this.reloadCover = false; this.coverT = 0; this.needRepath = false; this.playerDist = 99; this.investGo = false; this.wishSpeed = 0;
    this.sepX = 0; this.sepZ = 0; this.moveSpeed = cfg.patrolSpeed; this.wx = 0; this.wz = 0; this.aimingPose = 0;
    // hit reactions / pressure
    this.stagT = 0; this.stagDur = 1; this.stagImmT = 0; this.stagX = 0; this.stagAmt = 0; this.staggerT = 0;
    this.acc = 0; this.accN = 0; this.accT = -99; this.burstDmg = 0; this.ptSkip = 0; this.hitLx = 0; this.hitLz = -1; this.hitSide = 0;
    this.slowT = 0; this.telling = false; this.tellT = 0; this.suppression = 0; this.duckT = 0; this.supCd = 0;
    this.underFire = false; this.defensive = false; this.flankUntil = -99; this.flankCdT = this.mgr.time + rand(2, 8); this.hunting = false; this.huntCdT = 0;
    this.height = this.baseHeight;
    this.foe = null; this.foeVis = false; this.foeRevealT = -99; this.concernPl = false; this.scanAmp = 1.05; this.faceBot = null; this.lootUntil = -99; this.seqDone = -1; this.far = false;
    this.resetRole();
    this.mesh.reset();
    this.ctx.events.emit('botSpawned', { bot: this, point: this.pos.clone() });
  }

  // info: { from (Vector3: where the shot came from), source (the shooter target), headshot, weapon (id), explosive,
  //         point?, dir? } — the player's guns pass from / source / headshot / weapon; the exact hit point arrives
  //         right after through the 'impact' event (-> hitAt). point / dir are used directly if a caller passes them.
  takeDamage(amount, info = {}) {
    if (!this.alive || !(amount > 0)) return;
    const cfg = this.cfg, now = this.mgr.time, wasHp = this.hp;
    const from = info.from || (info.source && info.source.pos) || null;
    let weak = false;
    if (this.special === 'shield' && !info.shieldBypass) { amount = this.shieldCheck(amount, info, from); if (!(amount > 0)) return 'blocked'; }
    else if (this.special === 'suppressor' && from && !info.explosive) { // the drum on its back is the weak spot
      const off = Math.abs(wrap(Math.atan2(from.x - this.pos.x, from.z - this.pos.z) - this.bodyYaw));
      if (off > 2.1) { amount *= cfg.backMult || 1; weak = true; } else if (off < 1.2 && !info.headshot) amount *= cfg.frontMult || 1; // plated in front (not the head)
    }
    if (this.aimT > 0) this.cancelSnipe('hit');
    if (this.grenWind > 0 && amount >= 15) { this.grenWind = 0; this.grenCd = Math.max(this.grenCd, 2.5); }
    this.hp -= amount; this.hurtT = 0;
    let lx = 0, lz = -1;
    if (info.dir || from) { // push direction (away from the shooter), world and in the bot's local frame
      let dx = info.dir ? info.dir.x : this.pos.x - from.x, dz = info.dir ? info.dir.z : this.pos.z - from.z;
      const l = Math.hypot(dx, dz) || 1, s = Math.sin(this.bodyYaw), c = Math.cos(this.bodyYaw);
      dx /= l; dz /= l; this.hitDir.set(dx, 0, dz);
      lx = dx * c - dz * s; lz = dx * s + dz * c;
    }
    this.hitLx = lx; this.hitLz = lz;
    if (now - this.accT > 0.05) { this.acc = 0; this.accN = 0; this.accT = now; } // rounds landing together (pellets) add up
    this.acc += amount; this.accN++; this.burstDmg += amount;
    let zone = info.headshot ? 'head' : 'torso', side = (Math.random() - 0.5) * 1.2;
    if (info.point) { const z = this.zoneOf(info.point); if (!info.headshot) zone = z; side = this.hitSide; this.ptSkip++; }
    this.hitSide = side;
    const str = Math.min(1.6, 0.5 + amount / 30) / Math.sqrt(this.accN) * (cfg.flinchScale || 1);
    this.mesh.flinch(lx, lz, str, side, zone);
    if (zone === 'leg') this.slowT = Math.max(this.slowT, 0.8 + amount / 40);
    this.flinchErr = Math.min(0.12, this.flinchErr + cfg.aimErrorFlinch * Math.min(1.5, amount / 20));
    this.errT = 0;
    this.telling = false; this.tellT = 0; // knocked off aim: the next burst has to be announced again
    this.ctx.events.emit('botDamaged', { bot: this, amount, hp: this.hp, from, headshot: !!info.headshot, dir: this.hitDir, zone, weak });
    if (this.hp <= 0) { this.die(info, lx, lz, amount); return; }
    // heavy hit / blast / headshot / sustained fire -> stagger
    const sd = cfg.staggerDamage;
    if (this.acc >= sd || info.explosive || (info.headshot && amount >= sd * 0.55) || this.burstDmg >= cfg.staggerSustain) {
      const st = info.explosive ? 1.3 : Math.max(this.burstDmg >= cfg.staggerSustain ? 0.65 : 0.5, Math.min(1.5, this.acc / sd * 0.75));
      if (this.stagger(st, this.hitDir, !!info.headshot, info.point || null)) this.burstDmg = 0;
    }
    if (wasHp >= cfg.retreatHp && this.hp < cfg.retreatHp && !this.defensive && Math.random() < cfg.defensiveChance * (1 - 0.5 * this.mgr.aggr)) {
      this.defensive = true; this.modeT = 0; this.mgr.callout(this, 'wounded'); // badly hurt: fall back and fight from cover
    }
    if (this.state === 'combat' && this.mode !== 'cover') { this.underFire = true; this.reposT = Math.min(this.reposT, rand(0.08, 0.3)); } // do not stand there and take it
    this.noticeAttacker(info, from);
  }

  // being hit (or having a round stopped by the shield) reveals the attacker, even from behind
  noticeAttacker(info, from) {
    const cfg = this.cfg, now = this.mgr.time;
    const atk = info.source;
    if (atk && atk !== this && atk.pos && atk.alive !== false) {
      this.lastAttacker = atk; this.lastAttackT = this.mgr.time;
      const m = this.memOf(atk); m.revealT = this.mgr.time + 2.5; m.aware = 1;
      this.percT = Math.min(this.percT, 0.03);
    }
    if (!cfg.ffa && atk && atk.team === 'player' && atk.alive !== false) { // engaged by the player: instantly alert on the shooter's position
      this.awareness = 1; this.stim.copy(atk.pos);
      if (this.state !== 'combat') { this.target = atk; this.lastSeen.copy(atk.pos); this.lastSeenVel.set(0, 0, 0); this.lastSeenTime = this.mgr.time; this.enterCombat(); this.reactT = Math.min(this.reactT, 0.35); this.underFire = true; this.reposT = rand(0.15, 0.4); }
      else if (!this.visible) this.lastSeen.copy(atk.pos);
      this.concernPl = true;
      return;
    }
    if (!cfg.ffa && atk && atk.isBot) { // shot by a bot of the other side: it is revealed, even from behind; go for it
      if (atk.faction !== this.faction && atk.alive) { this.foe = atk; this.foeRevealT = now + 3; this.percT = Math.min(this.percT, 0.05); if (this.state !== 'combat') this.hearFoe(atk.pos); }
      return;
    }
    if (this.state !== 'combat') {
      const src = (info.source && info.source.pos) || from;
      if (src) { this.lastSeen.copy(src); this.lastSeenTime = this.mgr.time; this.alert(src, 0.15, true); this.awareness = Math.max(this.awareness, 0.85); }
    }
  }

  // The shield bearer's frontal shield. Returns the damage that gets through (0 = stopped).
  // Open: the back and flanks (outside cfg.shieldArc), the feet, shots from well above, and any time the shield is down
  // (unaware, firing, staggered). A blast from the front is damped to cfg.shieldBlast and knocks the shield aside.
  shieldCheck(amount, info, from) {
    if (!this.shieldUp || !from) return amount;
    const cfg = this.cfg, dx = from.x - this.pos.x, dz = from.z - this.pos.z;
    if (Math.abs(wrap(Math.atan2(dx, dz) - this.bodyYaw)) > cfg.shieldArc * Math.PI / 360) return amount;
    if (Math.atan2(from.y - (this.pos.y + this.height * 0.8), Math.max(0.1, Math.hypot(dx, dz))) > cfg.shieldOverTop) return amount;
    if (info.explosive) return amount * cfg.shieldBlast; // (the stagger that follows drops the shield)
    if (info.point) {
      if (info.point.y - this.pos.y < cfg.shieldFeet * this.height) return amount;
      this.ptSkip++; this.blockFx(info.point, from, info.source);
    } else { // the hit point arrives with the 'impact' event (hitAt): feet still count
      this.blockPend = amount; this.blockT = this.mgr.time; this.blockFrom.copy(from); this.blockSrc = info.source || null; this.blockWeapon = info.weapon || null;
    }
    this.blocked++; this.mgr.stats.blocked = (this.mgr.stats.blocked || 0) + 1;
    this.mesh.flinch(0, -1, 0.25);
    this.noticeAttacker(info, from);
    return 0;
  }
  blockFx(point, from, by) {
    TMP.subVectors(from, point).normalize();
    this.ctx.events.emit('impact', { point: point.clone(), normal: TMP.clone(), kind: 'shield', target: this, damage: 0, by: by || null, blocked: true });
  }

  // which part of the body a world point is on; also stores hitSide (-1..1, + = the bot's left)
  zoneOf(point) {
    const rel = (point.y - this.pos.y) / this.height, dx = point.x - this.pos.x, dz = point.z - this.pos.z;
    this.hitSide = THREE.MathUtils.clamp((dx * Math.cos(this.bodyYaw) - dz * Math.sin(this.bodyYaw)) / this.radius, -1, 1);
    return rel > 0.82 ? 'head' : rel < 0.42 ? 'leg' : 'torso';
  }

  // The exact point of a hit that takeDamage() has just handled (bots.js feeds this from 'impact' events).
  // Returns 'blocked' when the round was in fact stopped by the shield (bots.js then relabels the 'impact' event).
  hitAt(point, damage = 0, headshot = false) {
    if (this.ptSkip > 0) { this.ptSkip--; return; }
    if (this.blockPend > 0) {
      const amt = this.blockPend, fresh = this.blockT === this.mgr.time; this.blockPend = 0;
      if (fresh) {
        if (this.alive && point.y - this.pos.y < this.cfg.shieldFeet * this.height) { // under the shield: the feet
          this.blocked--; this.mgr.stats.blocked--;
          this.takeDamage(amt, { from: this.blockFrom, source: this.blockSrc, weapon: this.blockWeapon, shieldBypass: true, point }); this.ptSkip = Math.max(0, this.ptSkip - 1);
          return;
        }
        this.blockFx(point, this.blockFrom, this.blockSrc);
        return 'blocked';
      }
    }
    const zone = headshot ? 'head' : this.zoneOf(point), side = this.hitSide;
    if (!this.alive) { if (this.state === 'dead' && this.deadT < 0.05) this.mesh.deathHint(zone, side); return; }
    const str = Math.min(1.3, 0.35 + damage / 40) / Math.sqrt(Math.max(1, this.accN)) * (this.cfg.flinchScale || 1);
    if (zone === 'leg') { this.slowT = Math.max(this.slowT, 0.8 + damage / 40); this.mesh.legBuckle(side, str); }
    else this.mesh.flinch(0, this.hitLz * 0.25, str, side, zone === 'head' ? 'torso' : zone); // adds the twist away from the side that was hit
  }

  // Break the guard's balance: it stops firing and moving for a moment and reels in `dir` (world, horizontal).
  // strength 0..1.5. Returns false if it only flinched (dead, or still immune from the last stagger).
  stagger(strength = 1, dir = null, headshot = false, point = null) {
    if (!this.alive) return false;
    const cfg = this.cfg, res = cfg.staggerResist, d = dir || this.hitDir;
    const s = Math.sin(this.bodyYaw), c = Math.cos(this.bodyYaw), l = Math.hypot(d.x, d.z) || 1, lx = (d.x * c - d.z * s) / l, lz = (d.x * s + d.z * c) / l;
    strength = Math.min(1.5, Math.max(0.2, strength));
    if (this.stagImmT > 0 && strength < 1.25) { this.mesh.flinch(lx, lz, 0.5 * strength); return false; }
    const dur = (0.3 + 0.38 * strength + (headshot ? 0.15 : 0)) * res;
    this.stagT = this.stagDur = dur; this.stagAmt = Math.min(1, 0.55 + 0.45 * strength) * Math.min(1, res + 0.25); this.stagImmT = dur + cfg.staggerImmunity; this.stagX = lx;
    this.staggerT = dur; // (legacy field written by hitreact.js)
    this.burstLeft = 0; this.pauseT = Math.max(this.pauseT, dur + 0.12); this.telling = false; this.tellT = 0;
    if (this.special === 'shield') { this.shieldDownT = Math.max(this.shieldDownT, dur + cfg.shieldStaggerDrop); this.shieldUp = false; } // knocked aside: the opening
    else if (this.special === 'rusher' && (this.rush.phase === 'windup' || this.rush.phase === 'lunge')) { this.rush.phase = 'recover'; this.rush.t = dur + 0.3; this.clearPath(); }
    if (this.aimT > 0) this.cancelSnipe('hit');
    this.grenWind = 0;
    this.flinchErr = Math.min(0.14, this.flinchErr + 0.06); this.firstBurst = this.firstBurst || strength > 0.9;
    const push = (2.2 + 3.2 * strength) * res; this.vel.x += d.x / l * push; this.vel.z += d.z / l * push;
    this.mesh.flinch(lx, lz, 0.9 + 0.5 * strength, this.hitSide, headshot ? 'head' : 'torso');
    this.underFire = true; this.reposT = Math.min(this.reposT, dur + 0.05);
    this.ctx.events.emit('botStagger', { bot: this, point: point ? point.clone() : new THREE.Vector3(this.pos.x, this.pos.y + this.height * 0.7, this.pos.z), strength, dir: d.clone(), headshot });
    this.mgr.callout(this, 'hit');
    return true;
  }

  // Rounds are passing close (n near misses this instant). Enough of them make the guard duck and hesitate.
  suppress(n = 1) {
    if (!this.alive) return;
    const cfg = this.cfg;
    this.suppression = Math.min(1.5, this.suppression + cfg.suppressPerMiss * Math.min(3, n));
    if (this.suppression < cfg.suppressAt || this.supCd > 0) return;
    this.supCd = rand(2.2, 3.4);
    if (cfg.suppressResist < 1) this.duckT = rand(0.55, 1.0) * (1 - cfg.suppressResist);
    if (this.state === 'combat') {
      this.pauseT = Math.max(this.pauseT, rand(0.35, 0.7) * (1 - cfg.suppressResist * 0.6));
      if (Math.random() < 0.6) this.burstLeft = 0;
      this.telling = false; this.tellT = 0; this.flinchErr = Math.min(0.12, this.flinchErr + 0.04);
      if (this.mode !== 'cover') { this.underFire = true; this.reposT = Math.min(this.reposT, rand(0.2, 0.5)); }
    }
    this.ctx.events.emit('botSuppressed', { bot: this, level: this.suppression });
    this.mgr.callout(this, 'suppressed');
  }

  // The fall is chosen from the killing shot: where it came from, how hard it was, what the guard was doing.
  die(info = {}, lx = 0, lz = -1, amount = 0) {
    const cfg = this.cfg, mgr = this.mgr, hd = this.hitDir;
    const speed = Math.hypot(this.vel.x, this.vel.z), from = info.from || (info.source && info.source.pos) || null;
    const dist = from ? Math.hypot(this.pos.x - from.x, this.pos.z - from.z) : 10;
    const blast = !info.explosive && (this.accN >= 3 || /shotgun/.test(info.weapon || '')) && amount < 60; // a pellet load
    let style = 'topple', force = Math.min(1.2, 0.35 + amount / 80), kx = 0, ky = 0, kz = 0;
    if (!from && !info.dir) { style = 'slump'; force = 0.3; }
    else if (info.explosive) { style = 'thrown'; force = 1.4; if (this.vel.y < 3) { ky = 3; kx = hd.x * 3; kz = hd.z * 3; } }
    else if (blast) {
      force = THREE.MathUtils.clamp(1.35 - dist / 13, 0.35, 1.25);
      if (force > 0.6) { style = 'thrown'; kx = hd.x * 5.2 * force; kz = hd.z * 5.2 * force; ky = 2.2 + 2.2 * force; } else style = 'blown';
    } else if (info.headshot) {
      if (amount >= 60) { style = 'snapback'; force = 1.1; kx = hd.x * 3; kz = hd.z * 3; ky = 1.2; }
      else if (speed > 4) style = 'tumble';
      else style = Math.random() < 0.7 ? 'crumple' : 'snapback';
    } else if (amount >= 50) { style = 'blown'; force = 1.1; kx = hd.x * 3.6; kz = hd.z * 3.6; ky = 1.6; }
    else if (speed > 4.2) style = 'tumble';
    else { const r = Math.random(); style = r < 0.55 ? 'topple' : r < 0.78 ? 'slump' : 'spin'; }
    if (info.deathStyle) style = info.deathStyle; // scripted / test override
    let side = this.hitSide;
    if (style === 'tumble' && speed > 0.5) { // carried on by its own momentum: goes down the way it was running
      const s = Math.sin(this.bodyYaw), c = Math.cos(this.bodyYaw);
      lx = (this.vel.x * c - this.vel.z * s) / speed + lx * 0.25; lz = (this.vel.x * s + this.vel.z * c) / speed + lz * 0.25; force = Math.min(1.2, speed / 7);
    }
    const k = cfg.staggerResist; // heavies are thrown less
    if (kx || ky || kz) { this.vel.x += kx * k; this.vel.z += kz * k; if (ky) { this.vel.y = Math.max(this.vel.y, ky * k); this.body.grounded = false; this.body.coyote = 0; } }
    this.alive = false; this.state = 'dead'; this.deadT = 0; this.hp = 0; this.stats.deaths++;
    this.releaseToken(); this.clearPath(); this.evalJob = null; this.visible = false; this.target = null;
    this.stagT = 0; this.telling = false; this.duckT = 0; this.height = this.baseHeight;
    this.aimT = 0; this.locked = false; this.grenWind = 0; this.shieldUp = false; if (mgr.roles) mgr.roles.laserOff(this);
    if (this.poi && this.poi.claimedBy === this) this.poi.claimedBy = null;
    this.mesh.die({ lx, lz, style, force, side, vel: this.vel, dirX: hd.x, dirZ: hd.z });
    this.deathStyle = style;
    const by = info.source || info.by || null;
    this.ctx.events.emit('botDied', { bot: this, point: new THREE.Vector3(this.pos.x, this.pos.y + 1, this.pos.z), by, headshot: !!info.headshot, dir: hd.clone(), force, style, weapon: info.weapon || null, explosive: !!info.explosive, faction: this.faction, kind: this.kind });
    mgr.allyDown(this);
    if (mgr.botDied) mgr.botDied(this, by);
  }

  dispose() { this.alive = false; this.releaseToken(); this.clearPath(); if (this.mgr.roles) this.mgr.roles.release(this); this.mesh.dispose(); }

  // ===========================================================================
  // movement
  // ===========================================================================
  clearPath() {
    if (this.pathReq) { this.pathReq.cancelled = true; this.pathReq = null; }
    this.path = null; this.pathI = 0; this.onArrive = null; this.onFail = null;
  }
  get moving() { return !!(this.path || this.pathReq); }

  moveTo(target, speed, opts = {}) {
    const nav = this.nav, p = this.pos;
    if (this.pathReq) { this.pathReq.cancelled = true; this.pathReq = null; }
    this.goal.copy(target); this.moveSpeed = speed; this.goalId = opts.goalId ?? -1;
    this.onArrive = opts.onArrive || null; this.onFail = opts.onFail || null;
    this.stuckN = opts.keepStuck ? this.stuckN : 0; this.stuckT = 0; this.stuckPos.copy(p);
    const d = Math.hypot(target.x - p.x, target.z - p.z);
    if (this.body.grounded && d < 16 && Math.abs(target.y - p.y) < 0.6 && nav.lineClear(p.x, p.y, p.z, target.x, target.z)) {
      this.setPath([{ x: p.x, y: p.y, z: p.z, t: 0, pad: null }, { x: target.x, y: target.y, z: target.z, t: 0, pad: null }]);
      return;
    }
    const req = this.pathReq = nav.requestPath(p, target, (pts) => {
      if (this.pathReq !== req) return;
      this.pathReq = null;
      if (!pts || !this.alive) { this.path = null; const f = this.onFail; this.onArrive = this.onFail = null; if (f) f(); return; }
      this.setPath(pts);
    }, { goalId: this.goalId, air: !this.body.grounded });
  }

  setPath(pts) {
    const p = this.pos;
    this.path = pts;
    let i = 0;
    if (pts.length > 1 && !pts[0].pad) {
      const off = Math.hypot(pts[0].x - p.x, pts[0].z - p.z);
      if (off < 0.3 || (off < 1.2 && pts[1].t === 0 && this.nav.lineClear(p.x, p.y, p.z, pts[1].x, pts[1].z))) i = 1;
    }
    this.pathI = i;
    let x0 = p.x, x1 = p.x, z0 = p.z, z1 = p.z;
    for (const q of pts) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z; }
    this.pathBB = { x0: x0 - 1, x1: x1 + 1, z0: z0 - 1, z1: z1 + 1 };
    this.pathVersion = this.nav.version;
  }

  repath() {
    if (!this.path && !this.pathReq) return;
    this.stats.repaths++;
    const a = this.onArrive, f = this.onFail;
    this.path = null;
    this.moveTo(TMP3.copy(this.goal), this.moveSpeed, { goalId: this.goalId, onArrive: a, onFail: f, keepStuck: true });
  }

  arrive() {
    const a = this.onArrive; this.path = null; this.onArrive = this.onFail = null;
    if (a) a();
  }
  failMove() {
    const f = this.onFail; this.clearPath();
    if (f) f();
  }

  followPath(dt) {
    this.wx = 0; this.wz = 0; this.wishSpeed = 0;
    const path = this.path; if (!path || this.padFlight) return;
    const p = this.pos;
    for (let guard = 0; guard < 4; guard++) {
      const wp = path[this.pathI], last = this.pathI === path.length - 1;
      const tx = wp.pad ? wp.pad.x : wp.x, tz = wp.pad ? wp.pad.z : wp.z;
      const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
      const next = last ? null : path[this.pathI + 1];
      const dy = Math.abs(p.y - wp.y);
      let reached = false, tight = false;
      if (wp.pad) reached = false;                                             // keep walking to the pad centre until launched
      else if (wp.t === 2) reached = this.body.grounded && d < 1.8 && dy < 1.3; // landing zone of a pad flight
      else if (last) reached = d < 0.25 && dy < 1.3;
      else if (next.t === 1 || next.pad) reached = d < 0.2 && dy < 1.3 && (wp.t === 0 || this.body.grounded);
      else if (d < 0.45 && dy < 1.3 && (wp.t === 0 || this.body.grounded)) {
        // cut the corner only if the straight walk to the next waypoint is clear from where we stand
        reached = d < 0.1 || (dy < 0.7 && this.nav.lineClear(p.x, p.y, p.z, next.x, next.z));
        tight = !reached;
      }
      if (reached) {
        if (last) { this.arrive(); return; }
        this.pathI++; continue;
      }
      if (d > 1e-3) { this.wx = dx / d; this.wz = dz / d; }
      let sp = this.moveSpeed;
      if (last) sp = Math.min(sp, Math.max(1.4, d * 5));
      if (next && next.t === 1) sp = Math.min(sp, Math.max(2.5, d * 4 + 2)); // ease up to ledges
      if (wp.pad) sp = Math.min(sp, Math.max(1.6, d * 3));
      if (tight) sp = Math.min(sp, Math.max(1.5, d * 9));
      this.wishSpeed = sp;
      return;
    }
  }

  move(dt) {
    const b = this.body, cfg = this.cfg;
    const prevAir = b.airTime;
    this.followPath(dt);
    let wx = this.wx, wz = this.wz, sp = this.wishSpeed;
    if (this.stagT > 0) { wx = 0; wz = 0; sp = 0; this.wishSpeed = 0; }                       // reeling: no control of the legs
    else if (this.slowT > 0) { sp *= this.cfg.legHitSlow; this.wishSpeed = sp; }               // limping on a hit leg
    else if (this.duckT > 0) sp *= 0.7;
    if (this.sepX || this.sepZ) { // nudge away from allies / the player
      this.vel.x += this.sepX * 7 * dt; this.vel.z += this.sepZ * 7 * dt; this.sepX = 0; this.sepZ = 0;
    }
    // (ground friction caps a body at accel / 8 m/s: 55 -> 6.9 m/s for everyone but the rusher, whose legs keep up with its speed)
    const pad = stepBody(b, this.ctx.world, dt, wx, wz, sp, this.special === 'rusher' ? Math.max(55, sp * 8 + 25) : 55, true, PAD_TRIGGER_R);
    if (pad) {
      this.padFlight = true; this.stats.pads++; pad.pulse = 1;
      const link = this.nav.padLinks.find((l) => l.pad === pad);
      if (link && link.time > 0.2) { this.vel.x += (pad.x - this.pos.x) / link.time; this.vel.z += (pad.z - this.pos.z) / link.time; } // cancel the off-centre start
      const wp = this.path && this.path[this.pathI];
      if (wp && wp.pad === pad && this.pathI < this.path.length - 1) this.pathI++;
      else if (this.path) this.needRepath = true;
    }
    if (b.landed) {
      if (this.padFlight) {
        this.padFlight = false;
        const wp = this.path && this.path[this.pathI];
        if (wp && (Math.hypot(wp.x - this.pos.x, wp.z - this.pos.z) > 2 || Math.abs(wp.y - this.pos.y) > 1.3)) this.needRepath = true;
      } else if (prevAir > 0.4 && this.path) {
        const wp = this.path[this.pathI];
        if (!(wp.t === 1 && Math.abs(wp.y - this.pos.y) < 0.8)) this.needRepath = true; // fell somewhere unplanned
      }
    }
    if (this.padFlight && b.grounded) this.padFlight = false;
    if (this.pos.y < -30) { this.die({}); return; }

    // housekeeping a few times per second: world changed under the path? stuck?
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = 0.4;
      if (this.path) {
        if (this.nav.changedSince(this.pathVersion, this.pathBB)) this.needRepath = true; else this.pathVersion = this.nav.version;
      }
    }
    if (this.needRepath && b.grounded) { this.needRepath = false; this.repath(); }
    if (this.path && this.wishSpeed > 1 && !this.padFlight) {
      this.stuckT += dt;
      if (this.stuckT > 0.8) {
        const moved = this.stuckPos.distanceTo(this.pos);
        this.stuckT = 0; this.stuckPos.copy(this.pos);
        if (moved < 0.3) {
          this.stuckN++; this.stats.stuck++;
          if (this.cfg.debug) { const w = this.path[this.pathI]; this.mgr.stuckLog.push([this.name, this.state, this.stuckN, +this.pos.x.toFixed(2), +this.pos.y.toFixed(2), +this.pos.z.toFixed(2), '->', +w.x.toFixed(2), +w.y.toFixed(2), +w.z.toFixed(2), w.t, w.pad ? 'pad' : '', this.pathI + '/' + this.path.length, this.body.grounded ? 'g' : 'air']); }
          if (this.stuckN === 1) this.repath();
          else if (this.stuckN === 2) { if (b.grounded) { this.vel.y = JUMP * 0.85; b.grounded = false; b.coyote = 0; } this.vel.x += (Math.random() - 0.5) * 4; this.vel.z += (Math.random() - 0.5) * 4; }
          else { this.stuckN = 0; this.failMove(); }
        } else if (moved > 1) this.stuckN = 0;
      }
    } else { this.stuckT = 0; this.stuckPos.copy(this.pos); }
  }

  // ===========================================================================
  // senses
  // ===========================================================================
  memOf(t) { let m = this.mem.get(t); if (!m) { m = { aware: 0, visT: -99, vis: false, revealT: -99 }; this.mem.set(t, m); } return m; }
  isEnemy(t) { return t !== this && t.alive && t.pos && (this.cfg.ffa || t.team !== this.team); }

  // Staggered senses: the current target is checked every tick (chest, then head); other potential enemies in view
  // are checked a couple per tick in rotation, within the global per-frame ray budget. Then the best visible enemy is chosen.
  // ---- team mode (guards vs the player): awareness-based detection ----------
  get leashed() { return this.role === 'passive' || this.special === 'marksman'; }
  inLeash(p) { return !this.leashed || Math.hypot(p.x - this.post.x, p.z - this.post.z) <= (this.special === 'marksman' ? this.cfg.perchLeash : this.cfg.passiveLeash); } // (a marksman stays on its perch)

  perceiveTeam() {
    const cfg = this.cfg, mgr = this.mgr, world = this.ctx.world, iv = cfg.perceptionInterval, now = mgr.time, pl = this.ctx.player;
    const inFight = this.state === 'combat', combat = inFight && this.target === pl; // `combat`: fighting the PLAYER (a fight with a hostile bot does not sharpen the senses toward the player)
    let sight = false, d = 1e9;
    if (pl.alive && !this.far) {
      const ex = this.pos.x, ey = this.pos.y + EYE, ez = this.pos.z, h = tH(pl);
      const dx = pl.pos.x - ex, dz = pl.pos.z - ez, dy = pl.pos.y + h * 0.6 - ey; d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const range = (this.role === 'passive' ? cfg.sightRangePassive : cfg.sightRange) * (combat ? cfg.trackRangeMult : 1);
      const fov = (combat ? cfg.combatFovDeg : cfg.fovDeg) * Math.PI / 360, ang = Math.abs(wrap(Math.atan2(dx, dz) - this.aimYaw));
      if (d < range && (ang < fov || d < cfg.closeSense)) {
        TMP.set(ex, ey, ez); TMP2.set(pl.pos.x, pl.pos.y + h * 0.6, pl.pos.z);
        sight = world.lineOfSight(TMP, TMP2); mgr.rayBudget--; mgr.stats.rays++;
        if (!sight) { TMP2.y = pl.pos.y + h - 0.12; sight = world.lineOfSight(TMP, TMP2); mgr.rayBudget--; mgr.stats.rays++; }
        if (sight) {
          this.sightT = now;
          if (combat) this.awareness = 1;
          else {
            const sm = cfg.sightMods, sp = Math.hypot(pl.vel.x, pl.vel.z);
            let rate = 1 / THREE.MathUtils.lerp(cfg.detectTimeNear, cfg.detectTimeFar, d / range);
            if (pl.crouching) rate *= sm.crouching;
            if (sp < 0.5) rate *= sm.still; else if (sp > cfg.walkSpeed + 1.2) rate *= sm.sprinting;
            rate *= THREE.MathUtils.lerp(sm.coneCentre, sm.coneEdge, Math.min(1, ang / fov));
            if (this.state !== 'patrol') rate *= sm.onGuard;
            this.awareness = Math.min(1, this.awareness + rate * iv);
            this.stim.copy(pl.pos);
          }
        }
      }
    }
    if (!sight && !combat) this.awareness = Math.max(0, this.awareness - (this.far ? iv * 3 : iv) / cfg.forgetTime);
    if (this.awareness < cfg.suspiciousAt * 0.6) this.susActed = false;
    const plVis = sight && this.awareness >= 1, foeVis = this.perceiveFoes(now);
    // who to fight: the player or a hostile bot — the nearer one, with a bias to whoever shot me last and to the current target
    let T = plVis ? pl : null;
    if (foeVis) {
      const f = this.foe;
      if (!T) T = f;
      else {
        const rec = now - this.lastAttackT < 4 ? this.lastAttacker : null;
        const sp = d - (rec === pl ? 12 : 0) - (this.target === pl ? 8 : 0), sf = this.pos.distanceTo(f.pos) - (rec === f ? 12 : 0) - (this.target === f ? 8 : 0);
        if (sf < sp) T = f;
      }
    }
    this.visible = !!T;
    if (T) {
      if (T !== this.target) { this.releaseToken(); if (inFight) this.setTarget(T); else this.target = T; }
      this.lastSeen.copy(T.pos); this.lastSeenVel.copy(T.vel || ZERO); this.lastSeenTime = now;
      if (!inFight) this.enterCombat();
    } else if (sight && !inFight && this.awareness >= cfg.suspiciousAt && !this.susActed && (this.state === 'patrol' || this.state === 'search')) {
      this.concernPl = true; this.react(pl.pos, 'peek'); // glimpsed something: stop, turn, take a few steps to look
    }
  }

  // Hostile bots (guards <-> raiders): keeps this.foe = the hostile bot being watched, returns whether it is in sight.
  // The current foe is ray-checked every tick; one other candidate per tick is checked in rotation (global ray budget).
  perceiveFoes(now) {
    const mgr = this.mgr, cfg = this.cfg, list = mgr.bots, n = list.length;
    let foe = this.foe;
    if (foe && (!foe.alive || foe.faction === this.faction)) foe = this.foe = null;
    if (!mgr.raiders.length) return (this.foeVis = false); // nobody to fight but the player
    const range = this.leashed ? cfg.engageRange : cfg.foeViewDist, fov = (this.state === 'combat' ? cfg.combatFovDeg : cfg.fovDeg) * Math.PI / 360;
    let vis = false, fd = 1e9;
    if (foe) { fd = this.pos.distanceTo(foe.pos); vis = fd < range * 1.2 && this.seeBot(foe); if (!vis && now - (this.foeSeenT || -99) > 6) foe = this.foe = null; }
    if (!vis || this.state !== 'combat') { // look for a (closer) one
      for (let k = 0; k < n; k++) {
        this.scanI = (this.scanI + 1) % n;
        const o = list[this.scanI];
        if (o === foe || !o.alive || o.faction === this.faction) continue;
        const dx = o.pos.x - this.pos.x, dz = o.pos.z - this.pos.z, d2 = dx * dx + dz * dz;
        if (d2 > range * range || (vis && d2 > fd * fd * 0.6)) continue;
        if (!(d2 < cfg.closeSense * cfg.closeSense * 4 || (o === this.lastAttacker && now < this.foeRevealT) || Math.abs(wrap(Math.atan2(dx, dz) - this.aimYaw)) < fov)) continue;
        if (mgr.rayBudget <= 0) break;
        if (this.seeBot(o)) { foe = this.foe = o; vis = true; }
        break; // one candidate per tick
      }
    }
    if (vis) this.foeSeenT = now;
    return (this.foeVis = vis);
  }
  seeBot(o) {
    const mgr = this.mgr; mgr.rayBudget--; mgr.stats.rays++;
    TMP.set(this.pos.x, this.pos.y + EYE, this.pos.z); TMP2.set(o.pos.x, o.pos.y + o.height * 0.7, o.pos.z);
    return this.ctx.world.lineOfSight(TMP, TMP2);
  }

  // Gunfire / a call-out that is NOT about the player (a fight between guards and raiders): go and look, or turn and
  // watch if it is outside this guard's leash. Does not touch the awareness of the player (the detect HUD stays honest).
  hearFoe(p) {
    if (!this.alive || this.state === 'combat' || this.state === 'chase') return;
    if (this.concernPl && this.state !== 'patrol') return; // busy looking for the player
    const was = this.susActed;
    this.concernPl = false; this.react(p, this.inLeash(p) ? 'go' : 'watch'); this.susActed = was;
  }

  // A stimulus (noise, call-out) at `p`: raise awareness and decide how to respond. kind: 'shot' | 'noise'
  hear(p, add, kind = 'noise', floor = 0) {
    if (!this.alive) return;
    const cfg = this.cfg;
    if (this.state === 'combat') { if (!this.visible && kind === 'shot') this.lastSeen.copy(p); return; }
    this.awareness = Math.min(0.95, Math.max(this.awareness + add, floor)); // noise alone never makes a guard fully alert
    this.stim.copy(p);
    if (this.awareness < cfg.suspiciousAt) return;
    this.concernPl = true;
    if (kind === 'shot') this.react(p, this.inLeash(p) ? 'go' : 'watch');
    else if (!this.susActed) this.react(p, this.inLeash(p) ? 'peek' : 'watch');
  }

  // respond to a stimulus: 'go' = investigate the spot, 'peek' = a few steps toward it, 'watch' = turn and hold
  react(p, mode) {
    const cfg = this.cfg, d = this.pos.distanceTo(p);
    if (this.special === 'marksman' && mode !== 'watch') mode = 'watch'; // a marksman does not leave its perch to look
    this.susActed = true;
    if (this.state === 'investigate' && (this.investMode === 'go' || mode !== 'go') && this.alertPos.distanceTo(p) < 8) { if (mode === 'go' && this.investMode === 'go') this.alertPos.copy(p); return; }
    const noise = mode === 'go' ? Math.min(4, d * 0.07) : 0;
    this.alertPos.set(p.x + gauss() * noise, p.y, p.z + gauss() * noise);
    this.state = 'investigate'; this.investMode = mode; this.investT = rand(0.4, 0.9); this.investGo = false; this.watchT = cfg.watchTime;
    this.lookPt.copy(this.alertPos); this.lookPt.y += 1.2; this.lookMove = false;
    if (this.poi && this.poi.claimedBy === this) this.poi.claimedBy = null;
    this.clearPath();
  }

  perceive() {
    if (!this.cfg.ffa) return this.perceiveTeam();
    const cfg = this.cfg, mgr = this.mgr, world = this.ctx.world, iv = cfg.perceptionInterval, now = mgr.time, list = this.ctx.targets, sc = cfg.targetScore;
    if (this.target && !this.isEnemy(this.target)) this.loseTarget(true);
    const ex = this.pos.x, ey = this.pos.y + EYE, ez = this.pos.z, combat = this.state === 'combat';
    const fov = (combat ? cfg.combatFovDeg : cfg.fovDeg) * Math.PI / 360;
    let best = null, bs = -Infinity, extra = 0;
    const n = list.length; this.scanI = (this.scanI + 1) % Math.max(1, n);
    for (let k = -1; k < n; k++) {
      const t = k < 0 ? this.target : list[(k + this.scanI) % n];
      if (!t || (k >= 0 && t === this.target) || !this.isEnemy(t)) continue;
      const cur = t === this.target, m = this.memOf(t), h = tH(t);
      const dx = t.pos.x - ex, dz = t.pos.z - ez, dy = t.pos.y + h * 0.6 - ey, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let vis = false, checked = true;
      if (d < cfg.viewDist && (now < m.revealT || d < cfg.closeSense || Math.abs(wrap(Math.atan2(dx, dz) - this.aimYaw)) < fov)) {
        if (!cur && (extra >= cfg.perceiveOthersPerTick || mgr.rayBudget <= 0)) checked = false; // not this tick: keep what we knew
        else {
          if (!cur) extra++;
          TMP.set(ex, ey, ez); TMP2.set(t.pos.x, t.pos.y + h * 0.6, t.pos.z);
          vis = world.lineOfSight(TMP, TMP2); mgr.rayBudget--; mgr.stats.rays++;
          if (!vis && cur) { TMP2.y = t.pos.y + h - 0.12; vis = world.lineOfSight(TMP, TMP2); mgr.rayBudget--; mgr.stats.rays++; }
        }
      }
      if (!checked) m.vis = m.vis && now - m.visT < 0.6;
      else {
        if (vis) {
          if ((combat && cur) || now < m.revealT) m.aware = 1;
          else {
            let rate = 1 / THREE.MathUtils.lerp(cfg.detectTimeNear, cfg.detectTimeFar, d / cfg.viewDist);
            if (this.state !== 'patrol') rate *= 3;
            if (t.crouching) rate *= 0.7;
            m.aware = Math.min(1, m.aware + rate * iv * (cur ? 1 : Math.max(1, Math.min(4, (now - (m.chkT || now)) / iv))));
          }
          if (m.aware >= 1) m.visT = now;
        } else if (!(combat && cur)) m.aware = Math.max(0, m.aware - iv * 0.35);
        m.chkT = now;
        m.vis = vis && m.aware >= 1;
      }
      if (!m.vis) continue;
      let s = -d * sc.perMeter + (cur ? sc.sticky : 0);
      if (t === this.lastAttacker && now - this.lastAttackT < sc.attackerMemory) s += sc.attacker;
      if (t.maxHp > 0 && t.hp >= 0) s += (1 - Math.min(1, t.hp / t.maxHp)) * sc.lowHealth;
      if (s > bs) { bs = s; best = t; }
    }
    if (best && best !== this.target) this.setTarget(best);
    const T = this.target;
    this.visible = !!T && this.memOf(T).vis;
    this.awareness = T ? this.memOf(T).aware : Math.max(0, this.awareness - iv * 0.35);
    if (this.visible) {
      this.lastSeen.copy(T.pos); this.lastSeenVel.copy(T.vel || ZERO); this.lastSeenTime = now;
      if (!combat) this.enterCombat();
    }
  }

  setTarget(t) {
    const cfg = this.cfg;
    this.target = t; this.lastSeen.copy(t.pos); this.lastSeenVel.copy(t.vel || ZERO);
    if (this.state === 'combat') { // switching mid-fight: a short re-acquire, and the first burst walks in again
      this.reactT = Math.max(this.reactT, randR(cfg.reacquireTime)); this.firstBurst = true; this.evalJob = null; this.reposT = Math.min(this.reposT, 0.3); this.unseenT = 0;
    }
  }

  // the current target died (dead = true) or is gone
  loseTarget(dead) {
    const was = this.target; this.target = null; this.visible = false; this.releaseToken(); this.evalJob = null;
    if (was) this.mem.delete(was);
    if (!this.alive) return;
    if (this.state === 'combat' || this.state === 'chase') {
      if (dead) { this.startSearch(); this.searchT = this.cfg.searchAfterKill; } else { this.state = 'patrol'; this.waitT = rand(0.5, 2); this.clearPath(); }
    }
  }

  // something drew attention to `p` (a noise, a hit, an ally's call-out)
  alert(p, delay = 0.4, certain = false) {
    if (!this.cfg.ffa) { this.hear(p, 0.3, 'shot', this.cfg.suspiciousAt + 0.1); return; }
    if (!this.alive || this.state === 'combat') {
      if (this.alive && !this.visible) { this.lastSeen.copy(p); }
      return;
    }
    const d = this.pos.distanceTo(p), noise = certain ? 0 : Math.min(5, d * 0.08);
    this.alertPos.set(p.x + gauss() * noise, p.y, p.z + gauss() * noise);
    this.awareness = Math.max(this.awareness, 0.55);
    if (this.state === 'investigate' && this.investT <= 0 && this.goal.distanceTo(this.alertPos) < 6) return; // already on the way there
    this.state = 'investigate'; this.investT = delay; this.investGo = false;
    this.lookPt.copy(this.alertPos); this.lookPt.y += 1.2; this.lookMove = false;
    if (this.poi && this.poi.claimedBy === this) this.poi.claimedBy = null;
    this.clearPath();
  }

  enterCombat() {
    const cfg = this.cfg, now = this.mgr.time;
    const fresh = now - this.lastCombatT > 4;
    this.state = 'combat'; this.lastCombatT = now;
    this.investMode = 'go';
    this.reactT = (fresh ? randR(cfg.reactionTime) + cfg.reactionPerMeter * Math.hypot(this.lastSeen.x - this.pos.x, this.lastSeen.z - this.pos.z) : randR(cfg.reacquireTime)) * (1 - cfg.aggrReaction * this.mgr.aggr);
    this.firstBurst = true; this.hunting = false; this.telling = false; this.underFire = false;
    this.concernPl = this.target === this.ctx.player;
    if (!cfg.ffa) { if (this.concernPl) this.mgr.lastContactT = now; if (fresh) { this.prefRange = randR(cfg.preferredRange) * (1 - 0.25 * this.mgr.aggr); this.mgr.callout(this, 'contact'); } }
    if (fresh) this.settle = 0;
    this.mode = 'engage'; this.modeT = randR(cfg.peekTime); this.reposT = rand(0.4, 1.0); this.evalJob = null; this.unseenT = 0;
    this.burstLeft = 0; this.pauseT = 0; this.shotT = 0; this.lookMove = false;
    if (this.poi && this.poi.claimedBy === this) this.poi.claimedBy = null;
    this.clearPath();
    if (!cfg.ffa) this.mgr.callOut(this, this.lastSeen);
  }

  // `t` respawned / vanished (the player after dying): drop what we knew about it
  forget(t = null) {
    if (!this.alive) return;
    if (t) { this.mem.delete(t); if (this.lastAttacker === t) this.lastAttacker = null; if (!this.cfg.ffa) { this.awareness = 0; this.susActed = false; if (this.state === 'investigate' || this.state === 'search') { this.state = 'patrol'; this.waitT = rand(0.5, 2); this.clearPath(); } } if (this.target !== t) return; }
    if (!this.cfg.ffa) { this.awareness = 0; this.susActed = false; }
    this.loseTarget(false); this.awareness = 0;
    if (this.state !== 'patrol' && (!t || this.state === 'combat' || this.state === 'chase')) { this.state = 'patrol'; this.waitT = rand(0.5, 2); this.clearPath(); }
  }

  // ===========================================================================
  // brain
  // ===========================================================================
  think(dt) {
    const cfg = this.cfg;
    switch (this.state) {
      case 'patrol': {
        this.lookMove = true;
        if (this.moving) break;
        this.waitT -= dt;
        if (this.waitT <= 0) {
          if (!cfg.ffa && this.squad && this.mgr.squadGoal(this)) break; // posted guards, road patrols, raider squads (squads.js)
          if (!cfg.ffa && this.role === 'passive') this.pickPostGoal();
          else if (!cfg.ffa && this.mgr.aggr > 0.25 && this.mgr.time > this.huntCdT && Math.random() < this.mgr.aggr && this.huntGoal()) break; // late raid: go looking for the intruder
          else this.pickPatrolGoal();
        }
        break;
      }
      case 'investigate': {
        if (this.investT > 0) { this.investT -= dt; break; }
        if (!cfg.ffa && this.investMode !== 'go') {
          if (!this.investGo) {
            this.investGo = true;
            if (this.investMode === 'peek') { // a few metres toward the stimulus, then stand and look
              const dx = this.alertPos.x - this.pos.x, dz = this.alertPos.z - this.pos.z, d = Math.hypot(dx, dz) || 1, step = Math.min(cfg.peekDistance, Math.max(0, d - 3));
              const id = step > 1 ? this.nav.nearestNode(this.pos.x + dx / d * step, this.pos.y, this.pos.z + dz / d * step, 2, 1.2, true) : -1;
              if (id >= 0 && this.inLeash(this.nav.nodePos(id, TMP3))) this.moveTo(TMP3, cfg.patrolSpeed, { goalId: id });
            }
          }
          if (!this.moving) { this.watchT -= dt; if (this.watchT <= 0) { this.state = 'patrol'; this.waitT = rand(0.3, 1); } }
          break;
        }
        if (!this.investGo) {
          this.investGo = true;
          this.lastSeen.copy(this.alertPos);
          const done = () => this.startSearch();
          this.moveTo(this.alertPos, cfg.ffa ? cfg.sprintSpeed * 0.9 : this.hunting ? cfg.walkSpeed + (cfg.sprintSpeed - cfg.walkSpeed) * 0.7 : cfg.walkSpeed, { onArrive: done, onFail: done });
        }
        this.lookMove = this.moving && this.pos.distanceTo(this.alertPos) > 12;
        break;
      }
      case 'combat': this.thinkCombat(dt); break;
      case 'chase': {
        this.lookMove = this.pos.distanceTo(this.lastSeen) > 10;
        this.lookPt.copy(this.lastSeen); this.lookPt.y += 1.2;
        if (!this.moving) this.startSearch();
        break;
      }
      case 'search': {
        this.searchT -= dt;
        if (this.searchT <= 0) { this.target = null; this.state = 'patrol'; this.waitT = 0.5; this.hunting = false; if (cfg.ffa) this.awareness = 0; this.clearPath(); break; } // team mode: awareness decays over forgetTime
        this.lookMove = this.moving;
        if (this.moving) break;
        this.waitT -= dt;
        if (this.waitT <= 0) {
          const s = this.lastSeen, r = 13;
          if (!cfg.ffa && (!this.inLeash(s) || this.special === 'marksman')) { this.waitT = 1; break; } // passive guard too far from its post (and any marksman): stand and scan
          const id = this.nav.randomNode(s.x - r, s.x + r, s.z - r, s.z + r, s.y - 4.5, s.y + 4.5, 10);
          this.waitT = 0.4;
          if (id >= 0) {
            this.nav.nodePos(id, TMP3);
            const wait = () => { this.waitT = rand(0.8, 2); this.scanBase = this.aimYaw; };
            this.moveTo(TMP3, cfg.walkSpeed * 0.85, { goalId: id, onArrive: wait, onFail: wait });
          }
        }
        break;
      }
    }
  }

  // Send this guard to look for the intruder at `p` (heat system / late-raid hunting). It moves fast and searches
  // there, but still has to SEE the player to open fire: the detection rules are unchanged.
  huntTo(p, noise = 0) {
    if (!this.alive || this.state === 'combat' || this.state === 'chase' || this.special === 'marksman') return false;
    const cfg = this.cfg;
    this.alertPos.set(p.x + gauss() * noise, p.y, p.z + gauss() * noise);
    this.hunting = true; this.concernPl = true; this.huntCdT = this.mgr.time + rand(14, 24);
    this.awareness = Math.max(this.awareness, cfg.suspiciousAt + 0.05); this.susActed = true; this.stim.copy(this.alertPos);
    this.state = 'investigate'; this.investMode = 'go'; this.investT = rand(0.1, 0.5); this.investGo = false;
    this.lookPt.copy(this.alertPos); this.lookPt.y += 1.2; this.lookMove = false;
    if (this.poi && this.poi.claimedBy === this) this.poi.claimedBy = null;
    this.clearPath();
    return true;
  }
  // late raid: a guard that knows roughly where the player is goes there instead of walking its round
  huntGoal() {
    const mgr = this.mgr, cfg = this.cfg, g = mgr.aggr, now = mgr.time, pl = this.ctx.player;
    if (!pl.alive) return false;
    const recent = now - this.lastSeenTime < 25 + 80 * g, sus = this.awareness >= cfg.suspiciousAt;
    const net = g >= 0.75 && now - mgr.lastContactT < 90; // lockdown: positions are shared over the radio, with a big error
    if (!recent && !sus && !net) return false;
    const src = net ? pl.pos : sus ? this.stim : this.lastSeen;
    return this.huntTo(src, net ? 15 - 6 * g : 5);
  }

  startSearch() {
    this.state = 'search'; this.searchT = this.cfg.searchTime * (1 + this.mgr.aggr * (this.hunting ? 1 : 0.6)); this.waitT = rand(0.6, 1.4); this.scanBase = this.aimYaw; this.clearPath();
  }

  // passive guards idle around their post
  pickPostGoal() {
    const cfg = this.cfg, q = this.post, far = Math.hypot(this.pos.x - q.x, this.pos.z - q.z) > cfg.passiveLoopRadius;
    const r = far ? 1.5 : cfg.passiveLoopRadius * 0.7;
    const id = this.nav.randomNode(q.x - r, q.x + r, q.z - r, q.z + r, q.y - 0.6, q.y + 0.6, 12);
    if (id < 0 || Math.random() < 0.25 && !far) { this.waitT = rand(2, 5); this.scanBase = this.aimYaw + rand(-1.5, 1.5); return; }
    this.nav.nodePos(id, TMP3);
    const wait = () => { this.waitT = rand(2.5, 7); this.scanBase = this.aimYaw; };
    this.moveTo(TMP3, cfg.patrolSpeed * (far ? 1 : 0.7), { goalId: id, onArrive: wait, onFail: wait });
  }

  pickPatrolGoal() {
    const pick = this.mgr.pickPoi(this);
    if (!pick) { this.waitT = 0.5; return; }
    this.poi = pick.poi;
    this.nav.nodePos(pick.id, TMP3);
    this.moveTo(TMP3, this.cfg.patrolSpeed * rand(0.9, 1.15), {
      goalId: pick.id,
      onArrive: () => { this.waitT = rand(1, 3.5); this.scanBase = this.aimYaw; this.mgr.poiVisited(pick.poi, this); },
      onFail: () => { this.waitT = 0.3; if (pick.poi.claimedBy === this) pick.poi.claimedBy = null; pick.poi.fails++; },
    });
  }

  thinkCombat(dt) {
    const cfg = this.cfg, mgr = this.mgr;
    this.lastCombatT = mgr.time;
    if (!this.target) { this.startSearch(); this.searchT = cfg.searchAfterKill; return; }
    if (this.special === 'rusher') { this.thinkRush(dt); return; }
    if (this.special === 'marksman' && this.visible && !this.underFire && this.hp >= cfg.retreatHp) this.reposT = Math.max(this.reposT, 0.5); // holds its perch while it has the shot
    if (this.aimT > 0 || this.grenWind > 0) { this.reposT = Math.max(this.reposT, 0.25); this.modeT = Math.max(this.modeT, 0.25); if (this.path && this.aimT > 0) this.clearPath(); } // stands still to aim / throw
    this.modeT -= dt; this.reposT -= dt;
    this.lookPt.copy(this.lastSeen); this.lookPt.y += 1.15;
    const hurt = this.hp < cfg.retreatHp;

    if (this.mode === 'cover') {
      this.lookMove = this.moving && !this.visible;
      this.unseenT = Math.min(this.unseenT, 0.5); // hiding on purpose is not "losing" the player
      if (!this.moving && !this.evalJob) this.coverT -= dt;
      if (this.modeT <= 0 || this.coverT <= 0) { this.mode = 'engage'; this.modeT = randR(cfg.peekTime) * (this.defensive ? 0.6 : 1); this.reposT = 0; this.unseenT = 0; this.underFire = false; }
    } else {
      this.lookMove = false;
      if (this.defensive && this.hp > cfg.retreatHp + 25) this.defensive = false;
      if (this.unseenT > cfg.loseSightTime * (1 - 0.4 * mgr.aggr)) { // lost them: go and look
        mgr.callout(this, 'lost');
        if (!cfg.ffa && (!this.inLeash(this.lastSeen) || this.special === 'marksman')) { this.releaseToken(); this.evalJob = null; this.startSearch(); return; } // passive: hold and watch
        this.releaseToken(); this.state = 'chase'; this.evalJob = null;
        TMP3.copy(this.lastSeen).addScaledVector(this.lastSeenVel, 0.4);
        const done = () => this.startSearch();
        this.moveTo(TMP3, cfg.sprintSpeed, { onArrive: done, onFail: done });
        return;
      }
      const wantCover = !cfg.noCover && ((hurt && this.modeT <= 0) || this.reloadT > 0.4 && !this.reloadCover);
      if (this.stagT > 0) { /* reeling: no decisions */ }
      else if (wantCover && !this.evalJob) {
        if (this.reloadT > 0) { this.reloadCover = true; mgr.callout(this, 'reloading'); }
        this.mode = 'cover'; this.modeT = 5.5; this.coverT = (randR(cfg.coverTime) + (this.reloadT > 0 ? this.reloadT * 0.5 : 0)) * (this.defensive ? 1.7 : 1);
        this.underFire = false;
        this.releaseToken(); this.startEval('cover');
      } else if (this.reposT <= 0 && !this.evalJob) {
        this.reposT = randR(cfg.repositionInterval) * (this.hasToken ? 1 : 1.4);
        const dT = Math.hypot(this.lastSeen.x - this.pos.x, this.lastSeen.z - this.pos.z), far = dT > this.prefRange + cfg.closeInBeyond, g = mgr.aggr;
        let kind = this.unseenT > 0.7 || far ? 'push' : 'engage'; // too far to hit much: close in
        if (this.underFire) { // being shot at in the open: break for cover, or at least sidestep
          this.underFire = false;
          if (!cfg.noCover && Math.random() < cfg.underFireCover + (1 - this.hp / this.maxHp) * 0.4) {
            kind = 'cover'; this.mode = 'cover'; this.modeT = 4; this.coverT = randR(cfg.coverTime) * 0.6; this.releaseToken(); mgr.callout(this, 'cover');
          } else if (cfg.noCover) kind = far ? 'push' : 'engage'; // shield / heavy: keeps coming
          else { kind = 'dodge'; this.reposT = rand(0.7, 1.3); }
        } else if (!hurt && !this.leashed && mgr.time > this.flankCdT && mgr.campT > cfg.campTime * (1 - 0.6 * g) && mgr.flankers() < 1 + Math.round(g * 2)) {
          // the player has settled in one spot: someone goes round the side, or straight at them
          kind = Math.random() < cfg.flankShare ? 'flank' : 'push';
          this.flankCdT = mgr.time + rand(10, 16) * (1 - 0.5 * g); this.flankUntil = mgr.time + 6; this.reposT = rand(3, 4.5);
          mgr.callout(this, kind);
        } else if (kind === 'engage' && g > 0 && !hurt && dT > cfg.minRange + 5 && Math.random() < 0.4 * g) kind = 'push'; // late raid: keep closing
        this.startEval(kind);
      }
    }
    if (this.evalJob) this.stepEval();

    // firing slot
    this.tokenCd -= dt;
    const want = this.mode !== 'cover' && this.visible && this.inRange !== false && this.reactT <= 0 && this.reloadT <= 0 && this.tokenCd <= 0;
    if (cfg.ffa || this.target !== this.ctx.player || this.special === 'marksman') { if (!cfg.ffa) this.pool.delete(this); this.hasToken = this.mode !== 'cover'; return; } // free-for-all / bot against bot / the marksman's single rounds: no shared firing slots
    if (want && !this.hasToken) { this.wantTokenT = mgr.time; if (this.pool.size < cfg.maxAttackers + (mgr.aggr >= 0.75 && this.faction === 'guard' ? 1 : 0)) { this.pool.add(this); this.hasToken = true; this.tokenT = randR(cfg.attackHoldTime); } }
    if (this.hasToken) {
      this.tokenT -= dt;
      if (this.unseenT > 0.9 || this.mode === 'cover') this.releaseToken();
      else if (this.tokenT <= 0 && this.burstLeft <= 0 && mgr.someoneWaiting(this)) { this.releaseToken(); this.tokenCd = rand(1.2, 2.2); }
    }
  }

  // ---- the rusher: no gun, no cover. run (zigzag) -> windup (the tell) -> lunge (a straight, committed line) -> recover
  thinkRush(dt) {
    const cfg = this.cfg, mgr = this.mgr, T = this.target, R = this.rush, p = this.pos;
    this.releaseToken(); this.evalJob = null; this.lookMove = false;
    this.lookPt.copy(this.lastSeen); this.lookPt.y += 1.0;
    const tp = this.visible ? T.pos : this.lastSeen, dx = tp.x - p.x, dz = tp.z - p.z, d = Math.hypot(dx, dz) || 1e-3, dy = tp.y - p.y;
    if (R.phase === 'run') {
      if ((this.unseenT > cfg.loseSightTime * 1.6 && d < 2.5) || this.unseenT > 8) { this.startSearch(); mgr.callout(this, 'lost'); return; } // reached where they were: nobody there
      if (this.stagT > 0) return;
      if (this.reactT > 0) { if (this.visible) this.reactT -= dt; return; }
      if (this.visible && d < cfg.chargeRange && Math.abs(dy) < 2.2) { // close enough: wind up (crouch, arms wide, glow) — the fair warning
        R.phase = 'windup'; R.t = cfg.chargeWindup; this.clearPath(); this.telling = true;
        this.ctx.events.emit('botTell', { bot: this, time: cfg.chargeWindup, kind: this.kind, attack: 'charge' });
        mgr.callout(this, 'push');
        return;
      }
      R.repT -= dt; R.zigT -= dt;
      if (R.zigT <= 0) { R.zig = -R.zig; R.zigT = rand(0.4, 0.8); R.repT = 0; }
      if (R.repT <= 0 || !this.moving) { // erratic approach: aim to one side of the target, then the other
        R.repT = 0.45;
        const off = d > cfg.chargeRange + 3 ? Math.min(cfg.zigzag, d * 0.25) * R.zig : 0;
        const gx = tp.x + (dz / d) * off, gz = tp.z - (dx / d) * off;
        let id = this.nav.nearestNode(gx, tp.y, gz, 2, 1.6, true); if (id < 0) id = this.nav.nearestNode(tp.x, tp.y, tp.z, 4, 2.5, true);
        if (id >= 0) this.moveTo(this.nav.nodePos(id, TMP3), cfg.sprintSpeed, { goalId: id });
      }
    } else if (R.phase === 'windup') {
      R.t -= dt; this.telling = true;
      if (R.t <= 0) {
        this.telling = false;
        const tv = T.vel || ZERO, lx = T.pos.x + tv.x * 0.12 - p.x, lz = T.pos.z + tv.z * 0.12 - p.z, l = Math.hypot(lx, lz) || 1;
        R.dx = lx / l; R.dz = lz / l; R.phase = 'lunge'; R.t = cfg.lungeTime; R.hit = false;
        const reach = cfg.lungeSpeed * cfg.lungeTime + 1.5;
        this.clearPath(); this.moveSpeed = cfg.lungeSpeed; this.goal.set(p.x + R.dx * reach, p.y, p.z + R.dz * reach); this.goalId = -1; this.stuckN = 0; this.stuckT = 0; this.stuckPos.copy(p);
        this.setPath([{ x: p.x, y: p.y, z: p.z, t: 0, pad: null }, { x: this.goal.x, y: p.y, z: this.goal.z, t: 0, pad: null }]);
        this.aimYaw = Math.atan2(R.dx, R.dz);
      }
    } else if (R.phase === 'lunge') {
      R.t -= dt;
      if (!R.hit && T.alive && Math.hypot(T.pos.x - p.x, T.pos.z - p.z) < cfg.meleeRange + (T.radius || 0.35) - 0.35 && Math.abs(T.pos.y - p.y) < 1.7) { R.hit = true; this.melee(T); }
      if (R.t <= 0 || R.hit || !this.path) { R.phase = 'recover'; R.t = cfg.meleeRecover; this.clearPath(); }
    } else { R.t -= dt; if (R.t <= 0) { R.phase = 'run'; R.repT = 0; } } // spent: stands there for a moment — the opening
  }
  melee(T) {
    const cfg = this.cfg, ev = this.ctx.events, R = this.rush;
    const dmg = cfg.meleeDamage * (T.isBot ? cfg.botVsBotDamage : 1), from = new THREE.Vector3(this.pos.x, this.pos.y + 1.1, this.pos.z);
    const point = new THREE.Vector3(T.pos.x - R.dx * 0.3, T.pos.y + tH(T) * 0.6, T.pos.z - R.dz * 0.3);
    this.stats.shots++; this.stats.hits++; this.stats.damageDealt += dmg; this.mesh.fireKick();
    if (T.vel && T.vel.isVector3) { T.vel.x += R.dx * 4; T.vel.z += R.dz * 4; }
    this.vel.x = -R.dx * 7; this.vel.z = -R.dz * 7; // it rebounds off its victim: there is daylight between them again
    T.takeDamage(dmg, { from, source: this, weapon: 'bot_shock' });
    ev.emit('impact', { point, normal: new THREE.Vector3(-R.dx, 0, -R.dz), kind: 'flesh', target: T, damage: dmg, by: this, melee: true });
    ev.emit('rusherHit', { bot: this, target: T, damage: dmg, point });
  }

  // ---- the marksman: a laser held on the target, then one round ---------------------------------------------
  cancelSnipe(reason) {
    if (!(this.aimT > 0)) return;
    this.aimT = 0; this.locked = false; this.telling = false; this.snipeCd = Math.max(this.snipeCd, reason === 'hit' ? 1.6 : 1.0);
    this.mgr.roles.laserOff(this); this.stats.snipeCancel = (this.stats.snipeCancel || 0) + 1;
    this.ctx.events.emit('marksmanAim', { bot: this, time: 0, phase: 'cancel', reason });
  }
  fireSnipe(dt) {
    const cfg = this.cfg, mgr = this.mgr, ctx = this.ctx, T = this.target, ev = ctx.events;
    if (this.reactT > 0 && this.visible) this.reactT -= dt;
    if (this.snipeCd > 0) this.snipeCd -= dt;
    const live = this.state === 'combat' && T && T.alive && this.stagT <= 0 && !this.far;
    this.inRange = !!T && this.pos.distanceTo(this.visible ? T.pos : this.lastSeen) <= cfg.engageRange;
    if (this.aimT > 0) {
      if (!live || !this.inRange) { this.cancelSnipe('lost'); return; }
      const M = TMP.set(this.pos.x, this.pos.y + EYE * (this.baseHeight / 1.8), this.pos.z), h = tH(T);
      if (!this.locked) { // the line follows the target; breaking line of sight now calls the shot off
        this.lockPt.set(T.pos.x, T.pos.y + h * 0.6, T.pos.z);
        let los = ctx.world.lineOfSight(M, this.lockPt); mgr.stats.rays++;
        if (!los) { TMP2.set(T.pos.x, T.pos.y + h - 0.12, T.pos.z); los = ctx.world.lineOfSight(M, TMP2); mgr.stats.rays++; }
        if (los) this.losLostT = 0; else if ((this.losLostT += dt) > cfg.snipeLosGrace) { this.cancelSnipe('los'); return; }
      }
      this.aimT -= dt; this.telling = true;
      if (!this.locked && this.aimT <= cfg.lockTime) { // frozen: where the target will be if it keeps going (partly led)
        this.locked = true; const tv = T.vel || ZERO, k = cfg.lockTime * cfg.snipeLead;
        this.lockPt.set(T.pos.x + tv.x * k, T.pos.y + h * 0.6, T.pos.z + tv.z * k);
        ev.emit('marksmanAim', { bot: this, time: Math.max(0, this.aimT), phase: 'lock' });
      }
      if (this.aimT > 0) { mgr.roles.laser(this, M, this.lockPt, 1 - this.aimT / cfg.aimTime, this.locked); return; }
      // the shot
      this.aimT = 0; this.locked = false; this.telling = false; this.snipeCd = randR(cfg.snipeCooldown); mgr.roles.laserOff(this);
      const origin = M.clone(), dir = this.lockPt.clone().sub(origin).normalize(), hit = ctx.hitscan(origin, dir, cfg.maxRange, this);
      this.stats.shots++; mgr.stats.shots++; this.mesh.fireKick(); this.recoil += 0.03;
      ev.emit('shot', { weapon: 'bot_marksman', origin, dir, dirs: [dir], muzzle: origin.clone().addScaledVector(dir, 1.3), by: this, end: hit ? hit.point : origin.clone().addScaledVector(dir, cfg.maxRange), heavy: true });
      if (hit && hit.type === 'target') {
        const t = hit.target, dmg = cfg.snipeDamage * (t.isBot ? 2 : 1);
        this.stats.hits++; this.stats.damageDealt += dmg; mgr.stats.hits++;
        t.takeDamage(dmg, { from: origin, source: this, weapon: 'bot_marksman' });
        ev.emit('impact', { point: hit.point, normal: hit.normal, kind: 'flesh', target: t, damage: dmg, by: this });
      } else if (hit) {
        if (ctx.destruction && ctx.destruction.hit) ctx.destruction.hit(hit.collider, hit.point, hit.normal, cfg.snipeDamage);
        ev.emit('impact', { point: hit.point, normal: hit.normal, kind: 'world', collider: hit.collider, damage: cfg.snipeDamage, by: this });
      }
      return;
    }
    if (live && this.inRange && this.visible && this.reactT <= 0 && this.snipeCd <= 0 && this.mode !== 'cover' && this.aimOff < 0.25) {
      this.aimT = cfg.aimTime; this.locked = false; this.losLostT = 0; this.telling = true; this.clearPath(); this.evalJob = null;
      this.lockPt.set(T.pos.x, T.pos.y + tH(T) * 0.6, T.pos.z);
      ev.emit('botTell', { bot: this, time: cfg.aimTime, kind: this.kind, attack: 'snipe' });
      ev.emit('marksmanAim', { bot: this, time: cfg.aimTime, phase: 'aim' });
    }
  }

  // ---- the grenadier: flush out a target that hides or stays put. Returns true while it is busy throwing. ------
  grenadeTick(dt) {
    const cfg = this.cfg, mgr = this.mgr, T = this.target;
    if (this.grenCd > 0) this.grenCd -= dt;
    if (this.grenWind > 0) {
      if (this.stagT > 0 || this.state !== 'combat') { this.grenWind = 0; this.telling = false; this.grenCd = 2; return false; }
      this.grenWind -= dt; this.burstLeft = 0; this.telling = true;
      if (this.grenWind <= 0) {
        this.telling = false; this.grenWind = 0;
        this.grenCd = mgr.roles.throwGrenade(this, this.grenAim) ? randR(cfg.grenadeCooldown) : 2;
        this.pauseT = Math.max(this.pauseT, 0.7); this.stats.grenades = (this.stats.grenades || 0) + 1;
      }
      return true;
    }
    if (this.grenCd > 0 || this.state !== 'combat' || !T || !T.alive || this.stagT > 0 || this.far || this.reactT > 0) return false;
    const src = this.visible ? T.pos : this.lastSeen, d = Math.hypot(src.x - this.pos.x, src.z - this.pos.z);
    if (d < cfg.grenadeRange[0] || d > cfg.grenadeRange[1]) return false;
    const hiding = !this.visible && this.unseenT > cfg.grenadeAfterUnseen && mgr.time - this.lastSeenTime < 6;
    const camping = this.visible && (T === this.ctx.player ? mgr.campT > cfg.grenadeCamp : Math.hypot(T.vel ? T.vel.x : 0, T.vel ? T.vel.z : 0) < 1);
    if (!hiding && !camping) return false;
    this.grenAim.set(src.x + gauss() * cfg.grenadeError, src.y + 0.1, src.z + gauss() * cfg.grenadeError);
    if (!mgr.roles.canThrow(this, this.grenAim)) { this.grenCd = 1.2; return false; }
    this.grenWind = cfg.grenadeWindup; this.telling = true; this.burstLeft = 0; this.unseenT = Math.min(this.unseenT, 1); // (it does not run off after them in the middle of the throw)
    this.ctx.events.emit('botTell', { bot: this, time: cfg.grenadeWindup, kind: this.kind, attack: 'grenade' });
    mgr.callout(this, 'grenade');
    return true;
  }

  get pool() { return this.faction === 'raider' ? this.mgr.raidAttackers : this.mgr.attackers; } // firing slots against the player, per faction
  releaseToken() { if (this.hasToken) { this.hasToken = false; this.pool.delete(this); } }

  // ---- tactical position choice (spread over a few frames) ------------------
  startEval(kind) {
    const nav = this.nav, cfg = this.cfg, p = this.pos, T = this.lastSeen;
    const dx = T.x - p.x, dz = T.z - p.z, d = Math.hypot(dx, dz), toT = Math.atan2(dx, dz);
    const job = this.evalJob = { kind, cands: [], i: 0, best: null, bs: -1e9, T: T.clone() };
    const dodge = kind === 'dodge'; if (dodge) kind = job.kind = 'engage';
    const strafe = dodge || (kind === 'engage' && Math.abs(d - this.prefRange) < 7 && d > cfg.minRange);
    if (Math.random() < 0.3) this.strafeSign = -this.strafeSign;
    const n = kind === 'cover' ? 18 : 10, back = cfg.tacticalRadius * (this.defensive ? 1.5 : 1);
    job.dodge = dodge;
    for (let k = 0; k < n; k++) {
      let ang, r, ox = p.x, oz = p.z, oy = p.y;
      if (kind === 'flank') { ang = toT + Math.PI + (k < 7 ? this.strafeSign : -this.strafeSign) * rand(1.0, 2.1); r = rand(7, 13); ox = T.x; oz = T.z; oy = T.y; } // a spot off to the target's side
      else if (kind === 'push') { ang = toT + rand(-0.9, 0.9); r = rand(4, 12); }
      else if (kind === 'cover' && this.defensive && k < 6) { ang = toT + Math.PI + rand(-1, 1); r = rand(4, back); } // wounded: fall back
      else if (kind === 'cover') { ang = rand(0, Math.PI * 2); r = rand(1.5, cfg.tacticalRadius * (k < 9 ? 1 : 1.6)); }
      else if (strafe) { ang = toT + (k < 7 ? this.strafeSign : -this.strafeSign) * rand(1.0, 2.0); r = rand(1.8, 5); }
      else { ang = toT + (d > this.prefRange ? rand(-1.2, 1.2) : Math.PI + rand(-1.2, 1.2)); r = rand(3, cfg.tacticalRadius); }
      const x = ox + Math.sin(ang) * r, z = oz + Math.cos(ang) * r;
      const id = nav.nearestNode(x, oy, z, 1, 1.6, true);
      if (id < 0) continue;
      const col = (id / nav.L) | 0; if (nav.padMask[col]) continue;
      const c = { id, x: nav.cx(col % nav.N), y: nav.ys[id], z: nav.cx((col / nav.N) | 0), stay: false };
      job.cands.push(c);
    }
    if (kind !== 'push' && kind !== 'flank' && !dodge) job.cands.push({ id: -1, x: p.x, y: p.y, z: p.z, stay: true });
  }

  stepEval() {
    const job = this.evalJob, cfg = this.cfg, world = this.ctx.world, p = this.pos, T = job.T;
    if (this.mgr.rayBudget <= 0) return; // out of rays this frame: carry on next frame
    for (let n = 0; n < 3 && job.i < job.cands.length; n++, job.i++) {
      const c = job.cands[job.i];
      if (!cfg.ffa && !c.stay && !this.inLeash(c)) continue; // passive guards do not leave their post area
      TMP.set(c.x, c.y + EYE, c.z); TMP2.set(T.x, T.y + 1.1, T.z);
      const los = world.lineOfSight(TMP, TMP2); this.mgr.stats.rays++; this.mgr.rayBudget--;
      const dT = Math.hypot(c.x - T.x, c.z - T.z), travel = Math.hypot(c.x - p.x, c.z - p.z) + Math.abs(c.y - p.y) * 2;
      let s = rand(-1, 1) + THREE.MathUtils.clamp(c.y - T.y, -3, 4) * 0.35;
      if (dT < cfg.minRange) s -= 10;
      if (job.kind === 'cover') s += (los ? -12 : 7) - travel * 0.55 - Math.abs(dT - this.prefRange) * 0.15;
      else if (job.kind === 'push') s += (los ? 7 : 0) - dT * 0.35 - travel * 0.1;
      else if (job.kind === 'flank') s += (los ? 5 : 0) - Math.abs(dT - 9) * 0.4 - travel * 0.04;
      else if (job.dodge) s += (los ? 3 : 1) - Math.abs(travel - 3.2) * 0.8;
      else s += (los ? 7 : -6) - Math.abs(dT - this.prefRange) * 0.5 - travel * 0.25;
      if (c.stay) s -= job.kind === 'cover' ? 0 : this.hurtT < 1.2 ? 4 : 1.2;
      for (const o of this.mgr.bots) {
        if (o === this || !o.alive) continue;
        if (Math.hypot(o.pos.x - c.x, o.pos.z - c.z) < 2.4 || (o.path && Math.hypot(o.goal.x - c.x, o.goal.z - c.z) < 2.4)) s -= 5;
      }
      if (s > job.bs) { job.bs = s; job.best = c; c.los = los; }
    }
    if (job.i < job.cands.length) return;
    this.evalJob = null;
    const b = job.best;
    if (job.kind === 'cover' && (!b || b.stay || b.los) && this.hurtT < 2.5 && this.reloadT <= 0) { // no cover within reach while being shot: keep moving instead
      this.mode = 'engage'; this.modeT = randR(cfg.peekTime); this.reposT = rand(0.8, 1.4); this.startEval('dodge'); return;
    }
    if (!b || b.stay) return;
    const travel = Math.hypot(b.x - p.x, b.z - p.z);
    const speed = job.kind === 'cover' || job.kind === 'flank' || job.dodge || travel > 7 ? cfg.sprintSpeed : cfg.combatSpeed;
    TMP3.set(b.x, b.y, b.z);
    this.moveTo(TMP3, speed, { goalId: b.id });
  }

  // ===========================================================================
  // aim + fire
  // ===========================================================================
  aim(dt) {
    const cfg = this.cfg, pl = this.target, p = this.pos;
    if (!pl) this.visible = false;
    let ty, tp = 0, k = 5, combat = this.state === 'combat';
    const speed = Math.hypot(this.vel.x, this.vel.z);
    let usePt = false;
    if (combat && !this.lookMove) {
      if (this.visible) TMP.set(pl.pos.x, pl.pos.y + tH(pl) * 0.66, pl.pos.z); else TMP.copy(this.lookPt);
      usePt = true; k = cfg.aimSpeed;
    } else if (!this.lookMove && (this.state === 'investigate' || this.state === 'chase')) { TMP.copy(this.lookPt); usePt = true; k = 7; }
    if (usePt) {
      const dx = TMP.x - p.x, dz = TMP.z - p.z, dy = TMP.y - (p.y + EYE), dh = Math.hypot(dx, dz);
      ty = Math.atan2(dx, dz); tp = Math.atan2(dy, Math.max(dh, 0.3));
      if (combat) {
        // wandering aim error: bigger just after acquiring, on fast-crossing targets, while moving, after being hit
        this.errT -= dt;
        if (this.errT <= 0) {
          this.errT = rand(0.16, 0.36);
          let ang = 0;
          if (this.visible && pl.vel) { const rvx = pl.vel.x - this.vel.x, rvz = pl.vel.z - this.vel.z; ang = Math.abs(rvx * dz - rvz * dx) / Math.max(dh * dh, 4); }
          const sig = cfg.aimErrorBase + cfg.aimErrorFirst * Math.exp(-this.settle / cfg.aimSettleTime) + cfg.aimErrorTargetSpeed * Math.min(ang, 1.5) + cfg.aimErrorSelfMove * speed + this.flinchErr;
          this.errTY = gauss() * sig; this.errTP = gauss() * sig * 0.6;
        }
        this.errYaw = damp(this.errYaw, this.errTY, 6, dt); this.errPitch = damp(this.errPitch, this.errTP, 6, dt);
        ty += this.errYaw; tp += this.errPitch;
      }
    } else if (speed > 0.6) { ty = Math.atan2(this.vel.x, this.vel.z); k = 6; this.scanBase = ty; }
    else if (this.faceBot && this.faceBot.alive) { ty = Math.atan2(this.faceBot.pos.x - p.x, this.faceBot.pos.z - p.z) + Math.sin(this.t * 0.9 + this.scanPhase) * 0.12; k = 3; tp = Math.sin(this.t * 1.3 + this.scanPhase) * 0.05; } // talking to a squadmate
    else { ty = this.scanBase + Math.sin(this.t * 0.75 + this.scanPhase) * this.scanAmp; k = 2.2; tp = Math.sin(this.t * 0.4 + this.scanPhase) * 0.08; }
    this.flinchErr = damp(this.flinchErr, 0, 2.5, dt);
    this.recoil = damp(this.recoil, 0, 9, dt);

    const dyaw = wrap(ty - this.aimYaw), dpitch = tp - this.aimPitch, a = 1 - Math.exp(-k * dt), cap = cfg.aimMaxTurn * dt;
    this.aimYaw = wrap(this.aimYaw + THREE.MathUtils.clamp(dyaw * a, -cap, cap));
    this.aimPitch = THREE.MathUtils.clamp(this.aimPitch + THREE.MathUtils.clamp(dpitch * a, -cap, cap), -1.3, 1.3);
    this.aimOff = Math.abs(dyaw) + Math.abs(dpitch);
    this.bodyYaw = wrap(this.bodyYaw + wrap(this.aimYaw - this.bodyYaw) * (1 - Math.exp(-(combat ? 9 : 7) * dt)));
    const cp = Math.cos(this.aimPitch + this.recoil);
    this.aimDir.set(Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch + this.recoil), Math.cos(this.aimYaw) * cp);
    // in a fight the carbine sits at low ready and only comes up to the shoulder for the tell and the burst
    this.aimingPose = combat ? (this.lookMove ? 0.25 : this.telling || this.burstLeft > 0 || this.aimT > 0 ? 1 : this.special === 'shield' ? 0.3 : cfg.lowReady) : this.state === 'patrol' ? 0 : this.special === 'shield' ? 0.2 : 0.55;
  }

  fire(dt) {
    const cfg = this.cfg, sp = this.special;
    if (sp === 'rusher') { this.burstLeft = 0; return; }
    if (sp === 'marksman') { this.fireSnipe(dt); return; }
    if (sp === 'grenadier' && this.grenadeTick(dt)) return;
    if (this.reloadT > 0) { this.reloadT -= dt; if (this.reloadT <= 0) { this.mag = cfg.magSize; this.reloadCover = false; } }
    if (this.reactT > 0 && this.visible) this.reactT -= dt;
    const tp = this.visible && this.target ? this.target.pos : this.lastSeen;
    this.inRange = cfg.ffa || this.pos.distanceTo(tp) <= cfg.engageRange; // never open fire across the map
    const can = this.state === 'combat' && this.stagT <= 0 && this.hasToken && this.inRange && this.reactT <= 0 && this.reloadT <= 0 && (this.visible || (this.unseenT < 0.35 && this.burstLeft > 0));
    if (!can) { this.burstLeft = 0; this.shotT = 0; this.telling = false; if (this.pauseT > 0) this.pauseT -= dt; return; }
    if (this.burstLeft <= 0) {
      // the tell: the last cfg.tellTime before every burst the weapon comes up and the visor flares
      if (!this.telling) {
        if (this.pauseT > cfg.tellTime) { this.pauseT -= dt; return; }
        this.telling = true; this.tellT = cfg.tellTime;
        this.ctx.events.emit('botTell', { bot: this, time: cfg.tellTime, kind: this.kind, attack: sp === 'suppressor' ? 'spool' : 'burst' });
      }
      this.pauseT -= dt; this.tellT -= dt;
      if (this.tellT > 0 || this.pauseT > 0) return;
      this.telling = false; this.burstLeft = randI(cfg.burst); this.shotT = 0;
    } else if (this.pauseT > 0) { this.pauseT -= dt; return; }
    this.shotT -= dt;
    if (this.shotT > 0 || (this.aimOff > 0.1 && sp !== 'suppressor')) return; // (the machine gun keeps firing down its lane while it swings round)
    this.shotT = Math.max(this.shotT, -0.02) + 1 / cfg.fireRate;
    if (!this.shoot()) { this.burstLeft = 0; this.pauseT = 0.35; this.reposT = 0; return; }
    this.burstLeft--; this.mag--;
    if (this.burstLeft <= 0 || this.mag <= 0) this.firstBurst = false;
    if (this.mag <= 0) { this.reloadT = cfg.reloadTime; this.burstLeft = 0; }
    else if (this.burstLeft <= 0) this.pauseT = randR(cfg.burstPause);
  }

  // probability that a round lands on the (visible) player: range curve x situational modifiers
  hitChance(dist, lateralSpeed) {
    const cfg = this.cfg, c = cfg.accuracyByRange, m = cfg.accuracyMods, pl = this.target;
    let p = c[c.length - 1][1];
    if (dist <= c[0][0]) p = c[0][1];
    else for (let i = 1; i < c.length; i++) if (dist <= c[i][0]) { const a = c[i - 1], b = c[i]; p = a[1] + (b[1] - a[1]) * (dist - a[0]) / (b[0] - a[0]); break; }
    const v = lateralSpeed;
    if (v > 0.5) p *= v <= cfg.walkSpeed ? 1 + (m.targetWalk - 1) * v / cfg.walkSpeed : m.targetWalk + (m.targetSprint - m.targetWalk) * Math.min(1, (v - cfg.walkSpeed) / Math.max(0.1, cfg.sprintSpeed - cfg.walkSpeed));
    if (tAir(pl)) p *= m.targetAirborne;
    if (Math.hypot(this.vel.x, this.vel.z) > 1) p *= m.selfMoving;
    if (this.firstBurst) p *= m.firstBurst;
    if (this.hurtT < cfg.recentlyHitTime) p *= m.recentlyHit;
    if (this.suppression > 0.5) p *= m.suppressed ?? 1;
    return (this._hc = p);
  }

  shoot() {
    const cfg = this.cfg, ctx = this.ctx, ev = ctx.events;
    const origin = new THREE.Vector3(this.pos.x, this.pos.y + EYE, this.pos.z);
    let dir;
    const pl = this.target;
    if (this.far && this.visible && pl && pl.isBot && pl.far && pl.alive) {
      // Both sides are far from the player: the round is resolved by dice — no ray, no impact effects. One round in four
      // still emits `shot` (flagged far) so that the distant firefight can be heard and its tracers seen.
      const dh = Math.hypot(pl.pos.x - origin.x, pl.pos.z - origin.z) || 1e-3, tv = pl.vel || ZERO;
      this.stats.shots++; this.mgr.stats.shots++; this.recoil += cfg.recoilPerShot;
      const hitRoll = Math.random() < this.hitChance(dh, Math.hypot(tv.x, tv.z) * 0.6);
      if (this.simN++ % 4 === 0) {
        const end = new THREE.Vector3(pl.pos.x, pl.pos.y + 1.1, pl.pos.z);
        if (!hitRoll) { end.x += gauss() * 1.5; end.y += Math.random() * 1.5; end.z += gauss() * 1.5; }
        dir = end.clone().sub(origin).normalize();
        ev.emit('shot', { weapon: 'bot_rifle', origin, dir, dirs: [dir], muzzle: origin.clone().addScaledVector(dir, 0.9), by: this, end, far: true });
      }
      if (hitRoll) { const dmg = cfg.damage * cfg.botVsBotDamage; this.stats.hits++; this.stats.damageDealt += dmg; this.mgr.stats.hits++; pl.takeDamage(dmg, { from: origin, source: this }); }
      return true;
    }
    if (this.visible && pl && pl.alive && this.special !== 'suppressor') {
      // explicit model: decide hit / miss first, then aim the round accordingly
      const dx = pl.pos.x - origin.x, dz = pl.pos.z - origin.z, dh = Math.hypot(dx, dz) || 1e-3, px = dz / dh, pz = -dx / dh; // (px, pz): sideways
      const tv = pl.vel || ZERO, lat = tv.x * px + tv.z * pz, h = tH(pl);
      const hitRoll = Math.random() < this.hitChance(dh, Math.abs(lat));
      this.lastHitChance = this._hc;
      const tgt = TMP.set(pl.pos.x, pl.pos.y, pl.pos.z);
      if (hitRoll) { const j = (Math.random() - 0.5) * 0.3; tgt.x += px * j; tgt.z += pz * j; tgt.y += h * rand(0.3, 0.86); }
      else {
        // a deliberate near miss: wide on one side (trailing a moving target, otherwise the side this burst is walking in from) or high
        if (Math.abs(lat) > 1.5) this.missSide = Math.random() < 0.8 ? -Math.sign(lat) : Math.sign(lat);
        else if (!this.missSide || Math.random() < 0.2) this.missSide = Math.random() < 0.5 ? 1 : -1;
        const scale = (1 + dh * cfg.missOffsetPerMeter) * (this.firstBurst ? 1 + 0.25 * Math.max(0, this.burstLeft - 1) : 1);
        if (Math.random() < cfg.missOverHead) { const j = (Math.random() - 0.5) * 0.5; tgt.x += px * j; tgt.z += pz * j; tgt.y += h + rand(0.2, 0.6) * scale; }
        else { const off = (pl.radius || 0.35) + 0.25 + randR(cfg.missOffset) * scale; tgt.x += px * off * this.missSide; tgt.z += pz * off * this.missSide; tgt.y += h * rand(0.15, 0.95); }
      }
      dir = tgt.sub(origin).normalize().clone();
    } else {
      // blind fire at the last known position — and every round of the heavy's machine gun: a cone around the simulated
      // aim direction, so its fire is a lane that can be stepped out of
      dir = this.aimDir.clone();
      const r = cfg.spread * Math.sqrt(Math.random()), th = Math.random() * Math.PI * 2;
      TMP.set(Math.cos(this.aimYaw), 0, -Math.sin(this.aimYaw));            // right-ish
      TMP2.crossVectors(dir, TMP).normalize();                               // up-ish
      dir.addScaledVector(TMP, Math.cos(th) * r).addScaledVector(TMP2, Math.sin(th) * r).normalize();
    }
    const hit = ctx.hitscan(origin, dir, cfg.maxRange, this);
    if (!cfg.ffa && hit && hit.type === 'target' && hit.target !== pl && hit.target.team === this.team && (hit.target.faction || 'guard') === this.faction) return this.special === 'suppressor'; // an ally is in the line of fire: hold (the machine gun only skips the round: its burst, once spooled, goes on)
    // muzzle of the carbine (for tracers / flashes drawn by the fx system)
    const sy = Math.sin(this.aimYaw), cy = Math.cos(this.aimYaw);
    const muzzle = new THREE.Vector3(this.pos.x - cy * 0.1, this.pos.y + 1.43, this.pos.z + sy * 0.1).addScaledVector(this.aimDir, 0.9);
    this.stats.shots++; this.mgr.stats.shots++;
    this.recoil += cfg.recoilPerShot; this.mesh.fireKick();
    ev.emit('shot', { weapon: this.special === 'suppressor' ? 'bot_lmg' : this.special === 'shield' ? 'bot_pistol' : 'bot_rifle', origin, dir, dirs: [dir], muzzle, by: this, end: hit ? hit.point : origin.clone().addScaledVector(dir, cfg.maxRange) });
    if (!hit) return true;
    if (hit.type === 'target') {
      const t = hit.target, dmg = cfg.damage * (hit.headshot ? cfg.headshotMult : 1) * (t.isBot ? cfg.botVsBotDamage : 1);
      this.stats.hits++; this.stats.damageDealt += dmg; this.mgr.stats.hits++;
      t.takeDamage(dmg, { from: origin, source: this, headshot: !!hit.headshot });
      ev.emit('impact', { point: hit.point, normal: hit.normal, kind: 'flesh', target: t, damage: dmg, by: this });
    } else {
      if (ctx.destruction && ctx.destruction.hit) ctx.destruction.hit(hit.collider, hit.point, hit.normal, cfg.damage);
      ev.emit('impact', { point: hit.point, normal: hit.normal, kind: 'world', collider: hit.collider, damage: cfg.damage, by: this });
    }
    return true;
  }

  // ===========================================================================
  update(dt) {
    const cfg = this.cfg, a = this.animState;
    if (!this.alive) {
      if (this.pendingSpawn) return;
      this.deadT += dt;
      const bodyT = this.faction === 'raider' ? cfg.raiders.bodyTime : cfg.respawnDelay;
      if (this.deadT < bodyT + 1) {
        stepBody(this.body, this.ctx.world, dt, 0, 0, 0, 0, false);
        a.grounded = this.body.grounded; a.floorY = this.body.grounded ? this.pos.y : this.pos.y - 3; a.showBar = false;
        a.fadeStart = Math.max(1.4, bodyT - 1.7); a.fadeTime = 1.2;
        this.mesh.update(dt, a);
      }
      return;
    }
    this.t += dt; this.hurtT += dt;
    if (this.stagT > 0) this.stagT -= dt; if (this.stagImmT > 0) this.stagImmT -= dt; if (this.staggerT > 0) this.staggerT -= dt;
    if (this.slowT > 0) this.slowT -= dt; if (this.duckT > 0) this.duckT -= dt; if (this.supCd > 0) this.supCd -= dt;
    if (this.suppression > 0) this.suppression = Math.max(0, this.suppression - cfg.suppressDecay * dt);
    if (this.burstDmg > 0) this.burstDmg = Math.max(0, this.burstDmg - (8 + this.burstDmg * 0.9) * dt);
    if (this.hurtT > cfg.regenDelay && this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + cfg.regenRate * dt);
    if (this.visible) { if (this.unseenT > 1.5) this.firstBurst = true; this.seenT += dt; this.unseenT = 0; this.settle += dt; } else { this.seenT = 0; this.unseenT += dt; this.settle = Math.max(0, this.settle - dt * 0.6); }

    if (this.special === 'shield') { // up whenever it is on guard, except while firing (and a moment after) or reeling
      if (this.shieldDownT > 0) this.shieldDownT -= dt;
      if (this.telling || this.burstLeft > 0) this.shieldDownT = Math.max(this.shieldDownT, cfg.shieldDropAfter);
      this.shieldUp = this.shieldDownT <= 0 && this.stagT <= 0 && this.state !== 'patrol';
    }
    if (this.dummy) {
      const D = this.dummy, P = this.ctx.player.pos;
      this.pos.set(D.x, D.y, D.z); this.vel.set(0, 0, 0); this.body.grounded = true; this.state = 'patrol'; this.target = null; this.telling = false; this.burstLeft = 0; this.alertState = 'alert';
      this.bodyYaw = this.aimYaw = Math.atan2(P.x - D.x, P.z - D.z); this.aimPitch = 0; this.aimingPose = 0;
      if (this.special === 'shield') this.shieldUp = this.shieldDownT <= 0 && this.stagT <= 0;
    } else if (this.errand) { // sent to a spot (the deposit thief): runs straight there, ignoring the fight, and stands on it
      const E = this.errand, far = Math.hypot(this.pos.x - E.x, this.pos.z - E.z) > 2.2;
      this.state = 'patrol'; this.target = null; this.telling = false; this.burstLeft = 0; this.lookMove = true; this.alertState = 'alert';
      E.t = (E.t || 0) - dt;
      if (!far) { if (this.path || this.pathReq) this.clearPath(); }
      else if (E.t <= 0 || (!this.path && !this.pathReq)) { E.t = 2.5; this.moveTo(TMP3.set(E.x, E.y || 0, E.z), cfg.sprintSpeed, {}); }
      this.aim(dt); this.move(dt);
      if (!this.alive) return;
    } else {
    const T0 = this.target;
    if (T0 && T0.isBot && (!T0.alive || T0.faction === this.faction)) this.loseTarget(true); // the bot I was fighting is down / gone
    this.percT -= dt;
    if (this.percT <= 0) {
      const iv = this.far ? cfg.perceptionInterval * 3 : cfg.perceptionInterval; // far from the player: senses tick slower
      if (this.mgr.rayBudget <= 0 && (this.percDefer = (this.percDefer || 0) + 1) <= 2) this.percT = 0; // ray budget spent: wait a frame (2 at most)
      else { this.percDefer = 0; this.percT += iv; if (this.percT < 0) this.percT = iv; this.perceive(); }
    }
    this.think(dt);
    if (!cfg.ffa) { // HUD-facing detection state + one event per upward transition
      // (about the PLAYER only: a guard fighting raiders, or going to look at their gunfire, stays 'unaware' of the player)
      const st = (this.state === 'combat' || this.state === 'chase') && this.target === this.ctx.player ? 'alert' : this.awareness >= cfg.suspiciousAt || ((this.state === 'investigate' || this.state === 'search') && this.concernPl) ? 'suspicious' : 'unaware';
      if (st !== this.alertState) {
        const up = st === 'alert' || (st === 'suspicious' && this.alertState === 'unaware'), name = (this.faction === 'raider' ? 'raider' : 'guard') + (st === 'alert' ? 'Alert' : 'Suspicious');
        if (up && this.mgr.time - this.evT[name] > cfg.alertEventInterval) { this.evT[name] = this.mgr.time; this.ctx.events.emit(name, { bot: this }); }
        this.alertState = st;
      }
      this.lastSeenPlayerT = this.mgr.time - this.sightT;
    }
    this.aim(dt);
    this.move(dt);
    if (!this.alive) return;
    this.fire(dt);
    }

    a.bodyYaw = this.bodyYaw; a.aimYaw = this.aimYaw; a.aimPitch = this.aimPitch + this.recoil; a.grounded = this.body.grounded || this.body.coyote > 0;
    a.aiming = this.aimingPose; a.hp01 = this.hp / this.maxHp; a.showBar = this.hurtT < 3.5 && this.hp < this.maxHp;
    a.stag = this.stagT > 0 ? this.stagAmt * Math.min(1, this.stagT / (this.stagDur * 0.45)) : 0; a.stagX = this.stagX;
    // ducked: suppressed, or sitting out a reload / a breather behind cover
    a.crouch = this.duckT > 0 ? 1 : this.state === 'combat' && this.mode === 'cover' && !this.moving && !this.evalJob && !this.visible ? 0.75 : this.state === 'patrol' && this.lootUntil > this.mgr.time && !this.moving ? 0.85 : 0;
    a.tell = this.telling ? 1 : 0; a.limp = this.slowT > 0 ? 1 : 0;
    const sp = this.special;
    a.shield = this.shieldUp ? 1 : 0; a.spin = sp === 'suppressor' && (this.telling || this.burstLeft > 0) ? 1 : 0; a.throw = this.grenWind > 0 ? 1 : 0; a.claw = 0;
    if (sp === 'rusher') { const ph = this.rush.phase, cb = this.state === 'combat'; a.claw = cb && ph === 'lunge' ? 1 : 0; if (cb && ph === 'windup') a.crouch = 0.9; else if (cb && ph === 'recover') { a.crouch = 0.45; a.stag = Math.max(a.stag, 0.5); } }
    else if (sp === 'shield' && this.shieldUp) a.crouch = Math.max(a.crouch, 0.22); // hunkered behind it
    this.mesh.update(dt, a);
    this.height = this.baseHeight * (1 - 0.2 * this.mesh.crouch); // the hit box ducks with the body
  }
}
