import * as THREE from 'three';

import { P, SEA } from './params.js';
import { flatnessAt, mulberry32, sampleHeight, inWater } from './noise.js';
import { HIDDEN, _c, _e, _m4, _q, _s, _v, refillTilesNear, treeSpots } from './world.js';
import { FIELD, fieldReach } from './farming.js';
import { CITYHALL_TOP, civicGeometries, houseGeometry, storeGeometry, tentMaterial, tentStyle } from './village.js';
import { pathEpoch, paveDisc, paveRoad } from './paths.js';
import {
  CAMP_CLEARING, CAMP_PIECES, campCapacity, campParts, camps, GRAVE_SPACING, HEARTHS, PALE, people, STORE_FLAT, STORE_SCALE, STORE_SPOTS, STORE_STAND, STORE_THATCH, STORE_WALL, STORES, TENT_REACH, tribeGroup
} from './people.js';

/* -------------------------------------------------------------------------
   A settlement past its core

   Lifted out of people.js whole, because people.js had grown past the length
   of the page it was split out of — the rule this project keeps, the same one
   that took skills out of life.js. It was already one subject with one edge:
   everything a camp becomes beyond the five fires and fifty tents it is laid
   out with — the outskirts and their granaries, a village's and a city's
   houses, the chief's hall, the market and the wall.

   people.js imports it back, and re-exports what the rest of the page asks it
   for, so nothing that imported these from there had to change. The cycle is
   safe for the reason every other one here is: nothing on either side is
   called while a module is still loading.
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   The outskirts: a village that keeps growing

   The core of a camp is five fires and fifty tents, laid out once when the
   camp is founded — and a band of fourteen hundred lived in those fifty,
   everybody past the fiftieth household sharing the last one. So past the
   core a village grows outskirts: more hearths, ten tents round each, in rings
   out from the middle, as many as there are households to fill them, and a
   yard of granaries after every few.

   Laid out as they are needed and never off the camp's own random stream: that
   stream laid out the core and moves on with every draw. A hearth's place comes
   from its ring and its seat instead, the same every time, so a village that
   shrinks and grows again puts its tents back where they stood, and a
   reloaded world rebuilds the same outskirts without any of it being saved.

   A spot is skipped rather than moved: in the water, on a hillside, on the
   graveyard or the field, crowding another village, or too far into the woods
   to pitch in. A band that runs out of good ground packs its last households
   into the tents it has, which is what the core always did.
   ------------------------------------------------------------------------- */
export const OUTSKIRTS = {
  first: 37,        // the first ring out: the core's tents reach 24.5 m, these begin at 25.4
  ring: 24,         // metres between rings: two tents' reach from their fires, and a little
  apart: 23.5,      // and between neighbouring fires on one ring, for the same reason
  seats: 10,        // tents round an outskirts fire, as round a core one
  minSeats: 6,      // fewer good spots round it than this and a fire is not lit there
  storeEvery: 5,    // a yard of granaries after every five outskirts fires
  rings: 12,        // how far out it will look: the twelfth ring is three hundred metres
};

/** How far a camp's trampled ground reaches: its clearing, or its outskirts. */
export const campReach = (c) => Math.max(CAMP_CLEARING, c?.reach || 0);

const outerSeed = (camp, slot) => ((Math.round(camp.x * 8) * 73856093) ^ (Math.round(camp.z * 8) * 19349663)
  ^ Math.imul(slot + 1, 83492791) ^ P.seed) >>> 0;

/* Where the s-th spot out from a camp is: ring by ring, and round each ring. */
function outerSlot(camp, s) {
  let rest = s;
  for (let k = 0; k < OUTSKIRTS.rings; k++) {
    const R = OUTSKIRTS.first + k * OUTSKIRTS.ring;
    const n = Math.max(6, Math.floor((2 * Math.PI * R) / OUTSKIRTS.apart));
    if (rest < n) {
      const a = (rest / n) * Math.PI * 2 + (camp.hearthTurn || 0) + k * 0.618;
      return { x: camp.x + Math.cos(a) * R, z: camp.z + Math.sin(a) * R };
    }
    rest -= n;
  }
  return null;
}

/* Whether a village may spread onto a spot: dry and level, clear of the dead
   and of the largest graveyard it could come to, clear of the largest field
   (FIELD, farming.js), and clear of every other village's ground. */
