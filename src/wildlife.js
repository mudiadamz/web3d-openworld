import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { P, SEA, SNOW, WORLD } from './params.js';
import { clamp, flatnessAt, mulberry32, sampleHeight } from './noise.js';
import { camera, faunaMaterial } from './scene.js';
import { HIDDEN, _c, fauna, stats } from './world.js';
import { drawingWorld, herdStride, lodStride, lodTurn, luck, turnStart } from './clock.js';
import { inCamp, people, roundBox, roundLimb } from './people.js';
import { killPerson, logEvent, nearestFruit, pickFruit, simDay, who } from './life.js';
import { rebuildFauna } from './move.js';
import { updateHud } from './main.js';

/* -------------------------------------------------------------------------
   Wildlife

   Every animal is a handful of InstancedMeshes — one per body part, shared
   across the whole species — with its instance matrices rewritten each frame.
   As separate objects a 22-strong herd of 8-part deer would be 176 draw calls;
   as instanced parts it is seven, and recomposing the matrices costs nothing.

   Nothing is skinned. A part's matrix is the animal's transform times a local
   pivot rotation, which is all a low-poly gait needs: geometry is pre-shifted
   so its pivot sits at the origin, so a leg is a rotation about the hip, a
   neck a rotation about its base, and a horn a rotation about the skull.

   One description drives all of it. Bison, deer and rabbit are the same forty
   lines of code with different numbers — which is why the size range runs from
   a 5 cm butterfly to a 2 m bison without three copies of the walk cycle.
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   Models

   Real geometry for the living things, loaded from glTF, over the top of the
   procedural shapes rather than instead of them: if a model fails to load — no
   network, a moved URL, a corrupt file — the boxes and cones are still there
   and the page carries on. Nothing here is load-bearing.

   Everything used is a single low-poly mesh animated by morph targets, which is
   what makes it affordable: `InstancedMesh` can carry per-instance morph state,
   so a hundred birds are one draw call with a hundred different wingbeats.

   All four numbers per model — the scale, the ground offset, the facing, the
   clip — were measured off the files rather than guessed. The three birds and
   the horse all face +Z, which is this project's forward, so none needs
   rotating; the horse's origin sits 59 units above its hooves, which is why
   there is a ground offset at all.

   Credits: Parrot, Stork, Flamingo and Horse are the example models from the
   three.js repository (originally from ro.me by Mirada). See that repository
   for their licence terms. Anything you drop in `assets/` is yours to account
   for.
   ------------------------------------------------------------------------- */

export const MODEL_SOURCE = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r169/examples/models/gltf/';

/* `fit` is how many metres the model's longest axis should end up being. Point
   `url` at a file in `assets/` to use your own — see the README for where to
   find CC0 packs with animals and people that actually belong in this world. */
export const MODELS = {
  birds: [
    { url: MODEL_SOURCE + 'Parrot.glb', fit: 0.85 },
    { url: MODEL_SOURCE + 'Stork.glb', fit: 1.05 },
    { url: MODEL_SOURCE + 'Flamingo.glb', fit: 1.00 },
  ],
  // A horse is not a deer and is certainly not a bison. It is, however, an
  // actual quadruped, and at these two very different sizes the herds read as
  // two different animals. Off by default: see the note in the README about
  // what a single-mesh model costs in behaviour.
  quadruped: {
    deer: { url: MODEL_SOURCE + 'Horse.glb', fit: 1.9 },
    bison: { url: MODEL_SOURCE + 'Horse.glb', fit: 2.9 },
  },
};

/* A ceiling on how many of a thing may become models. Fifteen morph targets a
   vertex is affordable across a flock and ruinous across a herd of hundreds, and
   the sliders go to two hundred. Past this a species keeps its built-in shapes —
   consistent within a species, so a herd never comes out half real. */
export const MODEL_MAX_INSTANCES = 90;

export const modelCache = new Map();     // url → measured, ready-to-instance entry
export let modelsPending = false;

export async function loadModel(url) {
  if (modelCache.has(url)) return modelCache.get(url);
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().load(url, resolve, undefined, reject);
  });
  let mesh = null;
  gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  if (!mesh) throw new Error(`no mesh in ${url}`);

  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const clip = gltf.animations[0] || null;
  // The mixer drives the loaded mesh itself, so the clip's track names bind to
  // the node they were authored against. Reading its influences back out is how
  // every instance gets its own moment in the animation.
  const mixer = new THREE.AnimationMixer(gltf.scene);
  if (clip) mixer.clipAction(clip).play();

  const entry = {
    url, geometry: mesh.geometry, material: mesh.material, clip, mixer, scratch: mesh,
    span: Math.max(size.x, size.y, size.z),
    minY: box.min.y,
  };
  modelCache.set(url, entry);
  return entry;
}

export function wantedModelUrls() {
  const urls = [];
  if (P.models !== 'off') urls.push(...MODELS.birds.map((m) => m.url));
  if (P.models === 'all') {
    for (const key in MODELS.quadruped) urls.push(MODELS.quadruped[key].url);
  }
  return [...new Set(urls)];
}

/* Fetched in the background and the fauna rebuilt when they arrive, so the
   world is standing there from the first frame and simply gets better. */
export async function loadModels() {
  const urls = wantedModelUrls();
  if (!urls.length || modelsPending) return;
  modelsPending = true;
  const results = await Promise.allSettled(urls.map(loadModel));
  modelsPending = false;
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed) {
    logEvent('models', `${failed} of ${urls.length} models did not load — using the built-in shapes`, 0, 0);
  }
  stats.models = modelCache.size;
  updateHud();
  if (results.some((r) => r.status === 'fulfilled')) rebuildFauna();
}

export function modelFor(url) {
  return P.models === 'off' ? null : modelCache.get(url) || null;
}

/** An instanced mesh of one model, sized so its longest axis is `fit` metres. */
export function makeModelSet(spec, count) {
  const entry = modelFor(spec.url);
  if (!entry || count <= 0 || count > MODEL_MAX_INSTANCES) return null;
  const mesh = new THREE.InstancedMesh(entry.geometry, entry.material, count);
  mesh.frustumCulled = false;
  /* No shadow casting. Every one of these vertices is already being posed by
     fifteen morph targets, and the shadow pass would do the whole thing a
     second time — the single most expensive thing this feature could ask for,
     for a shadow you would struggle to pick out. */
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  fauna.add(mesh);
  return {
    mesh, entry, count,
    scale: spec.fit / entry.span,
    // Models are not modelled with their feet at the origin; the horse's are
    // 59 units below it. Without this the herd walks buried to the knee.
    footOffset: -entry.minY * (spec.fit / entry.span),
  };
}

/* One instance's transform and its own moment in the wingbeat. `setTime` on the
   shared mixer re-evaluates the clip, and `setMorphAt` copies the result into
   the instance's row of the morph texture. */
export function writeModelInstance(set, slot, position, quaternion, scale, phase) {
  _sAnim.setScalar(scale);
  _mAnim.compose(position, quaternion, _sAnim);
  set.mesh.setMatrixAt(slot, _mAnim);
  const e = set.entry;
  if (!e.clip) return;
  e.mixer.setTime(((phase % e.clip.duration) + e.clip.duration) % e.clip.duration);
  set.mesh.setMorphAt(slot, e.scratch);
}

export function flushModelSet(set) {
  if (!set) return;
  set.mesh.instanceMatrix.needsUpdate = true;
  if (set.mesh.morphTexture) set.mesh.morphTexture.needsUpdate = true;
}

// +X is the animal's LEFT: right = forward × up = Z × Y = −X.
export const WALK_GAIT = [0, Math.PI, Math.PI, 0];   // diagonal pairs, front-left with back-right
export const HOP_GAIT = [0.9, 0.9, 0, 0];            // front pair together, back pair together

