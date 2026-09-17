# Society and settlements

[Technical documentation](README.md)

How the island's people are organised: bands and tribes, what a band knows, who does which job, how a settlement climbs from band to city, how bands trade with, fight, rule and join each other, horses, everything a settlement builds on the ground, and the chronicle that records it.

All of it runs on the **books** (`main.ts`), kept eight times a simulated day whether the world is drawn or run ahead. Each books call runs, in order:

1. `updateEconomy`: head count, splitting, tribes sharing food, spoilage, granaries.
2. `updateGround`.
3. `updateLives`: ageing, deaths, skill fade, births.
4. `repopulate` and `updateLivestock`.
5. `updateSociety` (stages), `borderTension`, `tradeTies`, `cityDraw`.

Chiefs and roles are worked out once a day (`onNewDay`, `life.ts`). Errands (visits, raids, taming, patrols, the market) are chosen and completed in the per-person step (`move.ts`).

| Module | Owns |
|---|---|
| `people.ts` | `camps`, `people`, the population salt, starting sites, the core camp layout, graves and monuments, `dressCamp` |
| `settlement.ts` | outskirts, city street plans, stores by rung, hall, market, wall, gates, roads |
| `village.ts` | tent, house, store and civic geometry; `tentStyle` |
| `footprint.ts` | dwelling footprints and `pitch` |
| `walls.ts` | refusing steps through walls, gate routing, walking the road network |
| `life.ts` | `VISIT`, `RAID`, `CONQUEST`, `SPLIT`, `GROUND`, chiefs, the chronicle (`logEvent`, `MILESTONES`) |
| `society.ts` | `STAGES`, `SOCIETY`, `jobMix`, development, `BORDER`, `TIES`, `CITY_EDGE`, `MERGE`, `guarded`, `placeName` |
| `skills.ts` | the 22 skills, `SKILL`, practice, fade, rungs, roles |
| `made.ts` | what each skill has made, for the band card |
| `lessons.ts` | what a band remembers from its deaths |
| `explore.ts` | explorers, finds, where a new band may settle |
| `riding.ts` | `RIDE`, taming, riding, paddocks, `POLICE` patrols |
| `chronicle.ts` | the band card and the full chronicle window |

---

## 1. Bands and tribes

A **camp** (`Camp`, `types.ts`) is one settlement at any stage. A **tribe** is every living camp flying the same two-letter code. A conquered or joined place takes its ruler's code, so everything tribal groups by `camp.code`: `villagesOf`, `shareTribes`, `raidTarget` and `placeName`.

### Names, codes, colours

- **Name.** Each band has a "voice" of six favoured syllable onsets (`tribeVoice`). Its name is 2–3 syllables from that voice (`uniqueName`), unique on the island.
- **Code** (`tribeCode`, `ui.ts`). The first letter of the name, then the first second character not already taken, trying in order:
  1. the name's second letter;
  2. the start of a later syllable, last syllable first;
  3. any other letter in the name;
  4. any character of `CODE_LETTERS` (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, which has no I, O, 0 or 1).

  So Tsekash is `TS`. `takeTribeCode` claims the code in `usedCodes`.
- **Colour** (`codeColor`). An FNV hash of the code alone gives `hsl(h 70% 70%)`, so a years-old chronicle line still colours `[TS]` correctly. The same colour is used for the chip (`tribeChips` marks up every `[XX]`), the map dot, the population chart, the flag (same hue at 0.7 saturation and 0.5 lightness) and dyed clothing.

> **Guaranteed by tests** (`tribe codes`, `world codes`): codes come from the name, twenty bands sharing a first letter get twenty codes, and codes one letter apart get clearly different colours spread over the wheel.

### Starting sites

`chooseCampSites(count)` runs before trees are placed, so each camp gets a clearing.

- **Draws.** Up to 200 per camp, at radius `(90 + sqrt(u) × 320) × MAP_SCALE`.
- **Rejected spots.** Below `SEA + 4`, above `SNOW − 25`, in water, or within `CAMPS_APART` (260 m) of another camp. `CAMPS_APART` is deliberately not scaled by the map: when both the radius and the spacing scaled, every map size held the same handful of bands.
- **Choice.** The flattest remaining spot, with flatness halved within 22 m of a creek. The search stops above 0.985.
- **New camp state.** Each camp gets its own random stream and starts with `hunger: 1` and an empty store. Measured (97683d0): a literal `hunger: 0` had sent 21% of a new band out to forage instead of 96%.

### Population salt and Reset population

The ground comes from `P.seed`. The people come from `peopleSeed() = P.seed ^ peopleSalt`, which seeds:

- starting sites, names and colours, and the founding people;
- bands founded later (`splitCamp`, `campFromRecord`);
- monument forms;
- the simulation stream (`seedSim(peopleSeed())`).

**Reset population** (`resetPopulation`, `ui.ts`):

1. Removes this world's chronicle lines, locally and on the server (`DELETE /api/events?seed=`).
2. Clears the save.
3. Sets a new non-zero salt and resets the day and the born and died counts.
4. Rebuilds.

Every hill, stream and deposit stays, and so does the world's place on the shelf. Salt 0 is the original people (XOR with 0 changes nothing), so worlds built before the salt existed are unchanged. The salt is saved as `ps`, and entering another world resets it to 0.

Measured (5a808e8, headless): after a reset, terrain, streams, lakes and deposits were identical and the bands were not; salt 0 rebuilt the original bands exactly.

> **Guaranteed by tests**: the boot check has the destructive buttons start unarmed, arm on the first click, and leave "the same world, still on the shelf". The commit notes these clicks sit behind `if (modelsVendored)`, which was false on the checking machine, so they did not run there.

### Splitting

Splitting is the only way a new band comes to be. `updateEconomy` splits at most one camp per books call, and only when:

```
c.pop >= SPLIT.at * STAGES[c.stage].split     // see the stage table in section 4
&& daysOfFood(c) > SPLIT.needFood
&& simDay - c.splitAt > SPLIT.everyYears * P.yearLength
&& no camp on the island has split within SPLIT.anyYears * P.yearLength
```

| `SPLIT` | Value | |
|---|---|---|
| `at` | 160 | people in a plain band; ×2.5 tribe (400), ×3.5 chiefdom (560), ×5 village (800), ×9 city (1,440) |
| `takes` | 0.42 | share of the parent the party is filled out to |
| `needFood` | 6 | days of store (= `FOOD.comfortable`) |
| `gap` | 45 | metres a new camp keeps from another settlement's trampled ground |
| `everyYears` / `anyYears` | 30 / 5 | sim-years per settlement / island-wide |
| `pairs` / `keepPairs` | 3 / 2 | fertile adults of each sex who may go / must stay |

**History of the threshold** (all measured):

- 60 saw no split in 600 days; the biggest band was 32, because about 100 m round a fire feeds 20–30 people. It dropped to 24 (5ef47fd).
- 24 → 40 with a 3-year wait (5dc77ca).
- The stage multipliers rose after a rich-island run in which a tribe stopped at 58, just under its old threshold of 60 (6defb81).
- On request: 80 with a 30-year wait and the 5-year island rule (57785dd), then 160 (d73ad5f).

**Who goes** (`pickLeavers`):

1. The chief-to-be is `pickChief(parent)`, counted as one of their sex's pairs.
2. The youngest fertile women and the youngest fertile men, up to 3 of each, while at least 2 of each stay.
3. If the party lacks a fertile woman or a fertile man, nobody leaves. This is checked before a camp is built, so a failed split leaves no trace.
4. The party is filled out to `round(pop × 0.42)` with children, oldest first, never more adults.

**The new band** (`splitCamp`) gets:

