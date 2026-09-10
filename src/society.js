import { P } from './params.js';
import { camps, dressCamp } from './people.js';
import { logEvent, simDay } from './life.js';
import { SKILLS } from './skills.js';

/* -------------------------------------------------------------------------
   From band to city

   A settlement is not what it is by decree. It is a band while it forages and
   moves nothing; it becomes a tribe when it has settled at its fields; a
   chiefdom when one of them leads with warriors behind him, or rules more than
   one village, and the band has raised something over its dead; a village
   when it is a permanent place of fields and flocks and proper houses; and a
   city when it is big, trades, builds in stone, and has other villages under
   it.

   The steps are careful on purpose, because the change is the interesting part
   and a switch is not a change:

     - one rung at a time, never two;
     - the next rung's marks have to hold for SOCIETY.hold sim-years before it
       is reached, so a good season is not a revolution;
     - a settlement that stops meeting its own rung for SOCIETY.slip years
       falls back one, which is how chiefdoms end;
     - and the way people spend their days shifts across SOCIETY.blend years
       after each step — foraging and hunting giving way to the fields, the
       workshops, the neighbours, the war band and the stones — rather than
       overnight. Hunger undoes all of it: a starving city forages like a band.

   Settlements also hold more people before they split as they climb, or the
   split rule — a band goes at two dozen — would stop any of them ever reaching
   the size a chiefdom or a city is.

   Nothing here is called while a module loads: life.js imports this back.
   ------------------------------------------------------------------------- */
export const SOCIETY = {
  hold: 1.5,          // sim-years the next rung's marks must hold before it is reached
  slip: 3,            // sim-years of failing its own rung before a settlement falls back
  blend: 1,           // sim-years over which the day's work shifts after a step
};

/* `split` multiplies SPLIT.at. `mix` leans each errand against the others; an
   errand not named stays as it was. */
export const STAGES = [
  { name: 'band', split: 1.0,
    mix: { gather: 1.0, hunt: 1.0, fish: 1.0, farm: 0.7, craft: 0.9, visit: 1.0, raid: 0.6, mourn: 1.0, quarry: 0.9 } },
  { name: 'tribe', split: 1.5,
    mix: { gather: 0.9, hunt: 0.9, fish: 1.0, farm: 1.2, craft: 1.0, visit: 1.0, raid: 0.8, mourn: 1.1, quarry: 1.0 } },
  { name: 'chiefdom', split: 2.1,
    mix: { gather: 0.75, hunt: 0.8, fish: 0.9, farm: 1.4, craft: 1.1, visit: 1.1, raid: 1.3, mourn: 1.3, quarry: 1.2 } },
  { name: 'village', split: 3.0,
    mix: { gather: 0.6, hunt: 0.6, fish: 0.8, farm: 1.7, craft: 1.3, visit: 1.3, raid: 1.1, mourn: 1.3, quarry: 1.3 } },
  { name: 'city', split: 6.0,
    mix: { gather: 0.45, hunt: 0.45, fish: 0.7, farm: 1.9, craft: 1.5, visit: 1.6, raid: 1.4, mourn: 1.4, quarry: 1.5 } },
];

/** Living villages flying this settlement's code: the tribe it belongs to. */
export function villagesOf(camp) {
  let n = 0;
  for (const c of camps) if (!c.gone && c.pop > 0 && c.code === camp.code) n++;
  return n;
}

/* What each rung asks. Read against what the settlement is now: its people,
   its skills, its flock, and how many villages its tribe holds. */
const MARKS = [
  () => true,
  (c, s) => c.pop >= 20 && (s.farming || 0) >= 0.25,
  (c, s, v) => c.pop >= 30 && ((s.war || 0) >= 0.25 || v >= 2) && (s.art || 0) >= 0.25,
  (c, s) => (s.farming || 0) >= 0.5 && (s.building || 0) >= 0.5 && (c.stock || 0) >= 4,
  (c, s, v) => c.pop >= 60 && (s.trade || 0) >= 0.5 && (s.stonework || 0) >= 0.5 && v >= 2,
];
export function meets(camp, stage) {
  return MARKS[stage](camp, camp.skill || {}, villagesOf(camp));
}

export const stageName = (camp) => STAGES[camp.stage || 0].name;
export const nextStage = (camp) => STAGES[(camp.stage || 0) + 1] || null;
/** How far a settlement is through holding the next rung's marks, 0 to 1. */
export function stageProgress(camp) {
  if (camp.risingSince == null || !nextStage(camp)) return 0;
  return Math.min(1, (simDay - camp.risingSince) / (SOCIETY.hold * P.yearLength));
}

/* How far a settlement has come, out of a hundred, for the panel: what it
   knows — every skill, averaged — and how far up from band to city it has
   climbed. Seven parts the first to three the second: the ladder is five slow
   rungs and the skills are twenty-one that move every season, and a band that
   has learned a great deal without settling has still come a long way. */
export const DEVELOPMENT = { skills: 0.7, stage: 0.3 };
export function developmentOf(camp) {
  const s = camp.skill || {};
  const keys = Object.keys(SKILLS);
  const known = keys.reduce((n, k) => n + Math.min(1, Math.max(0, s[k] || 0)), 0) / keys.length;
  const rung = (camp.stage || 0) / (STAGES.length - 1);
  return Math.round(100 * (DEVELOPMENT.skills * known + DEVELOPMENT.stage * rung));
}

const aOr = (word) => (/^[aeiou]/.test(word) ? 'an ' : 'a ') + word;

function setStage(c, to) {
  const from = c.stage || 0;
  c.stageFrom = from;
  c.stage = to;
  c.stageSince = simDay;
  c.risingSince = null;
  c.slippingSince = null;
  logEvent('stage', to > from
    ? `[${c.code}] ${c.name} has become ${aOr(STAGES[to].name)}`
    : `[${c.code}] ${c.name} is no longer ${aOr(STAGES[from].name)} — ${aOr(STAGES[to].name)} again`,
  c.x, c.z);
  // And it looks it at once: houses, a hall, a market and a wall (people.js).
  dressCamp(c);
}

/** On the books: a step up when the next rung has held, a step down when this one has failed. */
export function updateSociety() {
  const year = P.yearLength;
  for (const c of camps) {
    if (c.gone || !(c.pop > 0)) continue;
    const at = c.stage || 0;
    if (at < STAGES.length - 1 && meets(c, at + 1)) {
      if (c.risingSince == null) c.risingSince = simDay;
      if (simDay - c.risingSince >= SOCIETY.hold * year) { setStage(c, at + 1); continue; }
    } else c.risingSince = null;
    if (at > 0 && !meets(c, at)) {
      if (c.slippingSince == null) c.slippingSince = simDay;
      if (simDay - c.slippingSince >= SOCIETY.slip * year) setStage(c, at - 1);
    } else c.slippingSince = null;
  }
}

/* How much the stage a settlement has reached leans one errand, blended from
   the rung it came from across SOCIETY.blend years — and pulled back toward
   no lean at all by hunger, because a hungry city forages like a band. */
export function jobMix(camp, job, hunger) {
  const to = STAGES[camp.stage || 0].mix, from = STAGES[camp.stageFrom ?? camp.stage ?? 0].mix;
  const t = camp.stageSince == null ? 1 : Math.min(1, (simDay - camp.stageSince) / (SOCIETY.blend * P.yearLength));
  const a = from[job] ?? 1, b = to[job] ?? 1;
  const m = a + (b - a) * t;
  return m + (1 - m) * Math.min(1, Math.max(0, hunger));
}
