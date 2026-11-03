/**
 * Modul: Secrets, die beim ersten Start entstehen (server/utils/auto-secrets.js)
 * Zweck: SESSION_SECRET und DB_ENCRYPTION_KEY entstehen bei einer
 *        Neuinstallation von selbst unter `<Verzeichnis von DB_PATH>/.secrets/`,
 *        und eine BESTANDSINSTALLATION bleibt, wie sie war. Der zweite Teil ist
 *        der teure: ein Schlüssel für eine vorhandene Klartext-Datenbank liesse
 *        db.js sie still verschlüsseln.
 *
 *        Jeder Fall ist ein echter Start als eigener Prozess gegen ein eigenes
 *        Temp-Verzeichnis, in der Reihenfolge des Servers: Handschlag, db.js,
 *        auth.js. Der Log-Fall startet server/index.js selbst.
 *
 *        Deckt ab:
 *          - Neuinstallation: beide entstehen (0700/0600), die Datenbank ist
 *            verschlüsselt, der zweite Start liest dieselben Werte
 *          - Bestand mit yuvomi.db, mit Legacy-oikos.db und mit eigenem
 *            DB_PATH: kein Schlüssel, Klartext bleibt Klartext, SESSION_SECRET
 *            aus der Umgebung bleibt unverändert
 *          - `:memory:` legt keine Datei an
 *          - ausdrücklich gesetzt oder `_FILE`: keine Datei; liegt doch eine,
 *            gilt der ausdrückliche Wert, und das Log sagt es
 *          - Platzhalter bricht weiter ab, auch neben einer gespeicherten Datei
 *          - leere oder unlesbare gespeicherte Datei bricht ab
 *          - DB_ENCRYPTION_AUTO_KEY=false: kein Schlüssel, eine vorhandene
 *            Datei wird trotzdem gelesen
 *          - verschlüsselte Datenbank ohne Schlüssel: Abbruch, der den Pfad nennt
 *          - kein Secret-Wert in stdout oder stderr eines echten Serverstarts
 *          - server/check-backup.js liest die gespeicherte Datei (env > _FILE >
 *            gespeichert) und legt nie etwas an
 *          - der Backup-Befehl aus Admin -> Backups und docs/installation.md
 *            (beide gleich, aus der Quelle gelesen) findet den gespeicherten
 *            Schluessel und `_FILE` und legt nie einen an
 * Ausführen: node --test test/test-auto-secrets.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';
import { once } from 'node:events';
import { tempDir } from './tmp-dir.js';
import { _writeStoredForTest } from '../server/utils/auto-secrets.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const url = (rel) => JSON.stringify(pathToFileURL(join(ROOT, rel)).href);
const PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'binary');
const NAMES = ['SESSION_SECRET', 'DB_ENCRYPTION_KEY'];
const RUNS_AS_ROOT = process.getuid?.() === 0;

/** Der Start bis auth.js, wie server/index.js ihn importiert; meldet Herkunft und Hash der Werte. */
const PROBE = `
  import { createHash } from 'node:crypto';
  await import(${url('server/utils/load-file-secrets.js')});
  const db = await import(${url('server/db.js')});
  await import(${url('server/auth.js')});
  const auto = await import(${url('server/utils/auto-secrets.js')});
  const hash = (v) => (v ? createHash('sha256').update(v).digest('hex') : null);
  const report = {};
  for (const name of ['SESSION_SECRET', 'DB_ENCRYPTION_KEY']) {
    report[name] = { origin: auto.secretOrigin(name), path: auto.storedSecretPath(name), hash: hash(process.env[name]) };
  }
  report.dbPath = db.getPath();
  process.stdout.write('PROBE ' + JSON.stringify(report) + '\\n');
  db.get().close();
  process.exit(0);
`;

/** Nur PATH und was der Fall setzt: keine Secrets aus der Umgebung des Testlaufs. */
function cleanEnv(env) {
  return { PATH: process.env.PATH, LOG_LEVEL: 'info', ...env };
}

