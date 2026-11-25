/**
 * Modul: Restore (restore)
 * Zweck: Ein Backup einspielen: Backup einer anderen Installation auf den
 *        eigenen Schluessel umschluesseln (#1267), Arbeitsdatei neben DB_PATH,
 *        unteilbarer Tausch und Rollback (#1422, #1431), Backup-Status der
 *        Installation mitnehmen, Reste eines abgebrochenen Restores beim Start
 *        wegraeumen, und das Schliessen zum Prozessende. Jede Funktion, die
 *        Verbindung, DB_PATH, Schluessel oder den Restore-Riegel braucht,
 *        bekommt den Griff ihrer Instanz von server/db.js als ersten Parameter
 *        (./handle.ts); server/db.js re-exportiert sie ohne ihn.
 * Abhängigkeiten: ../utils/sqlite-driver.js, ../utils/restore-state.js,
 *                 ../utils/restore-messages.js, ../utils/backup-status.js,
 *                 ./backup.ts, ./migrate.ts
 */

import Database from '../utils/sqlite-driver.js';
import path from 'path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync, rmSync, statSync, readdirSync, constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createLogger } from '../logger.js';
import { RESTORE_IN_PROGRESS_MESSAGE, RESTORE_IN_PROGRESS_REASON } from '../utils/restore-messages.js';
import { setRestoreRunning, activeWriters, restoreWaitTimeoutMs, waitUntilIdle } from '../utils/restore-state.js';
import { BACKUP_STATUS_KEYS } from '../utils/backup-status.js';
import { schemaVersion } from './migrate.ts';
import { restoreError, validateBackupFile, unlinkIfExists } from './backup.ts';
import type { ReasonedError } from './backup.ts';
import type { DbHandle, SqliteDatabase } from './handle.ts';
import { withTx } from './tx.ts';

const log = createLogger('DB');

/** Was `restoreFromFile()` zurueckgibt. */
type RestoreResult = { schemaVersion: number; rollbackPath: string | null; keptJournalPath: string | null };

/** Datei umbenennen; `false`, wenn es sie nicht gibt. */
async function renameIfExists(from: string, to: string): Promise<boolean> {
  try {
    await fs.rename(from, to);
    return true;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') throw err;
    return false;
  }
}

/**
 * Wohin `restoreFromFile()` das Journal einer leeren Datei legt: neben die
 * Rollback-Kopie, aber unter einem Namen, den SQLite nicht von selbst aufgreift
 * (`<kopie>.wal-kept`, nicht `<kopie>-wal`).
 */
function keptJournalName(rollbackPath: string, kind: string): string {
  return `${rollbackPath}.${kind}-kept`;
}

/** `true`, wenn DB_ENCRYPTION_KEY dieser Instanz die Datei oeffnet und liest. */
function opensWithOwnKey(handle: DbHandle, filePath: string): boolean {
  if (!handle.dbKey) return false;
  let candidate: SqliteDatabase | undefined;
  try {
    candidate = new Database(filePath, { readonly: true, fileMustExist: true }) as SqliteDatabase;
    handle.applyEncryptionKey(candidate);
    handle.assertReadable(candidate);
    return true;
  } catch {
    // Jeder Fehler heisst nur „nicht mit diesem Schluessel" - die Diagnose
    // uebernimmt der Weg mit dem Backup-Schluessel.
    return false;
  } finally {
    candidate?.close();
  }
}

/** Backup-Schluessel als Bytes; `null`, wenn keiner (oder ein leerer) gegeben ist. */
function backupKeyBytes(backupKey: string | Buffer | null | undefined): Buffer | null {
  if (backupKey == null) return null;
  const bytes = Buffer.isBuffer(backupKey) ? backupKey : Buffer.from(String(backupKey), 'utf8');
  return bytes.length > 0 ? bytes : null;
}

/**
 * Warum der Backup-Schluessel die Datei nicht oeffnet - getrennt wie in
 * `unreadableBackupError()`: nur `SQLITE_NOTADB` heisst „falscher Schluessel",
 * `SQLITE_CORRUPT` gibt es nur mit dem richtigen (Seite 1 hat die HMAC-Pruefung
 * bestanden).
 */
function foreignKeyReadError(cause: unknown, { keyProven = false }: { keyProven?: boolean } = {}): ReasonedError {
  const code = typeof (cause as { code?: unknown } | null)?.code === 'string' ? (cause as { code: string }).code : '';
  if (code === 'SQLITE_NOTADB' && !keyProven) {
    return restoreError(
      'Backup file could not be decrypted with the backup key you entered. It has to be exactly '
      + 'the DB_ENCRYPTION_KEY of the installation that wrote this backup - every character counts, '
      + 'including spaces at either end. Nothing on this instance was changed. If the key is right, '
      + 'the file is not a Yuvomi database or was cut short before it got here.',
      'backup_key_wrong',
      cause
    );
  }
  // Node-Fehler (etwa EACCES aus copyFile) tragen den Code schon am Anfang
  // ihrer Meldung - dann nicht ein zweites Mal davorsetzen.
  const text = (cause as { message?: string } | null)?.message ?? String(cause);
  const detail = code && text.startsWith(`${code}:`) ? text : `${code || 'no SQLite error code'}: ${text}`;
  // Gemessen scheitert eine spaetere Seite beim Umschluesseln immer mit
  // SQLITE_CORRUPT. Der NOTADB-Zweig mit `keyProven` ist in keiner Messung
  // aufgetreten; er ist defensiv und sichert ab, dass ein nach bewiesenem
  // Schluessel doch gemeldetes NOTADB nie als „falscher Schluessel" ankommt.
  if (code.startsWith('SQLITE_CORRUPT') || (keyProven && code === 'SQLITE_NOTADB')) {
    return restoreError(
      `Backup file is damaged or incomplete (${detail}). The backup key is right: it opens the `
      + 'first page, which a wrong key never does. Nothing on this instance was changed. Get the '
      + 'backup again from where it is stored and check that its size and sha256sum match the '
      + 'stored original, then restore that copy.',
      'backup_damaged',
      cause
    );
  }
  return restoreError(
    `Backup file could not be read (${detail}). Nothing on this instance was changed.`,
    'backup_unreadable',
    cause
  );
}

