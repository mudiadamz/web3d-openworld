#!/usr/bin/env node
/**
 * Serves the sandbox with its defaults taken from the environment.
 *
 * The page stays a standalone file: open index.html directly and it uses the
 * defaults written into it. Served from here, the resolved configuration is
 * injected as one small script ahead of the module, and the page prefers that.
 *
 * No dependencies — node:http and node:fs are the whole of it.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, resolveConfig, resolveServer, describe } from './config.js';
import { openDb } from './db.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER = '<!--CONFIG-->';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

const env = loadEnv(join(ROOT, '.env'));
const { values, explicit, notes } = resolveConfig(env);
const server = resolveServer(env);

for (const note of [...notes, ...server.notes]) console.warn(`  ! ${note}`);

const db = openDb(join(ROOT, server.chronicle_db));
const payload = { values, explicit, chronicle: Boolean(db) };

/* How big a body each endpoint may send.

   A megabyte was one number for everything, and a saved world is not the same
   kind of object as a day's tribe rows. `LINE_MAX` alone is twenty thousand
   people who have ever lived at about 123 bytes each — two and a half megabytes
   before a single living person, a grave or a skill is written — so the page
   could produce a save the server would not take, and neither cap knew the
   other existed. `test.js` compares them now.

   Everything else stays tight: these are small, fixed-shape messages, and a cap
   that fits them is a cap that catches a client gone wrong. */
export const STATE_LIMIT = 12_000_000;
export const BODY_LIMIT = 1_000_000;

/** Read a JSON body, with a cap so a stuck client cannot fill memory. */
function readJson(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        /* Marked, so the handler can answer 413 rather than 500. What the page
           does about it matters — it falls back to keeping the world in the
           browser — and it cannot do that if all it gets is a dead socket and a
           stack trace on the server's console. */
        const err = new Error(`body too large: ${size} bytes, limit ${limit}`);
        err.tooLarge = true;
        /* Stop reading, but do not tear the socket down here: the 413 has not
           been written yet, and a client that gets a dropped connection instead
           of a status cannot tell "too big" from "the server is gone". It falls
           back to keeping the world in the browser either way — but only one of
           those two tells it why. The handler destroys the request after it has
           answered. */
        req.pause();
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveIndex() {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  if (!html.includes(PLACEHOLDER)) {
    console.warn(`  ! index.html has no ${PLACEHOLDER} marker — serving it unconfigured`);
    return html;
  }
  // `</script` inside a script element would end it early, whatever the JSON
  // says; escaping `<` is the usual, boring fix.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return html.replace(PLACEHOLDER,
    `<script>window.__CONFIG__ = ${json};</script>`);
}

function safePath(urlPath) {
  // Everything is served from ROOT and nothing may climb out of it.
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const full = join(ROOT, clean);
  return full.startsWith(ROOT) ? full : null;
}

