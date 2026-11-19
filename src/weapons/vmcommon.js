import * as THREE from 'three';
import { buildHand } from './vmkit.js';

// Helpers shared by the viewmodel builders (viewmodels.js, viewmodels2.js).

export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const seg = (t, a, b) => clamp01((t - a) / (b - a));
export const ease = (x) => x * x * (3 - 2 * x);
export const eseg = (t, a, b) => ease(seg(t, a, b));
export const bump = (t, a, b) => Math.sin(Math.PI * seg(t, a, b));

export function finish(group) {
  group.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true; } });
}
export const GRIP_CURLS = [[0.3, 0.62, 0.35], [1.2, 1.5, 0.9], [1.25, 1.55, 0.9], [1.3, 1.55, 0.9]];
export const WRAP_CURLS = [[1.15, 1.5, 0.9], [1.2, 1.5, 0.9], [1.25, 1.55, 0.9], [1.3, 1.55, 0.9]];
export const CUP_CURLS = [[0.8, 1.2, 0.75], [0.85, 1.25, 0.8], [0.9, 1.25, 0.8], [0.95, 1.3, 0.8]];
export const GRIP_THUMB = { dir: [-0.62, 0.5, -0.6], bend: [-0.7, -0.6, 0.2], angle: 0.42 };
export const CUP_THUMB = { dir: [-0.2, 0.72, -0.66], bend: [-0.7, 0.2, -0.2], angle: 0.18 };
// right hand on a pistol grip whose front strap is at (f, y)
export const gripHand = (M, f, y, extra = {}) => buildHand(M, { right: true, pos: [0.036, y + 0.02, f - 0.092], fwd: [-0.1, 0.28, 0.95], palm: [-1, 0, -0.12], elbow: [0.3, -0.42, -0.85], curls: GRIP_CURLS, thumb: GRIP_THUMB, trigger: true, ...extra });
// left hand cupping a fore-end from below; (f, y) = centre underside
export const cupHand = (M, f, y, extra = {}) => buildHand(M, { right: false, pos: [-0.04, y - 0.017, f - 0.045], fwd: [0.8, 0.12, 0.55], palm: [0, 1, 0], elbow: [-0.36, -0.5, -0.79], curls: CUP_CURLS, thumb: CUP_THUMB, ...extra });

export const GRIP_PTS = [[-0.035, -0.022], [-0.09, -0.022], [-0.102, -0.034], [-0.128, -0.14], [-0.12, -0.15], [-0.082, -0.15], [-0.072, -0.11], [-0.052, -0.06], [-0.032, -0.042]];
export const shiftPts = (pts, df, dy = 0) => pts.map(([f, y]) => [f + df, y + dy]);
export const TRIGGER = [[-0.006, -0.022], [0.002, -0.022], [0.0045, -0.036], [0.0005, -0.05], [-0.0035, -0.05], [-0.002, -0.036]];
