import { P } from './params.js';
import { clamp, mulberry32 } from './noise.js';
import { NAME_CODA, NAME_VOWEL, setLineage, tribeVoice } from './wildlife.js';
import { RATES, rateIndex, setRateIndex } from './clock.js';
import {
  CHRONICLE_STORE, chronicle, milestonesOnly, pendingEvents, renderChronicle, renderTribes, runId,
  saveChronicle, setBornCount, setChronicle, setDiedCount, setMilestonesOnly, setPendingEvents, setRunId,
  startRun
} from './life.js';
import { buildWorld, placeCamera } from './move.js';
import {
  chronPage, closeChronicle, closeTribe, openChronicle, openTribe, orderJob, renderChronPage,
  renderTribeCard, setChronFind, setChronPage, setTribeTab, showKeys, toggleKeys
} from './chronicle.js';
import { $, STATE_STORE, clearSavedState, ui } from './save.js';
import { elapsed, seeAhead, stopAhead, updateHud } from './main.js';

/* -------------------------------------------------------------------------
   Panel

   Almost nothing is adjustable here any more. Every setting lives in the
   environment — `.env`, or `FOO=1 npm start`, or a query string — and the panel
   is left with the one thing that is genuinely a choice rather than a setting:
   which world you are in. The rest of it is a readout.
   ------------------------------------------------------------------------- */

export function hhmm(t) {
  const h = Math.floor(t) % 24;
  const m = Math.floor((t - Math.floor(t)) * 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/* A line that says what just happened and then gets out of the way: which view
   you switched to, which world you loaded. */
export let toastUntil = 0;

export function toast(text, seconds = 1.6) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  toastUntil = elapsed + seconds;
}

export function updateToast() {
  const el = $('toast');
  if (el && !el.hidden && elapsed > toastUntil) el.hidden = true;
}

export const VIEW_NAMES = { fly: 'Fly', walk: 'Walk', orbit: 'Orbit', follow: 'Follow' };

/* -------------------------------------------------------------------------
   Worlds

   A seed is a number nobody remembers. A world is a name, and a list of them
   you can come back to — kept in SQLite when there is a server and in the
   browser when there is not, so the standalone file still has a shelf.
   ------------------------------------------------------------------------- */

export const WORLD_STORE = 'openworld.worlds';
export let worlds = [];

/** Named the same way its tribes are, from its own seed. */
export function nameForSeed(seed) {
  const rng = mulberry32(seed ^ 0x5731a9);
  const voice = tribeVoice(rng);
  let name = '';
  for (let i = 0; i < 2 + ((rng() * 2) | 0); i++) {
    name += voice[(rng() * voice.length) | 0] + NAME_VOWEL[(rng() * NAME_VOWEL.length) | 0];
  }
  name += NAME_CODA[(rng() * NAME_CODA.length) | 0];
  return name[0].toUpperCase() + name.slice(1);
}

/* Two characters and a hue, both straight off the seed, so a world's mark is
   the same every time it is built and needs storing nowhere. I, O, 0 and 1 are
   left out: the whole point is to be read at a glance and not misread. */
export const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function worldCode(seed) {
  const rng = mulberry32((seed | 0) ^ 0x2f6e1b);
  return CODE_LETTERS[(rng() * CODE_LETTERS.length) | 0]
    + CODE_LETTERS[(rng() * CODE_LETTERS.length) | 0];
}

/* Light and saturated: the chip carries dark text, and neighbouring worlds want
   to be told apart at a glance rather than merely to look different. */
export function worldColor(seed) {
  const rng = mulberry32((seed | 0) ^ 0x51af37);
  return `hsl(${Math.floor(rng() * 360)} 70% 70%)`;
}

/* A tribe's colour is a function of its two characters, not of its seed. That
   is what lets a chronicle line written in another world still show its band in
   the right colour years later: the line carries "[TK]" as plain text, and the
   colour is worked out from those two characters at the moment it is drawn.
   Nothing has to be stored, and nothing can drift. */
export function codeColor(code) {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) | 0;
  return `hsl(${((h % 360) + 360) % 360} 70% 70%)`;
}

/** Marks up every [XX] in a line of chronicle as the band it belongs to. */
export function tribeChips(text) {
  return text.replace(/\[([A-Z0-9]{2})\]/g,
    (_, code) => `<b class="wcode" style="background:${codeColor(code)}">${code}</b>`);
}

/* Which one somebody is, in colour. The glyph still carries the meaning on its
   own — this is a second channel, not the only one — and it goes on at the
   markup stage rather than in the text, so nothing has to remember to escape a
   name that now has a tag in it. */
export function sexMarks(html) {
  return String(html)
    .replace(/♀/g, '<i class="sx f">♀</i>')
    .replace(/♂/g, '<i class="sx m">♂</i>');
}

export function codeChip(seed) {
  /* Rows written before the chronicle knew about worlds have no seed. They are
     real history and worth showing, but they cannot be given a colour that
     means anything, so they get a grey one that does not pretend. */
  if (!Number.isFinite(seed)) return '<b class="wcode" style="background:#6b7280">··</b>';
  return `<b class="wcode" style="background:${worldColor(seed)}">${worldCode(seed)}</b>`;
}

