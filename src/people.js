import * as THREE from 'three';

import { CAMP_CEILING, MAP_SCALE, P, PEOPLE_CEILING, QUALITY, SEA, SNOW } from './params.js';
import { clamp, flatnessAt, mulberry32, sampleHeight } from './noise.js';
import { faunaMaterial, rockMaterial } from './scene.js';
import { HIDDEN, _c, _e, _m4, _q, _s, _v, stats, world } from './world.js';
import { recordPerson, setLineage, tribeVoice, uniqueName, usedCodes, usedNames } from './wildlife.js';
import { PERSON, PERSON_PARTS, partsPer } from './clock.js';
import {
  FOOD, LIFE, chiefOf, emptySkills, hidePeopleFrom, nearestShore, newPerson, peopleCapacity, personAge, setPeopleCapacity, simDay
} from './life.js';
import { codeColor, takeTribeCode } from './ui.js';

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
      const flat = flatnessAt(x, z);
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

/* Metres of trampled ground around a camp — no grass, no trees, and the
   distance the rest of the simulation means by "at the fire". Grown with the
   camp: hearths sit 13 m out and their tents 6 to 9 m beyond that, so at 17 the
   far tents of a village stood in long grass outside their own camp. */
export const CAMP_CLEARING = 26;

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
  graveMesh = new THREE.InstancedMesh(geo, rockMaterial,
    GRAVE_MAX * GRAVE_STONES + campCapacity * MONUMENT_MAX);
  graveMesh.castShadow = true;
  graveMesh.receiveShadow = true;
  graveMesh.frustumCulled = false;
  for (let i = 0; i < graveMesh.count; i++) graveMesh.setMatrixAt(i, HIDDEN);
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
  /* And what each band has raised, standing behind its own graves. How many of
     the planned stones are up follows their `art`, so a monument goes up over
     years — and it comes back down if a band forgets what it was for, which is
     the only way any of this is ever lost. */
  let at = GRAVE_MAX * GRAVE_STONES;
  for (const camp of camps) {
    const plan = camp.gone ? [] : monumentPlan(camp);
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
  /* Carried back rather than left. Somebody who dies out on the hill is buried
     with the rest of their band — which is the whole difference between a
     grave and a place where somebody died.

     Laid in rows off the ground's own line, so a burial ground of thirty reads
     as arranged rather than as thirty accidents in the same field. The row grows
     outward with the count, so the oldest stones are at the middle: a band's
     history has a shape you can walk along. */
  const ground = p.camp?.barrow;
  let x = p.x, z = p.z;
  if (ground) {
    const n = (p.camp.buried = (p.camp.buried || 0) + 1) - 1;
    const row = Math.floor(n / 5), seat = (n % 5) - 2;
    const ax = Math.cos(ground.a), az = Math.sin(ground.a);
    x = ground.x + (-az * seat * 1.6) + ax * row * 1.5;
    z = ground.z + (ax * seat * 1.6) + az * row * 1.5;
  }
  graves.push({
    x: Math.round(x * 100) / 100,
    z: Math.round(z * 100) / 100,
    y: sampleHeight(x, z),
    day: Math.floor(simDay),
    sex: p.sex,
  });
  if (graves.length > GRAVE_MAX) graves.splice(0, graves.length - GRAVE_MAX);
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
export const CAMP_PIECES = {
  huts: HEARTHS * HUTS_PER_HEARTH,
  // Nine stones and four logs *per hearth*: a fire nobody can sit at is a
  // bonfire, not a hearth.
  stones: 9 * HEARTHS,
  logs: 4 * HEARTHS,
  poles: 3,
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
  families.forEach((f, i) => {
    const at = Math.min(i, camp.huts.length - 1);
    const hut = camp.huts[at];
    /* And the fire that tent stands round. Without this a village was five
       hearths and one crowd: everything that means "go home" — the night
       coming on, an errand ending, a job by the fire — aimed at `camp.x`, which
       is hearth nought, so sixty people walked past four burning fires to stand
       at the first one. The hearths were furniture.

       It comes off the tent rather than off the person, so a household sits at
       one fire: the same rule that put their tents beside each other. */
    const fire = camp.fireAt?.[Math.floor(at / HUTS_PER_HEARTH)];
    for (const p of [...f.adults, ...f.kids]) { p.hut = hut; p.hearth = fire; }
  });
}

/** The fire somebody lives at, rather than the middle of the village. */
export function homeFire(p) {
  return p.hearth || p.camp;
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
  return best;
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

  /* And a fire for every ring of tents that has anybody in it. A hearth with
     no tents round it is a fire nobody is sitting at, which reads as a camp
     twice the size of the band living in it — the thing lighting them all
     unconditionally would do. */
  camp.hearths = here === 0 ? 0 : hearthsFor(want);
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

  camp.barrow = null;
  for (let t = 0; t < 60 && !camp.barrow; t++) {
    const a = rng() * Math.PI * 2;
    const r = CAMP_CLEARING + 6 + rng() * 12;
    const x = camp.x + Math.cos(a) * r, z = camp.z + Math.sin(a) * r;
    if (sampleHeight(x, z) < SEA + 1.5) continue;
    if (flatnessAt(x, z) < 0.88) continue;
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
    const a = (seat / HUTS_PER_HEARTH) * Math.PI * 2 + rng() * 0.5;
    const r = 6.5 + rng() * 2.6;
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
    campParts.huts.setColorAt(slot, _c.setHex(0x6d5740 + ((rng() * 0x101010) | 0)));
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
  campParts.stones = instancedFrom(stoneGeo, campCapacity * CAMP_PIECES.stones, tribeGroup);
  campParts.logs = instancedFrom(logGeo, campCapacity * CAMP_PIECES.logs, tribeGroup);
  campParts.poles = instancedFrom(poleGeo, campCapacity * CAMP_PIECES.poles, tribeGroup);
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
  if (!camp) {
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
  setPeopleCapacity(Math.max(count, PEOPLE_CEILING));
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
  /* Eyes are the whole of a face at this size. A mouth is a line and a brow is
     a shadow; the eyes are what make a head look at you. */
  const eye = new THREE.SphereGeometry(S.head[0] * 0.085, 6, 5);
  const brow = roundBox(S.head[0] * 0.30, S.head[1] * 0.035, S.head[2] * 0.06);
  const mouth = roundBox(S.head[0] * 0.28, S.head[1] * 0.028, S.head[2] * 0.05);
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
    eyeL: mk(eye, 0x241c16), eyeR: mk(eye, 0x241c16),
    browL: mk(brow, 0x3a2c22), browR: mk(brow, 0x3a2c22),
    mouth: mk(mouth, 0x4a3128),
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
