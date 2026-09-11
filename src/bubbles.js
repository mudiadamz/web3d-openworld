import * as THREE from 'three';

import { sampleHeight, smoothstep } from './noise.js';
import { camera, renderer, scene } from './scene.js';
import { PERSON } from './clock.js';
import { people, smokeUniforms } from './people.js';
import { WALKING_AT } from './chronicle.js';
import { ICON_PATHS } from './icons.js';

/* -------------------------------------------------------------------------
   What they are doing, over their heads

   The caption says what one person is doing, and only the one you are behind.
   Everybody else was a figure standing still, and a figure standing still in a
   berry patch, at a granary, at the water's edge and at the next band's fire
   all looked the same. So anybody stopped to do something says what, in a
   bubble over their head: the order row's own icons, so a thing you can tell
   somebody to do looks the same as somebody doing it.

   Only while they are stopped. Walking is walking; the bubble is for the part
   of an errand that is the errand. And under a roof it goes over the tent
   instead, because knapping and sleeping happen where the figure is not drawn,
   and a tent with a flint over it is a tent with somebody knapping in it.

   One draw for all of them: points, sized in the shader, reading one small
   atlas painted once onto a canvas. Only so far out from the camera, because a
   bubble two hundred metres off is a speck and a hundred specks are noise.
   ------------------------------------------------------------------------- */
export const BUBBLE = {
  gather: 0, hunt: 1, craft: 2, tend: 3, sleep: 4, visit: 5, quarry: 6,
  fish: 7, raid: 8, mourn: 9, store: 10, rest: 11, nurse: 12, wood: 13, explore: 14,
};
/* And the word each one says beside its icon. One word, because a bubble is a
   glance and not a caption — the caption is still there for the person you are
   behind. */
export const BUBBLE_SAYS = {
  gather: 'foraging', hunt: 'hunting', craft: 'knapping', tend: 'tending',
  sleep: 'sleeping', visit: 'trading', quarry: 'quarrying', fish: 'fishing',
  raid: 'raiding', mourn: 'mourning', store: 'storing', rest: 'resting',
  nurse: 'nursing', wood: 'chopping', explore: 'exploring',
};
export const BUBBLE_RANGE = 70;      // metres from the camera past which nothing is said
/* Nearer than this a bubble carries its word; further out, the icon alone.
   A word has to be about twelve pixels tall to be read, and at seventy metres
   that makes every bubble wider than the person under it — a camp of them is
   a wall of labels. Fifty takes in the ground you land looking at when you
   travel somewhere on the map. */
export const BUBBLE_WORDS = 50;
export const BUBBLE_MAX = 192;
const BUBBLE_TENT = 4.0;             // metres up: over the tip of the tallest tent
/* The atlas: cells 128 pixels a side, eight across and four down. The first
   sixteen are the icons alone; the same icon with its word is sixteen further
   on, which is all the shader needs to know to size it as the wide one. */
const ATLAS_CELL = 128;
const ATLAS_COLS = 8, ATLAS_ROWS = 4;
export const WORD_AT = 16;

/** What somebody is doing, as an icon, or -1 for nothing worth a bubble.

    Off the same two things the caption reads — `p.hidden` and `p.speed` — so
    the bubble cannot say one thing while the figure does another. */
export function bubbleFor(p) {
  // Being walked about by hand, or running from something: not a task.
  if (p.led || p.panic > 0) return -1;
  if (p.hidden) {
    /* Under a roof. Said over the tent, and only for what is worth saying
       there: a tent of people sitting about is every tent. */
    if (p.asleep || (p.job === 'sleep' && p.state === 'work')) return BUBBLE.sleep;
    if (p.state !== 'work') return -1;
    if (p.job === 'craft') return BUBBLE.craft;
    if (p.job === 'nurse') return BUBBLE.nurse;
    return -1;
  }
  if (p.speed > WALKING_AT) return -1;
  /* Just in from an errand and standing at the granaries: putting it away.
     Otherwise stood between one thing and the next, which is resting. */
  if (p.state === 'idle') return p.stowed ? BUBBLE.store : BUBBLE.rest;
  if (p.state === 'work') return BUBBLE[p.job] ?? -1;
  return -1;
}

/* The drawings are in icons.js, shared with the map's marks, so a berry patch
   on the map and somebody picking in one are the same picture. Each bubble is
   the icon of its own name, except a visit, which is drawn as the trade it is
   for rather than as the walk. */
const BUBBLE_ICON = { visit: 'trade' };
const ICONS = [];
const WORDS = [];
for (const [k, i] of Object.entries(BUBBLE)) {
  ICONS[i] = ICON_PATHS[BUBBLE_ICON[k] || k];
  WORDS[i] = BUBBLE_SAYS[k];
}

/* Pale and see-through, so a camp of them sits over the scene rather than
   in front of it. */