export const SPECIES = [
  {
    key: 'bison', label: 'Bison',
    legLen: 0.95, legW: 0.17, legD: 0.19, hipX: 0.33, hipZ: 0.60,
    body: [0.84, 0.80, 1.95], bodyY: 0.24,
    hump: { size: [0.72, 0.44, 0.78], pos: [0, 0.54, 0.42] },
    neck: { w: 0.46, d: 0.44, len: 0.40, y: 0.34, z: 0.86, rest: 0.75, graze: 1.55 },
    head: [0.36, 0.36, 0.50],
    horns: { size: [0.09, 0.26, 0.09], x: 0.17, y: 0.12, z: 0.04, tilt: 1.15, color: 0x3a352e },
    tail: [0.07, 0.34, 0.07], tailPos: [0, 0.40, -0.98],
    gait: 'walk', stride: 1.9, walkSpeed: 0.85, fleeSpeed: 4.6, turn: 1.1, fleeRadius: 13,
    scale: [0.94, 1.16], youngChance: 0.14, youngScale: [0.54, 0.68],
    coat: [0x4a3a2e, 0x6a5238], legShade: 0.60,
    herdOf: 5, roam: 11, graze: [22, 40], swing: 0.11, bob: 0.030,
  },
  {
    key: 'deer', label: 'Deer',
    legLen: 0.62, legW: 0.09, legD: 0.11, hipX: 0.17, hipZ: 0.40,
    body: [0.42, 0.44, 1.05], bodyY: 0.12,
    neck: { w: 0.20, d: 0.22, len: 0.46, y: 0.30, z: 0.44, rest: 0.60, graze: 1.95 },
    head: [0.19, 0.21, 0.34],
    tail: [0.09, 0.20, 0.09], tailPos: [0, 0.28, -0.52],
    gait: 'walk', stride: 0.95, walkSpeed: 1.6, fleeSpeed: 6.8, turn: 2.4, fleeRadius: 16,
    scale: [0.90, 1.12], youngChance: 0.17, youngScale: [0.58, 0.67],
    coat: [0x8a6244, 0xb08c5e], legShade: 0.68,
    herdOf: 6, roam: 14, graze: [12, 30], swing: 0.14, bob: 0.020,
  },
  {
    key: 'rabbit', label: 'Rabbits',
    legLen: 0.14, legW: 0.045, legD: 0.055, hipX: 0.062, hipZ: 0.105,
    body: [0.145, 0.155, 0.30], bodyY: 0.045,
    neck: { w: 0.105, d: 0.105, len: 0.075, y: 0.075, z: 0.125, rest: 0.55, graze: 1.60 },
    head: [0.115, 0.115, 0.155],
    // The "horn" slot doing duty as a pair of ears: same pivot-on-the-skull maths.
    horns: { size: [0.030, 0.150, 0.014], x: 0.034, y: 0.070, z: -0.01, tilt: 0.22, color: 0x9a8272 },
    tail: [0.055, 0.055, 0.055], tailPos: [0, 0.10, -0.155],
    gait: 'hop', hop: 0.10, stride: 0.52, walkSpeed: 1.5, fleeSpeed: 5.6, turn: 5.0, fleeRadius: 22,
    scale: [0.86, 1.10], youngChance: 0.18, youngScale: [0.62, 0.74],
    coat: [0x8a7a68, 0xb8a894], legShade: 0.80,
    herdOf: 3, roam: 8, graze: [3, 8], swing: 0.30, bob: 0.010,
  },
  /* The competition. A boar eats fruit off the low branches and the ground
     under them, which is the same fruit the band was going to carry home — so
     an orchard is not simply a resource that regrows, it is one somebody else
     is also working. They are worth hunting for exactly that reason, and they
     are in QUARRY so the band can.

     Built from the same spec as everything else: low, broad, tusked (the horn
     slot again, as the rabbit's ears were), and no great turn of speed. */
  {
    key: 'boar', label: 'Boar', eatsFruit: { reach: 4.5, takes: 2, every: [7, 16], seeks: 90 },
    legLen: 0.34, legW: 0.075, legD: 0.085, hipX: 0.14, hipZ: 0.32,
    body: [0.36, 0.38, 0.86], bodyY: 0.10,
    neck: { w: 0.24, d: 0.24, len: 0.16, y: 0.16, z: 0.38, rest: 1.05, graze: 1.85 },
    head: [0.20, 0.19, 0.34],
    horns: { size: [0.035, 0.10, 0.035], x: 0.075, y: -0.02, z: 0.14, tilt: -0.5, color: 0xd8cdb4 },
    tail: [0.05, 0.16, 0.05], tailPos: [0, 0.24, -0.44],
    gait: 'walk', stride: 0.72, walkSpeed: 1.1, fleeSpeed: 5.2, turn: 2.6, fleeRadius: 15,
    scale: [0.88, 1.10], youngChance: 0.20, youngScale: [0.50, 0.64],
    coat: [0x3a2f26, 0x5c4a38], legShade: 0.70,
    herdOf: 4, roam: 16, graze: [8, 18], swing: 0.18, bob: 0.018,
  },
  /* The one that eats the others. Everything above this line is described by
     where it grazes and how far it runs when something frightens it; a tiger is
     described by what frightens it of nothing and how fast it closes. It uses
     the same body spec — legs off the hips, neck off the body, head off the
     neck — because a tiger is a quadruped like the rest, and reusing the rig is
     what makes it affordable to have one at all.

     Long and low, striped by the coat range being wide rather than by any
     texture, and no horns. It hunts alone: herdOf 1. */
  {
    key: 'tiger', label: 'Tigers', predator: true,
    legLen: 0.52, legW: 0.11, legD: 0.13, hipX: 0.19, hipZ: 0.52,
    body: [0.44, 0.42, 1.32], bodyY: 0.10,
    neck: { w: 0.28, d: 0.28, len: 0.26, y: 0.20, z: 0.60, rest: 1.25, graze: 1.70 },
    head: [0.28, 0.26, 0.34],
    tail: [0.07, 0.72, 0.07], tailPos: [0, 0.20, -0.72],
    gait: 'walk', stride: 1.15, walkSpeed: 1.5, fleeSpeed: 7.4, turn: 2.8, fleeRadius: 0,
    scale: [0.96, 1.12], youngChance: 0.10, youngScale: [0.55, 0.70],
    coat: [0x8a4a18, 0xc8862c], legShade: 0.72,
    herdOf: 1, roam: 60, graze: [10, 26], swing: 0.16, bob: 0.024,
    hunt: {
      // How far it notices, how close it has to be, and how long it eats for.
      sees: 62, reach: 2.2, feeds: 40,
      // A person is harder and rarer than a deer: it prefers four legs.
      prefersAnimals: 6,
      /* A cat's rush is short.

         There was already an end to a chase — the shared animal stamina, which
         breaks a sprint off at `energy < 0.06`. It never once saved anybody,
         because it is on the wrong timescale: a tiger takes upwards of forty
         seconds to blow, and it catches a person in twelve. And a spent tiger
         still runs at FLEE_SPENT of flat out, 3.1 m/s, which is close enough to
         a person's 3.6 that being exhausted barely helps them either.

         So the rush gets its own limit, in seconds, the way an ambush predator
         actually works. If the quarry is still ahead when `chase` runs out it
         gives up and sulks for `sulks` before trying again. Stamina still
         governs the long business of harrying a herd; this governs the pounce.

         What it buys is a graded risk: near the fire you get home, far out you
         probably do not, and how far you forage is a gamble rather than a
         verdict. */
      chase: 11,
      sulks: 30,
      /* Hunger rather than a stopwatch. `fed` runs from 1 down to 0 over
         `lasts` sim-days; below `hunts` it starts looking, and a kill fills it
         by `meal`. A full tiger walks past a deer, which is the difference
         between a predator and a hazard that fires on a timer. */
      /* A big cat kills every few days, not every day. At 2.2 this emptied
         from a kill to the hunting threshold in about one sim-day, so a single
         tiger was hunting something more or less constantly and the island read
         as one continuous chase — which is why turning TIGERS down to 1 barely
         changed anything. At 6 the same fall takes a bit over three days. */
      lasts: 6,             // sim-days a full stomach lasts
      hunts: 0.55,          // starts hunting below this
      meal: 0.8,            // what a kill is worth
      person: 0.5,          // a person is a smaller meal than a deer
      /* Two sighting ranges, not one, and this is the change that matters.

         `sees` is how far off it picks a deer out of the landscape. A person it
         does not notice until `seesPeople`, which is a third of that — the
         difference between a tiger that hunts people and a tiger that takes the
         person who walks into it.

         Without it `prefersAnimals` did nothing most of the time, and the
         arithmetic says why: a couple of hundred animals spread over an island
         900 metres across is less than one animal inside a 62-metre circle, so
         most of the time there was no four-legged option to prefer. A person
         alone in an empty stretch was simply the best thing on offer, from as
         far away as a deer, and got taken. On seed 20260906 that was 11 of 14
         deaths over eight years — against a section comment claiming a tiger is
         what happens to somebody who went too far out on their own. */
      seesPeople: 22,
      /* And never somebody who has company. This is the other half of the rule
         this file has always described and never implemented: "it will take
         somebody who is out alone". It is what makes a foraging party different
         from a foraging person — and it does not make anyone safe, because the
         bold go furthest, arrive first, and are still alone when they do. */
      company: 15,
      /* And only when it is properly hungry.

         `hunts` is when it starts looking. This is how far down it has to be
         before a person is on the list at all — so there is a stretch, most of
         its hunting life, where it is hunting and what it is hunting is deer.

         This is the difference between "prefers animals" and "eats people when
         the hunting has gone badly", and it is the one that shows up in the
         numbers. A stomach falls from full to empty over `lasts` days: it
         starts looking around day 2.7 and only starts counting people around
         day 4.8, by which point it has had two days of failing to find
         anything with four legs. A tiger that hunts well never gets there. */
      desperate: 0.22,
    },
  },
];

export const packs = [];        // one per species: { spec, parts, list, herds }
export let birdParts = null, butterflyParts = null;
export const birdList = [], butterflyList = [];
export let birdSets = [];             // instanced model meshes, one per bird species
export const birdSlot = new Map();    // bird index → which set and which slot in it

export function clearFauna() {
  birdSets = [];
  birdSlot.clear();
  stats.modelled = 0;
  packs.length = 0;
  birdList.length = 0;
  butterflyList.length = 0;
  birdParts = null;
  butterflyParts = null;
}

// Rejection-sample a spot an animal could plausibly stand on.
export function findGround(rng, minFlat, minH, maxH, cx = 0, cz = 0, radius = WORLD * 0.42) {
  for (let t = 0; t < 40; t++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * radius;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const h = sampleHeight(x, z);
    if (h < minH || h > maxH) continue;
    if (flatnessAt(x, z) < minFlat) continue;
    return { x, z };
  }
  return null;
}

export function buildAnimals() {
  fauna.visible = true;
  for (const spec of SPECIES) buildQuadrupeds(spec, P.counts[countKey(spec)] | 0);
  buildBirds(P.counts.birds | 0);
  buildButterflies(P.counts.butterflies | 0);
  recountAnimals();
}

export function countKey(spec) {
  return spec.key === 'rabbit' ? 'rabbits'
    : spec.key === 'tiger' ? 'tigers'
    : spec.key === 'boar' ? 'boars'
    : spec.key;
}

/* Alive, not allocated. A hunted animal keeps its slot in the instanced mesh —
   that is how it can come back later without reallocating anything — so
   counting `list.length` counted the dead too, and the readout never moved when
   the band ate. It is the one number on screen that is supposed to move. */
export function recountAnimals() {
  let alive = 0;
  for (const pack of packs) {
    for (const a of pack.list) if (!a.dead) alive++;
  }
  stats.animals = alive + birdList.length + butterflyList.length;
}

