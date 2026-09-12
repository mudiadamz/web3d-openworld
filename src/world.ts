import * as THREE from 'three';

import { P, SEA, SNOW, TILE, WORLD } from './params.js';
import { clamp, fbm, flatnessAt, hash2, mulberry32, sampleHeight } from './noise.js';
import {
  C_GRASS_B, FRUIT_COLORS, camera, fruitMaterial, grassMaterial, groundColorAt, lastGreen,
  pineCanopyMaterial, rockMaterial, roundCanopyMaterial, scene, terrainMaterial,
  trunkMaterial, waterMaterial
} from './scene.js';
import { clearFauna, pick } from './wildlife.js';
import { clearTribe, inCamp, setGraveMesh, setGraves, setNearParts, tribeGroup } from './people.js';
import { PATH, PATH_EARTH, clearPaths, takeWornTiles, tileFromKey, wearAt } from './paths.js';
import { setWet } from './creeks.js';
import { isWet, streams, tintBank } from './creeks.js';
import { updateHud } from './main.js';

/* -------------------------------------------------------------------------
   World construction
   ------------------------------------------------------------------------- */

export const world = new THREE.Group();


/* Each population lives in its own group so a slider can rebuild just that
   population. Changing the number of rabbits has no business regenerating the
   terrain, and a full rebuild would throw away the second or so of noise that
   the height field costs. */
export const terrainGroup = new THREE.Group();
export const floraGroup = new THREE.Group();
export const rockGroup = new THREE.Group();
/* The quarries' heaps. A group of their own rather than the rocks', because the
   rocks slider rebuilds that one and a quarry is not scenery. */
export const depositGroup = new THREE.Group();
/* And the berry thickets', for the same reason. */
export const thicketGroup = new THREE.Group();
/* Every rock worth quarrying, in world coordinates. Rebuilt with the world. */
export const outcrops = [];
/* And every tree, where it stands, so somebody can climb one. */
export const treeSpots = [];

/** The nearest one to here, or nothing if they are all too far to be worth it. */
export function nearestRock(x, z, within) {
  let best = null, near = within;
  for (const r of outcrops) {
    const d = Math.hypot(r.x - x, r.z - z);
    if (d < near) { near = d; best = r; }
  }
  return best;
}
export const grassGroup = new THREE.Group();
export const fauna = new THREE.Group();
/* Hung together once main says everything exists. Doing it as the module
   loaded meant reaching for a scene that a module in the same import cycle
   had not finished making. */
export function wireWorld() {
  scene.add(world);
  world.add(terrainGroup, floraGroup, rockGroup, depositGroup, thicketGroup, grassGroup, fauna);
}

/* The pickable fruit: the mesh, every fruit's resting transform, which of them
   are still on the tree, and how many that is. Null until a world with
   broadleaves in it has been built. */
export let orchard = null;

export let grassTiles = [];      // { mesh, flowers, ix, iz }
export let dirtyTiles = [];      // rebuild queue, drained a few per frame
export let GRID = 9, BLADES = 2000;
export let bladeGeo = null, flowerGeo = null;
/** What is in the world, for the panel and the boot check. `graves` arrives
    once anybody has been buried, which is why it is optional rather than 0:
    a world nobody has died in has no graves, not zero of them. */
export interface Stats {
  blades: number; trees: number; rocks: number; fruit: number;
  animals: number; people: number; models: number; modelled: number;
  graves?: number;
}

export let stats = { blades: 0, trees: 0, rocks: 0, fruit: 0, animals: 0, people: 0, models: 0, modelled: 0 } as Stats;

export function disposeGroup(group) {
  group.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh) o.geometry?.dispose();
  });
  group.clear();
}

