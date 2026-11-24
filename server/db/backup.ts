/**
 * Modul: Backup schreiben und pruefen (backup)
 * Zweck: Backup der laufenden Datenbank schreiben und vor der Weitergabe
 *        pruefen (#2520), eine Backup-Datei wie vor jedem Restore oeffnen und
 *        validieren, und die Meldungen dazu mit maschinenlesbarem Grund (#1267,
 *        #1283). Jede Funktion, die Verbindung, Schluessel oder die laufenden
 *        Backups braucht, bekommt den Griff ihrer Instanz von server/db.js als
 *        ersten Parameter (./handle.ts); server/db.js re-exportiert sie ohne ihn.
 * Abhängigkeiten: ../utils/sqlite-driver.js, ./migrate.ts
 */

import Database from '../utils/sqlite-driver.js';
import path from 'path';
import fs from 'node:fs/promises';
import { unknownMigrationVersions, latestKnownVersion } from './migrate.ts';
import type { DbHandle, SqliteDatabase } from './handle.ts';

/** Ein Fehler mit maschinenlesbarem Grund fuer den Restore-Dialog. */
export type ReasonedError = Error & { reason?: string };

/** Backup schreiben; laeuft, solange es laeuft, in `handle.activeBackups`. */
export function backupToFile(handle: DbHandle, destinationPath: string): Promise<string> {
  const running = backupToFileUntracked(handle, destinationPath);
  const tracked: Promise<string> = running.finally(() => handle.activeBackups.delete(tracked));
  handle.activeBackups.add(tracked);
  return tracked;
}

async function backupToFileUntracked(handle: DbHandle, destinationPath: string): Promise<string> {
  const database = handle.get();
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  if (handle.dbKey) {
    // Die SQLite-Backup-API kann nicht von einer verschlüsselten Quelle in ein
    // frisch angelegtes Ziel schreiben ("backup is not supported with
    // incompatible source and target databases") — ohne diesen Zweig wäre bei
    // gesetztem Key JEDES Backup kaputt. VACUUM INTO übernimmt Cipher und Key
    // der Quelle, das Backup ist also ebenfalls verschlüsselt. Es verlangt
    // allerdings ein noch nicht existierendes Ziel.
    await unlinkIfExists(destinationPath);
    vacuumInto(database, destinationPath);
  } else if (typeof database.backup === 'function') {
    await database.backup(destinationPath);
  } else {
    vacuumInto(database, destinationPath);
  }

  await verifyWrittenBackup(handle, destinationPath);
  return destinationPath;
}

/**
 * `VACUUM INTO` auch waehrend eines Restores: `query_only` (siehe
 * `restoreFromFile()`) sperrt es sonst, obwohl es nur in eine andere Datei
 * schreibt. Das Loesen und Wiedersetzen ist synchron - dazwischen kann kein
 * anderer Request schreiben.
 */
function vacuumInto(database: SqliteDatabase, destinationPath: string): void {
  const locked = database.pragma('query_only', { simple: true }) === 1;
  if (locked) database.pragma('query_only = OFF');
  try {
    database.prepare('VACUUM INTO ?').run(destinationPath);
  } finally {
    if (locked) database.pragma('query_only = ON');
  }
}

/**
 * Warum eine Backup-Datei nicht lesbar ist - so genau, wie es hier zu wissen ist.
 *
 * SQLite sagt zu jeder Datei, die es nicht entziffern kann, denselben Satz:
 * `file is not a database`. Für ein Backup aus einer ANDEREN Installation ist
 * das die häufigste und zugleich die irreführendste Auskunft - die Datei ist
 * heil, es fehlt nur der Schlüssel, mit dem sie geschrieben wurde. Gemeldet
 * als #1267: der Umzug von einer Instanz mit selbst gesetzten Secrets auf eine,
 * die sich ihre eigenen erzeugt, endete im Restore-Dialog bei „is not a file",
 * und der Nutzer schloss daraus auf ein kaputtes Backup. Danach hat er die
 * Datenbankdatei von Hand ersetzt und die Instanz zerlegt - der teure Teil des
 * Fehlers steckt nicht im Abbruch, sondern in dem, wozu die Auskunft einlädt.
 *
 * Unterschieden wird am Dateikopf, nicht geraten: eine unverschlüsselte
 * SQLite-Datei beginnt mit `SQLite format 3\0`. Fehlt der Kopf, ist die Datei
 * verschlüsselt ODER überhaupt keine Datenbank - beides kann von hier aus nicht
 * auseinandergehalten werden, deshalb nennt die Meldung den wahrscheinlichen
 * Fall zuerst und den anderen im letzten Satz.
 *
 * Die Auskunft hat es beim zweiten Anlauf erneut getan, und das ist der Grund
 * fuer die Fassung von jetzt: sie riet, DB_ENCRYPTION_KEY auf den Key der
 * Quellinstanz zu setzen und neu zu starten. Auf einer Instanz OHNE eigenen Key
 * stimmt das - ihre Klartextdatenbank wird beim Start mitverschluesselt, und
 * danach passt der Key zu beidem. Auf einer Instanz MIT eigenem Key ist es eine
 * Sackgasse: die eigene Datenbank ist mit dem alten Key verschluesselt, `init()`
 * bricht beim naechsten Start ab, und der Dialog, der den Rat gegeben hat, ist
 * nicht mehr erreichbar. Deshalb steht der Rat nur noch im `!DB_KEY`-Zweig; der
 * andere verweist auf den Weg ueber die Kommandozeile, der Datei und Key
 * zusammen umstellt (#1267).
 *
 * Beide Texte gelten nur fuer `SQLITE_NOTADB` - die Weiche davor steht in
 * `unreadableBackupError()` (#1283).
 */
