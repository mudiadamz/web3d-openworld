import * as THREE from 'three';
import { P, SEA, WORLD } from './params.js';
import { clamp, field, fieldCell, fieldSeg, mulberry32, sampleHeight } from './noise.js';
import { streamMaterial } from './scene.js';
import { terrainGroup, world } from './world.js';

/* -------------------------------------------------------------------------
   Creeks

   Water that runs downhill and cuts the ground on its way, rather than a blue
   ribbon laid on top of a landscape that never knew it was there.

   Three passes, in this order and no other:
     1. trace  — from a high source, step downhill across the height field
     2. carve  — sink a channel along that path, before the mesh is built
     3. build  — lay the water in the channel the carve just made

   Doing it before the terrain mesh is what makes the valleys real: the trees,
   the grass, the animals' cliff tests and the camp sites all read the carved
   field, so the whole world knows where the creeks are without being told.
   ------------------------------------------------------------------------- */

export const streams = [];               // each an array of { x, z, level, width }
export let wet = null;                   // per-field-cell flag: is this a creek bed?

export const STREAM_STEP = 6;            // metres between path samples
export const STREAM_DROP = 0.02;         // forced descent per step, so a creek never stalls
export const CHANNEL_DEPTH = 1.7;
export const CHANNEL_BANK = 0.5;
export const MAX_CUT = 4;                // a creek cuts through a bump, not through a hill
export const MAX_STEPS = 240;            // 1.4 km, longer than the island is wide
export const MAX_BANK_CUT = 4;           // a hillside gets a notch, not a gorge

export function traceStreams(count) {
  const rng = mulberry32(P.seed ^ 0x57ea3f11);
  for (let n = 0; n < count; n++) {
    let src = null;
    for (let t = 0; t < 400; t++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * WORLD * 0.40;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (sampleHeight(x, z) < 32) continue;                 // springs come from high ground
      if (streams.some((s) => Math.hypot(s[0].x - x, s[0].z - z) < 130)) continue;
      src = { x, z };
      break;
    }
    if (!src) continue;

    const path = [];
    let x = src.x, z = src.z;
    let level = sampleHeight(x, z);
    let dirX = 0, dirZ = 0;

    for (let i = 0; i < MAX_STEPS; i++) {
      path.push({ x, z, level, width: 0 });
      if (level <= SEA + 0.3) break;

      // Steepest descent on a ring around the current point.
      let bestX = x, bestZ = z, bestH = Infinity;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const nx = x + Math.cos(a) * STREAM_STEP, nz = z + Math.sin(a) * STREAM_STEP;
        const nh = sampleHeight(nx, nz);
        if (nh < bestH) { bestH = nh; bestX = nx; bestZ = nz; }
      }

      /* Momentum. Pure steepest descent rattles from side to side down a noisy
         slope and reads as a zigzag; carrying the previous direction gives the
         meander a creek actually has. */
      dirX = dirX * 0.55 + (bestX - x) * 0.45;
      dirZ = dirZ * 0.55 + (bestZ - z) * 0.45;
      const len = Math.hypot(dirX, dirZ);
      if (len < 1e-4) break;
      const nx = x + (dirX / len) * STREAM_STEP;
      const nz = z + (dirZ / len) * STREAM_STEP;
      if (Math.hypot(nx, nz) > WORLD * 0.47) break;

      const ground = sampleHeight(nx, nz);
      /* The level only ever falls. Water does not run uphill, and forcing the
         drop is what lets a creek cut through a small rise instead of pooling
         behind it — but a rise it would have to trench four metres through is a
         hill, not a rise, so the creek ends there. Without that limit a creek
         on gently rolling ground will meander for kilometres, digging the whole
         way: one of these ran 2670 m across a 1600 m island. */
      const next = Math.min(level - STREAM_DROP, ground);
      if (ground - next > MAX_CUT) break;

      /* On ground flat enough that the forced descent is doing the work,
         momentum plus steepest descent will happily circle: one creek spent 85%
         of its length within twelve metres of itself, a scribble rather than a
         stream. So a creek that arrives back on its own course is finished —
         but only against ground it left a while ago, since the last hundred
         metres are just the meander it is supposed to have. */
      let looped = false;
      for (let k = 0; k < path.length - 20; k++) {
        if (Math.hypot(path[k].x - nx, path[k].z - nz) < 10) { looped = true; break; }
      }
      if (looped) break;

      x = nx; z = nz; level = next;
    }

    if (path.length > 14) {
      // Creeks widen downstream, the way they do.
      for (let i = 0; i < path.length; i++) {
        path[i].width = 4.5 + 5.5 * (i / path.length);
      }
      streams.push(path);
    }
  }
}

