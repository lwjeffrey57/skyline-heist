import * as THREE from 'three';

// Free-for-all deathmatch: everyone against everyone. Tracks kills, shows the standings,
// ends the match at the kill limit or time limit, and keeps (re)spawns fair.

const MATCH = { bots: 7, botDamage: 6, killLimit: 20, timeLimit: 600 };
const PROTECT_TIME = 4;
const SPAWNS = [[0, 50], [-48, 58], [48, 58], [-62, 20], [62, 22], [-62, -20], [62, -10], [-40, -60], [0, -60], [36, -60], [-20, 60], [26, 46]];

export function init(ctx) {
  const { player, world, events, input } = ctx;
  player.name = 'You';
  const stats = new Map(); // combatant -> { kills, deaths }
  const stat = (who) => { if (!stats.has(who)) stats.set(who, { kills: 0, deaths: 0 }); return stats.get(who); };
  let timeLeft = MATCH.timeLimit, over = false, winner = null;

  const style = document.createElement('style');
  style.textContent = `
    #dir-top { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); text-align: center; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,.75); pointer-events: none; font-variant-numeric: tabular-nums; }
    #dir-top .mode { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; opacity: .7; }
    #dir-top .line { font-size: 15px; font-weight: 700; letter-spacing: 1px; }
    #dir-top .line span { opacity: .6; font-weight: 500; margin: 0 6px; }
    #dir-shield { margin-top: 4px; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: #7ff3ea; }
    #dir-feed { position: fixed; top: 170px; right: 28px; text-align: right; font-size: 12px; letter-spacing: 1px; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,.75); pointer-events: none; }
    #dir-feed div { opacity: .8; margin-top: 3px; transition: opacity .6s; }
    #dir-feed b { color: #ff8a70; font-weight: 600; }
    #dir-board { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
    #dir-board .panel { min-width: 380px; padding: 22px 26px; background: rgba(8,11,15,.82); border: 1px solid rgba(255,255,255,.14); color: #fff; }
    #dir-board h2 { margin: 0 0 4px; font-size: 20px; letter-spacing: 3px; text-transform: uppercase; }
    #dir-board p { margin: 0 0 14px; font-size: 12px; letter-spacing: 1px; opacity: .7; }
    #dir-board table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
    #dir-board th { text-align: right; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; opacity: .6; font-weight: 500; padding: 4px 8px; }
    #dir-board th:nth-child(2), #dir-board td:nth-child(2) { text-align: left; }
    #dir-board td { text-align: right; padding: 5px 8px; border-top: 1px solid rgba(255,255,255,.08); }
    #dir-board tr.me td { color: #ffc56b; font-weight: 700; }`;
  document.head.appendChild(style);
  const top = document.createElement('div'); top.id = 'dir-top';
  top.innerHTML = '<div class="mode">Free for all</div><div class="line"></div><div id="dir-shield" hidden></div>';
  const feed = document.createElement('div'); feed.id = 'dir-feed';
  const board = document.createElement('div'); board.id = 'dir-board'; board.hidden = true;
  ctx.hud.append(top, feed, board);
  const line = top.querySelector('.line'), shield = top.querySelector('#dir-shield');

  // everyone seen this match, including bots that are waiting to respawn
  const combatants = () => { for (const t of ctx.targets) if (t === player || t.name) stat(t); return [...stats.keys()]; };
  const standings = () => combatants().map((c) => ({ c, ...stat(c) })).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

  function addFeed(killer, victim) {
    const row = document.createElement('div');
    row.innerHTML = `${esc(killer)} <b>▸</b> ${esc(victim)}`;
    feed.prepend(row);
    while (feed.children.length > 4) feed.lastChild.remove();
    setTimeout(() => { row.style.opacity = '0'; }, 4000);
    setTimeout(() => row.remove(), 4700);
  }

  function credit(killer, victim) {
    if (over) return;
    stat(victim).deaths++;
    if (killer && killer !== victim && (killer === player || killer.name)) {
      stat(killer).kills++;
      if (killer !== player) addFeed(killer.name, victim.name); // the player's own kills show in the weapon kill feed
      if (stat(killer).kills >= MATCH.killLimit) endMatch(killer);
    }
  }
  events.on('botDied', (e) => credit(e.by, e.bot));
  events.on('playerDied', (info) => credit(info && info.source, player));

  function renderBoard(title, sub) {
    const rows = standings().map((s, i) => `<tr class="${s.c === player ? 'me' : ''}"><td>${i + 1}</td><td>${esc(s.c.name)}</td><td>${s.kills}</td><td>${s.deaths}</td></tr>`).join('');
    board.innerHTML = `<div class="panel"><h2>${title}</h2><p>${sub}</p><table><tr><th>#</th><th>Name</th><th>Kills</th><th>Deaths</th></tr>${rows}</table></div>`;
  }

  function endMatch(who) {
    over = true; winner = who || standings()[0].c;
    player.protectT = 1e9; // nobody can hurt the player on the results screen
    if (ctx.bots) ctx.bots.setCount(0);
    events.emit('matchOver', { winner, playerWon: winner === player });
  }

  function startMatch() {
    stats.clear(); timeLeft = MATCH.timeLimit; over = false; winner = null; feed.innerHTML = '';
    if (ctx.bots) { ctx.bots.config.damage = MATCH.botDamage; ctx.bots.setCount(MATCH.bots); if (ctx.bots.respawnAll) ctx.bots.respawnAll(); }
    player.respawn();
    events.emit('matchStart', {});
  }

  // choose the spawn point that is hidden from, and farthest from, every living opponent
  const eye = new THREE.Vector3(), tgt = new THREE.Vector3();
  player.pickSpawn = () => {
    const others = ctx.targets.filter((t) => t !== player && t.alive);
    let best = null, bestScore = -Infinity;
    for (const [x, z] of SPAWNS) {
      if (!player.free(x, 0.01, z, 1.8)) continue;
      eye.set(x, 1.6, z);
      let minD = 200, seen = 0;
      for (const b of others) {
        minD = Math.min(minD, Math.hypot(b.pos.x - x, b.pos.z - z));
        tgt.set(b.pos.x, b.pos.y + 1.5, b.pos.z);
        if (world.lineOfSight(eye, tgt)) seen++;
      }
      const score = minD - seen * 60;
      if (score > bestScore) { bestScore = score; best = [x, z]; }
    }
    if (best) { world.spawn.set(best[0], 0, best[1]); world.spawnYaw = Math.atan2(best[0], best[1]); }
  };
  events.on('shot', (e) => { if (e.by === player && !over) player.protectT = 0; }); // attacking ends spawn protection
  player.protectTime = PROTECT_TIME; player.protectT = PROTECT_TIME;
  if (ctx.bots) { ctx.bots.config.damage = MATCH.botDamage; ctx.bots.setCount(MATCH.bots); }

  ctx.match = { config: MATCH, stats, standings, get over() { return over; }, get timeLeft() { return timeLeft; }, restart: startMatch, end: endMatch };
  return {
    update(dt) {
      if (over) {
        player.protectT = 1e9;
        renderBoard(winner === player ? 'You win' : `${esc(winner.name)} wins`, 'Match over — press Enter for a new match');
        board.hidden = false; shield.hidden = true;
        if (input.pressed.has('Enter')) startMatch();
        return;
      }
      timeLeft -= dt;
      if (timeLeft <= 0) { timeLeft = 0; endMatch(null); return; }
      const st = standings(), rank = st.findIndex((s) => s.c === player) + 1, lead = st[0];
      const m = Math.floor(timeLeft / 60), s = Math.floor(timeLeft % 60);
      line.innerHTML = `${m}:${String(s).padStart(2, '0')}<span>·</span>${ordinal(rank)} ${stat(player).kills}/${MATCH.killLimit}<span>·</span>Leader ${esc(lead.c.name)} ${lead.kills}`;
      const shielded = player.protectT > 0;
      shield.hidden = !shielded;
      if (shielded) shield.textContent = `Spawn shield ${player.protectT.toFixed(1)}s — firing ends it`;
      const show = input.down('Tab');
      if (show) renderBoard('Free for all', `First to ${MATCH.killLimit} kills — ${m}:${String(s).padStart(2, '0')} left`);
      board.hidden = !show;
    },
  };
}

function ordinal(n) { return n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'); }
