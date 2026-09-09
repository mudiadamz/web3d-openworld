# Working on this repo

## Do not run the slow checks

`npm test` is two suites and they are three orders of magnitude apart in cost:

| command | cost | when |
|---|---|---|
| `node test.js` | **0.35s**, 938 checks | default — run this |
| `QUICK=1 node test-boot.js` | ~50s | only when the change touches boot or the DOM |
| `node test-boot.js` | **~13 min** | ask first |
| `ONLY_PROBES=1 PROBES=curve node test-boot.js` | minutes, simulates years | ask first |

Run the fast suite, report, stop. If a change genuinely needs a slow one, say so
in a line and let me decide. Never start a multi-minute run and report back
later as though the wait were free, and never run a sweep of them — no A/B
matrices of `.env` settings, no bisecting with the full boot check.

Waiting is the dominant cost of a session and it buys nothing the fast suite did
not already say. One task spent two and a half hours this way, most of it
chasing a failure that turned out to be the harness measuring a different
island — see below.

## Boot-check probe results are not comparable between two versions

`test-boot.js` pins `Math.random` so a run repeats. It does not make two
*different* trees comparable: the world the probes measure is one the page mints
for itself with a random seed, and three calls `Math.random` four times per UUID
— once per geometry, per material, per texture. Allocate one more object
anywhere on the way and every probe lands on a different island.

Measured on an untouched tree: four extra `Math.random()` calls in `buildWorld`
take a three-year population curve from 16→25→35 to 16→16→16, and eight take it
to 16→26→33. The simulation was identical both times.

So `CURVE`, `TOLL`, `GEN` and `VISIT` output is a fact about one tree, not a
number to diff against another. To show a change is inert, run the page against
*itself* with the change switched off — same allocations, same island.
Reseeding before the probes does not fix it; the seed is minted after a world is
built, and building one draws once per object in it.

## Six failures in the boot check are pre-existing

`node test-boot.js` exits 1 on an untouched tree. Compare failure *lists*, not
exit codes, and ignore incidental numbers inside a failure's detail text — the
blade count moves whenever grass scattering changes.

## Anything that awaits belongs after the last check that does not

The page boots through nested animation frames and a couple of promise chains,
so an `await` dropped in among the checks in `test-boot.js` lets more of that
run than the checks below it were written against. The same goes for a check
that drives frames: the world does not stop while you are looking at it. Both
have moved unrelated failures. Put anything that awaits, or drives time, after
everything that does not.
