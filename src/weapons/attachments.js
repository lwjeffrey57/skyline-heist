// =============================================================================
// ATTACHMENTS — data only. Geometry: attachparts.js. Wiring (inventory, HUD, API): weapons.js.
//
// An attachment never edits a weapon def. Each inventory slot owns an EFFECTIVE def: a deep copy of the base def
// with the mods of everything fitted applied on top (effectiveDef below), rebuilt whenever the set changes.
//
//   id, name      unique id / display name          short   3-5 letters for the weapon HUD
//   slot          'muzzle' | 'optic' | 'magazine' | 'grip' | 'stock'
//   desc          one player-facing line: what it gives and what it costs
//   fits          weapon ids, or 'all-with-slot' (every gun that has the slot, see SLOTS)
//   tier, price   'common' | 'uncommon' | 'rare' | 'epic', credits
//   part          which geometry attachparts.js builds
//   mods          multipliers unless noted (1 = unchanged):
//       damage, range (falloff start + end), rpm, mag, magAdd (+rounds), reserve, reload (all reload times),
//       adsTime, adsMove, mobility, equip, sprintOut,
//       recoilV / recoilH (pattern, vertical / horizontal), recoilCrouch (the crouch multiplier itself), recover,
//       hipSpread (base + bloom at the hip), moveSpread, crouchSpread (the crouch multiplier itself), kick (visual)
//       suppressed: true     shots carry `suppressed` (guards hear a quarter of the distance)
//       loud: n              shots carry `loud: n` (for systems that want a bigger report; nothing reads it yet)
//       optic: { kind:'irons'|'dot'|'holo'|'scope', fov, style?, color? }   replaces the sight picture
//   per           { weaponId: mods } replaces `mods` on that gun
// =============================================================================

export const SLOT_NAMES = ['muzzle', 'optic', 'magazine', 'grip', 'stock'];

// which slots each gun has (not every gun has every slot)
export const SLOTS = {
  pistol: ['muzzle', 'optic', 'magazine', 'grip'],
  rifle: ['muzzle', 'optic', 'magazine', 'grip', 'stock'],
  smg: ['muzzle', 'optic', 'magazine', 'grip', 'stock'],
  dmr: ['muzzle', 'optic', 'magazine', 'grip', 'stock'],
  shotgun: ['muzzle', 'optic', 'magazine', 'grip'],
  slug_shotgun: ['muzzle', 'optic', 'magazine', 'grip'],
  sniper: ['muzzle', 'magazine'],
  launcher: [],
  handcannon: ['muzzle', 'optic', 'grip'],
  lmg: ['muzzle', 'optic', 'magazine', 'grip', 'stock'],
  lever: ['muzzle', 'optic', 'magazine'],
  crossbow: ['optic', 'grip', 'stock'],
  burst_rifle: ['muzzle', 'optic', 'magazine', 'grip'],
  burst_pistol: ['muzzle', 'optic', 'magazine'],
};

const RIFLES = ['rifle', 'smg', 'dmr'];
const LONG = ['rifle', 'smg', 'dmr', 'lmg', 'burst_rifle'];

