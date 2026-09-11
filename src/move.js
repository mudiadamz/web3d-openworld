import * as THREE from 'three';

import { P, QUALITY, SEA, WORLD } from './params.js';
import {
  buildField, clamp, field, fieldCell, fieldSeg, flatnessAt, mulberry32, sampleHeight
} from './noise.js';
import {
  camera, controls, renderer, seasonName, starUniforms, streamMaterial, sunLight, waterUniforms,
  windUniforms
} from './scene.js';
import { roleWeight } from './skills.js';
import { nearestRock,
  HIDDEN, _m4, _q, _s, _v, buildGrass, buildRocks, buildTerrain, buildTrees, buildWater,
  disposeGroup, disposeWorld, fauna, floraGroup, grassGroup, grassTiles, rockGroup,
  setDirtyTiles, setGrassTiles, stats, terrainGroup, updateTiles, world
} from './world.js';
import {
  PANIC, PERSON_STAMINA, RECOVERY_SECONDS, REFEED, SLEEP_SECONDS, STARVE_DRAIN,
  STARVE_FROM, _eAnim, _mChain, _mHead, _mLocal, _mLower, _mOff, _mUpper, _pAnim, _qAnim,
  _sAnim, buildAnimals, clearFauna, energyRate, nearestPredator
} from './wildlife.js';
import { PERSON, SHIN_MAX, drawingWorld, lodStride, lodTurn, luck, pace, partsPer, seedSim, turnStart, worldClock } from './clock.js';
import {
  CAMP_CLEARING, CITY, CIVIC, campReach, HEARTHS, buildCamps, buildGraves, buildNearParts, buildPeople, campParts, camps, chooseCampSites, hideNearParts, homeFire, homeward, inCamp, nearParts, nearestFire, people, personParts, resetSmoke, setPersonParts, smoke, smokeUniforms, tribeGroup
} from './people.js';
import { buildPaths, groundPace, pathSwerve, TREAD, tread } from './paths.js';
import {
  LIFE, DUSK_AT, FISH, FOOD, GROUND, PLAGUE, RAID, SKILL, VISIT, _mBody, _mTorso, arriveAtCamp, buildForaged, campIsIll, craftChoice, findPrey, fishRichness, forageRichness, groundOf, huntReach, otherCamp, personAge, nearestShore, pickFishing, practise, raidTarget, resolveRaid, simDay, takeForage, tryKill, logEvent, updateEconomy
} from './life.js';
import { ORCHARD, nearestFruit, pickFruit } from './orchard.js';
import { followIdx, leadRunning, syncLookFromCamera } from './chronicle.js';
import { renderMapBase } from './map.js';
import {
  DIG_REACH, ORES, buildDeposits, depositRadius, mineDeposit, pickDeposit, quarryInReach, storeOre
} from './quarries.js';
import { BAG, bagAdd, bagKind, bagWords, carryCap, emptyBag, hasLoad, loadOf, loadPace, putIn, takeOut } from './bag.js';
import { chopDone, pickTree, storeWood, woodWant } from './wood.js';
import { exploreWeight, pickFar, surveyDone } from './explore.js';
import { pileWords, putDown, removeDrop } from './drops.js';
import { takeCarcass, throwSpear } from './spear.js';
import { boardRaft, landRaft, moorRaft, raftBusy, raftStep, raftTrip } from './rafts.js';
import { dockOf } from './larder.js';
import { buildThickets } from './thickets.js';
import { CLIMB_HEIGHT, CLIMB_REACH, CRAWL } from './danger.js';
import {
  CLOTH, HEAD_GROUPS, SHINS, SLEEVES, THIGHS, animalSize, cargoKey, clearLooks, clothingGrade, fitOf, flushLooks,
  headKey, looks, tunicKey, undress, wear
} from './looks.js';
import { atHome, eat, lifeWant, restBoost, spendLife } from './vitals.js';
import { arm } from './ui.js';
import { updateHud } from './main.js';
import { traceStreams, carveStreams, buildStreamWater } from './creeks.js';
import { farmDone, farmSite, farmWeight } from './farming.js';
import { jobMix } from './society.js';

/* -------------------------------------------------------------------------
   Getting there

   There is no path-finding here and there does not need to be, but there does
   need to be more than a step test. A person walked straight at their target
   and, if the next step was too steep, stopped and picked an entirely new
   errand — which had two consequences, both of them visible:

     - somebody in a steep pocket could never leave it. Every direction failed,
       so every frame was blocked, re-aim, blocked, and they stood there for
       the rest of their life;
     - the new errand was picked around their OWN camp, so anybody walking to
       the next band was sent home by the first bump in the ground. Camps are at
       least two hundred and sixty metres apart. Nobody ever arrived.

   So: try the way you are facing, and if it will not go, try further and
   further off it until something will. Walking round a hill is what a person
   does; giving up and going home is not.
   ------------------------------------------------------------------------- */

export const WALKABLE = 0.66;          // flatness a person will put a foot on

/* How far off their heading somebody will step to get round something, and how
   long they stay committed to the side they picked.

   Both numbers exist because of the same bug. The first version tried deviations
   up to 149° — which is not a detour, it is walking away — and re-chose one
   every frame. So somebody blocked took a near-reversal, the turn toward their
   target pulled them straight back into the same ground, and they reversed
   again: back and forth, all night, never arriving. Anybody walking to the next
   band, two hundred and sixty metres off, could never get there.

   Nothing here goes past a hundred degrees, and having picked a side they keep
   it for a few seconds — which is the difference between bouncing off an
   obstacle and following it round. */
export const DETOURS = [0.30, 0.62, 0.98, 1.40, 1.75];
export const DODGE_HOLD = 3;           // world-seconds committed to one side

export function canStand(x, z, flat = WALKABLE) {
  return sampleHeight(x, z) > SEA + 0.9
    && flatnessAt(x, z) > flat
    && Math.hypot(x, z) < WORLD * 0.46;
}

/* Moves them if it can, and reports whether it managed. The heading they end up
   with is kept, so somebody rounding a spur keeps following it instead of
   turning back into it on the next frame. */
export function stepPerson(p, step) {
  const tryAt = (a, flat) => {
    const nx = p.x + Math.sin(a) * step, nz = p.z + Math.cos(a) * step;
    if (!canStand(nx, nz, flat)) return false;
    /* Where the wear goes in, and the only place it can: this is the one
       function in the world that moves a person, so a path is exactly the
       ground people got across — not the ground they aimed at. Somebody who
       spends the whole errand blocked by a spur wears the way round it, which
       is what a path round a spur is. */
    tread(p.x, p.z, nx, nz);
    p.x = nx; p.z = nz; p.yaw = a;
    p.phase += (step / (PERSON.stride * p.scale)) * Math.PI * 2;
    return true;
  };

  // Straight on. If that works, whatever was in the way is behind them.
  if (tryAt(p.yaw, WALKABLE)) { p.dodgeUntil = 0; return true; }

  /* Round it, on the side already chosen if one is still being held. Trying
     both sides afresh every frame is how a person ends up zig-zagging along a
     slope instead of walking along it. */
  const held = (p.dodgeUntil || 0) > worldClock;
  const sides = held ? [p.dodgeSide || 1] : [1, -1];
  for (const off of DETOURS) {
    for (const side of sides) {
      if (tryAt(p.yaw + side * off, WALKABLE)) {
        p.dodgeSide = side;
        p.dodgeUntil = worldClock + DODGE_HOLD;
        return true;
      }
    }
  }
  // The held side has run out of room: the other way, and commit to that.
  if (held) {
    for (const off of DETOURS) {
      if (tryAt(p.yaw - (p.dodgeSide || 1) * off, WALKABLE)) {
        p.dodgeSide = -(p.dodgeSide || 1);
        p.dodgeUntil = worldClock + DODGE_HOLD;
        return true;
      }
    }
  }

  /* Boxed in on every heading. Rather than stand there for ever, take one step
     onto ground they would not normally choose — this is the way out of a
     pocket, and it is why nobody gets stuck permanently. */
  for (const off of [0, ...DETOURS]) {
    for (const side of [1, -1]) {
      if (tryAt(p.yaw + side * off, 0.30)) return true;
    }
  }
  return false;
}

/* How long to allow for the walk. A flat sixty seconds was allowed for every
   errand whatever its length, and a lot of errands are longer than that: the
   far half of a foraging trip, most long hunts, and every single visit to the
   next band, which is two hundred and sixty metres away and therefore three
   minutes off. They all timed out on the way — and the timeout falls through to
   the arrival case, so the work got done wherever they happened to be standing.

   Doubled and a bit, because going round a hill is the normal case rather than
   the exception. */
/* Points somebody at home: the granaries if they are carrying food, their own
   fire if not. Two draws from the stream whichever it is, the same two the
   fire always took, so a band carrying nothing walks exactly as it did. */
function aimHome(p, spread) {
  const to = homeward(p, spread);
  p.targetX = to.x + (luck() - 0.5) * to.spread;
  p.targetZ = to.z + (luck() - 0.5) * to.spread;
}

/* -------------------------------------------------------------------------
   Doing it yourself, in the step

   E leaves an act on the person (actHere, in chronicle.js); the next turn
   starts it here. It is the errand of the same name, done where they stand: the
   same work state, the same yields at the end of it from the same ground, the
   tools making it quicker the same way. A spear is thrown at once. What is
   different is afterwards — see endAct.
   ------------------------------------------------------------------------- */
/* Cold, for the person you are playing: out in the open, resting does less at
   night and less again in winter. The band's own people are not touched — the
   balance they live by was set without it. */
export const COLD = { night: 0.6, winter: 0.5 };
export function coldFactor(p, day) {
  if (!p.led || inCamp(p.x, p.z, 0)) return 1;
  const raw = (day < 0.3 ? COLD.night : 1) * (seasonName === 'winter' ? COLD.winter : 1);
  // Clothes keep some of it out (SKILL.clothWarm): what the band can sew, they wear.
  return 1 - (1 - raw) * (1 - SKILL.clothWarm * (p.camp?.skill?.clothing || 0));
}

/* How much of their pace what they carry leaves them. The band's own foragers
   keep the flat fifth off a walk they always had: they carry one trip's worth
   and no more, and they have no way to put a load down, so a load that could
   stop them would stop them for good. Somebody you are playing carries what
   you give them, and it weighs what it weighs. */
export function carryFactor(p) {
  if (!p.led) return 0.8;
  return loadPace(loadOf(p), carryCap(p, SKILL.basketHaul, p.camp.skill?.baskets || 0));
}

/** At or past what they can carry: they cannot walk — though what is in
    reach they can still do, and G puts it down a handful at a time. */
export function tooHeavy(p) {
  return loadOf(p) >= carryCap(p, SKILL.basketHaul, p.camp.skill?.baskets || 0);
}

/* Everything they are carrying, into the camp: the food into the store, the
   ore onto the pile. Where every walk home ends, and where E at the granary
   ends — one unloading, so the two cannot come to disagree about what putting
   it away means. */
function bankLoad(p) {
  /* Ore to the camp's pile rather than the store: nobody eats it. */
  if (p.bag?.ore > 0) {
    storeOre(p.camp, p.bag.oreKind || 'stone', p.bag.ore);
    p.bag.ore = 0;
    p.bag.oreKind = null;
  }
  // Wood onto the camp's stack, where a raft is built from it (wood.js).
  if (p.bag?.wood > 0) { storeWood(p.camp, p.bag.wood); p.bag.wood = 0; }
  /* Remembered for the moment they stand here after, which is the
     bubble saying they are putting it away. */
  p.stowed = p.haul > 0;
  if (p.haul > 0) {
    p.camp.food += p.haul;
    /* Kept per person as well as added to the store. The store is what
       the band has; this is what each of them put into it, which is a
       different and more interesting number — it is the difference
       between a good hunter and somebody who mostly tends the fire. */
    p.brought = (p.brought || 0) + p.haul;
    p.haul = 0;
    emptyBag(p);
  }
  p.carry = 0;
}

export const ACT_TIME = { gather: 3.5, fish: 4.5, quarry: 5, tend: 3, hunt: 1, wood: 5 };

