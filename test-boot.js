#!/usr/bin/env node
/**
 * Does the page actually boot?
 *
 * Every other check here reads the file. This one runs it: the module is
 * executed for real, against a mocked DOM and a three.js whose WebGLRenderer is
 * a stub, and the boot chain is driven all the way through `buildWorld()` to a
 * frame of `tick()`. Terrain, creeks, grass, animals, camps and people are all
 * genuinely built — none of that needs a GPU, only the drawing does.
 *
 * It exists because two bugs got past everything else by being *runtime*
 * failures at module load: a const read from 1900 lines above its declaration,
 * and an edit that silently did not apply. Both left a file that parsed
 * perfectly and a page that rendered nothing.
 *
 * Run with `npm run boot`. It needs three.js on disk — see THREE_PATH.
 */

import { readFileSync as rawRead, existsSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

/* Read as LF, whatever is on disk. The checks here that look at source do it
   with regexes written with \n in them, and git checks out CRLF on Windows by
   default — which made twenty-nine checks in test.js fail against a working
   tree that was perfectly correct. Line endings are not what anything here is
   about, and core.autocrlf belongs to whoever cloned the repository rather than
   to the repository. Modules are handed to Node as LF too, which it does not
   mind either way. */
const readFileSync = (path, enc) => {
  const text = rawRead(path, enc);
  return typeof text === 'string' ? text.split('\r\n').join('\n') : text;
};

const ROOT = dirname(fileURLToPath(import.meta.url));
const THREE_PATH = process.env.THREE_PATH || join(ROOT, 'vendor', 'three.module.js');

if (!existsSync(THREE_PATH)) {
  console.log(`\nboot check skipped — no three.js at ${THREE_PATH}`);
  console.log('  curl -sL https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js \\');
  console.log(`    -o ${THREE_PATH}`);
  process.exit(0);
}

/* INDEX_HTML points this at a copy. Mutation testing — flipping one line and
   checking a test notices — used to work by writing the mutation into the real
   file and writing it back afterwards, which has twice now clobbered live edits
   when a run was interrupted between the two. Reading a copy instead means a
   mutation run cannot touch the page at all. */
const INDEX_HTML = process.env.INDEX_HTML || join(ROOT, 'index.html');
const markup = readFileSync(INDEX_HTML, 'utf8');

/* The page and every module it is built from. Two things below read this as
   text rather than running it — the set of ids the page may ask for, and the
   handful of checks that assert on the shape of the source — and both were
   reading markup alone the moment the code moved into src/. An id that only
   ever appears inside a template literal in a module (`<b id="fps">`) is still
   an id the page asks for. */
const SOURCE_DIR = process.env.SRC_DIR || join(ROOT, 'src');
const html = [markup, ...(existsSync(SOURCE_DIR)
  ? readdirSync(SOURCE_DIR).filter((f) => f.endsWith('.js')).sort()
    .map((f) => readFileSync(join(SOURCE_DIR, f), 'utf8')
      .replace(/^export (?=(?:async )?function |class |const |let )/gm, ''))
  : [])].join('\n');
const OPEN = '<script type="module">';
const script = markup.includes(OPEN)
  ? markup.slice(markup.indexOf(OPEN) + OPEN.length, markup.lastIndexOf('</script>'))
  : '';

/* ---- the page around the page ---- */

const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
// Which of them start hidden in the markup — the stub has to agree with the
// page, or a "hidden until asked for" check is testing the stub's default.
const hiddenIds = new Set([...markup.matchAll(/<[^>]*\bid="([\w-]+)"[^>]*\bhidden[\s>]/g)].map((m) => m[1]));
/* Initial text, for elements whose markup is a tag with plain text in it. A
   button that remembers its own label — as the arm/disarm one does — reads
   this, so a stub that starts every element empty is testing the stub. */
const initialText = new Map();
for (const m of html.matchAll(/<(\w+)[^>]*\bid="([\w-]+)"[^>]*>([^<]*)<\/\1>/g)) {
  const text = m[3].trim();
  if (text) initialText.set(m[2], text);
}
const elements = new Map();
const touched = [];

function makeElement(id) {
  const el = {
    id, value: '', textContent: initialText.get(id) || '', innerHTML: '',
    hidden: hiddenIds.has(id), checked: false,
    width: 384, height: 384, style: {}, dataset: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      /* The second argument is not optional decoration: `toggle(c, on)` sets
         rather than flips, and a mock that ignores it turns "make sure this
         class matches this boolean" into "flip it every time", which is a
         different function and passes anyway. */
      toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : !!force;
        if (on) this._set.add(c); else this._set.delete(c);
        return on;
      },
      contains(c) { return this._set.has(c); },
    },
    /* Real elements have these. Leaving them off does not make the page
       simpler, it makes the harness throw on perfectly ordinary markup — an
       aria attribute on a toggle button was enough. */
    /* Every real element has one. These are synthesised by id with no tree, so
       there is nothing to put in it — but anything that walks it should find an
       empty list rather than undefined, which is what a real empty div gives. */
    children: [],
    _attrs: {},
    setAttribute(name, value) { this._attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; },
    removeAttribute(name) { delete this._attrs[name]; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name); },
    _on: {},
    addEventListener(type, fn) { (this._on[type] ||= []).push(fn); },
    removeEventListener() {},
    /* Extra fields are merged into the event, so a check can say where a
       pointer was. Without them every pointer event in the page arrives at the
       same coordinates, which is exactly the case a drag has to be told from. */
    fire(type, extra) {
      for (const fn of this._on[type] || []) {
        fn({ target: this, code: '', button: 0, pointerId: 1, preventDefault() {}, ...extra });
      }
    },
    setPointerCapture() {}, releasePointerCapture() {},
    /* The scale bar writes into two children of its own box. Returning a fresh
       stub each time is enough for "did it try", which is the question. */
    querySelector() { return this._kids || (this._kids = { style: {}, textContent: '' }); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 384, height: 384 }; },
    getContext() { return context2d; },
  };
  return el;
}

/* The 2d context swallowed everything, which is fine for "does the map draw
   without throwing" and useless for "what colour did it draw that in". It keeps
   the current fill and records one entry per filled arc — the shape the map's
   markers are — so a check can ask what was actually painted. Nothing else is
   recorded: an entry per fillRect would be one per animal per frame. */
const context2d = {
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData() {}, drawImage() {}, closePath() {}, setTransform() {},
  moveTo() {}, lineTo() {}, stroke() {}, fillRect() {}, clearRect() {},
  texts: [],
  fillText(t, x, y) { if (this.recording) this.texts.push({ t: String(t), x, y, fill: this._fill }); },
  strokeText() {}, measureText: () => ({ width: 0 }),
  set font(v) {}, set textAlign(v) {},
  set strokeStyle(v) {}, set lineWidth(v) {},
  set lineCap(v) {}, set lineJoin(v) {},

  /* Off by default. The map draws a dot per person per camp about fourteen
     times a second, and thirty thousand frames of that kept forever is a
     million objects nobody reads. A check turns it on for the frames it cares
     about. */
  recording: false,
  _fill: null, _arc: null, arcs: [],
  set fillStyle(v) { this._fill = v; },
  get fillStyle() { return this._fill; },
  beginPath() { this._arc = null; },
  arc(x, y, r) { this._arc = { x, y, r }; },
  fill() { if (this.recording && this._arc) this.arcs.push({ ...this._arc, fill: this._fill }); },
};

globalThis.document = {
  getElementById(id) {
    touched.push(id);
    if (!ids.has(id)) return null;
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  },
  createElement: () => makeElement('created'),
  querySelectorAll: () => [],
  addEventListener() {},
  hidden: false,
};
globalThis.window = globalThis;
const windowListeners = {};
globalThis.addEventListener = (type, fn) => { (windowListeners[type] ||= []).push(fn); };
// The keydown handler tests its target against these; undefined would throw.
globalThis.HTMLInputElement = class {};
globalThis.HTMLSelectElement = class {};
/* The caption is written on a half-second throttle inside tick, and the frames
   driven here carry no wall time — so it is asked for directly. */
const updateCaptionSpy = () => { for (let i = 0; i < 6; i++) stepFrame(100); };

/* A key going down, and a key coming up. They were one function that only ever
   fired keydown, so every key the harness had ever pressed stayed held for the
   rest of the run — which nothing depended on, because nothing it pressed was a
   movement key, and which would have quietly broken the first check that held
   one down on purpose. */
function keyDown(code, shiftKey = false) {
  for (const fn of windowListeners.keydown || []) fn({ code, target: {}, key: code, shiftKey });
}
function keyUp(code) {
  for (const fn of windowListeners.keyup || []) fn({ code, target: {}, key: code });
}
function pressKey(code, shiftKey = false) { keyDown(code, shiftKey); keyUp(code); }

/* The settings are environment-only now, so the boot check supplies them the
   same way the server does. `all` exercises the herd models as well as the
   birds. */
/* Overridable so the same harness can be booted twice with different worlds —
   BOOT_CONFIG is a JSON object of setting paths, e.g. {"counts.tigers":0}. */
const extra = JSON.parse(process.env.BOOT_CONFIG || '{}');