function outerGround(camp, x, z) {
  if (sampleHeight(x, z) < SEA + 1.5 || flatnessAt(x, z) < 0.8) return false;
  if (inWater(x, z)) return false;                             // nor in a creek or a lake
  if (camp.barrow) {
    const ring = Math.ceil((Math.sqrt(Math.max(1, (camp.buried || 0) + 100)) - 1) / 2);
    const half = (ring + 0.5) * GRAVE_SPACING + 0.3;
    if (Math.hypot(x - camp.barrow.x, z - camp.barrow.z) < half * 1.6 + 6 + TENT_REACH) return false;
  }
  if (camp.field) {
    const most = fieldReach(camp);           // as far as the field has come (farming.js)
    if (Math.hypot(x - camp.field.x, z - camp.field.z) < most + TENT_REACH) return false;
  }
  for (const c of camps) {
    if (c === camp || c.gone) continue;
    if (Math.hypot(x - c.x, z - c.z) < campReach(c) + TENT_REACH + 4) return false;
  }
  return true;
}

function spread(camp, x, z, edge) {
  const reach = Math.hypot(x - camp.x, z - camp.z) + edge;
  if (reach > (camp.reach || 0)) {
    camp.reach = reach;
    refillTilesNear(camp.x, camp.z, reach);     // the grass goes, out to the new edge
  }
}

/* A fire and the ring of tents round it, laid out the way the core's are. The
   stream is drawn in full for every tent, kept or not, so skipping one never
   moves the next. */
function addOuterHearth(camp, o, spot, slot) {
  const jitter = mulberry32(outerSeed(camp, slot));
  const trees = treeSpots.filter((t) => Math.abs(t.x - spot.x) < 12 && Math.abs(t.z - spot.z) < 12);
  const fire = { x: spot.x, y: sampleHeight(spot.x, spot.z), z: spot.z };
  const huts = [];
  for (let k = 0; k < OUTSKIRTS.seats; k++) {
    const a = (k / OUTSKIRTS.seats) * Math.PI * 2 + jitter() * 0.5;
    const r = 6.5 + jitter() * 2.6;
    const sc = 0.85 + jitter() * 0.4, tall = 0.9 + jitter() * 0.3;
    const hide = 0x6d5740 + ((jitter() * 0x101010) | 0);
    const x = fire.x + Math.cos(a) * r, z = fire.z + Math.sin(a) * r;
    if (sampleHeight(x, z) < SEA + 1 || trees.some((t) => Math.hypot(t.x - x, t.z - z) < 2.6)) continue;
    _e.set(0, -a, 0); _q.setFromEuler(_e);
    _v.set(x, sampleHeight(x, z) - 0.15, z);
    _s.set(sc, sc * tall, sc);
    huts.push({ hut: { x, z }, at: _m4.compose(_v, _q, _s).clone(), hide });
  }
  if (huts.length < OUTSKIRTS.minSeats) return;
  const stones = [], logs = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const x = fire.x + Math.cos(a) * 1.15, z = fire.z + Math.sin(a) * 1.15;
    const sc = 0.7 + jitter() * 0.7;
    _e.set(jitter() * 3, jitter() * 3, jitter() * 3); _q.setFromEuler(_e);
    _v.set(x, sampleHeight(x, z) + 0.06, z);
    _s.set(sc, sc * 0.8, sc);
    stones.push(_m4.compose(_v, _q, _s).clone());
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4 + jitter() * 0.3;
    const x = fire.x + Math.cos(a) * 2.6, z = fire.z + Math.sin(a) * 2.6;
    _e.set(0, -a + Math.PI / 2, 0); _q.setFromEuler(_e);
    _v.set(x, sampleHeight(x, z) + 0.17, z);
    _s.setScalar(0.9 + jitter() * 0.3);
    logs.push(_m4.compose(_v, _q, _s).clone());
  }
  o.hearths.push({ fire, huts, stones, logs });
  // One of the camp's own fires, after the core's five: see assignHuts.
  camp.fireAt[HEARTHS + o.hearths.length - 1] = fire;
  for (const t of huts) o.seats.push({ hut: t.hut, fire });
  spread(camp, fire.x, fire.z, TENT_REACH);
}

/* A yard of granaries, four of them in the core's pattern, turned to face the
   middle of the village so the ground to fill them from is on the near side. */
