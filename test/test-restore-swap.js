/**
 * Test-Suite: Restore tauscht die Datenbank unteilbar ein und spielt keine
 * beschaedigte Datei ein (#1422).
 *
 * Zwei Luecken im selben Codepfad:
 *   - Das Backup wurde direkt ueber `DB_PATH` kopiert. Starb der Prozess
 *     mittendrin, lag dort eine halb geschriebene Datei, und der naechste
 *     Start fand eine kaputte Datenbank. Jetzt entsteht die Kopie neben
 *     `DB_PATH` und wird per `rename()` eingehaengt: `DB_PATH` ist zu jedem
 *     Zeitpunkt die alte oder die neue Datenbank, nie eine Mischung.
 *   - Die Validierung las nur `sqlite_master`. Ein EIGENES Backup mit einer
 *     kaputten Seite dahinter ging ohne Fehler durch; nur der Weg mit
 *     Backup-Schluessel lehnte es ab, weil das Umschluesseln jede Seite liest.
 *     Jetzt prueft `quick_check` jede Seite und bricht mit `backup_corrupt` ab.
 *
 * Der Abbruch wird nicht nachgestellt, sondern herbeigefuehrt: ein Kindprozess
 * schreibt beim Kopieren des Backups die Haelfte und toetet sich dann selbst
 * mit SIGKILL - kein catch, kein Rollback, genau wie ein OOM-Kill oder
 * Stromausfall.
 *
 * Lauf: npm run test:restore-swap
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

const KEY = 'schluessel-dieser-instanz-0123456789';
const PAGE = 4096;
const DB_MODULE = new URL('../server/db.js', import.meta.url).href;

// Vor jedem Import von db.js: ohne wirksames DB_PATH legte der Import eine
// Datenbank im Arbeitsbaum an (test:db-isolation).
process.env.DB_PATH = join(tempDir('yuvomi-test-swap-'), 'yuvomi.db');
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

let scenario = 0;

async function bootDb(dbPath, key) {
  process.env.DB_PATH = dbPath;
  if (key === null) delete process.env.DB_ENCRYPTION_KEY;
  else process.env.DB_ENCRYPTION_KEY = key;
  const mod = await import(`../server/db.js?swap=${++scenario}`);
  mod.init();
  return mod;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function openWith(filePath, key) {
  const handle = new Database(filePath, { fileMustExist: true });
  if (key) {
    handle.pragma("cipher = 'sqlcipher'");
    handle.pragma(`key="x'${Buffer.from(key, 'utf8').toString('hex')}'"`);
  }
  return handle;
}

/** Notiz und quick_check einer Datei - oder der SQLite-Code, an dem sie scheitert. */
function inspect(filePath, key) {
  let handle;
  try {
    handle = openWith(filePath, key);
    return {
      note: handle.prepare('SELECT note FROM restore_probe LIMIT 1').get()?.note ?? null,
      check: handle.pragma('quick_check(1)', { simple: true }),
    };
  } catch (err) {
    return { code: err.code ?? err.message };
  } finally {
    handle?.close();
  }
}

/** Ein echtes Backup mit genug Seiten, dass Seite 5 zu den Daten gehoert. */
async function bigBackup(key, note) {
  const dir = tempDir('yuvomi-test-swap-');
  const mod = await bootDb(join(dir, 'quelle.db'), key);
  mod.get().exec('CREATE TABLE restore_probe (note TEXT)');
  const insert = mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)');
  insert.run(note);
  for (let i = 0; i < 400; i++) insert.run(`${'x'.repeat(200)}-${i}`);
  const backupPath = join(dir, 'backup.db');
  await mod.backupToFile(backupPath);
  mod.get().close();
  return backupPath;
}