function start(cwd, env) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], {
    cwd, env: cleanEnv(env), encoding: 'utf8', timeout: 60_000,
  });
  const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE '));
  return {
    status: run.status,
    output: `${run.stdout}${run.stderr}`,
    report: line ? JSON.parse(line.slice('PROBE '.length)) : null,
  };
}

function started(run) {
  assert.equal(run.status, 0, run.output);
  assert.ok(run.report, run.output);
  return run.report;
}

const sha = (value) => createHash('sha256').update(value).digest('hex');
const stored = (dir, name) => readFileSync(join(dir, '.secrets', name), 'utf8').replace(/\n$/, '');
const mode = (p) => statSync(p).mode & 0o777;

function isPlaintext(filePath) {
  return readFileSync(filePath).subarray(0, PLAINTEXT_HEADER.length).equals(PLAINTEXT_HEADER);
}

/** Eine Klartext-Datenbank, wie sie eine Bestandsinstallation ohne Schlüssel hat. */
function seedPlaintext(filePath) {
  const seed = new Database(filePath);
  seed.exec("CREATE TABLE bestand_marker (note TEXT); INSERT INTO bestand_marker VALUES ('vorher')");
  seed.close();
}

function marker(filePath) {
  const handle = new Database(filePath, { readonly: true });
  try {
    return handle.prepare('SELECT note FROM bestand_marker').get().note;
  } finally {
    handle.close();
  }
}

test('Neuinstallation: beide Secrets entstehen, die Datenbank ist verschluesselt, der zweite Start liest dieselben', () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const dbPath = join(dir, 'yuvomi.db');

  const first = started(start(dir, { DB_PATH: dbPath }));
  for (const name of NAMES) {
    assert.equal(first[name].origin, 'generated', name);
    assert.equal(first[name].path, join(dir, '.secrets', name), name);
    const value = stored(dir, name);
    assert.match(value, /^[0-9a-f]{64}$/, `${name}: 32 Zufallsbytes als Hex`);
    assert.equal(first[name].hash, sha(value), `${name}: der Prozess benutzt den gespeicherten Wert`);
    assert.equal(mode(join(dir, '.secrets', name)), 0o600, `${name}: Datei 0600`);
  }
  assert.equal(mode(join(dir, '.secrets')), 0o700, 'Verzeichnis 0700');
  assert.ok(!isPlaintext(dbPath), 'die neue Datenbank ist verschluesselt');
  assert.deepEqual(readdirSync(join(dir, '.secrets')).sort(), [...NAMES].sort(), 'keine Arbeitsdatei bleibt liegen');

  const second = started(start(dir, { DB_PATH: dbPath }));
  for (const name of NAMES) {
    assert.equal(second[name].origin, 'stored', name);
    assert.equal(second[name].hash, first[name].hash, `${name}: derselbe Wert beim zweiten Start`);
  }
});

test('Bestand mit yuvomi.db ohne Schluessel: kein Schluessel entsteht, Klartext bleibt, SESSION_SECRET bleibt', () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const dbPath = join(dir, 'yuvomi.db');
  seedPlaintext(dbPath);

  const report = started(start(dir, { DB_PATH: dbPath, SESSION_SECRET: 'bestand-secret-aus-der-env-0123456789' }));
  assert.equal(report.DB_ENCRYPTION_KEY.origin, null);
  assert.equal(report.DB_ENCRYPTION_KEY.hash, null, 'kein Schluessel im Prozess');
  assert.equal(report.SESSION_SECRET.origin, 'env');
  assert.equal(report.SESSION_SECRET.hash, sha('bestand-secret-aus-der-env-0123456789'));
  assert.equal(existsSync(join(dir, '.secrets')), false, 'kein .secrets-Verzeichnis');
  assert.ok(isPlaintext(dbPath), 'die Datenbank bleibt Klartext');
  assert.equal(marker(dbPath), 'vorher', 'mit ihren Daten');
});

