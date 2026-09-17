# People and daily life

[Technical documentation](README.md)

A handful of modules cover what a person is and does:

| Module | What it owns |
|---|---|
| `src/types.ts` | The `Person` shape. |
| `src/life.ts` | Making people, ageing them, feeding them, making them ill, killing them. |
| `src/move.ts` | Choosing what each person does next, and moving them. |
| `src/people.ts`, `src/looks.ts`, `src/clock.ts` | Building and dressing bodies. |
| `src/vitals.ts`, `src/bag.ts`, `src/drops.ts`, `src/larder.ts`, `src/lessons.ts`, `src/farming.ts`, `src/wood.ts`, `src/rafts.ts`, `src/explore.ts`, `src/paths.ts`, `src/walls.ts`, `src/ill.ts` | One subject each. |
| `src/wildlife.ts` (parts) | Lineage, names, energy. |

Units and conventions:

- **Sim-day.** One turn of the clock. A year is `P.yearLength` sim-days (default 24). Rates in `LIFE`, `PLAGUE` and `FOOD` are per sim-day or per year.
- **World-second.** Movement, energy and errand timers run on the paced clock, `dt * pace()`, where `pace()` = `clamp(paceDay / dayLength, 0.5, 12)`. Pace is 1 unless `PACE_DAY` is set. One step moves at most `PACE_MAX_STEP` (0.25 s) while watched and `FF_STEP` (0.5 s) while unwatched.
- **The books.** `updateEconomy`, `updateGround`, `updateLives`, `repopulate`, `updateLivestock`, `updateSociety` and `cityDraw` run every `BOOK_EVERY` = 1/8 sim-day. Each is handed the days owed since its last run. The watched frame and `stepWorld` both keep this cadence.
- **Luck.** Every decision a person makes draws from `luck()`, the seeded simulation stream in `src/clock.ts`. Orders and E-actions are therefore left on the person for the step to perform, never performed by the frame.

---

## 1. A person

### 1.1 The Person record

`Person` (`src/types.ts`) is built in exactly two places:

- `newPerson` (`src/life.ts`): at world build, at birth, and for a role-play newcomer.
- `personFromRecord` (`src/save.ts`): when a save is loaded.

A field marked optional arrives during a life; it is not rare.

| Group | Fields | Notes |
|---|---|---|
| Identity | `id`, `camp`, `name`, `sex`/`kind` (`'m'`/`'f'`), `child`, `born` | `id` comes from `takePersonId()` and is never reissued. `born` is a sim-day. |
| Descent | `mother`, `father`, `motherName`, `fatherName`, `line`, `gen` | Parent names are kept because parents die first. |
| Body | `adultScale/Shoulder/Hip/Head`; current `scale`, `shoulder`, `hip`, `headScale` | The current values are recomputed from age. |
| Motion | `x`, `z`, `yaw`, `speed`, `phase`, `targetX/Z`, `swerve`, `lift` | `lift` raises the body onto a tree, raft or horse. |
| Errand | `state` (`idle`/`goto`/`work`/`return`), `job`, `timer`, `work`, `came` | |
| Condition | `energy`, `nourish`, `sick`, `immuneUntil`, `panic`, `life?`, `cold?` | `life` exists only once the person has been played. |
| Posture | `crouch`, `bend`, `carry`, `hasSpear`, `asleep`, `hidden`, `resting?`, `hiding?`, `climbed?`, `mounted?` | |
| Load | `haul`, `bag?`, `brought?`, `prey?`, `attempt`, `kills`, `digging?` | `haul` is in food units; `bag` counts what it is. |
| Control | `led`, `leadX/Z`, `orders`, `act?`, `acting?`, `goingHome?` | |
| Trips | `visiting`, `raiding`, `onRaft`, `raftTrip` | These hold camps, not flags. |
| Knowledge | `knows`, `taught`, `moved`, `role`, `lastBirth` | `knows` is the person's own memory of each skill. |
| Looks | `skin(Shade)`, `garment(Shade)`, `hairColor`, `traits`, `look?`, `worn/wornAt/wornStamp` | `look` is derived from `id` and never saved. |
| Home | `hut`, `hearth` | Taken from the household. |
| Role play | `stamina?`, `carryMul?`, `paceMul?` | Set by a character's level. |

### 1.2 Where people come from

**Founding bands.** `buildPeople(count)` (`src/people.ts`) makes the island's first people:

- There are `PEOPLE` of them (default 16, range 0–800), dealt round-robin into the `CAMPS` camps (default 2).
- Ages are drawn from the world stream: 35% children spread evenly over 0–14 years, the rest `min(72, 14 + Exp(mean 16))`.
- Each camp starts with `food = need × FOOD.startingDays` (4 days) and `hunger: 1`. The literal 1 matters: a band that believed its empty store was full sent 21% of its people out instead of 96% (measured, commit `97683d0`).
- `dressCamps()` runs before anyone takes a step, so everyone has a tent and a fire from the first frame.

`newPerson` gives each person:

- a sex by coin flip, and an `adultScale` from `BUILDS[sex]`;
- a spot 2–8 m from the fire, energy 0.6–1, job `tend`, state `idle`;
- `traitsFor(rng, null, null)`, and colours drawn from `SKIN`, `GARMENT` and `HAIR`;
- `line` = their own name, and `gen` = 1.

The room for people starts at `PEOPLE_ROOM` = `min(4000, (WORLD/1000)² × 195)`. When the bands fill it, `growPeople` rebuilds every body mesh and look mesh at twice the size. A birth is never refused for lack of room.

**Births** (`updateLives`, on the books, per camp):

1. **Count parents.** *Mothers* are women aged 16–42 (`LIFE.fertileFrom`–`fertileTo`) who are not sick and not `nursing(p)`. *Fathers* are fertile men who are not sick. With none of either, there are no births.
2. **Check food.** `plenty` is 1 if `daysOfFood > FOOD.breedsUntil` (0.75) and 0 otherwise. Births are a cliff, not a taper: a band breeds flat out until it is already starving.
3. **Roll.** The expected number of births is `mothers × 2 × LIFE.birthPerYear (0.30) × plenty × P.fertility × days/yearLength`. The whole part always happens and the fraction is rolled, so a big camp can have several births in one step. Before commit `c1b34ab` a step allowed only one birth, which capped a camp at 32 births a year on a 4-day year.
4. **Parents.** `pickParent` draws a random eligible mother and a random eligible father. The mother's `lastBirth` is set, which starts `LIFE.birthGap` (2 years) of nursing. That makes 3–4 years between children. The gap was added after a `FERTILITY=3` world starved 1,008 people, 80% of them children.
5. **Descent.** Descent follows the father: `line = father.line`, `gen = father.gen + 1`.
6. **Traits, looks, record.** The child gets `traitsFor(luck, mother, father)` and `inheritLooks`, is recorded with `recordPerson`, and the chronicle says "X was born to Mother".

Parentage is drawn from the whole camp and is independent of the households that share a tent.

**Traits** are three numbers near 1:

- `bold`: widens foraging and hunting range, and shortens how early a tiger is noticed (`PANIC.sees / bold`).
- `sociable`: scales the visit, market and nurse weights.
- `quick`: scales what a craft session teaches.

Each trait is `clamp(mid × 0.5 + own × 0.5, 0.55, 1.55)`. `mid` is the parents' mean, or 1 with no parents. `own` is `1 ± TRAIT_SPREAD` (0.30). The band card names a trait only when it is more than 0.18 from 1.

**Looks.** `inheritLooks` makes skin the parents' mean plus a small HSL drift (without the drift, families converge on one shade within a century). Hair colour comes from one parent.

**Households.** `familiesOf(camp)` pairs women and men oldest-first. Children go to the household that holds a parent. Everyone left over shares in pairs. `assignHuts` gives each household one tent (a house from the city rung up) and one fire, `p.hearth`. `homeFire(p)` is what "go home" means.

**Changing band.** A person moves to another camp in one of four ways, each calling `recordMove`:

- staying after a visit (7.6);
- a split, where `pickLeavers` takes the youngest fertile adults of both sexes (up to 3 each, always leaving 2 of each behind) and then the oldest children, or takes nobody if either camp would be left without a fertile pair;
- the city draw;
- a neighbouring band merging in.

> Tests guarantee: births need one of each sex, and the rate is set by mothers who are not nursing; nursing lasts about two years and survives a reload; births run flat out and stop only once starving; a big camp can have several children a step; traits start near the middle, half from the parents, bounded; a tent is a family; ten households fill a hearth before the next is lit; the room is made, never refused; a split takes young adults, not elders. Boot check: every person has a fire in their own camp, one per household.

### 1.3 Ages and life stages

`personAge(p)` = `(simDay − born) / yearLength`. On each books pass `applyAge` sets:

- `child` = age < `LIFE.adultAt` (14);
- `growthOf(age)` = `(age/14)^0.65`;
- `scale`, from `adultScale × newbornScale` (0.30) up to `adultScale`;
- `headScale` 1.18 → 1, `shoulder` 0.95 → 1, `hip` 0.98 → 1;
- `p.years`, which the hair colour reads.

`BUILDS.child` is declared but not read; a child is sized from their own adult build.

