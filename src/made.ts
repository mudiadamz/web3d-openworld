import { MONUMENT_MAX, PYRAMID_COURSES, RACK_KNOWN, camps, monumentPlan } from './people.js';
import { TENT_KEYS, tentStyle } from './village.js';
import { CLOTH } from './looks.js';
import { WOOD } from './wood.js';
import { FARM } from './farming.js';
import { CONQUEST } from './life.js';
import { SKILL, SKILL_HOW, SKILL_NEEDS, nextRung } from './skills.js';

/* -------------------------------------------------------------------------
   What a skill has made, counted

   The band card used to say 62/100: exact, and about nothing you could go and
   look at. This says what the skill has put in the world instead - three
   courses of a pyramid out of five, a raft, twelve logs of the twelve a raft
   takes - so every skill counts in its own thing, out of its own most.

   Most of them are read straight off the world: the rack is standing or it is
   not, the pen holds so many animals, the ditch is dug so far. The rest move a
   number and build nothing you can walk up to (a better spear is a better
   chance, not a mesh), and for those it is the kinds of thing a band makes as
   it gets better, named in the order it comes by them, a kind for every equal
   share of the way - the same sum that decides how many courses of the pyramid
   stand.

   Only chronicle.js reads this, so it sits in a module of its own at the far
   end of the import graph rather than in skills.js, which half the simulation
   imports and which would otherwise have to import the other half back.
   ------------------------------------------------------------------------- */

const KINDS = {
  spears: ['flaked points', 'hafted spears', 'barbed points', 'spear-throwers'],
  baskets: ['net bags', 'coiled baskets', 'twined baskets', 'lidded baskets', 'carrying frames'],
  tracking: ['fresh tracks', 'game trails', 'the herds\' crossings'],
  herbs: ['poultices', 'fever teas', 'splints', 'salves', 'sleeping draughts', 'medicine bundles'],
  fire: ['fire drills', 'banked embers', 'carried coals'],
  wares: ['hide bedding', 'fired pots', 'carved bowls', 'woven mats', 'painted pots'],
  tools: ['hammerstones', 'scrapers', 'stone adzes', 'polished axes'],
  war: ['clubs', 'hide shields', 'war parties'],
  trade: ['gifts', 'barter', 'trade partners', 'market days'],
  rites: ['marked graves', 'grave goods', 'mourning feasts', 'days for the dead'],
};

const TENT_WORDS = {
  huts: 'cones of hides', tentHide: 'hide tents', tentPainted: 'painted tents', lodge: 'lodges',
  house: 'houses', townhouse: 'townhouses',
};
const CLOTH_WORDS = ['hides', 'sleeves', 'leggings', 'dyed cloth'];

/** What one skill has made in one band: `n` of the most there can be, `of`,
    and what they are. `of` is 0 where the band has nowhere to make it - no
    shore to launch a raft from, no field to dig a ditch to. */
