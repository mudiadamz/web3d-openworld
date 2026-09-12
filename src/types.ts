import type { InstancedMesh, Matrix4, PointLight } from 'three';
// Declared where it is built, taken from there rather than written twice.
import type { ModelSet } from './wildlife.js';

/* -------------------------------------------------------------------------
   The shapes the island is made of

   A camp and a person are what every module here passes around, so what they
   are is written once, in a file with nothing else in it. What it imports it
   imports as types, and it emits nothing at all: every shape below is gone by
   the time the page runs.

   Both are re-exported by people.ts, which is where `camps` and `people`
   live, so a module can take either from wherever it already imports.
   ------------------------------------------------------------------------- */

/** What somebody is carrying. Counts, except for the animal over the shoulder
    and the rock a quarry trip came out of, which are kinds rather than
    numbers. Wood and vegetables arrive with the skills that fetch them. */
export interface Bag {
  fruit: number;
  berries: number;
  fish: number;
  game: number;
  animal: string | null;
  ore: number;
  oreKind: string | null;
  wood?: number;
  vegetables?: number;
}

/** A piece of farmland: where it is, which way its rows run, the water a ditch
    can be dug from, and what it is worth to a band (farming.ts). */
export interface Field {
  x: number; z: number; y: number;
  a: number;
  src: { x: number; z: number };
  length: number;
  soil: number;
  worth: number;
}

/** A place to sit: one of the core's fires, an outskirt hearth's, or a city
    doorstep. All three go in the same list on a camp, which is what `slot`
    records — where in that list this one was put (people.ts, assignHuts). */
export interface FirePoint {
  x: number; y: number; z: number;
  slot?: number;
}

/** A tent on the outskirts: where its door is, the transform it is drawn with,
    and the shade of its hide. */
export interface OuterHut {
  hut: { x: number; z: number };
  at: Matrix4;
  hide: number;
}

/** One fire out past the core, with its ring of tents and the stones and logs
    laid round it (settlement.ts). */
export interface Hearth {
  fire: FirePoint;
  huts: OuterHut[];
  stones: Matrix4[];
  logs: Matrix4[];
}

/** A working yard between the hearths, and the places in it a store can go. */
export interface YardSpot {
  x: number; z: number;
  fx: number; fz: number;
  at: Matrix4;
}

/** Something the rung has bought and the ground it stands on: a hall, a
    market, a well. Null while a place has been claimed but not yet sited. */
export interface CivicPlace {
  x: number; y: number; z: number;
  face: number;
}

/** A village's outskirts: the fires lit past the core, the yards between them,
    and whatever the rung has bought — a hall, a market, a well, a wall. */
export interface Outskirts {
  x: number; z: number;
  hearths: Hearth[];
  yards: { spots: YardSpot[] }[];
  // One per tent out here: the tent, and the fire that tent stands round.
  seats: { hut: { x: number; z: number }; fire: FirePoint }[];
  next: number;
  done: boolean;
  civic: Record<string, CivicPlace | null>;
}

/** A plot on a city's grid before anything stands on it: where it is, which
    way it faces, and where it falls on the street (settlement.ts). */
export interface CityPlot {
  x: number; z: number;
  fx: number; fz: number;
  u: number; v: number;
  side: number;
}

/** A house on a city street: the transform it is drawn with, the shade of its
    walls, the doorstep somebody lives at and the fire they sit at. The slot on
    the step is the camp's own fire list, which a house is added to. */
export interface CityHome {
  x: number; z: number;
  at: Matrix4;
  hide: number;
  door: { x: number; z: number };
  step: FirePoint;
  u: number; v: number;
  side: number;
}

/** A city: the houses and stores along its streets, and the trees its streets
    were cut through. */
export interface City {
  x: number; z: number;
  cand: CityPlot[] | null;
  next: number;
  homes: CityHome[];
  stores: { at: Matrix4 }[];
  trees: { x: number; z: number }[] | null;
}

/** One thing a band learned from a death: how hard it is held, when it was
    last taught, and whether the chronicle has said so (lessons.ts). */
export interface Lesson {
  w: number;
  day: number;
  told?: boolean;
}

