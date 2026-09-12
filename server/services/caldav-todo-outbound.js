// --------------------------------------------------------
// Ausgehende Änderungen für CalDAV-VTODO (Issue #617).
//
// Der VTODO-Spiegel (caldav-reminders-sync.js) war einseitig: eine hier
// abgehakte, umbenannte oder gelöschte Aufgabe blieb auf dem Server stehen, und
// der nächste Inbound-Lauf machte die lokale Änderung wieder rückgängig. Diese
// Datei ist die Rückrichtung, nach demselben Muster wie die Termine (#593):
//
//   Löschen → Zeile in caldav_todo_pending_deletions (überlebt den Eintrag)
//   Ändern  → outbound_dirty auf der Zeile selbst
//
// Vorgemerkt wird synchron im Route-Handler, ausgeführt wird danach: der
// Server-Aufruf darf die HTTP-Antwort weder verzögern noch scheitern lassen. Was
// nicht durchgeht, bleibt vorgemerkt und läuft im nächsten Sync mit
// (at-least-once).
//
// Ein Umzug zwischen Listen fehlt weiterhin bewusst: eine Aufgabe gehört zu der
// Liste, aus der sie kam.
//
// Das Anlegen dagegen gibt es seit #695. Die alte Begründung ("ohne Zielwahl
// gäbe es keine Liste, in die es gehörte") stimmte nicht mehr: die Zielwahl gibt
// es seit v1.79.0 bei den Terminen (#620), und die Oberfläche versprach die
// Rückrichtung die ganze Zeit über in beide Richtungen. Eine in Yuvomi angelegte
// Aufgabe trägt jetzt ihr Ziel selbst (tasks.target_caldav_account_id +
// target_caldav_list_url, Migration 136) und wird beim nächsten Lauf hochgeladen:
//
//   Anlegen → Zielspalten auf der Zeile, external_source bleibt 'local'
//   Ändern  → outbound_dirty auf der Zeile selbst
//   Löschen → Zeile in caldav_todo_pending_deletions (überlebt den Eintrag)
//
// Nach erfolgreichem Upload ist die Zeile ein gewöhnlicher Spiegel und läuft ab
// da über dieselben Pfade wie eine vom Server geholte Aufgabe.
// --------------------------------------------------------

import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { outboundFailureAction } from './calendar-outbound.js';
import { patchICSTodo } from '../utils/ics-patch.js';
import { createCalDAVClient, collectionUrlOf } from '../utils/caldav-client.js';
import { householdTimeZone, localToUTC } from '../utils/timezone.js';
import { loadTags } from '../utils/task-tags.js';
import { runSerialized } from '../utils/sync-lock.js';

const log = createLogger('CalDAV-Todo-Outbound');

// --------------------------------------------------------
// Module
//
// Der Inbound spiegelt VTODO in zwei Ziele, also muss die Rückrichtung beide
// kennen. `table` wird in SQL interpoliert (SQLite erlaubt keine Bind-Parameter
// für Bezeichner) - die Modulnamen hier sind zugleich die Whitelist, ein
// unbekannter Name kommt nie bis zum Statement.
// --------------------------------------------------------

export const MODULES = {
  tasks: {
    table: 'tasks',
    // Felder, die zum Server gespiegelt werden. Alles andere (Kategorie,
    // Zuweisung, Punkte, Sichtbarkeit, Unteraufgaben) ist Yuvomi-intern und
    // kennt in VTODO keine Entsprechung, löst also keinen Push aus.
    //
    // `tags_key` ist kein Spaltenname: Tags liegen in task_tags, der
    // Feldvergleich sieht aber nur die Zeile. Der Aufrufer hängt den
    // kanonischen Schlüssel (utils/task-tags.js: tagsKey) an beide Seiten,
    // sonst bliebe eine reine Tag-Änderung unbemerkt (#586).
    mirrored: ['title', 'description', 'priority', 'status', 'due_date', 'due_time', 'tags_key'],
    icsFields: icsFieldsForTask,
    labelOf: (row) => row.title,
  },
  shopping: {
    table: 'shopping_items',
    mirrored: ['name', 'is_checked'],
    icsFields: icsFieldsForShoppingItem,
    labelOf: (row) => row.name,
  },
};

function moduleDef(module) {
  const def = MODULES[module];
  if (!def) throw new Error(`Unknown VTODO module "${module}".`);
  return def;
}

// --------------------------------------------------------
// Feld-Abbildung Yuvomi → VTODO
// --------------------------------------------------------

/** RFC-5545-Zeitstempel in UTC, wie ihn COMPLETED und DTSTAMP verlangen. */
function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Yuvomi-Priorität → RFC-5545-PRIORITY. Gegenstück zu mapVtodoPriority.
 *
 * Vier lokale Stufen treffen auf drei Bänder (1-4 hoch, 5 mittel, 6-9 niedrig),
 * deshalb teilen sich `urgent` und `high` das obere Band. Damit `urgent` den
 * Rückweg trotzdem übersteht, respektiert der Inbound eine lokale Verfeinerung
 * innerhalb desselben Bandes, statt sie zu überschreiben.
 */
