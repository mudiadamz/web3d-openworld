import * as THREE from 'three';

import { MAP_SCALE, P, SEA, WORLD } from './params.js';
import { flatnessAt, mulberry32, sampleHeight } from './noise.js';
import { HIDDEN, _c, _e, _m4, _q, _s, _v, thicketGroup } from './world.js';
import { forageRichness } from './larder.js';
import { CAMP_CLEARING, camps } from './people.js';
import { deposits } from './quarries.js';

/* -------------------------------------------------------------------------
   Berry thickets

   Foraging was a person standing in grass. The ground under them had a
   richness — the same noise that decides where the flowers grow — but nothing
   you could see said so, and E worked on a bare hillside as well as anywhere.

   So the richest ground has something on it: thickets of bushes, laid out
   with the island, with berries on them. How many berries is the ground's own
   richness, read again every couple of seconds — so a thicket a band has been
   picking thins out, a winter strips it, and a few quiet days put the berries
   back. It is the same number a forager's yield is worked out from; the
   berries are that number, drawn.

   A thicket is also where E forages, and the map's foraging marks are the
   thickets: the food you can see, the food on the map and the food E finds
   are one thing in three places.
   ------------------------------------------------------------------------- */
export const THICKET = {
  count: 26,           // on a 1600 m island, scaled by its area
  bushes: 7,           // in one thicket
  spread: 3.2,         // metres from its middle to the middle of its outermost bush
  bush: 0.66,          // the largest a bush is across its half-width
  berries: 6,          // on one bush when it is full
  apart: 60,           // metres between two thickets
  buffer: 1.0,         // past the outermost bush that still counts as at it
};
/* How close counts, for E and for the ring: the outermost bush, its own width,
   and a step. The thing and about a metre more — nothing like the old twelve. */
export const THICKET_REACH = THICKET.spread + THICKET.bush + THICKET.buffer;

export const thickets = [];
export let bushMesh = null, berryMesh = null;
let berryHome = null, berriesAt = -Infinity;

/* Laid out off the world seed, on the richest dry ground that is not a camp or
   a quarry, the richest first and kept apart — so the list is in order of how
   good the ground is, which is the order the map reads it in. */
export function buildThickets() {
  thickets.length = 0;
  bushMesh = berryMesh = null;
  berryHome = null;
  const rng = mulberry32(P.seed ^ 0x7b1c4e51);
  const want = Math.max(1, Math.round(THICKET.count * MAP_SCALE ** 2));
  const cand = [];
  for (let t = 0; t < want * 40; t++) {
    const x = (rng() - 0.5) * WORLD * 0.9, z = (rng() - 0.5) * WORLD * 0.9;
    if (sampleHeight(x, z) < SEA + 1.5 || flatnessAt(x, z) < 0.8) continue;
    if (camps.some((c) => Math.hypot(c.x - x, c.z - z) < CAMP_CLEARING)) continue;
    if (deposits.some((d) => Math.hypot(d.x - x, d.z - z) < 15)) continue;
    cand.push({ x, z, rich: forageRichness(x, z) });
  }
  cand.sort((a, b) => b.rich - a.rich);
  for (const c of cand) {
    if (thickets.length >= want) break;
    if (thickets.some((t) => Math.hypot(t.x - c.x, t.z - c.z) < THICKET.apart)) continue;
    thickets.push({ i: thickets.length, x: c.x, z: c.z, turn: rng() * Math.PI * 2,
      red: rng() < 0.55, shown: THICKET.berries });
  }
  drawThickets(rng);
}

/* The bushes, once, and every berry's place on its bush, so a berry can be put
   back where it grew rather than somewhere new. */