test('Bestand mit Legacy-oikos.db ohne Schluessel: kein Schluessel, die Migration laeuft wie bisher, Klartext bleibt', () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const legacy = join(dir, 'oikos.db');
  seedPlaintext(legacy);

  const report = started(start(dir, { DB_PATH: legacy, SESSION_SECRET: 'bestand-secret-aus-der-env-0123456789' }));
  assert.equal(report.DB_ENCRYPTION_KEY.hash, null, 'die noch nicht migrierte oikos.db bekommt keinen Schluessel');
  assert.equal(report.dbPath, join(dir, 'yuvomi.db'));
  assert.equal(existsSync(legacy), false, 'oikos.db ist umbenannt');
  assert.ok(isPlaintext(join(dir, 'yuvomi.db')), 'und Klartext geblieben');
  assert.equal(marker(join(dir, 'yuvomi.db')), 'vorher');
  assert.equal(existsSync(join(dir, '.secrets', 'DB_ENCRYPTION_KEY')), false);
});

test('eigener DB_PATH: .secrets liegt daneben; eine vorhandene Datei dort bekommt keinen Schluessel', () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const fresh = join(dir, 'neu', 'haushalt.sqlite');
  const report = started(start(dir, { DB_PATH: fresh }));
  assert.equal(report.DB_ENCRYPTION_KEY.path, join(dir, 'neu', '.secrets', 'DB_ENCRYPTION_KEY'));
  assert.ok(!isPlaintext(fresh), 'neu: verschluesselt');

  const existing = join(dir, 'alt', 'haushalt.sqlite');
  mkdirSync(join(dir, 'alt'));
  seedPlaintext(existing);
  const bestand = started(start(dir, { DB_PATH: existing, SESSION_SECRET: 'bestand-secret-aus-der-env-0123456789' }));
  assert.equal(bestand.DB_ENCRYPTION_KEY.hash, null);
  assert.ok(isPlaintext(existing));
  assert.equal(existsSync(join(dir, 'alt', '.secrets')), false);
});

test(':memory: legt keine Datei an, SESSION_SECRET gilt nur fuer diesen Lauf', () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const report = started(start(dir, { DB_PATH: ':memory:' }));
  assert.equal(report.SESSION_SECRET.origin, 'generated');
  assert.equal(report.SESSION_SECRET.path, null);
  assert.equal(report.DB_ENCRYPTION_KEY.hash, null, 'kein Schluessel ohne Datei');
  assert.deepEqual(readdirSync(dir), [], 'im Arbeitsverzeichnis entsteht nichts');
});

test('ausdruecklich gesetzt oder per _FILE: keine gespeicherte Datei', () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const keyFile = join(dir, 'db-key');
  writeFileSync(keyFile, 'schluessel-aus-der-datei-0123456789\n', { mode: 0o600 });
  const report = started(start(dir, {
    DB_PATH: join(dir, 'data', 'yuvomi.db'),
    SESSION_SECRET: 'ausdruecklich-gesetzt-0123456789abcdef',
    DB_ENCRYPTION_KEY_FILE: keyFile,
  }));
  assert.equal(report.SESSION_SECRET.origin, 'env');
  assert.equal(report.DB_ENCRYPTION_KEY.origin, 'file');
  assert.equal(report.DB_ENCRYPTION_KEY.hash, sha('schluessel-aus-der-datei-0123456789'));
  assert.equal(existsSync(join(dir, 'data', '.secrets')), false);
});