export function disposeWorld() {
  orchard = null;
  stats.fruit = 0;
  /* The mesh goes with tribeGroup; the list has to go with it, or the next
     world opens with the last one's dead scattered over ground they never
     walked on. */
  setGraves([]);
  setGraveMesh(null);
  /* The near set's meshes go with tribeGroup below, so the only thing left to
     drop is the handle on them — a world must not start holding the last one's
     face, however briefly. */
  setNearParts(null);
  stats.graves = 0;
  for (const g of [terrainGroup, floraGroup, rockGroup, depositGroup, thicketGroup, grassGroup, fauna, tribeGroup]) disposeGroup(g);
  grassTiles = [];
  dirtyTiles = [];
  outcrops.length = 0;
  treeSpots.length = 0;
  streams.length = 0;
  setWet(null);
  clearPaths();
  clearFauna();
  clearTribe();
}

export function buildTerrain(seg) {
  const geo = new THREE.PlaneGeometry(WORLD, WORLD, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const green = new Float32Array(pos.count);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = sampleHeight(x, z);
    pos.setY(i, h);
    // Flatness from the field, not from the neighbouring vertices: the same
    // number the grass and the trees will ask for, so the rock colour and the
    // "too steep to grow" test can never disagree.
    groundColorAt(x, z, h, flatnessAt(x, z), c);
    tintBank(x, z, c);                     // wet, dark ground along a creek
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    green[i] = lastGreen;
  }
  pos.needsUpdate = true;
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aGreen', new THREE.BufferAttribute(green, 1));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, terrainMaterial);
  mesh.receiveShadow = true;
  /* Off by default, and this is the flickering fix. A heightfield casting onto
     itself is the classic acne case: 3.5 m triangles mean a large depth error
     across a single one, and the only lever three gives you — normalBias — is
     a single number shared with every other caster in the scene. Biasing it
     enough for the hills displaced the shadow lookup on a person by most of a
     person. Hills no longer shade each other; everything standing on them
     still does, correctly. `?terrainshadow=1` puts it back. */
  mesh.castShadow = Boolean(P.terrainShadow);
  mesh.name = 'terrain';
  terrainGroup.add(mesh);
}

export function buildWater() {
  // Enough subdivision to carry a 150-metre swell; the fine detail is normals.
  const geo = new THREE.PlaneGeometry(WORLD * 3, WORLD * 3, 240, 240);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, waterMaterial);
  mesh.position.y = SEA;
  mesh.name = 'water';
  mesh.visible = P.water;
  terrainGroup.add(mesh);
}

export function bladeGeometry(segments = 3) {
  const verts = [], norms = [], uvs = [], idx = [];
  const n = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const w = 0.5 * (1 - t * t * 0.92);   // taper to a near-point at the tip
    const bend = t * t * 0.18;            // a blade is never straight
    for (const s of [-1, 1]) {
      verts.push(s * w, t, bend);
      // Fanned normals give the flat blade a rounded, non-cardboard shading.
      n.set(s * 0.55, 0.12, 0.85).normalize();
      norms.push(n.x, n.y, n.z);
      uvs.push((s + 1) * 0.5, t);
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  // Zero throughout: a blade is coloured entirely by its instance colour, which
  // is the shade of the ground it grew out of.
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(verts.length / 3), 1));
  g.setIndex(idx);
  return g;
}

/* A flower: one stalk and a ring of petals, sharing the grass shader so it
   bends in the same wind by the same maths. The stalk is marked aPart=1 and
   takes the shared green; the petals are aPart=2 and take the instance colour,
   which is what makes a whole meadow of species out of one geometry. */
export function flowerGeometry(petals = 5) {
  const verts = [], norms = [], uvs = [], stem = [], idx = [];
  const H = 1.0, headR = 0.22;

  // stalk: a narrow strip from the ground to the head
  const halfW = 0.035;
  for (let i = 0; i <= 2; i++) {
    const t = i / 2;
    for (const side of [-1, 1]) {
      verts.push(side * halfW, t * H * 0.86, 0);
      norms.push(0, 0.2, 0.98);
      uvs.push((side + 1) * 0.5, t * 0.86);
      stem.push(1);            // stalk
    }
  }
  for (let i = 0; i < 2; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }

  // head: petals fanned round the top of the stalk, tilted up a little
  let base = verts.length / 3;
  const y = H * 0.86;
  verts.push(0, y + 0.02, 0); norms.push(0, 1, 0); uvs.push(0.5, 1); stem.push(2);
  for (let p = 0; p <= petals; p++) {
    const a = (p / petals) * Math.PI * 2;
    verts.push(Math.cos(a) * headR, y, Math.sin(a) * headR);
    norms.push(Math.cos(a) * 0.35, 0.94, Math.sin(a) * 0.35);
    uvs.push(0.5, 1);
    stem.push(2);   // petal
  }
  for (let p = 0; p < petals; p++) idx.push(base, base + 1 + p, base + 2 + p);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(stem, 1));
  g.setIndex(idx);
  return g;
}

