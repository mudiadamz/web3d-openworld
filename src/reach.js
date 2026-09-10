import * as THREE from 'three';

import { SEA } from './params.js';
import { sampleHeight } from './noise.js';
import { scene } from './scene.js';
import { camps, inStoreArea } from './people.js';
import { ORES, depositRadius, deposits } from './quarries.js';
import { predatorNear, preyNear } from './spear.js';
import { fruitNear, nearestRipeFruit } from './orchard.js';
import { bagWords, hasLoad } from './bag.js';
import { treeNear } from './danger.js';
import { WOOD } from './wood.js';
import { THICKET_REACH, nearestThicket, ripeWord } from './thickets.js';
import { PICKUP_REACH, nearestDrop, pileWords } from './drops.js';
import { CARCASS_REACH, carcassNear } from './spear.js';
import { dockOf, fishRichness } from './larder.js';
import { RAFT, raftBusy } from './rafts.js';

export { thicketNear } from './thickets.js';

/* -------------------------------------------------------------------------
   What is within reach

   E does whatever is in front of them: pick the fruit off the tree they are
   under, forage a berry thicket, fish the water at their feet, dig the quarry
   they are standing at, tend the fire, or throw a spear at the nearest animal
   in reach — and inside the ring round the granaries, put away what they are
   carrying.

   Every one of those is a place with an edge, and the edge is the thing itself
   and about a metre more: the ring of stones round a fire, the heap of a
   quarry, the outermost bush of a thicket, the canopy of a fruit tree, the
   water's edge. A throw is the one that is a range rather than a place. A ring
   goes down on the nearest of each within SHOW_WITHIN, pale, and the one E
   would act on turns green — so what E will do is something you can see before
   you press it, the way the storage ring already was.

   Worked out a few times a second, off nothing that draws: the fruit is found
   in its buckets, the animal is the nearest one in a list, the water is walked
   out to along twelve bearings. What E does with it is done in the step.
   ------------------------------------------------------------------------- */
export const THROW_REACH = 16;         // metres: the same as THROW.reach in spear.js
export const FIRE_REACH = 2.3;         // the ring of stones sits 1.15 m out
export const DIG_BUFFER = 1.0;         // past the edge of a quarry's heap
export const FRUIT_REACH = 3.5;        // from the nearest ripe fruit: under its tree
export const WATER_REACH = 3.5;        // from the water's edge
export const SHOW_WITHIN = 25;         // how near a thing is before its ring goes down
/* The storage ring's own two colours (STORE_RING_IN and _OUT in chronicle.js),
   so green means "E works here" wherever it is on the ground. */
export const RING_ON = 0x8fd18a, RING_OFF = 0xe8c872;
export const RING_DANGER = 0xe2574c;   // under a tiger, unless it is what E will do
const HUNT_RING = 1.3;                 // under an animal
const WATER_RING = 1.4;                // at the water's edge

/* The nearest water to here within reach, as a point: out along twelve
   bearings a metre at a time until one of them gets wet. */
function nearestWater(x, z, within) {
  let best = null, near = within;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    for (let r = 0.5; r < near; r += 1) {
      const wx = x + ca * r, wz = z + sa * r;
      if (sampleHeight(wx, wz) < SEA) { near = r; best = { x: wx, z: wz, d: r }; break; }
    }
  }
  return best;
}

/** Everything E could act on near this person — the nearest of each kind,
    with where it is, how wide its ring is, and whether they are in it. */
