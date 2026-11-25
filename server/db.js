/**
 * Modul: Datenbank (Database)
 * Zweck: SQLite/SQLCipher Verbindung, Schema-Migration (versioniert) und Query-Helfer.
 *        Migrations-Engine, Backup und Restore stehen in server/db/ (migrate.ts,
 *        backup.ts, restore.ts); dieses Modul ist ihre Fassade.
 * Abhängigkeiten: better-sqlite3-multiple-ciphers
 *
 * Verschlüsselung:
 *   `better-sqlite3-multiple-ciphers` ist ein API-kompatibler Ersatz für
 *   `better-sqlite3`, der die Cipher-Schicht bereits im vorkompilierten Binary
 *   mitbringt. Es wird KEIN System-SQLCipher und kein Quell-Build benötigt -
 *   das gilt für Docker und Bare-Metal gleichermaßen.
 *
 *   Ohne DB_ENCRYPTION_KEY läuft die App bewusst mit unverschlüsseltem SQLite
 *   (Entwicklung). Ist der Key gesetzt, wird der Cipher auf `sqlcipher`
 *   (AES-256) gestellt und beim Start hart verifiziert: fehlender
 *   Cipher-Support oder eine trotz Key unverschlüsselte Datei sind ein
 *   Startfehler, kein stilles Weiterlaufen. Eine bereits vorhandene
 *   unverschlüsselte Datenbank wird dabei einmalig migriert.
 */

