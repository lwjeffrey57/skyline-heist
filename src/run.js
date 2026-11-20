import * as THREE from 'three';
import { WEAPONS } from './weapons/defs.js';

// CASHOUT RUN: the fast mode. No stash, no looting, nothing to lose but the run.
// Each round: grab the cash box, carry it to the deposit station, hold the station while it banks. Everything on site
// comes for you. Bank it and pick one of three upgrades; the next round is harder and pays more. Go down and the run
// is over: rounds, cash and your best are kept. Kills heal you, so pushing forward is how you stay alive.
// ctx.run = { start(), active, state }   Uses the no-stakes path of the raid (ctx.rangeMode) plus ctx.runMode.

const CFG = { bankTime: 18, bankPer: 2, bankMax: 30, radius: 9, pay: 1000, killPay: 25, healKill: 6, bots0: 5, botsPer: 2, botsMax: 22 };
const rnd = (a, b) => a + Math.random() * (b - a);
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
// enemy mix by round: [kind, first round it appears, weight, max alive]
const MIX = [['grunt', 1, 8, 99], ['scout', 1, 3, 4], ['shield', 2, 2, 2], ['grenadier', 3, 1.5, 2], ['marksman', 4, 1.5, 2], ['heavy', 5, 1.2, 2]];
const GUN_FIELDS = (w) => ({ damage: w.damage, rpm: w.rpm, mag: w.mag, brpm: w.burst ? w.burst.rpm : 0, rt: w.reload.time, rs: w.reload.shell, ri: w.reload.insert });

