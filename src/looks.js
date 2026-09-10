import * as THREE from 'three';

import { HUMAN_JOINTS, HUMAN_PARTS } from 'humans-threejs/human-parts.js';
import { CHIEF_BAND, CHIEF_CLOTH } from './people.js';
import { HIDDEN } from './world.js';

/* -------------------------------------------------------------------------
   Looks: everything humans-threejs dresses a body in

   human-parts.js is the body and nothing else. The rest of what the library
   can do — four builds, three faces, six ways of wearing hair, a hide tunic,
   baskets of food, a small animal carried in the arms, a pick and a knife —
   lives in its create-humans.js as code that builds geometry, and that code
   is ported here: the same shapes and the same numbers, moved from the model's
   standing space into the space of the joint each one hangs from. The head's
   things are measured off the head the rig actually draws, which matters: in
   the library's own v0.3 the eyes and mouth are a centimetre inside the head.

   The last two came in with farming: the library's basket of vegetables and
   its hoe, for whoever works a band's field (farming.js).

   How they are drawn is the part that is not the library's. Every person is in
   exactly one of eight tunics, one of five hairstyles or none, one of three
   faces, and at most one load and one tool — twenty-odd meshes where the body
   has a dozen. Drawn the way the body is, one slot per person in every mesh,
   the GPU would work through a tunic for every body in each of the seven
   tunics they are not wearing. So each of these meshes holds only the people
   wearing it: a list, packed from the front, that a person joins when they put
   something on and leaves when they take it off — the last in the list moving
   into the gap, so nothing is ever shuffled along.
   ------------------------------------------------------------------------- */

const J = HUMAN_JOINTS.male;
const HIP_Y = J.hip[1];                   // the torso's origin, in the model's standing space
const HEAD_BASE_Y = J.headBase[1];        // where the model hangs the head from
const HEAD_CENTRE_Y = J.headCentre[1];    // and where the rig holds it

export const BODY_BUILDS = ['slim', 'average', 'broad', 'full'];
export const FACES = ['soft', 'angular', 'wide'];
export const HAIRS = ['cropped', 'swept', 'bob', 'curls', 'long'];   // and bald, which is none

const smooth = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* The library's build: how much wider and deeper a body is at height y, in the
   model's standing space. Everything below the neck; the head is the head. */
export function buildAt(build, y) {
  const body = 1 - smooth(1.39, 1.52, y);
  const waist = Math.exp(-(((y - 1.10) / 0.23) ** 2));
  const shoulder = Math.exp(-(((y - 1.34) / 0.16) ** 2));
  let w = 1, d = 1;
  if (build === 'slim') { w -= 0.18 * body; d -= 0.19 * body; }
  if (build === 'broad') { w += body * (0.10 + 0.22 * shoulder); d += body * (0.09 + 0.12 * shoulder); }
  if (build === 'full') { w += body * (0.21 + 0.27 * waist); d += body * (0.25 + 0.40 * waist); }
  return [w, d];
}

/* The library stretches every vertex by its own height, which works on a body
   that stands still. This one bends: a thigh swinging forward has no single
   height. So each limb is widened by the stretch at its middle, measured
   standing, and the joints it hangs from move out with the torso around them —
   a full-bodied person's arms hang wider because their middle is. */
const MID = {
  thigh: J.hip[1] - J.lengths.thigh / 2,
  shin: J.knee[1] - J.lengths.calf / 2,
  foot: J.ankle[1] / 2,
  upperArm: J.shoulder[1] - J.lengths.upperArm / 2,
  foreArm: J.elbow[1] - J.lengths.forearm / 2,
  hand: J.wrist[1] - 0.045,
  neck: (J.neckBase[1] + J.headBase[1]) / 2,
};
export const BUILD_FIT = Object.fromEntries(BODY_BUILDS.map((build) => {
  const fit = { armX: buildAt(build, J.shoulder[1])[0], hipX: buildAt(build, J.hip[1])[0] };
  for (const [piece, y] of Object.entries(MID)) {
    const [w, d] = buildAt(build, y);
    fit[piece] = new THREE.Vector3(w, 1, d);
  }
  return [build, fit];
}));

