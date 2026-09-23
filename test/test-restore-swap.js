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
import { readFileSync, readdirSync, writeFileSync, chmodSync, copyFileSync, linkSync, symlinkSync, statSync, existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    assert.deepEqual(
      names.filter((name) => name.includes('.pre-restore-')),
      [],
      'die Rollback-Kopie ist per rename zurueck an DB_PATH gegangen, nicht kopiert'
    );
    target.mod.get().close();
  });
}

// ---------------------------------------------------------------------------
// Re-Review #1431: Rollback ohne zweite Kopie, Meldung bei gescheitertem Rollback
// ---------------------------------------------------------------------------

const IS_ROLLBACK_COPY = /\.pre-restore-[^./]+$/;

test('#1431 volle Platte beim Rollback: die alte Datenbank kommt trotzdem zurueck, ohne zweite Kopie', async () => {
  // Scheitert init() nach dem Tausch, liegt die neue Datei noch an DB_PATH.
  // Den Rollback per Kopie traf dann ENOSPC - genau der Fall aus #1422.
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const realCopyFile = fsp.copyFile;
  fsp.copyFile = async (src, dest, mode) => {
    if (IS_ROLLBACK_COPY.test(String(src))) {
      throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
    }
    return realCopyFile(src, dest, mode);
  };
  try {
    await assert.rejects(() => target.mod.restoreFromFile(backupThatFailsAfterTheSwap()));
  } finally {
    fsp.copyFile = realCopyFile;
  }
  assert.equal(
    target.mod.get().prepare('SELECT note FROM restore_probe').get()?.note,
    'vor dem Restore',
    'die Instanz laeuft wieder auf der alten Datenbank'
  );
  target.mod.get().pragma('wal_checkpoint(TRUNCATE)');
  assert.equal(sha256(target.dbPath), target.hash, 'DB_PATH ist Byte fuer Byte die alte Datei');
  target.mod.get().close();
});

test('#1431 scheitert auch der Rollback, sagt die Meldung das und nennt die Rollback-Kopie', async () => {
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const realRename = fsp.rename;
  const realCopyFile = fsp.copyFile;
  // Beide Wege zurueck blockieren: das rename (neu) und die Kopie (vorher).
  fsp.rename = async (from, to) => {
    if (IS_ROLLBACK_COPY.test(String(from))) {
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    }
    return realRename(from, to);
  };
  fsp.copyFile = async (src, dest, mode) => {
    if (IS_ROLLBACK_COPY.test(String(src))) {
      throw Object.assign(new Error('EIO: i/o error, copyfile'), { code: 'EIO' });
    }
    return realCopyFile(src, dest, mode);
  };
  try {
    await assert.rejects(
      () => target.mod.restoreFromFile(backupThatFailsAfterTheSwap()),
      (err) => {
        const rollback = readdirSync(target.dir).find((name) => IS_ROLLBACK_COPY.test(name));
        assert.ok(rollback, 'Vorbedingung: die Rollback-Kopie steht noch');
        assert.match(err.message, /Putting the previous database back failed as well: EIO/);
        assert.ok(err.message.includes(join(target.dir, rollback)), `die Meldung nennt die Rollback-Kopie: ${err.message}`);
        assert.equal(err.reason, undefined, 'ohne reason - kein Dialogtext darf „nichts geaendert" sagen');
        return true;
      }
    );
  } finally {
    fsp.rename = realRename;
    fsp.copyFile = realCopyFile;
  }
});

for (const art of ['Arbeitsdatei', 'halbe Rollback-Kopie']) {
  test(`#1431 der Start raeumt eine ${art} eines toten Prozesses weg, die eines lebenden laesst er liegen`, async () => {
    const dir = tempDir('yuvomi-test-swap-');
    const dbPath = join(dir, 'yuvomi.db');
    // Ein Prozess, der sicher tot ist, und einer, der sicher lebt (der Vater
    // dieses Testprozesses; nicht dieser selbst - den behandelt der Start als eigenen).
    const tot = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const totePid = Number(tot.stdout);
    const lebendePid = process.ppid;
    const name = (pid) => (art === 'Arbeitsdatei'
      ? `yuvomi.db.restore-tmp-${pid}-abc`
      : `yuvomi.db.pre-restore-2026-01-01T00-00-00-000Z.${pid}.partial`);
    writeFileSync(join(dir, name(totePid)), 'rest');
    writeFileSync(join(dir, name(lebendePid)), 'laeuft noch');

    const mod = await bootDb(dbPath, KEY);
    mod.get().close();
    const names = readdirSync(dir);
    assert.ok(!names.includes(name(totePid)), `die Datei des toten Prozesses ist weg: ${names.join(', ')}`);
    assert.ok(names.includes(name(lebendePid)), `die Datei des lebenden Prozesses bleibt: ${names.join(', ')}`);
  });
}

// ---------------------------------------------------------------------------
// Dritte Review-Runde #1431
// ---------------------------------------------------------------------------

test('#1431 scheitert nur das Aufraeumen der Arbeitsdatei, bleibt es beim urspruenglichen Fehler', async () => {
  // Das Kopieren des Backups scheitert (vor dem Tausch), und beim Wegraeumen
  // der Arbeitsdatei kommt EACCES. Die alte Datenbank laeuft weiter - eine
  // Meldung, die von einem gescheiterten Rueckweg oder von Dateien zum
  // Verschieben spricht, waere falsch.
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const realCopyFile = fsp.copyFile;
  const realUnlink = fsp.unlink;
  let stagingUnlinks = 0;
  fsp.copyFile = async (src, dest, mode) => {
    if (String(src) === backupPath) {
      throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
    }
    return realCopyFile(src, dest, mode);
  };
  fsp.unlink = async (filePath) => {
    // Das erste Wegraeumen (vor dem Kopieren) laeuft, das im Fehlerpfad nicht.
    if (String(filePath).includes('.restore-tmp-') && ++stagingUnlinks > 1) {
      throw Object.assign(new Error('EACCES: permission denied, unlink'), { code: 'EACCES' });
    }
    return realUnlink(filePath);
  };
  try {
    await assert.rejects(
      () => target.mod.restoreFromFile(backupPath),
      (err) => {
        assert.match(err.message, /^ENOSPC/, `der urspruengliche Fehler: ${err.message}`);
        assert.doesNotMatch(err.message, /Putting the previous database back|move that file|Restart Yuvomi/);
        return true;
      }
    );
  } finally {
    fsp.copyFile = realCopyFile;
    fsp.unlink = realUnlink;
  }
  assert.ok(stagingUnlinks > 1, 'Vorbedingung: der Fehlerpfad hat die Arbeitsdatei wegraeumen wollen');
  assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe').get()?.note, 'vor dem Restore');
  target.mod.get().close();
});

/** Der `sh -c`-Teil des Compose-Restores aus docs/installation.md. */
function documentedComposeRestore() {
  const doc = readFileSync(new URL('../docs/installation.md', import.meta.url), 'utf8');
  const line = doc.split('\n').find((l) => l.startsWith('docker compose run --rm -v "$BACKUP:/tmp/yuvomi-restore.db:ro"'));
  assert.ok(line, 'installation.md muss den Compose-Restore zeigen');
  const match = line.match(/ -c '([^']+)'$/);
  assert.ok(match, 'der Befehl endet in sh -c \'...\'');
  return match[1];
}