export function addPart(bag, key, geo, count, group) {
  const m = new THREE.InstancedMesh(geo, faunaMaterial, Math.max(count, 1));
  m.castShadow = true;
  m.receiveShadow = true;
  // The herd spans the map and moves, so a cached bounding sphere would be
  // wrong the moment they walk — and a wrong sphere culls animals away.
  m.frustumCulled = false;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(m);
  bag[key] = m;
  return m;
}

export function buildQuadrupeds(spec, count) {
  const parts = {};
  const bodyGeo = roundBox(...spec.body);
  bodyGeo.translate(0, spec.bodyY, 0);
  addPart(parts, 'body', bodyGeo, count, fauna);

  if (spec.hump) {
    const humpGeo = roundBox(...spec.hump.size);
    humpGeo.translate(...spec.hump.pos);
    addPart(parts, 'hump', humpGeo, count, fauna);
  }

  const neckGeo = roundLimb(spec.neck.w, spec.neck.len, spec.neck.d);
  neckGeo.translate(0, spec.neck.len / 2, 0);        // pivot at the base of the neck
  addPart(parts, 'neck', neckGeo, count, fauna);

  const headGeo = roundBox(...spec.head);
  headGeo.translate(0, 0, spec.head[2] * 0.28);      // nose forward of the neck tip
  addPart(parts, 'head', headGeo, count, fauna);

  if (spec.horns) {
    const hornGeo = roundLimb(...spec.horns.size);
    hornGeo.translate(0, spec.horns.size[1] / 2, 0); // pivot where it meets the skull
    addPart(parts, 'horns', hornGeo, count * 2, fauna);
  }

  const tailGeo = roundLimb(...spec.tail);
  tailGeo.translate(0, -spec.tail[1] / 2, 0);
  addPart(parts, 'tail', tailGeo, count, fauna);

  const legGeo = roundLimb(spec.legW, spec.legLen, spec.legD);
  legGeo.translate(0, -spec.legLen / 2, 0);          // pivot at the hip
  addPart(parts, 'legs', legGeo, count * 4, fauna);

  const list = [], herds = [];
  const rng = mulberry32((P.seed ^ 0x2a3b4c5d) + spec.key.charCodeAt(0) * 7919);
  const herdCount = Math.max(1, Math.ceil(count / spec.herdOf));
  for (let i = 0; i < herdCount; i++) {
    const spot = findGround(rng, 0.86, SEA + 2, SNOW - 12) || { x: 60, z: 60 };
    herds.push({ x: spot.x, z: spot.z, timer: 10 + rng() * 60 });
  }

  const coatA = new THREE.Color(spec.coat[0]);
  const coatB = new THREE.Color(spec.coat[1]);
  for (let i = 0; i < count; i++) {
    const h = herds[i % herds.length];
    const spot = findGround(rng, 0.80, SEA + 1.5, SNOW - 8, h.x, h.z, 26) || { x: h.x, z: h.z };
    // Some are young: same animal, smaller. It reads as a herd rather than as
    // a row of clones, and it costs one number.
    const young = rng() < spec.youngChance;
    const scale = young
      ? spec.youngScale[0] + rng() * (spec.youngScale[1] - spec.youngScale[0])
      : spec.scale[0] + rng() * (spec.scale[1] - spec.scale[0]);
    list.push({
      x: spot.x, z: spot.z, yaw: rng() * Math.PI * 2,
      speed: 0, phase: rng() * Math.PI * 2, scale, herd: h,
      state: 'graze', timer: rng() * 8, energy: 0.7 + rng() * 0.3,
      prey: null, rest: rng() * 20,     // only a predator uses these
      fed: 0.35 + rng() * 0.65,
      rootTimer: rng() * 12,            // only a fruit-eater uses this
      targetX: spot.x, targetZ: spot.z,
      neck: spec.neck.rest, grazeDown: rng() < 0.5, lookTimer: 1 + rng() * 5,
      tailOff: rng() * Math.PI * 2,
    });

    _c.copy(coatA).lerp(coatB, rng()).multiplyScalar(0.85 + rng() * 0.3);
    parts.body.setColorAt(i, _c);
    parts.neck.setColorAt(i, _c);
    parts.tail.setColorAt(i, _c);
    if (parts.hump) parts.hump.setColorAt(i, _c.clone().multiplyScalar(0.92));
    parts.head.setColorAt(i, _c.clone().multiplyScalar(0.84));
    if (parts.horns) {
      _hornColor.setHex(spec.horns.color).multiplyScalar(0.85 + rng() * 0.3);
      parts.horns.setColorAt(i * 2, _hornColor);
      parts.horns.setColorAt(i * 2 + 1, _hornColor);
    }
    _c.multiplyScalar(spec.legShade);
    for (let k = 0; k < 4; k++) parts.legs.setColorAt(i * 4 + k, _c);
  }
  hideSpare(parts, count);
  /* If a model is configured for this species and it has arrived, the whole
     animal becomes one instanced mesh and the box parts step aside. The cost is
     real and worth stating: a single mesh cannot put its head down to graze, so
     this trades expressiveness for a silhouette. */
  const modelSpec = P.models === 'all' ? MODELS.quadruped[spec.key] : null;
  const model = modelSpec ? makeModelSet(modelSpec, Math.max(count, 1)) : null;
  if (model) {
    for (const key in parts) parts[key].visible = false;
    stats.modelled += count;
  }
  packs.push({ spec, parts, list, herds, model, gait: spec.gait === 'hop' ? HOP_GAIT : WALK_GAIT });
}

// InstancedMesh counts are padded to at least one, and a slider can leave a
// species at zero. Park the spares at zero scale so they draw nothing.
export function hideSpare(parts, count) {
  for (const key in parts) {
    const per = key === 'legs' ? 4 : key === 'horns' ? 2 : 1;
    for (let i = count * per; i < parts[key].count; i++) parts[key].setMatrixAt(i, HIDDEN);
  }
}

export function buildBirds(count) {
  const bodyGeo = new THREE.ConeGeometry(0.10, 0.46, 4);
  bodyGeo.rotateX(Math.PI / 2);                   // point the nose along +Z
  const wingGeo = new THREE.BoxGeometry(0.44, 0.015, 0.17);
  wingGeo.translate(0.22, 0, 0);                  // pivot at the shoulder
  birdParts = {};
  addPart(birdParts, 'body', bodyGeo, count, fauna);
  addPart(birdParts, 'wings', wingGeo, count * 2, fauna);

  /* Deal the flock out between whichever bird models arrived, so a flock is
     three species rather than one shape repeated. Any bird without a model slot
     falls back to the cone-and-two-boxes below. */
  birdSets = [];
  const haveBirds = MODELS.birds.filter((m) => modelFor(m.url));
  if (haveBirds.length && count > 0) {
    const shares = haveBirds.map(() => []);
    for (let i = 0; i < count; i++) shares[i % haveBirds.length].push(i);
    haveBirds.forEach((spec, s) => {
      const set = makeModelSet(spec, shares[s].length);
      if (!set) return;
      set.birds = shares[s];
      // `.set`, not `[...]` — this is a Map, and property assignment on one
      // silently does nothing: every bird then fell through to the procedural
      // path that had just been hidden, and the flock disappeared.
      shares[s].forEach((b, slot) => birdSlot.set(b, { set: birdSets.length, slot }));
      birdSets.push(set);
    });
    /* Counted off the map that the writer actually reads, not off what was
       intended — the two came apart once already, and a counter that agrees
       with the intention is a counter that cannot catch it. */
    stats.modelled += birdSlot.size;
    if (birdSets.length && birdSlot.size) {
      for (const key in birdParts) birdParts[key].visible = false;
    }
  }

  const rng = mulberry32(P.seed ^ 0x7f4a2c19);
  const featherA = new THREE.Color(0x3b3f4a);
  const featherB = new THREE.Color(0x6b5a4a);
  const start = findGround(rng, 0, -1e9, 1e9) || { x: 0, z: 0 };
  for (let i = 0; i < count; i++) {
    const x = start.x + (rng() - 0.5) * 90;
    const z = start.z + (rng() - 0.5) * 90;
    const b = {
      pos: new THREE.Vector3(x, sampleHeight(x, z) + 45 + rng() * 30, z),
      vel: new THREE.Vector3((rng() - 0.5) * 8, 0, (rng() - 0.5) * 8),
      flap: rng() * Math.PI * 2,
      scale: 0.8 + rng() * 0.5,
      yaw: 0, roll: 0,
    };
    if (b.vel.lengthSq() < 1) b.vel.set(6, 0, 0);
    birdList.push(b);

    _c.copy(featherA).lerp(featherB, rng()).multiplyScalar(0.8 + rng() * 0.4);
    birdParts.body.setColorAt(i, _c);
    birdParts.wings.setColorAt(i * 2, _c);
    birdParts.wings.setColorAt(i * 2 + 1, _c);
  }
  for (let i = count; i < birdParts.body.count; i++) birdParts.body.setMatrixAt(i, HIDDEN);
  for (let i = count * 2; i < birdParts.wings.count; i++) birdParts.wings.setMatrixAt(i, HIDDEN);
}

/* Butterflies are the small end of the range: no flocking, no herd, just a
   home patch of grass and a drunken walk around it. */
export const BUTTERFLY_COLORS = [0xf2efe6, 0xf0c22c, 0xe07a2a, 0x5f86c8, 0xd6d2c0, 0xc85a3a];

