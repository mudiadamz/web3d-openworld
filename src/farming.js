import * as THREE from 'three';

import { P, SEA, SNOW } from './params.js';
import { fbm, flatnessAt, sampleHeight, clearOfCreeks, inWater } from './noise.js';
import { faunaMaterial, forageSeason, streamMaterial } from './scene.js';
import { HIDDEN } from './world.js';
import { lakeRadius, lakes, streams } from './creeks.js';
import { luck } from './clock.js';
import { CAMP_CLEARING, CAMP_PIECES, camps, dressCamp, joinGeometries, people, tribeGroup } from './people.js';
import { practise } from './skills.js';
import { BAG, bagAdd } from './bag.js';
import { logEvent } from './life.js';

/* -------------------------------------------------------------------------
   Fields, ditches and flocks

   Everything else a band eats it finds: berries on the hillside, fruit on the
   tree, a deer, a fish. This is the first food anybody on the island makes.

   It starts with the ground. Not every place will take a field: it wants
   flat, fertile ground with water close by and higher up — a creek falling
   past just above it, a lake or a spring's pool — so that a short ditch will
   carry the water down to it. That ground is found once for the island
   (surveyFarmland), and any band takes the best of it it can walk to, near
   its tents or not, that no other band has taken first (fieldOf). A band with
   no farmland within reach cannot farm.

   Then the ditch, dug from the water end a stretch every session until the
   water runs in it. That is what teaches `irrigation`, and nothing is sown
   until the ditch is dug and the band is a fair hand at it.

   Then `farming`, and a crop; past a fair hand at that a pair of animals off
   the hill, which grow into a flock. And the field has no size but the one the
   band needs: so many square metres a mouth, worked as well as the band knows
   how, growing round the tents, the water and its neighbours' fields as it
   spreads. A band that has taken to farming leans its day toward its field and
   away from the hillside and the hunt (farmWeight, and jobMix in society.js).

   Nothing here runs while a module is loading: `people.js` imports this back,
   so every count it needs is read off CAMP_PIECES inside a function.
   ------------------------------------------------------------------------- */
export const FARM = {
  irrigateFirst: 0.5,  // irrigation a band needs before anything is sown
  perDitch: 0.03,      // irrigation learned by a session of digging and carrying water
  perField: 0.026,     // farming learned by a session in the field
  crop: 0.9,           // food a session brings home at mastery
  siteReach: 450,      // metres a band will walk to its field: one day's walk out, well inside a trip's patience
  walk: 300,           // metres of walk that halve what a piece of farmland is worth to a band
  fallow: 12,          // metres of fallow kept between one band's field and the next thing
  dig: 6,              // metres of ditch a session digs, before the band is any good at it
  chance: 0.32,        // how often somebody goes to the field, before hunger
  lean: 2.2,           // how much more a band goes to its field at mastery
  stockFrom: 0.5,      // farming at which a band pens its first animals
  stockMax: 12,        // head a band at mastery keeps; the pen has room for this many
  stockGrow: 0.08,     // share a flock grows by in a sim-day, while there is room
  milk: 0.2,           // food one head gives the store in a sim-day
};

/* The field's shape: as square as the ground lets it be, as big as the band
   needs. No largest — a city of two hundred works a field of two hundred. */
export const FIELD = {
  spacing: 1.6,        // metres between rows
  minLen: 9.5,         // a stretch of ridge: the length of the ridge geometry
  perHead: 30,         // square metres of field a mouth needs, worked at mastery
  step: 1.4,           // metres between plants along a row
};

/* The ditch: dug in steps of this, through a rise no taller than this. */
export const DITCH = { step: 3, rise: 1.5, width: 1.1, water: 0.55 };

/* Looking for farmland: a place every so many metres along a creek, a few
   distances back from the water either side, and water no further than this
   to dig from. */
const SURVEY = { every: 30, back: [14, 26, 40], most: 160, tries: 6 };

/** How good the ground is to grow in. The flowery ground is the fertile ground
    — the same noise that decides where there is foraging, without the season
    or what has been picked off it — best low down, poorer toward the snow. */
