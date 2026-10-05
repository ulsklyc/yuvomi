/**
 * Modul: Test-Infrastruktur - Temp-Reste-Guard
 * Zweck: Suiten raeumen weg, was sie unter dem Temp-Ordner anlegen.
 *
 * Am 2026-09-22 lief die Platte voll (ENOSPC fuer jeden Prozess): Suiten
 * legten per `mkdtemp` Verzeichnisse an und loeschten sie nie. Danach lagen
 * dort wieder 570 `yuvomi-test-rekey-*` (1,8 GB) und 286 `yuvomi-encryption-*`.
 * Gemessen mit eigenem TMPDIR je Suite liessen 22 Suiten Reste liegen - ein
 * Lauf von test:db-encryption allein 143 Verzeichnisse.
 *
 * Drei Proben:
 *   1. `tempDir()` aus test/tmp-dir.js raeumt beim Prozessende weg - auch
 *      nach einer Ausnahme, die den Prozess abbricht.
 *   2. Ausgewaehlte Suiten laufen mit EIGENEM TMPDIR und hinterlassen nichts.
 *      Die Stichprobe deckt die drei Formen ab, die geleckt haben: DB_PATH
 *      plus Migrations-DB, ein Skript als Kindprozess, ein Service-Setup.
 *   3. Jede Datei unter test/, die `mkdtemp` ruft, nutzt `tempDir()` oder steht
 *      in SELF_CLEANING - mit Grund und einer Messung. Eine neue Suite muss
 *      sich also entscheiden; ein Eintrag, dessen Datei kein `mkdtemp` mehr
 *      ruft, faellt als veraltet auf.
 *
 * Warum nicht alle Suiten mit eigenem TMPDIR: sie laufen ohnehin in der
 * Kette, und ein zweiter Lauf von test:db-encryption und test:restore-rekey
 * kostete hier weitere zwei Minuten. Probe 3 haelt die Menge vollstaendig,
 * Probe 2 misst, dass der Mechanismus am echten Programm wirkt.
 *
 * Ausfuehren: node --test test/test-tmp-clean.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './tmp-dir.js';

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(TEST_DIR, '..');
const HELPER = pathToFileURL(join(TEST_DIR, 'tmp-dir.js')).href;

/**
 * Dateien, die `mkdtemp` selbst rufen und selbst wegraeumen (after(),
 * finally oder t.after). Gemessen am 2026-09-22: jede mit eigenem TMPDIR
 * gelaufen, 0 Reste. Neue Eintraege nur nach derselben Messung - sonst
 * `tempDir()` nehmen.
 */
const SELF_CLEANING = new Map([
  ['test-backup-routes.js', 'TMP_ROOT, rmSync im after()'],
  ['test-backup-scheduler.js', 'Backup-Ordner, rmSync im after()'],
  ['test-backup-webdav.js', 'je Probe, fs.rm im finally'],
  ['test-calendar-routes.js', 'Anhangsordner je Probe, fs.rm im finally'],
  ['test-db-isolation.js', 'Fixture-Ordner, rmSync im finally'],
  ['test-db-newer-schema.js', 'rmSync je Probe'],
  ['test-document-folders.js', 'rmSync im after()'],
  ['test-document-storage.js', 'rmSync je Probe'],
  ['test-extension-permissions.js', 'TMP_ROOT, rmSync im after()'],
  ['test-household-members.js', 'fs.rm im finally'],
  ['test-installer-env-write.js', 'rmSync je Probe'],
  ['test-migrate-tolerance.js', 'rmSync je Probe'],
  ['test-modules.js', 'TMP_ROOT, rmSync im after()'],
  ['test-parallel-runner.js', 'prueft den Runner, der selbst mkdtemp ruft; rmSync je Probe'],
  ['test-sendfile-dotpath.js', 'TMP_ROOT, rmSync im after()'],
  ['test-service-worker-build-revision.js', 'rmSync je Probe'],
  ['test-suite-chain.js', 'Fixture-Ordner, rmSync je Probe'],
]);

/** Stichprobe fuer Probe 2: je eine Form, die vor dem Fix geleckt hat. */
const SAMPLE = [
  'test-budget-account-inherit-migration.js', // DB_PATH + Migrations-DB je Probe
  'test-review-proof.js', // Skript als Programm in einem eigenen Ordner
  'test-fasting-reminders-transactions.js', // Service-Setup mit Datei-DB je Probe
];