function startAct(p) {
  const a = p.act;
  if (!a || !p.led || p.acting) return;
  /* Putting it away is not an errand: it is done the moment they are told,
     where they stand, and said the frame after. */
  if (a.kind === 'store') {
    if (hasLoad(p)) {
      const said = bagWords(p.bag) || 'what they carried';
      bankLoad(p);
      p.actResult = 'put away ' + said;
    }
    return;
  }
  /* Put down, a handful at a time — or all of it — in front of where they
     stand, as a pile that stays there and can be picked up again. */
  if (a.kind === 'drop') {
    let first = null;
    for (;;) {
      const out = takeOut(p);
      if (!out) break;
      putDown(p, out);
      if (!first) first = out;
      if (!a.all) break;
    }
    if (first) p.actResult = a.all ? 'put it all down' : 'put down ' + pileWords(first);
    return;
  }
  // Something they brought down, onto the shoulder.
  if (a.kind === 'carcass') { takeCarcass(p, a.carcass); return; }
  // The band's raft, out from its dock and back to it (rafts.js).
  if (a.kind === 'raft' || a.kind === 'moor') { p.actResult = a.kind === 'raft' ? boardRaft(p) : moorRaft(p); return; }
  /* Picked back up, the whole pile, into the basket as it came out of it. */
  if (a.kind === 'pickup') {
    const pile = a.pile;
    if (pile) {
      putIn(p, pile);
      removeDrop(pile);
      p.actResult = 'picked up ' + pileWords(pile);
    }
    return;
  }
  /* Sitting down to rest, and up again: resting pays back energy faster than
     standing about, and faster still at home (vitals.js). */
  if (a.kind === 'rest') {
    p.resting = !p.resting;
    if (p.resting) { p.speed = 0; p.hiding = false; }
    p.actResult = !p.resting ? 'up from resting' : atHome(p) ? 'resting at home' : 'resting — faster at home';
    return;
  }
  // A meal: out of the store at home, out of the basket anywhere.
  if (a.kind === 'eat') {
    p.actResult = eat(p);
    return;
  }
  /* Taking cover: up the tree they are at, or down where they stand — and
     the same again to come down, or to stand. Allowed under any load: a tiger
     does not wait for somebody to put their basket down. */
  if (a.kind === 'cover') {
    p.resting = false;
    if (p.climbed) { p.climbed = null; p.lift = 0; p.actResult = 'down from the tree'; }
    else if (p.hiding) { p.hiding = false; p.actResult = 'up from cover'; }
    else if (a.tree && Math.hypot(a.tree.x - p.x, a.tree.z - p.z) < CLIMB_REACH + 0.5) {
      p.climbed = a.tree;
      p.lift = CLIMB_HEIGHT;
      p.x = a.tree.x + 0.35;
      p.z = a.tree.z;
      p.leadX = p.x;
      p.leadZ = p.z;
      p.speed = 0;
      p.actResult = 'up a tree';
    } else {
      p.hiding = true;
      p.speed = 0;
      p.actResult = 'hiding — keep still';
    }
    return;
  }
  /* Too heavy to walk is not too heavy to do anything: what is in reach can
     still be done. Walking is what a load stops (carryFactor). */
  let job = null;
  if (a.kind === 'hunt') { job = 'hunt'; throwSpear(p, a.prey); }
  else if (a.kind === 'dig') { if (a.deposit && a.deposit.left > 0) { job = 'quarry'; p.digging = a.deposit; } }
  else if (a.kind === 'fish' || a.kind === 'tend' || a.kind === 'gather' || a.kind === 'wood') job = a.kind;
  if (!job) return;
  p.resting = false;
  p.acting = true;
  p.job = job;
  p.state = 'work';
  p.prey = null;
  p.visiting = null;
  p.hasSpear = job === 'hunt';
  p.targetX = p.x;
  p.targetZ = p.z;
  p.timer = ACT_TIME[job] * (1 - SKILL.toolSpeed * (p.camp.skill?.tools || 0));
}

/* Done, and still yours: nobody walks them home with it, because you are
   still holding their hand. They stand where they did it, led, until you
   point them somewhere or let go. */
function endAct(p) {
  p.acting = false;
  p.hasSpear = false;
  p.job = 'led';
  p.state = 'goto';
  p.leadX = p.x;
  p.leadZ = p.z;
  p.timer = 0;
}

export function travelTimeout(p) {
  const dist = Math.hypot(p.targetX - p.x, p.targetZ - p.z);
  const pace = (p.job === 'hunt' || p.job === 'play') ? PERSON.jog * 0.8 : PERSON.walk;
  return clamp((dist / pace) * 2.2, 20, 900);
}

/* How hard a forager looks before choosing where to go.

   Everything is weighed in the same unit — food — because the first cut of this
   was not, and it was worse than walking out blindfolded. It sent them to a
   bearing tree six times out of ten whatever the ground there was like, and a
   tree is worth about a tenth of a unit against half a unit for good ground. On
   poor ground a tree is a loss, and preferring it was optimising for the thing
   that is easy to see rather than the thing that is worth having. */
export const FORAGE = {
  tries: 14,           // patches of open ground weighed up
  fruitTries: 4,       // and bearing trees, weighed the same way
  farCost: 0.08,       // food per hundred metres, so distance is a tiebreak
  helpFrom: 8,         // years; old enough to go out with the others
  childHaul: 0.40,     // what an eight-year-old brings back, against an adult's basket
  childGrown: 0.90,    // and a thirteen-year-old, nearly grown
  childRange: 0.55,    // and how far from the fire they will go
  ringFeeds: 14,       // people the 95 m ring round a fire feeds with food to spare
  ringMax: 2.5,        // and how many times that far a big band will walk
  /* What a fed band still does. Foraging and hunting are the daily round of
     people who live off the land, not an emergency: they go out whether the
     store is full or not, and hunger sends more of them. With nothing but
     hunger behind them, a band whose fields and flock kept the store full
     spent its days knapping and sitting at the fire — 14% of its errands were
     foraging and 7% hunting, against 41% knapping and 38% at the fire. */
  routine: 0.28,       // foraging's weight when nobody is hungry
  huntRoutine: 0.14,   // and hunting's
};

/* What a child's hands are worth against an adult's, rising with age. It was
   a flat 0.55 from eight to fourteen, so a boy a year off being a man brought
   home no more than his little sister — and a band full of children was
   carried by its adults for six years longer than it had to be. */
export function childWorth(p) {
  if (!p.child) return 1;
  const t = clamp((personAge(p) - FORAGE.helpFrom) / (LIFE.adultAt - 1 - FORAGE.helpFrom), 0, 1);
  return FORAGE.childHaul + (FORAGE.childGrown - FORAGE.childHaul) * t;
}

/* How far out a band goes for its food, against the 95 metres a small one
   needs. The ring was the same whatever the band's size, and it was what capped
   them: recorded, a band of twelve to fifteen held 6.4 days of store and one of
   twenty-eight held 4.3, and the big ones starved out one by one over a century.
   The ground a band needs grows with the mouths it feeds, so the reach grows
   with the square root of them — until it runs into the neighbours'. */
export function groundFor(camp) {
  return clamp(Math.sqrt((camp.pop || 1) / FORAGE.ringFeeds), 1, FORAGE.ringMax);
}

/* Where to forage. It used to be a random point between twenty-six and
   ninety-five metres from camp, checked only for not being sea or cliff — and
   since a forager can reach fruit within seven metres, landing on any was pure
   luck. The ground is not uniform and the fruit is certainly not; a band can
   starve beside a wood full of food. */
/* -------------------------------------------------------------------------
   Knowing where the food is

   Every foraging trip picked fourteen spots at random in a ring round the camp
   and walked to the best of them. Which means a band that has lived in one
   valley for forty years is no better at feeding itself than one that arrived
   this morning — the best of fourteen random guesses, over and over, for ever.
   That is not how anybody has ever foraged. You go back to where the food was.

   So a camp keeps a short list of the places that paid. A trip weighs those
   alongside a handful of fresh guesses, so there is always some looking about;
   what a patch is remembered as being worth decays every time it is picked
   over and is written up again from what the trip actually brought home, so a
   place that stops paying stops being remembered.

   The list is deliberately short. A band that remembers thirty patches is a
   band that never explores, and the whole value of the memory is that it beats
   guessing — not that it replaces walking around. */

export const MEMORY = {
  keep: 6,             // patches a band holds on to
  fresh: 6,            // fresh guesses weighed against them on every trip
  trust: 1.25,         // how much better a remembered patch looks than a guess
  forget: 0.82,        // what a patch is worth next time, before it is re-rated
};

/** Remembered ground, best first, with anything worthless dropped. */
export function rememberPatch(camp, x, z, worth) {
  if (!camp.patches) camp.patches = [];
  const near = camp.patches.find((q) => Math.hypot(q.x - x, q.z - z) < 18);
  if (near) {
    // The same place, rated again by what it just gave up.
    near.worth = near.worth * 0.5 + worth * 0.5;
    near.x = x; near.z = z;
  } else {
    camp.patches.push({ x, z, worth });
  }
  camp.patches.sort((a, b) => b.worth - a.worth);
  if (camp.patches.length > MEMORY.keep) camp.patches.length = MEMORY.keep;
}

export function pickForage(p, camp, range) {
  let bx = camp.x, bz = camp.z, best = -Infinity, found = false;

  const consider = (x, z, fruit, known = 1) => {
    if (sampleHeight(x, z) < SEA + 1.5) return;
    if (flatnessAt(x, z) < 0.80) return;
    if (Math.hypot(x, z) > WORLD * 0.44) return;
    const away = Math.hypot(x - camp.x, z - camp.z);
    /* What this trip is expected to be worth, less what the walk costs. The
       fruit term is what they would actually strip off the tree, in the same
       units as the ground — which is the whole point of doing it this way. */
    /* Somebody else's ground is worth less than it is — the walk home past
       their fire is not worth the basket. A hungry band stops caring, which is
       exactly when the two of them start to be a problem for each other. */
    const theirs = groundOf(x, z, camp) ? GROUND.shy * (1 - camp.hunger) : 0;
    /* A guess at what it is worth, not a measurement of it. Two foragers
       leaving the same fire at the same moment read the same numbers off the
       same ground and walked to the same spot, every time, for ever — which is
       a band with one opinion rather than twenty people. The jitter is small
       enough that a good patch still usually wins and large enough that a
       close second sometimes does, which is the difference between a band that
       works a hillside and a band that works one bush. */
    const guess = 0.78 + luck() * 0.44;
    const value = ((FOOD.gather * forageRichness(x, z) + fruit) * (1 - theirs) * known
      - (away / 100) * FORAGE.farCost) * guess;
    if (value > best) { best = value; bx = x; bz = z; found = true; }
  };

  // Trees known to be bearing...
  const fruitWorth = ORCHARD.takes * ORCHARD.worth;
  for (let t = 0; t < FORAGE.fruitTries; t++) {
    const spot = nearestFruit(camp.x, camp.z, range[1]);
    if (spot) consider(spot.x, spot.z, fruitWorth);
  }
  /* Where it paid before. Weighted up a little, because a place somebody has
     actually come back from with a full basket is worth more than a guess that
     looks the same on paper. */
  for (const q of camp.patches || []) {
    consider(q.x, q.z, 0, MEMORY.trust);
  }
  // ...and a look about, so a band never stops finding new ground.
  for (let t = 0; t < MEMORY.fresh; t++) {
    const a = luck() * Math.PI * 2;
    const r = range[0] + luck() * (range[1] - range[0]);
    consider(camp.x + Math.cos(a) * r, camp.z + Math.sin(a) * r, 0);
  }

  p.targetX = bx; p.targetZ = bz;
  return found;
}

