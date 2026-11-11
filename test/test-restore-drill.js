/**
 * Modul: Restore-Drill (scripts/restore-drill.mjs), Phase 1b Abschnitt B
 * Zweck: Der Drill spielt jede Korpus-DB ueber den echten Restore-Weg ein und
 *        prueft, dass dieser Stand sie migriert und bedient. Die Suite baut
 *        sich ihre Korpus-DB selbst, auf dem Weg, den .github/workflows/corpus.yml
 *        an einem Release-Tag geht: Seed mit dem oeffentlichen Testschluessel,
 *        Backup ueber `backupToFile`, `.sha256` daneben.
 *
 *        Vier Faelle aus dem Bauplan, je ueber das CLI wie in CI:
 *          1. frische Seed-DB: alle Schritte gruen, der Server antwortet
 *          2. ein gekipptes Byte: rot bei der Pruefsumme
 *          3. kuenstlich hoehere Schema-Version: rot bei check-backup,
 *             Grund `backup_newer_version`
 *          4. eine fehlende Tabelle: rot beim Schema-Hash
 *        Der Server-Schritt braucht `dist/` (`npm run build`, in der Kette per pretest).
 * Ausführen: npm run test:restore-drill
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './tmp-dir.js';
import { CORPUS_TEST_KEY } from '../scripts/restore-drill.mjs';
import { lostRows, openDatabase } from '../scripts/rollback-probe/fingerprint.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRILL = join(ROOT, 'scripts', 'restore-drill.mjs');
const work = tempDir('yuvomi-restore-drill-test-');

/**
 * Nur PATH und was der Schritt braucht: kein Schluessel und kein `.env` aus der Umgebung des Laufs.
 * @param {Record<string, string>} extra
 */
function env(extra) {
  return { PATH: process.env.PATH, HOME: process.env.HOME ?? '', LOG_LEVEL: 'warn', ...extra };
}

/**
 * `sha256sum`-Format, wie corpus.yml es schreibt.
 * @param {string} file
 */
function writeSha256(file) {
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(`${file}.sha256`, `${hash}  ${basename(file)}\n`);
}