| Stage | Age | What changes |
|---|---|---|
| Toddler | < 4 (`TODDLER_UNTIL`) | Always indoors. Plays or tends. |
| Child | 4–7 | Plays at 0.75 of an adult jog, or tends. |
| Older child | 8–13 (`FORAGE.helpFrom`) | Forages with weight `0.25 + 0.55 × hunger`. Brings back `childWorth` of an adult basket, rising from 0.40 to 0.90. Forages over 0.55 of the adult range and carries half as much. |
| Adult | ≥ 14 | Full job list. On the first books pass as an adult, `knows[k] = max(knows[k], camp.skill[k] × SKILL.teach 0.86)`. |
| Fertile | 16–42 | Can parent; can explore. |
| Prime | 18–45 | First-pass pool when a chief is picked. |
| Ageing | > 32 | Age hazard climbs exponentially. |

> Tests guarantee: an older child brings home more than a younger one and less than an adult; a toddler is in the tent whatever else is happening. Boot check: restored ages come out right.

### 1.4 Names

Names are built from syllables that belong to no real language (`src/wildlife.ts`):

- There are 20 onsets (`NAME_ONSET`), 14 vowels and 12 codas, four of them empty.
- `tribeVoice` gives each band 6 distinct onsets, its accent. People are named `uniqueName(rng, 2, camp.voice)`, so a band's names rhyme a little. A band name has 2–3 syllables, and its two-letter code comes from the name.
- `uniqueName` makes 40 attempts at an unused name longer than two characters, then appends `usedNames.size % 100`.
- `who(p)` renders a person as `[CODE] Name` everywhere.

### 1.5 The lineage record

`lineage` (`src/wildlife.ts`) keeps everyone who ever lived. `people` holds only the living.

| Function | What it writes |
|---|---|
| `recordPerson` | `i` id, `n` name, `s` sex, `f`/`m` parent ids, `fn`/`mn` parent names, `b` born, `d` died (0 while alive), `c` birth camp code, `g` generation, `l` line. Short keys, because it is saved. |
| `recordDeath` | `d`, the cause `x`, and `dc`, the camp at death. |
| `recordMove` | `fr`, `to` and `md`. |

- `LINE_MAX` = 20,000. Past it the oldest records go; a world would need thousands of years to reach it.
- `lineOf` searches newest-first. `ancestry` walks at most 12 fathers.
- A new world starts with `setLineage([])`, and a save restores its own record over the top. `src/kin.ts` draws a family tree from it.

> Tests guarantee: ids are never reissued, so a newborn cannot collide with anyone dead; everyone who ever lived is kept, founders and children alike; a death is written with its cause and camp; a move is recorded; lines cost one step at birth, and a broken chain cannot loop; the record survives a reload.

### 1.6 Death

**Competing hazards.** `hazards(p, age, camp.hunger)` gives annual rates:

| Hazard | Annual rate |
|---|---|
| `age` | `0.008 × exp(max(0, age − 32) / 11)`. About 0.25 at 70 (derived). |
| `infancy` | Under 5 only: `0.03 × (1 − age/5) × infantCare(camp)`. |
| `hunger` | `0.40 × hunger²` |
| `sickness` | While sick: `0.10 × (1 + 2.4 × hunger) × (1 − 0.55 × herbs) × yearLength`. This converts a per-day risk to per-year. |

A person dies if `luck() < total × days/yearLength`. `pickCause` then chooses the cause in proportion to each hazard: one roll for whether, one for what.

Before the hazard roll, **exhaustion** is checked deterministically: `energy <= 0` kills. Two more causes arrive from elsewhere:

- `tiger`: from `takeQuarry` in `src/wildlife.ts`.
- `raid`: in `resolveRaid`, the losing side loses someone with chance `RAID.hurt` = 0.10.

| Toll key | Chronicle wording | Card wording |
|---|---|---|
| `age` | "died, 67" | old age |
| `infancy` | "died a baby" / "a child of 3" | infancy |
| `hunger` | "starved, 31" | hunger |
| `exhaustion` | "grew too weak with hunger, 40" | weakness from hunger |
| `sickness` | "died of the sickness, 22" | the sickness |
| `tiger` | "was taken by a tiger, 19" | tigers |
| `raid` | "was killed in a raid, 28" | a raid |

**`killPerson(i, cause)`** is the only function that removes a person. It:

1. logs the death;
2. calls `buryPerson`;
3. practises `rites` by `SKILL.perBurial` (0.06);
4. increments `camp.lost` and `toll[cause]`;
5. calls `learnFrom` (7.8) and `recordDeath`;
6. splices the person out of `people`, fixes `followIdx`, and repaints.

When a camp's last person dies, `updateEconomy` marks it `gone` and logs an obituary: the two leading causes, years lasted, how many were born, and the most they ever were.

> Tests guarantee: causes compete, drawn in proportion to their hazard; one place removes a person and lets go of the follow camera; the toll counts every cause with a word, worst first; the obituary is said once; energy reaching nought is death, not a risk. Measured: before three hunting rules were written, tigers caused 73% of deaths; after, 26% (commit `97683d0`).

### 1.7 Burial

`layoutCamp` chooses each camp's burial ground, `barrow`. It tries 60 spots 6–18 m past `CAMP_CLEARING`, needing flatness ≥ 0.88, dry ground, and 8 m clear of creeks. If none qualifies it uses a spot 4 m past the clearing.

`buryPerson(p)`:

- **Placement.** The body is carried back to the barrow. The n-th grave goes to `squareSeat(n)`, which spirals a square out from the middle at `GRAVE_SPACING` 1.6 m, so the oldest graves sit at the centre. A band with no barrow buries people where they fell.
- **Marker.** A band with `stonework` ≥ 0.5 raises a headstone. Otherwise the grave is a cairn of 3 stones, and older cairns stay cairns.
- **Nothing is removed.** The grave mesh starts with room for 400 (`GRAVE_ROOM`) and doubles when full. A band that dies out keeps its graves, its monument and its pyramid.

> Tests guarantee: the dead leave a cairn that is never taken away and survives a reload; they are carried back and laid in a square filled from the middle out; a burial teaches more than an afternoon at the stones; a band that can dress stone raises headstones.

---

## 2. Bodies and looks

### 2.1 The rig

The body is the **humans-threejs** package, imported from `node_modules` through the import map. `PERSON` (`src/clock.ts`) reads its measurements from the model's joint table instead of keeping its own. The old hand-set leg summed 14 cm longer than the hip height, so feet sank into the ground (commit `72f982c`).

| `PERSON` | Value |
|---|---|
| `legLen` | The model's hip height, which is the body's origin. |
| `hipX/hipXF`, `armX/armXF` | Male and female joint offsets. The sexes differ in the joints, not the limbs. |
| `thigh`, `shin`, `upperArm`, `foreArm` | Bone lengths from the joint table. |
| `stride` | 0.78 m |
| `walk` / `jog` | 1.35 / 3.6 m/s |
| `turn` | 3.0 rad/s |
| `spear` | [0.045, 2.1, 0.045] |
| `load` | [0.30, 0.11, 0.26] |
| `basket` | [0.19, 0.15, 0.17] |

`PERSON_PARTS` is the one table saying how many instances of each part a person has:

- `neck` 1, `head` 1;
- `upperArm`, `foreArm`, `hand`, `thigh`, `shin`, `foot` 2 each;
- `spear`, `load`, `basket` 1 each.

That is 17 per person. There is no torso mesh; the hide tunic is the torso (2.3). Meshes are named `person-<key>`. `hidePeopleFrom` limits the draw count to the living, and culling and the far figure belong to `src/crowd.ts`.

`writePerson` (`src/move.ts`) poses a person each frame:

- **Body.** The body matrix is lowered by `0.44 × legLen × crouch`, bobs with the stride, and pitches by half the ground slope.
- **Torso.** It turns at the waist by `bend` plus a lean: 0.16–0.38 mining, 0.34 hoeing, 0.04–0.20 fighting. The head and arms ride on it.
- **Arms.** They counter-swing when walking. Carrying holds them forward with the elbow at 1.30. Working poses are `mining` (two-handed pick), `cutting` (a knife, for craft), `hoeing`, `picking` (arm up a tree), and `fighting`. `throwPose` draws a spear throw.
- **Legs.** The knee bends only through the swing, and crouching takes the knee forward. Hip plus knee is bounded by `SHIN_MAX` (1.35 rad), so the ankle stays below the knee. The foot stays level.
- **Hands.** A hand closes to `FIST` scale [1.25, 0.72, 1.45] when carrying, holding a spear or fighting (right hand), or working.

| Pose | crouch | bend |
|---|---|---|
| gather | 0.55 | 0.85 |
| craft | 0.95 | 0.45 |
| tend | 0.90 | 0.18 |
| quarry | 0.50 | 0.90 |
| wood | 0.20 | 0.55 |
| farm | 0.15 | 0.30 |
| fish | 0.30 | 0.45 |
| raft / horse | 0.60 | 0.20 |
| hiding | 1.00 | 0.55 |
| resting | 0.90 | 0.12 |
| asleep | 1.00 | 0.10 |

> Tests guarantee: the body is plain data from the humans-threejs package, following main; every piece hangs from its own joint, and a woman's limbs from hers; the legs add up to the hip; the knee bends one way, and the bound is on hip plus knee. Boot check: the head is above the neck, down to the foot below the knee, on a live person.