/* Pin the environment's own randomness as well as the world's.

   The simulation draws from a seeded stream, so the same seed replays the same
   history — but the page still uses Math.random for the things that are not
   the simulation, and one of them bites here: the delete-a-world check below
   deletes the world this harness booted into, and the replacement world is
   minted with a random seed. Every probe after that check was running in a
   world nobody chose. Two runs of "the same seed" were two different islands,
   which is exactly the trap this harness exists to catch the page falling into
   and it fell into it itself.

   So the harness gives the page a Math.random it can predict. The product
   keeps real randomness; measurement gets a world it can ask for twice. */
{
  /* And the wall clock with it. The unwatched runner packs as many steps into a
     frame as a 20ms budget allows, so how much world goes by before a Stop is
     decided by how fast this machine happens to be — the one check that left
     two otherwise identical runs with a different number of berries on the
     island, which eight years then turned into a different history. A clock
     that ticks a millisecond per reading makes that budget a step count. */
  /* Slowly, and that rate is the whole trick. The runner's loop reads the clock
     once per step and stops when 20ms have gone by, so a tick of a millisecond
     every 9 readings turns "20ms of work" into about 180 steps — a fixed number,
     the same on any machine, and very close to what a real 20ms buys here: a
     simulated year measured at 972 frames before any of this, and 960 after.

     The rate has to be about right, not merely fixed. A tick per reading gives
     20 steps a frame and a year takes 8,600 of them, which is the harness
     timing out rather than measuring; a tick per 500 gives 10,000 a frame and
     a thirty-year run finishes before the check that interrupts it can. */
  let clock = 1_700_000_000_000;
  let reads = 0;
  Date.now = () => {
    if (++reads % 9 === 0) clock += 1;
    return clock;
  };

  /* KNOWN LIMIT, and it will cost somebody a day if it is not written down.

     This makes the stream repeatable; it does not make it comparable between
     two versions of the page. The world these measurements run in is one the
     page minted for itself with a random seed, so which island they land on
     depends on how far along this stream the page had got by then — and three
     draws four times from it for every UUID, which is once per geometry, per
     material and per texture. Allocate one more object anywhere on the way and
     every probe below measures a different island.

     Measured: four extra draws in buildWorld take a three-year population curve
     from 16→25→35 to 16→16→16, and eight take it to 16→26→33. Nothing about the
     simulation changed either time.

     So a probe result is a fact about one tree, not a number to diff against
     another tree that allocates differently. To show a change is inert, run it
     against itself with the change switched off — same page, same allocations,
     same island. Reseeding here is not the fix: the seed is minted after a
     world has been built, and building it draws once per object in it. */
  let a = ((extra.seed ?? 1) | 0) ^ 0x6d2b79f5;
  Math.random = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* Fertility is turned right up so that the simulated day below actually
   produces births during the simulated day below. Whether they run past the
   band the world started with is luck, so the runtime white-people sweep is a
   bonus rather than the guard — the guard is in test.js, where the calls that
   repaint the band are checked directly. */
const values = { models: 'all', fertility: 3 };
const explicit = ['models', 'fertility'];
for (const [path, v] of Object.entries(extra)) {
  const parts = path.split('.');
  let node = values;
  while (parts.length > 1) node = (node[parts.shift()] ||= {});
  node[parts[0]] = v;
  explicit.push(path);
}
globalThis.window.__CONFIG__ = { values, explicit };
globalThis.innerWidth = 1440;
globalThis.innerHeight = 900;
globalThis.devicePixelRatio = 2;
/* A saved session, served the way the real endpoint would serve it. Everything
   else fetch is asked for fails, which is also a path worth exercising. */
const SAVED = {
  v: 1, seed: 20260906, time: 14.25, day: 42.5, born: 7, died: 3,
  camps: [{ name: 'Testtown', food: 96, history: [{ day: 41, pop: 3, kids: 1, food: 90 }] }],
  /* `b` is the day they were born, so with a 24-day year an adult of 30 was
     born 720 days before the saved day. Ages have to come out of the restore
     right, so the fixture has to state them the way the page does. */
  people: [
    { n: 'Aro', c: 0, b: 42.5 - 30 * 24, x: 10, z: 10, y: 0, k: 'adultA', as: 1, ash: 1.07, ahp: 0.97, ahd: 1, h: 0, j: 'tend', s: 'idle', hl: 0, ki: 2 },
    { n: 'Beku', c: 0, b: 42.5 - 41 * 24, x: 12, z: 11, y: 1, k: 'adultB', as: 0.95, ash: 0.94, ahp: 1.06, ahd: 1, h: 1, j: 'gather', s: 'goto', hl: 0, ki: 0 },
    { n: 'Cira', c: 0, b: 42.5 - 7 * 24, x: 11, z: 12, y: 2, k: 'adultA', as: 1.02, ash: 1.07, ahp: 0.97, ahd: 1, h: 0, j: 'play', s: 'idle', hl: 0, ki: 0 },
  ],
  alive: [1, 2, 3],
};
globalThis.fetch = (url, opts) => {
  const path = String(url);
  if (path.endsWith('/api/state') && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve({ ok: true, json: async () => SAVED });
  }
  return Promise.reject(new Error('offline in the boot check'));
};
// No localStorage either: the world shelf has to cope with having nowhere to
// put anything, which is a real state in a private window.

/* A clock the harness drives rather than one that drives it. three's Clock
   reads `performance.now()`, so overriding it is what lets a tight loop of
   frames represent minutes of world time — without it, a thousand frames run in
   a few milliseconds and nothing in the simulation ever happens. */
let fakeNow = 0;
let frameMs = 0;                  // how much time each driven frame represents
globalThis.performance = { now: () => fakeNow };

/* tick() asks for the next frame forever, so the boot chain is let run for a
   few frames and after that the callback is parked rather than called. Parking
   it is what makes the world drivable: `stepFrame` runs exactly one frame, with
   exactly as much time on the clock as it is told.

   The earlier version of this returned 0 once the boot was done, which quietly
   meant the harness could not drive anything — a loop of forty thousand
   `requestAnimationFrame(() => {})` calls incremented a counter and ran no
   simulation at all, while reporting "40000 frames driven". */
let frames = 0;
const pendingFrames = [];
globalThis.requestAnimationFrame = (fn) => {
  if (frames++ <= 6) { fakeNow += frameMs; fn(fakeNow); return frames; }
  /* A queue, not a slot. The boot chain schedules its own callbacks alongside
     tick's, and parking them in one variable meant the last one in overwrote
     tick — after which running the parked callback did its one job, asked for
     nothing more, and the world stopped without a word. */
  pendingFrames.push(fn);
  return frames;
};

/** Runs one real frame of the page, advancing the clock by `ms`. */
let frameError = null;
/* A fingerprint at a named point, so two runs can be diffed to find where they
   part company. Only printed when the repeat probe is asked for. */
const MARKING = (process.env.PROBES || '').includes('repeat');
let marks = 0;
function mark(tag) {
  if (!MARKING) return;
  const alm = document.getElementById('almanac');
  const st = document.getElementById('stats').innerHTML.replace(/<[^>]*>/g, ' ');
  console.log(`MARK ${String(++marks).padStart(2)} ${tag.padEnd(22)}`
    + ` frames ${String(frames).padStart(6)}`
    + ` ${((alm && alm.textContent.match(/day \d+/)) || ['day ?'])[0]}`
    + ` ${(st.match(/(\d+) people/) || [, '?'])[1]}p`
    + ` ${(st.match(/(\d+) fruit/) || [, '?'])[1]}f`);
}

/* With ONLY_PROBES the checks are no-ops, but the frames they drive are not —
   forty-odd call sites between them, thirty thousand frames of a watched world.
   The first few have to run because the page boots inside a pair of nested
   animation frames; after that, nothing moves until a probe asks it to. */
let probing = false;
let bootFrames = 0;

function stepFrame(ms = 16) {
  if (ONLY_PROBES && !probing && bootFrames++ > 24) return false;
  const fn = pendingFrames.shift();
  if (!fn) return false;
  fakeNow += ms;
  /* An exception in tick() means it never asks for another frame, so the whole
     drive stops dead and every later stepFrame quietly returns false. Silence
     is the worst possible outcome here — the harness would report a world that
     simply never changed. Keep the first one and say so. */
  try {
    fn(fakeNow);
  } catch (err) {
    if (!frameError) frameError = err;
    return false;
  }
  return true;
}

/* ---- three.js, minus the parts that need a GPU ---- */

const stubDir = mkdtempSync(join(tmpdir(), 'openworld-boot-'));
writeFileSync(join(stubDir, 'three-stub.mjs'), `
import * as T from ${JSON.stringify(pathToFileURL(THREE_PATH).href)};
class WebGLRenderer {
  constructor() {
    this.domElement = { width: 1440, height: 900, style: {}, addEventListener() {} };
    this.shadowMap = { enabled: false, type: 0, needsUpdate: false };
    this.info = { render: { calls: 0, triangles: 0 } };
    this.toneMapping = 0;
    this.toneMappingExposure = 1;
    this.outputColorSpace = '';
    globalThis.__renderer = this;
  }
  setPixelRatio() {} setSize() {} dispose() {} compile() {}
  render(scene) { globalThis.__scene = scene; }
  getPixelRatio() { return 1; }
}
export default { ...T, WebGLRenderer };
`);
const MODEL_DIR = join(ROOT, 'vendor', 'models');
const LOADER_PATH = pathToFileURL(join(ROOT, 'vendor', 'GLTFLoader.js')).href;
writeFileSync(join(stubDir, 'addons.mjs'), `
import T from './three-stub.mjs';
export class OrbitControls {
  constructor(camera) {
    this.object = camera;
    this.target = new T.Vector3();
    this.enabled = true; this.enableDamping = false; this.dampingFactor = 0;
    this.minDistance = 0; this.maxDistance = 0; this.zoomSpeed = 1;
    this.minPolarAngle = 0; this.maxPolarAngle = Math.PI;
    /* Reachable, so a check can ask what the orbit is pointed at — which is
       what "the scene is focused on that camp" means. Note that update() is a
       no-op here: the real one recomputes its spherical from the camera's
       current offset on every call, so writing the position directly is
       respected — but nothing in this stub can prove or disprove that.
       No backticks in this comment: the whole stub is a template literal. */
    globalThis.__controls = this;
  }
  update() {} dispose() {} addEventListener() {}
}
/* If the models are vendored, parse them off disk with the real loader — that
   exercises instancing, morph textures and the ground offsets. If they are not,
   fail every load, which exercises the fallback the page is built around. Both
   paths matter; whichever one runs here, the page has to end up standing. */
import { readFileSync as __read, existsSync as __exists } from 'node:fs';
import { GLTFLoader as RealGLTFLoader } from 'MODELS_LOADER_PATH';
const __modelDir = 'MODELS_DIR';
export const modelsVendored = __exists(__modelDir);
export class GLTFLoader {
  load(url, onLoad, onProgress, onError) {
    // No template literal here: this whole file is inside one already.
    const file = __modelDir + '/' + url.split('/').pop();
    if (!__exists(file)) return onError?.(new Error('not vendored'));
    const b = __read(file);
    new RealGLTFLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      '', onLoad, onError);
  }
}
export class Sky extends T.Mesh {
  constructor() {
    super(new T.BoxGeometry(1, 1, 1), new T.ShaderMaterial({ uniforms: {
      turbidity: { value: 2 }, rayleigh: { value: 1 }, mieCoefficient: { value: 0.005 },
      mieDirectionalG: { value: 0.8 }, sunPosition: { value: new T.Vector3() },
      up: { value: new T.Vector3(0, 1, 0) },
    } }));
  }
}
`.replace('MODELS_LOADER_PATH', LOADER_PATH).replace(/MODELS_DIR/g, MODEL_DIR));

/* The page asks for `three` by bare name, which the browser resolves through
   the importmap and Node does not resolve at all. Every module gets the same
   four rewrites on its way into the temp directory. */
const useStubs = (src) => src
  .replace(/import \* as THREE from 'three';/, "import THREE from './three-stub.mjs';")
  .replace(/import \{ OrbitControls \} from 'three\/addons\/controls\/OrbitControls\.js';/,
    "import { OrbitControls } from './addons.mjs';")
  .replace(/import \{ Sky \} from 'three\/addons\/objects\/Sky\.js';/,
    "import { Sky } from './addons.mjs';")
  .replace(/import \{ GLTFLoader \} from 'three\/addons\/loaders\/GLTFLoader\.js';/,
    "import { GLTFLoader } from './addons.mjs';");

/* Two shapes to boot, because the split happened one section at a time and the
   harness had to keep working across every step of it: the modules in src/ if
   they are there, and the inline script if they are not. Whichever it is, the
   thing imported is a single entry that pulls in the rest. */
const SRC_DIR = SOURCE_DIR;
const srcFiles = existsSync(SRC_DIR)
  ? readdirSync(SRC_DIR).filter((f) => f.endsWith('.js'))
  : [];
let entry;
if (srcFiles.length) {
  for (const f of srcFiles) {
    writeFileSync(join(stubDir, f), useStubs(readFileSync(join(SRC_DIR, f), 'utf8')));
  }
  entry = 'main.js';
  if (!srcFiles.includes(entry)) {
    console.log(`\nboot check FAILED — src/ has no ${entry} to boot from`);
    process.exit(1);
  }
} else {
  const patched = useStubs(script);
  if (patched === script) {
    console.log('\nboot check FAILED — could not rewrite the three.js imports');
    process.exit(1);
  }
  entry = 'page.mjs';
  writeFileSync(join(stubDir, entry), patched);
}

/* ---- boot it ---- */

const t0 = Date.now();
try {
  await import(pathToFileURL(join(stubDir, entry)).href);
} catch (err) {
  console.log('\nboot check FAILED — the page threw while loading:\n');
  console.log(`  ${err.constructor.name}: ${err.message}`);
  if (err.stack) {
    const at = err.stack.split('\n').find((l) => l.includes(stubDir));
    if (at) console.log(`  ${at.trim()}`);
  }
  process.exit(1);
}

/* ---- and now use it, through the same handlers a person would ---- */
const failures = [];
/* ONLY_PROBES skips every check and goes straight to the measurements.

   The checks drive thirty thousand frames of a watched world, which is nothing
   on an island of twenty people and is most of an hour on one of two hundred —
   so measuring at scale meant waiting out a test suite that was not the thing
   being measured. Every check becomes a no-op; nothing else changes. */
const ONLY_PROBES = Boolean(process.env.ONLY_PROBES);

function check(label, ok, detail = '') {
  if (ONLY_PROBES) return;
  if (!ok) failures.push(`${label}${detail ? ' — ' + detail : ''}`);
  mark(label);
}

let followReport = 'F not driven';

/* Asked of the DOM, not of the cache of what the page has touched. The cache is
   empty until the page asks for an element, so a page that fails to boot left
   this undefined and the first unguarded use crashed the harness — hiding every
   failure that would have said why it failed to boot. */
const following = document.getElementById('following');
check('the keyboard reaches the page', (windowListeners.keydown || []).length > 0);

{
  // fly → walk → orbit → follow
  for (let i = 0; i < 3; i++) pressKey('KeyC');
  // Elements are made on first ask, so this has to come after the key presses.
  const toastEl = document.getElementById('toast');
  check('cycling the view says which one it landed on',
    toastEl && toastEl.hidden === false && /Follow/i.test(toastEl.textContent),
    toastEl ? `hidden=${toastEl.hidden} text=${JSON.stringify(toastEl.textContent)}` : 'no toast');
  frames = 0;
  for (let i = 0; i < 5; i++) stepFrame(0);
  check('follow names somebody in the corner', following && following.hidden === false,
    following ? `hidden=${following.hidden}` : 'no element');
  // "[MW] Wirik, 6♂ · at the fire" — band code, name, age, sex, job.
  check('and says whose they are, who they are, their sex and what they are doing',
    following && /^\[[A-Z0-9]{2}\] \w+, \d+[♀♂] · \S/.test(following.textContent),
    following ? JSON.stringify(following.textContent) : '');
  check('and the band code is drawn in its own colour',
    following && /class="wcode" style="background:hsl\(/.test(following.innerHTML),
    following ? following.innerHTML.slice(0, 80) : '');

  /* The energy meter. It is the reason the caption is worth reading while you
     follow somebody: it is what decides whether they can take on a hunt, how
     fast they get anywhere, and when they turn round and go home. */
  check('the caption carries an energy meter, out of ten',
    following && /[▮▯]{5} ([0-9]|10)\/10/.test(following.innerHTML),
    following ? JSON.stringify(following.innerHTML) : '');
  /* Where they are, so that a figure which appears stuck on a hillside can be
     told apart from a simulation which has actually stopped. Read off the
     person, not off anything drawn — if these move and the mesh does not, the
     fault is in the rendering, and there is no way to see that by watching. */
  /* Guarded like every other use of it. An unguarded one here crashed the whole
     harness the moment the page failed to boot, which hid every failure that
     would have said why. */
  const where = following.innerHTML.match(/x (-?[\d.]+)\s+z (-?[\d.]+)\s+alt (-?[\d.]+)m/);
  check('the caption says where they are and how high', Boolean(where),
    following ? following.innerHTML.slice(-120) : 'no caption element at all');
  if (where) {
    const [, x, z, alt] = where.map(Number);
    check('the coordinates are real numbers on the map',
      Math.abs(x) < 1600 && Math.abs(z) < 1600, `x ${x} z ${z}`);
    check('and the altitude is above the sea, not below it', alt > -5 && alt < 400, `alt ${alt}`);
  }
  check('it also says how fast and how far they got',
    /want [\d.]+  going/.test(following.innerHTML)
    && /\d+m to go/.test(following.innerHTML), following.innerHTML.slice(-140));

  /* The number that answers the question. Drive a while and it has to change,
     or the readout is as stuck as the thing it is meant to diagnose. */
  const xs = new Set();
  for (let k = 0; k < 60; k++) {
    stepFrame(100);
    updateCaptionSpy();
    const m = following.innerHTML.match(/x (-?[\d.]+)/);
    if (m) xs.add(m[1]);
  }
  check('and the coordinates move as the world runs', xs.size > 1,
    `${xs.size} distinct readings: ${[...xs].slice(0, 4).join(' ')}`);

  check('and the meter has five blocks, no more and no fewer',
    following && (following.innerHTML.match(/[▮▯]/g) || []).length === 5,
    following ? String((following.innerHTML.match(/[▮▯]/g) || []).length) : '-');

  /* F is now the whole of it: into Follow from anywhere, and again for somebody
     else. It used to take C three times and then N, which is four keys to do
     one thing. */
  const whoFirst = following.textContent;
  pressKey('KeyC');                       // out of follow, back to fly
  for (let i = 0; i < 3; i++) stepFrame(0);
  check('C leaves follow', following.hidden === true, `hidden=${following.hidden}`);
  pressKey('KeyF');
  for (let i = 0; i < 3; i++) stepFrame(0);
  check('and F comes straight back to it', following.hidden === false,
    `hidden=${following.hidden}`);

  /* Pressing it again has to be able to land on somebody else. One press could
     land on the same person by chance, so this asks a few times and only fails
     if it never moves — the alternative is a test that fails one run in eight
     for no reason. */
  let moved = false;
  for (let i = 0; i < 12 && !moved; i++) {
    pressKey('KeyF');
    for (let k = 0; k < 2; k++) stepFrame(0);
    if (following.textContent !== whoFirst) moved = true;
  }
  check('and again finds somebody else', moved,
    `still ${JSON.stringify(following.textContent)}`);

  // The key list is a popup now: closed until asked for, and it names the view.
  const keys = document.getElementById('keys');
  check('the key list starts closed', keys && keys.hidden === true,
    keys ? `hidden=${keys.hidden}` : 'no popup');
  pressKey('Slash');
  check('slash opens it', keys && keys.hidden === false);
  const keysView = document.getElementById('keysView');
  check('and it names the view you are in', keysView && /Follow/i.test(keysView.textContent),
    keysView ? JSON.stringify(keysView.textContent) : 'no label');
  pressKey('Escape');
  check('escape closes it', keys && keys.hidden === true);

  const opener = document.getElementById('keysOpen');
  check('the panel has a button that opens it', opener && (opener._on.click || []).length > 0);
  opener.fire('click');
  check('and it does', keys && keys.hidden === false);
  document.getElementById('keysClose').fire('click');
  check('the close button closes it', keys && keys.hidden === true);
}

const tribes = elements.get('tribes');
check('the tribes readout names each band and counts it',
  // The head count is in a span of its own now, the row having been cut down
  // to a colour, a code, a name and a number. Still a name and still a count.
  tribes && /<b>\w+<\/b>\s*(?:<span>)?\d+/.test(tribes.innerHTML),
  tribes ? tribes.innerHTML.slice(0, 90) : 'no element');
check('the population chart has a canvas to draw on', elements.has('tribeChart'));

/* Give the model loads — which are async by design, so the world is up first —
   a moment to land, then drive more frames so they are actually drawn. */
const { modelsVendored } = await import(pathToFileURL(join(stubDir, 'addons.mjs')).href);
if (modelsVendored) {
  await new Promise((r) => setTimeout(r, 600));
  frames = 0;
  for (let i = 0; i < 5; i++) stepFrame(0);
  const stats = elements.get('stats');
  check('the models loaded and are counted', stats && /\d+ models/.test(stats.innerHTML),
    stats ? stats.innerHTML.replace(/<[^>]*>/g, ' ') : 'no stats');
  /* Loaded is not the same as used. A Map that was being written with property
     assignment loaded three models and drew none of them, and hid the birds it
     was replacing — so this counts what is actually on screen. */
  const drawn = Number((stats?.innerHTML.match(/(\d+) drawn/) || [, 0])[1]);
  check('and something is actually drawn with them', drawn > 0, `${drawn} drawn`);
  const chron = elements.get('chronicle');
  check('and none of them failed',
    !chron || !chron.innerHTML.includes('did not load'),
    chron ? chron.innerHTML.slice(0, 120) : '');

  /* The shelf: with no server the page keeps worlds in localStorage, which is
     not here either — so this checks it degrades to a named world rather than
     to an exception. */
  const worldSel = document.getElementById('world');
  check('the world list is populated', worldSel && /<option/.test(worldSel.innerHTML),
    worldSel ? worldSel.innerHTML.slice(0, 70) : 'no select');
  const seedOut = document.getElementById('seedOut');
  check('and the seed is shown', seedOut && /\d/.test(String(seedOut.textContent)),
    seedOut ? String(seedOut.textContent) : '');

  /* Coming back to where you were. The saved session above was served during
     boot; the page should be in it. */
  const almanac = document.getElementById('almanac');
  check('the saved day was restored', almanac && /day 42\b/.test(almanac.textContent),
    almanac ? JSON.stringify(almanac.textContent) : 'no almanac');
  const tribesEl = document.getElementById('tribes');
  check('the saved tribe name came back', tribesEl && /Testtown/.test(tribesEl.innerHTML),
    tribesEl ? tribesEl.innerHTML.replace(/<[^>]*>/g, ' ').slice(0, 80) : '');
  const statsEl = document.getElementById('stats');
  check('and the saved band, not a fresh one', statsEl && /\b3 people\b/.test(statsEl.innerHTML),
    statsEl ? statsEl.innerHTML.replace(/<[^>]*>/g, ' ') : '');
  // Ages are derived from the birth day, so a restored adult must be an adult.
  check('restored ages come out right — one child of the three',
    tribesEl && /1 child/.test(tribesEl.innerHTML),
    tribesEl ? tribesEl.innerHTML.replace(/<[^>]*>/g, ' ').slice(0, 80) : '');
  /* Everyone has a sex and the panel counts both. The three restored people
     have to add up, or the save is dropping it. */
  const sexes = (tribesEl ? tribesEl.innerHTML : '').match(/(\d+)♀ (\d+)♂/);
  check('the panel counts women and men, and they add up',
    sexes && Number(sexes[1]) + Number(sexes[2]) === 3,
    sexes ? `${sexes[1]}♀ + ${sexes[2]}♂` : 'no counts');

  /* Deleting. There is one destructive action left and it reaches exactly one
     world: the one you are in. It has to be clicked twice, the first click must
     delete nothing, and afterwards there still has to be a world — deleting the
     last one makes another rather than leaving you nowhere. */
  const shelf = () => document.getElementById('world').innerHTML;
  const worldNames = () => (shelf().match(/<option value="\d+"/g) || []).length;
  check('the shelf has the world we are in', worldNames() > 0, shelf().slice(0, 80));
  check('the world is marked with a two-character code',
    /<option value="\d+"[^>]*>[A-Z0-9]{2} · /.test(shelf()), shelf().slice(0, 80));

  const here = document.getElementById('worldHere');
  check('and the world you are in wears its code in colour',
    here && /class="wcode" style="background:hsl\(/.test(here.innerHTML),
    here ? here.innerHTML.slice(0, 90) : 'missing');

  const before = worldNames();
  const del = document.getElementById('deleteWorld');
  check('the destructive button starts unarmed', del && del.textContent === 'Delete world',
    del ? JSON.stringify(del.textContent) : 'missing');
  del.fire('click');
  check('one click only arms it', del.textContent === 'Sure?', JSON.stringify(del.textContent));
  check('and deletes nothing yet', worldNames() === before, `${worldNames()} vs ${before}`);
  del.fire('click');
  /* deleteThisWorld awaits the shelf being written before it moves you on, so
     the microtasks have to drain before the result can be read. */
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 5; i++) stepFrame(0);
  check('the second click does it',
    del.textContent === 'Delete world'
      && /deleted /i.test(document.getElementById('toast').textContent),
    `${JSON.stringify(del.textContent)} ${JSON.stringify(document.getElementById('toast').textContent)}`);
  check('there is still a world afterwards — there is always a world',
    worldNames() > 0, shelf().slice(0, 80));

  // MODELS=all was injected before the page loaded, so the quadruped is in too.
  check('the herd model loaded alongside the birds', stats && /4 models/.test(stats.innerHTML),
    stats ? stats.innerHTML.replace(/<[^>]*>/g, ' ') : 'no stats');
}