test('ausdruecklich gesetzt UND gespeicherte Datei: der ausdrueckliche Wert gilt, das Log nennt Name und Pfad', () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const dbPath = join(dir, 'yuvomi.db');
  started(start(dir, { DB_PATH: dbPath, DB_ENCRYPTION_AUTO_KEY: 'false' }));
  const gespeichert = stored(dir, 'SESSION_SECRET');

  const run = start(dir, { DB_PATH: dbPath, SESSION_SECRET: 'der-ausdrueckliche-wert-0123456789' });
  const report = started(run);
  assert.equal(report.SESSION_SECRET.origin, 'env');
  assert.equal(report.SESSION_SECRET.hash, sha('der-ausdrueckliche-wert-0123456789'));
  assert.match(run.output, new RegExp(`SESSION_SECRET is set in the environment, so ${join(dir, '.secrets', 'SESSION_SECRET')} is not used`));
  assert.ok(!run.output.includes(gespeichert), 'kein gespeicherter Wert im Log');
  assert.ok(!run.output.includes('der-ausdrueckliche-wert-0123456789'), 'kein ausdruecklicher Wert im Log');
  assert.equal(stored(dir, 'SESSION_SECRET'), gespeichert, 'die gespeicherte Datei bleibt unberuehrt');
});

test('ein Platzhalter bricht weiter ab, auch neben einer gespeicherten Datei', () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const dbPath = join(dir, 'yuvomi.db');
  started(start(dir, { DB_PATH: dbPath }));

  const session = start(dir, { DB_PATH: dbPath, SESSION_SECRET: 'REPLACE_WITH_A_LONG_RANDOM_STRING' });
  assert.notEqual(session.status, 0);
  assert.match(session.output, /SESSION_SECRET is still the placeholder/);

  const fresh = tempDir('yuvomi-auto-secrets-');
  const key = start(fresh, { DB_PATH: join(fresh, 'yuvomi.db'), DB_ENCRYPTION_KEY: 'REPLACE_WITH_A_STRONG_ENCRYPTION_KEY' });
  assert.notEqual(key.status, 0);
  assert.match(key.output, /DB_ENCRYPTION_KEY is still the placeholder/);
  assert.equal(existsSync(join(fresh, '.secrets', 'DB_ENCRYPTION_KEY')), false, 'kein Schluessel neben dem Platzhalter');
});

test('der Rat der Platzhalter-Meldung traegt: Zeile weg verschluesselt, der Schalter nicht', () => {
  // Bis zu den Auto-Secrets hiess es "clear the line to run without encryption" -
  // seitdem erzeugt genau das auf einer Neuinstallation einen Schluessel.
  const fresh = tempDir('yuvomi-auto-secrets-');
  const key = start(fresh, { DB_PATH: join(fresh, 'yuvomi.db'), DB_ENCRYPTION_KEY: 'REPLACE_WITH_A_STRONG_ENCRYPTION_KEY' });
  assert.notEqual(key.status, 0);
  assert.doesNotMatch(key.output, /clear the line entirely to run without encryption/);
  assert.match(key.output, /delete the line/);
  assert.match(key.output, /DB_ENCRYPTION_AUTO_KEY=false/);

  // Beide Wege befolgt, je auf einem leeren Stand.
  started(start(fresh, { DB_PATH: join(fresh, 'yuvomi.db') }));
  assert.ok(!isPlaintext(join(fresh, 'yuvomi.db')), 'Zeile geloescht: die neue Datenbank ist verschluesselt');
  const plain = tempDir('yuvomi-auto-secrets-');
  started(start(plain, { DB_PATH: join(plain, 'yuvomi.db'), DB_ENCRYPTION_AUTO_KEY: 'false' }));
  assert.ok(isPlaintext(join(plain, 'yuvomi.db')), 'mit DB_ENCRYPTION_AUTO_KEY=false bleibt sie Klartext');
});

