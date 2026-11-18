// =============================================================================
// WEAPON TUNING — every gunplay number lives in this file. Edit freely after playtesting.
//
// Units: time in seconds, angles in DEGREES, distance in metres.
//
//   id            string sent in events ('pistol' | 'rifle' | 'shotgun' | 'sniper' | 'launcher'); name = display name
//   modes         fire modes, toggled with B: 'auto' | 'semi' | 'burst'
//   rpm           rate of fire. burst: { count, rpm, gap } (gap = pause after a burst)
//   damage        per bullet / per pellet.  headMult: headshot multiplier
//                 headR: a headshot must also pass within this distance (m) of the target's centre line, so the
//                 multiplier is earned by aim, not by clipping the top corner of the hit box (omit = any head-height hit)
//   falloff       [startDist, endDist, multiplierAtEnd]
//   pellets       bullets per shot (shotgun)
//   mag/reserve   magazine size / starting+max reserve ammo. killRefund: reserve gained per kill
//   reload        { type:'mag', time, commit }   commit = fraction of the animation at which ammo is in the gun
//                   time = the EMPTY reload (mag out, mag in, charge). With `tactical` (a fraction of the same
//                   timeline, e.g. 0.8) a reload with rounds left skips the charge, ends at that point and keeps
//                   the round in the chamber (mag + 1). stages: [out, in, charge] = where on the timeline the
//                   'reloadStage' events fire (they match the viewmodel animation).
//                 { type:'shell', start, shell, insert, end }  one round at a time, interruptible by firing
//   equip         raise time when switching to it.  sprintOut: sprint -> can fire delay
//   mobility      move speed multiplier while held
//   spread        hip/ads: base cone half-angle (0 = first shot perfectly accurate standing still)
//                 move: added at walk speed, air: added while airborne, slide: added while sliding
//                 bloom: added per shot, bloomMax, decay (deg/s), crouch: multiplier while crouched
//                 delay: seconds after a shot before the bloom starts to decay (default: one shot interval + 0.03)
//                 adsBloom: share of the bloom that survives while aimed (default 0.4)
//   recoil        pattern: [up, right] aim kick per shot (the last `loop` entries repeat for long sprays)
//                 jitter: random +- added to each entry, adsMult/crouchMult: scaling
//                 snap: how fast the kick is applied (1/s), recover: return speed (1/s), delay: before recovery
//                 The aim returns to where the spray started unless the player pulled against it.
//   kick          purely visual: z (viewmodel pushed back, m), rx (muzzle flip, rad), roll (random roll, rad),
//                 jolt (random sideways / vertical shake of the gun, m),
//                 cam (camera pitch punch, rad), camRoll, fov (FOV punch, degrees),
//                 climb (muzzle rise that builds up over a burst and settles, rad per shot), climbMax
//   eject         spent case: delay after the shot, vel [right, up, back] m/s  (omit for none)
//   ads           fov: fovScale when aimed, time: transition, move: move speed multiplier, vmFov: viewmodel FOV aimed
//                 scope: true = look through the telescopic sight (its eyepiece fills the view)
//   view          hip: viewmodel position [right, up, forward] at the hip, fov: viewmodel FOV,
//                 adsDist: how far the sight sits from the eye when aimed
// =============================================================================

// WREN AR-6: the first three rounds kick softly (bursts stay on target), rounds 4-9 climb hard, then the
// climb flattens and the muzzle walks right (to ~13), left (to ~20), and wanders gently after that.
const rifleRecoil = [
  [0.34, 0.02], [0.40, -0.03], [0.50, 0.04], [0.62, 0.09], [0.66, 0.13], [0.62, 0.16], [0.56, 0.17], [0.48, 0.17],
  [0.42, 0.16], [0.36, 0.14], [0.32, 0.10], [0.30, 0.04], [0.28, -0.06], [0.28, -0.15], [0.26, -0.20], [0.26, -0.22],
  [0.26, -0.21], [0.24, -0.18], [0.24, -0.12], [0.24, -0.04], [0.24, 0.08], [0.24, 0.16], [0.24, 0.18], [0.24, 0.12],
  [0.24, 0.0], [0.24, -0.12], [0.24, -0.18], [0.24, -0.14],
];

