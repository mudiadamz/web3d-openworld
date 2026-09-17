# Architecture and operations

[Technical documentation](README.md)

## Overview

The project is a three.js island on which a few hundred to several thousand simulated people forage, hunt, farm, split into bands and grow into cities, with nobody writing their history in advance. Architecturally it has two halves:

- **The page** (`index.html` plus the modules compiled from `src/*.ts` into `dist/`) holds the whole world: terrain, simulation, rendering, UI. It runs standalone (any static server, or with care `file://`) using the defaults written into `src/params.ts`.
- **The Node server** (`server.ts`, `config.ts`, `db.ts`) is optional. It serves the page with settings resolved from the environment injected into it, and keeps the chronicle, the daily statistics, the shelf of worlds and the single save bookmark in SQLite.

The world itself is never stored: a seed rebuilds terrain, creeks, camp sites, deposits and herd anchors exactly, and a save holds only what no seed can reproduce (clock, bands founded in play, the living, lineage, graves, quarry levels, herd counts). The simulation draws from its own seeded stream (`seedSim`/`luck` in `src/clock.ts`), so a seed replays the same history when run in fixed unwatched steps.

## Repository layout

| Path | What it is |
|---|---|
| `index.html` | Markup, styles, the import map, `modulepreload` links, the start-up screen and the `<!--CONFIG-->` marker. No program: the code is in modules. |
| `src/*.ts` | The page's 50 modules (TypeScript), grouped below. |
| `dist/` | `tsc` output of `src/` (`.js` + `.map`), which is what the browser loads. Gitignored. |
| `server.ts` | HTTP server: page, static files, config and version injection, `/api/*`, `/healthz`, dev reload stream, graceful shutdown. |
| `db.ts` | The chronicle database on `node:sqlite` (schema, queries, truncate, forget). |
| `config.ts` | The settings schema (`SCHEMA`, `SERVER_SCHEMA`), the `.env` parser, `--flag` parsing, coercion and clamping. |
| `dev.ts` | `npm start`: fetch newest humans-threejs, build, run the server, restart on change, reload the page. |
| `reset.ts` | `npm run reset`: empty every table from a terminal. |
| `config.js`, `db.js`, `dev.js`, `reset.js`, `server.js` (+ `.map`) | Built from the `.ts` beside them by `tsconfig.node.json`. Gitignored; edit the `.ts`. |
| `test.js` | The fast suite: 1,968 checks that read source as text or run extracted pieces of the build. |
| `test-boot.js` | The boot check: imports `dist/` against a mocked DOM and a stubbed renderer, drives frames, then optional long probes. |
| `spike/` | `headless.mjs` (boot the island in Node), `sim-headless.mjs` (step-cost bench), `sim-push.mjs` (server-owned island pushed over SSE). |
| `deploy/` | `service.ps1` (Windows background service), `README.md`, and the generated, gitignored `run.cmd`. |
| `vendor/` | Gitignored local copies for the boot check and spikes: `three.module.js` (r169), `GLTFLoader.js`, `utils/BufferGeometryUtils.js`; optionally `models/`. |
| `.env.example` | Every variable, documented. `.env` is the local, gitignored copy. |
| `.npmrc` | `omit=peer` and `legacy-peer-deps=true` (see Build). |
| `CLAUDE.md` | Rules for working on the repo (which suites to run, how to compare boot results). |
| `HUMAN-MODEL-SPEC.md` | What the humans-threejs model had to change to fit this rig. |
| `assets/ss/` | README screenshots. |
| `chronicle.db` (+ `-wal`, `-shm`), `logs/`, `node_modules/` | Runtime and install artefacts, all gitignored. |

### Source modules by responsibility

Loop, settings and persistence

| Module | Responsibility |
|---|---|
| `main.ts` | The frame loop (`tick`), the unwatched world step (`stepWorld`), Run years (`seeAhead`/`runAhead`), the frame cap, `?watch=` viewing, boot sequence. |
| `params.ts` | `P` (every setting and its default), `QUALITY` presets, injected-config and URL-override merging, world constants (`WORLD`, `MAP_SCALE`, `PEOPLE_ROOM`, `CAMP_CEILING`). |
| `clock.ts` | Clock rates, night detection, `pace()`, `FF_STEP`/`ffStep`, the seeded simulation stream, `LOD` turn-taking, `drawingWorld`, body proportions from the model's joint table. |
| `save.ts` | Snapshot and restore (SQLite via `/api/state`, else `localStorage`), `SAVE_EVERY`, `?fresh=1`. |
| `background.ts` | Keeps the island running, undrawn, while the tab is hidden. |
| `types.ts` | `Camp`, `Person` and related shapes; emits nothing (`export {}`). |

World and rendering

| Module | Responsibility |
|---|---|
| `scene.ts` | Renderer, camera, sky, sun, seasons, wind uniforms, materials. |
| `world.ts` | World construction: terrain, water, trees, rocks, grass tiles. |
| `noise.ts` | Seeded value noise, terrain height and slope. |
| `creeks.ts` | Creeks traced downhill, carved into the height field, then filled; lakes and springs. |
| `paths.ts` | The wear field: footpaths worn by feet, roads stored above any trail value. |
| `crowd.ts` | Per-frame packing of only the visible, unparked parts of people into drawn meshes. |
| `bubbles.ts`, `icons.ts` | Activity bubbles over heads (one points draw from a canvas atlas); shared icon drawings. |
| `map.ts` | Corner and full-page relief map, layers, markers, click to travel. |
| `audio.ts` | Synthesised nature sound driven by wind, sun and proximity to the surf. |

Bodies, camps and buildings

| Module | Responsibility |
|---|---|
| `people.ts` | Person meshes (humans-threejs body), animals' shapes, camps, graves, room growth; re-exports settlement names. |
| `looks.ts` | Builds, hides, hair, faces, loads and tools ported from humans-threejs, drawn from packed per-garment lists. |
| `village.ts` | Tent kinds by building skill, coloured in geometry. |
| `footprint.ts` | Non-overlapping tent/house footprints (`pitch`, `TENT_REACH`). |
| `settlement.ts` | Outskirts, granaries and stores by rung, village houses, city streets, hall, market, wall, roads. |
| `walls.ts` | Wall crossing only at gates, gate routing, the road network handed to walkers. |

Simulation

| Module | Responsibility |
|---|---|
| `life.ts` | Food store, jobs, visits, splits, births, deaths, the chronicle and its posting to the server. |
| `skills.ts` | The 22 skills, practice and fade, roles. |
| `larder.ts` | Ground and water richness and how it runs down and recovers. |
| `orchard.ts`, `thickets.ts` | Fruit on visible trees; berry thickets. |
| `quarries.ts`, `wood.ts`, `rafts.ts` | Ore deposits; wood cutting and stacks; docks, rafts and fishing trips. |
| `farming.ts` | Farmland survey, ditches or dry-field wells, crops and flocks. |
| `society.ts` | The band-to-city ladder, trade ties, city advantages, border tension, place names. |
| `explore.ts`, `lessons.ts`, `ill.ts` | Explorers and finds; lessons from deaths; per-camp sick counts. |
| `move.ts` | Walking, obstacle avoidance, path preference, job execution, `updatePeople` with turn-taking, the camera rig. |
| `wildlife.ts`, `riding.ts` | Instanced herds, the tiger, the lineage record; horses, taming, riding, mounted patrols. |

Playing somebody, and the UI

| Module | Responsibility |
|---|---|
| `reach.ts`, `spear.ts`, `hunt.ts`, `drops.ts`, `bag.ts`, `vitals.ts`, `danger.ts` | What E acts on; the thrown spear (rolled in the step) and its drawing; piles on the ground; the basket's contents in words; the life bar; tiger warnings. |
| `roleplay.ts` | `ROLEPLAY=true`: one character, its sheet, levels, goals, achievements. |
| `ui.ts` | Panel, world shelf, Reset population / Delete everything, touch rail, About version. |
| `chronicle.ts`, `kin.ts`, `made.ts` | Chronicle window, band card, input wiring, follow camera; lineage view; "what a skill has made" counts. |

