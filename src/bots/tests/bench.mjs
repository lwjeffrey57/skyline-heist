// node micro-benchmark of the nav grid on a synthetic box world (no browser needed)
import * as THREE from 'three';
import { Nav } from '../nav.js';
import { CONFIG } from '../config.js';
const cols = [{ min: new THREE.Vector3(-450, -5, -450), max: new THREE.Vector3(450, 0, 450) }];
let s = 7; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
for (let i = 0; i < 600; i++) { const x = r() * 130 - 65, z = r() * 130 - 65, w = 0.3 + r() * 5, d = 0.3 + r() * 5, h = 1 + r() * 3; cols.push({ min: new THREE.Vector3(x - w / 2, 0, z - d / 2), max: new THREE.Vector3(x + w / 2, h, z + d / 2) }); }
const world = { colliders: cols, arenaHalf: 70, pads: [] };
let t = performance.now(); const nav = new Nav(world, CONFIG.nav); console.log('build ms', (performance.now() - t).toFixed(1));
for (let k = 0; k < 5; k++) {
  let done = null; const e0 = nav.stats.expansions;
  nav.requestPath(new THREE.Vector3(-66 + k, 0, -66), new THREE.Vector3(66, 0, 66 - k), (p) => { done = p; });
  t = performance.now(); let frames = 0; while (done === null && frames++ < 1000) nav.update(1 / 60);
  const ms = performance.now() - t, ex = nav.stats.expansions - e0;
  console.log('path', done && done.length, 'frames', frames, 'ms', ms.toFixed(2), 'exp', ex, 'us/exp', (ms * 1000 / ex).toFixed(2));
}