export function soilAt(x, z) {
  const rich = Math.max(0, Math.min(1, 0.55 + fbm(x * 0.010, z * 0.010, 2, P.seed + 707)));
  const up = Math.max(0, Math.min(1, (sampleHeight(x, z) - SEA) / (SNOW - SEA)));
  return rich * (1 - 0.6 * up);
}

/* Water at `level` at (sx, sz) will run to ground at (x, z), `ground` high:
   it is higher than the field, and nothing on the way rises taller than a
   ditch can be cut through. */
function runsTo(sx, sz, level, x, z, ground) {
  if (level < ground + 0.3) return false;             // water runs down to a field, never up
  const len = Math.hypot(x - sx, z - sz);
  for (let d = DITCH.step; d < len; d += DITCH.step) {
    const t = d / len;
    if (sampleHeight(sx + (x - sx) * t, sz + (z - sz) * t) > level + DITCH.rise) return false;
  }
  return true;
}

/* The nearest lake shore or spring's pool that a ditch could bring water down
   from to (x, z). */
function fromLake(x, z, ground) {
  let best = null, near = SURVEY.most;
  for (const l of lakes) {
    const a = Math.atan2(z - l.z, x - l.x), r = lakeRadius(l, a);
    const sx = l.x + Math.cos(a) * r, sz = l.z + Math.sin(a) * r;
    const d = Math.hypot(x - sx, z - sz);
    if (d < near && runsTo(sx, sz, l.level, x, z, ground)) { near = d; best = { x: sx, z: sz }; }
  }
  return best;
}

let farmland = [], farmlandOf = '';

/** Every piece of farmland on the island, found once for the world the creeks
    were traced on: ground back from a creek or a lake, flat, dry, below the
    snow, with water higher up close enough to dig a ditch from. Each worth what
    its soil is, and more the shorter that ditch — the strategic ground is the
    fertile bank a creek falls past just above. */
export function surveyFarmland() {
  const key = streams.length + ':' + lakes.length + ':' + (streams[0]?.[0]?.x ?? 0) + ':' + (lakes[0]?.x ?? 0);
  if (key === farmlandOf) return farmland;
  farmlandOf = key;
  farmland = [];
  const consider = (x, z, a, upstream) => {
    const y = sampleHeight(x, z);
    if (y < SEA + 1.5 || y > SNOW - 25) return;
    const flat = flatnessAt(x, z);
    if (flat < 0.8 || inWater(x, z) || !clearOfCreeks(x, z, 12)) return;
    const up = upstream ? upstream(x, z, y) : null, lake = fromLake(x, z, y);
    const src = up && (!lake || Math.hypot(up.x - x, up.z - z) <= Math.hypot(lake.x - x, lake.z - z)) ? up : lake;
    if (!src) return;
    const length = Math.hypot(x - src.x, z - src.z), soil = soilAt(x, z);
    const worth = soil * (0.4 + 0.6 / (1 + length / 40)) * (0.5 + 0.5 * flat);
    farmland.push({ x, z, y, a, src, length, soil, worth });
  };
  for (const path of streams) {
    let run = SURVEY.every;
    for (let i = 1; i < path.length - 1; i++) {
      run += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
      if (run < SURVEY.every) continue;
      run = 0;
      /* The water for a field here comes from further up this creek: walked
         back toward its source to the first point high enough to run down. */
      const upstream = (x, z, ground) => {
        let tries = 0;
        for (let j = i; j >= 0 && tries < SURVEY.tries; j--) {
          const q = path[j];
          if (Math.hypot(q.x - x, q.z - z) > SURVEY.most) break;
          if (q.level < ground + 0.3) continue;
          tries++;
          if (runsTo(q.x, q.z, q.level, x, z, ground)) return { x: q.x, z: q.z };
        }
        return null;
      };
      const tx = path[i + 1].x - path[i - 1].x, tz = path[i + 1].z - path[i - 1].z, tl = Math.hypot(tx, tz) || 1;
      for (const side of [-1, 1]) {
        const nx = (-tz / tl) * side, nz = (tx / tl) * side;
        for (const back of SURVEY.back) consider(path[i].x + nx * back, path[i].z + nz * back, Math.atan2(nz, nx), upstream);
      }
    }
  }
  for (const l of lakes) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, r = lakeRadius(l, a);
      for (const back of SURVEY.back) consider(l.x + Math.cos(a) * (r + back), l.z + Math.sin(a) * (r + back), a, null);
    }
  }
  return farmland;
}