test('eine leere gespeicherte Datei bricht ab, statt still neu zu erzeugen', () => {
  for (const name of NAMES) {
    const dir = tempDir('yuvomi-auto-secrets-');
    mkdirSync(join(dir, '.secrets'), { mode: 0o700 });
    writeFileSync(join(dir, '.secrets', name), '\n', { mode: 0o600 });
    const run = start(dir, { DB_PATH: join(dir, 'yuvomi.db') });
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, new RegExp(`${join(dir, '.secrets', name)} is empty`), name);
    assert.equal(readFileSync(join(dir, '.secrets', name), 'utf8'), '\n', `${name}: die Datei bleibt, wie sie war`);
    assert.equal(existsSync(join(dir, 'yuvomi.db')), false, `${name}: keine Datenbank entsteht`);
  }
});

test('eine unlesbare gespeicherte Datei bricht ab', { skip: RUNS_AS_ROOT && 'root liest jede Datei' }, () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  mkdirSync(join(dir, '.secrets'), { mode: 0o700 });
  writeFileSync(join(dir, '.secrets', 'DB_ENCRYPTION_KEY'), 'irgendein-schluessel\n', { mode: 0o000 });
  try {
    const run = start(dir, { DB_PATH: join(dir, 'yuvomi.db') });
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /DB_ENCRYPTION_KEY is stored in .+, which cannot be read \(EACCES\)/);
    assert.ok(!run.output.includes('irgendein-schluessel'));
  } finally {
    chmodSync(join(dir, '.secrets', 'DB_ENCRYPTION_KEY'), 0o600);
  }
});

test('DB_ENCRYPTION_AUTO_KEY=false: kein Schluessel entsteht, eine vorhandene Datei wird gelesen', () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const dbPath = join(dir, 'yuvomi.db');
  const report = started(start(dir, { DB_PATH: dbPath, DB_ENCRYPTION_AUTO_KEY: 'false' }));
  assert.equal(report.DB_ENCRYPTION_KEY.hash, null);
  assert.equal(report.SESSION_SECRET.origin, 'generated', 'SESSION_SECRET hat keinen Schalter');
  assert.equal(existsSync(join(dir, '.secrets', 'DB_ENCRYPTION_KEY')), false);
  assert.ok(isPlaintext(dbPath), 'bewusst unverschluesselt');

  const withKey = tempDir('yuvomi-auto-secrets-');
  started(start(withKey, { DB_PATH: join(withKey, 'yuvomi.db') }));
  const again = started(start(withKey, { DB_PATH: join(withKey, 'yuvomi.db'), DB_ENCRYPTION_AUTO_KEY: 'false' }));
  assert.equal(again.DB_ENCRYPTION_KEY.origin, 'stored', 'der Schalter sperrt die vorhandene Datenbank nicht aus');
  assert.equal(again.DB_ENCRYPTION_KEY.hash, sha(stored(withKey, 'DB_ENCRYPTION_KEY')));
});

test('verschluesselte Datenbank ohne Schluessel: klarer Abbruch mit dem .secrets-Pfad, kein neuer Schluessel', () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const dbPath = join(dir, 'yuvomi.db');
  started(start(dir, { DB_PATH: dbPath }));
  const keyPath = join(dir, '.secrets', 'DB_ENCRYPTION_KEY');
  rmSync(keyPath);

  const run = start(dir, { DB_PATH: dbPath });
  assert.notEqual(run.status, 0);
  assert.ok(run.output.includes(`${dbPath} is encrypted, but no DB_ENCRYPTION_KEY is set`), run.output);
  assert.ok(run.output.includes(keyPath), 'die Meldung nennt den Pfad der gespeicherten Datei');
  assert.equal(existsSync(keyPath), false, 'es entsteht kein neuer Schluessel');
  assert.ok(!isPlaintext(dbPath), 'die Datenbank bleibt unberuehrt');
});

