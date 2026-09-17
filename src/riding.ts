import { SEA } from './params.js';
import { flatnessAt, inWater, sampleHeight } from './noise.js';
import { PERSON, lodStride, luck, worldClock, worldStep } from './clock.js';
import { camps, people } from './people.js';
import { packs } from './wildlife.js';
import { logEvent } from './life.js';
import { practise } from './skills.js';
import { campReach } from './settlement.js';
import { walls } from './walls.js';
import { CITY } from './settlement.js';

/* -------------------------------------------------------------------------
   Horses, and riding them

   Wild horses graze the island in herds like everything else (SPECIES,
   wildlife.js), and until a band does something about it they are only that.
   `riding` is the skill, and it comes in two parts, in order:

   - Taming. Somebody goes out to a herd for an afternoon and works a horse
     until it will follow them home. Most afternoons it will not. One that does
     is the band's: it grazes in a paddock just outside the camp and does not
     run from anybody. How many a band keeps grows with the skill.
   - Riding. Past a fair hand, the band rides what it has tamed - or rather,
     its chief does, and in a city its mounted patrols do (POLICE, below). A
     horse is rare and it is dear: a band keeps a handful at most, and nobody
     else gets on one. One of those setting off anywhere worth the saddle
     whistles up a free horse, which
     comes at a gallop, and they ride - two and a bit times a walking pace at a
     fair hand, over three and a half at mastery, and never faster than a horse
     can be ridden. At the other end the horse waits near them while they work,
     carries them home, and goes back to the paddock.

   Nobody rides inside a town's wall: they walk out through the gate and the
   horse meets them outside it, and coming home they get down before the gate.
   A horse is an animal, not a person, and the wall rule is for people.

   A tamed horse keeps its place in the herd's list, so the drawing, the gait,
   a tiger taking one and a save putting them back are all the herd's own.
   ------------------------------------------------------------------------- */

export const RIDE = {
  from: 0.5,           // riding a band needs before it rides what it has tamed: until then it only tames
  reach: 450,          // metres from the camp a band will walk to a wild herd
  chance: 0.12,        // weight of an afternoon at the herd, fed and rested
  odds: [0.05, 0.25],  // chance an afternoon brings a horse home, at nothing and at mastery: seldom
  perTame: 0.03,       // riding learned by an afternoon at the herd
  perRide: 0.012,      // and by a ride
  kept: [1, 8],        // horses a band will keep, at nothing and at mastery: few, however good it is
  wild: 3,             // a herd with fewer wild horses than this is left alone
  worth: 70,           // metres: nearer than this nobody saddles up
  pace: [2.2, 3.6],    // times the pace they would have walked at, at a fair hand and at mastery
  most: 7.5,           // metres a second: a horse ridden, however hurried
  fetch: 180,          // metres a free horse will come from to whoever wants it
  wait: 150,           // world seconds a horse waits by somebody working before it goes home
  pen: 9,              // metres round the paddock's middle the horses graze
  out: 14,             // metres past the camp's edge the paddock is
  gate: 8,             // metres outside a town wall a rider going in gets down
  near: 12,            // metres from its rider at which a horse coming for them slows to a walk
  mount: 3.5,          // and at which they get on
};

/* -------------------------------------------------------------------------
   Mounted patrols

   A city has a territory to keep, and a few of its people spend their days
   riding the bounds of it on the city's horses: a beat of eight points out past
   the wall, round and round. They are drawn from its best riders, one to every
   thirty grown people, and never more than it has horses for. While they are
   out the city is watched - raiders are seen coming and met - so its defence
   counts for more (guarded, society.js), and riding the bounds is where they
   learn to fight.
   ------------------------------------------------------------------------- */
export const POLICE = {
  per: 30,             // grown people in a city to each patrol rider, as far as its horses go
  out: 45,             // metres past the wall the beat runs
  stops: 8,            // points round the beat
  round: 8,            // points ridden one after another before going home: once round
  chance: 1.2,         // weight of riding the beat, for a patrol rider, before the role leans on it
  perStop: 0.004,      // fighting learned at each point of the beat
  guard: 0.8,          // how much more a city's defence counts with its patrols all out
  full: 4,             // patrol riders at which that is all of it
};

/** Who may take a horse at all: the chief, and a city's patrol riders. */
export const mayRide = (p) => p.role === 'patrol' || p.role === 'chief';

/** How many patrol riders a city keeps: none below a city, one to every
    POLICE.per grown people, and no more than it has horses. */
export function patrolsFor(camp, adults) {
  if ((camp.stage || 0) < CITY.at) return 0;
  return Math.min(horsesOf(camp).length, Math.ceil(adults / POLICE.per));
}

