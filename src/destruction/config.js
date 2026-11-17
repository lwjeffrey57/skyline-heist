// All destruction tuning lives here. Exposed at runtime as ctx.destruction.config (mutable).
export const CONFIG = {
  // Health of one "cell" (~1 m2 of a piece) by tag. A leaf piece gets health * clamp(sqrt(faceArea), 0.5, 1.6).
  // Tuned for the shipped weapons: rifle 22/bullet (30 rounds), shotgun 10x13, sniper 92, launcher explode(6.5, 150), frag explode(8, 220):
  // ~13 rifle bullets on one spot punch a 0.8 m hole in a wall, a magazine chews through one sill, a launcher grenade
  // at a wall base opens a ~4 m walk-through hole, the frag roughly 7 m.
  health: { wall: 340, pillar: 420, lintel: 260, sill: 190, slab: 380, stair: 300, parapet: 220, cover: 380, default: 320 },
  bulletScale: 1.0,      // multiplier on hit() damage
  explosionScale: 3.8,   // multiplier on explode() damage versus structure (blasts wreck concrete far better than bullets)
  falloffExp: 2.0,       // blast damage = D * (1 - d/r)^falloffExp
  bulletCell: 0.8,       // size (m) of the hole a bullet-broken cell leaves in a large piece
  blastCell: 1.0,        // finest subdivision used around the edge of a blast hole
  minSliver: 0.45,       // never cut pieces thinner than this
  carveFactor: 0.8,      // local damage needed to punch a cell out of a large piece = health[tag] * carveFactor
  clusterRadius: 0.55,   // hits closer than this accumulate into the same damage spot
  maxClusters: 6,        // damage spots remembered per piece
  occlusion: 0.45,       // blast damage multiplier per destructible piece between blast and target
  staticOcclusion: 0.2,  // ... per indestructible box in between
  blastSpeed: 11,        // debris launch speed (m/s) at the centre of a blast
  chips: true,           // knock small chips off on non-fatal bullet hits
  support: {
    maxSpan: 4.0,        // how far (cost units ~ half the true cantilever length) structure may reach from a vertical load path
    spanMargin: 0.4,     // if the intact level needs more than maxSpan, maxSpan is raised to (worst case + this) at start
    restFree: 2.0,       // a piece resting ON another may overhang its centre this far for free
    hangBase: 0.5,       // cost of hanging underneath a supported piece ...
    hangFactor: 2.0,     // ... plus this per metre hung
    structCell: 2.5,     // unsupported pieces larger than this are first broken into tiles so only the unsupported part falls
    tileBoxesPerFrame: 24, // work budget for that tiling
    groupsPerFrame: 2,
    collapsesPerFrame: 8,
    delayBase: 0.12, delayPerMeter: 0.07, delayJitter: 0.12, delayMax: 2.0, // cascading collapse timing (s)
  },
  debris: {
    max: 1000,           // hard cap on chunks (instances); oldest/sleeping are recycled
    gravity: 22,
    restitution: 0.28,
    chunk: 0.5,          // target fragment size for shot/blasted pieces
    fallChunk: 1.25,     // target fragment size for collapsing pieces (they break again on landing)
    maxPerPiece: 8,
    breakSize: 0.9,      // falling fragments larger than this split when they land harder than breakSpeed
    breakSpeed: 5,
    rubbleLife: 50,      // seconds a settled chunk stays before shrinking away
    chipLife: 3,
    activeLife: 12,      // a chunk still moving after this is put to sleep
  },
  decals: { max: 256 },  // crack marks
};
