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
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/* Watched by name rather than the whole root: the chronicle's database is
   written there every simulated day, and a restart per write would be a
   server that never finished starting. By name rather than by pattern too,
   because saving `.env` in an editor writes `.env.swp`, `.env~` and stranger
   things on the way, and none of those is a change to anything. */
export const WATCHED = new Set(['.env', 'index.html', 'server.js', 'config.js', 'db.js', 'package-lock.json']);
/* Everything in these is the page. Not watched recursively: that needs Node 20
   on Linux and the package says 18, and src/ is flat. */
export const WATCHED_DIRS = ['src'];
/* One save is often several events and saving three files is dozens. One
   restart for the lot. */
export const SETTLE_MS = 150;

/* The people are the humans-threejs package, followed on its main branch. Each
   `npm start` asks GitHub for the newest before the server comes up, so a
   model pushed there is on the island at the next start. A plain `npm install`
   would not do it — it installs whatever the lockfile last wrote down — so this
   installs the package by its spec again, which makes npm look the branch up.
   No network, and it starts on the model it already has.

   Before the watchers are set up, so writing the lockfile is not itself a
   change to restart for. A lockfile changed later — `npm run model` in another
   terminal — is one, and restarts the server like any other. */
const lockedModel = () => {
  try {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
    return (lock.packages?.['node_modules/humans-threejs']?.resolved || '').split('#').pop().slice(0, 7) || null;
  } catch { return null; }
};
export function updateModel() {
  const spec = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies?.['humans-threejs'];
  if (!spec) return;
  const was = existsSync(join(ROOT, 'node_modules', 'humans-threejs')) ? lockedModel() : null;
  console.log(`  humans-threejs: checking ${spec} for a newer model…`);
  const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--no-audit', '--no-fund', '--loglevel=error', `humans-threejs@${spec}`],
    { cwd: ROOT, stdio: 'inherit', timeout: 120000, shell: process.platform === 'win32' });
  const now = lockedModel();
  if (run.status !== 0) console.log(`  humans-threejs: could not reach it — starting on ${was || 'nothing'}`);
  else if (was && now !== was) console.log(`  humans-threejs: updated ${was} → ${now}`);
  else console.log(`  humans-threejs: ${now}, the newest`);
}

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

updateModel();

/* The lockfile is written by every install, including the one just above —
   and macOS will hand a watcher set up a moment afterwards the event anyway.
   What matters is whether the model it names moved, so that is what is
   compared. */
let modelAt = lockedModel();
watch(ROOT, (event, name) => {
  if (!name || !WATCHED.has(String(name))) return;
  if (String(name) === 'package-lock.json') {
    const now = lockedModel();
    if (now === modelAt) return;
    modelAt = now;
  }
  changed(String(name));
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
