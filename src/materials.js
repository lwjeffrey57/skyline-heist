import * as THREE from 'three';
import { createTexGen } from './visuals/texgen.js';
import { getNoiseTexture } from './visuals/sky.js';

// Material library. world.js looks materials up by these key names, so keep every
// existing key (concrete, concreteDark, slab, ground, teal, amber, cream, navy, rust,
// metal, glowAmber, glowTeal, paint, far). Box UVs are in metres / 4 (one tile = 4 m).
//
// Every surface is a procedural PBR set (albedo + normal + AO/roughness/metalness, see visuals/texgen.js)
// plus a small shader extension shared by all of them:
//   * world-space macro variation, so the 4 m tiles never read as a repeating pattern
//   * box-edge effects (soft bevel normal, worn edges, chipped paint) driven by the optional `aFace`
//     vertex attribute (face size in metres) that decor.js adds to the level's boxes
//   * layered paint: the albedo alpha is a paint mask; where it is 0 the substrate colour shows
//   * ground: puddles / damp patches, walls: grime near the floor
// Extra keys: containerRust/Navy/Teal/Amber/Cream (corrugated steel), trim, glowWarm, glowWhite.
// materials.containerFor(mat) maps a wall paint material to its container counterpart.

const shared = { uMacro: { value: null } };

