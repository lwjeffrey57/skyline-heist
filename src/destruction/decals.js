import * as THREE from 'three';

// Crack marks: one InstancedMesh of quads laid on piece faces. Each mark belongs to a piece
// and is clamped inside that piece's face, so it never hangs over a hole.

function crackTexture() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d');
  let s = 99173; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) >>> 8) / 16777216;
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.2);
  g.addColorStop(0, 'rgba(0,0,0,0.95)'); g.addColorStop(0.45, 'rgba(0,0,0,0.6)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  x.lineCap = 'round'; x.lineJoin = 'round';
  const crack = (px, py, ang, len, w, depth) => {
    let cx = px, cy = py, a = ang; const steps = Math.max(3, Math.round(len / 9));
    for (let i = 0; i < steps; i++) {
      a += (rnd() - 0.5) * 0.9;
      const nx = cx + Math.cos(a) * (len / steps), ny = cy + Math.sin(a) * (len / steps);
      const t = i / steps;
      x.strokeStyle = `rgba(0,0,0,${0.95 * (1 - t * 0.55)})`; x.lineWidth = Math.max(0.7, w * (1 - t));
      x.beginPath(); x.moveTo(cx, cy); x.lineTo(nx, ny); x.stroke();
      if (depth > 0 && rnd() < 0.3) crack(nx, ny, a + (rnd() < 0.5 ? 1 : -1) * (0.5 + rnd() * 0.7), len * (1 - t) * 0.6, w * (1 - t) * 0.7, depth - 1);
      cx = nx; cy = ny;
    }
  };
  const n = 9;
  for (let i = 0; i < n; i++) crack(S / 2, S / 2, (i / n) * Math.PI * 2 + rnd() * 0.5, S * (0.3 + rnd() * 0.16), 4.5, 2);
  for (let i = 0; i < 22; i++) { // pitting around the centre
    const a = rnd() * 6.283, r = S * (0.06 + rnd() * 0.2);
    x.fillStyle = `rgba(0,0,0,${0.35 + rnd() * 0.4})`; x.beginPath(); x.arc(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 1.5 + rnd() * 4, 0, 6.283); x.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

const AX = ['x', 'y', 'z'];

export class Decals {
  constructor(scene, cfg) {
    const N = this.N = cfg.max;
    const mat = new THREE.MeshBasicMaterial({ color: 0x0b0a09, map: crackTexture(), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const mesh = this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.m = mesh.instanceMatrix.array; this.m.fill(0);
    mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.name = 'destruction-cracks';
    scene.add(mesh);
    this.owner = new Array(N).fill(null); // the damage spot using each slot
    this.cursor = 0;
  }

  // spot: { x, y, z, axis, sign, slot, flip }; box: collider with min/max; size in metres
  set(spot, box, size) {
    let i = spot.slot;
    if (i < 0 || this.owner[i] !== spot) {
      i = this.cursor; this.cursor = (i + 1) % this.N;
      const old = this.owner[i]; if (old) old.slot = -1;
      this.owner[i] = spot; spot.slot = i; spot.flip = Math.floor(Math.random() * 8);
    }
    const n = spot.axis, u = n === 0 ? 2 : 0, v = n === 1 ? 2 : 1;
    const mn = box.min, mx = box.max;
    const fit = (a) => {
      const lo = mn[AX[a]], hi = mx[AX[a]], s = Math.min(size, hi - lo);
      const c = Math.min(hi - s / 2, Math.max(lo + s / 2, spot[AX[a]]));
      return [c, s];
    };
    const [cu, su] = fit(u), [cv, sv] = fit(v);
    const pos = [0, 0, 0];
    pos[u] = cu; pos[v] = cv; pos[n] = (spot.sign > 0 ? mx[AX[n]] : mn[AX[n]]) + spot.sign * 0.012;
    const m = this.m, j = i * 16, f = spot.flip;
    for (let k = 0; k < 16; k++) m[j + k] = 0;
    // columns: plane x, plane y, normal; flips/swaps vary the pattern while staying axis aligned
    const a0 = f & 4 ? v : u, a1 = f & 4 ? u : v, s0 = f & 4 ? sv : su, s1 = f & 4 ? su : sv;
    m[j + a0] = (f & 1 ? -1 : 1) * s0; m[j + 4 + a1] = (f & 2 ? -1 : 1) * s1; m[j + 8 + n] = 1;
    m[j + 12] = pos[0]; m[j + 13] = pos[1]; m[j + 14] = pos[2]; m[j + 15] = 1;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  release(spot) {
    const i = spot.slot; if (i < 0) return;
    spot.slot = -1;
    if (this.owner[i] !== spot) return;
    this.owner[i] = null;
    const j = i * 16; for (let k = 0; k < 15; k++) this.m[j + k] = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
