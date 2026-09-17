import { P } from './params.js';
import { luck } from './clock.js';
import { camps, dressCamp, dressStores, homeward, paintPeople, people } from './people.js';
import { CITY, campReach } from './settlement.js';
import { CONQUEST, VISIT, conquer, logEvent, personAge, simDay } from './life.js';
import { recordMove } from './wildlife.js';
import { SKILL, SKILLS, practise } from './skills.js';
import { POLICE } from './riding.js';

/* -------------------------------------------------------------------------
   From band to city

   A settlement is not what it is by decree. It is a band while it forages and
   moves nothing; it becomes a tribe when it has settled at its fields; a
   chiefdom when one of them leads with warriors behind him, or rules more than
   one village, and the band has raised something over its dead; a village
   when it is a permanent place of fields and flocks and proper houses; and a
   city when it is big, trades, builds in stone, and has other villages under
   it.

   The steps are careful on purpose, because the change is the interesting part
   and a switch is not a change:

     - one rung at a time, never two;
     - the next rung's marks have to hold for SOCIETY.hold sim-years before it
       is reached, so a good season is not a revolution;
     - a settlement that stops meeting its own rung for SOCIETY.slip years
       falls back one, which is how chiefdoms end;
     - and the way people spend their days shifts across SOCIETY.blend years
       after each step — foraging and hunting giving way to the fields, the
       workshops, the neighbours, the war band and the stones — rather than
       overnight. Hunger undoes all of it: a starving city forages like a band.

   Settlements also hold more people before they split as they climb, or the
   split rule — a band goes at two dozen — would stop any of them ever reaching
   the size a chiefdom or a city is.

   Nothing here is called while a module loads: life.js imports this back.
   ------------------------------------------------------------------------- */
export const SOCIETY = {
  hold: 1.5,          // sim-years the next rung's marks must hold before it is reached
  slip: 3,            // sim-years of failing its own rung before a settlement falls back
  blend: 1,           // sim-years over which the day's work shifts after a step
  farmAway: 0.55,     // how much less a band that farms forages and hunts, at mastery
};

/* `split` multiplies SPLIT.at. `mix` leans each errand against the others; an
   errand not named stays as it was. */
export const STAGES = [
  { name: 'band', split: 1.0,
    mix: { gather: 1.0, hunt: 1.0, fish: 1.0, farm: 0.7, craft: 0.9, visit: 1.0, raid: 0.6, mourn: 1.0, quarry: 0.9 } },
  { name: 'tribe', split: 2.5,
    mix: { gather: 0.9, hunt: 0.9, fish: 1.0, farm: 1.2, craft: 1.0, visit: 1.0, raid: 0.8, mourn: 1.1, quarry: 1.0 } },
  { name: 'chiefdom', split: 3.5,
    mix: { gather: 0.75, hunt: 0.8, fish: 0.9, farm: 1.4, craft: 1.1, visit: 1.1, raid: 1.3, mourn: 1.3, quarry: 1.2 } },
  { name: 'village', split: 5.0,
    mix: { gather: 0.6, hunt: 0.6, fish: 0.8, farm: 1.7, craft: 1.3, visit: 1.3, raid: 1.1, mourn: 1.3, quarry: 1.3 } },
  { name: 'city', split: 9.0,
    mix: { gather: 0.45, hunt: 0.45, fish: 0.7, farm: 1.9, craft: 1.5, visit: 1.6, raid: 1.4, mourn: 1.4, quarry: 1.5 } },
];

/** Living villages flying this settlement's code: the tribe it belongs to. */
export function villagesOf(camp) {
  let n = 0;
  for (const c of camps) if (!c.gone && c.pop > 0 && c.code === camp.code) n++;
  return n;
}

/* What each rung asks. Read against what the settlement is now: its people,
   its skills, its flock, and how many villages its tribe holds. */
const MARKS = [
  () => true,
  (c, s) => c.pop >= 20 && (s.farming || 0) >= 0.25,
  (c, s, v) => c.pop >= 30 && ((s.war || 0) >= 0.25 || v >= 2) && (s.art || 0) >= 0.25,
  (c, s) => (s.farming || 0) >= 0.5 && (s.building || 0) >= 0.5 && (c.stock || 0) >= 4,
  (c, s, v) => c.pop >= 60 && (s.trade || 0) >= 0.5 && (s.stonework || 0) >= 0.5 && v >= 2,
];
export function meets(camp, stage) {
  return MARKS[stage](camp, camp.skill || {}, villagesOf(camp));
}

