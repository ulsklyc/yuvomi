/**
 * Modul: Instanzsperre - "ein Prozess arbeitet auf dieser Datenbank" (#1530)
 * Zweck: Der Server und der CLI-Restore (scripts/restore-backup.js) halten fuer
 *        ihre ganze Laufzeit eine Sperre auf `<DB_PATH>.lock`. Der CLI-Restore
 *        verweigert, solange ein Server sie haelt; ein Server, der waehrend eines
 *        CLI-Restores startet, wartet, bis der fertig ist.
 *
 * Warum keine PID-Datei: in Docker ist jeder Server PID 1, und `docker compose
 * run` startet einen eigenen Container mit eigenem PID-Namensraum und Hostnamen.
 * Ob der Prozess hinter einer PID-Datei noch lebt, laesst sich von dort aus
 * nicht pruefen - nach einem Absturz haette die Datei entweder fuer immer
 * gesperrt oder nie. Diese Sperre haelt das Betriebssystem (fcntl bzw.
 * LockFileEx, ueber SQLite) und gibt sie beim Prozessende frei, auch nach
 * SIGKILL oder OOM. Es gibt nichts, was veralten kann.
 *
 * Die Sperre ist eine SQLite-Sperre auf einer eigenen, leeren Datei:
 * `locking_mode = EXCLUSIVE` plus eine leere EXCLUSIVE-Transaktion halten den
 * Lock, bis die Verbindung schliesst. Sie braucht dieselben Byte-Range-Locks,
 * die SQLite fuer die Datenbank selbst (WAL, `-shm`) ohnehin braucht - eine neue
 * Annahme ueber das Dateisystem fuehrt sie nicht ein. Wo das Dateisystem keine
 * Locks kann oder einen anderen Fehler meldet als "belegt", wird nie blockiert:
 * Warnung, und alles laeuft wie vor #1530.
 *
 * Pro Prozess gibt es genau EINE Verbindung auf die Sperrdatei: eine zweite im
 * selben Prozess bekaeme SQLITE_BUSY (gemessen). Deshalb ist `held` modulweit,
 * und der Restore aus der Einstellungsseite, der `init()` erneut durchlaeuft,
 * sperrt sich nicht selbst aus.
 */

import Database from 'better-sqlite3-multiple-ciphers';

export const INSTANCE_LOCKED = 'YUVOMI_INSTANCE_LOCKED';

/** Wie lange der Server je Versuch wartet, bevor er erneut ins Log schreibt. */
const WAIT_LOG_INTERVAL_MS = 30_000;

/** @type {{ path: string, release: () => void } | null} */
let held = null;

export function instanceLockPath(dbPath) {
  return `${dbPath}.lock`;
}

function isBusy(err) {
  return err?.code === 'SQLITE_BUSY' || err?.code === 'SQLITE_LOCKED';
}

/**
 * Ein Versuch. `timeoutMs` ist der busy_timeout von SQLite: so lange wartet der
 * Versuch auf einen anderen Halter, synchron.
 * @returns {{ path: string, release: () => void }} oder wirft (BUSY oder anderer Fehler).
 */
function tryAcquire(lockPath, timeoutMs) {
  const conn = new Database(lockPath, { timeout: timeoutMs });
  try {
    conn.pragma('locking_mode = EXCLUSIVE');
    // Journal im Speicher: sonst bleibt `<DB_PATH>.lock-journal` liegen
    // (gemessen, auch mit journal_mode = OFF). Die Datei traegt keine Daten.
    conn.pragma('journal_mode = MEMORY');
    // Ein Schreibzugriff in der Transaktion: auf einer Datei ohne Schreibrecht
    // (etwa von root angelegt) oeffnet SQLite still nur lesend, und eine leere
    // Transaktion haelt dann KEINE Sperre (gemessen). So wird daraus
    // SQLITE_READONLY - kein BUSY, also Warnung statt Warten.
    conn.exec('BEGIN EXCLUSIVE; PRAGMA user_version = 1; COMMIT;');
  } catch (err) {
    try { conn.close(); } catch { /* schon zu */ }
    throw err;
  }
  held = {
    path: lockPath,
    release: () => {
      try { conn.close(); } catch { /* schon zu */ }
      held = null;
    },
  };
  return held;
}

/**
 * Die Instanzsperre nehmen.
 *
 * @param {string} dbPath
 * @param {object} options
 * @param {'wait'|'refuse'} options.onBusy  Server: warten; CLI-Restore: abbrechen.
 * @param {{ info: Function, warn: Function }} options.log
 * @param {number} [options.waitLogIntervalMs] nur fuer Tests.
 * @returns {{ path: string, release: () => void } | null} null, wenn das
 *   Dateisystem keine Sperre zulaesst - dann geht es ohne weiter.
 * @throws {Error} code INSTANCE_LOCKED bei `onBusy: 'refuse'` und fremdem Halter.
 */
export function acquireInstanceLock(dbPath, { onBusy, log, waitLogIntervalMs = WAIT_LOG_INTERVAL_MS }) {
  if (held) return held;
  const lockPath = instanceLockPath(dbPath);
  try {
    return tryAcquire(lockPath, 0);
  } catch (err) {
    if (!isBusy(err)) return lockUnavailable(lockPath, err, log);
  }

  if (onBusy === 'refuse') {
    const locked = new Error(
      `A Yuvomi server is using ${dbPath} (it holds ${lockPath}). Stop Yuvomi first, `
      + 'or restore from Settings -> Administration -> Backup and restore.'
    );
    locked.code = INSTANCE_LOCKED;
    throw locked;
  }

  // Server: ein CLI-Restore (oder ein zweiter Server) haelt die Datei. Warten
  // statt abbrechen - ein Abbruch liefe unter einer Restart-Policy in eine
  // Schleife und endete ohne Policy in einem gestoppten Dienst.
  const startedAt = Date.now();
  for (;;) {
    log.warn(
      `Waiting for ${lockPath}: another Yuvomi process is using ${dbPath} - usually a restore `
      + `from the command line. Yuvomi starts as soon as it has finished `
      + `(waiting ${Math.round((Date.now() - startedAt) / 1000)} s so far).`
    );
    try {
      const lock = tryAcquire(lockPath, waitLogIntervalMs);
      log.info(`${lockPath} is free again - starting.`);
      return lock;
    } catch (err) {
      if (!isBusy(err)) return lockUnavailable(lockPath, err, log);
    }
  }
}

function lockUnavailable(lockPath, err, log) {
  log.warn(
    `Could not lock ${lockPath} (${err?.code || err?.message || err}). Yuvomi runs without it, `
    + 'so a restore from the command line cannot tell whether Yuvomi is running - stop Yuvomi '
    + 'before one.'
  );
  return null;
}