### 2.2 Builds, sizes and colour

`BUILDS` scales the 1.735 m model:

- men 0.963–1.030, about 1.67–1.79 m (derived);
- women 0.886–0.943, about 1.54–1.64 m (derived).

Palettes: `SKIN` has 8 tones, `GARMENT` 5 hides, `HAIR` 4 browns. `paintPerson` writes `skin × skinShade` (0.9–1.1) onto the head, neck, arms and hands, 0.95× that onto the legs and feet, and wicker `0x9a7446` onto the basket.

`paintPeople()` runs whenever the band changes, because a death shifts everyone after it down a slot. It re-resolves chiefs, redresses camps, undresses everyone, and repaints.

> Tests guarantee: colouring is carried by the person, not the slot; every part is painted; it survives a reload. Boot check: nobody is drawn in unpainted white.

### 2.3 The wardrobe (`src/looks.ts`)

`looks.ts` ports the library's clothing geometry into joint space. `lookOf(p)` hashes `p.id`, so a save never has to store looks:

- **Build.** `slim`, `average`, `broad` or `full`, a quarter each. `buildAt` is the library's formula. Limbs widen by the stretch at their middle (`BUILD_FIT`), and shoulders and hips move out with the torso.
- **Face.** `soft`, `angular` or `wide`, a third each. The features are placed on the drawn head by a ray through its triangles; in the library's v0.3 the eyes sat a centimetre inside the head.
- **Hair.**
  - Women: long 75%, bob 15%, curls 5%, swept 3%, cropped 1.5%, bald 0.5%.
  - Men: cropped, swept, bob, curls or bald, 20% each.
  - A bald child wears `cropped`.
  - Colour lightens in childhood and greys with age: `t = 0.32×(1−smooth(5,22,age)) + 0.42×smooth(45,100,age)`, blended toward `0xb38a60`.

The look meshes (24 in all):

| Key | Count | What it is |
|---|---|---|
| `tunic:{m,f}:{build}` | 8 | The hide, fitted to the model's torso rings. It stops a hand below the hip. Grown women wear `f`; children of both sexes wear `m` until they come of age. |
| `hair:*` | 5 | |
| `face:*` | 3 | |
| `band` | 1 | The chief's brow band. |
| `cargo:fruit/berries/fish/meat/animal/vegetables` | 6 | Berries reuse the fruit heap, darker. |
| `tool:knife/pickaxe/hoe` | 3 | |
| `sleeve:0/1`, `legs:0/1`, `shins:0/1` | 6 | Tubes on the limb's own matrix, one mesh per side. |
| `cloak` | 1 | |

**Packed lists.** Each look mesh holds only its wearers:

- `wear(p, group, key, stamp)` appends the person to the mesh's `who` list.
- `takeOff` moves the last wearer into the gap, so nothing shuffles.
- Wearing the same key with a new `stamp` recolours the item in place; this is how cloth is dyed.
- `undress(p)` clears a hidden person's items. `undressAll` clears every list on any band change, and people put their clothes back on next frame in today's colours. That is how a new chief turns ochre.

**Clothing grades** are `CLOTH = { sleeves: 1, legs: 2, dyed: 3, cloak: 4 }`. They read the *announced* rung, `camp.told.clothing`, not the raw skill, so clothes do not flicker as a skill wavers.

| Rung | Effect |
|---|---|
| ≥ 1 | Sleeves. |
| ≥ 2 | Leggings and shinwear. |
| ≥ 3 | Cloth lerps 70% toward `hsl(bandHue, 0.5, 0.3)`, the band's chip colour. The chief keeps ochre. |
| 4 | A cloak in winter. **Unreachable:** announcing mastery needs `1 + SKILL_RISE`, but `practise` caps skills at 1. Commit `6bb956c` says the cloak is never sewn. |

**The chief.** `chiefOf(camp)` stores `camp.chief` as an id and re-picks only when that person has left.

- `pickChief` takes the non-sick adult aged 18–45 with the highest `spears + baskets + 2×drying + energy`, plus 0.15 for a woman.
- If there is none, it takes the eldest non-child, then the eldest of anyone.
- The chief wears `CHIEF_CLOTH` (`0xb5651d`) and `CHIEF_BAND` (`0xe8ddc8`).

**Loads and tools** (`writePerson`):

- **What shows.** `bagKind` chooses what to draw, in priority: ore, wood, game, fish, vegetables, fruit or berries.
- **Food** rides in a basket held low in front, heaped to `clamp(haul / 0.8, 0.45, 1.15)`.
- **Animals.** A rabbit (at half size) or a boar is carried whole in the arms. Deer and bison come home as meat in the basket.
- **Stone, ore and wood** use the shoulder heap, coloured by `LOADS`; the colour is written only when the load changes.
- **Tools.** The pickaxe, knife or hoe goes into the right hand before the fist closes. A spear shows during a hunt or raid, or while fighting.

> Tests guarantee: a look mesh holds only its wearers, and removal moves the last into the gap; someone out of sight wears nothing; the tool is placed before the hand closes; the builds differ where they should; a load takes the shape of what it is; clothing goes sleeves, leggings, dye, then cloak (winter only), recoloured in place; the chief wears ochre and a band, and who leads is settled before painting. Boot check: fruit in a basket, a deer as meat, a rabbit in the arms.

### 2.4 The near set

Joints and fingers are drawn only on the person the camera follows. `buildNearParts` makes plain meshes: elbow, wrist and knee balls, plus four fingers and a thumb per hand. `nearJoint` copies a limb's matrix onto them when `i === followIdx` in Follow view. Fingers appear only on an open hand, and `hideNearParts` puts the set away when nobody wore it that frame. The cost does not change with population.

> Tests guarantee: near detail is not instanced for everyone and costs the same for a village as for a band; it is worn by whoever you are behind and put away when that is nobody; fingers only on an open hand. Boot check: an open hand has fingers, a fist none.

### 2.5 Bubbles over heads (`src/bubbles.ts`)

`bubbleFor(p)` reads the same fields the caption does:

- **No bubble** for someone led, panicking, or moving faster than `WALKING_AT` (0.25 m/s).
- **Hidden** people get a bubble over their tent: sleep, craft or nurse. If several share a tent, craft beats nurse beats sleep.
- **Idle** people show `store` just after putting a load away, otherwise `rest`.
- **Working** people show their job's icon: gather, hunt, craft, tend, sleep, visit (drawn as trade), quarry, fish, raid, mourn, nurse, wood, explore.
- `farm`, `market`, `play`, `tame` and `patrol` have no icon.

Bubbles appear within `BUBBLE_RANGE` (70 m), fade over its last third, and carry a word within `BUBBLE_WORDS` (50 m). At most 192 show, all in one `THREE.Points` draw. `BUBBLES=false` hides them, and they are never built if never shown.

> Tests guarantee: a forager stopped in a berry patch gets a bubble and one walking to it does not; knapping and sleeping go over the tent; being led, running or playing shows nothing; BUBBLES turns them off. Boot check: a bubble over a forager and over a knapper's tent.

---

## 3. Vitals

### 3.1 Energy

Energy runs 0–1 and is spent only above a sustainable pace (`src/wildlife.ts`):

```ts
export const SUSTAIN = 0.42;
export const PERSON_STAMINA = 60;      // seconds of flat-out work, from full
export const SLEEP_SECONDS = 22;
export const RECOVERY_SECONDS = 70;
export function energyRate(effort, stamina, recover) {
  const over = effort - SUSTAIN;
  return over > 0 ? -(over * over) / stamina : (SUSTAIN - effort) / recover;
}
```

In `updatePeople`, `effort = speed / PERSON.jog / (p.stamina || 1)`.

- **Walking is free.** A walk's effort is 0.375, below `SUSTAIN`, so it pays back.
- **Jogging costs.** A full jog costs about 0.0056 energy per second, a tank in about three minutes (derived). But anything above a walk is scaled by `clamp(energy × 1.4, 0, 1)`, so below 0.71 energy the jog is already fading, and a spent person walks. A child's jog costs a third as much.
- **Riders spend a walk's effort.** A mounted person's effort uses `min(speed, walk)`. With the horse's speed counted, 88 people died of exhaustion against 2 without horses. After this rule and the panic rule (3.2), both came out at 165 (measured, commit `efb585f`).
- **Recovery.** Standing recovers `0.42/70` per second; sleeping `0.42/22`, about 3× faster. Positive rates are multiplied by:
  - `fed` = `1 − 0.55 × camp.hunger`;
  - `heal` = `(sick ? 0.55 : 1) × restBoost`, where `restBoost` is 1.6 resting out or 4 resting at home, only for someone who sat down on purpose;
  - `comfort` = `1 + 0.55 × wares`.
- **Cold.** For the played person, the cold takes back `(1 − p.cold)` of the gain.

Hunger lifts the foraging weight even for someone tired, and resting is worth something only with food to recover on. Before that rule, a starving, weak band spent 58% of its time at the fire and 2% hunting (measured, noted in `chooseJob`).

> Tests guarantee: walking never drains a person; a jog runs one down in a few minutes and a child at play lasts much longer; sleep refills faster than rest; one rate function serves people and animals; a spent person drops to a walk; hunting wants a rested body; energy survives a reload; a rider sits and the horse runs.

