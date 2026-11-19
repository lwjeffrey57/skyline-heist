import * as THREE from 'three';
import { Particles, preset, TILE_SMOKE, TILE_CHIP, TILE_RING, TILE_STAR_A, TILE_STAR_B, TILE_BLAST, TILE_SHARD } from './fx/particles.js';
import { Decals, DECAL_CONCRETE, DECAL_METAL, DECAL_SCORCH } from './fx/decals.js';
import { Tracers } from './fx/tracers.js';
import { createScreen } from './fx/screen.js';
import { nearMiss, NEAR_MISS } from './fx/nearmiss.js';

// Transient visual effects. Purely reactive: listens to ctx.events and renders.
// Draw calls: 2 particle systems (soft = smoke/dust/chips, glow = fire/sparks/flashes), 1 decal mesh,
// 1 tracer mesh, 1 Points cloud of ambient motes. 3 pooled PointLights that never leave the scene.
// Everything is ring-buffered: spawning writes into typed arrays, nothing is allocated per frame.

const SOFT_CAP = 3072, GLOW_CAP = 3072, LIGHTS = 3;
const INDOOR_LIGHT = 0.3, FOG_FALLOFF = 0.022; // FOG_FALLOFF mirrors visuals/sky.js SKY.fogFalloff

// ---- presets ---------------------------------------------------------------------------------------------
const P = {
  // muzzle: shaped sprites that live 1-2 frames (random variant / rotation / scale per shot), spikes, sparks, gas
  mzStarA: preset({ tile: TILE_STAR_A, life: [0.03, 0.042], speed: [0, 0], size0: [0.3, 0.38], size1: [0.4, 0.5], col0: [14, 8.5, 3.2], col1: [9, 3, 0.5], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0 }),
  mzStarB: preset({ tile: TILE_STAR_B, life: [0.03, 0.042], speed: [0, 0], size0: [0.3, 0.38], size1: [0.4, 0.5], col0: [14, 8.5, 3.2], col1: [9, 3, 0.5], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0 }),
  mzBlast: preset({ tile: TILE_BLAST, life: [0.04, 0.06], speed: [0, 1], size0: [0.3, 0.4], size1: [0.55, 0.7], col0: [8.5, 3.6, 0.9], col1: [5, 1.1, 0.15], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0 }),
  mzCore: preset({ life: [0.03, 0.045], speed: [0, 0.6], size0: [0.1, 0.14], size1: [0.2, 0.26], col0: [14, 10, 5], col1: [8, 3, 0.6], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0.1 }),
  mzSpike: preset({ life: [0.03, 0.055], speed: [12, 30], spread: 0.3, size0: [0.05, 0.09], size1: [0.02, 0.03], col0: [11, 7.5, 3], col1: [6, 2, 0.4], add0: 1, add1: 1, stretch: 0.034, fadeIn: 0, fadeOut: 0.3, rot: 0 }),
  mzJet: preset({ life: [0.04, 0.07], speed: [14, 30], spread: 0.16, size0: [0.06, 0.1], size1: [0.02, 0.03], col0: [12, 7, 2.6], col1: [6, 1.6, 0.3], add0: 1, add1: 1, stretch: 0.03, fadeIn: 0, fadeOut: 0.2, rot: 0 }),
  mzSpark: preset({ life: [0.12, 0.34], speed: [6, 18], spread: 0.24, size0: [0.016, 0.026], size1: [0.008, 0.01], col0: [9, 5.5, 2], col1: [4, 1, 0.1], add0: 1, add1: 1, gravity: 6, drag: 3, stretch: 0.02, rot: 0 }),
  mzSmoke: preset({ tile: TILE_SMOKE, life: [0.5, 1.0], speed: [0.6, 2.0], spread: 0.35, size0: [0.07, 0.12], size1: [0.4, 0.75], col0: [0.75, 0.73, 0.7], col1: [0.75, 0.73, 0.7], alpha: [0.07, 0.14], drag: 3, lift: 0.35, fadeIn: 0.12, fadeOut: 0.2, rotSpeed: 1 }),
  mzGas: preset({ tile: TILE_SMOKE, life: [0.09, 0.16], speed: [2, 6], spread: 0.3, size0: [0.08, 0.12], size1: [0.3, 0.45], col0: [2.2, 1.2, 0.5], col1: [0.5, 0.45, 0.4], alpha: [0.16, 0.26], add0: 0.9, add1: 0, drag: 6, fadeIn: 0, fadeOut: 0.2, rotSpeed: 3 }),
  barrelSmoke: preset({ tile: TILE_SMOKE, life: [0.9, 1.6], speed: [0.05, 0.3], spread: 2, size0: [0.03, 0.05], size1: [0.22, 0.4], col0: [0.8, 0.79, 0.77], col1: [0.8, 0.79, 0.77], alpha: [0.1, 0.18], drag: 1.5, lift: 0.5, fadeIn: 0.15, fadeOut: 0.3, rotSpeed: 1.2 }),
  heatHaze: preset({ tile: TILE_SMOKE, life: [0.3, 0.5], speed: [0.1, 0.3], spread: 2, size0: [0.04, 0.06], size1: [0.12, 0.2], col0: [1.0, 0.98, 0.95], col1: [1.0, 0.98, 0.95], alpha: [0.05, 0.09], drag: 1, lift: 1.3, fadeIn: 0.2, fadeOut: 0.3, rotSpeed: 4 }),
  kickDust: preset({ tile: TILE_SMOKE, life: [0.8, 1.5], speed: [2.5, 6], spread: 0.15, size0: [0.25, 0.4], size1: [1.0, 1.6], col0: [0.62, 0.58, 0.52], col1: [0.62, 0.58, 0.52], alpha: [0.2, 0.32], drag: 3.5, lift: 0.3, fadeIn: 0.08, fadeOut: 0.2, rotSpeed: 0.8 }),
  // impacts
  impStar: preset({ tile: TILE_STAR_B, life: [0.04, 0.06], speed: [0, 0], size0: [0.3, 0.42], size1: [0.5, 0.65], col0: [16, 11, 5], col1: [8, 2.5, 0.4], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0 }),
  impFlash: preset({ life: [0.06, 0.09], speed: [0, 0], size0: [0.3, 0.4], size1: [0.1, 0.12], col0: [14, 9, 4], col1: [6, 2, 0.4], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0.2 }),
  impSpark: preset({ life: [0.2, 0.55], speed: [3, 12], spread: 0.72, size0: [0.022, 0.034], size1: [0.008, 0.012], col0: [12, 7, 2.6], col1: [5, 1.2, 0.1], add0: 1, add1: 1, gravity: 12, drag: 1.2, stretch: 0.03, rot: 0 }),
  metalSpark: preset({ life: [0.25, 0.8], speed: [4, 17], spread: 0.68, size0: [0.022, 0.036], size1: [0.008, 0.012], col0: [15, 12, 7], col1: [6, 1.6, 0.15], add0: 1, add1: 1, gravity: 12, drag: 0.9, stretch: 0.032, rot: 0 }),
  ricochet: preset({ life: [0.1, 0.2], speed: [28, 48], spread: 0.12, size0: [0.03, 0.04], size1: [0.012, 0.016], col0: [15, 11, 6], col1: [8, 3, 0.5], add0: 1, add1: 1, gravity: 4, drag: 1.5, stretch: 0.045, rot: 0 }),
  impDust: preset({ tile: TILE_SMOKE, life: [1.1, 2.2], speed: [1.0, 3.4], spread: 0.45, size0: [0.14, 0.24], size1: [0.9, 1.6], col0: [0.62, 0.59, 0.54], col1: [0.62, 0.59, 0.54], tint: 0.5, alpha: [0.42, 0.6], drag: 3.5, lift: 0.12, fadeIn: 0.04, fadeOut: 0.1, rotSpeed: 0.8, colVar: 0.15 }),
  impHang: preset({ tile: TILE_SMOKE, life: [2.2, 3.4], speed: [0.2, 0.6], spread: 0.6, size0: [0.25, 0.35], size1: [1.1, 1.6], col0: [0.64, 0.61, 0.56], col1: [0.64, 0.61, 0.56], tint: 0.45, alpha: [0.16, 0.24], drag: 1.5, lift: 0.05, fadeIn: 0.15, fadeOut: 0.2, rotSpeed: 0.3 }),
  impChip: preset({ tile: TILE_CHIP, life: [0.7, 1.3], speed: [2.5, 7.5], spread: 0.7, size0: [0.03, 0.085], size1: [0.03, 0.07], col0: [0.6, 0.58, 0.54], col1: [0.6, 0.58, 0.54], tint: 0.6, gravity: 14, drag: 0.6, rotSpeed: 14, fadeOut: 0.85, colVar: 0.3 }),
  metalSmoke: preset({ tile: TILE_SMOKE, life: [0.5, 1.0], speed: [0.5, 1.5], spread: 0.5, size0: [0.08, 0.12], size1: [0.45, 0.7], col0: [0.3, 0.3, 0.32], col1: [0.3, 0.3, 0.32], alpha: [0.2, 0.3], drag: 3, lift: 0.4, fadeIn: 0.08, fadeOut: 0.2, rotSpeed: 1 }),
  // headshots: the bots' visor orange, sharp and bright, nothing like the teal body hit
  hsStar: preset({ tile: TILE_STAR_A, life: [0.09, 0.13], speed: [0, 0], size0: [0.5, 0.6], size1: [0.9, 1.1], col0: [26, 10, 2.4], col1: [12, 2, 0.3], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0 }),
  hsCore: preset({ life: [0.1, 0.14], speed: [0, 0], size0: [0.5, 0.6], size1: [0.2, 0.25], col0: [22, 9, 2.5], col1: [10, 2, 0.3], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0.2 }),
  hsRing: preset({ tile: TILE_RING, life: [0.2, 0.26], speed: [0, 0], size0: [0.2, 0.25], size1: [1.3, 1.6], col0: [14, 4.5, 1.0], col1: [6, 0.8, 0.15], alpha: [0.9, 1], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0.1, rot: 0 }),
  hsRingSlow: preset({ tile: TILE_RING, life: [0.5, 0.6], speed: [0, 0], size0: [0.4, 0.5], size1: [3.6, 4.2], col0: [12, 4, 0.9], col1: [3, 0.4, 0.1], alpha: [0.8, 0.9], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0.05, rot: 0 }),
  hsShard: preset({ tile: TILE_SHARD, life: [0.35, 0.75], speed: [3, 9.5], spread: 0.8, size0: [0.09, 0.17], size1: [0.05, 0.08], col0: [14, 4.2, 1.0], col1: [3, 0.4, 0.08], add0: 1, add1: 1, gravity: 9, drag: 1.6, rotSpeed: 16, fadeIn: 0, fadeOut: 0.6, lift: 1.5 }),
  hsSpark: preset({ life: [0.2, 0.5], speed: [5, 14], spread: 1, size0: [0.03, 0.045], size1: [0.01, 0.012], col0: [16, 7, 2], col1: [6, 0.8, 0.1], add0: 1, add1: 1, gravity: 8, drag: 2.5, stretch: 0.035, rot: 0 }),
  // hits on the armoured guards (non-gory): sparks off the plate, a glancing spray along the line of fire, ceramic chips
  enSpray: preset({ life: [0.14, 0.32], speed: [5, 13], spread: 0.36, size0: [0.028, 0.045], size1: [0.01, 0.012], col0: [4, 12, 12], col1: [0.2, 2, 7], add0: 1, add1: 1, gravity: 5, drag: 3.5, stretch: 0.035, rot: 0 }),
  plateChip: preset({ tile: TILE_CHIP, life: [0.5, 0.9], speed: [2, 5.5], spread: 0.6, size0: [0.025, 0.06], size1: [0.025, 0.05], col0: [0.78, 0.76, 0.72], col1: [0.78, 0.76, 0.72], gravity: 13, drag: 0.8, rotSpeed: 14, fadeOut: 0.8, colVar: 0.25 }),
  nearDust: preset({ tile: TILE_SMOKE, life: [0.6, 1.1], speed: [1.5, 4], spread: 0.5, size0: [0.12, 0.2], size1: [0.6, 1.0], col0: [0.62, 0.59, 0.54], col1: [0.62, 0.59, 0.54], tint: 0.5, alpha: [0.3, 0.45], drag: 3.5, lift: 0.15, fadeIn: 0.04, fadeOut: 0.15, rotSpeed: 1 }),
  enFlash: preset({ life: [0.07, 0.1], speed: [0, 0], size0: [0.45, 0.6], size1: [0.15, 0.2], col0: [3, 11, 12], col1: [0.4, 3, 8], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0.2 }),
  enShard: preset({ life: [0.15, 0.4], speed: [3, 10], spread: 1, size0: [0.03, 0.05], size1: [0.01, 0.012], col0: [4, 12, 12], col1: [0.2, 2, 7], add0: 1, add1: 1, gravity: 3, drag: 4, stretch: 0.035, rot: 0 }),
  enRing: preset({ tile: TILE_RING, life: [0.16, 0.22], speed: [0, 0], size0: [0.15, 0.2], size1: [0.9, 1.2], col0: [2, 9, 10], col1: [0.2, 2, 6], alpha: [0.7, 0.9], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0.1, rot: 0 }),
  enPuff: preset({ tile: TILE_SMOKE, life: [0.6, 1.2], speed: [0.5, 2.2], spread: 2, size0: [0.3, 0.5], size1: [1.1, 1.8], col0: [0.5, 0.75, 0.8], col1: [0.4, 0.5, 0.55], alpha: [0.2, 0.32], drag: 2.5, lift: 0.5, fadeIn: 0.06, fadeOut: 0.15, rotSpeed: 1, jitter: 0.6 }),
  // explosion
  exFlash: preset({ life: [0.07, 0.1], speed: [0, 0], size0: [2.6, 3.2], size1: [6, 7], col0: [14, 9, 4], col1: [8, 3, 0.6], alpha: [0.7, 0.8], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0.1 }),
  exFire: preset({ tile: TILE_SMOKE, life: [0.55, 1.15], speed: [4, 13], spread: 2, size0: [1.2, 1.9], size1: [3.0, 4.4], col0: [10, 3.4, 0.55], col1: [0.06, 0.05, 0.045], add0: 0.85, add1: 0, alpha: [0.95, 1], drag: 3.4, lift: 1.5, fadeIn: 0.02, fadeOut: 0.5, rotSpeed: 1.6, jitter: 1.0 }),
  exCore: preset({ tile: TILE_SMOKE, life: [0.2, 0.36], speed: [1, 5], spread: 2, size0: [1.0, 1.5], size1: [2.0, 2.7], col0: [16, 10, 4], col1: [8, 2.4, 0.3], add0: 1, add1: 1, alpha: [0.9, 1], drag: 4, fadeIn: 0, fadeOut: 0.3, rotSpeed: 2, jitter: 0.5 }),
  exSmoke: preset({ tile: TILE_SMOKE, life: [3.0, 5.5], speed: [2, 7], spread: 2, size0: [1.4, 2.2], size1: [4.5, 7], col0: [0.045, 0.04, 0.038], col1: [0.15, 0.14, 0.135], alpha: [0.75, 0.9], drag: 2.2, lift: 1.5, fadeIn: 0.08, fadeOut: 0.3, rotSpeed: 0.5, jitter: 1.2, colVar: 0.25 }),
  exSpark: preset({ life: [0.5, 1.3], speed: [8, 28], spread: 0.85, size0: [0.05, 0.085], size1: [0.014, 0.018], col0: [13, 7.5, 2.6], col1: [5, 1, 0.1], add0: 1, add1: 1, gravity: 11, drag: 0.9, stretch: 0.026, rot: 0 }),
  exDebris: preset({ tile: TILE_CHIP, life: [1.0, 1.9], speed: [5, 17], spread: 0.8, size0: [0.06, 0.17], size1: [0.06, 0.14], col0: [0.2, 0.19, 0.18], col1: [0.2, 0.19, 0.18], gravity: 16, drag: 0.3, rotSpeed: 16, fadeOut: 0.85, colVar: 0.4 }),
  exRing: preset({ tile: TILE_RING, life: [0.26, 0.3], speed: [0, 0], size0: [1, 1], size1: [16, 16], col0: [3.2, 2.6, 2.0], col1: [1, 0.8, 0.7], alpha: [0.5, 0.5], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0.05, rot: 0 }),
  exGround: preset({ tile: TILE_SMOKE, life: [1.2, 2.2], speed: [5, 12], spread: 0.12, size0: [0.6, 1.0], size1: [2.4, 3.6], col0: [0.5, 0.47, 0.43], col1: [0.5, 0.47, 0.43], alpha: [0.3, 0.42], drag: 3.2, lift: 0.3, fadeIn: 0.08, fadeOut: 0.2, rotSpeed: 0.8 }),
  // destruction
  dstDust: preset({ tile: TILE_SMOKE, life: [1.6, 3.2], speed: [1.0, 3.6], spread: 2, size0: [0.5, 0.9], size1: [1.9, 3.2], col0: [0.66, 0.63, 0.58], col1: [0.66, 0.63, 0.58], tint: 0.55, alpha: [0.42, 0.6], drag: 1.8, lift: 0.25, fadeIn: 0.07, fadeOut: 0.2, rotSpeed: 0.5, colVar: 0.2 }),
  dstHaze: preset({ tile: TILE_SMOKE, life: [7, 11], speed: [0.1, 0.5], spread: 2, size0: [2.2, 3.2], size1: [5, 7], col0: [0.7, 0.67, 0.62], col1: [0.7, 0.67, 0.62], tint: 0.4, alpha: [0.14, 0.22], drag: 0.6, lift: 0.08, fadeIn: 0.15, fadeOut: 0.3, rotSpeed: 0.15 }),
  dstChip: preset({ tile: TILE_CHIP, life: [0.9, 1.6], speed: [1.5, 6], spread: 2, size0: [0.04, 0.13], size1: [0.04, 0.1], col0: [0.6, 0.58, 0.54], col1: [0.6, 0.58, 0.54], tint: 0.7, gravity: 15, drag: 0.4, rotSpeed: 12, fadeOut: 0.85, colVar: 0.35 }),
  trail: preset({ tile: TILE_SMOKE, life: [0.6, 1.1], speed: [0.1, 0.5], spread: 2, size0: [0.1, 0.14], size1: [0.45, 0.7], col0: [0.7, 0.7, 0.7], col1: [0.6, 0.6, 0.6], alpha: [0.22, 0.32], drag: 2, lift: 0.2, fadeIn: 0.05, fadeOut: 0.1, rotSpeed: 1 }),
  trailGlow: preset({ life: [0.08, 0.12], speed: [0, 0.3], size0: [0.16, 0.2], size1: [0.05, 0.06], col0: [8, 3.5, 1], col1: [4, 1, 0.2], add0: 1, add1: 1, fadeIn: 0, fadeOut: 0.2 }),
  // movement
  footDust: preset({ tile: TILE_SMOKE, life: [0.5, 0.9], speed: [0.8, 2.4], spread: 0.1, size0: [0.18, 0.26], size1: [0.7, 1.1], col0: [0.6, 0.57, 0.52], col1: [0.6, 0.57, 0.52], alpha: [0.16, 0.26], drag: 4, lift: 0.25, fadeIn: 0.1, fadeOut: 0.2, rotSpeed: 1 }),
  padStreak: preset({ life: [0.3, 0.6], speed: [8, 19], spread: 0.1, size0: [0.05, 0.07], size1: [0.02, 0.02], col0: [1.5, 9, 8.5], col1: [0.1, 2, 4], add0: 1, add1: 1, drag: 1.5, stretch: 0.03, rot: 0, jitter: 2.2 }),
  zipSpark: preset({ life: [0.15, 0.4], speed: [1, 4.5], spread: 0.8, size0: [0.02, 0.035], size1: [0.008, 0.01], col0: [12, 7, 2], col1: [5, 1.2, 0.1], add0: 1, add1: 1, gravity: 10, drag: 1, stretch: 0.03, rot: 0 }),
  spawnStreak: preset({ life: [0.35, 0.7], speed: [2, 6], spread: 0.08, size0: [0.05, 0.08], size1: [0.02, 0.02], col0: [9, 2.5, 1.2], col1: [3, 0.3, 0.2], add0: 1, add1: 1, drag: 1, stretch: 0.05, rot: 0, jitter: 1.0 }),
};

