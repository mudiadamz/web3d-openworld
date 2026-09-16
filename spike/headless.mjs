/* Booting the island in node, with nothing drawing it.
 *
 * Pulled out of sim-headless.mjs so the bench and the pushing server are the
 * same boot rather than two that drift. It runs the real dist/ modules the page
 * runs, with three.js swapped for one whose WebGLRenderer is a stub - the trick
 * test-boot.js uses - against a throwaway DOM of its own, so nothing in here
 * can disturb the checks.
 *
 * The globals go in at import time, before any page module is loaded, because
 * several of them read the document while they are still evaluating.
 */
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const THREE_PATH = join(ROOT, 'vendor', 'three.module.js');
const HUMANS_PATH = join(ROOT, 'node_modules', 'humans-threejs', 'human-parts.js');
const DIST = join(ROOT, 'dist');
for (const [what, p] of [['three', THREE_PATH], ['humans-threejs', HUMANS_PATH], ['dist', DIST]]) {
  if (!existsSync(p)) { console.log(`missing ${what}: ${p}`); process.exit(1); }
}

/* ---- a page that is not there ---- */
const ctx2d = new Proxy({}, { get: (_, k) => (k === 'canvas' ? { width: 1, height: 1 }
  : k === 'measureText' ? () => ({ width: 0 })
    : k === 'getImageData' || k === 'createImageData' ? () => ({ data: new Uint8ClampedArray(4) })
      : () => {}) });

const cache = new Map();
const makeEl = (id = '') => ({
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
});
const byId = (id) => { if (!cache.has(id)) cache.set(id, makeEl(id)); return cache.get(id); };

globalThis.document = {
  getElementById: byId,
  createElement: () => makeEl('created'),
  createElementNS: () => makeEl('created'),
  querySelector: () => null, querySelectorAll: () => [],
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
globalThis.cancelAnimationFrame = () => {};
globalThis.performance ??= { now: () => Date.now() };
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.location = { href: 'http://localhost/', search: '', hash: '', pathname: '/' };
globalThis.navigator ??= { userAgent: 'node', maxTouchPoints: 0 };
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

/* The world is built inside two nested rAF calls (ui.js, rebuild), so a no-op
   here means it is never built at all. A queue that can be drained on demand
   lets the boot finish, and then be stopped so tick() cannot drive itself. */
const frames = [];
globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
const drain = (rounds) => {
  for (let r = 0; r < rounds; r++) {
    for (const cb of frames.splice(0, frames.length)) {
      try { cb(performance.now()); } catch { /* the stub renderer has no uniforms */ }
    }
  }
};

/* ---- three, minus the GPU ---- */
const stub = mkdtempSync(join(tmpdir(), 'openworld-headless-'));
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
export class GLTFLoader { setPath() { return this; } load(_u, _ok, _p, err) { if (err) err(new Error('no models out here')); } }
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

/** Boots an island and hands back the modules that hold it. */
export async function bootWorld({ people = 60, camps = 6, abundance = 3, map = 1500, seed, ...extra } = {}) {
  /* Anything else passed in is a setting path too - dayLength, yearLength - so a
     measurement can run a short day without this growing a parameter a time. */
  const values = { counts: { people, camps }, abundance, map, ...extra };
  if (seed !== undefined) values.seed = seed;
  globalThis.__CONFIG__ = { values, explicit: ['abundance'] };

  const t0 = Date.now();
  const load = (f) => import(pathToFileURL(join(stub, f)).href);
  const main = await load('main.js');
  const folk = await load('people.js');
  const life = await load('life.js');
  const params = await load('params.js');
  /* Let the boot sequence through, then take the wheel: nothing may queue
     itself into a frame again, because from here the steps are ours. */
  drain(8);
  frames.length = 0;
  return { main, people: folk, life, params, load, bootMs: Date.now() - t0 };
}