/** Den dokumentierten Befehl hier ausfuehren - mit echtem sh, cp, mv, sync. */
function runComposeRestore(backupPath, dbPath, { killMidCopy = false, refuseChmod = false } = {}) {
  const script = documentedComposeRestore().replaceAll('/tmp/yuvomi-restore.db', backupPath);
  const env = { ...process.env, DB_PATH: dbPath };
  if (refuseChmod) {
    // Ein Daten-Mount, der chmod ablehnt (SMB/FUSE auf einem NAS).
    const shimDir = tempDir('yuvomi-test-swap-chmod-');
    writeFileSync(join(shimDir, 'chmod'), '#!/bin/sh\necho "chmod: Operation not permitted" >&2\nexit 1\n');
    chmodSync(join(shimDir, 'chmod'), 0o755);
    env.PATH = `${shimDir}:${process.env.PATH}`;
  }
  if (killMidCopy) {
    // Ein cp, das beim Kopieren des Backups die Haelfte schreibt und dann die
    // Shell mit SIGKILL beendet - wie ein Container, der mittendrin stirbt.
    const shimDir = tempDir('yuvomi-test-swap-shim-');
    const shim = join(shimDir, 'cp');
    writeFileSync(shim, [
      '#!/bin/sh',
      'if [ "$1" = "$SWAP_BACKUP" ]; then',
      '  size=$(wc -c < "$1")',
      '  head -c $((size / 2)) "$1" > "$2"',
      '  kill -9 $PPID',
      '  exit 1',
      'fi',
      'PATH="$SWAP_ORIG_PATH" exec cp "$@"',
      '',
    ].join('\n'));
    chmodSync(shim, 0o755);
    env.SWAP_ORIG_PATH = process.env.PATH;
    env.PATH = `${shimDir}:${process.env.PATH}`;
    env.SWAP_BACKUP = backupPath;
  }
  env.LOG_LEVEL = 'error';
  // Wie im Container (WORKDIR /app): der Befehl ruft `node server/check-backup.js`.
  return spawnSync('/bin/sh', ['-c', script], { env, encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) });
}

test('#1431 der dokumentierte Compose-Restore: stirbt er mitten im Kopieren, bleibt die alte Datenbank heil', async () => {
  const backupPath = await bigBackup(null, 'aus dem Backup');
  const target = await frozenTarget(null, 'vor dem Restore');
  target.mod.get().close();

  const run = runComposeRestore(backupPath, target.dbPath, { killMidCopy: true });
  assert.equal(run.signal, 'SIGKILL', `die Shell muss am Kopieren gestorben sein: ${run.stderr}`);
  assert.deepEqual(
    inspect(target.dbPath, null),
    { note: 'vor dem Restore', check: 'ok' },
    'DB_PATH muss die alte Datenbank sein - keine halbe Kopie des Backups'
  );

  // Der naechste Start raeumt den Rest des Befehls weg.
  const mod = await bootDb(target.dbPath, null);
  assert.equal(mod.get().prepare('SELECT note FROM restore_probe').get()?.note, 'vor dem Restore');
  mod.get().close();
  assert.deepEqual(
    readdirSync(target.dir).filter((name) => name.includes('.restore-tmp') || name.endsWith('.partial')),
    [],
    'kein Rest des abgebrochenen Befehls bleibt liegen'
  );
});

test('#1431 der dokumentierte Compose-Restore: ein vollstaendiger Lauf tauscht ein und behaelt die Rollback-Kopie', async () => {
  const backupPath = await bigBackup(null, 'aus dem Backup');
  const target = await frozenTarget(null, 'vor dem Restore');
  target.mod.get().close();

  const run = runComposeRestore(backupPath, target.dbPath);
  assert.equal(run.status, 0, `der Befehl muss gelingen: ${run.stderr}`);
  assert.equal(sha256(target.dbPath), sha256(backupPath), 'DB_PATH ist das Backup');
  const names = readdirSync(target.dir);
  const rollbacks = names.filter((name) => IS_ROLLBACK_COPY.test(name));
  assert.equal(rollbacks.length, 1, `eine Rollback-Kopie: ${names.join(', ')}`);
  assert.equal(inspect(join(target.dir, rollbacks[0]), null).note, 'vor dem Restore');
  assert.deepEqual(names.filter((name) => name.includes('.restore-tmp') || name.endsWith('.partial')), []);
});

// ---------------------------------------------------------------------------
// Vierte Runde #1431
// ---------------------------------------------------------------------------

function hasNote(filePath, note) {
  let handle;
  try {
    handle = openWith(filePath, null);
    return Boolean(handle.prepare('SELECT 1 FROM restore_probe WHERE note = ?').get(note));
  } catch (err) {
    return err.code ?? err.message;
  } finally {
    handle?.close();
  }
}

test('#1431 der dokumentierte Compose-Restore behaelt das Write-Ahead-Log bei der Rollback-Kopie', async () => {
  // `docker compose stop` ohne Checkpoint: die letzte Transaktion steht nur im -wal.
  const laufend = join(tempDir('yuvomi-test-swap-'), 'laufend.db');
  const mod = await bootDb(laufend, null);
  mod.get().exec('CREATE TABLE restore_probe (note TEXT)');
  mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run('vor dem Restore');
  mod.get().pragma('wal_checkpoint(TRUNCATE)');
  mod.get().pragma('wal_autocheckpoint = 0');
  mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run('letzte Zeile');
  const dir = tempDir('yuvomi-test-swap-');
  const dbPath = join(dir, 'yuvomi.db');
  for (const suffix of ['', '-wal', '-shm']) copyFileSync(`${laufend}${suffix}`, `${dbPath}${suffix}`);
  mod.get().close();
  const nurHauptdatei = join(tempDir('yuvomi-test-swap-'), 'nur-haupt.db');
  copyFileSync(dbPath, nurHauptdatei);
  assert.notEqual(hasNote(nurHauptdatei, 'letzte Zeile'), true, 'Vorbedingung: ohne das -wal fehlt die letzte Zeile');

  const backupPath = await bigBackup(null, 'aus dem Backup');
  const run = runComposeRestore(backupPath, dbPath);
  assert.equal(run.status, 0, `der Befehl muss gelingen: ${run.stderr}`);
  assert.equal(sha256(dbPath), sha256(backupPath), 'DB_PATH ist das Backup');
  const rollback = readdirSync(dir).find((name) => IS_ROLLBACK_COPY.test(name) && !name.endsWith('-wal'));
  assert.ok(rollback, `eine Rollback-Kopie: ${readdirSync(dir).join(', ')}`);
  assert.equal(
    hasNote(join(dir, rollback), 'letzte Zeile'),
    true,
    `die Rollback-Kopie traegt auch, was nur im -wal stand: ${readdirSync(dir).join(', ')}`
  );
});

