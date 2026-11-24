/**
 * Modul: Datenbank (Database)
 * Zweck: SQLite/SQLCipher Verbindung, Schema-Migration (versioniert) und Query-Helfer
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
import os from 'node:os';
import fs from 'node:fs/promises';
import { mkdirSync, existsSync, renameSync, linkSync, rmSync, copyFileSync, openSync, readSync, closeSync, statSync, readdirSync, constants as fsConstants } from 'node:fs';
import { createLogger } from './logger.js';
import { acquireInstanceLock } from './utils/instance-lock.js';
import { resolveDbPath, secretsDirFor } from './utils/db-path.js';
import { RESTORE_IN_PROGRESS_MESSAGE, RESTORE_IN_PROGRESS_REASON } from './utils/restore-messages.js';
import { setRestoreRunning, activeWriters, restoreWaitTimeoutMs, waitUntilIdle } from './utils/restore-state.js';
import { BACKUP_STATUS_KEYS } from './utils/backup-status.js';
import { groupBatchesIntoProducts, productKey } from './services/pantry-products.js';
import { MIGRATIONS as MIGRATION_FILES } from './migrations/index.ts';
import { backfillShoppingMoveSince, backfillSeriesAuthored } from './migrations/helpers.ts';

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
// test:migrations-append-only.

/**
 * Eine Migration, wie server/migrations/NNNN.ts sie exportiert.
 * @typedef {{ version: number, description: string, up: string | ((db: any) => void), afterUp?: (db: any) => void, foreignKeysOff?: boolean }} Migration
 */

/** Alle Migrationen in aufsteigender Reihenfolge (server/migrations/index.ts). @type {Migration[]} */
const MIGRATIONS = MIGRATION_FILES;

/** Die Trigger aus Migration 251, derselbe Wortlaut; die Migration bleibt eingefroren. */
function createAvatarKeyTriggers(database) {
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_users_avatar_key_update
      AFTER UPDATE OF avatar_data ON users FOR EACH ROW
      WHEN NEW.avatar_data IS NOT OLD.avatar_data
      BEGIN
        UPDATE users SET avatar_key = CASE
          WHEN NEW.avatar_data IS NULL OR NEW.avatar_data = '' THEN NULL
          ELSE lower(hex(randomblob(16))) END
        WHERE id = OLD.id;
      END;
    CREATE TRIGGER IF NOT EXISTS trg_users_avatar_key_insert
      AFTER INSERT ON users FOR EACH ROW
      WHEN NEW.avatar_data IS NOT NULL AND NEW.avatar_data <> ''
      BEGIN UPDATE users SET avatar_key = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
  `);
}

/**
 * Nachtrag zu einer nachgetragenen `users.avatar_key` (reconcileCriticalSchema):
 * Schluessel fuer die vorhandenen Bilder und die Trigger aus Migration 251.
 */
function backfillAvatarKey(database) {
  database.exec(`
    UPDATE users SET avatar_key = lower(hex(randomblob(16)))
      WHERE avatar_data IS NOT NULL AND avatar_data <> '' AND avatar_key IS NULL
  `);
  createAvatarKeyTriggers(database);
}

/** Der Nachtrag aus Migration 254, derselbe Wortlaut; die Migration bleibt eingefroren. */
function backfillBirthdayYearUnknown(database) {
  database.exec(`
    UPDATE birthdays SET birth_date = '2000' || substr(birth_date, 5), year_unknown = 1
      WHERE substr(birth_date, 1, 5) = '1604-'
  `);
}

/** Der Nachtrag aus Migration 254 fuer Kontakte, derselbe Wortlaut. */
function backfillContactBirthdayYearUnknown(database) {
  database.exec(`
    UPDATE contacts SET birthday = '2000' || substr(birthday, 5), birthday_year_unknown = 1
      WHERE substr(birthday, 1, 5) = '1604-'
  `);
}

/**
 * Hat ein ANDERER Prozess genau diese Migration inzwischen verbucht? (#1331)
 *
 * Zwei Erststarts auf derselben frischen Datei bestimmen ihre Liste
 * ausstehender Migrationen, bevor einer von beiden etwas geschrieben hat: jede
 * Migration läuft in einer deferred begonnenen Transaktion, die ihre
 * Schreibsperre erst beim ersten Schreiben nimmt - lange nach der
 * Entscheidung. Der Nachzügler fährt dieselbe Migration deshalb ein zweites
 * Mal und stirbt daran, je nachdem wie weit er kommt: an der Buchung
 * (`UNIQUE constraint failed: schema_migrations.version`) oder schon am DDL
 * (`table ... already exists`).
 *
 * Entschieden wird am ZUSTAND, nicht am Fehlertext: die Transaktion dieses
 * Laufs ist zurückgerollt, die eigene Buchung also wieder weg. Steht die
 * Version danach trotzdem da, hat ein anderer Prozess sie geschrieben - und
 * zwar in derselben Transaktion wie ihre Wirkung, sonst stünde sie nicht da.
 * Ein Syntaxfehler, eine kaputte Tabelle, ein Constraint aus dem Migrations-SQL
 * selbst hinterlassen keine Buchung und bleiben damit Fehler.
 *
 * Der Meldungstext taugt dafür nicht, und der Fehlercode allein auch nicht:
 * `table ... already exists` und ein Syntaxfehler tragen beide SQLITE_ERROR,
 * und SQLITE_CONSTRAINT_PRIMARYKEY kommt genauso aus einer Migration, die
 * ihre eigene Zeile doppelt schreibt (gemessen, test:migrate-tolerance).
 *
 * SQLITE_BUSY zählt hier mit: auch der ausgesperrte Lauf ist zurückgerollt,
 * und eine Buchung, die danach dasteht, trägt dieselbe Beweiskraft. Die
 * Abfrage läuft außerhalb jeder Transaktion und liest damit einen FRISCHEN
 * Snapshot - den alten, an dem SQLITE_BUSY_SNAPSHOT hing, gibt es nicht mehr.
 */
function migrationAlreadyRecorded(database, migration, err) {
  // Ohne SQLite-Code kommt der Fehler nicht vom Treiber: die
  // Fremdschlüssel-Prüfung unten wirft selbst, ein Tippfehler in einem
  // up()/afterUp()-Hook wirft einen ReferenceError. Beides sind
  // Programmfehler und bleiben es.
  if (typeof err?.code !== 'string' || !err.code.startsWith('SQLITE_')) return false;

  return Boolean(
    database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(migration.version)
  );
}

/**
 * Wie oft `migrate()` eine Migration höchstens anfasst, wenn sie an der
 * Schreibsperre scheitert (SQLITE_BUSY, SQLITE_BUSY_SNAPSHOT), und wie lange es
 * zwischen zwei Versuchen wartet (linear steigend). Ein busy_timeout hilft bei
 * SQLITE_BUSY_SNAPSHOT nicht: SQLite meldet den Snapshot-Konflikt sofort, der
 * Busy-Handler wird gar nicht gefragt (gemessen: 0 ms bei 5000 ms Vorgabe des
 * Treibers). Erst ein neuer Versuch mit neuer Transaktion liest neu.
 */
const MIGRATION_BUSY_ATTEMPTS = 5;
const MIGRATION_BUSY_BACKOFF_MS = 25;

/** SQLITE_BUSY samt erweiterter Codes (SQLITE_BUSY_SNAPSHOT, SQLITE_BUSY_RECOVERY, ...). */
function isBusyError(err) {
  return typeof err?.code === 'string' && err.code.startsWith('SQLITE_BUSY');
}

/**
 * Synchron warten. `migrate()` läuft synchron im Startpfad, bevor der Server
 * Requests annimmt - ein `await` gäbe es dort nicht, und blockieren ist hier
 * genau das Gewollte.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Führt alle ausstehenden Migrations in einer Transaktion aus.
 *
 * Beide Parameter tragen im Betrieb ihren Vorgabewert; sie stehen da, damit ein
 * Test den Lauf gegen einen GESETZTEN Zustand fahren kann - eine eigene Datei
 * und eine eigene Migrationsliste - statt gegen ein Rennen zu hoffen.
 * @param {import('better-sqlite3-multiple-ciphers').Database} [database]
 * @param {Migration[]} [migrations]
 */
function migrate(database = db, migrations = MIGRATIONS) {
  // Migrations-Versions-Tabelle sicherstellen (außerhalb der Haupt-Transaktion)
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);

  const applied = new Set(
    database.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  const pending = migrations.filter((m) => !applied.has(m.version));

  if (pending.length === 0) return;

  const runMigration = database.transaction((migration) => {
    if (typeof migration.up === 'function') {
      migration.up(database);
    } else {
      database.exec(migration.up);
    }
    // Optionaler JS-Hook für Datenmigrationen, die nach dem Schema-DDL laufen.
    if (typeof migration.afterUp === 'function') {
      migration.afterUp(database);
    }
    if (migration.foreignKeysOff) {
      const violations = database.pragma('foreign_key_check');
      if (violations.length > 0) {
        throw new Error(
          `Migration ${migration.version} left ${violations.length} foreign key violation(s).`
        );
      }
    }
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
    log.info(`Migration ${migration.version} applied: ${migration.description}`);
  });

  /**
   * Eine Migration fahren und genau zwei fremde Fälle hinnehmen (#1331):
   * - sie ist schon verbucht, also hat ein anderer Prozess sie angewendet;
   * - sie kam an der Schreibsperre nicht vorbei (SQLITE_BUSY*) und ist auch
   *   nach dem Rollback nicht verbucht: dann ein neuer Versuch mit neuer
   *   Transaktion und neuem Snapshot, höchstens MIGRATION_BUSY_ATTEMPTS-mal.
   * Jeder andere Fehler fliegt sofort weiter, SQLITE_BUSY nach dem letzten
   * Versuch unverändert.
   *
   * Kein `runMigration.immediate`: das nähme die Sperre schon am Anfang, säße
   * aber im Startpfad jeder Installation - der Neuversuch ändert nur den
   * Fehlerpfad.
   */
  const applyPendingMigration = (migration) => {
    for (let attempt = 1; ; attempt++) {
      try {
        runMigration(migration);
        return;
      } catch (err) {
        if (migrationAlreadyRecorded(database, migration, err)) {
          log.warn(
            `Migration ${migration.version} war bereits verbucht, als dieser Lauf sie anwenden wollte: `
            + `${migration.description} - ein anderer Prozess war schneller (#1331).`
          );
          return;
        }
        if (!isBusyError(err) || attempt >= MIGRATION_BUSY_ATTEMPTS) throw err;
        log.warn(
          `Migration ${migration.version} kam nicht an die Schreibsperre (${err.code}), `
          + `Versuch ${attempt + 1} von ${MIGRATION_BUSY_ATTEMPTS} (#1331).`
        );
        sleepSync(MIGRATION_BUSY_BACKOFF_MS * attempt);
      }
    }
  };

  for (const migration of pending) {
    if (!migration.foreignKeysOff) {
      applyPendingMigration(migration);
      continue;
    }

    database.pragma('foreign_keys = OFF');
    if (database.pragma('foreign_keys', { simple: true }) !== 0) {
      throw new Error(`Migration ${migration.version} could not disable foreign key enforcement.`);
    }
    try {
      applyPendingMigration(migration);
    } finally {
      database.pragma('foreign_keys = ON');
      if (database.pragma('foreign_keys', { simple: true }) !== 1) {
        throw new Error(`Migration ${migration.version} could not restore foreign key enforcement.`);
      }
    }
  }
}

