/* What a step of the world costs, with nothing drawing it.
 *
 * Asked whether the simulation should move to the server so the browser only
 * renders. This is the bench that answered it, and the answer was no - but not
 * for the reason expected. It runs the real dist/ modules the page runs, on the
 * headless boot beside it.
 *
 * What it found, on this machine:
 *
 *     60 people   0.09 ms a step   ~11,000 steps a second
 *    445 people   0.15 ms a step    ~6,700 steps a second
 *    boots in about 0.66 s either way
 *
 * A frame at 60 fps is 16.7 ms, so at four hundred and forty-five people the
 * whole simulation is under one percent of it. A server can own the world - see
 * sim-push.mjs, which does - but moving it there hands the browser back a
 * hundred and fifty microseconds of a twenty-eight millisecond frame. The rest
 * is drawing, which is what clock.js has said all along: a drawn frame cost
 * more than a year of running unwatched.
 *
 *   PEOPLE=445 CAMPS=8 STEPS=1200 node spike/sim-headless.mjs
 *
 * Kept as a bench: it is the cheapest way to ask what the step costs, and the
 * only way to ask it without a browser in the room.
 */
import { bootWorld } from './headless.mjs';

const PEOPLE = Number(process.env.PEOPLE || 60);
const CAMPS = Number(process.env.CAMPS || 6);
const STEPS = Number(process.env.STEPS || 1800);

const { main, people, life, bootMs } = await bootWorld({ people: PEOPLE, camps: CAMPS });
console.log(`booted in ${bootMs} ms · ${people.people.length} people · ${people.camps.length} camps`);

const DT = 1 / 30;
const t1 = Date.now();
for (let i = 0; i < STEPS; i++) main.stepWorld(DT);
const ms = Date.now() - t1;

console.log(`stepped ${STEPS} times in ${ms} ms · ${(ms / STEPS).toFixed(2)} ms a step`
  + ` · ${(STEPS / (ms / 1000)).toFixed(0)} steps a second`);
console.log(`day ${Math.floor(life.simDay)} · ${people.people.length} people · ${people.camps.length} camps`);
const p = people.people[0];
if (p) console.log(`somebody: ${p.name} at ${p.x.toFixed(1)}, ${p.z.toFixed(1)} doing ${p.job}`);
