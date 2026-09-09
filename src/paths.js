import * as THREE from 'three';

import { TILE, WORLD } from './params.js';

/* -------------------------------------------------------------------------
   Footpaths

   Nobody lays one. A path is what is left of the grass after enough people
   have walked the same way, so this stores one number per patch of ground —
   how worn it is — written by feet and read by everything that grows.

   Which is why it is a field over the whole island rather than a route between
   two points. A route would have to be planned, and a band does not plan its
   paths; it walks to the water, to the good foraging, to the next fire, and the
   ground keeps the score. The paths that appear are the errands people actually
   run, and they move when the errands do: a camp that shifts leaves its old
   paths behind to grow over.

   Three things read the field:

   - the terrain shader, which browns the ground under a path. This is the one
     that makes it look like a path, and it is a texture sample rather than
     geometry — nothing is drawn, nothing z-fights with the hill it is on, and
     it follows a slope exactly because it *is* the slope.
   - `fillTile`, which thins the grass on a worn patch and stops growing it
     entirely on a bare one.
   - the flowers, which give up sooner than the grass does.

   The field is deliberately coarse. A cell is a stride and a half across, and
   the texture is filtered, so what a single passer-by leaves is a faint smear
   rather than a footprint — a path has to be walked to exist.
   ------------------------------------------------------------------------- */

export const PATH = {
  cell: 1.5,            // metres one wear cell covers
  maxTexels: 4096,      // and the ceiling on the field, whatever the island
  /* What one person walking one metre leaves. A cell is 1.5 m, so about a
     dozen crossings take fresh grass to bare earth — a route somebody runs
     twice a day is a path within the week, and a walk taken once is not. */
  perMetre: 0.055,
  showing: 0.22,        // wear at which the grass starts to thin
  bare: 0.72,           // and at which it stops growing at all
  /* And where a path is worn enough to be worth drawing on a map. The same
     number the terrain shader browns from, so the map and the ground agree
     about what counts as a path — a road on the map that is not under your feet
     when you get there is worse than no road. */
  onMap: 0.45,
  /* Grass comes back. Proportional, so a path fades fastest when it is
     freshest and a deep one takes a season — the same shape as the fruit. */
  fadeDays: 30,         // sim-days to fall by 1/e with nobody walking it
  /* And how often that is actually worked out. The decay is exponential, so
     four days in one go is exactly four days one at a time — and the alternative
     is walking every worn cell on the island once a simulated day, which after a
     long run is a hundred and seventy thousand of them. */
  fadeEvery: 4,         // sim-days
  gone: 0.015,          // below this a cell is dropped from the live list
};

/* The ground under a path: trodden earth, not dead grass. Kept out of the
   season tint on purpose — bare soil does not turn with the year.

   One colour, two readers. The terrain shader paints the ground with it and
   `fillTile` browns the blades still standing on the edge of the path toward
   it, and those two have to agree or the grass reads as a different material
   from the earth it is growing out of. */
export const PATH_EARTH = new THREE.Color(0x5b4a35);

export const pathUniforms = {
  uPaths: { value: null },
  uPathColor: { value: PATH_EARTH },
  /* How far the colour goes where the path is deepest. At 0.88 the ground under
     a path was almost entirely path — bare earth in a place people walk, which
     is not what a trodden line through grass looks like. Half is enough to read
     as worn and little enough to still be ground. */
  uPathDeep: { value: 0.50 },
};

/* One byte per cell, 0-255 for 0-1. A Float32Array would be four times the
   memory for precision nothing here can see. */
let wear = null;
let texture = null;
let cols = 0;                        // cells across the island
let cell = PATH.cell;                // metres, after the ceiling is applied
/* Which cells are non-zero. Fading walks this rather than the whole field: on
   a 3200 m island the field is four and a half million cells and the paths are
   a few thousand of them, and a fade that costs the island rather than the
   paths would be paid every simulated day forever. */
let live = new Set();
let dirty = false;
/* Bumped by every change to the field. Anything that draws the paths keeps the
   number it last drew and rebuilds when it no longer matches. */
export let pathVersion = 0;
/* Tiles whose grass no longer matches the ground. Crossing a threshold is what
   changes what grows, so that — rather than every step — is what asks for a
   tile to be scattered again. Once a path is bare it stops crossing anything
   and stops asking. */
const worn = new Set();

const EMPTY = new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat);
EMPTY.needsUpdate = true;
pathUniforms.uPaths.value = EMPTY;

export function clearPaths() {
  wear = null;
  live = new Set();
  worn.clear();
  texture?.dispose();
  texture = null;
  pathUniforms.uPaths.value = EMPTY;
}

/** Sized to the island, up to a ceiling — past which the cells grow instead. */
export function buildPaths() {
  clearPaths();
  cols = Math.min(PATH.maxTexels, Math.ceil(WORLD / PATH.cell));
  cell = WORLD / cols;
  wear = new Uint8Array(cols * cols);
  texture = new THREE.DataTexture(wear, cols, cols, THREE.RedFormat);
  /* Filtered, so a cell is a soft edge rather than a square. This is most of
     what makes a field this coarse read as a trodden line at all. */
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  pathUniforms.uPaths.value = texture;
  dirty = false;
}

const cellX = (x) => Math.floor((x + WORLD / 2) / cell);
const cellZ = (z) => Math.floor((z + WORLD / 2) / cell);

/* A tile key that survives a negative index. Tiles are 24 m and the island is
   at most 6400, so this cannot collide inside one world. */
