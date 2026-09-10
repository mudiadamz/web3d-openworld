import * as THREE from 'three';

/* -------------------------------------------------------------------------
   How a band builds

   `building` is the village-keeping skill, and what it shows is the tents. A
   band starts with the cone of hides it has always had; a band that knows what
   it is doing puts its hides on longer poles that cross out of the top and
   hangs a door flap; one better than that paints bands round them; and a band
   at real skill builds lodges — a round wall of daub under a thatched cone
   with a finial on it. One kind of tent per band, the kind its skill has got to.

   Coloured in the geometry itself, because a painted band on a tent is two
   colours on one instance and an instance has one. The instance colour is kept
   pale and only tints it, so the paint stays paint.

   No imports from the rest of the page: people.js imports this, and a module
   that only builds geometry has no business in the middle of that cycle.
   ------------------------------------------------------------------------- */

/* The meshes, one per kind, in the order a band climbs them. `huts` is the
   plain cone people.js has always built. */
export const TENT_KEYS = ['huts', 'tentHide', 'tentPainted', 'lodge'];

export function tentStyle(camp) {
  /* Past the tents, what a settlement has become decides it (society.js): a
     village builds houses, a city builds in brick. Below that it is how well
     the band builds. */
  const stage = camp.stage || 0;
  if (stage >= 4) return 'townhouse';
  if (stage >= 3) return 'house';
  const b = camp.skill?.building || 0;
  return b >= 0.75 ? 'lodge' : b >= 0.5 ? 'tentPainted' : b >= 0.25 ? 'tentHide' : 'huts';
}

export const tentMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

const HIDE = 0xb89a78, POLE = 0x5b4230, DOOR = 0x2e241b;
const OCHRE = 0xd08a3a, RED = 0x8a2f24, DAUB = 0xcbb28c, THATCH = 0x8a7442, FINIAL = 0x6b4a2e;

function painted(g, hex) {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex), n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// Position, normal and colour, and nothing else: parts disagree about uvs.
function merged(parts) {
  const total = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let at = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, at * 3);
    nor.set(g.attributes.normal.array, at * 3);
    col.set(g.attributes.color.array, at * 3);
    at += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/* A hide cone on long poles that cross out of the top, and a door flap. */
function hideTent(bands) {
  const R = 2.0, H = 2.9;
  const parts = [painted(new THREE.ConeGeometry(R, H, 9).translate(0, H / 2, 0), HIDE)];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    const pole = new THREE.CylinderGeometry(0.035, 0.05, 1.1, 5)
      .translate(0, 0.55, 0).rotateZ(0.32).rotateY(a).translate(0, H - 0.25, 0);
    parts.push(painted(pole, POLE));
  }
  parts.push(painted(new THREE.BoxGeometry(0.7, 1.15, 0.06).translate(0, 0.58, R * 0.62).rotateX(-0.36), DOOR));
  // Painted rings round the hide, standing just proud of it.
  const r = (y) => R * (1 - y / H) + 0.03;
  for (const [y0, y1, hex] of bands) {
    parts.push(painted(new THREE.CylinderGeometry(r(y1), r(y0), y1 - y0, 9, 1, true).translate(0, (y0 + y1) / 2, 0), hex));
  }
  return merged(parts);
}

/* A round wall of daub under a thatched cone, a finial, and a doorway. */
function lodge() {
  return merged([
    painted(new THREE.CylinderGeometry(1.9, 2.0, 1.3, 12).translate(0, 0.65, 0), DAUB),
    painted(new THREE.ConeGeometry(2.45, 1.8, 12).translate(0, 1.3 + 0.9, 0), THATCH),
    painted(new THREE.ConeGeometry(0.16, 0.55, 5).translate(0, 3.1 + 0.27, 0), FINIAL),
    painted(new THREE.BoxGeometry(0.75, 1.05, 0.1).translate(0, 0.53, 1.95), DOOR),
  ]);
}

export function tentGeometries() {
  return {
    tentHide: hideTent([]),
    tentPainted: hideTent([[0.65, 0.92, OCHRE], [1.45, 1.62, RED]]),
    lodge: lodge(),
  };
}

/* -------------------------------------------------------------------------
   Houses, and what a city builds

   A village stops living in tents: a timber frame walled in wattle and daub
   under a hipped thatch, on the spot its tent stood on. A city builds in brick —
   two storeys, a flat roof behind a parapet, windows. Kept out of TENT_KEYS:
   those are the four kinds of tent a band climbs through, and these are what
   comes after them. Made the first time a band builds one (people.js).

   And the things only a larger place has: the chief's hall, a market of stalls
   round a well, and a wall with gates.
   ------------------------------------------------------------------------- */
export const HOUSE_KEYS = ['house', 'townhouse'];
const MUDBRICK = 0xc49a6c, ROOFSLAB = 0x9c7b56, TIMBER = 0x6b4a2e, STONE = 0x8f877b;
const TABLE = 0x7a5a3a, AWNING = 0xf2efe6, WATER = 0x3d5a6e;