export const _m4 = new THREE.Matrix4();
export const _q = new THREE.Quaternion();
export const _e = new THREE.Euler();
export const _v = new THREE.Vector3();
export const _s = new THREE.Vector3();
export const _c = new THREE.Color();
/* Flowers come in patches of one kind rather than as confetti: a low-frequency
   noise picks the species for a patch of ground, so a meadow reads as a meadow. */
export const FLOWER_COLORS = [0xfdfbf3, 0xf3e070, 0xe8748f, 0x9d7fd6, 0xe8963c, 0xf7bcd0, 0xcfe3f2].map((h) => new THREE.Color(h));
export const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/* Fill one grass tile. Blades live in tile-local coordinates with the mesh
   parked at the tile origin, so a tile can be moved by touching one position
   instead of every matrix. */
/* Fill one tile: blades, then flowers over the top of them. Both live in
   tile-local coordinates with the mesh parked at the tile origin, so a tile can
   be moved by touching one position instead of every matrix. */
/* -------------------------------------------------------------------------
   How much grass is actually drawn

   A blade a hundred and fifty metres away is a fraction of a pixel, and there
   are as many of them out there as there are underfoot — more, because the
   outer rings of a nine-by-nine grid hold two thirds of the tiles. Thinning
   them is the cheapest thing that can be done to this scene.

   It works because `fillTile` scatters blades in random order and packs the
   survivors to the front: taking the first N of them is a uniform sample of the
   tile, so turning `count` down thins the grass evenly rather than clearing a
   visible wedge of it. Nothing is refilled and nothing is recomputed — it is
   one number per tile per frame, and it can follow the camera as it walks.
   ------------------------------------------------------------------------- */

/* Metres a fruit bucket covers. A little wider than anybody's reach, so a pick
   looks at four buckets at most and usually finds its fruit in the first. */
export const ORCHARD_BUCKET = 12;

export const GRASS_NEAR = 1.5;        // tiles: full density out to here
export const GRASS_FAR = 4.5;         // tiles: thinnest beyond here
export const GRASS_THIN = 0.28;       // what is left at the far edge

export function tileDensity(tile) {
  if (!Number.isFinite(tile.ix)) return 1;
  const dx = tile.ix + 0.5 - camera.position.x / TILE;
  const dz = tile.iz + 0.5 - camera.position.z / TILE;
  const d = Math.hypot(dx, dz);
  if (d <= GRASS_NEAR) return 1;
  if (d >= GRASS_FAR) return GRASS_THIN;
  const t = (d - GRASS_NEAR) / (GRASS_FAR - GRASS_NEAR);
  return 1 + (GRASS_THIN - 1) * t;
}

/** How many of a tile's blades to submit this frame. */
export function setTileDraw(mesh, live, tile) {
  mesh.count = Math.max(0, Math.min(live, Math.round(live * tileDensity(tile))));
}

/** Re-aims every tile's draw count at where the camera is now. */
export function updateGrassDetail() {
  for (const t of grassTiles) {
    // A tile waiting to be refilled is holding the last tile's blades and is
    // hidden on purpose; leave it alone until drainDirtyTiles gets to it.
    if (t.dirty) continue;
    for (const mesh of [t.mesh, t.flowers]) {
      const live = mesh.userData.live || 0;
      setTileDraw(mesh, live, t);
      mesh.visible = mesh.count > 0;
    }
  }
}

