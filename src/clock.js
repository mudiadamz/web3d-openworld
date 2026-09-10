import { P } from './params.js';
import { clamp, mulberry32 } from './noise.js';
import { sunDir } from './scene.js';
import { CAMP_CLEARING, people } from './people.js';
import { $ } from './save.js';
import { HUMAN_JOINTS, HUMAN_PARTS } from './human-parts.js';

/* -------------------------------------------------------------------------
   How fast the clock runs

   Two things move it off 1×. The buttons, which are yours; and the night, which
   runs itself through once there is nobody left awake to watch.

   Both end up as one multiplier on dt, applied before anything else, so the
   sun, the calendar, the seasons, the food, the growing and the walking all
   stay in step. Scaling any of them separately is how a world ends up with
   people ageing faster than they can walk home.
   ------------------------------------------------------------------------- */

export const RATES = [0.25, 0.5, 1, 2, 4, 8, 16];
export let rateIndex = RATES.indexOf(1);

/* Night is skipped only when there is nothing to miss: everybody is either
   asleep in a hut or in among the huts. Anyone still out in the dark keeps the
   clock honest — watching somebody come home late is worth waiting for — but
   only until they are home, which is the difference between this and asking
   what job they hold. A person who set out gathering at dusk keeps that job all
   the way back to the fire, so testing the job meant one straggler could hold
   the whole night at 1×, and in one run out of eight it did. */
export let skipping = false;

/* What NIGHT_SKIP_RATE is measured against: at this value the night gets the
   whole of NIGHT_BUDGET, above it more of the frame and below it less. It is
   the old default, so every .env that set a rate keeps the sense it had —
   bigger is a quicker night. */
export const NIGHT_SKIP_BASE = 6;

/* Fifteen degrees below the horizon: past dusk, properly dark, and far enough
   in that whoever is still out there is not coming back before dawn. Both ends
   of the window are settings now — see NIGHT_FROM and NIGHT_DEEP — and this is
   what they default to. */
export const DEEP_NIGHT = -0.25;

/* The far end, never above the near end. Set the two the wrong way round and
   the deep test would fire before the night had started, which would run the
   world on through a sunset with everybody still out in it. Clamping here is
   cheaper than a validation rule nobody reads. */
export function deepNight() { return Math.min(P.nightDeep, P.nightFrom); }

export function nightIdle() {
  if (!P.nightSkip || sunDir.y > P.nightFrom) return false;
  if (!people.length) return true;            // nobody left to wait for
  /* Deep night runs whatever anybody is doing. Waiting on stragglers is right
     around dusk and wrong at two in the morning — one person who wandered off
     and never came back held a whole night at 1× in two runs out of eight, and
     a feature that only works when everybody behaves is not on by default. */
  if (sunDir.y < deepNight()) return true;
  for (const p of people) {
    if (p.asleep) continue;
    if (Math.hypot(p.x - p.camp.x, p.z - p.camp.z) > CAMP_CLEARING) return false;
  }
  return true;
}

/** What you asked for. Also where `skipping` is decided and the badge shown.

   It used to multiply by `nightSkipRate` as well — that was how the night was
   made to pass, by stretching one frame. The tick runs the night in proper
   world-steps now, so there is nothing here to scale: the rate went from a
   multiplier on the clock to a share of the frame, because as a multiplier it
   could not be raised without the clock leaving the sleeping behind. */
export function clockRate() {
  const wasSkipping = skipping;
  skipping = nightIdle();
  if (skipping !== wasSkipping) {
    const el = $('skip');
    if (el) el.hidden = !skipping;
  }
  return RATES[rateIndex];
}

/* The reference day used to be a constant here. It is P.paceDay now: set with
   PACE_DAY, or the day itself when that is not set — see params.js. */
export const PACE_MAX_STEP = 0.25;
/* How far anything is allowed to MOVE in one unwatched step. Larger than the
   live cap — smoothness is not a consideration when there is nothing to be
   smooth — but it is still an integration step, and how far it can be pushed
   before the outcomes drift is a question for measurement rather than taste.

   Note that it is a distance, not a duration. The duration follows from it: a
   two-hour day runs at half the pace of a one-hour day, so a step of it can
   cover twice as many seconds for the same movement. Fixing the DURATION
   instead made a long day cost twice the work for no extra fidelity, and with
   DAY_LENGTH and YEAR_LENGTH both at their maximum, five years was seven
   million steps. */
