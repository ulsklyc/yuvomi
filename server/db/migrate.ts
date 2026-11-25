/**
 * Modul: Migrations-Engine (migration runner)
 * Zweck: Ausstehende Migrationen anwenden (`migrate()`, mit Neuversuch an der
 *        Schreibsperre, #1331), Migrationen einer neueren Version erkennen und
 *        die Selbstheilung gegen additive Schema-Drift (#538). Alle Funktionen
 *        bekommen die Verbindung als Parameter; die Vorgabe "die offene
 *        Verbindung" setzt server/db.js, das sie re-exportiert.
 * Abhängigkeiten: ../migrations/index.ts, ../migrations/helpers.ts, ./baseline.ts, ../logger.js
 */

import { createLogger } from '../logger.js';
import { MIGRATIONS as MIGRATION_FILES } from '../migrations/index.ts';
import { backfillShoppingMoveSince, backfillSeriesAuthored } from '../migrations/helpers.ts';
import { applyBaseline, isPristine, loadBaseline } from './baseline.ts';
import type { Baseline } from './baseline.ts';
import type { SqliteDatabase } from './handle.ts';
import { withTx } from './tx.ts';
import type { TxDatabase } from './tx.ts';

const log = createLogger('DB');

/** Was die Selbstheilung braucht; Suiten fahren sie auch auf node:sqlite. */
type ReconcileDatabase = Pick<SqliteDatabase, 'prepare' | 'exec'> & TxDatabase;

// --------------------------------------------------------
// Migrations-Engine
// --------------------------------------------------------
//
// Die Migrationen selbst liegen in server/migrations/ (eine Datei je Version,
// Reihenfolge in index.ts, Helfer in helpers.ts); append-only, siehe
// test:migrations-append-only.

/** Eine Migration, wie server/migrations/NNNN.ts sie exportiert. */
type Migration = {
  version: number;
  description: string;
  up: string | ((db: SqliteDatabase) => void);
  afterUp?: (db: SqliteDatabase) => void;
  foreignKeysOff?: boolean;
};

/** Alle Migrationen in aufsteigender Reihenfolge (server/migrations/index.ts). */
const MIGRATIONS: Migration[] = MIGRATION_FILES as Migration[];

