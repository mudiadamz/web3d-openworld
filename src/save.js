import { P } from './params.js';
import { setSeasonIndex } from './scene.js';
import { stats } from './world.js';
import {
  lineage, nextPersonId, packs, recountAnimals, setLineage, setNextPersonId, takePersonId, usedNames
} from './wildlife.js';
import {
  BUILDS, GARMENT, GRAVE_MAX, HAIR, SKIN, camps, drawGraves, graves, paintPeople, people,
  setGraves
} from './people.js';
import {
  SKILLS, applyAge, bornCount, diedCount, hidePeopleFrom, logEvent, peopleCapacity,
  renderTribes, runId, setBornCount, setDiedCount, setSimDay, simDay
} from './life.js';
import { setLastClock, updateHud } from './main.js';

/* -------------------------------------------------------------------------
   Keeping your place

   Reload the tab, restart the server, come back tomorrow: the band is where you
   left it, at the hour you left it, as old as they had got.

   The world is not saved, because it does not need to be — a seed rebuilds the
   terrain, the creeks, the camp sites and the herd anchors exactly. What is
   saved is the part no seed can reproduce: the clock, and who is alive.

   Stored in SQLite when there is a server, so it survives the server going
   down, and in localStorage when there is not. `?fresh=1` ignores whatever is
   there and starts clean.
   ------------------------------------------------------------------------- */

export const STATE_STORE = 'openworld.state';
export const STATE_VERSION = 1;
export const SAVE_EVERY = 10;            // seconds
export let nextSave = 0;

export const r2 = (n) => Math.round(n * 100) / 100;

export function snapshot() {
  return {
    v: STATE_VERSION,
    seed: P.seed,
    time: r2(P.time),
    day: r2(simDay),
    born: bornCount,
    died: diedCount,
    camps: camps.map((c) => ({ name: c.name, food: r2(c.food), history: c.history,
      skill: { spears: r2(c.skill.spears), baskets: r2(c.skill.baskets), drying: r2(c.skill.drying) },
      toll: c.toll, born: c.born, peak: c.peak, founded: r2(c.founded), lost: c.lost || 0 })),
    /* Short keys: this is written every ten seconds and eighty people with
       long field names is a surprising amount of JSON for what it says. */
    people: people.map((p) => ({
      n: p.name, c: camps.indexOf(p.camp), b: r2(p.born),
      x: r2(p.x), z: r2(p.z), y: r2(p.yaw), k: p.kind,
      as: r2(p.adultScale), ash: r2(p.adultShoulder), ahp: r2(p.adultHip), ahd: r2(p.adultHead),
      h: p.camp.huts.indexOf(p.hut), j: p.job, s: p.state, hl: r2(p.haul), ki: p.kills,
      id: p.id, mo: p.mother || 0, fa: p.father || 0, mn: p.motherName || '', fn: p.fatherName || '',
      ln: p.line || '', gn: p.gen || 1,
      kn: [r2(p.knows?.spears || 0), r2(p.knows?.baskets || 0), r2(p.knows?.drying || 0)],
      tt: p.taught ? 1 : 0, mv: p.moved ? 1 : 0,
      // Who they are, which no seed can reproduce once they have been born.
      tr: [r2(p.traits?.bold ?? 1), r2(p.traits?.sociable ?? 1), r2(p.traits?.quick ?? 1)],
      e: r2(p.energy), nr: r2(p.nourish ?? 1), sk: r2(p.sick || 0), im: r2(p.immuneUntil || 0), sx: p.sex,
      sc: p.skin, sh: r2(p.skinShade), gc: p.garment, gh: r2(p.garmentShade), hc: p.hairColor,
    })),
    /* Everyone who has ever lived. The living are saved below with everything
       they need to go on being alive; this is the record of the dead, which is
       the only thing that makes descent traceable further back than a person's
       own father. */
    lineage,
    /* Where the dead are. Rounded to the centimetre because nobody is going to
       measure a cairn, and the save is sent over the wire on every autosave. */
    graves,
    // Herds are rebuilt from the seed; what matters is how many the hunting
    // left, so an over-hunted species comes back over-hunted.
    alive: packs.map((pk) => pk.list.reduce((n, a) => n + (a.dead ? 0 : 1), 0)),
  };
}

