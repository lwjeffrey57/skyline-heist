import * as THREE from 'three';
import { WEAPONS, FEEL } from './weapons/defs.js';

// THE FIRING RANGE: a platform high above the site with every gun unlocked, endless ammunition, and one of each enemy
// type standing still. T frees the mouse to move sliders that change the gun in your hands as you play; the numbers
// are saved in this browser (they carry into raids) and "Copy my numbers" writes out everything that was changed.
// ctx.range = { start(), stop(), active }   ctx.tune = { stop, shot, sub, mech } (hit-stop strength and shot volumes)

const Y = 200, HALF_W = 13, Z0 = 40, Z1 = -44; // floor height, half width, the firing line end, the far end
const KINDS = ['grunt', 'shield', 'scout', 'marksman', 'grenadier', 'heavy'];
// one of each type in a row at 12 m, then plain guards at 25 / 45 / 65 m
const SPOTS = KINDS.map((k, i) => [k, (i - 2.5) * 3.4, Z0 - 6 - 12]).concat([['grunt', -3, Z0 - 6 - 25], ['grunt', 3, Z0 - 6 - 45], ['grunt', 0, Z0 - 6 - 65]]);

// [key, label, min, max, step, what it does]
const GUN_SLIDERS = [
  ['rpm', 'Rate of fire', 30, 1200, 5, 'rounds per minute'],
  ['damage', 'Damage', 5, 200, 1, 'per round (per pellet on the scattergun)'],
  ['recoilMul', 'Recoil', 0, 2.5, 0.05, 'how far the aim is thrown by each shot'],
  ['recoil.recover', 'Recoil settle', 2, 30, 0.5, 'how fast the aim comes back'],
  ['kick.z', 'Gun push-back', 0, 0.25, 0.002, 'the gun shoved toward you'],
  ['kick.rx', 'Muzzle flip', 0, 0.4, 0.005, 'the barrel jumping up'],
  ['kick.roll', 'Gun twist', 0, 0.12, 0.002, 'sideways roll of the gun'],
  ['kick.cam', 'View punch', 0, 0.05, 0.0005, 'your whole view jolting'],
  ['kick.fov', 'Zoom punch', 0, 5, 0.05, 'a blink of zoom on each shot'],
  ['spread.bloom', 'Spread growth', 0, 3, 0.02, 'accuracy lost per shot'],
  ['reloadTime', 'Reload time', 0.3, 5, 0.05, 'seconds (per round on round-by-round guns)'],
];
const GLOBAL_SLIDERS = [
  ['stop', 'Freeze on kill', 0, 3, 0.05, '0 = off'],
  ['zoom', 'Zoom pop on kill', 0, 3, 0.05, 'degrees'],
  ['shot', 'Shot volume', 0, 2, 0.05, 'the crack'],
  ['sub', 'Bass volume', 0, 2.5, 0.05, 'the low punch'],
  ['mech', 'Action volume', 0, 2.5, 0.05, 'the metal working'],
];

const pat0 = new Map(WEAPONS.map((w) => [w.id, w.recoil.pattern.map((p) => p.slice())]));
const getG = (w, key) => (key === 'recoilMul' ? w._recoilMul ?? 1 : key === 'reloadTime' ? (w.reload.type === 'shell' ? w.reload.shell : w.reload.time) : key.split('.').reduce((o, k) => o[k], w));
function setG(w, key, v) {
  if (key === 'recoilMul') { w._recoilMul = v; w.recoil.pattern = pat0.get(w.id).map(([u, s]) => [u * v, s * v]); }
  else if (key === 'reloadTime') { if (w.reload.type === 'shell') w.reload.shell = v; else w.reload.time = v; }
  else { const ks = key.split('.'), last = ks.pop(); ks.reduce((o, k) => o[k], w)[last] = v; }
}
const tune = { stop: 1, shot: 1, sub: 1, mech: 1 };
const getGl = (key) => (key === 'zoom' ? FEEL.killFovPunch : tune[key]);
const setGl = (key, v) => { if (key === 'zoom') { FEEL.killFovPunch = v; FEEL.headshotKillFovPunch = v * 1.8; } else tune[key] = v; };