## Build

### Two TypeScript projects

| | `tsconfig.json` (the page) | `tsconfig.node.json` (Node side) |
|---|---|---|
| Inputs | `include: ["src/**/*"]` | `files: ["config.ts", "db.ts", "reset.ts", "server.ts", "dev.ts"]` |
| Output | `rootDir: src`, `outDir: dist` | `rootDir: "."`, `outDir: "."` (each `.js` beside its `.ts`) |
| Target / module | ES2022 / ES2022, `moduleResolution: bundler` | same |
| Libs / types | `ES2022`, `DOM`, `DOM.Iterable` | `ES2022`, `types: ["node"]` |
| Strictness | `strict: false`, `noImplicitAny: false`, `skipLibCheck` | same |
| Other | `allowJs: true` (a no-op now every module is `.ts`), `paths` maps `three/addons/*` to `@types/three/examples/jsm/*` | `allowJs: false` |

The Node files emit beside their sources because `node server.js`, `dev.ts`'s spawn, `test.js`'s `import './config.js'` and the installed Windows service all name those paths. `files` is used instead of `include` because TypeScript excludes its own `outDir` (the root) from `include`. The two test harnesses stay JavaScript and are not compiled. Installed toolchain: `typescript` 7.0.2, `three` and `@types/three` 0.169.0 (types only), `@types/node` 22.20.2; `engines.node` is `>=18`, but the chronicle needs Node 22+.

### npm scripts

| Script | Command | Use |
|---|---|---|
| `start` | `tsc -p tsconfig.node.json && node dev.js` | Development server (watch, rebuild, restart, page reload, model update). |
| `serve` | `npm run build && node server.js` | Plain server, no watching or fetching. |
| `build` | `tsc && tsc -p tsconfig.node.json` | Page into `dist/`, Node files beside sources. |
| `build:watch` | `tsc --watch --preserveWatchOutput` | Page only. |
| `types` | `tsc --noEmit && tsc -p tsconfig.node.json --noEmit` | Type-check both halves. |
| `test` | `npm run build && node test.js && node test-boot.js` | Runs the **full** boot check (about 13 minutes); see Testing. |
| `boot` | `node test-boot.js` | Boot check alone. |
| `reset` | `tsc -p tsconfig.node.json && node reset.js` | Empty the database. |
| `model` | `npm install --no-audit --no-fund humans-threejs@github:mudiadamz/humans-threejs#main` | Move the people model to the newest `main`. |
| `service`, `service:install`, `service:restart`, `service:status` | `powershell ... -File deploy/service.ps1 [verb]` | Windows service management. |

### Why imports name `.js`

Every import in `src/` names the emitted file (`'./noise.js'`, not `'./noise.ts'`). `tsc` never rewrites a module specifier, and `dist/` is loaded by the browser as plain ES modules, so a specifier must name the file that will be fetched. `.ts` specifiers are rejected, and bare `./noise` would compile under `moduleResolution: bundler` and then fail to resolve in the browser.

### three.js from the CDN

three.js is not bundled or served locally. The import map in `index.html` maps:

```json
"three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
"three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/",
"humans-threejs/": "./node_modules/humans-threejs/"
```

After the import map, `<link rel="modulepreload">` names three, the addons used, `node_modules/humans-threejs/human-parts.js` and every `dist/` module, so a slow link fetches all modules in one round instead of three. The page therefore needs network access to jsDelivr in every mode. Only the tests and spikes use `vendor/three.module.js`.

Guaranteed by tests ("loading over a slow link"): every `dist/` module is preloaded and nothing that is not one; the preload list comes after the import map; the start-up screen reports the real error and does not call a slow load a failure (no 6 s timeout; advice only after 60 s).

### The humans-threejs dependency

The people's bodies (`human-parts.js`) are the one runtime dependency: `"humans-threejs": "github:mudiadamz/humans-threejs#main"`, installed as 0.4.2 with the lockfile naming commit `99629a4`. The page loads it straight out of `node_modules` through the import map.

- `npm start` re-installs it by spec before the server starts (`updateModel` in `dev.ts`), which makes npm look the branch up; offline it starts on what it has. A later lockfile change restarts the dev server only if the resolved commit moved. `npm run serve` and the service never fetch.
- `.npmrc`: `omit=peer` (the package's three peer would be a dead second copy) and `legacy-peer-deps=true` (0.4.2 asks for `@types/three ^0.180` as an optional peer against this project's `^0.169`, which failed `npm install` with ERESOLVE).
- `server.ts` warns at start-up if the package is missing; `test-boot.js` fails with that reason.

Guaranteed by tests ("bodies", "emptying it"): the model comes from the package, not a copy in `src/`; the page finds it where npm put it; it is installed from GitHub following `main`, without the three.js peer; `npm start` asks for the newest model before the server starts; only a model that actually moved restarts it; `npm run model` is exactly the install command above.

### The module line ceiling

No file in `src/` may reach 2,000 lines as `text.split('\n').length`, i.e. at most 1,998 newline-terminated lines. It is enforced by the `test.js` check "none of which is longer than the page was" (group "one file per thing"), which computes `Math.max(...rawSources.map((t) => t.split('\n').length)) < 2000` over every file in `src/` and reports the longest. It does not apply to the root `.ts` files or the test harnesses.

At HEAD `chronicle.ts` and `life.ts` are at 1,998 lines (split length 1,999) and `move.ts` at 1,997. When a module reaches the ceiling, a section that is its own subject is moved out whole and verbatim, with importers repointed or names re-exported: `skills`, `larder`, `orchard` and `ill` out of `life`; `creeks` out of `move`; `kin` out of `chronicle`; `settlement` out of `people`.

The import graph has cycles (`life`/`move`, `life`/`skills`, `people`/`settlement`, `people`/`farming`). They are safe under one rule: nothing is called, and no other module's binding touched, while a module is still evaluating. DOM wiring is deferred into `wireWorld()` and `wireInput()`, called by `main.ts` once everything has loaded, and state written from outside its module goes through an exported setter (`setDrawingWorld`, `setWorldClock`, ...), since imported bindings are read-only.

Guaranteed by tests ("one file per thing", "module-level ordering"): the page is markup that loads `dist/main.js`; no module calls `.add`/`.addEventListener` on an imported binding at load; wiring runs before `buildWorld()`; state written from elsewhere goes through its owner; nothing at module level reads a `const` declared below it.

## Server

`server.ts` depends only on `node:http`, `node:fs`, `node:child_process`, `node:path` and `node:url`.

### Start-up

1. Settings are merged in increasing precedence: `.env` file, then the process environment, then command-line flags (`parseArgs`). Flags are turned into environment-style values (`--port 8089`, `--chronicle-db x.db`, `-p`/`-h` aliases, a bare `--shadows` means true), so they go through the same coercion, clamping and notes as `.env` lines.
2. `resolveConfig` produces `{ values, explicit, notes }` for the page; `resolveServer` produces `port`, `host`, `chronicle_db`. Every note (clamped, ignored, unknown flag) is printed as `  ! ...` and start-up continues.
3. The humans-threejs check runs, then `openDb(join(ROOT, server.chronicle_db))`. `db` is `null` if `node:sqlite` is unavailable or the file cannot be opened.
4. The listener starts on `host:port` and prints the resolved settings and the list of API routes, or that the chronicle is off.

Note: `server.ts` joins `CHRONICLE_DB` onto the project root without the `isAbsolute` guard that `reset.ts` has, so an absolute path given to the server is resolved under the root. Use a root-relative path.

