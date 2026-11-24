// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 207,
    description: 'Waste collection: covering index for per-source pickup-health lookups (audit finding, no data change)',
    // waste-store.js#decorateSourceHealth/listSources both run
    // `WHERE source_id = ? AND date_key >= ?` (single source) or
    // `WHERE date_key >= ? GROUP BY source_id` (every source) against
    // waste_imported_pickups - neither existing index covers that:
    // idx_waste_imported_pickups_source is source_id alone (no date_key), and
    // idx_waste_imported_pickups_type_date (migration 201) is keyed on
    // type_id, not source_id. Both queries fell back to the source-only
    // index plus a per-row filter - fine at today's row counts (measured
    // 18-36ms, see the audit report), a table scan by source count that grows
    // with import history otherwise. A new index alongside the old ones
    // (not a replacement - idx_waste_imported_pickups_source still serves
    // deleteSource's un-filtered "does this source have any rows" shape).
    up: `
      CREATE INDEX idx_waste_imported_pickups_source_date ON waste_imported_pickups(source_id, date_key);
    `,
  };