export function init(ctx) {
  const { player, world, events, scene } = ctx;
  let active = false, state = 'off', round = 0, cash = 0, kills = 0, bankT = 0, bankNeed = 0, huntT = 0, overAt = 0, best = 0, bestRound = 0;
  let healKill = CFG.healKill, saved = null, box = null, station = null, mark = null, cards = [], picks = [];
  try { const b = JSON.parse(localStorage.getItem('sh-run-best') || 'null'); if (b) { best = b.cash || 0; bestRound = b.round || 0; } } catch { /* storage unavailable */ }

  // ---- things in the world --------------------------------------------------------------------------------------
  const beamGeo = new THREE.CylinderGeometry(0.45, 0.9, 70, 8, 1, true);
  const mkBeam = (hex) => new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  const boxG = new THREE.Group(), stG = new THREE.Group();
  {
    const cube = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.6), new THREE.MeshStandardMaterial({ color: 0x3a2c08, emissive: 0xffb820, emissiveIntensity: 2.4, roughness: 0.4 }));
    cube.position.y = 0.8; const b = mkBeam(0xffc23a); b.position.y = 35; boxG.add(cube, b); boxG.userData.cube = cube;
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(CFG.radius, CFG.radius, 0.06, 40, 1, true), new THREE.MeshBasicMaterial({ color: 0x35ffd0, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    ring.position.y = 0.06; ring.scale.y = 8;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(CFG.radius, 40), new THREE.MeshBasicMaterial({ color: 0x35ffd0, transparent: true, opacity: 0.12, depthWrite: false, fog: false }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = 0.05;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.5, 0.8), new THREE.MeshStandardMaterial({ color: 0x0c2a26, emissive: 0x35ffd0, emissiveIntensity: 1.6, roughness: 0.4 }));
    post.position.y = 0.75; const b2 = mkBeam(0x35ffd0); b2.position.y = 35; stG.add(ring, disc, post, b2);
  }
  boxG.visible = stG.visible = false; scene.add(boxG, stG);

  function pickSpot(from, dMin, dMax) {
    const lim = world.arenaHalf - 14, all = world.buildings.concat(world.outbuildings || []);
    for (let i = 0; i < 120; i++) {
      const a = Math.random() * Math.PI * 2, d = rnd(dMin, dMax) * (i > 80 ? 0.6 : 1);
      const x = THREE.MathUtils.clamp(from.x + Math.sin(a) * d, -lim, lim), z = THREE.MathUtils.clamp(from.z + Math.cos(a) * d, -lim, lim);
      if (Math.hypot(x - from.x, z - from.z) < dMin * 0.5) continue;
      if (all.some((b) => Math.abs(x - b.x) < b.w / 2 + 2.5 && Math.abs(z - b.z) < b.d / 2 + 2.5)) continue; // open ground
      if (!player.free(x, 0.05, z, 1.8)) continue;
      const g = world.raycast(new THREE.Vector3(x, 3, z), new THREE.Vector3(0, -1, 0), 6);
      if (g && g.point.y > 0.6) continue; // on top of something
      return { x, z };
    }
    return { x: from.x, z: from.z };
  }
  function setMark(p, title, css) {
    const M = ctx.worldEvents && ctx.worldEvents.marks; if (!M) return;
    if (mark) { const i = M.indexOf(mark); if (i >= 0) M.splice(i, 1); mark = null; }
    if (p) { mark = { x: p.x, z: p.z, title, css, active: true }; M.push(mark); }
  }

  // ---- HUD -----------------------------------------------------------------------------------------------------------
  const css = document.createElement('style');
  css.textContent = `
    #rn { position: fixed; top: 44px; left: 50%; transform: translateX(-50%); text-align: center; color: #fff; pointer-events: none; text-shadow: 0 1px 3px #000; z-index: 20; }
    #rn .l1 { display: inline-block; background: rgba(12,14,18,.7); border-bottom: 2px solid #e0a23a; padding: 5px 16px; font-size: 15px; font-weight: 700; letter-spacing: 3px; }
    #rn .l1 i { font-style: normal; color: #e0a23a; }
    #rn .l2 { margin-top: 7px; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; }
    #rn .bar { width: 320px; height: 8px; margin: 7px auto 0; background: rgba(255,255,255,.18); }
    #rn .bar b { display: block; height: 100%; width: 0; background: #35ffd0; }
    #rn-cards { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; background: rgba(6,8,12,.72); color: #fff; z-index: 40; }
    #rn-cards h2 { margin: 0; font-size: 26px; letter-spacing: 8px; text-transform: uppercase; }
    #rn-cards p { margin: 0; opacity: .8; letter-spacing: 2px; font-size: 12px; text-transform: uppercase; }
    #rn-cards .row { display: flex; gap: 16px; }
    #rn-cards .card { width: 210px; min-height: 150px; padding: 16px; background: rgba(20,24,30,.95); border: 2px solid rgba(255,255,255,.25); cursor: pointer; text-align: left; }
    #rn-cards .card:hover { border-color: #e0a23a; transform: translateY(-4px); }
    #rn-cards .card .k { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: #e0a23a; }
    #rn-cards .card .t { font-size: 17px; font-weight: 700; letter-spacing: 1px; margin: 8px 0 6px; }
    #rn-cards .card .d { font-size: 12px; opacity: .85; line-height: 1.4; }
    #rn-end { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); background: rgba(12,14,18,.94); border: 1px solid #e0a23a; color: #fff; padding: 10px 18px; font-size: 13px; letter-spacing: 1.5px; z-index: 60; text-align: center; pointer-events: none; }
    #rn-end b { color: #e0a23a; } #rn-end .big { font-size: 20px; font-weight: 700; letter-spacing: 6px; margin-bottom: 4px; }`;
  document.head.appendChild(css);
  const hud = document.createElement('div'); hud.id = 'rn'; hud.hidden = true; hud.innerHTML = '<div class="l1"></div><div class="l2"></div><div class="bar" hidden><b></b></div>'; ctx.hud.appendChild(hud);
  const l1 = hud.querySelector('.l1'), l2 = hud.querySelector('.l2'), bar = hud.querySelector('.bar'), fill = bar.querySelector('b');
  const cardEl = document.createElement('div'); cardEl.id = 'rn-cards'; cardEl.hidden = true; document.body.appendChild(cardEl);
  const endEl = document.createElement('div'); endEl.id = 'rn-end'; endEl.hidden = true; document.body.appendChild(endEl);
  const say = (t, c) => { if (ctx.raid && ctx.raid.toast) ctx.raid.toast(t, c); };
  const chime = (...a) => { if (ctx.raid && ctx.raid.chime) ctx.raid.chime(...a); };

  // ---- upgrades ---------------------------------------------------------------------------------------------------
  const inv = () => ctx.weapons.inventory;
  const rebuild = () => { for (const v of inv()) ctx.weapons.setAttachments(v.base.id, ctx.weapons.getAttachments(v.base.id)); };
  const eachGun = (f) => { for (const w of WEAPONS) f(w); rebuild(); };
  const UPGRADES = [
    { id: 'dmg', k: 'Firepower', t: 'Hotter loads', d: 'Every gun does 15% more damage.', go: () => eachGun((w) => { w.damage = Math.round(w.damage * 1.15 * 10) / 10; }) },
    { id: 'rpm', k: 'Firepower', t: 'Tuned actions', d: 'Every gun fires 12% faster.', go: () => eachGun((w) => { w.rpm = Math.round(w.rpm * 1.12); if (w.burst) w.burst.rpm = Math.round(w.burst.rpm * 1.12); }) },
    { id: 'mag', k: 'Firepower', t: 'Extended magazines', d: 'Every magazine holds 35% more.', go: () => { eachGun((w) => { w.mag = Math.max(w.mag + 1, Math.round(w.mag * 1.35)); }); for (const v of inv()) v.mag = v.def.mag; } },
    { id: 'rel', k: 'Handling', t: 'Fast hands', d: 'Reloads are 25% quicker.', go: () => eachGun((w) => { if (w.reload.time) w.reload.time *= 0.75; if (w.reload.shell) { w.reload.shell *= 0.75; w.reload.insert *= 0.75; } }) },
    { id: 'hp', k: 'Survival', t: 'Plating', d: '+30 maximum health, and you are patched up to full now.', go: () => { player.maxHp += 30; player.hp = player.maxHp; } },
    { id: 'leech', k: 'Survival', t: 'Scavenger', d: 'Each kill heals 5 more health.', go: () => { healKill += 5; } },
    { id: 'dash', k: 'Movement', t: 'Quick recharge', d: 'Dash comes back 30% sooner.', go: () => { player.dashCdMul = (player.dashCdMul || 1) * 0.7; } },
  ];
  function offer() {
    const pool = UPGRADES.slice(), out = [];
    const locked = inv().filter((v) => v.locked);
    for (const v of locked.sort(() => Math.random() - 0.5).slice(0, 2)) pool.push({ id: 'gun_' + v.base.id, k: 'New gun', t: v.base.name, d: `${v.base.tag}. Added to your weapons and put in your hands.`, go: () => { v.locked = false; v.mag = v.def.mag; ctx.weapons.switchTo(inv().indexOf(v), true); } });
    const guns = pool.filter((u) => u.id.startsWith('gun_'));
    if (guns.length) { out.push(guns[0]); pool.splice(pool.indexOf(guns[0]), 1); } // there is always a gun on the table while any are left
    while (out.length < 3 && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return out.sort(() => Math.random() - 0.5);
  }
  function showCards() {
    state = 'pick'; cards = offer(); ctx.freeze = true; ctx.uiOpen = true;
    cardEl.innerHTML = `<h2>Banked ${money(CFG.pay * round)}</h2><p>Round ${round} done · choose one</p><div class="row">${cards.map((c, i) => `<div class="card" data-i="${i}"><div class="k">${c.k}</div><div class="t">${c.t}</div><div class="d">${c.d}</div></div>`).join('')}</div>`;
    cardEl.hidden = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }
  function pick(i) {
    const c = cards[i]; if (state !== 'pick' || !c) return;
    c.go(); picks.push(c.t); cardEl.hidden = true; ctx.freeze = false; ctx.uiOpen = false;
    if (ctx.relock) ctx.relock();
    chime([520, 660, 880], 0.07, 0.3, 0.18);
    nextRound();
  }
  cardEl.addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) pick(Number(c.dataset.i)); });

  // ---- rounds ------------------------------------------------------------------------------------------------------------
  function setEnemies() {
    const B = ctx.bots, c = B.config, K = c.kinds;
    for (const [kind, from, weight, max] of MIX) if (K[kind]) { K[kind].weight = round >= from ? weight * (kind === 'grunt' ? 1 : 1 + (round - from) * 0.15) : 0; K[kind].max = round >= from ? max + Math.floor((round - from) / 3) : 0; }
    c.passiveShare = 0; c.respawnDelay = Math.max(3, 9 - round); c.damage = 6 + Math.min(6, (round - 1) * 0.6);
    B.setCount(Math.min(CFG.botsMax, CFG.bots0 + CFG.botsPer * round));
    if (B.setAggression) B.setAggression(Math.min(1, 0.3 + round * 0.1));
  }
  function nextRound() {
    round++; state = 'grab'; bankT = 0; bankNeed = Math.min(CFG.bankMax, CFG.bankTime + CFG.bankPer * (round - 1)); huntT = 3;
    setEnemies();
    const p = pickSpot(player.pos, 30, 55); box = p; boxG.position.set(p.x, 0, p.z); boxG.visible = true; stG.visible = false; station = null;
    setMark(p, 'CASH', '#ffc23a');
    say(`Round ${round}: a cash box is down. Get it.`, '#ffc23a'); chime([440, 554], 0.1, 0.25, 0.16, 'triangle');
  }
  function grab() {
    state = 'carry'; boxG.visible = false;
    const p = pickSpot(box, 32, 60); station = p; stG.position.set(p.x, 0, p.z); stG.visible = true;
    setMark(p, 'DEPOSIT', '#35ffd0');
    say('You have the cash. Get it to the deposit station.', '#35ffd0'); chime([660, 880], 0.08, 0.25, 0.18);
    if (ctx.bots.alertAll) ctx.bots.alertAll(player.pos);
  }
  function banked() {
    cash += CFG.pay * round; stG.visible = false; setMark(null);
    chime([520, 660, 780, 1040], 0.09, 0.4, 0.2); if (ctx.slowmo) ctx.slowmo(0.3, 0.5);
    showCards();
  }

  // ---- start / end ---------------------------------------------------------------------------------------------------
  function start() {
    if (active || !ctx.raid || !ctx.bots || (ctx.range && ctx.range.active)) return;
    const c = ctx.bots.config;
    saved = { guns: WEAPONS.map(GUN_FIELDS), kinds: Object.fromEntries(Object.entries(c.kinds).map(([k, v]) => [k, [v.weight, v.max]])), passive: c.passiveShare, squads: c.raiders ? c.raiders.squads : null };
    if (c.raiders) c.raiders.squads = 0;
    ctx.rangeMode = true; ctx.runMode = true; active = true; round = 0; cash = 0; kills = 0; picks = []; healKill = CFG.healKill; endEl.hidden = true;
    ctx.raid.deploy();
    if (ctx.bots.clearRaiders) ctx.bots.clearRaiders();
    player.noRegen = true; player.dashCdMul = 1;
    for (const v of inv()) v.locked = !(v.base.id === 'pistol' || v.base.id === 'rifle');
    ctx.weapons.switchTo(inv().findIndex((v) => v.base.id === 'rifle'), true);
    hud.hidden = false;
    nextRound();
  }
  function restore() {
    if (!saved) return;
    const c = ctx.bots.config;
    WEAPONS.forEach((w, i) => { const s = saved.guns[i]; w.damage = s.damage; w.rpm = s.rpm; w.mag = s.mag; if (w.burst) w.burst.rpm = s.brpm; if (s.rt != null) w.reload.time = s.rt; if (s.rs != null) { w.reload.shell = s.rs; w.reload.insert = s.ri; } });
    rebuild();
    for (const k in saved.kinds) if (c.kinds[k]) { c.kinds[k].weight = saved.kinds[k][0]; if (saved.kinds[k][1] === undefined) delete c.kinds[k].max; else c.kinds[k].max = saved.kinds[k][1]; }
    c.passiveShare = saved.passive; if (c.raiders && saved.squads != null) c.raiders.squads = saved.squads;
    player.noRegen = false; player.dashCdMul = 1; saved = null;
  }
  function finish() {
    if (!active) return;
    const record = cash > best;
    if (record) { best = cash; bestRound = round; try { localStorage.setItem('sh-run-best', JSON.stringify({ cash: best, round: bestRound })); } catch { /* storage unavailable */ } }
    endEl.innerHTML = `<div class="big">${record && cash > 0 ? 'NEW BEST' : 'RUN OVER'}</div>Reached round <b>${round}</b> · banked <b>${money(cash)}</b> · <b>${kills}</b> kills · best <b>${money(best)}</b>${picks.length ? `<br><span style="opacity:.7">Build: ${picks.join(', ')}</span>` : ''}`;
    endEl.hidden = false;
    active = false; state = 'off'; hud.hidden = true; cardEl.hidden = true; boxG.visible = stG.visible = false; setMark(null);
    ctx.freeze = false; ctx.uiOpen = false;
    restore();
    ctx.raid.endRange(); ctx.rangeMode = false; ctx.runMode = false;
  }
  events.on('botDied', (e) => {
    if (!active || e.by !== player) return;
    kills++; cash += CFG.killPay * round;
    if (!player.downed) player.hp = Math.min(player.maxHp, player.hp + healKill);
  });
  events.on('raidStart', () => { if (!active) endEl.hidden = true; });
  ctx.run = { start, finish, pick, get active() { return active; }, get state() { return state; }, get round() { return round; }, get cash() { return cash; } };

  return {
    update(dt) {
      if (!active) return;
      if (ctx.raid.state !== 'raid') { finish(); return; }
      if (state === 'over') { if (performance.now() - overAt > 2200) finish(); return; }
      if (player.downed || !player.alive) { state = 'over'; overAt = performance.now(); if (ctx.slowmo) ctx.slowmo(0.25, 2.5); l2.textContent = 'You are down'; bar.hidden = true; return; }
      if (state === 'pick') return;
      const P = player.pos, t = ctx.time;
      huntT -= dt; if (huntT <= 0) { huntT = state === 'bank' ? 4 : 7; ctx.bots.hunt(P, state === 'grab' ? 3 + round : 99); }
      let goal = '';
      if (state === 'grab') {
        const d = Math.hypot(P.x - box.x, P.z - box.z); boxG.userData.cube.rotation.y = t * 1.5; boxG.userData.cube.position.y = 0.8 + Math.sin(t * 3) * 0.08;
        goal = `Grab the cash box · ${Math.round(d)} m`;
        if (d < 1.8 && Math.abs(P.y) < 2.5) grab();
      } else {
        const d = Math.hypot(P.x - station.x, P.z - station.z), inside = d < CFG.radius && P.y < 4;
        if (inside) { if (state !== 'bank') { state = 'bank'; say('Depositing. Hold the station.', '#35ffd0'); huntT = 0; } bankT += dt; }
        else { if (state === 'bank') state = 'carry'; bankT = Math.max(0, bankT - dt * 0.5); }
        goal = inside ? `Hold the station · ${Math.ceil(bankNeed - bankT)} s` : bankT > 0 ? `Get back in the ring · ${Math.round(d)} m` : `Carry it to the deposit · ${Math.round(d)} m`;
        if (bankT >= bankNeed) { banked(); return; }
      }
      l1.innerHTML = `ROUND ${round} <i>·</i> ${money(cash)} <i>·</i> BEST ${money(Math.max(best, cash))}`;
      l2.textContent = goal; bar.hidden = !(bankT > 0); fill.style.width = `${Math.min(100, (bankT / bankNeed) * 100)}%`;
    },
  };
}