/** What a band remembers. The places are where somebody was killed; the rest
    are the lessons, held by name. The index signature is what `takeLesson`
    needs to write one by name — a Lessons is read that way as often as it is
    read by field. */
export interface Lessons {
  places: { x: number; z: number; w: number; day: number }[];
  famine?: Lesson;
  overwork?: Lesson;
  sickness?: Lesson;
  infants?: Lesson;
  raiding?: Lesson;
  [key: string]: Lesson | { x: number; z: number; w: number; day: number }[] | undefined;
}

/** The ditch a band digs to its field: which field it is for, the line it
    takes from the water, and how long that line is (farming.ts). */
export interface Ditch {
  of: Field;
  path: { x: number; z: number }[] | null;
  length: number;
}

/** A place on the island worth digging: what is in it, how much it held and
    how much is still there, and the turn it is drawn at (quarries.ts). */
export interface Deposit {
  i: number;
  kind: string;
  x: number; z: number;
  full: number;
  left: number;
  turn: number;
}

/** What a predator goes by: how far it notices something, how close it has to
    get, how long it eats for, and how much it would rather have four legs than
    two (wildlife.ts, SPECIES). Only a predator carries one. */
export interface AnimalHunt {
  sees: number;
  reach: number;
  feeds: number;
  prefersAnimals: number;
}

/** A species, as much of it as anything outside wildlife.ts reads. The table
    itself (SPECIES) carries thirty-odd more fields, all of them geometry for
    drawing the thing; those are read off the table directly, where they are
    inferred, rather than through here. */
export interface AnimalSpec {
  key: string;
  label: string;
  predator?: boolean;
  gait: string;
  hunt?: AnimalHunt;
}

/** One animal. Everything from `prey` down is only used by a predator or a
    fruit-eater; the rest is any of them (wildlife.ts). `dead` is not in the
    literal one is built from — it arrives when something kills it. */
export interface Animal {
  x: number; z: number;
  yaw: number; speed: number; phase: number;
  scale: number;
  herd: number;
  state: string;
  timer: number;
  energy: number;
  targetX: number; targetZ: number;
  neck: number;
  grazeDown: boolean;
  lookTimer: number;
  tailOff: number;
  dead?: boolean;
  // What it is after, which is either one of its own kind or one of ours.
  prey?: { kind: 'animal'; a: Animal; pack: Pack }
    | { kind: 'person'; person: Person }
    | null;
  chase?: number;
  rest: number;
  fed: number;
  rootTimer: number;
}

/** Every animal of one species, with the meshes they are all drawn from and
    the herds they wander in (wildlife.ts). */
export interface Pack {
  spec: AnimalSpec;
  list: Animal[];
  herds: { x: number; z: number; timer: number }[];
  /* One mesh per body part — body, neck, head, legs, horns — each carrying
     every animal of the species as an instance, which is what makes a herd of
     hundreds one draw call. Keyed by part name (wildlife.ts). */
  parts: Record<string, InstancedMesh>;
  /* Real geometry from a glTF file, over the top of the boxes and cones rather
     than instead of them — null whenever a species has none, which is the
     ordinary case and not a failure (wildlife.ts). */
  model: ModelSet | null;
  gait: number[];
}

/** What a hunter is after: the animal, and the herd it belongs to. */
export interface Prey {
  animal: Animal;
  pack: Pack;
}

/** A band's dock: the shore point it is built on, the bearing it runs out on,
    the far end of its deck, and where the raft is moored (larder.ts). */
export interface Dock {
  of: { x: number; z: number };
  a: number;
  x: number; z: number;
  ex: number; ez: number;
  mx: number; mz: number;
}

/** What somebody looks like, drawn from their own id and never stored: their
    build, their face and their hair (looks.ts). */
export interface Look {
  build: string;
  face: string;
  hair: string;
}

/** A band — and later a village, a chiefdom, a city.

    What a camp *is* is written in three places: the world build below,
    `splitCamp` (life.ts) and `campFromRecord`. What it becomes is written
    across twenty modules, which is why almost all of this is optional: a camp
    founded this morning has a name, a fire and an empty store, and everything
    else arrives — its huts when it is laid out, its field when it digs one, its
    outskirts when it outgrows one ring of tents.

    `camps` below is not typed as Camp[] yet. Doing that checks every property
    access in every module against this list, which is the point of writing it
    and is a piece of work of its own; this is the shape written down first, and
    the three places that build one are checked against it. */