/* ---- who somebody is to look at ---- */

function roll(p, salt) {
  let seed = typeof p.id === 'number' ? p.id : 0;
  if (typeof p.id !== 'number') {
    for (const ch of String(p.id ?? p.name ?? '')) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  }
  let n = Math.imul(seed + 1, 747796405) ^ salt;
  n = Math.imul(n ^ (n >>> 16), 2246822507);
  return ((n ^ (n >>> 13)) >>> 0) / 4294967296;
}

/* A build, a face and a way of wearing hair, drawn the way the library draws
   them — a quarter each of the builds, a third each of the faces, a woman's
   hair long three times in four — and drawn from their id, so they come back
   from a save looking like themselves without the save having to say so. */
export function lookOf(p) {
  if (p.look) return p.look;
  const r = roll(p, 7847);
  const hair = p.sex === 'f'
    ? (r < 0.75 ? 'long' : r < 0.90 ? 'bob' : r < 0.95 ? 'curls' : r < 0.98 ? 'swept' : r < 0.995 ? 'cropped' : 'bald')
    : ['cropped', 'swept', 'bob', 'curls', 'bald'][(r * 5) | 0];
  p.look = {
    build: BODY_BUILDS[(roll(p, 9173) * BODY_BUILDS.length) | 0],
    face: FACES[(roll(p, 3427) * FACES.length) | 0],
    hair,
  };
  return p.look;
}
export const fitOf = (p) => BUILD_FIT[lookOf(p).build];
export const tunicKey = (p, woman) => `tunic:${woman ? 'f' : 'm'}:${lookOf(p).build}`;
const leads = (p) => Boolean(p.camp && p.camp.chief === p.id);

/* What hangs off the head, and what is on it today. Nobody is bald as a
   child; the band round the brow is the chief's. */
export const HEAD_GROUPS = ['hair', 'face', 'band'];
export function headKey(p, group) {
  const look = lookOf(p);
  if (group === 'face') return 'face:' + look.face;
  if (group === 'band') return leads(p) ? 'band' : null;
  const hair = look.hair === 'bald' && p.child ? 'cropped' : look.hair;
  return hair === 'bald' ? null : 'hair:' + hair;
}

/* Food comes home as the library's cargo, heaped in the basket. A rabbit or a
   boar is carried whole, in the arms, the way the library carries its lamb; a
   deer or a bison is too big for that and comes home as meat. Stone, ore and
   wood are none of the library's and are not dressed here. */
export function cargoKey(kind, bag) {
  if (kind === 'fruit' || kind === 'berries' || kind === 'fish') return 'cargo:' + kind;
  if (kind === 'vegetables') return 'cargo:vegetables';
  if (kind === 'game') return bag?.animal === 'rabbit' || bag?.animal === 'boar' ? 'cargo:animal' : 'cargo:meat';
  return null;
}
export const animalSize = (bag) => (bag?.animal === 'rabbit' ? 0.5 : 1);
const ANIMAL_COLOUR = { rabbit: 0x9c8c76, boar: 0x5e4636 };
const BERRIES = 0x6a3450;          // the fruit heap, darkened: a basket of berries
const GREYING = new THREE.Color(0xb38a60);

/* ---- colour ---- */

const _col = new THREE.Color();

/* Hair is lighter in childhood and lightens again with age — the library's
   curve — on top of the colour a person was born with. */
function hairColour(p) {
  const age = p.years ?? 30;
  const t = 0.32 * (1 - smooth(5, 22, age)) + 0.42 * smooth(45, 100, age);
  return _col.setHex(p.hairColor ?? 0x2b1d14).lerp(GREYING, t);
}

