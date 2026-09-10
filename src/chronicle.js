import * as THREE from 'three';

import { P, SEA, WORLD } from './params.js';
import { clamp, flatnessAt, sampleHeight } from './noise.js';
import { seasonName, camera, canvas, controls, renderer, scene, sky, sunDir, sunLight } from './scene.js';
import { fauna, grassGroup, rockGroup, world } from './world.js';
import { lineage, pick } from './wildlife.js';
import { linButton, lineageView } from './kin.js';
import { PERSON, rateIndex, worldClock } from './clock.js';
import { camps, homeFire, inStoreArea, people, storeAreaOf, tribeGroup } from './people.js';
import {
  FOOD, SKILL, SKILLS, SKILL_RUNGS, TOLL_WORDS, VISIT, chiefOf, childrenOf, chronicle, daysOfFood, wealthOf, energyOutOfTen, isMilestone, milestonesOnly, personAge, simDay, skillTier, runId, tollOf, traitWord, who
} from './life.js';
import { DIFFICULTY_WORDS, SKILL_DIFFICULTY, SKILL_HOW, SKILL_NEEDS } from './skills.js';
import { fruitNear } from './orchard.js';
import { bagKind, bagWords, carryCap, hasLoad, loadOf } from './bag.js';
import { ORES, depositRadius, deposits } from './quarries.js';
import { preyNear } from './spear.js';
import { updateActionRings, whatHere } from './reach.js';
import { takeCover } from './danger.js';
import { atHome, canEat, condition } from './vitals.js';
import { moorRaft } from './rafts.js';
/* Read by the boot check through this module, which is the one it holds. */
export { RING_ON, actionRings, ringHexes, thicketNear, whatHere } from './reach.js';
import { VIEW_MODES, applyShadowSettings, carryFactor, tooHeavy } from './move.js';
import { $ } from './save.js';
import { PATCHES_MARKED, stepMapSize } from './map.js';
import { VIEW_NAMES, codeChip, setRate, sexMarks, toast, togglePanel, tribeChips } from './ui.js';
import { stopAhead } from './main.js';
import { nextStage, stageName, stageProgress } from './society.js';

/* -------------------------------------------------------------------------
   The whole chronicle

   The panel shows the last twelve lines, which is the right number for
   something you glance at while the world runs and the wrong number for
   anything else. This is the rest of it: every line the machine has kept, from
   every world, searchable and paged.

   The panel's list is capped at two hundred in memory. The database is not, so
   with a server this asks for the lot — a century of a couple of bands is a few
   thousand lines, which is nothing to hold and everything to be able to look
   through.
   ------------------------------------------------------------------------- */

export const CHRON_PAGE = 40;
export let chronRows = [];        // what is being looked through
export let chronPage = 0;
export let chronFind = '';

export async function openChronicle() {
  $('chron').hidden = false;
  chronRows = chronicle;
  chronPage = 0;
  renderChronPage();
  /* The in-memory list first so the window opens instantly, then the full
     history over the top of it. Waiting on a fetch to show anything makes a
     window that is usually empty for a moment and occasionally empty for good. */
  if (runId) {
    try {
      const res = await fetch('/api/chronicle?limit=2000');
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length) { chronRows = rows; renderChronPage(); }
      }
    } catch { /* no server, or it went away: the browser's copy stands */ }
  }
}

export function closeChronicle() { $('chron').hidden = true; }

/* Matched against everything a line can be looked up by: what it says, which
   band it was, which world, what kind of thing it was, and the day. Searching
   for "born" and searching for "TK" and searching for "42" should all work,
   because all three are things somebody would type. */
export function chronMatch(e, needle) {
  if (!needle) return true;
  return (`${e.text} ${e.kind} ${e.world || ''} d${e.day} ${e.hour}`)
    .toLowerCase().includes(needle);
}

export function chronFiltered() {
  const needle = chronFind.trim().toLowerCase();
  const rows = milestonesOnly ? chronRows.filter(isMilestone) : chronRows;
  return needle ? rows.filter((e) => chronMatch(e, needle)) : rows;
}

/* The needle picked out of the line, without letting what was typed become
   markup. Escaped first, then the marks are put in — the other way round and a
   search for "<b" writes tags into the page. */
export function markHits(text, needle) {
  const safe = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!needle) return safe;
  const at = safe.toLowerCase().indexOf(needle);
  if (at < 0) return safe;
  return safe.slice(0, at) + '<b class="hit">' + safe.slice(at, at + needle.length)
    + '</b>' + safe.slice(at + needle.length);
}

export function renderChronPage() {
  const rows = chronFiltered();
  const pages = Math.max(1, Math.ceil(rows.length / CHRON_PAGE));
  chronPage = clamp(chronPage, 0, pages - 1);
  const from = chronPage * CHRON_PAGE;
  const needle = chronFind.trim().toLowerCase();

  $('chronList').innerHTML = rows.slice(from, from + CHRON_PAGE).map((e) =>
    `<div>${codeChip(e.seed)}<span>d${e.day} ${e.hour}</span>`
    + `${tribeChips(markHits(e.text, needle))} <em>${e.kind}</em></div>`).join('')
    || `<div><em>${chronRows.length ? 'nothing matches that' : 'nothing has happened yet'}</em></div>`;

  const kept = milestonesOnly ? ' worth telling' : '';
  $('chronWhere').textContent = rows.length
    ? `${from + 1}–${Math.min(from + CHRON_PAGE, rows.length)} of ${rows.length}${kept}`
      + (needle || milestonesOnly ? ` · ${chronRows.length} in all` : '')
    : `0 of ${chronRows.length}`;
  $('chronPrev').disabled = chronPage === 0;
  $('chronNext').disabled = chronPage >= pages - 1;
}

/* -------------------------------------------------------------------------
   One band, in detail

   The panel line says how many and how hungry. This is who they are: the chief,
   everybody's age, how many children the women have had, and what each of them
   has actually carried home — which is the number that separates a hunter from
   somebody who mostly tends the fire.
   ------------------------------------------------------------------------- */

export let tribeShown = -1;

export function openTribe(i) {
  const camp = camps[i];
  if (!camp) return;
  tribeShown = i;
  /* Back to the living — opening one band on the tab you left another band's
     card on reads as the page being wrong. Unless there are no living, in
     which case the only thing there is to see is who there was. */
  tribeTab = people.some((p) => p.camp === camp) ? 'now' : 'was';
  lineageShown = 0;
  $('tribe').hidden = false;
  renderTribeCard();
}

export function closeTribe() { $('tribe').hidden = true; tribeShown = -1; }

/* -------------------------------------------------------------------------
   Who is gone

   A band is as much the people it has lost as the people in it, and until now
   the only trace of either was a count and a cause on the panel — "11 lost: 7
   tigers" says nothing about who. The record has always had the names; it just
   had nowhere to be read.

   Two ways to be gone. Died here, which the record now carries the cause of;
   or walked out to another band, which is not a loss at all and reads as one
   if the list does not say where they went. Somebody born here who died
   somewhere else counts as that band's, not this one's.
   ------------------------------------------------------------------------- */

export let tribeTab = 'now';

export function formerOf(camp) {
  const out = [];
  // A village taken by another tribe keeps the dead it had under its old code.
  const mine = (code) => code === camp.code || (camp.pastCodes || []).includes(code);
  for (const r of lineage) {
    if (r.d > 0 && mine(r.dc || r.c)) {
      out.push({ r, when: r.d, gone: 'died', how: DEATH_TOLD[r.x] || r.x || 'nobody knows what of' });
    } else if (r.to && mine(r.fr)) {
      out.push({ r, when: r.md || 0, gone: 'left', how: `went to ${r.to}` });
    }
  }
  // Most recent first: what just happened to a band is what you are looking for.
  return out.sort((a, b) => b.when - a.when);
}

/* The panel's words are about a band ("7 tigers"); these are about a person. */
export const DEATH_TOLD = {
  age: 'old age', infancy: 'died an infant', hunger: 'starved',
  exhaustion: 'too weak with hunger', sickness: 'the sickness', tiger: 'a tiger',
};

export function formerTable(camp) {
  const gone = formerOf(camp);
  if (!gone.length) return '<div>nobody has left and nobody has died</div>';
  return `<table><thead><tr><th>who</th><th>age</th><th>what became of them</th>`
    + `<th>day</th><th></th></tr></thead><tbody>`
    + gone.map(({ r, when, gone: how, how: why }) => {
      const years = Math.max(0, (when - r.b) / P.yearLength);
      return `<tr class="${how === 'left' ? '' : 'gone'}">`
        + `<td class="n">${r.n}</td>`
        + `<td>${Math.floor(years)}${sexMarks(r.s === 'f' ? '♀' : '♂')}</td>`
        + `<td class="n">${why}</td>`
        + `<td>${Math.floor(when)}</td>`
        + `<td>${linButton(r.i, r.n)}</td></tr>`;
    }).join('')
    + '</tbody></table>';
}

/* Which person's family the card is showing in the list's place, if any, and
   the tab it was opened from. The view itself is in kin.js. */
export let lineageShown = 0;
let lineageTab = 'now';

/* How long a band has been a band: years once it has a year behind it, days
   before that — "0 years old" reads as a band that does not exist yet, and a
   band that split off last month very much does. */
export function bandAge(camp) {
  const days = Math.max(0, simDay - (camp.founded || 0));
  const years = Math.floor(days / P.yearLength);
  if (years >= 1) return `${years} ${years === 1 ? 'year' : 'years'}`;
  const d = Math.floor(days);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}

