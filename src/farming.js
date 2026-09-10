import * as THREE from 'three';

import { P, SEA } from './params.js';
import { flatnessAt, mulberry32, sampleHeight } from './noise.js';
import { forageSeason } from './scene.js';
import { HIDDEN } from './world.js';
import { streams } from './creeks.js';
import { luck } from './clock.js';
import { CAMP_CLEARING, CAMP_PIECES, camps, dressCamp, joinGeometries, people } from './people.js';
import { practise } from './skills.js';
import { BAG, bagAdd } from './bag.js';
import { logEvent } from './life.js';

/* -------------------------------------------------------------------------
   Fields and flocks

   Everything else a band eats it finds: berries on the hillside, fruit on the
   tree, a deer, a fish. This is the first food anybody on the island makes.

   It comes in two steps and the order is the point. Nothing is sown until a
   band can get water onto the ground, so the first seasons at a field are
   ditches and carrying, and teach `irrigation`. Only past a fair hand at that
   does working the field teach `farming` and bring a crop home. And past a
   fair hand at farming a band pens a pair of animals off the hill, which grow
   into a flock that gives the store a little every day — winter included,
   which is the whole of what makes it security rather than more foraging.

   The field is on the bank of the nearest creek when there is one within
   walking distance, and watered from it. A band with no creek near waters by
   hand, and gets rather less for it.

   Nothing here runs while a module is loading: `people.js` imports this back,
   so every count it needs is read off CAMP_PIECES inside a function.
   ------------------------------------------------------------------------- */
export const FARM = {
  irrigateFirst: 0.5,  // irrigation a band needs before anything is sown
  perDitch: 0.03,      // irrigation learned by a session of digging and carrying water
  perField: 0.026,     // farming learned by a session in the field
  crop: 0.9,           // food a session brings home at mastery, on watered ground
  dry: 0.55,           // share of that from a field watered by hand
  waterReach: 160,     // metres to a creek for a field to be watered from it
  chance: 0.32,        // how often somebody goes to the field, before hunger
  stockFrom: 0.5,      // farming at which a band pens its first animals
  stockMax: 12,        // head a band at mastery keeps; the pen has room for this many
  stockGrow: 0.08,     // share a flock grows by in a sim-day, while there is room
  milk: 0.2,           // food one head gives the store in a sim-day
  fullBand: 30,        // a band this big works the whole field its farming allows
};

/* The field's shape. It grows both ways — more rows across, and longer rows —
   so a band of five that has just learned works a patch, and a village of
   thirty at mastery works a field some thirty metres by twenty-five. */
export const FIELD = {
  spacing: 1.6,        // metres between rows
  minLen: 9.5,         // a row when the field is new: the length of the ridge geometry
  maxLen: 26,          // and at its longest
  step: 1.4,           // metres between plants along a row
};

/** A band's field: found once, off the camp's own stream, and kept. */
export function fieldOf(camp) {
  if (camp.field) return camp.field;
  let creek = null, near = FARM.waterReach;
  for (const path of streams) {
    for (const q of path) {
      const d = Math.hypot(q.x - camp.x, q.z - camp.z);
      if (d < near && d > CAMP_CLEARING) { near = d; creek = q; }
    }
  }
  let spot = null;
  // On the bank, a few metres back from the water toward the camp.
  if (creek) {
    const a = Math.atan2(camp.z - creek.z, camp.x - creek.x);
    for (let back = 7; back < 30 && !spot; back += 3) {
      const x = creek.x + Math.cos(a) * back, z = creek.z + Math.sin(a) * back;
      if (sampleHeight(x, z) > SEA + 1.5 && flatnessAt(x, z) > 0.8) spot = { x, z, a, wet: true };
    }
  }
  // No creek in reach: flat ground just past the clearing, watered by hand.
  const rng = mulberry32(((camp.index + 1) * 4219) ^ (P.seed | 0));
  for (let t = 0; t < 60 && !spot; t++) {
    const a = rng() * Math.PI * 2, r = CAMP_CLEARING + 10 + rng() * 14;
    const x = camp.x + Math.cos(a) * r, z = camp.z + Math.sin(a) * r;
    if (sampleHeight(x, z) > SEA + 1.5 && flatnessAt(x, z) > 0.85) spot = { x, z, a, wet: false };
  }
  if (!spot) spot = { x: camp.x - (CAMP_CLEARING + 12), z: camp.z, a: 0, wet: false };
  spot.y = sampleHeight(spot.x, spot.z);
  return (camp.field = spot);
}

/* How much somebody wants to go to the field. Learning it is a thing a fed
   band has time for; once the field pays, a hungry band goes to it. */
export function farmWeight(p, hunger, rested) {
  if (p.child) return 0;
  const skill = p.camp.skill.farming || 0;
  const pull = skill < 0.1 ? 1 - hunger : 0.5 + 0.9 * hunger * skill;
  return FARM.chance * pull * rested;
}

/* How big a band's field is now: wider and longer with how well it farms and
   how many mouths it has to feed. Nothing until it has dug. */
export function fieldSize(camp) {
  const irrigation = camp.skill?.irrigation || 0, farming = camp.skill?.farming || 0;
  if (irrigation < 0.1) return { rows: 0, len: 0, perRow: 0, grown: 0 };
  const band = Math.min(1, Math.max(0.35, (camp.pop || 0) / FARM.fullBand));
  const size = Math.min(1, Math.max(0.1, Math.max(irrigation * 0.25, farming) * band));
  const most = CAMP_PIECES.crops / CAMP_PIECES.rows;
  const rows = Math.max(2, Math.round(CAMP_PIECES.rows * size));
  const len = FIELD.minLen + (FIELD.maxLen - FIELD.minLen) * size;
  const perRow = Math.min(most, Math.max(1, Math.floor(len / FIELD.step)));
  return { rows, len, perRow, grown: Math.min(1, farming * 1.25) };
}