### 3.2 Nourishment, starvation and exhaustion

Starvation lowers a ceiling, `p.nourish`; energy is clamped under it every step:

```ts
p.nourish = clamp(p.nourish + (camp.hunger > STARVE_FROM
  ? -(camp.hunger - STARVE_FROM) / (1 - STARVE_FROM) * STARVE_DRAIN
  : REFEED) * days, 0, 1);
if (p.energy > p.nourish) p.energy = p.nourish;
```

- `camp.hunger` = `clamp(1 − daysOfFood / 6, 0, 1)`.
- `STARVE_FROM` = 0.82: the lid starts falling below about 1.08 days of food.
- `STARVE_DRAIN` = 0.16 per sim-day at total hunger. An empty store takes about 6.25 sim-days to reach zero (derived).
- `REFEED` = 1.4 per sim-day, so a fed band is back up within a day.

At zero, the next books pass kills by `exhaustion`, worded "grew too weak with hunger".

Walking cannot reach zero energy, and jogging is capped by energy, so exhaustion has two routes:

1. **The nourishment lid.**
2. **A panic run.** `if (panic > 0) want = max(want, jog)` is applied *after* the energy cap. A band once panicked at its own fire, over and over, until people dropped. Now nobody within a camp's reach plus its `safeGround` panics.

> Tests guarantee: starvation is a ceiling, not a drain, on the calendar rather than the frame clock; recovering is quicker than falling; a comfortable camp never starves; an empty store takes a season to kill, and a lean one far longer; nobody already behind the fire runs from a tiger.

### 3.3 Sickness and nursing

`updateSickness(days)` (`src/life.ts`) uses `PLAGUE`:

| Constant | Value | Meaning |
|---|---|---|
| `arrival` | 0.010 | Per camp per sim-day, only into a camp with no sick. |
| `winter` | 3.2 | Season factor. Autumn 1.6, spring 1.1, summer 1. |
| `spread` | 0.30 | Per healthy campmate, per sick person, per sim-day. |
| `crowding` | 14 | Camp size at full spread, capped at 1.5×. |
| `runs` | 1.2 | Sim-days ill, × 0.6–1.4. |
| `mortality` / `hungerFactor` | 0.10 / 2.4 | See 1.6. |
| `immuneYears` | 6 | |
| `drag` | 0.55 | Share of pace and of energy recovery kept while sick. |
| `nurse` / `catching` / `tendPer` | 0.55 / 0.16 / 3 | Recovery 1.55× faster when tended; a nurse's daily risk; sick people per nurse. |
| `carried` | 0.22 | Chance a visitor brings it. |

How the rates combine:

- **Cold.** `chill = 1 + (season − 1)(1 − 0.6 × clothing)`: clothing keeps out up to 60% of the season.
- **Spread chance.** `0.30 × sick × min(here/14, 1.5) × (1 − 0.5 × building) × (1 + hunger) × chill × days`.
- **Falling ill** caps energy at 0.5.
- **Recovery.** `sick` falls by `days × (tended ? 1.55 : 1) × restHeal`, where `restHeal` is 2.5 only when resting at home. Getting up caps energy at 0.35 and grants six years' immunity.
- **Behaviour.** The sick never go out: they `sleep` (60%) or `tend`. They are left out of parenting, the chief's first pass, raid strength, and splits.
- **Travel.** No visitor leaves an ill camp. A sickness crosses the island only with someone who left before it showed. The host check in `arriveAtCamp`, `host.people?.some?.(...)`, is always true, because camps have no `people` array.
- **Counting.** `src/ill.ts` counts the ill once per world step. At 9,000 people this cut a step from 5.62 ms to 1.98 ms (measured, commit `8143d73`).

**Nursing.** An adult's `nurse` weight is `(0.35 + 0.40 × min(ill/3, 1)) × (1 − hunger) × rested × sociable`, and `lessonMix` raises it up to 1.8×. Nurses work indoors. Each marks up to 3 sick people as tended and may catch the illness. **Herbs** is a craft skill weighted by the sick share (`0.10 + 1.10 × sick`); mastery takes 55% off sickness mortality.

> Tests guarantee: winter is the dangerous season; surviving buys time; illness slows you; an outbreak spreads, kills some, never wipes out the camp, and ends; a hungry camp fares worse; a nurse shortens illness, can catch it, cannot cover a whole band, and a starving band spares nobody; a guest carries it and the chronicle names them; the ill are counted once a step and recounted on any change.

### 3.4 The life bar (the person you are playing)

The band's own energy barely moves while walking, so `src/vitals.ts` gives a played person (anyone with `p.life`) a **life** bar out of 100. While led, their energy is `max(0.05, life)`.

| `LIFEBAR` | Value |
|---|---|
| `idle` | 0.0004/s |
| `walk` / `run` | 0.0012 / 0.004 per s, scaled by speed, × `(1 + loadFrac)` |
| `work` / `sick` | 0.0008/s each |
| `cold` | 0.0025/s × `(1 − p.cold)` |
| `rest` | 0.002/s out, 0.005/s at home (half while sick) |
| `restCap` | 0.6 out, 0.8 at home: rest alone never fills the bar |
| `meal` | 0.3 |
| `runFrom` / `weakFrom` / `crawl` | Below 0.2, no running. Below 0.25, pace scales down toward 35%. |

- `coldFactor` applies only to a led person outside every camp: night 0.6, winter 0.5, with clothing keeping out up to 60% of the loss.
- Handed back to the band, a person at home tops up to 1 if the store holds a meal (0.8 otherwise).
- `eat` (N) takes 0.3 food from the store at home, or from the basket elsewhere: berries, vegetables, fruit, fish, then meat. It adds 0.35 nourishment, 0.1 energy and 0.3 life.

> Tests guarantee: life is one bar out of a hundred, worn by walking, running, working, carrying and cold; rest never fills it and a meal does more; worn down, they slow and cannot run; a meal comes from the store at home and the basket elsewhere, berries first; cold and night affect only the played person.

---

## 4. The food economy

### 4.1 The band store

`updateEconomy(days)` runs each books pass:

1. `camp.need` = the sum over the band of `FOOD.adult` 1.0 or `FOOD.child` 0.55, per sim-day.
2. Spoilage and eating:
   ```ts
   const spoil = FOOD.spoil * (1 - SKILL.dryKeep * drying) * (1 - SKILL.farmKeep * Math.min(1, farming));
   c.food = Math.max(0, c.food - c.need * days - c.food * spoil * days);
   c.hunger = clamp(1 - daysOfFood(c) / FOOD.comfortable, 0, 1);
   ```
   The factors are `spoil` 0.18, `dryKeep` 0.65 and `farmKeep` 0.55. They multiply, so spoilage never goes negative. Measured (commit `514f355`):
   - nothing learned: 18% a day, half gone in about 4 days;
   - drying mastered: about 6% a day, about 11 days;
   - drying and farming mastered: about 2.8% a day, about 24 days.
3. `daysOfFood` = `food / need` is the number everyone acts on. The chronicle logs only the crossings: into "nothing left", and back to "food again".

Other flows into the store:

- Granaries stand at `STORE_DAYS` of [0, 6, 15, 30] days of food.
- A tribe's villages share food through `shareTribes`.
- A flock adds milk (7.3).

`ABUNDANCE` multiplies every yield where the food is found: forage, fruit, catch, crop, meat, milk. Food that only moves (raids, gifts, piles) is not scaled again.

Measured history:

- One world's chronicle recorded 1,427 deaths, 1,108 of them hunger and 80% under fourteen (commit `8e01e70`).
- With a fixed 95 m forage ring, a band of 12–15 held 6.4 days of store but a band of 28 held 4.3 (commit `1b6d304`). The ring was widened for bigger bands in response.

> Tests guarantee: an empty store is a hungry camp in all three places a camp is made; the books are opened before anyone picks a job and again after a reload; curing keeps the store and farming keeps it longer; the books run eight times a day, on the same cadence watched or not.

### 4.2 Foraging

**Range.** `[26, 95 × bold × groundFor(camp)]` metres; a child's range is multiplied by 0.55. `groundFor` = `clamp(sqrt(pop/14), 1, 2.5)`.

**Choosing a spot** (`pickForage`). Every candidate is valued in food:

- **Candidates.** 4 bearing trees, each worth 6 fruit × 0.02 on top of the ground; up to 6 remembered patches (`MEMORY.keep`), weighted ×1.25; and 6 fresh random guesses.
- **Rejected** below `SEA + 1.5`, at flatness under 0.80, or beyond 0.44 × `WORLD`.
- **Value.** `((0.44 × forageRichness + fruit) × (1 − theirs) × known × dreadOf − (away/100) × 0.08) × guess`.
  - `theirs` = `GROUND.shy (0.55) × (1 − hunger)` when the spot is nearer another band's fire (within `GROUND.range`, 105 m);
  - `dreadOf` shuns ground within 70 m of a tiger death;
  - `guess` is jitter of 0.78–1.22.

**Yield** is taken where the trip ends, even if the forager gave up on the way:

```
got = (0.44 × forageRichness(x,z) + pickFruit(x,z)) × (1 + 0.90 × baskets) × childWorth × abundance
```

