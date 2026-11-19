// HUD upgrade: a radar in the top-left, one vitals block (health, armour, medkits, keycards) in the bottom-left, and a
// tidier status cluster in the top-centre. Loaded after ui.js; it restyles and hides the older pieces it replaces.
//
// The radar turns with you (ahead is up) and shows the ground within 75 m: buildings, walls, roads, ladders, exits,
// supply drops and the commander's last report. It does not show enemies. What it does show is gunfire: every shot
// someone else fires nearby leaves a fading ping, red for guards and machines, ochre for rival crews.

const R = 96, RANGE = 75, SIZE = R * 2 + 8, K = R / RANGE;

export function init(ctx) {
  const { player, world, events } = ctx;
  const style = document.createElement('style');
  style.textContent = `
    #hp-map { position: fixed; left: 22px; top: 18px; width: ${SIZE}px; height: ${SIZE}px; pointer-events: none; }
    #hp-map canvas { width: ${SIZE}px; height: ${SIZE}px; border-radius: 50%; background: rgba(8,12,16,.55); box-shadow: 0 0 0 2px rgba(255,255,255,.16), 0 6px 22px rgba(0,0,0,.35); }
    #hp-map .n { position: absolute; left: 50%; top: -7px; transform: translateX(-50%); font-size: 10px; font-weight: 700; letter-spacing: 1px; color: #ffc56b; text-shadow: 0 1px 2px #000; }
    #hp-map .d { position: absolute; left: 0; right: 0; bottom: -17px; text-align: center; font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: rgba(255,255,255,.75); text-shadow: 0 1px 2px #000; }
    #rd-contracts { top: ${SIZE + 50}px !important; left: 22px !important; min-width: ${SIZE - 24}px; white-space: nowrap; }

    #hp-vit { position: fixed; left: 24px; bottom: 26px; width: 300px; color: #fff; pointer-events: none; text-shadow: 0 1px 3px rgba(0,0,0,.7); }
    #hp-vit .row { display: flex; align-items: flex-end; gap: 10px; }
    #hp-vit .num { font-size: 44px; font-weight: 700; line-height: .9; letter-spacing: 1px; min-width: 78px; }
    #hp-vit .side { flex: 1; padding-bottom: 3px; }
    #hp-vit .lbl { display: flex; justify-content: space-between; font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; opacity: .8; margin-bottom: 3px; }
    #hp-vit .bar { display: flex; gap: 2px; height: 8px; }
    #hp-vit .bar i { flex: 1; background: rgba(255,255,255,.16); transform: skewX(-18deg); }
    #hp-vit .bar i.on { background: #8ff0c8; }
    #hp-vit.low .bar i.on { background: #ff5a4a; } #hp-vit.low .num { color: #ff8a70; }
    #hp-vit .arm { height: 4px; margin-top: 3px; background: rgba(255,255,255,.14); }
    #hp-vit .arm b { display: block; height: 100%; background: #7fb8ff; }
    #hp-vit .kit { display: flex; gap: 14px; margin-bottom: 9px; font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; }
    #hp-vit .kit span { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; background: rgba(8,12,16,.5); }
    #hp-vit .kit b { font-size: 14px; }
    #hp-vit .kit kbd { font: inherit; font-size: 9px; padding: 0 4px; border: 1px solid rgba(255,255,255,.4); opacity: .8; }
    #hp-vit .kit .pip { width: 8px; height: 8px; }
    #wp-health, #rd-kit { display: none !important; } /* replaced by the vitals block */

    /* top-centre: one tidy stack — status line, heat, detection, shield */
    #rd-top .line { background: rgba(8,12,16,.6) !important; border-bottom: 2px solid rgba(255,197,107,.7); padding: 5px 16px !important; }
    #ht { top: 84px !important; padding: 3px 10px; background: rgba(8,12,16,.42); }
    #dt-status { top: 110px !important; }
    #rd-top .sub { position: absolute; left: 0; right: 0; top: 80px; text-align: center; }`;
  document.head.appendChild(style);

  const map = document.createElement('div'); map.id = 'hp-map'; map.hidden = true;
  map.innerHTML = `<canvas width="${SIZE * 2}" height="${SIZE * 2}"></canvas><div class="n">N</div><div class="d"></div>`;
  const vit = document.createElement('div'); vit.id = 'hp-vit'; vit.hidden = true;
  vit.innerHTML = `<div class="kit"></div><div class="row"><div class="num">100</div><div class="side"><div class="lbl"><span>Vitals</span><span class="ar"></span></div><div class="bar">${'<i></i>'.repeat(20)}</div><div class="arm"><b></b></div></div></div>`;
  ctx.hud.appendChild(map); ctx.hud.appendChild(vit);
  const g = map.querySelector('canvas').getContext('2d'), nEl = map.querySelector('.n'), dEl = map.querySelector('.d');
  const num = vit.querySelector('.num'), segs = [...vit.querySelectorAll('.bar i')], armB = vit.querySelector('.arm b'), arL = vit.querySelector('.ar'), kit = vit.querySelector('.kit');
  let frame = 0, lastHp = -1, lastKit = '';

  // gunfire pings: a small ring buffer, no allocation per shot
  const pings = Array.from({ length: 40 }, () => ({ x: 0, z: 0, t: -99, raider: false })); let pi = 0;
  events.on('shot', (e) => {
    if (!e.by || e.by === player || !e.origin) return;
    const dx = e.origin.x - player.pos.x, dz = e.origin.z - player.pos.z; if (dx * dx + dz * dz > 130 * 130) return;
    const p = pings[pi]; pi = (pi + 1) % pings.length; p.x = e.origin.x; p.z = e.origin.z; p.t = ctx.time; p.raider = e.by.faction === 'raider';
  });

  const C = R + 4;
  function draw() {
    const px = player.pos.x, pz = player.pos.z, cos = Math.cos(player.yaw), sin = Math.sin(player.yaw);
    g.setTransform(2, 0, 0, 2, 0, 0); g.clearRect(0, 0, SIZE, SIZE);
    g.save(); g.beginPath(); g.arc(C, C, R, 0, Math.PI * 2); g.clip();
    // world space: ahead of you is up
    g.setTransform(2 * cos * K, 2 * sin * K, -2 * sin * K, 2 * cos * K, 2 * (C - (px * cos - pz * sin) * K), 2 * (C - (px * sin + pz * cos) * K));
    const near = (x0, x1, z0, z1) => x1 > px - RANGE - 4 && x0 < px + RANGE + 4 && z1 > pz - RANGE - 4 && z0 < pz + RANGE + 4;
    g.fillStyle = 'rgba(255,255,255,.07)'; for (const [x0, x1, z0, z1] of world.roads || []) if (near(x0, x1, z0, z1)) g.fillRect(x0, z0, x1 - x0, z1 - z0);
    g.fillStyle = 'rgba(190,200,210,.75)'; for (const c of world.compoundWalls || []) if (near(c.min.x, c.max.x, c.min.z, c.max.z)) g.fillRect(c.min.x, c.min.z, Math.max(0.9, c.max.x - c.min.x), Math.max(0.9, c.max.z - c.min.z));
    const A = world.arenaHalf; g.strokeStyle = 'rgba(190,200,210,.75)'; g.lineWidth = 1.2; g.strokeRect(-A, -A, A * 2, A * 2);
    for (const b of world.buildings) { if (!near(b.x - b.w / 2, b.x + b.w / 2, b.z - b.d / 2, b.z + b.d / 2)) continue; g.fillStyle = b.hq ? 'rgba(212,139,255,.5)' : b.outpost ? 'rgba(127,214,255,.45)' : 'rgba(150,162,175,.6)'; g.fillRect(b.x - b.w / 2, b.z - b.d / 2, b.w, b.d); }
    g.fillStyle = 'rgba(150,162,175,.4)'; for (const b of world.outbuildings || []) if (near(b.x - b.w / 2, b.x + b.w / 2, b.z - b.d / 2, b.z + b.d / 2)) g.fillRect(b.x - b.w / 2, b.z - b.d / 2, b.w, b.d);
    if (world.strongroom) { g.fillStyle = '#d48bff'; g.fillRect(-4, -3, 8, 6); }
    for (const l of world.ladders || []) if (near(l.x, l.x, l.z, l.z)) { g.fillStyle = l.fast ? '#ffc56b' : '#e8edf2'; g.fillRect(l.x - 1, l.z - 1, 2, 2); }
    g.fillStyle = '#35e0d8'; for (const p of world.pads) if (near(p.x, p.x, p.z, p.z)) { g.beginPath(); g.arc(p.x, p.z, 1.6, 0, Math.PI * 2); g.fill(); }
    const raid = ctx.raid;
    if (raid) for (const L of raid.lootables) if (L.kind === 'locker' && L.seen && !L.opened && near(L.pos.x, L.pos.x, L.pos.z, L.pos.z)) { g.fillStyle = '#ff6a00'; g.fillRect(L.pos.x - 1.3, L.pos.z - 1.3, 2.6, 2.6); }
    // gunfire you can hear
    for (const p of pings) { const age = ctx.time - p.t; if (age > 2.6) continue; g.globalAlpha = 1 - age / 2.6; g.fillStyle = p.raider ? '#e0a83a' : '#ff5a4a'; g.beginPath(); g.arc(p.x, p.z, 1.6 + age * 1.6, 0, Math.PI * 2); g.fill(); }
    g.globalAlpha = 1;
    // enemies only while a signal tap is active
    if (raid && raid.revealT > 0 && ctx.bots) for (const b of ctx.bots.list) if (b.alive && near(b.pos.x, b.pos.x, b.pos.z, b.pos.z)) { g.fillStyle = b.faction === 'raider' ? '#e0a83a' : '#ff5a4a'; g.beginPath(); g.arc(b.pos.x, b.pos.z, 1.8, 0, Math.PI * 2); g.fill(); }
    g.restore(); g.setTransform(2, 0, 0, 2, 0, 0);
    // exits and marks: on the map if in range, otherwise pinned to the rim in their direction
    const marks = (raid ? raid.zones.filter((z) => z.active) : []).concat(ctx.worldEvents ? ctx.worldEvents.marks : []);
    for (const m of marks) {
      const dx = m.x - px, dz = m.z - pz; let sx = (dx * cos - dz * sin) * K, sy = (dx * sin + dz * cos) * K; const d = Math.hypot(sx, sy), rim = d > R - 7;
      if (rim) { sx *= (R - 7) / d; sy *= (R - 7) / d; }
      g.save(); g.translate(C + sx, C + sy); g.rotate(Math.PI / 4); g.fillStyle = m.css || '#9be37a'; g.globalAlpha = rim ? 0.85 : 1; const s = rim ? 4 : 5; g.fillRect(-s, -s, s * 2, s * 2); g.restore();
    }
    // you
    g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 1; g.beginPath(); g.moveTo(C, C - 7); g.lineTo(C + 5, C + 5); g.lineTo(C, C + 2); g.lineTo(C - 5, C + 5); g.closePath(); g.fill(); g.stroke();
    // north marker rides the rim
    nEl.style.left = `${C - Math.sin(player.yaw) * (R + 1)}px`; nEl.style.top = `${C - Math.cos(player.yaw) * (R + 1) - 6}px`;
  }

  return {
    update() {
      const raid = ctx.raid, inRaid = raid && raid.state === 'raid';
      map.hidden = vit.hidden = !inRaid; if (!inRaid) return;
      if (frame++ % 2 === 0) draw();
      if (frame % 20 === 0 && raid.districtAt) dEl.textContent = raid.districtAt(player.pos.x, player.pos.z);
      const hp = Math.max(0, Math.round(player.hp)), max = player.maxHp || 100, armor = Math.round(raid.armor || 0);
      const key = hp * 1000 + armor;
      if (key !== lastHp) {
        lastHp = key; num.textContent = hp; const on = Math.ceil((hp / max) * segs.length);
        for (let i = 0; i < segs.length; i++) segs[i].className = i < on ? 'on' : '';
        vit.classList.toggle('low', hp / max < 0.3);
        armB.style.width = `${Math.min(100, armor)}%`; arL.textContent = armor ? `Armour ${armor}` : 'No armour';
      }
      const k = `${raid.medkits}|${raid.keycards}`;
      if (k !== lastKit) {
        lastKit = k;
        kit.innerHTML = `<span><i class="pip" style="background:#8ff0c8"></i>Medkits <b>${raid.medkits}</b><kbd>H</kbd></span>${raid.keycards ? `<span style="color:#d48bff"><i class="pip" style="background:#d48bff"></i>Keycards <b>${raid.keycards}</b></span>` : ''}`;
      }
    },
  };
}
