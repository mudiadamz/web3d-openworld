import * as THREE from 'three';

import { CAMP_CEILING, MAP_SCALE, P, PEOPLE_ROOM, QUALITY, SEA, SNOW } from './params.js';
import { clamp, flatnessAt, mulberry32, sampleHeight, clearOfCreeks, inWater } from './noise.js';
import { faunaMaterial, rockMaterial } from './scene.js';
import { HIDDEN, _c, _e, _m4, _q, _s, _v, refillTilesNear, stats, treeSpots, world } from './world.js';
import { recordPerson, setLineage, tribeVoice, uniqueName, usedCodes, usedNames } from './wildlife.js';
import { PERSON, PERSON_PARTS, partsPer } from './clock.js';
import { HUMAN_PARTS } from 'humans-threejs/human-parts.js';
import { buildLooks, clearLooks, growLooks, undressAll } from './looks.js';
import {
  FOOD, LIFE, chiefOf, emptySkills, hidePeopleFrom, nearestShore, newPerson, peopleCapacity, personAge, setPeopleCapacity, simDay
} from './life.js';
import { codeColor, takeTribeCode } from './ui.js';
import { FIELD, dressField, farmGeometries } from './farming.js';
import { HOUSE_KEYS, TENT_KEYS, tentGeometries, tentMaterial, tentStyle } from './village.js';
import { campReach, CITY, cityPlotsFor, CIVIC, claimCivic, dressCivic, dressOutskirts, extendOutskirts, makeHouses, OUTSKIRTS } from './settlement.js';
export { CITY, CIVIC, OUTSKIRTS, campReach, claimCivic, cityPlotsFor, dressCivic, dressOutskirts, extendOutskirts, storeKind } from './settlement.js';
/* The outskirts and what a larger place builds were lifted out into settlement.js
   when this file passed the length of the page it came from; see there. */

/* -------------------------------------------------------------------------
   Bodies

   Everything alive used to be boxes, which reads as blocky at any distance you
   can actually see a limb at. These are the two replacements, and both take the
   same three numbers a BoxGeometry took and occupy the same space — so every
   pivot, offset and scale in the rigs below still means what it meant.

   The cost is real: an ellipsoid is 40-80 triangles against a box's 12. It is
   spent per instance, and there can be two hundred people and two hundred
   animals, so how round anything is comes off the quality preset — LOW keeps
   the boxes it always had.

   People are no longer made of these. Their bodies are the humans-threejs
   model — see buildPeople — and what is left here is the animals, and on a
   person the hair and the spear.
   ------------------------------------------------------------------------- */

/* Measured rather than guessed: at HIGH these take the scene from 1.85M
   triangles to 2.06M, about a nine percent rise, because a world of this size
   is grass and terrain and the bodies in it are a rounding error. Roundness was
   the cheapest thing on the list. */
export const ROUND_RINGS = [[0, 0], [8, 5], [10, 7]];       // [radial, rings] per level

/** A box-shaped ellipsoid: same width, height and depth, none of the corners. */
export function roundBox(w, h, d) {
  const [seg, rings] = ROUND_RINGS[QUALITY[P.quality]?.round ?? 2];
  if (!seg) return new THREE.BoxGeometry(w, h, d);
  const g = new THREE.SphereGeometry(0.5, seg, rings);
  g.scale(w, h, d);
  return g;
}

/** A limb: round in cross-section, domed at both ends, filling the same box. */
export function roundLimb(w, h, d) {
  const [seg] = ROUND_RINGS[QUALITY[P.quality]?.round ?? 2];
  if (!seg) return new THREE.BoxGeometry(w, h, d);
  /* The cap radius comes off the thinner cross-section so the capsule stays
     inside the box it replaces, and the other axis is scaled back out to it.
     A limb shorter than it is thick has no barrel left, so it falls back to a
     plain ellipsoid rather than asking for a negative length. */
  const r = Math.min(w, d) * 0.5;
  const len = h - r * 2;
  if (len <= 0.001) return roundBox(w, h, d);
  const g = new THREE.CapsuleGeometry(r, len, 2, seg);
  g.scale(w / (r * 2), 1, d / (r * 2));
  return g;
}

/* The model is 1.735 m to the crown and the old figure was 1.67, so every scale
   is 1.67 / 1.735 of what it was: the same people, the same heights, a
   different body. Shoulder and hip are 1 for a grown man or woman because the
   difference between them is in the model's joints now (PERSON.armXF, hipXF);
   what is left is a child being narrower than the adult they grow into. Hair
   is not here any more: it is a style, one of the library's (looks.js). */
export const BUILDS = {
  m:     { scale: [0.963, 1.030], shoulder: 1.00, hip: 1.00, head: 1.00 },
  f:     { scale: [0.886, 0.943], shoulder: 1.00, hip: 1.00, head: 1.00 },
  child: { scale: [0.558, 0.731], shoulder: 0.95, hip: 0.98, head: 1.18 },
};

/* humans-threejs's eight skin tones, light to dark, and its five hides. */
export const SKIN = [0xf3d6c4, 0xe9bfa5, 0xd9a382, 0xc58b65, 0xac704e, 0x8b5438, 0x633c2b, 0x40271f];
export const GARMENT = [0x967047, 0xb18a59, 0x715039, 0xc2a174, 0x806044];
export const HAIR = [0x181310, 0x2b1d14, 0x3d2a1a, 0x4a3626];

// Unlit on purpose: a flame is a light source, not a lit surface, and a Lambert
// flame goes dark at exactly the moment it should be brightest.
export const fireMaterial = new THREE.MeshBasicMaterial({ color: 0xffb347 });

export const camps = [];        // { x, z, huts, light, ... }
export const people = [];

/* Metres between two fires at world build. Not scaled by the map — see the note
   where it is used. A bigger island now holds proportionally more bands. */
export const CAMPS_APART = 260;
export let personParts = null, campParts = null, smoke = null;
export const tribeGroup = new THREE.Group();

export function clearTribe() {
  usedNames.clear();
  usedCodes.clear();
  camps.length = 0;
  people.length = 0;
  clearLooks();
  personParts = null;
  campParts = null;
  smoke = null;
}

/* Sites are chosen before the trees go in, so buildTrees can leave a clearing
   and fillTile can leave the ground bare. A camp in a thicket would be wrong,
   and cutting the trees afterwards would mean rebuilding them. */
export function chooseCampSites(count) {
  const rng = mulberry32(P.seed ^ 0x5eed0c47);
  for (let i = 0; i < count; i++) {
    let best = null, bestFlat = 0;
    for (let t = 0; t < 200; t++) {
      const a = rng() * Math.PI * 2;
      // Out of the spawn meadow and spread over however big the island is.
      const r = (90 + Math.sqrt(rng()) * 320) * MAP_SCALE;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = sampleHeight(x, z);
      if (h < SEA + 4 || h > SNOW - 25) continue;
      /* Keep camps apart, or two bands end up sharing one fire. In metres, and
         deliberately not scaled by the map.

         Both this and the radius above used to scale, which cancelled: a disc
         2.5 times wider than the spacing holds about the same handful of camps
         whatever you multiply them both by, so a 6400m island held exactly as
         many bands as a 1600m one and merely spread them further apart. Asking
         for forty camps got you seven on any map in the game. The distance two
         fires need between them is a fact about camps; where on the island the
         camps go is a fact about the island. Only the second one scales.

         GROUND.range, the ground a band treats as its own, was already in
         plain metres — so scaling GROUND.apart beside it was inconsistent with
         its own neighbour in the same object. */
      if (camps.some((c) => Math.hypot(c.x - x, c.z - z) < CAMPS_APART)) continue;
      /* Off the creeks if it can be — its tents and fires spread twenty metres
         round the middle — but on an island threaded with water, beside one
         rather than nowhere: the tents step round it (layoutCamp), and nothing
         is built in it. Never in the water itself. */
      if (inWater(x, z)) continue;
      const flat = flatnessAt(x, z) * (clearOfCreeks(x, z, 22) ? 1 : 0.5);
      if (flat > bestFlat) { bestFlat = flat; best = { x, z }; }
      if (flat > 0.985) break;                    // good enough, stop looking
    }
    if (!best) continue;
    const crng = mulberry32((P.seed ^ 0xc0ffee) + i * 977);
    const voice = tribeVoice(crng);
    // The name first, because the code is a shorthand for it.
    const name = uniqueName(crng, 2 + ((crng() * 2) | 0), voice);
    camps.push({
      index: camps.length, x: best.x, z: best.z, y: sampleHeight(best.x, best.z),
      rng: crng, voice, name,
      /* Two characters and a hue, taken out of the band's own name — Tsekash is
         TS. Once a chronicle spans several bands over several worlds, a line has
         to say whose it is in less space than a name takes, and a shorthand you
         can read is worth more than one you have to memorise. */
      code: takeTribeCode(name),
      get color() { return codeColor(this.code); },
      /* Hunger 1, not 0. An empty store is maximum hunger — `1 - 0/6` — and
         writing 0 here says the opposite of what `food: 0` on the same line
         says. It is only a literal until the first book-keeping pass corrects
         it, an eighth of a day later, but every person picks their first job
         within six seconds of the world existing. They all picked it believing
         the store was full, which puts one in five outside instead of all but
         one of them, and a brand new band sat down round a fire it had nothing
         to cook on. */
      food: 0, pop: 0, need: 0, hunger: 1, wasEmpty: false,
      // Nothing quarried yet. Unlike food it does not spoil, so it only ever
      // goes up until somebody makes something out of it or trades it away.
      stone: 0,
      // Everything it will ever know, it has to work out.
      skill: emptySkills(),
      told: emptySkills(),
      /* What has happened to them, kept per band rather than per world. A
         chronicle says one thing at a time; this is the thing you can only see
         by adding them up — that one camp lost nine to a sickness and the other
         starved. */
      toll: { age: 0, infancy: 0, hunger: 0, exhaustion: 0, sickness: 0, tiger: 0, raid: 0 },
      born: 0, peak: 0, founded: simDay, gone: false,
      history: [],
    });
  }
}

/** A band founded while the world ran, built again where it stood (save.js).

    The seed lays out only the bands an island starts with, so this is the one
    part of a reload no seed can do: a band that broke away on day 300 has a
    name, a code and a place, and all three are in the save. Without it the
    restore filled the seeded camps and stopped, and every band founded after
    them came back as camps[0] — a world of twenty bands reloading as five, with
    everybody else's descendants standing round the first band's fire. */
export function campFromRecord(index, x, z, name, founded) {
  if (index >= campCapacity) growCamps(index + 1);
  /* Its own rolls, as a camp founded in play gets them (life.js, splitCamp):
     the same band on the same day draws the same names for its children. */
  const rng = mulberry32((P.seed ^ 0x5b1f7) + index * 7717 + Math.floor(founded || 0));
  const camp = {
    index, x, z, y: sampleHeight(x, z),
    rng, voice: tribeVoice(rng), name,
    code: takeTribeCode(name),
    get color() { return codeColor(this.code); },
    // Everything else is read back over this by the restore (save.js).
    food: 0, pop: 0, need: 0, hunger: 1, wasEmpty: false,
    stone: 0,
    skill: emptySkills(),
    told: emptySkills(),
    toll: { age: 0, infancy: 0, hunger: 0, exhaustion: 0, sickness: 0, tiger: 0, raid: 0 },
    born: 0, peak: 0, founded: Number.isFinite(founded) ? founded : simDay, gone: false,
    history: [],
  };
  camps.push(camp);
  layoutCamp(camp, index);
  return camp;
}

