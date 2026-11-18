import * as THREE from 'three';

// "Ink" art style: a comic-book finish applied to the finished frame. Dark outlines are drawn wherever the depth
// buffer bends or breaks (silhouettes and creases), light is quantised into a few flat bands, and colour is pushed.
// It runs as one full-screen pass, so it costs the same whatever is on screen.
export const StyleShader = {
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, px: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    near: { value: 0.1 }, far: { value: 1000 }, bands: { value: 5 }, sat: { value: 0.7 }, ink: { value: new THREE.Color(0.035, 0.04, 0.07) }, line: { value: 1.25 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse, tDepth; uniform vec2 px; uniform float near, far, bands, sat, line; uniform vec3 ink; varying vec2 vUv;
    float lin(vec2 uv){ float z = texture2D(tDepth, uv).x * 2.0 - 1.0; return 2.0 * near * far / (far + near - z * (far - near)); }
    float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec2 o = px * line;
      float d0 = lin(vUv), dl = lin(vUv - vec2(o.x, 0.0)), dr = lin(vUv + vec2(o.x, 0.0)), du = lin(vUv + vec2(0.0, o.y)), dd = lin(vUv - vec2(0.0, o.y));
      // second difference of depth: zero across a flat surface at any angle, large at silhouettes, smaller at creases
      float e = (abs(dl + dr - 2.0 * d0) + abs(du + dd - 2.0 * d0)) / d0;
      float edge = smoothstep(0.012, 0.045, e) * (1.0 - smoothstep(90.0, 220.0, d0));
      // flat bands of light, with a soft step between them so gradients do not shimmer
      // flat bands of light, taken from a blurred copy of the picture so surface grain does not turn into speckle
      vec2 b2 = px * 2.5;
      float lb0 = (lum(c) * 2.0 + lum(texture2D(tDiffuse, vUv + vec2(b2.x, b2.y)).rgb) + lum(texture2D(tDiffuse, vUv - vec2(b2.x, b2.y)).rgb) + lum(texture2D(tDiffuse, vUv + vec2(b2.x, -b2.y)).rgb) + lum(texture2D(tDiffuse, vUv + vec2(-b2.x, b2.y)).rgb)) / 6.0;
      float l = max(lum(c), 1e-4), q = sqrt(lb0) * bands, f = fract(q);
      float lq = (floor(q) + smoothstep(0.4, 0.6, f)) / bands; lq *= lq;
      float sky = smoothstep(far * 0.5, far * 0.9, d0);
      c = mix(c * (lq / max(lb0, 1e-4)), c, max(sky, 0.5));
      // richer colour; shadows become deep blue-violet instead of black
      c = mix(vec3(lum(c)), c, sat);
      c = max(c, vec3(0.0));
      c = mix(vec3(0.055, 0.06, 0.11), c + vec3(0.02, 0.022, 0.04), smoothstep(0.0, 0.16, lum(c)) * 0.75 + 0.25);
      gl_FragColor = vec4(mix(c, ink, edge * 0.75), 1.0);
    }`,
};
