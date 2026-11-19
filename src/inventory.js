// Visual inventory shown between raids: drag item tiles between the stash, your pack and two weapon slots,
// drop them on SELL for credits, click shop tiles to buy. Whatever is in the pack and weapon slots when you
// deploy comes with you and is at risk.
//
// Items are plain objects kept in the saved stash:
//   { t: 'weapon', id } | { t: 'loot', name, tier, value } | { t: 'med' } | { t: 'plate' } | { t: 'att', id }
// Attachments fitted to a weapon live in stash.att[weaponId], one entry per slot that weapon has.

const ICON = {
  pistol: 'M3 8h14v4h-6l-1 2H8v5H4v-7H3z',
  rifle: 'M1 10h15V8h3v2h4v2h-7l-1 2h-3v4H9v-4H5l-1 2H1z',
  shotgun: 'M1 11h21v2H12l-1 2H8v3H5v-3H1z',
  sniper: 'M1 11h22v2h-9l-1 2h-3v3H7v-3H1zM8 7h8v2H8z',
  launcher: 'M2 9h14v6H2zM16 10h6v4h-6zM6 15h3v4H6z',
  med: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z',
  plate: 'M12 2l8 3v7c0 5-4 8-8 10-4-2-8-5-8-10V5z',
  att: 'M3 10h12v4H3zM15 9h3v6h-3zM18 10.5h3v3h-3zM6 14h3v4H6z',
  bag: 'M8 3h8v3h2a2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h2zM10 5v1h4V5zM8 12h8v2H8z',
  common: 'M4 8l8-4 8 4v8l-8 4-8-4z',
  uncommon: 'M7 7h10v10H7zM9 3h2v3H9zM13 3h2v3h-2zM9 18h2v3H9zM13 18h2v3h-2zM3 9h3v2H3zM3 13h3v2H3zM18 9h3v2h-3zM18 13h3v2h-3z',
  rare: 'M6 3h12l4 6-10 12L2 9z',
  epic: 'M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z',
};
const WEAPON_ICON = { pistol: 'pistol', rifle: 'rifle', smg: 'rifle', dmr: 'sniper', shotgun: 'shotgun', slug_shotgun: 'shotgun', sniper: 'sniper', launcher: 'launcher', handcannon: 'pistol', lmg: 'rifle', lever: 'sniper', crossbow: 'sniper' };
const COLOR = { common: '#c9d1d9', uncommon: '#5fd38a', rare: '#5aa9ff', epic: '#d48bff', weapon: '#ff8a3c', med: '#9be37a', plate: '#7fb4ff', bag: '#ffc56b' };
export const BAGS = { 4: { name: 'Sling pack', cost: 800 }, 8: { name: 'Field ruck', cost: 2000 } }; // backpacks add this many pack slots
const SUPPLY = { med: { name: 'Medkit', cost: 150, desc: 'Heals 60. Press H in a raid.' }, plate: { name: 'Armour plate', cost: 300, desc: '+50 armour when you deploy.' } };
export const STASH_SLOTS = 40;
import { STATIONS, TRADERS, taskState, stationLevel, canBuild, build, claim, countItem } from './progress.js';
const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