/** The best farmland for a band: worth more the better its soil and the
    shorter its ditch, and less the further it is to walk — so a band walks
    past poor ground at home to good ground further off, but not across the
    island. Nothing inside `taken`: another band's field or its tents. */
export function chooseSite(camp, sites, taken) {
  let best = null, top = 0;
  for (const s of sites) {
    const d = Math.hypot(s.x - camp.x, s.z - camp.z);
    if (d > FARM.siteReach) continue;
    if (taken.some((t) => Math.hypot(t.x - s.x, t.z - s.z) < t.r)) continue;
    const score = s.worth / (1 + d / FARM.walk);
    if (score > top) { top = score; best = s; }
  }
  return best;
}

/** A band's field: the farmland it has taken, kept while it can still walk to
    it — or, restored from a save, the one it had. Null for a band with no
    farmland within reach: it cannot farm. */
export function fieldOf(camp) {
  const here = camp.x + ',' + camp.z;
  if (camp.fieldAt === here) return camp.field;
  camp.fieldAt = here;
  const sites = surveyFarmland(), was = camp.field;
  let pick = null;
  if (camp.fieldPin) {
    const pin = camp.fieldPin;
    camp.fieldPin = null;
    pick = sites.find((s) => Math.abs(s.x - pin.x) < 1 && Math.abs(s.z - pin.z) < 1) || null;
    if (!pick) camp.ditchDug = 0;                    // not this island's ground: start again
  }
  if (!pick && was && sites.includes(was) && Math.hypot(was.x - camp.x, was.z - camp.z) <= FARM.siteReach) pick = was;
  if (!pick) {
    const taken = [{ x: camp.x, z: camp.z, r: CAMP_CLEARING + 8 }];
    for (const c of camps) {
      if (c === camp || c.gone) continue;
      taken.push({ x: c.x, z: c.z, r: CAMP_CLEARING + FARM.fallow });
      if (c.field) taken.push({ x: c.field.x, z: c.field.z, r: fieldReach(c) + FARM.fallow });
    }
    pick = chooseSite(camp, sites, taken);
    if (was && pick !== was) camp.ditchDug = 0;      // a new field wants a new ditch
  }
  camp.ditch = null;
  return (camp.field = pick);
}

/** The line the ditch takes: from the field's water, down to the field. */
export function ditchOf(camp) {
  const f = fieldOf(camp);
  if (!f) return null;
  if (camp.ditch && camp.ditch.of === f) return camp.ditch;
  const n = Math.max(2, Math.ceil(f.length / DITCH.step) + 1), path = [];
  for (let i = 0; i < n; i++) path.push({ x: f.src.x + (f.x - f.src.x) * (i / (n - 1)), z: f.src.z + (f.z - f.src.z) * (i / (n - 1)) });
  return (camp.ditch = { of: f, path, length: f.length });
}

/** The ditch is dug, and the water runs in it. */
export function ditchDone(camp) {
  const d = ditchOf(camp);
  return Boolean(d?.path) && (camp.ditchDug || 0) >= d.length;
}

/* How much somebody wants to go to the field. Nothing without farmland to
   take. Learning it is a thing a fed band has time for; once the field pays, a
   hungry band goes to it — and a band that has taken to farming goes to it far
   more, the way a village does and a band of hunters does not. */
export function farmWeight(p, hunger, rested) {
  if (p.child) return 0;
  if (!ditchOf(p.camp)?.path) return 0;
  const skill = p.camp.skill.farming || 0;
  const pull = skill < 0.1 ? 1 - hunger : 0.5 + 0.9 * hunger * skill;
  return FARM.chance * pull * rested * (1 + FARM.lean * skill);
}

/* How big a band's field is now: so many square metres a mouth, as much of it
   as the band knows how to work — and nothing until it has dug. No largest. */