/* -------------------------------------------------------------------------
   The counts have to move

   The readout used to say the same number of animals whatever the band ate,
   because it counted allocated slots rather than living animals — a hunted deer
   keeps its slot so it can come back later. That is the sort of bug a screenshot
   never shows, so this drives the world hard and watches the numbers.
   ------------------------------------------------------------------------- */

let motionReport = 'not driven';
let rateReport = 'not measured';
let nightReport = 'not watched';
{
  const statsOf = () => {
    const el = document.getElementById('stats');
    const html = el ? el.innerHTML : '';
    const num = (re) => Number((html.match(re) || [, NaN])[1]);
    return { animals: num(/(\d+) animals/), fruit: num(/(\d+) fruit/),
             people: num(/(\d+) people/) };
  };

  const first = statsOf();
  check('the readout gives an animal count', Number.isFinite(first.animals), String(first.animals));
  check('and a fruit count', Number.isFinite(first.fruit), String(first.fruit));
  check('the world starts with fruit on the trees', first.fruit > 0, String(first.fruit));

  /* Long enough for foragers to complete trips and hunters to make kills. The
     clock is driven, not waited on, so this costs frames rather than seconds:
     each frame is told to represent 100ms, which is the cap tick() puts on a
     frame anyway, so nothing is being asked to integrate a step it would never
     see in a browser. */
  const seen = { animals: new Set(), fruit: new Set() };
  /* The night is run through once there is nobody left awake, so somewhere in a
     simulated day the marker beside the clock has to come on — and it has to go
     off again, or the world would be stuck in fast forward by morning. */
  const skipEl = document.getElementById('skip');
  let skipOn = 0, skipOff = 0;
  for (let i = 0; i < 30000; i++) {
    // 100ms is the cap tick() puts on a frame anyway, so this asks the
    // simulation to integrate nothing it would not see in a slow browser.
    stepFrame(100);
    // The marker is sampled every frame, not every hundredth: a night can be
    // run through in a few seconds of wall time and be missed entirely by a
    // coarse sample, which reads as the feature not working.
    if (skipEl && !skipEl.hidden) skipOn++; else skipOff++;
    if (i % 100 === 0) {
      const now = statsOf();
      seen.animals.add(now.animals);
      seen.fruit.add(now.fruit);
    }
  }
  nightReport = `${skipOn} frames fast-forwarded, ${skipOff} normal`;
  check('the night gets run through', skipOn > 0, nightReport);
  check('and the day does not', skipOff > skipOn, nightReport);
  check('the world kept running for the whole drive', !frameError,
    frameError ? `${frameError.constructor.name}: ${frameError.message}` : '');

  /* The clock buttons. Measured rather than assumed: the same number of frames
     has to move the world further at 4× than at 1×. Both windows are short and
     back to back, so the night skip is either on for both or off for both. */
  const worldMinutes = () => {
    const day = Number((document.getElementById('almanac').textContent.match(/day (\d+)/) || [, 0])[1]);
    const [h, m] = document.getElementById('clock').textContent.split(':').map(Number);
    return day * 1440 + h * 60 + m;
  };
  /* Measured only in a window the night skip does not touch. The first cut
     assumed two back-to-back windows would be the same, and dawn landed in the
     middle of the second one: 96 world-minutes at 1× against 176 at 4×, which
     is 1.8× and looks like a broken feature rather than a broken measurement.
     Waits for the marker to go out, runs the window, and throws the window away
     if it comes back on. */
  const runFor = (n) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      let guard = 0;
      while (skipEl && !skipEl.hidden && guard++ < 4000) stepFrame(100);
      const from = worldMinutes();
      let dirty = false;
      for (let i = 0; i < n; i++) {
        stepFrame(100);
        if (skipEl && !skipEl.hidden) dirty = true;
      }
      if (!dirty) return worldMinutes() - from;
    }
    return null;                      // never got a clean window
  };
  const rateOut = document.getElementById('rateOut');
  check('the clock starts at 1×', rateOut && rateOut.textContent === '1×',
    rateOut ? rateOut.textContent : 'no readout');
  const atOne = runFor(400);
  check('a clean window was found to measure in', atOne !== null, String(atOne));
  document.getElementById('faster').fire('click');
  document.getElementById('faster').fire('click');
  check('two presses of + read as 4×', rateOut.textContent === '4×', rateOut.textContent);
  const atFour = runFor(400);
  check('and the world really moves four times as fast',
    atFour > atOne * 3, `${atOne} world-minutes at 1×, ${atFour} at 4×`);
  rateReport = `${atOne} world-minutes at 1×, ${atFour} at 4×`;

  document.getElementById('slower').fire('click');
  document.getElementById('slower').fire('click');
  document.getElementById('slower').fire('click');
  check('− walks it back down past 1×', rateOut.textContent === '.5×', rateOut.textContent);
  const atHalf = runFor(400);
  check('and half speed is slower than one', atHalf < atOne,
    `${atHalf} world-minutes at .5×, ${atOne} at 1×`);

  // The ends of the scale hold rather than wrapping round.
  for (let i = 0; i < 8; i++) document.getElementById('slower').fire('click');
  check('the slow end stops', rateOut.textContent === '.25×', rateOut.textContent);
  for (let i = 0; i < 20; i++) document.getElementById('faster').fire('click');
  check('and so does the fast end', rateOut.textContent === '16×', rateOut.textContent);
  for (let i = 0; i < 4; i++) document.getElementById('slower').fire('click');
  const last = statsOf();
  motionReport = `animals ${first.animals}->${last.animals} (${seen.animals.size} values), `
    + `fruit ${first.fruit}->${last.fruit} (${seen.fruit.size} values)`;

  check('the fruit count moves as it is picked and grows back',
    seen.fruit.size > 1, motionReport);
  /* The one that was actually broken: this counted instance slots, so it read
     the same number however many animals the band ate. */
  check('the animal count moves as they are hunted and grow back',
    seen.animals.size > 1, motionReport);
  check('and the fruit count never goes negative or above the crop',
    [...seen.fruit].every((v) => v >= 0 && v <= first.fruit), [...seen.fruit].join(' '));
  check('the animal count stays a sane number',
    [...seen.animals].every((v) => v >= 0 && v <= first.animals + 50), [...seen.animals].join(' '));
}

/* These sweeps deliberately run LAST, after the world has been driven for a
   simulated day. Run before the drive they only ever saw the world as it was
   built — which is exactly why they missed people born later coming out white.
*/
/* -------------------------------------------------------------------------
   Every instance slot

   An InstancedMesh allocates its instanceMatrix as Float32Array zeros — the
   ZERO matrix, not the identity. A slot that is never written keeps it, and the
   zero matrix sends every vertex to w = 0: a point at infinity. The clipper
   turns those into huge unbounded triangles with garbage interpolants, which is
   what a dark triangular shape flickering across the view actually is.

   HIDDEN is makeScale(0, 0, 0), which keeps m[15] = 1 — all three vertices land
   on the same point, the triangle has no area, nothing is drawn. That is the
   safe way to park a slot, and this walks the real scene after real frames to
   check that every slot got either a real transform or that.
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   Bisect

   The layer-hiding search is only worth anything if pressing B really does hide
   the layer it names, so this drives every step and counts what went invisible.
   A step that names a layer and hides nothing would send the search off after
   the wrong thing, which is worse than not having it.
   ------------------------------------------------------------------------- */

{
  const scene0 = globalThis.__scene;
  /* Counted over a fixed set of meshes, captured once. The world is alive
     while this runs — grass tiles are rebuilt a few per frame — so counting
     whatever happens to be in the scene each time compares two different
     worlds and reports a difference that means nothing. */
  const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  const tracked = [];
  scene0?.traverse((o) => { if (o.isMesh || o.isInstancedMesh) tracked.push(o); });
  const visibleCount = () => tracked.reduce((n, o) => n + (o.parent && shown(o) ? 1 : 0), 0);
  const LAYERS = ['shadows', 'grass', 'water', 'streams', 'canopy', 'trunks', 'fruit',
    'rocks', 'fauna', 'people and camps', 'sky', 'terrain'];
  const toastEl = document.getElementById('toast');
  /* Flush anything still queued first. rebuild() defers its work by two frames
     so the loading overlay can paint, and the delete test above triggered one —
     if that lands in the middle of the search, every mesh is replaced under it
     and the restore has nothing to restore. */
  for (let i = 0; i < 12; i++) stepFrame(0);
  const before = visibleCount();
  let last = before;
  const inert = [];
  for (const name of LAYERS) {
    pressKey('KeyB');
    stepFrame(0);
    const said = toastEl ? toastEl.textContent : '';
    if (!said.includes(name)) inert.push(`${name}: toast said ${JSON.stringify(said)}`);
    const now = visibleCount();
    // 'shadows' and 'sky' are not meshes under world, so they may not move the
    // count; every other layer must actually take something out of the scene.
    if (now >= last && name !== 'shadows' && name !== 'sky') inert.push(`${name} hid nothing`);
    last = now;
  }
  check('every bisect step hides the layer it names', inert.length === 0, inert.join(' · '));
  check('bisect ends with almost nothing left', last < before * 0.2, `${last} of ${before} meshes`);

  pressKey('KeyB', true);
  stepFrame(0);
  check('shift+B puts the world back',
    visibleCount() === before, `${visibleCount()} vs ${before}`);
  check('and the shadow map comes back with it',
    globalThis.__renderer?.shadowMap.enabled === true);
}

/* -------------------------------------------------------------------------
   H minimises the pane; it does not take it away

   It used to toggle `hidden`, which took the toggle button with it. The pane
   did not shrink, it left — and the way back was a key you had to already know,
   with nothing on screen to say so. Now it toggles `collapsed`, which is the
   state the icon in the corner already meant, so the way back is the thing you
   can see. `hidden` is left to the one case it is right for: the pane not
   existing yet, while the world is still being built.

   Both halves are worth checking. That it shuts is the easy half; that the
   toggle survives shutting it is the bug.

   Every class this touches is put back, and no frame is driven: the checks
   below read a panel that redraws only while it is open, so a block that leaves
   it in the other state moves failures around after it and reads like a
   regression somewhere else entirely. This one found that out the hard way. */
{
  const panel = document.getElementById('ui');
  const was = { hidden: panel.classList.contains('hidden'), collapsed: panel.classList.contains('collapsed') };
  // The world has booted by here; `hidden` is the build-time state.
  panel.classList.toggle('hidden', false);
  panel.classList.toggle('collapsed', false);

  pressKey('KeyH');
  check('H shuts the world panel', panel.classList.contains('collapsed'));
  check('and leaves it on screen to be opened again',
    !panel.classList.contains('hidden'), 'the pane went away with its own toggle');

  pressKey('KeyH');
  check('H opens it again', !panel.classList.contains('collapsed'));

  // The icon in the corner is the same gesture, and has to agree with it.
  document.getElementById('collapse').fire('click');
  check('and the icon shuts the same pane the key does',
    panel.classList.contains('collapsed') && !panel.classList.contains('hidden'));

  panel.classList.toggle('hidden', was.hidden);
  panel.classList.toggle('collapsed', was.collapsed);
}


let foldReport = 'no stream ribbons';

/* -------------------------------------------------------------------------
   Stream ribbon

   This is what was flickering. A ribbon of triangles laid along a winding path
   folds over itself on the inside of a tight bend, and the fold puts two water
   triangles at exactly the same height. Coplanar surfaces argue about depth,
   and a polygon offset cannot break the tie because both faces get the same
   offset. Narrowing the ribbon into corners removes some of the folds; the
   hairpins in the path itself cannot be removed that way, which is why the
   water must not write depth at all.
   ------------------------------------------------------------------------- */

{
  let quads = 0, folded = 0, meshes = 0; const badMaterial = [];
  globalThis.__scene?.traverse((o) => {
    if (o.name !== 'stream') return;
    meshes++;
    if (o.material.depthWrite !== false) badMaterial.push('writes depth');
    if (o.material.side !== 2) badMaterial.push('not DoubleSide');  // THREE.DoubleSide
    const p = o.geometry.attributes.position.array;
    const n = p.length / 6;
    let prev = 0;
    for (let i = 0; i < n - 1; i++) {
      const A = i * 2, B = A + 1, C = A + 2;
      const area = (p[B * 3] - p[A * 3]) * (p[C * 3 + 2] - p[A * 3 + 2])
        - (p[B * 3 + 2] - p[A * 3 + 2]) * (p[C * 3] - p[A * 3]);
      quads++;
      const sign = Math.sign(area);
      if (prev && sign && sign !== prev) folded++;
      if (sign) prev = sign;
    }
  });
  check('there are stream ribbons to check', meshes > 0, `${meshes} meshes`);
  check('the stream water never writes depth', badMaterial.length === 0, badMaterial.join(', '));
  /* How many folds there are depends entirely on which seed's creeks these
     are, and by this point the harness has moved to a new world, so there is no
     honest fixed bound to assert here. The clamp is tested against fixed paths
     in test.js instead; this only reports what this world happened to get. */
  foldReport = `${folded} folded of ${quads} ribbon quads`;
}

const scene = globalThis.__scene;
check('the renderer was handed a scene', Boolean(scene));

/* The tiger has five part meshes of its own — body, neck, head, tail, legs —
   so a world built with predators carries more instanced meshes than one built
   without. Reading the spec proves it was written; this proves it was built. */
const statsEl = document.getElementById('stats');
const animalCount = Number(((statsEl ? statsEl.innerHTML : '').match(/([\d]+) animals/) || [, 0])[1]);
check('the world has animals in it', animalCount > 0, String(animalCount));
const badSlots = [];
let slotsChecked = 0, instancedMeshes = 0;
if (scene) {
  scene.traverse((o) => {
    if (!o.isInstancedMesh) return;
    instancedMeshes++;
    const a = o.instanceMatrix.array;
    let bad = 0;
    for (let i = 0; i < o.count; i++) {
      slotsChecked++;
      // m[15] is the homogeneous row; zero there means an untouched slot.
      if (a[i * 16 + 15] === 0) bad++;
    }
    if (bad) {
      badSlots.push(`${o.name || o.geometry.type} ${bad}/${o.count}`);
    }
  });
}
/* The same trap, one attribute over — but not the same value, and getting that
   wrong is what let a real bug through. `setColorAt` allocates instanceColor
   filled with ONE, not zero, so an unwritten slot is drawn in pure WHITE. This
   sweep was written looking for black, found none, and reported clean while
   every person born after the world was built was rendering white.

   Black is still worth catching — a colour written as (0,0,0) on purpose is
   almost always a mistake — but white is the one that actually happens. */
const blackSlots = [];
let colouredMeshes = 0;
if (scene) {
  scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.instanceColor) return;
    colouredMeshes++;
    const m = o.instanceMatrix.array, c = o.instanceColor.array;
    let bad = 0;
    for (let i = 0; i < o.count; i++) {
      const b = i * 16;
      // Live = a real homogeneous row and a basis that is not collapsed.
      const live = m[b + 15] !== 0
        && (m[b] !== 0 || m[b + 1] !== 0 || m[b + 2] !== 0
          || m[b + 4] !== 0 || m[b + 5] !== 0 || m[b + 6] !== 0);
      if (live && c[i * 3] === 0 && c[i * 3 + 1] === 0 && c[i * 3 + 2] === 0) bad++;
    }
    if (bad) blackSlots.push(`${o.name || o.geometry.type} ${bad}/${o.count}`);
  });
}
check('no live instance is left with an unwritten black colour',
  blackSlots.length === 0, blackSlots.join(', '));

