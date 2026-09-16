import * as THREE from 'three';
import { camera } from './scene.js';
import { partsPer } from './clock.js';
import { looks } from './looks.js';
import { people, personParts, tribeGroup } from './people.js';

/* -------------------------------------------------------------------------
   Drawing a crowd

   Every body part and every garment of every person used to go to the GPU
   every frame, whoever they were: behind the camera, or a kilometre off and
   three pixels tall. A person is about two and a half thousand triangles of
   body and the best part of a thousand of hide, hair and face, and nearly all
   of it casts a shadow and so is drawn twice. At two and a half thousand
   people that was 7.7 million triangles a frame, 6.8 million of them twice:
   a phone running hot and a frame rate falling through the floor.

   The meshes people.js and looks.js build are still where a figure is written
   - the body by index, a turn at a time (writePerson, move.js), the clothes
   packed by who is wearing them - but they are no longer drawn. They are the
   record. Each frame this copies out only what is worth drawing, packed to the
   front of meshes that are drawn:

     - nothing of anybody outside what the camera can see
     - nothing parked out of sight: a spear nobody is carrying is a matrix of
       zeros, and a matrix of zeros is still every vertex of a spear to the GPU
     - and past CROWD.near, a figure made of a handful of plain shapes, without
       hands, feet, neck, face or whatever is in their hand. At sixty metres a
       forearm is under two pixels wide; nobody can tell a capsule from a
       six-sided rod at that size, or see a nose at all.

   Whoever is asleep or indoors was already out of both records (updatePeople
   parks them and takes their clothes off), so they cost nothing here either.
   ------------------------------------------------------------------------- */

export const CROWD = {
  near: 60,            // metres from the camera inside which a person is drawn in full
  reach: 2.2,          // how far from the head a person's parts can reach, spear and all
  /* What a distant body keeps: the parts that make the shape of somebody
     walking, and what they carry. */
  far: new Set(['head', 'upperArm', 'foreArm', 'thigh', 'shin', 'spear', 'load', 'basket']),
  /* And what a distant figure takes off: the look groups too small to see. */
  farBare: new Set(['face', 'band', 'tool']),
};

/* One drawn copy of one record mesh. */
interface Copy { from: THREE.InstancedMesh; mesh: THREE.InstancedMesh; n: number }

let bodyFor = null, looksFor = null;
const body: Record<string, Copy> = {}, bodyFar: Record<string, Copy> = {}, clothes: Record<string, Copy> = {};

/* A plain shape the size of a part: a six-sided rod along its longest side if
   it is long, a coarse ball if it is not. Fitted to the part's own box, so it
   hangs from the same joint the part does. */
function roughly(geo) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const s = b.getSize(new THREE.Vector3()), mid = b.getCenter(new THREE.Vector3());
  const long = Math.max(s.x, s.y, s.z), short = Math.min(s.x, s.y, s.z);
  const rod = () => new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1);
  let g;
  if (long <= short * 1.6) g = new THREE.SphereGeometry(0.5, 6, 4).scale(s.x, s.y, s.z);
  else if (long === s.y) g = rod().scale(s.x, s.y, s.z);
  else if (long === s.x) g = rod().scale(s.y, s.x, s.z).rotateZ(Math.PI / 2);
  else g = rod().scale(s.x, s.z, s.y).rotateX(Math.PI / 2);
  return g.translate(mid.x, mid.y, mid.z);
}

function copyOf(from, geo, suffix): Copy {
  const mesh = new THREE.InstancedMesh(geo, from.material, from.instanceMatrix.count);
  /* Not the record's own name: whatever looks a part up by name - the boot
     checks do - means the record, where slot i is person i. */
  mesh.name = 'crowd:' + from.name + suffix;
  mesh.castShadow = from.castShadow;
  mesh.receiveShadow = from.receiveShadow;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  tribeGroup.add(mesh);
  return { from, mesh, n: 0 };
}

function drop(set: Record<string, Copy>, key, geometryToo = false) {
  const c = set[key];
  if (!c) return;
  tribeGroup.remove(c.mesh);
  if (geometryToo) c.mesh.geometry.dispose();
  c.mesh.dispose();
  delete set[key];
}

/* Kept in step with the records: made again when people.js or looks.js make
   theirs again - a new island, or room for more people, which replaces a mesh
   with a bigger one. */