export function buildButterflies(count) {
  const bodyGeo = new THREE.BoxGeometry(0.030, 0.030, 0.095);
  const wingGeo = new THREE.BoxGeometry(0.115, 0.005, 0.095);
  wingGeo.translate(0.0575, 0, 0);
  butterflyParts = {};
  addPart(butterflyParts, 'body', bodyGeo, count, fauna);
  addPart(butterflyParts, 'wings', wingGeo, count * 2, fauna);
  butterflyParts.body.castShadow = false;         // too small to read as a shadow
  butterflyParts.wings.castShadow = false;

  const rng = mulberry32(P.seed ^ 0x1bd11bda);
  for (let i = 0; i < count; i++) {
    const spot = findGround(rng, 0.84, SEA + 1.5, SNOW - 20) || { x: 0, z: 0 };
    const b = {
      home: new THREE.Vector2(spot.x, spot.z),
      pos: new THREE.Vector3(spot.x, sampleHeight(spot.x, spot.z) + 0.6 + rng() * 1.6, spot.z),
      vel: new THREE.Vector3((rng() - 0.5) * 2, 0, (rng() - 0.5) * 2),
      flap: rng() * Math.PI * 2,
      flapRate: 17 + rng() * 10,
      scale: 0.75 + rng() * 0.6,
      jitter: 0,
      yaw: 0,
    };
    butterflyList.push(b);

    _c.setHex(BUTTERFLY_COLORS[(rng() * BUTTERFLY_COLORS.length) | 0]);
    butterflyParts.body.setColorAt(i, _c.clone().multiplyScalar(0.35));
    butterflyParts.wings.setColorAt(i * 2, _c);
    butterflyParts.wings.setColorAt(i * 2 + 1, _c);
  }
  for (let i = count; i < butterflyParts.body.count; i++) butterflyParts.body.setMatrixAt(i, HIDDEN);
  for (let i = count * 2; i < butterflyParts.wings.count; i++) butterflyParts.wings.setMatrixAt(i, HIDDEN);
}

/* ---- movement ---- */

export const _mAnim = new THREE.Matrix4();
export const _mLocal = new THREE.Matrix4();
export const _mUpper = new THREE.Matrix4();   // shoulder or hip
export const _mLower = new THREE.Matrix4();   // elbow or knee
export const _mChain = new THREE.Matrix4();
export const _mHead = new THREE.Matrix4();
export const _mOff = new THREE.Matrix4();
export const _qAnim = new THREE.Quaternion();
export const _eAnim = new THREE.Euler();
export const _pAnim = new THREE.Vector3();
export const _sAnim = new THREE.Vector3();
export const _acc = new THREE.Vector3();
export const _centre = new THREE.Vector3();
export const _align = new THREE.Vector3();
export const _sep = new THREE.Vector3();
export const _diff = new THREE.Vector3();
export const _hornColor = new THREE.Color();

export function pickTarget(d, spec) {
  for (let t = 0; t < 12; t++) {
    const a = luck() * Math.PI * 2;
    const r = Math.sqrt(luck()) * spec.roam;
    const x = d.herd.x + Math.cos(a) * r, z = d.herd.z + Math.sin(a) * r;
    if (sampleHeight(x, z) < SEA + 1.2) continue;
    if (flatnessAt(x, z) < 0.78) continue;
    d.targetX = x; d.targetZ = z;
    return true;
  }
  return false;
}

/* -------------------------------------------------------------------------
   The tiger

   One animal, hunting alone, and the only thing on the map that kills. It has
   three states and they are the same three every other animal has, so that all
   the movement, turning, tiring and drawing below is shared: lying up is
   'graze', prowling is 'walk', and the charge is 'flee'.

   It prefers four legs to two — a deer is easier and more worth it than a
   person — but it will take somebody who is out alone, and that is where a
   death by tiger comes from. Nothing about it is fair; that is rather the
   point of having one.

   "Somebody who is out alone" is four separate things in the code, and for a
   long time only the first of them existed: a person scores as `prefersAnimals`
   times their real distance, so anything with four legs in sight wins; a person
   is not noticed at all beyond `seesPeople`, which is a third of the range a
   deer is seen at; a person with anyone else within `company` metres is not
   considered at all; and none of it happens unless the tiger is below
   `desperate`, well past merely hungry. The first alone did nothing, because on
   an island this size there is usually no animal in sight to prefer — see the
   note on `seesPeople`.

   Measured the way this file measures things: the same six seeds run eight
   years through each version, counting off `lineage` rather than off the
   panel, which shows a band's two leading causes and drops the rest.

     tigers as a share of all deaths      73%  ->  44%  ->  26%
     tiger deaths across the six seeds     38  ->   27  ->   15
     alive at eight years, six bands       87  ->  105  ->  112

   The three columns are: as it was; with the two sighting rules; with
   `desperate` as well. The middle column is why all three are here — halving
   the range and skipping anyone with company moved it a long way and left
   tigers still the leading cause of death, because a hungry tiger with no
   deer in sight will walk until it finds somebody. The hunger gate is what
   makes that a rare state rather than most of a tiger's week.

   They still kill. Fifteen deaths over forty-eight band-years is a tiger
   that is worth running from, and on seed 20260906 — the one this started
   from — it is still seven of ten deaths, because the hunting is poor on
   that island and a tiger that hunts poorly is exactly the one that comes
   for people. That is the mechanism working, not the mechanism failing.
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   Being hunted

   Deer bolt from a tiger; people did not. The list of threats that makes a herd
   scatter was never read by a person, so a tiger walked up to somebody who
   never looked up — and over eight years that was killing more of a band than
   hunger, sickness and old age together.

   Two things follow from noticing. They run for the fire, and the fire is
   somewhere a tiger will not follow: which turns foraging far from camp into a
   risk somebody is taking rather than a thing that happens to them.
   ------------------------------------------------------------------------- */

export const PANIC = {
  sees: 46,            // metres at which somebody notices a tiger
  runs: 14,            // seconds they keep running once they have
  safe: 9,             // metres from the fire a tiger will not come
  /* ...and how much further out a band that keeps its fire well pushes that.
     At mastery the sanctuary is the size of the trampled ground round a camp —
     so a well-kept fire makes the whole clearing somewhere you are safe rather
     than a place you have to reach the middle of. It is the difference between
     getting home and getting nearly home.

     Which means it has to move when the camp does. A band is a village now: up
     to five hearths spread thirteen metres out with their own rings of tents
     round them, and `CAMP_CLEARING` grew from 17 to 26 to cover it. At 14 this
     stayed 23, and the ground that gained was the outer third of every village
     — somebody would reach their own tent, be inside the camp by every other
     rule in the world, and be taken there. The test that caught it compares
     these two numbers directly, which is why it caught it. */
  fireSafe: 17,
};

/** The ground round this band's fire that a tiger will not cross. */
export const safeGround = (camp) => PANIC.safe + PANIC.fireSafe * (camp?.skill?.fire || 0);

export function nearestPredator(x, z, within) {
  let best = null, bestD = within * within;
  for (const pack of packs) {
    if (!pack.spec.predator) continue;
    for (const a of pack.list) {
      if (a.dead) continue;
      const d = (a.x - x) ** 2 + (a.z - z) ** 2;
      if (d < bestD) { bestD = d; best = a; }
    }
  }
  return best;
}

/* Somebody within `within` metres of them, awake and on their feet. Cheap
   enough to ask per candidate: there are a dozen or two people, and only a
   hungry tiger with something already in sight ever asks. */
export function hasCompany(p, within) {
  const r2 = within * within;
  for (const q of people) {
    if (q === p || q.asleep) continue;
    if ((q.x - p.x) ** 2 + (q.z - p.z) ** 2 < r2) return true;
  }
  return false;
}

export function nearestQuarry(d, spec) {
  const h = spec.hunt;
  let best = null, bestScore = Infinity;

  for (const pack of packs) {
    if (pack.spec.predator) continue;           // it does not hunt its own kind
    for (const a of pack.list) {
      if (a.dead) continue;
      const dist = Math.hypot(a.x - d.x, a.z - d.z);
      if (dist > h.sees) continue;
      // Nearer is better, and four legs are better than two by a wide margin.
      if (dist < bestScore) { bestScore = dist; best = { kind: 'animal', a, pack }; }
    }
  }

  /* Nothing above stops here; the loop below is the one that can be skipped.
     A person is not an alternative to a deer — they are what it comes to when
     there has been no deer for days. */
  if (d.fed > h.desperate) return best;

  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (p.asleep) continue;                     // inside a hut, out of reach
    if (p.climbed) continue;                    // up a tree, out of reach too
    // Nor will it come to the fire. Standing in camp is standing somewhere.
    if (inCamp(p.x, p.z, safeGround(p.camp))) continue;
    const dist = Math.hypot(p.x - d.x, p.z - d.z);
    // Much shorter than the range it spots a deer at: it has to nearly walk
    // into them, rather than pick them out of the middle distance.
    if (dist > h.seesPeople) continue;
    /* Hidden, down and still: it has to nearly walk onto them — a quarter of
       the distance it would notice them at (HIDE_SEEN, in danger.js). */
    if (p.hiding && dist > h.seesPeople * 0.25) continue;
    // And somebody with company is not on the menu at all.
    if (hasCompany(p, h.company)) continue;
    /* A person is scored as though they were much further away, so a tiger with
       any other option takes it. People die when they are the only thing out
       there — which is exactly when they are foraging alone. */
    if (dist * h.prefersAnimals < bestScore) {
      bestScore = dist * h.prefersAnimals;
      best = { kind: 'person', index: i };
    }
  }
  return best;
}