/** Somewhere along the rows, as far as the field reaches. */
export function farmSite(p) {
  const f = fieldOf(p.camp), size = fieldSize(p.camp);
  const along = (luck() - 0.5) * Math.max(size.len, 9);
  const across = (luck() - 0.5) * Math.max(size.rows, 2) * FIELD.spacing;
  const ca = Math.cos(f.a), sa = Math.sin(f.a);
  p.targetX = f.x + ca * along - sa * across;
  p.targetZ = f.z + sa * along + ca * across;
  return true;
}

/* A session at the field. Ditches and water until the band can irrigate —
   then a crop, which follows the season like everything else that grows, and
   the island's ABUNDANCE like every other food. */
export function farmDone(p) {
  const camp = p.camp, f = fieldOf(camp);
  const size = fieldSize(camp);
  const reach = Math.max(14, size.len / 2 + (size.rows * FIELD.spacing) / 2 + 4);
  if (Math.hypot(p.x - f.x, p.z - f.z) > reach) return;     // gave up on the way
  const learning = (camp.skill.irrigation || 0) < FARM.irrigateFirst;
  practise(camp, 'irrigation', learning ? FARM.perDitch : FARM.perDitch * 0.25);
  p.knows.irrigation = Math.max(p.knows.irrigation || 0, camp.skill.irrigation);
  if (learning) return;
  practise(camp, 'farming', FARM.perField);
  p.knows.farming = Math.max(p.knows.farming || 0, camp.skill.farming);
  const got = FARM.crop * (0.3 + 0.7 * camp.skill.farming) * (f.wet ? 1 : FARM.dry)
    * forageSeason * P.abundance;
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
const EARTH = 0x5b4a35, SHOOT = 0x5f8f3a, POST = 0x6b5334, FLEECE = 0xe4dccb;

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

/* As far as the band has got: ridges once it has dug, a field growing wider
   and longer as the band learns and grows, green on the rows as it farms, and
   a pen with as many head as it keeps. Nothing is planted in the creek or on
   the camp's trampled ground, whatever size the field has reached. */
export function dressField(camp, parts, index) {
  if (!parts.rows) return;
  const n = CAMP_PIECES, f = fieldOf(camp), size = fieldSize(camp), most = n.crops / n.rows;
  const ca = Math.cos(f.a), sa = Math.sin(f.a);
  const spot = (along, across) => [f.x + ca * along - sa * across, f.z + sa * along + ca * across];
  const growable = (x, z) => sampleHeight(x, z) > SEA + 0.6 && Math.hypot(x - camp.x, z - camp.z) > CAMP_CLEARING;
  const put = (mesh, slot, x, z, yaw, sx, sy, sz, hex) => {
    _v.set(x, sampleHeight(x, z), z);
    _e.set(0, yaw, 0);
    _q.setFromEuler(_e);
    _s.set(sx, sy, sz);
    mesh.setMatrixAt(slot, _m.compose(_v, _q, _s));
    mesh.setColorAt(slot, _c.setHex(hex));
  };
  const shoots = Math.round(size.perRow * size.grown);
  for (let r = 0; r < n.rows; r++) {
    const across = (r - (size.rows - 1) / 2) * FIELD.spacing;
    const [rx, rz] = spot(0, across);
    const on = r < size.rows && growable(rx, rz);
    // The ridge is the geometry's length at its shortest, stretched along the row.
    if (on) put(parts.rows, index * n.rows + r, rx, rz, -f.a, size.len / FIELD.minLen, 1, 1, EARTH);
    else parts.rows.setMatrixAt(index * n.rows + r, HIDDEN);
    for (let k = 0; k < most; k++) {
      const slot = index * n.crops + r * most + k;
      const [cx, cz] = spot((k - (size.perRow - 1) / 2) * FIELD.step, across);
      if (on && k < shoots && growable(cx, cz)) {
        const sc = 0.8 + (((r * most + k) * 37) % 10) / 25;
        put(parts.crops, slot, cx, cz, k * 1.3, sc, sc, sc, SHOOT);
      } else parts.crops.setMatrixAt(slot, HIDDEN);
    }
  }
  const stock = Math.round(camp.stock || 0);
  const beside = (size.rows / 2) * FIELD.spacing + 5.5;
  for (let i = 0; i < n.pen; i++) {
    const a = (i / n.pen) * Math.PI * 2;
    const [x, z] = spot(Math.cos(a) * 3.4, beside + Math.sin(a) * 3.4);
    if (stock > 0) put(parts.pen, index * n.pen + i, x, z, 0, 1, 1, 1, POST);
    else parts.pen.setMatrixAt(index * n.pen + i, HIDDEN);
  }
  for (let i = 0; i < n.sheep; i++) {
    // Spread round the pen, and the same place each time it is dressed.
    const a = i * 2.39996, r = Math.min(2.6, 0.7 + ((i * 53) % 17) / 10);
    const [x, z] = spot(Math.cos(a) * r, beside + Math.sin(a) * r);
    if (i < stock) put(parts.sheep, index * n.sheep + i, x, z, a * 2, 1, 1, 1, FLEECE);
    else parts.sheep.setMatrixAt(index * n.sheep + i, HIDDEN);
  }
  for (const key of ['rows', 'crops', 'pen', 'sheep']) {
    const m = parts[key];
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    // Only as far as the bands there are: the rest of the room is for bands not yet founded.
    m.count = Math.min(m.instanceMatrix.count, camps.length * n[key]);
  }
}