export function priorityToVtodo(priority) {
  switch (priority) {
    case 'urgent': return '1';
    case 'high':   return '2';
    case 'medium': return '5';
    case 'low':    return '9';
    default:       return null; // 'none' → Property entfernen
  }
}

/**
 * DUE-Property aus Datum und Uhrzeit.
 *
 * Ohne Uhrzeit ein reines Datum (VALUE=DATE), sonst ein UTC-Zeitstempel. Eine
 * Aufgabe trägt keine TZID: `due_date`/`due_time` sind Wanduhr-Werte in der Zone
 * des Haushalts, also muss die Uhrzeit von dort nach UTC (Gegenstück zu
 * splitDue). Ein ungeprüft als UTC verschicktes „14:30" verschöbe die Aufgabe auf
 * dem Server um den Zonenoffset.
 */
export function dueField(date, time, tz = householdTimeZone(null)) {
  if (!date) return null; // Property entfernen
  const day = String(date).slice(0, 10);
  if (!time) return { value: day.replace(/-/g, ''), params: ';VALUE=DATE' };

  const utc = localToUTC(`${day}T${String(time).slice(0, 5)}:00`, tz);
  return { value: utc.replace(/[-:]/g, '').replace(/\.\d{3}/, ''), params: '' };
}

/**
 * Erledigt-Zustand als die drei Properties, an denen Clients ihn ablesen.
 * `hadCompleted` verhindert, dass eine Bearbeitung an einer längst erledigten
 * Aufgabe deren Erledigt-Zeitpunkt auf jetzt zurücksetzt.
 */
function completionFields(done, inProgress, hadCompleted) {
  if (!done) {
    return {
      STATUS:              inProgress ? 'IN-PROCESS' : 'NEEDS-ACTION',
      COMPLETED:           null,
      'PERCENT-COMPLETE':  null,
    };
  }
  const fields = { STATUS: 'COMPLETED', 'PERCENT-COMPLETE': '100' };
  if (!hadCompleted) fields.COMPLETED = utcStamp();
  return fields;
}

/**
 * VTODO-Properties einer lokalen Aufgabe.
 *
 * CATEGORIES wird nur aufgenommen, wenn die Tags wirklich geladen sind (#586).
 * Der Unterschied ist folgenreich: ein leeres Array heißt „keine Tags mehr" und
 * entfernt die Property auf dem Server, ein fehlendes Feld heißt „unbekannt"
 * und muss sie unberührt lassen. Wäre beides dasselbe, würde jeder Aufrufer,
 * der eine rohe Zeile aus `SELECT *` durchreicht, die Tags des Servers
 * stillschweigend löschen - `reloadRow` hängt sie deshalb an.
 */
export function icsFieldsForTask(task, hadCompleted = false, tz = householdTimeZone(null)) {
  const fields = {
    SUMMARY:     task.title,
    DESCRIPTION: task.description || null,
    DUE:         dueField(task.due_date, task.due_time, tz),
    PRIORITY:    priorityToVtodo(task.priority),
    ...completionFields(task.status === 'done', task.status === 'in_progress', hadCompleted),
  };
  if (Array.isArray(task.tags)) fields.CATEGORIES = task.tags;
  return fields;
}

/** VTODO-Properties eines lokalen Einkaufspostens. */
export function icsFieldsForShoppingItem(item, hadCompleted = false) {
  return {
    SUMMARY: item.name,
    ...completionFields(!!item.is_checked, false, hadCompleted),
  };
}

/** Trägt das Objekt bereits einen Erledigt-Zeitpunkt? */
function hasCompleted(icsText) {
  return /^COMPLETED[;:]/im.test(String(icsText || ''));
}

// --------------------------------------------------------
// Vormerkung: Löschung
// --------------------------------------------------------

/** Gibt es das Konto noch? */
function accountExists(accountId) {
  return !!db.get().prepare('SELECT 1 FROM caldav_accounts WHERE id = ?').get(accountId);
}

/**
 * Ist dieser Eintrag ein CalDAV-Spiegel, für den die Rückrichtung überhaupt gilt?
 * Lokale Aufgaben haben external_source = 'local' und gehen nirgendwohin.
 *
 * Das Konto muss es noch geben. `external_account_id` trägt keinen
 * Fremdschlüssel (v45), eine gedriftete Datenbank kann also auf ein längst
 * gelöschtes Konto zeigen - und der Tombstone darauf scheiterte am
 * Fremdschlüssel von caldav_todo_pending_deletions, womit sich die Aufgabe
 * lokal nicht mehr löschen ließe. Ohne Konto gibt es keinen Rückweg, also ist
 * hier nichts vorzumerken: dieselbe Vorprüfung wie acceptsOutbound() bei den
 * Terminen. Der Regelfall ist ohnehin abgedeckt - caldavSync.deleteAccount
 * entkoppelt seine Zeilen (detachAccountRows), Migration v123 den Bestand.
 */