function addYard(camp, o, spot) {
  const b = Math.atan2(spot.z - camp.z, spot.x - camp.x);
  const ox = Math.cos(b), oz = Math.sin(b), ax = -Math.sin(b), az = Math.cos(b);
  const spots = [];
  STORE_SPOTS.forEach(([out, along], k) => {
    const x = spot.x + ox * out + ax * along, z = spot.z + oz * out + az * along;
    const fx = x - ox * STORE_STAND, fz = z - oz * STORE_STAND;
    if (sampleHeight(x, z) < SEA + 1.5 || sampleHeight(fx, fz) < SEA + 1.5 || flatnessAt(x, z) < STORE_FLAT) return;
    _e.set(0, -b + k * 0.7, 0); _q.setFromEuler(_e);
    _v.set(x, sampleHeight(x, z) - 0.05, z);
    _s.setScalar(STORE_SCALE);
    spots.push({ x, z, fx, fz, at: _m4.compose(_v, _q, _s).clone() });
  });
  o.yards.push({ spots });
  spread(camp, spot.x, spot.z, 5);
}

/** Lays out as much of the outskirts as there are households for, and keeps it. */
export function extendOutskirts(camp, seats) {
  const o = outerOf(camp);
  while (o.seats.length < seats && !o.done) {
    const slot = o.next++;
    const spot = outerSlot(camp, slot);
    if (!spot) { o.done = true; break; }
    if (!outerGround(camp, spot.x, spot.z)) continue;
    if (o.yards.length < Math.floor(o.hearths.length / OUTSKIRTS.storeEvery)) addYard(camp, o, spot);
    else addOuterHearth(camp, o, spot, slot);
  }
  return o;
}

/* -------------------------------------------------------------------------
   A city is laid out in streets

   A camp is fires with tents round them, and so is a village — houses round
   hearths. A city is not: it is rows of houses along streets, and a household
   sits at its own door rather than round a fire it shares with nine others. So
   a city gets a plan of its own, on a grid turned to the camp's own bearing:
   rows back to back, each facing a street five metres wide, a cross street
   every six houses, and an open plaza at the middle round the one fire it
   keeps. Every household has a house, nearest the middle first, so a city
   fills out from its heart — no fifty-house core, no rings.

   The plan is worked out once, from where the camp is, and a plot is skipped
   rather than moved: in the water, on a hillside, on the dead or the field, on
   the granaries, the hall or the market (claimed first, so the houses keep off
   them), among trees, or crowding the next place. Every twelfth good plot is a
   granary rather than a house.
   ------------------------------------------------------------------------- */
export const CITY = { at: 4, along: 4.2, block: 6, pair: 11.4, back: 1.7, plaza: 10, reach: 150, storeEvery: 12,
  hallRoof: CITYHALL_TOP };

function cityCandidates(camp) {
  const th = camp.hearthTurn || 0;
  const ux = Math.cos(th), uz = Math.sin(th), vx = -uz, vz = ux;
  const out = [];
  const J = Math.ceil(CITY.reach / CITY.pair), I = Math.ceil(CITY.reach / CITY.along);
  for (let j = -J; j <= J; j++) {
    for (const side of [-1, 1]) {
      // Back to back, each row facing out onto its street.
      const v = j * CITY.pair + side * CITY.back;
      for (let i = -I; i <= I; i++) {
        if ((((i % (CITY.block + 1)) + CITY.block + 1) % (CITY.block + 1)) === CITY.block) continue;   // a cross street
        const u = i * CITY.along;
        const d = Math.hypot(u, v);
        if (d < CITY.plaza || d > CITY.reach) continue;
        out.push({ x: camp.x + ux * u + vx * v, z: camp.z + uz * u + vz * v, d, fx: side * vx, fz: side * vz, u, v, side });
      }
    }
  }
  return out.sort((a, b) => a.d - b.d);
}

function cityGround(camp, q, trees) {
  const sx = q.x + q.fx * 3.2, sz = q.z + q.fz * 3.2;
  if (sampleHeight(q.x, q.z) < SEA + 1.2 || sampleHeight(sx, sz) < SEA + 1 || flatnessAt(q.x, q.z) < 0.72) return false;
  if (inWater(q.x, q.z) || inWater(sx, sz)) return false;     // a city is not built in its creeks
  if (camp.barrow) {
    const ring = Math.ceil((Math.sqrt(Math.max(1, (camp.buried || 0) + 100)) - 1) / 2);
    const half = (ring + 0.5) * GRAVE_SPACING + 0.3;
    if (Math.hypot(q.x - camp.barrow.x, q.z - camp.barrow.z) < half * 1.6 + 4) return false;
  }
  if (camp.field) {
    const most = fieldReach(camp);           // as far as the field has come (farming.js)
    if (Math.hypot(q.x - camp.field.x, q.z - camp.field.z) < most + 3) return false;
  }
  for (const s of camp.storeSpots || []) if (Math.hypot(q.x - s.x, q.z - s.z) < 4.2) return false;
  const market = camp.outer?.civic?.market;
  if (market && Math.hypot(q.x - market.x, q.z - market.z) < 10) return false;
  for (const c of camps) {
    if (c === camp || c.gone) continue;
    if (Math.hypot(q.x - c.x, q.z - c.z) < campReach(c) + 6) return false;
  }
  return !trees.some((t) => Math.hypot(t.x - q.x, t.z - q.z) < 2.4);
}

