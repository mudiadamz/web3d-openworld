import * as THREE from 'three';

import { CAMP_CEILING, MAP_SCALE, P, PEOPLE_CEILING, QUALITY, SEA, SNOW } from './params.js';
import { clamp, flatnessAt, mulberry32, sampleHeight } from './noise.js';
import { faunaMaterial, rockMaterial } from './scene.js';
import { HIDDEN, _c, _e, _m4, _q, _s, _v, stats, world } from './world.js';
import { recordPerson, setLineage, tribeVoice, uniqueName, usedNames } from './wildlife.js';
import { PERSON, PERSON_PARTS, partsPer } from './clock.js';
import {
  FOOD, LIFE, chiefOf, hidePeopleFrom, newPerson, peopleCapacity, personAge, setPeopleCapacity, simDay
} from './life.js';
import { codeColor, worldCode } from './ui.js';

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
   ------------------------------------------------------------------------- */

/* Measured rather than guessed: at HIGH these take the scene from 1.85M
   triangles to 2.06M, about a nine percent rise, because a world of this size
   is grass and terrain and the bodies in it are a rounding error. Roundness was
   the cheapest thing on the list. */
export const ROUND_RINGS = [[0, 0], [8, 5], [10, 7]];       // [radial, rings] per level

/* A torso is the one part an ellipsoid cannot do: a person is wide at the
   shoulders, narrow at the waist and wide again at the hips, and that double
   curve is most of what makes a silhouette read as a body. A lathe turns a
   profile about the vertical axis, and the cross-section is then squashed
   front-to-back, because a chest is wider than it is deep.

   The profile runs bottom to top in fractions of the half-height, with the
   radius as a fraction of the half-width. It starts and ends on the axis so the
   shape closes at both ends. */
export const TORSO_PROFILE = [
  [0.00, -1.00], [0.58, -0.94], [0.93, -0.74],   // seat and hips
  [0.86, -0.34], [0.75, -0.02],                  // waist
  [0.93, 0.34], [0.90, 0.62],                    // chest
  [0.64, 0.90], [0.00, 1.00],                    // shoulders
];

export function torsoGeometry(w, h, d) {
  const [seg] = ROUND_RINGS[QUALITY[P.quality]?.round ?? 2];
  if (!seg) return new THREE.BoxGeometry(w, h, d);
  const pts = TORSO_PROFILE.map(([r, y]) => new THREE.Vector2(r * w * 0.5, y * h * 0.5));
  const g = new THREE.LatheGeometry(pts, Math.max(seg, 7));
  g.scale(1, 1, d / w);
  g.computeVertexNormals();
  return g;
}

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

export const BUILDS = {
  m:     { scale: [1.00, 1.07], shoulder: 1.07, hip: 0.97, head: 1.00, hair: 0.85 },
  f:     { scale: [0.92, 0.98], shoulder: 0.94, hip: 1.06, head: 1.00, hair: 4.20 },
  child: { scale: [0.58, 0.76], shoulder: 0.95, hip: 0.98, head: 1.18, hair: 1.20 },
};

export const SKIN = [0x8d5a3b, 0x6f4429, 0xa9754c, 0x5a3620, 0xc08a5e, 0x7b4e33];
export const GARMENT = [0x7a6248, 0x8e7355, 0x5f5340, 0x9a7f5c, 0x6b543c, 0xa08a63];
export const HAIR = [0x181310, 0x2b1d14, 0x3d2a1a, 0x4a3626];

// Unlit on purpose: a flame is a light source, not a lit surface, and a Lambert
// flame goes dark at exactly the moment it should be brightest.
export const fireMaterial = new THREE.MeshBasicMaterial({ color: 0xffb347 });

export const camps = [];        // { x, z, huts, light, ... }
export const people = [];
export let personParts = null, campParts = null, smoke = null;
export const tribeGroup = new THREE.Group();