const listening = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    if (path === '/' || path === '/index.html') {
      const html = await serveIndex();
      res.writeHead(200, {
        'content-type': TYPES['.html'],
        // The whole point is that a restart with a new .env shows up on reload.
        'cache-control': 'no-store',
      });
      return res.end(html);
    }

    /* Is it up, and is it the one you think it is?

       Answered before the `/api/` guard and without touching the database, so
       it stays a fact about the process rather than about SQLite: a chronicle
       that failed to open is worth reporting, not worth failing a health check
       over, because the page runs fine without one.

       It exists for the thing that restarts this. A service manager that can
       only see "the process is alive" cannot tell a listening server from one
       wedged on a port it never got. */
    if (path === '/healthz') {
      return json(res, 200, {
        ok: true,
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        port: server.port,
        chronicle: Boolean(db),
        node: process.version,
      });
    }

    if (path.startsWith('/api/')) {
      if (!db) return json(res, 503, { error: 'no chronicle database' });

      if (path === '/api/run' && req.method === 'POST') {
        const b = await readJson(req);
        return json(res, 200, { runId: db.startRun(b.seed, b.quality, b.counts) });
      }
      if (path === '/api/events' && req.method === 'POST') {
        const b = await readJson(req);
        if (!b.runId || !Array.isArray(b.events)) return json(res, 400, { error: 'runId and events required' });
        return json(res, 200, { stored: db.addEvents(b.runId, b.events.slice(0, 5000)) });
      }
      if (path === '/api/state') {
        if (req.method === 'POST') {
          // Stored as the text it arrived as: the server has no opinion about
          // the shape of a snapshot, and versioning it is the page's business.
          const raw = await readJson(req, STATE_LIMIT);
          db.saveState(JSON.stringify(raw));
          return json(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') { db.clearState(); return json(res, 200, { ok: true }); }
        const payload = db.loadState();
        if (!payload) return json(res, 404, { error: 'nothing saved' });
        res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
        return res.end(payload);
      }
      if (path === '/api/worlds' && req.method === 'POST') {
        const b = await readJson(req);
        if (!Number.isFinite(b.seed)) return json(res, 400, { error: 'seed required' });
        db.saveWorld(b.name, b.seed);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/worlds' && req.method === 'DELETE') {
        const seed = Number(url.searchParams.get('seed'));
        if (!Number.isFinite(seed)) return json(res, 400, { error: 'seed required' });
        db.forgetSeed(seed);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/worlds') return json(res, 200, db.worlds());

      /* Everything, gone. This was taken out once, on the reasoning that a
         single request should not be able to remove everything there is — and
         then the reason for wanting it turned up: a page that will not behave,
         and no way to start again from inside it. `npm run reset` does the same
         thing from a terminal, which is the one that works when the tab is the
         problem. */
      if (path === '/api/data' && req.method === 'DELETE') {
        const gone = db.truncateAll();
        return json(res, 200, { ok: true, removed: gone, remaining: db.counts() });
      }
      if (path === '/api/data') {
        /* Explicitly GET-only. A DELETE that fell through to the readout would
           answer 200 and look for all the world like it had worked. */
        if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
        return json(res, 200, db.counts());
      }
      if (path === '/api/tribes' && req.method === 'POST') {
        const b = await readJson(req);
        if (!b.runId || !Array.isArray(b.tribes)) return json(res, 400, { error: 'runId and tribes required' });
        return json(res, 200, { stored: db.addTribes(b.runId, b.day, b.tribes.slice(0, 64)) });
      }
      if (path === '/api/tribes') {
        const runId = Number(url.searchParams.get('run')) || db.runs(1)[0]?.id;
        return json(res, 200, runId ? db.tribes(runId) : []);
      }
      if (path === '/api/sample' && req.method === 'POST') {
        const b = await readJson(req);
        if (!b.runId) return json(res, 400, { error: 'runId required' });
        db.addSample(b);
        return json(res, 200, { ok: true });
      }
      /* Without ?run= this is the chronicle of every world there has ever been,
         which is what the panel shows. With one it is still a single run, for
         anything reading the database rather than the page. */
      if (path === '/api/chronicle') {
        const limit = Number(url.searchParams.get('limit'));
        const run = url.searchParams.get('run');
        if (run) return json(res, 200, db.chronicle(Number(run), limit));
        return json(res, 200, db.allEvents(limit));
      }
      if (path === '/api/history') {
        const runId = Number(url.searchParams.get('run')) || db.runs(1)[0]?.id;
        return json(res, 200, runId ? db.history(runId) : []);
      }
      if (path === '/api/runs') return json(res, 200, db.runs());
      return json(res, 404, { error: 'no such endpoint' });
    }

    if (path === '/config.json') {
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
      return res.end(JSON.stringify(payload, null, 2));
    }

    const file = safePath(path);
    if (!file) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('forbidden');
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      /* The same promise the page itself is served with, and for a worse
         reason. A response with no `cache-control`, no `etag` and no
         `last-modified` is one the browser may reuse without asking — so
         `index.html` came back new every reload, exactly as intended, while the
         modules it loads came out of the cache.

         That is a page half of which is the code you just wrote. It reads as
         the new markup being inert: the buttons were there and did nothing, the
         scale bar sat at its placeholder, the labels never drew — because the
         new HTML was talking to the old `map.js`. Nothing is wrong with the
         code in that state and nothing about it is visible from inside the
         page, which is what makes it worth a header on a local sandbox that has
         no reason to cache anything. */
      'cache-control': 'no-store',
    });
    return res.end(body);
  } catch (err) {
    /* Too big is the client's mistake and it has something to do about it, so
       it gets an answer rather than a dropped connection: the page keeps the
       world in the browser instead. Logged once as a warning, because a save
       that will not fit is worth knowing about and is not a crash. */
    if (err.tooLarge) {
      console.warn(`  ! ${req.method} ${req.url}: ${err.message}`);
      json(res, 413, { error: err.message });
      return req.destroy();               // answered; now stop listening
    }
    const code = err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 500;
    if (code === 500) console.error(err);
    res.writeHead(code, { 'content-type': 'text/plain' });
    res.end(code === 404 ? 'not found' : 'server error');
  }
});

