import * as THREE from 'three';

import { P } from './params.js';
import { clamp, smoothstep } from './noise.js';
import {
  camera, controls, renderer, scene, seasonName, sunDir, updateSeason, updateSunDirection,
  updateTimeOfDay, windUniforms
} from './scene.js';
import {
  drainDirtyTiles, stats, updateGrassDetail, updateTiles, wireWorld
} from './world.js';
import { loadModels, recountAnimals, updateAnimals } from './wildlife.js';
import { FF_STEP, PACE_MAX_STEP, clockRate, ffStep, pace, rateIndex, setDrawingWorld, setWorldClock, tickWorldStep, worldClock } from './clock.js';
import { camps, paintPeople, people } from './people.js';
import {
  bornCount, chronicle, diedCount, drawTribeChart, loadChronicle, logEvent, onNewDay, personAge, regrowFruit, renderChronicle, renderTribes, repopulate, setSimDay, simDay, startRun, updateEconomy, updateGround, updateLives
} from './life.js';
import { buildWorld, placeCamera, recountBlades, updateCamps, updatePeople } from './move.js';
import {
  moveCamera, setViewMode, updateFollowCaption, updateShadowFocus, wireInput
} from './chronicle.js';
import {
  $, SAVE_EVERY, applySavedLife, applySavedWorld, nextSave, persistState, readSavedState,
  setNextSave, ui
} from './save.js';
import { updateAudio } from './audio.js';
import { drawMap } from './map.js';
import {
  codeChip, ensureCurrentWorld, hhmm, setRate, syncLabels, toast, tribeChips, updateToast
} from './ui.js';

/* -------------------------------------------------------------------------
   Loop
   ------------------------------------------------------------------------- */

export let frames = 0, fpsTime = 0;
export function updateHud() {
  const born = people.length
    ? `<br>${bornCount} born · ${diedCount} died · oldest ${Math.floor(
        people.reduce((m, p) => Math.max(m, personAge(p)), 0))}`
    : '';
  $('stats').innerHTML =
    `<b id="fps">–</b> fps · ${(stats.blades / 1000).toFixed(1)}k blades`
    + `<br>${stats.trees} trees · ${stats.fruit} fruit · ${stats.rocks} rocks`
    + `<br>${stats.animals} animals · ${stats.people} people · ${camps.length} camps`
    + (stats.graves ? ` · ${stats.graves} buried` : '')
    + (stats.models ? ` · ${stats.models} models, ${stats.modelled} drawn` : '')
    + born;
}

export function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
}
addEventListener('resize', onResize);

export const clock = new THREE.Clock();

export let elapsed = 0;
export let lastClock = '';
export let lastCaption = 0;

/* -------------------------------------------------------------------------
   Running the world on without drawing it

   The clock already goes to sixteen times, and sixteen times is nothing: a year
   is twenty-four days of an hour each, so watching a decade at 16× is fifteen
   hours of sitting there. What is wanted is to skip the watching entirely —
   name a number of years, let the simulation run flat out with nothing rendered,
   and be shown the world it arrives at.

   It cannot be faked. The food in a store is not a rate; it is what people
   actually carried home, one foraging trip at a time, and a band's skills are
   what its people actually practised. So this runs the real simulation — the
   same functions, in the same order — with everything that only exists to be
   looked at left out: no camera, no grass tiles, no shadows, no map, no sound.
   ------------------------------------------------------------------------- */

/* An eighth of a simulated day. Fine enough that nothing anybody watches is
   decided on a coarser grain than they can see, coarse enough that the books
   are kept eight times a day instead of seven thousand. */
export const BOOK_EVERY = 1 / 8;
let bookDue = 0;