function colourFor(p, group, key) {
  if (group === 'tunic') {
    return leads(p) ? _col.setHex(CHIEF_CLOTH) : _col.setHex(p.garment).multiplyScalar(p.garmentShade ?? 1);
  }
  if (group === 'hair') return hairColour(p);
  // The face is its marks, dark, and a nose and ears in whatever skin it is on.
  if (group === 'face') return _col.setHex(p.skin).multiplyScalar(p.skinShade ?? 1);
  if (group === 'band') return _col.setHex(CHIEF_BAND);
  if (key === 'cargo:berries') return _col.setHex(BERRIES);
  if (key === 'cargo:animal') return _col.setHex(ANIMAL_COLOUR[p.bag?.animal] ?? 0x8a7a66);
  return _col.setHex(0xffffff);
}

/* ---- the meshes, and who is in them ---- */

export let looks = null;
let lookGroup = null;

/* Put something on, or take it off with null. Returns what they are wearing,
   which is what the caller draws. Cheap when nothing changes, which is nearly
   every call: it is asked every frame for everybody on screen. */
export function wear(p, group, key) {
  const worn = p.worn || (p.worn = {});
  const was = worn[group] || null;
  if (was === key) return key;
  if (was) takeOff(p, group);
  if (key) {
    const m = looks[key], who = m.userData.who;
    const at = who.length;
    who.push(p);
    m.count = who.length;
    worn[group] = key;
    (p.wornAt || (p.wornAt = {}))[group] = at;
    m.setMatrixAt(at, HIDDEN);          // until whoever called this places it
    m.setColorAt(at, colourFor(p, group, key));
    m.instanceColor.needsUpdate = true;
  }
  return key;
}

function takeOff(p, group) {
  const m = looks[p.worn[group]], who = m.userData.who;
  const at = p.wornAt[group], last = who.length - 1;
  if (at !== last) {
    const q = who[last];
    who[at] = q;
    q.wornAt[group] = at;
    m.instanceMatrix.array.copyWithin(at * 16, last * 16, last * 16 + 16);
    m.instanceColor.array.copyWithin(at * 3, last * 3, last * 3 + 3);
    m.instanceColor.needsUpdate = true;
  }
  who.pop();
  m.count = who.length;
  p.worn[group] = null;
}

/** Out of sight: nothing on, so nothing of theirs is drawn at all. */
export function undress(p) {
  if (!looks || !p.worn) return;
  for (const group in p.worn) if (p.worn[group]) takeOff(p, group);
}

/* The band changed, so everybody's place in every list may be somebody else's
   now. Everything off; whoever is drawn next frame puts it back on, in the
   colours they have today — which is also how a new chief comes to be in
   ochre and an old one's hair comes to be grey. */
export function undressAll(people) {
  if (!looks) return;
  for (const key in looks) {
    looks[key].userData.who.length = 0;
    looks[key].count = 0;
  }
  for (const p of people) { p.worn = null; p.wornAt = null; }
}

export function flushLooks() {
  if (!looks) return;
  for (const key in looks) looks[key].instanceMatrix.needsUpdate = true;
}

const detailMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
/* A hide is a shell open at the neck and the hem, so the inside shows. */
const clothMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide });

export function buildLooks(group, capacity) {
  clearLooks();
  looks = {};
  lookGroup = group;
  for (const [key, spec] of Object.entries(lookGeometries())) {
    const m = new THREE.InstancedMesh(spec.geo, spec.cloth ? clothMaterial : detailMaterial, capacity);
    m.name = 'look-' + key;
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = spec.shadow;
    m.receiveShadow = true;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, _col.setHex(0xffffff));
    m.userData.who = [];
    group.add(m);
    looks[key] = m;
  }
}

/* Room for more, the way growPeople makes it for the body: bigger meshes with
   everything already in them copied across, and the lists carried over. */
