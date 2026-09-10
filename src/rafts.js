import * as THREE from 'three';

import { SEA } from './params.js';
import { sampleHeight } from './noise.js';
import { scene } from './scene.js';
import { luck } from './clock.js';
import { camps, joinGeometries, people } from './people.js';
import { DOCK, dockOf, pickFishing } from './larder.js';

/* -------------------------------------------------------------------------
   Rafts, and the docks they are tied up at

   A band "built a raft" and nothing on the island changed but a number. The
   fish were within reach of the bank, a little less of them, and the raft
   was a multiplier nobody could see. Now:

     the dock   planks out from the band's landing into the water, and the
                raft riding at the end of them — the first thing a band on a
                coast builds that you can see from the sea;
     the fish   out in deep water, and only there: from the bank there is
                nothing (fishRichness, in larder.js). A band fishes once it has
                a raft, and not before;
     a trip     one of the band's fishers walks down to the dock, paddles out
                to deep water, fishes, and paddles back — the raft goes with
                them, one fisher at a time;
     yours      at the landing, E takes it out; WASD paddles it, only where
                it floats; E out on deep water fishes; E back at the dock ties
                it up and puts them ashore.

   The trips are the step's: where they go is drawn from the stream, and where
   they are is worked out from the errand's own clock, so a raft out of sight
   is exactly where one in sight would be. The dock and raft meshes are the
   frame's, built the first time a band has a raft, for the reason the lead
   ring gives.
   ------------------------------------------------------------------------- */
export const RAFT = {
  deck: 0.3,           // how far above the water they stand on it
  draft: 0.35,         // water it needs under it: less and it is aground
  speed: 2.2,          // metres a second, paddled
  fishFor: [18, 38],   // seconds out there with a line in, for the band's own
  reach: 4,            // metres from the landing that E takes it out from
  dockDeck: 0.55,      // the planks, above the water
};
const RAFT_MAX = 96;

/** How far up off the ground somebody standing on a raft here is. */
export function afloat(x, z) { return Math.max(0, SEA + RAFT.deck - sampleHeight(x, z)); }

/** Whether this band's raft is out, and so not at the dock for anybody else. */
export function raftBusy(camp) {
  const r = camp.raftOut;
  return Boolean(r) && (Boolean(r.raftTrip) || r.onRaft === camp) && people.includes(r);
}

/** Where somebody out on the water would be put ashore: for the save, which
    must never bring anybody back standing on the sea bed. */
export function landing(p) {
  if (p.raftTrip) return { x: p.raftTrip.landX, z: p.raftTrip.landZ };
  const d = p.onRaft ? dockOf(p.onRaft) : null;
  return d ? { x: d.x, z: d.z } : p;
}

/** Every step, for anybody out fishing: out from the dock to deep water, a
    while there, and back, off the errand's own timer. */
export function raftTrip(p) {
  if (!(p.job === 'fish' && p.state === 'work') || p.led) { if (p.raftTrip) landRaft(p); return; }
  const camp = p.camp;
  let t = p.raftTrip;
  if (!t) {
    const dock = camp.raft ? dockOf(camp) : null;
    if (!dock || raftBusy(camp)) return;
    const spot = pickFishing(camp, luck);
    if (!spot) return;
    const out = Math.hypot(spot.x - dock.mx, spot.z - dock.mz) / RAFT.speed;
    p.timer = 2 * out + RAFT.fishFor[0] + luck() * (RAFT.fishFor[1] - RAFT.fishFor[0]);
    t = p.raftTrip = { spot, dock, total: p.timer, out, landX: p.x, landZ: p.z };
    camp.raftOut = p;
  }
  const left = Math.max(0, p.timer);
  const k = Math.min(1, (t.total - left) / t.out, left / t.out);
  const x = t.dock.mx + (t.spot.x - t.dock.mx) * k, z = t.dock.mz + (t.spot.z - t.dock.mz) * k;
  if (Math.hypot(x - p.x, z - p.z) > 1e-3) p.yaw = Math.atan2(x - p.x, z - p.z);
  p.x = x;
  p.z = z;
  p.lift = afloat(x, z);
}

/** Back on land where they walked down to the dock, and the raft tied up. */
export function landRaft(p) {
  const t = p.raftTrip;
  if (!t) return;
  p.x = t.landX;
  p.z = t.landZ;
  p.lift = 0;
  p.raftTrip = null;
  if (p.camp.raftOut === p) p.camp.raftOut = null;
}