/**
 * Backup einer ANDEREN Installation auf den eigenen Schluessel umschluesseln (#1267).
 *
 * Entschieden in #1267: der Schluessel des Backups lebt nur fuer diesen
 * Restore, die Datenbank wird auf DB_ENCRYPTION_KEY dieser Instanz
 * umgeschluesselt. Der eigene Schluessel bleibt die eine Quelle der Wahrheit -
 * jede Alternative (alten Key in die Env schreiben, nur im Speicher halten,
 * Key-Datei auf dem Volume) endete am naechsten Neustart oder neben den Daten.
 *
 * Gearbeitet wird an einer Kopie in einem eigenen Temp-Verzeichnis, nie an
 * DB_PATH: erst wenn die Kopie mit dem alten Schluessel lesbar war und auf den
 * neuen umgestellt ist, laeuft sie in den bestehenden Restore - der sie mit dem
 * EIGENEN Schluessel validiert und dann erst die Datenbank tauscht. Ein
 * falscher Schluessel endet also vor jeder Aenderung an dieser Instanz.
 * `PRAGMA rekey` schreibt die Seiten verschluesselt um; die Datei liegt zu
 * keinem Zeitpunkt entschluesselt auf der Platte.
 *
 * Ohne eigenen Schluessel wird abgelehnt: umschluesseln ginge hier nur auf
 * Klartext, und ein still entschluesseltes Backup unterliefe die
 * Verschluesselung der Quellinstanz.
 *
 */