export function fillTile(tile, ix, iz) {
  const ox = ix * TILE, oz = iz * TILE;
  const rng = mulberry32((hash2(ix, iz, P.seed) * 4294967296) | 0);
  const mesh = tile.mesh;
  /* Written packed rather than in place. A blade that cannot grow — sea, cliff,
     snowline, a trampled camp — used to be parked at zero scale and drawn
     anyway: a degenerate triangle costs no pixels but is still transformed,
     shaded and clipped, and along a coast that was most of a tile. Packing the
     survivors to the front lets `count` say how many there really are, and the
     rest are never submitted at all. */
  let live = 0;
  for (let i = 0; i < BLADES; i++) {
    const lx = rng() * TILE, lz = rng() * TILE;
    /* Drawn for every blade, before anything can reject one, and that ordering
       is the whole trick. The wear under a tile changes while you are standing
       on it, and a random number drawn only by survivors would mean the rest of
       the tile's blades came off a different part of the stream every time a
       path crossed a threshold — the grass fifty metres away shuffling because
       somebody walked past. Draw it always and the layout is fixed. */
    const thin = rng();
    const wx = ox + lx, wz = oz + lz;
    const h = sampleHeight(wx, wz);
    const flat = flatnessAt(wx, wz);

    // Grass does not grow in the sea, on a cliff, above the snow line, or on
    // ground a camp has trampled flat.
    if (h < SEA + 0.8 || h > SNOW || flat < 0.80 || inCamp(wx, wz) || isWet(wx, wz)) continue;

    /* And it gives up where it is walked. Thinning between the two thresholds
       rather than switching off at one: the edge of a path is where it stops
       looking like a line somebody drew. */
    const worn = wearAt(wx, wz);
    if (worn >= PATH.bare) continue;
    if (worn > PATH.showing
      && thin < (worn - PATH.showing) / (PATH.bare - PATH.showing)) continue;

    const i2 = live;
    live++;

    /* Trodden, not just sparse. A blade on the edge of a path is one that has
       been stepped on and got up again, so it is shorter than its neighbours —
       and the ground shows through more of it, which is what carries the line
       when the thinning alone is too subtle to read. */
    const trodden = worn > 0 ? Math.min(1, worn / PATH.bare) : 0;
    const height = (0.42 + rng() * 0.66) * (1 - 0.55 * trodden);
    const width = 0.075 + rng() * 0.045;
    _e.set((rng() - 0.5) * 0.30, rng() * Math.PI * 2, (rng() - 0.5) * 0.30);
    _q.setFromEuler(_e);
    /* A centimetre into the soil rather than exactly on it. A blade's base
       quad meeting the terrain at precisely the same height is two surfaces
       fighting for the same depth, and the loser changes with the camera. */
    _v.set(lx, h - 0.015, lz);
    _s.set(width, height, height);
    mesh.setMatrixAt(i2, _m4.compose(_v, _q, _s));

    groundColorAt(wx, wz, h, flat, _c);
    tintBank(wx, wz, _c);
    // Blades read brighter and a little more saturated than the soil.
    _c.lerp(C_GRASS_B, 0.35).multiplyScalar(0.85 + rng() * 0.45);
    // And browner the more they have been walked on.
    if (trodden > 0) _c.lerp(PATH_EARTH, trodden * 0.55);
    mesh.setColorAt(i2, _c);
  }
  mesh.userData.live = live;
  /* Blades were scattered in random order, so the first N of them are a uniform
     sample of the tile — which is what lets the draw count be turned down with
     distance later without the thinning showing as a pattern. */
  setTileDraw(mesh, live, tile);
  finishTileMesh(mesh);

  fillFlowers(tile.flowers, ox, oz, rng, P.counts.flowers | 0, tile);
}

