import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { patchShaderChunks, createSunRig } from './visuals/lighting.js';
import { createSky, SKY, getNoiseTexture } from './visuals/sky.js';
import { ScenePost, TAAPass, FinishPass } from './visuals/post.js';
import { StyleShader } from './visuals/style.js';

// Renderer, sky, lighting and post-processing. Returns the `view` object used by main.js:
//   { renderer, scene, camera, sun, sunDir, composer, update(dt, player), render(dt), resize(), setPostEnabled(b), postEnabled }
// plus: quality, setQuality('low'|'medium'|'high'), cycleQuality(), shadowsDirty(), rig, sky, passes, QUALITY.
//
// Lighting notes for other systems (details in visuals/lighting.js):
//   * the sun is three cascaded shadow lights + one downward "sky occlusion" light. Every shadow-casting
//     DirectionalLight in the scene is interpreted as part of that rig, so do not add another one that casts shadows.
//   * meshes with receiveShadow = true are darkened under roofs (interiors); others get full sky light.
//   * first-person viewmodels are recognised by their squashed depth (gl_FragCoord.z < 0.1, see weapons.js patchDepth):
//     they get a camera-fixed rim + key light, an ambient floor indoors, capped muzzle light, their own TAA
//     handling and depth of field while aiming. Nothing has to be set on the meshes.
//   * post chain: RenderPass -> ScenePost (AO, sun shafts, puddle reflections) -> TAA (high) -> bloom -> FinishPass
//     (weapon DoF, exposure, tone map, grade) -> SMAA (medium) / FXAA (low).