function isMirrored(row) {
  if (!row || row.external_source !== 'caldav') return false;
  if (!row.external_uid || !row.external_account_id) return false;
  return accountExists(row.external_account_id);
}

/**
 * Löst die gespiegelten Zeilen eines Kontos von ihm ab - zu rufen, bevor das
 * Konto verschwindet. Was hier steht, sind Nutzerdaten und bleibt; nur die
 * Verbindung zum Server geht. Danach ist es eine gewöhnliche Aufgabe bzw. ein
 * gewöhnlicher Einkaufsposten: kein Tombstone, kein Push, und der Prune-Lauf
 * eines anderen Kontos fasst sie nicht an.
 *
 * @returns {number} Anzahl entkoppelter Zeilen
 */
export function detachAccountRows(accountId) {
  let detached = 0;
  for (const def of Object.values(MODULES)) {
    detached += db.get().prepare(`
      UPDATE ${def.table}
         SET external_source     = 'local',
             external_uid        = NULL,
             external_account_id = NULL,
             external_object_url = NULL,
             outbound_dirty      = 0,
             outbound_attempts   = 0
       WHERE external_source = 'caldav' AND external_account_id = ?
    `).run(accountId).changes;
  }
  return detached;
}

/**
 * Merkt einen gerade lokal gelöschten Spiegel-Eintrag für die Löschung auf dem
 * Server vor. Muss VOR dem lokalen DELETE mit der noch vorhandenen Zeile
 * aufgerufen werden - danach sind UID und Objekt-URL weg.
 *
 * @returns {boolean} true, wenn ein Tombstone entstanden ist
 */
export function queueTodoDeletion(module, row) {
  moduleDef(module);
  if (!isMirrored(row)) return false;

  db.get().prepare(`
    INSERT INTO caldav_todo_pending_deletions (account_id, module, uid, object_url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, module, uid)
      DO UPDATE SET object_url = COALESCE(excluded.object_url, object_url)
  `).run(row.external_account_id, module, row.external_uid, row.external_object_url || null);
  return true;
}

/** Merkt alle gespiegelten Einträge einer Auswahl vor (Mehrfachlöschungen). */
export function queueTodoDeletions(module, rows) {
  let queued = 0;
  for (const row of rows || []) {
    if (queueTodoDeletion(module, row)) queued++;
  }
  return queued;
}

export function pendingDeletions(accountId, module) {
  return db.get().prepare(`
    SELECT id, uid, object_url, attempts
    FROM caldav_todo_pending_deletions
    WHERE account_id = ? AND module = ?
    ORDER BY id
  `).all(accountId, module);
}

/**
 * Offene Lösch-UIDs eines Moduls als Set - der Inbound darf einen lokal
 * gelöschten Eintrag nicht wieder anlegen, solange der Server ihn noch führt.
 * Fehlt die Tabelle (gedriftete Datenbank), gilt "keine offenen Löschungen":
 * daran darf ein Inbound-Lauf nicht scheitern.
 */
export function pendingDeletionUids(accountId, module) {
  try {
    return new Set(
      db.get().prepare(
        'SELECT uid FROM caldav_todo_pending_deletions WHERE account_id = ? AND module = ?'
      ).all(accountId, module).map((r) => r.uid)
    );
  } catch (err) {
    log.warn(`Pending deletions are not readable (${err.message}); treating them as none.`);
    return new Set();
  }
}

function dropDeletion(id) {
  db.get().prepare('DELETE FROM caldav_todo_pending_deletions WHERE id = ?').run(id);
}

function failDeletion(id, err) {
  db.get().prepare(
    'UPDATE caldav_todo_pending_deletions SET attempts = attempts + 1, last_error = ? WHERE id = ?'
  ).run(String(err?.message || err).slice(0, 500), id);
}

// --------------------------------------------------------
// Vormerkung: Änderung
// --------------------------------------------------------

export function mirroredFieldsChanged(module, before, after) {
  return moduleDef(module).mirrored.some((f) => before?.[f] !== after?.[f]);
}

/**
 * Merkt eine lokale Bearbeitung für den Push vor.
 * @param {'tasks'|'shopping'} module
 * @param {object} before  Zeile vor der Änderung
 * @param {object} after   Zeile danach
 * @returns {boolean} true, wenn etwas aussteht
 */
export function markTodoOutbound(module, before, after) {
  const def = moduleDef(module);
  if (!isMirrored(after)) return false;
  if (!mirroredFieldsChanged(module, before, after)) return false;

  db.get().prepare(
    `UPDATE ${def.table} SET outbound_dirty = 1, outbound_attempts = 0 WHERE id = ?`
  ).run(after.id);
  return true;
}

export function pendingUpdates(accountId, module) {
  const def = moduleDef(module);
  return db.get().prepare(`
    SELECT * FROM ${def.table}
    WHERE outbound_dirty = 1 AND external_source = 'caldav' AND external_account_id = ?
    ORDER BY id
  `).all(accountId);
}

