import * as THREE from 'three';

// Lens materials for the weapon optics. Both draw their reticle "at infinity": it is computed from the
// direction of the view ray through each lens pixel, not painted on the glass, so it stays on the aim point,
// has no parallax and is clipped by the lens housing exactly like a real collimated sight.

const VERT = /* glsl */`
varying vec3 vView; varying vec2 vUv;
void main() {
	vec4 mv = modelViewMatrix * vec4( position, 1.0 );
	vView = mv.xyz; vUv = uv;
	gl_Position = projectionMatrix * mv;
	gl_Position.z = mix( gl_Position.z, - gl_Position.w, 0.9 ); // same depth squash as the rest of the viewmodel
}`;

const base = (uniforms, fragmentShader) => new THREE.ShaderMaterial({
  uniforms, vertexShader: VERT, fragmentShader, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, // premultiplied
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
});

// Reflex / red-dot window. uAxis = where the sight points, as a tangent-plane offset from the view centre
// (in viewmodel space, i.e. before the viewmodel FOV correction uK).
// ring: 0 = dot only, 1 = holographic ring with four ticks around the dot.
export function redDotLens(color = 0xff2a1a, ring = 0) {
  return base({
    uAxis: { value: new THREE.Vector2() }, uK: { value: 1 }, uColor: { value: new THREE.Color(color) }, uBright: { value: 1 }, uRing: { value: ring },
  }, /* glsl */`
uniform vec2 uAxis; uniform float uK; uniform vec3 uColor; uniform float uBright; uniform float uRing;
varying vec3 vView; varying vec2 vUv;
void main() {
	vec2 t = vView.xy / ( - vView.z * uK );
	vec2 e = t - uAxis;
	float d = length( e ), fw = fwidth( d ) * 1.2;
	float dotI = 1.0 - smoothstep( 0.0025 - fw, 0.0025 + fw, d ); // small crisp dot
	float ring = 1.0 - smoothstep( 0.0007, 0.0007 + fw, abs( d - 0.0172 ) );
	// four ticks on the ring
	vec2 ae = abs( e );
	float tick = ( 1.0 - smoothstep( 0.0006, 0.0006 + fw, min( ae.x, ae.y ) ) ) * step( 0.0172, d ) * ( 1.0 - smoothstep( 0.0215, 0.0215 + fw, d ) );
	float I = clamp( dotI + ( ring + tick ) * uRing * 0.85, 0.0, 1.0 );
	float halo = exp( - d * d / 0.000012 ) * 0.22; // emitter bloom around the dot
	// glass: faint coating tint, stronger toward the edges, plus a soft diagonal reflection band
	vec2 p = vUv * 2.0 - 1.0;
	float edge = smoothstep( 0.55, 1.0, max( abs( p.x ), abs( p.y ) ) );
	float band = smoothstep( 0.25, 0.0, abs( p.x * 0.6 + p.y - 0.55 ) ) * 0.05;
	float a = 0.02 + edge * 0.06 + band * 0.4; // clean glass, faint coating
	vec3 glass = mix( vec3( 0.25, 0.42, 0.5 ), vec3( 0.55, 0.3, 0.2 ), edge ) * a * 0.6;
	vec3 col = glass + uColor * ( I * 3.0 + halo ) * uBright;
	gl_FragColor = vec4( col, a + I * 0.5 );
}`);
}

