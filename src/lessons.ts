import { P } from './params.js';
import { FOOD, logEvent, simDay } from './life.js';
import { practise } from './skills.js';

/* -------------------------------------------------------------------------
   What a band remembers

   A band used to die the same death twice. The famine that took half of it
   came round again the next winter to a band that had stored no more than
   before; the tiger took the next forager from the same thicket; the raiders
   who never came home were followed out by the next party. Nothing a death
   taught was kept, so every band was always the first band.

   Now a death is a lesson, and the band keeps it:

   - hunger: they keep more food by them — forage, hunt, fish and farm harder
     while the store is short of what they now think enough — and learn to dry
     what they have so it keeps. They still breed at the full rate (life.js,
     "breeding flat out"); what changes is that the store is there when the
     lean months come, so the crash comes later, or not at all.
   - exhaustion: they rest more, and it is a hunger lesson too.
   - sickness: they sit with their sick, and learn herbs.
   - a child dying: they watch the little ones closer — fewer die young.
   - a tiger: the place is remembered and foragers keep off it, and they keep
     the fire high (the fire is what a tiger will not come near).
   - a raid: the band that lost raiders raids less; the band that lost a
     defender learns to fight.

   And a lesson fades — halving every LESSON.half years, the way a story does
   when the people who were there are gone — more slowly in a band that keeps
   its dead, since the rites are where the stories are told. A lesson taught
   twice is held twice as hard. A daughter band takes its mother's memories
   with it (splitCamp), and they are saved with the band.
   ------------------------------------------------------------------------- */
export const LESSON = {
  half: 12,            // years for a lesson to fade by half, in a band with no rites
  rites: 2,            // how much longer a band remembers, at mastery of rites
  places: 10,          // bad places a band keeps in mind
  near: 45,            // metres within which two bad places are one
  dread: 70,           // metres out from a bad place that foragers keep off
  stock: 25,           // days of food a band keeps ahead, per famine it still holds (to two)
  store: 0.8,          // how much harder a band that remembers a famine works for food, its store short
  care: 0.5,           // share of deaths in infancy a band that has buried children learns to prevent
  wary: 0.6,           // how much less a band that lost raiders goes raiding, per lesson
  nursing: 0.8,        // more nursing in a band that lost people to sickness
  resting: 0.5,        // more time at home in a band that lost somebody to exhaustion
  skill: 0.02,         // what one death teaches of the skill that would have prevented it
};

/* What each lesson is called when the band's card lists it, and what the
   chronicle says the day it takes hold. */
const LESSON_WORDS = {
  famine: ['the hunger', 'they keep more food by them now'],
  overwork: ['the one worked to death', 'they rest more now'],
  sickness: ['the sickness', 'they sit with their sick now'],
  infants: ['the children they buried', 'they watch the little ones closer now'],
  raiding: ['the raiders who never came home', 'they raid less now'],
};

/** A band's memories, made on first asking. */
export function lessonsOf(camp) {
  if (!camp.lessons) camp.lessons = { places: [] };
  if (!camp.lessons.places) camp.lessons.places = [];
  return camp.lessons;
}

/** How hard a band still holds something it learned: halving every
    LESSON.half years, more slowly the better it keeps its rites. */
export function heldNow(camp, l) {
  if (!l || !(l.w > 0)) return 0;
  const half = LESSON.half * (1 + LESSON.rites * (camp.skill?.rites || 0)) * P.yearLength;
  return l.w * Math.pow(0.5, Math.max(0, simDay - (l.day || 0)) / half);
}

/** How hard a band holds one lesson now. */
export function lessonOf(camp, key) {
  return heldNow(camp, camp.lessons?.[key]);
}

/* Taught once more: held as hard as it still was, and one more time. The
   chronicle hears of it the day it takes hold, and again only if it has been
   all but forgotten in between. */
function takeLesson(camp, key, amount) {
  const L = lessonsOf(camp), was = heldNow(camp, L[key]);
  const told = was >= 0.3 && L[key]?.told;
  L[key] = { w: was + amount, day: simDay, told: told || was + amount >= 1 };
  if (!told && was + amount >= 1) {
    logEvent('learned', `[${camp.code}] ${camp.name} remembers ${LESSON_WORDS[key][0]}: ${LESSON_WORDS[key][1]}`, camp.x, camp.z);
  }
}

/* Where somebody was killed, kept: foragers go round it (dreadOf). The same
   place again is the same memory, held harder. */
function markBadPlace(camp, p) {
  const L = lessonsOf(camp);
  const near = L.places.find((b) => Math.hypot(b.x - p.x, b.z - p.z) < LESSON.near);
  if (near) {
    near.w = heldNow(camp, near) + 1;
    near.day = simDay;
    return;
  }
  L.places.push({ x: p.x, z: p.z, w: 1, day: simDay });
  L.places.sort((a, b) => heldNow(camp, b) - heldNow(camp, a));
  if (L.places.length > LESSON.places) L.places.length = LESSON.places;
  logEvent('learned', `[${camp.code}] ${camp.name} will remember where the tiger took ${p.name || 'one of them'}, and keep away from there`, p.x, p.z);
}