/** Where the beat runs: out past the wall (or the edge of a place without one). */
function beatPoint(camp, k) {
  const wall = walls.find((w) => Math.hypot(w.x - camp.x, w.z - camp.z) < 1);
  const r = (wall ? wall.r : campReach(camp)) + POLICE.out;
  const a = (camp.hearthTurn || 0) + (k / POLICE.stops) * Math.PI * 2;
  return { x: camp.x + Math.cos(a) * r, z: camp.z + Math.sin(a) * r };
}

/** The next point on the beat, round from the last one: dry ground, or the one after. */
function pickBeat(p) {
  const camp = p.camp;
  for (let t = 0; t < POLICE.stops; t++) {
    const k = ((p.beat ?? Math.floor(luck() * POLICE.stops)) + 1 + t) % POLICE.stops;
    const q = beatPoint(camp, k);
    if (sampleHeight(q.x, q.z) > SEA + 1 && !inWater(q.x, q.z)) {
      p.beat = k;
      p.targetX = q.x;
      p.targetZ = q.z;
      return true;
    }
  }
  return false;
}

/** How much a patrol rider wants to ride the beat. */
export const patrolWeight = (p, rested) => (p.role === 'patrol' ? POLICE.chance * rested : 0);

/** Out: to the herd, or round the beat. */
export function pickOut(p) {
  return p.job === 'patrol' ? pickBeat(p) : pickHerd(p);
}

/** Done out there. For a patrol rider, a point of the beat: on to the next one
    until they have been once round, and true while they are going on - then,
    like everybody, home. */
export function outDone(p) {
  if (p.job === 'tame') { tameDone(p); return false; }
  practise(p.camp, 'war', POLICE.perStop);
  p.knows.war = Math.max(p.knows.war || 0, p.camp.skill.war);
  p.stops = (p.stops || 0) + 1;
  if (p.stops >= POLICE.round || !pickBeat(p)) { p.stops = 0; return false; }
  p.state = 'goto';
  p.timer = 40 + Math.hypot(p.targetX - p.x, p.targetZ - p.z) / 1.2;
  return true;
}

export const horses = () => packs.find((k) => k.spec.key === 'horse') || null;

/** The horses a band has tamed, alive. */
export function horsesOf(camp) {
  const pack = horses();
  return pack ? pack.list.filter((d) => d.tamed === camp && !d.dead) : [];
}

/** How many a band will keep, for how well it rides. */
export const keeps = (camp) => Math.round(RIDE.kept[0] + (RIDE.kept[1] - RIDE.kept[0]) * (camp.skill?.riding || 0));

/** Where a band keeps its horses: level, dry ground just past its edge, found
    once, round from the side of the camp opposite its first fire. */
export function paddockOf(camp) {
  if (camp.paddock) return camp.paddock;
  const r = campReach(camp) + RIDE.out, from = (camp.hearthTurn || 0) + Math.PI;
  for (let k = 0; k < 24; k++) {
    const a = from + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 12);
    const x = camp.x + Math.cos(a) * r, z = camp.z + Math.sin(a) * r;
    if (sampleHeight(x, z) > SEA + 1.5 && flatnessAt(x, z) > 0.8 && !inWater(x, z)) return (camp.paddock = { x, z });
  }
  return (camp.paddock = { x: camp.x + Math.cos(from) * r, z: camp.z + Math.sin(from) * r });
}

const wildIn = (herd, pack) => pack.list.reduce((n, d) => n + (d.herd === herd && !d.tamed && !d.dead ? 1 : 0), 0);

/** The nearest herd with horses in it to spare, within reach of the camp. */
function herdFor(camp) {
  const pack = horses();
  if (!pack) return null;
  let best = null, near = RIDE.reach;
  for (const h of pack.herds) {
    const d = Math.hypot(h.x - camp.x, h.z - camp.z);
    if (d < near && wildIn(h, pack) >= RIDE.wild) { near = d; best = h; }
  }
  return best;
}

/** How much an afternoon at the herd is wanted: by a grown, fed, rested band
    with room in the paddock and wild horses within reach. */
export function tameWeight(p, hunger, rested) {
  if (p.child || hunger > 0.5) return 0;
  const camp = p.camp;
  if (horsesOf(camp).length >= keeps(camp) || !herdFor(camp)) return 0;
  return RIDE.chance * (1 - hunger) * rested;
}

/** Out to the herd: to where it is grazing, give or take. */
export function pickHerd(p) {
  const h = herdFor(p.camp);
  if (!h) return false;
  p.targetX = h.x + (luck() - 0.5) * 16;
  p.targetZ = h.z + (luck() - 0.5) * 16;
  return true;
}

/** An afternoon at the herd done: the band a little better at it, and now and
    then a horse that will follow them home. */