function house() {
  const W = 2.8, L = 3.6, H = 1.6;
  const parts = [
    painted(new THREE.BoxGeometry(W, H, L).translate(0, H / 2, 0), DAUB),
    painted(new THREE.ConeGeometry(2.55, 1.5, 4).rotateY(Math.PI / 4).scale(1, 1, L / W).translate(0, H + 0.75, 0), THATCH),
    painted(new THREE.BoxGeometry(0.7, 1.1, 0.08).translate(0, 0.55, L / 2 + 0.02), DOOR),
  ];
  for (const [x, z] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    parts.push(painted(new THREE.BoxGeometry(0.14, H, 0.14).translate(x * (W / 2 - 0.03), H / 2, z * (L / 2 - 0.03)), TIMBER));
  }
  return merged(parts);
}

function townhouse() {
  const W = 3.0, D = 3.0, H = 3.2;
  return merged([
    painted(new THREE.BoxGeometry(W, H, D).translate(0, H / 2, 0), MUDBRICK),
    painted(new THREE.BoxGeometry(W + 0.25, 0.22, D + 0.25).translate(0, H + 0.11, 0), ROOFSLAB),
    painted(new THREE.BoxGeometry(W + 0.25, 0.35, 0.18).translate(0, H + 0.39, (D + 0.25) / 2 - 0.09), MUDBRICK),
    painted(new THREE.BoxGeometry(0.75, 1.3, 0.08).translate(0, 0.65, D / 2 + 0.02), DOOR),
    painted(new THREE.BoxGeometry(0.45, 0.45, 0.08).translate(-0.8, 2.3, D / 2 + 0.02), DOOR),
    painted(new THREE.BoxGeometry(0.45, 0.45, 0.08).translate(0.8, 2.3, D / 2 + 0.02), DOOR),
  ]);
}

export function houseGeometry(key) {
  return key === 'townhouse' ? townhouse() : house();
}

/* The chief's hall: a longhouse, long axis toward the middle of the village. */
function hall() {
  const W = 5.5, L = 11, H = 2.2;
  return merged([
    painted(new THREE.BoxGeometry(W, H, L).translate(0, H / 2, 0), DAUB),
    painted(new THREE.ConeGeometry(4.4, 2.8, 4).rotateY(Math.PI / 4).scale(1, 1, L / W).translate(0, H + 1.4, 0), THATCH),
    painted(new THREE.BoxGeometry(1.3, 1.7, 0.1).translate(0, 0.85, L / 2 + 0.03), DOOR),
    painted(new THREE.BoxGeometry(0.22, 2.6, 0.22).translate(-0.95, 1.3, L / 2 + 0.3), TIMBER),
    painted(new THREE.BoxGeometry(0.22, 2.6, 0.22).translate(0.95, 1.3, L / 2 + 0.3), TIMBER),
    painted(new THREE.ConeGeometry(0.2, 0.7, 5).translate(0, H + 2.95, 0), FINIAL),
  ]);
}

/* A market stall: a table under an awning. The awning is pale so each stall's
   own colour, given on the instance, is what you see. */
function stall() {
  const parts = [painted(new THREE.BoxGeometry(1.8, 0.8, 1.0).translate(0, 0.4, 0), TABLE)];
  for (const [x, z] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    parts.push(painted(new THREE.BoxGeometry(0.08, 2.1, 0.08).translate(x * 0.95, 1.05, z * 0.6), TIMBER));
  }
  parts.push(painted(new THREE.BoxGeometry(2.1, 0.08, 1.5).rotateX(0.18).translate(0, 2.12, 0), AWNING));
  return merged(parts);
}

function well() {
  return merged([
    painted(new THREE.CylinderGeometry(0.9, 0.95, 0.8, 10).translate(0, 0.4, 0), STONE),
    painted(new THREE.CylinderGeometry(0.72, 0.72, 0.05, 10).translate(0, 0.78, 0), WATER),
    painted(new THREE.BoxGeometry(0.1, 2.0, 0.1).translate(-0.8, 1.0, 0), TIMBER),
    painted(new THREE.BoxGeometry(0.1, 2.0, 0.1).translate(0.8, 1.0, 0), TIMBER),
    painted(new THREE.BoxGeometry(1.8, 0.1, 0.1).translate(0, 1.95, 0), TIMBER),
    painted(new THREE.ConeGeometry(1.2, 0.7, 4).rotateY(Math.PI / 4).translate(0, 2.35, 0), THATCH),
  ]);
}

/* A length of town wall, along its local x, and a tower either side of a gate. */
function wallLength() {
  return merged([
    painted(new THREE.BoxGeometry(4.3, 2.6, 0.9).translate(0, 1.3, 0), MUDBRICK),
    painted(new THREE.BoxGeometry(0.9, 0.45, 0.95).translate(-1.3, 2.82, 0), MUDBRICK),
    painted(new THREE.BoxGeometry(0.9, 0.45, 0.95).translate(1.3, 2.82, 0), MUDBRICK),
  ]);
}
function tower() {
  return merged([
    painted(new THREE.BoxGeometry(1.7, 4.0, 1.7).translate(0, 2.0, 0), MUDBRICK),
    painted(new THREE.BoxGeometry(2.0, 0.3, 2.0).translate(0, 4.15, 0), ROOFSLAB),
  ]);
}

export function civicGeometries() {
  return { hall: hall(), stall: stall(), well: well(), wall: wallLength(), tower: tower() };
}