// the shipped numbers, then whatever this browser saved on top of them (before any system reads a gun)
const DEFAULTS = { guns: {}, global: {} };
for (const w of WEAPONS) { DEFAULTS.guns[w.id] = {}; for (const [k] of GUN_SLIDERS) DEFAULTS.guns[w.id][k] = getG(w, k); }
for (const [k] of GLOBAL_SLIDERS) DEFAULTS.global[k] = getGl(k);
let saved = { guns: {}, global: {} };
try { const s = JSON.parse(localStorage.getItem('sh-tune') || 'null'); if (s && s.guns && s.global) saved = s; } catch { /* storage unavailable */ }
for (const w of WEAPONS) for (const k in saved.guns[w.id] || {}) if (k in DEFAULTS.guns[w.id] && Number.isFinite(saved.guns[w.id][k])) setG(w, k, saved.guns[w.id][k]);
for (const k in saved.global) if (k in DEFAULTS.global && Number.isFinite(saved.global[k])) setGl(k, saved.global[k]);
const store = () => { try { localStorage.setItem('sh-tune', JSON.stringify(saved)); } catch { /* storage unavailable */ } };
const fmt = (v) => String(Math.round(v * 10000) / 10000);

export function init(ctx) {
  const { player, world, events, input } = ctx;
  ctx.tune = tune;
  let active = false, built = false, open = false, raiderSquads = null, shownGun = '', statT = 0;

  function build() {
    built = true;
    const flat = (hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.9, metalness: 0 });
    const floor = flat(0x6f757c), wall = flat(0xb9b4a8), line = flat(0xe0a23a), o = { tag: 'range' }, len = Z0 - Z1, mid = (Z0 + Z1) / 2;
    world.addBox(0, Y - 1, mid, HALF_W * 2, 1, len, floor, o);
    world.addBox(0, Y, Z1 - 0.5, HALF_W * 2 + 2, 9, 1, wall, o); world.addBox(0, Y, Z0 + 0.5, HALF_W * 2 + 2, 4, 1, wall, o);
    for (const s of [-1, 1]) world.addBox(s * (HALF_W + 0.5), Y, mid, 1, 4, len, wall, o);
    for (let d = 10; d <= 70; d += 10) world.addBox(0, Y, Z0 - 6 - d, HALF_W * 2, 0.02, d % 20 ? 0.12 : 0.3, line, { solid: false, shadow: false, tag: 'range' }); // a stripe every 10 m, a thick one every 20
    world.addBox(0, Y, Z0 - 6 + 1.2, HALF_W * 2, 0.02, 0.3, flat(0xffffff), { solid: false, shadow: false, tag: 'range' }); // the firing line
  }

  // ---- panel ---------------------------------------------------------------------------------------------------
  const css = document.createElement('style');
  css.textContent = `
    #rg { position: fixed; top: 12px; right: 12px; width: 318px; max-height: calc(100vh - 24px); overflow: auto; background: rgba(12,14,18,.97); border: 1px solid rgba(255,255,255,.18); color: #fff; font-size: 11px; letter-spacing: .5px; padding: 10px 12px; pointer-events: none; z-index: 30; }
    #rg.open { pointer-events: auto; border-color: #e0a23a; }
    #rg h4 { margin: 8px 0 4px; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #e0a23a; }
    #rg .hd { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; opacity: .8; }
    #rg .gn { font-size: 16px; font-weight: 700; letter-spacing: 2px; margin: 2px 0; }
    #rg .st { opacity: .8; margin-bottom: 4px; }
    #rg .row { display: grid; grid-template-columns: 96px 1fr 50px; gap: 6px; align-items: center; height: 19px; }
    #rg .row b { font-weight: 400; text-align: right; font-variant-numeric: tabular-nums; }
    #rg .row.ch span { color: #ffd166; }
    #rg input[type=range] { width: 100%; margin: 0; accent-color: #e0a23a; }
    #rg .guns { display: flex; flex-wrap: wrap; gap: 3px; }
    #rg button { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.25); color: #fff; font: inherit; padding: 3px 6px; cursor: pointer; }
    #rg button.on { background: #e0a23a; color: #111; border-color: #e0a23a; }
    #rg .acts { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    #rg textarea { width: 100%; height: 90px; margin-top: 6px; background: #0b0d10; color: #cfe; border: 1px solid rgba(255,255,255,.25); font: 10px/1.35 monospace; box-sizing: border-box; }
    #rg .only { display: none; } #rg.open .only { display: block; } #rg.open .acts { display: flex; }`;
  document.head.appendChild(css);
  const el = document.createElement('div'); el.id = 'rg'; el.hidden = true; ctx.hud.appendChild(el);
  const rowHtml = (scope, [k, label, min, max, step, tip], v, d) => `<div class="row ${Math.abs(v - d) > 1e-9 ? 'ch' : ''}" title="${tip}"><span>${label}</span><input type="range" data-s="${scope}" data-k="${k}" min="${min}" max="${Math.max(max, v)}" step="${step}" value="${v}"><b>${fmt(v)}</b></div>`;
  const cur = () => (ctx.weapons && ctx.weapons.current ? ctx.weapons.current : null);
  function stats(w) {
    const d = (cur() && cur().def) || w, per = d.damage * (d.pellets || 1), n = per > 0 ? Math.ceil(100 / per) : 0;
    const iv = 60 / d.rpm, ttk = n > 0 ? (n - 1) * iv : 0;
    return per > 0 ? `${n} hit${n === 1 ? '' : 's'} to drop a guard · ${ttk.toFixed(2)} s · ${Math.round(per / iv)} damage a second` : 'Explosive';
  }
  function render() {
    const it = cur(); if (!it) return;
    const w = it.base; shownGun = w.id;
    el.innerHTML = `<div class="hd">Firing range · <b style="color:#e0a23a">T</b> ${open ? 'to go back to shooting' : 'to adjust'}</div>
      <div class="gn">${w.name}</div><div class="st" id="rg-st">${stats(w)}</div>
      <div class="only"><div class="guns">${ctx.weapons.inventory.map((v, i) => `<button data-gun="${i}" class="${v === it ? 'on' : ''}">${v.base.name.split(' ')[0]}</button>`).join('')}</div></div>
      <h4>This gun</h4>${GUN_SLIDERS.filter(([k]) => !(w.projectile && (k === 'damage' || k === 'spread.bloom'))).map((r) => rowHtml('g', r, getG(w, r[0]), DEFAULTS.guns[w.id][r[0]])).join('')}
      <h4>Every gun</h4>${GLOBAL_SLIDERS.map((r) => rowHtml('a', r, getGl(r[0]), DEFAULTS.global[r[0]])).join('')}
      <div class="only"><div class="acts"><button data-do="reset">Reset this gun</button><button data-do="resetall">Reset everything</button><button data-do="copy">Copy my numbers</button><button data-do="leave">Leave the range</button></div>
      <textarea id="rg-out" readonly placeholder="Press Copy my numbers, then paste this to Claude"></textarea></div>
      <div class="st" style="margin-top:6px">Yellow = changed from the shipped value. Changes are saved in this browser and apply in raids too.</div>`;
  }
  function applyGun(w) { if (ctx.weapons && ctx.weapons.setAttachments) ctx.weapons.setAttachments(w.id, ctx.weapons.getAttachments(w.id)); } // rebuilds the gun in your hands from the edited numbers
  function report() {
    const lines = [];
    for (const w of WEAPONS) {
      const ch = GUN_SLIDERS.filter(([k]) => Math.abs(getG(w, k) - DEFAULTS.guns[w.id][k]) > 1e-9).map(([k, label]) => `${label} (${k}) ${fmt(DEFAULTS.guns[w.id][k])} -> ${fmt(getG(w, k))}`);
      if (ch.length) lines.push(`${w.name} [${w.id}]: ${ch.join('; ')}`);
    }
    const gl = GLOBAL_SLIDERS.filter(([k]) => Math.abs(getGl(k) - DEFAULTS.global[k]) > 1e-9).map(([k, label]) => `${label} (${k}) ${fmt(DEFAULTS.global[k])} -> ${fmt(getGl(k))}`);
    if (gl.length) lines.push(`Every gun: ${gl.join('; ')}`);
    return lines.length ? `SKYLINE HEIST TUNING\n${lines.join('\n')}` : 'Nothing changed from the shipped numbers.';
  }
  el.addEventListener('input', (e) => {
    const t = e.target; if (!t.dataset || !t.dataset.k) return;
    const v = Number(t.value), k = t.dataset.k, it = cur(); if (!it) return;
    if (t.dataset.s === 'g') { const w = it.base; setG(w, k, v); (saved.guns[w.id] = saved.guns[w.id] || {})[k] = v; applyGun(w); t.parentNode.classList.toggle('ch', Math.abs(v - DEFAULTS.guns[w.id][k]) > 1e-9); const st = el.querySelector('#rg-st'); if (st) st.textContent = stats(w); }
    else { setGl(k, v); saved.global[k] = v; t.parentNode.classList.toggle('ch', Math.abs(v - DEFAULTS.global[k]) > 1e-9); }
    t.nextElementSibling.textContent = fmt(v); store();
  });
  el.addEventListener('click', (e) => {
    const g = e.target.closest('[data-gun]'), a = e.target.closest('[data-do]');
    if (g) { ctx.weapons.switchTo(Number(g.dataset.gun), true); render(); return; }
    if (!a) return;
    const it = cur(), act = a.dataset.do;
    if (act === 'reset' && it) { const w = it.base; for (const [k] of GUN_SLIDERS) setG(w, k, DEFAULTS.guns[w.id][k]); delete saved.guns[w.id]; applyGun(w); store(); render(); }
    else if (act === 'resetall') { for (const w of WEAPONS) { for (const [k] of GUN_SLIDERS) setG(w, k, DEFAULTS.guns[w.id][k]); applyGun(w); } for (const [k] of GLOBAL_SLIDERS) setGl(k, DEFAULTS.global[k]); saved = { guns: {}, global: {} }; store(); render(); }
    else if (act === 'copy') { const txt = report(), out = el.querySelector('#rg-out'); out.value = txt; out.focus(); out.select(); try { navigator.clipboard.writeText(txt).catch(() => {}); } catch { /* select-and-copy by hand */ } }
    else if (act === 'leave') stop();
  });
  function setOpen(v) {
    open = v; ctx.uiOpen = v; el.classList.toggle('open', v); render();
    if (v) { input.keys.clear(); if (document.pointerLockElement) document.exitPointerLock(); } else if (ctx.relock) ctx.relock();
  }

  // ---- start / stop ------------------------------------------------------------------------------------------------
  function start() {
    if (active || !ctx.raid || !ctx.bots) return;
    if (!built) build();
    const R = ctx.bots.config.raiders; if (R && raiderSquads == null) { raiderSquads = R.squads; R.squads = 0; }
    ctx.rangeMode = true; active = true;
    ctx.raid.deploy();
    if (ctx.bots.clearRaiders) ctx.bots.clearRaiders();
    ctx.bots.config.respawnDelay = 2; ctx.bots.setCount(SPOTS.length);
    player.pos.set(0, Y + 0.05, Z0 - 6 + 3); if (player.vel) player.vel.set(0, 0, 0); player.yaw = 0; player.pitch = 0;
    el.hidden = false; open = false; el.classList.remove('open'); render();
    if (ctx.raid.toast) ctx.raid.toast('Firing range: every gun, endless ammunition. Mouse wheel changes gun, T opens the tuning sliders.', '#e0a23a');
  }
  function stop() {
    if (!active) return;
    if (open) { open = false; ctx.uiOpen = false; }
    for (const b of ctx.bots.list) b.dummy = null;
    active = false; el.hidden = true;
    ctx.raid.endRange(); ctx.rangeMode = false;
    const R = ctx.bots.config.raiders; if (R && raiderSquads != null) { R.squads = raiderSquads; raiderSquads = null; }
  }
  events.on('raidEnd', () => { if (active) { active = false; el.hidden = true; ctx.rangeMode = false; for (const b of ctx.bots.list) b.dummy = null; } });
  window.addEventListener('keydown', (e) => { if (active && e.code === 'KeyT' && !e.repeat && ctx.raid.state === 'raid') { e.preventDefault(); setOpen(!open); } });
  ctx.range = { start, stop, get active() { return active; } };

  return {
    update(dt) {
      if (!active) return;
      player.protectT = 999; if (player.hp < player.maxHp) player.hp = player.maxHp;
      if (player.pos.y < Y - 20) { player.pos.set(0, Y + 0.05, Z0 - 3); if (player.vel) player.vel.set(0, 0, 0); } // fell off somehow
      for (const v of ctx.weapons.inventory) { v.locked = false; v.reserve = v.def.reserve; }
      const guards = ctx.bots.guards || ctx.bots.list;
      for (let i = 0; i < SPOTS.length && i < guards.length; i++) {
        const b = guards[i], [kind, x, z] = SPOTS[i];
        if (!b.dummy) b.dummy = { x, y: Y, z };
        if (b.alive && (b.kind !== kind || b.rangeLife !== b.spawnSeq)) { if (b.kind !== kind) { b.setKind(kind); b.spawn(new THREE.Vector3(x, Y, z)); } b.rangeLife = b.spawnSeq; }
      }
      const it = cur();
      if (it && it.base.id !== shownGun) render();
      statT -= dt; if (statT <= 0 && it) { statT = 0.5; const st = el.querySelector('#rg-st'); if (st) st.textContent = stats(it.base); }
    },
  };
}
