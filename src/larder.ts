import { P, SEA, WORLD } from './params.js';
import { fbm, sampleHeight } from './noise.js';
import { forageSeason, seasonName } from './scene.js';

/* -------------------------------------------------------------------------
   The larder: where food comes from before anybody carries it home

   Lifted out of life.js whole, for the same reason the skills were — life.js
   had grown past the length of the page it was split out of, which is a rule
   this project keeps rather than a number it happens to be under. Nothing here
   changed on the way across.

   It is one subject with one edge: the ground and the water, how much either
   is worth standing on, and what happens to that when somebody takes from it.
   Nothing in here knows about people, camps or days — it is handed positions
   and asked what they are worth.
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   Ground that gives out

   Foraging read a noise field and nothing else, so a patch was worth exactly as
   much on its thousandth visit as its first — and since every forager in a band
   works out the same best spot from the same numbers, the whole band walked to
   the same place for ever. There was no mechanism by which it could have done
   anything else: the ground could not run down.

   It can now. Picking takes from a coarse grid of what is left, and it grows
   back over the following days, which is the same shape as the fruit and the
   herds: something taken, something returning. What it buys is the behaviour
   the band should have had all along — they work a patch, it thins, the one
   over the hill is now worth the walk, and they come back to the first one next
   week. Nobody decided that; it falls out of the ground being finite.

   Eight metres a cell, which is about the size of the ground one person works
   in an afternoon, and one float apiece: a 3200 m island is 640 KB. It belongs
   to the ground rather than to a band, so two camps sharing a hillside strip it
   between them — which is what `GROUND.range` and the crowding rules were
   already about, and what they had no physical basis for until now.
   ------------------------------------------------------------------------- */
export const FORAGED = {
  cell: 8,
  /* What one completed trip takes out of the cell it happened in. A patch
     stands about two trips before it is worth less than the ground next to it,
     which is what sends the third forager somewhere else. */
  takes: 0.38,
  /* And how fast it comes back: proportional, like the fruit, so a stripped
     patch recovers quickest and a lightly-worked one is barely marked. Six
     sim-days to most of the way, which is inside a season and outside a week's
     foraging. */
  back: 0.22,
  floor: 0.15,          // never worth nothing: there is always something
};

let picked = null, pickedCols = 0;
/* Which cells anybody has actually taken from. Recovery walks this rather than
   the island, for the same reason the paths keep a live list: the grid is forty
   thousand cells on a small map and a hundred and sixty thousand on a big one,
   the books run eight times a simulated day, and a band works a few dozen
   patches. Walking all of it was twenty-three million iterations over three
   years to move a few hundred numbers — most of a fast-forward, spent on
   ground nobody had touched. */
let worked = new Set<number>();

export function buildForaged() {
  pickedCols = Math.max(1, Math.ceil(WORLD / FORAGED.cell));
  picked = new Float32Array(pickedCols * pickedCols);
  worked = new Set();
}

const pickedAt = (x, z) => {
  if (!picked) return 0;
  const i = Math.floor((x + WORLD / 2) / FORAGED.cell);
  const j = Math.floor((z + WORLD / 2) / FORAGED.cell);
  if (i < 0 || j < 0 || i >= pickedCols || j >= pickedCols) return 0;
  return picked[j * pickedCols + i];
};

/** Somebody worked this ground. Called once by a trip that finished here. */
export function takeForage(x, z) {
  if (!picked) return;
  const i = Math.floor((x + WORLD / 2) / FORAGED.cell);
  const j = Math.floor((z + WORLD / 2) / FORAGED.cell);
  if (i < 0 || j < 0 || i >= pickedCols || j >= pickedCols) return;
  const k = j * pickedCols + i;
  picked[k] = Math.min(1 - FORAGED.floor, picked[k] + FORAGED.takes);
  worked.add(k);
};

/* Grows back, proportionally to how much is missing — the same curve the
   orchard uses, and for the same reason: the more that was taken the faster it
   returns, so ground recovers rather than being on a timer. */
export function recoverForage(days) {
  if (!picked || !worked.size || days <= 0) return;
  const back = Math.min(1, FORAGED.back * days);
  for (const k of worked) {
    const left = picked[k] - picked[k] * back;
    /* Dropped once it is close enough to untouched to be untouched. Without
       this the set only grows, and a band that has been somewhere once pays for
       it for the rest of the run — which is the whole cost this was meant to
       avoid, arriving by a slower road. */
    if (left < 0.004) { picked[k] = 0; worked.delete(k); } else picked[k] = left;
  }
}

