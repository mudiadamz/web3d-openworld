/**
 * Configuration from the environment.
 *
 * Every knob on the page's panel can be given a starting value by an
 * environment variable, so a world can be described entirely by a `.env` file
 * and handed to someone else. Real environment variables win over `.env`, which
 * is the usual precedence and the one people expect from `FOO=1 npm start`.
 *
 * Nothing here throws. A sandbox that refuses to boot because someone typed
 * `DEER=lots` is worse than one that says so and carries on with the default,
 * so bad values are reported and dropped, and out-of-range values are clamped.
 *
 * The ranges below deliberately mirror the sliders in index.html. If they drift
 * apart the panel silently disagrees with `P` — so `test.js` reads the sliders
 * out of the HTML and fails when they do.
 */

import { readFileSync, existsSync } from 'node:fs';

export const SCHEMA = {
  // world
  SEED: { path: 'seed', type: 'int', min: -2147483648, max: 2147483647 },
  QUALITY: { path: 'quality', type: 'enum', values: ['low', 'medium', 'high'] },
  /* How big the island is, in metres across. Everything that reads the world's
     extent reads it from one number, so this is the only place it lives — but
     it is the extent alone: an island twice as wide with the same counts is an
     emptier island, so raise TREES, GRASS and the rest with it. */
  MAP: { path: 'map', type: 'float', min: 800, max: 6400 },

  // time and sky
  TIME: { path: 'time', type: 'float', min: 0, max: 24 },
  DAY_LENGTH: { path: 'dayLength', type: 'float', min: 60, max: 7200, slider: 'dayLen' },
  YEAR_LENGTH: { path: 'yearLength', type: 'float', min: 4, max: 200, slider: 'yearLen' },
  FERTILITY: { path: 'fertility', type: 'float', min: 0, max: 3 },
  EXPOSURE: { path: 'exposure', type: 'float', min: 0.1, max: 1.2 },

  // wind
  WIND: { path: 'wind', type: 'float', min: 0, max: 1 },
  WIND_DIR: { path: 'windDir', type: 'float', min: 0, max: 359, slider: 'windDir' },
  GUST: { path: 'gust', type: 'float', min: 0, max: 1 },

  // camera
  VIEW: { path: 'view', type: 'enum', values: ['fly', 'walk', 'orbit', 'follow'] },
  FOV: { path: 'fov', type: 'float', min: 30, max: 110 },

  // rendering and sound
  WAVES: { path: 'waves', type: 'float', min: 0, max: 2 },
  MODELS: { path: 'models', type: 'enum', values: ['off', 'birds', 'all'] },
  NIGHT_SKIP: { path: 'nightSkip', type: 'bool' },
  NIGHT_SKIP_RATE: { path: 'nightSkipRate', type: 'float', min: 1, max: 60 },
  /* Sun height, not hours: everything that asks whether it is night asks the
     sun, so the window is set in the same units it is measured in. 0 is the
     horizon; more negative is further into the night. */
  NIGHT_FROM: { path: 'nightFrom', type: 'float', min: -0.9, max: 0.3 },
  NIGHT_DEEP: { path: 'nightDeep', type: 'float', min: -0.9, max: 0.3 },
  SHADOWS: { path: 'shadows', type: 'bool' },
  TERRAIN_SHADOW: { path: 'terrainShadow', type: 'bool' },
  WATER: { path: 'water', type: 'bool' },
  SOUND: { path: 'sound', type: 'bool' },
  VOLUME: { path: 'volume', type: 'float', min: 0, max: 1 },

  // populations
  GRASS: { path: 'counts.grass', type: 'int', min: 0, max: 4000 },
  TREES: { path: 'counts.trees', type: 'int', min: 0, max: 3000 },
  ROCKS: { path: 'counts.rocks', type: 'int', min: 0, max: 1200 },
  BISON: { path: 'counts.bison', type: 'int', min: 0, max: 60 },
  DEER: { path: 'counts.deer', type: 'int', min: 0, max: 120 },
  RABBITS: { path: 'counts.rabbits', type: 'int', min: 0, max: 200 },
  BOARS: { path: 'counts.boars', type: 'int', min: 0, max: 120 },
  TIGERS: { path: 'counts.tigers', type: 'int', min: 0, max: 40 },
  BIRDS: { path: 'counts.birds', type: 'int', min: 0, max: 200 },
  BUTTERFLIES: { path: 'counts.butterflies', type: 'int', min: 0, max: 400 },
  FLOWERS: { path: 'counts.flowers', type: 'int', min: 0, max: 600 },
  FRUIT: { path: 'counts.fruit', type: 'int', min: 0, max: 12 },
  STREAMS: { path: 'counts.streams', type: 'int', min: 0, max: 12 },
  CAMPS: { path: 'counts.camps', type: 'int', min: 0, max: 40 },
  PEOPLE: { path: 'counts.people', type: 'int', min: 0, max: 800 },
};

