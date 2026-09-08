#!/usr/bin/env node
/**
 * Checks the environment layer against the page it configures.
 *
 * The point of most of this is drift: config.js declares ranges that only mean
 * anything if they match the sliders in index.html, and .env.example is only
 * useful while it lists every variable that exists. Both are the kind of thing
 * that rots quietly, so they are asserted rather than remembered.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA, SERVER_SCHEMA, parseEnvFile, resolveConfig, resolveServer } from './config.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
/* INDEX_HTML points this at a copy. Mutation testing — flipping one line and
   checking a test notices — used to work by writing the mutation into the real
   file and writing it back afterwards, which has twice now clobbered live edits
   when a run was interrupted between the two. Reading a copy instead means a
   mutation run cannot touch the page at all. */
const INDEX_HTML = process.env.INDEX_HTML || join(ROOT, 'index.html');

/* The page, plus every module it is built from.

   These checks read the source as text — which is the whole reason they are
   quick — so they have to be given all of it. While the code was one inline
   script that was just the file; now the markup and the styles are in
   index.html and the code is in src/, and `html` is the two concatenated. The
   checks never had to care which file a line lived in and they still do not. */
/* SRC_DIR points this at a copy of the modules, the way INDEX_HTML points it
   at a copy of the page — so a mutation run can flip a line without ever
   touching the code somebody is working in. */
const SRC = process.env.SRC_DIR || join(ROOT, 'src');
/* `export ` is stripped off the front of declarations as they are read. These
   checks are about what the code does, not about which file a line ended up in
   — they were all written against one long script, and one keyword of module
   plumbing in front of `const QUALITY = {` should not be the difference between
   a check that works and one that does not. What the modules actually export is
   checked separately, below. */
const moduleSource = (f) => readFileSync(join(SRC, f), 'utf8')
  .replace(/^export (?=(?:async )?function |class |const |let )/gm, '');
const srcFiles = existsSync(SRC)
  ? readdirSync(SRC).filter((f) => f.endsWith('.js')).sort()
  : [];
const sources = srcFiles.map(moduleSource);
/* The same files with the `export` keywords left on, for the few checks that
   are about the module boundary itself rather than about what the code does. */
const rawSources = srcFiles.map((f) => readFileSync(join(SRC, f), 'utf8'));
const html = [readFileSync(INDEX_HTML, 'utf8'), ...sources].join('\n');
const example = readFileSync(join(ROOT, '.env.example'), 'utf8');

/* The page's own settings block, lifted out and executed. It is plain
   JavaScript with no imports, so both the schema check and the merge check can
   run against the real thing rather than a description of it. */
/* Ends at whatever declares the world's extent, rather than at the exact text
   that used to. Pinning the literal meant the day MAP made the extent a setting,
   this slice ran off the end of the settings and swallowed every module after
   them, imports and all. */
const settingsBlock = html.slice(html.indexOf('const P = {'), html.indexOf('const WORLD ='))
  .replace('applyInjectedConfig();\napplyUrlOverrides();\n', '')
  .replace(/function applyUrlOverrides\(\)[\s\S]*?\n\}\n/, '');
const makePage = new Function('window', 'location',
  `${settingsBlock}; return { P, QUALITY, applyInjectedConfig };`).bind(null);

let pass = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { pass++; return; }
  failures.push(`${label}${detail ? '  — ' + detail : ''}`);
}
function group(name) { console.log(`\n${name}`); }

/** Blank out comments and string literals, keeping every newline in place so
    reported line numbers still mean something. */
function blankNoise(src) {
  const blank = (t) => t.replace(/[^\n]/g, ' ');
  let out = '', i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '/*') {
      const e = src.indexOf('*/', i + 2);
      const stop = e < 0 ? src.length : e + 2;
      out += blank(src.slice(i, stop)); i = stop; continue;
    }
    if (two === '//') {
      const e = src.indexOf('\n', i);
      const stop = e < 0 ? src.length : e;
      out += blank(src.slice(i, stop)); i = stop; continue;
    }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      const stop = Math.min(j + 1, src.length);
      out += blank(src.slice(i, stop)); i = stop; continue;
    }
    out += c; i++;
  }
  return out;
}

/* ---- the page has somewhere to put the config ---- */
group('injection');
check('index.html carries the <!--CONFIG--> marker', html.includes('<!--CONFIG-->'));
check('the page reads window.__CONFIG__', html.includes('window.__CONFIG__'));
check('a quality from the environment loads its populations',
  html.includes("explicit.has('quality')"));

/* ---- every variable maps to a real setting ----
   The panel used to carry a slider per setting and this compared their ranges
   against the schema. The settings now live only in the environment, so the
   drift that matters is different: a renamed key in `P` would leave its
   environment variable silently doing nothing. This evaluates the page's own
   `P` and looks each path up in it. */
group('schema vs. the page');
const page = makePage({});
for (const [name, spec] of Object.entries(SCHEMA)) {
  const parts = spec.path.split('.');
  let node = page.P, ok = true;
  for (const part of parts) {
    if (node === undefined || !(part in node)) { ok = false; break; }
    node = node[part];
  }
  check(`${name} → P.${spec.path} exists`, ok);
}

// The three enums, against the lists the page actually accepts.
/* The code, without the markup. It used to be the one inline script; now it is
   every module, and `html` is that plus index.html. Anything reading function
   bodies wants this rather than the page. */