export function fillFlowers(mesh, ox, oz, rng, wanted, tile) {
  /* Packed to the front like the blades, and for the same reason: most of the
     draws in a tile of flowers are ground that has none. The mesh is padded to
     at least one instance so it can hold an instance colour; `wanted` is how
     many were actually asked for, and zero means zero. */
  let live = 0;
  for (let i = 0; i < wanted; i++) {
    const lx = rng() * TILE, lz = rng() * TILE;
    const wx = ox + lx, wz = oz + lz;
    const h = sampleHeight(wx, wz);

    /* Two noises decide a flower. One says whether anything blooms on this
       patch of ground at all, so there are bare stretches between the drifts;
       the other picks which kind, so a drift is mostly one species instead of
       confetti. */
    const bloom = fbm(wx * 0.010, wz * 0.010, 2, P.seed + 707);
    if (bloom < 0.46 || rng() > (bloom - 0.42) * 3.2
        || h < SEA + 1.0 || h > SNOW - 12
        || flatnessAt(wx, wz) < 0.86 || inCamp(wx, wz) || isWet(wx, wz)
        // Nothing blooms in a footpath. Flowers go at the first sign of one,
        // where the grass hangs on until it is properly worn.
        || wearAt(wx, wz) > PATH.showing) continue;
    const i2 = live;
    live++;

    const kind = fbm(wx * 0.004 + 51, wz * 0.004 - 22, 2, P.seed + 909);
    const height = 0.26 + rng() * 0.30;
    _e.set((rng() - 0.5) * 0.24, rng() * Math.PI * 2, (rng() - 0.5) * 0.24);
    _q.setFromEuler(_e);
    _v.set(lx, h - 0.015, lz);
    _s.set(height * (0.8 + rng() * 0.5), height, height * (0.8 + rng() * 0.5));
    mesh.setMatrixAt(i2, _m4.compose(_v, _q, _s));

    const pick = FLOWER_COLORS[Math.min(FLOWER_COLORS.length - 1,
      (clamp(kind, 0, 0.999) * FLOWER_COLORS.length) | 0)];
    mesh.setColorAt(i2, _c.copy(pick).multiplyScalar(0.82 + rng() * 0.36));
  }
  mesh.userData.live = live;
  setTileDraw(mesh, live, tile);
  finishTileMesh(mesh);
}

export function finishTileMesh(mesh) {
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  /* computeBoundingSphere only looks at `count` instances, and count is turned
     down with distance — so the sphere is computed over everything that lives
     in the tile and then left alone, or a tile would shrink its own bounds as
     you walked away from it and cull itself out of the frame. */
  const drawn = mesh.count;
  mesh.count = mesh.userData.live ?? drawn;
  mesh.computeBoundingSphere();
  mesh.count = drawn;
  mesh.visible = drawn > 0;
}

export function buildGrass(grid, blades) {
  GRID = grid; BLADES = blades;
  const flowers = P.counts.flowers | 0;
  if (blades <= 0 && flowers <= 0) return;   // both sliders can legitimately be zero
  /* Two segments rather than three. A blade is eight centimetres wide and bends
     by eighteen centimetres over its whole length; the middle joint was buying
     a curve nobody can see and costing a third of every blade in the world. */
  bladeGeo = bladeGeometry(2);
  flowerGeo = flowerGeometry(5);
  for (let s = 0; s < grid * grid; s++) {
    const tile = { ix: NaN, iz: NaN };
    for (const [key, geo, count] of [['mesh', bladeGeo, blades], ['flowers', flowerGeo, flowers]]) {
      const mesh = new THREE.InstancedMesh(geo, grassMaterial, Math.max(count, 1));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = true;
      mesh.visible = false;
      // setColorAt allocates instanceColor, which is what switches on
      // USE_INSTANCING_COLOR and gives the shader its per-blade albedo. Without
      // it the material compiles a program with no instance colour at all.
      mesh.setColorAt(0, _c.setRGB(0, 0, 0));
      if (count <= 0) mesh.setMatrixAt(0, HIDDEN);
      grassGroup.add(mesh);
      tile[key] = mesh;
    }
    grassTiles.push(tile);
  }
  // Tiles are filled by placeCamera() → updateTiles(true), once the camera is where
  // it is going to be. Filling here as well would scatter every blade twice.
}