/* Metres of trampled ground around a camp — no grass, no trees, and the
   distance the rest of the simulation means by "at the fire". Grown with the
   camp: hearths sit 13 m out and their tents 6 to 9 m beyond that, so at 17 the
   far tents of a village stood in long grass outside their own camp. */
export const CAMP_CLEARING = 26;

export function inCamp(x, z, extra = 0) {
  for (let i = 0; i < camps.length; i++) {
    const c = camps[i];
    if (Math.hypot(c.x - x, c.z - z) < campReach(c) + extra) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------
   Camps, and the room for more of them

   A camp used to be laid out once, at world build, into meshes sized exactly to
   fit it — which is fine until a band grows too big for one fire and half of it
   walks off to start another. So the meshes are allocated for more camps than
   there are, at a fixed number of pieces each, and a camp's slot is simply its
   index times that number. No fill pointer, no compaction, and a new camp can
   be laid out into empty slots years later.
   ------------------------------------------------------------------------- */

/* Smoke particles per fire. Enough to read as smoke from across the valley and
   few enough that a dozen camps do not cost anything worth measuring. */
export const SMOKE_PER_FIRE = 26;
export let smokeMaterial = null;   // built once, reused across rebuilds
export const smokeUniforms = { uViewportH: { value: 900 }, uTanHalfFov: { value: 0.55 } };

/** One instanced mesh of a camp fitting, lit and shadowed like everything else. */
export function instancedFrom(geo, count, group) {
  const m = new THREE.InstancedMesh(geo, faunaMaterial, Math.max(count, 1));
  m.castShadow = true;
  m.receiveShadow = true;
  m.frustumCulled = false;
  group.add(m);
  if (count === 0) m.setMatrixAt(0, HIDDEN);
  return m;
}

/* -------------------------------------------------------------------------
   The dead stay on the island

   Somebody dies, the figure vanishes, and the only trace is a number going down
   on the panel. A band could lose eleven people and the ground would look
   exactly as it did before — which is the one place this world was letting an
   event happen without leaving anything behind to find.

   So a cairn goes up where they fell, and stays. It is a handful of stones, it
   is small, and it is somewhere real: the ridge somebody was hunting on, the
   far side of the island where a visit went wrong, the middle of a camp for the
   ones who died at home. Walk far enough after a few decades and you can read
   where the bad years happened off the ground.

   Saved with everything else, so they survive a reload, and never taken away.
   They were capped at four hundred, oldest first — and the oldest are the bands
   that have died out, so the one thing left of a band was the first thing to
   go. The mesh is built again bigger when the dead outgrow it, the way the
   people's meshes are, and a cairn is three stones: a century of them is still
   less than one tree line.
   ------------------------------------------------------------------------- */

export const GRAVE_ROOM = 400;       // room the graves start with; it doubles when full
export let graveRoom = GRAVE_ROOM;
export const GRAVE_STONES = 3;       // stones per cairn
export const GRAVE_SPACING = 1.6;    // metres between graves, both ways
export const PALE = new THREE.Color(0xffffff);
export const PYRAMID_COURSES = 5;    // steps in the pyramid a band at mastery of masonry has raised
export let graves = [];              // { x, z, y, day, sex }
export let graveMesh = null;
export let stoneMesh = null;          // the kerb and the pyramid: masonry

/* -------------------------------------------------------------------------
   What a band raises over its dead

   Going back to the stones is `rites`. This is what a band does once going back
   is not enough — and it is the first mark any of them leaves that is not
   shelter or a tool.

   The form is the band's own, drawn once off its own stream: a ring, an avenue
   leading in, or a single raised cairn. Two villages a kilometre apart have
   raised different things, and neither of them chose to. How much of it is
   standing follows their `art`, so it goes up over years rather than appearing
   — a band with a tenth of it has a few stones on end and a band at mastery has
   the whole ring.
   ------------------------------------------------------------------------- */
export const MONUMENT_FORMS = ['ring', 'avenue', 'cairn'];
export const MONUMENT_MAX = 14;          // stones in the largest of them

export function monumentPlan(camp) {
  if (!camp.barrow) return [];
  if (camp.stonesPlan) return camp.stonesPlan;
  const rng = mulberry32((camp.index + 1) * 7919 ^ (P.seed | 0));
  const form = MONUMENT_FORMS[(rng() * MONUMENT_FORMS.length) | 0];
  const { x, z, a } = camp.barrow;
  const plan = [];
  for (let i = 0; i < MONUMENT_MAX; i++) {
    const t = i / MONUMENT_MAX;
    let px, pz, tall = 1.5 + rng() * 1.1;
    if (form === 'ring') {
      const ang = t * Math.PI * 2 + rng() * 0.06;
      px = x + Math.cos(ang) * 7.5; pz = z + Math.sin(ang) * 7.5;
    } else if (form === 'avenue') {
      // Two files leading in to the ground, which is what an avenue is.
      const side = i % 2 ? 1 : -1, step = Math.floor(i / 2);
      px = x - Math.cos(a) * (5 + step * 2.6) - Math.sin(a) * side * 2.2;
      pz = z - Math.sin(a) * (5 + step * 2.6) + Math.cos(a) * side * 2.2;
    } else {
      // A cairn: one heap, taller than it is wide, growing inward and up.
      const ang = rng() * Math.PI * 2, r = 0.5 + t * 2.6;
      px = x + Math.cos(ang) * r; pz = z + Math.sin(ang) * r;
      tall = 2.4 - t * 1.4;
    }
    plan.push({ x: px, z: pz, y: sampleHeight(px, pz), tall, lean: (rng() - 0.5) * 0.16 });
  }
  camp.stonesPlan = plan;
  camp.stonesForm = form;
  return plan;
}

export function buildGraves() {
  const geo = new THREE.DodecahedronGeometry(1, 0);
  /* The graves, and behind them whatever each band has raised. One mesh for
     both because they are the same material and the same shape at different
     scales — a standing stone is a cairn stone that somebody stood up. */
  graveRoom = GRAVE_ROOM;
  while (graveRoom < graves.length) graveRoom *= 2;
  graveMesh = new THREE.InstancedMesh(geo, rockMaterial,
    graveRoom * GRAVE_STONES + campCapacity * MONUMENT_MAX);
  graveMesh.castShadow = true;
  graveMesh.receiveShadow = true;
  graveMesh.frustumCulled = false;
  for (let i = 0; i < graveMesh.count; i++) graveMesh.setMatrixAt(i, HIDDEN);
  tribeGroup.add(graveMesh);
  /* Masonry's pieces: a kerb round the square of graves and the courses of a
     pyramid behind them. Boxes, drawn in the graves' own pass, so a band that
     has died out keeps what it built exactly as it keeps its stones. */
  if (stoneMesh) { tribeGroup.remove(stoneMesh); stoneMesh.geometry.dispose(); stoneMesh.dispose(); }
  stoneMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), rockMaterial,
    Math.max(1, campCapacity * (PYRAMID_COURSES + 4)));
  stoneMesh.castShadow = true;
  stoneMesh.receiveShadow = true;
  stoneMesh.frustumCulled = false;
  for (let i = 0; i < stoneMesh.count; i++) stoneMesh.setMatrixAt(i, HIDDEN);
  tribeGroup.add(stoneMesh);
  drawGraves();
}

/* Where the n-th grave of a band goes: round and round a square, from the
   middle out — so the oldest are at the centre, the ground stays square
   however many it holds, and its size is how long they have been burying. */
export function squareSeat(n) {
  if (n === 0) return [0, 0];
  const k = Math.ceil((Math.sqrt(n + 1) - 1) / 2);
  const m = n - (2 * k - 1) ** 2, side = 2 * k, edge = Math.floor(m / side), t = m % side;
  if (edge === 0) return [-k + 1 + t, -k];
  if (edge === 1) return [k, -k + 1 + t];
  if (edge === 2) return [k - 1 - t, k];
  return [-k, k - 1 - t];
}

/* The kerb and the pyramid, as far as each band's masonry has got. The kerb
   goes up with the first course and follows the square as it grows; the
   pyramid stands behind the graves, on the side away from the camp. */
function drawMasonry() {
  if (!stoneMesh) return;
  const per = PYRAMID_COURSES + 4;
  const box = (slot, cx, cz, y, w, h, d, yaw, hex) => {
    _e.set(0, yaw, 0);
    _q.setFromEuler(_e);
    _v.set(cx, y, cz);
    _s.set(w, h, d);
    stoneMesh.setMatrixAt(slot, _m4.compose(_v, _q, _s));
    stoneMesh.setColorAt(slot, _c.setHex(hex));
  };
  for (const camp of camps) {
    const base = camp.index * per;
    if (base + per > stoneMesh.count) continue;
    const ground = camp.barrow;
    const courses = ground ? Math.round(PYRAMID_COURSES * (camp.skill?.stonework || 0)) : 0;
    const ax = ground ? Math.cos(ground.a) : 1, az = ground ? Math.sin(ground.a) : 0;
    const ring = Math.ceil((Math.sqrt(Math.max(1, camp.buried || 0)) - 1) / 2);
    const half = (ring + 0.5) * GRAVE_SPACING + 0.3;
    // The kerb: front and back across the rows, and the two sides along them.
    const sides = [[half, 0, Math.PI / 2], [-half, 0, Math.PI / 2], [0, half, 0], [0, -half, 0]];
    sides.forEach(([along, across, turn], s) => {
      const slot = base + PYRAMID_COURSES + s;
      if (courses < 1 || !(camp.buried > 0)) { stoneMesh.setMatrixAt(slot, HIDDEN); return; }
      const cx = ground.x + ax * along - az * across, cz = ground.z + az * along + ax * across;
      box(slot, cx, cz, sampleHeight(cx, cz) + 0.15, half * 2 + 0.4, 0.45, 0.3, -(ground.a + turn), 0x8f877b);
    });
    // The pyramid, a course at a time, each narrower than the one under it.
    const cx = ground ? ground.x + ax * (half + 6.5) : 0, cz = ground ? ground.z + az * (half + 6.5) : 0;
    const floor = ground ? sampleHeight(cx, cz) - 0.25 : 0;
    for (let c = 0; c < PYRAMID_COURSES; c++) {
      if (c >= courses) { stoneMesh.setMatrixAt(base + c, HIDDEN); continue; }
      const w = 7 - c * 1.3;
      box(base + c, cx, cz, floor + c * 0.9 + 0.45, w, 0.9, w, -ground.a, c % 2 ? 0x9d9384 : 0x958b7c);
    }
  }
  stoneMesh.instanceMatrix.needsUpdate = true;
  if (stoneMesh.instanceColor) stoneMesh.instanceColor.needsUpdate = true;
}