export const ATTACHMENTS = [
  // ---- muzzle -------------------------------------------------------------------------------------------------
  { id: 'suppressor', name: 'Hush can', short: 'SUP', slot: 'muzzle', part: 'suppressor', tier: 'rare', price: 900,
    desc: 'Guards hear your shots from a quarter of the distance. Less damage and reach, slower to aim.',
    fits: ['pistol', 'rifle', 'smg', 'dmr', 'sniper', 'lmg', 'lever', 'shotgun', 'slug_shotgun', 'burst_rifle', 'burst_pistol'],
    mods: { suppressed: true, damage: 0.92, range: 0.85, adsTime: 1.06, recoilV: 0.95 } },
  { id: 'compensator', name: 'Compensator', short: 'COMP', slot: 'muzzle', part: 'compensator', tier: 'uncommon', price: 400,
    desc: 'A fifth less muzzle climb. The gun kicks sideways more and the blast is bigger.',
    fits: ['pistol', 'rifle', 'smg', 'dmr', 'lmg', 'handcannon', 'burst_rifle', 'burst_pistol'],
    mods: { recoilV: 0.78, recoilH: 1.2, loud: 1.25, kick: 1.1 } },
  { id: 'brake', name: 'Muzzle brake', short: 'BRK', slot: 'muzzle', part: 'brake', tier: 'uncommon', price: 400,
    desc: 'Sideways drift almost halved, so long sprays stay in a column. Looser from the hip.',
    fits: ['rifle', 'smg', 'dmr', 'lmg', 'lever', 'shotgun', 'slug_shotgun', 'burst_rifle'],
    mods: { recoilH: 0.58, recoilV: 0.96, hipSpread: 1.2, loud: 1.15 } },
  { id: 'longbarrel', name: 'Long barrel', short: 'LONG', slot: 'muzzle', part: 'longbarrel', tier: 'uncommon', price: 450,
    desc: 'Damage holds 30% further out. Slower to aim, to raise and to carry.',
    fits: ['rifle', 'smg', 'dmr', 'sniper', 'lmg', 'lever', 'shotgun', 'slug_shotgun', 'handcannon', 'burst_rifle'],
    mods: { range: 1.3, adsTime: 1.12, equip: 1.15, mobility: 0.98, hipSpread: 1.1 } },
  // ---- optic --------------------------------------------------------------------------------------------------
  { id: 'irons', name: 'Flip-up irons', short: 'IRON', slot: 'optic', part: 'irons', tier: 'common', price: 150,
    desc: 'No glass: the fastest sight to bring up and the widest view, with the least zoom.',
    fits: RIFLES,
    mods: { adsTime: 0.84, adsMove: 1.08, optic: { kind: 'irons', fov: 0.82 } } },
  { id: 'reddot', name: 'Red dot', short: 'DOT', slot: 'optic', part: 'reddot', tier: 'common', price: 250,
    desc: 'A clean dot at 1.4x in place of the factory sights. A touch slower to aim than bare irons.',
    fits: ['pistol', 'shotgun', 'slug_shotgun', 'handcannon', 'lmg', 'lever', 'crossbow', 'burst_rifle', 'burst_pistol'], // (the WREN family carries one from the factory)
    mods: { adsTime: 1.04, optic: { kind: 'dot', fov: 0.74, color: 0xff2a1a } },
    per: { pistol: { adsTime: 1.08, optic: { kind: 'dot', fov: 0.8, color: 0xff2a1a } }, handcannon: { adsTime: 1.08, optic: { kind: 'dot', fov: 0.78, color: 0xff2a1a } } } },
  { id: 'holo', name: 'Holo sight', short: 'HOLO', slot: 'optic', part: 'holo', tier: 'uncommon', price: 450,
    desc: 'Ring-and-dot reticle in a big window at 1.6x: easy to track with. Slower to aim, slower on the move.',
    fits: ['rifle', 'smg', 'dmr', 'lmg', 'shotgun', 'slug_shotgun', 'crossbow', 'burst_rifle'],
    mods: { adsTime: 1.1, adsMove: 0.95, optic: { kind: 'holo', fov: 0.63, color: 0x45ffa0 } } },
  { id: 'scope25', name: '2.5x prism scope', short: '2.5X', slot: 'optic', part: 'scope25', tier: 'rare', price: 700,
    desc: 'Chevron reticle at 2.5x for work across the yard. A quarter slower to aim, clumsy up close.',
    fits: ['rifle', 'smg', 'dmr', 'lmg', 'lever', 'crossbow', 'handcannon', 'burst_rifle'],
    mods: { adsTime: 1.25, adsMove: 0.85, optic: { kind: 'scope', fov: 0.4, style: 1 } } },
  { id: 'scope4', name: '4x marksman scope', short: '4X', slot: 'optic', part: 'scope4', tier: 'epic', price: 1100,
    desc: 'A true 4x glass. Half as slow again to aim and you crawl while looking through it.',
    fits: ['rifle', 'dmr', 'lmg', 'crossbow', 'burst_rifle'],
    mods: { adsTime: 1.5, adsMove: 0.7, optic: { kind: 'scope', fov: 0.25, style: 2 } } },
  // ---- magazine -----------------------------------------------------------------------------------------------
  { id: 'extmag', name: 'Extended magazine', short: 'EXT', slot: 'magazine', part: 'extmag', tier: 'uncommon', price: 450,
    desc: 'Half as many rounds again in the gun. Reloads 15% slower and the gun comes up slower.',
    fits: ['pistol', 'rifle', 'smg', 'dmr', 'sniper', 'lmg', 'shotgun', 'slug_shotgun', 'lever', 'burst_rifle', 'burst_pistol'],
    mods: { mag: 1.5, reload: 1.15, adsTime: 1.05 },
    per: { shotgun: { magAdd: 2, adsTime: 1.06, equip: 1.1 }, slug_shotgun: { magAdd: 2, adsTime: 1.06, equip: 1.1 }, lever: { magAdd: 3, adsTime: 1.06, equip: 1.1 },
      sniper: { magAdd: 3, reload: 1.12, adsTime: 1.04 }, lmg: { mag: 1.5, reload: 1.12, mobility: 0.96 } } },
  { id: 'fastmag', name: 'Quick-pull magazine', short: 'FAST', slot: 'magazine', part: 'fastmag', tier: 'uncommon', price: 400,
    desc: 'Reloads a fifth faster. The bulky pull-tabs mean you carry 15% less spare ammunition.',
    fits: ['pistol', 'rifle', 'smg', 'dmr', 'sniper', 'burst_rifle', 'burst_pistol'],
    mods: { reload: 0.8, reserve: 0.85 } },
  { id: 'drum', name: 'Drum magazine', short: 'DRUM', slot: 'magazine', part: 'drum', tier: 'epic', price: 1200,
    desc: 'Two and a half magazines in one. A long, heavy reload; slower to aim and to move.',
    fits: ['rifle', 'smg'],
    mods: { mag: 2.5, reload: 1.45, adsTime: 1.2, mobility: 0.96, equip: 1.2 } },
  // ---- grip / underbarrel -------------------------------------------------------------------------------------
  { id: 'vgrip', name: 'Vertical grip', short: 'VGRP', slot: 'grip', part: 'vgrip', tier: 'common', price: 250,
    desc: 'Pulls the muzzle down: 18% less climb, a little less drift. Slower to aim.',
    fits: LONG,
    mods: { recoilV: 0.82, recoilH: 0.92, adsTime: 1.07 } },
  { id: 'agrip', name: 'Angled grip', short: 'AGRP', slot: 'grip', part: 'agrip', tier: 'common', price: 250,
    desc: 'On target sooner: aims 18% faster and fires sooner out of a sprint. A little more sideways kick.',
    fits: ['rifle', 'smg', 'dmr', 'lmg', 'crossbow', 'burst_rifle'],
    mods: { adsTime: 0.82, sprintOut: 0.75, recoilH: 1.1 } },
  { id: 'laser', name: 'Aiming laser', short: 'LASR', slot: 'grip', part: 'laser', tier: 'uncommon', price: 350,
    desc: 'Hip fire 40% tighter, standing or moving. Takes the place of a grip.',
    fits: ['pistol', 'rifle', 'smg', 'dmr', 'lmg', 'shotgun', 'slug_shotgun', 'handcannon', 'crossbow', 'burst_rifle'],
    mods: { hipSpread: 0.6, moveSpread: 0.75 } },
  { id: 'brace', name: 'Brace pod', short: 'POD', slot: 'grip', part: 'brace', tier: 'rare', price: 650,
    desc: 'Crouch and the gun barely moves: recoil and spread nearly halved while crouched. Heavier everywhere else.',
    fits: ['lmg', 'dmr'],
    mods: { recoilCrouch: 0.55, crouchSpread: 0.6, adsTime: 1.12, mobility: 0.97 } },
  // ---- stock --------------------------------------------------------------------------------------------------
  { id: 'lightstock', name: 'Skeleton stock', short: 'LITE', slot: 'stock', part: 'lightstock', tier: 'uncommon', price: 350,
    desc: 'Aims 15% faster, moves faster, fires sooner out of a sprint. Recoil up by a fifth.',
    fits: ['rifle', 'smg', 'dmr', 'lmg', 'crossbow'],
    mods: { adsTime: 0.85, mobility: 1.04, sprintOut: 0.8, adsMove: 1.08, recoilV: 1.2, recoilH: 1.2 } },
  { id: 'heavystock', name: 'Padded stock', short: 'HVY', slot: 'stock', part: 'heavystock', tier: 'uncommon', price: 350,
    desc: 'Soaks up 15% of the recoil and settles faster. Slower to aim and to carry.',
    fits: ['rifle', 'smg', 'dmr', 'lmg', 'crossbow'],
    mods: { recoilV: 0.85, recoilH: 0.85, recover: 1.25, adsTime: 1.12, mobility: 0.97 } },
];