/* Recycle tiles around the camera.

   Each slot keeps a fixed residue mod GRID, so crossing one tile boundary
   only invalidates the single row or column that fell off the back — not the
   whole grid, which would hitch every 24 metres. */
export function updateTiles(force) {
  const cx = Math.floor(camera.position.x / TILE);
  const cz = Math.floor(camera.position.z / TILE);
  const R = (GRID / 2) | 0;
  const baseX = cx - R, baseZ = cz - R;
  for (let s = 0; s < grassTiles.length; s++) {
    const sx = s % GRID, sz = (s / GRID) | 0;
    const ix = baseX + (((sx - baseX) % GRID) + GRID) % GRID;
    const iz = baseZ + (((sz - baseZ) % GRID) + GRID) % GRID;
    const t = grassTiles[s];
    if (!force && t.ix === ix && t.iz === iz) continue;
    t.ix = ix; t.iz = iz;
    t.mesh.position.set(ix * TILE, 0, iz * TILE);
    t.flowers.position.set(ix * TILE, 0, iz * TILE);
    if (force) {
      fillTile(t, ix, iz);
    } else if (!t.dirty) {
      // The mesh has already moved but still holds the previous tile's blades.
      // Hide it until it is refilled: grass popping in at the far edge is much
      // less distracting than grass hovering over the wrong hill.
      t.mesh.visible = false;
      t.flowers.visible = false;
      t.dirty = true;
      dirtyTiles.push(t);
    }
  }
}

/* A path that has just appeared under a tile you are standing on has to be
   scattered again, or the grass keeps growing through it until you walk far
   enough away for the tile to be recycled. Only tiles on screen are looked
   for — the rest are refilled when they come round anyway — and only a
   threshold crossing asks, so an established path stops asking. */
export function refillWornTiles() {
  const keys = takeWornTiles();
  if (!keys) return;
  for (const key of keys) {
    const [ix, iz] = tileFromKey(key);
    for (const t of grassTiles) {
      if (t.ix !== ix || t.iz !== iz || t.dirty) continue;
      t.dirty = true;
      dirtyTiles.push(t);
      break;
    }
  }
}

/* A village has spread past where its grass stopped: the tiles on screen inside
   its new edge are scattered again, and fillTile — which asks inCamp, and
   inCamp asks how far the village reaches now — leaves them trampled. */
export function refillTilesNear(x, z, r) {
  for (const t of grassTiles) {
    if (t.dirty) continue;
    if (Math.hypot((t.ix + 0.5) * TILE - x, (t.iz + 0.5) * TILE - z) > r + TILE) continue;
    t.dirty = true;
    dirtyTiles.push(t);
  }
}

export function drainDirtyTiles(budget) {
  if (!dirtyTiles.length) return;
  for (let i = 0; i < budget && dirtyTiles.length; i++) {
    const t = dirtyTiles.shift();
    t.dirty = false;
    fillTile(t, t.ix, t.iz);
  }
  // The live blade count changes as tiles cross water and cliffs, so the HUD
  // has to be recounted rather than measured once at spawn.
  if (!dirtyTiles.length) {
    stats.blades = grassTiles.reduce((n, t) => n + (t.mesh.userData.live || 0), 0);
    updateHud();
  }
}

/* Trees: two silhouettes, each split into a still trunk and a swaying canopy.
   Both parts of a tree share one instance matrix, so they cannot drift apart. */