export function fieldSize(camp) {
  const irrigation = camp.skill?.irrigation || 0, farming = camp.skill?.farming || 0;
  if (irrigation < 0.1) return { rows: 0, len: 0, perRow: 0, grown: 0 };
  const area = FIELD.perHead * Math.max(6, camp.pop || 0) * Math.max(0.15, farming, irrigation * 0.25);
  const side = Math.sqrt(area);
  const rows = Math.max(2, Math.round(side / FIELD.spacing));
  const len = Math.max(FIELD.minLen, side);
  const perRow = Math.max(1, Math.floor(len / FIELD.step));
  return { rows, len, perRow, grown: Math.min(1, farming * 1.25) };
}

/** How far out from its middle the field reaches now: what a village keeps its
    tents off (settlement.js), and another band its own field. */
export function fieldReach(camp) {
  const s = fieldSize(camp);
  return Math.hypot(s.len / 2, (s.rows * FIELD.spacing) / 2) + 4;
}

/** Where a session goes: the working end of the ditch while it is still being
    dug, and somewhere along the rows once the water runs. */
export function farmSite(p) {
  const camp = p.camp, f = fieldOf(camp), d = ditchOf(camp);
  if (!f || !d?.path) return false;
  if ((camp.ditchDug || 0) < d.length) {
    const q = d.path[Math.min(d.path.length - 1, Math.floor((camp.ditchDug || 0) / DITCH.step))];
    p.targetX = q.x + (luck() - 0.5) * 2;
    p.targetZ = q.z + (luck() - 0.5) * 2;
    return true;
  }
  const size = fieldSize(camp);
  const along = (luck() - 0.5) * Math.max(size.len, 9);
  const across = (luck() - 0.5) * Math.max(size.rows, 2) * FIELD.spacing;
  const ca = Math.cos(f.a), sa = Math.sin(f.a);
  p.targetX = f.x + ca * along - sa * across;
  p.targetZ = f.z + sa * along + ca * across;
  return true;
}

/* A session at the field. The ditch first — a stretch dug from the water end,
   and the water let in when it reaches the field — and nothing sown until the
   water runs and the band can irrigate. Then a crop, which follows the season
   like everything else that grows, and the island's ABUNDANCE like every other
   food. */
export function farmDone(p) {
  const camp = p.camp, f = fieldOf(camp), d = ditchOf(camp);
  if (!f || !d?.path) return;
  if ((camp.ditchDug || 0) < d.length) {
    const front = d.path[Math.min(d.path.length - 1, Math.floor((camp.ditchDug || 0) / DITCH.step))];
    if (Math.hypot(p.x - front.x, p.z - front.z) > 14) return;     // gave up on the way
    camp.ditchDug = Math.min(d.length, (camp.ditchDug || 0) + FARM.dig * (1 + (camp.skill.irrigation || 0)));
    if (camp.ditchDug >= d.length) {
      logEvent('learned', `[${camp.code}] ${camp.name} dug a ditch to their field, and the water runs in it`, f.x, f.z);
    }
  } else {
    const size = fieldSize(camp);
    const reach = Math.max(14, size.len / 2 + (size.rows * FIELD.spacing) / 2 + 4);
    if (Math.hypot(p.x - f.x, p.z - f.z) > reach) return;     // gave up on the way
  }
  const learning = (camp.skill.irrigation || 0) < FARM.irrigateFirst;
  practise(camp, 'irrigation', learning ? FARM.perDitch : FARM.perDitch * 0.25);
  p.knows.irrigation = Math.max(p.knows.irrigation || 0, camp.skill.irrigation);
  const watered = ditchDone(camp);
  if (learning || !watered) return;
  practise(camp, 'farming', FARM.perField);
  p.knows.farming = Math.max(p.knows.farming || 0, camp.skill.farming);
  const got = FARM.crop * (0.3 + 0.7 * camp.skill.farming) * forageSeason * P.abundance;
  if (!(got > 0)) return;
  p.haul += got;
  p.carry = 1;
  bagAdd(p, 'vegetables', Math.max(1, Math.round(got / BAG.veg)));
}

/* The flock, on the books. Pens its first pair when the band is a fair hand
   at farming, grows while there is room for it — room being what the band
   knows how to keep — and gives the store a little every day. A band that has
   nobody left has nobody to keep them, and they wander off. */