export function pickWork(p) {
  const camp = p.camp;
  /* How far somebody is willing to be from the fire. The bold go out to ground
     nobody has stripped and come back with more; they are also who a tiger
     finds. Errands round the camp are not stretched — walking further to sit
     down is nobody's idea of daring. */
  const far = (p.traits?.bold ?? 1) * (p.child ? FORAGE.childRange : 1);
  const range = p.job === 'hunt' ? [90 * far, 260 * far]
    : p.job === 'gather' ? [26 * (p.child ? FORAGE.childRange : 1), 95 * far * groundFor(camp)]
    : p.job === 'tend' ? FIRESIDE : [2, 9];
  if (p.job === 'gather') return pickForage(p, camp, range);
  /* The water's edge. Found once for the camp rather than per trip — a coast
     does not move, and searching for it every time somebody feels like fishing
     is forty samples an errand for an answer that was the same yesterday. */
  if (p.job === 'fish') {
    // Down to the band's dock: the raft is where the fishing starts (rafts.js).
    const at = camp.raft ? dockOf(camp) : null;
    if (at) {
      p.targetX = at.x;
      p.targetZ = at.z;
      return true;
    }
    p.job = 'gather';                     // landlocked, or no raft yet: the hillside then
  }
  /* Somebody else's fire. The same walk a visit is, and deliberately so: it is
     the same hill, the same daylight and the same distance, and the only thing
     that differs is what happens on arrival. */
  if (p.job === 'raid') {
    const mark = raidTarget(camp);
    if (mark) {
      p.raiding = mark;
      p.targetX = mark.x + (luck() - 0.5) * 6;
      p.targetZ = mark.z + (luck() - 0.5) * 6;
      gatherWarParty(p, mark);
      return true;
    }
    p.job = 'gather';                     // nobody worth it: eat instead
  }
  /* A deposit, chosen: any with something left in it that is worth this
     band's walk, weighed by what it is and how far. Rolled rather than the
     nearest, so a band works the stone by its door and, now and then, walks to
     the iron over the ridge — and bands sharing a hillside do not all dig one
     hole. They stand at the edge of the heap, not inside it. */
  if (p.job === 'quarry') {
    const d = pickDeposit(camp, luck, (camp.stone || 0) >= SKILL.stoneMax);
    if (d) {
      const a = luck() * Math.PI * 2, r = depositRadius(d) + 0.8;
      p.digging = d;
      p.targetX = d.x + Math.cos(a) * r;
      p.targetZ = d.z + Math.sin(a) * r;
      return true;
    }
    p.job = 'craft';                      // nothing within reach: something else
  }
  // Far out into the emptiest country they can see (explore.js).
  if (p.job === 'explore') { if (pickFar(p, camp, luck)) return true; p.job = 'gather'; }
  // A tree, for wood (wood.js): to the foot of it.
  if (p.job === 'wood') {
    const t = pickTree(camp, luck);
    if (t) { p.targetX = t.x + 1.1; p.targetZ = t.z; return true; }
    p.job = 'gather';
  }
  // Along the rows of the band's field (farming.js).
  if (p.job === 'farm') return farmSite(p);
  /* To a stall at the market (a city's), in front of it rather than in it. */
  if (p.job === 'market') {
    const m = camp.outer?.civic?.market;
    if (m) {
      const a = (((luck() * CIVIC.stalls) | 0) / CIVIC.stalls) * Math.PI * 2 + m.face;
      p.targetX = m.x + Math.sin(a) * (CIVIC.stallOut - 1.3);
      p.targetZ = m.z + Math.cos(a) * (CIVIC.stallOut - 1.3);
      return true;
    }
    p.job = 'tend';
  }
  // A city's children play in its square as often as round their fire.
  if (p.job === 'play' && camp.outer?.civic?.market && luck() < 0.5) {
    const m = camp.outer.civic.market, a = luck() * Math.PI * 2, r = 1.2 + luck() * 2;
    p.targetX = m.x + Math.cos(a) * r;
    p.targetZ = m.z + Math.sin(a) * r;
    return true;
  }
  /* The stones, and a step short of them: standing among the graves rather than
     at the edge of them is the difference between visiting and trampling. */
  if (p.job === 'mourn' && camp.barrow) {
    const a = luck() * Math.PI * 2, r = 2.5 + luck() * 2.5;
    p.targetX = camp.barrow.x + Math.cos(a) * r;
    p.targetZ = camp.barrow.z + Math.sin(a) * r;
    return true;
  }
  for (let t = 0; t < 14; t++) {
    const a = luck() * Math.PI * 2;
    const r = range[0] + luck() * (range[1] - range[0]);
    const x = camp.x + Math.cos(a) * r, z = camp.z + Math.sin(a) * r;
    if (sampleHeight(x, z) < SEA + 1.5) continue;
    if (flatnessAt(x, z) < 0.80) continue;
    if (Math.hypot(x, z) > WORLD * 0.44) continue;
    p.targetX = x; p.targetZ = z;
    return true;
  }
  p.targetX = camp.x; p.targetZ = camp.z;
  return false;
}

/* Going to market: how much of a city's day is spent at its stalls. */
export const MARKET = { chance: 0.22 };

export function chooseJob(p, day) {
  /* What they were at before this one. Kept for the caption and nothing else:
     "walking to the fire" says where somebody is going and leaves out the half
     you can see them doing, which is coming back from somewhere. One field, set
     in the one place a job is chosen. */
  if (p.job) p.came = p.job;
  if (day < 0.25) {
    // Night: the fire, or a hut.
    p.job = luck() < 0.55 ? 'sleep' : 'tend';
    // Their own hearth, not the village's middle — see homeFire.
    p.targetX = p.job === 'sleep' ? p.hut.x : homeFire(p).x + (luck() - 0.5) * 4;
    p.targetZ = p.job === 'sleep' ? p.hut.z : homeFire(p).z + (luck() - 0.5) * 4;
    p.hasSpear = false;
    return;
  }
  if (p.sick) {
    // Nobody ill goes out. They lie up, and the band carries them.
    p.job = luck() < 0.6 ? 'sleep' : 'tend';
    p.targetX = p.job === 'sleep' ? p.hut.x : homeFire(p).x + (luck() - 0.5) * 4;
    p.targetZ = p.job === 'sleep' ? p.hut.z : homeFire(p).z + (luck() - 0.5) * 4;
    p.hasSpear = false;
    p.prey = null;
    return;
  }
  if (p.child) {
    /* Old enough to be useful. A band was carried entirely by its adults while
       every child under fourteen played, which is nobody's childhood and it is
       most of why a band with a good year of births then starved: it had added
       mouths and no hands. From FORAGE.helpFrom they go out with the others —
       not far, and they do not bring back an adult's basket, but they feed
       themselves and a bit more. And it is the hungrier the band is, the more
       of them go, which is exactly the way round it should be. */
    const old = personAge(p) >= FORAGE.helpFrom;
    const pull = old ? 0.25 + 0.55 * p.camp.hunger : 0;
    p.job = luck() < pull ? 'gather' : luck() < 0.75 ? 'play' : 'tend';
    if (p.job === 'gather') {
      p.hasSpear = false;
      p.prey = null;
      return;
    }
  } else {
    /* This is the whole feedback loop. With a full store people knap, tend the
       fire and rest; as it empties they go out, and by the time it is empty
       almost everyone is foraging or hunting. */
    const hunger = p.camp.hunger;
    /* Energy decides what is even on offer. Going out is the expensive choice
       and hunting the most expensive of all, so someone who has been running
       all morning stays in and knaps — and hunger pushes them out anyway, which
       is how a band ends up sending exhausted people after deer. */
    const rested = clamp(p.energy, 0, 1);
    /* Resting is only worth anything if there is something to recover ON. With
       an empty store the nourishment ceiling is down, so sitting by the fire
       cannot put energy back — and weighting rest by tiredness alone sent a
       starving band to sit down and die. Measured before the change: a starving,
       weak band spent 58% of its time at the fire and 2% of it hunting. */
    const restWorth = (1 - rested) * (1 - hunger);
    /* Walking to the next band is a day gone, so it is a thing a camp does
       when it can spare somebody — or when it is desperate enough to go and
       ask. Both ends of the range, nothing in the middle. */
    /* And only with the day left to do it in. The next band is a few hundred
       metres off — the better part of an hour's walk there and back — and dusk
       sends everybody home from wherever they have got to. Somebody setting out
       at four in the afternoon is somebody who will be turned round halfway and
       never arrive, which is what happened every time. */
    let ill = 0;
    for (const q of people) if (q.camp === p.camp && q.sick) ill++;
    const host = otherCamp(p.camp);
    const enough = host
      ? (Math.hypot(host.x - p.camp.x, host.z - p.camp.z) * 2 / PERSON.walk) * 1.4
      : 0;
    const daylightLeft = (DUSK_AT - P.time) / 24 * P.dayLength;
    /* And nobody walks to the neighbours out of a camp that has it. Which is
       not what stops it travelling — somebody who left before it showed still
       carries it — but it is what makes that the only way it travels. */
    const canVisit = host && rested > 0.5 && daylightLeft > enough
      && !campIsIll(p.camp)
      && (hunger < 1 - VISIT.needFood || hunger > VISIT.begFrom);
    const weights = [
      /* Hunger lifts foraging whatever state they are in. Walking is below the
         pace that costs anything, so somebody with nothing left can still walk
         out and pick — it is the one useful thing they can still do, and it was
         the thing tiredness was suppressing. */
      ['gather', (FORAGE.routine + 0.54 * hunger) * (0.3 + 0.7 * rested + 0.7 * hunger)],
      /* Hunting still wants a rested body, because it is a jog and a throw —
         but a starving band will try it anyway rather than not eat. */
      ['hunt', (FORAGE.huntRoutine + 0.28 * hunger) * Math.max(rested * rested, 0.25 * hunger)],
      ['craft', 0.30 * (1 - hunger)],
      /* Less of the fed afternoon at the fire than there was: that time goes
         to the daily round above. */
      ['tend', 0.06 + 0.12 * (1 - hunger) + 0.5 * restWorth],
      /* Sitting with whoever is ill. Weighted by how many of them there are
         and how much is in the store — a band with nothing to eat cannot spare
         anybody to nurse, which is the same band the sickness is worst in. */
      ['nurse', ill > 0 && !p.child
        ? (0.35 + 0.40 * Math.min(ill / 3, 1)) * (1 - hunger) * rested
          * (p.traits?.sociable ?? 1) : 0],
      ['visit', canVisit ? VISIT.chance * rested * (p.traits?.sociable ?? 1) : 0],
      /* The market, in a city that has one (people.js): a morning at the stalls. */
      ['market', p.camp.outer?.civic?.market ? MARKET.chance * rested * (p.traits?.sociable ?? 1) : 0],
      /* Going back to the stones. Only where there are any — a band that has
         buried nobody has nowhere to go — and never on an empty store: this is
         the first thing a hungry band stops doing, and the fact that it is the
         first thing to go is most of what makes it worth having. */
      ['mourn', p.camp.buried > 0 && !p.child ? MOURN.chance * (1 - hunger) * rested : 0],
      /* Going to the rocks. Not while hungry — stone does not feed anybody
         today — and not while the pile is already high, because a band with
         forty stones does not need a forty-first. It is the errand a comfortable
         band sends people on, which is what it should be. The metals are the
         exception: nothing uses them up, so a band with a seam in reach goes on
         digging it after the stone pile is full, until the seam is worked out. */
      ['quarry', !p.child && quarryInReach(p.camp, (p.camp.stone || 0) >= SKILL.stoneMax)
        ? QUARRY_TRIP.chance * (1 - hunger) * rested : 0],
      /* Out for wood: with a raft to build, or the stack by the granaries low.
         Not while hungry, like the rocks — a log does not feed anybody today. */
      ['wood', !p.child ? woodWant(p.camp) * (1 - 0.7 * hunger) * rested : 0],
      ['explore', exploreWeight(p, hunger, rested)],       // the bold, far out (explore.js)
      /* To the field (farming.js): ditches and water until the band can
         irrigate, then a crop — something a fed band learns and a hungry one
         leans on once it pays. */
      ['farm', farmWeight(p, hunger, rested)],
      /* Going to take it. Only past the hunger at which a band would rather
         walk over and ask, only if there is somebody near enough holding
         enough, and only if this band has not just tried — see RAID. A warrior
         is who goes, but a starving band sends whoever it has. */
      /* Standing in the water. Worth it when the ground is poor, which is
         most of what a coast is for: a band whose hillside is picked over or
         under snow still has the sea. */
      ['fish', p.camp.raft && !raftBusy(p.camp) ? FISH.chance * (0.4 + 0.9 * hunger) * rested : 0],
      ['raid', !p.child && hunger > RAID.hungry && rested > 0.4
        && simDay - (p.camp.lastRaid ?? -99) > RAID.every && raidTarget(p.camp)
        ? RAID.chance * hunger * rested * (p.role === 'warrior' ? 2.5 : 1) : 0],
    ];
    /* A role leans the whole list before anything is rolled: it multiplies the
       job it belongs to and zeroes the ones it refuses, so the chief does not
       spend the morning on the hill and the knapper is usually knapping. A band
       too small or too hungry to afford roles has none, and this does nothing
       at all — see assignRoles. */
    if (p.role) for (const w of weights) w[1] *= roleWeight(p, w[0]);
    /* And the stage the settlement has reached leans it again (society.js):
       fewer foraging, more at the fields, the workshop, the neighbours and the
       war band as it climbs — unless it is hungry, which undoes all of it. */
    for (const w of weights) w[1] *= jobMix(p.camp, w[0], hunger);
    let roll = luck() * weights.reduce((a, w) => a + w[1], 0);
    p.job = weights.find(([, w]) => (roll -= w) <= 0)?.[0] || 'gather';
  }
  setOut(p);
}

