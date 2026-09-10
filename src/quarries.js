import * as THREE from 'three';

import { MAP_SCALE, P, SEA, WORLD } from './params.js';
import { flatnessAt, mulberry32, sampleHeight } from './noise.js';
import { rockMaterial } from './scene.js';
import { HIDDEN, _c, _e, _m4, _q, _s, _v, depositGroup } from './world.js';
import { CAMP_CLEARING, camps } from './people.js';
import { SKILL } from './skills.js';
import { logEvent } from './life.js';

/* -------------------------------------------------------------------------
   Quarries

   There was one quarry per band, and it was whichever boulder happened to lie
   nearest the fire: every trip for eighty years went to the same rock, and two
   bands on one hillside dug the same hole. Stone was the only thing that came
   out of the ground.

   So the ground has deposits now — places worth digging, laid out with the
   island — and five kinds of rock in them, in the quantities they come in:
   stone everywhere and plenty of it, iron in a handful of places, the ore that
   makes bronze in fewer, silver in two or three seams, and gold in one or two
   small ones up in the rough ground. Each holds a fixed amount and gives it up
   a trip at a time; what stands on the hillside is the size of what is left,
   and a seam that is worked out is gone.

   Stone goes on the pile that toolmaking eats, the way it always did. The
   metals are carried home and kept, and nothing uses them yet — they are what
   a band has dug, shown on its card and worth a line in the chronicle.
   ------------------------------------------------------------------------- */
export const ORES = {
  /* sites: how many on a 1600 m island, scaled by area. amount: what one holds.
     flat: the flattest ground it will sit on — the rarer the metal, the rougher
     the country it is found in. reach: how far a band will walk for it. per:
     what one trip brings back, before the band is any good at it. rock: the
     colour it stands in on the hillside; mark: the colour of its map mark. */
  stone:  { label: 'stone',  sites: 14, amount: [150, 400], flat: 0.95, reach: 220, per: 1, want: 1,   rock: 0x8a847a, mark: '#bdb6aa' },
  iron:   { label: 'iron',   sites: 6,  amount: [30, 70],   flat: 0.90, reach: 360, per: 2, want: 0.8, rock: 0x7e4630, mark: '#c0603f' },
  bronze: { label: 'bronze', sites: 4,  amount: [20, 45],   flat: 0.88, reach: 400, per: 2, want: 0.7, rock: 0x9c6a3c, mark: '#d6934f' },
  silver: { label: 'silver', sites: 3,  amount: [8, 20],    flat: 0.86, reach: 450, per: 1, want: 0.6, rock: 0xaab4ba, mark: '#dde5ea' },
  gold:   { label: 'gold',   sites: 2,  amount: [3, 10],    flat: 0.84, reach: 500, per: 1, want: 0.6, rock: 0xcfa233, mark: '#f2c84b' },
};
export const ORE_KINDS = Object.keys(ORES);
export const DEPOSIT_APART = 70;       // metres between two deposits
export const PER_DEPOSIT = 4;          // rocks in one deposit's heap
export const DIG_REACH = 7;            // metres past its edge that still counts as at it
export const deposits = [];
export let depositMesh = null;

/** How big a deposit stands, from how much is left in it. One rule for all
    five, so a gold seam is small because there is little gold in it, and a
    stone quarry dug for fifty years has shrunk toward the size of one. */
export function depositRadius(d) {
  return d.left > 0 ? 0.8 + 1.5 * Math.cbrt(d.left / 100) : 0;
}

/* Laid out with the island, off its own stream of the world seed, so the same
   seed puts the same seams in the same places — which is what lets a save say
   how much is left in each by position in the list and nothing else. Never in
   a camp's clearing and never on top of another deposit. */
export function buildDeposits() {
  deposits.length = 0;
  const rng = mulberry32(P.seed ^ 0x0de905e7);
  const area = MAP_SCALE ** 2;
  for (const [kind, ore] of Object.entries(ORES)) {
    const want = Math.max(1, Math.round(ore.sites * area));
    for (let n = 0, t = 0; n < want && t < want * 200; t++) {
      const x = (rng() - 0.5) * WORLD * 0.9;
      const z = (rng() - 0.5) * WORLD * 0.9;
      const h = sampleHeight(x, z);
      if (h < SEA + 2) continue;
      if (flatnessAt(x, z) > ore.flat) continue;
      if (deposits.some((d) => Math.hypot(d.x - x, d.z - z) < DEPOSIT_APART)) continue;
      if (camps.some((c) => Math.hypot(c.x - x, c.z - z) < CAMP_CLEARING + 10)) continue;
      const full = Math.round(ore.amount[0] + rng() * (ore.amount[1] - ore.amount[0]));
      deposits.push({ i: deposits.length, kind, x, z, full, left: full, turn: rng() * Math.PI * 2 });
      n++;
    }
  }
  drawDeposits();
}

