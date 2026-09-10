#!/usr/bin/env node
/**
 * Checks the environment layer against the page it configures.
 *
 * The point of most of this is drift: config.js declares ranges that only mean
 * anything if they match the sliders in index.html, and .env.example is only
 * useful while it lists every variable that exists. Both are the kind of thing
 * that rots quietly, so they are asserted rather than remembered.
 */

import { readFileSync as rawRead, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA, SERVER_SCHEMA, parseEnvFile, resolveConfig, resolveServer } from './config.js';

/* Every check below reads source as text and matches it with regexes written
   with \n in them. Git is normally set to check out CRLF on Windows, and under
   that setting twenty-nine of them failed against a working tree that was
   correct — the files in the repository are LF, the ones on disk were not, and
   nothing was wrong with the code at all.

   Line endings are not what any check here is about, so they are taken out at
   the door: everything is read through this and arrives as LF. A checkout is
   then the same to the harness whatever core.autocrlf is set to, which it has
   to be, because the setting belongs to whoever cloned it and not to the
   project. */
const readFileSync = (path, enc) => {
  const text = rawRead(path, enc);
  return typeof text === 'string' ? text.split('\r\n').join('\n') : text;
};

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
check('a tribe code is two characters, taken from the band\'s own name',
  /code: takeTribeCode\(name\)/.test(html));
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
  html.includes('paceDay: null,') && html.includes('const PACE_MAX_STEP = 0.25;'));
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
/* One speed left, for the one view that moves the camera by hand. Fly and Walk
   are gone and CAMERA_WALK with them. */
check('there is one camera speed',
  /const CAMERA_FLY = \d+;/.test(html) && !/CAMERA_WALK/.test(html));

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
/* Hair is a style now, the library's, and still what tells them apart from a
   ridge away: a woman's is long three times in four, a man's never is. */
const looksSrc = moduleSource('looks.js');
check('a woman\'s hair is mostly long',
  /p\.sex === 'f'\s*\? \(r < 0\.75 \? 'long'/.test(looksSrc));
check('and a man\'s is one of the short ones',
  /: \['cropped', 'swept', 'bob', 'curls', 'bald'\]\[\(r \* 5\) \| 0\]/.test(looksSrc));
check('and nobody is bald as a child',
  /look\.hair === 'bald' && p\.child \? 'cropped'/.test(looksSrc));
check('it is theirs, drawn from their id, so a save brings it back unchanged',
  /if \(p\.look\) return p\.look;/.test(looksSrc) && /let seed = typeof p\.id === 'number'/.test(looksSrc));
check('it takes one of each to have a child',
  /if \(mothers < 1 \|\| fathers < 1\) continue;/.test(html));
check('and the mothers set the rate, not the head count',
  /chance = mothers \* 2 \* LIFE\.birthPerYear/.test(html));
/* A mother nurses before she can carry again. Without it FERTILITY=3 was a
   child every seven months per woman, and a world that ran on it starved
   1,008 people, 80% of them children. */
check('a mother nursing her last child is not counted as a mother',
  /if \(p\.sex === 'f'\) \{ if \(!nursing\(p\)\) mothers\+\+; \} else fathers\+\+;/.test(html)
  && /return p\.lastBirth != null && simDay - p\.lastBirth < LIFE\.birthGap \* P\.yearLength;/.test(html));
check('nor picked as one', /if \(sex === 'f' && nursing\(p\)\) continue;/.test(html));
check('and a birth starts her nursing', /mother\.lastBirth = simDay;/.test(html));
check('which a reload remembers',
  /lb: p\.lastBirth != null \? r2\(p\.lastBirth\) : undefined/.test(html)
  && /lastBirth: Number\.isFinite\(r\.lb\) \? r\.lb : undefined/.test(html));
check('two years or so, not a pause nobody would notice',
  Number((html.match(/birthGap: ([\d.]+),/) || [, 0])[1]) >= 1.5);
/* Children who go out bring back more the older they are. */
const childHaulAt = (k) => Number((html.match(new RegExp(`${k}: ([\\d.]+),`)) || [, NaN])[1]);
check('an older child brings home more than a younger one, and less than an adult',
  childHaulAt('childHaul') < childHaulAt('childGrown') && childHaulAt('childGrown') < 1,
  `${childHaulAt('childHaul')} to ${childHaulAt('childGrown')}`);
check('and every haul a child makes goes through it',
  (html.match(/childWorth\(p\)/g) || []).length >= 3 && !/p\.child \? FORAGE\.childHaul : 1/.test(html));
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

check('whoever leads is wearing it: an ochre hide and a band round the brow',
  /const leads = \(p\) => Boolean\(p\.camp && p\.camp\.chief === p\.id\);/.test(looksSrc)
  && /return leads\(p\) \? _col\.setHex\(CHIEF_CLOTH\)/.test(looksSrc)
  && /if \(group === 'band'\) return leads\(p\) \? 'band' : null;/.test(looksSrc)
  && /if \(group === 'band'\) return _col\.setHex\(CHIEF_BAND\);/.test(looksSrc));
/* Colours go on as things are put on, so a new chief is only in ochre once they
   are dressed again — which is why everybody is undressed on every change. */
check('and a new chief is dressed as one',
  /dressCamps\(\);\n  undressAll\(people\);/.test(html));
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
  && /buryPerson\(p\);[\s\S]{0,400}?p\.camp\.lost/.test(html));
/* Carried back to the band's own ground rather than left where they fell. A
   stone in the long grass eight hundred metres out is scenery, and forty of
   them scattered across an island are litter — one place you can walk to is
   somewhere, and how big it is says how long they have been here. */
check('and is carried back to their band\'s ground rather than left where they fell', (() => {
  const i = html.indexOf('function buryPerson');
  const fn = html.slice(i, i + 1400);
  return /const ground = p\.camp\?\.barrow;/.test(fn) && /y: sampleHeight\(x, z\)/.test(fn);
})());
/* None is ever taken away. They were capped at four hundred, oldest first —
   and the oldest are the bands that died out, so the one thing left of them
   was the first thing to go. The mesh is built again bigger instead. */
check('no grave is ever taken away', !/graves\.splice\(/.test(html) && !/graves\.slice\(-/.test(html));
check('the ground makes room instead',
  /if \(graves\.length > graveRoom\) \{/.test(html)
  && /while \(graveRoom < graves\.length\) graveRoom \*= 2;/.test(html));
check('they survive a reload, every one', /\n    graves,\n/.test(html)
  && /setGraves\(Array\.isArray\(st\.graves\) \? st\.graves : \[\]\);/.test(html));
/* Or the next world opens with the last one's dead scattered over ground they
   never walked on. */
check('and a new world starts with nobody buried in it',
  /setGraves\(\[\]\);\n  setGraveMesh\(null\);/.test(html));
check('every slot past the last cairn is parked out of sight',
  /for \(let i = n \* GRAVE_STONES; i < graveRoom \* GRAVE_STONES; i\+\+\) \{\n    graveMesh\.setMatrixAt\(i, HIDDEN\);/.test(html));
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

/* -------------------------------------------------------------------------
   Keeping a matrix that is actually yours

   `_m4` is one scratch Matrix4, declared in world.js and shared by everything
   that scatters instances. Anything that wants to *keep* a transform has to
   compose into it first and clone second; cloning first keeps whatever the last
   thing to touch it left behind. Two adjacent lines in the wrong order, and it
   parses perfectly — which is how the camps ended up storing the drying rack's
   crossbar as a tent and standing it on its side at the next birth.

   test-boot.js decomposes the stored matrices and catches this properly, but it
   skips politely when three.js is not on disk, which on a fresh clone is always.
   This is the version that always runs. */
group('what a camp keeps');

const composeFirst = (src, keptInto) => {
  const lines = src.split('\n');
  const bad = [];
  lines.forEach((line, i) => {
    const kept = new RegExp(`${keptInto}[^=]*=\\s*_m4\\.clone\\(\\)\\s*;`).test(line);
    if (!kept) return;
    // Composed on some earlier line, and not merely on a later one.
    const before = lines.slice(Math.max(0, i - 4), i).join('\n');
    if (!/_m4\.compose\(/.test(before)) bad.push(`line ${i + 1}: ${line.trim().slice(0, 52)}`);
  });
  return bad;
};
const peopleSrc = rawSources[srcFiles.indexOf('people.js')] || '';
check('a hut keeps the matrix that was composed for it',
  composeFirst(peopleSrc, 'hutAt').length === 0,
  composeFirst(peopleSrc, 'hutAt').join(' · '));
check('and so does every pole of the drying rack',
  composeFirst(peopleSrc, 'rackAt').length === 0,
  composeFirst(peopleSrc, 'rackAt').join(' · '));
/* Nothing else in the file keeps one, but if something starts to, it has the
   same trap waiting for it. */
check('and nothing else clones the scratch matrix before filling it', (() => {
  const lines = peopleSrc.split('\n');
  const bad = [];
  lines.forEach((line, i) => {
    if (!/=\s*_m4\.clone\(\)\s*;/.test(line)) return;
    const before = lines.slice(Math.max(0, i - 4), i).join('\n');
    if (!/_m4\.compose\(/.test(before)) bad.push(`line ${i + 1}`);
  });
  return bad.length ? bad.join(', ') : true;
})() === true);

check('an errand either takes you out or it does not',
  /const OUTDOOR_JOBS = new Set\(\['gather', 'hunt', 'visit', 'play', 'tend', 'led', 'mourn', 'quarry', 'raid', 'fish', 'wood'\]\);/.test(html));
/* Standing at the stones happens outdoors, and it is the one job that has
   nowhere indoors to be mistaken for. */
check('and going to the stones or the rocks takes you out too',
  /'led', 'mourn', 'quarry', 'raid', 'fish', 'wood'\]\);/.test(html));
/* The one job whose name says where it happens. It was on the indoor side, so
   somebody "at the fire" was hidden inside a tent — the caption said one thing
   and the camp showed another — and with a full store it is better than a third
   of a band, which is most of the people who were never drawn. */
check('and sitting at the fire is not one of them',
  /'play', 'tend', 'led', 'mourn', 'quarry', 'raid', 'fish', 'wood'\]\);/.test(html));
/* Nor is somebody you are walking about by hand, or they wink out the moment
   you lead them into their own camp. */
check('and neither is somebody you are leading',
  /'tend', 'led', 'mourn', 'quarry', 'raid', 'fish', 'wood'\]\);/.test(html));
/* Between the stones and the tents: the huts stand 6.5m out and are about two
   metres across, so their inner edge is near 4.1m, and the fire ring is 1.15m. */
check('somebody at the fire sits between the stones and the tents', (() => {
  const m = html.match(/FIRESIDE = \[([\d.]+), ([\d.]+)\]/);
  if (!m) return 'no FIRESIDE';
  const [, lo, hi] = m.map(Number);
  const hutRing = Number((html.match(/const r = 6\.5 \+ rng\(\) \* ([\d.]+);/) || [, 2.6])[1]);
  return lo > 1.15 && hi < 6.5 - 2.4
    ? true
    : `fireside ${lo}-${hi}m against a hut ring from 6.5m (spread ${hutRing})`;
})() === true);
check('and it is a range of its own, not the one knapping uses',
  /: p\.job === 'tend' \? FIRESIDE : \[2, 9\];/.test(html));
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
/* -------------------------------------------------------------------------
   Saying where somebody is, not just what their hands are doing

   A job says what somebody is busy with. It does not say whether you can see
   them, and the two came apart the moment anything was hidden: the card read
   "at the fire" off a person inside a tent. So the words key off `p.hidden` —
   the flag the draw loop sets — and never off the job alone. Same rule as the
   click-picker: one answer to "is this person visible", written once.
   ------------------------------------------------------------------------- */
check('what somebody is doing is read off whether they are drawn',
  /export function doingWords\(p\)/.test(html.replace(/^export /gm, 'export '))
  || /function doingWords\(p\)/.test(html));
check('and it asks the draw loop, not the job list',
  /if \(p\.hidden\) return INDOOR_WORDS\[p\.job\] \|\| 'resting';/.test(html));
check('somebody under a roof is resting, not at the fire',
  /tend: 'resting',/.test(html) && /INDOOR_WORDS = \{/.test(html));
check('and asleep still says asleep',
  /if \(p\.asleep\) return 'asleep in a hut';/.test(html));
/* Both places a person's doing is shown, or one of them keeps the old lie. */
check('the follow caption uses it', /const doing = doingWords\(p\);/.test(html));
check('and so does the band card', /\$\{p\.sick \? 'ill' : doingWords\(p\)\}/.test(html));

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
/* -------------------------------------------------------------------------
   ...on both paths, which is the point

   `turnStart` is `worldStep % stride`, so if the step does not move, the same
   slice of the band is walked every frame and nobody else is walked at all.
   It was ticked only in stepWorld — the unwatched fast-forward — so while
   somebody was actually looking, worldStep was frozen.

   Everyone outside that one slice was not merely undrawn: they were never
   stepped. No job, no movement, no ageing, and a build-time zero matrix that
   nothing ever overwrote. It hid while a band was small, because lodStride
   returns 1 below LOD.from and every index gets visited regardless, and it
   arrived the moment a world grew past two dozen — as most of a crowd standing
   perfectly still and never being drawn.

   Measured on a fresh world of 121 people: 95 who should have been on screen,
   24 with a matrix. After: 88 of 88.

   This is the same shape as the books below it, which is why it sits here: two
   paths through the world, and anything either of them owes has to be paid by
   both. `bookDue += simDays` appears twice for exactly that reason.
   ------------------------------------------------------------------------- */
check('on both paths, watched and not',
  (html.match(/tickWorldStep\(\);/g) || []).length === 2,
  `${(html.match(/tickWorldStep\(\);/g) || []).length} call sites`);
check('the unwatched one steps it', (() => {
  const body = bodyOf('stepWorld');
  return body && /tickWorldStep\(\);/.test(body) ? true : 'stepWorld does not';
})() === true);
check('and so does the watched one', (() => {
  const body = bodyOf('tick');
  return body && /tickWorldStep\(\);/.test(body) ? true : 'tick does not';
})() === true);
/* And it has to happen before anything reads whose turn it is, or the frame
   that ticks it walks the slice belonging to the frame before. */
check('before anybody takes their turn', (() => {
  const body = bodyOf('tick');
  if (!body) return 'no tick';
  const tickAt = body.indexOf('tickWorldStep();');
  const useAt = body.indexOf('updatePeople(');
  return tickAt >= 0 && useAt > tickAt ? true : 'the turn is read before it moves';
})() === true);
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
  /if \(nearest < GROUND\.apart\) continue;/.test(html));

/* -------------------------------------------------------------------------
   Two kinds of distance, and only one of them is about the island

   Every distance here was a number of metres tuned on a 1600 m island. On a
   4800 m one they all still meant 1600 m: six bands sited inside a 410 m circle
   in the middle of an island nine times the size, fighting over the same
   ground. Sixty people down to nine, and not one founder alive at the end. So
   they were all multiplied by MAP_SCALE — and that overshot, because it scaled
   two different things that are not the same thing.

   Where a camp may be *placed* is about the island: on a bigger one the sites
   have to be spread further out, or you get the huddle above. How far two fires
   have to be *apart* is about camps — 260 metres is 260 metres whatever the
   island measures. Scaling both cancels: a disc 2.5× wider than the spacing
   holds the same handful of camps however you multiply the pair, so a 6400 m
   island held exactly as many bands as a 1600 m one and merely spread them
   thinner. Asking for forty camps got seven on every map in the game.

   GROUND.range, the ground a band treats as its own, was already in plain
   metres and sits three lines above GROUND.apart, which was not.
   ------------------------------------------------------------------------- */
check('where a camp may be placed scales with the island', (() => {
  const code = blankNoise(sources.join('\n'));
  const radii = (code.match(/Math\.sqrt\(rng\(\)\) \* \d+\) \* MAP_SCALE/g) || []).length;
  return radii >= 3 ? true : `${radii} of the three placement radii scale`;
})() === true);
check('but how far apart two fires must be does not', (() => {
  const code = blankNoise(sources.join('\n'));
  const scaled = code.match(/(?:CAMPS_APART|GROUND\.apart|SPLIT\.minAway)\s*\*\s*MAP_SCALE/g);
  return scaled ? scaled.join(', ') : true;
})() === true);
/* Which is the whole point: a bigger island is more bands, not the same bands
   further apart. The three spacings are plain metres and stay comparable to
   GROUND.range, which is the ground one band works. */
check('and the spacings are still real distances', (() => {
  const apart = Number((html.match(/CAMPS_APART = (\d+);/) || [, 0])[1]);
  const away = Number((html.match(/minAway: (\d+),/) || [, 0])[1]);
  const room = Number((html.match(/apart: (\d+),/) || [, 0])[1]);
  const range = Number((html.match(/range: (\d+),/) || [, 0])[1]);
  return apart > range && away > range && room > range
    ? true
    : `apart ${apart}, minAway ${away}, room ${room} vs a band's own ground ${range}`;
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
  && /for \(const p of \[\.\.\.f\.adults, \.\.\.f\.kids\]\) \{ p\.hut = hut; p\.hearth = fire; \}/.test(html));
/* And at the fire that tent stands round. Without it a village was five hearths
   and one crowd: everything meaning "go home" aimed at camp.x, which is hearth
   nought, so sixty people walked past four burning fires to stand at the
   first. */
check('and at the fire it stands round',
  /const fire = camp\.fireAt\?\.\[Math\.floor\(at \/ HUTS_PER_HEARTH\)\];/.test(html));
check('and that happens whenever the band changes', (() => {
  const i = html.indexOf('function dressCamp');
  return i > 0 && /assignHuts\(camp\);/.test(html.slice(i, i + 900));
})());
/* Laying the camp out again would shuffle it around them, because the layout
   comes off the camp's own rng and that rng moves on every call. */
check('without laying the camp out again', /camp\.hutAt\[i\] = _m4\.clone\(\);/.test(html)
  && /mesh\.setMatrixAt\(slot, key === style && i < want && camp\.hutAt\?\.\[i\] \? camp\.hutAt\[i\] : HIDDEN\)/.test(html));
check('the drying rack only stands once they know what it is for',
  /RACK_KNOWN = [\d.]+;/.test(html)
  && /const knows = \(camp\.skill\?\.drying \|\| 0\) >= RACK_KNOWN;/.test(html));
check('and it goes up the moment they learn',
  /if \(key === 'drying'\) dressCamp\(camp\);/.test(html));
check('the camps are dressed whenever the band changes',
  /dressCamps\(\);/.test(html) && /function dressCamps\(\)/.test(html));

/* The store, kept somewhere you can see it. Run as well as read: the slack is
   the part that is easy to get backwards, and backwards it raises a granary
   every morning and takes it down every night. */
const storesFor = (() => {
  const at = html.indexOf('function storesFor(');
  if (at < 0) return null;
  const src = html.slice(at, html.indexOf('\n}\n', at) + 2);
  const num = (re) => Number(html.match(re)?.[1]);
  const days = JSON.parse(html.match(/const STORE_DAYS = (\[[^\]]*\]);/)?.[1] || 'null');
  return new Function('STORES', 'STORE_DAYS', 'STORE_SLACK', `${src}; return storesFor;`)(
    num(/const STORES = (\d+);/), days, num(/const STORE_SLACK = ([\d.]+);/));
})();
check('a band keeps its food somewhere', typeof storesFor === 'function');
if (storesFor) {
  const band = (up, pop = 5) => ({ storesUp: up, pop });
  check('none while the store is empty',
    storesFor(band(0), 0) === 0 && storesFor(band(2), 0) === 0);
  check('one for a band getting by', storesFor(band(0), 3) === 1, String(storesFor(band(0), 3)));
  check('four for a band with a month put by', storesFor(band(0), 40) === 4,
    String(storesFor(band(0), 40)));
  check('and none for a band nobody is left in', storesFor(band(3, 0), 40) === 0);
  /* Back and forth across the week line. With the slack it goes up once and
     comes down once; without it, this same walk changes four times. */
  let up = 1, changes = 0;
  for (const d of [5.5, 6.5, 5.9, 6.8, 6.2, 7.5, 6.5, 5.8]) {
    const n = storesFor(band(up), d);
    if (n !== up) changes++;
    up = n;
  }
  check('and a band hovering on a line does not flicker', changes === 2, `${changes} changes`);
}
check('the granaries follow the store, and only when the count changes',
  /const stores = storesFor\(c, daysOfFood\(c\)\);\s*if \(stores !== c\.storesUp\) \{ c\.storesUp = stores; dressStores\(c\); \}/.test(html));
check('each has a mesh behind it',
  /campParts\.stores = instancedFrom\(/.test(html) && /campParts\.storeRoofs = instancedFrom\(/.test(html)
  && /stores: STORES,\s*storeRoofs: STORES,/.test(html));
/* The camp's rng lays out every tent and stone after this, so a draw taken
   here would move all of them. */
check('laid out without touching the camp\'s dice', (() => {
  const a = html.indexOf('camp.storeAt = [];'), b = html.indexOf('camp.fireAt = [];', a);
  if (a < 0 || b < 0) return 'no store layout';
  return /\brng\(\)/.test(html.slice(a, b)) ? 'draws from rng' : true;
})() === true);
check('and composed before it is kept',
  /camp\.storeAt\.push\(_m4\.compose\(_v, _q, _s\)\.clone\(\)\);/.test(html));
/* A camp is sited for dry flat ground at its middle and nothing more, so
   thirteen metres out can be sea. A granary there is one nobody reaches: they
   stand at the water until the errand times out and the food never goes in. */
check('a granary never stands in the water, or where they stand to fill it',
  /sampleHeight\(x, z\) < SEA \+ 1\.5 \|\| sampleHeight\(fx, fz\) < SEA \+ 1\.5/.test(bodyOf('storeGround') || ''));
check('nor on a hillside', /flatnessAt\(x, z\) < STORE_FLAT/.test(bodyOf('storeGround') || ''));
check('nor in a tent, round any fire the village could light',
  /for \(let f = 0; f < HEARTHS; f\+\+\)[\s\S]*?< TENT_REACH \+ roof\) return false;/.test(bodyOf('storeGround') || ''));
/* Two numbers written down twice, once where the thing is built and once where
   it is kept clear of. Checked against each other so moving one moves both. */
check('and the reach it keeps clear of is the tents as built', (() => {
  const n = (re) => Number(html.match(re)?.[1]);
  const built = 6.5 + n(/const r = 6\.5 \+ rng\(\) \* ([\d.]+);/)
    + n(/new THREE\.ConeGeometry\(([\d.]+), 2\.5, 7\)/) * (0.85 + n(/const sc = 0\.85 \+ rng\(\) \* ([\d.]+);/));
  const said = new Function(`return ${html.match(/const TENT_REACH = ([^;]+);/)?.[1]};`)();
  return Math.abs(built - said) < 1e-9 ? true : `TENT_REACH ${said} but tents reach ${built}`;
})() === true);
check('and the thatch it measures is the thatch as built',
  Number(html.match(/const STORE_ROOF = ([\d.]+);/)?.[1])
  === Number(html.match(/new THREE\.ConeGeometry\(([\d.]+), 1\.05, 8\)/)?.[1]));
check('and none of that rolls the camp\'s dice',
  !/\brng\(\)/.test(bodyOf('storeCandidates') || 'rng()') && !/\brng\(\)/.test(bodyOf('storeGround') || 'rng()'));
if (storesFor) {
  check('and only as many go up as there was ground for',
    storesFor({ storesUp: 0, pop: 5, storeAt: [1, 2] }, 40) === 2
    && storesFor({ storesUp: 0, pop: 5, storeAt: [] }, 40) === 0);
}
check('a spot for every granary', (() => {
  const spots = html.match(/const STORE_SPOTS = \[(.*)\];/)?.[1] || '';
  const n = (spots.match(/\[/g) || []).length;
  return n === Number(html.match(/const STORES = (\d+);/)?.[1]) ? true : `${n} spots`;
})() === true);
/* Clear of every tent that could ever stand: the biggest tent at the far edge
   of its ring, round every fire a village can light. Read off the numbers the
   camp is actually laid out with, so moving a tent ring moves this. */
check('and none of them stands in a tent', (() => {
  const n = (re) => Number(html.match(re)?.[1]);
  const ringOut = n(/const r = 6\.5 \+ rng\(\) \* ([\d.]+);/) + 6.5;
  const tent = n(/new THREE\.ConeGeometry\(([\d.]+), 2\.5, 7\)/)
    * (0.85 + n(/const sc = 0\.85 \+ rng\(\) \* ([\d.]+);/));
  const roof = n(/new THREE\.ConeGeometry\(([\d.]+), 1\.05, 8\)/) * n(/STORE_SCALE = ([\d.]+);/);
  const out = n(/STORE_OUT = ([\d.]+);/), apart = n(/HEARTH_SPACING = ([\d.]+);/), fires = n(/HEARTHS = (\d+);/);
  const spots = JSON.parse(html.match(/const STORE_SPOTS = (\[.*\]);/)[1]);
  const hearths = [[0, 0]];
  for (let f = 1; f < fires; f++) {
    hearths.push([Math.cos((f / fires) * Math.PI * 2) * apart, Math.sin((f / fires) * Math.PI * 2) * apart]);
  }
  let worst = Infinity;
  for (const [o, a] of spots) {
    for (const [hx, hz] of hearths) {
      worst = Math.min(worst, Math.hypot(out + o - hx, a - hz) - ringOut - tent - roof);
    }
  }
  for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
    worst = Math.min(worst, Math.hypot(spots[i][0] - spots[j][0], spots[i][1] - spots[j][1]) - 2 * roof);
  }
  return worst > 0 ? true : `overlap by ${(-worst).toFixed(2)}m`;
})() === true);

group('nursing');

check('somebody can sit with the ill', /\['nurse', ill > 0 && !p\.child/.test(html)
  && /nurse: 'sitting with the ill'/.test(html));
check('and it shortens the illness',
  /p\.sick -= days \* \(p\.tended \? 1 \+ PLAGUE\.nurse : 1\)( \* restHeal\(p\))?;/.test(html));
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
  && /95 \* far \* groundFor\(camp\)\]/.test(html));
check('and a bigger band walks further, as far as the ground it needs',
  /return clamp\(Math\.sqrt\(\(camp\.pop \|\| 1\) \/ FORAGE\.ringFeeds\), 1, FORAGE\.ringMax\);/.test(html));
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
/* Once per update rather than once per birth — a warren can put back a dozen
   in one call now — but never an update that brought any back and did not. */
check('and one growing back recounts them',
  /born\.fed = [^;]+;\n      changed = true;[\s\S]{0,40}?if \(changed\) recountAnimals\(\);/.test(html));
/* The point is that the readout is refreshed on its own timer rather than only
   when something happens to somebody. It was pinned as two adjacent lines,
   which made it a check about where a line sits — one statement between them
   and it failed on code that does exactly what it says. */
check('the readout redraws on its own, not only when somebody dies',
  /updateHud\(\);[\s\S]{0,220}?\$\('fps'\)/.test(html));

/* -------------------------------------------------------------------------
   The two numbers that outlive the panel

   H hides the world panel, and the frame rate and the head count were both in
   it — which are the two numbers you actually want while looking at something
   else. They are beside the clock as well now, written in the same half-second
   the frame rate is measured over.
   ------------------------------------------------------------------------- */
check('the frame rate is beside the clock too',
  /const hf = \$\('hudFps'\);/.test(html) && html.includes('id="hudFps"'));
check('and so is the head count',
  /hp\.textContent = people\.length;/.test(html) && html.includes('id="hudPop"'));
check('and they sit in the hud, which H does not hide', (() => {
  const hud = html.slice(html.indexOf('<div id="hud">'), html.indexOf('<div id="hud">') + 400);
  return /id="hudFps"/.test(hud) && /id="hudPop"/.test(hud)
    ? true : 'they are not inside #hud';
})() === true);
check('fruit is on the readout', html.includes('${stats.fruit} fruit'));

group('the orchard');

/* Read out of the ORCHARD block, not out of the whole file. This searched every
   source for `takes:` and `worth:` and took the first of each — which for most
   of this project's life meant `SPLIT.takes` (0.42) against `ORCHARD.worth`
   (0.02). The product of two unrelated constants happened to be small, so the
   check passed, and it was testing nothing. It failed the day a `worth: 4`
   appeared anywhere above it in the file. */
const ORCHARD_SRC = (html.match(/ORCHARD = \{([\s\S]*?)\n\};/) || [, ''])[1];
const ORCHARD = {};
for (const k of ['reach', 'takes', 'worth', 'regrow']) {
  const m = ORCHARD_SRC.match(new RegExp(`^\\s*${k}: ([\\d.]+),`, 'm'));
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
  && /_col\.setHex\(p\.garment\)/.test(looksSrc)
  && /_col\.setHex\(p\.hairColor \?\? 0x2b1d14\)/.test(looksSrc));

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
  ['a person being killed', /function killPerson[\s\S]{0,900}?paintPeople\(\);/],
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
/* The whole of tick(), not the first 3000 characters of it. A fixed slice put
   the last line it looks for near the edge, so a comment added inside the
   function was enough to drop the simDays line off the end and fail a check
   about code that had not changed. bodyOf runs to the next top-level declaration. */
const tickBody = bodyOf('tick');
check('the rate is applied once, to dt', /const dt = ranNight \? 0 : real \* rate;/.test(tickBody));
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
check('nothing is skipped in daylight', /sunDir\.y > P\.nightFrom\) return false;/.test(html));
check('deep night runs whatever anyone is doing',
  /if \(sunDir\.y < deepNight\(\)\) return true;/.test(html));

/* -------------------------------------------------------------------------
   Both ends of the night window are settings

   How much of the night you want to sit through is taste rather than physics.
   In sun height, not hours, because everything that asks whether it is night
   asks the sun and the window should be set in the units it is measured in.
   ------------------------------------------------------------------------- */
check('where the window opens is a setting',
  /nightFrom: -0\.02,/.test(html)
  && /NIGHT_FROM: \{ path: 'nightFrom'/.test(readFileSync(join(ROOT, 'config.js'), 'utf8')));
check('and where it stops waiting for stragglers',
  /nightDeep: -0\.25,/.test(html)
  && /NIGHT_DEEP: \{ path: 'nightDeep'/.test(readFileSync(join(ROOT, 'config.js'), 'utf8')));
/* Set the two the wrong way round and the deep test would fire before the night
   had started — running the world on through a sunset with everybody still out
   in it. Clamped rather than validated, because a rule nobody reads is not a
   rule. */
check('and the far end is never above the near one',
  /export function deepNight\(\) \{ return Math\.min\(P\.nightDeep, P\.nightFrom\); \}/.test(
    rawSources[srcFiles.indexOf('clock.js')] || ''));
check('the defaults are the numbers that were hard-coded', (() => {
  const from = Number((html.match(/nightFrom: (-?[\d.]+),/) || [, NaN])[1]);
  const deep = Number((html.match(/nightDeep: (-?[\d.]+),/) || [, NaN])[1]);
  return from === -0.02 && deep === -0.25
    ? true : `from ${from}, deep ${deep}`;
})() === true);
check('before that, anybody still out keeps the clock honest',
  /if \(p\.asleep\) continue;/.test(html)
  && /Math\.hypot\(p\.x - p\.camp\.x, p\.z - p\.camp\.z\) > CAMP_CLEARING\) return false;/.test(html));
check('an empty world does not wait for nobody', /if \(!people\.length\) return true;/.test(html));
/* -------------------------------------------------------------------------
   The night is run, not stretched

   It used to be one enormous frame: clockRate multiplied dt by nightSkipRate
   and everything carried on as normal. That holds to about 15x and then comes
   apart, because `paced` is clamped by PACE_MAX_STEP and dt is not — past there
   the books (eating, ageing, births, deaths, the store spoiling) run at the
   full rate while movement and sleep run at the clamped one. At 60x a band took
   a whole night's hunger and got a quarter of a night's rest; at 600x, a
   fortieth. Which is why the rate was capped at 60 and a night still took half
   a minute: it could not be raised without the clock leaving the sleeping
   behind.

   So the night goes through stepWorld instead, which does the deciding and
   skips the drawing, as many times as fit in a slice of the frame. ffStep() is
   FF_STEP / pace(), so dt * pace() is exactly FF_STEP and the clamp inside
   stepWorld never bites — the clock and the sleeping cannot come apart however
   fast it runs.
   ------------------------------------------------------------------------- */
check('the clock rate is what you asked for and nothing else',
  /return RATES\[rateIndex\];/.test(html)
  && !/RATES\[rateIndex\] \* \(skipping/.test(html));
check('and the night is run in world-steps',
  /while \(nightIdle\(\) && Date\.now\(\) < until\) \{ stepWorld\(step\); ranNight = true; \}/.test(html));
check('at the step size that keeps movement tied to the clock',
  /const step = ffStep\(\);/.test(tickBody)
  && /return FF_STEP \/ Math\.max\(pace\(\), 0\.001\);/.test(html));
/* Bounded, or one slow frame becomes a hung tab. */
check('inside a budget, so a frame still ends',
  /const until = Date\.now\(\) \+ NIGHT_BUDGET \* \(P\.nightSkipRate \/ NIGHT_SKIP_BASE\);/.test(html));
/* And the world must not be moved twice in the same frame. */
check('and the frame does not move the world again after running it',
  /const dt = ranNight \? 0 : real \* rate;/.test(html));
/* `skipping` is written by clockRate. Reading it before calling clockRate gets
   last frame's answer — and at the end of the night a stale true takes the
   branch that skips the call, so it would never clear itself and the world
   would stop. It has to be asked first. */
check('the flag is asked for before it is read', (() => {
  const body = bodyOf('tick');
  if (!body) return 'no tick';
  const asked = body.indexOf('const rate = clockRate();');
  const read = body.indexOf('if (skipping) {');
  return asked >= 0 && read > asked ? true : 'skipping is read before clockRate sets it';
})() === true);
/* The setting keeps its sense — bigger is a quicker night — it is a share of
   the frame now rather than a multiplier on the clock. */
check('NIGHT_SKIP_RATE still means a quicker night',
  /const NIGHT_SKIP_BASE = 6;/.test(html) && /const NIGHT_BUDGET = 10;/.test(html));
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
  /\} else if \(P\.view !== 'follow'\) setViewMode\('follow'\);\s*else pickFollow\(\);/.test(html));

/* F picks at random, so the person you were watching goes when you press it —
   and you cannot ask for them back by name, because you never chose them. The
   trail is what makes that keypress undoable. */