export function buildTrees(count) {
  const rng = mulberry32(P.seed ^ 0x9e3779b9);
  const pine = [], round = [];
  treeSpots.length = 0;
  let tries = 0;
  const limit = count * 60;
  while (pine.length + round.length < count && tries < limit) {
    tries++;
    const x = (rng() - 0.5) * WORLD * 0.94;
    const z = (rng() - 0.5) * WORLD * 0.94;
    const h = sampleHeight(x, z);
    if (h < SEA + 2 || h > SNOW + 12) continue;
    if (flatnessAt(x, z) < 0.88) continue;
    // Clumping: a low-frequency forest mask, so trees arrive in woods rather
    // than sprinkled evenly like a lawn ornament.
    const forest = fbm(x * 0.0035, z * 0.0035, 3, P.seed + 55);
    if (rng() > (forest - 0.34) * 2.4) continue;
    if (Math.hypot(x, z) < 22) continue;      // keep the spawn clearing open
    if (inCamp(x, z, 4)) continue;            // and the camps' clearings

    const scale = 0.72 + rng() * 0.75;
    _e.set(0, rng() * Math.PI * 2, 0);
    _q.setFromEuler(_e);
    _v.set(x, h - 0.4, z);
    _s.set(scale * (0.9 + rng() * 0.25), scale, scale * (0.9 + rng() * 0.25));
    const m = new THREE.Matrix4().compose(_v, _q, _s);
    // Pines take the high ground, broadleaves the valleys.
    (h > 46 + rng() * 26 ? pine : round).push(m);
    treeSpots.push({ x, z });
  }

  const trunkGeoA = new THREE.CylinderGeometry(0.20, 0.42, 4.4, 6);
  trunkGeoA.translate(0, 2.2, 0);
  const pineGeo = new THREE.ConeGeometry(2.35, 9.0, 8);
  pineGeo.translate(0, 7.0, 0);

  const trunkGeoB = new THREE.CylinderGeometry(0.26, 0.52, 4.6, 6);
  trunkGeoB.translate(0, 2.3, 0);
  const roundGeo = new THREE.IcosahedronGeometry(2.9, 1);
  roundGeo.scale(1, 0.84, 1);
  roundGeo.translate(0, 6.5, 0);

  addTreeSet(pine, trunkGeoA, pineGeo, pineCanopyMaterial, 0x3f6b3a, 0x2c5233, 0);
  // Conifers bear cones, not fruit; only the broadleaves carry it.
  addTreeSet(round, trunkGeoB, roundGeo, roundCanopyMaterial, 0x5c8c3c, 0x7d9c3f, P.counts.fruit | 0);
  stats.trees = pine.length + round.length;
}

