import { clamp } from './noise.js';
import { luck } from './clock.js';
import { MONUMENT_MAX, camps, dressCamp, drawGraves, people } from './people.js';
import { FISH, logEvent } from './life.js';

/* -------------------------------------------------------------------------
   Skills: what a band knows, and what knowing it is worth

   Lifted out of life.js whole, because life.js had grown past the length of the
   page it was split out of — which is a rule this project keeps rather than a
   number it happens to be under. Nothing here changed on the way across; it was
   already one subject with one edge, which is what made it the piece to move.

   It imports `logEvent` from life.js and life.js imports most of this back. The
   cycle is fine and the reason is worth writing down: every binding crossing it
   in either direction is a function declaration or a const initialised at
   module scope, and nothing here is CALLED while a module is still loading.
   That is the rule the whole split turns on.
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   What a band knows

   Until now a band on day one and the same band fifty years later were the same
   band: nothing it did ever added up to anything. Knapping was an animation.

   Three things it can get better at, each of which changes a number the food
   economy already reads. They are held by the camp, but they are CAPPED by what
   the living remember — a camp can practise a little past its best memory and
   no further, so a hard winter that takes the elders takes the drying racks
   with them, and the grandchildren have to work it out again. That is the whole
   point: an arrow of time, and two bands on one map that diverge.
   ------------------------------------------------------------------------- */

export const SKILLS = {
  spears: { label: 'spears', of: 'knapping' },
  baskets: { label: 'baskets', of: 'weaving' },
  drying: { label: 'drying', of: 'curing' },
  /* Three more, and the reason for them is that three was not enough to make
     two bands different from each other. With three, every band that lasted
     learned all of them and the interesting question — what is this band good
     at? — had one answer. Six is enough that a century leaves two bands with
     different histories: one that has buried a lot of people and knows how to
     treat a fever, one that has been hungry and can find a deer at three
     hundred metres.

     Each does something the simulation already had a number for. A skill that
     only shows on a readout is a readout, not a skill. */
  herbs: { label: 'herbs', of: 'healing' },
  tracking: { label: 'tracking', of: 'tracking' },
  fire: { label: 'fire', of: 'fire-keeping' },
  /* And a seventh, which is the only one that is not a technique.

     A band that buries its dead in one place has somewhere, and going back to
     it is the oldest thing people do that no animal does. It is learned the way
     the others are — by doing it, at a burial and afterwards — and it is
     forgotten the same way, which is what makes a long-settled band different
     from one that arrived last spring rather than merely older.

     Like every other skill here it had to do something the simulation already
     had a number for, or it is a readout. See SKILL.holdGround. */
  rites: { label: 'rites', of: 'burying' },
  /* And an eighth, which is the seventh grown up.

     `rites` is going back to the stones. This is what a band does once going
     back is not enough: it raises something over its dead — a ring, an avenue,
     a cairn — and the form is the band's own, off its own stream, so two
     villages a kilometre apart have raised different things. It is the first
     mark any of them leaves that is not shelter or a tool.

     What it moves: a band that has raised something is a band other bands walk
     to. See SKILL.artDraw. */
  art: { label: 'art', of: 'raising stones' },
  /* Ninth and tenth, and between them they are the two halves of having things
     at all: making them, and getting them somewhere else.

     `wares` is the domestic craft — hides scraped and sewn, bedding, pots, the
     carved and the useful. It is not weaving (that is `baskets`, and it is
     about carrying) and it is not knapping. What it moves is how well a band
     rests in its own camp, which is the number a dry bed has always changed.

     `trade` is dealings between bands. It is learned by doing it, like the
     graveyard pair — you get better at trading by trading — and what it moves
     is how much actually changes hands when somebody walks over the hill. */
  wares: { label: 'wares', of: 'making things' },
  trade: { label: 'trade', of: 'trading' },
  /* Eleventh and twelfth, and they are a chain rather than two more entries:
     one gets the stone out of the ground, the other turns it into something
     that makes every other job quicker.

     `mining` is worked at an outcrop rather than at the fire — the only skill
     besides the graveyard pair with somewhere it has to be done — and what it
     produces is not a number on a card but a stock in the camp. Stone does not
     spoil, which is the whole of what makes it different from food: a band can
     hold it, and therefore trade it.

     `tools` is what the stone is for. It does not sharpen a spear (that is
     `spears`) or weave a better basket (that is `baskets`); it makes the work
     itself quicker — an errand that took twenty seconds takes twelve — so a
     band with tools gets more done in a day than a band without. It cannot be
     practised without stone in the camp, which is why the two are one thing. */
  mining: { label: 'mining', of: 'quarrying' },
  tools: { label: 'tools', of: 'toolmaking' },
  /* And the thirteenth, which is the only one nobody is better off for two
     bands having.

     A band with a full pile and a hungry neighbour is a fact about the world
     before it is a fact about either of them, and until now the neighbour could
     only ask. `war` is what a band does instead of asking. It is one skill and
     not two — fighting is fighting, and the band that has raided is the band
     that knows how to hold a camp — and it is learned the way trading is, by
     doing it, on both sides of it.

     What it moves is the odds when a raid arrives. See SKILL.warEdge. */
  war: { label: 'war', of: 'fighting' },
  /* And the fourteenth. The island has had water round it since the first frame
     and nothing has ever eaten out of it.

     `fishing` is the skill and the raft is what it builds. Two thirds of the
     water is out of reach from the bank, so a band that gets good at this stops
     being limited by the season on the ground — which is why a coast band eats
     in February. It is the only skill that opens ground rather than improving
     what a band already does with it. */
  fishing: { label: 'fishing', of: 'fishing' },
  /* And the fifteenth: cutting wood. Learned at a tree and nowhere else, and
     what it moves is how many logs a trip brings home (WOOD.perTrip, in
     wood.js) — which is how soon a band on a coast has its raft. */
  woodcraft: { label: 'woodcraft', of: 'woodcutting' },
  /* Sixteenth and seventeenth, and a chain like mining and tools: nothing is
     sown until a band can get water onto the ground. `irrigation` is learned
     digging ditches and carrying water at the band's field, and `farming` only
     once that is a fair hand — then the field feeds them, and past a fair hand
     at farming a pen of animals gives a little every day, winter included. The
     first food anybody on the island makes rather than finds (farming.js). */
  irrigation: { label: 'irrigation', of: 'watering' },
  farming: { label: 'farming', of: 'farming' },
};

