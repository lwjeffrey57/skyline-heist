import * as THREE from 'three';
import { BotBody } from './body.js';
import { makeBody, stepBody, JUMP } from './physics.js';
import { PAD_TRIGGER_R } from './nav.js';
import { rand, randR, randI } from './config.js';

// One enemy bot: body physics, path following, senses, state machine, aim and fire.
// It is also the `target` object pushed into ctx.targets (team, alive, pos, radius, height, takeDamage).

const EYE = 1.62;
const TMP = new THREE.Vector3(), TMP2 = new THREE.Vector3(), TMP3 = new THREE.Vector3();
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
let NEXT_ID = 1;
const CALLSIGNS = ['Vex', 'Orrin', 'Kade', 'Juno', 'Brask', 'Sable', 'Tiber', 'Nyx', 'Rook', 'Quill', 'Marlo', 'Dax', 'Fenn', 'Ibis', 'Corvo', 'Lumen', 'Pike', 'Wren', 'Zell', 'Garr', 'Mosk', 'Tamsin', 'Udo', 'Yara'];
const tH = (t) => t.h ?? t.height ?? 1.8;
const tAir = (t) => t.grounded === false || (t.body && !t.body.grounded) || !!t.sliding || t.state === 'zip';
const ZERO = new THREE.Vector3();

export class Bot {
  // Give this guard an enemy type: its own view of the config (overrides on top of the shared one), size and colour.
  setKind(name) {
    const base = this.mgr.cfg, K = (base.kinds && base.kinds[name]) || { set: {}, mul: {}, scale: 1, color: base.accentColor };
    const c = Object.create(base);
    for (const k in K.set) c[k] = K.set[k];
    for (const k in K.mul) Object.defineProperty(c, k, { get: () => base[k] * K.mul[k], enumerable: true });
    this.cfg = c; this.kind = name; this.kindLabel = K.label || 'Guard';
    this.height = 1.8 * (K.scale || 1);
    this.mesh.root.scale.setScalar(K.scale || 1); this.mesh.mats.accent.emissive.setHex(K.color ?? base.accentColor);
  }

  constructor(mgr) {
    this.mgr = mgr; this.ctx = mgr.ctx; this.cfg = mgr.cfg; this.nav = mgr.nav;
    this.id = NEXT_ID++;
    const used = new Set(mgr.bots.map((b) => b.name));
    this.name = CALLSIGNS.find((n) => !used.has(n)) || `Warden-${this.id}`; // stable callsign, kept across respawns
    this.mem = new Map(); this.target = null; this.lastAttacker = null; this.lastAttackT = -99; this.scanI = 0;
    // ---- target contract ----
    this.team = 'enemy'; this.alive = false; this.isBot = true;
    this.pos = new THREE.Vector3(0, -100, 0); this.vel = new THREE.Vector3();
    this.radius = 0.35; this.height = 1.8; this.hp = 0; this.maxHp = this.cfg.hp;
    this.takeDamage = this.takeDamage.bind(this);

    this.body = makeBody(this.pos, this.vel);
    this.mesh = new BotBody(this.ctx.scene, this.cfg.accentColor); this.mesh.hide();
    this.kind = 'grunt'; this.kindLabel = 'Guard';
    this.state = 'dead'; this.deadT = 0; this.pendingSpawn = true;
    this.goal = new THREE.Vector3(); this.lastSeen = new THREE.Vector3(); this.lastSeenVel = new THREE.Vector3(); this.alertPos = new THREE.Vector3();
    this.lookPt = new THREE.Vector3(); this.stuckPos = new THREE.Vector3();
    this.aimDir = new THREE.Vector3(0, 0, 1);
    this.animState = { pos: this.pos, vel: this.vel, bodyYaw: 0, aimYaw: 0, aimPitch: 0, grounded: true, aiming: 0, hp01: 1, showBar: false, camera: this.ctx.camera, floorY: 0, fadeStart: 2, fadeTime: 1.2 };
    this.percT = Math.random() * this.cfg.perceptionInterval;
    // guard detection (team mode): role, awareness of the player, alert state — read by the HUD
    this.role = 'active'; this.post = new THREE.Vector3(); this.awareness = 0; this.alertState = 'unaware'; this.lastSeenPlayerT = Infinity;
    this.stim = new THREE.Vector3(); this.sightT = -1e9; this.susActed = false; this.evT = { guardSuspicious: -99, guardAlert: -99 }; this.hearLos = true; this.hearLosT = -99;
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
    this.mesh.reset();
    this.ctx.events.emit('botSpawned', { bot: this, point: this.pos.clone() });
  }