check('shift+F goes back to the one before',
  /if \(ev\.shiftKey\) \{\s*if \(P\.view !== 'follow'\) setViewMode\('follow'\);\s*if \(!followBack\(\)\)/.test(html));
check('and it is kept by id, not by index',
  /followTrail\.push\(p\.id\)/.test(html) && /people\.findIndex\(\(q\) => q\.id === id\)/.test(html));
/* Indices shift when somebody dies, so a trail of them walks you back to
   whoever inherited the slot. An id that is gone is simply skipped. */
check('somebody who died while you were away is skipped',
  /if \(idx < 0\) continue;/.test(html));
/* Going back to A must not put B on the trail, or shift+F twice returns you to
   where you started — two people passing each other rather than a way back. */
check('stepping back does not put the one you left on the trail',
  /followPerson\(idx, true, false\)/.test(html)
  && /function followPerson\(idx, announce = true, remember = true\)/.test(html)
  && /if \(remember\) rememberFollowed\(\)/.test(html));
check('and the same person is not on the trail twice',
  /const at = followTrail\.indexOf\(p\.id\);\s*if \(at >= 0\) followTrail\.splice\(at, 1\);/.test(html));
check('the trail does not grow without bound',
  /if \(followTrail\.length > FOLLOW_TRAIL_MAX\) followTrail\.shift\(\)/.test(html));

/* The wheel sets how far back you stand and the drag sets the angle. After a
   minute of both there was no way back to the view F leaves you in short of
   finding somebody else to follow. */
check('V puts the camera back over their shoulder',
  /if \(ev\.code === 'KeyV'\) \{\s*if \(shoulderView\(\)\)/.test(html));
check('and that view is one definition, not three copies',
  /const SHOULDER = \{ pitch: -0\.12, dist: 4\.5 \}/.test(html)
  && (html.match(/SHOULDER\.pitch/g) || []).length >= 3
  && !/cam\.pitch = -0\.12/.test(html));
check('resetting sets the distance too, which is what the wheel moved',
  /P\.followDist = SHOULDER\.dist/.test(html));
/* "Behind them" was only ever true for the instant it was set: cam.yaw is a
   direction in the world, so the moment somebody turned a corner the camera
   held its bearing and you watched them walk away sideways, then head-on. */
const chronSrc = moduleSource('chronicle.js');
check('the shoulder view keeps station behind them as they walk',
  /if \(cam\.astern && !steering\) \{[^]*?cam\.yaw \+= off \* Math\.min\(1, dt \* ASTERN_EASE\)/.test(chronSrc));
check('and V is what puts you back on it',
  /P\.followDist = SHOULDER\.dist;\s*cam\.astern = true;\s*return true;/.test(chronSrc));
check('dragging to look around lets go of their shoulder',
  /cam\.astern = false;\s*cam\.yaw -= \(ev\.clientX - cam\.lastX\)/.test(chronSrc));
/* How far back you stand is not an opinion about which way to look. */
check('but the wheel does not — it only sets how far back you stand',
  !/cam\.astern = false/.test(chronSrc.slice(chronSrc.indexOf("addEventListener('wheel'"))));

/* Eased rather than welded: the walk code turns somebody a little every few
   seconds to get round things, and a camera pinned to their heading swings hard
   at every sidestep. */
const astern = new Function('cam', 'p', 'dt', 'ASTERN_EASE', `
  let off = p.yaw - cam.yaw;
  off = Math.atan2(Math.sin(off), Math.cos(off));
  cam.yaw += off * Math.min(1, dt * ASTERN_EASE);
  return cam.yaw;`);
const EASE = Number((chronSrc.match(/ASTERN_EASE = ([\d.]+)/) || [, 0])[1]);
check('the ease is a real rate, not a snap', EASE > 0 && EASE < 8, String(EASE));
/* The one place a bearing has a seam in it: just west of north to just east of
   it is two degrees, and the long way round is three hundred and fifty-eight. */
{
  const cam2 = { yaw: Math.PI - 0.02 };
  const moved = astern(cam2, { yaw: -Math.PI + 0.02 }, 1, EASE) - (Math.PI - 0.02);
  check('and it turns the short way across the seam of the compass',
    Math.abs(moved) < 0.1 && moved > 0, `moved ${moved.toFixed(3)} rad`);
}
{
  // Half a second of a quarter turn should be most of the way there, not all.
  const cam3 = { yaw: 0 };
  astern(cam3, { yaw: Math.PI / 2 }, 0.5, EASE);
  check('a turn is followed rather than snapped to',
    cam3.yaw > 0.2 && cam3.yaw < Math.PI / 2, `${cam3.yaw.toFixed(2)} of ${(Math.PI / 2).toFixed(2)}`);
}

check('both new keys are on the keys card',
  /<kbd>shift<\/kbd>\+<kbd>F<\/kbd>/.test(html) && /<kbd>V<\/kbd>/.test(html));
check('entering follow picks somebody', /if \(mode === 'follow'\) pickFollow\(false\);/.test(html));
/* N used to follow somebody, which F does now. It is back, for eating, and
   only in Follow. */
check('N no longer follows anybody: it eats',
  !/ev\.code === 'KeyN'[^\n]*\n[^\n]*(pickFollow|setViewMode)/.test(html)
  && /if \(P\.view === 'follow' && ev\.code === 'KeyN'\) \{\s*if \(!eatHere\(\)\)/.test(html));
check('and the key list says F', /<kbd>F<\/kbd>/.test(html));

/* -------------------------------------------------------------------------
   Somewhere, as against somebody

   F answers "show me somebody". In Orbit the question is "show me somewhere",
   and on a 3200m island flying there to find out there was nothing at the other
   end is a long way to go. R is the same shape as F: it puts you in the mode it
   needs rather than making you cycle to it first.
   ------------------------------------------------------------------------- */
check('R both enters orbit and finds somewhere',
  /if \(ev\.code === 'KeyR'\) \{\s*if \(P\.view !== 'orbit'\) setViewMode\('orbit'\);\s*pickRoam\(\);/.test(html));
/* Dry land, not a cliff, and inside the island — the same three tests camp
   siting uses, because a spot that fails them is a spot with nothing to see. */
check('and it lands on dry land',
  /if \(h < SEA \+ 2\) continue;/.test(html));
check('picking the flattest it found rather than the first',
  /if \(flat > bestFlat\) \{ bestFlat = flat; best = \{ x, z, y: h \}; \}/.test(html));
check('inside the island, not out in the water',
  /Math\.sqrt\(Math\.random\(\)\) \* WORLD \* 0\.42/.test(html));
/* Twice in the same place should still be a different picture. */
check('and it looks from a new bearing each time',
  /const look = Math\.random\(\) \* Math\.PI \* 2;/.test(html));
check('the orbit pivot goes with it, or the next drag spins the world',
  /controls\.target\.set\(best\.x, best\.y \+ 2\.5, best\.z\);/.test(html)
  && /if \(P\.view === 'orbit'\) controls\.update\(\);/.test(html));
/* It picks a spot, so it must not draw from the simulation's stream — same rule
   as pickFollow, which is in NOT_STEPPED for exactly this reason. */
check('and it does not draw from the world stream', (() => {
  const body = bodyOf('pickRoam');
  return body && !/\bluck\(\)/.test(body) ? true : 'pickRoam draws from luck()';
})() === true);
check('the key list says R', /<kbd>R<\/kbd>/.test(html));

/* -------------------------------------------------------------------------
   The one figure you are actually looking at

   Turn-taking is invisible at the distance a crowd is seen from and very
   visible at three metres. In Follow the one figure on screen is the one being
   grouped, so it stepped four times as far four times as often — a judder that
   only appeared once worldStep started moving while watching, because before
   that the followed person was either permanently in the group and smooth, or
   permanently outside it and frozen.
   ------------------------------------------------------------------------- */
check('whoever the camera is locked to is not dealt into a group',
  /const watched = P\.view === 'follow' && followIdx >= 0 && followIdx < people\.length/.test(html)
  && /if \(i !== watched\) _turns\.push\(i\);/.test(html)
  && /if \(watched >= 0\) _turns\.push\(watched\);/.test(html));
/* And they get one frame of time, not the whole group's wait, or they walk at
   `stride` times everybody else's pace. */
check('and they get one frame of time, not a group\'s worth',
  /const slice = i === watched \? dt : dt \* stride;/.test(html));
/* One extra person a frame against a saving in the hundreds. */
check('which costs one person a frame', (() => {
  const body = bodyOf('updatePeople');
  if (!body) return 'no updatePeople';
  // The watched index is appended once, so nobody is stepped twice.
  return (body.match(/_turns\.push\(watched\)/g) || []).length === 1
    ? true : 'the watched person is queued more than once';
})() === true);

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
/* The basket at the bottom of the screen says what they carry and how much
   they have left; the caption says neither while it is showing. */
check('and the caption does not repeat what the basket says',
  /const carrying = !hud && p\.haul > 0/.test(bodyOf('updateFollowCaption') || '')
  && /\+ \(hud \? '' : ` <span class="meter/.test(bodyOf('updateFollowCaption') || ''));

/* -------------------------------------------------------------------------
   Where you pointed, and who goes there

   Clicking a person used to pick them to follow. It does not any more: a click
   means "go there" now, which is a thing you say about a place rather than
   about a person, and one gesture cannot carry both readings. Choosing who to
   follow is F, or a name on the band card.
   ------------------------------------------------------------------------- */
check('clicking somebody no longer follows them',
  !/pickPersonAt/.test(html) && !/PICK_RADIUS/.test(html));
check('a click on the ground says where, and only in Follow',
  /const spot = pickGroundAt\(ev\.clientX, ev\.clientY\);/.test(html)
  && /&& P\.view === 'follow'\) \{/.test(html));
/* Looking round at the ground must not also send anybody to it. */
check('and a drag is still not a click',
  /Math\.hypot\(ev\.clientX - press\.x, ev\.clientY - press\.y\) <= CLICK_SLOP_PX/.test(html));

/* A height field has exactly one crossing along a downward ray, so marching to
   it and halving is exact — where a flat plane test misses hills entirely. */
check('the ground is found by marching the ray and halving',
  /if \(_pickAt\.y <= sampleHeight\(_pickAt\.x, _pickAt\.z\)\) \{ below = t; break; \}/.test(html)
  && /const mid = \(above \+ below\) \/ 2;/.test(html));
check('and the sky is not the ground',
  /if \(ray\.direction\.y >= -0\.0001\) return null;/.test(html));
check('nor is the sea, nor off the edge of the island',
  /if \(sampleHeight\(_pickAt\.x, _pickAt\.z\) < SEA \+ 0\.5\) return null;/.test(html)
  && /if \(Math\.hypot\(_pickAt\.x, _pickAt\.z\) > WORLD \* 0\.46\) return null;/.test(html));

/* -------------------------------------------------------------------------
   Taking somebody by the hand

   Following is watching. This is the other half: the person you are behind does
   what you say instead of what they were going to do. Click for where, hold W
   to walk them, shift+W to let go.
   ------------------------------------------------------------------------- */
check('a click hands them their destination',
  /export function leadTo\(x, z\)/.test(html.replace(/^export /gm, 'export ')) || /function leadTo\(x, z\)/.test(html));
/* Pointing is the whole instruction. Holding a key as well was one step too
   many for a single idea — you pointed, so go — and a walk across the island
   was a key held down for a minute. `goto` already means walk until you
   arrive, so being led needs nothing added to the movement at all. */
check('they walk there on their own',
  !/leadWalking/.test(html));
/* And W is the extra rather than the whole instruction: hold it and they run. */
check('and holding shift makes them run',
  /if \(p\.led && leadRunning\(\)\) want = PERSON\.jog \* \(p\.child \? 0\.75 : 1\);/.test(html)
  && /function leadRunning\(\) \{ return keys\.has\('ShiftLeft'\) \|\| keys\.has\('ShiftRight'\); \}/.test(html));
/* Charged for like any other jog. Set before the clamps rather than after, so a
   run costs energy, is cut short when there is none left, and slows with a full
   basket — a run you can hold for ever for nothing makes walking pointless. */
check('and running is charged for like any other jog', (() => {
  const body = bodyOf('updatePeople');
  if (!body) return 'no updatePeople';
  const at = body.indexOf('if (p.led && leadRunning())');
  const clamp = body.indexOf('want = PERSON.walk + (want - PERSON.walk) * clamp(p.energy');
  const carry = body.indexOf('if (p.carry || p.led) want *= carryFactor(p);');
  return at > 0 && at < clamp && at < carry
    ? true : 'the run is set after the clamps that would charge for it';
})() === true);
check('and the state they are put in is the one that walks',
  /if \(p\.led && !p\.acting\) \{[\s\S]{0,200}?p\.state = 'goto';/.test(html));
/* Point somewhere else and they turn round: the lead point is copied to the
   target on every turn, so a new click is picked up without anything else. */
check('a new click turns them round',
  /p\.targetX = p\.leadX;\s*p\.targetZ = p\.leadZ;/.test(html));
/* And arriving is standing still, not finishing an errand they never had. */
check('and arriving just stops them',
  /if \(p\.led\) \{ \/\* nothing to finish \*\/ \}/.test(html));

/* -------------------------------------------------------------------------
   Telling them what to do

   Clicking the ground says where; these say what. Six icons across the bottom
   while you are behind somebody, and nothing at all when you are not.
   ------------------------------------------------------------------------- */
/* Read out of ORDERS rather than written out again here, so the two cannot
   disagree about what a band can be told to do. Adding an errand is adding it
   in one place and putting an icon in the markup. */
const ORDER_LIST = (rawSources[srcFiles.indexOf('chronicle.js')] || '')
  .match(/export const ORDERS = \[([^\]]*)\]/)[1]
  .split(',').map((t) => t.trim().replace(/'/g, '')).filter(Boolean);
check('there is a button for each job you can give', ORDER_LIST.length >= 8,
  ORDER_LIST.join(' '));
check('and one in the markup for each of them', (() => {
  const missing = ORDER_LIST.filter((j) => !html.includes(`data-order="${j}"`));
  return missing.length ? `no button for ${missing.join(', ')}` : true;
})() === true);
/* The two a grown band has and a new one does not. */
check('including the errands a band only has once it has grown',
  ORDER_LIST.includes('quarry') && ORDER_LIST.includes('mourn'));
/* Icons only, which means the words have to be somewhere a pointer and a reader
   can still find them. */
check('each says what it is without being read',
  (html.match(/data-order="\w+" aria-label="[^"]+" title="[^"]+"/g) || []).length === ORDER_LIST.length,
  `${(html.match(/data-order="\w+" aria-label="[^"]+" title="[^"]+"/g) || []).length} labelled of ${ORDER_LIST.length}`);
/* Only while you are behind somebody: a menu bar over an empty world is a menu
   bar over an empty world. */
check('the row is only there in Follow',
  /const p = P\.view === 'follow' \? followedPerson\(\) : null;\s*if \(box\.hidden !== !p\) box\.hidden = !p;/.test(html));
/* And something has to call it, or the row is correct and never drawn. It
   shipped that way: the wiring was written and dropped, every check about the
   orders passed, and the buttons were invisible. */
check('and something actually draws it',
  /export function moveCamera\(dt\) \{\s*updateLeadMark\(\);\s*updateOrders\(\);/.test(
    rawSources[srcFiles.indexOf('chronicle.js')] || ''));

/* An order is one instruction taken up once, not a leash: they go and do it and
   then they are choosing for themselves again. */
check('an order is taken up once and then let go of',
  /if \(p\.orders\) \{\s*p\.job = p\.orders;\s*p\.orders = null;\s*setOut\(p\);\s*\} else chooseJob\(p, day\);/.test(html));
/* Two things steering one person is one too many. */
check('and being told what to do ends being walked by hand',
  /if \(p\.led\) releaseLead\(false, false\);\s*p\.orders = job;/.test(html));

/* The rule that keeps a world reproducible: only what the step calls may draw
   from the stream. A click happens on a frame, not on a step — so the order is
   left on the person and the next turn spends it. */
check('an order draws nothing from the world stream', (() => {
  const body = bodyOf('orderJob');
  if (!body) return 'no orderJob';
  return !/\bluck\(\)/.test(body) && !/setOut\(/.test(body) && !/pickWork\(/.test(body)
    ? true : 'orderJob points them at something itself';
})() === true);
check('and the thing that does is only called from the step', (() => {
  // setOut draws from luck(); it must not be reachable from a click.
  const ui = rawSources[srcFiles.indexOf('ui.js')] || '';
  const chron = rawSources[srcFiles.indexOf('chronicle.js')] || '';
  return !/setOut\(/.test(ui) && !/setOut\(/.test(chron)
    ? true : 'setOut is called outside move.js';
})() === true);

/* -------------------------------------------------------------------------
   The two on the end that are not errands

   Everything in ORDERS sends somebody out. These are the other direction: one
   takes the instructions off them, one brings them in. They carry `data-act`
   rather than `data-order` so the row's listener can tell them apart, which is
   also why they are checked apart from the loop above.
   ------------------------------------------------------------------------- */
for (const [act, what] of [['free', 'handing them back'], ['home', 'sending them home']]) {
  check(`there is a button for ${what}`,
    new RegExp(`data-act="${act}" aria-label="[^"]+" title="[^"]+"`).test(html),
    `no labelled data-act="${act}"`);
}
/* Both halves of being told what to do. Shift+W dropped the hand on the
   shoulder and left a pending order sitting there, which is a person you have
   let go of who still does the next thing you said. */
check('handing them back drops the lead and the order together', (() => {
  const body = bodyOf('handBack');
  if (!body) return 'no handBack';
  return /p\.orders = null;/.test(body) && /releaseLead\(false\)/.test(body)
    ? true : 'handBack undoes only one of the two';
})() === true);
/* And it does not stop you watching them. Letting go of somebody and turning
   away from them are different things, and the second one is Esc. */
check('and it leaves you still behind them',
  !/setViewMode\(/.test(bodyOf('handBack') || ''), 'handBack leaves Follow');

/* Going home is the walk that ends every errand, started early: it is a state
   the person already has, not a new one. */
check('going home is the ordinary walk back',
  /if \(p\.goingHome\) \{\s*p\.goingHome = false;/.test(html)
  && /p\.state = 'return';\s*const to = homeward\(p, 0\);\s*p\.targetX = to\.x;/.test(html));
/* The same place every other walk home goes: the granaries with food in their
   arms, their own hearth without — the same fire they sleep at, which is what
   homeFire is for. */
check('and it is their own fire they are sent to when they carry nothing',
  /const f = homeFire\(p\);\s*return \{ x: f\.x, z: f\.z, spread \};/.test(html));

/* The rule that keeps a world reproducible, again: a click happens on a frame,
   so it may not draw from the stream. Home is left on the person and the next
   turn spends it, exactly as an order is. */
check('being sent home draws nothing from the world stream', (() => {
  const body = bodyOf('sendHome');
  if (!body) return 'no sendHome';
  return !/\bluck\(\)/.test(body) && !/travelTimeout\(/.test(body) && !/homeFire\(/.test(body)
    ? true : 'sendHome points them at something itself';
})() === true);

/* And the wiring, which is the part that has actually been wrong: the buttons
   shipped invisible once because the line that drew them was written into a
   patch that never applied, and every check about them passed. An export
   nothing imports is the same failure one step earlier. */
check('the row reads the two of them', (() => {
  const ui = rawSources[srcFiles.indexOf('ui.js')] || '';
  const wired = /data-act\]/.test(ui) && /handBack\(\)/.test(ui) && /sendHome\(\)/.test(ui);
  const imported = /import \{[^}]*\bhandBack\b[^}]*\} from '\.\/chronicle\.js'/s.test(ui)
    && /import \{[^}]*\bsendHome\b[^}]*\} from '\.\/chronicle\.js'/s.test(ui);
  if (!wired) return 'the listener does not call them';
  return imported ? true : 'called but never imported';
})() === true);
/* Nothing to undo is a thing the button has to say. Pressing it and having
   nothing happen reads as the button being broken. */
check('and the one that undoes is greyed when there is nothing to undo',
  /button\[data-act="free"\]/.test(bodyOf('updateOrders') || '')
  && /free\.disabled/.test(bodyOf('updateOrders') || ''));

/* -------------------------------------------------------------------------
   Bringing it in

   Food carried home goes to the granaries, not the fire. Run as well as read:
   which granary, and what happens when none is standing yet, are the parts a
   regex cannot see.
   ------------------------------------------------------------------------- */
const homeward = (() => {
  const at = html.indexOf('function homeward(');
  if (at < 0) return null;
  const src = html.slice(at, html.indexOf('\n}\n', at) + 2);
  return new Function('homeFire', `${src}; return homeward;`)((p) => p.hearth || p.camp);
})();
check('there is somewhere to bring food in to', typeof homeward === 'function');
if (homeward) {
  const spots = [
    { x: 13, z: 0, fx: 11.3, fz: 0 }, { x: 13, z: -2.7, fx: 11.3, fz: -2.7 },
    { x: 13, z: 2.7, fx: 11.3, fz: 2.7 }, { x: 15.4, z: 1.35, fx: 13.7, fz: 1.35 },
  ];
  const hearth = { x: -4, z: 6 };
  const camp = (up) => ({ x: 0, z: 0, storesUp: up, storeSpots: spots });
  const who = (up, haul, x, z) => ({ camp: camp(up), hearth, haul, x, z });
  const a = homeward(who(4, 1, 20, -5), 6);
  check('with food, to the front of the nearest granary', a.x === 11.3 && a.z === -2.7,
    `${a.x},${a.z}`);
  /* The nearest standing, not the nearest there is room for. */
  const b = homeward(who(2, 1, 20, 5), 6);
  check('and only one that is actually standing', b.x === 11.3 && b.z === 0, `${b.x},${b.z}`);
  const c = homeward(who(0, 1, 20, 5), 6);
  check('and where the first will go when none is up yet', c.x === 11.3 && c.z === 0,
    `${c.x},${c.z}`);
  const d = homeward(who(3, 0, 20, 5), 6);
  check('empty-handed, to their own fire', d.x === -4 && d.z === 6 && d.spread === 6,
    `${d.x},${d.z} spread ${d.spread}`);
  check('and a granary is walked up to, not sat round', a.spread < d.spread, String(a.spread));
}
/* Every walk home that is a walk home. The tiger is not one: running from it
   goes to the nearest fire, and the granaries are not somewhere to hide. */
check('every errand ends at the granaries when there is food to bring',
  (html.match(/aimHome\(p, \d\);/g) || []).length === 3
  && !/p\.state = 'return';\s*p\.targetX = homeFire/.test(html),String((html.match(/aimHome\(p, \d\);/g) || []).length));
check('but running from a tiger is still to the nearest fire',
  /const run = nearestFire\(p\.camp, p\.x, p\.z\);/.test(html));
/* Two draws whichever way they go, the same two the fire always took, so a
   band carrying nothing replays exactly as it did. */
check('and aiming home takes the same two draws it always did',
  ((bodyOf('aimHome') || '').match(/\bluck\(\)/g) || []).length === 2);
check('they stand there putting it away',
  /p\.stowed = p\.haul > 0;\s*if \(p\.haul > 0\) \{\s*p\.camp\.food \+= p\.haul;/.test(html)
  && /case 'idle':[\s\S]{0,400}?p\.stowed = false;/.test(html));

/* -------------------------------------------------------------------------
   Bubbles

   What somebody is doing, over their head, while they are stopped doing it.
   ------------------------------------------------------------------------- */
const BUBBLE = (() => {
  const m = html.match(/const BUBBLE = (\{[^}]*\});/);
  return m ? new Function(`return ${m[1]};`)() : null;
})();
const bubbleFor = (() => {
  const at = html.indexOf('function bubbleFor(');
  if (at < 0 || !BUBBLE) return null;
  const src = html.slice(at, html.indexOf('\n}\n', at) + 2);
  const walking = Number(html.match(/const WALKING_AT = ([\d.]+);/)?.[1]);
  return new Function('BUBBLE', 'WALKING_AT', `${src}; return bubbleFor;`)(BUBBLE, walking);
})();
check('there is a bubble for what people do', typeof bubbleFor === 'function');
if (bubbleFor) {
  const at = (o) => bubbleFor({ speed: 0, state: 'work', hidden: false, ...o });
  check('stopped in a berry patch, foraging', at({ job: 'gather' }) === BUBBLE.gather);
  check('walking to one, nothing', at({ job: 'gather', state: 'goto', speed: 1.3 }) === -1);
  check('at the water, fishing', at({ job: 'fish' }) === BUBBLE.fish);
  check('at the next band, trading', at({ job: 'visit' }) === BUBBLE.visit);
  check('just in with food, putting it away', at({ job: 'gather', state: 'idle', stowed: true }) === BUBBLE.store);
  check('stood between errands, resting', at({ job: 'gather', state: 'idle' }) === BUBBLE.rest);
  check('knapping in a tent, over the tent', at({ job: 'craft', hidden: true }) === BUBBLE.craft);
  check('asleep, over the tent', at({ job: 'sleep', hidden: true, asleep: true }) === BUBBLE.sleep);
  check('sitting about in a tent, nothing', at({ job: 'tend', hidden: true, state: 'idle' }) === -1);
  check('being led, nothing', at({ job: 'led', led: true }) === -1);
  check('running from something, nothing', at({ job: 'gather', panic: 2 }) === -1);
  check('a child at play, nothing', at({ job: 'play' }) === -1);
}
/* The drawings live in icons.js, shared with the map. It imports nothing, so
   it can be run here as it is. Every bubble is the picture of its own name, or
   of the one its alias names. */
const ICON_PATHS = (() => {
  const src = sources[srcFiles.indexOf('icons.js')];
  try { return src ? new Function(`${src}\nreturn ICON_PATHS;`)() : null; } catch { return null; }
})();
check('every bubble has a drawing', (() => {
  if (!ICON_PATHS) return 'no icons.js';
  const alias = new Function(`return ${html.match(/const BUBBLE_ICON = (\{[^}]*\});/)?.[1] || '{}'};`)();
  const missing = Object.keys(BUBBLE || {}).filter((k) => !ICON_PATHS[alias[k] || k]);
  return missing.length ? `none for ${missing.join(', ')}` : true;
})() === true);
/* And something draws them: the part that has actually gone missing before. */
check('and they are drawn every frame, after the people move', (() => {
  const main = rawSources[srcFiles.indexOf('main.js')] || '';
  if (!/import \{ updateBubbles \} from '\.\/bubbles\.js';/.test(main)) return 'never imported';
  return /updatePeople\(paced, daylight\);\s*\/\/[^\n]*\n\s*updateBubbles\(\);/.test(main)
    ? true : 'not called after updatePeople';
})() === true);
/* The atlas is painted with Path2D, which a browser has and the boot check
   does not. Guarded, or the page boots and the check does not. */
check('and the painting does not need a browser to build',
  /if \(typeof Path2D !== 'function'\) return;/.test(bodyOf('drawIcon') || ''));

/* And a word beside the icon, near enough to read one. */
const BUBBLE_SAYS = (() => {
  const m = html.match(/const BUBBLE_SAYS = (\{[^}]*\});/);
  return m ? new Function(`return ${m[1]};`)() : null;
})();
check('every bubble says one word', (() => {
  if (!BUBBLE || !BUBBLE_SAYS) return 'no words';
  const bad = Object.keys(BUBBLE).filter((k) => !/^[a-z]+$/.test(BUBBLE_SAYS[k] || ''));
  return bad.length ? `no single word for ${bad.join(', ')}` : true;
})() === true);
/* Near: the word. Further out, the icon alone — a word has to be about twelve
   pixels tall to be read, and at seventy metres that makes every bubble wider
   than the person under it. */
check('the word goes up near, the icon alone further out',
  /const near = d < BUBBLE_WORDS;/.test(html) && /icon\.setX\(n, near \? k \+ WORD_AT : k\);/.test(html));
check('and the shader sizes the worded ones as the wide ones',
  /gl_PointSize = aIcon > \$\{\(WORD_AT - 0\.5\)\.toFixed\(1\)\} \? wide : round;/.test(html));
check('and the atlas has a cell for both shapes of every bubble', (() => {
  const n = Object.keys(BUBBLE || {}).length;
  const at = Number(html.match(/const WORD_AT = (\d+);/)?.[1]);
  const [, cols, rows] = (html.match(/const ATLAS_COLS = (\d+), ATLAS_ROWS = (\d+);/) || []).map(Number);
  return n <= at && at + n <= cols * rows ? true : `${n} bubbles, words at ${at}, ${cols * rows} cells`;
})() === true);
/* The boot check's canvas has arcs and lines and nothing rounder, and neither
   do older browsers. */
check('and the pill is drawn from arcs and lines',
  !/roundRect\(|arcTo\(/.test(bodyOf('paintPill') || 'roundRect('));

/* -------------------------------------------------------------------------
   Where the food is, and what the map shows

   Marks on the full map for the four places food comes from, each one a place
   you can click to go to; and every layer of the map one you can put away.
   ------------------------------------------------------------------------- */
const MAP_LAYERS = JSON.parse((html.match(/const MAP_LAYERS = (\[[^\]]*\]);/)?.[1] || '[]').replace(/'/g, '"'));
check('the map has layers you can put away', MAP_LAYERS.length >= 9, MAP_LAYERS.join(' '));
check('and a line in the filter list for each of them', (() => {
  const missing = MAP_LAYERS.filter((k) => !new RegExp(`data-layer="${k}" aria-pressed="true"`).test(html));
  return missing.length ? `no line for ${missing.join(', ')}` : true;
})() === true);
/* A switch that nothing reads is a switch that does nothing, and passes every
   other check here. */
check('every layer the map draws asks whether it is showing', (() => {
  const drawn = (bodyOf('drawMap') || '') + (bodyOf('gatherMarks') || '');
  /* The quarry layers are asked by the deposit's own kind, one line for all
     five, rather than five lines saying the same thing. */
  const ores = /mapShows\[d\.kind\]/.test(drawn) ? ['stone', 'iron', 'bronze', 'silver', 'gold'] : [];
  const missing = MAP_LAYERS.filter((k) => !drawn.includes(`mapShows.${k}`) && !ores.includes(k));
  return missing.length ? `never asked: ${missing.join(', ')}` : true;
})() === true);
check('the paths are only drawn while they are showing', /if \(mapShows\.paths\) drawPathLayer\(\);/.test(html));
check('the food is only marked on the full map',
  /mapMarks\.length = 0;\s*if \(!mapIsFull\(\)\) return;/.test(bodyOf('gatherMarks') || ''));
check('every kind of food has a drawing', (() => {
  const kinds = [...(html.match(/const MARK_KINDS = \{([\s\S]*?)\n\};/)?.[1] || '').matchAll(/icon: '(\w+)'/g)].map((m) => m[1]);
  const missing = kinds.filter((k) => !ICON_PATHS?.[k]);
  return kinds.length >= 4 && !missing.length ? true : `kinds ${kinds.join(',')} missing ${missing.join(',')}`;
})() === true);
check('the fruit marked is the fruit still on the trees',
  /if \(!orchard\.on\[i\]\) continue;/.test(bodyOf('clumpFruit') || ''));
/* The first world this drew had 117 clumps worth a mark on the whole island. */
check('and only the richest few of it, in view',
  /fruitClumps\.sort\(\(a, b\) => b\.n - a\.n\);/.test(bodyOf('clumpFruit') || '')
  && /if \(shown >= FRUIT_MARKS\) break;\s*if \(put\('fruit'/.test(bodyOf('gatherMarks') || ''));
check('clicking a mark goes there and says what it is',
  /travelTo\(hit\.mark\.x, hit\.mark\.z\);\s*toast\(hit\.mark\.label\);/.test(html));
check('and a granary beside its own fire goes to whichever the pointer is nearer',
  /if \(hit && \(!camp \|\| hit\.d < campDist\(camp, ev\.clientX, ev\.clientY\)\)\)/.test(html));
check('hovering one says what it is', /if \(mapCanvas\.title !== tip\) mapCanvas\.title = tip;/.test(html));
check('each band\'s raft is on the full map, wherever it is, with a layer of its own',
  /if \(mapShows\.rafts && c\.raft\) \{/.test(bodyOf('gatherMarks') || '')
  && /const out = at && raftBusy\(c\) \? c\.raftOut : null;/.test(bodyOf('gatherMarks') || '')
  && /rafts: \{ icon: 'raft'/.test(html) && /data-layer="rafts" aria-pressed="true"/.test(html));
/* The corner map: for glancing at, and a way into the full one. */
check('the corner map is plain: land and water, the paths, and a dot for each band',
  /if \(!mapIsFull\(\)\) \{ drawCornerMap\(\); return; \}/.test(bodyOf('drawMap') || '')
  && /drawImage\(mapPlain \|\| mapBase, sx, sz, src, src, 0, 0, MAP_N, MAP_N\)/.test(bodyOf('drawCornerMap') || '')
  && /drawPathLayer\(\);/.test(bodyOf('drawCornerMap') || '')
  && !/mapShows\.people|gatherMarks|pack\.list/.test(bodyOf('drawCornerMap') || ''));
check('and its ground is flat land and water, with no relief',
  /const flat = h < SEA \? PLAIN_WATER : PLAIN_LAND/.test(bodyOf('renderMapBase') || ''));
check('a click on the corner map opens the full map rather than travelling',
  /if \(!mapIsFull\(\)\) \{ setMapSize\(FULL_MAP\); return; \}/.test(html)
  && /const tip = !mapIsFull\(\) \? 'open the map'/.test(html));
check('the E prompt sits above the order row, however tall it is',
  /const lift = row && !row\.hidden && row\.offsetHeight \? row\.offsetHeight \+ 20 : 58;/.test(bodyOf('updateActPrompt') || ''));
check('the map remembers what you put away',
  /localStorage\.setItem\(MAP_LAYERS_STORE/.test(bodyOf('setMapLayer') || '')
  && /localStorage\.getItem\(MAP_LAYERS_STORE\)/.test(html));
check('and the funnel fills while anything is hidden',
  /classList\?\.toggle\('filtering', MAP_LAYERS\.some/.test(bodyOf('paintLayerButtons') || ''));
check('there is a line to put them all away or bring them all back',
  /<button data-all aria-pressed="true"><i><\/i>All<\/button>/.test(html));
check('which brings everything back when anything is hidden, and puts it all away when nothing is',
  /if \(ev\.target\?\.closest\?\.\('button\[data-all\]'\)\) \{\s*setAllMapLayers\(!MAP_LAYERS\.every\(\(k\) => mapShows\[k\]\)\);/.test(html));
check('and says so when it is some of each',
  /on === MAP_LAYERS\.length \? 'true' : on === 0 \? 'false' : 'mixed'/.test(bodyOf('paintLayerButtons') || ''));
check('and is remembered like the rest',
  /localStorage\.setItem\(MAP_LAYERS_STORE/.test(bodyOf('setAllMapLayers') || ''));
check('the list goes away with the full map', /if \(!at\.fills\) \{ mapZoom = 1; closeMapLayers\(\); \}/.test(html));
check('and the marks do not need a browser to build',
  /const paths = typeof Path2D === 'function';/.test(bodyOf('drawMarks') || ''));

/* -------------------------------------------------------------------------
   Doing it yourself

   WASD walks the person you are behind; E does what is in front of them. Both
   ride on what being led already is, and both keep the rule that a frame may
   not draw from the world's stream.
   ------------------------------------------------------------------------- */
check('WASD walks them, the way the camera looks', (() => {
  const body = bodyOf('steerFollowed') || '';
  return /const sx = Math\.sin\(cam\.yaw\), sz = Math\.cos\(cam\.yaw\);/.test(body)
    && ['KeyW', 'KeyA', 'KeyS', 'KeyD'].every((k) => body.includes("keys.has('" + k + "')"))
    && /p\.leadX = p\.x \+ \(fx \/ len\) \* STEER_AHEAD;/.test(body) ? true : 'not steered off the camera';
})() === true);
check('and letting go of the keys stops them where they are',
  /\} else if \(steering\) \{[\s\S]{0,120}?p\.leadX = p\.x; p\.leadZ = p\.z;/.test(bodyOf('steerFollowed') || ''));
check('and it is done every frame', /updateOrders\(\);\s*steerFollowed\(\);\s*updateActPrompt\(\);/.test(html));
/* The camera stops swinging round behind them while they are walked with keys,
   or S turns them round, which turns the camera, which turns them round. */
check('and the camera holds its bearing while they are', /if \(cam\.astern && !steering\) \{/.test(html));
check('E does what is in front of them', /if \(P\.view === 'follow' && ev\.code === 'KeyE'\) \{\s*const done = actHere\(\);/.test(html));
check('and it is left on them for the step to do, not done by the frame', (() => {
  const body = bodyOf('actHere') || '';
  return /p\.act = t;/.test(body) && !/\bluck\(\)/.test(body) && !/throwSpear\(|startAct\(/.test(body)
    ? true : 'actHere does the act itself';
})() === true);
check('and the frame that works out what is there draws nothing either', (() => {
  const body = (bodyOf('whatHere') || '') + (bodyOf('fruitNear') || '') + (bodyOf('preyNear') || '');
  return !/\bluck\(\)/.test(body) && !/nearestFruit\(/.test(body) ? true : 'it draws from the stream';
})() === true);
check('the next turn starts it', /if \(p\.act\) \{ startAct\(p\); p\.act = null; \}/.test(html));
check('as the errand of the same name, where they stand',
  /p\.acting = true;\s*p\.job = job;\s*p\.state = 'work';/.test(bodyOf('startAct') || ''));
check('and the spear is thrown in the step, by the stream',
  /\bluck\(\)/.test(bodyOf('throwSpear') || '')
  && !/throwSpear\(/.test(moduleSource('chronicle.js')) && !/throwSpear\(/.test(moduleSource('ui.js')));
check('closer is surer, and the band\'s spears count',
  /THROW\.point \* \(1 - 0\.7 \* d \/ THROW\.reach\)\s*\* \(1 \+ SKILL\.spearChance \* p\.camp\.skill\.spears\)/.test(bodyOf('throwSpear') || ''));
/* The whole difference from an errand: somebody you did it with is still yours. */
check('and when it is done they are still yours, not walked home',
  /if \(p\.acting\) \{ endAct\(p\); break; \}\s*p\.state = 'return';/.test(html)
  && /p\.job = 'led';\s*p\.state = 'goto';/.test(bodyOf('endAct') || ''));
check('the errand timer runs for somebody you are leading only while they are doing something',
  /if \(p\.timer <= 0 && \(!p\.led \|\| p\.acting\)\) \{/.test(html));
check('and letting go drops whatever they were doing', /p\.acting = false;\s*p\.act = null;/.test(bodyOf('releaseLead') || ''));
check('the prompt says what E would do before you press it',
  /el\.innerHTML = '<kbd>E<\/kbd> ' \+ t\.words/.test(html) && /<div id="actPrompt" hidden><\/div>/.test(html));
check('and the keys card says all three',
  /<kbd>W<\/kbd><kbd>A<\/kbd><kbd>S<\/kbd><kbd>D<\/kbd><\/span><em><i>\(in Follow\)<\/i> walk them yourself/.test(html)
  && /<kbd>E<\/kbd><\/span><em><i>\(in Follow\)<\/i> do what is in front of them/.test(html)
  && /<kbd>Q<\/kbd><\/span><em><i>\(in Follow\)<\/i> let go/.test(html));
check('the throw reach is the same number in both places',
  Number(html.match(/THROW_REACH = (\d+);/)?.[1]) === Number(html.match(/THROW = \{ reach: (\d+),/)?.[1]));

/* The basket, on screen: what is in it, how full, and what it is for. */
check('the action bar says what they are carrying',
  /<div id="bagHud" class="bag"><\/div>/.test(html) && /updateBagHud\(p\);/.test(bodyOf('updateOrders') || ''));
check('how full: what it weighs against what they can carry',
  /clamp\(loadOf\(p\) \/ carryCap\(p, SKILL\.basketHaul, p\.camp\.skill\?\.baskets \|\| 0\), 0, 1\)/.test(bodyOf('updateBagHud') || ''));
check('and the slowness it quotes is the slowness in the step',
  /if \(p\.carry \|\| p\.led\) want \*= carryFactor\(p\);/.test(html) && /carryFactor\(p\)/.test(bodyOf('updateBagHud') || ''));
check('and the store it is all for', /daysOfFood\(p\.camp\)/.test(bodyOf('updateBagHud') || ''));
/* Putting it away: E at the granary, or at the fire before there is one. */
check('carrying something in the storage area, E puts it away',
  /if \(hasLoad\(p\) && inStoreArea\(p\)\) \{/.test(bodyOf('whatHere') || ''));
check('the same unloading a walk home ends in',
  /bankLoad\(p\);\s*p\.state = 'idle';/.test(html)
  && /if \(a\.kind === 'store'\) \{[\s\S]{0,200}?bankLoad\(p\);/.test(bodyOf('startAct') || ''));
/* A band that has died out keeps its camp, not its row. */
/* The storage area is a place with an edge, and the edge is drawn. */
check('the storage area is the ground round the granaries',
  /camp\.storeArea = \{ x: cx, z: cz, r \};/.test(html)
  && /const r = STORE_AREA_EDGE \+ Math\.max\(/.test(html));
check('with a ring on the ground round it, green once they are in',
  /storeRing\.material\.color\.setHex\(inStoreArea\(p\) \? STORE_RING_IN : STORE_RING_OUT\);/.test(html)
  && /updateStoreRing\(\);/.test(html));
check('and the basket on screen says how far, or that they are there',
  /at the granaries · E puts it away/.test(bodyOf('updateBagHud') || '')
  && /granaries ' \+ Math\.ceil\(off\) \+ ' m/.test(bodyOf('updateBagHud') || ''));
check('and there is a button for it, lit only where it works',
  /data-act="store"/.test(html) && /const can = loadNow && inStoreArea\(p\);/.test(html));
/* Foraging is only something where there is food: the grounds the map marks. */
check('E forages at a berry thicket and nowhere else',
  /on: d < THICKET_REACH/.test(bodyOf('actionTargets') || '')
  && !/if \(sampleHeight\(p\.x, p\.z\) > SEA \+ 0\.9\) return \{ kind: 'gather'/.test(html)
  && !/function forageGroundNear/.test(html));
/* And a load can be put down. */
check('G puts a handful down and shift+G all of it, and the step does it',
  /if \(P\.view === 'follow' && ev\.code === 'KeyG'\) \{\s*if \(!dropHere\(ev\.shiftKey\)\)/.test(html)
  && /p\.act = \{ kind: 'drop', all: Boolean\(all\) \};/.test(bodyOf('dropHere') || '')
  && /const out = takeOut\(p\);\s*if \(!out\) break;\s*putDown\(p, out\);/.test(bodyOf('startAct') || ''));
check('and nothing put down is lost: it is a pile, and E picks it up again',
  !/if \(a\.kind === 'drop'\) \{[\s\S]{0,200}?p\.haul = 0;\s*emptyBag\(p\);/.test(bodyOf('startAct') || '')
  && /putIn\(p, pile\);\s*removeDrop\(pile\);/.test(bodyOf('startAct') || '')
  && /kind: 'pickup'/.test(bodyOf('actionTargets') || ''));
check('a pile put down where another of its kind lies joins it, and anywhere else is its own',
  /Math\.hypot\(d\.x - x, d\.z - z\) < DROP\.merge/.test(bodyOf('putDown') || ''));
check('food left lying spoils, and stone does not',
  /if \(d\.kind !== 'ore' && d\.kind !== 'wood' && simDay - d\.born > DROP\.keeps\)/.test(bodyOf('updateDrops') || ''));
check('and what is lying on the ground survives a reload',
  /drops: keptDrops\(\),/.test(html) && /restoreDrops\(st\.drops\);/.test(html));
check('and there is a button for it too',
  /data-act="drop"/.test(html) && /if \(a\?\.dataset\.act === 'drop'\) dropHere\(\);/.test(html)
  && /<kbd>G<\/kbd><\/span><em><i>\(in Follow\)<\/i> put a handful down in front of them/.test(html));

/* A load weighs something, for the person you are playing: run, not read. */
const WEIGH = (() => {
  const src = sources[srcFiles.indexOf('bag.js')];
  try { return src ? new Function(src + '\nreturn { loadOf, carryCap, loadPace };')() : null; } catch { return null; }
})();
check('a basketful of food is a load of one', (() => {
  if (!WEIGH) return 'no bag.js';
  const b = (o) => ({ bag: { fruit: 0, berries: 0, fish: 0, game: 0, animal: null, ore: 0, oreKind: null, ...o } });
  const ok = Math.abs(WEIGH.loadOf(b({ berries: 50 })) - 1) < 1e-9 && Math.abs(WEIGH.loadOf(b({ fish: 10 })) - 1) < 1e-9
    && WEIGH.loadOf(b({ game: 1, animal: 'bison' })) > 1 && WEIGH.loadOf(b({ game: 1, animal: 'deer' })) < 1;
  return ok ? true : 'weights are off';
})() === true);
check('the fuller, the slower, and none at all at or past full', (() => {
  if (!WEIGH) return 'no bag.js';
  const paces = [0, 0.25, 0.5, 0.75, 0.99].map((f) => WEIGH.loadPace(f, 1));
  const falling = paces.every((v, i) => i === 0 || v < paces[i - 1]);
  return falling && paces[0] === 1 && WEIGH.loadPace(1, 1) === 0 && WEIGH.loadPace(1.4, 1) === 0
    ? true : paces.map((v) => v.toFixed(2)).join(' ');
})() === true);
check('better baskets carry more, and a child half as much',
  WEIGH && WEIGH.carryCap({}, 0.6, 1) > WEIGH.carryCap({}, 0.6, 0)
  && WEIGH.carryCap({ child: true }, 0.6, 0) === WEIGH.carryCap({}, 0.6, 0) / 2);
/* The band's own foragers keep the flat fifth: they cannot put a load down, so
   one that could stop them would stop them for good. */
check('only the person you are playing is weighed down by it',
  /if \(!p\.led\) return 0\.8;/.test(bodyOf('carryFactor') || ''));
check('too heavy to walk is not too heavy to do what is in reach',
  !/return 'heavy'/.test(bodyOf('actHere') || '')
  && !/if \(tooHeavy\(p\)\) \{\s*p\.actResult = 'too heavy/.test(bodyOf('startAct') || ''));
check('and the prompt says how to get moving', /put one down — too heavy to walk/.test(bodyOf('updateActPrompt') || ''));
check('but too heavy to walk is too heavy to be sent anywhere: no order, no walk home, no letting go',
  ['orderJob', 'handBack', 'sendHome'].every((f) => /if \(tooHeavyToSend\(p\)\) return false;/.test(bodyOf(f) || ''))
  && /if \(b\.dataset\?\.order && b\.disabled !== heavy\) b\.disabled = heavy;/.test(bodyOf('updateOrders') || '')
  && /if \(home && home\.disabled !== heavy\) home\.disabled = heavy;/.test(bodyOf('updateOrders') || ''));
check('and the one you are playing is weighed by what is in the basket, whatever the carry flag says',
  /if \(p\.carry \|\| p\.led\) want \*= carryFactor\(p\);/.test(html));
/* One handful at a time, and the pile and the basket add up to what there was. */
const HAND = (() => {
  const src = sources[srcFiles.indexOf('bag.js')];
  try { return src ? new Function(src + '\nreturn { takeOut, putIn };')() : null; } catch { return null; }
})();
check('a handful out is ten berries, and the food goes with it', (() => {
  if (!HAND) return 'no bag.js';
  const p = { haul: 0.3, bag: { fruit: 0, berries: 15, fish: 0, game: 0, animal: null, ore: 0, oreKind: null } };
  const out = HAND.takeOut(p);
  return out && out.kind === 'berries' && out.n === 10 && p.bag.berries === 5
    && Math.abs(out.food + p.haul - 0.3) < 1e-9 ? true : JSON.stringify(out);
})() === true);
check('an animal comes out before anything lighter, and the last handful takes what is left', (() => {
  if (!HAND) return 'no bag.js';
  const p = { haul: 20.1, bag: { fruit: 0, berries: 5, fish: 0, game: 1, animal: 'deer', ore: 0, oreKind: null } };
  const a = HAND.takeOut(p), b = HAND.takeOut(p);
  return a.kind === 'game' && b.kind === 'berries' && p.haul === 0 && Math.abs(a.food + b.food - 20.1) < 1e-9
    ? true : JSON.stringify([a, b, p.haul]);
})() === true);
check('and a pile picked up goes back in as it came out', (() => {
  if (!HAND) return 'no bag.js';
  const p = { haul: 0.1, bag: { fruit: 0, berries: 5, fish: 0, game: 0, animal: null, ore: 0, oreKind: null } };
  HAND.putIn(p, { kind: 'berries', n: 10, food: 0.2 });
  return p.bag.berries === 15 && Math.abs(p.haul - 0.3) < 1e-9 ? true : JSON.stringify(p);
})() === true);

/* Who you were watching survives a refresh. */
check('who you are behind is kept as it changes, by id and seed',
  /localStorage\.setItem\(FOCUS_STORE, JSON\.stringify\(\{ seed: P\.seed, view: P\.view, id \}\)\)/.test(bodyOf('keepFocus') || '')
  && /updateStoreRing\(\);\s*keepFocus\(\);/.test(html));
check('and only written when it changes, though it is asked every frame',
  /if \(keptSeed === P\.seed && keptView === P\.view && keptId === id\) return;/.test(bodyOf('keepFocus') || ''));
check('and put back only on the island it belongs to, by who they are',
  /kept\.seed !== P\.seed/.test(bodyOf('restoreFocus') || '') && /return followPersonById\(kept\.id\);/.test(bodyOf('restoreFocus') || ''));
check('once the world is standing and the view is set',
  /setViewMode\(P\.view\);\s*placeCamera\(\);\s*\/\/[^\n]*\n\s*restoreFocus\(\);/.test(moduleSource('main.js')));
check('and a browser with nowhere to keep it still boots',
  /try \{ localStorage\.setItem\(FOCUS_STORE/.test(html) && /try \{ kept = JSON\.parse\(localStorage\.getItem\(FOCUS_STORE\)/.test(html));

/* Food you can see: berry thickets, laid out with the island. */
check('the thickets come off the world seed, the richest ground first, kept apart', (() => {
  const body = bodyOf('buildThickets') || '';
  return /const rng = mulberry32\(P\.seed \^ 0x[0-9a-f]+\);/.test(body) && !/\bluck\(\)/.test(body)
    && /cand\.sort\(\(a, b\) => b\.rich - a\.rich\);/.test(body) && /THICKET\.apart/.test(body)
    ? true : 'not seeded, ranked and spaced';
})() === true);
check('and their berries are the ground\'s own richness, picked thin and grown back',
  /forageRichness\(/.test(bodyOf('thicketRipe') || '')
  && /const n = Math\.round\(thicketRipe\(t\) \* THICKET\.berries\);/.test(bodyOf('updateThickets') || ''));
check('and the map marks the thickets as the foraging',
  /put\('forage', t\.x, t\.z, 'Berries: ' \+ ripeWord\(t\)\)/.test(bodyOf('gatherMarks') || ''));
/* Every place E acts on has an edge, and the edge is the thing and a metre. */
check('each area is the thing on the ground and about a metre more', (() => {
  const n = (re) => Number(html.match(re)?.[1]);
  const fire = n(/FIRE_REACH = ([\d.]+);/), dig = n(/DIG_BUFFER = ([\d.]+);/);
  const fruit = n(/FRUIT_REACH = ([\d.]+);/), store = n(/STORE_AREA_EDGE = ([\d.]+);/);
  const bad = [];
  if (!(fire > 1.15 && fire < 3)) bad.push('fire ' + fire);
  if (!(dig <= 1.5)) bad.push('dig ' + dig);
  if (!(fruit <= 4)) bad.push('fruit ' + fruit);
  if (!(store > 1.7 && store <= 2.5)) bad.push('store ' + store);
  return bad.length ? bad.join(', ') : true;
})() === true);
check('a ring goes down on each thing within a short walk, and the one E would act on is green',
  /actionRings\.setColorAt\(n, _rc\.setHex\(t === chosen \? RING_ON : RING_OFF\)\);/.test(bodyOf('updateActionRings') || ''));
check('in the storage ring\'s own two colours',
  Number(html.match(/RING_ON = (0x[0-9a-f]+), RING_OFF = (0x[0-9a-f]+);/)?.[1]) === Number(html.match(/STORE_RING_OUT = (0x[0-9a-f]+), STORE_RING_IN = (0x[0-9a-f]+);/)?.[2])
  && Number(html.match(/RING_ON = (0x[0-9a-f]+), RING_OFF = (0x[0-9a-f]+);/)?.[2]) === Number(html.match(/STORE_RING_OUT = (0x[0-9a-f]+), STORE_RING_IN = (0x[0-9a-f]+);/)?.[1]));
check('and what E does is the ring that is green', /if \(t\) \{ chosen = t; return t; \}/.test(bodyOf('whatHere') || '')
  && /updateActionRings\(P\.view === 'follow' \? followedPerson\(\) : null\);/.test(html));

/* Let go of, they do what somebody in their shoes would. */
check('let go with a full load or an animal, they take it home',
  /if \(load >= cap \* 0\.85 \|\| kind === 'game'\) \{ p\.goingHome = true; return 'home'; \}/.test(bodyOf('carryOn') || ''));
check('and with room left, they go on with what they were doing',
  /p\.orders = kind === 'fish' \? 'fish' : kind === 'wood' \? 'wood' : \(p\.bag\?\.ore > 0 \? 'quarry' : 'gather'\);/.test(bodyOf('carryOn') || ''));
check('but an order or a walk home is what they were told, not what they would do',
  /if \(p\.led\) releaseLead\(false, false\);\s*p\.orders = null;\s*p\.goingHome = true;/.test(html));

/* Danger, for the person you are playing. */
check('a tiger in sight is on screen, which way and how far',
  /predatorNear\(p\.x, p\.z, watchRange\(\)\)/.test(bodyOf('updateDanger') || '')
  && /Math\.atan2\(side, fore\)/.test(bodyOf('updateDanger') || ''));
check('and you see less far at night',
  /DANGER\.far \* \(DANGER\.night \+ \(1 - DANGER\.night\) \* daylight\(\)\)/.test(bodyOf('watchRange') || ''));
check('and it says when it has chosen them', /hunting\(t\.animal, p\)/.test(bodyOf('updateDanger') || ''));
check('Z takes cover: a tree if there is one, the ground if not',
  /if \(P\.view === 'follow' && ev\.code === 'KeyZ'\)/.test(html)
  && /p\.climbed = a\.tree;/.test(bodyOf('startAct') || '') && /p\.hiding = true;/.test(bodyOf('startAct') || ''));
check('a tiger does not choose somebody up a tree, or somebody hidden until nearly on them',
  /if \(p\.climbed\) continue;/.test(html) && /if \(p\.hiding && dist > h\.seesPeople \* 0\.25\) continue;/.test(html));
check('and one already after them gives up',
  /\|\| d\.prey\.person\.climbed/.test(html) && /d\.prey\.person\.hiding && Math\.hypot\(d\.prey\.person\.x - d\.x, d\.prey\.person\.z - d\.z\) > 12/.test(html));
check('and the numbers wildlife.js writes out are the ones danger.js names',
  Number(html.match(/HIDE_SEEN = ([\d.]+);/)?.[1]) === 0.25 && Number(html.match(/HIDE_LOST = (\d+);/)?.[1]) === 12);
check('up a tree they stay up it, and are drawn up it',
  /if \(p\.climbed\) return;/.test(bodyOf('steerFollowed') || '') && /\+ bounce \+ \(p\.lift \|\| 0\), p\.z\);/.test(html));
check('E throws at a tiger before anything else',
  /const FIRST = \['fight',/.test(html) && /what: 'fight'/.test(bodyOf('actionTargets') || ''));
check('a hit kills it and is worth a line; a miss brings it on',
  /logEvent\('slain'/.test(bodyOf('throwSpear') || '') && /a\.prey = \{ kind: 'person', person: p \};/.test(bodyOf('throwSpear') || '')
  && /'slain',/.test(html.slice(html.indexOf('MILESTONES = new Set'), html.indexOf('MILESTONES = new Set') + 900)));
check('how they are is one bar, life, with a number out of a hundred',
  /const c = condition\(p\);/.test(bodyOf('vitalsHtml') || '') && /<u>life<\/u>/.test(bodyOf('vitalsHtml') || '')
  && /'<strong>' \+ c\.life \+ '<\/strong>'/.test(bodyOf('vitalsHtml') || '')
  && /const life = Math\.round\(clamp\(p\.life \?\? startLife\(p\), 0, 1\) \* 100\);/.test(bodyOf('condition') || '')
  && !/function vbar/.test(html));
check('and it says what to do about it', /hint = 'worn out — eat \(N\) or rest \(X\)';/.test(bodyOf('condition') || '')
  && /hint = 'cold out here — get home';/.test(bodyOf('condition') || ''));
check('walking, running, working, carrying and the cold all wear it down',
  /\(LIFEBAR\.walk \* walk \+ LIFEBAR\.run \* run\) \* \(1 \+ clamp\(loadFrac, 0, 1\)\)/.test(bodyOf('spendLife') || '')
  && /p\.acting \? LIFEBAR\.work : 0/.test(bodyOf('spendLife') || '')
  && /LIFEBAR\.cold \* \(1 - \(p\.cold \?\? 1\)\)/.test(bodyOf('spendLife') || ''));
check('running costs more than walking, and walking more than standing', (() => {
  const L = html.slice(html.indexOf('const LIFEBAR = {'), html.indexOf('const LIFEBAR = {') + 900);
  const n = (k) => Number(L.match(new RegExp('\\s' + k + ': ([\\d.]+),'))?.[1]);
  return n('run') > n('walk') && n('walk') > n('idle') && n('idle') > 0 ? true : [n('idle'), n('walk'), n('run')].join(' ');
})() === true);
check('resting wins some back but never fills it; a meal wins more', (() => {
  const cap = html.match(/restCap: \{ out: ([\d.]+), home: ([\d.]+) \}/);
  const meal = Number(html.match(/meal: ([\d.]+),\s*\/\/ life a meal/)?.[1]);
  const rest = html.match(/rest: \{ out: ([\d.]+), home: ([\d.]+) \}/);
  if (!cap || !rest || !meal) return 'no LIFE';
  return Number(cap[2]) < 1 && Number(cap[1]) < Number(cap[2]) && Number(rest[1]) < Number(rest[2])
    && meal > Number(rest[2]) * 30 && /p\.life = clamp\(life \+ LIFEBAR\.meal \* share, 0, 1\);/.test(bodyOf('eat') || '')
    ? true : [cap[0], rest[0], meal].join(' ');
})() === true);
check('and the step spends it, for the person you are playing, and it is their energy',
  /spendLife\(p, slice, loadFrac\);/.test(html) && /want = lifeWant\(p, want\);/.test(html)
  && /if \(p\.led && p\.life != null\) p\.energy = Math\.max\(0\.05, p\.life\);/.test(html));
check('worn down they slow, and near the end cannot run',
  /if \(p\.life < LIFEBAR\.runFrom\) want = Math\.min\(want, PERSON\.walk\);/.test(bodyOf('lifeWant') || '')
  && /if \(!p\.led \|\| p\.life == null\) return want;/.test(bodyOf('lifeWant') || ''));
check('and it survives a reload',
  /lf: p\.life != null \? r2\(p\.life\) : undefined,/.test(html) && /life: Number\.isFinite\(r\.lf\) \? r\.lf : undefined,/.test(html));
/* Rest and eat, for the person you are playing. */
check('X rests and N eats, and the step does both',
  /ev\.code === 'KeyX'\) \{\s*if \(!restHere\(\)\)/.test(html) && /ev\.code === 'KeyN'\) \{\s*if \(!eatHere\(\)\)/.test(html)
  && /if \(a\.kind === 'rest'\) \{\s*p\.resting = !p\.resting;/.test(bodyOf('startAct') || '')
  && /if \(a\.kind === 'eat'\) \{\s*p\.actResult = eat\(p\);/.test(bodyOf('startAct') || ''));
check('and there are buttons for both',
  /data-act="rest"/.test(html) && /data-act="eat"/.test(html)
  && /if \(a\?\.dataset\.act === 'rest' && !restHere\(\)\)/.test(html) && /if \(a\?\.dataset\.act === 'eat' && !eatHere\(\)\)/.test(html));
check('resting, they stay where they are, sat down',
  /if \(p\.climbed \|\| p\.resting\) want = 0;/.test(html) && /else if \(p\.resting\) \{ wantCrouch/.test(html));
/* Crawl, throw, and what is brought down. */
check('down low they crawl, and nothing grazing notices them',
  /else if \(p\.hiding\) want = Math\.min\(want, PERSON\.walk \* CRAWL\);/.test(html)
  && /if \(!led\) threats\.push\(camera\.position\.x, camera\.position\.z\);\s*else if \(!led\.hiding\) threats\.push\(led\.x, led\.z\);/.test(bodyOf('collectThreats') || '')
  && /if \(leadRunning\(\)\) p\.hiding = false;/.test(bodyOf('steerFollowed') || ''));
check('and a crawl is slow', (() => { const c = Number(html.match(/const CRAWL = ([\d.]+);/)?.[1]); return c > 0 && c < 0.6; })());
check('a throw from down low is surer', /\(p\.hiding \? THROW\.stalk : 1\)\);/.test(bodyOf('throwSpear') || '')
  && Number(html.match(/stalk: ([\d.]+) \}/)?.[1]) > 1);
check('a spear brings it down where it stood, rather than straight into the basket',
  /a\.carcass = \{ until: simDay \+ CARCASS_DAYS, fall: -0\.5 \};/.test(bodyOf('throwSpear') || '')
  && !/bagAdd\(/.test(bodyOf('throwSpear') || ''));
check('and it lies there, still, until it is picked up — and does not come back to life meanwhile',
  /if \(d\.carcass && drawCarcass\(d, i, spec, model, parts, slice\)\) continue;/.test(html)
  && /_eAnim\.set\(0, d\.yaw, f \* Math\.PI \/ 2, 'YXZ'\);/.test(bodyOf('drawCarcass') || '')
  && /\(a\) => a\.dead && !a\.carcass/.test(bodyOf('repopulate') || ''));
/* Births come at the herd's own rate however long a step is — it was one per
   call, and a call is an eighth of a day or a whole skipped night. And a
   species hunted to nothing gets a breeding pair back, or the last one taken
   is the last one there ever is. */
check('a hunted species comes back at its own rate, not one birth per update',
  /const expected = q\.regrow \* alive \* \(1 - alive \/ target\) \* days;/.test(bodyOf('repopulate') || '')
  && /for \(; due > 0; due--\)/.test(bodyOf('repopulate') || ''));
check('and one hunted to nothing is not gone for good',
  /if \(alive === 0\) \{\s*due = luck\(\) < STRAYS\.perYear \* days \/ P\.yearLength \? STRAYS\.pair : 0;/
    .test(bodyOf('repopulate') || '')
  && !/alive\.length === 0\) continue/.test(html));
check('the strays are a pair, so they can breed', /STRAYS = \{ perYear: [\d.]+, pair: 2 \}/.test(html));
check('and a newborn grazes where it was born, not where its slot last died',
  /born\.targetX = born\.x;\s*born\.targetZ = born\.z;/.test(bodyOf('repopulate') || ''));
check('E picks it up, onto the shoulder, as meat',
  /kind: 'carcass'/.test(bodyOf('actionTargets') || '') && /const FIRST = \['fight', 'carcass',/.test(html)
  && /bagAdd\(p, 'game', 1, key\);/.test(bodyOf('takeCarcass') || '')
  && /if \(a\.kind === 'carcass'\) \{ takeCarcass\(p, a\.carcass\); return; \}/.test(bodyOf('startAct') || ''));
check('the throw is drawn: the arm, and the spear in the air',
  /p\.threw = \{ fromX: p\.x, fromZ: p\.z,/.test(html) && /if \(side === 0 && p\.throwPose > 0\) \{/.test(html)
  && /spearMesh\.quaternion\.setFromUnitVectors\(_up, _dir\);/.test(bodyOf('updateSpearFlight') || '')
  && /updateHunt\(\);/.test(html));
check('and a ring round them shows how far a spear goes, green with something inside it',
  /rangeRing\.material\.color\.setHex\(inReach \? RING_ON : RING_OFF\);/.test(bodyOf('updateThrowRange') || ''));
check('resting pays back faster, and fastest at home', (() => {
  const m = html.match(/const REST = \{\s*out: ([\d.]+),[^\n]*\n\s*home: ([\d.]+),/);
  if (!m) return 'no REST';
  return Number(m[2]) > Number(m[1]) && Number(m[1]) > 1
    && /const heal = \(p\.sick \? PLAGUE\.drag : 1\) \* restBoost\(p\);/.test(html) ? true : m[0];
})() === true);
check('and only for somebody sat down on purpose: the band rest as they always have',
  /return p\.resting \? \(atHome\(p\) \? REST\.home : REST\.out\) : 1;/.test(bodyOf('restBoost') || ''));
check('and an illness passes quicker resting at home',
  /p\.sick -= days \* \(p\.tended \? 1 \+ PLAGUE\.nurse : 1\) \* restHeal\(p\);/.test(html));
check('a meal is out of the store at home, out of the basket anywhere',
  /if \(atHome\(p\) && p\.camp\.food >= EAT\.meal\) \{\s*p\.camp\.food -= EAT\.meal;/.test(bodyOf('eat') || '')
  && /ate = eatFromBag\(p, EAT\.meal\);/.test(bodyOf('eat') || ''));
const MEAL = (() => {
  const src = sources[srcFiles.indexOf('bag.js')];
  try { return src ? new Function(src + '\nreturn { eatFromBag };')() : null; } catch { return null; }
})();
check('a meal out of the basket is berries first, and comes off the haul', (() => {
  if (!MEAL) return 'no bag.js';
  const p = { haul: 0.5, carry: 1, bag: { fruit: 0, berries: 20, fish: 2, game: 0, animal: null, ore: 0, oreKind: null } };
  const ate = MEAL.eatFromBag(p, 0.3);
  return Math.abs(ate - 0.3) < 1e-9 && p.bag.berries === 5 && p.bag.fish === 2 && Math.abs(p.haul - 0.2) < 1e-9
    ? true : JSON.stringify([ate, p]);
})() === true);
check('and an empty basket is no meal', (() => {
  if (!MEAL) return 'no bag.js';
  const p = { haul: 0, carry: 0, bag: { fruit: 0, berries: 0, fish: 0, game: 0, animal: null, ore: 3, oreKind: 'stone' } };
  return MEAL.eatFromBag(p, 0.3) === 0 && p.bag.ore === 3;
})());
check('the bubbles are small and see-through',
  /float wide = clamp\(1\.8 \* perMetre/.test(html) && /const BUBBLE_OPACITY = 0\.8;/.test(html)
  && /const HIDE = 'rgba\(248, 243, 231, 0\.55\)';/.test(html));
check('and night and winter in the open make resting do less — for the person you are playing only',
  /if \(!p\.led \|\| inCamp\(p\.x, p\.z, 0\)\) return 1;/.test(bodyOf('coldFactor') || ''));
check('every tree is kept where it stands, so one can be climbed', /treeSpots\.push\(\{ x, z \}\);/.test(html));

check('the panel lists the bands still living',
  /if \(c\.gone\) return '';/.test(html.slice(html.indexOf('function renderTribes'), html.indexOf('function drawTribeChart'))));

/* -------------------------------------------------------------------------
   A ring where you pointed

   From behind somebody's shoulder at three metres, a person setting off looks
   the same whichever way they were going to go anyway — so the only evidence a
   click landed was that something moved.
   ------------------------------------------------------------------------- */
check('the point they are walking to is marked',
  /export function updateLeadMark\(\)/.test(html.replace(/^export /gm, 'export '))
  || /function updateLeadMark\(\)/.test(html));
check('and it is only there while somebody is being led',
  /if \(!p \|\| !p\.led \|\| steering\) \{ if \(leadMark\) leadMark\.visible = false; return; \}/.test(html));
/* And nothing is built until there is something to mark. three.js gives every
   geometry, material and object a UUID out of Math.random, so a mesh made on
   the first frame regardless is a feature nobody has used yet spending draws —
   which in the boot harness, where Math.random is pinned so a seed replays,
   built a different island. */
check('and nothing is built for a click that never happened', (() => {
  const body = bodyOf('updateLeadMark');
  if (!body) return 'no updateLeadMark';
  return body.indexOf('if (!p || !p.led)') < body.indexOf('leadMarker()')
    ? true : 'the mesh is made before it is known to be wanted';
})() === true);
/* Sitting exactly on the ground z-fights with the terrain, which reads as the
   marker flickering rather than as a marker. */
check('it sits just clear of the ground',
  /sampleHeight\(p\.leadX, p\.leadZ\) \+ 0\.08/.test(html));
/* On the scene, not the world: disposeWorld empties the world's groups when a
   new island is built, and this belongs to the camera rather than the island. */
check('and it survives a new world being built', (() => {
  const body = bodyOf('leadMarker');
  return body && /scene\.add\(leadMark\);/.test(body) && !/world\.add\(leadMark\)/.test(html)
    ? true : 'the marker is added to the world, which is disposed';
})() === true);
check('and it is drawn every frame, from the one thing that runs every frame',
  /export function moveCamera\(dt\) \{\s*updateLeadMark\(\);/.test(html.replace(/^export /gm, 'export '))
  || /function moveCamera\(dt\) \{\s*updateLeadMark\(\);/.test(html));
check('Q gives them back',
  /if \(P\.view === 'follow' && ev\.code === 'KeyQ'\) \{\s*if \(tooHeavyToSend\(followedPerson\(\)\)\) return;\s*if \(!releaseLead\(\)\)/.test(html)
  && /function releaseLead\(announce = true, natural = true\)/.test(html));
/* Read before `keys` sees the key: in Orbit Q and E move the rig, and letting go
   of somebody must not also lower the camera. */
check('and letting go does not also move the camera', (() => {
  const q = html.indexOf("if (P.view === 'follow' && ev.code === 'KeyQ')");
  const e = html.indexOf("if (P.view === 'follow' && ev.code === 'KeyE')");
  const k = html.indexOf('keys.add(ev.code);');
  return q > 0 && e > 0 && k > q && k > e ? true : 'Q or E is handled after keys.add';
})() === true);
check('and shift and W is running forward now, not letting go',
  !/ev\.code === 'KeyW' && ev\.shiftKey/.test(html));
check('and they pick up their own life again',
  /p\.led = false;\s*p\.state = 'idle';\s*p\.timer = 0;/.test(html));

/* Nothing else may steer somebody who is being led. A person who obeys most of
   the time is worse than one who cannot be steered at all — you never know
   which of your instructions took. */
check('nothing else steers them while they are led', (() => {
  const want = [
    ["the tiger they'd run from", /if \(!p\.led && !p\.asleep && p\.panic <= 0 && nearestPredator/],
    ['dusk sending them home', /if \(!p\.led && day < 0\.25 && p\.job !== 'sleep'/],
    ['the errand timer', /if \(p\.timer <= 0 && \(!p\.led \|\| p\.acting\)\) \{/],
    ['waking them for the day', /if \(day >= 0\.25 && p\.job === 'sleep' && !p\.led\)/],
  ];
  const missing = want.filter(([, re]) => !re.test(html)).map(([n]) => n);
  return missing.length ? `still steered by: ${missing.join(', ')}` : true;
})() === true);
/* But everything that is not steering still runs: led is a hand on the
   shoulder, not a shield. The books do not know about it at all. */
check('but being led is not a shield', (() => {
  const lives = bodyOf('updateLives');
  const econ = bodyOf('updateEconomy');
  return !/\.led/.test(lives || '') && !/\.led/.test(econ || '')
    ? true : 'the books check for it';
})() === true);
check('and a tiger does not know about it either', (() => {
  const body = bodyOf('nearestQuarry');
  return body && !/\.led/.test(body) ? true : 'nearestQuarry checks for it';
})() === true);

/* The other half of the same question. A figure on screen can be clicked; the
   person you want is often the one who is *not* on screen — indoors, asleep, or
   over a hill — and the band card is the list of exactly those. */
check('a name on the band card follows that person',
  /\$\('tribeList'\)\?\.addEventListener\('click'/.test(html)
  && /if \(followPersonById\(Number\(row\.dataset\.p\)\)\) closeTribe\(\);/.test(html));
/* The card is built from a filtered, re-sorted copy of `people`, and a death
   renumbers the array under it. A row index would follow the wrong person. */
check('and it goes by who they are, not where they are',
  /data-p="\$\{p\.id\}"/.test(html)
  && /const idx = people\.findIndex\(\(p\) => p\.id === id\);/.test(html));
check('the rows are the living ones only', (() => {
  // formerTable is the "who is gone" tab. Nothing there is followable.
  const i = html.indexOf('function formerTable');
  const body = html.slice(i, html.indexOf('function renderTribeCard'));
  return i > 0 && !/data-p=/.test(body);
})());
/* The listener cannot live on the rows: they are rewritten every time somebody
   is born, dies, falls ill or changes job. */
check('and it survives the list being rewritten',
  /\$\('tribeList'\)\?\.addEventListener/.test(html)
  && /row = ev\.target\?\.closest\?\.\('tr\[data-p\]'\)/.test(html));

/* A suggestion and a choice are different things, and only one of them may be
   overruled. Follow hands you off a sleeper because staring at a hut looks like
   the mode is broken — but if you picked the sleeper by name, it is not. */
check('F offers you somebody; a click or a name chooses one',
  /followChosen = false;/.test(html) && /followChosen = true;/.test(html));
check('and somebody you chose is not handed away while they are indoors',
  /if \(p && !followChosen && p\.asleep && people\.some\(\(o\) => !o\.asleep\)\)/.test(html));

/* -------------------------------------------------------------------------
   F does not hand you an empty tent

   It asked for `!asleep`, which is narrower than being visible: a person can be
   wide awake and inside a hut — knapping, sitting with the ill, or a toddler
   kept in — and F would land on them. The caption read "knapping" and the
   screen showed a hut, which is what the mode being broken looks like.
   ------------------------------------------------------------------------- */
/* An adult on an errand first, and everybody on screen after that. On a fed
   island a third of a band is under fourteen, and what a child does is play,
   run about, sit at the fire and sleep — so F landed on one four times out of
   five, which is F not working rather than F being unlucky. */
check('F looks for somebody doing something first',
  /if \(i !== followIdx && !q\.hidden && !q\.child && !IDLE_JOBS\.has\(q\.job\)\) pool\.push\(i\);/.test(html));
check('and falls back to anybody on screen',
  /if \(i !== followIdx && !people\[i\]\.hidden\) pool\.push\(i\);/.test(html));
/* F is "show me somebody", and showing you the person you are already looking
   at is F doing nothing — which is what narrowing the pool did the moment a
   band had exactly one adult on an errand. */
check('and never on the one you are already behind',
  (html.match(/i !== followIdx/g) || []).length >= 2);
/* Not a judgement about the person: somebody asleep is doing the most important
   thing they will do all day. F is a request to be shown something. */
check('the errands with nothing to watch are named once',
  /const IDLE_JOBS = new Set\(\['play', 'tend', 'sleep'\]\);/.test(html));
/* Sitting with somebody who is ill looks like sitting down and is the most
   interesting thing in a camp with a sickness in it. */
check('and sitting with the ill is not one of them',
  !/IDLE_JOBS = new Set\(\[[^\]]*'nurse'/.test(html));
check('and asks the draw loop rather than guessing again', (() => {
  const body = bodyOf('pickFollow');
  if (!body) return 'no pickFollow';
  // asleep may only appear as the fallback, never as the first test.
  return body.indexOf('.hidden') < body.indexOf('.asleep') ? true : 'asleep is still the test';
})() === true);
/* Refusing to pick anybody is worse than picking badly: a camp can genuinely be
   all indoors — a wet afternoon, or three in the morning — and F still has to
   do something. */
check('but it always picks somebody', (() => {
  const body = bodyOf('pickFollow');
  if (!body) return 'no pickFollow';
  const falls = (body.match(/if \(!pool\.length\)/g) || []).length;
  return falls === 3 ? true : `${falls} fallbacks, wanted 3`;
})() === true);
check('and the last fallback takes anyone at all',
  /if \(!pool\.length\) for \(let i = 0; i < people\.length; i\+\+\) pool\.push\(i\);/.test(html));

group('a tiger with a stomach');

/* To the end of the species list, rather than a fixed number of characters.
   It was 2800, which left the last number it reads sitting 28 characters from
   falling off the end — and the moment the tiger grew two more hunting
   numbers, three checks started reading NaN instead of failing honestly. The
   tiger is the last species, so the list's own closing bracket is the edge. */
const tigerAt = html.indexOf("key: 'tiger'");
const hunt = html.slice(tigerAt, html.indexOf('];', tigerAt));
const num = (k) => Number((hunt.match(new RegExp(k + ': ([\\d.]+)')) || [, NaN])[1]);
check('a meal is worth more than the threshold to start hunting',
  num('meal') > num('hunts'), `meal ${num('meal')} vs hunts ${num('hunts')}`);
check('a person is a smaller meal than an animal',
  num('person') < num('meal'), `person ${num('person')} vs ${num('meal')}`);

/* -------------------------------------------------------------------------
   ...and hunts them a good deal less than it hunts a deer

   Preferring four legs only helps when four legs are in sight, and on an island
   this size they usually are not: a couple of hundred animals over 900 metres
   is under one animal inside the 62-metre circle a tiger sees a deer in. So a
   person alone in an empty stretch was simply the best thing on offer, from as
   far off as a deer, and 11 of 14 deaths on seed 20260906 were tigers.
   ------------------------------------------------------------------------- */
check('a tiger picks a deer out of the landscape further off than a person',
  num('seesPeople') < num('sees'), `sees ${num('sees')} vs seesPeople ${num('seesPeople')}`);
/* And people have to notice it before it notices them, or running is a thing
   they start doing too late for it to be worth anything. */
check('and people notice it before it notices them', (() => {
  const sees = Number((html.match(/sees: (\d+),\s+\/\/ metres at which somebody notices a tiger/) || [, 0])[1]);
  return sees > num('seesPeople');
})(), `PANIC.sees vs seesPeople ${num('seesPeople')}`);
/* The rule this file always claimed and never implemented. */
check('it will not take somebody who has company',
  /if \(hasCompany\(p, h\.company\)\) continue;/.test(html)
  && num('company') > 0, `within ${num('company')}m`);
check('and company means somebody awake and out there with them',
  /function hasCompany\(p, within\)/.test(html)
  && /if \(q === p \|\| q\.asleep\) continue;/.test(html));
/* None of which makes anyone safe: the bold go furthest, get there first, and
   are alone when they do. */
check('the range it hunts people in is still a real distance',
  num('seesPeople') > num('reach'), `${num('seesPeople')}m vs a reach of ${num('reach')}m`);

/* The one that did most of the work. Hungry enough to hunt and hungry enough to
   take a person are different states, and there has to be a stretch between
   them — otherwise "prefers animals" only ever means "prefers an animal that
   happens to be standing there", and most of the time none is. */
check('hunting and being desperate are not the same hunger',
  num('desperate') < num('hunts'),
  `starts hunting at ${num('hunts')}, counts people at ${num('desperate')}`);
check('and a tiger that is merely hungry does not consider people at all',
  /if \(d\.fed > h\.desperate\) return best;/.test(html));
/* It has to be reachable, or the tiger is scenery. A stomach empties over
   `lasts` days, so anything above zero is a state it gets to by hunting badly. */
check('but it is a state a bad hunter reaches',
  num('desperate') > 0, `${num('desperate')} of a full stomach`);
/* The order matters: animals are scored before the early return, so a desperate
   tiger with a deer in sight still takes the deer. */
check('and even then four legs still win', (() => {
  const i = html.indexOf('function nearestQuarry');
  const body = html.slice(i, i + 1600);
  return i > 0
    && body.indexOf("kind: 'animal'") < body.indexOf('if (d.fed > h.desperate) return best;');
})());
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
  !/new THREE\.BoxGeometry\(\.\.\.spec\.body\)/.test(html)
  && /torsoRings\(sex === 'f' \? 'torsoFemale' : 'torsoMale'\)/.test(looksSrc) && /roundBox\(\.\.\.spec\.body\)/.test(html));

/* The body is the humans-threejs model, read here the way the page reads it:
   plain arrays, no three.js. What the torso used to be tested for as a lathe
   profile it is now tested for as a shape — wide at the hips, narrow at the
   waist, wide again at the chest — and there are two of them to test. */
const { pathToFileURL: fileUrl } = await import('node:url');
const { HUMAN_PARTS, HUMAN_JOINTS } = await import('humans-threejs/human-parts.js');
const ringsOf = (key) => {
  const a = HUMAN_PARTS[key].positions, by = new Map();
  for (let i = 0; i < a.length; i += 3) {
    const y = a[i + 1].toFixed(3);
    by.set(y, Math.max(by.get(y) || 0, Math.abs(a[i])));
  }
  return [...by].map(([y, r]) => [Number(y), r]).sort((p, q) => p[0] - q[0]);
};
for (const key of ['torsoMale', 'torsoFemale']) {
  const R = ringsOf(key);
  const waist = R.slice(1, -1).reduce((m, q) => (q[1] < m[1] ? q : m));
  const hips = Math.max(...R.filter((q) => q[0] < waist[0]).map((q) => q[1]));
  const chest = Math.max(...R.filter((q) => q[0] > waist[0]).map((q) => q[1]));
  check(`${key}: there is a waist between the hips and the chest`,
    waist[1] < hips && waist[1] < chest, JSON.stringify(R));
  check(`${key}: and it is a waist, not a pinch`, waist[1] > hips * 0.6 && waist[1] > chest * 0.6,
    `waist ${waist[1]} against hips ${hips} and chest ${chest}`);
  const a = HUMAN_PARTS[key].positions;
  let wide = 0, deep = 0;
  for (let i = 0; i < a.length; i += 3) { wide = Math.max(wide, Math.abs(a[i])); deep = Math.max(deep, Math.abs(a[i + 2])); }
  check(`${key}: a chest is wider across than front to back`, wide > deep, `${wide} by ${deep}`);
}
check('the two torsos are two shapes',
  HUMAN_PARTS.torsoMale.positions.some((v, i) => v !== HUMAN_PARTS.torsoFemale.positions[i]));
/* The package, not a copy of it: installed from GitHub on its main branch, so
   the model on the island is whatever was last pushed there. */
const partsSrc = readFileSync(join(ROOT, 'node_modules', 'humans-threejs', 'human-parts.js'), 'utf8');
check('the model is plain data: nothing imported, nothing fetched',
  !/^import /m.test(partsSrc) && !/fetch\(|await /.test(partsSrc));
check('it comes from the humans-threejs package, not from a copy in src/',
  !existsSync(join(SRC, 'human-parts.js'))
  && srcFiles.every((f) => !/from '\.\/human-parts\.js'/.test(moduleSource(f)))
  && ['clock.js', 'people.js', 'looks.js'].every((f) => moduleSource(f).includes("from 'humans-threejs/human-parts.js'")));
check('the page finds it where npm put it',
  html.includes('"humans-threejs/": "./node_modules/humans-threejs/"'));
const deps = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies || {};
check('installed from its GitHub repository, following main',
  deps['humans-threejs'] === 'github:mudiadamz/humans-threejs#main', JSON.stringify(deps));
check('and without the three.js it lists as a peer, which the page gets from its CDN',
  /^omit=peer$/m.test(readFileSync(join(ROOT, '.npmrc'), 'utf8')));
check('the page takes every piece of a body from the model',
  /const body = \(key\) => \{[\s\S]{0,200}?HUMAN_PARTS\[key\]\.positions\.slice\(\)/.test(html)
  && ['neck', 'head', 'upperArm', 'forearm', 'hand', 'thigh', 'calf', 'foot']
    .every((k) => html.includes(`body('${k}')`)));

/* A grown woman has the woman's torso, and the joints follow the torso: arms
   from its shoulders, legs from its hips. The other torso is parked in the
   same frame, every frame, because the slot may have been somebody else's. */
check('a grown woman wears the woman\'s hide, cut from the woman\'s torso',
  /const woman = p\.sex === 'f' && !p\.child;[\s\S]{0,60}?const tunic = wear\(p, 'tunic', tunicKey\(p, woman\)\);/.test(moduleSource('move.js'))
  && /tunicKey = \(p, woman\) => `tunic:\$\{woman \? 'f' : 'm'\}:\$\{lookOf\(p\)\.build\}`/.test(looksSrc));
check('and her arms and legs hang from its joints',
  /const armX = \(woman \? S\.armXF : S\.armX\) \* p\.shoulder \* fit\.armX;/.test(moduleSource('move.js'))
  && /const hipX = \(woman \? S\.hipXF : S\.hipX\) \* p\.hip \* fit\.hipX;/.test(moduleSource('move.js'))
  && /setPosition\(dir \* armX, S\.shoulderY, 0\)/.test(moduleSource('move.js'))
  && /setPosition\(dir \* hipX, 0, 0\)/.test(moduleSource('move.js')));
check('which are the model\'s, not numbers of our own',
  /hipX: MODEL\.hip\[0\], hipXF: MODEL_F\.hip\[0\]/.test(html)
  && /armX: MODEL\.shoulder\[0\], armXF: MODEL_F\.shoulder\[0\]/.test(html));
check('and a woman\'s shoulders are narrower and her hips wider',
  HUMAN_JOINTS.female.shoulder[0] < HUMAN_JOINTS.male.shoulder[0]
  && HUMAN_JOINTS.female.hip[0] > HUMAN_JOINTS.male.hip[0]);

/* Limbs in two pieces. This is most of what separates a figure from a
   mannequin, and it only works if every piece hangs from its own joint. */
for (const joint of ['upperArm', 'foreArm', 'thigh', 'shin']) {
  check(`${joint} is a limb piece, as long as the model's bone`,
    new RegExp(`${joint}: across\\('\\w+', MODEL\\.lengths\\.\\w+\\)`).test(html));
  check(`and there are two of them`, PERSON_PARTS[joint] === 2);
}
/* Joint-local: the joint is the origin, the piece hangs from it to the next
   joint down, and its rounded end reaches a little past both — which is what
   stops a bent knee opening a gap on the outside of the bend. */
const J = HUMAN_JOINTS.male;
for (const [key, len] of [['thigh', J.lengths.thigh], ['calf', J.lengths.calf],
  ['upperArm', J.lengths.upperArm], ['forearm', J.lengths.forearm]]) {
  const a = HUMAN_PARTS[key].positions;
  let top = -Infinity, bottom = Infinity;
  for (let i = 1; i < a.length; i += 3) { top = Math.max(top, a[i]); bottom = Math.min(bottom, a[i]); }
  check(`the ${key} hangs from its joint rather than its middle`,
    top > 0 && top < 0.1 && bottom < -len && bottom > -len - 0.1,
    `${top.toFixed(3)} to ${bottom.toFixed(3)} for a ${len} m bone`);
}
check('and the legs add up to the hip, so a foot stands on the ground',
  Math.abs(J.lengths.thigh + J.lengths.calf + J.ankle[1] - J.hip[1]) < 1e-6,
  `${J.lengths.thigh} + ${J.lengths.calf} + ${J.ankle[1]} against ${J.hip[1]}`);
check('the forearm hangs off the end of the upper arm',
  /_mOff\.setPosition\(0, -S\.upperArm\[1\], 0\);/.test(html));
check('and the shin off the end of the thigh',
  /_mOff\.setPosition\(0, -S\.thigh\[1\], 0\);/.test(html));
check('a hand is on the end of the forearm',
  /_mOff\.makeTranslation\(0, -S\.foreArm\[1\], 0\);/.test(html));
check('a foot is on the end of the shin, and kept level with the ground',
  /_mOff\.makeRotationX\(-\(leg \+ knee\)\);\n    _mOff\.setPosition\(0, -S\.shin\[1\], 0\);/.test(html));
check('and it sits forward of the ankle, like a foot', (() => {
  const a = HUMAN_PARTS.foot.positions;
  let front = 0, back = 0;
  for (let i = 2; i < a.length; i += 3) { front = Math.max(front, a[i]); back = Math.min(back, a[i]); }
  return front > -back * 1.5;
})());
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
/* Not a person's head any more: that is the model's, and is checked with the
   rest of the body above. */
for (const part of ['spec.head', 'spec.hump.size']) {
  check(`${part} is rounded`, html.includes(`roundBox(...${part})`));
}
for (const [what, call] of [['a spear', 'roundLimb(...p.spear)'],
                            ['a heap', 'heapGeo(...p.load)'], ['a basket', 'basketGeoFrom(...p.basket)'],
                            ['a tail', 'roundLimb(...spec.tail)'],
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

/* -------------------------------------------------------------------------
   Breeding is not planning

   A band used to have children in proportion to how full its store was, which
   is a population regulating itself and is not a thing any species does. It
   also produced a flat line: bands found a level and held it for thirty years,
   because the birth rate backed off long before the store got low enough to
   kill anybody, so the starvation machinery below never fired.

   Now they breed flat out and stop when the food is gone — by which point the
   deaths have already started. Overshoot, crash, recovery. The regulator is
   the crash.
   ------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------
   A band that has not been counted yet

   Everything a person decides to do next comes off `camp.hunger`. It was a
   literal on the camp object — 0, meaning comfortable — sitting on the same
   line as `food: 0`, which says the opposite: an empty store is `1 - 0/6` = 1,
   maximum hunger. The literal stood until the first book-keeping pass an eighth
   of a day later, and every person picks their first job within six seconds of
   the world existing, so the whole band chose against a number nobody had
   worked out. At hunger 0 the weights send 21% outside; at hunger 1, 96%. A new
   band sat down round a fire it had nothing to cook on.

   Restoring was worse, because it never corrected: the save carries `food` and
   not `hunger`, so a reloaded band reported the hunger its camp was *built*
   with whatever it came back to.
   ------------------------------------------------------------------------- */
group('opening the books');

check('a camp with an empty store is a hungry camp', (() => {
  const bad = [];
  for (const m of html.matchAll(/food: 0, pop: 0, need: 0, hunger: ([\d.]+),/g)) {
    if (Number(m[1]) !== 1) bad.push(`hunger ${m[1]} beside food 0`);
  }
  return bad.length ? bad.join(' · ') : true;
})() === true);
/* Both places a camp is made: at world build and when a band splits off. */
check('in both places a camp is made',
  (html.match(/food: 0, pop: 0, need: 0, hunger: 1,/g) || []).length === 2,
  `${(html.match(/food: 0, pop: 0, need: 0, hunger: 1,/g) || []).length} of 2`);
/* And the literal is not trusted at all: the books are opened once before
   anybody moves, so hunger is worked out rather than assumed. A `days` of zero
   eats nothing and spoils nothing. */
check('and the books are opened before anybody picks a job', (() => {
  const build = html.indexOf('function buildWorld');
  if (build < 0) return 'no buildWorld';
  const body = html.slice(build, build + 1800);
  return /updateEconomy\(0\);/.test(body) ? true : 'buildWorld never opens them';
})() === true);
/* The restore reads the store back and has to work the hunger out from it. */
check('and again after coming back to a saved world', (() => {
  const restore = html.indexOf('camps[i].food = c.food;');
  if (restore < 0) return 'no restore';
  /* A window, not a rule about distance: the restore reads the flock and a
     basket's vegetables back too, and the call is still in the same function. */
  return /updateEconomy\(0\);/.test(html.slice(restore, restore + 4000))
    ? true : 'the store is restored but the hunger is not';
})() === true);

group('breeding flat out');

check('births run at the full rate or not at all',
  /const plenty = daysOfFood\(camp\) > FOOD\.breedsUntil \? 1 : 0;/.test(html));
/* If it were still proportional there would be a division by `comfortable` in
   the birth rate, which is what made the line flat. */
check('and nothing tapers them off as the store falls',
  !/plenty = clamp\(daysOfFood/.test(html));
/* The stop has to come after the starving has begun, or it is restraint again
   in a different costume. hunger is 1 - days/comfortable, and people start
   losing their ceiling at STARVE_FROM. */
check('and they stop only once the band is already starving', (() => {
  const comfortable = Number((html.match(/comfortable: ([\d.]+),/) || [, 0])[1]);
  const breedsUntil = Number((html.match(/breedsUntil: ([\d.]+),/) || [, 0])[1]);
  const starveFrom = Number((html.match(/STARVE_FROM = ([\d.]+);/) || [, 0])[1]);
  // Hunger at the moment the last child is born.
  const hungerThen = 1 - breedsUntil / comfortable;
  return hungerThen > starveFrom
    ? true
    : `hunger ${hungerThen.toFixed(2)} at the last birth, starving starts at ${starveFrom}`;
})() === true);
/* And it is not zero, or a band breeds into a literally empty store on the
   step before everybody's ceiling hits the floor. */
check('but not so late that the last child is born into nothing',
  Number((html.match(/breedsUntil: ([\d.]+),/) || [, 0])[1]) > 0);
/* The crash was always there; only the birth rate stopped it arriving. These
   three still key off `comfortable`, and have to, or there is no crash. */
check('the machinery of the crash is untouched',
  /c\.hunger = clamp\(1 - daysOfFood\(c\) \/ FOOD\.comfortable, 0, 1\);/.test(html)
  && /hunger: LIFE\.hungerMortality \* hunger \* hunger,/.test(html)
  && /p\.camp\.hunger > STARVE_FROM/.test(html));
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
/* Descent is reckoned through the father, and the band card is where it is
   read. It used to be on the follow caption as well — "daughter of Bresher",
   "3rd of the Lohae line", and the chain of fathers under them — three ways of
   saying one thing, on screen whether or not anybody asked, and the half of
   that caption that cannot change while you watch somebody. */
check('a child takes its father\'s line', /child\.line = father\.line \|\| father\.name/.test(html));
check('and is one generation deeper in it', /child\.gen = \(father\.gen \|\| 1\) \+ 1/.test(html));
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
check('and the walk uses it', /if \(step > 0 && !\(p\.onRaft \? raftStep\(p, step\) : stepPerson\(p, step\)\)\)/.test(html));
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
  /if \(p\.job !== 'visit' && !p\.onRaft\) pickWork\(p\);/.test(html));

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

/* A tenth of a unit of berries is still something in their arms. It used to be
   a number rounded to one place; it is counted things now, and the berries and
   the catch are counted at least one apiece, so a small haul still says it is
   something — and "food" when nothing was counted at all. */
check('a small haul is not rounded away to nothing',
  /bagAdd\(p, 'berries', Math\.max\(1,/.test(html) && /bagAdd\(p, 'fish', Math\.max\(1,/.test(html)
  && /\$\{bagWords\(p\.bag\) \|\| 'food'\}/.test(caption));

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

/* npm start watches and reloads; npm run serve and the Windows service do not.
   The service runs `node server.js` directly, so the thing that must never
   happen is the reload leaking into a plain run. */
const devSrc = readFileSync(join(ROOT, 'dev.js'), 'utf8');
const watched = (devSrc.match(/WATCHED = new Set\(\[[^\]]*\]\)/) || [''])[0];
check('npm start is the development server, npm run serve the plain one',
  pkg.scripts.start === 'node dev.js' && pkg.scripts.serve === 'node server.js', JSON.stringify(pkg.scripts));
check('a change to .env restarts it, because settings are only read at startup',
  watched.includes("'.env'"), watched);
check('and so does a change to the page or the server',
  ['index.html', 'server.js', 'config.js', 'db.js'].every((f) => watched.includes(`'${f}'`))
  && /WATCHED_DIRS = \['src'\]/.test(devSrc), watched);
check('but not the chronicle, which is written every simulated day', !/chronicle/.test(watched));
check('it passes its arguments on, so --port still works',
  /spawn\(process\.execPath, \[join\(ROOT, 'server\.js'\), \.\.\.args\]/.test(devSrc));
check('the reload is only offered in dev',
  /const DEV = Boolean\(process\.env\.DEV_RELOAD\);/.test(serverSrc)
  && /if \(DEV && path === '\/__dev\/reload'\)/.test(serverSrc)
  && /\+ \(DEV \? DEV_SCRIPT : ''\)\);/.test(serverSrc));
check('and the service never asks for it',
  !/DEV_RELOAD/.test(readFileSync(join(ROOT, 'deploy', 'service.ps1'), 'utf8')));
/* The model is followed on its main branch: each npm start installs it by its
   spec again, which makes npm look the branch up — a plain install would only
   reinstall what the lockfile last wrote down. Done before the watchers exist,
   and a lockfile event only restarts when the model it names has moved: the
   first try restarted every start, on the lockfile its own install wrote. */
check('npm start asks for the newest model before the server starts',
  /\['install', [^\]]*`humans-threejs@\$\{spec\}`\]/.test(devSrc)
  && devSrc.indexOf('updateModel();') < devSrc.indexOf('watch(ROOT,')
  && devSrc.indexOf('updateModel();') < devSrc.lastIndexOf('start();'));
check('and only a model that actually moved restarts it',
  watched.includes("'package-lock.json'") && /if \(now === modelAt\) return;/.test(devSrc));
check('npm run model fetches it without starting anything',
  pkg.scripts.model === 'npm install --no-audit --no-fund humans-threejs@github:mudiadamz/humans-threejs#main');
check('a restart is not held up by a page still listening for it',
  /for \(const stream of devStreams\) stream\.end\(\);\n\s*listening\.close\(/.test(serverSrc));

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

/* -------------------------------------------------------------------------
   What is worth telling

   The chronicle keeps everything and everything is mostly hunting. Twelve lines
   of panel fill with kills inside a minute, so the day a band worked out how to
   cure meat goes past between two rabbits. Measured on one real world: of 655
   lines, 238 were kills. The one that mattered — three bands splitting away —
   was three.
   ------------------------------------------------------------------------- */
group('worth telling');

const MILE = (() => {
  const m = html.match(/MILESTONES = new Set\(\[([\s\S]*?)\]\)/);
  return m ? [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]) : [];
})();
check('the band\'s own history is kept', (() => {
  const want = ['learned', 'lost', 'split', 'joined', 'moved', 'extinct'];
  const missing = want.filter((k) => !MILE.includes(k));
  return missing.length ? `missing ${missing.join(', ')}` : true;
})() === true);
/* The two the ask was actually about. */
check('including what a band worked out', MILE.includes('learned') && MILE.includes('lost'));
check('and who walked off to start their own fire', MILE.includes('split'));
/* And the things that fill it up are not. */
check('a day of hunting is not', (() => {
  const noise = ['kill', 'birth', 'death', 'predator', 'forage', 'visit'];
  const leaked = noise.filter((k) => MILE.includes(k));
  return leaked.length ? `${leaked.join(', ')} kept` : true;
})() === true);

/* -------------------------------------------------------------------------
   Quarries

   Deposits laid out with the island, five kinds of rock in the quantities they
   come in, each the size of what is left in it, and dug a trip at a time.
   ------------------------------------------------------------------------- */
const ORES_SRC = (() => {
  const m = html.match(/const ORES = (\{[\s\S]*?\n\});/);
  try { return m ? new Function(`return ${m[1]};`)() : null; } catch { return null; }
})();
const ORE_ORDER = ['stone', 'iron', 'bronze', 'silver', 'gold'];
check('there are five kinds of rock worth digging',
  Boolean(ORES_SRC) && ORE_ORDER.every((k) => k in ORES_SRC), Object.keys(ORES_SRC || {}).join(' '));
check('and the rarer the metal, the fewer the places and the less in each', (() => {
  if (!ORES_SRC) return 'no ORES';
  for (let i = 1; i < ORE_ORDER.length; i++) {
    const a = ORES_SRC[ORE_ORDER[i - 1]], b = ORES_SRC[ORE_ORDER[i]];
    if (!(b.sites <= a.sites && b.amount[1] < a.amount[1])) return `${ORE_ORDER[i]} is not rarer than ${ORE_ORDER[i - 1]}`;
  }
  return true;
})() === true);
check('the deposits come off the world seed, not the step\'s stream',
  /const rng = mulberry32\(P\.seed \^ 0x[0-9a-f]+\);/.test(bodyOf('buildDeposits') || '')
  && !/\bluck\(\)/.test(bodyOf('buildDeposits') || ''));
check('never in a camp, and never on top of each other',
  /CAMP_CLEARING/.test(bodyOf('buildDeposits') || '') && /DEPOSIT_APART/.test(bodyOf('buildDeposits') || ''));
check('and laid out after the camp sites are chosen',
  /chooseCampSites\([^)]*\);[\s\S]{0,200}?buildDeposits\(\);/.test(html));
check('a deposit stands the size of what is left in it',
  /d\.left > 0 \? [\d.]+ \+ [\d.]+ \* Math\.cbrt\(d\.left \/ 100\) : 0/.test(bodyOf('depositRadius') || ''));
check('and shrinks as it is dug', /d\.left -= took;\s*dressDeposit\(d\);/.test(bodyOf('mineDeposit') || ''));
check('a band chooses among them rather than always the nearest',
  /const d = pickDeposit\(camp, luck, /.test(html) && !/nearestRock\(camp\.x, camp\.z/.test(html));
check('and only from the step, which is the only place that may roll',
  !/pickDeposit\(/.test(moduleSource('ui.js')) && !/pickDeposit\(/.test(moduleSource('chronicle.js')));
check('dug where they stood, and carried home',
  /const took = mineDeposit\(d, ORES\[d\.kind\]\.per \* \(1 \+ p\.camp\.skill\.mining\)\);\s*if \(took > 0\) \{ bagAdd\(p, 'ore', took, d\.kind\); p\.carry = 1; \}/.test(html));
check('and put on the pile, not in the food store',
  /storeOre\(p\.camp, p\.bag\.oreKind \|\| 'stone', p\.bag\.ore\);/.test(html));
check('the first of a metal is worth a line in the chronicle',
  MILE.includes('find') && /logEvent\('find'/.test(html));
check('a band\'s card says what it has dug', /<em>\(\$\{heldWords\(camp\)\}\)<\/em>/.test(html));
check('the quarries are on the map, sized by what is left',
  /put\('quarry', d\.x, d\.z,/.test(bodyOf('gatherMarks') || '')
  && /Math\.cbrt\(d\.left \/ 100\)/.test(bodyOf('gatherMarks') || ''));
check('with a line in the filter for every kind of rock',
  ORE_ORDER.every((k) => new RegExp(`data-layer="${k}" aria-pressed="true"`).test(html)));
check('and what is left in them survives a reload',
  /quarries: deposits\.map\(\(d\) => d\.left\),/.test(html)
  && /st\.quarries\.length === deposits\.length/.test(html));
check('and so does the pile, which it never used to',
  /stone: r2\(c\.stone \|\| 0\), ores: c\.ores \|\| undefined/.test(html) && /camps\[i\]\.stone = Number\(c\.stone\) \|\| 0;/.test(html));
check('ore comes home the colour of the rock it came out of', (() => {
  const src = moduleSource('move.js');
  const bad = ['iron', 'bronze', 'silver', 'gold'].filter((k) => {
    const hex = (src.match(new RegExp(`${k}:\\s*\\{ scale: [^}]*hex: (0x[0-9a-f]+)`)) || [])[1];
    return !hex || Number(hex) !== ORES_SRC?.[k]?.rock;
  });
  return bad.length ? `${bad.join(', ')} differ` : true;
})() === true);
/* A sickness reaching a camp is the band's news; one person catching it off
   another is not. They shared a kind, so neither could be filtered alone. */
check('a plague arriving and a person catching it are different kinds',
  /logEvent\('plague',/.test(html) && /logEvent\('sickness',/.test(html));
check('and only the first is worth telling',
  MILE.includes('plague') && !MILE.includes('sickness'));
/* Nothing is dropped: the filter is a way of looking, not a way of recording. */
check('everything is still written down', (() => {
  const i = html.indexOf('function logEvent(kind, text');
  const body = html.slice(i, i + 500);
  return i > 0 && !/MILESTONES/.test(body) ? true : 'logEvent filters at the source';
})() === true);
check('and one button gives it all back',
  /setMilestonesOnly\(!milestonesOnly\)/.test(html));
/* A funnel rather than two words. "worth telling" and "everything" are
   different lengths, so the button changed width every time it was pressed and
   shoved the search box along with it. */
check('the filter is an icon',
  /id="chronKind" aria-pressed="true" aria-label="Filter the chronicle"/.test(html)
  && /<svg viewBox="0 0 16 16"/.test(html));
/* Which must not be written over. `textContent = …` on a button whose label is
   an svg throws the svg away on the first press, and the button is empty for
   the rest of the session. */
check('and nothing writes text over it', (() => {
  const at = html.indexOf('function renderChronKind()');
  if (at < 0) return 'no renderChronKind';
  // To the end of the function, not to the next declaration: bodyOf would sweep
  // in the wiring below it, which writes plenty of text to plenty of things.
  const body = html.slice(at, html.indexOf('\n}', at));
  // An assignment, not the word: the comment in there explains why the svg
  // must not be written over, and saying so should not fail the check.
  return !/textContents*=/.test(body) ? true : 'renderChronKind sets textContent';
})() === true);
/* The icon is never the only channel: the state is in the class that fills the
   funnel, in aria-pressed, and in words in the title. */
check('its state is readable as well as visible',
  /b\.setAttribute\('aria-pressed', String\(milestonesOnly\)\);/.test(html)
  && /b\.setAttribute\('title', milestonesOnly/.test(html));
/* The panel and the window read the same flag, or they show different answers
   to the same question. */
check('the panel and the window agree on what matters',
  /const rows = milestonesOnly \? chronicle\.filter\(isMilestone\) : chronicle;/.test(html)
  && /const rows = milestonesOnly \? chronRows\.filter\(isMilestone\) : chronRows;/.test(html));

/* -------------------------------------------------------------------------
   And a band only learns a thing once

   `told` is what the band has already been announced as knowing. It is derived
   from `skill`, so it is not saved — and it was not worked out again on the way
   back in either, so it came back as the zero a fresh camp is built with and
   every reload re-announced the whole ladder. A band that had known how to cure
   meat for eighty years learnt it again, in four steps, every time the page
   reloaded: 236 of one world's 655 lines, against at most four rungs on three
   skills that can honestly be climbed.
   ------------------------------------------------------------------------- */
check('what a band has been told about itself is worked out, not stored',
  /camps\[i\]\.told\[key\] = skillTier\(camps\[i\]\.skill\[key\]\);/.test(html));
check('by the same rungs the announcement uses',
  /function skillTier\(v, told = 0\)/.test(html)
  && /const tier = skillTier\(v, told\);/.test(html));
/* Storing it would be the same fact written twice, which is how the two come
   to disagree — so the save carries skill and not told. */
check('and the save carries the mastery, not the announcement', (() => {
  const i = html.indexOf('camps: camps.map((c) => ({');
  const body = html.slice(i, i + 400);
  return i > 0 && /skill: Object\.fromEntries/.test(body) && !/told:/.test(body);
})() === true);

/* -------------------------------------------------------------------------
   Six skills, not three

   Three was not enough to make two bands different from each other: every band
   that lasted learned all of them, and "what is this band good at" had one
   answer. Six was enough that a century leaves two bands with different
   histories, and the seventh is the one that is not a technique — a band that
   buries its dead in one place and goes back to it. Each of them moves a number
   the simulation already had, because a skill that only shows on a readout is a
   readout.
   ------------------------------------------------------------------------- */
check('there are twenty of them', Object.keys(
  (() => { const m = html.match(/SKILLS = \{([\s\S]*?)\n\};/); return m ? m[1] : ''; })()
    .split('\n').filter((l) => /^\s{2}\w+: \{ label:/.test(l))
    .reduce((o, l) => (o[l.trim().split(':')[0]] = 1, o), {})
).length === 20);
check('and every one of them does something', (() => {
  const want = [
    ['spears', /SKILL\.spearChance \* p\.camp\.skill\.spears/],
    ['baskets', /SKILL\.basketHaul \* p\.camp\.skill\.baskets/],
    ['drying', /SKILL\.dryKeep \* c\.skill\.drying/],
    ['herbs', /SKILL\.herbCure \* \(p\.camp\.skill\.herbs \|\| 0\)/],
    ['tracking', /SKILL\.trackFar \* \(camp\?\.skill\?\.tracking \|\| 0\)/],
    ['fire', /PANIC\.fireSafe \* \(camp\?\.skill\?\.fire \|\| 0\)/],
    ['woodcraft', /WOOD\.perTrip \* \(1 \+ \(p\.camp\.skill\.woodcraft \|\| 0\)\)/],
  ];
  const idle = want.filter(([, re]) => !re.test(html)).map(([n]) => n);
  return idle.length ? `${idle.join(', ')} changes nothing` : true;
})() === true);
/* A band learns to treat a fever because it has been having fevers, which is
   the nicest of them: the bands that are good at healing are the ones that have
   been through something, and you can read that off the card years later. */
check('a band works on what it has been worrying about',
  /\['herbs', 0\.10 \+ 1\.10 \* sick\]/.test(html)
  && /if \(q\.sick\) ill\+\+;/.test(html));
/* Six weights for eight skills, and that is the shape of it: these are the ones
   a band gets better at by sitting down and working at them. The other two are
   learned at the graveyard and nowhere else — going back to it, and raising
   something over it. */
/* Out of craftChoice, not out of the file. `const weights = [` also opens the
   job list in move.js, which sorts earlier — so this was counting the errands a
   person can choose between and getting the right answer by coincidence. It
   broke the day a ninth errand was added, which is the only reason anybody
   found out it had never been reading the skills at all. */
const CRAFT_WEIGHTS = (() => {
  const src = moduleSource('skills.js');
  const at = src.indexOf('function craftChoice');
  const m = src.slice(at).match(/const weights = \[([\s\S]*?)\];/);
  return m ? (m[1].match(/\['(\w+)',/g) || []).map((t) => t.slice(2, -2)) : [];
})();
check('and there is a weight for every skill worked at',
  CRAFT_WEIGHTS.length === 9, `${CRAFT_WEIGHTS.length} weights: ${CRAFT_WEIGHTS.join(' ')}`);
/* Four of the twelve are not worked at the fire: the two learned at the
   graveyard, trading (learned by trading), and mining (learned at the rock). */
/* Six of the fourteen are not worked at the fire: the two at the graveyard,
   trading, mining at a rock, fighting when somebody arrives, and fishing, which
   is learned standing in the water. */
check('and the six learned elsewhere are not among them',
  !CRAFT_WEIGHTS.some((k) => ['rites', 'art', 'trade', 'mining', 'war', 'fishing'].includes(k)),
  CRAFT_WEIGHTS.join(' '));
/* Written out in five places before. Adding a seventh should not be a hunt
   through the file for the ones that were missed. */
check('an empty set of them is built from the list',
  /export const emptySkills = \(\) => Object\.fromEntries\(Object\.keys\(SKILLS\)\.map\(\(k\) => \[k, 0\]\)\);/.test(
    rawSources[srcFiles.indexOf('skills.js')] || ''));
check('and nothing writes the three out by hand any more',
  !/\{ spears: 0, baskets: 0, drying: 0 \}/.test(html));
/* A save from before the other three has to still mean what it meant. */
check('an old save is read by the order it was written in',
  /SAVED_SKILL_ORDER = \['spears', 'baskets', 'drying'\]/.test(html)
  && /if \(Array\.isArray\(kn\)\)/.test(html));
check('and a new one is keyed, so inserting a skill shifts nobody',
  /kn: Object\.fromEntries\(Object\.keys\(SKILLS\)\.map\(\(k\) => \[k, r2\(p\.knows\?\.\[k\] \|\| 0\)\]\)\)/.test(html));
/* And a word for forgetting each of them, or a band that loses one says
   "has forgotten how to undefined". */
check('every skill can be forgotten in words', (() => {
  const skills = [...(html.match(/^\s{2}(\w+): \{ label: '[^']*', of: '([^']*)' \},/gm) || [])]
    .map((l) => (l.match(/of: '([^']*)'/) || [, ''])[1]);
  const words = (html.match(/FORGET_WORDS = \{([\s\S]*?)\};/) || [, ''])[1];
  const missing = skills.filter((of) => !words.includes(`${of}:`) && !words.includes(`'${of}':`));
  return missing.length ? `no word for ${missing.join(', ')}` : true;
})() === true);
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
  /toll: \{ age: 0, infancy: 0, hunger: 0, exhaustion: 0, sickness: 0, tiger: 0, raid: 0 \}/.test(html));
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

/* -------------------------------------------------------------------------
   A list you scan and a card you read

   The panel row used to carry the sex split, the children, the days of food,
   three skill bars and the toll with its causes. That is a good paragraph about
   one band and an unreadable wall about twenty, so the row is a colour, a code,
   a name and a number, and everything else moved to the card a click away.

   "Eleven died" still says nothing and "eleven died, seven of the sickness and
   three hungry" is still the story — that has not changed, only where there is
   room to tell it. On the card there is room for all of them, so none of it
   hides behind a hover any more.
   ------------------------------------------------------------------------- */
check('the band card says what has become of them',
  /lost \$\{toll\.reduce\(\(n, \[, k\]\) => n \+ k, 0\)\}: /.test(html));
/* On the card, all of them. The obituary keeps its leading two on purpose —
   that is one line in the chronicle, not a panel with room — so this asks about
   the card rather than about the file. */
check('and names every cause, not the leading two', (() => {
  const card = html.slice(html.indexOf('function renderTribeCard'), html.indexOf('function showKeys'));
  if (!card) return 'no renderTribeCard';
  if (!/toll\.map\(\(\[k, n\]\) => `\$\{n\} \$\{TOLL_WORDS\[k\]\}`\)\.join\(', '\)/.test(card)) {
    return 'the card does not name the causes';
  }
  return /toll\.slice\(0, 2\)/.test(card) ? 'the card still truncates to two' : true;
})() === true);
// And from the band's own tally, not from an empty list that renders nothing.
check('and reads it off the band', /const toll = tollOf\(camp\);/.test(
  html.slice(html.indexOf('function renderTribeCard'), html.indexOf('function showKeys'))));

check('the panel row is a colour, a code, a name and a number', (() => {
  const body = html.slice(html.indexOf('function renderTribes'), html.indexOf('function drawTribeChart'));
  if (!body) return 'no renderTribes';
  const gone = ['tollOf(c)', 'class="toll"', 'class="skills"', 'daysOfFood(c)', 'sexMarks']
    .filter((t) => body.includes(t));
  return gone.length ? `still on the row: ${gone.join(', ')}` : true;
})() === true);
check('and it still counts the people on it',
  /for \(const p of people\) if \(p\.camp === c\) pop\+\+;/.test(html));
/* Everything that left the row has to arrive on the card, or it is not a move,
   it is a deletion. */
/* -------------------------------------------------------------------------
   Which skill, and how far

   Three anonymous bars said a band knew *something*. Which of the three, and
   how much, was only reachable by hovering — and the whole reason skills are
   interesting is watching one climb while the others do not.
   ------------------------------------------------------------------------- */
check('the card lists the skills one to a row, in a table like the rest of it',
  /<table class="skills"><thead><tr><th>skill<\/th><th>acquired<\/th><th>level<\/th><\/tr><\/thead>/.test(html)
  && /<tr><td class="n">\$\{SKILLS\[k\]\.of\}<\/td>/.test(html)
  && /#tribeList table, #tribeHead table \{/.test(html));
check('with the number on it, out of a hundred',
  /<td>\$\{pct\}<span>\/100<\/span><\/td>/.test(html));
check('and the rung it is on, in words',
  /<td class="n">\$\{SKILL_RUNGS\[skillTier\(v\)\]\}<\/td><\/tr>/.test(html));
check('and no bar: the number says it', (() => {
  const card = html.slice(html.indexOf('function renderTribeCard'), html.indexOf('function showKeys'));
  return !card.includes('class="sk"') && !card.includes('--v:') && !html.includes('.skillRow');
})());
/* SKILL_WORDS is written to sit inside a sentence — "has a fair hand at
   knapping" — so a column of them reads as a column of half-sentences. */
check('which are labels, not the middles of sentences',
  /SKILL_RUNGS = \['not yet', 'beginnings', 'a fair hand', 'real skill', 'mastery'\]/.test(html));
check('and there is a rung for every step of the ladder', (() => {
  const rungs = (html.match(/SKILL_RUNGS = \[([^\]]*)\]/) || [, ''])[1].split(',').length;
  const steps = (html.match(/SKILL_STEPS = \[([^\]]*)\]/) || [, ''])[1].split(',').length;
  return rungs === steps + 1 ? true : `${rungs} rungs for ${steps} steps`;
})() === true);

check('and everything it dropped is on the card', (() => {
  const card = html.slice(html.indexOf('function renderTribeCard'), html.indexOf('function showKeys'));
  if (!card) return 'no renderTribeCard';
  const want = [['the sex split', 'sexMarks'], ['the children', 'children'],
    ['the ill', 'ill</em>'], ['the skills', 'class="skills"'], ['the days of food', 'daysOfFood(camp)']];
  const missing = want.filter(([, t]) => !card.includes(t)).map(([n]) => n);
  return missing.length ? `missing: ${missing.join(', ')}` : true;
})() === true);
/* The row is how you get to the card, so it has to stay clickable. */
check('and the row opens the card',
  /data-camp="\$\{i\}"/.test(html));

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

/* How old a band is, on its card: from the day it was founded, in years once it
   has one, in days before — and said once, not again at the foot of the card. */
const bandAgeFn = new Function('simDay', 'P',
  moduleSource('chronicle.js').match(/function bandAge\(camp\) \{[\s\S]*?\n\}/)[0] + '\nreturn bandAge;');
const ageAt = (day, founded) => bandAgeFn(day, { yearLength: 12 })({ founded });
check('the card says how old the band is',
  /<div><b>\$\{bandAge\(camp\)\}<\/b> <span>old · founded on day \$\{Math\.floor\(camp\.founded \|\| 0\)\}<\/span><\/div>/.test(html)
  && !/founded day \$\{Math\.floor\(camp\.founded\)\}/.test(html));
check('in years once it has one', ageAt(12 * 12 + 5, 0) === '12 years' && ageAt(20, 5) === '1 year',
  `${ageAt(12 * 12 + 5, 0)}, ${ageAt(20, 5)}`);
check('and in days before that, so a new band is not "0 years old"',
  ageAt(40, 31) === '9 days' && ageAt(31, 30) === '1 day' && ageAt(30, 30) === '0 days',
  `${ageAt(40, 31)}, ${ageAt(31, 30)}, ${ageAt(30, 30)}`);
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
   they are gone — and that is what the band card is for. The follow caption
   says who somebody is and what they are doing now; the ancestry it used to
   recite belongs where there is room to read it. */
const followCaption = html.slice(html.indexOf('export function updateFollowCaption'),
  html.indexOf('export function', html.indexOf('export function updateFollowCaption') + 10));
check('the follow caption does not recite anybody\'s ancestry',
  !/ancestry\(/.test(followCaption) && !/fatherName/.test(followCaption)
  && !/ordinal\(/.test(followCaption),
  followCaption.slice(0, 0) || 'the caption still names a parent or a line');
check('and the record still keeps who somebody came from',
  /function lineOf\(id\)/.test(html) && /function ancestry\(p, limit/.test(html)
  && /g: p\.gen, l: p\.line/.test(html));
check('and a save carries it out and back', /ln: p\.line \|\| '', gn: p\.gen \|\| 1/.test(html));

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
  /const value = \(\(FOOD\.gather \* forageRichness\(x, z\) \+ fruit\)/.test(html));
/* Two foragers leaving the same fire read the same numbers and walked to the
   same spot, every time — a band with one opinion rather than twenty people.
   The jitter multiplies the whole value, fruit and ground together: applied to
   one term and not the other it would be precisely the preference this test
   exists to keep out. */
check('and the tie is broken on the total, not on one kind of spot',
  /const guess = 0\.78 \+ luck\(\) \* 0\.44;/.test(html)
  && /- \(away \/ 100\) \* FORAGE\.farCost\) \* guess;/.test(html));
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
const aheadSrc = html.slice(html.indexOf('function showAheadProgress'),
  html.indexOf('function runAhead'));
check('and the log is the chronicle itself, not a copy of it',
  /chronicle\.filter\(isMilestone\)\.slice\(0, 8\)/.test(aheadSrc));
/* Eight lines is what fits and a year is hundreds of them, so unfiltered those
   eight were whichever kills and hungry nights happened to be most recent — a
   band breaking away would show for a fraction of a second and be gone. Same
   filter the panel has had all along. */
check('showing only what is worth telling', /isMilestone/.test(aheadSrc));
/* The number the run is actually about. A progress bar says how long there is
   to wait; this says whether waiting is worth it. */
check('and how many people there are while it runs',
  /people\.length \} \}/.test(aheadSrc) || /\$\{people\.length\}/.test(aheadSrc));
check('and how many camps they are living in',
  /camps\.filter\(\(c\) => !c\.gone\)\.length/.test(aheadSrc));
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
  /if \(inCamp\(p\.x, p\.z, safeGround\(p\.camp\)\)\) continue;/.test(html));
/* And how much ground that is depends on how well the band keeps its fire. */
check('and a better-kept fire holds it further off',
  /export const safeGround = \(camp\) => PANIC\.safe \+ PANIC\.fireSafe \* \(camp\?\.skill\?\.fire \|\| 0\);/.test(
    rawSources[srcFiles.indexOf('wildlife.js')] || ''));
check('by about the width of the trampled ground round a camp', (() => {
  const safe = Number((html.match(/safe: (\d+),/) || [, 0])[1]);
  const more = Number((html.match(/fireSafe: (\d+),/) || [, 0])[1]);
  const clearing = Number((html.match(/CAMP_CLEARING = (\d+);/) || [, 0])[1]);
  return safe + more >= clearing && safe < clearing
    ? true : `${safe} to ${safe + more} against a clearing of ${clearing}`;
})() === true);
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
/* The tiger's hunting block: the first `hunt: {` that has a chase in it, not
   the first in the page. icons.js sorts ahead of the wildlife and has an icon
   by the same name, and taking that one made three tiger checks read a list of
   path strings. */
const tigerHunt = (() => {
  for (let i = html.indexOf('hunt: {'); i >= 0; i = html.indexOf('hunt: {', i + 1)) {
    const block = html.slice(i, i + 1400);
    if (/chase: \d+,/.test(block)) return block;
  }
  return '';
})();
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
  return i > 0 && /inCamp\(d\.prey\.person\.x, d\.prey\.person\.z, safeGround\(d\.prey\.person\.camp\)\)/
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

/* -------------------------------------------------------------------------
   Footpaths

   The wear field is module state and arithmetic — no DOM, no renderer, nothing
   that needs a world — so the whole file is instantiated here with its imports
   stubbed and somebody is walked across it. What is being checked is the thing
   the numbers in `PATH` claim: that a route walked daily becomes a path, that a
   walk taken once does not, and that a path nobody uses goes away again.
   ------------------------------------------------------------------------- */

const PATH_WORLD = 1600;
const makePaths = new Function('THREE', 'WORLD', 'TILE',
  moduleSource('paths.js')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
  + '\nreturn { PATH, buildPaths, clearPaths, tread, wearAt, fadePaths, pathStats, takeWornTiles };');

/* Only the four things paths.js actually touches. A real three.js here would
   be measuring three.js. */
const THREE_STUB = {
  DataTexture: class { constructor(d, w, h) { this.image = { data: d, width: w, height: h }; } dispose() {} },
  Color: class { constructor(hex) { this.hex = hex; } },
  RedFormat: 1, LinearFilter: 2, ClampToEdgeWrapping: 3,
};

const paths = makePaths(THREE_STUB, PATH_WORLD, 24);
const { PATH: PATHS, buildPaths, tread, wearAt, fadePaths, pathStats, takeWornTiles } = paths;

/** Walks somebody from one end of a line to the other, in strides. */
function walkLine(x0, z0, x1, z1, times = 1, stride = 0.9) {
  const dx = x1 - x0, dz = z1 - z0;
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.round(dist / stride));
  for (let t = 0; t < times; t++) {
    for (let s = 0; s < steps; s++) {
      const a = s / steps, b = (s + 1) / steps;
      tread(x0 + dx * a, z0 + dz * a, x0 + dx * b, z0 + dz * b);
    }
  }
}

/* Measured across the track rather than at a point on it, and that is not
   fussiness: the field is a grid, so a line walked along z = 0 can fall exactly
   on the boundary between two rows of cells and read half of what it laid down,
   for ever. Sampling one point made this pass at one map size and hang at
   another — the wear was fine both times, the ruler was not. */
const peakAcross = (x) => {
  let most = 0;
  for (let d = -3; d <= 3; d += 0.05) most = Math.max(most, wearAt(x, d));
  return most;
};

buildPaths();
walkLine(-20, 0, 20, 0, 1);
const afterOne = peakAcross(0);
check('one walk down a line is not a path', afterOne < PATHS.showing,
  `${afterOne.toFixed(3)} against ${PATHS.showing}`);
check('but it does leave a mark', afterOne > 0, String(afterOne));

/* How many times it takes, which is the number the comment in paths.js claims.
   Asserted as a range rather than a value: the point is that it is a week of
   errands and not one walk or a hundred. */
buildPaths();
let crossings = 0;
while (peakAcross(0) < PATHS.bare && crossings < 200) { walkLine(-20, 0, 20, 0, 1); crossings++; }
check('a route walked daily is bare ground within a fortnight',
  crossings >= 4 && crossings <= 20, `${crossings} crossings`);

check('and the ground either side of it is untouched', wearAt(0, 18) === 0,
  String(wearAt(0, 18)));
check('wear stops at fully worn however much it is walked',
  (walkLine(-20, 0, 20, 0, 200), peakAcross(0) <= 1), String(peakAcross(0)));

/* Grass grows back. A path is a record of what people are doing now, not a
   monument to what they did once — a camp that moves has to leave its paths
   behind or the island fills up with the ghosts of old errands. */
/* Faded from a path that has just become bare, not from the saturated one the
   check above left behind — the claim is about how long a path lasts once
   nobody is using it, and starting from four times the wear anybody ever needs
   measures the ceiling instead. */
buildPaths();
while (peakAcross(0) < PATHS.bare) walkLine(-20, 0, 20, 0, 1);
const bareBefore = pathStats().bare;
fadePaths(PATHS.fadeDays * 1.5);
check('a path nobody walks grows over', peakAcross(0) < PATHS.showing,
  `${peakAcross(0).toFixed(3)} left of ${bareBefore} bare cells`);
fadePaths(PATHS.fadeDays * 40);
check('and eventually leaves nothing behind at all', pathStats().cells === 0,
  `${pathStats().cells} cells still worn`);

/* The grass is only re-scattered when a tile crosses a threshold, so the tiles
   have to be handed over once and then not again — a tile that keeps asking is
   a tile that gets rebuilt every frame somebody walks on it. */
buildPaths();
walkLine(-20, 0, 20, 0, 30);
const asked = takeWornTiles();
check('crossing a threshold asks for those tiles to be scattered again',
  asked && asked.length > 0, String(asked && asked.length));
check('and asks once, not once a step', takeWornTiles() === null);

/* The map walks through its sizes, and the largest of them is the window
   itself rather than a bigger corner — a map you are reading is the thing you
   are looking at. It carries no number, because the number is however much room
   there is, so it is the one size that has to be measured again on a resize. */
const mapSrc = moduleSource('map.js');
check('the map has a full-page size', /\{ name: 'max', px: 0, fills: true \}/.test(mapSrc));
/* Three states, and the decision is only ever "get it out of the way" or "let
   me look properly" — 118 and 168 and 236 were four presses to make it. */
check('and there are three of them: off, a glance, and the window',
  (mapSrc.match(/\{ name: '\w+'/g) || []).length === 3
  && !/name: 'xlarge'/.test(mapSrc) && !/name: 'medium'/.test(mapSrc));
check('sized against the short edge of the window, not a constant',
  /Math\.min\(innerWidth, innerHeight\)/.test(mapSrc));
check('and measured again when the window changes',
  /function onMapResize\(\)/.test(mapSrc)
  && /MAP_SIZES\[mapSize\]\.fills\) setMapSize\(mapSize\)/.test(mapSrc)
  && /onMapResize\(\)/.test(moduleSource('main.js')));
/* `hidden` is px 0 and so is `full`, so the test that decides whether to hide
   the box cannot be "px is zero" any more. */
check('a full map is not mistaken for a hidden one',
  /if \(!at\.fills && at\.px === 0\)/.test(mapSrc));
check('the keys card lists what M walks through',
  /the map: off, a corner map, the whole window, and round again/.test(html));

/* -------------------------------------------------------------------------
   How many the world will hold

   An InstancedMesh cannot be resized, so the room for people is decided when
   the world is built and never again. It used to be four times the starting
   band, which meant PEOPLE=16 stopped the world at 64 however much food there
   was — and it stopped by refusing births rather than by anybody going hungry,
   which is a ceiling with nothing in the world behind it.
   ------------------------------------------------------------------------- */
group('room to grow');

const roomSrc = moduleSource('people.js');
check('room is made for everybody the island can feed',
  /setPeopleCapacity\(Math\.max\(count, PEOPLE_ROOM\)\)/.test(roomSrc));
check('and not for a multiple of the band that happens to start',
  !/setPeopleCapacity\(Math\.round\(clamp\(count \* 4/.test(roomSrc));
/* Somebody may start more people than the ground would carry, and they have to
   be drawable on the first frame. */
check('a band larger than the island still fits on it',
  /Math\.max\(count, PEOPLE_ROOM\)/.test(roomSrc));
check('the room it starts with is the island, not a constant',
  /PEOPLE_ROOM =\s*Math\.round\(Math\.min\(4000, \(WORLD \/ 1000\) \*\* 2 \* PEOPLE_PER_KM2\)\)/
    .test(moduleSource('params.js')));
/* And it is only where the room starts. A band that fills it is given more:
   every piece rebuilt twice the size, what was drawn and painted copied across,
   and the new slots parked out of sight until somebody is born into them. */
check('a band can outgrow the room it started with', (() => {
  const body = bodyOf('growPeople') || '';
  const needs = [
    /while \(room < need\) room \*= 2;/, /instanceMatrix\.array\.set\(old\.instanceMatrix\.array\)/,
    /instanceColor\.array\.set\(old\.instanceColor\.array\)/, /m\.setMatrixAt\(i, HIDDEN\)/,
    /m\.count = old\.count;/, /setPeopleCapacity\(room\);/,
  ];
  const missing = needs.filter((re) => !re.test(body));
  return missing.length ? `missing ${missing.map(String).join(' ')}` : true;
})() === true);

/* Same argument for the fires. Starting two camps capped an island at six of
   them whatever its size, and where a camp may go is decided by the ground —
   sites need 260 m between them — which is a reason. Running out of huts is
   not. */
check('and for as many fires as the map has room for',
  /campCapacity = Math\.max\(camps\.length, CAMP_CEILING\)/.test(roomSrc));
check('not three times the number it started with',
  !/campCapacity = Math\.round\(clamp\(camps\.length \* 3/.test(roomSrc));

/* The reason this is affordable: an empty slot is a matrix and nothing else.
   The draw count is turned down to the band that exists, so allocating for two
   thousand costs no frames — which is what made the old ceiling look like a
   saving when it was not. */
check('an empty slot is never submitted',
  /personParts\[key\]\.count = Math\.min\(from \* per, personParts\[key\]\.instanceMatrix\.count\)/
    .test(moduleSource('life.js')));
check('and nothing refuses a birth for want of room: the room is made',
  !/if \(people\.length >= peopleCapacity\) break;/.test(html)
  && /if \(people\.length >= peopleCapacity\) growPeople\(people\.length \+ 1\);\s*recordPerson\(child\);\s*people\.push\(child\);/.test(html));
check('and a saved world comes back at the size it was',
  /growPeople\(st\.people\.length\);\s*for \(const r of st\.people\) people\.push\(personFromRecord\(r\)\);/.test(html));
check('and a split, somewhere to put the fire',
  /if \(camps\.length >= campCapacity\) return false;/.test(html));

/* -------------------------------------------------------------------------
   How much of the map is land

   The island falloff was `smoothstep(540, 820, d)` — metres, tuned on a 1600 m
   island, and so what they went on meaning. Asking for a bigger world gave you
   the same island in more water.

   Run for real rather than read: noise.js is arithmetic with two imports, so it
   is instantiated here at a few map sizes and the height field is sampled.
   ------------------------------------------------------------------------- */
group('land and water');

const makeTerrain = new Function('P', 'WORLD',
  moduleSource('noise.js').replace(/^import .*$/gm, '')
  + '\nreturn { rawHeight, settle: () => { hOffset = 0; hOffset = 4 - rawHeight(0, 0); } };');

/** Land, and how much of the ground anybody may walk on is land, per map size. */
function surveyIsland(WORLD, seed, N = 90) {
  const t = makeTerrain({ seed }, WORLD);
  t.settle();
  let land = 0, reach = 0, reachLand = 0, rim = 0, rimLand = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -WORLD / 2 + (i + 0.5) * WORLD / N;
      const z = -WORLD / 2 + (j + 0.5) * WORLD / N;
      const wet = t.rawHeight(x, z) > 0;
      const d = Math.hypot(x, z);
      if (wet) land++;
      // The disc canStand allows, and the corners it never does.
      if (d < WORLD * 0.46) { reach++; if (wet) reachLand++; }
      if (d > WORLD * 0.62) { rim++; if (wet) rimLand++; }
    }
  }
  return { land: land / (N * N), reach: reachLand / reach, rim: rimLand / rim };
}

const islands = [1600, 3200].map((w) => ({ w, ...surveyIsland(w, 20260906) }));
const pct = (v) => `${(v * 100).toFixed(0)}%`;

/* The whole point: an island is a fraction of its map, not a fixed number of
   metres sitting in the middle of one. */
check('a bigger map is a bigger island, not more sea',
  Math.abs(islands[0].land - islands[1].land) < 0.08,
  islands.map((r) => `${r.w}: ${pct(r.land)} land`).join(' · '));
check('and most of the map is land at every size',
  islands.every((r) => r.land > 0.55),
  islands.map((r) => `${r.w}: ${pct(r.land)}`).join(' · '));

/* The shoreline sits where `canStand` stops anybody, so the edge of where you
   can walk is the water rather than an invisible wall with beach beyond it. */
check('nearly everywhere you may walk is dry',
  islands.every((r) => r.reach > 0.8),
  islands.map((r) => `${r.w}: ${pct(r.reach)} of the walkable disc`).join(' · '));

/* And it still ends in sea, which is the reason there is a falloff at all. */
check('the map still ends in water rather than at a cliff',
  islands.every((r) => r.rim < 0.25),
  islands.map((r) => `${r.w}: ${pct(r.rim)} of the rim is land`).join(' · '));

/* Asserted on the line itself rather than on the absence of the old one: the
   comment above it quotes `smoothstep(540, 820, d)` to say what it used to be,
   and a check that greps the whole file for that string fails on the
   explanation of why it is gone. */
check('the falloff is written against the map, not in metres',
  /const half = WORLD \/ 2;\s*h -= smoothstep\(half \* 0\.78, half \* 1\.12, d\) \* 95;/
    .test(moduleSource('noise.js')));

/* -------------------------------------------------------------------------
   The full-page map

   A map that fills the window is a different object from one in the corner: it
   is the thing you are looking at rather than a glance, so it carries what a
   map carries — a frame, labels, roads, a scale, and a way back.
   ------------------------------------------------------------------------- */
group('the full map');

const mapMod = moduleSource('map.js');

/* Five steps that were mostly each other. Walking through 118 and 168 on the
   way to somewhere was four keypresses to make one decision. */
check('M walks off, small and max — nothing in between',
  /const MAP_SIZES = \[\s*\{ name: 'hidden', px: 0 \},\s*\{ name: 'small', px: 92 \},\s*\{ name: 'max', px: 0, fills: true \},\s*\]/
    .test(mapMod));
check('and it starts on the one you glance at, not off',
  /const MAP_DEFAULT = SMALL_MAP;/.test(mapMod));
/* Index 0 is the hidden one now. A button labelled "smaller" that turns the map
   off is the kind of thing a reordered array does quietly. */
check('so the corner is found by name rather than by number',
  /const SMALL_MAP = MAP_SIZES\.findIndex\(\(m\) => m\.name === 'small'\)/.test(mapMod));

/* One transform for drawing and for clicking, or a zoomed map disagrees with
   itself about where a thing is — you would click a camp and travel somewhere
   else. */
check('zoom is a window on the world, shared by what is drawn and what is clicked',
  /const mapView = \{ x: 0, z: 0, span: WORLD \}/.test(mapMod)
  && /function worldToMap\(x, z\) \{\s*const k = MAP_N \/ mapView\.span;/.test(mapMod)
  && /function mapToWorld\(u, v\) \{\s*return \[mapView\.x/.test(mapMod));
/* It follows you until you drag it, and then it stays where you put it. Both
   are wanted: finding yourself on the map is the reason to zoom, and being
   unable to look at the next valley without walking there is why that is not
   enough. */
check('zoomed in it follows you, because that is what magnifying a map is for',
  /const at = mapPan \|\| camera\.position;/.test(mapMod)
  && /mapView\.x = clamp\(at\.x, -edge, edge\)/.test(mapMod));
check('unless you have dragged it somewhere, and then it stays there',
  /function setMapPan\(x, z\)/.test(mapMod)
  && /setMapPan\(mapView\.x - dx \* per, mapView\.z - dy \* per\)/.test(mapMod));
/* Zooming back out is also how you say "follow me again". */
check('and zooming back out hands it back to you',
  /if \(zoom === 1\) \{ mapView\.x = 0; mapView\.z = 0; mapPan = null; return; \}/.test(mapMod));
/* One pointer, two jobs, and the only thing between them is how far it moved. */
check('a drag pans and a click travels, told apart by distance',
  /if \(drag\.moved > DRAG_SLOP\) return;/.test(mapMod)
  && /const \[x, z\] = mapToWorld/.test(mapMod));
check('and only a zoomed full map can be dragged at all',
  /function mapCanPan\(\) \{ return mapIsFull\(\) && mapZoom > 1; \}/.test(mapMod));
check('the ground keeps pace with the pointer',
  /const per = mapView\.span \/ mapCanvas\.getBoundingClientRect\(\)\.width;/.test(mapMod));
check('and never off the side of the world',
  /const edge = \(WORLD - mapView\.span\) \/ 2/.test(mapMod));
check('leaving full size drops the zoom with it', /if \(!at\.fills\) \{ mapZoom = 1;/.test(mapMod));

/* The relief is one image of the whole island, so zooming is a crop rather than
   a redraw: a keypress does not re-sample a quarter of a million heights. */
check('zooming crops the relief rather than rebuilding it',
  /drawImage\(mapBase, sx, sz, src, src, 0, 0, MAP_N, MAP_N\)/.test(mapMod));

/* A track a metre and a half wide is a third of a pixel at island scale, so it
   is drawn thicker than it is — which is what a map does with a road. */
check('the paths are drawn as roads', /function drawPathLayer\(\)/.test(mapMod)
  && /const w = Math\.max\(1, cell \* k\)/.test(mapMod));
/* The same threshold the terrain shader browns from, so the map and the ground
   agree about what counts as a path — a road on the map that is not under your
   feet when you get there is worse than no road. */
check('and only where somebody has actually worn one',
  /if \(worn < PATH\.onMap\) return;/.test(mapMod)
  && /smoothstep\(0\.45, 0\.88, worn\)/.test(moduleSource('scene.js'))
  && /onMap: 0\.45,/.test(moduleSource('paths.js')));
/* Painting the same few thousand cells fourteen times a second to get the same
   picture is most of what the map would cost. */
check('the roads are cached until the ground changes',
  /if \(pathVersion === drawnPaths \|\| now < nextPathDraw\) return;/.test(mapMod)
  && /pathVersion\+\+/.test(moduleSource('paths.js')));

check('camps wear their band code at this size', /mapCtx\.strokeText\(c\.code, at, py\)/.test(mapMod)
  && /mapCtx\.fillText\(c\.code, at, py\)/.test(mapMod));
check('and only at this size', /if \(mapIsFull\(\) && mapShows\.camps\) \{\s*mapCtx\.font/.test(mapMod));
check('a band that is gone is not labelled', /if \(c\.gone\) continue;/.test(mapMod));

/* A scale that reads "0.83 km" is a scale nobody can use, so the bar is a round
   number of metres and its length follows. */
check('the scale bar is a round distance, not a round number of pixels',
  /const SCALE_STEPS = \[25, 50, 100, 200, 500, 1000, 2000, 5000\]/.test(mapMod)
  && /SCALE_STEPS\.find\(\(m\) => m >= want\)/.test(mapMod));
check('and says kilometres once it is worth saying them',
  /metres >= 1000\s*\? `\$\{\(metres \/ 1000\)/.test(mapMod));

check('there are controls on it, for somebody who has not read the keys card',
  html.includes('id="mapIn"') && html.includes('id="mapOut"') && html.includes('id="mapMin"'));
/* "Minimise" on a window that fills the screen means make it small. There is
   already a key for making it go away. */
check('and minimise puts it back in the corner rather than turning it off',
  /\$\('mapMin'\)\?\.addEventListener\('click', \(\) => setMapSize\(SMALL_MAP\)\)/.test(mapMod));
check('the wheel zooms it, the way a wheel over a map does',
  /if \(!mapIsFull\(\)\) return;\s*ev\.preventDefault\(\);\s*stepMapZoom/.test(mapMod));
check('the frame and the controls belong to the full size only',
  /#map\.full::before/.test(html) && /#mapUi \{ display: none; \}/.test(html)
  && /#map\.full #mapUi \{/.test(html));

/* The page is served `no-store` so a restart with a new .env shows up. The
   modules it loads have to be too, or a reload gives you new markup driving old
   code — buttons that do nothing, a scale bar stuck on its placeholder, and no
   way to tell from inside the page that this is what happened. */
check('the page is served without caching', /'cache-control': 'no-store',\n      \}\);\n      return res\.end\(html\)/.test(serverSrc)
  || /no-store/.test(serverSrc.slice(serverSrc.indexOf('serveIndex()'), serverSrc.indexOf('serveIndex()') + 400)));
check('and so is every module and asset it loads',
  /TYPES\[extname\(file\)\] \|\| 'application\/octet-stream',[^]*?'cache-control': 'no-store'/.test(serverSrc));

/* -------------------------------------------------------------------------
   A camp is a village that has not grown yet

   Fourteen tents in one ring round one fire was the only thing a band could be:
   past that the ring was full, everybody left over shared the last tent, and
   the band split rather than getting any bigger.
   ------------------------------------------------------------------------- */
group('villages');

const villageSrc = moduleSource('people.js');

check('a camp has room for a tent per household, many times over',
  /HEARTHS \* HUTS_PER_HEARTH/.test(villageSrc)
  && /const HEARTHS = 5/.test(villageSrc) && /const HUTS_PER_HEARTH = 10/.test(villageSrc));
check('and a tent is what a household gets — one, whatever its size',
  /families\.forEach\(\(f, i\) => \{[^]*?const at = Math\.min\(i, camp\.huts\.length - 1\);\s*const hut = camp\.huts\[at\];/.test(html));
/* A pair and their children, with the unpaired sharing — a camp is short of
   shelter, not of ground. */
check('a household is a pair and the children that belong to them',
  /families\.push\(\{ adults: \[women\[i\], men\[i\]\], kids: \[\] \}\)/.test(html));

/* The point of more than one fire: tents cluster round their own hearth rather
   than packing tighter round the first one. */
check('every hearth has its own ring of tents',
  /const mine = \(i \/ HUTS_PER_HEARTH\) \| 0;/.test(villageSrc)
  && /const fire = hearthAt\(camp, mine\);/.test(villageSrc));
check('and its own stones to ring it and logs to sit at',
  /const perFireStones = P0\.stones \/ HEARTHS/.test(villageSrc)
  && /camp\.stoneAt\[at\] = _m4\.clone\(\)/.test(villageSrc));
check('a fire is lit only once there are tents round it',
  /function hearthsFor\(families\) \{\s*return clamp\(Math\.ceil\(\(families \|\| 1\) \/ HUTS_PER_HEARTH\), 1, HEARTHS\)/
    .test(villageSrc)
  && /camp\.hearths = here === 0 \? 0 : hearthsFor\(want\)/.test(villageSrc));
check('so a band of one household still looks like one camp',
  /const lit = f < camp\.hearths;/.test(villageSrc));

/* Run rather than read: how many fires a band of n households sits around is
   the whole of this feature, and a regex on the formula would pass just as
   happily with the clamp the wrong way up. */
const hearthsFor = new Function('clamp', 'HEARTHS', 'HUTS_PER_HEARTH',
  villageSrc.slice(villageSrc.indexOf('function hearthsFor'),
    villageSrc.indexOf('}', villageSrc.indexOf('function hearthsFor')) + 1)
  + '\nreturn hearthsFor;')((v, a, b) => Math.max(a, Math.min(b, v)), 5, 10);
const fires = [1, 4, 10, 11, 20, 21, 50, 200].map(hearthsFor);
check('one household, one fire', fires[0] === 1);
check('and a fire holds ten of them before the next is lit',
  fires[2] === 1 && fires[3] === 2, `10 -> ${fires[2]} fires, 11 -> ${fires[3]}`);
check('a village of fifty households is every hearth it has',
  fires[6] === 5, `50 households -> ${fires[6]} fires`);
check('and it never asks for a sixth', fires[7] === 5, `200 -> ${fires[7]}`);

/* Five flames on one beat read as a mechanism rather than as fire. */
check('each fire burns on its own beat',
  /const own = f === 0 \? flick/.test(moduleSource('move.js')));
check('and the smoke is shared out between the ones that are lit',
  /camp\.fireAt\?\.\[i % Math\.max\(1, camp\.hearths \|\| 1\)\]/.test(villageSrc));
/* One real light for the village. A hundred and forty camps at five apiece is
   seven hundred lights in a scene that otherwise manages with the sun. */
check('but the village is lit by one light, not one per hearth',
  (villageSrc.match(/new THREE\.PointLight/g) || []).length === 1);

/* A band splits when it has filled the ground it forages, not the tents it
   has room for. At sixty, six hundred recorded days saw no split at all: the
   biggest band was 32, because that is what a hundred metres round a fire
   feeds. And only with food to spare, but spare food a band can actually have. */
const splitAt = Number((html.match(/^\s*at: (\d+),\s*\/\/ people in one camp/m) || [, NaN])[1]);
const splitFood = Number((html.match(/needFood: ([\d.]+),\s*\/\/ days of store before/) || [, NaN])[1]);
const comfortable = Number((html.match(/comfortable: ([\d.]+),/) || [, NaN])[1]);
check('a band splits at the size its own ground feeds, not one it never reaches',
  splitAt >= 16 && splitAt <= 40, `at ${splitAt}`);
check('and only with food to spare, but an amount a band can actually put by',
  splitFood >= comfortable && splitFood <= comfortable * 1.5, `${splitFood} days against comfortable ${comfortable}`);
/* The trampled ground has to cover the village, and so does the ground a
   well-kept fire keeps a tiger off — otherwise somebody reaches their own tent,
   is inside the camp by every other rule, and is taken there. */
check('the clearing covers the whole village', /CAMP_CLEARING = 26;/.test(html));
check('and so does the sanctuary a well-kept fire buys',
  (() => {
    const safe = Number((html.match(/safe: (\d+),/) || [, 0])[1]);
    const more = Number((html.match(/fireSafe: (\d+),/) || [, 0])[1]);
    const clearing = Number((html.match(/CAMP_CLEARING = (\d+);/) || [, 0])[1]);
    return safe + more >= clearing;
  })());

/* The one number that decides how fast the world looks. `pace()` multiplies
   every walk, flight and camera move by paceDay / dayLength, and paceDay is
   unset by default — the day itself — so the multiplier is 1 and a walk is the
   1.35 m/s it is written as at any day length. Setting PACE_DAY is what makes a
   short day a fast one: at a twelve-minute day against an hour the same walk
   is 6.75 m/s, a sprint the walk animation is not playing. */
check('unset, the reference day is the day itself', /paceDay: null,/.test(moduleSource('params.js')));
check('and the default day is twenty-four minutes',
  /dayLength: 1440,/.test(moduleSource('params.js')));
check('and pace is that ratio, clamped',
  /function pace\(\) \{ return clamp\(\(P\.paceDay \|\| P\.dayLength\) \/ P\.dayLength, 0\.5, 12\); \}/.test(html));
/* Run, not just read: the page's own expression, given the two cases. */
const pagePace = (() => {
  const expr = html.match(/function pace\(\) \{ return (.*?); \}/)?.[1];
  return expr ? new Function('P', 'clamp', `return ${expr};`) : null;
})();
const clampPace = (v, a, b) => Math.min(Math.max(v, a), b);
check('with PACE_DAY unset, everything moves at written speed at any day length',
  pagePace && [300, 1440, 3600, 7200].every((d) => pagePace({ paceDay: null, dayLength: d }, clampPace) === 1));
check('and with it set, a short day is a fast one',
  pagePace && pagePace({ paceDay: 3600, dayLength: 1440 }, clampPace) === 2.5);
check('and an unset PACE_DAY stays unset on its way to the page',
  !('paceDay' in resolveConfig({}).values));
/* And the reference day is a setting now. Through the real resolver, so the
   path and the range are the ones the server will actually apply. */
const pacedAt = resolveConfig({ PACE_DAY: '1440' });
check('PACE_DAY sets the reference day', pacedAt.values.paceDay === 1440,
  JSON.stringify(pacedAt.values));
check('and is kept inside the range pace can use',
  resolveConfig({ PACE_DAY: '10' }).values.paceDay === 300
  && resolveConfig({ PACE_DAY: '99999' }).values.paceDay === 7200);
check('and nothing reads a fixed hour any more', !/const PACE_DAY\s*=/.test(html));
/* The economy does not notice the day length: a day is always PACE_DAY seconds
   of activity however many real seconds it takes to watch. */
check('so shortening the day speeds the world up rather than starving it',
  !/dayLength/.test(String(html.match(/const FOOD = \{[^]*?\n\};/) || '')));

/* -------------------------------------------------------------------------
   The caption and the figure have to agree

   A job says what somebody is out to do; it does not say whether they have got
   there. The caption read "knapping" and "at the fire" off a figure walking
   across a hillside — the same disagreement INDOOR_WORDS exists to fix, one
   step earlier in the errand.
   ------------------------------------------------------------------------- */
group('what they are doing now');

const sayingSrc = moduleSource('chronicle.js');
/* The words for a basket live in life.js, and doingWords calls them. */
const bagWordsFn = (() => {
  const src = moduleSource('bag.js');
  const at = src.indexOf('function bagWords(');
  return at < 0 ? () => '' : new Function(`${src.slice(at, src.indexOf('\n}\n', at) + 2)}\nreturn bagWords;`)();
})();
const doingWords = new Function('JOB_WORDS', 'INDOOR_WORDS', 'GOING_WORDS', 'CAME_WORDS',
  'HOMEWARD', 'WALKING_AT', 'visitWords', 'fireWords', 'bagWords',
  sayingSrc.slice(sayingSrc.indexOf('function doingWords'),
    sayingSrc.indexOf('\n}', sayingSrc.indexOf('function doingWords')) + 2)
  + '\nreturn doingWords;');
const WORDS = (k) => new Function(`return ${sayingSrc.slice(sayingSrc.indexOf(`const ${k} = {`) + `const ${k} = `.length, sayingSrc.indexOf('};', sayingSrc.indexOf(`const ${k} = {`)) + 2)}`)();
const say = doingWords(WORDS('JOB_WORDS'), WORDS('INDOOR_WORDS'), WORDS('GOING_WORDS'),
  WORDS('CAME_WORDS'), new Set(['tend', 'craft', 'sleep', 'nurse']), 0.25, () => 'visiting',
  () => 'at the fire', bagWordsFn);

/* The bug, both halves of it. */
check('somebody walking to the fire is not "at the fire"',
  say({ job: 'tend', state: 'goto', speed: 1.35 }) !== 'at the fire',
  say({ job: 'tend', state: 'goto', speed: 1.35 }));
check('and somebody walking off to knap is not knapping',
  say({ job: 'craft', state: 'goto', speed: 1.35 }) !== 'knapping',
  say({ job: 'craft', state: 'goto', speed: 1.35 }));
check('they are walking, and it says where to',
  /walk|off to|out after/.test(say({ job: 'craft', state: 'goto', speed: 1.35 })));

/* And once they are there it says the job, or the fix has eaten the feature. */
check('standing at the fire is at the fire',
  say({ job: 'tend', state: 'work', speed: 0 }) === 'at the fire');
check('and sitting knapping is knapping',
  say({ job: 'craft', state: 'work', speed: 0 }) === 'knapping');

/* And where from. "Walking to the fire" says where somebody is going and leaves
   out the half you can watch them doing, which is coming in off something. */
check('walking to the fire says what they are coming in from',
  say({ job: 'tend', state: 'goto', speed: 1.35, came: 'hunt' })
    === 'walking to the fire, back from a hunt',
  say({ job: 'tend', state: 'goto', speed: 1.35, came: 'hunt' }));
check('and the rocks, and the stones, and the next band',
  say({ job: 'craft', state: 'goto', speed: 1.35, came: 'quarry' }).endsWith('back from the rocks')
  && say({ job: 'tend', state: 'goto', speed: 1.35, came: 'mourn' }).endsWith('back from the stones')
  && say({ job: 'tend', state: 'goto', speed: 1.35, came: 'visit' }).endsWith('back from the next band'));
/* "Back from resting" is not news. */
check('but says nothing of the errands not worth naming',
  say({ job: 'tend', state: 'goto', speed: 1.35, came: 'sleep' }) === 'walking to the fire'
  && say({ job: 'tend', state: 'goto', speed: 1.35, came: 'tend' }) === 'walking to the fire');
/* Walking out to forage "back from a hunt" is two errands in one sentence. */
check('and only when they are coming in, not going out',
  say({ job: 'gather', state: 'goto', speed: 1.35, came: 'hunt' }) === 'walking out to forage');
check('somebody on their first errand of all has nothing to say about it',
  say({ job: 'tend', state: 'goto', speed: 1.35 }) === 'walking to the fire');
/* One field, set in the one place a job is chosen. */
check('and what they were at is recorded where the choosing happens',
  /if \(p\.job\) p\.came = p\.job;/.test(moduleSource('move.js')));

/* Coming back is its own thing, and worth saying: a forager walking home with
   something is the moment the whole errand was for. */
check('walking home says so', say({ job: 'gather', state: 'return', speed: 1.35 }) === 'walking home');
/* And what, the way you would say it: not "carrying it home · carrying 10". */
const bag = (o) => ({ fruit: 0, berries: 0, fish: 0, game: 0, animal: null, ...o });
const home = (o) => say({ job: 'gather', state: 'return', speed: 1.35, carry: 1, ...o });
check('and says what they are bringing home',
  home({ bag: bag({ fruit: 10 }) }) === 'bringing home 10 fruit', home({ bag: bag({ fruit: 10 }) }));
check('a catch is fish and a kill is the animal',
  home({ job: 'fish', bag: bag({ fish: 5 }) }) === 'bringing home 5 fish'
  && home({ job: 'hunt', bag: bag({ game: 1, animal: 'deer' }) }) === 'bringing home a deer'
  && bagWordsFn(bag({ game: 2, animal: 'rabbit' })) === '2 rabbits'
  && bagWordsFn(bag({ game: 1, animal: 'aurochs' })) === 'an aurochs',
  home({ job: 'hunt', bag: bag({ game: 1, animal: 'deer' }) }));
check('two things at most, and a sentence rather than a list',
  home({ bag: bag({ fruit: 4, berries: 22, fish: 1 }) }) === 'bringing home 1 fish and 4 fruit',
  home({ bag: bag({ fruit: 4, berries: 22, fish: 1 }) }));
check('and food when nothing was counted', home({}) === 'bringing home food', home({}));
check('a quarry trip is the rock it came out of',
  bagWordsFn(bag({ ore: 2, oreKind: 'iron' })) === '2 iron ore'
  && bagWordsFn(bag({ ore: 1, oreKind: 'stone' })) === '1 stone'
  && bagWordsFn(bag({ ore: 3, oreKind: 'stone' })) === '3 stones',
  bagWordsFn(bag({ ore: 2, oreKind: 'iron' })));
/* The basket on screen lists all of it, where a caption says two things. */
check('all of it, as a list rather than a sentence',
  bagWordsFn({ fruit: 4, berries: 22, fish: 1, game: 0, ore: 0 }, true) === '1 fish, 4 fruit, 22 berries',
  bagWordsFn({ fruit: 4, berries: 22, fish: 1, game: 0, ore: 0 }, true));
check('the caption no longer gives a bare number of food units',
  !/carrying \$\{p\.haul/.test(sayingSrc) && /!doing\.startsWith\('bringing home'\)/.test(sayingSrc));

/* The threshold has to sit under a walk and over a standstill, or somebody
   coasting to a halt flickers between the two. */
check('a walk counts as walking and a standstill does not',
  say({ job: 'tend', state: 'goto', speed: 1.35 }) !== say({ job: 'tend', state: 'goto', speed: 0 })
  && /WALKING_AT = 0\.25/.test(sayingSrc));

/* Asleep and indoors still win: where somebody is beats what they are up to. */
check('asleep is still asleep', say({ job: 'gather', speed: 2, asleep: true }) === 'asleep in a hut');
check('and under a roof is still under a roof',
  say({ job: 'craft', speed: 2, hidden: true }) === 'knapping in a tent');

/* It reads off the number the gait is drawn from, so the two cannot disagree. */
check('the words come from the same speed the legs do',
  /if \(p\.speed > WALKING_AT\)/.test(sayingSrc)
  && /const gaitF = Math\.min\(p\.speed \/ PERSON\.walk, 1\.6\)/.test(html));

/* -------------------------------------------------------------------------
   A band's two characters are its own

   They used to be a hash of a seed: unique and meaningless, so the chip on the
   map and the name on the panel were two unrelated facts about one band and you
   learned the pairing by rote.
   ------------------------------------------------------------------------- */
group('tribe codes');

const uiSrc = moduleSource('ui.js');
const tribeCode = new Function('CODE_LETTERS', 'worldCode',
  uiSrc.slice(uiSrc.indexOf('function tribeCode'),
    uiSrc.indexOf('\n}', uiSrc.indexOf('function tribeCode')) + 2)
  + '\nreturn tribeCode;')('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', () => 'ZZ');

/* Claimed in order, the way an island fills up with bands. */
function codesFor(names) {
  const taken = new Set(), out = [];
  for (const n of names) { const c = tribeCode(n, taken); taken.add(c); out.push(c); }
  return out;
}

check('a code is the start of the name it stands for',
  codesFor(['Tribe'])[0] === 'TR', codesFor(['Tribe'])[0]);
/* And when that is taken, still out of the name: the start of its last
   syllable, because the end of a name is the part that makes it that name. */
check('and when that is taken it takes another letter from the same name',
  codesFor(['Tribe', 'Tribetwo']).join(' ') === 'TR TT',
  codesFor(['Tribe', 'Tribetwo']).join(' '));
check('real band names come out as their own initials',
  codesFor(['Tsekash', 'Ndahouth', 'Hiabrali']).join(' ') === 'TS ND HI',
  codesFor(['Tsekash', 'Ndahouth', 'Hiabrali']).join(' '));

/* Uniqueness is not decoration: the chronicle says whose line a line is with
   one of these. Twenty bands whose names all start with T still get twenty
   codes. */
const crowd = Array.from({ length: 20 }, (_, i) => `Tsotsa${'abcdefgh'[i % 8]}${i}`);
const many = codesFor(crowd);
check('twenty bands sharing a first letter get twenty codes',
  new Set(many).size === 20, many.join(' '));
check('and every one of them still starts with the name\'s own letter',
  many.every((c) => c[0] === 'T'));
check('a nameless band still gets something rather than nothing',
  typeof tribeCode('', new Set()) === 'string' && tribeCode('', new Set()).length === 2);

/* The colour is derived from the code, and making codes meaningful is what
   forced the hash to change: `h * 31 + c` moves the hue one degree per step of
   the last character, so TR and TS would have been the same colour on the dots
   the map uses to tell bands apart. */
const codeColor = new Function(uiSrc.slice(uiSrc.indexOf('function codeColor'),
  uiSrc.indexOf('\n}', uiSrc.indexOf('function codeColor')) + 2) + '\nreturn codeColor;')();
const hue = (c) => Number(codeColor(c).match(/hsl\((\d+)/)[1]);
const apart = (a, b) => { const d = Math.abs(hue(a) - hue(b)); return Math.min(d, 360 - d); };
check('two codes one letter apart are not the same colour',
  apart('TR', 'TS') > 25, `TR ${hue('TR')}° vs TS ${hue('TS')}° — ${apart('TR', 'TS')}° apart`);
check('nor are two that differ in the first',
  apart('TR', 'UR') > 25, `${apart('TR', 'UR')}° apart`);
/* Across a whole island of same-letter bands, and asserted as spread rather
   than as separation. Twenty arbitrary hues on a 360° wheel will crowd
   somewhere by chance — the first cut of this check demanded three degrees
   between the nearest pair and failed on a perfectly good hash, because that is
   a fact about twenty random numbers and not about the hash.

   What a summing hash actually did is the thing worth testing: twenty codes
   sharing a first letter all landed inside a thirty-degree window, because only
   the last character moved and it moved the hue by one. So: do they reach
   across the wheel. */
{
  const buckets = new Set(many.map((c) => Math.floor(hue(c) / 30)));
  check('and twenty of them reach across the wheel rather than clustering',
    buckets.size >= 8, `${buckets.size} of 12 arcs used`);
}

/* -------------------------------------------------------------------------
   Two ways to watch

   Fly and Walk were a free camera with WASD and the same camera pinned to eye
   height. What they were for — getting somewhere to look at it — is what
   clicking the map does, in one gesture and without flying across an island in
   real time.
   ------------------------------------------------------------------------- */
group('views');

check('there are two views, and they are the two questions anybody has',
  /const VIEW_MODES = \['orbit', 'follow'\]/.test(html));
check('the panel names both and nothing else',
  /const VIEW_NAMES = \{ orbit: 'Orbit', follow: 'Follow' \}/.test(html));
check('and the environment will not let you ask for a gone one',
  SCHEMA.VIEW.values.join('|') === 'orbit|follow');
check('the world starts in one of them', /view: 'orbit',/.test(html));
check('no path still branches on a view that does not exist',
  !/P\.view === 'fly'/.test(html) && !/P\.view === 'walk'/.test(html)
  && !/setViewMode\('fly'\)/.test(html));

/* Travelling used to ask which of four rigs it was putting down and keep a
   height for each. */
check('travelling lands one rig, not four',
  /if \(P\.view === 'follow'\) setViewMode\('orbit'\);/.test(moduleSource('map.js'))
  && !/const height = P\.view/.test(html));
/* The camera dispatch is the whole of it now. */
check('and the camera is a choice between two',
  /return P\.view === 'follow' \? moveFollow\(dt\) : moveOrbit\(dt\);/.test(html));

/* -------------------------------------------------------------------------
   A band on the map is a place, not a coordinate

   The dot is drawn under two pixels across — a fine thing to look at and an
   impossible thing to hit — so what is clickable is a target round it, sized
   for a pointer rather than for the island.
   ------------------------------------------------------------------------- */
group('clicking a band');

const clickSrc = moduleSource('map.js');
check('a fire has a target round it, sized in pixels not metres',
  /const CAMP_HIT = 10;/.test(clickSrc)
  && /function campUnder\(clientX, clientY\)/.test(clickSrc));
check('and a band that is gone is not one of them',
  /for \(const c of camps\) \{\s*if \(c\.gone\) continue;/.test(clickSrc));
/* Hit-tested where it is drawn, so a zoomed or panned map cannot offer you a
   camp that is somewhere else — worldToMap is the same transform the dot uses. */
check('it is hit-tested through the same transform the dot is drawn with',
  /const \[mx, my\] = worldToMap\(c\.x, c\.z\);/.test(clickSrc));

/* Travelling is "show me that place", and a map filling the window is the one
   thing between you and it. Click a band on the full map and you would arrive
   behind the map you clicked — which reads as the click having done nothing,
   the same mistake as leaving the band card up, one layer further out. */
check('travelling puts a full-page map away',
  /if \(mapIsFull\(\)\) setMapSize\(SMALL_MAP\);/.test(clickSrc));
/* A corner map is not in the way, and taking it away because you travelled
   would be answering a question nobody asked. */
check('but leaves a corner map where it is',
  /if \(mapIsFull\(\)\) setMapSize/.test(clickSrc) && !/setMapSize\(SMALL_MAP\);\s*const ground/.test(clickSrc));
check('clicking one goes and looks at it rather than at the ground nearby',
  /const camp = campUnder\(ev\.clientX, ev\.clientY\);[\s\S]{0,400}?if \(camp\) \{\s*travelTo\(camp\.x, camp\.z\);/.test(clickSrc));
check('and opens that band\'s card', /openTribe\(camps\.indexOf\(camp\)\);/.test(clickSrc));

/* Three things a click can mean here, and a target you cannot see is a target
   nobody presses. */
check('the cursor says which of the three a click will do',
  /campUnder\(ev\.clientX, ev\.clientY\) \? 'pointer'/.test(clickSrc)
  && /mapCanPan\(\) \? 'grab' : ''/.test(clickSrc)
  && /drag\.on \? \(mapCanPan\(\) \? 'grabbing' : ''\)/.test(clickSrc));
/* And a drag across a dot is still a drag. */
check('but dragging over one still pans instead of travelling',
  clickSrc.indexOf('if (drag.moved > DRAG_SLOP) return;')
    < clickSrc.indexOf('const camp = campUnder(ev.clientX, ev.clientY);'));

/* -------------------------------------------------------------------------
   What has become of these people

   The chronicle is every line from every world, searchable — the right shape
   for "when did anybody last learn to cure meat" and the wrong one for "what
   happened to this band".
   ------------------------------------------------------------------------- */
group('a band\'s own history');

const cardSrc = moduleSource('chronicle.js');

check('the card has a third tab', html.includes('id="tribeLog"')
  && /\$\('tribeLog'\)\.addEventListener\('click', \(\) => \{ setTribeTab\('log'\); renderTribeCard\(\); \}\)/.test(html));
check('and rendering it is a branch like the other two',
  /if \(tribeTab === 'log'\) \{ \$\('tribeList'\)\.innerHTML = campHistory\(camp\); return; \}/.test(cardSrc));
/* Important only, which is the same filter the panel and the fast-forward log
   use — a band's forty years is thousands of lines and eight of them matter. */
/* The skills are a tab of their own rather than a table wedged into the head
   of the card, and every person on either list opens their family. */
check('the skills have a tab of their own', html.includes('id="tribeSkills"')
  && /\$\('tribeSkills'\)\.addEventListener\('click', \(\) => \{ setTribeTab\('skills'\); renderTribeCard\(\); \}\)/.test(html)
  && /if \(tribeTab === 'skills'\) \{/.test(cardSrc));
check('and are no longer crowded into the head of the card', (() => {
  const i = cardSrc.indexOf("$('tribeHead').innerHTML"), j = cardSrc.indexOf("$('tribeNow').className");
  return i > 0 && j > i && !cardSrc.slice(i, j).includes('class="skills"');
})());
check('every person on both lists has a lineage button',
  /\$\{linButton\(p\.id, p\.name\)\}/.test(cardSrc) && /\$\{linButton\(r\.i, r\.n\)\}/.test(cardSrc));
check('which opens their lineage rather than following them', (() => {
  const a = cardSrc.indexOf("closest?.('[data-lin]')"), b = cardSrc.indexOf("closest?.('tr[data-p]')");
  return a > 0 && b > a;
})());
const kinSrc = moduleSource('kin.js');
check('reading parents, grandparents and children off the record, and the line back',
  /function lineageView\(id\)/.test(kinSrc) && /'grandparents'/.test(kinSrc)
  && /grandchildren/.test(kinSrc) && /ancestry\(\{ father: me\.f \}\)/.test(kinSrc));
check('and a new card never opens on somebody else\'s family', /lineageShown = 0;\n  \$\('tribe'\)\.hidden = false;/.test(cardSrc));
check('it shows what is worth telling, not everything',
  /chronicle\.filter\(\(e\) => isMilestone\(e\)/.test(cardSrc));
check('and only this world\'s', /e\.seed === P\.seed/.test(cardSrc));

/* Found by code rather than by a stored id, for the same reason the colour is:
   a line is text, it outlives the camp that wrote it, and it travels to another
   world's chronicle intact. */
check('a band is found in the record by the code its lines carry',
  /e\.text\.includes\(`\[\$\{camp\.code\}\]`\)/.test(cardSrc));
/* An empty box reads as something failing to load. */
check('a band with no history yet says so',
  /nothing worth telling yet/.test(cardSrc));
check('and a long-lived one is capped rather than endless',
  /const CAMP_HISTORY_MAX = 40;/.test(cardSrc)
  && /\.slice\(0, CAMP_HISTORY_MAX\)/.test(cardSrc));

/* And the one thing the card could not do, which is show you them. */
check('the card has a button to go and stand there',
  html.includes('id="tribeGo"')
  && /travelTo\(camp\.x, camp\.z\);/.test(moduleSource('ui.js')));
/* And gets out of the way. The card sits on a dimmed, blurred backdrop over the
   whole window, so leaving it open moved the camera to a view of the overlay —
   a button that reads as doing nothing, which is the worst way for one to
   work. */
/* Every overlay, not just the card: the chronicle and the keys are full-screen
   backdrops too, and any one of them left up moves the camera to a view of an
   overlay — which is what "the button does nothing" turned out to mean. */
check('and takes down every popup over the world first',
  /closeTribe\(\);\s*closeChronicle\(\);\s*showKeys\(false\);\s*travelTo\(camp\.x, camp\.z\);/
    .test(moduleSource('ui.js')));
/* And which band it goes to is written on the button when the card is rendered,
   rather than read out of another module's live binding at click time. A button
   that silently does nothing when that is out of step is indistinguishable on
   screen from one that was never wired up. */
check('the band it goes to is recorded on the button itself',
  /pin\.dataset\.camp = String\(tribeShown\)/.test(moduleSource('chronicle.js'))
  && /const at = Number\(\$\('tribeGo'\)\.dataset\.camp\);/.test(moduleSource('ui.js')));
check('and it says so instead of failing silently',
  /if \(!camp\) \{ toast\('no band to go to'\); return; \}/.test(moduleSource('ui.js')));
check('the card really is a full-screen overlay, which is why',
  /#tribe \{\s*position: fixed; inset: 0;/.test(html));
check('it says what it does without being read',
  /id="tribeGo"[^>]*aria-label="Go to their camp"[^>]*title="Go to their camp"/.test(html));

/* -------------------------------------------------------------------------
   Five hearths and one crowd

   The village had its fires and nobody sat at four of them. Everything that
   means "go home" — dusk, an errand ending, a job by the fire, a hunt finishing
   — aimed at `camp.x`, and `camp.x` is hearth nought.
   ------------------------------------------------------------------------- */
group('spread round the fires');

const fireSrc = moduleSource('move.js');
/* Counted rather than spot-checked: one missed call site is one reason for the
   whole village to be standing in the same place, and there are seven. */
check('nothing aims at the middle of the village any more',
  !/p\.targetX = p\.camp\.x/.test(fireSrc) && !/p\.targetZ = p\.camp\.z/.test(fireSrc));
/* Directly, or through homeward — which is homeFire for anybody carrying
   nothing, and the granaries for anybody bringing food in. */
check('they go to the fire they live at',
  (fireSrc.match(/homeFire\(p\)|homeward\(p, |aimHome\(p, /g) || []).length >= 8);
check('and "am I home yet" is asked of that fire too',
  /Math\.hypot\(p\.x - homeFire\(p\)\.x, p\.z - homeFire\(p\)\.z\) > 12/.test(fireSrc));

/* Which fire is theirs comes off their tent, so a household sits together —
   the same rule that put their tents beside each other. */
check('a household shares a hearth because it shares a tent',
  /const fire = camp\.fireAt\?\.\[Math\.floor\(at \/ HUTS_PER_HEARTH\)\]/.test(html));
check('and somebody with no tent yet still has somewhere to go',
  /function homeFire\(p\) \{\s*return p\.hearth \|\| p\.camp;\s*\}/.test(html));

/* Which they should never be, because the households are worked out when the
   world is built. They used not to be: assignHuts ran only when the band
   changed, so a new world spent its first day with every hut hidden and the
   whole band walking to the middle of the village, then quietly came right the
   first time somebody was born. Founding a band is a change to it. */
check('a band has its tents and its fires from the first frame',
  /c\.food = c\.need \* FOOD\.startingDays;\s*\}[^]*?dressCamps\(\);\s*stats\.people = count;/.test(html));

/* Except when something is chasing them. Everything else about going home is
   about where you live; this is about getting behind a fire before it reaches
   you. */
check('but a tiger sends them to the nearest fire, not to theirs',
  /const run = nearestFire\(p\.camp, p\.x, p\.z\);/.test(fireSrc)
  && /function nearestFire\(camp, x, z\)/.test(html));
check('and that only considers fires that are lit',
  /for \(let f = 0; f < \(camp\.hearths \|\| 0\); f\+\+\)/.test(html));

/* The arithmetic of it: ten households to a hearth, so a village of fifty
   spreads over five and not one. */
{
  const spread = (families) => {
    const per = 10, hearths = Math.min(5, Math.ceil(families / per));
    const at = new Array(hearths).fill(0);
    for (let i = 0; i < families; i++) at[Math.min(hearths - 1, Math.floor(i / per))]++;
    return at;
  };
  check('ten households fill one hearth before a second is used',
    spread(10).length === 1 && spread(11).length === 2, JSON.stringify(spread(11)));
  check('and fifty sit at five rather than fifty at one',
    spread(50).length === 5 && spread(50).every((n) => n === 10), JSON.stringify(spread(50)));
}

/* -------------------------------------------------------------------------
   Somewhere to put the dead

   They were buried where they fell, which is defensible and reads as nothing: a
   stone in the long grass eight hundred metres out is scenery, and forty of
   them scattered over an island are litter.
   ------------------------------------------------------------------------- */
group('the stones');

const barrowSrc = moduleSource('people.js');

check('a band has one place it buries people',
  /camp\.barrow = \{ x, z, y: sampleHeight\(x, z\), a \}/.test(barrowSrc));
/* Just outside the trampled ground: far enough that the village is not built on
   its own dead, near enough to be theirs. */
check('just outside the camp rather than inside it',
  /const r = CAMP_CLEARING \+ 6 \+ rng\(\) \* 12;/.test(barrowSrc));
check('on flat, dry ground, the way a camp is sited',
  /if \(sampleHeight\(x, z\) < SEA \+ 1\.5\) continue;\s*if \(flatnessAt\(x, z\) < 0\.88\) continue;/
    .test(barrowSrc));
/* Off the camp's own stream and once, or it wanders every time somebody dies. */
check('and chosen once, from the camp\'s own rng',
  barrowSrc.indexOf('camp.barrow = null;') > barrowSrc.indexOf('const rng = camp.rng;'));
check('an island with nowhere flat still buries its dead somewhere',
  /if \(!camp\.barrow\) \{/.test(barrowSrc));

check('the dead are carried back to it', /const ground = p\.camp\?\.barrow;/.test(barrowSrc));
/* Laid round and round a square from the middle out, so the oldest stones are
   at the centre, the ground stays square, and its size is how long they have
   been burying. The seat function is run, not just read. */
check('and laid out in a square rather than dropped in a heap',
  /const \[col, row\] = squareSeat\(n\);/.test(barrowSrc));
check('which fills a square from the middle out, one grave to a place', (() => {
  const src = moduleSource('people.js');
  const at = src.indexOf('function squareSeat(n)');
  const body = src.slice(at, src.indexOf('\n}\n', at) + 2);
  const seat = new Function(`${body}; return squareSeat;`)();
  const first = Array.from({ length: 25 }, (_, n) => seat(n));
  const keys = new Set(first.map(([c, r]) => `${c},${r}`));
  const inFive = first.every(([c, r]) => Math.abs(c) <= 2 && Math.abs(r) <= 2);
  return keys.size === 25 && inFive && seat(0).join() === '0,0' ? true : JSON.stringify(first.slice(0, 10));
})() === true);

/* The seventh skill: the only one that is not a technique. */
check('going back to them is a job somebody can be doing',
  /\['mourn', p\.camp\.buried > 0 && !p\.child/.test(moduleSource('move.js')));
/* A band that has buried nobody has nowhere to go, and a hungry one stops —
   which is most of what makes it worth having. */
check('a band with no dead has nowhere to go', /p\.camp\.buried > 0/.test(moduleSource('move.js')));
check('and a hungry band stops going', /MOURN\.chance \* \(1 - hunger\)/.test(moduleSource('move.js')));
check('standing there teaches it, and a burial teaches it more',
  /practise\(p\.camp, 'rites', SKILL\.perVisit\)/.test(moduleSource('move.js'))
  && /practise\(p\.camp, 'rites', SKILL\.perBurial\)/.test(html));
{
  const perVisit = Number((html.match(/perVisit: ([\d.]+)/) || [, 0])[1]);
  const perBurial = Number((html.match(/perBurial: ([\d.]+)/) || [, 0])[1]);
  check('a burial is worth several afternoons at the stones',
    perBurial > perVisit * 3, `${perBurial} against ${perVisit}`);
}

/* And it does something, or it is a readout. A band with its dead in the next
   field takes longer to give up its ground — sometimes why it comes through a
   squeeze, sometimes why it starves where it stands. */
check('and belief holds a band to its ground',
  /const patience = GROUND\.patience \* \(1 \+ SKILL\.holdGround \* \(camp\.skill\?\.rites \|\| 0\)\)/.test(html)
  && /if \(!squeezed \|\| camp\.pressed < patience\) continue;/.test(html));
check('by enough to matter and not enough to be a wall',
  (() => {
    const hold = Number((html.match(/holdGround: ([\d.]+)/) || [, 0])[1]);
    return hold > 0.5 && hold < 4;
  })());
/* And it can be lost, like the rest. */
check('a band can forget it, in words', /burying: 'sit with their dead'/.test(html));

/* -------------------------------------------------------------------------
   What a band raises over its dead

   `rites` is going back to the stones. This is what a band does once going back
   is not enough — and it is the first mark any of them leaves that is not
   shelter or a tool.
   ------------------------------------------------------------------------- */
group('raising stones');

const artSrc = moduleSource('people.js');

check('a band raises something of its own over its dead',
  /const MONUMENT_FORMS = \['ring', 'avenue', 'cairn'\]/.test(artSrc)
  && /function monumentPlan\(camp\)/.test(artSrc));
/* Drawn once off the band's own stream, so two villages a kilometre apart have
   raised different things and neither of them chose to. */
check('the form is theirs, and settled once',
  /if \(camp\.stonesPlan\) return camp\.stonesPlan;/.test(artSrc)
  && /mulberry32\(\(camp\.index \+ 1\) \* 7919 \^ \(P\.seed \| 0\)\)/.test(artSrc));
check('and it goes up over years rather than appearing',
  /const up = Math\.round\(plan\.length \* \(camp\.skill\?\.art \|\| 0\)\)/.test(artSrc));
/* Four hundred graves redrawn for a number nobody can see is four hundred
   graves a frame. */
check('the world is told only when a stone actually goes up',
  /if \(up !== camp\.stonesUp\) \{ camp\.stonesUp = up; drawGraves\(\); \}/.test(html));
check('and there is room in the mesh for them',
  /graveRoom \* GRAVE_STONES \+ campCapacity \* MONUMENT_MAX/.test(artSrc));
/* A band that dies out keeps what it raised. Its monument used to vanish that
   day, and its art to fade to nothing after, taking the stones with it. */
check('a band that has died out keeps its monument',
  !/camp\.gone \? \[\] : monumentPlan\(camp\)/.test(html)
  && /if \(!living\.has\(camp\)\) continue;/.test(html));

/* Learned at the ground and nowhere else — the six worked skills come off
   craftChoice, these two do not. */
check('stones are raised by the people who go back to them',
  /practise\(p\.camp, 'art', SKILL\.perStone\)/.test(moduleSource('move.js')));
check('and only where there is a ground to raise them on',
  /if \(p\.camp\.barrow\) \{\s*practise\(p\.camp, 'art'/.test(moduleSource('move.js')));

/* And it moves a number, or it is a readout: a band that has raised something
   is a band other bands walk to, and visiting is how everything one band knows
   reaches another. */
check('a monument pulls the neighbours toward it',
  /function campPull\(host\) \{\s*return 1 \+ SKILL\.artDraw \* \(host\.skill\?\.art \|\| 0\)(?: \+ SKILL\.pyramidDraw \* \(host\.skill\?\.stonework \|\| 0\))?;/.test(html)
  && /Math\.hypot\(c\.x - camp\.x, c\.z - camp\.z\) \/ campPull\(c\)/.test(html));
check('by counting as nearer than it is, not by teleporting anybody',
  (() => {
    const draw = Number((html.match(/artDraw: ([\d.]+)/) || [, 0])[1]);
    return draw > 1 && draw < 5;
  })());
/* A band that has gone is not a destination. */
check('and a band that is gone is not walked to',
  /if \(c === camp \|\| c\.gone\) continue;/.test(html));

/* On the map, because a graveyard is a place. */
check('the burial ground is on the map',
  /for \(const c of mapShows\.barrows \? camps : \[\]\) \{\s*if \(!c\.barrow\) continue;/.test(moduleSource('map.js')));
check('in a colour nothing else on the map uses',
  /fillStyle = 'rgba\(216, 210, 196, 0\.92\)'/.test(moduleSource('map.js')));
/* How much is standing is the thing worth seeing from above; where it is, is
   not — so it grows a ring rather than a bigger dot. */
check('and what is standing there shows as a ring round it',
  /const raised = c\.skill\?\.art \|\| 0;/.test(moduleSource('map.js'))
  && /arc\(px, py, \(2\.2 \+ 1\.8 \* raised\) \* MK/.test(moduleSource('map.js')));

/* And it can be lost, like the rest — but not the stones. */
check('a band forgets what the stones are for, not how to stack them',
  /'raising stones': 'say what the stones are for'/.test(html));

/* -------------------------------------------------------------------------
   Making things, and getting them somewhere else

   Between them the ninth and tenth skills are the two halves of having things
   at all.
   ------------------------------------------------------------------------- */
group('wares and trade');

/* Home goods: hides, bedding, pots. Not weaving — that is baskets, and it is
   about carrying — and not knapping. What it moves is how well a band rests in
   its own camp, which is the number a dry bed has always changed. */
check('a band that makes things rests better in its own camp',
  /const comfort = 1 \+ SKILL\.wareRest \* \(p\.camp\.skill\?\.wares \|\| 0\);/.test(moduleSource('move.js')));
/* Only on the way up: home goods make a night worth more, they do not make a
   chase cost less. */
check('and only on the way up, not on the way down',
  /rate > 0 \? rate \* fed \* heal \* comfort : rate/.test(moduleSource('move.js')));
check('it is made when there is time to make it',
  /\['wares', 0\.16 \+ 0\.55 \* \(1 - h\)\]/.test(html));

/* Trading: learned by doing it, like the graveyard pair. */
check('trading is learned by trading, on both sides',
  /practise\(home, 'trade', SKILL\.perCall\);\s*practise\(host, 'trade', SKILL\.perCall\);/.test(html)
  && /practise\(home, 'trade', SKILL\.perDeal\);\s*practise\(host, 'trade', SKILL\.perDeal\);/.test(html));
check('a deal teaches more than the walk that led to it', (() => {
  const deal = Number((html.match(/perDeal: ([\d.]+)/) || [, 0])[1]);
  const call = Number((html.match(/perCall: ([\d.]+)/) || [, 0])[1]);
  return deal > call * 2;
})());
/* And what it moves is what actually changes hands. */
check('and it moves more of the surplus when somebody walks over',
  /const dealt = VISIT\.gift \* \(1 \+ SKILL\.tradeGift \* \(\(home\.skill\.trade \+ host\.skill\.trade\) \/ 2\)\)/.test(html));
/* A share is a share: more than all of the surplus is not a trade, it is a
   subtraction. */
check('but never more of it than there is',
  /const gift = surplus \* Math\.min\(dealt, 1\);/.test(html));

/* -------------------------------------------------------------------------
   And where the skills now live
   ------------------------------------------------------------------------- */
check('what a band knows is its own module now',
  srcFiles.includes('skills.js') && /const SKILLS = \{/.test(moduleSource('skills.js')));
/* Eight modules import these names from life.js. A move that is invisible to
   all of them is a move that cannot break any of them. */
check('and life.js passes the names through, so nothing else had to change',
  /export \{\s*FORGET_WORDS, LEAN, ROLES, ROLE_AT, SKILL, SKILLS[^]*?\} from '\.\/skills\.js';/.test(
    rawSources[srcFiles.indexOf('life.js')] || ''));
/* A re-export binds nothing locally, and life.js uses most of them itself. */
check('while still importing the ones it uses',
  /import \{\s*ROLES, SKILL, SKILLS, SKILL_RUNGS, announceSkill, assignRoles, craftChoice,[^]*?\} from '\.\/skills\.js';/.test(
    rawSources[srcFiles.indexOf('life.js')] || ''));

/* -------------------------------------------------------------------------
   Stone, and what it is for

   Two skills that are one chain: somebody gets it out of the ground, somebody
   else turns it into something that makes every other job quicker.
   ------------------------------------------------------------------------- */
group('stone and tools');

const mineSrc = moduleSource('move.js');

/* Worked at an outcrop that is actually on the hillside. A spot invented for
   the errand is a person standing in a field pretending. */
check('quarrying happens at a rock somebody can see',
  /const d = pickDeposit\(camp, luck, [\s\S]{0,80}?\);[\s\S]{0,200}?depositRadius\(d\) \+ 0\.8;/.test(mineSrc)
  && /depositMesh\.setMatrixAt\(slot, _m4\.compose\(_v, _q, _s\)\);/.test(html));
check('and only the ones big enough to be worth the walk',
  /if \(s > 1\.1\) outcrops\.push\(\{ x, z \}\);/.test(html));
check('the outcrops go with the world they belong to',
  /outcrops\.length = 0;/.test(moduleSource('world.js')));
/* No rock within reach is not a person standing still all afternoon. */
check('and a band with no rock near it does something else',
  /p\.job = 'craft';\s*\/\/ nothing within reach/.test(mineSrc));

/* Not while hungry, and not when the pile is already high. */
check('nobody quarries on an empty store',
  /QUARRY_TRIP\.chance \* \(1 - hunger\) \* rested/.test(mineSrc));
check('nor for stone when the camp already has all it can keep',
  /if \(d\.kind === 'stone' && stoneFull\) return 0;/.test(html)
  && /quarryInReach\(p\.camp, \(p\.camp\.stone \|\| 0\) >= SKILL\.stoneMax\)/.test(mineSrc));

/* The stock, which is the point of it: stone does not spoil, so a band can hold
   it and therefore trade it. */
check('a trip brings stone back, and the better they are the more of it',
  /mineDeposit\(d, ORES\[d\.kind\]\.per \* \(1 \+ p\.camp\.skill\.mining\)\)/.test(mineSrc));
check('the pile is capped — a camp is not a warehouse',
  /camp\.stone = Math\.min\(SKILL\.stoneMax,/.test(moduleSource('quarries.js')));
check('and a new band starts at the rocks again', (() => {
  const splits = (html.match(/food: 0, pop: 0, need: 0, hunger: 1, wasEmpty: false,/g) || []).length;
  const stones = (html.match(/\n\s*stone: 0,/g) || []).length;
  return splits === stones ? true : `${stones} camps start with a pile of nothing, of ${splits}`;
})() === true);

/* Tools are what the stone is for, and the two are one thing. */
check('toolmaking cannot be practised without stone',
  /\['tools', \(camp\.stone \|\| 0\) >= SKILL\.stonePerTool \? 0\.30 \+ 0\.35 \* h : 0\]/.test(html));
check('and a session spends it',
  /if \(key === 'tools'\) p\.camp\.stone = Math\.max\(0, p\.camp\.stone - SKILL\.stonePerTool\);/.test(mineSrc));
/* Taken where it is spent rather than where it is chosen, so choosing stays
   free of side effects and can be asked twice. */
check('spent where it is used, not where it is chosen',
  !/stone -= /.test(moduleSource('skills.js')));

/* And what tools do: the work goes quicker, which is the difference tools have
   always made. */
check('tools make every errand shorter',
  /const quick = 1 - SKILL\.toolSpeed \* \(p\.camp\.skill\?\.tools \|\| 0\);/.test(mineSrc));
check('but not a night — a good axe does not shorten sleep',
  /p\.job === 'sleep' \? 600/.test(mineSrc)
  && !/'sleep' \? 600 \* quick/.test(mineSrc));

/* Stone travels the way food does, and that is what makes it a good rather
   than a number in a camp. */
check('stone is traded between bands',
  /const spareStone = \(home\.stone \|\| 0\) - SKILL\.stonePerTool \* 4;/.test(html)
  && /host\.stone = Math\.min\(SKILL\.stoneMax, \(host\.stone \|\| 0\) \+ moved\);/.test(html));
check('only what is spare, and only to a band that needs it',
  /if \(spareStone > 0 && \(host\.stone \|\| 0\) < SKILL\.stoneMax \* 0\.5\)/.test(html));
check('and dealing in it teaches dealing',
  /host\.stone = Math\.min[^]*?practise\(home, 'trade', SKILL\.perDeal\)/.test(html));

/* -------------------------------------------------------------------------
   A save has to fit through the door

   `LINE_MAX` is twenty thousand people who have ever lived. The server took a
   megabyte. Neither cap knew the other existed, so a long-running world
   produced a save the server refused — and the page read the refusal as a
   save, because it checked that the fetch had not thrown rather than that it
   had worked. A world too big to keep was a world silently not kept.
   ------------------------------------------------------------------------- */
group('the size of a saved world');

const LINE_MAX = Number((html.match(/LINE_MAX = (\d+)/) || [, 0])[1]);
/* Graves are never taken away (buryPerson), so there is no ceiling on them
   either. A save is promised to hold two hundred thousand: over a hundred
   thousand sim-days at the death rate the chronicle records. */
const GRAVES_PROMISED = 200000;
/* There is no ceiling on people any more (growPeople), so there is no worst
   case to measure against. This is the size a save is promised to fit at:
   twenty thousand, which is past anything that still draws. */
const PEOPLE_CAP = 20000;
const STATE_LIMIT = Number((serverSrc.match(/STATE_LIMIT = ([\d_]+)/) || [, '0'])[1].replace(/_/g, ''));

/* Measured off the shapes the code actually writes, not guessed: one lineage
   row, one grave, and one person with every skill they can have. */
const skillCount = Object.keys(
  (() => { const m = html.match(/SKILLS = \{([\s\S]*?)\n\};/); return m ? m[1] : ''; })()
    .split('\n').filter((l) => /^\s{2}\w+: \{ label:/.test(l))
    .reduce((o, l) => (o[l.trim().split(':')[0]] = 1, o), {})
).length;
const LINE_ROW = JSON.stringify({
  i: 12345, n: 'Khayuyeiss', s: 'f', f: 1234, m: 1235, fn: 'Braebreir', mn: 'Tsekash',
  b: 12345.67, d: 0, c: 'ND', g: 12, l: 'Lohae',
}).length;
const PERSON_ROW = 620 + skillCount * 14;   // the fixed fields, plus one entry a skill
const GRAVE_ROW = 60;
const worstSave = LINE_MAX * LINE_ROW + PEOPLE_CAP * PERSON_ROW + GRAVES_PROMISED * GRAVE_ROW;

check('the server takes the largest save the page can make',
  STATE_LIMIT > worstSave,
  `${(worstSave / 1048576).toFixed(1)}MB possible, ${(STATE_LIMIT / 1048576).toFixed(1)}MB allowed`);
/* And the other endpoints stay tight — they are small, fixed-shape messages,
   and a cap that fits them is a cap that catches a client gone wrong. */
check('but only that one endpoint is given the room',
  /const raw = await readJson\(req, STATE_LIMIT\);/.test(serverSrc)
  && /function readJson\(req, limit = BODY_LIMIT\)/.test(serverSrc));

/* The failure that mattered: a refusal read as a success. */
check('the page checks that a save worked, not that it did not throw',
  /if \(res\.ok\) return;/.test(moduleSource('save.js')));
check('and keeps the world in the browser when it did not',
  /localStorage\.setItem\(STATE_STORE, JSON\.stringify\(data\)\)/.test(moduleSource('save.js')));
/* Which it can only do if it is told. A dropped socket is not an answer. */
check('so too-large is answered rather than dropped',
  /err\.tooLarge = true;/.test(serverSrc)
  && /if \(err\.tooLarge\) \{[^]*?json\(res, 413/.test(serverSrc));
check('and logged as a warning, because it is not a crash',
  /console\.warn\(`  ! \$\{req\.method\} \$\{req\.url\}: \$\{err\.message\}`\)/.test(serverSrc));
/* Answered, then hung up. The other order gives the client a dropped
   connection, which it cannot tell from the server being gone — it falls back
   to the browser either way, but only one of those says why. */
check('the status goes out before the socket is closed',
  /req\.pause\(\);\s*reject\(err\);/.test(serverSrc)
  && /json\(res, 413, \{ error: err\.message \}\);\s*return req\.destroy\(\);/.test(serverSrc));

/* -------------------------------------------------------------------------
   Roles

   A band of eight is eight people doing whatever needs doing, and that is
   right: there is no room in a hungry camp for somebody who only knaps.
   ------------------------------------------------------------------------- */
group('who does what');

const roleSrc = moduleSource('skills.js');

/* Specialising is something a band can afford, not a setting. Both conditions
   already meant something before this existed. */
check('a band specialises only when it can afford to',
  /const ROLE_AT = \{ families: 6, days: 8 \}/.test(roleSrc)
  && /if \(adults\.length < ROLE_AT\.families \|\| fed < ROLE_AT\.days\)/.test(roleSrc));
/* And un-specialises. A bad winter puts everybody back on the hill, which is
   the point of the condition rather than a tidy-up. */
check('and gives the roles up again when it cannot',
  /for \(const p of folk\) p\.role = null;\s*return;/.test(roleSrc));

/* The one the whole thing is for. */
check('the chief does not forage or hunt',
  /chief:\s*\{ job: 'tend',\s*refuses: \['gather', 'hunt', 'quarry'\]/.test(roleSrc));
check('and is the first role handed out',
  roleSrc.indexOf("chief.role = 'chief'") < roleSrc.indexOf('for (const [name, role] of Object.entries(ROLES))'));

/* A role is a bias, not an assignment: a knapper still eats, still sleeps and
   still runs from a tiger. */
check('a role leans the choosing rather than replacing it',
  /if \(p\.role\) for \(const w of weights\) w\[1\] \*= roleWeight\(p, w\[0\]\);/.test(moduleSource('move.js')));
check('and refusing a job is a zero, not a rule elsewhere',
  /if \(role\.refuses\.includes\(job\)\) return 0;/.test(roleSrc)
  && /return job === role\.job \? LEAN : 1;/.test(roleSrc));

/* Who gets which is what they already know — the same number pickChief reads
   and the same one that caps what a camp can learn. */
check('roles go to whoever the band is already best at it through',
  /\.sort\(\(a, b\) => \(b\.knows\?\.\[role\.by\] \|\| 0\) - \(a\.knows\?\.\[role\.by\] \|\| 0\)\)/.test(roleSrc));
check('and nobody is made a quarrier who has never seen a rock',
  /if \(\(able\[i\]\.knows\?\.\[role\.by\] \|\| 0\) <= 0\.02\) break;/.test(roleSrc));
/* Shares, so a village of forty has four hunters and a camp of ten has one. */
check('how many of each is a share of the band',
  /const want = Math\.max\(1, Math\.round\(adults\.length \* role\.share\)\)/.test(roleSrc));
check('and nobody holds two', /taken\.add\(able\[i\]\.id\)/.test(roleSrc)
  && /\.filter\(\(p\) => !taken\.has\(p\.id\)\)/.test(roleSrc));

/* Worked out for the band at once, because the shares are a fact about the
   band: you cannot ask "am I the healer" without knowing who else wanted to
   be. Once a day, which is the cadence everything else about a band moves on. */
check('the band works out who is who once a day',
  /assignRoles\(c, people\.filter\(\(p\) => p\.camp === c\)\)/.test(html));

/* And it is visible, or it is a number in a file. */
check('the card says what somebody is',
  /ROLE_WORDS\[p\.role\] \|\| p\.role/.test(moduleSource('chronicle.js'))
  && /<th>is<\/th>/.test(html));
/* Forager is what everybody is until the band can afford otherwise, and a card
   that says it of half the village says nothing. */
check('but says nothing of the ones who are just the band',
  /p\.role !== 'forager'/.test(moduleSource('chronicle.js'))
  && !/forager: '/.test(moduleSource('chronicle.js')));

/* Run rather than read. The shares, the ordering and the affordability gate are
   the whole of this feature, and a regex on any of them would pass just as
   happily with the comparison the wrong way round. */
/* `moduleSource` has already stripped `export` off the declarations — searching
   for it here found nothing and sliced from the end of the file, which is a
   ReferenceError three lines later and no hint as to why. */
const roleApi = new Function('clamp',
  roleSrc.slice(roleSrc.indexOf('const ROLE_AT'))
  + '\nreturn { ROLES, ROLE_AT, LEAN, roleWeight, assignRoles };')(
  (v, a, b) => Math.max(a, Math.min(b, v)));

/** A band of `n` adults, each best at one thing, with `days` of food. */
function bandOf(n, days, best = {}) {
  const folk = Array.from({ length: n }, (_, i) => ({
    id: i + 1, child: false, knows: { ...best[i] },
  }));
  const camp = { food: days, need: 1, chief: folk[0]?.id };
  return { camp, folk };
}

{
  // Too small to divide the work, however well fed.
  const { camp, folk } = bandOf(4, 40);
  roleApi.assignRoles(camp, folk);
  check('four people are four people, not a chief and three specialists',
    folk.every((p) => p.role === null));
}
{
  // Big enough, and starving.
  const { camp, folk } = bandOf(20, 2);
  roleApi.assignRoles(camp, folk);
  check('and a hungry village goes back to everybody foraging',
    folk.every((p) => p.role === null));
}
{
  const best = { 3: { spears: 0.9 }, 4: { herbs: 0.8 }, 5: { mining: 0.7 } };
  const { camp, folk } = bandOf(20, 40, best);
  roleApi.assignRoles(camp, folk);
  check('a fed village divides the work', folk.some((p) => p.role && p.role !== 'forager'));
  check('the chief is the chief', folk[0].role === 'chief');
  /* The one the whole thing is for. */
  check('and does not hunt or forage',
    roleApi.roleWeight(folk[0], 'hunt') === 0 && roleApi.roleWeight(folk[0], 'gather') === 0,
    `hunt ${roleApi.roleWeight(folk[0], 'hunt')}, gather ${roleApi.roleWeight(folk[0], 'gather')}`);
  check('but still eats, sleeps and tends the fire',
    roleApi.roleWeight(folk[0], 'sleep') > 0 && roleApi.roleWeight(folk[0], 'tend') > 1);

  check('the best spear-hand becomes a hunter', folk[3].role === 'hunter', String(folk[3].role));
  check('the one who knows herbs becomes the healer', folk[4].role === 'healer', String(folk[4].role));
  check('and the one who has been to the rocks, the quarrier',
    folk[5].role === 'quarrier', String(folk[5].role));
  check('nobody holds two', new Set(folk.filter((p) => p.role && p.role !== 'forager')
    .map((p) => p.id)).size === folk.filter((p) => p.role && p.role !== 'forager').length);
  /* Everybody else is the band, and most of a band always will be. */
  check('and most of the village is still the village',
    folk.filter((p) => p.role === 'forager').length > folk.length / 2,
    `${folk.filter((p) => p.role === 'forager').length} of ${folk.length}`);
  /* A hunter leans toward hunting without being unable to do anything else. */
  check('a role leans rather than dictates',
    roleApi.roleWeight(folk[3], 'hunt') === roleApi.LEAN
    && roleApi.roleWeight(folk[3], 'gather') === 1);
}
{
  // Nobody knows anything: no roles but the chief, because the band has no
  // grain to specialise along yet.
  const { camp, folk } = bandOf(20, 40);
  roleApi.assignRoles(camp, folk);
  check('a village that knows nothing yet has only a chief',
    folk.filter((p) => p.role && p.role !== 'forager').length === 1,
    folk.filter((p) => p.role && p.role !== 'forager').map((p) => p.role).join(' '));
}
{
  // Shares: a bigger band has more of each.
  const best = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i, { spears: 0.9 - i * 0.01 }]));
  const big = bandOf(40, 40, best);
  const small = bandOf(10, 40, best);
  roleApi.assignRoles(big.camp, big.folk);
  roleApi.assignRoles(small.camp, small.folk);
  const hunters = (f) => f.filter((p) => p.role === 'hunter').length;
  check('a village has more hunters than a camp does',
    hunters(big.folk) > hunters(small.folk),
    `${hunters(big.folk)} of 40 against ${hunters(small.folk)} of 10`);
}

/* How wide and how strong a path comes out. Both are a fact about three
   numbers — where the browning starts, where it reaches full, and how far the
   colour goes — and all three were set once and never measured. A route walked
   twenty times painted 3.8 m across at 88%, which is a road. */
{
  const lo = Number((moduleSource('scene.js').match(/smoothstep\(([\d.]+), [\d.]+, worn\)/) || [, 0])[1]);
  const hi = Number((moduleSource('scene.js').match(/smoothstep\([\d.]+, ([\d.]+), worn\)/) || [, 0])[1]);
  const deep = Number((moduleSource('paths.js').match(/uPathDeep: \{ value: ([\d.]+) \}/) || [, 0])[1]);
  check('a path is a trodden line, not a road', lo >= 0.35 && hi > lo && deep <= 0.6,
    `browns from ${lo} to ${hi}, at most ${deep} of the way`);
  /* And the grass gives up before the earth shows, which is the order it
     happens in: thin first, bare after. */
  const showing = Number((moduleSource('paths.js').match(/showing: ([\d.]+),/) || [, 0])[1]);
  check('the grass thins before the ground browns', showing < lo,
    `grass at ${showing}, ground at ${lo}`);
}

/* -------------------------------------------------------------------------
   Why somebody is walking over the hill

   "Walking to the next band" says where and not what, and a visit is the one
   errand in this world with several completely different points to it.
   ------------------------------------------------------------------------- */
group('what a visit is for');

/* Run rather than read: the reasons are an ordering, and an ordering is exactly
   what a regex cannot check. */
const visitSrc = moduleSource('chronicle.js');
const visitWords = new Function('VISIT', 'FOOD', 'SKILL', 'SKILLS',
  visitSrc.slice(visitSrc.indexOf('function visitWords'),
    visitSrc.indexOf('\n}', visitSrc.indexOf('function visitWords')) + 2)
  + '\nreturn visitWords;')(
  { begFrom: 0.70, learn: 0.90 },
  { comfortable: 6 },
  { stonePerTool: 0.6, stoneMax: 40 },
  { drying: { of: 'curing' } });

const aBand = (over = {}) => ({
  name: 'Tsekash', hunger: 0.2, food: 100, need: 1, stone: 0, skill: {}, ...over,
});
const goer = (over = {}) => ({ camp: aBand(), visiting: aBand({ name: 'Ndahouth' }), knows: {}, ...over });

check('a visit says where it is going',
  visitWords(goer(), true).includes('Ndahouth'), visitWords(goer(), true));
/* Somebody starving is going for food whatever else is in their arms. */
check('a hungry band goes to ask for food',
  visitWords(goer({ camp: aBand({ hunger: 0.9 }) }), true) === 'walking to Ndahouth, to ask for food',
  visitWords(goer({ camp: aBand({ hunger: 0.9 }) }), true));
check('and a band with a surplus takes some over',
  visitWords(goer({
    camp: aBand({ food: 100, need: 1 }),
    visiting: aBand({ name: 'Ndahouth', hunger: 0.8 }),
  }), true) === 'walking to Ndahouth, with food');
check('stone goes the same way',
  visitWords(goer({
    camp: aBand({ stone: 30 }), visiting: aBand({ name: 'Ndahouth', stone: 0, hunger: 0.1 }),
  }), true) === 'walking to Ndahouth, with stone to trade');
/* The quietest of the three and the one that changes the island. */
check('and what one band knows, when there is nothing else to carry',
  visitWords(goer({ knows: { drying: 0.8 } }), true)
    === 'walking to Ndahouth, to show them curing',
  visitWords(goer({ knows: { drying: 0.8 } }), true));
check('but not something they already know',
  !visitWords(goer({
    knows: { drying: 0.8 }, visiting: aBand({ name: 'Ndahouth', skill: { drying: 0.9 } }),
  }), true).includes('show'));
check('and otherwise, to see them',
  visitWords(goer(), true) === 'walking to Ndahouth, to see them');
/* Arrived is the same errand, standing still. */
check('and it reads as arrived once they are there',
  visitWords(goer(), false).startsWith('at Ndahouth'), visitWords(goer(), false));
/* A visit with no destination yet is still a visit. */
check('somebody with nowhere to go yet still says something',
  visitWords({ camp: aBand(), knows: {} }, true) === 'walking to the next band');

/* -------------------------------------------------------------------------
   Ground that gives out

   Foraging read a noise field and nothing else, so a patch was worth exactly as
   much on its thousandth visit as its first — and every forager in a band works
   the same best spot out of the same numbers. The whole band walked to one
   place for ever, and there was no mechanism by which it could have done
   anything else.
   ------------------------------------------------------------------------- */
group('where the food comes from');

check('the ground remembers what has been taken off it',
  /const FORAGED = \{/.test(html) && /function takeForage\(x, z\)/.test(html));
check('and richness is what is there less what was picked',
  /\* \(1 - pickedAt\(x, z\)\);/.test(html));
/* Taken where the trip actually ended, not where it was aimed: a patch somebody
   gave up halfway to is not a patch anybody stripped. */
check('taken where the trip ended, not where it was aimed',
  /takeForage\(p\.x, p\.z\);/.test(moduleSource('move.js')));
/* Proportional, like the fruit: the more that was taken the faster it returns,
   so ground recovers rather than running on a timer. */
check('and it grows back, proportionally to what is missing',
  /const left = picked\[k\] - picked\[k\] \* back;/.test(html)
  && /recoverForage\(owed\);/.test(moduleSource('main.js')));
check('there is always something there', /floor: 0\.15,/.test(html));
/* Eight metres a cell is about the ground one person works in an afternoon, and
   one float apiece is 640 KB on a 3200 m island. */
check('the grid is coarse enough to be cheap', (() => {
  const cell = Number((html.match(/FORAGED = \{\s*\n\s*cell: (\d+)/) || [, 0])[1]);
  return cell >= 6 && cell <= 16 ? true : `${cell} m a cell`;
})() === true);
/* It belongs to the ground, not to a band: two camps sharing a hillside strip
   it between them, which is what GROUND.range was already about and had no
   physical basis for until now. */
check('and it belongs to the ground rather than to a band',
  !/camp\.picked/.test(html) && /let picked = null, pickedCols = 0;/.test(html));

/* And the second half: twenty people reading the same numbers is a band with
   one opinion. */
check('two foragers leaving together do not have to agree',
  /const guess = 0\.78 \+ luck\(\) \* 0\.44;/.test(html));

/* -------------------------------------------------------------------------
   Taking it instead

   A band with a full pile and a hungry neighbour is a fact about the world
   before it is a fact about either of them. Until now the neighbour could only
   walk over and ask, and a band with nothing to spare said no by having nothing.
   ------------------------------------------------------------------------- */
group('raiding');

/* The ordering that is the whole ethics of it, and it is one comparison: a band
   that could still walk over and ask, asks. */
{
  const beg = Number((html.match(/begFrom: ([\d.]+),/) || [, 0])[1]);
  const raid = Number((html.match(/hungry: ([\d.]+),/) || [, 0])[1]);
  check('a band asks before it takes', raid > beg, `raids at ${raid}, begs at ${beg}`);
}
check('and only when there is somebody worth walking to',
  /function raidTarget\(camp\)/.test(html)
  && /if \(daysOfFood\(c\) < RAID\.worth && \(c\.stone \|\| 0\) < SKILL\.stoneMax \* 0\.3\) continue;/.test(html));
check('and not twice in a row', /simDay - \(p\.camp\.lastRaid \?\? -99\) > RAID\.every/.test(moduleSource('move.js')));
/* The same walk a visit is. There is no new place and no new resource. */
check('a raid is the same walk over the hill with a different reason',
  /if \(p\.job === 'raid'\) \{[^]*?p\.raiding = mark;/.test(moduleSource('move.js')));
check('and it has to arrive, like a visit',
  /if \(Math\.hypot\(p\.x - mark\.x, p\.z - mark\.z\) < CAMP_CLEARING \* 1\.6\)/.test(moduleSource('move.js')));
/* Five people arriving is one raid, not five. */
check('the party is resolved once, not once a raider',
  /resolveRaid\(party, mark\)/.test(moduleSource('move.js'))
  && /p\.raiding = null;/.test(moduleSource('move.js')));

/* And the odds, which are the whole of it. Run rather than read. */
const strengthOf = new Function('SKILL',
  html.slice(html.indexOf('function strengthOf'), html.indexOf('\n}', html.indexOf('function strengthOf')) + 2)
  + '\nreturn strengthOf;')({ warEdge: 1.5 });
const folkOf = (camp, n, over = {}) => Array.from({ length: n }, () => ({
  camp, child: false, sick: false, energy: 1, ...over,
}));
{
  const a = { skill: { war: 0 } }, b = { skill: { war: 0 } };
  check('more people is more strength',
    strengthOf(a, folkOf(a, 10)) > strengthOf(b, folkOf(b, 5)));
  check('children and the ill do not count',
    strengthOf(a, folkOf(a, 5).concat(folkOf(a, 5, { child: true }))) === strengthOf(b, folkOf(b, 5)));
  check('a tired band is a weaker one',
    strengthOf(a, folkOf(a, 5, { energy: 0.1 })) < strengthOf(b, folkOf(b, 5)));
  check('a warrior counts for more than a person',
    strengthOf(a, folkOf(a, 5, { role: 'warrior' })) > strengthOf(b, folkOf(b, 5)));
  /* Practice counts for more than numbers, which is what makes defending worth
     anything and raiding a gamble rather than an arithmetic problem. */
  const practised = { skill: { war: 1 } };
  check('and a practised band beats a bigger unpractised one',
    strengthOf(practised, folkOf(practised, 6)) > strengthOf(b, folkOf(b, 12)),
    `${strengthOf(practised, folkOf(practised, 6)).toFixed(1)} against ${strengthOf(b, folkOf(b, 12)).toFixed(1)}`);
}
/* Both sides learn, which is the uncomfortable part and the true one. */
check('both sides get better at it',
  /practise\(home, 'war', SKILL\.perRaid\);\s*practise\(host, 'war', SKILL\.perRaid\);/.test(html));
check('and defending your own camp is worth something',
  /const theirs = strengthOf\(host, people\) \* RAID\.home;/.test(html)
  && Number((html.match(/home: ([\d.]+),/) || [, 0])[1]) > 1);
/* What changes hands is what was already there. */
check('a raid moves food and stone, and invents neither',
  /host\.food -= food;\s*home\.food \+= food;/.test(html)
  && /host\.stone = \(host\.stone \|\| 0\) - stone;/.test(html));
check('and the pile it lands in is still capped',
  /home\.stone = Math\.min\(SKILL\.stoneMax, \(home\.stone \|\| 0\) \+ stone\);/.test(html));
/* Somebody may not come back, and the losing side pays it. */
check('a raid can cost somebody', /killPerson\(i, 'raid'\)/.test(html)
  && /raid: 'a raid'/.test(html) && /raid: \(p, age\) =>/.test(html));

/* The warrior, who is not a job — there is nothing to do all day. */
check('a warrior is a role a band keeps once it has something worth taking',
  /warrior: \{ job: 'tend',\s*refuses: \[\],\s*by: 'war'/.test(moduleSource('skills.js')));
/* And what a band is holding, which is what makes it a target. */
check('the card says what a band has worth taking',
  /function wealthOf\(camp\)/.test(html) && /worth taking<\/span>/.test(html));

/* -------------------------------------------------------------------------
   Fish

   The island has had water round it since the first frame and nothing has ever
   eaten out of it. A coast was the one piece of ground worth standing on for a
   reason nothing in the simulation could see.
   ------------------------------------------------------------------------- */
group('fishing');

const larderSrc = moduleSource('larder.js');

/* Fishing is foraging with a different larder, and it is built that way: the
   same trip, the same completion, the same haul into the same store, and the
   same ground that runs down. */
check('a catch lands in the same haul as a basket of berries',
  /if \(p\.job === 'fish'\) \{[^]*?p\.haul \+= got;/.test(moduleSource('move.js')));
check('and takes off the same ground that runs down',
  /if \(p\.job === 'fish'\) \{[^]*?takeForage\(spot\.x, spot\.z\);/.test(moduleSource('move.js')));
/* Baskets carry fish as well as berries. */
check('and the same baskets carry it',
  /if \(p\.job === 'fish'\) \{[^]*?SKILL\.basketHaul \* p\.camp\.skill\.baskets/.test(moduleSource('move.js')));

/* Somewhere to stand: dry ground with water in front of it, found once with the
   camp, because a coast does not move. */
check('a band knows where its own water is',
  /camp\.shore = nearestShore\(camp\.x, camp\.z\);/.test(moduleSource('people.js'))
  && /function nearestShore\(x, z, within = FISH\.reach\)/.test(larderSrc));
check('and a landlocked band forages instead of standing about',
  /p\.job = 'gather';\s*\/\/ landlocked/.test(moduleSource('move.js')));

/* The good water is the deep water, and most of it is out of reach from the
   bank — which is what a raft is for, and the only thing in this world that
   opens ground rather than improving what a band already does with it. */
check('the fish are out in deep water',
  /const deep = Math\.max\(0, Math\.min\(1, \(SEA - h - FISH\.shallow\) \/ FISH\.deep\)\);/.test(larderSrc));
check('and there is no fishing at all without a raft',
  /if \(!camp\?\.raft\) return 0;/.test(larderSrc)
  && /\['fish', p\.camp\.raft && !raftBusy\(p\.camp\) \? FISH\.chance/.test(moduleSource('move.js'))
  && !/nearestWater\(p\.x, p\.z, SHOW_WITHIN\)/.test(moduleSource('reach.js')));
check('a band on a coast builds one out of the wood it has stacked',
  /if \(camp\.shore && !camp\.raft && camp\.wood >= WOOD\.raft\) \{\s*camp\.wood -= WOOD\.raft;\s*camp\.raft = true;/.test(moduleSource('wood.js')));
/* Wood: a skill, an errand, a stack by the granaries. */
check('people go out for wood, with a raft to build or the stack low',
  /\['wood', !p\.child \? woodWant\(p\.camp\) \*/.test(moduleSource('move.js'))
  && /if \(camp\.shore && !camp\.raft\) return WOOD\.chance;/.test(moduleSource('wood.js'))
  && /return \(camp\.wood \|\| 0\) < WOOD\.keep \? WOOD\.chance \* 0\.35 : 0;/.test(moduleSource('wood.js')));
check('to a tree near the fire, and back with logs on the shoulder',
  /if \(p\.job === 'wood'\) \{\s*const t = pickTree\(camp, luck\);/.test(moduleSource('move.js'))
  && /if \(p\.job === 'wood'\) chopDone\(p\);/.test(moduleSource('move.js'))
  && /bagAdd\(p, 'wood', logs\);/.test(moduleSource('wood.js')));
check('and put away, the logs go on the stack',
  /if \(p\.bag\?\.wood > 0\) \{ storeWood\(p\.camp, p\.bag\.wood\); p\.bag\.wood = 0; \}/.test(bodyOf('bankLoad') || ''));
check('woodcraft is learned at the tree', /practise\(p\.camp, 'woodcraft', WOOD\.practise\);/.test(moduleSource('wood.js')));
check('and E at a tree cuts wood, for the person you are playing',
  /kind: 'wood'/.test(bodyOf('actionTargets') || '') && /a\.kind === 'wood'\) job = a\.kind;/.test(bodyOf('startAct') || ''));
check('a log weighs something, and the stack is drawn',
  Number(html.match(/wood: ([\d.]+),\s*\/\/ a log/)?.[1]) > 0 && /updateWoodpiles\(\);/.test(moduleSource('main.js')));
/* Everything bagKind can say has a shape on the shoulder or in the basket: the
   figure is drawn off that table, and a load it does not know is a crash. */
check('and logs are drawn on the shoulder of whoever carries them',
  /\n\s*wood:\s+\{ scale: new THREE\.Vector3\([^)]*\), hex: 0x[0-9a-f]+, basket: false \},/.test(moduleSource('move.js'))
  && /if \(bag\.wood > 0\) return 'wood';/.test(moduleSource('bag.js')));
check('and the band keeps its stack over a reload', /wd: r2\(c\.wood \|\| 0\)/.test(moduleSource('save.js'))
  && /camps\[i\]\.wood = Number\(c\.wd\) \|\| 0;/.test(moduleSource('save.js')));
check('the raft is on the water, tied up at a dock at the landing',
  /updateRafts\(\);/.test(moduleSource('main.js')) && /function dockOf\(camp\)/.test(larderSrc)
  && /raftMesh\.setMatrixAt\(i, _m\.compose\(_v, _q, _s\)\);/.test(moduleSource('rafts.js')));
check('the band\'s fishers take it out to deep water and back',
  /if \(p\.raftTrip \|\| \(p\.job === 'fish' && p\.state === 'work'\)\) raftTrip\(p\);/.test(moduleSource('move.js'))
  && /const spot = pickFishing\(camp, luck\);/.test(moduleSource('rafts.js'))
  && /const spot = p\.raftTrip \? p\.raftTrip\.spot : p;/.test(moduleSource('move.js')));
check('one raft, one fisher at a time',
  /return Boolean\(r\) && \(Boolean\(r\.raftTrip\) \|\| r\.onRaft === camp\) && people\.includes\(r\);/.test(moduleSource('rafts.js')));
check('and you can take it out yourself: E at the landing, paddle, fish, E back at the dock',
  /kind: 'raft'/.test(bodyOf('actionTargets') || '') && /kind: 'moor'/.test(bodyOf('actionTargets') || '')
  && /if \(a\.kind === 'raft' \|\| a\.kind === 'moor'\)/.test(bodyOf('startAct') || '')
  && /p\.onRaft \? raftStep\(p, step\) : stepPerson\(p, step\)/.test(moduleSource('move.js')));
check('a raft, and whoever is out on one, survive a reload — ashore',
  /raft: c\.raft \? 1 : 0/.test(moduleSource('save.js')) && /x: r2\(landing\(p\)\.x\)/.test(moduleSource('save.js')));

/* And the sea does not have a winter the way the ground does, which is the
   whole point of a coast. */
check('winter takes less off the water than off the ground', (() => {
  const water = Number((larderSrc.match(/winter: ([\d.]+),/) || [, 0])[1]);
  const land = 0.35;                       // SEASON.forage, winter
  return water > land ? true : `${water} against ${land} on land`;
})() === true);

/* And the mistake foraging already made once: one landing is everybody in the
   same water until it is fished out, with nothing telling them to walk along
   the beach. */
check('fishing spreads over the water rather than sitting on one spot',
  /function pickFishing\(camp, luck\)/.test(larderSrc)
  && /const value = \(worth - away \/ 700\) \* \(0\.78 \+ luck\(\) \* 0\.44\);/.test(larderSrc));

/* -------------------------------------------------------------------------
   And where the larder lives
   ------------------------------------------------------------------------- */
check('where food comes from is its own module',
  srcFiles.includes('larder.js') && /const FORAGED = \{/.test(larderSrc)
  && /const FISH = \{/.test(larderSrc));
/* It is handed positions and asked what they are worth: nothing in it knows
   about people, camps or days.

   Asserted on the code with the comments taken out, because the paragraph
   explaining this rule says "people, camps or days" and a grep over the whole
   file finds it there. That is the second check this session to fail on its own
   explanation. */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check('and it knows nothing about people or days',
  !/\bpeople\b/.test(codeOnly(larderSrc)) && !/simDay/.test(codeOnly(larderSrc))
  && !/from '\.\/(people|life)\.js'/.test(larderSrc),
  (codeOnly(larderSrc).match(/\bpeople\b|simDay/g) || []).join(' '));
check('life.js passes it through the way it does the skills',
  /export \{\s*FISH, FORAGED, buildForaged[^]*?\} from '\.\/larder\.js';/.test(
    rawSources[srcFiles.indexOf('life.js')] || ''));

/* -------------------------------------------------------------------------
   Nothing is drawn while nothing is watching

   `stepWorld` sets `drawingWorld` false and the fast-forward runs thousands of
   steps under it. Everything that poses a figure has to be behind that flag,
   and it is easy to put it on one branch and not the other.
   ------------------------------------------------------------------------- */
group('the unwatched world');

const unwatchedSrc = moduleSource('move.js');

/* The one that was missed. Somebody indoors is parked out of sight with
   seventeen zeroed matrices, and that was happening for every hidden person on
   every step of a run nobody was looking at: six percent of a fast-forward,
   spent on people asleep in their huts. */
check('parking somebody out of sight is drawing them',
  /if \(hidden\) \{[^]*?if \(drawingWorld\) \{\s*for \(const key in personParts\)/.test(unwatchedSrc));
check('and so is posing them',
  /if \(drawingWorld\) writePerson\(p, i\);/.test(unwatchedSrc));
/* Nothing was written, so there is nothing to upload. */
check('and an unwatched step uploads nothing',
  /if \(drawingWorld\) \{\s*for \(const key in personParts\) personParts\[key\]\.instanceMatrix\.needsUpdate = true;/.test(unwatchedSrc));
/* The herds were fixed for this once; the rule is the same for both. */
check('the herds already knew', /if \(!drawingWorld\) continue;/.test(moduleSource('wildlife.js')));

/* -------------------------------------------------------------------------
   And two scans that a busier world made expensive
   ------------------------------------------------------------------------- */
/* Picking walked every fruit on the island — and walked all of them precisely
   when there were none within reach, which is most trips. */
check('picking fruit looks at the ground you are standing on',
  /const here = orchard\.buckets\?\.get\(`\$\{bi\},\$\{bj\}`\);/.test(html)
  && /const ORCHARD_BUCKET = 12;/.test(moduleSource('world.js')));
check('and the index is built once, with the trees that carry it',
  /buckets\.set\(key, \[i\]\)/.test(moduleSource('world.js')));
/* The record was serialised and handed to localStorage on every line logged. */
check('the chronicle is written once a day, not once a line',
  /chronicleDirty = true;/.test(html) && /function flushChronicle\(\)/.test(html)
  && /flushChronicle\(\);/.test(html));
/* And recovery walks the ground somebody has taken from, not the island. */
check('and the ground recovers over what was worked, not over everything',
  /for \(const k of worked\)/.test(moduleSource('larder.js'))
  && /worked\.delete\(k\)/.test(moduleSource('larder.js')));

/* -------------------------------------------------------------------------
   Why somebody is at the fire

   "At the fire" is where, and for a third of a band on any given afternoon it
   is the whole caption — the least informative thing the page says about the
   most people.
   ------------------------------------------------------------------------- */
group('at the fire');

const fireSay = new Function('P', 'seasonName',
  sayingSrc.slice(sayingSrc.indexOf('function fireWords'),
    sayingSrc.indexOf('\n}', sayingSrc.indexOf('function fireWords')) + 2)
  + '\nreturn fireWords;');
const atFire = (p, hour = 12, season = 'summer') => fireSay({ time: hour }, season)(p);
const person = (over = {}) => ({ energy: 1, camp: { hunger: 0.1 }, ...over });

check('the one whose job it is says so', atFire(person({ role: 'keeper' })) === 'keeping the fire');
/* Somebody with nothing left is resting whatever else is true of the evening. */
check('and somebody with nothing left is resting, whatever else is true',
  atFire(person({ energy: 0.1, role: null }), 23, 'winter') === 'resting by the fire');
check('an empty store is worth saying',
  atFire(person({ camp: { hunger: 0.95 } })) === 'at the fire, with nothing in the store');
check('and so is the cold', atFire(person(), 12, 'winter') === 'at the fire, out of the cold');
/* Night is last of the four because it is the least surprising: everybody is at
   the fire at night, and saying so of all of them is saying nothing. */
check('night is the least surprising reason and comes last',
  atFire(person(), 23) === 'sitting up at the fire'
  && atFire(person({ camp: { hunger: 0.95 } }), 23) === 'at the fire, with nothing in the store');
check('and an ordinary afternoon says the ordinary thing',
  atFire(person()) === 'at the fire');
/* Only when they are actually there. */
check('somebody still walking to it is still walking to it',
  /if \(p\.job === 'tend' && p\.speed <= WALKING_AT\) return fireWords\(p\);/.test(sayingSrc));

/* -------------------------------------------------------------------------
   What they are carrying
   ------------------------------------------------------------------------- */
group('the load');

/* Berries, a joint of meat and a morning's fish all came home as the same brown
   block — the one moment of a forager's day you can watch pay off, saying
   nothing about what they had been doing. */
check('a load takes the shape of the thing it is',
  /const LOADS = \{/.test(moduleSource('move.js'))
  && ['berries', 'fruit', 'fish', 'game', 'stone'].every((k) =>
    new RegExp(`${k}:\\s*\\{ scale:`).test(moduleSource('move.js'))));
check('and a catch is not the same shape as a kill', (() => {
  const src = moduleSource('move.js');
  const grab = (k) => (src.match(new RegExp(`${k}:\\s*\\{ scale: new THREE\\.Vector3\\(([\\d., ]+)\\)`)) || [, ''])[1];
  return grab('fish') !== grab('game') && grab('fish') !== grab('berries');
})());
/* The things you pick go in a basket; an animal goes over the shoulders. */
check('berries, fruit and fish come home in a basket, and an animal does not', (() => {
  const src = moduleSource('move.js');
  const inBasket = (k) => new RegExp(`${k}:\\s*\\{[^}]*basket: true`).test(src);
  return inBasket('berries') && inBasket('fruit') && inBasket('fish') && !inBasket('game');
})());
check('the basket is a part of a person, painted wicker',
  PERSON_PARTS.basket === 1 && /personParts\.basket\.setColorAt\(i, _c\.setHex\(0x9a7446\)\)/.test(html));
check('and heaped to how full it is',
  /const full = clamp\(p\.haul \/ BASKET_FULL, [\d.]+, [\d.]+\);/.test(moduleSource('move.js')));
check('and put away with the load',
  /personParts\.basket\.setMatrixAt\(i, HIDDEN\);\s*personParts\.load\.setMatrixAt\(i, HIDDEN\);\s*wear\(p, 'cargo', null\);\s*p\.loadKind = null;/.test(moduleSource('move.js')));
/* The colour of a load is a fact about the errand, not about the frame. */
check('the colour is written when it changes hands, not every frame',
  /if \(p\.loadKind !== key\) \{/.test(moduleSource('move.js'))
  && /p\.loadKind = null;/.test(moduleSource('move.js')));

/* Counted where it is made, in the units you would count it in, and the food
   the store gets is the sum it always was. */
check('a foraging trip is counted as berries and fruit',
  /bagAdd\(p, 'berries', Math\.max\(1, Math\.round\(ground \* hands \/ BAG\.berry\)\)\);\s*bagAdd\(p, 'fruit', Math\.round\(fruit \/ ORCHARD\.worth\)\);/.test(html)
  && /const got = \(ground \+ fruit\) \* baskets \* childWorth\(p\) \* P\.abundance;/.test(html));
/* Food security is a setting: every yield the island has goes through it. */
check('every basket, catch and kill is scaled by ABUNDANCE',
  (html.match(/\* P\.abundance;/g) || []).length >= 4
  && /childWorth\(p\) \* P\.abundance;/.test(html)
  && /const meat = q\.meat \* \(a\.scale \|\| 1\) \* P\.abundance;/.test(html)
  && /const meat = QUARRY\[key\]\.meat \* \(a\.scale \|\| 1\) \* P\.abundance;/.test(html));
check('a catch as fish', /bagAdd\(p, 'fish', Math\.max\(1, Math\.round\(got \/ BAG\.fish\)\)\);/.test(html));
check('a kill as the animal it was', /bagAdd\(p, 'game', 1, prey\.pack\.spec\.key\);/.test(html));
check('and the basket is emptied with the haul, into the store',
  /p\.haul = 0;\s*emptyBag\(p\);/.test(html));
check('and what is in it survives a reload',
  /bg: p\.haul > 0 && p\.bag \?/.test(html) && /bag: Array\.isArray\(r\.bg\)/.test(html));

/* -------------------------------------------------------------------------
   A face, and where the detail goes

   A face is legible at about four metres. So is a knuckle. Everything a person
   is made of is an InstancedMesh sized to the whole island, so eyes on
   everybody cost four thousand instances to be seen on one figure.
   ------------------------------------------------------------------------- */
group('the near set');

const nearSrc = moduleSource('people.js');

check('detail for one person is not instanced for two thousand',
  /function buildNearParts\(\)/.test(nearSrc)
  && /new THREE\.Mesh\(geo, new THREE\.MeshLambertMaterial/.test(nearSrc));
/* It costs the same at any population, which is the whole reason it exists. */
check('and a village draws the same face as a band of nine',
  !/nearParts\[[^\]]*\]\.setMatrixAt/.test(moduleSource('move.js')));

/* It hangs off the matrix writePerson has already worked out, so a face cannot
   drift from the head it is on — that matrix carries the build, the crouch, the
   bob of the walk and which way they are looking. */
check('the face is on everybody now, and hangs off the head it belongs to',
  /for \(const group of HEAD_GROUPS\) \{\s*const key = wear\(p, group, headKey\(p, group\)\);\s*if \(key\) looks\[key\]\.setMatrixAt\(p\.wornAt\[group\], _mHead\);/.test(moduleSource('move.js')));
check('and sits on the head that is drawn, not the one the library assumed',
  /function headOut\(/.test(looksSrc) && /headFront\(x, y\) \+ depth \* 0\.25/.test(looksSrc));

/* Only on the person being followed, and only in the view where you can see
   them. */
check('it is worn by whoever you are behind',
  /if \(nearParts && i === followIdx && P\.view === 'follow' && !closed\)/.test(moduleSource('move.js')));
/* And the failure that matters: a face left on somebody you stopped following. */
check('and put away the moment that is nobody',
  /if \(!nearShown\) hideNearParts\(\);\s*nearShown = false;/.test(moduleSource('move.js'))
  && /function hideNearParts\(\)/.test(nearSrc));
/* Dropped where the world is torn down, which is world.js — the meshes go with
   tribeGroup and only the handle on them is left to let go of. */
check('a new world does not inherit the last one\'s face',
  /setGraveMesh\(null\);[^]*?setNearParts\(null\);/.test(moduleSource('world.js')));

/* The fist is the one piece of hand detail that survives being thirty metres
   away, and it costs nothing: everybody already has this box, and closing it is
   a scale on it. */
check('a hand closes round what it is holding',
  /const closed = p\.carry \|\| \(p\.hasSpear && side === 0\) \|\| p\.state === 'work';/.test(moduleSource('move.js'))
  && /if \(closed\) _mChain\.scale\(FIST\);/.test(moduleSource('move.js')));
check('and a fist is shorter and thicker than a hand hanging', (() => {
  const m = moduleSource('move.js').match(/FIST = new THREE\.Vector3\(([\d., ]+)\)/);
  const [x, y, z] = m[1].split(',').map(Number);
  return y < 1 && x > 1 && z > 1 ? true : `${x} ${y} ${z}`;
})() === true);
/* The fingers are the expensive half and they only exist when there is a hand
   open to put them on. */
check('fingers are near-set only, and only on an open hand',
  /if \(nearParts && i === followIdx && P\.view === 'follow' && !closed\) \{/.test(moduleSource('move.js')));
check('four of them and a thumb', /for \(let k = 0; k < 4; k\+\+\)/.test(moduleSource('move.js'))
  && /F\.thumb\.visible = true;/.test(moduleSource('move.js')));

/* A joint is a ball at the seam between two capsules — the limbs already have
   no corner in them, what was missing is the joint reading as a joint. */
check('elbows, wrists and knees are balls at the seam',
  /nearJoint\(nearParts\?\.elbow\?\.\[side\], i, _mLower\);/.test(moduleSource('move.js'))
  && /nearJoint\(nearParts\?\.wrist\?\.\[side\], i, _mChain\);/.test(moduleSource('move.js'))
  && /nearJoint\(nearParts\?\.knee\?\.\[side\], i, _mLower\);/.test(moduleSource('move.js')));
/* The joint is where the limb hanging from it starts, which is the origin of
   that limb's own space — so there is nothing to work out. */
check('and are placed with the matrix the caller already had',
  /mesh\.matrix\.copy\(mat\);/.test(moduleSource('move.js')));

/* The set grew from five meshes to twenty-one, and anything that walks it
   shallowly puts half of it away — a face hidden while ten fingers stay on the
   world. */
check('and the whole set is walked, however deep it nests',
  /function eachNearPart\(fn\)/.test(nearSrc)
  && /else if \(Array\.isArray\(v\)\) v\.forEach\(walk\);/.test(nearSrc)
  && /hideNearParts\(\) \{\s*eachNearPart/.test(nearSrc));

/* -------------------------------------------------------------------------
   The wardrobe

   Everything humans-threejs dresses a body in: builds, hides, hair, faces,
   loads and tools. Each is a mesh holding only the people wearing it, packed
   from the front, because a mesh with a slot for everybody draws a tunic for
   every person in each of the seven tunics they are not wearing.
   ------------------------------------------------------------------------- */
group('the wardrobe');

check('a mesh holds only who is wearing it',
  /who\.push\(p\);\s*m\.count = who\.length;/.test(looksSrc));
check('taking something off moves the last one into the gap, not everyone along',
  /m\.instanceMatrix\.array\.copyWithin\(at \* 16, last \* 16, last \* 16 \+ 16\);/.test(looksSrc)
  && /q\.wornAt\[group\] = at;/.test(looksSrc));
check('somebody out of sight is wearing nothing, so nothing of theirs is drawn',
  /setMatrixAt\(i \* per \+ k, HIDDEN\);\s*\}\s*\/\/[^\n]*\n\s*undress\(p\);/.test(moduleSource('move.js')));
check('and it grows with the band, like the body does',
  /growLooks\(room\);\n  setPeopleCapacity\(room\);/.test(html));
check('the tool is placed before the hand closes, so a pick is not squashed into a fist',
  html.indexOf("const tool = wear(p, 'tool'") > 0
  && html.indexOf("const tool = wear(p, 'tool'") < html.indexOf('if (closed) _mChain.scale(FIST);'));
check('food comes home as the library\'s cargo, and a rabbit in the arms',
  /if \(kind === 'fruit' \|\| kind === 'berries' \|\| kind === 'fish'\) return 'cargo:' \+ kind;/.test(looksSrc)
  && /bag\?\.animal === 'rabbit' \|\| bag\?\.animal === 'boar' \? 'cargo:animal' : 'cargo:meat'/.test(looksSrc));

/* The builds, run: the library's formula lifted out of looks.js. */
const buildAt = new Function(
  looksSrc.slice(looksSrc.indexOf('const smooth = '), looksSrc.indexOf("/* The library's build"))
  + looksSrc.slice(looksSrc.indexOf('function buildAt('), looksSrc.indexOf('/* The library stretches'))
  + 'return buildAt;')();
const [slimW] = buildAt('slim', 1.0), [broadShoulder] = buildAt('broad', 1.34), [broadWaist] = buildAt('broad', 1.10);
const [fullW, fullD] = buildAt('full', 1.10), [avgW, avgD] = buildAt('average', 1.10);
check('a slim body is narrower', slimW < 0.9, `${slimW}`);
check('a broad one is broadest at the shoulders', broadShoulder > broadWaist && broadShoulder > 1.25,
  `${broadShoulder} at the shoulders, ${broadWaist} at the waist`);
check('a full one is fullest at the waist, and deeper than it is wide there',
  fullW > 1.4 && fullD > fullW && avgW === 1 && avgD === 1, `${fullW} by ${fullD}`);
check('and a head is a head, whatever the build',
  ['slim', 'broad', 'full'].every((b) => buildAt(b, 1.62).every((v) => v === 1)));

/* -------------------------------------------------------------------------
   Fields and flocks

   The first food anybody makes rather than finds, and the order is the point:
   nothing is sown until a band can water the ground.
   ------------------------------------------------------------------------- */
group('fields and flocks');
const farmSrc = moduleSource('farming.js');
check('irrigation comes first: nothing is sown until a band can water the ground',
  /const learning = \(camp\.skill\.irrigation \|\| 0\) < FARM\.irrigateFirst;/.test(farmSrc)
  && /if \(learning\) return;/.test(farmSrc)
  && farmSrc.indexOf("practise(camp, 'irrigation'") < farmSrc.indexOf("practise(camp, 'farming'"));
check('the field is by a creek when there is one, and watered by hand when not',
  /for \(const path of streams\)/.test(farmSrc) && /\(f\.wet \? 1 : FARM\.dry\)/.test(farmSrc));
check('a crop follows the season, and the island\'s ABUNDANCE', /\* forageSeason \* P\.abundance;/.test(farmSrc));
check('the job is chosen, sent, worked and told like the others',
  /\['farm', farmWeight\(p, hunger, rested\)\]/.test(html)
  && /if \(p\.job === 'farm'\) return farmSite\(p\);/.test(html)
  && /if \(p\.job === 'farm'\) farmDone\(p\);/.test(html)
  && /farm: 'working the fields'/.test(html) && /farm: ', back from the fields'/.test(html)
  && /farm: 'walking out to the fields'/.test(html));
check('with the library\'s hoe and its basket of vegetables',
  /out\['tool:hoe'\]/.test(html) && /out\['cargo:vegetables'\]/.test(html)
  && /act === 'hoeing' \? 'tool:hoe'/.test(html) && /if \(kind === 'vegetables'\) return 'cargo:vegetables';/.test(html));
check('the flock feeds the store every day, on both sets of books',
  /c\.food \+= c\.stock \* FARM\.milk \* P\.abundance \* days;/.test(farmSrc)
  && (html.match(/updateLivestock\(owed\);/g) || []).length === 2);
check('and is remembered across a reload',
  /st: r2\(c\.stock \|\| 0\)/.test(html) && /camps\[i\]\.stock = Number\(c\.st\) \|\| 0;/.test(html));
check('the pen has room for the biggest flock', (() => {
  const places = Number((html.match(/^\s*sheep: (\d+),/m) || [, NaN])[1]);
  const most = Number((farmSrc.match(/stockMax: (\d+),/) || [, NaN])[1]);
  return places === most ? true : `${places} places for ${most} head`;
})() === true);
check('nothing crosses the farming import cycle while a module loads',
  !/^(?:const|let|export const|export let)[^\n]*\b(camps|people|CAMP_PIECES|CAMP_CLEARING|streams)\b/m.test(
    farmSrc.replace(/^import .*$/gm, '')));

/* -------------------------------------------------------------------------
   Building and masonry

   Tents follow how well a band builds; the graveyard follows how well it
   dresses stone — a kerb, headstones, and a pyramid, kept after the band is
   gone like everything else it raised.
   ------------------------------------------------------------------------- */
group('building and masonry');
const villageSrc2 = moduleSource('village.js');
check('four kinds of tent, climbed by building',
  /TENT_KEYS = \['huts', 'tentHide', 'tentPainted', 'lodge'\]/.test(villageSrc2)
  && /b >= 0\.75 \? 'lodge' : b >= 0\.5 \? 'tentPainted' : b >= 0\.25 \? 'tentHide' : 'huts'/.test(villageSrc2));
check('and every kind has a mesh with a slot for every tent', (() => {
  const src = moduleSource('people.js');
  return ['tentHide', 'tentPainted', 'lodge'].every((k) => new RegExp(`${k}: HEARTHS \\* HUTS_PER_HEARTH,`).test(src))
    && /for \(const key of TENT_KEYS\.slice\(1\)\)/.test(src);
})());
check('painted in the geometry, not in one colour an instance can hold',
  /vertexColors: true/.test(villageSrc2) && /\[0\.65, 0\.92, OCHRE\], \[1\.45, 1\.62, RED\]/.test(villageSrc2));
check('a well-built village is a less crowded one',
  /\* \(1 - SKILL\.buildAir \* \(camp\.skill\?\.building \|\| 0\)\)/.test(html));
check('masonry is learned at the graveyard, out of the stone pile',
  /p\.camp\.stone -= SKILL\.stonePerCourse;\s*practise\(p\.camp, 'stonework', SKILL\.perCourse\);/.test(html));
check('and pulls visitors, like a monument',
  /SKILL\.pyramidDraw \* \(host\.skill\?\.stonework \|\| 0\)/.test(html));
check('a band that can dress stone stands its graves up, and older cairns stay cairns',
  /const headstone = \(p\.camp\?\.skill\?\.stonework \|\| 0\) >= 0\.5;/.test(html)
  && /if \(it\.k === 's'\) \{/.test(html));
check('the kerb and the pyramid are drawn with the graves, so a dead band keeps them',
  /drawMasonry\(\);\n\n  for \(let i = n \* GRAVE_STONES/.test(html)
  && /const courses = ground \? Math\.round\(PYRAMID_COURSES \* \(camp\.skill\?\.stonework \|\| 0\)\) : 0;/.test(html));

/* -------------------------------------------------------------------------
   Conquest

   After war, ruling: a band that can hold what it takes takes the village —
   same name, same flag, one store — and a tribe's villages feed each other.
   ------------------------------------------------------------------------- */
group('conquest');
check('ruling is learned by winning, once a band can fight',
  /if \(won && \(home\.skill\.war \|\| 0\) >= CONQUEST\.warFirst\) practise\(home, 'conquest', CONQUEST\.perWin\);/.test(html));
check('a band that can rule, winning by a wide margin, takes the village rather than robbing it',
  /return \(home\.skill\.conquest \|\| 0\) >= CONQUEST\.from && mine > theirs \* CONQUEST\.margin && host\.code !== home\.code;/.test(html)
  && /if \(won && canTake\(home, host, mine, theirs\)\) \{\s*conquer\(home, host\);\s*\} else if \(won\) \{/.test(html));
check('which flies the conqueror\'s name and flag, and remembers what it was called',
  /host\.name = home\.name;\s*host\.code = home\.code;/.test(html)
  && /host\.villageName = host\.villageName \|\| host\.name;/.test(html)
  && /host\.pastCodes = \[\.\.\.\(host\.pastCodes \|\| \[\]\), host\.code\];/.test(html));
check('villages of one tribe never raid each other', /if \(c\.code === camp\.code\) continue;/.test(html));
check('a tribe\'s villages share their food, and invent none of it', (() => {
  const at = html.indexOf('function shareTribes');
  const fn = new Function('camps', 'CONQUEST',
    html.slice(at, html.indexOf('\n}', at) + 2) + '\nreturn shareTribes;');
  const camps = [
    { code: 'AB', pop: 5, food: 100, need: 10 }, { code: 'AB', pop: 5, food: 0, need: 10 },
    { code: 'CD', pop: 5, food: 40, need: 10 },
  ];
  fn(camps, { share: 0.25 })(1);
  const tribe = camps[0].food + camps[1].food;
  return Math.abs(tribe - 100) < 1e-9 && camps[1].food > 0 && camps[0].food < 100 && camps[2].food === 40
    ? true : JSON.stringify(camps.map((c) => c.food));
})() === true);
check('every village flies a flag in its tribe\'s colour',
  /flagPole: 1,/.test(html) && /flagCloth: 1,/.test(html) && /setHSL\(hue \/ 360, 0\.7, 0\.5\)/.test(html)
  && /dressFlag\(camp, index, here\);/.test(html));
check('a taken village comes back under its new name and flag',
  /cd: c\.code, vn: c\.villageName \|\| undefined/.test(html)
  && /if \(typeof c\.cd === 'string' && c\.cd\) \{ usedCodes\.add\(c\.cd\); camps\[i\]\.code = c\.cd; \}/.test(html));
check('and keeps the dead it had under its old name', /const mine = \(code\) => code === camp\.code \|\| \(camp\.pastCodes \|\| \[\]\)\.includes\(code\);/.test(html));
check('a conquest is worth telling', /'conquest',   \/\/ a band took another's village/.test(html));

/* ---- report ---- */
console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