/** Faehrt `args` mit einem frischen, eigenen TMPDIR und liefert Ergebnis und Reste. */
function runWithOwnTmp(args) {
  const own = tempDir('yuvomi-tmp-clean-');
  // OHNE NODE_TEST_CONTEXT: node:test setzt es fuer seine Kindprozesse, und ein
  // `node --test` darin ueberspringt dann alle Dateien und endet mit 0 - die
  // Probe war so gruen, ohne dass eine Suite gelaufen waere.
  const env = { ...process.env, TMPDIR: `${own}/`, TMP: own, TEMP: own };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, {
    cwd: REPO,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { result, own, left: readdirSync(own) };
}

test('der eigene TMPDIR erreicht os.tmpdir() im Kindprozess', () => {
  const { result, own } = runWithOwnTmp(['-e', "process.stdout.write(require('node:os').tmpdir())"]);
  assert.equal(result.status, 0, result.stderr);
  // os.tmpdir() schneidet den Schraegstrich am Ende ab.
  assert.equal(result.stdout, own);
});

for (const [label, tail] of [
  ['am normalen Ende', ''],
  ['nach einer Ausnahme, die den Prozess abbricht', "throw new Error('Absicht');"],
]) {
  test(`tempDir() raeumt ${label} weg`, () => {
    const script = [
      `import { tempDir } from ${JSON.stringify(HELPER)};`,
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const dir = tempDir('yuvomi-tmp-clean-probe-');",
      "mkdirSync(join(dir, 'tief', 'drin'), { recursive: true });",
      "writeFileSync(join(dir, 'tief', 'drin', 'db.sqlite'), 'x');",
      'console.log(dir);',
      tail,
    ].join('\n');
    const { result, own, left } = runWithOwnTmp(['--input-type=module', '-e', script]);
    const dir = result.stdout.trim();
    assert.ok(dir.startsWith(own), `das Verzeichnis lag unter dem eigenen TMPDIR: ${dir}`);
    assert.equal(result.status, tail ? 1 : 0, result.stderr);
    assert.equal(existsSync(dir), false, `${dir} ist noch da`);
    assert.deepEqual(left, []);
  });
}

for (const file of SAMPLE) {
  test(`${file} hinterlaesst unter einem eigenen TMPDIR nichts`, () => {
    const { result, left } = runWithOwnTmp(['--experimental-sqlite', '--test', '--test-reporter=spec', join('test', file)]);
    assert.equal(result.status, 0, `${file} ist selbst rot:\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-2000)}`);
    // Ein Lauf ohne Tests endet auch mit 0 und hinterlaesst auch nichts.
    assert.match(result.stdout, /^ℹ pass [1-9]\d*$/m, `${file} hat keinen einzigen Test gefahren`);
    assert.match(result.stdout, /^ℹ fail 0$/m);
    assert.deepEqual(left, [], `${file} liess Reste im Temp-Ordner liegen`);
  });
}

/** Alle .js/.mjs unter test/, rekursiv, ohne node_modules. */
function testFiles(dir = TEST_DIR) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (/\.(m?js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('jede Datei mit mkdtemp nutzt tempDir() oder raeumt nachweislich selbst weg', () => {
  const own = new Set(['tmp-dir.js', 'test-tmp-clean.js']);
  const offenders = [];
  const seen = new Set();
  for (const full of testFiles()) {
    const rel = relative(TEST_DIR, full);
    if (own.has(rel)) continue;
    // Kommentare zaehlen nicht: mkdtemp im Erklaertext ist kein Aufruf.
    const code = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (!/\bmkdtemp(Sync)?\s*\(/.test(code)) continue;
    seen.add(rel);
    if (!SELF_CLEANING.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    'Diese Dateien rufen mkdtemp ohne tempDir() aus test/tmp-dir.js. tempDir() nehmen - oder, wenn die Datei '
    + 'selbst wegraeumt, mit eigenem TMPDIR messen (0 Reste) und in SELF_CLEANING eintragen.');
  const stale = [...SELF_CLEANING.keys()].filter((rel) => !seen.has(rel));
  assert.deepEqual(stale, [], 'SELF_CLEANING nennt Dateien, die kein mkdtemp mehr rufen - Eintrag streichen');
});