- a salted stream, a voice, a name and a code;
- the parent's best explorer find (`foundSite`), or else `newCampSite`;
- an empty stone pile;
- each skill at the best of its leavers;
- the parent's lessons (`inheritLessons`) and remembered forage patches within 140 m;
- food in proportion to the party's size.

The parent's `splitAt` is set, and a `split` line is logged. Meshes grow past their allocation (`growCamps`), so there is no cap on camps. `splitAt` is not saved, so a reload forgets the last split.

> **Guaranteed by tests** (`splitting a band`, `villages`, `a settlement holds more the higher it climbs`): parties are young adults filled out with children; both camps can have children; unviable splits leave no trace; `SPLIT.at` is held between 120 and 300 and `needFood` between 1 and 1.5 × `comfortable`; the island-wide `anyYears` rule exists; the five stage multipliers strictly increase.

### Explorers and founding

The boldest adults go and look for new ground first (`explore.ts`).

| `EXPLORE` | Value | Meaning |
|---|---|---|
| `bold` | 1.15 | boldness needed: about one adult in five |
| `chance` | 0.10 | base errand weight |
| `near` / `far` | 0.16 / 0.45 | distance out, as a share of island width |
| `keep` | 6 | finds remembered |
| `notable` | 0.55 | a new best find worth a `find` line |
| `flat` | 0.9 | flatness a camp needs |
| `push` | 2.5 | a fully crowded band sends 3.5× the explorers |
| `lookRings` | 30, 60, 90 | metres of rings surveyed round the stop |

- **Who goes.** `exploreWeight = 0.10 × (1 + 4(bold − 1.15)) × rested × (1 − 0.8 × hunger × (1 − crowd)) × (1 + 2.5 × crowd)`. `crowding` is the larger of population over the stage's split size and `pressed / GROUND.patience`. Explorers ignore dusk.
- **Where they go.** `pickFar` tries ten spots and prefers those far from any fire. Spots within 90 m of an earlier find count at 0.4.
- **Rating a site** (`siteWorth`). Zero if out of height range, flatness below 0.9, not `clearOfCamps`, or within 22 m of a creek. Otherwise the sum of:
  - mean forage richness at eight points 45 m out;
  - 0.2 for a shore within 180 m;
  - 0.15 for ore within 220 m;
  - `0.25 × min(1, nearest camp / 900)` for room;
  - `2 × (flatness − 0.9)`.
- **Surveying** (`surveyDone`). Rates the stop and 24 points on the three rings, and keeps the best.
- **Where a new band may settle** (`clearOfCamps`). Clear of every camp by `max(CAMP_CLEARING, reach)` + 45 m, where a city counts as at least 150 m. So a band may pitch beside a village or a city but not in its streets. It is not held to `CAMPS_APART`.
- **Fallback** (`newCampSite`). 260 draws at `(120 + sqrt(u) × 340) × MAP_SCALE`; flattest wins.

Measured (f1aa209): the ring survey exists because a random stopping point in hill country "is usually a slope". An explorer's tread counts 2.5× on the path field.

> **Guaranteed by tests** (`explorers`, boot probe): one in five explore, to the emptiest unvisited ground, ignoring dusk; sites are weighed by food, water, stone, room and flatness; new bands may settle beside but not inside a city; finds survive a reload; a split settles on the find itself, which is never worse than the spot surveyed.

### Ground, chiefs, and dying out

- **Ground** (`GROUND`).
  - A band treats `range` (105 m) as its own. Foragers discount other bands' ground by `shy` (0.55).
  - A camp with a rival within 1.7 × range builds up `pressed` while its hunger exceeds `squeeze` (0.62), and unwinds it at twice that rate otherwise.
  - After `patience` (40 days) × `(1 + 1.5 × rites)`, the camp with fewer adults moves (`moveCampAway`: 300 draws, at least `apart` 200 m from any camp, flatness ≥ 0.86, a `moved` line).
- **Chiefs** (`chiefOf`, `pickChief`).
  - Held as an id and re-picked only when the chief is dead or gone.
  - First choice: healthy adults aged 18–45, ranked by `knows.spears + knows.baskets + 2 × knows.drying + energy` (+0.15 for a woman).
  - Failing that, the eldest adult, then the eldest person: "Somebody is in charge of a band that exists."
  - The chief wears an ochre hide (`CHIEF_CLOTH`) and a brow band.
- **Dying out.**
  - A camp with nobody left and at least one death is marked `gone` and gets an obituary (`extinct`): cause counts, years, born, peak. If somebody later moves in, `gone` clears, and it can end again. The last person on the island writes `end`.
  - A dead band's graves, monument and masonry stay. Its skills stop fading (`fadeSkills` skips unpeopled camps), and it leaves the Entities panel.

> **Guaranteed by tests** (`sharing an island`, `the chief, and the dead`, `extinction`): the smaller squeezed band moves, somewhere with room; the chief is dressed as one and does not forage; an ending is told once and can recur; no grave is ever removed; a dead band keeps its monument.

### What a band remembers

Every death teaches a lesson (`lessons.ts`). A lesson's weight halves every `LESSON.half` (12) years × `(1 + 2 × rites)`, and grows each time it is taught again.

| Death | Lesson |
|---|---|
| hunger | `famine`: keep 25 more days ahead per famine held (up to two), work food errands up to 1.8× while short; +0.02 `drying` |
| exhaustion | `overwork` (tending up to 1.5×), plus half a famine |
| sickness | nursing up to 1.8×; +0.02 `herbs` |
| infancy | up to half of infant deaths prevented |
| tiger | the place is remembered (10 places, merged within 45 m) and foragers shun 70 m round it; +0.02 `fire` |
| raid | a raider killed: raid weight ÷ `(1 + 0.6 × lesson)`; a defender killed: +0.02 `war` |

- A lesson is announced when it reaches weight 1, and again only after fading below 0.3.
- The band card lists lessons held at ≥ 0.25.
- Daughter bands inherit lessons, and lessons are saved.

> **Guaranteed by tests** (`what a band remembers`): each cause teaches what would have stopped it, with the right fade; births still run flat out; memories survive a reload.

### Place names

`placeName(c)` is used by the Entities list, the card title and the role-play sheet.

| Place | Name shown |
|---|---|
| joined or taken | `"Talo, Neimosh"` (`villageName, name`) |
| origin of a multi-place tribe, at city stage | `"Neimosh, city center"` |
| origin of a multi-place tribe, below city | `"Neimosh, center"` |
| on its own | `"Neimosh"` |

Chronicle lines keep the name a place had when they were written.

> **Guaranteed by tests** (`which place is which`): `placeName` is run on a made-up tribe.

---

## 2. Skills

Three ledgers:

- `camp.skill[key]` (0–1): what the band knows.
- `person.knows[key]`: what one person remembers.
- `camp.told[key]`: the last announced rung. Derived with `skillTier` on restore, never saved.

`knowsFrom` reads old three-skill array saves by `SAVED_SKILL_ORDER`.

### The 22 skills

Listed in band-card order: difficulty (`SKILL_DIFFICULTY`), then `SKILLS` order. **Needs** is `SKILL_NEEDS`, shown while a skill is at 0. **Per go** comes from `perGo` in `made.ts`.