/**
 * Migrationsnummern, die diese Datenbank trägt und dieser Build nicht kennt.
 *
 * Das ist die Signatur einer NEUEREN Yuvomi-Version auf dieser Datei - nach
 * einem Rollback des Images (Umbrel, Unraid) oder mit einem Backup aus einer
 * neueren Installation. `migrate()` sieht nur die Gegenrichtung: es führt
 * nach, was fehlt, und übergeht stumm, was es nicht kennt. Eine ältere App
 * liefe damit gegen Tabellen und Spalten, die sie nicht kennt, und fiele erst
 * dort auf, wo sie schreibt. Migrationen sind einbahnig
 * (test:migrations-append-only); der Rückweg ist das Backup vor dem Update.
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @returns {number[]} aufsteigend, leer wenn alles bekannt ist
 */
function unknownMigrationVersions(database) {
  const known = new Set(MIGRATIONS.map((m) => m.version));
  return database
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row.version)
    .filter((version) => !known.has(version));
}

function latestKnownVersion() {
  return Math.max(0, ...MIGRATIONS.map((m) => m.version));
}

/** Notfallschalter: nur ein ausdrückliches 1/true/yes zählt, ein leerer Wert nicht. */
function allowNewerSchema() {
  return /^(1|true|yes)$/i.test(String(process.env.DB_ALLOW_NEWER_SCHEMA || '').trim());
}

/**
 * Kritische additive Spalten, die real vorhanden sein MÜSSEN, sobald ihre
 * Migration als angewendet gilt. Jede Spalte ist eine gefahrlos wiederholbare
 * `ADD COLUMN` (NULL-Default) - die einzige idempotente Reparaturform.
 *
 * `backfill` (optional): der Nachtrag, den die Migration der Spalte nach dem
 * `ADD COLUMN` faehrt. Er laeuft nur, wenn die Spalte hier wirklich neu
 * angelegt wurde, und in derselben Transaktion wie sie.
 */