export function skillMade(camp, k) {
  const v = camp?.skill?.[k] || 0;
  if (KINDS[k]) {
    const kinds = KINDS[k], n = Math.min(kinds.length, Math.round(kinds.length * v));
    return { n, of: kinds.length, what: n ? kinds[n - 1] : '' };
  }
  switch (k) {
    case 'drying': return { n: v >= RACK_KNOWN ? 1 : 0, of: 1, what: 'rack' };
    case 'building': {
      /* Past the tents a village builds houses (society.js), which is further
         than any tent, so it counts as the top of the ladder. */
      const style = tentStyle(camp), at = TENT_KEYS.indexOf(style);
      const of = TENT_KEYS.length - 1;
      return { n: at < 0 ? of : at, of, what: TENT_WORDS[style] || '' };
    }
    case 'clothing': {
      /* Out of what can be sewn. The cloak is mastery, and mastery is a rung no
         band is ever told it has reached (nextRung, skills.js), so it is not
         held out here as one more thing to make. */
      const n = Math.min(CLOTH.dyed, camp.told?.clothing || 0);
      return { n, of: CLOTH.dyed, what: CLOTH_WORDS[n] };
    }
    case 'stonework':
      return { n: camp.barrow ? Math.round(PYRAMID_COURSES * v) : 0, of: PYRAMID_COURSES, what: 'courses' };
    case 'art': {
      const plan = monumentPlan(camp);
      return { n: Math.round(plan.length * v), of: plan.length || MONUMENT_MAX, what: 'stones raised' };
    }
    case 'fishing':
      return camp.shore ? { n: camp.raft ? 1 : 0, of: 1, what: 'raft' } : { n: 0, of: 0, what: 'no shore' };
    case 'woodcraft': {
      const forRaft = Boolean(camp.shore && !camp.raft), of = forRaft ? WOOD.raft : WOOD.keep;
      return { n: Math.min(of, Math.floor(camp.wood || 0)), of, what: forRaft ? 'logs for a raft' : 'logs stacked' };
    }
    case 'irrigation': {
      const d = camp.ditch;
      if (!d?.length) return { n: 0, of: 0, what: 'no field yet' };
      const of = Math.ceil(d.length), dug = camp.ditchDug || 0;
      return { n: dug >= d.length ? of : Math.floor(dug), of, what: 'm of ditch' };
    }
    case 'farming':
      return { n: Math.min(FARM.stockMax, Math.round(camp.stock || 0)), of: FARM.stockMax, what: 'animals penned' };
    case 'mining':
      return { n: Math.floor(camp.stone || 0), of: SKILL.stoneMax, what: 'stone' };
    case 'conquest': {
      const held = camps.filter((c) => !c.gone && c.code === camp.code);
      return { n: held.filter((c) => c.villageName).length, of: held.length, what: 'villages taken' };
    }
  }
  return { n: 0, of: 0, what: '' };
}

/* How much one go at it teaches, and what a go is called - read off where each
   skill's `practise` is called, the commonest way for each. A function rather
   than a table, because FARM, WOOD and CONQUEST belong to modules that import
   skills.js, and a table built while the imports are still settling would read
   them before they exist. */
function perGo(k): [number, string, string] {
  switch (k) {
    case 'rites': return [SKILL.perVisit, 'visit', 'visits'];
    case 'art': return [SKILL.perStone, 'visit', 'visits'];
    case 'stonework': return [SKILL.perCourse, 'session', 'sessions'];
    case 'trade': return [SKILL.perDeal, 'deal', 'deals'];
    case 'mining': return [SKILL.perQuarry, 'trip', 'trips'];
    case 'fishing': return [SKILL.perCatch, 'catch', 'catches'];
    case 'woodcraft': return [WOOD.practise, 'trip', 'trips'];
    case 'irrigation': return [FARM.perDitch, 'session', 'sessions'];
    case 'farming': return [FARM.perField, 'session', 'sessions'];
    case 'war': return [SKILL.perRaid, 'raid', 'raids'];
    case 'conquest': return [CONQUEST.perWin, 'won raid', 'won raids'];
  }
  return [SKILL.perCraft, 'session', 'sessions'];
}

/** The needs column on a band card: what has to happen before it climbs a
    rung. While a skill has not started at all, the standing condition is the
    answer - that is the thing in the way. After that it is the next rung. */
export function skillNeeds(camp, k) {
  const v = camp?.skill?.[k] || 0;
  if (v <= 0 && SKILL_NEEDS[k]) return SKILL_NEEDS[k];
  const next = nextRung(v);
  return next ? next.rung : '—';
}

/** And how to get there: where the work is done, and about how many goes at
    it are left before the next rung - counted in the band's own afternoons
    rather than in hundredths. About, because nothing learned stays learned
    while nobody is practising it. */
export function skillHow(camp, k) {
  const v = camp?.skill?.[k] || 0;
  const how = SKILL_HOW[k] || '';
  const next = nextRung(v);
  if (!next) return how;
  const [each, one, many] = perGo(k);
  const left = Math.max(1, Math.ceil((next.at / 100 - v) / each - 1e-9));
  const togo = `about ${left} ${left === 1 ? one : many} to go`;
  return how ? how + ' · ' + togo : togo;
}
