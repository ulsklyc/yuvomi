/**
 * Test-Suite: Restore eines Backups aus einer ANDEREN Installation (#1267).
 *
 * Ein Backup traegt die Verschluesselung der Instanz, die es geschrieben hat.
 * Bis hierher liess es sich nur auf einer Instanz mit demselben
 * DB_ENCRYPTION_KEY einspielen, und jeder Weg dorthin endete an einer
 * Shell - auf Umbrel ist der Schluessel fest und gar nicht setzbar. Entschieden
 * (#1267): der Schluessel des Backups wird NUR fuer den Restore angegeben, und
 * die wiederhergestellte Datenbank wird auf den EIGENEN Schluessel der
 * Zielinstanz umgeschluesselt. Der eigene Schluessel bleibt die eine Quelle der
 * Wahrheit; nach dem naechsten Neustart oeffnet `init()` die Datei mit ihm.
 *
 * Gemessen wird am Dateiinhalt, nicht an einer API-Zusage:
 *   - Umschluesseln Schluessel -> Schluessel war im Repo nie erprobt (nur
 *     Klartext -> Schluessel in `encryptPlaintextDatabase()`). Die Datei muss
 *     danach mit dem Zielschluessel aufgehen und mit dem alten NICHT mehr,
 *     und die Daten des Backups muessen drinstehen - auch nach einem Neustart.
 *   - Ein falscher Backup-Schluessel laesst die Zielinstanz unveraendert: weder
 *     ihre Daten noch eine Rollback-Kopie im Datenverzeichnis.
 *   - Eine Instanz OHNE eigenen Schluessel lehnt ab, statt das Backup still auf
 *     Klartext zu entschluesseln.
 *   - Der Schluessel kommt ueber einen Header, nie ueber die Query, und steht
 *     in keiner Antwort.
 *
 * Lauf: npm run test:restore-rekey
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';

const PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'binary');
const KEY_ALT = 'schluessel-der-alten-instanz-0123';
const KEY_NEU = 'schluessel-der-neuen-instanz-4567';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'yuvomi-test-rekey-'));
}

// Vor jedem Import von db.js: ohne wirksames DB_PATH legte der Import eine
// Datenbank im Arbeitsbaum an (test:db-isolation).
process.env.DB_PATH = join(tmpDir(), 'yuvomi.db');
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

let scenario = 0;

/** Frische db.js-Instanz mit Pfad und Key - DB_KEY wird beim Modul-Load gelesen. */
async function bootDb(dbPath, key) {
  process.env.DB_PATH = dbPath;
  if (key === null) delete process.env.DB_ENCRYPTION_KEY;
  else process.env.DB_ENCRYPTION_KEY = key;
  const mod = await import(`../server/db.js?rekey=${++scenario}`);
  mod.init();
  return mod;
}

function isPlaintext(filePath) {
  return readFileSync(filePath).subarray(0, PLAINTEXT_HEADER.length).equals(PLAINTEXT_HEADER);
}

/** Wert der Probe-Tabelle, wenn `key` die Datei oeffnet - sonst der SQLite-Code. */
function probeWith(filePath, key) {
  let handle;
  try {
    handle = new Database(filePath, { readonly: true, fileMustExist: true });
    if (key) {
      handle.pragma("cipher = 'sqlcipher'");
      handle.pragma(`key="x'${Buffer.from(key, 'utf8').toString('hex')}'"`);
    }
    return { note: handle.prepare('SELECT note FROM restore_probe').get()?.note ?? null };
  } catch (err) {
    return { code: err.code };
  } finally {
    handle?.close();
  }
}

/** Ein echtes Backup einer Instanz mit `key`, ueber den Weg, den die App nimmt. */
async function backupWithMarker(key, note) {
  const dir = tmpDir();
  const mod = await bootDb(join(dir, 'quelle.db'), key);
  mod.get().exec('CREATE TABLE restore_probe (note TEXT)');
  mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run(note);
  const backupPath = join(dir, 'backup.db');
  await mod.backupToFile(backupPath);
  mod.get().close();
  return backupPath;
}