/** UIDs mit ausstehendem Push - der Inbound überschreibt sie nicht. */
export function pendingUpdateUids(accountId, module) {
  const def = moduleDef(module);
  try {
    return new Set(
      db.get().prepare(`
        SELECT external_uid FROM ${def.table}
        WHERE outbound_dirty = 1 AND external_source = 'caldav' AND external_account_id = ?
      `).all(accountId).map((r) => r.external_uid)
    );
  } catch (err) {
    log.warn(`Pending updates are not readable (${err.message}); treating them as none.`);
    return new Set();
  }
}

function clearOutbound(module, id) {
  const def = moduleDef(module);
  db.get().prepare(
    `UPDATE ${def.table} SET outbound_dirty = 0, outbound_attempts = 0 WHERE id = ?`
  ).run(id);
}

function failOutbound(module, id) {
  const def = moduleDef(module);
  db.get().prepare(
    `UPDATE ${def.table} SET outbound_attempts = outbound_attempts + 1 WHERE id = ?`
  ).run(id);
}

/**
 * Der Stand unmittelbar vor dem Server-Aufruf; null, wenn parallel gelöscht.
 * Aufgaben bekommen ihre Tags angehängt - sie liegen in task_tags, `SELECT *`
 * allein liefert sie also nicht, und icsFieldsForTask baut CATEGORIES daraus (#586).
 */
function reloadRow(module, id) {
  const def = moduleDef(module);
  const row = db.get().prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(id) ?? null;
  if (row && module === 'tasks') row.tags = loadTags(db.get(), row.id);
  return row;
}

// --------------------------------------------------------
// Vormerkung: Anlegen (#695)
// --------------------------------------------------------

/**
 * UID einer in Yuvomi entstandenen Aufgabe.
 *
 * Bewusst aus der Zeilen-Id abgeleitet und nicht zufällig: scheitert der Schritt
 * NACH dem Upload (die Zeile auf 'caldav' umzuschreiben), nimmt der nächste Lauf
 * dieselbe UID und überschreibt das Objekt, statt ein zweites anzulegen. Eine
 * Zufalls-UID hätte an derselben Stelle eine Dublette hinterlassen.
 *
 * Neuer Namensraum, deshalb `yuvomi`: die oikos-Kennungen der Termine bleiben aus
 * Rückwärtskompatibilität stehen, sie werden aber nicht fortgeschrieben.
 */
export function todoUidFor(module, id) {
  return `yuvomi-${module === 'shopping' ? 'item' : 'task'}-${id}@yuvomi.local`;
}

/**
 * Vollständiges VTODO-Objekt für einen Eintrag, den es auf dem Server noch nicht
 * gibt. Gebaut wird ein Gerüst mit UID und DTSTAMP, das anschließend durch
 * denselben Patcher läuft wie jede spätere Änderung - so gibt es genau EINE
 * Stelle, die Yuvomi-Felder in VTODO-Properties übersetzt. Eine zweite
 * Serialisierung neben icsFieldsForTask wäre die Sorte Doppelung, die
 * auseinanderläuft, sobald ein Feld dazukommt.
 */
export function buildTodoICS(module, row, uid) {
  const def = moduleDef(module);
  const skeleton = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Yuvomi//CalDAV Sync//EN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `DTSTAMP:${utcStamp()}`,
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');

  return patchICSTodo(skeleton, uid, def.icsFields(row, false, householdTimeZone(db.get())));
}

/**
 * Einträge, die hier entstanden sind und auf ihren ersten Upload warten.
 *
 * Unteraufgaben bleiben ausgenommen: sie sind Punkte einer Checkliste, und als
 * eigenständige VTODOs stünden sie auf dem Server gleichrangig neben ihrer
 * Elternaufgabe - der Zusammenhang, der sie überhaupt zu Unteraufgaben macht,
 * ginge dabei verloren. VTODO kennt zwar RELATED-TO, aber der Inbound wertet es
 * nicht aus; die Rundreise würde sie also als lose Aufgaben zurückbringen.
 */
export function pendingCreations(accountId, module = 'tasks') {
  const def = moduleDef(module);
  if (module !== 'tasks') return [];
  return db.get().prepare(`
    SELECT * FROM ${def.table}
     WHERE external_source          = 'local'
       AND target_caldav_account_id = ?
       AND target_caldav_list_url IS NOT NULL
       AND parent_task_id IS NULL
     ORDER BY id
  `).all(accountId);
}

/**
 * Einkaufsartikel einer gespiegelten Liste, die es auf dem Server noch nicht gibt.
 *
 * `external_source = 'local'` ist der Spalten-Default, trennt also genau die
 * hier angelegten Artikel von den vom Server geholten Spiegeln.
 */
export function pendingShoppingCreations(listId) {
  return db.get().prepare(`
    SELECT * FROM shopping_items
     WHERE external_source = 'local'
       AND list_id         = ?
     ORDER BY id
  `).all(listId);
}