export function stepWorld(dt) {
  setDrawingWorld(false);
  // Whose turn it is comes off this, so it has to move exactly once a step.
  tickWorldStep();
  setWorldClock(worldClock + dt);
  const wasHour = P.time;
  P.time = (P.time + (dt * 24) / P.dayLength) % 24;
  if (P.time < wasHour) { setSimDay(simDay + 1); onNewDay(); }

  const paced = Math.min(dt * pace(), FF_STEP);
  const simDays = dt / P.dayLength;
  /* The sun has to move, and not for the look of it: who is awake, who is out,
     whether the herds can see anybody coming and whether the night is being
     skipped all read the sun's height. Only its direction is wanted, though —
     the sky's turbidity and the colour of the fog are for looking at. */
  updateSunDirection(P.time);
  updateAnimals(paced, 0);
  updateSeason();
  /* The books, kept eight times a day rather than seven thousand.

     These five walk every person and every camp and integrate a rate over the
     days that have passed — eating, ageing, falling ill, being born, dying, the
     store spoiling. They were called on every step, which at half a second a
     step is 7,200 times a simulated day, each time handed a `days` of 0.00014.
     The result was the same as calling them eight times with a `days` of 0.125
     and cost nine hundred times as much: at two hundred people it was most of
     the run, and it was the wall that a world of thousands hit.

     Eight times a day is still finer than anything they decide. Nobody starves
     between breakfast and lunch on a resolution this coarse, and a birth landing
     three hours late is a birth nobody can see the timing of. */
  bookDue += simDays;
  if (bookDue >= BOOK_EVERY) {
    const owed = bookDue;
    bookDue = 0;
    regrowFruit(owed);
    updateEconomy(owed);
    updateGround(owed);
    updateLives(owed);
    repopulate(owed);
  }
  updatePeople(paced, smoothstep(-0.10, 0.14, sunDir.y));
  setDrawingWorld(true);
}

/* -------------------------------------------------------------------------
   Seeing ahead

   Name a number of years and the world runs on without being drawn. Measured
   on this machine: about seven seconds of real time to a simulated year, so a
   decade is a minute or so — which is why there is a progress bar rather than
   a frozen tab.

   It runs in slices rather than in one go. The screen is not updated either
   way, but a browser given a straight-line loop of that length decides the page
   has hung and offers to kill it, and a run that cannot report where it has got
   to is indistinguishable from one that has crashed. */

/* Milliseconds of simulation per animation frame. A frame is about sixteen, so
   this deliberately overruns it — there is nothing to be smooth for. It is kept
   short of the point where the page stops noticing input, because the one
   button that has to keep working while this runs is the one that stops it. */
export const AHEAD_BUDGET = 20;
export let ahead = null;

export function seeAhead(years) {
  if (ahead) return;
  const y = clamp(Math.round(years), 1, 50);
  const steps = Math.round((y * P.yearLength * P.dayLength) / ffStep());
  ahead = { left: steps, total: steps, years: y, from: simDay, started: Date.now() };
  $('ahead').hidden = false;
  showAheadProgress();
}

/* Stopped where it got to, which is a real place: the world has genuinely lived
   through however much of it ran, and everything is put back the way finishing
   would have put it back.

   The acknowledgement matters as much as the stopping. A click handler returns
   immediately and the browser can paint before the next frame, so saying so
   here is the only chance to say anything at all — everything after it happens
   inside frames that paint nothing. */
export function stopAhead() {
  if (!ahead || ahead.left <= 0) return;
  ahead.left = 0;
  $('aheadNote').textContent = 'stopping…';
  $('aheadStop').disabled = true;
}

export function ago(seconds) {
  if (seconds < 90) return `${seconds.toFixed(0)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`;
}

/* Redrawing the chart and the chronicle every slice would spend the simulation
   budget on the readout — which is the one thing this window exists NOT to do.
   Four times a second reads as live and costs nothing. */
export const AHEAD_DRAW_EVERY = 250;