/* Every skill at nothing. Built from SKILLS rather than written out, because it
   was written out in five places and adding a seventh skill should not be a
   hunt through the file for the ones that were missed. */
export const emptySkills = () => Object.fromEntries(Object.keys(SKILLS).map((k) => [k, 0]));

/* What one person remembers, read back off a save.

   Saves written before there were six skills carry three, in order, as an
   array. Reading that as an object gives everybody nothing; reading the new
   object as an array gives the same. So: both shapes, and the old one is
   mapped by the order it was written in rather than by position in whatever
   SKILLS happens to say today — insert a skill in the middle and an ordered
   read would hand everybody's knapping to the weavers. */
export const SAVED_SKILL_ORDER = ['spears', 'baskets', 'drying'];

export function knowsFrom(kn) {
  const out = emptySkills();
  if (Array.isArray(kn)) {
    SAVED_SKILL_ORDER.forEach((k, i) => { if (k in out) out[k] = Number(kn[i]) || 0; });
  } else if (kn && typeof kn === 'object') {
    for (const k in out) out[k] = Number(kn[k]) || 0;
  }
  return out;
}

export const SKILL = {
  perCraft: 0.028,     // mastery gained by one completed session
  teach: 0.86,         // how much of the camp's level a child grows up with
  step: 0.14,          // how far past the best living memory a camp can go
  fade: 0.010,         // mastery lost per sim-day with nobody practising
  /* What mastery is worth. Deliberately large: the difference between a band
     that has been going a century and one that started last spring should be
     the difference between eating and not. */
  spearChance: 1.20,   // kill chance, at mastery
  basketHaul: 0.90,    // what a foraging trip brings home
  dryKeep: 0.65,       // how much less of the store spoils
  /* Healing. The sickness was the leading cause of death and the only one
     nobody could do anything about; this is the something. Not a cure — 0.55
     of the mortality at mastery still leaves a plague worth fearing — but it is
     the difference between a band that comes through one and a band that does
     not, and it is the only skill you can watch pay off in a week. */
  herbCure: 0.55,      // how much less a sickness kills
  /* Tracking. Hunters look for prey inside FOOD.searchRadius; at mastery they
     look half as far again. Reach is what turns hunting from a thing that works
     when a deer wanders past into a thing a band does on purpose. */
  trackFar: 0.50,      // further a hunter will find something
  /* What belief is worth, and it is the one thing that would make a band stay
     somewhere it should leave.

     A band gives up its ground when it has been squeezed for `GROUND.patience`
     sim-days — a rule about food and crowding, and the right one. A band with
     its dead in the next field weighs that differently: at mastery it endures
     two and a half times as long before it will walk away. Sometimes that is
     the reason it survives the crowding, and sometimes it is the reason it
     starves rather than moving, which is what belief is for. */
  holdGround: 1.5,     // extra patience with the ground, at mastery
  /* Practised at a burial, and by going back afterwards. A burial is rare and
     worth a great deal; standing at the stones is common and worth little. */
  perBurial: 0.06,
  perVisit: 0.012,
  /* Raising stones. A band only thinks about it once it has somewhere to raise
     them and somebody to raise them over, which is why the weight below is a
     function of how many are buried rather than a constant — a band that has
     lost nobody is not building a monument to nobody. */
  perStone: 0.020,
  /* And what it is worth: a band that has raised something is a band other
     bands walk to. Visiting is how everything one band knows reaches another,
     so a monument pulls ideas toward it — which is the least romantic and most
     defensible thing a gathering place has ever done. */
  artDraw: 2.2,       // how much likelier a band with a monument is to be visited
  /* Home goods. A band with hides, bedding and a dry place to put them rests
     better in its own camp — which is the one thing in this world that decides
     what anybody is fit to do the next morning. At mastery a night is worth
     half as much again, and the band that sleeps well is the band that hunts. */
  wareRest: 0.55,     // how much better a well-kept camp rests
  /* Trading. What actually changes hands when somebody walks over the hill:
     at mastery a band gives away half again as much of its surplus, which is
     the difference between a neighbour who is fed and one who is merely visited.
     It cuts both ways, and that is the point — a band good at trading is a band
     that has given a lot away. */
  tradeGift: 0.60,    // more of the surplus moved, at mastery
  perDeal: 0.030,     // learned by doing it: a visit that ends in a gift
  perCall: 0.008,     // and a little for the walk itself
  /* Quarrying. What one trip to an outcrop brings back, and what it teaches.
     Stone is heavy: a trip is worth about a day of one person's toolmaking,
     which is why a band that wants tools sends people to the rocks rather than
     picking up whatever is lying about. */
  perQuarry: 0.024,
  stonePerTrip: 1.0,
  stoneMax: 40,       // what a camp can keep. It does not spoil; it does pile up.
  /* Toolmaking, and the stone one session eats. A band with no stone cannot
     practise this at all — the skill and the stock are one thing. */
  perTool: 0.026,
  stonePerTool: 0.6,
  /* And what tools are worth: how much quicker the work goes. At mastery an
     errand takes a little over half as long, so a day holds nearly twice the
     errands — which is the difference tools have always made, and it compounds
     with everything else a band knows. */
  toolSpeed: 0.45,    // share off the length of a work session, at mastery
  /* Fighting. What a band's skill at it is worth against a band without any:
     at mastery it counts for two and a half people, so a small practised band
     can hold off a larger desperate one — which is what makes defending worth
     anything and raiding a gamble rather than an arithmetic problem. */
  warEdge: 1.5,
  perRaid: 0.045,     // learned by raiding, and by being raided
  perCatch: 0.022,    // learned standing in the water
  /* Fire-keeping. A tiger will not come within PANIC.safe of a fire, and a
     better-kept fire pushes that out — see safeGround in wildlife.js, where the
     metres live next to the tiger that respects them. */
};

