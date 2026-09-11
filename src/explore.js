import { SEA, SNOW, WORLD } from './params.js';
import { flatnessAt, sampleHeight, clearOfCreeks } from './noise.js';
import { CAMP_CLEARING, camps } from './people.js';
import { deposits } from './quarries.js';
import { forageRichness, nearestShore } from './larder.js';
import { SPLIT, logEvent, personAge, simDay, who } from './life.js';

/* -------------------------------------------------------------------------
   Explorers

   Everybody in a band works the ground within a walk of its fire, and a band
   that splits used to send its new camp to whichever flat spot a dice roll
   turned up — somewhere on a ring round the middle of the island, good ground
   or bad. Nobody had ever been to look.

   Now some of them do. The boldest — about one in five, the ones the card
   already calls bold — go out further than anybody forages, into the emptiest
   country they can see, and do not turn back at dusk. Where they end up they
   look the place over: is there food on the ground round it, water in reach,
   stone, room from the nearest band, and flat enough to put a fire on? What
   is worth remembering goes on the band's short list of finds, and a band
   that splits sends its new camp to the best of them — so bands spread over
   the island onto the good ground, rather than piling up where they began.
   ------------------------------------------------------------------------- */
export const EXPLORE = {
  bold: 1.15,          // how bold somebody has to be to go at all: about one in five
  chance: 0.10,        // weight against the other errands, for the least bold of them
  near: 0.16,          // how far out they go, as a share of the island's width ...
  far: 0.45,           // ... and at the most
  keep: 6,             // finds a band remembers
  notable: 0.55,       // a find worth a line in the chronicle, once it is the band's best
  flat: 0.9,           // ground a camp could stand on
};

/* A city's streets reach this far from its hall, from this rung up — CITY.reach
   and CITY.at in settlement.js, written out here so this module need not load
   that one (test.js keeps the two the same). */
const CITY_REACH = 150, CITY_AT = 4;

/** Whether a new band could pitch here: clear of every settlement's trampled
    ground — a camp's clearing, a village's outskirts, a city's streets — by
    SPLIT.gap. Beside a village or a city is fine; in one is not. */
export function clearOfCamps(x, z) {
  for (const c of camps) {
    let reach = Math.max(CAMP_CLEARING, c.reach || 0);
    if ((c.stage || 0) >= CITY_AT) reach = Math.max(reach, CITY_REACH);
    if (Math.hypot(c.x - x, c.z - z) < reach + SPLIT.gap) return false;
  }
  return true;
}

/** How much this person wants to go: nothing unless they are bold, and more
    the bolder; less when hungry or tired, like any long walk. */
export function exploreWeight(p, hunger, rested) {
  if (p.child || p.sick || personAge(p) < 16) return 0;
  const bold = p.traits?.bold ?? 1;
  if (bold < EXPLORE.bold) return 0;
  return EXPLORE.chance * (1 + (bold - EXPLORE.bold) * 4) * rested * (1 - 0.8 * hunger);
}

/* The emptiest of a handful of far places: as far from any fire as can be
   found, and not somewhere this band has already been to look. From the step,
   so it draws from the stream. */
export function pickFar(p, camp, luck) {
  let best = null, top = -Infinity;
  for (let t = 0; t < 10; t++) {
    const a = luck() * Math.PI * 2;
    const r = WORLD * (EXPLORE.near + luck() * (EXPLORE.far - EXPLORE.near));
    const x = camp.x + Math.cos(a) * r, z = camp.z + Math.sin(a) * r;
    if (Math.hypot(x, z) > WORLD * 0.44) continue;
    const h = sampleHeight(x, z);
    if (h < SEA + 2 || h > SNOW) continue;
    let empty = Infinity;
    for (const c of camps) if (!c.gone) empty = Math.min(empty, Math.hypot(c.x - x, c.z - z));
    const seen = (camp.finds || []).some((f) => Math.hypot(f.x - x, f.z - z) < 90) ? 0.4 : 1;
    const value = empty * seen * (0.7 + luck() * 0.6);
    if (value > top) { top = value; best = { x, z }; }
  }
  if (!best) return false;
  p.targetX = best.x;
  p.targetZ = best.z;
  return true;
}

/** What a place is worth to a band that might live there, or 0 if nobody
    could: the food on the ground round it, water and stone in reach, room
    from the nearest band, and how flat it lies. */
export function siteWorth(x, z) {
  const h = sampleHeight(x, z);
  if (h < SEA + 4 || h > SNOW - 25) return 0;
  const flat = flatnessAt(x, z);
  if (flat < EXPLORE.flat) return 0;
  if (!clearOfCamps(x, z)) return 0;
  if (!clearOfCreeks(x, z, 22)) return 0;       // a camp is not pitched on a creek
  let empty = Infinity;
  for (const c of camps) empty = Math.min(empty, Math.hypot(c.x - x, c.z - z));
  let ground = 0;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    ground += forageRichness(x + Math.cos(a) * 45, z + Math.sin(a) * 45);
  }
  ground /= 8;
  const water = nearestShore(x, z, 180) ? 0.2 : 0;
  const stone = deposits.some((d) => d.left > 0 && Math.hypot(d.x - x, d.z - z) < 220) ? 0.15 : 0;
  const room = Math.min(1, empty / 900) * 0.25;
  return ground + water + stone + room + (flat - EXPLORE.flat) * 2;
}

/** Arrived: the place looked over, and remembered if it is worth it. */
export function surveyDone(p) {
  const camp = p.camp;
  const worth = siteWorth(p.x, p.z);
  if (!(worth > 0)) return;
  camp.finds ||= [];
  const best = camp.finds[0]?.worth ?? 0;
  const again = camp.finds.find((f) => Math.hypot(f.x - p.x, f.z - p.z) < 60);
  if (again) again.worth = worth;
  else camp.finds.push({ x: Math.round(p.x), z: Math.round(p.z), worth });
  camp.finds.sort((a, b) => b.worth - a.worth);
  if (camp.finds.length > EXPLORE.keep) camp.finds.length = EXPLORE.keep;
  if (worth > best && worth > EXPLORE.notable) {
    const far = Math.round(Math.hypot(p.x - camp.x, p.z - camp.z));
    logEvent('find', `${who(p)} found good ground ${far} m from the fire`, p.x, p.z);
  }
  p.explored = simDay;
}

/** Where a band that is splitting sends its new camp: the best of its finds
    that nobody has settled since, or null to fall back on the old way. */
export function foundSite(parent) {
  const finds = parent.finds || [];
  for (let i = 0; i < finds.length; i++) {
    const f = finds[i];
    if (!clearOfCamps(f.x, f.z)) continue;
    const h = sampleHeight(f.x, f.z);
    if (h < SEA + 4 || h > SNOW - 25) continue;
    finds.splice(i, 1);
    return { x: f.x, z: f.z };
  }
  return null;
}