| Key | Label | Difficulty | Learned by (per go) | Needs | What it moves |
|---|---|---|---|---|---|
| `spears` | knapping | easy | craft session (0.028) | — | kill chance × `(1 + 1.2v)` |
| `baskets` | weaving | easy | craft session | — | forage and fish haul × `(1 + 0.9v)`; carry capacity |
| `drying` | curing | easy | craft session; +0.02 per hunger death | — | spoilage × `(1 − 0.65v)`; the rack stands from 0.35 |
| `tracking` | tracking | easy | craft session | — | hunt radius 300 m × `(1 + 0.5v)` |
| `fire` | fire-keeping | easy | craft session; +0.02 per tiger death | — | tiger-free ground `9 + 17v` m (`safeGround`) |
| `wares` | making things | easy | craft session | — | rest at home × `(1 + 0.55v)` |
| `building` | building | easy | craft session | — | sickness crowding × `(1 − 0.5v)`; tent style |
| `clothing` | sewing | easy | craft session, most in autumn and winter | — | cold's effect on sickness × `(1 − 0.6v)`; visible clothes by rung |
| `herbs` | healing | moderate | craft session, weighted by share ill | somebody ill | sickness mortality × `(1 − 0.55v)` |
| `rites` | burying | moderate | burial (0.06), graveyard visit (0.012) | a death | ground patience × `(1 + 1.5v)`; lessons last `(1 + 2v)` × longer |
| `trade` | trading | moderate | deal (0.03), visit (0.008), market (0.008); ×1.5 in a city | another band in reach | gifts × `(1 + 0.6v)`; leading ties |
| `mining` | quarrying | moderate | quarry trip (0.024) | an outcrop in reach | ore per trip × `(1 + v)`; pile capped at 40 |
| `woodcraft` | woodcutting | moderate | tree trip (0.02) | trees in reach | logs per trip `round(3(1 + v))` |
| `irrigation` | watering | moderate | ditch session (0.03) | — | the ditch; nothing is sown before 0.5 |
| `tools` | toolmaking | hard | craft session, spends 0.6 stone | stone in the pile | work time × `(1 − 0.45v)` |
| `art` | raising stones | hard | graveyard visit (0.020) | somebody buried | visit pull `+2.2v`; `round(14v)` monument stones |
| `farming` | farming | hard | field session (0.026) | watering at a fair hand | crop yield; spoilage × `(1 − 0.55v)`; less foraging; flock from 0.5 |
| `fishing` | fishing | hard | catch (0.022) | a raft and a shore | catch × `(1 + v)`; no fishing without a raft |
| `war` | fighting | hard | raid on either side (0.045), border (≤ 0.025/day), patrol stop (0.004) | a band hungry enough to raid | raid strength × `(1 + 1.5v)` |
| `riding` | horse riding | hard | afternoon at a herd (0.03), mounting (0.012) | wild horses in reach | horses kept `round(1 + 7v)`; taming odds; pace past 0.5 |
| `stonework` | masonry | very hard | graveyard visit with stone (0.022, spends 0.5) | somebody buried, and stone | visit pull `+1.6v`; headstones from 0.5; `round(5v)` pyramid courses |
| `conquest` | ruling | very hard | raid won past war 0.5 (0.05), taking a village (0.12), leading a tie (≤ 0.03/day) | fighting or trading at a fair hand, and a neighbour | from 0.25: taking villages and bringing in tied bands |

**Craft sessions** pick a skill with `craftChoice`, weighted by hunger `h`:

| Skill | Weight |
|---|---|
| spears, baskets | `0.25 + 0.5h` |
| drying | `0.20 + 0.7(1−h)` |
| tracking | `0.16 + 0.45h` |
| fire | `0.14 + 0.40(1−h)` |
| herbs | `0.10 + 1.10 × share ill` |
| wares | `0.16 + 0.55(1−h)` |
| tools | `0.30 + 0.35h`, only with ≥ 0.6 stone |
| building | `0.14 + 0.45(1−h)` |
| clothing | `0.10`, +0.55 in autumn, +0.35 in winter |

What a session teaches is scaled by the person's `quick` trait.

Other `SKILL` constants: `teach` 0.86, `step` 0.14, `fade` 0.010/day, `stoneMax` 40, `stonePerTool` 0.6, `stonePerCourse` 0.5. Measured (514f355): store rot is 18%/day with nothing learned, 6% with drying mastered, and 2.8% with drying and farming (the two multiply).

### Practice, fade, teaching

- **Practice.** `practise(camp, key, amount)` clamps the new value to `max(was, min(1, bestKnown + SKILL.step))`, where `bestKnown` is the highest `knows` among living adults. Every practice site also raises the practitioner's own memory. Without that, "every band in every world stalled at exactly 14% for ever". Border and tie practice raise every adult's memory for the same reason. `practise` redraws graves when the number of standing stones or pyramid courses changes.
- **Fade.** `fadeSkills(days)` takes `0.010 × days` off every skill of every peopled camp and reapplies the cap. A band that loses its last elder loses the difference that evening.
- **Coming of age.** A person reaching adulthood sets `knows = max(knows, camp.skill × 0.86)`.
- **Visitors.** A host skill is set to `0.9 × visitor.knows` when that exceeds it by more than 0.02. The host's own people have not learned it, though, so the next fade caps it again at their best memory + 0.14.
- **Splits and conquest.** A split band starts at its leavers' best. Conquest and joining give both places the maximum of each skill.

### Rungs and announcements

```ts
SKILL_STEPS = [0.25, 0.5, 0.75, 1]; SKILL_RISE = 0.02; SKILL_FALL = 0.06
SKILL_WORDS = ['', 'the beginnings of', 'a fair hand at', 'real skill at', 'mastery of']
SKILL_RUNGS = ['not yet', 'beginnings', 'a fair hand', 'real skill', 'mastery']
```

- **Hysteresis.** `skillTier(v, told)` climbs at 0.27, 0.52 and 0.77, and falls below 0.19, 0.44 and 0.69. Losing a skill is the louder claim, so it needs more evidence.
- **Announcing.** `announceSkill` logs `learned` ("has a fair hand at knapping") or `lost` (`FORGET_WORDS`: "has forgotten how to sit with their dead"). It re-dresses the camp when drying, irrigation, farming or building changes rung.
- **Mastery is never reached.** It would need 1.02, and practice caps at 1.0. The fifth rung is never announced, 100/100 reads "real skill", and `nextRung` returns `null` instead of offering 102/100 (f3468f6). Clothing's cloak (`told ≥ 4`) is therefore never sewn. Effects that scale with the value do reach full strength.
- Measured (97683d0): before `told` was derived on restore, "all 236 skill lines in one world came from six reload bursts".

> **Guaranteed by tests** (`knowledge`, `worth telling`): practice teaches the hands doing it; the cap is best living memory plus a step; losing everyone who knew drops the band back; announcements compare with the last one and need a wider margin to fall; there are twenty-two skills and each does something; saves are keyed, and old ones are read by order.

### The band card's skills tab

Columns: skill, acquired, level, difficulty, needs, how it is learned.

**Acquired** is `skillMade` (`made.ts`), shown as `n/of`. Where the skill leaves something in the world, the count is read off the world:

| Skill | Count |
|---|---|
| `drying` | rack 0 or 1 of 1 |
| `building` | tent kind of 3 (cones, hide tents, painted tents, lodges); houses count 3/3 |
| `clothing` | `min(3, told)` of 3 (hides, sleeves, leggings, dyed cloth) |
| `stonework` | pyramid courses of 5 |
| `art` | stones raised of the plan's 14 |
| `fishing` | raft of 1, or "no shore" |
| `woodcraft` | logs for a raft of 12, or logs stacked of 8 |
| `irrigation` | metres of ditch dug |
| `farming` | animals penned of 12 |
| `mining` | stone of 40 |
| `riding` | horses of 8: "tamed" below 0.5, "ridden" after |
| `conquest` | places with a `villageName` of all places with this code |

Skills that only move a number count named kinds, `round(count × v)`:

| Skill | Kinds, in order |
|---|---|
| spears | flaked points, hafted spears, barbed points, spear-throwers |
| baskets | net bags, coiled, twined, lidded baskets, carrying frames |
| tracking | fresh tracks, game trails, the herds' crossings |
| herbs | poultices, fever teas, splints, salves, sleeping draughts, medicine bundles |
| fire | fire drills, banked embers, carried coals |
| wares | hide bedding, fired pots, carved bowls, woven mats, painted pots |
| tools | hammerstones, scrapers, stone adzes, polished axes |
| war | clubs, hide shields, war parties |
| trade | gifts, barter, trade partners, market days |
| rites | marked graves, grave goods, mourning feasts, days for the dead |

- **Level** is `SKILL_RUNGS[skillTier(v)]`.
- **Needs** (`skillNeeds`) is the standing condition while the skill is at 0, then the next rung's name, or "—".
- **How** (`skillHow`) is `SKILL_HOW` plus "about N to go". `N = ceil((nextRung.at/100 − v) / perGo)`, counted in sessions, visits, deals, trips, catches, raids, afternoons at the herd, won raids, or, for ruling with ties, days of dealing (0.03 − 0.01 fade per day).

> **Guaranteed by tests** (`the toll`): every skill has something to count; the courses and stones counted are the ones `people.ts` raises; no unreachable rung is offered; the list goes easiest first; what a skill waits on is what the code waits on, and no easy skill needs anything; the two levels named in the table are read against `FARM.irrigateFirst`, `CONQUEST.warFirst` and `SKILL_STEPS`.

---

## 3. Roles

A role leans errand choice; it does not dictate it. `assignRoles` runs daily.

**Affordability.** `ROLE_AT = { families: 6, days: 8 }` is compared with the number of **adults** (despite the name) and with `food / need`. Below either, all roles are cleared: "a band coming out of a hard winter goes back to everybody foraging".

| Role | Leans to | Refuses | Chosen by | Share of adults |
|---|---|---|---|---|
| `chief` | tend | gather, hunt, quarry | the band's chief | one |
| `hunter` | hunt | — | spears | 0.16 |
| `knapper` | craft | hunt | tools | 0.10 |
| `healer` | nurse | hunt | herbs | 0.08 |
| `keeper` | tend | hunt | fire | 0.08 |
| `quarrier` | quarry | — | mining | 0.08 |
| `trader` | visit | — | trade | 0.06 |
| `warrior` | tend | — | war | 0.12 |
| `fisher` | fish | hunt | fishing | 0.14 |
| `patrol` | patrol | gather, hunt, quarry, farm, wood, fish | riding | `patrolsFor` |
| `forager` | gather | — | — | everybody else |

- **Weights.** `roleWeight` gives `LEAN` (3.2) for the role's job, 0 for a refused job, 1 otherwise, applied before `jobMix` and `lessonMix`.
- **Assignment order.**
  1. Everyone becomes a forager.
  2. The chief is set.
  3. The role-play character gets the role they chose, if their level has opened it.
  4. Each role in table order takes `max(1, round(adults × share))` people, ranked by their own `knows[by]`, stopping at anyone at or below 0.02: "a band with no memory of mining does not have a quarrier".
- **One role each.** Nobody holds two.
- **Warriors** add 0.8 to raid strength, join war parties first, and weigh raiding × 2.5.
- **Patrols.** `patrolsFor` gives 0 below a city, otherwise `min(horses, ceil(adults / 30))`. The first patrol is logged: "has riders out on its bounds".
- **Card words** (`ROLE_WORDS`): chief, hunter, toolmaker, healer, fire-keeper, quarrier, trader, warrior, fisher, patrol rider. Forager is left blank.
- **Role play** (`ROLE_LEVEL`, `roleplay.ts`): hunter and fisher open at level 2; knapper, quarrier and keeper at 3; trader and healer at 4; warrior at 5; patrol at 7. See the player section.

> **Guaranteed by tests** (`who does what`, `mounted patrols`, `role play`): roles only when affordable, and given up when not; the chief goes first and does not forage; a role leans, and a refusal is a zero; roles go to whoever knows most; nobody holds two; a hungry village forages again; the role assignment is run, not just read.

---

## 4. Development and stages

```ts
SOCIETY = { hold: 1.5, slip: 3, blend: 1, farmAway: 0.55 }
```

| # | Stage | Marks (`MARKS`) | Split at | On the ground |
|---|---|---|---|---|
| 0 | band | always | 160 | tents by building skill; granaries on stilts |
| 1 | tribe | pop ≥ 20, farming ≥ 0.25 | 400 | as a band |
| 2 | chiefdom | pop ≥ 30, (war ≥ 0.25 or ≥ 2 villages), art ≥ 0.25 | 560 | the chief's hall |
| 3 | village | farming ≥ 0.5, building ≥ 0.5, flock ≥ 4 | 800 | timber houses, storehouses, hall |
| 4 | city | pop ≥ 60, trade ≥ 0.5, stonework ≥ 0.5, ≥ 2 villages | 1,440 | brick street plan, silos, city hall, market, wall, gates, roads, patrols |

`villagesOf` counts living, peopled places with the same code. `updateSociety` runs every books call:

- **Up.** The next rung's marks must hold continuously for 1.5 sim-years (`risingSince`). A settlement climbs one rung at a time.
- **Down.** Failing its own rung for 3 years (`slippingSince`) drops it one rung. This is how chiefdoms end.
- **The change.** `setStage` records `stageFrom` and `stageSince`, logs `stage` ("has become a city", or "is no longer a chiefdom — a tribe again") and re-dresses the camp at once.
- **Saving.** `stage`, `stageSince` and `risingSince` are saved; `slippingSince` is not.

**`jobMix(camp, job, hunger)`** multiplies errand weights by stage. Errands not listed stay at 1.

| Errand | band | tribe | chiefdom | village | city |
|---|---|---|---|---|---|
| gather | 1.0 | 0.9 | 0.75 | 0.6 | 0.45 |
| hunt | 1.0 | 0.9 | 0.8 | 0.6 | 0.45 |
| fish | 1.0 | 1.0 | 0.9 | 0.8 | 0.7 |
| farm | 0.7 | 1.2 | 1.4 | 1.7 | 1.9 |
| craft | 0.9 | 1.0 | 1.1 | 1.3 | 1.5 |
| visit | 1.0 | 1.0 | 1.1 | 1.3 | 1.6 |
| raid | 0.6 | 0.8 | 1.3 | 1.1 | 1.4 |
| mourn | 1.0 | 1.1 | 1.3 | 1.3 | 1.4 |
| quarry | 0.9 | 1.0 | 1.2 | 1.3 | 1.5 |

- **Blending.** The mix blends from the old rung's table to the new one over 1 sim-year.
- **Hunger undoes it.** `m + (1 − m) × hunger`, so "a starving city forages like a band".
- **Farming.** Gather and hunt are also multiplied by `1 − 0.55 × farming × (1 − hunger)`.
- Measured (0d685e1): a fed band forages about 17% and hunts about 8% of errands; a starving one forages 85%.

**Development** is `round(100 × (0.7 × mean skill + 0.3 × stage / 4))`. The Entities panel ranks bands by it and shows chip, `placeName`, stage (tribe and up), head count and `dev/100`. The card's first line reads "a **chiefdom** · 40% of the way to a village" (`stageProgress`).

### What a city has going for it

`CITY_EDGE` applies at stage 4.

- **Trade × 1.5.** A city learns trade 1.5× faster on visits and deals. A deal with a city on either side moves 1.5× as much and ties 1.5× faster (`tradeEdge`).
- **Crop × 1.5.** A city's field yields 1.5× per session.
- **Drawing people** (`cityDraw`), every books call:
  1. Each non-city band of at least 8 people (`keep`) picks the city with the highest `appeal / (1 + dist / 2000)`, where `appeal = (1 − hunger)(0.6 + 0.2 × trade + 0.2 × farming)`.
  2. With chance `days × 0.35 × pull × (0.6 + home hunger)`, one adult aged 16–30 who has never moved, and is not sick, led or raiding, joins that city and walks there. This happens once in a life.
  3. A `joined` line ("N people came from across the island to live in [XX] Name") is written at most once a season per city.