const VERT_PARS = /* glsl */`
attribute vec2 aFace;
varying vec2 vFace;
varying vec3 vWPos;
`;
const VERT_MAIN = /* glsl */`
vFace = aFace;
vec4 sWP = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	sWP = instanceMatrix * sWP;
#endif
vWPos = ( modelMatrix * sWP ).xyz;
`;
const FRAG_PARS = /* glsl */`
uniform sampler2D uMacro;
uniform vec3 uUnder;
varying vec2 vFace;
varying vec3 vWPos;
`;
const FRAG_COLOR = /* glsl */`
vec2 sMc = vWPos.xz * 0.037 + vWPos.y * vec2( 0.029, 0.041 );
vec4 sM1 = texture2D( uMacro, sMc );
vec4 sM2 = texture2D( uMacro, sMc * 0.21 + 0.37 );
float sVar = sM1.r * 0.55 + sM2.g * 0.45;
float sEdge = 1000.0; vec2 sBev = vec2( 0.0 );
#ifdef USE_MAP
if ( vFace.x > 0.0 ) {
	vec2 sLo = vMapUv * 4.0, sHi = vFace - sLo;
	sEdge = max( min( min( sLo.x, sLo.y ), min( sHi.x, sHi.y ) ), 0.0 );
	sBev = smoothstep( vec2( 0.022 ), vec2( 0.0 ), sHi ) - smoothstep( vec2( 0.022 ), vec2( 0.0 ), sLo );
}
float sWearN = sM1.b * 0.55 + texture2D( uMacro, vMapUv * 2.3 ).a * 0.45;
float sPaint = 1.0;
#ifdef SURF_PAINT
	sPaint = sampledDiffuseColor.a;
	sPaint *= smoothstep( 0.0, 0.25, sEdge / 0.07 + sWearN * 1.5 - 0.72 );
	#ifdef SURF_WORN
		sPaint *= smoothstep( 0.20, 0.30, sM1.g * 0.5 + sWearN * 0.5 + 0.1 * sampledDiffuseColor.r );
	#endif
	diffuseColor.rgb = mix( sampledDiffuseColor.rgb * uUnder, diffuseColor.rgb, sPaint );
	// paint has thickness: a dark undercut just outside the flake and a pale, lifted lip just inside it
	float sLip = sPaint * ( 1.0 - sPaint ) * 4.0;
	diffuseColor.rgb *= 1.0 - 0.45 * sLip * step( sPaint, 0.5 ) + 0.22 * sLip * step( 0.5, sPaint );
#endif
// close-up micro variation (fades out a few metres away): fine mottling so walls hold up at eye level
float sNear = 1.0 - smoothstep( 3.0, 11.0, length( vViewPosition ) );
vec4 sMic = texture2D( uMacro, vMapUv * 5.7 + sM1.rg * 0.15 );
diffuseColor.rgb *= 1.0 + sNear * ( ( sMic.r - 0.5 ) * 0.16 + ( sMic.b - 0.5 ) * 0.10 * sM1.a );
float sFrame = 0.0;
#ifdef SURF_FRAME
	sFrame = smoothstep( 0.115, 0.10, sEdge );
	diffuseColor.rgb *= 1.0 - 0.22 * sFrame - 0.5 * smoothstep( 0.02, 0.0, abs( sEdge - 0.115 ) );
#endif
// exposed edges are scuffed lighter, and the whole surface drifts in tone across the level
diffuseColor.rgb *= 1.0 + 0.16 * smoothstep( 0.03, 0.0, sEdge ) * sWearN;
diffuseColor.rgb *= 0.80 + 0.40 * sVar;
#ifdef SURF_GRIME
	float sGrime = smoothstep( 1.3, 0.0, vWPos.y ) * ( 0.25 + 0.75 * sM1.a );
	diffuseColor.rgb *= 1.0 - 0.42 * sGrime;
#endif
float sWet = 0.0, sDamp = 0.0;
#ifdef SURF_WET
	float sW = sM2.a * 0.7 + sM1.g * 0.3 - 0.05 * sampledDiffuseColor.r;
	sWet = smoothstep( 0.555, 0.60, sW ); sDamp = smoothstep( 0.44, 0.57, sW );
	diffuseColor.rgb *= 1.0 - 0.28 * sDamp - 0.22 * sWet;
#endif
#endif
`;
const FRAG_ROUGH = /* glsl */`
#ifdef USE_MAP
	roughnessFactor = clamp( roughnessFactor + ( sVar - 0.5 ) * 0.22 + ( sMic.g - 0.5 ) * 0.18 * sNear, 0.04, 1.0 );
	#ifdef SURF_PAINT
		roughnessFactor = mix( 0.92, roughnessFactor, sPaint );
	#endif
	#ifdef SURF_GRIME
		roughnessFactor = mix( roughnessFactor, 0.95, sGrime * 0.6 );
	#endif
	#ifdef SURF_WET
		roughnessFactor = mix( mix( roughnessFactor, 0.45, sDamp * 0.6 ), 0.05, sWet );
	#endif
#endif
`;
const FRAG_NORMAL = /* glsl */`
#if defined( USE_NORMALMAP_TANGENTSPACE )
	vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	mapN.xy *= normalScale;
	#ifdef USE_MAP
		// detail normal: the same map again at ~6x the frequency, only near the camera
		vec2 sDetN = texture2D( normalMap, vNormalMapUv * 6.3 + 0.37 ).xy * 2.0 - 1.0;
		mapN.xy += sDetN * ( 0.55 * sNear * normalScale.x );
		mapN.xy *= ( 1.0 - 0.95 * sWet ) * ( 1.0 - sFrame );
		mapN.xy += sBev * 0.85;
	#endif
	normal = normalize( tbn * mapN );
#endif
`;