export const http = listening.listen(server.port, server.host, () => {
  const shown = describe(values);
  console.log(`\n  open world  →  http://${server.host}:${server.port}\n`);
  console.log(shown.length
    ? `  from the environment: ${shown.join(' · ')}`
    : '  no configuration in the environment — the page uses its own defaults');
  console.log('  GET /config.json to see exactly what was resolved');
  console.log(db
    ? '  chronicle: SQLite — /api/runs, /api/chronicle, /api/history, /api/tribes, /api/worlds, /api/state, /api/data\n'
    : '  chronicle: off (node:sqlite unavailable) — the page still runs\n');
});

/* -------------------------------------------------------------------------
   Being stopped

   Run from a terminal this hardly matters: you press ctrl-C, the process dies,
   and SQLite recovers the write-ahead log next time. Run as a service it
   matters every time, because a service is stopped and started rather than
   left running — so "recovers next time" happens on every restart, and the
   `-wal` file is the size of the last burst of writing.

   `db.close()` checkpoints and removes it. It is one call and it was never
   made, because nothing ever asked this process to stop politely.

   Which is worth being exact about on Windows, because most ways of stopping a
   process there never ask. Windows has no SIGTERM: `Stop-Process`, `taskkill`
   and `process.kill` from another process are all TerminateProcess, and nothing
   below runs. What does reach here is a console control event — ctrl-C at a
   prompt, or the CTRL_BREAK a service wrapper sends on stop — which arrives as
   SIGINT or SIGBREAK. Those are the two paths this is for, and SIGTERM is in
   the list for the day it runs somewhere that has one.

   When it does not run, nothing is lost: the write-ahead log is crash-safe and
   SQLite recovers it on the next open. The cost of being killed is a recovery
   and a file left lying about, not a world. This turns that from every restart
   into only the abrupt ones.
   ------------------------------------------------------------------------- */
export const STOP_GRACE = 5000;

let stopping = false;
export function shutdown(signal) {
  if (stopping) return;                 // a second ctrl-C should not race the first
  stopping = true;
  console.log(`\n  ${signal} — closing`);

  let finished = false;
  const finish = (why) => {
    if (finished) return;
    finished = true;
    /* The database last, and never let a failure here stop the exit: a service
       that cannot be stopped is worse than a write-ahead log that has to be
       recovered. */
    try { db?.close(); } catch (err) { console.warn(`  ! closing the chronicle: ${err.message}`); }
    console.log(`  stopped (${why})`);
    process.exit(0);
  };

  listening.close(() => finish('all connections done'));
  /* A request that never ends must not hold the service open for ever — the
     service manager's own patience runs out and then it kills the process,
     which is the ungraceful stop this exists to avoid. Unref'd so it is not
     itself a reason to stay alive. */
  setTimeout(() => finish(`gave up waiting after ${STOP_GRACE}ms`), STOP_GRACE).unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => shutdown(signal));
}