- The bag counts berries (`ground × hands / 0.02`, at least 1) and fruit (`fruit / 0.02`).
- `takeForage` marks the cell as worked.
- `rememberPatch` stores `got × 0.82`, merging within 18 m and keeping the best six.

**Ground that gives out** (`src/larder.ts`, `FORAGED`):

- The island is an 8 m grid. Each trip adds 0.38 to a cell's picked share, capped at 0.85, so there is always something.
- `forageRichness` = `(0.55 + fbm) × forageSeason × (1 − picked)`. Season factors: spring 1.00, summer 1.15, autumn 0.90, winter 0.35.
- `recoverForage(days)` gives back `min(1, 0.22 × days)` of what is missing, walking only worked cells.
- In the current source `recoverForage` is called only from `stepWorld`'s books, not from the watched frame's. Picked ground recovers during night skip, Run years and background running only. The fast check only asserts that the call appears in `main.js`.

**Crowding** (`updateGround`). If a rival camp is within 1.7 × 105 m and hunger is above 0.62, the camp builds `pressed`. After 40 sim-days, lengthened by up to 2.5× with `rites`, the side with fewer adults moves at least 200 m from any camp.

> Tests guarantee: a forager weighs spots in food, trees included, so a tree on poor ground loses and distance counts; the ground remembers what was taken, where the trip ended, grows back proportionally and never to nothing; two foragers leaving together need not agree; the bold and bigger bands go further; a hungry band stops respecting others' ground; the smaller band moves; foragers avoid where a tiger struck. Boot check: foraging spreads over the ground and no patch is picked to nothing.

### 4.3 Hunting

**Setting out.** `findPrey` looks for the nearest living `QUARRY` animal within `300 × (1 + 0.5 × tracking)` m. A species below 40% of its number (`FOOD.minStock`) is skipped. With nothing found, the hunter walks 90–260 m (× bold) and returns empty.

**Killing** (`tryKill`). The hunter re-aims at the animal every step. Within 9 m, every 0.7 s, the kill chance is `q.chance × (1 + 1.2 × spears)`.

| `QUARRY` | meat | chance | regrow |
|---|---|---|---|
| bison | 45 | 0.07 | 0.06 |
| boar | 14 | 0.11 | 0.16 |
| deer | 20 | 0.10 | 0.12 |
| rabbit | 2.5 | 0.06 | 0.35 |

A kill adds `meat × animal scale × abundance` to the haul, puts the animal in the bag, adds to `p.kills`, and sends the hunter home carrying it at once. Hunters jog. Children and the band's hunters never hunt tigers or horses.

**A played person's throw** (`src/spear.ts`, `THROW`):

- Reach 16 m.
- Chance `0.85 × (1 − 0.7 d/16) × (1 + 1.2 × spears) × (q.chance/0.10) × (hiding ? 1.25 : 1)`, at most 0.95.
- At a tiger the base is 0.4, capped at 0.75, and a miss brings it on.
- A kill lies where it fell for a day until E picks it up.

> Tests guarantee: a better spear kills more often; hunters do not chase tigers; a spear brings the animal down where it stood, it lies still until picked up, and is carried as meat; a throw from down low is surer.

### 4.4 Carrying (`src/bag.ts`)

`haul` is food. `bag` counts fruit, berries, fish, game plus the `animal`, ore plus `oreKind`, wood and vegetables. `bagWords` names at most two things.

| Item | Weight (basketfuls) |
|---|---|
| berry / fruit | 0.02 each (also 0.02 food) |
| fish | 0.1 (0.1 food) |
| vegetable | 0.05 (0.05 food) |
| rabbit / boar / deer / bison | 0.3 / 0.8 / 0.9 / 1.6 |
| stone / ore / log | 0.35 / 0.3 / 0.2 |

- **Capacity.** `carryCap` = `1 × (1 + 0.9 × baskets) × (child ? 0.5 : 1) × carryMul`. One basketful is 50 berries, or 10 fish, or 20 vegetables; a bison is more than anyone can carry.
- **Pace.** `loadPace` = `1 − 0.7 × (load/cap)^1.3`, and 0 at or past full.
- **The band versus the played person.** The band's own carriers take a flat 0.8 pace while carrying, since they cannot put a load down. A played person uses `loadPace`, and when `tooHeavy` cannot walk, though they can still act within reach.

> Tests guarantee: a basketful is a load of one; fuller is slower and full is stopped; better baskets carry more and a child half; only the played person is weighed down; too heavy to walk still lets them act in reach, but not be sent anywhere.

### 4.5 Bringing it home

A finished errand turns into `return`, aimed by `homeward`:

- **Carrying food:** to the front of the nearest standing granary, or the first granary spot if none stands.
- **Empty-handed:** to their own fire.

On arrival, `bankLoad(p)`:

- adds stone to the pile (capped at `SKILL.stoneMax`, 40) and metals to `camp.ores`;
- sends wood to `storeWood`;
- adds food to `camp.food`, and to `p.brought`, the per-person tally shown on the card and read by role play;
- empties the bag and sets `p.stowed` for the storing bubble.

If a walk home times out, the person goes idle with the carry flag cleared but the haul still on them. It is banked at their next completed return.

> Tests guarantee: with food, the walk ends at the nearest standing granary, and empty-handed at their own fire; running from a tiger still goes to the nearest fire; the basket empties into the store and survives a reload. Boot check: the card lists what each member carried, and the band total is their sum.

### 4.6 Piles on the ground (`src/drops.ts`)

G takes one handful out of the bag (`takeOut`); shift+G takes everything. The order is:

1. an animal;
2. a stone or ore lump;
3. a log;
4. then fish (1), vegetables (5), fruit (5) or berries (10).

The food value comes out of the haul with each handful, and the last handful takes the remainder, so nothing is lost.

- **Placement.** Piles land 0.9 m ahead and merge with a like pile within 1.2 m.
- **Limits.** At most 160 piles; the oldest goes first.
- **Spoiling.** Food spoils after 3 sim-days; stone, ore and wood keep.
- **Pickup.** E within 1.8 m takes the whole pile back.
- Piles are saved with the world.

> Tests guarantee: a handful at a time, all with shift, done in the step; nothing put down is lost; like piles join; food spoils and stone does not; piles survive a reload.

---

## 5. Movement

### 5.1 Speed

`updatePeople` works out `want`, the target speed, in this order:

1. **Base.** Jog for `hunt` or `play` (children at 0.75×), otherwise walk. A led person held with shift jogs.
2. **Load.** × `carryFactor`, when carrying or led.
3. **Life.** `lifeWant` (played person only).
4. **Stopped.** 0 up a tree or resting; `min(want, walk × 0.35)` while hiding.
5. **Energy.** Anything above a walk × `clamp(energy × 1.4)`.
6. **Sickness.** × 0.55 while sick.
7. **Ground and horse.** Off a raft: `riding(p, want × groundPace)`. That applies `paceMul`, and when mounted `× RIDE.pace` (2.2 at a fair hand up to 3.6 at mastery), never above 7.5 m/s.
8. **Panic.** `max(want, jog × (child 0.8))`, after every cap above.

Actual speed eases toward `want` at a rate of `min(1, slice × 3.2)`.

**Timeouts.** `travelTimeout` = `clamp(dist / pace × 2.2, 20, 900)` world-seconds, with 0.8× jog as the pace for hunt and play and a walk otherwise.

> Tests guarantee: the reference day runs at pace 1 and half the day at twice it, within limits; the time allowed is the distance, with room to go round things; illness slows you.

### 5.2 Stepping round things

`stepPerson` is the only function that moves a person on foot:

- **A valid step.** `canStand` needs height above `SEA + 0.9`, flatness above `WALKABLE` (0.66), and a spot within 0.46 × `WORLD` of the centre. `wallBlocks` must also allow it.
- **Straight first.** If blocked, try the offsets in `DETOURS` ([0.30, 0.62, 0.98, 1.40, 1.75] rad) on either side. Once a side works it is held for `DODGE_HOLD` (3 s); if that side runs out, switch sides.
- **Boxed in.** Relax flatness to 0.30. If even that fails, stop and re-aim with `pickWork`. A visit is never abandoned this way.
- **Every step.** The working heading is kept, so a spur is followed round; the stride phase advances by `step / (0.78 × scale)`; `tread` wears the ground.

> Tests guarantee: detours widen to either side and never approach walking backwards; a side is kept until clear or out of room; there is a way out of a pocket; a visit is never given up because of a hillside. Boot check: people cover real ground and nobody who went out is pinned in place.

### 5.3 Paths worn by feet (`src/paths.ts`)

**Wear.** One byte per 1.5 m cell. `tread` stamps along the whole step at `0.055 × weight` per metre; explorers tread at `PATH.blaze` = 2.5. About a dozen crossings take grass to bare earth.

| Wear level | Effect |
|---|---|
| 0.22 | Grass thins. |
| 0.45 | The path shows on the map. |
| 0.72 | Grass stops growing. |
| 230 / 255 (byte) | A trail stops at `TRAIL_MAX`; a road is `ROAD` and never fades. |

**Fading.** Wear decays by `exp(−days/30)`, applied every 4 sim-days over live cells only. Wear is not saved.