/** The best any living adult of this camp actually remembers. */
export function bestKnown(camp, key) {
  let best = 0;
  for (const p of people) {
    if (p.camp !== camp || p.child) continue;
    const k = p.knows?.[key] || 0;
    if (k > best) best = k;
  }
  return best;
}

/* Practice, bounded by memory. A camp can push a little past what its best
   hand remembers and no further, which is what makes losing people cost
   something later rather than only at the funeral. */
export function practise(camp, key, amount) {
  const was = camp.skill[key];
  const cap = Math.min(1, bestKnown(camp, key) + SKILL.step);
  camp.skill[key] = clamp(camp.skill[key] + amount, 0, Math.max(cap, was));
  announceSkill(camp, key);
  /* Stones are the one skill with something standing in the world to show for
     it, so the world has to be told. Only when the count of them changes: `art`
     moves every afternoon somebody spends at the ground and a stone goes up
     about once a year, and redrawing four hundred graves for a number nobody
     can see is four hundred graves a frame. */
  /* The raft is built out of the wood a band has cut and stacked, not out of
     a skill: see storeWood, in wood.js. */
  if (key === 'art') {
    const up = Math.round(MONUMENT_MAX * camp.skill.art);
    if (up !== camp.stonesUp) { camp.stonesUp = up; drawGraves(); }
  }
}