test('#1431 scheitert die Rollback-Kopie und dann das Aufraeumen, wird die alte Datenbank trotzdem wieder geoeffnet', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const realCopyFile = fsp.copyFile;
  const realUnlink = fsp.unlink;
  let stagingUnlinks = 0;
  fsp.copyFile = async (src, dest, mode) => {
    // Die Rollback-Kopie: nach db.close(), vor dem Tausch.
    if (String(src) === target.dbPath) {
      throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
    }
    return realCopyFile(src, dest, mode);
  };
  fsp.unlink = async (filePath) => {
    if (String(filePath).includes('.restore-tmp-') && ++stagingUnlinks > 1) {
      throw Object.assign(new Error('EACCES: permission denied, unlink'), { code: 'EACCES' });
    }
    return realUnlink(filePath);
  };
  try {
    await assert.rejects(
      () => target.mod.restoreFromFile(backupPath),
      (err) => {
        assert.match(err.message, /^ENOSPC/, `der urspruengliche Fehler: ${err.message}`);
        return true;
      }
    );
  } finally {
    fsp.copyFile = realCopyFile;
    fsp.unlink = realUnlink;
  }
  assert.ok(stagingUnlinks > 1, 'Vorbedingung: der Fehlerpfad wollte die Arbeitsdatei wegraeumen');
  assert.equal(
    target.mod.get().prepare('SELECT note FROM restore_probe').get()?.note,
    'vor dem Restore',
    'die alte Datenbank ist wieder offen'
  );
  target.mod.get().close();
});

for (const art of ['derselbe Pfad', 'harter Link', 'Symlink']) {
  test(`#1431 die laufende Datenbank auf sich selbst zurueckspielen wird abgelehnt (${art})`, async () => {
    const target = await frozenTarget(KEY, 'vor dem Restore');
    // Nur im -wal: ohne Ablehnung haengte das rename den Stand davor ein.
    target.mod.get().pragma('wal_autocheckpoint = 0');
    target.mod.get().prepare('UPDATE restore_probe SET note = ?').run('nur im wal');
    let source = target.dbPath;
    if (art === 'harter Link') {
      source = join(tempDir('yuvomi-test-swap-'), 'link.db');
      linkSync(target.dbPath, source);
    } else if (art === 'Symlink') {
      source = join(tempDir('yuvomi-test-swap-'), 'symlink.db');
      symlinkSync(target.dbPath, source);
    }
    await assert.rejects(
      () => target.mod.restoreFromFile(source),
      /is the active database itself \(DB_PATH\).*Nothing on this instance was changed/s
    );
    assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe').get()?.note, 'nur im wal');
    assert.deepEqual(readdirSync(target.dir).filter((name) => name.includes('.pre-restore-')), [], 'keine Rollback-Kopie');
    target.mod.get().close();
  });
}

test('#1431 Klartext-Backup mit kaputter Schemaseite: backup_corrupt statt „not a valid Yuvomi database"', async () => {
  const backupPath = await bigBackup(null, 'aus dem Backup');
  const kaputt = join(tempDir('yuvomi-test-swap-'), 'kaputt.db');
  const bytes = Buffer.from(readFileSync(backupPath));
  // Kopf (100 Byte) heil, der Rest von Seite 1 - der sqlite_master-Seite - Muell.
  bytes.fill(0x41, 100, PAGE);
  writeFileSync(kaputt, bytes);
  const probe = openWith(kaputt, null);
  let code;
  try { probe.prepare('SELECT count(*) FROM sqlite_master').get(); } catch (err) { code = err.code; }
  probe.close();
  assert.match(String(code), /^SQLITE_CORRUPT/, 'Vorbedingung: schon das Lesen von sqlite_master scheitert mit CORRUPT');

  const target = await frozenTarget(null, 'vor dem Restore');
  await assert.rejects(
    () => target.mod.restoreFromFile(kaputt),
    (err) => err.reason === 'backup_corrupt' && /Nothing on this instance was changed/.test(err.message)
  );
  assertUntouched(target, 'vor dem Restore');
  target.mod.get().close();
});

// ---------------------------------------------------------------------------
// Fuenfte Runde #1431
// ---------------------------------------------------------------------------

test('#1431 Compose-Restore auf eine leere Datenbankdatei: das Journal ueberlebt das Oeffnen der Rollback-Kopie', async () => {
  // SQLite verwirft ein -wal neben einer 0-Byte-Datei beim ersten Oeffnen,
  // auch lesend - deshalb legt es db.js als `.wal-kept` ab (#1282).
  const laufend = join(tempDir('yuvomi-test-swap-'), 'laufend.db');
  const mod = await bootDb(laufend, null);
  mod.get().exec('CREATE TABLE restore_probe (note TEXT)');
  mod.get().pragma('wal_autocheckpoint = 0');
  mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run('nur im journal');
  const dir = tempDir('yuvomi-test-swap-');
  const dbPath = join(dir, 'yuvomi.db');
  copyFileSync(`${laufend}-wal`, `${dbPath}-wal`);
  mod.get().close();
  writeFileSync(dbPath, '');
  const walVorher = sha256(`${dbPath}-wal`);
  assert.ok(statSync(`${dbPath}-wal`).size > 0, 'Vorbedingung: das Journal traegt Daten');

  const backupPath = await bigBackup(null, 'aus dem Backup');
  const run = runComposeRestore(backupPath, dbPath);
  assert.equal(run.status, 0, `der Befehl muss gelingen: ${run.stderr}`);
  const rollback = readdirSync(dir).find((name) => IS_ROLLBACK_COPY.test(name) && !name.endsWith('-wal'));
  assert.ok(rollback, `eine Rollback-Kopie: ${readdirSync(dir).join(', ')}`);
  // Wer die Rollback-Kopie ansieht, oeffnet sie - der naheliegende naechste
  // Schritt, wie `sqlite3 <kopie>` mit einer ersten Abfrage.
  try {
    const blick = new Database(join(dir, rollback));
    try { blick.prepare('SELECT count(*) FROM sqlite_master').get(); } finally { blick.close(); }
  } catch { /* leere Datei */ }
  const bewahrt = readdirSync(dir).filter((name) => name.startsWith(rollback) && name !== rollback
    && sha256(join(dir, name)) === walVorher);
  assert.equal(bewahrt.length, 1, `das Journal liegt Byte fuer Byte neben der Rollback-Kopie: ${readdirSync(dir).join(', ')}`);
  assert.ok(!bewahrt[0].endsWith('-wal'), 'nicht unter -wal, das SQLite neben der leeren Datei verwirft');
});

test('#1431 der Compose-Restore in der App ist derselbe Befehl wie in docs/installation.md', () => {
  const source = readFileSync(new URL('../public/settings/pages/admin-backup.js', import.meta.url), 'utf8');
  const raw = source.split('\n').find((l) => l.startsWith('docker compose run --rm -v "$BACKUP:/tmp/yuvomi-restore.db:ro"'));
  assert.ok(raw, 'admin-backup.js muss den Compose-Restore zeigen');
  // So, wie er auf dem Bildschirm steht: das Template-Literal wertet \${ zu ${
  // aus, das HTML die Entities zu Zeichen.
  assert.ok(!/(^|[^\\])\$\{/.test(raw), 'kein unmaskiertes ${ - das Template-Literal setzte dort etwas ein');
  const shown = raw.replaceAll('\\${', '${')
    .replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
  // Im HTML muss jedes < und & eine Entity sein, sonst liest der Browser etwas anderes.
  assert.ok(!raw.includes('<'), 'kein rohes < in der App-Zeile');
  assert.ok(!/&(?!(gt|lt|amp);)/.test(raw), 'kein rohes & ohne Entity in der App-Zeile');
  const doc = readFileSync(new URL('../docs/installation.md', import.meta.url), 'utf8');
  const documented = doc.split('\n').find((l) => l.startsWith('docker compose run --rm -v "$BACKUP:/tmp/yuvomi-restore.db:ro"'));
  assert.equal(shown, documented, 'App und Doku zeigen denselben Befehl');
});

test('#1431 ein schreibgeschuetztes Backup (0444) laesst sich einspielen, DB_PATH behaelt seine Rechte', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  chmodSync(backupPath, 0o444);
  const target = await frozenTarget(KEY, 'vor dem Restore');
  chmodSync(target.dbPath, 0o640);
  await target.mod.restoreFromFile(backupPath);
  assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe LIMIT 1').get()?.note, 'aus dem Backup');
  assert.equal(statSync(target.dbPath).mode & 0o777, 0o640, 'die Rechte der bisherigen Datenbank bleiben');
  assert.equal(statSync(target.dbPath).uid, process.getuid(), 'und ihr Besitzer');
  target.mod.get().close();
});