/** Zielinstanz mit eigener Notiz; die Datei nach dem Checkpoint per Hash festgehalten. */
async function frozenTarget(key, note) {
  const dir = tempDir('yuvomi-test-swap-');
  const dbPath = join(dir, 'yuvomi.db');
  const mod = await bootDb(dbPath, key);
  mod.get().exec('CREATE TABLE restore_probe (note TEXT)');
  mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run(note);
  mod.get().pragma('wal_checkpoint(TRUNCATE)');
  return { mod, dir, dbPath, hash: sha256(dbPath), names: readdirSync(dir).sort() };
}

function assertUntouched(target, note) {
  assert.equal(
    target.mod.get().prepare('SELECT note FROM restore_probe').get()?.note,
    note,
    'die laufende Datenbank ist dieselbe'
  );
  target.mod.get().pragma('wal_checkpoint(TRUNCATE)');
  assert.equal(sha256(target.dbPath), target.hash, 'die Datei der Zielinstanz ist Byte fuer Byte unveraendert');
  assert.deepEqual(readdirSync(target.dir).sort(), target.names, 'im Datenverzeichnis ist nichts dazugekommen');
}

/**
 * Restore in einem Kindprozess, der beim Kopieren des Backups die Haelfte
 * schreibt und sich dann per SIGKILL beendet. Getroffen wird jedes Kopieren,
 * dessen QUELLE das Backup ist - egal wohin es geht: vor #1422 war das Ziel
 * `DB_PATH`, danach die Arbeitsdatei daneben.
 */
const KILL_MID_COPY = `
  import fs from 'node:fs/promises';
  import { readFileSync, writeFileSync } from 'node:fs';
  const backup = process.env.SWAP_BACKUP;
  const realCopyFile = fs.copyFile;
  fs.copyFile = async (src, dest, mode) => {
    if (String(src) === backup) {
      const bytes = readFileSync(src);
      writeFileSync(dest, bytes.subarray(0, Math.floor(bytes.length / 2)));
      process.stdout.write('half-written\\n');
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    }
    return realCopyFile(src, dest, mode);
  };
  const db = await import(process.env.SWAP_DB_MODULE);
  await db.restoreFromFile(backup);
  process.stdout.write('restored\\n');
`;

function restoreKilledMidCopy(backupPath, { dbPath, key }) {
  const env = {
    ...process.env,
    DB_PATH: dbPath,
    LOG_LEVEL: 'error',
    SWAP_BACKUP: backupPath,
    SWAP_DB_MODULE: DB_MODULE,
  };
  if (key) env.DB_ENCRYPTION_KEY = key;
  else delete env.DB_ENCRYPTION_KEY;
  return spawnSync(process.execPath, ['--input-type=module', '-e', KILL_MID_COPY], {
    cwd: tempDir('yuvomi-test-swap-cwd-'), env, encoding: 'utf8',
  });
}

for (const [fall, key] of [['mit Schluessel', KEY], ['ohne Schluessel', null]]) {
  test(`#1422 Restore stirbt mitten im Kopieren (${fall}): DB_PATH ist danach die alte Datenbank, heil`, async () => {
    const backupPath = await bigBackup(key, 'aus dem Backup');
    const target = await frozenTarget(key, 'vor dem Restore');
    target.mod.get().close();

    const run = restoreKilledMidCopy(backupPath, { dbPath: target.dbPath, key });
    assert.equal(run.signal, 'SIGKILL', `der Kindprozess muss am Kopieren gestorben sein: ${run.stderr}`);
    assert.match(run.stdout, /half-written/, 'Vorbedingung: der Abbruch traf das Kopieren des Backups');
    assert.doesNotMatch(run.stdout, /restored/);

    assert.deepEqual(
      inspect(target.dbPath, key),
      { note: 'vor dem Restore', check: 'ok' },
      'DB_PATH muss die alte Datenbank sein, vollstaendig lesbar - keine halbe Kopie des Backups'
    );

    // Der naechste Start kommt hoch und raeumt die halbe Arbeitsdatei weg.
    const mod = await bootDb(target.dbPath, key);
    assert.equal(mod.get().prepare('SELECT note FROM restore_probe').get()?.note, 'vor dem Restore');
    mod.get().close();
    assert.deepEqual(
      readdirSync(target.dir).filter((name) => name.includes('.restore-tmp')),
      [],
      'keine Arbeitsdatei des abgebrochenen Restores bleibt liegen'
    );
  });
}