export function tameDone(p) {
  const camp = p.camp, pack = horses();
  practise(camp, 'riding', RIDE.perTame);
  p.knows.riding = Math.max(p.knows.riding || 0, camp.skill.riding);
  if (!pack || horsesOf(camp).length >= keeps(camp)) return;
  let best = null, near = 45;
  for (const d of pack.list) {
    if (d.tamed || d.dead || d.carcass) continue;
    const dd = Math.hypot(d.x - p.x, d.z - p.z);
    if (dd < near && wildIn(d.herd, pack) >= RIDE.wild) { near = dd; best = d; }
  }
  const v = camp.skill.riding || 0;
  if (!best || luck() > RIDE.odds[0] + (RIDE.odds[1] - RIDE.odds[0]) * v) return;
  const first = horsesOf(camp).length === 0 && !camp.everTamed;
  tame(best, camp);
  if (first) {
    camp.everTamed = true;
    logEvent('learned', `[${camp.code}] ${camp.name} has tamed its first horse`, p.x, p.z);
  }
}

function tame(d, camp) {
  d.tamed = camp;
  d.rider = d.come = d.waitFor = null;
  d.state = 'walk';
  d.timer = 20;
  const pad = paddockOf(camp);
  d.targetX = pad.x;
  d.targetZ = pad.z;
}

const insideWall = (x, z, pad = 0) => walls.find((w) => Math.hypot(x - w.x, z - w.z) < w.r + pad) || null;

/* How long without a word from somebody before a horse decides they are not
   coming: a couple of their turns, however many steps their turns are apart. */
const stale = () => lodStride(people.length) * 2 + 4;

function mount(p, d) {
  d.come = d.waitFor = null;
  d.rider = p;
  p.horse = d;
  p.mounted = true;
  p.rodeStep = worldStep;
  practise(p.camp, 'riding', RIDE.perRide);
  p.knows.riding = Math.max(p.knows.riding || 0, p.camp.skill.riding);
}

function unseat(p, d) {
  if (d && d.rider === p) d.rider = null;
  if (p.horse === d) { p.mounted = false; p.lift = 0; }
}

/** Somebody on their way somewhere, walking at `want`: on a horse if they have
    one under them, and whistling one up if they could use it. Returns the pace
    they actually go at. Called from the step (move.js) for anybody walking. */
export function riding(p, want) {
  want *= p.paceMul || 1;                   // a character's level (roleplay.js)
  let d = p.horse;
  if (d && (d.dead || d.tamed !== p.camp)) { unseat(p, d); p.horse = d = null; }
  const far = Math.hypot(p.targetX - p.x, p.targetZ - p.z);
  // A band that has forgotten how gets down, and so does anybody no longer allowed a horse.
  if (d && d.rider === p && p.mounted && ((p.camp.skill?.riding || 0) < RIDE.from || !mayRide(p))) { unseat(p, d); p.horse = d = null; }
  if (d && d.rider === p && p.mounted) {
    // Getting down before a town's gate, going in: horses stay outside the wall.
    const into = insideWall(p.targetX, p.targetZ);
    if (into && Math.hypot(p.x - into.x, p.z - into.z) < into.r + RIDE.gate) {
      unseat(p, d);
      d.waitFor = null;
      p.horse = null;
      return want;
    }
    p.rodeStep = worldStep;
    /* Sat on its back: the hips at the top of the horse, whatever the legs are
       folded to (the kneeling pose the raft uses, move.js). */
    const spec = horses().spec;
    const back = (spec.legLen + spec.bodyY + spec.body[1] / 2) * d.scale;
    p.lift = back - PERSON.legLen * p.scale * (1 - 0.44 * (p.crouch || 0));
    const v = Math.min(1, Math.max(0, ((p.camp.skill?.riding || 0) - RIDE.from) / (1 - RIDE.from)));
    return Math.min(RIDE.most, want * (RIDE.pace[0] + (RIDE.pace[1] - RIDE.pace[0]) * v));
  }
  if (!mayRide(p) || p.child || p.sick || p.led || p.panic > 0 || p.onRaft || p.climbed || p.hiding || p.prey) return want;
  if ((p.camp?.skill?.riding || 0) < RIDE.from || far < RIDE.worth || insideWall(p.x, p.z, 2)) return want;
  if (insideWall(p.targetX, p.targetZ) && far < RIDE.worth * 2) return want;
  if (d && d.waitFor === p) {
    if (Math.hypot(d.x - p.x, d.z - p.z) < RIDE.mount) mount(p, d);
    else { d.waitFor = null; d.come = p; p.callStep = worldStep; }
    return want;
  }
  if (d && d.come === p) { p.callStep = worldStep; return want; }
  if (d && d.rider !== p) p.horse = d = null;
  const pack = horses();
  if (!pack) return want;
  let best = null, near = RIDE.fetch;
  for (const h of pack.list) {
    if (h.tamed !== p.camp || h.dead || h.rider || h.come || h.waitFor) continue;
    const dd = Math.hypot(h.x - p.x, h.z - p.z);
    if (dd < near) { near = dd; best = h; }
  }
  if (best) { best.come = p; p.horse = best; p.callStep = worldStep; }
  return want;
}