// Server-only; never sent to the page.
export const SERVER_SCHEMA = {
  PORT: { type: 'int', min: 1, max: 65535, fallback: 8080 },
  HOST: { type: 'string', fallback: '127.0.0.1' },
  CHRONICLE_DB: { type: 'string', fallback: 'chronicle.db' },
};

/**
 * A `.env` parser rather than a dependency. Handles `KEY=value`, `#` comments,
 * blank lines, quoted values, and a trailing ` # comment` on unquoted ones.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    out[key] = value;
  }
  return out;
}

export function loadEnv(file = '.env', env = process.env) {
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
  // Real environment variables override the file.
  return { ...fromFile, ...env };
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

function coerce(name, spec, raw, notes) {
  const text = String(raw).trim();
  if (text === '') return undefined;

  if (spec.type === 'bool') {
    const lower = text.toLowerCase();
    if (TRUE.has(lower)) return true;
    if (FALSE.has(lower)) return false;
    notes.push(`${name}: expected true/false, got "${text}" — ignored`);
    return undefined;
  }

  if (spec.type === 'enum') {
    const lower = text.toLowerCase();
    if (spec.values.includes(lower)) return lower;
    notes.push(`${name}: expected one of ${spec.values.join('|')}, got "${text}" — ignored`);
    return undefined;
  }

  if (spec.type === 'string') return text;

  const n = Number(text);
  if (!Number.isFinite(n)) {
    notes.push(`${name}: expected a number, got "${text}" — ignored`);
    return undefined;
  }
  let value = spec.type === 'int' ? Math.round(n) : n;
  if (spec.min !== undefined && value < spec.min) {
    notes.push(`${name}: ${value} is below ${spec.min} — clamped`);
    value = spec.min;
  }
  if (spec.max !== undefined && value > spec.max) {
    notes.push(`${name}: ${value} is above ${spec.max} — clamped`);
    value = spec.max;
  }
  return value;
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) node = (node[parts[i]] ||= {});
  node[parts.at(-1)] = value;
}

/**
 * Resolve the page's starting configuration.
 *
 * `explicit` is the list of variables that were actually set, which matters for
 * one case: naming a QUALITY should load that preset's populations, exactly as
 * picking it on the panel does — but only when the counts were not asked for
 * directly. The page does that part, because the preset table lives there.
 */
export function resolveConfig(env = process.env) {
  const values = {};
  const explicit = [];
  const notes = [];

  for (const [name, spec] of Object.entries(SCHEMA)) {
    if (!(name in env)) continue;
    const value = coerce(name, spec, env[name], notes);
    if (value === undefined) continue;
    setPath(values, spec.path, value);
    explicit.push(spec.path);
  }
  return { values, explicit, notes };
}

export function resolveServer(env = process.env) {
  const notes = [];
  const out = {};
  for (const [name, spec] of Object.entries(SERVER_SCHEMA)) {
    const value = name in env ? coerce(name, spec, env[name], notes) : undefined;
    out[name.toLowerCase()] = value === undefined ? spec.fallback : value;
  }
  return { ...out, notes };
}

/** One line per setting, for the startup banner. */
export function describe(values) {
  const flat = [];
  for (const [key, value] of Object.entries(values)) {
    if (key === 'counts') continue;
    flat.push(`${key} ${value}`);
  }
  for (const [key, value] of Object.entries(values.counts || {})) {
    flat.push(`${key} ${value}`);
  }
  return flat;
}