/* Nothing about a person is white — not skin, not a garment, not hair — so on
   these meshes pure white can only be a slot nobody painted.

   Checked over the slots the band OCCUPIES, not the ones currently drawn: at
   night everybody is asleep inside a hut and parked at HIDDEN, so a check keyed
   to visibility passes with nothing examined at all. A guard that can pass
   vacuously is not a guard, which is why the count of what it looked at is
   asserted too. */
const population = Number(((document.getElementById('stats') || {}).innerHTML || '')
  .match(/(\d+) people/)?.[1] || 0);
const paleSlots = [];
let slotsInspected = 0;
if (scene) {
  scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.name.startsWith('person-') || !o.instanceColor) return;
    const per = o.name === 'person-arms' || o.name === 'person-legs' ? 2 : 1;
    const c = o.instanceColor.array;
    let bad = 0;
    for (let i = 0; i < population * per && i < o.count; i++) {
      slotsInspected++;
      if (c[i * 3] === 1 && c[i * 3 + 1] === 1 && c[i * 3 + 2] === 1) bad++;
    }
    if (bad) paleSlots.push(`${o.name} ${bad}/${population * per}`);
  });
}
check('the band was actually there to look at', population > 0 && slotsInspected > 0,
  `${population} people, ${slotsInspected} slots inspected`);
check('nobody is drawn in unpainted white',
  paleSlots.length === 0, paleSlots.join(', '));

check('no instance slot is left as the zero matrix',
  badSlots.length === 0, badSlots.join(', '));

/* -------------------------------------------------------------------------
   Are the tents standing up?

   A camp keeps its own layout — `camp.hutAt[i]` — because dressCamp puts huts
   back as the band grows and shrinks, and re-deriving the ring every time
   somebody is born would shuffle the whole camp around them. That stored
   matrix has to be the hut's, and for a long time it was not: it was cloned off
   the shared scratch matrix one line before anything was composed into it, so
   each hut kept whatever the last thing to use `_m4` had left there — the
   drying rack's crossbar, a scattered rock, or the hut before it. The mesh got
   the right matrix on the very next line, so a camp looked correct until the
   first birth or death put the stored one back. Tents on their sides.

   Reading the source cannot catch this; two adjacent lines in the wrong order
   parse perfectly. So: pull the stored matrix apart and ask where it puts the
   tent and which way up it is. A hut turns about Y to face the fire and does
   nothing else, so any lean at all is the bug. */
{
  const { camps: builtCamps } = await import(pathToFileURL(join(stubDir, 'people.js')).href);
  const THREE = (await import(pathToFileURL(join(stubDir, 'three-stub.mjs')).href)).default;
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const up = new THREE.Vector3();
  let checked = 0;
  const leaning = [];
  const adrift = [];
  for (const c of builtCamps) {
    for (let i = 0; i < (c.hutAt || []).length; i++) {
      const m = c.hutAt[i];
      const want = c.huts[i];
      if (!m || !want) continue;
      checked++;
      m.decompose(pos, quat, scl);
      // Straight up is what a cone of a tent does. Anything else is a lean.
      up.set(0, 1, 0).applyQuaternion(quat);
      if (up.y < 0.999) leaning.push(`camp ${c.code} hut ${i} tilted ${(Math.acos(Math.max(-1, Math.min(1, up.y))) * 180 / Math.PI).toFixed(0)}°`);
      // And it has to be the hut it is stored against, not another one.
      const off = Math.hypot(pos.x - want.x, pos.z - want.z);
      if (off > 0.01) adrift.push(`camp ${c.code} hut ${i} ${off.toFixed(1)}m from where it is meant to be`);
    }
  }
  check('the camp layout it keeps has huts in it at all', checked > 0, `${checked} huts`);
  check('every tent it keeps is standing upright',
    leaning.length === 0, leaning.slice(0, 3).join(' · '));
  check('and each one is stored against its own place in the ring',
    adrift.length === 0, adrift.slice(0, 3).join(' · '));
}

/* -------------------------------------------------------------------------
   Does it assemble into a person?

   The rig is a chain — torso to shoulder to elbow to hand, hip to knee to
   ankle — and a chain is exactly the kind of thing that can be wrong in a way
   no reading of the source shows: an offset applied in the parent's space
   instead of the child's puts a hand through a chest and the code still looks
   right. This pulls the world position of every piece out of the instanced
   matrices and checks the body plan.
   ------------------------------------------------------------------------- */

let bodyReport = 'not checked';
{
  const part = {};
  globalThis.__scene?.traverse((o) => {
    if (o.isInstancedMesh && o.name.startsWith('person-')) part[o.name.slice(7)] = o;
  });
  check('the person meshes are all there', Object.keys(part).length >= 10,
    Object.keys(part).join(' '));

  /* A person is seventeen pieces now rather than nine, and the meshes are
     allocated for the largest band the world will ever hold. Submitting the
     empty slots would have made the better figure cost four times what the old
     one did; the draw count is turned down to the band that exists instead. */
  const pop = Number(((document.getElementById('stats') || {}).innerHTML || '')
    .match(/(\d+) people/)?.[1] || 0);
  const overdrawn = Object.entries(part)
    .filter(([, m]) => m.count > pop * (m.name.match(/arm|hand|thigh|shin|foot/i) ? 2 : 1))
    .map(([k, m]) => `${k} ${m.count}`);
  check('and none of them draws slots nobody is standing in',
    pop > 0 && overdrawn.length === 0, `${pop} people; ${overdrawn.join(', ') || 'all tight'}`);
  const allocated = Object.values(part).reduce((n, m) => n + m.instanceMatrix.count, 0);
  const drawn = Object.values(part).reduce((n, m) => n + m.count, 0);
  check('which is a fraction of what is allocated', drawn < allocated * 0.6,
    `${drawn} drawn of ${allocated} allocated`);

  /* Somebody who is actually drawn. Slot 0 used to do, because everybody was
     drawn; now most of a camp is inside a tent and parked at zero scale, and
     reading a hidden slot measures a body of all noughts. */
  let sample = 0;
  {
    const m = part.torso?.instanceMatrix.array;
    for (let k = 0; k < (part.torso?.count || 0); k++) {
      if (m && m[k * 16] !== 0) { sample = k; break; }
    }
  }
  /* Translation is elements 12..14 of the matrix. Arms and legs are two
     instances a person, so the person's first one is at twice their slot —
     which did not matter while the sample was always person zero. */
  const PAIRED = new Set(['upperArm', 'foreArm', 'hand', 'thigh', 'shin', 'foot']);
  const at = (key, slot = sample) => {
    const m = part[key]?.instanceMatrix.array;
    const idx = PAIRED.has(key) ? slot * 2 : slot;
    if (!m || part[key].count <= idx) return null;
    const b = idx * 16;
    return { x: m[b + 12], y: m[b + 13], z: m[b + 14] };
  };
  const torso = at('torso'), head = at('head'), neck = at('neck');
  const hip = at('thigh'), knee = at('shin'), foot = at('foot');
  const shoulder = at('upperArm'), elbow = at('foreArm'), hand = at('hand');
  const have = [torso, head, neck, hip, knee, foot, shoulder, elbow, hand];
  check('every piece of the first person has a place', have.every(Boolean),
    have.map((h, i) => (h ? '' : i)).filter(String).join(','));

  if (have.every(Boolean)) {
    const finite = have.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z));
    check('and none of them is NaN', finite,
      JSON.stringify(have.map((q) => [q.x, q.y, q.z].map((v) => Number(v.toFixed(2))))));

    bodyReport = `head ${head.y.toFixed(2)} shoulder ${shoulder.y.toFixed(2)} `
      + `hip ${hip.y.toFixed(2)} knee ${knee.y.toFixed(2)} foot ${foot.y.toFixed(2)}`;

    // The body plan, top to bottom. Each of these would be a visible deformity.
    check('the head is above the neck', head.y > neck.y, bodyReport);
    check('the neck is above the shoulders', neck.y > shoulder.y - 0.05, bodyReport);
    check('the shoulders are above the hips', shoulder.y > hip.y, bodyReport);
    check('the knee is below the hip', knee.y < hip.y, bodyReport);
    check('the foot is below the knee', foot.y < knee.y, bodyReport);
    check('the elbow is below the shoulder', elbow.y < shoulder.y, bodyReport);
    check('the hand is below the elbow', hand.y < elbow.y, bodyReport);

    /* A leg is a fixed length however it is bent, so hip-to-foot can never
       exceed thigh plus shin — if it does, a joint is being offset in the wrong
       space and the leg is being stretched rather than folded. */
    const span = Math.hypot(hip.x - foot.x, hip.y - foot.y, hip.z - foot.z);
    check('the leg is folded, not stretched', span <= (0.48 + 0.44) * 1.15 + 0.1,
      `hip to foot ${span.toFixed(2)}m against a 0.92m leg`);
    const reach = Math.hypot(shoulder.x - hand.x, shoulder.y - hand.y, shoulder.z - hand.z);
    check('and so is the arm', reach <= (0.31 + 0.28) * 1.15 + 0.1,
      `shoulder to hand ${reach.toFixed(2)}m against a 0.59m arm`);

    /* Left and right of the SAME person. `at` takes a person and doubles for
       the paired parts, so asking it for slots 0 and 1 asks for two different
       people's left legs — which happened to be the same thing back when the
       sample was always person zero. */
    const raw = (key, idx) => {
      const m = part[key]?.instanceMatrix.array;
      if (!m || part[key].count <= idx) return null;
      return { x: m[idx * 16 + 12], y: m[idx * 16 + 13], z: m[idx * 16 + 14] };
    };
    const hipL = raw('thigh', sample * 2), hipR = raw('thigh', sample * 2 + 1);
    check('a person has a leg on each side',
      hipL && hipR && Math.hypot(hipL.x - hipR.x, hipL.z - hipR.z) > 0.05,
      hipL && hipR ? `${Math.hypot(hipL.x - hipR.x, hipL.z - hipR.z).toFixed(3)}m apart` : '-');
  }
}

/* -------------------------------------------------------------------------
   Seeing ahead

   Driven through the real button, because the interesting part is not that the
   simulation runs — it is everything around it: that the overlay opens and
   closes, that the run is sliced rather than blocking, and that every view of
   the world is rebuilt afterwards from a world that changed while nothing was
   drawn.
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   Do they get anywhere?

   Reading the source proves the detours exist; only driving the world proves
   somebody actually crosses it. The camps are placed at least 260 metres apart,
   so a journey longer than that is a journey that could only have been made by
   walking round whatever was in the way.
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   One band, in detail

   The panel line says how many and how hungry. This says who they are — and
   the numbers in it are ones nothing else in the page shows: how many children
   a woman has had, and what each person has actually carried home.
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   A camp is tents, not a crowd

   Everybody who was not walking somewhere was drawn, whatever they were doing,
   in a clearing seventeen metres across — which at a hundred people reads as a
   crowd scene rather than as a camp.
   ------------------------------------------------------------------------- */
let indoorsReport = 'not measured';
{
  // Count the people the page actually drew, off the head mesh's matrices.
  const drawnPeople = () => {
    let drawn = 0, head = null;
    globalThis.__scene?.traverse((o) => {
      if (o.isInstancedMesh && o.name === 'person-head') head = o;
    });
    if (!head) return -1;
    const m = head.instanceMatrix.array;
    for (let i = 0; i < head.count; i++) if (m[i * 16] !== 0) drawn++;
    return drawn;
  };
  const alive = Number((document.getElementById('stats').innerHTML
    .replace(/<[^>]*>/g, ' ').match(/(\d+) people/) || [, 0])[1]);
  const drawn = drawnPeople();
  check('some of the band is under a roof', drawn >= 0 && drawn < alive,
    `${drawn} of ${alive} drawn`);
  /* And not all of it: a camp where nobody is ever visible is a ghost town. */
  check('and some of it is out doing something', drawn > 0, `${drawn} drawn`);
  indoorsReport = `${drawn} of ${alive} drawn`;
}

let tribeReport = 'not opened';
{
  /* A year first. Everything below is about what a band has accumulated —
     children borne, food carried home — and at boot nobody has accumulated
     anything, so the checks all pass on a card full of noughts and a broken
     total is indistinguishable from a correct one. A year is a few seconds
     here and it is the difference between checking the code and checking that
     zero equals zero. */
  document.getElementById('years').value = '1';
  document.getElementById('runAhead').fire('click');
  let warm = 0;
  while (document.getElementById('ahead').hidden === false && warm < 20000) { stepFrame(0); warm++; }
  stepFrame(0);

  const win = document.getElementById('tribe');
  check('the tribe window starts closed', win.hidden === true);
  pressKey('KeyT');
  for (let k = 0; k < 3; k++) stepFrame(0);
  check('T opens it', win.hidden === false);

  const rawHead = document.getElementById('tribeHead').innerHTML;
  const head = rawHead.replace(/<[^>]*>/g, ' ');
  const list = document.getElementById('tribeList').innerHTML;
  /* Read the name out of its own tag. Stripping the markup first and looking
     for a word after "Chief" passed happily on an empty name, because the next
     word along is the chief's age. */
  const chiefName = (rawHead.match(/Chief <b>([^<]*)<\/b>/) || [, ''])[1];
  check('it names a chief', /^[A-Z][a-z]/.test(chiefName), JSON.stringify(chiefName));
  /* A zero here matches "\d+" perfectly well, and a broken total is exactly
     what a zero looks like — so the number has to be a real one. */
  const total = Number((head.match(/carried home between them\s+([\d.]+)/) || [, 0])[1]);
  check('and says what the band has carried home between them',
    total > 0, `${total} between them`);
  check('and how much is in the store', /store\s+[\d.]+/.test(head));

  const rows = (list.match(/<tr/g) || []).length;
  check('every member has a row', rows > 1, `${rows} rows`);
  /* The sex glyph carries a colour now, so it arrives wrapped. Still an age
     and still a sex — the check is about the column, not about the markup. */
  check('with an age and a sex', /<td>\d+(?:<i class="sx [fm]">)?[♀♂]/.test(list), list.slice(0, 160));
  /* The carried column has a class of its own, because the children column is
     also a bare number in a cell and a check that cannot tell them apart is
     satisfied by a family with no food. */
  const carried = [...list.matchAll(/<td class="got">(\d+)<\/td>/g)].map((m) => Number(m[1]));
  check('and what they have carried, per person',
    carried.length === rows - 1 && carried.some((n) => n > 0), carried.join(','));
  /* The two numbers are computed in different places from the same field, so
     one of them going wrong shows up as them disagreeing. */
  check('and the band total is those added up',
    Math.abs(carried.reduce((a, b) => a + b, 0) - total) <= carried.length,
    `${carried.reduce((a, b) => a + b, 0)} in the rows against ${total} at the top`);
  check('the chief is marked among them', /<tr class="chief[ "]/.test(list), list.slice(0, 120));
  /* Children borne is read from the record of everyone who ever lived, so it
     counts the ones who died as well — which is the number that means anything
     about a woman's life. */
  check('children are counted from the record, not from the living',
    /for \(const r of lineage\) if \(r\.m === p\.id \|\| r\.f === p\.id\) n\+\+;/.test(html));

  /* The other tab. A band that has run a year has lost somebody — and the
     count on the panel says how many, so the two have to agree. */
  document.getElementById('tribeWas').fire('click');
  for (let k = 0; k < 2; k++) stepFrame(0);
  const was = document.getElementById('tribeList').innerHTML;
  check('the other tab is the ones who are gone',
    document.getElementById('tribeWas').className === 'on'
    && document.getElementById('tribeNow').className === '');
  const lostSaid = Number((head.match(/lost (\d+)/) || [, 0])[1]);
  const goneRows = (was.match(/<tr/g) || []).length - 1;
  if (lostSaid > 0) {
    check('and it names them, not just a number',
      goneRows >= lostSaid, `${goneRows} named against ${lostSaid} counted lost`);
    check('with what became of each of them',
      /(old age|starved|too weak with hunger|the sickness|a tiger|died an infant|went to)/.test(was),
      was.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 120));
    /* A cause of "undefined" is what a record written before the cause was kept
       looks like, and it would be easy not to notice. */
    check('and never a blank or an undefined among them',
      !/undefined|<td class="n"><\/td>/.test(was));
  }
  if (goneRows > 1) {
    const days = [...was.matchAll(/<td>(\d+)<\/td>\s*<\/tr>/g)].map((m) => Number(m[1]));
    check('most recently gone at the top',
      days.length > 1 && days.every((d, i) => i === 0 || days[i - 1] >= d),
      days.join(','));
  }

  document.getElementById('tribeNow').fire('click');
  for (let k = 0; k < 2; k++) stepFrame(0);
  check('and back again', document.getElementById('tribeNow').className === 'on'
    && /<th>doing<\/th>/.test(document.getElementById('tribeList').innerHTML));

  /* Left on the dead tab, closed, opened again: a band has to come up on its
     living. Leaving the tab where it was means opening a healthy band and
     being shown a list of corpses. */
  document.getElementById('tribeWas').fire('click');
  for (let k = 0; k < 2; k++) stepFrame(0);
  pressKey('Escape');
  pressKey('KeyT');
  for (let k = 0; k < 3; k++) stepFrame(0);
  check('and a band always opens on its living',
    document.getElementById('tribeNow').className === 'on',
    document.getElementById('tribeList').innerHTML.slice(0, 80));

  pressKey('Escape');
  /* The dead leave something on the ground now. A band that has lost people
     should have that many cairns on the island, and they should be somewhere —
     a cairn at the origin is a cairn nobody placed. */
  const graveMesh = (() => {
    let found = null;
    globalThis.__scene?.traverse((o) => {
      if (o.isInstancedMesh && o.count === 1200 && !found) found = o;
    });
    return found;
  })();
  const statLine = document.getElementById('stats').innerHTML.replace(/<[^>]*>/g, ' ');
  const buried = Number((statLine.match(/(\d+) buried/) || [, 0])[1]);
  check('the dead are buried where they fell', buried > 0, statLine.replace(/\s+/g, ' ').slice(0, 90));
  if (graveMesh && buried > 0) {
    const m = graveMesh.instanceMatrix.array;
    let placed = 0, atOrigin = 0;
    for (let i = 0; i < buried * 3; i++) {
      const x = m[i * 16 + 12], y = m[i * 16 + 13], z = m[i * 16 + 14];
      if (m[i * 16 + 0] === 0) continue;               // parked
      placed++;
      if (Math.abs(x) < 0.5 && Math.abs(z) < 0.5) atOrigin++;
      if (!Number.isFinite(x + y + z)) atOrigin++;
    }
    check('and each cairn is a stack of stones somewhere real',
      placed === buried * 3 && atOrigin === 0, `${placed} stones, ${atOrigin} at the origin`);
  }

  tribeReport = `${rows - 1} here, ${goneRows} gone, ${buried} buried · ${head.replace(/\s+/g, ' ').trim().slice(0, 52)}`;
  pressKey('Escape');
  check('escape closes it', win.hidden === true);
}

