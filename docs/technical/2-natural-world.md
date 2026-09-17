# The natural world

[Technical documentation](README.md)

This section covers everything on the island that nobody built: the ground, sea, creeks and lakes, the sky and calendar, the vegetation and stone, the wear people leave on the ground, and the animals, including the tiger. People, settlements and the road network are covered in other sections. This one covers only where they meet the natural world: foraging ground, safe ground round a fire, and wild horses.

Every number below was read from the current `src/*.ts`. *Measured* means the figure comes from a commit message or a source comment and describes the tree it was measured on. *Derived* means it is worked out here from the constants.

| Module | Owns |
|---|---|
| `src/params.ts` | `P`, `QUALITY`, `WORLD`, `MAP_SCALE`, `SEA`, `SNOW`, `TILE`, `FOG_DENSITY` |
| `src/noise.ts` | hashing, `valueNoise`, `fbm`, `ridged`, `mulberry32`, `rawHeight`, the height field, `inCreek`/`inWater` |
| `src/creeks.ts` | tracing, carving and drawing creeks, lakes, spring pools |
| `src/world.ts` | terrain mesh, sea plane, grass and flowers, trees and fruit, rocks |
| `src/scene.ts` | sky, sun, moon, stars, seasons, wind, every natural material and shader |
| `src/clock.ts` | clock rates, night skip, the seeded simulation stream, LOD grouping, `pace()` |
| `src/paths.ts` | the wear field (paths and roads as ground), ground pace |
| `src/larder.ts`, `src/orchard.ts`, `src/thickets.ts`, `src/quarries.ts` | forage ground and fish, fruit, berry thickets, ore deposits |
| `src/wildlife.ts` | species, rigs, models, herds, tiger, birds, butterflies, `PANIC` |
| `src/life.ts` | `QUARRY`, `FOOD`, `STRAYS`, `repopulate`, band hunting |
| `src/spear.ts`, `src/danger.ts` | the played person's throw, carcasses, tiger warnings |
| `src/audio.ts` | synthesised nature sound |

---

## 1. The island

### Seed and determinism

`P.seed` (default `20260906`, env `SEED`) builds the ground. The island itself is never saved: a save holds the clock, the people and a few counters, and the seed rebuilds the terrain, creeks, camp sites and herd anchors.

**Noise and streams.** Noise is hashed value noise (`hash2`), so a height depends only on position and seed. Scattered objects each draw from their own `mulberry32` stream, so changing one count moves nothing else:

| Stream | Seed |
|---|---|
| trees / rocks / deposits / thickets / creeks | `P.seed ^` `0x9e3779b9` / `0x51ed270b` / `0x0de905e7` / `0x7b1c4e51` / `0x57ea3f11` |
| a species' herds | `(P.seed ^ 0x2a3b4c5d) + key.charCodeAt(0) * 7919` |
| birds / butterflies | `P.seed ^ 0x7f4a2c19` / `P.seed ^ 0x1bd11bda` |
| one grass tile | `mulberry32(hash2(ix, iz, P.seed) * 2^32)` |
| stars | fixed `7771` |
| camp sites | `peopleSeed() ^ 0x5eed0c47` |
| simulation (`luck()`) | `seedSim(peopleSeed())` → `mulberry32(seed ^ 0x9e37)` |

**Population salt.** `peopleSeed() = P.seed ^ peopleSalt` (`src/people.ts`).
- The ground comes from `P.seed` alone. Camp sites, bands, people and the simulation stream come from the salted seed.
- **Reset population** sets a new non-zero salt and rebuilds. Salt 0 is the island's first people, and XOR with 0 changes nothing, so older worlds are unchanged.
- **Caveat:** trees, deposits and thickets skip camp clearings when placed, so a reset can shift their layout even though their own streams are unsalted.

**Replaying a history.**
- `buildWorld` calls `seedSim(peopleSeed())` before rebuilding.
- Only code that runs identically whether the world is watched or not may draw from `luck()`. Smoke, butterflies, bird song and audio use `Math.random()`, because unwatched runs skip them.
- Unwatched years advance in fixed `ffStep()` steps and replay exactly. Watched frames advance by frame time, so two machines will not agree.

**Guaranteed by tests:**
- The simulation has its own stream, and building a world rewinds it.
- Stepped functions (`pickTarget`, `updatePredator`, `updateHerdAnchors`, `updateQuadrupeds`, `repopulate`, `tryKill`, `nearestFruit`, …) never call `Math.random()`, and watched-only ones (`updateButterflies`, `birdSong`, `updateAudio`, …) never call `luck()`.
- The people come from their own seed and the ground does not.

### Map size and `MAP_SCALE`

`WORLD = clamp(P.map, 800, 6400)` m (default 1600, env `MAP`), and `MAP_SCALE = WORLD/1600`.

| Scales with the map | Does not scale |
|---|---|
| the coast (fractions of the half-width) | noise feature sizes (a bigger map has more hills, not bigger ones) |
| `MAX_STEPS` for creeks | tree, grass, rock and animal counts (a bigger map is a thinner wood) |
| deposit and thicket counts (by area) | `CAMPS_APART` 260 m |
| camp-site radius | the birds' 460 m turn-back radius |

**Guaranteed by tests** (seed 20260906 at 1600 m and 3200 m): the land share differs by under 8 points, land is over 55% of the map, over 80% of the walkable disc (`0.46·WORLD`) is dry, and under 25% of the rim is land.

*Measured* (commit 628d26b, `src/noise.ts`): before the falloff was a fraction of the map, a 3200 m map was 23% land against 56% at 1600 m. Pushing the shore out to about 0.92 of the half-width cut too-steep shoreline from 14% to 12% at 1600 m and from 24% to 9% at 3200 m.

### Terrain generation

`fbm` uses gain 0.5 and lacunarity 2.03. `ridged` uses `(1 − |2n − 1|)²` and lacunarity 2.07. Each octave is rotated 0.71 rad so the lattice grid does not show on the hillshaded map. `valueNoise` interpolates with smootherstep, so hills have no creases.

**`rawHeight(x, z)`** (`s = P.seed`, `d` = distance from origin, `calm = smoothstep(40, 280, d)`):

| Layer | Freq. (per m) | Noise | Contribution |
|---|---|---|---|
| plain | — | — | `LAND.plain` 5 m |
| roll | 0.0030 | fbm 3 | `(n − 0.5) · LAND.roll` (6 m) |
| hilly mask | 0.0016 | fbm 3 | `smoothstep(0.55, 0.75, n)` |
| hills | 0.0045 | fbm 5 | `(n − 0.45) · 90 · hilly · (0.25 + 0.75·calm)` |
| range mask | 0.0019 | fbm 3 | `smoothstep(0.54, 0.74, n)` |
| mountains | 0.0026 | ridged 4 | `n · 170 · range · calm` |
| detail | 0.020 | fbm 3 | `(n − 0.5) · 1.6` |