### Serving the page

`GET /` and `GET /index.html` read `index.html` and replace `<!--CONFIG-->` with:

```html
<script>window.__CONFIG__ = {"values":{...},"explicit":[...],"chronicle":true};</script>
<script>window.__VERSION__ = {"version":"1.0.86","commit":"5751a50"};</script>
<!-- plus the dev reload snippet, only when DEV_RELOAD is set -->
```

JSON is escaped (`<` as `\u003c`). Without the marker the page is served unconfigured, with a warning. The page applies the injection in `applyInjectedConfig` (`src/params.ts`): scalars overwrite `P`; a `quality` in `explicit` loads that preset's populations; explicit counts then win.

Any other non-API path is a static file under the project root (403 if the normalised path escapes it, 404 for missing files, 500 otherwise). Every response is `cache-control: no-store`, because a fresh `index.html` driving cached old modules once looked like inert markup. The static handler serves any file under the root, including `.env` and `chronicle.db`, which is one more reason the default bind is loopback.

### Version injection

`version()` computes `{ version, commit }`:

- major and minor from `package.json` (`1.0`), patch = `git rev-list --count HEAD` (86 commits at HEAD, so `1.0.86`), commit = `git rev-parse --short HEAD`;
- each git call runs as `git -c safe.directory=<ROOT with forward slashes> ...`, trusting this repository for that command only. The service runs as SYSTEM, git 2.35.2+ refuses repositories owned by another user, and without this the service silently served `1.0.0` (measured: 1.0.65 from a terminal, 1.0.0 from the service, 1.0.66 from the service after the fix);
- cached for 5 s (`versionAt`), so a new commit shows on the next reload rather than the next restart;
- with no `.git`, falls back to `package.json`'s version and an empty commit.

The page shows it in the About section of the `?` card (`#aboutVersion`, `src/ui.ts`): `v1.0.86`, with `commit 5751a50` as the tooltip. Opened without a server it keeps the markup's text, `standalone`.

Guaranteed by tests ("which version this is"): the version is derived from the commit count and handed to the page as `window.__VERSION__`; it is injected after the config script without disturbing it; the About box renders it.

### Development reload

Under `dev.js` the server gets `DEV_RELOAD=1`, serves `GET /__dev/reload` as an event stream (`retry: 300`) carrying a per-process id, and injects a snippet that reloads the page when a reconnect hears a different id. `dev.ts` watches `.env`, `index.html`, `server.ts`, `config.ts`, `db.ts` and `package-lock.json` by name (never the database or editor swap files) and `src/` non-recursively (Node 18 on Linux). After `SETTLE_MS` (150 ms) a `src/` change rebuilds the page, a root `.ts` rebuilds the Node project, and the child is sent SIGINT and restarted; a failed `tsc` keeps the last good build. Measured: touching `.env` brought the server back with a new id in 1.3 s. Without `DEV_RELOAD` neither the endpoint nor the snippet exists.

### Endpoints

Non-API routes:

| Method | Path | Behaviour |
|---|---|---|
| GET | `/`, `/index.html` | Page with config, version (and dev snippet) injected. |
| GET | `/healthz` | `{ ok, pid, uptime, port, chronicle, node }`. Answered before the `/api/` guard and without touching the database, so a failed chronicle is reported, not fatal. Used by `deploy/service.ps1`. |
| GET | `/config.json` | The injected payload, pretty-printed: exactly what the server resolved. |
| GET | `/__dev/reload` | Dev only: restart-id event stream. |
| GET | anything else | Static file under the project root. |

API routes. Every `/api/*` request returns 503 `{ error: 'no chronicle database' }` when `db` is null, and unknown routes return 404 `{ error: 'no such endpoint' }`. JSON bodies go through `readJson` with a cap.

| Method | Path | Purpose | Behaviour |
|---|---|---|---|
| POST | `/api/run` | Registers a run. The page calls it once per served boot (`startRun`, skipped when standalone) and again after Delete everything. | Body `{ seed, quality, counts }`; inserts into `runs`; returns `{ runId }`. |
| POST | `/api/events` | Chronicle lines, batched and flushed once a simulated day (`flushEvents` in `onNewDay`; a failed batch is re-queued). | Needs `runId` and an `events` array, else 400. Stores at most the first 5,000 of a batch in one transaction; `world` truncated to 60 chars, `text` to 500. Returns `{ stored }`. |
| DELETE | `/api/events?seed=N` | Reset population: removes this world's chronicle lines only, keeping the world on the shelf. | 400 without a finite seed; `forgetEvents(seed)`. |
| GET | `/api/state` (any method but POST/DELETE) | Restore the saved session at boot (`readSavedState`). | 404 `{ error: 'nothing saved' }` when empty; otherwise the stored JSON text verbatim. |
| POST | `/api/state` | Autosave every `SAVE_EVERY` (10) seconds of wall time, after background runs and after Run years. | Body limit `STATE_LIMIT` (64,000,000 bytes). One row, overwritten. On a non-OK response the page saves to `localStorage` instead. |
| DELETE | `/api/state` | Clear the bookmark (`clearSavedState`, e.g. from Reset population). | `clearState()`. |
| GET | `/api/worlds` (any method but POST/DELETE) | The shelf of worlds. | `{ name, seed }[]`, newest first, 60 by default (200 max in `db.worlds`). |
| POST | `/api/worlds` | Keep a world on the shelf. | Needs a finite `seed`, else 400; upsert keyed by seed (a second save renames); name truncated to 60 chars, default `Seed N`. |
| DELETE | `/api/worlds?seed=N` | Remove a world and its chronicle lines. Not called by the current page (Delete world became Reset population). | 400 without a seed; `forgetSeed(seed)` in one transaction. |
| GET | `/api/data` | Row counts per table. | Explicitly GET-only: any method other than GET or DELETE gets 405, so a mistaken method cannot look like success. |
| DELETE | `/api/data` | Delete everything. | `truncateAll()`; returns `{ ok, removed, remaining }`. No authentication. |
| POST | `/api/tribes` | One row per band per simulated day (`postTribes`, in `onNewDay`). | Needs `runId` and a `tribes` array, else 400; at most 64 rows; upsert on `(run_id, day, name)`. Returns `{ stored }`. |
| GET | `/api/tribes?run=N` | Per-band history of a run, for anything reading the database. | Defaults to the newest run; `[]` if there is none. |
| POST | `/api/sample` | One world row per simulated day (`postSample`): people, food, animals, kills. | Needs `runId`, else 400; upsert on `(run_id, day)`. |
| GET | `/api/chronicle?limit=&run=` | Without `run`: every world's lines, newest first (the panel asks for 200 at boot, the chronicle window for 2,000). With `run`: one run's lines. | Without run: default 200, max 2,000. With run: default 100, max 1,000. |
| GET | `/api/history?run=N` | Daily samples of a run. | Defaults to the newest run. |
| GET | `/api/runs` | Recent runs. | 25 newest, each with its event count and highest sampled day. |

### Limits and error handling

`BODY_LIMIT` is 1,000,000 bytes for every JSON body except `POST /api/state`, which gets `STATE_LIMIT` (64,000,000), sized for 20,000 living people, a full lineage and 200,000 graves. Past a limit the request is paused, a 413 with the message is written and logged as one warning, and only then is the request destroyed, so the page can tell "too big" from "server gone". Unparseable JSON ends in a 500.

Guaranteed by tests ("the size of a saved world", "emptying it"): the server takes the largest save the page can make (computed from `LINE_MAX`, a 20,000-person cap, 200,000 graves and the real row shapes); only `/api/state` gets the room; the page checks `res.ok` and keeps the world in the browser otherwise; 413 is answered, logged as a warning, and written before the socket closes; `/api/data` DELETE exists and GET-only reading answers 405; the reload is only offered in dev; a restart is not held up by pages listening to the reload stream.

