import * as THREE from 'three';
import { seasonUniforms } from './scene.js';
import { ORCHARD_BUCKET, HIDDEN, orchard, stats } from './world.js';
import { luck } from './clock.js';
import { $, r2 } from './save.js';
import { chronicle, logEvent, who } from './life.js';

/* -------------------------------------------------------------------------
   The orchard

   Fruit is picked off the trees you can see, rather than deducted from an
   abstraction: a forager who finishes a trip under a bearing tree strips what
   is within arm's reach, those instances go, and the count on the panel goes
   with them. It grows back over the following days, and only in a season that
   bears — nothing ripens in a snowdrift.
   ------------------------------------------------------------------------- */

export const ORCHARD = {
  reach: 7,            // metres a forager can strip from where they stood
  takes: 6,            // most they will take from one spot
  /* A supplement, not a second harvest. At 0.09 a forager standing under a
     tree brought home more fruit than forage and roughly doubled the food
     supply; this is about a third on top of a trip that lands well, which is
     what "there is fruit here" ought to be worth. */
  worth: 0.02,         // food units a fruit is worth
  regrow: 0.50,        // share of the missing fruit that returns per sim-day
};

export const _fm4 = new THREE.Matrix4();

/** Puts one fruit back on its tree, or takes it off. */
export function setFruit(i, on) {
  if (!orchard || Boolean(orchard.on[i]) === on) return;
  orchard.on[i] = on ? 1 : 0;
  if (on) {
    _fm4.fromArray(orchard.home, i * 16);
    orchard.mesh.setMatrixAt(i, _fm4);
    orchard.ripe++;
  } else {
    orchard.mesh.setMatrixAt(i, HIDDEN);
    orchard.ripe--;
  }
  orchard.mesh.instanceMatrix.needsUpdate = true;
  stats.fruit = orchard.ripe;
}

/* What one forager takes from where they are standing. Returns the food it was
   worth, which is nothing at all if they finished their trip on bare ground —
   which is the point: fruit is somewhere in particular. */
export function pickFruit(x, z, reach = ORCHARD.reach, takes = ORCHARD.takes) {
  if (!orchard) return 0;
  const r2 = reach * reach;
  let taken = 0;
  /* Only the fruit hanging near enough to matter. This walked every fruit on
     the island — and walked all of them precisely when there were none within
     reach, which is most trips. See the note where the buckets are built. */
  const cell = ORCHARD_BUCKET;
  const i0 = Math.floor((x - reach) / cell), i1 = Math.floor((x + reach) / cell);
  const j0 = Math.floor((z - reach) / cell), j1 = Math.floor((z + reach) / cell);
  for (let bi = i0; bi <= i1 && taken < takes; bi++) {
    for (let bj = j0; bj <= j1 && taken < takes; bj++) {
      const here = orchard.buckets?.get(`${bi},${bj}`);
      if (!here) continue;
      for (let n = 0; n < here.length && taken < takes; n++) {
        const i = here[n];
        if (!orchard.on[i]) continue;
        const b = i * 16;
        const dx = orchard.home[b + 12] - x, dz = orchard.home[b + 14] - z;
        if (dx * dx + dz * dz > r2) continue;
        setFruit(i, false);
        taken++;
      }
    }
  }
  if (taken) logFruit(taken, x, z);
  return taken * ORCHARD.worth;
}

/** The nearest ripe fruit to here within reach, as a place — for the ring
    under its tree. Found in the buckets, without a draw from the stream. */
export function nearestRipeFruit(x, z, reach) {
  if (!orchard) return null;
  const cell = ORCHARD_BUCKET;
  let best = null, bestD = reach * reach;
  for (let bi = Math.floor((x - reach) / cell); bi <= Math.floor((x + reach) / cell); bi++) {
    for (let bj = Math.floor((z - reach) / cell); bj <= Math.floor((z + reach) / cell); bj++) {
      const here = orchard.buckets?.get(bi + ',' + bj);
      if (!here) continue;
      for (const i of here) {
        if (!orchard.on[i]) continue;
        const fx = orchard.home[i * 16 + 12], fz = orchard.home[i * 16 + 14];
        const d = (fx - x) ** 2 + (fz - z) ** 2;
        if (d < bestD) { bestD = d; best = { x: fx, z: fz }; }
      }
    }
  }
  return best;
}

/** How much fruit hangs within reach of here — counted, not picked, and
    without a draw from the stream, so a frame can ask it for the prompt. The
    same buckets pickFruit walks, for the same reason. */
export function fruitNear(x, z, reach = ORCHARD.reach) {
  if (!orchard) return 0;
  const r2 = reach * reach, cell = ORCHARD_BUCKET;
  let n = 0;
  for (let bi = Math.floor((x - reach) / cell); bi <= Math.floor((x + reach) / cell); bi++) {
    for (let bj = Math.floor((z - reach) / cell); bj <= Math.floor((z + reach) / cell); bj++) {
      const here = orchard.buckets?.get(bi + ',' + bj);
      if (!here) continue;
      for (const i of here) {
        if (!orchard.on[i]) continue;
        const dx = orchard.home[i * 16 + 12] - x, dz = orchard.home[i * 16 + 14] - z;
        if (dx * dx + dz * dz <= r2) n++;
      }
    }
  }
  return n;
}

/* Somewhere with fruit still on it, for something that eats fruit to walk to.
   Sampling rather than searching: a few random draws out of the whole orchard
   finds the nearest bearing tree well enough, and does not cost a pass over
   five thousand instances every time an animal decides where to go. */
export function nearestFruit(x, z, within) {
  if (!orchard || orchard.ripe <= 0) return null;
  const n = orchard.on.length;
  let best = null, bestD = within * within;
  for (let t = 0; t < 24; t++) {
    const i = (luck() * n) | 0;
    if (!orchard.on[i]) continue;
    const b = i * 16;
    const fx = orchard.home[b + 12], fz = orchard.home[b + 14];
    const d = (fx - x) ** 2 + (fz - z) ** 2;
    if (d < bestD) { bestD = d; best = { x: fx, z: fz }; }
  }
  return best;
}

/* Only worth a line in the chronicle when a camp strips a tree bare — one
   forager taking six berries is not news. */
export let strippedSince = 0;
export function logFruit(n, x, z) {
  strippedSince += n;
  if (orchard.ripe === 0 && strippedSince > 0) {
    logEvent('forage', 'the last of the fruit is picked', x, z);
    strippedSince = 0;
  }
}

/* Back onto the trees. Proportional to how much is missing, so an orchard that
   has been stripped fills slowly at first and then faster — and nothing ripens
   in a season that does not bear. */
export function regrowFruit(days) {
  if (!orchard || orchard.ripe >= orchard.on.length) return;
  const season = seasonUniforms.uFruit.value;
  if (season <= 0.02) return;
  const missing = orchard.on.length - orchard.ripe;
  let back = missing * ORCHARD.regrow * season * days;
  // Fractional growth would never round up to a whole fruit on a short frame,
  // so it is carried and spent as one when it reaches one.
  orchard.debt = (orchard.debt || 0) + back;
  let n = Math.floor(orchard.debt);
  if (n <= 0) return;
  orchard.debt -= n;
  for (let i = 0; i < orchard.on.length && n > 0; i++) {
    // Start somewhere different each time or the same trees always fill first.
    const k = (i + orchard.cursor | 0) % orchard.on.length;
    if (orchard.on[k]) continue;
    setFruit(k, true);
    n--;
  }
  orchard.cursor = ((orchard.cursor | 0) + 37) % orchard.on.length;
  strippedSince = 0;
}