const BY_ID = new Map(ATTACHMENTS.map((a) => [a.id, a]));
export const attachment = (id) => BY_ID.get(id) || null;
export const slotsFor = (weaponId) => (SLOTS[weaponId] || []).slice();
export function fits(attId, weaponId) {
  const a = BY_ID.get(attId), slots = SLOTS[weaponId];
  if (!a || !slots || !slots.includes(a.slot)) return false;
  return a.fits === 'all-with-slot' || a.fits.includes(weaponId);
}
export const modsFor = (a, weaponId) => (a.per && a.per[weaponId]) ? { ...a.mods, ...a.per[weaponId] } : a.mods;

// keep only what fits this gun, one per slot: { slot: id }
export function cleanSet(weaponId, set) {
  const out = {};
  if (set) for (const slot of SLOT_NAMES) { const id = set[slot]; if (id && fits(id, weaponId) && BY_ID.get(id).slot === slot) out[slot] = id; }
  return out;
}

const clone = (v) => (Array.isArray(v) ? v.map(clone) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v);
const mul = (o, k, m) => { if (m != null && typeof o[k] === 'number') o[k] *= m; };

// base def + fitted attachments -> a new def object. `baseFov` (degrees) sizes the viewmodel FOV of telescopic sights.
export function effectiveDef(base, set, baseFov = 80) {
  const d = clone(base);
  d.attSuppressed = false; d.loud = 1; d.optic = null; d.attachments = {};
  for (const slot of SLOT_NAMES) {
    const a = set && set[slot] ? BY_ID.get(set[slot]) : null; if (!a) continue;
    d.attachments[slot] = a.id;
    const m = modsFor(a, base.id), r = d.reload, s = d.spread, rc = d.recoil;
    mul(d, 'damage', m.damage); mul(d, 'rpm', m.rpm); mul(d, 'mobility', m.mobility); mul(d, 'equip', m.equip); mul(d, 'sprintOut', m.sprintOut);
    if (m.range != null) { d.falloff[0] *= m.range; d.falloff[1] *= m.range; }
    if (m.mag != null) d.mag = Math.max(1, Math.round(d.mag * m.mag));
    if (m.mag != null && d.burst && d.modes.length === 1) d.mag = Math.ceil(d.mag / d.burst.count) * d.burst.count; // burst-only guns: whole bursts
    if (m.magAdd) d.mag += m.magAdd;
    if (m.reserve != null) d.reserve = Math.max(d.mag, Math.round(d.reserve * m.reserve));
    if (m.reload != null) for (const k of ['time', 'start', 'shell', 'end']) mul(r, k, m.reload);
    mul(d.ads, 'time', m.adsTime); if (m.adsMove != null) d.ads.move = Math.min(1, d.ads.move * m.adsMove);
    if (m.recoilV != null || m.recoilH != null) for (const p of rc.pattern) { p[0] *= m.recoilV ?? 1; p[1] *= m.recoilH ?? 1; }
    if (m.recoilH != null) rc.jitter *= (1 + m.recoilH) / 2;
    mul(rc, 'crouchMult', m.recoilCrouch); mul(rc, 'recover', m.recover);
    if (m.hipSpread != null) { s.hip *= m.hipSpread; s.hipBloom = (s.hipBloom ?? 1) * m.hipSpread; }
    mul(s, 'move', m.moveSpread); mul(s, 'air', m.moveSpread); mul(s, 'crouch', m.crouchSpread);
    if (m.kick != null) for (const k of ['z', 'rx', 'cam', 'fov']) mul(d.kick, k, m.kick);
    if (m.suppressed) d.attSuppressed = true;
    if (m.loud) d.loud *= m.loud;
    if (m.optic) {
      d.optic = { ...m.optic, id: a.id };
      d.ads.fov = m.optic.fov; d.ads.scope = m.optic.kind === 'scope';
      if (d.ads.scope) { d.ads.vmFov = baseFov * m.optic.fov * 0.946; d.view.adsDist = 0.108; d.spread.ads = 0; }
    }
  }
  if (d.attSuppressed) d.loud = 1;
  return d;
}