function extend(material, { paint = false, worn = false, grime = false, wet = false, frame = false, under = 0x7d7a74 } = {}) {
  material.defines = material.defines || {};
  if (paint) material.defines.SURF_PAINT = '';
  if (worn) material.defines.SURF_WORN = '';
  if (grime) material.defines.SURF_GRIME = '';
  if (wet) material.defines.SURF_WET = '';
  if (frame) material.defines.SURF_FRAME = '';
  const uUnder = { value: new THREE.Color(under) };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMacro = shared.uMacro; shader.uniforms.uUnder = uUnder;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_COLOR}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${FRAG_ROUGH}`)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL);
  };
  return material;
}

export function createMaterials(renderer) {
  const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('q');
  const gen = createTexGen(renderer, q === 'low' ? 512 : 1024);
  shared.uMacro.value = getNoiseTexture();

  const T = {
    concrete: gen.make('concrete', { seed: 1, uniforms: { uKind: 0 }, normalStrength: 1.6 }),
    slab: gen.make('concrete', { seed: 40, uniforms: { uKind: 1 }, normalStrength: 1.3 }),
    asphalt: gen.make('asphalt', { seed: 3, normalStrength: 1.1 }),
    painted: gen.make('painted', { seed: 5, normalStrength: 1.5 }),
    corrugated: gen.make('corrugated', { seed: 7, normalStrength: 1.0 }),
    metal: gen.make('metal', { seed: 9, normalStrength: 1.2 }),
  };
  gen.dispose();

  const surf = (set, color, { roughness = 1, metalness = 0, metalMap = false, ao = 1, normal = 1, ...ext } = {}) => {
    const c = new THREE.Color(color);
    const m = new THREE.MeshStandardMaterial({
      color: c, roughness, metalness, map: set.map, normalMap: set.normalMap, normalScale: new THREE.Vector2(normal, normal),
      roughnessMap: set.orm, aoMap: set.orm, aoMapIntensity: ao, metalnessMap: metalMap ? set.orm : null,
    });
    return extend(m, ext);
  };
  const bright = (hex, k) => new THREE.Color(hex).multiplyScalar(k);
  const paintWall = (hex) => surf(T.painted, bright(hex, 1.25), { paint: true, grime: true, under: 0x8a867f });
  const container = (hex) => surf(T.corrugated, bright(hex, 1.2), { paint: true, frame: true, grime: true, metalMap: true, metalness: 1, under: 0xffffff });

  const M = {
    concrete: surf(T.concrete, bright(0xb9b4aa, 1.2), { grime: true }),
    concreteDark: surf(T.concrete, bright(0x6f6e6c, 1.15), { grime: true }),
    slab: surf(T.slab, bright(0x8e8a83, 1.2), {}),
    ground: surf(T.asphalt, bright(0x3b3d40, 1.5), { wet: true }),
    teal: paintWall(0x1f8a8c),
    amber: paintWall(0xd98a1f),
    cream: paintWall(0xe6dcc6),
    navy: paintWall(0x24364f),
    rust: paintWall(0x9c4a2a),
    metal: surf(T.metal, 0x8b9199, { metalness: 1, metalMap: true, roughness: 1 }),
    glowAmber: new THREE.MeshStandardMaterial({ color: 0x1a1206, emissive: 0xffa53a, emissiveIntensity: 5 }),
    glowTeal: new THREE.MeshStandardMaterial({ color: 0x06181a, emissive: 0x35e0d8, emissiveIntensity: 5 }),
    paint: surf(T.painted, 0xf2ecda, { paint: true, worn: true, under: 0x33353a, roughness: 0.9 }),
    far: new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 1 }),
    // ---- additions ----
    containerRust: container(0x9c4a2a),
    containerNavy: container(0x24364f),
    containerTeal: container(0x1f8a8c),
    containerAmber: container(0xd98a1f),
    containerCream: container(0xe6dcc6),
    trim: surf(T.metal, 0x3a3e45, { metalness: 1, metalMap: true, roughness: 1.15 }),
    glowWarm: new THREE.MeshStandardMaterial({ color: 0x1a1206, emissive: 0xffc98a, emissiveIntensity: 7 }),
    glowWhite: new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xfff1dc, emissiveIntensity: 9 }),
  };
  const pairs = new Map([[M.rust, M.containerRust], [M.navy, M.containerNavy], [M.teal, M.containerTeal], [M.amber, M.containerAmber], [M.cream, M.containerCream]]);
  Object.defineProperty(M, 'containerFor', { value: (mat) => pairs.get(mat) || M.containerRust, enumerable: false });
  Object.defineProperty(M, 'textures', { value: T, enumerable: false });
  return M;
}