/* Given the job, point them at something to do it on. This was the tail of
   chooseJob and is now its own thing, because an order from the panel needs
   exactly this and none of the choosing above it.

   It draws from `luck()`, so it may only ever be called from inside the step —
   see the note on the stream in clock.js. That is why an order is left on the
   person for their next turn to pick up rather than acted on where it is
   given. */
/* A raid is a war party, not one hungry person walking into somebody's camp.
   Whoever decides on it takes others — the band's warriors first, then whoever
   is at home and able — up to a quarter of its adults and never more than
   RAID.party, and they set out at once, so they arrive together. The first to
   get there settles it for all of them. */
const AT_HOME = new Set(['tend', 'craft']);
function gatherWarParty(leader, mark) {
  const camp = leader.camp;
  let adults = 0;
  const free = [];
  for (const q of people) {
    if (q.camp !== camp || q.child) continue;
    adults++;
    if (q === leader || q.sick || q.led || q.acting || q.asleep || q.job === 'raid') continue;
    if (q.state === 'idle' || AT_HOME.has(q.job)) free.push(q);
  }
  free.sort((a, b) => (b.role === 'warrior') - (a.role === 'warrior'));
  const take = Math.min(RAID.party - 1, Math.max(0, Math.round(adults / 4) - 1), free.length);
  for (let k = 0; k < take; k++) {
    const q = free[k];
    q.job = 'raid';
    q.raiding = mark;
    q.hasSpear = true;
    q.prey = null;
    q.visiting = null;
    q.state = 'goto';
    q.targetX = mark.x + (luck() - 0.5) * 8;
    q.targetZ = mark.z + (luck() - 0.5) * 8;
    q.timer = travelTimeout(q);
  }
  logEvent('raid', `[${camp.code}] ${camp.name} set out to raid [${mark.code}] ${mark.name}, ${take + 1} strong`,
    camp.x, camp.z);
}

export function setOut(p) {
  // A spear for the hunt, and for a raid.
  p.hasSpear = p.job === 'hunt' || p.job === 'raid';
  p.prey = null;
  if (p.job === 'visit') {
    const host = otherCamp(p.camp);
    if (host) {
      p.visiting = host;
      p.targetX = host.x + (luck() - 0.5) * 8;
      p.targetZ = host.z + (luck() - 0.5) * 8;
      return;
    }
    p.job = 'tend';
  }
  if (p.job === 'hunt') {
    // Set off after something real, not toward a random point on the map.
    const prey = findPrey(p.x, p.z, huntReach(p.camp));
    if (prey) {
      p.prey = prey;
      p.targetX = prey.animal.x;
      p.targetZ = prey.animal.z;
      return;
    }
  }
  pickWork(p);
}

/* -------------------------------------------------------------------------
   Indoors

   A camp of a hundred and forty was a hundred and forty figures standing in a
   clearing seventeen metres across. Everybody who was not walking somewhere was
   drawn, whatever they were doing — sitting by the fire, knapping, sitting with
   the ill, and every toddler in the band underfoot among them. From any
   distance it read as a crowd scene rather than as a camp.

   So a camp is tents with people in them. Anybody whose errand is inside the
   camp is inside a tent and is not drawn; the people you see are the ones out
   doing something — foraging, hunting, walking to the neighbours, and the
   children old enough to be running about outside. Toddlers stay in.

   Not drawn is all it is. They are still there, still eating, still catching
   things off each other, still counted by everything that counts people. A
   tiger already treats the ground round a fire as somewhere it will not go, so
   nothing that hunts them is fooled either.
   ------------------------------------------------------------------------- */

/* Errands that happen where you can see them. The three that are left —
   knapping, sitting with the ill, sleeping — happen under a roof.

   `tend` was on the wrong side of this line, and it was the one job whose name
   says where it happens. Somebody "at the fire" was hidden inside a tent: the
   caption said one thing, the camp showed another, and it was the largest group
   of people not being drawn — with a full store the weights put better than a
   third of a band on it. Sitting at the fire is the most visible thing anybody
   in a camp does. */
/* Going back to the stones. Rarer than tending the fire and commoner than
   walking to the next band — it is an errand of an afternoon, not a ceremony,
   and what makes it read as one is that it happens often enough to see and
   stops the moment a band is hungry. */
export const MOURN = { chance: 0.10 };

/* Going to the rocks. Rarer than most errands and further than any of them
   except a visit: an outcrop is where it is, and 220 metres is about as far as
   anybody will go for a stone. */
export const QUARRY_TRIP = { chance: 0.12, reach: 220 };

const OUTDOOR_JOBS = new Set(['gather', 'hunt', 'visit', 'market', 'play', 'tend', 'led', 'mourn', 'quarry', 'raid', 'fish', 'wood', 'explore']);

/* Where somebody at the fire actually sits: inside the ring of tents and
   outside the ring of stones. The huts stand 6.5-9.1m out and are a couple of
   metres across, so their inner edge is about 4.1m; the fire's stones sit at
   1.15m. Between those two is the part of a camp people are actually in.

   The old range was the generic [2, 9] shared with knapping and nursing, which
   put fire-tenders among the tents and sometimes inside one. It did not show,
   because they were not drawn. */
export const FIRESIDE = [1.8, 4.0];
export const TODDLER_UNTIL = 4;       // years; too small to be underfoot

export function indoorsNow(p) {
  // Small enough to be in the tent whatever else is going on.
  if (p.child && personAge(p) < TODDLER_UNTIL) return true;
  if (OUTDOOR_JOBS.has(p.job)) return false;
  // Otherwise: indoors if they are actually at the camp rather than walking to it.
  return inCamp(p.x, p.z, 0);
}

/* Whose turn it is this frame. Reused rather than rebuilt, because this runs
   every frame and it is the only allocation the loop would make. */
export const _turns = [];

/* Whether the near set found a wearer this frame — see the end of updatePeople. */
let nearShown = false;

/* One joint, at the top of the limb hanging from it. Every caller has the
   limb's matrix already — the joint is where that limb starts, which is the
   origin of its own space, so there is nothing to work out. */
function nearJoint(mesh, i, mat) {
  if (!mesh || i !== followIdx || P.view !== 'follow') return;
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(mat);
  mesh.visible = true;
  nearShown = true;
}

