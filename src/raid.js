import * as THREE from 'three';
import { createInventory, BAGS } from './inventory.js';
import { bump } from './progress.js';

// Extraction mode. Deploy, search crates and fallen guards for loot, reach an extraction zone and hold it
// to bank what you carry. Die or run out of time and the backpack is lost. Banked credits buy upgrades.

const RAID = { time: 720, bots: 9, botDamage: 6, botRespawn: 25, extractHold: 6, extractRadius: 3.6, protect: 4 };
const TIERS = {
  common: { color: '#c9d1d9', w: 60 }, uncommon: { color: '#5fd38a', w: 27 }, rare: { color: '#5aa9ff', w: 10 }, epic: { color: '#d48bff', w: 1.5 },
};
const ITEMS = [
  ['Ration Tin', 'common', 12], ['Copper Spool', 'common', 15], ['Work Gloves', 'common', 18], ['Fuse Pack', 'common', 20], ['Circuit Scrap', 'common', 25], ['Cable Reel', 'common', 30],
  ['Signal Relay', 'uncommon', 70], ['Field Dressing Case', 'uncommon', 80], ['Optic Lens', 'uncommon', 90], ['Coolant Cell', 'uncommon', 110], ['Data Slate', 'uncommon', 120],
  ['Encrypted Drive', 'rare', 260], ['Servo Core', 'rare', 320], ['Gold Bearing', 'rare', 380],
  ['Prototype Chip', 'epic', 900], ['Vault Bond', 'epic', 1400],
].map(([name, tier, value]) => ({ name, tier, value }));
// crate kinds: how many rolls, and how much the odds lean toward better tiers
const CRATES = {
  standard: { rolls: [2, 3], luck: 1, color: 0x6b7480, glow: 0xffb347, time: 1.0, label: 'supply crate' },
  secure: { rolls: [2, 4], luck: 1.8, color: 0x3f5f8a, glow: 0x5aa9ff, time: 1.6, label: 'secure crate' },
  vault: { rolls: [4, 5], luck: 4, color: 0x5c4480, glow: 0xd48bff, time: 2.6, label: 'vault case' },
  locker: { rolls: [0, 0], luck: 1, color: 0xff6a00, glow: 0xffe9c2, time: 2.2, label: 'arms locker' },
  terminal: { rolls: [0, 0], luck: 1, color: 0x1c2a33, glow: 0x35e0d8, time: 3, label: 'signal terminal' },
  bag: { rolls: [1, 2], luck: 1.4, color: 0x4a4335, glow: 0x9be37a, time: 0.5, label: 'dropped pack' },
};
const UPGRADES = [
  { id: 'pack', key: 'KeyZ', label: 'Z', name: 'Expanded pack', desc: 'Carry 12 items instead of 8', cost: 1500 },
  { id: 'medic', key: 'KeyX', label: 'X', name: 'Field medic kit', desc: 'Deploy with 3 medkits instead of 1', cost: 1000 },
  { id: 'armor', key: 'KeyV', label: 'V', name: 'Plate carrier', desc: 'Deploy with 50 armour', cost: 2500 },
  { id: 'suppressor', key: 'KeyC', label: 'C', name: 'Pistol suppressor', desc: 'Guards hear your pistol from a quarter of the distance', cost: 1800 },
  { id: 'pouch', key: 'KeyB', label: 'B', name: 'Secure pouch', desc: 'Your most valuable item survives if you die', cost: 2000 },
];
// weapons you can own: extract with one and it joins your armoury; bring it on a raid and it is at risk
const GUNS = [['rifle', 'Digit2', '2', 900], ['shotgun', 'Digit3', '3', 700], ['sniper', 'Digit4', '4', 1200], ['launcher', 'Digit5', '5', 1500], ['smg', 'Digit6', '6', 700], ['dmr', 'Digit7', '7', 1100], ['slug_shotgun', 'Digit8', '8', 800]];
// Contracts: two are offered each raid; a completed one pays its bonus only if you extract.
// count contracts tick up from events; check contracts are judged from the raid's state (live, and at extraction).
const CONTRACTS = [
  { id: 'lockers', text: 'Open 2 arms lockers', goal: 2, pay: 300, ev: 'loot', inc: (e) => (e.kind === 'locker' ? 1 : 0) },
  { id: 'search', text: 'Search 8 containers', goal: 8, pay: 250, ev: 'loot', inc: () => 1 },
  { id: 'vault', text: 'Crack a vault case', goal: 1, pay: 400, ev: 'loot', inc: (e) => (e.kind === 'vault' ? 1 : 0) },
  { id: 'kills', text: 'Eliminate 3 guards', goal: 3, pay: 300, ev: 'kill', inc: () => 1 },
  { id: 'heads', text: 'Get 2 headshot kills', goal: 2, pay: 350, ev: 'kill', inc: (e) => (e.headshot ? 1 : 0) },
  { id: 'sidearm', text: 'Get 2 kills with the pistol', goal: 2, pay: 300, ev: 'kill', inc: (e) => (e.weapon === 'pistol' ? 1 : 0) },
  { id: 'haul', text: 'Extract with a pack worth 500 cr', pay: 300, check: (s) => s.value >= 500 },
  { id: 'rare', text: 'Extract with a rare item or better', pay: 300, check: (s) => s.pack.some((i) => i.tier === 'rare' || i.tier === 'epic') },
  { id: 'ghost', text: 'Extract without ever being detected', pay: 500, check: (s) => !s.detected },
  { id: 'fast', text: 'Extract within 4 minutes', pay: 300, check: (s) => s.elapsed <= 240 },
  { id: 'district', text: 'Search 3 containers in one district', goal: 3, pay: 300, ev: 'loot', inc: () => 0 }, // given a district when rolled
];
// Districts: the arena is five named areas, each with its own kind of loot.
const DISTRICTS = {
  Plaza: 'the strongroom', Depot: 'supplies', Exchange: 'better valuables', Works: 'fuller crates', 'Freight Row': 'a mix',
};
function districtAt(x, z) {
  if (Math.abs(x) < 17 && Math.abs(z) < 17) return 'Plaza';
  if (Math.abs(z) >= Math.abs(x)) return z > 0 ? 'Depot' : 'Freight Row';
  return x > 0 ? 'Exchange' : 'Works';
}
// Threat: every named location has a rating you can read on the map. Higher threat means better loot and more defences.
const THREAT = { low: { luck: 0, color: '#9be37a' }, medium: { luck: 0.3, color: '#ffe14a' }, high: { luck: 0.6, color: '#ff9a3c' }, critical: { luck: 0.85, color: '#ff5a4a' } };
const OUTPOST_THREAT = { infirmary: 'low', depot: 'low', signal: 'medium', watch: 'medium', armoury: 'high' };
const EXITS = [[-62, 42], [62, -30], [0, -64], [62, 50], [-62, -30]];
const SPAWNS = [[0, 50], [-48, 58], [48, 58], [-62, 20], [62, 22], [-62, -20], [62, -10], [-40, -60], [0, -60], [36, -60], [-20, 60], [26, 46]];
const rnd = (a, b) => a + Math.random() * (b - a);
const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

function loadStash() {
  const base = { credits: 0, extracted: 0, lost: 0, best: 0, upgrades: {}, armory: {}, bring: {} };
  let s = base;
  try { s = { ...base, ...JSON.parse(localStorage.getItem('sh-stash') || '{}') }; } catch { /* storage unavailable */ }
  // the page was closed or reloaded in the middle of a raid: that counts as a lost raid, so what was carried is gone
  if (s.inRaid) { s.inRaid = false; s.lost++; s.pack = []; s.w = [null, null]; }
  return s;
}
function saveStash(s) { try { localStorage.setItem('sh-stash', JSON.stringify(s)); } catch { /* storage unavailable */ } }

function rollItem(luck) {
  let total = 0; const w = {};
  for (const [k, t] of Object.entries(TIERS)) { w[k] = k === 'common' ? t.w : t.w * luck; total += w[k]; }
  let r = Math.random() * total, tier = 'common';
  for (const k of Object.keys(w)) { r -= w[k]; if (r <= 0) { tier = k; break; } }
  const pool = ITEMS.filter((i) => i.tier === tier);
  return { ...pool[Math.floor(Math.random() * pool.length)] };
}
function rollContents(kind) {
  const c = CRATES[kind], n = Math.round(rnd(c.rolls[0], c.rolls[1])), out = [];
  for (let i = 0; i < n; i++) {
    if (Math.random() < 0.03) { const size = Math.random() < 0.25 ? 8 : 4; out.push({ supply: 'bag', size, name: BAGS[size].name }); continue; }
    const r = Math.random();
    if (r < 0.14) out.push({ supply: 'medkit', name: 'Medkit' });
    else if (r < 0.26) out.push({ supply: 'armor', name: 'Armour plate' });
    else if (r < 0.42) out.push({ supply: 'ammo', name: 'Ammo box' });
    else out.push(rollItem(c.luck));
  }
  return out;
}

