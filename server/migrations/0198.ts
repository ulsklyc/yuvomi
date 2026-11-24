// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 198,
    description: 'ship the Waste collection module disabled by default (households opt in, #1063)',
    up(db) {
      // Same merge-not-replace pattern as migration 145 (Inventory) and 166
      // (Schedule): a household may already have disabled other modules, and a
      // blind INSERT OR REPLACE would silently re-enable them.
      const row = db.prepare("SELECT value FROM sync_config WHERE key = 'disabled_modules'").get();

      let disabled = [];
      if (row?.value) {
        try {
          const parsed = JSON.parse(row.value);
          if (Array.isArray(parsed)) disabled = parsed.filter((m) => typeof m === 'string');
        } catch { /* a broken value is replaced, not honored */ }
      }

      if (disabled.includes('waste')) return;
      disabled.push('waste');

      db.prepare(`
        INSERT INTO sync_config (key, value) VALUES ('disabled_modules', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      `).run(JSON.stringify(disabled));
    },
  };
