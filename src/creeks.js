import * as THREE from 'three';
import { P, SEA, SNOW, WORLD } from './params.js';
import { clamp, fbm, field, fieldCell, fieldSeg, mulberry32, sampleHeight, smoothstep, setWaterCells } from './noise.js';
import { applyWaterShader, streamMaterial } from './scene.js';
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

   Water comes from somewhere and goes somewhere. A creek rises under a
   glacier — just below the snow, where the melt runs off it — or at a spring,
   a small pool welling up on high ground. And it ends in water: the sea, a
   creek it runs into, or, where a rise it cannot cut stops it, a lake that it
   pools into behind the rise. Nothing just stops on dry ground.
   ------------------------------------------------------------------------- */

export const streams = [];               // each an array of { x, z, level, width }, with .source and .end
export const lakes = [];                 // { x, z, level, r, spring } — where creeks end, and springs well up
export let wet = null;                   // per-field-cell flag: is this a creek bed?
let bank = null;                         // per-field-cell: how close to a creek's bank, 0-1
const C_BANK = new THREE.Color(0x4d5a2c); // wet, dark ground along the water

export const STREAM_STEP = 6;            // metres between path samples
export const STREAM_DROP = 0.02;         // forced descent per step, so a creek never stalls
export const CHANNEL_DEPTH = 1.7;
export const CHANNEL_BANK = 0.5;
export const MAX_CUT = 4;                // a creek cuts through a bump, not through a hill
export const MAX_STEPS = 240;            // 1.4 km, longer than the island is wide
export const MAX_BANK_CUT = 4;           // a hillside gets a notch, not a gorge

export const LAKE = {
  min: 7,              // metres out from the middle, the smallest a creek pools into ...
  perStep: 0.09,       // ... and more the further the creek had come to it
  max: 30,
  depth: 2.2,          // how deep in the middle
  berm: 7,             // metres of bank raised round it, wherever the ground fell away
  spring: 3.2,         // a spring's pool
};

/* Where a creek rises. Under a glacier: ground just below the snow line with
   snowfield above it, where the melt comes off the ice. Or a spring: high
   ground below the snow. Half the creeks look for ice first and half for a
   spring, so an island with snow on it has both — and one without has only
   springs, which is all it could have. */
function pickSource(rng, ice) {
  for (let t = 0; t < 200; t++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * WORLD * 0.40;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = sampleHeight(x, z);
    if (h < 32) continue;                                    // springs come from high ground
    if (streams.some((s) => Math.hypot(s[0].x - x, s[0].z - z) < 130)) continue;
    if (!ice) {
      if (h > SNOW - 14) continue;                           // under the snow is the glacier's
      return { x, z, kind: 'spring' };
    }
    if (h < SNOW - 14 || h > SNOW + 4) continue;
    let snowAbove = false;
    for (let k = 0; k < 8 && !snowAbove; k++) {
      const b = (k / 8) * Math.PI * 2;
      if (sampleHeight(x + Math.cos(b) * 40, z + Math.sin(b) * 40) > SNOW + 6) snowAbove = true;
    }
    if (snowAbove) return { x, z, kind: 'glacier' };
  }
  return null;
}

/* Water this creek has come to: a lake a creek before it pooled into, or the
   channel of one, at or below its own level — water runs into water, never up
   into it. */
function meetWater(x, z, level) {
  for (const lake of lakes) {
    if (lake.spring || lake.level > level + 0.3) continue;
    if (Math.hypot(lake.x - x, lake.z - z) < lake.r) return { x: lake.x, z: lake.z, level: lake.level, lake };
  }
  for (const s of streams) {
    for (const q of s) {
      if (q.level > level + 0.3) continue;
      if (Math.hypot(q.x - x, q.z - z) < q.width * 0.5 + 4) return q;
    }
  }
  return null;
}