/* Stacked rather than scattered: three stones getting smaller, each one turned
   differently, which is enough to read as piled by somebody at this size. */
export function drawGraves() {
  if (!graveMesh) return;
  /* More dead than there is room for: the mesh is built again, bigger, and
     every stone drawn where it was. Nobody's cairn is cleared to make room. */
  if (graves.length > graveRoom) {
    tribeGroup.remove(graveMesh);
    graveMesh.geometry.dispose();
    graveMesh.dispose();
    buildGraves();                 // sizes itself to the graves, and draws them
    return;
  }
  const n = graves.length;
  for (let g = 0; g < n; g++) {
    const it = graves[g];
    const rng = mulberry32((it.x * 131 + it.z * 977 + it.day * 7) | 0);
    /* A headstone: one dressed slab stood upright, facing down the rows. A
       cairn stays a cairn — the band's older dead keep what they were given. */
    if (it.k === 's') {
      _e.set((rng() - 0.5) * 0.06, -(it.a || 0), (rng() - 0.5) * 0.06);
      _q.setFromEuler(_e);
      _v.set(it.x, it.y + 0.34, it.z);
      _s.set(0.36, 0.62, 0.12);
      graveMesh.setMatrixAt(g * GRAVE_STONES, _m4.compose(_v, _q, _s));
      graveMesh.setColorAt(g * GRAVE_STONES, _c.setHex(0xa39d92).multiplyScalar(0.85 + rng() * 0.2));
      for (let k = 1; k < GRAVE_STONES; k++) graveMesh.setMatrixAt(g * GRAVE_STONES + k, HIDDEN);
      continue;
    }
    let up = 0;
    for (let k = 0; k < GRAVE_STONES; k++) {
      const size = 0.30 - k * 0.07;
      _e.set(rng() * 3, rng() * 6, rng() * 3);
      _q.setFromEuler(_e);
      _v.set(it.x + (rng() - 0.5) * 0.16, it.y + up + size * 0.5, it.z + (rng() - 0.5) * 0.16);
      _s.set(size, size * 0.8, size);
      graveMesh.setMatrixAt(g * GRAVE_STONES + k, _m4.compose(_v, _q, _s));
      graveMesh.setColorAt(g * GRAVE_STONES + k, _c.setHex(0x8b8378)
        .multiplyScalar(0.72 + rng() * 0.4));
      up += size * 0.72;
    }
  }
  /* And what each band has raised, standing behind its own graves. How many of
     the planned stones are up follows their `art`, so a monument goes up over
     years — and it comes back down if a band forgets what it was for, which is
     the only way any of this is ever lost. */
  let at = graveRoom * GRAVE_STONES;
  for (const camp of camps) {
    // A band that has died out keeps what it raised: it is all that is left of them.
    const plan = monumentPlan(camp);
    const up = Math.round(plan.length * (camp.skill?.art || 0));
    for (let i = 0; i < MONUMENT_MAX; i++) {
      const stone = i < up ? plan[i] : null;
      if (stone) {
        _e.set(stone.lean, i * 1.7, stone.lean * 0.7);
        _q.setFromEuler(_e);
        _v.set(stone.x, stone.y + stone.tall * 0.5, stone.z);
        _s.set(0.42, stone.tall, 0.30);
        graveMesh.setMatrixAt(at, _m4.compose(_v, _q, _s));
        graveMesh.setColorAt(at, _c.setHex(0x8f877b));
      } else {
        graveMesh.setMatrixAt(at, HIDDEN);
      }
      at++;
    }
  }

  drawMasonry();

  for (let i = n * GRAVE_STONES; i < graveRoom * GRAVE_STONES; i++) {
    graveMesh.setMatrixAt(i, HIDDEN);
  }
  graveMesh.instanceMatrix.needsUpdate = true;
  if (graveMesh.instanceColor) graveMesh.instanceColor.needsUpdate = true;
  graveMesh.computeBoundingSphere();
  stats.graves = n;
}

/* Every one of them stays. A band that has died out has nothing else left on
   the island, and its graves were the first thing a cap would clear. */
export function buryPerson(p) {
  /* Carried back rather than left. Somebody who dies out on the hill is buried
     with the rest of their band — which is the whole difference between a
     grave and a place where somebody died.

     Laid in rows off the ground's own line, so a burial ground of thirty reads
     as arranged rather than as thirty accidents in the same field. The row grows
     outward with the count, so the oldest stones are at the middle: a band's
     history has a shape you can walk along. */
  const ground = p.camp?.barrow;
  // A band that can dress stone stands a headstone rather than piling a cairn.
  const headstone = (p.camp?.skill?.stonework || 0) >= 0.5;
  let x = p.x, z = p.z;
  if (ground) {
    const n = (p.camp.buried = (p.camp.buried || 0) + 1) - 1;
    const [col, row] = squareSeat(n);
    const ax = Math.cos(ground.a), az = Math.sin(ground.a);
    x = ground.x + (-az * col * GRAVE_SPACING) + ax * row * GRAVE_SPACING;
    z = ground.z + (ax * col * GRAVE_SPACING) + az * row * GRAVE_SPACING;
  }
  graves.push({
    x: Math.round(x * 100) / 100,
    z: Math.round(z * 100) / 100,
    y: sampleHeight(x, z),
    day: Math.floor(simDay),
    sex: p.sex,
    ...(headstone ? { k: 's', a: Math.round((ground?.a || 0) * 100) / 100 } : {}),
  });
  drawGraves();
}

/* Tents per camp. Six was a band; a camp that grows into a village needs one
   tent per family and there can be a dozen families round one fire. */
/* -------------------------------------------------------------------------
   A camp is a village that has not grown yet

   Fourteen tents in one ring around one fire is a camp, and it is the only
   thing a band could ever be: past that the ring was full, everybody left over
   shared the last tent, and the band split rather than getting any bigger.

   Now the tents come in clusters and every cluster has its own hearth. A band
   of four families is one fire and four tents and looks exactly as it always
   did; a band of forty is five fires with their own rings of tents around
   them, which is what a village is — not one crowd around one hearth, but
   several hearths far enough apart to sit at.

   `perHearth` is the number that decides it: how many households one fire can
   hold before the next one is lit.
   ------------------------------------------------------------------------- */
export const HEARTHS = 5;
export const HUTS_PER_HEARTH = 10;
/* -------------------------------------------------------------------------
   Where the food is kept

   The store was a number on a panel. A band with a month put by and a band on
   its last day looked the same from anywhere you could stand, which is the
   thing "a camp you can read" below exists to stop, and food is the one
   quantity the whole simulation turns on.

   So it is kept somewhere. Granaries go up as the store fills and come down as
   it empties: none in a band with nothing, one for a band getting by, four for
   a band that has put a month by. A drum of wattle on stilts under a thatch
   that overhangs it, which makes it the one shape in a camp that is not a cone
   and lets you pick it out of a ring of tents from the ridge.
   ------------------------------------------------------------------------- */
export const STORES = 4;
/* Days of food above which each one stands: something at all, a comfortable
   week, a fortnight, a month. Spaced wider as they go, because a store that
   runs to weeks is a different kind of band rather than more of the same. */
export const STORE_DAYS = [0, 6, 15, 30];
/* A day's slack on the way up, so a band hovering on a line does not raise a
   granary in the morning and take it down by night. The same margin the
   chronicle leaves before it says a band has food again. */
export const STORE_SLACK = 1;
/* Where they stand: out past the tents of the first fire, on the bearing no
   other fire is lit on. The hearths go round a village at fifths of a turn
   from `hearthTurn`, starting at the first fifth, so `hearthTurn` itself is
   the one direction a second fire never takes. */
export const STORE_OUT = 13;
/* Out, then along. The first stands in the middle, the next two flank it, and
   the fourth goes behind, between them. */
export const STORE_SPOTS = [[0, 0], [0, -2.7], [0, 2.7], [2.4, 1.35]];
export const STORE_SCALE = 0.95;
/* Where somebody bringing food in stands to put it away: this far short of the
   granary, on the camp side of it. */
export const STORE_STAND = 1.7;
/* How far past the outermost granary the storage area reaches: the ground in
   front of each, and a step more, so walking up to the store is arriving at it
   rather than hunting for the one metre where E works. */
/* The granary's thatch is 1.14 m across its half-width and the spot somebody
   stands at to fill it is 1.7 m out; this takes in that and half a metre more.
   It was 3.5, which drew a ring well clear of anything on the ground. */
export const STORE_AREA_EDGE = 2.2;
/* The ground a granary needs. A camp is sited for dry flat ground at its
   middle, and nothing more: thirteen metres out on a coast can be sea, and a
   granary there is one nobody can walk up to — they stand at the water's edge
   until their errand times out, and what they were carrying never goes in. */
export const STORE_FLAT = 0.8;       // stilts take a slope a tent would not, but not a hillside
/* The far edge of the biggest tent at the back of its ring: huts stand 6.5 to
   9.1 m from their fire and the largest is 1.95 m across the base at 1.25
   scale. Every fire a village could light has one, lit or not. */
export const TENT_REACH = 6.5 + 2.6 + 1.95 * 1.25;
export const STORE_ROOF = 1.2;       // the thatch's radius, as built in buildCamps
/* Where the fallbacks go: out past every ring of tents, between two fires. */
export const STORE_FAR = 22;
export const STORE_WALL = 0x8f7350, STORE_THATCH = 0xb59d62;

export const CAMP_PIECES = {
  huts: HEARTHS * HUTS_PER_HEARTH,
  /* The better tents (village.js), a slot for every tent in each kind. A band
     puts up one kind; the others are parked. */
  tentHide: HEARTHS * HUTS_PER_HEARTH,
  tentPainted: HEARTHS * HUTS_PER_HEARTH,
  lodge: HEARTHS * HUTS_PER_HEARTH,
  /* A flag for every village, in its tribe's colour: the same flag over every
     village a tribe holds, which is what a tribe of more than one looks like. */
  flagPole: 1,
  flagCloth: 1,
  // Nine stones and four logs *per hearth*: a fire nobody can sit at is a
  // bonfire, not a hearth.
  stones: 9 * HEARTHS,
  logs: 4 * HEARTHS,
  poles: 3,
  /* The granaries, in two meshes because they are two colours: stilts, floor
     and walls in one, the thatch in the other. One matrix places both. */
  stores: STORES,
  storeRoofs: STORES,
  /* A band's field and its pen (farming.js): ridges of turned earth, what is
     growing on them, the posts round the pen and the animals in it. Numbers
     rather than FARM's names, because farming.js imports this module back and
     nothing may cross that while either is loading. `sheep` is FARM.stockMax;
     rows and crops are room for the largest field (FIELD, in farming.js): twenty
     rows, eighteen plants to a row of twenty-six metres. */
  /* A field's rows and plants are not a camp's to keep slots for: a field has
     no largest, and they are drawn into meshes of their own that grow
     (farming.js). None here. */
  rows: 0,
  crops: 0,
  pen: 10,
  sheep: 12,
  /* No `fires` here, and the crash that put this comment in is the reason:
     `buildCamps` walks this object and parks every slot of the mesh named by
     each key, so a key with no `campParts` mesh behind it is a TypeError on the
     first frame of the first world. The fires have their own mesh and their own
     count — `HEARTHS` — because there is one per hearth rather than a fixed
     number per camp. This object is the pieces that come in bulk. */
};