const tileKey = (ix, iz) => (ix + 512) * 4096 + (iz + 512);
export const tileFromKey = (k) => [((k / 4096) | 0) - 512, (k % 4096) - 512];

function bump(i, j, amount) {
  if (i < 0 || j < 0 || i >= cols || j >= cols) return;
  const k = j * cols + i;
  const before = wear[k];
  if (before === 255) return;
  const after = Math.min(255, before + Math.round(amount * 255));
  if (after === before) return;
  wear[k] = after;
  live.add(k);
  dirty = true;
  pathVersion++;
  /* Only a threshold changes what grows here. Everything between them is the
     shader's business, and the shader reads the field directly. */
  const was = before / 255, now = after / 255;
  if ((was < PATH.showing && now >= PATH.showing) || (was < PATH.bare && now >= PATH.bare)) {
    const wx = -WORLD / 2 + (i + 0.5) * cell, wz = -WORLD / 2 + (j + 0.5) * cell;
    worn.add(tileKey(Math.floor(wx / TILE), Math.floor(wz / TILE)));
  }
}

/* Somebody walked from one place to the next. Stamped along the whole segment
   rather than at the end of it: a step is a quarter of a second of jogging at
   its longest, which is most of a cell, and an unwatched step is longer still —
   stamping only where they landed leaves a dotted line with gaps a path cannot
   be made of. */
export function tread(x0, z0, x1, z1) {
  if (!wear) return;
  const dx = x1 - x0, dz = z1 - z0;
  const dist = Math.hypot(dx, dz);
  if (dist <= 0) return;
  const steps = Math.max(1, Math.ceil(dist / (cell * 0.5)));
  /* Every sample is stamped, including the several that land in the same cell.
     That is the point: what a cell collects is the distance walked across it,
     so crossing a cell corner to corner wears it more than clipping an edge,
     and neither depends on where the frame boundaries happened to fall. */
  const each = (dist / steps) * PATH.perMetre;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    bump(cellX(x0 + dx * t), cellZ(z0 + dz * t), each);
  }
}

/** How worn the ground is here, 0 to 1. Bilinear, or paths come out square. */
export function wearAt(x, z) {
  if (!wear || live.size === 0) return 0;
  const u = (x + WORLD / 2) / cell - 0.5;
  const v = (z + WORLD / 2) / cell - 0.5;
  const i = Math.floor(u), j = Math.floor(v);
  if (i < 0 || j < 0 || i + 1 >= cols || j + 1 >= cols) return 0;
  const tx = u - i, tz = v - j;
  const a = wear[j * cols + i], b = wear[j * cols + i + 1];
  const c = wear[(j + 1) * cols + i], d = wear[(j + 1) * cols + i + 1];
  const top = a + (b - a) * tx, bot = c + (d - c) * tx;
  return (top + (bot - top) * tz) / 255;
}

/* Grass grows back over a path nobody walks any more. Once a sim-day, over the
   cells that are actually worn. */
export function fadePaths(days) {
  if (!wear || !live.size || days <= 0) return;
  const keep = Math.exp(-days / PATH.fadeDays);
  for (const k of live) {
    const was = wear[k] / 255;
    const now = was * keep;
    wear[k] = now < PATH.gone ? 0 : Math.round(now * 255);
    if (wear[k] === 0) live.delete(k);
    // Coming back down past a threshold puts the grass back, the same way.
    if ((was >= PATH.bare && now < PATH.bare) || (was >= PATH.showing && now < PATH.showing)) {
      const i = k % cols, j = (k / cols) | 0;
      const wx = -WORLD / 2 + (i + 0.5) * cell, wz = -WORLD / 2 + (j + 0.5) * cell;
      worn.add(tileKey(Math.floor(wx / TILE), Math.floor(wz / TILE)));
    }
  }
  dirty = true;
  pathVersion++;
}

/** Tiles whose grass is out of date, handed over once. */
export function takeWornTiles() {
  if (!worn.size) return null;
  const out = [...worn];
  worn.clear();
  return out;
}

/* The texture is only uploaded when something walked, and never more than a
   few times a second: the field is megabytes and the difference one person
   makes to it in a frame cannot be seen. Nothing is uploaded at all while the
   world is running unwatched, because nothing is being drawn. */
let nextUpload = 0;
export function flushPaths(now) {
  if (!dirty || !texture || now < nextUpload) return;
  texture.needsUpdate = true;
  dirty = false;
  nextUpload = now + 0.5;
}

/* For the map, which draws the paths as roads. Handed out as a walk over the
   cells that are actually worn rather than as a field to sample: there are a
   few thousand of them against four and a half million cells, and the map would
   otherwise ask every pixel a question the answer to which is almost always no.

   Cheap enough to walk every draw, and `pathVersion` above says when it is not
   worth walking at all. */
export function forEachWorn(fn) {
  if (!wear) return;
  for (const k of live) {
    const i = k % cols, j = (k / cols) | 0;
    fn(-WORLD / 2 + (i + 0.5) * cell, -WORLD / 2 + (j + 0.5) * cell, wear[k] / 255, cell);
  }
}

/** For the panel and the boot check: how much of the island is trodden. */
export function pathStats() {
  if (!wear) return { cells: 0, bare: 0 };
  let bare = 0;
  const cut = PATH.bare * 255;
  for (const k of live) if (wear[k] >= cut) bare++;
  return { cells: live.size, bare };
}

/* Wear is not saved. A world is rebuilt from its seed, and a path is not in the
   seed — it is in the walking. Coming back to a saved world puts the band back
   where it was on ground that has forgotten them, and they walk it again. */
