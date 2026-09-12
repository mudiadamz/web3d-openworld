/* What somebody is carrying, counted the way you would count it. Words and a
   colour come of it and nothing else: the food a band eats is still the haul,
   and ore goes on the pile. No imports — both of its readers are in the middle
   of import cycles it has no business being part of. */

/* -------------------------------------------------------------------------
   What is in the basket

   A haul is one number in food units, which is what the store needs and not
   what anybody would say: the caption read "carrying 10", and ten of what? So
   alongside it, what it actually is, counted the way you would count it —
   fruit, berries and fish by the piece, an animal as the animal. Words and a
   colour come of it and nothing else; the food is still the haul.
   ------------------------------------------------------------------------- */
export const BAG = {
  berry: 0.02,         // food in a berry, the same as a fruit off the tree
  fish: 0.1,           // food in a fish: a morning's catch is a handful of them
  veg: 0.05,           // food in a vegetable: a session in the field is a basket of them
};

/* `what` is only given for the two kinds that have one — the animal a kill was,
   the rock a quarry trip came out of — so it is optional, and saying so is what
   lets the dozen callers that add berries or logs keep calling with three. */
export function bagAdd(p, kind, n, what?) {
  if (!(n > 0)) return;
  const bag = p.bag
    || (p.bag = { fruit: 0, berries: 0, fish: 0, game: 0, animal: null, ore: 0, oreKind: null });
  bag[kind] = (bag[kind] || 0) + n;
  // What sort: the animal a kill was, or the rock a quarry trip came out of.
  if (what) { if (kind === 'ore') bag.oreKind = what; else bag.animal = what; }
}


/** Emptied into the store with the haul, and at no other time. */
export function emptyBag(p) {
  if (!p.bag) return;
  p.bag.fruit = 0; p.bag.berries = 0; p.bag.fish = 0; p.bag.game = 0; p.bag.animal = null;
  p.bag.ore = 0; p.bag.oreKind = null; p.bag.wood = 0; p.bag.vegetables = 0;
}

/** Whether they are carrying anything at all: food, stone or ore, or wood. */
export function hasLoad(p) {
  return p.haul > 0 || p.bag?.ore > 0 || p.bag?.wood > 0;
}

/** What is in it, the way you would say it: "a deer", "5 fish", "4 fruit and
    22 berries". Two things at most, an animal first and berries last — a
    basket read out item by item is an inventory, not a sentence. Empty when
    nothing was counted. */
export function bagWords(bag, all = false) {
  if (!bag) return '';
  const said = [];
  // Stone by the stone; a metal as the ore it is still in.
  if (bag.ore > 0) {
    said.push(!bag.oreKind || bag.oreKind === 'stone'
      ? `${bag.ore} stone${bag.ore === 1 ? '' : 's'}` : `${bag.ore} ${bag.oreKind} ore`);
  }
  if (bag.wood > 0) said.push(bag.wood === 1 ? 'a log' : `${bag.wood} logs`);
  if (bag.game > 0) {
    const a = bag.animal || 'kill';
    said.push(bag.game === 1 ? `${/^[aeiou]/.test(a) ? 'an' : 'a'} ${a}`
      : `${bag.game} ${['deer', 'bison'].includes(a) ? a : `${a}s`}`);
  }
  if (bag.fish > 0) said.push(`${bag.fish} fish`);
  if (bag.vegetables > 0) said.push(`${bag.vegetables} ${bag.vegetables === 1 ? 'vegetable' : 'vegetables'}`);
  if (bag.fruit > 0) said.push(`${bag.fruit} fruit`);
  if (bag.berries > 0) said.push(`${bag.berries} ${bag.berries === 1 ? 'berry' : 'berries'}`);
  // All of it, for the basket on screen: a list there rather than a sentence.
  return all ? said.join(', ') : said.slice(0, 2).join(' and ');
}

/** Which of them the load looks like: an animal if there is one, then the
    catch, then whichever of fruit and berries there is more of. */
export function bagKind(bag) {
  if (!bag) return null;
  if (bag.ore > 0) return bag.oreKind || 'stone';
  if (bag.wood > 0) return 'wood';
  if (bag.game > 0) return 'game';
  if (bag.fish > 0) return 'fish';
  if (bag.vegetables > 0) return 'vegetables';
  if (bag.fruit > 0 || bag.berries > 0) return bag.fruit >= bag.berries ? 'fruit' : 'berries';
  return null;
}

/* -------------------------------------------------------------------------
   How heavy it is

   A load weighs something now, for the person you are playing. A basketful of
   food is a load of one — fifty berries, fifty fruit or ten fish — a stone a
   third of that, an animal what it is: a rabbit is nothing much, a deer most
   of what anybody can carry, and a bison more than anybody can. What one
   person can carry is a basketful, more for a band that weaves good baskets
   and half for a child. The fuller, the slower; at or past it, not at all.
   ------------------------------------------------------------------------- */
export const LOAD = {
  fruit: 0.02,         // the same as a fruit is worth off the tree (ORCHARD.worth)
  stone: 0.35,         // a piece of rock
  ore: 0.3,            // a lump of ore
  wood: 0.2,           // a log
  animal: { rabbit: 0.3, boar: 0.8, deer: 0.9, bison: 1.6 },
  basket: 1,           // what one grown person can carry, before baskets
  slows: 0.7,          // how much of their pace a load just short of full takes
};

