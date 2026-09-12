import { P } from './params.js';
import { clamp, mulberry32 } from './noise.js';
import { NAME_CODA, NAME_VOWEL, setLineage, tribeVoice, usedCodes } from './wildlife.js';
import { RATES, rateIndex, setRateIndex } from './clock.js';
import {
  CHRONICLE_STORE, chronicle, milestonesOnly, pendingEvents, renderChronicle, renderTribes, runId,
  saveChronicle, setBornCount, setChronicle, setDiedCount, setMilestonesOnly, setPendingEvents, setRunId,
  startRun
} from './life.js';
import { VIEW_MODES, buildWorld, placeCamera } from './move.js';
import {
  chronPage, closeChronicle, closeTribe, dropHere, eatHere, handBack, openChronicle, openTribe, orderJob,
  restHere, renderChronPage, renderTribeCard, sendHome, setChronFind, setChronPage, setTribeTab, showKeys,
  storeHere, toggleKeys, tribeShown, actHere, pickFollow, setViewMode
} from './chronicle.js';
import { camps } from './people.js';
import { stepMapSize, travelTo } from './map.js';
import { $, STATE_STORE, clearSavedState, ui } from './save.js';
import { elapsed, seeAhead, setAheadOnly, stopAhead, updateHud } from './main.js';

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

export const VIEW_NAMES = { orbit: 'Orbit', follow: 'Follow' };

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

/* A band's two characters, taken out of its own name.

   They used to be a hash of a seed, which made them unique and meaningless:
   "Tsekash" was 3X because of arithmetic, so the chip on the map and the name on
   the panel were two unrelated facts about the same band and you learned the
   pairing by rote. Read off the name they are a shorthand for it — Tsekash is
   TS — and the map stops needing to be memorised.

   Uniqueness still has to hold, because the code is what the chronicle uses to
   say whose line a line is. So the second character is the first of these that
   nobody has taken:

     · the name's second letter          Tribe    -> TR
     · the start of its last syllable    Tribetwo -> TT   (TR being gone)
     · any other letter in it            Tsotsa   -> TO
     · any letter at all, which cannot run out inside one island

   Every one of those is still *from the name* until the last, which is the
   whole point: a code you cannot derive is a code you have to look up. */
export function tribeCode(name, taken = new Set()) {
  const up = String(name || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!up) return worldCode(taken.size + 1);
  const first = up[0];
  const vowel = (c) => 'AEIOU'.includes(c);

  const tries = [];
  if (up.length > 1) tries.push(up[1]);
  /* Syllable starts, last first. "Tribetwo" is TT rather than TB because the
     end of a name is the part that makes it that name — the beginnings are
     shared by everything the same band ever founded. */
  for (let i = up.length - 1; i > 1; i--) {
    if (!vowel(up[i]) && vowel(up[i - 1])) tries.push(up[i]);
  }
  for (let i = 1; i < up.length; i++) tries.push(up[i]);
  for (const c of CODE_LETTERS) tries.push(c);

  for (const c of tries) {
    const code = first + c;
    if (!taken.has(code)) return code;
  }
  return first + CODE_LETTERS[taken.size % CODE_LETTERS.length];
}