### Shutdown

`SIGINT`, `SIGTERM` and `SIGBREAK` call `shutdown`: dev reload streams are ended, the listener closed, then `db.close()` checkpoints the WAL; `STOP_GRACE` (5,000 ms) forces the exit if a request never ends. On Windows `Stop-Process` and `taskkill` never reach this code; only console control events do (CTRL_C as SIGINT, CTRL_BREAK as SIGBREAK). An abrupt kill costs a WAL recovery, not data.

## Database

`db.ts` imports `node:sqlite` (`DatabaseSync`) dynamically. It exists from Node 22; on older Node, or if the file cannot be opened, `openDb` returns `null`, the server reports `chronicle: off`, every `/api/*` route answers 503, and the page runs with `localStorage` only. The file is opened with `PRAGMA journal_mode = WAL` (bursts of writes, no concurrent readers), the schema is created if absent, and for databases from before the chronicle spanned worlds the `seed` and `world` columns are added to `events` with `ALTER TABLE`.

### Tables

| Table | Columns | What it stores |
|---|---|---|
| `runs` | `id` (autoincrement), `seed`, `quality`, `counts` (JSON text), `started_at` | One row per served page boot. The id tags events, samples and tribe rows. |
| `events` | `id`, `run_id`, `seed`, `world`, `day`, `hour`, `kind`, `text`, `x`, `z`, `at`; index `events_run_day (run_id, day)` | Chronicle lines from every world ever run on this machine. |
| `samples` | `run_id`, `day`, `people`, `food`, `animals`, `kills`; PK `(run_id, day)` | One whole-world row per simulated day. |
| `tribes` | `run_id`, `day`, `name`, `people`, `children`, `food`; PK `(run_id, day, name)` | One row per band per simulated day. |
| `worlds` | `seed` (PK), `name`, `created_at` | The shelf: a seed is the world, the name is how you find it. |
| `state` | `id` (CHECK `id = 1`), `payload`, `saved_at` | The single save bookmark, overwritten on every save. |

Batch inserts (`addEvents`, `addTribes`) run inside `BEGIN`/`COMMIT` with `ROLLBACK` on error, so a batch is one fsync.

### Emptying and forgetting

- `truncateAll()`: in one transaction, counts and deletes every row of `events`, `samples`, `tribes`, `state`, `worlds`, `runs` and clears `sqlite_sequence` (the next run is run 1); then, outside it, `PRAGMA wal_checkpoint(TRUNCATE)` and `VACUUM`, each allowed to fail. It returns the rows removed, since "emptied" and "nothing there" otherwise look alike. The checkpoint exists because the WAL was measured at 4 MB against 80 KB of tables.
- `forgetEvents(seed)`: deletes that seed's events only (Reset population).
- `forgetSeed(seed)`: deletes that seed's events and its `worlds` row in one transaction.

In the page, Delete everything (`#wipeAll`, armed by a first click) calls `DELETE /api/data`, removes the five named `localStorage` keys (`openworld.state`, `openworld.worlds`, `openworld.chronicle`, `openworld.mapLayers`, `openworld.focus`) and then every other key starting `openworld.`, registers a new run and creates a new world, because there is always a world.

### `npm run reset`

`reset.ts` empties the database without the page or the server, for when the page itself is the problem. It resolves `CHRONICLE_DB` from `.env` and the environment against the working directory, or takes a path argument (`npm run reset -- runs/one.db`, absolute paths used as given); exits 0 with `nothing to empty` if the file is absent and 1 if it cannot open it (Node older than 22); prints per-table counts before and after; and reminds you the browser keeps its own copy. It never deletes the file: a running server holds it open in WAL mode and carries on with the truncated database. A page left open keeps its old run id until reloaded.

Guaranteed by tests ("emptying it"): every `CREATE TABLE` in `db.ts` is in `truncateAll`'s list; one transaction; the count is returned; `sqlite_sequence` is cleared; checkpoint and VACUUM follow; `npm run reset` exists, uses `truncateAll`, does not mangle absolute paths and never unlinks the file; the in-page button clears all five named keys and anything else under `openworld.`, registers a new run because the old id points at nothing, asks twice, and leaves a world behind; Reset population asks twice, keeps the seed and the shelf entry, takes its people from a new population salt, and deletes only this seed's chronicle lines, in the browser and on the server.

## Configuration

Settings come from `.env`, the process environment and `--flags` (highest wins), are resolved by `config.ts` and injected into the page. Nothing throws: unparseable values are dropped with a note, out-of-range numbers are clamped with a note, ints are rounded, enums are lowercased, empty strings are not values. Booleans accept `1/true/yes/on` and `0/false/no/off`. The `.env` parser handles comments, blank lines, single and double quotes, trailing ` # comment` on unquoted values, and `#` inside URLs. Unset settings keep the defaults in `P` (`src/params.ts`), which are also what a standalone page uses. The schema has 46 page settings and 3 server settings; the `slider:` fields on three of them are left over from the removed panel sliders.

### Page settings