async function rekeyForeignBackup(handle: DbHandle, sourcePath: string, oldKey: Buffer): Promise<{ dir: string, path: string }> {
  if (!handle.dbKey) {
    throw restoreError(
      'A backup key was given, but DB_ENCRYPTION_KEY is not set on this instance. A restore with a '
      + "backup key re-encrypts the backup with this instance's own key; without one it would have "
      + 'to be stored decrypted, and this restore refuses that. Set DB_ENCRYPTION_KEY on this '
      + 'instance (for example to a value from `openssl rand -hex 32`) and restart Yuvomi - its '
      + 'current database is encrypted with it on that start - then restore again with the backup '
      + 'key. Nothing on this instance was changed.',
      'own_key_missing'
    );
  }
  handle.assertCipherSupport();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuvomi-rekey-'));
  const workingPath = path.join(dir, 'rekeyed.db');
  try {
    try {
      await fs.copyFile(sourcePath, workingPath);
    } catch (err) {
      throw foreignKeyReadError(err);
    }
    let working: SqliteDatabase;
    try {
      working = new Database(workingPath, { fileMustExist: true });
    } catch (err) {
      throw foreignKeyReadError(err);
    }
    try {
      working.pragma('temp_store = MEMORY');
      handle.applyKeyBytes(working, oldKey);
      try {
        handle.assertReadable(working);
      } catch (err) {
        throw foreignKeyReadError(err);
      }
      // Ein Backup aus `VACUUM INTO` einer WAL-Datenbank traegt das WAL-Flag
      // im Kopf. DELETE haelt das Umschluesseln in EINER Datei: ohne entstuende
      // ein `-wal` neben der Arbeitskopie im Temp-Verzeichnis. init() stellt
      // nach dem Restore ohnehin wieder auf WAL.
      try {
        working.pragma('journal_mode = DELETE');
        working.pragma(`rekey="x'${Buffer.from(handle.dbKey as string, 'utf8').toString('hex')}'"`);
      } catch (err) {
        // Seite 1 ist oben mit diesem Schluessel entschluesselt worden - ein
        // Fehler hier liegt nicht am Schluessel: an einer spaeteren Seite
        // (SQLITE_CORRUPT) oder am Temp-Verzeichnis (SQLITE_FULL, SQLITE_IOERR,
        // voller Datentraeger), das dann als backup_unreadable ankommt.
        throw foreignKeyReadError(err, { keyProven: true });
      }
    } finally {
      working.close();
    }
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return { dir, path: workingPath };
}

/**
 * Backup einspielen.
 * @param options `backupKey`: der
 *   DB_ENCRYPTION_KEY der Installation, die das Backup geschrieben hat - nur
 *   fuer ein verschluesseltes Backup einer ANDEREN Installation (#1267). Er
 *   wird nicht gespeichert und steht in keiner Meldung.
 */
export async function restoreFromFile(handle: DbHandle, sourcePath: string, { backupKey = null }: { backupKey?: string | Buffer | null } = {}): Promise<RestoreResult> {
  if (handle.restoreRunning) {
    throw restoreError(RESTORE_IN_PROGRESS_MESSAGE, RESTORE_IN_PROGRESS_REASON);
  }
  handle.restoreRunning = true;
  setRestoreRunning(true);
  try {
    // Erst die Jobs zu Ende kommen lassen, die schon nach aussen schreiben
    // (Kalender-Sync, Push, ...): sie muessen ihr Ergebnis noch zurueckschreiben
    // koennen, sonst bleibt der entfernte Stand ohne Link (Codex-Befund in
    // #1431). Neue beginnen ab `setRestoreRunning(true)` nicht mehr, und
    // schreibende Requests weist `restoreWriteGate` ab derselben Zeile ab.
    // Schon zugelassene schreibende Requests laufen zu Ende und landen in der
    // alten Datenbank, nie in der eingespielten (Codex-Befund in #1431).
    // Hoechstens `restoreWaitTimeoutMs()` lang, dann Abbruch vor jeder
    // Aenderung (Review #1431).
    await waitForQuietOrGiveUp(handle);
    // Ab jetzt nimmt die laufende Verbindung keine Schreibzugriffe mehr an
    // (Codex-Befund in #1431): seit die Arbeitsdatei VOR dem Schliessen kopiert
    // wird, bleibt sie waehrenddessen offen, und ein Schreibzugriff meldete
    // Erfolg, den Checkpoint, Schliessen und rename danach verwarfen. Die neue
    // Verbindung nach dem Tausch beginnt ohne den Riegel, nach einem
    // Fehlschlag wird er unten geloest.
    try { handle.db?.pragma('query_only = ON'); } catch { /* ohne Verbindung nichts zu sperren */ }
    return await restoreFromFileUnlocked(handle, sourcePath, { backupKey });
  } finally {
    handle.restoreRunning = false;
    setRestoreRunning(false);
    try { handle.db?.pragma('query_only = OFF'); } catch { /* best effort */ }
  }
}

/**
 * Auf laufende Backups, Jobs und zugelassene Anfragen warten - hoechstens
 * `restoreWaitTimeoutMs()`. Laeuft die Frist ab, bricht der Restore ab, bevor er
 * die Verbindung sperrt oder etwas aendert, mit einem Grund, den der Dialog
 * uebersetzt (Review #1431).
 */
async function waitForQuietOrGiveUp(handle: DbHandle): Promise<void> {
  const quiet = await waitUntilIdle(
    () => [...handle.activeBackups, ...activeWriters()],
    Date.now() + restoreWaitTimeoutMs()
  );
  if (quiet) return;
  const seconds = Math.round(restoreWaitTimeoutMs() / 1000);
  throw restoreError(
    `Yuvomi is still busy: a sync, a backup or a request had not finished after ${seconds} seconds, `
    + 'so the restore did not start. Nothing on this instance was changed. Try again in a moment.',
    'restore_busy'
  );
}

/**
 * Die Verbindung zum Prozessende schliessen (SIGTERM/SIGINT, server/index.js).
 *
 * Wartet wie der Restore auf laufende Backups, Jobs und zugelassene Anfragen,
 * hoechstens bis `deadline`, checkpointet das Journal und schliesst. Erst das
 * Schliessen raeumt `-wal` und `-shm` weg. Ein Job, der die Frist reisst, wird
 * mit dem Prozess abgebrochen wie zuvor beim SIGKILL - seine Transaktionen sind
 * synchron und damit schon ganz geschrieben oder gar nicht.
 *
 * Waehrend eines Restores bleibt die Verbindung, wie sie ist: der Restore haelt
 * sie selbst, und ein Abbruch mittendrin ist mit Arbeitsdatei und Rollback-Kopie
 * schon abgefangen (#1431).
 * @param deadline Zeitpunkt in ms
 * @returns `true`, wenn nichts mehr lief und die Verbindung zu ist
 */
export async function closeForShutdown(handle: DbHandle, deadline: number): Promise<boolean> {
  const quiet = await waitUntilIdle(() => [...handle.activeBackups, ...activeWriters()], deadline);
  if (handle.restoreRunning || !handle.db) return false;
  try { handle.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  handle.db.close();
  handle.setDb(null);
  return quiet;
}

/** Laeuft gerade ein Restore? Fuer `restoreWriteGate`. */
export function isRestoreRunning(handle: DbHandle): boolean {
  return handle.restoreRunning;
}

/**
 * Ist die Verbindung offen? Waehrend eines Restores ist sie es vom Schliessen
 * bis zum Wiederoeffnen nicht - dann beantwortet `restoreWriteGate` auch
 * lesende API-Anfragen mit 503 (Review #1431).
 */
export function isDatabaseOpen(handle: DbHandle): boolean {
  return Boolean(handle.db);
}

/**
 * `true`, wenn `sourcePath` dieselbe Datei ist wie DB_PATH (auch per Symlink
 * oder hartem Link). Ein Restore der laufenden Datenbank auf sich selbst
 * kopierte die Hauptdatei VOR dem Checkpoint: was nur im `-wal` stand, fehlte
 * der Arbeitsdatei, und das rename haengte diesen alten Stand als „Erfolg" ein
 * (Codex-Befund in #1431).
 */
function isActiveDatabaseFile(handle: DbHandle, sourcePath: string): boolean {
  try {
    // bigint: grosse Inode-Nummern (manche Netz- und Overlay-Dateisysteme)
    // passen nicht verlustfrei in eine Zahl.
    const source = statSync(sourcePath, { bigint: true });
    const active = statSync(handle.dbPath, { bigint: true });
    return source.dev === active.dev && source.ino === active.ino;
  } catch {
    return false;
  }
}

async function restoreFromFileUnlocked(handle: DbHandle, sourcePath: string, { backupKey }: { backupKey: string | Buffer | null }): Promise<RestoreResult> {
  if (isActiveDatabaseFile(handle, sourcePath)) {
    throw new Error(
      `Backup file ${sourcePath} is the active database itself (DB_PATH). Restoring it onto itself `
      + 'would drop the changes that are still only in its write-ahead log. Nothing on this instance '
      + 'was changed. Restore a backup file instead - download one under Settings, Backup, or copy '
      + 'the database file while Yuvomi is stopped.'
    );
  }
  const oldKey = backupKeyBytes(backupKey);
  // Ein Klartext-Backup braucht keinen Schluessel - es laeuft wie bisher und
  // wird von init() mit dem eigenen verschluesselt.
  // Oeffnet der EIGENE Schluessel das Backup, ist es eines dieser Installation
  // und der Backup-Schluessel gar nicht gefragt - etwa bei einem API-Client,
  // der den Header immer mitschickt.
  const rekeyed = oldKey && !handle.isPlaintextDatabase(sourcePath) && !opensWithOwnKey(handle, sourcePath)
    ? await rekeyForeignBackup(handle, sourcePath, oldKey)
    : null;
  try {
    return await restoreValidatedFile(handle, rekeyed?.path ?? sourcePath);
  } finally {
    if (rekeyed) await fs.rm(rekeyed.dir, { recursive: true, force: true }).catch(() => {});
  }
}

const RESTORE_STAGING_SUFFIX = '.restore-tmp';

/**
 * Arbeitsname, unter dem `restoreFromFile()` die neue Datenbank ablegt, bevor
 * sie an `DB_PATH` gehaengt wird (#1422). Neben `DB_PATH`, nicht im
 * Temp-Verzeichnis: nur im selben Verzeichnis ist das Umhaengen ein `rename()`
 * innerhalb eines Dateisystems und damit unteilbar - wie `.creating` (#1287).
 */
function restoreStagingPath(handle: DbHandle): string {
  // Eigener Name je Restore: ein Restore aus einem zweiten Prozess (CLI neben
  // dem laufenden Server) ueberschreibt so nie die Arbeitsdatei des ersten.
  return `${handle.dbPath}${RESTORE_STAGING_SUFFIX}-${process.pid}-${Date.now().toString(36)}`;
}

/**
 * Codes, mit denen ein Dateisystem sagt, dass es fsync auf ein Verzeichnis
 * nicht kann - nicht, dass es gescheitert ist. EISDIR/EACCES/EPERM kommen beim
 * Oeffnen eines Verzeichnisses (Windows, manche Netzfreigaben), EINVAL,
 * ENOTSUP/EOPNOTSUPP und EBADF vom fsync selbst (FUSE, SMB, NFS-Varianten).
 */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF']);

/**
 * Verzeichnis-Eintrag auf die Platte bringen. Kann das Dateisystem das nicht,
 * bleibt es beim unteilbaren rename (nur nicht sofort dauerhaft). Ein echter
 * Fehler (EIO, ENOSPC, ...) geht weiter: der Aufrufer bricht ab bzw. meldet,
 * statt einen nicht bestaetigten Tausch als Erfolg auszugeben (Codex-Befund in #1431).
 */
async function syncDirectory(dirPath: string): Promise<void> {
  let fileHandle: FileHandle | undefined;
  try {
    fileHandle = await fs.open(dirPath, 'r');
    await fileHandle.sync();
  } catch (err) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has((err as { code?: string } | null)?.code as string)) throw err;
  } finally {
    await fileHandle?.close().catch(() => {});
  }
}

