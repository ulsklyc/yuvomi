// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 285,
    description: 'Budget series: optional end date (#1742)',
    up(database) {
      const cols = database.prepare('PRAGMA table_info(budget_series)').all();
      if (!cols.some((c) => c.name === 'end_date')) {
        database.exec('ALTER TABLE budget_series ADD COLUMN end_date TEXT');
      }
    },
  };