**Ground pace.** `groundPace` is 0.42 wading in a creek or lake, 1.12 on a road (wear ≥ 0.94), and `0.82 + 0.18 × min(1, wear/0.72)` elsewhere.

**Swerving.** Every 0.4 s `pathSwerve` scores the headings 0, ±0.35 and ±0.7 rad by average ground pace 2 m and 4 m ahead, times the cosine of the offset. A new heading must beat the held one by 4%. Nobody swerves on a raft, led, panicking, chasing, hiding, or within 8 m of the goal.

Measured: a single crossing by an explorer used to leave about 0.08 wear, against the 0.22 at which grass even thins (commit `f1aa209`).

> Tests guarantee: one walk marks the ground but is not a path, a daily route is bare within a fortnight and its sides untouched; wear stops at fully worn and an unwalked path grows over; off-path is slower, trail full pace, road quicker; walkers hold a heading unless another is clearly better; the played person, a chase and a fright go straight; wading is slowest. Boot check: walking wears only the ground walked on, down to earth.

### 5.4 Walls, gates and roads (`src/walls.ts`)

**Walls.** `dressCivic` hands over walls as rings with gate angles.

- `wallBlocks` refuses any step that crosses a ring unless the step's midpoint lies inside a gate (within 0.8 of the gate's half-width).
- `viaGate` sends a walker whose target is across a wall to the shortest-way gate: first to a point 3 m (`GATEWAY`) before it on their side, then through. From outside, if the straight line to that point would cross the town, they circle the wall at up to 0.5 rad at a time.

**Roads.** `layRoads` hands over the road network through `setRoadNet`: the segments, Floyd shortest paths between them, and `slow` = `TREAD.rough / TREAD.road`. `wayTo` plans a route once per errand, and replans only when the target, the network or inside-versus-outside changes.

| `ROADWALK` | Value | Meaning |
|---|---|---|
| `min` | 30 m | Shorter walks never take a road. |
| `on` | 3 m | A route point counts as reached. |
| `gain` | 0.97 | Away from gates, the road must beat walking straight. |
| `detour` | 1.3 | Leaving or entering by a gate, the road may be this much longer. |
| `gate` | 15 m | How near a gate's road end counts as "just came out". |
| `stall` | 240 | Looks without progress before the route is dropped. |

- Inside a wall, the gate comes first.
- Someone on a raft, led, panicking, chasing or hiding gets only `viaGate`.

Measured (commit `454e3a4`): 60 people sent 440 m out from a city plaza all used a gate, none crossed the wall, 82% of their outside steps were on the road, and all arrived within 7 minutes. Before the gate allowance, only 3% of those steps were on the road. In commit `d73ad5f`, 12 people started outside the wall all got in through a gate.

> Tests guarantee: a step through a wall is refused unless through a gate; walkers head for the gate and round the wall to it; the walls walked against are the walls built; the network is handed over split at junctions, dry stretches only; a forager nowhere near the road just walks.

### 5.5 Horses, as they affect walking

- **Who.** Only the chief and a city's patrol riders ride (`mayRide`), once the band's `riding` is at least 0.5.
- **When.** The trip must be at least 70 m, with a free horse within 180 m.
- **Walls.** A rider dismounts 8 m before entering a wall; nobody rides inside one.

Measured: one rider covered 300 m in about 90 s at 3.5–4.2 m/s, against about 240 s on foot (commit `efb585f`). Taming and patrols are described in the wildlife and society sections.

### 5.6 Turn-taking and being led

**Turn-taking** (`src/clock.ts`, `LOD`):

- `lodStride(n)` is 1 for up to 24 people. Above that it is `min(cap, ceil(n/24))`, with a cap of 8 while watched and 64 unwatched.
- `updatePeople` steps every `stride`-th person from `turnStart`, with `slice = dt × stride`.
- The followed person is exempt and stepped every frame with `dt`.
- Watched frames also call `tickWorldStep`. When they did not, only 24 of 95 people who should have been on screen were stepped (measured, commit `97683d0`).
- Raising the watched cap from 4 to 8 halved the figures written per frame at 445 people, from 111 to 56 (commit `e844e79`).

**Being led.**

- A ground click or WASD (4 m ahead) sets `p.led`. The job becomes `led` and the target is the lead point.
- **Skipped while led:** tiger flight, dusk recall, errand timers, road planning, and swerving.
- **Not skipped:** tiring, hunger, the nourishment lid, and a tiger catching them.
- **Orders.** An order (`p.orders`) is taken up once at the next idle. `goingHome` starts the ordinary walk home.
- **Acts.** An E action leaves `p.act` for the step. It runs as the matching errand for `ACT_TIME` (gather 3.5, fish 4.5, quarry 5, tend 3, hunt 1, wood 5 world-seconds, shortened by tools). Afterwards the person stays led where they stand.

> Tests guarantee: group size grows with the crowd; a small world steps everyone; a watched world is grouped gently; a turn is worth the time it waited; a predator or ridden animal is never grouped; the followed person is not grouped. Being led: they walk on their own, shift runs and is charged, nothing else steers them, but being led is no shield; an order is taken up once.

---

## 6. The day: jobs and errands

### 6.1 The errand loop

Each person cycles through four states:

1. **`idle`** (2–8 s). Take up an order or `chooseJob`, then switch to `goto` with `travelTimeout`.
2. **`goto`**. Arriving within 1.1 m switches to `work`. On timeout, work results apply where they stand; visits, raids, quarrying and farming check the person actually arrived.
3. **`work`**. Results apply (section 7), then `return`, aimed home.
4. **`return`**. On arrival, `bankLoad`, then `idle`.

Work timers, where `quick` = `1 − 0.45 × tools`:

| Job | Seconds |
|---|---|
| hunt | (8–22) × quick |
| gather | (6–16) × quick |
| farm | (8–20) × quick |
| sleep | 600 |
| everything else | (10–30) × quick |

A raft trip replaces the fishing timer with the trip length. A patrol rider's timer for each beat point is `40 + dist/1.2`.

> Tests guarantee: tools make every errand shorter.

### 6.2 Night, dusk, sleep and indoors

`day` is daylight, `smoothstep(−0.10, 0.14, sun height)`.

- **Night job.** When `day < 0.25`, a new job is `sleep` (55%, walking to their own hut) or `tend` (45%, at their own fire).
- **Waking.** Once `day ≥ 0.25`, sleepers wake within 0–4 s.
- **Dusk recall.** At `day < 0.25`, anyone not led whose job is not sleep, tend or explore is sent home if more than 12 m from their fire; closer than that, they idle and pick a night job. The 12 m test is what stopped a band circling its own fire all night. **Explorers are exempt.**
- **Asleep** = job `sleep`, arrived, not in `goto`. Sleep recovers energy about 3× faster than standing, and puts a person out of a tiger's reach.
- **Visit timing.** `canVisit` needs the daylight left before `DUSK_AT` (18:00) to cover the round trip at a walk × 1.4.
- **Indoors.** `indoorsNow` is true for anyone under 4. Otherwise it is false for any job in `OUTDOOR_JOBS` (`gather, hunt, visit, market, play, tend, led, mourn, quarry, raid, fish, wood, explore, tame, patrol`), and otherwise true inside any camp's reach. So craft, nurse, sleep and idle people at camp are indoors.
- **Hidden.** `p.hidden` = asleep or indoors. Hidden people are parked and undressed only while drawing, and are still fed, made ill and counted.
- **A gap.** `farm` is not in `OUTDOOR_JOBS`, so a farmer inside a settlement's reach is not drawn.
- **Night skip.** `nightIdle` runs the night through once everyone is asleep or within their camp, and always runs it below `P.nightDeep`.

> Tests guarantee: an errand either takes you out or it does not, and sitting at the fire and being led are outside; everything else is under a roof; indoors stops drawing but is not asleep and nothing stops counting them; stragglers hold the clock only at the edges of the night; dusk follows the sun; explorers ignore dusk. Boot check: some of the band is indoors and some out.

### 6.3 Children and the sick

`chooseJob` handles, in order:

1. **Night** (6.2).
2. **The sick:** sleep (60%) or tend.
3. **Children aged 8 or older:** gather with probability `0.25 + 0.55 × hunger`.
4. **Other children:** play (75%; in a city half of that in the market square) or tend.

Children never visit, hunt, craft, farm, quarry, cut wood, raid or nurse.

### 6.4 The job weights (adults)

`chooseJob` rolls a job in proportion to these weights, where `h` = camp hunger, `r` = energy, `ill` = the camp's sick count, and `restWorth` = `(1 − r)(1 − h)`. If the roll finds nothing, the job is `gather`.

