import { clamp } from './noise.js';
import { CAMP_CLEARING } from './people.js';
import { PERSON } from './clock.js';
import { eatFromBag } from './bag.js';

/* -------------------------------------------------------------------------
   Life, rest and food, for the person you are playing

   One bar, life, out of a hundred. The band's own energy was the wrong thing
   to show: walking costs it nothing and standing gives it back, so it sat at
   the top whatever you did. Life is spent by what you have them do —

     walking, and far more running; working; all of it more under a load;
     the cold, out away from the camp at night or in winter; being ill —

   and won back two ways:

     rest   X: sit down where they stand. Some of it comes back, faster at home
            by their own fire, where an illness passes quicker too — but rest
            alone never fills it;
     eat    N: a meal. At home, out of the band's store; anywhere else, out
            of the basket. Worth more than rest, and it can fill it.

   Worn down, they slow, and near the end they cannot run at all. For the
   person you are playing it is their energy — so a run is paid for out of it —
   and nobody else has one: handed back to the band, they look after
   themselves at home, and the band's own people rest and eat the way they
   always have.
   ------------------------------------------------------------------------- */
export const LIFEBAR = {
  idle: 0.0004,        // per second, just being awake: a hundred in about forty minutes
  walk: 0.0012,        // walking, on top of that
  run: 0.004,          // running, on top of walking
  work: 0.0008,        // digging, picking, fishing
  cold: 0.0025,        // out in the cold, times how cold (night, winter, or both)
  sick: 0.0008,        // ill
  rest: { out: 0.002, home: 0.005 },   // won back per second, resting
  restCap: { out: 0.6, home: 0.8 },    // and the most rest alone brings it to
  meal: 0.3,           // life a meal gives back
  runFrom: 0.2,        // below this they cannot run
  weakFrom: 0.25,      // and below this they slow
  crawl: 0.35,         // to this much of a walk, at nothing left
};
/* How much faster the band's energy comes back resting — still used for the
   illness, and for whoever is not being played. */
export const REST = {
  out: 1.6,            // resting anywhere, against standing about
  home: 4,             // resting at home, by their own fire
  heal: 2.5,           // how much faster an illness runs its course resting at home
};
export const EAT = {
  meal: 0.3,           // food units in a meal — a third of an adult's day
  fill: 0.35,          // how much of "fed" one meal gives back
  lift: 0.1,           // and energy, straight away
};

/** On their own band's ground, by its fire. */
export function atHome(p) {
  return Boolean(p.camp) && Math.hypot(p.x - p.camp.x, p.z - p.camp.z) < CAMP_CLEARING;
}

/** How much faster energy comes back than it would standing about. */
export function restBoost(p) {
  return p.resting ? (atHome(p) ? REST.home : REST.out) : 1;
}

/** How much faster an illness passes. */
export function restHeal(p) {
  return p.resting && atHome(p) ? REST.heal : 1;
}

/** Where life starts, the first time somebody is played: from how they were. */
export function startLife(p) {
  return clamp(Math.min(p.energy ?? 1, p.nourish ?? 1), 0.5, 1);
}

/** Every step, for anybody who has a life bar. `loadFrac` is what they carry
    against what they can. */