/** Zielinstanz mit eigener Probe-Zeile, damit „unveraendert" messbar ist. */
async function targetWithMarker(key, note) {
  const dir = tmpDir();
  const dbPath = join(dir, 'yuvomi.db');
  const mod = await bootDb(dbPath, key);
  mod.get().exec('CREATE TABLE restore_probe (note TEXT)');
  mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run(note);
  return { mod, dir, dbPath };
}

function liveNote(mod) {
  return mod.get().prepare('SELECT note FROM restore_probe').get()?.note;
}

// ---------------------------------------------------------------------------
// restoreFromFile() direkt: die Umschluesselung selbst
// ---------------------------------------------------------------------------

test('Backup mit fremdem Schluessel: mit dem Backup-Schluessel eingespielt und auf den eigenen umgeschluesselt', async () => {
  const backupPath = await backupWithMarker(KEY_ALT, 'aus der alten Instanz');
  assert.equal(probeWith(backupPath, KEY_NEU).code, 'SQLITE_NOTADB', 'Vorbedingung: der eigene Schluessel oeffnet das Backup nicht');

  const { mod, dbPath } = await targetWithMarker(KEY_NEU, 'frische Instanz');
  const result = await mod.restoreFromFile(backupPath, { backupKey: KEY_ALT });

  assert.ok(result.schemaVersion > 0, 'der Restore muss durchlaufen');
  assert.equal(liveNote(mod), 'aus der alten Instanz', 'die laufende Instanz traegt die Daten des Backups');
  mod.get().close();

  assert.ok(!isPlaintext(dbPath), 'die eingespielte Datei liegt verschluesselt auf der Platte, nie im Klartext');
  assert.deepEqual(probeWith(dbPath, KEY_NEU), { note: 'aus der alten Instanz' }, 'der EIGENE Schluessel oeffnet sie');
  assert.equal(probeWith(dbPath, KEY_ALT).code, 'SQLITE_NOTADB', 'der alte Schluessel oeffnet sie nicht mehr');

  // Der Neustart ist der Fall, an dem der Melder ausgesperrt wurde.
  const wieder = await bootDb(dbPath, KEY_NEU);
  assert.equal(liveNote(wieder), 'aus der alten Instanz', 'nach dem Neustart mit dem eigenen Schluessel sind die Daten da');
  wieder.get().close();

  // Nichts Unverschluesseltes und kein Rest des alten Schluessels bleibt liegen.
  const dir = join(dbPath, '..');
  for (const name of readdirSync(dir)) {
    if (name.endsWith('-wal') || name.endsWith('-shm')) continue;
    assert.ok(!isPlaintext(join(dir, name)), `${name} darf keine Klartext-Datenbank sein`);
  }
});

test('der Backup-Schluessel darf auch als Buffer kommen (Bytes aus dem Header, ohne UTF-8-Umweg)', async () => {
  const KEY_UMLAUT = 'schlüssel-mit-ümlaut-0123';
  const backupPath = await backupWithMarker(KEY_UMLAUT, 'umlaut');
  const { mod } = await targetWithMarker(KEY_NEU, 'frisch');
  await mod.restoreFromFile(backupPath, { backupKey: Buffer.from(KEY_UMLAUT, 'utf8') });
  assert.equal(liveNote(mod), 'umlaut');
  mod.get().close();
});