| Job | Weight | Only when |
|---|---|---|
| `gather` | `(0.28 + 0.54h) × (0.3 + 0.7r + 0.7h)` | always |
| `hunt` | `(0.14 + 0.28h) × max(r², 0.25h)` | always |
| `craft` | `0.30 × (1 − h)` | always |
| `tend` | `0.06 + 0.12(1 − h) + 0.5 × restWorth` | always |
| `nurse` | `(0.35 + 0.40 min(ill/3,1)) × (1 − h) × r × sociable` | someone in the camp is ill |
| `visit` | `0.10 × r × sociable` | a host exists, `r > 0.5`, daylight enough, camp not ill, and `h < 0.45` or `h > 0.70` |
| `market` | `0.22 × r × sociable` | the camp has a market |
| `mourn` | `0.10 × (1 − h) × r` | someone is buried |
| `quarry` | `0.12 × (1 − h) × r` | a deposit in reach (stone only while the pile is under 40) |
| `wood` | `woodWant × (1 − 0.7h) × r` | 0.12 on a coast with no raft, 0.042 with under 8 logs, else 0 |
| `explore` | `exploreWeight` (7.5) | bold ≥ 1.15, age ≥ 16, not sick |
| `farm` | `farmWeight` (7.3) | the band has a field with a ditch path |
| `tame` | `0.12 × (1 − h) × r` | `h ≤ 0.5`, room for another horse, a herd of 3+ wild within 450 m |
| `patrol` | `1.2 × r` | the person's role is patrol |
| `fish` | `0.30 × (0.4 + 0.9h) × r` | a raft that is not out |
| `raid` | `0.55 × h × r × (warrior ? 2.5 : 1)` | `h > 0.80`, `r > 0.4`, over 2 days since the last raid, a target exists |

Before the roll, each weight is multiplied by:

1. **`roleWeight`:** 3.2 (`LEAN`) for the role's own job, 0 for a job the role refuses.
2. **`jobMix`:** the settlement stage's `mix` (a city: gather 0.45, hunt 0.45, farm 1.9, craft 1.5, visit 1.6), blended from the previous rung over a year and pulled back toward 1 by hunger. Gather and hunt are also × `(1 − 0.55 × farming × (1 − h))`.
3. **`lessonMix`** (7.8).

**Fallbacks** when a chosen job has nowhere to go:

| Job | Falls back to |
|---|---|
| fish (no raft), raid (no target), explore, tame, wood | gather |
| quarry | craft |
| patrol, market, visit | tend |
| hunt with no prey | walks 90–260 m out and back |

A `tend` spot sits 1.8–4.0 m (`FIRESIDE`) from the fire; other in-camp errands pick a random spot 2–9 m from the centre.

Measured (commit `0d685e1`): when choice ran on hunger alone, a fed farming band spent 14% of errands foraging and 7% hunting, against 41% knapping and 38% at the fire. With routine weights, a fed band forages about 17% and hunts 8%, and a starving band still forages 85%.