export function clearTribe() {
  usedNames.clear();
  camps.length = 0;
  people.length = 0;
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
      // Keep camps apart, or two bands end up sharing one fire.
      if (camps.some((c) => Math.hypot(c.x - x, c.z - z) < 260 * MAP_SCALE)) continue;
      const flat = flatnessAt(x, z);
      if (flat > bestFlat) { bestFlat = flat; best = { x, z }; }
      if (flat > 0.985) break;                    // good enough, stop looking
    }
    if (!best) continue;
    const crng = mulberry32((P.seed ^ 0xc0ffee) + i * 977);
    const voice = tribeVoice(crng);
    camps.push({
      index: camps.length, x: best.x, z: best.z, y: sampleHeight(best.x, best.z),
      rng: crng, voice, name: uniqueName(crng, 2 + ((crng() * 2) | 0), voice),
      /* The same two-characters-and-a-hue the worlds wear, from the camp's own
         seed. Once a chronicle spans several bands over several worlds, a line
         has to say whose it is in less space than a name takes. */
      code: worldCode((P.seed ^ 0x1d3f) + i * 6151),
      get color() { return codeColor(this.code); },
      food: 0, pop: 0, need: 0, hunger: 0, wasEmpty: false,
      // Everything it will ever know, it has to work out.
      skill: { spears: 0, baskets: 0, drying: 0 },
      told: { spears: 0, baskets: 0, drying: 0 },
      /* What has happened to them, kept per band rather than per world. A
         chronicle says one thing at a time; this is the thing you can only see
         by adding them up — that one camp lost nine to a sickness and the other
         starved. */
      toll: { age: 0, infancy: 0, hunger: 0, exhaustion: 0, sickness: 0, tiger: 0 },
      born: 0, peak: 0, founded: simDay, gone: false,
      history: [],
    });
  }
}

export const CAMP_CLEARING = 17;      // metres of trampled ground around a fire