export function updatePredator(d, spec, dt) {
  const h = spec.hunt;

  // Eating, or lying up after. Nothing tempts it until it is done.
  if (d.rest > 0) {
    d.rest -= dt;
    d.state = 'graze';
    d.prey = null;
    if (d.rest <= 0) d.rest = 0;
    return;
  }

  /* A full tiger does not hunt. It walks, it lies in the sun, and the herds
     graze a hundred metres away untroubled — which is what a predator that is
     not hungry actually looks like, and what makes the times it IS hungry read
     as something happening rather than as weather. */
  if (d.fed > h.hunts) {
    d.prey = null;
    d.chase = 0;
    d.timer -= dt;
    if (d.timer <= 0) {
      d.state = pickTarget(d, spec) ? 'walk' : 'graze';
      d.timer = 20 + luck() * 40;
    }
    return;
  }

  /* A target it already has, or a new one. Re-resolving every frame is what
     lets it switch to something closer, and what stops it charging a corpse. */
  if (d.prey) {
    /* Reaching the fire has to end a chase already under way. Skipping people
       in camp when it PICKS a target is not enough on its own: the pick only
       happens now and then, so a tiger that started after somebody followed
       them all the way in and took them standing at the hearth — which made
       running home, the one thing they do about tigers, worth nothing. */
    const gone = d.prey.kind === 'animal'
      ? d.prey.a.dead
      : !people.includes(d.prey.person)
        || inCamp(d.prey.person.x, d.prey.person.z, safeGround(d.prey.person.camp))
        /* Up a tree it cannot follow; hidden past a dozen metres it has lost
           them (HIDE_LOST, in danger.js). */
        || d.prey.person.climbed
        || (d.prey.person.hiding && Math.hypot(d.prey.person.x - d.x, d.prey.person.z - d.z) > 12);
    if (gone) { d.prey = null; d.chase = 0; }
  }

  // Blown, after a rush that came to nothing. It walks it off before trying again.
  d.sulk = Math.max(0, (d.sulk || 0) - dt);
  if (d.sulk > 0) {
    d.prey = null;
    d.timer -= dt;
    if (d.timer <= 0) {
      d.state = pickTarget(d, spec) ? 'walk' : 'graze';
      d.timer = 10 + luck() * 15;
    }
    return;
  }

  if (!d.prey || luck() < dt * 0.6) {
    const found = nearestQuarry(d, spec);
    if (found) {
      d.prey = found.kind === 'animal'
        ? { kind: 'animal', a: found.a, pack: found.pack }
        : { kind: 'person', person: people[found.index] };
    } else if (!d.prey) {
      d.prey = null;
    }
  }

  if (!d.prey) {
    // Nothing in sight: prowl. The roam radius is wide, so it covers ground.
    d.chase = 0;
    d.timer -= dt;
    if (d.timer <= 0) {
      d.state = pickTarget(d, spec) ? 'walk' : 'graze';
      d.timer = 12 + luck() * 20;
    }
    return;
  }

  const target = d.prey.kind === 'animal' ? d.prey.a : d.prey.person;
  d.targetX = target.x;
  d.targetZ = target.z;
  const dist = Math.hypot(target.x - d.x, target.z - d.z);

  // Lost it, or it got too far ahead: back to prowling.
  if (dist > h.sees * 1.3) { d.prey = null; d.chase = 0; d.state = 'walk'; d.timer = 6; return; }

  // Out of sprint. It stops, and whatever it was after keeps going.
  d.chase = (d.chase || 0) + dt;
  if (d.chase > h.chase) {
    /* Worth a line of its own. A near miss is the most interesting thing a
       tiger does now — it is the moment the running was worth doing — and it
       reads as one only if it says who got away. */
    if (d.prey.kind === 'person') {
      logEvent('predator', `${who(d.prey.person)} outran a tiger`, d.x, d.z);
    }
    d.prey = null;
    d.chase = 0;
    d.sulk = h.sulks;
    d.state = 'walk';
    d.timer = 8;
    return;
  }

  // Close enough, and it is over.
  if (dist < h.reach + (d.prey.kind === 'animal' ? target.scale : 0.6)) {
    takeQuarry(d, spec);
    return;
  }

  // Otherwise: run it down.
  d.state = 'flee';
  d.timer = 4;
}

export function takeQuarry(d, spec) {
  if (d.prey.kind === 'animal') {
    const a = d.prey.a, pack = d.prey.pack;
    a.dead = true;
    a.speed = 0;
    logEvent('predator', `a tiger took a ${pack.spec.key}`, d.x, d.z);
    recountAnimals();
  } else {
    const i = people.indexOf(d.prey.person);
    if (i >= 0) killPerson(i, 'tiger');
  }
  const wasPerson = d.prey.kind === 'person';
  d.prey = null;
  d.chase = 0;
  d.state = 'graze';
  // It eats where it stands. Nothing is hunted while it does.
  d.rest = spec.hunt.feeds;
  d.fed = Math.min(1, d.fed + (wasPerson ? spec.hunt.person : spec.hunt.meal));
  d.energy = Math.min(1, d.energy + 0.5);
}

export function updateHerdAnchors(dt) {
  for (const pack of packs) {
    for (const h of pack.herds) {
      h.timer -= dt;
      if (h.timer > 0) continue;
      h.timer = 45 + luck() * 75;
      for (let t = 0; t < 20; t++) {
        const a = luck() * Math.PI * 2, r = 15 + luck() * 45;
        const x = h.x + Math.cos(a) * r, z = h.z + Math.sin(a) * r;
        if (Math.hypot(x, z) > WORLD * 0.44) continue;
        if (sampleHeight(x, z) < SEA + 2) continue;
        if (flatnessAt(x, z) < 0.84) continue;
        h.x = x; h.z = z;
        break;
      }
    }
  }
}