> Tests guarantee: the page weighs jobs the way the harness does (the harness reads the page's formulas); a starving band looks for food and spends almost nothing at the fire; a fed band still has time for everything and still forages and hunts daily; foraging rises with hunger at every tiredness; a role leans rather than replaces, and refusing is a zero; the stage leans the list before rolling; a farming band leans to its field.

### 6.5 Roles

`assignRoles` runs once a day, and only for a band with at least 6 adults and 8 days of food. Otherwise everyone's role is `null`.

| Role | Leans to | Refuses | Picked by `knows` | Share of adults |
|---|---|---|---|---|
| chief | tend | gather, hunt, quarry | — | — |
| hunter | hunt | — | spears | 0.16 |
| knapper | craft | hunt | tools | 0.10 |
| healer | nurse | hunt | herbs | 0.08 |
| keeper | tend | hunt | fire | 0.08 |
| quarrier | quarry | — | mining | 0.08 |
| trader | visit | — | trade | 0.06 |
| warrior | tend | — | war | 0.12 |
| fisher | fish | hunt | fishing | 0.14 |
| patrol | patrol | gather, hunt, quarry, farm, wood, fish | riding | cities only: `min(horses, ceil(adults/30))` |
| forager | gather | — | — | everyone else |

- Each role wants at least one holder, drawn from the best `knows` values; a candidate needs `knows` above 0.02.
- Nobody holds two roles.
- In role play, the player's chosen role is assigned first.

> Tests guarantee: a band specialises only when it can afford to and gives roles up when it cannot; the chief does not forage or hunt; roles go to whoever is best; nobody who has never seen a rock becomes a quarrier; nobody holds two; roles are worked out once a day; only a city has patrols, one per thirty, never more than its horses.

---

## 7. Trades

### 7.1 Fishing and rafts

**Where the fish are** (`src/larder.ts`):

- `fishAt` = `0.9 × clamp((SEA − h − 3)/18, 0, 1) × (winter ? 0.75 : 1) × (1 − picked)`. Fish are in deep water only, and fishing uses the same picked grid as foraging.
- `fishRichness` is 0 without a raft.
- `camp.shore` is found once, within 190 m of camp.
- `dockOf` builds a 7 m dock on the bearing with the most water, with the raft moored 1.8 m past its end.

**A band's trip** (`src/rafts.ts`):

1. The fisher walks to the dock.
2. `pickFishing` tries 6 spots in a ±0.8 rad fan, 35–130 m out.
3. The timer is `2 × dist/2.2 + 18–38` s, and position along the trip is worked out from the timer. `camp.raftOut` is set: one raft, one fisher at a time.
4. On completion, `got` = `fishRichness × (1 + 0.9 × baskets) × (1 + fishing) × childWorth × abundance`, which adds `got/0.1` fish.
5. `takeForage` marks the water, `landRaft` puts the fisher back ashore, and `fishing` is practised at 0.022.

**A played person** takes the raft out with E within 4 m of the landing, paddles where the water is at least 0.35 m deep, fishes with E, and ties up with E.

> Tests guarantee: a catch is the same haul, off the same ground, in the same baskets; the fish are in deep water and there is no fishing without a raft; a coastal band builds one from stacked wood; one raft, one fisher; a raft and its rider survive a reload ashore; winter takes less off the water. Boot check: no fishing from the bank; E out, fish, and tie up.

### 7.2 Wood and the woodpile (`src/wood.ts`)

`WOOD` constants:

| Constant | Value |
|---|---|
| `chance` | 0.12 |
| `keep` | 8 logs |
| `perTrip` | 3 logs |
| `practise` | 0.02 |
| `raft` | 12 logs |
| `near` / `far` | 12 / 150 m (the band's stand of trees) |
| `reach` | 2.4 m (for E) |

- **The trip.** `pickTree` takes the nearest of 4 random trees in the stand. `chopDone` adds `max(1, round(3 × (1 + woodcraft) × (child ? 0.5 : 1)))` logs, carried on the shoulder.
- **The stack.** `storeWood` adds to it. On a coast with no raft, reaching 12 logs spends them and builds the raft.
- **Drawn.** The pile shows up to 15 logs beside the granaries.

> Tests guarantee: people go for wood with a raft to build or the stack low, to a tree near the fire, back with logs; put away, logs go on the stack; woodcraft is learned at the tree; logs weigh something and the stack is drawn and saved. Boot check: cutting puts logs on the shoulder, and on a coast enough makes a raft.

### 7.3 Farming (`src/farming.ts`)

**Land.**

- **Watered sites.** `surveyFarmland` runs once per world. It checks points every 30 m along creeks (14, 26 and 40 m back on each side) and round lakes. A site needs flatness ≥ 0.8, dry ground, 12 m clear of creeks, and water higher up within 160 m that can run to it (no rise above 1.5 m on the way).
- **Worth.** `soil × (0.4 + 0.6/(1 + ditchLength/40)) × (0.5 + 0.5 × flat)`.
- **Dry sites.** `DRY` lays rings at 60–240 m round the camp, 16 bearings each, for rain-fed sites with a well 6 m toward camp, yielding 0.7× a watered field.
- **Choosing.** `fieldOf` keeps an existing field within 450 m. Otherwise it picks the best watered site, then the best dry one, scored `worth / (1 + d/300)` and clear of other camps and fields (12 m fallow).

Measured (commit `c1b34ab`): on a 4,800 m map only 2 of 12 camps had irrigable land in reach, and growth stalled near 90 people a camp. With dry farming, 12 of 12 have a field.

**Ditch, then crop** (`farmDone`):

1. **Dig.** While the ditch is unfinished and the farmer is within 14 m of its working end: `ditchDug += 6 × (1 + irrigation)`. Otherwise the farmer must be within the field's reach.
2. **Irrigation.** `practise(irrigation, 0.03)`, dropping to a quarter of that once past 0.5.
3. **Gate.** Nothing is sown until irrigation ≥ 0.5 (`FARM.irrigateFirst`) and the ditch is done.
4. **Crop.** `practise(farming, 0.026)`, and a crop of `0.9 × (0.3 + 0.7 × farming) × forageSeason × abundance × (city 1.5) × (dry 0.7)`, carried as vegetables, with the hoe in hand.

**Weight.** `farmWeight` = `0.32 × pull × r × (1 + 2.2 × farming)`. `pull` is `1 − h` while farming is below 0.1 (a fed band learns), then `0.5 + 0.9 × h × farming` (a hungry band leans on a field that pays).

**Field size.** Nothing is drawn until irrigation reaches 0.1. Then the area is `30 m² × max(6, pop) × max(0.15, farming, 0.25 × irrigation)`, with rows 1.6 m apart and no maximum. Rows and plants are placed only on growable ground: never on water, camps, tents, stores, hearths, civic buildings, graves or other fields.

**Livestock** (`updateLivestock`):

- At farming ≥ 0.5 the band pens a pair.
- The flock grows logistically at 0.08 a day toward `12 × farming` head, and each head gives 0.2 food a day.
- A band with nobody left loses its flock at 30% a day.

> Tests guarantee: irrigation comes first and nothing is sown until the ground can be watered; the field is on farmland by water, fed by a ditch dug from upstream a stretch a session; a band with no water to dig from cannot farm (dry farming aside: a well, a lower yield, kept on reload); farmland is found for the island and remembered; the flock feeds the store every day on both sets of books; a field grows with the band and round what stands there. Boot check: every ditch runs to its field.

### 7.4 Quarrying and toolmaking

**Choosing a deposit.** `pickDeposit` rolls among deposits weighted by `ORES[kind].want / (1 + dist/120)`, within each ore's reach: stone 220 m, iron 360, bronze 400, silver 450, gold 500. Stone is skipped while the pile is full; metals never are. `QUARRY_TRIP.reach` is declared but not read.

**Digging.** Within `depositRadius + 7` m of the deposit, the quarrier takes `per × (1 + mining)`: stone 1, iron 2, bronze 2, silver 1, gold 1. Mining is practised at 0.024, and the take is carried home.

**Toolmaking** is a craft choice, weighted `0.30 + 0.35h`, available only with at least 0.6 stone, and it spends that stone. At mastery, tools shorten every work timer by 45%.

**Other crafts.** `craftChoice` also offers spears, baskets, drying, tracking, fire, herbs, wares, building and clothing (most in autumn and winter). Each session gives `practise(key, 0.028 × quick)` and raises the crafter's own `knows`. A band is capped at `bestKnown + 0.14`, and every skill fades by 0.010 a day. Skills have their own section.

> Tests guarantee: quarrying happens at a rock someone can see; not on an empty store, nor for stone with a full pile; better quarriers bring more; the pile is capped; toolmaking needs stone and spends it where it is used; a band chooses among deposits rather than always the nearest; ore is carried home to the pile, not the food store; practice teaches the hands doing it, a little past the best memory.

### 7.5 Exploring (`src/explore.ts`)

`EXPLORE` constants:

| Constant | Value |
|---|---|
| `bold` | 1.15 |
| `chance` | 0.10 |
| `near` / `far` | 0.16 / 0.45 × `WORLD` |
| `keep` | 6 |
| `notable` | 0.55 |
| `flat` | 0.9 |
| `push` | 2.5 |
| `lookRings` | [30, 60, 90] m |

- **Weight.** `0.10 × (1 + (bold − 1.15) × 4) × r × (1 − 0.8h(1 − crowd)) × (1 + 2.5 × crowd)`. `crowding` is the larger of population over the band's split size and `pressed/40`. A fully crowded band sends 3.5× the explorers, and hunger no longer holds them back.
- **Where.** `pickFar` tries 10 land points 0.16–0.45 × `WORLD` out, scored by distance to the nearest camp × 0.4 if within 90 m of a known find × jitter.
- **Survey.** `surveyDone` scores the arrival point and 8 bearings on each look ring with `siteWorth`: forage at 45 m, +0.2 for a shore within 180 m, +0.15 for stone within 220 m, + `min(1, empty/900) × 0.25` for room, + `(flat − 0.9) × 2`. It keeps the best six finds, and logs a new best above 0.55.
- **Explorers** tread paths at 2.5×, ignore dusk, and their finds are where a splitting band settles (`foundSite`).

**Founders can never explore** (derived from `inheritTrait`, not measured). With no parents, bold falls in [0.85, 1.15), always under the 1.15 gate. Only people born in play with bold parents can reach it. The fast check "about one in five" computes its share as if founders spread across the full ±0.30.

> Tests guarantee: only the bold go, the bolder the more; they go far, to empty ground not already looked at; dusk does not call them home; a place is weighed by food, water, stone, room and flatness; a split settles at the best find, and finds survive a reload. Boot check: a splitting band settles on the find.

### 7.6 Visits and markets

**Choosing a host.** `otherCamp` picks the camp with the smallest `distance / (1 + 2.2 × art + 1.6 × stonework)`, so a band with a monument or pyramid counts as nearer.

**Arrival.** `arriveAtCamp` runs only if the visitor ends within 41.6 m (1.6 × `CAMP_CLEARING`). In order:

1. **Sickness.** From an ill band, a non-immune visitor makes one host fall ill with chance 0.22.
2. **Knowledge.** The host takes any skill where `visitor.knows × 0.9` beats its own by more than 0.02.
3. **Ties.** `calledOn` teaches trade and ties the two bands.
4. **Stone.** Home's stone above 2.4 goes to a host holding under 20, at `spare × 0.30 × (1 + 0.6 × trade) × tradeEdge`.
5. **Food.** If home has more than 6 days' surplus and the host's hunger is over 0.5, it moves `surplus × min(0.30 × (1 + 0.6 × mean trade) × tradeEdge, 1)`, logged at most once a quarter-year.
6. **Staying.** Once in a life, a visitor under 30 stays with chance 0.14 (`VISIT.stay`), if the host has an eligible fertile adult of the other sex.

**Marrying out was tried and removed.** A note in `src/life.ts` records that weighting who stays by which sex a band lacks prevented dead-end bands, but over seven paired seeds 5 of 7 worlds stayed peopled with it against 7 of 7 without (91 people against 89). More mothers drove bands through the food ceiling (measured, recorded in source).

**Markets.** In a city, a market trip goes to a stall and teaches trade at 0.008.

**City draw.** Young adults (16–30) who have never moved, from any band of at least 8, may move to the city that draws them most and walk there. Measured: one fed city grew from 50 to 97 people in 20 days (commit `f790183`).

> Tests guarantee: a band finds its neighbour and somebody walks over; a hungry band goes to ask and a band with surplus takes some over, stone too; knowledge travels when there is nothing else to carry, but not what the host already knows; trading is learned on both sides and never moves more than there is; a visit counts only if they got there, and is cleared either way; a monument pulls neighbours by counting as nearer; the young walk to a city from across the island.

### 7.7 Mourning

A `mourn` trip goes to 2.5–5 m from the barrow and does three things:

- practises `rites` (0.012);
- practises `art` (0.020), which raises the monument over the years;
- with at least 0.5 stone in the pile, spends it on `stonework` (0.022): headstones, the kerb, the pyramid.

It happens only where someone is buried, and it is the first errand a hungry band drops. `rites` also slows how fast a band abandons its ground and forgets its lessons.

> Tests guarantee: going back is a job; a band with no dead has nowhere to go; a hungry band stops; standing there teaches it; stones are raised by the people who go back, only where there is ground to raise them on.

### 7.8 Lessons from deaths (`src/lessons.ts`)

`learnFrom(p, cause)` runs for every death:

| Cause | Lesson | Skill practised (0.02) |
|---|---|---|
| hunger | `famine` +1 | drying |
| exhaustion | `overwork` +1, `famine` +0.5 | — |
| sickness | `sickness` +1 | herbs |
| infancy | `infants` +1 | — |
| tiger | a bad place (merged within 45 m, at most 10 kept) | fire |
| raid, while raiding | `raiding` +1 | — |
| raid, while defending | — | war |

- **Fading.** A lesson halves every `12 × (1 + 2 × rites)` years, and adds up when taught again.
- **Announcing.** The chronicle announces a lesson when it first reaches 1, and again only after it has faded below 0.3.
- **Inheritance.** A daughter band inherits lessons at their current strength, and lessons are saved.

Effects:

- **Famine** (gather, hunt, fish, farm): × `(1 + 0.8 × short)`, where `short` = `clamp(1 − days/(6 + 25 × min(2, famine)), 0, 1)`. A band that remembers famine works for food until it holds up to 56 days. Births are unchanged.
- **Other job weights:** raid × `1/(1 + 0.6 × raiding)`; nurse × `(1 + 0.8 × min(1, sickness))`; tend × `(1 + 0.5 × min(1, overwork))`.
- **Bad places:** `dreadOf` cuts forage value by up to 0.9 × strength, out to 70 m.
- **Infants:** `infantCare` scales infancy hazard by `(1 − 0.5 × min(1, infants))`.

> Tests guarantee: every death is a lesson taken before the dead are gone; each cause teaches what would have stopped it; a lesson halves in `LESSON.half` years, slower with rites; foragers avoid where a tiger struck and nowhere else; a famine band works harder while short and lost raiders raid less; births still run flat out; memories survive a reload.

---

## Notes from reading the source

These are facts about the current tree that a reader might not expect. They were read from the code, not run or measured.

1. **Forage recovery.** `recoverForage` is called only from `stepWorld`'s books, so picked ground recovers only during night skip, Run years and background time (4.2).
2. **Founders cannot explore.** A founder's boldness is always below `EXPLORE.bold`, and the fast check computes its share from a spread the code does not use (7.5).
3. **The winter cloak is unreachable.** `CLOTH.cloak` needs an announced mastery that `skillTier` cannot reach (2.3).
4. **Farmers can be hidden.** `farm` is missing from `OUTDOOR_JOBS`, so a farmer inside a settlement's reach is not drawn (6.2).
5. **One sickness check is inert.** `arriveAtCamp`'s test `host.people?.some?.(...)` is always true (3.3).
6. **Unread constants.** `BUILDS.child` and `QUARRY_TRIP.reach` are declared but not read.