/* -------------------------------------------------------------------------
   One stream of luck for the whole simulation

   The seed built the island and nothing else. Everything people and animals did
   came off Math.random(), so the same seed replayed a different history every
   time — which is fine to watch and useless to measure against. Two arms of an
   A/B on the same six seeds are not two arms, they are twelve unrelated worlds,
   and the difference between them is mostly noise. It took a measurement that
   contradicted itself to notice.

   So the simulation draws from here instead, and the world is reproducible:
   same seed, same history. What matters is which code is allowed to draw from
   it. Only the eight things stepWorld calls, because they are the only things
   that run identically whether the world is being watched or run on unwatched.
   Smoke, birdsong, butterflies and the camera are skipped entirely while
   fast-forwarding, so a draw from this stream inside any of them would leave
   the same seed in two different places depending on whether anybody was
   looking — which is worse than not being seeded at all.

   Frame timing is the remaining caveat. Unwatched years advance in fixed
   steps, so those replay exactly; a world watched in real time advances by
   whatever each frame took, and two machines will not agree. The measurements
   run unwatched.
   ------------------------------------------------------------------------- */

export let simRng = mulberry32(1);
export const luck = () => simRng();
export function seedSim(seed) { simRng = mulberry32((seed | 0) ^ 0x9e37); }

export const FF_STEP = 0.5;

/** Seconds of world time per unwatched step, for whatever length the day is. */
export function ffStep() {
  return FF_STEP / Math.max(pace(), 0.001);
}

/* False while the world is being run on with nothing rendered. Every piece of
   work that exists only to put something on screen is skipped — and it turns
   out that is almost all of the per-frame cost: deciding what two hundred
   animals and twenty people do is cheap, and writing out the four thousand
   matrices that draw them is not. */
/* -------------------------------------------------------------------------
   Not everything, every step

   A simulated year was measured at 111 seconds, and 84 of them were the herds:
   two hundred animals deciding what to do, 172,800 times each. People were 14
   of it and everything else together was 11 — which is not where anybody would
   have looked, twenty-odd people being the thing the whole simulation is about.

   So they take turns. With more than `from` of something, they are dealt into
   groups and one group goes each step with the time the whole group waited —
   two hundred animals in groups of eight is a quarter of a million decisions a
   year rather than two million, and each animal still decides for itself, just
   less often. Nothing is merged and nothing is averaged.

   Only while nobody is watching. A herd stepping eight times as far, eight
   times less often, is a herd juddering across the field; unwatched there is
   nothing to judder. Which is also where it matters — watching costs whatever
   drawing costs, and running a decade does not draw at all.

   Predators are never grouped. A tiger closing on something covers thirty
   metres in one grouped step and would walk straight through the moment it was
   near enough to catch it. There are one or two of them; grouping them saves
   nothing and breaks the one thing on the map that hunts. */

export const LOD = {
  from: 24,            // fewer than this and everybody goes every step
  /* Groups of eight held a village. A world of two thousand in groups of eight
     is two hundred and fifty decisions a step, which is ten times what the
     island cost when this was written — so the cap has to rise with the crowd
     or it stops being a ceiling on the work and becomes a floor under it. At 64
     a thousand people cost what fifteen did. */
  most: 64,
  /* Animals are worth less thought than people are and there are ten times as
     many of them. Unwatched, a herd is a supply of meat standing in a field: it
     has to be somewhere and it has to still be there, but which way a particular
     deer is facing during a decade nobody watched is not a question worth
     answering 172,800 times. */
  herdCoarser: 6,      // how much larger an animal's group is than a person's
  /* Watching was free of this entirely, on the reasoning that a figure stepping
     four times as far four times as often judders. True of one figure crossing
     the middle of the screen; not true of two hundred, most of whom are a
     kilometre off and a few pixels tall — and with the grouping switched off
     while watching, a big world spent longer on a single drawn frame than on a
     year of running unwatched.

     So watching gets grouped too, gently: never coarser than this, which at the
     distances a crowd is actually seen from is not visible, and below the
     threshold it is still nobody at all. */
  watchedMost: 4,
};

export let worldStep = 0;
export function tickWorldStep() { worldStep++; }

/** How many take turns, for a population of this size. */
export function lodStride(n) {
  if (n <= LOD.from) return 1;
  const cap = drawingWorld ? LOD.watchedMost : LOD.most;
  return Math.max(1, Math.min(cap, Math.ceil(n / LOD.from)));
}

/** The same, for animals, which can afford to think much less often. */
export function herdStride(n) {
  if (drawingWorld) return lodStride(n);
  return Math.max(1, Math.min(LOD.most * LOD.herdCoarser,
    Math.ceil(n / LOD.from) * LOD.herdCoarser));
}

/** Whose turn it is this step. */
export function lodTurn(i, stride) {
  return stride === 1 || (i % stride) === (worldStep % stride);
}

/* Where this step's group starts, so a loop can step over the rest instead of
   walking past them and asking each one. */
export function turnStart(stride) {
  return stride === 1 ? 0 : worldStep % stride;
}

export let drawingWorld = true;

/* Seconds of world time, which is not the same as seconds. `elapsed` runs on
   the wall clock and drives the firelight and the toasts; this runs at whatever
   rate the world is being run at, and it is what a speed in metres per second
   has to be measured against. Dividing world metres by wall seconds gave a
   person walking at 1.35 a measured speed of 11 at 8x. */