function undecryptableBackupError(handle: DbHandle, cause: unknown): ReasonedError {
  if (!handle.dbKey) {
    return restoreError(
      'Backup file could not be read: it has no plain SQLite header, so it is likely encrypted - '
      + 'and DB_ENCRYPTION_KEY is not set on this instance, so there is nothing to decrypt it with. '
      + 'A backup carries the encryption of the instance that wrote it: set DB_ENCRYPTION_KEY to '
      + "that instance's key and restart Yuvomi, then restore again. If the file was never "
      + 'encrypted, it is not a valid Yuvomi database.',
      'own_key_missing',
      cause
    );
  }
  return restoreError(
    "Backup file could not be decrypted with this instance's DB_ENCRYPTION_KEY. A backup carries "
    + 'the encryption of the instance that wrote it, so a backup from another installation needs '
    + "that installation's key: enter it as the backup key and restore again (on the command "
    + 'line: `scripts/restore-backup.js <file> --backup-key-stdin`, with the key on stdin). It is used only for '
    + "this restore - the backup is re-encrypted with this instance's own key and the entered key "
    + 'is not stored. Do NOT just set DB_ENCRYPTION_KEY to that installation\'s key and restart: '
    + "this instance's own database is encrypted with the key it has now, so after the swap Yuvomi "
    + 'would not start at all and this dialog would be out of reach. The manual route, which '
    + 'replaces the database file and sets the key together with Yuvomi stopped, is under '
    + '"CLI / Docker Compose restore" on this page. If both installations really do have the same '
    + 'key, the file is not a Yuvomi database.',
    'backup_key_required',
    cause
  );
}

/**
 * Fehler mit maschinenlesbarem Grund fuer den Restore-Dialog (#1267): er
 * entscheidet daran, ob er das Feld fuer den Backup-Schluessel zeigt. Die
 * Meldung selbst nennt nie einen Schluessel, weder den eigenen noch den des
 * Backups.
 */
export function restoreError(message: string, reason: string, cause?: unknown): ReasonedError {
  const err: ReasonedError = cause === undefined ? new Error(message) : new Error(message, { cause });
  err.reason = reason;
  return err;
}