export function updateLivestock(days) {
  const here = new Map();
  for (const p of people) here.set(p.camp, (here.get(p.camp) || 0) + 1);
  for (const c of camps) {
    const was = Math.round(c.stock || 0);
    const farming = c.skill?.farming || 0;
    if (!here.get(c)) {
      c.stock = Math.max(0, (c.stock || 0) * (1 - 0.3 * days));
    } else if (farming >= FARM.stockFrom || c.stock > 0) {
      if (!(c.stock > 0)) {
        c.stock = 2;                        // a pair, brought in off the hill
        logEvent('learned', `[${c.code}] ${c.name} has penned its first animals`, c.x, c.z);
      }
      const room = FARM.stockMax * farming;
      c.stock += (c.stock < room ? FARM.stockGrow * c.stock * (1 - c.stock / room) : (room - c.stock) * 0.1) * days;
      c.stock = Math.max(0, c.stock);
      c.food += c.stock * FARM.milk * P.abundance * days;
    }
    if (Math.round(c.stock || 0) !== was) dressCamp(c);
  }
}

/* ---- what it looks like ---- */

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _e = new THREE.Euler(), _m = new THREE.Matrix4(), _c = new THREE.Color();
const EARTH = 0x5b4a35, SHOOT = 0x5f8f3a, POST = 0x6b5334, FLEECE = 0xe4dccb, TRENCH = 0x3f3326;

/** Ridges of turned earth, what grows on them, the pen's posts and a sheep. */
export function farmGeometries() {
  const body = new THREE.SphereGeometry(0.42, 7, 5).scale(1.3, 0.85, 0.8).translate(0, 0.6, 0);
  const head = new THREE.SphereGeometry(0.22, 6, 4).translate(0.55, 0.78, 0);
  return {
    rows: new THREE.BoxGeometry(9.5, 0.14, 0.55).translate(0, 0.05, 0),
    crops: new THREE.ConeGeometry(0.26, 0.7, 5).translate(0, 0.35, 0),
    pen: new THREE.CylinderGeometry(0.06, 0.07, 1.1, 5).translate(0, 0.55, 0),
    sheep: joinGeometries([body, head]),
  };
}

function put(mesh, slot, x, z, yaw, sx, sy, sz, hex) {
  _v.set(x, sampleHeight(x, z), z);
  _e.set(0, yaw, 0);
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  mesh.setMatrixAt(slot, _m.compose(_v, _q, _s));
  mesh.setColorAt(slot, _c.setHex(hex));
}

/* The rows and what grows on them are not a camp's to keep slots for: a field
   has no largest, so every band's is drawn into one pair of meshes that grows,
   doubling, to whatever the fields on the island come to. Redrawn whole, on
   the next frame after any band's field changes. */
let farmGeo = null, rowMesh = null, cropMesh = null, fieldsDirty = true, trenchMaterial = null;

function roomFor(mesh, need, geo, name) {
  const live = mesh && mesh.parent === tribeGroup;
  if (live && mesh.instanceMatrix.count >= need) return mesh;
  let size = live ? mesh.instanceMatrix.count : 64;
  while (size < need) size *= 2;
  if (mesh) { mesh.parent?.remove(mesh); mesh.dispose(); }
  const m = new THREE.InstancedMesh(geo, faunaMaterial, size);
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  m.frustumCulled = false;
  m.count = 0;
  tribeGroup.add(m);
  return m;
}

/* What a field grows round: the tents of every camp near it and their
   trampled ground, their granaries, a village's outskirts fires and yards and
   halls, a city's houses, and the dead. Marked on a grid of four-metre cells,
   so a field of a thousand plants is not a thousand walks round the camps. */