/** Paddling, for the person you are playing: only where it floats. */
export function raftStep(p, step) {
  const nx = p.x + Math.sin(p.yaw) * step, nz = p.z + Math.cos(p.yaw) * step;
  if (sampleHeight(nx, nz) > SEA - RAFT.draft) return false;      // aground
  p.x = nx;
  p.z = nz;
  p.lift = afloat(nx, nz);
  return true;
}

/** E at the landing: onto the band's raft, riding at the end of the dock. */
export function boardRaft(p) {
  const camp = p.camp, d = camp.raft ? dockOf(camp) : null;
  if (!d) return 'no raft here';
  if (raftBusy(camp)) return 'the raft is out';
  if (Math.hypot(p.x - d.x, p.z - d.z) > RAFT.reach + 0.5) return 'too far from the dock';
  p.onRaft = camp;
  camp.raftOut = p;
  p.x = d.mx;
  p.z = d.mz;
  p.leadX = p.x;
  p.leadZ = p.z;
  p.yaw = d.a;
  p.lift = afloat(p.x, p.z);
  p.speed = 0;
  p.hiding = false;
  p.resting = false;
  return 'out on the raft — the fish are in the deep water';
}

/** E back at the dock: the raft tied up where it lives, and them ashore. */
export function moorRaft(p) {
  const camp = p.onRaft;
  if (!camp) return 'not on a raft';
  const d = dockOf(camp);
  p.onRaft = null;
  if (camp.raftOut === p) camp.raftOut = null;
  if (d) { p.x = d.x; p.z = d.z; }
  p.leadX = p.x;
  p.leadZ = p.z;
  p.lift = 0;
  p.speed = 0;
  return 'tied up the raft';
}

/* ---- drawn ---- */

let dockMesh = null, raftMesh = null;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

function buildRaftMeshes() {
  // The dock: a deck of planks out along +z from the landing, on four posts.
  const deckLen = DOCK.len + 0.6;
  const dock = [new THREE.BoxGeometry(1.5, 0.1, deckLen).translate(0, 0, deckLen / 2 - 0.6)];
  for (const [x, z] of [[-0.65, 2], [0.65, 2], [-0.65, DOCK.len - 0.3], [0.65, DOCK.len - 0.3]]) {
    dock.push(new THREE.CylinderGeometry(0.08, 0.1, 3.4, 6).translate(x, -1.65, z));
  }
  dockMesh = new THREE.InstancedMesh(joinGeometries(dock), new THREE.MeshLambertMaterial({ color: 0x75573a }), RAFT_MAX);
  // The raft: five logs lashed across two bars.
  const logs = [];
  for (let k = 0; k < 5; k++) {
    logs.push(new THREE.CylinderGeometry(0.16, 0.16, 3, 7).rotateX(Math.PI / 2).translate((k - 2) * 0.33, 0, 0));
  }
  logs.push(new THREE.BoxGeometry(1.8, 0.08, 0.14).translate(0, 0.16, 0.95));
  logs.push(new THREE.BoxGeometry(1.8, 0.08, 0.14).translate(0, 0.16, -0.95));
  raftMesh = new THREE.InstancedMesh(joinGeometries(logs), new THREE.MeshLambertMaterial({ color: 0x8c6b43 }), RAFT_MAX);
  for (const m of [dockMesh, raftMesh]) {
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }
}

/** Every frame the world is drawn: each band's dock, and its raft — at the
    end of the dock, or wherever whoever has it out is. */
export function updateRafts() {
  let any = false;
  for (const c of camps) if (c.raft && !c.gone && c.shore) { any = true; break; }
  if (!any) { if (dockMesh) { dockMesh.count = 0; raftMesh.count = 0; } return; }
  if (!dockMesh) buildRaftMeshes();
  const now = typeof performance !== 'undefined' ? performance.now() / 1000 : 0;
  let i = 0;
  for (const c of camps) {
    if (i >= RAFT_MAX) break;
    if (!c.raft || c.gone) continue;
    const d = dockOf(c);
    if (!d) continue;
    _q.setFromAxisAngle(_up, d.a);
    _v.set(d.x, SEA + RAFT.dockDeck, d.z);
    dockMesh.setMatrixAt(i, _m.compose(_v, _q, _s));
    const r = raftBusy(c) ? c.raftOut : null;
    _q.setFromAxisAngle(_up, r ? r.yaw : d.a);
    _v.set(r ? r.x : d.mx, SEA + 0.1 + Math.sin(now * 1.3 + i) * 0.03, r ? r.z : d.mz);
    raftMesh.setMatrixAt(i, _m.compose(_v, _q, _s));
    i++;
  }
  dockMesh.count = i;
  raftMesh.count = i;
  dockMesh.instanceMatrix.needsUpdate = true;
  raftMesh.instanceMatrix.needsUpdate = true;
}
