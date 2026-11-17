// Arcade feedback layer of the weapon HUD: headshot hitmarker, headshot-kill skull, score popups, running
// total, kill feed, multi-kill callouts, streak + combo timer. Everything is animated from update(dt)
// (no CSS animations) so it stays in step with the simulation. All art is original inline SVG.

const CSS = `
#wp-hsm,#wp-skull{position:absolute;left:50%;top:50%;width:0;height:0}
#wp-hsm svg{position:absolute;left:-60px;top:-60px;width:120px;height:120px;overflow:visible}
#wp-hsm .wp-flash{position:absolute;left:-34px;top:-34px;width:68px;height:68px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.95) 0,rgba(255,225,130,.55) 28%,rgba(255,190,60,0) 70%)}
#wp-skull{top:calc(50% - 104px)}
#wp-skull svg{position:absolute;left:-34px;top:-34px;width:68px;height:68px;overflow:visible}
#wp-skull .wp-burst{position:absolute;border-radius:50%;border:2px solid #ffd23a;box-shadow:0 0 14px rgba(255,190,50,.9),inset 0 0 10px rgba(255,190,50,.5)}
#wp-skull .wp-rays{position:absolute;left:-70px;top:-70px;width:140px;height:140px;background:conic-gradient(from 0deg,rgba(255,210,58,.0) 0 8deg,rgba(255,210,58,.75) 8deg 12deg,rgba(255,210,58,0) 12deg 53deg,rgba(255,210,58,.75) 53deg 57deg,rgba(255,210,58,0) 57deg 98deg,rgba(255,210,58,.75) 98deg 102deg,rgba(255,210,58,0) 102deg 143deg,rgba(255,210,58,.75) 143deg 147deg,rgba(255,210,58,0) 147deg 188deg,rgba(255,210,58,.75) 188deg 192deg,rgba(255,210,58,0) 192deg 233deg,rgba(255,210,58,.75) 233deg 237deg,rgba(255,210,58,0) 237deg 278deg,rgba(255,210,58,.75) 278deg 282deg,rgba(255,210,58,0) 282deg 323deg,rgba(255,210,58,.75) 323deg 327deg,rgba(255,210,58,0) 327deg 360deg);-webkit-mask:radial-gradient(circle,transparent 0 44%,#000 50%,transparent 70%);mask:radial-gradient(circle,transparent 0 44%,#000 50%,transparent 70%)}
#wp-score{position:absolute;left:24px;top:16px;text-shadow:0 1px 3px rgba(0,0,0,.8)}
#wp-score .wp-sl{font-size:10px;letter-spacing:3px;opacity:.7}
#wp-score .wp-sn{font-size:32px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:1px;display:inline-block;transform-origin:0 60%}
#wp-score .wp-cb{width:168px;height:3px;margin-top:5px;background:rgba(8,12,16,.55);transform:skewX(-20deg);overflow:hidden;opacity:0}
#wp-score .wp-cb div{height:100%;background:#ffd23a;transform-origin:0 50%;box-shadow:0 0 8px #ffd23a}
#wp-score .wp-st{margin-top:5px;font-size:11px;font-weight:700;letter-spacing:2.5px;opacity:0;white-space:nowrap}
#wp-score .wp-st b{color:#ffd23a;font-size:14px}
#wp-score .wp-st i{font-style:normal;margin-left:8px;padding:1px 6px;background:rgba(255,210,58,.16);border-left:2px solid #ffd23a;color:#ffe9a0}
#wp-pops{position:absolute;left:calc(50% + 82px);top:calc(50% - 6px);width:0;height:0}
#wp-pops div{position:absolute;left:0;top:0;white-space:nowrap;font-size:13px;font-weight:700;letter-spacing:2.5px;text-shadow:0 0 8px rgba(0,0,0,.9),0 1px 2px #000;transform-origin:0 50%;opacity:0}
#wp-pops div b{font-size:17px;letter-spacing:.5px;margin-right:8px;font-variant-numeric:tabular-nums}
#wp-pops .wp-gold{color:#ffd23a}#wp-pops .wp-hot{color:#ff8a4a}#wp-pops .wp-cyan{color:#7ff3ea}
#wp-call{position:absolute;left:50%;top:calc(50% - 196px);font-size:25px;font-weight:700;letter-spacing:9px;white-space:nowrap;color:#fff;opacity:0;text-shadow:0 0 18px rgba(255,170,40,.95),0 0 4px rgba(255,210,58,.9),0 2px 3px #000}
#wp-call small{display:block;text-align:center;font-size:11px;letter-spacing:5px;color:#ffd23a;margin-top:2px}
#wp-feed{position:absolute;right:28px;top:64px;width:0;height:0}
#wp-feed div{position:absolute;right:0;top:0;white-space:nowrap;display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:2px;padding:4px 9px 4px 10px;background:linear-gradient(90deg,rgba(8,12,16,0),rgba(8,12,16,.62) 22%);border-right:2px solid #fff;text-shadow:0 1px 2px #000;opacity:0}
#wp-feed div.wp-fh{border-right-color:#ffd23a}
#wp-feed b{font-weight:700}#wp-feed u{text-decoration:none;opacity:.75}#wp-feed i{font-style:normal;font-weight:700;color:#ffd23a;font-variant-numeric:tabular-nums}
#wp-feed svg{width:13px;height:13px;flex:none}
`;