export function growLooks(room) {
  if (!looks) return;
  for (const key in looks) {
    const old = looks[key];
    if (old.instanceMatrix.count >= room) continue;
    const m = new THREE.InstancedMesh(old.geometry, old.material, room);
    m.name = old.name;
    m.castShadow = old.castShadow;
    m.receiveShadow = old.receiveShadow;
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceMatrix.array.set(old.instanceMatrix.array);
    m.setColorAt(0, _col.setHex(0xffffff));
    m.instanceColor.array.set(old.instanceColor.array);
    m.count = old.count;
    m.userData.who = old.userData.who;
    lookGroup.remove(old);
    old.dispose();
    lookGroup.add(m);
    looks[key] = m;
  }
}

export function clearLooks() {
  if (!looks) return;
  const geometries = new Set();
  for (const key in looks) {
    lookGroup?.remove(looks[key]);
    geometries.add(looks[key].geometry);
    looks[key].dispose();
  }
  for (const g of geometries) g.dispose();
  looks = null;
}

/* ---- the shapes ---- */

const box = (x, y, z, w, h, d) => new THREE.BoxGeometry(w, h, d).toNonIndexed().translate(x, y, z);
const ball = (x, y, z, w, h, d, seg = 8, rings = 5) =>
  new THREE.SphereGeometry(1, seg, rings).toNonIndexed().scale(w, h, d).translate(x, y, z);
function painted(g, hex) {
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
/* One geometry out of several, keeping their colours — white where a part has
   none, so the instance's own colour shows through it untouched. */
function merge(parts) {
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3).fill(1);
  let o = 0;
  for (const g of parts) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, c * 3), o * 3);
    nor.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    if (g.attributes.color) col.set(g.attributes.color.array.subarray(0, c * 3), o * 3);
    o += c;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}
const hash01 = (i) => {
  let n = Math.imul(i + 1, 747796405) ^ 7123;
  n = Math.imul(n ^ (n >>> 16), 2246822507);
  return ((n ^ (n >>> 13)) >>> 0) / 4294967296;
};

/* Where the head's surface is, found on the head that is drawn rather than
   assumed: the model's y and the x (or z) across it, and how far out the
   surface is along the other axis. A ray through its triangles, which are few. */
function headOut(across, yModel, alongX) {
  const a = HUMAN_PARTS.head.positions, y = yModel - HEAD_BASE_Y;
  const u = alongX ? 2 : 0, out = alongX ? 0 : 2;
  let best = 0;
  for (let t = 0; t < a.length; t += 9) {
    const u0 = a[t + u], v0 = a[t + 1], u1 = a[t + 3 + u], v1 = a[t + 4], u2 = a[t + 6 + u], v2 = a[t + 7];
    const d = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(d) < 1e-12) continue;
    const l0 = ((v1 - v2) * (across - u2) + (u2 - u1) * (y - v2)) / d;
    const l1 = ((v2 - v0) * (across - u2) + (u0 - u2) * (y - v2)) / d;
    const l2 = 1 - l0 - l1;
    if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
    best = Math.max(best, l0 * a[t + out] + l1 * a[t + 3 + out] + l2 * a[t + 6 + out]);
  }
  return best;
}
const headFront = (x, y) => headOut(x, y, false);
const headSide = (z, y) => headOut(z, y, true);

const MARK = 0x2a1f1a;
function faceGeo(type) {
  const spread = type === 'wide' ? 0.039 : type === 'soft' ? 0.029 : 0.032;
  const eyeHeight = type === 'soft' ? 0.011 : 0.008;
  const on = (x, y, depth) => headFront(x, y) + depth * 0.25;   // proud of the skin, not in it
  const parts = [];
  for (const s of [-1, 1]) {
    parts.push(painted(box(s * spread, 1.634, on(s * spread, 1.634, 0.008), 0.014, eyeHeight, 0.008), MARK));
    parts.push(painted(box(s * spread, 1.658, on(s * spread, 1.658, 0.006), 0.022, 0.004, 0.006), MARK));
  }
  parts.push(painted(box(0, 1.563, on(0, 1.563, 0.007), type === 'wide' ? 0.033 : 0.026, 0.004, 0.007), MARK));
  // A nose, and ears on the sides: the part of a face that is skin.
  const nw = type === 'angular' ? 0.014 : 0.012, nd = type === 'angular' ? 0.023 : 0.017;
  parts.push(ball(0, 1.601, headFront(0, 1.601) + nd * 0.35, nw, 0.023, nd, 6, 4));
  const ear = headSide(0, 1.617) + 0.004;
  for (const s of [-1, 1]) parts.push(ball(s * ear, 1.617, 0, 0.016, 0.027, 0.018, 6, 4));
  return merge(parts).translate(0, -HEAD_CENTRE_Y, 0);
}

