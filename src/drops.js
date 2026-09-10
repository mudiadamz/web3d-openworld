import * as THREE from 'three';

import { P } from './params.js';
import { sampleHeight } from './noise.js';
import { scene } from './scene.js';
import { HIDDEN, _c, _m4, _q, _s, _v } from './world.js';
import { heapGeo } from './people.js';
import { simDay } from './life.js';

/* -------------------------------------------------------------------------
   Things put down

   G used to empty the basket onto nothing: a morning's berries, gone, to get
   somebody moving again. Now what is put down stays where it was put, as a
   pile on the ground, and E picks it up again. One handful at a time — ten
   berries, five fruit, a fish, a stone, an animal — and in front of wherever
   they are standing, so a basket can be lightened a handful here and a handful
   there, and a pile put down in the same spot as another of its kind joins it.

   Food left lying spoils: after a few days it is gone, the way a store
   without curing loses what it holds. Stone, ore and wood keep.
   ------------------------------------------------------------------------- */
export const DROP = {
  max: 160,            // piles on the ground at once; the oldest goes past this
  keeps: 3,            // sim-days food lasts on the ground
  merge: 1.2,          // metres within which a pile joins one of its kind
  ahead: 0.9,          // how far in front of them it lands
};
export const PICKUP_REACH = 1.8;       // metres from a pile that E picks it up from
export const drops = [];
let dropMesh = null, dropsSeed = null, dirty = false;

const COLOUR = {
  berries: 0x7a2a45, fruit: 0xc7462c, fish: 0x9fb0b8, game: 0x6e3630, food: 0x8a6a48,
  wood: 0x7a5a3a, stone: 0x7a746a, iron: 0x7e4630, bronze: 0x9c6a3c, silver: 0xaab4ba, gold: 0xcfa233,
};

/** A pile, the way you would say it. */
export function pileWords(d) {
  if (d.kind === 'game') {
    const a = d.animal || 'kill';
    return d.n === 1 ? (/^[aeiou]/.test(a) ? 'an ' : 'a ') + a : d.n + ' ' + a + 's';
  }
  if (d.kind === 'ore') {
    return !d.oreKind || d.oreKind === 'stone'
      ? d.n + (d.n === 1 ? ' stone' : ' stones') : d.n + ' ' + d.oreKind + ' ore';
  }
  if (d.kind === 'food') return 'food';
  if (d.kind === 'wood') return d.n === 1 ? 'a log' : d.n + ' logs';
  return d.n + ' ' + (d.kind === 'berries' && d.n === 1 ? 'berry' : d.kind);
}

/* A new island is a clean floor. Checked when anything touches the piles
   rather than hooked into the world's build, which is watched closely enough
   that one more call there moves other things out of place. */
function fresh() {
  if (dropsSeed === P.seed) return;
  drops.length = 0;
  dropsSeed = P.seed;
  dirty = true;
}

/** Puts `out` (from takeOut, in bag.js) down in front of them. */
export function putDown(p, out) {
  fresh();
  const a = (p.yaw || 0) + ((drops.length % 5) - 2) * 0.45;
  const x = p.x + Math.sin(a) * DROP.ahead, z = p.z + Math.cos(a) * DROP.ahead;
  const like = drops.find((d) => d.kind === out.kind && d.oreKind === (out.oreKind || null)
    && d.animal === (out.animal || null) && Math.hypot(d.x - x, d.z - z) < DROP.merge);
  if (like) {
    like.n += out.n;
    like.food += out.food;
    like.born = simDay;
  } else {
    if (drops.length >= DROP.max) drops.shift();
    drops.push({ x, z, kind: out.kind, n: out.n, food: out.food,
      animal: out.animal || null, oreKind: out.oreKind || null, born: simDay });
  }
  dirty = true;
}

export function removeDrop(d) {
  const i = drops.indexOf(d);
  if (i >= 0) { drops.splice(i, 1); dirty = true; }
}

/** The nearest pile to here within some distance, or null. */
export function nearestDrop(x, z, within) {
  let best = null, near = within;
  for (const d of drops) {
    const e = Math.hypot(d.x - x, d.z - z);
    if (e < near) { near = e; best = d; }
  }
  return best;
}

/** Every frame the world is drawn: food left lying spoils, and the piles are
    drawn where they lie. Built the first time there is a pile, not before. */
export function updateDrops() {
  fresh();
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    if (d.kind !== 'ore' && d.kind !== 'wood' && simDay - d.born > DROP.keeps) { drops.splice(i, 1); dirty = true; }
  }
  if (!dirty) return;
  dirty = false;
  if (!dropMesh) {
    if (!drops.length) return;
    dropMesh = new THREE.InstancedMesh(heapGeo(0.34, 0.12, 0.3),
      new THREE.MeshLambertMaterial({ color: 0xffffff }), DROP.max);
    dropMesh.frustumCulled = false;
    dropMesh.castShadow = true;
    dropMesh.receiveShadow = true;
    scene.add(dropMesh);
  }
  for (let i = 0; i < DROP.max; i++) {
    const d = drops[i];
    if (!d) { dropMesh.setMatrixAt(i, HIDDEN); continue; }
    const s = d.kind === 'game' ? 2.2 : 0.8 + Math.min(1.2, Math.cbrt(d.n) * 0.3);
    _q.identity();
    _v.set(d.x, sampleHeight(d.x, d.z), d.z);
    _s.set(s, s * 0.8, s);
    dropMesh.setMatrixAt(i, _m4.compose(_v, _q, _s));
    dropMesh.setColorAt(i, _c.setHex(COLOUR[d.kind === 'ore' ? (d.oreKind || 'stone') : d.kind] || COLOUR.food));
  }
  dropMesh.instanceMatrix.needsUpdate = true;
  if (dropMesh.instanceColor) dropMesh.instanceColor.needsUpdate = true;
}

/** For the save: short, like everything else in it. */
export function keptDrops() {
  const r = (v) => Math.round(v * 100) / 100;
  return drops.map((d) => [r(d.x), r(d.z), d.kind, d.n, Math.round(d.food * 1000) / 1000,
    d.animal || d.oreKind || null, r(d.born)]);
}

export function restoreDrops(list) {
  drops.length = 0;
  dropsSeed = P.seed;
  dirty = true;
  if (!Array.isArray(list)) return;
  for (const r of list) {
    if (!Array.isArray(r)) continue;
    const kind = String(r[2]);
    drops.push({ x: Number(r[0]) || 0, z: Number(r[1]) || 0, kind, n: r[3] | 0, food: Number(r[4]) || 0,
      animal: kind === 'game' ? r[5] : null, oreKind: kind === 'ore' ? r[5] : null, born: Number(r[6]) || 0 });
  }
}