const script = sources.join('\n');
const viewModes = (script.match(/const VIEW_MODES = \[([^\]]*)\]/) || [, ''])[1]
  .split(',').map((v) => v.trim().replace(/'/g, '')).filter(Boolean);
check('VIEW options match VIEW_MODES',
  viewModes.length === SCHEMA.VIEW.values.length && SCHEMA.VIEW.values.every((v) => viewModes.includes(v)),
  `page ${viewModes.join('|')} vs schema ${SCHEMA.VIEW.values.join('|')}`);
check('QUALITY options match the preset table',
  Object.keys(page.QUALITY).length === SCHEMA.QUALITY.values.length
    && SCHEMA.QUALITY.values.every((v) => v in page.QUALITY),
  `page ${Object.keys(page.QUALITY).join('|')}`);
const urlModels = (script.match(/\['off', 'birds', 'all'\]/) || [])[0];
check('MODELS options match what the page accepts', Boolean(urlModels)
  && SCHEMA.MODELS.values.join('|') === 'off|birds|all');

/* ---- every element the script asks for exists ----
   The boot check catches this for code that runs at load, but not for a wheel
   handler or an audio graph that is only built on a click. Two references to
   removed controls survived a panel rewrite that way; one of them would have
   thrown on every scroll. */
group('elements the script reaches for');
{
  const markupIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const asked = new Set([...script.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  const missing = [...asked].filter((id) => !markupIds.has(id));
  check('every $(id) in the script is in the markup', missing.length === 0, missing.join(', '));
}

/* ---- .env.example documents everything, and nothing it does not ---- */
group('.env.example');
const documented = new Set(
  example.split(/\r?\n/)
    .map((l) => l.trim().replace(/^#\s*/, ''))
    .map((l) => l.match(/^([A-Z_]+)=/)?.[1])
    .filter(Boolean));
for (const name of Object.keys(SCHEMA)) {
  check(`${name} is documented`, documented.has(name));
}
for (const name of Object.keys(SERVER_SCHEMA)) check(`${name} is documented`, documented.has(name));
for (const name of documented) {
  check(`${name} is a real variable`, name in SCHEMA || name in SERVER_SCHEMA);
}

/* ---- the grass shader's arithmetic, on a parked instance ----
   The shader cannot be run here, but the maths that broke can. Every rejected
   blade and every out-of-season flower is stored as an all-zero instance
   matrix, and `normalize(vec3(0))` is 0/0. A NaN normal on a collapsed triangle
   is harmless; a NaN *position* is an undefined triangle, which is what the
   flickering was. This mirrors both the old line and the new one. */
group('degenerate instances');
{
  const zero = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];        // the parked matrix
  const live = [[0.09, 0, 0], [0, 0.8, 0], [0, 0, 0.8]]; // a real blade
  const len = (v) => Math.hypot(v[0], v[1], v[2]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const wind = [0.7, 0, -0.7];

  const oldWay = (m) => {
    const n = (v) => { const l = len(v); return [v[0] / l, v[1] / l, v[2] / l]; };
    return [dot(n(m[0]), wind), dot(n(m[2]), wind)];
  };
  const newWay = (m) => {
    const n = (v) => { const l = Math.max(len(v), 1e-6); return [v[0] / l, v[1] / l, v[2] / l]; };
    return [dot(n(m[0]), wind), dot(n(m[2]), wind)];
  };

  check('the old maths made NaN out of a parked instance',
    oldWay(zero).every(Number.isNaN), JSON.stringify(oldWay(zero)));
  check('the guarded maths stays finite',
    newWay(zero).every(Number.isFinite), JSON.stringify(newWay(zero)));
  check('and is unchanged for a real blade',
    Math.abs(newWay(live)[0] - oldWay(live)[0]) < 1e-12
      && Math.abs(newWay(live)[1] - oldWay(live)[1]) < 1e-12,
    JSON.stringify(newWay(live)));

  // And the shader itself must not go back to a bare normalize of a column.
  check('no unguarded normalize of an instance column in any shader',
    !/normalize\((?:im|tim)\[/.test(script), 'found normalize on an instance column');
}

/* ---- the clock belongs to the session, not to the world ----
   Loading a world builds a new band into the year already in progress. Only
   Restart puts the calendar back. These read the actual function bodies,
   because the invariant is exactly "this code does not touch that state". */
group('loading a world leaves the clock alone');
{
  const bodyOf = (name) => {
    const start = script.indexOf(`function ${name}(`);
    if (start < 0) return null;
    let depth = 0, i = script.indexOf('{', start);
    for (let j = i; j < script.length; j++) {
      if (script[j] === '{') depth++;
      else if (script[j] === '}' && --depth === 0) return script.slice(i, j + 1);
    }
    return null;
  };
  const clockWrites = /\b(simDay|lastDawn|seasonIndex|bornCount|diedCount)\s*=[^=]|P\.time\s*=[^=]/;

  for (const fn of ['buildWorld', 'rebuild', 'disposeWorld', 'buildPeople', 'enterWorld']) {
    const body = bodyOf(fn);
    check(`${fn}() does not reset the clock`, body !== null && !clockWrites.test(body),
      body === null ? 'function not found' : (body.match(clockWrites) || [''])[0].trim());
  }

  /* Restart is gone, along with Spawn and Forget world. Nothing puts the clock
     back any more, so the invariant is stronger than it was: the clock is
     written by the simulation and by loading a saved session, and by nothing
     else at all. */
  for (const gone of ['restart', 'forgetWorld', 'respawn', 'deleteEverything']) {
    check(`${gone}() is gone`, bodyOf(gone) === null);
  }
  for (const gone of ['restart', 'respawn', 'forgetWorld', 'deleteAll']) {
    check(`nothing is wired to #${gone}`, !script.includes(`$('${gone}')`));
    check(`there is no #${gone} in the markup`, !html.includes(`id="${gone}"`));
  }
}

/* ---- parsing ---- */
group('.env parsing');
const parsed = parseEnvFile([
  '# a comment',
  '',
  'DEER=40',
  '  SPACED = 7  ',
  'QUOTED="two words"',
  "SINGLE='x'",
  'TRAILING=5 # inline comment',
  'EMPTY=',
  'no_equals_sign',
  'URL=http://example.com/#anchor',
].join('\n'));
check('reads a plain value', parsed.DEER === '40', JSON.stringify(parsed.DEER));
check('trims around the =', parsed.SPACED === '7', JSON.stringify(parsed.SPACED));
check('keeps spaces inside quotes', parsed.QUOTED === 'two words', JSON.stringify(parsed.QUOTED));
check('handles single quotes', parsed.SINGLE === 'x', JSON.stringify(parsed.SINGLE));
check('strips a trailing comment', parsed.TRAILING === '5', JSON.stringify(parsed.TRAILING));
check('keeps an empty value', parsed.EMPTY === '', JSON.stringify(parsed.EMPTY));
check('skips a line with no =', !('no_equals_sign' in parsed));
check('does not eat a # inside a url', parsed.URL === 'http://example.com/#anchor', parsed.URL);

/* ---- coercion, clamping and refusal ---- */
group('values');
const good = resolveConfig({ DEER: '40', QUALITY: 'low', SHADOWS: 'off', WIND: '0.8', SEED: '7' });
check('a count lands in counts', good.values.counts?.deer === 40);
check('an enum lands lowercased', good.values.quality === 'low');
check('off is false', good.values.shadows === false);
check('a float survives', good.values.wind === 0.8);
check('explicit lists what was set',
  good.explicit.includes('counts.deer') && good.explicit.includes('quality')
    && !good.explicit.includes('counts.trees'),
  good.explicit.join(','));
check('no warnings for good input', good.notes.length === 0, good.notes.join('; '));

const clamped = resolveConfig({ DEER: '9999', VOLUME: '-3' });
check('too many deer are clamped to the slider max', clamped.values.counts.deer === 120);
check('a negative volume is clamped to 0', clamped.values.volume === 0);
check('clamping is reported', clamped.notes.length === 2, clamped.notes.join('; '));

const bad = resolveConfig({ DEER: 'lots', QUALITY: 'ultra', SHADOWS: 'maybe' });
check('unparseable values are dropped, not guessed',
  bad.values.counts === undefined && bad.values.quality === undefined
    && bad.values.shadows === undefined);
check('and each one is explained', bad.notes.length === 3, bad.notes.join('; '));
check('nothing is marked explicit when nothing was accepted', bad.explicit.length === 0);

const empty = resolveConfig({});
check('an empty environment configures nothing',
  Object.keys(empty.values).length === 0 && empty.explicit.length === 0);
check('an empty string is not a value', resolveConfig({ DEER: '' }).explicit.length === 0);

const ints = resolveConfig({ DEER: '12.7' });
check('an int setting rounds', ints.values.counts.deer === 13);

group('server settings');
check('port defaults to 8080', resolveServer({}).port === 8080);
check('host defaults to loopback', resolveServer({}).host === '127.0.0.1');
check('port is read', resolveServer({ PORT: '3000' }).port === 3000);
check('a silly port is clamped', resolveServer({ PORT: '99999' }).port === 65535);
check('the database file has a default', resolveServer({}).chronicle_db === 'chronicle.db');
check('and can be moved', resolveServer({ CHRONICLE_DB: 'runs/one.db' }).chronicle_db === 'runs/one.db');

/* ---- use-before-declare at module level ----
   `node --check` parses; it does not evaluate, so a top-level initialiser that
   reads a const declared further down passes every syntax check and then throws
   a ReferenceError the moment the page loads — nothing renders, and the console
   holds one line. That is what happened when the seasons went in:
   `grassUniforms` read `seasonUniforms` from 1900 lines below it.

   One file at a time, now that there are files. Within a module the order on
   the page is the order in the file and this still holds; between modules the
   order is decided by the import graph, which has cycles in it and therefore
   promises nothing — which is why nothing at the top level of a module is
   allowed to touch another module's bindings at all, and why the wiring that
   used to run on load is now a wire() that main calls.

   Comments and string literals are blanked first. Without that the file's own
   prose about `$` counts as a use of it. */
/* -------------------------------------------------------------------------
   The shape of the code

   It was one 8,200-line inline script. These checks are about the split, and
   they exist because everything that went wrong during it went wrong the same
   way: a module reached for something at load time and got a binding that had
   not been initialised yet, because a graph with cycles in it decides its own
   evaluation order.
   ------------------------------------------------------------------------- */
group('one file per thing');

check('the page is markup, not a program', (() => {
  const markupOnly = readFileSync(INDEX_HTML, 'utf8');
  return !/<script type="module">[\s\S]*\bfunction\b/.test(markupOnly)
    && /<script type="module" src="src\/main\.js">/.test(markupOnly);
})());
check('and the code is in modules', srcFiles.length >= 10, `${srcFiles.length} files`);
check('none of which is longer than the page was', (() => {
  const longest = Math.max(...rawSources.map((t) => t.split('\n').length));
  return longest < 2000;
})(), `longest ${Math.max(...rawSources.map((t) => t.split('\n').length))} lines`);

/* The rule the whole split turns on. A module that touches another module's
   binding while it is still loading gets whatever that binding is at that
   moment, which with a cycle is nothing at all — the page threw four different
   ReferenceErrors this way before the wiring was deferred. */
check('no module wires the page as it loads', (() => {
  const bad = [];
  rawSources.forEach((t, k) => {
    // What this file imports; touching its own objects at load is fine, because
    // it is the module that made them.
    const imported = new Set();
    for (const m of t.matchAll(/import \{([^}]*)\} from '\.\/[\w]+\.js';/g)) {
      for (const nm of m[1].split(',')) imported.add(nm.trim());
    }
    for (const line of t.split('\n')) {
      const m = /^([\w$]+)\.(?:add|addEventListener)\(/.exec(line);
      if (m && imported.has(m[1])) bad.push(`${srcFiles[k]}: ${line.trim().slice(0, 40)}`);
    }
  });
  return bad.length ? bad.join('; ') : true;
})() === true);
check('the wiring is a function main calls instead', (() => {
  const main = rawSources[srcFiles.indexOf('main.js')] || '';
  return /wireWorld\(\);/.test(main) && /wireInput\(\);/.test(main);
})());
check('and it runs before the world is built', (() => {
  const main = rawSources[srcFiles.indexOf('main.js')] || '';
  return main.indexOf('wireWorld();') < main.indexOf('buildWorld();');
})());

/* An imported binding is read-only, so a module cannot assign to one. Every
   piece of state written from outside the module that declares it goes through
   a setter that module exports. */
check('state written from elsewhere goes through its owner', (() => {
  const owned = new Map();
  rawSources.forEach((t, k) => {
    for (const m of t.matchAll(/^export let\s+(.+)$/gm)) {
      for (const part of m[1].split(';')[0].split(',')) {
        const nm = part.split('=')[0].trim();
        if (/^[\w$]+$/.test(nm)) owned.set(nm, srcFiles[k]);
      }
    }
  });
  const bad = [];
  rawSources.forEach((t, k) => {
    for (const [nm, file] of owned) {
      if (file === srcFiles[k]) continue;
      const re = new RegExp(`(?<![\\w.$])${nm.replace(/\$/g, '\\$')}\\s*(?:=[^=>]|\\+\\+|--|\\+=|-=)`);
      for (const line of t.split('\n')) {
        if (/^export let\s/.test(line)) continue;
        if (re.test(line)) bad.push(`${srcFiles[k]} writes ${nm} (owned by ${file})`);
      }
    }
  });
  return bad.length === 0 ? true : bad.slice(0, 3).join('; ');
})() === true);

group('module-level ordering');
for (const source of sources.length ? sources : [script]) {
  const clean = blankNoise(source);
  const lines = clean.split('\n');

  // Declarations at column zero: the ones that live in module scope. The
  // thousands inside functions are somebody else's problem.
  const declaredAt = new Map();
  lines.forEach((line, i) => {
    const m = line.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)/);
    if (m && !declaredAt.has(m[1])) declaredAt.set(m[1], i);
  });

  const balance = (l) => (l.match(/[{([]/g) || []).length - (l.match(/[})\]]/g) || []).length;
  const offenders = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const head = depth === 0 && lines[i].match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (!head) { depth += balance(lines[i]); continue; }
    const own = head[1];

    // The whole initialiser, however many lines it runs to.
    let text = '', d = 0, j = i;
    do { text += '\n' + lines[j]; d += balance(lines[j]); j++; } while (d > 0 && j < lines.length);

    // A function body does not run at load, so it may name anything.
    if (!/=>|\bfunction\b/.test(text)) {
      for (const [name, at] of declaredAt) {
        if (at <= i || name === own) continue;
        // `(?!\\s*:)` skips object keys — `camps: 2` is not a use of `camps` —
        // while a value like `uBloom: seasonUniforms.uBloom` still counts,
        // because the value is not followed by a colon.
        // `$` is a legal identifier and a regex metacharacter, so it has to be
        // escaped or the pattern matches end-of-line everywhere.
        const lit = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(?<![\\w$.])${lit}(?![\\w$])(?!\\s*:)`).test(text)) {
          offenders.push(`line ${i + 1} reads ${name}, declared at line ${at + 1}`);
        }
      }
    }
    i = j - 1;
    depth = 0;
  }
  check('nothing at module level reads a const declared below it',
    offenders.length === 0, offenders.slice(0, 3).join('; '));
}

/* ---- the page's own merge, run for real ----
   The block that folds an injected payload into P is plain JavaScript with no
   imports, so it can be lifted out of the HTML and executed here. That keeps
   the half of this feature that lives in the browser under test too. */
group('the page merges what it is given');

function merged(payload) {
  const w = payload === null ? {} : { __CONFIG__: payload };
  const m = makePage(w);
  m.applyInjectedConfig();
  return m;
}
const clean = makePage({});
const base = JSON.parse(JSON.stringify(clean.P));

check('no injection leaves the built-in defaults alone',
  JSON.stringify(merged(null).P) === JSON.stringify(base));
check('an empty payload changes nothing',
  JSON.stringify(merged({ values: {}, explicit: [] }).P) === JSON.stringify(base));

const scalars = merged({ values: { seed: 777, view: 'walk', fov: 90, shadows: false },
  explicit: ['seed', 'view', 'fov', 'shadows'] }).P;
check('scalars are applied',
  scalars.seed === 777 && scalars.view === 'walk' && scalars.fov === 90 && scalars.shadows === false);
check('and nothing else moves',
  scalars.counts.deer === base.counts.deer && scalars.wind === base.wind);

const lowOnly = merged({ values: { quality: 'low' }, explicit: ['quality'] });
check('a named quality loads its populations',
  JSON.stringify(lowOnly.P.counts) === JSON.stringify(lowOnly.QUALITY.low.counts),
  JSON.stringify(lowOnly.P.counts));

const lowPlus = merged({ values: { quality: 'low', counts: { deer: 100 } },
  explicit: ['quality', 'counts.deer'] });
check('QUALITY=low with DEER=100 does what it says',
  lowPlus.P.counts.deer === 100 && lowPlus.P.counts.trees === lowPlus.QUALITY.low.counts.trees,
  `deer ${lowPlus.P.counts.deer}, trees ${lowPlus.P.counts.trees}`);

const countOnly = merged({ values: { counts: { deer: 100 } }, explicit: ['counts.deer'] }).P;
check('counts without a quality touch only those counts',
  countOnly.counts.deer === 100 && countOnly.counts.trees === base.counts.trees);

const junk = merged({ values: { nonsense: 1 }, explicit: ['nonsense'] }).P;
check('unknown keys are ignored',
  junk.nonsense === undefined && JSON.stringify(junk.counts) === JSON.stringify(base.counts));

const noPreset = merged({ values: { quality: 'nope' }, explicit: ['quality'] }).P;
check('a quality with no preset does not wipe the populations',
  JSON.stringify(noPreset.counts) === JSON.stringify(base.counts), JSON.stringify(noPreset.counts));

/* -------------------------------------------------------------------------
   Shadow focus

   The shadow map's texel grid lives in the light's frame, not the world's.
   These run the page's own snapping arithmetic — lifted out of
   updateShadowFocus, and asserted below to still match it — and check that the
   frustum centre lands exactly on that grid, which is the thing that stops
   shadow edges crawling.
   ------------------------------------------------------------------------- */

const focusSrc = html.slice(html.indexOf('function updateShadowFocus'));
check('updateShadowFocus snaps in the light frame, not the world',
  /_lightRot\.lookAt\(sunDir/.test(focusSrc) && /_focusLS\.x = Math\.round/.test(focusSrc)
  && !/Math\.round\(camera\.position\.x\)/.test(focusSrc));

// three's Matrix4.lookAt, for the sun's direction: z = dir, x = up x z, y = z x x.
function lightBasis(dir, up = [0, 1, 0]) {
  const n = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const z = n(dir);
  let x = cross(up, z);
  if (Math.hypot(...x) < 1e-9) x = cross([up[0] + 1e-4, up[1], up[2]], z);
  x = n(x);
  return [x, n(cross(z, x)), z];
}
const toLight = (p, b) => b.map((axis) => axis[0] * p[0] + axis[1] * p[1] + axis[2] * p[2]);

const TEXEL = 220 / 2048;
const snapWorld = (p) => [Math.round(p[0]), Math.round(p[1]), Math.round(p[2])];
function snapLight(p, b) {
  const ls = toLight(p, b);
  ls[0] = Math.round(ls[0] / TEXEL) * TEXEL;
  ls[1] = Math.round(ls[1] / TEXEL) * TEXEL;
  // back to world: the basis is a rotation, so transpose it
  return [0, 1, 2].map((i) => b[0][i] * ls[0] + b[1][i] * ls[1] + b[2][i] * ls[2]);
}
const offGrid = (p, b) => {
  const ls = toLight(p, b);
  return Math.max(...[ls[0], ls[1]].map((c) => {
    const r = Math.abs(c / TEXEL - Math.round(c / TEXEL));
    return Math.min(r, 1 - r);
  }));
};

// A day's worth of sun angles against a wandering camera.
let worstWorld = 0, worstLight = 0;
for (let i = 0; i < 400; i++) {
  const ang = (i / 400) * Math.PI;            // sunrise to sunset
  const dir = [Math.cos(ang) * 0.92, Math.sin(ang), 0.38];
  const b = lightBasis(dir);
  const p = [i * 0.37 - 74, 12 + Math.sin(i * 0.11) * 30, i * 0.53 - 106];
  worstWorld = Math.max(worstWorld, offGrid(snapWorld(p), b));
  worstLight = Math.max(worstLight, offGrid(snapLight(p, b), b));
}
check('rounding to whole world units misses the texel grid (the old bug)',
  worstWorld > 0.2, `worst ${(worstWorld * 100).toFixed(0)}% of a texel off`);
check('snapping in the light frame lands on the texel grid',
  worstLight < 1e-9, `worst ${worstLight.toExponential(1)} of a texel off`);

/* -------------------------------------------------------------------------
   Shadow bias

   normalBias is a single number shared by every caster in the scene, so it is
   set by the biggest surface that casts. Terrain self-shadowing needs metres of
   it; metres of it detach the shadow of a person. The two cannot both be on.
   ------------------------------------------------------------------------- */

check('the terrain does not cast by default', html.includes('mesh.castShadow = Boolean(P.terrainShadow);'));
check('terrainShadow is off by default', /terrainShadow: false,/.test(html));
check('?terrainshadow=1 turns it back on', html.includes("q.get('terrainshadow') === '1'"));
check('normalBias follows the terrain flag',
  html.includes('sunLight.shadow.normalBias = P.terrainShadow ? 1.6 : 0.06;'));

const nb = 0.06, personHeight = 1.7;
check('the standing bias is small next to the things that cast it',
  nb / personHeight < 0.05, `${(nb / personHeight * 100).toFixed(0)}% of a person`);

/* -------------------------------------------------------------------------
   Shader varyings

   This is the one that was flickering the streams. The creek's ripples were
   driven by three's `vUv`, but three declares that varying only under USE_UV,
   which it sets from a texture map — and the water has no texture. The fragment
   shader therefore referenced an identifier that did not exist, the program
   never compiled, and what the driver draws for a broken program is anyone's
   guess. Nothing headless catches it, because the boot check stubs the renderer
   and no shader is ever compiled, so it is caught here by reading instead.
   ------------------------------------------------------------------------- */
group('shader varyings');

/* Comments are stripped first, or prose explaining a varying reads as a use of
   one. The `(?<!:)` keeps https:// out of it. */
const glsl = html.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<!:)\/\/[^\n]*/g, ' ');
const declaredVaryings = new Set();
for (const m of glsl.matchAll(/varying\s+(?:highp|mediump|lowp)?\s*\w+\s+(\w+)\s*;/g)) {
  declaredVaryings.add(m[1]);
}
const undeclared = new Set();
for (const m of glsl.matchAll(/\bv[A-Z]\w*\b/g)) {
  if (!declaredVaryings.has(m[0])) undeclared.add(m[0]);
}
check('every varying the injected shaders read is declared by the page',
  undeclared.size === 0, [...undeclared].join(', '));
check('the page declares varyings at all', declaredVaryings.size > 5,
  `${declaredVaryings.size} declared`);

// A varying is only any use if both stages agree it exists.
for (const name of ['vFlowUv', 'vWorldXZ']) {
  const decls = (glsl.match(new RegExp('varying\\s+\\w+\\s+' + name + '\\s*;', 'g')) || []).length;
  check(`${name} is declared in both the vertex and the fragment stage`,
    decls >= 2, `${decls} declaration(s)`);
}

/* -------------------------------------------------------------------------
   Worlds and the chronicle

   The code and the colour are derived from the seed rather than stored, so the
   thing to check is that the derivation is stable, that it spreads, and that
   both ends of the page agree on it.
   ------------------------------------------------------------------------- */
group('world codes');

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
check('the alphabet leaves out the characters that get misread',
  !/[IO01]/.test(CODE_LETTERS), CODE_LETTERS);
check('the page uses that alphabet', html.includes(CODE_LETTERS));

// The page's own two functions, evaluated rather than reimplemented.
const codeSrc = html.slice(html.indexOf('const CODE_LETTERS'), html.indexOf('function codeChip'));
const mulberrySrc = html.slice(html.indexOf('function mulberry32'));
const worldMarks = new Function(
  mulberrySrc.slice(0, mulberrySrc.indexOf('\n}') + 2) + codeSrc
  + 'return { worldCode, worldColor };')();

const seeds = Array.from({ length: 400 }, (_, i) => (i * 7919 + 13) | 0);
const codes = seeds.map(worldMarks.worldCode);
check('a code is two characters from the alphabet',
  codes.every((c) => c.length === 2 && [...c].every((ch) => CODE_LETTERS.includes(ch))),
  codes.slice(0, 6).join(' '));
check('the same seed always gives the same code',
  seeds.every((sd) => worldMarks.worldCode(sd) === worldMarks.worldCode(sd)));
/* 32*32 = 1024 possible codes, so 400 seeds collide by the birthday paradox
   whatever you do — a fixed fraction is the wrong bar. Perfectly uniform draws
   give 1024(1 - (1 - 1/1024)^400) distinct codes, and the test is that the real
   ones land near that. Clumping shows up as far fewer. */
const distinct = new Set(codes).size;
const ideal = 1024 * (1 - (1 - 1 / 1024) ** codes.length);
check('codes spread as evenly as random draws would',
  Math.abs(distinct - ideal) / ideal < 0.08,
  `${distinct} distinct, ${ideal.toFixed(0)} expected of ${codes.length}`);
check('a colour is a real hsl()',
  seeds.every((sd) => /^hsl\(\d{1,3} 70% 70%\)$/.test(worldMarks.worldColor(sd))),
  worldMarks.worldColor(seeds[0]));
const hues = new Set(seeds.map((sd) => worldMarks.worldColor(sd)));
check('and colours spread too', hues.size > 200, `${hues.size} distinct`);

group('the chronicle');
check('an entry records which world it happened in',
  /seed: P\.seed, world: worldNameNow\(\)/.test(html));
check('the chronicle is never emptied wholesale',
  !/chronicle\.length = 0/.test(html));
check('deleting a world takes only that world\'s lines',
  /setChronicle\(chronicle\.filter\(\(e\) => e\.seed !== seed\)\)/.test(html));
check('a line is stamped with its world\'s chip', /codeChip\(e\.seed\)/.test(html));
check('it outlives the tab', /CHRONICLE_STORE/.test(html) && /function loadChronicle/.test(html));
check('and is loaded at boot', /\.then\(loadChronicle\)/.test(html));

// Events about a person say which band, or a chronicle spanning worlds is a
// list of names with nothing to attach them to.
for (const [kind, needle] of [['kill', '${who(p)} took a'],
                              ['death', '${who(p)} ${say}'],
                              ['birth', '${who(child)} was born']]) {
  check(`the ${kind} line names the band`, html.includes(needle), needle);
}
/* One helper, so a line can never be written that names a person without their
   band — and it writes the code as plain text, because that is how the line is
   stored and how it travels to another world's chronicle. */
check('there is exactly one way to name a person',
  (html.match(/function who\(p\) \{/g) || []).length === 1
  && /return `\[\$\{p\.camp\.code\}\] \$\{p\.name\}`;/.test(html));
check('a tribe code is two characters', /code: worldCode\(/.test(html));
check('its colour follows from the code, not from a seed',
  /function codeColor\(code\)/.test(html) && /get color\(\) \{ return codeColor\(this\.code\); \}/.test(html));
check('and the chronicle colours every code in a line',
  /function tribeChips\(text\)/.test(html) && /tribeChips\(e\.text\)/.test(html));

/* -------------------------------------------------------------------------
   The bend clamp

   A ribbon of triangles laid along a path folds over itself on the inside of a
   bend as soon as it is wider than the bend is tight. The clamp narrows it into
   corners. Fixed paths here rather than a world's real creeks, because how many
   folds a real creek has depends on its seed and there is no honest bound to
   assert against that.
   ------------------------------------------------------------------------- */
group('the stream ribbon');

const clampSrc = html.slice(html.indexOf('const inLen = Math.hypot'),
  html.indexOf('for (const side of [-1, 1]) {', html.indexOf('const inLen = Math.hypot')));
check('the clamp is where the ribbon is built', clampSrc.includes('Math.tan(turn / 2)'), clampSrc.slice(0, 40));

// The page's own arithmetic, run against paths built to bend.
const halfWidth = new Function('p', 'a', 'b', 'clamp',
  clampSrc + 'return half;');
const clamp01 = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* A fold is the offset edge running backwards against the direction of the
   path it is following. That is what "the ribbon crosses over itself" means,
   and it is measurable without any rendering. */
function ribbonFolds(path, useClamp) {
  const sides = [[], []];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const half = useClamp ? halfWidth(p, a, b, clamp01) : p.width * 0.5;
    sides[0].push({ x: p.x + dz * half, z: p.z - dx * half, dx, dz });
    sides[1].push({ x: p.x - dz * half, z: p.z + dx * half, dx, dz });
  }
  let folds = 0;
  for (const side of sides) {
    for (let i = 0; i < side.length - 1; i++) {
      const step = { x: side[i + 1].x - side[i].x, z: side[i + 1].z - side[i].z };
      if (step.x * side[i].dx + step.z * side[i].dz < 0) folds++;
    }
  }
  return folds;
}

/* A hairpin: out along one line and back along another close beside it. The
   ribbon is wider than the gap, so on the way round the turn the inside edge
   has nowhere to go but backwards over itself. */
const hairpin = [];
for (let i = 0; i <= 10; i++) hairpin.push({ x: i * 2, z: 0, width: 9, level: 0 });
for (let i = 10; i >= 0; i--) hairpin.push({ x: i * 2, z: 5, width: 9, level: 0 });

const loose = ribbonFolds(hairpin, false);
const tight = ribbonFolds(hairpin, true);
check('a wide ribbon round a hairpin folds without the clamp', loose >= 2, `${loose} folds`);
check(`and the clamp takes those folds out (${tight} folds, was ${loose})`, tight < loose);

// A gentle path must not be narrowed: the clamp is for corners, not for water.
const gentle = Array.from({ length: 40 }, (_, i) =>
  ({ x: i * 12, z: Math.sin(i * 0.12) * 6, width: 5, level: 0 }));
const widths = gentle.map((p, i) => halfWidth(p,
  gentle[Math.max(0, i - 1)], gentle[Math.min(39, i + 1)], clamp01));
check('a gently curving creek keeps its full width',
  widths.slice(1, -1).every((w) => w === 2.5), `${Math.min(...widths.slice(1, -1))} of 2.5`);

/* -------------------------------------------------------------------------
   Pace and energy

   A short day is a fast one: everything that moves is scaled so a walk across
   camp still takes the same slice of a day whatever the day is worth in real
   seconds. And nothing sprints indefinitely — effort is quadratic, so walking
   is nearly free and running is not.
   ------------------------------------------------------------------------- */
group('pace');

const PACE_DAY = 3600, PACE_MAX_STEP = 0.25;
const paceOf = (dayLength) => Math.min(Math.max(PACE_DAY / dayLength, 0.5), 12);
check('the page uses the same reference day and clamp',
  html.includes('const PACE_DAY = 3600;') && html.includes('const PACE_MAX_STEP = 0.25;'));
check('the reference day runs at pace 1', paceOf(3600) === 1);
check('half the day is twice the pace', paceOf(1800) === 2);
check('a long day slows down, but only so far', paceOf(7200) === 0.5);
check('and a very short one speeds up, but only so far', paceOf(60) === 12,
  String(paceOf(60)));

/* The point of it: crossing the camp costs the same fraction of a day whatever
   the day is worth in seconds. That is the invariant, not the raw speed. */
const CROSS = 40;                       // metres across a camp
const dayFraction = (dayLength) => (CROSS / (1.35 * paceOf(dayLength))) / dayLength;
for (const len of [1800, 3600, 7200]) {
  check(`a walk across camp is the same slice of a ${len}s day`,
    Math.abs(dayFraction(len) - dayFraction(3600)) < 1e-9,
    dayFraction(len).toExponential(3));
}
// Outside the clamp the invariant has to break — better that than a person
// teleporting a step at a time. Worth stating rather than leaving implied.
check('below the clamp the day is simply too short to keep up with',
  dayFraction(60) > dayFraction(3600), `${dayFraction(60).toExponential(2)}`);

check('the camera speed is not adjustable',
  !/P\.speed/.test(html) && !html.includes("SPEED: { path: 'speed'"));
check('and the wheel no longer sets one',
  !/toast\(`\$\{Math\.round\(P\.speed\)\} m\/s`/.test(html));
check('there is one fly speed and one walk speed',
  /const CAMERA_FLY = \d+;/.test(html) && /const CAMERA_WALK = \d+;/.test(html));

group('energy');

/* Read out of the page rather than written down again here, so that changing a
   constant in one place moves every check below with it. Asserting a literal
   value only catches the literal changing; these have to catch the behaviour
   changing. */
function constant(name) {
  const m = html.match(new RegExp(`const ${name} = (-?[\\d.]+);`));
  return m ? Number(m[1]) : NaN;
}
const SUSTAIN = constant('SUSTAIN');
const PERSON_STAMINA = constant('PERSON_STAMINA');
const ANIMAL_STAMINA = constant('ANIMAL_STAMINA');
const RECOVERY_SECONDS = constant('RECOVERY_SECONDS');
const SLEEP_SECONDS = constant('SLEEP_SECONDS');
const FLEE_SPENT = constant('FLEE_SPENT');
check('every energy constant is readable from the page',
  [SUSTAIN, PERSON_STAMINA, ANIMAL_STAMINA, RECOVERY_SECONDS, SLEEP_SECONDS, FLEE_SPENT]
    .every(Number.isFinite),
  JSON.stringify({ SUSTAIN, PERSON_STAMINA, ANIMAL_STAMINA, RECOVERY_SECONDS, SLEEP_SECONDS, FLEE_SPENT }));

// The page's own rate function, lifted rather than reimplemented.
const energyRate = new Function('effort', 'stamina', 'recover',
  `const SUSTAIN = ${SUSTAIN};`
  + html.slice(html.indexOf('  const over = effort - SUSTAIN;'),
    html.indexOf('}', html.indexOf('  const over = effort - SUSTAIN;'))));

/* THE regression test. An earlier cut of this spent energy on anything above a
   quarter of a jog — and a walk is 0.375 of a jog. Everyone would have been
   pinned at zero from mid-morning, nobody rested enough to hunt, and the band
   would have starved with nothing looking obviously broken. A walk has to be
   free, or the whole economy quietly dies. */
const WALK_EFFORT = 1.35 / 3.6;
check('a walk is under the pace that costs anything', WALK_EFFORT < SUSTAIN,
  `walk is ${WALK_EFFORT.toFixed(3)} of a jog, sustain ${SUSTAIN}`);
check('so walking never drains a person', energyRate(WALK_EFFORT, PERSON_STAMINA, RECOVERY_SECONDS) >= 0,
  String(energyRate(WALK_EFFORT, PERSON_STAMINA, RECOVERY_SECONDS)));
check('a deer walking never drains either',
  energyRate(1.6 / 6.8, ANIMAL_STAMINA, RECOVERY_SECONDS) >= 0);
// A day is 2700 waking seconds at the reference length; a walker must survive it.
let e = 1;
for (let t = 0; t < 2700; t += 0.5) e = Math.min(1, Math.max(0, e + energyRate(WALK_EFFORT, PERSON_STAMINA, RECOVERY_SECONDS) * 0.5));
check('a person who walks all day is not exhausted by evening', e > 0.9, e.toFixed(3));

const emptyIn = (effort, stamina) => {
  let x = 1, t = 0;
  while (x > 0.02 && t < 100000) { x += energyRate(effort, stamina, RECOVERY_SECONDS) * 0.1; t += 0.1; }
  return t;
};
const fullIn = (recover) => {
  let x = 0, t = 0;
  while (x < 0.98 && t < 100000) { x = Math.min(1, x + energyRate(0, PERSON_STAMINA, recover) * 0.1); t += 0.1; }
  return t;
};
const jog = emptyIn(1, PERSON_STAMINA);
const play = emptyIn(0.75, PERSON_STAMINA);
check('a jog runs a person down in a few minutes', jog > 90 && jog < 300, `${jog.toFixed(0)}s`);
check('and a child at play lasts much longer than that', play > jog * 2, `${play.toFixed(0)}s`);
check('a sprinting animal runs down far faster than a person',
  emptyIn(1, ANIMAL_STAMINA) < jog / 3, `${emptyIn(1, ANIMAL_STAMINA).toFixed(0)}s`);
check('resting refills it', fullIn(RECOVERY_SECONDS) < 300, `${fullIn(RECOVERY_SECONDS).toFixed(0)}s`);
check('sleeping refills it faster', fullIn(SLEEP_SECONDS) < fullIn(RECOVERY_SECONDS) / 2,
  `${fullIn(SLEEP_SECONDS).toFixed(0)}s vs ${fullIn(RECOVERY_SECONDS).toFixed(0)}s`);

/* The point of the whole mechanism: a chase with an outcome rather than a
   foregone conclusion. */
const DEER_FLEE = 6.8, HUNTER_JOG = 3.6;
const fleeAt = (energy) => DEER_FLEE * (FLEE_SPENT + (1 - FLEE_SPENT) * energy);
check('a fresh deer outruns a hunter', fleeAt(1) > HUNTER_JOG, `${fleeAt(1).toFixed(1)} m/s`);
check('a spent one does not', fleeAt(0) < HUNTER_JOG, `${fleeAt(0).toFixed(1)} m/s`);
check('the page uses that same falloff',
  html.includes('want *= FLEE_SPENT + (1 - FLEE_SPENT) * d.energy'));
check('one rate function serves both, so they cannot drift',
  (html.match(/energyRate\(/g) || []).length === 3);

check('a spent person drops to a walk',
  html.includes('want = PERSON.walk + (want - PERSON.walk) * clamp(p.energy * 1.4, 0, 1);'));
/* Hunting still wants a rested body — it is a jog and a throw — but a starving
   band tries it anyway rather than not eat. The floor is what stops hunger and
   weakness together locking out the one job that brings back a deer. */
check('hunting still wants a rested body',
  /Math\.max\(rested \* rested, 0\.25 \* hunger\)/.test(html));
/* The spiral this broke: hungry, so weak, so rest, so no food, so weaker.
   Measured before the change — a starving, weak band spent 58% of its time at
   the fire and 2% of it hunting. */
check('and resting is only worth it if there is food to recover on',
  /const restWorth = \(1 - rested\) \* \(1 - hunger\);/.test(html));
check('while hunger lifts foraging whatever state they are in',
  /\(0\.3 \+ 0\.7 \* rested \+ 0\.7 \* hunger\)/.test(html));
check('and a person carries energy through a reload',
  /e: r2\(p\.energy\)/.test(html) && /energy: Number\.isFinite\(r\.e\)/.test(html));

/* -------------------------------------------------------------------------
   Sex, sickness, tigers

   Three things that decide who lives, so worth simulating rather than trusting.
   The constants are read out of the page, so tuning any of them moves these
   checks with it instead of leaving them asserting the old world.
   ------------------------------------------------------------------------- */
group('sex');

check('the builds are a sex each, not A and B',
  /^\s*m:\s*\{/m.test(html) && /^\s*f:\s*\{/m.test(html) && !/adultA:/.test(html));
check('a person is born one or the other', /const kind = rng\(\) < 0.5 \? 'm' : 'f';/.test(html));
const hairOf = (k) => Number(html.match(new RegExp(`^\\s*${k}:.*hair: ([\\d.]+)`, 'm'))[1]);
check('hair length is what tells them apart', hairOf('f') > hairOf('m') * 3,
  `f ${hairOf('f')} vs m ${hairOf('m')}`);
check('and a child grows into whichever they will be',
  hairOf('child') > hairOf('m') && hairOf('child') < hairOf('f'),
  `child ${hairOf('child')}`);
check('and it grows with the child', /p\.hairLen = lerp\(BUILDS\.child\.hair, p\.adultHair, g\)/.test(html));
check('it takes one of each to have a child',
  /if \(mothers < 1 \|\| fathers < 1\) continue;/.test(html));
check('and the mothers set the rate, not the head count',
  /chance = mothers \* 2 \* LIFE\.birthPerYear/.test(html));
check('the panel counts both', html.includes('${women}♀ ${men}♂'));
check('and a save carries it', /sx: p\.sex/.test(html));

/* -------------------------------------------------------------------------
   One stream of luck

   The seed built the island and nothing else, so the same seed replayed a
   different history every time. Two arms of an A/B on six seeds each were not
   two arms; they were twelve unrelated worlds, and the difference between them
   was mostly noise. A measurement that contradicted itself is how that came to
   light — a control arm configured identically to an earlier one gave four
   worlds peopled where the earlier gave six.
   ------------------------------------------------------------------------- */
group('the same seed, the same history');

check('the simulation has a stream of its own', /let simRng = mulberry32\(1\);/.test(html)
  && /const luck = \(\) => simRng\(\);/.test(html)
  && /function seedSim\(seed\)/.test(html));
check('and building a world goes back to the start of it',
  /seedSim\(P\.seed\);\n  disposeWorld\(\);/.test(html));
/* The rule that keeps it honest. Anything skipped while the world runs
   unwatched must not draw from this stream, or the same seed lands in two
   different places depending on whether somebody was looking. */
const STEPPED = ['pickTarget', 'updatePredator', 'updateHerdAnchors', 'updateQuadrupeds',
  'craftChoice', 'arriveAtCamp', 'splitCamp', 'updateSickness', 'fallIll', 'repopulate',
  'tryKill', 'nearestFruit', 'pickCause', 'pickParent', 'inheritLooks', 'updateLives',
  'pickForage', 'pickWork', 'chooseJob', 'updatePeople'];
const NOT_STEPPED = ['updateButterflies', 'buildSmoke', 'resetSmoke', 'updateCamps',
  'pickFollow', 'birdSong', 'updateAudio'];
/* Where each top-level declaration starts; a function's body runs to the next. */
const decls = [...html.matchAll(/^(?:function|const|let)\s+(\w+)/gm)]
  .map((m) => ({ at: m.index, name: m[1] }));
const bodyOf = (name) => {
  const k = decls.findIndex((d) => d.name === name);
  return k < 0 ? '' : html.slice(decls[k].at, k + 1 < decls.length ? decls[k + 1].at : html.length);
};
check('everything the world steps draws from it',
  STEPPED.every((f) => !/Math\.random\(\)/.test(bodyOf(f))),
  STEPPED.filter((f) => /Math\.random\(\)/.test(bodyOf(f))).join(', ') || 'all of them');
/* Smoke, birdsong and butterflies are skipped entirely while fast-forwarding,
   so a draw from the seeded stream inside any of them would leave the same seed
   in two different places depending on whether anybody was watching — which is
   worse than not being seeded at all. */
check('and nothing that only runs when somebody is watching does',
  NOT_STEPPED.every((f) => !/\bluck\(\)/.test(bodyOf(f))),
  NOT_STEPPED.filter((f) => /\bluck\(\)/.test(bodyOf(f))).join(', ') || 'none of them');
check('stepWorld calls exactly what is allowed to draw', (() => {
  const body = bodyOf('stepWorld');
  return ['updateAnimals', 'updateEconomy', 'updateLives', 'repopulate', 'updatePeople']
    .every((f) => body.includes(f + '('));
})());
/* Unwatched years advance in fixed steps, which is what makes them replay; a
   world watched in real time advances by whatever each frame took. */
check('and unwatched years advance in fixed steps',
  /const step = ffStep\(\);/.test(html) && /stepWorld\(step\);/.test(html));

/* -------------------------------------------------------------------------
   Two things you can see

   A camp is a dozen figures the same size doing the same things, and a death
   was a number going down. Both are now something on the ground.
   ------------------------------------------------------------------------- */
group('the chief, and the dead');

check('whoever leads is wearing it', /const leads = p\.camp && p\.camp\.chief === p\.id;/.test(html)
  && /personParts\.torso\.setColorAt\(i, leads/.test(html)
  && /personParts\.hair\.setColorAt\(i, leads \? _c\.setHex\(CHIEF_BAND\)/.test(html));
/* camp.chief is only re-resolved when something asks, and the only thing that
   asked was the band card — so a chief who died stayed in ochre until somebody
   opened a panel. */
check('and who leads is settled before anyone is painted', (() => {
  const i = html.indexOf('for (const c of camps) chiefOf(c);');
  return i > 0 && /for \(let i = 0; i < people\.length/.test(html.slice(i, i + 500));
})());
check('the ochre is not a colour anybody else can be wearing', (() => {
  const cloth = (html.match(/const CHIEF_CLOTH = (0x[0-9a-f]+);/) || [, ''])[1];
  const pool = html.slice(html.indexOf('const GARMENT'), html.indexOf('const GARMENT') + 400);
  return cloth && !pool.includes(cloth);
})());

check('somebody who dies leaves a cairn', /function buryPerson\(p\)/.test(html)
  && /buryPerson\(p\);\n  p\.camp\.lost/.test(html));
check('where they fell, on the ground', (() => {
  const i = html.indexOf('function buryPerson');
  const fn = html.slice(i, i + 500);
  return /x: Math\.round\(p\.x \* 100\)/.test(fn) && /y: sampleHeight\(p\.x, p\.z\)/.test(fn);
})());
/* An InstancedMesh cannot grow, so a world left running for a century must not
   be able to spend all of memory on headstones. */
check('and there is a limit to how many the ground holds',
  /const GRAVE_MAX = \d+;/.test(html)
  && /if \(graves\.length > GRAVE_MAX\) graves\.splice\(0, graves\.length - GRAVE_MAX\);/.test(html));
check('the oldest is the one that goes', /graves\.splice\(0, /.test(html));
check('they survive a reload', /\n    graves,\n/.test(html)
  && /setGraves\(Array\.isArray\(st\.graves\) \? st\.graves\.slice\(-GRAVE_MAX\) : \[\]\);/.test(html));
/* Or the next world opens with the last one's dead scattered over ground they
   never walked on. */
check('and a new world starts with nobody buried in it',
  /setGraves\(\[\]\);\n  setGraveMesh\(null\);/.test(html));
check('every slot past the last cairn is parked out of sight',
  /for \(let i = n \* GRAVE_STONES; i < GRAVE_MAX \* GRAVE_STONES; i\+\+\) \{\n    graveMesh\.setMatrixAt\(i, HIDDEN\);/.test(html));
check('a cairn is stones piled, not one stone', (() => {
  const n = Number((html.match(/const GRAVE_STONES = (\d+);/) || [, 0])[1]);
  return n > 1;
})());
check('and the panel says how many are buried', /\$\{stats\.graves\} buried/.test(html));

group('cause of death');

const CAUSES = ['age', 'infancy', 'hunger', 'sickness', 'tiger'];
for (const c of CAUSES) {
  check(`the chronicle can say "${c}"`, new RegExp(`^\\s*${c}: \\(p, age\\) =>`, 'm').test(html));
}
check('causes compete rather than being checked in turn',
  /function pickCause\(h, total\)/.test(html) && /let roll = luck\(\) \* total;/.test(html));
check('one place removes a person, so a cause is never skipped',
  (html.match(/function killPerson\(/g) || []).length === 1
  && (html.match(/people\.splice\(i, 1\)/g) || []).length === 1);
check('and the follow camera is let go of there', /if \(i === followIdx\) setFollowIdx\(-1\);/.test(html));

/* The competing-risks draw has to be unbiased, or a cause with a small hazard
   would never be reported even when it is what killed people. */
/* `luck` is passed in rather than reached for: the real one is the simulation's
   seeded stream, and lifting the body out to run it two hundred thousand times
   should not be able to touch it. */
const pickCause = new Function('h', 'total', 'luck',
  html.slice(html.indexOf('  let roll = luck() * total;'),
    html.indexOf('}', html.indexOf("  return 'age';"))));
const hz = { age: 0.1, infancy: 0.2, hunger: 0.3, sickness: 0.4 };
const total = Object.values(hz).reduce((x, y) => x + y, 0);
const tally = {};
for (let i = 0; i < 200000; i++) {
  const c = pickCause(hz, total, Math.random);
  tally[c] = (tally[c] || 0) + 1;
}
const worst = Math.max(...Object.keys(hz).map((k) =>
  Math.abs(tally[k] / 200000 - hz[k] / total) / (hz[k] / total)));
check('a cause is drawn in proportion to its hazard', worst < 0.05,
  `worst ${(worst * 100).toFixed(1)}% off`);

/* -------------------------------------------------------------------------
   Doing something about it

   Sickness became the leading cause of death — eight of fourteen over five
   years — and it was the only one nobody could do anything about. It arrived,
   it spread by crowding, it killed, and every person in the band stood there.
   ------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------
   Ground, and a camp you can read
   ------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------
   Taking turns

   A simulated year was 111 seconds and 84 of them were the herds: two hundred
   animals deciding what to do, 172,800 times each. People were 14 of it — which
   is not where anybody would have looked, twenty-odd people being the thing the
   whole simulation is about.
   ------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------
   Indoors

   A camp of a hundred and forty was a hundred and forty figures standing in a
   clearing seventeen metres across — everybody who was not walking somewhere
   was drawn, whatever they were doing, and every toddler in the band underfoot
   among them.
   ------------------------------------------------------------------------- */
group('a camp is tents, not a crowd');

check('an errand either takes you out or it does not',
  /const OUTDOOR_JOBS = new Set\(\['gather', 'hunt', 'visit', 'play'\]\);/.test(html));
check('and everything else happens under a roof',
  /function indoorsNow\(p\)/.test(html)
  && /if \(OUTDOOR_JOBS\.has\(p\.job\)\) return false;/.test(html)
  && /return inCamp\(p\.x, p\.z, 0\);/.test(html));
/* Walking home is not being home. */
check('somebody on their way is still outside', /return inCamp\(p\.x, p\.z, 0\);/.test(html));
check('a toddler is in the tent whatever else is happening',
  /TODDLER_UNTIL = \d+;/.test(html)
  && /if \(p\.child && personAge\(p\) < TODDLER_UNTIL\) return true;/.test(html));
check('and being indoors is what stops them being drawn',
  /const hidden = p\.asleep \|\| indoorsNow\(p\);/.test(html));
/* Asleep recovers energy several times faster and is what the rest of the
   simulation means by out of reach. Somebody knapping under a roof is neither,
   and rolling the two together would make a whole camp untouchable and
   well-rested. */
check('but it is not the same as being asleep',
  /p\.asleep = p\.job === 'sleep' && p\.state !== 'goto' && arrived;/.test(html));
check('and nothing that counts people stops counting them', (() => {
  // indoorsNow is read where people are drawn, and nowhere that decides anything.
  const i = html.indexOf('function indoorsNow');
  const uses = (html.match(/indoorsNow\(/g) || []).length;
  return i > 0 && uses === 2;
})());

group('not everything, every step');

check('there is a group size, and it grows with the crowd',
  /function lodStride\(n\)/.test(html)
  && /Math\.max\(1, Math\.min\(cap, Math\.ceil\(n \/ LOD\.from\)\)\)/.test(html));
check('a small world still runs everybody every step',
  /if \(n <= LOD\.from\) return 1;/.test(html));
/* Watching used to be free of this entirely, on the reasoning that a figure
   stepping four times as far four times as often judders. True of one figure
   crossing the middle of the screen; not true of two hundred, most of whom are
   a kilometre off and a few pixels tall — and with it switched off, a big world
   spent longer on one drawn frame than on a year of running unwatched. */
check('and a watched one is grouped gently rather than not at all',
  /const cap = drawingWorld \? LOD\.watchedMost : LOD\.most;/.test(html));
check('gently meaning a few, not sixty', (() => {
  const watched = Number((html.match(/watchedMost: (\d+),/) || [, 0])[1]);
  const most = Number((html.match(/most: (\d+),/) || [, 0])[1]);
  return watched >= 2 && watched <= 8 && watched < most;
})());
check('whoever goes is decided by the step, not the clock',
  /export let worldStep = 0;/.test(html.replace(/^export /gm, 'export '))
  || /let worldStep = 0;/.test(html));
check('and the step moves exactly once per step of the world',
  /tickWorldStep\(\);/.test(html) && /function tickWorldStep\(\) \{ worldStep\+\+; \}/.test(html));
/* They get the whole wait when their turn comes, or the world runs slow. */
check('a turn is worth the time it waited for', /const slice = dt \* stride;/.test(html));
check('and the loop steps over the rest rather than asking each one',
  /for \(let i = turnStart\(stride\); i < list\.length; i \+= stride\)/.test(html)
  && /for \(let i = turnStart\(stride\); i < people\.length; i \+= stride\)/.test(html));
/* Sized per pack the threshold was never reached — the herds are four to
   forty-odd each and the number that matters is the two hundred together. */
check('the crowd is every animal on the map, not one herd',
  /for \(const pack of packs\) onMap \+= pack\.list\.length;/.test(html)
  && /herdStride\(onMap\)/.test(html));
/* A tiger covers thirty metres in a grouped step and would walk through the
   moment it was near enough to catch anything. */
check('a predator is never grouped', /spec\.predator \? 1 : herdStride\(onMap\)/.test(html));
/* Which way a deer is facing during a decade nobody watched is not a question
   worth answering 172,800 times. */
check('and a herd thinks much less often than people do',
  /herdCoarser: \d+,/.test(html) && /function herdStride\(n\)/.test(html)
  && /LOD\.most \* LOD\.herdCoarser/.test(html));
/* Groups of eight held a village; a world of two thousand in groups of eight is
   ten times the work the island cost when this was written. */
check('and the groups keep growing with the crowd', (() => {
  const most = Number((html.match(/most: (\d+),/) || [, 0])[1]);
  return most >= 32;
})());
/* A carcass was rewriting eight matrices to stay as invisible as it already
   was, sixty times a second, for ever. */
check('and a carcass is hidden once, not for ever',
  /if \(d\.dead && d\.hidden\) continue;/.test(html) && /d\.hidden = true;/.test(html));
check('until it comes back into its slot', /born\.hidden = false;/.test(html));

group('a bigger island');

check('how far the island reaches is a setting',
  SCHEMA.MAP?.path === 'map' && SCHEMA.MAP.min === 800 && SCHEMA.MAP.max === 6400);
check('and the page reads it',
  /const WORLD = Math\.max\(800, Math\.min\(6400, P\.map \|\| 1600\)\)/.test(html));
/* A literal extent anywhere in the code would be an island half of it disagrees
   about. Prose is allowed to mention the default; code is not. */
check('and nothing else decides the extent for itself', (() => {
  const code = blankNoise(sources.join('\n'));
  const stray = (code.match(/(?<![\w.])1600(?![\w])/g) || []).length;
  // REFERENCE_MAP names the island these distances were tuned on; WORLD is the
  // one they run on. Those two are allowed to say the number.
  return stray <= 3 ? true : `${stray} literals left`;
})() === true);
check('it is documented', /# MAP=1600/.test(example));

group('sharing an island');

check('a band has ground', /const GROUND = \{/.test(html)
  && /function groundOf\(x, z, notThis\)/.test(html));
check('and a forager would rather not take somebody else\'s',
  /const theirs = groundOf\(x, z, camp\) \? GROUND\.shy \* \(1 - camp\.hunger\) : 0;/.test(html));
/* Which is the point: the rule stops applying exactly when the two bands start
   to be a problem for each other. */
check('until they are hungry enough to stop caring', /\* \(1 - camp\.hunger\)/.test(html));
check('being crowded builds up, and eases off when it stops',
  /camp\.pressed = Math\.max\(0, \(camp\.pressed \|\| 0\) \+ \(squeezed \? days : -days \* 2\)\);/.test(html));
check('and a band squeezed long enough moves rather than starves',
  /patience: \d+,/.test(html) && /if \(moveCampAway\(camp\)\) camp\.pressed = 0;/.test(html));
/* Nobody is driven off. The band that goes is the one with fewer adults to
   feed itself with, which is a reason rather than a fight. */
check('the smaller band is the one that goes',
  /if \(adults\(camp\) > adults\(rival\)\) continue;/.test(html));
check('it goes somewhere with room',
  /if \(nearest < GROUND\.apart \* MAP_SCALE\) continue;/.test(html));
/* Every distance here was a number of metres tuned on a 1600 m island. On a
   4800 m one they all still meant 1600 m: six bands sited inside a 410 m circle
   in the middle of an island nine times the size, fighting over the same
   ground. Sixty people down to nine, and not one founder alive at the end. */
check('and every camp distance scales with the island', (() => {
  const code = blankNoise(sources.join('\n'));
  const spread = (code.match(/MAP_SCALE/g) || []).length;
  return spread >= 6 ? true : `${spread} places scale with it`;
})() === true);
/* A reference to the old hut is a person walking to where their house was. */
check('and everybody gets a hut in the new camp',
  /p\.hut = camp\.huts\[\(luck\(\) \* camp\.huts\.length\) \| 0\];\n    p\.state = 'idle';/.test(html));
check('the world runs it', /updateGround\(owed\);/.test(html));
/* These five walk every person and every camp and integrate a rate over the
   days that have passed. Called every step — 7,200 times a simulated day, each
   handed a `days` of 0.00014 — they were the wall a world of thousands hit, and
   the answer was the same as calling them eight times with a `days` of 0.125. */
check('and keeps the books eight times a day, not seven thousand',
  /BOOK_EVERY = 1 \/ 8;/.test(html)
  && /bookDue \+= simDays;/.test(html)
  && /if \(bookDue >= BOOK_EVERY\)/.test(html));
check('paying whatever is owed when it does', /const owed = bookDue;\s*\n\s*bookDue = 0;/.test(html));
/* Watched and unwatched have to agree, or a world runs differently depending on
   whether anybody was looking at it. */
check('on the same cadence whether anybody is watching',
  (html.match(/bookDue \+= simDays;/g) || []).length === 2);

group('a camp you can read');

/* A tent is a family, not a bed count. A camp of four families is four tents
   whether that is eight people or twenty, and a camp growing from three tents
   to a dozen is something you can count from the ridge. */
check('a tent is a family',
  /const want = here === 0 \? 0 : clamp\(camp\.families \|\| Math\.ceil\(here \/ 2\), 1, P0\.huts\);/.test(html)
  && /function familiesOf\(camp\)/.test(html));
check('which is a woman, a man, and their children with them',
  /families\.push\(\{ adults: \[women\[i\], men\[i\]\], kids: \[\] \}\)/.test(html)
  && /f\.adults\.some\(\(a\) => a\.id === p\.mother \|\| a\.id === p\.father\)/.test(html));
/* A camp is short of shelter, not of ground: the leftovers share rather than
   each taking a tent of their own. */
check('and whoever is left over shares what is spare',
  /for \(let i = 0; i < spare\.length; i \+= 2\)/.test(html));
check('everybody is put in the tent they belong in',
  /function assignHuts\(camp\)/.test(html)
  && /for \(const p of \[\.\.\.f\.adults, \.\.\.f\.kids\]\) p\.hut = hut;/.test(html));
check('and that happens whenever the band changes', (() => {
  const i = html.indexOf('function dressCamp');
  return i > 0 && /assignHuts\(camp\);/.test(html.slice(i, i + 900));
})());
/* Laying the camp out again would shuffle it around them, because the layout
   comes off the camp's own rng and that rng moves on every call. */
check('without laying the camp out again', /camp\.hutAt\[i\] = _m4\.clone\(\);/.test(html)
  && /campParts\.huts\.setMatrixAt\(slot, camp\.hutAt\[i\]\)/.test(html));
check('the drying rack only stands once they know what it is for',
  /RACK_KNOWN = [\d.]+;/.test(html)
  && /const knows = \(camp\.skill\?\.drying \|\| 0\) >= RACK_KNOWN;/.test(html));
check('and it goes up the moment they learn',
  /if \(key === 'drying'\) dressCamp\(camp\);/.test(html));
check('the camps are dressed whenever the band changes',
  /dressCamps\(\);/.test(html) && /function dressCamps\(\)/.test(html));

group('nursing');

check('somebody can sit with the ill', /\['nurse', ill > 0 && !p\.child/.test(html)
  && /nurse: 'sitting with the ill'/.test(html));
check('and it shortens the illness',
  /p\.sick -= days \* \(p\.tended \? 1 \+ PLAGUE\.nurse : 1\);/.test(html));
/* Or it is a free improvement rather than a decision. */
check('but the one sitting with them can catch it',
  /if \(luck\(\) < PLAGUE\.catching \* days\)/.test(html) && /catching: [\d.]+,/.test(html));
check('one nurse cannot sit with a whole band at once',
  /tendPer: \d+,/.test(html) && /const beds = nurses\.length \* PLAGUE\.tendPer;/.test(html));
/* A band with nothing to eat cannot spare anybody to nurse, which is the same
   band the sickness is worst in. */
check('and a starving band cannot spare anyone to do it',
  /\(1 - hunger\) \* rested[\s\S]{0,20}\* \(p\.traits\?\.sociable \?\? 1\) : 0\]/.test(html));

check('a band that has it keeps to itself', /&& !campIsIll\(p\.camp\)/.test(html)
  && /function campIsIll\(camp\)/.test(html));
/* Which is not what stops it travelling — it is what makes a visitor who left
   before it showed the only way it travels. */
check('so the way it crosses the island is a guest',
  /if \(campIsIll\(home\) && !immune\(p\)/.test(html) && /carried: [\d.]+,/.test(html));
check('and the chronicle says who brought it',
  /the sickness came to \[\$\{host\.code\}\] \$\{host\.name\} with \$\{who\(p\)\}/.test(html));

/* -------------------------------------------------------------------------
   Who somebody is

   Given the same hunger and the same tiredness every person picked identically,
   so a band was a number and following one of them was watching the average.
   ------------------------------------------------------------------------- */
group('people who differ');

check('a person is three numbers as well as a body',
  /function traitsFor\(rng, mother, father\)/.test(html)
  && /bold: inheritTrait/.test(html) && /sociable: inheritTrait/.test(html)
  && /quick: inheritTrait/.test(html));
check('and they start near the middle', (() => {
  const spread = Number((html.match(/TRAIT_SPREAD = ([\d.]+)/) || [, 0])[1]);
  return spread > 0 && spread < 0.5;
})());
check('half of it comes from the parents', /TRAIT_FROM_PARENTS = [\d.]+/.test(html)
  && /child\.traits = traitsFor\(luck, mother, father\);/.test(html));
check('and none of it can run away', /clamp\(mid \* TRAIT_FROM_PARENTS \+ own \* \(1 - TRAIT_FROM_PARENTS\), 0\.55, 1\.55\)/.test(html));

/* Each one has to reach something, or they are decoration. */
check('the bold forage further out',
  /const far = \(p\.traits\?\.bold \?\? 1\) \* \(p\.child \? FORAGE\.childRange : 1\);/.test(html)
  && /95 \* far\]/.test(html));
check('and notice a tiger later', /const notice = PANIC\.sees \/ \(p\.traits\?\.bold \?\? 1\);/.test(html));
check('the sociable walk to the neighbours more',
  /VISIT\.chance \* rested \* \(p\.traits\?\.sociable \?\? 1\)/.test(html));
check('the quick get more from a session of knapping',
  /SKILL\.perCraft \* \(p\.traits\?\.quick \?\? 1\)/.test(html));
/* Most people are unremarkable and the card should say so by saying nothing. */
check('only a strong one is worth naming', /let best = '', by = 0\.18;/.test(html));
check('and a save carries who they were',
  /tr: \[r2\(p\.traits\?\.bold \?\? 1\)/.test(html)
  && /traits: Array\.isArray\(r\.tr\)/.test(html));

group('sickness');

/* Scoped to the PLAGUE block. Reading `^\s*name:` across the whole file finds
   whichever object happens to come first, and the moment something else grew a
   `runs:` the sickness test started simulating a fourteen-day illness instead
   of a one-day one and reported the camps being wiped out. */
const plagueSrc = html.slice(html.indexOf('const PLAGUE = {'),
  html.indexOf('}', html.indexOf('const PLAGUE = {')));
function plague(name) {
  const m = plagueSrc.match(new RegExp(`^\\s*${name}: ([\\d.]+),`, 'm'));
  return m ? Number(m[1]) : NaN;
}
const PLAGUE = {
  arrival: plague('arrival'), winter: plague('winter'), spread: plague('spread'),
  crowding: plague('crowding'), runs: plague('runs'), mortality: plague('mortality'),
  immuneYears: plague('immuneYears'), drag: plague('drag'),
};
check('the plague constants are readable',
  Object.values(PLAGUE).every(Number.isFinite), JSON.stringify(PLAGUE));
check('winter is the dangerous season', PLAGUE.winter > 1);
check('surviving it buys real time', PLAGUE.immuneYears >= 3);
check('being ill slows you down', PLAGUE.drag > 0 && PLAGUE.drag < 1);

/* An outbreak has to be survivable and it has to end. Both directions matter:
   one that kills a camp every time is not a simulation, and one that nobody
   ever catches is not a disease. */
function outbreak(campSize, hunger, seasonMul) {
  let sick = new Array(campSize).fill(0);       // days of illness left
  let immune = new Array(campSize).fill(0);
  let alive = campSize, dead = 0, everIll = 0, day = 0;
  sick[0] = PLAGUE.runs; everIll = 1;
  const step = 0.05;   // the illness runs for about a sim-day, so step finely
  while (day < 400 && alive > 0) {
    const ill = sick.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
    if (ill === 0) break;
    const crowd = Math.min(alive / PLAGUE.crowding, 1.5);
    const chance = PLAGUE.spread * ill * crowd * (1 + hunger) * seasonMul * step;
    for (let i = 0; i < campSize; i++) {
      if (sick[i] > 0 || immune[i] || sick[i] === -1) continue;
      if (Math.random() < chance) { sick[i] = PLAGUE.runs; everIll++; }
    }
    for (let i = 0; i < campSize; i++) {
      if (sick[i] <= 0) continue;
      if (Math.random() < PLAGUE.mortality * (1 + 2.4 * hunger) * step) {
        sick[i] = -1; alive--; dead++; continue;
      }
      sick[i] -= step;
      if (sick[i] <= 0) { sick[i] = 0; immune[i] = 1; }
    }
    day += step;
  }
  return { dead, everIll, day, survived: alive };
}

const runs = Array.from({ length: 400 }, () => outbreak(12, 0.2, PLAGUE.winter));
const avgDead = runs.reduce((n, r) => n + r.dead, 0) / runs.length;
const wipes = runs.filter((r) => r.survived === 0).length;
const spreadAvg = runs.reduce((n, r) => n + r.everIll, 0) / runs.length;
const lasted = runs.reduce((n, r) => n + r.day, 0) / runs.length;
check('an outbreak spreads beyond the first case', spreadAvg > 2, `${spreadAvg.toFixed(1)} caught it`);
check('and it kills some of them', avgDead > 0.5, `${avgDead.toFixed(1)} dead of 12`);
check('but it does not wipe out the camp', wipes / runs.length < 0.02,
  `${wipes} of ${runs.length} camps lost`);
check('and it ends rather than running forever', lasted < PLAGUE.runs * 4,
  `${lasted.toFixed(1)} sim-days, illness runs ${PLAGUE.runs}`);

const lean = Array.from({ length: 400 }, () => outbreak(12, 0.9, PLAGUE.winter));
check('a hungry camp comes off worse',
  lean.reduce((n, r) => n + r.dead, 0) / 400 > avgDead,
  `${(lean.reduce((n, r) => n + r.dead, 0) / 400).toFixed(1)} vs ${avgDead.toFixed(1)}`);

group('the tiger');

/* Verified by booting the world three times with different TIGERS values: the
   animal total came out 189 / 191 / 197 for 0 / 2 / 8, so they are really built
   and really counted rather than merely described. What is checked here is the
   part that would silently rot — a preset forgetting them. */
for (const q of ['low', 'medium', 'high']) {
  const preset = html.match(new RegExp(`${q}: \\{[\\s\\S]*?counts: \\{([^}]*)\\}`));
  for (const beast of ['tigers', 'boars']) {
    check(`the ${q} preset has a ${beast} count`,
      preset && new RegExp(`${beast}: \\d+`).test(preset[1]),
      preset ? preset[1].trim().slice(0, 70) : 'preset not found');
  }
}
check('and so do the defaults',
  /bison: \d+, deer: \d+, rabbits: \d+, boars: \d+, tigers: \d+/.test(html));

check('it is a predator and it hunts alone',
  /key: 'tiger'[\s\S]{0,400}?predator: true/.test(html) && /herdOf: 1,/.test(html));
check('the herds are afraid of it',
  html.includes('for (const pack of packs) {\n    if (!pack.spec.predator) continue;'));
check('it prefers four legs to two', /prefersAnimals: \d+/.test(html));
check('somebody asleep in a hut is out of reach', /if \(p\.asleep\) continue;/.test(html));
check('a kill by tiger goes through the one death path',
  html.includes("killPerson(i, 'tiger')"));
check('it eats where it stands', /d\.rest = spec\.hunt\.feeds;/.test(html));
check('and it hunts on hunger rather than a stopwatch',
  /if \(d\.fed > h\.hunts\)/.test(html) && /lasts: [\d.]+,/.test(html));
check('a kill fills it, and a person less than a deer',
  /d\.fed = Math\.min\(1, d\.fed \+ \(wasPerson \? spec\.hunt\.person : spec\.hunt\.meal\)\)/.test(html));
check('hunger runs on the calendar, not the frame clock',
  /d\.fed = Math\.max\(0, d\.fed - \(slice \/ P\.dayLength\) \/ spec\.hunt\.lasts\)/.test(html));
/* This line used to reach for spec.hunt.rest, which stopped existing when the
   tiger's stopwatch became a stomach. Only a blown chase reached it, which is
   rare enough that it went unnoticed until a fast-forward ran a year of them. */
check('a blown tiger loses the chase',
  /if \(spec\.predator\) \{ d\.prey = null; d\.rest = spec\.hunt\.feeds \* 0\.4; \}/.test(html));
// Comments stripped, or the note explaining the bug reads as the bug.
check('and nothing reads a hunt field that no longer exists',
  !/spec\.hunt\.rest/.test(glsl));
check('hunters do not go after tigers', /if \(!QUARRY\[pack\.spec\.key\]\) continue;/.test(html)
  && !/tiger: \{ meat/.test(html));
check('and it reuses the same three states as everything else',
  !/'stalk'/.test(html) && !/'charge'/.test(html));

// A tiger sprints at 7.4 and a deer flees at 6.8, so a fresh chase is winnable
// only once the deer has spent itself — which is what the energy work bought.
const tigerTop = 7.4, deerTop = 6.8;
check('a tiger is faster than a deer, but not by much', tigerTop > deerTop && tigerTop < deerTop * 1.2,
  `${tigerTop} vs ${deerTop}`);

/* -------------------------------------------------------------------------
   Counts that move

   The readout used to say the same number of animals however many the band ate,
   because it counted allocated instance slots rather than living animals — a
   hunted animal keeps its slot so it can come back later. Numbers that never
   move are worse than no numbers, because they look like they are working.
   ------------------------------------------------------------------------- */
group('the counts');

check('animals are counted alive, not allocated',
  /for \(const a of pack\.list\) if \(!a\.dead\) alive\+\+;/.test(html)
  && !/stats\.animals = packs\.reduce\(\(n, p\) => n \+ p\.list\.length/.test(html));
check('a kill recounts them', /a\.dead = true;\n  recountAnimals\(\);/.test(html));
check('a tiger kill recounts them too',
  /a\.dead = true;[\s\S]{0,200}?recountAnimals\(\);/.test(html));
check('and one growing back recounts them',
  /born\.fed = [^;]+;\n    recountAnimals\(\);/.test(html));
check('the readout redraws on its own, not only when somebody dies',
  /updateHud\(\);\n    const el = \$\('fps'\);/.test(html));
check('fruit is on the readout', html.includes('${stats.fruit} fruit'));

group('the orchard');

const ORCHARD = {};
for (const k of ['reach', 'takes', 'worth', 'regrow']) {
  const m = html.match(new RegExp(`^\\s*${k}: ([\\d.]+),`, 'm'));
  ORCHARD[k] = m ? Number(m[1]) : NaN;
}
check('the orchard constants are readable', Object.values(ORCHARD).every(Number.isFinite),
  JSON.stringify(ORCHARD));

/* Fruit has to be a supplement. At 0.09 a forager standing under a tree brought
   home more fruit than forage and roughly doubled the food supply, which would
   have quietly moved the whole population equilibrium. */
const FORAGE_BASE = 0.34;
const bestBonus = ORCHARD.takes * ORCHARD.worth;
check('a good fruit trip is a supplement, not a second harvest',
  bestBonus < FORAGE_BASE * 0.5,
  `${bestBonus.toFixed(2)} on top of ${FORAGE_BASE} (${(bestBonus / FORAGE_BASE * 100).toFixed(0)}%)`);

check('picking takes fruit off and hides the instance',
  /setFruit\(i, false\);/.test(html) && /orchard\.mesh\.setMatrixAt\(i, HIDDEN\)/.test(html));
check('putting one back restores the transform it was built with, not a new one',
  /_fm4\.fromArray\(orchard\.home, i \* 16\)/.test(html));
check('the count is kept by the same function that moves the fruit',
  /stats\.fruit = orchard\.ripe;/.test(html));
check('nothing ripens out of season', /if \(season <= 0\.02\) return;/.test(html));
check('and the orchard is dropped with the world it grew in',
  /function disposeWorld\(\) \{\n  orchard = null;/.test(html));

/* Regrowth is proportional to what is missing, so a stripped orchard fills
   slowly at first. The thing worth checking is that it converges rather than
   overshooting — an orchard that ends up with more fruit than it was built with
   would be growing fruit out of nothing. */
function refill(total, missing, days, season) {
  let ripe = total - missing, debt = 0, t = 0;
  while (ripe < total && t < 1000) {
    debt += (total - ripe) * ORCHARD.regrow * season * days;
    const n = Math.floor(debt);
    if (n > 0) { debt -= n; ripe = Math.min(total, ripe + n); }
    t += days;
  }
  return { ripe, days: t };
}
const full = refill(3000, 1500, 0.02, 1);
check('a stripped orchard fills back up', full.ripe === 3000, String(full.ripe));
check('and never past what was planted', full.ripe <= 3000);
check('it takes days, not an instant', full.days > 1, `${full.days.toFixed(1)} sim-days`);
check('nothing grows in a season that does not bear', refill(3000, 1500, 0.02, 0).ripe === 1500);

/* -------------------------------------------------------------------------
   Nobody is white

   Colouring used to be written into the instanced meshes once, by slot, for the
   band the world started with. Two things followed from that, and both were
   visible on screen while every test passed:

     - anyone born afterwards took a slot nobody had painted, and three fills
       instanceColor with ONE, not zero, so they were drawn in pure white;
     - a death moves everyone after it up a slot, so the band swapped skins,
       garments and hair around at every funeral.

   The fix is that colouring belongs to the person, and the band is repainted
   whenever the band changes. These are source checks on purpose: whether a
   birth happens to push the population past its starting size inside a test run
   is luck, and a guard that only fires when it is lucky is not a guard.
   ------------------------------------------------------------------------- */
group('colouring');

check('a person carries their own colouring',
  /skin: SKIN\[/.test(html) && /garment: GARMENT\[/.test(html) && /hairColor: HAIR\[/.test(html));
check('and it is written from the person, not drawn fresh per slot',
  /function paintPerson\(i, p\)/.test(html)
  && /_c\.setHex\(p\.skin\)/.test(html)
  && /_c\.setHex\(p\.garment\)/.test(html)
  && /_c\.setHex\(p\.hairColor\)/.test(html));

/* Every part of a person has to be painted, or one of them renders white while
   the rest look right — which is harder to spot and just as wrong. */
const paint = html.slice(html.indexOf('function paintPerson(i, p)'), html.indexOf('function paintPeople'));
/* PERSON_PARTS is the one table saying what a person is made of, and the four
   places that walk the parts all read it. Whatever is in it has to be painted,
   or a new part ships rendering white and nothing says so. */
const PERSON_PARTS = Object.fromEntries(
  [...html.slice(html.indexOf('const PERSON_PARTS = {'), html.indexOf('const partsPer'))
    .matchAll(/(\w+): (\d)/g)].map((m) => [m[1], Number(m[2])]));
check('the parts table is readable', Object.keys(PERSON_PARTS).length >= 10,
  JSON.stringify(PERSON_PARTS));
const unpainted = Object.keys(PERSON_PARTS).filter((k) =>
  k !== 'spear' && k !== 'load' && !paint.includes(`'${k}'`) && !paint.includes(`personParts.${k}.`));
check('every part of a person is painted', unpainted.length === 0, unpainted.join(', '));

// The three places the band can change under it.
for (const [what, re] of [
  ['a birth or death', /hidePeopleFrom\(people\.length\);\n    \/\*[\s\S]{0,400}?paintPeople\(\);/],
  ['a person being killed', /function killPerson[\s\S]{0,600}?paintPeople\(\);/],
  ['coming back to a saved session', /hidePeopleFrom\(people\.length\);\n  paintPeople\(\);/],
]) {
  check(`${what} repaints the band`, re.test(html));
}
/* And it has to actually walk the band — a paintPeople() that returns early
   satisfies every call-site check above and paints nobody. */
const paintAll = html.slice(html.indexOf('function paintPeople()'),
  html.indexOf('function buildPeople'));
check('paintPeople walks the whole band',
  /for \(let i = 0; i < people\.length && i < peopleCapacity; i\+\+\) paintPerson\(i, people\[i\]\);/
    .test(paintAll));
check('and returns early only when there is nothing to paint into',
  (paintAll.match(/return;/g) || []).length === 1
  && /if \(!personParts\) return;/.test(paintAll));

check('the colour buffer is told it changed',
  /instanceColor\.needsUpdate = true;/.test(html));
check('and the colouring survives a reload',
  /sc: p\.skin/.test(html) && /skin: r\.sc \?\?/.test(html));
check('a save from before the change still gets a colour',
  /r\.sc \?\? SKIN\[/.test(html) && /r\.hc \?\? HAIR\[/.test(html));
check('the person meshes are named, so a sweep can find them',
  html.includes("m.name = 'person-' + key;"));

/* The value that made this invisible for so long: the boot sweep was written
   looking for black, found none, and reported clean while people rendered
   white. It has to be looking for the right colour. */
const bootSrc = readFileSync(join(ROOT, 'test-boot.js'), 'utf8');
check('the boot sweep looks for unpainted WHITE on people, not black',
  /c\[i \* 3\] === 1 && c\[i \* 3 \+ 1\] === 1 && c\[i \* 3 \+ 2\] === 1/.test(bootSrc)
  && /name\.startsWith\('person-'\)/.test(bootSrc));
check('and it runs after the world has been driven, not before',
  bootSrc.indexOf('The counts have to move') < bootSrc.indexOf('Every instance slot'));

/* -------------------------------------------------------------------------
   The clock

   One multiplier on dt, applied before anything else reads it. That is the
   whole design, and it is the part worth guarding: scale the sun separately
   from the walking and you get people ageing faster than they can get home.
   ------------------------------------------------------------------------- */
group('clock speed');

const RATES = JSON.parse((html.match(/const RATES = (\[[^\]]*\]);/) || [, '[]'])[1]);
check('there is a ladder of rates', RATES.length >= 5, JSON.stringify(RATES));
check('it is sorted and includes 1×',
  RATES.includes(1) && RATES.every((r, i) => i === 0 || r > RATES[i - 1]), JSON.stringify(RATES));
check('it goes both slower and faster than real time',
  RATES[0] < 1 && RATES[RATES.length - 1] > 1);
check('the ends hold rather than wrap',
  /setRateIndex\(clamp\(i, 0, RATES\.length - 1\)\)/.test(html));
check('minus and plus are wired', /\$\('slower'\)\.addEventListener/.test(html)
  && /\$\('faster'\)\.addEventListener/.test(html));
check('and so are the bracket keys',
  /ev\.code === 'BracketLeft'/.test(html) && /ev\.code === 'BracketRight'/.test(html));

/* The invariant that matters: one scaled dt feeds the clock, the calendar, the
   seasons, the economy and the movement, and the unscaled one feeds only the
   things that belong to the room rather than the world. */
const tickBody = html.slice(html.indexOf('function tick() {'), html.indexOf('function tick() {') + 3000);
check('the rate is applied once, to dt', /const dt = real \* clockRate\(\);/.test(tickBody));
check('the clock reads the scaled one', /P\.time = \(P\.time \+ \(dt \* 24\)/.test(tickBody));
check('the calendar reads the scaled one', /const simDays = dt \/ P\.dayLength;/.test(tickBody));
check('the walking reads the scaled one', /const paced = Math\.min\(dt \* pace\(\), PACE_MAX_STEP\);/.test(tickBody));
check('and the wind does not — weather is not life',
  /windUniforms\.uTime\.value \+= real \*/.test(tickBody));
check('nor does the frame clock the toasts run on', /elapsed \+= real;/.test(tickBody));

group('the night');

check('it is on by default', /nightSkip: true,/.test(html));
check('and how fast is a setting', /nightSkipRate: \d+,/.test(html)
  && /NIGHT_SKIP_RATE: \{ path: 'nightSkipRate'/.test(readFileSync(join(ROOT, 'config.js'), 'utf8')));
check('nothing is skipped in daylight', /sunDir\.y > -0\.02\) return false;/.test(html));
check('deep night runs whatever anyone is doing',
  /const DEEP_NIGHT = -0\.25;/.test(html) && /if \(sunDir\.y < DEEP_NIGHT\) return true;/.test(html));
check('before that, anybody still out keeps the clock honest',
  /if \(p\.asleep\) continue;/.test(html)
  && /Math\.hypot\(p\.x - p\.camp\.x, p\.z - p\.camp\.z\) > CAMP_CLEARING\) return false;/.test(html));
check('an empty world does not wait for nobody', /if \(!people\.length\) return true;/.test(html));
check('the two multipliers compose rather than compete',
  /return RATES\[rateIndex\] \* \(skipping \? P\.nightSkipRate : 1\);/.test(html));
check('and the screen says when it is running', /\$\('skip'\)/.test(html)
  && html.includes('id="skip"'));

/* Deep night is a fixed elevation, so what fraction of the night runs at full
   speed is arithmetic rather than opinion — worth stating, because "the night
   is skipped" and "most of the night is skipped" are different features. */
const DEEP = -0.25;
const nightFrac = Math.acos(-1) === Math.PI ? (Math.asin(-DEEP) / (Math.PI / 2)) : 0;
check('waiting for stragglers covers only the edges of the night',
  nightFrac < 0.25, `${(nightFrac * 100).toFixed(0)}% of the way down from the horizon`);

/* -------------------------------------------------------------------------
   Following, and what is on the caption
   ------------------------------------------------------------------------- */
group('follow');

check('F both enters follow and finds somebody new',
  /if \(ev\.code === 'KeyF'\) \{\s*if \(P\.view !== 'follow'\) setViewMode\('follow'\);\s*else pickFollow\(\);/.test(html));
check('entering follow picks somebody', /if \(mode === 'follow'\) pickFollow\(false\);/.test(html));
check('N is gone', !/KeyN/.test(html) && !/<kbd>N<\/kbd>/.test(html));
check('and the key list says F', /<kbd>F<\/kbd>/.test(html));

check('the caption carries an energy meter',
  /const bars = Math\.max\(0, Math\.min\(5, Math\.round\(p\.energy \* 5\)\)\)/.test(html)
  && /'▮'\.repeat\(bars\) \+ '▯'\.repeat\(5 - bars\)/.test(html));
/* Nought to ten, and nought has to mean nought — anything above zero rounds up
   to at least 1, or somebody reads 0 while they are still walking about. */
const energyOutOfTen = new Function('p',
  html.slice(html.indexOf('  return p.energy <= 0 ? 0'), html.indexOf('}', html.indexOf('  return p.energy <= 0 ? 0'))));
check('empty reads 0', energyOutOfTen({ energy: 0 }) === 0);
check('full reads 10', energyOutOfTen({ energy: 1 }) === 10);
check('and nothing in between reads 0',
  [0.001, 0.02, 0.049, 0.05, 0.4, 0.99].every((e) => energyOutOfTen({ energy: e }) >= 1),
  JSON.stringify([0.001, 0.02, 0.049].map((e) => energyOutOfTen({ energy: e }))));
check('it never goes over ten', energyOutOfTen({ energy: 1.5 }) === 10);
check('the meter turns red on the last of it', /ten <= 2 \? ' low' : ''/.test(html));

group('a tiger with a stomach');

const hunt = html.slice(html.indexOf("key: 'tiger'"), html.indexOf("key: 'tiger'") + 2800);
const num = (k) => Number((hunt.match(new RegExp(k + ': ([\\d.]+)')) || [, NaN])[1]);
check('a meal is worth more than the threshold to start hunting',
  num('meal') > num('hunts'), `meal ${num('meal')} vs hunts ${num('hunts')}`);
check('a person is a smaller meal than an animal',
  num('person') < num('meal'), `person ${num('person')} vs ${num('meal')}`);
check('a full stomach lasts more than a day', num('lasts') > 1, String(num('lasts')));
/* The point of the whole thing: a tiger that has just eaten spends most of its
   time not hunting. Anything less and it is a timer wearing a stomach. */
const idleShare = 1 - num('hunts');
check('a fed tiger leaves the herds alone for most of its cycle',
  idleShare > 0.4, `${(idleShare * 100).toFixed(0)}% of the way down before it looks`);
check('and being full is checked before anything is chosen',
  html.indexOf('if (d.fed > h.hunts)') < html.indexOf('const found = nearestQuarry'));

group('competition for the fruit');

check('a boar is a species like the rest', /key: 'boar', label: 'Boar'/.test(html));
check('it eats fruit', /eatsFruit: \{ reach: [\d.]+, takes: \d+/.test(html));
check('from the same orchard the band picks',
  /pickFruit\(d\.x, d\.z, eats\.reach, eats\.takes\)/.test(html));
check('and it goes looking when there is none where it stands',
  /const spot = nearestFruit\(d\.x, d\.z, eats\.seeks\)/.test(html));
check('picking is shared, not copied', /function pickFruit\(x, z, reach = ORCHARD\.reach, takes = ORCHARD\.takes\)/.test(html));
check('the band can hunt them back', /boar: \{ meat: \d+/.test(html));
check('a boar is slower than a deer', (() => {
  const b = html.slice(html.indexOf("key: 'boar'"), html.indexOf("key: 'boar'") + 900);
  const d = html.slice(html.indexOf("key: 'deer'"), html.indexOf("key: 'deer'") + 900);
  const flee = (t) => Number(t.match(/fleeSpeed: ([\d.]+)/)[1]);
  return flee(b) < flee(d);
})());

/* Measured by driving four simulated days: the orchard settles rather than
   being stripped. Regrowth is proportional to what is missing, so the more the
   boars take the faster it comes back — 3850 fruit down to 3246 with the
   decline flattening the whole way, not a slide to zero. */
const orchardRegrow = Number((html.match(/regrow: ([\d.]+),/) || [, 0])[1]);
check('regrowth is proportional, which is what makes it settle',
  /missing \* ORCHARD\.regrow \* season \* days/.test(html) && orchardRegrow > 0,
  `regrow ${orchardRegrow}`);

/* -------------------------------------------------------------------------
   Rounder bodies

   Both replacements have to occupy exactly the box they replace, or every
   pivot, offset and scale in the rigs means something slightly different and
   the whole thing comes apart in ways that are hard to see and harder to trace.
   ------------------------------------------------------------------------- */
group('bodies');

const ROUND_RINGS = JSON.parse((html.match(/const ROUND_RINGS = (\[\[[^;]*\]\]);/) || [, '[]'])[1]);
check('there is a roundness per quality level', ROUND_RINGS.length === 3, JSON.stringify(ROUND_RINGS));
check('the lowest level is boxes, as it always was', ROUND_RINGS[0][0] === 0);
check('and it gets rounder, not coarser',
  ROUND_RINGS[2][0] > ROUND_RINGS[1][0] && ROUND_RINGS[2][1] > ROUND_RINGS[1][1],
  JSON.stringify(ROUND_RINGS));
for (const q of ['low', 'medium', 'high']) {
  check(`the ${q} preset says how round it is`,
    new RegExp(`${q}: \\{[\\s\\S]{0,200}?round: \\d`).test(html));
}

/* The capsule maths, lifted out and run. A limb has to fit inside the box it
   replaces in every axis — a capsule that bulges is a leg wider than the hip it
   hangs off — and a limb shorter than it is thick has no barrel left, which
   asks CapsuleGeometry for a negative length. */
const capsuleFits = (w, h, d) => {
  const r = Math.min(w, d) * 0.5;
  const len = h - r * 2;
  if (len <= 0.001) return 'falls back';
  const scaleX = w / (r * 2), scaleZ = d / (r * 2);
  // After scaling, the widest point is r*2*scaleX by r*2*scaleZ, and the
  // tallest is len + 2r. All three have to match the box exactly.
  return Math.abs(r * 2 * scaleX - w) < 1e-9
    && Math.abs(r * 2 * scaleZ - d) < 1e-9
    && Math.abs(len + 2 * r - h) < 1e-9;
};
const limbs = [[0.11, 0.54, 0.115], [0.13, 0.85, 0.15], [0.09, 0.62, 0.11],
               [0.045, 2.1, 0.045], [0.07, 0.34, 0.07], [0.075, 0.060, 0.075]];
check('a limb fills exactly the box it replaces',
  limbs.every((l) => capsuleFits(...l) === true || capsuleFits(...l) === 'falls back'),
  JSON.stringify(limbs.map((l) => capsuleFits(...l))));
check('and a stubby one falls back rather than asking for a negative length',
  capsuleFits(0.075, 0.060, 0.075) === 'falls back');
check('the page guards that case', /if \(len <= 0\.001\) return roundBox\(w, h, d\);/.test(html));

check('nothing alive is a box any more at full quality',
  !/new THREE\.BoxGeometry\(\.\.\.p\.torso\)/.test(html)
  && !/new THREE\.BoxGeometry\(\.\.\.spec\.body\)/.test(html)
  && /torsoGeometry\(\.\.\.p\.torso\)/.test(html) && /roundBox\(\.\.\.spec\.body\)/.test(html));

/* A torso is the one part an ellipsoid cannot do: wide at the shoulders, narrow
   at the waist, wide again at the hips. */
const PROFILE = [...html.slice(html.indexOf('const TORSO_PROFILE = ['),
  html.indexOf('function torsoGeometry')).matchAll(/\[([\d.]+), (-?[\d.]+)\]/g)]
  .map((m) => [Number(m[1]), Number(m[2])]);
check('the torso profile is a profile', PROFILE.length >= 7, JSON.stringify(PROFILE));
check('it closes at both ends', PROFILE[0][0] === 0 && PROFILE[PROFILE.length - 1][0] === 0);
check('it runs bottom to top without doubling back',
  PROFILE.every(([, y], i) => i === 0 || y > PROFILE[i - 1][1]),
  JSON.stringify(PROFILE.map((q) => q[1])));
const radiusAt = (y) => {
  for (let i = 1; i < PROFILE.length; i++) {
    if (PROFILE[i][1] >= y) {
      const [r0, y0] = PROFILE[i - 1], [r1, y1] = PROFILE[i];
      return r0 + (r1 - r0) * ((y - y0) / (y1 - y0));
    }
  }
  return 0;
};
const hip = radiusAt(-0.6), waist = radiusAt(-0.02), chest = radiusAt(0.4);
check('there is a waist between the hips and the chest',
  waist < hip && waist < chest,
  `hip ${hip.toFixed(2)} waist ${waist.toFixed(2)} chest ${chest.toFixed(2)}`);
check('and it is a waist, not a pinch', waist > hip * 0.6 && waist > chest * 0.6,
  `waist is ${(waist / chest * 100).toFixed(0)}% of the chest`);
check('a chest is deeper across than front to back', /g\.scale\(1, 1, d \/ w\)/.test(html));

/* Limbs in two pieces. This is most of what separates a figure from a
   mannequin, and it only works if every piece hangs from its own joint. */
for (const joint of ['upperArm', 'foreArm', 'thigh', 'shin']) {
  check(`${joint} is a limb piece`, new RegExp(`${joint}: \\[[\\d., ]+\\]`).test(html));
  check(`and there are two of them`, PERSON_PARTS[joint] === 2);
}
check('every limb piece hangs from its joint rather than its middle',
  /const hang = \(dims\) => \{[\s\S]{0,140}?g\.translate\(0, -dims\[1\] \/ 2, 0\);/.test(html));
check('the forearm hangs off the end of the upper arm',
  /_mOff\.setPosition\(0, -S\.upperArm\[1\], 0\);/.test(html));
check('and the shin off the end of the thigh',
  /_mOff\.setPosition\(0, -S\.thigh\[1\], 0\);/.test(html));
check('a hand is on the end of the forearm',
  /_mOff\.makeTranslation\(0, -S\.foreArm\[1\], 0\);/.test(html));
check('a foot is on the end of the shin, and kept level with the ground',
  /_mOff\.makeRotationX\(-\(leg \+ knee\)\);\n    _mOff\.setPosition\(0, -S\.shin\[1\], 0\);/.test(html));
check('and it sits forward of the ankle, like a foot',
  /footGeo\.translate\(0, -p\.foot\[1\] \/ 2, p\.footZ\)/.test(html));
check('there is a neck', PERSON_PARTS.neck === 1 && /personParts\.neck\.setMatrixAt/.test(html));

/* A knee bends through the swing and not through the stance — a knee that bent
   both ways would walk like a pair of scissors. */
const kneeAt = (ph, swing) => Math.max(0, Math.sin(ph + 1.1)) * swing * 1.5;
const kneeCurve = Array.from({ length: 32 }, (_, k) => kneeAt(k / 32 * Math.PI * 2, 0.5));
check('a knee only ever bends one way', kneeCurve.every((v) => v >= 0));
check('and it is straight for part of the stride', kneeCurve.some((v) => v === 0));
check('the elbow keeps a little bend even at rest', /let elbow = 0\.22 \+/.test(html));

/* The one that actually bit. A leg is a chain, so the shin's angle in the world
   is the hip's plus the knee's — capping the knee alone leaves the hip free,
   and a deep crouch swung the shin past horizontal and put the foot higher than
   the knee. This walks the whole reachable space of poses and checks the ankle
   is below the knee in every one of them.

   It is arithmetic rather than a rendering, so it costs nothing and it covers
   poses a driven world might not happen to strike for hours. */
const SHIN_MAX = Number((html.match(/const SHIN_MAX = ([\d.]+);/) || [, NaN])[1]);
check('the shin has a bound at all', Number.isFinite(SHIN_MAX), String(SHIN_MAX));
check('and it is short of the horizontal', SHIN_MAX < Math.PI / 2, String(SHIN_MAX));

const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function pose(phase, swing, crouch) {
  const leg = Math.sin(phase) * swing - crouch * 0.9;
  let knee = Math.max(0, Math.sin(phase + 1.1)) * swing * 1.5 + crouch * 1.3;
  knee = clampN(knee, 0, Math.max(0, SHIN_MAX - leg));
  return { leg, knee, shin: leg + knee };
}
let worstShin = -Infinity, worstAnkle = -Infinity, poses = 0;
for (let c = 0; c <= 1.0001; c += 0.05) {
  for (let sw = 0; sw <= 0.62001; sw += 0.02) {
    for (let ph = 0; ph < Math.PI * 2; ph += Math.PI / 24) {
      const q = pose(ph, sw, c);
      poses++;
      worstShin = Math.max(worstShin, q.shin);
      // Ankle height relative to the knee, down the shin's own axis.
      worstAnkle = Math.max(worstAnkle, -0.44 * Math.cos(q.shin) * -1);
    }
  }
}
check('no reachable pose swings the shin past the horizontal',
  worstShin <= SHIN_MAX + 1e-9, `worst ${worstShin.toFixed(2)} rad over ${poses} poses`);
check('so the ankle is below the knee in every one of them',
  worstAnkle > 0, `worst ankle offset ${worstAnkle.toFixed(3)}m below the knee`);
check('the bound is on the sum, not on the knee alone',
  /knee = clamp\(knee, 0, Math\.max\(0, SHIN_MAX - leg\)\);/.test(html));

/* And a crouch has to read as one: the knee goes forward, the shin folds back
   underneath, and the two partly cancel. Adding the crouch to both — which is
   what a single straight leg could get away with — tips the whole leg
   backwards instead. */
check('crouching takes the knee forward', /- p\.crouch \* 0\.9;/.test(html));
check('and folds the shin back under it', /\+ crouch \* 1\.3|\+ p\.crouch \* 1\.3/.test(html));
const deep = pose(0, 0, 1);
check('a deep crouch leaves the shin near upright', Math.abs(deep.shin) < 0.6,
  `shin ${deep.shin.toFixed(2)} rad with the thigh at ${deep.leg.toFixed(2)}`);
for (const part of ['p.head', 'p.hair', 'spec.head', 'spec.hump.size']) {
  check(`${part} is rounded`, html.includes(`roundBox(...${part})`));
}
for (const [what, call] of [['a spear', 'roundLimb(...p.spear)'],
                            ['a bundle', 'roundBox(...p.load)'], ['a tail', 'roundLimb(...spec.tail)'],
                            ['horns', 'roundLimb(...spec.horns.size)']]) {
  check(`${what} rounded`, html.includes(call), call);
}
check('no part of a person is a box any more',
  !/const \w+Geo = new THREE\.BoxGeometry\(\.\.\.p\./.test(html));

/* Cost, measured by building the world at each level and counting triangles
   through the real scene graph: 1.85M as boxes against 2.03M rounded at HIGH.
   Worth writing down because the intuition is wrong — bodies look expensive and
   are not; the grass is the bill. */
check('roundness is off at the level meant for slow machines',
  ROUND_RINGS[0][0] === 0 && /low: \{[\s\S]{0,120}?round: 0/.test(html));

/* -------------------------------------------------------------------------
   Running out

   Zero on the meter means dying, so zero has to be reachable — and the first
   attempt at it could not be. Draining energy directly cannot work: resting
   recovers 0.006 a second, which is twenty full tanks over a sim-day, so a
   drain slow enough to take days is lost in the noise and one fast enough to
   compete empties somebody in minutes. Starvation is a ceiling instead.
   ------------------------------------------------------------------------- */
group('starving');

const constOf = (n) => Number((html.match(new RegExp(`const ${n} = ([\\d.]+)`)) || [, NaN])[1]);
const STARVE_FROM = constOf('STARVE_FROM'), STARVE_DRAIN = constOf('STARVE_DRAIN'),
  REFEED = constOf('REFEED');
check('the starvation constants are readable',
  [STARVE_FROM, STARVE_DRAIN, REFEED].every(Number.isFinite),
  JSON.stringify({ STARVE_FROM, STARVE_DRAIN, REFEED }));
check('it is a ceiling on energy, not a drain of it',
  /if \(p\.energy > p\.nourish\) p\.energy = p\.nourish;/.test(html));
check('and it moves on the calendar, not the frame clock',
  /const days = slice \/ P\.dayLength;/.test(html) && /\) \* days, 0, 1\);/.test(html));
check('getting back on your feet is quicker than falling off them',
  REFEED > STARVE_DRAIN, `refeed ${REFEED} vs drain ${STARVE_DRAIN}`);

/* The page's own arithmetic, run out to a conclusion. */
function starve(hunger, days, step = 0.01) {
  let nourish = 1, energy = 1, t = 0;
  while (t < days) {
    const rate = hunger > STARVE_FROM
      ? -(hunger - STARVE_FROM) / (1 - STARVE_FROM) * STARVE_DRAIN
      : REFEED;
    nourish = Math.max(0, Math.min(1, nourish + rate * step));
    if (energy > nourish) energy = nourish;
    if (energy <= 0) return t;
    t += step;
  }
  return null;
}
const YEAR = Number((html.match(/yearLength: (\d+)/) || [, 24])[1]);
check('a comfortable camp never starves anybody', starve(0.4, 200) === null);
check('a camp on the edge does not either', starve(STARVE_FROM, 200) === null);
const emptyCamp = starve(1, 200);
/* Weeks, not days. Two sim-days from full to dead is not starving, it is a
   switch — and a band that hits one bad week should come out of it thinner
   rather than smaller. Long enough for a season to turn, a hunt to come in, or
   the neighbours to send something over, all of which actually happen. */
check('an empty one takes weeks to kill somebody', emptyCamp > 4 && emptyCamp < 12,
  `${emptyCamp?.toFixed(1)} sim-days`);
check('but it does still kill them', emptyCamp !== null);
check('and it is a season, not a year', emptyCamp / YEAR * 12 < 6,
  `${(emptyCamp / YEAR * 12).toFixed(1)} months`);
/* Above the threshold but not empty. Taken from the threshold rather than
   hardcoded, so moving it moves the test with it — 0.75 was below the new one
   and the camp simply never starved, which read as a failure. */
const leanHunger = STARVE_FROM + (1 - STARVE_FROM) * 0.4;
const halfBad = starve(leanHunger, 3000);
check('and a lean camp takes far longer than an empty one',
  halfBad === null || halfBad > emptyCamp * 2,
  `hunger ${leanHunger.toFixed(2)}: ${halfBad === null ? 'never' : halfBad.toFixed(1)} against ${emptyCamp.toFixed(1)} sim-days`);
check('the meter reaching nought is death, not a risk',
  /if \(p\.energy <= 0\) \{ killPerson\(i, 'exhaustion'\); continue; \}/.test(html));
check('and the chronicle has a word for it', /exhaustion: \(p, age\) =>/.test(html));

/* Verified by driving five simulated days: population held at 16 and fell to
   14, with no exhaustion deaths at all. That is the intended shape — starving
   to death is what happens when a band fails, not something that happens to a
   band that is working. */
check('starvation is downstream of the food economy, not a separate clock',
  /p\.camp\.hunger > STARVE_FROM/.test(html));

/* -------------------------------------------------------------------------
   What the grass costs

   It was half the scene and it is scenery. Three changes, none of which move a
   blade you can actually see: a shorter blade, packing the ones that grew, and
   drawing fewer of the ones far away.
   ------------------------------------------------------------------------- */
group('grass cost');

check('a blade is two segments now, not three', /bladeGeo = bladeGeometry\(2\);/.test(html));

/* Packing. A blade that cannot grow used to be parked at zero scale and drawn
   anyway — a degenerate triangle costs no pixels but is still transformed,
   shaded and clipped, and along a coast that was most of a tile. */
const fill = html.slice(html.indexOf('function fillTile(tile, ix, iz)'), html.indexOf('function fillFlowers'));
check('a blade that cannot grow is simply not written',
  !/mesh\.setMatrixAt\(i, HIDDEN\)/.test(fill), 'still parks blades at HIDDEN');
check('the survivors are written packed', /mesh\.setMatrixAt\(i2, _m4\.compose/.test(fill));
check('and the count says how many there are', /mesh\.userData\.live = live;/.test(fill));
const flow = html.slice(html.indexOf('function fillFlowers'), html.indexOf('function fillFlowers') + 2200);
check('flowers are packed the same way',
  /mesh\.setMatrixAt\(i2, _m4\.compose/.test(flow) && !/setMatrixAt\(i, HIDDEN\)/.test(flow));

/* Thinning. The page's own density curve, run out over distance. */
const NEAR = Number(html.match(/const GRASS_NEAR = ([\d.]+);/)[1]);
const FAR = Number(html.match(/const GRASS_FAR = ([\d.]+);/)[1]);
const THIN = Number(html.match(/const GRASS_THIN = ([\d.]+);/)[1]);
const density = (d) => {
  if (d <= NEAR) return 1;
  if (d >= FAR) return THIN;
  return 1 + (THIN - 1) * ((d - NEAR) / (FAR - NEAR));
};
check('grass underfoot is not thinned at all', density(0) === 1 && density(NEAR) === 1);
check('and the far edge is thinned hard', density(FAR) === THIN && THIN < 0.4, String(THIN));
check('the ramp between them never rises',
  Array.from({ length: 60 }, (_, i) => density(i * 0.15))
    .every((v, i, arr) => i === 0 || v <= arr[i - 1] + 1e-12));
check('and never leaves the range it promises',
  Array.from({ length: 60 }, (_, i) => density(i * 0.15)).every((v) => v >= THIN && v <= 1));
check('the count drawn can never exceed the count that grew',
  /Math\.min\(live, Math\.round\(live \* tileDensity\(tile\)\)\)/.test(html));
check('an empty tile is not drawn at all', /mesh\.visible = mesh\.count > 0;/.test(html));

/* The trap in turning the draw count down: three computes an InstancedMesh's bounding
   sphere over the draw count instances, so a tile would shrink its own bounds as you
   walked away and eventually cull itself out of the frame. */
check('the bounding sphere is measured over everything in the tile',
  /const drawn = mesh\.count;\n  mesh\.count = mesh\.userData\.live \?\? drawn;\n  mesh\.computeBoundingSphere\(\);\n  mesh\.count = drawn;/.test(html));
check('and the detail pass runs every frame, not only on a refill',
  /drainDirtyTiles\(3\);\n  updateGrassDetail\(\);/.test(html));
check('a tile waiting to be refilled is left alone', /if \(t\.dirty\) continue;/.test(html));
check('the dirty queue is a flag, not a linear scan',
  /} else if \(!t\.dirty\) \{/.test(html) && !/dirtyTiles\.includes/.test(html));

/* Measured through the real scene graph at HIGH: 2.03M triangles before,
   1.29M after — the grass itself from 0.97M to 0.25M, and 35 of the 162 grass
   and flower meshes dropping out of the draw list entirely because the tile
   they cover is sea or cliff. */
const bladeTris = 2 * 2;        // segments x 2
check('a blade is four triangles', bladeTris === 4);

/* -------------------------------------------------------------------------
   What a band knows

   The thing the simulation was missing: an arrow of time. A band on day one and
   the same band fifty years later used to be the same band, because nothing it
   did ever added up to anything and knapping was an animation.
   ------------------------------------------------------------------------- */
group('knowledge');

const SK = {};
for (const k of ['perCraft', 'teach', 'step', 'fade', 'spearChance', 'basketHaul', 'dryKeep']) {
  SK[k] = Number((html.match(new RegExp(k + ': ([\\d.]+),')) || [, NaN])[1]);
}
check('the skill constants are readable', Object.values(SK).every(Number.isFinite), JSON.stringify(SK));
check('mastery is worth having', SK.spearChance > 0.5 && SK.basketHaul > 0.5 && SK.dryKeep > 0.3,
  JSON.stringify({ spears: SK.spearChance, baskets: SK.basketHaul, drying: SK.dryKeep }));
check('a generation loses a little of what the last one had', SK.teach < 1, String(SK.teach));

check('knapping produces something now',
  /practise\(p\.camp, key, SKILL\.perCraft \* \(p\.traits\?\.quick \?\? 1\)\)/.test(html));
check('a better spear kills more often',
  /q\.chance \* \(1 \+ SKILL\.spearChance \* p\.camp\.skill\.spears\)/.test(html));
check('baskets bring more home', /1 \+ SKILL\.basketHaul \* p\.camp\.skill\.baskets/.test(html));
check('and curing keeps the store', /FOOD\.spoil \* \(1 - SKILL\.dryKeep \* c\.skill\.drying\)/.test(html));

/* THE one. Knowledge is capped by what the living remember, and the only way
   memory rises is people learning. If only children learn, and only once, then
   nobody's memory ever moves, the cap never moves, and every band in every
   world stalls at exactly `step` for ever — which is precisely what happened:
   14%, in both camps, in every run, permanently. */
check('practice teaches the hands doing it',
  /p\.knows\[key\] = Math\.max\(p\.knows\[key\] \|\| 0, p\.camp\.skill\[key\]\)/.test(html));
check('and growing up teaches the next generation',
  /p\.knows\[key\] = Math\.max\(p\.knows\[key\] \|\| 0, p\.camp\.skill\[key\] \* SKILL\.teach\)/.test(html));
/* Scoped to practise() on purpose: the same line appears in fadeSkills, so an
   unscoped search passed with the cap removed from the place that matters. */
const practiseBody = html.slice(html.indexOf('function practise(camp, key, amount)'),
  html.indexOf('function practise(camp, key, amount)') + 400);
check('a camp can only practise a little past its best memory',
  /const cap = Math\.min\(1, bestKnown\(camp, key\) \+ SKILL\.step\)/.test(practiseBody)
  && /Math\.max\(cap, was\)/.test(practiseBody), practiseBody.slice(0, 60));
check('and memory is only ever what living adults hold',
  /if \(p\.camp !== camp \|\| p\.child\) continue;/.test(html));
check('so it fades with nobody to keep it', /function fadeSkills\(days\)/.test(html));

/* Simulated: a band that practises climbs, and one that loses everybody who
   knew anything falls back to what a beginner can work out unaided. */
function climb(sessionsPerDay, days, taughtEvery) {
  let camp = 0, best = 0, t = 0;
  while (t < days) {
    for (let k = 0; k < sessionsPerDay; k++) {
      camp = Math.min(camp + SK.perCraft, Math.min(1, best + SK.step));
      best = Math.max(best, camp);
    }
    camp = Math.max(0, Math.min(camp - SK.fade, Math.min(1, best + SK.step)));
    if (taughtEvery && t % taughtEvery === 0) best = Math.max(best, camp * SK.teach);
    t++;
  }
  return camp;
}
check('a band that keeps at it reaches mastery', climb(6, 60, 0) > 0.95,
  climb(6, 60, 0).toFixed(2));
check('and one that never crafts gets nowhere', climb(0, 60, 0) === 0);
check('losing everyone who knew it drops the band back to a beginner',
  Math.min(1, 0 + SK.step) <= SK.step + 1e-9,
  `back to ${(SK.step * 100).toFixed(0)}%`);

/* The chronicle used to announce mastery and its loss in the same minute, for
   ever: a band at the cap sits exactly on 1.0, practice pushes it up and the
   fade pulls it a hair under, every frame. */
check('what is announced is compared with what was last announced',
  /const told = camp\.told\[key\] \|\| 0;/.test(html) && /camp\.told\[key\] = tier;/.test(html));
check('and it takes a clear margin to change the claim',
  /const SKILL_RISE = ([\d.]+);/.test(html) && /const SKILL_FALL = ([\d.]+);/.test(html));
const RISE = Number(html.match(/const SKILL_RISE = ([\d.]+);/)[1]);
const FALL = Number(html.match(/const SKILL_FALL = ([\d.]+);/)[1]);
check('losing a skill is the louder claim, so it needs more evidence', FALL > RISE,
  `rise ${RISE} fall ${FALL}`);
check('and the deadband is wider than one frame of fade', FALL > SK.fade,
  `fall ${FALL} against a fade of ${SK.fade} a day`);

group('families');

check('everybody has an identity that is never reissued',
  /let nextPersonId = 1;/.test(html) && /id: takePersonId\(\)/.test(html)
  && /export function takePersonId\(\) \{ return nextPersonId\+\+; \}/
    .test(rawSources.join('\\n')));
check('and a save cannot collide a newborn with a grandparent',
  /setNextPersonId\(Math\.max\(nextPersonId,\n    \.\.\.st\.people\.map/.test(html));
// The dead are in the record too, and their ids must not be handed out again.
check('nor with somebody long dead',
  /\.\.\.\(Array\.isArray\(st\.lineage\) \? st\.lineage\.map\(\(r\) => \(r\.i \| 0\) \+ 1\) : \[\]\)/.test(html));
check('a child is born to named parents', /function pickParent\(camp, sex\)/.test(html)
  && /child\.motherName = mother\.name/.test(html));
check('the names are kept, not just the ids — a parent dies first',
  /motherName: r\.mn \|\| ''/.test(html));
check('the chronicle says whose child it is', /was born to \$\{mother\.name\}/.test(html));
/* Descent is reckoned through the father, so that is the parent the caption
   names — and the line and the generation with it, which is the part that
   reaches further back than one step. */
check('and the caption names the father',
  /son'\} of \$\{p\.fatherName\}/.test(html));
check('with the line they belong to and how deep they are in it',
  /\$\{ordinal\(p\.gen\)\} of the \$\{p\.line\} line/.test(html));
check('children look like their parents', /function inheritLooks\(child, mother, father\)/.test(html)
  && /child\.skin = mix\.getHex\(\)/.test(html));
check('with a little drift, or a family converges on one shade',
  /mix\.offsetHSL\(/.test(html));

group('the bands meeting');

check('a band can find its neighbour', /function otherCamp\(camp\)/.test(html));
check('and somebody walks over', /\['visit', canVisit\s*\?\s*VISIT\.chance \* rested/.test(html));

/* -------------------------------------------------------------------------
   Marrying out, and why it is not here

   Eight people is too small a sample for a coin, and a band that lands on one
   fertile woman and four men has no way back — a measured world sat on
   forty-seven days of food at 1♀ 3♂, never went hungry, and ended anyway.

   So young adults were made to marry out: the odds of staying weighted by who
   was short of whom, and somebody with nobody at home the one who set out. It
   worked, and it lost. Paired across seven seeds,at it learned across a reload', /skill: \{ spears: r2\(c\.skill\.spears\)/.test(html));
check('and so does a person', /kn: \[r2\(p\.knows\?\.spears \|\| 0\)/.test(html));
check('the panel shows what each band has worked out', /class="sk" title="\$\{SKILLS\[k\]\.label\}"/.test(html));

/* -------------------------------------------------------------------------
   Seeing ahead

   The simulation itself is driven for real in the boot check — a whole year of
   it. What is read here is the shape around it, which costs nothing to check
   and twenty seconds of real time to drive.
   ------------------------------------------------------------------------- */
group('running the world on');

/* Sliced to stepWorld's own body. Everything between it and tick() is the
   run-ahead machinery, and finishAhead legitimately rebuilds the tiles and the
   map — which made an unbounded slice fail for the right reasons at the wrong
   place. */
const stepBody = (() => {
  const at = html.indexOf('function stepWorld(dt)');
  return html.slice(at, html.indexOf('\n}', at) + 2);
})();

check('there is one step of the world, separate from drawing it',
  /function stepWorld\(dt\)/.test(html));
check('and it runs the real simulation, not a model of it',
  ['updateAnimals', 'updateSeason', 'regrowFruit', 'updateEconomy', 'updateLives',
    'repopulate', 'updatePeople'].every((f) => new RegExp(f + '\\(').test(stepBody)));
check('with nothing that only exists to be looked at',
  !/moveCamera|updateTiles|drawMap|updateAudio|updateShadowFocus|updateCamps/.test(stepBody),
  stepBody.slice(0, 60));
check('and no profiling scaffolding left in it',
  !/__ff|__stepWorld/.test(html));
check('the sun still moves, because the simulation reads it',
  /updateSunDirection\(P\.time\)/.test(stepBody));

check('asking twice does not start two', /function seeAhead\(years\) \{\n  if \(ahead\) return;/.test(html));
check('the years asked for are bounded', /clamp\(Math\.round\(years\), 1, 50\)/.test(html));
check('it runs in slices, not in one blocking loop',
  /const until = Date\.now\(\) \+ AHEAD_BUDGET;/.test(html)
  && /while \(ahead\.left > 0 && Date\.now\(\) < until\)/.test(html));
/* performance.now is replaced in the headless harness by a clock the harness
   drives itself, which would make a budget measured against it never elapse. */
check('and the budget is wall clock, not the world clock',
  !/performance\.now\(\) \+ AHEAD_BUDGET/.test(html));
check('nothing is drawn while it runs', /if \(ahead\) \{ runAhead\(\); return; \}/.test(html));

/* There has to be a way out. A world with eighty people and five hundred
   animals is many minutes to the year, and the overlay covers everything —
   without a stop the only way out is to close the tab. */
check('it can be stopped', /function stopAhead\(\)/.test(html)
  && /\$\('aheadStop'\)\.addEventListener\('click', stopAhead\)/.test(html));
check('and escape stops it too', /if \(ev\.code === 'Escape'\) \{ stopAhead\(\);/.test(html));
check('stopping runs the same tidying up as finishing',
  /ahead\.left = 0;/.test(html) && /rebuildAfterAhead\(years\)/.test(html));
/* The acknowledgement is the only thing that can be painted: a click handler
   returns and the browser gets its chance, whereas everything after it runs
   inside frames that paint nothing. */
check('and it says so the moment it is clicked',
  /\$\('aheadNote'\)\.textContent = 'stopping…';/.test(html));
/* Doing both halves in one frame is what made Stop feel like nothing happened:
   the overlay stayed up for the whole rebuild, which is a quarter of a second
   at high quality and far more on a big world. */
check('the overlay comes down a frame before the rebuilding starts',
  /ahead\.closing = true;\n    \$\('ahead'\)\.hidden = true;/.test(html)
  && /if \(ahead\.closing\) \{/.test(html));

/* The step is a DISTANCE, and the duration follows from it. Fixing the duration
   instead made a long day cost twice the work for no extra fidelity: with
   DAY_LENGTH and YEAR_LENGTH both at maximum, five years was seven million
   steps and there was no way to stop it. */
check('the step is worked out from the pace, not fixed', /function ffStep\(\)/.test(html)
  && /return FF_STEP \/ Math\.max\(pace\(\), 0\.001\)/.test(html));
check('and the run is counted in those steps',
  /Math\.round\(\(y \* P\.yearLength \* P\.dayLength\) \/ ffStep\(\)\)/.test(html));

const FF_DIST = Number(html.match(/const FF_STEP = ([\d.]+);/)[1]);
const pace = (dayLength) => Math.min(Math.max(3600 / dayLength, 0.5), 12);
const stepsFor = (years, yearLength, dayLength) =>
  (years * yearLength * dayLength) / (FF_DIST / Math.max(pace(dayLength), 0.001));
const movePerStep = (dayLength) => Math.min((FF_DIST / pace(dayLength)) * pace(dayLength), FF_DIST);

check('a step moves the same distance whatever the day is worth',
  [60, 600, 3600, 7200].every((d) => Math.abs(movePerStep(d) - FF_DIST) < 1e-9),
  [60, 600, 3600, 7200].map((d) => movePerStep(d).toFixed(3)).join(' '));
check('so a longer day is not more work for the same fidelity',
  stepsFor(5, 24, 7200) <= stepsFor(5, 24, 3600) * 1.01,
  `${(stepsFor(5, 24, 7200) / 1e6).toFixed(2)}M at 7200 against `
  + `${(stepsFor(5, 24, 3600) / 1e6).toFixed(2)}M at 3600`);
check('and the defaults are unchanged by the change',
  Math.abs(stepsFor(5, 24, 3600) - (5 * 24 * 3600) / FF_DIST) < 1,
  String(stepsFor(5, 24, 3600)));

/* And it says how long it has left, from this world's own measured rate rather
   than from a number gathered on a different one. */
check('the estimate is measured, not assumed',
  /const doneSteps = ahead\.total - ahead\.left;/.test(html)
  && /ahead\.left \/ \(doneSteps \/ spent\)/.test(html));
check('and it arrives after the first slice, not the first percent',
  /doneSteps > 400 && spent > 0\.25/.test(html));
check('and every view of the world is rebuilt afterwards',
  ['updateTimeOfDay', 'updateTiles(true)', 'recountBlades', 'recountAnimals', 'paintPeople',
    'renderTribes', 'updateHud', 'drawMap'].every((f) =>
    html.slice(html.indexOf('function rebuildAfterAhead('), html.indexOf('function tick()')).includes(f)));
check('including the clock, which tick would otherwise have written',
  /\$\('almanac'\)\.textContent = `day \$\{Math\.floor\(simDay\)\}/.test(
    html.slice(html.indexOf('function rebuildAfterAhead('))));

/* Scenery does not need to move when nobody is watching, and it turned out to
   be most of the cost: birds and butterflies together took longer per step than
   every herd, boar and tiger on the map. */
check('the scenery stops flying when nobody is watching',
  /if \(!drawingWorld\) return;\n  updateBirds/.test(html));
check('and the bodies are not written either',
  /if \(drawingWorld\) writePerson\(p, i\)/.test(html)
  && /if \(!drawingWorld\) continue;/.test(html));

/* -------------------------------------------------------------------------
   Getting there

   Two faults with one cause. A person walked straight at their target, and if
   the next step was too steep they stopped and picked a new errand — around
   their own camp, checking the ground only at the destination and never along
   the way.
   ------------------------------------------------------------------------- */
group('walking');

const DETOURS = JSON.parse((html.match(/const DETOURS = (\[[^\]]*\]);/) || [, '[]'])[1]);
check('there is a list of ways round', DETOURS.length >= 5, JSON.stringify(DETOURS));
check('they are magnitudes, tried to either side', DETOURS.every((d) => d > 0));
check('widening as they go', DETOURS.every((d, i) => i === 0 || d > DETOURS[i - 1]),
  JSON.stringify(DETOURS));
/* The bug this list caused. It went to 2.6 radians — 149°, which is not a
   detour, it is walking away. Somebody blocked took a near-reversal, the turn
   toward their target pulled them straight back into the same ground, and they
   reversed again: back and forth all night, never arriving. */
check('and none of them is anywhere near walking backwards',
  Math.max(...DETOURS) < Math.PI * 0.58,
  `widest ${Math.max(...DETOURS).toFixed(2)} rad = ${(Math.max(...DETOURS) * 57.3).toFixed(0)}°`);

check('a step is tried in each of them', /function stepPerson\(p, step\)/.test(html)
  && /for \(const off of DETOURS\)/.test(html));
/* Re-choosing a side every frame is how somebody zig-zags along a slope
   instead of walking along it. */
check('and having picked a side they keep it', /const DODGE_HOLD = \d+;/.test(html)
  && /p\.dodgeUntil = worldClock \+ DODGE_HOLD/.test(html));
check('until the way ahead is clear again', /if \(tryAt\(p\.yaw, WALKABLE\)\) \{ p\.dodgeUntil = 0; return true; \}/.test(html));
check('or that side runs out of room', /p\.dodgeSide = -\(p\.dodgeSide \|\| 1\)/.test(html));
// And the walking actually goes through it, rather than it merely existing.
check('and the walk uses it', /if \(step > 0 && !stepPerson\(p, step\)\)/.test(html));
check('the heading that worked is kept, so a spur is followed round',
  /p\.yaw = a;/.test(html));
/* Somebody boxed in on every heading has to be able to leave, or they stand
   there for the rest of their life. */
check('and there is a way out of a pocket',
  /if \(tryAt\(p\.yaw \+ side \* off, 0\.30\)\) return true;/.test(html));
check('which is looser than the ground they would choose',
  /const WALKABLE = 0\.66;/.test(html));

/* The second fault. pickWork picks around the walker's OWN camp, and for
   anything that is not a hunt or a forage it picks 2-9 metres from the fire —
   so the first bump on the way to a neighbour 260 metres off sent the visitor
   home, every time, and nobody ever arrived. */
check('a visit is never given up because of a hillside',
  /if \(p\.job !== 'visit'\) pickWork\(p\);/.test(html));

group('long enough to get there');

check('the time allowed is the distance', /function travelTimeout\(p\)/.test(html)
  && /const dist = Math\.hypot\(p\.targetX - p\.x, p\.targetZ - p\.z\)/.test(html));
check('and no errand is given a flat sixty seconds any more',
  !/p\.timer = 60;/.test(html) && !/p\.timer = 90;/.test(html) && !/p\.timer = 120;/.test(html));

/* The arithmetic that made it a certainty rather than a risk. */
const WALK_MS = 1.35, JOG_MS = 3.6;
const trips = [['a near forage', 26, WALK_MS], ['a far forage', 95, WALK_MS],
               ['a near hunt', 90, JOG_MS], ['a far hunt', 260, JOG_MS],
               ['a visit', 260, WALK_MS]];
const overSixty = trips.filter(([, d, pace]) => d / pace > 60);
check('under a flat sixty seconds, the long errands could not finish',
  overSixty.length >= 2, overSixty.map(([n, d, p]) => `${n} ${(d / p).toFixed(0)}s`).join(', '));
const allow = (d, pace) => Math.min(900, Math.max(20, (d / pace) * 2.2));
check('and the measured allowance covers every one of them',
  trips.every(([, d, pace]) => allow(d, pace) > d / pace * 1.5),
  trips.map(([n, d, p]) => `${n} ${allow(d, p).toFixed(0)}s for ${(d / p).toFixed(0)}s`).join(' · '));
check('with room for going round things', 2.2 > 1.5);

/* The timeout falls through to the arrival case, which is right for foraging —
   you pick what is around you wherever you stopped — and wrong for a visit. */
check('a visit only counts if they actually got there',
  /if \(Math\.hypot\(p\.x - host\.x, p\.z - host\.z\) < CAMP_CLEARING \* 1\.6\)/.test(html));
check('and the visit is cleared either way, so nobody arrives twice',
  /const host = p\.visiting;\n            p\.visiting = null;/.test(html));

/* -------------------------------------------------------------------------
   Where they actually are

   A figure can appear stuck on a hillside for two entirely different reasons:
   the simulation has stopped moving them, or it has not and the drawing has.
   Watching cannot tell those apart. These numbers can, because they are read
   off the person rather than off anything drawn — if they change while the
   figure does not, the fault is in the rendering.
   ------------------------------------------------------------------------- */
group('the person detail');

const caption = html.slice(html.indexOf('function updateFollowCaption()'),
  html.indexOf('\n}', html.indexOf('function updateFollowCaption()')));
check('the coordinates come off the person, not off a mesh',
  /p\.x\.toFixed\(1\)/.test(caption) && /p\.z\.toFixed\(1\)/.test(caption)
  && !/instanceMatrix|getMatrixAt/.test(caption));
check('altitude is sampled from the ground they are standing on',
  /const alt = sampleHeight\(p\.x, p\.z\)/.test(caption));
check('and it says how fast they are trying to go', /p\.speed\.toFixed\(2\)/.test(caption));

/* Speed is what they are attempting; distance is what happened. A person
   pressed against a hill has a speed and covers nothing, and that gap is the
   whole diagnosis — so both have to be shown, not one or the other. */
check('and how fast they are actually going, from their own coordinates',
  /Math\.hypot\(p\.x - p\.lastSeen\[0\], p\.z - p\.lastSeen\[1\]\) \/ gap/.test(caption));
check('which is remembered on the person, with the time it was taken',
  /p\.lastSeen = \[p\.x, p\.z, worldClock\]/.test(caption));
/* A distance with no time attached is not a speed. The first cut showed a
   whole journey's worth of movement accumulated since anybody last looked. */
check('a stale reading is refused rather than reported',
  /if \(gap > 0\.05 && gap < 20\)/.test(caption) && /let going = '—'/.test(caption));
check('and the two speeds are labelled so the gap between them reads',
  /want \$\{p\.speed\.toFixed\(2\)\}  going \$\{going\} m\/s/.test(caption));
check('and how far they still have to go',
  /const target = Math\.hypot\(p\.targetX - p\.x, p\.targetZ - p\.z\)/.test(caption));
check('the numbers are tabular, so they do not dance while you read them',
  /#following \.where \{[^}]*font-variant-numeric: tabular-nums/.test(html));

// A tenth of a unit of berries is still something in their arms.
check('a small haul is not rounded away to nothing',
  /p\.haul < 10 \? p\.haul\.toFixed\(1\) : p\.haul\.toFixed\(0\)/.test(caption));

/* -------------------------------------------------------------------------
   Starting again

   Taken out once, on the reasoning that a single request should not be able to
   remove everything there is — and then the reason for wanting it turned up: a
   page that will not behave, and no way to start again from inside it.

   So it is back, twice over: a button, and a command. The command is the one
   that matters, because the usual reason for wanting everything gone is that
   the page is the problem, and a button lives inside the page.
   ------------------------------------------------------------------------- */
group('emptying it');

const dbSrc = readFileSync(join(ROOT, 'db.js'), 'utf8');
const serverSrc = readFileSync(join(ROOT, 'server.js'), 'utf8');
const resetSrc = readFileSync(join(ROOT, 'reset.js'), 'utf8');

check('every table is emptied, not just some of them',
  (() => {
    const listed = (dbSrc.match(/const tables = \[([^\]]*)\]/) || [, ''])[1]
      .match(/'(\w+)'/g) || [];
    const created = [...dbSrc.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    return created.every((t) => listed.includes(`'${t}'`));
  })(),
  'a table added later and not listed here would survive being deleted');
check('in one transaction', /truncateAll\(\) \{[\s\S]{0,200}?db\.exec\('BEGIN'\)/.test(dbSrc));
check('and it says how much went, because empty and broken look alike',
  /return gone;/.test(dbSrc));
check('the counters go back too, so the next run is run 1',
  /DELETE FROM sqlite_sequence/.test(dbSrc));
/* The write-ahead log was four megabytes against eighty kilobytes of tables.
   Deleting rows does not touch it, so "emptied" would leave the biggest file
   on disk exactly as it was. */
check('and the write-ahead log is folded back in',
  /PRAGMA wal_checkpoint\(TRUNCATE\)/.test(dbSrc) && /VACUUM/.test(dbSrc));

check('there is an endpoint', /path === '\/api\/data' && req\.method === 'DELETE'/.test(serverSrc));
check('and it is still GET-only for reading', /if \(req\.method !== 'GET'\) return json\(res, 405/.test(serverSrc));

check('there is a command that does not need the page',
  /npm run reset/.test(resetSrc) && /truncateAll\(\)/.test(resetSrc));
/* Joining an absolute path to the project root turns /tmp/x.db into
   <root>/tmp/x.db, which does not exist — and the reply is a cheerful
   "nothing to empty". The same trap caught CHRONICLE_DB earlier. */
check('and it does not mangle an absolute path',
  /isAbsolute\(named\) \? named : join\(ROOT, named\)/.test(resetSrc));
check('it stops short of deleting the file a server is holding open',
  !/unlinkSync|rmSync/.test(resetSrc));

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
check('npm run reset exists', pkg.scripts.reset === 'node reset.js', JSON.stringify(pkg.scripts));

check('the button clears the browser\'s copies as well as the server\'s',
  ['WORLD_STORE', 'STATE_STORE', 'CHRONICLE_STORE'].every((k) =>
    new RegExp(`for \\(const key of \\[[^\\]]*${k}`).test(html)));
/* The runs table goes with everything else, so the id the page is holding
   points at nothing — anything written afterwards would be orphaned. */
check('and registers a new run, because the old id points at nothing',
  /setRunId\(null\);\n    await startRun\(\);/.test(html));
check('it asks twice', /arm\(\$\('wipeAll'\), 'Delete everything', wipeEverything, 5\)/.test(html));
check('and leaves a world behind, because there is always a world',
  /await newWorld\(\);\n  toast\('everything deleted'/.test(html));

/* -------------------------------------------------------------------------
   Things that are hidden have to actually hide

   `hidden` is an attribute the browser styles with `[hidden] { display: none }`
   from its own stylesheet — which any author rule with an id selector outranks.
   So an element given `#thing { display: grid }` and hidden with the attribute
   is not hidden at all: it sits on screen from the moment the page loads and
   nothing in the JavaScript can take it down.

   That is exactly what happened to the run-ahead overlay. It covered the whole
   game from load, permanently, and every fix aimed at the button that was
   supposed to close it was aimed at the wrong thing entirely.

   The boot check cannot catch this. Its DOM is a mock: `hidden` is a property
   it honours by fiat, and there is no CSS engine to disagree with it. So it is
   caught here, by reading the stylesheet.
   ------------------------------------------------------------------------- */
group('hiding');

const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

/* Every id the page hides — by markup attribute or by assigning to .hidden. */
const hides = new Set();
for (const m of html.matchAll(/<[^>]*\bid="([\w-]+)"[^>]*\shidden\b/g)) hides.add(m[1]);
for (const m of html.matchAll(/\$\('([\w-]+)'\)\.hidden\s*=/g)) hides.add(m[1]);
for (const m of html.matchAll(/getElementById\('([\w-]+)'\)\.hidden\s*=/g)) hides.add(m[1]);
check('the page hides things by attribute', hides.size >= 4, [...hides].join(' '));

/* Of those, the ones an author rule gives a display to — which is what beats
   the browser's own rule and needs the attribute spelled out again. */
const needsRule = [];
for (const id of hides) {
  const rule = css.match(new RegExp(`#${id}\\s*\\{([^}]*)\\}`));
  if (!rule || !/display:/.test(rule[1])) continue;
  const guarded = new RegExp(`#${id}\\[hidden\\]`).test(css);
  if (!guarded) needsRule.push(id);
}
check('everything the stylesheet gives a display to says so for [hidden] too',
  needsRule.length === 0,
  needsRule.length
    ? `${needsRule.join(', ')} — set to display and hidden with the attribute, so never hidden`
    : 'all guarded');

// And the one it happened to, by name, so the fix cannot quietly go again.
check('the run-ahead overlay in particular', /#ahead\[hidden\] \{ display: none; \}/.test(css));

/* -------------------------------------------------------------------------
   The whole chronicle

   The panel shows twelve lines, which is the right number for something you
   glance at while the world runs and the wrong number for anything else.
   ------------------------------------------------------------------------- */
group('the chronicle window');

check('there is a window onto all of it', /function openChronicle\(\)/.test(html)
  && html.includes('id="chron"'));
/* The rule the run-ahead overlay went without, which is why it covered the game
   from the moment the page loaded. */
check('and it can actually be hidden', /#chron\[hidden\] \{ display: none; \}/.test(html));
check('a button opens it', /\$\('chronOpen'\)\.addEventListener\('click', openChronicle\)/.test(html));
check('L opens and closes it', /if \(ev\.code === 'KeyL'\)/.test(html));
check('escape closes it', /closeChronicle\(\);/.test(html.slice(html.indexOf("ev.code === 'Escape'"),
  html.indexOf("ev.code === 'Escape'") + 120)));
check('and so does clicking the dark behind it',
  /if \(ev\.target === \$\('chron'\)\) closeChronicle\(\)/.test(html));

/* The panel's copy is capped at two hundred; the database is not. */
check('it asks the server for the lot', /fetch\('\/api\/chronicle\?limit=2000'\)/.test(html));
check('but shows what it already has first, so it is never empty while it waits',
  /chronRows = chronicle;[\s\S]{0,80}?renderChronPage\(\);[\s\S]{0,400}?if \(runId\)/.test(html));
check('and keeps the local copy if the server is not there',
  /catch \{ \/\* no server, or it went away/.test(html));

/* Search. Everything a line can be looked up by, because a name, a band code
   and a day number are all things somebody would type. */
const matchSrc = html.slice(html.indexOf('function chronMatch(e, needle)'),
  html.indexOf('function chronFiltered'));
for (const field of ['text', 'kind', 'world', 'day', 'hour']) {
  check(`search covers the ${field}`, matchSrc.includes(`e.${field}`), matchSrc.slice(0, 80));
}
check('and it is case-insensitive', /toLowerCase\(\)\.includes\(needle\)/.test(matchSrc));
check('a new search goes back to the newest',
  /setChronPage\(0\);\s+\/\/ a new search starts at the top of it/.test(html));

/* What somebody typed is put into the page, so it has to be escaped — and
   escaped BEFORE the marks go in, or a search for "<b" writes tags. */
const markSrc = html.slice(html.indexOf('function markHits(text, needle)'),
  html.indexOf('function renderChronPage'));
check('what was typed cannot become markup',
  /replace\(\/&\/g, '&amp;'\)/.test(markSrc) && /replace\(\/<\/g, '&lt;'\)/.test(markSrc));
check('and it is escaped before the marks are added, not after',
  markSrc.indexOf("'&lt;'") < markSrc.indexOf('<b class="hit">'));

/* Paging. */
check('there is a page size', /const CHRON_PAGE = \d+;/.test(html));
check('the page is a window into the list, not the whole of it',
  /rows\.slice\(from, from \+ CHRON_PAGE\)/.test(html));
check('and the ends stop rather than running off',
  /chronPage = clamp\(chronPage, 0, pages - 1\)/.test(html)
  && /\$\('chronPrev'\)\.disabled = chronPage === 0/.test(html)
  && /\$\('chronNext'\)\.disabled = chronPage >= pages - 1/.test(html));
check('it says where you are in it', /\$\('chronWhere'\)\.textContent/.test(html));

/* -------------------------------------------------------------------------
   Why a band is not there any more

   The chronicle says one thing at a time, which is the wrong shape for this
   question: eleven separate lines saying somebody died do not add up to "the
   sickness took them" in anybody's head. A band keeps its own tally, and when
   the last of them dies it says what of.
   ------------------------------------------------------------------------- */
group('the toll');

check('a band keeps its own tally of what happened to it',
  /toll: \{ age: 0, infancy: 0, hunger: 0, exhaustion: 0, sickness: 0, tiger: 0 \}/.test(html));
/* Every cause a death can have needs a place in the tally and a word for it, or
   a death goes into the count and comes out of the readout as "undefined". */
const causes = [...html.matchAll(/^\s*(\w+): \(p, age\) =>/gm)].map((m) => m[1]);
check('every cause of death is one it can count', causes.length >= 5
  && causes.every((c) => new RegExp(`\\b${c}: 0`).test(html)), causes.join(' '));
check('and every one has a word for the readout',
  causes.every((c) => new RegExp(`\\b${c}: '`).test(
    html.slice(html.indexOf('const TOLL_WORDS'), html.indexOf('const TOLL_WORDS') + 300))),
  causes.join(' '));
check('a death goes into it', /p\.camp\.toll\[cause\] = \(p\.camp\.toll\[cause\] \|\| 0\) \+ 1/.test(html));
check('and it is sorted worst first', /\.sort\(\(a, b\) => b\[1\] - a\[1\]\)/.test(html));
check('with the causes that never happened left out', /\.filter\(\(\[, n\]\) => n > 0\)/.test(html));

check('the panel says what has become of them', /class="toll"/.test(html)
  && /\$\{lost\} lost: /.test(html));
// And from the band's own tally, not from an empty list that renders nothing.
check('and reads it off the band', /const toll = tollOf\(c\);/.test(
  html.slice(html.indexOf('function renderTribes'), html.indexOf('function drawTribeChart'))));
/* Two on the line and all of them behind the hover: "eleven died" says nothing
   and "eleven died, seven of the sickness and three hungry" is the story. */
check('the leading two on the line, the rest on the hover',
  /toll\.slice\(0, 2\)/.test(html) && /title="\$\{toll\.map/.test(html));

group('extinction');

check('a band notices when the last of them dies',
  /if \(c\.pop === 0 && !c\.gone && \(c\.lost \|\| 0\) > 0\)/.test(html));
check('and says so once, not every frame after', /c\.gone = true;\n      obituary\(c\);/.test(html));
check('but can end again if somebody moves in and it fails a second time',
  /\} else if \(c\.pop > 0 && c\.gone\) \{\n      c\.gone = false;/.test(html));

const obit = html.slice(html.indexOf('function obituary(camp)'),
  html.indexOf('function killPerson'));
check('the obituary names what killed most of them', /toll\.slice\(0, 2\)/.test(obit));
check('and how long they lasted', /simDay - \(camp\.founded \|\| 0\)\) \/ P\.yearLength/.test(obit));
check('how many were ever born', /camp\.born/.test(obit));
check('and the most they ever were', /camp\.peak/.test(obit));
/* A band that never lost anybody and never existed is not an extinction. */
check('a band that never had anybody does not get an obituary',
  /\(c\.lost \|\| 0\) > 0/.test(html));
check('the peak is kept as it happens, not guessed afterwards',
  /if \(c\.pop > \(c\.peak \|\| 0\)\) c\.peak = c\.pop/.test(html));

check('all of it survives a reload',
  /toll: c\.toll, born: c\.born, peak: c\.peak, founded: r2\(c\.founded\)/.test(html)
  && /camps\[i\]\.toll\[key\] = Number\(c\.toll\?\.\[key\]\) \|\| 0/.test(html));
/* A save from before any of this has no founding day, and treating that as day
   zero brings a band back claiming to be a century old. */
check('and a save from before it does not come back a century old',
  /Number\.isFinite\(c\.founded\) \? c\.founded : simDay/.test(html));

/* -------------------------------------------------------------------------
   Descent

   `people` holds the living, and a death splices them out of it. So before
   this a genealogy was exactly one generation deep: a person remembered their
   parents' names, and the moment a parent died so did any way of finding out
   who THEIR father was. Nothing reached back to the founders.
   ------------------------------------------------------------------------- */
group('the line');

check('everyone who has ever lived is kept', /let lineage = \[\]/.test(html)
  && /function recordPerson\(p\)/.test(html));
check('a founder goes into it', /const person = newPerson\(camp, rng, age\);\n    recordPerson\(person\)/.test(html));
check('and so does a child', /recordPerson\(child\);\n    people\.push\(child\)/.test(html));
/* The point of the whole thing: a death is an entry in the record, not an
   erasure from it. */
check('a death is written down, not erased',
  /recordDeath\(p, cause\);\n  people\.splice\(i, 1\)/.test(html));
/* And written down with what killed them, or the record can say a band lost
   eleven people without being able to say what of — which is the one thing
   anybody looking at a dead band wants to know. */
check('and written down with what killed them',
  /rec\.x = cause \|\| 'age';/.test(html) && /function recordDeath\(p, cause\)/.test(html));
check('and whose they were when it happened',
  /rec\.dc = p\.camp \? p\.camp\.code : rec\.c;/.test(html));
check('somebody who walks to another band is recorded as having left',
  /function recordMove\(p, from, to\)/.test(html)
  && /recordMove\(p, parent, camp\);/.test(html)
  && /recordMove\(p, p\.camp, host\);/.test(html));
check('and the record survives a reload',
  /lineage,/.test(html) && /setLineage\(Array\.isArray\(st\.lineage\) \? st\.lineage : \[\]\)/.test(html));
check('the dead cannot have their ids handed out again',
  /st\.lineage\.map\(\(r\) => \(r\.i \| 0\) \+ 1\)/.test(html));

/* Descent through the father, carried rather than walked. */
check('a child takes its father\'s line', /child\.line = father\.line \|\| father\.name/.test(html));
check('and is one generation deeper', /child\.gen = \(father\.gen \|\| 1\) \+ 1/.test(html));
check('somebody with no father starts a line of their own',
  /p\.line = p\.name;/.test(html) && /line: '', gen: 1,/.test(html));
check('so a hundred generations costs what one does',
  !/while[^)]*\.father/.test(html.slice(html.indexOf('function updateFollowCaption'),
    html.indexOf('function updateFollowCaption') + 1400)));
check('and there is still a way to walk it when something wants to',
  /function ancestry\(p, limit = 12\)/.test(html));
check('which cannot loop for ever on a broken chain', /guard\+\+ < limit/.test(html));

const ordinal = new Function('n',
  html.slice(html.indexOf('  const tens = n % 100;'), html.indexOf('function who(p)')).replace(/\}\s*$/, ''));
check('the ordinals are right, including the elevenths',
  ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '101st', '111th']
    .every((want, i) => ordinal([1, 2, 3, 4, 11, 12, 13, 21, 101, 111][i]) === want),
  [1, 2, 3, 11, 12, 13, 21, 111].map(ordinal).join(' '));

/* A new band is a new line. Without this the record grew across every world
   ever loaded: nobody was wrongly linked to anybody, because ids are unique,
   but it filled with people from worlds that no longer exist. */
check('a new band starts a new genealogy',
  /setLineage\(\[\]\);\n\n  personParts = \{\};/.test(html));
check('and a restored save puts its own back over the top',
  html.indexOf('function buildPeople') < html.indexOf('function applySavedLife')
  || /lineage = Array\.isArray\(st\.lineage\)/.test(html));

check('somebody can be found in the record, living or long dead',
  /function lineOf\(id\)/.test(html));
/* Newest first: the only ids looked up are recent ones — a person's father, and
   his — and a linear scan from the front of a twenty-thousand-row record walks
   past every founder to find somebody born last spring. */
check('and the search starts from the newest',
  /for \(let i = lineage\.length - 1; i >= 0; i--\)/.test(html));
check('a death is looked up the same way', /const rec = lineOf\(p\.id\)/.test(html));
check('and so is an ancestor', /const rec = lineOf\(at\)/.test(html));

/* The whole reason for keeping the dead is being able to name them years after
   they are gone, so the caption shows the fathers rather than only a depth. */
check('the caption shows the fathers themselves',
  /const fathers = ancestry\(p, 4\)/.test(html)
  && html.includes("fathers.map((r) => " + String.fromCharCode(96) + "← "));
check('and says when there are more of them than it showed',
  /fathers\.length === 4 && fathers\[3\]\.f \? ' ←…' : ''/.test(html));

/* A visit to the next band is the better part of an hour there and back, and
   dusk sends everybody home from wherever they have got to. Somebody setting
   out at four in the afternoon is somebody who will be turned round halfway. */
check('nobody sets out for the next band without the day left to do it in',
  /const daylightLeft = \(DUSK_AT - P\.time\) \/ 24 \* P\.dayLength/.test(html)
  && /daylightLeft > enough/.test(html));
check('and the time needed is the round trip, with room to spare',
  /Math\.hypot\(host\.x - p\.camp\.x, host\.z - p\.camp\.z\) \* 2 \/ PERSON\.walk\) \* 1\.4/.test(html));

/* DUSK_AT is the come-home rule's moment written the other way round: that rule
   tests the sun's height, not the clock. So it is checked against the sun model
   rather than against itself — and it must not be LATE, because a few minutes
   early costs nothing and a few minutes late costs the whole errand. */
const DUSK_AT = Number(html.match(/const DUSK_AT = ([\d.]+);/)[1]);
const tiltDeg = Number(html.match(/SUN_TILT = THREE\.MathUtils\.degToRad\((\d+)\)/)[1]);
const tilt = tiltDeg * Math.PI / 180;
const smooth = (a2, b2, x) => { const t = Math.min(1, Math.max(0, (x - a2) / (b2 - a2))); return t * t * (3 - 2 * t); };
const elevation = (h) => {
  const ang = ((h - 6) / 12) * Math.PI, y0 = Math.sin(ang);
  const v = [Math.cos(ang), y0 * Math.cos(tilt), y0 * Math.sin(tilt)];
  return v[1] / Math.hypot(v[0], v[1], v[2]);
};
let realDusk = 24;
for (let h = 12; h < 24; h += 0.01) {
  if (smooth(-0.10, 0.14, elevation(h)) < 0.25) { realDusk = h; break; }
}
check('dusk is where the sun says it is', Math.abs(DUSK_AT - realDusk) < 0.5,
  `${DUSK_AT} against ${realDusk.toFixed(2)} from the sun`);
check('and never later than it', DUSK_AT <= realDusk,
  `${DUSK_AT} against ${realDusk.toFixed(2)}`);

group('foraging');

/* A forage trip used to be a random point 26-95m from camp, checked only for
   not being sea or cliff — and a forager reaches fruit within seven metres, so
   landing on any was luck. A band can starve beside a wood full of food. */
check('a forager looks before walking', /function pickForage\(p, camp, range\)/.test(html));
check('and gathering goes through it', /if \(p\.job === 'gather'\) return pickForage\(p, camp, range\)/.test(html));
check('trees in fruit are among the spots weighed up',
  /nearestFruit\(camp\.x, camp\.z, range\[1\]\)/.test(html)
  && /consider\(spot\.x, spot\.z, fruitWorth\)/.test(html));
/* Weighed in the same unit, which the first cut did not do: it preferred a
   tree six times in ten whatever the ground was, and a tree is worth about a
   tenth of a unit against half a unit for good ground. */
check('and everything is weighed in food, not in preference',
  /const value = \(FOOD\.gather \* forageRichness\(x, z\) \+ fruit\)/.test(html));
check('so a tree on poor ground loses to good ground',
  !/seesFruit/.test(html));
check('with distance counting against a far one', /farCost: [\d.]+,/.test(html));
check('and more than one spot considered', (() => {
  const n = Number((html.match(/tries: (\d+),/) || [, 0])[1]);
  return n >= 8;
})(), (html.match(/tries: (\d+),/) || [, '?'])[1]);

/* Both hunger deaths have to read as hunger. "Had nothing left" reads as
   somebody who worked themselves to death, and nothing here has ever died of
   walking: effort alone cannot reach zero, because a spent person drops to a
   walk and a walk pays for itself. */
// Comments stripped, or the note explaining the old wording reads as the old
// wording. `glsl` is the comment-free copy made further up.
check('the slow hunger death says it is hunger',
  /grew too weak with hunger/.test(html) && !/had nothing left/.test(glsl));
check('and the tally says so too', /exhaustion: 'weakness from hunger'/.test(html));

/* -------------------------------------------------------------------------
   What the run-ahead window shows

   A paragraph explaining that nothing is being drawn is a paragraph nobody
   reads twice. The years are the only thing happening, so the window shows them
   happening: the chronicle as it is written, and the population as it moves.
   ------------------------------------------------------------------------- */
group('watching the years pass');

check('the window has a chart and a log rather than an explanation',
  html.includes('id="aheadChart"') && html.includes('id="aheadLog"')
  && !/Nothing is drawn while this runs/.test(html));
check('the chart is the same one the panel uses, pointed elsewhere',
  /function drawTribeChart\(cv = \$\('tribeChart'\)\)/.test(html)
  && /drawTribeChart\(\$\('aheadChart'\)\)/.test(html));
check('and the log is the chronicle itself, not a copy of it',
  /chronicle\.slice\(0, 8\)\.map/.test(
    html.slice(html.indexOf('function showAheadProgress'), html.indexOf('function runAhead'))));
check('with the band codes coloured, as everywhere else',
  /codeChip\(e\.seed\)/.test(html.slice(html.indexOf('function showAheadProgress'),
    html.indexOf('function runAhead'))));

/* Redrawing every slice would spend the simulation budget on the readout, which
   is the one thing this window exists not to do. */
check('the redraw is throttled', /const AHEAD_DRAW_EVERY = (\d+);/.test(html));
const every = Number(html.match(/const AHEAD_DRAW_EVERY = (\d+);/)[1]);
const budget = Number(html.match(/const AHEAD_BUDGET = (\d+);/)[1]);
check('to far less often than a slice', every > budget * 4,
  `redraw every ${every}ms against a ${budget}ms slice`);
check('but always on the last one, so it ends on the truth',
  /now - \(ahead\.drawn \|\| 0\) > AHEAD_DRAW_EVERY \|\| ahead\.left <= 0/.test(html));

/* -------------------------------------------------------------------------
   Not dying out quite so easily

   Two loops were killing bands, and neither was bad luck.
   ------------------------------------------------------------------------- */
group('surviving');

/* One: hungry, so weak, so rest, so no food, so weaker. Measured before the
   change — a starving, weak band spent 58% of its time at the fire and 2% of it
   hunting, and resting could not help because the nourishment ceiling was down.
   There was nothing to recover on. */
const jobsAt = (h, r) => {
  const w = [
    ['gather', (0.10 + 0.62 * h) * (0.3 + 0.7 * r + 0.7 * h)],
    ['hunt', (0.05 + 0.37 * h) * Math.max(r * r, 0.25 * h)],
    ['craft', 0.30 * (1 - h)],
    ['tend', 0.06 + 0.22 * (1 - h) + 0.5 * (1 - r) * (1 - h)],
  ];
  const total = w.reduce((n, x) => n + x[1], 0);
  return Object.fromEntries(w.map(([k, v]) => [k, v / total]));
};
const desperate = jobsAt(1, 0.2);
check('a starving band looks for food instead of sitting down',
  desperate.gather > 0.7, `gather ${(desperate.gather * 100).toFixed(0)}%`);
check('and spends almost nothing at the fire',
  desperate.tend < 0.15, `tend ${(desperate.tend * 100).toFixed(0)}%`);
check('while a fed one still has time for everything else',
  jobsAt(0, 1).craft > 0.3, `craft ${(jobsAt(0, 1).craft * 100).toFixed(0)}%`);
check('foraging rises with hunger at every state of tiredness',
  [0, 0.3, 0.6, 1].every((r) => jobsAt(1, r).gather > jobsAt(0.2, r).gather));

/* Two: tigers. The threat list that makes a herd scatter was never read by a
   person, so a tiger walked up to somebody who never looked up — and over eight
   years that killed more of a band than hunger, sickness and age together. */
check('a person can see a tiger coming', /function nearestPredator\(x, z, within\)/.test(html));
check('and drops what they are doing', /p\.panic = PANIC\.runs;/.test(html)
  && /p\.state = 'return';/.test(html.slice(html.indexOf('p.panic = PANIC.runs'),
    html.indexOf('p.panic = PANIC.runs') + 200)));
check('running rather than walking', /if \(p\.panic > 0\) want = Math\.max\(want, PERSON\.jog/.test(html));
/* Somebody who stops the instant the tiger is out of sight stops in front of it. */
check('and keeping it up after losing sight of it', /runs: \d+,/.test(html)
  && /p\.panic = Math\.max\(0, \(p\.panic \|\| 0\) - slice\)/.test(html));
check('a tiger will not come to the fire',
  /if \(inCamp\(p\.x, p\.z, PANIC\.safe\)\) continue;/.test(html));
check('which makes foraging far out a risk taken, not a thing that happens',
  /sees: \d+,\s+\/\/ metres at which somebody notices a tiger/.test(html));

/* Which was still not enough, because the running went nowhere.

   The tiger sprints at 7.4 m/s, the fastest deer manages 6.8 and a person
   running for their life 3.6. There WAS a limit on a chase — the shared animal
   stamina — but it takes a tiger upwards of forty seconds to blow and it
   catches a person in twelve, so it had never once ended a chase after a
   person. Every chase that started, finished. Running home only decided where
   you died: eight years of it, twelve of sixteen deaths were tigers, and the
   island emptied. */
const tigerHunt = html.slice(html.indexOf("hunt: {"), html.indexOf("hunt: {") + 1400);
check('the tiger is faster than everything it hunts', (() => {
  const flee = [...html.matchAll(/fleeSpeed: ([\d.]+)/g)].map((m) => Number(m[1]));
  const jog = Number((html.match(/walk: [\d.]+, jog: ([\d.]+)/) || [, 0])[1]);
  return Math.max(...flee) === 7.4 && jog < 7.4;
})(), 'which is why the rush has to run out');
check('so its rush is a number of seconds', /chase: \d+,/.test(tigerHunt));
check('counted while it is closing', /d\.chase = \(d\.chase \|\| 0\) \+ dt;/.test(html));
check('and when it runs out it breaks off', (() => {
  const i = html.indexOf('if (d.chase > h.chase)');
  const body = html.slice(i, i + 700);
  return i > 0 && /d\.prey = null;/.test(body) && /d\.sulk = h\.sulks;/.test(body);
})());
check('then walks it off before hunting again', /sulks: \d+,/.test(tigerHunt)
  && /d\.sulk = Math\.max\(0, \(d\.sulk \|\| 0\) - dt\);/.test(html));
/* A rush left running across a kill expires mid-pounce on the next one. */
check('a kill resets the count', (() => {
  const i = html.indexOf('function takeQuarry');
  return i > 0 && /d\.prey = null;\s+d\.chase = 0;/.test(html.slice(i, i + 900));
})());
check('and so does every other way a chase can end',
  (html.match(/d\.chase = 0;/g) || []).length >= 6);

/* And the fire had to be real. Skipping people in camp when it PICKS a target
   is not the same rule as dropping one who reaches camp mid-chase — so a tiger
   already running followed them in and took them at the hearth, which made the
   one thing people do about tigers worth precisely nothing. */
check('reaching the fire ends a chase already under way', (() => {
  const i = html.indexOf('const gone = d.prey.kind === ');
  return i > 0 && /inCamp\(d\.prey\.person\.x, d\.prey\.person\.z, PANIC\.safe\)/
    .test(html.slice(i, i + 300));
})());
/* The one number that decides whether any of this works.

   A person who notices at `sees` metres and runs flat out is losing ground at
   the difference between the two speeds. If the rush lasts long enough to eat
   that head start, the tiger still catches everybody it picks and nothing above
   has changed anything — so the rush has to expire first, with something spare
   for the ground they lose turning round and getting up to speed. */
const rushGains = (() => {
  const chase = Number((tigerHunt.match(/chase: (\d+)/) || [, 0])[1]);
  const jog = Number((html.match(/walk: [\d.]+, jog: ([\d.]+)/) || [, 0])[1]);
  const tiger = Math.max(...[...html.matchAll(/fleeSpeed: ([\d.]+)/g)].map((m) => Number(m[1])));
  return { chase, jog, gains: chase * (tiger - jog) };
})();
const seesAt = Number((html.match(/sees: (\d+),\s+\/\/ metres at which/) || [, 0])[1]);
check('and a rush cannot eat the head start of somebody who notices in time',
  rushGains.gains < seesAt,
  `it closes ${rushGains.gains.toFixed(0)}m of a ${seesAt}m start`);
check('though it costs them a long way home',
  rushGains.gains > seesAt * 0.5,
  'a rush nobody need run from is not a predator');

/* -------------------------------------------------------------------------
   Who leaves when a band splits

   A band is not a number of people. It is people who can feed themselves and
   people who can have children, and a group missing either ends quietly —
   without starving, simply by running out of anybody to be next.

   The first version sorted by age and took the first of them, which took the
   CHILDREN: a new camp of one chief and a pile of infants, nobody fertile,
   nobody able to forage or hunt. And the parent, stripped of every child, had
   no next generation either. One line, and it doomed both camps.
   ------------------------------------------------------------------------- */
group('splitting a band');

const SPLIT = {};
const splitSrc = html.slice(html.indexOf('const SPLIT = {'), html.indexOf('}', html.indexOf('const SPLIT = {')));
for (const m of splitSrc.matchAll(/(\w+): ([\d.]+),/g)) SPLIT[m[1]] = Number(m[2]);
const LIFE = {
  fertileFrom: Number(html.match(/fertileFrom: (\d+)/)[1]),
  fertileTo: Number(html.match(/fertileTo: (\d+)/)[1]),
  adultAt: Number(html.match(/adultAt: (\d+)/)[1]),
};
check('the split constants are readable', Number.isFinite(SPLIT.pairs)
  && Number.isFinite(SPLIT.keepPairs), JSON.stringify(SPLIT));
check('it no longer just takes the youngest',
  !/pool\.slice\(0, Math\.max\(1, Math\.round\(pool\.length \* SPLIT\.takes\)\)\)/.test(html));
check('and a split that cannot be made viable leaves no trace',
  /if \(!pickLeavers\(parent, chief\)\) return false;/.test(html)
  && /if \(!going\) \{ camps\.pop\(\); return false; \}/.test(html));

/* The page's own selection, run against bands of every plausible shape. */
const pickLeavers = new Function('parent', 'chief', 'people', 'personAge', 'fertileNow', 'SPLIT',
  html.slice(html.indexOf('  const here = people.filter((p) => p.camp === parent'),
    html.indexOf('function splitCamp(parent)')).replace(/\}\s*$/, ''));
const fertileNow = (p) => !p.child && p.age >= LIFE.fertileFrom && p.age <= LIFE.fertileTo;
const personAge = (p) => p.age;

function band(women, men, kids, elders) {
  const out = [];
  let id = 0;
  for (let i = 0; i < women; i++) out.push({ id: id++, sex: 'f', age: 18 + i * 2, child: false });
  for (let i = 0; i < men; i++) out.push({ id: id++, sex: 'm', age: 19 + i * 2, child: false });
  for (let i = 0; i < kids; i++) out.push({ id: id++, sex: i % 2 ? 'f' : 'm', age: 2 + i, child: true });
  for (let i = 0; i < elders; i++) out.push({ id: id++, sex: i % 2 ? 'f' : 'm', age: 50 + i * 3, child: false });
  return out;
}

function trySplit(w, m, k, e) {
  const folk = band(w, m, k, e);
  const parent = { pop: folk.length };
  // The same object the selection compares against, not a stand-in for it.
  for (const q of folk) q.camp = parent;
  const chief = folk.find((p) => fertileNow(p));
  if (!chief) return { going: null };
  const going = pickLeavers(parent, chief, folk, personAge, fertileNow, SPLIT);
  if (!going) return { going: null };
  const stay = folk.filter((p) => !going.includes(p));
  const count = (list, sex) => list.filter((p) => fertileNow(p) && p.sex === sex).length;
  return {
    going,
    newW: count(going, 'f'), newM: count(going, 'm'),
    oldW: count(stay, 'f'), oldM: count(stay, 'm'),
    kids: going.filter((p) => p.child).length,
  };
}

/* The shapes a camp of seventeen or more actually comes in. */
const shapes = [[6, 6, 5, 2], [8, 5, 6, 1], [4, 9, 6, 2], [5, 5, 9, 1], [10, 8, 4, 3]];
const viable = shapes.map((sh) => trySplit(...sh)).filter((r) => r.going);
check('a band of that shape can split at all', viable.length === shapes.length,
  `${viable.length} of ${shapes.length}`);
check('the new band can have children',
  viable.every((r) => r.newW >= 1 && r.newM >= 1),
  viable.map((r) => `${r.newW}♀${r.newM}♂`).join(' '));
check('and so can the one they left',
  viable.every((r) => r.oldW >= 1 && r.oldM >= 1),
  viable.map((r) => `${r.oldW}♀${r.oldM}♂ stay`).join(' '));
check('the new band is not all children',
  viable.every((r) => r.kids < r.going.length), viable.map((r) => `${r.kids}/${r.going.length}`).join(' '));
check('it takes the young adults, not the elders',
  viable.every((r) => r.going.every((p) => p.child || p.age <= LIFE.fertileTo)));
/* Beyond the fertile core, the rest of the party is children — the parent keeps
   its working adults, and the children are the soonest to be of use anyway. */
check('and fills out the party with children, not more adults',
  viable.every((r) => {
    const core = r.newW + r.newM;
    return r.going.length === core || r.going.slice(core).every((p) => p.child);
  }),
  viable.map((r) => `${r.going.length} of whom ${r.kids} children`).join(' · '));

/* And it refuses rather than dooming anybody. */
const thin = trySplit(2, 2, 12, 0);
check('a band with only one pair to spare does not split at all',
  thin.going === null || (thin.oldW >= 1 && thin.oldM >= 1),
  thin.going ? `${thin.oldW}♀${thin.oldM}♂ left behind` : 'refused');
const noMen = trySplit(8, 1, 6, 2);
check('nor one that would strand either camp without men',
  noMen.going === null || (noMen.newM >= 1 && noMen.oldM >= 1),
  noMen.going ? `${noMen.newM} new, ${noMen.oldM} kept` : 'refused');

/* ---- report ---- */
console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