// ---- weapon classes --------------------------------------------------------------------------------------
// star = sprite size (m), spikes/sparks = counts, light = PointLight intensity, tracer [width, speed, length], kick/trauma = tiny (weapons.js owns recoil)
const CLASS = {
  rifle:   { star: 0.3, blast: 0, spikes: 3, sparks: 2, gas: 1, light: 70, range: 16, tw: 0.04, ts: 300, tl: 11, kick: 0.0012, trauma: 0, smoke: 0.45 },
  shotgun: { star: 0.5, blast: 0.75, spikes: 8, sparks: 14, gas: 3, light: 190, range: 20, tw: 0.03, ts: 250, tl: 7, kick: 0.004, trauma: 0.05, smoke: 3 },
  heavy:   { star: 0.7, blast: 0.6, spikes: 6, sparks: 6, gas: 3, light: 260, range: 24, tw: 0.065, ts: 480, tl: 22, kick: 0.005, trauma: 0.07, smoke: 3 },
  grenade: { star: 0, blast: 0.34, spikes: 0, sparks: 2, gas: 2, light: 45, range: 12, tw: 0, ts: 0, tl: 0, kick: 0.003, trauma: 0.03, smoke: 5 },
  bot:     { star: 0.34, blast: 0, spikes: 4, sparks: 2, gas: 0, light: 50, range: 14, tw: 0.034, ts: 220, tl: 9, kick: 0, trauma: 0, smoke: 0.5 },
};
const classCache = new Map();
export function weaponClass(id) {
  let c = classCache.get(id);
  if (c) return c;
  const s = String(id || '').toLowerCase();
  c = /bot|enemy|drone/.test(s) ? 'bot' : /shot|scatter|pump/.test(s) ? 'shotgun' : /grenade|launcher|rocket|\bgl\b|explos/.test(s) ? 'grenade'
    : /heavy|snip|rail|precision|marksman|cannon|dmr/.test(s) ? 'heavy' : 'rifle';
  classCache.set(id, c);
  return c;
}

