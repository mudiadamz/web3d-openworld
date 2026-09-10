import * as THREE from 'three';

import { P, SEA, WORLD } from './params.js';
import { clamp, flatnessAt, sampleHeight, smoothstep } from './noise.js';
import { camera, controls, groundColorAt } from './scene.js';
import { orchard, updateTiles } from './world.js';
import { packs } from './wildlife.js';
import { camps, people } from './people.js';
import { PATH, forEachWorn, pathVersion } from './paths.js';
import { recountBlades } from './move.js';
import { streams } from './creeks.js';
import { _fwd, openTribe, setViewMode, syncLookFromCamera } from './chronicle.js';
import { $, persistState } from './save.js';
import { toast } from './ui.js';
import { armAudio, audio } from './audio.js';
import { daysOfFood } from './life.js';
import { ICON_PATHS } from './icons.js';
import { ORES, deposits } from './quarries.js';
import { ripeWord, thickets } from './thickets.js';
import { dockOf } from './larder.js';
import { raftBusy } from './rafts.js';

/* -------------------------------------------------------------------------
   Map

   A relief map of the island, drawn once per world into an offscreen canvas
   from the same height field the terrain mesh is built from, using the same
   ground colours — so what you see on the map is what is actually under you.
   Shaded from the north-west, which is the cartographic convention and the
   reason the ridges read as ridges instead of as noise.

   On top of that, live markers redrawn a few times a second: the camps, the
   band, the animals, and you with your field of view. Click anywhere to go
   there.
   ------------------------------------------------------------------------- */

export const MAP_N = 384;                  // map pixels across the whole 1600-unit world

/* How big it sits on screen, and M walks through them. One of these is "not at
   all", which is where the old M left it — it was a single toggle, so a map you
   wanted smaller rather than gone was a map you turned off. */
/* Three sizes and off, rather than five steps that were mostly each other:
   a corner map you glance at, one you can actually read without leaving what
   you are doing, and the whole window. Walking through 118 and 168 on the way
   to somewhere was four keypresses to make one decision.

   `full` is sized against the window instead of carrying a number, because the
   whole point of it is that there is no number — it is however much room there
   is. Square, so it goes by the short edge. */
export const MAP_SIZES = [
  { name: 'hidden', px: 0 },
  { name: 'small', px: 92 },
  { name: 'max', px: 0, fills: true },
];
/* Where "put it back in the corner" goes, by name rather than by number: the
   minimise button used to say `setMapSize(0)`, and index 0 is the hidden one
   now. A button labelled "smaller" that turns the map off is the kind of thing
   a reordered array does quietly. */
export const SMALL_MAP = MAP_SIZES.findIndex((m) => m.name === 'small');
export const FULL_MAP = MAP_SIZES.findIndex((m) => m.fills);

/* How far in the full map is looking. 1 is the whole island; past that it
   centres on where you are, because the only reason to magnify a map is to see
   the ground you are standing on. The corner sizes ignore it — there is no room
   in 92 pixels to be lost in. */
export let mapZoom = 1;
export const MAP_ZOOMS = [1, 1.6, 2.6, 4.2, 6.8];

export function stepMapZoom(by) {
  const at = MAP_ZOOMS.indexOf(mapZoom);
  mapZoom = MAP_ZOOMS[Math.max(0, Math.min(MAP_ZOOMS.length - 1, (at < 0 ? 0 : at) + by))];
  nextMapDraw = 0;
  return mapZoom;
}

/** True while the map is the whole window, which is the only place zoom and the
    controls mean anything. */
export function mapIsFull() { return Boolean(MAP_SIZES[mapSize].fills); }

export function fullMapPx() {
  return Math.max(240, Math.min(innerWidth, innerHeight) - 32);
}
export let nextMapDraw = 0;
/* The small one. Three states and M walks them: off, a corner map you glance
   at, and the whole window. The two middle sizes went the way Fly and Walk did —
   118 and 168 and 236 were four presses to make one decision, and the decision
   is only ever "get it out of the way" or "let me look properly". */
export const MAP_DEFAULT = SMALL_MAP;
export let mapSize = MAP_DEFAULT;
export let MAP_DISPLAY = MAP_SIZES[MAP_DEFAULT].px;
/* Marker sizes below are written in screen pixels; this converts them. It moves
   with the size, or a bigger map is the same island with the same dots on it
   drawn smaller, which is not a bigger map. */
export let MK = MAP_N / MAP_DISPLAY;
export const mapCanvas = $('mapCanvas');
export const mapCtx = mapCanvas.getContext('2d');

/** Walks to the next size, wrapping through hidden and back to the smallest. */
export function stepMapSize(by = 1) {
  return setMapSize((mapSize + by + MAP_SIZES.length) % MAP_SIZES.length);
}

export function setMapSize(i) {
  mapSize = ((i % MAP_SIZES.length) + MAP_SIZES.length) % MAP_SIZES.length;
  const at = MAP_SIZES[mapSize];
  const box = $('map');
  box?.classList.toggle('full', Boolean(at.fills));
  /* Zoom belongs to the full map. Carrying it out to a 92-pixel corner would
     leave you with a corner map of somewhere you cannot tell from anywhere
     else, and no control on it to undo that. */
  if (!at.fills) { mapZoom = 1; closeMapLayers(); }
  if (!at.fills && at.px === 0) {
    if (box) box.hidden = true;
    return at.name;
  }
  MAP_DISPLAY = at.fills ? fullMapPx() : at.px;
  MK = MAP_N / MAP_DISPLAY;
  mapCanvas.style.width = MAP_DISPLAY + 'px';
  mapCanvas.style.height = MAP_DISPLAY + 'px';
  /* The backing store follows the display, so the markers are rasterised at the
     size they are actually seen at. A 384-pixel canvas stretched across a
     window turns every camp dot into a soft blob — and the dots are the part of
     this that has to be read. Everything is still drawn in MAP_N coordinates;
     one transform in drawMap carries them up. The relief underneath is the one
     thing that cannot be sharpened this way, because it is an image rendered
     once per world — it is upscaled, and soft, and that is the trade for not
     re-rendering a quarter of a million height samples on a keypress. */
  const back = Math.min(2048, Math.round(MAP_DISPLAY * Math.min(2, devicePixelRatio || 1)));
  if (mapCanvas.width !== back) { mapCanvas.width = back; mapCanvas.height = back; }
  if (box) box.hidden = false;
  nextMapDraw = 0;                          // redraw at the new marker scale
  return at.name;
}