export function renderTribeCard() {
  const camp = camps[tribeShown];
  if (!camp || $('tribe').hidden) return;

  const folk = people.filter((p) => p.camp === camp)
    .sort((a, b) => personAge(b) - personAge(a));
  const chief = chiefOf(camp);
  const brought = folk.reduce((n, p) => n + (p.brought || 0), 0);
  const toll = tollOf(camp);

  $('tribeName').innerHTML = `<b class="wcode" style="background:${camp.color}">${camp.code}</b>`
    + ` ${camp.name}`;
  /* Which band the pin will take you to, written on the pin itself.

     It used to read `tribeShown` at click time, through a live binding in
     another module, and a button that silently does nothing when that is out of
     step is indistinguishable from a button that is not wired up at all. The
     card is rendered for exactly one band; this is that band, recorded where
     the click can reach it without asking anybody. */
  const pin = $('tribeGo');
  if (pin) pin.dataset.camp = String(tribeShown);

  /* Everything the panel row used to carry, now that the row carries a name
     and a number. A list you scan and a card you read are different jobs, and
     this is the one with room to do the second. */
  let women = 0, men = 0, kids = 0, ill = 0;
  for (const p of folk) {
    if (p.sex === 'f') women++; else men++;
    if (p.child) kids++;
    if (p.sick) ill++;
  }
  /* A row each, in a table like the rest of the card: which skill, how much of
     it they have out of a hundred, and the rung that amounts to. A number
     rather than a bar — 62/100 says exactly what a bar could only suggest, and
     the whole reason skills are interesting is watching one climb while the
     others do not. */
  /* Easiest first: the ones any band picks up at its fire, then the ones that
     wait on something, then the chains. Within a step, in the order they came. */
  const skills = Object.keys(SKILLS).sort((a, b) => (SKILL_DIFFICULTY[a] || 9) - (SKILL_DIFFICULTY[b] || 9)).map((k) => {
    const v = camp.skill[k] || 0;
    const pct = Math.round(v * 100);
    return `<tr><td class="n">${SKILLS[k].of}</td><td>${pct}<span>/100</span></td>`
      + `<td class="n">${SKILL_RUNGS[skillTier(v)]}</td>`
      + `<td class="n d${SKILL_DIFFICULTY[k] || 0}">${DIFFICULTY_WORDS[SKILL_DIFFICULTY[k]] || ''}</td>`
      + `<td class="n how">${SKILL_NEEDS[k] || '—'}</td><td class="n how">${SKILL_HOW[k] || ''}</td></tr>`;
  }).join('');

  /* A tribe of more than one village, and what a taken village used to be. */
  const villages = camps.filter((c) => !c.gone && c.code === camp.code).length;
  const held = (villages > 1 ? `<div><span>one of</span> ${villages} <span>villages of</span> ${camp.name}</div>` : '')
    + (camp.villageName
      ? `<div><span>once</span> ${camp.villageName}<span>, taken on day ${Math.floor(camp.conqueredAt || 0)}</span></div>` : '');
  /* What it has become, and how far it is through holding the next rung's marks
     (society.js). */
  const next = nextStage(camp), rising = stageProgress(camp);
  const stageLine = `<div><span>a</span> <b>${stageName(camp)}</b>${next
    ? ` <span>· ${rising > 0 ? `${Math.round(rising * 100)}% of the way to ${/^[aeiou]/.test(next.name) ? 'an' : 'a'} ${next.name}`
      : `not yet on the way to ${/^[aeiou]/.test(next.name) ? 'an' : 'a'} ${next.name}`}</span>` : ''}</div>`;
  $('tribeHead').innerHTML = stageLine + held +
    `<div>Chief <b>${chief ? chief.name : 'nobody'}</b>`
    + `${chief ? ` <span>${Math.floor(personAge(chief))}${sexMarks(chief.sex === 'f' ? '♀' : '♂')}</span>` : ''}</div>`
    + `<div><b>${bandAge(camp)}</b> <span>old · founded on day ${Math.floor(camp.founded || 0)}</span></div>`
    + `<div><b>${folk.length}</b> <span>here</span>`
    + `${folk.length ? ` · ${sexMarks(`${women}♀ ${men}♂`)}` : ''}`
    + `${kids ? ` · ${kids} ${kids === 1 ? 'child' : 'children'}` : ''}`
    + `${ill ? ` · <em class="ill">${ill} ill</em>` : ''}</div>`
    + `<div><span>store</span> ${camp.food.toFixed(1)} `
    + `<span>(${daysOfFood(camp).toFixed(1)} days)</span> · `
    + `<span>carried home between them</span> ${brought.toFixed(0)}</div>`
    // The flock, when there is one (farming.js): the food that comes in every day.
    + (camp.stock >= 1 ? `<div><span>penned</span> ${Math.round(camp.stock)} <span>animals</span></div>` : '')
    /* What they are holding that somebody else could want, which is the number
       a raid is decided by and the one that makes a band a target. Stone rather
       than food is most of it: food spoils, so a band cannot hoard it, and the
       pile is the only thing here that keeps. */
    + `<div><span>worth taking</span> ${wealthOf(camp).toFixed(0)}`
    + ` <em>(${heldWords(camp)})</em></div>`
    + `<div><span>${camp.born} born · `
    + `most they were was ${camp.peak}${toll.length
        ? ` · lost ${toll.reduce((n, [, k]) => n + k, 0)}: `
          + toll.map(([k, n]) => `${n} ${TOLL_WORDS[k]}`).join(', ') : ''}</span></div>`;

  $('tribeNow').className = tribeTab === 'now' ? 'on' : '';
  $('tribeWas').className = tribeTab === 'was' ? 'on' : '';
  $('tribeLog').className = tribeTab === 'log' ? 'on' : '';
  $('tribeSkills').className = tribeTab === 'skills' ? 'on' : '';
  // Another tab closes a lineage; back, or the tab it was opened from, returns.
  if (lineageShown && tribeTab !== lineageTab) lineageShown = 0;
  if (lineageShown) { $('tribeList').innerHTML = lineageView(lineageShown); return; }
  if (tribeTab === 'skills') {
    $('tribeList').innerHTML = `<table class="skills"><thead><tr><th>skill</th><th>acquired</th><th>level</th><th>difficulty</th><th>needs</th><th>how it is learned</th></tr></thead>`
      + `<tbody>${skills}</tbody></table>`;
    return;
  }
  if (tribeTab === 'was') { $('tribeList').innerHTML = formerTable(camp); return; }
  if (tribeTab === 'log') { $('tribeList').innerHTML = campHistory(camp); return; }

  /* Sorted oldest first, because a band reads as a band that way: the elders
     who remember how things are done, then the ones doing them, then the
     children who will. */
  $('tribeList').innerHTML = folk.length
    ? `<table><thead><tr><th>who</th><th>age</th><th>is</th><th>children</th><th>carried</th><th>doing</th><th></th></tr></thead><tbody>`
      + folk.map((p) => {
        const kids = childrenOf(p);
        return `<tr class="${p === chief ? 'chief' : ''}${p.sick ? ' gone' : ''}"`
          + ` data-p="${p.id}" title="follow ${p.name}">`
          + `<td class="n">${p.name}</td>`
          + `<td>${Math.floor(personAge(p))}${sexMarks(p.sex === 'f' ? '♀' : '♂')}${p.child ? ' ·' : ''}</td>`
          /* What they are in the band. Blank for most of them, and blank for
             all of them in a band too small or too hungry to have divided the
             work — which is the column doing its job, not failing to. */
          + `<td class="n">${p.role && p.role !== 'forager' ? (ROLE_WORDS[p.role] || p.role) : ''}</td>`
          + `<td>${kids || (p.child ? '' : '—')}</td>`
          + `<td class="got">${(p.brought || 0).toFixed(0)}</td>`
          + `<td class="n">${p.sick ? 'ill' : doingWords(p)}</td>`
          + `<td>${linButton(p.id, p.name)}</td></tr>`;
      }).join('')
      + '</tbody></table>'
    : '<div>nobody is left</div>';
}

/* -------------------------------------------------------------------------
   What happened to this band

   The chronicle is every line from every world and it is searchable, which is
   the right shape for "when did anybody last learn to cure meat" and the wrong
   one for "what has become of these people". This is the same record read the
   other way round: one band, oldest last, and only the lines worth telling.

   Bands are found in it by their code rather than by a stored id, for the same
   reason the colour is: a line is text, it outlives the camp that wrote it, and
   it travels to another world's chronicle intact. `[TS]` in a line written
   forty years ago still says Tsekash, and nothing has to have been kept.
   ------------------------------------------------------------------------- */
export const CAMP_HISTORY_MAX = 40;

export function campHistory(camp) {
  const mine = chronicle.filter((e) => isMilestone(e)
    && e.seed === P.seed && e.text.includes(`[${camp.code}]`));
  if (!mine.length) {
    /* A band founded this morning has no history, and saying so is better than
       an empty box that reads as something failing to load. */
    return '<div>nothing worth telling yet</div>';
  }
  /* Oldest last, the way the rest of the chronicle reads. */
  return `<div id="tribeLogList">${mine.slice(0, CAMP_HISTORY_MAX).map((e) =>
    `<div><span class="d">day ${e.day}</span>${sexMarks(tribeChips(e.text))}</div>`).join('')}</div>`;
}

export function showKeys(open) {
  const el = $('keys');
  if (!el) return;
  el.hidden = !open;
}
export function toggleKeys() {
  const el = $('keys');
  if (el) showKeys(el.hidden);
}
export const LOOK_SENSITIVITY = 0.0026;      // radians per pixel dragged
export const PITCH_LIMIT = 1.5;              // just short of straight up or down

/* `astern` is the over-the-shoulder lock: the camera keeps its station behind
   whoever you are following instead of holding a compass bearing.

   Without it, "behind them" was only ever true for the instant it was set.
   `cam.yaw` is a direction in the world, so the moment somebody turned a corner
   the camera stayed pointing north and you were watching them walk away
   sideways, then head-on, then away again — which is not a following camera, it
   is a camera that happens to have been aimed at somebody once. */
export const cam = {
  yaw: 0, pitch: 0, dragging: false, lastX: 0, lastY: 0, astern: false,
};

/* How fast the camera comes back round behind them. Eased rather than welded:
   a camera pinned exactly to a person's heading swings hard every time they
   sidestep a rock, and the walk code turns them a little every few seconds to
   get round things. This is slow enough to ignore a dodge and quick enough to
   be back astern within a couple of steps of a real turn. */
export const ASTERN_EASE = 1.8;

/* Where the button went down, in every view. A click and a look-around begin
   identically and stay indistinguishable until the button comes up again. */
export const press = { x: 0, y: 0, live: false };

/* Following one person. The whole reason the band exists is to be watched, and
   watching it from a hundred metres up is not the same as walking a day with
   somebody. */
/* Errands with nothing to watch. Not a judgement about the person — somebody
   asleep is doing the most important thing they will do all day — but F is a
   request to be shown something, and the answer to it should not be a figure
   sitting still.

   Deliberately not `nurse`: sitting with somebody who is ill looks like sitting
   down and is the most interesting thing in a camp with a sickness in it. */
export const IDLE_JOBS = new Set(['play', 'tend', 'sleep']);

export let followIdx = -1;

/* The view F leaves you in: behind them, a shade above, close enough to see
   what they are doing with their hands. `followDist` is the wheel's business
   after that and the yaw and pitch are the drag's, which is exactly why this
   has to be somewhere they can all be put back from — twenty seconds of
   zooming and swinging around somebody is easy to do and, until now, nothing
   undid it. */
export const SHOULDER = { pitch: -0.12, dist: 4.5 };

/* Who you were watching before this one. Ids rather than indices: people die
   and the list shifts under you, and going "back" to whoever inherited an index
   is worse than refusing. Short, because it is a way out of a wrong keypress
   and not a browsing history. */
export const followTrail = [];
export const FOLLOW_TRAIL_MAX = 12;

/* Called before followIdx changes, by everything that changes it. */
export function rememberFollowed() {
  const p = people[followIdx];
  if (!p) return;
  const at = followTrail.indexOf(p.id);
  if (at >= 0) followTrail.splice(at, 1);
  followTrail.push(p.id);
  if (followTrail.length > FOLLOW_TRAIL_MAX) followTrail.shift();
}