/** `node server/check-backup.js <backup>` wie im dokumentierten Compose-Restore. */
function checkBackup(cwd, backupPath, env) {
  const run = spawnSync(process.execPath, [join(ROOT, 'server/check-backup.js'), backupPath], {
    cwd, env: cleanEnv(env), encoding: 'utf8', timeout: 60_000,
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

test('check-backup liest den gespeicherten Schluessel, wie der Server ihn liest', () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const dbPath = join(dir, 'yuvomi.db');
  started(start(dir, { DB_PATH: dbPath }));
  const backupPath = join(tempDir('yuvomi-auto-secrets-backup-'), 'backup.db');
  writeFileSync(backupPath, readFileSync(dbPath));
  assert.ok(!isPlaintext(backupPath), 'das Backup traegt den erzeugten Schluessel');

  const run = checkBackup(dir, backupPath, { DB_PATH: dbPath });
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /Backup check passed/);
  assert.ok(!run.output.includes(stored(dir, 'DB_ENCRYPTION_KEY')), 'kein Wert in der Ausgabe');

  // Ein ausdruecklicher Schluessel schlaegt die Datei auch hier.
  const wrong = checkBackup(dir, backupPath, { DB_PATH: dbPath, DB_ENCRYPTION_KEY: 'f'.repeat(64) });
  assert.notEqual(wrong.status, 0, wrong.output);
});

test('check-backup erzeugt nie etwas: kein .secrets, kein Schluessel, keine Datenbank', () => {
  const source = tempDir('yuvomi-auto-secrets-');
  started(start(source, { DB_PATH: join(source, 'yuvomi.db') }));
  const backupPath = join(tempDir('yuvomi-auto-secrets-backup-'), 'backup.db');
  writeFileSync(backupPath, readFileSync(join(source, 'yuvomi.db')));

  // Ein leeres Volume: der Handschlag des Servers gaebe ihm jetzt einen Schluessel.
  const empty = tempDir('yuvomi-auto-secrets-');
  const run = checkBackup(empty, backupPath, { DB_PATH: join(empty, 'yuvomi.db') });
  assert.notEqual(run.status, 0, 'ohne Schluessel ist das verschluesselte Backup nicht lesbar');
  assert.deepEqual(readdirSync(empty), [], `nichts angelegt: ${readdirSync(empty).join(', ')}`);
});

/**
 * Der Backup-Befehl, den Admin -> Backups und docs/installation.md zeigen
 * (`docker compose exec yuvomi node ...`), als `node ...`-Teil. Beide Stellen
 * muessen denselben Befehl zeigen; gelesen wird er aus der Quelle, nicht
 * abgeschrieben, sonst bliebe der Test gruen ueber einem kaputten Snippet.
 */
function documentedBackupCommand() {
  const pick = (text, where) => {
    const line = text.split('\n')
      .find((l) => l.startsWith('docker compose exec yuvomi node ') && l.includes('backupToFile'));
    assert.ok(line, `${where}: kein Backup-Befehl gefunden`);
    return line.replace('docker compose exec yuvomi ', '').replaceAll('&gt;', '>');
  };
  const ui = pick(readFileSync(join(ROOT, 'public/settings/pages/admin-backup.js'), 'utf8')
    .replace(/^.*<code>/gm, ''), 'admin-backup.js');
  const doc = pick(readFileSync(join(ROOT, 'docs/installation.md'), 'utf8'), 'docs/installation.md');
  assert.equal(ui, doc, 'UI und Doku zeigen denselben Backup-Befehl');
  return ui;
}

/** Der Befehl in einer Shell wie im Container (cwd = App-Verzeichnis), Ziel umgebogen. */
function runBackupCommand(target, env) {
  // Node und Ziel kommen als Umgebungsvariablen in die Shell, nicht in den
  // Befehlstext: ein Pfad mit Leerzeichen oder Quote zerlegte ihn sonst.
  const cmd = documentedBackupCommand()
    .replace(/^node /, '"$NODE_BIN" ')
    .replace("'/data/yuvomi-backup.db'", 'process.env.BACKUP_TARGET');
  const run = spawnSync('sh', ['-c', cmd], {
    cwd: ROOT,
    env: cleanEnv({ ...env, NODE_BIN: process.execPath, BACKUP_TARGET: target }),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

test('der dokumentierte Backup-Befehl findet den gespeicherten Schluessel', () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const dbPath = join(dir, 'yuvomi.db');
  started(start(dir, { DB_PATH: dbPath }));
  const target = join(tempDir('yuvomi-auto-secrets-backup-'), 'backup.db');

  const run = runBackupCommand(target, { DB_PATH: dbPath, LOG_LEVEL: 'warn' });
  assert.equal(run.status, 0, run.output);
  assert.ok(existsSync(target), 'das Backup liegt da');
  assert.ok(!isPlaintext(target), 'das Backup ist verschluesselt');
  assert.ok(!run.output.includes(stored(dir, 'DB_ENCRYPTION_KEY')), 'kein Wert in der Ausgabe');
  const check = checkBackup(dir, target, { DB_PATH: dbPath });
  assert.equal(check.status, 0, `mit dem gespeicherten Schluessel lesbar: ${check.output}`);
});

test('der dokumentierte Backup-Befehl liest DB_ENCRYPTION_KEY_FILE', () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const dbPath = join(dir, 'yuvomi.db');
  const keyFile = join(tempDir('yuvomi-auto-secrets-key-'), 'key');
  writeFileSync(keyFile, `${'a'.repeat(64)}\n`, { mode: 0o400 });
  const env = { DB_PATH: dbPath, DB_ENCRYPTION_KEY_FILE: keyFile, SESSION_SECRET: 'b'.repeat(64) };
  started(start(dir, env));
  const target = join(tempDir('yuvomi-auto-secrets-backup-'), 'backup.db');

  const run = runBackupCommand(target, { ...env, LOG_LEVEL: 'warn' });
  assert.equal(run.status, 0, run.output);
  assert.ok(!isPlaintext(target), 'das Backup ist verschluesselt');
});

test('der dokumentierte Backup-Befehl erzeugt nie einen Schluessel', () => {
  // Leeres Volume (falsch eingehaengt): der volle Handschlag gaebe ihm jetzt
  // einen Schluessel, und das Backup truege einen, den niemand kennt.
  const empty = tempDir('yuvomi-auto-secrets-');
  const target = join(tempDir('yuvomi-auto-secrets-backup-'), 'backup.db');
  runBackupCommand(target, { DB_PATH: join(empty, 'yuvomi.db'), LOG_LEVEL: 'warn' });
  assert.equal(existsSync(join(empty, '.secrets')), false, 'kein .secrets angelegt');
});

test('zwei gleichzeitige Erststarts einigen sich auf dieselben Werte', async () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const probe = `
    import { createHash } from 'node:crypto';
    await import(${url('server/utils/load-file-secrets.js')});
    const h = (v) => createHash('sha256').update(v).digest('hex');
    process.stdout.write(h(process.env.SESSION_SECRET) + ' ' + h(process.env.DB_ENCRYPTION_KEY));
  `;
  const once = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: dir, env: cleanEnv({ DB_PATH: join(dir, 'yuvomi.db'), LOG_LEVEL: 'error' }),
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
  });
  const [a, b] = await Promise.all([once(), once()]);
  assert.equal(a.code, 0, a.out);
  assert.equal(b.code, 0, b.out);
  assert.equal(a.out, b.out, 'beide Prozesse benutzen denselben gespeicherten Wert');
  assert.equal(a.out, `${sha(stored(dir, 'SESSION_SECRET'))} ${sha(stored(dir, 'DB_ENCRYPTION_KEY'))}`);
});

