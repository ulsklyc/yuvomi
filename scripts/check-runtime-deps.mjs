#!/usr/bin/env node
/**
 * Modul: Image-Build - Laufzeit-Abhaengigkeiten pruefen (#2006)
 * Zweck: Laedt jedes Paket aus `dependencies` der package.json neben diesem
 *        Skript per `import()` - genau so, wie der Server es tut. Fehlt eines
 *        oder zerbricht sein Baum, endet das Skript mit Exit 1 und nennt es.
 *        Das Dockerfile ruft es in der Build-Stage direkt nach
 *        `npm ci --omit=dev` auf, also je Plattform: 2.77.1 ging auf arm64 ohne
 *        googleapis raus, weil npm ein optionales Paket still verworfen hatte
 *        und der Build trotzdem gruen war.
 *        Keine Liste von Hand: die Quelle ist `dependencies` selbst. Dass jedes
 *        Paket, das der Server importiert, dort steht, haelt
 *        test/test-runtime-deps.js.
 * Ausfuehren: node scripts/check-runtime-deps.mjs
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @param {Record<string, string> | undefined} dependencies
 * @param {(name: string) => Promise<unknown>} [load]
 * @returns {Promise<{ name: string, error: string }[]>} die Pakete, die nicht laden
 */
export async function findUnloadableDependencies(dependencies, load = (name) => import(name)) {
  const failures = [];
  for (const name of Object.keys(dependencies ?? {})) {
    try {
      await load(name);
    } catch (err) {
      failures.push({ name, error: `${err?.code ?? 'ERROR'}: ${err?.message ?? String(err)}` });
    }
  }
  return failures;
}

async function main() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const names = Object.keys(pkg.dependencies ?? {});
  if (names.length === 0) {
    console.error('check-runtime-deps: package.json declares no dependencies - refusing to pass an empty check');
    process.exit(1);
  }
  const failures = await findUnloadableDependencies(pkg.dependencies);
  if (failures.length > 0) {
    console.error(`check-runtime-deps: ${failures.length} of ${names.length} runtime dependencies do not load:`);
    for (const { name, error } of failures) console.error(`  - ${name}: ${error}`);
    process.exit(1);
  }
  console.log(`check-runtime-deps: all ${names.length} runtime dependencies load`);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  await main();
}