/* Behind them and at arm's length again, whatever the wheel and the drag have
   been doing. Facing the way they are walking, which is where the camera starts
   and the only angle that stays useful while they move. */
export function shoulderView() {
  const p = followedPerson();
  if (!p) return false;
  cam.yaw = p.yaw;
  cam.pitch = SHOULDER.pitch;
  P.followDist = SHOULDER.dist;
  cam.astern = true;
  return true;
}

/* Back to whoever you were watching before. Skips anybody who has died since —
   the whole reason the trail is ids — and says so rather than doing nothing. */
export function followBack() {
  while (followTrail.length) {
    const id = followTrail.pop();
    const idx = people.findIndex((q) => q.id === id);
    if (idx < 0) continue;                      // died while you were away
    if (idx === followIdx) continue;            // already there; keep going back
    followPerson(idx, true, false);             // see the note on `remember`
    return true;
  }
  return false;
}
/* Whether the person being followed was asked for by name or by click, rather
   than found by `F`. It is the difference between a suggestion and a choice,
   and the handover below is allowed to overrule only the first of them. */
export let followChosen = false;
export const _follow = new THREE.Vector3();
export const _want = new THREE.Vector3();

export function pickFollow(announce = true) {
  if (!people.length) { followIdx = -1; return; }
  /* Somebody you can actually see.

     This asked for `!asleep`, which is a narrower thing than being visible and
     let F land on a person who was perfectly awake and inside a tent: knapping,
     sitting with the ill, or a toddler kept in. The caption said "knapping" and
     the screen showed a hut, which reads as the mode being broken.

     `p.hidden` is the answer the draw loop already worked out, so asking it
     cannot disagree with what is on screen — the same rule the caption follows.

     Two fallbacks, because refusing to pick anybody is worse than picking
     badly: anyone awake, then anyone at all. A camp can genuinely be all
     indoors — a wet afternoon, or three in the morning — and F still has to do
     something. */
  rememberFollowed();
  /* Somebody worth following, before anybody visible.

     F used to land on whoever was on screen, which on a fed island is mostly
     children: a band with a full store has a third of it under fourteen, and
     what a child does is play, run about, sit at the fire and sleep. You would
     press F four times to find somebody doing something, which is F not
     working rather than F being unlucky.

     So: an adult on an errand first. Everything below it is unchanged and is
     what makes this safe to want — the fallbacks already existed, because
     refusing to pick anybody is worse than picking badly, and a camp can
     genuinely be all children asleep in the rain. */
  /* Never the one you are already behind, in either of the pools that can
     afford the exclusion. F is "show me somebody", and showing you the person
     you are looking at is F doing nothing — which is what narrowing the first
     pool did the moment a band had exactly one adult on an errand. */
  const pool = [];
  for (let i = 0; i < people.length; i++) {
    const q = people[i];
    if (i !== followIdx && !q.hidden && !q.child && !IDLE_JOBS.has(q.job)) pool.push(i);
  }
  if (!pool.length) {
    for (let i = 0; i < people.length; i++) if (i !== followIdx && !people[i].hidden) pool.push(i);
  }
  if (!pool.length) for (let i = 0; i < people.length; i++) if (!people[i].asleep) pool.push(i);
  if (!pool.length) for (let i = 0; i < people.length; i++) pool.push(i);
  followIdx = pool[(Math.random() * pool.length) | 0];
  followChosen = false;
  const p = people[followIdx];
  /* Behind them, not in front. The camera sits at `target − forward × distance`,
     so adding π here put it out ahead walking backwards, staring at their face. */
  cam.yaw = p.yaw;
  cam.pitch = SHOULDER.pitch;
  P.followDist = SHOULDER.dist;
  cam.astern = true;
  if (announce) updateFollowCaption();
}

/* Follow this exact person. F finds you somebody, which is the right answer
   when you have nobody in mind and the wrong one the moment you do — usually
   you are already watching one of them carry something home. */
/* `remember` is false for one caller: stepping back along the trail. Going back
   to A must not put B on the trail, or shift+F pressed twice returns you to
   where you started — two people passing each other for ever instead of a way
   out of the room. */
export function followPerson(idx, announce = true, remember = true) {
  if (idx < 0 || idx >= people.length) return false;
  /* Entering Follow picks somebody at random on the way in, so the choice has
     to be made after the switch rather than before it. */
  if (P.view !== 'follow') setViewMode('follow');
  if (remember) rememberFollowed();
  followIdx = idx;
  followChosen = true;
  const p = people[idx];
  cam.yaw = p.yaw;                 // behind them, the way pickFollow leaves it
  cam.pitch = SHOULDER.pitch;
  P.followDist = SHOULDER.dist;
  cam.astern = true;
  updateFollowCaption();
  if (announce) toast(who(p));
  return true;
}

/* By who they are, not where they are in the array — the band card is built
   from a filtered, re-sorted copy of `people`, and a death renumbers the lot. */
export function followPersonById(id) {
  const idx = people.findIndex((p) => p.id === id);
  return idx < 0 ? false : followPerson(idx);
}

/* -------------------------------------------------------------------------
   Who you were watching, across a reload

   A refresh put you behind somebody else: Follow picks a person at random on
   the way in, so whoever you had spent ten minutes with was gone the moment
   the page came back. So who you are behind is kept in this browser as it
   changes — by id, because every death renumbers the array, and with the seed,
   because the same id on another island is somebody else — and the boot puts
   you back behind them once the world is standing.

   Written the moment it changes rather than with the ten-second save, because
   a refresh straight after switching to somebody new is exactly the case that
   matters. Kept per browser, like the map's layers: it is where you were
   looking, not a fact about the world.
   ------------------------------------------------------------------------- */
export const FOCUS_STORE = 'openworld.focus';
let keptSeed = null, keptView = null, keptId;

/** Called every frame; writes only when who or how you are watching changes. */
export function keepFocus() {
  const p = P.view === 'follow' ? followedPerson() : null;
  const id = p ? p.id : null;
  if (keptSeed === P.seed && keptView === P.view && keptId === id) return;
  keptSeed = P.seed;
  keptView = P.view;
  keptId = id;
  try { localStorage.setItem(FOCUS_STORE, JSON.stringify({ seed: P.seed, view: P.view, id })); } catch { /* nowhere to keep it */ }
}

/** On boot: back behind whoever you were behind, if they are in this world. */
export function restoreFocus() {
  let kept = null;
  try { kept = JSON.parse(localStorage.getItem(FOCUS_STORE) || 'null'); } catch { return false; }
  if (!kept || kept.seed !== P.seed || kept.view !== 'follow' || kept.id == null) return false;
  return followPersonById(kept.id);
}

/* -------------------------------------------------------------------------
   Somewhere else on the island

   `F` answers "show me somebody". In Orbit the question is "show me somewhere",
   and there was no answer to it but flying there yourself — which on a 3200m
   island is a long way to go to find out there is nothing at the other end.

   Dry land, not a cliff, and inside the island rather than out in the water.
   The same three tests camp siting uses, for the same reason: a spot that fails
   any of them is a spot there is nothing to look at.
   ------------------------------------------------------------------------- */
export const ROAM_TRIES = 60;         // give up and take the best of these
export const ROAM_HIGH = 26;          // metres above the ground it settles at
export const ROAM_BACK = 52;          // ...and how far back from what it looks at

export function pickRoam(announce = true) {
  let best = null, bestFlat = -1;
  for (let t = 0; t < ROAM_TRIES; t++) {
    const a = Math.random() * Math.PI * 2;
    /* sqrt so the points spread evenly over the disc rather than crowding the
       middle, and the same 0.44 of the map everything else stays inside. */
    const r = Math.sqrt(Math.random()) * WORLD * 0.42;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = sampleHeight(x, z);
    if (h < SEA + 2) continue;                    // not out at sea
    const flat = flatnessAt(x, z);
    if (flat > bestFlat) { bestFlat = flat; best = { x, z, y: h }; }
    if (flat > 0.9) break;                        // good enough, stop looking
  }
  if (!best) return false;

  controls.target.set(best.x, best.y + 2.5, best.z);
  /* Behind and above, on a random bearing, so pressing it twice at the same
     spot is still a different picture. */
  const look = Math.random() * Math.PI * 2;
  camera.position.set(
    best.x + Math.sin(look) * ROAM_BACK,
    best.y + ROAM_HIGH,
    best.z + Math.cos(look) * ROAM_BACK,
  );
  camera.lookAt(controls.target.x, controls.target.y, controls.target.z);
  syncLookFromCamera();
  if (P.view === 'orbit') controls.update();
  if (announce) {
    const away = Math.round(Math.hypot(best.x, best.z));
    toast(`${away}m from the middle · ${Math.round(best.y)}m up`);
  }
  return true;
}

export function followedPerson() {
  if (followIdx < 0 || followIdx >= people.length) return null;
  return people[followIdx];
}

/* -------------------------------------------------------------------------
   Where on the ground you pointed

   Clicking a person used to pick them to follow. It does not any more: the
   click means "go there" now, which is a thing you say about a place rather
   than about a person, and the two readings of one gesture cannot both be
   right. Choosing who to follow is F, or a name on the band card.

   Against the height field rather than against any mesh. March the ray out
   until it is under the ground, then bisect — a heightfield has exactly one
   crossing along a downward ray, so twenty-four halvings put it within a
   millimetre and it cannot miss a hill the way a plane test does.
   ------------------------------------------------------------------------- */
export const CLICK_SLOP_PX = 5;      // travel further than this and it was a drag
export const GROUND_MAX = 6000;      // metres out before it gives up
export const GROUND_STEP = 2;        // ...and how coarsely it looks on the way

export const _pickNdc = new THREE.Vector2();
export const _pickRay = new THREE.Raycaster();
export const _pickAt = new THREE.Vector3();

/** Where a screen point lands on the island, or null for sky and sea. */
export function pickGroundAt(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  _pickNdc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  _pickRay.setFromCamera(_pickNdc, camera);
  const ray = _pickRay.ray;
  if (ray.direction.y >= -0.0001) return null;          // pointed at the sky

  let above = 0, below = -1, t = 0, step = GROUND_STEP;
  for (let n = 0; n < 600 && t < GROUND_MAX; n++) {
    t += step;
    _pickAt.copy(ray.origin).addScaledVector(ray.direction, t);
    if (_pickAt.y <= sampleHeight(_pickAt.x, _pickAt.z)) { below = t; break; }
    above = t;
    step = Math.min(step * 1.08, 24);                   // coarser the further out
  }
  if (below < 0) return null;                           // never came down to it

  for (let n = 0; n < 24; n++) {
    const mid = (above + below) / 2;
    _pickAt.copy(ray.origin).addScaledVector(ray.direction, mid);
    if (_pickAt.y <= sampleHeight(_pickAt.x, _pickAt.z)) below = mid; else above = mid;
  }
  _pickAt.copy(ray.origin).addScaledVector(ray.direction, below);
  /* Out past the shelf is not somewhere anybody can be sent. */
  if (sampleHeight(_pickAt.x, _pickAt.z) < SEA + 0.5) return null;
  if (Math.hypot(_pickAt.x, _pickAt.z) > WORLD * 0.46) return null;
  return { x: _pickAt.x, z: _pickAt.z };
}