function hairGeo(type) {
  const cap = new THREE.SphereGeometry(1, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
  cap.scale(0.098, 0.078, 0.091).translate(0, 1.685, 0);
  const parts = [cap];
  if (type === 'cropped') parts.push(box(0, 1.672, -0.059, 0.138, 0.052, 0.046));
  if (type === 'swept') parts.push(box(-0.025, 1.689, 0.062, 0.114, 0.043, 0.045), box(0, 1.65, -0.058, 0.145, 0.10, 0.052));
  if (type === 'bob') {
    parts.push(box(0, 1.601, -0.060, 0.181, 0.19, 0.056),
      box(-0.082, 1.608, 0, 0.032, 0.18, 0.13), box(0.082, 1.608, 0, 0.032, 0.18, 0.13));
  }
  if (type === 'long') {
    // Behind the shoulders, with two narrower lengths falling in front.
    parts.push(box(0, 1.47, -0.077, 0.19, 0.40, 0.056),
      box(-0.085, 1.525, -0.01, 0.034, 0.32, 0.105), box(0.085, 1.525, -0.01, 0.034, 0.32, 0.105),
      box(-0.105, 1.38, 0.066, 0.035, 0.18, 0.036), box(0.105, 1.38, 0.066, 0.035, 0.18, 0.036));
  }
  if (type === 'curls') {
    for (let i = 0; i < 9; i++) {
      const a = (i * Math.PI * 2) / 9;
      parts.push(ball(Math.cos(a) * 0.078, 1.697 + Math.sin(i * 2) * 0.012, Math.sin(a) * 0.073, 0.034, 0.035, 0.033));
    }
    parts.push(ball(0, 1.757, 0, 0.066, 0.035, 0.061));
  }
  return merge(parts).translate(0, -HEAD_CENTRE_Y, 0);
}

/* The chief's band: a ring round the brow, below where the hair starts. */
function bandGeo() {
  const y = 1.66;
  const g = new THREE.TorusGeometry(1, 0.1, 4, 18).toNonIndexed().rotateX(Math.PI / 2);
  g.scale(headSide(0, y), 0.09, headFront(0, y)).translate(0, y - HEAD_CENTRE_Y, 0);
  return merge([g]);
}

/* The torso's own rings, read off the model: height, half-width, half-depth,
   and how far forward the ring sits — a woman's chest ring is. */
function torsoRings(key) {
  const a = HUMAN_PARTS[key].positions, by = new Map();
  for (let i = 0; i < a.length; i += 3) {
    const y = a[i + 1].toFixed(4);
    const r = by.get(y) || { x: 0, lo: Infinity, hi: -Infinity };
    r.x = Math.max(r.x, Math.abs(a[i]));
    r.lo = Math.min(r.lo, a[i + 2]);
    r.hi = Math.max(r.hi, a[i + 2]);
    by.set(y, r);
  }
  return [...by].map(([y, r]) => ({ y: Number(y), rx: r.x, rz: (r.hi - r.lo) / 2, cz: (r.hi + r.lo) / 2 }))
    .sort((p, q) => p.y - q.y);
}

/* The hide, cut to the torso it is on. The library's is one shell for both
   sexes and hangs to mid-thigh; this one follows the model's own torso rings
   with a little room — so a woman's shows her chest and a full build its belly
   — and stops a hand below the hip, because these legs swing and sit and a
   rigid skirt to the knee would have them through it at every step. The hem is
   the library's, ragged; the tone of each panel varies, as a hide does. */
const HEM = [0, 0.023, -0.029, 0.013, -0.017, 0.035];
function tunicGeo(sex, build) {
  const torso = torsoRings(sex === 'f' ? 'torsoFemale' : 'torsoMale');
  const first = torso[0], top = torso[torso.length - 1];
  const rings = [
    { y: first.y - 0.035, rx: first.rx * 1.25 + 0.01, rz: first.rz * 1.35 + 0.01, cz: 0, hem: true },
    ...torso.map((r) => ({ y: r.y, rx: r.rx * 1.08 + 0.012, rz: r.rz * 1.10 + 0.012, cz: r.cz })),
    { y: top.y + 0.02, rx: 0.069, rz: 0.064, cz: 0 },           // the neckline
  ];
  const n = 12, pts = [], tints = [];
  const point = (r, k) => {
    const ring = rings[r], a = (2 * Math.PI * (k % n)) / n;
    const y = ring.y + (ring.hem ? HEM[k % 6] : 0);
    const [w, d] = buildAt(build, y + HIP_Y);
    return [Math.cos(a) * ring.rx * w, y, (Math.sin(a) * ring.rz + ring.cz) * d];
  };
  let panel = 0;
  for (let r = 0; r < rings.length - 1; r++) {
    for (let k = 0; k < n; k++) {
      const a = point(r, k), b = point(r + 1, k), c = point(r + 1, k + 1), d = point(r, k + 1);
      const tone = 0.85 + hash01(panel++) * 0.15;
      for (const v of [a, b, c, a, c, d]) { pts.push(...v); tints.push(tone, tone * 0.98, tone * 0.94); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(tints, 3));
  g.computeVertexNormals();
  return g;
}

/* The library's cargo, without its box of a basket: the heap goes on the rim of
   the basket this world already carries, narrowed to fit it. Its space is the
   rim's centre. */
const RIM = [0, 1.147, 0.43];
function heap(parts) {
  return merge(parts).translate(-RIM[0], -RIM[1], -RIM[2]).scale(0.76, 1, 1);
}
function cargoFruit() {
  const parts = [];
  for (let i = 0; i < 8; i++) {
    parts.push(painted(ball((i % 4 - 1.5) * 0.105, 1.17 + Math.floor(i / 4) * 0.012, 0.37 + Math.floor(i / 4) * 0.12, 0.053, 0.051, 0.05),
      [0xb4432d, 0xd9a23b, 0x739249][i % 3]));
  }
  return heap(parts);
}
function cargoMeat() {
  // Cuts, their pale fat, and a joint on the bone.
  return heap([
    painted(ball(-0.10, 1.18, 0.43, 0.092, 0.048, 0.08), 0x9a493c), painted(ball(0.08, 1.18, 0.44, 0.10, 0.057, 0.078), 0xa95a48),
    painted(box(-0.10, 1.221, 0.43, 0.115, 0.01, 0.023), 0xdebda1),
    painted(box(0.15, 1.20, 0.36, 0.13, 0.022, 0.025), 0xead7b5), painted(ball(0.217, 1.20, 0.36, 0.021, 0.021, 0.023), 0xead7b5),
  ]);
}
function cargoFish() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const z = 0.345 + i * 0.086, y = 1.17 + (i % 2) * 0.016;
    parts.push(painted(ball(-0.015, y, z, 0.155, 0.037, 0.035), [0x718b86, 0x8e9b96, 0x647e89][i]));
    const tail = new THREE.ConeGeometry(0.046, 0.083, 3).toNonIndexed().rotateZ(-Math.PI / 2).translate(-0.174, y, z);
    parts.push(painted(tail, 0x546e71));
    parts.push(painted(ball(0.11, y + 0.025, z + 0.014, 0.008, 0.007, 0.007), 0x202b2c));
    parts.push(painted(box(-0.005, y + 0.031, z, 0.13, 0.008, 0.012), 0xaebbb3));
  }
  return heap(parts);
}
// Roots, greens and a carrot, off the field.
function cargoVegetables() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push(painted(ball((i - 1.5) * 0.105, 1.16, 0.43, 0.048, 0.052, 0.085), 0x55753a));
    parts.push(painted(ball((i - 1.5) * 0.105, 1.22, 0.46, 0.06, 0.07, 0.025), 0x729548));
  }
  parts.push(painted(box(0.06, 1.19, 0.34, 0.19, 0.025, 0.027), 0xc88135));
  return heap(parts);
}
/* The library's lamb, held level in front: body, head, four legs, ears, an eye
   and a muzzle. Pale, so the instance's colour makes it a rabbit or a boar. */