test('#1431 Reste eines Restores werden auch neben einer leeren Datenbankdatei weggeraeumt', async () => {
  const dir = tempDir('yuvomi-test-swap-');
  const dbPath = join(dir, 'yuvomi.db');
  writeFileSync(dbPath, '');
  const tot = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const rest = join(dir, `yuvomi.db.restore-tmp-${Number(tot.stdout)}-abc`);
  writeFileSync(rest, 'volle Kopie eines Backups');
  await assert.rejects(() => bootDb(dbPath, KEY), /empty/i, 'Vorbedingung: der Start bricht an der leeren Datei ab');
  assert.ok(!existsSync(rest), `die Arbeitsdatei ist trotzdem weg: ${readdirSync(dir).join(', ')}`);
});

test('#1431 ein Backup, das waehrend des Kopierens der Arbeitsdatei beginnt, laeuft zu Ende, bevor der Restore die Verbindung schliesst', async () => {
  const backupPath = await bigBackup(null, 'aus dem Backup');
  const target = await frozenTarget(null, 'vor dem Restore');
  const backupDir = tempDir('yuvomi-test-swap-dl-');
  const snapshot = join(backupDir, 'waehrenddessen.db');

  let releaseCopy;
  const copyGate = new Promise((resolve) => { releaseCopy = resolve; });
  let copyReached;
  const copying = new Promise((resolve) => { copyReached = resolve; });
  let releaseMkdir;
  const mkdirGate = new Promise((resolve) => { releaseMkdir = resolve; });
  let mkdirReached;
  const inBackup = new Promise((resolve) => { mkdirReached = resolve; });
  const realCopyFile = fsp.copyFile;
  const realMkdir = fsp.mkdir;
  fsp.copyFile = async (src, dest, mode) => {
    if (String(src) === backupPath) {
      copyReached();
      await copyGate;
    }
    return realCopyFile(src, dest, mode);
  };
  fsp.mkdir = async (dir, options) => {
    // Das Backup haelt nach seinem ersten Schritt an - mit der Verbindung in der Hand.
    if (String(dir) === backupDir) {
      mkdirReached();
      await mkdirGate;
    }
    return realMkdir(dir, options);
  };
  try {
    const restore = target.mod.restoreFromFile(backupPath);
    await copying;
    const backup = target.mod.backupToFile(snapshot);
    await inBackup;
    releaseCopy();
    // Dem Restore Zeit lassen, bis zum Schliessen zu kommen, falls er nicht wartet.
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseMkdir();
    await backup;
    await restore;
  } finally {
    releaseCopy();
    releaseMkdir();
    fsp.copyFile = realCopyFile;
    fsp.mkdir = realMkdir;
  }
  assert.equal(hasNote(snapshot, 'vor dem Restore'), true, 'das Backup traegt den Stand vor dem Restore');
  assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe LIMIT 1').get()?.note, 'aus dem Backup');
  target.mod.get().close();
});

test('#1431 der Name der Rollback-Kopie ist dauerhaft, bevor DB_PATH ersetzt wird', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const log = [];
  const realRename = fsp.rename;
  const realOpen = fsp.open;
  fsp.rename = async (from, to) => {
    log.push(`rename ${String(to) === target.dbPath ? 'DB_PATH' : IS_ROLLBACK_COPY.test(String(to)) ? 'rollback' : 'other'}`);
    return realRename(from, to);
  };
  fsp.open = async (filePath, flags, mode) => {
    if (String(filePath) === target.dir) log.push('fsync dir');
    return realOpen(filePath, flags, mode);
  };
  try {
    await target.mod.restoreFromFile(backupPath);
  } finally {
    fsp.rename = realRename;
    fsp.open = realOpen;
  }
  const rollback = log.indexOf('rename rollback');
  const swap = log.indexOf('rename DB_PATH');
  assert.ok(rollback >= 0 && swap > rollback, `Reihenfolge: ${log.join(', ')}`);
  assert.ok(log.slice(rollback + 1, swap).includes('fsync dir'), `zwischen beiden ein fsync des Verzeichnisses: ${log.join(', ')}`);
  target.mod.get().close();
});

// ---------------------------------------------------------------------------
// Sechste Runde #1431
// ---------------------------------------------------------------------------

test('#1431 verschwindet die halbe Rollback-Kopie unterwegs, wird NICHT getauscht', async () => {
  // Nachgestellt: ein Server-Start in einem anderen PID-Namensraum haelt den
  // Prozess der `.partial` fuer tot und raeumt sie weg, bevor sie ihren
  // Endnamen bekommt. Vorher lief der Restore trotzdem durch, mit
  // rollbackPath null - und die alte Datenbank war weg.
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const realRename = fsp.rename;
  fsp.rename = async (from, to) => {
    if (String(from).endsWith('.partial')) {
      await fsp.unlink(from);
      throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${from}'`), { code: 'ENOENT' });
    }
    return realRename(from, to);
  };
  try {
    await assert.rejects(() => target.mod.restoreFromFile(backupPath), /ENOENT/);
  } finally {
    fsp.rename = realRename;
  }
  assertUntouched(target, 'vor dem Restore');
  target.mod.get().close();
});

test('#1431 lehnt das Dateisystem chmod ab (NAS-Mount), laeuft der Restore trotzdem', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const realChmod = fsp.chmod;
  let refused = 0;
  fsp.chmod = async () => {
    refused++;
    throw Object.assign(new Error('EPERM: operation not permitted, chmod'), { code: 'EPERM' });
  };
  try {
    await target.mod.restoreFromFile(backupPath);
  } finally {
    fsp.chmod = realChmod;
  }
  assert.ok(refused > 0, 'Vorbedingung: chmod wurde versucht');
  assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe LIMIT 1').get()?.note, 'aus dem Backup');
  target.mod.get().close();
});

test('#1431 lehnt das Dateisystem chmod ab und bleibt die Datei schreibgeschuetzt, wird abgebrochen', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  chmodSync(backupPath, 0o444);
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const realChmod = fsp.chmod;
  fsp.chmod = async () => {
    throw Object.assign(new Error('EPERM: operation not permitted, chmod'), { code: 'EPERM' });
  };
  try {
    await assert.rejects(() => target.mod.restoreFromFile(backupPath), /EPERM/);
  } finally {
    fsp.chmod = realChmod;
  }
  assertUntouched(target, 'vor dem Restore');
  target.mod.get().close();
});

