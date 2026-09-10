import { P } from './params.js';
import { ancestry, lineOf, lineage } from './wildlife.js';
import { camps, people } from './people.js';
import { personAge } from './life.js';
import { DEATH_TOLD } from './chronicle.js';
import { sexMarks } from './ui.js';

/* -------------------------------------------------------------------------
   Whose they are

   Everybody born on the island is in the record with both parents named, and
   the record keeps the dead — so a family can be read back past anybody still
   alive to remember it, and forward to whoever is carrying the line now. A
   button on every row of both lists opens it in the list's place; a name in it
   opens that person's, and back returns to the tab it was opened from.
   ------------------------------------------------------------------------- */

const TREE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="3" r="2"/>'
  + '<circle cx="3.5" cy="13" r="2"/><circle cx="12.5" cy="13" r="2"/>'
  + '<path d="M8 5v3M3.5 11V8h9v3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

export function linButton(id, name) {
  return `<button class="lin" data-lin="${id}" title="${name}'s lineage" aria-label="${name}'s lineage">${TREE_ICON}</button>`;
}

/* One relative: their name to click through, their band, and alive or how
   they ended. `name` is what the child's record called them, for a parent the
   record itself has lost. */
function kin(id, name) {
  const r = id ? lineOf(id) : null;
  if (!r) return `<span class="unk">${name || 'not remembered'}</span>`;
  const living = r.d > 0 ? null : people.find((q) => q.id === r.i);
  const band = camps.find((c) => c.code === r.c);
  const age = Math.floor(living ? personAge(living) : Math.max(0, ((r.d || 0) - r.b) / P.yearLength));
  const state = living ? `${age}, alive`
    : r.d > 0 ? `died at ${age}, ${DEATH_TOLD[r.x] || r.x || 'nobody knows what of'}`
      : 'lost to the record';
  return `<a data-lin="${r.i}">${r.n}</a>`
    + ` <b class="wcode" style="background:${band ? band.color : '#666'}">${r.c}</b>`
    + `${sexMarks(r.s === 'f' ? '♀' : '♂')} <span>${state}</span>`;
}

/* A generation up from a list of people: each one's mother and father. */
function parentsOf(list) {
  return list.flatMap(({ id }) => {
    const r = id ? lineOf(id) : null;
    return [{ id: r?.m || 0, name: r?.mn || '' }, { id: r?.f || 0, name: r?.fn || '' }];
  });
}

export function lineageView(id) {
  const me = lineOf(id);
  const back = `<button class="btn tiny" data-lin="0">‹ back</button>`;
  if (!me) return `<div id="lineage"><div class="top">${back}</div><div>nobody by that name is remembered</div></div>`;
  const known = (row) => row.some((k) => k.id || k.name);
  const parents = [{ id: me.m, name: me.mn }, { id: me.f, name: me.fn }];
  const grandparents = parentsOf(parents);
  const greats = parentsOf(grandparents);
  const children = lineage.filter((r) => r.m === id || r.f === id).sort((a, b) => a.b - b.b);
  const grandchildren = children.flatMap((c) => lineage.filter((r) => r.m === c.i || r.f === c.i))
    .sort((a, b) => a.b - b.b);
  const fathers = ancestry({ father: me.f });
  const row = (label, list) => `<tr><th>${label}</th><td>${list.join('<br>')}</td></tr>`;
  const rows = [
    row('parents', parents.map((k) => kin(k.id, k.name))),
    known(grandparents) ? row('grandparents', grandparents.filter((k) => k.id || k.name).map((k) => kin(k.id, k.name))) : '',
    known(greats) ? row('great-grandparents', greats.filter((k) => k.id || k.name).map((k) => kin(k.id, k.name))) : '',
    row(`children <span>(${children.length})</span>`, children.length ? children.map((r) => kin(r.i)) : ['<span class="unk">none</span>']),
    grandchildren.length ? row(`grandchildren <span>(${grandchildren.length})</span>`, grandchildren.map((r) => kin(r.i))) : '',
  ].join('');
  return `<div id="lineage"><div class="top">${back} ${kin(me.i)}</div>`
    + `<div><span>of the line of</span> <b>${me.l || me.n}</b> <span>· generation ${me.g || 1}</span></div>`
    + (fathers.length ? `<div><span>fathers back to it</span> ${fathers.map((r) => r.n).join(' ← ')}</div>` : '')
    + `<table>${rows}</table></div>`;
}
