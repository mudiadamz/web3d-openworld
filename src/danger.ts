import { P } from './params.js';
import { smoothstep } from './noise.js';
import { sunDir } from './scene.js';
import { treeSpots } from './world.js';
import { predatorNear } from './spear.js';
import { cam, followedPerson } from './chronicle.js';
import { $ } from './save.js';
import { toast } from './ui.js';

/* -------------------------------------------------------------------------
   Danger

   A tiger was something that happened to the person you were playing: they
   were walking, and then they were dead, and the first you knew of it was the
   chronicle. So a tiger in sight is on screen — which way it is from where you
   are looking and how far — and when it has chosen them, it says so, and what
   there is to do about it:

     run      shift, the run that is already there, paid for in energy;
     climb    Z at a tree, and it cannot reach them;
     hide     Z anywhere else: down and still, and it has to nearly walk onto
              them to find them — and one already after them loses them;
     fight    E, a spear thrown at it. A hit kills it. A miss brings it on.

   You see less far at night, which is the whole of what night does here. The
   band's own people run from tigers the way they always have; none of this is
   theirs, and nothing in how a tiger hunts them has moved.
   ------------------------------------------------------------------------- */
export const DANGER = {
  far: 48,             // metres a tiger is seen at in daylight
  night: 0.55,         // what is left of that at night
  close: 20,           // near enough to say so
};
export const CLIMB_REACH = 2.2;        // metres from a trunk that can be climbed
export const CLIMB_HEIGHT = 2.4;       // how far up they go
/* The two hiding numbers wildlife.js writes out where a tiger chooses and
   chases: a quarter of the distance it would notice somebody at, and the
   distance past which one already after them loses them. */
export const HIDE_SEEN = 0.25;
export const HIDE_LOST = 12;
/* Down low and moving is a crawl: this much of a walk, and nothing grazing
   notices them (collectThreats, in wildlife.js). */
export const CRAWL = 0.35;

/** How light it is: the same curve the tick hands the people. */
export function daylight() { return smoothstep(-0.10, 0.14, sunDir.y); }

/** How far the person you are playing sees a tiger coming — less at night. */
export function watchRange() {
  return DANGER.far * (DANGER.night + (1 - DANGER.night) * daylight());
}

/** The nearest trunk within reach of here, or null. */
export function treeNear(x, z, within = CLIMB_REACH) {
  let best = null, near = within;
  for (const t of treeSpots) {
    const d = Math.hypot(t.x - x, t.z - z);
    if (d < near) { near = d; best = t; }
  }
  return best;
}

/** Whether this tiger has this person as its quarry. */
export function hunting(d, p) {
  return Boolean(d && d.prey && d.prey.kind === 'person' && d.prey.person === p);
}

/** Z: take cover — up the tree they are at, or down where they stand; again to
    come down or stand up. Left on the person for the step, like E. */
export function takeCover() {
  const p = P.view === 'follow' ? followedPerson() : null;
  if (!p || p.acting || p.act) return false;
  p.led = true;
  p.orders = null;
  p.leadX = p.x;
  p.leadZ = p.z;
  p.act = { kind: 'cover', tree: p.climbed || p.hiding ? null : treeNear(p.x, p.z) };
  return true;
}

let dangerAt = 0, wasHunted = false;

/** The warning at the top of the screen. A few times a second, or at once. */
export function updateDanger(force = false) {
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  if (!force && now < dangerAt) return;
  dangerAt = now + 100;
  const el = $('danger');
  const p = P.view === 'follow' ? followedPerson() : null;
  const t = p ? predatorNear(p.x, p.z, watchRange()) : null;
  const hunted = Boolean(t) && hunting(t.animal, p);
  // The moment it turns on them is worth more than the warning that follows.
  if (hunted && !wasHunted) toast('a ' + t.pack.spec.key + ' is coming for you');
  wasHunted = hunted;
  if (!el) return;
  if (!t) { if (!el.hidden) el.hidden = true; return; }
  const a = t.animal;
  const dx = a.x - p.x, dz = a.z - p.z;
  const dist = Math.hypot(dx, dz);
  // Which way, against where the camera looks: straight up the screen is ahead.
  const fx = Math.sin(cam.yaw), fz = Math.cos(cam.yaw);
  const fore = dx * fx + dz * fz, side = -dx * fz + dz * fx;
  const turn = Math.atan2(side, fore);
  const what = t.pack.spec.key;
  const state = p.climbed ? 'up a tree — it cannot reach you'
    : p.hiding ? 'hidden — keep still'
      : hunted ? 'coming for you — run (shift), climb or hide (Z), or throw (E)'
        : dist < DANGER.close ? 'close' : 'about';
  el.hidden = false;
  el.classList?.toggle?.('hunted', hunted);
  el.innerHTML = '<i class="arrow" style="transform:rotate(' + turn.toFixed(2) + 'rad)">▲</i>'
    + '<b>' + what + ' · ' + Math.round(dist) + ' m</b> <span>' + state + '</span>';
}