export function updateQuadrupeds(dt) {
  /* Across every pack, not within one. Sized per pack, the threshold was never
     reached — the herds are four to forty-odd each and the number that matters
     is the two hundred of them on the map together. That mistake cost the whole
     saving: a year went from 84 seconds to 68 instead of to 10. */
  let onMap = 0;
  for (const pack of packs) onMap += pack.list.length;

  for (const pack of packs) {
    const { spec, parts, list, gait, model } = pack;
    const grazeMin = spec.graze[0], grazeSpan = spec.graze[1] - spec.graze[0];
    /* A predator is never dealt into a group: it covers thirty metres in one
       grouped step and would walk through the moment it was near enough to
       catch anything. There are one or two of them and grouping them saves
       nothing. */
    const stride = spec.predator ? 1 : herdStride(onMap);
    /* The time this one waited for its turn. Everything inside the loop is
       measured in this rather than in dt. */
    const slice = dt * stride;

    /* Straight to this step's group rather than walking past the others to find
       it. Testing every animal and skipping seven of eight still costs the walk
       — two hundred of them, a hundred and seventy thousand steps a year — and
       that walk was most of what the grouping had not already saved. */
    for (let i = turnStart(stride); i < list.length; i += stride) {
      const d = list[i];
      /* Hidden once, not every step for ever. A carcass was rewriting eight
         matrices sixty times a second to stay exactly as invisible as it
         already was, and over a simulated year that was most of what was left
         of the herd cost after the grouping. `hidden` is cleared when the
         animal comes back into its slot. */
      if (d.carcass && drawCarcass(d, i, spec, model, parts, slice)) continue;
      if (d.dead && d.hidden) continue;
      if (d.dead) {
        d.hidden = true;
        // Hunted. The instance stays in the mesh, parked at zero scale, so a
        // kill costs nothing and the animal can come back later in its place.
        if (model) { model.mesh.setMatrixAt(i, HIDDEN); continue; }
        parts.body.setMatrixAt(i, HIDDEN);
        if (parts.hump) parts.hump.setMatrixAt(i, HIDDEN);
        parts.neck.setMatrixAt(i, HIDDEN);
        parts.head.setMatrixAt(i, HIDDEN);
        parts.tail.setMatrixAt(i, HIDDEN);
        if (parts.horns) { parts.horns.setMatrixAt(i * 2, HIDDEN); parts.horns.setMatrixAt(i * 2 + 1, HIDDEN); }
        for (let k = 0; k < 4; k++) parts.legs.setMatrixAt(i * 4 + k, HIDDEN);
        continue;
      }

      /* A predator decides differently and then moves, turns, tires and is
         drawn by exactly the same code as everything else. That is why it maps
         onto the same three states rather than inventing its own: 'graze' is
         lying up or eating, 'walk' is prowling, 'flee' is the charge — which
         also means a tiger tires out of a sprint like everything else does. */
      if (spec.predator) {
        updatePredator(d, spec, slice);
      } else {
        /* Something big walked up: break off and run. Small animals spook from
           much further out than large ones, which is most of what makes a
           rabbit read as a rabbit and a bison as a bison. */
        let nearest = Infinity, awayX = 0, awayZ = 0;
        for (let t = 0; t < threats.length; t += 2) {
          const dx = d.x - threats[t], dz = d.z - threats[t + 1];
          const dd = dx * dx + dz * dz;
          if (dd < nearest) { nearest = dd; awayX = dx; awayZ = dz; }
        }
        if (nearest < (spec.fleeRadius * d.scale + 6) ** 2 && d.state !== 'flee') {
          d.state = 'flee';
          d.timer = 2.5 + luck() * 3;
          const a = Math.atan2(awayX, awayZ);
          d.targetX = d.x + Math.sin(a) * 70;
          d.targetZ = d.z + Math.cos(a) * 70;
        }

        d.timer -= slice;
        if (d.timer <= 0) {
          if (d.state === 'graze') {
            d.state = pickTarget(d, spec) ? 'walk' : 'graze';
            d.timer = d.state === 'walk' ? 30 : grazeMin + luck() * grazeSpan;
          } else {
            d.state = 'graze';
            d.timer = grazeMin + luck() * grazeSpan;
          }
        }
      }

      const tdx = d.targetX - d.x, tdz = d.targetZ - d.z;
      const distT = Math.hypot(tdx, tdz);
      if (!spec.predator && distT < 1.5 && d.state !== 'graze') {
        d.state = 'graze';
        d.timer = grazeMin + luck() * grazeSpan;
      }

      /* Nothing can run flat out for as long as it likes. A full deer outruns a
         hunter easily; a spent one does not, which is what turns a chase into
         something with an outcome rather than a fixed result. Grazing is where
         it comes back, so a herd harried all morning is a herd worth hunting. */
      let want = d.state === 'flee' ? spec.fleeSpeed : d.state === 'walk' ? spec.walkSpeed : 0;
      if (d.state === 'flee') want *= FLEE_SPENT + (1 - FLEE_SPENT) * d.energy;
      d.speed += (want - d.speed) * Math.min(1, slice * 2.5);

      /* A stomach empties on the calendar, not on the frame clock, so a tiger
         is as hungry after a fast-forwarded night as it would have been after a
         slow one. */
      if (spec.predator) {
        d.fed = Math.max(0, d.fed - (slice / P.dayLength) / spec.hunt.lasts);
      }

      // Grazing and walking are free; the sprint is what costs.
      const effort = spec.fleeSpeed > 0 ? d.speed / spec.fleeSpeed : 0;
      d.energy = clamp(d.energy
        + energyRate(effort, ANIMAL_STAMINA, RECOVERY_SECONDS) * slice, 0, 1);
      // Blown, and it stops running whatever is behind it. It has no choice.
      if (d.state === 'flee' && d.energy < 0.06) {
        d.state = 'graze';
        d.timer = grazeMin + luck() * grazeSpan;
        // A tiger that has run itself out has lost this one and knows it.
        /* A tiger that has run itself out has lost this one and knows it.
           This used to reach for spec.hunt.rest, which stopped existing when
           the stopwatch became a stomach — so a blown chase threw, and only a
           blown chase, which is rare enough to have gone unnoticed until a
           fast-forward ran a year of them in four seconds. */
        if (spec.predator) { d.prey = null; d.rest = spec.hunt.feeds * 0.4; }
      }

      if (distT > 0.01 && d.state !== 'graze') {
        let diff = Math.atan2(tdx, tdz) - d.yaw;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));   // shortest way round
        d.yaw += clamp(diff, -spec.turn * slice, spec.turn * slice);
      }

      const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw);
      const step = d.speed * slice;
      if (step > 0) {
        const nx = d.x + fx * step, nz = d.z + fz * step;
        // Nothing walks into the sea, off a cliff, or out of the world.
        if (sampleHeight(nx, nz) > SEA + 0.9 && flatnessAt(nx, nz) > 0.68
            && Math.hypot(nx, nz) < WORLD * 0.46) {
          d.x = nx; d.z = nz;
          // Phase advances with ground covered, not with time, so the legs
          // cannot skate while the body slides.
          d.phase += (step / (spec.stride * d.scale)) * Math.PI * 2;
        } else {
          d.speed = 0;
          if (!pickTarget(d, spec)) { d.state = 'graze'; d.timer = 3; }
        }
      }

      let wantNeck = spec.neck.rest;
      if (d.state === 'graze') {
        d.lookTimer -= slice;
        if (d.lookTimer <= 0) {
          d.grazeDown = !d.grazeDown;
          d.lookTimer = d.grazeDown ? 3 + luck() * 7 : 1.5 + luck() * 3;
        }
        wantNeck = d.grazeDown ? spec.neck.graze : spec.neck.rest * 0.7;
        /* Rooting about. Whatever it finds comes off the same trees the band is
           working, so a wood full of boar is a wood with less in it — which is
           the whole point of putting them here. */
        const eats = spec.eatsFruit;
        if (eats && d.grazeDown) {
          d.rootTimer -= slice;
          if (d.rootTimer <= 0) {
            d.rootTimer = eats.every[0] + luck() * (eats.every[1] - eats.every[0]);
            if (pickFruit(d.x, d.z, eats.reach, eats.takes) === 0) {
              // Nothing here. Go and find some, rather than standing in a field.
              const spot = nearestFruit(d.x, d.z, eats.seeks);
              if (spot) {
                d.targetX = spot.x; d.targetZ = spot.z;
                d.state = 'walk';
                d.timer = 30;
              }
            }
          }
        }
      } else if (d.state === 'flee') {
        wantNeck = spec.neck.rest * 0.5;
      }
      d.neck += (wantNeck - d.neck) * Math.min(1, slice * 2.4);

      /* ---- write the matrices ---- */

      const probe = 0.55 * Math.max(d.scale, 0.4);
      const hF = sampleHeight(d.x + fx * probe, d.z + fz * probe);
      const hB = sampleHeight(d.x - fx * probe, d.z - fz * probe);
      const hR = sampleHeight(d.x - fz * probe, d.z + fx * probe);
      const hL = sampleHeight(d.x + fz * probe, d.z - fx * probe);
      // Nose up when the ground climbs ahead; and because +X is the animal's
      // left, ground rising on its right has to push +X down — hence the minus.
      let pitch = -Math.atan2(hF - hB, probe * 2) * 0.85;
      const roll = -Math.atan2(hR - hL, probe * 2) * 0.85;

      const gaitF = Math.min(d.speed / Math.max(spec.walkSpeed, 0.01), 1);
      /* Everything above this line is the animal deciding; everything below it
         is the animal being drawn. With nobody watching, the second half is
         four thousand matrix compositions a step for nothing. */
      if (!drawingWorld) continue;

      let lift;
      if (spec.gait === 'hop') {
        // A hop is the whole animal leaving the ground, nose rising on the way
        // up — not a leg cycle with the body held level.
        lift = Math.abs(Math.sin(d.phase)) * spec.hop * gaitF;
        pitch += Math.cos(d.phase) * 0.30 * gaitF;
      } else {
        lift = Math.sin(d.phase * 2) * spec.bob * gaitF;
      }

      _eAnim.set(pitch, d.yaw, roll, 'YXZ');          // yaw outermost, aircraft order
      _qAnim.setFromEuler(_eAnim);

      if (model) {
        // The model stands on its own feet, and its gait runs off the same
        // phase the legs would have used — still driven by ground covered
        // rather than by the clock.
        _pAnim.set(d.x, sampleHeight(d.x, d.z) + model.footOffset * d.scale + lift, d.z);
        writeModelInstance(model, i, _pAnim, _qAnim, d.scale * model.scale, d.phase * 0.22);
        continue;
      }

      _pAnim.set(d.x, sampleHeight(d.x, d.z) + spec.legLen * d.scale + lift, d.z);
      _sAnim.setScalar(d.scale);
      _mAnim.compose(_pAnim, _qAnim, _sAnim);
      parts.body.setMatrixAt(i, _mAnim);
      if (parts.hump) parts.hump.setMatrixAt(i, _mAnim);

      _mLocal.makeRotationX(d.neck);
      _mLocal.setPosition(0, spec.neck.y, spec.neck.z);
      _mChain.multiplyMatrices(_mAnim, _mLocal);
      parts.neck.setMatrixAt(i, _mChain);

      _mOff.makeTranslation(0, spec.neck.len, 0.02);
      _mHead.multiplyMatrices(_mChain, _mOff);        // the head hangs off the neck
      parts.head.setMatrixAt(i, _mHead);

      if (parts.horns) {
        for (let side = -1; side <= 1; side += 2) {
          _mLocal.makeRotationZ(-side * spec.horns.tilt);
          _mLocal.setPosition(side * spec.horns.x, spec.horns.y, spec.horns.z);
          _mChain.multiplyMatrices(_mHead, _mLocal);
          parts.horns.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), _mChain);
        }
      }

      _mLocal.makeRotationY(Math.sin(d.phase * 1.7 + d.tailOff) * 0.4);
      _mLocal.setPosition(...spec.tailPos);
      _mChain.multiplyMatrices(_mAnim, _mLocal);
      parts.tail.setMatrixAt(i, _mChain);

      const swing = Math.min(d.speed * spec.swing, spec.gait === 'hop' ? 0.9 : 0.6);
      for (let k = 0; k < 4; k++) {
        _mLocal.makeRotationX(Math.sin(d.phase + gait[k]) * swing);
        _mLocal.setPosition(k % 2 === 0 ? spec.hipX : -spec.hipX, 0, k < 2 ? spec.hipZ : -spec.hipZ);
        _mChain.multiplyMatrices(_mAnim, _mLocal);
        parts.legs.setMatrixAt(i * 4 + k, _mChain);
      }
    }
    flushModelSet(model);
    for (const key in parts) parts[key].instanceMatrix.needsUpdate = true;
  }
}

export const FLOCK = { neighbour: 16, separation: 3.2, minSpeed: 5, maxSpeed: 13 };

