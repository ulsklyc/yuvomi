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
import { readFileSync, readdirSync, writeFileSync, chmodSync, copyFileSync, linkSync, symlinkSync } from 'node:fs';
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
function runComposeRestore(backupPath, dbPath, { killMidCopy = false } = {}) {
  const script = documentedComposeRestore().replaceAll('/tmp/yuvomi-restore.db', backupPath);
  const env = { ...process.env, DB_PATH: dbPath };
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
  return spawnSync('/bin/sh', ['-c', script], { env, encoding: 'utf8' });
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