/**
 * Meldung für eine Backup-Datei, an der das Öffnen oder das erste Lesen
 * scheitert - getrennt nach dem, was SQLite tatsächlich sagt (#1283).
 *
 * Vor #1283 wurde jeder Fehler an dieser Stelle zur Schlüssel-Meldung, ohne
 * auf `err.code` zu sehen - dieselbe Lücke, die #1281 am Startpfad geschlossen
 * hat. Gemessen über die echte Restore-Route und das CLI-Skript:
 *   - `SQLITE_NOTADB`: fremder Key, eine Instanz ohne Key vor einem
 *     verschlüsselten Backup, und ebenso eine Datei, die schon innerhalb der
 *     ersten Seite abreißt (100 B, 2 KiB) - von einem falschen Key ist das von
 *     hier aus nicht zu unterscheiden, deshalb nennen beide Key-Texte die
 *     zweite Möglichkeit mit.
 *   - `SQLITE_CORRUPT`: das EIGENE Backup, abgeschnitten nach 4 KiB, 8 KiB,
 *     der Hälfte, allen Seiten bis auf eine, einem Byte zu wenig. Das gibt es
 *     nur mit dem richtigen Key: dieselbe Datei liefert mit falschem Key
 *     `SQLITE_NOTADB`, weil Seite 1 erst entschlüsselt werden und ihre
 *     HMAC-Prüfung bestehen muss. Die Schlüssel-Meldung schickte diesen Admin
 *     zur Übernahme eines fremden Backups über die Kommandozeile, die ihm
 *     nichts nützt. Ohne Key kann ein Backup ohne Klartext-Kopf gar nicht
 *     `SQLITE_CORRUPT` liefern (SQLite scheitert schon am Kopf, gemessen:
 *     `SQLITE_NOTADB`), und der Satz „der Key öffnet sie" wäre dort falsch -
 *     deshalb hängt der Zweig an `DB_KEY`.
 *   - alles andere: Code und SQLite-Text, kein Wort über den Key. Gemessen ist
 *     `SQLITE_CANTOPEN` für eine Datei ohne Leserecht (CLI-Restore einer als
 *     root kopierten Datei). Der Kopf ist dann gar nicht lesbar, `encrypted`
 *     steht deshalb auf true, und ohne diese Weiche sagte die Meldung mit Key
 *     „falscher Schlüssel" und ohne Key „wahrscheinlich verschlüsselt, setz
 *     DB_ENCRYPTION_KEY" - beides über eine Klartextdatei, die nur nicht
 *     lesbar war.
 * Eine Upload-Übertragung, die abreißt, kommt hier nie an: `express.raw()`
 * verwirft den Request mit `request.aborted`, bevor die Route läuft. Eine
 * unvollständige Datei ist also schon unvollständig hochgeladen worden -
 * meist ein Download oder eine Kopie, die zu früh aufgehört hat.
 *
 * Die Klartext-Auskunft bleibt ohne Weiche: sie sagt nichts über den Key.
 * @param encrypted  Datei hat keinen Klartext-SQLite-Kopf
 * @param cause      Fehler beim Öffnen oder ersten Lesen
 */
function unreadableBackupError(handle: DbHandle, encrypted: boolean, cause: unknown): ReasonedError {
  const code = typeof (cause as { code?: unknown } | null)?.code === 'string' ? (cause as { code: string }).code : '';
  if (!encrypted) {
    // Kopf da, aber schon die Schemaseite kaputt: ein beschaedigtes Backup,
    // keine fremde Datei - derselbe Grund wie aus `assertBackupIntact()`
    // (Codex-Befund in #1431).
    if (code.startsWith('SQLITE_CORRUPT')) {
      return restoreError(
        `Backup file is damaged (${code}: ${(cause as { message?: string } | null)?.message ?? String(cause)}). Its SQLite header is `
        + 'intact, but its schema page is not. Nothing on this instance was changed. Get the backup '
        + 'again from where it is stored and check that its size and sha256sum match the stored '
        + 'original, then restore that copy - or restore an older backup.',
        'backup_corrupt',
        cause
      );
    }
    // Ohne Grund (#1909): die Ursache steht nur im Stack, und den schreibt die
    // Route nur fuer Fehler ohne `reason` ins Log - die Seite zeigt dazu den
    // allgemeinen Satz, der auf das Server-Log zeigt.
    return new Error('Backup file is not a valid Yuvomi database.', { cause });
  }
  if (code === 'SQLITE_NOTADB') return undecryptableBackupError(handle, cause);

  const detail = `${code || 'no SQLite error code'}: ${(cause as { message?: string } | null)?.message ?? String(cause)}`;
  if (handle.dbKey && code.startsWith('SQLITE_CORRUPT')) {
    return restoreError(
      `Backup file is damaged or incomplete (${detail}). DB_ENCRYPTION_KEY is not the problem: it `
      + 'does open this file - its first page decrypted and passed the integrity check, which a '
      + 'wrong key never does. Most likely the file was cut short before it got here, by a download '
      + 'or copy that stopped early. Nothing on this instance was changed. Get the backup again from '
      + 'where it is stored - download or copy it once more - and check that its size and sha256sum '
      + 'match the stored original, then restore that copy.',
      'backup_corrupt',
      cause
    );
  }

  const lines = [`Backup file could not be read (${detail}).`];
  if (code.startsWith('SQLITE_CANTOPEN')) {
    lines.push('Check that the file is there and that the user this restore runs as may read it.');
  }
  return new Error(lines.join(' '), { cause });
}

/** Erste Zeile eines Befunds ohne die Kopfzeile `*** in database main ***`. */
function firstFinding(result: unknown): string {
  const text = String(result);
  return text.split('\n').find((line) => line.trim() && !line.startsWith('***')) ?? text;
}