  takeDamage(amount, info = {}) {
    if (!this.alive || !(amount > 0)) return;
    const cfg = this.cfg;
    this.hp -= amount; this.hurtT = 0;
    const from = info.from || (info.source && info.source.pos) || null;
    let lx = 0, lz = -1;
    if (from) { // push direction (away from the shooter) in the bot's local frame
      const dx = this.pos.x - from.x, dz = this.pos.z - from.z, l = Math.hypot(dx, dz) || 1, s = Math.sin(this.bodyYaw), c = Math.cos(this.bodyYaw);
      lx = (dx * c - dz * s) / l; lz = (dx * s + dz * c) / l;
    }
    this.mesh.flinch(lx, lz, Math.min(1.6, 0.5 + amount / 30));
    this.flinchErr = Math.min(0.12, this.flinchErr + cfg.aimErrorFlinch * Math.min(1.5, amount / 20));
    this.errT = 0;
    this.ctx.events.emit('botDamaged', { bot: this, amount, hp: this.hp, from, headshot: !!info.headshot });
    if (this.hp <= 0) { this.die(info, lx, lz); return; }
    const atk = info.source;
    if (atk && atk !== this && atk.pos && atk.alive !== false) { // being hit reveals the attacker, even from behind
      this.lastAttacker = atk; this.lastAttackT = this.mgr.time;
      const m = this.memOf(atk); m.revealT = this.mgr.time + 2.5; m.aware = 1;
      this.percT = Math.min(this.percT, 0.03);
    }
    if (!cfg.ffa && atk && atk.team === 'player' && atk.alive !== false) { // engaged by the player: instantly alert on the shooter's position
      this.awareness = 1; this.stim.copy(atk.pos);
      if (this.state !== 'combat') { this.target = atk; this.lastSeen.copy(atk.pos); this.lastSeenVel.set(0, 0, 0); this.lastSeenTime = this.mgr.time; this.enterCombat(); this.reactT = Math.min(this.reactT, 0.35); }
      else if (!this.visible) this.lastSeen.copy(atk.pos);
      return;
    }
    if (this.state !== 'combat') {
      const src = (info.source && info.source.pos) || from;
      if (src) { this.lastSeen.copy(src); this.lastSeenTime = this.mgr.time; this.alert(src, 0.15, true); this.awareness = Math.max(this.awareness, 0.85); }
    }
  }

  die(info = {}, lx = 0, lz = -1) {
    this.alive = false; this.state = 'dead'; this.deadT = 0; this.hp = 0; this.stats.deaths++;
    this.releaseToken(); this.clearPath(); this.evalJob = null; this.visible = false; this.target = null;
    if (this.poi && this.poi.claimedBy === this) this.poi.claimedBy = null;
    this.mesh.die(lx, lz, this.vel);
    const by = info.source || info.by || null;
    this.ctx.events.emit('botDied', { bot: this, point: new THREE.Vector3(this.pos.x, this.pos.y + 1, this.pos.z), by, headshot: !!info.headshot });
  }

  dispose() { this.alive = false; this.releaseToken(); this.clearPath(); this.mesh.dispose(); }

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
    if (this.sepX || this.sepZ) { // nudge away from allies / the player
      this.vel.x += this.sepX * 7 * dt; this.vel.z += this.sepZ * 7 * dt; this.sepX = 0; this.sepZ = 0;
    }
    const pad = stepBody(b, this.ctx.world, dt, wx, wz, sp, 55, true, PAD_TRIGGER_R);
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
  get leashed() { return this.role === 'passive'; }
  inLeash(p) { return !this.leashed || Math.hypot(p.x - this.post.x, p.z - this.post.z) <= this.cfg.passiveLeash; }