export const WEAPONS = [
  {
    // the sidearm you deploy with: crisp and accurate up close, clearly outclassed by everything found later
    id: 'pistol', name: 'MARTLET-9', tag: 'Service pistol', accent: '#e9e3d4',
    modes: ['semi'], rpm: 400,
    damage: 24, headMult: 2.5, headR: 0.24, falloff: [15, 40, 0.55], pellets: 1, range: 250,
    mag: 15, reserve: 90, killRefund: 15,
    reload: { type: 'mag', time: 1.2, commit: 0.53, tactical: 0.78, stages: [0.1, 0.53, 0.72] },
    equip: 0.15, sprintOut: 0.07, mobility: 1.04,
    spread: { hip: 0.0, ads: 0.0, move: 0.6, air: 1.2, slide: 0.4, bloom: 0.55, bloomMax: 2.4, decay: 12, delay: 0.12, crouch: 0.7, adsMoveMult: 0.25, adsBloom: 0.35 },
    recoil: { pattern: [[1.25, 0.06], [1.1, -0.14], [1.15, 0.16], [1.1, -0.1]], loop: 4, jitter: 0.08, adsMult: 0.8, crouchMult: 0.85, snap: 110, recover: 16, delay: 0.06 },
    kick: { z: 0.034, rx: 0.1, roll: 0.03, jolt: 0.0025, cam: 0.007, camRoll: 0.005, fov: 0.55, climb: 0.012, climbMax: 0.04 },
    eject: { delay: 0.02, vel: [2.2, 1.9, 0.3] },
    ads: { fov: 0.85, time: 0.11, move: 1.0, vmFov: 50 },
    view: { hip: [0.105, -0.118, 0.35], fov: 60, adsDist: 0.37 }, // held further from the eye when aiming, so the gun covers less of the view
  },
  {
    id: 'rifle', name: 'WREN AR-6', tag: 'Assault carbine', accent: '#22e0c8',
    modes: ['auto', 'burst'], rpm: 640, burst: { count: 3, rpm: 900, gap: 0.15 },
    damage: 27, headMult: 1.8, headR: 0.24, falloff: [30, 70, 0.6], pellets: 1, range: 400,
    mag: 30, reserve: 180, killRefund: 30,
    reload: { type: 'mag', time: 1.5, commit: 0.57, tactical: 0.8, stages: [0.11, 0.57, 0.71] },
    equip: 0.22, sprintOut: 0.1, mobility: 1.0,
    spread: { hip: 0.0, ads: 0.0, move: 0.9, air: 1.5, slide: 0.5, bloom: 0.26, bloomMax: 2.2, decay: 10, crouch: 0.7, adsMoveMult: 0.2, adsBloom: 0.2 },
    recoil: { pattern: rifleRecoil, loop: 8, jitter: 0.04, adsMult: 0.72, crouchMult: 0.85, snap: 80, recover: 10, delay: 0.11 },
    kick: { z: 0.044, rx: 0.032, roll: 0.026, jolt: 0.002, cam: 0.0045, camRoll: 0.005, fov: 0.7, climb: 0.011, climbMax: 0.07 },
    eject: { delay: 0.0, vel: [2.6, 1.5, 0.5] },
    ads: { fov: 0.72, time: 0.15, move: 0.82, vmFov: 42 },
    view: { hip: [0.2, -0.195, 0.45], fov: 60, adsDist: 0.165 },
  },
  {
    id: 'shotgun', name: 'BRAMBLE-8', tag: 'Pump scattergun', accent: '#ff8a3c',
    modes: ['semi'], rpm: 84,
    damage: 13, headMult: 1.3, falloff: [9, 26, 0.3], pellets: 10, range: 120,
    mag: 6, reserve: 36, killRefund: 6,
    reload: { type: 'shell', start: 0.3, shell: 0.4, insert: 0.55, end: 0.3 },
    equip: 0.3, sprintOut: 0.12, mobility: 0.98,
    spread: { hip: 3.3, ads: 2.5, move: 0.3, air: 0.5, slide: 0.0, bloom: 0.5, bloomMax: 1.0, decay: 4, crouch: 0.9, adsMoveMult: 0.5 },
    recoil: { pattern: [[3.6, 0.5], [3.4, -0.6], [3.5, 0.3]], loop: 3, jitter: 0.35, adsMult: 0.85, crouchMult: 0.9, snap: 45, recover: 9, delay: 0.12 },
    kick: { z: 0.12, rx: 0.17, roll: 0.07, cam: 0.022, camRoll: 0.014, fov: 2.4, climb: 0.03, climbMax: 0.06 },
    eject: { delay: 0.2, vel: [2.0, 1.0, 0.3] },
    ads: { fov: 0.84, time: 0.17, move: 0.85, vmFov: 48 },
    view: { hip: [0.205, -0.2, 0.46], fov: 60, adsDist: 0.2 },
  },
  {
    id: 'sniper', name: 'LONGHAND .50', tag: 'Bolt rail rifle', accent: '#ff4d7a',
    modes: ['semi'], rpm: 50,
    damage: 100, headMult: 2.2, falloff: [90, 200, 0.85], pellets: 1, range: 600,
    mag: 5, reserve: 30, killRefund: 5,
    reload: { type: 'mag', time: 2.3, commit: 0.55 },
    equip: 0.42, sprintOut: 0.16, mobility: 0.94,
    spread: { hip: 2.6, ads: 0.0, move: 2.0, air: 3.0, slide: 1.0, bloom: 1.5, bloomMax: 1.5, decay: 3, crouch: 0.6, adsMoveMult: 0.12 },
    recoil: { pattern: [[5.2, 0.6], [5.0, -0.7]], loop: 2, jitter: 0.4, adsMult: 0.8, crouchMult: 0.8, snap: 40, recover: 7, delay: 0.14 },
    kick: { z: 0.14, rx: 0.14, roll: 0.06, cam: 0.03, camRoll: 0.018, fov: 3.0, climb: 0.03, climbMax: 0.05 },
    eject: { delay: 0.42, vel: [1.8, 1.2, 0.6] },
    ads: { fov: 0.27, time: 0.22, move: 0.6, vmFov: 23, scope: true },
    view: { hip: [0.2, -0.205, 0.5], fov: 60, adsDist: 0.108 },
  },
  {
    id: 'launcher', name: 'DOORKNOCKER', tag: 'Grenade launcher', accent: '#ffc928',
    modes: ['semi'], rpm: 92,
    damage: 0, headMult: 1, falloff: [0, 1, 1], pellets: 0, range: 0,
    mag: 6, reserve: 18, killRefund: 3, reserveRegen: 7, // one grenade back into reserve every N seconds
    reload: { type: 'mag', time: 2.2, commit: 0.7 },
    equip: 0.36, sprintOut: 0.14, mobility: 0.95,
    spread: { hip: 0.4, ads: 0.1, move: 0.5, air: 0.6, slide: 0.2, bloom: 0.8, bloomMax: 1.2, decay: 4, crouch: 0.8, adsMoveMult: 0.4 },
    recoil: { pattern: [[2.6, 0.3], [2.5, -0.4]], loop: 2, jitter: 0.3, adsMult: 0.85, crouchMult: 0.9, snap: 40, recover: 8, delay: 0.12 },
    kick: { z: 0.1, rx: 0.12, roll: 0.05, cam: 0.016, camRoll: 0.012, fov: 1.8, climb: 0.02, climbMax: 0.04 },
    ads: { fov: 0.86, time: 0.18, move: 0.85, vmFov: 50 },
    view: { hip: [0.215, -0.215, 0.44], fov: 60, adsDist: 0.3 },
    projectile: 'launcher',
  },
];

