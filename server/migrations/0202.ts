// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 202,
    description: 'Waste collection: automatic ICS URL sources (#1063 Phase 7)',
    // kind's CHECK only allowed 'file' (migration 199); widening it to add
    // 'url' needs the CREATE+COPY+DROP+RENAME rebuild pattern used elsewhere
    // in this file, since SQLite cannot ALTER an existing CHECK. The DROP
    // TABLE step would otherwise cascade-delete every waste_source_mappings/
    // waste_imported_pickups row through their ON DELETE CASCADE (the same
    // hazard noted at migration 52's dms_accounts rebuild) - foreignKeysOff
    // suspends FK enforcement for this migration only, and the framework's
    // own foreign_key_check afterward fails the migration if anything was
    // actually left dangling.
    foreignKeysOff: true,
    up(db) {
      db.exec(`
        CREATE TABLE waste_sources_new (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          kind                     TEXT    NOT NULL DEFAULT 'file' CHECK (kind IN ('file', 'url')),
          name                     TEXT    NOT NULL,
          content_hash             TEXT    NOT NULL,
          version                  INTEGER NOT NULL DEFAULT 1,
          coverage_start           TEXT,
          coverage_end             TEXT,
          last_import_at           TEXT,
          last_success_at          TEXT,
          last_error               TEXT,
          -- URL-only fields (NULL for kind='file'). url is the subscription
          -- credential (invariant: never expose it to a user without write
          -- access) - server/routes/waste/sources.js redacts it on read for
          -- read-only callers, the same way caldav-sync.js keeps a password
          -- out of its own list responses.
          url                      TEXT,
          etag                     TEXT,
          last_modified            TEXT,
          refresh_interval_minutes INTEGER NOT NULL DEFAULT 1440,
          next_attempt_at          TEXT,
          consecutive_failures     INTEGER NOT NULL DEFAULT 0,
          -- Set when an auto-refresh fetched new content but could not
          -- auto-commit (an unmapped label, or an unresolved blocking
          -- diagnostic - neither may be decided automatically). The
          -- scheduler skips a source while this is set; only a reviewed
          -- manual refresh (same mapping wizard as file re-import) clears it.
          needs_mapping            INTEGER NOT NULL DEFAULT 0 CHECK (needs_mapping IN (0, 1)),
          created_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );
        INSERT INTO waste_sources_new (
          id, kind, name, content_hash, version, coverage_start, coverage_end,
          last_import_at, last_success_at, last_error, created_by, created_at, updated_at
        )
        SELECT id, kind, name, content_hash, version, coverage_start, coverage_end,
               last_import_at, last_success_at, last_error, created_by, created_at, updated_at
        FROM waste_sources;
        DROP TABLE waste_sources;
        ALTER TABLE waste_sources_new RENAME TO waste_sources;
        CREATE TRIGGER trg_waste_sources_updated_at AFTER UPDATE ON waste_sources FOR EACH ROW BEGIN
          UPDATE waste_sources SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
        CREATE INDEX idx_waste_sources_name ON waste_sources(name);
        -- The scheduler's own "which sources are due" query (kind='url',
        -- needs_mapping=0, next_attempt_at due).
        CREATE INDEX idx_waste_sources_due ON waste_sources(kind, needs_mapping, next_attempt_at);
      `);
    },
  };