export function traceStreams(count) {
  const rng = mulberry32(P.seed ^ 0x57ea3f11);
  lakes.length = 0;
  for (let n = 0; n < count; n++) {
    const ice = n % 2 === 0;
    const src = pickSource(rng, ice) || pickSource(rng, !ice);
    if (!src) continue;

    const path = [];
    let x = src.x, z = src.z;
    let level = sampleHeight(x, z);
    let dirX = 0, dirZ = 0;
    /* How it ends. A lake unless it reaches the sea or runs into other water:
       whatever stops a creek on land — a rise it cannot cut, flat ground, its
       own course, the edge of the island — is where it pools. */
    let end = 'lake', met = null;

    for (let i = 0; i < MAX_STEPS; i++) {
      path.push({ x, z, level, width: 0 });
      if (level <= SEA + 0.3) { end = 'sea'; break; }

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
         hill, not a rise, so the creek pools there. Without that limit a creek
         on gently rolling ground will meander for kilometres, digging the whole
         way: one of these ran 2670 m across a 1600 m island. */
      const next = Math.min(level - STREAM_DROP, ground);
      if (ground - next > MAX_CUT) break;

      // Into water that is already there: it joins it, and ends.
      met = meetWater(nx, nz, next);
      if (met) {
        path.push({ x: met.x, z: met.z, level: Math.min(next, met.level), width: 0 });
        end = 'join';
        break;
      }

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
      let pts = smoothPath(path);
      // Where it pools, the lake it makes: bigger the further the creek came.
      if (end === 'lake') {
        const last = pts[pts.length - 1];
        lakes.push({ x: last.x, z: last.z, level: last.level, r: Math.min(LAKE.max, LAKE.min + path.length * LAKE.perStep), spring: false });
      }
      // A spring wells up in a pool of its own, at the head of the creek.
      if (src.kind === 'spring') {
        lakes.push({ x: pts[0].x, z: pts[0].z, level: pts[0].level, r: LAKE.spring, spring: true });
      }
      /* The ribbon stops at the shore rather than running on under the lake,
         where two sheets of water would lie on top of each other. */
      const into = end === 'lake' ? lakes[lakes.length - (src.kind === 'spring' ? 2 : 1)] : met?.lake;
      if (into) pts = trimInto(pts, into);
      if (src.kind === 'spring') pts = trimFrom(pts, lakes[lakes.length - 1]);
      /* A spring is a trickle and a mouth is a stream: narrow at the top and
         widening with the water it has gathered — faster at first, then
         slowly — and never a ruled width, but wandering a little wider and
         narrower along its length. A glacier's melt starts with more. */
      const n = pts.length, head = src.kind === 'glacier' ? 2.6 : 1.6;
      for (let i = 0; i < n; i++) {
        const f = i / (n - 1), q = pts[i];
        // Narrows and broad reaches, a few tens of metres each ...
        const wander = 0.55 + 0.9 * fbm(q.x * 0.022, q.z * 0.022, 3, P.seed + 7711);
        // ... and now and then a pool, where the water spreads out and slows ...
        const pool = 1 + 0.7 * smoothstep(0.6, 0.78, fbm(q.x * 0.009, q.z * 0.009, 2, P.seed + 4242));
        q.width = (head + 8.4 * Math.sqrt(f)) * wander * pool;
        /* ... and two banks of its own, not one ruled twice: how far the water
           reaches toward each side, as a share of what the bend allows, so one
           bank is cut back where the other stands in. Never more than the whole
           of it, so it can never fold the water where the width could not. */
        q.bankL = 0.55 + 0.45 * fbm(q.x * 0.06, q.z * 0.06, 2, P.seed + 1301);
        q.bankR = 0.55 + 0.45 * fbm(q.x * 0.06, q.z * 0.06, 2, P.seed + 2903);
      }
      pts.source = src.kind;
      pts.end = end;
      streams.push(pts);
    }
  }
}

/** How far a lake's shore is from its middle, this way round: never a circle,
    but a shore that comes in and goes out. */
export function lakeRadius(lake, a) {
  if (lake.spring) return lake.r;
  return lake.r * (0.78 + 0.44 * fbm(lake.x * 0.013 + Math.cos(a) * 0.8, lake.z * 0.013 + Math.sin(a) * 0.8, 2, P.seed + 5151));
}

const insideLake = (lake, q, share) =>
  Math.hypot(q.x - lake.x, q.z - lake.z) < lakeRadius(lake, Math.atan2(q.z - lake.z, q.x - lake.x)) * share;

// The last points in the lake go, all but one: the water reaches in, and stops.
function trimInto(pts, lake) {
  while (pts.length > 4 && insideLake(lake, pts[pts.length - 2], 0.8)) pts.pop();
  return pts;
}
// And a spring's creek starts at the edge of its pool, not in the middle of it.
function trimFrom(pts, lake) {
  while (pts.length > 4 && insideLake(lake, pts[1], 0.7)) pts.shift();
  return pts;
}