- **Markets.** A city with a market has a `market` errand (`MARKET.chance` 0.22 × rested × sociable). Each morning there practises trade by 0.008. Its children play in the square half the time.

Measured (f790183): with one fed city among 12 bands, 20 days took the city from 50 to 97, all 47 newcomers walking to it.

> **Guaranteed by tests** (`from band to city`, `development`, `what a city has going for it`): five rungs in order, lost one at a time; the job mix is run (blended over the year, city below band at foraging and above at farming, no lean when starving); every step is told and saved; development is 0 for a new band and 100 for a mastered city; a city deals and farms better and draws the young, on both the watched and run-ahead books.

---

## 5. Contact between bands

### Visits and gifts

```ts
VISIT = { chance: 0.10, needFood: 0.55, begFrom: 0.70, gift: 0.30, learn: 0.90, stay: 0.14, stayUnder: 30 }
```

**Who visits.** A rested adult (> 0.5) whose camp is not ill, with daylight left for the round trip before 18:00, and whose hunger is below 0.45 (to give) or above 0.70 (to ask). `otherCamp` picks the nearest camp, with distance divided by `campPull = 1 + 2.2 × art + 1.6 × stonework`, so a monument or pyramid pulls visitors from further off.

**On arrival** (`arriveAtCamp`, within `CAMP_CLEARING × 1.6`):

1. **Sickness.** A visitor from an ill band, not immune, may infect one host with chance `PLAGUE.carried` (`plague`: "the sickness came to [YY] Name with [XX] Aro").
2. **Knowledge** carries over (section 2).
3. **A call.** `calledOn`: both bands practise trade by 0.008 (×1.5 for a city) and a `call` tie is added.
4. **Stone.** If home has more than 2.4 spare and the host has under 20, `spare × 0.3 × (1 + 0.6 × home trade) × tradeEdge` moves, and it counts as a deal (`dealtWith`: trade 0.03 each, plus a `deal` tie).
5. **Food.** If home's surplus over 6 days is positive and host hunger is above 0.5, `surplus × min(1, 0.3 × (1 + 0.6 × mean trade) × tradeEdge)` moves. Once a season per host this counts as a deal and logs `trade` ("sent food to"). Otherwise, if knowledge moved, it logs `visit`.
6. **Staying.** A visitor under 30 who has never moved stays with chance 0.14, if the host has a fertile, non-nursing partner of the other sex (`joined`: "[AA] Lore stayed with [BB] Name"). Once-in-a-life stops two bands becoming "the same people shuffled".

> **Guaranteed by tests** (`the bands meeting`, `what a visit is for`, `wares and trade`, `nursing`): a hungry band goes to ask; a fed one takes surplus food and stone over, and knowledge, but not what the host already knows; trading is learned on both sides, and a deal teaches more than the walk; nothing moves that is not there; a guest is how sickness crosses the island.

### Ties

```ts
TIES = { keep: 4, call: 0.5, deal: 1, join: 6, tradeFirst: 0.5, perDay: 0.03 }
```

- **Growing.** `tie()` adds `TIES[kind] × tradeEdge` to a symmetric tie, at most once a season per pair per kind (`tiedAt`). Places with the same code never tie. A season with both a visit and a deal adds 1.5 (2.25 with a city), so a full tie of 6 takes at least four such seasons. By the season, because counting by deal made "one tribe inside a year".
- **Loosening.** `tradeTies` multiplies ties by `exp(−days / (4 × yearLength) × ln 3)`, a third over four years. A tie under 0.05, or with a gone band or one with the same code, is deleted.
- **Ruling from ties.** The better trader (or the bigger, if equal) leads the tie. With trade ≥ 0.5 it practises conquest by `0.03 × min(1, tie / 6) × days`, from its strongest tie, and adults' `knows.conquest` rises to match. This beats the fade once a tie passes 2.
- **Joining.** A band with conquest ≥ 0.25 that leads a tie ≥ 6 with a strictly smaller band calls `conquer(camp, other, true)`, at most once per books call. The line reads "[BB] joined [AA], after years of dealing with them — it flies their flag now".
- **Saving.** Ties and `joined` are saved; `tiedAt` is not.

Measured (5ae3e58: 160 people, 7 years, one seed): with `join` at 12 nobody joined. At 6, the two closest trading pairs joined in years 3 and 4, and ruling reached 100 in the tribes formed.

> **Guaranteed by tests** (`conquest`): a visit ties, a trade ties more; once a season per pair; never within a tribe; unkept ties loosen; the leader learns to rule and so do its people, faster than the fade; a full tie with a band that can rule brings the smaller in, told as joining, and saved.

### The border

`BORDER = { reach: 300, perDay: 0.025 }`. Raids only happen when a band is starving, so a well-fed island never learned to fight. `borderTension` gives each camp `0.025 × (1 − d / 300) × days` of war practice from its nearest foreign camp (a different code, not gone) within 300 m, and lifts its adults' memory.

- At its closest, that is 2.5× the fade.
- It breaks even at 180 m.
- Further out, fighting fades.

Measured (cde323e, the same island with the border on and off, 100 days):

| | off | on |
|---|---|---|
| fighting, neighbours 76–97 m | 0 0 0 0 0 | 14 85 80 80 69 |
| fighting, a band at about 300 m | 0 | 0 |
| raid deaths | 0 | 0 |

The on run also ended with 91 people against 115, mostly from sickness and exhaustion. The commit leaves that open as divergence between runs.

> **Guaranteed by tests** (`a border teaches fighting`): a close border beats the fade, lifts memory past the cap, and ignores same-tribe villages.

### Raids

```ts
RAID = { hungry: 0.80, worth: 4, takesFood: 0.35, takesStone: 0.40, home: 1.35, hurt: 0.10, every: 2.0, party: 8, chance: 0.55 }
```

- **Deciding.**
  - Weight: `0.55 × hunger × rested × (2.5 for a warrior)`.
  - Only for an adult with hunger > 0.80 (past `begFrom`: "a band asks before it takes") and rested > 0.4, whose band has not raided within 2 days.
  - `raidTarget` is the nearest camp of another code holding ≥ 4 days of food or ≥ 12 stone.
- **The party** (`gatherWarParty`). The leader plus `min(7, round(adults / 4) − 1)` idle or at-home adults, warriors first, all with spears ("N strong", a `raid` line). While raiders stand in the target, it is `underRaid` and its able people turn and fight. That fight is drawing only.
- **Resolving** (`resolveRaid`, once for the party, on the first arrival within `CAMP_CLEARING × 1.6`).
  - Strength: over well adults, `Σ(0.4 + 0.6 × energy + 0.8 per warrior) × (1 + 1.5 × war)`.
  - Defence: the host's strength × 1.35 × `guarded(host)`.
  - Won if `mine > theirs × (0.7 + random × 0.6)`.
  - Both sides practise war (0.045). A winner at war ≥ 0.5 also practises conquest (0.05).
  - A winner with conquest ≥ 0.25 and `mine > 2 × theirs` conquers. Otherwise a winner takes 35% of the food and 40% of the stone (pile capped at 40), carried home ("took food from"). A loss is "drove off".
  - With 10% chance the losing side loses one adult (cause `raid`).

Measured (48cc7c4): 341 raids across seventeen runs, before war parties existed.

> **Guaranteed by tests** (`raiding`, `raids you can see`): asking comes before taking; not twice in a row; a raid must arrive and is resolved once; strength counts well people, energy, warriors and practice; home ground counts; raids move but never invent food or stone; war parties go warriors first, fight visibly, and carry the loot home.