export function localWorlds(next) {
  try {
    if (next) localStorage.setItem(WORLD_STORE, JSON.stringify(next));
    return JSON.parse(localStorage.getItem(WORLD_STORE) || '[]');
  } catch {
    return [];               // private window, or storage turned off
  }
}

/* Whatever world you booted into belongs on the shelf too, so the list is
   never empty and the world you are standing in is always one of them. */
export async function ensureCurrentWorld() {
  await loadWorlds();
  if (!worlds.some((w) => w.seed === P.seed)) {
    await rememberWorld(nameForSeed(P.seed), P.seed);
  }
  renderWorlds();
}

export async function loadWorlds() {
  if (runId) {
    try {
      const res = await fetch('/api/worlds');
      worlds = await res.json();
      renderWorlds();
      return;
    } catch { /* fall through to the browser's own shelf */ }
  }
  worlds = localWorlds();
  renderWorlds();
}

/* There is always a world: `ensureCurrentWorld` puts whatever seed you booted
   into on the shelf, and deleting the one you are in moves you to another or
   makes one. So the list is never empty and Delete always has somewhere to go. */
export async function newWorld() {
  const seed = (Math.random() * 2147483647) | 0;
  const name = nameForSeed(seed);
  await rememberWorld(name, seed);
  enterWorld(seed, name);
  return { name, seed };
}

export async function rememberWorld(name, seed) {
  if (worlds.some((w) => w.seed === seed)) return;
  const entry = { name, seed };
  worlds = [entry, ...worlds].slice(0, 60);
  renderWorlds();
  if (runId) {
    try {
      await fetch('/api/worlds', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry),
      });
      return;
    } catch { /* keep it locally instead */ }
  }
  localWorlds(worlds);
}

export function renderWorlds() {
  const sel = $('world');
  if (!sel) return;
  const here = worlds.find((w) => w.seed === P.seed);
  // A <select> cannot carry a coloured chip, so the code goes in the text and
  // the chip itself is shown beside it for the world you are actually in.
  sel.innerHTML = worlds.map((w) =>
    `<option value="${w.seed}"${w.seed === P.seed ? ' selected' : ''}>${worldCode(w.seed)} · ${w.name}</option>`)
    .join('') || '<option value="">no worlds yet</option>';
  $('seedOut').textContent = P.seed;
  $('worldHere').innerHTML = codeChip(P.seed) + (here ? here.name : nameForSeed(P.seed));
}

export function enterWorld(seed, name) {
  P.seed = seed | 0;
  rebuild();
  renderWorlds();
  toast(name ? `${name} · seed ${P.seed}` : `seed ${P.seed}`, 2.2);
}

$('world').addEventListener('change', (e) => {
  const seed = parseInt(e.target.value, 10);
  const w = worlds.find((x) => x.seed === seed);
  if (w) enterWorld(w.seed, w.name);
});

export function setRate(i) {
  setRateIndex(clamp(i, 0, RATES.length - 1));
  const r = RATES[rateIndex];
  const out = $('rateOut');
  if (out) out.textContent = (r < 1 ? r.toString().replace('0.', '.') : r) + '×';
  toast(`clock ${r}×`, 1.2);
}

$('runAhead').addEventListener('click', () => seeAhead(Number($('years').value) || 5));
$('aheadStop').addEventListener('click', stopAhead);

$('slower').addEventListener('click', () => setRate(rateIndex - 1));
$('faster').addEventListener('click', () => setRate(rateIndex + 1));

$('newWorld').addEventListener('click', newWorld);

/* Destructive buttons ask twice. A native confirm() blocks the whole page and
   looks like the browser talking; arming the button itself says the same thing
   in the same place you clicked, and disarms on its own if you walk away. */
export function arm(button, label, action, seconds = 4) {
  let armed = false, timer = null;
  const reset = () => {
    armed = false;
    button.classList.remove('armed');
    button.textContent = label;
    clearTimeout(timer);
  };
  button.addEventListener('click', () => {
    if (armed) { reset(); action(); return; }
    armed = true;
    button.classList.add('armed');
    button.textContent = 'Sure?';
    timer = setTimeout(reset, seconds * 1000);
  });
  return reset;
}

/* The only destructive action there is, and it reaches exactly one world: the
   one you are standing in. Its place on the shelf, the bookmark that would put
   you back in it, and its lines in the chronicle all go together — a chronicle
   line pointing at a world that no longer exists is worse than no line. Then it
   moves you somewhere, because there is always a world. */
export async function deleteThisWorld() {
  const gone = worlds.find((w) => w.seed === P.seed) || { name: nameForSeed(P.seed), seed: P.seed };
  const seed = P.seed;

  worlds = worlds.filter((w) => w.seed !== seed);
  setChronicle(chronicle.filter((e) => e.seed !== seed));
  for (let i = pendingEvents.length - 1; i >= 0; i--) {
    if (pendingEvents[i].seed === seed) pendingEvents.splice(i, 1);
  }
  clearSavedState();

  if (runId) {
    try { await fetch(`/api/worlds?seed=${seed}`, { method: 'DELETE' }); }
    catch { localWorlds(worlds); }
  } else {
    localWorlds(worlds);
  }
  saveChronicle();

  const next = worlds[0];
  if (next) enterWorld(next.seed, next.name);
  else await newWorld();
  renderChronicle();
  toast(`deleted ${gone.name}`, 2.6);
}