/**
 * Die fertige Arbeitsdatei unteilbar an `DB_PATH` haengen (#1422). Sie ist
 * vorher vollstaendig neben `DB_PATH` kopiert und auf die Platte gebracht
 * (`stageDatabaseCopy()`); hier wird nur noch umbenannt.
 *
 * Vorher wurde das Backup direkt ueber `DB_PATH` kopiert. Ein Kopieren ist
 * nicht unteilbar: starb der Prozess mittendrin oder lief die Platte voll,
 * lag an `DB_PATH` eine halb geschriebene Datei - halb Backup, halb nichts -,
 * und der naechste Start fand eine kaputte Datenbank. Der Rueckweg ueber
 * `.pre-restore-*` stand zwar da, aber nichts sagte dem Admin, dass er ihn
 * braucht. Jetzt ist `DB_PATH` zu jedem Zeitpunkt entweder die alte oder die
 * neue Datenbank: bis zum `rename()` ist nur die Arbeitsdatei betroffen, und
 * die raeumt der naechste Start weg (`removeRestoreStaging()`).
 *
 * Die Verbindung muss dafuer zu sein, und `-wal`/`-shm` der alten Datenbank
 * muessen VOR dem Umhaengen weg sein: SQLite wendete ein liegengebliebenes
 * `-wal` sonst auf die neue Datei an. Beides erledigt der Aufrufer.
 * DB_PATH muss eine echte Datei sein, kein Symlink: `rename()` ersetzt den
 * Verzeichniseintrag, einen Symlink also durch die Datei, statt ihm zu folgen.
 * Dasselbe gilt schon fuer die Verschluesselungs-Migration und `.creating`;
 * docs/installation.md sagt es beim Restore.
 * @param stagingPath  fertig geschriebene Arbeitsdatei oder, beim
 *   Rollback, die Rollback-Kopie
 */
async function swapIntoDbPath(handle: DbHandle, stagingPath: string, onRenamed: () => void = () => {}): Promise<void> {
  await fs.rename(stagingPath, handle.dbPath);
  // Sofort vermerken: scheitert der fsync danach, liegt die Datei trotzdem
  // schon an DB_PATH, und der Aufrufer muss das wissen.
  onRenamed();
  await syncDirectory(path.dirname(handle.dbPath));
}

/** `from` nach `stagingPath` kopieren und die Datei auf die Platte bringen. */
async function stageDatabaseCopy(handle: DbHandle, from: string, stagingPath: string): Promise<void> {
  await unlinkIfExists(stagingPath);
  await fs.copyFile(from, stagingPath);
  await adoptDatabaseAttributes(handle, stagingPath);
  // Schreibend oeffnen, wo es geht: Windows (FlushFileBuffers) verlangt fuer
  // fsync einen Handle mit Schreibrecht und antwortet sonst mit EPERM - ein
  // Restore unter Node nativ auf Windows blieb daran stehen (#1441). Traegt
  // die Datei keine Schreibrechte, genuegt ausserhalb von Windows ein lesender
  // Handle wie bisher.
  let fileHandle: FileHandle;
  try {
    fileHandle = await fs.open(stagingPath, 'r+');
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'EACCES' && (err as { code?: unknown } | null)?.code !== 'EPERM') throw err;
    fileHandle = await fs.open(stagingPath, 'r');
  }
  try {
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
}