test('#1422 die Arbeitsdatei entsteht NEBEN DB_PATH und ist nach dem Restore weg', async () => {
  // Nur im selben Verzeichnis ist das Einhaengen ein rename() innerhalb eines
  // Dateisystems. Gemessen am Kindprozess, der beim Kopieren stirbt: die halbe
  // Datei liegt unter dem Arbeitsnamen neben DB_PATH.
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  target.mod.get().close();
  const run = restoreKilledMidCopy(backupPath, { dbPath: target.dbPath, key: KEY });
  assert.equal(run.signal, 'SIGKILL');
  assert.equal(
    readdirSync(target.dir).filter((name) => name.startsWith('yuvomi.db.restore-tmp')).length,
    1,
    `Arbeitsdatei neben DB_PATH erwartet: ${readdirSync(target.dir).join(', ')}`
  );

  // Ein vollstaendiger Restore laesst keine liegen.
  const ziel = await frozenTarget(KEY, 'vor dem Restore');
  const result = await ziel.mod.restoreFromFile(backupPath);
  assert.ok(result.rollbackPath, 'die Rollback-Kopie steht wie bisher');
  assert.equal(ziel.mod.get().prepare('SELECT note FROM restore_probe LIMIT 1').get()?.note, 'aus dem Backup');
  assert.deepEqual(readdirSync(ziel.dir).filter((name) => name.includes('.restore-tmp')), []);
  ziel.mod.get().close();
});

test('#1422 scheitert schon das Kopieren (volle Platte), bleibt die laufende Datenbank offen und unveraendert', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const realCopyFile = fsp.copyFile;
  fsp.copyFile = async (src, dest, mode) => {
    if (String(src) === backupPath) {
      writeFileSync(dest, 'angefangen');
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return realCopyFile(src, dest, mode);
  };
  try {
    await assert.rejects(() => target.mod.restoreFromFile(backupPath), /ENOSPC/);
  } finally {
    fsp.copyFile = realCopyFile;
  }
  assertUntouched(target, 'vor dem Restore');
  target.mod.get().close();
});

// ---------------------------------------------------------------------------
// Beschaedigtes eigenes Backup
// ---------------------------------------------------------------------------

test('#1422 eigenes verschluesseltes Backup mit gekipptem Byte in Seite 5: backup_corrupt, Zielinstanz unveraendert', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const kaputt = join(tempDir('yuvomi-test-swap-'), 'kaputt.db');
  const bytes = Buffer.from(readFileSync(backupPath));
  bytes[4 * PAGE + 100] ^= 0xff;
  writeFileSync(kaputt, bytes);
  const probe = openWith(kaputt, KEY);
  assert.doesNotThrow(
    () => probe.prepare('SELECT count(*) FROM sqlite_master').get(),
    'Vorbedingung: die erste Seite geht mit dem eigenen Schluessel auf - erst eine spaetere ist kaputt'
  );
  probe.close();

  const target = await frozenTarget(KEY, 'vor dem Restore');
  await assert.rejects(
    () => target.mod.restoreFromFile(kaputt),
    (err) => {
      assert.equal(err.reason, 'backup_corrupt', `Grund fehlt oder falsch: ${err.code} ${err.message}`);
      assert.match(err.message, /Nothing on this instance was changed/);
      assert.doesNotMatch(err.message, /\*\*\*/, 'die Kopfzeile von quick_check ist kein Befund');
      return true;
    }
  );
  assertUntouched(target, 'vor dem Restore');
  target.mod.get().close();
});

