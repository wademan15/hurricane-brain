/**
 * A static, tileable cloud texture, generated once from a fixed seed.
 *
 * This is texture, not data: it never changes and is sampled in the storm's rotating frame, so a
 * pixel's colour changes only when a bound parameter (rotation, winding, brightness...) changes.
 * The fixed seed keeps the picture identical across runs (CLAUDE.md rule 4).
 *
 * Channels (gradient-noise fBm, cells per tile at the base octave): R = 4 (4 octaves),
 * G = 8 (3 octaves), B = 8 (2 octaves), A = 16 (1 octave). Finest detail is 8 texels.
 */

export const NOISE_SIZE = 256;
const SEED = 0x9e3779b9;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable gradient (Perlin) noise with `cells` lattice cells per tile, quintic interpolation. */
function gradientNoise(size: number, cells: number, rand: () => number): Float32Array {
  const gx = new Float32Array(cells * cells);
  const gy = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    const a = rand() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const out = new Float32Array(size * size);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const dot = (ix: number, iy: number, dx: number, dy: number) => {
    const k = (iy % cells) * cells + (ix % cells);
    return gx[k] * dx + gy[k] * dy;
  };
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells;
    const y0 = Math.floor(fy);
    const dy = fy - y0;
    const ty = fade(dy);
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const x0 = Math.floor(fx);
      const dx = fx - x0;
      const tx = fade(dx);
      const a = dot(x0, y0, dx, dy);
      const b = dot(x0 + 1, y0, dx - 1, dy);
      const c = dot(x0, y0 + 1, dx, dy - 1);
      const d = dot(x0 + 1, y0 + 1, dx - 1, dy - 1);
      const ab = a + (b - a) * tx;
      const cd = c + (d - c) * tx;
      out[y * size + x] = ab + (cd - ab) * ty;
    }
  }
  return out;
}

/** fBm of tileable gradient noise, normalised to 0..1. */
function fbm(size: number, baseCells: number, octaves: number, rand: () => number): Float32Array {
  const acc = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = gradientNoise(size, baseCells << o, rand);
    for (let i = 0; i < acc.length; i++) acc[i] += n[i] * amp;
    total += amp;
    amp *= 0.5;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < acc.length; i++) {
    acc[i] /= total;
    if (acc[i] < lo) lo = acc[i];
    if (acc[i] > hi) hi = acc[i];
  }
  for (let i = 0; i < acc.length; i++) acc[i] = (acc[i] - lo) / (hi - lo);
  return acc;
}

let cached: Uint8Array | null = null;

export function cloudTexture(): Uint8Array {
  if (cached) return cached;
  const rand = mulberry32(SEED);
  const size = NOISE_SIZE;
  const r = fbm(size, 4, 4, rand);
  const g = fbm(size, 8, 3, rand);
  const b = fbm(size, 8, 2, rand);
  const a = fbm(size, 16, 1, rand);
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = Math.round(r[i] * 255);
    out[i * 4 + 1] = Math.round(g[i] * 255);
    out[i * 4 + 2] = Math.round(b[i] * 255);
    out[i * 4 + 3] = Math.round(a[i] * 255);
  }
  cached = out;
  return out;
}