export async function persistState() {
  if (typeof window === 'undefined') return;
  const data = snapshot();
  if (runId) {
    try {
      await fetch('/api/state', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      return;
    } catch { /* fall through to the browser's own copy */ }
  }
  try {
    localStorage.setItem(STATE_STORE, JSON.stringify(data));
  } catch { /* private window, or storage off: nothing to be done */ }
}

export async function readSavedState() {
  if (typeof location !== 'undefined'
      && new URLSearchParams(location.search || '').get('fresh') === '1') return null;
  try {
    const res = await fetch('/api/state');
    if (res.ok) {
      const data = await res.json();
      if (data && data.v === STATE_VERSION) return data;
    }
  } catch { /* no server; try the browser */ }
  try {
    const raw = localStorage.getItem(STATE_STORE);
    const data = raw ? JSON.parse(raw) : null;
    return data && data.v === STATE_VERSION ? data : null;
  } catch {
    return null;
  }
}

export function clearSavedState() {
  try { localStorage.removeItem(STATE_STORE); } catch { /* nothing stored */ }
  if (runId) fetch('/api/state', { method: 'DELETE' }).catch(() => {});
}

/** Which world and what time — has to be applied before anything is built. */
export function applySavedWorld(st) {
  if (!st) return;
  P.seed = st.seed | 0;
  P.time = st.time;
  setSimDay(st.day);
  setBornCount(st.born | 0);
  setDiedCount(st.died | 0);
  setLastClock('');
  setSeasonIndex(-1);
}

export function personFromRecord(r) {
  const camp = camps[r.c] || camps[0];
  const p = {
    // Saves from before people had a sex used 'adultA'/'adultB' for the build.
    camp, kind: r.k === 'adultA' ? 'm' : r.k === 'adultB' ? 'f' : r.k,
    sex: r.k === 'adultA' ? 'm' : r.k === 'adultB' ? 'f' : r.k,
    child: true, name: r.n, born: r.b,
    adultScale: r.as, adultShoulder: r.ash, adultHip: r.ahp, adultHead: r.ahd,
    adultHair: BUILDS[r.k === 'adultA' ? 'm' : r.k === 'adultB' ? 'f' : r.k]?.hair ?? 1,
    x: r.x, z: r.z, yaw: r.y, speed: 0, phase: Math.random() * Math.PI * 2,
    scale: r.as, shoulder: r.ash, hip: r.ahp, headScale: r.ahd,
    state: r.s || 'idle', job: r.j || 'tend', timer: Math.random() * 5,
    // Older saves have no energy in them; someone rested is the safe guess.
    energy: Number.isFinite(r.e) ? r.e : 1,
    sick: Number.isFinite(r.sk) ? r.sk : 0,
    nourish: Number.isFinite(r.nr) ? r.nr : 1,
    id: r.id || takePersonId(),
    mother: r.mo || 0, father: r.fa || 0,
    motherName: r.mn || '', fatherName: r.fn || '',
    /* A save from before descent was reckoned has neither. Somebody with a
       father named but no line recorded is the second of a line that starts
       with him, which is the most that can honestly be said of them. */
    line: r.ln || r.fn || r.n,
    gen: Number.isFinite(r.gn) ? r.gn : (r.fa ? 2 : 1),
    taught: Boolean(r.tt), moved: Boolean(r.mv),
    /* A save written before anybody had a character gives everybody the middle
       of the range, which is what everybody used to be. */
    traits: Array.isArray(r.tr)
      ? { bold: r.tr[0], sociable: r.tr[1], quick: r.tr[2] }
      : { bold: 1, sociable: 1, quick: 1 },
    knows: { spears: r.kn?.[0] || 0, baskets: r.kn?.[1] || 0, drying: r.kn?.[2] || 0 },
    visiting: null,
    immuneUntil: Number.isFinite(r.im) ? r.im : 0,
    /* A save from before people carried their own colouring has none, so they
       are given one here rather than coming back as a blank. */
    skin: r.sc ?? SKIN[(Math.random() * SKIN.length) | 0],
    skinShade: Number.isFinite(r.sh) ? r.sh : 1,
    garment: r.gc ?? GARMENT[(Math.random() * GARMENT.length) | 0],
    garmentShade: Number.isFinite(r.gh) ? r.gh : 1,
    hairColor: r.hc ?? HAIR[(Math.random() * HAIR.length) | 0],
    targetX: camp.x, targetZ: camp.z,
    crouch: 0, bend: 0, carry: r.hl > 0 ? 1 : 0, hasSpear: r.j === 'hunt', asleep: false,
    haul: r.hl || 0, prey: null, attempt: 0, kills: r.ki | 0,
    hut: camp.huts[r.h] || camp.huts[0],
    work: Math.random() * Math.PI * 2,
  };
  applyAge(p);                // size and childhood follow from the birth day
  usedNames.add(p.name);
  return p;
}

/** The band and the herds — applied after the world exists to put them in. */
export function applySavedLife(st) {
  if (!st || !camps.length) return;

  st.camps.forEach((c, i) => {
    if (!camps[i]) return;
    usedNames.delete(camps[i].name);
    camps[i].name = c.name;
    usedNames.add(c.name);
    camps[i].food = c.food;
    // A save from before a band could learn anything has no skills in it.
    for (const key in SKILLS) camps[i].skill[key] = Number(c.skill?.[key]) || 0;
    for (const key in camps[i].toll) camps[i].toll[key] = Number(c.toll?.[key]) || 0;
    camps[i].born = c.born | 0;
    camps[i].peak = c.peak | 0;
    camps[i].lost = c.lost | 0;
    // Older saves have no founding day; treat the band as founded now rather
    // than at day zero, or it comes back claiming to be a century old.
    camps[i].founded = Number.isFinite(c.founded) ? c.founded : simDay;
    camps[i].history = Array.isArray(c.history) ? c.history : [];
  });

  setLineage(Array.isArray(st.lineage) ? st.lineage : []);
  /* A save written before there were cairns simply has none, which is right:
     the chronicle still says who died, there is just nothing on the ground. */
  setGraves(Array.isArray(st.graves) ? st.graves.slice(-GRAVE_MAX) : []);
  drawGraves();
  people.length = 0;
  // Past anything the save used, or a newborn would collide with a grandparent.
  setNextPersonId(Math.max(nextPersonId,
    ...st.people.map((r) => (r.id | 0) + 1),
    // The dead are in here too, and their ids must not be handed out again.
    ...(Array.isArray(st.lineage) ? st.lineage.map((r) => (r.i | 0) + 1) : []),
    1));
  for (const r of st.people) {
    if (people.length >= peopleCapacity) break;
    people.push(personFromRecord(r));
  }
  hidePeopleFrom(people.length);
  paintPeople();
  stats.people = people.length;

  packs.forEach((pk, i) => {
    const alive = Math.min(st.alive?.[i] ?? pk.list.length, pk.list.length);
    pk.list.forEach((a, k) => { a.dead = k >= alive; });
  });

  recountAnimals();
  updateHud();
  renderTribes();
  logEvent('resume', `back at [${camps[0].code}] ${camps[0].name}, day ${Math.floor(simDay)}`, 0, 0);
}

/* -------------------------------------------------------------------------
   Panel
   ------------------------------------------------------------------------- */

export const $ = (id) => document.getElementById(id);
export const ui = $('ui');

/* nextSave lives here and is written from elsewhere. An imported binding is
   read-only, so the write has to come back to the module that owns it. */
export function setNextSave(v) { nextSave = v; }