| Variable | Path in `P` | Type | Range | Default | Effect |
|---|---|---|---|---|---|
| `SEED` | `seed` | int | int32 | 20260906 | The island: terrain, creeks, camp sites, deposits, herds. Same seed, same island. |
| `QUALITY` | `quality` | enum | `low`, `medium`, `high` | `high` | Rendering preset (below). Naming it also loads the preset's populations, before any explicit counts. |
| `MAP` | `map` | float | 800–6400 | 1600 | Island extent in metres (`WORLD`). Distances scale with `MAP_SCALE = WORLD / 1600`; counts do not. |
| `TIME` | `time` | float | 0–24 | 7.5 | Starting hour. The clock always runs. |
| `DAY_LENGTH` | `dayLength` | float | 60–7200 | 1440 | Real seconds per simulated day. |
| `PACE_DAY` | `paceDay` | float | 300–7200 | unset (= `DAY_LENGTH`) | Reference day for all speeds: `pace() = clamp(PACE_DAY / DAY_LENGTH, 0.5, 12)`. Food needs were balanced against 3600. |
| `YEAR_LENGTH` | `yearLength` | float | 4–200 | 24 | Simulated days per year; also scales cooldowns written in years. |
| `FERTILITY` | `fertility` | float | 0–3 | 1 | Birth-rate multiplier. |
| `ABUNDANCE` | `abundance` | float | 0.25–4 | 1 | Multiplier on every food yield where it is found (basket, fruit, catch, kill, crop). |
| `EXPOSURE` | `exposure` | float | 0.1–1.2 | 0.5 | Renderer tone-mapping exposure. |
| `WIND` | `wind` | float | 0–1 | 0.35 | Wind strength for grass, canopies and sound. |
| `WIND_DIR` | `windDir` | float | 0–359 | 135 | Degrees the wind blows toward, 0 = north. |
| `GUST` | `gust` | float | 0–1 | 0.5 | 0 steady, 1 arrives in waves. |
| `VIEW` | `view` | enum | `orbit`, `follow` | `orbit` | Starting camera mode. |
| `FOV` | `fov` | float | 30–110 | 58 | Camera field of view in degrees. |
| `WAVES` | `waves` | float | 0–2 | 1 | Sea swell and ripple scale. |
| `MODELS` | `models` | enum | `off`, `birds`, `all` | `birds` | glTF models for wildlife: none, birds only, or herds too. |
| `NIGHT_SKIP` | `nightSkip` | bool | | true | Run the night through in world steps once everybody is in. |
| `NIGHT_SKIP_RATE` | `nightSkipRate` | float | 1–60 | 6 | Share of each frame spent on the night: `NIGHT_BUDGET * rate / 6` ms. |
| `MAX_FPS` | `maxFps` | float | 0–240 | 30 | Drawn-frame cap; 0 draws every refresh. An unfocused window draws at most 10. |
| `BACKGROUND` | `background` | bool | | true | Keep running, undrawn, while the tab is hidden. |
| `NIGHT_FROM` | `nightFrom` | float | −0.9–0.3 | −0.02 | Sun height (sine of elevation) where the night may start being skipped. |
| `NIGHT_DEEP` | `nightDeep` | float | −0.9–0.3 | −0.25 | Sun height past which the night runs whatever stragglers are doing; never treated as above `NIGHT_FROM`. |
| `SHADOWS` | `shadows` | bool | | true | Sun shadows (only where the preset has a shadow map; `low` has none). |
| `TERRAIN_SHADOW` | `terrainShadow` | bool | | false | Terrain casts shadows (second pass, speckles at low sun); normal bias 1.6 instead of 0.06. |
| `WATER` | `water` | bool | | true | Water plane visible. |
| `SOUND` | `sound` | bool | | true | Synthesised nature sound. |
| `BUBBLES` | `bubbles` | bool | | true | Activity bubbles over heads; false never builds them. |
| `ROLEPLAY` | `roleplay` | bool | | false | Play one named newcomer; camera locked behind them. |
| `VOLUME` | `volume` | float | 0–1 | 0.55 | Master volume. |
| `GRASS` | `counts.grass` | int | 0–4000 | 2000 | Blades per 24 m tile. |
| `TREES` | `counts.trees` | int | 0–3000 | 1000 | Trees on the island. |
| `ROCKS` | `counts.rocks` | int | 0–1200 | 260 | Rocks. |
| `BISON` | `counts.bison` | int | 0–60 | 9 | Herd size. |
| `DEER` | `counts.deer` | int | 0–120 | 22 | Herd size. |
| `RABBITS` | `counts.rabbits` | int | 0–200 | 44 | Warren size. |
| `BOARS` | `counts.boars` | int | 0–120 | 16 | Boars, which compete for fruit. |
| `TIGERS` | `counts.tigers` | int | 0–40 | 2 | Predators. |
| `HORSES` | `counts.horses` | int | 0–90 | 18 | Wild horses a band can tame and ride. |
| `BIRDS` | `counts.birds` | int | 0–200 | 44 | Birds. |
| `BUTTERFLIES` | `counts.butterflies` | int | 0–400 | 70 | Butterflies. |
| `FLOWERS` | `counts.flowers` | int | 0–600 | 150 | Blooms per 24 m tile. |
| `FRUIT` | `counts.fruit` | int | 0–12 | 5 | Fruit per broadleaf tree. |
| `STREAMS` | `counts.streams` | int | 0–12 | 5 | Creeks carved into the terrain. |
| `CAMPS` | `counts.camps` | int | 0–40 | 2 | Starting camps; sites need 260 m between them, so about 7 fit at 1600 m, 22 at 3200, 40 by 4800. |
| `PEOPLE` | `counts.people` | int | 0–800 | 16 | Starting population. Not a ceiling: room starts at `PEOPLE_ROOM = min(4000, (WORLD/1000)^2 * 195)` and meshes double when outgrown. |

### Server settings (never sent to the page)

| Variable | Flag | Type | Range | Default | Effect |
|---|---|---|---|---|---|
| `PORT` | `--port`, `-p` | int | 1–65535 | 8080 | Listen port (the Windows service uses 8089). |
| `HOST` | `--host`, `-h` | string | | `127.0.0.1` | Bind address; `0.0.0.0` exposes it (unauthenticated destructive endpoints). |
| `CHRONICLE_DB` | `--chronicle-db` | string | | `chronicle.db` | Database file, relative to the project root. |

### Quality presets

| Preset | Terrain segments | Grass grid | Shadow map | Pixel ratio | Body roundness | Populations (grass/trees/people/camps) |
|---|---|---|---|---|---|---|
| `low` | 176 | 5 | 0 | 1.0 | 0 | 700 / 300 / 8 / 1 |
| `medium` | 288 | 7 | 1024 | 1.5 | 1 | 1300 / 600 / 12 / 2 |
| `high` | 448 | 9 | 2048 | 2.0 | 2 | 2000 / 1000 / 16 / 2 |

### URL overrides

Read by `applyUrlOverrides` and `main.ts`/`save.ts`, as escape hatches when a setting has made the page unusable: `?models=off|birds|all`, `?quality=low|medium|high` (loads its populations), `?grass=0`, `?flowers=0`, `?wind=0`, `?shadows=0`, `?terrainshadow=1`, `?water=0`, `?streams=0`, `?fresh=1` (ignore any saved state for one load) and `?watch=<SSE url>` (see the server-push spike).

Guaranteed by tests (".env.example", "schema vs. the page", ".env parsing", "values", "server settings", "the page merges what it is given", "villages"): every `SCHEMA` and `SERVER_SCHEMA` name is documented in `.env.example` and every documented name is real; every schema path exists in the page's evaluated `P`; `VIEW`, `QUALITY` and `MODELS` values match the page; the parser, coercion, clamping, rounding and notes behave as described; port defaults to 8080 and clamps 99999 to 65535, host to loopback, database to `chronicle.db`; an empty injection changes nothing, a named quality loads its populations, counts without a quality touch only those counts, unknown keys are ignored; an unset `PACE_DAY` stays unset on its way to the page and a set one is kept inside the range pace can use; `BACKGROUND`, `BUBBLES`, `ROLEPLAY` and `MAX_FPS` have their documented defaults.

## Deployment

### The Windows service

`deploy/service.ps1` runs the server in the background on Windows. It takes a verb (`install`, `uninstall`, `start`, `stop`, `restart`, `status` (default), `logs`) and `-Port` (default 8089), `-Bind` (default `127.0.0.1`) and `-Name` (default `OpenWorld`). Everything except `status` and `logs` needs an elevated PowerShell. `npm run service:install`, `service:restart` and `service:status` wrap it.

Port 8089 rather than the server's own 8080 is deliberate: the copy left running and a `node server.js` started to try something never fight over a port.

**Backend.** Node cannot be a services.msc service by itself (the SCM handshake must complete within 30 s; `sc create binPath="node.exe server.js"` fails with error 1053), so the default backend is a Scheduled Task:

| Setting | Value |
|---|---|
| Trigger | `-AtStartup` |
| Principal | `SYSTEM`, `ServiceAccount` logon, `RunLevel Highest` (runs with nobody logged in) |
| Restart | `RestartCount 3`, `RestartInterval` 1 minute |
| Time limit | `ExecutionTimeLimit` zero (the default of three days would stop the server) |
| Other | allowed on batteries, not stopped on batteries, `MultipleInstances IgnoreNew` |
| Action | `deploy/run.cmd`, working directory the project root |

If `nssm.exe` is on the PATH, `install` creates a real service instead (auto start, `AppDirectory` the root, `PORT`/`HOST`/`NODE_ENV=production` in `AppEnvironmentExtra`, stdout and stderr to the log, `AppStopMethodConsole 5000`, restart on exit). `status` reports whichever backend is installed. The NSSM path and task registration were written but not tested on this machine.

**The launcher.** `install` writes `deploy/run.cmd`: `cd /d <root>`, `set PORT`, `set HOST`, `set NODE_ENV=production`, then `"<node.exe>" server.js >> logs\service.log 2>&1`. As environment variables, `PORT` and `HOST` override `.env`. `logs` prints the last 40 lines of the log.

**Verification against the server, not Windows.** A task reports Running as soon as it launches anything, so every verb polls `GET http://127.0.0.1:<port>/healthz`: `install` and `start` wait up to 25 s (and `install` warns if `chronicle` is false), `stop` waits up to 15 s for silence, and `restart` compares pids, warning "it never actually went down" if unchanged.

