#!/usr/bin/env node
/**
 * `npm start`: the server, restarted whenever something it is made of changes,
 * and the page reloaded when it comes back.
 *
 * `.env` is the reason this exists. It is read once, at startup, and handed to
 * the page — so a changed setting means nothing until the process is a new
 * one, and "edit, save, stop the server, start it, reload the tab" is four
 * steps for what should be one.
 *
 * The page reloads itself. Run from here the server has DEV_RELOAD set, and it
 * opens an event stream that says which run of the server this is; the page
 * reloads when it reconnects and hears a different answer. A change to src/
 * restarts the server too, which costs a fraction of a second and means there
 * is one mechanism instead of two to keep in step.
 *
 * `npm run serve` is the same server with none of this, and the Windows
 * service runs `node server.js` directly, so neither ever reloads anybody.
 *
 * No dependencies — fs.watch and child_process.
 */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/* Watched by name rather than the whole root: the chronicle's database is
   written there every simulated day, and a restart per write would be a
   server that never finished starting. By name rather than by pattern too,
   because saving `.env` in an editor writes `.env.swp`, `.env~` and stranger
   things on the way, and none of those is a change to anything. */
export const WATCHED = new Set(['.env', 'index.html', 'server.js', 'config.js', 'db.js']);
/* Everything in these is the page. Not watched recursively: that needs Node 20
   on Linux and the package says 18, and src/ is flat. */
export const WATCHED_DIRS = ['src'];
/* One save is often several events and saving three files is dozens. One
   restart for the lot. */
export const SETTLE_MS = 150;

const args = process.argv.slice(2);          // `npm start -- --port 8090` still works
let child = null;
let pending = null;
let restarting = false;
let quitting = false;

function start() {
  child = spawn(process.execPath, [join(ROOT, 'server.js'), ...args], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, DEV_RELOAD: '1' },
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (quitting) process.exit(0);
    if (restarting) {
      restarting = false;
      start();
      return;
    }
    // Stopped on its own — a typo in config.js, say. Wait for the fix.
    console.log(`\n  server stopped (${signal || `exit ${code}`}) — waiting for a change to try again\n`);
  });
}

function changed(what) {
  clearTimeout(pending);
  pending = setTimeout(() => {
    console.log(`\n  ${what} changed — restarting`);
    if (child) {
      restarting = true;
      child.kill('SIGINT');          // the server's own graceful stop: the chronicle is closed properly
    } else {
      start();
    }
  }, SETTLE_MS);
}

watch(ROOT, (event, name) => {
  if (name && WATCHED.has(String(name))) changed(String(name));
});
for (const dir of WATCHED_DIRS) {
  watch(join(ROOT, dir), (event, name) => changed(join(dir, String(name || ''))));
}

/* ctrl-C at a terminal reaches both processes, so the server is usually
   stopping already; sending it again is harmless — its shutdown ignores a
   second one. Whatever stopped us, we go when it has gone. */
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    quitting = true;
    if (!child) process.exit(0);
    child.kill('SIGINT');
  });
}

start();