export function updatePeople(dt, day) {
  /* A camp is under attack for as long as raiders stand in it, and its people
     turn out to meet them (writePerson). Read off where the raiders are rather
     than kept, so it ends the moment the raid is settled. */
  for (const c of camps) c.underRaid = null;
  for (const q of people) if (q.job === 'raid' && q.state === 'work' && q.raiding) q.raiding.underRaid = q;
  if (!personParts) return;
  /* The same turn-taking as the herds, and it starts later: twenty-odd people
     is under the threshold, so nothing changes until a world grows past it.
     Then they go in pairs, then in fours, and a band of a hundred costs what a
     band of twenty-five does. */
  const stride = lodStride(people.length);

  /* Whoever the camera is locked to is not dealt into a group.

     Turn-taking is invisible at the distance a crowd is seen from and extremely
     visible at three metres: a figure that steps four times as far, four times
     less often, judders — and in Follow the one figure on screen is the one you
     are looking at. The grouping comment above says as much; what it did not do
     was exempt anybody. It went unnoticed for as long as `worldStep` never
     moved while watching, because then the followed person was either in the
     one permanent group and perfectly smooth, or outside it and frozen.

     They cost one extra person a frame, against a saving measured in the
     hundreds, so this is the cheapest exemption in the file. */
  const watched = P.view === 'follow' && followIdx >= 0 && followIdx < people.length
    ? followIdx : -1;
  _turns.length = 0;
  for (let i = turnStart(stride); i < people.length; i += stride) {
    if (i !== watched) _turns.push(i);
  }
  if (watched >= 0) _turns.push(watched);

  for (let t = 0; t < _turns.length; t++) {
    const i = _turns[t];
    const p = people[i];
    /* Everyone else gets the whole time their group waited; the watched person
       is here every frame and gets one frame of it, or they would walk at
       `stride` times everybody else's pace. */
    const slice = i === watched ? dt : dt * stride;

    /* A tiger in sight, and the errand is over. They run for the fire, and
       keep running for a while after losing sight of it — somebody who stops
       the instant the tiger is out of view stops directly in front of it. */
    /* Being led. Everything below that would choose for them is skipped: the
       tiger they should run from, dusk sending them home, the timer that ends
       one errand and starts the next. A person who obeys most of the time is
       worse than one who cannot be steered at all — you would never know which
       of your instructions had taken.

       Not skipped: the rest of being alive. They tire, they get hungry, their
       nourishment ceiling falls if the store is empty, and a tiger can still
       catch them. Led is a hand on the shoulder, not a shield. */
    // Something you told them to do with E: this turn starts it.
    if (p.act) { startAct(p); p.act = null; }
    // Out on the raft and back, for the band's own fishers (rafts.js).
    if (p.raftTrip || (p.job === 'fish' && p.state === 'work')) raftTrip(p);
    if (p.led && !p.acting) {
      p.job = 'led';
      p.prey = null;
      p.visiting = null;
      p.asleep = false;
      p.state = 'goto';
      p.targetX = p.leadX;
      p.targetZ = p.leadZ;
    }

    /* Sent home. Not a state of its own: it is the walk back that ends every
       errand, started early. They carry home whatever is in their arms, the
       store takes it when they arrive, and afterwards they are idle and
       choosing for themselves again, which is the whole of what going home
       means.

       Spent here rather than in the click that set it, because the timeout
       comes off the distance and arriving is what banks the haul. Both are the
       step's business, the same way an order is. */
    if (p.goingHome) {
      p.goingHome = false;
      p.prey = null;
      p.visiting = null;
      p.asleep = false;
      /* Nobody is pointing any more, and "going where you point" is what the
         caption would otherwise say for the whole walk back. */
      if (p.job === 'led') p.job = 'tend';
      p.state = 'return';
      const to = homeward(p, 0);
      p.targetX = to.x;
      p.targetZ = to.z;
      p.timer = travelTimeout(p);
    }

    p.panic = Math.max(0, (p.panic || 0) - slice);
    /* A cautious person looks up sooner. The bold notice the same tiger from
       closer in, which costs them metres they cannot spare — the whole margin
       between getting home and not is four of them. */
    const notice = PANIC.sees / (p.traits?.bold ?? 1);
    if (!p.led && !p.asleep && p.panic <= 0 && nearestPredator(p.x, p.z, notice)) {
      p.panic = PANIC.runs;
      p.state = 'return';
      p.prey = null;
      p.visiting = null;
      /* Nearest, not theirs. Everything else about going home is about where
         you live; this is about getting behind a fire before it reaches you. */
      const run = nearestFire(p.camp, p.x, p.z);
      p.targetX = run.x + (luck() - 0.5) * 4;
      p.targetZ = run.z + (luck() - 0.5) * 4;
      p.timer = travelTimeout(p);
    }

    p.timer -= slice;
    if (p.timer <= 0 && (!p.led || p.acting)) {
      switch (p.state) {
        case 'idle':
          /* Told to do something, rather than choosing. One order, taken up
             once: after this they are back to choosing for themselves, which is
             the difference between telling somebody to go hunting and holding
             them there. */
          p.stowed = false;               // whatever they put away, it is put away
          if (p.orders) {
            p.job = p.orders;
            p.orders = null;
            setOut(p);
          } else chooseJob(p, day);
          p.state = 'goto';
          p.timer = travelTimeout(p);
          break;
        case 'goto':                       // gave up getting there, or lost it
          p.prey = null;
        case 'work':
          if (p.job === 'gather') {
            /* What the ground gave up. Lush ground gives more, which puts the
               good foraging exactly where the flowers are — and if they
               finished under a bearing tree, what they stripped off it too.
               Baskets are the difference between carrying it and dropping it. */
            const baskets = 1 + SKILL.basketHaul * p.camp.skill.baskets;
            /* The two halves kept apart long enough to be counted — what the
               ground gave, as berries, and what came off the tree, as fruit —
               so the caption can say which. The food is the same sum it was. */
            const ground = FOOD.gather * forageRichness(p.x, p.z);
            const fruit = pickFruit(p.x, p.z);
            const got = (ground + fruit) * baskets * childWorth(p) * P.abundance;
            p.haul += got;
            p.carry = 1;
            const hands = baskets * childWorth(p);
            bagAdd(p, 'berries', Math.max(1, Math.round(ground * hands / BAG.berry)));
            bagAdd(p, 'fruit', Math.round(fruit / ORCHARD.worth));
            /* And the ground is that much barer. Taken where the trip actually
               ended rather than where it was aimed, which is the same place the
               yield was read from — a patch somebody gave up halfway to is not
               a patch anybody stripped. */
            takeForage(p.x, p.z);
            /* Written up from what it actually gave, not from what it looked
               like on the way out — and faded a little first, so a patch that
               is being picked over slides down the list on its own. */
            rememberPatch(p.camp, p.x, p.z, got * MEMORY.forget);
          }
          if (p.job === 'craft') {
            /* An afternoon's work, and the band is fractionally better at
               something for the rest of its existence — and so is the person
               who did it.

               That second half is what makes the whole mechanism go anywhere.
               Without it the only people who ever learned were children growing
               up, once, from whatever the camp knew that day; nobody's memory
               ever rose, so the cap of "best living memory plus a step" never
               rose either, and every band in every world stalled at exactly 14%
               for ever. Practice has to teach the hands doing it. */
            const key = craftChoice(p.camp);
            /* Toolmaking spends what somebody quarried. craftChoice will not
               pick it without stone in the camp, so this cannot go negative —
               and taking it here rather than there keeps the choosing free of
               side effects, which is what lets it be asked twice. */
            if (key === 'tools') p.camp.stone = Math.max(0, p.camp.stone - SKILL.stonePerTool);
            practise(p.camp, key, SKILL.perCraft * (p.traits?.quick ?? 1));
            p.knows[key] = Math.max(p.knows[key] || 0, p.camp.skill[key]);
          }
          /* Time spent at the stones, which is the whole of what the seventh
             skill is learned by. Worth a fifth of an afternoon's knapping, so
             it is a thing a band grows into over years rather than a thing one
             person does on a slow afternoon — and it is learned by the person
             as well as the band, like every other skill, or nobody's memory
             ever rises and the cap never moves. */
          /* A trip to the rocks: stone in the pile, and the band a little
             better at getting it. The pile is capped — a camp is not a
             warehouse — and the cap is why quarrying stops being chosen. */
          /* Arrived, and only if they actually got there — the same rule the
             visit follows, and for the same reason: you cannot raid a camp you
             turned back from. Resolved for the party rather than the person, so
             five people arriving is one raid and not five. */
          if (p.job === 'raid' && p.raiding) {
            const mark = p.raiding;
            p.raiding = null;
            if (Math.hypot(p.x - mark.x, p.z - mark.z) < CAMP_CLEARING * 1.6) {
              const party = people.filter((q) => q.camp === p.camp
                && Math.hypot(q.x - mark.x, q.z - mark.z) < CAMP_CLEARING * 2);
              const won = resolveRaid(party, mark);
              /* Settled once, for all of them: every raider of this band on
                 their way to it or standing in it stops, and comes home — the
                 winners carrying what was taken. */
              for (const q of people) {
                if (q.camp !== p.camp || q.raiding !== mark) continue;
                q.raiding = null;
                if (q.state === 'work') q.timer = 0;
              }
              if (won) for (const q of party) if (!q.child) q.carry = 1;
            }
          }
          /* A catch. The same shape as a foraging trip and deliberately so —
             it lands in the same haul, in the same units, and takes off the
             same ground that runs down. Baskets carry fish as well as berries;
             a band good at weaving brings more of both home. */
          if (p.job === 'fish') {
            // Where the raft was out on the water, or where they sit on it.
            const spot = p.raftTrip ? p.raftTrip.spot : p;
            const baskets = 1 + SKILL.basketHaul * p.camp.skill.baskets;
            const got = fishRichness(spot.x, spot.z, p.camp) * baskets
              * (1 + p.camp.skill.fishing) * childWorth(p) * P.abundance;
            p.haul += got;
            p.carry = 1;
            if (got > 0) bagAdd(p, 'fish', Math.max(1, Math.round(got / BAG.fish)));
            takeForage(spot.x, spot.z);
            if (p.raftTrip) landRaft(p);
            practise(p.camp, 'fishing', SKILL.perCatch);
            p.knows.fishing = Math.max(p.knows.fishing || 0, p.camp.skill.fishing);
          }
          if (p.job === 'quarry') {
            /* Dug from the deposit they actually stood at, and carried home
               rather than put on the pile where they stand: stone and ore both
               come in over the shoulder, and somebody who gave up on the way
               out brings nothing. */
            const d = p.digging;
            p.digging = null;
            if (d && Math.hypot(p.x - d.x, p.z - d.z) < depositRadius(d) + DIG_REACH) {
              const took = mineDeposit(d, ORES[d.kind].per * (1 + p.camp.skill.mining));
              if (took > 0) { bagAdd(p, 'ore', took, d.kind); p.carry = 1; }
            }
            practise(p.camp, 'mining', SKILL.perQuarry);
            p.knows.mining = Math.max(p.knows.mining || 0, p.camp.skill.mining);
          }
          // Logs off a tree, onto the shoulder (wood.js).
          if (p.job === 'wood') chopDone(p);
          if (p.job === 'explore') surveyDone(p);
          // A field: ditches until the band can water it, then a crop (farming.js).
          if (p.job === 'farm') farmDone(p);
          // A morning at the market: the band a little better at dealing.
          if (p.job === 'market') {
            practise(p.camp, 'trade', SKILL.perCall);
            p.knows.trade = Math.max(p.knows.trade || 0, p.camp.skill.trade);
          }
          if (p.job === 'mourn') {
            practise(p.camp, 'rites', SKILL.perVisit);
            p.knows.rites = Math.max(p.knows.rites || 0, p.camp.skill.rites);
            /* And an afternoon at the stones is an afternoon spent on them: the
               ones who go back are the ones who raise things. Less than a
               craft session, because this is carrying and setting rather than
               knapping, and it only counts where there is a ground to do it
               on. */
            if (p.camp.barrow) {
              practise(p.camp, 'art', SKILL.perStone);
              p.knows.art = Math.max(p.knows.art || 0, p.camp.skill.art);
            }
            /* And with stone in the camp, the stones are dressed and set as well
               as raised: masonry, which squares off the ground, stands the
               graves up and in the end raises a pyramid behind them. It spends
               what the quarriers brought home, the way toolmaking does. */
            if (p.camp.barrow && (p.camp.stone || 0) >= SKILL.stonePerCourse) {
              p.camp.stone -= SKILL.stonePerCourse;
              practise(p.camp, 'stonework', SKILL.perCourse);
              p.knows.stonework = Math.max(p.knows.stonework || 0, p.camp.skill.stonework);
            }
          }
          /* Only if they actually arrived. This case is reached both by
             arriving and by giving up on the way, which is right for foraging —
             you pick what is around you wherever you stopped — and wrong for
             this: you cannot hand over food you never carried anywhere, or
             teach a band you never reached. */
          if (p.job === 'visit' && p.visiting) {
            const host = p.visiting;
            p.visiting = null;
            if (Math.hypot(p.x - host.x, p.z - host.z) < CAMP_CLEARING * 1.6) {
              arriveAtCamp(p, host);
            }
          }
          if (p.acting) { endAct(p); break; }
          p.state = 'return';
          aimHome(p, 6);
          // The walk back from the next band is the same walk, in reverse.
          p.timer = travelTimeout(p);
          break;
        default:
          p.state = 'idle';
          p.carry = 0;
          p.timer = 2 + luck() * 5;
      }
    }

    // Light wakes people, whatever the sleep timer says.
    if (day >= 0.25 && p.job === 'sleep' && !p.led) {
      p.state = 'idle';
      p.timer = luck() * 4;
    }

    /* Dusk overrides whatever anyone was doing: everybody comes back.

       The distance test is what makes this terminate. Without it the rule fires
       again the moment someone arrives — their job is still a daytime one, so
       they are sent straight back out to a fresh point beside the fire they are
       already standing at, and nobody ever idles long enough to choose a night
       job. A whole band walked in circles round its own camp all night. */
    if (!p.led && day < 0.25 && p.job !== 'sleep' && p.job !== 'tend' && p.job !== 'explore' && p.state !== 'return') {
      if (Math.hypot(p.x - homeFire(p).x, p.z - homeFire(p).z) > 12) {
        p.state = 'return';
        aimHome(p, 5);
        p.timer = travelTimeout(p);
      } else {
        p.state = 'idle';                    // already home: pick a night job now
        p.carry = 0;
        p.timer = Math.min(p.timer, 0.4);
      }
    }

    // A hunter's target moves. Re-aim at it, and take a shot when close enough.
    if (p.prey && p.state === 'goto') {
      if (tryKill(p, slice) || !p.prey) {
        p.state = 'return';
        aimHome(p, 6);
        p.timer = travelTimeout(p);
      } else if (Math.hypot(p.prey.animal.x - p.x, p.prey.animal.z - p.z) > huntReach(p.camp)) {
        p.prey = null;                     // it outran us
      }
    }

    const tdx = p.targetX - p.x, tdz = p.targetZ - p.z;
    const dist = Math.hypot(tdx, tdz);
    const arrived = dist < 1.1;

    let want = 0;
    if (p.state === 'goto' || p.state === 'return') {
      if (arrived) {
        // Stood where you put them. `want` stays 0 until you point somewhere else.
        if (p.led) { /* nothing to finish */ }
        else if (p.state === 'goto') {
          p.state = 'work';
          // Sleep has to outlast the night. Give it the same 10-30 seconds as
          // every other task and people shuttle in and out of the huts until
          // dawn instead of sleeping in them.
          /* And tools are what make the work quick. Everything but sleeping,
             because a good axe does not shorten a night — at mastery an errand
             takes a little over half as long, so a day holds nearly twice the
             errands of a band with nothing but its hands. */
          const quick = 1 - SKILL.toolSpeed * (p.camp.skill?.tools || 0);
          p.timer = p.job === 'hunt' ? (8 + luck() * 14) * quick
                  : p.job === 'gather' ? (6 + luck() * 10) * quick
                  : p.job === 'farm' ? (8 + luck() * 12) * quick
                  : p.job === 'sleep' ? 600
                  : (10 + luck() * 20) * quick;
        } else {
          bankLoad(p);
          p.state = 'idle';
          p.carry = 0;
          p.timer = 2 + luck() * 6;
        }
      } else {
        // Hunters and children move at a jog; everyone else walks.
        want = (p.job === 'hunt' || p.job === 'play') ? PERSON.jog * (p.child ? 0.75 : 1) : PERSON.walk;
        /* Told to run. Set here rather than after the clamps below so that
           running is charged for like any other jog: it costs energy, it is cut
           short when there is none left, and it slows with a full basket. A run
           you can hold forever for nothing would make walking pointless. */
        if (p.led && leadRunning()) want = PERSON.jog * (p.child ? 0.75 : 1);
        /* The one you are playing is weighed by what is in the basket, whatever
           the carry flag says: dusk at home and idling both lower the flag
           without emptying anything. */
        if (p.carry || p.led) want *= carryFactor(p);
        // Worn down, they slow — and near the end cannot run (vitals.js).
        want = lifeWant(p, want);
        // Up a tree, or sat resting: they stay where they are.
        if (p.climbed || p.resting) want = 0;
        // Down low (Z) they crawl: slowly, and nothing grazing notices them.
        else if (p.hiding) want = Math.min(want, PERSON.walk * CRAWL);
        /* Spent, they walk. The jog is what energy buys, and it is the first
           thing to go — which is why a long hunt ends in a trudge home. */
        if (want > PERSON.walk) {
          want = PERSON.walk + (want - PERSON.walk) * clamp(p.energy * 1.4, 0, 1);
        }
        if (p.sick) want *= PLAGUE.drag;
        // Off the path, slower; on a road, quicker (paths.js).
        if (!p.onRaft) want *= groundPace(p.x, p.z);
        // Frightened, and whatever is left in them goes into running.
        if (p.panic > 0) want = Math.max(want, PERSON.jog * (p.child ? 0.8 : 1));
      }
    }
    p.speed += (want - p.speed) * Math.min(1, slice * 3.2);

    /* A walk is under SUSTAIN and so costs nothing; a jog is over it and does.
       Sleep pays back several times faster than sitting by the fire, and a camp
       with nothing in the store pays back slowly — which is the loop closing:
       hunger makes people tired, tired people hunt worse, and hunting worse is
       what made them hungry. */
    const effort = p.speed / PERSON.jog;
    const fed = 1 - 0.55 * p.camp.hunger;
    const rate = energyRate(effort, PERSON_STAMINA, p.asleep ? SLEEP_SECONDS : RECOVERY_SECONDS);
    /* Rest does a sick person much less good than it does a well one — and
       sitting down on purpose does more than standing about, most at home. */
    const heal = (p.sick ? PLAGUE.drag : 1) * restBoost(p);
    /* And a camp with hides, bedding and somewhere dry to keep them is a camp
       people rest in properly. Only on the way up: home goods make a night
       worth more, they do not make a chase cost less. */
    const comfort = 1 + SKILL.wareRest * (p.camp.skill?.wares || 0);
    p.energy = clamp(p.energy + (rate > 0 ? rate * fed * heal * comfort : rate) * slice, 0, 1);
    // And the cold takes some of the rest back, for the person you are playing.
    p.cold = coldFactor(p, day);
    /* The life bar, for the person you are playing: spent walking, running,
       working, under a load and in the cold; won back resting and eating. */
    if (p.led || p.life != null) {
      const loadFrac = p.led && hasLoad(p)
        ? loadOf(p) / carryCap(p, SKILL.basketHaul, p.camp.skill?.baskets || 0) : 0;
      spendLife(p, slice, loadFrac);
    }
    if (p.cold < 1 && rate > 0) p.energy = clamp(p.energy - rate * fed * heal * comfort * (1 - p.cold) * slice, 0, 1);

    /* Starvation is a ceiling coming down, not a drain.

       Draining energy directly cannot work, and the arithmetic says so plainly:
       resting recovers 0.006 a second, which is twenty full tanks over a
       sim-day, so any drain slow enough to take days is lost in the noise and
       any drain fast enough to compete empties somebody in minutes. What an
       empty store actually does is put a lid on how much you can have — a
       starving person can rest all they like and still not get up.

       `nourish` is that lid. It falls while the store is empty and comes back
       when there is food, on the calendar rather than the frame clock, and
       energy simply cannot exceed it. When the lid reaches nought, so do they. */
    const days = slice / P.dayLength;
    p.nourish = clamp(p.nourish + (p.camp.hunger > STARVE_FROM
      ? -(p.camp.hunger - STARVE_FROM) / (1 - STARVE_FROM) * STARVE_DRAIN
      : REFEED) * days, 0, 1);
    if (p.energy > p.nourish) p.energy = p.nourish;
    // For the person you are playing, the life bar is their energy (vitals.js).
    if (p.led && p.life != null) p.energy = Math.max(0.05, p.life);

    if (!arrived && want > 0) {
      /* By the path, if one near enough runs their way (paths.js). Not for
         the one you are playing, who goes where they are pointed; not after
         something that moves, or away from something that frightens; and not
         on the last few metres, where the goal is the goal. */
      const aim = Math.atan2(tdx, tdz);
      if (p.onRaft || p.led || p.panic > 0 || p.prey || p.hiding || dist < TREAD.near) p.swerve = 0;
      else if ((p.swerveAt || 0) <= worldClock) {
        p.swerve = pathSwerve(p.x, p.z, aim, p.swerve || 0);
        p.swerveAt = worldClock + TREAD.every;
      }
      let diff = aim + (p.swerve || 0) - p.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      p.yaw += clamp(diff, -PERSON.turn * slice, PERSON.turn * slice);
    }

    const step = p.speed * slice;
    if (step > 0 && !(p.onRaft ? raftStep(p, step) : stepPerson(p, step))) {
      /* Nothing worked, not even the relaxed try — which means they are stood
         somewhere there is genuinely no way out of. Only then is the errand
         given up, and a visit is never given up this way: being sent home by a
         hillside is how nobody ever reached the next band. */
      p.speed = 0;
      if (p.job !== 'visit' && !p.onRaft) pickWork(p);
    }

    // Posture. Foraging bends at the waist, knapping hunches over a lap, sitting
    // by the fire folds the legs, and sleeping puts them inside a hut.
    let wantCrouch = 0, wantBend = 0;
    const working = p.state === 'work';
    if (working && p.job === 'gather') { wantCrouch = 0.55; wantBend = 0.85; }
    else if (working && p.job === 'craft') { wantCrouch = 0.95; wantBend = 0.45; }
    else if (working && p.job === 'tend') { wantCrouch = 0.9; wantBend = 0.18; }
    // Bent to the rock, and stooped over the water.
    else if (working && p.job === 'quarry') { wantCrouch = 0.5; wantBend = 0.9; }
    else if (working && p.job === 'wood') { wantCrouch = 0.2; wantBend = 0.55; }
    else if (working && p.job === 'farm') { wantCrouch = 0.15; wantBend = 0.3; }
    else if (working && p.job === 'fish') { wantCrouch = 0.3; wantBend = 0.45; }
    // Kneeling on the raft.
    else if (p.onRaft) { wantCrouch = 0.6; wantBend = 0.2; }
    // Down in cover: as low as a person goes.
    else if (p.hiding) { wantCrouch = 1; wantBend = 0.55; }
    // Sat down to rest.
    else if (p.resting) { wantCrouch = 0.9; wantBend = 0.12; }
    else if (p.job === 'sleep' && p.state !== 'goto') { wantCrouch = 1; wantBend = 0.1; }
    p.crouch += (wantCrouch - p.crouch) * Math.min(1, slice * 3);
    p.bend += (wantBend - p.bend) * Math.min(1, slice * 3);
    p.work += slice * (working ? 3.4 : 0);

    /* Asleep is not the same as indoors, and the difference matters: asleep
       recovers energy several times faster and is what the rest of the
       simulation means by out of reach. Somebody knapping under a roof is
       neither. */
    p.asleep = p.job === 'sleep' && p.state !== 'goto' && arrived;
    const hidden = p.asleep || indoorsNow(p);
    /* Kept on the person, because something else needs it now: clicking
       somebody has to choose between the figures actually on screen, and
       working the rule out a second time over there is how the two answers
       start disagreeing. */
    p.hidden = hidden;
    if (hidden) {
      /* Parked out of sight — but only when there is a sight to be out of.

         The guard below was on the half that draws somebody and not on the half
         that hides them, so a fast-forward spent its time writing seventeen
         zeroed matrices per person per step for a scene nobody was looking at:
         six percent of a run, on people who were asleep in their huts. The
         first drawn frame afterwards walks this same branch and parks them
         properly, which is why skipping it costs nothing.

         Exactly the mistake the herds had and were fixed for — everything above
         this is somebody deciding, everything below is somebody being drawn. */
      if (drawingWorld) {
        for (const key in personParts) {
          const per = partsPer(key);
          for (let k = 0; k < per; k++) personParts[key].setMatrixAt(i * per + k, HIDDEN);
        }
        // And nothing of theirs is in the wardrobe's lists, so none of it is drawn.
        undress(p);
      }
      continue;
    }

    if (drawingWorld) writePerson(p, i);
  }
  /* Put the face away unless somebody wore it this frame. One flag rather than
     a second pass: the near set belongs to whoever `writePerson` last put it
     on, and the moment that stops being anybody it has to stop being anywhere. */
  if (!nearShown) hideNearParts();
  nearShown = false;

  // Nothing was written if nothing is being drawn, so nothing has to be uploaded.
  if (drawingWorld) {
    for (const key in personParts) personParts[key].instanceMatrix.needsUpdate = true;
    flushLooks();
  }
}