/** Claims one, so no two bands on an island answer to the same two letters. */
export function takeTribeCode(name) {
  const code = tribeCode(name, usedCodes);
  usedCodes.add(code);
  return code;
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
/* Scattered rather than summed, and the codes being meaningful is what forced
   it. `h * 31 + c` moves the hue by one degree per step of the last character,
   which was invisible but harmless while codes were random and spread over the
   whole space. Now they are initials: half the bands on an island can share a
   first letter, and TR and TS would have come out two degrees apart — the same
   colour, on the dots the map uses to tell them apart.

   FNV with a finalizer, so one character's difference is a different hue rather
   than an adjacent one. */
export function codeColor(code) {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) {
    h = Math.imul(h ^ code.charCodeAt(i), 16777619);
  }
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return `hsl(${(h >>> 0) % 360} 70% 70%)`;
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

// With a list it writes; without one it just reads the shelf back.
export function localWorlds(next?) {
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
  $('seedOut').textContent = String(P.seed);
  $('worldHere').innerHTML = codeChip(P.seed) + (here ? here.name : nameForSeed(P.seed));
}

export function enterWorld(seed, name) {
  P.seed = seed | 0;
  rebuild();
  renderWorlds();
  toast(name ? `${name} · seed ${P.seed}` : `seed ${P.seed}`, 2.2);
}

$('world').addEventListener('change', (e: any) => {
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

$('runAhead').addEventListener('click', () => seeAhead(Number(($('years') as HTMLInputElement).value) || 5));
$('aheadStop').addEventListener('click', stopAhead);
$('aheadTribe')?.addEventListener('change', (ev: any) => setAheadOnly(ev.target.value));

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
$('tribes').addEventListener('click', (ev: any) => {
  const row = ev.target.closest ? ev.target.closest('div[data-camp]') : null;
  if (row) openTribe(Number(row.dataset.camp));
});
$('tribeNow').addEventListener('click', () => { setTribeTab('now'); renderTribeCard(); });
$('tribeWas').addEventListener('click', () => { setTribeTab('was'); renderTribeCard(); });
$('tribeSkills').addEventListener('click', () => { setTribeTab('skills'); renderTribeCard(); });
$('tribeLog').addEventListener('click', () => { setTribeTab('log'); renderTribeCard(); });
/* Go and stand there — and get out of the way, which is the whole gesture.

   This left the card open at first, on the reasoning that the reason to go is
   to look at what the card is describing. That was exactly backwards: `#tribe`
   is `position: fixed; inset: 0` with a dimmed, blurred backdrop over the whole
   window, so the camera moved and you were left looking at the overlay. It read
   as a button that did nothing, which is the worst way for a thing to work.

   Clicking a band on the *map* still opens the card, and that is not the same
   gesture: there you are asking who they are, here you are asking to see them.
   The toast keeps its name on screen either way. */
$('tribeGo').addEventListener('click', () => {
  /* Off the button rather than out of a live binding — see renderTribeCard. */
  const at = Number($('tribeGo').dataset.camp);
  const camp = camps[Number.isFinite(at) && at >= 0 ? at : tribeShown];
  /* And it says so rather than doing nothing. A button that fails silently is
     the same thing on screen as a button that is not connected, which is two
     completely different bugs to go looking for. */
  if (!camp) { toast('no band to go to'); return; }

  /* Everything that is over the world comes down. The card is a full-screen
     backdrop and so is the chronicle, so leaving either up moves the camera to
     a view of the overlay — which is what "the button does nothing" turned out
     to mean the first time. */
  closeTribe();
  closeChronicle();
  showKeys(false);
  travelTo(camp.x, camp.z);
  toast(camp.name);
});
$('tribeClose').addEventListener('click', closeTribe);
$('tribe').addEventListener('click', (ev: any) => { if (ev.target === $('tribe')) closeTribe(); });

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

/* One listener on the row rather than six on the buttons. The two on the end
   are not errands. One takes the instructions off them and one brings them in,
   so they carry `data-act` and are read separately. */
$('orders')?.addEventListener('click', (ev: any) => {
  // Shut or open the row. First, because folding it away is not an errand.
  if (ev.target?.closest?.('#ordersFold')) { $('orders').classList.toggle('collapsed'); return; }
  const b = ev.target?.closest?.('button[data-order]');
  if (b) { orderJob(b.dataset.order); return; }
  const a = ev.target?.closest?.('button[data-act]');
  if (a?.dataset.act === 'free') handBack();
  if (a?.dataset.act === 'home') sendHome();
  if (a?.dataset.act === 'store' && !storeHere()) toast('not at the granaries');
  if (a?.dataset.act === 'drop') dropHere();
  if (a?.dataset.act === 'rest' && !restHere()) toast('busy');
  if (a?.dataset.act === 'eat' && !eatHere()) toast('busy');
});

/* ---- a screen with no keys ----

   Everything on the order row above is already a button, so a phone can reach
   all of it by tapping — but only once you are behind somebody, and getting
   there was F. These are the rest of the keys that had no button at all: they
   call exactly what the keys call, so there is one way each of these works. */
$('touch')?.addEventListener('click', (ev: any) => {
  const b = ev.target?.closest?.('button[data-touch]');
  if (!b) return;
  const what = b.dataset.touch;
  // C: fly, walk, orbit, follow and round again - the same walk the key makes.
  if (what === 'view') setViewMode(VIEW_MODES[(VIEW_MODES.indexOf(P.view) + 1) % VIEW_MODES.length]);
  // F: into Follow, then again for somebody else — the same one key, twice over.
  if (what === 'follow') { if (P.view !== 'follow') setViewMode('follow'); else pickFollow(); }
  if (what === 'act') actHere();
  if (what === 'map') stepMapSize(1);
  /* One sheet at a time. Each of these covers the whole screen, and opening a
     second over the first left them stacked with nothing to close them but
     Escape, which a phone has not got. The same three closes that "go to their
     camp" already makes, in the same order. */
  if (what === 'band') { if ($('tribe').hidden) { closeChronicle(); showKeys(false); openTribe(tribeShown || 0); } else closeTribe(); }
  if (what === 'panel') togglePanel();
  if (what === 'keys') { closeTribe(); closeChronicle(); toggleKeys(); }
  // Says what the next tap does, because shut it is the only thing left to read.
  if (what === 'fold') b.textContent = $('touch').classList.toggle('collapsed') ? 'menu' : 'hide';
});

/* On a phone both corners start shut. The screen is small and the world is the
   point of it; the icon that opens each is right there, which is the one thing
   the world pane's own collapse taught (a minimise you cannot undo is a leave).
   With a mouse there is room, so the row and the rail start as they always did. */
if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches) {
  $('orders')?.classList.add('collapsed');
  $('touch')?.classList.add('collapsed');
  const fold = $('touchFold');
  if (fold) fold.textContent = 'menu';
}

/* Pinch is the wheel a phone does not have: in Follow it sets how far back you
   stand, the same as the wheel does (chronicle.js). Two fingers only — one
   finger is a drag to look around, and in Orbit two fingers belong to
   OrbitControls, which is listening on this canvas already. */
/* The canvas is read off the page rather than imported from scene.js: this
   module is in a cycle with that one, so an imported binding read while this
   file is still evaluating is a ReferenceError, not an element. The listeners
   below run at load like every other one here, and `$` is a DOM lookup. */
const view = $('view');
const pinch = { live: false, gap: 0 };
const pinchGap = (ev) => (ev.touches.length >= 2
  ? Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY)
  : 0);
view?.addEventListener('touchstart', (ev: any) => {
  if (P.view !== 'follow' || ev.touches.length < 2) return;
  pinch.live = true;
  pinch.gap = pinchGap(ev);
}, { passive: true });
view?.addEventListener('touchmove', (ev: any) => {
  if (!pinch.live || P.view !== 'follow') return;
  const gap = pinchGap(ev);
  if (!gap || !pinch.gap) return;
  ev.preventDefault();
  P.followDist = clamp(P.followDist * (pinch.gap / gap), 1.4, 40);
  pinch.gap = gap;
}, { passive: false });
view?.addEventListener('touchend', (ev: any) => { if (ev.touches.length < 2) pinch.live = false; }, { passive: true });

$('chronOpen').addEventListener('click', openChronicle);
$('chronClose').addEventListener('click', closeChronicle);
$('chron').addEventListener('click', (ev: any) => { if (ev.target === $('chron')) closeChronicle(); });
$('chronPrev').addEventListener('click', () => { setChronPage(chronPage - 1); renderChronPage(); });
$('chronNext').addEventListener('click', () => { setChronPage(chronPage + 1); renderChronPage(); });
$('chronFind').addEventListener('input', (ev: any) => {
  setChronFind(ev.target.value);
  setChronPage(0);                      // a new search starts at the top of it
  renderChronPage();
});

$('keysOpen').addEventListener('click', toggleKeys);
$('keysClose').addEventListener('click', () => showKeys(false));
// Clicking the dimmed area behind the card closes it; clicking the card does not.
$('keys').addEventListener('click', (ev: any) => { if (ev.target === $('keys')) showKeys(false); });

/* One path for the icon and for H, because they are the same gesture.

   H used to toggle `hidden`, which took the toggle button with it: the pane did
   not minimise, it left, and the only way back was a key you had to already
   know. Collapsed, the icon IS the panel — one row, no title, still there. The
   `hidden` class stays for the one thing it is right for, which is the panel
   not existing yet while the world is being built. */
export function togglePanel(collapsed?) {
  const next = collapsed === undefined ? !ui.classList.contains('collapsed') : Boolean(collapsed);
  ui.classList.toggle('collapsed', next);
  // Nothing in the pane is redrawn while it is shut, so opening it has to catch up.
  if (!next) { updateHud(); renderChronicle(); renderTribes(); }
  return next;
}

$('collapse').addEventListener('click', () => togglePanel());

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

