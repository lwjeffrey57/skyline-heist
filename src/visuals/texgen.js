import * as THREE from 'three';

// GPU procedural PBR texture generator. Each surface is a GLSL function evaluated over one tile
// (uv 0..1 = 4 m in the world, see world.js boxGeo) and must be periodic. For every surface we render:
//   albedo  (sRGB, alpha = "top layer" mask, e.g. paint vs. exposed substrate)
//   normal  (tangent space, derived from the height field)
//   orm     (R = ambient occlusion, G = roughness, B = metalness)

const LIB = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uSeed;
float hash( vec2 p, float s ) {
	uvec2 q = uvec2( ivec2( p ) ) * uvec2( 1597334673u, 3812015801u ) + uint( s + uSeed ) * 747796405u;
	uint n = ( q.x ^ q.y ) * 1597334673u; n ^= n >> 15; n *= 2246822519u; n ^= n >> 13;
	return float( n ) * ( 1.0 / 4294967295.0 );
}
// periodic value noise, period = per cells
float vnoise( vec2 x, vec2 per, float s ) {
	vec2 i = floor( x ), f = fract( x ); f = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
	float a = hash( mod( i, per ), s ), b = hash( mod( i + vec2( 1, 0 ), per ), s );
	float c = hash( mod( i + vec2( 0, 1 ), per ), s ), d = hash( mod( i + vec2( 1, 1 ), per ), s );
	return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
// fbm over the unit tile; freq = cells across the tile at the first octave (vec2 allows stretching)
float fbm( vec2 uv, vec2 freq, int oct, float s ) {
	float v = 0.0, a = 0.5, t = 0.0;
	for ( int i = 0; i < oct; i ++ ) { v += a * vnoise( uv * freq, freq, s + float( i ) * 17.0 ); t += a; a *= 0.5; freq *= 2.0; }
	return v / t;
}
// periodic worley: x = distance to nearest point, y = cell id hash
vec2 worley( vec2 uv, vec2 freq, float s ) {
	vec2 x = uv * freq, i = floor( x ), f = fract( x ); float best = 9.0, id = 0.0;
	for ( int oy = -1; oy <= 1; oy ++ ) for ( int ox = -1; ox <= 1; ox ++ ) {
		vec2 o = vec2( float( ox ), float( oy ) ), c = mod( i + o, freq );
		vec2 p = o + vec2( hash( c, s ), hash( c, s + 5.0 ) ) - f; float d = dot( p, p );
		if ( d < best ) { best = d; id = hash( c, s + 9.0 ); }
	}
	return vec2( sqrt( best ), id );
}
float line( float x, float w ) { return 1.0 - smoothstep( 0.0, w, abs( x ) ); }
// distance to the nearest of n evenly spaced lines across the tile (in tile units)
float grid( float u, float n ) { float x = fract( u * n ); return min( x, 1.0 - x ) / n; }

struct Surf { float h; vec3 albedo; float mask; float rough; float ao; float metal; };
`;

// ---- surfaces -----------------------------------------------------------------
// h is in metres (roughly); albedo is near-white (tinted by the material colour) unless stated.

const CONCRETE = /* glsl */`
uniform float uKind; // 0 = formwork wall concrete, 1 = trowelled floor slab
Surf surface( vec2 uv ) {
	Surf s; vec2 m = uv * 4.0; // metres
	float big = fbm( uv, vec2( 3.0 ), 5, 1.0 ), mid = fbm( uv, vec2( 12.0 ), 5, 2.0 ), fine = fbm( uv, vec2( 96.0 ), 3, 3.0 );
	float grain = hash( floor( uv * 1024.0 ), 4.0 );
	float tone = 0.80 + 0.16 * big + 0.08 * ( mid - 0.5 ) + 0.05 * ( fine - 0.5 ) + 0.03 * ( grain - 0.5 );
	s.h = 0.0015 * mid + 0.0012 * fine + 0.0004 * grain; s.rough = 0.86 + 0.1 * ( fine - 0.5 ) - 0.1 * smoothstep( 0.55, 0.8, big ); s.ao = 1.0; s.metal = 0.0; s.mask = 1.0;
	// pits / bug holes
	vec2 w = worley( uv, vec2( 56.0 ), 5.0 ); float pit = ( 1.0 - smoothstep( 0.04, 0.13, w.x ) ) * step( 0.9, w.y );
	if ( uKind < 0.5 ) {
		// formwork panels 2.0 m x 1.333 m, each cast slightly differently
		vec2 pc = vec2( 2.0, 3.0 ); vec2 cell = floor( uv * pc );
		float pv = hash( cell, 11.0 ); tone *= 0.94 + 0.09 * pv;
		float seam = min( grid( uv.x, 2.0 ), grid( uv.y, 3.0 ) ) * 4.0; // metres to nearest seam
		float groove = 1.0 - smoothstep( 0.004, 0.012, seam );
		float lip = ( 1.0 - smoothstep( 0.0, 0.07, seam ) ) * ( 0.5 + 0.5 * mid );
		s.h -= 0.004 * groove; s.h += 0.0012 * lip; tone *= 1.0 - 0.38 * groove - 0.07 * lip; s.ao -= 0.45 * groove;
		// plank grain left by the formwork
		float plank = fbm( uv, vec2( 6.0, 160.0 ), 3, 21.0 ); s.h += 0.0006 * plank; tone *= 0.97 + 0.06 * plank;
		// tie holes, 4 per panel
		vec2 pm = fract( uv * pc ) * vec2( 2.0, 1.3333 ); vec2 q = abs( pm - vec2( 1.0, 0.6667 ) ) - vec2( 0.55, 0.36 );
		float hd = length( q ); float hole = 1.0 - smoothstep( 0.016, 0.024, hd ); float ring = ( 1.0 - smoothstep( 0.024, 0.045, hd ) ) - hole;
		s.h -= 0.006 * hole; s.h += 0.0008 * ring; tone *= 1.0 - 0.55 * hole + 0.05 * ring; s.ao -= 0.5 * hole;
		// rain streaks running down from the horizontal seams and holes
		float streak = fbm( uv, vec2( 72.0, 2.0 ), 3, 31.0 ); float sm = smoothstep( 0.52, 0.8, streak ) * smoothstep( 0.35, 0.7, fbm( uv, vec2( 5.0, 3.0 ), 3, 33.0 ) );
		float below = 1.0 - fract( uv.y * 3.0 ); tone *= 1.0 - 0.2 * sm * ( 0.35 + 0.65 * below * below ); s.rough += 0.05 * sm;
	} else {
		// saw-cut control joints every 2 m, power-float swirls, scuffs
		float seam = min( grid( uv.x, 2.0 ), grid( uv.y, 2.0 ) ) * 4.0;
		float groove = 1.0 - smoothstep( 0.003, 0.009, seam );
		s.h -= 0.003 * groove; tone *= 1.0 - 0.3 * groove; s.ao -= 0.35 * groove;
		float swirl = fbm( uv + 0.06 * vec2( fbm( uv, vec2( 4.0 ), 3, 41.0 ), fbm( uv, vec2( 4.0 ), 3, 42.0 ) ), vec2( 10.0 ), 4, 43.0 );
		tone *= 0.93 + 0.12 * swirl; s.rough = 0.62 + 0.22 * swirl + 0.1 * ( fine - 0.5 );
		float scuff = smoothstep( 0.62, 0.9, fbm( uv, vec2( 40.0, 5.0 ), 3, 44.0 ) ) * smoothstep( 0.4, 0.7, big );
		tone *= 1.0 - 0.1 * scuff; s.rough += 0.12 * scuff;
	}
	// hairline cracks
	float cr = fbm( uv + 0.04 * vec2( fbm( uv, vec2( 8.0 ), 3, 51.0 ), fbm( uv, vec2( 8.0 ), 3, 52.0 ) ), vec2( 3.0 ), 3, 53.0 );
	float crack = ( 1.0 - smoothstep( 0.0, 0.0035, abs( cr - 0.5 ) ) ) * smoothstep( 0.5, 0.75, fbm( uv, vec2( 2.0 ), 2, 54.0 ) );
	s.h -= 0.002 * crack; tone *= 1.0 - 0.4 * crack;
	s.h -= 0.003 * pit; tone *= 1.0 - 0.35 * pit; s.ao -= 0.3 * pit;
	// faint warm / cool mottling so it is not a flat grey
	vec3 tint = mix( vec3( 1.0, 0.985, 0.955 ), vec3( 0.955, 0.98, 1.0 ), fbm( uv, vec2( 2.0 ), 4, 61.0 ) );
	s.albedo = vec3( tone ) * tint; s.rough = clamp( s.rough, 0.3, 1.0 ); s.ao = clamp( s.ao, 0.0, 1.0 );
	return s;
}`;

const ASPHALT = /* glsl */`
Surf surface( vec2 uv ) {
	Surf s; s.metal = 0.0; s.mask = 1.0;
	float big = fbm( uv, vec2( 2.0 ), 5, 1.0 ), mid = fbm( uv, vec2( 10.0 ), 4, 2.0 );
	vec2 w1 = worley( uv, vec2( 150.0 ), 3.0 ), w2 = worley( uv, vec2( 64.0 ), 4.0 );
	float stone = 1.0 - smoothstep( 0.15, 0.5, w1.x ), pebble = ( 1.0 - smoothstep( 0.1, 0.42, w2.x ) ) * step( 0.55, w2.y );
	float tone = 0.62 + 0.2 * big + 0.1 * ( mid - 0.5 );
	tone += stone * ( 0.10 + 0.25 * w1.y * w1.y ) + pebble * 0.2 * w2.y;
	s.h = 0.0035 * stone + 0.004 * pebble + 0.002 * mid;
	s.rough = 0.9 - 0.12 * stone + 0.06 * ( mid - 0.5 ); s.ao = 0.78 + 0.22 * max( stone, pebble );
	// worn lanes: smoother and a bit lighter
	float wear = smoothstep( 0.45, 0.75, fbm( uv, vec2( 3.0, 1.0 ), 4, 7.0 ) );
	tone *= 1.0 + 0.1 * wear; s.rough -= 0.1 * wear; s.h *= 1.0 - 0.4 * wear;
	// cracks sealed with tar
	vec2 warp = vec2( fbm( uv, vec2( 6.0 ), 4, 11.0 ), fbm( uv, vec2( 6.0 ), 4, 12.0 ) ) * 0.09;
	float c1 = fbm( uv + warp, vec2( 2.0 ), 2, 13.0 ), c2 = fbm( uv - warp, vec2( 3.0 ), 2, 14.0 );
	float gate = smoothstep( 0.42, 0.6, fbm( uv, vec2( 2.0 ), 3, 15.0 ) );
	float tar = max( ( 1.0 - smoothstep( 0.004, 0.011, abs( c1 - 0.5 ) ) ) * gate, ( 1.0 - smoothstep( 0.002, 0.006, abs( c2 - 0.47 ) ) ) * ( 1.0 - gate ) );
	float crack = max( ( 1.0 - smoothstep( 0.0, 0.003, abs( c1 - 0.5 ) ) ) * gate, ( 1.0 - smoothstep( 0.0, 0.002, abs( c2 - 0.47 ) ) ) * ( 1.0 - gate ) );
	tone = mix( tone, 0.34, tar * 0.7 ); s.rough = mix( s.rough, 0.7, tar * 0.8 ); s.h = mix( s.h, 0.0025, tar ); s.h -= 0.004 * crack; s.ao -= 0.3 * crack;
	// oil stains
	float oil = smoothstep( 0.66, 0.84, fbm( uv, vec2( 5.0 ), 4, 21.0 ) );
	tone *= 1.0 - 0.3 * oil; s.rough -= 0.22 * oil;
	s.albedo = vec3( tone ) * mix( vec3( 1.0, 0.98, 0.95 ), vec3( 0.95, 0.98, 1.0 ), mid );
	s.rough = clamp( s.rough, 0.25, 1.0 ); s.ao = clamp( s.ao, 0.0, 1.0 );
	return s;
}`;

const PAINTED = /* glsl */`
Surf surface( vec2 uv ) {
	Surf s; s.metal = 0.0;
	float big = fbm( uv, vec2( 3.0 ), 5, 1.0 ), mid = fbm( uv, vec2( 14.0 ), 4, 2.0 ), fine = fbm( uv, vec2( 110.0 ), 3, 3.0 );
	float peel = fbm( uv, vec2( 190.0 ), 2, 4.0 ); // roller orange-peel
	float roller = fbm( uv, vec2( 40.0, 3.0 ), 3, 5.0 );
	float tone = 0.86 + 0.1 * big + 0.05 * ( roller - 0.5 ) + 0.03 * ( fine - 0.5 );
	// chipped paint: irregular islands, more of them low on the wall and along panel seams
	float seam = min( grid( uv.x, 2.0 ), grid( uv.y, 1.0 ) ) * 4.0;
	float chipN = fbm( uv, vec2( 9.0 ), 5, 7.0 ) * 0.7 + 0.3 * fbm( uv, vec2( 60.0 ), 3, 8.0 );
	float bias = 0.10 * ( 1.0 - smoothstep( 0.0, 0.25, seam ) ) + 0.05 * smoothstep( 0.4, 0.0, uv.y );
	float chip = smoothstep( 0.665, 0.69, chipN + bias );
	float chipEdge = smoothstep( 0.62, 0.665, chipN + bias ) - chip;
	s.mask = 1.0 - chip;
	float groove = 1.0 - smoothstep( 0.003, 0.010, seam );
	// substrate (concrete) under the paint
	float sub = 0.75 + 0.2 * mid + 0.08 * ( fine - 0.5 );
	s.h = 0.0006 * peel + 0.0006 * roller + mix( -0.0016 + 0.0012 * fine, 0.0, s.mask ) + 0.0005 * chipEdge - 0.004 * groove;
	s.rough = mix( 0.92, 0.50 + 0.14 * big + 0.08 * ( peel - 0.5 ), s.mask );
	// grime: streaks from the top and soft dirt patches
	float streak = smoothstep( 0.55, 0.85, fbm( uv, vec2( 80.0, 2.0 ), 3, 31.0 ) ) * smoothstep( 0.4, 0.7, fbm( uv, vec2( 4.0, 2.0 ), 3, 33.0 ) );
	float dirt = smoothstep( 0.5, 0.8, fbm( uv, vec2( 5.0 ), 4, 35.0 ) );
	tone *= 1.0 - 0.16 * streak - 0.1 * dirt - 0.4 * groove; s.rough += 0.1 * dirt + 0.08 * streak;
	s.albedo = mix( vec3( sub ), vec3( tone ) * ( 1.0 - 0.12 * chipEdge ), s.mask );
	s.ao = 1.0 - 0.45 * groove - 0.15 * chip; s.rough = clamp( s.rough, 0.25, 1.0 );
	return s;
}`;

const CORRUGATED = /* glsl */`
Surf surface( vec2 uv ) {
	Surf s;
	// 32 trapezoid ribs across the tile (12.5 cm pitch), running vertically
	float x = fract( uv.x * 32.0 ); float tri = abs( x - 0.5 ) * 2.0; float rib = smoothstep( 0.28, 0.62, tri );
	float big = fbm( uv, vec2( 3.0 ), 5, 1.0 ), mid = fbm( uv, vec2( 12.0 ), 4, 2.0 ), fine = fbm( uv, vec2( 100.0 ), 3, 3.0 );
	float tone = 0.84 + 0.12 * big + 0.04 * ( fine - 0.5 );
	// long horizontal scrapes and small dents
	float scr = smoothstep( 0.72, 0.8, fbm( uv, vec2( 3.0, 150.0 ), 2, 5.0 ) ) * smoothstep( 0.45, 0.7, fbm( uv, vec2( 3.0, 6.0 ), 3, 6.0 ) ) * ( 0.4 + 0.6 * rib );
	// rust: blooms on the rib crests + streaks running down from them
	float rustN = fbm( uv, vec2( 7.0 ), 5, 7.0 ) * 0.72 + 0.28 * fbm( uv, vec2( 70.0 ), 3, 8.0 );
	float rust = smoothstep( 0.63, 0.70, rustN + 0.04 * rib + 0.07 * smoothstep( 0.25, 0.0, uv.y ) + 0.06 * smoothstep( 0.8, 1.0, uv.y ) );
	float run = smoothstep( 0.6, 0.85, fbm( uv, vec2( 90.0, 2.0 ), 3, 9.0 ) ) * smoothstep( 0.45, 0.7, fbm( uv, vec2( 6.0, 2.0 ), 3, 10.0 ) );
	float bare = clamp( rust + scr * 0.9, 0.0, 1.0 );
	s.mask = 1.0 - bare;
	s.h = 0.018 * rib + 0.0004 * fine + 0.0015 * ( mid - 0.5 ) - 0.0006 * bare + 0.0008 * rust * fine;
	float dirt = ( 1.0 - rib ) * 0.12 + 0.1 * smoothstep( 0.5, 0.8, mid );
	tone *= 1.0 - dirt - 0.18 * run;
	// albedo where the paint is gone: orange-brown rust texture (not tinted)
	vec3 rustCol = mix( vec3( 0.33, 0.13, 0.05 ), vec3( 0.58, 0.29, 0.11 ), fine ) * ( 0.7 + 0.5 * mid );
	rustCol = mix( rustCol, vec3( 0.55, 0.56, 0.58 ), clamp( scr * 1.2 - rust, 0.0, 1.0 ) ); // fresh scrapes show steel
	s.albedo = mix( rustCol, vec3( tone ), s.mask );
	s.rough = mix( 0.88, 0.42 + 0.16 * big + 0.1 * dirt, s.mask ); s.rough = mix( s.rough, 0.4, clamp( scr - rust, 0.0, 1.0 ) );
	s.metal = clamp( scr * 1.2 - rust, 0.0, 1.0 ) * 0.8;
	s.ao = 1.0 - 0.3 * ( 1.0 - rib ) * ( 1.0 - smoothstep( 0.0, 0.3, tri ) ) - 0.15 * ( 1.0 - rib );
	return s;
}`;

const METAL = /* glsl */`
Surf surface( vec2 uv ) {
	Surf s; s.mask = 1.0;
	float brush = fbm( uv, vec2( 4.0, 420.0 ), 3, 1.0 ), brush2 = fbm( uv, vec2( 16.0, 900.0 ), 2, 2.0 );
	float big = fbm( uv, vec2( 3.0 ), 5, 3.0 ), mid = fbm( uv, vec2( 14.0 ), 4, 4.0 );
	float smudge = smoothstep( 0.45, 0.8, fbm( uv, vec2( 6.0 ), 4, 5.0 ) );
	// sheet seams every 1 m with rivets every 25 cm
	float seam = min( grid( uv.x, 4.0 ), grid( uv.y, 4.0 ) ) * 4.0; float groove = 1.0 - smoothstep( 0.003, 0.008, seam );
	vec2 rp = fract( uv * 16.0 ) - 0.5; float nearSeam = 1.0 - smoothstep( 0.05, 0.07, abs( seam - 0.06 ) + 0.05 );
	float rv = ( 1.0 - smoothstep( 0.04, 0.07, length( rp ) ) ) * step( seam, 0.125 ) * step( 0.03, seam );
	float tone = 0.80 + 0.14 * ( brush - 0.5 ) + 0.1 * ( brush2 - 0.5 ) + 0.1 * ( big - 0.5 );
	tone *= 1.0 - 0.5 * groove - 0.12 * smudge + 0.12 * rv;
	s.h = 0.0003 * brush + 0.0002 * brush2 - 0.003 * groove + 0.003 * rv + 0.0006 * ( mid - 0.5 );
	s.rough = 0.36 + 0.2 * ( brush - 0.5 ) + 0.22 * smudge + 0.1 * ( big - 0.5 ) + 0.3 * groove;
	float corr = smoothstep( 0.68, 0.8, fbm( uv, vec2( 20.0 ), 4, 9.0 ) + 0.08 * groove );
	s.albedo = mix( vec3( tone ), vec3( 0.5, 0.33, 0.22 ) * ( 0.7 + 0.5 * mid ), corr * 0.7 );
	s.rough = clamp( mix( s.rough, 0.85, corr * 0.8 ), 0.15, 1.0 ); s.metal = 1.0 - 0.8 * corr - 0.5 * groove;
	s.ao = 1.0 - 0.5 * groove;
	return s;
}`;

const SURFACES = { concrete: CONCRETE, asphalt: ASPHALT, painted: PAINTED, corrugated: CORRUGATED, metal: METAL };
const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }';

export function createTexGen(renderer, size = 1024) {
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null); quad.frustumCulled = false; scene.add(quad);
  const heightRT = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const temp = [];
  const out = (srgb) => {
    const t = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, anisotropy: aniso, colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace });
    return t;
  };
  const draw = (material, target) => {
    quad.material = material;
    const prev = renderer.getRenderTarget(), tm = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(target); renderer.render(scene, cam); renderer.setRenderTarget(prev);
    renderer.toneMapping = tm; temp.push(material);
  };
  const normalMat = new THREE.ShaderMaterial({
    uniforms: { tH: { value: heightRT.texture }, uTexel: { value: 1 / size }, uTile: { value: 4 } },
    vertexShader: VERT, depthTest: false,
    fragmentShader: /* glsl */`
      precision highp float; varying vec2 vUv; uniform sampler2D tH; uniform float uTexel; uniform float uTile;
      float H( vec2 o ) { return texture2D( tH, vUv + o * uTexel ).r; }
      void main() {
        float dx = ( H( vec2( 1, -1 ) ) + 2.0 * H( vec2( 1, 0 ) ) + H( vec2( 1, 1 ) ) - H( vec2( -1, -1 ) ) - 2.0 * H( vec2( -1, 0 ) ) - H( vec2( -1, 1 ) ) ) / 8.0;
        float dy = ( H( vec2( -1, 1 ) ) + 2.0 * H( vec2( 0, 1 ) ) + H( vec2( 1, 1 ) ) - H( vec2( -1, -1 ) ) - 2.0 * H( vec2( 0, -1 ) ) - H( vec2( 1, -1 ) ) ) / 8.0;
        float metresPerTexel = uTile * uTexel;
        vec3 n = normalize( vec3( - dx / metresPerTexel, - dy / metresPerTexel, 1.0 ) );
        gl_FragColor = vec4( n * 0.5 + 0.5, 1.0 );
      }`,
  });

  return {
    size,
    // -> { map, normalMap, orm }
    make(kind, { seed = 0, uniforms = {}, normalStrength = 1 } = {}) {
      const src = SURFACES[kind];
      const u = { uSeed: { value: seed } }; for (const k in uniforms) u[k] = { value: uniforms[k] };
      const pass = (body) => new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, depthTest: false, fragmentShader: `${LIB}\n${src}\nvoid main(){ Surf s = surface( vUv ); ${body} }` });
      const albedo = out(true), normal = out(false), orm = out(false);
      draw(pass(`gl_FragColor = vec4( s.h * ${normalStrength.toFixed(3)}, 0.0, 0.0, 1.0 );`), heightRT);
      draw(pass('gl_FragColor = vec4( pow( clamp( s.albedo, 0.0, 1.0 ), vec3( 2.2 ) ), s.mask );'), albedo);
      draw(pass('gl_FragColor = vec4( s.ao, s.rough, s.metal, 1.0 );'), orm);
      draw(normalMat, normal); temp.pop();
      return { map: albedo.texture, normalMap: normal.texture, orm: orm.texture };
    },
    dispose() { heightRT.dispose(); normalMat.dispose(); temp.forEach((m) => m.dispose()); quad.geometry.dispose(); },
  };
}