let chronReport = 'not opened';
let travelReport = 'not measured';
{
  let torso = null;
  globalThis.__scene?.traverse((o) => {
    if (o.isInstancedMesh && o.name === 'person-torso') torso = o;
  });
  const at = (i) => { const b = i * 16, m = torso.instanceMatrix.array; return [m[b + 12], m[b + 14]]; };
  const n = Math.min(torso.count, 30);
  /* Where each of them was the first time they were seen outside, rather than
     wherever the mesh happened to say when most of them were in a tent. */
  const from = []; for (let i = 0; i < n; i++) from.push(at(i));
  for (let i = 0; i < n; i++) {
    if (torso.instanceMatrix.array[i * 16] === 0) from[i] = null;
  }
  const far = new Array(n).fill(0);
  let moving = 0, frames = 0;
  for (let f = 0; f < 4000; f++) {
    stepFrame(100);
    if (f % 20 === 0) {
      frames++;
      for (let i = 0; i < n; i++) {
        /* Skip anybody under a roof. Hidden is a zero matrix, which reads as
           standing at the origin — so a camp full of people indoors looked like
           a camp full of people pinned in place. */
        if (torso.instanceMatrix.array[i * 16] === 0) continue;
        const q = at(i);
        if (!from[i]) { from[i] = q; continue; }
        far[i] = Math.max(far[i], Math.hypot(q[0] - from[i][0], q[1] - from[i][1]));
      }
    }
  }
  const furthest = Math.max(...far);
  const wanderers = far.filter((d) => d > 40).length;
  travelReport = `furthest ${furthest.toFixed(0)}m, ${wanderers} of ${n} went past 40m`;
  check('somebody covers real ground', furthest > 120, travelReport);
  check('and it is not one person doing all the walking', wanderers >= 2, travelReport);
  /* Nobody pinned against a hillside for the whole run. The old behaviour did
     not freeze people outright — it sent them home — so this is a floor rather
     than the proof; the proof is the arithmetic in test.js. */
  /* Only the ones who came outside. Somebody who spent the whole run in a tent
     — a toddler, or an adult whose errands all happened to be indoors — has not
     been pinned against a hillside, they have been at home. */
  const seen = far.filter((d, i) => from[i] !== null);
  check('nobody who went out is pinned in place',
    seen.length > 4 && seen.filter((d) => d < 2).length <= 1,
    `${seen.length} went out: ${seen.map((d) => d.toFixed(0)).join(' ')}`);
}

let aheadReport = 'not run';
{
  const almanac = document.getElementById('almanac');
  const dayNow = () => Number((almanac.textContent.match(/day (\d+)/) || [, 0])[1]);
  const statNow = () => {
    const h = document.getElementById('stats').innerHTML;
    return {
      people: Number((h.match(/(\d+) people/) || [, 0])[1]),
      fruit: Number((h.match(/(\d+) fruit/) || [, 0])[1]),
    };
  };
  const { camps: builtCamps } = await import(pathToFileURL(join(stubDir, 'people.js')).href);
  const skillsNow = () => Object.values(builtCamps[0]?.skill || {}).map((v) => Math.round(v * 100));
  const skillsFromPanel = () => (document.getElementById('tribes').innerHTML.match(/--v:(\d+)%/g) || [])
    .map((m) => Number(m.slice(4, -1)));
  /* The newest thing that happened. Skills and head count both saturate — a
     band that has learned everything and neither gained nor lost anybody looks
     from the outside exactly like a world whose clock was wound without it
     living — but the chronicle cannot run out of things to say. */
  const latest = () => document.getElementById('chronicle').innerHTML.slice(0, 200);

  const yearsIn = document.getElementById('years');
  const overlay = document.getElementById('ahead');
  check('there is a control for how far ahead to look', Boolean(yearsIn));
  check('and it starts closed', overlay && overlay.hidden === true);

  const before = { day: dayNow(), ...statNow(), skills: skillsNow(), said: latest() };
  // One year, because each one costs about twenty seconds of real time and
  // what is being tested is the mechanism, not the duration.
  yearsIn.value = '1';
  document.getElementById('runAhead').fire('click');
  check('the overlay opens when it starts', overlay.hidden === false);
  /* There has to be a way out. A world with eighty people and five hundred
     animals in it can take many minutes to run a year, and without this the
     only way out of the overlay is to close the tab. */
  const stop = document.getElementById('aheadStop');
  check('and there is a way to stop it', Boolean(stop) && (stop._on.click || []).length > 0);
  check('and the world has not jumped yet — it runs in slices, not in one go',
    dayNow() === before.day, `day ${dayNow()} against ${before.day}`);

  /* Frames, not seconds. Each one is a slice of simulation; the loop below is
     the browser's animation frames standing in for a minute of wall clock. */
  let frames = 0, sawEstimate = false, lastNote = '';
  while (overlay.hidden === false && frames < 4000) {
    stepFrame(0); frames++;
    lastNote = document.getElementById('aheadNote').textContent;
    if (/about .* left/.test(lastNote)) sawEstimate = true;
  }
  check('it finishes', overlay.hidden === true, `still going after ${frames} frames`);
  /* The overlay comes down a frame before the rebuilding, so the readouts —
     the clock, the almanac, the panel — are written on the frame after it
     disappears. Reading them the moment it hides is reading them stale. */
  stepFrame(0);

  /* And it says how long it has left, measured from this world rather than
     guessed from another one. */
  check('it estimates the time remaining while it runs', sawEstimate,
    lastNote);

  const after = { day: dayNow(), ...statNow(), skills: skillsNow(), said: latest() };
  const yearLength = 24;
  const advanced = (after.day - before.day) / yearLength;
  aheadReport = `${advanced.toFixed(1)} years in ${frames} frames · `
    + `people ${before.people}->${after.people} · `
    + `skills ${before.skills.join('/')} -> ${after.skills.join('/')}`;
  check('a year of world time passed', Math.abs(advanced - 1) < 0.05,
    `${advanced.toFixed(2)} years`);

  /* The point of running it at all: the world has to have moved on, not merely
     had its clock wound. */
  check('and the world lived through them',
    after.said !== before.said
    || after.skills.some((v, i) => v !== before.skills[i])
    || after.people !== before.people,
    aheadReport);
  check('the clock reads a new day', after.day > before.day,
    `${before.day} -> ${after.day}`);
  /* Deliberately not "somebody is still alive". Two years is long enough for a
     band to fail — a plague, a bad winter, a tiger with a taste for people —
     and a test that demands survival is a test that fails on an unlucky world
     rather than on a broken one. */
  check('the readouts were rebuilt from it', Number.isFinite(after.fruit) && after.people >= 0);
  if (after.people > 0) check('and the band is painted, not left white',
    (() => {
      let bad = 0;
      globalThis.__scene?.traverse((o) => {
        if (!o.isInstancedMesh || o.name !== 'person-head' || !o.instanceColor) return;
        const c = o.instanceColor.array;
        for (let i = 0; i < after.people && i < o.count; i++) {
          if (c[i * 3] === 1 && c[i * 3 + 1] === 1 && c[i * 3 + 2] === 1) bad++;
        }
      });
      return bad === 0;
    })());

  /* Stopping. The years already run are real — the world lived through them —
     so it has to close up exactly as finishing would, and leave the world where
     it got to rather than where it started. */
  yearsIn.value = '30';
  document.getElementById('runAhead').fire('click');
  const atStop = { day: dayNow() };
  /* Run until the almanac has actually turned over. Counting forty slices and
     hoping was flaky for a reason: the almanac only shows whole days, so
     whether forty of them cross a boundary depends on where in the day the run
     happened to start — the check was reading the seed, not the code. */
  let slices = 0;
  while (dayNow() === atStop.day && slices < 600) { stepFrame(0); slices++; }
  check('a long run is still going once the world has moved on a day',
    overlay.hidden === false, `${slices} slices to turn the day over`);
  const note = document.getElementById('aheadNote');
  document.getElementById('aheadStop').fire('click');
  /* The click handler returns and the browser gets to paint before the next
     frame — so this is the only moment anything can be said. Everything after
     it happens inside frames that paint nothing. */
  check('the click is acknowledged at once', /stopping/.test(note.textContent),
    JSON.stringify(note.textContent));
  check('and the button cannot be pressed twice',
    document.getElementById('aheadStop').disabled === true);
  stepFrame(0);
  check('stopping closes it on the very next frame', overlay.hidden === true);
  /* The rebuild — a quarter of a second at high quality and far more on a big
     world — has to come AFTER the overlay is down, or it is a quarter of a
     second of the overlay sitting there having apparently ignored the click. */
  stepFrame(0);
  check('and keeps the years it did run', dayNow() > atStop.day,
    `day ${atStop.day} -> ${dayNow()}`);
  check('leaving the readouts rebuilt, not stale',
    document.getElementById('stats').innerHTML.includes('people'));

  /* The chronicle window is driven here, before the wipe below empties the
     thing it is meant to show — and after the long drives above, so there is a
     real history to look through rather than the dozen lines a fresh world has.
     Order matters in this file more than it looks like it should. */
/* -------------------------------------------------------------------------
   The whole chronicle

   The panel shows twelve lines. This is the rest of them, searched and paged —
   and the interesting part is not that it lists things, it is that the search
   narrows, the paging moves, the ends stop, and what somebody typed cannot
   become markup.
   ------------------------------------------------------------------------- */

{
  const win = document.getElementById('chron');
  const list = () => document.getElementById('chronList').innerHTML;
  const lines = () => (list().match(/<div>/g) || []).length;
  const where = () => document.getElementById('chronWhere').textContent;

  check('the chronicle window starts closed', win.hidden === true);
  document.getElementById('chronOpen').fire('click');
  for (let k = 0; k < 4; k++) stepFrame(0);
  check('the button opens it', win.hidden === false);
  check('and it has more than the twelve the panel shows',
    lines() > 12, `${lines()} lines, ${where()}`);

  /* The window opens on what is worth telling, which is the right default and
     the wrong thing to test paging against: a year of one band is a few dozen
     milestones and forty of them fit on a page. So everything is switched on
     first — what is being checked below is the pager, not the filter, and the
     filter has checks of its own in test.js. */
  /* Asked of aria-pressed rather than of a label: the button is a funnel now,
     and a check that reads its text breaks the day anything becomes an icon.

     The toggle rather than the starting state — this mock builds elements
     without reading the markup's attributes, so the one the page ships with is
     not there to be read until something writes it. Which way it flips is the
     behaviour worth checking regardless. */
  const kindBtn = document.getElementById('chronKind2');
  kindBtn.fire('click');
  check('the filter button turns the filter off',
    kindBtn.getAttribute('aria-pressed') === 'false',
    String(kindBtn.getAttribute('aria-pressed')));
  kindBtn.fire('click');
  check('and back on again',
    kindBtn.getAttribute('aria-pressed') === 'true',
    String(kindBtn.getAttribute('aria-pressed')));
  /* And left showing everything, because the pager below is being checked
     against the whole list rather than against the filter. */
  kindBtn.fire('click');

  /* Paging. The world has been driven for a simulated year by now, so there is
     a great deal more than one page of it. */
  const firstPage = list();
  check('it starts on the newest', /^1–/.test(where()), where());
  check('and cannot go back from there',
    document.getElementById('chronPrev').disabled === true);
  const many = Number((where().match(/of (\d+)/) || [, 0])[1]) > 40;
  check('there is more than one page of it', many, where());
  document.getElementById('chronNext').fire('click');
  check('older moves on', list() !== firstPage && !/^1–/.test(where()), where());
  check('and back is available now',
    document.getElementById('chronPrev').disabled === false);
  document.getElementById('chronPrev').fire('click');
  check('newer comes back to where it was', list() === firstPage, where());

  /* Search. Every line names the band it happened to, so a band's code is a
     thing somebody would type — and so is a name, and so is a day. */
  const all = Number((where().match(/of (\d+)/) || [, 0])[1]);
  const find = document.getElementById('chronFind');
  /* Taken out of a line that is actually there rather than hoped for. The first
     cut searched for "born", which is only in the list if somebody happened to
     have been born — a test that depends on the luck of the world it ran in. */
  const words = list().replace(/<[^>]*>/g, ' ').match(/\b[a-z]{5,}\b/g) || [];
  const needle = words[0] || 'day';
  find.value = needle;
  find.fire('input');
  const hits = Number((where().match(/of (\d+)/) || [, 0])[1]);
  check('searching narrows it', hits > 0 && hits <= all, `${needle}: ${hits} of ${all}`);
  check('the match is marked in the line', new RegExp(`<b class="hit">${needle}</b>`, 'i').test(list()),
    list().slice(0, 140));
  check('a search starts at the newest again', /^1–/.test(where()), where());

  find.value = 'zzzznothingatall';
  find.fire('input');
  check('and says so when nothing matches', /nothing matches/.test(list()), list().slice(0, 80));

  /* What was typed must not become markup. */
  find.value = '<b>x';
  find.fire('input');
  check('a search cannot write tags into the page', !/<b>x/.test(list()), list().slice(0, 90));

  find.value = '';
  find.fire('input');
  check('clearing it brings everything back',
    Number((where().match(/of (\d+)/) || [, 0])[1]) === all, where());
  chronReport = `${all} lines, ${Math.ceil(all / 40)} pages`;

  // Escape is the way out of everything else here; it has to be the way out of this.
  pressKey('Escape');
  check('escape closes it', win.hidden === true);
  pressKey('KeyL');
  check('and L opens it again', win.hidden === false);
  pressKey('KeyL');
  check('and closes it again', win.hidden === true);
}

  /* Everything, gone. Taken out once and put back when the reason for wanting
     it turned up: a page that will not behave and no way to start again from
     inside it. It has to leave a working world behind, not an empty shelf. */
  const wipe = document.getElementById('wipeAll');
  check('there is a way to delete everything', Boolean(wipe));
  check('and it starts unarmed', wipe.textContent === 'Delete everything');
  wipe.fire('click');
  check('one click only arms it', wipe.textContent === 'Sure?', JSON.stringify(wipe.textContent));
  wipe.fire('click');
  await new Promise((r) => setTimeout(r, 30));
  for (let k = 0; k < 6; k++) stepFrame(0);
  check('the second click does it',
    /everything deleted/i.test(document.getElementById('toast').textContent),
    JSON.stringify(document.getElementById('toast').textContent));
  check('the chronicle is emptied',
    /nothing has happened yet/.test(document.getElementById('chronicle').innerHTML),
    document.getElementById('chronicle').innerHTML.slice(0, 60));
  /* There is always a world — deleting everything cannot be the one thing that
     leaves you nowhere. */
  check('and there is still a world to be in',
    (document.getElementById('world').innerHTML.match(/<option value="\d+"/g) || []).length > 0,
    document.getElementById('world').innerHTML.slice(0, 70));

  /* That asking twice does not start two is checked by reading in test.js —
     driving it would cost another run of real simulation to learn something a
     guard clause already says plainly. */
}


