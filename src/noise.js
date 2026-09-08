import { P, WORLD } from './params.js';

/* -------------------------------------------------------------------------
   Noise. Seeded value noise is plenty at this scale and it is deterministic,
   so a seed always rebuilds the same island.
   ------------------------------------------------------------------------- */

export function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function valueNoise(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  // smootherstep: continuous second derivative, so the hills have no creases
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = zf * zf * zf * (zf * (zf * 6 - 15) + 10);
  const a = hash2(xi, zi, seed),     b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed), d = hash2(xi + 1, zi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/* Successive octaves are rotated as well as scaled. Value noise lives on an
   integer lattice, and stacking octaves on the *same* lattice leaves the grid
   showing: faint axis-aligned crosshatching that a hillshaded map makes
   obvious. Turning each octave off the last hides the alignment. */
export const OCT_COS = Math.cos(0.71), OCT_SIN = Math.sin(0.71);

export function fbm(x, z, octaves, seed) {
  let f = 1, a = 0.5, sum = 0, norm = 0;
  let px = x, pz = z;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(px * f, pz * f, seed + i * 131) * a;
    norm += a; f *= 2.03; a *= 0.5;
    const nx = px * OCT_COS - pz * OCT_SIN;
    pz = px * OCT_SIN + pz * OCT_COS;
    px = nx;
  }
  return sum / norm;
}

// Ridged noise: the absolute-value fold turns smooth blobs into sharp crests.
export function ridged(x, z, octaves, seed) {
  let f = 1, a = 0.5, sum = 0, norm = 0;
  let px = x, pz = z;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(px * f, pz * f, seed + i * 77) * 2 - 1);
    sum += n * n * a; norm += a; f *= 2.07; a *= 0.5;
    const nx = px * OCT_COS - pz * OCT_SIN;
    pz = px * OCT_SIN + pz * OCT_COS;
    px = nx;
  }
  return sum / norm;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------------------
   Terrain height
   ------------------------------------------------------------------------- */

export let hOffset = 0;   // slides the island so spawn always sits above the water

/* A frequency is only meaningful against the size of the map: the noise works
   on an integer lattice, so `x * f` has to cross whole numbers within
   ±WORLD/2 or the whole island sits inside one cell and comes out as a single
   smooth mound. 0.0045 puts ~7 hill cells across 1600 units; the range mask at
   0.0019 gives about three mountain regions. Retuning any of these is the
   fastest way to change what the world looks like. */
export function rawHeight(x, z) {
  const s = P.seed;
  const hills = (fbm(x * 0.0045, z * 0.0045, 5, s) - 0.45) * 90;
  const range = smoothstep(0.44, 0.66, fbm(x * 0.0019 + 31.7, z * 0.0019 - 12.4, 3, s + 900));
  const mountains = ridged(x * 0.0026, z * 0.0026, 4, s + 400) * 170 * range;
  const detail = (fbm(x * 0.020, z * 0.020, 3, s + 1700) - 0.5) * 3.4;

  // A calm meadow around the origin: somewhere to stand and watch the grass.
  const d = Math.hypot(x, z);
  const calm = smoothstep(40, 280, d);

  let h = hills * (0.25 + 0.75 * calm) + mountains * calm + detail;
  h -= smoothstep(540, 820, d) * 95;    // island falloff → the map ends in sea
  return h + hOffset;
}

/* The height *field*: sampled once at terrain resolution, then everything else
   (grass, trees, rocks, the camera) reads it bilinearly. Two reasons — it is
   far cheaper than re-running five octaves of noise per blade, and it puts
   objects on the *rendered* surface rather than the ideal one, so nothing
   floats above a facet or sinks into it. */
export let field = null, fieldSeg = 0, fieldCell = 0;

export function buildField(seg) {
  hOffset = 0;
  hOffset = 4 - rawHeight(0, 0);
  fieldSeg = seg;
  fieldCell = WORLD / seg;
  field = new Float32Array((seg + 1) * (seg + 1));
  for (let j = 0; j <= seg; j++) {
    const z = -WORLD / 2 + j * fieldCell;
    for (let i = 0; i <= seg; i++) {
      field[j * (seg + 1) + i] = rawHeight(-WORLD / 2 + i * fieldCell, z);
    }
  }
}

export function sampleHeight(x, z) {
  const fx = clamp((x + WORLD / 2) / fieldCell, 0, fieldSeg - 0.0001);
  const fz = clamp((z + WORLD / 2) / fieldCell, 0, fieldSeg - 0.0001);
  const i = fx | 0, j = fz | 0;
  const tx = fx - i, tz = fz - j;
  const w = fieldSeg + 1;
  const a = field[j * w + i],       b = field[j * w + i + 1];
  const c = field[(j + 1) * w + i], d = field[(j + 1) * w + i + 1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

// 1 = dead flat, 0 = a wall. Central differences over one field cell.
export function flatnessAt(x, z) {
  const e = fieldCell;
  const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
  const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
  return 1 / Math.sqrt(1 + dx * dx + dz * dz);
}

