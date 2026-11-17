import * as THREE from 'three';

// Golden-hour sky dome with an animated cloud layer, plus the image-based-lighting probe made from it.

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Tileable value-noise fbm in a 256x256 RGBA texture (four independent fields). Shared with materials.
let noiseTex = null;
export function getNoiseTexture() {
  if (noiseTex) return noiseTex;
  const S = 256, data = new Uint8Array(S * S * 4);
  for (let ch = 0; ch < 4; ch++) {
    const rand = rng(1234 + ch * 77);
    const acc = new Float32Array(S * S);
    let amp = 0.5, total = 0;
    for (let cells = 4; cells <= 128; cells *= 2) {
      const g = new Float32Array(cells * cells); for (let i = 0; i < g.length; i++) g[i] = rand();
      const sc = cells / S;
      for (let y = 0; y < S; y++) {
        const fy = y * sc, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty), y1 = (y0 + 1) % cells;
        for (let x = 0; x < S; x++) {
          const fx = x * sc, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx), x1 = (x0 + 1) % cells;
          const a = g[y0 * cells + x0], b = g[y0 * cells + x1], c = g[y1 * cells + x0], d = g[y1 * cells + x1];
          acc[y * S + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
        }
      }
      total += amp; amp *= 0.5;
    }
    let mn = 1, mx = 0; for (let i = 0; i < acc.length; i++) { const v = acc[i] / total; if (v < mn) mn = v; if (v > mx) mx = v; }
    for (let i = 0; i < acc.length; i++) data[i * 4 + ch] = Math.round((((acc[i] / total) - mn) / (mx - mn)) * 255);
  }
  noiseTex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.minFilter = THREE.LinearMipmapLinearFilter; noiseTex.magFilter = THREE.LinearFilter;
  noiseTex.generateMipmaps = true; noiseTex.anisotropy = 8; noiseTex.needsUpdate = true;
  return noiseTex;
}

export const SKY = {
  fogColor: new THREE.Color(0.80, 0.60, 0.44),
  sunFog: new THREE.Color(1.0, 0.58, 0.26),
  fogDensity: 0.0030,
  fogFalloff: 0.022,
};

