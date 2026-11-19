import * as THREE from 'three';
import { createView } from './render.js';
import { createWorld } from './world.js';
import { Player } from './player.js';
import { createEvents, installCombat } from './core.js';
import * as destruction from './destruction.js';
import * as fx from './fx.js';
import * as audio from './audio.js';
import * as weapons from './weapons.js';
import * as bots from './bots.js';
import * as decor from './decor.js';
import * as detect from './detect.js';
import * as ui from './ui.js';
import * as dmgnum from './dmgnum.js';
import * as settings from './settings.js';
import * as map from './map.js';
import * as hudplus from './hudplus.js';
import * as dash from './dash.js';
import * as downed from './downed.js';
import * as drones from './drones.js';
import * as turrets from './turrets.js';
import * as heat from './heat.js';
import * as worldevents from './worldevents.js';
import * as raid from './raid.js'; // director.js (free-for-all deathmatch) is kept in the repo but not loaded

// Integration only: builds the shared ctx (see core.js) and runs every system each frame.

const view = createView();
const { renderer, scene, camera } = view;
const events = createEvents();
const world = createWorld(scene, renderer);

const input = { keys: new Set(), pressed: new Set(), down(c) { return this.keys.has(c); } };
const player = new Player(camera, world, input, events);

const ctx = {
  scene, camera, renderer, view, world, player, input, events,
  targets: [player], hud: document.getElementById('hud-root'), time: 0,
  destruction: { hit() {}, explode() {} },
};
installCombat(ctx);

// a zipline post that gets split into smaller pieces keeps its zipline until those pieces go
events.on('pieceSplit', ({ collider, parts }) => {
  if (!collider.zipline) return;
  for (const part of parts) part.zipline = collider.zipline;
});

events.on('pieceDestroyed', ({ collider }) => { if (collider.zipline) world.removeZipline(collider.zipline); });

const systems = [];
for (const [name, mod] of Object.entries({ destruction, decor, fx, audio, weapons, bots, raid, heat, worldevents, detect, ui, hudplus, dash, downed, dmgnum, settings, map, drones, turrets })) {
  try { const s = mod.init(ctx); if (s) systems.push({ name, ...s }); } catch (e) { console.error(`[${name}] init failed`, e); }
}

// ---- input ----------------------------------------------------------------
const overlay = document.getElementById('overlay');
let playing = false, dragLook = false;
const setPlaying = (v) => { playing = v; overlay.style.display = v ? 'none' : 'flex'; if (!v) input.keys.clear(); };

overlay.addEventListener('click', async () => {
  events.emit('userGesture', {}); // audio may start now
  try {
    await renderer.domElement.requestPointerLock();
    if (document.pointerLockElement !== renderer.domElement) throw new Error('no lock');
  } catch {
    dragLook = true; // pointer lock unavailable: hold the RIGHT mouse button to look
  }
  setPlaying(true);
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === renderer.domElement) { dragLook = false; setPlaying(true); }
  else if (!dragLook && !ctx.uiOpen) setPlaying(false); // an in-raid panel (the pack) frees the mouse without pausing
});
document.addEventListener('mousemove', (e) => {
  if (!playing || ctx.uiOpen) return;
  if (dragLook && !(e.buttons & 2)) return;
  const sens = 0.0022 * player.fovScale * (ctx.settings ? ctx.settings.sens : 1);
  player.yaw -= e.movementX * sens;
  player.pitch = THREE.MathUtils.clamp(player.pitch - e.movementY * sens, -1.5, 1.5);
});
document.addEventListener('mousedown', (e) => { if (!playing || ctx.uiOpen) return; input.keys.add('Mouse' + e.button); input.pressed.add('Mouse' + e.button); });
document.addEventListener('mouseup', (e) => input.keys.delete('Mouse' + e.button));
document.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('wheel', (e) => { if (playing) input.pressed.add(e.deltaY > 0 ? 'WheelDown' : 'WheelUp'); }, { passive: true });
window.addEventListener('keydown', (e) => {
  if (!playing) return;
  if (e.code === 'Escape' && dragLook) { setPlaying(false); return; }
  if (!/^F\d+$/.test(e.code)) e.preventDefault();
  if (!e.repeat) { input.pressed.add(e.code); if (e.code === 'KeyP') view.setPostEnabled(!view.postEnabled); if (e.code === 'KeyN') toggleMute(); }
  input.keys.add(e.code);
});
window.addEventListener('keyup', (e) => input.keys.delete(e.code));
window.addEventListener('blur', () => input.keys.clear());

// N silences everything (music, guns, ambience); the choice is remembered
let allMuted = false;
try { allMuted = localStorage.getItem('sh-muted') === '1'; } catch { /* storage unavailable */ }
const muteTag = document.createElement('div');
muteTag.style.cssText = 'position:fixed;top:30px;right:16px;font-size:12px;letter-spacing:1px;color:#fff;opacity:.7;pointer-events:none';
muteTag.textContent = 'SOUND OFF — N'; muteTag.hidden = !allMuted; document.body.appendChild(muteTag);
if (allMuted && ctx.audio) ctx.audio.mute(true);
function toggleMute() {
  allMuted = !allMuted;
  if (ctx.audio) ctx.audio.mute(allMuted);
  muteTag.hidden = !allMuted;
  try { localStorage.setItem('sh-muted', allMuted ? '1' : '0'); } catch { /* storage unavailable */ }
}

ctx.relock = async () => { try { await renderer.domElement.requestPointerLock(); } catch { dragLook = true; } };

// ---- loop -----------------------------------------------------------------
const hudSpeed = document.getElementById('speed'), hudState = document.getElementById('state');
const hudPrompt = document.getElementById('prompt'), hudFps = document.getElementById('fps');
let last = performance.now(), fpsT = 0, fpsN = 0, frameN = 0;

function step(dt) {
  ctx.time += dt;
  player.update(dt);
  for (const s of systems) { if (s.update) { try { s.update(dt); } catch (e) { if (!s.err) console.error(`[${s.name}] update failed`, e); s.err = true; } } }
  input.pressed.clear();
  for (const p of world.pads) {
    p.pulse = Math.max(0, (p.pulse || 0) - dt * 2.5);
    p.ring.position.y = 0.2 + Math.sin(ctx.time * 3 + p.x) * 0.04 + p.pulse * 0.6;
    p.ring.scale.setScalar(1 + p.pulse * 0.5);
  }
}

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05); last = now;
  if (playing) step(dt); else if (!window.__test) player.update(0);
  if (frameN++ % 20 === 0) world.updateLOD(camera.position);
  view.update(dt, player);
  view.render(dt);

  hudSpeed.firstChild.nodeValue = Math.hypot(player.vel.x, player.vel.z).toFixed(1);
  hudState.textContent = player.label;
  hudPrompt.style.display = player.prompt ? 'block' : 'none';
  if (player.prompt) hudPrompt.innerHTML = player.prompt;
  fpsT += dt; fpsN++;
  if (fpsT > 0.5) { hudFps.textContent = `${Math.round(fpsN / fpsT)} fps${view.postEnabled ? '' : ' · post off'}`; fpsT = 0; fpsN = 0; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// hooks for automated testing
window.__game = { ctx, player, input, world, step, scene, camera, renderer, view, setPlaying, THREE };
