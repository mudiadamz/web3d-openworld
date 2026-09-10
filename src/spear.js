import { luck } from './clock.js';
import { SKILL } from './skills.js';
import { sampleHeight } from './noise.js';
import { packs, recountAnimals } from './wildlife.js';
import { bagAdd } from './bag.js';
import { QUARRY, logEvent, simDay, who } from './life.js';
import { P } from './params.js';

/* Hunting by hand, for the person you are playing: the nearest animal worth a
   spear, and the throw. Everything the band's own hunters do — the chase, the
   repeated tries — is still tryKill in life.js; this is the one throw E makes. */

/** The nearest living animal worth a spear within reach — hunted-out or not,
    because a person standing in front of the last deer will throw at it. No
    draw from the stream, so a frame can ask it for the prompt. */
export function preyNear(x, z, reach) {
  let best = null, bestD = reach * reach;
  for (const pack of packs) {
    if (!QUARRY[pack.spec.key]) continue;
    for (const a of pack.list) {
      if (a.dead) continue;
      const d = (a.x - x) ** 2 + (a.z - z) ** 2;
      if (d < bestD) { bestD = d; best = { animal: a, pack }; }
    }
  }
  return best;
}

/** The nearest living predator within reach of here, with its pack. */
export function predatorNear(x, z, within) {
  let best = null, bestD = within * within;
  for (const pack of packs) {
    if (!pack.spec.predator) continue;
    for (const a of pack.list) {
      if (a.dead) continue;
      const d = (a.x - x) ** 2 + (a.z - z) ** 2;
      if (d < bestD) { bestD = d; best = { animal: a, pack }; }
    }
  }
  return best;
}

/* -------------------------------------------------------------------------
   A spear thrown by hand

   The band's hunters close in and try again and again while the animal runs;
   somebody you are playing throws once, from where they stand. So one throw is
   worth more than one of theirs — surer the closer it is, surer for a band that
   knows spears, surer still from down low where it never saw them coming, and
   harder or easier by what it is thrown at, in the same proportion the band
   finds it — and a miss is a miss.

   What it brings down lies where it fell (wildlife.js draws it on its side)
   until E picks it up, or a day goes by. The band's own kills are carried off
   at once, as they always were.

   Rolled here, in the step, like every other chance in the world: the key only
   left it on the person.
   ------------------------------------------------------------------------- */
export const THROW = { reach: 16, point: 0.85, most: 0.95, tiger: 0.4, tigerMost: 0.75, stalk: 1.25 };
export const CARCASS_DAYS = 1;         // how long something brought down lies there
export const CARCASS_REACH = 2.2;      // metres from it that E picks it up from

/* What the throw looked like, for hunt.js to draw: from where, to where, and
   whether it went in. A miss goes on past, into the ground. */
function flight(p, a, hit) {
  const dx = a.x - p.x, dz = a.z - p.z, d = Math.hypot(dx, dz) || 1;
  const x = hit ? a.x : a.x + (dx / d) * 2.5, z = hit ? a.z : a.z + (dz / d) * 2.5;
  p.threw = { fromX: p.x, fromZ: p.z, x, z, y: sampleHeight(x, z) + (hit ? 0.55 * (a.scale || 1) : 0), hit };
}

export function throwSpear(p, prey) {
  const a = prey && prey.animal;
  if (!a || a.dead) { p.actResult = 'nothing left to throw at'; return false; }
  const d = Math.hypot(a.x - p.x, a.z - p.z);
  const key = prey.pack.spec.key;
  if (d > THROW.reach) { p.actResult = 'the ' + key + ' is out of reach'; return false; }
  p.yaw = Math.atan2(a.x - p.x, a.z - p.z);
  /* At a tiger. Harder than at a deer, and it is not a meal: a hit kills it
     and is worth a line in the chronicle; a miss tells it where they are, and
     it comes for them however little it wanted to before. */
  if (prey.pack.spec.predator) {
    const chance = Math.min(THROW.tigerMost, THROW.tiger * (1 - 0.7 * d / THROW.reach)
      * (1 + SKILL.spearChance * p.camp.skill.spears) * (p.hiding ? THROW.stalk : 1));
    if (luck() > chance) {
      const h = prey.pack.spec.hunt;
      a.prey = { kind: 'person', person: p };
      a.chase = 0;
      a.sulk = 0;
      a.rest = 0;
      if (h) a.fed = Math.min(a.fed ?? 0, h.desperate * 0.9);
      flight(p, a, false);
      p.actResult = 'missed — the ' + key + ' is coming';
      return false;
    }
    flight(p, a, true);
    a.dead = true;
    a.carcass = { until: simDay + CARCASS_DAYS, fall: -0.5 };
    recountAnimals();
    p.kills++;
    logEvent('slain', '[' + p.camp.code + '] ' + who(p) + ' killed a ' + key, p.x, p.z);
    p.actResult = 'killed the ' + key + '!';
    return true;
  }
  const q = QUARRY[key];
  const chance = Math.min(THROW.most, THROW.point * (1 - 0.7 * d / THROW.reach)
    * (1 + SKILL.spearChance * p.camp.skill.spears) * (q.chance / 0.10) * (p.hiding ? THROW.stalk : 1));
  if (luck() > chance) { flight(p, a, false); p.actResult = 'missed the ' + key; return false; }
  flight(p, a, true);
  // Down where it stood, for E to pick up: the fall is a moment after the spear lands.
  a.dead = true;
  a.carcass = { until: simDay + CARCASS_DAYS, fall: -0.5 };
  recountAnimals();
  p.kills++;
  logEvent('kill', who(p) + ' brought down a ' + key, p.x, p.z);
  p.actResult = 'got the ' + key + '! — E to pick it up';
  return true;
}

/** The nearest thing worth carrying that the person you are playing brought
    down and has not picked up, within reach of here. */
export function carcassNear(x, z, within) {
  let best = null, bestD = within * within;
  for (const pack of packs) {
    if (!QUARRY[pack.spec.key]) continue;
    for (const a of pack.list) {
      if (!a.carcass) continue;
      const d = (a.x - x) ** 2 + (a.z - z) ** 2;
      if (d < bestD) { bestD = d; best = { animal: a, pack }; }
    }
  }
  return best;
}

/** Picked up: onto the shoulder, as meat, and gone from the ground. */
export function takeCarcass(p, t) {
  const a = t && t.animal;
  if (!a || !a.carcass) { p.actResult = 'nothing there now'; return; }
  const key = t.pack.spec.key;
  const meat = QUARRY[key].meat * (a.scale || 1) * P.abundance;
  a.carcass = null;
  p.haul += meat;
  p.carry = 1;
  bagAdd(p, 'game', 1, key);
  p.actResult = 'picked up the ' + key + ' · ' + meat.toFixed(0) + ' food';
}
