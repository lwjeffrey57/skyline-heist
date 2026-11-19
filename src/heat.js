// Heat: how hot the compound is. A raid starts quiet; every enemy you kill raises the heat, and each tier brings more guards, faster reinforcements, bolder guards and hunting parties — and
// richer containers and hazard pay on everything you carry out. The tier never drops during a raid.
// ctx.heat = { value (0..100), tier (1..5), frac (0..1), bonus (hazard pay, 0..0.6), lootLuck, add(n), name }
// Emits `heatTier { tier, name }` when the tier rises.

const TIERS = [
  { at: 0, name: 'Quiet', color: '#9be37a', bots: 0, respawn: 25, aggr: 0, bonus: 0, note: '' },
  { at: 20, name: 'Stirring', color: '#ffe14a', bots: 1, respawn: 18, aggr: 0.25, bonus: 0.1, note: 'More guards on patrol' },
  { at: 40, name: 'Alarm', color: '#ff9a3c', bots: 2, respawn: 13, aggr: 0.5, bonus: 0.25, note: 'Hunters are looking for you' },
  { at: 62, name: 'Lockdown', color: '#ff5a4a', bots: 3, respawn: 11, aggr: 0.75, bonus: 0.4, note: 'The site is filling with guards' },
  { at: 84, name: 'Kill order', color: '#ff2d55', bots: 4, respawn: 9, aggr: 1, bonus: 0.6, note: 'Everything on site is coming for you' },
];
// Heat comes from kills only: each enemy you kill adds KILL, so the tiers arrive at 8, 16, 25 and 34 kills.
const KILL = 2.5;

