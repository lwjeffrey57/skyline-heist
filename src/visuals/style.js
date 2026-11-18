import * as THREE from 'three';

// "Ink" art style: the world keeps its full colour and lighting, and is drawn over with black ink. Heavy lines follow
// silhouettes and creases (found where the depth buffer breaks or bends), thinner lines follow painted detail and
// hard shadow edges (found where brightness jumps). Lines are thicker on near things, like a drawn panel.
// It runs as one full-screen pass, so it costs the same whatever is on screen.
export const StyleShader = {
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, px: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    near: { value: 0.1 }, far: { value: 1000 }, sat: { value: 1.12 }, ink: { value: new THREE.Color(0.02, 0.02, 0.03) },
    line: { value: 1.0 }, detail: { value: 0.55 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse, tDepth; uniform vec2 px; uniform float near, far, sat, line, detail; uniform vec3 ink; varying vec2 vUv;
    float lin(vec2 uv){ float z = texture2D(tDepth, uv).x * 2.0 - 1.0; return 2.0 * near * far / (far + near - z * (far - near)); }
    float lum(vec2 uv){ return dot(texture2D(tDiffuse, uv).rgb, vec3(0.299, 0.587, 0.114)); }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float d0 = lin(vUv);
      // line weight: about 2.4 px on things within a few metres, 1 px far away
      vec2 o = px * line * mix(2.0, 1.0, smoothstep(1.5, 14.0, d0));
      float dl = lin(vUv - vec2(o.x, 0.0)), dr = lin(vUv + vec2(o.x, 0.0)), du = lin(vUv + vec2(0.0, o.y)), dd = lin(vUv - vec2(0.0, o.y));
      // second difference of depth: zero across a flat surface at any angle, large at silhouettes, smaller at creases
      float e = (abs(dl + dr - 2.0 * d0) + abs(du + dd - 2.0 * d0)) / d0;
      float outline = smoothstep(0.012, 0.04, e);
      // detail lines: brightness jumps (painted markings, panel seams, hard shadow edges), ignored in the sky and at range
      float l0 = dot(c, vec3(0.299, 0.587, 0.114));
      float gx = lum(vUv + vec2(o.x, 0.0)) - lum(vUv - vec2(o.x, 0.0)), gy = lum(vUv + vec2(0.0, o.y)) - lum(vUv - vec2(0.0, o.y));
      float g = sqrt(gx * gx + gy * gy) / (l0 + 0.18);
      float inner = smoothstep(0.55, 1.1, g) * detail * (1.0 - smoothstep(10.0, 28.0, d0));
      // ink is strong up close and thins out with distance, so far things stay clean and readable
      float fade = mix(1.0, 0.3, smoothstep(18.0, 60.0, d0)) * (1.0 - smoothstep(90.0, 170.0, d0));
      float k = clamp(max(outline, inner) * fade, 0.0, 1.0);
      c = mix(vec3(l0), c, sat);
      gl_FragColor = vec4(mix(max(c, vec3(0.0)), ink, k * 0.95), 1.0);
    }`,
};