/**
 * Konten, unter denen ein hier angelegter Einkaufsartikel auf seinen Upload
 * wartet (#831). Anders als eine Aufgabe merkt sich ein Artikel kein Ziel - die
 * offene Arbeit ist deshalb nur über die Listenzuordnung sichtbar.
 */
function accountsWithPendingShoppingCreations() {
  try {
    return db.get().prepare(`
      SELECT DISTINCT sel.account_id AS account_id
        FROM caldav_reminder_selection sel
        JOIN shopping_items i ON i.list_id = sel.target_list_id
       WHERE sel.enabled = 1
         AND sel.target_module = 'shopping'
         AND sel.target_list_id IS NOT NULL
         AND i.external_source = 'local'
    `).all().map((r) => r.account_id).filter(Boolean);
  } catch (err) {
    log.warn(`Pending shopping creations are not readable (${err.message}); treating them as none.`);
    return [];
  }
}

/** Konten mit wartenden Uploads. */
function accountsWithPendingCreations() {
  try {
    return db.get().prepare(`
      SELECT DISTINCT target_caldav_account_id AS account_id FROM tasks
       WHERE external_source = 'local' AND target_caldav_account_id IS NOT NULL
    `).all().map((r) => r.account_id).filter(Boolean);
  } catch (err) {
    // Gedriftete Datenbank ohne Migration 136: kein Grund, den ganzen
    // Sofortversuch scheitern zu lassen.
    log.warn(`Pending creations are not readable (${err.message}); treating them as none.`);
    return [];
  }
}

/** Das Ziel wieder abräumen - nach dem Upload und wenn es unerreichbar ist. */
function clearCreationTarget(id) {
  db.get().prepare(
    'UPDATE tasks SET target_caldav_account_id = NULL, target_caldav_list_url = NULL WHERE id = ?'
  ).run(id);
}

/**
 * Einen lokalen Eintrag auf dem Server anlegen und die Zeile zum Spiegel machen.
 *
 * Gemeinsamer Kern beider Anlege-Wege: Aufgaben tragen ihr Ziel selbst, ein
 * Einkaufsartikel erbt es von der Listenzuordnung (siehe unten). Was danach
 * passiert, ist identisch - deshalb steht es hier nur einmal.
 *
 * Die Objekt-URL wird gleich festgehalten: ohne sie wäre der frisch
 * hochgeladene Eintrag für Änderungen und Löschungen unerreichbar, bis der
 * nächste Inbound-Lauf ihn wiederfindet (dieselbe Lehre wie bei den Terminen,
 * #593).
 *
 * @returns {Promise<boolean>} false, wenn sich kein VTODO bauen ließ
 */
async function uploadNewTodo(client, collection, module, row, accountId) {
  const def = moduleDef(module);
  const uid = todoUidFor(module, row.id);
  const ics = buildTodoICS(module, row, uid);
  if (!ics) return false;

  await client.createCalendarObject({
    calendar:   collection,
    filename:   `${uid}.ics`,
    iCalString: ics,
  });

  const objectUrl = `${String(collection.url).replace(/\/?$/, '/')}${uid}.ics`;
  db.get().prepare(`
    UPDATE ${def.table}
       SET external_source     = 'caldav',
           external_uid        = ?,
           external_account_id = ?,
           external_object_url = ?,
           outbound_dirty      = 0,
           outbound_attempts   = 0
     WHERE id = ?
  `).run(uid, accountId, objectUrl, row.id);
  return true;
}

/**
 * Legt wartende Aufgaben auf dem Server an und macht sie damit zu Spiegeln.
 *
 * @param {object} client       tsdav-Client
 * @param {number} accountId
 * @param {string} module
 * @param {Map}    listsByUrl   Listen-URL → Collection des Servers
 * @returns {Promise<number>} erfolgreich hochgeladene Einträge
 */
export async function processPendingCreations(client, accountId, module, listsByUrl) {
  const rows = pendingCreations(accountId, module);
  if (rows.length === 0) return 0;

  let done = 0;
  for (const row of rows) {
    const collection = listsByUrl.get(row.target_caldav_list_url);
    if (!collection) {
      // Die Liste ist weg oder wurde abgewählt. Das Ziel stehen zu lassen hieße,
      // es bei jedem Lauf erneut zu versuchen; die Aufgabe bleibt lokal, was der
      // Zustand vor #695 war und keine Daten kostet.
      log.warn(`Reminder list ${row.target_caldav_list_url} is not available, keeping task ${row.id} local.`);
      clearCreationTarget(row.id);
      continue;
    }

    const fresh = reloadRow(module, row.id);
    if (!fresh) continue; // zwischenzeitlich gelöscht

    try {
      if (await uploadNewTodo(client, collection, module, fresh, accountId)) {
        clearCreationTarget(fresh.id);
        done++;
      } else {
        log.error(`Could not build a VTODO for task ${fresh.id}, keeping it local.`);
        clearCreationTarget(fresh.id);
      }
    } catch (err) {
      // Kein Zähler und kein Aufgeben: anders als eine Änderung hat ein Upload
      // keinen Stand, der veralten könnte. Er bleibt vorgemerkt und läuft im
      // nächsten Lauf mit, so lange bis er durchgeht oder das Ziel verschwindet.
      log.warn(`Could not upload task ${fresh.id} to ${row.target_caldav_list_url}: ${err.message}`);
    }
  }
  return done;
}