test('falscher Backup-Schluessel: klare Meldung, Zielinstanz unveraendert, keine Rollback-Kopie', async () => {
  const backupPath = await backupWithMarker(KEY_ALT, 'aus der alten Instanz');
  const { mod, dir } = await targetWithMarker(KEY_NEU, 'bleibt stehen');
  const vorher = readdirSync(dir).sort();
  const FALSCH = 'vertippt-0123456789-geheim';

  await assert.rejects(
    () => mod.restoreFromFile(backupPath, { backupKey: FALSCH }),
    (err) => {
      assert.equal(err.reason, 'backup_key_wrong', 'maschinenlesbarer Grund fuer den Dialog');
      assert.match(err.message, /backup key/i, 'die Meldung nennt den Backup-Schluessel');
      assert.match(err.message, /Nothing on this instance was changed/);
      assert.ok(!err.message.includes(FALSCH), 'der Schluessel steht nie in der Meldung');
      return true;
    }
  );
  assert.equal(liveNote(mod), 'bleibt stehen', 'die laufende Datenbank ist dieselbe');
  assert.deepEqual(readdirSync(dir).sort(), vorher, 'im Datenverzeichnis ist nichts dazugekommen');
  mod.get().close();
});

test('Instanz ohne eigenen Schluessel: Restore mit Backup-Schluessel wird abgelehnt, nichts wird entschluesselt', async () => {
  const backupPath = await backupWithMarker(KEY_ALT, 'aus der alten Instanz');
  const { mod, dir, dbPath } = await targetWithMarker(null, 'klartext-instanz');
  const vorher = readdirSync(dir).sort();

  await assert.rejects(
    () => mod.restoreFromFile(backupPath, { backupKey: KEY_ALT }),
    (err) => {
      assert.equal(err.reason, 'own_key_missing');
      assert.match(err.message, /DB_ENCRYPTION_KEY is not set on this instance/);
      assert.ok(!err.message.includes(KEY_ALT), 'der Schluessel steht nie in der Meldung');
      return true;
    }
  );
  assert.equal(liveNote(mod), 'klartext-instanz');
  assert.deepEqual(readdirSync(dir).sort(), vorher, 'keine Klartextkopie des Backups im Datenverzeichnis');
  assert.ok(isPlaintext(dbPath), 'Vorbedingung bestaetigt: die Instanz laeuft ohne Schluessel');
  mod.get().close();
});

test('ohne Backup-Schluessel meldet ein fremdes Backup den Grund backup_key_required und nennt den Weg', async () => {
  const backupPath = await backupWithMarker(KEY_ALT, 'x');
  const { mod } = await targetWithMarker(KEY_NEU, 'frisch');
  await assert.rejects(
    () => mod.restoreFromFile(backupPath),
    (err) => err.reason === 'backup_key_required' && /backup key/i.test(err.message)
  );
  mod.get().close();
});

test('ein Klartext-Backup mit Backup-Schluessel laeuft wie bisher durch und wird mit dem eigenen verschluesselt', async () => {
  const backupPath = await backupWithMarker(null, 'klartext-backup');
  assert.ok(isPlaintext(backupPath), 'Vorbedingung');
  const { mod, dbPath } = await targetWithMarker(KEY_NEU, 'frisch');
  await mod.restoreFromFile(backupPath, { backupKey: KEY_ALT });
  assert.equal(liveNote(mod), 'klartext-backup');
  mod.get().close();
  assert.deepEqual(probeWith(dbPath, KEY_NEU), { note: 'klartext-backup' });
});

// ---------------------------------------------------------------------------
// Beschaedigte Backups mit dem RICHTIGEN Schluessel (Review-Runde 1 auf #1417)
// ---------------------------------------------------------------------------

const sha256 = (filePath) => createHash('sha256').update(readFileSync(filePath)).digest('hex');
const PAGE = 4096;

/** Ein Backup mit genug Seiten, dass Seite 5 zu den Daten gehoert. */
async function bigBackup(key) {
  const dir = tmpDir();
  const mod = await bootDb(join(dir, 'quelle.db'), key);
  mod.get().exec('CREATE TABLE restore_probe (note TEXT)');
  const insert = mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)');
  for (let i = 0; i < 400; i++) insert.run(`${'x'.repeat(200)}-${i}`);
  const backupPath = join(dir, 'backup.db');
  await mod.backupToFile(backupPath);
  mod.get().close();
  return backupPath;
}