test('#1431 der dokumentierte Compose-Restore mit schreibgeschuetztem Backup (0444): die Datenbank bleibt schreibbar', async () => {
  const backupPath = await bigBackup(null, 'aus dem Backup');
  chmodSync(backupPath, 0o444);
  const target = await frozenTarget(null, 'vor dem Restore');
  target.mod.get().close();
  const run = runComposeRestore(backupPath, target.dbPath);
  assert.equal(run.status, 0, `der Befehl muss gelingen: ${run.stderr}`);
  assert.equal(statSync(target.dbPath).mode & 0o777, 0o600, 'die eingespielte Datei ist 0600, nicht die 0444 des Backups');
  const mod = await bootDb(target.dbPath, null);
  assert.equal(mod.get().prepare('SELECT note FROM restore_probe LIMIT 1').get()?.note, 'aus dem Backup');
  mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run('schreibbar');
  mod.get().close();
});

test('#1431 der dokumentierte Compose-Restore laeuft auch auf einem Mount, der chmod ablehnt', async () => {
  const backupPath = await bigBackup(null, 'aus dem Backup');
  const target = await frozenTarget(null, 'vor dem Restore');
  target.mod.get().close();
  const run = runComposeRestore(backupPath, target.dbPath, { refuseChmod: true });
  assert.equal(run.status, 0, `der Befehl darf am chmod nicht abbrechen: ${run.stderr}`);
  assert.equal(sha256(target.dbPath), sha256(backupPath), 'DB_PATH ist das Backup');
  assert.deepEqual(
    readdirSync(target.dir).filter((name) => name.includes('.restore-tmp') || name.endsWith('.partial')),
    [],
    'keine Arbeitsdatei bleibt liegen'
  );
});

// ---------------------------------------------------------------------------
// Siebte Runde #1431 (Codex-Befunde auf 46ecf18ec)
// ---------------------------------------------------------------------------

test('#1431 waehrend der Restore die Arbeitsdatei kopiert, nimmt die Verbindung keine Schreibzugriffe an', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const copying = new Promise((resolve) => { reached = resolve; });
  const realCopyFile = fsp.copyFile;
  fsp.copyFile = async (src, dest, mode) => {
    if (String(src) === backupPath) {
      reached();
      await gate;
    }
    return realCopyFile(src, dest, mode);
  };
  let writeOutcome;
  let runningDuring;
  try {
    const restore = target.mod.restoreFromFile(backupPath);
    await copying;
    runningDuring = target.mod.isRestoreRunning?.();
    try {
      target.mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run('waehrend des Restores');
      writeOutcome = 'gespeichert';
    } catch (err) {
      writeOutcome = err.code;
    }
    release();
    await restore;
  } finally {
    release();
    fsp.copyFile = realCopyFile;
  }
  assert.equal(writeOutcome, 'SQLITE_READONLY', 'der Schreibzugriff darf keinen Erfolg melden, den der Tausch verwirft');
  assert.equal(runningDuring, true, 'isRestoreRunning() meldet den laufenden Restore');
  assert.equal(target.mod.isRestoreRunning(), false);
  // Die neue Verbindung nimmt wieder Schreibzugriffe an.
  target.mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run('danach');
  target.mod.get().close();
});

test('#1431 nach einem gescheiterten Restore nimmt die alte Verbindung wieder Schreibzugriffe an', async () => {
  const kaputt = join(tempDir('yuvomi-test-swap-'), 'kein-sqlite.db');
  writeFileSync(kaputt, 'das ist keine Datenbank, aber lang genug fuer einen Kopf');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  await assert.rejects(() => target.mod.restoreFromFile(kaputt));
  target.mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run('danach');
  target.mod.get().close();
});

test('#1431 ein verschluesseltes Backup (VACUUM INTO) laeuft auch waehrend eines Restores', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const snapshot = join(tempDir('yuvomi-test-swap-dl-'), 'snapshot.db');
  target.mod.get().pragma('query_only = ON');
  try {
    await target.mod.backupToFile(snapshot);
  } finally {
    target.mod.get().pragma('query_only = OFF');
  }
  assert.equal(target.mod.get().pragma('query_only', { simple: true }), 0);
  const handle = openWith(snapshot, KEY);
  assert.equal(handle.prepare('SELECT note FROM restore_probe').get()?.note, 'vor dem Restore');
  handle.close();
  await target.mod.restoreFromFile(backupPath);
  target.mod.get().close();
});

test('#1431 restoreWriteGate: schreibende Requests bekommen waehrend eines Restores 503, ein zweiter Restore 409, lesende gehen durch', async () => {
  const { createRestoreWriteGate } = await import('../server/middleware/restore-gate.js');
  let running = true;
  const gate = createRestoreWriteGate(() => running);
  const call = (method, url) => {
    const res = { statusCode: 200, body: null, headers: {},
      // Eine zugelassene schreibende Anfrage wird bis 'finish' festgehalten -
      // hier endet sie sofort, sonst wartete jeder spaetere Restore auf sie.
      once(event, fn) { if (event === 'finish') queueMicrotask(fn); },
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; } };
    let passed = false;
    gate({ method, originalUrl: url, url }, res, () => { passed = true; });
    return { passed, res };
  };
  const closedGate = createRestoreWriteGate(() => true, () => false);
  const closedCall = (method, url) => {
    const res = { statusCode: 200, body: null, headers: {},
      // Eine zugelassene schreibende Anfrage wird bis 'finish' festgehalten -
      // hier endet sie sofort, sonst wartete jeder spaetere Restore auf sie.
      once(event, fn) { if (event === 'finish') queueMicrotask(fn); },
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; } };
    let passed = false;
    closedGate({ method, originalUrl: url, url }, res, () => { passed = true; });
    return { passed, res };
  };
  assert.equal(closedCall('GET', '/api/v1/auth/me').res.statusCode, 503, 'Verbindung zu: auch lesende API-Anfragen');
  assert.equal(closedCall('GET', '/mcp').res.statusCode, 503);
  assert.equal(closedCall('GET', '/manifest.json').passed, true, 'statische Dateien gehen durch');
  assert.equal(closedCall('GET', '/feed/calendar/abc.ics').res.statusCode, 503, 'Feeds lesen die Datenbank');
  const secondClosed = closedCall('POST', '/api/v1/backup/restore');
  assert.equal(secondClosed.res.statusCode, 409, 'ein zweiter Restore bekommt auch bei geschlossener Verbindung 409');
  assert.equal(secondClosed.res.body.reason, 'restore_in_progress');
  const post = call('POST', '/api/v1/tasks');
  assert.equal(post.passed, false);
  assert.equal(post.res.statusCode, 503);
  assert.equal(post.res.body.reason, 'restore_in_progress');
  assert.equal(post.res.body.code, 503);
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal(call(method, '/mcp').passed, false, method);
  assert.equal(call('GET', '/api/v1/tasks').passed, true);
  const second = call('POST', '/api/v1/backup/restore?x=1');
  assert.equal(second.passed, false, 'ein zweiter Restore kommt nicht bis zur Route');
  assert.equal(second.res.statusCode, 409);
  assert.equal(second.res.body.reason, 'restore_in_progress');
  running = false;
  assert.equal(call('POST', '/api/v1/tasks').passed, true);
});

