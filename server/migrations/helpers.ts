// @ts-nocheck - eingefrorene Helfer der Migrationen: Typen nachziehen hiesse den Text aendern.

/**
 * Modul: Helfer der Migrationen
 * Zweck: Funktionen, die Migrationen im Code aufrufen, als eingefrorene Kopie.
 *        Wer sie aendert, aendert Migrationen, die Bestandsinstallationen schon
 *        ausgefuehrt haben - test:migrations-append-only vergleicht ihren
 *        Quelltext mit der Basis. Erlaubte Importe: node:, ../utils/, ../logger.js.
 */

import { createLogger } from '../logger.js';

export const log = createLogger('DB');

/**
 * SQL der Migration 284. Titel- und body-Ausdruecke stehen je Entitaet EINMAL
 * und dienen Trigger und Neuaufbau, damit beide nicht auseinanderlaufen.
 * Eine Funktionsdeklaration (samt Codetabelle darin), damit MIGRATIONS sie beim
 * Laden schon kennt: eine Konstante hier unten laege beim Aufruf noch in der TDZ.
 * @returns {string}
 */
export function searchIndexRowidMigrationSql() {
  // Feste Codes des Schluessels `rowid = (code << 40) + id`. Nie neu vergeben;
  // ein neues Modul nimmt den naechsten freien (9).
  const SEARCH_INDEX_CODES = Object.freeze({
    task: 1, event: 2, note: 3, contact: 4, item: 5, medication: 6, activity: 7, waste_type: 8,
  });
  const key = (/** @type {keyof typeof SEARCH_INDEX_CODES} */ entity, /** @type {string} */ id) =>
    `((${SEARCH_INDEX_CODES[entity]} << 40) + ${id})`;
  /** Termin-Feld nur am Master oder als ausdruecklich ueberschriebenes Feld (v194/239). */
  const eventField = (/** @type {string} */ r, /** @type {string} */ field) => `
            CASE WHEN ${r}.recurrence_parent_id IS NULL
                    OR EXISTS (SELECT 1 FROM json_each(
                         CASE WHEN json_valid(${r}.overridden_fields) THEN
                           CASE WHEN json_type(${r}.overridden_fields) = 'array' THEN ${r}.overridden_fields END
                         END) WHERE type = 'text' AND value = '${field}')
                 THEN COALESCE(${r}.${field}, '') ELSE '' END`;
  const eventCols = (/** @type {string} */ r) =>
    `${eventField(r, 'title')},
          TRIM(${eventField(r, 'description')}
            || ' ' ||${eventField(r, 'location')})`;
  /** Aufgabe samt Tags (v117), gelesen aus der Tabelle. */
  const taskSelect = (/** @type {string} */ where) => `
        SELECT ${key('task', 't.id')}, 'task', t.id, COALESCE(t.title, ''),
               TRIM(COALESCE(t.description, '') || ' ' ||
                    COALESCE((SELECT group_concat(tag, ' ') FROM task_tags WHERE task_id = t.id), ''))
        FROM tasks t${where}`;
  /** Einkaufsartikel samt Notizen und Tags (v117/151), gelesen aus der Tabelle. */
  const itemSelect = (/** @type {string} */ where) => `
        SELECT ${key('item', 'i.id')}, 'item', i.id, COALESCE(i.name, ''),
               TRIM(COALESCE(i.notes, '') || ' ' ||
                    COALESCE((SELECT group_concat(tag, ' ') FROM shopping_item_tags WHERE item_id = i.id), ''))
        FROM shopping_items i${where}`;
  /**
   * Einfache Entitaeten: Tabelle, Titel, body (Ausdruecke ueber Alias `r`).
   * @type {Array<{ entity: string, table: string, name: string, title: (r: string) => string, body: (r: string) => string }>}
   */
  const simple = [
    { entity: 'note', table: 'notes', name: 'notes', title: (r) => `COALESCE(${r}.title, '')`, body: (r) => `COALESCE(${r}.content, '')` },
    { entity: 'contact', table: 'contacts', name: 'contacts', title: (r) => `COALESCE(${r}.name, '')`, body: (r) => `COALESCE(${r}.phone, '') || ' ' || COALESCE(${r}.email, '')` },
    { entity: 'medication', table: 'medications', name: 'meds', title: (r) => `COALESCE(${r}.name, '')`, body: (r) => `COALESCE(${r}.dosage_text, '')` },
    { entity: 'activity', table: 'health_activities', name: 'activities', title: (r) => `COALESCE(${r}.type, '')`, body: (r) => `COALESCE(${r}.note, '')` },
    { entity: 'waste_type', table: 'waste_types', name: 'waste_types', title: (r) => `COALESCE(${r}.name, '')`, body: () => `''` },
  ];
  const cols = 'search_index (rowid, entity, entity_id, title, body)';

  const parts = [];
  // Aufgaben
  parts.push(`
      DROP TRIGGER IF EXISTS trg_search_tasks_ai;
      CREATE TRIGGER trg_search_tasks_ai AFTER INSERT ON tasks BEGIN
        INSERT OR REPLACE INTO ${cols}${taskSelect(' WHERE t.id = NEW.id')};
      END;
      DROP TRIGGER IF EXISTS trg_search_tasks_au;
      CREATE TRIGGER trg_search_tasks_au AFTER UPDATE ON tasks BEGIN
        DELETE FROM search_index WHERE rowid = ${key('task', 'OLD.id')};
        INSERT INTO ${cols}${taskSelect(' WHERE t.id = NEW.id')};
      END;
      DROP TRIGGER IF EXISTS trg_search_tasks_ad;
      CREATE TRIGGER trg_search_tasks_ad AFTER DELETE ON tasks BEGIN
        DELETE FROM search_index WHERE rowid = ${key('task', 'OLD.id')};
      END;
      DROP TRIGGER IF EXISTS trg_search_task_tags_ai;
      CREATE TRIGGER trg_search_task_tags_ai AFTER INSERT ON task_tags BEGIN
        DELETE FROM search_index WHERE rowid = ${key('task', 'NEW.task_id')};
        INSERT INTO ${cols}${taskSelect(' WHERE t.id = NEW.task_id')};
      END;
      DROP TRIGGER IF EXISTS trg_search_task_tags_ad;
      CREATE TRIGGER trg_search_task_tags_ad AFTER DELETE ON task_tags BEGIN
        DELETE FROM search_index WHERE rowid = ${key('task', 'OLD.task_id')};
        INSERT INTO ${cols}${taskSelect(' WHERE t.id = OLD.task_id')};
      END;`);
  // Termine
  parts.push(`
      DROP TRIGGER IF EXISTS trg_search_events_ai;
      CREATE TRIGGER trg_search_events_ai AFTER INSERT ON calendar_events BEGIN
        INSERT OR REPLACE INTO ${cols}
        VALUES (${key('event', 'NEW.id')}, 'event', NEW.id,${eventCols('NEW')});
      END;
      DROP TRIGGER IF EXISTS trg_search_events_au;
      CREATE TRIGGER trg_search_events_au
        AFTER UPDATE OF title, description, location, recurrence_parent_id, overridden_fields
        ON calendar_events BEGIN
        DELETE FROM search_index WHERE rowid = ${key('event', 'OLD.id')};
        INSERT INTO ${cols}
        VALUES (${key('event', 'NEW.id')}, 'event', NEW.id,${eventCols('NEW')});
      END;
      DROP TRIGGER IF EXISTS trg_search_events_ad;
      CREATE TRIGGER trg_search_events_ad AFTER DELETE ON calendar_events BEGIN
        DELETE FROM search_index WHERE rowid = ${key('event', 'OLD.id')};
      END;`);
  // Einkaufsartikel (ai loescht vorher, v151)
  parts.push(`
      DROP TRIGGER IF EXISTS trg_search_items_ai;
      CREATE TRIGGER trg_search_items_ai AFTER INSERT ON shopping_items BEGIN
        DELETE FROM search_index WHERE rowid = ${key('item', 'NEW.id')};
        INSERT INTO ${cols}${itemSelect(' WHERE i.id = NEW.id')};
      END;
      DROP TRIGGER IF EXISTS trg_search_items_au;
      CREATE TRIGGER trg_search_items_au AFTER UPDATE ON shopping_items BEGIN
        DELETE FROM search_index WHERE rowid = ${key('item', 'OLD.id')};
        INSERT INTO ${cols}${itemSelect(' WHERE i.id = NEW.id')};
      END;
      DROP TRIGGER IF EXISTS trg_search_items_ad;
      CREATE TRIGGER trg_search_items_ad AFTER DELETE ON shopping_items BEGIN
        DELETE FROM search_index WHERE rowid = ${key('item', 'OLD.id')};
      END;
      DROP TRIGGER IF EXISTS trg_search_item_tags_ai;
      CREATE TRIGGER trg_search_item_tags_ai AFTER INSERT ON shopping_item_tags BEGIN
        DELETE FROM search_index WHERE rowid = ${key('item', 'NEW.item_id')};
        INSERT INTO ${cols}${itemSelect(' WHERE i.id = NEW.item_id')};
      END;
      DROP TRIGGER IF EXISTS trg_search_item_tags_ad;
      CREATE TRIGGER trg_search_item_tags_ad AFTER DELETE ON shopping_item_tags BEGIN
        DELETE FROM search_index WHERE rowid = ${key('item', 'OLD.item_id')};
        INSERT INTO ${cols}${itemSelect(' WHERE i.id = OLD.item_id')};
      END;`);
  for (const s of simple) {
    const entity = /** @type {keyof typeof SEARCH_INDEX_CODES} */ (s.entity);
    parts.push(`
      DROP TRIGGER IF EXISTS trg_search_${s.name}_ai;
      CREATE TRIGGER trg_search_${s.name}_ai AFTER INSERT ON ${s.table} BEGIN
        INSERT OR REPLACE INTO ${cols}
        VALUES (${key(entity, 'NEW.id')}, '${s.entity}', NEW.id, ${s.title('NEW')}, ${s.body('NEW')});
      END;
      DROP TRIGGER IF EXISTS trg_search_${s.name}_au;
      CREATE TRIGGER trg_search_${s.name}_au AFTER UPDATE ON ${s.table} BEGIN
        DELETE FROM search_index WHERE rowid = ${key(entity, 'OLD.id')};
        INSERT INTO ${cols}
        VALUES (${key(entity, 'NEW.id')}, '${s.entity}', NEW.id, ${s.title('NEW')}, ${s.body('NEW')});
      END;
      DROP TRIGGER IF EXISTS trg_search_${s.name}_ad;
      CREATE TRIGGER trg_search_${s.name}_ad AFTER DELETE ON ${s.table} BEGIN
        DELETE FROM search_index WHERE rowid = ${key(entity, 'OLD.id')};
      END;`);
  }
  // Neuaufbau mit den neuen Schluesseln, dieselben Ausdruecke wie oben.
  parts.push(`
      DELETE FROM search_index;
      INSERT INTO ${cols}${taskSelect('')};
      INSERT INTO ${cols}
        SELECT ${key('event', 'e.id')}, 'event', e.id,${eventCols('e')}
        FROM calendar_events e;
      INSERT INTO ${cols}${itemSelect('')};`);
  for (const s of simple) {
    const entity = /** @type {keyof typeof SEARCH_INDEX_CODES} */ (s.entity);
    parts.push(`
      INSERT INTO ${cols}
        SELECT ${key(entity, 'r.id')}, '${s.entity}', r.id, ${s.title('r')}, ${s.body('r')} FROM ${s.table} r;`);
  }
  return parts.join('\n') + '\n';
}

