/**
 * The chronicle, in SQLite.
 *
 * The simulation runs in the browser, so the page posts what happens and this
 * writes it down. That is the whole architecture: the world is not stored, only
 * its history — a seed rebuilds the world exactly, so what is worth keeping is
 * what the band *did* in it.
 *
 * `node:sqlite` is built into Node, which keeps the project at zero
 * dependencies. It arrived in Node 22; on anything older this degrades to
 * nothing rather than refusing to start, because a sandbox that will not run
 * without a database is worse than one that runs without a record.
 */

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seed       INTEGER NOT NULL,
  quality    TEXT,
  counts     TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  INTEGER NOT NULL REFERENCES runs(id),
  seed    INTEGER,
  world   TEXT,
  day     INTEGER NOT NULL,
  hour    TEXT    NOT NULL,
  kind    TEXT    NOT NULL,
  text    TEXT    NOT NULL,
  x       INTEGER,
  z       INTEGER,
  at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS samples (
  run_id  INTEGER NOT NULL REFERENCES runs(id),
  day     INTEGER NOT NULL,
  people  INTEGER NOT NULL,
  food    INTEGER NOT NULL,
  animals INTEGER NOT NULL,
  kills   INTEGER NOT NULL,
  PRIMARY KEY (run_id, day)
);
CREATE TABLE IF NOT EXISTS tribes (
  run_id   INTEGER NOT NULL REFERENCES runs(id),
  day      INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  people   INTEGER NOT NULL,
  children INTEGER NOT NULL,
  food     INTEGER NOT NULL,
  PRIMARY KEY (run_id, day, name)
);
CREATE TABLE IF NOT EXISTS worlds (
  seed       INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS state (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_run_day ON events(run_id, day);
`;

export function openDb(file = 'chronicle.db') {
  if (!DatabaseSync) return null;
  try {
    const db = new DatabaseSync(file);
    // A simulation writes in bursts and nobody is reading concurrently; WAL
    // keeps a burst of a hundred events from stalling the request that carried
    // them.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    /* The chronicle became a record of every world rather than of one run, so
       an event has to say which world it happened in. CREATE TABLE IF NOT
       EXISTS will not add a column to a table that is already there, and there
       are databases in the wild from before this; add them by hand. */
    const have = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
    if (!have.includes('seed')) db.exec('ALTER TABLE events ADD COLUMN seed INTEGER');
    if (!have.includes('world')) db.exec('ALTER TABLE events ADD COLUMN world TEXT');
    return {
      startRun(seed, quality, counts) {
        const r = db.prepare('INSERT INTO runs (seed, quality, counts) VALUES (?, ?, ?)')
          .run(seed | 0, String(quality ?? ''), JSON.stringify(counts ?? {}));
        return Number(r.lastInsertRowid);
      },
      addEvents(runId, events) {
        const stmt = db.prepare('INSERT INTO events (run_id, seed, world, day, hour, kind, text, x, z)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        // One transaction for the batch: a hundred separate commits is a
        // hundred fsyncs, and the page sends them in batches for that reason.
        db.exec('BEGIN');
        try {
          for (const e of events) {
            stmt.run(runId | 0, e.seed | 0, String(e.world ?? '').slice(0, 60),
              e.day | 0, String(e.hour ?? ''), String(e.kind ?? ''),
              String(e.text ?? '').slice(0, 500), Math.round(e.x || 0), Math.round(e.z || 0));
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        return events.length;
      },
      addTribes(runId, day, rows) {
        const stmt = db.prepare(`INSERT INTO tribes (run_id, day, name, people, children, food)
                                 VALUES (?, ?, ?, ?, ?, ?)
                                 ON CONFLICT(run_id, day, name) DO UPDATE SET
                                   people = excluded.people, children = excluded.children,
                                   food = excluded.food`);
        db.exec('BEGIN');
        try {
          for (const r of rows) {
            stmt.run(runId | 0, day | 0, String(r.name ?? '').slice(0, 60),
              r.people | 0, r.children | 0, r.food | 0);
          }
          db.exec('COMMIT');
        } catch (err) { db.exec('ROLLBACK'); throw err; }
        return rows.length;
      },
      tribes(runId) {
        return db.prepare(`SELECT day, name, people, children, food FROM tribes
                           WHERE run_id = ? ORDER BY day, name`).all(runId | 0);
      },
      addSample(s) {
        db.prepare(`INSERT INTO samples (run_id, day, people, food, animals, kills)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(run_id, day) DO UPDATE SET
                      people = excluded.people, food = excluded.food,
                      animals = excluded.animals, kills = excluded.kills`)
          .run(s.runId | 0, s.day | 0, s.people | 0, s.food | 0, s.animals | 0, s.kills | 0);
      },
      /* The shelf of worlds. A seed is the world; the name is so you can find
         it again. Keyed by seed, so saving the same world twice is not two
         worlds. */
      saveWorld(name, seed) {
        db.prepare(`INSERT INTO worlds (seed, name) VALUES (?, ?)
                    ON CONFLICT(seed) DO UPDATE SET name = excluded.name`)
          .run(seed | 0, String(name ?? '').slice(0, 60) || `Seed ${seed | 0}`);
      },
      worlds(limit = 60) {
        return db.prepare('SELECT name, seed FROM worlds ORDER BY created_at DESC LIMIT ?')
          .all(Math.min(limit | 0 || 60, 200));
      },
      /* Where you were. One row, overwritten — this is a bookmark, not a
         history, and the history is the chronicle next to it. */
      saveState(payload) {
        db.prepare(`INSERT INTO state (id, payload, saved_at) VALUES (1, ?, datetime('now'))
                    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload,
                                                 saved_at = excluded.saved_at`)
          .run(String(payload));
      },
      loadState() {
        const row = db.prepare('SELECT payload FROM state WHERE id = 1').get();
        return row ? row.payload : null;
      },
      clearState() { db.prepare('DELETE FROM state WHERE id = 1').run(); },
      /* Every table emptied, in one transaction, and the auto-increment
         counters put back so the next run is run 1 rather than run 4,000.
         Returns how many rows went, because "it worked" and "there was
         nothing there" look identical otherwise. */
      truncateAll() {
        const tables = ['events', 'samples', 'tribes', 'state', 'worlds', 'runs'];
        let gone = 0;
        db.exec('BEGIN');
        try {
          for (const t of tables) {
            gone += db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
            db.exec(`DELETE FROM ${t}`);
          }
          // Present only once something has auto-incremented; absent is fine.
          try { db.exec("DELETE FROM sqlite_sequence"); } catch { /* never used */ }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        /* WAL can be larger than the database it belongs to — 4MB of write-ahead
           log against 80KB of tables — and truncating rows does not shrink it.
           Fold it back in, or "emptied" leaves the biggest file untouched. */
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* not in WAL */ }
        try { db.exec('VACUUM'); } catch { /* held open elsewhere */ }
        return gone;
      },
      /** How much is in here, per table — the /api/data readout. */
      counts() {
        const n = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
        return { runs: n('runs'), events: n('events'), samples: n('samples'),
                 tribes: n('tribes'), worlds: n('worlds'), state: n('state') };
      },
      chronicle(runId, limit = 100) {
        return db.prepare('SELECT seed, world, day, hour, kind, text, x, z FROM events'
          + ' WHERE run_id = ? ORDER BY id DESC LIMIT ?')
          .all(runId | 0, Math.min(limit | 0 || 100, 1000));
      },
      /* The panel's chronicle is no longer a record of one run. It spans every
         world the machine has ever built, which is the point of it. */
      allEvents(limit = 200) {
        return db.prepare('SELECT seed, world, day, hour, kind, text, x, z FROM events'
          + ' ORDER BY id DESC LIMIT ?').all(Math.min(limit | 0 || 200, 2000));
      },
      /* Deleting a world takes its lines with it, or the chronicle fills up
         with entries pointing at worlds that are not on the shelf any more. */
      forgetSeed(seed) {
        db.exec('BEGIN');
        try {
          db.prepare('DELETE FROM events WHERE seed = ?').run(seed | 0);
          db.prepare('DELETE FROM worlds WHERE seed = ?').run(seed | 0);
          db.exec('COMMIT');
        } catch (err) { db.exec('ROLLBACK'); throw err; }
      },
      history(runId) {
        return db.prepare(
          'SELECT day, people, food, animals, kills FROM samples WHERE run_id = ? ORDER BY day')
          .all(runId | 0);
      },
      runs(limit = 25) {
        return db.prepare(`SELECT r.id, r.seed, r.quality, r.started_at,
                                  (SELECT COUNT(*) FROM events e WHERE e.run_id = r.id) AS events,
                                  (SELECT MAX(day) FROM samples s WHERE s.run_id = r.id) AS days
                           FROM runs r ORDER BY r.id DESC LIMIT ?`).all(Math.min(limit | 0 || 25, 200));
      },
      close() { db.close(); },
    };
  } catch (err) {
    console.warn(`  ! could not open ${file}: ${err.message} — running without a chronicle`);
    return null;
  }
}