test('#1431 restoreWriteGate haengt vor Body-Parsern, Sessions und Routern', () => {
  const source = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const gate = source.indexOf('app.use(createRestoreWriteGate(db.isRestoreRunning, db.isDatabaseOpen));');
  assert.ok(gate > 0, 'server/index.js muss den Riegel mit db.isRestoreRunning und db.isDatabaseOpen einhaengen');
  for (const later of ['app.use(express.json(', 'app.use(express.urlencoded(', 'app.use(sessionMiddleware);', "app.use('/api/v1/auth', authRouter);", "app.use('/mcp'", "app.use('/api/v1/tasks', tasksRouter);"]) {
    assert.ok(source.indexOf(later) > gate, `${later} kommt nach dem Riegel`);
  }
});

test('#1431 Klartext-Backup, dessen Index nicht mehr zur Tabelle passt: backup_corrupt', async () => {
  const backupPath = await bigBackup(null, 'aus dem Backup');
  // Ein indizierter Wert, dann ein gleich langes Zeichen darin gekippt - nur in der Tabelle.
  const marker = 'INDEXPROBE-ABCDEFGHIJ';
  const setup = new Database(backupPath);
  setup.exec('CREATE TABLE index_probe (v TEXT); CREATE INDEX index_probe_v ON index_probe (v)');
  setup.prepare('INSERT INTO index_probe (v) VALUES (?)').run(marker);
  setup.pragma('journal_mode = DELETE');
  setup.close();
  const original = readFileSync(backupPath);
  const needle = Buffer.from(marker);
  let kaputt = null;
  for (let at = original.indexOf(needle); at !== -1; at = original.indexOf(needle, at + 1)) {
    const bytes = Buffer.from(original);
    bytes[at + needle.length - 1] = 'K'.charCodeAt(0);
    const probe = join(tempDir('yuvomi-test-swap-'), 'probe.db');
    writeFileSync(probe, bytes);
    const handle = new Database(probe, { readonly: true });
    const quick = handle.pragma('quick_check(1)', { simple: true });
    const full = handle.pragma('integrity_check(1)', { simple: true });
    handle.close();
    if (quick === 'ok' && full !== 'ok') { kaputt = probe; break; }
  }
  assert.ok(kaputt, 'Vorbedingung: eine Stelle, an der quick_check ok sagt und integrity_check nicht');

  const target = await frozenTarget(null, 'vor dem Restore');
  await assert.rejects(
    () => target.mod.restoreFromFile(kaputt),
    (err) => err.reason === 'backup_corrupt'
  );
  assertUntouched(target, 'vor dem Restore');
  target.mod.get().close();
});

test('#1431 die entfernten Nebendateien sind dauerhaft, bevor DB_PATH ersetzt wird', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const log = [];
  const realRename = fsp.rename;
  const realOpen = fsp.open;
  const realUnlink = fsp.unlink;
  fsp.unlink = async (filePath) => {
    if (String(filePath) === `${target.dbPath}-wal` || String(filePath) === `${target.dbPath}-shm`) log.push('sidecar');
    return realUnlink(filePath);
  };
  fsp.rename = async (from, to) => {
    if (String(to) === target.dbPath) log.push('rename DB_PATH');
    return realRename(from, to);
  };
  fsp.open = async (filePath, flags, mode) => {
    if (String(filePath) === target.dir) log.push('fsync dir');
    return realOpen(filePath, flags, mode);
  };
  try {
    await target.mod.restoreFromFile(backupPath);
  } finally {
    fsp.rename = realRename;
    fsp.open = realOpen;
    fsp.unlink = realUnlink;
  }
  const lastSidecar = log.lastIndexOf('sidecar');
  const swap = log.indexOf('rename DB_PATH');
  assert.ok(lastSidecar >= 0 && swap > lastSidecar, `Reihenfolge: ${log.join(', ')}`);
  assert.ok(log.slice(lastSidecar + 1, swap).includes('fsync dir'), `zwischen Nebendateien und Tausch ein fsync: ${log.join(', ')}`);
  target.mod.get().close();
});

function patchDirectorySync(dir, code) {
  const realOpen = fsp.open;
  fsp.open = async (filePath, flags, mode) => {
    const handle = await realOpen(filePath, flags, mode);
    if (String(filePath) !== dir) return handle;
    return {
      sync: async () => { throw Object.assign(new Error(`${code}: directory fsync`), { code }); },
      close: () => handle.close(),
    };
  };
  return () => { fsp.open = realOpen; };
}

test('#1431 ein echter Fehler beim fsync des Verzeichnisses (EIO) bricht den Restore ab, vor dem Tausch', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const restore = patchDirectorySync(target.dir, 'EIO');
  try {
    await assert.rejects(() => target.mod.restoreFromFile(backupPath), /EIO/);
  } finally {
    restore();
  }
  assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe').get()?.note, 'vor dem Restore');
  target.mod.get().pragma('wal_checkpoint(TRUNCATE)');
  assert.equal(sha256(target.dbPath), target.hash, 'DB_PATH ist die alte Datei');
  target.mod.get().close();
});

test('#1431 kann das Dateisystem keinen fsync auf Verzeichnisse (EINVAL), laeuft der Restore', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const restore = patchDirectorySync(target.dir, 'EINVAL');
  try {
    await target.mod.restoreFromFile(backupPath);
  } finally {
    restore();
  }
  assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe LIMIT 1').get()?.note, 'aus dem Backup');
  target.mod.get().close();
});

test(
  '#1431 laesst sich der Besitzer der bisherigen Datenbank nicht uebernehmen, wird vor dem Tausch abgebrochen',
  { skip: process.getuid?.() === 0 && 'root darf jeden Besitzer setzen' },
  async () => {
    const backupPath = await bigBackup(KEY, 'aus dem Backup');
    const target = await frozenTarget(KEY, 'vor dem Restore');
    const realStat = fsp.stat;
    const realAccess = fsp.access;
    // Die bisherige Datenbank gehoert (scheinbar) einem anderen Nutzer, etwa
    // dem Dienst, und der laufende Prozess darf sie nicht schreiben - er ist
    // also nicht der Dienst.
    fsp.stat = async (filePath, options) => {
      const stats = await realStat(filePath, options);
      if (String(filePath) === target.dbPath) return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: stats.uid + 1 });
      return stats;
    };
    fsp.access = async (filePath, mode) => {
      if (String(filePath) === target.dbPath && mode) {
        throw Object.assign(new Error('EACCES: permission denied, access'), { code: 'EACCES' });
      }
      return realAccess(filePath, mode);
    };
    try {
      await assert.rejects(
        () => target.mod.restoreFromFile(backupPath),
        /Run the restore as the user Yuvomi runs as, or as root/
      );
    } finally {
      fsp.stat = realStat;
      fsp.access = realAccess;
    }
    assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe').get()?.note, 'vor dem Restore');
    target.mod.get().pragma('wal_checkpoint(TRUNCATE)');
    assert.equal(sha256(target.dbPath), target.hash, 'DB_PATH ist die alte Datei');
    target.mod.get().close();
  }
);

test('#1431 scheitert chown, gehoert die Datei aber ohnehin demselben Nutzer (SMB), laeuft der Restore', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const realChown = fsp.chown;
  let refused = 0;
  fsp.chown = async () => {
    refused++;
    throw Object.assign(new Error('EPERM: operation not permitted, chown'), { code: 'EPERM' });
  };
  try {
    await target.mod.restoreFromFile(backupPath);
  } finally {
    fsp.chown = realChown;
  }
  assert.ok(refused > 0, 'Vorbedingung: chown wurde versucht');
  assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe LIMIT 1').get()?.note, 'aus dem Backup');
  target.mod.get().close();
});

