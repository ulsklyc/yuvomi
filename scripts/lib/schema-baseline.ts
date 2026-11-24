/**
 * Modul: Schema-Baseline erzeugen und vergleichen
 * Zweck: Aus einer von Null migrierten Datenbank das SQL der Baseline schreiben
 *        (dumpBaseline) und den Inhalt zweier Datenbanken vergleichbar machen
 *        (tableRows). Benutzt von scripts/build-schema-baseline.ts und
 *        test/test-schema-baseline.js; braucht nur `prepare` und `exec` und
 *        laeuft damit auf dem Cipher-Treiber und auf node:sqlite.
 *
 * Aufbau der Baseline (ein SQL-Skript fuer eine leere Datenbank, ohne
 * BEGIN/COMMIT und ohne Pragma; die Transaktion gehoert dem Aufrufer, siehe
 * server/db/baseline.ts):
 *   1. Tabellen und Indizes in der Folge ihrer Entstehung (rowid in
 *      sqlite_master). Schattentabellen einer virtuellen Tabelle,
 *      sqlite_sequence und Auto-Indizes legt SQLite selbst an.
 *   2. Die Zeilen, die die Migrationen hinterlassen (Vorgabezeilen), mit rowid.
 *      Tabellen in Abhaengigkeitsfolge (Eltern vor Kindern), damit das Skript
 *      auch Anweisung fuer Anweisung mit eingeschalteten Fremdschluesseln laeuft.
 *   3. sqlite_sequence, Zeile fuer Zeile wie nach dem Replay.
 *   4. Trigger in der Folge ihrer Entstehung - nach den Zeilen, damit sie nicht
 *      auf diese feuern, und in derselben Folge, weil sie die Feuerreihenfolge
 *      bestimmt.
 *   5. schema_migrations 1 bis N (applied_at setzt die Spaltenvorgabe).
 *
 * Zeitstempel: Vorgabezeilen tragen `created_at`/`updated_at` aus einer
 * Spaltenvorgabe mit 'now', also die Zeit des Replays. Die Baseline schreibt
 * dort den Vorgabe-Ausdruck selbst statt eines Literals, damit eine
 * Neuinstallation ihre eigene Zeit bekommt. Jede andere Zelle, die wie ein
 * Zeitpunkt aus dem Replay aussieht, laesst den Erzeuger abbrechen: dann hat
 * eine Migration eine Zeit geschrieben, die keine Spaltenvorgabe ist, und wie
 * die Baseline sie wiedergibt, muss ein Mensch entscheiden.
 * Abhängigkeiten: ../../server/db/baseline.ts, ../../server/db/migrate.ts,
 *                 ../../server/migrations/index.ts, ../../server/utils/sqlite-driver.js
 */

import Database from '../../server/utils/sqlite-driver.js';
import { migrate } from '../../server/db/migrate.ts';
import { MIGRATIONS } from '../../server/migrations/index.ts';
import { applyBaseline, schemaFingerprint, schemaObjects } from '../../server/db/baseline.ts';
import type { Baseline, BaselineDatabase } from '../../server/db/baseline.ts';

/** Zeitfenster eines Replays in Millisekunden seit 1970 (Date.now() davor und danach). */
export type ReplayWindow = { from: number; to: number };

type Column = { name: string; type: string; dflt_value: string | null; pk: number; hidden: number };
type TableInfo = { name: string; type: string; wr: number };

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const text = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Tabellen der Datenbank ohne Schattentabellen, in Entstehungsfolge. */
function dataTables(database: BaselineDatabase): { tables: TableInfo[]; shadow: Set<string> } {
  const list = database
    .prepare("SELECT name, type, wr FROM pragma_table_list WHERE schema = 'main'")
    .all() as TableInfo[];
  const shadow = new Set(list.filter((t) => t.type === 'shadow').map((t) => t.name));
  const byName = new Map(list.map((t) => [t.name, t]));
  const tables = schemaObjects(database).objects
    .filter((o) => o.type === 'table' && !shadow.has(o.name))
    .map((o) => byName.get(o.name) as TableInfo);
  return { tables, shadow };
}

