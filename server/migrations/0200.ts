export default {
    version: 200,
    description: 'Waste collection: ICS source label-to-type mappings (#1063 Phase 3)',
    up: `
      -- One row per distinct label (CATEGORIES tag, or SUMMARY when a feed
      -- carries no categories) seen for a source. Exactly one of
      -- (type_id set) / (ignored=1) is valid - a label is always either
      -- mapped or explicitly excluded, never left ambiguous. Rows persist
      -- across re-imports (UNIQUE on source_id+normalized_label) so a
      -- reviewed decision is remembered and only resurfaced for review, not
      -- re-asked, unless the label itself is new.
      CREATE TABLE waste_source_mappings (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id         INTEGER NOT NULL REFERENCES waste_sources(id) ON DELETE CASCADE,
        original_label    TEXT    NOT NULL,
        normalized_label  TEXT    NOT NULL,
        type_id           INTEGER REFERENCES waste_types(id),
        ignored           INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0, 1)),
        created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (source_id, normalized_label),
        CHECK (
          (ignored = 1 AND type_id IS NULL) OR (ignored = 0 AND type_id IS NOT NULL)
        )
      );
      CREATE TRIGGER trg_waste_source_mappings_updated_at AFTER UPDATE ON waste_source_mappings FOR EACH ROW BEGIN
        UPDATE waste_source_mappings SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE INDEX idx_waste_source_mappings_source ON waste_source_mappings(source_id);
    `,
  };