/**
 * Rechte und, soweit erlaubt, Besitzer der bisherigen Datenbank auf die
 * Arbeitsdatei uebertragen (Codex-Befunde in #1431).
 *
 * `copyFile` gibt der neuen Datei die Rechte der QUELLE und den Nutzer, der
 * kopiert, als Besitzer - und das rename macht beides zu denen von DB_PATH.
 * Das fruehere Kopieren UEBER DB_PATH behielt die Datei und damit beides.
 * Gemessen wurde: ein Backup von schreibgeschuetztem Medium (0444) machte die
 * Arbeitsdatei 0444, und ein CLI-Restore als root hinterliesse eine Datenbank,
 * die der Dienst nach dem Neustart nicht schreiben darf. Der Besitzerwechsel
 * gelingt nur als root oder wenn er ohnehin stimmt; sonst bleibt er, wie er
 * ist. Ohne bisherige Datenbank: 0600, lesbar nur fuer den Dienst.
 */
/**
 * Kann, wer die bisherige Datenbank schreiben durfte, auch die neue Datei
 * schreiben? Besitzer gleich: Besitzerbit; sonst Gruppe gleich: Gruppenbit.
 * Wer nur ueber die Gruppe schrieb, schreibt so weiter; wer Besitzer war und
 * es nicht mehr ist, verliert das Recht (ausser die Datei ist fuer alle
 * schreibbar).
 */
function stillWritableForPreviousWriters(staged: Stats, previous: Stats, { processMayWritePrevious = false }: { processMayWritePrevious?: boolean } = {}): boolean {
  const mode = staged.mode;
  if (mode & 0o002) return true;
  // Die Arbeitsdatei gehoert immer dem laufenden Prozess. Durfte er die
  // bisherige Datenbank schreiben, ist er der Dienst oder hat dessen Rechte -
  // dann genuegt sein Besitzer-Schreibbit, auch bei anderer uid und gid als die
  // alte Datei (Review #1431).
  if (processMayWritePrevious && staged.uid === process.geteuid?.() && (mode & 0o200) !== 0) return true;
  if (staged.uid === previous.uid) return (mode & 0o200) !== 0;
  if (staged.gid === previous.gid) return (mode & 0o020) !== 0;
  return false;
}

async function adoptDatabaseAttributes(handle: DbHandle, filePath: string): Promise<void> {
  let previous: Stats | null = null;
  try { previous = await fs.stat(handle.dbPath); } catch { /* keine bisherige Datenbank */ }
  try {
    await fs.chmod(filePath, previous ? previous.mode & 0o7777 : 0o600);
  } catch (err) {
    // FUSE- und SMB-Mounts eines NAS lehnen chmod oft ab - dann gelten ihre
    // eigenen Rechte. Abbrechen nur, wenn der Besitzer die Datei so nicht
    // schreiben kann: sie wird gleich DB_PATH.
    const mode = (await fs.stat(filePath)).mode;
    if ((mode & 0o200) === 0) throw err;
    log.warn(`Could not set the mode of ${filePath} (${(err as { code?: unknown } | null)?.code ?? err}); keeping the one the file system gave it.`);
  }
  if (previous) {
    try {
      await fs.chown(filePath, previous.uid, previous.gid);
    } catch (err) {
      // Nur als root oder ohne Wechsel erlaubt. Abbrechen, vor dem Tausch, nur
      // wenn die Datei so fuer die bisherigen Schreiber der Datenbank NICHT
      // schreibbar waere (Codex-Befund in #1431) - verglichen wird mit Besitzer
      // UND Gruppe der bisherigen Datei, wie im chmod-Zweig ueber die
      // Modusbits. Eine Datenbank root:node 0660 mit dem Dienst als node
      // (TrueNAS, Entrypoint ohne chown) besteht so ueber die Gruppe; eine
      // gleichbleibende uid (SMB-Mounts melden jeder Datei dieselbe) ohnehin.
      const staged = await fs.stat(filePath);
      // Nur im Dienst selbst (Restore aus der App) ist die eigene euid die des
      // Dienstes. Das Restore-CLI (Handschlag gesetzt) kann root oder ein
      // Gruppenmitglied sein, das die alte Datei schreiben darf, der Dienst
      // die neue aber nicht - dort gelten nur Besitzer und Gruppe (Review #1431).
      let processMayWritePrevious = false;
      if ((globalThis as unknown as Record<symbol, unknown>)[handle.restoreTargetHandshake] !== true) {
        try {
          await fs.access(handle.dbPath, fsConstants.W_OK);
          processMayWritePrevious = true;
        } catch { /* der laufende Prozess darf die bisherige Datenbank nicht schreiben */ }
      }
      if (!stillWritableForPreviousWriters(staged, previous, { processMayWritePrevious })) {
        throw new Error(
          `Could not give ${filePath} the owner of the current database (uid ${previous.uid}, gid `
          + `${previous.gid}; it belongs to uid ${staged.uid}, gid ${staged.gid}): ${(err as { code?: unknown } | null)?.code ?? err}. `
          + 'Yuvomi would not be able to write the restored database. Nothing on this instance was '
          + 'changed. Run the restore as the user Yuvomi runs as, or as root.',
          { cause: err }
        );
      }
    }
  }
}

const ROLLBACK_PARTIAL_SUFFIX = '.partial';

/**
 * Lebt der Prozess, der eine liegengebliebene Datei angelegt hat, noch - und
 * ist es nicht dieser? `process.kill(pid, 0)` prueft nur, sendet nichts;
 * `EPERM` heisst „gibt es, gehoert einem anderen Benutzer".
 *
 * Grenze: die Nummer gilt nur im selben PID-Namensraum. Ein CLI-Restore per
 * `docker compose run` laeuft in einem eigenen Container; seine Nummer kann
 * hier einen fremden Prozess treffen (dann bleibt die Datei bis zum naechsten
 * Start liegen) oder keinen (dann wird sie geloescht). Trifft das seine
 * Arbeitsdatei, scheitert sein rename auf DB_PATH; trifft es seine halbe
 * Rollback-Kopie, scheitert deren rename, und `restoreValidatedFile()` bricht
 * deshalb ab (ENOENT zaehlt dort nur, wenn DB_PATH vorher fehlte). In beiden
 * Faellen vor dem Tausch: DB_PATH bleibt die alte Datenbank.
 */
function otherProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'EPERM';
  }
}

/**
 * Reste eines abgebrochenen Restores wegraeumen: die Arbeitsdatei
 * (`<DB_PATH>.restore-tmp-<pid>-<zeit>`) und eine halbe Rollback-Kopie
 * (`<DB_PATH>.pre-restore-<zeit>.<pid>.partial`). Die Arbeitsdatei ist nie an
 * `DB_PATH` gehaengt worden - die Datenbank ist die alte, und das Backup liegt
 * dort, woher es kam. Ohne Aufraeumen laege eine vollstaendige Kopie des
 * Backups im Datenverzeichnis, bei einem Klartext-Backup sogar unverschluesselt.
 *
 * Jeder Prozess, der db.js laedt, laeuft hier durch (`init()`). Eine Datei,
 * deren Prozess noch lebt, gehoert zu einem laufenden Restore und bleibt
 * liegen (Review #1431) - siehe `otherProcessAlive()` fuer die Grenze.
 * Der Compose-Restore aus docs/installation.md schreibt die Nummer 0: er laeuft
 * bei gestopptem Server in einem eigenen Container, dessen Nummern hier nichts
 * bedeuten - 0 heisst „kein Eigentuemer", sein Rest wird immer weggeraeumt.
 */
export function removeRestoreStaging(handle: DbHandle): void {
  if (handle.dbPath === ':memory:') return;
  const dir = path.dirname(handle.dbPath);
  const base = path.basename(handle.dbPath);
  const stagingPrefix = `${base}${RESTORE_STAGING_SUFFIX}-`;
  const rollbackPrefix = `${base}.pre-restore-`;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    let pid: number;
    if (name.startsWith(stagingPrefix)) {
      pid = Number(name.slice(stagingPrefix.length).split('-')[0]);
    } else if (name.startsWith(rollbackPrefix) && name.endsWith(ROLLBACK_PARTIAL_SUFFIX)) {
      const parts = name.slice(0, -ROLLBACK_PARTIAL_SUFFIX.length).split('.');
      pid = Number(parts[parts.length - 1]);
    } else {
      continue;
    }
    if (otherProcessAlive(pid)) continue;
    const leftover = path.join(dir, name);
    log.info(`${leftover} is left over from a restore that was interrupted before the swap - removing it. The database is the one from before that restore.`);
    try { rmSync(leftover, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * The stored status of the last local backup (Phase 1b section F, E12), read
 * from the database a restore is about to replace. It describes the backups of
 * THIS installation - when the scheduler last ran here and why it failed - and
 * the restored file brings the status of the moment it was written, or that of
 * another installation. `null` for a key means "no row".
 * @returns null when it cannot be read
 */
function readBackupStatus(database: SqliteDatabase): Record<string, string | null> | null {
  try {
    const read = database.prepare('SELECT value FROM sync_config WHERE key = ?');
    return Object.fromEntries(Object.values(BACKUP_STATUS_KEYS).map((key) => [key, (read.get(key) as { value: string | null } | undefined)?.value ?? null]));
  } catch (err) {
    log.warn(`Could not read the backup status before the restore: ${(err as { code?: unknown } | null)?.code ?? 'unknown error'}`);
    return null;
  }
}

/**
 * Put the carried status into the restored database: each key gets the value
 * this installation had, a key it did not have is removed. Without a carried
 * status (a restore onto an empty or unreadable database, as the CLI does on a
 * new server) the keys of the restored file are removed as well - this
 * installation has not made a backup yet. A failure here is logged and never
 * fails the restore: the next backup run writes the status anew.
 */
function writeBackupStatus(database: SqliteDatabase, carried: Record<string, string | null> | null): void {
  try {
    const upsert = database.prepare(`
      INSERT INTO sync_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `);
    const remove = database.prepare('DELETE FROM sync_config WHERE key = ?');
    withTx(database, () => {
      for (const key of Object.values(BACKUP_STATUS_KEYS)) {
        const value = carried?.[key] ?? null;
        if (value === null) remove.run(key);
        else upsert.run(key, value);
      }
    });
  } catch (err) {
    log.warn(`Could not carry the backup status into the restored database: ${(err as { code?: unknown } | null)?.code ?? 'unknown error'}`);
  }
}

async function restoreValidatedFile(handle: DbHandle, sourcePath: string): Promise<RestoreResult> {
  const backupVersion = validateBackupFile(handle, sourcePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rollbackPath = `${handle.dbPath}.pre-restore-${timestamp}`;
  // Mit Prozessnummer wie die Arbeitsdatei: `removeRestoreStaging()` laesst
  // die Datei eines noch laufenden fremden Prozesses liegen.
  const rollbackPartialPath = `${rollbackPath}.${process.pid}${ROLLBACK_PARTIAL_SUFFIX}`;
  const stagingPath = restoreStagingPath(handle);
  let rollbackCreated = false;
  // Offen ist die Verbindung, außer im Leer-Fall des Restore-CLI (#1282, siehe
  // Auto-Init am Dateiende). Nur eine offene Verbindung wird unten per
  // TRUNCATE gecheckpointet; danach trägt die Rollback-Kopie alles, und ein
  // Rest-Journal zu löschen verliert nichts.
  const wasOpen = Boolean(handle.db);
  let keptJournalPath: string | null = null;
  // Ab hier liegt an DB_PATH die Datenbank aus dem Backup (#1422).
  let swapped = false;
  // Die Rollback-Kopie ist per rename zurueck an DB_PATH.
  let rolledBack = false;
  let carriedBackupStatus: Record<string, string | null> | null = null;

  try {
    await fs.mkdir(path.dirname(handle.dbPath), { recursive: true });
    // Zuerst die Arbeitsdatei: scheitert schon das Kopieren (volle Platte),
    // ist die laufende Verbindung noch gar nicht angefasst.
    await stageDatabaseCopy(handle, sourcePath, stagingPath);

    // Laufende Backups zu Ende kommen lassen. Zwischen dem letzten Blick auf
    // `activeBackups` und `db.close()` steht kein await: ein neues Backup kann
    // dort nicht mehr beginnen, und danach findet es keine Verbindung.
    // Waehrend des Kopierens kann ein Download ein Backup begonnen haben.
    // Scheitert das Warten, raeumt der catch unten die Arbeitsdatei weg - die
    // Datenbank ist noch nicht angefasst. Die Schleife prueft nach dem letzten
    // await noch einmal synchron - erst dann ist die Luecke zu.
    do {
      await waitForQuietOrGiveUp(handle);
    } while (handle.activeBackups.size > 0 || activeWriters().length > 0);
    if (handle.db) {
      carriedBackupStatus = readBackupStatus(handle.get());
      try { handle.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      handle.db.close();
      handle.setDb(null);
    }

    // Die Rollback-Kopie entsteht wie die Arbeitsdatei: unter einem
    // Zwischennamen vollstaendig geschrieben, auf die Platte gebracht, dann
    // umbenannt. Ein direktes Kopieren hinterliess bei einem Abbruch eine
    // abgeschnittene Datei unter dem Namen, den die Anleitung als Rueckweg
    // nennt. Kein harter Link statt der Kopie: er spart das Kopieren, aber
    // bis zum Tausch waeren Rollback und DB_PATH dieselbe Datei - ein
    // gescheiterter Restore, der die alte Datenbank wieder oeffnet, schriebe
    // dann in die Rollback-Kopie mit.
    // ENOENT heisst hier nur dann „keine bisherige Datenbank", wenn DB_PATH
    // schon vor dem Kopieren fehlte. Sonst kam es von unterwegs - etwa weil
    // ein zweiter Prozess die `.partial` als Rest weggeraeumt hat (Review
    // #1431) -, und ohne Rollback-Kopie darf nicht getauscht werden: die alte
    // Datenbank waere danach weg.
    const hadDatabase = existsSync(handle.dbPath);
    try {
      await stageDatabaseCopy(handle, handle.dbPath, rollbackPartialPath);
      await fs.rename(rollbackPartialPath, rollbackPath);
      // Den Namen dauerhaft machen, BEVOR DB_PATH ersetzt wird: sonst kann nach
      // einem Stromausfall das Backup an DB_PATH stehen, die Rollback-Kopie aber
      // noch unter `.partial` - und die raeumt der naechste Start weg
      // (Codex-Befund in #1431).
      await syncDirectory(path.dirname(handle.dbPath));
      rollbackCreated = true;
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 'ENOENT' || hadDatabase) throw err;
    }

    // Ohne offene Verbindung hat niemand das Journal gecheckpointet. Ein `-wal`
    // mit Daten neben der leeren Datei gehört zur Datenbank, die vorher hier
    // lag, und kann Änderungen tragen, die nirgends sonst stehen - die Meldung
    // aus `emptyDatabaseFileError()` sagt „keep them". Also nicht löschen,
    // sondern neben die Rollback-Kopie legen, wohin es als Vorgänger gehört.
    //
    // NICHT unter `-wal`: die Rollback-Kopie ist hier selbst die leere Datei,
    // und SQLite verwirft ein `-wal` neben einer leeren Hauptdatei beim ersten
    // Lesen. Wer die Kopie ansieht (`sqlite3 <kopie>`, der naheliegende
    // nächste Schritt), vernichtete sonst genau das, was hier bewahrt wird.
    if (!wasOpen && (handle.regularFileSize(`${handle.dbPath}-wal`) as number) > 0) {
      await fs.rename(`${handle.dbPath}-wal`, keptJournalName(rollbackPath, 'wal'));
      keptJournalPath = keptJournalName(rollbackPath, 'wal');
      await renameIfExists(`${handle.dbPath}-shm`, keptJournalName(rollbackPath, 'shm'));
    }
    await unlinkIfExists(`${handle.dbPath}-wal`);
    await unlinkIfExists(`${handle.dbPath}-shm`);
    // Das Entfernen der alten Nebendateien dauerhaft machen, BEVOR DB_PATH
    // ersetzt wird: sonst kann nach einem Stromausfall das neue DB_PATH stehen
    // und das alte -wal wieder daneben - und SQLite wendete es auf die falsche
    // Datei an (Codex-Befund in #1431).
    await syncDirectory(path.dirname(handle.dbPath));
    await swapIntoDbPath(handle, stagingPath, () => { swapped = true; });

    // Ohne Klartext-Sicherheitskopie: stammt das Backup aus der Zeit vor der
    // Verschlüsselung, verschlüsselt init() es jetzt — die Sicherung dafür ist
    // die Quelldatei selbst, plus `.pre-restore-*` für den Rollback. Eine
    // zusätzliche unverschlüsselte Vollkopie im Datenverzeichnis würde sich bei
    // jedem Restore erneut anhäufen und die Zusage „verschlüsselt at rest"
    // unterlaufen, ohne dass die Backup-UI davon berichtet.
    handle.init({ plaintextBackup: false });
    writeBackupStatus(handle.get(), carriedBackupStatus);
    log.info(`Database restored from backup. Schema v${backupVersion}${rollbackCreated ? ` | rollback: ${rollbackPath}` : ''}`);

    return {
      schemaVersion: schemaVersion(handle.db),
      rollbackPath: rollbackCreated ? rollbackPath : null,
      keptJournalPath,
    };
  } catch (err) {
    try {
      // Best effort: ein Rest, der nicht weggeht (EACCES), darf das
      // Wiederoeffnen unten nicht verhindern - der naechste Start raeumt ihn weg.
      for (const leftover of [stagingPath, rollbackPartialPath]) {
        try {
          await unlinkIfExists(leftover);
        } catch (cleanupErr) {
          log.warn(`Could not remove ${leftover} after a failed restore: ${(cleanupErr as { message?: string } | null)?.message ?? cleanupErr}`);
        }
      }
      if (swapped) {
        // init() kann die neue Datenbank schon geoeffnet haben.
        if (handle.db) {
          handle.db.close();
          handle.setDb(null);
        }
        if (rollbackCreated) {
          // Die neue Datenbank liegt schon an DB_PATH: die alte per rename
          // zurueck, nicht per Kopie. Eine Kopie braucht noch einmal so viel
          // Platz wie die alte Datenbank, waehrend die neue noch an DB_PATH
          // liegt - bei vollem Datentraeger (der Fall aus #1422) scheiterte der
          // Rollback, und die Instanz blieb auf dem gescheiterten Backup ohne
          // Verbindung stehen (Review #1431). Das rename ist unteilbar und
          // braucht keinen Platz; die Rollback-Kopie ist danach DB_PATH selbst.
          await unlinkIfExists(`${handle.dbPath}-wal`);
          await unlinkIfExists(`${handle.dbPath}-shm`);
          await syncDirectory(path.dirname(handle.dbPath));
          await swapIntoDbPath(handle, rollbackPath, () => { rolledBack = true; });
        }
      }
      // Vor dem Tausch ist DB_PATH die alte Datei geblieben, nach dem Rollback
      // ist sie es wieder: ein beiseite gelegtes Journal gehoert zurueck neben
      // die (leere) Datei, an der die Meldung es nennt.
      if (keptJournalPath) {
        await renameIfExists(keptJournalName(rollbackPath, 'wal'), `${handle.dbPath}-wal`);
        await renameIfExists(keptJournalName(rollbackPath, 'shm'), `${handle.dbPath}-shm`);
        // Das zurueckgelegte Journal dauerhaft machen: sonst kann es nach einem
        // Stromausfall wieder unter `.wal-kept` liegen, wo die Meldung zur
        // leeren Datei es nicht nennt (Codex-Befund in #1431).
        await syncDirectory(path.dirname(handle.dbPath));
      }
      if (!handle.db && swapped && !rollbackCreated) {
        // Vorher gab es keine Datenbank: nichts zurueckzuholen.
        try { handle.init({ plaintextBackup: false }); } catch { /* preserve original restore error */ }
      } else if (!handle.db) {
        try {
          handle.init({ plaintextBackup: false });
        } catch (reopenErr) {
          // Die leere Datei verweigert init() wie vor dem Restore - das ist der
          // alte Stand, kein gescheiterter Rollback.
          if ((reopenErr as { code?: unknown } | null)?.code !== handle.emptyDatabaseFileCode) throw reopenErr;
        }
      }
    } catch (rollbackErr) {
      log.error('Rollback after failed restore also failed:', rollbackErr);
      // Nur wenn die Instanz wirklich nicht mehr wie vorher dasteht: getauscht,
      // oder ohne Verbindung. Scheitert bloss das Aufraeumen der Arbeitsdatei
      // (etwa EACCES), laeuft die alte Datenbank weiter - dann gilt der
      // urspruengliche Fehler, samt seinem Grund (Review #1431).
      if (swapped || !handle.db) {
        throw rollbackFailedError(handle, err as Error, rollbackErr as Error, {
          swapped, rolledBack, rollbackPath: rollbackCreated ? rollbackPath : null,
        });
      }
    }
    throw err;
  }
}

/**
 * Meldung, wenn nach einem gescheiterten Restore auch der Rueckweg scheitert
 * (Review #1431). Die Instanz steht dann NICHT mehr wie vorher da - der
 * urspruengliche Fehler (oft mit einem Grund, dessen Dialogtext „hier wurde
 * nichts geaendert" sagt) waere eine falsche Auskunft. Deshalb ohne `reason`:
 * der Dialog zeigt diese Meldung selbst, und sie nennt den Weg von Hand.
 * @param state
 *   `swapped`: das Backup lag schon an DB_PATH; `rolledBack`: die Rollback-Kopie
 *   ist per rename zurueck; `rollbackPath`: die Rollback-Kopie, falls eine
 *   angelegt wurde (vorher gab es sonst keine Datenbank)
 */
function rollbackFailedError(handle: DbHandle, restoreErr: Error, rollbackErr: Error, { swapped, rolledBack, rollbackPath }: { swapped: boolean, rolledBack: boolean, rollbackPath: string | null }): Error {
  const lines = [
    `Restore failed: ${restoreErr?.message ?? String(restoreErr)}`,
    `Putting the previous database back failed as well: ${rollbackErr?.message ?? String(rollbackErr)}.`,
  ];
  if (swapped && !rolledBack && rollbackPath) {
    lines.push(
      `The database from before the restore is kept at ${rollbackPath}. Stop Yuvomi, move that file `
      + `to ${handle.dbPath} (and delete ${handle.dbPath}-wal and ${handle.dbPath}-shm if they exist), then start Yuvomi again.`
    );
  } else if (swapped && !rolledBack) {
    lines.push(
      `There was no database at ${handle.dbPath} before this restore, and the restored one does not start. `
      + `Delete ${handle.dbPath} (with ${handle.dbPath}-wal and ${handle.dbPath}-shm) to start as a fresh instance, or restore another backup.`
    );
  } else if (rolledBack) {
    lines.push(`The database from before the restore is back at ${handle.dbPath}, but it could not be opened again. Restart Yuvomi.`);
  } else {
    lines.push(`The restore never replaced ${handle.dbPath}; the database there is the one from before, but it could not be opened again. Restart Yuvomi.`);
  }
  return new Error(lines.join(' '), { cause: restoreErr });
}