test('#1422 eigenes Klartext-Backup mit ueberschriebener Seite: backup_corrupt, Zielinstanz unveraendert', async () => {
  const backupPath = await bigBackup(null, 'aus dem Backup');
  const kaputt = join(tempDir('yuvomi-test-swap-'), 'kaputt.db');
  const bytes = Buffer.from(readFileSync(backupPath));
  // Eine Datenseite weit hinten: sqlite_master auf Seite 1 bleibt heil.
  bytes.fill(0x41, bytes.length - 3 * PAGE, bytes.length - 3 * PAGE + 16);
  writeFileSync(kaputt, bytes);

  const target = await frozenTarget(null, 'vor dem Restore');
  await assert.rejects(
    () => target.mod.restoreFromFile(kaputt),
    (err) => err.reason === 'backup_corrupt' && /integrity check found an error/.test(err.message)
  );
  assertUntouched(target, 'vor dem Restore');
  target.mod.get().close();
});

test('#1422 ein heiles eigenes Backup laeuft durch die Pruefung', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  await target.mod.restoreFromFile(backupPath);
  assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe LIMIT 1').get()?.note, 'aus dem Backup');
  assert.equal(target.mod.get().pragma('quick_check(1)', { simple: true }), 'ok');
  target.mod.get().close();
});

// ---------------------------------------------------------------------------
// Review #1431: zwei Restores, Rollback-Kopie, Rollback nach dem Tausch
// ---------------------------------------------------------------------------

test('#1431 ein zweiter Restore waehrend des ersten wird sofort abgelehnt, der erste laeuft sauber durch', async () => {
  // Ohne Riegel teilten sich beide die Arbeitsdatei: der zweite ueberschrieb
  // die halbe Kopie des ersten, und der erste hing eine Mischung an DB_PATH.
  const backupA = await bigBackup(KEY, 'Backup A');
  const backupB = await bigBackup(KEY, 'Backup B');
  const target = await frozenTarget(KEY, 'vor dem Restore');

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const copying = new Promise((resolve) => { reached = resolve; });
  const realCopyFile = fsp.copyFile;
  fsp.copyFile = async (src, dest, mode) => {
    if (String(src) === backupA) {
      reached();
      await gate;
    }
    return realCopyFile(src, dest, mode);
  };
  try {
    const first = target.mod.restoreFromFile(backupA);
    await copying;
    await assert.rejects(
      () => target.mod.restoreFromFile(backupB),
      (err) => err.reason === 'restore_in_progress' && /changed nothing/.test(err.message)
    );
    release();
    await first;
  } finally {
    release();
    fsp.copyFile = realCopyFile;
  }

  assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe LIMIT 1').get()?.note, 'Backup A');
  assert.equal(target.mod.get().pragma('quick_check(1)', { simple: true }), 'ok');
  // Der Riegel ist wieder offen: der naechste Restore laeuft.
  await target.mod.restoreFromFile(backupB);
  assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe LIMIT 1').get()?.note, 'Backup B');
  target.mod.get().close();
});

test('#1431 der Riegel loest sich auch nach einem gescheiterten Restore', async () => {
  const kaputt = join(tempDir('yuvomi-test-swap-'), 'kein-sqlite.db');
  writeFileSync(kaputt, 'das ist keine Datenbank, aber lang genug fuer einen Kopf');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  await assert.rejects(() => target.mod.restoreFromFile(kaputt));
  await assert.rejects(
    () => target.mod.restoreFromFile(kaputt),
    (err) => err.reason !== 'restore_in_progress',
    'der zweite Versuch scheitert an der Datei, nicht am Riegel'
  );
  target.mod.get().close();
});