function cargoAnimal() {
  const parts = [ball(0, 1.12, 0.43, 0.235, 0.125, 0.12), ball(0.225, 1.20, 0.43, 0.09, 0.10, 0.073)];
  for (const x of [-0.14, 0.13]) for (const z of [0.37, 0.49]) parts.push(painted(box(x, 0.975, z, 0.032, 0.15, 0.032), 0xb59b7c));
  parts.push(ball(0.235, 1.245, 0.335, 0.06, 0.018, 0.04), ball(0.235, 1.245, 0.525, 0.06, 0.018, 0.04));
  parts.push(painted(ball(0.269, 1.217, 0.491, 0.009, 0.009, 0.009), 0x29251f), painted(ball(0.283, 1.173, 0.452, 0.032, 0.025, 0.028), 0x9a8470));
  return merge(parts).translate(0, -1.12, -0.43);
}

/* Tools in the hand's own space. The library places them at its right hand's
   grip, standing; here that grip is the middle of a closed fist, just below the
   wrist the hand hangs from. */
const GRIP = [0.267, 0.79, 0.018], FIST_Y = -0.05;
const inHand = (parts) => merge(parts).translate(-GRIP[0], -GRIP[1] + FIST_Y, -GRIP[2]);
const knifeGeo = () => inHand([
  painted(box(0.267, 0.76, 0.018, 0.035, 0.13, 0.035), 0x5b402d), painted(box(0.267, 0.665, 0.018, 0.075, 0.09, 0.014), 0xa3a7a0),
]);
const hoeGeo = () => inHand([
  painted(box(0.267, 0.55, 0.018, 0.033, 0.62, 0.033), 0x705133), painted(box(0.267, 0.25, 0.072, 0.16, 0.035, 0.15), 0x777c7a),
]);
const pickaxeGeo = () => inHand([
  painted(box(0.267, 0.60, 0.018, 0.033, 0.49, 0.033), 0x705133), painted(box(0.267, 0.38, 0.018, 0.33, 0.046, 0.044), 0x777c7a),
]);

function lookGeometries() {
  const out = {};
  for (const sex of ['m', 'f']) {
    for (const build of BODY_BUILDS) out[`tunic:${sex}:${build}`] = { geo: tunicGeo(sex, build), cloth: true, shadow: true };
  }
  for (const type of HAIRS) out['hair:' + type] = { geo: hairGeo(type), shadow: true };
  for (const type of FACES) out['face:' + type] = { geo: faceGeo(type), shadow: false };
  out.band = { geo: bandGeo(), shadow: false };
  const fruit = cargoFruit();
  out['cargo:fruit'] = { geo: fruit, shadow: true };
  out['cargo:berries'] = { geo: fruit, shadow: true };      // the same heap, darker
  out['cargo:fish'] = { geo: cargoFish(), shadow: true };
  out['cargo:meat'] = { geo: cargoMeat(), shadow: true };
  out['cargo:animal'] = { geo: cargoAnimal(), shadow: true };
  out['cargo:vegetables'] = { geo: cargoVegetables(), shadow: true };
  out['tool:knife'] = { geo: knifeGeo(), shadow: true };
  out['tool:pickaxe'] = { geo: pickaxeGeo(), shadow: true };
  out['tool:hoe'] = { geo: hoeGeo(), shadow: true };
  return out;
}