### Conquest, shared stores, neighbours moving in

```ts
CONQUEST = { warFirst: 0.5, from: 0.25, margin: 2.0, perWin: 0.05, perTaking: 0.12, share: 0.25 }
```

`conquer(home, host, joined)`:

1. Pools food and splits it by need. Pools stone and wood and halves them (stone capped at 40 each).
2. Sets every skill in both places to the higher of the two, recomputing `told` so no string of "learned" lines follows.
3. The host keeps `pastCodes` and `villageName`, takes the conqueror's name and code (so its colour and flag change), and records `conqueredAt` and `joined`.
4. The conqueror practises conquest by 0.12.
5. Logs `conquest` ("took [BB] — it flies their flag now").
6. Merges neighbours (below) or re-dresses the host.

- **Shared food.** `shareTribes` moves each place's food `min(1, 0.25 × days)` of the way to the tribe's need-weighted share, every books call.
- **Inside a tribe.** Places of one tribe never raid, tie or border each other.
- **The dead.** A taken place's "was" tab still lists its dead under its `pastCodes`.
- **The card.** "one of N villages", "once Hedrol, taken on day 9480".

**Neighbours move in** (`mergeNeighbour`, `MERGE.near` = 120 m). If the gap between the two places' edges (`distance − both campReach`) is at most 120 m:

- the host's people move to the conqueror and walk over;
- food, wood, flock and stone (to 40) are added;
- the host's houses come down, and it is marked `gone` with `mergedInto`;
- the line reads "the people of Talo moved in with [AA] Name: one town now".

Measured (d73ad5f): 50 + 50 → 100, nobody left behind.

> **Guaranteed by tests** (`conquest`, `walls and neighbours`): winning teaches ruling once a band can fight; a wide win takes the village; tribes never raid themselves; a taken village comes back under its new flag and keeps its old dead; a neighbour joined or taken moves in, one town inside one wall.

---

## 6. Horses and riding

Wild horses are a herd species: `HORSES` is 18 at default and high quality, 12 medium, 6 low. A tamed horse keeps its herd slot, so drawing, gait, tiger kills and saving stay the herd's. Tigers do not hunt tamed horses.

| `RIDE` | Value | Meaning |
|---|---|---|
| `from` | 0.5 | skill before a band rides; below it, it only tames |
| `reach` / `wild` | 450 m / 3 | distance to a herd; fewest wild horses left in a herd |
| `chance` | 0.12 | errand weight of taming |
| `odds` | 0.05 → 0.25 | chance an afternoon brings a horse home |
| `kept` | 1 → 8 | horses kept, at 0 and at mastery |
| `perTame` / `perRide` | 0.03 / 0.012 | skill per afternoon / per mount |
| `worth` / `fetch` | 70 / 180 m | minimum trip to ride; how far a horse comes when called |
| `pace` / `most` | 2.2 → 3.6 × walk / 7.5 m/s | riding speed |
| `wait` | 150 s | how long a horse waits by a working rider |
| `pen` / `out` | 9 / 14 m | paddock grazing radius / distance past the camp edge |
| `gate`, `near`, `mount` | 8, 12, 3.5 m | get down outside a wall; gallop becomes walk; mount |

- **Taming.** `tameWeight = 0.12 × (1 − hunger) × rested`, for an adult in a band with hunger ≤ 0.5, room for another horse (`keeps = round(1 + 7 × riding)`), and a herd with ≥ 3 wild horses within 450 m. `tameDone` practises 0.03, then with chance `0.05 + 0.20 × riding` takes the nearest wild horse within 45 m. The first one is logged: "has tamed its first horse".
- **Paddock** (`paddockOf`). At `campReach + 14 m` on the side opposite the first fire, searched in 15° steps for level, dry ground.
- **Who rides.** `mayRide`: the chief and patrol riders only. Anyone who loses permission, or whose band's riding falls below 0.5, is unseated.
- **Riding** (`riding(p, want)`, called for anybody walking).
  - Nobody rides who is not allowed, a child, sick, led, panicking, rafting, up a tree, hiding or chasing; nor on a trip under 70 m, from inside a wall, or to a target inside a wall under 140 m away.
  - A free band horse within 180 m is called. It gallops to 12 m, then walks (a gallop circled the rider), and the rider mounts at 3.5 m.
  - Pace is `min(7.5, want × (2.2 + 1.4 × v))` with `v = (riding − 0.5) / 0.5`. The horse copies the rider's position and speed, legs in time, and ridden horses are never put into coarse LOD groups.
  - A rider heading inside a wall dismounts within wall radius + 8 m. Going out, they walk through the gate and the horse meets them outside.
  - When the rider stops, the horse waits up to 150 s, then goes home to graze. A band that ends frees its horses. Saves store a count (`hs`), and `restoreHorses` retames the nearest wild ones.

### Mounted patrols

`POLICE = { per: 30, out: 45, stops: 8, round: 8, chance: 1.2, perStop: 0.004, guard: 0.8, full: 4 }`

- **The beat.** Beat points sit at wall radius (or `campReach`) + 45 m, eight round at `hearthTurn + k/8`. `pickBeat` takes the next dry point. `outDone` practises war by 0.004 at each point and rides on until eight are done, then home. The errand weighs 1.2 × rested, × 3.2 from the role.
- **Defence.** `guarded(host) = 1 + 0.8 × min(1, riders / 4)`, counting well patrol riders: 1.2, 1.4, 1.6, 1.8.

Measured:

- **efb585f** (160 people, when odds were 15–55% and horses kept 2–12):
  - 88 exhaustion deaths with horses against 2 without, because rider effort was charged at horse speed; now a rider pays a walk's cost.
  - Grazing horses drew tigers and people at the fire panicked; nobody on a camp's safe ground panics now.
  - After both fixes: 165 people either way.
  - One rider did 300 m in about 90 s against about 240 s walking; about 50 people shared 7 horses.
- **29d196f** (a city of 139, 6 horses):
  - 3 patrol riders, defence × 1.60.
  - Riders were outside the wall 80% of the time, on the beat 57%, mounted 53%.
  - Ordinary people spent 0 steps on a horse.
  - 686 wall crossings, all at gates.
  - Riders were on the beat only 5% of the time before the beat was chained into one outing.
  - This commit cut taming to 5–25% and horses kept to 1–8.

> **Guaranteed by tests** (`horses`, `mounted patrols`): taming first, riding past a fair hand; rare horses, never taking a herd to nothing; paddock, calling and waiting; faster but capped; nobody rides inside a wall; only the chief and patrol ride; only cities have patrols, one per thirty adults, never more than their horses; patrols ride the bounds, learn to fight, and make raiding harder.

---

## 7. Settlement layout

A camp is laid out once from its own stream (`layoutCamp`); what is **shown** follows the band (`dressCamp`, `dressOutskirts`, `dressCivic`). Everything past the core (outskirts, city plots, civic buildings, roads) is slot arithmetic, never saved and rebuilt identically. New mesh kinds are made on first need, because meshes made at build time draw `Math.random` and move the boot check onto a different island.

### The core camp

`HEARTHS` 5, `HUTS_PER_HEARTH` 10, `HEARTH_SPACING` 13 m, `CAMP_CLEARING` 26 m, `TENT_REACH = 5.2 + 3.9 + 1.95 × 1.25` ≈ 11.54 m.