const skyFrag = /* glsl */`
uniform vec3 uSun; uniform float uTime; uniform float uDisc; uniform float uClouds;
uniform vec3 uFogColor; uniform vec3 uSunFog; uniform float uFogDensity; uniform float uFogFalloff; uniform float uCamY;
uniform sampler2D uNoise;
varying vec3 vDir;

// explicit mip level (lod = log2 of the footprint of p in noise texels): the cloud code runs inside branches
float fbm( vec2 p, float lod ) {
	float a = textureLod( uNoise, p, lod ).r;
	float b = textureLod( uNoise, p * 2.7 + vec2( 0.31, 0.17 ) + uTime * 0.0006, lod + 1.43 ).g;
	float c = textureLod( uNoise, p * 6.9 + vec2( 0.11, 0.73 ), lod + 2.79 ).b;
	return a * 0.62 + b * 0.27 + c * 0.11;
}
float cloudDensity( vec2 p, float lod ) {
	float n = fbm( p, lod );
	float cover = textureLod( uNoise, p * 0.23 + 0.4, 0.0 ).a;
	return smoothstep( 0.47 - cover * 0.24, 0.68 - cover * 0.24, n );
}
void main() {
	vec3 d = normalize( vDir );
	float mu = max( dot( d, uSun ), 0.0 );
	float y = max( d.y, 0.0 );

	// gradient: deep blue zenith -> pale, warm horizon; warmer towards the sun azimuth
	float az = dot( normalize( d.xz + 1e-5 ), normalize( uSun.xz ) ) * 0.5 + 0.5;
	vec3 zenith = vec3( 0.13, 0.27, 0.58 );
	vec3 mid = mix( vec3( 0.42, 0.52, 0.72 ), vec3( 0.62, 0.56, 0.60 ), az );
	vec3 horizon = mix( vec3( 0.78, 0.66, 0.62 ), vec3( 1.25, 0.80, 0.46 ), az * az );
	vec3 col = mix( mid, zenith, smoothstep( 0.0, 0.75, y ) );
	col = mix( col, horizon, pow( 1.0 - y, 7.0 ) );
	// sun glow (mie) and disc
	col += vec3( 1.0, 0.62, 0.30 ) * ( pow( mu, 10.0 ) * 0.45 + pow( mu, 90.0 ) * 0.9 );
	col += vec3( 1.0, 0.86, 0.66 ) * pow( mu, 900.0 ) * 3.0;
	float disc = smoothstep( 0.99955, 0.99985, dot( d, uSun ) );

	// cloud deck
	vec2 p = d.xz / ( y + 0.11 ) * 0.085 + vec2( uTime * 0.0011, uTime * 0.0004 );
	float lod = log2( max( length( dFdx( p ) ), length( dFdy( p ) ) ) * 256.0 + 0.0001 );
	if ( uClouds > 0.0 && d.y > 0.004 ) {
		float den = cloudDensity( p, lod );
		if ( den > 0.002 ) {
			vec2 toSun = normalize( uSun.xz ) * 0.018;
			float occ = cloudDensity( p + toSun, lod ) * 0.6 + cloudDensity( p + toSun * 2.4, lod ) * 0.4;
			float lit = exp( - occ * 2.2 );
			vec3 sunlit = vec3( 1.55, 1.02, 0.62 ) * ( 0.55 + 1.6 * pow( mu, 5.0 ) );
			vec3 shade = mix( vec3( 0.34, 0.36, 0.50 ), vec3( 0.55, 0.42, 0.44 ), az );
			vec3 cc = mix( shade, sunlit, lit );
			cc += vec3( 1.6, 1.0, 0.55 ) * pow( mu, 24.0 ) * ( 1.0 - den ) * 1.4; // silver lining
			float fade = smoothstep( 0.004, 0.16, d.y );
			float a = den * fade * uClouds;
			col = mix( col, cc, a );
			disc *= 1.0 - a;
		}
	}
	col += vec3( 1.0, 0.82, 0.58 ) * disc * uDisc;

	// same height fog as the scene, for a ray leaving to infinity
	float od = d.y > 0.0005 ? uFogDensity * exp( - uFogFalloff * uCamY ) / ( uFogFalloff * d.y ) : 50.0;
	float fog = 1.0 - exp( - od );
	vec3 fogCol = uFogColor + uSunFog * ( pow( mu, 6.0 ) * 0.55 + pow( mu, 48.0 ) * 0.9 );
	col = mix( col, fogCol, fog );
	gl_FragColor = vec4( col, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`;

function skyMaterial(sunDir) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: sunDir.clone().normalize() }, uTime: { value: 0 }, uDisc: { value: 40 }, uClouds: { value: 1 },
      uFogColor: { value: SKY.fogColor }, uSunFog: { value: SKY.sunFog }, uFogDensity: { value: SKY.fogDensity },
      uFogFalloff: { value: SKY.fogFalloff }, uCamY: { value: 2 }, uNoise: { value: getNoiseTexture() },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * viewMatrix * vec4( position * 1500.0 + cameraPosition, 1.0 ); gl_Position = p.xyww; }',
    fragmentShader: skyFrag,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false, toneMapped: true,
  });
}

export function createSky(scene, renderer, sunDir) {
  const geo = new THREE.IcosahedronGeometry(1, 3);
  const mat = skyMaterial(sunDir);
  const dome = new THREE.Mesh(geo, mat);
  dome.frustumCulled = false; dome.renderOrder = -1000; dome.matrixAutoUpdate = false;
  scene.add(dome);

  // lighting probe: the same sky without the sun disc (the sun is a real light) + a ground bounce plane
  {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const em = skyMaterial(sunDir); em.uniforms.uDisc.value = 0; em.uniforms.uTime.value = 40;
    const s = new THREE.Mesh(geo, em); s.frustumCulled = false; envScene.add(s);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1400, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.30, 0.25, 0.21) }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -3; envScene.add(ground);
    scene.environment = pmrem.fromScene(envScene, 0.015, 1, 2500).texture;
    pmrem.dispose(); em.dispose(); ground.geometry.dispose(); ground.material.dispose();
  }
  return {
    dome, material: mat,
    update(dt, camera) { mat.uniforms.uTime.value += dt; mat.uniforms.uCamY.value = camera.position.y; },
    setClouds(v) { mat.uniforms.uClouds.value = v; },
  };
}
