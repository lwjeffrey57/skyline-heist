import * as THREE from 'three';

// Instanced bullet tracers and lingering beams. One draw call, fully shader-animated.
// A tracer is a camera-facing ribbon whose head flies from start to end at `speed`; a beam
// (speed = 0) spans the whole segment at once and fades over `life`.

const STRIDE = 16;
export const TRACER_CAP = 96;

const VERT = /* glsl */`
attribute vec2 aCorner;
attribute vec4 aStart; // xyz, birth
attribute vec4 aEnd;   // xyz, speed (0 = beam)
attribute vec4 aCol;   // rgb, width
attribute vec4 aPar;   // length, life, lead, near-fade distance
uniform float uTime; uniform float uFogDensity;
varying vec2 vUv; varying vec3 vCol; varying float vA;
void main() {
  float age = uTime - aStart.w;
  vUv = vec2(0.0); vCol = vec3(0.0); vA = 0.0;
  vec3 seg = aEnd.xyz - aStart.xyz; float dist = length(seg);
  if (aPar.y <= 0.0 || age < 0.0 || age >= aPar.y || dist < 1e-3) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 dir = seg / dist;
  float head, tail, fade;
  if (aEnd.w > 0.0) {
    float h = aPar.z + aEnd.w * age;
    head = min(h, dist); tail = clamp(h - aPar.x, 0.0, dist);
    if (tail >= dist - 1e-3) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    fade = 1.0;
  } else {
    head = dist; tail = 0.0; fade = 1.0 - age / aPar.y; fade *= fade;
  }
  float along = aCorner.y * 0.5 + 0.5;
  vec3 p = aStart.xyz + dir * mix(tail, head, along);
  vec3 toCam = cameraPosition - p; float cd = length(toCam);
  vec3 side = normalize(cross(dir, toCam));
  float w = max(aCol.w, cd * 0.0011) * (aEnd.w > 0.0 ? 1.0 : 0.6 + 0.4 * fade);
  p += side * aCorner.x * w * 0.5;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vUv = vec2(aCorner.x, along);
  vCol = aCol.rgb;
  float fog = exp(-uFogDensity * cd);
  vA = fade * fog * smoothstep(0.3, aPar.w, cd) * min(1.0, aCol.w / max(cd * 0.0011, 1e-5) * 0.6 + 0.4);
  if (aEnd.w <= 0.0) vUv.y = 0.75;
}`;

const FRAG = /* glsl */`
varying vec2 vUv; varying vec3 vCol; varying float vA;
void main() {
  float x = abs(vUv.x), y = vUv.y;
  // thin hot core + faint halo; brightness piles up at the head and the tail thins out to nothing
  float tail = y * y * (0.35 + 0.65 * y);
  float head = smoothstep(0.86, 0.97, y) * (1.0 - smoothstep(0.985, 1.0, y));
  float w = mix(0.35, 1.0, y);                              // the ribbon narrows toward the tail
  float xs = x / w;
  float core = exp(-xs * xs * 9.0) * step(xs, 1.0);
  float a = core * (tail + head * 1.6) * vA;
  vec3 c = mix(vCol, vec3(dot(vCol, vec3(0.5)) * 1.1), head * 0.6); // white-hot tip
  gl_FragColor = vec4(c * a, 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Tracers {
  constructor() {
    this.data = new Float32Array(TRACER_CAP * STRIDE); this.head = 0; this.time = 0;
    const ib = this.ib = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    ib.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    ['aStart', 'aEnd', 'aCol', 'aPar'].forEach((n, i) => g.setAttribute(n, new THREE.InterleavedBufferAttribute(ib, 4, i * 4)));
    g.instanceCount = TRACER_CAP;
    this.uniforms = { uTime: { value: 0 }, uFogDensity: { value: 0.003 } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 12; this.mesh.matrixAutoUpdate = false; this.mesh.name = 'fx-tracers';
  }

  // speed > 0: flying tracer (life is derived); speed = 0: static beam fading over `life`
  add(sx, sy, sz, ex, ey, ez, r, g, b, width, speed, length, lead, life, nearFade = 5) {
    const i = this.head; this.head = (i + 1) % TRACER_CAP;
    const d = this.data, o = i * STRIDE;
    if (speed > 0) life = (Math.hypot(ex - sx, ey - sy, ez - sz) + length) / speed + 0.02;
    d[o] = sx; d[o + 1] = sy; d[o + 2] = sz; d[o + 3] = this.time;
    d[o + 4] = ex; d[o + 5] = ey; d[o + 6] = ez; d[o + 7] = speed;
    d[o + 8] = r; d[o + 9] = g; d[o + 10] = b; d[o + 11] = width;
    d[o + 12] = length; d[o + 13] = life; d[o + 14] = lead; d[o + 15] = nearFade;
    this.ib.needsUpdate = true;
  }

  setTime(t) { this.time = t; this.uniforms.uTime.value = t; }
}
