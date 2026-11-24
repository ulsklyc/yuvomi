/**
 * Modul: Schema-Baseline (schema baseline)
 * Zweck: Eine frische Datenbank bekommt Schema und Vorgabezeilen der Migrationen
 *        1 bis N aus server/migrations/baseline.sql in EINER Transaktion, statt N
 *        Migrationen einzeln zu fahren; danach laufen nur die Migrationen ueber N.
 *        Hier stehen der Fingerabdruck des Schemas, das Laden der Baseline und
 *        ihr Einspielen samt Pruefung. Wann sie greift, entscheidet migrate.ts.
 *
 * Die Baseline ist KEINE Migration und nicht append-only: sie wird aus den
 * Migrationen erzeugt (scripts/build-schema-baseline.ts) und nur mit einem
 * Fundament-Release neu geschnitten. test:schema-baseline haelt, dass
 * "Baseline + Migrationen ueber N" dasselbe ergibt wie alle Migrationen von
 * Null, und dass die Datei dem Erzeuger entspricht.
 *
 * baseline.sql ist ein schlichtes Skript fuer eine LEERE Datenbank: kein BEGIN,
 * kein COMMIT, kein Pragma. Die Vorgabezeilen stehen so, dass jede Zeile ihre
 * Elternzeile schon vorfindet, es laeuft also auch Anweisung fuer Anweisung mit
 * eingeschalteten Fremdschluesseln. Alle Funktionen hier brauchen nur `prepare`
 * und `exec` und laufen damit auf dem Cipher-Treiber und auf node:sqlite.
 * Abhängigkeiten: node:crypto, node:fs
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Was Fingerabdruck und Einspielen von einer Verbindung brauchen. */
export type BaselineDatabase = {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  exec(sql: string): unknown;
};

/** Die ausgelieferte Baseline: Stand `version`, Fingerabdruck und das SQL. */
export type Baseline = { version: number; schemaHash: string; sql: string };

/** Eine Zeile aus sqlite_master. */
export type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };

/**
 * Alle Objekte aus sqlite_master in der Reihenfolge ihrer Entstehung, Trigger
 * getrennt.
 *
 * Die Reihenfolge ist Teil des Schemas, nicht Beiwerk: mehrere Trigger auf
 * derselben Tabelle feuern in umgekehrter Reihenfolge ihrer Entstehung, und
 * SQLite liest diese beim Oeffnen aus der rowid-Folge von sqlite_master. Eine
 * Baseline, die dieselben Trigger in anderer Folge anlegt, verhielte sich
 * anders. Trigger stehen getrennt, weil die Baseline sie erst nach den
 * Vorgabezeilen anlegt (sonst feuerten sie auf diese).
 */
export function schemaObjects(database: BaselineDatabase): { objects: SchemaObject[]; triggers: SchemaObject[] } {
  const all = database
    .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid')
    .all()
    .map((row) => {
      const { type, name, tbl_name, sql } = row as SchemaObject;
      return { type, name, tbl_name, sql };
    });
  return {
    objects: all.filter((o) => o.type !== 'trigger'),
    triggers: all.filter((o) => o.type === 'trigger'),
  };
}

/**
 * Fingerabdruck des Schemas: SHA-256 ueber Art, Name, Tabelle und SQL-Text aller
 * Objekte in Entstehungsfolge (Trigger als eigene Folge, siehe schemaObjects).
 */
export function schemaFingerprint(database: BaselineDatabase): string {
  const { objects, triggers } = schemaObjects(database);
  const flat = (list: SchemaObject[]) => list.map((o) => [o.type, o.name, o.tbl_name, o.sql]);
  return createHash('sha256').update(JSON.stringify([flat(objects), flat(triggers)])).digest('hex');
}

/** Traegt die Datenbank noch gar nichts? Nur dann darf die Baseline hinein. */
export function isPristine(database: BaselineDatabase): boolean {
  return (database.prepare('SELECT count(*) AS n FROM sqlite_master').get() as { n: number }).n === 0;
}

/**
 * Die Baseline in eine leere Datenbank einspielen und pruefen. Ein
 * Fingerabdruck, der nicht zu `schemaHash` passt, wirft. Die Transaktion gehoert
 * dem Aufrufer: migrate.ts rollt damit zurueck und die Datei bleibt leer; eine
 * Suite auf einer Wegwerf-Datenbank braucht keine.
 */
export function applyBaseline(database: BaselineDatabase, baseline: Baseline): void {
  database.exec(baseline.sql);
  const hash = schemaFingerprint(database);
  if (hash !== baseline.schemaHash) {
    throw new Error(
      `Schema baseline v${baseline.version} produced schema ${hash}, expected ${baseline.schemaHash}.`
    );
  }
}

const BASELINE_SQL = new URL('../migrations/baseline.sql', import.meta.url);
const BASELINE_JSON = new URL('../migrations/baseline.json', import.meta.url);

/**
 * Die ausgelieferte Baseline lesen. Gelesen wird erst hier, also nur beim Start
 * auf einer leeren Datei - eine bestehende Installation fasst die Dateien nie an.
 * Wirft, wenn sie fehlen oder nicht die erwartete Form haben; migrate.ts faehrt
 * dann alle Migrationen einzeln.
 */
export function loadBaseline(): Baseline {
  const meta = JSON.parse(readFileSync(BASELINE_JSON, 'utf8')) as { version?: unknown; schemaHash?: unknown };
  const sql = readFileSync(BASELINE_SQL, 'utf8');
  if (!Number.isInteger(meta.version) || typeof meta.schemaHash !== 'string' || sql.trim() === '') {
    throw new Error('server/migrations/baseline.json or baseline.sql is not a schema baseline.');
  }
  return { version: meta.version as number, schemaHash: meta.schemaHash, sql };
}