export function writePerson(p, i) {
  const S = PERSON;
  /* A raid, fought. The raiders stand in the camp they came for, and the
     people of that camp who are home and able face them and fight back — a
     spear each, drawn in and driven out. Only drawing: who wins was never going
     to be decided by the poses (resolveRaid). Turned to face each other, and
     only while standing, so nobody walks sideways to a fight. */
  const raiding = p.job === 'raid' && p.state === 'work' && p.raiding;
  const defending = !raiding && !p.child && !p.sick && !p.asleep && p.speed < 0.5 && p.camp?.underRaid
    && Math.hypot(p.x - p.camp.x, p.z - p.camp.z) < campReach(p.camp);
  const foe = raiding ? p.raiding : defending ? p.camp.underRaid : null;
  const yaw = foe ? Math.atan2(foe.x - p.x, foe.z - p.z) : p.yaw;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const probe = 0.5;
  const hF = sampleHeight(p.x + fx * probe, p.z + fz * probe);
  const hB = sampleHeight(p.x - fx * probe, p.z - fz * probe);
  const pitch = -Math.atan2(hF - hB, probe * 2) * 0.5;   // people stay upright-ish

  const gaitF = Math.min(p.speed / PERSON.walk, 1.6);
  const bounce = Math.sin(p.phase * 2) * 0.018 * Math.min(gaitF, 1);
  const drop = S.legLen * p.scale * 0.44 * p.crouch;

  _eAnim.set(pitch, yaw, 0, 'YXZ');
  _qAnim.setFromEuler(_eAnim);
  _pAnim.set(p.x, sampleHeight(p.x, p.z) + S.legLen * p.scale - drop + bounce + (p.lift || 0), p.z);
  _sAnim.setScalar(p.scale);
  _mBody.compose(_pAnim, _qAnim, _sAnim);

  // The torso pivots at the waist and the head and arms ride on it, so bending
  // to forage takes the whole upper body with it.
  /* What they are doing with their hands decides a little of how they stand —
     a pick is swung from the hips — so it is worked out before the torso.
     These are the library's working poses: a pick swung two-handed, a knife
     worked in one hand while the other holds, an arm up into the branches. */
  const act = foe ? 'fighting' : p.state === 'work'
    ? (p.job === 'quarry' ? 'mining' : p.job === 'craft' ? 'cutting' : p.job === 'farm' ? 'hoeing'
      : p.job === 'gather' && p.climbed ? 'picking' : null)
    : null;
  const stroke = Math.sin(p.work * 0.7);
  // Each fighter on their own beat, off the clock, so a defender standing still still fights.
  const blow = Math.sin(worldClock * 4.2 + i * 1.7);
  const lean = act === 'mining' ? 0.16 + 0.11 * (1 - stroke) : act === 'hoeing' ? 0.34
    : act === 'fighting' ? 0.12 + 0.08 * blow : 0;
  _mLocal.makeRotationX(p.bend + lean);
  _mLocal.setPosition(0, 0, 0);
  _mTorso.multiplyMatrices(_mBody, _mLocal);
  _mLocal.makeScale(p.shoulder, 1, 1);
  _mChain.multiplyMatrices(_mTorso, _mLocal);
  /* The torso is dressed rather than drawn: what you see of it is the hide,
     cut to the sex and the build (looks.js). A woman's on a grown woman; a
     child of either sex wears the other, and the joints follow the hide they
     are in — the arms hang from its shoulders and the legs from its hips, and
     a broad or a full build carries them further out. */
  const woman = p.sex === 'f' && !p.child;
  const fit = fitOf(p);
  /* What the band can sew, on the rung the chronicle last announced: sleeves,
     then leggings, then the cloth dyed, then a cloak for the winter. */
  const grade = clothingGrade(p);
  const dyed = grade >= CLOTH.dyed ? 1 : 0;
  const tunic = wear(p, 'tunic', tunicKey(p, woman), dyed);
  looks[tunic].setMatrixAt(p.wornAt.tunic, _mChain);
  const cloak = wear(p, 'cloak', grade >= CLOTH.cloak && seasonName === 'winter' ? 'cloak' : null);
  if (cloak) looks[cloak].setMatrixAt(p.wornAt.cloak, _mChain);
  const armX = (woman ? S.armXF : S.armX) * p.shoulder * fit.armX;
  const hipX = (woman ? S.hipXF : S.hipX) * p.hip * fit.hipX;

  // A neck, hung from its base at the top of the chest.
  _mLocal.makeTranslation(0, S.neckY, 0);
  _mChain.multiplyMatrices(_mTorso, _mLocal);
  personParts.neck.setMatrixAt(i, _mChain.scale(fit.neck));

  _mOff.makeScale(p.headScale, p.headScale, p.headScale);
  _mOff.setPosition(0, S.headY, 0);
  _mHead.multiplyMatrices(_mTorso, _mOff);
  personParts.head.setMatrixAt(i, _mHead);
  /* Hair, a face, and on whoever leads a band round the brow — all in the
     head's own space, so they carry its size, its bob and where it looks. */
  for (const group of HEAD_GROUPS) {
    const key = wear(p, group, headKey(p, group));
    if (key) looks[key].setMatrixAt(p.wornAt[group], _mHead);
  }

  const swing = Math.min(p.speed * 0.32, 0.62);
  const busy = Math.sin(p.work) * 0.5 * (p.crouch > 0.2 || p.bend > 0.2 ? 1 : 0);
  for (let side = 0; side < 2; side++) {
    const dir = side === 0 ? 1 : -1;
    const phase = p.phase + (side === 0 ? Math.PI : 0);

    /* Arm: shoulder, then elbow, then a hand on the end. Arms counter-swing
       against the leg on the same side; when carrying, they come up and hold
       instead. The elbow keeps a little bend even at rest — a perfectly
       straight arm is the thing that reads as a mannequin. */
    let arm = Math.sin(phase) * swing * 0.8 + busy;
    if (p.carry) arm = -1.15 + Math.sin(p.phase) * 0.05;
    let elbow = 0.22 + Math.max(0, Math.sin(phase + 0.9)) * swing * 0.9;
    if (p.carry) elbow = 1.30;
    else if (p.hasSpear && side === 0) elbow = 0.75;
    if (act && !p.carry) {
      if (act === 'fighting') {
        // The spear driven forward and drawn back; the other arm up to fend.
        arm = side === 0 ? -1.45 + 0.75 * blow : -1.1;
        elbow = side === 0 ? 0.35 + 0.45 * Math.max(0, -blow) : 1.25;
      } else if (act === 'mining') {
        // Both arms together: the pick is held in two hands.
        arm = -1.45 + 0.8 * stroke;
        elbow = 0.35;
      } else if (act === 'cutting') {
        arm = side === 0 ? -1.05 + 0.25 * Math.sin(p.work * 1.3) : -0.9;
        elbow = side === 0 ? 0.9 : 1.05;
      } else if (act === 'hoeing') {
        // Both hands on the haft, a short low stroke: the library's hoeing.
        arm = -0.62 + 0.34 * stroke;
        elbow = 0.55;
      } else {
        arm = side === 0 ? -2.35 + 0.14 * Math.sin(p.work) : -0.4;
        elbow = side === 0 ? 0.2 : 0.3;
      }
    }
    // Throwing (hunt.js): the spear arm back over the shoulder, then through.
    if (side === 0 && p.throwPose > 0) {
      const k = p.throwPose;
      arm = k < 0.55 ? -3.4 * (k / 0.55) : -3.4 + 2.2 * Math.min(1, (k - 0.55) / 0.25);
      elbow = k < 0.55 ? 1.4 : 0.2;
    }

    _mLocal.makeRotationX(arm);
    _mLocal.setPosition(dir * armX, S.shoulderY, 0);
    _mUpper.multiplyMatrices(_mTorso, _mLocal);
    personParts.upperArm.setMatrixAt(i * 2 + side, _mFit.copy(_mUpper).scale(fit.upperArm));
    // Sleeves on the same matrix as the arm, so they bend with it.
    const sleeve = wear(p, SLEEVES[side], grade >= CLOTH.sleeves ? 'sleeve:' + side : null, dyed);
    if (sleeve) looks[sleeve].setMatrixAt(p.wornAt[SLEEVES[side]], _mFit);

    _mOff.makeRotationX(elbow);
    _mOff.setPosition(0, -S.upperArm[1], 0);
    _mLower.multiplyMatrices(_mUpper, _mOff);
    personParts.foreArm.setMatrixAt(i * 2 + side, _mFit.copy(_mLower).scale(fit.foreArm));
    /* The elbow itself. The limbs are capsules, so a bend has no corner in it —
       what is missing is the joint reading as a joint rather than as the place
       two capsules happen to meet. A ball at the seam is what an elbow is. */
    nearJoint(nearParts?.elbow?.[side], i, _mLower);

    _mOff.makeTranslation(0, -S.foreArm[1], 0);
    _mChain.multiplyMatrices(_mLower, _mOff);
    /* Open or closed. A hand round a spear shaft or under a basket is a fist,
       and a fist is shorter and thicker than a hand hanging — which is the one
       piece of finger detail that survives being thirty metres away, and it
       costs nothing at all: everybody already has this box, and closing it is a
       scale on it.

       The fingers themselves are in the near set, on the one person you are
       looking at, and they only exist when the hand is open. A fist is a fist. */
    const closed = p.carry || ((p.hasSpear || foe) && side === 0) || p.state === 'work';
    /* The tool, in the right hand before it closes: a fist is a squashed hand,
       and a squashed pick is not a pick. */
    if (side === 0) {
      const tool = wear(p, 'tool', act === 'mining' ? 'tool:pickaxe' : act === 'cutting' ? 'tool:knife'
        : act === 'hoeing' ? 'tool:hoe' : null);
      if (tool) looks[tool].setMatrixAt(p.wornAt.tool, _mChain);
    }
    if (closed) _mChain.scale(FIST);
    if (i === followIdx) p.handOpen = !closed;
    personParts.hand.setMatrixAt(i * 2 + side, _mFit.copy(_mChain).scale(fit.hand));
    nearJoint(nearParts?.wrist?.[side], i, _mChain);
    if (nearParts && i === followIdx && P.view === 'follow' && !closed) {
      /* Four fingers and a thumb, hung off the hand's own matrix. Two hands is
         ten meshes and they are drawn for one person, which is the whole
         argument for the near set. */
      const F = nearParts.fingers[side];
      for (let k = 0; k < 4; k++) {
        _mLocal.makeTranslation((k - 1.5) * S.hand[0] * 0.26, -S.hand[1] * 0.62, 0);
        F.digit[k].matrixAutoUpdate = false;
        F.digit[k].matrix.multiplyMatrices(_mChain, _mLocal);
        F.digit[k].visible = true;
      }
      _mLocal.makeTranslation(-dir * S.hand[0] * 0.46, -S.hand[1] * 0.30, S.hand[2] * 0.30);
      F.thumb.matrixAutoUpdate = false;
      F.thumb.matrix.multiplyMatrices(_mChain, _mLocal);
      F.thumb.visible = true;
      nearShown = true;
    }

    /* Leg: hip, then knee, then a foot kept level with the ground. A knee bends
       through the swing and not through the stance, which is what stops a walk
       looking like a pair of scissors. */
    const legPhase = p.phase + (side === 0 ? 0 : Math.PI);
    /* Crouching takes the knee FORWARD and folds the shin back underneath, so
       the two rotations partly cancel and the body comes down between them.
       Adding the crouch to both — which is what this did while a leg was one
       straight piece — tips the whole leg backwards instead, and once there is
       a knee in it the shin swings past horizontal and the foot ends up higher
       than the knee. */
    const leg = Math.sin(legPhase) * swing - p.crouch * 0.9;
    let knee = Math.max(0, Math.sin(legPhase + 1.1)) * swing * 1.5 + p.crouch * 1.3;
    /* Whatever the pose, the shin may not pass the horizontal: beyond that the
       ankle is rising rather than falling. Bounding the sum rather than the
       knee alone is the point — the shin's angle in the world is the hip's plus
       the knee's, and capping only one of them leaves the other free. */
    knee = clamp(knee, 0, Math.max(0, SHIN_MAX - leg));

    _mLocal.makeRotationX(leg);
    _mLocal.setPosition(dir * hipX, 0, 0);
    _mUpper.multiplyMatrices(_mBody, _mLocal);
    personParts.thigh.setMatrixAt(i * 2 + side, _mFit.copy(_mUpper).scale(fit.thigh));
    const legging = wear(p, THIGHS[side], grade >= CLOTH.legs ? 'legs:' + side : null, dyed);
    if (legging) looks[legging].setMatrixAt(p.wornAt[THIGHS[side]], _mFit);

    _mOff.makeRotationX(knee);
    _mOff.setPosition(0, -S.thigh[1], 0);
    _mLower.multiplyMatrices(_mUpper, _mOff);
    personParts.shin.setMatrixAt(i * 2 + side, _mFit.copy(_mLower).scale(fit.shin));
    const shinwear = wear(p, SHINS[side], grade >= CLOTH.legs ? 'shins:' + side : null, dyed);
    if (shinwear) looks[shinwear].setMatrixAt(p.wornAt[SHINS[side]], _mFit);
    nearJoint(nearParts?.knee?.[side], i, _mLower);

    // Undo both joints so the sole stays parallel to the ground it is on.
    _mOff.makeRotationX(-(leg + knee));
    _mOff.setPosition(0, -S.shin[1], 0);
    _mChain.multiplyMatrices(_mLower, _mOff);
    personParts.foot.setMatrixAt(i * 2 + side, _mFit.copy(_mChain).scale(fit.foot));
  }

  if (p.hasSpear || foe) {
    _mLocal.makeRotationX(-0.30);
    _mLocal.setPosition(armX + 0.09, S.shoulderY - 0.35, 0.10);
    _mChain.multiplyMatrices(_mTorso, _mLocal);
    personParts.spear.setMatrixAt(i, _mChain);
  } else {
    personParts.spear.setMatrixAt(i, HIDDEN);
  }

  if (p.carry) {
    /* What they are carrying, in the thing they would carry it in.

       It was one box whatever it was, and then one box in three shapes. Now
       berries, fruit and fish come home in a basket held in front, heaped with
       whatever the trip gave — dark berries, red fruit, a pale catch — and
       heaped higher the more there is. An animal goes over the shoulders,
       because nobody puts a deer in a basket. Two meshes, the basket and what
       is in it, so the basket can be wicker while its contents are the colour
       of the food. */
    const key = bagKind(p.bag) || LOAD_FOR_JOB[p.job] || 'berries';
    const kind = LOADS[key];
    /* Food is the library's cargo — fruit, a catch, cuts of meat — heaped in
       the basket, and a rabbit or a boar is carried whole in the arms. Stone,
       ore and wood are this world's own and keep the heap they always had.
       A change of load is taken off and put on again, so it comes in its own
       colour: the same fruit heap is berries when it is darker. */
    const cargo = cargoKey(key, p.bag);
    if (p.loadKind !== key) wear(p, 'cargo', null);
    const worn = wear(p, 'cargo', cargo);
    // Heaped to how full it is, and never so low it sinks below the rim.
    const full = clamp(p.haul / BASKET_FULL, 0.45, 1.15);
    if (worn === 'cargo:animal') {
      personParts.basket.setMatrixAt(i, HIDDEN);
      personParts.load.setMatrixAt(i, HIDDEN);
      _mLocal.makeTranslation(0, S.shoulderY + BASKET_AT.y + 0.10, BASKET_AT.z);
      _mChain.multiplyMatrices(_mTorso, _mLocal);
      looks[worn].setMatrixAt(p.wornAt.cargo, _mChain.scale(_sLoad.setScalar(animalSize(p.bag))));
    } else if (kind.basket || worn) {
      _mLocal.makeTranslation(0, S.shoulderY + BASKET_AT.y, BASKET_AT.z);
      _mChain.multiplyMatrices(_mTorso, _mLocal);
      personParts.basket.setMatrixAt(i, _mChain);
      _mLocal.makeTranslation(0, S.shoulderY + BASKET_AT.y + BASKET_AT.rim, BASKET_AT.z);
      _mChain.multiplyMatrices(_mTorso, _mLocal);
      if (worn) {
        looks[worn].setMatrixAt(p.wornAt.cargo, _mChain.scale(_sLoad.setScalar(0.75 + 0.25 * Math.min(full, 1))));
        personParts.load.setMatrixAt(i, HIDDEN);
      } else {
        _sLoad.set(kind.scale.x, kind.scale.y * full, kind.scale.z);
        personParts.load.setMatrixAt(i, _mChain.scale(_sLoad));
      }
    } else {
      personParts.basket.setMatrixAt(i, HIDDEN);
      _mLocal.makeTranslation(0, S.shoulderY + 0.04, -0.10);
      _mChain.multiplyMatrices(_mTorso, _mLocal);
      _mChain.scale(kind.scale);
      personParts.load.setMatrixAt(i, _mChain);
    }
    /* Only when it changes hands. The colour of a load is a fact about the
       errand, not about the frame, and writing it every frame is an upload of
       the whole instance colour buffer for every carrier in the world. */
    if (p.loadKind !== key) {
      p.loadKind = key;
      personParts.load.setColorAt(i, _cLoad.setHex(kind.hex));
      if (personParts.load.instanceColor) personParts.load.instanceColor.needsUpdate = true;
    }
  } else {
    personParts.basket.setMatrixAt(i, HIDDEN);
    personParts.load.setMatrixAt(i, HIDDEN);
    wear(p, 'cargo', null);
    p.loadKind = null;
  }
}

