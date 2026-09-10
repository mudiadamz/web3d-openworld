import * as THREE from 'three';

import { P, SEA } from './params.js';
import { sampleHeight } from './noise.js';
import { scene } from './scene.js';
import { followedPerson } from './chronicle.js';
import { THROW, preyNear } from './spear.js';
import { RING_OFF, RING_ON } from './reach.js';

/* -------------------------------------------------------------------------
   The throw, on screen

   A throw was a number: E, and the next frame said "got the deer" while the
   deer quietly vanished. Now it is something you watch —

     the range   a ring round the person you are playing, as wide as a spear
                 goes, while there is anything worth one near; pale, and green
                 once something is inside it;
     the arm     back over the shoulder, and through (drawn in move.js from
                 `p.throwPose`);
     the spear   out of the hand on an arc, and into what it was thrown at —
                 or on past it into the ground — and left standing there a
                 moment.

   All of it is the frame's: the throw itself was decided in the step
   (throwSpear, in spear.js), which leaves `p.threw` for this to draw.
   Built the first time it is needed, for the reason the lead ring gives.
   ------------------------------------------------------------------------- */
export const THROW_FX = {
  windup: 260,         // ms with the arm going back
  swing: 220,          // and coming through
  perMetre: 26,        // ms of flight per metre
  flyMin: 180,
  stay: 3500,          // ms the spear stands where it went in
  arc: 0.12,           // how high the arc rises, against the distance
  len: 1.9,            // the spear
  band: 0.14,          // half the width of the range ring
};
export const RANGE_SHOW = 1.6;         // the ring is down while a prey is this many reaches off

const RING_SEGS = 96;
let rangeRing = null, rangeGeo = null, rangeAt = null;
let spearMesh = null, flightSeen = null, flightFx = null;
const _up = new THREE.Vector3(0, 1, 0), _dir = new THREE.Vector3();

function buildRange() {
  rangeGeo = new THREE.BufferGeometry();
  rangeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((RING_SEGS + 1) * 2 * 3), 3));
  const idx = [];
  for (let k = 0; k < RING_SEGS; k++) {
    const a = k * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  rangeGeo.setIndex(idx);
  rangeRing = new THREE.Mesh(rangeGeo, new THREE.MeshBasicMaterial({
    color: RING_OFF, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide,
  }));
  rangeRing.frustumCulled = false;
  rangeRing.renderOrder = 3;
  scene.add(rangeRing);
}

/* Laid on the ground rather than flat through it: sixteen metres across a
   slope is a ring half buried on one side and floating on the other. */
function layRange(x, z) {
  const pos = rangeGeo.attributes.position.array;
  for (let k = 0; k <= RING_SEGS; k++) {
    const a = (k / RING_SEGS) * Math.PI * 2, s = Math.sin(a), c = Math.cos(a);
    for (let j = 0; j < 2; j++) {
      const r = THROW.reach + (j ? THROW_FX.band : -THROW_FX.band);
      const px = x + s * r, pz = z + c * r;
      const o = (k * 2 + j) * 3;
      pos[o] = px;
      pos[o + 1] = Math.max(sampleHeight(px, pz), SEA) + 0.18;
      pos[o + 2] = pz;
    }
  }
  rangeGeo.attributes.position.needsUpdate = true;
  rangeGeo.computeBoundingSphere();
}

/** The range ring: down while there is something worth a spear near, green
    once it is inside the throw. */
export function updateThrowRange(p) {
  const prey = p ? preyNear(p.x, p.z, THROW.reach * RANGE_SHOW) : null;
  if (!prey) { if (rangeRing) rangeRing.visible = false; return; }
  if (!rangeRing) buildRange();
  if (!rangeAt || Math.hypot(rangeAt.x - p.x, rangeAt.z - p.z) > 0.25) {
    layRange(p.x, p.z);
    rangeAt = { x: p.x, z: p.z };
  }
  const inReach = Math.hypot(prey.animal.x - p.x, prey.animal.z - p.z) < THROW.reach;
  rangeRing.visible = true;
  rangeRing.material.color.setHex(inReach ? RING_ON : RING_OFF);
  rangeRing.material.opacity = inReach ? 0.7 : 0.4;
}

function buildSpear() {
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.022, THROW_FX.len, 5).translate(0, -THROW_FX.len / 2, 0),
    new THREE.MeshLambertMaterial({ color: 0x8a6a45 }));
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.18, 5).translate(0, 0.06, 0),
    new THREE.MeshLambertMaterial({ color: 0x5c5850 }));
  // The tip at the group's origin, so where it lands is where it went in.
  spearMesh = new THREE.Group();
  spearMesh.add(shaft, tip);
  spearMesh.visible = false;
  scene.add(spearMesh);
}

/** The arm, and the spear in the air: one throw at a time, off `p.threw`. */
export function updateSpearFlight(p, now) {
  const t = p && p.threw;
  if (t && t !== flightSeen) {
    flightSeen = t;
    if (flightFx) flightFx.p.throwPose = 0;
    const dist = Math.hypot(t.x - t.fromX, t.z - t.fromZ);
    flightFx = { p, t, start: now, dist, fly: Math.max(THROW_FX.flyMin, dist * THROW_FX.perMetre) };
  }
  if (!flightFx) return;
  const f = flightFx, el = now - f.start;
  const arm = THROW_FX.windup + THROW_FX.swing;
  f.p.throwPose = el < arm ? Math.max(0.001, el / arm) : 0;
  if (el < THROW_FX.windup) { if (spearMesh) spearMesh.visible = false; return; }
  if (el > THROW_FX.windup + f.fly + THROW_FX.stay) {
    if (spearMesh) spearMesh.visible = false;
    f.p.throwPose = 0;
    flightFx = null;
    return;
  }
  if (!spearMesh) buildSpear();
  const k = Math.min(1, (el - THROW_FX.windup) / f.fly);
  const x0 = f.t.fromX, z0 = f.t.fromZ, y0 = sampleHeight(x0, z0) + 1.65;
  const rise = f.dist * THROW_FX.arc;
  spearMesh.position.set(x0 + (f.t.x - x0) * k,
    y0 + (f.t.y - y0) * k + Math.sin(k * Math.PI) * rise, z0 + (f.t.z - z0) * k);
  // Along its path: the arc's slope where it is now.
  _dir.set(f.t.x - x0, (f.t.y - y0) + Math.cos(k * Math.PI) * Math.PI * rise, f.t.z - z0).normalize();
  spearMesh.quaternion.setFromUnitVectors(_up, _dir);
  spearMesh.visible = true;
}

/** Every frame the world is drawn. */
export function updateHunt() {
  const p = P.view === 'follow' ? followedPerson() : null;
  updateThrowRange(p);
  updateSpearFlight(p, typeof performance !== 'undefined' ? performance.now() : 0);
}