/** A house for each of n households, and the granaries among them, kept. */
export function cityPlotsFor(camp, n) {
  if (!camp.city || camp.city.x !== camp.x || camp.city.z !== camp.z) {
    camp.city = { x: camp.x, z: camp.z, cand: null, next: 0, homes: [], stores: [], trees: null };
  }
  const c = camp.city;
  // The market first, so no house is ever put up where it goes. (The chief's
  // hall is not a city's: its city hall is in the middle, where the fire was.)
  claimCivic(camp, 'market');
  c.cand ||= cityCandidates(camp);
  c.trees ||= treeSpots.filter((t) => Math.hypot(t.x - camp.x, t.z - camp.z) < CITY.reach + 6);
  while (c.homes.length < n && c.next < c.cand.length) {
    const slot = c.next++;
    const q = c.cand[slot];
    if (!cityGround(camp, q, c.trees)) continue;
    const jitter = mulberry32(outerSeed(camp, 100000 + slot));
    _e.set(0, Math.atan2(q.fx, q.fz), 0); _q.setFromEuler(_e);
    _v.set(q.x, sampleHeight(q.x, q.z) - 0.1, q.z);
    if ((c.homes.length + c.stores.length) % CITY.storeEvery === CITY.storeEvery - 1) {
      _s.setScalar(STORE_SCALE);
      c.stores.push({ at: _m4.compose(_v, _q, _s).clone() });
      continue;
    }
    const sc = 0.95 + jitter() * 0.15;
    _s.set(sc, sc * (0.85 + jitter() * 0.35), sc);
    const at = _m4.compose(_v, _q, _s).clone();
    const hide = 0x6d5740 + ((jitter() * 0x101010) | 0);
    const door = { x: q.x + q.fx * 2.2, z: q.z + q.fz * 2.2 };
    const step = { x: q.x + q.fx * 3.2, y: sampleHeight(q.x + q.fx * 3.2, q.z + q.fz * 3.2), z: q.z + q.fz * 3.2 };
    c.homes.push({ x: q.x, z: q.z, at, hide, door, step, u: q.u, v: q.v, side: q.side });
    spread(camp, q.x, q.z, 3);
  }
  return c.homes;
}

/* Drawn packed, not slotted per camp: the core gives every camp fifty tents
   whether it has them or not, and the outskirts of one city can be a thousand.
   So every camp's outskirts go one after another into shared meshes, rewritten
   whenever any band changes, and the meshes grow when they fill. */
const OUT_TENTS = { huts: 'outHuts', tentHide: 'outTentHide', tentPainted: 'outTentPainted', lodge: 'outLodge',
  house: 'outHouse', townhouse: 'outTownhouse' };
const OUT_CORE = { outHuts: 'huts', outTentHide: 'tentHide', outTentPainted: 'tentPainted', outLodge: 'lodge',
  outHouse: 'house', outTownhouse: 'townhouse', outFire: 'fire', outStones: 'stones', outLogs: 'logs',
  outStores: 'stores', outStoreRoofs: 'storeRoofs' };

/* Every one of these is made the first time any camp needs it, not at world
   build. Nothing is lost by waiting — until a band passes fifty households, or
   builds a house, or becomes a chiefdom, there is nothing to draw — and a world
   where none has is a world that never allocated them. Which matters for more
   than the memory: three draws Math.random for every object it makes, so
   meshes made at build moved every random number after them and put the boot
   check on a different island. And each grows, doubling, when it fills. */
function packed(key, want, make) {
  let m = campParts[key];
  if (!m) {
    if (!want) return null;
    m = make(Math.max(8, want));
    m.frustumCulled = false;
    m.count = 0;
    tribeGroup.add(m);
    campParts[key] = m;
  }
  if (m.instanceMatrix.count >= want) return m;
  let room = m.instanceMatrix.count;
  while (room < want) room *= 2;
  const g = new THREE.InstancedMesh(m.geometry, m.material, room);
  g.name = m.name;
  g.castShadow = m.castShadow;
  g.receiveShadow = m.receiveShadow;
  g.frustumCulled = false;
  g.count = 0;
  tribeGroup.remove(m);
  m.dispose();
  tribeGroup.add(g);
  campParts[key] = g;
  return g;
}

