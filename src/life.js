import * as THREE from 'three';

import {
  MAP_SCALE, P, PEOPLE_CEILING, SEA, SNOW
} from './params.js';
import { clamp, fbm, flatnessAt, lerp, mulberry32, sampleHeight } from './noise.js';
import { forageSeason, seasonName, seasonUniforms } from './scene.js';
import { HIDDEN, _c, orchard, stats } from './world.js';
import {
  NAME_ONSET, lineage, packs, recordDeath, recordMove, recordPerson, recountAnimals, takePersonId, tribeVoice, uniqueName
} from './wildlife.js';
import { luck, partsPer } from './clock.js';
import {
  BUILDS, GARMENT, HAIR, SKIN, buryPerson, campCapacity, camps, dressCamp, layoutCamp, paintPeople, people, personParts
} from './people.js';
import { followIdx, renderTribeCard, setFollowIdx } from './chronicle.js';
import { $, r2, ui } from './save.js';
import { codeChip, codeColor, hhmm, nameForSeed, tribeChips, worldCode, worlds } from './ui.js';
import { updateHud } from './main.js';

/* -------------------------------------------------------------------------
   Food, and hunts that actually catch something

   Until now the band's day was a dice roll: pick a job, do it, pick another.
   Nothing they did changed anything, and the hunters — the only thread
   connecting the people to the animals — came home empty every time.

   Now the camp has a store. Foragers fill it, hunters fill it in rare large
   amounts, everyone empties it, and how full it is decides what people do
   next. A lean camp sends everyone out; a full one lets them sit and knap.
   That one feedback loop is the difference between an animation and a life.
   ------------------------------------------------------------------------- */

/* The chronicle is a record of every world, not of the one you happen to be
   standing in: load another world and the list carries on, with each line
   marked by the world it happened in. It outlives the tab in SQLite when there
   is a server and in the browser when there is not, and it is only ever emptied
   one world at a time, by deleting that world.

   Each entry carries its own seed rather than a code or a colour, because both
   of those are derived from the seed and deriving them again is cheaper than
   storing them and risking the two disagreeing. */
export const CHRONICLE_MAX = 200;
export const CHRONICLE_STORE = 'openworld.chronicle';
export let chronicle = [];
export let pendingEvents = [];
export let runId = null;

export function logEvent(kind, text, x = 0, z = 0) {
  const entry = {
    seed: P.seed, world: worldNameNow(),
    day: Math.floor(simDay), hour: hhmm(P.time), kind, text,
    x: Math.round(x), z: Math.round(z),
  };
  chronicle.unshift(entry);
  if (chronicle.length > CHRONICLE_MAX) chronicle.pop();
  pendingEvents.push(entry);
  saveChronicle();
  renderChronicle();
}

/** The name of the world being played, whether or not the shelf has loaded. */
export function worldNameNow() {
  const here = worlds.find((w) => w.seed === P.seed);
  return here ? here.name : nameForSeed(P.seed);
}

export function saveChronicle() {
  try {
    localStorage.setItem(CHRONICLE_STORE, JSON.stringify(chronicle.slice(0, CHRONICLE_MAX)));
  } catch { /* private window, or storage off */ }
}

/* The server's copy wins when there is one: it has every world this machine has
   ever built, including the ones built before this browser profile existed. */
export async function loadChronicle() {
  if (runId) {
    try {
      const res = await fetch(`/api/chronicle?limit=${CHRONICLE_MAX}`);
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length) {
          chronicle = rows;
          renderChronicle();
          return;
        }
      }
    } catch { /* fall through to the browser's copy */ }
  }
  try {
    const raw = localStorage.getItem(CHRONICLE_STORE);
    const rows = raw ? JSON.parse(raw) : null;
    if (Array.isArray(rows)) chronicle = rows;
  } catch { /* nothing stored */ }
  renderChronicle();
}

/* One colour per tribe, used by the readout, the chart and the map so the same
   band is the same colour wherever you meet it. */
export const TRIBE_COLORS = ['#e8a33d', '#6fb2e8', '#c77ee0', '#7fd08a', '#e8746a'];
export const HISTORY_DAYS = 120;
export let nextTribeDraw = 0;

export function renderTribes(now = 0) {
  const el = $('tribes');
  if (!el || ui.classList.contains('collapsed')) return;
  if (now && now < nextTribeDraw) return;
  nextTribeDraw = now + 0.5;

  el.innerHTML = camps.map((c, i) => {
    let pop = 0, kids = 0, women = 0, men = 0, ill = 0;
    for (const p of people) {
      if (p.camp !== c) continue;
      pop++;
      if (p.child) kids++;
      if (p.sex === 'f') women++; else men++;
      if (p.sick) ill++;
    }
    /* Days-of-food is the store divided by what the camp eats in a day, and a
       camp with nobody in it eats nothing — which came out as twenty-six
       thousand days. An empty camp has no such number. */
    const detail = pop === 0
      ? 'empty'
      : `${women}♀ ${men}♂ · ${kids} child · ${daysOfFood(c).toFixed(1)}d food`
        + (ill ? ` · <em class="ill">${ill} ill</em>` : '');
    /* What has become of them, worst first. On the line rather than behind a
       hover, because the whole question is why a band is doing badly and the
       answer is usually right here. */
    const toll = tollOf(c);
    const lost = toll.reduce((n, [, k]) => n + k, 0);
    const why = lost
      ? `<span class="toll" title="${toll.map(([k, n]) => `${n} ${TOLL_WORDS[k]}`).join(', ')}">`
        + `${lost} lost: ${toll.slice(0, 2).map(([k, n]) => `${n} ${TOLL_WORDS[k]}`).join(', ')}`
        + `</span>`
      : '';
    /* What it has worked out, as three bars. This is the line that makes a
       century of simulation legible: two bands on one map, one of them with
       drying racks and one without, and you can see which is which. */
    const learned = Object.keys(SKILLS)
      .map((k) => `<i class="sk" title="${SKILLS[k].label}" style="--v:${Math.round(c.skill[k] * 100)}%"></i>`)
      .join('');
    return `<div data-camp="${i}"><i style="background:${TRIBE_COLORS[i % TRIBE_COLORS.length]}"></i>`
      + `<b class="wcode" style="background:${c.color}">${c.code}</b>`
      + `<b>${c.name}</b> ${pop}<span>${detail}</span>`
      + `<span class="skills" title="knapping · weaving · curing">${learned}</span>`
      + why + `</div>`;
  }).join('') || '<div><span>no camps</span></div>';

  drawTribeChart();
  renderTribeCard();
}

/* Population over the last hundred and twenty days, one line per tribe. The
   point of the whole simulation is that this line has a shape nobody drew. */
export function drawTribeChart(cv = $('tribeChart')) {
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (!camps.length) return;

  let maxPop = 4, minDay = Infinity, maxDay = 0;
  for (const c of camps) {
    for (const h of c.history) {
      maxPop = Math.max(maxPop, h.pop);
      minDay = Math.min(minDay, h.day);
      maxDay = Math.max(maxDay, h.day);
    }
  }
  if (!Number.isFinite(minDay) || maxDay === minDay) return;

  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  camps.forEach((c, i) => {
    if (c.history.length < 2) return;
    ctx.strokeStyle = TRIBE_COLORS[i % TRIBE_COLORS.length];
    ctx.beginPath();
    c.history.forEach((h, k) => {
      const x = ((h.day - minDay) / (maxDay - minDay)) * (W - 8) + 4;
      const y = H - 6 - (h.pop / maxPop) * (H - 14);
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
  });

  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.font = '18px system-ui, sans-serif';
  ctx.fillText(String(maxPop), 6, 20);
  ctx.fillText(`day ${Math.round(minDay)}–${Math.round(maxDay)}`, 6, H - 8);
}

export function renderChronicle() {
  const el = $('chronicle');
  if (!el || ui.classList.contains('collapsed')) return;
  el.innerHTML = chronicle.slice(0, 12)
    .map((e) => `<div>${codeChip(e.seed)}<span>d${e.day} ${e.hour}</span> ${tribeChips(e.text)}</div>`).join('')
    || '<div><span>—</span> nothing has happened yet</div>';
}

export async function startRun() {
  if (typeof window === 'undefined' || !window.__CONFIG__) return;   // standalone
  try {
    const res = await fetch('/api/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed: P.seed, quality: P.quality, counts: P.counts }),
    });
    runId = (await res.json()).runId;
  } catch { runId = null; }
}

export async function flushEvents() {
  if (!runId || !pendingEvents.length) return;
  const batch = pendingEvents;
  pendingEvents = [];
  try {
    await fetch('/api/events', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, events: batch }),
    });
  } catch {
    // Put them back rather than losing them to a hiccup.
    pendingEvents = batch.concat(pendingEvents);
  }
}