export function spendLife(p, slice, loadFrac = 0) {
  if (p.life == null) p.life = startLife(p);
  /* Handed back to the band: at home they look after themselves — rest, and
     a meal out of the store if there is one. Away from it, it waits. */
  if (!p.led) {
    if (atHome(p)) {
      const cap = p.camp.food >= EAT.meal ? 1 : LIFEBAR.restCap.home;
      if (p.life < cap) p.life = Math.min(cap, p.life + LIFEBAR.rest.home * slice);
    }
    return;
  }
  const chill = LIFEBAR.cold * (1 - (p.cold ?? 1));
  if (p.resting) {
    const home = atHome(p);
    const cap = home ? LIFEBAR.restCap.home : LIFEBAR.restCap.out;
    const gain = (home ? LIFEBAR.rest.home : LIFEBAR.rest.out) * (p.sick ? 0.5 : 1);
    if (p.life < cap) p.life = Math.min(cap, p.life + gain * slice);
    p.life = Math.max(0, p.life - chill * slice);
    return;
  }
  const walk = clamp(p.speed / PERSON.walk, 0, 1);
  const run = clamp((p.speed - PERSON.walk) / (PERSON.jog - PERSON.walk), 0, 1);
  const drain = LIFEBAR.idle + (LIFEBAR.walk * walk + LIFEBAR.run * run) * (1 + clamp(loadFrac, 0, 1))
    + (p.acting ? LIFEBAR.work : 0) + LIFEBAR.cold * (1 - (p.cold ?? 1)) + (p.sick ? LIFEBAR.sick : 0);
  p.life = Math.max(0, p.life - drain * slice);
}

/** Worn down, they slow; near the end they cannot run. Only yours. */
export function lifeWant(p, want) {
  if (!p.led || p.life == null) return want;
  if (p.life < LIFEBAR.runFrom) want = Math.min(want, PERSON.walk);
  if (p.life < LIFEBAR.weakFrom) want *= LIFEBAR.crawl + (1 - LIFEBAR.crawl) * (p.life / LIFEBAR.weakFrom);
  return want;
}

/** Whether there is anything for them to eat where they are. */
export function canEat(p) {
  return p.haul > 0 || (atHome(p) && p.camp.food >= EAT.meal);
}

/** A meal: from the store at home, from the basket anywhere. Called from the
    step, like any act. Returns what to say about it. */
export function eat(p) {
  const fed = clamp(p.nourish ?? 1, 0, 1);
  const life = p.life ?? startLife(p);
  if (life > 0.97 && fed > 0.98) return 'not hungry';
  let ate = 0, said = '';
  if (atHome(p) && p.camp.food >= EAT.meal) {
    p.camp.food -= EAT.meal;
    ate = EAT.meal;
    said = 'ate from the store';
  } else {
    const was = p.bag ? { ...p.bag } : null;
    ate = eatFromBag(p, EAT.meal);
    const what = was ? ['berries', 'fruit', 'fish']
      .map((k) => ((was[k] || 0) - (p.bag[k] || 0) > 0 ? (was[k] || 0) - (p.bag[k] || 0) + ' ' + k : ''))
      .filter(Boolean) : [];
    said = 'ate ' + (what.join(' and ') || 'from the basket');
  }
  if (!(ate > 0)) return atHome(p) ? 'nothing in the store or the basket' : 'nothing to eat — gather some, or go home';
  const share = ate / EAT.meal;
  p.nourish = clamp(fed + EAT.fill * share, 0, 1);
  p.energy = Math.min(p.nourish, clamp(p.energy + EAT.lift * share, 0, 1));
  p.life = clamp(life + LIFEBAR.meal * share, 0, 1);
  return said + ' · life +' + Math.round(LIFEBAR.meal * share * 100);
}

/** The life bar, as a number out of a hundred and what to do about it. */
export function condition(p) {
  const life = Math.round(clamp(p.life ?? startLife(p), 0, 1) * 100);
  const home = atHome(p);
  const cold = (p.cold ?? 1) < 1;
  let hint = '';
  if (p.resting) hint = home ? 'resting at home · X to get up' : 'resting · faster at home';
  else if (life < 25) hint = 'worn out — eat (N) or rest (X)';
  else if (p.sick) hint = home ? 'ill — rest (X)' : 'ill — rest at home';
  else if (cold) hint = 'cold out here — get home';
  else if (life < 60) hint = 'eat (N) or rest (X)';
  return {
    life, hint, low: life < 25, mid: life < 50,
    detail: 'life ' + life + ' of 100' + (p.sick ? ' · ill' : '') + (cold ? ' · cold' : ''),
  };
}