/**
 * Hier angelegte Einkaufsartikel einer gespiegelten Liste hochladen (#831).
 *
 * Ein Einkaufsartikel trägt - anders als eine Aufgabe - kein eigenes Ziel: die
 * Zuordnung Server-Liste ↔ Yuvomi-Liste steht schon in
 * caldav_reminder_selection, und genau sie ist die Zielangabe. Deshalb braucht
 * dieser Weg weder Zielspalten noch eine Migration; Kandidat ist jeder Artikel
 * der zugeordneten Liste, der noch kein Spiegel ist.
 *
 * Ohne das war die Rückrichtung für den Einkauf halb da: Umbenennen, Abhaken und
 * Löschen liefen über processPendingUpdates/-Deletions zum Server, ein neu
 * angelegter Artikel blieb aber für immer lokal - die Liste lief nach jedem
 * neuen Eintrag auseinander, obwohl die Oberfläche einen Zwei-Wege-Sync
 * verspricht.
 *
 * @param {object} client      tsdav-Client
 * @param {number} accountId
 * @param {Array<{listUrl: string, targetListId: number}>} targets  aktive Zuordnungen
 * @param {Map}    listsByUrl  Listen-URL → Collection des Servers
 * @returns {Promise<number>} erfolgreich hochgeladene Artikel
 */
export async function processPendingShoppingCreations(client, accountId, targets, listsByUrl) {
  let done = 0;
  for (const { listUrl, targetListId } of targets) {
    if (!targetListId) continue;
    const collection = listsByUrl.get(listUrl);
    if (!collection) continue;

    for (const row of pendingShoppingCreations(targetListId)) {
      const fresh = reloadRow('shopping', row.id);
      if (!fresh) continue; // zwischenzeitlich gelöscht

      try {
        if (await uploadNewTodo(client, collection, 'shopping', fresh, accountId)) done++;
        else log.error(`Could not build a VTODO for shopping item ${fresh.id}, keeping it local.`);
      } catch (err) {
        // Wie oben: bleibt lokal und läuft im nächsten Lauf wieder mit.
        log.warn(`Could not upload shopping item ${fresh.id} to ${listUrl}: ${err.message}`);
      }
    }
  }
  return done;
}

// --------------------------------------------------------
// Ausführung
// --------------------------------------------------------

/**
 * Arbeitet vorgemerkte Löschungen ab.
 *
 * @param {object}  client       tsdav-Client
 * @param {number}  accountId
 * @param {string}  module
 * @param {Map}     objectIndex  UID → { url, etag, data }
 * @param {boolean} complete     true, wenn alle Listen dieses Kontos abgerufen
 *                               wurden. Nur dann ist "der Server führt das Objekt
 *                               nicht mehr" belegt und der Tombstone erledigt;
 *                               im Sofortversuch (nur einzelne Objekte geholt)
 *                               bleibt er sonst liegen.
 * @returns {Promise<number>} erledigte Tombstones
 */
export async function processPendingDeletions(client, accountId, module, objectIndex, complete = false) {
  const rows = pendingDeletions(accountId, module);
  if (rows.length === 0) return 0;

  let done = 0;
  for (const row of rows) {
    const known = objectIndex.get(row.uid);
    const url   = row.object_url || known?.url || null;

    if (!url) {
      if (complete) {
        log.info(`VTODO ${row.uid} is no longer on the server, dropping the pending deletion.`);
        dropDeletion(row.id);
        done++;
      }
      continue;
    }

    try {
      await client.deleteCalendarObject({ calendarObject: { url, etag: known?.etag } });
      dropDeletion(row.id);
      done++;
    } catch (err) {
      const action = outboundFailureAction(err, row.attempts);
      if (action === 'settled') {
        dropDeletion(row.id);
        done++;
        continue;
      }
      failDeletion(row.id, err);
      if (action === 'give-up') {
        log.error(`Giving up on remote deletion of VTODO ${row.uid} after ${row.attempts + 1} attempt(s):`, err.message);
        dropDeletion(row.id);
        done++;
        continue;
      }
      log.warn(`Remote deletion failed for VTODO ${row.uid} (attempt ${row.attempts + 1}):`, err.message);
    }
  }
  return done;
}

/**
 * Schiebt lokal bearbeitete Spiegel-Einträge zum Server. Geändert wird das
 * Originalobjekt, nicht ein neu gebautes: sonst verlöre die Aufgabe auf dem
 * Server alles, was Yuvomi nicht kennt (Alarme, Unterlisten, Beziehungen).
 * CATEGORIES gehört seit #586 nicht mehr dazu - die Tag-Liste ist vollständig
 * gespiegelt und wird deshalb bewusst verwaltet.
 *
 * @returns {Promise<number>} erfolgreich verarbeitete Einträge
 */
