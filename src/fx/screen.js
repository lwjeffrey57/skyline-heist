// Screen-space feedback: camera shake / weapon kick (applied as an offset AFTER player.update rewrote the
// camera), damage vignette + direction arc, low-health pulse, explosion flash / blur, death fade.
// Suppression (rounds cracking past / landing beside you): the edges of the view darken and close in briefly.
// All DOM lives under ctx.hud with ids prefixed `fx-`; styles are only touched when a value changes.

export function createScreen(ctx) {
  const mk = (id, css) => { const d = document.createElement('div'); d.id = id; d.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0;' + css; ctx.hud.appendChild(d); return d; };
  const elVig = mk('fx-vignette', 'background:radial-gradient(ellipse at center, rgba(120,0,0,0) 38%, rgba(150,8,4,.5) 72%, rgba(120,0,0,.92) 100%);');
  const elSup = mk('fx-suppress', 'background:radial-gradient(ellipse at center, rgba(0,0,0,0) 46%, rgba(6,8,12,.5) 80%, rgba(0,0,0,.9) 100%);');
  const elFlash = mk('fx-flash', 'background:radial-gradient(ellipse at center, rgba(255,246,225,.95) 0%, rgba(255,214,150,.85) 55%, rgba(255,170,90,.7) 100%);mix-blend-mode:screen;');
  const elBlur = mk('fx-blur', 'opacity:1;display:none;');
  const elFade = mk('fx-fade', 'background:radial-gradient(ellipse at center, rgba(30,4,4,.82) 0%, rgba(6,0,0,.97) 100%);');
  const elDir = mk('fx-dmgdir', 'inset:auto;left:50%;top:50%;width:0;height:0;');
  const arc = document.createElement('div');
  arc.style.cssText = 'position:absolute;left:-32vmin;top:-32vmin;width:64vmin;height:64vmin;box-sizing:border-box;border-radius:50%;border:1.1vmin solid transparent;border-top-color:rgba(255,72,48,.95);filter:drop-shadow(0 0 8px rgba(255,60,30,.9));clip-path:polygon(30% 0,70% 0,50% 50%);';
  elDir.appendChild(arc);

  const S = {
    trauma: 0, kp: 0, kpv: 0, ky: 0, kyv: 0, kr: 0, krv: 0, t: 0,
    hurt: 0, flash: 0, blur: 0, fade: 0, dirA: 0, dirX: 0, dirZ: 0, sup: 0, oSup: -1,
    oVig: -1, oFlash: -1, oBlur: -1, oFade: -1, oDir: -1, oDirRot: 1e9,
  };
  const q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 50) / 50;

  const api = {
    state: S,
    addTrauma(x, cap = 1) { if (S.trauma < cap) S.trauma = Math.min(cap, S.trauma + x); },
    // impulse in radians: pitch up, random yaw/roll. Critically damped, gone in ~90 ms.
    kick(pitch, yaw, roll) { S.kpv += pitch * 60; S.kyv += yaw * 60; S.krv += roll * 60; },
    damage(amount, from) {
      S.hurt = Math.min(1, S.hurt + 0.3 + amount / 45);
      if (from && from.isVector3) { S.dirA = 1; S.dirX = from.x; S.dirZ = from.z; }
      api.kick((Math.random() - 0.5) * 0.012, (Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.03);
      api.addTrauma(0.12 + amount / 160, 0.5);
    },
    // k 0..1: how close the round was. Builds with sustained fire, capped well short of blacking the edges out.
    suppress(k) {
      S.sup = Math.min(0.8, S.sup + 0.2 + 0.3 * k);
      api.addTrauma(0.03 + 0.05 * k, 0.22);
      api.kick((Math.random() - 0.5) * 0.004 * k, (Math.random() - 0.5) * 0.006 * k, (Math.random() - 0.5) * 0.008 * k);
    },
    flash(a) { S.flash = Math.max(S.flash, a); },
    blur(a) { S.blur = Math.max(S.blur, a); },
    died() { S.fade = 1; S.hurt = 1; },
    respawned() { S.hurt = 0; S.dirA = 0; S.trauma = 0; S.sup = 0; },
    update(dt) {
      const cam = ctx.camera, p = ctx.player;
      S.t += dt;
      // --- shake
      if (S.trauma > 0) {
        const s = S.trauma * S.trauma, t = S.t;
        cam.rotation.x += s * 0.03 * (Math.sin(t * 43.1) + Math.sin(t * 71.7 + 1.3)) * 0.5;
        cam.rotation.y += s * 0.03 * (Math.sin(t * 37.3 + 2.1) + Math.sin(t * 83.9 + 0.4)) * 0.5;
        cam.rotation.z += s * 0.045 * (Math.sin(t * 29.7 + 4.2) + Math.sin(t * 61.3 + 3.1)) * 0.5;
        cam.position.x += s * 0.05 * Math.sin(t * 51.3 + 0.7);
        cam.position.y += s * 0.05 * Math.sin(t * 47.9 + 5.1);
        S.trauma = Math.max(0, S.trauma - dt * (1.1 + S.trauma * 1.4));
      }
      // --- kick springs (stiff, critically damped)
      const K = 1600, D = 80;
      S.kpv += (-K * S.kp - D * S.kpv) * dt; S.kp += S.kpv * dt;
      S.kyv += (-K * S.ky - D * S.kyv) * dt; S.ky += S.kyv * dt;
      S.krv += (-K * S.kr - D * S.krv) * dt; S.kr += S.krv * dt;
      cam.rotation.x += S.kp; cam.rotation.y += S.ky; cam.rotation.z += S.kr;

      // --- overlays
      S.hurt = Math.max(0, S.hurt - dt * 1.3);
      let vig = S.hurt * 0.85;
      if (p && p.alive && p.hp < p.maxHp * 0.35) {
        const low = 1 - p.hp / (p.maxHp * 0.35), ph = (S.t * (1.15 + low * 0.7)) % 1;
        const beat = Math.exp(-ph * 9) + 0.6 * Math.exp(-Math.abs(ph - 0.28) * 14);
        vig = Math.max(vig, 0.22 + low * 0.3 + beat * 0.25);
      }
      const v = q(vig);
      if (v !== S.oVig) { S.oVig = v; elVig.style.opacity = v; }
      S.sup = Math.max(0, S.sup - dt * (0.9 + S.sup * 1.6)); // ~0.6 s from a single near miss
      const su = q(S.sup);
      if (su !== S.oSup) { S.oSup = su; elSup.style.opacity = su; }
      S.flash = Math.max(0, S.flash - dt * (1.6 + S.flash * 3));
      const f = q(S.flash);
      if (f !== S.oFlash) { S.oFlash = f; elFlash.style.opacity = f; }
      S.blur = Math.max(0, S.blur - dt * 1.4);
      const b = Math.round(S.blur * 10);
      if (b !== S.oBlur) {
        S.oBlur = b;
        if (b <= 0) elBlur.style.display = 'none';
        else { elBlur.style.display = 'block'; elBlur.style.backdropFilter = elBlur.style.webkitBackdropFilter = `blur(${b}px) saturate(${100 - b * 4}%)`; }
      }
      S.fade = Math.max(0, S.fade - dt * 1.1);
      const fd = q(S.fade);
      if (fd !== S.oFade) { S.oFade = fd; elFade.style.opacity = fd; }
      S.dirA = Math.max(0, S.dirA - dt * 0.9);
      const da = q(S.dirA * 1.5);
      if (da !== S.oDir) { S.oDir = da; elDir.style.opacity = da; }
      if (da > 0 && p) {
        const rot = Math.round((Math.atan2(S.dirX - p.pos.x, -(S.dirZ - p.pos.z)) + p.yaw) * 57.29578);
        if (rot !== S.oDirRot) { S.oDirRot = rot; elDir.style.transform = `rotate(${rot}deg)`; }
      }
    },
  };
  return api;
}