export const stageName = (camp) => STAGES[camp.stage || 0].name;
export const nextStage = (camp) => STAGES[(camp.stage || 0) + 1] || null;
/** How far a settlement is through holding the next rung's marks, 0 to 1. */
export function stageProgress(camp) {
  if (camp.risingSince == null || !nextStage(camp)) return 0;
  return Math.min(1, (simDay - camp.risingSince) / (SOCIETY.hold * P.yearLength));
}

/* How far a settlement has come, out of a hundred, for the panel: what it
   knows — every skill, averaged — and how far up from band to city it has
   climbed. Seven parts the first to three the second: the ladder is five slow
   rungs and the skills are twenty-one that move every season, and a band that
   has learned a great deal without settling has still come a long way. */
export const DEVELOPMENT = { skills: 0.7, stage: 0.3 };
export function developmentOf(camp) {
  const s = camp.skill || {};
  const keys = Object.keys(SKILLS);
  const known = keys.reduce((n, k) => n + Math.min(1, Math.max(0, s[k] || 0)), 0) / keys.length;
  const rung = (camp.stage || 0) / (STAGES.length - 1);
  return Math.round(100 * (DEVELOPMENT.skills * known + DEVELOPMENT.stage * rung));
}

const aOr = (word) => (/^[aeiou]/.test(word) ? 'an ' : 'a ') + word;

function setStage(c, to) {
  const from = c.stage || 0;
  c.stageFrom = from;
  c.stage = to;
  c.stageSince = simDay;
  c.risingSince = null;
  c.slippingSince = null;
  logEvent('stage', to > from
    ? `[${c.code}] ${c.name} has become ${aOr(STAGES[to].name)}`
    : `[${c.code}] ${c.name} is no longer ${aOr(STAGES[from].name)} — ${aOr(STAGES[to].name)} again`,
  c.x, c.z);
  // And it looks it at once: houses, a hall, a market and a wall (people.js).
  dressCamp(c);
}

/** On the books: a step up when the next rung has held, a step down when this one has failed. */
export function updateSociety() {
  const year = P.yearLength;
  for (const c of camps) {
    if (c.gone || !(c.pop > 0)) continue;
    const at = c.stage || 0;
    if (at < STAGES.length - 1 && meets(c, at + 1)) {
      if (c.risingSince == null) c.risingSince = simDay;
      if (simDay - c.risingSince >= SOCIETY.hold * year) { setStage(c, at + 1); continue; }
    } else c.risingSince = null;
    if (at > 0 && !meets(c, at)) {
      if (c.slippingSince == null) c.slippingSince = simDay;
      if (simDay - c.slippingSince >= SOCIETY.slip * year) setStage(c, at - 1);
    } else c.slippingSince = null;
  }
}

/* How much the stage a settlement has reached leans one errand, blended from
   the rung it came from across SOCIETY.blend years — and pulled back toward
   no lean at all by hunger, because a hungry city forages like a band. */
export function jobMix(camp, job, hunger) {
  const to = STAGES[camp.stage || 0].mix, from = STAGES[camp.stageFrom ?? camp.stage ?? 0].mix;
  const t = camp.stageSince == null ? 1 : Math.min(1, (simDay - camp.stageSince) / (SOCIETY.blend * P.yearLength));
  const a = from[job] ?? 1, b = to[job] ?? 1;
  const m = a + (b - a) * t;
  const mixed = m + (1 - m) * Math.min(1, Math.max(0, hunger));
  /* And a band that has taken to farming walks the hillside and hunts the less
     for it, the better it farms — which hunger undoes as well, like the rest. */
  const farmed = job === 'gather' || job === 'hunt'
    ? (camp.skill?.farming || 0) * (1 - Math.min(1, Math.max(0, hunger))) : 0;
  return farmed > 0 ? mixed * (1 - SOCIETY.farmAway * farmed) : mixed;
}

/* -------------------------------------------------------------------------
   A border

   Fighting used to be learned in one way only: a raid, from either end of
   it. And a raid is a hungry band taking food - test.js holds it above
   begging, because a band that could still walk over and ask, asks. So on an
   island that feeds everybody nobody ever raided, and nobody ever learned to
   fight, however close two tribes pitched their fires.

   Which is not how it goes. People who live within sight of somebody else's
   smoke keep a watch, square up at the stream, and know what they would do.
   A foreign camp close by teaches fighting slowly, every day, with nobody
   hurt - and the raid is still what it was, for when there is no food.

   Two things it has to do or it does nothing at all:

   - Beat the fade. Every skill loses SKILL.fade a day whether or not it was
     practised, so a border has to teach more than that or the number only
     ever falls. At its tightest it teaches two and a half times the fade;
     at forty percent of the reach it breaks even, and past that it fades,
     as a peaceful band's fighting should.

   - Lift what people know. practise caps a band at a step past the best of
     what its living people know, and nothing raised anybody's knowing of
     war - so the camp's number alone would stop at fourteen and stay there,
     looking fixed and not being. The adults know what the band knows.

   Villages of the same tribe do not count: raidTarget skips them for the
   same reason. It is somebody else's smoke. */