/* -------------------------------------------------------------------------
   Taking somebody by the hand

   Following is watching. This is the other half of it: the person you are
   behind does what you say instead of what they were going to do.

   Click the ground and they walk there. Click somewhere else and they turn
   and walk there instead; shift+W hands them back. Holding a key to make them
   move was one instruction too many for what is really a single idea — you
   pointed, so go — and it meant a walk across the island was a key held down
   for a minute.

   While they are led, nothing else gets to steer them — not dusk, not a job
   timer, not a tiger — because a person who ignores you half the time is worse
   than one you cannot steer at all. Everything that is not steering still runs:
   they get tired, they get hungry, they can be caught.
   ------------------------------------------------------------------------- */
export function leadTo(x, z) {
  const p = followedPerson();
  if (!p) return false;
  p.led = true;
  p.leadX = x;
  p.leadZ = z;
  updateFollowCaption();
  return true;
}

/* Let go of, they do what somebody in their shoes would: a full load, or an
   animal over the shoulder, goes home to the granaries; a basket with room in
   it gets filled, at whatever filled it so far; empty-handed, they choose. */
export function carryOn(p) {
  if (!hasLoad(p)) return 'free';
  const load = loadOf(p), cap = carryCap(p, SKILL.basketHaul, p.camp.skill?.baskets || 0);
  const kind = bagKind(p.bag);
  if (load >= cap * 0.85 || kind === 'game') { p.goingHome = true; return 'home'; }
  p.orders = kind === 'fish' ? 'fish' : kind === 'wood' ? 'wood' : (p.bag?.ore > 0 ? 'quarry' : 'gather');
  return p.orders;
}

/** What they will do now, said. */
export function carryOnWords(p) {
  if (p.goingHome) return p.name + ' takes it home';
  const on = { gather: 'goes on foraging', fish: 'goes on fishing', quarry: 'goes on digging', wood: 'goes on cutting wood', farm: 'goes on working the fields' }[p.orders];
  return p.name + ' ' + (on || 'goes back to it');
}

/** Hands them back to themselves, wherever they happen to be standing. With
    `natural` they carry on as they would (carryOn); an order or a walk home
    passes false, because what they were told is what they do next. */
export function releaseLead(announce = true, natural = true) {
  const p = followedPerson();
  if (!p || !p.led) return false;
  p.led = false;
  p.state = 'idle';
  p.timer = 0;                     // pick something to do on the next step
  p.speed = 0;
  // And anything you had them in the middle of doing is theirs to drop.
  p.acting = false;
  p.act = null;
  // Out of the tree and up from cover: nobody is holding them there any more.
  p.climbed = null;
  p.lift = 0;
  p.hiding = false;
  p.resting = false;
  // Off the raft and ashore at its dock: nobody else can paddle it for them.
  if (p.onRaft) moorRaft(p);
  if (natural) carryOn(p);
  if (announce) toast(carryOnWords(p));
  updateFollowCaption();
  return true;
}

/* -------------------------------------------------------------------------
   Telling them what to do

   Clicking the ground says where. These say what: go and find food, go and
   hunt, sit down and knap. Six buttons across the bottom while you are behind
   somebody, and nothing at all when you are not.

   An order is one instruction taken up once, not a leash. They go and do the
   thing, and afterwards they are choosing for themselves again — which is the
   difference between telling somebody to go hunting and standing over them.

   Left on the person rather than acted on here. Everything that points somebody
   at a patch of ground draws from `luck()`, and the rule that keeps a world
   reproducible is that only what the step calls may draw from it: a click
   happens on a frame, not on a step, so it queues and the next turn spends it.
   ------------------------------------------------------------------------- */
/* What you can tell somebody to do. The last two are errands a grown band has
   and a new one does not: there is nowhere to quarry until somebody has found
   the rocks, and nowhere to stand until somebody has been buried. */
export const ORDERS = ['gather', 'hunt', 'craft', 'tend', 'sleep', 'visit', 'quarry', 'mourn', 'raid', 'fish', 'wood', 'farm'];

/* Too heavy to walk is too heavy to be sent anywhere: an order, the walk home
   or being let go to carry on would all have them walking off with it — the
   band's own logic only ever takes a fifth off a walk for a load. So none of
   those is taken until something is put down, or put away. */
function tooHeavyToSend(p) {
  if (!p || !tooHeavy(p)) return false;
  toast('too heavy to walk — put some down (G), or put it away (E)');
  return true;
}

export function orderJob(job) {
  const p = followedPerson();
  if (!p || !ORDERS.includes(job)) return false;
  if (tooHeavyToSend(p)) return false;
  /* An order is not a leash, and holding both would be two things steering one
     person. Being told to go hunting ends being walked about by hand. */
  if (p.led) releaseLead(false, false);
  p.orders = job;
  p.state = 'idle';
  p.timer = 0;                     // taken up on their next turn
  toast(`${p.name}: ${JOB_WORDS[job] || job}`);
  updateFollowCaption();
  return true;
}

/* -------------------------------------------------------------------------
   Giving them back

   Two ways of holding somebody and one way of letting go. Q already
   drops the hand on the shoulder, but an order set a moment ago is the other
   half of it, and nothing undid that except waiting for them to finish it. So
   this clears both: no point to walk to, no errand pending, and they choose
   for themselves on their next turn.

   It does not leave Follow. Handing somebody back and stopping watching them
   are different things, and the second one is Esc.
   ------------------------------------------------------------------------- */
export function handBack() {
  const p = P.view === 'follow' ? followedPerson() : null;
  if (!p) return false;
  const wasLed = p.led;
  const hadOrder = !!p.orders;
  /* Nothing is holding them, so there is nothing to undo and nothing to say.
     The button is disabled in this state; this is the guard behind it. */
  if (!wasLed && !hadOrder) return false;
  if (tooHeavyToSend(p)) return false;
  p.orders = null;
  if (wasLed) releaseLead(false);
  /* Cancelling an order they had not taken up yet. Idle with no time left is
     "choose something now", which is what releasing the lead does too. */
  else { p.state = 'idle'; p.timer = 0; }
  toast(carryOnWords(p));
  updateFollowCaption();
  return true;
}

/* -------------------------------------------------------------------------
   Back to the fire

   The one instruction that is not an errand. Everything in ORDERS sends
   somebody out; this brings them in, and it is the walk that ends every errand
   started early. What they are carrying goes into the store when they arrive,
   and then they are idle and their own again.

   Left on the person, like an order, and for the same reason: the walk wants a
   timeout worked out from the distance it is about to cover, and arriving is
   what banks the haul. Both of those are the step's business, and a click
   happens on a frame. The next turn spends it.
   ------------------------------------------------------------------------- */
export function sendHome() {
  const p = P.view === 'follow' ? followedPerson() : null;
  if (!p) return false;
  if (tooHeavyToSend(p)) return false;
  /* Being sent home ends being walked about by hand, the same way an order
     does: two things steering one person is one too many. */
  if (p.led) releaseLead(false, false);
  p.orders = null;
  p.goingHome = true;
  toast(`${p.name} heads home`);
  updateFollowCaption();
  return true;
}

/* -------------------------------------------------------------------------
   The basket, on screen

   At the left of the action bar: what they are carrying, all of it, how full
   the basket is, and the band's store it is for — so walking in with a full one
   and pressing E is something you can watch go into the number. An animal or
   ore is carried over the shoulder, not in the basket, and says so.

   Rewritten only when what it says changes: it is asked every frame.
   ------------------------------------------------------------------------- */
let bagShown = '';

/* The life bar, beside what they carry: out of a hundred, spent walking,
   running, working, carrying and in the cold, won back resting (X) and eating
   (N) — and a hint at which, or at what is wearing them down. */
function vitalsHtml(p) {
  const c = condition(p);
  return '<span class="vit' + (p.sick ? ' ill' : '') + '" title="' + c.detail + '"><u>life</u><i><b'
    + (c.low ? ' class="low"' : c.mid ? ' class="mid"' : '') + ' style="width:' + c.life + '%"></b></i>'
    + '<strong>' + c.life + '</strong>' + (c.hint ? '<em>' + c.hint + '</em>' : '') + '</span>';
}
export function updateBagHud(p) {
  const el = $('bagHud');
  if (!el || !p) return;
  const kind = bagKind(p.bag);
  const shoulder = kind === 'game' || kind === 'wood' || p.bag?.ore > 0;
  const what = bagWords(p.bag, true) || (p.haul > 0 ? 'food' : 'an empty basket');
  // How full: what it weighs against what they can carry.
  const full = clamp(loadOf(p) / carryCap(p, SKILL.basketHaul, p.camp.skill?.baskets || 0), 0, 1);
  /* The slowness is the one in the step (carryFactor, in updatePeople), said
     only while it applies — and when it is all of their pace, that they are
     stuck and what to do about it. */
  const loaded = p.carry || hasLoad(p);
  const pace = loaded ? carryFactor(p) : 1;
  const slow = !loaded ? ''
    : pace <= 0 ? '<i class="heavy">too heavy to walk</i> · '
      : Math.round((1 - pace) * 100) + '% slower · ';
  /* Where the store is, while there is something to take there: how far to
     the edge of the storage area, or that they are in it and E will do. */
  let where = '';
  if (hasLoad(p)) {
    const a = storeAreaOf(p);
    const off = Math.hypot(p.x - a.x, p.z - a.z) - a.r;
    where = off < 0 ? '<em class="here">at the granaries · E puts it away</em>'
      : '<em>granaries ' + Math.ceil(off) + ' m</em>';
  }
  const html = '<b>' + (shoulder ? 'on the shoulder: ' : '') + what + '</b>'
    + where
    + '<span class="bar' + (full >= 1 ? ' full' : '') + '"><i style="width:' + Math.round(full * 100) + '%"></i></span>'
    + '<small>' + slow + 'store '
    + daysOfFood(p.camp).toFixed(1) + ' days</small>'
    + vitalsHtml(p);
  if (html !== bagShown) { el.innerHTML = html; bagShown = html; }
}