// Original skull mark: a faceted cranium with a diamond brow notch, slanted sockets and a four-tooth jaw.
const SKULL_PATH = 'M32 5 L45 8 L54 17 L57 29 L54 39 L48 45 L48 53 L44 58 L20 58 L16 53 L16 45 L10 39 L7 29 L10 17 L19 8 Z '
  + 'M14 28 L27 25 L28.5 35 L19 39 Z M50 28 L37 25 L35.5 35 L45 39 Z M32 37 L28 46 L36 46 Z M32 11 L35 16 L32 21 L29 16 Z '
  + 'M23.5 50 h2.4 v8 h-2.4 Z M30.8 50 h2.4 v8 h-2.4 Z M38.1 50 h2.4 v8 h-2.4 Z';
export const skullSvg = (fill = '#fff', stroke = 'rgba(0,0,0,.75)', sw = 2.2) =>
  `<svg viewBox="0 0 64 64"><path d="${SKULL_PATH}" fill="${stroke}" stroke="${stroke}" stroke-width="${sw * 2}" stroke-linejoin="round" fill-rule="evenodd"/><path d="${SKULL_PATH}" fill="${fill}" fill-rule="evenodd"/></svg>`;

// headshot marker: four tapered blades pointing at the aim point + a broken diamond frame
const BLADE = 'M7 -7 L22 -17 L25 -25 L17 -22 Z';
const blades = (fill, stroke, sw) => [0, 90, 180, 270].map((a) => `<path d="${BLADE}" transform="rotate(${a})" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`).join('');
const bladesSvg = (fill, stroke = 'none', sw = 0) => `<svg viewBox="-60 -60 120 120">${blades(fill, stroke, sw)}</svg>`;
const FRAME_SVG = '<svg viewBox="-60 -60 120 120"><g fill="none" stroke-linecap="butt">'
  + '<path d="M0 -34 L34 0 L0 34 L-34 0 Z" stroke="rgba(0,0,0,.5)" stroke-width="4.5" stroke-dasharray="26 22.1" stroke-dashoffset="13"/>'
  + '<path d="M0 -34 L34 0 L0 34 L-34 0 Z" stroke="#ffd23a" stroke-width="2.2" stroke-dasharray="26 22.1" stroke-dashoffset="13"/></g></svg>';

const el = (tag, id, parent, cls) => { const e = document.createElement(tag); if (id) e.id = id; if (cls) e.className = cls; parent.appendChild(e); return e; };
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const outBack = (x) => { const c = 2.2; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };

