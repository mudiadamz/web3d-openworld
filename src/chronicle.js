import * as THREE from 'three';

import { P, SEA, WORLD } from './params.js';
import { clamp, flatnessAt, sampleHeight } from './noise.js';
import { camera, canvas, controls, renderer, scene, sky, sunDir, sunLight } from './scene.js';
import { fauna, grassGroup, rockGroup, world } from './world.js';
import { ancestry, lineage, pick } from './wildlife.js';
import { PERSON, rateIndex, worldClock } from './clock.js';
import { camps, people, tribeGroup } from './people.js';
import {
  SKILLS, SKILL_RUNGS, TOLL_WORDS, chiefOf, childrenOf, chronicle, daysOfFood, energyOutOfTen, isMilestone, milestonesOnly, ordinal, personAge, skillTier,
  runId, tollOf, traitWord, who
} from './life.js';
import { VIEW_MODES, applyShadowSettings } from './move.js';
import { $, ui } from './save.js';
import { stepMapSize } from './map.js';
import { VIEW_NAMES, codeChip, setRate, sexMarks, toast, tribeChips } from './ui.js';
import { stopAhead } from './main.js';

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
  for (const r of lineage) {
    if (r.d > 0 && (r.dc || r.c) === camp.code) {
      out.push({ r, when: r.d, gone: 'died', how: DEATH_TOLD[r.x] || r.x || 'nobody knows what of' });
    } else if (r.to && r.fr === camp.code) {
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
    + `<th>day</th></tr></thead><tbody>`
    + gone.map(({ r, when, gone: how, how: why }) => {
      const years = Math.max(0, (when - r.b) / P.yearLength);
      return `<tr class="${how === 'left' ? '' : 'gone'}">`
        + `<td class="n">${r.n}</td>`
        + `<td>${Math.floor(years)}${sexMarks(r.s === 'f' ? '♀' : '♂')}</td>`
        + `<td class="n">${why}</td>`
        + `<td>${Math.floor(when)}</td></tr>`;
    }).join('')
    + '</tbody></table>';
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

  /* Everything the panel row used to carry, now that the row carries a name
     and a number. A list you scan and a card you read are different jobs, and
     this is the one with room to do the second. */
  let women = 0, men = 0, kids = 0, ill = 0;
  for (const p of folk) {
    if (p.sex === 'f') women++; else men++;
    if (p.child) kids++;
    if (p.sick) ill++;
  }
  /* A row each, rather than three anonymous bars. The bars said a band knew
     *something*; which of the three, and how much, was a thing you could only
     get at by hovering — and the whole reason skills are interesting is
     watching one of them climb while the others do not. */
  const skills = Object.keys(SKILLS).map((k) => {
    const v = camp.skill[k] || 0;
    const pct = Math.round(v * 100);
    return `<div class="skillRow"><span>${SKILLS[k].of}</span>`
      + `<i class="sk" style="--v:${pct}%"></i>`
      + `<b>${pct}%</b><em>${SKILL_RUNGS[skillTier(v)]}</em></div>`;
  }).join('');

  $('tribeHead').innerHTML =
    `<div>Chief <b>${chief ? chief.name : 'nobody'}</b>`
    + `${chief ? ` <span>${Math.floor(personAge(chief))}${sexMarks(chief.sex === 'f' ? '♀' : '♂')}</span>` : ''}</div>`
    + `<div><b>${folk.length}</b> <span>here</span>`
    + `${folk.length ? ` · ${sexMarks(`${women}♀ ${men}♂`)}` : ''}`
    + `${kids ? ` · ${kids} ${kids === 1 ? 'child' : 'children'}` : ''}`
    + `${ill ? ` · <em class="ill">${ill} ill</em>` : ''}</div>`
    + `<div><span>store</span> ${camp.food.toFixed(1)} `
    + `<span>(${daysOfFood(camp).toFixed(1)} days)</span> · `
    + `<span>carried home between them</span> ${brought.toFixed(0)}</div>`
    + `<div class="skills">${skills}</div>`
    + `<div><span>founded day ${Math.floor(camp.founded)} · ${camp.born} born · `
    + `most they were was ${camp.peak}${toll.length
        ? ` · lost ${toll.reduce((n, [, k]) => n + k, 0)}: `
          + toll.map(([k, n]) => `${n} ${TOLL_WORDS[k]}`).join(', ') : ''}</span></div>`;

  $('tribeNow').className = tribeTab === 'now' ? 'on' : '';
  $('tribeWas').className = tribeTab === 'was' ? 'on' : '';
  if (tribeTab === 'was') { $('tribeList').innerHTML = formerTable(camp); return; }

  /* Sorted oldest first, because a band reads as a band that way: the elders
     who remember how things are done, then the ones doing them, then the
     children who will. */
  $('tribeList').innerHTML = folk.length
    ? `<table><thead><tr><th>who</th><th>age</th><th>children</th><th>carried</th><th>doing</th></tr></thead><tbody>`
      + folk.map((p) => {
        const kids = childrenOf(p);
        return `<tr class="${p === chief ? 'chief' : ''}${p.sick ? ' gone' : ''}"`
          + ` data-p="${p.id}" title="follow ${p.name}">`
          + `<td class="n">${p.name}</td>`
          + `<td>${Math.floor(personAge(p))}${sexMarks(p.sex === 'f' ? '♀' : '♂')}${p.child ? ' ·' : ''}</td>`
          + `<td>${kids || (p.child ? '' : '—')}</td>`
          + `<td class="got">${(p.brought || 0).toFixed(0)}</td>`
          + `<td class="n">${p.sick ? 'ill' : doingWords(p)}</td></tr>`;
      }).join('')
      + '</tbody></table>'
    : '<div>nobody is left</div>';
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

export const cam = { yaw: 0, pitch: 0, dragging: false, lastX: 0, lastY: 0 };

/* Where the button went down, in every view. A click and a look-around begin
   identically and stay indistinguishable until the button comes up again. */
export const press = { x: 0, y: 0, live: false };

/* Following one person. The whole reason the band exists is to be watched, and
   watching it from a hundred metres up is not the same as walking a day with
   somebody. */
export let followIdx = -1;
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
  const pool = [];
  for (let i = 0; i < people.length; i++) if (!people[i].hidden) pool.push(i);
  if (!pool.length) for (let i = 0; i < people.length; i++) if (!people[i].asleep) pool.push(i);
  if (!pool.length) for (let i = 0; i < people.length; i++) pool.push(i);
  followIdx = pool[(Math.random() * pool.length) | 0];
  followChosen = false;
  const p = people[followIdx];
  /* Behind them, not in front. The camera sits at `target − forward × distance`,
     so adding π here put it out ahead walking backwards, staring at their face. */
  cam.yaw = p.yaw;
  cam.pitch = -0.12;
  if (announce) updateFollowCaption();
}

/* Follow this exact person. F finds you somebody, which is the right answer
   when you have nobody in mind and the wrong one the moment you do — usually
   you are already watching one of them carry something home. */
export function followPerson(idx, announce = true) {
  if (idx < 0 || idx >= people.length) return false;
  /* Entering Follow picks somebody at random on the way in, so the choice has
     to be made after the switch rather than before it. */
  if (P.view !== 'follow') setViewMode('follow');
  followIdx = idx;
  followChosen = true;
  const p = people[idx];
  cam.yaw = p.yaw;                 // behind them, the way pickFollow leaves it
  cam.pitch = -0.12;
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

/** Hands them back to themselves, wherever they happen to be standing. */
export function releaseLead(announce = true) {
  const p = followedPerson();
  if (!p || !p.led) return false;
  p.led = false;
  p.state = 'idle';
  p.timer = 0;                     // pick something to do on the next step
  p.speed = 0;
  if (announce) toast(`${p.name} goes back to it`);
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
export const ORDERS = ['gather', 'hunt', 'craft', 'tend', 'sleep', 'visit'];

export function orderJob(job) {
  const p = followedPerson();
  if (!p || !ORDERS.includes(job)) return false;
  /* An order is not a leash, and holding both would be two things steering one
     person. Being told to go hunting ends being walked about by hand. */
  if (p.led) releaseLead(false);
  p.orders = job;
  p.state = 'idle';
  p.timer = 0;                     // taken up on their next turn
  toast(`${p.name}: ${JOB_WORDS[job] || job}`);
  updateFollowCaption();
  return true;
}

/** Shows the row while you are behind somebody, and marks what they are at. */
export function updateOrders() {
  const box = $('orders');
  if (!box) return;
  const p = P.view === 'follow' ? followedPerson() : null;
  if (box.hidden !== !p) box.hidden = !p;
  if (!p) return;
  for (const b of box.children) {
    const mine = b.dataset && b.dataset.order === (p.orders || p.job);
    if (b.classList.contains('on') !== !!mine) b.classList.toggle('on', !!mine);
  }
}

/** True while the run key is down. Walking there is automatic; this is the
    extra — and the energy clamp downstream charges for it, so a band you run
    everywhere arrives tired and hunts worse. */
export function leadRunning() { return keys.has('KeyW'); }

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
  if (!p || !p.led) { if (leadMark) leadMark.visible = false; return; }
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

export const JOB_WORDS = {
  gather: 'foraging', hunt: 'hunting', craft: 'knapping',
  tend: 'at the fire', play: 'playing', sleep: 'asleep',
  nurse: 'sitting with the ill',
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
export function doingWords(p) {
  if (p.asleep) return 'asleep in a hut';
  if (p.hidden) return INDOOR_WORDS[p.job] || 'resting';
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
  /* A tenth of a unit of berries is still something in their arms; rounded to
     nothing it read "carrying 0", which says the opposite of what is true. */
  const carrying = p.haul > 0
    ? ` · carrying ${p.haul < 10 ? p.haul.toFixed(1) : p.haul.toFixed(0)}` : '';
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
  /* Through the father. A line of one is a founder, and saying "1st of the
     Beku line" of the man the line is named after reads as a mistake — so the
     founders are simply named as founders. */
  const born = p.fatherName ? ` · ${p.sex === 'f' ? 'daughter' : 'son'} of ${p.fatherName}` : '';
  /* The line, and then the line itself. A generation number says how deep they
     are; the fathers say who they are — and the whole reason for keeping the
     dead is being able to name them years after they are gone. */
  const fathers = ancestry(p, 4);
  const chain = fathers.length
    ? ` <span class="line">${p.name} ${fathers.map((r) => `← ${r.n}`).join(' ')}`
      + `${fathers.length === 4 && fathers[3].f ? ' ←…' : ''}</span>`
    : '';
  /* Said only when there is a line to say. "Of the founding band" was on
     every first-generation person in the world, which at the start is all of
     them — a phrase that is on everybody tells you nothing about anybody. */
  const house = (p.gen || 1) > 1 ? ` · ${ordinal(p.gen)} of the ${p.line} line` : '';
  /* Named only when it is worth naming — most people are unremarkable and the
     card should say so by not saying anything. */
  const word = traitWord(p);
  el.textContent = `${who(p)}, ${age}${p.sex === 'f' ? '♀' : '♂'}${born}${house}`
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
    + ` <span class="meter${ten <= 2 ? ' low' : ''}" title="energy">${meter} ${ten}/10</span>`
    + chain
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
    if (ev.code === 'KeyH') ui.classList.toggle('hidden');
    /* M used to be a single toggle, so a map you wanted smaller rather than
       gone was a map you turned off. It walks the sizes now and "hidden" is the
       last of them, so the old gesture still gets there — it just takes the
       scenic route, and says where it got to. */
    if (ev.code === 'KeyM') toast(`map: ${stepMapSize(ev.shiftKey ? -1 : 1)}`);
    if (ev.code === 'Slash') toggleKeys();
    if (ev.code === 'Escape') { stopAhead(); showKeys(false); closeChronicle(); closeTribe(); }
    /* One key rather than two. It used to take C to cycle into Follow and then
       N to find somebody worth following, which is two keys to do one thing. */
    if (ev.code === 'KeyF') {
      if (P.view !== 'follow') setViewMode('follow');
      else pickFollow();
    }
    /* The same shape as F, for the other question. F is "show me somebody";
       this is "show me somewhere", and like F it puts you in the mode it needs
       rather than making you cycle to it first. */
    /* Shift and W together, before `keys` sees the W — otherwise letting go
       of somebody also tells them to walk on the way out. */
    if (ev.code === 'KeyW' && ev.shiftKey && P.view === 'follow') {
      if (!releaseLead()) toast('nobody is being led');
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
export const CAMERA_WALK = 12;

export const _fwd = new THREE.Vector3();
export const _right = new THREE.Vector3();
export const _move = new THREE.Vector3();
export const _lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
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

export function moveCamera(dt) {
  updateLeadMark();
  updateOrders();
  if (P.view === 'orbit') return moveOrbit(dt);
  if (P.view === 'follow') return moveFollow(dt);

  _lookEuler.set(cam.pitch, cam.yaw, 0);
  camera.quaternion.setFromEuler(_lookEuler);

  camera.getWorldDirection(_fwd);
  if (P.view === 'walk') {
    _fwd.y = 0;                                   // feet on the ground, always
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
  }
  _right.crossVectors(_fwd, UP);
  if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);   // looking straight up or down
  _right.normalize();

  _move.set(0, 0, 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) _move.add(_fwd);
  if (keys.has('KeyS') || keys.has('ArrowDown')) _move.sub(_fwd);
  if (keys.has('KeyD') || keys.has('ArrowRight')) _move.add(_right);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) _move.sub(_right);
  if (P.view === 'fly') {
    if (keys.has('KeyE') || keys.has('Space')) _move.y += 1;
    if (keys.has('KeyQ') || keys.has('ShiftRight')) _move.y -= 1;
  }

  if (_move.lengthSq() > 0) {
    const fast = keys.has('ShiftLeft') ? 3.6 : 1;
    const speed = (P.view === 'walk' ? CAMERA_WALK : CAMERA_FLY) * fast;
    camera.position.addScaledVector(_move.normalize(), speed * dt);
  }

  const ground = sampleHeight(camera.position.x, camera.position.z);
  if (P.view === 'walk') {
    camera.position.y = ground + 1.7;             // eye height, not negotiable
  } else if (camera.position.y < ground + 0.4) {
    // The only limit on the fly camera: do not end up inside the hill. Nothing
    // else moves, so this cannot ratchet the view upward the way the old rig did.
    camera.position.y = ground + 0.4;
  }
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

  const ground = sampleHeight(p.x, p.z);
  const eye = ground + PERSON.legLen * p.scale * (1 - 0.44 * p.crouch) + 1.15 * p.scale;
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