// Telescopic sight eyepiece. Opaque dark glass until the eye is on axis (uOpen), then a clear picture with a
// fine mil reticle and the black "scope shadow" that slides around when the rifle moves (uShadow, lens units).
// style: 0 = fine mil cross (LONGHAND), 1 = chevron with drop bars (2.5x prism), 2 = duplex posts around an open circle (4x)
export function scopeLens(style = 0, glow = 0xff2a1a) {
  return base({
    uOpen: { value: 0 }, uShadow: { value: new THREE.Vector2() }, uMil: { value: 0.001 }, uGlow: { value: new THREE.Color(glow) }, uStyle: { value: style },
  }, /* glsl */`
uniform float uOpen; uniform vec2 uShadow; uniform float uMil; uniform vec3 uGlow; uniform float uStyle;
varying vec3 vView; varying vec2 vUv;
float line( float x, float w, float fw ) { return 1.0 - smoothstep( w, w + fw, abs( x ) ); }
void main() {
	vec2 p = vUv * 2.0 - 1.0;
	float rr = length( p );
	// eye box: clear disc that shrinks to nothing when the eye is off axis, and drifts with the rifle
	float clear = smoothstep( uOpen * 1.04, uOpen * 0.86, length( p - uShadow ) ) * step( 0.001, uOpen );
	clear *= smoothstep( 1.0, 0.94, rr );
	// reticle at infinity, in mils from the aim point
	vec2 m = ( vView.xy / - vView.z ) / uMil;
	float fw = max( fwidth( m.x ), fwidth( m.y ) );
	vec2 am = abs( m );
	float thin = 0.55 * fw;
	float cross = max( line( m.x, thin, fw ) * step( 1.5, am.y ), line( m.y, thin, fw ) * step( 1.5, am.x ) );
	cross *= 1.0 - step( 62.0, max( am.x, am.y ) ) * 0.0;
	// hash marks every 10 mil, small every 5
	float major = max( line( mod( m.x + 5.0, 10.0 ) - 5.0, thin, fw ) * step( am.y, 2.2 ) * step( 5.0, am.x ),
	                   line( mod( m.y + 5.0, 10.0 ) - 5.0, thin, fw ) * step( am.x, 2.2 ) * step( 5.0, am.y ) );
	float minor = max( line( mod( m.x, 10.0 ) - 5.0, thin, fw ) * step( am.y, 1.1 ),
	                   line( mod( m.y, 10.0 ) - 5.0, thin, fw ) * step( am.x, 1.1 ) );
	float inner = step( max( am.x, am.y ), 60.0 );
	// heavy outer posts (left, right, bottom)
	float post = max( line( m.y, 1.1, fw ) * step( 60.0, am.x ), line( m.x, 1.1, fw ) * step( 60.0, - m.y ) );
	float ret = clamp( ( cross + ( major + minor ) * inner ) * 0.92 + post, 0.0, 1.0 );
	float cdot = 1.0 - smoothstep( 0.45, 0.45 + fw, length( m ) ); // illuminated centre dot
	if ( uStyle > 0.5 && uStyle < 1.5 ) {
		// chevron: two strokes meeting at the aim point, three drop bars below, heavy posts far out
		float w = 0.7 + fw;
		float chev = ( 1.0 - smoothstep( w * 0.5, w * 0.5 + fw, abs( am.x * 0.92 + m.y ) * 0.74 ) ) * step( m.y, 0.2 ) * step( - 7.0, m.y );
		float bars = 0.0;
		for ( int i = 1; i <= 3; i ++ ) { float y = - 7.0 - float( i ) * 9.0; bars = max( bars, line( m.y - y, 0.4, fw ) * step( am.x, 7.0 - float( i ) * 1.5 ) ); }
		float stem = line( m.x, 0.3, fw ) * step( m.y, - 9.0 ) * step( - 36.0, m.y );
		float posts = max( line( m.y, 1.3, fw ) * step( 45.0, am.x ), line( m.x, 1.3, fw ) * step( 45.0, - m.y ) );
		ret = clamp( ( bars + stem ) * 0.92 + posts, 0.0, 1.0 );
		cdot = chev;
	} else if ( uStyle > 1.5 ) {
		// duplex: thick posts stopping short of an open circle with a fine cross inside
		float rr2 = length( m );
		float circ = 1.0 - smoothstep( 0.45, 0.45 + fw, abs( rr2 - 9.0 ) );
		float fine = max( line( m.x, thin, fw ) * step( 1.2, am.y ) * step( am.y, 26.0 ), line( m.y, thin, fw ) * step( 1.2, am.x ) * step( am.x, 26.0 ) );
		float thick = max( line( m.y, 1.2, fw ) * step( 26.0, am.x ), line( m.x, 1.2, fw ) * step( 26.0, am.y ) );
		ret = clamp( ( circ + fine ) * 0.92 + thick, 0.0, 1.0 );
	}
	// dark coated glass when closed
	vec3 glass = vec3( 0.004, 0.005, 0.007 ) + vec3( 0.03, 0.018, 0.05 ) * smoothstep( 0.9, - 0.6, p.y + p.x * 0.4 ) * 0.5 * ( 1.0 - step( 0.001, uOpen ) );
	float tint = smoothstep( 0.55, 1.0, rr ) * 0.25; // darkening toward the edge of the picture
	float a = max( 1.0 - clear, max( ret * clear, tint ) );
	vec3 col = glass * ( 1.0 - clear ) + uGlow * cdot * clear * 2.5;
	gl_FragColor = vec4( col, clamp( a + cdot * clear * 0.5, 0.0, 1.0 ) );
}`);
}
