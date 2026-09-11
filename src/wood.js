import * as THREE from 'three';

import { sampleHeight, inWater } from './noise.js';
import { scene } from './scene.js';
import { treeSpots } from './world.js';
import { camps, dressCamp } from './people.js';
import { bagAdd } from './bag.js';
import { practise } from './skills.js';
import { logEvent } from './life.js';

/* -------------------------------------------------------------------------
   Wood

   The island has three thousand trees and nobody had ever cut one. Now:

     the errand   somebody walks out to a tree, cuts, and carries the logs
                  home on the shoulder — the band's own people when there is
                  something to build or the stack is low, and you with E at
                  any tree;
     the skill    woodcraft, learned by doing it: the better a band is at it,
                  the more logs a trip brings back;
     the stack    what comes home is stacked by the granaries, log on log,
                  and you can see how much a band has;
     the raft     what the wood is for: a band on a coast builds its raft out
                  of the stack, and until it has cut enough there is no raft
                  and no fishing.
   ------------------------------------------------------------------------- */
export const WOOD = {
  chance: 0.12,        // weight against the other errands, with something to build
  keep: 8,             // logs a band keeps stacked once it has nothing to build
  perTrip: 3,          // logs one trip brings home, before woodcraft
  practise: 0.02,      // woodcraft gained by one trip
  raft: 12,            // logs in a raft
  near: 12,            // the nearest a tree worth cutting stands from the fire
  far: 150,            // and the furthest anybody walks for one
  reach: 2.4,          // metres from a trunk that E cuts at
  show: 9,             // how near a tree is before its ring goes down
};

/** How much a band wants wood: a lot with a raft to build, a little to keep
    the stack up, and none with the stack full. */
export function woodWant(camp) {
  if (camp.shore && !camp.raft) return WOOD.chance;
  return (camp.wood || 0) < WOOD.keep ? WOOD.chance * 0.35 : 0;
}

/* The trees a band cuts at: within a walk of its fire and not on top of it.
   Worked out once for where the camp stands, not per trip — three thousand
   trunks is a long list to read every time somebody wants a log. */
function standOf(camp) {
  const at = camp.x + ',' + camp.z;
  if (camp.woodsAt !== at) {
    camp.woodsAt = at;
    camp.woods = treeSpots.filter((t) => {
      const d = Math.hypot(t.x - camp.x, t.z - camp.z);
      return d > WOOD.near && d < WOOD.far;
    });
  }
  return camp.woods;
}

/** A tree for this trip: the nearest of a few picked from the band's stand.
    From the step, so it draws from the stream. */
export function pickTree(camp, luck) {
  const stand = standOf(camp);
  if (!stand.length) return null;
  let best = null, near = Infinity;
  for (let t = 0; t < 4; t++) {
    const s = stand[(luck() * stand.length) | 0];
    const d = Math.hypot(s.x - camp.x, s.z - camp.z);
    if (d < near) { near = d; best = s; }
  }
  return best;
}

/** A trip's cutting done: logs onto the shoulder, and a little more woodcraft. */
export function chopDone(p) {
  const skill = p.camp.skill;
  skill.woodcraft ||= 0;
  const logs = Math.max(1, Math.round(WOOD.perTrip * (1 + (p.camp.skill.woodcraft || 0)) * (p.child ? 0.5 : 1)));
  bagAdd(p, 'wood', logs);
  p.carry = 1;
  practise(p.camp, 'woodcraft', WOOD.practise);
  if (p.knows) p.knows.woodcraft = Math.max(p.knows.woodcraft || 0, skill.woodcraft);
}

/** Logs put away: onto the stack — and on a coast, once there are enough, a
    raft built out of them. */
export function storeWood(camp, n) {
  camp.wood = (camp.wood || 0) + n;
  if (camp.shore && !camp.raft && camp.wood >= WOOD.raft) {
    camp.wood -= WOOD.raft;
    camp.raft = true;
    logEvent('learned', `[${camp.code}] ${camp.name} built a raft`, camp.shore.x, camp.shore.z);
    dressCamp(camp);
  }
}

/* ---- the stack, drawn ---- */

const PILE_MAX = 15;                   // logs drawn on a stack: five, four, three, two, one
let pileCamps = 96;                    // camps the stacks mesh holds; doubled past it
let pileMesh = null, pileKey = '';
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

/* Beside the granaries, a step further out from the fire than the first of
   them, and to one side of it. */
function pileSpot(c) {
  const s = c.storeSpots?.[0];
  if (!s) return { x: c.x + 8, z: c.z, a: 0 };
  const dx = s.x - c.x, dz = s.z - c.z, d = Math.hypot(dx, dz) || 1;
  // To one side of it — the other side, if that one is in the water.
  for (const side of [1, -1]) {
    const x = s.x + (dx / d) * 3.4 + side * (dz / d) * 1.8, z = s.z + (dz / d) * 3.4 - side * (dx / d) * 1.8;
    if (!inWater(x, z) || side < 0) return { x, z, a: Math.atan2(dx, dz) };
  }
}

/** Every frame the world is drawn, and only rewritten when a stack changes. */
export function updateWoodpiles() {
  let key = '';
  for (const c of camps) key += (c.gone ? 0 : Math.min(PILE_MAX, Math.floor(c.wood || 0))) + ',';
  if (key === pileKey) return;
  pileKey = key;
  // More camps than the mesh holds: made again, bigger. There is no ceiling on camps.
  if (pileMesh && camps.length > pileCamps) {
    scene.remove(pileMesh);
    pileMesh.geometry.dispose();
    pileMesh.material.dispose();
    pileMesh.dispose();
    pileMesh = null;
    while (pileCamps < camps.length) pileCamps *= 2;
  }
  if (!pileMesh) {
    if (!/[1-9]/.test(key)) return;
    const geo = new THREE.CylinderGeometry(0.12, 0.13, 1.5, 7).rotateZ(Math.PI / 2);
    pileMesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0x7a5a3a }), PILE_MAX * pileCamps);
    pileMesh.frustumCulled = false;
    pileMesh.castShadow = true;
    pileMesh.receiveShadow = true;
    scene.add(pileMesh);
  }
  let n = 0;
  camps.forEach((c, ci) => {
    if (ci >= pileCamps || c.gone) return;
    const logs = Math.min(PILE_MAX, Math.floor(c.wood || 0));
    if (!logs) return;
    const at = pileSpot(c), ground = sampleHeight(at.x, at.z);
    _q.setFromAxisAngle(_up, at.a);
    let k = 0;
    // Side by side across the stack, each row one shorter and resting on the last.
    for (let row = 0; row < 5 && k < logs; row++) {
      for (let j = 0; j < 5 - row && k < logs; j++, k++) {
        _v.set(0, 0.13 + row * 0.22, (j - (4 - row) / 2) * 0.26).applyQuaternion(_q);
        _v.x += at.x;
        _v.y += ground;
        _v.z += at.z;
        pileMesh.setMatrixAt(n++, _m.compose(_v, _q, _s));
      }
    }
  });
  pileMesh.count = n;
  pileMesh.instanceMatrix.needsUpdate = true;
}
