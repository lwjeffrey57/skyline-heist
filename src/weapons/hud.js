// Weapon HUD: crosshair, hitmarker, ammo, weapon slots, health, damage direction, scope overlay.
// (headshot marker, skull, score popups, kill feed: scorehud.js)
// All DOM lives under #wp-hud inside ctx.hud; everything is driven from update() (no CSS animations),
// so it stays in sync with the simulation.

import { createScoreHud } from './scorehud.js';

const CSS = `
#crosshair{display:none!important}
#wp-hud{position:fixed;inset:0;pointer-events:none;font-family:"Bahnschrift","DIN Alternate","Roboto Condensed","Arial Narrow",system-ui,sans-serif;color:#fff;--wp-accent:#22e0c8;user-select:none;overflow:hidden}
#wp-hud *{box-sizing:border-box}
#wp-cross,#wp-hit{position:absolute;left:50%;top:50%;width:0;height:0}
#wp-cross i{position:absolute;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.55);border-radius:1px}
#wp-cross .wp-h{width:9px;height:2px;margin:-1px 0 0 -4.5px}
#wp-cross .wp-v{width:2px;height:9px;margin:-4.5px 0 0 -1px}
#wp-cross .wp-dot{width:2px;height:2px;margin:-1px 0 0 -1px}
#wp-cross .wp-ring{background:none;border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.45),inset 0 0 0 1px rgba(0,0,0,.45)}
#wp-cross .wp-arc{background:none;border:2px solid transparent;border-radius:50%;box-shadow:none}
#wp-hit i{position:absolute;width:2px;height:8px;margin:-4px 0 0 -1px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.5);border-radius:1px;will-change:transform}
#wp-stag{position:absolute;left:50%;top:50%;border:1.5px solid #8fe6ff;border-radius:50%;opacity:0;box-shadow:0 0 0 1px rgba(0,0,0,.35)}
#wp-rl{position:absolute;left:50%;top:calc(50% + 44px);width:92px;height:4px;margin-left:-46px;background:rgba(0,0,0,.5);opacity:0;transform:skewX(-20deg)}
#wp-rl div{height:100%;width:100%;background:var(--wp-accent);transform-origin:0 50%;box-shadow:0 0 8px var(--wp-accent)}
#wp-hint{position:absolute;left:50%;top:calc(50% + 56px);transform:translateX(-50%);font-size:12px;font-weight:700;letter-spacing:3px;text-shadow:0 1px 3px #000;opacity:0;white-space:nowrap}
#wp-hint.wp-warn{color:#ffb020}#wp-hint.wp-bad{color:#ff5a4d}
#wp-scope{position:absolute;inset:0;opacity:0;-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px)}
#wp-vig{position:absolute;inset:0;opacity:0;background:radial-gradient(ellipse at center,transparent 45%,rgba(200,10,0,.55) 100%)}
#wp-dmg{position:absolute;left:50%;top:50%;width:0;height:0}
#wp-dmg svg{position:absolute;left:-40vh;top:-40vh;width:80vh;height:80vh;overflow:visible;opacity:0}
#wp-dmg svg path{fill:rgba(255,38,28,.6);filter:blur(2.2px)}
#wp-dmg svg polygon{fill:#ff2a1e}
.wp-panel{position:absolute;text-shadow:0 1px 3px rgba(0,0,0,.8)}
#wp-health{left:24px;bottom:96px;width:250px}
#wp-health .wp-row{display:flex;align-items:flex-end;gap:10px;margin-bottom:5px}
#wp-hpn{font-size:34px;font-weight:700;line-height:.9;font-variant-numeric:tabular-nums;min-width:58px}
#wp-health .wp-lbl{font-size:11px;letter-spacing:3px;opacity:.75;padding-bottom:2px}
#wp-hpbar{position:relative;height:9px;background:rgba(8,12,16,.55);transform:skewX(-20deg);overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.14)}
#wp-hpbar div{position:absolute;left:0;top:0;bottom:0;width:100%;transform-origin:0 50%}
#wp-hpghost{background:#fff;opacity:.85}
#wp-hpfill{background:linear-gradient(90deg,#e8fff6,#7dffc9)}
#wp-hpbar:after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0,transparent 23px,rgba(8,12,16,.8) 23px,rgba(8,12,16,.8) 25px)}
#wp-health.wp-low #wp-hpfill{background:linear-gradient(90deg,#ff8a7a,#ff3b30)}
#wp-health.wp-low #wp-hpn{color:#ff6a5c}
#wp-ammo{right:28px;bottom:22px;text-align:right}
#wp-name{font-size:13px;font-weight:700;letter-spacing:3px}
#wp-att{display:flex;justify-content:flex-end;gap:4px;margin-bottom:5px;min-height:0}
#wp-att span{font-size:9px;font-weight:700;letter-spacing:1.5px;padding:2px 5px 1px;background:rgba(8,12,16,.6);border-bottom:2px solid var(--wp-accent);color:#fff}
#wp-tag{font-size:10px;letter-spacing:2.5px;opacity:.6;text-transform:uppercase;margin-bottom:2px}
#wp-count{display:flex;justify-content:flex-end;align-items:baseline;gap:8px;line-height:1}
#wp-mag{font-size:60px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-1px;display:inline-block;transform-origin:100% 80%}
#wp-res{font-size:22px;font-weight:600;opacity:.7;font-variant-numeric:tabular-nums;min-width:44px;text-align:left}
#wp-ammo.wp-low #wp-mag{color:#ffb020}#wp-ammo.wp-empty #wp-mag{color:#ff4a3d}
#wp-bar{height:4px;width:210px;margin:4px 0 6px auto;background:rgba(8,12,16,.55);transform:skewX(-20deg);overflow:hidden}
#wp-bar div{height:100%;background:var(--wp-accent);transform-origin:100% 50%;box-shadow:0 0 8px var(--wp-accent)}
#wp-meta{display:flex;justify-content:flex-end;gap:12px;font-size:11px;letter-spacing:2px;align-items:center}
#wp-mode{padding:2px 7px;background:rgba(8,12,16,.55);border-left:2px solid var(--wp-accent)}
#wp-gren{display:flex;gap:4px;align-items:center}
#wp-gren span{opacity:.7;margin-right:2px}
#wp-gren i{width:11px;height:11px;border-radius:50%;border:2px solid #fff;position:relative;overflow:hidden;opacity:.45}
#wp-gren i.wp-on{background:#ff7a4a;border-color:#ff7a4a;opacity:1;box-shadow:0 0 8px #ff7a4a}
#wp-gren i u{position:absolute;left:0;right:0;bottom:0;background:#fff;opacity:.7}
#wp-slots{right:28px;bottom:172px;display:flex;flex-direction:column;gap:3px;align-items:flex-end}
#wp-slots div{font-size:10px;letter-spacing:2px;padding:3px 8px 3px 6px;background:rgba(8,12,16,.42);opacity:.5;border-right:2px solid transparent;display:flex;gap:8px}
#wp-slots div b{opacity:.7}
#wp-slots div.wp-cur{opacity:1;border-right-color:var(--wp-accent);background:rgba(8,12,16,.7)}
#wp-slots div.wp-dry{color:#ff6a5c}
`;