export const BORDER = {
  reach: 300,          // metres: a foreign camp this close is somebody you watch
  perDay: 0.025,       // fighting a day at the tightest - two and a half times SKILL.fade
};

export function borderTension(days) {
  if (!(days > 0)) return;
  for (const camp of camps) {
    if (camp.gone) continue;
    let near = Infinity;
    for (const c of camps) {
      if (c === camp || c.gone || c.code === camp.code) continue;
      near = Math.min(near, Math.hypot(c.x - camp.x, c.z - camp.z));
    }
    if (!(near < BORDER.reach)) continue;
    const tight = 1 - near / BORDER.reach;      // nothing at the edge, all of it next door
    practise(camp, 'war', BORDER.perDay * tight * days);
    const level = camp.skill?.war || 0;
    for (const p of people) {
      if (p.camp === camp && !p.child) p.knows.war = Math.max(p.knows.war || 0, level);
    }
  }
}

/* -------------------------------------------------------------------------
   Ties

   Ruling was learned one way: winning raids, once a band could fight. So the
   only tribes of more than one village were made by force, and a peaceful
   island - the one a well-fed island is - never made any at all.

   Which is not the only way it goes. Two bands that deal with each other year
   after year - food over the hill in a bad winter, stone for the band with no
   outcrop - come to depend on each other, and the one that does the dealing
   best comes to be the one the other looks to. In the end the smaller simply
   joins, and nobody had to be killed for it.

   A season in which the two bands visited each other ties them a little, and
   a season in which something changed hands - food, stone - ties them twice as
   much again. By the season rather than by the visit or the deal, because
   neighbours with stone to spare deal on nearly every visit, and counted that
   way the first island measured was one tribe inside a year. A tie that is not
   kept up loosens, over years. So bands that only ever visit never get there;
   bands that trade goods every other season join in about six years, and every
   season in about three. The better trader of the two leads the tie,
   and learns ruling from it every day the way a border teaches fighting: by
   enough to beat the fade once the tie is a third of the way to joining, and
   lifting what its adults know, or practise would hold it at a step past
   nothing. Once it can rule and the tie is full, the smaller band joins it -
   the same as being taken (conquer, life.js), and told as joining.

   Villages of one tribe do not tie: they already share a store. */
export const TIES = {
  keep: 4,             // years in which a tie left alone loosens to a third of itself
  call: 0.5,           // tie from a season in which the two bands visited each other
  deal: 1,             // and from a season in which something changed hands between them
  join: 6,             // tie at which the smaller band joins the better trader
  tradeFirst: 0.5,     // trading the leader needs before a tie teaches it to rule
  perDay: 0.03,        // ruling a day for the leader of a full tie - three times SKILL.fade
};

const tieOf = (a, b) => a.ties?.[b.index] || 0;

/* Once a season for each kind, per pair: `tiedAt` holds when each last counted,
   by the other band's index and the kind. */
function tie(home, host, kind) {
  if (home.code === host.code) return;
  const key = host.index + kind, tiedAt = (home.tiedAt ||= {});
  if (simDay - (tiedAt[key] ?? -Infinity) < P.yearLength / 4) return;
  tiedAt[key] = simDay;
  (host.tiedAt ||= {})[home.index + kind] = simDay;
  const t = tieOf(home, host) + TIES[kind] * tradeEdge(home, host);
  (home.ties ||= {})[host.index] = t;
  (host.ties ||= {})[home.index] = t;
}

/** A visit between two bands: both learn a little trading from the walk. */
export function calledOn(home, host) {
  practise(home, 'trade', SKILL.perCall * cityEdge(home, 'trade'));
  practise(host, 'trade', SKILL.perCall * cityEdge(host, 'trade'));
  tie(home, host, 'call');
}

