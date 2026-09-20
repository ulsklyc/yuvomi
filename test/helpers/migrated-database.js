export function applyMigration(database, migration) {
  const run = database.transaction(() => {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    if (migration.foreignKeysOff) {
      const violations = database.pragma('foreign_key_check');
      if (violations.length > 0) {
        throw new Error(`Migration ${migration.version} left ${violations.length} foreign key violation(s).`);
      }
    }
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  });

  if (!migration.foreignKeysOff) {
    run();
    return;
  }

  database.pragma('foreign_keys = OFF');
  try {
    run();
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

export function buildMigratedDatabase(Database, migrations, path = ':memory:') {
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(database, migration);
  return database;
}