/** Restore im Kindprozess, der beim Anlegen der ROLLBACK-Kopie die Haelfte schreibt und stirbt. */
const KILL_MID_ROLLBACK_COPY = `
  import fs from 'node:fs/promises';
  import { readFileSync, writeFileSync } from 'node:fs';
  const live = process.env.DB_PATH;
  const realCopyFile = fs.copyFile;
  fs.copyFile = async (src, dest, mode) => {
    if (String(src) === live) {
      const bytes = readFileSync(src);
      writeFileSync(dest, bytes.subarray(0, Math.floor(bytes.length / 2)));
      process.stdout.write('half-written\\n');
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    }
    return realCopyFile(src, dest, mode);
  };
  const db = await import(process.env.SWAP_DB_MODULE);
  await db.restoreFromFile(process.env.SWAP_BACKUP);
  process.stdout.write('restored\\n');
`;

test('#1431 stirbt der Restore beim Anlegen der Rollback-Kopie, liegt unter .pre-restore-* keine abgeschnittene Kopie', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  // Gross genug, dass eine halbe Kopie nicht zufaellig heil aussieht.
  const insert = target.mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)');
  for (let i = 0; i < 400; i++) insert.run(`${'y'.repeat(200)}-${i}`);
  target.mod.get().close();

  const env = {
    ...process.env, DB_PATH: target.dbPath, LOG_LEVEL: 'error', DB_ENCRYPTION_KEY: KEY,
    SWAP_BACKUP: backupPath, SWAP_DB_MODULE: DB_MODULE,
  };
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', KILL_MID_ROLLBACK_COPY], {
    cwd: tempDir('yuvomi-test-swap-cwd-'), env, encoding: 'utf8',
  });
  assert.equal(run.signal, 'SIGKILL', `der Kindprozess muss beim Kopieren gestorben sein: ${run.stderr}`);
  assert.match(run.stdout, /half-written/, 'Vorbedingung: der Abbruch traf die Rollback-Kopie');

  const names = readdirSync(target.dir);
  const rollbacks = names.filter((name) => /\.pre-restore-[^.]+$/.test(name));
  assert.deepEqual(rollbacks, [], `unter dem Rollback-Namen darf keine halbe Kopie liegen: ${names.join(', ')}`);
  assert.deepEqual(inspect(target.dbPath, KEY), { note: 'vor dem Restore', check: 'ok' }, 'DB_PATH ist die alte Datenbank');
});

/** Besteht die Validierung (Tabelle da, Version 1), scheitert aber in init() an den Migrationen. */
function backupThatFailsAfterTheSwap() {
  const pfad = join(tempDir('yuvomi-test-swap-'), 'scheitert.db');
  const handle = new Database(pfad);
  handle.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT ''
  )`);
  handle.prepare('INSERT INTO schema_migrations (version, description) VALUES (1, ?)').run('nur die Tabelle');
  handle.close();
  return pfad;
}

for (const [fall, key] of [['mit Schluessel', KEY], ['ohne Schluessel', null]]) {
  test(`#1431 scheitert init() nach dem Tausch (${fall}), holt der Rollback die alte Datenbank zurueck`, async () => {
    const target = await frozenTarget(key, 'vor dem Restore');
    await assert.rejects(() => target.mod.restoreFromFile(backupThatFailsAfterTheSwap()));

    assert.equal(
      target.mod.get().prepare('SELECT note FROM restore_probe').get()?.note,
      'vor dem Restore',
      'die Instanz laeuft wieder auf der alten Datenbank'
    );
    target.mod.get().pragma('wal_checkpoint(TRUNCATE)');
    assert.equal(sha256(target.dbPath), target.hash, 'DB_PATH ist Byte fuer Byte die alte Datei');
    const names = readdirSync(target.dir);
    assert.deepEqual(
      names.filter((name) => name.includes('.restore-tmp') || name.endsWith('.partial')),
      [],
      `keine Arbeitsdatei bleibt liegen: ${names.join(', ')}`
    );
    assert.equal(names.filter((name) => /\.pre-restore-[^.]+$/.test(name)).length, 1, 'die Rollback-Kopie bleibt stehen');
    target.mod.get().close();
  });
}