export function init(ctx) {
  const { scene, camera, events, world } = ctx;
  const player = ctx.player;

  const soft = new Particles(SOFT_CAP, 10), glow = new Particles(GLOW_CAP, 11);
  soft.mesh.name = 'fx-soft'; glow.mesh.name = 'fx-glow';
  const decals = new Decals(), tracers = new Tracers();
  const root = new THREE.Group(); root.name = 'fx-root'; root.matrixAutoUpdate = false;
  root.add(decals.mesh, soft.mesh, glow.mesh, tracers.mesh);
  scene.add(root);
  const screen = createScreen(ctx);

  // ---- pooled lights (always in the scene; intensity 0 when idle) ----------------------------------------
  const lights = [];
  for (let i = 0; i < LIGHTS; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 12, 2); l.castShadow = false; l.name = 'fx-light' + i;
    scene.add(l); lights.push({ l, i0: 0, t: 0, dur: 0 });
  }
  function flashLight(x, y, z, r, g, b, intensity, range, dur) {
    let best = lights[0], bv = Infinity;
    for (let i = 0; i < LIGHTS; i++) { const L = lights[i], v = L.dur > 0 ? L.l.intensity : -1; if (v < bv) { bv = v; best = L; } }
    if (bv > intensity) return; // all busy with something brighter
    best.l.position.set(x, y, z); best.l.color.setRGB(r, g, b); best.l.distance = range;
    best.l.intensity = intensity; best.i0 = intensity; best.t = 0; best.dur = dur;
  }

  // ---- ambient dust motes: a cloud that wraps around the camera ------------------------------------------
  const moteU = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uScale: { value: 400 } };
  {
    const N = 420, pos = new Float32Array(N * 3), sd = new Float32Array(N);
    for (let i = 0; i < N; i++) { pos[i * 3] = Math.random() * 28; pos[i * 3 + 1] = Math.random() * 14; pos[i * 3 + 2] = Math.random() * 28; sd[i] = Math.random(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: moteU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float aSeed; uniform float uTime; uniform vec3 uCam; uniform float uScale; varying float vA;
        void main() {
          vec3 box = vec3(28.0, 14.0, 28.0);
          vec3 p = position + vec3(0.35, 0.05, 0.22) * uTime + 0.3 * vec3(sin(uTime * 0.5 + aSeed * 40.0), sin(uTime * 0.37 + aSeed * 23.0), cos(uTime * 0.43 + aSeed * 31.0));
          p = mod(p - uCam + box * 0.5, box) - box * 0.5;
          vec4 mv = viewMatrix * vec4(p + uCam, 1.0);
          float d = -mv.z;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp((0.018 + aSeed * 0.02) * uScale / max(d, 0.3), 1.0, 7.0);
          float edge = 1.0 - smoothstep(10.0, 14.0, max(abs(p.x), abs(p.z)));
          vA = edge * smoothstep(0.6, 2.5, d) * (0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (0.8 + aSeed * 2.0) + aSeed * 60.0)));
        }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0; float a = (1.0 - smoothstep(0.2, 1.0, r)) * vA;
          gl_FragColor = vec4(vec3(1.0, 0.86, 0.66) * 1.5 * a, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = 9; pts.name = 'fx-motes'; pts.matrixAutoUpdate = false;
    root.add(pts);
  }

  // ---- scratch -------------------------------------------------------------------------------------------
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
  const DOWN = new THREE.Vector3(0, -1, 0), qInv = new THREE.Quaternion();
  const tintC = new THREE.Color(), GREY = new THREE.Color(0.5, 0.48, 0.45);
  const lastShot = new WeakMap(); // shooter -> { t, mx,my,mz, dx,dy,dz, cls }
  let frameDust = 0, frameImpacts = 0, zipping = false, zipT = 0, slideT = 0, nearMisses = 0;

  const isMetal = (c) => !!c && (c.tag === 'container' || c.mat === world.materials.metal || (c.mat && c.mat.metalness > 0.5));
  function surfaceTint(c) {
    const m = c && (c.mat || (c.mesh && c.mesh.material));
    if (m && m.color && m.color.isColor && !(m.emissiveIntensity > 1)) tintC.copy(m.color); else tintC.copy(GREY);
    // keep dust readable on very dark / very saturated surfaces
    tintC.lerp(GREY, 0.35);
    return tintC;
  }
  const camDist = (p) => p.distanceTo(camera.position);

  // ---- environment: how much sky light reaches a point (dust under a roof must not glow in a dark room) ----
  const UP = new THREE.Vector3(0, 1, 0), v4 = new THREE.Vector3();
  let elX = 1e9, elY = 0, elZ = 0, elT = -1, elV = 1;
  function envLight(x, y, z) {
    if (ctx.time - elT < 0.3 && Math.abs(x - elX) + Math.abs(y - elY) + Math.abs(z - elZ) < 2.5) return elV;
    elX = x; elY = y; elZ = z; elT = ctx.time;
    elV = world.raycast(v4.set(x, y + 0.2, z), UP, 60) ? INDOOR_LIGHT : 1;
    return elV;
  }
  const setLight = (x, y, z) => { soft.light = glow.light = decals.light = envLight(x, y, z); };
  let camIndoor = 0, camIndoorT = 0; // 0 outdoors .. 1 under a roof (refreshed 4x / s)

  // ---- shots ---------------------------------------------------------------------------------------------
  const STARS = [P.mzStarA, P.mzStarB];
  const smokeGun = { until: 0, next: 0, x: 0, y: 0, z: 0 }; let heat = 0; // heat: recent own shots (sustained fire -> hot barrel) // lingering barrel smoke, muzzle kept in camera space
  function tracerFor(cls, C, mine, mx, my, mz, ex, ey, ez, thin) {
    if (C.tw <= 0) return;
    // no two rounds alike: width, brightness and length all wander
    const w = C.tw * (thin ? 0.8 : 1) * (0.75 + Math.random() * 0.5), b = 0.65 + Math.random() * 0.7, l = C.tl * (0.7 + Math.random() * 0.7);
    if (cls === 'bot' || (!mine && cls !== 'heavy')) tracers.add(mx, my, mz, ex, ey, ez, 11 * b, 3.2 * b, 1.0 * b, w, C.ts, l, 0.5, 0);
    else if (cls === 'heavy') {
      tracers.add(mx, my, mz, ex, ey, ez, 9, 11, 15, w, C.ts, l, mine ? 6 : 4, 0, mine ? 1.8 : 5);
      tracers.add(mx, my, mz, ex, ey, ez, 0.9, 1.8, 2.8, 0.06, 0, 0, 0, 0.5); // lingering wake
    } else tracers.add(mx, my, mz, ex, ey, ez, 14 * b, 8.5 * b, 3 * b, w, C.ts * (0.9 + Math.random() * 0.2), l, mine ? 5 + Math.random() * 3 : 0.5, 0, mine ? 1.8 : 5);
  }

  events.on('shot', (e) => {
    const cls = weaponClass(e.weapon), C = CLASS[cls], mine = e.by === player;
    const m = e.muzzle || e.origin, d = e.dir;
    if (!m || !d) return;
    const far = mine ? 0 : camDist(m);
    const bot = cls === 'bot' || !mine;
    const ads = mine && ctx.weapons && ctx.weapons.state ? ctx.weapons.state.ads || 0 : 0;
    // first person: smaller when aiming so the sight picture survives; indoors the eye is dark-adapted, so dim it
    // through a magnifying scope the flash would fill the lens: nearly remove it there
    const scoped = mine && ads > 0.5 && player.fovScale < 0.6;
    const vis = mine ? (scoped ? 0.1 : (1 - 0.45 * ads) * (1 - 0.3 * camIndoor)) : 1;
    const s = (mine ? (scoped ? 0.35 : 0.85 - 0.3 * ads) : 1 + Math.min(1.5, far * 0.022)) * (0.82 + Math.random() * 0.36);
    const fx_ = m.x + d.x * 0.06, fy_ = m.y + d.y * 0.06, fz_ = m.z + d.z * 0.06;
    setLight(m.x, m.y, m.z);
    let n = 0;
    if (!scoped) {
    if (C.star > 0) { glow.burst(STARS[(Math.random() * 2) | 0], 1, fx_, fy_, fz_, d.x, d.y, d.z, (C.star / 0.34) * s); n++; }
    if (C.blast > 0) { glow.burst(P.mzBlast, 1, fx_ + d.x * 0.1, fy_ + d.y * 0.1, fz_ + d.z * 0.1, d.x, d.y, d.z, (C.blast / 0.35) * s); n++; }
    glow.burst(P.mzCore, 1, fx_, fy_, fz_, d.x, d.y, d.z, Math.min(1.15, 0.6 + C.star * 1.2) * s); n++;
    if (C.spikes) { glow.burst(P.mzSpike, C.spikes, m.x, m.y, m.z, d.x, d.y, d.z, s, null, -1e4, 0.75 + 0.5 * C.star); n += C.spikes; }
    if (cls === 'heavy') { // muzzle brake: two sideways jets
      v1.set(-d.z, 0, d.x).normalize();
      glow.burst(P.mzJet, 4, m.x, m.y, m.z, v1.x, 0.12, v1.z, s); glow.burst(P.mzJet, 4, m.x, m.y, m.z, -v1.x, 0.12, -v1.z, s); n += 8;
    }
    }
    // big flashes overlap several additive layers: pull each one down so the sum keeps its colour and shape
    const keep = Math.min(1, Math.max(0.4, 0.42 / (C.star + C.blast * 0.6 + 0.001))) * vis;
    if (bot) glow.tweak(n, 1, 0.42, 0.4, 1);            // enemy fire reads red-hot
    else if (keep < 0.999) glow.tweak(n, keep, keep * 0.92, keep * 0.8, 1);
    if (far < 60 && C.sparks && !scoped) glow.burst(P.mzSpark, Math.max(1, Math.round(C.sparks * (0.6 + Math.random() * 0.8))), m.x, m.y, m.z, d.x, d.y, d.z, 1, null, -1e4, 0.8 + C.blast);
    if (far < 50 && C.gas && !scoped) glow.burst(P.mzGas, C.gas, fx_, fy_, fz_, d.x, d.y, d.z, 0.8 + C.star + C.blast, null, -1e4, 1);
    if (far < 40 && !scoped && Math.random() < C.smoke) soft.burst(P.mzSmoke, Math.max(1, Math.round(C.smoke)), m.x + d.x * 0.15, m.y + d.y * 0.15, m.z + d.z * 0.15, d.x, d.y, d.z, 0.9 + C.blast + C.star * 0.6, null, -1e4, 1 + C.blast);
    if (cls === 'heavy' && far < 40) { // side smoke from the brake + dust kicked off the ground under the muzzle
      v1.set(-d.z, 0, d.x).normalize();
      soft.burst(P.mzSmoke, 2, m.x, m.y, m.z, v1.x, 0.1, v1.z, 1.6, null, -1e4, 2.2); soft.burst(P.mzSmoke, 2, m.x, m.y, m.z, -v1.x, 0.1, -v1.z, 1.6, null, -1e4, 2.2);
      const g = world.raycast(m, DOWN, 2.2);
      if (g) { const gy = g.point.y + 0.12, a0 = Math.random() * 6.28; for (let i = 0; i < 7; i++) { const a = a0 + i * 0.9; soft.burst(P.kickDust, 1, m.x + d.x * 0.5, gy, m.z + d.z * 0.5, Math.cos(a) + d.x * 0.8, 0.08, Math.sin(a) + d.z * 0.8, 1, null, -1e4, 1.2 - g.dist * 0.3); } }
    }
    if (mine) heat = Math.min(14, heat + (cls === 'rifle' ? 1 : 3));
    if (mine && (cls === 'heavy' || cls === 'shotgun' || cls === 'grenade' || heat > 7 || Math.random() < 0.2)) { // barrel keeps smoking for a moment
      smokeGun.until = ctx.time + (cls === 'rifle' ? (heat > 7 ? 1.3 : 0.5) : 1.5); smokeGun.next = ctx.time + 0.08;
      v2.copy(m).sub(camera.position).applyQuaternion(qInv.copy(camera.quaternion).invert());
      smokeGun.x = v2.x; smokeGun.y = v2.y; smokeGun.z = v2.z;
    }
    let li = C.light * (0.8 + Math.random() * 0.4);
    if (camIndoor > 0.5 && li > 95) li = 95 + li * 0.1; // dark-adapted rooms: a big gun must light the room, not white it out
    if (bot) flashLight(m.x + d.x * 0.3, m.y + d.y * 0.3, m.z + d.z * 0.3, 1, 0.35, 0.2, li, C.range, 0.07);
    else flashLight(m.x + d.x * 0.35, m.y + d.y * 0.35 + 0.05, m.z + d.z * 0.35, 1, 0.7, 0.38, li, C.range, 0.075);

    // tracers along the real lines of fire
    let rec = e.by && lastShot.get(e.by);
    if (e.by && !rec) { rec = { t: -1, mx: 0, my: 0, mz: 0, dx: 0, dy: 0, dz: 0, cls }; lastShot.set(e.by, rec); }
    if (rec) { rec.t = ctx.time; rec.mx = m.x; rec.my = m.y; rec.mz = m.z; rec.dx = d.x; rec.dy = d.y; rec.dz = d.z; rec.cls = cls; rec.pellets = !(e.dirs && e.dirs.length); }
    if (C.tw > 0 && !e.projectile) {
      const o = e.origin || m, dirs = e.dirs && e.dirs.length ? e.dirs : null, nd = dirs ? Math.min(dirs.length, 16) : 1;
      for (let i = 0; i < nd; i++) {
        const dd = dirs ? dirs[i] : d;
        if (nd === 1 && e.end) v1.copy(e.end);
        else { const hit = ctx.hitscan ? ctx.hitscan(o, dd, 400, e.by) : world.raycast(o, dd, 400); if (hit) v1.copy(hit.point); else v1.copy(o).addScaledVector(dd, 400); }
        if (v1.distanceToSquared(m) > 9) tracerFor(cls, C, mine, m.x, m.y, m.z, v1.x, v1.y, v1.z, nd > 1);
      }
    }
    if (mine) {
      screen.kick(C.kick * (0.85 + Math.random() * 0.3), (Math.random() - 0.5) * C.kick * 0.7, (Math.random() - 0.5) * C.kick * 0.9);
      if (C.trauma > 0) screen.addTrauma(C.trauma, 0.12 + C.trauma);
    } else if (player.alive) { // a round cracking past the head: the edges of the view close in for a moment
      const miss = nearMiss(e, camera.position, world, v2);
      if (miss >= 0) { nearMisses++; screen.suppress(1 - miss / NEAR_MISS); events.emit('nearMiss', { dist: miss, point: v2.clone(), by: e.by }); }
    }
  });

  // ---- grenade trails: follow live projectiles while their mesh is in the scene --------------------------
  const trails = [null, null, null, null, null, null, null, null], trailT = new Float32Array(8);
  events.on('projectile', (e) => {
    const pr = e.projectile; if (!pr || !pr.pos) return;
    for (let i = 0; i < trails.length; i++) if (!trails[i]) { trails[i] = pr; trailT[i] = ctx.time; return; }
  });
  events.on('grenadeBounce', (e) => {
    const p = e.point; if (!p || camDist(p) > 50) return;
    const n = e.normal || v3.set(0, 1, 0);
    soft.burst(P.impDust, 1, p.x, p.y + 0.03, p.z, n.x, n.y, n.z, 0.7, null, -1e4, 0.5);
    glow.burst(P.impSpark, 2, p.x, p.y + 0.03, p.z, n.x, n.y, n.z, 1, null, -1e4, 0.5);
  });

  // ---- impacts -------------------------------------------------------------------------------------------
  events.on('impact', (e) => {
    const p = e.point; if (!p) return;
    const n = e.normal || v3.set(0, 1, 0);
    const rec = e.by && lastShot.get(e.by);
    // weapons that don't list their pellets: infer extra tracers from impacts
    if (rec && rec.pellets && ctx.time - rec.t < 0.03) {
      v1.set(p.x - rec.mx, p.y - rec.my, p.z - rec.mz);
      const len = v1.length();
      if (len > 2 && (v1.x * rec.dx + v1.y * rec.dy + v1.z * rec.dz) / len < 0.99996)
        tracerFor(rec.cls, CLASS[rec.cls], e.by === player, rec.mx, rec.my, rec.mz, p.x, p.y, p.z, true);
    }
    const dist = camDist(p);
    frameImpacts++;
    const lod = dist > 80 || frameImpacts > 24 ? 0.4 : dist > 45 || frameImpacts > 12 ? 0.7 : 1;
    const dmg = e.damage > 0 ? e.damage : 20;
    const s = Math.min(2.2, Math.max(0.75, Math.sqrt(dmg / 22)));
    const px = p.x + n.x * 0.03, py = p.y + n.y * 0.03, pz = p.z + n.z * 0.03;
    if (e.kind === 'flesh') {
      if (e.target === player) return; // the player's own pain is screen-space (vignette), see playerDamaged
      const shotFresh = rec && ctx.time - rec.t < 0.05;
      if (e.headshot) {
        // a compact visor-orange pop: one small star, a hot core and a few sparks. Restrained on purpose -
        // the hitmarker, the damage number and the sound already say "headshot"; this must not hide the target.
        const ds = Math.min(3, Math.max(1, dist * 0.09));
        glow.burst(P.hsStar, 1, px, py, pz, n.x, n.y, n.z, ds * 0.8);
        glow.burst(P.hsCore, 1, px, py, pz, n.x, n.y, n.z, ds * 0.55);
        glow.burst(P.hsSpark, Math.round(7 * lod), px, py, pz, n.x, n.y, n.z, 0.6 + ds * 0.3, null, -1e4, 0.6 + ds * 0.3);
        glow.burst(P.hsShard, 4, px, py, pz, n.x, n.y + 0.4, n.z, 0.5 + ds * 0.25, null, -1e4, 0.6 + ds * 0.3);
        flashLight(px + n.x * 0.3, py + n.y * 0.3, pz + n.z * 0.3, 1, 0.42, 0.12, 40, 7, 0.08);
        return;
      }
      const bs = s * Math.min(3, Math.max(1, dist * 0.09));
      glow.burst(P.enFlash, 1, px, py, pz, n.x, n.y, n.z, bs * 0.7);
      // sparks back off the plate toward the shooter ...
      glow.burst(P.enShard, Math.round(5 * lod * s), px, py, pz, n.x, n.y, n.z, 0.6 + bs * 0.3, null, -1e4, 0.6 + bs * 0.3);
      // ... and a tighter spray glancing off along the line of fire, so the hit shows which way the round was going
      if (shotFresh) {
        const dn = rec.dx * n.x + rec.dy * n.y + rec.dz * n.z;
        glow.burst(P.enSpray, Math.round(6 * lod * s), px, py, pz, n.x * 0.55 + (rec.dx - dn * n.x), n.y * 0.55 + (rec.dy - dn * n.y) + 0.15, n.z * 0.55 + (rec.dz - dn * n.z), 0.6 + bs * 0.3, null, -1e4, 0.7 + bs * 0.3);
      }
      if (dist < 35 && lod >= 0.7) { setLight(px, py, pz); soft.burst(P.plateChip, 3, px, py, pz, n.x, n.y, n.z, 1 + bs * 0.2); }
      return;
    }
    const c = e.collider, metal = isMetal(c);
    setLight(px, py, pz);
    const fs = s * (1 + Math.min(2.6, dist * 0.06)); // far hits keep a visible flash at the point of aim
    glow.burst(P.impStar, 1, px, py, pz, n.x, n.y, n.z, fs * (0.8 + Math.random() * 0.4));
    glow.burst(P.impFlash, 1, px, py, pz, n.x, n.y, n.z, fs);
    if (metal) {
      glow.burst(P.metalSpark, Math.round(14 * lod * s), px, py, pz, n.x, n.y, n.z, 1, null, -1e4, s);
      soft.burst(P.metalSmoke, lod < 1 ? 1 : 2, px, py, pz, n.x, n.y, n.z, s);
      if (Math.random() < 0.38) { // ricochet: a few long streaks along the mirrored line of fire
        let rx = n.x, ry = n.y, rz = n.z;
        if (rec && ctx.time - rec.t < 0.05) { const dn = rec.dx * n.x + rec.dy * n.y + rec.dz * n.z; rx = rec.dx - 2 * dn * n.x; ry = rec.dy - 2 * dn * n.y; rz = rec.dz - 2 * dn * n.z; }
        glow.burst(P.ricochet, 1 + ((Math.random() * 2.2) | 0), px, py, pz, rx + n.x * 0.25, ry + n.y * 0.25, rz + n.z * 0.25, s);
      }
    } else {
      const t = surfaceTint(c);
      glow.burst(P.impSpark, Math.round(6 * lod * s), px, py, pz, n.x, n.y, n.z, 1, null, -1e4, s);
      const far = 1 + Math.min(1.1, Math.max(0, dist - 8) * 0.035); // dust and chips grow with range so the hit still reads at 40 m
      soft.burst(P.impDust, lod < 1 ? 3 : 4, px, py, pz, n.x, n.y, n.z, s * far, t, -1e4, s * far);
      if (lod >= 0.7) {
        soft.burst(P.impHang, 1, px + n.x * 0.15, py + n.y * 0.15, pz + n.z * 0.15, n.x, n.y, n.z, s, t, -1e4, 1);
        soft.burst(P.impChip, Math.round(8 * s), px, py, pz, n.x, n.y, n.z, s * far, t, 0, 1);
      }
    }
    if (e.by !== player && e.by && dist < 4 && player.alive) { // an enemy round landing right beside you: grit in the face
      const k = 1 - dist / 4; nearMisses++;
      v1.copy(camera.position).sub(p).normalize();
      soft.burst(P.nearDust, 3, px, py, pz, n.x * 0.6 + v1.x * 0.5, n.y * 0.6 + v1.y * 0.5 + 0.2, n.z * 0.6 + v1.z * 0.5, 1, surfaceTint(c), -1e4, 1);
      screen.suppress(0.6 * k);
    }
    if (c && e.normal) {
      const half = (metal ? 0.085 : 0.115) * (0.8 + 0.4 * Math.random()) * Math.sqrt(s);
      if (metal) decals.add(DECAL_METAL, p.x, p.y, p.z, n.x, n.y, n.z, half, 60, 1, c);
      else { const t = surfaceTint(c); decals.add(DECAL_CONCRETE, p.x, p.y, p.z, n.x, n.y, n.z, half * 1.25, 60, 1, c, t.r, t.g, t.b); }
    }
  });

  // ---- explosions ----------------------------------------------------------------------------------------
  events.on('explosion', (e) => {
    const p = e.point; if (!p) return;
    const R = e.radius > 0 ? e.radius : 5, s = R / 5, dist = camDist(p);
    const lod = dist > 90 ? 0.5 : 1;
    const hit = world.raycast(v1.set(p.x, p.y + 0.3, p.z), DOWN, R + 0.5);
    const floorY = hit ? hit.point.y : -1e4, nearGround = hit && hit.dist < R * 0.6;
    const cy = p.y + 0.25 * s;
    setLight(p.x, cy + 0.5, p.z);
    glow.burst(P.exFlash, 1, p.x, cy, p.z, 0, 1, 0, s);
    glow.burst(P.exCore, Math.round(5 * lod), p.x, cy, p.z, 0, 1, 0, s, null, -1e4, s);
    glow.burst(P.exFire, Math.round(18 * lod), p.x, cy, p.z, 0, 1, 0, s, null, -1e4, s);
    soft.burst(P.exSmoke, Math.round(16 * lod), p.x, cy + 0.3 * s, p.z, 0, 1, 0, s, null, -1e4, s);
    glow.burst(P.exSpark, Math.round(34 * lod), p.x, cy, p.z, 0, 1, 0, s, null, floorY + 0.02, Math.sqrt(s));
    soft.burst(P.exDebris, Math.round(18 * lod), p.x, cy, p.z, 0, 1, 0, s, null, floorY + 0.03, Math.sqrt(s));
    glow.burst(P.exRing, 1, p.x, cy, p.z, 0, 1, 0, s);
    if (nearGround) {
      const gy = floorY + 0.35 * s, n = Math.round(12 * lod), a0 = Math.random() * 6.28;
      for (let i = 0; i < n; i++) { const a = a0 + (i / n) * 6.2832; soft.burst(P.exGround, 1, p.x, gy, p.z, Math.cos(a), 0.06, Math.sin(a), s, null, -1e4, s); }
      decals.ring(p.x, floorY + 0.03, p.z, 0, 1, 0, R * 2.1, 0.42, 3.5, 2.6, 1.8, 1);
      decals.add(DECAL_SCORCH, hit.point.x, hit.point.y, hit.point.z, 0, 1, 0, R * (0.62 + Math.random() * 0.14), 75, 1, hit.collider);
    }
    flashLight(p.x, cy + 0.6, p.z, 1, 0.62, 0.3, 2600 * s * s, R * 6, 0.55);
    // screen feedback by distance
    const prox = Math.max(0, 1 - dist / (R * 3.2));
    screen.addTrauma(prox * 0.95 + Math.max(0, 0.22 * (1 - dist / 90)), 1);
    if (prox > 0.05) {
      screen.kick((Math.random() - 0.3) * 0.03 * prox, (Math.random() - 0.5) * 0.04 * prox, (Math.random() - 0.5) * 0.06 * prox);
      v2.copy(camera.position);
      const los = world.lineOfSight(v1.set(p.x, cy + 0.2, p.z), v2);
      screen.flash(prox * prox * (los ? 0.85 : 0.25));
      if (prox > 0.45) screen.blur((prox - 0.45) * (los ? 1.8 : 0.9));
    }
  });

  // ---- destruction ---------------------------------------------------------------------------------------
  events.on('pieceDamaged', (e) => {
    const p = e.point; if (!p || camDist(p) > 80) return;
    const n = e.normal || v3.set(0, 1, 0);
    if (frameDust > 40) return; frameDust += 4;
    const t = surfaceTint(e.collider); setLight(p.x, p.y, p.z);
    soft.burst(P.impDust, 2, p.x + n.x * 0.05, p.y + n.y * 0.05, p.z + n.z * 0.05, n.x, n.y, n.z, 1.5, t, -1e4, 0.8);
    soft.burst(P.impChip, 3, p.x + n.x * 0.05, p.y + n.y * 0.05, p.z + n.z * 0.05, n.x, n.y, n.z, 1.4, t, 0, 0.7);
  });

  events.on('pieceDestroyed', (e) => {
    const c = e.collider;
    if (c) decals.dropCollider(c);
    let cx, cy, cz, sx, sy, sz;
    if (e.center) { cx = e.center.x; cy = e.center.y; cz = e.center.z; }
    else if (c && c.min) { cx = (c.min.x + c.max.x) / 2; cy = (c.min.y + c.max.y) / 2; cz = (c.min.z + c.max.z) / 2; } else return;
    const sz0 = e.size;
    if (typeof sz0 === 'number') sx = sy = sz = sz0;
    else if (sz0 && sz0.x !== undefined) { sx = sz0.x; sy = sz0.y; sz = sz0.z; }
    else if (c && c.min) { sx = c.max.x - c.min.x; sy = c.max.y - c.min.y; sz = c.max.z - c.min.z; } else sx = sy = sz = 1;
    const dist = Math.hypot(cx - camera.position.x, cy - camera.position.y, cz - camera.position.z);
    const big = Math.max(sx, sy, sz), vol = sx * sy * sz, area = (sx * sy + sy * sz + sx * sz) * 2 / 3;
    // budget: a collapsing building destroys dozens of pieces in one frame
    const load = 1 / (1 + frameDust * 0.03);
    let n = Math.round(Math.min(16, 2 + area * 0.9) * load * (dist > 70 ? 0.5 : 1));
    if (n < 1) n = frameDust < 400 ? 1 : 0;
    frameDust += n;
    if (e.color && e.color.isColor) tintC.copy(e.color).lerp(GREY, 0.3); else surfaceTint(c);
    const scale = Math.min(2.4, 0.55 + Math.cbrt(vol) * 0.42);
    setLight(cx, cy, cz);
    const cp = e.cause && e.cause.point;
    let ox = 0, oy = 0, oz = 0;
    if (cp) { ox = cx - cp.x; oy = cy - cp.y; oz = cz - cp.z; const l = Math.hypot(ox, oy, oz) || 1; ox = (ox / l) * 1.6; oy = (oy / l) * 0.8; oz = (oz / l) * 1.6; }
    for (let i = 0; i < n; i++) {
      const x = cx + (Math.random() - 0.5) * sx, y = cy + (Math.random() - 0.5) * sy, z = cz + (Math.random() - 0.5) * sz;
      soft.burst(P.dstDust, 1, x, y, z, 0, 1, 0, scale, tintC, -1e4, 0.7 + big * 0.12, ox, oy, oz);
    }
    if (n > 0 && dist < 90) {
      const chips = Math.round(Math.min(14, 3 + area) * load);
      for (let i = 0; i < chips; i++) {
        const x = cx + (Math.random() - 0.5) * sx, y = cy + (Math.random() - 0.5) * sy, z = cz + (Math.random() - 0.5) * sz;
        soft.burst(P.dstChip, 1, x, y, z, 0, 1, 0, 0.8 + scale * 0.5, tintC, 0.02, 1, ox * 1.5, oy * 1.5 + 1, oz * 1.5);
      }
      if (big > 1.5 && load > 0.3) soft.burst(P.dstHaze, big > 3 ? 2 : 1, cx, cy, cz, 0, 1, 0, Math.min(1.6, 0.5 + big * 0.22), tintC, -1e4, 1);
      if (isMetal(c)) glow.burst(P.metalSpark, Math.round(10 * load), cx, cy, cz, 0, 1, 0, 1.3, null, 0.02, 1);
    }
    if (dist < 14 && big > 2) screen.addTrauma(0.25 * (1 - dist / 14) * Math.min(1, big / 4), 0.45);
  });

  // ---- bots ----------------------------------------------------------------------------------------------
  events.on('botDied', (e) => {
    const b = e.bot, p = e.point || (b && b.pos && v1.copy(b.pos).setY(b.pos.y + (b.height || 1.8) * 0.55));
    if (!p) return;
    const rec = e.by && lastShot.get(e.by), fresh = rec && ctx.time - rec.t < 0.1;
    if (e.headshot) {
      // headshot kill: the same compact orange pop as a headshot, one quick ring and a handful of visor shards
      const hy = b && b.pos ? b.pos.y + (b.height || 1.8) * 0.92 : p.y + 0.65, hx = b && b.pos ? b.pos.x : p.x, hz = b && b.pos ? b.pos.z : p.z;
      const ds = Math.min(3, Math.max(1, Math.hypot(hx - camera.position.x, hy - camera.position.y, hz - camera.position.z) * 0.09));
      glow.burst(P.hsStar, 1, hx, hy, hz, 0, 1, 0, 1.1 * ds);
      glow.burst(P.hsCore, 1, hx, hy, hz, 0, 1, 0, 0.7 * ds);
      glow.burst(P.hsRing, 1, hx, hy, hz, 0, 1, 0, 0.6 * ds);
      glow.burst(P.hsShard, 9, hx, hy, hz, 0, 1, 0, 0.5 + ds * 0.3, null, -1e4, 0.7 + ds * 0.3);
      glow.burst(P.hsSpark, 9, hx, hy, hz, 0, 1, 0, 0.6 + ds * 0.3, null, -1e4, 0.7 + ds * 0.3);
      if (fresh) glow.burst(P.hsSpark, 6, hx, hy, hz, rec.dx, rec.dy + 0.2, rec.dz, 0.6 + ds * 0.3, null, -1e4, 1.2); // carried on along the shot
      setLight(hx, hy, hz); soft.burst(P.enPuff, 2, p.x, p.y, p.z, 0, 1, 0, 0.7); soft.tweak(2, 1.3, 0.9, 0.7, 1);
      flashLight(hx, hy + 0.2, hz, 1, 0.45, 0.14, 150, 10, 0.2);
      return;
    }
    // body kill: the core lets go - a short teal flash, one ring, sparks thrown the way the killing round was going
    const ks = Math.min(2.2, Math.max(1, camDist(p) * 0.07));
    glow.burst(P.enFlash, 1, p.x, p.y, p.z, 0, 1, 0, 1.3 * ks);
    glow.burst(P.enRing, 1, p.x, p.y, p.z, 0, 1, 0, 1.2 * ks);
    glow.burst(P.enShard, 12, p.x, p.y, p.z, 0, 1, 0, 1.1, null, -1e4, 1.2);
    if (fresh) glow.burst(P.enSpray, 10, p.x, p.y, p.z, rec.dx, rec.dy + 0.2, rec.dz, 1.1, null, -1e4, 1.1);
    setLight(p.x, p.y, p.z); soft.burst(P.enPuff, 3, p.x, p.y, p.z, 0, 1, 0, 0.8);
    flashLight(p.x, p.y, p.z, 0.3, 0.9, 1, 110, 9, 0.18);
  });
  events.on('botSpawned', (e) => {
    const b = e.bot; if (!b || !b.pos) return;
    const p = b.pos;
    glow.burst(P.spawnStreak, 22, p.x, p.y + 0.9, p.z, 0, 1, 0, 1);
    decals.ring(p.x, p.y + 0.04, p.z, 0, 1, 0, 1.8, 0.5, 4, 1.0, 0.5, 1);
  });

  // ---- player ---------------------------------------------------------------------------------------------
  events.on('playerDamaged', (e) => screen.damage(e.amount || 10, e.from));
  events.on('playerDied', () => { screen.died(); screen.addTrauma(0.6, 1); });
  events.on('playerRespawned', () => { screen.respawned(); screen.flash(0.35); });
  events.on('land', (e) => {
    const sp = e.speed || 0; if (sp < 4) return;
    const k = Math.min(1, (sp - 4) / 14), pp = player.pos, n = 4 + Math.round(k * 8), a0 = Math.random() * 6.28;
    for (let i = 0; i < n; i++) { const a = a0 + (i / n) * 6.2832; soft.burst(P.footDust, 1, pp.x + Math.cos(a) * 0.3, pp.y + 0.12, pp.z + Math.sin(a) * 0.3, Math.cos(a), 0.05, Math.sin(a), 0.8 + k, null, -1e4, 0.8 + k * 1.6); }
    screen.addTrauma(0.1 + k * 0.4, 0.6);
    screen.kick(-0.004 - k * 0.02, 0, (Math.random() - 0.5) * 0.01 * k);
  });
  events.on('jump', () => { const pp = player.pos; soft.burst(P.footDust, 2, pp.x, pp.y + 0.08, pp.z, 0, 1, 0, 0.7, null, -1e4, 0.5); });
  events.on('footstep', (e) => {
    if ((e.speed || 0) < 7) return;
    const pp = player.pos; soft.burst(P.footDust, 1, pp.x, pp.y + 0.06, pp.z, -player.vel.x * 0.1, 0.4, -player.vel.z * 0.1, 0.6, null, -1e4, 0.5);
  });
  events.on('slideStart', () => {
    const pp = player.pos; soft.burst(P.footDust, 5, pp.x, pp.y + 0.1, pp.z, 0, 1, 0, 1.1, null, -1e4, 1); slideT = 0;
    screen.kick(-0.006, 0, 0);
  });
  events.on('mantle', () => { const pp = player.pos; soft.burst(P.footDust, 2, pp.x, pp.y + 1.0, pp.z, 0, 1, 0, 0.8, null, -1e4, 0.5); screen.kick(0.006, 0, 0.004); });
  events.on('pad', (e) => {
    let y = 0;
    for (const pd of world.pads || []) if (Math.abs(pd.x - e.x) < 0.1 && Math.abs(pd.z - e.z) < 0.1) y = pd.y || 0;
    glow.burst(P.padStreak, 26, e.x, y + 0.6, e.z, 0, 1, 0, 1);
    decals.ring(e.x, y + 0.22, e.z, 0, 1, 0, 3.4, 0.45, 0.6, 4.5, 4.2, 1);
    decals.ring(e.x, y + 0.24, e.z, 0, 1, 0, 2.0, 0.3, 0.8, 5, 4.6, 1);
    flashLight(e.x, y + 1, e.z, 0.25, 1, 0.95, 160, 12, 0.3);
    screen.addTrauma(0.22, 0.5); screen.kick(-0.015, 0, 0);
  });
  events.on('zipStart', () => { zipping = true; zipT = 0; const pp = player.pos; glow.burst(P.zipSpark, 14, pp.x, pp.y + 2.15, pp.z, 0, -1, 0, 1.2); });
  events.on('zipEnd', () => { zipping = false; const pp = player.pos; glow.burst(P.zipSpark, 8, pp.x, pp.y + 2.15, pp.z, 0, -1, 0, 1); });

  // ---- per-frame -----------------------------------------------------------------------------------------
  const lightCol = new THREE.Vector3(1.25, 1.14, 1.0);
  const api = {
    soft, glow, decals, tracers, screen, lights, weaponClass, flashLight,
    stats() { return { soft: soft.spawned, glow: glow.spawned, decals: decals.countLive(), drawCalls: 5, lights: LIGHTS, nearMisses, suppress: screen.state.sup }; },
    update(dt) {
      const t = ctx.time;
      soft.setTime(t); glow.setTime(t); decals.setTime(t); tracers.setTime(t);
      const fog = scene.fog;
      const dens = (fog ? (fog.isFogExp2 ? fog.density : fog.far ? 1.2 / fog.far : 0) : 0) * Math.exp(-FOG_FALLOFF * Math.max(0, camera.position.y));
      soft.uniforms.uFogDensity.value = glow.uniforms.uFogDensity.value = decals.uniforms.uFogDensity.value = tracers.uniforms.uFogDensity.value = dens;
      if (fog) { soft.uniforms.uFogColor.value.copy(fog.color); glow.uniforms.uFogColor.value.copy(fog.color); decals.uniforms.uFogColor.value.copy(fog.color); }
      soft.uniforms.uLight.value.copy(lightCol); glow.uniforms.uLight.value.copy(lightCol); decals.uniforms.uLight.value.copy(lightCol);
      moteU.uTime.value = t; moteU.uCam.value.copy(camera.position);
      moteU.uScale.value = ctx.renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));

      for (let i = 0; i < LIGHTS; i++) {
        const L = lights[i]; if (L.dur <= 0) continue;
        L.t += dt; const k = 1 - L.t / L.dur;
        if (k <= 0) { L.dur = 0; L.l.intensity = 0; } else L.l.intensity = L.i0 * k * k;
      }

      heat = Math.max(0, heat - dt * 3);
      camIndoorT -= dt;
      if (camIndoorT <= 0) { camIndoorT = 0.25; camIndoor = world.raycast(camera.position, UP, 60) ? 1 : 0; }
      if (t < smokeGun.until && t >= smokeGun.next) {
        smokeGun.next = t + 0.06;
        v2.set(smokeGun.x, smokeGun.y, smokeGun.z).applyQuaternion(camera.quaternion).add(camera.position);
        soft.light = envLight(v2.x, v2.y, v2.z);
        soft.burst(P.barrelSmoke, 1, v2.x, v2.y, v2.z, 0, 1, 0, 1, null, -1e4, 1, player.vel.x * 0.5, 0, player.vel.z * 0.5);
        if (heat > 5) soft.burst(P.heatHaze, 1, v2.x, v2.y + 0.02, v2.z, 0, 1, 0, 1, null, -1e4, 1, player.vel.x * 0.5, 0, player.vel.z * 0.5); // hot barrel shimmer
      }
      // continuous movement effects
      for (let i = 0; i < trails.length; i++) {
        const pr = trails[i]; if (!pr) continue;
        if ((pr.mesh && !pr.mesh.parent) || pr.dead || pr.exploded || t - trailT[i] > 8) { trails[i] = null; continue; }
        const pp = pr.pos;
        soft.burst(P.trail, 1, pp.x, pp.y, pp.z, 0, 1, 0, 1, null, -1e4, 1);
        glow.burst(P.trailGlow, 1, pp.x, pp.y, pp.z, 0, 1, 0, 1, null, -1e4, 1);
      }
      if (zipping && player.state === 'zip') {
        zipT -= dt;
        if (zipT <= 0) { zipT = 0.035; const pp = player.pos, vv = player.vel; glow.burst(P.zipSpark, 2, pp.x, pp.y + 2.15, pp.z, 0, -0.5, 0, 1, null, -1e4, 1, vv.x * 0.6, vv.y * 0.6, vv.z * 0.6); }
      } else zipping = false;
      if (player.sliding && player.grounded) {
        slideT -= dt;
        if (slideT <= 0) {
          slideT = 0.045; const pp = player.pos, vv = player.vel, hs = Math.hypot(vv.x, vv.z);
          if (hs > 3) soft.burst(P.footDust, 1, pp.x - vv.x * 0.04, pp.y + 0.08, pp.z - vv.z * 0.04, 0, 1, 0, 0.9, null, -1e4, 0.5, vv.x * 0.25, 0, vv.z * 0.25);
        }
      }
      frameDust = 0; frameImpacts = 0;
      soft.light = glow.light = decals.light = envLight(player.pos.x, player.pos.y + 1, player.pos.z); // default for movement dust next frame
      screen.update(dt);
    },
  };
  ctx.fx = api;
  return api;
}