- **Hearths.** Hearth 0 is the camp position. Hearths 1–4 sit 13 m out at `i/5` turns + `hearthTurn`. The `hearthTurn` bearing itself is left for the granaries.
- **Tents.** For each of 50 slots, all random draws come first: angle (slot ± 0.85 slot), distance (5.2–9.1 m), scale (0.78–1.25), height (0.84–1.34) and hide colour. `pitch` then finds room, or the tent is skipped. Facing comes from size, not a new draw: one extra draw per hut had moved the probed island (a86e702).
- **Fires.** Each hearth has a ring of 9 stones at 1.15 m and 4 logs at 2.6 m. `hearthsFor(families) = clamp(ceil(families / 10), 1, 5)` fires burn, with one point light for the whole village.
- **Households.** `familiesOf` pairs adults by age, children with a parent, and leftovers in twos. `assignHuts` gives each a tent, and the tent's `fire` becomes their `hearth`: people go home to it (`homeFire`) and flee to the nearest lit fire (`nearestFire`). Households past the core go to the outskirts.
- **Clearing.** `campReach = max(26, reach)` grows with the outskirts and city plots, and governs "at home", resting and the night skip.

> **Guaranteed by tests** (`villages`, `spread round the fires`, `a camp is pitched, not drawn with a compass`): a tent per household; a ring of tents, stones and logs per hearth; a fire lit only with tents round it; ten households fill a hearth before the next; people go to their own fire; tents scattered, not facing the fire square on.

### Tents, houses, footprints

`tentStyle` (`village.ts`), with colours painted into the geometry and pale instance tints:

| Condition | Dwelling |
|---|---|
| stage ≥ 4 | `townhouse`: brick, two storeys, flat roof and parapet, door and two windows |
| stage 3 | `house`: timber frame, daub walls, hipped thatch (on the tent spots) |
| building ≥ 0.75 | `lodge`: round daub wall, thatched cone, finial |
| building ≥ 0.5 | `tentPainted`: hide on crossing poles, door flap, ochre and red bands |
| building ≥ 0.25 | `tentHide`: hide on crossing poles, door flap |
| otherwise | `huts`: plain cone of hides |

**Footprints** (`footprint.ts`):

- `DWELLING = { radius: 2.95, margin: 0.4, fire: 1.3, tree: 0.3 }` and `footprint(sc) = 2.95 × sc`. The radius is a house's eaves corner to corner, the widest thing that will ever stand on the spot.
- `dwellingsNear` gathers every nearby tent, outskirts tent and fire, city home, tree and the camp's own hearths.
- `pitch` tries distances from `1.3 + fp + 0.4` to `TENT_REACH − fp` in 0.7 m steps, nearest the drawn distance first, at 48 alternating 7.5° turns. It returns the first dry, clear spot, with no random draws of its own.

Measured (3dcc8ce, a 2,500-person island):

| | before | after |
|---|---|---|
| overlapping pairs | 686 of 1,265 dwellings | 0 of 1,268, closest exactly 0.4 m |
| core tents per camp | 50 slots | 22–26 |
| outskirts fires | 108 | 172 |
| townhouse back-to-back | 0.17 m overlap | clear (`CITY.back` 1.7 → 1.95) |

> **Guaranteed by tests** (`building and masonry`, `a camp you can read`): four tent kinds by building skill, painted in the geometry; a footprint as wide as the widest shelter; fifty tents round five fires, placed twenty times, with no pair overlapping, none in a fire, none past the reach; outskirts follow the same rule; townhouse rows clear.

### Stores and the rack

- **Constants.** `STORES` 4, `STORE_DAYS` [0, 6, 15, 30] (+1 day slack going up), cluster 13 m out along `hearthTurn` (`STORE_SPOTS`), fallbacks at 22 m between fires.
- **Placement** (`storeGround`): dry where it stands and where it is filled from, flatness ≥ 0.8, clear of every possible hearth by `TENT_REACH` + roof.
- **By rung** (`storeKind`): granary on stilts; a timber storehouse on staddle stones in a village; three domed brick silos on a stone floor in a city. They stand in the core slots, outskirts yards and city plots.
- **The rack.** Two uprights and a crossbar 5 m from the middle, shown once drying reaches 0.35 (`RACK_KNOWN`), hidden in a city.

> **Guaranteed by tests** (`a camp you can read`, `stores by rung`): none for an empty store, one getting by, four with a month put by; no flicker; never in water, on a hillside or in a tent; storehouses and silos by rung everywhere.

### Graves, monuments, masonry

- **The graveyard** (`camp.barrow`): 32–44 m out, flatness ≥ 0.88, no creek within 8 m (fallback 30 m). Graves spiral out from the middle of a square (`squareSeat`, 1.6 m spacing), so its size is how long a band has buried.
- **Graves.** A cairn is 3 stones. At stonework ≥ 0.5 new graves are headstones, and old cairns stay. No grave is ever removed: the mesh starts at 400 and doubles.
- **Monument** (`monumentPlan`). The form is drawn once from the salted stream: `ring` (7.5 m radius), `avenue` (two files leading in) or `cairn`. `MONUMENT_MAX` is 14, and `round(14 × art)` stand.
- **Masonry.** A kerb round the grave square comes with the first course. `PYRAMID_COURSES` 5: course `c` is `7 − 1.3c` m wide and 0.9 m high, behind the graves away from camp, and `round(5 × stonework)` stand. Both are drawn with the graves, so dead bands keep them.

> **Guaranteed by tests** (`the stones`, `raising stones`, `building and masonry`): one flat, dry burial ground just outside camp; graves in a square from the middle out; a band's own monument form, raised over years by those who go back, pulling neighbours by seeming nearer; headstones for bands that dress stone; dead bands keep all of it.

### Outskirts

`OUTSKIRTS = { first: 37, ring: 24, apart: 23.5, seats: 10, minSeats: 6, storeEvery: 5, rings: 12 }`

`extendOutskirts` lays out slots ring by ring:

- **Rings.** Ring `k` is at `37 + 24k` m (the twelfth at about 301 m), with `max(6, floor(2πR / 23.5))` slots.
- **Skipped slots** (`outerGround`): low, not flat, in water, near the largest possible graveyard or the field, or within another camp's reach + `TENT_REACH` + 4.
- **Hearths.** Each good slot becomes a hearth of up to 10 pitched tents, 9 stones and 4 logs, seeded by position and slot. A hearth that fits fewer than 6 tents is dropped.
- **Yards.** After every 5 hearths, the next slot becomes a yard of four stores facing the middle.
- **Fires and edge.** Outskirts fires number after the core's five, so `homeFire` works unchanged. `camp.reach` grows to cover them.
- **Drawing.** Packed shared meshes that double when full.

Measured (344ff9a): the boot check lays out 60 extra households, giving room for 68 round 7 fires, a yard, out to 73 m.

> **Guaranteed by tests** (`the outskirts`): packed meshes made only on need; yards fill with the store; re-laying a camp drops its outskirts. The boot check draws a tent per household with a fire per occupied ring.

### Cities in streets

`CITY = { at: 4, along: 4.2, block: 6, pair: 11.4, back: 1.95, plaza: 10, reach: 150, storeEvery: 12 }`

- **The grid** (`cityCandidates`). Turned to `hearthTurn`. Back-to-back rows at `v = 11.4j ± 1.95`, each facing its street; plots every 4.2 m, with every seventh a cross street (six houses per block); 10–150 m from the middle, nearest first.
- **Plots** (`cityPlotsFor`). The market site is claimed first. A plot is skipped if it is low, not flat (below 0.72), in water, near the graves, field, stores (4.2 m) or market (10 m), inside another camp's reach + 6 m, or within 2.4 m of a tree. Every twelfth good plot is a store.
- **Homes.** Each house has a door at 2.2 m and a step at 3.2 m, where the household sits.
- **The middle.** A city shows no tents, hearths or rack. The **city hall** (brick, portico of four columns, tower with the flag) stands where the fire was.