/** Zielinstanz, deren Datei nach dem Checkpoint per Hash festgehalten wird. */
async function frozenTarget() {
  const target = await targetWithMarker(KEY_NEU, 'bleibt stehen');
  target.mod.get().pragma('wal_checkpoint(TRUNCATE)');
  target.hash = sha256(target.dbPath);
  target.names = readdirSync(target.dir).sort();
  return target;
}

function assertUntouched(target) {
  assert.equal(liveNote(target.mod), 'bleibt stehen', 'die laufende Datenbank ist dieselbe');
  target.mod.get().pragma('wal_checkpoint(TRUNCATE)');
  assert.equal(sha256(target.dbPath), target.hash, 'die Datei der Zielinstanz ist Byte fuer Byte unveraendert');
  assert.deepEqual(readdirSync(target.dir).sort(), target.names, 'im Datenverzeichnis ist nichts dazugekommen');
}

test('richtiger Schluessel, abgeschnittene Datei: backup_damaged, Zielinstanz unveraendert', async () => {
  const backupPath = await bigBackup(KEY_ALT);
  const kurz = join(tmpDir(), 'kurz.db');
  const buf = readFileSync(backupPath);
  writeFileSync(kurz, buf.subarray(0, Math.floor(buf.length / 2)));
  const target = await frozenTarget();

  await assert.rejects(
    () => target.mod.restoreFromFile(kurz, { backupKey: KEY_ALT }),
    (err) => err.reason === 'backup_damaged' && /The backup key is right/.test(err.message)
  );
  assertUntouched(target);
  target.mod.get().close();
});

test('richtiger Schluessel, gekipptes Byte in Seite 5: backup_damaged statt Fehler ohne Grund', async () => {
  // Gemessen: Seite 1 entschluesselt, `SELECT ... sqlite_master` besteht, erst
  // das Umschluesseln liest Seite 5 und scheitert an deren HMAC. Vor dem Fix
  // kam das als nacktes SQLITE_CORRUPT ohne `reason` heraus, und der Dialog
  // leerte das Feld mit dem richtigen Schluessel.
  const backupPath = await bigBackup(KEY_ALT);
  const kaputt = join(tmpDir(), 'kaputt.db');
  const buf = Buffer.from(readFileSync(backupPath));
  buf[4 * PAGE + 100] ^= 0xff;
  writeFileSync(kaputt, buf);
  const target = await frozenTarget();

  await assert.rejects(
    () => target.mod.restoreFromFile(kaputt, { backupKey: KEY_ALT }),
    (err) => {
      assert.equal(err.reason, 'backup_damaged', `Grund fehlt oder falsch: ${err.code} ${err.message}`);
      assert.ok(!/could not be decrypted with the backup key/.test(err.message), 'der Schluessel stimmt - nie „falscher Schluessel"');
      return true;
    }
  );
  assertUntouched(target);
  target.mod.get().close();
});

test(
  'richtiger Schluessel, Backup nicht lesbar: backup_unreadable, Zielinstanz unveraendert',
  { skip: process.getuid?.() === 0 && 'root ignoriert Dateirechte' },
  async () => {
    const backupPath = await bigBackup(KEY_ALT);
    chmodSync(backupPath, 0o000);
    const target = await frozenTarget();
    try {
      await assert.rejects(
        () => target.mod.restoreFromFile(backupPath, { backupKey: KEY_ALT }),
        (err) => err.reason === 'backup_unreadable' && /Nothing on this instance was changed/.test(err.message)
          && !/(\b[A-Z_]{3,}): \1:/.test(err.message)
      );
      assertUntouched(target);
    } finally {
      chmodSync(backupPath, 0o600);
      target.mod.get().close();
    }
  }
);