Then, in order:
1. **Inland floor.** `h = 2.5 + 1.5·ln(1 + exp((h − 2.5)/1.5))` (`LAND.floor`, `LAND.soft`). This soft maximum lifts every hollow above the sea without leaving a shelf. The only inland water is where a creek ends in a lake.
2. **Coast** (`COAST`). The distance the falloff reads is stretched ±16% along a bearing `(seed % 628)/100` rad, and pushed in and out by a slow noise at 4.2 cycles per map width. The noise is sharpened ×2.6 and clipped, so the coast is bay or headland, then trimmed inward by 0.35 to hold the land area. It is blended in only past 0.72 of the half-width. Finally `h −= smoothstep(0.78·half, 1.12·half, coast) · 95`.
3. **Spawn offset.** `buildField` sets `hOffset = 4 − rawHeight(0, 0)`, putting spawn about 4 m above the sea.

**Height field.**
- `buildField(seg)` samples `rawHeight` once into a `(seg+1)²` grid, and the creeks then carve that grid (section 2).
- Everything reads the grid, not the noise: `sampleHeight` interpolates bilinearly, so objects sit on the rendered surface.
- `flatnessAt = 1/√(1 + dx² + dz²)`, by central differences over one field cell.
- `seg` comes from the quality preset, so a LOW island is a slightly coarser surface than a HIGH one.

**Where things may stand:**

| Thing | Height | Flatness | Other |
|---|---|---|---|
| grass blade | `SEA+0.8 … SNOW` | ≥ 0.80 | not in a camp, not in a creek bed, wear < `PATH.bare` |
| flower | `SEA+1 … SNOW−12` | ≥ 0.86 | bloom noise, wear ≤ `PATH.showing` |
| tree | `SEA+2 … SNOW+12` | ≥ 0.88 | forest mask, > 22 m from origin, > 4 m outside camp reach |
| rock | ≥ `SEA−1` | 75% of candidates flatter than 0.94 rejected | — |
| ore deposit | ≥ `SEA+2` | ≤ the ore's `flat` | 70 m apart, ≥ 36 m from camps |
| berry thicket | ≥ `SEA+1.5` | ≥ 0.80 | outside `CAMP_CLEARING`, 15 m from deposits, 60 m apart |
| herd anchor | `SEA+2 … SNOW−12` | ≥ 0.86 | within `0.42·WORLD` |
| animal step | > `SEA+0.9` | > 0.68 | within `0.46·WORLD` |
| person step (`canStand`) | > `SEA+0.9` | > `WALKABLE` 0.66 | within `0.46·WORLD`, not through a wall |

**Ground colour** (`groundColorAt`) is baked into terrain vertices and reused by the grass and the map:
- The base is two grass greens plus a dry tint.
- Sand where `smoothstep(3.2, 0.4, h)`, rock where `smoothstep(0.86, 0.62, flat)`.
- Snow where `smoothstep(SNOW−8, SNOW+26, h) × smoothstep(0.55, 0.80, flat)`.
- `lastGreen`, the share that is living ground, becomes the `aGreen` vertex attribute. Only that share takes the season tint and path wear.

`SEA = 0` is the water plane. `SNOW = 96` m is the fixed snow line for placement and vertex colour.

*Measured* (commit 1c768d9, seeds 1, 2, 3 and 7, before → after the plain and floor): water in the island's middle 3–25% → 0%, flat land 41–70% → 59–93%, land share 55–67% → 56–59%.

**Guaranteed by tests:**
- On seeds 1, 3 and 20260906, none of the middle 70% is water, and over 60% of land has a slope under 0.12.
- The floor is the soft maximum, the falloff is written against `WORLD`, and the coast shape is in fractions of the map.
- The shoreline radius varies by more than 20% of its mean ("the island is not a disc").

### Quality presets

`QUALITY` sets rendering cost and seeds the populations. `QUALITY=` or `?quality=` loads a preset's counts, and a count named explicitly wins.

| | `low` | `medium` | `high` (default) |
|---|---|---|---|
| `seg` (field cell at 1600 m) | 176 (9.1 m) | 288 (5.6 m) | 448 (3.6 m) |
| `grid` of 24 m grass tiles | 5 (120 m) | 7 (168 m) | 9 (216 m) |
| `shadowMap` | 0 (off) | 1024 | 2048 |
| `pixelRatio` cap | 1.0 | 1.5 | 2.0 |
| `round` (`ROUND_RINGS`) | boxes | 8×5 ellipsoids | 10×7 ellipsoids |
| blades per tile / flowers per tile | 700 / 60 | 1300 / 100 | 2000 / 150 |
| trees / rocks / fruit per tree / creeks | 300 / 90 / 3 / 3 | 600 / 170 / 4 / 4 | 1000 / 260 / 5 / 5 |
| bison / deer / rabbits / boars / tigers / horses | 4 / 8 / 14 / 5 / 1 / 6 | 6 / 14 / 26 / 9 / 1 / 12 | 9 / 22 / 44 / 16 / 2 / 18 |
| birds / butterflies | 16 / 24 | 28 / 44 | 44 / 70 |

**Diagnostic switches.** URL switches for finding a slow layer: `?models=off`, `?grass=0`, `?flowers=0`, `?wind=0`, `?shadows=0`, `?terrainshadow=1`, `?water=0`, `?streams=0`. B hides layers one at a time (`BISECT`) and Shift+B restores them.

**Guaranteed by tests:**
- The schema's options match the preset table, and every preset has tiger, boar and horse counts.
- A quality with no preset does not wipe the populations.
- Each level has its own roundness, and LOW is boxes.
- Boot check: each bisect step hides the layer it names, and Shift+B brings the shadow map back.

---

## 2. Water

### The sea

`buildWater` lays one Phong plane `WORLD·3` across, with 240² segments, at `SEA` (opacity 0.88, polygon offset +1 against beach flicker).

**Swell** (vertex shader):
- Three sines run along the wind, across it and diagonal, with wavenumbers 0.042, 0.068 and 0.115. Normals come from the analytic derivative.
- The amplitude is `uWaves·(0.35 + 1.5·wind)·offshore`, where `offshore = smoothstep(0.80·half, 0.95·half, |xz|)` (`SWELL_CALM`, `SWELL_FULL`). The plane lies under the whole island, and the plains are only 2.5–5 m up.

**Surface.** Ripples are a view-space normal perturbation. The sea's colour is the sky's, 62% toward `WATER_DEEP`, and its specular is the sun's colour. `WATER=false` hides the plane, and `WAVES` (0–2) scales swell and ripple.

*Measured* (commit cfd015b): at full wind the swell reached 3.3 m crest over trough. It stood up through the plains until the calm zone was added.

**Guaranteed by tests:** the amplitude includes `offshore`, and the calm zone reaches at least as far out as the land stays at its inland height.

### Creeks: trace, carve, build

`buildWorld` runs `traceStreams(P.counts.streams)` and then `carveStreams()` before `buildTerrain`, so every tree, blade, footstep and camp site reads the real valleys. `buildStreamWater` then draws the water.

**Sources** (`pickSource`). Even-numbered creeks look for a glacier first and odd ones for a spring; each falls back to the other kind. Candidates are within `0.40·WORLD` of the centre and at least 130 m from another source, and must stand at 38 m (`SOURCE_HIGH`), falling back to 32 m.
- **Spring:** below `SNOW−14` (82 m).
- **Glacier:** between 82 and 100 m, with ground above `SNOW+6` within 40 m.