export function createInventory(ctx, api) {
  const { stash, save, GUNS, UPGRADES, packSize, contractsHtml, chime, onDeploy } = api;
  const defOf = (id) => { const s = ctx.weapons && ctx.weapons.inventory.find((v) => v.def.id === id); return s ? s.def : null; };
  const gunCost = (id) => (GUNS.find((g) => g[0] === id) || [0, 0, 0, 600])[3];

  // ---- item helpers ---------------------------------------------------------
  const W = () => ctx.weapons, attOf = (id) => (W() && W().attachment ? W().attachment(id) : null) || { name: id, tier: 'common', price: 200, slot: '?', desc: '' };
  const slotsFor = (wid) => (W() && W().slotsFor ? W().slotsFor(wid) : []);
  const kindOf = (it) => (it.t === 'loot' ? it.tier : it.t === 'att' ? attOf(it.id).tier : it.t);
  const nameOf = (it) => (it.t === 'weapon' ? (defOf(it.id) || { name: it.id }).name : it.t === 'loot' ? it.name : it.t === 'att' ? attOf(it.id).name : it.t === 'bag' ? BAGS[it.size].name : SUPPLY[it.t].name);
  const sellValue = (it) => (it.t === 'att' ? Math.round(attOf(it.id).price * 0.4) : it.t === 'loot' ? it.value : it.t === 'weapon' ? Math.round(gunCost(it.id) * 0.5) : Math.round((it.t === 'bag' ? BAGS[it.size] : SUPPLY[it.t]).cost * 0.5));
  const iconOf = (it) => ICON[it.t === 'weapon' ? WEAPON_ICON[it.id] || 'rifle' : it.t === 'loot' ? it.tier : it.t];
  const fitNames = (id) => { const a = attOf(id); return Array.isArray(a.fits) ? a.fits.map((w) => (defOf(w) || { name: w }).name).join(', ') : 'any gun with the slot'; };
  const describe = (it) => {
    if (it.t === 'weapon') { const d = defOf(it.id); return d ? `${d.tag} · ${d.damage}${d.pellets > 1 ? ` × ${d.pellets}` : ''} damage · ${d.rpm} rpm · ${d.mag} rounds` : 'Weapon'; }
    if (it.t === 'loot') return `${it.tier[0].toUpperCase()}${it.tier.slice(1)} valuable`;
    if (it.t === 'att') { const a = attOf(it.id); return `${a.slot[0].toUpperCase()}${a.slot.slice(1)} attachment — ${a.desc} Fits: ${fitNames(it.id)}. Drag it onto that weapon's ${a.slot} slot.`; }
    if (it.t === 'bag') return `Backpack: +${it.size} pack slots while equipped`;
    return SUPPLY[it.t].desc;
  };
  const accepts = (zone, it, ti = 0) => zone === 'stash' || zone === 'sell' || (zone.startsWith('att_') ? it.t === 'att' && W() && W().fits(it.id, zone.slice(4)) && attOf(it.id).slot === slotsFor(zone.slice(4))[ti] : zone === 'pack' ? it.t !== 'weapon' && it.t !== 'bag' && it.t !== 'att' : zone === 'w' ? it.t === 'weapon' : zone === 'bag' ? it.t === 'bag' : false);

  // ---- saved layout ---------------------------------------------------------
  function normalise() {
    if (!Array.isArray(stash.grid)) stash.grid = [];
    while (stash.grid.length < STASH_SLOTS) stash.grid.push(null);
    if (!Array.isArray(stash.pack)) stash.pack = [];
    if (!Array.isArray(stash.b)) stash.b = [null];
    while (stash.pack.length < packSize()) stash.pack.push(null);
    while (stash.pack.length > packSize()) { const it = stash.pack.pop(); if (it) addToStash(it); } // a smaller backpack: the overflow goes to the stash
    if (!Array.isArray(stash.w)) stash.w = [null, null];
    // weapons owned under the old list-based armoury become tiles
    if (stash.armory) { for (const id in stash.armory) for (let n = 0; n < stash.armory[id]; n++) addToStash({ t: 'weapon', id }); delete stash.armory; delete stash.bring; }
  }
  // puts an item in the first free stash slot; if the stash is full it is sold instead. Returns true if stored.
  function addToStash(it) {
    const i = stash.grid.indexOf(null);
    if (i < 0) { stash.credits += sellValue(it); return false; }
    stash.grid[i] = it; return true;
  }
  const attArr = (wid) => { stash.att = stash.att || {}; const n = slotsFor(wid).length, a = stash.att[wid] || (stash.att[wid] = []); while (a.length < n) a.push(null); return a; };
  const zoneArr = (zone) => (zone.startsWith('att_') ? attArr(zone.slice(4)) : zone === 'stash' ? stash.grid : zone === 'pack' ? stash.pack : zone === 'bag' ? stash.b : stash.w);

  // ---- DOM ------------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    #iv .deploy { position: sticky; bottom: 0; z-index: 2; box-shadow: 0 -10px 18px 6px #0c1016; } /* always reachable, however tall the loadout column gets */
    #iv { position: fixed; inset: 0; z-index: 30; display: grid; grid-template-columns: 300px 1fr 290px; gap: 18px; padding: 22px 26px 16px; background: linear-gradient(160deg, #0a0e13, #10141a); color: #fff; user-select: none; overflow: auto;
      font-family: "Bahnschrift","DIN Alternate","Roboto Condensed","Arial Narrow",system-ui,sans-serif; }
    #iv h1 { margin: 0; font-size: 22px; letter-spacing: 7px; text-transform: uppercase; }
    #iv h3 { margin: 16px 0 7px; font-size: 10px; letter-spacing: 3px; text-transform: uppercase; font-weight: 500; opacity: .65; }
    #iv .cr { font-size: 26px; font-weight: 700; color: #ffc56b; font-variant-numeric: tabular-nums; }
    #iv .cr small { font-size: 11px; letter-spacing: 2px; opacity: .7; margin-left: 5px; }
    #iv .rec { font-size: 11px; letter-spacing: 1px; opacity: .6; }
    #iv .grid { display: grid; gap: 5px; }
    #iv .slot { position: relative; aspect-ratio: 1; background: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.1); }
    #iv .slot.wide { aspect-ratio: auto; height: 62px; }
    #iv .slot.over { border-color: #ffc56b; background: rgba(255,197,107,.12); }
    #iv .slot .ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 9px; letter-spacing: 2px; text-transform: uppercase; opacity: .35; }
    .iv-tile { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; cursor: grab; border: 1px solid var(--c); border-bottom-width: 3px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--c) 16%, transparent), rgba(8,11,15,.6)); color: #fff; overflow: hidden; }
    .iv-tile svg { width: 46%; max-height: 54%; fill: var(--c); filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
    .iv-tile .nm { max-width: 94%; font-size: 9px; letter-spacing: .6px; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .iv-tile .vl { position: absolute; right: 3px; top: 2px; font-size: 9px; color: var(--c); font-variant-numeric: tabular-nums; }
    .iv-tile.row { flex-direction: row; justify-content: flex-start; gap: 10px; padding: 0 10px; }
    .iv-tile.row svg { width: 54px; max-height: 70%; }
    .iv-tile.row .nm { font-size: 12px; letter-spacing: 1.5px; }
    .iv-tile.fixed { cursor: default; }
    #iv-ghost { position: fixed; z-index: 40; width: 62px; height: 62px; pointer-events: none; opacity: .92; transform: translate(-50%, -50%) scale(1.06); }
    #iv-ghost .iv-tile { position: absolute; }
    #iv .shop { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
    #iv .shop .slot { cursor: pointer; }
    #iv .shop .slot:hover { border-color: #ffc56b; }
    #iv .shop .iv-tile { cursor: pointer; }
    #iv .shop .short { opacity: .38; }
    #iv .up { display: flex; justify-content: space-between; gap: 8px; padding: 6px 9px; margin-bottom: 4px; background: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.1); font-size: 12px; letter-spacing: .6px; cursor: pointer; }
    #iv .up:hover { border-color: #ffc56b; }
    #iv .up.own { opacity: .45; cursor: default; border-color: rgba(255,255,255,.1); }
    #iv .up b { color: #ffc56b; font-weight: 600; white-space: nowrap; }
    #iv .tabs { display: flex; gap: 4px; margin-top: 4px; }
    #iv .tabs span { flex: 1; padding: 6px 0; text-align: center; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; background: rgba(255,255,255,.05); cursor: pointer; }
    #iv .tabs span.on { background: #ffc56b; color: #14100a; font-weight: 700; }
    #iv .card { margin-top: 8px; padding: 9px 11px; background: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.1); font-size: 12px; letter-spacing: .5px; line-height: 1.5; }
    #iv .card b { display: block; letter-spacing: 1.5px; text-transform: uppercase; }
    #iv .card .dim { display: block; opacity: .65; font-size: 11px; }
    #iv .card .dim span { opacity: 1; }
    #iv .card .task { margin-top: 5px; }
    #iv .mini.go2 { border-color: #ffc56b; color: #ffc56b; }
    #iv .mini.off { opacity: .4; cursor: default; }
    #iv .sell { display: flex; align-items: center; justify-content: center; height: 54px; margin-top: 8px; border: 1px dashed rgba(255,138,112,.6); color: #ff8a70; font-size: 12px; letter-spacing: 4px; text-transform: uppercase; }
    #iv .sell.over { background: rgba(255,138,112,.16); border-style: solid; }
    #iv button { font: inherit; color: inherit; cursor: pointer; }
    #iv .deploy { width: 100%; margin-top: 14px; padding: 12px; border: 0; background: #ffc56b; color: #14100a; font-size: 15px; font-weight: 700; letter-spacing: 5px; text-transform: uppercase; }
    #iv .deploy:hover { background: #ffd690; }
    #iv .mini { margin-top: 8px; padding: 6px 10px; background: none; border: 1px solid rgba(255,255,255,.25); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; }
    #iv .mini:hover { border-color: #ffc56b; }
    #iv .contracts { font-size: 12px; line-height: 1.6; letter-spacing: .6px; }
    #iv .help { grid-column: 1 / -1; font-size: 11px; letter-spacing: 1px; opacity: .5; }
    #iv-tip { position: fixed; z-index: 45; max-width: 260px; padding: 7px 10px; background: rgba(5,7,10,.96); border-left: 2px solid var(--c, #ffc56b); font-size: 12px; letter-spacing: .5px; pointer-events: none; }
    #iv-tip b { display: block; letter-spacing: 1.5px; text-transform: uppercase; }
    #iv-tip span { opacity: .7; }`;
  document.head.appendChild(style);
  const root = document.createElement('div'); root.id = 'iv'; root.hidden = true; document.body.appendChild(root);
  const tip = document.createElement('div'); tip.id = 'iv-tip'; tip.hidden = true; document.body.appendChild(tip);
  let ghost = null, drag = null, tab = 'shop';

  const tile = (it, cls = '') => `<div class="iv-tile ${cls}" style="--c:${COLOR[kindOf(it)]}"><svg viewBox="0 0 24 24"><path d="${iconOf(it)}"/></svg><span class="nm">${esc(nameOf(it))}</span><span class="vl">${it.t === 'loot' ? it.value : ''}</span></div>`;
  const slot = (zone, i, it, cls = '', ph = '') => `<div class="slot ${cls}" data-zone="${zone}" data-i="${i}">${it ? tile(it, cls === 'wide' ? 'row' : '') : `<div class="ph">${ph}</div>`}</div>`;

  function render() {
    normalise();
    const risk = stash.pack.concat(stash.w, stash.b).reduce((a, it) => a + (it ? sellValue(it) : 0), 0);
    const pistol = defOf('pistol');
    const shop = GUNS.map(([id, , , cost]) => ({ it: { t: 'weapon', id }, cost })).concat(Object.keys(SUPPLY).map((k) => ({ it: { t: k }, cost: SUPPLY[k].cost })), (W() && W().attachments ? W().attachments : []).map((a) => ({ it: { t: 'att', id: a.id }, cost: a.price })), Object.keys(BAGS).map((k) => ({ it: { t: 'bag', size: Number(k) }, cost: BAGS[k].cost })));
    root.innerHTML = `
      <div>
        <h1>Skyline Heist</h1>
        <div class="cr">${stash.credits}<small>CREDITS</small></div>
        <div class="rec">${stash.extracted} extractions · ${stash.lost} lost · streak ${stash.streak || 0} (best ${stash.bestStreak || 0})<br>best haul ${stash.best} cr${stash.fastest ? ` · fastest exit ${Math.floor(stash.fastest / 60)}:${String(Math.round(stash.fastest % 60)).padStart(2, '0')}` : ''}</div>
        <h3>Weapons — at risk</h3>
        <div class="grid">
          <div class="slot wide"><div class="iv-tile row fixed" style="--c:#e9e3d4"><svg viewBox="0 0 24 24"><path d="${ICON.pistol}"/></svg><span class="nm">${esc(pistol ? pistol.name : 'Pistol')} · sidearm</span></div></div>
          ${slot('w', 0, stash.w[0], 'wide', 'Drag a weapon here')}
          ${slot('w', 1, stash.w[1], 'wide', 'Drag a weapon here')}
          ${slot('bag', 0, stash.b[0], 'wide', 'Backpack slot')}
        </div>
        ${['pistol'].concat(stash.w.filter(Boolean).map((w) => w.id)).filter((wid, i, a) => a.indexOf(wid) === i && slotsFor(wid).length).map((wid) => `<h3 style="margin:8px 0 3px">${esc((defOf(wid) || { name: wid }).name)} — attachments</h3><div class="grid" style="grid-template-columns:repeat(5,1fr)">${slotsFor(wid).map((sn, i) => slot('att_' + wid, i, attArr(wid)[i], '', sn)).join('')}</div>`).join('')}
        <h3>Pack — ${stash.pack.filter(Boolean).length}/${packSize()} · carried worth ${risk} cr</h3>
        <div class="grid" style="grid-template-columns:repeat(4,1fr)">${stash.pack.map((it, i) => slot('pack', i, it)).join('')}</div>
        <button class="mini" data-act="store">Move pack to stash</button> <button class="mini" data-act="sellpack">Sell pack valuables</button>
        <button class="deploy" data-act="deploy">Deploy</button>
      </div>
      <div>
        <h3 style="margin-top:4px">Stash — ${stash.grid.filter(Boolean).length}/${STASH_SLOTS}</h3>
        <div class="grid" style="grid-template-columns:repeat(8,1fr)">${stash.grid.map((it, i) => slot('stash', i, it)).join('')}</div>
        <div class="sell" data-zone="sell" data-i="0">Drop here to sell</div>
        <h3>Contracts this raid — paid if you extract</h3>
        <div class="contracts">${contractsHtml()}</div>
      </div>
      <div>
        <div class="tabs">${[['shop', 'Shop'], ['traders', 'Traders'], ['base', 'Base'], ['settings', 'Settings']].map(([id, label]) => `<span class="${tab === id ? 'on' : ''}" data-tab="${id}">${label}</span>`).join('')}</div>
        ${tab === 'shop' ? `<h3 style="margin-top:10px">Click to buy</h3><div class="shop">${shop.map((s, i) => `<div class="slot ${stash.credits < s.cost ? 'short' : ''}" data-buy="${i}">${tile(s.it)}<span class="vl" style="position:absolute;left:3px;bottom:2px;font-size:9px;color:#ffc56b">${s.cost}</span></div>`).join('')}</div>` : ''}
        ${tab === 'traders' ? TRADERS.map((tr) => {
          const st = taskState(stash, tr), t = st.task;
          const reward = t ? [t.reward.cr ? `${t.reward.cr} cr` : ''].concat(t.reward.items.map((it) => esc(nameOf(it)))).filter(Boolean).join(' + ') : '';
          return `<div class="card"><b>${esc(tr.name)}</b><span class="dim">${esc(tr.blurb)} · ${st.s.i}/${tr.tasks.length} tasks done</span>${t
            ? `<div class="task">${esc(t.text)} <span class="dim">${st.have}/${st.need}</span></div><div class="dim">Reward: ${reward}</div><button class="mini ${st.done ? 'go2' : 'off'}" data-claim="${tr.id}">${st.done ? (t.handin ? 'Hand in' : 'Claim reward') : 'In progress'}</button>`
            : '<div class="task">Nothing more to ask of you.</div>'}</div>`;
        }).join('') : ''}
        ${tab === 'base' ? STATIONS.map((stn) => {
          const lv = stationLevel(stash, stn), next = stn.levels[lv];
          const have = stn.levels.slice(0, lv).map((l) => `<div class="dim">✔ ${esc(l.desc)}</div>`).join('');
          if (!next) return `<div class="card"><b>${esc(stn.name)}</b><span class="dim">Level ${lv}/${stn.levels.length} · complete</span>${have}</div>`;
          const needs = next.need.map(([name, n]) => { const c = countItem(stash, name); return `<span style="color:${c >= n ? '#9be37a' : '#ff8a70'}">${n} × ${esc(name)} (${c})</span>`; }).join(', ');
          return `<div class="card"><b>${esc(stn.name)}</b><span class="dim">Level ${lv}/${stn.levels.length}</span>${have}<div class="task">Next: ${esc(next.desc)}</div><div class="dim">Needs <span style="color:${stash.credits >= next.cost ? '#9be37a' : '#ff8a70'}">${next.cost} cr</span>, ${needs}</div><button class="mini ${canBuild(stash, next) ? 'go2' : 'off'}" data-build="${stn.id}">Build</button></div>`;
        }).join('') : ''}
        ${tab === 'settings' ? '<div id="iv-settings" style="margin-top:12px"></div>' : ''}
      </div>
      <div class="help">Drag tiles between the stash, your pack and the weapon slots. What you carry is lost if you die. In a raid: F search · H medkit · Tab pack · M map · Esc pause and settings · N mute.</div>`;
    root._shop = shop;
    const setHost = root.querySelector('#iv-settings'); if (setHost && ctx.mountSettings) ctx.mountSettings(setHost);
  }

  // ---- interactions ---------------------------------------------------------
  const zoneEl = (x, y) => { const e = document.elementFromPoint(x, y); return e && e.closest('[data-zone]'); };
  function drop(target) {
    const { zone, i, it } = drag, tz = target.dataset.zone, ti = Number(target.dataset.i);
    if (tz === zone && ti === i) return;
    if (!accepts(tz, it, ti)) return chime([200], 0.05, 0.12, 0.1, 'square');
    const from = zoneArr(zone);
    if (tz === 'sell') { stash.credits += sellValue(it); from[i] = null; chime([880, 1320], 0.05, 0.14); return; }
    const to = zoneArr(tz), other = to[ti];
    if (other && !accepts(zone, other, i)) return chime([200], 0.05, 0.12, 0.1, 'square');
    to[ti] = it; from[i] = other || null; chime([520], 0.05, 0.08, 0.1);
  }
  root.addEventListener('mousedown', (e) => {
    if (e.target.closest('#iv-settings')) return;
    const s = e.target.closest('[data-zone]'); if (!s || e.button !== 0 || s.dataset.zone === 'sell') return;
    const it = zoneArr(s.dataset.zone)[Number(s.dataset.i)]; if (!it) return;
    drag = { zone: s.dataset.zone, i: Number(s.dataset.i), it };
    ghost = document.createElement('div'); ghost.id = 'iv-ghost'; ghost.innerHTML = tile(it); document.body.appendChild(ghost);
    ghost.style.left = `${e.clientX}px`; ghost.style.top = `${e.clientY}px`; tip.hidden = true; e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (root.hidden) return;
    if (drag) {
      ghost.style.left = `${e.clientX}px`; ghost.style.top = `${e.clientY}px`;
      root.querySelectorAll('.over').forEach((n) => n.classList.remove('over'));
      const z = zoneEl(e.clientX, e.clientY); if (z && accepts(z.dataset.zone, drag.it, Number(z.dataset.i))) z.classList.add('over');
      return;
    }
    // tooltip
    const s = e.target.closest && e.target.closest('[data-zone],[data-buy]'); let it = null;
    if (s && s.dataset.buy != null) it = root._shop[Number(s.dataset.buy)].it; else if (s && s.dataset.zone !== 'sell') it = zoneArr(s.dataset.zone)[Number(s.dataset.i)];
    if (!it) { tip.hidden = true; return; }
    tip.style.setProperty('--c', COLOR[kindOf(it)]);
    tip.innerHTML = `<b>${esc(nameOf(it))}</b><span>${esc(describe(it))}<br>Sells for ${sellValue(it)} cr</span>`;
    tip.style.left = `${Math.min(window.innerWidth - 280, e.clientX + 16)}px`; tip.style.top = `${e.clientY + 18}px`; tip.hidden = false;
  });
  window.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const z = zoneEl(e.clientX, e.clientY); if (z) drop(z);
    ghost.remove(); ghost = null; drag = null; save(); render();
  });
  root.addEventListener('click', (e) => {
    const buy = e.target.closest('[data-buy]'), act = e.target.closest('[data-act]'), tabEl = e.target.closest('[data-tab]'), claimEl = e.target.closest('[data-claim]'), buildEl = e.target.closest('[data-build]');
    if (buy) {
      const s = root._shop[Number(buy.dataset.buy)];
      if (stash.credits < s.cost || stash.grid.indexOf(null) < 0) return chime([200], 0.05, 0.12, 0.1, 'square');
      stash.credits -= s.cost; addToStash({ ...s.it }); chime([660, 880]);
    } else if (tabEl) { tab = tabEl.dataset.tab; render(); return;
    } else if (claimEl) {
      const tr = TRADERS.find((t) => t.id === claimEl.dataset.claim);
      if (!claim(stash, tr, addToStash)) return chime([200], 0.05, 0.12, 0.1, 'square');
      chime([520, 660, 780, 1040], 0.08, 0.35, 0.2);
    } else if (buildEl) {
      const stn = STATIONS.find((x) => x.id === buildEl.dataset.build), next = stn.levels[stationLevel(stash, stn)];
      if (!next || !build(stash, next)) return chime([200], 0.05, 0.12, 0.1, 'square');
      chime([440, 660, 880, 1100], 0.08, 0.35, 0.2);
    } else if (act && act.dataset.act === 'sellpack') {
      stash.pack.forEach((it, i) => { if (it && it.t === 'loot') { stash.credits += it.value; stash.pack[i] = null; } }); chime([880, 1320], 0.05, 0.14);
    } else if (act && act.dataset.act === 'store') {
      stash.pack.forEach((it, i) => { if (it && stash.grid.indexOf(null) >= 0) { addToStash(it); stash.pack[i] = null; } }); chime([520], 0.05, 0.08, 0.1);
    } else if (act && act.dataset.act === 'deploy') { save(); onDeploy(); return; }
    else return;
    save(); render();
  });

  normalise();
  return {
    addToStash, normalise, sellValue, nameOf, tile,
    show() { if (root.hidden) { render(); root.hidden = false; } },
    hide() { root.hidden = true; tip.hidden = true; },
    get visible() { return !root.hidden; },
    render,
  };
}
