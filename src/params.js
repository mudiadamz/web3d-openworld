/* =========================================================================
   Open World Sandbox — a single file to experiment with.

   1600 x 1600 units of procedural terrain: rolling hills, a few masked-in
   mountain ranges, an island falloff that ends in water so the map has no
   visible edge. Grass is instanced into tiles that recycle around the camera;
   trees and rocks are scattered once across the whole map. Sky, sun, light
   colour, ambient and fog all hang off one clock, and one wind vector drives
   both the grass and the tree canopies.

   Everything worth turning lives in `P` and on the panel.
   ========================================================================= */

export const P = {
  time: 7.5,          // hours, 0..24 — state, not a setting; the clock always runs
  dayLength: 3600,    // real seconds for a full 24h
  yearLength: 24,     // simulated days in a year
  map: 1600,          // metres across; the island's extent, set with MAP
  fertility: 1,       // multiplier on the birth rate
  exposure: 0.5,
  wind: 0.35,         // 0..1
  windDir: 135,       // degrees the wind blows TOWARD; 0 = north
  gust: 0.5,          // 0 = steady breeze, 1 = arrives in waves
  quality: 'high',
  /* The night runs itself through once everybody is in. Off, and a night is a
     night — which is a long time to watch nothing at 1×. */
  nightSkip: true,
  nightSkipRate: 6,
  shadows: true,
  // Hills shading each other. Off: see the note where the terrain is built.
  terrainShadow: false,
  water: true,
  waves: 1,
  models: 'birds',    // off | birds | all — real glTF geometry for the wildlife
  view: 'fly',        // fly | walk | orbit | follow
  followDist: 4.5,
  fov: 58,
  sound: true,
  volume: 0.55,
  seed: 20260906,
  // Populations. A quality preset loads its numbers in here, and after that the
  // sliders are what count — pick a preset for the rendering cost, then put as
  // much life in the world as the machine will carry.
  counts: {
    grass: 2000, trees: 1000, rocks: 260,
    bison: 9, deer: 22, rabbits: 44, boars: 16, tigers: 2, birds: 44, butterflies: 70,
    camps: 2, people: 16,
    flowers: 150, fruit: 5, streams: 5,
  },
};

/* Quality buys only rendering cost — terrain resolution, shadow map, pixel
   ratio, how far the grass reaches. Population is separate and lives in
   P.counts; a preset seeds it, the sliders own it afterwards. */
export const QUALITY = {
  low: {
    seg: 176, grid: 5, shadowMap: 0, pixelRatio: 1.0, round: 0,
    counts: { grass: 700, trees: 300, rocks: 90, bison: 4, deer: 8, rabbits: 14, boars: 5, tigers: 1, birds: 16, butterflies: 24, camps: 1, people: 8, flowers: 60, fruit: 3, streams: 3 },
  },
  medium: {
    seg: 288, grid: 7, shadowMap: 1024, pixelRatio: 1.5, round: 1,
    counts: { grass: 1300, trees: 600, rocks: 170, bison: 6, deer: 14, rabbits: 26, boars: 9, tigers: 1, birds: 28, butterflies: 44, camps: 2, people: 12, flowers: 100, fruit: 4, streams: 4 },
  },
  high: {
    seg: 448, grid: 9, shadowMap: 2048, pixelRatio: 2.0, round: 2,
    counts: { grass: 2000, trees: 1000, rocks: 260, bison: 9, deer: 22, rabbits: 44, boars: 16, tigers: 2, birds: 44, butterflies: 70, camps: 2, people: 16, flowers: 150, fruit: 5, streams: 5 },
  },
};

/* server.js replaces the <!--CONFIG--> marker above with the defaults it
   resolved from the environment. Opened as a plain file there is no injection
   and the values written above stand, which is what keeps this one file
   runnable on its own. */
applyInjectedConfig();
applyUrlOverrides();

/* The time of day, the day count and the season belong to the session, not to
   the world: you can walk out of one world and into another without the sun
   jumping, and nothing puts the clock back — there is no Restart any more, and
   a world you delete is deleted rather than rewound. */