**Stopping a task.** `Stop-ScheduledTask` ends `run.cmd`, not necessarily node, so the script attaches to the console of whoever listens on the port and sends `CTRL_C_EVENT` (the helper is named `Send-CtrlBreak`; CTRL_C is used because the sender can deafen itself to CTRL_C only, and an earlier CTRL_BREAK version killed the restarting PowerShell), waits 1.2 s, then `Stop-Process -Force`s anything still listening.

**Building.** `install` compiles both projects through `node_modules/typescript/bin/tsc` and installs nothing if either fails. `run.cmd` deliberately does not build (a failed build at boot would leave no service), and `restart` does not build either.

**Other notes.** Run `npm install` in the checkout first. `install` warns when `-Bind` is not `127.0.0.1`, because `DELETE /api/data`, `/api/state` and `/api/worlds` are unauthenticated. `uninstall` leaves `chronicle.db` and `logs/` alone. `service.ps1` must stay UTF-8 with a BOM and an ASCII body (PowerShell 5.1 reads BOM-less scripts as ANSI).

Guaranteed by tests: the service never sets `DEV_RELOAD` (so no reload snippet or stream in production).

### Updating a running deployment

The working rule after every change that is committed:

```powershell
npm run build; if ($?) { npm run service:restart }   # from an elevated shell
```

The restart is gated on the build exiting 0. An ungated restart after a failed build once took the service down: the service runs whatever `server.js` and `dist/` are on disk. After restarting, confirm the page serves the new commit, e.g. that `GET /` on port 8089 contains `window.__VERSION__ = {"version":"1.0.<count>","commit":"<new short hash>"}`, or open the `?` card's About box. After pulling a new `humans-threejs` model, `npm run model` before restarting.

## Performance architecture

### Two paths through the world

The world advances on two paths that must owe and pay the same things:

- **The drawn frame**, `tick()` in `src/main.ts`, driven by `requestAnimationFrame`. It advances the world by `real * rate` (real delta clamped to 0.1 s; `RATES = [0.25, 0.5, 1, 2, 4, 8, 16]`), moves things by `paced = min(dt * pace(), PACE_MAX_STEP)` (0.25), and does everything visual: camera, grass tiles (3 dirty tiles a frame), animals, people, bubbles, camps, sky, audio, map, HUD, `drawCrowd()`, `renderer.render`.
- **The world step**, `stepWorld(dt)`. It sets `drawingWorld` false, ticks `worldStep`, advances the clock, moves only the sun direction, runs animals, season, the books and `updatePeople`, and skips everything that exists only to be seen (matrix writes, scenery, smoke, birdsong, camera, grass). Night skip, Run years and background running all call it with `dt = ffStep()`.

`FF_STEP = 0.5` is a distance, not a duration: `ffStep() = FF_STEP / pace()`, so `dt * pace()` is exactly `FF_STEP` and the movement clamp inside `stepWorld` never bites. A longer day therefore costs no extra steps for the same fidelity.

**The books.** Eating, ageing, illness, births, deaths, spoilage, fruit regrowth, livestock, society, border tension, trade ties and city draw integrate over elapsed days and run every `BOOK_EVERY = 1/8` simulated day on both paths (`bookDue += simDays` appears twice). They used to run every step, 7,200 times a simulated day at half-second steps, which cost about 900 times as much for the same result. One asymmetry at HEAD: `recoverForage(owed)` (picked-over forage ground growing back) is called only in `stepWorld`'s books, not in `tick`'s, so that recovery happens only during unwatched steps (night skip, Run years, background).

**Turn order.** `tickWorldStep()` runs on both paths, before anybody reads whose turn it is. When it ran only in `stepWorld`, a watched world past 24 people walked the same slice for ever: measured on a fresh world of 121, 95 people who should have been on screen and 24 with a matrix; after the fix 88 of 88.

Guaranteed by tests ("running the world on", "not everything, every step"): one step separate from drawing that runs the real simulation with no profiling scaffolding; the sun still moves; the step is a distance; nothing is drawn while running unwatched and neither scenery nor bodies are written; `tickWorldStep` has exactly two call sites, both before `updatePeople`; `cityDraw(owed)` is called on both paths.

### Level of detail: turn-taking strides

Measured when introduced: a simulated year took 111 s, 84 of them the herds (about 200 animals deciding 172,800 times each), 14 people and 11 everything else. So populations take turns: each step one group goes, with the time the whole group waited (`slice = dt * stride`), and the loops start at `turnStart(stride)` and step over the rest.

| `LOD` field | Value | Meaning |
|---|---|---|
| `from` | 24 | At or below this count, everybody goes every step. |
| `most` | 64 | Unwatched cap on a person stride (1,000 people cost what about 15 did). |
| `herdCoarser` | 6 | Unwatched animal groups are this much larger than people's. |
| `watchedMost` | 8 | Watched cap. |

- `lodStride(n)` = 1 if `n <= 24`, else `min(cap, ceil(n / 24))`, where `cap` is `watchedMost` while drawing and `most` otherwise.
- `herdStride(n)`: while drawing, `lodStride(n)`; unwatched, `min(64 * 6, ceil(n / 24) * 6)`. `n` is every animal on the map, not one herd.
- Predators and mounts (`spec.predator || spec.mount`) are never grouped: a tiger in a grouped step covers 30 m and walks through its prey, and a horse must not lag its rider.
- The person the Follow camera is locked to is never grouped and gets `dt` every frame; everybody else steps half as often at stride 8, which is the judder the cap bounds.
- `watchedMost` went from 4 to 8 (commit "A crowd takes its turns twice as coarsely while you are watching"): at 445 people a stride of 4 still writes 111 figures a frame, 8 writes 56.

Guaranteed by tests: the group size grows with the crowd; small worlds run everybody; a watched world is grouped gently, `watchedMost` between 2 and 8 and below `most`; `most` at least 32; predators and ridden horses never grouped; herds coarser than people.

### Frame cap

`MAX_FPS` (default 30) caps drawn frames. `frameCap()` returns `P.maxFps`, or `min(P.maxFps, FPS_UNFOCUSED)` with `FPS_UNFOCUSED = 10` when `document.hasFocus()` is false (a visible window on a second screen). A frame arriving sooner than `1000 / cap - FRAME_SLACK_MS` (1 ms) after the last drawn one returns immediately; the clock is read on the next frame that runs, so no world time is lost. Run years is never capped (`const cap = ahead ? 0 : frameCap()`). `MAX_FPS=0` draws every refresh. The boot harness sets `maxFps: 0` because it drives frames 16 ms apart on a fake clock.

Measured with the same commit ("The battery", at 9,000 people): the person-choosing code counted sick camp members by walking every person twice per chooser; a CPU profile put `chooseJob` at 20.5% and `campIsIll` at 4.1% of step self time. Counting the sick per camp once per world step (`src/ill.ts`, invalidated on falling ill, recovering and restore) took one simulation step from 5.62 ms to 1.98 ms (9,000 people, 41 camps, 4,800 m map, headless bench).

Guaranteed by tests ("the battery"): the ill count is cached per `worldStep` and invalidated in at least three places; an early frame does nothing; 30 by default and `FPS_UNFOCUSED` in the background.

### Night skip

`clockRate()` evaluates `nightIdle()` every frame and shows the skip badge. The night is idle when `NIGHT_SKIP` is on and the sun is below `NIGHT_FROM`, and either nobody is alive, the sun is below `min(NIGHT_DEEP, NIGHT_FROM)`, or every awake person is within their camp's reach. While skipping, `tick` runs `stepWorld(ffStep())` in a loop until the night ends or `NIGHT_BUDGET * (nightSkipRate / NIGHT_SKIP_BASE)` ms have passed (`NIGHT_BUDGET = 10`, `NIGHT_SKIP_BASE = 6`, so 10 ms of each frame by default), and then applies no frame `dt`, so the world is not advanced twice. The frame still renders.