/** How much ground is carrying a mark. For the boot check, and for the books. */
export function workedCount() { return worked.size; }

/* -------------------------------------------------------------------------
   Fish

   The island has had water round it since the first frame and nothing has ever
   eaten out of it. A coast is the one piece of ground that is worth standing on
   for a reason nothing in the simulation could see.

   Fishing is foraging with a different larder, and it is built that way on
   purpose: the same trip, the same completion, the same haul into the same
   store, and the same ground that runs down and grows back. What is different
   is where it is worth doing — a shore rather than a hillside — and that the
   good water is the deep water, which is exactly the part a band cannot reach
   without building something.

   Which is what a raft is for.
   ------------------------------------------------------------------------- */
export const FISH = {
  /* How far a band will walk to stand in the water. Shorter than a hunt: fish
     do not run, so the walk is the whole cost. */
  reach: 190,
  /* What the water is worth against a good hillside. Less than foraging on land
     per trip and steadier, because a coast does not have a winter in the way
     the ground does — which is the point of it and why a band by the sea eats
     in February. */
  yield: 0.9,
  /* And all of it is out in deep water: from the bank there is nothing worth
     the wait. A raft is what a band fishes from, and the only thing in the
     world that opens ground rather than improving it. */
  shallow: 3,          // metres of water under the raft before a fish is worth waiting for
  deep: 18,            // and how much more makes it the best there is
  /* Winter takes something off it, but nothing like what it takes off the
     ground: 0.35 of high summer on land against this. (The raft itself is a
     stack of logs: a band on a coast cuts them, stacks them, and builds one
     once it has enough — storeWood, in wood.js.) */
  winter: 0.75,
  chance: 0.30,        // weight against the other errands, on a coast
};

/* Somewhere to stand and fish: dry ground with water in front of it. Sampled
   outward rather than searched, because a coast is a line and a line is what
   you hit by walking toward it. */
export function nearestShore(x, z, within = FISH.reach) {
  let best = null, near = within;
  for (let t = 0; t < 40; t++) {
    const a = (t / 40) * Math.PI * 2;
    for (let r = 12; r < within; r += 14) {
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (sampleHeight(px, pz) < SEA + 0.9) continue;      // in the water already
      // Water within a few metres, which is what makes it a shore.
      const wx = px + Math.cos(a) * 5, wz = pz + Math.sin(a) * 5;
      if (sampleHeight(wx, wz) > SEA) continue;
      if (r < near) { near = r; best = { x: px, z: pz }; }
      break;
    }
  }
  return best;
}

/* Somewhere along the coast to fish today, rather than the one spot the camp
   found when it was founded.

   A single landing is the same mistake foraging had: everybody stands in the
   same water, it fishes out, and nothing tells them to walk along the beach.
   Candidates are scored the way forage spots are — what the water is worth,
   less the walk, times a guess — so the depletion pushes a band along its own
   coast and back again a week later.

   `shoreNear` is the camp's own, found once, and is what makes this cheap: the
   search starts from a place that is already known to be a shore instead of
   hunting the island for one every trip. */
export function pickFishing(camp, luck) {
  const dock = camp.raft ? dockOf(camp) : null;
  if (!dock) return null;
  let best = null, top = -Infinity;
  for (let t = 0; t < 6; t++) {
    // Out from the dock, the way it points, to wherever the deep water is.
    const a = dock.a + (luck() - 0.5) * 1.6;
    const away = 35 + luck() * 95;
    const x = dock.mx + Math.sin(a) * away, z = dock.mz + Math.cos(a) * away;
    const worth = fishRichness(x, z, camp);
    if (worth <= 0) continue;
    const value = (worth - away / 700) * (0.78 + luck() * 0.44);
    if (value > top) { top = value; best = { x, z }; }
  }
  return best;
}

/* Where a band's raft is tied up: planks out from its landing along the
   bearing with the most water in front of it, and the raft riding just past
   the end of them. Worked out from the ground, once per landing. */