/* A row a day: enough to plot how the band did over a season without storing
   every footstep. */
/* The per-tribe rows, so a run can be read back tribe by tribe rather than as
   one lump. */
export async function postTribes() {
  if (!runId || !camps.length) return;
  const rows = camps.map((c) => {
    let people_ = 0, kids = 0;
    for (const p of people) if (p.camp === c) { people_++; if (p.child) kids++; }
    return { name: c.name, people: people_, children: kids, food: Math.round(c.food) };
  });
  try {
    await fetch('/api/tribes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, day: Math.floor(simDay), tribes: rows }),
    });
  } catch { /* a day's rows are not worth a retry queue */ }
}

export async function postSample() {
  if (!runId) return;
  const total = camps.reduce((a, c) => a + c.food, 0);
  try {
    await fetch('/api/sample', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId, day: Math.floor(simDay), people: people.length,
        food: Math.round(total),
        animals: packs.reduce((a, p) => a + p.list.filter((x) => !x.dead).length, 0),
        kills: people.reduce((a, p) => a + p.kills, 0),
      }),
    });
  } catch { /* the day's row is not worth a retry queue */ }
}

export function onNewDay() {
  // Each tribe's own line, kept to a rolling window so a long run does not grow
  // an unbounded array behind the chart.
  for (const c of camps) {
    let pop = 0, kids = 0;
    for (const p of people) if (p.camp === c) { pop++; if (p.child) kids++; }
    c.history.push({ day: Math.floor(simDay), pop, kids, food: Math.round(c.food) });
    if (c.history.length > HISTORY_DAYS) c.history.shift();
  }
  postTribes();

  const food = camps.reduce((a, c) => a + c.food, 0);
  const days = camps.length ? (food / camps.reduce((a, c) => a + campDailyNeed(c), 0)) : 0;
  logEvent('day', `day ${Math.floor(simDay)} · ${people.length} people · `
    + `${days.toFixed(1)} days of food`, 0, 0);
  postSample();
  flushEvents();
}

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
};

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
export const SKILL_RISE = 0.02;
export const SKILL_FALL = 0.06;
export const FORGET_WORDS = { knapping: 'knap', weaving: 'weave', curing: 'cure meat' };