/* Quarters, so the chronicle says something when a band crosses a threshold
   and nothing while it inches along.

   With hysteresis, and it is not optional. A band that has mastered something
   sits exactly on 1.0: practice pushes it to the cap and the fade pulls it a
   hair under, every frame — and comparing before against after announced
   "has mastery of curing" and "has forgotten how to cure meat" in the same
   minute, for ever. What is announced is compared against what was LAST
   ANNOUNCED, and it takes a clear margin to move — a small one to climb, a
   wider one to fall, because losing a skill is the louder claim. */
export const SKILL_STEPS = [0.25, 0.5, 0.75, 1];
export const SKILL_WORDS = ['', 'the beginnings of', 'a fair hand at', 'real skill at', 'mastery of'];
/* The same five rungs as a label. SKILL_WORDS is written to sit in the middle
   of a sentence — "has a fair hand at knapping" — and a column in a table wants
   the words on their own. */
export const SKILL_RUNGS = ['not yet', 'beginnings', 'a fair hand', 'real skill', 'mastery'];
export const SKILL_RISE = 0.02;
export const SKILL_FALL = 0.06;
export const FORGET_WORDS = {
  knapping: 'knap', weaving: 'weave', curing: 'cure meat',
  healing: 'treat the sick', tracking: 'track', 'fire-keeping': 'keep a fire',
  /* Not "bury" — a band that loses this has not forgotten how to dig a hole.
     What goes is the going back to it. */
  burying: 'sit with their dead',
  /* Not "raise stones" — the stones are still standing. What a band loses is
     the knowing why, which is the only way any of this is ever lost. */
  'raising stones': 'say what the stones are for',
  'making things': 'make anything but tools',
  trading: 'deal with the next band',
  quarrying: 'get stone out of the ground',
  toolmaking: 'make a tool worth carrying',
  /* A band that forgets this is a band with nobody who has ever had to. */
  fighting: 'stand anybody off',
  /* The raft rots and nobody remembers why it was worth the wood. */
  fishing: 'take anything out of the water',
  /* The axe is still there. Nobody remembers which trees split clean. */
  woodcutting: 'cut a log worth carrying',
  /* The ditches are still there. Nobody remembers where the water came in. */
  watering: 'get water onto a field',
  farming: 'bring anything up out of the ground',
};

/* Which rung a mastery is standing on, given the rung it was last said to be
   on. Pulled out of announceSkill because the restore needs the same answer
   without saying anything: `told` is derived from `skill` and is not saved, so
   it has to be worked out again on the way back in. */
export function skillTier(v, told = 0) {
  let tier = told;
  while (tier < SKILL_STEPS.length && v >= SKILL_STEPS[tier] + SKILL_RISE) tier++;
  while (tier > 0 && v < SKILL_STEPS[tier - 1] - SKILL_FALL) tier--;
  return tier;
}