/* An escape hatch. If a setting has made the page too slow to interact with,
   the panel is exactly what you cannot get to — so the two settings that can
   cost the most are also reachable from the address bar:
   `?models=off`, `?quality=low`. */
export function applyUrlOverrides() {
  if (typeof location === 'undefined') return;
  const q = new URLSearchParams(location.search || '');
  const models = q.get('models');
  if (['off', 'birds', 'all'].includes(models)) P.models = models;
  const quality = q.get('quality');
  if (quality && QUALITY[quality]) {
    P.quality = quality;
    Object.assign(P.counts, QUALITY[quality].counts);
  }

  /* Bisecting switches. Some things can only be identified by turning them off
     one at a time, and the person who can see the screen is not the one who can
     edit the file: `?grass=0`, `?flowers=0`, `?wind=0`. */
  if (q.get('grass') === '0') P.counts.grass = 0;
  if (q.get('flowers') === '0') P.counts.flowers = 0;
  if (q.get('wind') === '0') P.wind = 0;
  if (q.get('shadows') === '0') P.shadows = false;
  if (q.get('terrainshadow') === '1') P.terrainShadow = true;
  if (q.get('water') === '0') P.water = false;
  if (q.get('streams') === '0') P.counts.streams = 0;
}

export function applyInjectedConfig() {
  const cfg = typeof window !== 'undefined' && window.__CONFIG__;
  if (!cfg || !cfg.values) return;
  const explicit = new Set(cfg.explicit || []);

  for (const [key, value] of Object.entries(cfg.values)) {
    if (key !== 'counts' && key in P) P[key] = value;
  }
  // Naming a quality loads that preset's populations, exactly as picking it on
  // the panel does — then anything asked for by name wins over the preset.
  if (explicit.has('quality') && QUALITY[P.quality]) {
    Object.assign(P.counts, QUALITY[P.quality].counts);
  }
  if (cfg.values.counts) Object.assign(P.counts, cfg.values.counts);
}

/* How far the island reaches, in metres. Set with MAP; everything that needs to
   know the extent — the terrain field, the falloff into water, where camps may
   be sited, how far anybody may walk — reads this and nothing else, which is why
   it can be moved at all. Counts do not scale with it: a map twice as wide with
   the same number of trees is a thinner wood, so raise them alongside it. */
export const WORLD = Math.max(800, Math.min(6400, P.map || 1600));

/* The most people this world will ever hold. Everything that draws a person is
   allocated to it at build time and an InstancedMesh cannot grow, so it is the
   one number that has to be guessed rather than discovered — and it is sized
   off the island, because that is what actually feeds them. A 1600 m map tops
   out around 500; 6400 m is room for several thousand. */
/* Every distance in the simulation — how far camps sit from the middle, how far
   apart they are, how far a band walks to found a new one — was a number of
   metres tuned on a 1600 m island. On a 4800 m one they all still meant 1600 m,
   so six bands were sited inside a 410 m circle in the middle of an island nine
   times the size, fought over the same ground, and starved: sixty people down
   to nine, and not one of the founders alive at the end.

   Nothing about that was the population being too large. It was the map growing
   and the world not noticing. */
export const REFERENCE_MAP = 1600;              // the island these were tuned on
export const MAP_SCALE = WORLD / REFERENCE_MAP;

export const PEOPLE_PER_KM2 = 195;
export const PEOPLE_CEILING =
  Math.round(Math.min(4000, (WORLD / 1000) ** 2 * PEOPLE_PER_KM2));

/* And the most camps. A camp is a handful of tents and a fire; a map that holds
   three thousand people needs somewhere for all of them to live. */
export const CAMP_CEILING = Math.round(clampTo(PEOPLE_CEILING / 14, 4, 240));

function clampTo(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export const TILE = 24;           // grass tile size
export const SEA = 0;             // water plane height
export const SNOW = 96;           // grass and trees stop below this
export const FOG_DENSITY = 0.0024;