export function carveStreams() {
  const w = fieldSeg + 1;
  wet = new Uint8Array(w * w);
  for (const path of streams) {
    for (const p of path) {
      const r = p.width;
      const i0 = Math.max(0, Math.floor((p.x - r + WORLD / 2) / fieldCell));
      const i1 = Math.min(fieldSeg, Math.ceil((p.x + r + WORLD / 2) / fieldCell));
      const j0 = Math.max(0, Math.floor((p.z - r + WORLD / 2) / fieldCell));
      const j1 = Math.min(fieldSeg, Math.ceil((p.z + r + WORLD / 2) / fieldCell));
      for (let j = j0; j <= j1; j++) {
        const cz = -WORLD / 2 + j * fieldCell;
        for (let i = i0; i <= i1; i++) {
          const cx = -WORLD / 2 + i * fieldCell;
          const d = Math.hypot(cx - p.x, cz - p.z);
          if (d > r) continue;
          const t = d / r;
          // A parabolic channel: deepest in the middle, back to the original
          // ground by the rim, so the banks are cut rather than stepped.
          const target = p.level - CHANNEL_DEPTH + t * t * (CHANNEL_DEPTH + CHANNEL_BANK);
          const idx = j * w + i;
          if (field[idx] > target) {
            /* The channel core is cut to whatever depth it takes — the water has
               to have a bed under it. The banks are only allowed to come down so
               far, so a creek crossing a steep hillside notches into it instead
               of opening a gorge down the slope. */
            const limit = t < 0.5 ? Infinity : MAX_BANK_CUT;
            field[idx] = Math.max(target, field[idx] - limit);
          }
          if (t < 0.8) wet[idx] = 1;
        }
      }
    }
  }
}

// One lookup instead of a distance test against every point of every creek.
export function isWet(x, z) {
  if (!wet) return false;
  const i = Math.round(clamp((x + WORLD / 2) / fieldCell, 0, fieldSeg));
  const j = Math.round(clamp((z + WORLD / 2) / fieldCell, 0, fieldSeg));
  return wet[j * (fieldSeg + 1) + i] === 1;
}

/* The water itself: a ribbon of triangles following the path, with uv.y running
   downstream so the ripples can be made to flow along it. */
export function buildStreamWater() {
  for (const path of streams) {
    const n = path.length;
    const pos = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);
    const idx = [];
    let along = 0;

    for (let i = 0; i < n; i++) {
      const p = path[i];
      const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
      let dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      if (i > 0) along += Math.hypot(p.x - path[i - 1].x, p.z - path[i - 1].z);

      /* A ribbon folds over itself on the inside of a bend as soon as it is
         wider than the bend is tight, and the fold lays two water triangles on
         top of each other at exactly the same height. No polygon offset can
         separate those — both faces get the same offset — so the fix has to be
         geometric: narrow the stream into tight corners instead. */
      const inLen = Math.hypot(p.x - a.x, p.z - a.z);
      const outLen = Math.hypot(b.x - p.x, b.z - p.z);
      let room = Infinity;
      if (inLen > 1e-6 && outLen > 1e-6) {
        const cosT = clamp(((p.x - a.x) * (b.x - p.x) + (p.z - a.z) * (b.z - p.z))
          / (inLen * outLen), -1, 1);
        const turn = Math.acos(cosT);
        if (turn > 1e-3) room = 0.8 * Math.min(inLen, outLen) / Math.tan(turn / 2);
      }
      const half = Math.min(p.width * 0.5, room);
      for (const side of [-1, 1]) {
        const k = (i * 2 + (side > 0 ? 1 : 0));
        // Perpendicular to the direction of travel.
        pos[k * 3] = p.x + -dz * half * side;
        pos[k * 3 + 1] = p.level + 0.22;
        pos[k * 3 + 2] = p.z + dx * half * side;
        uv[k * 2] = side > 0 ? 1 : 0;
        uv[k * 2 + 1] = along / 12;          // one ripple period every 12 m
      }
      if (i < n - 1) {
        const a0 = i * 2, b0 = a0 + 1, c0 = a0 + 2, d0 = a0 + 3;
        idx.push(a0, c0, b0, b0, c0, d0);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, streamMaterial);
    mesh.receiveShadow = true;
    mesh.name = 'stream';
    terrainGroup.add(mesh);
  }
}

/* wet lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setWet(v) { wet = v; }