/** A deal between two bands: both learn trading from it properly. */
export function dealtWith(home, host) {
  practise(home, 'trade', SKILL.perDeal * cityEdge(home, 'trade'));
  practise(host, 'trade', SKILL.perDeal * cityEdge(host, 'trade'));
  tie(home, host, 'deal');
}

/** Of two tied bands, the one the other looks to: the better trader, and the
    bigger if they are as good as each other. */
function leads(a, b) {
  const ta = a.skill?.trade || 0, tb = b.skill?.trade || 0;
  return ta !== tb ? ta > tb : (a.pop || 0) >= (b.pop || 0);
}

export function tradeTies(days) {
  if (!(days > 0)) return;
  const loosen = Math.exp(-days / (TIES.keep * P.yearLength) * Math.log(3));
  const byIndex = new Map(camps.map((c) => [c.index, c]));
  for (const camp of camps) {
    if (!camp.ties) continue;
    let rules = 0;
    for (const key in camp.ties) {
      const other = byIndex.get(Number(key));
      const t = camp.ties[key] * loosen;
      if (!other || other.gone || camp.gone || other.code === camp.code || t < 0.05) { delete camp.ties[key]; continue; }
      camp.ties[key] = t;
      if (leads(camp, other) && (camp.skill?.trade || 0) >= TIES.tradeFirst) rules = Math.max(rules, Math.min(1, t / TIES.join));
    }
    if (!(rules > 0)) continue;
    practise(camp, 'conquest', TIES.perDay * rules * days);
    const level = camp.skill?.conquest || 0;
    for (const p of people) {
      if (p.camp === camp && !p.child) p.knows.conquest = Math.max(p.knows.conquest || 0, level);
    }
  }
  /* And joining, once a tie is full and its leader can rule. One a day at most,
     so the chronicle says it once and nobody joins a band that has just joined
     somebody else. */
  for (const camp of camps) {
    if (camp.gone || !(camp.pop > 0) || (camp.skill?.conquest || 0) < CONQUEST.from) continue;
    for (const key in camp.ties || {}) {
      const other = byIndex.get(Number(key));
      if (!other || other.gone || !(other.pop > 0) || other.code === camp.code) continue;
      if (camp.ties[key] < TIES.join || !leads(camp, other) || (other.pop || 0) >= (camp.pop || 0)) continue;
      delete camp.ties[key];
      if (other.ties) delete other.ties[camp.index];
      conquer(camp, other, true);
      return;
    }
  }
}

/* -------------------------------------------------------------------------
   What a city has going for it

   A city is where the island's dealing is done and its best fields are, and
   people come to it. Three advantages, and each is one number:

     - trading: a city learns it faster from every visit and every deal, gives
       and gets more in a deal, and ties the bands it deals with to it faster —
       which is how a city comes to have villages join it;
     - farming: a city's field yields more a session, with the tools, the
       stores and the hands to work it;
     - and people: from anywhere on the island, the young leave a band that is
       not a city and walk to one — more from a hungry band, more to a city that
       is fed and good at dealing and farming, and further for a better one.
       Once in a life, like staying with a band they visited, and never out of a
       band too small to lose them.
   ------------------------------------------------------------------------- */
export const CITY_EDGE = {
  trade: 1.5,          // trading learned, given and tied, dealing with a city
  crop: 1.5,           // what a city's field yields a session
  drawPerDay: 0.35,    // chance a day a band sends somebody to a city, at the most a city draws
  far: 2000,           // metres at which a city draws half what it would next door
  keep: 8,             // a band this small sends nobody
  from: 16,            // years: old enough to go
};

export const isCity = (c) => (c?.stage || 0) >= STAGES.length - 1;
/** A city's edge at this, or nothing for anywhere else. */
export const cityEdge = (c, what) => (isCity(c) ? CITY_EDGE[what] : 1);
/** Dealing with a city, on either side of the deal. */
export const tradeEdge = (a, b) => (isCity(a) || isCity(b) ? CITY_EDGE.trade : 1);

/* How much a city draws people: fed, and good at what makes a city worth
   coming to. 0 to 1. */
function cityAppeal(city) {
  const s = city.skill || {};
  return Math.max(0, 1 - (city.hunger || 0)) * (0.6 + 0.2 * Math.min(1, s.trade || 0) + 0.2 * Math.min(1, s.farming || 0));
}