/**
 * Jede Seite des Backups lesen, bevor es eingespielt wird (#1422).
 *
 * `assertReadable()` liest nur `sqlite_master`. Ein EIGENES Backup mit einer
 * kaputten Seite dahinter (gemessen: ein gekipptes Byte in Seite 5, mit und
 * ohne Schluessel) ging damit ohne Fehler durch, wurde eingespielt, und die
 * Instanz lief danach auf einer Datenbank, deren `quick_check` Hunderte
 * unerreichbare Seiten meldet. Der Weg mit Backup-Schluessel lehnte dieselbe
 * Datei schon ab - nur weil das Umschluesseln jede Seite anfasst.
 *
 * `quick_check` statt `integrity_check`: es liest jede Seite (mit Schluessel
 * also auch deren HMAC) und prueft den Aufbau jedes B-Baums, laeuft aber
 * linear. Was `integrity_check` zusaetzlich prueft - ob jeder Index genau zu
 * seiner Tabelle passt -, kann in einem Backup aus `VACUUM INTO` nur durch
 * eine kaputte Seite auseinanderlaufen, und die findet schon `quick_check`.
 * Gemessen mit Schluessel: 2 MB samt ganzem Restore unter 200 ms, 91 MB (300 000 Zeilen, zwei
 * Indizes) rund 0,9 s gegen 1,9 s fuer `integrity_check` - der Restore
 * blockiert solange den Server, deshalb die schnellere Pruefung.
 * `quick_check(1)` hoert nach dem ersten Befund auf; einer reicht. Es meldet
 * nicht nur kaputte Seiten, sondern auch Zeilen, die eine NOT-NULL-Regel
 * ihrer Tabelle verletzen (gemessen: „NULL value in a.x"; CHECK-Regeln prueft
 * es nicht) - deshalb sagt die Meldung „haelt nicht zusammen" und nicht
 * „Seite unlesbar".
 */
function assertBackupIntact(handle: DbHandle, candidate: SqliteDatabase, encrypted: boolean): void {
  let result: unknown;
  try {
    // Klartext: integrity_check. quick_check prueft nicht, ob jeder Index zu
    // seiner Tabelle passt, und ohne Seiten-HMAC kann ein gekipptes Byte in
    // einem indizierten Wert genau das auseinanderlaufen lassen - gemessen:
    // quick_check „ok", integrity_check „row missing from index" (Codex-Befund
    // in #1431). Verschluesselt: quick_check. Jede Seite traegt dort ein HMAC,
    // eine veraenderte Seite scheitert schon beim Lesen, und integrity_check
    // kostete fuer diesen Fall nur die doppelte Zeit.
    result = candidate.pragma(encrypted ? 'quick_check(1)' : 'integrity_check(1)', { simple: true });
  } catch (err) {
    const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : '';
    if (!code.startsWith('SQLITE_CORRUPT')) throw unreadableBackupError(handle, encrypted, err);
    result = `${code}: ${(err as Error).message}`;
  }
  if (result === 'ok') return;
  throw restoreError(
    `Backup file is damaged: the integrity check found an error in it (${firstFinding(result)}). `
    + 'Its first page opens, but the file does not hold together - a damaged page or a row that '
    + 'breaks a NOT NULL rule of its table - and restoring it would put a broken database in place. Nothing on '
    + 'this instance was changed. Get the backup again from '
    + 'where it is stored and check that its size and sha256sum match the stored original, then '
    + 'restore that copy - or restore an older backup.',
    'backup_corrupt'
  );
}

/**
 * Ein Backup pruefen, ohne es einzuspielen: dieselbe Validierung wie vor jedem
 * Restore (lesbar mit dem eigenen Schluessel, Integritaet, Yuvomi-Schema, keine
 * neuere Version). Liefert die Schema-Version; wirft mit derselben Meldung wie
 * der Restore.
 */
export function checkBackupFile(handle: DbHandle, sourcePath: string): number {
  return validateBackupFile(handle, sourcePath);
}

/**
 * Backup-Datei oeffnen und lesen wie vor einem Restore: mit dem eigenen
 * Schluessel, falls sie keinen Klartext-Kopf hat, `sqlite_master` lesbar, jede
 * Seite heil (`assertBackupIntact()`). Liefert die offene Verbindung; wirft
 * mit denselben Gruenden wie der Restore und schliesst sie dann selbst.
 */