mapCanvas.style.width = MAP_DISPLAY + 'px';
mapCanvas.style.height = MAP_DISPLAY + 'px';

/* The fixed sizes are numbers and do not care about the window; the full one is
   the window, so it has to be measured again when that changes. */
export function onMapResize() {
  if (MAP_SIZES[mapSize].fills) setMapSize(mapSize);
}

export let mapBase = null;
/* The corner map's own ground: land and water and the creeks, flat, with no
   relief and no ground colours. At 92 pixels the relief is mush, and what the
   corner map is for is where you are and where the bands are. */
export let mapPlain = null;
const PLAIN_LAND = [104, 124, 78], PLAIN_WATER = [40, 84, 112];

export const MAP_WATER = new THREE.Color(0x2b5a78);
export const MAP_DEEP = new THREE.Color(0x122b44);

/* What the map is looking at, in world metres: the whole island at zoom 1, and
   a window of it around the camera past that. Everything that draws or is
   clicked goes through this one pair, so a zoomed map cannot disagree with
   itself about where a thing is. */
export const mapView = { x: 0, z: 0, span: WORLD };

/* Where the zoomed map is looking, once somebody has dragged it there. Null
   means nobody has, and it goes back to following you.

   Both are wanted, which is why it is a null and not a mode: opening a zoomed
   map to find yourself on it is the reason to zoom at all, and being unable to
   look at the next valley without walking there is the reason that is not
   enough. Dragging is the whole switch — the map stays where you put it until
   you zoom back out, which is also the way to say "follow me again". */
export let mapPan = null;

export function setMapPan(x, z) {
  mapPan = x === null ? null : { x, z };
  nextMapDraw = 0;
}

export function updateMapView() {
  const zoom = mapIsFull() ? mapZoom : 1;
  mapView.span = WORLD / zoom;
  if (zoom === 1) { mapView.x = 0; mapView.z = 0; mapPan = null; return; }
  // Where you dragged it to, or you — and never off the side of the world.
  const edge = (WORLD - mapView.span) / 2;
  const at = mapPan || camera.position;
  mapView.x = clamp(at.x, -edge, edge);
  mapView.z = clamp(at.z, -edge, edge);
}

export function worldToMap(x, z) {
  const k = MAP_N / mapView.span;
  return [(x - mapView.x) * k + MAP_N / 2, (z - mapView.z) * k + MAP_N / 2];
}
export function mapToWorld(u, v) {
  return [mapView.x + (u - 0.5) * mapView.span, mapView.z + (v - 0.5) * mapView.span];
}