test('ein Backup DIESER Installation mit mitgeschicktem Schluessel laeuft den normalen Weg', async () => {
  // Ein API-Client, der den Header immer schickt: der eigene Schluessel
  // oeffnet das Backup, also ist der Backup-Schluessel gar nicht gefragt.
  const backupPath = await backupWithMarker(KEY_NEU, 'eigenes Backup');
  const { mod } = await targetWithMarker(KEY_NEU, 'vorher');
  await mod.restoreFromFile(backupPath, { backupKey: 'irgendein-anderer-schluessel-00' });
  assert.equal(liveNote(mod), 'eigenes Backup');
  mod.get().close();
});

test('nach jedem Restore mit Backup-Schluessel bleibt kein Arbeitsverzeichnis im Temp liegen', async () => {
  const prod = () => new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('yuvomi-rekey-')));
  const vorher = prod();

  const gut = await backupWithMarker(KEY_ALT, 'gut');
  const { mod } = await targetWithMarker(KEY_NEU, 'x');
  await mod.restoreFromFile(gut, { backupKey: KEY_ALT });
  await assert.rejects(() => mod.restoreFromFile(gut, { backupKey: 'falsch-0123456789' }));
  const kaputt = join(tmpDir(), 'kaputt.db');
  const buf = Buffer.from(readFileSync(await bigBackup(KEY_ALT)));
  buf[4 * PAGE + 100] ^= 0xff;
  writeFileSync(kaputt, buf);
  await assert.rejects(() => mod.restoreFromFile(kaputt, { backupKey: KEY_ALT }));
  mod.get().close();

  const uebrig = [...prod()].filter((name) => !vorher.has(name));
  assert.deepEqual(uebrig, [], 'Erfolg, falscher Schluessel und beschaedigte Datei raeumen ihr Arbeitsverzeichnis weg');
});

// ---------------------------------------------------------------------------
// Die echte Route: Header statt Query, nichts vom Schluessel in der Antwort
// ---------------------------------------------------------------------------

const ROUTE_KEY = 'schluessel-dieser-instanz-route-89';
let routeInstance = null;