export const QUALITY = {
  // max pixel ratio, shadow map sizes, far-cascade / sky refresh interval (frames), AO samples, sun shafts, bloom,
  // AA (taa | smaa | fxaa), puddle reflections, weapon depth of field, practical-lamp budget
  low: { pixelRatio: 1.0, shadow: 1024, skyShadow: 512, farEvery: 8, skyEvery: 20, ao: 0, rays: false, bloom: true, aa: 'fxaa', ssr: false, dof: false, lamps: 2, aniso: 2, clouds: 1 },
  medium: { pixelRatio: 1.25, shadow: 2048, skyShadow: 1024, farEvery: 5, skyEvery: 12, ao: 6, rays: true, bloom: true, aa: 'smaa', ssr: false, dof: true, lamps: 3, aniso: 4, clouds: 1 },
  high: { pixelRatio: 1.5, shadow: 2048, skyShadow: 1024, farEvery: 3, skyEvery: 8, ao: 10, rays: true, bloom: true, aa: 'taa', ssr: true, dof: true, lamps: 4, aniso: 8, clouds: 1 },
};
const ORDER = ['low', 'medium', 'high'];
const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const JITTER = Array.from({ length: 8 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

export function createView() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // filtering is done by the cascade shader (visuals/lighting.js)
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // only used when post-processing is off
  renderer.toneMappingExposure = 0.62;
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(88, window.innerWidth / window.innerHeight, 0.08, 3000);
  scene.add(camera);

  // ---- sky, sun, image-based lighting, fog ----------------------------------
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 24), THREE.MathUtils.degToRad(215));
  patchShaderChunks(sunDir, { fogFalloff: SKY.fogFalloff, sunFogColor: SKY.sunFog });
  const sky = createSky(scene, renderer, sunDir);
  scene.environmentIntensity = 1.0;
  scene.fog = new THREE.FogExp2(SKY.fogColor.getHex(THREE.LinearSRGBColorSpace), SKY.fogDensity);
  scene.fog.color.copy(SKY.fogColor);

  const rig = createSunRig(scene, sunDir, { color: 0xffd9a8, intensity: 4.6 });
  const sun = rig.sun;
  const fill = new THREE.DirectionalLight(0x9fc4ff, 0.22); // cool fill from the shadow side (sky bounce)
  fill.position.copy(sunDir).multiplyScalar(-1).setY(0.6); scene.add(fill);

  // ---- post-processing --------------------------------------------------------
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
  // the scene is rendered into its own HDR target; its depth texture feeds AO, reflections, TAA, DoF and metering
  const sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(1, 1) });
  const scenePass = new Pass(); scenePass.needsSwap = false;
  scenePass.setSize = (w, h) => sceneRT.setSize(w, h);
  scenePass.render = (r) => { r.setRenderTarget(sceneRT); r.render(scene, camera); };
  composer.addPass(scenePass);
  const scenePost = new ScenePost(camera, sunDir); scenePost.source = sceneRT;
  composer.addPass(scenePost);
  scenePost.macro = getNoiseTexture();
  const taa = new TAAPass(camera); taa.depthSource = () => scenePost.sceneDepth;
  composer.addPass(taa);
  // soft knee instead of a hard threshold: flashes and explosions glow without a hard-edged white core
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.34, 0.6, 1.15);
  bloom.highPassUniforms.smoothWidth.value = 1.6;
  composer.addPass(bloom);
  const finish = new FinishPass(); finish.depthSource = () => scenePost.sceneDepth; finish.camera = camera;
  composer.addPass(finish);
  // art style: 'ink' (comic outlines and flat light) or 'real'. F8 switches; the choice is remembered
  const style = new ShaderPass(StyleShader); style.uniforms.tDepth.value = sceneRT.depthTexture;
  let styleName = new URLSearchParams(location.search).get('style');
  try { styleName = styleName || localStorage.getItem('sh-style') || 'ink'; } catch { styleName = styleName || 'ink'; }
  style.enabled = styleName === 'ink';
  composer.addPass(style);
  const smaa = new SMAAPass(window.innerWidth, window.innerHeight);
  composer.addPass(smaa);
  const fxaa = new ShaderPass(FXAAShader); fxaa.enabled = false;
  composer.addPass(fxaa);

  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;right:16px;top:30px;font:12px system-ui,sans-serif;color:#fff;opacity:0;transition:opacity .4s;pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,.7)';
  document.body.appendChild(hud);
  let hudTimer = 0;

  const view = {
    renderer, scene, camera, sun, sunDir, composer, postEnabled: true,
    rig, sky, QUALITY, quality: 'high', lampBudget: 4, anisotropy: 8, frame: 0, dofEnabled: true,
    passes: { scenePass, scenePost, taa, bloom, finish, smaa, fxaa }, sceneRT,
    setPostEnabled(b) { view.postEnabled = b; },
    // 'low' | 'medium' | 'high'
    setQuality(name, announce = false) {
      const q = QUALITY[name]; if (!q) return;
      view.quality = name;
      view.pixelRatio = Math.min(window.devicePixelRatio || 1, q.pixelRatio);
      rig.setMapSize(q.shadow, q.skyShadow); rig.setTaps(name !== 'low'); rig.farEvery = q.farEvery; rig.skyEvery = q.skyEvery;
      scenePost.aoEnabled = q.ao > 0; scenePost.aoSamples = q.ao || 6; scenePost.raysEnabled = q.rays;
      bloom.enabled = q.bloom;
      smaa.enabled = q.aa === 'smaa'; fxaa.enabled = q.aa === 'fxaa';
      taa.enabled = q.aa === 'taa'; taa.reset = true;
      rig.temporal = scenePost.temporal = taa.enabled; // the shadow / AO / reflection noise turns over only when TAA can average it
      scenePost.ssrEnabled = q.ssr; view.dofEnabled = q.dof;
      finish.material.uniforms.uSharpen.value = q.aa === 'fxaa' ? 0.5 : q.aa === 'taa' ? 0.6 : 0.35;
      view.lampBudget = q.lamps; view.anisotropy = q.aniso;
      sky.setClouds(q.clouds);
      scene.traverse((o) => { // texture filtering quality
        const m = o.material; if (!m || Array.isArray(m)) return;
        for (const k of ['map', 'normalMap', 'roughnessMap']) { const t = m[k]; if (t && t.anisotropy !== q.aniso && t.userData.aniso !== false) { t.anisotropy = q.aniso; t.needsUpdate = true; } }
      });
      view.resize();
      if (announce) { hud.textContent = `quality: ${name}`; hud.style.opacity = 0.85; clearTimeout(hudTimer); hudTimer = setTimeout(() => { hud.style.opacity = 0; }, 1600); }
    },
    cycleQuality() { view.setQuality(ORDER[(ORDER.indexOf(view.quality) + 1) % ORDER.length], true); },
    // call when level geometry changed (a piece was destroyed) so the cached shadow maps refresh at once
    shadowsDirty() { rig.markDirty(); },
    // called every frame before render
    update(dt, player) {
      const hs = Math.hypot(player.vel.x, player.vel.z);
      finish.material.uniforms.uSpeed.value = THREE.MathUtils.clamp((hs - 7) / 9, 0, 1);
      // weapon depth of field follows the aim (weapons.js publishes it as player.fovScale < 1)
      const aim = view.dofEnabled ? THREE.MathUtils.smoothstep(1 - (player.fovScale ?? 1), 0.03, 0.14) : 0;
      finish.dof = THREE.MathUtils.damp(finish.dof, aim, 14, dt);
      if (finish.dof < 0.01) finish.dof = 0;
      camera.updateMatrixWorld();
      rig.temporal = scenePost.temporal = taa.enabled && view.postEnabled;
      rig.update(camera);
      sky.update(dt, camera);
    },
    render(dt) {
      if (!view.postEnabled) { taa.reset = true; renderer.render(scene, camera); return; }
      if (!taa.enabled) { composer.render(dt); return; }
      // temporal AA: shift the projection by a sub-pixel Halton offset for this frame only (other systems read
      // camera.projectionMatrix for aiming / HUD maths, so it is restored straight after)
      const e = camera.projectionMatrix.elements, e8 = e[8], e9 = e[9];
      taa.proj.copy(camera.projectionMatrix);
      const j = JITTER[view.frame++ % JITTER.length], pr = view.pixelRatio || 1;
      e[8] += (j[0] * 2) / (window.innerWidth * pr); e[9] += (j[1] * 2) / (window.innerHeight * pr);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      composer.render(dt);
      e[8] = e8; e[9] = e9; camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    },
    resize() {
      const w = window.innerWidth, h = window.innerHeight, pr = view.pixelRatio || 1;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setPixelRatio(pr); renderer.setSize(w, h);
      composer.setPixelRatio(pr); composer.setSize(w, h);
      fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
      style.uniforms.px.value.set(1 / (w * pr), 1 / (h * pr)); style.uniforms.near.value = camera.near; style.uniforms.far.value = camera.far;
    },
  };
  window.addEventListener('resize', view.resize);
  window.addEventListener('keydown', (e) => { if (e.code === 'F2' && !e.repeat) { e.preventDefault(); view.cycleQuality(); } });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'F8' || e.repeat) return;
    e.preventDefault(); style.enabled = !style.enabled;
    try { localStorage.setItem('sh-style', style.enabled ? 'ink' : 'real'); } catch { /* storage unavailable */ }
    view.setQuality(view.quality); syncAA();
    hud.textContent = `art style: ${style.enabled ? 'ink' : 'realistic'}`; hud.style.opacity = 0.85; clearTimeout(hudTimer); hudTimer = setTimeout(() => { hud.style.opacity = 0; }, 1400);
  });
  view.style = style;
  const want = new URLSearchParams(location.search).get('q');
  // ink lines must not follow the sub-pixel camera shake that temporal anti-aliasing uses, or they wobble:
  // with the ink style on, the steadier edge anti-aliasing is used instead
  function syncAA() { if (style.enabled && taa.enabled) { taa.enabled = false; smaa.enabled = true; rig.temporal = scenePost.temporal = false; } }
  const setQ = view.setQuality; view.setQuality = (n, a) => { setQ(n, a); syncAA(); };
  view.setQuality(QUALITY[want] ? want : 'high');
  return view;
}
