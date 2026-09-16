/* The world, stepped in node with nothing drawing it.
 *
 * Asked whether the simulation should move to the server so the browser only
 * renders. This is the spike that answered it, and the answer was no - but not
 * for the reason expected. It runs the real dist/ modules the page runs, with
 * three.js swapped for one whose WebGLRenderer is a stub, the same trick
 * test-boot.js uses. A throwaway DOM rather than the harness's, so nothing here
 * can disturb the checks.
 *
 * What it found, on this machine:
 *
 *     60 people   0.09 ms a step   ~11,000 steps a second
 *    445 people   0.15 ms a step    ~6,700 steps a second
 *    boots in about 0.66 s either way
 *
 * A frame at 60 fps is 16.7 ms, so at four hundred and forty-five people the
 * whole simulation is under one percent of it. A server could own the world -
 * it boots and steps perfectly well out here, fast enough to run a dozen
 * islands - but moving it there would hand the browser back a hundred and fifty
 * microseconds of a twenty-eight millisecond frame. The rest is drawing, which
 * is what clock.js has said all along: a drawn frame cost more than a year of
 * running unwatched.
 *
 *   PEOPLE=445 CAMPS=8 STEPS=1200 node spike/sim-headless.mjs
 *
 * Kept as a bench: it is the cheapest way to ask what the step costs, and the
 * only way to ask it without a browser in the room.
 */
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const THREE_PATH = join(ROOT, 'vendor', 'three.module.js');
const HUMANS_PATH = join(ROOT, 'node_modules', 'humans-threejs', 'human-parts.js');
const LOADER_PATH = pathToFileURL(join(ROOT, 'vendor', 'GLTFLoader.js')).href;
const MODEL_DIR = join(ROOT, 'vendor', 'models');
const DIST = join(ROOT, 'dist');
for (const [what, p] of [['three', THREE_PATH], ['humans-threejs', HUMANS_PATH], ['dist', DIST]]) {
  if (!existsSync(p)) { console.log(`missing ${what}: ${p}`); process.exit(1); }
}

/* ---- a page that is not there ---- */
const ctx2d = new Proxy({}, { get: (_, k) => (k === 'canvas' ? { width: 1, height: 1 }
  : k === 'measureText' ? () => ({ width: 0 })
    : k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) })
      : k === 'createImageData' ? () => ({ data: new Uint8ClampedArray(4) })
        : () => {}) });

const cache = new Map();
const makeEl = (id = '') => {
  const el = {
    id, style: {}, dataset: {}, children: [], hidden: false,
    textContent: '', innerHTML: '', value: '', checked: false, width: 1440, height: 900,
    classList: { add() {}, remove() {}, toggle: () => false, contains: () => false },
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, remove() {}, insertAdjacentHTML() {}, scrollIntoView() {},
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 }),
    getContext: () => ctx2d, focus() {}, blur() {}, click() {},
    setPointerCapture() {}, releasePointerCapture() {}, requestPointerLock() {},
  };
  return el;
};
const byId = (id) => { if (!cache.has(id)) cache.set(id, makeEl(id)); return cache.get(id); };

globalThis.document = {
  getElementById: byId,
  createElement: () => makeEl('created'),
  createElementNS: () => makeEl('created'),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  body: makeEl('body'), documentElement: makeEl('html'), head: makeEl('head'),
  hidden: false, visibilityState: 'visible',
};
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.innerWidth = 1440;
globalThis.innerHeight = 900;
globalThis.devicePixelRatio = 1;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
/* The world is built inside two nested rAF calls (ui.js, rebuild), so a no-op
   here means it is never built at all. A queue that can be drained on demand
   lets the boot finish, and then be stopped so tick() cannot drive itself. */
const frames = [];
globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
const drain = (rounds) => {
  for (let r = 0; r < rounds; r++) {
    const due = frames.splice(0, frames.length);
    for (const cb of due) { try { cb(performance.now()); } catch (e) { console.log('frame: ' + e.message); } }
  }
};
globalThis.cancelAnimationFrame = () => {};
globalThis.performance ??= { now: () => Date.now() };
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.location = { href: 'http://localhost/', search: '', hash: '', pathname: '/' };
globalThis.navigator ??= { userAgent: 'node', maxTouchPoints: 0 };  // node 22 has one, read-only
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
const N = Number(process.env.PEOPLE || 60), C = Number(process.env.CAMPS || 6);
globalThis.__CONFIG__ = { values: { counts: { people: N, camps: C }, abundance: 3, map: 1500 }, explicit: ['abundance'] };

