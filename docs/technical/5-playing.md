# Playing: views, controls, interface and saves

[Technical documentation](README.md)

This section covers what a player touches: the two camera views, steering one person, the HUD and panels, the phone layout, role play, and how worlds are saved. It follows the current source, mainly:

- `src/chronicle.ts`: views, following, leading, keys, the order row, the band card, the chronicle window, the act prompt and the basket
- `src/ui.ts`: panel, worlds, clock rate, touch rail, reset and delete, toasts, version
- `src/map.ts`, `src/save.ts`, `src/main.ts`, `src/roleplay.ts`, `src/reach.ts`, `src/danger.ts`, `src/vitals.ts`, `src/bubbles.ts`, `src/kin.ts`
- `index.html`: markup and CSS

"Tests:" lines name what the checks guarantee. The fast suite is `node test.js`, which mostly pins source text and runs some logic headless. The boot check is `test-boot.js`, which loads the real modules into a DOM, drives frames and presses keys; its checks are marked "boot". Most touch behaviour has never been rendered on a device (see [Unverified on a device](#unverified-on-a-device)).

---

## 1. Views

### Orbit and Follow

There are exactly two views, `VIEW_MODES = ['orbit', 'follow']` (`src/move.ts`), named by `VIEW_NAMES` (`src/ui.ts`):

| View | What it is | Camera code |
|---|---|---|
| **Orbit** | A rig you point at a place. Drag orbits the pivot and the wheel zooms (three.js `OrbitControls`). WASD slides the rig across the ground. | `moveOrbit` |
| **Follow** | A person you go with. The camera sits behind their head and eases after them. | `moveFollow` |

The view at boot is `P.view` (`VIEW=orbit|follow`, default `orbit`). The old Fly and Walk views were removed; clicking the map does their job.

Every change of view goes through `setViewMode(mode)` (`src/chronicle.ts`), which:
1. Forces `'follow'` when `P.roleplay` is on.
2. Calls `releaseLead(false)` for any mode other than Follow. Whoever was being walked by hand is let go, whatever the way out: C, R, the map or the rail.
3. For Orbit, puts the pivot 25 m ahead of the current view, so the switch does not spin the world.
4. For Follow, disables the controls and calls `pickFollow(false)`.
5. Updates the view name on the keys card (`#keysView`) and the follow caption.

**C** (or the rail's `view` button) cycles the two views and toasts the name of the view it lands on.

Tests: there are two views; the panel names both and nothing else; the environment refuses a removed view; travelling lands one rig, not four. Boot: cycling says which view it landed on; C leaves Follow and F comes straight back.

### The Follow camera: over the shoulder

Every way into Follow starts the camera at `SHOULDER = { pitch: -0.12, dist: 4.5 }`, with `cam.yaw` set to the person's heading and the shoulder lock (`cam.astern`) on. Each frame, `moveFollow`:

- **Keeps station.** While the lock is on and they are not being walked with the keys, the yaw eases toward their heading at `ASTERN_EASE = 1.8`/s. It turns the short way across the compass seam, so a sidestep round a rock is ignored and a real turn is followed within a couple of steps.
- **Places the camera.** It aims at their eye height (allowing for crouching, or being up a tree), lerps there at `dt·6`, and never goes below 0.5 m above the ground.
- **Hands over from a sleeper.** If the person was found by F (`followChosen` false) and is asleep while somebody else on the island is awake, it switches to an awake person. Somebody you chose by name or click is never swapped.

Controls in Follow:

| Input | Effect |
|---|---|
| **Drag** | Turns the camera (`LOOK_SENSITIVITY = 0.0026` rad/px, pitch within ±`PITCH_LIMIT = 1.5`) and releases the shoulder lock. |
| **Wheel** / pinch | Moves you nearer or further: ×1.12 a notch, clamped to 1.4–40 m. The lock stays. |
| **V** (`shoulderView`) | Restores `SHOULDER` and the lock. Toasts "over the shoulder", or "nobody to stand behind". |
| **WASD** | While held, the camera holds its bearing. Otherwise S would turn them, which turns the camera, which turns them again. |

The cursor is a crosshair in Follow, the one view where a click on the ground means something.

Tests: V restores the shoulder, and that view has one definition. The camera keeps station as they walk. Dragging releases the lock and the wheel does not. The ease is a real rate that takes the short way round. Somebody you chose is not handed away while indoors.

### Picking somebody: F, shift+F, names

**F** (`pickFollow`) enters Follow from Orbit (entering picks somebody), or picks somebody else once in it. The pick is random from the first pool that is not empty, never including the person you are already behind:

1. Visible people on a raid, the rarest thing on the island.
2. Visible adults whose job is not in `IDLE_JOBS = {play, tend, sleep}`. `nurse` is deliberately not idle.
3. Anybody visible.
4. Anybody awake.
5. Anybody at all.

"Visible" means `p.hidden` is false. The draw loop sets that flag, so F does not land on somebody inside a tent.

**shift+F** (`followBack`) steps back along `followTrail`:
- The trail holds person ids, at most `FOLLOW_TRAIL_MAX = 12` and no duplicates.
- It skips the dead and the person you are on.
- Stepping back does not add the one you left, so two presses do not bounce between the same pair.
- From Orbit it enters Follow first.
- With nobody to go back to, it toasts "nobody watched before this one".

**By name:** a row on the band card's "who is here" tab calls `followPersonById`. It looks the person up by id (the card's rows are a sorted copy), closes the card, sets `followChosen`, and toasts `who(p)`, e.g. `[ND] Aro`.

Clicking a person does not follow them. In Follow, a click on the ground means "go there".

Tests: F enters Follow and finds somebody new; shift+F returns to the previous person, skips the dead, and keeps the trail bounded and free of duplicates; F prefers somebody doing something, falls back, never repeats the current person, always picks somebody, and goes to a raid first; a name on the card follows that person by id. Boot probe: F never picked a child while an adult was on an errand, nobody sitting still, and nobody indoors.

### Somewhere else: R

**R** (`pickRoam`) switches to Orbit, which releases any lead. It then tries up to `ROAM_TRIES = 60` random points spread evenly over a disc of radius `WORLD·0.42`:
- It rejects points below `SEA + 2`.
- It keeps the flattest point, stopping early at flatness above 0.9.

It sets the pivot 2.5 m above that spot and puts the camera `ROAM_HIGH = 26` m up and `ROAM_BACK = 52` m back, on a random bearing. It toasts, for example, "812m from the middle · 34m up". It uses `Math.random`, never the world's random stream.

Tests: R enters Orbit, lands on dry land inside the island, uses a new bearing each time, and draws nothing from the world stream. Boot: each spot is on the island, above the ground, and different each time.

### Keeping focus across reloads

Who you are behind is kept under `FOCUS_STORE = 'openworld.focus'` as `{ seed, view, id }`:
- **Writing.** `keepFocus()` runs every frame but writes only when one of the three values changes. It does not wait for the ten-second autosave, so a refresh straight after switching still lands on the new person.
- **Restoring.** At boot, after the world is built and the view is set, `restoreFocus()` follows the same id again. It does so only if the seed matches and the saved view was `follow`.
- **Scope.** The key is per browser, like the map layers, and is not part of the world save.

Tests: focus is kept by id and seed and written only on change; it is restored only on its own island, after the world stands; a browser with nowhere to store it still boots. Boot: a refresh puts you back behind the same person.

### Camera rules in brief

| Rule | Where |
|---|---|
| Leaving Follow by any route releases a lead. It keeps a standing order, unless you leave with the rail's `view` button, which calls `handBack()` first. | `setViewMode`; touch handler in `src/ui.ts` |
| Travelling by the map lands in Orbit and shrinks a full map back to the corner. | `travelTo` |
| In Orbit, WASD moves at `CAMERA_FLY = 26` m/s × world pace; left shift ×3.6; Q/E lower and raise. | `moveOrbit` |
| The Orbit camera stays at least 2.2 m above the ground; the pivot rises with it. | `moveOrbit` |
| A click is a press that travelled ≤ `CLICK_SLOP_PX = 5` px; anything further was a look. | `pointerup` handler |
| In role play, every view request becomes Follow on the character. | `setViewMode`, `heroView` |

---

## 2. Controlling a person

All of this works only in Follow, on `followedPerson()`. No frame draws from the world's random stream. A click, key or button leaves an instruction on the person: `p.led` with `p.leadX/Z`, `p.orders`, `p.act` or `p.goingHome`. The next simulation step carries it out, which keeps a seed replayable.

### Leading by click

A click on the ground runs `pickGroundAt`:
1. It marches the camera ray out from 2 m, each step ×1.08 longer (capped at 24 m), until the ray goes under the height field, up to `GROUND_MAX = 6000` m.
2. It then bisects 24 times.
3. It rejects sky, water below `SEA + 0.5`, and anywhere past `WORLD·0.46`.

On a hit, `leadTo(x, z)` sets `p.led` and the target, and toasts "Name sets off · 42m". A new click turns them round, and arriving stops them.

While they are led and not being walked with the keys, a pulsing light-blue ring (0.55–0.9 m, `LEAD_MARK_*`) marks the destination. The ring is built only the first time it is needed; building it earlier would draw `Math.random` for its UUIDs and change the boot check's island.

While led, nothing else steers them: not dusk, not a job, not a tiger. They still tire, get hungry and can be caught.

Tests: a click on the ground means go there, only in Follow, and a drag is not a click; sky, sea and off-island are refused; they walk on their own, shift runs and is charged like any jog, a new click turns them; the ring shows only while led, is never built for a click that never happened, and survives a world rebuild. Boot: the click takes them over, they walk there, shift runs, a new point turns them, the ring is at the target.

### Walking with WASD, running with shift

`steerFollowed()` runs every frame:
- **Holding a key.** W/A/S/D (or the arrows) move them relative to the camera, W being the way it looks. The lead point is kept `STEER_AHEAD = 4` m ahead, they count as led, and any order is cleared.
- **Releasing.** The lead point drops to where they stand, so they stop and stay yours.
- **Special cases.** Up a tree (`p.climbed`) the keys do nothing. Running stands them up out of hiding. Moving ends resting.

Shift (either side) runs, whether walking by click or by WASD. It is a jog: it costs life, a heavy load slows it, and it fails near empty. Down low, WASD is a crawl at `CRAWL = 0.35` of a walk, and grazing animals do not notice them.

Tests and boot: WASD walks them the way the camera looks, releasing the keys stops them where they are, and the camera holds its bearing meanwhile.

### Letting go

| Control | Clears | Then |
|---|---|---|
| **Q** (`releaseLead`) | The lead. Also drops any act in progress, takes them down from a tree or up from cover, stops resting, and moors a raft at its dock. | They carry on naturally (`carryOn`). A load at ≥85% of what they can carry, or an animal, goes home. Otherwise fish means fishing on, wood cutting on, ore digging on, other food foraging on. Empty-handed they choose. The toast comes from `carryOnWords`, e.g. "Telok takes it home". If nobody was led: "nobody is being led". |
| **Let them carry on** button (`data-act="free"`, `handBack`) | The lead **and** any standing order. | The same natural carry-on. You stay in Follow. |
| **Go home** button (`data-act="home"`, `sendHome`) | The lead and any order. | `p.goingHome`: the ordinary walk back, to the granaries with food or their own fire without. Toast: "Name heads home". |

None of these works while they are too heavy to walk (`loadOf(p) >= carryCap(...)`). Nor does sending them on an errand. Each refuses with "too heavy to walk — put some down (G), or put it away (E)".

Tests: Q gives them back and does not also lower the Orbit camera; shift+W is running forward, not letting go; handing back drops lead and order together and keeps you behind them; going home is the ordinary walk; with a full load or an animal they go home, with room they carry on, but an order or a walk home is what they were told; too heavy to walk is too heavy to be sent anywhere. Boot: Q lets go and they pick their own errand; the row undoes an order, keeps you following, and sends them home.

### E: what is in front of them

`whatHere(p)` (`src/reach.ts`) chooses what E does, and the rings on the ground are drawn from the same answer, so the two cannot disagree. `actHere()` leaves that act on the person, led where they stand. Once it is done they are still yours. With nothing in reach, E toasts "nothing to do here".

If they carry something inside the storage area round the granaries, the answer is always **store** ("put away …"). Otherwise it is the first of these in reach:

| # | Kind | In reach when | Prompt |
|---|---|---|---|
| 1 | `fight` | a tiger is within `THROW_REACH = 16` m | "throw at the tiger" |
| 2 | `carcass` | within `CARCASS_REACH = 2.2` m × scale of something they brought down | "pick up the deer" |
| 3 | `pickup` | within `PICKUP_REACH = 1.8` m of a pile | "pick up …" |
| 4 | `moor` | on a raft, within `RAFT.reach = 4` m of its dock | "tie up at the dock" |
| 5 | `raft` | within 4 m of the landing, and the band's raft is in | "take the raft out" |
| 6 | `hunt` | the nearest prey is within 16 m | "throw at the deer · 12 m" |
| 7 | `dig` | inside a quarry's heap radius + `DIG_BUFFER = 1` m | "dig flint · 42 left" |
| 8 | `wood` | within `WOOD.reach = 2.4` m of a tree (ring shown within `WOOD.show = 9` m) | "cut wood" |
| 9 | `fish` | on a raft; there is no fishing from the bank | "fish · good deep water" (or "deep water", or "shallow — the fish are further out") |
| 10 | `tend` | within `FIRE_REACH = 2.3` m of any hearth | "tend the fire" |
| 11 | `fruit` | within `FRUIT_REACH = 3.5` m of ripe fruit | "pick fruit · N ripe" |
| 12 | `forage` | inside a berry thicket's reach | "forage · …" |

On a raft, only fishing and mooring apply.

**Rings.** For each kind with a target within `SHOW_WITHIN = 25` m, a ring goes down on the nearest one, up to `RING_MAX = 8` rings. The ring E would act on is green (`RING_ON = 0x8fd18a`), the rest straw. A tiger's ring is red unless it is the one E would act on. A separate storage ring is straw outside the granary area and green inside it, shown whenever they carry something.

The step carries out the act, and any result (such as how a throw went) is toasted a frame later.

Tests: E is left on the person for the step, and the frame that works it out draws nothing; afterwards they are still yours; the prompt says what E would do before you press it; the throw reach is one number used in both places; the green ring is what E does; E forages at a thicket and nowhere else; E throws at a tiger before anything else. Boot: the storage ring; E puts a load into the store; the raft is taken out, fished from and tied up; a tree gives logs; a throw brings an animal down where it stood, to be picked up.

### G, Z, X and N

| Key | Function | Does |
|---|---|---|
| **G** | `dropHere(false)` | Puts one handful in front of them: ten berries, five fruit, a fish, a stone or an animal. It stays as a pile and E picks it up again. A pile within 1.2 m of one of its kind joins it. Food left lying spoils after `DROP.keeps = 3` sim-days; stone, ore and wood keep. With nothing to drop: "nothing to drop". |
| **shift+G** | `dropHere(true)` | Puts everything down. |
| **Z** | `takeCover()` (`src/danger.ts`) | Within `CLIMB_REACH = 2.2` m of a tree, climbs `CLIMB_HEIGHT = 2.4` m up it; anywhere else, gets down low. Z again comes down or stands. |
| **X** | `restHere()` | Sits down to rest, or gets up. |
| **N** | `eatHere()` | Eats from the band's store at home, from the basket anywhere else. |

Each marks them led on the spot and leaves the act to the step. Each refuses while an act is already under way (Z, X and N toast "busy"). X and N also refuse while up a tree.

Tests: G drops a handful and shift+G all of it; piles are never lost, merge with their kind, food spoils and stone does not, and piles survive a reload; Z climbs a tree if there is one and goes to ground if not; X rests and N eats, with buttons for both. Boot: shift+G then walking again, G dropping a single handful, E picking a pile up, climbing up and down with Z, X down and up, N eating from the basket.

### Life, rest and food

The person you play has a life bar out of 100 (`LIFEBAR`, `src/vitals.ts`), shown under the basket. It only moves this way while they are led; once handed back, they recover at home the way the band always does.

- **Drain per second.**
  - Awake and idle: 0.0004 (full to empty in about 40 minutes).
  - Walking: +0.0012. Running: a further +0.004. Both rise with the load carried.
  - Working: +0.0008.
  - Cold: up to +0.0025, away from camp at night or in winter.
  - Illness: +0.0008.
- **Rest (X).**
  - Gains 0.002/s, or 0.005/s at home (inside the camp's reach), halved while ill.
  - Rest alone tops out at 60 away from home and 80 at home.
  - The cold keeps draining while they rest.
  - Resting at home makes an illness pass 2.5× faster.
- **Eat (N).**
  - A meal is 0.3 food units, from the store at home or the basket elsewhere.
  - It gives back up to +30 life and can fill the bar.
  - Above 97 life when already fed, it answers "not hungry".
- **Limits.** Below 20 they cannot run. Below 25 they slow, down to 35% of a walk at zero.

The bar is red below 25, amber below 50, and brown while ill. `condition()` adds a hint: "resting at home · X to get up", "worn out — eat (N) or rest (X)", "ill — rest (X)", "cold out here — get home", or, below 60, "eat (N) or rest (X)".

Tests: life is one bar out of 100 that says what to do; walking, running, working, carrying and cold wear it; running costs more than walking; rest never fills it and a meal wins more; worn down they slow and cannot run; it survives a reload.

### Carrying

A load weighs what it is (`LOAD`, `src/bag.ts`):
- A basketful of food weighs 1, a fruit 0.02, a stone 0.35, ore 0.3, a log 0.2.
- Animals: rabbit 0.3, boar 0.8, deer 0.9, bison 1.6.
- `carryCap` is 1 basket, raised by the band's baskets skill, halved for a child, and multiplied by a role play character's `carryMul`.
- A heavier load slows the person you play, by up to 70% just short of full. At or past full they cannot walk, but can still do what is in reach.

Tests: the fuller the slower, with no walking at or past full; better baskets carry more and a child half; only the person you play is weighed down, and by what is actually in the basket.

### The order row

`#orders`, bottom left, shows whenever you are following somebody (`updateOrders()`, every frame). Left to right:

1. **Fold** (`#ordersFold`): collapses the row to itself. It uses a class, never `hidden`, which is what shows the row at all.
2. **The basket readout** (`#bagHud`). See [The basket readout](#the-basket-readout).
3. **Act buttons:**

| Button | Shown when | Calls |
|---|---|---|
| Put it away (`store`) | carrying something and inside the storage area; lit green | `storeHere()`, or "not at the granaries" |
| Put one handful down (`drop`) | carrying something | `dropHere()` |
| Rest (`rest`) | always; lit while resting | `restHere()` |
| Eat (`eat`) | `canEat`: food in the basket, or at home with a meal in the store | `eatHere()` |

4. **Errands** (`data-order`), one for each entry in `ORDERS`. All are hidden while they are too heavy to walk, and some also when impossible for the band:

| Order | Label | Also hidden when the band has |
|---|---|---|
| `gather` / `hunt` / `craft` / `tend` / `sleep` / `visit` / `wood` / `explore` | Find food / Go hunting / Knap / Tend the fire / Rest / Walk to the next band / Gather wood / Go exploring | — |
| `quarry` | Work the rock | no quarry in reach |
| `fish` | Go fishing | no raft |
| `farm` | Work the fields | no dug ditch (`ditchOf(camp)?.path`) |
| `raid` | Go and take it | no `raidTarget` |
| `mourn` | Go to the stones | nobody buried |

5. **Stopping**, after a hairline: *Let them carry on* shows only while they are led or under orders, and not too heavy; *Go home* is hidden while too heavy.

`ordersPossible(camp)` hides only what is impossible, never what is merely unlikely. It asks the questions the band's own chooser asks, cached for half a second. The button for the current order (or current job) is marked `.on`.

`orderJob(job)` refuses while too heavy. Otherwise it releases the lead (an order is not a leash), sets `p.orders`, makes them idle so the order is taken up on their next turn, and toasts e.g. "Telok: hunting". The order is taken up once; afterwards they choose for themselves again.

Tests: a button, and markup, for each order, including errands only a grown band has; each order says what it is without being read; the row only exists in Follow; an order is taken up once, ends leading, and draws nothing from the world stream; the undo button is absent when there is nothing to undo; store, drop, rest and eat have buttons; an action is shown only when it can be done. Boot: the row is on screen while following and gone when not; an order is queued, lets go of the lead, and afterwards they choose.

### The act prompt

`#actPrompt` shows what E would do, refreshed at most every 120 ms:

| State | Text |
|---|---|
| acting | the job's words, e.g. "foraging…" |
| nothing in reach, resting | "X get up · resting at home" |
| nothing in reach, too heavy | "G put one down — too heavy to walk" (warning colour) |
| something in reach | "E" and the target's words, adding " · too heavy to walk" when it applies |
| otherwise | hidden |

- **Desktop.** The prompt sits centred just above the order row: its bottom is the row's measured height plus 20 px.
- **Narrow screens.** At 720 px wide or less, CSS moves it to `top: 10px`, where the row cannot push it off the screen.
- **The rail's `do` button** (`#touchAct`) is shown by the same function, and only while `whatHere` has an answer.

Tests: the prompt sits above the row however tall it is, and at the top on a narrow screen; too heavy to walk does not stop what is in reach, and the prompt says how to get moving.

### Danger: tigers

`updateDanger()` (`src/danger.ts`), up to ten times a second, shows `#danger` high and centred. It appears when a tiger is within `watchRange()`: `DANGER.far = 48` m in daylight, falling to 55% of that at night. Seeing less far is the only thing night changes here.

The banner shows:
- an arrow pointing to the tiger relative to the camera (straight up means ahead);
- "tiger · 31 m";
- a state:
  - "up a tree — it cannot reach you";
  - "hidden — keep still";
  - "coming for you — run (shift), climb or hide (Z), or throw (E)", while the tiger has chosen them. The banner then pulses red, and a toast "a tiger is coming for you" fires once.
  - "close" within `DANGER.close = 20` m;
  - otherwise "about".

The answers:
- **Run:** shift.
- **Climb:** Z at a tree. A tiger does not choose somebody up a tree.
- **Hide:** Z anywhere else. The tiger must come within `HIDE_SEEN = 0.25` of its noticing range, and one already chasing loses them past `HIDE_LOST = 12` m.
- **Fight:** E. A hit kills it and earns a chronicle line; a miss brings it on.

The band's own people react to tigers exactly as before.

Tests: a tiger in sight is shown with its direction and distance; you see less far at night; the banner says when it has chosen them; nobody up a tree is chosen, and nobody hidden until nearly trodden on; one already chasing gives up; the numbers in `danger.js` are the ones `wildlife.js` uses. Boot: a tiger coming for them, a climb, a throw that kills it or brings it on.

---

## 3. The HUD and panels

### The corner HUD

`#hud`, top right:

| Element | Content |
|---|---|
| `#clock` | `hh:mm`, rewritten only when the minute changes |
| `#skip` | "▶▶" while the night is being run through |
| `#almanac` | "year N · season"; its tooltip gives "day N" |
| `#vitals` | "N people · N fps", every half second. It sits here rather than in the world panel, because H collapses the panel. |
| `#following` | In Follow, telemetry about the followed person, every 0.5 s |

**The follow caption is telemetry now.** `updateFollowCaption()` still builds the "who" line:
- `who(p)`: band code and name;
- age and sex mark;
- role, unless forager;
- a strong trait word;
- `doingWords(p)`;
- "ill".

That line goes to the basket readout (`whoLine`). The corner shows only a `.where` line read straight off the person: `x 95.1  z 20.4  alt 12.3m  ·  want 1.35  going 1.33 m/s  ·  42m to go`. `want` is the speed they are aiming for. `going` is measured from their own coordinates since the last write; a gap under 0.05 s or over 20 s reads "—". On a phone `.where` is hidden. The five-cell energy meter is emitted on narrow screens but hidden by CSS everywhere.

**`doingWords`** reads `p.hidden` and `p.speed` (the same speed the legs are posed from), so the words cannot disagree with the figure:

| Situation | Examples |
|---|---|
| hidden | "asleep in a hut", "knapping in a tent", "sitting with the ill", otherwise "resting" |
| moving faster than `WALKING_AT = 0.25` | "walking out to forage", "bringing home 5 fish", "walking home" |
| heading to fire or tent | may add where they came from: "walking to the fire, back from a hunt" |
| visiting | why: "walking to Natsir, to ask for food" (or "with food", "with stone to trade", "to show them …", "to see them") |
| at the fire | "keeping the fire", "resting by the fire", "at the fire, with nothing in the store", "at the fire, out of the cold", "sitting up at the fire" |

At a window 720 px wide or less, everything after the first comma is dropped.

Tests: fps and head count sit beside the clock, which H does not hide; coordinates come off the person and altitude off the ground; both speeds are labelled and a stale reading is refused; the caption does not repeat the basket; the words come from the same speed as the legs. Boot: the caption names somebody with a coloured code, says where and how high, and its numbers move as the world runs.

### The basket readout

`updateBagHud(p)` fills `#bagHud`, rewriting its HTML only when something changes:

1. **Who**, in the accent colour, e.g. "[ND] Aro, 30♂ · at the fire, out of the cold", with a coloured code chip.
2. **What they carry** (`bagWords`). "on the shoulder:" prefixes game, wood or ore. With nothing counted it says "food" or "an empty basket".
3. **Where to take it**, while carrying: "granaries 23 m", or "at the granaries · E puts it away" in green.
4. **A fill bar**: weight against capacity, red when full.
5. **A small line**: "too heavy to walk ·" or "N% slower ·" while carrying, then "store N.N days" (`daysOfFood`).
6. **The life bar**: its number and the hint from `condition`.

Tests: the bar says what they carry, how full by weight, the slowdown actually applied in the step, and the store it all goes to; how far to the granaries, or that they are there; who they are is on the basket, not in the corner; a small haul is not rounded away.

### Toasts

`toast(text, seconds = 1.6)` (`src/ui.ts`) shows one line low in the centre and hides it by the real frame clock `elapsed`. A 16× world rate does not shorten it. Clock changes last 1.2 s, entering a world 2.2 s, Reset population 2.6 s, Delete everything and level-ups 3–3.5 s.

Tests: the frame clock the toasts run on is not scaled by the rate.

### Bubbles over heads

`updateBubbles()` (`src/bubbles.ts`) runs every frame, after people move. It draws an icon, and a word when near, over anybody **stopped** to do something. The icons are the order row's own (`src/icons.ts`).

`bubbleFor(p)`:
- **No bubble** while they are led, panicking, or walking.
- **At work:** the job's bubble — foraging, hunting, knapping, tending, sleeping, trading (a visit), quarrying, fishing, raiding, mourning, chopping, exploring, nursing.
- **Idle:** "storing" just after putting food away, otherwise "resting".
- **Under a roof:** only sleeping, knapping and nursing show, and over the tent, one per tent. Knapping beats nursing, which beats sleeping.

Limits:
- Nothing past `BUBBLE_RANGE = 70` m from the camera, fading over the last third of that.
- Words only within `BUBBLE_WORDS = 50` m.
- At most `BUBBLE_MAX = 192`, drawn in one call from a 128 px canvas atlas.

`BUBBLES=false` turns them off, and then nothing is ever built.

Tests: each of those cases; every bubble has a drawing and one word; word near, icon alone far; small and see-through; drawn after people move; BUBBLES off builds nothing. Boot: a bubble over somebody foraging, one over a tent where somebody is knapping, words when near.

### The world panel

`#ui`, top left, starts as `hidden collapsed`. `hidden` is removed once the world is built. **H** or the globe icon toggles `collapsed` (`togglePanel`). Collapsed, the icon is still there. The Entities list and chronicle are not redrawn while it is shut, and catch up when it opens. At 720 px wide or less the panel spans the screen.

Header buttons:
- globe (H);
- person (`#rpOpen`), role play only: the character sheet (I);
- ? (`#keysOpen`), not on a phone: the keys card (/).

| Row | Control | Behaviour |
|---|---|---|
| Load | `<select id="world">` | Every world on the shelf as "CODE · Name"; choosing one enters it. |
| Here / Seed | `#worldHere`, `#seedOut` | The world's coloured code and name, and `P.seed`. |
| Ahead | `#years` (1–50, default 5) + **Run years** | `seeAhead(years)` |
| Clock | − `#rateOut` + | `setRate(rateIndex ∓ 1)` |
| | **New world** / **Reset population** / **Delete everything** | see [section 6](#6-worlds-and-saving) |

- **World codes.** Two characters from `CODE_LETTERS` (no I, O, 0 or 1) and an HSL colour, both derived from the seed and stored nowhere.
- **Clock rate.** `RATES = [0.25, 0.5, 1, 2, 4, 8, 16]` (`src/clock.ts`), starting at 1×. Both ends stop rather than wrap. The readout shows ".25×", and the toast "clock 4×". The rate is a single multiplier on `dt`; wind and toasts are not scaled.
- **Run years** (`src/main.ts`). `seeAhead` clamps to 1–50 years, converts them to `ffStep()` steps, and runs `stepWorld` without drawing, in slices of `AHEAD_BUDGET = 20` ms of wall clock a frame. The "Running the world on" overlay shows:
  - a progress bar;
  - "N people · M camps · year x of y · day d · elapsed · about t left", the estimate measured once 400 steps and 0.25 s have passed;
  - a tribe picker, a population chart and the eight latest milestones, redrawn four times a second and on the last slice.

  "Stop here" or Escape stops at once and says "stopping…". The overlay comes down a frame before `refreshViews()` rebuilds the views. At the end it toasts "N years on · day D" and logs "N years passed unwatched". A comment in `src/main.ts` records about seven seconds of real time per simulated year, measured on the author's machine.
- **Arming.** Destructive buttons ask twice (`arm`). The first click reads "Sure?" and disarms after 4 s (Reset population) or 5 s (Delete everything).

Below: **Entities**, **Chronicle**, and `#stats` (fps and grass blades; trees, fruit, rocks; animals, people, camps, buried; models; born, died, oldest).

Tests: a sorted ladder of rates including 1×, whose ends hold, wired to −, + and the bracket keys, applied once to `dt`; loading a world does not reset the clock; Run years cannot start twice, has bounded years, runs in slices on a wall-clock budget, draws nothing, stops (Escape too), tidies up as finishing does, rebuilds every view including the clock, and can be narrowed to one tribe. Boot: + twice reads 4× and the world really moves four times as fast; H shuts and reopens the panel; Run years finishes a year and rebuilds the readouts.

### The Entities list

`renderTribes()` (`src/life.ts`) redraws `#tribes` every half second while the panel is open, under the heading "Entities (N)". Each living settlement gets one row:
- its chip (code on `camp.color`);
- `placeName(camp)`;
- the stage name, when above "band";
- its head count, or "empty";
- its development, "N/100".

**Place names** (`placeName`, `src/society.ts`): a place that joined or was taken is "Talo, Neimosh"; the place a multi-place tribe grew from is "Neimosh, city center" ("…, center" below a city); a place on its own is just its name.

**Development** (`developmentOf`) is `round(100 × (0.7 × mean skill + 0.3 × stage/4))`, each skill capped at mastery. Rows are ranked by it, ties in camp order. Dead bands get no row. A row click opens that band's card. `#tribeChart` below plots each band's population in its chip colour.

Tests: a row is a colour, a code, a name and a number; development runs from 0 (knows nothing, unsettled) to 100 (a city mastering everything); rows are ranked by it and a row still opens its band; the list and the card both use the place name.

### The band card

`#tribe` is a full-screen dimmed overlay. It opens from:
- an Entities row;
- **T**: the followed person's band, else the first camp;
- a band dot on the full map;
- the rail's `band` button (but see [Unverified on a device](#unverified-on-a-device)).

It closes with ×, Escape, T, or a click on the backdrop. It always opens on "who is here", or "who is gone" if nobody is left.

The **header** holds the code chip, the place name, and a pin (`#tribeGo`). The pin stores its band in `data-camp`, closes the card, the chronicle window and the keys card, travels to the camp, and toasts its name. If there is no band it says "no band to go to" rather than doing nothing.

The **head** lists:
1. The stage: "a village · 40% of the way to a city", or "not yet on the way to …".
2. "one of N villages of Name", for a multi-place tribe.
3. "once Hedrol, taken on day 9480", or "joined".
4. "Chief Name 41♂", or "nobody".
5. "N years old · founded on day D", given in days until the first year.
6. "N here · W♀ M♂ · K children · I ill".
7. "store X (Y days) · carried home between them Z".
8. "penned N animals".
9. "worth taking W (N stone · iron …)".
10. "B born · most they were was P · lost N: 7 tigers, …".
11. "remembers …": lessons, marked "(fading)".

**Tabs:**

| Tab | Content |
|---|---|
| **who is here** | Columns: who, age (♀/♂; "·" for a child), is (role; blank for foragers), children, carried, doing, lineage. Oldest first. The chief is marked "· chief"; ill people are faded and read "ill". Clicking a row follows that person and closes the card. |
| **who is gone** | Columns: who, age, what became of them (e.g. "starved", "a tiger", or "went to X" for somebody who left), day, lineage. Most recent first. A taken village's dead under its old codes are included. Empty: "nobody has left and nobody has died". |
| **skills** | Columns: skill; acquired, counted as something made ("3/5 courses", "1/1 raft", "18/40 stone"); level (`SKILL_RUNGS`: not yet, beginnings, a fair hand, real skill, mastery); difficulty, easy to very hard, green to red; needs (the standing condition, then the next rung); how it is learned (the place, and about how many goes are left). Easiest first. |
| **what happened** | This band's milestone lines on this seed, found by `[CODE]` in the in-memory chronicle. The 40 most recent; otherwise "nothing worth telling yet". |

Tests: four tabs, rendered as branches; skills one to a row, counted, with rung, difficulty, needs and how; no rung offered that a band cannot reach, and the two levels named match the code; every cause of death named; the band's age, births and peak shown, and what it has worth taking; the history capped, and saying so when empty; the pin records its band, takes down every popup first, and speaks rather than failing. Boot: T opens it; it names a chief; the carried totals add up; the chief is marked; the gone tab names people and what became of them; Escape closes it; the history tab renders.

### The lineage view

Every row on both person tabs has a tree button (`linButton`, `data-lin`). Its click is handled before the row's own, so it opens the person's family instead of following them. `lineageView(id)` (`src/kin.ts`) replaces the list with:
- "‹ back";
- the person;
- "of the line of X · generation N";
- "fathers back to it A ← B ← C";
- a table of parents, grandparents and great-grandparents (when known), children (with a count, or "none"), and grandchildren (with a count).

Each relative shows a clickable name, band chip and sex mark, then "30, alive", "died at 52, the sickness", or "lost to the record". A parent the record has lost shows by the name the child's record kept, or as "not remembered".

Back, or any tab, closes the view. It is read from the lineage record, which keeps the dead.

Tests: every person on both lists has a lineage button; it opens their lineage rather than following them; it reads parents, grandparents, children and the line back from the record.

### The chronicle: panel and window

**The panel's Chronicle section** shows the 12 newest lines of the in-memory chronicle (`CHRONICLE_MAX = 200`). Each line has a world chip, "d<day> <hour>", and text with band codes coloured.
- The funnel (`#chronKind`, mirrored by `#chronKind2` in the window) toggles `milestonesOnly`, which is on by default. Both copies redraw together.
- Milestone kinds: `learned`, `lost`, `split`, `joined`, `moved`, `trade`, `plague`, `hunger`, `relief`, `find`, `conquest`, `stage`, `slain`, `extinct`, `end`.

**all** (`#chronOpen`) or **L** opens the window, `#chron`:
- **Content.** It shows the in-memory lines at once. With a server run it then fetches `/api/chronicle?limit=2000` (every world's lines) and swaps them in; without one the local copy stays.
- **Search** (`#chronFind`). Case-insensitive substring over text, kind, world name, `d<day>` and hour, so "born", "TK" and "42" all work. The text is HTML-escaped before the match is highlighted, so a search cannot inject markup. A new search returns to the first page.
- **Pages.** `CHRON_PAGE = 40` per page. "← newer" and "older →" stop at the ends. The footer reads e.g. "1–40 of 312 worth telling · 2034 in all".
- **Closing.** ×, Escape, L, or a click on the backdrop.

Tests: L opens and closes it, and Escape and the backdrop close it; it asks the server for everything but shows what it has first, and keeps the local copy without a server; search covers every field, ignores case, returns to the newest, and cannot become markup; pages are fixed-size and stop at the ends; panel and window agree on what matters; the filter is an icon whose state can be read. Boot: paging, search narrowing and highlighting, "nothing matches", Escape and L.

### The map

`#map` (`src/map.ts`) is a relief drawn once per world from the height field, with live markers on top.

**Sizes.** **M** steps through `MAP_SIZES` forward and **shift+M** backward, toasting "map: …":

| Name | Size | Contents |
|---|---|---|
| `hidden` | — | off |
| `small` (the default) | 92 px, bottom right; top left under the icons at 720 px wide or less | land and water, paths, a dot for each band; no relief. A click opens the full map. |
| `max` | `max(240, min(innerWidth, innerHeight) − 32)` px, centred, framed | band codes, paths drawn as roads, a scale bar, marks, controls |

**Full-map controls.**
- The funnel opens the layer list.
- − and + step through `MAP_ZOOMS = [1, 1.6, 2.6, 4.2, 6.8]`; the wheel zooms too.
- ▣ goes back to the corner, not off.
- Zoomed in, the map follows you until you drag it (a drag past `DRAG_SLOP = 4` px pans). Zooming back out hands it back.
- Leaving full size resets the zoom and closes the layer list.

**Layers** (`MAP_LAYERS`, 16): Bands, People, Animals, Paths, Creeks, Burial grounds; Food: Fruit, Foraging, Farms, Fish, Rafts; Quarries: Stone, Iron, Bronze, Silver, Gold.
- Each swatch is drawn in that layer's colour.
- "All" brings everything back when anything is hidden, and hides everything when nothing is; with some of each it reads "mixed".
- The funnel fills while anything is hidden.
- Kept per browser in `openworld.mapLayers`.

**Marks** (full map only):
- The `FRUIT_MARKS = 24` richest clumps of at least 6 ripe fruit in view.
- Up to `FORAGE_MARKS = 30` berry thickets.
- Each creek's spring.
- Each coast's fishing grounds ("rich/fair/thin/fished out … would need a raft").
- Each field, once digging starts.
- Each raft, at its dock or out.
- Each quarry, coloured by ore and sized by what is left.

The tooltip gives a mark's label, "click to travel", or "open the map" (on the corner map). The cursor shows what a click will do.

**Clicking** with a still pointer on the full map (`endDragMap`):
1. A mark nearer than any band dot travels to the mark and toasts its label.
2. A band dot (`CAMP_HIT = 10` px) travels to its fire, opens its card, and toasts its name.
3. Open ground travels there.

`travelTo(x, z)` does nothing in role play. Otherwise it:
1. leaves Follow for Orbit, releasing any lead;
2. shrinks a full map to the corner, leaving a corner map alone;
3. puts the pivot 2.5 m above the ground and the camera 13 m up and 46 m south of it;
4. refills the grass tiles at once.

**On a phone**, the body carries `mapFull` while the map is full. Under a coarse pointer that hides the HUD, the order row, the rail, the panel, the act prompt and the danger banner, so every tap reaches the map. The way back is ▣, or travelling.

Tests: three sizes, starting on the corner map, sized to the short edge and re-measured on resize; the keys card lists them; zoom follows until dragged; drag pans and click travels, told apart by distance, and only a zoomed map drags; leaving full size drops the zoom; codes only at full size; the controls, minimise-to-corner and wheel zoom; the full map clears the panes on a phone; layers are remembered and "All" behaves as described; food marks only on the full map; clicking a mark goes there and says what it is; a corner-map click opens the full map; travelling puts a full map away but leaves a corner one. Boot: M reaches the full map; zoom and scale bar; codes on the full map but not the corner; layer toggles; drag versus click; clicking a band lands at its fire, closes the map, and opens its card.

### The keys card and About

**/** or the panel's ? toggles `#keys`. Escape, × or the backdrop closes it.

**About** (`#about`) sits at the top. It gives "Open World Sandbox", the version, a paragraph on the island, credits (three.js; people from humans-threejs; birds and horse from the three.js examples, originally ro.me by Mirada), and a Source link.

**Version** (`#aboutVersion`). The server works it out: major and minor from `package.json`, patch equal to the commit count. It reaches the page as `window.__VERSION__` and shows as "v1.0.N", with the commit hash as the tooltip. Opened as a plain file, it reads "standalone".
- Measured when added: `{"version":"1.0.65","commit":"cde323e"}` from a terminal-started server.
- `{"version":"1.0.66","commit":"b9295fa"}` from the Windows service, once `-c safe.directory` let git run as SYSTEM.

**Key groups:** Moving, Views (with the live view name), On screen.

**Footnote:** `.env` holds everything else, and `?fresh=1` ignores the saved place. Address-bar switches: `?models=off`, `?quality=low`, `?shadows=0`, `?water=0`, `?streams=0`, `?grass=0`, `?flowers=0`, `?wind=0`, `?terrainshadow=1`.

The card is partly out of date. It still lists six order icons and says energy is on the caption (that meter is hidden), and it does not mention I or role play.

Tests: F, R and V are on the card, and so are E's uses. Boot: the card starts closed, slash opens it, it names the current view, Escape closes it, the panel button opens it, and × closes it.

---

## 4. Phones and touch

### How a phone is recognised

| Condition | Effect |
|---|---|
| `@media (hover: none) and (pointer: coarse)` | The touch rail exists. Both keys buttons disappear. Inputs are 16 px. The telemetry line is hidden. A full map hides every pane. The order row is capped at the screen width minus 96 px, clear of the rail. |
| `@media (max-width: 720px)` | The panel is full width. The order row wraps, with buttons at least 44 px and the basket on its own line. The act prompt moves to the top. The corner map moves top left. |
| `matchMedia('(pointer: coarse)')` at load (`src/ui.ts`) | The order row and the rail both start folded; the rail's fold button reads "menu". |

With a mouse, the rail is `display: none` and costs nothing.

### The touch rail

`#touch`, bottom right, is a column of buttons at least 60×44 px. Each calls exactly what its key calls:

| Button | Key | Shown | Does |
|---|---|---|---|
| `view` | C | not in role play | in Follow, `handBack()` first (drops lead **and** order), then cycles the view |
| `follow` | F | not in role play | enters Follow, or picks somebody new |
| `behind` (`#touchShoulder`) | V | role play only | `shoulderView()` |
| `do` (`#touchAct`) | E | only while `whatHere` has an answer | `actHere()` |
| `map` | M | always | `stepMapSize(1)` |
| `band` | T | always | shut: closes the chronicle and keys card, then `openTribe(tribeShown \|\| 0)`; open: closes it |
| `panel` | H | always | `togglePanel()` |
| `keys` | / | never on a phone (hidden by CSS) | closes the card and chronicle, toggles the keys card |
| `hide` / `menu` (`#touchFold`) | — | always | folds the rail down to itself; its label says what the next tap does |

Opening one full-screen sheet from the rail closes the others, since a phone has no Escape. The order row's own fold button works the bottom-left corner the same way.

**Pinch** is the wheel in Follow. Two fingers scale `P.followDist` by the change in finger gap, clamped to 1.4–40. One finger drags to look; in Orbit, two fingers belong to OrbitControls.

### What a phone shows and hides

- The corner telemetry is hidden; who they are and what they are doing is on the basket.
- There is no keys button, neither the rail's `keys` nor the panel's ?.
- Actions appear only when they can be done: put away, drop, eat, carry on, go home, and every errand. Rest is always there, and `do` only while E has something. The same holds with a mouse.
- The order row stays, as the only way to reach these actions without a keyboard.
- On narrow screens the "doing" words stop at the first comma.
- A full map is the only thing on screen.

### No zoom on Safari

- **Viewport:** `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no`.
- **Page:** `html, body` get `touch-action: manipulation` (no double-tap zoom) and `-webkit-text-size-adjust: 100%`.
- **Canvas:** keeps `touch-action: none`, so a drag turns the camera instead of scrolling and a pinch reaches the page's handler.
- **Fields:** under a coarse pointer, `input, select, textarea` are 16 px. Below that, Safari zooms into a focused field and stays zoomed.

**Role play on a phone:** `wireRoleplay()` shows `behind` and hides `follow` and `view`. Both would look away from the character, and are refused anyway.

Tests: a drag turns the camera rather than scrolling; the order row stays on a phone with thumb-wide buttons; E's prompt goes to the top; the keys without buttons get them, only where there is no mouse, wired to the same code; pinch stands you back; role play on a phone has over the shoulder and neither follow nor view; no keys button on a phone; Safari never zooms, on a double tap or into a field; everything the stylesheet gives a display also has a `[hidden]` rule.

### Unverified on a device

- **The commits say so themselves.** Folding was "reported as not working on a phone" and not verified (2159fab). The `view` button is "unverified beyond the boot check knowing it exists" (7824f10). The last phone commit was "Not seen on a phone" (5751a50). The fast suite pins source text, and the boot check only confirms the elements exist.
- **Reading the source, the `band` button cannot open a card.** It calls `openTribe(tribeShown || 0)`, but `tribeShown` is `-1` whenever the card is closed. `-1 || 0` is `-1`, so `openTribe(-1)` finds no camp. As written, the button can close an open card but not open one. Not checked on a device.

---

## 5. Role play (`ROLEPLAY`)

`ROLEPLAY=true` (`P.roleplay`, default `false`) makes you one person. The code is in `src/roleplay.ts`, with one-line hooks in:
- `setViewMode`, `pickFollow` and the keydown handler;
- `travelTo`;
- `assignRoles`;
- `carryCap`, `src/move.ts` (effort) and `src/riding.ts` (pace);
- `stepWorld` and `tick`.

The island runs exactly as it does without you.

Tests: ROLEPLAY turns it on, and it is off unless asked for. The boot check runs with it off.

### Setup and the newcomer

**On boot, or with no character.** Each frame `updateRoleplay` checks for a character. With none, it looks at `openworld.hero`. If that names a character on this seed whose person is still alive, play resumes with the toast "Name again". Otherwise, once there are people, it shows the setup.

**The setup screen** (`#rpSetup`):
- "Who are you?";
- the previous character's death note, if any;
- "Somebody new is walking into one of the bands on this island. Everything about them but their name is what the island gives them.";
- a name field (at most 24 characters) and **Begin**. Enter also submits, and an empty name toasts "a name first".

It has no close button, and Escape does not close it.

**`createHero(name)`:**
1. Picks a random band with living people ("there is no band left to join" if none).
2. Creates the person with `newPerson(camp, rng, 18 + rng·8)`: 18–26 years old, with sex, build, looks and temper rolled like anyone born here. Their name and line are the typed name.
3. Grows the people meshes if needed, records them in the lineage, adds them to `people`, and dresses the camp.
4. Logs "Name came to [AB] Band from over the hills" as kind `visit`. That kind is not a milestone, so the default filter hides the line.
5. Creates the sheet, applies the level-1 body, awards the "joined" achievement, deals goals, saves, follows them, and opens the sheet.

### The camera lock

- **Always on the character.** `setViewMode` forces Follow, `heroView()` holds Follow on the character every frame, and `pickFollow` never picks while a character exists.
- **Refused keys.** `roleplayRefuses(code)` runs first in the keydown handler. **C**, **F** and **R** (shift+F included) are refused with "you are Name" (or "make somebody first"); **I** toggles the sheet.
- **Map travel is refused.** `travelTo` returns at once. The full map still opens, and clicking a band dot still opens its card, but the camera stays.
- **Following somebody from a band card** is undone on the next frame.
- **Still allowed:** click the ground, WASD and shift, E, G, Z, X, N, the order row, Q (let them get on by themselves), V, M, T, L, H, B, the brackets, and Run years.

Tests: the camera stays behind the character, with no other view, nobody else to follow, and no travel by the map.

### The character sheet

**I**, or the person button in the panel header, toggles `#rpLobby`. It redraws every 0.5 s while open. × closes it; Escape does not. It shows:

- **Title:** "Name · level L title", where title is `TITLES[floor(level/2)]`: newcomer (1–3), hand (4–7), provider (8–11), elder hand (12–15), pillar of the band (16+).
- **band:** chip, place name, stage.
- **where** (`whereWords`), with rounded coordinates:
  - "inside the walls of [NE] Neimosh, city center";
  - "at [NE] …" within 40 m of the nearest camp;
  - otherwise "312 m NE of [NE] Neimosh, city center", on an 8-point compass.
- **age · doing · role:** doing is the raw job key, plus "on horseback"; role is the key or "none".
- **level:** "level L", an XP bar across the current level, and "xp / next XP" ("max" at level 20).
- **body:** "stamina x1.08 · carry x1.10 · pace x1.04".
- **Roles:** a button per role. Locked ones are disabled, labelled "· L", with the tooltip "opens at level L". Clicking an open one asks for it ("asking the band to be its hunter"); clicking again withdraws ("no role asked for").
- **Goals:** "text n/need +XP XP", or "nothing the band needs of you right now".
- **Achievements:** the 12 most recent across every character, "text · Name · day D", or "none yet".

Tests: the sheet shows their band, where they are, their level, their goals and their achievements.

### Experience

`watchHero()` reads everything off what the character actually does. It runs every frame, and after every unwatched `stepWorld` (night skip, Run years, background tab).

- **An errand** counts when their state leaves `work`: it adds to `hero.done[job]` and pays `XP_FOR[job]`.
- **Food** pays `XP_FOOD = 0.5` a unit when `p.brought` rises, that is, when it reaches the store.
- **A kill** pays `XP_KILL = 15` when `p.kills` rises.

| Source | XP | Source | XP |
|---|---|---|---|
| raid | 15 | wood, fish | 7 |
| tame | 12 | gather, farm, nurse | 6 |
| hunt, explore | 10 | craft, patrol | 5 |
| quarry, visit | 8 | market | 4 |
| each kill | 15 | mourn | 3 |
| a goal | 20–50 | tend | 1 |
| each food unit home | 0.5 | | |

A level-up toasts "Name is level L · can be hunter, fisher". It also logs "[AB] Name is level L (why)" as kind `learned`, which the filtered chronicle shows.

### Levels

`xpFor(level) = 50·(level−1)·level/2` is the total XP to reach a level, up to `HERO.levelMost = 20`:

| Level | XP | Level | XP | Level | XP | Level | XP |
|---|---|---|---|---|---|---|---|
| 2 | 50 | 7 | 1,050 | 12 | 3,300 | 17 | 6,800 |
| 3 | 150 | 8 | 1,400 | 13 | 3,900 | 18 | 7,650 |
| 4 | 300 | 9 | 1,800 | 14 | 4,550 | 19 | 8,550 |
| 5 | 500 | 10 | 2,250 | 15 | 5,250 | 20 | 9,500 |
| 6 | 750 | 11 | 2,750 | 16 | 6,000 | | |

Each level past the first improves the body (`bodyOf`). The values are set on the person when the character is made, resumed, or levels up:

| Multiplier | Per level | L3 | L10 | L20 | Read by |
|---|---|---|---|---|---|
| stamina (`p.stamina`) | +4% | ×1.08 | ×1.36 | ×1.76 | effort is divided by it (`src/move.ts`) |
| carry (`p.carryMul`) | +5% | ×1.10 | ×1.45 | ×1.95 | `carryCap` (`src/bag.ts`) |
| pace (`p.paceMul`) | +2% | ×1.04 | ×1.18 | ×1.38 | walking pace (`src/riding.ts`) |

Tests: each level asks for more XP than the last; a level gives a better body (longer breath, a heavier load, a quicker walk).

### Roles

| Role (`ROLE_LEVEL`) | Opens at | Role | Opens at |
|---|---|---|---|
| hunter | 2 | trader | 4 |
| fisher | 2 | healer | 4 |
| knapper ("toolmaker" on the card) | 3 | warrior | 5 |
| quarrier | 3 | patrol (patrol rider) | 7 |
| keeper (fire-keeper) | 3 | | |

`assignRoles` (`src/skills.ts`) runs once a day, and only when the band can afford roles: at least `ROLE_AT.families = 6` adults and 8 days of food. In order it appoints:
1. the chief;
2. the role the player asked for, if the character's level has opened it (`chosenRole`);
3. every other role, to whoever the band is best at it through. `mayHold` keeps the character out of roles not yet opened; everyone else may hold anything.

Patrol riders exist only in cities.

Tests: a level opens roles, which the player asks for and the band grants once they are open.

### Goals

The character holds `HERO.goals = 3` goals. `topUpGoals` refills from `GOALS`: only goals whose condition holds for the band right now, and that are not already held. "food" goes first whenever it is open; the rest are shuffled. Progress counts from a base recorded when the goal was dealt. A finished goal pays out, toasts "done: text · +XP XP", and is replaced.

| Key | Offered when the band… | Text | Need | XP |
|---|---|---|---|---|
| `food` | has under 25 days of food | Bring 15 food home to the store | 15 (`p.brought`) | 40 |
| `hunt` | always | Kill an animal on a hunt | 1 (`p.kills`) | 35 |
| `quarry` | has under 25 stone and a quarry in reach | Work the rock three times | 3 | 40 |
| `wood` | wants wood (`woodWant > 0`) | Cut wood three times | 3 | 35 |
| `visit` | has another living camp within 700 m | Walk to another band | 1 | 30 |
| `farm` | has a field | Work the field three times | 3 | 35 |
| `fish` | has a raft | Go fishing twice | 2 | 30 |
| `tame` | keeps fewer horses than it could | Spend an afternoon taming horses | 1 | 50 |
| `craft` | always | Knap at the fire twice | 2 | 20 |
| `explore` | always | Go 400 m from your fire | `hero.far ≥ 400` | 45 |

A flaw found by reading the source, not by play: the explore goal scores 1 once the character has *ever* been 400 m out. If it is dealt after that, its base is already 1, so it can never complete and holds one of the three slots for good.

Tests: goals come from what the band is short of, three at a time.

### Achievements

Achievements belong to the player. They are kept across characters in `openworld.heroMarks`, newest first, with the character's name and day. Each is awarded once per character and toasts "achievement: text".

| Key | Text | When |
|---|---|---|
| `joined` | Came to a band from over the hills | the character is made |
| `kill` / `hunter` | Made a first kill / Ten kills | kills rise / 10 kills |
| `provider` | Brought a hundred food home | 100 food |
| `rider` | Rode a horse | mounted |
| `role` / `patrol` | Held a role in the band / Rode the bounds of a city | any role but forager / patrol |
| `level5` / `level10` | Reached level 5 / 10 | level ≥ 5 / ≥ 10 |
| `winter` | Lived through a winter | the season turns from winter to spring |
| `goals` | Did ten things the band needed | 10 goals done |
| `far` | Went a kilometre from the fire | 1,000 m from the camp centre |

### Death

When the character's person is gone from `people`, `died()` runs:
1. It reads the cause and age from the lineage record, and writes "Name died of cause at N, level L. The record keeps what they did." The cause is one of old age, a childhood illness, hunger, exhaustion, the sickness, a tiger, or a raid.
2. It logs "Name, who was yours, is gone".
3. It clears `openworld.hero`, keeps the achievements, and shows the setup screen with the death note.

Tests: a death is a death; you make a new character, and what was achieved stays on the record.

### What is stored where

| Where | Content | Written |
|---|---|---|
| `openworld.hero` | the sheet: `seed`, person `id`, `name`, `xp`, `level`, `done` (errands by job), `goals` (with base, need and XP), `marks`, the `role` asked for, `far`, `since`, `season`, `broughtSeen`, `killsSeen`, `goalsDone`, `lastState`, `lastJob` | on creation, a role change, and death; every 5 s while playing |
| `openworld.heroMarks` | `{ key, text, name, day }` for every character | with the sheet |
| world snapshot `people[]` | the character's body, place, load, knowledge and life bar, like anybody's | with the world |

A reload carries on as the same person while they live. Delete everything removes both keys.

### Measured play-through (headless)

From commit 9958dcd. Measured headless, not in a browser:
- **Setup and lock.** The setup appeared. "Ardan" joined [RA] Raedrira (120 → 121 people). Asking for Orbit left the view on Follow on him, and C and F were refused.
- **Six days on.** Level 3 with 291 XP, from 10 foraging trips, 8 sessions at the field, 5 at the fire, a hunt, a visit and an afternoon at the herd. Goals kept rolling. The body read ×1.08 stamina, ×1.10 carry, ×1.04 pace.
- **Death.** Killed: the character was gone, the sheet cleared, the achievements kept. Every section of the sheet rendered.
- **Suites.** `node test.js` passed 1963 checks. The quick boot check failed the same six things as before.

---

## 6. Worlds and saving

### The shelf

A world is a name and a seed. The shelf (`worlds`) lives in one of two places:
- **With a server run** (`runId` set): `GET /api/worlds` reads it and `POST` adds to it (SQLite `worlds` table).
- **Standalone:** `localStorage` `openworld.worlds`, holding the 60 newest.

`ensureCurrentWorld()` adds the booted seed at startup, so the world you are in is always listed. Names come from the seed the same way band names do (`nameForSeed`). **New world** takes a random 31-bit seed, names it, shelves it and enters it.

The shelf holds seeds, not saves; there is only one save slot.

### Entering a world

`enterWorld(seed, name)`:
1. sets `P.seed`;
2. sets the population salt to 0;
3. rebuilds (loading overlay, `buildWorld()`, `placeCamera()`);
4. toasts "Name · seed N".

It does **not** reset the clock, the day or the born/died counts, which belong to the session. A world entered from the shelf is built fresh from its seed. Its earlier people are not restored, because only the last world played is saved.

Tests: loading a world does not reset the clock; another world starts from its first people.

### The snapshot

`snapshot()` (`src/save.ts`) records only what no seed can reproduce, with short keys because it is written every ten seconds:

| Field | Content |
|---|---|
| `v` | `STATE_VERSION = 1`. A save with any other version is ignored. |
| `seed`, `ps` | The world, and the population salt (omitted when 0). |
| `time`, `day`, `born`, `died` | Hour of day, simulation day, counters. |
| `camps[]` | Name, `x`/`z` (so bands founded in play can be rebuilt), food, history, `skill` (keyed by name), toll, born, peak, founded, lost, stone, ores, raft, `wd` wood, `st` flock, `dh` ditch dug, `fl` field pin, `ls` lessons, `pt` foraging patches, `fd` explorers' finds, `cd` code, `vn` former name, `pc` past codes, `ca` conquered-at, `jn` joined. `hs` holds **horses as a count only**: the herd is rebuilt from the seed and that many are taken from it. `ht` ever tamed. `ti` **trade ties** by camp index. `sg`/`sd`/`sr` stage, since, rising-since. |
| `quarries[]` | What is left in each deposit, by position. |
| `drops` | Piles on the ground. |
| `people[]` | Name, camp index, birth day, position (**always ashore**; nobody is saved on a raft), yaw, sex, adult proportions, hut, job, state, haul, kills, bag, id, parents' ids and names, line, generation, `kn` knowledge keyed by skill, traits, `lf` life bar, energy, nourishment, sickness, immunity, colours, last birth. |
| `lineage`, `graves` | Everyone who has ever lived, and where the dead lie. |
| `alive[]` | Living count per herd, so an over-hunted species comes back over-hunted. |

**Not in the snapshot:**
- Rebuilt from the seed: terrain, creeks, seeded camp sites, herd positions, trees, fruit.
- Rebuilt by position: worn paths, village outskirts.
- Derived:
  - `camp.told`, from mastery. Saving it once made every reload re-announce every skill.
  - Hunger, recomputed by `updateEconomy(0)`.
  - Who is ill.
  - The field, re-found from its pin.
  - Build, face and hair, from the person's id.
- Kept in their own stores: the chronicle, the shelf, focus, map layers, and the role play sheet.

Tests: dozens of "survives a reload" checks (colouring, energy, traits, nursing, graves, toll, lineage, drops, basket, quarries and the stone pile, flocks, memories, patches, farmland, stages, joined villages, finds); a band is saved with its position, bands founded in play are rebuilt before anyone is placed, and an older save stops rather than shifting bands along; keyed skills, so adding a skill shifts nobody; a saved world comes back at its size. Boot: the saved day, tribe name and band return, and ages come out right.

### When it saves

- **Every `SAVE_EVERY = 10` s** of frame time, from `tick()`.
- **When the tab is hidden.** A `visibilitychange` listener in `src/map.ts` calls `persistState()` at once.
- **In a hidden tab**, `src/background.ts` keeps running the world and saves every 15 s (`BACKGROUND.save`). Measured headless with a faked worker (28a1b71): 4 s hidden advanced 0.68 sim-days (0.17 per second), the world was saved while hidden, and with `BACKGROUND=false` a hidden second advanced nothing. Not tried in a real tab.
- **After Run years** or a background spell, `refreshViews()` saves once.

`persistState()` `POST`s to `/api/state` when there is a run. If that fails, or returns anything but `ok` (for example 413), it writes `localStorage` `openworld.state`. Standalone, it writes `localStorage` only. The server stores the text in a single row (`state`, `id = 1`), with a body limit of `STATE_LIMIT = 64,000,000` bytes (`BODY_LIMIT = 1,000,000` elsewhere).

Tests: the server accepts the largest save the page can make, and only that endpoint gets the room; the page checks that a save actually worked, not merely that it did not throw, and keeps the world in the browser when it did not.

### Restoring, and in what order

1. `readSavedState()`:
   - returns `null` under `?fresh=1`;
   - otherwise tries `GET /api/state`, then `localStorage` `openworld.state`, accepting only `v === 1`.
2. `applySavedWorld(saved)` runs **before anything is built**: it sets `P.seed`, the salt, the time, the day and the counters, and clears the clock text and season index.
3. Two animation frames later: `wireWorld()`, `wireInput()`, then `buildWorld()` from seed and salt.
4. `applySavedLife(saved)` runs **after the world exists**:
   - rebuilds camps founded in play (`campFromRecord`) before anyone is placed;
   - restores camp fields, horses by count, ties, lineage, graves, people and herd counts;
   - recomputes the economy;
   - restores stone, raft, wood, finds and ores;
   - restores quarries, only if the deposit count matches;
   - restores drops;
   - logs "back at [CODE] Name, day N".
5. `startRun()` → `ensureCurrentWorld()` → `loadChronicle()`; then `setViewMode(P.view)`, `placeCamera()`, `restoreFocus()`, `loadModels()`. The loading screen comes down and `tick()` starts.

`?fresh=1` only skips reading. The next autosave overwrites the stored world.

### Server endpoints the page uses

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/run` | POST | Register a run and return `runId`; only when served (`window.__CONFIG__`). |
| `/api/state` | GET, POST, DELETE | The one saved world; GET returns 404 when there is none. |
| `/api/worlds` | GET, POST | The shelf. |
| `/api/events` | POST | Chronicle lines, in batches. |
| `/api/events?seed=N` | DELETE | One world's chronicle lines. |
| `/api/chronicle?limit=N` | GET | Every world's lines, newest first. The page asks for 200 at boot and 2000 for the window; the server caps at 2000. |
| `/api/data` | DELETE | Truncate everything. GET returns counts; other methods get 405. |

Without a database, every `/api/` route answers 503, and the page carries on as if there were no server.

### Reset population

**Reset population** (armed, 4 s) keeps the island and replaces its people (`resetPopulation()`):
1. Removes this seed's chronicle lines from memory and the upload queue, sends `DELETE /api/events?seed=N` when there is a server, and saves the local chronicle.
2. Clears the save (`localStorage` and `DELETE /api/state`).
3. Sets a new population salt, a random non-zero value (1 to 2³¹−2).
4. Sets the day and the born/died counts to 0.
5. Rebuilds, and toasts "a new people on Name".

The ground comes from `P.seed` alone. The bands come from the seed mixed with the salt: camp sites, band names and colours, the people, later bands, monument forms, and the simulation's own random stream. Every hill, stream, lake and outcrop stays, and so does the world's place on the shelf. Salt 0 is the original people, so worlds from before the salt existed are unchanged. The salt is saved as `ps` and applied before the build; entering another world resets it to 0.

Measured headless (5a808e8):
- After a reset, terrain heights, streams, lakes and ore deposits were identical, while the bands and people were not.
- Setting the salt back to 0 rebuilt the original bands exactly.
- The reset kept the seed, cleared the save, and removed this world's chronicle lines while leaving another world's.

Tests: asks twice; keeps the seed and the shelf entry; people come from their own seed and ground does not; which people is saved with the world, and another world starts from its first. Boot: the button starts unarmed, one click only arms it, the second resets, and it is the same world still on the shelf. The commit notes that the boot check's clicks on both destructive buttons sit inside `if (modelsVendored)`, so they do not run on every machine.

### Delete everything

**Delete everything** (armed, 5 s) runs `wipeEverything()`:
1. **Memory.** Empties the shelf, chronicle, lineage and pending events, zeroes the born/died counts, and sets the salt to 0.
2. **Browser.** Removes the five named keys (`openworld.worlds`, `openworld.state`, `openworld.chronicle`, `openworld.mapLayers`, `openworld.focus`). It then removes every other key starting `openworld.`, which catches `openworld.hero` and `openworld.heroMarks`, and any key added later.
3. **Server.** `DELETE /api/data` truncates `events`, `samples`, `tribes`, `state`, `worlds` and `runs` in one transaction, resets the auto-increment counters, then runs `PRAGMA wal_checkpoint(TRUNCATE)` and `VACUUM`. The page drops its old `runId` and registers a new run.
4. **Finish.** Makes a new world (`newWorld()`) and toasts "everything deleted".

The simulation day is not reset, since entering a world leaves the clock alone.

Measured headless (5a808e8): only the new world's key and an unrelated app's key were left in `localStorage`. Before that fix, the map layers and the followed person survived a delete.

Tests: anything the page ever kept under its name is removed, and the server empties every table and the file; asks twice; registers a new run because the old id points at nothing; leaves a world behind. Boot: starts unarmed, one click arms, the second deletes, the chronicle is emptied, and there is still a world to be in.

### `npm run reset`

`npm run reset` builds the node side and runs `reset.js`. It performs the same truncation from a terminal, for when the tab itself is the problem:
- It opens the database named by `.env`, or a path argument (absolute paths are respected).
- It prints per-table counts before and after, and the rows removed.
- It does not delete the file, which a running server may hold open in WAL mode.
- It reminds you that the browser keeps its own copy.
- If the file does not exist, it says "nothing to empty".

Tests: the command needs no page; it does not mangle an absolute path; it stops short of deleting a file a server holds open.

### Browser storage keys

| Key | Owner | Content |
|---|---|---|
| `openworld.state` | `src/save.ts` | the world snapshot (standalone, or when the server refused it) |
| `openworld.worlds` | `src/ui.ts` | the shelf (standalone) |
| `openworld.chronicle` | `src/life.ts` | the newest 200 chronicle lines |
| `openworld.mapLayers` | `src/map.ts` | which map layers show |
| `openworld.focus` | `src/chronicle.ts` | `{ seed, view, id }` |
| `openworld.hero`, `openworld.heroMarks` | `src/roleplay.ts` | the character sheet; achievements |

Every read and write is wrapped in try/catch, so a private window still boots.

---

## 7. Keyboard reference

Keys are handled by `wireInput()` (`src/chronicle.ts`):
- They are ignored while focus is in an `<input>` or `<select>`, such as the chronicle search, world list or years field.
- In role play, `roleplayRefuses` runs first.
- The arrow keys work wherever WASD does.

In the table, "Role play" is the same as Follow unless it says otherwise.

| Key | Orbit | Follow | Role play |
|---|---|---|---|
| **W A S D** / arrows | slide the rig (26 m/s × pace) | walk them relative to the camera; release stops them, still yours | |
| **shift** | left shift: rig ×3.6 | run (either side); stands them up from hiding | |
| **Q** | lower the rig | let go: they carry on as they would (refused while too heavy) | |
| **E** | raise the rig | do what is in front of them (`whatHere`) | |
| **G** / **shift+G** | — | put one handful / everything down | |
| **Z** | — | take cover: climb the tree, or get down low; again to come down or stand | |
| **X** | — | sit down to rest, or get up | |
| **N** | — | eat: the store at home, the basket elsewhere | |
| **click** ground | (OrbitControls) | walk there; another click turns them | |
| **drag** | orbit the pivot | look around; releases the shoulder lock | |
| **wheel** / pinch | zoom | how far back you stand, 1.4–40 m | |
| **C** | to Follow (picks somebody) | to Orbit (releases a lead) | refused: "you are Name" |
| **F** | enter Follow | somebody else | refused |
| **shift+F** | enter Follow on the previous person | the previous person | refused |
| **V** | no visible effect | back over their shoulder, lock on | allowed |
| **R** | somewhere else on the island | to Orbit, then somewhere else | refused |
| **I** | — | — | toggle the character sheet |
| **H** | collapse or expand the world panel | same | |
| **M** / **shift+M** | map: small → full → hidden → small / backwards | same | full map viewable; clicks do not travel |
| **T** | band card for the last-followed person's band if one is still set, else camp 0; toggles | the followed person's band; toggles | |
| **L** | chronicle window, open or closed | same | |
| **[** / **]** | clock slower / faster through `RATES` | same | |
| **B** | hide one more render layer (shadows, grass, water, streams, canopy, trunks, fruit, rocks, fauna, people and camps, sky, terrain); the toast lists what is hidden | same | |
| **shift+B** | put every layer back | same | |
| **/** | keys card, open or closed | same | |
| **Esc** | stop a run of years; close the keys card, chronicle window and band card | same | does not close the setup screen or sheet |

Tests: F enters Follow and finds somebody; shift+F goes back; V restores the shoulder; R enters Orbit and finds somewhere; N now eats instead of following; Q in Follow does not also move the Orbit camera, and shift+W runs; the brackets are wired to the rate; Escape stops a run of years and closes the chronicle and band card. Boot: the keyboard reaches the page; /, Esc, T, L, H, C, F, R and M behave as listed; each bisect step hides the layer it names, and shift+B restores the world and its shadow map.