test('ein echter Serverstart schreibt keinen Secret-Wert nach stdout oder stderr', async () => {
  const dir = tempDir('yuvomi-auto-secrets-');
  const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    cwd: dir,
    env: cleanEnv({
      DB_PATH: join(dir, 'yuvomi.db'),
      LOG_LEVEL: 'debug',
      PORT: '0',
      BIND_ADDRESS: '127.0.0.1',
      BACKUP_ENABLED: 'false',
      SESSION_SECURE: 'false',
    }),
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.on('close', resolve));
  const deadline = Date.now() + 60_000;
  while (!/Server running on port/.test(output) && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  await closed;

  assert.match(output, /Server running on port/, output);
  assert.match(output, new RegExp(`Generated DB_ENCRYPTION_KEY for this new installation and stored it in ${join(dir, '.secrets', 'DB_ENCRYPTION_KEY')}`));
  assert.match(output, /Generated SESSION_SECRET and stored it in/);
  for (const name of NAMES) {
    const value = stored(dir, name);
    assert.ok(!output.includes(value), `${name} steht im Log`);
    assert.ok(!output.includes(value.slice(0, 16)), `ein Teil von ${name} steht im Log`);
  }
});

// Ohne harte Links (manche Netzfreigaben) faellt writeStored() auf rename()
// zurueck, und rename() ueberschreibt ein Ziel still. Probe-dann-rename liess
// zwei gleichzeitige Erststarts beide durch: der zweite ersetzte den Schluessel
// des ersten, der mit seinem Wert schon die Datenbank anlegen konnte.
const noLink = () => { throw Object.assign(new Error('link not supported'), { code: 'EPERM' }); };
const readText = (p) => readFileSync(p, 'utf8');