/** What a tamed horse does with itself this step, in place of a wild one's
    grazing and running (updateQuadrupeds, wildlife.js). */
export function tendHorse(d, spec, slice) {
  const camp = d.tamed;
  if (camp.gone || !camps.includes(camp)) {
    // Its band is gone, and so is it: back to the herd.
    if (d.rider) unseat(d.rider, d);
    d.tamed = d.rider = d.come = d.waitFor = null;
    return;
  }
  const r = d.rider;
  if (r) {
    if (worldStep - (r.rodeStep ?? -1e9) > stale() || r.horse !== d) {
      unseat(r, d);
      if (r.horse === d) { d.waitFor = r; d.waitUntil = worldClock + RIDE.wait; }
    } else {
      // Where they are, going where they go: its legs keep time with the ground covered.
      d.x = r.x; d.z = r.z; d.yaw = r.yaw; d.speed = r.speed;
      d.state = 'walk'; d.timer = 5; d.targetX = r.targetX; d.targetZ = r.targetZ;
      d.phase += ((r.speed * slice) / (spec.stride * d.scale)) * Math.PI * 2;
      return;
    }
  }
  if (d.come) {
    const p = d.come;
    if (worldStep - (p.callStep ?? -1e9) > stale() || p.horse !== d) d.come = null;
    else {
      const dd = Math.hypot(p.x - d.x, p.z - d.z);
      // A gallop turns wide and circles whoever it is coming for: the last few metres at a walk.
      d.state = dd > RIDE.near ? 'flee' : 'walk'; d.timer = 5; d.targetX = p.x; d.targetZ = p.z;
      if (dd < RIDE.mount) mount(p, d);
      return;
    }
  }
  if (d.waitFor) {
    const p = d.waitFor;
    const home = Math.hypot(p.x - camp.x, p.z - camp.z) < campReach(camp);
    if (worldClock > d.waitUntil || p.horse !== d || home || insideWall(p.x, p.z, 2)) {
      if (p.horse === d) p.horse = null;
      d.waitFor = null;
    } else {
      const dd = Math.hypot(p.x - d.x, p.z - d.z);
      if (dd > 6) { d.state = 'walk'; d.timer = 10; d.targetX = p.x; d.targetZ = p.z; }
      else if (d.state !== 'graze') { d.state = 'graze'; d.timer = 8; }
      return;
    }
  }
  // Home, in the paddock.
  const pad = paddockOf(camp);
  if (Math.hypot(d.x - pad.x, d.z - pad.z) > RIDE.pen + 4) {
    if (d.state !== 'walk' || Math.hypot(d.targetX - pad.x, d.targetZ - pad.z) > RIDE.pen) {
      d.state = 'walk'; d.timer = 30;
      d.targetX = pad.x + (luck() - 0.5) * RIDE.pen; d.targetZ = pad.z + (luck() - 0.5) * RIDE.pen;
    }
    return;
  }
  d.timer -= slice;
  if (d.timer > 0) return;
  if (d.state === 'graze') {
    const a = luck() * Math.PI * 2, rr = luck() * RIDE.pen;
    d.state = 'walk'; d.timer = 15;
    d.targetX = pad.x + Math.cos(a) * rr; d.targetZ = pad.z + Math.sin(a) * rr;
  } else {
    d.state = 'graze';
    d.timer = spec.graze[0] + luck() * (spec.graze[1] - spec.graze[0]);
  }
}

/** Put back after a save: this many of the nearest wild horses are the band's
    again, and in its paddock. */
export function restoreHorses(camp, n) {
  const pack = horses();
  if (!pack || !(n > 0)) return;
  const wild = pack.list.filter((d) => !d.tamed && !d.dead)
    .sort((a, b) => Math.hypot(a.x - camp.x, a.z - camp.z) - Math.hypot(b.x - camp.x, b.z - camp.z));
  const pad = paddockOf(camp);
  wild.slice(0, n).forEach((d, k) => {
    tame(d, camp);
    d.x = pad.x + Math.cos(k * 2.4) * Math.min(RIDE.pen, 2 + k);
    d.z = pad.z + Math.sin(k * 2.4) * Math.min(RIDE.pen, 2 + k);
  });
}