function keepUp() {
  if (bodyFor !== personParts) {
    for (const key in body) drop(body, key);
    for (const key in bodyFar) drop(bodyFar, key, true);
    bodyFor = personParts;
  }
  for (const key in personParts || {}) {
    const from = personParts[key];
    from.visible = false;                  // the record, not the picture
    if (body[key]?.from === from) continue;
    drop(body, key);
    body[key] = copyOf(from, from.geometry, '');
    if (CROWD.far.has(key)) {
      const rough = bodyFar[key]?.mesh.geometry || roughly(from.geometry);
      drop(bodyFar, key);
      bodyFar[key] = copyOf(from, rough, '-far');
    }
  }
  if (looksFor !== looks) {
    for (const key in clothes) drop(clothes, key);
    looksFor = looks;
  }
  for (const key in looks || {}) {
    const from = looks[key];
    from.visible = false;
    if (clothes[key]?.from === from) continue;
    drop(clothes, key);
    clothes[key] = copyOf(from, from.geometry, '');
  }
  // A colour is only made on a mesh the first time one is set (setColorAt).
  for (const set of [body, bodyFar, clothes]) {
    for (const key in set) {
      const { from, mesh } = set[key];
      if (from.instanceColor && !mesh.instanceColor) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count * 3), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
    }
  }
}

/* One slot of a record, onto the end of a copy - unless it is parked. */
function put(c: Copy, slot) {
  const src = c.from.instanceMatrix.array, o = slot * 16;
  if (src[o] === 0 && src[o + 1] === 0 && src[o + 2] === 0) return;
  const dst = c.mesh.instanceMatrix.array, d = c.n * 16;
  for (let e = 0; e < 16; e++) dst[d + e] = src[o + e];
  const sc = c.from.instanceColor?.array, dc = c.mesh.instanceColor?.array;
  if (sc && dc) {
    const a = slot * 3, b = c.n * 3;
    dc[b] = sc[a]; dc[b + 1] = sc[a + 1]; dc[b + 2] = sc[a + 2];
  }
  c.n++;
}

function upload(c: Copy) {
  c.mesh.count = c.n;
  c.mesh.visible = c.n > 0;
  c.mesh.instanceMatrix.clearUpdateRanges();
  c.mesh.instanceMatrix.addUpdateRange(0, c.n * 16);
  c.mesh.instanceMatrix.needsUpdate = true;
  if (c.mesh.instanceColor) {
    c.mesh.instanceColor.clearUpdateRanges();
    c.mesh.instanceColor.addUpdateRange(0, c.n * 3);
    c.mesh.instanceColor.needsUpdate = true;
  }
}

const _frustum = new THREE.Frustum();
const _view = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const NEAR = 1, FAR = 2;
const tier = new Map();

/** Copy out what is worth drawing this frame. Called once a frame, just before
    the render, so it sees the camera where the render will. */
export function drawCrowd() {
  if (!personParts) return;
  keepUp();
  camera.updateMatrixWorld();
  _view.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_view);
  const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
  const near2 = CROWD.near * CROWD.near;
  for (const set of [body, bodyFar, clothes]) for (const key in set) set[key].n = 0;
  tier.clear();

  const head = personParts.head.instanceMatrix.array;
  _sphere.radius = CROWD.reach;
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (p.hidden) continue;
    // The head's own matrix says where somebody is, as last written.
    const h = i * 16;
    if (head[h] === 0 && head[h + 1] === 0 && head[h + 2] === 0) continue;
    const x = head[h + 12], y = head[h + 13], z = head[h + 14];
    _sphere.center.set(x, y - 0.8, z);
    if (!_frustum.intersectsSphere(_sphere)) continue;
    const close = (x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz) < near2;
    tier.set(p, close ? NEAR : FAR);
    const set = close ? body : bodyFar;
    for (const key in set) {
      const per = partsPer(key);
      for (let k = 0; k < per; k++) put(set[key], i * per + k);
    }
  }
  /* The clothes are already packed by who has them on, so it is the same
     question asked the other way round: of everybody wearing this, who is in
     view. */
  for (const key in clothes) {
    const c = clothes[key], who = c.from.userData.who;
    const bare = CROWD.farBare.has(key.split(':')[0]);
    for (let j = 0; j < c.from.count && j < who.length; j++) {
      const t = tier.get(who[j]);
      if (t === NEAR || (t === FAR && !bare)) put(c, j);
    }
  }
  for (const set of [body, bodyFar, clothes]) for (const key in set) upload(set[key]);
}