test('ohne harte Links ueberschreibt ein gleichzeitiger Erststart den Schluessel nicht', async () => {
  const secrets = join(tempDir('yuvomi-auto-secrets-race-'), '.secrets');
  mkdirSync(secrets, { mode: 0o700 });
  const file = join(secrets, 'DB_ENCRYPTION_KEY');
  // Der andere Prozess haelt die Sperre und legt seinen Wert gleich ab.
  mkdirSync(`${file}.lock`);
  const other = spawn(process.execPath, ['-e', `setTimeout(() => {
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(`${file}.other`)}, 'anderer\\n');
    fs.renameSync(${JSON.stringify(`${file}.other`)}, ${JSON.stringify(file)});
    fs.rmdirSync(${JSON.stringify(`${file}.lock`)});
  }, 300)`]);
  const exited = once(other, 'exit');
  const value = _writeStoredForTest('DB_ENCRYPTION_KEY', file, 'meiner', readText, noLink);
  await exited;
  assert.equal(value, 'anderer', 'der Verlierer uebernimmt den Wert des Gewinners');
  assert.equal(readText(file), 'anderer\n', 'die Datei des Gewinners bleibt');
  assert.deepEqual(readdirSync(secrets), ['DB_ENCRYPTION_KEY'], 'keine Arbeitsdatei bleibt liegen');
});

test('ohne harte Links legt ein einzelner Erststart den Schluessel per rename ab', () => {
  const secrets = join(tempDir('yuvomi-auto-secrets-rename-'), '.secrets');
  const file = join(secrets, 'SESSION_SECRET');
  const value = _writeStoredForTest('SESSION_SECRET', file, 'meiner', readText, noLink);
  assert.equal(value, 'meiner');
  assert.equal(readText(file), 'meiner\n');
  assert.deepEqual(readdirSync(secrets), ['SESSION_SECRET'], 'Sperre und Arbeitsdatei sind weg');
});

// Ohne DB_PATH liegt .secrets/ in der Projektwurzel, mit Compose unter
// DATA_DIR (./data). Das Dockerfile kopiert den ganzen Build-Kontext: ein Image
// aus einer solchen Arbeitskopie trug sonst Sitzungs-Secret und DB-Schluessel.
test('der Docker-Build-Kontext laesst gespeicherte Secrets und das Datenverzeichnis draussen', () => {
  const lines = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(lines.includes('**/.secrets'), '.dockerignore schliesst .secrets/ in jeder Tiefe aus');
  assert.ok(lines.includes('data/'), '.dockerignore schliesst das Compose-Datenverzeichnis aus');
});