const CRITICAL_COLUMNS = [
  // #538: v54 trägt reminders.pushed_at nach; ohne die Spalte scheitert der
  // Notification-/Push-Scheduler bei jedem Lauf still auf `no such column`.
  { table: 'reminders', column: 'pushed_at', type: 'TEXT' },
  // #549: v97 trägt calendar_events.tzid nach; ohne die Spalte scheitert der
  // Sync-Upsert (schreibt tzid) still und die Kalender-Expansion driftet über DST.
  { table: 'calendar_events', column: 'tzid', type: 'TEXT' },
  // #1860: v238 traegt das Konto eines gespiegelten Termins und seines
  // Loeschauftrags nach; ohne die Spalten scheitert jeder CalDAV-Lauf, weil
  // Abruf, Ausgang und Prune danach filtern.
  { table: 'calendar_events', column: 'caldav_account_id',
    type: 'INTEGER REFERENCES caldav_accounts(id) ON DELETE SET NULL' },
  { table: 'calendar_pending_deletions', column: 'caldav_account_id',
    type: 'INTEGER REFERENCES caldav_accounts(id) ON DELETE CASCADE' },
  // #1883: v240 traegt den ETag eines Loeschauftrags nach; ohne die Spalte
  // scheitert das Lesen der Auftraege und damit jeder ausgehende Durchgang.
  { table: 'calendar_pending_deletions', column: 'etag', type: 'TEXT' },
  // #1700: v243 traegt die Vormerkung eines Umzugs zwischen gespiegelten
  // Einkaufslisten nach; ohne die Spalten scheitert der Abruf jedes
  // Einkaufsartikels (er liest sie, bevor er die Zeile anfasst) und jeder
  // Sofortversuch.
  { table: 'shopping_items', column: 'outbound_move', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'shopping_items', column: 'outbound_move_attempts', type: 'INTEGER NOT NULL DEFAULT 0' },
  // #1911: v259 traegt den Beginn eines Umzugs nach; ohne die Spalte scheitert
  // jeder Umzug eines gespiegelten Artikels (die Route schreibt sie) und jeder
  // Lauf (er liest sie). MIT NACHTRAG: wartende Umzuege beginnen ihre Frist
  // mit der Spalte, wie in der Migration.
  { table: 'shopping_items', column: 'outbound_move_since', type: 'TEXT',
    backfill: backfillShoppingMoveSince },
  // #1912: v260 merkt sich, wer verschoben hat; die Route schreibt die Spalte
  // bei jedem Umzug eines gespiegelten Artikels.
  { table: 'shopping_items', column: 'outbound_move_by', type: 'INTEGER REFERENCES users(id) ON DELETE SET NULL' },
  // #1935: v246 traegt nach, wer Start und Regel eines Termins verfasst hat;
  // ohne die Spalte scheitert das Anlegen jedes Termins und jeder Abruf von
  // Google, CalDAV und iCloud (er liest sie, bevor er die Zeile anfasst).
  // MIT NACHTRAG: die Spalte allein stellte jede Zeile auf 0 ("unbekannt"),
  // auch die hier angelegten, die Migration 246 auf 1 gesetzt hatte. Eine
  // einst gesetzte Marke an einer gespiegelten Zeile ist mit der Spalte
  // verloren und bleibt unbekannt.
  { table: 'calendar_events', column: 'series_authored',
    type: 'INTEGER NOT NULL DEFAULT 0 CHECK(series_authored IN (0, 1))',
    backfill: backfillSeriesAuthored },
  // #1956: v248 traegt den Sende-Schnappschuss nach; ohne die Spalte scheitert
  // jeder Abruf von Google, CalDAV und iCloud (er liest sie, bevor er die
  // Zeile anfasst) und jede Buchung eines Pushs. Kein Nachtrag: NULL heisst
  // "kein Schnappschuss", der Abruf nimmt den Weg von vorher.
  { table: 'calendar_events', column: 'outbound_snapshot', type: 'TEXT' },
  // #2056: v251 traegt den Schluessel des Profilbilds nach; ohne die Spalte
  // scheitern Aufgaben, Termine, Notizen, Uebersicht, Housekeeping und die
  // Taschengeld-Buchungen (ihre Bildadresse liest sie). MIT NACHTRAG: die
  // Schluessel der vorhandenen Bilder und die Trigger, die ihn bei jedem neuen
  // Bild neu wuerfeln, kommen mit der Spalte.
  { table: 'users', column: 'avatar_key', type: 'TEXT',
    backfill: backfillAvatarKey },
  // #1836: v252 traegt die Quelle einer Erledigung nach; ohne die Spalte
  // scheitert jeder Uebergang nach 'done' (der Eintrag schreibt sie, die
  // Aufgabenaenderung rollt mit zurueck) und jeder Verlauf (er liest sie). Kein
  // Nachtrag: NULL heisst "in Yuvomi abgehakt".
  { table: 'task_completions', column: 'source', type: 'TEXT' },
  // #2095: v254 traegt "Jahr unbekannt" an Geburtstag und Kontakt nach; ohne die
  // Spalten scheitern Kalender, Uebersicht und Geburtstagsliste (sie lesen sie,
  // um Jahr und Alter wegzulassen). MIT NACHTRAG: Apples Platzhalterjahr 1604
  // wird mit der Spalte umgestellt, wie in der Migration.
  { table: 'birthdays', column: 'year_unknown',
    type: 'INTEGER NOT NULL DEFAULT 0 CHECK(year_unknown IN (0, 1))',
    backfill: backfillBirthdayYearUnknown },
  { table: 'contacts', column: 'birthday_year_unknown',
    type: 'INTEGER NOT NULL DEFAULT 0 CHECK(birthday_year_unknown IN (0, 1))',
    backfill: backfillContactBirthdayYearUnknown },
  // #1839: v266 traegt "gesehen" nach; ohne die Spalten scheitert jeder Prune
  // von CalDAV und iCloud (er liest und schreibt sie) und jede Buchung eines
  // Uploads. Kein Nachtrag: 0 ist der Stand, mit dem die Migration beginnt.
  { table: 'calendar_events', column: 'seen_on_server', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'tasks', column: 'seen_on_server', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'shopping_items', column: 'seen_on_server', type: 'INTEGER NOT NULL DEFAULT 0' },
  // D#2330: v273 traegt den Feed-Stand nach; ohne die Spalte scheitert jeder
  // ICS-Sync (er schreibt sie) und jeder Reset (er liest sie).
  { table: 'calendar_events', column: 'feed_original', type: 'TEXT' },
  // #2506: v279 traegt die fremde Serienregel nach; ohne die Spalte scheitert
  // jeder VTODO-Abruf (der Upsert schreibt sie). Kein Nachtrag: NULL ist der
  // Stand, mit dem die Migration beginnt, der naechste Abruf fuellt sie.
  { table: 'tasks', column: 'external_rrule', type: 'TEXT' },
  // #2499: v281 traegt die Absage des Anbieters nach; ohne die Spalte scheitert
  // jeder Kalender-Abruf (der Upsert schreibt sie) und jede Erinnerung (der
  // Filter liest sie). Kein Nachtrag: NULL heisst "nicht abgesagt", der
  // naechste Abruf fuellt sie.
  { table: 'calendar_events', column: 'provider_status',
    type: "TEXT CHECK(provider_status IS NULL OR provider_status IN ('TENTATIVE', 'CONFIRMED', 'CANCELLED'))" },
];

