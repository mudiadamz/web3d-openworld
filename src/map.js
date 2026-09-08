import * as THREE from 'three';

import { P, SEA, WORLD } from './params.js';
import { clamp, flatnessAt, sampleHeight, smoothstep } from './noise.js';
import { camera, controls, groundColorAt } from './scene.js';
import { updateTiles } from './world.js';
import { packs } from './wildlife.js';
import { camps, people } from './people.js';
import { recountBlades, streams } from './move.js';
import { _fwd, syncLookFromCamera } from './chronicle.js';
import { $, persistState } from './save.js';
import { armAudio, audio } from './audio.js';

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
export const MAP_DISPLAY = 118;            // how big it actually sits on screen
// Marker sizes below are written in screen pixels; this converts them.
export const MK = MAP_N / MAP_DISPLAY;
export const mapCanvas = $('mapCanvas');
export const mapCtx = mapCanvas.getContext('2d');
mapCanvas.style.width = MAP_DISPLAY + 'px';
mapCanvas.style.height = MAP_DISPLAY + 'px';
export let mapBase = null;
export let nextMapDraw = 0;

export const MAP_WATER = new THREE.Color(0x2b5a78);
export const MAP_DEEP = new THREE.Color(0x122b44);

export function worldToMap(x, z) {
  return [((x + WORLD / 2) / WORLD) * MAP_N, ((z + WORLD / 2) / WORLD) * MAP_N];
}
export function mapToWorld(u, v) {
  return [u * WORLD - WORLD / 2, v * WORLD - WORLD / 2];
}

export function renderMapBase() {
  mapBase = document.createElement('canvas');
  mapBase.width = MAP_N;
  mapBase.height = MAP_N;
  const ctx = mapBase.getContext('2d');
  const img = ctx.createImageData(MAP_N, MAP_N);
  const d = img.data;
  const col = new THREE.Color();
  const step = WORLD / MAP_N;

  for (let j = 0; j < MAP_N; j++) {
    const z = -WORLD / 2 + (j + 0.5) * step;
    for (let i = 0; i < MAP_N; i++) {
      const x = -WORLD / 2 + (i + 0.5) * step;
      const h = sampleHeight(x, z);
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

  // The creeks are thinner than a map pixel in places, so they are drawn as
  // lines rather than left to the terrain shading to imply.
  ctx.strokeStyle = 'rgba(104, 166, 196, 0.95)';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const path of streams) {
    ctx.beginPath();
    for (let i = 0; i < path.length; i++) {
      const [px, py] = worldToMap(path[i].x, path[i].z);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.lineWidth = 1.5 * MK;
    ctx.stroke();
  }
  nextMapDraw = 0;
}

export function drawMap(now) {
  if (!mapBase || $('map').hidden) return;
  if (now < nextMapDraw) return;
  nextMapDraw = now + 0.07;           // ~14 a second is plenty for dots

  mapCtx.drawImage(mapBase, 0, 0);

  // Animals first and faintest: they are context, not the point.
  mapCtx.fillStyle = 'rgba(226, 240, 205, 0.55)';
  for (const pack of packs) {
    for (const a of pack.list) {
      const [px, py] = worldToMap(a.x, a.z);
      mapCtx.fillRect(px - 0.5 * MK, py - 0.5 * MK, 1.1 * MK, 1.1 * MK);
    }
  }

  // Camps: a ring you can pick out at a glance, plus its fire.
  for (const c of camps) {
    const [px, py] = worldToMap(c.x, c.z);
    mapCtx.beginPath();
    mapCtx.arc(px, py, 4.2 * MK, 0, Math.PI * 2);
    mapCtx.strokeStyle = 'rgba(255, 150, 60, 0.9)';
    mapCtx.lineWidth = 1.1 * MK;
    mapCtx.stroke();
    mapCtx.beginPath();
    mapCtx.arc(px, py, 1.4 * MK, 0, Math.PI * 2);
    mapCtx.fillStyle = '#ff9b3c';
    mapCtx.fill();
    // The name under the ring, so the map and the panel are talking about the
    // same band without you having to work out which is which.
    mapCtx.font = `${8 * MK}px system-ui, sans-serif`;
    mapCtx.textAlign = 'center';
    mapCtx.lineWidth = 3 * MK;
    mapCtx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
    mapCtx.strokeText(c.name, px, py + 11 * MK);
    mapCtx.fillStyle = '#ffd9a8';
    mapCtx.fillText(c.name, px, py + 11 * MK);
    mapCtx.textAlign = 'left';
  }

  // The band. Asleep is drawn smaller and dimmer rather than hidden, so an
  // empty-looking camp at night is still legibly a camp full of people.
  for (const p of people) {
    const [px, py] = worldToMap(p.x, p.z);
    mapCtx.beginPath();
    mapCtx.arc(px, py, (p.asleep ? 1.0 : 1.6) * MK, 0, Math.PI * 2);
    mapCtx.fillStyle = p.asleep ? 'rgba(255, 214, 150, 0.5)'
      : p.child ? '#ffe9a8' : '#ffcc74';
    mapCtx.fill();
    if (p.job === 'hunt' && !p.asleep) {     // a party out hunting is worth seeing
      mapCtx.strokeStyle = 'rgba(255, 120, 90, 0.85)';
      mapCtx.lineWidth = MK;
      mapCtx.beginPath();
      mapCtx.arc(px, py, 2.8 * MK, 0, Math.PI * 2);
      mapCtx.stroke();
    }
  }

  // You, and where you are looking.
  const [cx, cy] = worldToMap(camera.position.x, camera.position.z);
  camera.getWorldDirection(_fwd);
  const nx = _fwd.x, ny = _fwd.z;
  const heading = Math.atan2(ny, nx);
  const hFov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect);

  mapCtx.beginPath();
  mapCtx.moveTo(cx, cy);
  mapCtx.arc(cx, cy, 22 * MK, heading - hFov / 2, heading + hFov / 2);
  mapCtx.closePath();
  mapCtx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  mapCtx.fill();

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
  const ground = sampleHeight(x, z);
  if (P.view === 'orbit') {
    controls.target.set(x, ground + 2.5, z);
    camera.position.set(x, ground + 13, z + 46);
    controls.update();
  } else {
    const wasAbove = camera.position.y - sampleHeight(camera.position.x, camera.position.z);
    const height = P.view === 'walk' ? 1.7 : clamp(wasAbove, 2, 600);
    camera.position.set(x, ground + height, z);
  }
  syncLookFromCamera();
  // The grass tiles are indexed off the camera; without this you arrive on bare
  // ground and watch it grow in a row at a time.
  updateTiles(true);
  recountBlades();
}

mapCanvas.addEventListener('click', (ev) => {
  const r = mapCanvas.getBoundingClientRect();
  const [x, z] = mapToWorld((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
  travelTo(x, z);
});

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