export function renderMapBase() {
  mapBase = document.createElement('canvas');
  mapBase.width = MAP_N;
  mapBase.height = MAP_N;
  const ctx = mapBase.getContext('2d');
  const img = ctx.createImageData(MAP_N, MAP_N);
  const d = img.data;
  mapPlain = document.createElement('canvas');
  mapPlain.width = MAP_N;
  mapPlain.height = MAP_N;
  const plainCtx = mapPlain.getContext('2d');
  const plain = plainCtx.createImageData(MAP_N, MAP_N);
  const col = new THREE.Color();
  const step = WORLD / MAP_N;

  for (let j = 0; j < MAP_N; j++) {
    const z = -WORLD / 2 + (j + 0.5) * step;
    for (let i = 0; i < MAP_N; i++) {
      const x = -WORLD / 2 + (i + 0.5) * step;
      const h = sampleHeight(x, z);
      const flat = h < SEA ? PLAIN_WATER : PLAIN_LAND, q = (j * MAP_N + i) * 4;
      plain.data[q] = flat[0]; plain.data[q + 1] = flat[1]; plain.data[q + 2] = flat[2]; plain.data[q + 3] = 255;
      if (h < SEA) {
        col.copy(MAP_WATER).lerp(MAP_DEEP, smoothstep(0, -45, h));
      } else {
        groundColorAt(x, z, h, flatnessAt(x, z), col);
        /* Hillshade. A west-facing slope rises toward +x, so dx > 0 means the
           surface turns toward the light and brightens; same for dz and north.
           Getting that sign backwards inverts every valley into a ridge. */
        const dx = sampleHeight(x + step, z) - sampleHeight(x - step, z);
        const dz = sampleHeight(x, z + step) - sampleHeight(x, z - step);
        col.multiplyScalar(clamp(1 + (dx + dz) * 0.05, 0.40, 1.8));
      }
      col.convertLinearToSRGB();      // the canvas wants sRGB bytes, not linear
      const o = (j * MAP_N + i) * 4;
      d[o] = clamp(col.r, 0, 1) * 255;
      d[o + 1] = clamp(col.g, 0, 1) * 255;
      d[o + 2] = clamp(col.b, 0, 1) * 255;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  plainCtx.putImageData(plain, 0, 0);

  // The creeks are thinner than a map pixel in places, so they are drawn as
  // lines rather than left to the terrain shading to imply.
  ctx.strokeStyle = 'rgba(104, 166, 196, 0.95)';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  plainCtx.strokeStyle = 'rgba(40, 84, 112, 1)';
  plainCtx.lineCap = 'round';
  for (const path of streams) {
    for (const c of [ctx, plainCtx]) {
      c.beginPath();
      for (let i = 0; i < path.length; i++) {
        const [px, py] = worldToMap(path[i].x, path[i].z);
        if (i) c.lineTo(px, py); else c.moveTo(px, py);
      }
      c.lineWidth = 1.5 * MK;
      c.stroke();
    }
  }
  nextMapDraw = 0;
}

/* -------------------------------------------------------------------------
   Roads

   The paths people have worn, drawn on the map the way a map draws a road:
   thicker than the thing itself, because a track a metre and a half wide is a
   third of a pixel at island scale and a road you cannot see is not on the map.

   Cached into an image of the whole island, exactly like the relief, and
   redrawn only when the ground has changed — `pathVersion` says when. Walking
   a few thousand worn cells fourteen times a second to paint the same picture
   again would be most of what the map costs.
   ------------------------------------------------------------------------- */
export let pathLayer = null;
let drawnPaths = -1, nextPathDraw = 0;

export function buildPathLayer(now) {
  if (!pathLayer) {
    pathLayer = document.createElement('canvas');
    pathLayer.width = MAP_N;
    pathLayer.height = MAP_N;
  }
  if (pathVersion === drawnPaths || now < nextPathDraw) return;
  drawnPaths = pathVersion;
  nextPathDraw = now + 2;                 // a path is not a fast-moving thing

  const ctx = pathLayer.getContext('2d');
  ctx.clearRect(0, 0, MAP_N, MAP_N);
  const k = MAP_N / WORLD;
  forEachWorn((x, z, worn, cell) => {
    if (worn < PATH.onMap) return;        // a scuff is not a road
    /* Darker and more opaque the more it is walked, so the way between two
       camps reads as a road and the ground around a fire reads as scuffed. */
    const t = Math.min(1, (worn - PATH.onMap) / (1 - PATH.onMap));
    ctx.fillStyle = `rgba(94, 74, 48, ${(0.25 + 0.40 * t).toFixed(2)})`;
    const w = Math.max(1, cell * k);
    ctx.fillRect((x + WORLD / 2) * k - w / 2, (z + WORLD / 2) * k - w / 2, w, w);
  });
}

export function drawPathLayer() {
  if (!pathLayer) return;
  const src = MAP_N * (mapView.span / WORLD);
  const sx = ((mapView.x - mapView.span / 2 + WORLD / 2) / WORLD) * MAP_N;
  const sz = ((mapView.z - mapView.span / 2 + WORLD / 2) / WORLD) * MAP_N;
  mapCtx.drawImage(pathLayer, sx, sz, src, src, 0, 0, MAP_N, MAP_N);
}

/* How far across the map is, said in the units the world is measured in. The
   bar is a round number of metres rather than a round number of pixels — a
   scale that reads "0.83 km" is a scale nobody can use. */
export const SCALE_STEPS = [25, 50, 100, 200, 500, 1000, 2000, 5000];

export function updateScaleBar() {
  const el = $('mapScale');
  if (!el || !mapIsFull()) return;
  const perPx = mapView.span / MAP_DISPLAY;          // metres a screen pixel covers
  const want = 110 * perPx;                          // about this long, then rounded
  const metres = SCALE_STEPS.find((m) => m >= want) || SCALE_STEPS.at(-1);
  el.querySelector('i').style.width = `${Math.round(metres / perPx)}px`;
  el.querySelector('span').textContent = metres >= 1000
    ? `${(metres / 1000).toFixed(metres % 1000 ? 1 : 0)} km` : `${metres} m`;
}

/* -------------------------------------------------------------------------
   What the map shows

   Everything the map draws is a layer you can put away: the bands, the people,
   the animals, the paths, the burial grounds, and the four kinds of place food
   comes from. Nothing is added by turning one off. It is the same map with less
   on it, which is what you want when the thing you are looking for is under a
   crowd of people.

   Remembered in this browser, the way a collapsed panel would be: it is how
   you like to read the map, not a fact about the world, so it is not in the
   save and it does not travel with a seed.
   ------------------------------------------------------------------------- */
export const MAP_LAYERS = ['camps', 'people', 'animals', 'paths', 'barrows', 'fruit', 'forage', 'fish', 'rafts', 'stores',
  'stone', 'iron', 'bronze', 'silver', 'gold'];
export const MAP_LAYERS_STORE = 'openworld.mapLayers';
export const mapShows = Object.fromEntries(MAP_LAYERS.map((k) => [k, true]));
try {
  const kept = JSON.parse(localStorage.getItem(MAP_LAYERS_STORE) || 'null');
  for (const k of MAP_LAYERS) if (typeof kept?.[k] === 'boolean') mapShows[k] = kept[k];
} catch { /* nowhere to keep it: everything shows, which is the default anyway */ }

export function setMapLayer(k, on) {
  if (!MAP_LAYERS.includes(k)) return false;
  mapShows[k] = Boolean(on);
  try { localStorage.setItem(MAP_LAYERS_STORE, JSON.stringify(mapShows)); } catch { /* not kept */ }
  nextMapDraw = 0;
  paintLayerButtons();
  return true;
}

/** Every layer at once. One write and one redraw rather than fourteen of each,
    which is the whole reason it is not a loop over setMapLayer. */
export function setAllMapLayers(on) {
  for (const k of MAP_LAYERS) mapShows[k] = Boolean(on);
  try { localStorage.setItem(MAP_LAYERS_STORE, JSON.stringify(mapShows)); } catch { /* not kept */ }
  nextMapDraw = 0;
  paintLayerButtons();
}

/** Marks each line of the list on or off, and fills the funnel while anything
    is hidden — the way the chronicle's does, so a map with half its layers off
    says so before you wonder where everybody went. */
export function paintLayerButtons() {
  for (const b of $('mapLayers')?.querySelectorAll?.('button[data-layer]') || []) {
    b.setAttribute('aria-pressed', String(Boolean(mapShows[b.dataset.layer])));
  }
  /* "All" is on when everything is, off when nothing is, and mixed in between —
     which is a real state for a toggle button, and the one it spends most of
     its time in once anybody has used the list. */
  const on = MAP_LAYERS.filter((k) => mapShows[k]).length;
  $('mapLayers')?.querySelector?.('button[data-all]')?.setAttribute?.('aria-pressed',
    on === MAP_LAYERS.length ? 'true' : on === 0 ? 'false' : 'mixed');
  $('mapFilter')?.classList?.toggle('filtering', MAP_LAYERS.some((k) => !mapShows[k]));
}

export function closeMapLayers() {
  const box = $('mapLayers');
  if (box) box.hidden = true;
  $('mapFilter')?.setAttribute?.('aria-expanded', 'false');
}

/* -------------------------------------------------------------------------
   Where the food is

   The full map said where everybody was and nothing about what they were all
   walking to. So it marks the four places food comes from: fruit on the trees,
   the ground each band has found worth foraging, the water each band fishes,
   and the granaries it ends up in. Each is a badge you can click to go and
   look, drawn with the same pictures as the bubbles over the people doing the
   work.

   Only on the full map. At 92 pixels a badge is bigger than a camp and there
   would be forty of them.
   ------------------------------------------------------------------------- */
export const MARK_KINDS = {
  fruit: { icon: 'fruit', color: '#f08497' },
  forage: { icon: 'gather', color: '#a3d672' },
  fish: { icon: 'fish', color: '#76c8f0' },
  rafts: { icon: 'raft', color: '#c9a36b' },
  stores: { icon: 'granary', color: '#ecc870' },
  // Coloured per mark, by what the quarry is: see ORES in quarries.js.
  quarry: { icon: 'quarry', color: '#bdb6aa' },
};
export const MARK_HIT = 9;           // screen pixels, like CAMP_HIT
export const FRUIT_MIN = 6;          // fruit in a clump before it is worth a mark
/* And no more than this many in view, richest first. The first world this was
   drawn on had 117 clumps worth a mark across the whole island, which is not a
   map of where the fruit is but a rash; the best two dozen are where you would
   actually go, and zooming in shows the next ones down. */
export const FRUIT_MARKS = 24;
/* And thickets, the same way: the richest in view. */
export const FORAGE_MARKS = 30;
export const PATCHES_MARKED = 3;     // a band's best few, not all it remembers
/* What the last full-map draw put down, for the pointer to find. */
export const mapMarks = [];

let fruitClumps = [], fruitAt = -Infinity, fruitSpan = 0;

/* Fruit, gathered into clumps. There are thousands on an island and a mark
   each would be a rash — and the trees stand in groves anyway, so a clump is
   what you would walk to. How big a clump is follows the zoom: the whole island
   wants big ones, a valley small ones. Counted again every two seconds rather
   than every draw, because it walks every fruit there is. */
function clumpFruit(now) {
  if (now - fruitAt < 2 && fruitSpan === mapView.span) return fruitClumps;
  fruitAt = now;
  fruitSpan = mapView.span;
  fruitClumps = [];
  if (!orchard?.buckets) return fruitClumps;
  const cell = Math.max(40, mapView.span / 18);
  const clumps = new Map();
  for (const here of orchard.buckets.values()) {
    for (const i of here) {
      if (!orchard.on[i]) continue;
      const x = orchard.home[i * 16 + 12], z = orchard.home[i * 16 + 14];
      const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
      const c = clumps.get(key);
      if (c) { c.n++; c.x += x; c.z += z; } else clumps.set(key, { n: 1, x, z });
    }
  }
  for (const c of clumps.values()) {
    if (c.n >= FRUIT_MIN) fruitClumps.push({ x: c.x / c.n, z: c.z / c.n, n: c.n });
  }
  fruitClumps.sort((a, b) => b.n - a.n);     // richest first, for the cap in gatherMarks
  return fruitClumps;
}

/* Everything worth a mark, off live state, for the layers that are showing. */
function gatherMarks(now) {
  mapMarks.length = 0;
  if (!mapIsFull()) return;
  const put = (kind, x, z, label, color, size) => {
    const [mx, my] = worldToMap(x, z);
    // Off the edge of a zoomed-in view: nothing to draw and nothing to click.
    if (mx < -6 || my < -6 || mx > MAP_N + 6 || my > MAP_N + 6) return false;
    mapMarks.push({ kind, x, z, mx, my, label, color, size });
    return true;
  };
  if (mapShows.fruit) {
    let shown = 0;
    for (const f of clumpFruit(now)) {
      if (shown >= FRUIT_MARKS) break;
      if (put('fruit', f.x, f.z, `${f.n} fruit ripe on the trees here`)) shown++;
    }
  }
  /* Foraging: the berry thickets — where the food is on the ground, and what
     E forages at. The richest first, which is the order they are laid out in,
     and no more than a handful in view, like the fruit. */
  if (mapShows.forage) {
    let shown = 0;
    for (const t of thickets) {
      if (shown >= FORAGE_MARKS) break;
      if (put('forage', t.x, t.z, 'Berries: ' + ripeWord(t))) shown++;
    }
  }
  for (const c of camps) {
    if (c.gone) continue;
    // The fish are out in deep water, off the dock, and only for a band with a raft.
    const dock = mapShows.fish && c.raft ? dockOf(c) : null;
    if (dock) {
      put('fish', dock.mx + Math.sin(dock.a) * 70, dock.mz + Math.cos(dock.a) * 70, `${c.name} fish out here, from their raft`);
    }
    /* And the raft itself, wherever it is: tied up at the dock, or out on the
       water with whoever took it. */
    if (mapShows.rafts && c.raft) {
      const at = dockOf(c);
      const out = at && raftBusy(c) ? c.raftOut : null;
      if (out) put('rafts', out.x, out.z, `${c.name}'s raft — out on the water`);
      else if (at) put('rafts', at.mx, at.mz, `${c.name}'s raft, tied up at its dock`);
    }
    if (mapShows.stores && c.storesUp > 0 && c.storeSpots?.[0]) {
      const s = c.storeSpots[0];
      put('stores', s.x, s.z,
        `${c.name}'s granaries: ${Math.floor(daysOfFood(c))} days of food put by`);
    }
  }
  /* The quarries: one mark each, the colour of what is in it and the size of
     how much — the same cube root the heap on the hillside is drawn by, so a
     gold seam is a small mark and a fresh stone quarry a big one. A seam that
     is worked out is off the map. */
  for (const d of deposits) {
    if (d.left <= 0 || !mapShows[d.kind]) continue;
    const ore = ORES[d.kind];
    put('quarry', d.x, d.z, `${ore.label[0].toUpperCase()}${ore.label.slice(1)}: ${d.left} of ${d.full} left`,
      ore.mark, clamp(3.6 * (0.75 + 0.5 * Math.cbrt(d.left / 100)), 3.2, 7.6));
  }
}

/* A dark round with a ring in the kind's colour and its picture inside. Path2D
   turns the pictures into strokes and a browser is the only place it exists;
   the boot check draws the rounds without them, which is the right answer to
   "does the map still draw". */
function drawMarks() {
  const scale = mapCanvas.width / MAP_N;
  const paths = typeof Path2D === 'function';
  for (const m of mapMarks) {
    const kind = MARK_KINDS[m.kind];
    // Its own size and colour where it has them — a quarry's say how much.
    const r = (m.size || 4.4) * MK;
    const s = (r * 1.41) / 16;
    const color = m.color || kind.color;
    mapCtx.beginPath();
    mapCtx.arc(m.mx, m.my, r, 0, Math.PI * 2);
    mapCtx.fillStyle = 'rgba(18, 14, 10, 0.86)';
    mapCtx.fill();
    mapCtx.lineWidth = 0.9 * MK;
    mapCtx.strokeStyle = color;
    mapCtx.stroke();
    if (!paths) continue;
    mapCtx.setTransform(scale * s, 0, 0, scale * s, scale * (m.mx - 8 * s), scale * (m.my - 8 * s));
    mapCtx.lineWidth = 1.6;
    mapCtx.lineCap = 'round';
    mapCtx.lineJoin = 'round';
    mapCtx.strokeStyle = color;
    mapCtx.fillStyle = color;
    const icon = ICON_PATHS[kind.icon];
    for (const d of icon.stroke || []) mapCtx.stroke(new Path2D(d));
    for (const d of icon.fill || []) mapCtx.fill(new Path2D(d));
    mapCtx.setTransform(scale, 0, 0, scale, 0, 0);
  }
}

/* Screen pixels between the pointer and a point in map units. The same
   conversion campUnder makes, in one place for both of them. */
function screenDist(mx, my, clientX, clientY, r) {
  return Math.hypot(r.left + mx / MAP_N * r.width - clientX, r.top + my / MAP_N * r.height - clientY);
}

/** The mark under this point on the canvas, if any, and how far off its
    middle the pointer is. */
export function markUnder(clientX, clientY) {
  if (!mapIsFull() || !mapMarks.length) return null;
  const r = mapCanvas.getBoundingClientRect();
  if (!r.width) return null;
  let best = null, near = MARK_HIT;
  for (const m of mapMarks) {
    const d = screenDist(m.mx, m.my, clientX, clientY, r);
    if (d < near) { near = d; best = m; }
  }
  return best ? { mark: best, d: near } : null;
}

/** How far the pointer is from a band's fire, in screen pixels. */
export function campDist(camp, clientX, clientY) {
  const r = mapCanvas.getBoundingClientRect();
  const [mx, my] = worldToMap(camp.x, camp.z);
  return screenDist(mx, my, clientX, clientY, r);
}

export function drawMap(now) {
  if (!mapBase || $('map').hidden) return;
  if (now < nextMapDraw) return;
  nextMapDraw = now + 0.07;           // ~14 a second is plenty for dots

  /* Draw in MAP_N units whatever the canvas is, so every marker below is
     written the way it always was and comes out at the resolution the canvas
     happens to have. */
  const scale = mapCanvas.width / MAP_N;
  mapCtx.setTransform(scale, 0, 0, scale, 0, 0);

  updateMapView();
  buildPathLayer(now);
  // The corner map is its own, plainer picture.
  if (!mapIsFull()) { drawCornerMap(); return; }
  /* The relief is one image of the whole island, so zooming is a crop of it
     rather than a redraw — the height field is not sampled again for a keypress.
     It goes soft as you go in, which is what a paper map does when you put your
     nose against it, and the markers on top stay sharp because they are drawn
     rather than sampled. */
  const src = MAP_N * (mapView.span / WORLD);
  const sx = ((mapView.x - mapView.span / 2 + WORLD / 2) / WORLD) * MAP_N;
  const sz = ((mapView.z - mapView.span / 2 + WORLD / 2) / WORLD) * MAP_N;
  mapCtx.drawImage(mapBase, sx, sz, src, src, 0, 0, MAP_N, MAP_N);
  if (mapShows.paths) drawPathLayer();

  // Animals first and faintest: they are context, not the point.
  mapCtx.fillStyle = 'rgba(226, 240, 205, 0.55)';
  for (const pack of mapShows.animals ? packs : []) {
    for (const a of pack.list) {
      const [px, py] = worldToMap(a.x, a.z);
      mapCtx.fillRect(px - 0.5 * MK, py - 0.5 * MK, 1.1 * MK, 1.1 * MK);
    }
  }

  /* Where the food is. Under the bands, so a fire is never hidden by its own
     granaries on a map zoomed out far enough to put them on top of each other. */
  gatherMarks(now);
  drawMarks();

  /* Camps: one small dot each, in the band's own colour.

     It was a ring, a fire and a name, all sized for two bands on an island. At
     twenty they were most of the map — rings running into each other and labels
     stacked into a pile — and what a map is for is where things are, not what
     they are called or how ornate they look. The names are on the panel and on
     the band card, where there is room for them.

     They were all the same red, which said "a camp" and nothing else: on an
     island of ten bands, matching the dot to the band meant reading a name off
     the panel and then counting fires. `camp.color` is the same `codeColor` the
     two-character chip beside its name is filled with, so a dot and a label are
     the same band by looking, in one channel, with nothing to remember.

     What the red was buying was a hue nothing else on the map uses, which is
     what let the dot be this small. That is gone — a band can now come out
     ground-green or people-amber — so the dark edge stops being a hedge against
     one bad case and becomes the thing that makes a dot a dot. It is drawn
     wider for it. */
  for (const c of mapShows.camps ? camps : []) {
    const [px, py] = worldToMap(c.x, c.z);
    mapCtx.beginPath();
    mapCtx.arc(px, py, 1.7 * MK, 0, Math.PI * 2);
    mapCtx.fillStyle = c.color;
    mapCtx.fill();
    mapCtx.lineWidth = 0.9 * MK;
    mapCtx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    mapCtx.stroke();
  }

  /* The ground each band buries its people in, and whatever it has raised over
     them. Drawn before the fires and smaller than them: a graveyard is a place
     rather than a settlement, and on a map of an island the difference has to be
     legible at two pixels.

     Pale stone, which nothing else on the map is — the island is greens and
     browns, the bands are their own colours, the paths are trodden earth. A
     band that has raised something gets a ring round the mark rather than a
     bigger one, because how much is standing there is the thing worth seeing
     from above and the position is not. */
  for (const c of mapShows.barrows ? camps : []) {
    if (!c.barrow) continue;
    const [px, py] = worldToMap(c.barrow.x, c.barrow.z);
    mapCtx.beginPath();
    mapCtx.arc(px, py, 1.1 * MK, 0, Math.PI * 2);
    mapCtx.fillStyle = 'rgba(216, 210, 196, 0.92)';
    mapCtx.fill();
    mapCtx.lineWidth = 0.7 * MK;
    mapCtx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    mapCtx.stroke();
    const raised = c.skill?.art || 0;
    if (raised > 0.02) {
      mapCtx.beginPath();
      mapCtx.arc(px, py, (2.2 + 1.8 * raised) * MK, 0, Math.PI * 2);
      mapCtx.strokeStyle = `rgba(226, 220, 205, ${(0.25 + 0.55 * raised).toFixed(2)})`;
      mapCtx.lineWidth = 0.6 * MK;
      mapCtx.stroke();
    }
  }

  /* And on the full map, whose band it is. The dot carries the colour and the
     colour is enough to match a fire to a name on the panel; the code says it
     outright, and there is only room to say it at this size — twenty of these
     on a 92-pixel corner map is the pile of labels the dots were introduced to
     get rid of. Drawn after every dot so no fire is written over by the next
     camp's marker. */
  if (mapIsFull() && mapShows.camps) {
    mapCtx.font = `700 ${(6.5 * MK).toFixed(1)}px ui-sans-serif, system-ui, sans-serif`;
    mapCtx.textBaseline = 'middle';
    mapCtx.lineJoin = 'round';
    for (const c of camps) {
      if (c.gone) continue;
      const [px, py] = worldToMap(c.x, c.z);
      const at = px + 3.2 * MK;
      // Outlined rather than boxed: a label with a panel behind it hides the
      // ground it is labelling, and there are twenty of them.
      mapCtx.lineWidth = 2.4 * MK;
      mapCtx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      mapCtx.strokeText(c.code, at, py);
      mapCtx.fillStyle = c.color;
      mapCtx.fillText(c.code, at, py);
    }
  }

  // The band. Asleep is drawn smaller and dimmer rather than hidden, so an
  // empty-looking camp at night is still legibly a camp full of people.
  for (const p of mapShows.people ? people : []) {
    const [px, py] = worldToMap(p.x, p.z);
    mapCtx.beginPath();
    mapCtx.arc(px, py, (p.asleep ? 0.7 : 1.05) * MK, 0, Math.PI * 2);
    mapCtx.fillStyle = p.asleep ? 'rgba(255, 214, 150, 0.5)'
      : p.child ? '#ffe9a8' : '#ffcc74';
    mapCtx.fill();
    if (p.job === 'hunt' && !p.asleep) {     // a party out hunting is worth seeing
      mapCtx.strokeStyle = 'rgba(255, 120, 90, 0.85)';
      mapCtx.lineWidth = MK;
      mapCtx.beginPath();
      mapCtx.arc(px, py, 1.9 * MK, 0, Math.PI * 2);
      mapCtx.stroke();
    }
  }

  drawYou(true);
  updateScaleBar();
}

/* The corner map: land and water, the worn paths, a dot for each band, and
   you. Everything else — the relief, the food, the herds, the graves, every
   person — is the full map's, one click away. */
function drawCornerMap() {
  const src = MAP_N * (mapView.span / WORLD);
  const sx = ((mapView.x - mapView.span / 2 + WORLD / 2) / WORLD) * MAP_N;
  const sz = ((mapView.z - mapView.span / 2 + WORLD / 2) / WORLD) * MAP_N;
  mapCtx.drawImage(mapPlain || mapBase, sx, sz, src, src, 0, 0, MAP_N, MAP_N);
  drawPathLayer();
  for (const c of camps) {
    const [px, py] = worldToMap(c.x, c.z);
    mapCtx.beginPath();
    mapCtx.arc(px, py, 1.9 * MK, 0, Math.PI * 2);
    mapCtx.fillStyle = c.color;
    mapCtx.fill();
    mapCtx.lineWidth = 0.9 * MK;
    mapCtx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    mapCtx.stroke();
  }
  drawYou(false);
}

/* You: an arrow the way you are looking — and on the full map the wedge of
   what the camera sees. */
function drawYou(cone) {
  const [cx, cy] = worldToMap(camera.position.x, camera.position.z);
  camera.getWorldDirection(_fwd);
  const nx = _fwd.x, ny = _fwd.z;
  if (cone) {
    const heading = Math.atan2(ny, nx);
    const hFov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect);
    mapCtx.beginPath();
    mapCtx.moveTo(cx, cy);
    mapCtx.arc(cx, cy, 22 * MK, heading - hFov / 2, heading + hFov / 2);
    mapCtx.closePath();
    mapCtx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    mapCtx.fill();
  }

  const len = Math.hypot(nx, ny) || 1;
  const fx = nx / len, fy = ny / len;
  mapCtx.beginPath();
  mapCtx.moveTo(cx + fx * 5.5 * MK, cy + fy * 5.5 * MK);
  mapCtx.lineTo(cx - (fx * 3 + fy * 3) * MK, cy - (fy * 3 - fx * 3) * MK);
  mapCtx.lineTo(cx - (fx * 3 - fy * 3) * MK, cy - (fy * 3 + fx * 3) * MK);
  mapCtx.closePath();
  mapCtx.fillStyle = '#ffffff';
  mapCtx.fill();
  mapCtx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
  mapCtx.lineWidth = MK;
  mapCtx.stroke();
}

/* Click to travel. Fly keeps whatever height you were at, walk lands on the
   ground, orbit reassembles its rig around the new spot. */
export function travelTo(x, z) {
  /* Follow is not a place you can travel from: the camera is rebuilt behind
     somebody every frame, so putting it on a hillside lasts exactly one frame
     and the click reads as doing nothing. Clicking the map is asking to be
     somewhere, which means letting go of the person first — and setViewMode
     hands them back to their own life on the way out. */
  if (P.view === 'follow') setViewMode('orbit');
  /* And put a full-page map away. Travelling is "show me that place", and a map
     filling the window is the one thing between you and it — click a band on
     the full map and you would arrive behind the map you clicked, which reads
     as the click having done nothing at all. The same mistake as leaving the
     band card up, one layer further out.

     Only the full one: a corner map is not in the way, and taking it away
     because you travelled would be answering a question nobody asked. */
  if (mapIsFull()) setMapSize(SMALL_MAP);
  /* One rig to land now, which is most of what removing Fly and Walk bought:
     this used to ask which of four cameras it was putting down and keep a
     height for each. Orbit is reassembled around the new spot — the pivot on
     the ground, the camera behind and above it — which is the same thing it
     does when you cycle into it. */
  const ground = sampleHeight(x, z);
  controls.target.set(x, ground + 2.5, z);
  camera.position.set(x, ground + 13, z + 46);
  controls.update();
  syncLookFromCamera();
  // The grass tiles are indexed off the camera; without this you arrive on bare
  // ground and watch it grow in a row at a time.
  updateTiles(true);
  recountBlades();
}

/* -------------------------------------------------------------------------
   Dragging a zoomed map

   The same pointer does two things on this canvas — go there, and look over
   there — and the only thing separating them is how far it moved. So the click
   is not a click handler at all: it is a pointerup that travels if the pointer
   stayed put, and pans if it did not.

   `DRAG_SLOP` is what "stayed put" means. Too small and every travel is eaten
   by the hand shake of a real click; too large and a short drag teleports you
   into the sea. Four pixels is about a mouse's worth of wobble.
   ------------------------------------------------------------------------- */
export const DRAG_SLOP = 4;
const drag = { on: false, id: 0, x: 0, y: 0, moved: 0 };

/* How near a fire counts as pointing at it, in screen pixels rather than
   metres. The dot is drawn under two pixels across, which is a fine thing to
   look at and an impossible thing to hit — so what is clickable is a target
   round it, sized for a pointer instead of for the island. Ten is about a
   fingertip and small enough that two camps a hundred metres apart do not
   overlap at any zoom worth using. */
export const CAMP_HIT = 10;

/** The band whose fire is under this point on the canvas, if any. */
export function campUnder(clientX, clientY) {
  const r = mapCanvas.getBoundingClientRect();
  if (!r.width) return null;
  const px = clientX - r.left, py = clientY - r.top;
  let best = null, near = CAMP_HIT;
  for (const c of camps) {
    if (c.gone) continue;
    const [mx, my] = worldToMap(c.x, c.z);
    // Map units are MAP_N across; the canvas is however wide it is on screen.
    const d = Math.hypot(mx / MAP_N * r.width - px, my / MAP_N * r.height - py);
    if (d < near) { near = d; best = c; }
  }
  return best;
}

/** Can this map be dragged at all? Only a zoomed one has anywhere to go. */
export function mapCanPan() { return mapIsFull() && mapZoom > 1; }

mapCanvas.addEventListener('pointerdown', (ev) => {
  drag.on = true;
  drag.id = ev.pointerId;
  drag.x = ev.clientX;
  drag.y = ev.clientY;
  drag.moved = 0;
  if (mapCanPan()) mapCanvas.setPointerCapture?.(ev.pointerId);
});

mapCanvas.addEventListener('pointermove', (ev) => {
  /* Three things a click can mean here and the cursor says which: a hand on a
     map you can drag, a pointer on a band you can go and look at, and nothing
     in particular on open ground you can travel to. A target you cannot see is
     a target nobody presses. */
  /* And a mark says what it is before you click it: the canvas's own tooltip,
     rewritten only when what is under the pointer changes. */
  const hit = drag.on || !mapIsFull() ? null : markUnder(ev.clientX, ev.clientY);
  // The corner map is only for looking at: a click opens the full one.
  const tip = !mapIsFull() ? 'open the map' : hit ? hit.mark.label : 'click to travel';
  if (mapCanvas.title !== tip) mapCanvas.title = tip;
  mapCanvas.style.cursor = !mapIsFull() ? 'pointer' : drag.on ? (mapCanPan() ? 'grabbing' : '')
    : hit || campUnder(ev.clientX, ev.clientY) ? 'pointer'
      : mapCanPan() ? 'grab' : '';
  if (!drag.on) return;
  const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = ev.clientX;
  drag.y = ev.clientY;
  if (!mapCanPan() || drag.moved <= DRAG_SLOP) return;
  /* Metres per screen pixel, so the ground keeps pace with the pointer — the
     map moves with your hand rather than at some rate of its own. Backwards,
     because dragging the map right means looking further west. */
  const per = mapView.span / mapCanvas.getBoundingClientRect().width;
  setMapPan(mapView.x - dx * per, mapView.z - dy * per);
});

const endDragMap = (ev) => {
  if (!drag.on) return;
  drag.on = false;
  mapCanvas.releasePointerCapture?.(ev.pointerId);
  mapCanvas.style.cursor = mapCanPan() ? 'grab' : '';
  /* The corner map takes no clicks of its own — not a band, not a mark, not a
     place to travel to. It is for glancing at, and a click on it opens the
     full map, where all of that is. */
  if (!mapIsFull()) { setMapSize(FULL_MAP); return; }
  // Moved: that was a drag, and it has already happened. Still: go there.
  if (drag.moved > DRAG_SLOP) return;

  /* A band under the pointer is a place rather than a coordinate, so clicking
     one goes to look at it: the rig lands on the fire rather than on whichever
     metre of ground the pointer happened to be over, and the band's card opens
     beside it. Half of "which of these is Ndahouth" is answered by the dot's
     colour; this answers the rest of it. */
  /* A mark goes and looks at what it marks, and says what that is — the
     same as a band does, one kind of place further in. A granary stands a few
     pixels from its own fire on a whole-island map, so both can be under the
     pointer at once, and the one nearer it is the one being pointed at. */
  const camp = campUnder(ev.clientX, ev.clientY);
  const hit = markUnder(ev.clientX, ev.clientY);
  if (hit && (!camp || hit.d < campDist(camp, ev.clientX, ev.clientY))) {
    travelTo(hit.mark.x, hit.mark.z);
    toast(hit.mark.label);
    return;
  }
  if (camp) {
    travelTo(camp.x, camp.z);
    openTribe(camps.indexOf(camp));
    toast(camp.name);
    return;
  }

  const r = mapCanvas.getBoundingClientRect();
  const [x, z] = mapToWorld((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
  travelTo(x, z);
};
mapCanvas.addEventListener('pointerup', endDragMap);
mapCanvas.addEventListener('pointercancel', () => { drag.on = false; });

/* The three buttons on the full map. They are the same three things M and the
   wheel do, put where somebody who has not read the keys card can find them —
   a map that fills the window is the one place in this page with room to say
   what it can do. */
$('mapIn')?.addEventListener('click', () => stepMapZoom(1));
$('mapOut')?.addEventListener('click', () => stepMapZoom(-1));
/* Back to the corner rather than off. "Minimise" on a window that fills the
   screen means make it small, and there is a key for making it go away. */
$('mapMin')?.addEventListener('click', () => setMapSize(SMALL_MAP));

/* What the map shows: the funnel opens the list, and each line in it puts one
   layer away or brings it back. One listener on the list rather than one on
   every line. */
$('mapFilter')?.addEventListener('click', () => {
  const box = $('mapLayers');
  if (!box) return;
  box.hidden = !box.hidden;
  $('mapFilter').setAttribute('aria-expanded', String(!box.hidden));
});
$('mapLayers')?.addEventListener('click', (ev) => {
  /* All of them: back on if anything is hidden, away if nothing is. Bringing
     everything back is the more useful half, so a mixed list goes that way. */
  if (ev.target?.closest?.('button[data-all]')) {
    setAllMapLayers(!MAP_LAYERS.every((k) => mapShows[k]));
    return;
  }
  const b = ev.target?.closest?.('button[data-layer]');
  if (b) setMapLayer(b.dataset.layer, !mapShows[b.dataset.layer]);
});
paintLayerButtons();

/* The wheel over the map zooms it, which is what a wheel over a map does. Only
   at full size: over the corner map it would fight the page. */
mapCanvas.addEventListener('wheel', (ev) => {
  if (!mapIsFull()) return;
  ev.preventDefault();
  stepMapZoom(ev.deltaY < 0 ? 1 : -1);
}, { passive: false });

addEventListener('pointerdown', armAudio);
addEventListener('keydown', armAudio);
document.addEventListener('visibilitychange', () => {
  // Closing the tab is the one moment a save matters most and the timer is
  // least likely to have just run.
  if (document.hidden) persistState();
  if (!audio.ctx) return;
  if (document.hidden) audio.ctx.suspend?.();
  else if (P.sound) audio.ctx.resume?.();
});


