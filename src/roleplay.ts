import { P } from './params.js';
import { mulberry32 } from './noise.js';
import { camps, dressCamp, growPeople, paintPeople, people } from './people.js';
import {
  daysOfFood, hidePeopleFrom, logEvent, newPerson, peopleCapacity, personAge, simDay,
} from './life.js';
import { lineOf, recordPerson } from './wildlife.js';
import { stats } from './world.js';
import { $ } from './save.js';
import { toast } from './ui.js';
import { followPersonById, followedPerson, setViewMode } from './chronicle.js';
import { placeName, stageName } from './society.js';
import { quarryInReach } from './quarries.js';
import { woodWant } from './wood.js';
import { horsesOf, keeps } from './riding.js';
import { walls } from './walls.js';
import { seasonName } from './scene.js';

/* -------------------------------------------------------------------------
   Role play

   ROLEPLAY=true and you are somebody. You name them, a newcomer walks into a
   band - their sex, build, looks and temper rolled like anybody born here - and
   from then on the camera is behind them and nobody else: no orbit, no picking
   somebody to follow, no flying over the island by the map. The island carries
   on exactly as it does without you.

   The lobby (I, or the button) is their sheet: the band they live in, where
   they are, their level and what it has made of them, the roles it has opened,
   what they have done that is worth remembering, and what their band needs
   doing - three goals at a time, drawn from what it is short of.

   Everything is read off what the character actually does. An errand counts
   when the work of it is done - the state goes from work to anything else - the
   food counts when it reaches the store (p.brought), a kill when it is made
   (p.kills). So a goal is done the way anything is done here: by doing it.

   When they die, they are dead. The sheet says how, and you make somebody new;
   what they achieved stays on the record, which belongs to the player.
   ------------------------------------------------------------------------- */

export const HERO = {
  goals: 3,            // goals held at once
  levelMost: 20,
  /* What a level does to a body: a little more of each, every level past the first. */
  stamina: 0.04,       // how much longer they can run
  carry: 0.05,         // how much more they carry
  pace: 0.02,          // how much quicker they walk
};

/* XP for an errand's work done, by job. */
const XP_FOR = {
  gather: 6, hunt: 10, craft: 5, quarry: 8, wood: 7, farm: 6, fish: 7, tame: 12, patrol: 5,
  visit: 8, market: 4, mourn: 3, nurse: 6, explore: 10, raid: 15, tend: 1,
};
const XP_FOOD = 0.5;   // for each unit of food brought home
const XP_KILL = 15;

/* The level each role opens at, and the words for it. */
export const ROLE_LEVEL = { hunter: 2, fisher: 2, knapper: 3, quarrier: 3, keeper: 3, trader: 4, healer: 4, warrior: 5, patrol: 7 };
const TITLES = ['newcomer', 'newcomer', 'hand', 'hand', 'provider', 'provider', 'elder hand', 'elder hand', 'pillar of the band'];

/** Total XP to reach a level: 50, 150, 300, 500... */
export const xpFor = (level) => 50 * (level - 1) * level / 2;

/* ---- the sheet, kept in this browser by seed ---- */
const STORE = 'openworld.hero', MARKS = 'openworld.heroMarks';
let hero = null;             // { seed, id, name, xp, level, done, kills0, brought0, goals, marks, lastState, lastJob, far, role, since }
let marks = [];              // achievements across every character: { key, text, name, day }
let setupShown = false, lobbyOpen = false, deathNote = '', nextDraw = 0;

const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } };
const save = () => { if (hero) write(STORE, hero); write(MARKS, marks); };

export const heroPerson = () => (hero ? people.find((p) => p.id === hero.id) || null : null);
export const isHero = (p) => Boolean(hero && p && p.id === hero.id);