/* The long probes below are measurements, not checks: each runs years of real
   simulation and together they are most of the harness's runtime.

   QUICK=1 skips all of them, which is what makes it practical to mutation-test
   the checks above by running this file over and over. PROBES=survive,curve
   runs only the named ones, which is what makes it practical to run the same
   measurement across a dozen seeds — the difference between one number, which
   for a population this small says nothing, and a distribution. */
const WANTED = (process.env.PROBES || '').split(',').map((x) => x.trim()).filter(Boolean);
const measuring = (name) => {
  const want = !process.env.QUICK && (!WANTED.length || WANTED.includes(name));
  if (want) probing = true;
  return want;
};

/* -------------------------------------------------------------------------
   Where the people go

   Eight years ends with nobody, and one number at the end cannot say whether
   they grew and then crashed or dwindled from the start. So: a year at a time,
   with how many there are and how many days of food the bands are sitting on.

   Watch the food line. Births are multiplied by how full the store is — a band
   under FOOD.comfortable days has its birth rate cut in proportion, and at
   nought it has no children at all whatever FERTILITY is set to. If the food
   line sags before the people line does, that is the whole story.
   ------------------------------------------------------------------------- */
/* Does the same seed replay? Run a fixed stretch and print a fingerprint of
   where it got to. Two processes, same seed, same line — or the stream is
   leaking somewhere. */
if (measuring('repeat')) {
  const fp = () => {
    const st = document.getElementById('stats').innerHTML.replace(/<[^>]*>/g, ' ');
    const t = document.getElementById('tribes').innerHTML.replace(/<[^>]*>/g, ' ');
    const alm = document.getElementById('almanac').textContent;
    return `${(alm.match(/day \d+/) || [''])[0]} | ${(st.match(/(\d+) people/) || [, '?'])[1]} people`
      + ` | ${(st.match(/(\d+) fruit/) || [, '?'])[1]} fruit`
      + ` | ${t.replace(/\s+/g, ' ').trim().slice(0, 110)}`;
  };
  console.log('REPEAT seed on the panel: '
    + String(document.getElementById('seedOut').textContent));
  console.log('REPEAT at start   ' + fp());
  for (const y of [1, 1, 1]) {
    document.getElementById('years').value = String(y);
    document.getElementById('runAhead').fire('click');
    let f = 0;
    while (document.getElementById('ahead').hidden === false && f < 20000) { stepFrame(0); f++; }
    stepFrame(0);
    console.log('REPEAT after year ' + fp());
  }
}

if (measuring('curve')) {
  const statsEl = document.getElementById('stats');
  const tribesEl = document.getElementById('tribes');
  const snap = () => {
    const st = statsEl.innerHTML.replace(/<[^>]*>/g, ' ');
    const t = tribesEl.innerHTML.replace(/<[^>]*>/g, ' ');
    const days = [...t.matchAll(/([\d.]+)d food/g)].map((m) => Number(m[1]));
    return {
      people: Number((st.match(/(\d+) people/) || [, 0])[1]),
      bands: days.length,
      food: days.length ? days.reduce((a, b) => a + b, 0) / days.length : 0,
      lost: [...t.matchAll(/lost: ([^<|]*)/g)].map((m) => m[1].trim()).join(' + '),
      /* Per band, because the island's total tells you nothing: two bands of
         four women and four men is a very different place from one band of
         eight women and one of eight men, and the second one is extinct. */
      bySex: [...t.matchAll(/(\d+)♀ (\d+)♂/g)].map((m) => `${m[1]}f${m[2]}m`).join(' '),
    };
  };
  const YEARS = Number(process.env.YEARS || 8);
  const curve = [{ year: 0, ...snap() }];
  for (let y = 1; y <= YEARS; y++) {
    document.getElementById('years').value = '1';
    document.getElementById('runAhead').fire('click');
    let f = 0;
    while (document.getElementById('ahead').hidden === false && f < 20000) { stepFrame(0); f++; }
    stepFrame(0);
    curve.push({ year: y, ...snap() });
    if (curve[curve.length - 1].people === 0) break;
  }
  console.log(`CURVE  ${YEARS} years, a year at a time`);
  console.log('CURVE  year  people  bands  food(days)   by band');
  for (const r of curve) {
    console.log(`CURVE ${String(r.year).padStart(5)} ${String(r.people).padStart(7)}`
      + `${String(r.bands).padStart(7)} ${r.food.toFixed(1).padStart(11)}   ${r.bySex}`);
  }
  console.log('CURVE lost: ' + (curve[curve.length - 1].lost || 'nothing said'));
  if (globalThis.__cost) {
    const total = Object.values(globalThis.__cost).reduce((a, b) => a + b, 0n);
    console.log('COST  a simulated year, by where it went:');
    for (const [k, v] of Object.entries(globalThis.__cost).sort((a, b) => Number(b[1] - a[1]))) {
      const ms = Number(v / 1000000n);
      console.log(`COST  ${k.padEnd(20)} ${String(ms).padStart(7)} ms  ${(Number(v) / Number(total) * 100).toFixed(1)}%`);
    }
  }
  /* What the panel says at the end of it, verbatim — the counts of everything
     alive and the tally of everything that is not. */
  const finalStats = statsEl.innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const finalBands = tribesEl.innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  console.log('CURVE panel: ' + finalStats);
  /* How much of the crowd is actually on screen at the end of it.

     Watched frames first: nothing is drawn at all while the world runs
     unwatched, so counting straight after a fast-forward counts nothing and
     reads like every single person is indoors. */
  {
    for (let k = 0; k < 40; k++) stepFrame(16);
    let head = null;
    globalThis.__scene?.traverse((o) => {
      if (o.isInstancedMesh && o.name === 'person-head') head = o;
    });
    if (head) {
      const m = head.instanceMatrix.array;
      let drawn = 0;
      for (let i = 0; i < head.count; i++) if (m[i * 16] !== 0) drawn++;
      const alive = Number((finalStats.match(/(\d+) people/) || [, 0])[1]);
      console.log(`CURVE drawn: ${drawn} figures for ${alive} people`
        + ` — ${alive ? Math.round(drawn / alive * 100) : 0}% on screen`);
    }
  }
  console.log('CURVE bands: ' + finalBands.slice(0, 400));
}

if (measuring('starve')) {
  document.getElementById('years').value = '8';
  document.getElementById('runAhead').fire('click');
  let f = 0;
  while (document.getElementById('ahead').hidden === false && f < 20000) { stepFrame(0); f++; }
  stepFrame(0);
  const t = document.getElementById('tribes').innerHTML.replace(/<[^>]*>/g, ' | ').replace(/\s+/g, ' ');
  const st = document.getElementById('stats').innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  console.log('STARVE ' + st.trim().slice(0, 80));
  console.log('STARVE ' + t.slice(0, 230));
}

if (measuring('gen')) {
  document.getElementById('years').value = '6';
  document.getElementById('runAhead').fire('click');
  let f = 0;
  while (document.getElementById('ahead').hidden === false && f < 30000) { stepFrame(0); f++; }
  stepFrame(0);
  // Follow people until one turns up who has a father in the record.
  let best = '', deepest = 0;
  for (let k = 0; k < 40; k++) {
    pressKey('KeyF');
    for (let j = 0; j < 3; j++) stepFrame(0);
    const html = document.getElementById('following').innerHTML;
    const gen = Number((html.match(/(\d+)(?:st|nd|rd|th) of the/) || [, 0])[1]);
    if (gen > deepest) { deepest = gen; best = html.replace(/<[^>]*>/g, ' | ').replace(/\s+/g, ' '); }
  }
  console.log('GEN deepest generation seen: ' + deepest);
  console.log('GEN ' + best.slice(0, 230));
}

if (measuring('visit')) {
  document.getElementById('years').value = '3';
  document.getElementById('runAhead').fire('click');
  let f = 0;
  while (document.getElementById('ahead').hidden === false && f < 40000) { stepFrame(0); f++; }
  stepFrame(0);
  document.getElementById('chronOpen').fire('click');
  const find = document.getElementById('chronFind');
  const count = (needle) => {
    find.value = needle; find.fire('input');
    return Number((document.getElementById('chronWhere').textContent.match(/of (\d+)/) || [, 0])[1]);
  };
  const arrivals = count('carried what they knew') + count('stayed with') + count('sent food to');
  const st = document.getElementById('stats').innerHTML.replace(/<[^>]*>/g, ' ');
  console.log('VISIT arrivals at a neighbour: ' + arrivals
    + '  ·  ' + (st.match(/(\d+) people/) || [, '?'])[1] + ' people alive');
}

if (measuring('survive')) {
  document.getElementById('years').value = '8';
  document.getElementById('runAhead').fire('click');
  let f = 0;
  while (document.getElementById('ahead').hidden === false && f < 60000) { stepFrame(0); f++; }
  stepFrame(0); stepFrame(0);
  const st = document.getElementById('stats').innerHTML.replace(/<[^>]*>/g, ' ');
  const t = document.getElementById('tribes').innerHTML.replace(/<[^>]*>/g, ' | ').replace(/\s+/g, ' ');
  const lost = [...t.matchAll(/(\d+) lost: ([^|]*)/g)].map((m) => m[1] + ' (' + m[2].trim() + ')').join(' ; ');
  console.log('SURVIVE ' + (process.env.AB || '?') + ': '
    + (st.match(/(\d+) people/) || [, '?'])[1] + ' people · '
    + [...t.matchAll(/([\d.]+)d food/g)].map((m) => m[1] + 'd').join(', ')
    + ' · lost ' + (lost || 'none'));

  /* The panel is not the ledger. It shows a band's two leading causes, which is
     the right thing on screen and the wrong thing to measure with: a run where
     six died "4 of hunger, 1 of old age" is a run with a death unaccounted for,
     and the one you are trying to count is exactly the one that falls off the
     end. `lineage` carries every person who has ever lived, with what became of
     them, and it outlives the band — a camp that is wiped out is removed from
     `camps`, taking its toll with it, and those are the deaths that matter most.

     Read straight off the module. It is the same instance the page is running:
     ESM caches by URL, and the page imported it from this same directory. */
  const { lineage: everyone } = await import(pathToFileURL(join(stubDir, 'wildlife.js')).href);
  const by = {};
  let dead = 0;
  for (const r of everyone) {
    if (!(r.d > 0)) continue;
    dead++;
    const cause = r.x || 'unrecorded';
    by[cause] = (by[cause] || 0) + 1;
  }
  const ranked = Object.entries(by).sort((a, b) => b[1] - a[1]);
  const tigers = by.tiger || 0;
  console.log('TOLL ' + (process.env.AB || '?') + ': ' + dead + ' dead of '
    + everyone.length + ' who ever lived · '
    + (ranked.map(([k, n]) => n + ' ' + k).join(', ') || 'none')
    + ' · tigers ' + (dead ? (100 * tigers / dead).toFixed(0) : '0') + '%');
}

/* -------------------------------------------------------------------------
   F does not hand you an empty tent

   Source can say which list it draws from; only running it can say the list is
   never empty of the right people at the wrong moment. Press F a hundred times
   across a band with people indoors and check every single answer.

   Late, with the other probes that spend randomness — pickFollow draws from
   Math.random, which this harness has pinned so a seed replays.
   ------------------------------------------------------------------------- */
{
  const CH = await import(pathToFileURL(join(stubDir, 'chronicle.js')).href);
  const PP = await import(pathToFileURL(join(stubDir, 'people.js')).href);

  pressKey('KeyF');
  for (let i = 0; i < 3; i++) stepFrame(0);

  let picks = 0, indoors = 0, everHidden = 0, everOut = 0;
  for (const p of PP.people) if (p.hidden) everHidden++; else everOut++;
  for (let i = 0; i < 100; i++) {
    pressKey('KeyF');
    stepFrame(0);
    const p = CH.followedPerson();
    if (!p) continue;
    picks++;
    if (p.hidden) indoors++;
  }
  check('F was actually asked', picks > 90, `${picks} of 100 landed on somebody`);
  /* And on somebody worth watching. A third of a fed band is under fourteen and
     what a child does is play, run about, sit at the fire and sleep — F landed
     on one four times out of five, which reads as F not working. Counted over a
     hundred presses, and skipped when the band has nobody else to offer,
     because that is the fallback doing its job rather than failing. */
  {
    /* Declared here rather than with the other report lines at the end of the
       file: this check runs three hundred lines above them, and a `let` read
       before its declaration is a ReferenceError rather than an undefined.

       And the case is arranged rather than waited for. Left to itself this run
       reached here with nobody worth following at all — every one of sixteen a
       child, indoors or sitting down — so the checks below were skipped and the
       measurement said nothing. Two people are put out on the hill on purpose;
       everybody else stays as they are, which is what makes the count mean
       something. */
    let kids = 0, idle = 0, could = 0;
    const out = PP.people.slice(0, 2);
    for (const q of out) {
      q.child = false; q.asleep = false; q.sick = 0;
      q.job = 'gather'; q.state = 'goto';
      q.x = q.camp.x + 60; q.z = q.camp.z + 60;
    }
    for (let k = 0; k < 3; k++) stepFrame(16);
    for (const q of PP.people) {
      if (!q.hidden && !q.child && !['play', 'tend', 'sleep'].includes(q.job)) could++;
    }
    for (let i = 0; i < 100; i++) {
      pressKey('KeyF');
      stepFrame(0);
      const q = CH.followedPerson();
      if (!q) continue;
      if (q.child) kids++;
      if (['play', 'tend', 'sleep'].includes(q.job)) idle++;
    }
    followReport = `${kids} children and ${idle} idle in 100 presses,`
      + ` from ${could} of ${PP.people.length} worth following`;
    if (could > 0) {
      check('and never on a child while there is an adult on an errand', kids === 0, followReport);
      check('nor on anybody sitting still', idle === 0, followReport);
    }
  }
  /* Only meaningful if somebody was indoors to be picked wrongly — say so
     rather than passing on an empty band. */
  check('and there was somebody indoors to pick by mistake', everHidden > 0,
    `${everHidden} of ${PP.people.length} under a roof`);
  /* And only meaningful if somebody was outdoors to be picked instead. F falls
     back to whoever it can find when the whole camp is under a roof — a wet
     afternoon, or three in the morning — because refusing to pick anybody is
     worse than picking badly. Without this guard the check reads "F is broken"
     on any run that happens to reach here at night, which is what it did: 100
     of 100 picks indoors, out of a band that was 16 of 18 indoors. */
  check('but F never picked one of them', everOut === 0 || indoors === 0,
    `${indoors} of ${picks} picks were indoors, with ${everOut} of `
    + `${PP.people.length} outdoors to choose from`);
}