function columnsOf(database: BaselineDatabase, table: string): Column[] {
  return (database.prepare(`SELECT name, type, dflt_value, pk, hidden FROM pragma_table_xinfo(${text(table)})`).all() as Column[])
    .filter((c) => c.hidden === 0);
}

/**
 * Ist die rowid einer Tabelle ein eigener Wert (kein Alias einer Spalte)? Nur
 * dann schreibt und vergleicht man sie eigens. WITHOUT-ROWID-Tabellen haben
 * keine; bei genau einer Primaerschluesselspalte vom Typ INTEGER ist sie deren
 * Alias.
 */
function hasOwnRowid(table: TableInfo, columns: Column[]): boolean {
  if (table.type !== 'table' || table.wr === 1) return false;
  const pk = columns.filter((c) => c.pk > 0);
  return !(pk.length === 1 && /^integer$/i.test(pk[0].type));
}

/**
 * Liegt dieser Text als Zeitpunkt im Fenster des Replays? Erkannt werden die
 * Formen, die SQLite fuer 'now' schreibt: `YYYY-MM-DD HH:MM:SS`,
 * `YYYY-MM-DDTHH:MM:SS` mit oder ohne Bruchteil und `Z`, und das blosse Datum
 * (dann zaehlt der Tag des Fensters, UTC und Ortszeit).
 */