/** Die Trigger aus Migration 251, derselbe Wortlaut; die Migration bleibt eingefroren. */
function createAvatarKeyTriggers(database: ReconcileDatabase): void {
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
function backfillAvatarKey(database: ReconcileDatabase): void {
  database.exec(`
    UPDATE users SET avatar_key = lower(hex(randomblob(16)))
      WHERE avatar_data IS NOT NULL AND avatar_data <> '' AND avatar_key IS NULL
  `);
  createAvatarKeyTriggers(database);
}

/** Der Nachtrag aus Migration 254, derselbe Wortlaut; die Migration bleibt eingefroren. */
function backfillBirthdayYearUnknown(database: ReconcileDatabase): void {
  database.exec(`
    UPDATE birthdays SET birth_date = '2000' || substr(birth_date, 5), year_unknown = 1
      WHERE substr(birth_date, 1, 5) = '1604-'
  `);
}

/** Der Nachtrag aus Migration 254 fuer Kontakte, derselbe Wortlaut. */
function backfillContactBirthdayYearUnknown(database: ReconcileDatabase): void {
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
function migrationAlreadyRecorded(database: SqliteDatabase, migration: Migration, err: unknown): boolean {
  // Ohne SQLite-Code kommt der Fehler nicht vom Treiber: die
  // Fremdschlüssel-Prüfung unten wirft selbst, ein Tippfehler in einem
  // up()/afterUp()-Hook wirft einen ReferenceError. Beides sind
  // Programmfehler und bleiben es.
  if (typeof (err as { code?: unknown } | null)?.code !== 'string' || !(err as { code: string }).code.startsWith('SQLITE_')) return false;

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
export const MIGRATION_BUSY_ATTEMPTS = 5;
const MIGRATION_BUSY_BACKOFF_MS = 25;

/** SQLITE_BUSY samt erweiterter Codes (SQLITE_BUSY_SNAPSHOT, SQLITE_BUSY_RECOVERY, ...). */
function isBusyError(err: unknown): boolean {
  return typeof (err as { code?: unknown } | null)?.code === 'string' && (err as { code: string }).code.startsWith('SQLITE_BUSY');
}

/**
 * Synchron warten. `migrate()` läuft synchron im Startpfad, bevor der Server
 * Requests annimmt - ein `await` gäbe es dort nicht, und blockieren ist hier
 * genau das Gewollte.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Eine leere Datenbank aus der Baseline fuellen (server/db/baseline.ts): Schema
 * und Vorgabezeilen der Migrationen 1 bis N in EINER Transaktion. Danach findet
 * `migrate()` diese Versionen verbucht vor und faehrt nur noch den Rest.
 *
 * Gibt die Version der Baseline zurueck, wenn DIESER Lauf sie eingespielt hat,
 * sonst `null` - und dann faehrt `migrate()` weiter wie ohne Baseline. Drei
 * Faelle enden so, keiner davon ist ein Abbruch:
 * - Die Datenbank traegt schon etwas. Dann ist sie keine Neuinstallation.
 * - Ein anderer Prozess war schneller (#1331): der eigene Versuch scheitert an
 *   dessen Tabellen oder an der Schreibsperre, ist zurueckgerollt, und die
 *   Datenbank ist danach nicht mehr leer. Entschieden wird wie bei den
 *   Migrationen am ZUSTAND, nicht am Fehlertext.
 * - Die Baseline laesst sich nicht lesen oder einspielen, oder ihr Schema traegt
 *   nicht den erwarteten Fingerabdruck. Die Transaktion ist zurueckgerollt, die
 *   Datei so leer wie zuvor, und alle Migrationen einzeln sind der Weg, der
 *   schon immer galt. Das steht als Fehler im Log, weil es auf ein
 *   beschaedigtes Paket zeigt; test:schema-baseline haelt, dass die
 *   ausgelieferte Baseline diesen Zweig nie nimmt.
 * Alles andere fliegt weiter: SQLITE_BUSY nach dem letzten Versuch, wie bei
 * einer Migration, und jeder Fehler, der nicht an der Baseline liegt (Platte
 * voll, nur lesbar, E/A, beschaedigte Datei) - dort waere "die Baseline ist
 * unbrauchbar" die falsche Spur, und die Migrationen scheiterten am selben.
 */
/**
 * Liegt dieser Fehler an der Baseline selbst? Dann ist der Ersatzweg richtig.
 * Ohne SQLite-Code kommt er aus dem eigenen Code (falscher Fingerabdruck); mit
 * SQLITE_ERROR (SQL, das nicht laeuft) oder SQLITE_CONSTRAINT* (eine Zeile, die
 * eine Regel verletzt) aus dem Skript. Jeder andere Code meldet die Umgebung.
 */
function isBaselineFault(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !code.startsWith('SQLITE_')) return true;
  return code === 'SQLITE_ERROR' || code.startsWith('SQLITE_CONSTRAINT');
}

function startFromBaseline(database: SqliteDatabase, load: () => Baseline): number | null {
  if (!isPristine(database)) return null;

  let baseline: Baseline;
  try {
    baseline = load();
  } catch (err) {
    log.error(`Schema baseline is not usable, running every migration instead: ${(err as Error)?.message}`);
    return null;
  }

  const run = database.transaction(() => applyBaseline(database, baseline));
  for (let attempt = 1; ; attempt++) {
    try {
      run();
      log.info(`Schema baseline applied: migrations 1 to ${baseline.version}`);
      return baseline.version;
    } catch (err) {
      let pristine: boolean;
      try {
        pristine = isPristine(database);
      } catch {
        // Die Datei laesst sich nicht einmal mehr lesen: der erste Fehler ist die Nachricht.
        throw err;
      }
      if (!pristine) {
        log.warn('The database was no longer empty when this run wanted to apply the schema baseline - another process was faster (#1331).');
        return null;
      }
      if (isBusyError(err)) {
        if (attempt >= MIGRATION_BUSY_ATTEMPTS) throw err;
        log.warn(
          `Schema-Baseline kam nicht an die Schreibsperre (${(err as { code: string }).code}), `
          + `Versuch ${attempt + 1} von ${MIGRATION_BUSY_ATTEMPTS} (#1331).`
        );
        sleepSync(MIGRATION_BUSY_BACKOFF_MS * attempt);
        continue;
      }
      if (!isBaselineFault(err)) throw err;
      log.error(`Schema baseline v${baseline.version} could not be applied, running every migration instead: ${(err as Error)?.message}`);
      return null;
    }
  }
}

/**
 * Führt alle ausstehenden Migrations in einer Transaktion aus.
 *
 * Die Parameter tragen im Betrieb ihren Vorgabewert; sie stehen da, damit ein
 * Test den Lauf gegen einen GESETZTEN Zustand fahren kann - eine eigene Datei
 * und eine eigene Migrationsliste - statt gegen ein Rennen zu hoffen. Die
 * Vorgabe fuer `database` (die offene Verbindung) setzt server/db.js.
 *
 * `baseline`: womit eine LEERE Datenbank beginnt. Vorgabe ist die ausgelieferte
 * Baseline, aber nur fuer die ausgelieferte Migrationsliste - eine eigene Liste
 * eines Tests hat mit ihr nichts zu tun. `null` faehrt immer alle Migrationen
 * von Null (so entsteht die Baseline selbst, und so prueft test:schema-baseline
 * sie).
 * @returns die Version der Baseline, wenn dieser Lauf mit ihr begonnen hat
 */
export function migrate(
  database: SqliteDatabase,
  migrations: Migration[] = MIGRATIONS,
  baseline: (() => Baseline) | null = migrations === MIGRATIONS ? loadBaseline : null,
): { baseline: number | null } {
  const startedFrom = baseline ? startFromBaseline(database, baseline) : null;

  // Migrations-Versions-Tabelle sicherstellen (außerhalb der Haupt-Transaktion)
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);

  const applied = new Set(
    database.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version)
  );

  const pending = migrations.filter((m) => !applied.has(m.version));

  if (pending.length === 0) return { baseline: startedFrom };

  const runMigration = database.transaction((migration: Migration) => {
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
      const violations = database.pragma('foreign_key_check') as unknown[];
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
  const applyPendingMigration = (migration: Migration): void => {
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
          `Migration ${migration.version} kam nicht an die Schreibsperre (${(err as { code: string }).code}), `
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
  return { baseline: startedFrom };
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
 * @returns aufsteigend, leer wenn alles bekannt ist
 */
export function unknownMigrationVersions(database: Pick<SqliteDatabase, 'prepare'>): number[] {
  const known = new Set(MIGRATIONS.map((m) => m.version));
  return database
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => (row as { version: number }).version)
    .filter((version) => !known.has(version));
}

export function latestKnownVersion(): number {
  return Math.max(0, ...MIGRATIONS.map((m) => m.version));
}

/** Notfallschalter: nur ein ausdrückliches 1/true/yes zählt, ein leerer Wert nicht. */
export function allowNewerSchema(): boolean {
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
const CRITICAL_COLUMNS: { table: string; column: string; type: string; backfill?: (database: ReconcileDatabase) => void }[] = [
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
 * Sicherheitsnetz für additive Drift. Die Vorgabe fuer `database` (die offene
 * Verbindung) setzt server/db.js.
 */
export function reconcileCriticalSchema(database: ReconcileDatabase | null | undefined): void {
  if (!database) return;
  for (const { table, column, type, backfill } of CRITICAL_COLUMNS) {
    let columns: { name: string }[];
    try {
      columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    } catch {
      continue; // Tabelle nicht lesbar - keine additive Reparatur möglich.
    }
    if (!columns.length) continue;                          // Tabelle existiert nicht
    if (columns.some((c) => c.name === column)) continue;   // Spalte bereits vorhanden
    try {
      if (backfill) {
        // Spalte und Nachtrag zusammen oder gar nicht: eine Spalte ohne ihren
        // Nachtrag gaelte beim naechsten Start als vorhanden, und der Nachtrag
        // liefe nie mehr. withTx, weil es unter better-sqlite3 und node:sqlite
        // gleich geht und auch in einer offenen Transaktion (dort als SAVEPOINT).
        withTx(database, () => {
          database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
          backfill(database);
        });
      } else {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
      log.warn(`Schema-Drift behoben: ${table}.${column} fehlte trotz vermerkter Migration und wurde nachgetragen (#538).`);
    } catch (err) {
      log.error(`Schema-Reconciliation ${table}.${column} fehlgeschlagen:`, (err as { message?: string } | null)?.message || err);
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
function reconcileAvatarKeyTriggers(database: ReconcileDatabase): void {
  try {
    const columns = database.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'avatar_key')) return;
    const present = (database.prepare(`
      SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'trigger' AND name IN ('trg_users_avatar_key_update', 'trg_users_avatar_key_insert')
    `).get() as { n: number }).n;
    if (present === 2) return;
    // JEDER SCHLUESSEL NEU, nicht nur die fehlenden: ohne die Trigger kann ein
    // Bild unter dem alten Schluessel ersetzt worden sein, und dessen
    // `immutable`-Adresse zeigte aus dem Cache weiter das alte Bild.
    withTx(database, () => {
      createAvatarKeyTriggers(database);
      database.exec(`
        UPDATE users SET avatar_key = CASE
          WHEN avatar_data IS NULL OR avatar_data = '' THEN NULL
          ELSE lower(hex(randomblob(16))) END
      `);
    });
    log.warn('Schema-Drift behoben: Trigger fuer users.avatar_key fehlten, wurden neu angelegt und alle Schluessel neu gewuerfelt (#2056).');
  } catch (err) {
    log.error('Schema-Reconciliation der avatar_key-Trigger fehlgeschlagen:', (err as { message?: string } | null)?.message || err);
  }
}

/**
 * Aktuelle Schema-Version zurückgeben (`currentVersion()` in server/db.js
 * reicht die offene Verbindung herein).
 */
export function schemaVersion(database: SqliteDatabase | null): number {
  if (!database) return 0;
  try {
    const row = database.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}