// numbers for a stash / shop card
export function summary(d) {
  const r = d.reload, pat = d.recoil.pattern, n = Math.min(10, d.mag, pat.length + 40);
  let v = 0, h = 0;
  for (let i = 0; i < n; i++) { const p = pat[i < pat.length ? i : pat.length - d.recoil.loop + ((i - pat.length) % d.recoil.loop)]; v += p[0]; h += Math.abs(p[1]); }
  const round = (x, k = 100) => Math.round(x * k) / k;
  return {
    id: d.id, name: d.name, damage: round(d.damage, 10), pellets: d.pellets, headMult: d.headMult, rpm: Math.round(d.rpm),
    mag: d.mag, reserve: d.reserve,
    reload: round(r.type === 'shell' ? r.start + r.shell * d.mag + r.end : r.time),          // empty reload, seconds
    reloadTactical: r.type === 'shell' ? round(r.start + r.shell + r.end) : round(r.time * (r.tactical || 1)),
    ads: round(d.ads.time), adsFov: round(d.ads.fov), zoom: round(1 / d.ads.fov, 10), adsMove: round(d.ads.move), mobility: round(d.mobility),
    recoilV: round(v / n), recoilH: round(h / n),          // degrees per shot, average over the first 10 rounds
    recoil: round(v / n + h / n),
    hipSpread: round(d.spread.hip), hipBloom: round(d.spread.hipBloom ?? 1), moveSpread: round(d.spread.move), crouchRecoil: round(d.recoil.crouchMult), range: [Math.round(d.falloff[0]), Math.round(d.falloff[1])],
    suppressed: !!(d.suppressed || d.attSuppressed), scope: !!d.ads.scope,
    attachments: { ...d.attachments },
  };
}