export function updateBirds(dt, t) {
  for (let i = 0; i < birdList.length; i++) {
    const b = birdList[i];
    _acc.set(0, 0, 0);
    _centre.set(0, 0, 0);
    _align.set(0, 0, 0);
    _sep.set(0, 0, 0);
    let near = 0;

    for (let j = 0; j < birdList.length; j++) {
      if (j === i) continue;
      const o = birdList[j];
      _diff.subVectors(b.pos, o.pos);
      const dist = _diff.length();
      if (dist > FLOCK.neighbour) continue;
      _centre.add(o.pos);
      _align.add(o.vel);
      near++;
      if (dist < FLOCK.separation && dist > 0.001) {
        _sep.addScaledVector(_diff, (FLOCK.separation - dist) / (dist * FLOCK.separation));
      }
    }
    if (near > 0) {
      _centre.divideScalar(near).sub(b.pos);
      _acc.addScaledVector(_centre, 0.35);            // cohesion
      _align.divideScalar(near).sub(b.vel);
      _acc.addScaledVector(_align, 0.55);             // alignment
      _acc.addScaledVector(_sep, 9.0);                // separation, and it wins
    }

    // Hold a band of clear air above whatever is underneath right now, so the
    // flock climbs over a ridge instead of flying into it.
    const ground = sampleHeight(b.pos.x, b.pos.z);
    const floor = ground + 32, ceiling = ground + 100;
    // Asymmetric on purpose: the spring overshoots, and overshooting downward
    // means flying through a canopy, so climbing wins.
    if (b.pos.y < floor) _acc.y += (floor - b.pos.y) * 2.6;
    else if (b.pos.y > ceiling) _acc.y -= (b.pos.y - ceiling) * 1.0;

    const r = Math.hypot(b.pos.x, b.pos.z);
    if (r > 460) {                                     // turn back over the island
      _acc.x -= (b.pos.x / r) * (r - 460) * 0.06;
      _acc.z -= (b.pos.z / r) * (r - 460) * 0.06;
    }
    // A little wander, or a settled flock flies dead straight forever.
    _acc.x += Math.sin(t * 0.7 + i * 1.3) * 1.4;
    _acc.z += Math.cos(t * 0.53 + i * 2.1) * 1.4;

    b.vel.addScaledVector(_acc, dt);
    const speed = b.vel.length();
    if (speed > FLOCK.maxSpeed) b.vel.multiplyScalar(FLOCK.maxSpeed / speed);
    else if (speed < FLOCK.minSpeed) b.vel.multiplyScalar(FLOCK.minSpeed / Math.max(speed, 0.001));
    b.pos.addScaledVector(b.vel, dt);

    const v = b.vel;
    const flat = Math.hypot(v.x, v.z);
    const yaw = Math.atan2(v.x, v.z);
    let dYaw = yaw - b.yaw;
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    b.yaw = yaw;
    // Bank into the turn. Increasing yaw is a left turn, and +X is the left
    // wing, so a left turn needs a negative roll to drop that wing.
    const wantRoll = clamp(-dYaw / Math.max(dt, 0.001) * 0.22, -0.9, 0.9);
    b.roll += (wantRoll - b.roll) * Math.min(1, dt * 6);
    const pitch = -Math.atan2(v.y, Math.max(flat, 0.001));

    // Flap harder climbing, half-glide on the way down.
    const climbing = v.y > -1;
    b.flap += dt * (climbing ? 11 + Math.max(v.y, 0) * 1.5 : 3.5);

    const placed = birdSlot.get(i);
    if (placed && birdSets[placed.set]) {
      const set = birdSets[placed.set];
      _eAnim.set(pitch, b.yaw, b.roll, 'YXZ');
      _qAnim.setFromEuler(_eAnim);
      // A model beats its own wings; the flap counter becomes clip time.
      writeModelInstance(set, placed.slot, b.pos, _qAnim, b.scale * set.scale, b.flap * 0.16);
      continue;
    }
    writeFlyer(birdParts, i, b, pitch, b.roll, Math.sin(b.flap) * (climbing ? 0.85 : 0.28),
      0.045, 0.03, 0.02);
  }
  for (const set of birdSets) flushModelSet(set);
  if (birdParts) for (const key in birdParts) birdParts[key].instanceMatrix.needsUpdate = true;
}

export function updateButterflies(dt, t) {
  for (let i = 0; i < butterflyList.length; i++) {
    const b = butterflyList[i];
    _acc.set(0, 0, 0);

    // Drunken walk: a fresh shove every third of a second is what separates a
    // butterfly from a paper plane.
    b.jitter -= dt;
    if (b.jitter <= 0) {
      b.jitter = 0.18 + Math.random() * 0.35;
      _acc.x += (Math.random() - 0.5) * 26;
      _acc.z += (Math.random() - 0.5) * 26;
      _acc.y += (Math.random() - 0.4) * 14;
    }
    _acc.x += Math.sin(t * 2.3 + i * 4.1) * 2.2;
    _acc.z += Math.cos(t * 1.9 + i * 2.7) * 2.2;

    // Never far from its own patch of grass.
    const hx = b.home.x - b.pos.x, hz = b.home.y - b.pos.z;
    const fromHome = Math.hypot(hx, hz);
    if (fromHome > 9) {
      _acc.x += (hx / fromHome) * (fromHome - 9) * 0.9;
      _acc.z += (hz / fromHome) * (fromHome - 9) * 0.9;
    }

    const ground = sampleHeight(b.pos.x, b.pos.z);
    const floor = ground + 0.35, ceiling = ground + 3.0;
    if (b.pos.y < floor) _acc.y += (floor - b.pos.y) * 24;
    else if (b.pos.y > ceiling) _acc.y -= (b.pos.y - ceiling) * 14;

    b.vel.addScaledVector(_acc, dt);
    b.vel.multiplyScalar(1 - Math.min(dt * 2.2, 0.6));   // heavy drag, no gliding
    const speed = b.vel.length();
    if (speed > 2.6) b.vel.multiplyScalar(2.6 / speed);
    b.pos.addScaledVector(b.vel, dt);

    const flat = Math.hypot(b.vel.x, b.vel.z);
    if (flat > 0.05) b.yaw = Math.atan2(b.vel.x, b.vel.z);
    b.flap += dt * b.flapRate;
    // Wings sweep from nearly closed above the body to flat out, which is why
    // a butterfly flickers in and out of view as it crosses the light.
    writeFlyer(butterflyParts, i, b, Math.sin(t * 3 + i) * 0.25, 0,
      0.55 + Math.sin(b.flap) * 0.75, 0.012, 0.004, 0.0);
  }
  if (butterflyParts) {
    for (const key in butterflyParts) butterflyParts[key].instanceMatrix.needsUpdate = true;
  }
}

/* Body plus a mirrored pair of wings — the same shape for a bird and for a
   butterfly, only the numbers differ. */
export function writeFlyer(parts, i, b, pitch, roll, beat, shoulderX, shoulderY, shoulderZ) {
  if (!parts) return;
  _eAnim.set(pitch, b.yaw, roll, 'YXZ');
  _qAnim.setFromEuler(_eAnim);
  _sAnim.setScalar(b.scale);
  _mAnim.compose(b.pos, _qAnim, _sAnim);
  parts.body.setMatrixAt(i, _mAnim);

  _mLocal.makeRotationZ(beat);
  _mLocal.setPosition(shoulderX, shoulderY, shoulderZ);
  _mChain.multiplyMatrices(_mAnim, _mLocal);
  parts.wings.setMatrixAt(i * 2, _mChain);

  // The other wing is the same geometry spun round, which mirrors the flap
  // along with it — turning one shared beat into a symmetric pair.
  _mLocal.makeRotationZ(beat);
  _mOff.makeRotationY(Math.PI);
  _mLocal.premultiply(_mOff);
  _mLocal.setPosition(-shoulderX, shoulderY, shoulderZ);
  _mChain.multiplyMatrices(_mAnim, _mLocal);
  parts.wings.setMatrixAt(i * 2 + 1, _mChain);
}

/* Brought down by the person you are playing (spear.js): it lies where it
   fell, on its side and still, until it is picked up or its day is up — then
   it is hidden like any other kill. A moment after the throw it goes over, so
   the spear is seen to land before it falls. */
function drawCarcass(d, i, spec, model, parts, slice) {
  const c = d.carcass;
  if (simDay > c.until) { d.carcass = null; return false; }
  c.fall = Math.min(1, c.fall + slice * 2.5);
  d.speed = 0;
  if (!drawingWorld) return true;
  const f = Math.max(0, c.fall);
  const ground = sampleHeight(d.x, d.z);
  _eAnim.set(0, d.yaw, f * Math.PI / 2, 'YXZ');
  _qAnim.setFromEuler(_eAnim);
  if (model) {
    _pAnim.set(d.x, ground + model.footOffset * d.scale * (1 - f) + 0.3 * d.scale * f, d.z);
    writeModelInstance(model, i, _pAnim, _qAnim, d.scale * model.scale, 0);
    return true;
  }
  _pAnim.set(d.x, ground + spec.legLen * d.scale * (1 - 0.7 * f), d.z);
  _sAnim.setScalar(d.scale);
  _mAnim.compose(_pAnim, _qAnim, _sAnim);
  parts.body.setMatrixAt(i, _mAnim);
  if (parts.hump) parts.hump.setMatrixAt(i, _mAnim);
  _mLocal.makeRotationX(spec.neck.rest * (1 - f) + 0.9 * f);
  _mLocal.setPosition(0, spec.neck.y, spec.neck.z);
  _mChain.multiplyMatrices(_mAnim, _mLocal);
  parts.neck.setMatrixAt(i, _mChain);
  _mOff.makeTranslation(0, spec.neck.len, 0.02);
  _mHead.multiplyMatrices(_mChain, _mOff);
  parts.head.setMatrixAt(i, _mHead);
  if (parts.horns) {
    for (let side = -1; side <= 1; side += 2) {
      _mLocal.makeRotationZ(-side * spec.horns.tilt);
      _mLocal.setPosition(side * spec.horns.x, spec.horns.y, spec.horns.z);
      _mChain.multiplyMatrices(_mHead, _mLocal);
      parts.horns.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), _mChain);
    }
  }
  _mLocal.makeRotationY(0);
  _mLocal.setPosition(...spec.tailPos);
  _mChain.multiplyMatrices(_mAnim, _mLocal);
  parts.tail.setMatrixAt(i, _mChain);
  for (let k = 0; k < 4; k++) {
    _mLocal.makeRotationX(k < 2 ? 0.35 * f : -0.35 * f);
    _mLocal.setPosition(k % 2 === 0 ? spec.hipX : -spec.hipX, 0, k < 2 ? spec.hipZ : -spec.hipZ);
    _mChain.multiplyMatrices(_mAnim, _mLocal);
    parts.legs.setMatrixAt(i * 4 + k, _mChain);
  }
  return true;
}

/* What a grazing animal is afraid of: you, and anyone out hunting. Flat pairs
   of x,z because this is read once per animal per frame. */
export const threats = [];
export function collectThreats() {
  threats.length = 0;
  let led = null;
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (p.led) led = p;
    if (p.job === 'hunt' && !p.asleep) threats.push(p.x, p.z);
  }
  /* You: the camera — or, when you are walking somebody yourself, that person,
     and not at all while they are down low (Z). A crawl is how to get within a
     throw; the throw itself is a hunt, and scatters the rest. */
  if (!led) threats.push(camera.position.x, camera.position.z);
  else if (!led.hiding) threats.push(led.x, led.z);
  // A tiger frightens the herds whether or not it is hunting them, which is
  // what makes one moving across the map visible in how everything else moves.
  for (const pack of packs) {
    if (!pack.spec.predator) continue;
    for (const a of pack.list) if (!a.dead) threats.push(a.x, a.z);
  }
}