export async function processPendingUpdates(client, accountId, module, objectIndex) {
  const def  = moduleDef(module);
  const rows = pendingUpdates(accountId, module);
  if (rows.length === 0) return 0;

  let done = 0;
  for (const row of rows) {
    const known = objectIndex.get(row.external_uid);
    const url   = row.external_object_url || known?.url || null;

    // Weder gespeichert noch im aktuellen Abruf: gehört zu einer Liste, die
    // dieser Lauf nicht angefasst hat. Nichts tun, nichts verwerfen.
    if (!url) continue;

    if (!known?.data) {
      log.warn(`No source object for ${def.table} row ${row.id} in this run, deferring its update.`);
      continue;
    }

    // Frisch nachladen: zwischen der Auswahl und hier liegt ein await, in dem
    // eine weitere Bearbeitung eingetroffen sein kann.
    const fresh = reloadRow(module, row.id);
    if (!fresh) continue; // parallel gelöscht - der Tombstone-Pfad übernimmt

    const patched = patchICSTodo(
      known.data, row.external_uid, def.icsFields(fresh, hasCompleted(known.data), householdTimeZone(db.get()))
    );
    if (!patched) {
      log.warn(`VTODO ${row.external_uid} has no editable component in its calendar object, dropping its update.`);
      clearOutbound(module, row.id);
      continue;
    }

    try {
      await client.updateCalendarObject({ calendarObject: { url, etag: known.etag, data: patched } });
      clearOutbound(module, row.id);
      done++;
    } catch (err) {
      const action = outboundFailureAction(err, row.outbound_attempts);
      if (action === 'settled') {
        log.warn(`VTODO ${row.external_uid} no longer exists on the server, dropping its update.`);
        clearOutbound(module, row.id);
        continue;
      }
      if (action === 'give-up') {
        log.error(`Giving up on the outbound update of "${def.labelOf(row)}" after ${row.outbound_attempts + 1} attempt(s):`, err.message);
        clearOutbound(module, row.id);
        continue;
      }
      failOutbound(module, row.id);
      log.warn(`Outbound update failed for "${def.labelOf(row)}" (attempt ${row.outbound_attempts + 1}):`, err.message);
    }
  }
  return done;
}

// --------------------------------------------------------
// Sofortversuch (Fassade für die Route)
// --------------------------------------------------------

/** Konten mit offener ausgehender Arbeit, samt Modul. */
function accountsWithPendingWork() {
  const buckets = new Map();
  const add = (accountId, module) => {
    if (!accountId) return;
    if (!buckets.has(accountId)) buckets.set(accountId, new Set());
    buckets.get(accountId).add(module);
  };

  for (const row of db.get().prepare(
    'SELECT DISTINCT account_id, module FROM caldav_todo_pending_deletions'
  ).all()) {
    add(row.account_id, row.module);
  }
  for (const [module, def] of Object.entries(MODULES)) {
    for (const row of db.get().prepare(`
      SELECT DISTINCT external_account_id AS account_id FROM ${def.table}
      WHERE outbound_dirty = 1 AND external_source = 'caldav'
    `).all()) {
      add(row.account_id, module);
    }
  }
  for (const accountId of accountsWithPendingCreations()) add(accountId, 'tasks');
  for (const accountId of accountsWithPendingShoppingCreations()) add(accountId, 'shopping');
  return buckets;
}

/**
 * Die für Aufgaben freigeschalteten Listen eines Kontos als Collection-Objekte.
 *
 * Der Umweg über die Auswahltabelle ist Absicht: hochgeladen wird nur in eine
 * Liste, die der Haushalt für Aufgaben freigegeben hat. Ein Ziel, das inzwischen
 * abgewählt wurde, taucht hier nicht mehr auf, und processPendingCreations gibt
 * die Aufgabe dann wieder frei, statt sie ewig zu versuchen.
 */
async function taskListsOf(client, accountId) {
  const selected = db.get().prepare(`
    SELECT list_url FROM caldav_reminder_selection
     WHERE account_id = ? AND enabled = 1 AND target_module = 'tasks'
  `).all(accountId).map((r) => r.list_url);
  if (!selected.length) return new Map();

  const allowed = new Set(selected);
  const calendars = await client.fetchCalendars();
  return new Map(
    (calendars || []).filter((c) => allowed.has(c.url)).map((c) => [c.url, c])
  );
}

/**
 * Die für den Einkauf freigeschalteten Zuordnungen eines Kontos (#831).
 * Gegenstück zu taskListsOf: dort steht das Ziel am Eintrag, hier an der
 * Zuordnung. Bewusst ohne Netzzugriff, damit der Aufrufer erst prüfen kann, ob
 * überhaupt etwas wartet - der Listenabruf ist der teure Teil.
 */
