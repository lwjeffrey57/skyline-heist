// Full map (M): the whole arena from above with districts, buildings, the strongroom, exits, jump pads, ziplines and
// any arms lockers you have come close to. North is up. The raid keeps running while it is open.

const SIZE = 600; // canvas px
const DISTRICT_AT = { Plaza: [0, 0], Depot: [0, 46], 'Freight Row': [0, -46], Works: [-46, 0], Exchange: [46, 0] };

export function init(ctx) {
  const { player, world, input } = ctx;
  const style = document.createElement('style');
  style.textContent = `
    #mp { position: fixed; inset: 0; z-index: 15; display: flex; align-items: center; justify-content: center; background: rgba(5,7,10,.45); pointer-events: none; }
    #mp .box { padding: 0 20px 14px; background: rgba(8,11,15,.92); border-top: 3px solid #ffc56b; color: #fff; }
    #mp h2 { margin: 0 -20px 10px; padding: 12px 20px 9px; font-size: 18px; letter-spacing: 6px; text-transform: uppercase; background: rgba(255,255,255,.04); }
    #mp canvas { display: block; }
    #mp .lg { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 9px; font-size: 11px; letter-spacing: 1px; opacity: .85; }
    #mp .lg i { display: inline-block; width: 9px; height: 9px; margin-right: 5px; vertical-align: -1px; }`;
  document.head.appendChild(style);
  const root = document.createElement('div'); root.id = 'mp'; root.hidden = true;
  root.innerHTML = `<div class="box"><h2>Map</h2><canvas width="${SIZE}" height="${SIZE}"></canvas>
    <div class="lg"><span><i style="background:#9be37a"></i>Exit</span><span><i style="background:#d48bff"></i>Key exit / strongroom</span><span><i style="background:#ffc56b"></i>Beacon exit / zipline</span><span><i style="background:#ff6a00"></i>Arms locker (found)</span><span><i style="background:#35e0d8"></i>Jump pad</span><span><i style="background:#fff"></i>You</span><span>2F = floors</span><span>Threat: <b style="color:#9be37a">low</b> <b style="color:#ffe14a">medium</b> <b style="color:#ff9a3c">high</b> <b style="color:#ff5a4a">critical</b></span><span style="margin-left:auto;opacity:.6">M to close</span></div></div>`;
  ctx.hud.appendChild(root);
  const g = root.querySelector('canvas').getContext('2d');
  const A = world.arenaHalf, HALF = A + 4, K = SIZE / (HALF * 2); // metres from centre to the wall, to the map edge, px per metre
  const X = (x) => (x + HALF) * K, Z = (z) => (z + HALF) * K;
  let open = false, frame = 0;

  function draw() {
    g.clearRect(0, 0, SIZE, SIZE);
    g.fillStyle = '#12171d'; g.fillRect(X(-A), Z(-A), A * 2 * K, A * 2 * K);
    // district borders and names
    g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 1; g.setLineDash([5, 5]);
    g.strokeRect(X(-17), Z(-17), 34 * K, 34 * K);
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { g.beginPath(); g.moveTo(X(17 * sx), Z(17 * sz)); g.lineTo(X(A * sx), Z(A * sz)); g.stroke(); }
    g.setLineDash([]);
    // roads, then the compound's walls
    g.fillStyle = '#1d242c'; for (const [x0, x1, z0, z1] of world.roads || []) g.fillRect(X(x0), Z(z0), (x1 - x0) * K, (z1 - z0) * K);
    g.fillStyle = '#9aa6b2'; for (const c of world.compoundWalls || []) { if (!world.colliders.includes(c)) continue; g.fillRect(X(c.min.x), Z(c.min.z), Math.max(1.5, (c.max.x - c.min.x) * K), Math.max(1.5, (c.max.z - c.min.z) * K)); }
    // cover and containers
    for (const c of world.colliders) {
      if (c.tag !== 'cover' && c.tag !== 'container' || c.min.y > 0.5) continue;
      g.fillStyle = c.tag === 'container' ? '#3d4a57' : '#2c343d';
      g.fillRect(X(c.min.x), Z(c.min.z), Math.max(2, (c.max.x - c.min.x) * K), Math.max(2, (c.max.z - c.min.z) * K));
    }
    // buildings
    g.font = '600 10px "Bahnschrift","Arial Narrow",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const b of world.buildings.concat(world.outbuildings || [])) {
      g.fillStyle = '#56616d'; g.fillRect(X(b.x - b.w / 2), Z(b.z - b.d / 2), b.w * K, b.d * K);
      g.strokeStyle = '#8b97a3'; g.strokeRect(X(b.x - b.w / 2) + 0.5, Z(b.z - b.d / 2) + 0.5, b.w * K, b.d * K);
      g.fillStyle = 'rgba(255,255,255,.75)'; g.fillText(`${b.floors}F`, X(b.x), Z(b.z));
      const tc = b.threat && world.threatColors ? world.threatColors[b.threat] : null;
      if (tc) { g.fillStyle = tc; g.fillText(b.threat.toUpperCase(), X(b.x), Z(b.z + b.d / 2) + 20); g.strokeStyle = tc; g.lineWidth = 2; g.strokeRect(X(b.x - b.w / 2), Z(b.z - b.d / 2), b.w * K, b.d * K); g.lineWidth = 1; }
      if (b.tower) { g.fillStyle = '#ffc56b'; g.fillText(b.hq ? 'HEADQUARTERS' : b.warehouse ? 'WAREHOUSE' : b.w > 24 ? 'HALL' : 'TOWER', X(b.x), Z(b.z + b.d / 2) + 9); }
      if (b.outpost) { g.fillStyle = '#7fd6ff'; g.fillText(b.outpost === 'depot' ? 'SUPPLY DUMP' : b.outpost.toUpperCase(), X(b.x), Z(b.z + b.d / 2) + 9); }
    }
    // perimeter
    g.strokeStyle = '#8b97a3'; g.lineWidth = 2; g.strokeRect(X(-A), Z(-A), A * 2 * K, A * 2 * K); g.lineWidth = 1;
    // district names
    g.font = '600 11px "Bahnschrift","Arial Narrow",sans-serif'; g.fillStyle = 'rgba(255,197,107,.8)';
    for (const name in DISTRICT_AT) { const [dx, dz] = DISTRICT_AT[name], x = (dx / 46) * A * 0.72, z = (dz / 46) * A * 0.72; g.fillText(name.toUpperCase(), X(x), Z(z) + (name === 'Plaza' ? 26 : 0)); }
    // ziplines and pads
    g.strokeStyle = '#ffc56b'; for (const z of world.ziplines) { if (z.dead) continue; g.beginPath(); g.moveTo(X(z.a.x), Z(z.a.z)); g.lineTo(X(z.b.x), Z(z.b.z)); g.stroke(); }
    g.fillStyle = '#35e0d8'; for (const p of world.pads) { g.beginPath(); g.arc(X(p.x), Z(p.z), 4, 0, Math.PI * 2); g.fill(); }
    // strongroom
    if (world.strongroom) { g.fillStyle = '#d48bff'; g.fillRect(X(-4), Z(-3), 8 * K, 6 * K); g.fillStyle = '#14100a'; g.font = '700 9px "Bahnschrift","Arial Narrow",sans-serif'; g.fillText(world.strongroom.open ? 'OPEN' : 'VAULT', X(0), Z(0)); }
    // lockers you have been near
    const raid = ctx.raid;
    if (raid) for (const L of raid.lootables) { if (L.kind !== 'locker' || !L.seen || L.opened) continue; g.fillStyle = '#ff6a00'; g.fillRect(X(L.pos.x) - 4, Z(L.pos.z) - 4, 8, 8); }
    // exits
    g.font = '700 10px "Bahnschrift","Arial Narrow",sans-serif';
    if (raid) for (const zn of raid.zones) {
      if (!zn.active) continue;
      const x = X(Math.max(-A + 2, Math.min(A - 2, zn.x))), z = Z(Math.max(-A + 2, Math.min(A - 2, zn.z)));
      g.save(); g.translate(x, z); g.rotate(Math.PI / 4); g.fillStyle = zn.css || '#9be37a'; g.fillRect(-6, -6, 12, 12); g.restore();
      g.fillStyle = zn.css || '#9be37a'; g.fillText(zn.title || 'EXIT', x, z + (zn.z > 0 ? -15 : 15));
    }
    // supply drops and the site commander's last reported position
    if (ctx.worldEvents) for (const m of ctx.worldEvents.marks) { g.fillStyle = m.css; g.beginPath(); g.arc(X(m.x), Z(m.z), 6, 0, Math.PI * 2); g.fill(); g.fillText(m.title, X(m.x), Z(m.z) - 13); }
    // guards and drones, while a signal terminal's tap lasts
    if (raid && raid.revealT > 0) { g.fillStyle = '#ff5a4a'; for (const b of (ctx.bots ? ctx.bots.list : []).concat(ctx.drones ? ctx.drones.list : [], ctx.turrets ? ctx.turrets.list : [])) if (b.alive) { g.fillStyle = b.faction === 'raider' ? '#e0a83a' : '#ff5a4a'; g.beginPath(); g.arc(X(b.pos.x), Z(b.pos.z), 3.5, 0, Math.PI * 2); g.fill(); } }
    // you: an arrow pointing where you face
    g.save(); g.translate(X(player.pos.x), Z(player.pos.z)); g.rotate(-player.yaw);
    g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.beginPath(); g.moveTo(0, -9); g.lineTo(6, 7); g.lineTo(0, 3); g.lineTo(-6, 7); g.closePath(); g.fill(); g.stroke(); g.restore();
  }

  return {
    update() {
      const raid = ctx.raid, inRaid = raid && raid.state === 'raid';
      if (inRaid && raid.lootables && frame % 15 === 0) for (const L of raid.lootables) if (L.kind === 'locker' && !L.seen && Math.hypot(L.pos.x - player.pos.x, L.pos.z - player.pos.z) < 20) L.seen = true;
      if (inRaid && input.pressed.has('KeyM') && !ctx.uiOpen) open = !open;
      if (!inRaid || ctx.uiOpen) open = false;
      root.hidden = !open;
      if (open && frame % 5 === 0) draw();
      frame++;
    },
  };
}
