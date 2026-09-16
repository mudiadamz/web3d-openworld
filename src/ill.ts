import { worldStep } from './clock.js';
import { camps, people } from './people.js';

/* -------------------------------------------------------------------------
   Who is ill

   Lifted out of life.js, which had reached the length this project keeps a
   module under. Nothing here is called while a module loads.
   ------------------------------------------------------------------------- */
/* Who is lying ill in each band, counted once a step rather than once a
   question. Every person choosing what to do asked it, and each asking walked
   the whole island: at 9,000 people that is 9,000 times 9,000, and it was a
   fifth of the step. Counted again the moment anybody falls ill or gets up,
   and when a saved world is put back, so nothing reads last step's answer
   about this one. */
let illCountedAt = -1;
function countIll() {
  if (illCountedAt === worldStep) return;
  illCountedAt = worldStep;
  for (const c of camps) c.ill = 0;
  for (const p of people) if (p.sick && p.camp) p.camp.ill = (p.camp.ill || 0) + 1;
}
export function forgetIll() { illCountedAt = -1; }
/** How many in this band are lying ill. */
export function illIn(camp) {
  countIll();
  return camp?.ill || 0;
}
/** Anybody in this band lying ill. */
export function campIsIll(camp) {
  return illIn(camp) > 0;
}