/** Seed und Backup ueber den Code-Weg des Servers, mit dem oeffentlichen Testschluessel. */
function buildCorpus() {
  const src = join(work, 'src');
  mkdirSync(src, { recursive: true });
  const dbPath = join(src, 'yuvomi.db');
  const keyEnv = env({ DB_PATH: dbPath, DB_ENCRYPTION_KEY: CORPUS_TEST_KEY, SESSION_SECRET: 'corpus-test-session-secret' });
  const seed = spawnSync(process.execPath, [join(ROOT, 'scripts', 'seed-demo.js'), '--db', dbPath, '--locale', 'en'], {
    cwd: src, env: keyEnv, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(seed.status, 0, `seed-demo.js:\n${seed.stderr}`);
  const out = join(work, 'yuvomi-0.0.0-corpus.db');
  const backup = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const db = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server', 'db.js')).href)});
     await db.backupToFile(${JSON.stringify(out)}); process.exit(0);`], {
    cwd: src, env: keyEnv, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(backup.status, 0, `backupToFile:\n${backup.stderr}`);
  writeSha256(out);
  return out;
}

const corpus = buildCorpus();

/**
 * Kopie unter neuem Namen; `mutate` darf die Kopie veraendern, danach neue Pruefsumme (ausser `keepSum`).
 * @param {string} name
 * @param {(file: string) => void} mutate
 */
function variant(name, mutate, { keepSum = false } = {}) {
  const file = join(work, name);
  copyFileSync(corpus, file);
  mutate(file);
  if (keepSum) copyFileSync(`${corpus}.sha256`, `${file}.sha256`);
  else writeSha256(file);
  return file;
}

/**
 * @param {string} file
 * @param {(db: any) => void} fn
 */
function withKey(file, fn) {
  const db = openDatabase(file, CORPUS_TEST_KEY);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * @param {string} file
 * @param {...string} flags
 */
function runDrill(file, ...flags) {
  const run = spawnSync(process.execPath, [DRILL, file, '--json', ...flags], {
    cwd: work, env: env({}), encoding: 'utf8', timeout: 300_000,
  });
  const line = run.stdout.split('\n').find((l) => l.startsWith('{'));
  assert.ok(line, `no JSON result (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
  return { status: run.status, result: JSON.parse(line) };
}

test('eine frische Seed-DB besteht jeden Schritt, der Server bedient sie', () => {
  assert.ok(existsSync(join(ROOT, 'dist', 'index.html')), 'dist/ fehlt: erst `npm run build`');
  const { status, result } = runDrill(corpus);
  assert.equal(status, 0, JSON.stringify(result, null, 1));
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((/** @type {{ step: string }} */ s) => s.step), [
    'checksum', 'check-backup', 'restore', 'schema-version', 'integrity', 'foreign-keys', 'schema-hash', 'rows', 'server',
  ]);
  assert.ok(result.steps.every((/** @type {{ ok: boolean }} */ s) => s.ok));
  assert.match(result.steps.at(-1).detail, /^24 endpoints answered 200$/);
});

test('ein gekipptes Byte ist rot bei der Pruefsumme', () => {
  const file = variant('flipped-byte.db', (f) => {
    const fd = openSync(f, 'r+');
    try {
      const b = Buffer.alloc(1);
      readSync(fd, b, 0, 1, 8192);
      b[0] ^= 0xff;
      writeSync(fd, b, 0, 1, 8192);
    } finally {
      closeSync(fd);
    }
  }, { keepSum: true });
  const { status, result } = runDrill(file, '--skip-server');
  assert.equal(status, 1);
  assert.equal(result.failedStep, 'checksum', JSON.stringify(result, null, 1));
  assert.equal(result.reason, 'checksum_mismatch');
});

test('eine kuenstlich hoehere Schema-Version ist rot bei check-backup (backup_newer_version)', () => {
  const file = variant('newer-schema.db', (f) => withKey(f, (db) => {
    const cols = db.prepare('PRAGMA table_info(schema_migrations)').all();
    const max = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    const values = cols.map((/** @type {any} */ c) => (c.name === 'version' ? max + 1000 : c.notnull ? (c.type.match(/INT/i) ? 0 : 'drill') : null));
    db.prepare(`INSERT INTO schema_migrations (${cols.map((/** @type {any} */ c) => c.name).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...values);
  }));
  const { status, result } = runDrill(file, '--skip-server');
  assert.equal(status, 1);
  assert.equal(result.failedStep, 'check-backup', JSON.stringify(result, null, 1));
  assert.equal(result.reason, 'backup_newer_version');
});

test('eine fehlende Tabelle ist rot beim Schema-Hash', () => {
  // Ein Blatt ohne Fremdschluessel auf sich: die Pruefung soll am Schema
  // haengen, nicht an foreign_key_check.
  const table = 'quick_links';
  const file = variant('missing-table.db', (f) => withKey(f, (db) => {
    const referenced = db.prepare("SELECT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) fk WHERE m.type = 'table' AND fk.\"table\" = ?").all(table);
    assert.deepEqual(referenced, [], `${table} darf kein Ziel eines Fremdschluessels sein`);
    db.exec(`DROP TABLE ${table}`);
  }));
  const { status, result } = runDrill(file, '--skip-server');
  assert.equal(status, 1);
  assert.equal(result.failedStep, 'schema-hash', JSON.stringify(result, null, 1));
  assert.equal(result.reason, 'schema_hash_mismatch');
  assert.match(result.steps.at(-1).detail, new RegExp(`${table}: missing`));
});


// Gemessen an den Ankern v2.0.0 und v2.18.0: Migration v151 raeumt doppelte
// Eintraege aus dem Volltext-Index (47 Zeilen fuer 26 Einkaufsartikel, danach
// 26), und `mealie_accounts` heisst seit einer Migration
// `recipe_provider_accounts`. Beides ist gewollt. Der Zeilenschritt zaehlt
// deshalb nur Tabellen des Kopf-Schemas und keine abgeleiteten FTS-Tabellen;
// weniger Zeilen in einer echten Tabelle bleiben rot. Eine Korpus-Datei kann
// das nicht vorfuehren (die Messung "vorher" liest dieselbe Datei), also an
// der Regel selbst.
test('Zeilenregel: echte Tabellen zaehlen, FTS-Index und vom Kopf entfernte Tabellen nicht', () => {
  /** @param {Record<string, number>} counts @param {string[]} [virtualTables] */
  const fp = (counts, virtualTables = []) => ({
    journal: 'wal', migrations: 1, schema_version: 1, schema_hash: 'x', virtual_tables: virtualTables,
    tables: Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, { n, h: 'h' }])),
  });
  const reference = fp({ notes: 0, search_index_content: 0, search_index_docsize: 0, recipe_provider_accounts: 0 }, ['search_index']);
  const before = fp({ notes: 8, search_index_content: 110, search_index_docsize: 110, mealie_accounts: 1 });
  assert.deepEqual(lostRows(before, fp({ notes: 8, search_index_content: 89, search_index_docsize: 89, recipe_provider_accounts: 1 }), reference), [],
    'Index geschrumpft, Tabelle umbenannt: kein Verlust');
  assert.deepEqual(lostRows(before, fp({ notes: 6, search_index_content: 110, search_index_docsize: 110 }), reference), ['notes: 8 -> 6 rows']);
  assert.deepEqual(lostRows(before, fp({ search_index_content: 110 }), reference), ['notes: table missing'],
    'eine Tabelle des Kopf-Schemas, die nach dem Restore fehlt, ist rot');
});