**Tracing.** Steps are `STREAM_STEP` 6 m, up to `MAX_STEPS = max(400, ceil(2.2·WORLD/6))`.
- **Heading:** 16 headings are scored by the lowest ground visible up to `REACH_RINGS` 4 steps ahead. A heading whose first step climbs more than `MAX_CUT` 4 m is dropped, so water goes round hills.
- **Flat ground:** where there is less than `FLAT_DROP` 0.35 m of fall in sight, headings lean seaward (`SEAWARD` 2.5) and toward the current direction (`MEANDER` 0.6).
- **Level:** it only falls: `next = max(min(level − 0.02, ground), ground − CHANNEL_DEPTH)`. This forces a creek through small rises but stops it digging a gorge on a plain.
- **Endings:** `sea` at `SEA+0.3`; `join` on meeting a creek or non-spring lake at or below its level; otherwise `lake`.
- **When stuck:** `spillOver` (up to 5 times) searches rings 12–180 m for lower ground behind a rim at most 6 m high that is not on its own course. Failing that, `goSeaward` cuts radially outward, and may cross its own old bed when escaping a loop.
- **Stop and discard:** a creek stops past `0.47·WORLD`. A course of 14 points or fewer is discarded.

**Smoothing.** Points that double back by more than 90° are dropped, then two rounds of Chaikin corner-cutting run. The level is re-forced downhill and never above the ground.

**Flow and width.**
- **Flow:** starts at `FLOW.spring` 1.4 or `FLOW.glacier` 3.2 and adds 0.016 per metre run.
- **Width:** `2.6·√flow·wander·pool`, where wander is 0.82–1.18 and pools add up to 30%. Each bank has its own reach, 0.55–1.0.
- **Tributaries:** a tributary adds its whole mouth flow downstream of the junction and re-sizes the host's lake.
- *Derived:* a spring starts about 3 m wide and is about 11 m wide after 1 km.

**Lakes and springs** (`LAKE`).
- **Lake size:** radius `clamp(6 + 12·√flow, 6, 90)`, depth `min(6, 2.2 + 0.5·√flow)`. `lakeRadius` varies the shore by 0.78–1.22 with bearing.
- **Spring pools:** every spring gets a pool of radius 3.2 m and depth 1.1 m.
- **Trimming:** ribbons stop at a lake's shore and start at a spring pool's edge.

**Carving** (`carveStreams`).
- **Channel:** a parabolic channel is cut to `level − 1.7 + t²·2.2`, leaning toward the wider bank. The core (t < 0.5) cuts freely, the banks at most `MAX_BANK_CUT` 4 m, and cells with t < 0.8 are marked wet.
- **Lake basins:** dug to `level − depth·(1 − t²) − 0.1`. Low ground round a lake is raised into a 7 m berm up to `level + 0.6`.
- **Bank tint:** a bank value reaching `2.2·r + 2` m feeds `tintBank`, which darkens terrain, grass and map toward `0x4d5a2c`.

**Drawing.**
- **Creeks:** each creek is a ribbon 0.22 m above its level. At a bend its half-width is capped at `0.8·min(in, out)/tan(turn/2)` so it cannot fold.
- **Creek material:** `streamMaterial` is double-sided, opacity 0.80, with no depth write and polygon offset −2. Its ripples flow along `uv.y` (a 12 m period), and alpha fades over the outer 30% at each bank.
- **Lakes:** 48-segment fans of still water.

*Measured* (source comments): before `MAX_CUT` one creek ran 2670 m across a 1600 m island. Before the loop rule one spent 85% of its length within 12 m of itself.

### Where the water is, and wading

`carveStreams` hands the wet grid to `noise.ts` (`setWaterCells`):
- `inCreek(x, z)` is true in a creek bed or lake, but not the sea.
- `inWater` is `sampleHeight < SEA || inCreek`. Nothing is built where it is true.
- `clearOfCreeks(x, z, r)` tests the centre and rings at r/3, 2r/3 and r.

**Wading.** Wading is a ground pace: `groundPace` returns `TREAD.wade` 0.42 in any wet cell, against 0.82 on rough ground, and a path worn to a ford does not help. Creek beds normally stand above `SEA+0.9`, so they are walkable. A person panicking from a tiger jogs regardless of the ground.

**On the map.** The relief map uses the same field and colours, hillshaded from the north-west, with lakes painted in. On the full map, creeks are a live layer drawn as wide as the water and never under 1.2 px (`CREEK_MIN`). Each source is marked with its origin, length and ending.

**Guaranteed by tests:**
- **Ribbon:** a hairpin folds without the bend clamp and less with it, and a gentle curve keeps its full width.
- **Course:** a smoothed zigzag has no reversals and runs strictly downhill. Every creek ends in water, and water joins water only at or below its own level.
- **Flow:** width follows `√flow`, and the wander never outruns the flow. A tributary's flow passes downstream. Lake size is bounded (the page's `lakeSizeFor` is run).
- **Lakes and banks:** a lake has a non-circular shore, a basin and a bank, and the creek stops at the shore. Water thins at its banks, and `tintBank` is called by terrain, grass and map alike.
- **Wading and placement:** wading is slower than any ground. Nothing (granary, tent, house, hall, camp, graveyard, field, woodpile) is placed in water.
- **Boot probe:** every creek ends in water and rises at a glacier or a spring with its pool, no tent or granary stands in water, and stream water never writes depth.

---

## 3. Sky, time and weather

### The clock

**State.** `P.time` is the hour (starting at 7.5). `simDay` (`src/life.ts`) counts whole days. `P.dayLength` is real seconds per day (default 1440, i.e. 24 minutes; `DAY_LENGTH` 60–7200). `P.yearLength` is days per year (default 24; `YEAR_LENGTH` 4–200).

**Advancing.** Each frame does `P.time += dt·24/dayLength`, and a wrap past midnight increments `simDay`. The corner shows `year N · season`, with the day number in its tooltip.

**Rates and steps.**
- `RATES = [0.25, 0.5, 1, 2, 4, 8, 16]` scale `dt` once, before anything reads it. Wind and firelight stay on real time.
- `pace() = clamp((P.paceDay || P.dayLength)/P.dayLength, 0.5, 12)` scales every speed. With `PACE_DAY` unset it is 1, and a walk is 1.35 m/s at any day length.
- A watched step moves at most `PACE_MAX_STEP` 0.25 s. An unwatched step is `ffStep() = 0.5/pace()`.
- The books (regrowth, economy, lives, repopulation) run every `BOOK_EVERY` 1/8 day on both paths.

**Night skip** (`nightIdle`).
- Once the sun's height is below `P.nightFrom` (−0.02) and everyone awake is within their camp's reach, the frame spends `NIGHT_BUDGET·nightSkipRate/6` ms (10 ms by default) on `stepWorld(ffStep())` calls.
- Below `P.nightDeep` (−0.25) the night runs regardless of who is still out.
- *Derived:* the window runs from about 18:05 to 05:55, and deep night from about 19:04 to 04:56. An hour is 60 real seconds and a year is 9.6 real hours at 1×.