/* A kind of house for the core, every camp's slots parked, tinted off where it
   stands rather than off any stream. */
export function makeHouses(key) {
  const m = new THREE.InstancedMesh(houseGeometry(key), tentMaterial, Math.max(1, campCapacity * CAMP_PIECES.huts));
  m.name = 'camp-' + key;
  m.castShadow = true;
  m.receiveShadow = true;
  m.frustumCulled = false;
  for (let i = 0; i < m.instanceMatrix.count; i++) {
    m.setMatrixAt(i, HIDDEN);
    const t = ((i * 2654435761) >>> 0) / 4294967296;
    m.setColorAt(i, _c.setRGB(0.88 + t * 0.12, 0.86 + t * 0.12, 0.84 + t * 0.12));
  }
  tribeGroup.add(m);
  campParts[key] = m;
  return m;
}

/* Which store a settlement keeps its food in (village.js): a band's granary on
   stilts until it is a village, a storehouse on staddle stones then, domed
   brick silos in a city. Wherever a granary would stand — the core's, the
   outskirts yards', a city's plots — the store of its rung stands instead. */
export const storeKind = (camp) => ((camp.stage || 0) >= CITY.at ? 'silo' : (camp.stage || 0) >= 3 ? 'storehouse' : 'granary');
const OUT_STORE = { storehouse: 'outStorehouse', silo: 'outSilo' };
const storeMesh = (kind) => (room) => {
  const m = new THREE.InstancedMesh(storeGeometry(kind), tentMaterial, room);
  m.name = 'store-' + kind;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
};

/* The core's granary slots: shown as the store says, and parked for a
   settlement that has built something better — which then stands in them. */
function coreStores(camp) {
  const up = storeKind(camp) === 'granary' && !camp.gone ? camp.storesUp || 0 : 0;
  for (let k = 0; k < STORES; k++) {
    const slot = camp.index * STORES + k;
    const at = (k < up && camp.storeAt?.[k]) || HIDDEN;
    campParts.stores.setMatrixAt(slot, at);
    campParts.storeRoofs.setMatrixAt(slot, at);
  }
}

const outskirtsMesh = (key) => (room) => {
  const core = campParts[OUT_CORE[key]] || makeHouses(OUT_CORE[key]);
  const m = new THREE.InstancedMesh(core.geometry, core.material, room);
  m.name = 'outskirts-' + OUT_CORE[key];
  m.castShadow = core.castShadow;
  m.receiveShadow = core.receiveShadow;
  return m;
};