// ---- variants: new weapons built on an existing model and action (see MODEL_FOR in viewmodels.js) ----
const base = (id) => WEAPONS.find((w) => w.id === id);
const scaleRecoil = (pattern, k) => pattern.map(([u, s]) => [u * k, s * k]);
WEAPONS.push(
  { // fast, light and weak: wins inside a building, loses across a street
    ...base('rifle'), id: 'smg', name: 'FINCH-45', tag: 'Compact carbine', accent: '#ffd166',
    modes: ['auto'], rpm: 900, damage: 17, headMult: 1.5, falloff: [14, 36, 0.5],
    mag: 36, reserve: 216, killRefund: 36,
    reload: { ...base('rifle').reload, time: 1.3 },
    equip: 0.2, sprintOut: 0.08, mobility: 1.06,
    spread: { ...base('rifle').spread, move: 0.45, air: 0.9, bloom: 0.2 },
    recoil: { ...base('rifle').recoil, pattern: scaleRecoil(base('rifle').recoil.pattern, 0.7) },
    ads: { ...base('rifle').ads, fov: 0.82, time: 0.11, move: 0.95 },
  },
  { // semi-automatic marksman rifle: two headshots or three body shots, slow to follow up
    ...base('rifle'), id: 'dmr', name: 'HARRIER DMR', tag: 'Marksman rifle', accent: '#9be37a',
    modes: ['semi'], rpm: 300, burst: undefined, damage: 52, headMult: 2.0, falloff: [50, 110, 0.75], range: 500,
    mag: 12, reserve: 72, killRefund: 12,
    reload: { ...base('rifle').reload, time: 1.85 },
    equip: 0.32, sprintOut: 0.14, mobility: 0.97,
    spread: { ...base('rifle').spread, move: 1.6, air: 2.6, bloom: 0.9, bloomMax: 2.6, decay: 6 },
    recoil: { ...base('rifle').recoil, pattern: [[2.4, 0.2], [2.2, -0.3], [2.3, 0.25]], loop: 3, recover: 8 },
    kick: { ...base('rifle').kick, z: 0.06, rx: 0.05, cam: 0.008, fov: 1.1 },
    ads: { ...base('rifle').ads, fov: 0.5, time: 0.19, move: 0.7 },
  },
  { // one heavy slug instead of pellets: a pump gun that reaches across a street
    ...base('shotgun'), id: 'slug_shotgun', name: 'BRAMBLE SLUG', tag: 'Slug gun', accent: '#c98bff',
    pellets: 1, damage: 96, headMult: 1.5, falloff: [22, 60, 0.5], range: 300,
    spread: { ...base('shotgun').spread, hip: 0.5, ads: 0.0, bloom: 0.8 },
  },
);