### Seasons

`seasonPhase() = (simDay % yearLength)/yearLength`, so the season steps once a day (6 days each at the default year). `blendSeason` holds each season's values, then blends into the next over `smoothstep(0.55, 0.98)` of its length.

| `SEASON` | spring | summer | autumn | winter |
|---|---|---|---|---|
| `tint` (grass, broadleaves, living ground) | 0.95, 1.10, 0.80 | 1, 1, 1 | 1.32, 0.94, 0.48 | 0.80, 0.77, 0.71 |
| `bloom` (flower heads) | 1.00 | 0.85 | 0.15 | 0 |
| `fruit` (fruit scale and regrowth) | 0 | 0.55 | 1.00 | 0.10 |
| `forage` (`forageSeason`) | 1.00 | 1.15 | 0.90 | 0.35 |
| `snowLine` (terrain shader, m) | 92 | 112 | 86 | 42 |

`seasonName` also sets plague risk, winter fish (×0.75), cold, and clothing and cloaks. The seasonal snow line exists only in the terrain shader: grass placement uses the fixed `SNOW`, so winter snow at 42 m has blades standing in it.

### Sun, sky, fog and light

- **Sun path:** `updateSunDirection(hour)`: `a = (hour − 6)/12·π`, `sunDir = (cos a, sin a·cos 24°, sin a·sin 24°)`. It rises at 06:00 in +X, sets at 18:00, and peaks at about 66° elevation (`SUN_TILT`).
- **Sky and fog:** three's Preetham `Sky`, with turbidity 2.4→10.5, rayleigh 0.9→3.4 and Mie 0.004→0.020 rising toward the horizon. Sun, sky and fog colours are sampled from stops by elevation. Fog is `FogExp2` at `FOG_DENSITY` 0.0024.
- **Lights:**
  - Daylight is `day = smoothstep(−0.10, 0.14, e)`.
  - The sun's intensity is `3.2·day`. A bluish moon light sits opposite it at `0.45·(1 − day)`, and the hemisphere light ranges 0.30–1.05.
  - 2200 stars on an 8000 m shell fade in by `smoothstep(0.06, −0.14, e)`.
  - Tone mapping is ACES at `P.exposure` 0.5.
- **Grass shading:** the grass runs its own shader. It is handed the brighter of sun and moon plus the hemisphere colours, divided by π to match three's Lambert, and applies fog after tone mapping as three does.

### Shadows

**Frustum.** One directional shadow map, a ±110 m square (near 1, far 900, bias −0.0004, PCF soft), sized by the preset. *Derived:* a texel is about 0.11 m at 2048.

**Following the camera** (`updateShadowFocus`, `src/chronicle.ts`). The frustum centres on the ground under the camera, snapped to texels in the light's own frame so edges do not crawl as the sun turns. The light sits 400 m back along `sunDir`, and the map re-renders only while the sun is up.

**Terrain casting.** The terrain receives but does not cast (`P.terrainShadow` false): 3.5 m heightfield triangles self-shadow as acne, and `normalBias` is shared by every caster — 0.06, or 1.6 when the terrain casts (`?terrainshadow=1` or `TERRAIN_SHADOW`).

**Non-casters.** Models, fruit and butterflies do not cast, and the grass neither casts nor receives.

**Guaranteed by tests:**
- The shadow focus snaps in the light frame.
- The terrain does not cast by default, `?terrainshadow=1` turns it on, and `normalBias` follows the flag.
- Every shader guards `normalize` on an instance column, so parked zero-scale instances stay finite.

### Wind

**Settings.** `P.wind` 0.35 (`WIND`), `P.windDir` 135° (the direction it blows toward; 0 = north = −Z, 90 = east = +X), `P.gust` 0.5 (`GUST`).

**Shared uniforms.** `windUniforms` drive grass, flower stalks, canopies, fruit, sea and smoke, so a gust crosses all of them at once. Their `uTime` advances by real seconds × `(0.6 + 1.1·wind)`, ignoring the clock rate.

**Grass motion.**
- A blade leans `wind·(0.55 + 0.45·wave)·gustMask`, with `wave = sin(travel·0.07 − t·(1.4 + 2.2w))`, phase taken along the wind.
- A slow band `sin(travel·0.013 − t·0.45)` becomes the gust mask when `uGust` is 1.
- Motion is weighted by height² and rotated into each blade's frame, so a field leans one way.

**Canopies** use the same terms at lower frequencies, weighted by height above the trunk.

### Sound

`src/audio.ts` synthesises everything and builds the graph on the first gesture (`SOUND`, `VOLUME` 0.55). One 4 s noise buffer, through four filters, gives wind, leaves (∝ wind²), surf (rising near sea level) and fire (4–26 m from a camp). Birds sing by day, loudest at dawn and dusk; crickets and an owl take the night.

**Guaranteed by tests:**
- **Clock:** the rate ladder is sorted, includes 1× and holds at its ends. It is applied once, to `dt`, and read by clock, calendar and walking but not the wind.
- **Night:** skip is on by default, nothing is skipped in daylight, and deep night runs regardless. The night runs in world-steps inside a budget, and the frame does not move the world again.
- **Pace:** the default day is 24 minutes, the reference day runs at pace 1, and the clamp is 0.5–12.
- **Boot check:** the night is run through and the day is not, and 4× really runs four times as fast.

---

## 4. Vegetation and ground

### Trees

**Placement.** `buildTrees` makes up to `count·60` attempts within `0.94·WORLD`. A candidate is accepted only if it:
- stands between `SEA+2` and `SNOW+12`, on flatness ≥ 0.88;
- passes the forest mask: `rng() ≤ (fbm(0.0035) − 0.34)·2.4`, which groups trees into woods;
- lies more than 22 m from the origin;
- lies more than 4 m outside every camp's reach. Camp sites are chosen first, so clearings are left, not cut.

**Form.** Scale is 0.72–1.47. Above `46 + rng·26` m a tree is a pine (a 9 m cone); below, a broadleaf (a squashed icosahedron). Trunk and canopy share one instance matrix. Broadleaves take the season tint, and only they bear fruit. Every trunk goes into `treeSpots` for climbing and woodcutting; cutting wood never removes a tree.

### Grass tiles and blades

**Tiles.** The grass is a `grid × grid` set of 24 m tiles that recycles round the camera.
- Each slot keeps a fixed residue modulo `grid`, so crossing a tile boundary dirties one row.
- A moved tile is hidden until `drainDirtyTiles(3)` refills it, three tiles a frame. *Measured:* about 0.26 ms a tile.

**`fillTile`** scatters `BLADES` candidates from the tile's own stream.
- **Stable layout:** the thinning roll is drawn before any rejection, so a nearby path changing never reshuffles the tile.
- **Rejections:** sea, cliff, above `SNOW`, inside a camp (`inCamp`, which grows with the village) and creek beds.
- **Wear:** blades are rejected at wear ≥ `PATH.bare` 0.72. Between `PATH.showing` 0.22 and bare they are kept with linearly falling probability, and survivors are shorter (down to 45%) and browner.
- **Packing:** survivors are packed to the front, and `mesh.count` is the live count. A blade is 2 segments (4 triangles), coloured from the ground it stands on.