/** What they are carrying weighs, in basketfuls. */
export function loadOf(p) {
  const bag = p.bag;
  // A session saved before loads were counted: the food is the weight.
  if (!bag) return p.haul > 0 ? p.haul : 0;
  let load = (bag.berries || 0) * BAG.berry + (bag.fruit || 0) * LOAD.fruit + (bag.fish || 0) * BAG.fish
    + (bag.vegetables || 0) * BAG.veg;
  if (bag.game > 0) load += bag.game * (LOAD.animal[bag.animal] ?? 1);
  if (bag.ore > 0) load += bag.ore * (!bag.oreKind || bag.oreKind === 'stone' ? LOAD.stone : LOAD.ore);
  if (bag.wood > 0) load += bag.wood * LOAD.wood;
  return load;
}

/** What they can carry: a basketful, more with better baskets, half for a child. */
export function carryCap(p, basketHaul, baskets) {
  return LOAD.basket * (1 + basketHaul * baskets) * (p.child ? 0.5 : 1);
}

/** Their pace under it: all of it empty, less the fuller, none at or past full. */
export function loadPace(load, cap) {
  const f = cap > 0 ? load / cap : 1;
  if (f >= 1) return 0;
  return 1 - LOAD.slows * f ** 1.3;
}

/* -------------------------------------------------------------------------
   One handful at a time

   What one press of G takes out: an animal before anything, being the
   heaviest; then a stone or a lump of ore; then a fish, five fruit, ten
   berries. The food it was worth comes off the haul with it, so the pile on
   the ground and what is left in the basket add up to what there was — and the
   last of it takes whatever the rounding left, so nothing goes missing.
   ------------------------------------------------------------------------- */
export const DROP_UNIT = { berries: 10, fruit: 5, fish: 1, vegetables: 5 };

export function takeOut(p) {
  const bag = p.bag;
  if (!bag) {
    if (!(p.haul > 0)) return null;
    const food = p.haul;
    p.haul = 0;
    p.carry = 0;
    return { kind: 'food', n: 1, food };
  }
  const basket = (bag.berries || 0) * BAG.berry + (bag.fruit || 0) * LOAD.fruit + (bag.fish || 0) * BAG.fish
    + (bag.vegetables || 0) * BAG.veg;
  let out = null;
  if (bag.game > 0) {
    out = { kind: 'game', n: 1, animal: bag.animal, food: Math.max(0, p.haul - basket) / bag.game };
    bag.game--;
    if (!bag.game) bag.animal = null;
  } else if (bag.ore > 0) {
    out = { kind: 'ore', n: 1, oreKind: bag.oreKind || 'stone', food: 0 };
    bag.ore--;
    if (!bag.ore) bag.oreKind = null;
  } else if (bag.wood > 0) {
    out = { kind: 'wood', n: 1, food: 0 };
    bag.wood--;
  } else {
    for (const [kind, worth] of [['fish', BAG.fish], ['vegetables', BAG.veg], ['fruit', LOAD.fruit], ['berries', BAG.berry]] as [string, number][]) {
      if (!(bag[kind] > 0)) continue;
      const n = Math.min(DROP_UNIT[kind], bag[kind]);
      bag[kind] -= n;
      out = { kind, n, food: n * worth };
      break;
    }
  }
  if (!out) {
    if (!(p.haul > 0)) return null;
    out = { kind: 'food', n: 1, food: p.haul };
  }
  p.haul = Math.max(0, p.haul - out.food);
  const left = (bag.berries || 0) + (bag.fruit || 0) + (bag.fish || 0) + (bag.game || 0) + (bag.ore || 0)
    + (bag.wood || 0) + (bag.vegetables || 0);
  if (!left) { out.food += p.haul; p.haul = 0; }
  p.carry = hasLoad(p) ? 1 : 0;
  return out;
}

/** A pile picked back up: into the basket as it came out of it. */
export function putIn(p, pile) {
  if (pile.kind === 'ore') bagAdd(p, 'ore', pile.n, pile.oreKind);
  else if (pile.kind === 'game') bagAdd(p, 'game', pile.n, pile.animal);
  else if (pile.kind !== 'food') bagAdd(p, pile.kind, pile.n);
  p.haul = (p.haul || 0) + pile.food;
  p.carry = 1;
}

/** A meal out of the basket: berries, then fruit, then fish, then off the
    animal on their shoulder — until `want` food is eaten or there is none.
    Returns what was eaten, and takes it off the haul. */
export function eatFromBag(p, want) {
  if (!(p.haul > 0)) return 0;
  const bag = p.bag;
  const items = bag ? (bag.berries || 0) + (bag.fruit || 0) + (bag.fish || 0) + (bag.vegetables || 0) + (bag.game || 0) : 0;
  let ate = 0;
  if (items) {
    for (const [kind, worth] of [['berries', BAG.berry], ['vegetables', BAG.veg], ['fruit', LOAD.fruit], ['fish', BAG.fish]] as [string, number][]) {
      while (ate < want - 1e-9 && bag[kind] > 0) { bag[kind]--; ate += worth; }
    }
    // Off the animal: its meat is what the haul holds past the basket.
    const basket = (bag.berries || 0) * BAG.berry + (bag.fruit || 0) * LOAD.fruit + (bag.fish || 0) * BAG.fish
      + (bag.vegetables || 0) * BAG.veg;
    if (ate < want && bag.game > 0) ate += Math.max(0, Math.min(want - ate, p.haul - ate - basket));
  } else ate = want;
  ate = Math.min(ate, p.haul);
  p.haul -= ate;
  if (p.haul < 1e-9) p.haul = 0;
  p.carry = hasLoad(p) ? 1 : 0;
  return ate;
}