This replaced multiplying `dt` by the rate, which broke past about 15x because movement was clamped by `PACE_MAX_STEP` while the books were not: at 60x a band took a whole night's hunger and a quarter of a night's rest. Measured in the first commit that moved to world steps: 5,910 frames of night became 82.

Guaranteed by tests ("the night"): on by default; rate, near and deep ends are settings with the old hard-coded defaults; nothing skipped in daylight; deep night runs regardless; the far end never above the near; stragglers hold only the edges of the night; an empty world does not wait; run in world steps at `ffStep` inside a budget; the frame does not move the world again; the screen says when it runs.

### Run years

`seeAhead(years)` clamps years to 1–50 and plans `round(years * YEAR_LENGTH * DAY_LENGTH / ffStep())` steps (69,120 a year at the defaults). While it runs every frame goes to `runAhead()`, which calls `stepWorld(ffStep())` until `AHEAD_BUDGET` (20 ms of `Date.now`, since the harness fakes `performance.now`) is spent, then updates the progress bar, head and camp counts and a time estimate measured in steps. The chart and milestone log (optionally one tribe) redraw at most every `AHEAD_DRAW_EVERY` (250 ms) and always on the last slice. Stop (button or Escape) acknowledges at once; the overlay comes down one frame before `refreshViews()` rebuilds every view and saves, because refilling the grass alone takes about a quarter of a second at high quality. `main.ts` records about seven seconds of real time per simulated year when it was written.

Guaranteed by tests ("running the world on", "watching the years pass"): asking twice does not start two; years are bounded; slices with a wall-clock budget; nothing drawn; stoppable, including by Escape, with the same tidy-up as finishing; the overlay comes down first; the estimate is measured and arrives after the first slice; every view is rebuilt, including the clock; the chart and log redraw throttled but always on the last slice; the log is milestones only and can be narrowed to one tribe.

### Crowd drawing

`src/crowd.ts` separates the record from the picture. The instanced person meshes built by `people.ts` (body parts by person index) and `looks.ts` (garments packed by wearer) are still where `writePerson` puts every figure, but they are set `visible = false`. Once a frame, immediately before `renderer.render`, `drawCrowd()`:

1. keeps a drawn copy of each record mesh (`crowd:<name>`, `crowd:<name>-far`), remade when a record is replaced (new island, grown room);
2. culls each visible person against the camera frustum with a 2.2 m sphere (`CROWD.reach`) around their head matrix;
3. copies their parts into the near set within `CROWD.near` (60 m), otherwise into the far set, which keeps only `head, upperArm, foreArm, thigh, shin, spear, load, basket` as six-sided rods or coarse balls fitted to each part's bounding box;
4. copies in-view wearers of each garment list, dropping `face`, `band` and `tool` for far figures;
5. skips parked (all-zero) instances, packs to the front and uploads only the used range.

Measured on one frame of a 2,500-person island (headless, renderer stubbed): the body went from 6.29 M to 0.25 M triangles and the scene from about 9 M (7.7 M in people, 6.8 M of it drawn twice for shadows) to 2.1 M, 1.24 M of it in shadows; with everybody inside 60 m, culling and parking alone bring the body to 2.24 M. The copy costs a fraction of a millisecond; the simulation step at that size was 0.74 ms. The copies are renamed because boot checks find parts by name and the last mesh with a name wins. Not verified in a browser.

Guaranteed by tests ("drawing a crowd"): the record is not drawn; copies use another name; frustum culling; parked slots skipped; `CROWD.near` between 30 and 150 with no hands, feet or neck in the far set; `drawCrowd()` immediately precedes `renderer.render(scene, camera)`.

### Running in a background tab

A hidden tab receives no animation frames, and a hidden page's own timers are throttled to once a second, later once a minute. `src/background.ts` therefore creates a Worker from a Blob whose only job is `setInterval(() => postMessage(0), 50)`; each message runs a slice on the page, where the world lives.

| `BACKGROUND` field | Value | Meaning |
|---|---|---|
| `every` | 50 ms | Worker tick interval. |
| `budget` | 20 ms | Simulation per tick: two fifths of one core. |
| `save` | 15,000 ms | `persistState()` interval while running hidden. |
| `worth` | 0.02 sim-days | Minimum run before the return is announced. |

`runInBackground` starts on `visibilitychange` to hidden (when `P.background`) and stops on visible; it does nothing for a `?watch=` page or without `document`/`Worker`. A slice runs `stepWorld(ffStep())` for the budget, or continues a Run years in progress. `tick()` returns early while `backgroundRunning()`, so nothing is stepped twice. On return the worker is terminated and, past `worth`, `refreshViews()` runs once and a toast says how long went by.

Measured headless with a faked Worker and visibility event on the real modules, 200 people: 4 s hidden advanced 0.68 simulated days (0.17 a second, a 24-day year in a little over two minutes), the world was saved while hidden, and with `BACKGROUND=false` a hidden second moved it 0. Not tried in a real browser tab, where worker timing is what matters.

Guaranteed by tests ("a tab in the background"): starts on hidden when enabled, stops on visible and announces; ticks come from a Blob Worker and it is terminated; `budget / every <= 0.5`; periodic saves; a Run years carries on and a watched island is not run; `tick` returns early while running; `BACKGROUND` is a bool setting defaulting to true.

### The server-push spike

Asked whether the simulation should move to the server so the browser only renders, the project answered with measurement rather than a rewrite. `spike/headless.mjs` boots the real `dist/` modules in Node with a stubbed `WebGLRenderer`, `OrbitControls`, `Sky` and a GLTFLoader that always fails, against a throwaway proxy DOM (the same technique as `test-boot.js`, in its own temp directory so it cannot disturb the checks). It needs `vendor/three.module.js`, `node_modules/humans-threejs` and a built `dist/`.

- `spike/sim-headless.mjs` (`PEOPLE`, `CAMPS`, `STEPS`) times `stepWorld(1/30)`. Measured: 60 people 0.09 ms a step (about 11,000 a second), 445 people 0.15 ms (about 6,700 a second), boot about 0.66 s. The browser at 445 people ran at about 35 fps (a 28.6 ms frame), so the whole simulation was under 1% of a frame; moving it would return 150 microseconds and add serialising, transfer and interpolation, and be a rewrite (26 of 50 modules import three, and the same files grow people and paint them).
- `spike/sim-push.mjs` (`PORT` 8100, `PEOPLE` 120, `CAMPS` 8, `STEP_HZ` 30, `SEND_HZ` 15) owns an island, steps it on a timer, and serves `/health` and `/stream` (SSE): one `hello` event `{ seed, map, camps, sendHz }`, then frames `{ t, n, p: [[id, x, z, yaw, phase, flags], ...] }` (flags: asleep 1, hidden 2, child 4, carrying 8). Terrain and camps come off the seed on the viewer, so only people cross the wire. Measured: up in 677 ms with 120 people and 3 camps, about 3,900 bytes a frame (33 a person), extrapolating to 14.5 KB a frame and 1.7 Mbit/s at 445 people and 15 Hz. Read-only: no orders, chronicle or saving.
- `?watch=http://127.0.0.1:8100/stream` makes the page a viewer: it builds its own island from its seed, warns if the `hello` seed differs, applies positions by id, and passes `updatePeople` a paced delta of 0 so it draws without moving anybody. Background running is off for a watching page. Not verified in a browser.

Conclusion recorded in the commits: a server can own the island, which buys a world that keeps going with no tab open and several viewers of one world, but not frame rate, because drawing is the cost.

## Testing

### The fast suite: `node test.js`