// ---------------------------------------------------------------------------
// Neunte Runde #1431
// ---------------------------------------------------------------------------

test('#1431 ein Sync-Lauf, der vor dem Restore begann, wird abgewartet und schreibt sein Ergebnis noch', async () => {
  const { runSerialized } = await import('../server/utils/sync-lock.js');
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const order = [];
  const realCopyFile = fsp.copyFile;
  fsp.copyFile = async (src, dest, mode) => {
    if (String(src) === backupPath) order.push('Restore kopiert');
    return realCopyFile(src, dest, mode);
  };
  let releaseProvider;
  const provider = new Promise((resolve) => { releaseProvider = resolve; });
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const job = runSerialized('test-1431-wait', 'sync', async () => {
    started();
    await provider; // der Anbieter antwortet noch nicht
    target.mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run('Link vom Sync');
    order.push('Sync schreibt');
    return 'geschrieben';
  });
  let outcome;
  try {
    await running;
    const restore = target.mod.restoreFromFile(backupPath);
    // Dem Restore Zeit geben weiterzulaufen, falls er nicht wartet.
    await new Promise((resolve) => setTimeout(resolve, 200));
    releaseProvider();
    try {
      outcome = await job;
    } catch (err) {
      outcome = err.code ?? err.message;
    }
    await restore;
  } finally {
    releaseProvider();
    fsp.copyFile = realCopyFile;
  }
  assert.equal(outcome, 'geschrieben', 'der Sync schreibt sein Ergebnis noch zurueck');
  assert.deepEqual(order, ['Sync schreibt', 'Restore kopiert'], 'erst der Sync, dann der Restore');
  target.mod.get().close();
});

test('#1431 waehrend eines Restores beginnt kein Sync-Lauf', async () => {
  const { runSerialized } = await import('../server/utils/sync-lock.js');
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const copying = new Promise((resolve) => { reached = resolve; });
  const realCopyFile = fsp.copyFile;
  fsp.copyFile = async (src, dest, mode) => {
    if (String(src) === backupPath) {
      reached();
      await gate;
    }
    return realCopyFile(src, dest, mode);
  };
  let called = false;
  let result;
  try {
    const restore = target.mod.restoreFromFile(backupPath);
    await copying;
    result = await runSerialized('test-1431-tick', 'sync', async () => { called = true; return 'lief'; });
    release();
    await restore;
  } finally {
    release();
    fsp.copyFile = realCopyFile;
  }
  assert.equal(called, false, 'der Tick darf waehrend des Restores nicht beginnen');
  assert.equal(result?.skipped, 'restore_in_progress');
  target.mod.get().close();
});

test('#1431 Outlook- und CardDAV-Sync beginnen waehrend eines Restores nicht', async () => {
  const state = await import('../server/utils/restore-state.js');
  const outlook = await import('../server/services/outlook-calendar.js');
  const carddav = await import('../server/services/cardav-sync.js');
  state.setRestoreRunning?.(true);
  try {
    assert.deepEqual(await outlook.sync(), { success: false, skipped: 'restore_in_progress' });
    assert.deepEqual(await carddav.sync(), { success: false, skipped: 'restore_in_progress' });
  } finally {
    state.setRestoreRunning?.(false);
  }
});

test(
  '#1431 scheitert chown, bleibt die Datei aber ueber die Gruppe schreibbar (root:node 0660), laeuft der Restore',
  { skip: process.getuid?.() === 0 && 'root darf jeden Besitzer setzen' },
  async () => {
    const backupPath = await bigBackup(KEY, 'aus dem Backup');
    const target = await frozenTarget(KEY, 'vor dem Restore');
    chmodSync(target.dbPath, 0o660);
    const realStat = fsp.stat;
    // Die bisherige Datenbank gehoert (scheinbar) einem anderen Nutzer, teilt
    // aber die Gruppe mit dem Dienst - wie root:node auf TrueNAS.
    fsp.stat = async (filePath, options) => {
      const stats = await realStat(filePath, options);
      if (String(filePath) === target.dbPath) return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: stats.uid + 1 });
      return stats;
    };
    try {
      await target.mod.restoreFromFile(backupPath);
    } finally {
      fsp.stat = realStat;
    }
    assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe LIMIT 1').get()?.note, 'aus dem Backup');
    assert.equal(statSync(target.dbPath).mode & 0o777, 0o660);
    target.mod.get().close();
  }
);

// ---------------------------------------------------------------------------
// Zehnte Runde #1431
// ---------------------------------------------------------------------------

test('#1431 ICS, Feiertage, Rezepte, Abfall und Medikamente beginnen waehrend eines Restores nicht', async () => {
  const state = await import('../server/utils/restore-state.js');
  const ics = await import('../server/services/ics-subscription.js');
  const holidays = await import('../server/services/holidays.js');
  const recipes = await import('../server/services/recipe-provider-sync.js');
  const waste = await import('../server/services/waste-source-scheduler.js');
  const medication = await import('../server/services/medication-scheduler.js');
  const skipped = { success: false, skipped: 'restore_in_progress' };
  state.setRestoreRunning(true);
  try {
    assert.deepEqual(await ics.sync(), skipped, 'ICS-Abos');
    assert.deepEqual(await holidays.sync(true), skipped, 'Feiertage');
    assert.deepEqual(await recipes.sync(), skipped, 'Rezept-Anbieter');
    assert.deepEqual(await recipes.syncOne(1), skipped, 'ein Rezept-Konto');
    assert.deepEqual(await waste.runDueWasteSourceRefreshes(), skipped, 'Abfall-Quellen');
    assert.deepEqual(await medication.processDueMedications(), skipped, 'Medikamente');
  } finally {
    state.setRestoreRunning(false);
  }
});

test('#1431 das zurueckgelegte Journal ist dauerhaft, bevor der Rollback endet', async () => {
  // #1282: leere Datei mit Journal, per CLI-Handschlag ohne offene Verbindung.
  const laufend = join(tempDir('yuvomi-test-swap-'), 'laufend.db');
  const vorher = await bootDb(laufend, null);
  vorher.get().exec('CREATE TABLE restore_probe (note TEXT)');
  vorher.get().pragma('wal_autocheckpoint = 0');
  vorher.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run('nur im journal');
  const dir = tempDir('yuvomi-test-swap-');
  const dbPath = join(dir, 'yuvomi.db');
  copyFileSync(`${laufend}-wal`, `${dbPath}-wal`);
  vorher.get().close();
  writeFileSync(dbPath, '');

  const handshake = Symbol.for('yuvomi.db.restoreTarget');
  globalThis[handshake] = true;
  process.env.DB_PATH = dbPath;
  delete process.env.DB_ENCRYPTION_KEY;
  let mod;
  try {
    mod = await import(`../server/db.js?swap=${++scenario}`);
  } finally {
    delete globalThis[handshake];
  }
  const log = [];
  const realRename = fsp.rename;
  const realOpen = fsp.open;
  fsp.rename = async (from, to) => {
    if (String(to) === `${dbPath}-wal`) log.push('Journal zurueck');
    return realRename(from, to);
  };
  fsp.open = async (filePath, flags, mode) => {
    if (String(filePath) === dir) log.push('fsync dir');
    return realOpen(filePath, flags, mode);
  };
  try {
    await assert.rejects(() => mod.restoreFromFile(backupThatFailsAfterTheSwap()));
  } finally {
    fsp.rename = realRename;
    fsp.open = realOpen;
  }
  const back = log.indexOf('Journal zurueck');
  assert.ok(back >= 0, `Vorbedingung: der Rollback legt das Journal zurueck: ${log.join(', ')}`);
  assert.ok(log.slice(back + 1).includes('fsync dir'), `nach dem Zuruecklegen ein fsync: ${log.join(', ')}`);
});