export function init(ctx) {
  const { player, world, events, input, scene, camera } = ctx;
  const stash = loadStash();
  let tick = 0, tick10 = 0, reloading = false;
  let extraMed = 0, extraArmor = 0; // supplies bought on the loadout screen for the next raid
  let state = 'stash', timeLeft = 0, pack = [], medkits = 0, armor = 0, holdT = 0, exitT = 0, result = null, healCd = 0, target = null;
  let bagBonus = 0, foundBag = 0, packOpen = false; // backpack slots this raid; a bigger backpack found in the raid
  const packSize = () => (stash.upgrades.pack ? 12 : 8) + (state === 'raid' ? bagBonus : (stash.b && stash.b[0] ? stash.b[0].size : 0));
  const packValue = () => pack.reduce((a, i) => a + i.value, 0);
  player.noManualRespawn = true;

  // ---- HUD ----------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    #rd-top { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); text-align: center; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,.75); pointer-events: none; font-variant-numeric: tabular-nums; }
    #rd-top .mode { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; opacity: .7; }
    #rd-top .line { font-size: 15px; font-weight: 700; letter-spacing: 1px; }
    #rd-top .line span { opacity: .6; font-weight: 500; margin: 0 6px; }
    #rd-top .sub { margin-top: 3px; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: #7ff3ea; }
    #rd-kit { position: fixed; left: 24px; bottom: 164px; font-size: 12px; letter-spacing: 1px; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,.75); pointer-events: none; }
    #rd-kit b { color: #ffc56b; }
    #rd-kit .bar { width: 150px; height: 4px; background: rgba(255,255,255,.18); margin-top: 4px; }
    #rd-kit .bar i { display: block; height: 100%; background: #7fb4ff; }
    #rd-contracts { position: fixed; left: 24px; top: 118px; font-size: 12px; letter-spacing: 1px; line-height: 1.6; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,.8); pointer-events: none; }
    #rd-contracts .h { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; opacity: .7; }
    #rd-hint { position: fixed; left: 50%; top: 124px; transform: translateX(-50%); max-width: 520px; padding: 8px 14px; background: rgba(8,12,16,.6); border-left: 2px solid #9be37a; color: #fff; font-size: 13px; letter-spacing: 1px; text-align: center; pointer-events: none; }
    #rd-hint b { color: #9be37a; }
    #rd-hold { position: fixed; left: 50%; top: 64%; transform: translateX(-50%); width: 220px; text-align: center; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,.75); pointer-events: none; }
    #rd-hold .bar { height: 5px; background: rgba(255,255,255,.2); margin-top: 6px; }
    #rd-hold .bar i { display: block; height: 100%; background: #9be37a; width: 0; }
    #rd-toasts { position: fixed; left: 50%; top: 70%; transform: translateX(-50%); text-align: center; font-size: 13px; letter-spacing: 1px; text-shadow: 0 1px 3px rgba(0,0,0,.8); pointer-events: none; }
    #rd-toasts div { margin-top: 3px; transition: opacity .5s; }
    .rd-mark { position: fixed; transform: translate(-50%, -50%); text-align: center; font-size: 11px; letter-spacing: 1px; color: #9be37a; text-shadow: 0 1px 3px rgba(0,0,0,.8); pointer-events: none; font-variant-numeric: tabular-nums; }
    .rd-mark i { display: block; width: 12px; height: 12px; margin: 0 auto 3px; border: 2px solid #9be37a; transform: rotate(45deg); }
    #rd-packui { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; background: rgba(5,7,10,.35); }
    #rd-packui .box { width: 420px; padding: 0 26px 20px; background: rgba(8,11,15,.92); border-top: 3px solid #ffc56b; color: #fff; user-select: none; }
    #rd-packui h2 { margin: 0 -26px 8px; padding: 14px 26px 11px; font-size: 22px; letter-spacing: 6px; text-transform: uppercase; background: rgba(255,255,255,.04); }
    #rd-packui p { margin: 0 0 10px; font-size: 12px; letter-spacing: 1px; opacity: .8; line-height: 1.6; }
    #rd-packui .pgrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
    #rd-packui .slot { position: relative; aspect-ratio: 1; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.12); }
    #rd-packui .pdrop { margin-top: 8px; padding: 12px; text-align: center; border: 1px dashed rgba(255,138,112,.6); color: #ff8a70; font-size: 11px; letter-spacing: 3px; text-transform: uppercase; }
    #rd-packui .go { margin-top: 12px; padding: 9px 12px; text-align: center; background: #ffc56b; color: #14100a; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; font-size: 12px; }
    #rd-panel { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
    #rd-panel .box { min-width: 420px; max-width: 520px; padding: 22px 26px; background: rgba(8,11,15,.86); border: 1px solid rgba(255,255,255,.14); color: #fff; }
    #rd-panel h2 { margin: 0 0 4px; font-size: 20px; letter-spacing: 3px; text-transform: uppercase; }
    #rd-panel p { margin: 0 0 12px; font-size: 12px; letter-spacing: 1px; opacity: .75; }
    #rd-panel table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
    #rd-panel td { padding: 5px 6px; border-top: 1px solid rgba(255,255,255,.08); }
    #rd-panel td:last-child { text-align: right; }
    #rd-panel kbd { font-family: inherit; font-weight: 700; color: #ffc56b; }
    #rd-panel .go { margin-top: 14px; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: #ffc56b; }
    #rd-panel .dim { opacity: .5; }`;
  document.head.appendChild(style);
  const el = (id, html = '') => { const d = document.createElement('div'); d.id = id; d.innerHTML = html; ctx.hud.appendChild(d); return d; };
  const top = el('rd-top', '<div class="mode">Extraction</div><div class="line"></div><div class="sub" hidden></div>');
  const kit = el('rd-kit'), hold = el('rd-hold', '<span></span><div class="bar"><i></i></div>'), toasts = el('rd-toasts'), panel = el('rd-panel');
  const cbox = el('rd-contracts'); cbox.hidden = true;
  const hint = el('rd-hint'); hint.hidden = true;
  hold.hidden = true; panel.hidden = true;
  const line = top.querySelector('.line'), sub = top.querySelector('.sub');
  function toast(html, color = '#fff') {
    const d = document.createElement('div'); d.innerHTML = html; d.style.color = color; toasts.prepend(d);
    while (toasts.children.length > 5) toasts.lastChild.remove();
    setTimeout(() => { d.style.opacity = '0'; }, 2600); setTimeout(() => d.remove(), 3200);
  }

  // ---- small interface sounds (routed through the game's master volume, so N still mutes them) ------
  function chime(notes, gap = 0.07, len = 0.16, vol = 0.16, type = 'triangle') {
    const dbg = ctx.audio && ctx.audio.debug, ac = dbg && dbg.context, G = dbg && dbg.graph;
    if (!ac || !G || !G.master || ac.state !== 'running') return;
    notes.forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + i * gap;
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0008, t + len);
      o.connect(g); g.connect(G.master); o.start(t); o.stop(t + len + 0.02);
    });
  }
  const TIER_SOUND = { common: [[620]], uncommon: [[620, 830]], rare: [[620, 830, 1110], 0.07, 0.24, 0.2], epic: [[620, 830, 1110, 1480, 1860], 0.08, 0.4, 0.24] };
  let contracts = [], detected = false;
  let revealT = 0, phaseDelay = 0, keyT = 0, holdNeed = RAID.extractHold, kindsDue = null; // signal terminal effects, exit keycard hold, outpost guard types
  let doorT = 0, hintStep = 0, everInZone = false; // first-raid hints
  events.on('lootTaken', () => { if (hintStep === 0) hintStep = 1; });
  let keycards = 0, phase = 0, lateExit = false, exitSec = 0; // keycards open vault cases; the raid escalates in phases
  let exitCallT = -99;
  let reveal = null; // the container being emptied, one item at a time
  const brought = new Set(); let broughtMed = 0, menu = null; // weapons and medkits taken in from the loadout
  const raidGuns = new Set(); // weapons carried this raid (brought or found): kept on extraction, lost otherwise

  // ---- lootables ----------------------------------------------------------
  const lootables = [];
  const geoLocker = new THREE.BoxGeometry(0.85, 1.85, 0.5), geoLockerStrip = new THREE.BoxGeometry(0.88, 0.07, 0.53), geoLockerDoor = new THREE.BoxGeometry(0.03, 1.6, 0.03);
  const geoBody = new THREE.BoxGeometry(0.9, 0.5, 0.6), geoLid = new THREE.BoxGeometry(0.94, 0.1, 0.64), geoStrip = new THREE.BoxGeometry(0.93, 0.09, 0.63), geoBag = new THREE.BoxGeometry(0.5, 0.34, 0.36);
  const matCache = {};
  const mats = (kind) => (matCache[kind] ||= {
    body: new THREE.MeshStandardMaterial({ color: CRATES[kind].color, roughness: 0.6, metalness: 0.4 }),
    glow: new THREE.MeshStandardMaterial({ color: 0x111111, emissive: CRATES[kind].glow, emissiveIntensity: 3 }),
    dead: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }),
  });
  function addLootable(kind, x, y, z, yaw = 0, contents = null) {
    const m = mats(kind), g = new THREE.Group();
    if (kind === 'locker' || kind === 'terminal') {
      if (kind === 'terminal') g.scale.set(1.25, 0.62, 1);
      const cab = new THREE.Mesh(geoLocker, m.body); cab.position.y = 0.925; cab.castShadow = true; cab.receiveShadow = true; g.add(cab);
      const seam = new THREE.Mesh(geoLockerDoor, m.dead); seam.position.set(0, 0.9, 0.255); g.add(seam);
      const band = new THREE.Mesh(geoLockerStrip, m.glow); band.position.y = 1.62; g.add(band);
      g.position.set(x, y, z); g.rotation.y = yaw; scene.add(g);
      const L = { kind, group: g, lid: null, strip: band, items: contents || [], opened: false, pos: g.position, born: ctx.time, vy: 0, district: districtAt(x, z) };
      lootables.push(L); return L;
    }
    const body = new THREE.Mesh(kind === 'bag' ? geoBag : geoBody, m.body); body.position.y = kind === 'bag' ? 0.17 : 0.25;
    body.castShadow = true; body.receiveShadow = true; g.add(body);
    let lid = null;
    if (kind !== 'bag') { lid = new THREE.Mesh(geoLid, m.body); lid.position.set(0, 0.55, 0); lid.castShadow = true; g.add(lid); }
    const strip = new THREE.Mesh(geoStrip, m.glow); strip.position.y = kind === 'bag' ? 0.3 : 0.4; if (kind === 'bag') strip.scale.set(0.56, 0.6, 0.6); g.add(strip);
    g.position.set(x, y, z); g.rotation.y = yaw; scene.add(g);
    const L = { kind, group: g, lid, strip, items: rollContents(kind), opened: false, pos: g.position, born: ctx.time, vy: 0, district: districtAt(x, z) };
    if (kind === 'standard' || kind === 'secure') { // each district's crates lean a different way
      if (L.district === 'Depot') L.items = L.items.map((it) => (it.tier === 'common' && Math.random() < 0.6 ? [{ supply: 'medkit', name: 'Medkit' }, { supply: 'ammo', name: 'Ammo box' }, { supply: 'armor', name: 'Armour plate' }][Math.floor(Math.random() * 3)] : it));
      else if (L.district === 'Exchange') L.items = L.items.map((it) => (it.tier === 'common' ? rollItem(3.2) : it));
      else if (L.district === 'Works') L.items.push(rollItem(1.2), rollItem(1.2));
    }
    lootables.push(L); return L;
  }
  function clearLootables() { for (const L of lootables) L.group.removeFromParent(); lootables.length = 0; }
  const down = new THREE.Vector3(0, -1, 0), probe = new THREE.Vector3();
  function floorBelow(x, y, z) { probe.set(x, y + 0.6, z); const h = world.raycast(probe, down, 60); return h ? h.point.y : 0; }

  function placeCrates() {
    clearLootables();
    const spots = [];
    for (const b of world.buildings) {
      const ix = b.w / 2 - 1.6, iz = b.d / 2 - 1.6;
      for (let f = 0; f < b.floors; f++) {
        const y = f * b.floorHeight, kind = f === 0 ? 'standard' : 'secure';
        for (const [sx, sz] of [[-1, -1], [1, 1], [-1, 1], [1, -1]]) if (Math.random() < (f === 0 ? 0.28 : 0.32)) spots.push([kind, b.x + sx * ix, y, b.z + sz * iz]);
      }
      spots.push([b.floors >= 3 && !world.strongroom ? 'vault' : 'secure', b.x + rnd(-2, 2), b.roofY, b.z - b.d / 2 + 2.2, true]);
    }
    for (const [x, z] of [[-9, 26], [44, 9], [-54, 5], [10, -44], [-10, -40], [52, -46], [-56, -36], [3, 4.5], [-4.5, -3], [30, 40], [-40, 12], [20, -4]]) spots.push(['standard', x, 0, z]);
    // arms lockers: one on the top floor of five random buildings, each holding a weapon you did not deploy with
    const found = ['rifle', 'shotgun', 'sniper', 'launcher', 'smg', 'dmr', 'slug_shotgun'].sort(() => Math.random() - 0.5);
    const outpost = (type) => world.buildings.find((b) => b.outpost === type);
    const armoury = outpost('armoury'), sites = armoury ? [[armoury, 1], [armoury, -1]] : [];
    for (const b of world.buildings.filter((b) => !b.outpost).sort(() => Math.random() - 0.5).slice(0, armoury ? 3 : 5)) sites.push([b, 1]);
    sites.forEach(([b, side], i) => {
      const y = (b.floors - 1) * b.floorHeight, x = b.x + side * (b.w / 2 - 1.6) * 0.55, z = b.z + b.d / 2 - 0.75;
      if (!player.free(x, y + 0.1, z, 1.8)) return;
      const items = [{ weapon: found[i] }, { supply: 'ammoFull', name: 'Ammo' }];
      if (Math.random() < 0.5) items.push({ supply: 'armor', name: 'Armour plate' });
      addLootable('locker', x, floorBelow(x, y + 0.4, z), z, Math.PI, items);
    });
    // the other outposts: what each one is for
    const MED = { supply: 'medkit', name: 'Medkit' }, PLATE = { supply: 'armor', name: 'Armour plate' }, AMMO = { supply: 'ammo', name: 'Ammo box' };
    const put = (kind, b, dx, items) => { const x = b.x + dx, z = b.z - b.d / 2 + 1.5; if (!player.free(x, 0.75, z, 0.5)) return; const L = addLootable(kind, x, floorBelow(x, 0.4, z), z, 0); if (items) L.items = items; };
    const inf = outpost('infirmary'), dep = outpost('depot'), sig = outpost('signal');
    if (inf) { put('standard', inf, -2.2, [MED, MED, PLATE]); put('standard', inf, 2.2, [MED, PLATE, AMMO]); }
    if (dep) { put('secure', dep, -2.2, [{ supply: 'bag', size: Math.random() < 0.3 ? 8 : 4, name: 'Backpack' }, AMMO, AMMO]); put('standard', dep, 2.2, [AMMO, MED, rollItem(1.5)]); }
    if (sig) { const x = sig.x - (sig.w / 2 - 1.6) * 0.55, z = sig.z + sig.d / 2 - 0.75; if (player.free(x, 0.1, z, 1.2)) addLootable('terminal', x, floorBelow(x, 0.4, z), z, Math.PI, []); }
    kindsDue = [[armoury, 'heavy'], [outpost('watch'), 'marksman']].filter((k) => k[0]); // applied once the guards have taken their posts
    // every raid has at least one vault case: if no tall building rolled one, a rooftop crate is promoted
    if (world.strongroom) { const [a, b] = world.strongroom.inside; spots.push(['vault', a[0], a[1], a[2]], ['secure', b[0], b[1], b[2]]); }
    else if (!spots.some((s) => s[0] === 'vault')) { const roofs = spots.filter((s) => s[4]); if (roofs.length) roofs[Math.floor(Math.random() * roofs.length)][0] = 'vault'; }
    // a few crates out in the approach ring, so the walk in is worth something
    if (world.coreHalf) for (let i = 0; i < 10; i++) { const a = Math.random() * Math.PI * 2, d = world.coreHalf + 6 + Math.random() * (world.arenaHalf - world.coreHalf - 14); spots.push(['standard', Math.max(-d, Math.min(d, Math.cos(a) * d * 1.3)), 0, Math.max(-d, Math.min(d, Math.sin(a) * d * 1.3))]); }
    for (const [kind, x, y, z] of spots) {
      if (!player.free(x, y + 0.75, z, 0.5)) continue; // something solid is in the way
      const L = addLootable(kind, x, floorBelow(x, y + 0.4, z), z, Math.random() * Math.PI);
      if (kind === 'vault') { L.locked = !world.strongroom; // behind the strongroom door, the case itself is not locked
        if (Math.random() < 0.25) L.items.push({ name: 'Black Ledger', tier: 'epic', value: 2500 }); }
    }
    // better loot where the threat is higher: common items there are often re-rolled at much better odds
    for (const L of lootables) {
      if (L.kind !== 'standard' && L.kind !== 'secure') continue;
      const b = world.buildings.find((q) => q.threat && Math.abs(L.pos.x - q.x) < q.w / 2 && Math.abs(L.pos.z - q.z) < q.d / 2); if (!b) continue;
      const p = THREAT[b.threat].luck; L.items = L.items.map((it) => (it.tier === 'common' && Math.random() < p ? rollItem(4) : it));
    }
    for (const b of world.buildings) if (b.threat === 'critical') (kindsDue || (kindsDue = [])).push([b, 'heavy']); // critical sites get a heavy as well
    // vault cases are locked: one keycard is hidden in a secure crate (heavies and marksmen sometimes carry one too)
    const secure = lootables.filter((L) => L.kind === 'secure');
    if (secure.length) secure[Math.floor(Math.random() * secure.length)].items.push({ supply: 'key', name: 'Keycard' });
  }

  function take(item) {
    if (item.weapon) {
      const slot = ctx.weapons && ctx.weapons.inventory.find((v) => v.def.id === item.weapon);
      if (!slot) return true;
      if (slot.locked) { slot.locked = false; slot.mag = slot.def.mag; slot.reserve = slot.def.reserve; raidGuns.add(item.weapon); chime([415, 520, 620, 830], 0.06, 0.3, 0.2, 'square'); toast(`+ ${esc(slot.def.name)} <span style="opacity:.7">weapon — extract to keep it</span>`, '#ff8a3c'); }
      else { slot.reserve = slot.def.reserve; toast(`+ ${esc(slot.def.name)} ammo`, '#ffc56b'); }
      return true;
    }
    if (item.supply === 'ammoFull') { if (ctx.weapons && ctx.weapons.addAmmo) ctx.weapons.addAmmo(1); return true; }
    if (item.supply === 'bag') {
      if (item.size <= bagBonus) { toast(`${esc(item.name)} — no bigger than the pack you carry`, '#c9d1d9'); return true; }
      bagBonus = item.size; foundBag = item.size; chime([520, 780, 1040], 0.07, 0.3, 0.2);
      toast(`+ ${esc(item.name)} <span style="opacity:.7">pack now holds ${packSize()}</span>`, '#ffc56b'); return true;
    }
    if (item.supply === 'key') { keycards++; chime([880, 1175, 1568], 0.07, 0.3, 0.2); toast('+ Keycard <span style="opacity:.7">opens the strongroom on the plaza</span>', '#d48bff'); return true; }
    if (item.supply) chime([440], 0.05, 0.1, 0.12, 'square');
    if (item.supply === 'medkit') { if (medkits >= 4) return false; medkits++; toast('+ Medkit', '#9be37a'); return true; }
    if (item.supply === 'armor') { if (armor >= 100) return false; armor = Math.min(100, armor + 40); toast('+ Armour plate', '#7fb4ff'); return true; }
    if (item.supply === 'ammo') { if (ctx.weapons && ctx.weapons.addAmmo) ctx.weapons.addAmmo(0.35); toast('+ Ammo', '#ffc56b'); return true; }
    const color = TIERS[item.tier].color;
    chime(...TIER_SOUND[item.tier]);
    if (pack.length < packSize()) { pack.push(item); toast(`+ ${esc(item.name)} <span style="opacity:.7">${item.value} cr</span>`, color); return true; }
    // full: swap out the least valuable thing carried if this is worth more
    let worst = 0; for (let i = 1; i < pack.length; i++) if (pack[i].value < pack[worst].value) worst = i;
    if (pack[worst].value >= item.value) return false;
    toast(`+ ${esc(item.name)} <span style="opacity:.7">${item.value} cr — dropped ${esc(pack[worst].name)}</span>`, color);
    pack[worst] = item; return true;
  }
  // opening a container starts a reveal: items come out one at a time (see update), best saved for last
  function search(L) {
    if (L.kind === 'terminal') { // signal station: see every guard on the map for a minute, and push the reinforcements back
      L.opened = true; L.strip.material = mats(L.kind).dead; revealT = 60; if (ctx.heat) ctx.heat.add(-12); bump(stash, 'terminal');
      toast('Signal tapped — guards are marked on your map (M) for 60 s and the alarm log is scrubbed: heat drops', '#35e0d8'); chime([660, 990, 1320], 0.08, 0.3, 0.2);
      return;
    }
    L.busy = true; chime([300, 380], 0.05, 0.12, 0.12, 'square');
    const order = { common: 0, uncommon: 1, rare: 2, epic: 3 };
    if (ctx.heat && ctx.heat.lootLuck > 0) L.items = L.items.map((it) => (it.tier === 'common' && Math.random() < ctx.heat.lootLuck ? rollItem(4) : it));
    const queue = L.items.slice().sort((p, q) => (p.tier ? order[p.tier] + 1 : 0) - (q.tier ? order[q.tier] + 1 : 0));
    reveal = { L, queue, left: [], t: 0.25, total: queue.length };
    L.items = [];
  }
  function finishReveal() {
    const { L, left } = reveal; reveal = null; L.busy = false; L.items = left;
    if (left.length) toast('Pack full — left the cheaper items behind', '#ff8a70');
    else { L.opened = true; L.strip.material = mats(L.kind).dead; if (L.lid) { L.lid.rotation.z = 0.9; L.lid.position.set(-0.36, 0.72, 0); } if (L.kind === 'bag') L.group.visible = false; }
    if (ctx.heat) ctx.heat.add(L.kind === 'vault' ? 5 : L.kind === 'bag' ? 0.3 : 1.2);
    events.emit('lootTaken', { kind: L.kind, district: L.district });
  }

  for (const b of world.buildings) b.threat = b.outpost ? OUTPOST_THREAT[b.outpost] : b.tower ? (b.floors >= 5 ? 'critical' : b.floors >= 4 ? 'high' : 'medium') : null;
  if (world.strongroom) world.strongroom.threat = 'critical';
  world.threatColors = Object.fromEntries(Object.entries(THREAT).map(([k, v]) => [k, v.color]));

  // ---- contracts ----------------------------------------------------------
  function rollContracts() {
    const pool = CONTRACTS.slice().sort(() => Math.random() - 0.5);
    contracts = pool.slice(0, 2).map((def) => {
      if (def.id === 'district') { // point this one at a district picked for the raid
        const names = Object.keys(DISTRICTS).filter((n) => n !== 'Plaza'), name = names[Math.floor(Math.random() * names.length)];
        def = { ...def, text: `Search 3 containers in ${name === 'Freight Row' ? name : `the ${name}`}`, inc: (e) => (e.district === name ? 1 : 0) };
      }
      return { def, n: 0, done: false };
    });
  }
  const raidState = () => ({ value: packValue(), pack, detected, elapsed: RAID.time - timeLeft });
  const met = (c) => (c.def.check ? c.def.check(raidState()) : c.n >= c.def.goal);
  function contractTick(ev, e) {
    if (state !== 'raid') return;
    for (const c of contracts) {
      if (c.def.ev !== ev || c.n >= c.def.goal) continue;
      c.n = Math.min(c.def.goal, c.n + c.def.inc(e));
      if (c.n >= c.def.goal) { toast(`Contract complete — ${esc(c.def.text)} <span style="opacity:.7">+${c.def.pay} cr on extraction</span>`, '#ffc56b'); chime([520, 780, 1040], 0.08, 0.3, 0.2); }
    }
  }
  events.on('lootTaken', (e) => contractTick('loot', e));
  events.on('botDied', (e) => { if (e.by === player) contractTick('kill', { headshot: !!e.headshot, weapon: ctx.weapons && ctx.weapons.current ? ctx.weapons.current.def.id : '' }); });
  events.on('guardAlert', () => { if (state === 'raid') detected = true; });
  const contractRows = (final) => contracts.map((c) => {
    const ok = final ? c.done : met(c), prog = c.def.goal > 1 ? ` <span style="opacity:.6">${c.n}/${c.def.goal}</span>` : '';
    return `<div style="color:${ok ? '#9be37a' : '#fff'}">${ok ? '✔' : '◻'} ${esc(c.def.text)}${prog} <span style="opacity:.6">+${c.def.pay}</span></div>`;
  }).join('');
  rollContracts();

  // ---- extraction zones ---------------------------------------------------
  const zones = (world.exitPoints || EXITS).map(([x, z]) => {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(RAID.extractRadius, 0.08, 8, 64), new THREE.MeshBasicMaterial({ color: 0x9be37a }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.06; g.add(ring);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 60, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0x9be37a, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false }));
    beam.position.y = 30; g.add(beam);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(RAID.extractRadius, 48), new THREE.MeshBasicMaterial({ color: 0x9be37a, transparent: true, opacity: 0.1, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = 0.03; g.add(disc);
    g.position.set(x, 0, z); g.visible = false; scene.add(g);
    const mark = document.createElement('div'); mark.className = 'rd-mark'; mark.innerHTML = '<i></i><span></span>'; mark.hidden = true; ctx.hud.appendChild(mark);
    return { x, z, group: g, ring, active: false, mark, label: mark.querySelector('span') };
  });

  // ---- armour & supplies --------------------------------------------------
  const rawDamage = player.takeDamage.bind(player);
  player.takeDamage = (amount, info) => {
    if (state === 'raid' && armor > 0 && !(player.protectT > 0)) { const a = Math.min(armor, amount * 0.6); armor -= a; amount -= a; }
    rawDamage(amount, info);
  };

  // ---- flow ---------------------------------------------------------------
  function setBots(on) {
    if (!ctx.bots) return;
    const c = ctx.bots.config; c.ffa = false; c.damage = RAID.botDamage; c.respawnDelay = RAID.botRespawn; c.maxAttackers = 2;
    ctx.bots.setCount(on ? RAID.bots : 0);
    if (on && ctx.bots.respawnAll) ctx.bots.respawnAll();
  }
  function deploy() {
    detected = false; for (const c of contracts) { c.n = 0; c.done = false; }
    keycards = 0; phase = 0; lateExit = false; exitSec = 0; revealT = 0; phaseDelay = 0; keyT = 0; holdNeed = RAID.extractHold;
    bagBonus = stash.b && stash.b[0] ? stash.b[0].size : 0; foundBag = 0;
    if (stash.upgrades.scout) revealT = 30; // comms room: the opening picture
    player.maxHp = 100 + (stash.upgrades.health ? 25 : 0); // med bay level 2
    state = 'raid'; timeLeft = RAID.time + (stash.upgrades.time ? 90 : 0); pack = []; holdT = 0; exitT = 0; result = null; reveal = null; raidGuns.clear();
    // everything in the pack comes along: supplies are put to use, valuables ride in the pack (and are at risk)
    medkits = baseMed(); armor = baseArmor(); broughtMed = 0; brought.clear();
    for (const it of stash.pack || []) {
      if (!it) continue;
      if (it.t === 'med') { medkits++; broughtMed++; } else if (it.t === 'plate') armor = Math.min(100, armor + 50);
      else if (it.t === 'loot') pack.push({ name: it.name, tier: it.tier, value: it.value });
    }
    stash.pack = (stash.pack || []).map(() => null); stash.inRaid = true;
    const points = world.spawnPoints || SPAWNS; // at the edge of the site, outside the built-up centre
    let free = points.filter(([x, z]) => player.free(x, 0.01, z, 1.8));
    const quiet = free.filter(([x, z]) => !world.buildings.some((b) => Math.hypot(b.x - x, b.z - z) < 46)); // not on an outpost's doorstep
    if (quiet.length) free = quiet;
    const [sx, sz] = free[Math.floor(Math.random() * free.length)] || points[0];
    world.spawn.set(sx, 0, sz); world.spawnYaw = Math.atan2(sx, sz);
    // the two exits farthest from where you start, so every raid means crossing the map
    const order = zones.slice().sort((a, b) => Math.hypot(b.x - sx, b.z - sz) - Math.hypot(a.x - sx, a.z - sz));
    // three ways out: the far gate is free, the near one needs a keycard, and the beacon exit takes 20 s and calls guards in
    const EXIT_TYPES = { open: [0x9be37a, 'EXIT'], key: [0xd48bff, 'KEY EXIT'], beacon: [0xffc56b, 'BEACON'] };
    zones.forEach((zn) => { zn.active = false; zn.unlocked = false; zn.alarmed = false; zn.type = 'open'; });
    order[0].active = true; if (order.length > 2) { const k = order[order.length - 1]; k.active = true; k.type = 'key'; const b = order[Math.floor(order.length / 2)]; b.active = true; b.type = 'beacon'; } else if (order[1]) order[1].active = true;
    zones.forEach((zn) => { const [hex, label] = EXIT_TYPES[zn.type]; zn.title = label; zn.css = `#${hex.toString(16).padStart(6, '0')}`; zn.group.visible = zn.active; zn.group.traverse((o) => { if (o.material && o.material.color) o.material.color.setHex(hex); }); });
    player.protectTime = RAID.protect; player.respawn();
    if (ctx.weapons) { // deploy with the sidearm only; everything else comes from arms lockers
      const inv = ctx.weapons.inventory, start = inv.some((v) => v.def.id === 'pistol') ? 'pistol' : 'rifle';
      for (const v of inv) { v.locked = v.def.id !== start; v.mag = v.def.mag; v.reserve = v.def.reserve; }
      const sidearm = inv.find((v) => v.def.id === 'pistol'); if (sidearm) sidearm.def.suppressed = !!stash.upgrades.suppressor;
      // weapons chosen on the stash screen leave the armoury now; they only come back if you extract
      for (const it of stash.w || []) { const slot = it && inv.find((v) => v.def.id === it.id); if (slot) { slot.locked = false; brought.add(it.id); } }
      saveStash(stash);
      ctx.weapons.switchTo(inv.findIndex((v) => v.def.id === start), true);
    }
    placeCrates(); setBots(true);
    panel.hidden = true; if (menu) menu.hide();
    events.emit('raidStart', {});
    if (ctx.turrets && ctx.turrets.add) for (const b of world.buildings) { // high and critical sites are covered by a turret at the door
      if (b.threat !== 'high' && b.threat !== 'critical') continue;
      const sx = Math.random() < 0.5 ? -1 : 1;
      ctx.turrets.add(b.x + sx * (b.w / 2 + 3), b.z + b.d / 2 + 2.5, Math.atan2(sx * 0.4, 1));
    }
  }
  function endRaid(kind) {
    if (state !== 'raid') return;
    const value = packValue();
    const nameOf = (id) => { const s = ctx.weapons && ctx.weapons.inventory.find((v) => v.def.id === id); return s ? s.def.name : id; };
    const items = pack.slice().sort((a, b) => b.value - a.value), guns = [...raidGuns].filter((id) => !brought.has(id)).map(nameOf);
    result = { kind, value, items, guns, saved: null, bonus: 0, hazard: 0, heat: ctx.heat ? ctx.heat.tier : 1, heatName: ctx.heat ? ctx.heat.name : '', at: ctx.time, shown: 0 };
    for (const c of contracts) c.done = kind === 'extracted' && met(c);
    stash.inRaid = false;
    if (kind === 'extracted') {
      result.bonus = contracts.reduce((a, c) => a + (c.done ? c.def.pay : 0), 0); stash.credits += result.bonus;
      result.hazard = Math.round(value * (ctx.heat ? ctx.heat.bonus : 0)); stash.credits += result.hazard;
      stash.extracted++; stash.best = Math.max(stash.best, value);
      const took = RAID.time - timeLeft; stash.fastest = stash.fastest ? Math.min(stash.fastest, took) : took;
      stash.streak = (stash.streak || 0) + 1; stash.bestStreak = Math.max(stash.bestStreak || 0, stash.streak); stash.tutorialDone = true;
      // the haul stays in your pack for you to sort; unused medkits you brought come back; found weapons go to the stash
      if (foundBag) { const old = stash.b && stash.b[0]; stash.b = [{ t: 'bag', size: foundBag }]; if (old) menu.addToStash(old); } // the bigger backpack is now yours
      const back = items.map((i) => ({ t: 'loot', name: i.name, tier: i.tier, value: i.value }));
      for (let n = Math.min(broughtMed, Math.max(0, medkits - baseMed())); n > 0; n--) back.push({ t: 'med' });
      stash.pack = back; menu.normalise();
      for (const extra of stash.pack.splice(packSize())) if (extra) menu.addToStash(extra);
      for (const id of raidGuns) if (!brought.has(id)) { menu.addToStash({ t: 'weapon', id }); bump(stash, 'foundGun'); }
      if (stash.streak >= 3) bump(stash, 'streak3');
      chime([520, 660, 780, 1040, 1320], 0.09, 0.45, 0.2);
    } else {
      stash.lost++; stash.streak = 0; stash.pack = []; stash.w = [null, null]; stash.b = [null];
      if (stash.upgrades.pouch && items.length) { result.saved = items[0]; menu.addToStash({ t: 'loot', name: items[0].name, tier: items[0].tier, value: items[0].value }); }
      result.guns = [...new Set([...raidGuns, ...brought])].map(nameOf);
      menu.normalise();
      chime([330, 262, 196], 0.14, 0.4, 0.16, 'sawtooth');
    }
    raidGuns.clear(); reveal = null; closePack(false);
    saveStash(stash);
    state = 'result'; pack = []; setBots(false);
    zones.forEach((zn) => { zn.group.visible = false; zn.mark.hidden = true; });
    hold.hidden = true; clearLootables();
    events.emit('raidEnd', { kind, value });
  }
  events.on('playerDied', () => endRaid('kia'));
  events.on('botDied', (e) => {
    if (state !== 'raid' || !e.point) return;
    if (e.by === player) { // progress on trader tasks
      if (e.bot && e.bot.kind === 'drone') bump(stash, 'droneKill'); else if (e.bot && e.bot.kind === 'heavy') bump(stash, 'heavyKill');
      if (ctx.weapons && ctx.weapons.current && ctx.weapons.current.def.id === 'pistol' && !(e.bot && (e.bot.kind === 'drone' || e.bot.kind === 'turret'))) bump(stash, 'pistolKill');
    }
    // tougher enemy types carry better loot
    const rich = e.bot && (e.bot.kind === 'heavy' || e.bot.kind === 'marksman');
    const L = addLootable('bag', e.point.x + rnd(-0.4, 0.4), floorBelow(e.point.x, e.point.y, e.point.z), e.point.z + rnd(-0.4, 0.4), Math.random() * 3);
    if (rich) { L.items = rollContents('secure'); if (Math.random() < 0.35) L.items.push({ supply: 'key', name: 'Keycard' }); }
  });
  events.on('shot', (e) => { if (e.by === player && state === 'raid') player.protectT = 0; });

  function renderStash() {
    const ups = UPGRADES.map((u) => {
      const owned = !!stash.upgrades[u.id], can = stash.credits >= u.cost;
      return `<tr class="${owned ? 'dim' : ''}"><td><kbd>${u.label}</kbd></td><td>${u.name}<br><span style="opacity:.6;font-size:11px">${u.desc}</span></td><td>${owned ? 'Owned' : `${u.cost} cr${can ? '' : ' <span style="opacity:.5">(short)</span>'}`}</td></tr>`;
    }).join('');
    const guns = GUNS.map(([id, , label, cost]) => {
      const slot = ctx.weapons && ctx.weapons.inventory.find((v) => v.def.id === id); if (!slot) return '';
      const n = stash.armory[id] || 0;
      return `<tr><td><kbd>${label}</kbd></td><td>${esc(slot.def.name)} <span style="opacity:.6">× ${n} owned</span></td><td>Buy ${cost} cr${stash.credits >= cost ? '' : ' <span style="opacity:.5">(short)</span>'}</td></tr>`;
    }).join('');
    panel.innerHTML = `<div class="box"><h2>Stash</h2><p>${stash.credits} credits banked · ${stash.extracted} extractions · ${stash.lost} raids lost · best haul ${stash.best} cr</p>
      <p style="margin:10px 0 4px;letter-spacing:2px;text-transform:uppercase;font-size:10px">Weapon shop — press the number to buy one</p>
      <table>${guns}</table>
      <p style="margin:12px 0 4px;letter-spacing:2px;text-transform:uppercase;font-size:10px">Upgrades</p>
      <table>${ups}</table>
      <p style="margin-top:12px">Weapons found in orange arms lockers join your armoury if you extract with them. Hold <kbd>F</kbd> to search, <kbd>H</kbd> uses a medkit, <kbd>Tab</kbd> shows your pack.</p>
      <div class="go">Press Enter to choose your loadout</div></div>`;
  }
  // Loadout: what you carry into this raid. Everything chosen here is at risk.
  const SUPPLIES = { med: { key: 'KeyH', label: 'H', name: 'Extra medkit', cost: 150, max: 4 }, plate: { key: 'KeyT', label: 'T', name: 'Armour plate (+50)', cost: 300, max: 100 } };
  const baseMed = () => (stash.upgrades.medic ? 3 : 1), baseArmor = () => (stash.upgrades.armor ? 50 : 0);
  function renderLoadout() {
    let risk = 0;
    const guns = GUNS.map(([id, , label, cost]) => {
      const slot = ctx.weapons && ctx.weapons.inventory.find((v) => v.def.id === id); if (!slot) return '';
      const n = stash.armory[id] || 0, bring = n > 0 && stash.bring[id];
      if (bring) risk += cost;
      const right = n === 0 ? '<span style="opacity:.5">None owned</span>' : bring ? '<span style="color:#ff8a3c">Bringing</span>' : 'Leaving in the stash';
      return `<tr class="${n === 0 ? 'dim' : ''}"><td><kbd>${label}</kbd></td><td>${esc(slot.def.name)} <span style="opacity:.6">× ${n}</span></td><td>${right}</td></tr>`;
    }).join('');
    const med = baseMed() + extraMed, arm = baseArmor() + extraArmor;
    const pistol = ctx.weapons && ctx.weapons.inventory.find((v) => v.def.id === 'pistol');
    panel.innerHTML = `<div class="box"><h2>Loadout</h2><p>${stash.credits} credits · weapons at risk worth ${risk} cr</p>
      <p style="margin:10px 0 4px;letter-spacing:2px;text-transform:uppercase;font-size:10px">Weapons — press the number to bring or leave</p>
      <table><tr><td><kbd>1</kbd></td><td>${pistol ? esc(pistol.def.name) : 'Pistol'}</td><td>Always carried</td></tr>${guns}</table>
      <p style="margin:12px 0 4px;letter-spacing:2px;text-transform:uppercase;font-size:10px">Supplies for this raid</p>
      <table>
        <tr><td><kbd>H</kbd></td><td>Medkits <span style="opacity:.6">× ${med}</span></td><td>${med >= SUPPLIES.med.max ? 'Full' : `Buy one ${SUPPLIES.med.cost} cr`}</td></tr>
        <tr><td><kbd>T</kbd></td><td>Armour <span style="opacity:.6">${arm}</span></td><td>${arm >= SUPPLIES.plate.max ? 'Full' : `Add a plate ${SUPPLIES.plate.cost} cr`}</td></tr>
        <tr><td></td><td>Pack</td><td>${packSize()} slots${stash.upgrades.pouch ? ' · secure pouch' : ''}</td></tr>
      </table>
      <p style="margin:12px 0 4px;letter-spacing:2px;text-transform:uppercase;font-size:10px">Contracts — paid if you extract</p>
      <div style="font-size:13px;line-height:1.6">${contractRows(false)}</div>
      <div class="go">Enter to deploy · Backspace to return to the stash</div></div>`;
  }
  function renderResult() {
    const shown = result.kind === 'extracted' ? Math.min(result.items.length, Math.floor((ctx.time - result.at) / 0.22)) : result.items.length;
    if (shown > (result.shown || 0) && result.kind === 'extracted') { result.shown = shown; chime([520 + shown * 60], 0.05, 0.12, 0.14); }
    const tally = result.items.slice(0, shown).reduce((a, i) => a + i.value, 0);
    const t = { extracted: ['Extracted', `Haul worth <b style="color:#ffc56b;font-size:16px">${tally}</b> credits is in your pack — store or sell it in the stash`], kia: ['Killed in action', `Lost a pack worth ${result.value} credits`], mia: ['Missing in action', `Time ran out — lost a pack worth ${result.value} credits`] }[result.kind];
    const rows = result.items.slice(0, shown).map((i) => `<tr><td style="color:${TIERS[i.tier].color}">${esc(i.name)}${result.saved === i ? ' <span style="color:#9be37a">— saved by the secure pouch, sent to your stash</span>' : ''}</td><td>${i.value} cr</td></tr>`).join('') || '<tr><td class="dim">Empty pack</td><td></td></tr>';
    const guns = result.guns.length ? `<p style="margin-top:10px;color:${result.kind === 'extracted' ? '#9be37a' : '#ff8a70'}">${result.kind === 'extracted' ? 'Weapons found — sent to your stash' : 'Weapons lost'}: ${result.guns.map(esc).join(', ')}</p>` : '';
    panel.innerHTML = `<div class="box"><h2>${t[0]}</h2><p>${t[1]}</p><table>${rows}</table>${result.hazard ? `<p style="color:#ff9a3c">Hazard pay — left at heat ${result.heat} (${result.heatName}): <b>+${result.hazard} cr</b> paid to your account</p>` : ''}${guns}<p style="margin:12px 0 4px;letter-spacing:2px;text-transform:uppercase;font-size:10px">Contracts${result.bonus ? ` — bonus ${result.bonus} cr` : ''}</p><div style="font-size:13px;line-height:1.6">${contractRows(true)}</div><div class="go">Press Enter — a new map layout loads, then click to continue</div></div>`;
  }
  // ---- in-raid pack screen (Tab): tiles you can rearrange or drag out to drop. The raid keeps running while it is open.
  const pui = el('rd-packui'); pui.hidden = true;
  let pdrag = null, pghost = null;
  function renderPackUI() {
    const cells = Array.from({ length: packSize() }, (_, i) => `<div class="slot" data-pi="${i}">${pack[i] ? menu.tile({ t: 'loot', ...pack[i] }) : ''}</div>`).join('');
    const guns = ctx.weapons ? ctx.weapons.inventory.filter((v) => !v.locked).map((v) => esc(v.def.name)).join(' · ') : '';
    pui.innerHTML = `<div class="box"><h2>Pack ${pack.length}/${packSize()}</h2><p>Worth ${packValue()} credits if you get out${bagBonus ? ` · ${esc(BAGS[bagBonus].name)} +${bagBonus}` : ''}</p>
      <div class="pgrid">${cells}</div>
      <div class="pdrop" data-drop="1">Drag here to drop</div>
      <p style="margin-top:12px">Carrying: ${guns}<br>Medkits ${medkits} · Armour ${Math.round(armor)}${keycards ? ` · Keycards ${keycards}` : ''}</p>
      <div class="go" data-close="1" style="cursor:pointer">Tab or click to close</div></div>`;
  }
  function openPack() { packOpen = true; ctx.uiOpen = true; renderPackUI(); pui.hidden = false; if (document.pointerLockElement) document.exitPointerLock(); }
  function closePack(relock = true) { if (!packOpen) return; packOpen = false; ctx.uiOpen = false; pui.hidden = true; if (pghost) { pghost.remove(); pghost = null; } pdrag = null; if (relock && ctx.relock) ctx.relock(); }
  pui.addEventListener('mousedown', (e) => {
    const s = e.target.closest('[data-pi]'); if (!s || e.button !== 0) return;
    const i = Number(s.dataset.pi); if (!pack[i]) return;
    pdrag = i; pghost = document.createElement('div'); pghost.id = 'iv-ghost'; pghost.innerHTML = menu.tile({ t: 'loot', ...pack[i] }); document.body.appendChild(pghost);
    pghost.style.left = `${e.clientX}px`; pghost.style.top = `${e.clientY}px`; e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => { if (pghost) { pghost.style.left = `${e.clientX}px`; pghost.style.top = `${e.clientY}px`; } });
  window.addEventListener('mouseup', (e) => {
    if (pdrag === null) return;
    const at = document.elementFromPoint(e.clientX, e.clientY), slot = at && at.closest('[data-pi]'), drop = at && at.closest('[data-drop]');
    if (drop) { // dropped items land at your feet as a pack you can search again
      const [it] = pack.splice(pdrag, 1);
      const L = addLootable('bag', player.pos.x + rnd(-0.5, 0.5), floorBelow(player.pos.x, player.pos.y, player.pos.z), player.pos.z + rnd(-0.5, 0.5), Math.random() * 3); L.items = [it];
      chime([300], 0.05, 0.12, 0.12, 'square');
    } else if (slot) { const j = Math.min(Number(slot.dataset.pi), pack.length - 1); const it = pack[pdrag]; pack[pdrag] = pack[j]; pack[j] = it; }
    if (pghost) pghost.remove(); pghost = null; pdrag = null; renderPackUI();
  });
  pui.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closePack(); });

  function renderPack() {
    const rows = pack.slice().sort((a, b) => b.value - a.value).map((i) => `<tr><td style="color:${TIERS[i.tier].color}">${esc(i.name)}</td><td>${i.value} cr</td></tr>`).join('') || '<tr><td class="dim">Nothing yet</td><td></td></tr>';
    panel.innerHTML = `<div class="box"><h2>Pack ${pack.length}/${packSize()}</h2><p>Worth ${packValue()} credits if you get out</p><table>${rows}</table></div>`;
  }

  const v = new THREE.Vector3(), fwd = new THREE.Vector3();
  function updateMarkers() {
    camera.getWorldDirection(fwd);
    for (const zn of zones) {
      if (!zn.active || state !== 'raid') { zn.mark.hidden = true; continue; }
      v.set(zn.x, 2.2, zn.z);
      const dist = Math.hypot(zn.x - player.pos.x, zn.z - player.pos.z);
      const behind = v.clone().sub(camera.position).dot(fwd) < 0;
      v.project(camera);
      let sx = v.x, sy = v.y;
      if (behind) { sx = THREE.MathUtils.clamp(-sx, -0.45, 0.45); sy = -1; }
      sx = THREE.MathUtils.clamp(sx, -0.92, 0.92); sy = THREE.MathUtils.clamp(sy, -0.55, 0.8);
      zn.mark.style.left = `${(sx * 0.5 + 0.5) * 100}%`; zn.mark.style.top = `${(-sy * 0.5 + 0.5) * 100}%`;
      zn.label.textContent = `EXIT ${Math.round(dist)}m`; zn.mark.hidden = false;
      zn.ring.scale.setScalar(1 + Math.sin(ctx.time * 3) * 0.02);
    }
  }

  menu = createInventory(ctx, {
    stash, save: () => saveStash(stash), GUNS, UPGRADES, packSize, chime,
    contractsHtml: () => contractRows(false),
    onDeploy: () => { deploy(); const o = document.getElementById('overlay'); if (o) o.click(); }, // the click also captures the mouse
  });
  ctx.raid = { toast, chime, get heat() { return ctx.heat ? ctx.heat.frac : 0; }, get heatTier() { return ctx.heat ? ctx.heat.tier : 1; }, menu, config: RAID, stash, get state() { return state; }, get pack() { return pack; }, get timeLeft() { return timeLeft; }, set timeLeft(t) { timeLeft = t; }, lootables, zones, deploy, endRaid, get armor() { return armor; }, get contracts() { return contracts; }, get keycards() { return keycards; }, get revealT() { return revealT; }, get packOpen() { return packOpen; }, get bagBonus() { return bagBonus; }, packSize, set keycards(n) { keycards = n; }, get phase() { const t = ctx.heat ? ctx.heat.tier : 1; return t >= 4 ? 2 : t >= 2 ? 1 : 0; }, setContracts(ids) { contracts = ids.map((id) => ({ def: CONTRACTS.find((c) => c.id === id), n: 0, done: false })); }, get medkits() { return medkits; } };
  setBots(false); player.protectT = 1e9;
  panel.hidden = true; menu.show(); saveStash(stash);

  return {
    update(dt) {
      if (state !== 'raid') {
        player.protectT = 1e9; top.hidden = true; kit.hidden = true; hold.hidden = true; panel.hidden = false; cbox.hidden = true; hint.hidden = true;
        if (state === 'stash') {
          // the stash is a mouse-driven screen: release the pointer and show it
          panel.hidden = true; menu.show();
          if (document.pointerLockElement) document.exitPointerLock();
        } else {
          renderResult();
          if (input.pressed.has('Enter') && !reloading) {
            // a fresh page load rolls a new map layout (and repairs everything that was blown up)
            reloading = true;
            setTimeout(() => { reloading = false; state = 'stash'; rollContracts(); }, 2500); // if the reload is blocked, carry on with this layout
            try { location.reload(); } catch { reloading = false; state = 'stash'; }
          }
        }
        return;
      }
      top.hidden = false; kit.hidden = false; cbox.hidden = false;
      if (tick10++ % 10 === 0) cbox.innerHTML = `<div class="h">Contracts</div>${contractRows(false)}`;
      timeLeft -= dt; healCd -= dt;
      if (timeLeft <= 0) { endRaid('mia'); return; }

      // medkit
      if (input.pressed.has('KeyH') && medkits > 0 && healCd <= 0 && player.hp < player.maxHp) { medkits--; healCd = 1; player.hp = Math.min(player.maxHp, player.hp + 60); toast('Medkit used', '#9be37a'); }

      // loot that lost its floor falls to the next one down
      tick++;
      for (let i = 0; i < lootables.length; i++) {
        const L = lootables[i];
        if (L.vy === 0 && (tick + i) % 20) continue; // resting loot only re-checks its floor now and then
        const fy = floorBelow(L.pos.x, L.pos.y, L.pos.z);
        if (L.pos.y > fy + 0.02) { L.vy -= 24 * dt; L.pos.y = Math.max(fy, L.pos.y + L.vy * dt); } else { L.vy = 0; L.pos.y = fy; }
        if (L.kind === 'bag' && !L.opened && ctx.time - L.born > 90) { L.opened = true; L.group.visible = false; }
      }

      // searching: nearest unopened container within reach, roughly in front of you
      camera.getWorldDirection(fwd); target = null; let best = 2.4;
      for (const L of lootables) {
        if (L.opened || L.busy) continue;
        v.set(L.pos.x - player.pos.x, 0, L.pos.z - player.pos.z); const d = v.length();
        if (d > best || Math.abs(L.pos.y - player.pos.y) > 1.6) continue;
        if (d > 0.8 && v.normalize().dot(fwd) < 0.2) continue;
        best = d; target = L;
      }
      if (reveal) {
        reveal.t -= dt;
        if (reveal.t <= 0) {
          const it = reveal.queue.shift();
          if (it && !take(it)) reveal.left.push(it);
          reveal.t = it && (it.tier === 'rare' || it.tier === 'epic') ? 0.5 : 0.3;
          if (!reveal.queue.length) finishReveal();
        }
      }
      // the strongroom door: a keycard opens it, and opening it brings reinforcements at once
      const sr = world.strongroom;
      if (sr && !sr.open && !target && Math.hypot(player.pos.x - sr.x, player.pos.z - sr.z) < 2.3 && Math.abs(player.pos.y - sr.y) < 1.2) {
        if (keycards > 0 && input.down('KeyF')) {
          doorT += dt;
          if (doorT >= 1.5) {
            sr.open = true; keycards--; doorT = 0; world.removeCollider(sr.door); bump(stash, 'strongroom');
            toast('Strongroom open — the alarm is calling guards in', '#d48bff'); chime([330, 440, 330, 440], 0.16, 0.3, 0.22, 'sawtooth');
            if (ctx.heat) ctx.heat.add(16);
          }
        } else doorT = 0;
        if (!player.prompt) player.prompt = keycards > 0 ? 'Hold <b>F</b> — use keycard on the strongroom door' : 'Strongroom sealed — needs a <b>keycard</b>';
      } else doorT = 0;
      const lockedOut = target && target.locked && keycards <= 0;
      if (target && !lockedOut && input.down('KeyF')) {
        holdT += dt;
        if (holdT >= CRATES[target.kind].time) { if (target.locked) { target.locked = false; keycards--; toast('Keycard used', '#d48bff'); } search(target); holdT = 0; }
      } else holdT = 0;
      if (target && !player.prompt) player.prompt = lockedOut ? 'Vault case locked — needs a <b>keycard</b>' : `Hold <b>F</b> — ${target.locked ? 'use keycard on' : target.kind === 'terminal' ? 'tap' : 'search'} ${CRATES[target.kind].label}`;

      // extraction
      let zoneNow = null;
      for (const zn of zones) if (zn.active && Math.hypot(zn.x - player.pos.x, zn.z - player.pos.z) < RAID.extractRadius && player.pos.y < 2) zoneNow = zn;
      if (zoneNow && zoneNow.type === 'key' && !zoneNow.unlocked) { // the short way out costs the keycard you could have spent on the strongroom
        if (keycards > 0 && input.down('KeyF')) { keyT += dt; if (keyT >= 1) { zoneNow.unlocked = true; keycards--; keyT = 0; toast('Exit unlocked', '#d48bff'); chime([660, 880, 1320], 0.07, 0.25, 0.2); } } else keyT = 0;
        if (!zoneNow.unlocked) { if (!player.prompt) player.prompt = keycards > 0 ? 'Hold <b>F</b> — use a keycard to open this exit' : 'This exit needs a <b>keycard</b>'; zoneNow = null; }
      }
      if (zoneNow && zoneNow.type === 'beacon' && !zoneNow.alarmed) {
        zoneNow.alarmed = true; toast('Beacon lit — hold this zone for 20 seconds. Guards are on their way.', '#ffc56b'); chime([330, 440, 330, 440], 0.16, 0.3, 0.22, 'sawtooth');
        if (ctx.heat) { ctx.heat.add(14); ctx.heat.hunt(3); }
      }
      const inZone = !!zoneNow;
      if (inZone && exitT === 0 && ctx.heat && ctx.heat.tier >= 3 && ctx.time - exitCallT > 30) { exitCallT = ctx.time; ctx.heat.hunt(ctx.heat.tier - 1); toast('Guards are converging on the exit', '#ff8a70'); } holdNeed = zoneNow && zoneNow.type === 'beacon' ? 20 : RAID.extractHold;
      exitT = inZone ? exitT + dt : 0;
      // the extraction countdown is audible, rising as it nears the end
      if (inZone && Math.floor(exitT) >= exitSec) { chime([440 + Math.min(exitSec, 9) * 90], 0.05, 0.14, 0.16, 'square'); exitSec++; } else if (!inZone) exitSec = 0;
      // the longer you stay, the more guards arrive, and they are replaced faster
      const elapsed = RAID.time - timeLeft;
      if (revealT > 0) revealT -= dt;
      if (kindsDue && elapsed > 4 && ctx.bots) { // the armoury is held by a heavy and the watch post by the marksman
        for (const [b, kind] of kindsDue) {
          const g = ctx.bots.list.filter((x) => x.alive && x.kind === 'grunt').sort((p, q) => Math.hypot(p.pos.x - b.x, p.pos.z - b.z) - Math.hypot(q.pos.x - b.x, q.pos.z - b.z))[0];
          if (g && Math.hypot(g.pos.x - b.x, g.pos.z - b.z) < 45) { g.setKind(kind); g.maxHp = g.cfg.hp; g.hp = g.cfg.hp; }
        }
        kindsDue = null;
      }
      // with three minutes left an emergency exit opens at the spare zone nearest to you
      if (!lateExit && timeLeft < 180) {
        lateExit = true;
        const spare = zones.filter((zn) => !zn.active).sort((a, b) => Math.hypot(a.x - player.pos.x, a.z - player.pos.z) - Math.hypot(b.x - player.pos.x, b.z - player.pos.z))[0];
        if (spare) { spare.active = true; spare.type = 'open'; spare.title = 'EXIT'; spare.css = '#9be37a'; spare.group.traverse((o) => { if (o.material && o.material.color) o.material.color.setHex(0x9be37a); }); spare.group.visible = true; toast('Emergency exit open', '#9be37a'); chime([660, 880], 0.1, 0.3, 0.18); }
      }
      if (exitT >= holdNeed) { endRaid('extracted'); return; }

      if (inZone) everInZone = true;
      hint.hidden = true; // the first-raid hint banner was removed: the controls are listed on the pause and inventory screens
      const showBar = inZone || holdT > 0 || !!reveal || doorT > 0;
      hold.hidden = !showBar;
      if (showBar) {
        hold.firstChild.textContent = inZone ? `Extracting ${(holdNeed - exitT).toFixed(1)}s` : holdT > 0 ? 'Searching' : doorT > 0 ? 'Opening' : 'Looting';
        const frac = doorT > 0 ? doorT / 1.5 : inZone ? exitT / holdNeed : holdT > 0 && target ? holdT / CRATES[target.kind].time : reveal ? 1 - reveal.queue.length / Math.max(1, reveal.total) : 0;
        hold.querySelector('i').style.width = `${Math.min(1, frac) * 100}%`;
      }
      updateMarkers();

      const m = Math.floor(timeLeft / 60), s = Math.floor(timeLeft % 60);
      line.innerHTML = `<b style="color:#ffc56b;font-weight:600">${districtAt(player.pos.x, player.pos.z).toUpperCase()}</b><span>·</span>${m}:${String(s).padStart(2, '0')}<span>·</span>Pack ${pack.length}/${packSize()}<span>·</span>${packValue()} cr`;
      line.style.color = timeLeft < 60 ? '#ff8a70' : '#fff';
      const shielded = player.protectT > 0; sub.hidden = !shielded;
      if (shielded) sub.textContent = `Shielded ${player.protectT.toFixed(1)}s`;
      kit.innerHTML = `${keycards ? `<span style="color:#d48bff">Keycards <b style="color:#d48bff">${keycards}</b></span> · ` : ''}Medkits <b>${medkits}</b> <span style="opacity:.6">H</span> · Armour <b>${Math.round(armor)}</b><div class="bar"><i style="width:${armor}%"></i></div>`;
      panel.hidden = true;
      if (input.pressed.has('Tab')) { if (packOpen) closePack(); else openPack(); }
      if (packOpen && pdrag === null && tick % 20 === 0) renderPackUI(); // keep it current while loot comes in
    },
  };
}