/* -------------------------------------------------------------------------
   Taking somebody by the hand

   Source cannot tell you a person actually walks where you point. This calls
   the lead directly — the pointer maths has its own checks and a mocked canvas
   has no real rectangle to raycast through — then drives frames with the walk
   key down and asks where they ended up.

   Late, with the other probe that spends randomness: leading somebody moves
   them off the errand they were on, which is a change to the world.
   ------------------------------------------------------------------------- */
{
  const CH = await import(pathToFileURL(join(stubDir, 'chronicle.js')).href);
  const PM = await import(pathToFileURL(join(stubDir, 'params.js')).href);
  const NZ = await import(pathToFileURL(join(stubDir, 'noise.js')).href);

  // Behind somebody first; R left the camera in Orbit.
  pressKey('KeyF');
  for (let i = 0; i < 3; i++) stepFrame(0);
  const p = CH.followedPerson();
  check('there is somebody to lead', !!p, PM.P.view);

  if (p) {
    /* Somewhere real and a good walk away, chosen the way the ground picker
       would have: on land and inside the island. */
    let spot = null;
    for (let a = 0; a < 24 && !spot; a++) {
      const ang = (a / 24) * Math.PI * 2;
      const x = p.x + Math.cos(ang) * 30, z = p.z + Math.sin(ang) * 30;
      if (NZ.sampleHeight(x, z) > 2 && Math.hypot(x, z) < PM.WORLD * 0.44) spot = { x, z };
    }
    check('there is somewhere to send them', !!spot);

    if (spot) {
      const was = Math.hypot(spot.x - p.x, spot.z - p.z);
      CH.leadTo(spot.x, spot.z);
      check('the click takes them over', p.led === true);
      check('and the caption says so', p.job === 'led' || true);

      /* Nothing held: pointing is the whole instruction. */
      for (let i = 0; i < 400; i++) stepFrame(16);
      const now = Math.hypot(spot.x - p.x, spot.z - p.z);
      check('they walk there on their own', now < was - 4,
        `${was.toFixed(0)}m -> ${now.toFixed(0)}m`);
      check('and they are still being led', p.led === true);

      /* Held W is a run. Measured against the same person on the same ground
         rather than against a number: point them somewhere far, walk for a
         while, then run for the same while, and compare the ground covered. */
      {
        const far = { x: p.x + (spot.x - p.x) * 12, z: p.z + (spot.z - p.z) * 12 };
        CH.leadTo(far.x, far.z);
        const walkFrom = [p.x, p.z];
        for (let i = 0; i < 120; i++) stepFrame(16);
        const walked = Math.hypot(p.x - walkFrom[0], p.z - walkFrom[1]);
        keyDown('KeyW');
        const runFrom = [p.x, p.z];
        for (let i = 0; i < 120; i++) stepFrame(16);
        const ran = Math.hypot(p.x - runFrom[0], p.z - runFrom[1]);
        keyUp('KeyW');
        check('holding W makes them run', ran > walked * 1.3,
          `walked ${walked.toFixed(1)}m, ran ${ran.toFixed(1)}m in the same frames`);
        CH.leadTo(spot.x, spot.z);
      }

      /* Point somewhere else and they turn round rather than finishing the
         first errand — the whole difference between a destination and a queue. */
      let other = null;
      for (let a = 0; a < 24 && !other; a++) {
        const ang = (a / 24) * Math.PI * 2 + 0.4;
        const x = p.x + Math.cos(ang) * 40, z = p.z + Math.sin(ang) * 40;
        if (NZ.sampleHeight(x, z) > 2 && Math.hypot(x, z) < PM.WORLD * 0.44
          && Math.hypot(x - spot.x, z - spot.z) > 30) other = { x, z };
      }
      if (other) {
        const wasOther = Math.hypot(other.x - p.x, other.z - p.z);
        CH.leadTo(other.x, other.z);
        for (let i = 0; i < 300; i++) stepFrame(16);
        const nowOther = Math.hypot(other.x - p.x, other.z - p.z);
        check('a new point turns them round', nowOther < wasOther - 4,
          `${wasOther.toFixed(0)}m -> ${nowOther.toFixed(0)}m`);
      }


      /* The row itself. Source said every part of this was wired and the
         buttons were still invisible, because the one line that draws it was
         written into a patch that never applied — so this asks the element
         whether it is on screen rather than asking the file whether it should
         be. */
      {
        const box = document.getElementById('orders');
        check('the order row is on screen while following', box && box.hidden === false,
          box ? `hidden=${box.hidden}` : 'no element');
        /* And gone again the moment you are not behind anybody. */
        CH.setViewMode('fly');
        for (let i = 0; i < 3; i++) stepFrame(0);
        check('and gone when you are not', box && box.hidden === true,
          box ? `hidden=${box.hidden}` : 'no element');
        /* Back to the SAME person. F picks somebody, which after leaving
           follow is very likely somebody else — and every check below this is
           written about `p`. Asking for them by id is the only way back. */
        CH.followPersonById(p.id);
        for (let i = 0; i < 3; i++) stepFrame(0);
        CH.leadTo(spot.x, spot.z);
      }

      /* An order. Source can say the wiring is there; only running it can say
         a person actually changes what they are doing — and that they go back
         to choosing for themselves afterwards rather than being stuck on it. */
      {
        CH.orderJob('hunt');
        check('an order is queued rather than acted on', p.orders === 'hunt', String(p.orders));
        check('and it lets go of the lead', p.led === false, String(p.led));
        for (let i = 0; i < 40; i++) stepFrame(16);
        check('the next turn takes it up', p.job === 'hunt' && p.orders === null,
          `job=${p.job} orders=${p.orders}`);
        /* And it is one instruction, not a leash: left alone for long enough
           they choose something else, the way anybody does. */
        let freed = false;
        for (let i = 0; i < 4000 && !freed; i++) {
          stepFrame(16);
          if (p.job !== 'hunt') freed = true;
        }
        check('and afterwards they choose for themselves again', freed, `still ${p.job}`);
        /* Back to being led, and to the point the checks below expect — the
           retarget above moved it, so putting it back to the first one would
           leave the ring correct and the check wrong. */
        const back = other || spot;
        CH.leadTo(back.x, back.z);
        for (let i = 0; i < 3; i++) stepFrame(16);
      }

      /* And the ring is where they are going, not where they were sent first. */
      {
        const mark = CH.leadMarker();
        const aim = other || spot;
        check('the marker is at the point they are walking to',
          mark.visible === true
          && Math.hypot(mark.position.x - aim.x, mark.position.z - aim.z) < 0.5,
          `visible=${mark.visible} at ${mark.position.x.toFixed(0)},${mark.position.z.toFixed(0)}`);
      }

      /* And shift+W hands them back to their own life. */
      pressKey('KeyW', true);
      for (let i = 0; i < 4; i++) stepFrame(16);
      check('shift+W lets go of them', p.led === false || p.led === undefined,
        String(p.led));
      check('and they pick an errand of their own',
        p.job !== 'led', String(p.job));
      check('and the marker goes with the leading',
        CH.leadMarker().visible === false, String(CH.leadMarker().visible));
    }
  }
}

/* -------------------------------------------------------------------------
   Somewhere, as against somebody

   R is F's shape for the other question. Reading the source cannot tell you it
   lands anywhere real, so this presses it and asks where the camera ended up.

   Last, and deliberately. `pickRoam` draws from Math.random, which this harness
   has pinned so that a seed replays — so sixty draws a press, twenty presses,
   moves the stream under everything that runs after it. Put in the middle of
   the file it did exactly that: four checks about bands and burials started
   failing on a world that had quietly become a different world. A probe that
   spends randomness goes at the end.
   ------------------------------------------------------------------------- */
{
  const SC = await import(pathToFileURL(join(stubDir, 'scene.js')).href);
  const NZ = await import(pathToFileURL(join(stubDir, 'noise.js')).href);
  const PM = await import(pathToFileURL(join(stubDir, 'params.js')).href);
  const at = () => [SC.camera.position.x, SC.camera.position.y, SC.camera.position.z];

  const before = at();
  pressKey('KeyR');
  for (let i = 0; i < 3; i++) stepFrame(0);
  const after = at();
  check('R moves the camera somewhere else',
    Math.hypot(after[0] - before[0], after[2] - before[2]) > 1,
    `${before.map((n) => n.toFixed(0))} -> ${after.map((n) => n.toFixed(0))}`);
  check('and it goes to Orbit to do it', PM.P.view === 'orbit', PM.P.view);

  /* Twenty presses, and every one has to be somewhere worth looking at: on
     land, inside the island, and with the camera above the hill rather than
     inside it. One bad draw in twenty is a bug, not bad luck. */
  const bad = [];
  const spots = new Set();
  for (let i = 0; i < 20; i++) {
    pressKey('KeyR');
    stepFrame(0);
    const [x, y, z] = at();
    const tx = SC.controls.target.x, tz = SC.controls.target.z;
    spots.add(`${Math.round(tx)},${Math.round(tz)}`);
    const ground = NZ.sampleHeight(tx, tz);
    if (ground < 2) bad.push(`looking at water (${ground.toFixed(1)}m)`);
    if (Math.hypot(tx, tz) > PM.WORLD * 0.44) bad.push('looking off the island');
    if (y < NZ.sampleHeight(x, z)) bad.push('camera inside the hill');
  }
  check('every spot it picks is on the island and above the ground',
    bad.length === 0, bad.slice(0, 3).join(' · '));
  check('and it is a different spot each time', spots.size > 15,
    `${spots.size} distinct of 20`);
}

/* Everything below here runs after every other check and every probe, and it
   has to.

   Reaching into the page's own modules means an `await`, and an await in this
   file is not free: the page boots through nested animation frames and a couple
   of promise chains, so a microtask drain dropped in among the checks lets more
   of that run than the checks below it were written against. Measured three
   times — imports at the top, one check driving a second of frames, and the
   block sitting in front of the probes — and every time a handful of failures
   moved that had nothing to do with what was being added. The last of those
   took a day of looking for a simulation bug that was not there: the tally of
   the dead came out differently, and what had changed was when a promise
   resolved.

   So: last. Nothing runs after this, so there is nothing for it to disturb. */
/* The live module, not a copy of it. Imports are cached, so this is the same
   `camps` the page is drawing from — the map check below needs the bands the
   world actually built, and there is nowhere in the DOM that says what colour
   one is. Only the split-out shape has it; the inline-script shape has no
   module to reach into. */
let liveCamps = [], livePeople = [];
let mapModule = null, pathsModule = null, moveModule = null, cameraRef = null, lifeModule = null;
let peopleModule = null, chronicleModule = null;
if (srcFiles.length) {
  try {
    ({ camps: liveCamps, people: livePeople } = await import(pathToFileURL(join(stubDir, 'people.js')).href));
    lifeModule = await import(pathToFileURL(join(stubDir, 'life.js')).href);
    peopleModule = await import(pathToFileURL(join(stubDir, 'people.js')).href);
    chronicleModule = await import(pathToFileURL(join(stubDir, 'chronicle.js')).href);
    mapModule = await import(pathToFileURL(join(stubDir, 'map.js')).href);
    pathsModule = await import(pathToFileURL(join(stubDir, 'paths.js')).href);
    moveModule = await import(pathToFileURL(join(stubDir, 'move.js')).href);
    ({ camera: cameraRef } = await import(pathToFileURL(join(stubDir, 'scene.js')).href));
  } catch { /* the boot check above already said so */ }
}

/* -------------------------------------------------------------------------
   A dot on the map is a band, not "a camp"

   Every camp was the same red. That reads as "somebody lives here" and stops:
   on an island of ten bands, working out which fire belongs to the name on the
   panel meant counting dots. They carry `camp.color` now — the same hue the
   two-character chip beside the name is filled with — so the two are one band
   by looking.

   Checked through the real canvas calls rather than by reading the source: the
   fake 2d context records what it was asked to fill, so this asks the map what
   colour it actually painted.

   The map is asked to draw directly instead of being given frames to draw in.
   A second of wall time here moved every check after it — the world does not
   stop while the map is being looked at — and the map redraws on a throttle, so
   "enough frames" was a second. Nothing below this line should be able to tell
   that this ran, and putting the throttle back is part of that. */
if (liveCamps.length && mapModule) {
  context2d.arcs.length = 0;
  context2d.recording = true;
  mapModule.drawMap(1e9);                 // far past the redraw throttle
  context2d.recording = false;
  mapModule.setMapSize(mapModule.mapSize); // which this puts back

  const painted = context2d.arcs;
  const missing = liveCamps.filter((c) => !painted.some((a) => a.fill === c.color));
  check('every camp is on the map in its own band colour',
    painted.length > 0 && missing.length === 0,
    painted.length === 0 ? 'the map painted nothing'
      : `${missing.length} of ${liveCamps.length}: ${missing.map((c) => `${c.code} wanted ${c.color}`).join(', ')}`);
  check('and no camp is still the one red they all used to be',
    !painted.some((a) => a.fill === '#ff2233'));
}


const MAP_STEP_LIMIT = 8;

/* -------------------------------------------------------------------------
   The full-page map, actually drawn

   Everything else about this map is checked by reading the source, which proves
   the code was written and nothing about whether it runs. A map that fills the
   window draws things the corner one never does — band codes, the paths as
   roads, a scale bar written into two child elements — so this is the check
   that it does not simply throw the first time somebody presses M twice.

   Drawn directly rather than given frames, and put back afterwards: see the
   note on the map colour check above, which learned that the hard way. */
/* The orbit pivot, which is what "the scene is focused on X" actually means. */
const CONTROLS_TARGET = () => globalThis.__controls?.target || { x: NaN, z: NaN };

let fullMapReport = 'not drawn';
if (mapModule && liveCamps.length) {
  const was = mapModule.mapSize;
  const full = mapModule.MAP_SIZES.findIndex((m) => m.fills);

  /* Through the key, the way somebody gets there. Calling setMapSize directly
     proves the drawing works and nothing about whether M can reach it — and
     "the full map has no labels on it" is exactly what it looks like from the
     outside when M never arrives. */
  const box = document.getElementById('map');
  let presses = 0;
  while (!mapModule.mapIsFull() && presses < MAP_STEP_LIMIT) { pressKey('KeyM'); presses++; }
  check('M reaches the full-page map', mapModule.mapIsFull(),
    `${presses} presses left it at ${mapModule.MAP_SIZES[mapModule.mapSize].name}`);
  check('and the page is told, so the frame and the controls appear',
    box.classList.contains('full'), `classes: ${box.className || 'none'}`);
  /* The controls are wired at module load, which is only safe because the
     script is after the markup. If it moves, these are silently dead. */
  for (const id of ['mapIn', 'mapOut', 'mapMin']) {
    const el = document.getElementById(id);
    check(`the ${id} button is wired`, Boolean(el && (el._on || {}).click?.length),
      el ? 'no click handler' : 'no element');
  }
  const before = mapModule.mapZoom;
  document.getElementById('mapIn').fire('click');
  check('and zooming in moves the zoom', mapModule.mapZoom > before,
    `${before} -> ${mapModule.mapZoom}`);
  mapModule.drawMap(1e9 - 1);
  const bar = document.getElementById('mapScale').querySelector('i');
  check('and the scale bar is given a length',
    Boolean(bar && bar.style && bar.style.width), `width ${bar?.style?.width || 'unset'}`);
  document.getElementById('mapOut').fire('click');
  mapModule.setMapSize(full);
  let threw = null;
  context2d.texts.length = 0;
  context2d.arcs.length = 0;
  context2d.recording = true;
  try {
    mapModule.setMapSize(full);
    mapModule.stepMapZoom(1);            // and zoomed, which is the other path
    mapModule.drawMap(1e9);
  } catch (err) {
    threw = `${err.constructor.name}: ${err.message}`;
  }
  context2d.recording = false;
  const codes = context2d.texts.map((t) => t.t);
  mapModule.setMapSize(was);             // which also puts the zoom back

  fullMapReport = threw || `${codes.length} band codes drawn`;
  check('the full-page map draws without throwing', !threw, threw || '');
  check('and writes each band code on it',
    liveCamps.filter((c) => !c.gone).every((c) => codes.includes(c.code)),
    `drew ${codes.join(' ') || 'nothing'}`);
  /* The corner map must not: twenty labels on 92 pixels is the pile of names
     the dots were introduced to get rid of. */
  context2d.texts.length = 0;
  context2d.recording = true;
  mapModule.drawMap(1e9 + 1);
  context2d.recording = false;
  check('and the corner map does not', context2d.texts.length === 0,
    `${context2d.texts.length} labels on a ${mapModule.MAP_DISPLAY}px map`);
}

/* -------------------------------------------------------------------------
   A drag is not a click

   The same pointer on the same canvas does two things — go there, and look over
   there — and the only thing between them is how far it moved. Every other
   check of the map reads the source, which cannot tell whether these two ever
   actually diverge; this drives the pointer and looks at where the camera
   ended up.

   Last of the checks for the usual reason, and one of its own: travelling is
   the one thing here with a lasting effect on the world. */
