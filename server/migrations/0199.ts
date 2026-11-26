export default {
    version: 199,
    description: 'Waste collection: ICS import sources with health tracking (#1063 Phase 3)',
    up: `
      -- One row per imported file. version starts at 1 and is bumped on every
      -- committed (re)import; content_hash is the sha256 of the raw ICS text
      -- that produced the current committed snapshot, so a re-import preview
      -- can tell "nothing changed" from "this differs" without diffing rows.
      -- last_success_at is only touched on a successful commit (never cleared
      -- by a later failed attempt), so "needs refresh" reads as
      -- last_success_at stale/absent while last_error is set - never merely
      -- from file age (invariant #6).
      CREATE TABLE waste_sources (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        kind             TEXT    NOT NULL DEFAULT 'file' CHECK (kind IN ('file')),
        name             TEXT    NOT NULL,
        content_hash     TEXT    NOT NULL,
        version          INTEGER NOT NULL DEFAULT 1,
        coverage_start   TEXT,
        coverage_end     TEXT,
        last_import_at   TEXT,
        last_success_at  TEXT,
        last_error       TEXT,
        created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TRIGGER trg_waste_sources_updated_at AFTER UPDATE ON waste_sources FOR EACH ROW BEGIN
        UPDATE waste_sources SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE INDEX idx_waste_sources_name ON waste_sources(name);
    `,
  };