/** The body a level has made: multipliers the walk, the load and the breath read. */
export function bodyOf(level) {
  const n = Math.max(0, (level || 1) - 1);
  return { stamina: 1 + HERO.stamina * n, carry: 1 + HERO.carry * n, pace: 1 + HERO.pace * n };
}
function applyBody(p) {
  const b = bodyOf(hero.level);
  p.stamina = b.stamina;
  p.carryMul = b.carry;
  p.paceMul = b.pace;
}

/** Whether the character may hold a role: other people always may. */
export function mayHold(p, role) {
  if (!isHero(p)) return true;
  return (hero.level || 1) >= (ROLE_LEVEL[role] ?? 99);
}
/** The role the player has chosen for their character, if they may have it. */
export function chosenRole(p) {
  return isHero(p) && hero.role && mayHold(p, hero.role) ? hero.role : null;
}

/* ---- goals, from what the band is short of ---- */
function count(p, key) {
  if (key === 'food') return p.brought || 0;
  if (key === 'hunt') return p.kills || 0;
  if (key === 'explore') return hero.far >= 400 ? 1 : 0;
  return hero.done[key] || 0;
}
const GOALS = [
  { key: 'food', when: (c) => daysOfFood(c) < 25, need: 15, xp: 40, text: 'Bring 15 food home to the store' },
  { key: 'hunt', when: () => true, need: 1, xp: 35, text: 'Kill an animal on a hunt' },
  { key: 'quarry', when: (c) => (c.stone || 0) < 25 && quarryInReach(c, false), need: 3, xp: 40, text: 'Work the rock three times' },
  { key: 'wood', when: (c) => woodWant(c) > 0, need: 3, xp: 35, text: 'Cut wood three times' },
  { key: 'visit', when: (c) => camps.some((o) => o !== c && !o.gone && Math.hypot(o.x - c.x, o.z - c.z) < 700), need: 1, xp: 30, text: 'Walk to another band' },
  { key: 'farm', when: (c) => Boolean(c.field), need: 3, xp: 35, text: 'Work the field three times' },
  { key: 'fish', when: (c) => Boolean(c.raft), need: 2, xp: 30, text: 'Go fishing twice' },
  { key: 'tame', when: (c) => horsesOf(c).length < keeps(c), need: 1, xp: 50, text: 'Spend an afternoon taming horses' },
  { key: 'craft', when: () => true, need: 2, xp: 20, text: 'Knap at the fire twice' },
  { key: 'explore', when: () => true, need: 1, xp: 45, text: 'Go 400 m from your fire' },
];
function topUpGoals(p) {
  const held = new Set(hero.goals.map((g) => g.key));
  const open = GOALS.filter((g) => !held.has(g.key) && g.when(p.camp));
  // What the band is shortest of first: food when the store is low.
  open.sort((a, b) => Number(b.key === 'food') - Number(a.key === 'food') || Math.random() - 0.5);
  while (hero.goals.length < HERO.goals && open.length) {
    const g = open.shift();
    hero.goals.push({ key: g.key, text: g.text, need: g.need, xp: g.xp, base: count(p, g.key) });
  }
}

/* ---- achievements ---- */
const MARK_TEXT = {
  joined: 'Came to a band from over the hills',
  kill: 'Made a first kill',
  hunter: 'Ten kills',
  provider: 'Brought a hundred food home',
  rider: 'Rode a horse',
  role: 'Held a role in the band',
  patrol: 'Rode the bounds of a city',
  level5: 'Reached level 5',
  level10: 'Reached level 10',
  winter: 'Lived through a winter',
  goals: 'Did ten things the band needed',
  far: 'Went a kilometre from the fire',
};
function mark(key) {
  if (hero.marks.includes(key)) return;
  hero.marks.push(key);
  marks.unshift({ key, text: MARK_TEXT[key], name: hero.name, day: Math.floor(simDay) });
  toast(`achievement: ${MARK_TEXT[key]}`, 3);
}