/** Shows the row while you are behind somebody, and marks what they are at. */
export function updateOrders() {
  const box = $('orders');
  if (!box) return;
  const p = P.view === 'follow' ? followedPerson() : null;
  if (box.hidden !== !p) box.hidden = !p;
  if (!p) return;
  updateBagHud(p);
  const heavy = tooHeavy(p);
  for (const b of box.children) {
    const mine = b.dataset && b.dataset.order === (p.orders || p.job);
    if (b.classList.contains('on') !== !!mine) b.classList.toggle('on', !!mine);
    // Too heavy to walk: no errand can be set off on (tooHeavyToSend).
    if (b.dataset?.order && b.disabled !== heavy) b.disabled = heavy;
  }
  /* Greyed while nothing is holding them. A button whose whole job is to undo
     something has to say when there is nothing to undo: pressing it and having
     nothing happen reads as the button being broken. */
  const free = box.querySelector?.('button[data-act="free"]');
  if (free) {
    const held = !!(p.led || p.orders);
    const can = held && !heavy;
    if (free.disabled !== !can) free.disabled = !can;
  }
  const home = box.querySelector?.('button[data-act="home"]');
  if (home && home.disabled !== heavy) home.disabled = heavy;
  /* Put away: only in the storage area with something to put, and lit green
     when it is — the same green as the ring. Drop: whenever there is a load. */
  const loadNow = hasLoad(p);
  const store = box.querySelector?.('button[data-act="store"]');
  if (store) {
    const can = loadNow && inStoreArea(p);
    if (store.disabled !== !can) store.disabled = !can;
    store.classList?.toggle?.('ready', can);
  }
  const drop = box.querySelector?.('button[data-act="drop"]');
  if (drop && drop.disabled !== !loadNow) drop.disabled = !loadNow;
  // Rest lit while they are resting; eat only with something to eat.
  const rest = box.querySelector?.('button[data-act="rest"]');
  if (rest) rest.classList?.toggle?.('ready', Boolean(p.resting));
  const food = box.querySelector?.('button[data-act="eat"]');
  if (food) {
    const can = canEat(p);
    if (food.disabled !== !can) food.disabled = !can;
  }
}

/** True while the run key is down. Walking there is automatic; this is the
    extra — and the energy clamp downstream charges for it, so a band you run
    everywhere arrives tired and hunts worse. */
export function leadRunning() { return keys.has('ShiftLeft') || keys.has('ShiftRight'); }

/* -------------------------------------------------------------------------
   Walking them yourself

   Clicking says where; WASD says which way, the way you would walk anybody in
   a game. W is the way the camera looks, S back toward it, A and D to either
   side, and they turn to face the way they are going. Shift runs — the same run
   a click-walk gets, charged for the same way.

   It is the same walking, not a second kind. Holding a key keeps the lead point
   a few metres ahead of them that way, and letting go puts it where they stand,
   so everything that already applies to being led applies to this and nothing
   in the step is new. Set from a frame, like a click: a point on the ground is
   not a draw from the world's stream.
   ------------------------------------------------------------------------- */
export const STEER_AHEAD = 4;          // metres ahead of them the point is kept
let steering = false;

export function steerFollowed() {
  const p = P.view === 'follow' ? followedPerson() : null;
  if (!p || p.acting) { steering = false; return; }
  const sx = Math.sin(cam.yaw), sz = Math.cos(cam.yaw);
  let fx = 0, fz = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) { fx += sx; fz += sz; }
  if (keys.has('KeyS') || keys.has('ArrowDown')) { fx -= sx; fz -= sz; }
  if (keys.has('KeyD') || keys.has('ArrowRight')) { fx -= sz; fz += sx; }
  if (keys.has('KeyA') || keys.has('ArrowLeft')) { fx += sz; fz -= sx; }
  const len = Math.hypot(fx, fz);
  if (len > 1e-6) {
    // Up a tree they stay up it until Z. Down low they crawl — until they run.
    if (p.climbed) return;
    if (leadRunning()) p.hiding = false;
    p.resting = false;
    const was = p.led;
    p.led = true;
    p.orders = null;
    p.leadX = p.x + (fx / len) * STEER_AHEAD;
    p.leadZ = p.z + (fz / len) * STEER_AHEAD;
    steering = true;
    if (!was) updateFollowCaption();
  } else if (steering) {
    // Off the keys: they stop where they are, still yours.
    if (p.led) { p.leadX = p.x; p.leadZ = p.z; }
    steering = false;
  }
}

/* -------------------------------------------------------------------------
   Doing it yourself

   What E would do, and the rings on the ground that say so, are worked out in
   reach.js. This is the keys, the buttons and the prompt.
   ------------------------------------------------------------------------- */
let promptAt = 0;

/** G: puts one handful down in front of them — shift+G, all of it — as a
    pile that stays there. The step does it, like any act. */
export function dropHere(all = false) {
  const p = P.view === 'follow' ? followedPerson() : null;
  if (!p || p.acting || p.act || !hasLoad(p)) return false;
  p.led = true;
  p.orders = null;
  p.leadX = p.x;
  p.leadZ = p.z;
  p.act = { kind: 'drop', all: Boolean(all) };
  return true;
}

/** X: sit down to rest, or get up again. N: eat — out of the store at home,
    out of the basket anywhere. Both left on the person for the step, like E. */
function selfCare(kind) {
  const p = P.view === 'follow' ? followedPerson() : null;
  if (!p || p.acting || p.act || p.climbed) return false;
  p.led = true;
  p.orders = null;
  p.leadX = p.x;
  p.leadZ = p.z;
  p.act = { kind };
  return true;
}
export function restHere() { return selfCare('rest'); }
export function eatHere() { return selfCare('eat'); }

/** The put-away button: E, but only ever for putting away, and only where. */
export function storeHere() {
  const p = P.view === 'follow' ? followedPerson() : null;
  if (!p || p.acting || p.act || !hasLoad(p) || !inStoreArea(p)) return false;
  p.led = true;
  p.orders = null;
  p.leadX = p.x;
  p.leadZ = p.z;
  p.act = { kind: 'store' };
  return true;
}

/* -------------------------------------------------------------------------
   The storage area, on the ground

   A ring round the band's granaries while the person you are behind is
   carrying something: straw-coloured while they are outside it, green once
   they are in. Where to take a full basket is then something you can see,
   rather than a spot you find by pressing E until it works. Built the first
   time it is needed and not before, for the reason the lead ring gives.
   ------------------------------------------------------------------------- */
export let storeRing = null;
export const STORE_RING_OUT = 0xe8c872, STORE_RING_IN = 0x8fd18a;

export function updateStoreRing() {
  const p = P.view === 'follow' ? followedPerson() : null;
  if (!p || !hasLoad(p)) { if (storeRing) storeRing.visible = false; return; }
  if (!storeRing) {
    const geo = new THREE.RingGeometry(0.94, 1, 64);
    geo.rotateX(-Math.PI / 2);
    storeRing = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: STORE_RING_OUT, transparent: true, opacity: 0.75, depthWrite: false,
    }));
    storeRing.frustumCulled = false;
    storeRing.renderOrder = 3;
    scene.add(storeRing);
  }
  const a = storeAreaOf(p);
  storeRing.visible = true;
  storeRing.scale.set(a.r, 1, a.r);
  storeRing.position.set(a.x, sampleHeight(a.x, a.z) + 0.25, a.z);
  storeRing.material.color.setHex(inStoreArea(p) ? STORE_RING_IN : STORE_RING_OUT);
}

/** E: leaves the act on the person for the next turn to spend. */
export function actHere() {
  const p = P.view === 'follow' ? followedPerson() : null;
  if (!p || p.acting || p.act) return false;
  const t = whatHere(p);
  if (!t) return false;
  // Doing it yourself is holding their hand, and it is done where they stand.
  p.led = true;
  p.orders = null;
  p.leadX = p.x;
  p.leadZ = p.z;
  p.act = t;
  updateFollowCaption();
  return true;
}

/** The prompt at the bottom of the screen, and what came of a throw. */
export function updateActPrompt() {
  const el = $('actPrompt');
  const p = P.view === 'follow' ? followedPerson() : null;
  if (!p) { if (el && !el.hidden) el.hidden = true; return; }
  // A throw is decided in the step; it is said the frame after.
  if (p.actResult) { toast(p.actResult); p.actResult = null; }
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  if (now < promptAt) return;
  promptAt = now + 120;
  if (!el) return;
  // Above the order row, however tall the basket beside it has grown.
  const row = $('orders');
  const lift = row && !row.hidden && row.offsetHeight ? row.offsetHeight + 20 : 58;
  if (el.style && el.style.bottom !== lift + 'px') el.style.bottom = lift + 'px';
  if (p.acting || p.act) {
    el.innerHTML = (JOB_WORDS[p.job] || 'busy') + '…';
    el.hidden = false;
    return;
  }
  const t = whatHere(p);
  /* Too heavy to walk: what is in reach can still be done, and G is how to
     get moving again — a handful at a time, where it can be picked up. */
  const heavy = tooHeavy(p);
  el.classList?.toggle?.('heavy', heavy);
  if (!t && p.resting) {
    el.innerHTML = '<kbd>X</kbd> get up · resting' + (atHome(p) ? ' at home' : '');
    el.hidden = false;
    return;
  }
  if (!t && heavy) {
    el.innerHTML = '<kbd>G</kbd> put one down — too heavy to walk';
    el.hidden = false;
    return;
  }
  el.hidden = !t;
  if (t) el.innerHTML = '<kbd>E</kbd> ' + t.words + (heavy ? ' · too heavy to walk' : '');
}

/* -------------------------------------------------------------------------
   Where you sent them

   A ring on the ground at the point they are walking to, because otherwise the
   only evidence that a click landed is a person setting off — and from behind
   their shoulder, at three metres, that reads the same whichever way they were
   going to go anyway.

   On `scene` rather than on `world`: disposeWorld empties the world's groups
   when a new island is built, and a marker that belongs to the camera rather
   than to the island should not be one of the things thrown away with it. */
export const LEAD_MARK_INNER = 0.55;
export const LEAD_MARK_OUTER = 0.9;
export let leadMark = null;

export function leadMarker() {
  if (!leadMark) {
    const geo = new THREE.RingGeometry(LEAD_MARK_INNER, LEAD_MARK_OUTER, 28);
    geo.rotateX(-Math.PI / 2);              // flat on the ground, not facing the sky
    leadMark = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x9fe0ff, transparent: true, opacity: 0.8, depthWrite: false,
    }));
    leadMark.frustumCulled = false;
    leadMark.renderOrder = 3;
    leadMark.visible = false;
    scene.add(leadMark);
  }
  return leadMark;
}

/** Puts the ring where they are headed, or takes it away. Called every frame. */
export function updateLeadMark() {
  const p = P.view === 'follow' ? followedPerson() : null;
  /* Nothing is built until there is something to mark. Making the mesh on the
     first frame regardless looks harmless and is not: three.js gives every
     geometry, material and object a UUID out of Math.random, so a feature
     nobody had used yet was still spending draws — which in the boot harness,
     where Math.random is pinned so a seed replays, quietly built a different
     island. A ring for a click that never happened is not worth a world. */
  // Not while walking them with the keys: the point is only ever a step ahead.
  if (!p || !p.led || steering) { if (leadMark) leadMark.visible = false; return; }
  const mark = leadMarker();
  mark.visible = true;
  /* Just clear of the ground. Sitting exactly on it z-fights with the terrain,
     which reads as the marker flickering rather than as a marker. */
  mark.position.set(p.leadX, sampleHeight(p.leadX, p.leadZ) + 0.08, p.leadZ);
  /* A slow pulse, on world time so it stops with the world. It is the
     difference between a marker and a scorch mark on the grass. */
  const beat = 1 + Math.sin(worldClock * 2.4) * 0.14;
  mark.scale.set(beat, 1, beat);
}