test('#1431 der Fehlerbehandler beendet eine Antwort, deren Kopf schon unterwegs ist', async () => {
  const { createErrorHandler } = await import('../server/middleware/error-handler.js');
  const express = (await import('express')).default;
  const http = await import('node:http');
  const app = express();
  app.get('/halb', (req, res, next) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('angefangen');
    next(Object.assign(new Error('Sitzung nicht speicherbar'), { reason: 'restore_in_progress' }));
  });
  app.use(createErrorHandler({ warn() {}, error() {} }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('haengt'), 3000);
      http.get(`http://127.0.0.1:${server.address().port}/halb`, (res) => {
        res.on('data', () => {});
        res.on('end', () => { clearTimeout(timer); resolve('beendet'); });
        res.on('aborted', () => { clearTimeout(timer); resolve('beendet'); });
        res.on('error', () => { clearTimeout(timer); resolve('beendet'); });
      }).on('error', () => { clearTimeout(timer); resolve('beendet'); });
    });
    assert.equal(outcome, 'beendet', 'die Verbindung darf nicht offen stehen bleiben');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('#1431 gehoert die Arbeitsdatei dem laufenden Prozess, der die alte Datenbank schreiben darf, laeuft der Restore auch bei anderer uid und gid', async () => {
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const realStat = fsp.stat;
  const realChown = fsp.chown;
  fsp.stat = async (filePath, options) => {
    const stats = await realStat(filePath, options);
    if (String(filePath) === target.dbPath) {
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: stats.uid + 1, gid: stats.gid + 1 });
    }
    return stats;
  };
  fsp.chown = async () => { throw Object.assign(new Error('EPERM: operation not permitted, chown'), { code: 'EPERM' }); };
  try {
    await target.mod.restoreFromFile(backupPath);
  } finally {
    fsp.stat = realStat;
    fsp.chown = realChown;
  }
  assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe LIMIT 1').get()?.note, 'aus dem Backup');
  target.mod.get().close();
});

test('#1431 der dokumentierte Compose-Restore prueft das Backup und tauscht ein beschaedigtes nicht ein', async () => {
  const backupPath = await bigBackup(null, 'aus dem Backup');
  const kaputt = join(tempDir('yuvomi-test-swap-'), 'kaputt.db');
  const bytes = Buffer.from(readFileSync(backupPath));
  bytes.fill(0x41, bytes.length - 3 * PAGE, bytes.length - 3 * PAGE + 16);
  writeFileSync(kaputt, bytes);
  const target = await frozenTarget(null, 'vor dem Restore');
  target.mod.get().close();
  const hash = sha256(target.dbPath);
  const names = readdirSync(target.dir).sort();

  const run = runComposeRestore(kaputt, target.dbPath);
  assert.notEqual(run.status, 0, 'der Befehl muss abbrechen');
  assert.match(run.stderr, /Backup check failed: Backup file is damaged/, `mit der Meldung der Pruefung: ${run.stderr}`);
  assert.equal(sha256(target.dbPath), hash, 'DB_PATH ist unveraendert');
  assert.deepEqual(readdirSync(target.dir).sort(), names, 'keine Rollback-Kopie, keine Arbeitsdatei');
});

// ---------------------------------------------------------------------------
// Elfte Runde #1431
// ---------------------------------------------------------------------------

test(
  '#1431 das Restore-CLI als anderer Nutzer: scheitert chown, zaehlt die eigene euid nicht',
  { skip: process.getuid?.() === 0 && 'root darf jeden Besitzer setzen' },
  async () => {
    const backupPath = await bigBackup(KEY, 'aus dem Backup');
    const target = await frozenTarget(KEY, 'vor dem Restore');
    const realStat = fsp.stat;
    const realChown = fsp.chown;
    // Die alte Datei gehoert dem Dienst (andere uid und gid); der laufende
    // Prozess darf sie schreiben (hier: echt), ist aber das CLI, nicht der Dienst.
    fsp.stat = async (filePath, options) => {
      const stats = await realStat(filePath, options);
      if (String(filePath) === target.dbPath) {
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: stats.uid + 1, gid: stats.gid + 1 });
      }
      return stats;
    };
    fsp.chown = async () => { throw Object.assign(new Error('EPERM: operation not permitted, chown'), { code: 'EPERM' }); };
    const handshake = Symbol.for('yuvomi.db.restoreTarget');
    globalThis[handshake] = true;
    try {
      await assert.rejects(
        () => target.mod.restoreFromFile(backupPath),
        /Run the restore as the user Yuvomi runs as, or as root/
      );
    } finally {
      delete globalThis[handshake];
      fsp.stat = realStat;
      fsp.chown = realChown;
    }
    assert.equal(target.mod.get().prepare('SELECT note FROM restore_probe').get()?.note, 'vor dem Restore');
    target.mod.get().close();
  }
);

// ---------------------------------------------------------------------------
// Letzte Runde #1431
// ---------------------------------------------------------------------------

test('#1431 haengt eine Anfrage laenger als die Frist, bricht der Restore vor jeder Aenderung ab', async () => {
  const state = await import('../server/utils/restore-state.js');
  const { EventEmitter } = await import('node:events');
  const backupPath = await bigBackup(KEY, 'aus dem Backup');
  const target = await frozenTarget(KEY, 'vor dem Restore');
  const hanging = new EventEmitter();
  state.trackWriteRequest(hanging);
  state.setRestoreWaitTimeoutForTests?.(300);
  let outcome;
  try {
    const restore = target.mod.restoreFromFile(backupPath).then(
      () => 'eingespielt',
      (err) => err.reason ?? err.message
    );
    let timer;
    outcome = await Promise.race([
      restore,
      new Promise((resolve) => { timer = setTimeout(() => resolve('haengt'), 3000); }),
    ]);
    clearTimeout(timer);
  } finally {
    hanging.emit('finish');
    state.setRestoreWaitTimeoutForTests?.();
  }
  assert.equal(outcome, 'restore_busy', 'nach der Frist ein Abbruch mit eigenem Grund');
  assert.equal(target.mod.isRestoreRunning(), false, 'der Riegel ist wieder offen');
  assertUntouched(target, 'vor dem Restore');
  target.mod.get().prepare('INSERT INTO restore_probe (note) VALUES (?)').run('danach');
  target.mod.get().close();
});

test('#1431 trackAdmittedWrite weist eine Anfrage ab, die erst nach Restore-Beginn an der Anmeldung ankommt', async () => {
  const state = await import('../server/utils/restore-state.js');
  const { trackAdmittedWrite } = await import('../server/middleware/restore-gate.js');
  const res = { statusCode: 200, body: null, headers: {},
    once() {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  let passed = false;
  state.setRestoreRunning(true);
  try {
    trackAdmittedWrite({ method: 'POST' }, res, () => { passed = true; });
  } finally {
    state.setRestoreRunning(false);
  }
  assert.equal(passed, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.reason, 'restore_in_progress');
});