/* ---- XP and levels ---- */
function gain(p, xp, why) {
  if (!(xp > 0)) return;
  hero.xp += xp;
  while (hero.level < HERO.levelMost && hero.xp >= xpFor(hero.level + 1)) {
    hero.level++;
    applyBody(p);
    const opened = Object.entries(ROLE_LEVEL).filter(([, l]) => l === hero.level).map(([r]) => r);
    toast(`${hero.name} is level ${hero.level}${opened.length ? ` · can be ${opened.join(', ')}` : ''}`, 3.5);
    logEvent('learned', `[${p.camp.code}] ${hero.name} is level ${hero.level} (${why})`, p.x, p.z);
    if (hero.level >= 5) mark('level5');
    if (hero.level >= 10) mark('level10');
  }
}

/* ---- making somebody ---- */
export function createHero(name) {
  const living = camps.filter((c) => !c.gone && people.some((q) => q.camp === c));
  if (!living.length) { toast('there is no band left to join'); return; }
  const camp = living[(Math.random() * living.length) | 0];
  const rng = mulberry32((Date.now() ^ ((Math.random() * 0x7fffffff) | 0)) | 0);
  const p = newPerson(camp, rng, 18 + rng() * 8);
  p.name = name;
  p.line = name;
  if (people.length >= peopleCapacity) growPeople(people.length + 1);
  recordPerson(p);
  people.push(p);
  stats.people = people.length;
  hidePeopleFrom(people.length);
  paintPeople();
  dressCamp(camp);
  logEvent('visit', `${name} came to [${camp.code}] ${camp.name} from over the hills`, camp.x, camp.z);
  hero = {
    seed: P.seed, id: p.id, name, xp: 0, level: 1, done: {}, goals: [], marks: [], role: null,
    lastState: p.state, lastJob: p.job, far: 0, since: simDay, season: '', brought0: 0,
  };
  applyBody(p);
  mark('joined');
  topUpGoals(p);
  save();
  followPersonById(p.id);
  setViewMode('follow');
}

/* ---- every frame, and every unwatched step ---- */
export function watchHero() {
  if (!P.roleplay || !hero) return;
  const p = heroPerson();
  if (!p) return died();
  const was = hero.lastState, job = hero.lastJob;
  if (was === 'work' && p.state !== 'work') {
    hero.done[job] = (hero.done[job] || 0) + 1;
    gain(p, XP_FOR[job] || 0, job);
  }
  hero.lastState = p.state;
  hero.lastJob = p.job;
  // Food home and kills made, since last looked.
  const brought = p.brought || 0, kills = p.kills || 0;
  if (brought > (hero.broughtSeen || 0)) gain(p, (brought - (hero.broughtSeen || 0)) * XP_FOOD, 'food home');
  if (kills > (hero.killsSeen || 0)) { gain(p, (kills - (hero.killsSeen || 0)) * XP_KILL, 'a kill'); mark('kill'); }
  hero.broughtSeen = brought;
  hero.killsSeen = kills;
  hero.far = Math.max(hero.far, Math.hypot(p.x - p.camp.x, p.z - p.camp.z));
  if (kills >= 10) mark('hunter');
  if (brought >= 100) mark('provider');
  if (p.mounted) mark('rider');
  if (p.role && p.role !== 'forager') mark('role');
  if (p.role === 'patrol') mark('patrol');
  if (hero.far >= 1000) mark('far');
  if (hero.season === 'winter' && seasonName === 'spring') mark('winter');
  hero.season = seasonName;
  // Goals: done ones pay and make room.
  for (const g of hero.goals) {
    if (count(p, g.key) - g.base >= g.need) {
      g.done = true;
      hero.goalsDone = (hero.goalsDone || 0) + 1;
      toast(`done: ${g.text} · +${g.xp} XP`, 3);
      gain(p, g.xp, g.text.toLowerCase());
    }
  }
  if (hero.goals.some((g) => g.done)) {
    hero.goals = hero.goals.filter((g) => !g.done);
    if (hero.goalsDone >= 10) mark('goals');
  }
  topUpGoals(p);
}