/** How many fires a band of this many households is sitting around. */
export function hearthsFor(families) {
  return clamp(Math.ceil((families || 1) / HUTS_PER_HEARTH), 1, HEARTHS);
}

/* Where a camp's hearths are. The first is the camp itself — a band of one
   family has its fire where its camp is, and always has. The rest are spread
   round it far enough that the tents of one do not stand in the next. */
export function hearthAt(camp, i) {
  if (i === 0) return { x: camp.x, z: camp.z };
  const a = (i / HEARTHS) * Math.PI * 2 + (camp.hearthTurn || 0);
  const r = HEARTH_SPACING;
  return { x: camp.x + Math.cos(a) * r, z: camp.z + Math.sin(a) * r };
}
export const HEARTH_SPACING = 13;
export let campCapacity = 0;


/* Everything a camp is made of, written into its own slots. Called once per
   camp at world build, and again for each one that breaks away later. */
/* -------------------------------------------------------------------------
   A camp you can read

   Every camp looked the same whatever was happening to it. A band of four and
   a band of fourteen had the same three huts; a band that had worked out how to
   dry meat had the same rack standing as one that had not, because the rack was
   scenery. So the one place the whole simulation is visible from — the ground —
   said nothing about any of it.

   Two things, both read off state that already exists:

   How many shelters are standing follows how many people there are, so a big
   band looks big and a band that has just lost half of itself has huts nobody
   is in coming down.

   And the drying rack only stands once they know how to use it. It is the
   first thing a band builds that is not shelter or fire, and it is the visible
   half of a skill that until now only ever appeared as a number on a panel.
   ------------------------------------------------------------------------- */

export const RACK_KNOWN = 0.35;      // drying skill at which the rack goes up

/* -------------------------------------------------------------------------
   A tent to a family

   A tent held whoever was handed it — a person picked one at random when they
   were born, when they moved, when the camp moved — so a camp of twelve was
   twelve people scattered through however many shelters happened to exist, and
   the number of tents said nothing about who lived in them.

   A tent is a family: a woman and a man, and their children with them. What is
   left over — the widowed, the old, the young who have not paired off — shares
   what is spare. So the tents standing round a fire are the families round it,
   and a camp growing from three tents to a dozen is a thing you can count from
   the ridge without opening anything.

   Pairing is by age, oldest first, which is not romance — it is the cheapest
   rule that produces stable households and keeps a couple together as long as
   both of them live.
   ------------------------------------------------------------------------- */

export function familiesOf(camp) {
  const here = people.filter((p) => p.camp === camp);
  const women = here.filter((p) => !p.child && p.sex === 'f').sort((a, b) => personAge(b) - personAge(a));
  const men = here.filter((p) => !p.child && p.sex === 'm').sort((a, b) => personAge(b) - personAge(a));
  const families = [];
  const taken = new Set();

  for (let i = 0; i < Math.min(women.length, men.length); i++) {
    families.push({ adults: [women[i], men[i]], kids: [] });
    taken.add(women[i].id); taken.add(men[i].id);
  }
  // Children go with a parent if one of them has a household, else anywhere.
  for (const p of here) {
    if (!p.child) continue;
    const home = families.find((f) => f.adults.some((a) => a.id === p.mother || a.id === p.father));
    if (home) { home.kids.push(p); taken.add(p.id); }
  }
  /* Whoever is left: the unpaired, the widowed, and children whose parents are
     both dead. They share, rather than each taking a tent of their own — a camp
     is short of shelter, not of ground. */
  const spare = here.filter((p) => !taken.has(p.id));
  for (let i = 0; i < spare.length; i += 2) {
    families.push({ adults: spare.slice(i, i + 2), kids: [] });
  }
  return families;
}

/** Puts everybody in the tent they belong in. */
export function assignHuts(camp) {
  if (!camp?.huts?.length) return;
  const families = familiesOf(camp);
  camp.families = families.length;
  /* A city is laid out in streets, not round fires (settlement.js): a house to
     a household, nearest the middle first, and each sits at its own doorstep. */
  if ((camp.stage || 0) >= CITY.at) {
    const homes = cityPlotsFor(camp, families.length);
    families.forEach((f, i) => {
      const home = homes[Math.min(i, homes.length - 1)];
      const fire = home ? home.step : camp.fireAt?.[0];
      // One of the camp's own places to sit, as every hearth is.
      if (home && camp.fireAt && camp.fireAt[home.step.slot] !== home.step) {
        home.step.slot = camp.fireAt.length;
        camp.fireAt.push(home.step);
      }
      for (const p of [...f.adults, ...f.kids]) { p.hut = home ? home.door : camp.huts[0]; p.hearth = fire; }
    });
    return;
  }
  /* Past the core's fifty, the outskirts: laid out as far as there are
     households to fill them. A household past the last good spot shares the
     core's last tent, as every household past fifty used to. */
  const past = families.length - camp.huts.length;
  const outer = past > 0 ? extendOutskirts(camp, past) : null;
  families.forEach((f, i) => {
    const seat = i >= camp.huts.length ? outer?.seats[i - camp.huts.length] : null;
    const at = Math.min(i, camp.huts.length - 1);
    const hut = seat ? seat.hut : camp.huts[at];
    /* And the fire that tent stands round. Without this a village was five
       hearths and one crowd: everything that means "go home" — the night
       coming on, an errand ending, a job by the fire — aimed at `camp.x`, which
       is hearth nought, so sixty people walked past four burning fires to stand
       at the first one. The hearths were furniture.

       It comes off the tent rather than off the person, so a household sits at
       one fire: the same rule that put their tents beside each other. */
    const fire = seat ? seat.fire : camp.fireAt?.[Math.floor(at / HUTS_PER_HEARTH)];
    for (const p of [...f.adults, ...f.kids]) { p.hut = hut; p.hearth = fire; }
  });
}

/** The fire somebody lives at, rather than the middle of the village. */
export function homeFire(p) {
  return p.hearth || p.camp;
}

/** Where this person's band keeps its food: the ring round its granaries, or
    the ground round their own fire for a band with nowhere to raise one. */
export function storeAreaOf(p) {
  if (p.camp?.storeArea) return p.camp.storeArea;
  const f = homeFire(p);
  return { x: f.x, z: f.z, r: STORE_AREA_EDGE + 1.5 };
}

/** Whether they are standing in it. */
export function inStoreArea(p) {
  const a = storeAreaOf(p);
  return Math.hypot(p.x - a.x, p.z - a.z) < a.r;
}

/* Where somebody walking home actually goes. With food in their arms, that is
   the granaries: the store is somewhere now, so it gets put somewhere, and the
   walk in from a good day ends at the thing it fills. Empty-handed, their own
   fire, as it always was.

   The nearest granary standing, or where the first one will stand if none is
   yet — a band with an empty store is exactly the band this food is for, and
   it is what puts the first one up. And how widely people spread round the
   spot: a fire is sat round, a granary is walked up to. */
export function homeward(p, spread) {
  const c = p.camp;
  if (p.haul > 0 && c.storeSpots?.length) {
    const standing = Math.max(1, c.storesUp || 0);
    let best = c.storeSpots[0], near = Infinity;
    for (let k = 0; k < standing && k < c.storeSpots.length; k++) {
      const s = c.storeSpots[k];
      const d = (s.x - p.x) ** 2 + (s.z - p.z) ** 2;
      if (d < near) { near = d; best = s; }
    }
    return { x: best.fx, z: best.fz, spread: Math.min(spread, 1.2) };
  }
  const f = homeFire(p);
  return { x: f.x, z: f.z, spread };
}

/* And the one they would run to, which is whichever is nearest — a person with
   a tiger behind them takes the fire in front of them, not the one they happen
   to sleep at. */
export function nearestFire(camp, x, z) {
  let best = camp, near = Infinity;
  for (let f = 0; f < (camp.hearths || 0); f++) {
    const at = camp.fireAt?.[f];
    if (!at) continue;
    const d = Math.hypot(at.x - x, at.z - z);
    if (d < near) { near = d; best = at; }
  }
  // And the outskirts' fires that are lit (dressOutskirts).
  for (const { fire } of camp.outerFires || []) {
    const d = Math.hypot(fire.x - x, fire.z - z);
    if (d < near) { near = d; best = fire; }
  }
  return best;
}

