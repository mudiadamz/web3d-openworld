#!/usr/bin/env node
/* -------------------------------------------------------------------------
   Empty everything

   `npm run reset` — every table truncated, in one transaction, and the
   auto-increment counters put back to the start so the next run is run 1.

   Deliberately a command rather than only a button. A button lives inside the
   page, and the reason for wanting everything gone is usually that the page is
   not behaving — a stuck overlay, a world that will not load, a run that will
   not stop. Something that works with the tab shut and the server down is worth
   having for exactly those moments.

   The server holds the file open in WAL mode, so this stops short of deleting
   it: truncating the tables leaves a valid database that a running server can
   carry straight on with.
   ------------------------------------------------------------------------- */

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadEnv, resolveServer } from './config.js';
import { openDb } from './db.js';

const ROOT = process.cwd();
const server = resolveServer(loadEnv(join(ROOT, '.env')));
/* An absolute path is already where it wants to be. Joining it to the project
   root turns /tmp/x.db into <root>/tmp/x.db, which is a different file that
   does not exist — and the reply is then a cheerful "nothing to empty". */
const named = process.argv[2] || server.chronicle_db;
const file = isAbsolute(named) ? named : join(ROOT, named);

if (!existsSync(file)) {
  console.log(`\n  nothing to empty — ${file} does not exist\n`);
  process.exit(0);
}

const db = openDb(file);
if (!db) {
  console.log('\n  could not open the database — is this Node 22 or newer?\n');
  process.exit(1);
}

const before = db.counts();
const removed = db.truncateAll();
const after = db.counts();

console.log(`\n  emptied ${file}`);
for (const table of Object.keys(before)) {
  const n = before[table];
  console.log(`    ${table.padEnd(8)} ${String(n).padStart(7)} → ${after[table]}`);
}
console.log(`\n  ${removed} rows gone. The browser keeps its own copy too:`);
console.log('  open the page and use "Delete everything", or clear the site data.\n');