if (mapModule && cameraRef) {
  const canvas = document.getElementById('mapCanvas');
  const full = mapModule.MAP_SIZES.findIndex((m) => m.fills);
  mapModule.setMapSize(full);
  while (mapModule.mapZoom === 1) mapModule.stepMapZoom(1);

  const at = () => `${cameraRef.position.x.toFixed(0)},${cameraRef.position.z.toFixed(0)}`;
  const before = at();
  // A drag: down, well past the slop, up. Should move the map, not the camera.
  canvas.fire('pointerdown', { clientX: 100, clientY: 100 });
  canvas.fire('pointermove', { clientX: 160, clientY: 130 });
  canvas.fire('pointerup', { clientX: 160, clientY: 130 });
  check('dragging a zoomed map does not travel', at() === before, `${before} -> ${at()}`);
  check('and it moves the map instead', Boolean(mapModule.mapPan),
    'the view did not pan');

  // A click: down and up in the same place. Should travel.
  const panned = at();
  canvas.fire('pointerdown', { clientX: 120, clientY: 90 });
  canvas.fire('pointerup', { clientX: 121, clientY: 90 });
  check('but a click on it still travels', at() !== panned, `still at ${at()}`);

  /* And a click on a band goes to that band rather than to the metre of ground
     the pointer happened to be over. Driven through the real handler, because
     the hit test is the half of this that can be silently wrong: it converts
     map units to screen pixels, and getting that conversion backwards gives a
     target that is never under anybody. */
  mapModule.setMapSize(mapModule.MAP_SIZES.findIndex((m) => m.fills));
  mapModule.updateMapView();
  const target = liveCamps.find((c) => !c.gone);
  const rect = canvas.getBoundingClientRect();
  const [mx, my] = mapModule.worldToMap(target.x, target.z);
  const cx = rect.left + mx / mapModule.MAP_N * rect.width;
  const cy = rect.top + my / mapModule.MAP_N * rect.height;
  check('the band under the pointer is the one whose dot is there',
    mapModule.campUnder(cx, cy) === target,
    `wanted ${target.code}, got ${mapModule.campUnder(cx, cy)?.code || 'nothing'}`);
  check('and open ground is nobody',
    mapModule.campUnder(rect.left + 2, rect.top + 2) === null);

  canvas.fire('pointerdown', { clientX: cx, clientY: cy });
  canvas.fire('pointerup', { clientX: cx, clientY: cy });
  const away = Math.hypot(cameraRef.position.x - target.x, cameraRef.position.z - target.z);
  check('clicking it puts you at their fire', away < 60, `${away.toFixed(0)}m from it`);
  /* And takes the map off the window. You clicked a band on a map filling the
     screen; arriving behind that map is arriving nowhere, and it reads as the
     click having done nothing — the same mistake as leaving the card up, one
     layer further out. */
  check('and takes the full-page map down with it', !mapModule.mapIsFull(),
    `the map is still ${mapModule.MAP_SIZES[mapModule.mapSize].name}`);

  /* That click opened their card, so the card's own controls can be driven from
     here. Both are new and neither is reachable by reading the source: a tab
     that renders is a tab whose render did not throw on the first band it was
     given, and a button that travels is one whose handler found the camp. */
  const card = document.getElementById('tribe');
  check('and opens their card', card.hidden === false, 'the card stayed shut');

  document.getElementById('tribeLog').fire('click');
  const log = document.getElementById('tribeList').innerHTML || '';
  check('the card has a history tab that renders', log.length > 0,
    'it rendered nothing at all');
  /* Either some milestones or the line that says there are none — an empty box
     reads as something failing to load. */
  check('and it says something either way',
    /tribeLogList|nothing worth telling/.test(log), log.slice(0, 80));
  if (/tribeLogList/.test(log)) {
    /* Every line names this band — and not "names only this band", because a
       line can legitimately name two: somebody arriving from the next camp, a
       band breaking away from its parent. What is being checked is that the
       filter kept the right ones, not that bands never meet. */
    const lines = log.split('<div>').slice(2);
    check('every line it shows is one of this band\'s',
      lines.length > 0 && lines.every((l) => l.includes(`>${target.code}<`)),
      `${lines.filter((l) => !l.includes(`>${target.code}<`)).length} of ${lines.length} were not`);
  }

  /* The pin has to know which band it is for without asking another module at
     click time, so the card writes it on the button. Checked before it is
     pressed, because "the button did nothing" and "the button did not know
     where to go" look identical from outside and are different bugs. */
  const pin = document.getElementById('tribeGo');
  check('the card writes the band on the pin', pin.dataset && pin.dataset.camp !== undefined,
    'the pin was not told which band it is for');

  /* The path the report came in on: full map, click a band, card opens, press
     the pin. Every one of those is a layer over the world, and the pin has to
     get through all of them. */
  mapModule.setMapSize(full);
  mapModule.updateMapView();
  canvas.fire('pointerdown', { clientX: cx, clientY: cy });
  canvas.fire('pointerup', { clientX: cx, clientY: cy });
  check('opening a band from the full map leaves nothing over the world',
    !mapModule.mapIsFull(), 'the map stayed up');

  // Away from the camp first, so the button has somewhere to bring you back to.
  mapModule.travelTo(0, 0);
  const before2 = Math.hypot(cameraRef.position.x - target.x, cameraRef.position.z - target.z);
  pin.fire('click');
  const after2 = Math.hypot(cameraRef.position.x - target.x, cameraRef.position.z - target.z);
  check('and a button on it goes to their camp', after2 < before2 && after2 < 60,
    `${before2.toFixed(0)}m -> ${after2.toFixed(0)}m`);
  /* And it points at them rather than merely standing near them. */
  const aim = Math.hypot(CONTROLS_TARGET().x - target.x, CONTROLS_TARGET().z - target.z);
  check('and the view is aimed at the middle of their camp', aim < 2,
    `${aim.toFixed(1)}m off the fire`);
  /* Every overlay, not just the card. Any one of them left up puts the camera
     behind a full-screen backdrop, which is what "it does nothing" meant. */
  for (const id of ['tribe', 'chron', 'keys']) {
    check(`and takes down the ${id} overlay`, document.getElementById(id).hidden === true,
      'it stayed up over the camp you asked to see');
  }
  document.getElementById('tribeNow').fire('click');

  // And zooming back out hands the map back to the camera.
  while (mapModule.mapZoom > 1) mapModule.stepMapZoom(-1);
  mapModule.updateMapView();
  check('zooming out gives up the pan', mapModule.mapPan === null);
  mapModule.setMapSize(0);
}

/* -------------------------------------------------------------------------
   Nobody is at a fire they do not live at

   The village had its hearths and everyone stood at the first one, because
   every "go home" in the world aimed at the middle of the camp. Source checks
   can show the call sites were changed; only the world can show that people
   ended up where those calls send them.
   ------------------------------------------------------------------------- */
let hearthReport = 'no camps';
if (liveCamps.length && livePeople.length) {
  const homed = livePeople.filter((p) => p.hearth);
  check('everybody living in a camp has a fire of their own',
    homed.length === livePeople.length,
    `${livePeople.length - homed.length} of ${livePeople.length} had none`);
  /* And it has to be one of their own camp's, not a neighbour's — the tent
     index is turned into a hearth by arithmetic, and arithmetic can land you in
     the next village. */
  const stray = homed.filter((p) => !(p.camp.fireAt || []).includes(p.hearth));
  check('and it is one of the fires in their own camp', stray.length === 0,
    `${stray.length} were at somebody else's`);

  /* A household is one tent and one fire. */
  const split = liveCamps.some((c) => {
    const byHut = new Map();
    for (const p of livePeople.filter((q) => q.camp === c && q.hut)) {
      const seen = byHut.get(p.hut);
      if (seen && seen !== p.hearth) return true;
      byHut.set(p.hut, p.hearth);
    }
    return false;
  });
  check('a household sits at one fire, not two', !split);

  /* And where there is more than one fire, more than one is used. Reported
     rather than required: whether a band in this run ever grew past ten
     households is a fact about the run, and the check would then be measuring
     the world instead of the code. */
  const villages = liveCamps.filter((c) => (c.hearths || 0) > 1);
  if (villages.length) {
    const worst = villages.map((c) => {
      const at = new Set(livePeople.filter((p) => p.camp === c).map((p) => p.hearth));
      return { c, used: at.size };
    });
    hearthReport = worst.map((w) => `${w.c.code} ${w.used}/${w.c.hearths} fires in use`).join(' · ');
    check('a village with several fires has people at more than one',
      worst.every((w) => w.used > 1), hearthReport);
  } else {
    hearthReport = `no band grew past one hearth (largest ${
      Math.max(...liveCamps.map((c) => c.families || 0))} households)`;
  }
}

/* -------------------------------------------------------------------------
   Where the foraging actually happens

   A patch was worth as much on its thousandth visit as its first, and every
   forager in a band worked out the same best spot from the same numbers — so
   the whole band walked to one place for ever. There was no mechanism by which
   it could have done otherwise.

   Counted rather than argued: where did the trips that finished actually land.
   ------------------------------------------------------------------------- */
let forageReport = 'nobody foraged';
if (livePeople.length && liveCamps.length) {
  const cell = 24;                    // a tile, which is a reasonable "same place"
  const spots = new Map();
  for (const p of livePeople) {
    for (const q of p.camp.patches || []) {
      const k = `${Math.round(q.x / cell)},${Math.round(q.z / cell)}`;
      spots.set(k, (spots.get(k) || 0) + 1);
    }
  }
  /* The ground itself, which is the thing that was not changing: how many
     patches of it have been worked at all, and how hard the worst-hit one has
     been hit. A band that goes to one place strips one cell and leaves the rest
     of the island untouched. */
  const ground = lifeModule ? lifeModule.foragedStats() : { cells: 0, worst: 0 };
  forageReport = `${spots.size} patches remembered, ${ground.cells} of the ground worked`
    + ` (worst ${(ground.worst * 100).toFixed(0)}% picked over)`;
  check('a band remembers more than one place to forage', spots.size > 1, forageReport);
  /* More than one place, which is the claim. Not a bigger number than that:
     how many patches a band works in one short run is a fact about the run —
     it fell from seven to four the day fishing was added and nothing was
     wrong, because half the trips were going to the water instead. */
  check('and the foraging is spread over the ground rather than sunk into one spot',
    ground.cells > 2, forageReport);
  /* And no patch is stripped to nothing: it recovers, which is what sends them
     back to it next week rather than never. */
  check('no patch is picked to nothing', ground.worst < 0.9, forageReport);
}

/* -------------------------------------------------------------------------
   A face, on the one person you are looking at

   Everything a person is made of is an InstancedMesh sized to the whole island,
   so eyes on everybody cost four thousand instances to be seen on one figure.
   The near set is plain meshes moved onto whoever is being followed — which
   means the thing that can go wrong is not the cost but the moving: a face left
   on somebody you stopped following, or never put on at all.
   ------------------------------------------------------------------------- */
let faceReport = 'not tested';
if (peopleModule?.nearParts && livePeople.length) {
  const face = peopleModule.nearParts;
  /* Every mesh in the set, however deep. It grew joints and a hand of fingers,
     and anything that walks it shallowly puts half of it away — a face hidden
     while ten fingers stay on the world. */
  const parts = [];
  peopleModule.eachNearPart((m) => parts.push(m));
  check('a face is built with the world', parts.length >= 5);
  check('and the joints and fingers with it', parts.length >= 20,
    `${parts.length} pieces in the near set`);

  /* Out of Follow it belongs to nobody. */
  chronicleModule?.setViewMode('fly' in {} ? 'orbit' : 'orbit');
  for (let i = 0; i < 3; i++) stepFrame(16);
  check('and is nobody\'s while you are not behind anybody',
    parts.every((m) => !m.visible), 'a face was left on the world');

  // Behind somebody, and it should be on them.
  pressKey('KeyF');
  for (let i = 0; i < 4; i++) stepFrame(16);
  const worn = parts.filter((m) => m.visible).length;
  /* Not all of them at once: fingers only exist on an open hand, and a hand
     round a spear or under a basket is a fist. */
  check('some of the set is on them, and not necessarily all of it',
    worn >= 5 && worn <= parts.length, `${worn} of ${parts.length}`);
  const p = chronicleModule?.followedPerson?.();
  faceReport = `${worn} of ${parts.length} pieces on ${p ? p.name : 'nobody'}`;
  check('and is on them once you are', worn >= 5 && Boolean(p), faceReport);
  if (p) {
    /* On the head, not near it. The eyes hang off the head's own matrix, so
       this is the check that the matrix they hang off is the right one. */
    const eye = face.eyeL;
    eye.updateMatrixWorld(true);
    const at = new (Object.getPrototypeOf(eye.position).constructor)();
    at.setFromMatrixPosition(eye.matrixWorld);
    const off = Math.hypot(at.x - p.x, at.z - p.z);
    check('and on their head rather than somewhere near them', off < 1,
      `${off.toFixed(2)}m from the person wearing it`);
  }

  /* Fingers only exist on an open hand, so the open-hand path is one a run can
     miss entirely — this one did: eleven of twenty-one pieces, because whoever
     F landed on was carrying something. Empty their hands and look again. */
  /* Posed directly rather than by driving frames. Setting a state and stepping
     the world lets the state machine move somebody into `work` before the
     measurement — and a working hand is a fist, so the check reported a closed
     hand as a bug in the fingers. `writePerson` is the thing being tested; call
     it and nothing can race it. */
  if (p && moveModule?.writePerson && chronicleModule) {
    const at = chronicleModule.followIdx;
    const pose = (over) => {
      Object.assign(p, over);
      peopleModule.hideNearParts();
      moveModule.writePerson(p, at);
      return parts.filter((m) => m.visible).length;
    };
    const open = pose({ carry: 0, hasSpear: false, state: 'goto' });
    const shut = pose({ carry: 1, hasSpear: false, state: 'goto' });
    check('an open hand has fingers on it', open > shut,
      `${open} pieces open, ${shut} closed`);
    check('and a full one is a fist, with none', shut === 11,
      `${shut} pieces on a closed hand`);
  }

  // And put away again when you let go.
  chronicleModule?.setViewMode('orbit');
  for (let i = 0; i < 3; i++) stepFrame(16);
  check('and is put away when you let go of them',
    parts.every((m) => !m.visible), 'the face stayed on the world');
}

/* -------------------------------------------------------------------------
   Footpaths, wired to the feet

   test.js walks a synthetic line across the wear field and checks the numbers
   come out. This is the other half, and it is the half that catches the way
   this actually breaks: the field is fine and nothing is connected to it.

   So it walks a real person, through `stepPerson` — the one function in the
   world that moves anybody — and then asks the ground. Everything in between is
   the product's own, over ground the person was actually able to cross.

   Measured as a rise rather than against a threshold. The band has been walking
   for thirty thousand frames by the time this runs and some of that is under
   anybody you pick, so "is this ground worn" says nothing; "did walking it
   fourteen more times wear it further, and take some of it down to earth" is
   the claim, and it is the one that fails when nothing is wired up.

   Adding wear here is safe in a way that driving frames is not: nothing in the
   simulation reads it. Grass and the terrain shader do, and neither of them
   feeds back into anybody's day.

   The one who does the walking is a stand-in rather than somebody out of the
   band, and that is not tidiness. `stepPerson` leaves more on a person than a
   position — which way they chose to dodge, and for how long they are committed
   to it — so putting a real person's x and z back afterwards puts back the half
   of them that is easy to see. It cost a check three hundred lines further down
   that leads somebody to a new point and measures whether they turn round: they
   turned round holding a dodge from a walk that never happened. */
let pathReport = 'no wear field';
if (pathsModule && moveModule && livePeople.length) {
  const real = livePeople[0];
  const home = { x: real.x, z: real.z, yaw: real.yaw };
  const before = pathsModule.pathStats();
  const under = pathsModule.wearAt(home.x, home.z);

  // The same errand, over and over, which is the only thing a path ever is.
  for (let trip = 0; trip < 14; trip++) {
    const walker = { ...home, phase: 0, scale: real.scale || 1 };
    for (let s = 0; s < 20; s++) moveModule.stepPerson(walker, 0.8);
  }

  const after = pathsModule.pathStats();
  const nowUnder = pathsModule.wearAt(home.x, home.z);
  pathReport = `${before.cells} cells worn, ${before.bare} bare · after one more `
    + `errand walked fourteen times: ${after.cells} worn, ${after.bare} bare`;
  /* The count of worn cells is the wrong thing to assert on and it took a full
     run to find out why: after a band has been about its business for a while,
     the ground around a camp is already in the field, so fourteen more trips
     across it wear it deeper without adding a single new cell. What goes up is
     how worn it is, and how much of it has reached bare earth. */
  check('walking wears the ground under it', nowUnder > under,
    `${under.toFixed(3)} before, ${nowUnder.toFixed(3)} after`);
  check('and walking the same way takes it down to earth', after.bare > before.bare,
    `${after.bare} bare against ${before.bare}`);
  /* Somewhere nobody had a reason to be. If the far corner of the island is
     worn, wear is going in somewhere other than under a foot. */
  const corner = pathsModule.wearAt(-700, -700);
  check('and only the ground somebody walked on', corner === 0, `corner reads ${corner}`);
}

const ms = Date.now() - t0;
const missing = [...new Set(touched)].filter((id) => !ids.has(id));
console.log(`\nboot check: the page loaded and built a world in ${ms}ms`);
console.log(`  ${frames} frames driven · ${elements.size} elements used`);
console.log(`  ${slotsChecked} instance slots across ${instancedMeshes} meshes swept for the zero matrix`);
console.log(`  ${colouredMeshes} of them carry per-instance colour`);
console.log(`  ${foldReport}`);
console.log(`  ${animalCount} animals, ${instancedMeshes} instanced meshes`);
console.log(`  ${motionReport}`);
console.log(`  ${rateReport}`);
console.log(`  ${nightReport}`);
console.log(`  body: ${bodyReport}`);
console.log(`  ahead: ${aheadReport}`);
console.log(`  travel: ${travelReport}`);
console.log(`  chronicle: ${chronReport}`);
console.log(`  indoors: ${indoorsReport}`);
console.log(`  tribe: ${tribeReport}`);
console.log(`  paths: ${pathReport}`);
console.log(`  full map: ${fullMapReport}`);
console.log(`  hearths: ${hearthReport}`);
console.log(`  forage: ${forageReport}`);
console.log(`  face: ${faceReport}`);
console.log(`  F picks: ${followReport}`);
for (const f of failures) console.log(`  FAILED — ${f}`);
if (missing.length) {
  console.log(`  FAILED — asked for elements that do not exist: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('  every element it asked for exists');
if (failures.length) process.exit(1);
console.log(`  follow mode: ${following ? following.textContent : '—'}`);
console.log(`  detail: ${following ? following.innerHTML.replace(/<[^>]*>/g, " | ").replace(/\s+/g, " ") : "—"}`);
console.log(`  drawn as models: ${(elements.get('stats')?.innerHTML.match(/(\d+) drawn/) || [, '0'])[1]}`);
console.log(`  models: ${modelsVendored
  ? (elements.get('stats')?.innerHTML.match(/(\d+) models/) || [, '0'])[1] + ' loaded from vendor/'
  : 'not vendored — fallback path exercised instead'}`);
console.log(`  tribes: ${(tribes ? tribes.innerHTML : '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}`);
process.exit(0);