import Database from './utils/sqlite-driver.js';
import path from 'path';
import { mkdirSync, existsSync, renameSync, linkSync, rmSync, copyFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { createLogger } from './logger.js';
import { acquireInstanceLock } from './utils/instance-lock.js';
import { resolveDbPath, secretsDirFor } from './utils/db-path.js';
import { groupBatchesIntoProducts, productKey } from './services/pantry-products.js';
import { MIGRATIONS as MIGRATION_FILES } from './migrations/index.ts';
import {
  migrate as migrateDatabase, reconcileCriticalSchema as reconcileSchema, unknownMigrationVersions,
  latestKnownVersion, allowNewerSchema, schemaVersion, MIGRATION_BUSY_ATTEMPTS,
} from './db/migrate.ts';
import { withTx } from './db/tx.ts';
import { backupToFile as backupToFileFor, checkBackupFile as checkBackupFileFor } from './db/backup.ts';
import {
  restoreFromFile as restoreFromFileFor, closeForShutdown as closeForShutdownFor, isRestoreRunning as isRestoreRunningFor,
  isDatabaseOpen as isDatabaseOpenFor, removeRestoreStaging as removeRestoreStagingFor,
} from './db/restore.ts';

const log = createLogger('DB');

const DB_KEY = process.env.DB_ENCRYPTION_KEY;

// --------------------------------------------------------
// Pfad-Auflösung (Legacy-Migration oikos.db → yuvomi.db)
// --------------------------------------------------------
//
// Die Regeln stehen in server/utils/db-path.js, damit der Secret-Handschlag vor
// diesem Modul dieselbe Datei sieht (auto-secrets.js). `let`: scheitert die
// Legacy-Migration, läuft die Instanz auf `oikos.db` weiter (siehe unten).
let { dbPath: DB_PATH, legacyPath: LEGACY_DB_PATH } = resolveDbPath(); // LEGACY_DB_PATH: null außer bei „managed" Layout

/**
 * Einmalige, idempotente Migration der Legacy-Datenbankdatei `oikos.db` → `yuvomi.db`.
 * Läuft beim Start VOR dem Öffnen der Verbindung. Absturzsicher:
 *   - Nichts zu tun (frische Installation / bereits migriert) → return.
 *   - Doppelzustand (beide existieren) → Ziel gewinnt, Legacy bleibt liegen, Warnung.
 *   - Read-only-Volume → kein Crash, Fallback auf Legacy-Pfad.
 */
function migrateLegacyDbFile() {
  if (!LEGACY_DB_PATH) return;             // Custom-Pfad → keine Migration
  if (existsSync(DB_PATH)) {
    if (existsSync(LEGACY_DB_PATH)) {
      log.warn(
        `Both ${path.basename(DB_PATH)} and legacy ${path.basename(LEGACY_DB_PATH)} exist — ` +
        `using ${path.basename(DB_PATH)} and leaving the legacy file untouched.`
      );
    }
    return;                                // bereits migriert / frisch
  }
  if (!existsSync(LEGACY_DB_PATH)) return;  // nichts zu migrieren

  log.info(`Legacy database detected — migrating ${LEGACY_DB_PATH} → ${DB_PATH}`);

  // 1. WAL des Legacy-Files VOLLSTÄNDIG in die Hauptdatei einfalten. Erst wenn der
  //    TRUNCATE-Checkpoint nachweislich gelang, trägt `oikos.db` allein den
  //    kompletten Zustand (WAL = 0 Bytes) — dann ist ein Rename der reinen .db
  //    verlustfrei. Schlägt der Checkpoint fehl, könnten committete Frames noch im
  //    WAL liegen; dann NICHT teil-migrieren.
  let checkpointed = false;
  try {
    // Bestands-Installationen haben typischerweise einen gesetzten Key UND eine
    // noch unverschlüsselte Datei (bis v1.52.x lief `PRAGMA key` ins Leere).
    // Setzten wir ihr den Key auf, läse SQLite sie als verschlüsselt und schon
    // der Checkpoint scheiterte mit „file is not a database" — über eine völlig
    // intakte Datenbank. Verschlüsselt wird erst nach dem Rename, durch
    // encryptPlaintextDatabase() auf dem dann gültigen DB_PATH.
    const encrypted = !isPlaintextDatabase(LEGACY_DB_PATH);
    const legacy = new Database(LEGACY_DB_PATH);
    try {
      if (encrypted) applyEncryptionKey(legacy);
      // wal_checkpoint(TRUNCATE) WIRFT nicht, wenn eine andere Verbindung den
      // WAL-Lock hält — es liefert eine Zeile { busy, log, checkpointed }. Nur
      // busy === 0 bedeutet, dass der WAL vollständig gefaltet & getrunct wurde
      // (busy === 0 gilt auch für Nicht-WAL-DBs, die kein WAL haben). Bei busy != 0
      // dürfen wir NICHT umbenennen, sonst lösen wir die .db von ungefalteten Frames.
      const [row] = legacy.pragma('wal_checkpoint(TRUNCATE)');
      checkpointed = row != null && row.busy === 0;
      if (!checkpointed) {
        log.warn(`Legacy checkpoint incomplete (busy=${row?.busy}).`);
      }
    } finally {
      legacy.close();
    }
  } catch (err) {
    log.warn(`Legacy checkpoint failed (${err?.message}).`);
  }

  if (!checkpointed) {
    // WAL könnte committete Daten enthalten, die wir nicht sicher von der .db
    // trennen können → KEINE Teil-Migration. Auf dem Legacy-Pfad weiterlaufen
    // (SQLite öffnet oikos.db samt intaktem WAL); nächster Boot versucht es erneut.
    log.warn(`Deferring migration — continuing on legacy path ${LEGACY_DB_PATH}.`);
    DB_PATH = LEGACY_DB_PATH;
    return;
  }

  // 2. Checkpoint gelang → die .db ist vollständig und eigenständig. Nur sie
  //    umbenennen; die nun leeren Legacy-Sidecars best-effort entfernen (SQLite
  //    legt -wal/-shm für yuvomi.db bei Bedarf neu an).
  try {
    renameSync(LEGACY_DB_PATH, DB_PATH);
    for (const suffix of ['-wal', '-shm']) {
      const stale = `${LEGACY_DB_PATH}${suffix}`;
      if (existsSync(stale)) {
        try { rmSync(stale); } catch { /* harmlos: leeres/locked Sidecar */ }
      }
    }
    log.info(`Database migrated to ${DB_PATH}`);
  } catch (err) {
    // z. B. read-only Volume → NICHT crashen, weiter auf Legacy-Pfad laufen.
    log.warn(
      `Could not rename legacy database (${err?.message}); ` +
      `continuing on legacy path ${LEGACY_DB_PATH}.`
    );
    DB_PATH = LEGACY_DB_PATH;
  }
}

let db;

// --------------------------------------------------------
// Initialisierung
// --------------------------------------------------------

/**
 * Meldung für eine Datenbank, die sich mit dem gesetzten Key nicht öffnen lässt.
 *
 * Zwei verschiedene Ursachen erzeugen denselben SQLCipher-Fehler, und die alte
 * Meldung nannte nur die erste. Die zweite hat einen Melder zwei Tage gekostet
 * (#1267): er hatte die Datenbankdatei von Hand ersetzt, das Write-Ahead-Log der
 * VORHERIGEN Datenbank lag daneben, und SQLite liest dessen Frames beim Öffnen
 * mit - verschlüsselt mit dem alten Key. Die Datei selbst ist dann einwandfrei
 * und der Key stimmt; nur das Journal gehört nicht dazu.
 *
 * Der zweite Absatz ist bewusst BEDINGT formuliert, und das ist der Kern seiner
 * Fassung: ein `-wal` neben der Datenbank ist KEIN Hinweis auf einen Dateitausch.
 * `journal_mode = WAL` steht dauerhaft, und SQLite räumt das Journal nur beim
 * sauberen Schließen weg. Das tut der Server auf SIGTERM und SIGINT
 * (`closeForShutdown()`), aber nicht nach SIGKILL, Absturz, OOM oder bei einer
 * Version vor diesem Handler, die als PID 1 im Container jedes Signal
 * ignorierte. Nach so einem Stopp liegt es also da, und zwar als EIGENES
 * Journal dieser Datenbank.
 * Ein unbedingtes „lösch es" würde hier bestätigte, nur noch nicht
 * gecheckpointete Transaktionen verwerfen und den eigentlichen Schlüsselfehler
 * nicht einmal berühren - derselbe Fehlertyp, gegen den dieser ganze Vorgang
 * geht (Review-Befund auf PR #1275). Deshalb: die Bedingung kennt nur der Admin
 * („hast du die Datei von Hand ersetzt?"), und der Rat lautet beiseitelegen,
 * nicht löschen.
 *
 * Der dritte Satz ist der eigentliche Grund für #1267: die Restore-Meldung
 * riet dazu, den Key zu tauschen und neu zu starten. Wer das auf einer Instanz
 * mit eigener verschlüsselter Datenbank tut, landet genau hier und kommt nicht
 * mehr an die Oberfläche - der Weg zurück gehört deshalb in die Meldung.
 *
 * Dieser Rückweg gilt aber NUR, wenn allein der Key getauscht wurde, und so
 * steht er auch da. Wer Datei UND Key zusammen ersetzt hat - der richtige Weg
 * für eine Übernahme -, würde mit „change it back" in denselben Abbruch
 * zurückgeschickt: die eingesetzte Datei öffnet sich mit dem alten Key genauso
 * wenig (#1267, zweite Runde). Für ihn ist einer der beiden Eingänge nicht das,
 * wofür er ihn hält, und der Rat trennt beides mit einer Probe, die nichts
 * verändert: Größe und Prüfsumme der Datei gegen das Original. Stimmen sie, ist
 * es der Key, und dann meist nicht der Wert selbst, sondern sein Weg in den
 * Prozess - eine Env-Datei wird geparst, nicht kopiert.
 * @returns {string}
 */
function undecryptableDatabaseError() {
  const lines = [
    `[DB] Wrong encryption key - ${DB_PATH} could not be decrypted with DB_ENCRYPTION_KEY.`,
    'The key that opens this file is the one it was created with.',
    'If you changed only DB_ENCRYPTION_KEY and left the database file as it was - for example to '
    + 'take over a backup from another installation - change it back: this database belongs to '
    + 'this instance, and a key swap alone does not import anything - it only locks you out of '
    + 'what is here.',
    'If you replaced the database file and the key together, changing the key back will not help: '
    + 'the file you put in place does not open with the old key either. Then one of the two is not '
    + `what you think it is. Compare the size and sha256sum of ${DB_PATH} with the original file; `
    + 'if they differ, copy the file again. If they match, the key Yuvomi was started with is not, '
    + 'byte for byte, the one the file was written with. Compare it character by character with the '
    + 'source, and check how it reaches Yuvomi: an environment file is parsed, not copied - '
    + 'systemd\'s EnvironmentFile, for one, drops a backslash in an unquoted value, reads a quote '
    + 'right after "=" as quoting and trims spaces at both ends.',
  ];
  if (existsSync(`${DB_PATH}-wal`)) {
    lines.push(
      `A write-ahead log is lying next to the database (${DB_PATH}-wal). On its own that means `
      + 'nothing is wrong with it: after any stop that was not a clean shutdown the log stays, and '
      + 'it then belongs to THIS database and can hold committed transactions that are not in the '
      + 'main file yet. Do not delete it in that case - it would throw those away and would not fix '
      + 'the key. It is only a cause of this error if you replaced the database file by hand, '
      + 'because then the log belongs to the database you replaced and is still read on open. If '
      + `that is what happened, stop Yuvomi and move ${DB_PATH}-wal and ${DB_PATH}-shm aside `
      + 'before starting again.'
    );
  }
  return lines.join(' ');
}

/**
 * Meldung für den ersten Lesezugriff nach dem Öffnen, getrennt nach dem, was
 * SQLite tatsächlich sagt.
 *
 * Der `catch` in `init()` hat jeden Fehler an dieser Stelle als falschen Key
 * gemeldet (#1267). Gemessen sind drei Fälle, die sich nicht vertragen:
 *   - `SQLITE_NOTADB`: Seite 1 lässt sich nicht entschlüsseln. Das ist der
 *     falsche Key, aber ebenso eine Datei, die gar keine Datenbank ist (HTML,
 *     gzip, verstümmelte Übertragung) - deshalb nennt die Key-Meldung auch die
 *     Probe gegen das Original.
 *   - `SQLITE_CORRUPT`: gibt es NUR mit dem richtigen Key. Dieselbe
 *     abgeschnittene Datei liefert mit falschem Key `SQLITE_NOTADB`, denn
 *     Seite 1 muss erst entschlüsselt werden und ihre HMAC-Prüfung bestehen.
 *     Hier ist der Key also belegt richtig, und ein Rat zum Key wäre falsch.
 *   - alles andere: die Meldung behauptet nichts über den Key und reicht Code
 *     und Text weiter. Gemessen sind hier zwei Rechteprobleme, beide mit
 *     richtigem Key: `SQLITE_READONLY_DIRECTORY` (WAL-Datenbank in einem
 *     Verzeichnis ohne Schreibrecht) und `SQLITE_CANTOPEN` (ein `-wal`, auf das
 *     der Dienst nicht zugreifen darf). Nur für diese beiden Familien kommt der
 *     Hinweis auf die Dateirechte dazu.
 * @param {unknown} err
 * @returns {string}
 */
function unreadableAtStartError(err) {
  const code = typeof err?.code === 'string' ? err.code : '';
  const detail = `${code || 'no SQLite error code'}: ${err?.message ?? String(err)}`;

  if (code === 'SQLITE_NOTADB') return undecryptableDatabaseError();

  if (code.startsWith('SQLITE_CORRUPT')) {
    return `[DB] ${DB_PATH} is damaged or incomplete (${detail}). DB_ENCRYPTION_KEY is not the `
      + 'problem: it does open this file - its first page decrypted and passed the integrity '
      + 'check, which a wrong key never does - so changing the key will not help. If the file was '
      + 'copied or downloaded from another machine, the copy most likely stopped short: copy it '
      + 'again from the original and compare its size and sha256sum with the original before '
      + 'starting Yuvomi.';
  }

  const lines = [`[DB] ${DB_PATH} could not be read (${detail}).`];
  if (code.startsWith('SQLITE_READONLY') || code.startsWith('SQLITE_CANTOPEN')) {
    lines.push(
      `Yuvomi needs read and write access to the database file, to ${DB_PATH}-wal and `
      + `${DB_PATH}-shm next to it and to the directory they are in - even just to read, because `
      + 'SQLite keeps its write-ahead log there. Check the owner and permissions of '
      + `${path.dirname(DB_PATH)} and of the files in it for the user Yuvomi runs as.`
    );
  }
  return lines.join(' ');
}

/** Größe einer regulären Datei, `null` wenn sie fehlt oder keine ist. */
function regularFileSize(filePath) {
  try {
    const stat = statSync(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/**
 * Die Datei, die `init()` gleich öffnen wird: `DB_PATH`, oder im „managed"
 * Layout die Legacy-Datei, solange es `DB_PATH` noch nicht gibt - die öffnet
 * `migrateLegacyDbFile()` als Erstes. `null` heißt: frische Installation.
 */
function databaseFileAboutToOpen() {
  if (DB_PATH === ':memory:') return null;
  if (existsSync(DB_PATH)) return DB_PATH;
  if (LEGACY_DB_PATH && existsSync(LEGACY_DB_PATH)) return LEGACY_DB_PATH;
  return null;
}

/**
 * Meldung für eine vorhandene, aber leere Datenbankdatei (#1282).
 *
 * SQLite nimmt eine Datei mit 0 Byte als neue Datenbank, die Migrationen
 * laufen von vorn, und Yuvomi steht als leere Instanz da - genau in dem
 * Moment, in dem jemand gerade Daten bewegt. Gemessen mit diesem Treiber:
 * eine frische Installation hat gar keine Datei, und `journal_mode = WAL`
 * schreibt Seite 1 (4096 Byte) in die Hauptdatei, bevor es überhaupt ein
 * `-wal` gibt. Eine leere Datei kommt also von außen (abgebrochene Kopie,
 * `cp` auf eine volle Platte, falscher Quellpfad) oder aus einem Erststart,
 * der vor dieser ersten Seite abgebrochen wurde: mit Key liegen zwischen dem
 * Anlegen der Datei und Seite 1 rund 150 ms Schlüsselableitung, und ein
 * SIGKILL dort hinterlässt genau diese Datei ohne jede Nebendatei. Beide
 * Fälle stehen deshalb in der Meldung, jeder mit dem Schritt, der ihn löst.
 *
 * Das `-wal` ist KEINE Ausnahme von der Verweigerung, sondern ihr zweiter
 * Grund. Gemessen: liegt neben einer 0-Byte-Hauptdatei ein `-wal` mit Daten,
 * löscht SQLite es beim ersten Lesen und startet leer - `init()` hat so ein
 * Journal bisher stumm vernichtet, und `migrateLegacyDbFile()` tat es bei einer
 * leeren `oikos.db` schon vor dem Umbenennen. Zu der leeren Datei kann es nicht
 * gehören (siehe oben), es stammt von der Datenbank, die vorher hier lag, und
 * ohne Key trug es in der Messung deren kompletten Inhalt. Wer die Datei wie
 * geraten neu kopiert und das Journal liegen lässt, bekommt ohne Key still die
 * ALTEN Daten statt des Originals, mit Key den Abbruch „Wrong encryption key"
 * aus #1267. Deshalb: beiseitelegen, vor beiden Schritten.
 *
 * Der Absatz zur Legacy-Datei steht nur da, wenn sie Daten hat: dann führt
 * „leere Datei löschen" nicht zu einer neuen Instanz, sondern zu `oikos.db`,
 * die der nächste Start umbenennt.
 * @param {string} filePath die leere Datei
 * @returns {string}
 */
function emptyDatabaseFileError(filePath) {
  const lines = [
    `[DB] ${filePath} exists but is empty (0 bytes). Yuvomi refuses to start on it: SQLite would `
    + 'take an empty file for a new database, and Yuvomi would come up as a fresh, empty instance '
    + 'as if your data were gone. Nothing has been written to the file.',
    'A new installation has no database file at all, and Yuvomi never empties its own. An empty '
    + 'file is left behind by a copy or restore that failed or stopped short - an interrupted '
    + 'transfer, cp onto a full disk, a wrong source path - or by a very first start that was '
    + 'stopped before it had written anything.',
    'If you copied or restored a database to this path, copy it again from the original and '
    + `compare the size and sha256sum of ${filePath} with the original before starting Yuvomi.`,
    'If you want a new, empty instance - you created the file on purpose, or the first start of a '
    + `new installation was interrupted - delete ${filePath} and start again: Yuvomi then creates `
    + 'the database itself.',
  ];
  if (filePath === DB_PATH && LEGACY_DB_PATH && regularFileSize(LEGACY_DB_PATH) > 0) {
    lines.push(
      `An older database file from before the rename lies next to it (${LEGACY_DB_PATH}). `
      + `Deleting the empty ${path.basename(DB_PATH)} does not give you a new instance then: on the `
      + `next start Yuvomi moves ${path.basename(LEGACY_DB_PATH)} to ${path.basename(DB_PATH)} and `
      + 'starts with the data in it. Move it aside first if that is not what you want.'
    );
  }
  const wal = `${filePath}-wal`;
  if (regularFileSize(wal) > 0) {
    lines.push(
      `A write-ahead log with data lies next to it (${wal}). It does not belong to the empty file - `
      + 'SQLite writes the first page of a database into the main file before it ever creates the '
      + 'log - so it is left over from the database that was at this path before, and it can hold '
      + 'changes that exist nowhere else. Starting on the empty file would delete it, and a database '
      + 'copied back in next to it would be read together with a log that belongs to another file. '
      + `Before either step above, move ${wal} and ${filePath}-shm aside and keep them - do not `
      + 'delete them.'
    );
  }
  return lines.join(' ');
}

/**
 * `code` des Fehlers aus `assertDatabaseFileNotEmpty()`: daran erkennen der
 * Auto-Init am Dateiende und der Rollback in `restoreFromFile()` den Leer-Fall,
 * ohne die Meldung zu lesen.
 */
const EMPTY_DATABASE_FILE = 'YUVOMI_EMPTY_DATABASE_FILE';

/**
 * Handschlag des Restore-CLI (`scripts/restore-backup.js`), gesetzt VOR dem
 * Import dieses Moduls. Das CLI ist der eine Aufrufer, für den eine leere
 * `DB_PATH` kein Grund zum Abbruch ist: es ersetzt genau diese Datei - der Rat
 * der Meldung („copy it again") führt dorthin. Ein Symbol auf `globalThis`
 * statt einer Env-Variable, weil es kein Schalter für Betreiber ist: der Server
 * darf den Leer-Fall nie überspringen, und eine Variable in der Umgebung würde
 * er erben.
 */
const RESTORE_TARGET_HANDSHAKE = Symbol.for('yuvomi.db.restoreTarget');

/**
 * Handschlag fuer die Instanzsperre (#1530), gesetzt VOR dem Import dieser
 * Datei: `'wait'` vom Server (server/utils/claim-instance-lock.js), `'refuse'`
 * vom CLI-Restore. Wie beim Restore-Handschlag ein Symbol und keine
 * Env-Variable - ein Kindprozess soll ihn nicht erben.
 */
const INSTANCE_LOCK_HANDSHAKE = Symbol.for('yuvomi.db.instanceLock');

/**
 * Bricht den Start ab, wenn die Datei, die gleich geöffnet wird, existiert und
 * leer ist. Läuft VOR allem, was die Datei anfasst - auch vor
 * `migrateLegacyDbFile()`, die eine leere `oikos.db` samt Journal sonst schon
 * öffnet und umbenennt. Eine fehlende Datei ist die frische Installation und
 * bleibt, wie sie war.
 */
function assertDatabaseFileNotEmpty() {
  const filePath = databaseFileAboutToOpen();
  if (!filePath || regularFileSize(filePath) !== 0) return;
  const err = new Error(emptyDatabaseFileError(filePath));
  err.code = EMPTY_DATABASE_FILE;
  throw err;
}

/**
 * Datenbankverbindung öffnen, SQLCipher-Key setzen, Migrations ausführen.
 * Einmalig beim Serverstart aufrufen.
 * @param {{ plaintextBackup?: boolean }} [options] `plaintextBackup: false`
 *   unterdrückt die Klartext-Sicherheitskopie der Verschlüsselungs-Migration.
 *   Nur für Aufrufer, die die Quelldaten selbst schon gesichert halten — siehe
 *   `restoreFromFile()`.
 * @returns {import('better-sqlite3-multiple-ciphers').Database}
 */
function init({ plaintextBackup = true } = {}) {
  if (db) return db;
  if (!path.isAbsolute(DB_PATH)) {
    log.warn(
      `DB_PATH "${DB_PATH}" is a relative path — inside Docker this resolves to ` +
      `"${path.resolve(DB_PATH)}", which is NOT the mounted volume. ` +
      `Data will be lost on container restart. Use an absolute path, e.g. DB_PATH=/data/yuvomi.db`
    );
  }
  // Instanzsperre (#1530) als ERSTES, vor allem, was neben DB_PATH etwas
  // anfasst: ein Server, der waehrend eines CLI-Restores startet, wartet hier,
  // statt Reste wegzuraeumen oder die Datei mitten im Tausch zu oeffnen. Nur
  // Server und Restore-CLI setzen den Handschlag; andere Importeure (das
  // Backup per `node -e` aus docs/installation.md, Skripte) bleiben frei.
  // Der Restore aus der Einstellungsseite laeuft erneut hier durch und haelt
  // die Sperre schon.
  const instanceLockMode = globalThis[INSTANCE_LOCK_HANDSHAKE];
  if ((instanceLockMode === 'wait' || instanceLockMode === 'refuse') && DB_PATH !== ':memory:') {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    acquireInstanceLock(DB_PATH, { onBusy: instanceLockMode, log });
  }
  // Reste eines abgebrochenen Restores zuerst: auch vor der Leer-Pruefung,
  // denn ein CLI-Restore auf eine leere Datei (#1282), der mittendrin stirbt,
  // laesst sie neben genau so einer Datei liegen - und die Pruefung bricht ab,
  // bevor sie sonst drankaemen (Codex-Befund in #1431). Gefahrlos: angefasst
  // werden nur Arbeitsdateien toter Prozesse, nie die Datenbank oder ihr Journal.
  removeRestoreStaging();
  // Vor allem anderen: eine leere Datei würde ab hier still zur frischen
  // Instanz, und ein Journal daneben ginge dabei verloren (#1282).
  assertDatabaseFileNotEmpty();
  // Ebenfalls vor der Legacy-Migration: die öffnet eine `oikos.db` sonst schon
  // und scheitert dort mit „file is not a database".
  assertKeyForEncryptedDatabase();
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  migrateLegacyDbFile();
  // Scheitert die Umbenennung einer Legacy-oikos.db, faellt DB_PATH auf sie
  // zurueck - und Reste eines Restores tragen dann ihren Namen.
  removeRestoreStaging();

  // Beide Prüfungen laufen VOR dem Öffnen: fehlt der Cipher-Support, darf gar
  // nicht erst eine unverschlüsselte Datei entstehen.
  if (DB_KEY) {
    assertKeyIsNotPlaceholder();
    assertCipherSupport();
    encryptPlaintextDatabase({ backup: plaintextBackup });
  }

  // Gibt es DB_PATH noch nicht, entsteht die Datenbank unter einem
  // Arbeitsnamen daneben und wird erst fertig umgehängt (#1287). Erst NACH
  // den Key-Prüfungen oben: `assertKeyIsNotPlaceholder()` unterscheidet
  // Abbruch und Warnung daran, ob es DB_PATH schon gibt.
  createDatabaseFile();

  db = new Database(DB_PATH);

  applyEncryptionKey(db);

  if (DB_KEY) {
    // Sicherstellen dass die Datenbank tatsächlich entschlüsselbar ist
    try {
      assertReadable(db);
    } catch (err) {
      throw new Error(unreadableAtStartError(err), { cause: err });
    }
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');

  migrate();
  reconcileCriticalSchema();

  // Ältere App auf neuerer Datenbank: nicht starten. Die Gefahr ist nicht,
  // dass diese Version scheitert, sondern was sie zwischendurch schreibt -
  // Daten in einer Form, die eine schon angewendete Migration verlassen hat
  // und die nach dem erneuten Update nie nachgezogen werden, weil die
  // Migration als erledigt gilt. Der Rückweg ist das Backup vor dem Update
  // (docs/installation.md, "Going back"). DB_ALLOW_NEWER_SCHEMA=1 ist der
  // ausdrückliche Notfallschalter und wird bei jedem Start als Warnung
  // genannt, damit er kein Dauerzustand wird.
  const unknown = unknownMigrationVersions(db);
  if (unknown.length > 0) {
    const detail =
      `This database was written by a newer Yuvomi: it carries migration ${unknown.join(', ')} ` +
      `and this build knows up to v${latestKnownVersion()}.`;
    if (!allowNewerSchema()) {
      db.close();
      db = null;
      throw new Error(
        `[DB] ${detail} Running an older version on a newer database is not supported: what it ` +
        'writes in the meantime can be lost on the next update. Update Yuvomi to the version ' +
        'that wrote this database, or restore the backup taken before that update. To start ' +
        'anyway, at your own risk, set DB_ALLOW_NEWER_SCHEMA=1.'
      );
    }
    log.warn(
      `${detail} Started anyway because DB_ALLOW_NEWER_SCHEMA is set. What this version writes ` +
      'can be lost on the next update: take a backup now and update as soon as you can.'
    );
  }

  // Batches an older version wrote or renamed without their product (#1448).
  // Only when this build knows every applied migration: as the OLDER version
  // on a newer database (DB_ALLOW_NEWER_SCHEMA) its grouping rules may be
  // outdated, and the newer version adopts on its own next start.
  if (unknown.length === 0) adoptOrphanPantryBatches(db);

  // Erst hier steht garantiert eine beschriebene Datei auf der Platte. Der
  // Header ist der einzige Beleg, der nicht auf einer API-Zusage beruht.
  if (DB_KEY) assertStoredEncrypted();

  log.info(`Connected: ${DB_PATH} | Schema v${currentVersion()}`);
  return db;
}

/**
 * Ein Platzhalter aus `.env.example` ist kein Schlüssel.
 *
 * `.env.example` liefert `DB_ENCRYPTION_KEY=REPLACE_WITH_A_STRONG_ENCRYPTION_KEY`
 * (nicht etwa eine leere Zeile). Wer die Quick-Start-Zeilen am Stück kopiert und
 * das Bearbeiten von `.env` überspringt, verschlüsselt seine Datenbank damit
 * gegen eine Konstante, die im Repository und auf der Landingpage abgedruckt
 * steht - also gegen nichts. Der Fehler ist zusätzlich unumkehrbar, weil ein
 * späterer echter Schlüssel die Datei nicht mehr öffnet.
 *
 * Der Guard bricht NUR ab, solange die Datenbank noch nicht existiert. Genau
 * dann ist der Fehler vermeidbar. Bestandsinstallationen, die diesen Weg schon
 * gegangen sind, laufen weiter: ein Startfehler würde ihnen eine funktionierende
 * Instanz nehmen, statt einen Fehler zu verhindern, der dort längst passiert
 * ist. Sie bekommen die Warnung samt konkretem Ausweg bei jedem Start.
 */
function assertKeyIsNotPlaceholder() {
  if (!DB_KEY.startsWith('REPLACE_WITH_')) return;

  if (!existsSync(DB_PATH)) {
    throw new Error(
      '[DB] DB_ENCRYPTION_KEY is still the placeholder from .env.example ' +
      `(${DB_KEY}). That value is published in this repository, so it protects ` +
      'nothing. Generate a real one with `openssl rand -hex 32` and put it in ' +
      '.env, or delete the line: a new installation then generates its own key on ' +
      'the first start. To run without encryption, delete the line and set ' +
      'DB_ENCRYPTION_AUTO_KEY=false.'
    );
  }

  log.warn(
    'DB_ENCRYPTION_KEY is the placeholder from .env.example, so this database is ' +
    'encrypted with a publicly known value and is not protected. To rotate: stop ' +
    `the app, copy ${DB_PATH} somewhere safe, then open the database with the old ` +
    'key and run `PRAGMA rekey` with a value from `openssl rand -hex 32` before ' +
    'putting that same value into .env.'
  );
}

function applyEncryptionKey(database) {
  if (!DB_KEY) return;
  applyKeyBytes(database, Buffer.from(DB_KEY, 'utf8'));
}

/**
 * Schluessel als Bytes setzen. Hex statt Text: der Wert landet in einem
 * PRAGMA, und Hex kann dort weder quoten noch etwas anderes ausdruecken.
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {Buffer} bytes
 */
function applyKeyBytes(database, bytes) {
  // `cipher` muss vor `key` gesetzt werden. `sqlcipher` = AES-256 im
  // SQLCipher-Format (statt des Default-Ciphers ChaCha20).
  database.pragma("cipher = 'sqlcipher'");
  database.pragma(`key="x'${bytes.toString('hex')}'"`);
}

function assertReadable(database) {
  database.prepare('SELECT count(*) FROM sqlite_master').get();
}

/**
 * Belegt, dass das geladene Binary überhaupt verschlüsseln kann.
 * `sqlite3mc_version()` existiert ausschließlich in
 * better-sqlite3-multiple-ciphers. Ohne diese Prüfung schluckt reguläres
 * SQLite das unbekannte `PRAGMA key` kommentarlos und die Daten lägen im
 * Klartext, während die Konfiguration Verschlüsselung verspricht.
 */
function assertCipherSupport() {
  const probe = new Database(':memory:');
  try {
    probe.prepare('SELECT sqlite3mc_version() AS version').get();
  } catch {
    throw new Error(
      '[DB] DB_ENCRYPTION_KEY is set, but the installed SQLite binding has no ' +
      'encryption support (expected better-sqlite3-multiple-ciphers). Refusing ' +
      'to start rather than storing your data unencrypted.'
    );
  } finally {
    probe.close();
  }
}

/** Header jeder unverschlüsselten SQLite-Datei. Verschlüsselt ist er Zufallsrauschen. */
const SQLITE_PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'binary');

/** Die ersten Bytes der Datei in Headerlänge, `null` wenn sie sich nicht lesen lässt. */
function readDatabaseHeader(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const head = Buffer.alloc(SQLITE_PLAINTEXT_HEADER.length);
    const bytesRead = readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Datei ist ohnehin gleich zu */ }
    }
  }
}

function isPlaintextDatabase(filePath) {
  return readDatabaseHeader(filePath)?.equals(SQLITE_PLAINTEXT_HEADER) ?? false;
}

/**
 * Bricht ab, wenn die Datei, die gleich geöffnet wird, verschlüsselt ist, aber
 * kein Schlüssel gesetzt ist.
 *
 * Ohne diese Prüfung öffnete SQLite die Datei und scheiterte erst am ersten
 * Pragma mit `file is not a database` - ein Satz, der nach kaputter Datei
 * klingt. Seit der Schlüssel einer Neuinstallation von selbst entsteht
 * (server/utils/auto-secrets.js) ist der häufigste Grund ein anderer: die
 * Datei `.secrets/DB_ENCRYPTION_KEY` neben der Datenbank ist weg, etwa weil
 * nur die Datenbank auf ein neues Volume kopiert wurde. Deshalb nennt die
 * Meldung diesen Pfad. Neu erzeugt wird dort nichts - der Handschlag legt nur
 * einen Schlüssel an, solange es keine Datenbank gibt.
 *
 * Nur mit vollständig gelesenem Header: eine unlesbare oder zu kurze Datei
 * ist kein Beleg für Verschlüsselung und behält die Meldung von SQLite.
 */
function assertKeyForEncryptedDatabase() {
  if (DB_KEY) return;
  const filePath = databaseFileAboutToOpen();
  if (!filePath) return;
  const head = readDatabaseHeader(filePath);
  if (!head || head.length < SQLITE_PLAINTEXT_HEADER.length || head.equals(SQLITE_PLAINTEXT_HEADER)) return;
  const stored = path.join(secretsDirFor(filePath), 'DB_ENCRYPTION_KEY');
  throw new Error(
    `[DB] ${filePath} is encrypted, but no DB_ENCRYPTION_KEY is set - not in the environment, not ` +
    `through DB_ENCRYPTION_KEY_FILE and not in ${stored}, where Yuvomi keeps a key it generated ` +
    'itself. The database opens only with the key it was created with, so Yuvomi refuses to start ' +
    'instead of creating a new one. Put that key back, either as DB_ENCRYPTION_KEY, through ' +
    `DB_ENCRYPTION_KEY_FILE or as the file ${stored} (mode 600), and start again. If ${filePath} ` +
    'is not a Yuvomi database at all - it has no plain SQLite header, so it may also be something ' +
    'else - replace it with the right file.'
  );
}

/**
 * Einmalige Migration einer unverschlüsselten Bestands-Datenbank.
 *
 * Bis einschließlich v1.52.x war `DB_ENCRYPTION_KEY` faktisch wirkungslos:
 * das ausgelieferte Binary hatte keine Cipher-Schicht, `PRAGMA key` lief ins
 * Leere. Bestands-Installationen haben deshalb einen gesetzten Key UND eine
 * unverschlüsselte Datei. Ohne diese Migration würde die App nach dem Update
 * nicht mehr starten.
 *
 * Der Ablauf lässt das Original bis zum abschließenden, atomaren rename
 * unangetastet: bricht der Vorgang ab, ist die Datenbank unverändert.
 *
 * @param {{ backup?: boolean }} [options] `backup: false` überspringt die
 *   Klartext-Sicherheitskopie. Gedacht für den Restore-Pfad: dort ist die
 *   eingespielte Backup-Datei selbst die Sicherung, und `.pre-restore-*` deckt
 *   den Rollback ab. Eine dritte, unverschlüsselte Vollkopie im Datenverzeichnis
 *   wäre reine Duplikation — und würde sich bei jedem Restore erneut anhäufen.
 */
function encryptPlaintextDatabase({ backup = true } = {}) {
  if (!existsSync(DB_PATH)) return;           // Neuinstallation
  if (!isPlaintextDatabase(DB_PATH)) return;  // bereits verschlüsselt

  // Ein bereits vorhandenes Backup darf nicht überschrieben werden: nach dem
  // Einspielen eines alten Klartext-Backups liefe die Migration erneut und
  // würde sonst die Sicherheitskopie des ersten Durchlaufs vernichten.
  let backupPath = null;
  if (backup) {
    backupPath = `${DB_PATH}.plaintext-backup`;
    if (existsSync(backupPath)) {
      backupPath = `${DB_PATH}.plaintext-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    }
  }
  const workingPath = `${DB_PATH}.encrypting`;

  log.warn(`${DB_PATH} is unencrypted but DB_ENCRYPTION_KEY is set — encrypting now.`);

  // Offenes WAL einchecken, damit die .db-Datei für sich vollständig ist.
  // wal_checkpoint(TRUNCATE) WIRFT NICHT, wenn eine andere Verbindung den
  // WAL-Lock hält — es liefert { busy, log, checkpointed }. Nur busy === 0
  // heißt, dass alle committeten Frames in der .db stehen. Würden wir bei
  // busy != 0 weitermachen, verschlüsselten wir eine unvollständige Kopie und
  // löschten anschließend die Sidecars: committete Daten wären verloren.
  // Deshalb hier abbrechen statt teil-migrieren — unverschlüsselt weiterlaufen
  // ist wegen der Sicherheitszusage ebenfalls keine Option.
  let checkpointed = false;
  const source = new Database(DB_PATH);
  try {
    const [row] = source.pragma('wal_checkpoint(TRUNCATE)');
    checkpointed = row != null && row.busy === 0;
    if (!checkpointed) {
      log.warn(`WAL checkpoint incomplete (busy=${row?.busy}) — not encrypting a partial copy.`);
    }
  } finally {
    source.close();
  }

  if (!checkpointed) {
    throw new Error(
      `[DB] Cannot encrypt ${DB_PATH}: its write-ahead log could not be checkpointed, ` +
      'which means another connection is still using the database. Encrypting now ' +
      'would risk losing committed data. Make sure no second instance is running ' +
      'against this volume and start again.'
    );
  }

  if (backupPath) copyFileSync(DB_PATH, backupPath);
  copyFileSync(DB_PATH, workingPath);

  try {
    const working = new Database(workingPath);
    try {
      // rekey ist im WAL-Modus nicht erlaubt.
      working.pragma('journal_mode = DELETE');
      working.pragma("cipher = 'sqlcipher'");
      working.pragma(`rekey="x'${Buffer.from(DB_KEY, 'utf8').toString('hex')}'"`);
      working.pragma('journal_mode = WAL');
    } finally {
      working.close();
    }
  } catch (err) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(`${workingPath}${suffix}`, { force: true }); } catch { /* Aufräumen ist best-effort */ }
    }
    throw new Error(
      `[DB] Encrypting the existing database failed (${err?.message}). ` +
      `The original database is untouched at ${DB_PATH}.`
    );
  }

  renameSync(workingPath, DB_PATH);

  // Sidecars der unverschlüsselten Datei sind nach dem Checkpoint leer und
  // passen nicht mehr zur neuen Datei.
  for (const suffix of ['-wal', '-shm']) {
    try { rmSync(`${DB_PATH}${suffix}`, { force: true }); } catch { /* SQLite legt sie neu an */ }
    try { rmSync(`${workingPath}${suffix}`, { force: true }); } catch { /* dito */ }
  }

  if (!backupPath) {
    log.info('Database encrypted (AES-256).');
    return;
  }

  log.info(`Database encrypted (AES-256). Plaintext backup: ${backupPath}`);
  log.warn(
    `${backupPath} still contains UNENCRYPTED data — delete it once you have ` +
    'verified that the app starts and your data is complete.'
  );
}

/**
 * Arbeitsname, unter dem eine neue Datenbank entsteht.
 *
 * Er liegt NEBEN `DB_PATH`, nicht im Temp-Verzeichnis. Nur im selben
 * Verzeichnis ist der abschließende Zug ein Umhängen innerhalb eines
 * Dateisystems und damit unteilbar; über eine Dateisystemgrenze wäre er ein
 * Kopieren - also wieder ein Zeitraum, in dem `DB_PATH` unfertig existiert,
 * genau der Zustand, gegen den dieser ganze Vorgang geht.
 * @returns {string}
 */
function creatingFilePath() {
  return `${DB_PATH}.creating`;
}

/** Arbeitsdatei samt Nebendateien entfernen; best effort. */
function removeCreatingFiles(workingPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(`${workingPath}${suffix}`, { force: true }); } catch { /* Aufräumen ist best-effort */ }
  }
}

/**
 * Die Arbeitsdatei zu einer vollständigen, leeren Datenbank machen: Key setzen
 * und Seite 1 schreiben.
 *
 * Geschrieben wird mit `user_version`, nicht mit `journal_mode = WAL`. Beide
 * legen gemessen dieselben 4096 Byte an und hinterlassen keine Nebendatei,
 * aber ein Wechsel des Journal-Modus verlangt eine exklusive Sperre und kennt
 * dabei den Busy-Timeout des Treibers nicht: startet ein zweiter Prozess
 * gleichzeitig, scheitert er sofort mit „database is locked", statt zu warten.
 * Ein `user_version`-Schreibvorgang ist eine gewöhnliche Transaktion und
 * wartet. Den Journal-Modus setzt `init()` ohnehin gleich danach auf der
 * fertigen Datenbank.
 *
 * Der Wert 0 ist der, den eine neue Datenbank ohnehin hat - die Datei bekommt
 * also nur ihre Seite 1, keinen Inhalt. Auf einer bereits beschriebenen
 * Arbeitsdatei bleibt sie dadurch, wie sie ist. `user_version` gehört Yuvomi
 * nicht anderweitig: die Schema-Version steht in `schema_migrations`.
 */
function writeFirstDatabasePage(workingPath) {
  const fresh = new Database(workingPath);
  try {
    applyEncryptionKey(fresh);
    fresh.pragma('user_version = 0');
  } finally {
    fresh.close();
  }
}

/**
 * Eine neue Datenbank entsteht unter dem Arbeitsnamen und wird erst fertig an
 * `DB_PATH` gehängt (#1287).
 *
 * `new Database(DB_PATH)` legt die Datei sofort an - mit 0 Byte. Beschrieben
 * wird sie erst durch `journal_mode = WAL`, das Seite 1 (4096 Byte) in die
 * Hauptdatei schreibt. Ohne Key liegt dazwischen weniger als 1 ms, mit Key
 * rund 150 ms Schlüsselableitung (gemessen 147 ms, einmalig beim Anlegen), und
 * ein Erststart, der in diesem Fenster getötet wird, hinterlässt genau eine
 * leere `DB_PATH` ohne jede Nebendatei. Vor #1282 begann der nächste Start
 * darauf einfach frisch - hier das richtige Ergebnis. Seit #1282 verweigert er
 * ihn, zu Recht für jede andere Herkunft einer leeren Datei, und eine an
 * dieser Stelle unterbrochene Installation kommt nicht mehr von allein hoch.
 *
 * Deshalb entsteht die Datei unter `<DB_PATH>.creating`, bekommt dort den Key
 * und Seite 1, wird geschlossen - `close()` checkpointet und räumt `-wal` und
 * `-shm` weg, übrig bleibt genau die eine fertige Datei - und erst dann an
 * `DB_PATH` gehängt. Stirbt der Start irgendwo davor, liegt nur die
 * Arbeitsdatei da: `DB_PATH` fehlt, und der nächste Start ist wieder eine
 * frische Installation. `DB_PATH` ist damit entweder abwesend oder eine
 * vollständige Datenbank, nie leer.
 *
 * Gemessene Randfälle:
 *   - Eine liegengebliebene Arbeitsdatei ist der Rest genau so eines
 *     Abbruchs. Sie wird NICHT weggeräumt, sondern weiterbeschrieben: eine
 *     0-Byte-Datei ist für SQLite eine neue Datenbank, eine mit Seite 1 ist
 *     schon fertig, und `journal_mode = WAL` ist dort ein No-op. Erst wenn sie
 *     sich nicht verwenden lässt (kein SQLite, anderer Key, halb geschrieben),
 *     wird sie entfernt und der Vorgang genau einmal wiederholt. Dass beides
 *     im Log steht, ist Absicht: sie ist die einzige Spur, dass ein Erststart
 *     abbrach. Nutzerdaten können nicht darin liegen - der Vorgang läuft nur,
 *     solange es `DB_PATH` noch nicht gibt, und endet vor der ersten
 *     Migration.
 *   - Verzeichnis nicht schreibbar: das Anlegen scheitert beim Öffnen mit
 *     `SQLITE_CANTOPEN`, wie bisher beim Öffnen von `DB_PATH`. Der Fehler
 *     bleibt der von SQLite - ein eigener Rat wäre hier geraten, nicht
 *     gemessen, und der Rechte-Hinweis steht schon in
 *     `unreadableAtStartError()`.
 *   - Zwei Prozesse gleichzeitig: beide arbeiten auf DERSELBEN Arbeitsdatei,
 *     und SQLite serialisiert sie dort genau so, wie es bisher zwei Öffnungen
 *     von `DB_PATH` serialisiert hat (Busy-Timeout des Treibers: 5 s). Genau
 *     deshalb wird die liegengebliebene Datei nicht blind gelöscht - gemessen
 *     riss das dem anderen Prozess die offene Datei unter den Händen weg
 *     („disk I/O error"), und in 1 von 4 Läufen kam danach KEINER von beiden
 *     hoch. Der letzte Zug ist `link()`: ist `DB_PATH` inzwischen da,
 *     scheitert er mit `EEXIST`, statt die Datenbank des anderen Prozesses
 *     stillschweigend zu überschreiben - was ein `rename()` täte, und zwar
 *     noch nachdem der andere schon Daten hineingeschrieben hat. Der Verlierer
 *     räumt seine Arbeitsdatei weg und startet auf der fremden Datenbank
 *     weiter. Nur wenn das Dateisystem gar keine harten Links kennt (manche
 *     Netzfreigaben), fällt der Vorgang auf `rename()` zurück, mit vorheriger
 *     Probe auf `DB_PATH`.
 */
function createDatabaseFile() {
  if (DB_PATH === ':memory:') return;
  if (existsSync(DB_PATH)) return;

  const workingPath = creatingFilePath();
  const leftover = existsSync(workingPath);
  if (leftover) {
    log.info(
      `${workingPath} is left over from a first start that was interrupted - ` +
      'creating the database in it again.'
    );
  }

  try {
    writeFirstDatabasePage(workingPath);
  } catch (err) {
    // Ein zweiter Start kann genau jetzt fertig geworden sein; dann gilt seine
    // Datenbank und hier ist nichts schiefgegangen.
    if (existsSync(DB_PATH)) {
      removeCreatingFiles(workingPath);
      return;
    }
    if (!leftover) {
      removeCreatingFiles(workingPath);
      throw err;
    }
    log.warn(
      `${workingPath} could not be used (${err?.message}) - removing it and creating ` +
      'the database again.'
    );
    removeCreatingFiles(workingPath);
    try {
      writeFirstDatabasePage(workingPath);
    } catch (retryErr) {
      removeCreatingFiles(workingPath);
      throw retryErr;
    }
  }

  try {
    linkSync(workingPath, DB_PATH);
  } catch (err) {
    if (err?.code !== 'EEXIST' && !existsSync(DB_PATH)) {
      try {
        renameSync(workingPath, DB_PATH);
      } catch (renameErr) {
        removeCreatingFiles(workingPath);
        // Der andere Prozess kann genau hier fertig geworden sein; dann ist
        // seine Datenbank da und nichts ist schiefgegangen.
        if (!existsSync(DB_PATH)) throw renameErr;
      }
    }
  }
  removeCreatingFiles(workingPath);
}

/**
 * Letzte Instanz gegen den stillen Fehlschlag: liegt trotz gesetztem Key eine
 * unverschlüsselte Datei auf der Platte, ist der Start ein Fehler.
 */
function assertStoredEncrypted() {
  if (!isPlaintextDatabase(DB_PATH)) return;
  throw new Error(
    `[DB] DB_ENCRYPTION_KEY is set, but ${DB_PATH} is stored unencrypted. ` +
    'Refusing to continue — your data would not be protected.'
  );
}

// --------------------------------------------------------
// Migrations-Engine
// --------------------------------------------------------
//
// Die Migrationen selbst liegen in server/migrations/ (eine Datei je Version,
// Reihenfolge in index.ts, Helfer in helpers.ts); append-only, siehe
// test:migrations-append-only. Der Lauf, die Erkennung einer neueren Version und
// die Selbstheilung gegen Schema-Drift stehen in server/db/migrate.ts; hier
// setzen die Wrapper nur die offene Verbindung als Vorgabe.

/**
 * Eine Migration, wie server/migrations/NNNN.ts sie exportiert.
 * @typedef {{ version: number, description: string, up: string | ((db: any) => void), afterUp?: (db: any) => void, foreignKeysOff?: boolean }} Migration
 */

/** Alle Migrationen in aufsteigender Reihenfolge (server/migrations/index.ts). @type {Migration[]} */
const MIGRATIONS = MIGRATION_FILES;

/**
 * Führt alle ausstehenden Migrations aus (server/db/migrate.ts). Eine leere
 * Datenbank beginnt mit der Schema-Baseline (server/db/baseline.ts), wenn die
 * ausgelieferte Migrationsliste läuft; `baseline: null` fährt alle von Null.
 * @param {import('better-sqlite3-multiple-ciphers').Database} [database] Vorgabe: die offene Verbindung
 * @param {Migration[]} [migrations]
 * @param {(() => import('./db/baseline.ts').Baseline) | null} [baseline]
 * @returns {{ baseline: number | null }} die Version der Baseline, wenn dieser Lauf mit ihr begann
 */
function migrate(database = db, migrations = MIGRATIONS, baseline) {
  return migrateDatabase(database, migrations, baseline);
}

/** Selbstheilung gegen Migrations-Drift (#538, server/db/migrate.ts); Vorgabe: die offene Verbindung. */
function reconcileCriticalSchema(database = db) {
  reconcileSchema(database);
}

/**
 * Stock batches without a matching product join one at start (#1448).
 *
 * Since migration 253 every write path fills `pantry_items.product_id`. An older
 * version started on this database with DB_ALLOW_NEWER_SCHEMA does not know the
 * column: the batches it creates arrive without a product, and a batch it
 * renames keeps a product whose name or unit it no longer has. Both are grouped
 * by groupBatchesIntoProducts(), the live grouping, with the runtime key the
 * writers use (productKey): a batch adopted here joins exactly the product a
 * write through the API would have put it in. Migration 253 carries its own
 * frozen copy of key and grouping instead; test:pantry-products asserts that
 * the two agree today. A product left without batches stays.
 *
 * A batch that matches its product is not touched, so a second start finds
 * nothing. The check is one query per start. A failure is logged and does not
 * stop the server: the batches stay as they were, and the reads do not depend
 * on the product yet.
 */
function adoptOrphanPantryBatches(database = db) {
  if (!database) return;
  try {
    const hasColumn = database.prepare('PRAGMA table_info(pantry_items)').all()
      .some((c) => c.name === 'product_id');
    if (!hasColumn) return;
  } catch {
    return; // pantry_items not readable - nothing to adopt.
  }
  try {
    const result = withTx(database, () => groupBatchesIntoProducts(database, productKey));
    if (result.batches === 0) return;
    log.warn(
      `${result.batches} pantry batch(es) had no matching product, probably written by an older version `
      + `(DB_ALLOW_NEWER_SCHEMA); grouped into products, ${result.created} new (#1448).`
    );
  } catch (err) {
    log.error('Adopting pantry batches without a matching product failed:', err?.message || err);
  }
}

/**
 * Aktuelle Schema-Version zurückgeben.
 * @returns {number}
 */
function currentVersion() {
  return schemaVersion(db);
}

function getPath() {
  return DB_PATH;
}

// --------------------------------------------------------
// Backup und Restore
// --------------------------------------------------------
//
// Backup schreiben und pruefen steht in server/db/backup.ts, der Restore samt
// Tausch, Rollback und Aufraeumen in server/db/restore.ts. Beide bekommen den
// Griff dieser Instanz als Parameter (server/db/handle.ts): die Verbindung,
// DB_PATH und den Schluessel lesen und setzen sie hier, nie ueber einen Import
// von db.js. Laufende Backups und der Restore-Riegel stehen im Griff, weil
// Suiten db.js per `?swap=N` mehrfach laden und jede Instanz ihre eigenen hat.

/** @type {import('./db/handle.ts').DbHandle} */
const handle = {
  get db() { return db; },
  setDb(next) { db = next; },
  get dbPath() { return DB_PATH; },
  dbKey: DB_KEY,
  get,
  init,
  applyEncryptionKey,
  applyKeyBytes,
  assertReadable,
  assertCipherSupport,
  isPlaintextDatabase,
  regularFileSize,
  emptyDatabaseFileCode: EMPTY_DATABASE_FILE,
  restoreTargetHandshake: RESTORE_TARGET_HANDSHAKE,
  activeBackups: new Set(),
  restoreRunning: false,
};

/**
 * Backup schreiben und pruefen (#2520); Pfad der fertigen Datei.
 * @param {string} destinationPath
 */
function backupToFile(destinationPath) {
  return backupToFileFor(handle, destinationPath);
}

/**
 * Ein Backup pruefen, ohne es einzuspielen; liefert die Schema-Version.
 * @param {string} sourcePath
 */
function checkBackupFile(sourcePath) {
  return checkBackupFileFor(handle, sourcePath);
}

/**
 * Backup einspielen (server/db/restore.ts).
 * @param {string} sourcePath
 * @param {{ backupKey?: string | Buffer | null }} [options]
 */
function restoreFromFile(sourcePath, options) {
  return restoreFromFileFor(handle, sourcePath, options);
}

/**
 * Die Verbindung zum Prozessende schliessen.
 * @param {number} deadline Zeitpunkt in ms
 */
function closeForShutdown(deadline) {
  return closeForShutdownFor(handle, deadline);
}

/** Laeuft gerade ein Restore? Fuer `restoreWriteGate`. */
function isRestoreRunning() {
  return isRestoreRunningFor(handle);
}

/** Ist die Verbindung offen? Fuer `restoreWriteGate`. */
function isDatabaseOpen() {
  return isDatabaseOpenFor(handle);
}

/** Reste eines abgebrochenen Restores wegraeumen (beim Start, aus `init()`). */
function removeRestoreStaging() {
  removeRestoreStagingFor(handle);
}

// --------------------------------------------------------
// Öffentliche API
// --------------------------------------------------------

/**
 * Datenbankinstanz zurückgeben.
 * @returns {import('better-sqlite3-multiple-ciphers').Database}
 */
function get() {
  if (!db) throw new Error('[DB] Not initialized - call init() first.');
  return db;
}

let _originalDb = null;

/**
 * ONLY FOR TESTING: Override the internal db instance
 * @param {import('better-sqlite3-multiple-ciphers').Database} testDb
 */
function _setTestDatabase(testDb) {
  if (!_originalDb) _originalDb = db;
  db = testDb;
}

/**
 * ONLY FOR TESTING: Restore the original db instance
 */
function _resetTestDatabase() {
  if (_originalDb) {
    db = _originalDb;
    _originalDb = null;
  }
}

// Auto-Init beim ersten Import. Eine Ausnahme: das Restore-CLI setzt vorher den
// Handschlag (RESTORE_TARGET_HANDSHAKE), und nur für GENAU den Leer-Fall bleibt
// `db` dann `null` - `restoreFromFile()` ersetzt die leere Datei ohnehin, und
// ohne diese Ausnahme endete der Rat der Meldung („copy it again") per CLI in
// einer ungefangenen Ausnahme (#1282). Alles andere wirft weiter, auch im CLI.
// Eine gesunde Datenbank öffnet das CLI bewusst wie bisher: nur eine offene
// Verbindung checkpointet `restoreFromFile()` vor der Rollback-Kopie, ein
// pauschal aufgeschobenes init() kürzte die Kopie um nicht gecheckpointete
// Transaktionen und löschte danach das `-wal`. Ohne Handschlag (Server, Tests,
// andere Skripte) bricht der Leer-Fall ab wie zuvor.
// Nur pruefen, nichts oeffnen: `server/check-backup.js` (der Pruefschritt im
// dokumentierten Compose-Restore, #1431) setzt diesen Handschlag VOR dem
// Import. Er braucht nur `checkBackupFile()` - und die laufende Datenbank darf
// dabei nicht angefasst werden, sie kann leer sein oder einen anderen
// Schluessel tragen, genau die Faelle, fuer die es den manuellen Weg gibt.
const CHECK_ONLY_HANDSHAKE = Symbol.for('yuvomi.db.checkOnly');

if (globalThis[CHECK_ONLY_HANDSHAKE] !== true) {
  try {
    init();
  } catch (err) {
    if (!(err?.code === EMPTY_DATABASE_FILE && globalThis[RESTORE_TARGET_HANDSHAKE] === true)) throw err;
  }
}

export { init, get, currentVersion, getPath, backupToFile, restoreFromFile, checkBackupFile, isRestoreRunning, isDatabaseOpen, closeForShutdown, unknownMigrationVersions, MIGRATIONS, migrate, MIGRATION_BUSY_ATTEMPTS, reconcileCriticalSchema, adoptOrphanPantryBatches, _setTestDatabase, _resetTestDatabase };