const HIDE = 'rgba(248, 243, 231, 0.55)';
const HIDE_EDGE = 'rgba(58, 46, 34, 0.18)';
const BUBBLE_OPACITY = 0.8;           // of the whole bubble, ink and all
const INK = '#2b2620';

/* One icon, sixteen units a side, drawn at `size` pixels with its top-left at
   (x, y) of the current cell. */
function drawIcon(ctx, icon, ox, oy, x, y, size) {
  if (typeof Path2D !== 'function') return;
  const s = size / 16;
  ctx.setTransform(s, 0, 0, s, ox + x, oy + y);
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  for (const d of icon.stroke || []) ctx.stroke(new Path2D(d));
  for (const d of icon.fill || []) ctx.fill(new Path2D(d));
  ctx.setTransform(1, 0, 0, 1, ox, oy);
}

/* The round bubble, for far off: a disc of pale hide with a point under it. */
function paintRound(ctx, icon, ox, oy) {
  ctx.setTransform(1, 0, 0, 1, ox, oy);
  ctx.fillStyle = HIDE;
  ctx.beginPath();
  ctx.arc(64, 54, 46, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(52, 92); ctx.lineTo(64, 118); ctx.lineTo(76, 92);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = HIDE_EDGE;
  ctx.beginPath();
  ctx.arc(64, 54, 46, 0, Math.PI * 2);
  ctx.stroke();
  drawIcon(ctx, icon, ox, oy, 64 - 34, 54 - 34, 68);
}

/* The wide one, for near: a pill with the icon at its left and the word after
   it, as wide as the word needs and never wider than the cell. Built from arcs
   and lines rather than roundRect, which the boot check's canvas does not
   have — and which older browsers do not either. */
function paintPill(ctx, icon, word, ox, oy) {
  ctx.setTransform(1, 0, 0, 1, ox, oy);
  // Bigger in the cell, so the word still reads with the bubble drawn smaller.
  const cy = 52, r = 23, iconPx = 30, pad = 10, gap = 5;
  let font = 24;
  ctx.font = `700 ${font}px ui-sans-serif, system-ui, sans-serif`;
  let w = ctx.measureText(word).width || word.length * 11;
  const room = ATLAS_CELL - 4 - pad * 2 - iconPx - gap;
  if (w > room) {                     // "quarrying" is the long one
    font = Math.floor(font * room / w);
    ctx.font = `700 ${font}px ui-sans-serif, system-ui, sans-serif`;
    w = room;
  }
  const width = Math.min(ATLAS_CELL - 4, pad * 2 + iconPx + gap + w);
  const x0 = 64 - width / 2, x1 = 64 + width / 2;
  ctx.fillStyle = HIDE;
  ctx.beginPath();
  ctx.arc(x0 + r, cy, r, Math.PI / 2, Math.PI * 1.5);
  ctx.lineTo(x1 - r, cy - r);
  ctx.arc(x1 - r, cy, r, -Math.PI / 2, Math.PI / 2);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = HIDE_EDGE;
  ctx.stroke();
  ctx.fillStyle = HIDE;
  ctx.beginPath();
  ctx.moveTo(57, cy + r - 1); ctx.lineTo(64, cy + r + 12); ctx.lineTo(71, cy + r - 1);
  ctx.closePath();
  ctx.fill();
  drawIcon(ctx, icon, ox, oy, x0 + pad, cy - iconPx / 2, iconPx);
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(word, x0 + pad + iconPx + gap, cy + 1);
}

/* Painted once, both shapes of every bubble.

   Path2D is what turns the order row's path strings into strokes, and it is
   not there outside a browser — the boot check paints the bubbles and gets
   blank ones, which is the right answer to "does it build". */
function paintAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_CELL * ATLAS_COLS;
  canvas.height = ATLAS_CELL * ATLAS_ROWS;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const cell = (i) => [(i % ATLAS_COLS) * ATLAS_CELL, Math.floor(i / ATLAS_COLS) * ATLAS_CELL];
  ICONS.forEach((icon, i) => {
    paintRound(ctx, icon, ...cell(i));
    paintPill(ctx, icon, WORDS[i], ...cell(i + WORD_AT));
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

let points = null, pos = null, icon = null, alpha = null;
const uniforms = {
  uAtlas: { value: null },
  // Shared with the smoke, which keeps them right as the window changes size.
  uViewportH: smokeUniforms.uViewportH,
  uTanHalfFov: smokeUniforms.uTanHalfFov,
  uDpr: { value: 1 },
};

/* Built the first time there is somebody to put a bubble over, not with the
   world: it belongs to the camera, like the lead marker, and lives on the
   scene so a new island does not throw it away. */
function buildBubbles() {
  const geo = new THREE.BufferGeometry();
  pos = new THREE.BufferAttribute(new Float32Array(BUBBLE_MAX * 3), 3);
  icon = new THREE.BufferAttribute(new Float32Array(BUBBLE_MAX), 1);
  alpha = new THREE.BufferAttribute(new Float32Array(BUBBLE_MAX), 1);
  for (const a of [pos, icon, alpha]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', pos);
  geo.setAttribute('aIcon', icon);
  geo.setAttribute('aAlpha', alpha);
  geo.setDrawRange(0, 0);
  uniforms.uAtlas.value = paintAtlas();
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute float aIcon;
      attribute float aAlpha;
      uniform float uViewportH;
      uniform float uTanHalfFov;
      uniform float uDpr;
      varying float vIcon;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float perMetre = uViewportH / (2.0 * uTanHalfFov * max(-mv.z, 0.1));
        /* The round one: six tenths of a metre across, but never so small it
           cannot be read or so big it covers the person under it. The wide
           one: small, but with its word still about eleven pixels tall at its
           smallest, which is about the least a word can be and still be read. */
        float round = clamp(0.6 * perMetre, 13.0 * uDpr, 26.0 * uDpr);
        float wide = clamp(1.8 * perMetre, 62.0 * uDpr, 88.0 * uDpr);
        gl_PointSize = aIcon > ${(WORD_AT - 0.5).toFixed(1)} ? wide : round;
        vIcon = aIcon;
        vAlpha = aAlpha;
      }`,
    fragmentShader: `
      uniform sampler2D uAtlas;
      varying float vIcon;
      varying float vAlpha;
      void main() {
        float i = floor(vIcon + 0.5);
        float col = mod(i, ${ATLAS_COLS.toFixed(1)}), row = floor(i / ${ATLAS_COLS.toFixed(1)});
        vec2 uv = vec2((col + gl_PointCoord.x) / ${ATLAS_COLS.toFixed(1)},
                       1.0 - (row + gl_PointCoord.y) / ${ATLAS_ROWS.toFixed(1)});
        vec4 t = texture2D(uAtlas, uv);
        if (t.a * vAlpha < 0.02) discard;
        gl_FragColor = vec4(t.rgb, t.a * vAlpha * ${BUBBLE_OPACITY.toFixed(2)});
      }`,
  });
  points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.renderOrder = 6;
  scene.add(points);
}

/* One bubble per tent, whatever is going on in it: the most interesting thing
   wins, so a tent with a knapper and two sleepers says knapping. */
const HUT_RANK = { [BUBBLE.craft]: 3, [BUBBLE.nurse]: 2, [BUBBLE.sleep]: 1 };
const _huts = new Map();

/* How many went up last frame, of what, and how many of them close enough to
   carry their word. Read by the boot check. */
export const bubbleStats = { shown: 0, worded: 0, byIcon: new Array(ICONS.length).fill(0) };

function put(n, x, y, z, k, d2) {
  const d = Math.sqrt(d2);
  const near = d < BUBBLE_WORDS;
  pos.setXYZ(n, x, y, z);
  icon.setX(n, near ? k + WORD_AT : k);
  // Fading out over the last third of the range rather than popping.
  alpha.setX(n, 1 - smoothstep(BUBBLE_RANGE * 0.7, BUBBLE_RANGE, d));
  bubbleStats.byIcon[k]++;
  if (near) bubbleStats.worded++;
  return n + 1;
}

/** Every frame the world is drawn. */
export function updateBubbles() {
  if (!points) {
    if (!people.length) return;
    buildBubbles();
  }
  const cam = camera.position;
  const far2 = BUBBLE_RANGE * BUBBLE_RANGE;
  const head = PERSON.legLen + PERSON.headY + 0.62;
  bubbleStats.byIcon.fill(0);
  bubbleStats.worded = 0;
  _huts.clear();
  let n = 0;
  for (const p of people) {
    if (n >= BUBBLE_MAX) break;
    const k = bubbleFor(p);
    if (k < 0) continue;
    if (p.hidden) {
      if (!p.hut) continue;
      const had = _huts.get(p.hut);
      if (had === undefined || HUT_RANK[k] > HUT_RANK[had]) _huts.set(p.hut, k);
      continue;
    }
    const dx = p.x - cam.x, dz = p.z - cam.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > far2) continue;
    n = put(n, p.x, sampleHeight(p.x, p.z) + head * (p.scale || 1) + (p.lift || 0), p.z, k, d2);
  }
  for (const [h, k] of _huts) {
    if (n >= BUBBLE_MAX) break;
    const dx = h.x - cam.x, dz = h.z - cam.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > far2) continue;
    n = put(n, h.x, sampleHeight(h.x, h.z) + BUBBLE_TENT, h.z, k, d2);
  }
  points.geometry.setDrawRange(0, n);
  pos.needsUpdate = true;
  icon.needsUpdate = true;
  alpha.needsUpdate = true;
  uniforms.uDpr.value = renderer.getPixelRatio?.() || 1;
  bubbleStats.shown = n;
}