export function dressOutskirts() {
  if (!campParts?.huts) return;
  dressCivic();
  const n = Object.fromEntries([...Object.keys(OUT_CORE), ...Object.values(OUT_STORE)].map((k) => [k, 0]));
  const need = { ...n };
  // Where each store stands, granary or better; how many of each is known once they are counted.
  const stores = new Map();
  const storeAt = (camp, at) => {
    const kind = storeKind(camp);
    if (!stores.has(camp)) stores.set(camp, []);
    stores.get(camp).push(at);
    need[OUT_STORE[kind] || 'outStores']++;
  };
  const lit = (camp) => {
    let left = camp.outerShown || 0, fires = 0;
    for (const h of camp.outer.hearths) { if (left <= 0) break; fires++; left -= h.huts.length; }
    return fires;
  };
  const yardsOf = (camp) => Math.min(camp.outer.yards.length, Math.floor((camp.outerLit || 0) / OUTSKIRTS.storeEvery));
  // A city's houses and granaries go in the same brick and granary meshes.
  const cityStores = (camp) => Math.min(camp.city.stores.length,
    Math.round(Math.floor(camp.cityShown / (CITY.storeEvery - 1)) * Math.min(1, (camp.storesUp || 0) / STORES)));
  for (const camp of camps) {
    coreStores(camp);
    if (camp.cityShown && camp.city) {
      need.outTownhouse += camp.cityShown;
      for (const st of camp.city.stores.slice(0, cityStores(camp))) storeAt(camp, st.at);
    }
    // A granary in the core is a slot of its own; anything better stands in the packed lists.
    if (storeKind(camp) !== 'granary' && !camp.gone) {
      for (let k = 0; k < (camp.storesUp || 0) && k < (camp.storeAt?.length || 0); k++) storeAt(camp, camp.storeAt[k]);
    }
    camp.outerLit = camp.outer && !camp.gone ? lit(camp) : 0;
    if (!camp.outerLit) continue;
    need[OUT_TENTS[tentStyle(camp)]] += Math.min(camp.outerShown, camp.outer.seats.length);
    need.outFire += camp.outerLit;
    need.outStones += camp.outerLit * 9;
    need.outLogs += camp.outerLit * 4;
    for (let y = 0; y < yardsOf(camp); y++) {
      for (const s of camp.outer.yards[y].spots.slice(0, camp.storesUp || 0)) storeAt(camp, s.at);
    }
  }
  need.outStoreRoofs = need.outStores;
  for (const key in need) packed(key, need[key], key === 'outStorehouse' ? storeMesh('storehouse') : key === 'outSilo' ? storeMesh('silo') : outskirtsMesh(key));
  for (const camp of camps) {
    camp.outerFires = [];
    camp.outerStores = [];
    if (camp.cityShown && camp.city) {
      for (const h of camp.city.homes.slice(0, camp.cityShown)) {
        const i = n.outTownhouse++;
        campParts.outTownhouse.setMatrixAt(i, h.at);
        campParts.outTownhouse.setColorAt(i, _c.setHex(h.hide).lerp(PALE, 0.72));
      }
    }
    for (const at of stores.get(camp) || []) {
      const kind = OUT_STORE[storeKind(camp)];
      if (kind) {
        const i = n[kind]++;
        campParts[kind].setMatrixAt(i, at);
        const t = ((i * 2654435761) >>> 0) / 4294967296;
        campParts[kind].setColorAt(i, _c.setRGB(0.9 + t * 0.1, 0.88 + t * 0.1, 0.86 + t * 0.1));
        continue;
      }
      const i = n.outStores++;
      campParts.outStores.setMatrixAt(i, at);
      campParts.outStoreRoofs.setMatrixAt(i, at);
      campParts.outStores.setColorAt(i, _c.setHex(STORE_WALL));
      campParts.outStoreRoofs.setColorAt(i, _c.setHex(STORE_THATCH));
    }
    if (!camp.outerLit) continue;
    const key = OUT_TENTS[tentStyle(camp)], mesh = campParts[key];
    let left = camp.outerShown;
    for (let f = 0; f < camp.outerLit; f++) {
      const h = camp.outer.hearths[f];
      for (const t of h.huts) {
        if (left <= 0) break;
        left--;
        const i = n[key]++;
        mesh.setMatrixAt(i, t.at);
        mesh.setColorAt(i, key === 'outHuts' ? _c.setHex(t.hide) : _c.setHex(t.hide).lerp(PALE, 0.72));
      }
      const fi = n.outFire++;
      _v.set(h.fire.x, h.fire.y + 0.05, h.fire.z); _q.identity(); _s.setScalar(1);
      campParts.outFire.setMatrixAt(fi, _m4.compose(_v, _q, _s));
      camp.outerFires.push({ slot: fi, fire: h.fire, f: HEARTHS + f });
      for (const m of h.stones) {
        const i = n.outStones++;
        campParts.outStones.setMatrixAt(i, m);
        campParts.outStones.setColorAt(i, _c.setHex(0x6e6862));
      }
      for (const m of h.logs) {
        const i = n.outLogs++;
        campParts.outLogs.setMatrixAt(i, m);
        campParts.outLogs.setColorAt(i, _c.setHex(0x5b4630));
      }
    }
    // As many granaries in each yard as stand in the core: the store decides both.
    for (let y = 0; y < yardsOf(camp); y++) {
      for (const s of camp.outer.yards[y].spots.slice(0, camp.storesUp || 0)) camp.outerStores.push(s);
    }
  }
  n.outStoreRoofs = n.outStores;
  campParts.stores.instanceMatrix.needsUpdate = true;
  campParts.storeRoofs.instanceMatrix.needsUpdate = true;
  for (const key in n) {
    const m = campParts[key];
    if (!m) continue;
    m.count = n[key];
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}

/* -------------------------------------------------------------------------
   What a larger place has

   A chiefdom has a hall — the chief's, a longhouse bigger than anybody's tent.
   A city has a market, stalls round a well where people come to deal, and a
   wall round the whole of it with a gate on each quarter. Each takes the next
   good spot out from the middle, in the same rings the outskirts use, so it
   cannot stand on a tent, the dead or the field; and the wall follows the edge
   of the settlement as it grows, leaving gaps where the ground is water. Nobody
   walks round it — there is nothing in this world that stops a person walking
   through a thing — but it is where the city ends.
   ------------------------------------------------------------------------- */
export const CIVIC = { hallAt: 2, marketAt: 4, wallAt: 4, stalls: 6, stallOut: 4.2, wallOut: 5, wallGap: 4.2, gate: 3.5 };
const STALL_COLOURS = [0xe8c07a, 0xc86a4a, 0x8fb0c8, 0xd9d2b8, 0x9cc27a, 0xd08ab0];
const CIVIC_KEYS = { civHall: 'hall', civStall: 'stall', civWell: 'well', civWall: 'wall', civTower: 'tower', civCityHall: 'cityhall' };
let civicShapes = null;
const civicMesh = (key) => (room) => {
  civicShapes ||= civicGeometries();
  const m = new THREE.InstancedMesh(civicShapes[CIVIC_KEYS[key]], tentMaterial, room);
  m.name = 'civic-' + CIVIC_KEYS[key];
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
};

function outerOf(camp) {
  if (!camp.outer || camp.outer.x !== camp.x || camp.outer.z !== camp.z) {
    camp.outer = { x: camp.x, z: camp.z, hearths: [], yards: [], seats: [], next: 0, done: false, civic: {} };
  }
  camp.outer.civic ||= {};
  return camp.outer;
}

/** The spot a camp's hall or market stands on: the next good one out, kept. */
export function claimCivic(camp, kind) {
  const o = outerOf(camp);
  if (kind in o.civic) return o.civic[kind];
  o.civic[kind] = null;
  while (!o.done) {
    const slot = o.next++;
    const spot = outerSlot(camp, slot);
    if (!spot) { o.done = true; break; }
    if (!outerGround(camp, spot.x, spot.z)) continue;
    o.civic[kind] = { x: spot.x, y: sampleHeight(spot.x, spot.z), z: spot.z,
      face: Math.atan2(camp.x - spot.x, camp.z - spot.z) };
    spread(camp, spot.x, spot.z, 9);
    break;
  }
  return o.civic[kind];
}

function place(x, z, turn, lift = 0) {
  _e.set(0, turn, 0); _q.setFromEuler(_e);
  _v.set(x, sampleHeight(x, z) - 0.05 + lift, z);
  _s.setScalar(1);
  return _m4.compose(_v, _q, _s).clone();
}

export function dressCivic() {
  if (!campParts?.huts) return;
  const halls = [], stalls = [], wells = [], walls = [], towers = [], cityHalls = [];
  for (const camp of camps) {
    if (camp.gone || !people.some((q) => q.camp === camp)) continue;
    const stage = camp.stage || 0;
    // The chief's hall, until the place is a city and its hall is the city's.
    if (stage >= CIVIC.hallAt && stage < CITY.at) {
      const h = claimCivic(camp, 'hall');
      if (h) halls.push({ at: place(h.x, h.z, h.face) });
    }
    /* A city has no fire: where it burned, in the middle of the plaza, the city
       hall stands, square to the streets. */
    if (stage >= CITY.at) {
      const th = camp.hearthTurn || 0;
      cityHalls.push({ at: place(camp.x, camp.z, Math.atan2(Math.cos(th), Math.sin(th))) });
    }
    if (stage >= CIVIC.marketAt) {
      const m = claimCivic(camp, 'market');
      if (m) {
        wells.push({ at: place(m.x, m.z, m.face) });
        for (let k = 0; k < CIVIC.stalls; k++) {
          const a = (k / CIVIC.stalls) * Math.PI * 2 + m.face;
          const x = m.x + Math.sin(a) * CIVIC.stallOut, z = m.z + Math.cos(a) * CIVIC.stallOut;
          stalls.push({ at: place(x, z, a + Math.PI), hex: STALL_COLOURS[k % STALL_COLOURS.length] });
        }
      }
    }
    if (stage >= CIVIC.wallAt) {
      const R = campReach(camp) + CIVIC.wallOut;
      const n = Math.ceil((2 * Math.PI * R) / CIVIC.wallGap);
      const half = CIVIC.gate / R;
      const gates = [0, 1, 2, 3].map((g) => (camp.hearthTurn || 0) + (g * Math.PI) / 2);
      const off = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2;
        if (gates.some((g) => off(a, g) < half)) continue;
        const x = camp.x + Math.cos(a) * R, z = camp.z + Math.sin(a) * R;
        if (sampleHeight(x, z) < SEA + 0.4) continue;
        walls.push({ at: place(x, z, -a - Math.PI / 2) });
      }
      for (const g of gates) {
        for (const side of [-1, 1]) {
          const a = g + side * (half + 0.9 / R);
          const x = camp.x + Math.cos(a) * R, z = camp.z + Math.sin(a) * R;
          if (sampleHeight(x, z) < SEA + 0.4) continue;
          towers.push({ at: place(x, z, -a - Math.PI / 2) });
        }
      }
    }
  }
  // A name and the list drawn under it, said to be a pair.
  for (const [key, list] of [['civHall', halls], ['civStall', stalls], ['civWell', wells], ['civWall', walls], ['civTower', towers],
    ['civCityHall', cityHalls]] as [string, any[]][]) {
    const m = packed(key, list.length, civicMesh(key));
    if (!m) continue;
    list.forEach((it, i) => {
      m.setMatrixAt(i, it.at);
      m.setColorAt(i, _c.setHex(it.hex ?? 0xffffff));
    });
    m.count = list.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
  layRoads();
}

/* -------------------------------------------------------------------------
   Roads

   A city paves its plaza and a street in front of every house, and the cross
   streets through them; and there is a road from every city to each village of
   its tribe, and between the cities — the shortest set of roads that joins all
   of them, so every city can be reached from every other. Laid into the ground
   the footpaths are worn into (paths.js), but as road: it never grows back,
   grass never comes up through it, and it has a colour of its own on the ground
   and on the map. Straight, and not across the water.

   Laid again only when something it depends on changes — a city grows, one is
   made or lost, a village changes hands — or the ground is thrown away.
   ------------------------------------------------------------------------- */
let roadsFor = '';
export function layRoads() {
  const cities = camps.filter((c) => !c.gone && (c.stage || 0) >= CITY.at && c.city && people.some((q) => q.camp === c));
  const key = pathEpoch + '#' + cities.map((c) => `${c.index}:${c.cityShown || 0}:`
    + camps.filter((v) => !v.gone && v !== c && v.code === c.code).map((v) => v.index).join('.')).join('|');
  if (key === roadsFor) return;
  roadsFor = key;
  // Four numbers — two ends of a road — spread into paveRoad, so: a tuple.
  const edge = (from, to): [number, number, number, number] => {
    // From the edge of one place to the edge of the other; inside, the streets.
    const dx = to.x - from.x, dz = to.z - from.z, d = Math.hypot(dx, dz) || 1;
    const a = Math.min(campReach(from), d / 2) / d, b = Math.min(campReach(to), d / 2) / d;
    return [from.x + dx * a, from.z + dz * a, to.x - dx * b, to.z - dz * b];
  };
  for (const c of cities) {
    paveDisc(c.x, c.z, CITY.plaza - 1);
    const th = c.hearthTurn || 0, ux = Math.cos(th), uz = Math.sin(th), vx = -uz, vz = ux;
    const at = (u, v): [number, number] => [c.x + ux * u + vx * v, c.z + uz * u + vz * v];
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (const h of c.city.homes.slice(0, c.cityShown)) {
      const street = h.v + h.side * 4.0;           // the middle of the street the house faces
      paveRoad(...at(h.u - CITY.along / 2, street), ...at(h.u + CITY.along / 2, street), 4.2);
      umin = Math.min(umin, h.u); umax = Math.max(umax, h.u);
      vmin = Math.min(vmin, street); vmax = Math.max(vmax, street);
    }
    for (let i = Math.floor(umin / CITY.along) - 1; umin <= umax && i <= Math.ceil(umax / CITY.along) + 1; i++) {
      if ((((i % (CITY.block + 1)) + CITY.block + 1) % (CITY.block + 1)) !== CITY.block) continue;
      paveRoad(...at(i * CITY.along, vmin), ...at(i * CITY.along, vmax), 4.2);
    }
    for (const v of camps) if (!v.gone && v !== c && v.code === c.code) paveRoad(...edge(c, v), 3.5);
  }
  // Between the cities, the shortest roads that join them all (Prim's).
  const joined = cities.slice(0, 1), left = cities.slice(1);
  while (left.length) {
    let best = null, near = Infinity;
    for (const a of joined) {
      for (const b of left) {
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < near) { near = d; best = [a, b]; }
      }
    }
    paveRoad(...edge(best[0], best[1]), 3.5);
    joined.push(best[1]);
    left.splice(left.indexOf(best[1]), 1);
  }
}