export const DOCK = { len: 7, moor: 1.8 };
export function dockOf(camp) {
  if (camp.dock !== undefined && (camp.dock === null ? !camp.shore : camp.dock.of === camp.shore)) return camp.dock;
  const s = camp.shore;
  if (!s) return (camp.dock = null);
  let bestA = 0, most = -Infinity;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    let water = 0;
    for (const r of [4, 8, 12]) water += SEA - sampleHeight(s.x + Math.sin(a) * r, s.z + Math.cos(a) * r);
    if (water > most) { most = water; bestA = a; }
  }
  const fx = Math.sin(bestA), fz = Math.cos(bestA);
  return (camp.dock = {
    of: s, a: bestA, x: s.x, z: s.z,
    ex: s.x + fx * DOCK.len, ez: s.z + fz * DOCK.len,
    mx: s.x + fx * (DOCK.len + DOCK.moor), mz: s.z + fz * (DOCK.len + DOCK.moor),
  });
}

/* What the water off this shore is worth. Deeper is better — that is where the
   fish are — and how much of the depth a band can reach is what its raft
   decides. Less what has lately been taken, on the same field the foraging
   uses, because a stretch of coast fished out this week is fished out for
   everybody. */
export function fishRichness(x, z, camp) {
  // No raft, no fish: they are out in deep water, and nobody swims for them.
  if (!camp?.raft) return 0;
  return fishAt(x, z);
}

/** What the water here holds, whoever can reach it: the depth, the season,
    less what has lately been taken. */
export function fishAt(x, z) {
  const h = sampleHeight(x, z);
  const deep = Math.max(0, Math.min(1, (SEA - h - FISH.shallow) / FISH.deep));
  if (deep <= 0) return 0;
  const season = seasonName === 'winter' ? FISH.winter : 1;
  return FISH.yield * deep * season * (1 - pickedAt(x, z));
}

/* Where the fish are off a band's coast, for the map: the water a raft goes
   out to (the same fan off the dock that pickFishing draws from), its best few
   stretches, at least FISH_GROUNDS.between from each other. The depth is the
   ground and is found once a dock. What the water holds today changes with the
   season and the fishing, and is read fresh every time. */
export const FISH_GROUNDS = { spread: 0.8, near: 35, far: 130, between: 30, best: 3 };
export function fishGrounds(camp) {
  const dock = dockOf(camp);
  if (!dock) return [];
  if (camp.fishWater?.of !== dock) {
    const water = [];
    for (let k = -4; k <= 4; k++) {
      const a = dock.a + (k / 4) * FISH_GROUNDS.spread;
      for (let r = FISH_GROUNDS.near; r <= FISH_GROUNDS.far; r += 19) {
        const x = dock.mx + Math.sin(a) * r, z = dock.mz + Math.cos(a) * r;
        if (SEA - sampleHeight(x, z) > FISH.shallow) water.push({ x, z });
      }
    }
    camp.fishWater = { of: dock, water };
  }
  const rated = camp.fishWater.water.map((w) => ({ ...w, worth: fishAt(w.x, w.z), depth: SEA - sampleHeight(w.x, w.z),
    taken: pickedAt(w.x, w.z) })).filter((w) => w.worth > 0.02).sort((a, b) => b.worth - a.worth);
  const out = [];
  for (const w of rated) {
    if (out.length >= FISH_GROUNDS.best) break;
    if (out.every((o) => Math.hypot(o.x - w.x, o.z - w.z) >= FISH_GROUNDS.between)) out.push(w);
  }
  return out;
}

/** For the boot check: how far the foraging has spread over the island. */
export function foragedStats() {
  if (!picked) return { cells: 0, worst: 0 };
  let cells = 0, worst = 0;
  for (const k of worked) {
    if (picked[k] > 0.01) cells++;
    if (picked[k] > worst) worst = picked[k];
  }
  return { cells, worst };
}

/* How rich the ground is to forage. The same noise that decides where flowers
   grow decides where there is something worth picking, which means the good
   foraging is visibly the flowery ground — less whatever has lately been taken
   off it. */
export function forageRichness(x, z) {
  // Ground richness times the time of year. Winter yields about a third of high
  // summer, which is the whole reason a store is worth keeping.
  return (0.55 + fbm(x * 0.010, z * 0.010, 2, P.seed + 707)) * forageSeason
    * (1 - pickedAt(x, z));
}