function openIntactBackup(handle: DbHandle, sourcePath: string): SqliteDatabase {
  // Backups, die vor der Verschlüsselungs-Umstellung entstanden sind, liegen im
  // Klartext vor. Sie müssen einspielbar bleiben - würden wir ihnen den Key
  // aufsetzen, läse SQLite sie als verschlüsselt und die Validierung schlüge
  // fehl. Nach dem Restore verschlüsselt init() sie ohnehin.
  const encrypted = !handle.isPlaintextDatabase(sourcePath);
  let candidate: SqliteDatabase;
  try {
    candidate = new Database(sourcePath, { readonly: true, fileMustExist: true });
  } catch (err) {
    // Das Öffnen zählt mit: eine Datei, an der schon der Konstruktor scheitert,
    // liefe sonst an der Diagnose vorbei und käme als rohe SQLite-Zeile heraus.
    throw unreadableBackupError(handle, encrypted, err);
  }
  try {
    if (encrypted) handle.applyEncryptionKey(candidate);
    try {
      handle.assertReadable(candidate);
    } catch (err) {
      throw unreadableBackupError(handle, encrypted, err);
    }
    assertBackupIntact(handle, candidate, encrypted);
    return candidate;
  } catch (err) {
    candidate.close();
    throw err;
  }
}

/**
 * Ein frisch geschriebenes Backup pruefen, bevor es jemand bekommt (#2520).
 *
 * Ohne Pruefung ging jede Datei als gelungenes Backup durch - zum Download, in
 * die Rotation, nach WebDAV -, und ein Fehler zeigte sich erst beim Restore,
 * wenn die guten alten Backups womoeglich schon wegrotiert waren. Gemessen ist
 * der Fall, den die Backup-API ohne Schluessel mitbringt: sie kopiert die
 * Seiten der Live-Datenbank, einen kaputten Index also mit. Dieselbe Pruefung
 * wie vor dem Restore (`openIntactBackup()`), ohne dessen Schema- und
 * Versionsfragen: ein eigenes Backup traegt das eigene Schema, und eine
 * Instanz auf einer neueren Datenbank (`unknownMigrationVersions()`) soll ihre
 * Backups weiter bekommen.
 *
 * Die kaputte Datei wird geloescht: im Backup-Ordner zaehlte sie sonst bei
 * der naechsten Rotation als eines der aufbewahrten Backups.
 */
async function verifyWrittenBackup(handle: DbHandle, destinationPath: string): Promise<void> {
  try {
    openIntactBackup(handle, destinationPath).close();
  } catch (cause) {
    await unlinkIfExists(destinationPath);
    await removeCheckSideFiles(destinationPath);
    // Nur der erste Satz: der Rest der Restore-Meldung raet zum erneuten
    // Herunterladen, und das passt nicht zu einem Backup, das hier entsteht.
    const finding = String((cause as { message?: string } | null)?.message ?? cause).split('. ')[0];
    throw restoreError(
      `Backup failed its integrity check and was discarded (${finding}). `
      + 'Older backups were kept. The database this instance runs on may be damaged: check it '
      + 'with `PRAGMA integrity_check` and check the disk it is stored on.',
      'backup_verify_failed',
      cause
    );
  }
  await removeCheckSideFiles(destinationPath);
}

/**
 * Eine Kopie aus der Backup-API traegt den WAL-Modus der Live-Datenbank, und
 * schon das Oeffnen zum Pruefen legt `-wal` und `-shm` daneben an. Die
 * Verbindung war nur lesend, die beiden Dateien sind also leer - im
 * Backup-Ordner laegen sie sonst neben jedem Backup, und die Rotation raeumt
 * nur `.db`-Dateien.
 */
async function removeCheckSideFiles(destinationPath: string): Promise<void> {
  await unlinkIfExists(`${destinationPath}-wal`);
  await unlinkIfExists(`${destinationPath}-shm`);
}

export function validateBackupFile(handle: DbHandle, sourcePath: string): number {
  const candidate = openIntactBackup(handle, sourcePath);
  try {
    const row = candidate.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'schema_migrations'
    `).get();
    if (!row) {
      throw restoreError('Backup file is not a valid Yuvomi database.', 'backup_not_yuvomi');
    }
    // Backup aus einer neueren Yuvomi-Version: ablehnen, bevor irgendetwas
    // kopiert wird. Eingespielt liefe diese App stumm gegen ein Schema, das
    // sie nicht kennt; der richtige erste Schritt ist das Update.
    const unknown = unknownMigrationVersions(candidate);
    if (unknown.length > 0) {
      throw restoreError(
        `Backup was written by a newer Yuvomi (schema v${unknown[unknown.length - 1]}; this ` +
        `version knows up to v${latestKnownVersion()}). Update Yuvomi first, then restore.`,
        'backup_newer_version'
      );
    }
    return (candidate.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null } | undefined)?.version ?? 0;
  } finally {
    candidate.close();
  }
}

export async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') throw err;
  }
}
