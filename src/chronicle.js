import * as THREE from 'three';

import { P } from './params.js';
import { clamp, sampleHeight } from './noise.js';
import { camera, canvas, controls, renderer, sky, sunDir, sunLight } from './scene.js';
import { fauna, grassGroup, rockGroup, world } from './world.js';
import { ancestry, lineage, pick } from './wildlife.js';
import { PERSON, rateIndex, worldClock } from './clock.js';
import { camps, people, tribeGroup } from './people.js';
import {
  chiefOf, childrenOf, chronicle, daysOfFood, energyOutOfTen, ordinal, personAge, runId, tollOf, traitWord, who
} from './life.js';
import { VIEW_MODES, applyShadowSettings } from './move.js';
import { $, ui } from './save.js';
import { VIEW_NAMES, codeChip, setRate, toast, tribeChips } from './ui.js';
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
  return needle ? chronRows.filter((e) => chronMatch(e, needle)) : chronRows;
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

  $('chronWhere').textContent = rows.length
    ? `${from + 1}–${Math.min(from + CHRON_PAGE, rows.length)} of ${rows.length}`
      + (needle ? ` matching · ${chronRows.length} in all` : '')
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
        + `<td>${Math.floor(years)}${r.s === 'f' ? '♀' : '♂'}</td>`
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

  $('tribeHead').innerHTML =
    `<div>Chief <b>${chief ? chief.name : 'nobody'}</b>`
    + `${chief ? ` <span>${Math.floor(personAge(chief))}${chief.sex === 'f' ? '♀' : '♂'}</span>` : ''}</div>`
    + `<div><span>store</span> ${camp.food.toFixed(1)} `
    + `<span>(${daysOfFood(camp).toFixed(1)} days)</span> · `
    + `<span>carried home between them</span> ${brought.toFixed(0)}</div>`
    + `<div><span>founded day ${Math.floor(camp.founded)} · ${camp.born} born · `
    + `most they were was ${camp.peak}${toll.length
        ? ` · lost ${toll.reduce((n, [, k]) => n + k, 0)}` : ''}</span></div>`;

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
        return `<tr class="${p === chief ? 'chief' : ''}${p.sick ? ' gone' : ''}">`
          + `<td class="n">${p.name}</td>`
          + `<td>${Math.floor(personAge(p))}${p.sex === 'f' ? '♀' : '♂'}${p.child ? ' ·' : ''}</td>`
          + `<td>${kids || (p.child ? '' : '—')}</td>`
          + `<td class="got">${(p.brought || 0).toFixed(0)}</td>`
          + `<td class="n">${p.sick ? 'ill' : (JOB_WORDS[p.job] || p.job)}</td></tr>`;
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

/* Following one person. The whole reason the band exists is to be watched, and
   watching it from a hundred metres up is not the same as walking a day with
   somebody. */
export let followIdx = -1;
export const _follow = new THREE.Vector3();
export const _want = new THREE.Vector3();

export function pickFollow(announce = true) {
  if (!people.length) { followIdx = -1; return; }
  // Prefer somebody awake and out doing something; fall back to anyone.
  const awake = people.map((p, i) => i).filter((i) => !people[i].asleep);
  const pool = awake.length ? awake : people.map((_, i) => i);
  followIdx = pool[(Math.random() * pool.length) | 0];
  const p = people[followIdx];
  /* Behind them, not in front. The camera sits at `target − forward × distance`,
     so adding π here put it out ahead walking backwards, staring at their face. */
  cam.yaw = p.yaw;
  cam.pitch = -0.12;
  if (announce) updateFollowCaption();
}

export function followedPerson() {
  if (followIdx < 0 || followIdx >= people.length) return null;
  return people[followIdx];
}

export const JOB_WORDS = {
  gather: 'foraging', hunt: 'hunting', craft: 'knapping',
  tend: 'at the fire', play: 'playing', sleep: 'asleep',
  nurse: 'sitting with the ill',
  visit: 'walking to the next band',
};

export function updateFollowCaption() {
  const el = $('following');
  if (!el) return;
  const p = followedPerson();
  if (P.view !== 'follow' || !p) { el.hidden = true; return; }
  el.hidden = false;
  const age = Math.floor(personAge(p));
  const doing = p.asleep ? 'asleep in a hut' : JOB_WORDS[p.job] || p.job;
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
  const house = (p.gen || 1) > 1
    ? ` · ${ordinal(p.gen)} of the ${p.line} line`
    : ` · of the founding band`;
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

  el.innerHTML = tribeChips(el.textContent)
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
    if (ev.code === 'KeyM') $('map').hidden = !$('map').hidden;
    if (ev.code === 'Slash') toggleKeys();
    if (ev.code === 'Escape') { stopAhead(); showKeys(false); closeChronicle(); closeTribe(); }
    /* One key rather than two. It used to take C to cycle into Follow and then
       N to find somebody worth following, which is two keys to do one thing. */
    if (ev.code === 'KeyF') {
      if (P.view !== 'follow') setViewMode('follow');
      else pickFollow();
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
  addEventListener('blur', () => { keys.clear(); cam.dragging = false; });

  /* Look. In fly and walk the drag turns the camera directly; in orbit the same
     drag belongs to OrbitControls, which is listening on this canvas already. */
  canvas.addEventListener('pointerdown', (ev) => {
    if (P.view === 'orbit' || ev.button !== 0) return;
    cam.dragging = true;
    cam.lastX = ev.clientX;
    cam.lastY = ev.clientY;
    canvas.setPointerCapture?.(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!cam.dragging || P.view === 'orbit') return;
    cam.yaw -= (ev.clientX - cam.lastX) * LOOK_SENSITIVITY;    // drag right, turn right
    cam.pitch -= (ev.clientY - cam.lastY) * LOOK_SENSITIVITY;  // drag down, look down
    cam.pitch = clamp(cam.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    cam.lastX = ev.clientX;
    cam.lastY = ev.clientY;
  });
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

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
     case the caption says so and the camera keeps its vigil over the hut. */
  if (p && p.asleep && people.some((o) => !o.asleep)) {
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