  perceiveTeam() {
    const cfg = this.cfg, mgr = this.mgr, world = this.ctx.world, iv = cfg.perceptionInterval, now = mgr.time, pl = this.ctx.player;
    const combat = this.state === 'combat';
    let sight = false, d = 1e9;
    if (pl.alive) {
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
    if (!sight && !combat) this.awareness = Math.max(0, this.awareness - iv / cfg.forgetTime);
    if (this.awareness < cfg.suspiciousAt * 0.6) this.susActed = false;
    this.visible = sight && this.awareness >= 1;
    if (this.visible) {
      this.target = pl; this.lastSeen.copy(pl.pos); this.lastSeenVel.copy(pl.vel); this.lastSeenTime = now;
      if (!combat) this.enterCombat();
    } else if (sight && !combat && this.awareness >= cfg.suspiciousAt && !this.susActed && (this.state === 'patrol' || this.state === 'search')) {
      this.react(pl.pos, 'peek'); // glimpsed something: stop, turn, take a few steps to look
    }
  }

  // A stimulus (noise, call-out) at `p`: raise awareness and decide how to respond. kind: 'shot' | 'noise'
  hear(p, add, kind = 'noise', floor = 0) {
    if (!this.alive) return;
    const cfg = this.cfg;
    if (this.state === 'combat') { if (!this.visible && kind === 'shot') this.lastSeen.copy(p); return; }
    this.awareness = Math.min(0.95, Math.max(this.awareness + add, floor)); // noise alone never makes a guard fully alert
    this.stim.copy(p);
    if (this.awareness < cfg.suspiciousAt) return;
    if (kind === 'shot') this.react(p, this.inLeash(p) ? 'go' : 'watch');
    else if (!this.susActed) this.react(p, this.inLeash(p) ? 'peek' : 'watch');
  }

  // respond to a stimulus: 'go' = investigate the spot, 'peek' = a few steps toward it, 'watch' = turn and hold
  react(p, mode) {
    const cfg = this.cfg, d = this.pos.distanceTo(p);
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
    this.reactT = fresh ? randR(cfg.reactionTime) + cfg.reactionPerMeter * Math.hypot(this.lastSeen.x - this.pos.x, this.lastSeen.z - this.pos.z) : randR(cfg.reacquireTime);
    this.firstBurst = true;
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
        if (this.waitT <= 0) { if (!cfg.ffa && this.role === 'passive') this.pickPostGoal(); else this.pickPatrolGoal(); }
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
          this.moveTo(this.alertPos, cfg.ffa ? cfg.sprintSpeed * 0.9 : cfg.walkSpeed, { onArrive: done, onFail: done });
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
        if (this.searchT <= 0) { this.target = null; this.state = 'patrol'; this.waitT = 0.5; if (cfg.ffa) this.awareness = 0; this.clearPath(); break; } // team mode: awareness decays over forgetTime
        this.lookMove = this.moving;
        if (this.moving) break;
        this.waitT -= dt;
        if (this.waitT <= 0) {
          const s = this.lastSeen, r = 13;
          if (!cfg.ffa && !this.inLeash(s)) { this.waitT = 1; break; } // passive guard too far from its post: stand and scan
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

  startSearch() {
    this.state = 'search'; this.searchT = this.cfg.searchTime; this.waitT = rand(0.6, 1.4); this.scanBase = this.aimYaw; this.clearPath();
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
    this.modeT -= dt; this.reposT -= dt;
    this.lookPt.copy(this.lastSeen); this.lookPt.y += 1.15;
    const hurt = this.hp < cfg.retreatHp;

    if (this.mode === 'cover') {
      this.lookMove = this.moving && !this.visible;
      this.unseenT = Math.min(this.unseenT, 0.5); // hiding on purpose is not "losing" the player
      if (!this.moving && !this.evalJob) this.coverT -= dt;
      if (this.modeT <= 0 || this.coverT <= 0) { this.mode = 'engage'; this.modeT = randR(cfg.peekTime); this.reposT = 0; this.unseenT = 0; }
    } else {
      this.lookMove = false;
      if (this.unseenT > cfg.loseSightTime) { // lost them: go and look
        if (!cfg.ffa && !this.inLeash(this.lastSeen)) { this.releaseToken(); this.evalJob = null; this.startSearch(); return; } // passive: hold and watch
        this.releaseToken(); this.state = 'chase'; this.evalJob = null;
        TMP3.copy(this.lastSeen).addScaledVector(this.lastSeenVel, 0.4);
        const done = () => this.startSearch();
        this.moveTo(TMP3, cfg.sprintSpeed, { onArrive: done, onFail: done });
        return;
      }
      const wantCover = (hurt && this.modeT <= 0) || this.reloadT > 0.4 && !this.reloadCover;
      if (wantCover && !this.evalJob) {
        if (this.reloadT > 0) this.reloadCover = true;
        this.mode = 'cover'; this.modeT = 5.5; this.coverT = randR(cfg.coverTime) + (this.reloadT > 0 ? this.reloadT * 0.5 : 0);
        this.releaseToken(); this.startEval('cover');
      } else if (this.reposT <= 0 && !this.evalJob) {
        this.reposT = randR(cfg.repositionInterval) * (this.hasToken ? 1 : 1.4);
        const far = Math.hypot(this.lastSeen.x - this.pos.x, this.lastSeen.z - this.pos.z) > this.prefRange + cfg.closeInBeyond;
        this.startEval(this.unseenT > 0.7 || far ? 'push' : 'engage'); // too far to hit much: close in
      }
    }
    if (this.evalJob) this.stepEval();

    // firing slot
    this.tokenCd -= dt;
    const want = this.mode !== 'cover' && this.visible && this.inRange !== false && this.reactT <= 0 && this.reloadT <= 0 && this.tokenCd <= 0;
    if (cfg.ffa) { this.hasToken = this.mode !== 'cover'; return; } // free-for-all: no shared firing slots
    if (want && !this.hasToken) { this.wantTokenT = mgr.time; if (mgr.attackers.size < cfg.maxAttackers) { mgr.attackers.add(this); this.hasToken = true; this.tokenT = randR(cfg.attackHoldTime); } }
    if (this.hasToken) {
      this.tokenT -= dt;
      if (this.unseenT > 0.9 || this.mode === 'cover') this.releaseToken();
      else if (this.tokenT <= 0 && this.burstLeft <= 0 && mgr.someoneWaiting(this)) { this.releaseToken(); this.tokenCd = rand(1.2, 2.2); }
    }
  }

  releaseToken() { if (this.hasToken) { this.hasToken = false; this.mgr.attackers.delete(this); } }

  // ---- tactical position choice (spread over a few frames) ------------------
  startEval(kind) {
    const nav = this.nav, cfg = this.cfg, p = this.pos, T = this.lastSeen;
    const dx = T.x - p.x, dz = T.z - p.z, d = Math.hypot(dx, dz), toT = Math.atan2(dx, dz);
    const job = this.evalJob = { kind, cands: [], i: 0, best: null, bs: -1e9, T: T.clone() };
    const strafe = kind === 'engage' && Math.abs(d - this.prefRange) < 7 && d > cfg.minRange;
    if (Math.random() < 0.3) this.strafeSign = -this.strafeSign;
    const n = kind === 'cover' ? 18 : 10;
    for (let k = 0; k < n; k++) {
      let ang, r;
      if (kind === 'push') { ang = toT + rand(-0.9, 0.9); r = rand(4, 12); }
      else if (kind === 'cover') { ang = rand(0, Math.PI * 2); r = rand(1.5, cfg.tacticalRadius * (k < 9 ? 1 : 1.6)); }
      else if (strafe) { ang = toT + (k < 7 ? this.strafeSign : -this.strafeSign) * rand(1.0, 2.0); r = rand(1.8, 5); }
      else { ang = toT + (d > this.prefRange ? rand(-1.2, 1.2) : Math.PI + rand(-1.2, 1.2)); r = rand(3, cfg.tacticalRadius); }
      const x = p.x + Math.sin(ang) * r, z = p.z + Math.cos(ang) * r;
      const id = nav.nearestNode(x, p.y, z, 1, 1.6, true);
      if (id < 0) continue;
      const col = (id / nav.L) | 0; if (nav.padMask[col]) continue;
      const c = { id, x: nav.cx(col % nav.N), y: nav.ys[id], z: nav.cx((col / nav.N) | 0), stay: false };
      job.cands.push(c);
    }
    if (kind !== 'push') job.cands.push({ id: -1, x: p.x, y: p.y, z: p.z, stay: true });
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
      else s += (los ? 7 : -6) - Math.abs(dT - this.prefRange) * 0.5 - travel * 0.25;
      if (c.stay) s -= job.kind === 'cover' ? 0 : this.hurtT < 1.2 ? 4 : 1.2;
      for (const o of this.mgr.bots) {
        if (o === this || !o.alive) continue;
        if (Math.hypot(o.pos.x - c.x, o.pos.z - c.z) < 2.4 || (o.path && Math.hypot(o.goal.x - c.x, o.goal.z - c.z) < 2.4)) s -= 5;
      }
      if (s > job.bs) { job.bs = s; job.best = c; }
    }
    if (job.i < job.cands.length) return;
    this.evalJob = null;
    const b = job.best; if (!b || b.stay) return;
    const travel = Math.hypot(b.x - p.x, b.z - p.z);
    const speed = job.kind === 'cover' || travel > 7 ? cfg.sprintSpeed : cfg.combatSpeed;
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
    else { ty = this.scanBase + Math.sin(this.t * 0.75 + this.scanPhase) * 1.05; k = 2.2; tp = Math.sin(this.t * 0.4 + this.scanPhase) * 0.08; }
    this.flinchErr = damp(this.flinchErr, 0, 2.5, dt);
    this.recoil = damp(this.recoil, 0, 9, dt);

    const dyaw = wrap(ty - this.aimYaw), dpitch = tp - this.aimPitch, a = 1 - Math.exp(-k * dt), cap = cfg.aimMaxTurn * dt;
    this.aimYaw = wrap(this.aimYaw + THREE.MathUtils.clamp(dyaw * a, -cap, cap));
    this.aimPitch = THREE.MathUtils.clamp(this.aimPitch + THREE.MathUtils.clamp(dpitch * a, -cap, cap), -1.3, 1.3);
    this.aimOff = Math.abs(dyaw) + Math.abs(dpitch);
    this.bodyYaw = wrap(this.bodyYaw + wrap(this.aimYaw - this.bodyYaw) * (1 - Math.exp(-(combat ? 9 : 7) * dt)));
    const cp = Math.cos(this.aimPitch + this.recoil);
    this.aimDir.set(Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch + this.recoil), Math.cos(this.aimYaw) * cp);
    this.aimingPose = combat ? (this.lookMove ? 0.25 : 1) : this.state === 'patrol' ? 0 : 0.55;
  }

  fire(dt) {
    const cfg = this.cfg;
    if (this.reloadT > 0) { this.reloadT -= dt; if (this.reloadT <= 0) { this.mag = cfg.magSize; this.reloadCover = false; } }
    if (this.reactT > 0 && this.visible) this.reactT -= dt;
    const tp = this.visible && this.target ? this.target.pos : this.lastSeen;
    this.inRange = cfg.ffa || this.pos.distanceTo(tp) <= cfg.engageRange; // never open fire across the map
    const can = this.state === 'combat' && this.hasToken && this.inRange && this.reactT <= 0 && this.reloadT <= 0 && (this.visible || (this.unseenT < 0.35 && this.burstLeft > 0));
    if (!can) { this.burstLeft = 0; this.shotT = 0; if (this.pauseT > 0) this.pauseT -= dt; return; }
    if (this.pauseT > 0) { this.pauseT -= dt; return; }
    if (this.burstLeft <= 0) { this.burstLeft = randI(cfg.burst); this.shotT = 0; }
    this.shotT -= dt;
    if (this.shotT > 0 || this.aimOff > 0.1) return;
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
    return (this._hc = p);
  }

  shoot() {
    const cfg = this.cfg, ctx = this.ctx, ev = ctx.events;
    const origin = new THREE.Vector3(this.pos.x, this.pos.y + EYE, this.pos.z);
    let dir;
    const pl = this.target;
    if (this.visible && pl && pl.alive) {
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
      // blind fire at the last known position: cone around the simulated aim direction
      dir = this.aimDir.clone();
      const r = cfg.spread * Math.sqrt(Math.random()), th = Math.random() * Math.PI * 2;
      TMP.set(Math.cos(this.aimYaw), 0, -Math.sin(this.aimYaw));            // right-ish
      TMP2.crossVectors(dir, TMP).normalize();                               // up-ish
      dir.addScaledVector(TMP, Math.cos(th) * r).addScaledVector(TMP2, Math.sin(th) * r).normalize();
    }
    const hit = ctx.hitscan(origin, dir, cfg.maxRange, this);
    if (!cfg.ffa && hit && hit.type === 'target' && hit.target.team === this.team) return false; // an ally is in the line of fire: hold
    // muzzle of the carbine (for tracers / flashes drawn by the fx system)
    const sy = Math.sin(this.aimYaw), cy = Math.cos(this.aimYaw);
    const muzzle = new THREE.Vector3(this.pos.x - cy * 0.1, this.pos.y + 1.43, this.pos.z + sy * 0.1).addScaledVector(this.aimDir, 0.9);
    this.stats.shots++; this.mgr.stats.shots++;
    this.recoil += cfg.recoilPerShot; this.mesh.fireKick();
    ev.emit('shot', { weapon: 'bot_rifle', origin, dir, dirs: [dir], muzzle, by: this, end: hit ? hit.point : origin.clone().addScaledVector(dir, cfg.maxRange) });
    if (!hit) return true;
    if (hit.type === 'target') {
      const t = hit.target, dmg = cfg.damage * (hit.headshot ? cfg.headshotMult : 1);
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
      if (this.deadT < cfg.respawnDelay + 1) {
        stepBody(this.body, this.ctx.world, dt, 0, 0, 0, 0, false);
        a.grounded = this.body.grounded; a.floorY = this.body.grounded ? this.pos.y : this.pos.y - 3; a.showBar = false;
        a.fadeStart = Math.max(1.4, cfg.respawnDelay - 1.7); a.fadeTime = 1.2;
        this.mesh.update(dt, a);
      }
      return;
    }
    this.t += dt; this.hurtT += dt;
    if (this.hurtT > cfg.regenDelay && this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + cfg.regenRate * dt);
    if (this.visible) { if (this.unseenT > 1.5) this.firstBurst = true; this.seenT += dt; this.unseenT = 0; this.settle += dt; } else { this.seenT = 0; this.unseenT += dt; this.settle = Math.max(0, this.settle - dt * 0.6); }

    this.percT -= dt;
    if (this.percT <= 0) {
      if (this.mgr.rayBudget <= 0 && (this.percDefer = (this.percDefer || 0) + 1) <= 2) this.percT = 0; // ray budget spent: wait a frame (2 at most)
      else { this.percDefer = 0; this.percT += cfg.perceptionInterval; if (this.percT < 0) this.percT = cfg.perceptionInterval; this.perceive(); }
    }
    this.think(dt);
    if (!cfg.ffa) { // HUD-facing detection state + one event per upward transition
      const st = this.state === 'combat' || this.state === 'chase' ? 'alert' : this.awareness >= cfg.suspiciousAt || this.state === 'investigate' || this.state === 'search' ? 'suspicious' : 'unaware';
      if (st !== this.alertState) {
        const up = st === 'alert' || (st === 'suspicious' && this.alertState === 'unaware'), name = st === 'alert' ? 'guardAlert' : 'guardSuspicious';
        if (up && this.mgr.time - this.evT[name] > cfg.alertEventInterval) { this.evT[name] = this.mgr.time; this.ctx.events.emit(name, { bot: this }); }
        this.alertState = st;
      }
      this.lastSeenPlayerT = this.mgr.time - this.sightT;
    }
    this.aim(dt);
    this.move(dt);
    if (!this.alive) return;
    this.fire(dt);

    a.bodyYaw = this.bodyYaw; a.aimYaw = this.aimYaw; a.aimPitch = this.aimPitch + this.recoil; a.grounded = this.body.grounded || this.body.coyote > 0;
    a.aiming = this.aimingPose; a.hp01 = this.hp / this.maxHp; a.showBar = this.hurtT < 3.5 && this.hp < this.maxHp;
    this.mesh.update(dt, a);
  }
}