export function dressCamp(camp, pack = true) {
  if (!campParts || !camp || camp.gone) return;
  const P0 = CAMP_PIECES;
  const index = camp.index;

  /* One shelter per two people, never fewer than two while anybody is left —
     a camp with one hut reads as abandoned rather than as small. */
  /* One tent per family, which is what the tents are now for. A camp of four
     families is four tents whether that is eight people or twenty. */
  assignHuts(camp);
  const here = people.reduce((n, p) => n + (p.camp === camp ? 1 : 0), 0);
  const want = here === 0 ? 0 : clamp(camp.families || Math.ceil(here / 2), 1, P0.huts);
  /* A city has no rings of tents or houses round fires: its houses are on its
     streets (settlement.js), and of its fires it keeps only the one at the
     middle of its plaza. */
  const city = (camp.stage || 0) >= CITY.at;
  const coreWant = city ? 0 : want;
  camp.cityShown = city && here > 0 ? Math.min(camp.families || 0, camp.city?.homes.length || 0) : 0;
  // And every household past the core's fifty, in the outskirts (dressOutskirts).
  camp.outerShown = city || here === 0 || !camp.outer ? 0 : Math.min(Math.max(0, (camp.families || 0) - P0.huts), camp.outer.seats.length);
  /* Which kind of tent they put up is how well they build (village.js): the
     plain cone, then hides on poles, then painted, then a lodge. Every kind has
     a slot for every tent; the kinds this band does not build are parked. */
  const style = tentStyle(camp);
  for (const key of TENT_KEYS) {
    const mesh = campParts[key];
    if (!mesh) continue;
    for (let i = 0; i < P0.huts; i++) {
      const slot = index * P0.huts + i;
      mesh.setMatrixAt(slot, key === style && i < coreWant && camp.hutAt?.[i] ? camp.hutAt[i] : HIDDEN);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // Only as far as the bands there are: the rest of the room is for bands not yet founded.
    mesh.count = Math.min(mesh.instanceMatrix.count, camps.length * P0.huts);
  }
  /* And a village's houses, a city's townhouses (village.js), on the spots the
     tents stood on — each kind made the first time any band builds it. */
  for (const key of HOUSE_KEYS) {
    if (key !== style && !campParts[key]) continue;
    const mesh = campParts[key] || makeHouses(key);
    for (let i = 0; i < P0.huts; i++) {
      const slot = index * P0.huts + i;
      mesh.setMatrixAt(slot, key === style && i < coreWant && camp.hutAt?.[i] ? camp.hutAt[i] : HIDDEN);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = Math.min(mesh.instanceMatrix.count, camps.length * P0.huts);
  }

  /* And a fire for every ring of tents that has anybody in it. A hearth with
     no tents round it is a fire nobody is sitting at, which reads as a camp
     twice the size of the band living in it — the thing lighting them all
     unconditionally would do. */
  camp.hearths = here === 0 || city ? 0 : hearthsFor(want);
  const perFireStones = P0.stones / HEARTHS, perFireLogs = P0.logs / HEARTHS;
  for (let f = 0; f < HEARTHS; f++) {
    const lit = f < camp.hearths;
    const at = camp.fireAt?.[f];
    if (lit && at) {
      _v.set(at.x, at.y + 0.05, at.z); _q.identity(); _s.setScalar(1);
      campParts.fire.setMatrixAt(index * HEARTHS + f, _m4.compose(_v, _q, _s));
    } else {
      campParts.fire.setMatrixAt(index * HEARTHS + f, HIDDEN);
    }
    for (let i = 0; i < perFireStones; i++) {
      const k = f * perFireStones + i;
      campParts.stones.setMatrixAt(index * P0.stones + k,
        lit && camp.stoneAt?.[k] ? camp.stoneAt[k] : HIDDEN);
    }
    for (let i = 0; i < perFireLogs; i++) {
      const k = f * perFireLogs + i;
      campParts.logs.setMatrixAt(index * P0.logs + k,
        lit && camp.logAt?.[k] ? camp.logAt[k] : HIDDEN);
    }
  }
  campParts.fire.instanceMatrix.needsUpdate = true;
  campParts.stones.instanceMatrix.needsUpdate = true;
  campParts.logs.instanceMatrix.needsUpdate = true;

  /* The rack. Standing only if somebody in the band knows what it is for. */
  const knows = (camp.skill?.drying || 0) >= RACK_KNOWN;
  for (let i = 0; i < P0.poles; i++) {
    const slot = index * P0.poles + i;
    if (knows && !city && camp.rackAt?.[i]) campParts.poles.setMatrixAt(slot, camp.rackAt[i]);
    else campParts.poles.setMatrixAt(slot, HIDDEN);
  }
  campParts.poles.instanceMatrix.needsUpdate = true;

  // The field and the pen, as far as the band has got with them (farming.js).
  dressField(camp, campParts, index);
  // The flag, in the tribe's colour: the same over every village it holds.
  dressFlag(camp, index, here);
  if (pack) dressOutskirts();
}

/* By the first fire, a little off it. The colour is the band's code's — read as
   a hue off `camp.color`, whose `hsl(h s% l%)` three will not parse — so a
   village taken by another tribe changes its flag the moment it changes hands. */
function dressFlag(camp, index, here) {
  if (!campParts.flagPole) return;
  const city = (camp.stage || 0) >= CITY.at;
  const at = camp.fireAt?.[0] || camp;
  // On a city's hall, over the middle; by the first fire anywhere else.
  const x = city ? camp.x : at.x + 3.2, z = city ? camp.z : at.z - 2.4;
  if (here > 0) {
    _v.set(x, sampleHeight(x, z) + (city ? CITY.hallRoof - 0.05 : 0), z);
    _e.set(0, index * 1.7, 0);
    _q.setFromEuler(_e);
    _s.setScalar(1);
    _m4.compose(_v, _q, _s);
    campParts.flagPole.setMatrixAt(index, _m4);
    campParts.flagCloth.setMatrixAt(index, _m4);
    const hue = Number((/hsl\((\d+)/.exec(camp.color) || [, 0])[1]);
    campParts.flagCloth.setColorAt(index, _c.setHSL(hue / 360, 0.7, 0.5));
    campParts.flagPole.setColorAt(index, _c.setHex(0x6b5334));
  } else {
    campParts.flagPole.setMatrixAt(index, HIDDEN);
    campParts.flagCloth.setMatrixAt(index, HIDDEN);
  }
  for (const m of [campParts.flagPole, campParts.flagCloth]) {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}

export function dressCamps() {
  for (const c of camps) dressCamp(c, false);
  dressOutskirts();          // once for all of them, not once a camp
}

/* How many granaries a band with this much put by has standing. Counted from
   however many stand now rather than from nothing, so the slack only ever
   works one way: a store goes up a day past its line and comes down on it. */
export function storesFor(camp, days) {
  if (camp.gone || !(camp.pop > 0)) return 0;
  let n = camp.storesUp || 0;
  // No more than there was dry ground for.
  const room = camp.storeAt?.length ?? STORES;
  while (n < room && days > STORE_DAYS[n] + STORE_SLACK) n++;
  while (n > 0 && days <= STORE_DAYS[n - 1]) n--;
  return n;
}

/** Puts up as many granaries as `camp.storesUp` says and takes the rest down.
    Separate from dressCamp because it changes on a different clock: tents
    follow the band, and these follow what the band has to eat. */
export function dressStores(camp) {
  if (!campParts?.stores || !camp) return;
  // The core's slots, the yards' and a city's, in whatever this rung stores in (settlement.js).
  dressOutskirts();
}

/* Where a granary may go, best first: the cluster on the one bearing no second
   fire takes, then single spots out past every ring of tents, between two
   fires, the far side first. Arithmetic only, like the rest of the store
   layout — see layoutCamp for why nothing here may roll. */
export function storeCandidates(camp) {
  const sa = camp.hearthTurn;
  const ox = Math.cos(sa), oz = Math.sin(sa), ax = -Math.sin(sa), az = Math.cos(sa);
  const out = STORE_SPOTS.map(([o, a]) =>
    [camp.x + ox * (STORE_OUT + o) + ax * a, camp.z + oz * (STORE_OUT + o) + az * a, sa]);
  for (const tenth of [5, 3, 7, 1, 9]) {
    const b = sa + (tenth / 10) * Math.PI * 2;
    out.push([camp.x + Math.cos(b) * STORE_FAR, camp.z + Math.sin(b) * STORE_FAR, b]);
  }
  return out;
}

/* Somewhere a granary can stand and somebody can walk up to it: dry under it
   and dry where they stand to put food in, not on a hillside, clear of every
   ring of tents the village could ever put up, and clear of the granaries
   already placed. A spot that fails is skipped, not moved — a band whose free
   side runs into the sea keeps its food in fewer of them. */
export function storeGround(camp, x, z, fx, fz) {
  if (sampleHeight(x, z) < SEA + 1.5 || sampleHeight(fx, fz) < SEA + 1.5) return false;
  if (inWater(x, z) || inWater(fx, fz)) return false;          // nor in a creek or a lake
  if (flatnessAt(x, z) < STORE_FLAT) return false;
  const roof = STORE_ROOF * STORE_SCALE;
  for (let f = 0; f < HEARTHS; f++) {
    const h = hearthAt(camp, f);
    if (Math.hypot(x - h.x, z - h.z) < TENT_REACH + roof) return false;
  }
  for (const s of camp.storeSpots) {
    if (Math.hypot(x - s.x, z - s.z) < 2 * roof + 0.2) return false;
  }
  return true;
}

export function layoutCamp(camp, index) {
  const rng = camp.rng;
  const P0 = CAMP_PIECES;
  camp.people = [];
  camp.huts = [];
  // Laid out again from nothing, so the outskirts and the ground they took go too.
  camp.outer = null;
  camp.city = null;
  camp.reach = 0;

  /* Every hut a camp could have is placed; how many of them are standing is
     decided by dressCamp, and changes as the band does. Laying them out once
     matters because the layout comes off the camp's own rng, and re-running it
     every time somebody is born would shuffle the whole camp around them. */
  camp.hearthTurn = rng() * Math.PI * 2;

  /* -----------------------------------------------------------------------
     Where the dead go

     They used to be buried where they fell, which is defensible and reads as
     nothing: a stone in the long grass eight hundred metres out is scenery, and
     forty of them scattered across an island are litter. A band that buries its
     people in one place has somewhere — you can walk to it, it grows, and the
     size of it is how long they have been here.

     Just outside the trampled ground rather than in it: far enough that the
     village is not built on its own dead, near enough to be theirs. On flat
     ground, out of the water, and downwind of nothing in particular — the site
     is picked the same way a camp is, and once, off the camp's own stream, so
     it does not wander when somebody dies.
     ----------------------------------------------------------------------- */
  /* The water's edge this band goes to, found once with the camp. A coast does
     not move, and a band either has one within walking distance or is inland —
     which is a fact about where its founders stopped, and one of the few things
     that makes two camps on one island live differently. */
  camp.shore = nearestShore(camp.x, camp.z);
  camp.raft = false;
  camp.wood = 0;
  camp.raftOut = null;
  camp.dock = undefined;

  camp.barrow = null;
  for (let t = 0; t < 60 && !camp.barrow; t++) {
    const a = rng() * Math.PI * 2;
    const r = CAMP_CLEARING + 6 + rng() * 12;
    const x = camp.x + Math.cos(a) * r, z = camp.z + Math.sin(a) * r;
    if (sampleHeight(x, z) < SEA + 1.5) continue;
    if (flatnessAt(x, z) < 0.88) continue;
    if (!clearOfCreeks(x, z, 8)) continue;       // the dead are not buried in a creek
    camp.barrow = { x, z, y: sampleHeight(x, z), a };
  }
  // Nowhere flat and dry within reach: keep them close rather than nowhere.
  if (!camp.barrow) {
    const x = camp.x + CAMP_CLEARING + 4, z = camp.z;
    camp.barrow = { x, z, y: sampleHeight(x, z), a: 0 };
  }
  for (let i = 0; i < P0.huts; i++) {
    const slot = index * P0.huts + i;
    /* A ring of shelters facing a fire, which is what a camp actually is — and
       one ring per fire, which is what a village is. Tents fill their own
       hearth's ring before the next hearth is used at all, so a band that grows
       lights a second fire and puts its next tents round that, rather than
       packing more of them into the first ring. */
    const mine = (i / HUTS_PER_HEARTH) | 0;
    const seat = i % HUTS_PER_HEARTH;
    const fire = hearthAt(camp, mine);
    let a = (seat / HUTS_PER_HEARTH) * Math.PI * 2 + rng() * 0.5;
    const r = 6.5 + rng() * 2.6;
    /* Never standing in water: round its own ring, a little either way at a
       time, to the first dry ground. No draw off the stream for it, which the
       rest of the camp's layout is still reading. */
    for (let k = 1; k <= 20 && inWater(fire.x + Math.cos(a) * r, fire.z + Math.sin(a) * r); k++) {
      a += (k % 2 ? 1 : -1) * k * 0.16;
    }
    const x = fire.x + Math.cos(a) * r, z = fire.z + Math.sin(a) * r;
    const sc = 0.85 + rng() * 0.4;
    camp.huts.push({ x, z });
    _e.set(0, -a, 0); _q.setFromEuler(_e);
    _v.set(x, sampleHeight(x, z) - 0.15, z);
    _s.set(sc, sc * (0.9 + rng() * 0.3), sc);
    camp.hutAt = camp.hutAt || [];
    /* Composed first, and only then kept. This was the wrong way round, and
       what it stored was not this hut.

       `_m4` is a single scratch matrix, declared in world.js and shared by
       everything that scatters instances — the trees and rocks, the fire each
       frame, the cairns, and every piece of a camp. Cloning it *before*
       composing into it keeps whatever the last thing to touch it left behind.
       The mesh itself was set correctly on the next line, which is why a camp
       looked right the moment it was built; `camp.hutAt` is what dressCamp
       hands back to the mesh every time the band grows or shrinks, so the
       stored matrix is the one you end up looking at.

       Which matrix each hut kept:

         · hut 0 of the second camp onward — the last thing the previous camp
           composed, which is the drying rack's crossbar: rotated a quarter turn
           about Z and floating 1.85m up at the rack. A tent on its side.
         · hut 0 of the first camp — whatever the world scatter finished with,
           a rock or a tree, somewhere else entirely on a random tumble.
         · every other hut — the hut before it, so tents stood inside each other
           and the last hut in the ring was never placed at all. */
    campParts.huts.setMatrixAt(slot, _m4.compose(_v, _q, _s));
    camp.hutAt[i] = _m4.clone();
    const hide = 0x6d5740 + ((rng() * 0x101010) | 0);
    campParts.huts.setColorAt(slot, _c.setHex(hide));
    /* The better tents carry their colours in the hide itself, so the instance
       only tints them — the same hide, paled, and no new draw off the camp's
       stream, which the rest of its layout is still reading. */
    for (const key of TENT_KEYS.slice(1)) campParts[key]?.setColorAt(slot, _c.setHex(hide).lerp(PALE, 0.72));
  }

  /* Every hearth gets its own ring of stones and its own logs, laid out where
     the fire is rather than where the camp is. Kept like the tents are, because
     dressCamp puts back the ones belonging to hearths that are lit and hides
     the rest. */
  camp.stoneAt = []; camp.logAt = [];
  const perFireStones = P0.stones / HEARTHS, perFireLogs = P0.logs / HEARTHS;
  for (let f = 0; f < HEARTHS; f++) {
    const fire = hearthAt(camp, f);
    for (let i = 0; i < perFireStones; i++) {    // the fire ring
      const a = (i / perFireStones) * Math.PI * 2;
      const x = fire.x + Math.cos(a) * 1.15, z = fire.z + Math.sin(a) * 1.15;
      const sc = 0.7 + rng() * 0.7;
      _e.set(rng() * 3, rng() * 3, rng() * 3); _q.setFromEuler(_e);
      _v.set(x, sampleHeight(x, z) + 0.06, z);
      _s.set(sc, sc * 0.8, sc);
      const at = f * perFireStones + i;
      campParts.stones.setMatrixAt(index * P0.stones + at, _m4.compose(_v, _q, _s));
      camp.stoneAt[at] = _m4.clone();
      campParts.stones.setColorAt(index * P0.stones + at, _c.setHex(0x6e6862));
    }
    for (let i = 0; i < perFireLogs; i++) {      // logs to sit on
      const a = (i / perFireLogs) * Math.PI * 2 + 0.4 + rng() * 0.3;
      const x = fire.x + Math.cos(a) * 2.6, z = fire.z + Math.sin(a) * 2.6;
      _e.set(0, -a + Math.PI / 2, 0); _q.setFromEuler(_e);
      _v.set(x, sampleHeight(x, z) + 0.17, z);
      _s.setScalar(0.9 + rng() * 0.3);
      const at = f * perFireLogs + i;
      campParts.logs.setMatrixAt(index * P0.logs + at, _m4.compose(_v, _q, _s));
      camp.logAt[at] = _m4.clone();
      campParts.logs.setColorAt(index * P0.logs + at, _c.setHex(0x5b4630));
    }
  }

  // A drying rack: two uprights and a crossbar, the oldest furniture there is.
  const ra = rng() * Math.PI * 2;
  const rx = camp.x + Math.cos(ra) * 5.0, rz = camp.z + Math.sin(ra) * 5.0;
  let pole = index * P0.poles;
  for (const side of [-1, 1]) {
    const x = rx + Math.cos(ra + Math.PI / 2) * side * 0.9;
    const z = rz + Math.sin(ra + Math.PI / 2) * side * 0.9;
    _e.set(0, 0, 0); _q.setFromEuler(_e);
    _v.set(x, sampleHeight(x, z), z);
    _s.setScalar(1);
    camp.rackAt = camp.rackAt || [];
    // Compose, then keep — same as the huts, and for the same reason.
    campParts.poles.setMatrixAt(pole, _m4.compose(_v, _q, _s));
    camp.rackAt[pole - index * P0.poles] = _m4.clone();
    campParts.poles.setColorAt(pole, _c.setHex(0x7d6446));
    pole++;
  }
  _e.set(0, -ra, Math.PI / 2); _q.setFromEuler(_e);
  _v.set(rx, sampleHeight(rx, rz) + 1.85, rz);
  _s.set(1, 0.95, 1);
  campParts.poles.setMatrixAt(pole, _m4.compose(_v, _q, _s));
  camp.rackAt[pole - index * P0.poles] = _m4.clone();
  campParts.poles.setColorAt(pole, _c.setHex(0x7d6446));

  /* The granaries, placed once like everything else and shown by
     dressStores. Nothing here draws from the camp's rng: that stream lays out
     the rest of the camp and moves on with every call, so a new thing taking
     from it would move every tent and stone laid out after it. The bearing is
     one the camp has already drawn, and the rest is arithmetic. */
  camp.storeAt = [];
  camp.storeSpots = [];
  camp.storesUp = 0;
  for (const [x, z, bearing] of storeCandidates(camp)) {
    if (camp.storeAt.length >= STORES) break;
    const fx = x - Math.cos(bearing) * STORE_STAND, fz = z - Math.sin(bearing) * STORE_STAND;
    if (!storeGround(camp, x, z, fx, fz)) continue;
    const k = camp.storeAt.length;
    _e.set(0, -bearing + k * 0.7, 0); _q.setFromEuler(_e);
    _v.set(x, sampleHeight(x, z) - 0.05, z);
    _s.setScalar(STORE_SCALE);
    // Compose, then keep: the scratch matrix is shared, as the huts found out.
    camp.storeAt.push(_m4.compose(_v, _q, _s).clone());
    camp.storeSpots.push({ x, z, fx, fz });
  }
  /* The storage area: a circle round the granary cluster — the ones within a
     few metres of the first, not a fallback spot out between two fires — wide
     enough to take in the ground in front of each. Where somebody carrying food
     is "at the store", and what the ring on the ground is drawn round. */
  camp.storeArea = null;
  if (camp.storeSpots.length) {
    const first = camp.storeSpots[0];
    const near = camp.storeSpots.filter((s) => Math.hypot(s.x - first.x, s.z - first.z) < 8);
    const cx = near.reduce((n, s) => n + s.x, 0) / near.length;
    const cz = near.reduce((n, s) => n + s.z, 0) / near.length;
    const r = STORE_AREA_EDGE + Math.max(...near.map((s) => Math.hypot(s.x - cx, s.z - cz)));
    camp.storeArea = { x: cx, z: cz, r };
  }
  for (let k = 0; k < STORES; k++) {
    const slot = index * STORES + k;
    campParts.stores.setMatrixAt(slot, HIDDEN);
    campParts.storeRoofs.setMatrixAt(slot, HIDDEN);
    campParts.stores.setColorAt(slot, _c.setHex(STORE_WALL));
    campParts.storeRoofs.setColorAt(slot, _c.setHex(STORE_THATCH));
  }

  camp.fireAt = [];
  for (let f = 0; f < HEARTHS; f++) {
    const at = hearthAt(camp, f);
    _e.set(0, 0, 0); _q.setFromEuler(_e);
    _v.set(at.x, sampleHeight(at.x, at.z) + 0.05, at.z);
    _s.setScalar(1);
    campParts.fire.setMatrixAt(index * HEARTHS + f, _m4.compose(_v, _q, _s));
    camp.fireAt[f] = { x: at.x, y: sampleHeight(at.x, at.z), z: at.z };
  }

  /* One point light for the village rather than one per hearth, and this is a
     cost decision rather than a lighting one: a real light is the most
     expensive thing a camp owns, there can be a hundred and forty camps, and
     five apiece is seven hundred lights in a scene that manages with the sun.
     One at the middle of the village lights the whole of it — the fires
     themselves are emissive, so every hearth still reads as burning. */
  const light = new THREE.PointLight(0xff8b3a, 0, 48, 2);
  light.position.set(camp.x, camp.y + 0.9, camp.z);
  tribeGroup.add(light);
  camp.light = light;
  camp.flicker = rng() * 10;

  for (const key of ['huts', 'stones', 'logs', 'poles', 'fire', 'stores', 'storeRoofs']) {
    campParts[key].instanceMatrix.needsUpdate = true;
    if (campParts[key].instanceColor) campParts[key].instanceColor.needsUpdate = true;
  }
}

/** Several shapes as one geometry, so a granary is one draw however many legs
    it stands on. Position and normal only: a camp fitting is flat colour, and
    nothing on its material reads a uv. */
export function joinGeometries(parts) {
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const count = flat.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
  let at = 0;
  for (const g of flat) {
    pos.set(g.attributes.position.array, at * 3);
    nor.set(g.attributes.normal.array, at * 3);
    at += g.attributes.position.count;
  }
  for (const g of new Set([...parts, ...flat])) g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

export function buildCamps() {
  world.add(tribeGroup);            // before the early return: people live in here too
  if (!camps.length) return;

  const hutGeo = new THREE.ConeGeometry(1.95, 2.5, 7);
  hutGeo.translate(0, 1.25, 0);
  const stoneGeo = new THREE.IcosahedronGeometry(0.22, 0);
  const logGeo = new THREE.CylinderGeometry(0.17, 0.19, 1.7, 6);
  logGeo.rotateZ(Math.PI / 2);
  const poleGeo = new THREE.CylinderGeometry(0.05, 0.07, 2.0, 5);
  poleGeo.translate(0, 1.0, 0);
  const fireGeo = new THREE.ConeGeometry(0.42, 0.95, 6);
  fireGeo.translate(0, 0.48, 0);
  /* A granary. Up off the ground because that is the point of one, out of the
     wet and out of reach of whatever noses round a camp at night: four stilts,
     a floor, a drum of walls, and a thatch wider than the drum it sits on. */
  const leg = new THREE.CylinderGeometry(0.06, 0.08, 1.0, 5);
  const storeGeo = joinGeometries([
    ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([a, b]) => leg.clone().translate(a * 0.55, 0.5, b * 0.55)),
    new THREE.CylinderGeometry(0.98, 0.98, 0.12, 8).translate(0, 1.06, 0),     // the floor
    new THREE.CylinderGeometry(0.72, 0.82, 0.95, 8).translate(0, 1.595, 0),    // the walls
  ]);
  leg.dispose();
  const roofGeo = new THREE.ConeGeometry(1.2, 1.05, 8);
  roofGeo.translate(0, 2.595, 0);

  /* Room for the bands that do not exist yet. A camp that outgrows its fire
     splits, and the half that leaves needs somewhere to put its huts. */
  /* Twelve was a small island's worth. A camp splits when it outgrows its fire
     and the half that leaves needs somewhere to put its tents, so the ceiling
     has to be what the map can hold rather than what it started with — and
     three times the number of fires it started with is still the second thing.
     Starting two camps capped an island at six of them whatever its size.

     Where a camp may actually go is a fact about the ground and is decided
     there: sites need 260 m between them, so the island refuses the twenty-first
     band by having nowhere to put it, which is a reason. Running out of huts is
     not. */
  campCapacity = Math.max(camps.length, CAMP_CEILING);

  campParts = {};
  campParts.huts = instancedFrom(hutGeo, campCapacity * CAMP_PIECES.huts, tribeGroup);
  campParts.flagPole = instancedFrom(new THREE.CylinderGeometry(0.05, 0.07, 4.6, 5).translate(0, 2.3, 0),
    campCapacity * CAMP_PIECES.flagPole, tribeGroup);
  campParts.flagCloth = instancedFrom(new THREE.BoxGeometry(1.4, 0.85, 0.04).translate(0.72, 4.05, 0),
    campCapacity * CAMP_PIECES.flagCloth, tribeGroup);
  const tents = tentGeometries();
  for (const key of TENT_KEYS.slice(1)) {
    const m = new THREE.InstancedMesh(tents[key], tentMaterial, Math.max(1, campCapacity * CAMP_PIECES[key]));
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    tribeGroup.add(m);
    campParts[key] = m;
  }
  campParts.stones = instancedFrom(stoneGeo, campCapacity * CAMP_PIECES.stones, tribeGroup);
  campParts.logs = instancedFrom(logGeo, campCapacity * CAMP_PIECES.logs, tribeGroup);
  campParts.poles = instancedFrom(poleGeo, campCapacity * CAMP_PIECES.poles, tribeGroup);
  campParts.stores = instancedFrom(storeGeo, campCapacity * CAMP_PIECES.stores, tribeGroup);
  campParts.storeRoofs = instancedFrom(roofGeo, campCapacity * CAMP_PIECES.storeRoofs, tribeGroup);
  const farm = farmGeometries();
  for (const key of ['rows', 'crops', 'pen', 'sheep']) {
    campParts[key] = instancedFrom(farm[key], campCapacity * CAMP_PIECES[key], tribeGroup);
  }
  campParts.fire = new THREE.InstancedMesh(fireGeo, fireMaterial, campCapacity * HEARTHS);
  campParts.fire.frustumCulled = false;
  tribeGroup.add(campParts.fire);

  /* Everything is parked out of sight first, so the slots belonging to camps
     that have not been founded yet are not drawn as a heap at the origin. */
  for (const [key, per] of Object.entries(CAMP_PIECES)) {
    for (let i = 0; i < campCapacity * per; i++) campParts[key].setMatrixAt(i, HIDDEN);
    campParts[key].setColorAt(0, _c.setHex(0x808080));
  }
  for (let i = 0; i < campCapacity * HEARTHS; i++) campParts.fire.setMatrixAt(i, HIDDEN);

  camps.forEach((camp, i) => layoutCamp(camp, i));
  buildSmoke();
}

export function buildSmoke() {
  // Capacity, not head count: a camp founded later needs a fire to smoke from.
  const n = campCapacity * SMOKE_PER_FIRE;
  const pos = new Float32Array(n * 3);
  const life = new Float32Array(n);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
  smokeMaterial ||= new THREE.ShaderMaterial({
    uniforms: smokeUniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute float aLife;
      varying float vLife;
      uniform float uViewportH;
      uniform float uTanHalfFov;
      void main() {
        vLife = aLife;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // Size in metres, converted to pixels the way perspective actually
        // works — so a puff is the same size in the world whatever the field of
        // view is set to, instead of a number that only looked right at 58°.
        float metres = 0.9 + aLife * 3.4;
        gl_PointSize = metres * uViewportH / (2.0 * max(-mv.z, 0.5) * uTanHalfFov);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vLife;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float soft = 1.0 - d * 2.0;
        float a = soft * soft * 0.34 * (1.0 - vLife) * smoothstep(0.0, 0.12, vLife);
        gl_FragColor = vec4(vec3(0.62, 0.60, 0.58), a);
      }`,
  });
  smoke = new THREE.Points(geo, smokeMaterial);
  smoke.frustumCulled = false;
  for (let i = 0; i < n; i++) resetSmoke(i, Math.random());
  tribeGroup.add(smoke);
}

export function resetSmoke(i, life = 0) {
  /* There is smoke allocated for camps that have not been founded yet — a band
     that breaks away later needs a fire to smoke from. Those particles belong
     to nobody, so they are parked out of the world rather than placed at a
     camp that does not exist. */
  const camp = camps[(i / SMOKE_PER_FIRE) | 0];
  // Nor, now, for a city, which has no fire to smoke from.
  if (!camp || (camp.stage || 0) >= CITY.at) {
    smoke.geometry.attributes.position.array[i * 3 + 1] = -9999;
    smoke.geometry.attributes.aLife.array[i] = 0;
    return;
  }
  /* Shared out between the fires that are lit rather than all coming off the
     middle of the village. The budget is per camp and does not grow with the
     hearths — five columns of a fifth of the smoke each, which is what five
     small fires look like against one big one. */
  const at = camp.fireAt?.[i % Math.max(1, camp.hearths || 1)] || camp;
  const p = smoke.geometry.attributes.position.array;
  p[i * 3] = at.x + (Math.random() - 0.5) * 0.4;
  p[i * 3 + 1] = (at.y ?? camp.y) + 0.6;
  p[i * 3 + 2] = at.z + (Math.random() - 0.5) * 0.4;
  smoke.geometry.attributes.aLife.array[i] = life;
}

/* Writes one person's colouring into the slot they are currently drawn in.
   Cheap enough to redo for the whole band whenever the band changes, which is
   the only time it can go stale — births and deaths, and coming back to a saved
   session. Doing it per frame would be correct too, and would re-upload the
   colour buffer sixty times a second to say nothing new. */
/* Ochre and white, because they read at distance against grass, skin and every
   garment colour in the pool — and because they are what the ochre in the camp
   is already used for. */
export const CHIEF_CLOTH = 0xb5651d;
export const CHIEF_BAND = 0xe8ddc8;

export function paintPerson(i, p) {
  if (!personParts) return;
  _c.setHex(p.skin).multiplyScalar(p.skinShade);
  // Skin: the parts that are bare.
  for (const key of ['head', 'neck']) personParts[key].setColorAt(i, _c);
  for (const key of ['upperArm', 'foreArm', 'hand']) {
    personParts[key].setColorAt(i * 2, _c);
    personParts[key].setColorAt(i * 2 + 1, _c);
  }
  _c.multiplyScalar(0.95);
  for (const key of ['thigh', 'shin', 'foot']) {
    personParts[key].setColorAt(i * 2, _c);
    personParts[key].setColorAt(i * 2 + 1, _c);
  }
  /* Whoever leads is wearing it. A camp is a dozen figures the same size doing
     the same things, and finding out which one is in charge meant opening a
     panel — so the chief's hide is ochre and there is a band round the head,
     and you can pick them out of a crowd from the ridge. Both are the
     wardrobe's (looks.js), coloured as they are put on — and everybody is
     undressed whenever the band changes, which is when a chief can change. */
  personParts.spear.setColorAt(i, _c.setHex(0x6b5334));
  personParts.load.setColorAt(i, _c.setHex(0x7b6a45));
  personParts.basket.setColorAt(i, _c.setHex(0x9a7446));   // wicker
}

/* -------------------------------------------------------------------------
   Room past the island

   The meshes were allocated once, for everybody the island could feed, and a
   birth past that was refused — a limit with nothing in the world behind it,
   which is the one kind this simulation is not supposed to have. So the room is
   where it starts now, not where it ends. An InstancedMesh cannot grow, but it
   can be replaced: when the bands fill it, every piece of a person is built
   again at twice the size, everything already drawn and painted is copied
   across, the new slots are parked out of sight, and the band goes on.

   Doubling rather than adding one, so a band growing by a few a day rebuilds
   its meshes a handful of times in a long run rather than on every birth.
   ------------------------------------------------------------------------- */
export function growPeople(need) {
  if (!personParts || need <= peopleCapacity) return;
  let room = Math.max(peopleCapacity, 1);
  while (room < need) room *= 2;
  for (const key in personParts) {
    const old = personParts[key], per = partsPer(key);
    const m = new THREE.InstancedMesh(old.geometry, old.material, room * per);
    m.name = old.name;
    m.castShadow = old.castShadow;
    m.receiveShadow = old.receiveShadow;
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceMatrix.array.set(old.instanceMatrix.array);
    if (old.instanceColor) {
      m.setColorAt(0, _c.setHex(0xffffff));       // makes the attribute...
      m.instanceColor.array.set(old.instanceColor.array);   // ...and fills it
    }
    for (let i = old.instanceMatrix.count; i < room * per; i++) m.setMatrixAt(i, HIDDEN);
    m.count = old.count;
    tribeGroup.remove(old);
    old.dispose();                    // its own buffers; the geometry is shared
    tribeGroup.add(m);
    personParts[key] = m;
  }
  growLooks(room);
  setPeopleCapacity(room);
}

/* -------------------------------------------------------------------------
   No ceiling on camps, either

   A band that splits needs somewhere to put its tents, and there was room for
   so many camps and no more — a number fixed when the world was built, which
   is running out of huts rather than of island. So the camps do what the
   people do: past the room there is, every mesh that keeps a slot per camp is
   made again at twice the size, everything already drawn is copied across, and
   the new slots are parked out of sight until a band is laid out in them.
   Nothing is laid out again: a camp's tents come off its own stream, which has
   moved on, so drawing it twice would move them. The meshes settlement.js
   makes as they fill grow by themselves (packed), and are left to.
   ------------------------------------------------------------------------- */
export function growCamps(need) {
  if (!campParts || need <= campCapacity) return;
  let room = Math.max(campCapacity, 1);
  while (room < need) room *= 2;
  for (const key of Object.keys(campParts)) {
    const old = campParts[key];
    if (!old?.isInstancedMesh) continue;
    const house = Boolean(old.name?.startsWith('camp-'));
    const per = key in CAMP_PIECES ? CAMP_PIECES[key] : key === 'fire' ? HEARTHS : house ? CAMP_PIECES.huts : 0;
    if (!per || old.instanceMatrix.count !== campCapacity * per) continue;
    const m = new THREE.InstancedMesh(old.geometry, old.material, room * per);
    m.name = old.name;
    m.castShadow = old.castShadow;
    m.receiveShadow = old.receiveShadow;
    m.frustumCulled = false;
    m.instanceMatrix.array.set(old.instanceMatrix.array);
    if (old.instanceColor) {
      m.setColorAt(0, _c.setHex(0xffffff));
      m.instanceColor.array.set(old.instanceColor.array);
    }
    for (let i = old.instanceMatrix.count; i < room * per; i++) {
      m.setMatrixAt(i, HIDDEN);
      // A house's own tint, off its slot, as makeHouses (settlement.js) gives every one.
      if (house) {
        const t = ((i * 2654435761) >>> 0) / 4294967296;
        m.setColorAt(i, _c.setRGB(0.88 + t * 0.12, 0.86 + t * 0.12, 0.84 + t * 0.12));
      }
    }
    m.count = old.count >= old.instanceMatrix.count ? room * per : old.count;
    tribeGroup.remove(old);
    old.dispose();                    // its own buffers; the geometry is shared
    tribeGroup.add(m);
    campParts[key] = m;
  }
  campCapacity = room;
  // What bands raise over their dead stands in a slot per camp too.
  if (graveMesh) {
    tribeGroup.remove(graveMesh);
    graveMesh.geometry.dispose();
    graveMesh.dispose();
    buildGraves();
  }
  // And a column of smoke for every camp there could be.
  if (smoke) {
    tribeGroup.remove(smoke);
    smoke.geometry.dispose();
    buildSmoke();
  }
}

/** The whole band, after anything that could have moved somebody's slot. */
export function paintPeople() {
  if (!personParts) return;
  /* Settle who leads before painting them. `camp.chief` is only re-resolved
     when something asks, and the only thing that used to ask was the band card
     — so a chief who died stayed in ochre until somebody opened a panel. This
     runs on every change to the band, which is exactly when a chief can change. */
  for (const c of camps) chiefOf(c);
  /* And put the camps right while we are here. Both happen for the same reason
     — the band changed — and both used to be settled only when somebody opened
     a panel and asked. */
  dressCamps();
  undressAll(people);
  for (let i = 0; i < people.length && i < peopleCapacity; i++) paintPerson(i, people[i]);
  for (const key in personParts) {
    if (personParts[key].instanceColor) personParts[key].instanceColor.needsUpdate = true;
  }
}

/* A heap of seven, piled: six round the edge and one on top, with its base at
   nought so it sits on the rim of whatever it is put in. Round things, because
   the same heap has to read as berries, fruit or a catch depending only on its
   colour and the stretch it is given. */
export function heapGeo(w, h, d) {
  const r = h * 0.5;
  const parts = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    parts.push(new THREE.IcosahedronGeometry(r, 0)
      .translate(Math.cos(a) * (w / 2 - r), r * 0.9, Math.sin(a) * (d / 2 - r)));
  }
  parts.push(new THREE.IcosahedronGeometry(r * 1.1, 0).translate(0, r * 1.7, 0));
  return joinGeometries(parts);
}

/* A basket: a tapered tub with a handle arched over it. */
export function basketGeoFrom(top, bottom, height) {
  const tub = new THREE.CylinderGeometry(top, bottom, height, 12);
  const handle = new THREE.TorusGeometry(top * 0.92, 0.012, 4, 12, Math.PI).translate(0, height / 2, 0);
  return joinGeometries([tub, handle]);
}

export function buildPeople(count) {
  // Everyone belongs to a camp, so with no camps there is no band — and
  // camps[i % 0] would be an index of NaN.
  if (!camps.length) count = 0;
  const p = PERSON;
  /* The body is the humans-threejs model, piece by piece. Every piece arrives
     already hanging from its own joint — the torso from the hips, the neck from
     its base, a thigh from the hip, a foot from the ankle — so rotating a
     piece's matrix turns it about that joint with no shifting here. Copied
     rather than shared: a geometry owns its arrays, and the module's are
     everybody's. */
  const body = (key) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(HUMAN_PARTS[key].positions.slice(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(HUMAN_PARTS[key].normals.slice(), 3));
    return g;
  };
  /* No torso: nobody is seen without the hide, which is cut from the model's
     two torsos and worn over where they would be (looks.js). */
  const neckGeo = body('neck');
  // From the base of the skull to its middle, which is where the rig holds it.
  const headGeo = body('head').translate(0, -p.headDrop, 0);
  const upperArmGeo = body('upperArm');
  const foreArmGeo = body('forearm');
  const handGeo = body('hand');
  const thighGeo = body('thigh');
  const shinGeo = body('calf');
  const footGeo = body('foot');                    // forward of the ankle, like a foot
  const spearGeo = roundLimb(...p.spear);
  /* What is carried, as a heap rather than a box, and the basket it goes in. */
  const loadGeo = heapGeo(...p.load);
  const basketGeo = basketGeoFrom(...p.basket);

  /* A new band is a new line. Without this the record kept growing across every
     world ever loaded — nobody was wrongly linked to anybody, because ids are
     unique, but the record filled with people from worlds that no longer exist
     and a founder's ancestry search walked a list of strangers.

     A restored save puts its own record back over the top of this, because
     applySavedLife runs after the world is built. */
  setLineage([]);

  personParts = {};
  /* Room for everybody the island can feed, not four times the band that
     happens to start on it.

     An InstancedMesh cannot be resized, so this number is decided here or not
     at all — which is why it used to be tied to the starting count: allocating
     for a crowd that might never arrive looked like paying for nothing. It is
     not. Only the people who exist are ever submitted (`hidePeopleFrom` turns
     the draw count down to the living band), so an empty slot costs its matrix
     and no drawing at all — about a kilobyte each across the seventeen pieces.
     Room for two thousand is a couple of megabytes and no frames.

     What it was costing instead was the run: PEOPLE=16 meant the world stopped
     at 64 however much food there was, and it stopped by refusing births rather
     than by anybody going hungry — a ceiling with no reason in the world behind
     it, which is the one kind this simulation should not have. Now the only
     thing that stops a band growing is the island: the ground it forages, the
     winters, and how many fires fit on it.

     `count` still floors it, because somebody may start more people than the
     ground would carry and they have to be drawable on the first frame. */
  /* Where the room starts, not where it ends: growPeople makes more when the
     bands fill it. */
  setPeopleCapacity(Math.max(count, PEOPLE_ROOM));
  const n = peopleCapacity;
  const GEOMETRY = {
    neck: neckGeo, head: headGeo,
    upperArm: upperArmGeo, foreArm: foreArmGeo, hand: handGeo,
    thigh: thighGeo, shin: shinGeo, foot: footGeo,
    spear: spearGeo, load: loadGeo, basket: basketGeo,
  };
  for (const key in PERSON_PARTS) {
    const geo = GEOMETRY[key], per = partsPer(key);
    const m = new THREE.InstancedMesh(geo, faunaMaterial, n * per);
    m.name = 'person-' + key;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    tribeGroup.add(m);
    personParts[key] = m;
  }
  // And everything the body is dressed in, as much room again.
  buildLooks(tribeGroup, n);

  const rng = mulberry32(P.seed ^ 0x77aa1234);
  for (let i = 0; i < count; i++) {
    const camp = camps[i % camps.length];
    /* An age spread rather than sixteen thirty-year-olds. A plain exponential
       looked right on paper and gave eleven children to five adults — a band
       that cannot feed itself, since only adults forage and hunt. So: about a
       third children spread evenly through childhood, the rest adults thinning
       out with age. Everything else about a person — build, size, whether they
       are a child — follows from this one number. */
    const age = rng() < 0.35
      ? rng() * LIFE.adultAt
      : Math.min(72, LIFE.adultAt + -Math.log(1 - rng()) * 16);
    const person = newPerson(camp, rng, age);
    recordPerson(person);
    people.push(person);
    paintPerson(i, person);
  }
  /* The spare slots are not drawn at all rather than parked at zero scale.
     This used to park them, which meant a freshly built world submitted every
     one of the largest-possible band's seventeen pieces until the first birth
     or death happened to call hidePeopleFrom and turn the count down. */
  hidePeopleFrom(count);
  for (const c of camps) {
    c.pop = 0; c.need = 0;
    for (const p of people) if (p.camp === c) c.need += p.child ? FOOD.child : FOOD.adult;
    // Nobody arrives at a brand-new camp starving.
    c.food = c.need * FOOD.startingDays;
  }
  /* Households, tents and hearths, before anybody takes a step.

     This used to happen only when the band changed — a birth, a death, somebody
     leaving — because that is when the tents standing in a camp change. But it
     is also what decides which fire a person lives at, and until it has run
     nobody has one: a world spent its first day with every hut hidden and its
     whole band walking to the middle of the village, and then quietly came
     right the first time somebody was born. Founding a band is a change to it,
     and the largest one there is. */
  dressCamps();
  stats.people = count;
}

/* personParts lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
/* -------------------------------------------------------------------------
   The near set: detail for the one person you are actually looking at

   A face is legible at about four metres. So is a knuckle. Everything a person
   is made of is an InstancedMesh sized to the whole island — eighteen pieces
   times room for two thousand people — so putting eyes on everybody costs four
   thousand instances to be seen on one figure, and a hand of fingers costs
   twenty thousand.

   This is the other way round: plain meshes, one set of them, moved onto
   whoever is being followed and hidden the rest of the time. The cost is fixed
   and does not care how many people there are — a village of four hundred draws
   exactly the same face as a band of nine, because it is the same face.

   They hang off the matrices `writePerson` has already worked out, so a face
   cannot drift from the head it is on: the head's matrix carries the person's
   build, their crouch, the bob of their walk and which way they are looking,
   and the eyes are placed in the head's own space.
   ------------------------------------------------------------------------- */
export let nearParts = null;

export function buildNearParts() {
  const S = PERSON;
  const mk = (geo, hex) => {
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: hex }));
    m.visible = false;
    m.frustumCulled = false;
    tribeGroup.add(m);
    return m;
  };
  /* A joint is a ball at the seam between two capsules, sized off the thinner
     of the two so it never stands proud of the limb it belongs to. */
  const ball = (w) => new THREE.SphereGeometry(w * 0.5, 7, 5);
  const digit = roundBox(S.hand[0] * 0.22, S.hand[1] * 0.52, S.hand[2] * 0.7);
  const thumb = roundBox(S.hand[0] * 0.24, S.hand[1] * 0.40, S.hand[2] * 0.7);
  const skin = 0xb08a68;
  const hand = () => ({
    digit: [mk(digit, skin), mk(digit, skin), mk(digit, skin), mk(digit, skin)],
    thumb: mk(thumb, skin),
  });
  nearParts = {
    /* Two of each, indexed by side the way every other limb is. */
    elbow: [mk(ball(S.foreArm[0]), skin), mk(ball(S.foreArm[0]), skin)],
    wrist: [mk(ball(S.hand[0] * 0.9), skin), mk(ball(S.hand[0] * 0.9), skin)],
    knee: [mk(ball(S.shin[0]), skin), mk(ball(S.shin[0]), skin)],
    fingers: [hand(), hand()],
  };
}

/** Nobody is being followed, or they are out of sight: put it all away. */
/* Every mesh in the set, however deep it is nested. The set grew a hand of
   fingers and a `for (const k in nearParts)` stopped reaching half of it — a
   face put away while ten fingers stayed on the world. */
export function eachNearPart(fn) {
  if (!nearParts) return;
  const walk = (v) => {
    if (!v) return;
    if (v.isMesh) fn(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(nearParts);
}

export function hideNearParts() {
  eachNearPart((m) => { m.visible = false; });
}

export function setNearParts(v) { nearParts = v; }

export function setPersonParts(v) { personParts = v; }

/* graves lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setGraves(v) { graves = v; }

/* graveMesh lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setGraveMesh(v) { graveMesh = v; }