export function announceSkill(camp, key) {
  const v = camp.skill[key];
  const told = camp.told[key] || 0;
  const tier = skillTier(v, told);
  if (tier === told) return;
  camp.told[key] = tier;
  // The rack goes up, or comes down, the moment drying crosses the line.
  if (key === 'drying') dressCamp(camp);
  // And the field, the moment digging or farming crosses a line (farming.js).
  if (key === 'irrigation' || key === 'farming') dressCamp(camp);
  logEvent(tier > told ? 'learned' : 'lost',
    tier > told
      ? `[${camp.code}] ${camp.name} has ${SKILL_WORDS[tier]} ${SKILLS[key].of}`
      : `[${camp.code}] ${camp.name} has forgotten how to ${FORGET_WORDS[SKILLS[key].of]}`,
    camp.x, camp.z);
}

/* Nobody practising, and it slips — and it can never sit above what the living
   remember, so a camp that buries its last elder loses the difference that
   evening rather than gradually. */
export function fadeSkills(days) {
  /* Knowledge lives in people, so it fades as they go — but a band with nobody
     left has nobody left to forget. What they knew the day the last of them
     died is what they are remembered by, and it is what keeps their monument
     standing, which used to come down in the days after they did. */
  const living = new Set();
  for (const p of people) living.add(p.camp);
  for (const camp of camps) {
    if (!living.has(camp)) continue;
    for (const key in SKILLS) {
      const cap = Math.min(1, bestKnown(camp, key) + SKILL.step);
      camp.skill[key] = Math.max(0, Math.min(camp.skill[key] - SKILL.fade * days, cap));
      announceSkill(camp, key);
    }
  }
}

/* What a band works on is what it needs. Hungry, and it makes spears and
   baskets; comfortable, and it finally has the afternoon spare to build a
   drying rack — which is why the racks arrive in a good year and pay for
   themselves in a bad one. */
export function craftChoice(camp) {
  const h = camp.hunger;
  /* How much of the band is ill, which is what makes anybody think about
     medicine. It is the nicest of these: a band learns to treat a fever because
     it has been having fevers, so the bands that are good at healing are the
     ones that have been through something — and you can read that off the card
     years later. */
  let pop = 0, ill = 0;
  for (const q of people) {
    if (q.camp !== camp) continue;
    pop++;
    if (q.sick) ill++;
  }
  const sick = pop ? ill / pop : 0;
  const weights = [
    ['spears', 0.25 + 0.5 * h],
    ['baskets', 0.25 + 0.5 * h],
    ['drying', 0.20 + 0.7 * (1 - h)],
    ['tracking', 0.16 + 0.45 * h],
    ['fire', 0.14 + 0.40 * (1 - h)],
    ['herbs', 0.10 + 1.10 * sick],
    /* Made when there is time to make it, which is what a full store buys. A
       hungry band scrapes a hide to carry meat in; a fed one carves it. */
    ['wares', 0.16 + 0.55 * (1 - h)],
    /* And tools, but only with stone to make them from. A band with an empty
       quarry pile cannot practise this at all — which is the whole point of
       there being two skills rather than one: somebody has to go to the rocks
       first. */
    ['tools', (camp.stone || 0) >= SKILL.stonePerTool ? 0.30 + 0.35 * h : 0],
  ];
  /* Six weights for eight skills, and that is the shape of it: these are the
     things a band gets better at by sitting down and working at them. The other
     two are learned at the graveyard and nowhere else — going back to it, and
     raising something over it. */
  let roll = luck() * weights.reduce((a, w) => a + w[1], 0);
  return weights.find(([, w]) => (roll -= w) <= 0)?.[0] || 'spears';
}

/* -------------------------------------------------------------------------
   Roles

   A band of eight is eight people doing whatever needs doing, and that is
   right: there is no room in a hungry camp for somebody who only knaps. A band
   of forty with a full store is a different thing — it can afford to have
   somebody who is *the* knapper, and it gets better at knapping because of it.

   So specialising is not a setting, it is something a band can afford. Two
   conditions, both of them already meant something before this existed:
   households enough that the work can be split, and a store deep enough that a
   week of somebody not foraging does not show. Below either, everybody forages
   and the roles go away again — which is what a bad winter does to a village.

   A role is a bias, not an assignment. It multiplies the weight of the job it
   belongs to and zeroes the ones it refuses, so a knapper still eats, still
   sleeps and still runs from a tiger; they simply do not spend the morning out
   on the hill when there are twenty people who will.

   Who gets which is what they already know: `p.knows` is a person's own memory
   of each skill, so the band's best knapper becomes the knapper. It is the same
   number `pickChief` reads and the same one that caps what a camp can learn —
   the band specialises along the grain of what it happens to be good at.
   ------------------------------------------------------------------------- */