function drawThickets(rng) {
  if (!thickets.length) return;
  const nBush = thickets.length * THICKET.bushes;
  bushMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.55, 1),
    new THREE.MeshLambertMaterial({ color: 0xffffff }), nBush);
  berryMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.075, 0),
    new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x1a0306 }), nBush * THICKET.berries);
  berryHome = new Float32Array(nBush * THICKET.berries * 16);
  for (const m of [bushMesh, berryMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
  }
  for (const t of thickets) {
    for (let k = 0; k < THICKET.bushes; k++) {
      const slot = t.i * THICKET.bushes + k;
      const a = t.turn + (k / (THICKET.bushes - 1)) * Math.PI * 2 + rng() * 0.4;
      const r = k === 0 ? 0 : THICKET.spread * (0.55 + 0.45 * rng());
      const bx = t.x + Math.cos(a) * r, bz = t.z + Math.sin(a) * r;
      const s = 0.8 + 0.4 * rng();
      const by = sampleHeight(bx, bz) + 0.3 * s;
      _e.set(0, rng() * 6, 0);
      _q.setFromEuler(_e);
      _v.set(bx, by, bz);
      _s.set(s * 1.1, s * 0.8, s);
      bushMesh.setMatrixAt(slot, _m4.compose(_v, _q, _s));
      bushMesh.setColorAt(slot, _c.setHex(0x3f6b2e).multiplyScalar(0.8 + 0.3 * rng()));
      for (let j = 0; j < THICKET.berries; j++) {
        const b = slot * THICKET.berries + j;
        const ba = rng() * Math.PI * 2, up = 0.25 + 0.55 * rng();
        const reach = 0.55 * s;
        _q.identity();
        _v.set(bx + Math.cos(up) * Math.cos(ba) * reach * 1.1,
          by + Math.sin(up) * reach * 0.8, bz + Math.cos(up) * Math.sin(ba) * reach);
        _s.setScalar(0.9 + 0.3 * rng());
        _m4.compose(_v, _q, _s);
        _m4.toArray(berryHome, b * 16);
        berryMesh.setMatrixAt(b, _m4);
        berryMesh.setColorAt(b, _c.setHex(t.red ? 0xb3263f : 0x4b2f78).multiplyScalar(0.85 + 0.3 * rng()));
      }
    }
  }
  thicketGroup.add(bushMesh, berryMesh);
}

/* How ripe a thicket is: the ground's richness across it, in the middle and
   four bushes out, so picking at its edge thins it as surely as at its heart. */
function thicketRipe(t) {
  let rich = forageRichness(t.x, t.z);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    rich += forageRichness(t.x + Math.cos(a) * THICKET.spread, t.z + Math.sin(a) * THICKET.spread);
  }
  return Math.max(0, Math.min(1, (rich / 5 - 0.25) / 0.9));
}

/** Puts the berries back to what the ground says, every couple of seconds. */
export function updateThickets(now) {
  if (!berryMesh || now - berriesAt < 2) return;
  berriesAt = now;
  let dirty = false;
  for (const t of thickets) {
    const n = Math.round(thicketRipe(t) * THICKET.berries);
    if (n === t.shown) continue;
    t.shown = n;
    dirty = true;
    for (let k = 0; k < THICKET.bushes; k++) {
      for (let j = 0; j < THICKET.berries; j++) {
        const b = (t.i * THICKET.bushes + k) * THICKET.berries + j;
        if (j < n) berryMesh.setMatrixAt(b, _m4.fromArray(berryHome, b * 16));
        else berryMesh.setMatrixAt(b, HIDDEN);
      }
    }
  }
  if (dirty) berryMesh.instanceMatrix.needsUpdate = true;
}

/** What a thicket has on it, in words. */
export function ripeWord(t) {
  if (t.shown >= THICKET.berries * 0.7) return 'full of berries';
  return t.shown > 0 ? 'some berries' : 'picked bare';
}

/** The nearest thicket to here within some distance, or null. */
export function nearestThicket(x, z, within) {
  let best = null, near = within;
  for (const t of thickets) {
    const d = Math.hypot(t.x - x, t.z - z);
    if (d < near) { near = d; best = t; }
  }
  return best;
}

/** The thicket this spot is at, if it is at one. */
export function thicketNear(x, z) {
  return nearestThicket(x, z, THICKET_REACH);
}