export interface Camp {
  // Who they are. The colour is a getter off the code, so it is never stored.
  index: number;
  x: number; z: number; y: number;
  name: string;
  code: string;
  readonly color?: string;
  rng?: () => number;
  voice?: string[];
  // The books, opened once a day (life.js, updateEconomy).
  food: number; need: number; pop: number; hunger: number;
  born: number; peak: number; lost?: number;
  wasEmpty: boolean;
  toll: Record<string, number>;
  // A row a day: how many they were, how many of those were children, and what
  // was in the store. What the band's chart on the panel is drawn from.
  history: { day: number; pop: number; kids: number; food: number }[];
  founded: number;
  gone: boolean;
  // What they know, and what they have been told they know (skills.js).
  skill: Record<string, number>;
  told: Record<string, number>;
  // What they hold.
  stone: number;
  ores?: Record<string, number>;
  wood?: number;
  raft?: boolean;
  // Whoever has it out on the water: one band, one raft, so this is a person.
  raftOut?: Person | null;
  stock?: number;
  storesUp?: number;
  storeAt?: Matrix4[];
  storeSpots?: { x: number; z: number; fx: number; fz: number }[];
  // Where they live, and how many households that is (people.ts, layOut).
  families?: number;
  huts?: { x: number; z: number }[];
  // Where each tent stands, as the transform it is drawn with.
  hutAt?: Matrix4[];
  hearths?: number;
  hearthTurn?: number;
  /* Every place in the camp somebody sits: the core's fires first, then one per
     outskirt hearth, then a city's doorsteps. One list, because everything that
     means "go home" indexes into it. */
  fireAt?: FirePoint[];
  flicker?: number;
  // The nearest bit of coast, if there is one within reach (larder.ts).
  shore?: { x: number; z: number } | null;
  dock?: Dock | null;
  // How far the place reaches — a clearing, a village's outskirts, a city's
  // streets — and the one light it is lit by.
  reach?: number;
  light?: PointLight | null;
  /* What the outskirts draw, rebuilt whenever any band changes: which packed
     slot each fire went in, and the yard spots the stores stand on. */
  outerFires?: { slot: number; fire: FirePoint; f: number }[];
  outerStores?: YardSpot[];
  /* How hard its own ground is being worked, and whether raiders are standing
     in it: both written by the day's book-keeping rather than at founding. */
  pressed?: number;
  /* Whoever is standing in it, not how many: read off the raiders each step
     rather than kept, so it ends the moment the raid does (move.ts). */
  underRaid?: Person | null;
  barrow?: { x: number; z: number; y: number; a: number } | null;
  buried?: number;
  // The ground they work, and what they remember of it.
  patches?: { x: number; z: number; worth: number }[];
  finds?: { x: number; z: number; worth: number }[];
  field?: Field | null;
  fieldAt?: string | null;
  fieldPin?: { x: number; z: number } | null;
  ditch?: Ditch | null;
  ditchDug?: number;
  lessons?: Lessons;
  // What they have become (society.js), and the places that came with it.
  stage?: number;
  stageFrom?: number;
  stageSince?: number | null;
  risingSince?: number | null;
  slippingSince?: number | null;
  splitAt?: number;
  outer?: Outskirts | null;
  outerShown?: number;
  // How many of the outskirts' hearths are burning: a count, not a flag.
  outerLit?: number;
  city?: City | null;
  cityShown?: number;
  // Who leads them, and who they have fought.
  chief?: number;
  lastRaid?: number;
  villageName?: string | null;
  pastCodes?: string[];
  conqueredAt?: number;
}

/** One person. Built in two places — `newPerson` (life.ts) at birth and at the
    world build, and `personFromRecord` (save.ts) coming back from a save — and
    the two agree on everything a person *is*. The rest arrives while they live:
    what they are carrying, what they are doing and whose hand is on their
    shoulder. Optional means "not from the moment they are born", not "rare". */