/* The trace steps six metres at a time, and a creek drawn through those points
   is a chain of straight reaches with a kink at every one. Two rounds of
   corner-cutting (Chaikin's) turn the kinks into curves without moving the
   creek anywhere it was not — and afterwards the level is made to fall again
   all the way down, and never to sit above the ground a cut corner now
   crosses, or the water would stand on the bank. */
function smoothPath(path) {
  /* First the doublings-back. On a noisy slope the trace now and then turns
     more than a right angle in one step — a zigzag no creek makes, and the
     thing that folds the water over itself: through a turn that sharp the
     ribbon's edges run backwards whatever its width. Rounding the corner only
     spreads the zigzag over more points (it made the folds worse, measured),
     so the point that makes one goes, and the course is rounded after. */
  let pts = path.slice();
  for (let i = 1; i < pts.length - 1 && pts.length > 3;) {
    const a = pts[i - 1], p = pts[i], b = pts[i + 1];
    if ((p.x - a.x) * (b.x - p.x) + (p.z - a.z) * (b.z - p.z) < 0) { pts.splice(i, 1); if (i > 1) i--; }
    else i++;
  }
  for (let round = 0; round < 2; round++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25, level: a.level * 0.75 + b.level * 0.25, width: 0 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75, level: a.level * 0.25 + b.level * 0.75, width: 0 });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  for (let i = 0; i < pts.length; i++) {
    const below = i ? pts[i - 1].level - STREAM_DROP / 4 : Infinity;
    pts[i] = { ...pts[i], level: Math.min(pts[i].level, sampleHeight(pts[i].x, pts[i].z), below) };
  }
  return pts;
}