/**
 * Der Nachtrag aus Migration 259 (#1911): wartende Umzuege beginnen ihre
 * Frist jetzt.
 */
export function backfillShoppingMoveSince(database) {
  database.exec(`
    UPDATE shopping_items SET outbound_move_since = datetime('now')
     WHERE outbound_move = 1 AND outbound_move_since IS NULL
  `);
}

/**
 * Der Nachtrag zu Migration 246 (#1935): lokale Zeilen sind hier verfasst.
 *
 * Eine eigene Funktion, weil ZWEI Wege ihn brauchen - die Migration und
 * `reconcileCriticalSchema()`. Legt die Selbstheilung die Spalte auf einer
 * gedrifteten Datenbank neu an (Migration vermerkt, Spalte fehlt), stuende
 * sonst jede Zeile auf 0, und die hier angelegten Serien gingen danach wie
 * eingelesene hinaus.
 *
 * Die Trigger von calendar_events ruhen dabei (Begruendung an Migration 246)
 * und werden mit ihrem gespeicherten Wortlaut wieder angelegt. Die Aufrufer
 * sorgen fuer die Transaktion.
 */
export function backfillSeriesAuthored(database) {
  const triggers = database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = 'calendar_events' AND sql IS NOT NULL
    ORDER BY rowid
  `).all();
  for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`);
  database.exec("UPDATE calendar_events SET series_authored = 1 WHERE external_source = 'local'");
  for (const trigger of triggers) database.exec(trigger.sql);
}
