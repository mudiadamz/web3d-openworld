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
