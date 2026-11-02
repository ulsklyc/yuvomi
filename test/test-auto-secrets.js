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
import { tempDir } from './tmp-dir.js';

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