export function announceSkill(camp, key) {
  const v = camp.skill[key];
  const told = camp.told[key] || 0;
  let tier = told;
  while (tier < SKILL_STEPS.length && v >= SKILL_STEPS[tier] + SKILL_RISE) tier++;
  while (tier > 0 && v < SKILL_STEPS[tier - 1] - SKILL_FALL) tier--;
  if (tier === told) return;
  camp.told[key] = tier;
  // The rack goes up, or comes down, the moment drying crosses the line.
  if (key === 'drying') dressCamp(camp);
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
  for (const camp of camps) {
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
  const weights = [
    ['spears', 0.25 + 0.5 * h],
    ['baskets', 0.25 + 0.5 * h],
    ['drying', 0.20 + 0.7 * (1 - h)],
  ];
  let roll = luck() * weights.reduce((a, w) => a + w[1], 0);
  return weights.find(([, w]) => (roll -= w) <= 0)?.[0] || 'spears';
}

/* -------------------------------------------------------------------------
   The bands, meeting

   Two camps sat two hundred and sixty metres apart for fifty years and never
   once noticed each other. Somebody walks over now, and three things can come
   of it — all of them ordinary, all of them consequential:

     - what they know goes with them, so a rack built by one band eventually
       reaches the other, and a map with two bands on it stops being two
       separate runs of the same simulation;
     - food moves from a camp that has it to one that does not, which is the
       only thing standing between a bad season and a funeral;
     - the young sometimes stay, which spreads the bloodlines and quietly fixes
       a camp that has run out of women or men to have children with.

   Nobody goes hungry or ill or exhausted. It is a day's walk each way.
   ------------------------------------------------------------------------- */

/* The hour the "everybody comes home" rule starts firing, in the same 0-24 the
   clock reads. That rule tests the sun's height rather than the clock, so this
   is the same moment expressed the other way round — derived from the sun model
   (daylight drops through 0.25 at 18.10) and rounded DOWN, because sending
   somebody home a few minutes early costs nothing and sending them out a few
   minutes late costs the whole errand. There is a test that recomputes it. */
export const DUSK_AT = 18;

export const VISIT = {
  chance: 0.10,        // weight against the other jobs, for somebody who can go
  needFood: 0.55,      // the visitor's own camp must be at least this comfortable
  begFrom: 0.70,       // ...or this hungry, in which case they are going to ask
  gift: 0.30,          // share of the surplus carried over
  learn: 0.90,         // how much of what the visitor knows the hosts pick up
  stay: 0.14,          // chance a young adult stays for good, once in a life
  stayUnder: 30,       // years: only the young move
};

/* -------------------------------------------------------------------------
   Marrying out, and why it is not here

   A band of eight is too small a sample for a coin. Sex is decided per birth,
   so a run of sons is the ordinary amount of noise, and a band that lands on
   one fertile woman and four men has no way back: it does not starve, it stops
   having children and holds its number for a decade while the old die. That is
   real, and it was measured — one world sat on forty-seven days of food at
   1♀ 3♂ and ended anyway.

   The obvious fix is the one hunter-gatherers use. Young adults marry out:
   weight the decision to stay by who is short of whom, and let somebody with
   nobody at home be the one who sets out. It was built, and it did work — the
   bands stopped drifting into dead ends.

   It is not here because it made things worse. Paired across seven seeds, same
   world either way: seven of seven worlds still peopled without it, five of
   seven with; eighty-nine people against ninety-one. More women having children
   meant the bands grew straight through the island's food ceiling and starved
   in a heap, and the two worlds it lost were lost that way. It traded a slow,
   rare failure for a fast, common one, on an island that was already surviving
   once the tigers stopped catching everything they chased.

   Worth trying again if the ceiling ever moves. Not worth it against this one.
   ------------------------------------------------------------------------- */

/** The nearest other camp, or nobody if this world has only one band. */
export function otherCamp(camp) {
  let best = null, bestD = Infinity;
  for (const c of camps) {
    if (c === camp) continue;
    const d = Math.hypot(c.x - camp.x, c.z - camp.z);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/* What happens when somebody actually arrives. Knowledge first, because it is
   the one that outlives everybody involved. */
export function arriveAtCamp(p, host) {
  const home = p.camp;
  let told = false;

  /* What they brought that nobody wanted. They left before it showed in anyone
     — a band that knows it has the sickness stays home — so the first the host
     knows of it is a guest who was already carrying it. This is the only way it
     crosses the island, and it is why an outbreak in one band is worth watching
     the others for. */
  if (campIsIll(home) && !immune(p) && !host.people?.some?.((q) => q.sick)
      && luck() < PLAGUE.carried) {
    const well = people.filter((q) => q.camp === host && !q.sick && !immune(q));
    if (well.length) {
      fallIll(well[(luck() * well.length) | 0]);
      logEvent('sickness',
        `the sickness came to [${host.code}] ${host.name} with ${who(p)}`, host.x, host.z);
    }
  }
  for (const key in SKILLS) {
    const carried = (p.knows?.[key] || 0) * VISIT.learn;
    if (carried > host.skill[key] + 0.02) {
      host.skill[key] = carried;
      announceSkill(host, key);
      told = true;
    }
  }

  /* Food goes the way it is needed. A camp with a comfortable store gives some
     of the surplus away; a camp with nothing gets what it can carry. */
  const surplus = home.food - home.need * FOOD.comfortable;
  if (surplus > 0 && host.hunger > 0.5) {
    const gift = surplus * VISIT.gift;
    home.food -= gift;
    host.food += gift;
    /* Once a season, not once a trip. A band with a full store and a hungry
       neighbour sends somebody over every other day, and a chronicle that says
       so every time is a chronicle nobody can read. */
    if (simDay - (host.lastGift || -99) > P.yearLength / 4) {
      host.lastGift = simDay;
      logEvent('trade', `[${home.code}] ${home.name} sent food to [${host.code}] ${host.name}`,
        host.x, host.z);
    }
  } else if (told) {
    logEvent('visit', `${who(p)} carried what they knew to [${host.code}] ${host.name}`,
      host.x, host.z);
  }

  /* And sometimes they stay. Only the young, and only if there is somebody of
     the other sex to stay for — which is what makes this fix a camp that has
     run out of one or the other rather than merely shuffle people about. */
  /* Once in a life. Without that the two bands churned: somebody moved on
     almost every visit, half a dozen a day between them, and after a season the
     two camps were the same people shuffled — which is the opposite of what
     contact between bands is here for. They are supposed to stay distinct
     enough to diverge, and to trade the odd person, not merge. */
  if (!p.moved && personAge(p) < VISIT.stayUnder && luck() < VISIT.stay) {
    const mate = pickParent(host, p.sex === 'f' ? 'm' : 'f');
    if (mate) {
      // Named before they move, or the line reads "[VW] Lore stayed with [VW]".
      const leaving = who(p);
      p.moved = true;
      recordMove(p, p.camp, host);
      p.camp = host;
      p.hut = host.huts[(luck() * host.huts.length) | 0];
      logEvent('joined', `${leaving} stayed with [${host.code}] ${host.name}`, host.x, host.z);
      paintPeople();
    }
  }
}

export const FOOD = {
  adult: 1.0,          // units eaten per simulated day
  child: 0.55,
  /* What one completed trip is worth. Raised with the rest of this: a band was
     living hand to mouth on a good day and losing people on a bad one, and an
     island whose ground never runs out should be able to feed the people
     standing on it. */
  gather: 0.44,        // units brought home by one completed foraging trip
  comfortable: 6,      // days of store above which nobody worries
  /* A thrown spear, not a footrace. Hunters jog at 3.6 m/s and deer flee at
     6.8, so a hunt that has to touch its quarry can only ever catch the
     slowest animal in the world — the first run of this ended with every kill
     a bison and the bison down from nine to two. Nine metres is a range a
     hunter can reach before an animal is at full flight. */
  killRange: 9,
  attemptEvery: 0.7,   // seconds between attempts once in range
  searchRadius: 300,
  startingDays: 4,
  /* Nothing keeps. This is the only thing stopping a good week turning into an
     unbounded pile — and it is why a band this side of agriculture cannot
     hoard its way out of a bad season. */
  spoil: 0.18,
  minStock: 0.40,      // a species below this share of its number is left alone
};

// Per species: what it is worth, and how hard it is to catch. A rabbit is easy
// and barely worth the walk; a bison feeds the camp for days and rarely lets
// you near it.
export const QUARRY = {
  bison: { meat: 45, chance: 0.07, regrow: 0.06 },
  // Slower than a deer and worth more than a rabbit, which is what makes taking
  // one a reasonable answer to it having eaten the orchard.
  boar: { meat: 14, chance: 0.11, regrow: 0.16 },
  deer: { meat: 20, chance: 0.10, regrow: 0.12 },
  rabbit: { meat: 2.5, chance: 0.06, regrow: 0.35 },
};

export let simDay = 0;
export let lastDawn = -1;

export function campDailyNeed(camp) {
  return Math.max(camp.need, 0.001);
}

/** Days of food left at the current rate — the number everyone acts on. */
export function daysOfFood(camp) {
  return camp.food / campDailyNeed(camp);
}

/* -------------------------------------------------------------------------
   Breaking away

   A camp is a fire and a ring of huts, and there is a size past which that
   stops working. When a band outgrows it, somebody takes a share of them and
   walks off far enough to be out of each other's way.

   Everything else follows from mechanisms that already existed: the leavers
   carry what they know, so the new band starts with its founder's skills
   rather than from nothing; they are a separate camp, so they forage and hunt
   their own ground; and the two of them can visit each other afterwards.
   ------------------------------------------------------------------------- */

export const SPLIT = {
  at: 17,              // people in one camp before it is too many
  takes: 0.42,         // share of them who go
  /* Three and a half days is not a surplus, it is next week's dinner. Splitting
     on it turned one band that was coping into two that were not — measured
     over eight years, the third band founded in a squeeze starved out and took
     the parent most of the way down with it. A band leaves because it has more
     than it needs, which is the only reason anybody ever has. */
  needFood: 11,        // days of store before anybody can be spared to walk
  minAway: 300,        // metres from every existing camp, before MAP_SCALE
  everyYears: 1.5,     // no camp splits twice in quick succession
  pairs: 3,            // fertile adults of each sex who go, at most
  keepPairs: 2,        // and who must be left behind, at least
};

/* Somewhere far enough from every fire already burning. Deliberately stricter
   than the original placement — a band that has just walked away from crowding
   should not pitch within sight of what it left. */
/* -------------------------------------------------------------------------
   Ground

   Three bands shared one island and nothing about that was true of any of
   them. They visited, they traded, they sent people to stay — and they foraged
   straight through each other, because a patch of ground had no owner and the
   only limit on a band was how far somebody would walk.

   Which is fine while the island is empty and wrong the moment it is not. Food
   is the constraint now: the store fell from twenty-two days to nine as the
   population doubled. What was missing was for that to be about *somewhere*.

   Two rules, and both of them are pressure rather than rules:

   A forager weighs ground that belongs to somebody else as worth less than it
   is — the walk home past their fire is not worth the basket — and a hungry
   one stops caring, which is exactly when it starts to matter.

   And a band squeezed for long enough moves. Not driven off and not a fight:
   the one with fewer adults picks up and goes somewhere with room, which is
   what a band without granaries or walls actually does.
   ------------------------------------------------------------------------- */

export const GROUND = {
  range: 105,          // metres a band treats as its own
  shy: 0.55,           // how much of a spot's worth is lost for being theirs
  squeeze: 0.62,       // hunger at which being crowded starts to count
  patience: 40,        // sim-days of that before a band gives up its site
  apart: 200,          // metres from every other camp, before MAP_SCALE
};

/** The band whose ground this is, if it is nearer their fire than ours. */
export function groundOf(x, z, notThis) {
  let owner = null, near = GROUND.range;
  for (const c of camps) {
    if (c === notThis || c.gone) continue;
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < near) { near = d; owner = c; }
  }
  return owner;
}

/* Nobody is driven anywhere. The band that moves is the one with fewer adults
   to feed itself with, and it moves because staying stopped working. */
export function updateGround(days) {
  if (camps.length < 2) return;
  for (const camp of camps) {
    if (camp.gone) continue;
    const rival = camps.find((c) => c !== camp && !c.gone
      && Math.hypot(c.x - camp.x, c.z - camp.z) < GROUND.range * 1.7);
    const squeezed = rival && camp.hunger > GROUND.squeeze;
    camp.pressed = Math.max(0, (camp.pressed || 0) + (squeezed ? days : -days * 2));
    if (!squeezed || camp.pressed < GROUND.patience) continue;

    // The smaller band is the one that goes.
    const adults = (c) => people.reduce((n, p) => n + (p.camp === c && !p.child ? 1 : 0), 0);
    if (adults(camp) > adults(rival)) continue;
    if (moveCampAway(camp)) camp.pressed = 0;
  }
}

/** Picks up the whole camp and puts it down somewhere with room. */
export function moveCampAway(camp) {
  const rng = camp.rng;
  let best = null, bestScore = -Infinity;
  for (let t = 0; t < 300; t++) {
    const a = rng() * Math.PI * 2;
    const r = (120 + Math.sqrt(rng()) * 340) * MAP_SCALE;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (sampleHeight(x, z) < SEA + 3) continue;
    if (flatnessAt(x, z) < 0.86) continue;
    let nearest = Infinity;
    for (const c of camps) {
      if (c === camp || c.gone) continue;
      nearest = Math.min(nearest, Math.hypot(x - c.x, z - c.z));
    }
    if (nearest < GROUND.apart * MAP_SCALE) continue;
    // Room first, then ground worth foraging.
    const score = nearest + forageRichness(x, z) * 120;
    if (score > bestScore) { bestScore = score; best = { x, z }; }
  }
  if (!best) return false;

  const from = { x: camp.x, z: camp.z };
  camp.x = best.x;
  camp.z = best.z;
  camp.y = sampleHeight(best.x, best.z);
  layoutCamp(camp, camp.index);
  /* Everybody's hut moved with the camp, so everybody needs a new one — a
     reference to the old hut is a person walking to where their house was. */
  for (const p of people) {
    if (p.camp !== camp) continue;
    p.hut = camp.huts[(luck() * camp.huts.length) | 0];
    p.state = 'idle';
    p.timer = luck() * 3;
    p.visiting = null;
    p.x = camp.x + (luck() - 0.5) * 8;
    p.z = camp.z + (luck() - 0.5) * 8;
  }
  logEvent('moved',
    `[${camp.code}] ${camp.name} moved on — ${Math.round(Math.hypot(best.x - from.x, best.z - from.z))}m`,
    camp.x, camp.z);
  paintPeople();
  renderTribes();
  return true;
}

export function newCampSite(rng) {
  let best = null, bestFlat = 0;
  for (let t = 0; t < 260; t++) {
    const a = rng() * Math.PI * 2;
    const r = (120 + Math.sqrt(rng()) * 340) * MAP_SCALE;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = sampleHeight(x, z);
    if (h < SEA + 4 || h > SNOW - 25) continue;
    if (camps.some((c) => Math.hypot(c.x - x, c.z - z) < SPLIT.minAway * MAP_SCALE)) continue;
    const flat = flatnessAt(x, z);
    if (flat > bestFlat) { bestFlat = flat; best = { x, z }; }
    if (flat > 0.985) break;
  }
  return best;
}

/* The chief is the one with the most in them: old enough to be listened to,
   rested enough to lead a day's walk, and carrying the most of what the band
   knows — which is what makes the new camp start with something. */
export function pickChief(camp) {
  /* Two passes, and the second one is the point.

     The first is who you would choose: an adult in their prime, well enough to
     stand up, who knows things. The second is everyone else, because a band
     that has aged badly — elders and children and nobody in between — had no
     chief at all under the first rule, and a card reading "Chief nobody" over
     seven living people is the page being wrong rather than the band being in
     trouble. Somebody is in charge of a band that exists. */
  const rank = (p) => (p.knows?.spears || 0) + (p.knows?.baskets || 0)
    + (p.knows?.drying || 0) * 2 + p.energy + (p.sex === 'f' ? 0.15 : 0);
  let best = null, bestScore = -Infinity;
  for (const p of people) {
    if (p.camp !== camp || p.child || p.sick) continue;
    const age = personAge(p);
    if (age < 18 || age > 45) continue;
    const score = rank(p);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (best) return best;

  /* Nobody in their prime. The eldest who is not a child leads — an old woman
     who remembers how it is done, and failing even that, whoever is oldest. */
  for (const p of people) {
    if (p.camp !== camp || p.child) continue;
    const score = personAge(p) + (p.sick ? -100 : 0);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (best) return best;
  for (const p of people) {
    if (p.camp !== camp) continue;
    const score = personAge(p);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

/* Whoever leads a band. Held as an id rather than a person, because a person
   is spliced out of the world when they die and a stale reference to one is a
   way of quietly keeping a dead man in charge. Re-picked when the last one is
   gone, which is the only time it changes. */
export function chiefOf(camp) {
  let chief = camp.chief ? people.find((p) => p.id === camp.chief) : null;
  if (chief && chief.camp === camp) return chief;
  chief = pickChief(camp);
  camp.chief = chief ? chief.id : 0;
  return chief;
}

/** How many children somebody has had, living or not — the record keeps both. */
export function childrenOf(p) {
  let n = 0;
  for (const r of lineage) if (r.m === p.id || r.f === p.id) n++;
  return n;
}

export function fertileNow(p) {
  const age = personAge(p);
  return !p.child && age >= LIFE.fertileFrom && age <= LIFE.fertileTo;
}

/* Who goes.

   A band is not a number of people. It is people who can feed themselves and
   people who can have children, and a group missing either is a group that ends
   — quietly, without starving, simply by running out of anybody to be next.

   This used to sort by age and take the first of them, which took the CHILDREN:
   a new camp of one chief and a pile of infants, nobody fertile, nobody able to
   forage or hunt. And the parent, stripped of every child, had no next
   generation either. One line, and it doomed both camps.

   So: fertile adults of both sexes first, the youngest of them, because they
   have the most years of childbearing ahead. Then children, oldest first, since
   they are the soonest to be of any use. And neither camp may be left without a
   pair who can have children — if that cannot be arranged, nobody leaves. */
export function pickLeavers(parent, chief) {
  const here = people.filter((p) => p.camp === parent && p !== chief && !p.sick);
  const youngestFirst = (a, b) => personAge(a) - personAge(b);
  const women = here.filter((p) => p.sex === 'f' && fertileNow(p)).sort(youngestFirst);
  const men = here.filter((p) => p.sex === 'm' && fertileNow(p)).sort(youngestFirst);

  const spare = (list) => Math.max(0, list.length - SPLIT.keepPairs);
  let takeW = Math.min(spare(women), SPLIT.pairs);
  let takeM = Math.min(spare(men), SPLIT.pairs);
  // The chief is one of the pair already, whichever they are.
  if (chief.sex === 'f') takeW = Math.max(0, takeW - 1); else takeM = Math.max(0, takeM - 1);

  const going = [chief, ...women.slice(0, takeW), ...men.slice(0, takeM)];
  const fertile = going.filter(fertileNow);
  if (!fertile.some((p) => p.sex === 'f') || !fertile.some((p) => p.sex === 'm')) return null;

  const want = Math.max(going.length, Math.round(parent.pop * SPLIT.takes));
  const kids = here.filter((p) => p.child && !going.includes(p))
    .sort((a, b) => personAge(b) - personAge(a));
  going.push(...kids.slice(0, Math.max(0, want - going.length)));
  return going;
}

export function splitCamp(parent) {
  if (camps.length >= campCapacity) return false;
  const chief = pickChief(parent);
  if (!chief) return false;
  /* Checked before a camp is built rather than after, because a split that
     cannot be made viable should leave no trace at all. */
  if (!pickLeavers(parent, chief)) return false;
  const rng = mulberry32((P.seed ^ 0x5b1f7) + camps.length * 7717 + Math.floor(simDay));
  const site = newCampSite(rng);
  if (!site) return false;

  const voice = tribeVoice(rng);
  const camp = {
    index: camps.length, x: site.x, z: site.z, y: sampleHeight(site.x, site.z),
    rng, voice, name: uniqueName(rng, 2 + ((rng() * 2) | 0), voice),
    code: worldCode((P.seed ^ 0x1d3f) + camps.length * 6151),
    get color() { return codeColor(this.code); },
    food: 0, pop: 0, need: 0, hunger: 0, wasEmpty: false,
    /* What the leavers remember between them, which is where the new band
       starts. A camp founded by somebody who knew how to cure meat does not
       have to work it out again. */
    skill: { spears: 0, baskets: 0, drying: 0 },
    told: { spears: 0, baskets: 0, drying: 0 },
    toll: { age: 0, infancy: 0, hunger: 0, exhaustion: 0, sickness: 0, tiger: 0 },
    born: 0, peak: 0, founded: simDay, gone: false, history: [],
  };
  camp.chief = chief.id;
  camps.push(camp);
  layoutCamp(camp, camp.index);

  const going = pickLeavers(parent, chief);
  if (!going) { camps.pop(); return false; }
  for (const p of going) {
    recordMove(p, parent, camp);
    p.camp = camp;
    p.hut = camp.huts[(luck() * camp.huts.length) | 0];
    p.state = 'idle';
    p.timer = luck() * 3;
    p.visiting = null;
    for (const key in SKILLS) {
      camp.skill[key] = Math.max(camp.skill[key], (p.knows?.[key] || 0));
    }
  }
  /* What they already know about the new ground. They grew up here and have
     foraged over it for years, so the patches near where they are going are
     patches they know — and a band founded knowing nothing is a band spending
     its first winter learning the valley by guesswork, which is the winter it
     does not get through. */
  camp.patches = (parent.patches || [])
    .filter((q) => Math.hypot(q.x - camp.x, q.z - camp.z) < 140)
    .map((q) => ({ ...q }));

  // A share of the stores goes with a share of the people.
  const share = parent.food * (going.length / Math.max(1, parent.pop));
  parent.food -= share;
  camp.food = share;
  parent.splitAt = simDay;

  paintPeople();
  renderTribes();
  logEvent('split',
    `[${camp.code}] ${camp.name} broke away from [${parent.code}] ${parent.name}`
    + ` — ${going.length} went with ${chief.name}`, camp.x, camp.z);
  return true;
}

export function updateEconomy(days) {
  for (const c of camps) { c.pop = 0; c.need = 0; }
  for (const p of people) {
    p.camp.pop++;
    p.camp.need += p.child ? FOOD.child : FOOD.adult;
  }
  /* Population first, and the peak with it, so the obituary can say how big
     they ever got — which is most of the difference between a band that never
     took and one that was doing well until something happened to it. */
  /* Too many round one fire, with enough put by to spare the walkers. Checked
     after the head count and before anything is eaten, so the day it happens
     both camps are counted properly. */
  for (const c of camps) {
    if (c.pop >= SPLIT.at && daysOfFood(c) > SPLIT.needFood
        && simDay - (c.splitAt || -999) > SPLIT.everyYears * P.yearLength) {
      splitCamp(c);
      break;                       // one at a time; the next can go tomorrow
    }
  }

  for (const c of camps) {
    if (c.pop > (c.peak || 0)) c.peak = c.pop;
    /* The moment the last of them dies. Written once: `gone` stays set, so a
       camp that is repopulated later by somebody walking over from the next
       band gets its own second ending if it comes to that. */
    if (c.pop === 0 && !c.gone && (c.lost || 0) > 0) {
      c.gone = true;
      obituary(c);
    } else if (c.pop > 0 && c.gone) {
      c.gone = false;
    }
  }

  for (const c of camps) {
    const before = c.food;
    // Curing is the only thing standing between a good week and a lean one:
    // without it nothing keeps, and a band this side of agriculture cannot
    // hoard its way out of a bad season however well it hunts.
    const spoil = FOOD.spoil * (1 - SKILL.dryKeep * c.skill.drying);
    c.food = Math.max(0, c.food - c.need * days - c.food * spoil * days);
    c.hunger = clamp(1 - daysOfFood(c) / FOOD.comfortable, 0, 1);
    // Log the crossing, not the state: a chronicle of "still hungry" every
    // frame is not a chronicle.
    if (before > 0 && c.food === 0) logEvent('hunger', `[${c.code}] ${c.name} has nothing left`, c.x, c.z);
    if (c.wasEmpty && c.food > c.need) logEvent('relief', `[${c.code}] ${c.name} has food again`, c.x, c.z);
    c.wasEmpty = c.food === 0;
  }
}

/* Animals come back. Logistic growth, so a hunted-out species recovers slowly
   from few and quickly from many, and never past the number asked for on the
   slider — overhunting is felt, and is not permanent. */
/* Sickness runs on days, not years: it arrives at a camp, spreads through the
   people in it, runs its course and leaves the survivors with some immunity.
   Everything here is a per-day probability scaled by `days`, which is however
   much of a day went past this frame. */
/** Anybody in this band lying ill. */
export function campIsIll(camp) {
  for (const p of people) if (p.camp === camp && p.sick) return true;
  return false;
}

export function updateSickness(days) {
  if (!camps.length) return;
  // Winter is the dangerous one; high summer barely at all.
  const season = seasonName === 'winter' ? PLAGUE.winter
    : seasonName === 'autumn' ? 1.6
    : seasonName === 'spring' ? 1.1 : 1;

  for (const camp of camps) {
    let here = 0, sick = 0;
    for (const p of people) if (p.camp === camp) { here++; if (p.sick) sick++; }
    if (here === 0) continue;

    /* Arrival: one case out of nowhere, and only into a camp that has none.
       An outbreak already running does not need help starting. */
    if (sick === 0 && luck() < PLAGUE.arrival * season * days) {
      const well = people.filter((p) => p.camp === camp && !p.sick && !immune(p));
      if (well.length) {
        fallIll(well[(luck() * well.length) | 0]);
        logEvent('sickness', `a sickness reached [${camp.code}] ${camp.name}`, camp.x, camp.z);
      }
    }

    /* Spread: each sick person is a source, and a crowded camp with an empty
       store catches it faster. */
    if (sick > 0) {
      const crowd = Math.min(here / PLAGUE.crowding, 1.5);
      const weak = 1 + camp.hunger;
      const chance = PLAGUE.spread * sick * crowd * weak * season * days;
      for (const p of people) {
        if (p.camp !== camp || p.sick || immune(p)) continue;
        if (luck() < chance) fallIll(p);
      }
    }
  }

  /* Somebody sat with them. Water, food they cannot fetch, and being kept warm
     — which is most of what anybody could do about a fever for the whole of
     prehistory, and it is the difference between recovering and not. It is also
     how the person doing it catches it, which is what makes it a decision
     rather than a free improvement. */
  for (const camp of camps) {
    const nurses = people.filter((p) => p.camp === camp && p.job === 'nurse' && !p.sick);
    if (!nurses.length) continue;
    const beds = nurses.length * PLAGUE.tendPer;
    let seen = 0;
    for (const p of people) {
      if (p.camp !== camp || !p.sick || seen >= beds) continue;
      seen++;
      p.tended = true;
    }
    for (const n of nurses) {
      if (immune(n)) continue;
      if (luck() < PLAGUE.catching * days) {
        fallIll(n);
        logEvent('sickness', `${who(n)} caught it from the ones they were sitting with`, n.x, n.z);
      }
    }
  }

  // Running its course. Whoever is left standing at the end of it recovers.
  for (const p of people) {
    if (!p.sick) continue;
    p.sick -= days * (p.tended ? 1 + PLAGUE.nurse : 1);
    p.tended = false;
    if (p.sick <= 0) {
      p.sick = 0;
      p.immuneUntil = simDay + PLAGUE.immuneYears * P.yearLength;
      p.energy = Math.min(p.energy, 0.35);      // up, but not up to much
    }
  }
}

export function immune(p) {
  return (p.immuneUntil || 0) > simDay;
}

export function fallIll(p) {
  p.sick = PLAGUE.runs * (0.6 + luck() * 0.8);
  p.energy = Math.min(p.energy, 0.5);
}

export function repopulate(days) {
  for (const pack of packs) {
    const q = QUARRY[pack.spec.key];
    if (!q) continue;
    const alive = pack.list.filter((a) => !a.dead);
    const target = pack.list.length;
    if (alive.length >= target || alive.length === 0) continue;
    const rate = q.regrow * alive.length * (1 - alive.length / target);
    if (luck() > rate * days) continue;
    const born = pack.list.find((a) => a.dead);
    if (!born) continue;
    const h = pack.herds[(luck() * pack.herds.length) | 0];
    born.dead = false;
    born.hidden = false;   // back in its slot, and drawn again
    born.x = h.x + (luck() - 0.5) * 20;
    born.z = h.z + (luck() - 0.5) * 20;
    born.state = 'graze';
    born.timer = 2;
    born.speed = 0;
    born.energy = 0.7 + luck() * 0.3;
    born.fed = 0.5 + luck() * 0.5;
    recountAnimals();
  }
}

/** The nearest living animal, for a hunter to go after. */
export function findPrey(x, z) {
  let best = null, bestD = FOOD.searchRadius * FOOD.searchRadius;
  for (const pack of packs) {
    if (!QUARRY[pack.spec.key]) continue;
    /* A species that has been hunted down is left alone until it recovers.
       Read it either way — the band knows, or the survivors have simply moved
       somewhere else — but it is what stops a camp eating its world. */
    const alive = pack.list.reduce((n, a) => n + (a.dead ? 0 : 1), 0);
    if (alive < pack.list.length * FOOD.minStock) continue;
    for (const a of pack.list) {
      if (a.dead) continue;
      const d = (a.x - x) ** 2 + (a.z - z) ** 2;
      if (d < bestD) { bestD = d; best = { animal: a, pack }; }
    }
  }
  return best;
}

export function tryKill(p, dt) {
  const prey = p.prey;
  if (!prey || prey.animal.dead) { p.prey = null; return false; }
  const a = prey.animal;
  // Chase: the target is wherever it is now, not where it was when we set off.
  p.targetX = a.x;
  p.targetZ = a.z;

  const gap = Math.hypot(a.x - p.x, a.z - p.z);
  if (gap > FOOD.killRange) return false;

  p.attempt -= dt;
  if (p.attempt > 0) return false;
  p.attempt = FOOD.attemptEvery;

  const q = QUARRY[prey.pack.spec.key];
  if (luck() > q.chance * (1 + SKILL.spearChance * p.camp.skill.spears)) return false;

  a.dead = true;
  recountAnimals();
  const meat = q.meat * (a.scale || 1);
  p.haul += meat;
  p.carry = 1;
  p.prey = null;
  p.kills++;
  logEvent('kill', `${who(p)} took a ${prey.pack.spec.key} · ${meat.toFixed(0)} food`, p.x, p.z);
  return true;
}

/* -------------------------------------------------------------------------
   The orchard

   Fruit is picked off the trees you can see, rather than deducted from an
   abstraction: a forager who finishes a trip under a bearing tree strips what
   is within arm's reach, those instances go, and the count on the panel goes
   with them. It grows back over the following days, and only in a season that
   bears — nothing ripens in a snowdrift.
   ------------------------------------------------------------------------- */

export const ORCHARD = {
  reach: 7,            // metres a forager can strip from where they stood
  takes: 6,            // most they will take from one spot
  /* A supplement, not a second harvest. At 0.09 a forager standing under a
     tree brought home more fruit than forage and roughly doubled the food
     supply; this is about a third on top of a trip that lands well, which is
     what "there is fruit here" ought to be worth. */
  worth: 0.02,         // food units a fruit is worth
  regrow: 0.50,        // share of the missing fruit that returns per sim-day
};

export const _fm4 = new THREE.Matrix4();

/** Puts one fruit back on its tree, or takes it off. */
export function setFruit(i, on) {
  if (!orchard || Boolean(orchard.on[i]) === on) return;
  orchard.on[i] = on ? 1 : 0;
  if (on) {
    _fm4.fromArray(orchard.home, i * 16);
    orchard.mesh.setMatrixAt(i, _fm4);
    orchard.ripe++;
  } else {
    orchard.mesh.setMatrixAt(i, HIDDEN);
    orchard.ripe--;
  }
  orchard.mesh.instanceMatrix.needsUpdate = true;
  stats.fruit = orchard.ripe;
}

/* What one forager takes from where they are standing. Returns the food it was
   worth, which is nothing at all if they finished their trip on bare ground —
   which is the point: fruit is somewhere in particular. */
export function pickFruit(x, z, reach = ORCHARD.reach, takes = ORCHARD.takes) {
  if (!orchard) return 0;
  const r2 = reach * reach;
  let taken = 0;
  for (let i = 0; i < orchard.on.length && taken < takes; i++) {
    if (!orchard.on[i]) continue;
    const b = i * 16;
    const dx = orchard.home[b + 12] - x, dz = orchard.home[b + 14] - z;
    if (dx * dx + dz * dz > r2) continue;
    setFruit(i, false);
    taken++;
  }
  if (taken) logFruit(taken, x, z);
  return taken * ORCHARD.worth;
}

/* Somewhere with fruit still on it, for something that eats fruit to walk to.
   Sampling rather than searching: a few random draws out of the whole orchard
   finds the nearest bearing tree well enough, and does not cost a pass over
   five thousand instances every time an animal decides where to go. */
export function nearestFruit(x, z, within) {
  if (!orchard || orchard.ripe <= 0) return null;
  const n = orchard.on.length;
  let best = null, bestD = within * within;
  for (let t = 0; t < 24; t++) {
    const i = (luck() * n) | 0;
    if (!orchard.on[i]) continue;
    const b = i * 16;
    const fx = orchard.home[b + 12], fz = orchard.home[b + 14];
    const d = (fx - x) ** 2 + (fz - z) ** 2;
    if (d < bestD) { bestD = d; best = { x: fx, z: fz }; }
  }
  return best;
}

/* Only worth a line in the chronicle when a camp strips a tree bare — one
   forager taking six berries is not news. */
export let strippedSince = 0;
export function logFruit(n, x, z) {
  strippedSince += n;
  if (orchard.ripe === 0 && strippedSince > 0) {
    logEvent('forage', 'the last of the fruit is picked', x, z);
    strippedSince = 0;
  }
}

/* Back onto the trees. Proportional to how much is missing, so an orchard that
   has been stripped fills slowly at first and then faster — and nothing ripens
   in a season that does not bear. */
export function regrowFruit(days) {
  if (!orchard || orchard.ripe >= orchard.on.length) return;
  const season = seasonUniforms.uFruit.value;
  if (season <= 0.02) return;
  const missing = orchard.on.length - orchard.ripe;
  let back = missing * ORCHARD.regrow * season * days;
  // Fractional growth would never round up to a whole fruit on a short frame,
  // so it is carried and spent as one when it reaches one.
  orchard.debt = (orchard.debt || 0) + back;
  let n = Math.floor(orchard.debt);
  if (n <= 0) return;
  orchard.debt -= n;
  for (let i = 0; i < orchard.on.length && n > 0; i++) {
    // Start somewhere different each time or the same trees always fill first.
    const k = (i + orchard.cursor | 0) % orchard.on.length;
    if (orchard.on[k]) continue;
    setFruit(k, true);
    n--;
  }
  orchard.cursor = ((orchard.cursor | 0) + 37) % orchard.on.length;
  strippedSince = 0;
}

/* How rich the ground is to forage. The same noise that decides where flowers
   grow decides where there is something worth picking, which means the good
   foraging is visibly the flowery ground. */
export function forageRichness(x, z) {
  // Ground richness times the time of year. Winter yields about a third of high
  // summer, which is the whole reason a store is worth keeping.
  return (0.55 + fbm(x * 0.010, z * 0.010, 2, P.seed + 707)) * forageSeason;
}

/* -------------------------------------------------------------------------
   Lives

   People are born, grow, and die. Until now the band was sixteen fixed figures
   repeating a day; now it is a population, and the question of whether it is
   still here in fifty years has an answer that nobody wrote down in advance.

   Everything hangs off one number per person: the day they were born. Age gives
   their size, whether they are a child, whether they can have children, and how
   likely they are to see the next season. Food decides how many are born.
   ------------------------------------------------------------------------- */

export const LIFE = {
  adultAt: 14,          // years; a child's body reaches its adult build here
  fertileFrom: 16,
  fertileTo: 42,
  birthPerYear: 0.30,   // per fertile adult per year, with the store full
  baseMortality: 0.008, // annual, before age tells
  agingFrom: 32,        // where mortality starts climbing
  agingScale: 11,       // the e-fold: bigger is a gentler old age
  /* Hunger kills before the store is literally empty. With this keyed to
     `food <= 0` the band never triggered it — it sat at two or three days of
     food and grew for thirty years, 16 people to 61, getting quietly hungrier
     and never paying for it. Squared, so a lean winter is survivable and a
     failing one is not. */
  hungerMortality: 0.40,
  newbornScale: 0.30,   // of their eventual adult size
};

/* Sickness. It arrives at a camp rather than at a person — one case, which then
   has to spread — and it is worse in winter, worse when the camp is crowded,
   and worse when the store is empty. Surviving it buys a few years of not
   catching it again, which is what stops a band being wiped out by the same
   illness every winter.

   Every rate here is per SIM-day, and a year is only twenty-four of those —
   so an illness that "runs for nine days" would be running for a third of a
   year. The numbers are small on purpose; they are not calendar days. */
export const PLAGUE = {
  arrival: 0.010,       // per camp per sim-day, before the season is taken into account
  winter: 3.2,          // how much likelier in winter than in summer
  spread: 0.30,         // per healthy campmate per sim-day, per sick person
  crowding: 14,         // the camp size at which spread is at full strength
  runs: 1.2,            // sim-days it runs in one person, give or take
  mortality: 0.10,      // per sim-day while sick, before hunger
  hungerFactor: 2.4,    // how much worse it is on an empty store
  immuneYears: 6,       // after recovering
  drag: 0.55,           // how much of their pace a sick person has
  /* Sickness was the leading cause of death and the only one nobody could do
     anything about. It arrived, it spread by crowding, it killed a tenth of
     the people it touched a day, and every person in the band stood by. */
  nurse: 0.55,          // how much faster it runs its course with somebody sat with them
  catching: 0.16,       // per sim-day, the chance the one sitting with them catches it
  tendPer: 3,           // sick people one nurse can sit with
  /* And it never left the camp it started in. A band that has it now keeps to
     itself; the way it crosses the island is somebody who walked out before it
     showed in them. */
  carried: 0.22,        // chance a visitor from an afflicted band brings it with them
};

export let peopleCapacity = 0;
export let bornCount = 0, diedCount = 0;

export function personAge(p) {
  return (simDay - p.born) / P.yearLength;
}

/* Fast early and slowing after, which is roughly how growing works and, more
   to the point, means a child you follow is visibly bigger a few days later. */
export function growthOf(age) {
  return Math.pow(clamp(age / LIFE.adultAt, 0, 1), 0.65);
}

export function applyAge(p) {
  const age = personAge(p);
  const g = growthOf(age);
  p.child = age < LIFE.adultAt;
  p.scale = lerp(p.adultScale * LIFE.newbornScale, p.adultScale, g);
  // Proportion changes with growth too: children are big-headed and narrow.
  p.headScale = lerp(1.18, p.adultHead, g);
  p.shoulder = lerp(0.95, p.adultShoulder, g);
  p.hip = lerp(0.98, p.adultHip, g);
  /* The one thing you can actually read at fifty metres. A child's hair is a
     child's whatever they will grow into; it lengthens as they do. */
  p.hairLen = lerp(BUILDS.child.hair, p.adultHair, g);
  return age;
}

/** Annual chance of dying, given an age and how short the camp is of food. */
/* One hazard per cause rather than one number, so that when somebody dies the
   chronicle can say what of. They are competing risks: the total is what decides
   whether they die, and which one fired decides what killed them. */
export function hazards(p, age, hunger) {
  return {
    age: LIFE.baseMortality * Math.exp(Math.max(0, age - LIFE.agingFrom) / LIFE.agingScale),
    // Being small is dangerous in its own right before about five.
    infancy: age < 5 ? 0.03 * (1 - age / 5) : 0,
    hunger: LIFE.hungerMortality * hunger * hunger,
  };
}

/** Which of the competing risks fired, given that one of them did. */
export function pickCause(h, total) {
  let roll = luck() * total;
  for (const cause in h) if ((roll -= h[cause]) <= 0) return cause;
  return 'age';
}

export const DEATH_WORDS = {
  age: (p, age) => `died, ${describeAge(age)}`,
  infancy: (p, age) => `died ${age < 1 ? 'a baby' : `a child of ${Math.floor(age)}`}`,
  // The fast half: hungry enough that something else finishes it.
  hunger: (p, age) => `starved, ${describeAge(age)}`,
  /* Both of these are hunger. This one is the slow half — the store has been
     empty long enough that they cannot get up — and the wording used to say
     "had nothing left", which reads as somebody who worked themselves to
     death. Nobody has ever died of walking here: effort alone cannot reach
     zero, because a spent person drops to a walk and a walk pays for itself. */
  exhaustion: (p, age) => `grew too weak with hunger, ${describeAge(age)}`,
  sickness: (p, age) => `died of the sickness, ${describeAge(age)}`,
  tiger: (p, age) => `was taken by a tiger, ${describeAge(age)}`,
};

/** Removes them, says what of, and keeps the follow camera off a ghost. */
/* Sorted, worst first, and only the causes that actually happened. */
export function tollOf(camp) {
  return Object.entries(camp.toll || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
}

export const TOLL_WORDS = {
  age: 'old age', infancy: 'infancy', hunger: 'hunger',
  exhaustion: 'weakness from hunger', sickness: 'the sickness', tiger: 'tigers',
};

/* Why a band is not there any more. Written the moment the last of them dies,
   because that is the only moment everything needed to say it is still to hand
   — a minute later the camp is an empty clearing with a number beside it.

   The leading cause and the runner-up, because "eleven died" says nothing and
   "eleven died, seven of the sickness and three hungry" is the whole story. */
export function obituary(camp) {
  const toll = tollOf(camp);
  const lost = toll.reduce((n, [, k]) => n + k, 0);
  const years = Math.max(0, (simDay - (camp.founded || 0)) / P.yearLength);
  const how = toll.length
    ? toll.slice(0, 2).map(([cause, n]) => `${n} to ${TOLL_WORDS[cause] || cause}`).join(', ')
    : 'nobody knows what of';
  logEvent('extinct',
    `[${camp.code}] ${camp.name} is gone — ${lost} died, ${how}`
    + ` · ${years.toFixed(0)} years, ${camp.born} born, most they were was ${camp.peak}`,
    camp.x, camp.z);
}

export function killPerson(i, cause) {
  const p = people[i];
  const age = personAge(p);
  const say = (DEATH_WORDS[cause] || DEATH_WORDS.age)(p, age);
  logEvent('death', `${who(p)} ${say}`, p.x, p.z);
  buryPerson(p);
  p.camp.lost = (p.camp.lost || 0) + 1;
  p.camp.toll[cause] = (p.camp.toll[cause] || 0) + 1;
  recordDeath(p, cause);
  people.splice(i, 1);
  diedCount++;
  if (i === followIdx) setFollowIdx(-1);
  else if (i < followIdx) setFollowIdx(followIdx - 1);
  hidePeopleFrom(people.length);
  paintPeople();
}

/** A fertile adult of this camp and this sex, or nobody. */
export function pickParent(camp, sex) {
  const pool = [];
  for (const p of people) {
    if (p.camp !== camp || p.sex !== sex || p.sick) continue;
    const age = personAge(p);
    if (age >= LIFE.fertileFrom && age <= LIFE.fertileTo) pool.push(p);
  }
  return pool.length ? pool[(luck() * pool.length) | 0] : null;
}

/* Children look like their parents. Skin is the mean of the two with a little
   drift, and hair comes from one of them — so a family is something you can
   pick out of a camp by eye, and a band that has been to itself for
   generations comes to look like itself. */
export function inheritLooks(child, mother, father) {
  const from = [mother, father].filter(Boolean);
  if (!from.length) return;
  const mix = new THREE.Color(0, 0, 0);
  for (const parent of from) mix.add(_c.setHex(parent.skin));
  mix.multiplyScalar(1 / from.length);
  // A little drift, or every family converges on one shade in a century.
  mix.offsetHSL((luck() - 0.5) * 0.02, (luck() - 0.5) * 0.05,
    (luck() - 0.5) * 0.06);
  child.skin = mix.getHex();
  child.hairColor = from[(luck() * from.length) | 0].hairColor;
}

/* -------------------------------------------------------------------------
   Who somebody is

   Everybody made the same choice. Given the same hunger and the same tiredness
   every person in the world picked identically, so a band was a number and
   following one of them was watching the average of all of them.

   Three numbers, each around 1, each set at birth and each pulled a little
   towards the parents. They are deliberately few and deliberately blunt:

   `bold`      how far out they will forage, and how late they leave it before
               running from a tiger. Boldness feeds a band and boldness is what
               gets taken out on the far side of the island.
   `sociable`  how much they want to walk to the next band, and how readily they
               sit with somebody ill.
   `quick`     how fast they pick things up, and pass them on.

   Nothing here is a stat block: there is no combat, nothing is rolled against
   them. They tilt a weight that was already there, which is why a whole band of
   bold people reads as a bold band rather than as a spreadsheet.
   ------------------------------------------------------------------------- */

export const TRAIT_SPREAD = 0.30;     // how far from 1 a person can start
export const TRAIT_FROM_PARENTS = 0.5; // how much of it comes from them

/** A number near 1, pulled towards the average of whoever they came from. */
function inheritTrait(rng, key, mother, father) {
  const from = [mother, father].filter(Boolean).map((p) => p.traits?.[key] ?? 1);
  const mid = from.length ? from.reduce((a, b) => a + b, 0) / from.length : 1;
  const own = 1 + (rng() * 2 - 1) * TRAIT_SPREAD;
  return clamp(mid * TRAIT_FROM_PARENTS + own * (1 - TRAIT_FROM_PARENTS), 0.55, 1.55);
}

export function traitsFor(rng, mother, father) {
  return {
    bold: inheritTrait(rng, 'bold', mother, father),
    sociable: inheritTrait(rng, 'sociable', mother, father),
    quick: inheritTrait(rng, 'quick', mother, father),
  };
}

/* What to call somebody, for the card. Only the strongest one is named, and
   only if it is strong — most people are unremarkable and should read that way. */
export function traitWord(p) {
  if (!p.traits) return '';
  const named = { bold: 'bold', sociable: 'sociable', quick: 'quick to learn' };
  let best = '', by = 0.18;
  for (const k in named) {
    const off = p.traits[k] - 1;
    if (off > by) { by = off; best = named[k]; }
    if (-off > by) { by = -off; best = k === 'bold' ? 'cautious' : k === 'sociable' ? 'solitary' : 'slow to learn'; }
  }
  return best;
}

export function newPerson(camp, rng, ageYears) {
  const kind = rng() < 0.5 ? 'm' : 'f';
  const b = BUILDS[kind];
  const adultScale = b.scale[0] + rng() * (b.scale[1] - b.scale[0]);
  const a = rng() * Math.PI * 2, r = 2 + rng() * 6;
  const p = {
    camp, kind, sex: kind, child: true,
    id: takePersonId(),
    mother: 0, father: 0, motherName: '', fatherName: '',
    /* Overwritten at birth if there is a father. Anybody without one is the
       start of their own line, which is what the founding band is. */
    line: '', gen: 1,
    name: uniqueName(rng, 2, camp.voice || NAME_ONSET),
    born: simDay - ageYears * P.yearLength,
    adultScale, adultShoulder: b.shoulder, adultHip: b.hip, adultHead: b.head,
    adultHair: b.hair,
    x: camp.x + Math.cos(a) * r, z: camp.z + Math.sin(a) * r,
    yaw: rng() * Math.PI * 2, speed: 0, phase: rng() * Math.PI * 2,
    scale: adultScale, shoulder: b.shoulder, hip: b.hip, headScale: b.head,
    state: 'idle', job: 'tend', timer: rng() * 6, energy: 0.6 + rng() * 0.4,
    sick: 0, immuneUntil: 0, nourish: 1, panic: 0,
    targetX: camp.x, targetZ: camp.z,
    crouch: 0, bend: 0, carry: 0, hasSpear: false, asleep: false,
    haul: 0, prey: null, attempt: 0, kills: 0,
    hut: camp.huts[(rng() * camp.huts.length) | 0],
    work: rng() * Math.PI * 2,
    /* Their own, not their slot's. These used to be written into the instanced
       mesh once at build time, by slot — which meant anyone born afterwards got
       an untouched slot (three fills instanceColor with 1, so they came out
       white), and everyone shuffled up a place when somebody died and inherited
       a stranger's skin. */
    taught: false, knows: { spears: 0, baskets: 0, drying: 0 }, visiting: null, moved: false,
    traits: traitsFor(rng, null, null),
    skin: SKIN[(rng() * SKIN.length) | 0],
    skinShade: 0.9 + rng() * 0.2,
    garment: GARMENT[(rng() * GARMENT.length) | 0],
    garmentShade: 0.85 + rng() * 0.3,
    hairColor: HAIR[(rng() * HAIR.length) | 0],
  };
  p.line = p.name;
  applyAge(p);
  return p;
}

/* How a person is named everywhere: their band's two characters, then them.
   Plain text, so it stores and travels as plain text — the colour is put back
   at the moment it is drawn, by tribeChips. */
/* Nought to ten, and nought means dying. Rounded so that a person on the way
   out reads 1 rather than 0 until they really are at nothing: ceil keeps
   anything above zero off zero, which is what makes the zero mean something. */
export function energyOutOfTen(p) {
  return p.energy <= 0 ? 0 : Math.max(1, Math.min(10, Math.ceil(p.energy * 10)));
}

/* 1st, 2nd, 3rd, 4th — including the elevenths and twelfths, which are the
   ones a naive rule gets wrong. */
export function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
}

export function who(p) {
  return `[${p.camp.code}] ${p.name}`;
}

export function describeAge(age) {
  return age < 1 ? 'a baby' : age < LIFE.adultAt ? `a child of ${Math.floor(age)}` : `${Math.floor(age)}`;
}

export function updateLives(days) {
  if (!personParts || !camps.length) return;
  const perYear = days / P.yearLength;
  const before = people.length;

  // ---- dying ----
  for (let i = people.length - 1; i >= 0; i--) {
    const p = people[i];
    const age = applyAge(p);
    /* Taught once, on reaching adulthood, and imperfectly: a generation keeps
       most of what the last one knew and has to make up the rest itself. This
       is the whole reason knowledge can be lost — it lives in people, and the
       copy each of them carries is a little worse than the original. */
    if (!p.taught && !p.child) {
      p.taught = true;
      p.knows = p.knows || {};
      for (const key in SKILLS) {
        p.knows[key] = Math.max(p.knows[key] || 0, p.camp.skill[key] * SKILL.teach);
      }
    }
    const h = hazards(p, age, p.camp.hunger);
    /* Sickness is a daily risk rather than an annual one, so it is converted
       here rather than living in the same units as growing old. */
    if (p.sick) {
      h.sickness = PLAGUE.mortality * (1 + PLAGUE.hungerFactor * p.camp.hunger) * P.yearLength;
    }
    /* Nothing left. Not a risk, not a hazard competing with the others — a
       person at zero is done, and the readout said so all the way down. */
    if (p.energy <= 0) { killPerson(i, 'exhaustion'); continue; }

    let total = 0;
    for (const k in h) total += h[k];
    if (luck() < total * perYear) killPerson(i, pickCause(h, total));
  }

  updateSickness(days);
  fadeSkills(days);

  // ---- being born ----
  for (const camp of camps) {
    if (people.length >= peopleCapacity) break;
    /* It takes one of each, and the number of children a camp can have is set
       by its women rather than by its head count — so a run of sons is a real
       problem a generation later, which is the sort of thing worth being able
       to watch happen. */
    let mothers = 0, fathers = 0;
    for (const p of people) {
      if (p.camp !== camp || p.sick) continue;
      const age = personAge(p);
      if (age < LIFE.fertileFrom || age > LIFE.fertileTo) continue;
      if (p.sex === 'f') mothers++; else fathers++;
    }
    if (mothers < 1 || fathers < 1) continue;
    // Nobody has a child into an empty store.
    const plenty = clamp(daysOfFood(camp) / FOOD.comfortable, 0, 1);
    const chance = mothers * 2 * LIFE.birthPerYear * plenty * P.fertility * perYear;
    if (luck() > chance) continue;
    const child = newPerson(camp, luck, 0);
    /* Somebody's child, not the camp's. Two named people, which is what turns a
       population into a family tree you can follow — and the names are kept
       alongside the ids because a parent dies long before the child does and
       "daughter of" has to still mean something afterwards. */
    const mother = pickParent(camp, 'f');
    const father = pickParent(camp, 'm');
    if (mother) { child.mother = mother.id; child.motherName = mother.name; }
    if (father) {
      child.father = father.id;
      child.fatherName = father.name;
      /* Descent through the father, in one step. The line is whatever founder
         his line ends at, and the generation is one deeper than his — so
         walking a hundred fathers back costs nothing, because nobody ever
         walks it. */
      child.line = father.line || father.name;
      child.gen = (father.gen || 1) + 1;
    }
    /* Half from them, half their own. Which is enough for a bold line to run
       through three generations of a band and enough for it not to be a rule. */
    child.traits = traitsFor(luck, mother, father);
    inheritLooks(child, mother, father);
    recordPerson(child);
    people.push(child);
    bornCount++;
    camp.born++;
    logEvent('birth', mother
      ? `${who(child)} was born to ${mother.name}`
      : `${who(child)} was born`, camp.x, camp.z);
  }

  if (people.length !== before) {
    stats.people = people.length;
    updateHud();
    hidePeopleFrom(people.length);
    /* Everyone after a death moves up a slot, so the colours have to move with
       them — otherwise the band shuffles its skins around every funeral, and a
       newborn takes an unpainted slot and comes out white. */
    paintPeople();
    if (people.length === 0) logEvent('end', 'the last of them is gone', 0, 0);
  }
}

/** Park every unused instance at zero scale, so a death leaves no body behind. */
/* The meshes are allocated for the largest band the world will ever hold, and
   for most of a run most of that is empty. Parking the spare slots at zero
   scale still submits them — a person now has seventeen pieces rather than
   nine, so that was becoming real work for people who do not exist. Turning the
   draw count down instead means they are never submitted at all.

   The bounding sphere does not matter here: person meshes are frustumCulled
   false, because a band walking off the edge of the shot should keep animating
   rather than pop when it comes back. */
export function hidePeopleFrom(from) {
  if (!personParts) return;
  for (const key in personParts) {
    const per = partsPer(key);
    personParts[key].count = Math.min(from * per, personParts[key].instanceMatrix.count);
  }
}

/* ---- the day ---- */

export const _mBody = new THREE.Matrix4();
export const _mTorso = new THREE.Matrix4();

// Somewhere plausible to do the job: foraging goes out to vegetation, hunting
// goes a long way out, everything else happens in or near the camp.

/* chronicle lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setChronicle(v) { chronicle = v; }

/* pendingEvents lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setPendingEvents(v) { pendingEvents = v; }

/* runId lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setRunId(v) { runId = v; }

/* simDay lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setSimDay(v) { simDay = v; }

/* peopleCapacity lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setPeopleCapacity(v) { peopleCapacity = v; }

/* bornCount lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setBornCount(v) { bornCount = v; }

/* diedCount lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setDiedCount(v) { diedCount = v; }