export function addTreeSet(matrices, trunkGeo, canopyGeo, canopyMat, colorA, colorB, fruitPerTree) {
  if (!matrices.length) { trunkGeo.dispose(); canopyGeo.dispose(); return; }
  const rng = mulberry32(P.seed + matrices.length);
  const a = new THREE.Color(colorA), b = new THREE.Color(colorB);

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMaterial, matrices.length);
  const canopy = new THREE.InstancedMesh(canopyGeo, canopyMat, matrices.length);
  trunks.castShadow = true; trunks.receiveShadow = true;
  canopy.castShadow = true; canopy.receiveShadow = true;

  for (let i = 0; i < matrices.length; i++) {
    trunks.setMatrixAt(i, matrices[i]);
    canopy.setMatrixAt(i, matrices[i]);
    trunks.setColorAt(i, _c.setHex(0x6b4f36).multiplyScalar(0.8 + rng() * 0.4));
    canopy.setColorAt(i, _c.copy(a).lerp(b, rng()).multiplyScalar(0.82 + rng() * 0.36));
  }
  trunks.computeBoundingSphere();
  canopy.computeBoundingSphere();
  trunks.name = 'trunks';
  canopy.name = 'canopy';
  floraGroup.add(trunks, canopy);

  if (!fruitPerTree) return;
  const fruitGeo = new THREE.IcosahedronGeometry(0.135, 0);
  const fruit = new THREE.InstancedMesh(fruitGeo, fruitMaterial, matrices.length * fruitPerTree);
  fruit.castShadow = false;              // too small to read as a shadow
  fruit.receiveShadow = true;
  const _off = new THREE.Matrix4();
  const _fm = new THREE.Matrix4();
  for (let i = 0; i < matrices.length; i++) {
    // One species per tree: all of a tree's fruit is the same colour, which is
    // what stops an orchard looking like a bowl of sweets.
    const ripe = new THREE.Color(FRUIT_COLORS[(rng() * FRUIT_COLORS.length) | 0]);
    for (let k = 0; k < fruitPerTree; k++) {
      // Out near the surface of the canopy and on its lower half, because that
      // is where fruit is both visible and plausible.
      const a = rng() * Math.PI * 2;
      const up = rng() * 1.3 - 0.75;
      const r = 2.15 + rng() * 0.5;
      _off.makeTranslation(Math.cos(a) * r, 6.4 + up, Math.sin(a) * r);
      _fm.multiplyMatrices(matrices[i], _off);
      fruit.setMatrixAt(i * fruitPerTree + k, _fm);
      fruit.setColorAt(i * fruitPerTree + k, ripe.clone().multiplyScalar(0.82 + rng() * 0.36));
    }
  }
  fruit.computeBoundingSphere();
  fruit.name = 'fruit';
  floraGroup.add(fruit);

  /* Fruit is the one plant on the map that is a resource rather than scenery:
     it is picked, it runs out, and it comes back. The matrices are copied once
     at build time so that putting a fruit back is restoring what was there
     rather than recomputing where it should have been — which would have to
     agree with the code above forever, and eventually would not. */
  /* Bucketed by where they hang, so picking is a look at the ground you are
     standing on rather than a walk through every fruit on the island.

     `pickFruit` scanned all of them — sixteen thousand on a wooded map — for
     every completed foraging trip, and when there was nothing within arm's
     reach it scanned all of them to find that out, which is the common case.
     It was 5% of a fast-forward before this session and 88% more after it, for
     no reason except that bands now finish more errands in a day.

     The positions never move, so the index is built once with the trees. */
  const cell = ORCHARD_BUCKET;
  const buckets = new Map();
  const home = fruit.instanceMatrix.array.slice();
  for (let i = 0; i < fruit.count; i++) {
    const b = i * 16;
    const key = `${Math.floor(home[b + 12] / cell)},${Math.floor(home[b + 14] / cell)}`;
    const at = buckets.get(key);
    if (at) at.push(i); else buckets.set(key, [i]);
  }
  orchard = {
    mesh: fruit,
    home,
    on: new Uint8Array(fruit.count).fill(1),
    ripe: fruit.count,
    buckets,
  };
  stats.fruit = orchard.ripe;
}

export function buildRocks(count) {
  const rng = mulberry32(P.seed ^ 0x51ed270b);
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mesh = new THREE.InstancedMesh(geo, rockMaterial, count);
  let n = 0, tries = 0;
  while (n < count && tries < count * 60) {
    tries++;
    const x = (rng() - 0.5) * WORLD * 0.94;
    const z = (rng() - 0.5) * WORLD * 0.94;
    const h = sampleHeight(x, z);
    if (h < SEA - 1) continue;
    const flat = flatnessAt(x, z);
    // Boulders like the places grass cannot hold: scree, ridges, shoreline.
    if (flat > 0.94 && rng() > 0.25) continue;
    const s = 0.5 + rng() * rng() * 3.4;
    _e.set(rng() * 3, rng() * 6, rng() * 3);
    _q.setFromEuler(_e);
    _v.set(x, h - s * 0.35, z);
    _s.set(s * (0.7 + rng() * 0.6), s * (0.5 + rng() * 0.5), s * (0.7 + rng() * 0.6));
    mesh.setMatrixAt(n, _m4.compose(_v, _q, _s));
    mesh.setColorAt(n, _c.setHex(0x7a746a).multiplyScalar(0.62 + rng() * 0.6));
    /* Where they are, kept rather than only drawn. Somebody quarrying has to
       walk to an outcrop that is actually on the hillside — a spot invented for
       the errand is a person standing in a field pretending. Only the ones big
       enough to be worth the walk: a pebble is not a quarry. */
    if (s > 1.1) outcrops.push({ x, z });
    n++;
  }
  for (let i = n; i < count; i++) mesh.setMatrixAt(i, HIDDEN);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  rockGroup.add(mesh);
  stats.rocks = n;
}

/* grassTiles lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setGrassTiles(v) { grassTiles = v; }

/* dirtyTiles lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setDirtyTiles(v) { dirtyTiles = v; }