function shoppingSelectionsOf(accountId) {
  return db.get().prepare(`
    SELECT list_url, target_list_id FROM caldav_reminder_selection
     WHERE account_id = ? AND enabled = 1 AND target_module = 'shopping'
       AND target_list_id IS NOT NULL
  `).all(accountId).map((r) => ({ listUrl: r.list_url, targetListId: r.target_list_id }));
}

/** Collection-Objekte zu den Zuordnungen - ein Listenabruf. */
async function collectionsForTargets(client, targets) {
  const allowed   = new Set(targets.map((tgt) => tgt.listUrl));
  const calendars = await client.fetchCalendars();
  return new Map((calendars || []).filter((c) => allowed.has(c.url)).map((c) => [c.url, c]));
}

/**
 * Holt gezielt die betroffenen Kalenderobjekte statt ganzer Listen - die
 * Grundlage des Sofortversuchs direkt nach einer Bearbeitung. Die Collection
 * wird aus der Objekt-URL abgeleitet, weil ein Eintrag nur diese trägt.
 *
 * @returns {Promise<Map>} UID → { url, etag, data }
 */
async function fetchObjectsByUrl(client, wanted) {
  const index = new Map();
  if (!wanted.length) return index;

  const byCollection = new Map();
  for (const item of wanted) {
    const collection = collectionUrlOf(item.url);
    if (!collection) continue;
    if (!byCollection.has(collection)) byCollection.set(collection, []);
    byCollection.get(collection).push(item);
  }

  for (const [collection, items] of byCollection) {
    try {
      const objects = await client.fetchCalendarObjects({
        calendar:   { url: collection },
        objectUrls: items.map((i) => i.url),
      });
      for (const obj of objects || []) {
        const match = items.find((i) => i.url === obj.url) || (items.length === 1 ? items[0] : null);
        if (!match) continue;
        index.set(match.uid, { url: obj.url || match.url, etag: obj.etag, data: obj.data });
      }
    } catch (err) {
      // Kein Grund zur Sorge: der reguläre Sync-Lauf holt die Liste ohnehin.
      log.warn(`Could not fetch VTODO objects from ${collection} for the immediate attempt: ${err.message}`);
    }
  }
  return index;
}

/**
 * Sofortiger Best-Effort-Durchlauf direkt nach einer lokalen Änderung oder
 * Löschung, damit der Server nicht erst beim nächsten Sync-Intervall nachzieht.
 * Fehler sind unkritisch - die Vormerkung bleibt stehen und der Sync holt nach.
 *
 * @param {{createClient?: Function}} [opts] Client-Factory (Tests)
 * @returns {Promise<{deleted:number,updated:number}>}
 */
export async function flushOutbound(opts = {}) {
  return runSerialized('caldav-todo', 'flush', () => runFlushOutbound(opts));
}

async function runFlushOutbound({ createClient } = {}) {
  const total  = { deleted: 0, updated: 0, created: 0 };
  const work   = accountsWithPendingWork();
  if (work.size === 0) return total;

  const makeClient = createClient || createCalDAVClient;

  for (const [accountId, modules] of work) {
    const account = db.get().prepare('SELECT * FROM caldav_accounts WHERE id = ?').get(accountId);
    if (!account) continue;

    try {
      const client = await makeClient(account);

      for (const module of modules) {
        const wanted = [
          ...pendingDeletions(accountId, module)
            .filter((r) => r.object_url)
            .map((r) => ({ uid: r.uid, url: r.object_url })),
          ...pendingUpdates(accountId, module)
            .filter((r) => r.external_object_url)
            .map((r) => ({ uid: r.external_uid, url: r.external_object_url })),
        ];

        const objectIndex = await fetchObjectsByUrl(client, wanted);

        // complete = false: ohne vollen Listenabruf ist "der Server führt das
        // Objekt nicht mehr" nicht belegbar; ein Tombstone ohne bekannte URL
        // bleibt für den Sync liegen.
        total.deleted += await processPendingDeletions(client, accountId, module, objectIndex, false);
        total.updated += await processPendingUpdates(client, accountId, module, objectIndex);

        // Uploads brauchen die Collection selbst, nicht einzelne Objekte - und
        // damit den einzigen Listenabruf in diesem Pfad. Er läuft deshalb nur,
        // wenn wirklich etwas wartet.
        if (module === 'tasks' && pendingCreations(accountId, module).length) {
          total.created += await processPendingCreations(
            client, accountId, module, await taskListsOf(client, accountId)
          );
        }
        if (module === 'shopping') {
          const targets = shoppingSelectionsOf(accountId)
            .filter((tgt) => pendingShoppingCreations(tgt.targetListId).length);
          if (targets.length) {
            total.created += await processPendingShoppingCreations(
              client, accountId, targets, await collectionsForTargets(client, targets)
            );
          }
        }
      }
    } catch (err) {
      log.warn(`[Account ${accountId}] Immediate outbound attempt failed: ${err.message}`);
    }
  }
  return total;
}
