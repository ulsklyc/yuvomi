#!/usr/bin/env node
/**
 * Modul: Schema-Baseline schneiden (Phase 2, Abschnitt F4)
 * Zweck: Faehrt die Migrationen von Null auf dem Cipher-Treiber und schreibt
 *        server/migrations/baseline.sql (Schema, Vorgabezeilen, schema_migrations
 *        bis N) und baseline.json (version, schemaHash). Eine frische Datenbank
 *        beginnt damit statt mit N einzelnen Migrationen (server/db/baseline.ts).
 * Ausfuehren: node scripts/build-schema-baseline.ts [--check]
 *   ohne Schalter  schneidet die Baseline auf den Stand der neuesten Migration.
 *                  Nur mit einem Fundament-Release (CONTRIBUTING.md).
 *   --check        erzeugt die Baseline auf dem Stand aus baseline.json neu und
 *                  vergleicht sie Byte fuer Byte mit den Dateien; Exit 1 bei
 *                  Abweichung. Schreibt nichts.
 * Nur erasable TS-Syntax (laeuft per Type Stripping, ohne Build).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Der Logger liest LOG_LEVEL beim Laden; 284 Zeilen "Migration N applied" sind hier Rauschen.
process.env.LOG_LEVEL ??= 'warn';
const { baselineJson, buildBaseline, latestMigrationVersion } = await import('./lib/schema-baseline.ts');

const sqlPath = fileURLToPath(new URL('../server/migrations/baseline.sql', import.meta.url));
const jsonPath = fileURLToPath(new URL('../server/migrations/baseline.json', import.meta.url));

if (process.argv.includes('--check')) {
  const version = (JSON.parse(readFileSync(jsonPath, 'utf8')) as { version: number }).version;
  const baseline = buildBaseline(version);
  const stale = [
    ...(baseline.sql === readFileSync(sqlPath, 'utf8') ? [] : ['server/migrations/baseline.sql']),
    ...(baselineJson(baseline) === readFileSync(jsonPath, 'utf8') ? [] : ['server/migrations/baseline.json']),
  ];
  if (stale.length > 0) {
    console.error(`${stale.join(' and ')} differ(s) from what migrations 1 to ${version} produce.`);
    process.exit(1);
  }
  console.log(`Schema baseline v${version} matches migrations 1 to ${version}.`);
} else {
  const baseline = buildBaseline(latestMigrationVersion());
  writeFileSync(sqlPath, baseline.sql);
  writeFileSync(jsonPath, baselineJson(baseline));
  console.log(`Schema baseline v${baseline.version} written (${baseline.sql.length} bytes, schema ${baseline.schemaHash.slice(0, 12)}).`);
}