export function inCamp(x, z, extra = 0) {
  for (let i = 0; i < camps.length; i++) {
    const c = camps[i];
    if (Math.hypot(c.x - x, c.z - z) < CAMP_CLEARING + extra) return true;
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

   Saved with everything else, so they survive a reload; capped, because an
   InstancedMesh cannot grow and a world left running for a century should not
   be able to spend all of memory on headstones.
   ------------------------------------------------------------------------- */

export const GRAVE_MAX = 400;
export const GRAVE_STONES = 3;       // stones per cairn
export let graves = [];              // { x, z, y, day, sex }
export let graveMesh = null;

export function buildGraves() {
  const geo = new THREE.DodecahedronGeometry(1, 0);
  graveMesh = new THREE.InstancedMesh(geo, rockMaterial, GRAVE_MAX * GRAVE_STONES);
  graveMesh.castShadow = true;
  graveMesh.receiveShadow = true;
  graveMesh.frustumCulled = false;
  for (let i = 0; i < GRAVE_MAX * GRAVE_STONES; i++) graveMesh.setMatrixAt(i, HIDDEN);
  tribeGroup.add(graveMesh);
  drawGraves();
}

/* Stacked rather than scattered: three stones getting smaller, each one turned
   differently, which is enough to read as piled by somebody at this size. */
export function drawGraves() {
  if (!graveMesh) return;
  const n = Math.min(graves.length, GRAVE_MAX);
  for (let g = 0; g < n; g++) {
    const it = graves[g];
    const rng = mulberry32((it.x * 131 + it.z * 977 + it.day * 7) | 0);
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
  for (let i = n * GRAVE_STONES; i < GRAVE_MAX * GRAVE_STONES; i++) {
    graveMesh.setMatrixAt(i, HIDDEN);
  }
  graveMesh.instanceMatrix.needsUpdate = true;
  if (graveMesh.instanceColor) graveMesh.instanceColor.needsUpdate = true;
  graveMesh.computeBoundingSphere();
  stats.graves = n;
}

/* The oldest goes when there is no room, which is the wrong way round for a
   record and the right way round for a view: the cairns you can still find are
   the ones from living memory. The chronicle keeps the rest. */
export function buryPerson(p) {
  graves.push({
    x: Math.round(p.x * 100) / 100,
    z: Math.round(p.z * 100) / 100,
    y: sampleHeight(p.x, p.z),
    day: Math.floor(simDay),
    sex: p.sex,
  });
  if (graves.length > GRAVE_MAX) graves.splice(0, graves.length - GRAVE_MAX);
  drawGraves();
}

/* Tents per camp. Six was a band; a camp that grows into a village needs one
   tent per family and there can be a dozen families round one fire. */
export const CAMP_PIECES = { huts: 14, stones: 9, logs: 4, poles: 3 };
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
  families.forEach((f, i) => {
    const hut = camp.huts[Math.min(i, camp.huts.length - 1)];
    for (const p of [...f.adults, ...f.kids]) p.hut = hut;
  });
}

export function dressCamp(camp) {
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
  for (let i = 0; i < P0.huts; i++) {
    const slot = index * P0.huts + i;
    if (i < want && camp.hutAt?.[i]) campParts.huts.setMatrixAt(slot, camp.hutAt[i]);
    else campParts.huts.setMatrixAt(slot, HIDDEN);
  }
  campParts.huts.instanceMatrix.needsUpdate = true;

  /* The rack. Standing only if somebody in the band knows what it is for. */
  const knows = (camp.skill?.drying || 0) >= RACK_KNOWN;
  for (let i = 0; i < P0.poles; i++) {
    const slot = index * P0.poles + i;
    if (knows && camp.rackAt?.[i]) campParts.poles.setMatrixAt(slot, camp.rackAt[i]);
    else campParts.poles.setMatrixAt(slot, HIDDEN);
  }
  campParts.poles.instanceMatrix.needsUpdate = true;
}

export function dressCamps() { for (const c of camps) dressCamp(c); }

export function layoutCamp(camp, index) {
  const rng = camp.rng;
  const P0 = CAMP_PIECES;
  camp.people = [];
  camp.huts = [];

  /* Every hut a camp could have is placed; how many of them are standing is
     decided by dressCamp, and changes as the band does. Laying them out once
     matters because the layout comes off the camp's own rng, and re-running it
     every time somebody is born would shuffle the whole camp around them. */
  for (let i = 0; i < P0.huts; i++) {
    const slot = index * P0.huts + i;
    // A ring of shelters facing the fire, which is what a camp actually is.
    const a = (i / P0.huts) * Math.PI * 2 + rng() * 0.5;
    const r = 6.5 + rng() * 2.6;
    const x = camp.x + Math.cos(a) * r, z = camp.z + Math.sin(a) * r;
    const sc = 0.85 + rng() * 0.4;
    camp.huts.push({ x, z });
    _e.set(0, -a, 0); _q.setFromEuler(_e);
    _v.set(x, sampleHeight(x, z) - 0.15, z);
    _s.set(sc, sc * (0.9 + rng() * 0.3), sc);
    camp.hutAt = camp.hutAt || [];
    camp.hutAt[i] = _m4.clone();
    campParts.huts.setMatrixAt(slot, _m4.compose(_v, _q, _s));
    campParts.huts.setColorAt(slot, _c.setHex(0x6d5740 + ((rng() * 0x101010) | 0)));
  }

  for (let i = 0; i < P0.stones; i++) {          // the fire ring
    const a = (i / P0.stones) * Math.PI * 2;
    const x = camp.x + Math.cos(a) * 1.15, z = camp.z + Math.sin(a) * 1.15;
    const sc = 0.7 + rng() * 0.7;
    _e.set(rng() * 3, rng() * 3, rng() * 3); _q.setFromEuler(_e);
    _v.set(x, sampleHeight(x, z) + 0.06, z);
    _s.set(sc, sc * 0.8, sc);
    campParts.stones.setMatrixAt(index * P0.stones + i, _m4.compose(_v, _q, _s));
    campParts.stones.setColorAt(index * P0.stones + i, _c.setHex(0x6e6862));
  }

  for (let i = 0; i < P0.logs; i++) {            // logs to sit on
    const a = (i / P0.logs) * Math.PI * 2 + 0.4 + rng() * 0.3;
    const x = camp.x + Math.cos(a) * 2.6, z = camp.z + Math.sin(a) * 2.6;
    _e.set(0, -a + Math.PI / 2, 0); _q.setFromEuler(_e);
    _v.set(x, sampleHeight(x, z) + 0.17, z);
    _s.setScalar(0.9 + rng() * 0.3);
    campParts.logs.setMatrixAt(index * P0.logs + i, _m4.compose(_v, _q, _s));
    campParts.logs.setColorAt(index * P0.logs + i, _c.setHex(0x5b4630));
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
    camp.rackAt[pole - index * P0.poles] = _m4.clone();
    campParts.poles.setMatrixAt(pole, _m4.compose(_v, _q, _s));
    campParts.poles.setColorAt(pole, _c.setHex(0x7d6446));
    pole++;
  }
  _e.set(0, -ra, Math.PI / 2); _q.setFromEuler(_e);
  _v.set(rx, sampleHeight(rx, rz) + 1.85, rz);
  _s.set(1, 0.95, 1);
  campParts.poles.setMatrixAt(pole, _m4.compose(_v, _q, _s));
  camp.rackAt[pole - index * P0.poles] = _m4.clone();
  campParts.poles.setColorAt(pole, _c.setHex(0x7d6446));

  _e.set(0, 0, 0); _q.setFromEuler(_e);
  _v.set(camp.x, camp.y + 0.05, camp.z);
  _s.setScalar(1);
  const fire = _m4.clone().compose(_v, _q, _s);
  campParts.fire.setMatrixAt(index, fire);
  campParts.fireBase[index] = fire;

  /* The fire is the only light in the world that is not the sky. It earns a
     real point light: at night it is what the camp is lit by. */
  const light = new THREE.PointLight(0xff8b3a, 0, 42, 2);
  light.position.set(camp.x, camp.y + 0.9, camp.z);
  tribeGroup.add(light);
  camp.light = light;
  camp.flicker = rng() * 10;

  for (const key of ['huts', 'stones', 'logs', 'poles', 'fire']) {
    campParts[key].instanceMatrix.needsUpdate = true;
    if (campParts[key].instanceColor) campParts[key].instanceColor.needsUpdate = true;
  }
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

  /* Room for the bands that do not exist yet. A camp that outgrows its fire
     splits, and the half that leaves needs somewhere to put its huts. */
  /* Twelve was a small island's worth. A camp splits when it outgrows its fire
     and the half that leaves needs somewhere to put its tents, so the ceiling
     has to be what the map can hold rather than what it started with. */
  campCapacity = Math.round(clamp(camps.length * 3, 4, CAMP_CEILING));

  campParts = {};
  campParts.huts = instancedFrom(hutGeo, campCapacity * CAMP_PIECES.huts, tribeGroup);
  campParts.stones = instancedFrom(stoneGeo, campCapacity * CAMP_PIECES.stones, tribeGroup);
  campParts.logs = instancedFrom(logGeo, campCapacity * CAMP_PIECES.logs, tribeGroup);
  campParts.poles = instancedFrom(poleGeo, campCapacity * CAMP_PIECES.poles, tribeGroup);
  campParts.fire = new THREE.InstancedMesh(fireGeo, fireMaterial, campCapacity);
  campParts.fire.frustumCulled = false;
  tribeGroup.add(campParts.fire);
  campParts.fireBase = [];

  /* Everything is parked out of sight first, so the slots belonging to camps
     that have not been founded yet are not drawn as a heap at the origin. */
  for (const [key, per] of Object.entries(CAMP_PIECES)) {
    for (let i = 0; i < campCapacity * per; i++) campParts[key].setMatrixAt(i, HIDDEN);
    campParts[key].setColorAt(0, _c.setHex(0x808080));
  }
  for (let i = 0; i < campCapacity; i++) campParts.fire.setMatrixAt(i, HIDDEN);

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
  if (!camp) {
    smoke.geometry.attributes.position.array[i * 3 + 1] = -9999;
    smoke.geometry.attributes.aLife.array[i] = 0;
    return;
  }
  const p = smoke.geometry.attributes.position.array;
  p[i * 3] = camp.x + (Math.random() - 0.5) * 0.4;
  p[i * 3 + 1] = camp.y + 0.6;
  p[i * 3 + 2] = camp.z + (Math.random() - 0.5) * 0.4;
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
     panel — so the chief gets ochre on the shoulders and a band round the head,
     and you can pick them out of a crowd from the ridge. Repainted whenever the
     band changes, which is when a chief can change. */
  const leads = p.camp && p.camp.chief === p.id;
  personParts.torso.setColorAt(i, leads
    ? _c.setHex(CHIEF_CLOTH)
    : _c.setHex(p.garment).multiplyScalar(p.garmentShade));
  personParts.hair.setColorAt(i, leads ? _c.setHex(CHIEF_BAND) : _c.setHex(p.hairColor));
  personParts.spear.setColorAt(i, _c.setHex(0x6b5334));
  personParts.load.setColorAt(i, _c.setHex(0x7b6a45));
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
  for (let i = 0; i < people.length && i < peopleCapacity; i++) paintPerson(i, people[i]);
  for (const key in personParts) {
    if (personParts[key].instanceColor) personParts[key].instanceColor.needsUpdate = true;
  }
}

export function buildPeople(count) {
  // Everyone belongs to a camp, so with no camps there is no band — and
  // camps[i % 0] would be an index of NaN.
  if (!camps.length) count = 0;
  const p = PERSON;
  /* Every limb piece is modelled hanging from its own joint — the geometry is
     shifted down by half its length so that rotating the matrix rotates it
     about the shoulder, elbow, hip or knee rather than about its middle. */
  const hang = (dims) => {
    const g = roundLimb(...dims);
    g.translate(0, -dims[1] / 2, 0);
    return g;
  };
  const torsoGeo = torsoGeometry(...p.torso);
  torsoGeo.translate(0, p.torsoMid, 0);            // pivot at the waist
  const neckGeo = hang(p.neck);
  const headGeo = roundBox(...p.head);
  const hairGeo = roundBox(...p.hair);
  const upperArmGeo = hang(p.upperArm);
  const foreArmGeo = hang(p.foreArm);
  const handGeo = roundBox(...p.hand);
  handGeo.translate(0, -p.hand[1] / 2, 0);
  const thighGeo = hang(p.thigh);
  const shinGeo = hang(p.shin);
  // A foot sits forward of the ankle rather than under it, like a foot.
  const footGeo = roundBox(...p.foot);
  footGeo.translate(0, -p.foot[1] / 2, p.footZ);
  const spearGeo = roundLimb(...p.spear);
  const loadGeo = roundBox(...p.load);

  /* A new band is a new line. Without this the record kept growing across every
     world ever loaded — nobody was wrongly linked to anybody, because ids are
     unique, but the record filled with people from worlds that no longer exist
     and a founder's ancestry search walked a list of strangers.

     A restored save puts its own record back over the top of this, because
     applySavedLife runs after the world is built. */
  setLineage([]);

  personParts = {};
  /* Room to grow into. The slider says how many the band starts with; births
     and deaths decide the rest, and an InstancedMesh cannot be resized, so it
     is allocated with headroom and the population is capped there. */
  /* Room to grow into, and the ceiling is what the island can hold rather than
     what the first band needs. A cap of 240 is a large village and nowhere near
     the thousands a big map can feed — and an InstancedMesh cannot be resized
     once built, so this is decided here or not at all. */
  setPeopleCapacity(Math.round(clamp(count * 4, 12, PEOPLE_CEILING)));
  const n = peopleCapacity;
  const GEOMETRY = {
    torso: torsoGeo, neck: neckGeo, head: headGeo, hair: hairGeo,
    upperArm: upperArmGeo, foreArm: foreArmGeo, hand: handGeo,
    thigh: thighGeo, shin: shinGeo, foot: footGeo,
    spear: spearGeo, load: loadGeo,
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
  stats.people = count;
}

/* personParts lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setPersonParts(v) { personParts = v; }

/* graves lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setGraves(v) { graves = v; }

/* graveMesh lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setGraveMesh(v) { graveMesh = v; }
