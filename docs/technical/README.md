# Technical documentation

The reference for how Open World Sandbox is built and what it does, feature by
feature, down to the constants. The project `README.md` is the design journal:
why things are the way they are, in the order they were decided. This is the
other half: what is there now, how it works, and what the tests promise about
it.

It was written from three sources, and checked against a fourth:

- **Every commit message**, oldest first (86 commits up to `5751a50`,
  2026-09-17). The commits say what was built, what was measured and what went
  wrong on the way. Measured numbers quoted from them are labelled as measured.
- **The fast test suite**, `test.js`: 1,968 checks in 124 groups. Where a
  feature has a check behind it, the documentation says what the check
  guarantees.
- **The boot check**, `test-boot.js`: the page booted headless against a
  stubbed renderer and DOM, with its checks and its long probes.
- **The current source**, which wins wherever it disagrees with a commit. Every
  constant quoted here was read from `src/*.ts`, `server.ts`, `db.ts`,
  `config.ts` and `index.html` as they stand at version 1.0.86.

## Contents

1. [Architecture and operations](1-architecture.md): repository layout, the
   build, the server and its API, the database, every setting, the Windows
   service and versioning, the performance design (world steps, LOD, crowd
   drawing, night skip, Run years, background tabs, the server-push spike), and
   both test suites with the rules for running them.
2. [The natural world](2-natural-world.md): seeds and determinism, terrain,
   water, sky, time, seasons and weather, vegetation, ore, the wear field under
   paths and roads, every animal species, the tiger, and horses as wildlife.
3. [People and daily life](3-people.md): a person from birth to burial, bodies
   and clothing, energy, hunger and sickness, the food economy, carrying,
   movement through walls, gates and along roads, every errand and how it is
   chosen, and the trades: fishing and rafts, wood, farming, quarrying,
   exploring, markets, visits and lessons.
4. [Society and settlements](4-society.md): bands and tribes, the 22 skills and
   how they are learned and forgotten, roles, the stages from band to city,
   contact between bands (visits, ties, joining, border tension, raids,
   conquest), horses and mounted patrols, and settlement layout from a camp's
   tents to a walled city's streets, gates and road network.
5. [Playing: views, controls, interface and saves](5-playing.md): Orbit, Follow
   and over the shoulder, steering a person, the HUD and every panel and card,
   phones and touch, role play mode, worlds and saving, and a complete keyboard
   reference.

## The features, in brief

**An island that runs itself.** A seed builds terrain, creeks, lakes, forests,
grass, flowers, orchards, thickets and ore outcrops, lit by a physical sky on a
running clock with seasons, wind and weather. Six kinds of animal graze, flee,
breed back and hunt: bison, deer, rabbits, boar that eat the orchards, tigers
that hunt the herds and people, and wild horses. Birds and butterflies fly over
it.

**People who live on it.** A few hundred to a few thousand people, each with a
body, a build, clothes, a temper, a family and a line. They forage, hunt with
thrown spears, carry what they can, bring it home to a store that spoils, eat,
tire, fall ill, nurse each other, sleep, age and die, and are buried in a
graveyard that grows. Their feet wear paths into the grass that other walkers
follow.

**Bands that learn and grow.** Twenty-two skills, from knapping to horse
riding, each moving a number the simulation already has, learned by doing,
capped by what the living remember, and forgotten when nobody practises. Bands
take on roles once they can afford them, and climb from band to tribe,
chiefdom, village and city. Tents become lodges, then houses, then streets of
townhouses behind a wall with two gates and a road network branching out to
the tribe's villages, field and quarry.

**Bands that meet.** Visits carry food, stone and knowledge; bands that keep
dealing tie together until the smaller one joins; hungry bands raid, borders
teach fighting, and a band that can rule takes villages. Cities keep mounted
patrols riding their bounds, which makes them harder to raid.

**Ways to watch and play.** Orbit over the island or follow one person, steer
them, send them on errands, and read their band's card, its skills, its dead
and its history. Run years unwatched, leave the tab in the background and come
back to what happened, or turn on role play and be one person, with a
character sheet, levels, goals and achievements. It works on a phone.

**One page and an optional server.** The page is TypeScript compiled to ES
modules and runs on its own. The Node server adds settings from `.env`, a
SQLite chronicle of every world, a save that survives the browser, and a
version number that moves with every commit. It runs as a Windows service.

## Problems found while writing this

Reading the whole of the source against the commits and the tests turned up the
following. The first was confirmed against the running service. "Checked in source" means the
code was read again and says what the row says; nothing below it has been
reproduced by running the page.

| Where | What | Status |
|---|---|---|
| `server.ts`, static files | The static handler refuses paths outside the project folder but serves anything inside it: `/.env`, `/chronicle.db` and `/server.ts` all answer 200 from the running service. It should serve only what the page loads. | Confirmed |
| `src/main.ts` | `recoverForage` is only called from `stepWorld`, not from the drawn frame, so picked-over ground only recovers during night skip, Run years or a background tab. | Checked in source |
| `src/wildlife.ts` | When a GLTF model finishes loading, `rebuildFauna` rebuilds every herd from the seed, which looks like it undoes restored herd counts and tamed horses. | Read only |
| `src/life.ts` | Tigers and horses are not in `QUARRY`, so neither ever breeds back; wild horses only ever decrease as bands tame them. | Read only |
| `src/move.ts` | `farm` is missing from `OUTDOOR_JOBS`, so a farmer inside a settlement's reach counts as indoors and is not drawn. | Checked in source |
| `src/life.ts`, `arriveAtCamp` | The sickness check asks `host.people` for somebody ill, and `layoutCamp` leaves that list empty, so the condition is always true. | Checked in source |
| `src/ui.ts`, touch rail | The phone's `band` button calls `openTribe(tribeShown \|\| 0)`, which is -1 while the card is shut, so it opens nothing. | Read only |
| `src/roleplay.ts` | The goal "Go 400 m from your fire" can never finish if it is dealt after the character has already been 400 m out: its baseline is already 1. | Read only |
| `src/skills.ts` | The mastery rung needs 1.02 and practice stops at 1.0, so mastery is never announced and the winter cloak is never sewn. | Known |
| `src/life.ts` | Founders have no parents, and their boldness never reaches the 1.15 that exploring needs, so no founder explores. | Read only |
| `server.ts`, `CHRONICLE_DB` | An absolute database path is joined under the project root; `reset.ts` handles an absolute path and the server does not. | Read only |
| `deploy/service.ps1` | `Send-CtrlBreak` sends CTRL_C rather than CTRL_BREAK. | Read only |
| `CLAUDE.md` | Still says the fast suite is "938 checks, 0.35s"; it is 1,968 checks. | Out of date |

Each section also ends with the smaller oddities its author noticed: values that
are never read, timers that are not saved, and places where a comment and the
code disagree.