function takenBy(near) {
  const marks = [];
  for (const camp of near) {
    marks.push([camp.x, camp.z, CAMP_CLEARING]);
    for (const h of camp.huts || []) marks.push([h.x, h.z, 3]);
    for (const s of camp.storeSpots || []) marks.push([s.x, s.z, 3.5]);
    const o = camp.outer;
    for (const h of o?.hearths || []) if (h.fire) marks.push([h.fire.x, h.fire.z, 11]);
    for (const y of o?.yards || []) for (const s of y.spots || []) marks.push([s.x ?? s[0], s.z ?? s[1], 3.5]);
    for (const k in o?.civic || {}) { const c = o.civic[k]; if (c) marks.push([c.x, c.z, 9]); }
    for (const h of camp.city?.homes || []) marks.push([h.x, h.z, 4]);
    if (camp.barrow) marks.push([camp.barrow.x, camp.barrow.z, 12 + Math.sqrt(camp.buried || 0) * 1.6]);
  }
  const cells = new Set(), cell = 4, key = (i, j) => i * 100003 + j;
  for (const [x, z, r] of marks) {
    for (let i = Math.floor((x - r) / cell); i <= Math.floor((x + r) / cell); i++) {
      for (let j = Math.floor((z - r) / cell); j <= Math.floor((z + r) / cell); j++) {
        if (Math.hypot((i + 0.5) * cell - x, (j + 0.5) * cell - z) < r + cell * 0.5) cells.add(key(i, j));
      }
    }
  }
  return (x, z) => cells.has(key(Math.floor(x / cell), Math.floor(z / cell)));
}