function died() {
  const rec = lineOf(hero.id);
  const CAUSE = { age: 'old age', infancy: 'a childhood illness', hunger: 'hunger', exhaustion: 'exhaustion',
    sickness: 'the sickness', tiger: 'a tiger', raid: 'a raid' };
  const cause = CAUSE[rec?.x] || rec?.x || 'something nobody saw';
  const years = rec ? Math.floor(((rec.d ?? simDay) - (rec.b ?? hero.since)) / P.yearLength) : 0;
  deathNote = `${hero.name} died of ${cause} at ${years}, level ${hero.level}. The record keeps what they did.`;
  logEvent('death', `${hero.name}, who was yours, is gone`, 0, 0);
  hero = null;
  write(STORE, null);
  save();
  showSetup();
}

/* ---- the camera: behind them and nobody else ---- */
export function heroView() {
  if (!P.roleplay) return false;
  const p = heroPerson();
  if (!p) return false;
  if (P.view !== 'follow') setViewMode('follow');
  if (followedPerson() !== p) followPersonById(p.id);
  return true;
}

/** Keys that would look anywhere but at them. */
export function roleplayRefuses(code) {
  if (!P.roleplay) return false;
  if (code === 'KeyI') { toggleLobby(); return true; }
  if (['KeyC', 'KeyF', 'KeyR'].includes(code)) { toast(hero ? `you are ${hero.name}` : 'make somebody first'); return true; }
  return false;
}

/* ---- the screens ---- */
function showSetup() {
  setupShown = true;
  lobbyOpen = false;
  $('rp').hidden = false;
  $('rpSetup').hidden = false;
  $('rpLobby').hidden = true;
  $('rpDeath').textContent = deathNote;
  const input = $('rpName') as HTMLInputElement;
  if (input) { input.value = ''; input.focus?.(); }
}

export function toggleLobby(open = !lobbyOpen) {
  if (!hero) return;
  lobbyOpen = open;
  $('rp').hidden = !open;
  $('rpSetup').hidden = true;
  $('rpLobby').hidden = !open;
  if (open) drawLobby();
}