export function init(ctx) {
  const { player, events } = ctx;
  let baseMix = null;
  let value = 0, tier = 1, active = false, huntT = 0, alertCd = 0, bannerT = 0, shown = -1;

  const style = document.createElement('style');
  style.textContent = `
    #ht { position: fixed; top: 124px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #fff; pointer-events: none; text-shadow: 0 1px 2px #000; }
    #ht .segs { display: flex; gap: 3px; }
    #ht .segs i { width: 26px; height: 5px; background: rgba(255,255,255,.16); position: relative; overflow: hidden; }
    #ht .segs i b { position: absolute; left: 0; top: 0; bottom: 0; }
    #ht .pay { opacity: .85; }
    #ht-banner { position: fixed; top: 24%; left: 50%; transform: translateX(-50%); text-align: center; color: #fff; pointer-events: none; transition: opacity .5s; text-shadow: 0 2px 6px #000; }
    #ht-banner .t { font-size: 30px; font-weight: 700; letter-spacing: 9px; text-transform: uppercase; }
    #ht-banner .s { margin-top: 4px; font-size: 12px; letter-spacing: 3px; text-transform: uppercase; opacity: .9; }`;
  document.head.appendChild(style);
  const bar = document.createElement('div'); bar.id = 'ht'; bar.hidden = true;
  bar.innerHTML = `<span class="nm"></span><div class="segs">${'<i><b></b></i>'.repeat(5)}</div><span class="pay"></span>`;
  const banner = document.createElement('div'); banner.id = 'ht-banner'; banner.style.opacity = '0'; banner.innerHTML = '<div class="t"></div><div class="s"></div>';
  ctx.hud.appendChild(bar); ctx.hud.appendChild(banner);
  const nm = bar.querySelector('.nm'), pay = bar.querySelector('.pay'), fills = [...bar.querySelectorAll('.segs b')];

  function apply() {
    const T = TIERS[tier - 1], raid = ctx.raid;
    if (ctx.bots && raid) {
      ctx.bots.config.respawnDelay = T.respawn * (lullT > 0 ? 2.5 : 1);
      ctx.bots.setCount(raid.config.bots + T.bots);
      if (ctx.bots.setAggression) ctx.bots.setAggression(T.aggr);
      const K = ctx.bots.config.kinds; // hotter raids bring more of the types that force you to move
      if (K && K.scout && K.shield) {
        if (!baseMix) baseMix = { s: [K.scout.weight, K.scout.max], h: [K.shield.weight, K.shield.max] };
        const up = Math.max(0, tier - 2);
        K.scout.weight = baseMix.s[0] * (1 + up * 0.5); if (baseMix.s[1]) K.scout.max = baseMix.s[1] + up;
        K.shield.weight = baseMix.h[0] * (1 + up * 0.35); if (baseMix.h[1]) K.shield.max = baseMix.h[1] + Math.floor(up / 2);
      }
    }
  }
  function hunt(n) { if (ctx.bots && ctx.bots.hunt && n > 0) ctx.bots.hunt(player.pos, n); }
  function rise() {
    const T = TIERS[tier - 1];
    apply();
    banner.querySelector('.t').textContent = `Heat ${tier} — ${T.name}`; banner.querySelector('.t').style.color = T.color;
    banner.querySelector('.s').textContent = `${T.note} · hazard pay +${Math.round(T.bonus * 100)}%`;
    banner.style.opacity = '1'; bannerT = 3.5;
    if (ctx.raid && ctx.raid.chime) ctx.raid.chime(tier >= 4 ? [196, 185, 165, 147] : [220, 196, 175], 0.2, 0.55, 0.2, 'sawtooth');
    if (tier >= 3) { hunt(tier - 1); huntT = 75 - tier * 10; if (ctx.drones) ctx.drones.spawnNow(); }
    events.emit('heatTier', { tier, name: T.name });
  }
  function add(n) {
    if (!active) return;
    value = Math.max(0, Math.min(100, value + n));
    while (tier < TIERS.length && value >= TIERS[tier].at) { tier++; rise(); }
  }

  events.on('raidStart', () => { active = true; value = 0; tier = 1; huntT = 0; alertCd = 0; shown = -1; apply(); });
  events.on('raidEnd', () => { active = false; bar.hidden = true; banner.style.opacity = '0'; });
  events.on('botDied', (e) => { if (e.by === player) { add(KILL); press(0.1); } });
  // The pace: heat sets how dangerous the site is; this watches how hard you are being pressed right now and makes the
  // raid breathe. After a fight that pushed you to the limit you get a lull (reinforcements held back, no hunting
  // parties); when nothing has happened for a long while, something is sent your way.
  let pressure = 0, peak = 0, lullT = 0, quietT = 0;
  const press = (n) => { if (active) { pressure = Math.min(1, pressure + n); peak = Math.max(peak, pressure); } };
  events.on('playerDamaged', (e) => press((e.amount || 5) / 45));
  events.on('guardAlert', () => press(0.07));
  events.on('nearMiss', () => press(0.012));
  events.on('playerDowned', () => press(1));
  events.on('raidStart', () => { pressure = 0; peak = 0; lullT = 0; quietT = 0; });

  ctx.heat = {
    add, hunt, tiers: TIERS,
    get value() { return value; }, get tier() { return tier; }, get frac() { return value / 100; },
    get name() { return TIERS[tier - 1].name; }, get bonus() { return TIERS[tier - 1].bonus; },
    get pressure() { return pressure; }, get lull() { return lullT > 0; },
    get lootLuck() { return (tier - 1) * 0.12; }, // chance that a common item in a container you open is re-rolled as a good one
  };

  return {
    update(dt) {
      if (!active || !ctx.raid || ctx.raid.state !== 'raid') { bar.hidden = true; return; }
      // hunting parties: from Alarm upward, guards are sent to where you are every so often
      pressure = Math.max(0, pressure - dt * 0.035);
      if (lullT > 0) { lullT -= dt; if (lullT <= 0) apply(); }
      else if (peak > 0.8 && pressure < 0.35) { lullT = 22 + tier * 2; peak = 0; quietT = 0; apply(); } // the fight is over: let them breathe
      if (pressure < 0.08 && lullT <= 0) quietT += dt; else quietT = 0;
      if (quietT > 80 - tier * 8) { // too quiet for too long: stir the site
        quietT = 0;
        if (tier >= 2 || Math.random() < 0.5) hunt(1 + (tier > 2)); else if (ctx.drones) ctx.drones.spawnNow();
      }
      if (tier >= 3 && lullT <= 0) { huntT -= dt; if (huntT <= 0) { hunt(tier - 2); huntT = 75 - tier * 10; } }
      if (bannerT > 0) { bannerT -= dt; if (bannerT <= 0) banner.style.opacity = '0'; }
      bar.hidden = false;
      const key = Math.round(value) + tier * 1000;
      if (key !== shown) {
        shown = key;
        const T = TIERS[tier - 1];
        nm.textContent = `Heat ${tier} · ${T.name}`; nm.style.color = T.color;
        pay.textContent = T.bonus ? `Hazard pay +${Math.round(T.bonus * 100)}%` : '';
        for (let i = 0; i < 5; i++) {
          const lo = TIERS[i].at, hi = i < 4 ? TIERS[i + 1].at : 100;
          fills[i].style.width = `${Math.max(0, Math.min(1, (value - lo) / (hi - lo))) * 100}%`; fills[i].style.background = i < tier ? T.color : 'rgba(255,255,255,.5)';
        }
      }
    },
  };
}