export function carveStreams() {
  const w = fieldSeg + 1;
  wet = new Uint8Array(w * w);
  bank = new Float32Array(w * w);
  for (const path of streams) {
    for (let n = 0; n < path.length; n++) {
      const p = path[n];
      /* The channel follows the uneven banks the water is laid with: as wide
         as the two reaches together, and leaning toward whichever side runs
         wider, so one bank is cut back further than the other. */
      const a = path[Math.max(0, n - 1)], b = path[Math.min(path.length - 1, n + 1)];
      const run = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const lean = p.width * ((p.bankR ?? 1) - (p.bankL ?? 1)) * 0.5;
      const ox = p.x - ((b.z - a.z) / run) * lean, oz = p.z + ((b.x - a.x) / run) * lean;
      const r = p.width * ((p.bankL ?? 1) + (p.bankR ?? 1)) * 0.5;
      /* The bank reaches past the channel: ground within about twice the
         creek's width is wetter and darker the nearer it is (tintBank). */
      const rb = r * 2.2 + 2;
      const i0 = Math.max(0, Math.floor((ox - rb + WORLD / 2) / fieldCell));
      const i1 = Math.min(fieldSeg, Math.ceil((ox + rb + WORLD / 2) / fieldCell));
      const j0 = Math.max(0, Math.floor((oz - rb + WORLD / 2) / fieldCell));
      const j1 = Math.min(fieldSeg, Math.ceil((oz + rb + WORLD / 2) / fieldCell));
      for (let j = j0; j <= j1; j++) {
        const cz = -WORLD / 2 + j * fieldCell;
        for (let i = i0; i <= i1; i++) {
          const cx = -WORLD / 2 + i * fieldCell;
          const d = Math.hypot(cx - ox, cz - oz);
          if (d > rb) continue;
          const near = d <= r ? 1 : 1 - (d - r) / (rb - r);
          if (near > bank[j * w + i]) bank[j * w + i] = near;
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
  /* The lakes, and a spring's pool: a basin under the water, deepest in the
     middle, and wherever the ground round it falls away below the water, a
     low bank raised to hold it — water stands in a hollow, not on a slope. */
  for (const lake of lakes) {
    const out = lake.r * 1.25 + LAKE.berm + 2;
    const i0 = Math.max(0, Math.floor((lake.x - out + WORLD / 2) / fieldCell));
    const i1 = Math.min(fieldSeg, Math.ceil((lake.x + out + WORLD / 2) / fieldCell));
    const j0 = Math.max(0, Math.floor((lake.z - out + WORLD / 2) / fieldCell));
    const j1 = Math.min(fieldSeg, Math.ceil((lake.z + out + WORLD / 2) / fieldCell));
    const depth = lake.spring ? 1.1 : LAKE.depth, berm = lake.spring ? 3 : LAKE.berm;
    for (let j = j0; j <= j1; j++) {
      const cz = -WORLD / 2 + j * fieldCell;
      for (let i = i0; i <= i1; i++) {
        const cx = -WORLD / 2 + i * fieldCell;
        const d = Math.hypot(cx - lake.x, cz - lake.z);
        const shore = lakeRadius(lake, Math.atan2(cz - lake.z, cx - lake.x));
        const idx = j * w + i;
        const near = d <= shore ? 1 : Math.max(0, 1 - (d - shore) / (shore * 0.9 + 4));
        if (near > bank[idx]) bank[idx] = near;
        if (d < shore) {
          const t = d / shore;
          const floor = lake.level - depth * (1 - t * t) - 0.1;
          if (field[idx] > floor) field[idx] = floor;
          if (t < 0.9) wet[idx] = 1;
        } else if (d < shore + berm) {
          const hold = lake.level + 0.6 * (1 - (d - shore) / berm);
          if (field[idx] < hold) field[idx] = hold;
        }
      }
    }
  }
  // And everything that places things asks the field's own module (noise.js).
  setWaterCells(wet);
}

// One lookup instead of a distance test against every point of every creek.
export function isWet(x, z) {
  if (!wet) return false;
  const i = Math.round(clamp((x + WORLD / 2) / fieldCell, 0, fieldSeg));
  const j = Math.round(clamp((z + WORLD / 2) / fieldCell, 0, fieldSeg));
  return wet[j * (fieldSeg + 1) + i] === 1;
}

/* Still water: the sea's surface with none of its swell and none of a creek's
   flow, ripples off where it is. Made the first time there is a lake. */
let lakeMaterial = null;
function lakeWater() {
  lakeMaterial ||= applyWaterShader(new THREE.MeshPhongMaterial({
    color: 0x28566a,
    specular: 0xffffff,
    shininess: 220,
    transparent: true,
    opacity: 0.86,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  }));
  return lakeMaterial;
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
        // Each bank its own reach, never more than the bend allows (bankL/bankR).
        const reach = half * (side > 0 ? (p.bankR ?? 1) : (p.bankL ?? 1));
        // Perpendicular to the direction of travel.
        pos[k * 3] = p.x + -dz * reach * side;
        pos[k * 3 + 1] = p.level + 0.22;
        pos[k * 3 + 2] = p.z + dx * reach * side;
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

  // And the still water: every lake a creek ends in, and every spring's pool.
  const SHORE = 48;
  for (const lake of lakes) {
    const pos = new Float32Array((SHORE + 1) * 3);
    pos[0] = lake.x; pos[1] = lake.level + 0.22; pos[2] = lake.z;
    const idx = [];
    for (let k = 0; k < SHORE; k++) {
      const a = (k / SHORE) * Math.PI * 2, r = lakeRadius(lake, a);
      pos[(k + 1) * 3] = lake.x + Math.cos(a) * r;
      pos[(k + 1) * 3 + 1] = lake.level + 0.22;
      pos[(k + 1) * 3 + 2] = lake.z + Math.sin(a) * r;
      idx.push(0, 1 + ((k + 1) % SHORE), 1 + k);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, lakeWater());
    mesh.receiveShadow = true;
    mesh.name = lake.spring ? 'spring' : 'lake';
    terrainGroup.add(mesh);
  }
}

/** How near a creek's bank this is, 0 to 1, between the four nearest cells so
    the dark ground fades out rather than stepping. */
export function bankAt(x, z) {
  if (!bank) return 0;
  const w = fieldSeg + 1;
  const fx = clamp((x + WORLD / 2) / fieldCell, 0, fieldSeg), fz = clamp((z + WORLD / 2) / fieldCell, 0, fieldSeg);
  const i = Math.min(fieldSeg - 1, Math.floor(fx)), j = Math.min(fieldSeg - 1, Math.floor(fz));
  const u = fx - i, v = fz - j;
  const at = (a, b) => bank[b * w + a];
  return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
}

/** Darkens ground by a creek toward wet earth: the terrain, the grass on it and
    the map all call this after groundColorAt, so all three agree on the banks. */
export function tintBank(x, z, out) {
  const b = bankAt(x, z);
  if (b > 0) out.lerp(C_BANK, b * 0.6);
  return out;
}

/* wet lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setWet(v) { wet = v; setWaterCells(v); if (!v) bank = null; }