const COMPASS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
function whereWords(p) {
  const w = walls.find((q) => Math.hypot(p.x - q.x, p.z - q.z) < q.r);
  let near = null, d = Infinity;
  for (const c of camps) {
    if (c.gone) continue;
    const dd = Math.hypot(p.x - c.x, p.z - c.z);
    if (dd < d) { d = dd; near = c; }
  }
  const at = `${Math.round(p.x)}, ${Math.round(p.z)}`;
  if (!near) return at;
  if (w) return `inside the walls of [${near.code}] ${placeName(near)} · ${at}`;
  if (d < 40) return `at [${near.code}] ${placeName(near)} · ${at}`;
  const a = Math.atan2(-(p.z - near.z), p.x - near.x);
  const dir = COMPASS[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
  return `${Math.round(d)} m ${dir} of [${near.code}] ${placeName(near)} · ${at}`;
}

function drawLobby() {
  const p = heroPerson();
  if (!p || !hero) return;
  const need = xpFor(hero.level + 1), from = xpFor(hero.level);
  const share = hero.level >= HERO.levelMost ? 1 : (hero.xp - from) / Math.max(1, need - from);
  const b = bodyOf(hero.level);
  const title = TITLES[Math.min(TITLES.length - 1, Math.floor(hero.level / 2))];
  $('rpTitle').textContent = `${hero.name} · level ${hero.level} ${title}`;
  const roles = Object.entries(ROLE_LEVEL).map(([r, l]) => {
    const open = hero.level >= l;
    const on = hero.role === r;
    return `<button class="rpRole${on ? ' on' : ''}" data-role="${r}"${open ? '' : ' disabled'} title="${open ? 'ask for this role' : `opens at level ${l}`}">${r}${open ? '' : ` · ${l}`}</button>`;
  }).join('');
  $('rpBody').innerHTML =
    `<div><span>band</span> <b class="wcode" style="background:${p.camp.color}">${p.camp.code}</b> ${placeName(p.camp)} <em>${stageName(p.camp)}</em></div>`
    + `<div><span>where</span> ${whereWords(p)}</div>`
    + `<div><span>age</span> ${Math.floor(personAge(p))} · <span>doing</span> ${p.job}${p.mounted ? ' on horseback' : ''} · <span>role</span> ${p.role && p.role !== 'forager' ? p.role : 'none'}</div>`
    + `<div class="rpLevel"><span>level ${hero.level}</span><i><b style="width:${Math.round(share * 100)}%"></b></i>`
    + `<span>${Math.floor(hero.xp)} / ${hero.level >= HERO.levelMost ? 'max' : need} XP</span></div>`
    + `<div><span>body</span> stamina x${b.stamina.toFixed(2)} · carry x${b.carry.toFixed(2)} · pace x${b.pace.toFixed(2)}</div>`
    + `<h3>Roles</h3><div class="rpRoles">${roles}</div>`
    + `<h3>Goals</h3>` + (hero.goals.map((g) => {
      const have = Math.min(g.need, Math.max(0, count(p, g.key) - g.base));
      return `<div class="rpGoal"><span>${g.text}</span> <b>${Math.floor(have)}/${g.need}</b> <em>+${g.xp} XP</em></div>`;
    }).join('') || '<div><span>nothing the band needs of you right now</span></div>')
    + `<h3>Achievements</h3>` + (marks.slice(0, 12).map((m) =>
      `<div class="rpMark"><b>${m.text}</b> <span>${m.name} · day ${m.day}</span></div>`).join('') || '<div><span>none yet</span></div>');
}

/** Called every frame: the setup when there is nobody, the lobby kept current. */
export function updateRoleplay(now) {
  if (!P.roleplay) return;
  if (!hero && !setupShown) {
    // Carry on as somebody already made on this island, if they are still alive.
    const kept = read(STORE);
    marks = read(MARKS) || [];
    if (kept && kept.seed === P.seed && people.some((q) => q.id === kept.id)) {
      hero = kept;
      applyBody(heroPerson());
      toast(`${hero.name} again`, 2);
    } else if (people.length) showSetup();
  }
  if (!hero) return;
  watchHero();
  heroView();
  if (lobbyOpen && now > nextDraw) { nextDraw = now + 0.5; drawLobby(); }
  if (now > (hero.savedAt || 0)) { hero.savedAt = now + 5; save(); }
}

/* The setup's button and the lobby's role buttons. */
export function wireRoleplay() {
  if (typeof document === 'undefined') return;
  $('rpBegin')?.addEventListener('click', () => {
    const name = (($('rpName') as HTMLInputElement)?.value || '').trim().slice(0, 24);
    if (!name) { toast('a name first'); return; }
    $('rp').hidden = true;
    setupShown = false;
    createHero(name);
    toggleLobby(true);
  });
  $('rpName')?.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') $('rpBegin')?.click?.(); ev.stopPropagation?.(); });
  $('rpClose')?.addEventListener('click', () => toggleLobby(false));
  $('rpOpen')?.addEventListener('click', () => toggleLobby());
  $('rpBody')?.addEventListener('click', (ev: any) => {
    const role = ev.target?.dataset?.role;
    if (!role || !hero) return;
    hero.role = hero.role === role ? null : role;
    toast(hero.role ? `asking the band to be its ${role}` : 'no role asked for', 2);
    save();
    drawLobby();
  });
  if (!P.roleplay) return;
  if ($('rpOpen')) $('rpOpen').hidden = false;
  /* On a phone: over the shoulder, and nothing that would look at anybody else -
     follow picks somebody, and view switches away from them. */
  if ($('touchShoulder')) $('touchShoulder').hidden = false;
  for (const what of ['follow', 'view']) {
    const b = document.querySelector?.(`#touch [data-touch="${what}"]`) as HTMLElement;
    if (b) b.hidden = true;
  }
}