/** On the books: the young of the island moving to its cities. */
export function cityDraw(days) {
  if (!(days > 0)) return;
  const cities = camps.filter((c) => !c.gone && c.pop > 0 && isCity(c));
  if (!cities.length) return;
  for (const home of camps) {
    if (home.gone || isCity(home) || !((home.pop || 0) >= CITY_EDGE.keep)) continue;
    let to = null, most = 0;
    for (const c of cities) {
      const pull = cityAppeal(c) / (1 + Math.hypot(c.x - home.x, c.z - home.z) / CITY_EDGE.far);
      if (pull > most) { most = pull; to = c; }
    }
    if (!to || luck() >= days * CITY_EDGE.drawPerDay * most * (0.6 + (home.hunger || 0))) continue;
    const young = people.filter((p) => p.camp === home && !p.child && !p.moved && !p.sick && !p.led
      && p.job !== 'raid' && personAge(p) >= CITY_EDGE.from && personAge(p) < VISIT.stayUnder);
    if (!young.length) continue;
    const p = young[(luck() * young.length) | 0];
    p.moved = true;
    recordMove(p, home, to);
    p.camp = to;
    p.hut = to.huts[(luck() * to.huts.length) | 0];
    p.goingHome = true;                   // and they walk there, from wherever they are (move.js)
    to.newcomers = (to.newcomers || 0) + 1;
    paintPeople();
    /* Said once a season a city, not once a person: a city that draws a dozen
       a season would be most of the chronicle. */
    if (simDay - (to.newcomersSaid ?? -Infinity) >= P.yearLength / 4) {
      logEvent('joined', `${to.newcomers === 1 ? 'somebody' : `${to.newcomers} people`} came from across the island to live in [${to.code}] ${to.name}`, to.x, to.z);
      to.newcomersSaid = simDay;
      to.newcomers = 0;
    }
  }
}

/* -------------------------------------------------------------------------
   Moving in with the neighbours

   A village that joins or is taken by a band next door does not stay a town of
   its own behind its own wall a stone's throw away. Its people move in: they
   become the other band's people, walk over, and are housed there, and what
   they had put by goes with them, so the two are one town with one wall round
   it. The ground they left keeps its dead and grows over. Further off than
   MERGE.near, edge to edge, a village stays where it is and flies the flag,
   as before.
   ------------------------------------------------------------------------- */
export const MERGE = { near: 120 };    // metres between the two places' edges

export function mergeNeighbour(home, host) {
  if (home.gone || host.gone || home === host) return false;
  const gap = Math.hypot(home.x - host.x, home.z - host.z) - campReach(home) - campReach(host);
  if (gap > MERGE.near) return false;
  const moving = people.filter((p) => p.camp === host);
  for (const p of moving) {
    recordMove(p, host, home);
    p.camp = home;
    p.goingHome = true;                   // and they walk over (move.js)
  }
  home.food = Math.max(0, home.food) + Math.max(0, host.food);
  home.stone = Math.min(SKILL.stoneMax, (home.stone || 0) + (host.stone || 0));
  home.wood = (home.wood || 0) + (host.wood || 0);
  home.stock = (home.stock || 0) + (host.stock || 0);
  host.food = 0; host.stone = 0; host.wood = 0; host.stock = 0;
  host.storesUp = 0;
  home.pop = (home.pop || 0) + moving.length;
  host.pop = 0;
  dressStores(host);
  dressCamp(host);                        // nobody left: its houses come down
  host.gone = true;
  host.mergedInto = home.index;
  logEvent('conquest', `the people of ${host.villageName || host.name} moved in with [${home.code}] ${home.name}: one town now`, home.x, home.z);
  dressCamp(home);                        // and are housed with them
  paintPeople();
  return true;
}

/** How much more a city's defence counts for its patrol riders being out: seen
    coming, and met (POLICE, riding.js). One for anywhere with none. */
export function guarded(camp) {
  let riders = 0;
  for (const p of people) if (p.camp === camp && p.role === 'patrol' && !p.sick) riders++;
  return 1 + POLICE.guard * Math.min(1, riders / POLICE.full);
}

/* A place's name, the way a list or a card says it. A tribe of several places
   gave every one of them the tribe's name, and a list of six rows all reading
   "Neimosh" said nothing about which was which. So a place that joined the
   tribe or was taken keeps its own name in front of the tribe's - "Talo,
   Neimosh" - and the place the tribe grew from says that it is the centre of
   it: "Neimosh, city center". A place on its own is only its name. */
export function placeName(c) {
  if (c.villageName) return `${c.villageName}, ${c.name}`;
  if (!camps.some((o) => o !== c && !o.gone && o.code === c.code)) return c.name;
  return `${c.name}, ${(c.stage || 0) >= CITY.at ? 'city center' : 'center'}`;
}