**Distance thinning** (`tileDensity`). Density is 1 out to `GRASS_NEAR` 1.5 tiles, falling linearly to `GRASS_THIN` 0.28 at `GRASS_FAR` 4.5 tiles. Blades are in random order, so the first N are a uniform sample. Bounding spheres cover every live blade, so a thinned tile never culls itself.

**Refills.** A tile is refilled when a wear cell under it crosses a grass threshold (`refillWornTiles`, once per crossing) or a village's edge grows past it (`refillTilesNear`).

*Measured* (`test.js` comment, HIGH): packing and thinning took the scene from 2.03 M to 1.29 M triangles and the grass from 0.97 M to 0.25 M.

### Flowers

`fillFlowers` makes `P.counts.flowers` attempts per tile. A flower grows only where `bloom = fbm(0.010, s+707) ≥ 0.46` passes a density roll and wear is at most `showing`, so flowers give up before grass does. A slower noise picks one of 7 colours per drift. Petal heads shrink with the season's `bloom`. The bloom noise is the same noise `forageRichness` reads, so flowery ground is good foraging.

### Forage ground

`src/larder.ts` keeps a `FORAGED` grid of 8 m cells, owned by the ground, not by any band.

**Richness.** `forageRichness = (0.55 + fbm(0.010, s+707))·forageSeason·(1 − picked)`. *Derived:* winter forage is about 0.30 of high summer.

**Taking.** A finished foraging trip calls `takeForage` where it ended, adding `takes` 0.38. Picked is capped at `1 − floor`, 0.85, so ground always keeps something.

**Recovery.** `recoverForage(days)` shrinks each worked cell by `min(1, back·days)`, with `back` 0.22 per day, so recovery is proportional to what is missing. Only the `worked` set is walked, and a cell leaves it below 0.004. Depletion is not saved.

**Fish.** Fish deplete on the same grid (`fishAt`): `FISH.yield` 0.9, times how deep the water is past 3 m (best at 21 m), times 0.75 in winter. Raft fishing is covered in the economy section.

*Note from the source:* `recoverForage` is called only in `stepWorld` (night skip, run-ahead, background tab). The watched frame's book-keeping (`src/main.ts`) omits it, so ground does not recover while the world is being watched. The test for regrowth only checks that the call exists in `main.js`.

### Berry thickets

**Placement.** `THICKET.count` 26 per 1600 m island (scaled by area), taken richest first from `want·40` dry, flat candidates clear of camps and deposits, and kept 60 m apart.

**Shape.** A thicket is 7 bushes within 3.2 m, each carrying 6 berries (55% red, otherwise purple).

**Berries.** Every 2 real seconds `updateThickets` shows `round(ripe·6)` berries per bush, with `ripe = clamp((mean richness at centre and four bush-points − 0.25)/0.9)`. Picking, winter and recovery therefore show directly on the bushes.

**Reach.** E forages within `THICKET_REACH` 4.86 m (spread + bush + 1 m).

### Orchards and fruit

**Planting.** Each broadleaf carries `P.counts.fruit` fruit, all one of 5 colours. Home matrices are kept in `orchard.home`, bucketed into 12 m cells (`ORCHARD_BUCKET`).

**`ORCHARD`** constants are `reach` 7 m, `takes` 6, `worth` 0.02 food, and `regrow` 0.50 of missing fruit per day × the season's `fruit` value.

**Picking and regrowth.**
- `pickFruit` hides fruit within reach and returns their worth.
- `regrowFruit` does nothing while the seasonal value is ≤ 0.02, which in practice means spring. In winter (0.10) fruit comes back at a tenth of the summer rate.
- Regrowth carries a fractional debt and restores each fruit to its original matrix, rotating a cursor across the trees.
- The orchard is not saved; it is rebuilt full on reload.

*Measured* (`test.js` comment): over four days of boar feeding, the orchard fell from 3850 to 3246 fruit, and the decline levelled off.

**Guaranteed by tests:**
- **Fruit:** a best fruit trip is under half a basic forage trip. Picking hides the instance, and regrowth restores the built transform. Nothing ripens out of season. A stripped orchard refills to exactly the crop, and takes days to do it.
- **Forage:** richness is less what was picked, taken where the trip ended, with a floor of 0.15, on 6–16 m cells owned by the ground.
- **Thickets:** they come off the world seed, richest first, kept apart. The foraging area is the thicket plus about a metre.
- **Grass cost:** blades are two segments and packed. Density is 1 near, 0.28 far, and never rises with distance. Empty tiles are not drawn, and bounds cover every live blade.
- **Boot check:** fruit is on the trees at start and the count moves as it is picked and grows back, within 0 and the crop. Thickets have berries. Foraging spreads out, and no patch is picked to nothing.

### Rocks and ore deposits

**Rocks** (`buildRocks`) favour rough ground: 75% of candidates flatter than 0.94 are rejected. Sizes run `0.5 + rng²·3.4` m. Rocks over 1.1 m still go into `outcrops`, which nothing reads since quarrying moved to deposits.

**Ore deposits** (`ORES`, `src/quarries.ts`); site counts are per 1600 m island, scaled by area:

| Kind | Sites | Amount | Flatness ≤ | Reach (m) | Per trip | Want |
|---|---|---|---|---|---|---|
| stone | 14 | 150–400 | 0.95 | 220 | 1 | 1.0 |
| iron | 6 | 30–70 | 0.90 | 360 | 2 | 0.8 |
| bronze | 4 | 20–45 | 0.88 | 400 | 2 | 0.7 |
| silver | 3 | 8–20 | 0.86 | 450 | 1 | 0.6 |
| gold | 2 | 3–10 | 0.84 | 500 | 1 | 0.6 |

**Heaps.** A deposit is a heap of `PER_DEPOSIT` 4 rocks, `DEPOSIT_APART` 70 m from the next and at least 36 m from any camp. It stands `depositRadius = 0.8 + 1.5·∛(left/100)` m (*derived:* 3.2 m for 400 stone, 1.3 m for 3 gold) and disappears when empty.

**Choosing a deposit.** A deposit's `worth` is `want/(1 + dist/120)` within reach. Stone is worth nothing to a band whose pile is at `SKILL.stoneMax` 40. `pickDeposit` draws among deposits by worth using `luck()`, so it is only called from the step. `mainDeposit` returns the best one, where a city's quarry road goes.

**Digging.** `mineDeposit` takes whole pieces and redresses the heap. Anywhere within `DIG_REACH` 7 m of the heap's edge counts as at it. Metals go to `camp.ores`, and the first of each kind is a chronicle line. What is left is saved by list index.

**Guaranteed by tests:**
- There are five kinds, and the rarer the metal, the fewer the sites and the smaller each.
- Deposits are never in a camp or overlapping, and are laid out after camp sites.
- A deposit's size follows what is left, and it shrinks when dug.
- Choice is weighted, and made only in the step. What is left survives a reload.
- Boot check: digging makes a quarry smaller.