/* What is in the basket, in the two channels an instanced mesh has: how it is
   stretched and what colour. Berries dark, fruit red, a catch long and pale;
   an animal is a big dark bundle and does not go in a basket, and nor does
   stone, which comes home over the shoulder the same way. */
export const LOADS = {
  berries: { scale: new THREE.Vector3(1.0, 1.0, 1.0), hex: 0x5c2742, basket: true },
  fruit:   { scale: new THREE.Vector3(1.05, 1.15, 1.05), hex: 0xc7462c, basket: true },
  fish:    { scale: new THREE.Vector3(1.25, 0.75, 0.9), hex: 0x9fb0b8, basket: true },
  vegetables: { scale: new THREE.Vector3(1.0, 1.05, 1.0), hex: 0x6f8f45, basket: true },
  game:    { scale: new THREE.Vector3(1.7, 1.4, 1.2), hex: 0x6e3630, basket: false },
  stone:   { scale: new THREE.Vector3(1.0, 0.9, 1.0), hex: 0x7a746a, basket: false },
  /* Ore, the colour of the rock it came out of — the same numbers as ORES in
     quarries.js, written out because this table is read as the module loads. */
  iron:    { scale: new THREE.Vector3(1.0, 0.85, 1.0), hex: 0x7e4630, basket: false },
  bronze:  { scale: new THREE.Vector3(1.0, 0.85, 1.0), hex: 0x9c6a3c, basket: false },
  silver:  { scale: new THREE.Vector3(0.8, 0.7, 0.8), hex: 0xaab4ba, basket: false },
  gold:    { scale: new THREE.Vector3(0.7, 0.6, 0.7), hex: 0xcfa233, basket: false },
  // Logs, over the shoulder: long and low, the colour of the woodpile.
  wood:    { scale: new THREE.Vector3(1.8, 0.6, 0.7), hex: 0x7a5a3a, basket: false },
};
/* What somebody carrying with nothing counted in their bag has, by errand: a
   session saved before baskets were counted, or stone from the rocks. */