const el = (tag, id, parent, cls) => { const e = document.createElement(tag); if (id) e.id = id; if (cls) e.className = cls; parent.appendChild(e); return e; };

export function createHud(ctx, weapons) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const root = el('div', 'wp-hud', ctx.hud);

  const vig = el('div', 'wp-vig', root);
  const scope = el('div', 'wp-scope', root);

  const dmg = el('div', 'wp-dmg', root);
  // soft crescent (about 100 degrees, thick in the middle, tapering to nothing) + a small inward triangle at its middle
  const ARC = '<svg viewBox="-100 -100 200 200"><path d="M-76.6 -64.3 A100 100 0 0 1 76.6 -64.3 A118.5 118.5 0 0 0 -76.6 -64.3 Z"/><polygon points="-4.2,-90.5 4.2,-90.5 0,-82.5"/></svg>';
  const arcs = []; for (let i = 0; i < 3; i++) { const d = el('div', null, dmg); d.innerHTML = ARC; arcs.push({ el: d.firstChild, age: 9, from: null, amount: 0 }); d.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0'; }
  const srcAngle = (from) => { const p = ctx.player, fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), dx = from.x - p.pos.x, dz = from.z - p.pos.z; return Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz); };
  const ARC_IN = 0.07, ARC_HOLD = 0.8, ARC_OUT = 0.35;

  // crosshair: 4 lines + dot + ring (shotgun) + arc ticks
  const cross = el('div', 'wp-cross', root);
  const lines = [el('i', null, cross, 'wp-v'), el('i', null, cross, 'wp-h'), el('i', null, cross, 'wp-v'), el('i', null, cross, 'wp-h')];
  const dot = el('i', null, cross, 'wp-dot');
  const ring = el('i', null, cross, 'wp-ring');
  const hit = el('div', 'wp-hit', root);
  // minimal marker: four small diagonal ticks (white; red for a headshot). A kill snaps the mark outward and
  // adds a second, shorter set of ticks outside it (a double X). `hring` is the armour-break / stagger ring (only if enemies emit it).
  const ticks = [0, 1, 2, 3, 4, 5, 6, 7].map(() => el('i', null, hit));
  const hring = el('u', 'wp-stag', root);
  hit.style.opacity = '0';
  const TA = ticks.map((_, i) => Math.PI / 4 + (i % 4) * Math.PI / 2), TS = TA.map(Math.sin), TC = TA.map(Math.cos);
  const rl = el('div', 'wp-rl', root); const rlFill = el('div', null, rl);
  const hint = el('div', 'wp-hint', root);

  const health = el('div', 'wp-health', root, 'wp-panel');
  health.innerHTML = '<div class="wp-row"><div id="wp-hpn">100</div><div class="wp-lbl">VITALS</div></div><div id="wp-hpbar"><div id="wp-hpghost"></div><div id="wp-hpfill"></div></div>';
  const hpn = health.querySelector('#wp-hpn'), hpGhost = health.querySelector('#wp-hpghost'), hpFill = health.querySelector('#wp-hpfill');

  const slots = el('div', 'wp-slots', root, 'wp-panel');
  const slotEls = weapons.map((w, i) => { const d = el('div', null, slots); d.innerHTML = `<span>${w.name}</span><b>${i + 1}</b>`; return d; });

  const ammo = el('div', 'wp-ammo', root, 'wp-panel');
  ammo.innerHTML = '<div id="wp-att"></div><div id="wp-tag"></div><div id="wp-name"></div><div id="wp-count"><span id="wp-mag">0</span><span id="wp-res">0</span></div><div id="wp-bar"><div></div></div>'
    + '<div id="wp-meta"><div id="wp-gren"><span>G</span></div><div id="wp-mode"></div></div>';
  const q = (s) => ammo.querySelector(s);
  const attEl = q('#wp-att'), nameEl = q('#wp-name'), tagEl = q('#wp-tag'), magEl = q('#wp-mag'), resEl = q('#wp-res'), barEl = q('#wp-bar div'), modeEl = q('#wp-mode'), grenEl = q('#wp-gren');
  const grenPips = [];
  const score = createScoreHud(ctx, root);

  const S = { hsT: 9, killHead: false, hitT: 9, hitDur: 0.2, head: false, kill: false, killT: 9, hitOn: false, hitCol: '', hitKill: null, stagT: 9, stagOn: false, stagBreak: false, dry: [], lock: [], magPop: 0, ghost: 1, hurt: 0, lastMag: -1, lastRes: -1, lastHp: -1, lastName: '', lastAtt: null, lastMode: '', gap: 20, lastIdx: -1 };
  const tx = (e, x, y, extra = '') => { e.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)${extra}`; };

  return {
    root,
    hit({ headshot, kill }) {
      // a kill marker is never downgraded by a later pellet / splash hit in the same instant
      if (S.kill && S.hitT < 0.12 && !kill) return;
      S.hitT = 0; S.head = !!headshot; S.kill = !!kill; S.hitDur = kill ? 0.36 : headshot ? 0.2 : 0.16;
      if (headshot) score.headshot(kill); // skull on a headshot kill (scorehud.js)
    },
    stagger(e) { S.stagT = 0; S.stagBreak = !!(e && (e.armorBreak || e.armourBreak || e.break)); },
    scoreKill(info) { score.kill(info); },
    died() { score.died(); },
    damage(from, amount) {
      S.hurt = Math.min(0.6, S.hurt + 0.15 + amount / 120);
      if (!from) return;
      // a hit from (roughly) the same direction refreshes that arc; otherwise take the oldest of the three
      const ang = srcAngle(from), life = ARC_IN + ARC_HOLD + ARC_OUT;
      let a = null;
      for (const k of arcs) if (k.age < life && Math.abs(Math.atan2(Math.sin(srcAngle(k.from) - ang), Math.cos(srcAngle(k.from) - ang))) < 0.5) a = k;
      if (a) a.age = Math.min(a.age, ARC_IN); else { a = arcs[0]; for (const k of arcs) if (k.age > a.age) a = k; a.age = 0; }
      a.from = from.clone ? from.clone() : { x: from.x, z: from.z }; a.amount = amount;
    },
    // st: { w (def), idx, mag, reserve, mode, spreadPx, ads, adsScope, reload (0..1|-1), sprint, shotPop, grenades, grenCharge, hidden }
    update(st, dt) {
      const p = ctx.player, w = st.w;
      // ---- crosshair ---------------------------------------------------------
      S.gap += (st.spreadPx - S.gap) * (1 - Math.exp(-40 * dt));
      const isShot = w.pellets > 1, isLaunch = w.id === 'launcher';
      const gap = Math.max(isShot ? 10 : 5, S.gap) + (isShot ? 0 : 4);
      const chAlpha = st.hidden ? 0 : Math.max(0, 1 - st.ads * 3.2) * (1 - 0.75 * st.sprint);
      cross.style.opacity = chAlpha.toFixed(2);
      const len = isShot ? 6 : w.id === 'sniper' ? 7 : 9;
      const off = gap + len / 2;
      tx(lines[0], 0, -off); tx(lines[1], off, 0); tx(lines[2], 0, off); tx(lines[3], -off, 0);
      lines[0].style.display = isLaunch ? 'none' : '';
      ring.style.display = isShot ? '' : 'none';
      if (isShot) { const d = gap * 2; ring.style.width = ring.style.height = `${d.toFixed(1)}px`; ring.style.margin = `${(-gap).toFixed(1)}px 0 0 ${(-gap).toFixed(1)}px`; ring.style.opacity = '.55'; }
      // ---- hitmarker ---------------------------------------------------------
      S.hitT += dt; S.killT += dt;
      if (S.hitT < S.hitDur) {
        // appears at full strength on the frame of the hit; holds, then fades over the last 45%
        const f = S.hitT / S.hitDur, fade = f < 0.55 ? 1 : 1 - (f - 0.55) / 0.45;
        hit.style.opacity = fade.toFixed(2); S.hitOn = true;
        const snap = 1 - Math.pow(1 - Math.min(1, S.hitT / (S.kill ? 0.11 : 0.06)), 3);
        const r = S.kill ? 9 + snap * 5 : 8 + snap * 2.5, r2 = r + 4 + snap * 6;
        const col = S.head ? '#ff3b30' : '#fff';
        if (col !== S.hitCol) { S.hitCol = col; for (let i = 0; i < 8; i++) ticks[i].style.background = col; }
        if (S.kill !== S.hitKill) { S.hitKill = S.kill; for (let i = 4; i < 8; i++) ticks[i].style.display = S.kill ? '' : 'none'; }
        const sc = S.kill ? ' scale(1,1.2)' : '';
        for (let i = 0; i < (S.kill ? 8 : 4); i++) {
          const rr = i < 4 ? r : r2;
          ticks[i].style.transform = `translate(${(TS[i] * rr).toFixed(1)}px,${(-TC[i] * rr).toFixed(1)}px) rotate(${TA[i].toFixed(3)}rad)${i < 4 ? sc : ' scale(.75,.6)'}`;
        }
      } else if (S.hitOn) { S.hitOn = false; hit.style.opacity = '0'; }
      // armour break / stagger: one thin ring that opens around the marker
      S.stagT += dt;
      if (S.stagT < 0.26) {
        const f = S.stagT / 0.26, d = (S.stagBreak ? 26 : 22) + (1 - Math.pow(1 - f, 3)) * 12;
        hring.style.width = hring.style.height = `${d.toFixed(1)}px`; hring.style.margin = `${(-d / 2).toFixed(1)}px 0 0 ${(-d / 2).toFixed(1)}px`;
        hring.style.opacity = ((1 - f * f) * (st.hidden ? 0 : 0.9)).toFixed(2); hring.style.borderColor = S.stagBreak ? '#ffd23a' : '#8fe6ff'; S.stagOn = true;
      } else if (S.stagOn) { S.stagOn = false; hring.style.opacity = '0'; }
      score.update(dt, st.comboLeft || 0);
      // ---- reload bar / hints -------------------------------------------------
      rl.style.opacity = st.reload >= 0 ? '1' : '0';
      if (st.reload >= 0) rlFill.style.transform = `scaleX(${st.reload.toFixed(3)})`;
      let hintTxt = '', hintCls = '';
      if (st.reload >= 0) hintTxt = 'RELOADING';
      else if (st.mag === 0 && st.reserve === 0) { hintTxt = 'NO AMMO'; hintCls = 'wp-bad'; }
      else if (st.mag === 0) { hintTxt = 'RELOAD  [R]'; hintCls = 'wp-bad'; }
      else if (w.mag > 2 && st.mag <= Math.max(1, Math.floor(w.mag * 0.25)) && st.reserve > 0) { hintTxt = 'LOW AMMO'; hintCls = 'wp-warn'; }
      if (hintTxt !== hint.textContent) hint.textContent = hintTxt;
      hint.className = hintCls;
      hint.style.opacity = hintTxt && !(st.ads > 0.5) ? (hintCls === 'wp-bad' ? 0.65 + 0.35 * Math.sin(ctx.time * 9) : 0.85).toFixed(2) : '0';
      // ---- scope: everything outside the eyepiece is out of focus and dark ------------------------
      const sp = st.scopePx;
      scope.style.opacity = sp ? sp.a.toFixed(2) : '0';
      if (sp) {
        const cx = `calc(50% + ${sp.x.toFixed(1)}px)`, cy = `calc(50% + ${sp.y.toFixed(1)}px)`, r = sp.r;
        const g = `radial-gradient(circle at ${cx} ${cy},transparent ${(r * 0.97).toFixed(1)}px,#000 ${(r * 1.0).toFixed(1)}px)`;
        scope.style.webkitMaskImage = g; scope.style.maskImage = g;
        scope.style.background = `radial-gradient(circle at ${cx} ${cy},rgba(0,0,0,.78) ${r.toFixed(1)}px,rgba(0,0,0,.95) ${(r * 1.7).toFixed(1)}px)`;
      }
      // ---- ammo ---------------------------------------------------------------
      if (st.idx !== S.lastIdx) {
        S.lastIdx = st.idx; root.style.setProperty('--wp-accent', w.accent);
        nameEl.textContent = w.name; tagEl.textContent = w.tag;
        slotEls.forEach((d, i) => d.classList.toggle('wp-cur', i === st.idx));
        S.lastMag = -1;
      }
      // fitted attachments: one short chip each (muzzle, optic, magazine, grip, stock order)
      if (st.att !== S.lastAtt) { S.lastAtt = st.att; attEl.innerHTML = st.att ? st.att.split('  ').map((t) => `<span>${t}</span>`).join('') : ''; }
      if (st.mag !== S.lastMag) { if (S.lastMag >= 0) S.magPop = 1; S.lastMag = st.mag; magEl.textContent = st.mag; }
      if (st.reserve !== S.lastRes) { S.lastRes = st.reserve; resEl.textContent = st.reserve; }
      S.magPop = Math.max(0, S.magPop - dt * 9);
      magEl.style.transform = `scale(${(1 + S.magPop * 0.13).toFixed(3)})`;
      barEl.style.transform = `scaleX(${Math.min(1, st.mag / w.mag).toFixed(3)})`;
      const low = w.mag > 2 && st.mag <= Math.max(1, Math.floor(w.mag * 0.25));
      ammo.className = 'wp-panel' + (st.mag === 0 ? ' wp-empty' : low ? ' wp-low' : '');
      if (st.mode !== S.lastMode) { S.lastMode = st.mode; modeEl.textContent = st.mode.toUpperCase() + (w.modes.length > 1 ? '  [B]' : ''); }
      for (let i = 0; i < st.inv.length; i++) {
        const v = st.inv[i], dry = v.mag + v.reserve === 0, lock = !!v.locked;
        if (S.dry[i] !== dry) { S.dry[i] = dry; slotEls[i].classList.toggle('wp-dry', dry); }
        if (S.lock[i] !== lock) { S.lock[i] = lock; slotEls[i].hidden = lock; }
      }
      while (grenPips.length < st.grenMax) { const i = el('i', null, grenEl); grenPips.push({ i, u: el('u', null, i) }); }
      for (let k = 0; k < grenPips.length; k++) {
        const g = grenPips[k], cls = k < st.grenades ? 'wp-on' : '', hh = k === st.grenades ? `${(st.grenCharge * 100).toFixed(0)}%` : '0';
        if (g.c !== cls) { g.c = cls; g.i.className = cls; }
        if (g.h !== hh) { g.h = hh; g.u.style.height = hh; }
      }
      // ---- health -------------------------------------------------------------
      const hp = Math.max(0, p.hp), f = Math.min(1, hp / p.maxHp);
      const hpInt = Math.ceil(hp);
      if (hpInt !== S.lastHp) { S.lastHp = hpInt; hpn.textContent = hpInt; }
      if (S.ghost < f) S.ghost = f; else S.ghost = Math.max(f, S.ghost - dt * (S.hurt > 0.3 ? 0.08 : 0.6));
      hpFill.style.transform = `scaleX(${f.toFixed(3)})`; hpGhost.style.transform = `scaleX(${S.ghost.toFixed(3)})`;
      health.className = 'wp-panel' + (f < 0.35 ? ' wp-low' : '');
      // ---- damage feedback ------------------------------------------------------
      S.hurt = Math.max(0, S.hurt - dt * 1.6);
      const lowPulse = f < 0.35 ? (0.35 - f) * 1.6 * (0.7 + 0.3 * Math.sin(ctx.time * 6)) : 0;
      vig.style.opacity = Math.min(1, S.hurt + lowPulse).toFixed(2);
      const life = ARC_IN + ARC_HOLD + ARC_OUT;
      for (const a of arcs) {
        if (a.age >= life) { if (a.el.style.opacity !== '0') a.el.style.opacity = '0'; continue; }
        a.age += dt;
        const o = a.age < ARC_IN ? a.age / ARC_IN : a.age < ARC_IN + ARC_HOLD ? 1 : Math.max(0, 1 - (a.age - ARC_IN - ARC_HOLD) / ARC_OUT);
        a.el.style.opacity = o.toFixed(2);
        a.el.style.transform = `rotate(${srcAngle(a.from).toFixed(3)}rad)`;
      }
    },
  };
}