export function actionTargets(p) {
  const out = [];
  const at = (x, z) => Math.hypot(x - p.x, z - p.z);
  /* On the raft: the fish under it — worth more the deeper the water — and
     the dock to tie up at. Nothing on land is in reach from out here. */
  if (p.onRaft) {
    const worth = fishRichness(p.x, p.z, p.onRaft);
    out.push({ kind: 'fish', x: p.x, z: p.z, r: WATER_RING, wet: true, on: true,
      words: 'fish · ' + (worth > 0.45 ? 'good deep water' : worth > 0.1 ? 'deep water' : 'shallow — the fish are further out') });
    const moor = dockOf(p.onRaft);
    if (moor) {
      out.push({ kind: 'moor', x: moor.mx, z: moor.mz, r: RAFT.reach, wet: true,
        on: at(moor.mx, moor.mz) < RAFT.reach, words: 'tie up at the dock' });
    }
    return out;
  }
  /* A tiger, before anything: a spear is the one answer to it that is E. */
  const tiger = predatorNear(p.x, p.z, SHOW_WITHIN);
  if (tiger) {
    const d = at(tiger.animal.x, tiger.animal.z);
    out.push({ kind: 'hunt', what: 'fight', prey: tiger, animal: tiger.animal, r: HUNT_RING, danger: true,
      on: d < THROW_REACH, words: 'throw at the ' + tiger.pack.spec.key });
  }
  /* Something they brought down, lying where it fell: pick it up. */
  const body = carcassNear(p.x, p.z, SHOW_WITHIN);
  if (body) {
    const r = CARCASS_REACH * Math.max(1, body.animal.scale || 1);
    out.push({ kind: 'carcass', carcass: body, animal: body.animal, r,
      on: at(body.animal.x, body.animal.z) < r, words: 'pick up the ' + body.pack.spec.key });
  }
  /* Something put down: a pile to pick back up. */
  const pile = nearestDrop(p.x, p.z, SHOW_WITHIN);
  if (pile) {
    out.push({ kind: 'pickup', pile, x: pile.x, z: pile.z, r: PICKUP_REACH,
      on: at(pile.x, pile.z) < PICKUP_REACH, words: 'pick up ' + pileWords(pile) });
  }
  const prey = preyNear(p.x, p.z, SHOW_WITHIN);
  if (prey) {
    const d = at(prey.animal.x, prey.animal.z);
    out.push({ kind: 'hunt', prey, animal: prey.animal, r: HUNT_RING, on: d < THROW_REACH,
      words: 'throw at the ' + prey.pack.spec.key + ' · ' + Math.round(d) + ' m' });
  }
  let dep = null, depOff = SHOW_WITHIN;
  for (const q of deposits) {
    if (q.left <= 0) continue;
    const off = at(q.x, q.z) - depositRadius(q);
    if (off < depOff) { depOff = off; dep = q; }
  }
  if (dep) {
    const r = depositRadius(dep) + DIG_BUFFER;
    out.push({ kind: 'dig', deposit: dep, x: dep.x, z: dep.z, r, on: at(dep.x, dep.z) < r,
      words: 'dig ' + ORES[dep.kind].label + ' · ' + dep.left + ' left' });
  }
  /* A tree, close by: E cuts a log or two off it (wood.js). */
  const tree = treeNear(p.x, p.z, WOOD.show);
  if (tree) {
    out.push({ kind: 'wood', x: tree.x, z: tree.z, r: WOOD.reach, on: at(tree.x, tree.z) < WOOD.reach,
      words: 'cut wood' });
  }
  /* No fishing from the bank: the fish are out in deep water. The band's
     raft, riding at its dock, is how to get to them. */
  const dock = p.camp?.raft ? dockOf(p.camp) : null;
  if (dock && !raftBusy(p.camp) && at(dock.x, dock.z) < SHOW_WITHIN) {
    out.push({ kind: 'raft', x: dock.mx, z: dock.mz, r: 2.2, wet: true,
      on: at(dock.x, dock.z) < RAFT.reach, words: 'take the raft out' });
  }
  let fire = null, fireD = SHOW_WITHIN;
  for (const c of camps) {
    for (let f = 0; f < (c.hearths || 0); f++) {
      const h = c.fireAt?.[f];
      if (!h) continue;
      const d = at(h.x, h.z);
      if (d < fireD) { fireD = d; fire = h; }
    }
  }
  if (fire) out.push({ kind: 'tend', x: fire.x, z: fire.z, r: FIRE_REACH, on: fireD < FIRE_REACH, words: 'tend the fire' });
  const fruit = nearestRipeFruit(p.x, p.z, SHOW_WITHIN);
  if (fruit) {
    out.push({ kind: 'gather', what: 'fruit', x: fruit.x, z: fruit.z, r: FRUIT_REACH,
      on: at(fruit.x, fruit.z) < FRUIT_REACH, words: 'pick fruit · ' + fruitNear(p.x, p.z) + ' ripe' });
  }
  const th = nearestThicket(p.x, p.z, SHOW_WITHIN);
  if (th) {
    const d = at(th.x, th.z);
    out.push({ kind: 'gather', what: 'forage', x: th.x, z: th.z, r: THICKET_REACH, on: d < THICKET_REACH,
      words: 'forage · ' + ripeWord(th) });
  }
  return out;
}