/* What somebody is, as against what they are doing this afternoon. `forager`
   is deliberately absent: it is what everybody is until the band can afford
   for them not to be, and a card that says it of half the village says
   nothing. */
export const ROLE_WORDS = {
  chief: 'chief', hunter: 'hunter', knapper: 'toolmaker', healer: 'healer', warrior: 'warrior', fisher: 'fisher',
  keeper: 'fire-keeper', quarrier: 'quarrier', trader: 'trader',
};

export const JOB_WORDS = {
  gather: 'foraging', hunt: 'hunting', craft: 'knapping',
  tend: 'at the fire', play: 'playing', sleep: 'asleep',
  nurse: 'sitting with the ill',
  mourn: 'at the stones',
  quarry: 'working the rock',
  raid: 'taking it',
  fish: 'fishing',
  wood: 'cutting wood',
  farm: 'working the fields',
  visit: 'walking to the next band',
  led: 'going where you point',
};

/* The same jobs, for somebody still on their way to one. `visit` was always
   here in spirit — "walking to the next band" is a job that is mostly walking,
   and it was the only one the caption told the truth about. */
/* Where somebody has come in from, said only when it is worth saying. A person
   walking to the fire is walking to it from somewhere, and which somewhere is
   the difference between a figure crossing a hillside and a hunt that has just
   ended. Nothing for the camp jobs: "back from resting" is not news. */
export const CAME_WORDS = {
  gather: ', back from the foraging',
  hunt: ', back from a hunt',
  quarry: ', back from the rocks',
  wood: ', back with wood',
  farm: ', back from the fields',
  mourn: ', back from the stones',
  visit: ', back from the next band',
};

/* And the jobs that are somewhere to come back *to*. Walking out to forage
   "back from a hunt" is two errands in one sentence; walking to the fire back
   from one is a person you have been watching. */
export const HOMEWARD = new Set(['tend', 'craft', 'sleep', 'nurse']);

export const GOING_WORDS = {
  gather: 'walking out to forage',
  hunt: 'out after something',
  mourn: 'walking out to the stones',
  quarry: 'walking out to the rocks',
  raid: 'going to take it',
  fish: 'walking down to the water',
  wood: 'walking out for wood',
  farm: 'walking out to the fields',
  craft: 'off to sit and knap',
  tend: 'walking to the fire',
  nurse: 'going to sit with the ill',
  play: 'running about',
  sleep: 'off to their tent',
  visit: 'walking to the next band',
  led: 'going where you point',
};

/* The same jobs, for somebody who is under a roof doing them. A job says what
   the hands are busy with; it does not say where the person is, and the two
   came apart the moment anything was hidden — "at the fire" read off a tent. */
export const INDOOR_WORDS = {
  craft: 'knapping in a tent',
  nurse: 'sitting with the ill',
  tend: 'resting',
  play: 'resting',
  gather: 'resting',
  hunt: 'resting',
};

/* What to say they are doing.

   Keyed off `p.hidden` — the flag the draw loop sets — rather than off the job,
   so the words cannot disagree with the figure. If they are not on screen the
   caption says why, and if they are it says what they are up to. That is the
   same rule the click-picker follows, and for the same reason: one answer to
   "is this person visible", written in one place and read everywhere else. */
/* Slow enough to be a stroll and faster than standing still. `p.speed` eases
   toward what somebody wants rather than snapping, so a person who has just
   stopped spends a moment below a walk and above nothing. */
export const WALKING_AT = 0.25;

/* Why somebody is walking to the next band.

   "Walking to the next band" says where and not what, and a visit is the one
   errand in this world with several completely different points to it. The
   reasons are not invented for the caption either: they are the same conditions
   the visit was chosen under and the same ones `arriveAtCamp` acts on when it
   gets there — a band goes because it is comfortable enough to spare somebody
   or hungry enough to go and ask, and what actually changes hands is food,
   stone, or what one of them knows.

   Read in the order they matter. Somebody starving is going for food whatever
   else is in their arms. */
export function visitWords(p, walking) {
  const host = p.visiting;
  if (!host) return walking ? 'walking to the next band' : 'at the next band';
  const home = p.camp;
  const to = walking ? `walking to ${host.name}` : `at ${host.name}`;

  if (home.hunger > VISIT.begFrom) return `${to}, to ask for food`;
  if (home.food - home.need * FOOD.comfortable > 0 && host.hunger > 0.5) {
    return `${to}, with food`;
  }
  if ((home.stone || 0) - SKILL.stonePerTool * 4 > 0
      && (host.stone || 0) < SKILL.stoneMax * 0.5) {
    return `${to}, with stone to trade`;
  }
  /* What one band knows and the other does not, which is the quietest of the
     three and the one that changes the island. Their own memory rather than the
     camp's: what a visitor carries is what they can show, and that is the same
     number `arriveAtCamp` teaches from. */
  for (const key in SKILLS) {
    if ((p.knows?.[key] || 0) * VISIT.learn > (host.skill?.[key] || 0) + 0.08) {
      return `${to}, to show them ${SKILLS[key].of}`;
    }
  }
  return `${to}, to see them`;
}

/* Why somebody is at the fire.

   "At the fire" is where, and for a third of a band on any given afternoon it
   is the whole caption — which makes it the least informative thing the page
   says about the most people. The reasons are already on the person and on the
   camp; none of this is invented for the wording.

   Read in the order that decides it. Somebody with nothing left is resting
   whatever else is true of the evening. */
export function fireWords(p) {
  if (p.role === 'keeper') return 'keeping the fire';
  if (p.energy < 0.35) return 'resting by the fire';
  if ((p.camp?.hunger ?? 0) > 0.8) return 'at the fire, with nothing in the store';
  if (seasonName === 'winter') return 'at the fire, out of the cold';
  /* Night is last of the four, because it is the least surprising: everybody is
     at the fire at night, and saying so of all of them is saying nothing. */
  if (P.time < 6 || P.time > 20) return 'sitting up at the fire';
  return 'at the fire';
}

/* What a band has dug and kept: the stone pile, and whatever metal it has
   carried home, commonest first. */
export function heldWords(camp) {
  const held = [`${(camp.stone || 0).toFixed(0)} stone`];
  for (const k of ['iron', 'bronze', 'silver', 'gold']) {
    if (camp.ores?.[k] > 0) held.push(`${camp.ores[k]} ${k}`);
  }
  return held.join(' · ');
}

export function doingWords(p) {
  if (p.asleep) return 'asleep in a hut';
  if (p.hidden) return INDOOR_WORDS[p.job] || 'resting';

  /* What they are doing *now*, which for most of a day is walking to where they
     mean to do it. A job says what somebody is out to do; it does not say
     whether they have got there — so the caption read "knapping" and "at the
     fire" off a figure crossing a hillside, which is the same disagreement
     `INDOOR_WORDS` exists to fix, one step earlier.

     Read off `p.speed`, and that is the point rather than a convenience: it is
     the number `writePerson` builds the gait from, so the words cannot say one
     thing while the legs do another. Anything derived from the state machine
     instead can, and did — there is a moment at the end of every errand where
     somebody has arrived and is still coasting to a stop. */
  if (p.job === 'visit') return visitWords(p, p.speed > WALKING_AT);
  if (p.job === 'tend' && p.speed <= WALKING_AT) return fireWords(p);
  if (p.speed > WALKING_AT) {
    /* What they are bringing, said the way you would say it: "bringing home a
       deer", "bringing home 5 fish". Food when nothing was counted — a session
       saved before baskets were. */
    if (p.state === 'return') return p.carry ? `bringing home ${bagWords(p.bag) || 'food'}` : 'walking home';
    const going = GOING_WORDS[p.job] || 'walking';
    // ...and where from, when they are coming in off an errand worth naming.
    return HOMEWARD.has(p.job) ? going + (CAME_WORDS[p.came] || '') : going;
  }
  return JOB_WORDS[p.job] || p.job;
}

export function updateFollowCaption() {
  const el = $('following');
  if (!el) return;
  const p = followedPerson();
  if (P.view !== 'follow' || !p) { el.hidden = true; return; }
  el.hidden = false;
  const age = Math.floor(personAge(p));
  const doing = doingWords(p);
  /* What is in their arms, when the words for what they are doing have not
     already said it. It was "carrying 10", a number of food units nobody counts
     in; it is the things now, and said once. */
  /* And not at all while the basket at the bottom of the screen is showing:
     what is in it, and how much they have left, are said there already, and
     saying them twice is what crowded this line. The basket is hidden on a
     narrow screen, and there the caption still says both. */
  const hud = !(typeof innerWidth === 'number' && innerWidth <= 720);
  const carrying = !hud && p.haul > 0 && !doing.startsWith('bringing home')
    ? ` · with ${bagWords(p.bag) || 'food'}` : '';
  /* Sex, then how they are. Energy only shows once it is low enough to be
     changing what they can do — a readout that is always there is a readout
     nobody reads. */
  /* Energy out of ten, always, with the bar behind it. It decides what they can
     take on and how fast they move, so following somebody without it is watching
     them make decisions for reasons you cannot see — and at zero it is what
     kills them, which is worth being able to watch approach. */
  const ten = energyOutOfTen(p);
  const bars = Math.max(0, Math.min(5, Math.round(p.energy * 5)));
  const meter = '▮'.repeat(bars) + '▯'.repeat(5 - bars);
  const ill = p.sick ? ' · ill' : '';
  /* No ancestry on this card any more — not "daughter of Bresher", not "3rd of
     the Lohae line", and not the chain of fathers that ran under it.

     It was three ways of saying the same thing, it was on the card whether or
     not you were asking, and it is the half of the caption that does not change
     while you watch somebody: who their father was is settled before you start
     following them. What does change — what they are doing, what they are
     carrying, whether they are ill, how much they have left — is what the card
     is for.

     None of it is lost: a father, a line and a generation are still set on
     every person, still saved, and still written into the record every birth
     goes through, and the chronicle still says who was born to whom. It is off
     this caption, not out of the world. `ancestry()` has no caller in the page
     now — it reads that record and nothing displays it. */
  /* Named only when it is worth naming — most people are unremarkable and the
     card should say so by not saying anything. */
  const word = traitWord(p);
  /* What they are in the band, when the band is big enough and fed enough to
     have made them anything — see assignRoles. A camp of eight has no roles and
     says nothing, which is correct: everybody there does everything. */
  const post = p.role && p.role !== 'forager' ? ` · ${ROLE_WORDS[p.role] || p.role}` : '';
  el.textContent = `${who(p)}, ${age}${p.sex === 'f' ? '♀' : '♂'}${post}`
    + `${word ? ` · ${word}` : ''} · ${doing}${carrying}${ill}`;

  /* Where they are, read straight off the person rather than off anything
     drawn. That is the whole point of it: if these numbers are changing and the
     figure on screen is not, the simulation is fine and the rendering is not —
     and there is no way to tell those apart by watching.

     `gone` is how far they have actually travelled since the last time this was
     written, which is the question being asked. Speed is what they are trying
     to do; distance is what happened. */
  const alt = sampleHeight(p.x, p.z);
  const target = Math.hypot(p.targetX - p.x, p.targetZ - p.z);

  /* Two speeds, and the gap between them is the diagnosis. `want` is what they
     are trying to do; `going` is what actually happened to their coordinates
     since this line was last written. Somebody pressed against a hillside has a
     healthy want and a going of nothing.

     A rate rather than a raw distance, because the distance means nothing
     without the time it took — the first cut showed "moved 205.77m", which was
     a whole journey's worth accumulated since the last time anybody looked. */
  let going = '—';
  if (p.lastSeen) {
    const gap = worldClock - p.lastSeen[2];
    if (gap > 0.05 && gap < 20) {
      going = (Math.hypot(p.x - p.lastSeen[0], p.z - p.lastSeen[1]) / gap).toFixed(2);
    }
  }
  p.lastSeen = [p.x, p.z, worldClock];

  el.innerHTML = sexMarks(tribeChips(el.textContent))
    + (hud ? '' : ` <span class="meter${ten <= 2 ? ' low' : ''}" title="energy">${meter} ${ten}/10</span>`)
    + `<span class="where">`
    + `x ${p.x.toFixed(1)}  z ${p.z.toFixed(1)}  alt ${alt.toFixed(1)}m`
    + `  ·  want ${p.speed.toFixed(2)}  going ${going} m/s`
    + `  ·  ${target.toFixed(0)}m to go`
    + `</span>`;
}