export function showAheadProgress() {
  const done = 1 - ahead.left / ahead.total;
  $('aheadBar').style.width = (done * 100).toFixed(1) + '%';

  const now = Date.now();
  if (now - (ahead.drawn || 0) > AHEAD_DRAW_EVERY || ahead.left <= 0) {
    ahead.drawn = now;
    drawTribeChart($('aheadChart'));
    /* The chronicle as it is written. A run of years is not a progress bar with
       nothing behind it — it is births, deaths, a band learning to cure meat,
       another one breaking away — and all of that is happening whether or not
       anybody is shown it. */
    $('aheadLog').innerHTML = chronicle.slice(0, 8).map((e) =>
      `<div>${codeChip(e.seed)}<span>d${e.day}</span>${tribeChips(e.text)}</div>`).join('')
      || '<div>nothing has happened yet</div>';
  }
  const spent = (Date.now() - ahead.started) / 1000;
  const elapsedYears = (simDay - ahead.from) / P.yearLength;
  /* An estimate measured from this world rather than guessed from another one:
     how long a year takes depends entirely on how many people and animals are
     in it, and a band of eighty is nothing like the default sixteen.

     Measured in STEPS rather than as a fraction of the whole, so it is there
     after the first slice instead of after the first percent — on a run long
     enough to need an estimate, one percent is itself a long wait, which is
     exactly when somebody wants to know whether to stop. */
  const doneSteps = ahead.total - ahead.left;
  const left = doneSteps > 400 && spent > 0.25
    ? ` · about ${ago(ahead.left / (doneSteps / spent))} left` : '';
  $('aheadNote').textContent =
    `year ${elapsedYears.toFixed(1)} of ${ahead.years} · day ${Math.floor(simDay)}`
    + ` · ${ago(spent)}${left}`;
}

export function runAhead() {
  /* Second half of stopping. The overlay came down on the previous frame and
     the browser has had its chance to paint without it; now the rebuilding can
     take as long as it takes.

     Doing both in one frame is what made Stop feel like it did nothing: the
     click landed instantly, and then a single frame spent a quarter of a second
     at high quality — far more on a big world — refilling every grass tile,
     with the overlay still on screen the whole time because nothing can be
     painted in the middle of it. */
  if (ahead.closing) {
    const years = ahead.years;
    ahead = null;
    rebuildAfterAhead(years);
    return;
  }

  /* Date.now rather than performance.now: this is a wall-clock budget, and the
     headless harness replaces performance.now with a clock it drives itself —
     which would make this loop never end. */
  const until = Date.now() + AHEAD_BUDGET;
  const step = ffStep();
  while (ahead.left > 0 && Date.now() < until) {
    stepWorld(step);
    ahead.left--;
  }
  showAheadProgress();
  if (ahead.left <= 0) {
    ahead.closing = true;
    $('ahead').hidden = true;
    $('aheadStop').disabled = false;
  }
}

/* Everything that was allowed to go stale while nothing was drawn. The world
   itself is up to date; what is not is every view of it. Expensive — refilling
   the grass alone is a quarter of a second at high quality — which is why the
   overlay is already down by the time this runs. */
export function rebuildAfterAhead(y) {
  updateTimeOfDay();
  updateTiles(true);
  recountBlades();
  recountAnimals();
  paintPeople();
  renderTribes();
  renderChronicle();
  updateHud();
  updateFollowCaption();
  /* The clock and the almanac are written by tick, and tick has not run since
     before the years passed — so without this the world is a decade older and
     the corner still says the day it started. */
  lastClock = hhmm(P.time);
  $('clock').textContent = lastClock;
  $('almanac').textContent = `day ${Math.floor(simDay)} · ${seasonName}`;
  drawMap(0);
  persistState();
  toast(`${y} years on · day ${Math.floor(simDay)}`, 3);
  logEvent('ahead', `${y} years passed unwatched`, 0, 0);
}

