/**
 * Modul: Datenbank-Griff (DB handle)
 * Zweck: Der schmale Vertrag, ueber den server/db.js seine Verbindung, seine
 *        Schluesselwerkzeuge und den Zustand von Backup und Restore an
 *        backup.ts und restore.ts leiht. Nur Typen: das Objekt baut jede
 *        Instanz von server/db.js selbst, die Verbindung, DB_PATH und den
 *        Schluessel liest und setzt es ueber Zugriffsfunktionen auf deren
 *        eigene Variablen.
 *
 * Warum kein Modul mit eigenem Zustand: Suiten laden server/db.js mehrfach als
 * frische Instanz (`import('../server/db.js?swap=N')`, test-restore-swap.js und
 * fuenf weitere), jede mit eigenem DB_PATH und eigener Verbindung. Ein Modul,
 * das ohne Abfrageteil importiert wird, gibt es pro Prozess nur einmal; hielte
 * es Verbindung, laufende Backups oder den Restore-Riegel, teilten sich alle
 * Instanzen einen. Deshalb gehoert der Griff samt Zustand zur Instanz von
 * db.js, und backup.ts und restore.ts bekommen ihn als Parameter - keines von
 * beiden importiert db.js.
 * Abhängigkeiten: keine (nur Typen)
 */

/** Eine vorbereitete Anweisung des Treibers, so weit sie hier gebraucht wird. */
type SqliteStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
};

/**
 * Eine Verbindung aus better-sqlite3-multiple-ciphers (der Treiber hat keine
 * Typen), so weit sie hier gebraucht wird.
 */
export type SqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result;
  backup?: (destinationPath: string) => Promise<unknown>;
  close(): void;
};

/** Was eine Instanz von server/db.js an Backup und Restore leiht. */
export type DbHandle = {
  /** Die offene Verbindung oder `null`. */
  readonly db: SqliteDatabase | null;
  setDb(next: SqliteDatabase | null): void;
  /** DB_PATH; kann sich beim Start aendern (Legacy-Migration). */
  readonly dbPath: string;
  /** DB_ENCRYPTION_KEY, wie er beim Laden von db.js stand. */
  readonly dbKey: string | undefined;
  get(): SqliteDatabase;
  init(options?: { plaintextBackup?: boolean }): SqliteDatabase;
  applyEncryptionKey(database: SqliteDatabase): void;
  applyKeyBytes(database: SqliteDatabase, bytes: Buffer): void;
  assertReadable(database: SqliteDatabase): void;
  assertCipherSupport(): void;
  isPlaintextDatabase(filePath: string): boolean;
  regularFileSize(filePath: string): number | null;
  /** `code` des Fehlers einer leeren Datenbankdatei (#1282). */
  readonly emptyDatabaseFileCode: string;
  /** Handschlag des Restore-CLI, `Symbol.for('yuvomi.db.restoreTarget')`. */
  readonly restoreTargetHandshake: symbol;
  /**
   * Laufende `backupToFile()`-Aufrufe. Der Restore wartet vor dem Schliessen der
   * Verbindung, bis keiner mehr laeuft (Codex-Befund in #1431): seit die
   * Arbeitsdatei VOR dem Schliessen kopiert wird, kann waehrend dieses Kopierens
   * ein Backup (Download-Route, Zeitplan) auf der noch offenen Verbindung
   * beginnen - und `db.close()` zoege ihm die Verbindung unter den Haenden weg.
   */
  readonly activeBackups: Set<Promise<unknown>>;
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
  restoreRunning: boolean;
};