export const keys = new Set();
/* -------------------------------------------------------------------------
   Bisect

   Six mechanisms have been measured and cleared and something is still
   flickering, so stop guessing which layer it is and let the eye that can
   actually see it do the search. B hides one more layer each press, in rough
   order of how likely each is to be the culprit. The press after the flicker
   stops names it. Shift+B puts everything back.

   Order matters: the cheap suspects first, and terrain last, because hiding the
   terrain hides everything standing on it and tells you nothing.
   ------------------------------------------------------------------------- */

export const BISECT = [
  ['shadows', null],
  ['grass', () => grassGroup],
  ['water', () => byName('water')],
  ['streams', () => byName('stream')],
  ['canopy', () => byName('canopy')],
  ['trunks', () => byName('trunks')],
  ['fruit', () => byName('fruit')],
  ['rocks', () => rockGroup],
  ['fauna', () => fauna],
  ['people and camps', () => tribeGroup],
  ['sky', () => sky],
  ['terrain', () => byName('terrain')],
];
export let bisectAt = 0;

/* Rebuilt objects are new objects, so the layers are looked up by name at the
   moment they are hidden rather than held onto. */
export function byName(name) {
  const found = [];
  world.traverse((o) => { if (o.name === name) found.push(o); });
  return found;
}

/* What each layer's own visible flag was before the search touched it. Some
   things are hidden for reasons of their own — the water when WATER=false, the
   procedural birds once the real models arrive — and forcing everything on
   would switch those back. Recording is exact where re-deriving was guesswork,
   and a Map keyed by the object survives a rebuild by simply not matching. */
export const bisectWas = new Map();

export function applyBisect() {
  for (const [o, v] of bisectWas) o.visible = v;
  bisectWas.clear();

  let shadows = false;
  for (let i = 0; i < bisectAt; i++) {
    const [, pick] = BISECT[i];
    if (!pick) { shadows = true; continue; }
    for (const o of [].concat(pick())) {
      if (!o) continue;
      if (!bisectWas.has(o)) bisectWas.set(o, o.visible);
      o.visible = false;
    }
  }
  applyShadowSettings();
  if (shadows) {
    renderer.shadowMap.enabled = false;
    sunLight.castShadow = false;
    world.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  }
}

export function stepBisect(back) {
  bisectAt = back ? 0 : Math.min(bisectAt + 1, BISECT.length);
  applyBisect();
  toast(bisectAt === 0
    ? 'everything back'
    : `hidden: ${BISECT.slice(0, bisectAt).map(([n]) => n).join(', ')}`, 3.5);
}

export const endDrag = (ev) => {
  cam.dragging = false;
  canvas.releasePointerCapture?.(ev.pointerId);
};

/* Keyboard, pointer and wheel. These used to run as the module loaded, which
   is what made the load order matter — and a module graph with cycles in it
   does not promise you a load order. main calls this once the page is up. */
export function wireInput() {
  addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
    // Minimised to its icon rather than gone — see togglePanel.
    if (ev.code === 'KeyH') togglePanel();
    /* M used to be a single toggle, so a map you wanted smaller rather than
       gone was a map you turned off. It walks the sizes now and "hidden" is the
       last of them, so the old gesture still gets there — it just takes the
       scenic route, and says where it got to. */
    if (ev.code === 'KeyM') toast(`map: ${stepMapSize(ev.shiftKey ? -1 : 1)}`);
    if (ev.code === 'Slash') toggleKeys();
    if (ev.code === 'Escape') { stopAhead(); showKeys(false); closeChronicle(); closeTribe(); }
    /* One key rather than two. It used to take C to cycle into Follow and then
       N to find somebody worth following, which is two keys to do one thing. */
    /* F is "show me somebody"; shift+F is "the one before that". F picks at
       random, so losing somebody you were watching is one keypress and, until
       there was a way back, irreversible — you could not ask for them again
       because you never chose them in the first place. Out of Follow it puts
       you back in, on the last person you were watching rather than a new
       stranger, which is the other half of the same want. */
    if (ev.code === 'KeyF') {
      if (ev.shiftKey) {
        if (P.view !== 'follow') setViewMode('follow');
        if (!followBack()) toast('nobody watched before this one');
      } else if (P.view !== 'follow') setViewMode('follow');
      else pickFollow();
    }
    /* And back to the view F left you in. The wheel sets how far back you stand
       and dragging sets the angle, and after a minute of both you are looking at
       the sky from forty metres with no way back short of finding somebody else
       to follow. */
    if (ev.code === 'KeyV') {
      if (shoulderView()) toast('over the shoulder');
      else toast('nobody to stand behind');
    }
    /* The same shape as F, for the other question. F is "show me somebody";
       this is "show me somewhere", and like F it puts you in the mode it needs
       rather than making you cycle to it first. */
    /* In Follow, Q lets go and E does whatever is in front of them. Both are
       read before `keys` sees them: in Orbit the same two keys are down and up,
       and letting go of somebody must not also lower the camera. Shift and W
       used to let go, which is now "run forward". */
    if (P.view === 'follow' && ev.code === 'KeyQ') {
      if (tooHeavyToSend(followedPerson())) return;
      if (!releaseLead()) toast('nobody is being led');
      return;
    }
    if (P.view === 'follow' && ev.code === 'KeyE') {
      const done = actHere();
      if (!done) toast('nothing to do here');
      return;
    }
    // G puts a handful down; shift+G all of it.
    if (P.view === 'follow' && ev.code === 'KeyG') {
      if (!dropHere(ev.shiftKey)) toast('nothing to drop');
      return;
    }
    // Z takes cover: up the tree they are at, or down where they stand.
    if (P.view === 'follow' && ev.code === 'KeyZ') {
      if (!takeCover()) toast('busy');
      return;
    }
    // X sits them down to rest, or up again; N has them eat.
    if (P.view === 'follow' && ev.code === 'KeyX') {
      if (!restHere()) toast('busy');
      return;
    }
    if (P.view === 'follow' && ev.code === 'KeyN') {
      if (!eatHere()) toast('busy');
      return;
    }
    if (ev.code === 'KeyR') {
      if (P.view !== 'orbit') setViewMode('orbit');
      pickRoam();
    }
    /* Whichever band you are already looking at: the one you are following, or
       the first if you are not following anybody. A row on the panel opens it
       too — this is for when the panel is shut, which is most of the time. */
    if (ev.code === 'KeyT') {
      if ($('tribe').hidden) {
        const p = followedPerson();
        openTribe(p ? camps.indexOf(p.camp) : 0);
      } else closeTribe();
    }
    if (ev.code === 'KeyL') { if ($('chron').hidden) openChronicle(); else closeChronicle(); }
    if (ev.code === 'KeyB') stepBisect(ev.shiftKey);
    if (ev.code === 'BracketLeft') setRate(rateIndex - 1);
    if (ev.code === 'BracketRight') setRate(rateIndex + 1);
    if (ev.code === 'KeyC') {
      setViewMode(VIEW_MODES[(VIEW_MODES.indexOf(P.view) + 1) % VIEW_MODES.length]);
      // Cycling blind through four modes is a guessing game; say which one.
      toast(VIEW_NAMES[P.view] || P.view);
    }
    keys.add(ev.code);
  });
  addEventListener('keyup', (ev) => keys.delete(ev.code));
  addEventListener('blur', () => { keys.clear(); cam.dragging = false; press.live = false; });

  /* A name on the band card is the other way of saying "that one" — and the
     better way when the person you want is asleep in a hut, or a hundred metres
     off behind a hill, and so is not on screen to be clicked. The card is what
     is covering the world, so choosing from it closes it.

     Bound to the box, not the rows: the rows are rewritten every time somebody
     is born, dies, falls ill or changes job. Only the living carry `data-p` —
     the "who is gone" tab is a list of people there is nothing to follow. */
  $('tribeList')?.addEventListener('click', (ev) => {
    /* A lineage button, a name inside a lineage, or back. Before the row's own
       click, because the button sits on a row that would otherwise follow them. */
    const lin = ev.target?.closest?.('[data-lin]');
    if (lin) {
      lineageShown = Number(lin.dataset.lin) || 0;
      lineageTab = tribeTab;
      renderTribeCard();
      return;
    }
    const row = ev.target?.closest?.('tr[data-p]');
    if (!row) return;
    if (followPersonById(Number(row.dataset.p))) closeTribe();
  });

  /* Look. In fly and walk the drag turns the camera directly; in orbit the same
     drag belongs to OrbitControls, which is listening on this canvas already. */
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    /* Recorded in every view, Orbit included: OrbitControls owns the drag there
       but not the click, and clicking somebody has to work in all four. */
    press.x = ev.clientX;
    press.y = ev.clientY;
    press.live = true;
    if (P.view === 'orbit') return;
    cam.dragging = true;
    cam.lastX = ev.clientX;
    cam.lastY = ev.clientY;
    canvas.setPointerCapture?.(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    /* A crosshair while you are behind somebody, because that is the one view
       where a click on the ground means something. Cheap: no raycast, just the
       mode. */
    canvas.style.cursor = P.view === 'follow' && followedPerson() ? 'crosshair' : '';
    if (!cam.dragging || P.view === 'orbit') return;
    /* Taking hold of the camera lets go of their shoulder. Anything else is a
       camera that fights you: you drag to look at the hill and it swings
       straight back. V puts you behind them again, which is what V is for.

       The wheel deliberately does not do this — how far back you stand is not
       an opinion about which way to look. */
    cam.astern = false;
    cam.yaw -= (ev.clientX - cam.lastX) * LOOK_SENSITIVITY;    // drag right, turn right
    cam.pitch -= (ev.clientY - cam.lastY) * LOOK_SENSITIVITY;  // drag down, look down
    cam.pitch = clamp(cam.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    cam.lastX = ev.clientX;
    cam.lastY = ev.clientY;
  });
  canvas.addEventListener('pointerup', (ev) => {
    /* A press that did not travel is a click. Anything further was a look
       around, and looking round at the ground must not also send anybody to it. */
    if (press.live && ev.button === 0
      && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) <= CLICK_SLOP_PX
      && P.view === 'follow') {
      const spot = pickGroundAt(ev.clientX, ev.clientY);
      const p = spot && followedPerson();
      if (p && leadTo(spot.x, spot.z)) {
        const away = Math.round(Math.hypot(spot.x - p.x, spot.z - p.z));
        toast(`${p.name} sets off · ${away}m`);
      }
    }
    press.live = false;
    endDrag(ev);
  });
  canvas.addEventListener('pointercancel', (ev) => { press.live = false; endDrag(ev); });

  /* There is no move speed to adjust any more — one speed, set by how long a day
     takes, and shift for a sprint. In Follow the wheel still sets how far back you
     stand, and in Orbit the controls own it. */
  canvas.addEventListener('wheel', (ev) => {
    if (P.view === 'orbit') return;                 // OrbitControls owns the wheel
    ev.preventDefault();
    if (P.view === 'follow') {
      P.followDist = clamp(P.followDist * (ev.deltaY < 0 ? 1.12 : 1 / 1.12), 1.4, 40);
    }
  }, { passive: false });
}


