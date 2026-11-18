// One look for the whole interface. Loaded last: it retires leftovers from earlier modes, gives every element the
// same type and panel treatment, fixes each element to its own zone, and adds the compass bar.
//   top-centre: compass, raid status, detection · top-left: contracts · top-right: kill feed
//   bottom-left: supplies above health · bottom-right: weapon

const FONT = '"Bahnschrift","DIN Alternate","Roboto Condensed","Arial Narrow",system-ui,sans-serif';
const W = 560, SPAN = Math.PI * 0.9; // compass width in px and the angle it covers

export function init(ctx) {
  const { player } = ctx;
  const style = document.createElement('style');
  style.textContent = `
    #hud-root, #hud-root *, #prompt, #overlay { font-family: ${FONT}; }
    /* retired: movement debug readout, arcade score total and point pop-ups, floating exit markers */
    #hud, #wp-score, #wp-pops, .rd-mark { display: none !important; }
    #fx-vignette { display: none !important; } /* the weapon HUD already tints the screen when you are hit */
    #fps { display: none; right: 16px; top: auto; bottom: 8px; }
    #fps.on { display: block; }

    /* top-centre stack */
    #ui-compass { position: fixed; top: 12px; left: 50%; width: ${W}px; height: 38px; margin-left: -${W / 2}px; overflow: hidden; pointer-events: none;
      -webkit-mask: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent); mask: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent); }
    #ui-compass .ticks { position: absolute; left: 0; right: 0; top: 0; height: 7px; background-image: repeating-linear-gradient(90deg, rgba(255,255,255,.8) 0 1px, transparent 1px 100%); }
    #ui-compass .mid { position: absolute; left: 50%; top: 0; width: 2px; height: 11px; margin-left: -1px; background: #ffc56b; }
    #ui-compass span { position: absolute; top: 10px; transform: translateX(-50%); font-size: 11px; letter-spacing: 2px; color: rgba(255,255,255,.7); text-shadow: 0 1px 3px rgba(0,0,0,.8); white-space: nowrap; }
    #ui-compass span.exit { color: #9be37a; font-weight: 700; }
    #ui-compass span.exit::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 5px; border: 2px solid var(--ex, #9be37a); transform: rotate(45deg) translateY(-1px); }
    #ui-compass span.edge { opacity: .55; }
    #rd-top { top: 46px; }
    #rd-top .mode { display: none; }
    #rd-top .line { font-size: 16px; letter-spacing: 1.5px; padding: 4px 14px; background: rgba(8,12,16,.42); display: inline-block; }
    #rd-top .sub { font-size: 10px; letter-spacing: 2.5px; }
    #dt-status { top: 96px; font-size: 10px; letter-spacing: 3.5px; }

    /* top-left: contracts */
    #rd-contracts { left: 24px; top: 16px; padding: 8px 12px 9px; background: rgba(8,12,16,.42); border-left: 2px solid #ffc56b; font-size: 12px; letter-spacing: 1.2px; }
    #rd-contracts .h { margin-bottom: 2px; }

    /* bottom-left: supplies above health */
    #wp-health { bottom: 28px !important; }
    #rd-kit { bottom: 92px; left: 24px; padding: 5px 10px 7px; background: rgba(8,12,16,.42); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; }
    #rd-kit .bar { width: 100%; height: 3px; }

    /* prompts, progress, pickups */
    #prompt { top: 60%; border-radius: 0; background: rgba(8,12,16,.6); border-left: 2px solid #ffc56b; font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase; }
    #rd-hold { top: 66%; font-size: 11px; letter-spacing: 3px; }
    #rd-toasts { top: 71%; font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase; }

    /* panels: stash, loadout, results, pack */
    #rd-panel .box, #dir-board .panel { min-width: 620px; max-width: 700px; padding: 0 26px 20px; background: rgba(8,11,15,.9); border: 0; border-top: 3px solid #ffc56b; box-shadow: 0 18px 60px rgba(0,0,0,.5); }
    #rd-panel h2 { margin: 0 -26px 8px; padding: 14px 26px 11px; font-size: 22px; letter-spacing: 6px; background: rgba(255,255,255,.04); }
    #rd-panel table { width: 100%; font-size: 14px; letter-spacing: .6px; }
    #rd-panel td { padding: 4px 8px; }
    #rd-panel td:first-child { width: 30px; }
    #rd-panel td br { display: none; } /* descriptions sit on the same line as the name */
    #rd-panel td br + span { margin-left: 10px; }
    #rd-panel kbd { display: inline-block; min-width: 20px; padding: 0 5px; text-align: center; border: 1px solid rgba(255,197,107,.55); font-size: 12px; }
    #rd-panel .go { margin-top: 14px; padding: 9px 12px; text-align: center; background: #ffc56b; color: #14100a; font-weight: 700; letter-spacing: 3px; }
    #overlay #card h1 { letter-spacing: 8px; }
    #overlay #go { border-radius: 0; letter-spacing: 3px; }`;
  document.head.appendChild(style);

  const compass = document.createElement('div'); compass.id = 'ui-compass';
  compass.innerHTML = '<div class="ticks"></div><div class="mid"></div>';
  ctx.hud.appendChild(compass);
  const ticks = compass.querySelector('.ticks');
  const pxPerRad = W / SPAN, tickEvery = (Math.PI / 12) * pxPerRad; // a tick every 15 degrees
  ticks.style.backgroundSize = `${tickEvery}px 100%`;
  const mk = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; compass.appendChild(s); return s; };
  const cards = [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]].map(([t, x, z]) => ({ el: mk('', t), x, z }));
  const exits = Array.from({ length: 8 }, () => mk('exit', ''));

  window.addEventListener('keydown', (e) => { if (e.code === 'F3') { e.preventDefault(); document.getElementById('fps').classList.toggle('on'); } });

  // angle of a world direction relative to where the player faces: 0 = ahead, + = to the right
  const rel = (dx, dz, sin, cos) => Math.atan2(dx * cos - dz * sin, -dx * sin - dz * cos);
  const place = (el, a, clampEdge, slot = 0) => {
    const half = SPAN / 2;
    // off the strip: pin to that end (each exit gets its own spot so two labels never sit on top of each other)
    if (Math.abs(a) > half) { if (!clampEdge) { el.hidden = true; return; } a = Math.sign(a) * half * (0.84 - slot * 0.3); el.classList.add('edge'); } else el.classList.remove('edge');
    el.hidden = false; el.style.left = `${W / 2 + a * pxPerRad}px`;
  };

  return {
    update() {
      const inRaid = ctx.raid ? ctx.raid.state === 'raid' : true;
      compass.hidden = !inRaid; if (!inRaid) return;
      const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
      ticks.style.backgroundPositionX = `${W / 2 + player.yaw * pxPerRad}px`;
      for (const c of cards) place(c.el, rel(c.x, c.z, sin, cos), false);
      const zones = (ctx.raid ? ctx.raid.zones.filter((z) => z.active) : []).concat(ctx.worldEvents ? ctx.worldEvents.marks : []);
      exits.forEach((el, i) => {
        const z = zones[i]; if (!z) { el.hidden = true; return; }
        const dx = z.x - player.pos.x, dz = z.z - player.pos.z;
        el.textContent = `${z.title || 'EXIT'} ${Math.round(Math.hypot(dx, dz))}m`; el.style.color = z.css || ''; el.style.setProperty('--ex', z.css || '#9be37a');
        el.style.top = `${10 + (i % 3) * 12}px`; // each exit on its own row so the labels can never collide
        place(el, rel(dx, dz, sin, cos), true, i);
      });
    },
  };
}