export const ROLE_AT = { families: 6, days: 8 };

/* Each role: the job it leans toward, what it will not do, the skill that
   argues for it, and how many of the band may hold it at once — as a share, so
   a village of forty has four hunters and a camp of ten has one. */
export const ROLES = {
  chief:   { job: 'tend',   refuses: ['gather', 'hunt', 'quarry'], by: null,      share: 0 },
  hunter:  { job: 'hunt',   refuses: [],                           by: 'spears',  share: 0.16 },
  knapper: { job: 'craft',  refuses: ['hunt'],                     by: 'tools',   share: 0.10 },
  healer:  { job: 'nurse',  refuses: ['hunt'],                     by: 'herbs',   share: 0.08 },
  keeper:  { job: 'tend',   refuses: ['hunt'],                     by: 'fire',    share: 0.08 },
  quarrier:{ job: 'quarry', refuses: [],                           by: 'mining',  share: 0.08 },
  trader:  { job: 'visit',  refuses: [],                           by: 'trade',   share: 0.06 },
  /* A warrior is not a job — there is nothing to do all day — so they lean on
     tending the fire and are the ones a raid is made of. A band keeps a few
     once it has anything worth taking; what makes them warriors is being at
     home when somebody comes for it. */
  warrior: { job: 'tend',   refuses: [],                           by: 'war',     share: 0.12 },
  fisher:  { job: 'fish',   refuses: ['hunt'],                     by: 'fishing', share: 0.14 },
  /* And everybody else, which is most of a band and always will be. Named
     rather than left blank: "forager" is what the others are specialising away
     from, and a card that says so reads better than one that says nothing. */
  forager: { job: 'gather', refuses: [],                           by: null,      share: 1 },
};

export const LEAN = 3.2;          // how much a role favours its own job

/** How strongly this person leans toward a job, given the role they hold. */
export function roleWeight(p, job) {
  const role = ROLES[p.role];
  if (!role) return 1;
  if (role.refuses.includes(job)) return 0;
  return job === role.job ? LEAN : 1;
}

/* Worked out for the whole band at once rather than per person, because the
   shares are a fact about the band: you cannot ask "am I the healer" without
   knowing who else wanted to be. */
export function assignRoles(camp, folk) {
  const adults = folk.filter((p) => !p.child);
  const fed = camp.food / Math.max(camp.need, 0.001);
  if (adults.length < ROLE_AT.families || fed < ROLE_AT.days) {
    /* Cannot afford them, or not any more. A band coming out of a hard winter
       goes back to everybody foraging, and that is the whole point of the
       condition rather than a tidy-up. */
    for (const p of folk) p.role = null;
    return;
  }

  for (const p of folk) p.role = p.child ? null : 'forager';
  const taken = new Set();
  const chief = camp.chief ? adults.find((p) => p.id === camp.chief) : null;
  if (chief) { chief.role = 'chief'; taken.add(chief.id); }

  for (const [name, role] of Object.entries(ROLES)) {
    if (!role.by || role.share <= 0) continue;
    const want = Math.max(1, Math.round(adults.length * role.share));
    const able = adults
      .filter((p) => !taken.has(p.id))
      .sort((a, b) => (b.knows?.[role.by] || 0) - (a.knows?.[role.by] || 0));
    for (let i = 0; i < want && i < able.length; i++) {
      /* Somebody has to be better at it than nothing. A band with no memory of
         mining does not have a quarrier; it has people who sometimes go to the
         rocks, which is where quarriers come from. */
      if ((able[i].knows?.[role.by] || 0) <= 0.02) break;
      able[i].role = name;
      taken.add(able[i].id);
    }
  }
}