export function isReplayTime(value: unknown, window: ReplayWindow): boolean {
  if (typeof value !== 'string') return false;
  const full = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?Z?$/.exec(value);
  if (full) {
    const at = Date.parse(`${full[1]}T${full[2]}Z`);
    // Sekundengenau gegen ein Fenster in Millisekunden: eine Sekunde Rand.
    if (at >= window.from - 1000 && at <= window.to + 1000) return true;
    // Dieselbe Wanduhr als Ortszeit (datetime('now','localtime')).
    const local = new Date(`${full[1]}T${full[2]}`).getTime();
    return local >= window.from - 1000 && local <= window.to + 1000;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // date('now') ist der UTC-Tag, date('now','localtime') der Ortstag; beide zaehlen.
    const key = (y: number, m: number, d: number): string => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const days = new Set<string>();
    for (const t of [window.from, window.to]) {
      const d = new Date(t);
      days.add(key(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      days.add(key(d.getFullYear(), d.getMonth(), d.getDate()));
    }
    return days.has(value);
  }
  return false;
}

const hasNowDefault = (column: Column): boolean => /'now'/i.test(column.dflt_value ?? '');

/**
 * Tabellen so ordnen, dass jede nach den Tabellen steht, auf die ihre
 * Fremdschluessel zeigen; unter Gleichrangigen bleibt die gegebene Folge.
 * Ein Verweis auf die eigene Tabelle zaehlt nicht (dort traegt die rowid-Folge
 * der Zeilen). Ein Kreis zwischen Tabellen mit Zeilen laesst sich so nicht
 * schreiben und wirft.
 */
function parentsFirst(database: BaselineDatabase, tables: TableInfo[]): TableInfo[] {
  const names = new Set(tables.map((t) => t.name));
  const waitingFor = new Map(tables.map((t) => [
    t.name,
    new Set((database.prepare(`SELECT "table" AS parent FROM pragma_foreign_key_list(${text(t.name)})`).all() as { parent: string }[])
      .map((row) => row.parent)
      .filter((parent) => parent !== t.name && names.has(parent))),
  ]));
  const ordered: TableInfo[] = [];
  let rest = tables;
  while (rest.length > 0) {
    const ready = rest.filter((t) => [...(waitingFor.get(t.name) as Set<string>)].every((parent) => ordered.some((o) => o.name === parent)));
    if (ready.length === 0) {
      throw new Error(`Foreign keys between ${rest.map((t) => t.name).join(', ')} form a cycle; the baseline cannot order their rows.`);
    }
    ordered.push(...ready);
    rest = rest.filter((t) => !ready.includes(t));
  }
  return ordered;
}

/**
 * Das SQL der Baseline fuer eine von Null migrierte Datenbank auf Stand
 * `version`. Wirft, wenn sich der Stand nicht verlustfrei als Skript schreiben
 * laesst (virtuelle Tabelle mit Zeilen, Zeitpunkt des Replays ausserhalb einer
 * Spaltenvorgabe).
 */
export function dumpBaseline(database: BaselineDatabase, version: number, window: ReplayWindow): string {
  const { objects, triggers } = schemaObjects(database);
  const { tables, shadow } = dataTables(database);
  const out: string[] = [
    `-- Yuvomi schema baseline: schema and default rows of migrations 1 to ${version}.`,
    '-- GENERATED by scripts/build-schema-baseline.ts - do not edit, and do not treat as a',
    '-- migration: it is rebuilt from the migrations and re-cut only with a foundation',
    '-- release. For an empty database; server/db/baseline.ts runs it in one transaction.',
    '',
  ];

  for (const object of objects) {
    if (object.sql === null || shadow.has(object.name) || object.name === 'sqlite_sequence') continue;
    out.push(`${object.sql};`);
  }
  out.push('');

  const filled = tables.filter((table) => {
    if (table.name === 'schema_migrations' || table.name === 'sqlite_sequence') return false;
    const count = (database.prepare(`SELECT count(*) AS n FROM ${ident(table.name)}`).get() as { n: number }).n;
    if (count > 0 && table.type !== 'table') {
      throw new Error(`${table.name} is a ${table.type} table with ${count} row(s); the baseline cannot write those.`);
    }
    return count > 0;
  });
  for (const table of parentsFirst(database, filled)) {
    const columns = columnsOf(database, table.name);
    const ownRowid = hasOwnRowid(table, columns);
    const select = [
      ...(ownRowid ? ['rowid AS "r"'] : []),
      ...columns.flatMap((c, i) => [`${ident(c.name)} AS "v${i}"`, `quote(${ident(c.name)}) AS "q${i}"`]),
    ].join(', ');
    const order = table.wr === 1 ? columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => ident(c.name)).join(', ') : 'rowid';
    const names = [...(ownRowid ? ['rowid'] : []), ...columns.map((c) => ident(c.name))].join(', ');
    for (const row of database.prepare(`SELECT ${select} FROM ${ident(table.name)} ORDER BY ${order}`).all() as Record<string, unknown>[]) {
      const values = columns.map((column, i) => {
        if (!isReplayTime(row[`v${i}`], window)) return String(row[`q${i}`]);
        if (!hasNowDefault(column)) {
          throw new Error(
            `${table.name}.${column.name} holds ${JSON.stringify(row[`v${i}`])}, a time from this replay, `
            + 'but the column has no \'now\' default. Decide how the baseline writes it.'
          );
        }
        return `(${column.dflt_value})`;
      });
      out.push(`INSERT INTO ${ident(table.name)} (${names}) VALUES (${[...(ownRowid ? [String(row.r)] : []), ...values].join(', ')});`);
    }
  }
  out.push('');

  // sqlite_sequence entsteht mit der ersten AUTOINCREMENT-Tabelle; ihre Zeilen
  // (auch die mit seq 0, die ein Tabellenumbau hinterlaesst) genau wie nach dem Replay.
  if (objects.some((o) => o.name === 'sqlite_sequence')) {
    out.push('DELETE FROM sqlite_sequence;');
    for (const row of database.prepare('SELECT rowid AS r, quote(name) AS name, seq FROM sqlite_sequence ORDER BY rowid').all() as { r: number; name: string; seq: number }[]) {
      out.push(`INSERT INTO sqlite_sequence (rowid, name, seq) VALUES (${row.r}, ${row.name}, ${row.seq});`);
    }
    out.push('');
  }

  for (const trigger of triggers) out.push(`${trigger.sql};`);
  out.push('');

  const applied = database
    .prepare('SELECT version, quote(description) AS description FROM schema_migrations ORDER BY version')
    .all() as { version: number; description: string }[];
  if (applied.length === 0 || applied[applied.length - 1].version !== version) {
    throw new Error(`The database is not at migration ${version}.`);
  }
  for (const row of applied) {
    out.push(`INSERT INTO schema_migrations (version, description) VALUES (${row.version}, ${row.description});`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * Der Inhalt aller Tabellen in vergleichbarer Form: Tabelle -> Zeilen in
 * Schluesselfolge, mit rowid, wo sie ein eigener Wert ist. Zwei Dinge sind
 * herausgenommen, weil sie zwischen zwei Laeufen nie gleich sind:
 * `schema_migrations.applied_at`, und Zellen einer Spalte mit 'now'-Vorgabe,
 * deren Wert im Fenster des Laufs liegt (als '<now>').
 * Schattentabellen fehlen: ihr Inhalt ist die innere Ablage des FTS5-Index und
 * haengt von der Schreibfolge ab; die virtuelle Tabelle selbst steht mit drin.
 */
export function tableRows(database: BaselineDatabase, window: ReplayWindow): Record<string, unknown[]> {
  const { tables } = dataTables(database);
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    const columns = columnsOf(database, table.name).filter((c) => !(table.name === 'schema_migrations' && c.name === 'applied_at'));
    const ownRowid = table.type === 'virtual' || hasOwnRowid(table, columns);
    const select = [...(ownRowid ? ['rowid AS "(rowid)"'] : []), ...columns.map((c) => ident(c.name))].join(', ');
    const order = table.wr === 1 ? columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => ident(c.name)).join(', ') : 'rowid';
    const now = new Set(columns.filter(hasNowDefault).map((c) => c.name));
    result[table.name] = (database.prepare(`SELECT ${select} FROM ${ident(table.name)} ORDER BY ${order}`).all() as Record<string, unknown>[])
      .map((row) => {
        const plain: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          plain[key] = now.has(key) && isReplayTime(value, window) ? '<now>'
            : value instanceof Uint8Array ? `blob:${Buffer.from(value).toString('hex')}` : value;
        }
        return plain;
      });
  }
  return result;
}

/** Die hoechste Version der ausgelieferten Migrationen. */
export function latestMigrationVersion(): number {
  return Math.max(...MIGRATIONS.map((m) => m.version));
}

/**
 * Die Baseline fuer Stand `version` erzeugen: die Migrationen 1 bis `version`
 * von Null auf dem Cipher-Treiber fahren (ohne Baseline) und den Stand als
 * Skript schreiben. Zweimal erzeugt ergibt zweimal dasselbe.
 */
export function buildBaseline(version: number): Baseline {
  const database = new Database(':memory:');
  try {
    database.pragma('foreign_keys = ON');
    const from = Date.now();
    migrate(database, MIGRATIONS.filter((m) => m.version <= version), null);
    const window = { from, to: Date.now() };
    const baseline = { version, schemaHash: schemaFingerprint(database), sql: dumpBaseline(database, version, window) };
    assertRunsOnEmptyDatabase(baseline);
    return baseline;
  } finally {
    database.close();
  }
}

/**
 * Der Erzeuger prueft, was er schreibt: das Skript laeuft auf einer leeren
 * Datenbank Anweisung fuer Anweisung mit eingeschalteten Fremdschluesseln durch
 * und ergibt den Fingerabdruck des Replays. Sonst entsteht keine Datei.
 */
function assertRunsOnEmptyDatabase(baseline: Baseline): void {
  const database = new Database(':memory:');
  try {
    database.pragma('foreign_keys = ON');
    applyBaseline(database, baseline);
  } finally {
    database.close();
  }
}

/** baseline.json, wie der Erzeuger sie schreibt. */
export function baselineJson(baseline: Baseline): string {
  return `${JSON.stringify({ version: baseline.version, schemaHash: baseline.schemaHash }, null, 2)}\n`;
}