---

## 5. Paths and roads as ground

This covers the ground side only. How roads are laid, joined and walked is in the settlement section.

**The field** (`src/paths.ts`).
- **Cells:** one byte per `PATH.cell` 1.5 m cell, capped at 4096 cells across. It is uploaded as a linearly filtered texture at most twice a second, and never while unwatched.
- **Treading:** `stepPerson`, the only function that moves a person, calls `tread(x0, z0, x1, z1, weight)`. That stamps `distance·PATH.perMetre (0.055)·weight` along the segment, and explorers tread at `PATH.blaze` 2.5. Animals do not wear the ground.
- **Caps:** wear stops at `TRAIL_MAX` 230/255. `paveRoad`/`paveDisc` write `ROAD` 255, skipping any cell below `SEA + 0.3`. `liftRoads` turns road cells back into 230-wear trails.
- **Fading:** `fadePaths` multiplies non-road cells by `exp(−days/30)` every `fadeEvery` 4 days and drops cells below 0.015.
- **Saving:** wear is not saved.

| Wear | Effect | Reader |
|---|---|---|
| > 0 | blades shorter and browner | `fillTile` |
| 0.22 `showing` | grass thins; no flowers | `fillTile`, `fillFlowers` |
| 0.45 `onMap` | ground begins to brown; drawn on the map | terrain shader, `map.ts` |
| 0.72 `bare` | no grass; full walking pace | `fillTile`, `groundPace` |
| 0.88 | full path colour | terrain shader |
| 0.90 `TRAIL_MAX` | the most a trail can be | `bump` |
| ≥ 0.94 | road colour, `TREAD.road` pace | terrain shader, `groundPace` |
| 1.00 `ROAD` | laid road, never fades | `paveRoad`, `fadePaths` |

**Shader.**
- A trail browns living ground: `smoothstep(0.45, 0.88, worn) · uPathDeep 0.50 · vGreen`, toward `PATH_EARTH` `0x5b4a35`. Sand and rock never show paths.
- A road paints `smoothstep(0.94, 0.99) · 0.9` toward `0xbfae8c`.
- The season tint applies only to the untrodden share. A trail tops out at 0.90, so it can never take the road colour.

**Walking** (`TREAD`).
- **Pace:** `groundPace = 0.82 + 0.18·min(1, wear/0.72)`; `road` 1.12; `wade` 0.42.
- **Heading:** every 0.4 s a walker scores straight ahead and ±0.35/±0.7 rad by the ground 2 and 4 m ahead × cos(angle). A new heading needs a 4% advantage. Walkers go straight inside 8 m, and led, fleeing, chasing, hiding and rafting walkers never swerve.

**Map.** Trails from `onMap` up are drawn brown, with opacity 0.25–0.65. Roads (≥ 0.99) are drawn pale, and the drawing is cached on `pathVersion`.

*Derived:* one crossing of a cell adds about 0.08 (commit f1aa209). About 9 crossings make bare earth (4 for an explorer). An abandoned bare path thins grass again after about 36 days, and a saturated trail vanishes after about 120. *Measured* (shader comment): starting the brown at 0.10 painted a route walked 20 times 3.8 m wide; starting at 0.45 makes it 2.6 m.