export function tick() {
  requestAnimationFrame(tick);
  const real = Math.min(clock.getDelta(), 0.1); // a tab that slept must not lurch
  /* While the world is being run on, nothing else happens: no camera, no
     tiles, no sound, and nothing is rendered. The canvas keeps whatever it last
     drew, which is what "the UI stops" looks like from the outside. */
  if (ahead) { runAhead(); return; }
  elapsed += real;
  /* Everything below this line runs on world time, not wall time. `elapsed` is
     deliberately not scaled: it drives the fire flicker and the toasts, which
     belong to the room you are sitting in rather than to the world. */
  const dt = real * clockRate();
  setWorldClock(worldClock + dt);

  // The clock always runs; there is no setting for what time it is, only for
  // how long a day takes. Writing the readout only when the minute actually
  // changes keeps it off the per-frame path.
  const wasHour = P.time;
  P.time = (P.time + (dt * 24) / P.dayLength) % 24;
  if (P.time < wasHour) { setSimDay(simDay + 1); onNewDay(); }
  const clockText = hhmm(P.time);
  if (clockText !== lastClock) {
    lastClock = clockText;
    $('clock').textContent = clockText;
    $('almanac').textContent = `day ${Math.floor(simDay)} · ${seasonName}`;
  }
  windUniforms.uTime.value += real * (0.6 + P.wind * 1.1);

  /* Every speed in here — a walk, a jog, a deer's flight, the camera — was
     tuned against an hour-long day. Shorten the day without touching them and a
     whole day passes while somebody crosses their own camp; so the pace of
     everything that moves scales with how compressed the day is, and a short
     day is a fast one in every sense.

     Wind and firelight are left on the real clock. They are weather and light,
     not life, and speeding them up only looks wrong. */
  const paced = Math.min(dt * pace(), PACE_MAX_STEP);

  moveCamera(paced);
  // update() recomputes the camera from its spherical coordinates, so in the
  // free modes it would undo every frame of look and movement.
  if (P.view === 'orbit') controls.update();
  // Crossing a tile boundary dirties one row (9 tiles at high quality). The
  // scatter maths measures ~0.26ms a tile, so three a frame clears a row in
  // three frames and never costs more than about a millisecond of one.
  updateTiles(false);
  drainDirtyTiles(3);
  updateGrassDetail();
  updateAnimals(paced, elapsed);
  const daylight = smoothstep(-0.10, 0.14, sunDir.y);
  const simDays = dt / P.dayLength;
  updateSeason();
  // The same books, on the same cadence, whether anybody is watching or not.
  bookDue += simDays;
  if (bookDue >= BOOK_EVERY) {
    const owed = bookDue;
    bookDue = 0;
    regrowFruit(owed);
    updateEconomy(owed);
    updateGround(owed);
    updateLives(owed);
    repopulate(owed);
  }
  updatePeople(paced, daylight);
  updateCamps(dt, elapsed, daylight);
  updateTimeOfDay();
  updateAudio();
  updateShadowFocus();
  updateToast();
  if (elapsed > nextSave) { setNextSave(elapsed + SAVE_EVERY); persistState(); }
  drawMap(elapsed);
  if (P.view === 'follow' && elapsed - lastCaption > 0.5) { lastCaption = elapsed; updateFollowCaption(); }
  renderTribes(elapsed);

  renderer.render(scene, camera);

  frames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    /* The counts move constantly now — an animal is hunted, fruit is picked,
       it grows back — and a readout that only redraws when somebody is born or
       dies shows yesterday's numbers. Redrawing it twice a second is both often
       enough to look live and rare enough not to matter, and it shares the
       cadence with the frame counter because updateHud() rewrites the element
       the frame counter lives in. */
    updateHud();
    const el = $('fps');
    if (el) el.textContent = Math.round(frames / fpsTime);
    frames = 0; fpsTime = 0;
  }
}

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */

onResize();
syncLabels();
setRate(rateIndex);

/* The saved world and clock have to be in place before `buildWorld` reads them,
   so the boot waits for them. There is a loading screen up; this is the moment
   to spend on it. */
readSavedState().then((saved) => {
  applySavedWorld(saved);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.__booted = true;
    /* Everything that used to happen as a module loaded, now that they all
       have. The order is the order the one long script did it in. */
    wireWorld();
    wireInput();
    buildWorld();
    applySavedLife(saved);
    // The run has to be registered before the worlds can be fetched from it.
    // The run has to exist before either the worlds or the chronicle can be
    // read back from it.
    startRun().then(ensureCurrentWorld).then(loadChronicle);
    setViewMode(P.view);
    placeCamera();
    // The world is standing there already; the models arrive and improve it.
    loadModels();
    updateTimeOfDay();
    $('loading').classList.add('done');
    ui.classList.remove('hidden');
    tick();
  }));
});

/* lastClock lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setLastClock(v) { lastClock = v; }