export function updateAnimals(dt, t) {
  collectThreats();
  updateHerdAnchors(dt);
  updateQuadrupeds(dt);
  /* Birds and butterflies are scenery. Nothing in the simulation reads them —
     nobody hunts them, they eat nothing and they never die — so with nobody
     watching they do not need to fly. Measured: between them they cost more
     than every herd, boar and tiger on the map put together, which is not
     something anyone would have guessed. */
  if (!drawingWorld) return;
  updateBirds(dt, t);
  updateButterflies(dt, t);
}

/* -------------------------------------------------------------------------
   A band, and its camp

   Generic prehistoric hunter-gatherers: low-poly figures in the same idiom as
   everything else in the scene, with varied builds and skin tones and no
   markers belonging to any real culture. Adults and children, and a day that
   runs on the same clock as the sky — out foraging in the morning, back at the
   fire by dusk, asleep in the huts at night.

   A person is a biped, so it needs a rig the quadruped spec cannot express:
   the torso pivots at the waist and carries the head and arms with it, which is
   what makes bending to forage and hunching over a task read as work rather
   than as a wobble. Legs hang off the hips as before.
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   Names

   An invented sound, not a borrowed one. These are built from a small set of
   syllables that belong to no real language, because putting a living people's
   words on a procedurally generated band would be a worse kind of wrong than
   having no names at all.

   Each tribe draws a handful of openings from the pool and keeps them, so its
   own people rhyme a little with each other and not with the next valley's —
   which is most of what makes a set of invented names feel like a language
   rather than a random-syllable machine.
   ------------------------------------------------------------------------- */

export const NAME_ONSET = ['k', 't', 'm', 'n', 's', 'r', 'v', 'h', 'y', 'w', 'l', 'p',
                    'th', 'sh', 'br', 'dr', 'gr', 'kh', 'ts', 'nd'];
export const NAME_VOWEL = ['a', 'e', 'i', 'o', 'u', 'a', 'i', 'o', 'a', 'e', 'ae', 'ia', 'ou', 'ei'];
export const NAME_CODA = ['', '', '', '', 'n', 'r', 'sh', 'k', 'l', 'm', 'th', 'ss'];

export const pick = (list, rng) => list[(rng() * list.length) | 0];

export function buildName(rng, syllables, onsets) {
  let out = '';
  for (let i = 0; i < syllables; i++) {
    out += pick(onsets, rng) + pick(NAME_VOWEL, rng);
    if (i === syllables - 1) out += pick(NAME_CODA, rng);
  }
  return out[0].toUpperCase() + out.slice(1);
}

/** Distinct within a run, so two people are never confused in the chronicle. */
/* Distinct for the life of the page, so a parent can be pointed at after they
   are gone and never confused with somebody born into their slot later. */
export let nextPersonId = 1;

/* -------------------------------------------------------------------------
   The line

   Every person who has ever lived, kept after they die. `people` holds the
   living and a death splices them out of it, so before this a genealogy was
   exactly one generation deep: a person remembered their parents' names, and
   the moment a parent died so did any way of finding out who THEIR father was.
   Nothing reached back to the founders.

   Descent is reckoned through the father. Two numbers are carried on each
   person rather than walked for: `line`, the name of the founder the male chain
   ends at, and `gen`, how many fathers deep they are. Both come from the
   father in one step at birth, so a hundred generations costs the same as one.
   ------------------------------------------------------------------------- */

export const LINE_MAX = 20000;
export let lineage = [];

/** Short keys: this is written to the save every ten seconds. */
export function recordPerson(p) {
  lineage.push({
    i: p.id, n: p.name, s: p.sex, f: p.father || 0, m: p.mother || 0,
    fn: p.fatherName || '', mn: p.motherName || '',
    b: Math.round(p.born * 100) / 100, d: 0, c: p.camp.code, g: p.gen, l: p.line,
  });
  /* Dropping the oldest is dropping the founders, which is the one thing this
     exists to keep — so the cap is set where a world would have to run for
     several thousand years to reach it, and is a backstop rather than a policy. */
  if (lineage.length > LINE_MAX) lineage.splice(0, lineage.length - LINE_MAX);
}

/** The record of somebody, living or long dead. */
export function lineOf(id) {
  for (let i = lineage.length - 1; i >= 0; i--) if (lineage[i].i === id) return lineage[i];
  return null;
}

/* What of, and whose they were at the time. `c` is the camp somebody was born
   in and never changes; a band that took them in and buried them needs to be
   able to say so, and a band they walked out of needs to not claim them. */
export function recordDeath(p, cause) {
  const rec = lineOf(p.id);
  if (!rec) return;
  rec.d = Math.round(simDay * 100) / 100;
  rec.x = cause || 'age';
  rec.dc = p.camp ? p.camp.code : rec.c;
}

/** Somebody walked from one band to another, and both should remember it. */
export function recordMove(p, from, to) {
  const rec = lineOf(p.id);
  if (!rec) return;
  /* Named `fr`/`to` rather than anything with "mv" in it: the saved shape for a
     LIVING person already has an `mv` flag meaning "has moved once", and two
     fields a letter apart meaning different things in two record types is how
     an afternoon disappears. */
  rec.fr = from ? from.code : '';
  rec.to = to ? to.code : '';
  rec.md = Math.round(simDay * 100) / 100;
}

/** Fathers, back as far as anything is remembered. */
export function ancestry(p, limit = 12) {
  const out = [];
  let at = p.father, guard = 0;
  while (at && guard++ < limit) {
    const rec = lineOf(at);
    if (!rec) break;
    out.push(rec);
    at = rec.f;
  }
  return out;
}

export const usedNames = new Set();
/* And the two characters each of those names is shortened to. Kept beside the
   names because they are derived from them and have to be unique for the same
   reason: the chronicle says whose line a line is with one of these. */
export const usedCodes = new Set();

export function uniqueName(rng, syllables, onsets) {
  for (let t = 0; t < 40; t++) {
    const name = buildName(rng, syllables, onsets);
    if (name.length > 2 && !usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
  // Forty collisions means the pool is exhausted; number it rather than loop.
  const name = buildName(rng, syllables, onsets) + (usedNames.size % 100);
  usedNames.add(name);
  return name;
}

/** The openings a tribe favours — its accent, in effect. */
export function tribeVoice(rng) {
  const voice = [];
  while (voice.length < 6) {
    const o = pick(NAME_ONSET, rng);
    if (!voice.includes(o)) voice.push(o);
  }
  return voice;
}

/* The day length everything was tuned at, and what it means to run at another.
   The clamp on the step is what keeps a sixty-second day from integrating
   movement in strides longer than the person taking them: at 60fps a twelve-fold
   pace is a 0.2s step, so this only bites on a frame that already stuttered. */
/* Energy is only spent above a pace that can be held all day. Getting this
   wrong is easy and quiet: cost anything for walking and a person walking about
   their own camp for an hour-long day sits at zero from mid-morning, nobody is
   ever rested enough to hunt, and the band starves without anything obviously
   being broken. So SUSTAIN is the fraction of a flat-out run that costs
   nothing — a person's walk is 0.375 of their jog and sits under it — and the
   cost above that is quadratic, which is what makes a sprint expensive and a
   jog merely tiring.

   Animals spend far faster than people because they run far harder: a deer's
   flight is a real sprint, and a herd worked over a morning should be worth
   hunting by noon. */
/* How hungry a camp has to be before it starts costing its people, and how fast
   the lid comes down once it does — a full share of a sim-day at total hunger.
   Coming back up is quicker than going down, because a band that finds food
   should be back on its feet within the day rather than the week. */
/* Hunger is 1 - daysOfFood/comfortable, so 0.55 meant the ceiling started
   coming down with two and a half days of food still in the store — a thin
   larder, not a famine. At 0.82 it is a bit over a day, which is running out. */
export const STARVE_FROM = 0.82;
/* Two sim-days from a full tank to nothing is not starving, it is a switch. A
   person who has not eaten for two days is hungry; the ones who die of it have
   been going without for weeks, and the difference matters here because a band
   that hits one bad week should come out of it thinner rather than smaller.

   At 0.16 an empty store takes six days to kill somebody outright — long enough
   for a season to turn, for a hunt to come in, or for the neighbours to send
   something over, all of which are things that actually happen. Bands that go
   under now go under because the island had nothing, which is the only reason
   worth watching. */
export const STARVE_DRAIN = 0.16;      // lid lost per sim-day at total hunger
export const REFEED = 1.4;             // lid regained per sim-day with food in

export const SUSTAIN = 0.42;           // the pace that costs nothing to hold
export const PERSON_STAMINA = 60;      // seconds of flat-out work, from full
export const ANIMAL_STAMINA = 14;      // a sprint is a sprint
export const SLEEP_SECONDS = 22;       // a night is worth a great deal more than a sit
export const RECOVERY_SECONDS = 70;    // standing still, awake
export const FLEE_SPENT = 0.42;        // what is left of a flat-out run when spent

/* Positive when the effort is costing, negative when it is paying back, so one
   expression covers both and the two can never disagree about where the line
   is. `stamina` is what a flat-out effort costs; `recover` how fast rest pays. */
export function energyRate(effort, stamina, recover) {
  const over = effort - SUSTAIN;
  return over > 0 ? -(over * over) / stamina : (SUSTAIN - effort) / recover;
}

/* nextPersonId lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setNextPersonId(v) { nextPersonId = v; }

/* Handing one out is a read and a write at once, which `nextPersonId++` did in
   one place and an imported binding cannot do at all. */
export function takePersonId() { return nextPersonId++; }

/* lineage lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setLineage(v) { lineage = v; }