/** A death, and what the band takes from it. Called for every one (killPerson). */
export function learnFrom(p, cause) {
  const camp = p.camp;
  if (!camp) return;
  if (cause === 'hunger') {
    takeLesson(camp, 'famine', 1);
    practise(camp, 'drying', LESSON.skill);
  } else if (cause === 'exhaustion') {
    takeLesson(camp, 'overwork', 1);
    takeLesson(camp, 'famine', 0.5);
  } else if (cause === 'sickness') {
    takeLesson(camp, 'sickness', 1);
    practise(camp, 'herbs', LESSON.skill);
  } else if (cause === 'infancy') {
    takeLesson(camp, 'infants', 1);
  } else if (cause === 'tiger') {
    markBadPlace(camp, p);
    practise(camp, 'fire', LESSON.skill);
  } else if (cause === 'raid') {
    if (p.job === 'raid') takeLesson(camp, 'raiding', 1);
    else practise(camp, 'war', LESSON.skill);
  }
}

/** How much a band's memories move one kind of day's work (move.js, beside
    jobMix). A band that remembers a famine works for food while its store is
    short of what it now thinks enough; one that lost raiders raids less; one
    that lost people to sickness or to work nurses and rests more. */
export function lessonMix(camp, job) {
  if (!camp?.lessons) return 1;
  if (job === 'gather' || job === 'hunt' || job === 'fish' || job === 'farm') {
    const stockAhead = LESSON.stock * Math.min(2, lessonOf(camp, 'famine'));
    if (!(stockAhead > 0)) return 1;
    const days = camp.need > 0 ? camp.food / camp.need : Infinity;
    const short = Math.max(0, Math.min(1, 1 - days / (FOOD.comfortable + stockAhead)));
    return 1 + LESSON.store * short;
  }
  if (job === 'raid') return 1 / (1 + LESSON.wary * lessonOf(camp, 'raiding'));
  if (job === 'nurse') return 1 + LESSON.nursing * Math.min(1, lessonOf(camp, 'sickness'));
  if (job === 'tend') return 1 + LESSON.resting * Math.min(1, lessonOf(camp, 'overwork'));
  return 1;
}

/** How much of a forager's reckoning of a place survives the band's memory of
    it: nothing lost far from any bad place, most of it at the spot. */
export function dreadOf(camp, x, z) {
  const places = camp?.lessons?.places;
  if (!places?.length) return 1;
  let keep = 1;
  for (const b of places) {
    const d = Math.hypot(x - b.x, z - b.z);
    if (d < LESSON.dread) keep *= 1 - Math.min(0.9, heldNow(camp, b)) * (1 - d / LESSON.dread);
  }
  return Math.max(0.05, keep);
}

/** Of the deaths in infancy there would have been, the share there still are
    in a band that has buried children and remembers it (life.js, hazards). */
export function infantCare(camp) {
  return camp?.lessons ? 1 - LESSON.care * Math.min(1, lessonOf(camp, 'infants')) : 1;
}

/** A daughter band's memories: its mother's, as hard as she holds them now. */
export function inheritLessons(parent) {
  const L = parent?.lessons;
  if (!L) return undefined;
  const out = { places: (L.places || []).map((b) => ({ x: b.x, z: b.z, w: heldNow(parent, b), day: simDay })) };
  for (const k of Object.keys(LESSON_WORDS)) {
    if (L[k]) out[k] = { w: heldNow(parent, L[k]), day: simDay, told: L[k].told };
  }
  return out;
}

/** A row for the band's card: what they remember, strongest first. */
export function memoryRows(camp) {
  /* A pair, said to be a pair: a bare [k, lessonOf(...)] is an array of "string
     or number" to a compiler, and then neither the comparison nor the sort
     means anything. */
  const held = Object.keys(LESSON_WORDS).map((k) => [k, lessonOf(camp, k)] as [string, number])
    .filter(([, w]) => w >= 0.25)
    .sort((a, b) => b[1] - a[1]).map(([k, w]) => LESSON_WORDS[k][0] + (w < 1 ? ' <em>(fading)</em>' : ''));
  const places = (camp.lessons?.places || []).filter((b) => heldNow(camp, b) >= 0.25).length;
  if (places) held.push(`${places} ${places === 1 ? 'place' : 'places'} where the tiger struck`);
  return held.length ? `<div><span>remembers</span> ${held.join(', ')}</div>` : '';
}

/* ---- keeping them across a reload (save.js) ---- */

const keep2 = (v) => Math.round(v * 100) / 100;

/** A band's memories, small enough to save. */
export function packLessons(L) {
  if (!L) return undefined;
  // Keyed by lesson, plus `pl` for the places: written by name, so it is said to be.
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(LESSON_WORDS)) if (L[k]?.w > 0) out[k] = [keep2(L[k].w), keep2(L[k].day || 0), L[k].told ? 1 : 0];
  if (L.places?.length) out.pl = L.places.map((b) => [Math.round(b.x), Math.round(b.z), keep2(b.w), keep2(b.day || 0)]);
  return Object.keys(out).length ? out : undefined;
}

/** And back: an older save, or a band that had learned nothing, remembers nothing. */
export function unpackLessons(s) {
  const L = { places: [] };
  if (!s || typeof s !== 'object') return L;
  for (const k of Object.keys(LESSON_WORDS)) {
    const v = s[k];
    if (Array.isArray(v) && Number(v[0]) > 0) L[k] = { w: Number(v[0]), day: Number(v[1]) || 0, told: v[2] === 1 };
  }
  if (Array.isArray(s.pl)) {
    for (const b of s.pl) {
      if (Array.isArray(b) && b.length >= 4 && b.every((v) => Number.isFinite(Number(v)))) {
        L.places.push({ x: Number(b[0]), z: Number(b[1]), w: Number(b[2]), day: Number(b[3]) });
      }
    }
  }
  return L;
}