function redrawFields() {
  fieldsDirty = false;
  farmGeo ||= farmGeometries();
  const plan = [];
  let rowsNeed = 0, cropsNeed = 0;
  for (const camp of camps) {
    if (camp.gone) continue;
    const f = fieldOf(camp), size = fieldSize(camp);
    // Ridges once the water runs: a field is dug where it can be watered.
    if (!f || !size.rows || !ditchDone(camp)) continue;
    const segs = Math.max(1, Math.round(size.len / FIELD.minLen));
    plan.push({ camp, f, size, segs });
    rowsNeed += size.rows * segs;
    cropsNeed += size.rows * size.perRow;
  }
  rowMesh = roomFor(rowMesh, rowsNeed, farmGeo.rows, 'field-rows');
  cropMesh = roomFor(cropMesh, cropsNeed, farmGeo.crops, 'field-crops');
  let nr = 0, nc = 0;
  const sown = [];                     // the fields drawn so far: a later one grows round them
  for (const { camp, f, size, segs } of plan) {
    const reach = fieldReach(camp) + 400;
    const taken = takenBy(camps.filter((c) => !c.gone && Math.hypot(c.x - f.x, c.z - f.z) < reach));
    const ca = Math.cos(f.a), sa = Math.sin(f.a);
    const spot = (along, across) => [f.x + ca * along - sa * across, f.z + sa * along + ca * across];
    const sownAt = (x, z) => sown.some((s) => {
      const dx = x - s.x, dz = z - s.z;
      return Math.abs(dx * s.ca + dz * s.sa) < s.halfL && Math.abs(dz * s.ca - dx * s.sa) < s.halfW;
    });
    // Never in the water or on the camp's trampled ground, and round whatever stands there.
    const growable = (x, z) => sampleHeight(x, z) > SEA + 0.6 && Math.hypot(x - camp.x, z - camp.z) > CAMP_CLEARING
      && !inWater(x, z) && !taken(x, z) && !sownAt(x, z);
    const shoots = Math.round(size.perRow * size.grown);
    const seg = size.len / segs;
    for (let r = 0; r < size.rows; r++) {
      const across = (r - (size.rows - 1) / 2) * FIELD.spacing;
      // The ridge in stretches, each where the ground lets it be.
      for (let k = 0; k < segs; k++) {
        const [rx, rz] = spot((k - (segs - 1) / 2) * seg, across);
        if (growable(rx, rz)) put(rowMesh, nr++, rx, rz, -f.a, seg / FIELD.minLen, 1, 1, EARTH);
      }
      for (let k = 0; k < shoots; k++) {
        const [cx, cz] = spot((k - (size.perRow - 1) / 2) * FIELD.step, across);
        if (!growable(cx, cz)) continue;
        const sc = 0.8 + (((r * size.perRow + k) * 37) % 10) / 25;
        put(cropMesh, nc++, cx, cz, k * 1.3, sc, sc, sc, SHOOT);
      }
    }
    sown.push({ x: f.x, z: f.z, ca, sa, halfL: size.len / 2 + 1, halfW: (size.rows * FIELD.spacing) / 2 + 1 });
  }
  for (const m of [rowMesh, cropMesh]) {
    m.count = m === rowMesh ? nr : nc;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}

/** Every frame the world is drawn: the fields, if any band's has changed. */
export function updateFields() {
  if (fieldsDirty) redrawFields();
}

/* The ditch on the ground: an earth trench from the water end as far as it
   is dug, and the water running in it once it reaches the field. */
function dressDitch(camp) {
  const d = ditchOf(camp);
  if (!d?.path) return;
  let g = camp.ditchDrawn;
  if (!g || g.of !== d || g.trench.parent !== tribeGroup) {
    const n = d.path.length;
    const ribbon = (width, lift) => {
      const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2), idx = [];
      let along = 0;
      for (let i = 0; i < n; i++) {
        const q = d.path[i], a = d.path[Math.max(0, i - 1)], b = d.path[Math.min(n - 1, i + 1)];
        let dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        if (i) along += Math.hypot(q.x - d.path[i - 1].x, q.z - d.path[i - 1].z);
        for (const side of [-1, 1]) {
          const k = i * 2 + (side > 0 ? 1 : 0);
          const x = q.x - dz * width * 0.5 * side, z = q.z + dx * width * 0.5 * side;
          pos[k * 3] = x; pos[k * 3 + 1] = sampleHeight(x, z) + lift; pos[k * 3 + 2] = z;
          uv[k * 2] = side > 0 ? 1 : 0; uv[k * 2 + 1] = along / 12;
        }
        if (i < n - 1) { const a0 = i * 2; idx.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return geo;
    };
    if (g) { for (const m of [g.trench, g.water]) { m.parent?.remove(m); m.geometry.dispose(); } }
    trenchMaterial ||= new THREE.MeshLambertMaterial({ color: TRENCH, side: THREE.DoubleSide });
    const trench = new THREE.Mesh(ribbon(DITCH.width, 0.06), trenchMaterial);
    const water = new THREE.Mesh(ribbon(DITCH.water, 0.14), streamMaterial);
    trench.name = 'ditch';
    water.name = 'ditch-water';
    trench.receiveShadow = true;
    water.receiveShadow = true;
    tribeGroup.add(trench, water);
    g = camp.ditchDrawn = { of: d, trench, water };
  }
  const dug = Math.min(d.length, camp.ditchDug || 0);
  const quads = Math.min(d.path.length - 1, Math.floor(dug / DITCH.step));
  g.trench.geometry.setDrawRange(0, quads * 6);
  g.trench.visible = quads > 0;
  g.water.visible = dug >= d.length;
}

/* The pen and its flock, in the camp's own slots, beside the field; the ditch;
   and the field itself, redrawn on the next frame (updateFields). */
export function dressField(camp, parts, index) {
  fieldsDirty = true;
  dressDitch(camp);
  if (!parts.pen) return;
  const n = CAMP_PIECES, f = fieldOf(camp), size = fieldSize(camp);
  const stock = f ? Math.round(camp.stock || 0) : 0;
  const ca = f ? Math.cos(f.a) : 1, sa = f ? Math.sin(f.a) : 0;
  const spot = (along, across) => [f.x + ca * along - sa * across, f.z + sa * along + ca * across];
  const beside = (size.rows / 2) * FIELD.spacing + 5.5;
  for (let i = 0; i < n.pen; i++) {
    const a = (i / n.pen) * Math.PI * 2;
    if (stock > 0) {
      const [x, z] = spot(Math.cos(a) * 3.4, beside + Math.sin(a) * 3.4);
      put(parts.pen, index * n.pen + i, x, z, 0, 1, 1, 1, POST);
    } else parts.pen.setMatrixAt(index * n.pen + i, HIDDEN);
  }
  for (let i = 0; i < n.sheep; i++) {
    // Spread round the pen, and the same place each time it is dressed.
    const a = i * 2.39996, r = Math.min(2.6, 0.7 + ((i * 53) % 17) / 10);
    if (i < stock) {
      const [x, z] = spot(Math.cos(a) * r, beside + Math.sin(a) * r);
      put(parts.sheep, index * n.sheep + i, x, z, a * 2, 1, 1, 1, FLEECE);
    } else parts.sheep.setMatrixAt(index * n.sheep + i, HIDDEN);
  }
  for (const key of ['pen', 'sheep']) {
    const m = parts[key];
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    // Only as far as the bands there are: the rest of the room is for bands not yet founded.
    m.count = Math.min(m.instanceMatrix.count, camps.length * n[key]);
  }
}
