// Uniform xz hash of world colliders. Each collider is registered in every cell its box
// (grown by `margin`) touches, so a small moving body only has to look at the one cell under its centre.
export class Grid {
  constructor(cell = 4, margin = 1.5) { this.cell = cell; this.margin = margin; this.map = new Map(); this.big = []; this.stamp = 0; }
  key(ix, iz) { return (ix + 2048) * 4096 + (iz + 2048); }
  insert(c) {
    const s = this.cell, m = this.margin;
    const x0 = Math.floor((c.min.x - m) / s), x1 = Math.floor((c.max.x + m) / s), z0 = Math.floor((c.min.z - m) / s), z1 = Math.floor((c.max.z + m) / s);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 64) { c._gb = true; this.big.push(c); return; }
    c._gc = [x0, x1, z0, z1];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const k = this.key(x, z); let a = this.map.get(k); if (!a) this.map.set(k, a = []); a.push(c);
    }
  }
  remove(c) {
    if (c._gb) { const i = this.big.indexOf(c); if (i >= 0) this.big.splice(i, 1); c._gb = false; return; }
    const g = c._gc; if (!g) return; c._gc = null;
    for (let x = g[0]; x <= g[1]; x++) for (let z = g[2]; z <= g[3]; z++) {
      const k = this.key(x, z), a = this.map.get(k); if (!a) continue;
      const i = a.indexOf(c); if (i >= 0) { a[i] = a[a.length - 1]; a.pop(); }
      if (!a.length) this.map.delete(k);
    }
  }
  cellAt(x, z) { return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell))); }
  // all colliders whose box overlaps the given box (inclusive); appended to out
  query(x0, y0, z0, x1, y1, z1, out) {
    const s = this.cell, st = ++this.stamp;
    const a0 = Math.floor(x0 / s), a1 = Math.floor(x1 / s), b0 = Math.floor(z0 / s), b1 = Math.floor(z1 / s);
    for (let x = a0; x <= a1; x++) for (let z = b0; z <= b1; z++) {
      const a = this.map.get(this.key(x, z)); if (!a) continue;
      for (let i = 0; i < a.length; i++) {
        const c = a[i]; if (c._gs === st) continue; c._gs = st;
        if (c.min.x <= x1 && c.max.x >= x0 && c.min.y <= y1 && c.max.y >= y0 && c.min.z <= z1 && c.max.z >= z0) out.push(c);
      }
    }
    for (const c of this.big) if (c.min.x <= x1 && c.max.x >= x0 && c.min.y <= y1 && c.max.y >= y0 && c.min.z <= z1 && c.max.z >= z0) out.push(c);
    return out;
  }
}