/* ---- three, minus the GPU ---- */
const stub = mkdtempSync(join(tmpdir(), 'openworld-spike-'));
writeFileSync(join(stub, 'three-stub.mjs'), `
import * as T from ${JSON.stringify(pathToFileURL(THREE_PATH).href)};
class WebGLRenderer {
  constructor() {
    this.domElement = { width: 1440, height: 900, style: {}, addEventListener() {} };
    this.shadowMap = { enabled: false, type: 0, needsUpdate: false };
    this.info = { render: { calls: 0, triangles: 0 } };
    this.toneMapping = 0; this.toneMappingExposure = 1; this.outputColorSpace = '';
  }
  setPixelRatio() {} setSize() {} dispose() {} compile() {} render() {}
  getPixelRatio() { return 1; }
}
export default { ...T, WebGLRenderer };
`);
writeFileSync(join(stub, 'addons.mjs'), `
import T from './three-stub.mjs';
export class OrbitControls {
  constructor(camera) {
    this.object = camera; this.target = new T.Vector3();
    this.enabled = true; this.enableDamping = false; this.dampingFactor = 0;
    this.minDistance = 0; this.maxDistance = 0; this.zoomSpeed = 1;
    this.minPolarAngle = 0; this.maxPolarAngle = Math.PI;
  }
  update() {} dispose() {} addEventListener() {}
}
export class Sky extends T.Object3D { constructor() { super(); this.material = { uniforms: {} }; } }
export class GLTFLoader { setPath() { return this; } load(_u, _ok, _p, err) { if (err) err(new Error('no models in the spike')); } }
`);

const useStubs = (s) => s
  .replace(/import \* as THREE from 'three';/, "import THREE from './three-stub.mjs';")
  .replace(/import \{ OrbitControls \} from 'three\/addons\/controls\/OrbitControls\.js';/,
    "import { OrbitControls } from './addons.mjs';")
  .replace(/import \{ Sky \} from 'three\/addons\/objects\/Sky\.js';/, "import { Sky } from './addons.mjs';")
  .replace(/import \{ GLTFLoader \} from 'three\/addons\/loaders\/GLTFLoader\.js';/,
    "import { GLTFLoader } from './addons.mjs';")
  .replace(/from 'humans-threejs\/human-parts\.js';/g, `from '${pathToFileURL(HUMANS_PATH).href}';`);

for (const f of readdirSync(DIST).filter((f) => f.endsWith('.js'))) {
  writeFileSync(join(stub, f), useStubs(readFileSync(join(DIST, f), 'utf8')));
}

/* ---- boot, then step it by hand ---- */
const t0 = Date.now();
const main = await import(pathToFileURL(join(stub, 'main.js')).href);
const people = await import(pathToFileURL(join(stub, 'people.js')).href);
const life = await import(pathToFileURL(join(stub, 'life.js')).href);
/* Let the boot sequence through, then take the wheel: nothing may queue itself
   into a frame again, because from here the steps are ours. */
drain(8);
frames.length = 0;
console.log(`booted in ${Date.now() - t0} ms · ${people.people.length} people · ${people.camps.length} camps`);

const DT = 1 / 30;
const STEPS = Number(process.env.STEPS || 1800);
const t1 = Date.now();
for (let i = 0; i < STEPS; i++) main.stepWorld(DT);
const ms = Date.now() - t1;
const p = people.people[0];
console.log(`stepped ${STEPS} times in ${ms} ms · ${(ms / STEPS).toFixed(2)} ms a step`
  + ` · ${(STEPS / (ms / 1000)).toFixed(0)} steps a second`);
console.log(`day ${Math.floor(life.simDay)} · ${people.people.length} people · ${people.camps.length} camps`);
if (p) console.log(`somebody: ${p.name} at ${p.x.toFixed(1)}, ${p.z.toFixed(1)} doing ${p.job}`);