/* Metres a second at an hour-long day; the pace multiplier in the tick does the
   rest, so a shorter day moves the camera as fast as it moves everything else. */
export const CAMERA_FLY = 26;

export const _fwd = new THREE.Vector3();
export const _right = new THREE.Vector3();
export const _move = new THREE.Vector3();
export const UP = new THREE.Vector3(0, 1, 0);

// Read yaw and pitch back off the camera, so switching modes never snaps the view.
export function syncLookFromCamera() {
  camera.getWorldDirection(_fwd);
  cam.pitch = clamp(Math.asin(clamp(_fwd.y, -1, 1)), -PITCH_LIMIT, PITCH_LIMIT);
  cam.yaw = Math.atan2(-_fwd.x, -_fwd.z);
}

export function setViewMode(mode) {
  /* Leaving Follow lets go of anybody being led. Any road out counts — the map,
     C, R — because a person still walking to a point you cannot see any more is
     a person with nothing steering them and no way to stop them. */
  if (mode !== 'follow') releaseLead(false);
  P.view = mode;
  if (mode === 'orbit') {
    // Give the orbit something to orbit: a point out in front of where you are
    // already looking, so the switch does not spin the world.
    camera.getWorldDirection(_fwd);
    controls.target.copy(camera.position).addScaledVector(_fwd, 25);
    controls.enabled = true;
    controls.update();
  } else {
    controls.enabled = false;
    if (mode === 'follow') pickFollow(false);
    else syncLookFromCamera();
  }
  const label = $('keysView');
  if (label) label.textContent = VIEW_NAMES[mode] || mode;
  updateFollowCaption();
}

/* Two ways to watch, and they are the two questions anybody actually has:
   where is this, and who is that. Orbit is a rig you point at a place; Follow is
   a person you go with.

   Fly and Walk are gone. They were a free camera with WASD and a free camera
   with WASD pinned to eye height, and what they were for — getting somewhere to
   look at it — is what clicking the map does, in one gesture and without flying
   across an island in real time. Everything they cost was real: two branches in
   every camera path, a movement block that only they used, W and S bound to
   moving the camera in the two modes where W and S also mean things to the
   person you are steering, and a `travelTo` that had to ask which of four rigs
   it was landing.

   What is left is the pair that read the world rather than fly over it. */
/* The two overlays are drawn from here because this is the one thing that runs
   every frame in every view — and the comment is above the signature rather
   than inside it because two checks require `updateLeadMark()` to be the first
   line of this function. They are right to: trimming the view modes out dropped
   that call, which took the ring off the ground somebody had been told to walk
   to, and nothing else in the page would have noticed. */
export function moveCamera(dt) {
  updateLeadMark();
  updateOrders();
  steerFollowed();
  updateActPrompt();
  updateStoreRing();
  keepFocus();
  updateActionRings(P.view === 'follow' ? followedPerson() : null);
  return P.view === 'follow' ? moveFollow(dt) : moveOrbit(dt);
}

/* Over the shoulder of one person. The rig orbits their head rather than a
   point on the ground, so they stay in frame while they walk, forage and sleep,
   and the camera is eased toward where it wants to be so a turn of their head
   does not snap the view. */
export function moveFollow(dt) {
  let p = followedPerson();
  if (!p) { pickFollow(false); p = followedPerson(); }
  /* Somebody asleep is hidden inside a hut, so following them is following an
     empty patch of ground — which looks exactly like the mode being broken.
     Hand over to somebody who is up, unless the whole camp is asleep, in which
     case the caption says so and the camera keeps its vigil over the hut.

     Not if you asked for this one. `F` offers you somebody and the handover is
     it offering you somebody better; picking a name off the band card is you
     saying which, and quietly swapping the person out from under that is the
     same bug the handover exists to fix, pointed the other way — you chose the
     one who is asleep, most likely because they were the one who was asleep.
     The caption says "asleep in a hut" and they get up in the morning. */
  if (p && !followChosen && p.asleep && people.some((o) => !o.asleep)) {
    pickFollow(false);
    p = followedPerson();
  }
  if (!p) return moveOrbit(dt);

  /* Keep station. Toward their heading by the shortest way round, or a person
     turning from just west of north to just east of it sends the camera the
     long way round the compass — the one place a bearing has a seam in it. */
  /* Not while you are walking them with the keys: W is "the way the camera
     looks", and a camera that swings round behind them as they turn makes S a
     walk toward the camera that turns them round, which turns the camera, which
     turns them round again. Drag to turn instead. */
  if (cam.astern && !steering) {
    let off = p.yaw - cam.yaw;
    off = Math.atan2(Math.sin(off), Math.cos(off));
    cam.yaw += off * Math.min(1, dt * ASTERN_EASE);
  }

  const ground = sampleHeight(p.x, p.z);
  const eye = ground + PERSON.legLen * p.scale * (1 - 0.44 * p.crouch) + 1.15 * p.scale + (p.lift || 0);
  _follow.set(p.x, eye, p.z);

  const d = P.followDist;
  _want.set(
    _follow.x - Math.sin(cam.yaw) * Math.cos(cam.pitch) * d,
    _follow.y - Math.sin(cam.pitch) * d + 0.35,
    _follow.z - Math.cos(cam.yaw) * Math.cos(cam.pitch) * d,
  );
  // Never inside the hill they are standing on.
  _want.y = Math.max(_want.y, sampleHeight(_want.x, _want.z) + 0.5);

  camera.position.lerp(_want, Math.min(1, dt * 6));
  camera.lookAt(_follow.x, _follow.y, _follow.z);
}

/* The original rig, kept as a mode: WASD slides the whole orbit assembly across
   the ground so you can walk out of the meadow without losing the pivot. */
export function moveOrbit(dt) {
  camera.getWorldDirection(_fwd);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
  _fwd.normalize();
  _right.crossVectors(_fwd, UP).normalize();

  _move.set(0, 0, 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) _move.add(_fwd);
  if (keys.has('KeyS') || keys.has('ArrowDown')) _move.sub(_fwd);
  if (keys.has('KeyD') || keys.has('ArrowRight')) _move.add(_right);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) _move.sub(_right);
  if (keys.has('KeyE')) _move.y += 1;
  if (keys.has('KeyQ')) _move.y -= 1;

  if (_move.lengthSq() > 0) {
    const speed = CAMERA_FLY * (keys.has('ShiftLeft') ? 3.6 : 1) * dt;
    _move.normalize().multiplyScalar(speed);
    camera.position.add(_move);
    controls.target.add(_move);
  }

  // Stay above the ground. Moving the target by the same amount keeps the look
  // direction: the camera rises over a hill instead of tipping into it.
  const ground = sampleHeight(camera.position.x, camera.position.z);
  const dy = Math.max(camera.position.y, ground + 2.2) - camera.position.y;
  if (dy !== 0) {
    camera.position.y += dy;
    controls.target.y += dy;
  }
}

/* Shadows only cover a slice of a 1600-unit map, so the slice follows the
   camera — snapped to the shadow map's own texel grid, or its edges crawl as
   you walk. */
export const _focus = new THREE.Vector3();
export const _focusLS = new THREE.Vector3();
export const _lightRot = new THREE.Matrix4();
export const _lightRotInv = new THREE.Matrix4();
export const _ORIGIN = new THREE.Vector3();
export function updateShadowFocus() {
  if (!sunLight.castShadow) return;
  const cam = sunLight.shadow.camera;
  const texel = (cam.right - cam.left) / sunLight.shadow.mapSize.x;

  _focus.set(
    camera.position.x,
    sampleHeight(camera.position.x, camera.position.z),
    camera.position.z,
  );

  /* Rounding to whole world units, which is what this used to do, is not a
     snap: the texel grid lives in the light's frame, and the light turns all
     day, so a world-space round lands on a different fraction of a texel every
     time the sun moves. Rotate into the light's frame, snap on the grid that
     is actually there, rotate back. The rotation depends only on the sun's
     direction, so there is nothing circular about deriving it here — and it is
     built the same way three builds the shadow camera's, from the same up
     vector, or the two grids would not line up. */
  _lightRot.lookAt(sunDir, _ORIGIN, sunLight.up);
  _lightRotInv.copy(_lightRot).transpose();     // a pure rotation
  _focusLS.copy(_focus).applyMatrix4(_lightRotInv);
  _focusLS.x = Math.round(_focusLS.x / texel) * texel;
  _focusLS.y = Math.round(_focusLS.y / texel) * texel;
  _focus.copy(_focusLS).applyMatrix4(_lightRot);

  sunLight.target.position.copy(_focus);
  sunLight.position.copy(_focus).addScaledVector(sunDir, 400);
  // Below the horizon the sun's intensity is already zero, so the map it draws
  // costs a pass and changes nothing — skip it and let the moon light the night.
  sunLight.shadow.autoUpdate = sunDir.y > 0;
}

/* chronPage lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setChronPage(v) { chronPage = v; }

/* chronFind lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setChronFind(v) { chronFind = v; }

/* tribeTab lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setTribeTab(v) { tribeTab = v; }

/* followIdx lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setFollowIdx(v) { followIdx = v; }