export let worldClock = 0;
export function pace() { return clamp((P.paceDay || P.dayLength) / P.dayLength, 0.5, 12); }

/* A person, in the proportions of one. The limbs are in two pieces with a joint
   between them, which is most of what separates a figure from a mannequin: an
   arm that bends at the elbow and a leg that bends at the knee read as somebody
   walking even at fifty metres, where a straight limb reads as a stick swinging
   from a hip.

   Lengths are in metres at scale 1, and the upper and lower halves overlap
   slightly at every joint so there is no gap to see through when it bends. */
/* The body is the humans-threejs model (src/human-parts.js, vendored exactly as
   it is generated there): fifteen pieces, each already hanging from its own
   joint. So the rig takes its measurements from the model's joint table rather
   than keeping a second set that could drift away from the shapes. A thigh is
   exactly as long as the hip-to-knee the model was built around, and a foot
   lands on the ground because thigh, shin and ankle add up to the hip height —
   which the old hand-set numbers did not, by fourteen centimetres.

   Widths and depths are read off the shapes themselves. Nothing in the rig
   hangs anything from them; they size the near set's joints and fingers. */
const MODEL = HUMAN_JOINTS.male, MODEL_F = HUMAN_JOINTS.female;
const extent = (key) => {
  const a = HUMAN_PARTS[key].positions;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < a.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], a[i]);
    hi[i % 3] = Math.max(hi[i % 3], a[i]);
  }
  return { lo, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
};
/* Width, length, depth — the length being the bone's, joint to joint, when
   there is a next joint to reach. */
const across = (key, len) => {
  const { size } = extent(key);
  return [size[0], len ?? size[1], size[2]];
};
const HEAD = extent('head').size;

export const PERSON = {
  legLen: MODEL.hip[1],               // the hip joint's height: where the body's origin is
  /* Where the legs and arms hang from, across. A woman's hips are wider and
     her shoulders narrower, and in this model that is where the joints are,
     not different limbs — every limb is one shape shared by everybody, and only
     the torso differs. */
  hipX: MODEL.hip[0], hipXF: MODEL_F.hip[0],
  thigh: across('thigh', MODEL.lengths.thigh),          // hip to knee
  shin: across('calf', MODEL.lengths.calf),             // knee to ankle
  foot: across('foot'),
  neck: across('neck'), neckY: MODEL.neckBase[1] - MODEL.hip[1],
  shoulderY: MODEL.shoulder[1] - MODEL.hip[1],
  armX: MODEL.shoulder[0], armXF: MODEL_F.shoulder[0],
  upperArm: across('upperArm', MODEL.lengths.upperArm), // shoulder to elbow
  foreArm: across('forearm', MODEL.lengths.forearm),    // elbow to wrist
  // A hand's length is how far it hangs below the wrist, rounded end and all.
  hand: [extent('hand').size[0], -extent('hand').lo[1], extent('hand').size[2]],
  /* The head is held at its middle rather than its base, so a child's larger
     head grows about its own centre. headDrop is how far that is above the
     base of the skull the model hangs it from. */
  headY: MODEL.headCentre[1] - MODEL.hip[1], head: HEAD,
  headDrop: MODEL.headCentre[1] - MODEL.headBase[1],
  spear: [0.045, 2.1, 0.045],
  load: [0.30, 0.11, 0.26],       // the heap: across, high, deep
  basket: [0.19, 0.15, 0.17],     // the basket: rim, base, height
  stride: 0.78, walk: 1.35, jog: 3.6, turn: 3.0,
};

/* One table saying how many of each part a person has, so that the four places
   that walk the parts cannot disagree about it. Getting this wrong writes one
   limb's matrix over another's and the result is a person with three legs. */
/* Short of a right angle, so the ankle is always below the knee however the
   hip and the knee combine to get there. */
export const SHIN_MAX = 1.35;

export const PERSON_PARTS = {
  neck: 1, head: 1,
  upperArm: 2, foreArm: 2, hand: 2,
  thigh: 2, shin: 2, foot: 2,
  spear: 1, load: 1, basket: 1,
};
export const partsPer = (key) => PERSON_PARTS[key] || 1;

// Varied builds rather than one figure rescaled. Height, shoulder width and
// head proportion are the honest low-poly differences; everything else — what
// they do, what they wear, what colour they are — is drawn from the same pool.
/* The two adult builds are now what they always looked like they were: the
   broader-shouldered one is male, the broader-hipped one female. Nothing about
   the rendering changed — the shapes were already there — but a person now has
   a sex that the rest of the simulation can ask about, and `hair` is the thing
   you can actually read at a distance. */

/* rateIndex lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setRateIndex(v) { rateIndex = v; }

/* drawingWorld lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setDrawingWorld(v) { drawingWorld = v; }

/* worldClock lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setWorldClock(v) { worldClock = v; }
