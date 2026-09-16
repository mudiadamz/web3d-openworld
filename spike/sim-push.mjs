/* The island, run here and pushed out.
 *
 * The server owns the world: it boots it, steps it on a timer, and sends what
 * moved to anybody listening. A browser does not need the island sent to it -
 * terrain, camps and their tents all come off the seed, and the seed is a
 * number - so what goes down the wire is only the people and where they are.
 *
 * On the channel: the page's dev reload already runs an EventSource, so this is
 * the same thing the same way rather than a websocket and a second protocol. It
 * is one direction, which is all a viewer needs; giving orders would want the
 * other, and that is the next question rather than this one.
 *
 *   node spike/sim-push.mjs                 then open /stream in a browser
 *   PORT=8100 PEOPLE=445 CAMPS=8 node spike/sim-push.mjs
 *
 * What this does not do: it is read-only, it keeps no chronicle, and it does
 * not save. It exists to show the world can live out here and be watched from
 * there. Frame rate is not what it is for - the bench beside it measured the
 * whole simulation at 0.15 ms of a 28.6 ms frame.
 */
import { createServer } from 'node:http';
import { bootWorld } from './headless.mjs';

const PORT = Number(process.env.PORT || 8100);
const PEOPLE = Number(process.env.PEOPLE || 120);
const CAMPS = Number(process.env.CAMPS || 8);
const STEP_HZ = Number(process.env.STEP_HZ || 30);      // how often the world moves
const SEND_HZ = Number(process.env.SEND_HZ || 15);      // how often anybody hears about it

const world = await bootWorld({ people: PEOPLE, camps: CAMPS });
const { main, people: folk, life, params } = world;
console.log(`island up in ${world.bootMs} ms · ${folk.people.length} people · ${folk.camps.length} camps`
  + ` · seed ${params.P.seed}`);

/* Two decimals is a centimetre, which is far finer than anybody can see at the
   distance a crowd is drawn from, and it halves the line. */
const r2 = (n) => Math.round(n * 100) / 100;

/* What a viewer needs to put somebody on the ground: who they are, where, which
   way, and how far through their stride. The rest of a person - name, age, what
   they are carrying - does not change from frame to frame and is not sent. */
const snapshot = () => ({
  t: r2(life.simDay),
  n: folk.people.length,
  p: folk.people.map((p) => [
    p.id, r2(p.x), r2(p.z), r2(p.yaw), r2(p.phase),
    (p.asleep ? 1 : 0) | (p.hidden ? 2 : 0) | (p.child ? 4 : 0) | (p.carry ? 8 : 0),
  ]),
});

const listeners = new Set();
let stepped = 0;
let sent = 0;

const DT = 1 / STEP_HZ;
setInterval(() => { main.stepWorld(DT); stepped++; }, 1000 / STEP_HZ);

setInterval(() => {
  if (!listeners.size) return;
  const line = `data: ${JSON.stringify(snapshot())}\n\n`;
  sent++;
  for (const res of listeners) { try { res.write(line); } catch { listeners.delete(res); } }
}, 1000 / SEND_HZ);

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    /* The seed first and once: it is what lets the viewer build the same island
       this one is standing on, so that nothing but the people has to be sent. */
    res.write(`event: hello\ndata: ${JSON.stringify({
      seed: params.P.seed, map: params.P.map, camps: folk.camps.length, sendHz: SEND_HZ,
    })}\n\n`);
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
    return;
  }
  if (url.pathname === '/health') {
    const body = JSON.stringify({
      ok: true, day: Math.floor(life.simDay), people: folk.people.length,
      camps: folk.camps.length, watching: listeners.size, stepped, sent,
    });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(body);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('the island is at /stream, and how it is doing at /health\n');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`  watching at  http://127.0.0.1:${PORT}/stream`);
  console.log(`  and how it is doing at  http://127.0.0.1:${PORT}/health`);
  console.log(`  stepping ${STEP_HZ} times a second, sending ${SEND_HZ}`);
});