export const LOAD_FOR_JOB = { gather: 'berries', fish: 'fish', hunt: 'game', quarry: 'stone', farm: 'vegetables', raid: 'fruit' };
/* Where the basket is held, in the torso's own space: low and in front, the
   heap sitting on its rim. And how much food is a full one. */
export const BASKET_AT = { y: -0.36, z: 0.28, rim: 0.07 };
export const BASKET_FULL = 0.8;
export const _cLoad = new THREE.Color();
const _sLoad = new THREE.Vector3();
/* A limb's matrix widened for its build, written without widening the chain the
   next piece hangs from. */
const _mFit = new THREE.Matrix4();

/* A closed hand: shorter, thicker, squarer. The box is the same box. */
export const FIST = new THREE.Vector3(1.25, 0.72, 1.45);

/* The fire, its light, and its smoke. */
export function updateCamps(dt, t, day) {
  if (!campParts) return;
  const night = 1 - day;
  for (let i = 0; i < camps.length; i++) {
    const camp = camps[i];
    // Two incommensurate sines: a flame that never repeats on a countable beat.
    const flick = 0.78 + 0.22 * Math.sin(t * 11 + camp.flicker) + 0.12 * Math.sin(t * 27.3 + camp.flicker * 2);
    // Barely there in daylight, the only light in the world after dark.
    camp.light.intensity = (camp.stage || 0) >= CITY.at ? 0 : (4 + night * 62) * flick;   // a city has no fire
    /* Every hearth the band has lit, and each on its own beat — one flicker
       shared by five fires is five flames doing the same thing at the same
       moment, which reads as a mechanism rather than as fire. The unlit ones
       are left where dressCamp parked them. */
    for (let f = 0; f < (camp.hearths || 0); f++) {
      const at = camp.fireAt?.[f];
      if (!at) continue;
      const own = f === 0 ? flick
        : 0.78 + 0.22 * Math.sin(t * 11 + camp.flicker + f * 2.1)
          + 0.12 * Math.sin(t * 27.3 + camp.flicker * 2 + f * 1.3);
      _v.set(at.x, at.y + 0.05, at.z);
      _q.identity();
      _s.set(0.85 + own * 0.25, 0.8 + own * 0.45, 0.85 + own * 0.25);
      _m4.compose(_v, _q, _s);
      campParts.fire.setMatrixAt(i * HEARTHS + f, _m4);
    }
  }
  campParts.fire.instanceMatrix.needsUpdate = true;
  /* And the outskirts' fires, each on its own beat like the core's. */
  if (campParts.outFire) {
    for (const camp of camps) {
      for (const { slot, fire, f } of camp.outerFires || []) {
        const own = 0.78 + 0.22 * Math.sin(t * 11 + camp.flicker + f * 2.1)
          + 0.12 * Math.sin(t * 27.3 + camp.flicker * 2 + f * 1.3);
        _v.set(fire.x, fire.y + 0.05, fire.z);
        _q.identity();
        _s.set(0.85 + own * 0.25, 0.8 + own * 0.45, 0.85 + own * 0.25);
        campParts.outFire.setMatrixAt(slot, _m4.compose(_v, _q, _s));
      }
    }
    campParts.outFire.instanceMatrix.needsUpdate = true;
  }

  if (!smoke) return;
  smokeUniforms.uViewportH.value = renderer.domElement.height;
  smokeUniforms.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const pos = smoke.geometry.attributes.position.array;
  const life = smoke.geometry.attributes.aLife.array;
  const wind = windUniforms.uWindDir.value;
  const drift = 0.7 + P.wind * 7.5;
  for (let i = 0; i < life.length; i++) {
    life[i] += dt * 0.12;
    if (life[i] >= 1) { resetSmoke(i, 0); continue; }
    pos[i * 3] += (wind.x * drift + (Math.random() - 0.5) * 0.4) * dt;
    pos[i * 3 + 1] += (1.9 - life[i] * 0.9) * dt;
    pos[i * 3 + 2] += (wind.y * drift + (Math.random() - 0.5) * 0.4) * dt;
  }
  smoke.geometry.attributes.position.needsUpdate = true;
  smoke.geometry.attributes.aLife.needsUpdate = true;
}

export function buildWorld() {
  const q = QUALITY[P.quality];
  /* Back to the start of the stream. Rebuilding a world has to replay it, not
     carry on from wherever the last one had got to — otherwise loading the same
     seed twice in one session gives two different histories, which is the bug
     this whole thing exists to remove. */
  seedSim(P.seed);
  disposeWorld();
  buildField(q.seg);
  // Nobody has walked anywhere yet, and this is the only place that is true.
  buildPaths();
  // Nor picked anything: the ground starts as full as the noise says it is.
  buildForaged();
  // Before the mesh: the creeks cut the field the terrain is then built from,
  // so their valleys are real ground that everything else can read.
  traceStreams(P.counts.streams | 0);
  carveStreams();
  buildTerrain(q.seg);
  buildWater();
  buildStreamWater();
  // Camp sites are picked before anything is scattered, so the trees and the
  // grass can leave a clearing instead of being cut down afterwards.
  chooseCampSites(P.counts.camps | 0);
  buildTrees(P.counts.trees | 0);
  buildRocks(P.counts.rocks | 0);
  buildDeposits();
  buildThickets();
  buildCamps();
  buildGraves();
  buildPeople(P.counts.people | 0);
  buildNearParts();
  buildAnimals();
  buildGrass(q.grid, P.counts.grass | 0);

  /* Open the books before anybody picks a job. Everything about what a person
     does next comes off `camp.hunger`, and until this runs it is whatever the
     camp was built with — so the first job every one of them chooses is chosen
     against a number nobody has worked out yet. A day of zero eats nothing and
     spoils nothing; it counts heads, works out the need and reads the store. */
  updateEconomy(0);

  renderMapBase();
  applyShadowSettings(q);
  const ratio = Math.min(devicePixelRatio || 1, q.pixelRatio);
  renderer.setPixelRatio(ratio);
  starUniforms.uPixelRatio.value = ratio;
  waterUniforms.uWaves.value = P.waves;
  waterUniforms.uRipple.value = P.waves;
}

/* Rebuilds narrow enough that a slider can drive them. Changing the rabbit
   count has no business regenerating the terrain — the height field alone is
   most of the build time — nor teleporting the camera back to spawn. */
export function rebuildPeople() {
  // The camps stay; only the band is rebuilt.
  if (personParts) {
    for (const key in personParts) {
      tribeGroup.remove(personParts[key]);
      personParts[key].geometry.dispose();
    }
  }
  clearLooks();
  people.length = 0;
  setPersonParts(null);
  buildPeople(P.counts.people | 0);
  updateHud();
}
export function rebuildFauna() {
  disposeGroup(fauna);
  clearFauna();
  buildAnimals();
  updateHud();
}
export function rebuildTrees() {
  disposeGroup(floraGroup);
  buildTrees(P.counts.trees | 0);
  updateHud();
}
export function rebuildRocks() {
  disposeGroup(rockGroup);
  buildRocks(P.counts.rocks | 0);
  updateHud();
}
export function rebuildGrass() {
  disposeGroup(grassGroup);
  setGrassTiles([]);
  setDirtyTiles([]);
  buildGrass(QUALITY[P.quality].grid, P.counts.grass | 0);
  updateTiles(true);
  recountBlades();
}
export function recountBlades() {
  stats.blades = grassTiles.reduce((n, t) => n + (t.mesh.userData.live || 0), 0);
  updateHud();
}

export function applyShadowSettings(q = QUALITY[P.quality]) {
  const on = P.shadows && q.shadowMap > 0;
  renderer.shadowMap.enabled = on;
  sunLight.castShadow = on;
  /* One number for every caster in the scene, so it is set by the largest
     surface casting. With the hills out of it, the tallest thing throwing a
     shadow is a tree, and six centimetres is plenty. */
  sunLight.shadow.normalBias = P.terrainShadow ? 1.6 : 0.06;
  terrainGroup.traverse((o) => { if (o.name === 'terrain') o.castShadow = Boolean(P.terrainShadow); });
  if (q.shadowMap > 0) {
    // A shadow map already uploaded keeps its old size until the map is
    // disposed, so drop it and let three allocate the new one.
    sunLight.shadow.map?.dispose();
    sunLight.shadow.map = null;
    sunLight.shadow.mapSize.set(q.shadowMap, q.shadowMap);
  }
  // Whether a material samples a shadow map is baked into its program.
  world.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
}

/* Where the camera goes when a world is built. It used to be a button as
   well; it is not any more, and only the world-building calls it. */
export function placeCamera() {
  const y = sampleHeight(0, 0);
  camera.position.set(0, y + 13, 46);
  controls.target.set(0, y + 2.5, 0);
  camera.lookAt(controls.target.x, controls.target.y, controls.target.z);
  syncLookFromCamera();
  if (P.view === 'orbit') controls.update();
  updateTiles(true);
  recountBlades();
}

/* -------------------------------------------------------------------------
   Camera

   Three ways to be in the world, because one rig cannot do all three jobs.

   Orbit was the only mode, and it is the reason every view looked like a person
   standing in a field: the rig orbits a point a couple of metres above the
   ground and drags that point along as you walk, so the ground clamp is always
   in the frame and you can never really leave head height. It is still the best
   mode for circling a thing and looking at it, so it stays — as one option.

   Fly is the default now: no target, no orbit, no clamp beyond not burrowing
   into the hill. Yaw and pitch live on the camera itself, W follows wherever
   you are looking, and you can climb until the island is a shape below you.

   Walk is the locked-to-a-person view made deliberate rather than accidental —
   eye height, no vertical, feet on the terrain.
   ------------------------------------------------------------------------- */

export const VIEW_MODES = ['orbit', 'follow'];

/* The key list. It lives in the markup and only needs showing, hiding, and
   telling which view is current. */

