import * as THREE from 'three';

// Global lighting model. Patches three's ShaderChunk ONCE (before any material compiles) so that every
// lit material in the game -- including ones created by other systems -- gets:
//
//   * cascaded sun shadows: the shadow-casting DirectionalLights are treated as cascades of ONE sun.
//     Only the first one lights the surface; its shadow comes from the tightest cascade that contains
//     the fragment (cross-faded into the next one), filtered with a rotated Vogel disc.
//   * sky occlusion: the LAST shadow-casting DirectionalLight points straight down and never lights
//     anything; its shadow map says "is there a roof above this point" and scales ambient / IBL, so
//     interiors are dark and warm instead of being lit by the open sky.
//   * analytic height fog with sun in-scatter, replacing the stock fog chunks.
//
// Convention (see createSunRig): shadow-casting directional lights = [cascade 0 .. cascade N-1, sky].
// Directional lights that do not cast shadows behave normally.

let patched = false;

export function patchShaderChunks(sunDir, opts = {}) {
  if (patched) return; patched = true;
  const C = THREE.ShaderChunk;
  const f = (v) => v.toFixed(5);
  const fogFalloff = opts.fogFalloff ?? 0.03;
  const sunFog = opts.sunFogColor ?? new THREE.Color(1.0, 0.62, 0.3);
  const VM = { rim: new THREE.Color(0.80, 0.90, 1.0).multiplyScalar(opts.vmRim ?? 1.5), key: new THREE.Color(1.0, 0.95, 0.88).multiplyScalar(opts.vmKey ?? 0.6) };

  // ---- shadows --------------------------------------------------------------
  C.shadowmap_pars_fragment += /* glsl */`
#ifdef USE_SHADOWMAP
	const vec2 csmDisc[10] = vec2[10](
		vec2( 0.2236, 0.0000 ), vec2( -0.2856, 0.2616 ), vec2( 0.0437, -0.4981 ), vec2( 0.3601, 0.4638 ), vec2( -0.6665, -0.0731 ),
		vec2( 0.6226, -0.4005 ), vec2( -0.1554, 0.7909 ), vec2( -0.4179, -0.7604 ), vec2( 0.8759, 0.2685 ), vec2( -0.8873, 0.4144 ) );
	float csmNoise( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
	// depth slope of the receiver in shadow-map space, so every tap is compared against the receiver plane
	vec2 csmSlope( vec3 sc ) {
		vec3 dx = dFdx( sc ), dy = dFdy( sc );
		float det = dx.x * dy.y - dx.y * dy.x;
		if ( abs( det ) < 1e-14 ) return vec2( 0.0 );
		return vec2( dy.y * dx.z - dx.y * dy.z, dx.x * dy.z - dy.x * dx.z ) / det;
	}
	float csmFilter( sampler2D map, vec2 mapSize, float bias, float radius, vec3 sc, mat2 rot, vec2 slope, int taps ) {
		float z = sc.z + bias;
		vec2 r = radius / mapSize, o;
		float s = 0.0;
		for ( int k = 0; k < taps; k ++ ) {
			o = rot * csmDisc[ k ] * r;
			s += step( z + clamp( dot( slope, o ), - 0.0012, 0.0012 ), unpackRGBAToDepth( textureLod( map, sc.xy + o, 0.0 ) ) );
		}
		return s / float( taps );
	}
#endif
`;

  const dirLoop = /* glsl */`
float csmSkyVis = 1.0, csmSkyWide = 1.0;
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	DirectionalLight directionalLight;
	float csmSun = 1.0;

	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	if ( receiveShadow ) {
		// light.shadow.intensity is not used as an intensity: it carries the quality switch (>0.75 = 10 taps)
		// and, when temporal AA is running, a per-frame phase that turns the filter noise over
		float csmQ = directionalLightShadows[ 0 ].shadowIntensity;
		bool csmHigh = csmQ > 0.75;
		int csmTaps = csmHigh ? 10 : 5;
		float csmA = fract( csmNoise( gl_FragCoord.xy ) + ( ( csmHigh ? 1.0 : 0.5 ) - csmQ ) * 5.0 ) * 6.2831853;
		mat2 csmRot = mat2( cos( csmA ), sin( csmA ), - sin( csmA ), cos( csmA ) );
		float csmAcc = 0.0, csmLeft = 1.0;
		vec3 csmC; vec2 csmD; vec2 csmS; float csmW;
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {

			directionalLightShadow = directionalLightShadows[ i ];
			csmC = vDirectionalShadowCoord[ i ].xyz / vDirectionalShadowCoord[ i ].w;
			csmD = abs( csmC.xy - 0.5 );
			csmS = csmSlope( csmC );
			#if ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS - 1 )
			if ( csmLeft > 0.001 ) {
				csmW = ( 1.0 - smoothstep( 0.44, 0.49, max( csmD.x, csmD.y ) ) ) * step( csmC.z, 1.0 ) * csmLeft;
				if ( csmW > 0.001 ) {
					csmAcc += csmW * csmFilter( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, csmC, csmRot, csmS, csmTaps );
					csmLeft -= csmW;
				}
			}
			#else
			if ( max( csmD.x, csmD.y ) < 0.5 && csmC.z < 1.0 ) {
				csmSkyVis = csmFilter( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, csmC, csmRot, csmS, csmTaps );
				// a much wider lookup = "how close is open sky": gives interiors a gradient towards doors and windows
				csmSkyWide = csmHigh ? csmFilter( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius * 4.5, csmC, csmRot, vec2( 0.0 ), 5 ) : csmSkyVis;
			}
			#endif

		}
		#pragma unroll_loop_end
		csmSun = csmAcc + csmLeft;
	}
	#endif

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

		#if ( UNROLLED_LOOP_INDEX == 0 ) || ( UNROLLED_LOOP_INDEX >= NUM_DIR_LIGHT_SHADOWS )
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if ( UNROLLED_LOOP_INDEX == 0 ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )
		directLight.color *= csmSun;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		#endif

	}
	#pragma unroll_loop_end

	// first-person viewmodel (see csmVM): a cool rim from beyond the gun and a soft key over the shoulder,
	// fixed to the camera, so its form reads in shade and against a bright sky
	if ( csmVM ) {
		float csmVmK = mix( 0.5, 1.0, csmSkyVis ) * ( 0.55 + 0.45 * csmSun );
		directLight.visible = true;
		directLight.direction = vec3( - 0.72, 0.42, - 0.55 );
		directLight.color = vec3( ${f(VM.rim.r)}, ${f(VM.rim.g)}, ${f(VM.rim.b)} ) * csmVmK;
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		directLight.direction = vec3( 0.50, 0.62, 0.60 );
		directLight.color = vec3( ${f(VM.key.r)}, ${f(VM.key.g)}, ${f(VM.key.b)} ) * csmVmK;
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}

#endif
`;
  const src0 = C.lights_fragment_begin;
  // viewmodel test: weapons squash their depth to < 0.1 so they never clip into walls; nothing else gets that close.
  // Lights that sit almost inside the gun (muzzle flash) are capped on it so it does not clip to white.
  const src = ( '\nbool csmVM = gl_FragCoord.z < 0.1;\n' + src0 ).replace( 'getPointLightInfo( pointLight, geometryPosition, directLight );', 'getPointLightInfo( pointLight, geometryPosition, directLight );\n\t\tif ( csmVM ) directLight.color = min( directLight.color, vec3( 1.6 ) );' );
  const a = src.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const b = src.indexOf('#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )');
  if (a < 0 || b < 0) { console.warn('[lighting] unexpected three.js shader layout, cascades disabled'); return; }
  C.lights_fragment_begin = src.slice(0, a) + dirLoop + src.slice(b);

  // Interiors: ambient and reflections fade to a dim, warm "bounce" term under a roof.
  C.lights_fragment_end += /* glsl */`
#if defined( RE_IndirectDiffuse )
	{
		float csmNy = inverseTransformDirection( geometryNormal, viewMatrix ).y;
		// under a roof: dim fill that brightens towards openings, plus warm light bounced up from sunlit floor
		vec3 csmIn = vec3( 0.25, 0.225, 0.2 ) * ( 0.5 + 1.5 * csmSkyWide ) + vec3( 0.20, 0.14, 0.085 ) * csmSkyWide * ( 0.75 - 0.5 * csmNy );
		// in the open: surfaces facing the ground pick up sun-coloured bounce
		vec3 csmOut = vec3( 1.0 ) + vec3( 0.34, 0.20, 0.06 ) * ( 0.5 - 0.5 * csmNy );
		vec3 csmAmb = mix( csmIn, csmOut, csmSkyVis );
		if ( csmVM ) csmAmb = max( csmAmb, vec3( 0.55 ) );
		reflectedLight.indirectDiffuse *= csmAmb;
	}
#endif
#if defined( RE_IndirectSpecular )
	reflectedLight.indirectSpecular *= mix( csmVM ? 0.55 : 0.10 + 0.14 * csmSkyWide, 1.0, csmSkyVis );
#endif
`;

  // specular anti-aliasing: widen roughness by the screen-space variation of the SHADED normal (normal maps
  // included), so fine normal detail does not sparkle
  C.lights_physical_fragment = C.lights_physical_fragment.replace(
    'vec3 dxy = max( abs( dFdx( nonPerturbedNormal ) ), abs( dFdy( nonPerturbedNormal ) ) );',
    'vec3 dxy = max( abs( dFdx( normal ) ), abs( dFdy( normal ) ) ) * 1.25;');

  // ---- height fog -----------------------------------------------------------
  C.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorld;
#endif
`;
  C.fog_vertex = /* glsl */`
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorld = ( mvPosition.xyz - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
#endif
`;
  C.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorld;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
`;
  C.fog_fragment = /* glsl */`
#ifdef USE_FOG
	#ifdef FOG_EXP2
		vec3 fogRay = vFogWorld - cameraPosition;
		float fogLen = length( fogRay );
		float fogT = ${f(fogFalloff)} * fogRay.y;
		float fogInt = abs( fogT ) > 0.001 ? ( 1.0 - exp( - fogT ) ) / fogT : 1.0 - 0.5 * fogT;
		float fogOD = fogDensity * exp( - ${f(fogFalloff)} * cameraPosition.y ) * fogLen * fogInt;
		float fogFactor = 1.0 - exp( - fogOD );
		float fogSun = max( dot( fogRay / max( fogLen, 0.0001 ), vec3( ${f(sunDir.x)}, ${f(sunDir.y)}, ${f(sunDir.z)} ) ), 0.0 );
		vec3 fogCol = fogColor + vec3( ${f(sunFog.r)}, ${f(sunFog.g)}, ${f(sunFog.b)} ) * ( pow( fogSun, 6.0 ) * 0.55 + pow( fogSun, 48.0 ) * 0.9 );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogCol, fogFactor );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
	#endif
#endif
`;
}

// Sun cascades + the downward "sky occlusion" light.
export function createSunRig(scene, sunDir, { color = 0xffe2bd, intensity = 3.4 } = {}) {
  const RANGE = 420, DIST = 210;
  const cascades = [
    { half: 13, fixed: false },
    { half: 42, fixed: false },
    { half: 104, fixed: true },
  ];
  const lights = cascades.map((c) => {
    const l = new THREE.DirectionalLight(color, intensity);
    l.castShadow = true;
    Object.assign(l.shadow.camera, { left: -c.half, right: c.half, top: c.half, bottom: -c.half, near: 1, far: RANGE });
    l.shadow.camera.updateProjectionMatrix();
    l.position.copy(sunDir).multiplyScalar(DIST);
    scene.add(l, l.target);
    return l;
  });
  // straight down, covers the arena; never lights anything (see shader patch)
  const sky = new THREE.DirectionalLight(0x000000, 0);
  sky.castShadow = true;
  const SKY_HALF = 108; // covers the whole site, outer ring included
  Object.assign(sky.shadow.camera, { left: -SKY_HALF, right: SKY_HALF, top: SKY_HALF, bottom: -SKY_HALF, near: 1, far: 80 });
  sky.shadow.camera.updateProjectionMatrix();
  sky.position.set(0, 70, 0); sky.target.position.set(0, 0, 0);
  scene.add(sky, sky.target);
  sky.shadow.autoUpdate = false; sky.shadow.needsUpdate = true;
  lights[2].shadow.autoUpdate = false; lights[2].shadow.needsUpdate = true;

  // light-space basis for texel snapping
  const lz = sunDir.clone().normalize();
  const lx = new THREE.Vector3(0, 1, 0).cross(lz).normalize();
  const ly = lz.clone().cross(lx).normalize();
  const fwd = new THREE.Vector3(), c = new THREE.Vector3();

  const rig = {
    sun: lights[0], lights, sky, cascades, frame: 0, farEvery: 2, skyEvery: 6, softness: 0.05,
    highTaps: true, temporal: false,
    setTaps(high) { rig.highTaps = high; },
    setMapSize(size, skySize) {
      lights.forEach((l) => {
        l.shadow.mapSize.set(size, size);
        if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
        l.shadow.needsUpdate = true;
      });
      sky.shadow.mapSize.set(skySize, skySize);
      if (sky.shadow.map) { sky.shadow.map.dispose(); sky.shadow.map = null; }
      sky.shadow.needsUpdate = true;
      // filter radius (texels) for a constant world-space penumbra, plus matching biases
      cascades.forEach((cd, i) => {
        const texel = (cd.half * 2) / size;
        const world = Math.max(rig.softness * (1 + i * 0.6), texel * 1.3);
        const s = lights[i].shadow;
        s.radius = world / texel;
        s.normalBias = texel * 1.0;
        s.bias = -(0.012 + texel * 0.8) / RANGE;
      });
      const st = (SKY_HALF * 2) / skySize;
      sky.shadow.radius = 0.9 / st;
      sky.shadow.normalBias = 1.0; // push the lookup off the surface so outside walls see the sky and inside walls stay under the roof
      sky.shadow.bias = -0.12 / 79;
    },
    markDirty() { sky.shadow.needsUpdate = true; lights[2].shadow.needsUpdate = true; },
    update(camera) {
      rig.frame++;
      // see the shader: quality switch + temporal noise phase share this uniform
      const phase = rig.temporal ? ((rig.frame * 0.61803398875) % 1) * 0.95 : 0;
      lights[0].shadow.intensity = (rig.highTaps ? 1 : 0.5) - phase * 0.2;
      camera.getWorldDirection(fwd); fwd.y = 0; if (fwd.lengthSq() > 1e-6) fwd.normalize();
      for (let i = 0; i < lights.length; i++) {
        const cd = cascades[i], l = lights[i];
        if (cd.fixed) { c.set(0, 0, 0); } else {
          c.copy(camera.position).addScaledVector(fwd, cd.half * 0.55);
          // snap to shadow texels so the map does not shimmer as the camera moves
          const texel = (cd.half * 2) / l.shadow.mapSize.x;
          const px = Math.round(c.dot(lx) / texel) * texel, py = Math.round(c.dot(ly) / texel) * texel, pz = c.dot(lz);
          c.set(0, 0, 0).addScaledVector(lx, px).addScaledVector(ly, py).addScaledVector(lz, pz);
        }
        l.target.position.copy(c);
        l.position.copy(c).addScaledVector(lz, DIST);
        l.target.updateMatrixWorld(); l.updateMatrixWorld();
      }
      if (rig.frame % rig.farEvery === 0) lights[2].shadow.needsUpdate = true;
      if (rig.frame % rig.skyEvery === 1) sky.shadow.needsUpdate = true;
    },
  };
  rig.setMapSize(2048, 1024);
  return rig;
}