// Bouncing explosives. Blast damage falls off linearly from `damage` at the centre to damage*edge at `radius`.
export const PROJECTILES = {
  launcher: {
    speed: 36, up: 0.03, gravity: 17, radius: 0.085, bounce: 0.42, friction: 0.3,
    fuse: 3.0,            // max lifetime
    fuseAfterBounce: 0.55, // detonates this long after the first bounce
    impactTargets: true,  // direct hit on an enemy detonates instantly
    blast: { radius: 6.5, damage: 135, edge: 0.12, selfMult: 0.45, knock: 11, structure: 150 },
  },
  frag: {
    speed: 21, up: 0.16, gravity: 22, radius: 0.08, bounce: 0.5, friction: 0.35,
    fuse: 2.1, fuseAfterBounce: 0, impactTargets: false,
    blast: { radius: 8, damage: 170, edge: 0.1, selfMult: 0.5, knock: 13, structure: 220 },
  },
};

// Thrown frag (G)
export const GRENADE = { name: 'PUCK', charges: 2, recharge: 9, throwDelay: 0.13, throwTime: 0.42 };

// Global feel
export const FEEL = {
  holster: 0.09,        // time to drop the current weapon when switching
  fireBuffer: 0.2,      // a click this long before the gun is ready still fires
  reloadCancel: 0.09,   // firing with rounds left aborts a reload before the new magazine is in; the shot follows after this
  lowAmmo: 0.3,         // 'lowAmmo' events for the last share of a magazine
  walkSpeed: 5.5, sprintSpeed: 8.6,
  hitmarkerTime: 0.22, killMarkerTime: 0.55,
  killFovPunch: 0.12, headshotKillFovPunch: 0.2, // quick zoom-in pop on a kill (degrees)
  kickRhythm: 0.14,
  // strafing: the gun rolls against the camera lean and trails sideways (springy: overshoots on stop / reverse)
  strafeRoll: 0.065, strafeShift: 0.013, strafeTrail: 0.0022, strafeSpring: 75, strafeDamp: 9.5,     // every other shot of a spray kicks this much harder / softer
  explosionShake: 0.07,
};

// Arcade scoring. Every part of a kill is multiplied by the streak multiplier and rounded to 5.
//   'score' events carry reason: 'kill' | 'headshot' | 'longRange' | 'pointBlank' | 'blast' | 'multikill' | 'streak'
export const SCORE = {
  kill: 100,
  headshot: 50,
  longRange: 25, longRangeDist: 35,   // metres
  pointBlank: 25, pointBlankDist: 4,
  blast: 25,                          // explosive kill
  multiWindow: 3.2,                   // seconds between kills to keep a multi-kill going (the combo bar)
  multi: { 2: ['DOUBLE KILL', 50], 3: ['TRIPLE KILL', 100], 4: ['QUAD KILL', 150], 5: ['RAMPAGE', 250] }, // 5 = 5 or more
  streakMult: 0.1, streakMultMax: 2,  // +10% per kill in the streak (resets on death), up to x2
  streakEvery: 5, streakBonus: 100,   // bonus every N kills without dying
  labels: { kill: 'KILL', headshot: 'HEADSHOT', longRange: 'LONG RANGE', pointBlank: 'POINT BLANK', blast: 'BLAST', multikill: 'MULTI', streak: 'KILLSTREAK' },
};
