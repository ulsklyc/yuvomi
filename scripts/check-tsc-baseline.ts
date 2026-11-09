#!/usr/bin/env node
/**
 * Modul: Typpruefung - tsc-Fehler gegen eine sinkende Baseline (Phase 1a, Abschnitt C)
 * Zweck: Ruft `tsc --build --force --verbose --pretty false`, ordnet jede Fehlerzeile dem
 *        Projekt zu, das die Datei besitzt (server/ + scripts/, public/, test/; ein Projekt
 *        zieht per Import auch fremde Dateien mit, deren Fehler dort mit falscher
 *        Konfiguration entstuenden; public/vendor/ zaehlt nie), zaehlt eindeutige Stellen je `datei<TAB>TScode` und
 *        vergleicht mit tsc-baseline.json. Exit 1, wenn ein Schluessel steigt oder neu ist.
 *        Die Zahl darf nur sinken; die Baseline ist nie Freibrief fuer Neues.
 * Ausfuehren: node scripts/check-tsc-baseline.ts [--update | --init] [--root <dir>]
 *   --update  schreibt NUR sinkende oder verschwundene Werte zurueck, nie steigende.
 *   --init    fuellt eine fehlende oder leere Baseline vollstaendig (einmaliger Start).
 * Nur erasable TS-Syntax (laeuft per Type Stripping, ohne Build, auf Node 24.12+ und 26).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Counts = Record<string, number>;

const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 ? resolve(String(args[rootIdx + 1])) : fileURLToPath(new URL('..', import.meta.url));
const baselinePath = resolve(root, 'tsc-baseline.json');
// Welche Verzeichnisse ein Projekt besitzt; alles andere ist nur Mitlaeufer.
const OWNED: Record<string, string[]> = { server: ['server/', 'scripts/', 'vite.config.ts'] };

function measure(): Counts {
  const run = spawnSync(process.execPath, [tscBin, '--build', '--force', '--verbose', '--pretty', 'false'], {
    cwd: root, encoding: 'utf8', maxBuffer: 1 << 29,
  });
  const out = `${run.stdout}${run.stderr}`;
  if (run.error || !/Building project/.test(out)) {
    console.error(`tsc lief nicht: ${run.error?.message ?? out.slice(0, 400)}`);
    process.exit(2);
  }
  // Ohne Quellort (TS2688, TS18003, TS5xxx) oder in einer tsconfig: das Projekt wurde nicht
  // geprueft. Das ist kein Typfehler fuer die Baseline, sondern ein kaputter Lauf.
  const fatal = out.split('\n').filter((l) => /^error TS\d+:/.test(l) || /tsconfig[^/(]*\.json\(\d+,\d+\): error TS\d+:/.test(l));
  if (fatal.length > 0) {
    console.error(`tsc meldet Fehler der Konfiguration, nichts wird gezaehlt:\n${fatal.slice(0, 10).join('\n')}`);
    process.exit(2);
  }
  const places = new Set<string>();
  const counts: Counts = {};
  let owned: string[] = [];
  let located = 0;
  for (const line of out.split('\n')) {
    const building = /Building project '([^']+)'/.exec(line);
    if (building) {
      const dir = String(building[1]).replace(/\/?tsconfig[^/]*$/, '');
      owned = OWNED[dir] ?? [`${dir}/`];
      continue;
    }
    const err = /^(\S.*?)\((\d+),(\d+)\): error (TS\d+):/.exec(line);
    if (err) located++;
    if (!err || String(err[1]).includes('/vendor/')) continue; // Fremdcode: Regeln in CONTRIBUTING
    if (!owned.some((prefix) => String(err[1]).startsWith(prefix))) continue;
    const place = `${err[1]}:${err[2]}:${err[3]}:${err[4]}`;
    if (places.has(place)) continue;
    places.add(place);
    const key = `${err[1]}\t${err[4]}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  if (run.status !== 0 && located === 0) {
    console.error(`tsc endete mit Exit ${run.status} ohne eine Fehlerzeile mit Ort: ${out.slice(0, 400)}`);
    process.exit(2);
  }
  return counts;
}

function sorted(counts: Counts): Counts {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function write(counts: Counts) {
  writeFileSync(baselinePath, `${JSON.stringify(sorted(counts), null, 1)}\n`);
}

const current = measure();
const exists = existsSync(baselinePath);
const baseline: Counts = exists ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};

if (args.includes('--init')) {
  if (Object.keys(baseline).length > 0) {
    console.error('--init nur bei fehlender oder leerer Baseline; --update senkt eine bestehende.');
    process.exit(2);
  }
  write(current);
  console.log(`Baseline angelegt: ${Object.keys(current).length} Schluessel.`);
  process.exit(0);
}
if (!exists) {
  console.error('tsc-baseline.json fehlt (einmalig: --init).');
  process.exit(2);
}

const worse = Object.entries(current).filter(([key, n]) => n > (baseline[key] ?? 0));
const better = Object.entries(baseline).filter(([key, n]) => (current[key] ?? 0) < n);

if (worse.length > 0) {
  console.error(`Neue oder mehr Typfehler als die Baseline (${worse.length} Schluessel):`);
  for (const [key, n] of worse.slice(0, 40)) {
    const [file, code] = key.split('\t');
    console.error(`  ${file}  ${code}  ${baseline[key] ?? 0} -> ${n}`);
  }
  if (worse.length > 40) console.error(`  ... und ${worse.length - 40} weitere`);
  process.exit(1);
}

if (args.includes('--update')) {
  const next: Counts = {};
  for (const key of Object.keys(baseline)) if ((current[key] ?? 0) > 0) next[key] = current[key] as number;
  write(next);
  console.log(`Baseline gesenkt: ${better.length} Schluessel veraendert oder entfernt.`);
} else if (better.length > 0) {
  console.log(`Baseline kann sinken: ${better.length} Schluessel (node scripts/check-tsc-baseline.ts --update).`);
}
console.log(`Typpruefung ok: ${Object.keys(current).length} Schluessel, ${Object.values(current).reduce((a, b) => a + b, 0)} Fehler (Baseline ${Object.keys(baseline).length}).`);