1,968 checks at HEAD, 0 failed, in about 1.5 s wall time on the development machine including Node start-up (`CLAUDE.md`'s "0.35 s, 938 checks" predates most of them). It imports `config.js`, so the Node project must be built; it reads `dist/`, so the page must be built too. Output is a list of group names, then `N passed, M failed` and one `FAIL label — detail` line per failure; exit code 1 on any failure.

How it reads the code:

- All files are read through a CRLF-to-LF wrapper, because the regexes contain `\n` and a Windows checkout once failed 29 correct checks.
- `moduleSource(f)`: the file on disk (`society.js` is found as `society.ts`) with a leading `export ` stripped from declarations. Most checks quote code against this, singly or in the concatenations `html` (index.html plus all modules) and `script` (modules only).
- `rawSource(f)` / `rawSources`: the same with `export` kept, for module-boundary checks (line ceiling, load-time wiring, setters).
- `built(f)`: the compiled `dist/` file, `export ` stripped, for checks that **run** code with `new Function` (TypeScript syntax does not run, and tsc's re-indented output must not be quoted). Examples: the `P`/`QUALITY`/`applyInjectedConfig` block from `dist/params.js` runs to verify every schema path; `footprint` placement runs twenty layouts of fifty tents; role assignment, `placeName`, `bagWords`, creek smoothing, lake sizing and energy rates run in isolation; one check runs the built `walls.js` against a made-up town.
- `INDEX_HTML`, `SRC_DIR` and `BUILD_DIR` point the suite at copies, so mutation testing never touches the working tree.

Measured facts are pinned as ranges or recomputed from source rather than copied (`TENT_REACH` from the layout arithmetic, the save limit from row shapes, skill-table levels from `FARM`, `CONQUEST` and `SKILL_STEPS`).

### The boot check: `node test-boot.js`

It boots the page for real in Node:

- Requires `node_modules/humans-threejs` (exit 1 if missing) and three.js at `THREE_PATH` (default `vendor/three.module.js`; if missing it prints a `curl` command for `three@0.169.0` and exits 0 as skipped).
- Copies `dist/*.js` into a temp directory, rewriting imports of `three` (a stub whose `WebGLRenderer` records the scene), `OrbitControls`, `Sky`, `GLTFLoader` and `humans-threejs/human-parts.js`. With `vendor/models/` present models load through the real loader; otherwise every load fails and the fallback is exercised (the case here, so checks inside `if (modelsVendored)` do not run).
- Mocks the DOM from the markup (ids, initial `hidden`, initial text) and `fetch` (a fixed saved session at `GET /api/state`, everything else rejected); there is no `localStorage`.
- Makes a run repeatable: seeded `Math.random`; `Date.now` advancing 1 ms per 9 reads (the 20 ms Run years budget becomes about 180 steps on any machine); a harness-driven `performance.now`; `requestAnimationFrame` parked after the boot frames so `stepFrame(ms)` drives exactly one frame.
- Injects `{ models: 'all', fertility: 3, maxFps: 0 }` plus `BOOT_CONFIG` (JSON setting paths, e.g. `{"counts.tigers":0}` or `{"seed":33}`).
- Drives the page through the handlers a person would use, about 340 checks: views and keys, restore, world shelf, clock rates really moving the world 4x, night skip, band cards, chronicle paging and search, Run years and Stop, Delete everything, leading and orders, E actions, carrying, eating, hunting, rafts, map layers and travel, fires and granaries, wardrobe, path wear, outskirts, a city made on purpose, bubbles, and mesh growth last.

Switches:

| Variable | Effect |
|---|---|
| `QUICK=1` | Skip every probe (about 50 s instead of about 13 minutes). |
| `PROBES=a,b` | Run only the named probes: `repeat` (fingerprints after three one-year runs, plus `MARK` lines for diffing), `curve` (population and food per year), `starve`, `gen` (deepest generation), `visit` (arrivals at neighbours), `survive` (the death `TOLL` by cause from the lineage). |
| `ONLY_PROBES=1` | Every check becomes a no-op and only the boot frames and the probes run. |
| `BOOT_CONFIG` | JSON setting paths for the booted world. |
| `THREE_PATH`, `INDEX_HTML`, `SRC_DIR`, `BUILD_DIR` | Alternative three.js, page, source (shape checks) and build (what is imported). |
| `AB` | A label printed in the `SURVIVE`/`TOLL` lines. |

At the end it prints forage, face, F-pick, E and order-row reports and one `FAILED — label` per failure, and exits 1 if anything failed or the page asked for an element that does not exist.

### Rules for running and comparing (`CLAUDE.md`)

- **Run the fast suite, report, stop.** `node test.js` is the default. `QUICK=1 node test-boot.js` (about 50 s) only when a change touches boot or the DOM. The full boot check (about 13 minutes) and `ONLY_PROBES=1 PROBES=curve` (minutes, simulates years) need the owner's agreement first. No sweeps: no A/B matrices of `.env` settings, no bisecting with the full boot check, no multi-seed batches. Note that `npm test` includes the full boot check.
- **Probe results are not comparable between two versions.** The pinned `Math.random` makes one tree repeatable, but the probed world's seed is minted after the build, and three draws `Math.random` four times per UUID (every geometry, material, texture), so one extra allocation moves every probe to a different island. Measured on an untouched tree: four extra `Math.random()` calls in `buildWorld` turned a three-year population curve of 16→25→35 into 16→16→16, and eight into 16→26→33, with identical simulation. `CURVE`, `TOLL`, `GEN` and `VISIT` output is a fact about one tree; reseeding does not help.
- **Show a change is inert by switching it off.** Run the page against itself with the behaviour disabled and the same allocations. The commits do this by editing the built `dist/` to restore the old behaviour (e.g. `pitch()` off, or the old taming odds) and checking that the QUICK boot check then fails exactly the previous list. New meshes are created lazily, when first needed, partly so a feature does not draw `Math.random` at build and move the island.
- **Pre-existing failures.** The boot check exits 1 on an untouched tree, so compare failure lists, not exit codes, and ignore incidental numbers in detail text (the blade count moves with grass scattering). The known list has ranged from three to seven entries as the probed island shifted and currently stands at six, typically checks about whether a measurement had anything to measure ("somebody covers real ground", "there was somebody indoors to pick by mistake").
- **Anything that awaits goes after the last check that does not.** The page boots through nested frames and promise chains, so an `await` or a frame-driving check placed among other checks shifts what the later checks see; allocating checks sit at the end for the same reason.

### Headless measurement from the commits

Behaviour changes are measured with `bootWorld` from `spike/headless.mjs` rather than in a browser or with the boot check's probes:

```js
import { bootWorld } from './spike/headless.mjs';
const { main, people, life, params, load, bootMs } =
  await bootWorld({ people: 160, camps: 12, abundance: 3, map: 1500, seed: 7, yearLength: 4 });
const step = (await load('clock.js')).ffStep();
for (let i = 0; i < N; i++) main.stepWorld(step);
```

`bootWorld` sets `window.__CONFIG__` from its arguments (`people`, `camps`, `abundance` default 3, `map` default 1500, optional `seed`, any other setting path passed through), imports the stubbed `main`, `people`, `life` and `params`, drains eight rounds of animation frames so the world is built, and then stops the frame queue so the caller owns every step. `load(name)` imports any other module from the same instance, which is how commits reach internal state (a city made on purpose, a faked Worker and visibility event, a border effect zeroed after boot). Run it from the project root.

Pitfalls recorded in the commits: step with `ffStep()`, because a larger hand-picked `dt` loses movement at the clamp while the books run on, and a very short day starves everybody unless pace scales with it (both produced empty islands that looked like results); one island and one seed is one sample, so differences in, say, sickness between two runs may be divergence rather than cause; and the GPU side of a frame is not measured headless, which is why several features are recorded as "not seen in a browser".
