export default {
    version: 201,
    description: 'Waste collection: committed imported pickups (#1063 Phase 3)',
    up: `
      -- One row per concrete pickup fact accepted by a committed import.
      -- identity_key is the stable cross-reimport identity used to diff a
      -- re-import into additions/changes/removals: the ICS UID (optionally
      -- suffixed with the concrete date, for a recurring or overridden
      -- VEVENT) when present, otherwise a deterministic fingerprint over the
      -- label and date (opt-in allowMissingUid mode - see waste-import.js).
      -- external_uid is kept separately, nullable, purely for display/
      -- diagnostics. type_id carries no cascade: an imported pickup is a
      -- reference that blocks type deletion exactly like a schedule or
      -- one-off (invariant #5); only source_id cascades, so deleting a
      -- source never touches another source's or manual data.
      CREATE TABLE waste_imported_pickups (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id          INTEGER NOT NULL REFERENCES waste_sources(id) ON DELETE CASCADE,
        type_id            INTEGER NOT NULL REFERENCES waste_types(id),
        identity_key       TEXT    NOT NULL,
        external_uid       TEXT,
        original_summary   TEXT,
        date_key           TEXT    NOT NULL,
        tz_note            TEXT,
        created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (source_id, identity_key)
      );
      CREATE TRIGGER trg_waste_imported_pickups_updated_at AFTER UPDATE ON waste_imported_pickups FOR EACH ROW BEGIN
        UPDATE waste_imported_pickups SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE INDEX idx_waste_imported_pickups_source ON waste_imported_pickups(source_id);
      CREATE INDEX idx_waste_imported_pickups_type_date ON waste_imported_pickups(type_id, date_key);
    `,
  };