export function createScoreHud(ctx, root, SCORE) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

  // ---- headshot marker -------------------------------------------------------------------------------
  const hsm = el('div', 'wp-hsm', root);
  const flash = el('div', null, hsm, 'wp-flash');
  const frame = el('div', null, hsm); frame.innerHTML = FRAME_SVG;
  const trailA = el('div', null, hsm); trailA.innerHTML = bladesSvg('#ff3b5c'); trailA.style.mixBlendMode = 'screen';
  const trailB = el('div', null, hsm); trailB.innerHTML = bladesSvg('#3bd6ff'); trailB.style.mixBlendMode = 'screen';
  const main = el('div', null, hsm); main.innerHTML = `<svg viewBox="-60 -60 120 120">${blades('rgba(0,0,0,.6)', 'rgba(0,0,0,.6)', 4)}<g class="wp-bl">${blades('#ffd23a', 'none', 0)}</g></svg>`;
  const mainFill = [...main.querySelectorAll('.wp-bl path')];
  hsm.style.opacity = '0';
  const H = { t: 9, kill: false };

  // ---- skull --------------------------------------------------------------------------------------------
  const skull = el('div', 'wp-skull', root);
  const rays = el('div', null, skull, 'wp-rays');
  const burst = el('div', null, skull, 'wp-burst');
  const skullImg = el('div', null, skull); skullImg.innerHTML = skullSvg('#fff7df');
  skull.style.opacity = '0';
  const K = { t: 9 };

  // ---- score panel ----------------------------------------------------------------------------------------
  const panel = el('div', 'wp-score', root);
  panel.innerHTML = '<div class="wp-sl">SCORE</div><div class="wp-sn">0</div><div class="wp-cb"><div></div></div><div class="wp-st"></div>';
  const numEl = panel.querySelector('.wp-sn'), comboEl = panel.querySelector('.wp-cb'), comboFill = comboEl.firstChild, streakEl = panel.querySelector('.wp-st');
  const pops = el('div', 'wp-pops', root), popList = [];
  const call = el('div', 'wp-call', root); const C = { t: 9, dur: 1.4 };
  const feed = el('div', 'wp-feed', root), feedList = [];
  const P = { shown: 0, total: 0, pop: 0, combo: 0, streak: 0, mult: 1, lastStreak: '' };

  const fmt = (n) => Math.round(n).toLocaleString('en-US');

  return {
    // a headshot landed (kill or not)
    headshot(kill) { if (kill) K.t = 0; }, // (the hit marker itself is the minimal tick marker in hud.js)
    // info: { parts:[{ points, label, cls }], total, streak, mult, multi, multiName, weaponName, targetName, headshot, points }
    kill(info) {
      P.total = info.total; P.streak = info.streak; P.mult = info.mult; P.combo = 1;
      info.parts.forEach((p, i) => {
        const d = el('div', null, pops, p.cls || ''); d.innerHTML = `<b>+${p.points}</b>${p.label}`;
        popList.push({ d, t: -i * 0.07, points: p.points, counted: false });
      });
      while (popList.length > 7) { const o = popList.shift(); if (!o.counted) P.shown += o.points; o.d.remove(); }
      if (info.multiName) { call.textContent = info.multiName; C.t = 0; }
      const row = el('div', null, feed, info.headshot ? 'wp-fh' : '');
      row.innerHTML = `<b>${info.weaponName}</b>${info.headshot ? skullSvg('#ffd23a', 'rgba(0,0,0,.6)', 2) : '<u>▸</u>'}<u>${info.targetName}</u><i>+${info.points}</i>`;
      feedList.unshift({ d: row, t: 0, y: -26 });
      while (feedList.length > 5) feedList.pop().d.remove();
    },
    died() { P.streak = 0; P.mult = 1; P.combo = 0; },
    update(dt, comboLeft) {
      // ---- headshot marker: slam in with overshoot, white -> gold, chromatic ghosts, spinning frame, clean exit
      H.t += dt;
      const D = H.kill ? 0.5 : 0.36;
      if (H.t < D) {
        const t = H.t, base = H.kill ? 1.25 : 1;
        const sIn = t < 0.05 ? lerp(2.3, 0.86, t / 0.05) : t < 0.11 ? lerp(0.86, 1.06, (t - 0.05) / 0.06) : lerp(1.06, 1, seg(t, 0.11, 0.16));
        const out = seg(t, D - 0.12, D);
        const s = base * sIn * (1 + out * 0.35);
        hsm.style.opacity = (1 - out * out).toFixed(2);
        const twist = (1 - seg(t, 0, 0.11)) * -32;
        main.style.transform = `rotate(${twist.toFixed(1)}deg) scale(${s.toFixed(3)})`;
        const white = 1 - seg(t, 0.03, 0.12);
        const col = white > 0.5 ? '#ffffff' : H.kill ? '#ffb326' : '#ffd23a';
        if (main._c !== col) { main._c = col; mainFill.forEach((p) => p.setAttribute('fill', col)); }
        main.style.filter = `drop-shadow(0 0 ${(4 + white * 10).toFixed(0)}px ${white > 0.5 ? '#fff' : 'rgba(255,190,50,.95)'})`;
        const ghost = 1 - seg(t, 0.0, 0.17);
        trailA.style.opacity = trailB.style.opacity = (ghost * 0.75).toFixed(2);
        trailA.style.transform = `translate(${(-5 * ghost).toFixed(1)}px,${(2 * ghost).toFixed(1)}px) rotate(${(twist * 1.6).toFixed(1)}deg) scale(${(s * (1 + 0.5 * ghost)).toFixed(3)})`;
        trailB.style.transform = `translate(${(5 * ghost).toFixed(1)}px,${(-2 * ghost).toFixed(1)}px) rotate(${(twist * 2.2).toFixed(1)}deg) scale(${(s * (1 + 0.8 * ghost)).toFixed(3)})`;
        const f = t / D;
        frame.style.transform = `rotate(${(45 + f * (H.kill ? 150 : 110)).toFixed(1)}deg) scale(${(base * (0.55 + 1.05 * (1 - Math.pow(1 - f, 3)))).toFixed(3)})`;
        frame.style.opacity = Math.pow(1 - f, 1.5).toFixed(2);
        flash.style.opacity = (1 - seg(t, 0, 0.1)).toFixed(2);
        flash.style.transform = `scale(${(base * (0.7 + seg(t, 0, 0.1) * 0.9)).toFixed(2)})`;
      } else if (hsm.style.opacity !== '0') hsm.style.opacity = '0';

      // ---- skull: slam in above the crosshair, hold, then fly into the score
      K.t += dt;
      if (K.t < 1.05) {
        const t = K.t;
        const sIn = t < 0.16 ? lerp(2.6, 1, outBack(t / 0.16)) : 1 + 0.03 * Math.sin((t - 0.16) * 18) * (1 - seg(t, 0.16, 0.5));
        const fly = seg(t, 0.7, 1.05), fe = fly * fly * (3 - 2 * fly);
        const dx = -(window.innerWidth / 2 - 100) * fe, dy = (-(window.innerHeight / 2 - 36) + 104) * fe;
        skull.style.opacity = (Math.min(1, t / 0.03) * (1 - Math.pow(fly, 3))).toFixed(2);
        skull.style.transform = `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
        skullImg.style.transform = `scale(${(sIn * (1 - 0.72 * fe)).toFixed(3)}) rotate(${((1 - seg(t, 0, 0.16)) * -14).toFixed(1)}deg)`;
        skullImg.style.filter = `drop-shadow(0 0 ${(6 + 16 * (1 - seg(t, 0, 0.3))).toFixed(0)}px rgba(255,180,40,.95)) drop-shadow(0 2px 2px rgba(0,0,0,.7))`;
        const b = seg(t, 0.02, 0.4), br = 20 + b * 46;
        burst.style.width = burst.style.height = `${(br * 2).toFixed(0)}px`; burst.style.left = burst.style.top = `${(-br).toFixed(0)}px`;
        burst.style.opacity = ((1 - b) * (1 - fly)).toFixed(2);
        rays.style.opacity = ((1 - seg(t, 0.05, 0.45)) * 0.9).toFixed(2);
        rays.style.transform = `rotate(${(t * 60).toFixed(1)}deg) scale(${(0.6 + seg(t, 0, 0.3) * 0.75).toFixed(2)})`;
      } else if (skull.style.opacity !== '0') skull.style.opacity = '0';

      // ---- score popups: stack beside the crosshair, then feed the total
      let slot = 0;
      for (let i = 0; i < popList.length; i++) {
        const p = popList[i]; p.t += dt;
        if (p.t < 0) continue;
        const life = 1.25, t = p.t;
        if (t > life) { if (!p.counted) { p.counted = true; P.shown += p.points; P.pop = 1; } p.d.remove(); popList.splice(i--, 1); continue; }
        const inn = outBack(clamp01(t / 0.13)), outp = seg(t, life - 0.28, life);
        p.y = p.y === undefined ? slot * 21 : lerp(p.y, slot * 21, 1 - Math.exp(-18 * dt));
        p.d.style.opacity = (Math.min(1, t / 0.05) * (1 - outp)).toFixed(2);
        p.d.style.transform = `translate(${((1 - inn) * 26 - outp * 40).toFixed(1)}px,${(p.y - outp * 30).toFixed(1)}px) scale(${(0.7 + 0.3 * inn).toFixed(3)})`;
        slot++;
      }
      // total counts up
      const target = P.total - popList.reduce((a, p) => a + (p.counted ? 0 : p.points), 0);
      if (P.shown < target) P.shown = target; // (popups dropped early)
      P.disp = P.disp === undefined ? P.shown : P.disp + (P.shown - P.disp) * (1 - Math.exp(-14 * dt));
      if (Math.abs(P.shown - P.disp) < 0.6) P.disp = P.shown;
      const txt = fmt(P.disp); if (txt !== numEl.textContent) numEl.textContent = txt;
      P.pop = Math.max(0, P.pop - dt * 6);
      numEl.style.transform = `scale(${(1 + P.pop * 0.16).toFixed(3)})`;
      numEl.style.color = P.pop > 0.05 ? '#ffe9a0' : '#fff';
      // combo timer + streak
      const cl = clamp01(comboLeft);
      comboEl.style.opacity = cl > 0 ? '1' : '0';
      comboFill.style.transform = `scaleX(${cl.toFixed(3)})`;
      const st = P.streak >= 2 ? `STREAK <b>${P.streak}</b>${P.mult > 1 ? `<i>x${P.mult.toFixed(1)}</i>` : ''}` : '';
      if (st !== P.lastStreak) { P.lastStreak = st; streakEl.innerHTML = st; }
      streakEl.style.opacity = st ? '1' : '0';
      // multi-kill callout
      C.t += dt;
      if (C.t < C.dur) {
        const t = C.t, s = t < 0.14 ? lerp(2.1, 1, outBack(t / 0.14)) : 1, o = seg(t, C.dur - 0.3, C.dur);
        call.style.opacity = (Math.min(1, t / 0.04) * (1 - o)).toFixed(2);
        call.style.transform = `translateX(-50%) scale(${s.toFixed(3)})`;
        call.style.letterSpacing = `${(9 + t * 5).toFixed(1)}px`;
      } else if (call.style.opacity !== '0') call.style.opacity = '0';
      // kill feed
      for (let i = 0; i < feedList.length; i++) {
        const f = feedList[i]; f.t += dt;
        if (f.t > 5) { f.d.remove(); feedList.splice(i--, 1); continue; }
        f.y = lerp(f.y, i * 27, 1 - Math.exp(-16 * dt));
        const inn = 1 - Math.pow(1 - clamp01(f.t / 0.18), 3);
        f.d.style.opacity = (inn * (1 - seg(f.t, 4.4, 5))).toFixed(2);
        f.d.style.transform = `translate(${((1 - inn) * 60).toFixed(1)}px,${f.y.toFixed(1)}px)`;
      }
    },
  };
}