/**
 * Selbstheilung gegen Migrations-Drift (#538).
 *
 * In seltenen Fällen ist eine Migration in `schema_migrations` als angewendet
 * vermerkt, ihr additiver Effekt fehlt real aber - etwa nach Restore aus einem
 * zu einem inkonsistenten Zeitpunkt gezogenen Backup oder einem abgebrochenen
 * Migrationslauf. Eine so fehlende Spalte lässt einen ganzen Hintergrund-Loop
 * still auf `no such column` scheitern (der Push-/Notification-Scheduler auf
 * `reminders.pushed_at`), ohne dass es in der UI sichtbar wird.
 *
 * Diese Funktion stellt die bekannten kritischen Spalten idempotent sicher und
 * protokolliert jede Nachbesserung sichtbar. Sie ersetzt Migrationen NICHT -
 * die bleiben die einzige Quelle für Schemaänderungen; dies ist nur ein
 * Sicherheitsnetz für additive Drift.
 */
function reconcileCriticalSchema(database = db) {
  if (!database) return;
  for (const { table, column, type, backfill } of CRITICAL_COLUMNS) {
    let columns;
    try {
      columns = database.prepare(`PRAGMA table_info(${table})`).all();
    } catch {
      continue; // Tabelle nicht lesbar - keine additive Reparatur möglich.
    }
    if (!columns.length) continue;                          // Tabelle existiert nicht
    if (columns.some((c) => c.name === column)) continue;   // Spalte bereits vorhanden
    try {
      if (backfill) {
        // Spalte und Nachtrag zusammen oder gar nicht: eine Spalte ohne ihren
        // Nachtrag gaelte beim naechsten Start als vorhanden, und der Nachtrag
        // liefe nie mehr. SAVEPOINT, weil es unter better-sqlite3 und
        // node:sqlite gleich geht und auch in einer offenen Transaktion.
        database.exec('SAVEPOINT reconcile_column');
        try {
          database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
          backfill(database);
          database.exec('RELEASE SAVEPOINT reconcile_column');
        } catch (err) {
          database.exec('ROLLBACK TO SAVEPOINT reconcile_column');
          database.exec('RELEASE SAVEPOINT reconcile_column');
          throw err;
        }
      } else {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
      log.warn(`Schema-Drift behoben: ${table}.${column} fehlte trotz vermerkter Migration und wurde nachgetragen (#538).`);
    } catch (err) {
      log.error(`Schema-Reconciliation ${table}.${column} fehlgeschlagen:`, err?.message || err);
    }
  }
  reconcileAvatarKeyTriggers(database);
}

/**
 * Die Schluessel-Trigger der Profilbilder (Migration 251) - auch wenn NUR sie
 * fehlen. Der Nachtrag oben laeuft nur mit einer neu angelegten Spalte; ein
 * Neubau von `users` nimmt Trigger aber nicht mit, und ohne sie behielte ein
 * neues Bild seinen alten Schluessel (Codex-Review zu #2056). Die Reparatur
 * wuerfelt dann alle Schluessel neu - was ohne Trigger geschrieben wurde,
 * steht sonst unter einer falschen oder gar keiner Adresse.
 */
function reconcileAvatarKeyTriggers(database) {
  try {
    const columns = database.prepare('PRAGMA table_info(users)').all();
    if (!columns.some((c) => c.name === 'avatar_key')) return;
    const present = database.prepare(`
      SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'trigger' AND name IN ('trg_users_avatar_key_update', 'trg_users_avatar_key_insert')
    `).get().n;
    if (present === 2) return;
    // JEDER SCHLUESSEL NEU, nicht nur die fehlenden: ohne die Trigger kann ein
    // Bild unter dem alten Schluessel ersetzt worden sein, und dessen
    // `immutable`-Adresse zeigte aus dem Cache weiter das alte Bild.
    database.exec('SAVEPOINT reconcile_avatar_key');
    try {
      createAvatarKeyTriggers(database);
      database.exec(`
        UPDATE users SET avatar_key = CASE
          WHEN avatar_data IS NULL OR avatar_data = '' THEN NULL
          ELSE lower(hex(randomblob(16))) END
      `);
      database.exec('RELEASE SAVEPOINT reconcile_avatar_key');
    } catch (err) {
      database.exec('ROLLBACK TO SAVEPOINT reconcile_avatar_key');
      database.exec('RELEASE SAVEPOINT reconcile_avatar_key');
      throw err;
    }
    log.warn('Schema-Drift behoben: Trigger fuer users.avatar_key fehlten, wurden neu angelegt und alle Schluessel neu gewuerfelt (#2056).');
  } catch (err) {
    log.error('Schema-Reconciliation der avatar_key-Trigger fehlgeschlagen:', err?.message || err);
  }
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
    database.exec('SAVEPOINT adopt_pantry_batches');
    let result;
    try {
      result = groupBatchesIntoProducts(database, productKey);
      database.exec('RELEASE SAVEPOINT adopt_pantry_batches');
    } catch (err) {
      database.exec('ROLLBACK TO SAVEPOINT adopt_pantry_batches');
      database.exec('RELEASE SAVEPOINT adopt_pantry_batches');
      throw err;
    }
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
  if (!db) return 0;
  try {
    const row = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get();
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

function getPath() {
  return DB_PATH;
}

/**
 * Laufende `backupToFile()`-Aufrufe. Der Restore wartet vor dem Schliessen der
 * Verbindung, bis keiner mehr laeuft (Codex-Befund in #1431): seit die
 * Arbeitsdatei VOR dem Schliessen kopiert wird, kann waehrend dieses Kopierens
 * ein Backup (Download-Route, Zeitplan) auf der noch offenen Verbindung
 * beginnen - und `db.close()` zoege ihm die Verbindung unter den Haenden weg.
 * @type {Set<Promise<unknown>>}
 */
const activeBackups = new Set();

function backupToFile(destinationPath) {
  const running = backupToFileUntracked(destinationPath);
  const tracked = running.finally(() => activeBackups.delete(tracked));
  activeBackups.add(tracked);
  return tracked;
}

async function backupToFileUntracked(destinationPath) {
  const database = get();
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  if (DB_KEY) {
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

  await verifyWrittenBackup(destinationPath);
  return destinationPath;
}

/**
 * `VACUUM INTO` auch waehrend eines Restores: `query_only` (siehe
 * `restoreFromFile()`) sperrt es sonst, obwohl es nur in eine andere Datei
 * schreibt. Das Loesen und Wiedersetzen ist synchron - dazwischen kann kein
 * anderer Request schreiben.
 */
function vacuumInto(database, destinationPath) {
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
function undecryptableBackupError(cause) {
  if (!DB_KEY) {
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
 * @param {string} message
 * @param {string} reason
 * @param {unknown} [cause]
 */
function restoreError(message, reason, cause) {
  const err = cause === undefined ? new Error(message) : new Error(message, { cause });
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
 * @param {boolean} encrypted  Datei hat keinen Klartext-SQLite-Kopf
 * @param {unknown} cause      Fehler beim Öffnen oder ersten Lesen
 * @returns {Error}
 */
function unreadableBackupError(encrypted, cause) {
  const code = typeof cause?.code === 'string' ? cause.code : '';
  if (!encrypted) {
    // Kopf da, aber schon die Schemaseite kaputt: ein beschaedigtes Backup,
    // keine fremde Datei - derselbe Grund wie aus `assertBackupIntact()`
    // (Codex-Befund in #1431).
    if (code.startsWith('SQLITE_CORRUPT')) {
      return restoreError(
        `Backup file is damaged (${code}: ${cause?.message ?? String(cause)}). Its SQLite header is `
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
  if (code === 'SQLITE_NOTADB') return undecryptableBackupError(cause);

  const detail = `${code || 'no SQLite error code'}: ${cause?.message ?? String(cause)}`;
  if (DB_KEY && code.startsWith('SQLITE_CORRUPT')) {
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
function firstFinding(result) {
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
 * @param {import('better-sqlite3-multiple-ciphers').Database} candidate
 * @param {boolean} encrypted
 */
function assertBackupIntact(candidate, encrypted) {
  let result;
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
    const code = typeof err?.code === 'string' ? err.code : '';
    if (!code.startsWith('SQLITE_CORRUPT')) throw unreadableBackupError(encrypted, err);
    result = `${code}: ${err.message}`;
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
 * @param {string} sourcePath
 * @returns {number}
 */
function checkBackupFile(sourcePath) {
  return validateBackupFile(sourcePath);
}

/**
 * Backup-Datei oeffnen und lesen wie vor einem Restore: mit dem eigenen
 * Schluessel, falls sie keinen Klartext-Kopf hat, `sqlite_master` lesbar, jede
 * Seite heil (`assertBackupIntact()`). Liefert die offene Verbindung; wirft
 * mit denselben Gruenden wie der Restore und schliesst sie dann selbst.
 * @param {string} sourcePath
 */
function openIntactBackup(sourcePath) {
  // Backups, die vor der Verschlüsselungs-Umstellung entstanden sind, liegen im
  // Klartext vor. Sie müssen einspielbar bleiben - würden wir ihnen den Key
  // aufsetzen, läse SQLite sie als verschlüsselt und die Validierung schlüge
  // fehl. Nach dem Restore verschlüsselt init() sie ohnehin.
  const encrypted = !isPlaintextDatabase(sourcePath);
  let candidate;
  try {
    candidate = new Database(sourcePath, { readonly: true, fileMustExist: true });
  } catch (err) {
    // Das Öffnen zählt mit: eine Datei, an der schon der Konstruktor scheitert,
    // liefe sonst an der Diagnose vorbei und käme als rohe SQLite-Zeile heraus.
    throw unreadableBackupError(encrypted, err);
  }
  try {
    if (encrypted) applyEncryptionKey(candidate);
    try {
      assertReadable(candidate);
    } catch (err) {
      throw unreadableBackupError(encrypted, err);
    }
    assertBackupIntact(candidate, encrypted);
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
 * @param {string} destinationPath
 */
async function verifyWrittenBackup(destinationPath) {
  try {
    openIntactBackup(destinationPath).close();
  } catch (cause) {
    await unlinkIfExists(destinationPath);
    await removeCheckSideFiles(destinationPath);
    // Nur der erste Satz: der Rest der Restore-Meldung raet zum erneuten
    // Herunterladen, und das passt nicht zu einem Backup, das hier entsteht.
    const finding = String(cause?.message ?? cause).split('. ')[0];
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
 * @param {string} destinationPath
 */
async function removeCheckSideFiles(destinationPath) {
  await unlinkIfExists(`${destinationPath}-wal`);
  await unlinkIfExists(`${destinationPath}-shm`);
}

function validateBackupFile(sourcePath) {
  const candidate = openIntactBackup(sourcePath);
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
    return candidate.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? 0;
  } finally {
    candidate.close();
  }
}

async function unlinkIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

/** Datei umbenennen; `false`, wenn es sie nicht gibt. */
async function renameIfExists(from, to) {
  try {
    await fs.rename(from, to);
    return true;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return false;
  }
}

/**
 * Wohin `restoreFromFile()` das Journal einer leeren Datei legt: neben die
 * Rollback-Kopie, aber unter einem Namen, den SQLite nicht von selbst aufgreift
 * (`<kopie>.wal-kept`, nicht `<kopie>-wal`).
 */
function keptJournalName(rollbackPath, kind) {
  return `${rollbackPath}.${kind}-kept`;
}

/** `true`, wenn DB_ENCRYPTION_KEY dieser Instanz die Datei oeffnet und liest. */
function opensWithOwnKey(filePath) {
  if (!DB_KEY) return false;
  let candidate;
  try {
    candidate = new Database(filePath, { readonly: true, fileMustExist: true });
    applyEncryptionKey(candidate);
    assertReadable(candidate);
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
function backupKeyBytes(backupKey) {
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
function foreignKeyReadError(cause, { keyProven = false } = {}) {
  const code = typeof cause?.code === 'string' ? cause.code : '';
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
  const text = cause?.message ?? String(cause);
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
 * @param {string} sourcePath
 * @param {Buffer} oldKey
 * @returns {Promise<{ dir: string, path: string }>}
 */
async function rekeyForeignBackup(sourcePath, oldKey) {
  if (!DB_KEY) {
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
  assertCipherSupport();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuvomi-rekey-'));
  const workingPath = path.join(dir, 'rekeyed.db');
  try {
    try {
      await fs.copyFile(sourcePath, workingPath);
    } catch (err) {
      throw foreignKeyReadError(err);
    }
    let working;
    try {
      working = new Database(workingPath, { fileMustExist: true });
    } catch (err) {
      throw foreignKeyReadError(err);
    }
    try {
      working.pragma('temp_store = MEMORY');
      applyKeyBytes(working, oldKey);
      try {
        assertReadable(working);
      } catch (err) {
        throw foreignKeyReadError(err);
      }
      // Ein Backup aus `VACUUM INTO` einer WAL-Datenbank traegt das WAL-Flag
      // im Kopf. DELETE haelt das Umschluesseln in EINER Datei: ohne entstuende
      // ein `-wal` neben der Arbeitskopie im Temp-Verzeichnis. init() stellt
      // nach dem Restore ohnehin wieder auf WAL.
      try {
        working.pragma('journal_mode = DELETE');
        working.pragma(`rekey="x'${Buffer.from(DB_KEY, 'utf8').toString('hex')}'"`);
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
 * Laeuft in diesem Prozess gerade ein Restore? Ein zweiter (zweiter Tab,
 * zweiter Admin) wird sofort abgelehnt, statt mit dem ersten um dieselben
 * Dateien zu ringen: im Review von #1431 nachgestellt, ueberschrieb der zweite die
 * halbe Arbeitsdatei bzw. die Rollback-Kopie des ersten, und der erste hing
 * danach eine Mischung an DB_PATH (`database disk image is malformed`).
 * Gesetzt wird der Riegel vor dem ersten `await`, geloest im `finally`.
 * Gegen einen Restore aus einem ANDEREN Prozess (CLI neben dem Server) wirkt
 * er nicht. Dafuer tragen Arbeitsdatei und halbe Rollback-Kopie die
 * Prozessnummer im Namen: kein Prozess ueberschreibt die des anderen, und
 * `removeRestoreStaging()` raeumt nur Dateien toter Prozesse weg. Den Tausch
 * selbst serialisiert das nicht - beide haengten nacheinander eine
 * vollstaendige Datenbank an DB_PATH.
 */
let restoreRunning = false;

/**
 * Backup einspielen.
 * @param {string} sourcePath
 * @param {{ backupKey?: string | Buffer | null }} [options] `backupKey`: der
 *   DB_ENCRYPTION_KEY der Installation, die das Backup geschrieben hat - nur
 *   fuer ein verschluesseltes Backup einer ANDEREN Installation (#1267). Er
 *   wird nicht gespeichert und steht in keiner Meldung.
 */
async function restoreFromFile(sourcePath, { backupKey = null } = {}) {
  if (restoreRunning) {
    throw restoreError(RESTORE_IN_PROGRESS_MESSAGE, RESTORE_IN_PROGRESS_REASON);
  }
  restoreRunning = true;
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
    await waitForQuietOrGiveUp();
    // Ab jetzt nimmt die laufende Verbindung keine Schreibzugriffe mehr an
    // (Codex-Befund in #1431): seit die Arbeitsdatei VOR dem Schliessen kopiert
    // wird, bleibt sie waehrenddessen offen, und ein Schreibzugriff meldete
    // Erfolg, den Checkpoint, Schliessen und rename danach verwarfen. Die neue
    // Verbindung nach dem Tausch beginnt ohne den Riegel, nach einem
    // Fehlschlag wird er unten geloest.
    try { db?.pragma('query_only = ON'); } catch { /* ohne Verbindung nichts zu sperren */ }
    return await restoreFromFileUnlocked(sourcePath, { backupKey });
  } finally {
    restoreRunning = false;
    setRestoreRunning(false);
    try { db?.pragma('query_only = OFF'); } catch { /* best effort */ }
  }
}

/**
 * Auf laufende Backups, Jobs und zugelassene Anfragen warten - hoechstens
 * `restoreWaitTimeoutMs()`. Laeuft die Frist ab, bricht der Restore ab, bevor er
 * die Verbindung sperrt oder etwas aendert, mit einem Grund, den der Dialog
 * uebersetzt (Review #1431).
 */
async function waitForQuietOrGiveUp() {
  const quiet = await waitUntilIdle(
    () => [...activeBackups, ...activeWriters()],
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
 * @param {number} deadline Zeitpunkt in ms
 * @returns {Promise<boolean>} `true`, wenn nichts mehr lief und die Verbindung zu ist
 */
async function closeForShutdown(deadline) {
  const quiet = await waitUntilIdle(() => [...activeBackups, ...activeWriters()], deadline);
  if (restoreRunning || !db) return false;
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  db.close();
  db = null;
  return quiet;
}

/** Laeuft gerade ein Restore? Fuer `restoreWriteGate`. */
function isRestoreRunning() {
  return restoreRunning;
}

/**
 * Ist die Verbindung offen? Waehrend eines Restores ist sie es vom Schliessen
 * bis zum Wiederoeffnen nicht - dann beantwortet `restoreWriteGate` auch
 * lesende API-Anfragen mit 503 (Review #1431).
 */
function isDatabaseOpen() {
  return Boolean(db);
}

/**
 * `true`, wenn `sourcePath` dieselbe Datei ist wie DB_PATH (auch per Symlink
 * oder hartem Link). Ein Restore der laufenden Datenbank auf sich selbst
 * kopierte die Hauptdatei VOR dem Checkpoint: was nur im `-wal` stand, fehlte
 * der Arbeitsdatei, und das rename haengte diesen alten Stand als „Erfolg" ein
 * (Codex-Befund in #1431).
 */
function isActiveDatabaseFile(sourcePath) {
  try {
    // bigint: grosse Inode-Nummern (manche Netz- und Overlay-Dateisysteme)
    // passen nicht verlustfrei in eine Zahl.
    const source = statSync(sourcePath, { bigint: true });
    const active = statSync(DB_PATH, { bigint: true });
    return source.dev === active.dev && source.ino === active.ino;
  } catch {
    return false;
  }
}

async function restoreFromFileUnlocked(sourcePath, { backupKey }) {
  if (isActiveDatabaseFile(sourcePath)) {
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
  const rekeyed = oldKey && !isPlaintextDatabase(sourcePath) && !opensWithOwnKey(sourcePath)
    ? await rekeyForeignBackup(sourcePath, oldKey)
    : null;
  try {
    return await restoreValidatedFile(rekeyed?.path ?? sourcePath);
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
function restoreStagingPath() {
  // Eigener Name je Restore: ein Restore aus einem zweiten Prozess (CLI neben
  // dem laufenden Server) ueberschreibt so nie die Arbeitsdatei des ersten.
  return `${DB_PATH}${RESTORE_STAGING_SUFFIX}-${process.pid}-${Date.now().toString(36)}`;
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
async function syncDirectory(dirPath) {
  let handle;
  try {
    handle = await fs.open(dirPath, 'r');
    await handle.sync();
  } catch (err) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(err?.code)) throw err;
  } finally {
    await handle?.close().catch(() => {});
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
 * @param {string} stagingPath  fertig geschriebene Arbeitsdatei oder, beim
 *   Rollback, die Rollback-Kopie
 */
async function swapIntoDbPath(stagingPath, onRenamed = () => {}) {
  await fs.rename(stagingPath, DB_PATH);
  // Sofort vermerken: scheitert der fsync danach, liegt die Datei trotzdem
  // schon an DB_PATH, und der Aufrufer muss das wissen.
  onRenamed();
  await syncDirectory(path.dirname(DB_PATH));
}

/** `from` nach `stagingPath` kopieren und die Datei auf die Platte bringen. */
async function stageDatabaseCopy(from, stagingPath) {
  await unlinkIfExists(stagingPath);
  await fs.copyFile(from, stagingPath);
  await adoptDatabaseAttributes(stagingPath);
  // Schreibend oeffnen, wo es geht: Windows (FlushFileBuffers) verlangt fuer
  // fsync einen Handle mit Schreibrecht und antwortet sonst mit EPERM - ein
  // Restore unter Node nativ auf Windows blieb daran stehen (#1441). Traegt
  // die Datei keine Schreibrechte, genuegt ausserhalb von Windows ein lesender
  // Handle wie bisher.
  let handle;
  try {
    handle = await fs.open(stagingPath, 'r+');
  } catch (err) {
    if (err?.code !== 'EACCES' && err?.code !== 'EPERM') throw err;
    handle = await fs.open(stagingPath, 'r');
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
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
 * @param {string} filePath
 */
/**
 * Kann, wer die bisherige Datenbank schreiben durfte, auch die neue Datei
 * schreiben? Besitzer gleich: Besitzerbit; sonst Gruppe gleich: Gruppenbit.
 * Wer nur ueber die Gruppe schrieb, schreibt so weiter; wer Besitzer war und
 * es nicht mehr ist, verliert das Recht (ausser die Datei ist fuer alle
 * schreibbar).
 * @param {import('node:fs').Stats} staged
 * @param {import('node:fs').Stats} previous
 */
function stillWritableForPreviousWriters(staged, previous, { processMayWritePrevious = false } = {}) {
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

async function adoptDatabaseAttributes(filePath) {
  let previous = null;
  try { previous = await fs.stat(DB_PATH); } catch { /* keine bisherige Datenbank */ }
  try {
    await fs.chmod(filePath, previous ? previous.mode & 0o7777 : 0o600);
  } catch (err) {
    // FUSE- und SMB-Mounts eines NAS lehnen chmod oft ab - dann gelten ihre
    // eigenen Rechte. Abbrechen nur, wenn der Besitzer die Datei so nicht
    // schreiben kann: sie wird gleich DB_PATH.
    const mode = (await fs.stat(filePath)).mode;
    if ((mode & 0o200) === 0) throw err;
    log.warn(`Could not set the mode of ${filePath} (${err?.code ?? err}); keeping the one the file system gave it.`);
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
      if (globalThis[RESTORE_TARGET_HANDSHAKE] !== true) {
        try {
          await fs.access(DB_PATH, fsConstants.W_OK);
          processMayWritePrevious = true;
        } catch { /* der laufende Prozess darf die bisherige Datenbank nicht schreiben */ }
      }
      if (!stillWritableForPreviousWriters(staged, previous, { processMayWritePrevious })) {
        throw new Error(
          `Could not give ${filePath} the owner of the current database (uid ${previous.uid}, gid `
          + `${previous.gid}; it belongs to uid ${staged.uid}, gid ${staged.gid}): ${err?.code ?? err}. `
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
 * @param {number} pid
 */
function otherProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
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
function removeRestoreStaging() {
  if (DB_PATH === ':memory:') return;
  const dir = path.dirname(DB_PATH);
  const base = path.basename(DB_PATH);
  const stagingPrefix = `${base}${RESTORE_STAGING_SUFFIX}-`;
  const rollbackPrefix = `${base}.pre-restore-`;
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    let pid;
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
 * @param {any} database
 * @returns {Record<string, string | null> | null} null when it cannot be read
 */
function readBackupStatus(database) {
  try {
    const read = database.prepare('SELECT value FROM sync_config WHERE key = ?');
    return Object.fromEntries(Object.values(BACKUP_STATUS_KEYS).map((key) => [key, read.get(key)?.value ?? null]));
  } catch (err) {
    log.warn(`Could not read the backup status before the restore: ${/** @type {any} */ (err)?.code ?? 'unknown error'}`);
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
 * @param {any} database
 * @param {Record<string, string | null> | null} carried
 */
function writeBackupStatus(database, carried) {
  try {
    const upsert = database.prepare(`
      INSERT INTO sync_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `);
    const remove = database.prepare('DELETE FROM sync_config WHERE key = ?');
    database.transaction(() => {
      for (const key of Object.values(BACKUP_STATUS_KEYS)) {
        const value = carried?.[key] ?? null;
        if (value === null) remove.run(key);
        else upsert.run(key, value);
      }
    })();
  } catch (err) {
    log.warn(`Could not carry the backup status into the restored database: ${/** @type {any} */ (err)?.code ?? 'unknown error'}`);
  }
}

async function restoreValidatedFile(sourcePath) {
  const backupVersion = validateBackupFile(sourcePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rollbackPath = `${DB_PATH}.pre-restore-${timestamp}`;
  // Mit Prozessnummer wie die Arbeitsdatei: `removeRestoreStaging()` laesst
  // die Datei eines noch laufenden fremden Prozesses liegen.
  const rollbackPartialPath = `${rollbackPath}.${process.pid}${ROLLBACK_PARTIAL_SUFFIX}`;
  const stagingPath = restoreStagingPath();
  let rollbackCreated = false;
  // Offen ist die Verbindung, außer im Leer-Fall des Restore-CLI (#1282, siehe
  // Auto-Init am Dateiende). Nur eine offene Verbindung wird unten per
  // TRUNCATE gecheckpointet; danach trägt die Rollback-Kopie alles, und ein
  // Rest-Journal zu löschen verliert nichts.
  const wasOpen = Boolean(db);
  let keptJournalPath = null;
  // Ab hier liegt an DB_PATH die Datenbank aus dem Backup (#1422).
  let swapped = false;
  // Die Rollback-Kopie ist per rename zurueck an DB_PATH.
  let rolledBack = false;
  /** @type {Record<string, string | null> | null} */
  let carriedBackupStatus = null;

  try {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    // Zuerst die Arbeitsdatei: scheitert schon das Kopieren (volle Platte),
    // ist die laufende Verbindung noch gar nicht angefasst.
    await stageDatabaseCopy(sourcePath, stagingPath);

    // Laufende Backups zu Ende kommen lassen. Zwischen dem letzten Blick auf
    // `activeBackups` und `db.close()` steht kein await: ein neues Backup kann
    // dort nicht mehr beginnen, und danach findet es keine Verbindung.
    // Waehrend des Kopierens kann ein Download ein Backup begonnen haben.
    // Scheitert das Warten, raeumt der catch unten die Arbeitsdatei weg - die
    // Datenbank ist noch nicht angefasst. Die Schleife prueft nach dem letzten
    // await noch einmal synchron - erst dann ist die Luecke zu.
    do {
      await waitForQuietOrGiveUp();
    } while (activeBackups.size > 0 || activeWriters().length > 0);
    if (db) {
      carriedBackupStatus = readBackupStatus(get());
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      db.close();
      db = null;
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
    const hadDatabase = existsSync(DB_PATH);
    try {
      await stageDatabaseCopy(DB_PATH, rollbackPartialPath);
      await fs.rename(rollbackPartialPath, rollbackPath);
      // Den Namen dauerhaft machen, BEVOR DB_PATH ersetzt wird: sonst kann nach
      // einem Stromausfall das Backup an DB_PATH stehen, die Rollback-Kopie aber
      // noch unter `.partial` - und die raeumt der naechste Start weg
      // (Codex-Befund in #1431).
      await syncDirectory(path.dirname(DB_PATH));
      rollbackCreated = true;
    } catch (err) {
      if (err?.code !== 'ENOENT' || hadDatabase) throw err;
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
    if (!wasOpen && regularFileSize(`${DB_PATH}-wal`) > 0) {
      await fs.rename(`${DB_PATH}-wal`, keptJournalName(rollbackPath, 'wal'));
      keptJournalPath = keptJournalName(rollbackPath, 'wal');
      await renameIfExists(`${DB_PATH}-shm`, keptJournalName(rollbackPath, 'shm'));
    }
    await unlinkIfExists(`${DB_PATH}-wal`);
    await unlinkIfExists(`${DB_PATH}-shm`);
    // Das Entfernen der alten Nebendateien dauerhaft machen, BEVOR DB_PATH
    // ersetzt wird: sonst kann nach einem Stromausfall das neue DB_PATH stehen
    // und das alte -wal wieder daneben - und SQLite wendete es auf die falsche
    // Datei an (Codex-Befund in #1431).
    await syncDirectory(path.dirname(DB_PATH));
    await swapIntoDbPath(stagingPath, () => { swapped = true; });

    // Ohne Klartext-Sicherheitskopie: stammt das Backup aus der Zeit vor der
    // Verschlüsselung, verschlüsselt init() es jetzt — die Sicherung dafür ist
    // die Quelldatei selbst, plus `.pre-restore-*` für den Rollback. Eine
    // zusätzliche unverschlüsselte Vollkopie im Datenverzeichnis würde sich bei
    // jedem Restore erneut anhäufen und die Zusage „verschlüsselt at rest"
    // unterlaufen, ohne dass die Backup-UI davon berichtet.
    init({ plaintextBackup: false });
    writeBackupStatus(get(), carriedBackupStatus);
    log.info(`Database restored from backup. Schema v${backupVersion}${rollbackCreated ? ` | rollback: ${rollbackPath}` : ''}`);

    return {
      schemaVersion: currentVersion(),
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
          log.warn(`Could not remove ${leftover} after a failed restore: ${cleanupErr?.message ?? cleanupErr}`);
        }
      }
      if (swapped) {
        // init() kann die neue Datenbank schon geoeffnet haben.
        if (db) {
          db.close();
          db = null;
        }
        if (rollbackCreated) {
          // Die neue Datenbank liegt schon an DB_PATH: die alte per rename
          // zurueck, nicht per Kopie. Eine Kopie braucht noch einmal so viel
          // Platz wie die alte Datenbank, waehrend die neue noch an DB_PATH
          // liegt - bei vollem Datentraeger (der Fall aus #1422) scheiterte der
          // Rollback, und die Instanz blieb auf dem gescheiterten Backup ohne
          // Verbindung stehen (Review #1431). Das rename ist unteilbar und
          // braucht keinen Platz; die Rollback-Kopie ist danach DB_PATH selbst.
          await unlinkIfExists(`${DB_PATH}-wal`);
          await unlinkIfExists(`${DB_PATH}-shm`);
          await syncDirectory(path.dirname(DB_PATH));
          await swapIntoDbPath(rollbackPath, () => { rolledBack = true; });
        }
      }
      // Vor dem Tausch ist DB_PATH die alte Datei geblieben, nach dem Rollback
      // ist sie es wieder: ein beiseite gelegtes Journal gehoert zurueck neben
      // die (leere) Datei, an der die Meldung es nennt.
      if (keptJournalPath) {
        await renameIfExists(keptJournalName(rollbackPath, 'wal'), `${DB_PATH}-wal`);
        await renameIfExists(keptJournalName(rollbackPath, 'shm'), `${DB_PATH}-shm`);
        // Das zurueckgelegte Journal dauerhaft machen: sonst kann es nach einem
        // Stromausfall wieder unter `.wal-kept` liegen, wo die Meldung zur
        // leeren Datei es nicht nennt (Codex-Befund in #1431).
        await syncDirectory(path.dirname(DB_PATH));
      }
      if (!db && swapped && !rollbackCreated) {
        // Vorher gab es keine Datenbank: nichts zurueckzuholen.
        try { init({ plaintextBackup: false }); } catch { /* preserve original restore error */ }
      } else if (!db) {
        try {
          init({ plaintextBackup: false });
        } catch (reopenErr) {
          // Die leere Datei verweigert init() wie vor dem Restore - das ist der
          // alte Stand, kein gescheiterter Rollback.
          if (reopenErr?.code !== EMPTY_DATABASE_FILE) throw reopenErr;
        }
      }
    } catch (rollbackErr) {
      log.error('Rollback after failed restore also failed:', rollbackErr);
      // Nur wenn die Instanz wirklich nicht mehr wie vorher dasteht: getauscht,
      // oder ohne Verbindung. Scheitert bloss das Aufraeumen der Arbeitsdatei
      // (etwa EACCES), laeuft die alte Datenbank weiter - dann gilt der
      // urspruengliche Fehler, samt seinem Grund (Review #1431).
      if (swapped || !db) {
        throw rollbackFailedError(err, rollbackErr, {
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
 * @param {Error} restoreErr
 * @param {Error} rollbackErr
 * @param {{ swapped: boolean, rolledBack: boolean, rollbackPath: string | null }} state
 *   `swapped`: das Backup lag schon an DB_PATH; `rolledBack`: die Rollback-Kopie
 *   ist per rename zurueck; `rollbackPath`: die Rollback-Kopie, falls eine
 *   angelegt wurde (vorher gab es sonst keine Datenbank)
 */
function rollbackFailedError(restoreErr, rollbackErr, { swapped, rolledBack, rollbackPath }) {
  const lines = [
    `Restore failed: ${restoreErr?.message ?? String(restoreErr)}`,
    `Putting the previous database back failed as well: ${rollbackErr?.message ?? String(rollbackErr)}.`,
  ];
  if (swapped && !rolledBack && rollbackPath) {
    lines.push(
      `The database from before the restore is kept at ${rollbackPath}. Stop Yuvomi, move that file `
      + `to ${DB_PATH} (and delete ${DB_PATH}-wal and ${DB_PATH}-shm if they exist), then start Yuvomi again.`
    );
  } else if (swapped && !rolledBack) {
    lines.push(
      `There was no database at ${DB_PATH} before this restore, and the restored one does not start. `
      + `Delete ${DB_PATH} (with ${DB_PATH}-wal and ${DB_PATH}-shm) to start as a fresh instance, or restore another backup.`
    );
  } else if (rolledBack) {
    lines.push(`The database from before the restore is back at ${DB_PATH}, but it could not be opened again. Restart Yuvomi.`);
  } else {
    lines.push(`The restore never replaced ${DB_PATH}; the database there is the one from before, but it could not be opened again. Restart Yuvomi.`);
  }
  return new Error(lines.join(' '), { cause: restoreErr });
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

/**
 * Transaktion-Helfer: Funktion wird atomar ausgeführt.
 * Bei Fehler wird automatisch rollback ausgeführt.
 * @param {Function} fn
 * @returns {any}
 */
function transaction(fn) {
  return get().transaction(fn)();
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

export { init, get, transaction, currentVersion, getPath, backupToFile, restoreFromFile, checkBackupFile, isRestoreRunning, isDatabaseOpen, closeForShutdown, unknownMigrationVersions, MIGRATIONS, migrate, MIGRATION_BUSY_ATTEMPTS, reconcileCriticalSchema, adoptOrphanPantryBatches, _setTestDatabase, _resetTestDatabase };