/* The order E takes them in when more than one is in reach: an animal first,
   because it will not wait; then the places; the ground last. */
const FIRST = ['fight', 'carcass', 'pickup', 'moor', 'raft', 'hunt', 'dig', 'wood', 'fish', 'tend', 'fruit', 'forage'];
let shown = [], shownFor = null, chosen = null;

/** What E would do for this person where they stand, or null — and the rings
    on the ground are drawn from the same answer, so they cannot disagree. */
export function whatHere(p) {
  shown = actionTargets(p);
  shownFor = p;
  chosen = null;
  /* Carrying something and in the storage area: put it away. First, because
     that is what somebody walking in with a full basket is there to do. */
  if (hasLoad(p) && inStoreArea(p)) {
    return { kind: 'store', words: 'put away ' + (bagWords(p.bag) || 'what you carry') };
  }
  for (const k of FIRST) {
    const t = shown.find((c) => c.on && (c.kind === k || c.what === k));
    if (t) { chosen = t; return t; }
  }
  return null;
}

/* -------------------------------------------------------------------------
   The rings

   One instanced mesh of flat rings, a ring each for the nearest of every kind
   of thing within SHOW_WITHIN, pale — and green for the one E would act on.
   Built the first time there is something to ring, and not before, for the
   reason the lead ring gives: an object made on the first frame spends draws
   the boot check's pinned world depends on.
   ------------------------------------------------------------------------- */
export let actionRings = null;
const RING_MAX = 8;
const _rc = new THREE.Color(), _rm = new THREE.Matrix4();
const _rp = new THREE.Vector3(), _rs = new THREE.Vector3(), _rq = new THREE.Quaternion();

/** Every frame: the rings for whoever you are behind, or none. An animal's
    ring moves with the animal between the times the list is worked out. */
export function updateActionRings(p) {
  const list = p && shownFor === p ? shown : null;
  if (!list || !list.length) { if (actionRings) actionRings.count = 0; return; }
  if (!actionRings) {
    const geo = new THREE.RingGeometry(0.9, 1, 48);
    geo.rotateX(-Math.PI / 2);
    actionRings = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.8, depthWrite: false,
    }), RING_MAX);
    actionRings.frustumCulled = false;
    actionRings.renderOrder = 3;
    scene.add(actionRings);
  }
  let n = 0;
  for (const t of list) {
    if (n >= RING_MAX) break;
    const x = t.animal ? t.animal.x : t.x, z = t.animal ? t.animal.z : t.z;
    const y = Math.max(sampleHeight(x, z), t.wet ? SEA : -Infinity) + 0.2;
    _rp.set(x, y, z);
    _rs.set(t.r, 1, t.r);
    actionRings.setMatrixAt(n, _rm.compose(_rp, _rq, _rs));
    actionRings.setColorAt(n, _rc.setHex(t === chosen ? RING_ON : RING_OFF));
    if (t.danger && t !== chosen) actionRings.setColorAt(n, _rc.setHex(RING_DANGER));
    n++;
  }
  actionRings.count = n;
  actionRings.instanceMatrix.needsUpdate = true;
  if (actionRings.instanceColor) actionRings.instanceColor.needsUpdate = true;
}

/** The colours the rings are drawn in now, for the boot check. */
export function ringHexes() {
  const out = [];
  for (let i = 0; actionRings && i < actionRings.count; i++) {
    actionRings.getColorAt(i, _rc);
    out.push(_rc.getHex());
  }
  return out;
}
