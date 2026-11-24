// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 49,
    description: 'Holiday cache for public holidays and school holidays',
    up: `
      CREATE TABLE IF NOT EXISTS holiday_cache (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        type        TEXT    NOT NULL CHECK(type IN ('public', 'school')),
        country     TEXT    NOT NULL,
        subdivision TEXT,
        start_date  TEXT    NOT NULL,
        end_date    TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        year        INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_holiday_cache_dates
        ON holiday_cache(start_date, end_date);
      CREATE INDEX IF NOT EXISTS idx_holiday_cache_lookup
        ON holiday_cache(type, country, subdivision, year);
    `,
  };