> **Guaranteed by tests** (`cities`): streets, a house per household nearest the middle, each at its own door; no fire and a city hall with the flag. The boot check finds brick along streets, no overlaps, a paved plaza, a market and well, a wall and gates, and tents again when the city falls back.

### Civic buildings, walls, gates

`CIVIC = { hallAt: 2, marketAt: 4, wallAt: 4, stalls: 6, stallOut: 4.2, wallOut: 5, wallGap: 4.2, gate: 3.5 }`

- **Chief's hall** (chiefdom and village). A 5.5 × 11 m thatched longhouse on the next good outskirts slot, facing the middle.
- **Market** (city). Six coloured stalls 4.2 m round a thatched well, on an outskirts slot.
- **Wall** (city). Mud-brick lengths every 4.2 m round `R = campReach + 5`, skipped over water, following the city as it grows.
- **Gates** (`cityGates`). Two, at the ends of the street past the middle (`v = 5.7`, `u = ±sqrt(R² − 5.7²)`), each with towers either side, an opening of ±3.5/R radians, a road start `GATE_OUT` (4 m) outside and an avenue to the plaza.
- **Walking through walls** (`walls.ts`).
  - `wallBlocks` refuses any step crossing the radius outside 80% of a gate opening.
  - `viaGate` routes to the shortest gate, lines up `GATEWAY` 3 m out and goes through.
  - Outside, a walker whose line would cut through town circles the wall in steps of at most 0.5 rad.

Measured (d73ad5f): 12 people outside the wall between gates all got in, with no step through the wall.

> **Guaranteed by tests** (`walls and neighbours`, `cities`): steps through walls are refused except at gates; crossers head to a gate, round the wall if needed; the walls walked against are the ones built; two gates on the main street; no gate in water.

### Roads

- **Storage.** Roads are written into the path wear field at `ROAD` 255. Trails stop at `TRAIL_MAX` 230, so roads never grow back and have their own colour. They are straight, never on water, and walked at 1.12× (`TREAD.road`, against 0.82 rough).
- **When they are laid.** `layRoads` re-lays only when the cities, their shown homes and reach, tribe villages, fields or quarries change. Old roads come up first (`liftRoads`).
- **City paving.** Plaza disc (9 m), a 4.2 m street before each house, cross streets, and an avenue out through each gate.
- **Trunk.** Starting from the biggest city, the other cities join nearest first, at a free gate, a road end, or the nearest point on an existing road (a junction).
- **Branches.** Tribe villages, each city's field and its main quarry join the same way, up to `ROADS.branch` (1000 m), paved 3.5 m wide.
- **Junction rules.**
  - A walled city's roads use its gates only.
  - An unwalled place's first road fixes the one point later roads must meet it at.
  - Once a road takes a gate, others in that direction must branch off it.
  - No junction within `ROADS.clear` (12 m) of a gate.
  - A route through any wall costs an extra 10⁷.
- **Walking** (`shareRoads` → `setRoadNet`). Roads are split at junctions, dry stretches kept, each town's gate-to-gate street added, and Floyd–Warshall shortest paths computed. `wayTo` plans once per errand outside walls with `ROADWALK = { min: 30, on: 3, gain: 0.97, detour: 1.3, gate: 15, stall: 240 }`:
  - no road for walks under 30 m;
  - away from gates the road must cost less than 0.97 of the straight walk;
  - leaving or entering by a gate it may cost up to 1.3×;
  - a route not getting closer for 240 looks is dropped.

  Led, fleeing, chasing, hiding and rafting walkers go straight.

Measured:

- **33b37cb**: 3 cities and 13 villages gave 55 road cells on wall lines, all in gates, and 15 roads for 16 places.
- **454e3a4**:
  - 60 people sent to a village 440 m away all left by a gate, 0 through the wall, 82% of their outside steps on the road; 84% coming back.
  - Without the detour allowance, only 3% of steps were on the road.
  - With 8 villages: one network, 2 junctions, one road per gate.

> **Guaranteed by tests** (`roads`, `going by the path`): roads never regrow, never cross water, and have their own colour; one network joined at junctions; two gates with one road each; roads meet a place at a single point; walkers use the network (the built `walls.js` runs against a made-up town); roads relaid only on change; off-path slower, road quicker.

### Flags

Every living place flies its code's hue: on the city hall tower in a city, otherwise 3.2 m and 2.4 m off the first fire. A place changing hands changes flag at once.

---

## 8. The chronicle of events

`logEvent(kind, text, x, z)` records `{ seed, world, day, hour, kind, text, x, z }`.

- **In memory:** unshifted onto `chronicle`, capped at `CHRONICLE_MAX` (200).
- **Browser copy:** written daily and on tab close (`flushChronicle`).
- **Server:** keeps everything, and the full chronicle window reads it.

**Milestones** (`MILESTONES`) are shown by default. The filter hides lines, it does not drop them.

| Kind | From | Example |
|---|---|---|
| `learned` / `lost` | skill rungs, lessons, first horse, first patrol, ditch dug, first flock, raft, role-play level | "has real skill at masonry"; "has forgotten how to sit a horse" |
| `split` | `splitCamp` | "[XX] New broke away from [YY] Old — 9 went with Aro" |
| `joined` | a visitor staying, `cityDraw` | "[XX] Lore stayed with [YY] Name" |
| `moved` | `moveCampAway` | "[XX] Name moved on — 412m" |
| `trade` | a food gift, once a season per host | "[XX] Name sent food to [YY] Name" |
| `plague` | a visitor bringing sickness | "the sickness came to [YY] Name with [XX] Aro" |
| `hunger` / `relief` | the store emptying or refilling | "has nothing left" / "has food again" |
| `find` | first of a metal; an explorer's new best site | "brought home their first silver" |
| `conquest` | taking, joining, moving in | "took [BB] Name — it flies their flag now" |
| `stage` | `setStage` | "has become a city" |
| `slain` | a thrown spear killing a tiger | names the thrower and band |
| `extinct` / `end` | obituary; the last person on the island | "is gone — 31 died, 18 to hunger..." |

**Kept but not milestones:** `raid` (setting out, food taken, driven off), `visit`, `death`, `birth`, `kill`, `predator`, `sickness`, `forage`, `season`, `day`, `ahead`, `resume` and `models`. Skills use hysteresis, and gifts, city newcomers and ties are counted at most once a season, so milestones stay readable.

**Band card.**

- **Head:** stage and progress, villages held, "once X, taken/joined on day N", chief, age and founding day, people by sex, children, the ill, store in days, food carried home, flock, "worth taking" (`wealthOf`: food over 6 days plus stone), born, peak, toll by cause, lessons remembered.
- **Tabs:** now (the living, with roles and errands), was, log, skills.
- **Log tab** (`campHistory`): milestone lines from this seed containing `[CODE]`, newest first, up to 40, or "nothing worth telling yet". It reads the in-memory 200 lines and matches only the band's current code, so lines written under a taken village's old code do not appear.
- **Was tab** (`formerOf`): reads the lineage record instead, covering deaths and departures under the current code or any `pastCodes`.
- **Run-ahead window:** can filter milestones to one tribe (9e7a9c2).

> **Guaranteed by tests** (`the chronicle`, `worth telling`, `the toll`, `clicking a band`, `extinction`): entries record their world; the chronicle is never emptied wholesale and outlives the tab; codes are coloured from the text; milestones include what a band learned and who left, not a day's hunting; a plague arriving is news but a person catching it is not; the card's history is found by code, capped, and says so when empty; per-band toll by cause, worst first. The boot check renders the gone and history tabs.

### Not verified here

- All measured figures are quoted from commit messages, and some predate later constant changes (horse runs before taming was cut; split history before 160).
- Nothing here was observed in a browser.
- The `TIES` comment's join estimates ("about six years", "three") were not reproduced; the per-season arithmetic above is from the code.