**Guaranteed by tests** (the page's `paths.js` run on a stub):
- **Wear:** one walk leaves a mark below `showing`. A 40 m line goes bare in 4–20 crossings, ground 18 m aside stays untouched, and wear caps at fully worn.
- **Fading:** 1.5×`fadeDays` returns a bare path below `showing`, and 40×`fadeDays` leaves nothing. A threshold crossing asks for a re-scatter once.
- **Roads:** a trail stops short of a road. A road never fades or crosses water, and has its own colour on the ground and on the map.
- **Pace:** off the path is slower and a road quicker, and walkers take the soonest heading.
- **Boot check:** walking wears the ground, repeated walking takes it to earth, and only walked ground is worn.

---

## 6. Wildlife

### The species

`SPECIES` (`src/wildlife.ts`) is one spec per quadruped. A single rig and state machine drives them all; a species differs only in its numbers.

| | Bison | Deer | Rabbit | Boar | Tiger | Horse |
|---|---|---|---|---|---|---|
| count high / med / low | 9 / 6 / 4 | 22 / 14 / 8 | 44 / 26 / 14 | 16 / 9 / 5 | 2 / 1 / 1 | 18 / 12 / 6 |
| `herdOf` | 5 | 6 | 3 | 4 | 1 | 6 |
| `walkSpeed` / `fleeSpeed` (m/s) | 0.85 / 4.6 | 1.6 / 6.8 | 1.5 / 5.6 | 1.1 / 5.2 | 1.5 / 7.4 | 1.4 / 7.2 |
| `fleeRadius` (m, then ×scale + 6) | 13 | 16 | 22 | 15 | 0 | 20 |
| `turn` (rad/s) | 1.1 | 2.4 | 5.0 | 2.6 | 2.8 | 2.2 |
| `graze` (s) / `roam` (m) | 22–40 / 11 | 12–30 / 14 | 3–8 / 8 | 8–18 / 16 | 10–26 / 60 | 14–32 / 20 |
| gait, `stride` (m) | walk 1.9 | walk 0.95 | hop 0.52 | walk 0.72 | walk 1.15 | walk 1.7 |
| young chance | 14% | 17% | 18% | 20% | 10% | 14% |
| horn slot / extra | horns, hump | — | ears | tusks, `eatsFruit` | `predator`, `hunt` | ears, `mount` |
| `QUARRY` meat / chance / regrow | 45 / 0.07 / 0.06 | 20 / 0.10 / 0.12 | 2.5 / 0.06 / 0.35 | 14 / 0.11 / 0.16 | — | — |
| model with `MODELS=all` | Horse.glb 2.9 m | Horse.glb 1.9 m | — | — | — | Horse.glb 2.3 m |

### The rig and the optional models

**Procedural rig.**
- Every species is a handful of `InstancedMesh`es shared by the whole species: body, hump, neck, head, horns ×2, tail and legs ×4. A 22-deer herd is 7 draw calls, not 176.
- Nothing is skinned. Geometry is pre-shifted to its pivot, so a leg is a rotation about the hip and the head hangs off the neck.
- `roundBox`/`roundLimb` are ellipsoids at MEDIUM and HIGH and boxes at LOW.

**Posing** (only while drawing).
- Pitch and roll come from four ground probes.
- Walkers move diagonal leg pairs (`WALK_GAIT`) and hoppers front and back pairs (`HOP_GAIT`).
- Leg phase advances with ground covered, so feet never skate. A hopper's whole body lifts.
- The neck eases between `rest` and `graze`, alternating head down 3–10 s and up 1.5–4.5 s.

**GLTF models** (`P.models`: `off` | `birds` (default) | `all`).
- **Sources:** Parrot, Stork and Flamingo for birds, and Horse.glb for deer, bison and horses, all from the three.js r169 examples on jsDelivr. Rabbits, boars and tigers are always procedural.
- **Loading:** `loadModels` fetches them after the world stands, with `Promise.allSettled`. A failure logs a line and the procedural shapes stay.
- **Instancing:** each model is one morph-target mesh with per-instance morph state (`setMorphAt`), so a hundred birds are one draw call with a hundred wingbeats.
- **Fitting:** `fit` sets the longest axis in metres, and `footOffset` corrects models whose origin is above the feet (the horse's is 59 units up).
- **Limits:** models cast no shadows. A species over `MODEL_MAX_INSTANCES` 90 stays wholly procedural. A model cannot lower its head to graze.

*Note from the source:* model arrival calls `rebuildFauna`, which rebuilds every herd from the seed. After a save was restored, this looks like it resets the restored living counts and tamed horses. Not verified at runtime.

### Herds, grazing, walking and fleeing

**Herds.**
- `buildQuadrupeds` places `ceil(count/herdOf)` anchors and deals animals round-robin within 26 m of them.
- Every 45–120 s each anchor drifts 15–60 m to flat, dry ground (`updateHerdAnchors`, `luck()`).
- `pickTarget` chooses walk targets within `roam` of the anchor.
- *Note from the source:* bison and boar share a herd stream (both keys start with `b`), so their first anchors coincide.

**Three states**, shared by every species. A tiger maps lying up to `graze`, prowling to `walk` and its charge to `flee`.
- **graze:** head down and up. When the timer ends, pick a target (walk for 30 s) or keep grazing.
- **walk:** go to the target at `walkSpeed`. Within 1.5 m of it, graze.
- **flee:** when the nearest threat is within `fleeRadius·scale + 6`, run toward a point 70 m directly away for 2.5–5.5 s at `fleeSpeed`.
- **Blocked steps:** speed eases toward the wanted speed. A step into the sea, onto flatness < 0.68, or past `0.46·WORLD` stops the animal and picks a new target.

**Threats** (`collectThreats`, each step):
- hunters (job `hunt`) who are awake;
- the camera, or the person being led unless they are down low (Z), so a crawl gets within a throw unnoticed;
- every living tiger.

Foragers and ordinary walkers frighten nothing.

**Stamina.**
- `energyRate(speed/fleeSpeed, ANIMAL_STAMINA 14, RECOVERY_SECONDS 70)` costs `(effort − 0.42)²/14` per second above `SUSTAIN` 0.42, and recovers `(0.42 − effort)/70` below it.
- A fleeing animal runs at `FLEE_SPENT 0.42 + 0.58·energy` of `fleeSpeed`. Below 0.06 energy it is blown and grazes; a blown tiger also drops its prey and rests 16 s.
- *Derived:* a flat-out sprint blows in about 39 s, and standing refills in about 170 s. A spent tiger still runs 3.1 m/s.

**Boars.** `eatsFruit {reach 4.5, takes 2, every 7–16 s, seeks 90}`. While grazing head-down, a boar picks from the band's own orchard. If nothing is in reach it samples 24 fruit (`nearestFruit`) and walks to the nearest within 90 m.

### Birds and butterflies

Scenery: nothing reads them, and neither moves while unwatched. *Measured* (source comment): together they used to cost more than every herd.
- **Birds** (`FLOCK`): boids with 16 m neighbours; cohesion 0.35, alignment 0.55, separation 9.0 inside 3.2 m. Speed 5–13 m/s, 32–100 m above the ground below, banking into turns. They turn back past a fixed 460 m from the centre. The flock is dealt between the loaded bird models.
- **Butterflies:** a random walk round a home spot. Fresh pushes every 0.18–0.53 s, pulled home beyond 9 m, 0.35–3 m above ground, at most 2.6 m/s, flapping at 17–27 Hz.

### Counts, hunting pressure, regrowth, carcasses

- **Counting:** a dead animal keeps its slot, parked at zero scale once. `recountAnimals` counts the living plus birds and butterflies, and runs on every kill, birth and restore.
- **Band hunting** (`FOOD`, `src/life.ts`): search radius 300 m (wider with tracking). A species below `minStock` 40% of its starting count is left alone. Within `killRange` 9 m a hunter rolls `QUARRY.chance` × spear skill every 0.7 s, for `meat·scale·ABUNDANCE`.
- **Regrowth** (`repopulate`, every book pass): a `QUARRY` species below its starting count breeds `regrow·alive·(1 − alive/target)·days` animals, with the fraction rolled. Newborns take free non-carcass slots within ±10 m of a random anchor.
- **Strays:** a species at zero gets `STRAYS.pair` 2 back with probability `2·days/yearLength` per pass, about twice a year.
- **No regrowth:** tigers and horses are not in `QUARRY`, so bands and spears never take them, and `repopulate` never replaces one that a spear or a tiger kills.
- **Carcasses:** a spear kill lies on its side for `CARCASS_DAYS` 1 day, then is hidden. E within 2.2 m picks it up as meat.
- **Saved:** the living count per species; restoring marks the first N slots alive.

*Measured* (commit 5d08bd8): with one birth per pass, a warren that should have earned about 17 rabbits a day got 8.

### Scheduling

- **Grouping:** above `LOD.from` 24 animals on the whole map, animals step in groups, each group taking the time it waited. Unwatched the stride is `min(384, ceil(n/24)·6)`; watched, `min(8, ceil(n/24))`.
- **Exemptions:** predators and every horse (`spec.predator || spec.mount`) step every frame. A grouped tiger would cover 30 m in one step, and a grouped horse would trail its rider.
- *Measured* (source comment): a simulated year once took 111 s, 84 of them in the herds.

**Guaranteed by tests:**
- **Counts and regrowth:** animals are counted alive, and every kill or regrowth recounts. A hunted species regrows at its own rate, and one hunted to nothing comes back as a breeding pair that grazes where it was born.
- **Scheduling:** the crowd is every animal on the map. Predators and ridden animals are never grouped, herds think less often than people, and a carcass is hidden once.
- **Boars and stamina:** a boar eats fruit from the band's orchard, seeks it, and is slower than a deer. A deer walking never drains; a fresh deer outruns a hunter, a spent one does not; one rate function serves people and animals.
- **Boot check:** the models load and are drawn, no animal instance is left black, and counts move sanely. Down low, the played person is on no threat list. A spear kill lies still and is picked up as meat.

---

## 7. The tiger and the people it hunts

| `hunt` | Value | | `hunt` | Value |
|---|---|---|---|---|
| `sees` (animals) | 62 m | | `chase` | 11 s rush |
| `seesPeople` | 22 m | | `sulks` | 30 s |
| `reach` | 2.2 m + prey scale (person 0.6) | | `lasts` | 6 days full → empty |
| `feeds` | 40 s | | `hunts` | 0.55 |
| `prefersAnimals` | ×6 distance for a person | | `desperate` | 0.22 |
| `company` | 15 m | | `meal` / `person` | 0.8 / 0.5 |

**Hunger.**
- `d.fed` starts between 0.35 and 1 and falls by `slice/P.dayLength/lasts` per step.
- Above `hunts` the tiger ignores prey and wanders, though herds still flee it.
- *Derived:* from full, a tiger hunts after 2.7 days and is desperate after 4.7.
- *Note from the source:* `slice` is paced time, so with `PACE_DAY` set above the day length the stomach empties faster per calendar day.

**Choosing quarry** (`nearestQuarry`).
1. Every living, untamed, non-predator animal within 62 m is scored by distance. Horses count.
2. If `fed > desperate`, it stops here.
3. A person qualifies only if they are awake, not up a tree, not on safe ground, within 22 m (5.5 m if hiding) and without awake company within 15 m. They score `distance × 6`, so any animal in sight still wins.

**Dropping prey.** A tiger re-picks its target at a rate of 0.6 per second. It drops prey that died, reached safe ground, climbed a tree, is hiding more than 12 m away (`HIDE_LOST`), or got more than 80.6 m (`1.3·sees`) ahead.

**The rush.**
- The tiger charges at up to 7.4 m/s while `d.chase` accumulates.
- **Out of time:** past 11 s it breaks off, logs "`<name>` outran a tiger" if the prey was a person, and sulks 30 s. Exhaustion also ends a chase.
- **Kill:** in reach, `takeQuarry` marks an animal dead or calls `killPerson(i, 'tiger')`, the single death path. It eats where it stands for 40 s and gains 0.8 (animal) or 0.5 (person).
- *Derived:* a rush closes 11 × (7.4 − 3.6) = 41.8 m on a jogging person, less than the 46 m at which people notice a tiger.

**PANIC: how band members react** (`src/move.ts`).
- **Noticing:** at `PANIC.sees` 46 m ÷ the `bold` trait.
- **Running:** for `runs` 14 s, renewed only after it lapses. They drop their errand and jog (3.6 m/s; children 80%) whatever the ground, to the nearest lit fire of their own camp (`nearestFire`, ±2 m).
- **Safe ground:** `safeGround(camp) = PANIC.safe 9 + PANIC.fireSafe 17 × fire skill`, added to camp reach: `inCamp(x, z, extra)` holds within `campReach(c) + extra` of any camp, where `campReach = max(CAMP_CLEARING 26, grown reach)`. *Derived:* a basic camp is safe to 35 m from its centre with no fire-keeping and 52 m at mastery, more with outskirts. A tiger neither picks nor keeps chasing anyone there.
- **Recent rule** (commit efb585f): nobody already on safe ground, asleep or led panics. Horses grazing by camps drew tigers in, and people at the fire panicked on the spot until they died of exhaustion.

*Measured* (commit efb585f, 160 people, 12 days): 88 exhaustion deaths with horses against 2 without. Charging riders a walker's effort left 18–19. After the safe-ground rule, 165 people with horses, 165 without, and no exhaustion deaths.

*Measured* (`src/wildlife.ts`, six seeds × eight years):

| Version | Tiger share of deaths | Tiger deaths | Alive at 8 years |
|---|---|---|---|
| original | 73% | 38 | 87 |
| + `seesPeople` and `company` | 44% | 27 | 105 |
| + `desperate` | 26% | 15 | 112 |

**The person you play** (`src/danger.ts`, `src/spear.ts`; controls are in the gameplay section).
- A tiger is shown on screen within 48 m (×0.55 at night).
- Z within 2.2 m of a tree climbs it; a tiger cannot choose or follow them.
- Z elsewhere hides them and crawls at 0.35 of a walk.
- E throws a spear: chance 0.4 × distance falloff × spear skill × 1.25 if hiding, capped at 0.75. A hit kills the tiger. A miss makes it hungry and sets it on the thrower.

**Guaranteed by tests:**
- **Tiger:** it is a lone predator the herds fear, preferring four legs and unable to reach sleepers. Kills go through the one death path, and it eats where it stands. It hunts on hunger measured on the calendar, and a person is a smaller meal. It is faster than a deer by under 20%. Hunters never target it, and it uses the three shared states.
- **Stomach:**
  - It sees deer farther than people, and people see it first.
  - It never takes somebody with awake company.
  - Desperate is below hungry and above zero, and animals are scored before people even then.
  - A full stomach lasts over a day, and the tiger is idle over 40% of its cycle.
- **Surviving:**
  - People notice, drop what they are doing, and keep running after losing sight of it.
  - A tiger will not come to the fire, and a better-kept fire holds it further off (`safe + fireSafe ≥ CAMP_CLEARING > safe`).
  - The fastest `fleeSpeed` is exactly 7.4 and beats the jog.
  - The rush is counted while closing, breaks off, sulks, and resets on every ending.
  - Reaching the fire ends a chase, and a rush closes less than the notice distance but more than half of it.
- **Horses:** nobody already behind the fire panics, and tigers skip a band's own horses.
- **Boot check:** a tiger up a tree gives up, and E at a tiger in reach kills it or brings it on.

---

## 8. Horses as wildlife

Wild horses are an ordinary `SPECIES` entry (`key: 'horse'`, `mount: true`), counted by `HORSES` (0–90; 18/12/6 by preset). They graze in herds of 6 and flee from about 26 m (20 × scale + 6) at 7.2 m/s.

**Constraints.**
- **Speed:** `fleeSpeed` stays under the tiger's 7.4, because a test pins the island's fastest `fleeSpeed` at exactly 7.4. `RIDE.most` 7.5 m/s must stay within 0.5 of the horse's `fleeSpeed`.
- **Grouping:** `mount` keeps every horse, wild or tamed, out of LOD groups.
- **Predation and regrowth:** tigers hunt wild horses but skip tamed ones. Horses are not `QUARRY`, so bands cannot hunt them and nothing breeds them back.

**Tamed horses.** A tamed horse keeps its herd slot, so it is drawn, animated, preyed on and saved by the herd code, while `tendHorse` (`src/riding.ts`) replaces its grazing and fleeing. Taming odds, `RIDE.kept` 1–8, the `RIDE.wild` 3 herd floor, riding speeds, walls and mounted patrols are in the riding and settlement sections. A save records each band's horse count and re-tames that many of the nearest wild horses.

**Guaranteed by tests:**
- There are wild horses, counted like every herd, in every preset and in the schema.
- Anything ridden is never grouped.
- Riding is never quicker than a horse.
- A tiger does not hunt a band's own horses.

---

## Open questions found in the source

None of these is covered by a test.

- **Forage while watched:** `recoverForage` runs only in `stepWorld`, so watched ground does not recover.
- **Model arrival:** model arrival (`rebuildFauna`) appears to undo restored herd counts and tamed horses.
- **No regrowth:** tigers and horses never regrow (absent from `QUARRY`).
- **Shared stream:** bison and boar share a herd stream, so their first anchors coincide.
- **Bird range:** birds turn back at a fixed 460 m on any map size.
- **Dead code:** `outcrops`/`nearestRock` are built but unused.
- **Snow line:** the seasonal snow line (42–112 m) is shader-only; placement uses `SNOW` 96 m.
- **Tiger hunger:** it runs on paced seconds, which equal calendar time only while `PACE_DAY` is unset.
- **Population reset:** a reset can move trees, deposits and thickets, because they avoid camp sites drawn from the salted seed.