async function restoreRoute() {
  if (routeInstance) return routeInstance;
  process.env.DB_PATH = join(tmpDir(), 'yuvomi.db');
  process.env.DB_ENCRYPTION_KEY = ROUTE_KEY;
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.startsWith('REPLACE_WITH_')) {
    process.env.SESSION_SECRET = 'test-secret-restore-rekey';
  }
  const db = await import('../server/db.js');
  const { default: router } = await import('../server/routes/backup.js');
  const { default: express } = await import('express');
  const app = express();
  app.use((req, _res, next) => {
    req.authUserId = 1;
    req.authRole = 'admin';
    req.session = { userId: 1, role: 'admin' };
    next();
  });
  app.use('/', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  db.get().exec('CREATE TABLE IF NOT EXISTS restore_probe (note TEXT)');
  routeInstance = {
    db,
    server,
    async restore(buf, { headers = {}, query = '' } = {}) {
      const res = await fetch(`${base}/restore${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...headers },
        body: buf,
      });
      const text = await res.text();
      return { status: res.status, text, body: JSON.parse(text) };
    },
  };
  return routeInstance;
}

after(() => routeInstance?.server.close());

const b64 = (key) => Buffer.from(key, 'utf8').toString('base64');

function setLive(route, note) {
  route.db.get().exec('DELETE FROM restore_probe');
  route.db.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run(note);
}

test('Route: der Backup-Schluessel im Header X-Backup-Key (Base64) spielt ein fremdes Backup ein', async () => {
  const backupPath = await backupWithMarker(KEY_ALT, 'ueber die Route');
  const route = await restoreRoute();
  setLive(route, 'vorher');

  const res = await route.restore(readFileSync(backupPath), { headers: { 'X-Backup-Key': b64(KEY_ALT) } });
  assert.equal(res.status, 200, res.text);
  assert.equal(route.db.get().prepare('SELECT note FROM restore_probe').get().note, 'ueber die Route');
  assert.deepEqual(probeWith(route.db.getPath(), ROUTE_KEY), { note: 'ueber die Route' }, 'auf der Platte mit dem Schluessel DIESER Instanz');
});

test('Route: ohne Header meldet sie backup_key_required, ein Schluessel in der Query wird nie gelesen', async () => {
  const backupPath = await backupWithMarker(KEY_ALT, 'nie eingespielt');
  const route = await restoreRoute();
  setLive(route, 'bleibt');

  const ohne = await route.restore(readFileSync(backupPath));
  assert.equal(ohne.status, 400);
  assert.equal(ohne.body.reason, 'backup_key_required');

  const query = await route.restore(readFileSync(backupPath), {
    query: `?backupKey=${encodeURIComponent(KEY_ALT)}&backup_key=${encodeURIComponent(b64(KEY_ALT))}&key=${encodeURIComponent(KEY_ALT)}`,
  });
  assert.equal(query.status, 400, 'ein Schluessel in der URL darf den Restore nicht tragen');
  assert.equal(query.body.reason, 'backup_key_required');
  assert.equal(route.db.get().prepare('SELECT note FROM restore_probe').get().note, 'bleibt');
});

test('Route: falscher Backup-Schluessel ergibt 400 backup_key_wrong ohne den Schluessel in der Antwort', async () => {
  const backupPath = await backupWithMarker(KEY_ALT, 'nie eingespielt');
  const route = await restoreRoute();
  setLive(route, 'unberuehrt');
  const FALSCH = 'falscher-schluessel-route-0123';

  const res = await route.restore(readFileSync(backupPath), { headers: { 'X-Backup-Key': b64(FALSCH) } });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'backup_key_wrong');
  assert.ok(!res.text.includes(FALSCH) && !res.text.includes(b64(FALSCH)), 'weder Klartext noch Base64 des Schluessels in der Antwort');
  assert.equal(route.db.get().prepare('SELECT note FROM restore_probe').get().note, 'unberuehrt');
});

test('Route: ein Header, der kein Base64 ist, wird abgewiesen statt als Schluessel benutzt', async () => {
  const backupPath = await backupWithMarker(KEY_ALT, 'nie eingespielt');
  const route = await restoreRoute();
  setLive(route, 'unberuehrt');

  const res = await route.restore(readFileSync(backupPath), { headers: { 'X-Backup-Key': 'kein base64!' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'backup_key_invalid');
  assert.ok(!res.text.includes('kein base64!'));
  assert.equal(route.db.get().prepare('SELECT note FROM restore_probe').get().note, 'unberuehrt');
});

// ---------------------------------------------------------------------------
// CLI: der Schluessel ueber stdin, nie als Argument (Prozessliste)
// ---------------------------------------------------------------------------

const RESTORE_CLI = fileURLToPath(new URL('../scripts/restore-backup.js', import.meta.url));

test('CLI: --backup-key-stdin liest den Backup-Schluessel von stdin und schluesselt um', async () => {
  const backupPath = await backupWithMarker(KEY_ALT, 'ueber das CLI');
  const dbPath = join(tmpDir(), 'yuvomi.db');
  const env = { ...process.env, DB_PATH: dbPath, DB_ENCRYPTION_KEY: KEY_NEU, LOG_LEVEL: 'error' };

  const run = spawnSync(process.execPath, [RESTORE_CLI, backupPath, '--backup-key-stdin'], {
    cwd: tmpDir(), env, input: `${KEY_ALT}\n`, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!`${run.stdout}${run.stderr}`.includes(KEY_ALT), 'der Schluessel wird nicht ausgegeben');
  assert.deepEqual(probeWith(dbPath, KEY_NEU), { note: 'ueber das CLI' });
});