arm($('deleteWorld'), 'Delete world', deleteThisWorld);

/* Everything this thing has ever written down, here and on the server. Asked
   for after a session where the page would not behave and there was no way to
   start again from inside it — `npm run reset` does the same from a terminal,
   which is the one that works when the tab is the problem. */
export async function wipeEverything() {
  worlds = [];
  setChronicle([]);
  setLineage([]);
  setPendingEvents([]);
  setBornCount(0);
  setDiedCount(0);
  for (const key of [WORLD_STORE, STATE_STORE, CHRONICLE_STORE]) {
    try { localStorage.removeItem(key); } catch { /* private window */ }
  }
  if (runId) {
    try { await fetch('/api/data', { method: 'DELETE' }); } catch { /* local only */ }
    /* The runs table went with everything else, so the id this page is holding
       points at nothing. Register again before anything else is written. */
    setRunId(null);
    await startRun();
  }
  renderChronicle();
  await newWorld();
  toast('everything deleted', 3);
}

arm($('wipeAll'), 'Delete everything', wipeEverything, 5);

/* A tribe's line on the panel opens it. The rows are rebuilt every half second,
   so the click is caught on the container rather than on rows that will not
   exist by the time anybody presses one. */
$('tribes').addEventListener('click', (ev) => {
  const row = ev.target.closest ? ev.target.closest('div[data-camp]') : null;
  if (row) openTribe(Number(row.dataset.camp));
});
$('tribeNow').addEventListener('click', () => { setTribeTab('now'); renderTribeCard(); });
$('tribeWas').addEventListener('click', () => { setTribeTab('was'); renderTribeCard(); });
$('tribeClose').addEventListener('click', closeTribe);
$('tribe').addEventListener('click', (ev) => { if (ev.target === $('tribe')) closeTribe(); });

/* One idea of what is worth reading, two buttons that say it. Both write the
   same flag and then redraw both places, so the panel and the window can never
   be showing different answers to the same question. */
export function renderChronKind() {
  for (const id of ['chronKind', 'chronKind2']) {
    const b = $(id);
    if (!b) continue;
    /* The funnel is the label. Its state lives in the class, which fills it in,
       and in the title, which says the same thing in words for anybody hovering
       or using a screen reader — the icon is never the only channel. Writing
       textContent here would throw the svg away on the first press. */
    b.classList.toggle('on', milestonesOnly);
    b.setAttribute('aria-pressed', String(milestonesOnly));
    b.setAttribute('title', milestonesOnly
      ? 'Showing what is worth telling — click for every line'
      : 'Showing every line — click for what is worth telling');
  }
}
for (const id of ['chronKind', 'chronKind2']) {
  $(id)?.addEventListener('click', () => {
    setMilestonesOnly(!milestonesOnly);
    setChronPage(0);            // a different list starts at the top of it
    renderChronKind();
    renderChronicle();
    renderChronPage();
  });
}
/* Not called here. `milestonesOnly` is an imported binding and life.js and this
   file are in a cycle, so reading it while this module is still loading gets a
   ReferenceError rather than a value — which is the whole reason the page's
   wiring is deferred, and this slipped straight back into it. The button's
   starting state is in the markup instead, and this runs when something
   actually changes it. */

/* One listener on the row rather than six on the buttons. */
$('orders')?.addEventListener('click', (ev) => {
  const b = ev.target?.closest?.('button[data-order]');
  if (b) orderJob(b.dataset.order);
});

$('chronOpen').addEventListener('click', openChronicle);
$('chronClose').addEventListener('click', closeChronicle);
$('chron').addEventListener('click', (ev) => { if (ev.target === $('chron')) closeChronicle(); });
$('chronPrev').addEventListener('click', () => { setChronPage(chronPage - 1); renderChronPage(); });
$('chronNext').addEventListener('click', () => { setChronPage(chronPage + 1); renderChronPage(); });
$('chronFind').addEventListener('input', (ev) => {
  setChronFind(ev.target.value);
  setChronPage(0);                      // a new search starts at the top of it
  renderChronPage();
});

$('keysOpen').addEventListener('click', toggleKeys);
$('keysClose').addEventListener('click', () => showKeys(false));
// Clicking the dimmed area behind the card closes it; clicking the card does not.
$('keys').addEventListener('click', (ev) => { if (ev.target === $('keys')) showKeys(false); });

$('collapse').addEventListener('click', () => {
  ui.classList.toggle('collapsed');
  if (!ui.classList.contains('collapsed')) { updateHud(); renderChronicle(); renderTribes(); }
});

export function syncLabels() {
  renderWorlds();
}

export function rebuild() {
  $('loading').classList.remove('done');
  // Two frames: one to paint the overlay, one to let it composite.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    buildWorld();
    placeCamera();
    $('loading').classList.add('done');
  }));
}

