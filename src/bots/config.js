// =============================================================================
// BOT CONFIG — every difficulty / behaviour knob lives here.
// The live object is exposed as ctx.bots.config and is read every frame, so it
// can be changed at runtime (e.g. by a game mode or from the console).
// Defaults are tuned to be fair for an average player (100 hp, regen after 5 s).
// =============================================================================
export const CONFIG = {
  ffa: true,                // free-for-all: every other living entry in ctx.targets (player and bots) is an enemy
  targetScore: {            // target choice among VISIBLE enemies (highest wins; the human gets no bonus)
    perMeter: 0.5,          // closer is better (score -= distance * this)
    attacker: 12,           // whoever hit me within attackerMemory seconds
    attackerMemory: 4,
    lowHealth: 6,           // x (1 - hp / maxHp): finish the wounded
    sticky: 8,              // bonus for the current target so they do not flip-flop
  },
  perceiveOthersPerTick: 2, // besides its current target, a bot ray-checks this many other enemies per perception tick
  maxRaysPerFrame: 10,      // global cap on bot line-of-sight rays per frame (current-target checks are never skipped)
  searchAfterKill: 4,       // seconds of looking around after the target dies
  // ---- guards (team mode, ffa: false): roles and detection -------------------
  // enemy types (team mode only). `set` replaces a config value for that guard, `mul` multiplies the shared value,
  // `role` forces passive/active, `max` caps how many can be alive at once, `weight` is how often it is rolled.
  kinds: {
    grunt: { weight: 4, label: 'Guard', scale: 1.0, color: 0xff4a1c, set: {}, mul: {} },
    heavy: { weight: 2, max: 2, label: 'Heavy', scale: 1.15, color: 0xff1a3c, role: 'active',
      set: { hp: 240, burst: [7, 12], burstPause: [0.9, 1.6], magSize: 60, reloadTime: 3.2 },
      mul: { walkSpeed: 0.72, sprintSpeed: 0.7, patrolSpeed: 0.8, combatSpeed: 0.65, damage: 1.15, aimSpeed: 0.75 } },
    scout: { weight: 2, max: 2, label: 'Scout', scale: 0.92, color: 0x35e0ff, role: 'active',
      set: { hp: 70, engageRange: 20, burst: [4, 8], burstPause: [0.25, 0.6], accuracyByRange: [[0, 0.8], [8, 0.6], [16, 0.35], [24, 0.15]] },
      mul: { walkSpeed: 1.25, sprintSpeed: 1.25, patrolSpeed: 1.35, combatSpeed: 1.35, damage: 0.75, fireRate: 1.3 } },
    marksman: { weight: 1, max: 1, label: 'Marksman', scale: 1.0, color: 0xffe14a, role: 'passive',
      set: { hp: 90, engageRange: 55, sightRangePassive: 50, burst: [1, 1], burstPause: [1.8, 2.6], reactionTime: [0.9, 1.3], accuracyByRange: [[0, 0.6], [20, 0.55], [40, 0.45], [55, 0.3]] },
      mul: { damage: 4.5 } },
  },
  passiveShare: 0.5,        // share of living guards that hold a post instead of patrolling the map
  passiveLoopRadius: 8,     // m: a passive guard idles within this distance of its post
  passiveLeash: 30,         // m from its post a passive guard will go to investigate / fight
  sightRange: 45,           // m: active guards notice nothing beyond this
  sightRangePassive: 32,    // m: passive guards
  trackRangeMult: 1.3,      // once alert, a guard keeps sight of the player out to sightRange x this
  sightMods: { crouching: 0.5, still: 0.7, sprinting: 1.5, coneCentre: 1.3, coneEdge: 0.7, onGuard: 1.5 }, // awareness fill-rate multipliers (onGuard: already suspicious / searching)
  suspiciousAt: 0.35,       // awareness >= this -> 'suspicious' (1.0 -> 'alert')
  forgetTime: 20,           // s for awareness to decay from 1 to 0 once the player is not perceived
  engageRange: 42,          // m: a guard never fires at a target farther than this
  peekDistance: 6,          // m a suspicious guard walks toward what it glimpsed / heard faintly
  watchTime: 6,             // s a guard keeps watching a stimulus it will not walk to
  hearExplosionDist: 60,
  hearWalkDist: 5,          // walking footsteps (sprint / landing: hearStepDist; crouch-walking is silent)
  hearAllyShotDist: 30,     // guards hear another guard open fire and come to look
  hearNoLosMult: 0.7,       // gunshot hearing range without line of sight to it (0.7 x 45 m = 31.5 m)
  suppressedHearMult: 0.25, // for 'shot' events flagged suppressed
  hearAwareness: { shot: 0.45, explosion: 0.5, impact: 0.4, sprint: 0.3, walk: 0.2, allyShot: 0.25, callOut: 0.2 },
  alertEventInterval: 4,    // min seconds between guardSuspicious / guardAlert events of one bot
  count: 6,                 // bots alive at once (ctx.bots.setCount(n) changes it)
  respawnDelay: 5.0,        // seconds between a death and the respawn
  spawnMinDist: 32,         // spawn at least this far from the player (and out of sight if possible)
  spawnSeparation: 12,      // keep new spawns this far from other bots

  // ---- body ---------------------------------------------------------------
  hp: 120,                  // player rifle does 22 per body shot -> 6 hits
  regenDelay: 9,            // seconds without damage before health comes back
  regenRate: 8,             // hp / s
  walkSpeed: 5.5,
  sprintSpeed: 8.6,
  patrolSpeed: 3.4,         // relaxed pace when nothing is going on
  combatSpeed: 4.6,         // strafing / repositioning while shooting
  accentColor: 0xff4a1c,    // emissive team colour

  // ---- senses -------------------------------------------------------------
  fovDeg: 115,              // horizontal field of view when unaware
  combatFovDeg: 210,        // once in a fight they track much wider
  viewDist: 75,
  closeSense: 2.8,          // "feels" the player this close even from behind
  perceptionInterval: 0.13, // seconds between line-of-sight checks per bot (staggered)
  detectTimeNear: 0.22,     // seconds of visibility needed to notice at point-blank ...
  detectTimeFar: 1.3,       // ... and at viewDist (unaware bots only)
  hearShotDist: 45,         // hears the player's gunfire within this distance
  hearStepDist: 12,          // hears sprint footsteps / landings
  hearImpactDist: 8,        // bullets landing this close get attention
  alertRadius: 22,          // a bot that spots the player calls out to allies this close
  loseSightTime: 2.2,       // seconds without seeing before leaving the fight to chase
  searchTime: 12,           // seconds of searching before giving up

  // ---- aim (human-like) ---------------------------------------------------
  reactionTime: [0.32, 0.6],   // delay before the first shot after acquiring the player
  reacquireTime: [0.14, 0.3],  // delay when the player pops back out of cover
  aimSpeed: 9,                 // how fast the aim converges (1/s, exponential)
  aimMaxTurn: 5.5,             // rad/s cap
  aimErrorBase: 0.019,         // rad of wandering aim error when settled on a still target
  aimErrorFirst: 0.055,        // extra error right after acquiring, decays with aimSettleTime
  aimSettleTime: 0.8,
  aimErrorTargetSpeed: 0.045,  // rad of error per rad/s of target angular speed
  aimErrorSelfMove: 0.0022,    // rad of error per m/s of own movement
  aimErrorFlinch: 0.05,        // error kick when hit
  spread: 0.013,               // per-shot random cone (rad) — only for blind fire at a last-known position
  recoilPerShot: 0.0035,       // climb within a burst (rad)

  // ---- accuracy (explicit, distance-driven) ---------------------------------
  // Every round fired at a visible player is first decided hit / miss by this model; the aim
  // simulation above only drives the pose and when the trigger is pulled.
  // accuracyByRange: [distance m, fraction of rounds that land on a STATIONARY, exposed player once settled]
  accuracyByRange: [[0, 0.75], [10, 0.6], [20, 0.38], [35, 0.2], [50, 0.1], [70, 0.05]],
  accuracyMods: {
    targetWalk: 0.6,        // target crossing at walk speed (5.5 m/s), interpolated from 1 at rest
    targetSprint: 0.4,      // ... at sprint speed (8.6 m/s)
    targetAirborne: 0.5,    // target jumping / falling / sliding / on a zipline
    selfMoving: 0.7,        // the bot itself is moving (> 1 m/s)
    firstBurst: 0.4,        // first burst after (re)acquiring: mostly misses that walk in
    recentlyHit: 0.5,       // the bot took damage within recentlyHitTime
  },
  recentlyHitTime: 1.0,
  missOffset: [0.25, 0.95],    // m beside the body (beyond its radius) a deliberate miss is aimed at, at 0 m range
  missOffsetPerMeter: 0.025,   // misses open up with distance (x (1 + d * this))
  missOverHead: 0.2,           // share of misses that go high instead of wide
  reactionPerMeter: 0.0075,    // extra first-acquisition reaction time per metre of range (+0.15 s per 20 m)

  // ---- weapon -------------------------------------------------------------
  damage: 7,
  headshotMult: 1.5,
  fireRate: 8.5,               // shots / s inside a burst
  burst: [3, 6],               // shots per burst
  burstPause: [0.45, 1.05],    // pause between bursts
  magSize: 26,
  reloadTime: 2.1,
  maxRange: 220,
  maxAttackers: 2,             // (team mode only, ffa: false) bots allowed to fire at the same time
  attackHoldTime: [3.5, 6],    // how long one bot keeps its firing slot while others wait

  // ---- tactics ------------------------------------------------------------
  preferredRange: [11, 22],    // each bot picks a favourite distance in this range
  closeInBeyond: 6,            // farther than preferred range + this from the target: advance instead of trading shots
  minRange: 5,
  retreatHp: 45,               // below this they break off to cover
  coverTime: [1.2, 2.6],       // time spent behind cover before peeking again
  peekTime: [1.3, 2.4],        // time spent out of cover shooting
  repositionInterval: [0.9, 2.2], // strafe / shift position this often while engaging
  tacticalRadius: 12,          // how far they look for a better position

  // ---- navigation ---------------------------------------------------------
  nav: {
    cell: 0.5,                 // grid resolution (m)
    maxLayers: 6,              // walkable surfaces stacked in one column
    maxDrop: 12,               // highest ledge they will hop down from
    expansionsPerFrame: 1600,  // A* budget per frame (shared by all bots)
    columnsPerFrame: 300,      // nav columns re-generated per frame after destruction
    floodPerFrame: 1500,       // reachability flood budget per frame
    floodInterval: 2.5,        // min seconds between reachability floods while the world keeps changing
    syncInterval: 0.2,         // how often world.colliders is diffed for changes
  },

  debug: false,
};

export const rand = (a, b) => a + Math.random() * (b - a);
export const randR = (r) => r[0] + Math.random() * (r[1] - r[0]);
export const randI = (r) => Math.floor(r[0] + Math.random() * (r[1] - r[0] + 1));
