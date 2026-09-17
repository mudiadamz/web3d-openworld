import { P } from './params.js';
import { ffStep } from './clock.js';
import { simDay } from './life.js';
import { persistState } from './save.js';
import { ahead, refreshViews, runAhead, stepWorld } from './main.js';
import { toast } from './ui.js';

/* -------------------------------------------------------------------------
   Running on in a background tab

   A tab you are not looking at gets no animation frames, so the island stopped
   the moment you switched away and waited for you, however long you were gone.
   Now it runs on while the tab is hidden - run through, the way Run years runs
   it, with nothing drawn - and when you come back it has lived through however
   much it got to, and the views are brought up to date once.

   The ticks come from a worker. A hidden page's own timers are held to one a
   second or worse, and after a few minutes to one a minute, while a worker's
   are not; its message still runs the simulation here, on the page, where the
   world is. Each tick gets BACKGROUND.budget milliseconds of it, a share of one
   core rather than all of it - a tab in the background should not be the
   thing that warms the laptop - and the world is saved every so often, so a
   tab closed while hidden keeps what it lived through.

   A run of years started before you left carries on as it would have. And an
   island being watched from a server (?watch=) is not this page's to run.
   BACKGROUND=false turns all of it off.
   ------------------------------------------------------------------------- */

export const BACKGROUND = {
  every: 50,           // milliseconds between ticks from the worker
  budget: 20,          // milliseconds of simulation a tick: two fifths of one core
  save: 15000,         // milliseconds between saves while it runs
  worth: 0.02,         // sim-days it has to have run before coming back says so
};

let worker: Worker | null = null;
let running = false, fromDay = 0, savedAt = 0;

export const backgroundRunning = () => running;

function runSlice() {
  if (!running) return;
  if (ahead) { runAhead(); return; }
  const until = Date.now() + BACKGROUND.budget, step = ffStep();
  while (Date.now() < until) stepWorld(step);
  if (Date.now() - savedAt > BACKGROUND.save) {
    savedAt = Date.now();
    persistState();
  }
}

function start() {
  if (running) return;
  try {
    const src = `setInterval(() => postMessage(0), ${BACKGROUND.every});`;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  } catch {
    return;                                // no workers here: it waits, as it always did
  }
  worker.onmessage = runSlice;
  running = true;
  fromDay = simDay;
  savedAt = Date.now();
}

function stop() {
  if (!running) return;
  running = false;
  worker?.terminate();
  worker = null;
  const days = simDay - fromDay;
  if (days < BACKGROUND.worth) return;
  refreshViews();
  const said = days >= P.yearLength ? `${(days / P.yearLength).toFixed(1)} years` : `${days.toFixed(1)} days`;
  toast(`${said} went by while you were away · day ${Math.floor(simDay)}`, 3);
}

/** Starts and stops with the tab. `watching` is true for a page showing an
    island a server runs, which has nothing of its own to run. */
export function runInBackground(watching) {
  if (watching || typeof document === 'undefined' || typeof Worker === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && P.background) start();
    else stop();
  });
}