export interface Person {
  // Who they are, and whose they are.
  id: number;
  camp: Camp;
  name: string;
  kind: string;
  sex: string;
  child: boolean;
  born: number;
  // Descent (kin.ts): the names are what a child's record called them.
  mother: number; father: number;
  motherName: string; fatherName: string;
  line: string; gen: number;
  // The body they will grow into, and the one they have today.
  adultScale: number; adultShoulder: number; adultHip: number; adultHead: number;
  scale: number; shoulder: number; hip: number; headScale: number;
  // Where they are and where they are going.
  x: number; z: number; yaw: number; speed: number; phase: number;
  targetX: number; targetZ: number;
  state: string;
  job: string;
  timer: number;
  work?: number;
  // How they are.
  energy: number;
  nourish: number;
  sick: number;
  immuneUntil: number;
  life?: number;
  panic: number;
  // What they are doing with their hands and their body.
  crouch: number; bend: number;
  carry: number;
  hasSpear: boolean;
  asleep: boolean;
  hidden: boolean;
  resting?: boolean;
  hiding?: boolean;
  // The heap they are digging at, while they are at it.
  digging?: Deposit | null;
  /* Walking round something and then carrying on: which way they stepped, and
     when — held for a few seconds so they follow an obstacle rather than
     bouncing off it (move.ts, DODGE_HOLD). */
  swerve?: number;
  swerveAt?: number;
  // Heading home, with their load put away, and how cold they got on the way.
  goingHome?: boolean;
  stowed?: boolean;
  cold?: number;
  /* Where they were when the caption last spoke for them — a position, not a
     time — and whether they have tended the fire today. Both guessed wrong the
     first time this was written, and the compiler said so. */
  lastSeen?: number[];
  tended?: boolean;
  // The tree they are up, while they are up it.
  climbed?: { x: number; z: number } | null;
  lift?: number;
  throwPose?: number;
  acting?: boolean;
  /* What they are in the middle of doing, if anything: the kind of act, and
     whatever that kind needs — all of a load rather than a handful, the tree
     being climbed. */
  act?: { kind: string; all?: boolean; tree?: { x: number; z: number } } | null;
  actResult?: string | null;
  // What they are carrying, and what it came to.
  haul: number;
  bag?: Bag | null;
  brought?: number;
  prey?: Prey | null;
  attempt: number;
  kills: number;
  // Being led, sent, or taken along.
  led: boolean;
  leadX?: number; leadZ?: number;
  orders: string | null;
  // Whose fire they are walking to, and whose they are walking at: both a band.
  visiting: Camp | null;
  // The band whose raft they are standing on — a camp, not a raft: one band,
  // one raft, so the camp is the raft as far as anything here is concerned.
  onRaft?: Camp | null;
  /* A trip out fishing: the water they are making for, the dock they left, how
     long the whole errand is and how much of that is the paddle out — the two
     together are what places them on the way (rafts.ts). `landX`/`landZ` is the
     shore they walked down from, which is where they are put back. */
  raftTrip?: { spot: { x: number; z: number }; dock: Dock; total: number; out: number;
    landX: number; landZ: number } | null;
  raiding?: Camp | null;
  // What they know, what they have been taught, and what they have moved to.
  knows: Record<string, number>;
  taught: boolean;
  moved: boolean;
  role?: string | null;
  lastBirth?: number;
  // What they look like, and which slots are drawn for them (looks.ts).
  // Colours off the tables in people.ts, and a shade to vary each one by.
  skin: number; skinShade: number;
  garment: number; garmentShade: number;
  hairColor: number;
  traits: { bold: number; sociable: number; quick: number };
  look?: Look;
  /* Which parts are drawn for them and which slot each one sits in, both keyed
     by the part's name — 'tunic', 'hair:long', 'cargo:fish'. `wornStamp` is
     what the two were last built against, so a change redraws them. */
  worn?: Record<string, string> | null;
  wornAt?: Record<string, number> | null;
  wornStamp?: Record<string, number> | null;
  /* The tent or doorstep they live at, and the fire they sit at. Both come off
     the household rather than the person (people.ts, layOut), so everyone under
     one roof goes home to one fire rather than all sixty to the first one. */
  hut?: { x: number; z: number };
  hearth?: FirePoint;
}