/* One mesh for every deposit on the island, a heap of four rocks each, in the
   colour of what it is. */
function drawDeposits() {
  depositMesh = null;
  if (!deposits.length) return;
  depositMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), rockMaterial,
    deposits.length * PER_DEPOSIT);
  depositMesh.castShadow = true;
  depositMesh.receiveShadow = true;
  depositMesh.frustumCulled = false;
  for (const d of deposits) {
    for (let k = 0; k < PER_DEPOSIT; k++) {
      depositMesh.setColorAt(d.i * PER_DEPOSIT + k,
        _c.setHex(ORES[d.kind].rock).multiplyScalar(0.85 + 0.1 * k));
    }
    dressDeposit(d);
  }
  depositGroup.add(depositMesh);
}

/** Puts a deposit's heap back at the size of what is left in it. */
export function dressDeposit(d) {
  if (!depositMesh) return;
  const r = depositRadius(d);
  for (let k = 0; k < PER_DEPOSIT; k++) {
    const slot = d.i * PER_DEPOSIT + k;
    if (r <= 0) { depositMesh.setMatrixAt(slot, HIDDEN); continue; }
    const a = d.turn + k * 2.1;
    const off = k === 0 ? 0 : r * 0.62;
    const size = k === 0 ? r : r * (0.42 + 0.08 * k);
    const x = d.x + Math.cos(a) * off, z = d.z + Math.sin(a) * off;
    _e.set(d.turn + k, a, k * 0.7);
    _q.setFromEuler(_e);
    _v.set(x, sampleHeight(x, z) - size * 0.3, z);
    _s.set(size, size * 0.72, size * 0.9);
    depositMesh.setMatrixAt(slot, _m4.compose(_v, _q, _s));
  }
  depositMesh.instanceMatrix.needsUpdate = true;
}

/* What a deposit is worth to this band today: nothing if it is worked out,
   out of reach, or stone the band has no room for; otherwise what the rock is
   wanted for, less the walk. */
function worth(d, camp, stoneFull) {
  if (d.left <= 0) return 0;
  if (d.kind === 'stone' && stoneFull) return 0;
  const ore = ORES[d.kind];
  const dist = Math.hypot(d.x - camp.x, d.z - camp.z);
  if (dist > ore.reach) return 0;
  return ore.want / (1 + dist / 120);
}

/** Whether there is anywhere worth digging for this band at all. */
export function quarryInReach(camp, stoneFull) {
  for (const d of deposits) if (worth(d, camp, stoneFull) > 0) return true;
  return false;
}

const _w = [];
/** Somewhere to dig today, rolled among everything worth the walk rather than
    the nearest — so a band works the stone by its door and, now and then,
    walks to the iron over the ridge. Draws from the step's stream, so it is
    only ever called from the step. */
export function pickDeposit(camp, luck, stoneFull) {
  let total = 0;
  _w.length = 0;
  for (const d of deposits) {
    const v = worth(d, camp, stoneFull);
    _w.push(v);
    total += v;
  }
  if (total <= 0) return null;
  let r = luck() * total;
  for (let k = 0; k < deposits.length; k++) {
    if (_w[k] <= 0) continue;
    r -= _w[k];
    if (r <= 0) return deposits[k];
  }
  // Rounding at the very end of the list: the last one worth anything.
  for (let k = deposits.length - 1; k >= 0; k--) if (_w[k] > 0) return deposits[k];
  return null;
}

/** Takes up to `amount` out of a deposit, in whole pieces, and shrinks it. */
export function mineDeposit(d, amount) {
  const took = Math.min(d.left, Math.max(0, Math.round(amount)));
  if (took <= 0) return 0;
  d.left -= took;
  dressDeposit(d);
  return took;
}

/* -------------------------------------------------------------------------
   What comes out of the ground

   Stone goes on the pile the toolmaking eats, capped as it always was. The
   metals are kept — iron, bronze, silver, gold — and nothing uses them yet:
   they are what a band has dug and carried home, shown on its card, and the
   first of each is worth a line in the chronicle.
   ------------------------------------------------------------------------- */
export function storeOre(camp, kind, n) {
  if (!(n > 0) || !kind) return;
  if (kind === 'stone') {
    camp.stone = Math.min(SKILL.stoneMax, (camp.stone || 0) + n);
    return;
  }
  camp.ores ||= {};
  const first = !(camp.ores[kind] > 0);
  camp.ores[kind] = (camp.ores[kind] || 0) + n;
  if (first) logEvent('find', `[${camp.code}] ${camp.name} brought home their first ${kind}`, camp.x, camp.z);
}
