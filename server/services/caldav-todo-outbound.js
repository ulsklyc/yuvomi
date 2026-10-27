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
// Ein Umzug zwischen Listen fehlt für AUFGABEN weiterhin bewusst: eine Aufgabe
// gehört zu der Liste, aus der sie kam. Ein Einkaufsartikel kann seit #1700 die
// Liste wechseln, und sein Objekt auf dem Server zieht MIT ("Mitnahme",
// `moveShoppingMirror` und `processPendingShoppingMoves`):
//
//   Umzug   → shopping_items.outbound_move auf der Zeile selbst
//
// Die Zeile steht sofort auf der neuen Liste und zeigt weiter auf ihr Objekt
// am alten Platz. Der Durchgang liest das Original dort, legt es unverändert
// am neuen Platz ab (nur eine hier wartende Bearbeitung ist eingearbeitet),
// bucht die Zeile um und entfernt es ERST DANN am alten Platz. Was zwischen
// diesen Schritten abbricht, führt ein späterer Durchgang zu Ende; an keiner
// Stelle liegt das Objekt an keinem der beiden Plätze. Ist die Zielliste nicht
// gespiegelt, ist der Umzug am Server ein Löschen (`releaseShoppingMirror`).
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
import { davFailureAction, createRefusalStop, MAX_OUTBOUND_ATTEMPTS } from './calendar-outbound.js';
import { patchICSTodo } from '../utils/ics-patch.js';
import {
  createCalDAVClient, collectionUrlOf, createUploadGate, sameObjectAddress, withAccountOrigin, isOriginRefusal,
  isAccountWideRefusal, acceptsNewEntries,
} from '../utils/caldav-client.js';
import {
  ownUid, isOwnUidOfRow, ownUploadRowId, parseOwnUid, findObjectWithUid, inspectObjectAt,
} from '../utils/own-uid.js';
import {
  noteUploadAttempt, settleUploadAttempt, uploadAttemptsAt,
  hasUploadAttempt, removeLeftoverUploads,
} from './caldav-upload-attempts.js';
import { householdTimeZone, localToUTC } from '../utils/timezone.js';
import { loadTags, tagsKey } from '../utils/task-tags.js';
import { runSerialized } from '../utils/sync-lock.js';
import { noteMoveTakenBack } from './shopping-move-notices.js';

const log = createLogger('CalDAV-Todo-Outbound');

/**
 * Client eines Kontos für den VTODO-Weg: gezielte Anfragen (PUT, DELETE,
 * Objektabruf) nur an den Server dieses Kontos - `caldav_url` und die Listen
 * und Kalender seiner Auswahl -, wie bei den Terminen seit #1860
 * (`withAccountOrigin`).
 *
 * Die Objekt-Adresse einer gespiegelten Zeile stammt aus der href der
 * Server-Antwort, und tsdav übernimmt eine absolute href so, wie sie dasteht.
 * Lauf, Sofortversuch und die Quelle einer Mitnahme bauen ihre Clients deshalb
 * alle hier.
 *
 * @param {object}   account     Zeile aus `caldav_accounts`
 * @param {Function} makeClient  Factory (`createCalDAVClient` oder Test-Factory)
 */
export async function createTodoClient(account, makeClient = createCalDAVClient) {
  const selected = db.get().prepare(`
    SELECT list_url AS url FROM caldav_reminder_selection WHERE account_id = ?
    UNION SELECT calendar_url FROM caldav_calendar_selection WHERE account_id = ?
  `).all(account.id, account.id).map((r) => r.url);
  return withAccountOrigin(await makeClient(account), [account.caldav_url, ...selected]);
}

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
 * Konto verschwindet. Dieselbe Regel wie bei Terminen (#1885, #1906): die
 * Zeile bleibt Spiegel ihrer UID, verliert nur ihr Konto, und das nächste
 * Konto, das die UID liefert, übernimmt sie - statt dass es neben ihr eine
 * zweite anlegt. Kein Tombstone und kein Push ohne Konto, und der Prune-Lauf
 * eines anderen Kontos fasst sie nicht an. Der Trigger
 * `trg_caldav_accounts_release_rows` (v268) tut dasselbe für jeden anderen
 * Weg, auf dem ein Konto verschwindet.
 *
 * @returns {number} Anzahl abgelöster Zeilen
 */
export function detachAccountRows(accountId) {
  let detached = 0;
  for (const def of Object.values(MODULES)) {
    detached += db.get().prepare(`
      UPDATE ${def.table}
         SET external_account_id = NULL,${def.table === 'shopping_items' ? `
             outbound_move          = 0,
             outbound_move_attempts = 0,
             outbound_move_since    = NULL,
             outbound_move_by       = NULL,` : ''}
             outbound_dirty      = 0,
             outbound_attempts   = 0
       WHERE external_source = 'caldav' AND external_account_id = ?
    `).run(accountId).changes;
  }
  // Das Upload-Ziel lokaler Aufgaben trägt ebenso keinen Fremdschlüssel
  // (#1885). Ohne Ziel bleibt die Aufgabe lokal und wird nie gesendet - wie
  // jede Zeile ohne Konto. Einkaufsposten tragen kein eigenes Ziel: sie erben
  // es von der Listenzuordnung, und die fällt per CASCADE mit dem Konto.
  db.get().prepare(`
    UPDATE tasks SET target_caldav_account_id = NULL, target_caldav_list_url = NULL
     WHERE target_caldav_account_id = ?
  `).run(accountId);
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

/**
 * Löst EINEN Einkaufsartikel von seinem Objekt auf dem Server, weil er auf
 * eine Liste zieht, die NICHT gespiegelt ist (#1700): das Objekt wird zur
 * Löschung vorgemerkt, die Zeile selbst bleibt und ist danach ein
 * gewöhnlicher, hier angelegter Artikel. Am Server ist dieser Umzug ein
 * Löschen - es gibt dort keinen Platz, an den das Objekt mitkönnte.
 *
 * Die gespiegelten Etiketten (VTODO-CATEGORIES, #586) gehen mit dem Objekt:
 * sie sind eine Kopie SEINER Eigenschaft, Yuvomi verwaltet sie nicht. Blieben
 * sie stehen, zeigte die Zeile Etiketten, die es nirgends mehr gibt und die
 * sich hier nicht entfernen lassen.
 *
 * Muss mit der Zeile VOR dem Umzug gerufen werden.
 *
 * @returns {boolean} true, wenn ein Tombstone entstanden ist
 */
export function releaseShoppingMirror(row) {
  if (!row || row.external_source !== 'caldav') return false;
  // Ohne Konto (gedriftete Datenbank) gibt es keinen Rückweg und nichts
  // vorzumerken - entkoppelt wird trotzdem, sonst zeigte die Zeile auf der
  // neuen Liste weiter auf ein Objekt der alten.
  const queued = queueTodoDeletion('shopping', row);
  db.get().prepare('DELETE FROM shopping_item_tags WHERE item_id = ?').run(row.id);
  db.get().prepare(`
    UPDATE shopping_items
       SET external_source        = 'local',
           external_uid           = NULL,
           external_account_id    = NULL,
           external_object_url    = NULL,
           outbound_dirty         = 0,
           outbound_attempts      = 0,
           outbound_move          = 0,
           outbound_move_attempts = 0,
           outbound_move_since    = NULL,
           outbound_move_by       = NULL
     WHERE id = ?
  `).run(row.id);
  return queued;
}

/**
 * Die Server-Listen, denen diese Einkaufsliste zugeordnet ist - auch die
 * abgewählten. Abgewählt heisst "gerade nicht abgleichen", nicht "diese Liste
 * hat keinen Platz auf dem Server".
 */
function shoppingMappingsOf(listId) {
  return db.get().prepare(`
    SELECT account_id, list_url, enabled FROM caldav_reminder_selection
     WHERE target_module = 'shopping' AND target_list_id = ?
  `).all(listId);
}

/**
 * Ein gespiegelter Einkaufsartikel wechselt die Liste (#1700). Zu rufen in der
 * Transaktion des Umzugs, mit der Zeile VOR dem Umzug.
 *
 *   - Die Zielliste ist einer Server-Liste zugeordnet: die Zeile bleibt Spiegel
 *     ihres Objekts und bekommt `outbound_move = 1`. Das Objekt zieht mit dem
 *     nächsten Durchgang nach (`processPendingShoppingMoves`), mit allem, was
 *     daran hängt - deshalb bleiben auch die gespiegelten Etiketten an der
 *     Zeile. Ist die Zuordnung abgewählt, wartet der Umzug, bis sie wieder
 *     eingeschaltet ist: abgewählt heisst nicht "nicht gespiegelt", und ein
 *     Löschen am Server wäre dann nicht rückholbar.
 *   - Das Objekt liegt schon in einer Server-Liste, die der Zielliste über
 *     dasselbe Konto zugeordnet ist (der Artikel zieht zurück, bevor sein
 *     Objekt nachgezogen ist): nichts ist zu tun, eine Vormerkung fällt.
 *     Führt ein ANDERES Konto dieselbe Server-Liste auf die Zielliste, fällt
 *     die Vormerkung im Durchgang (`carryShoppingItem`).
 *   - Die Zielliste ist nicht gespiegelt: `releaseShoppingMirror`.
 *
 * @returns {'none'|'carry'|'home'|'released'}
 */
export function moveShoppingMirror(row, targetListId, movedBy = null) {
  if (!row || row.external_source !== 'caldav') return 'none';
  const from = collectionUrlOf(row.external_object_url);
  const mappings = isMirrored(row) ? shoppingMappingsOf(targetListId) : [];
  if (!mappings.length) {
    releaseShoppingMirror(row);
    return 'released';
  }
  const home = !!from && mappings.some(
    (sel) => sel.account_id === row.external_account_id && sameCollection(sel.list_url, from)
  );
  // Der Beginn zählt für die Frist eines wartenden Umzugs (#1911); ein neuer
  // Umzug beginnt sie neu. Wer verschoben hat, bekommt die Meldung, falls der
  // Umzug zurückgeht (#1912).
  db.get().prepare(`
    UPDATE shopping_items
       SET outbound_move = ?, outbound_move_attempts = 0,
           outbound_move_since = CASE WHEN ? THEN NULL ELSE datetime('now') END,
           outbound_move_by = ?
     WHERE id = ?
  `).run(home ? 0 : 1, home ? 1 : 0, home ? null : (movedBy ?? null), row.id);
  return home ? 'home' : 'carry';
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

/**
 * Liegt diese Objektadresse in einer Liste, die für das Konto ABGEWÄHLT ist
 * (#1884)? Ein Löschauftrag nennt seine Liste nicht; sie ergibt sich aus der
 * Adresse seines Objekts. Abgewählt heisst: die Auswahl des Kontos kennt die
 * Liste, und keine ihrer Zeilen ist eingeschaltet. Eine Adresse ohne Liste in
 * der Auswahl ist nicht abgewählt, sondern unbekannt - für sie gilt nichts
 * von hier.
 *
 * Gelesen bei jedem Aufruf: gefragt wird unmittelbar vor einem DELETE, und
 * davor liegen awaits.
 */
function inUnselectedList(accountId, objectUrl) {
  const list = collectionUrlOf(objectUrl);
  if (!list) return false;
  const known = db.get().prepare(
    'SELECT list_url, enabled FROM caldav_reminder_selection WHERE account_id = ?'
  ).all(accountId).filter((sel) => sameCollection(sel.list_url, list));
  return known.length > 0 && !known.some((sel) => sel.enabled === 1);
}

/**
 * Die Löschaufträge eines Kontos, die auf eine abgewählte Liste warten
 * (#1884), über beide Module.
 */
export function deletionsWaitingForSelection(accountId) {
  return db.get().prepare(
    'SELECT id, module, uid, object_url FROM caldav_todo_pending_deletions WHERE account_id = ? ORDER BY id'
  ).all(accountId).filter((row) => row.object_url && inUnselectedList(accountId, row.object_url));
}

/**
 * Räumt die Löschaufträge ab, deren Liste es auf dem Server nicht mehr gibt
 * (#1884): mit der Liste ist auch das Objekt fort. Der Lauf schaltet eine
 * verschwundene Liste ab, und ein Auftrag für eine abgewählte wartet - ohne
 * das hier für immer.
 *
 * Nur für Aufträge, deren Liste die Auswahl des Kontos kennt; eine Adresse,
 * die zu keiner bekannten Liste gehört, wird nicht beurteilt. `listedUrls` ist
 * die Auflistung DIESES Laufs und vom Aufrufer als nicht leer befunden.
 *
 * @returns {number} abgeräumte Aufträge
 */
export function dropDeletionsOfMissingLists(accountId, listedUrls) {
  const listed = [...(listedUrls || [])];
  if (listed.length === 0) return 0;
  const selection = db.get().prepare(
    'SELECT list_url FROM caldav_reminder_selection WHERE account_id = ?'
  ).all(accountId);
  const gone = new Map();
  for (const row of db.get().prepare(
    'SELECT id, object_url FROM caldav_todo_pending_deletions WHERE account_id = ? ORDER BY id'
  ).all(accountId)) {
    const list = collectionUrlOf(row.object_url);
    if (!list || !selection.some((sel) => sameCollection(sel.list_url, list))) continue;
    if (listed.some((url) => sameCollection(url, list))) continue;
    dropDeletion(row.id);
    gone.set(list, (gone.get(list) || 0) + 1);
  }
  let dropped = 0;
  for (const [list, count] of gone) {
    dropped += count;
    log.warn(`Reminder list ${list} no longer exists on the server: dropped ${count} pending deletion(s) for it, its entries are gone with it.`);
  }
  return dropped;
}

function failDeletion(id, err, { counts = true } = {}) {
  db.get().prepare(
    'UPDATE caldav_todo_pending_deletions SET attempts = attempts + ?, last_error = ? WHERE id = ?'
  ).run(counts ? 1 : 0, String(err?.message || err).slice(0, 500), id);
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

/**
 * Hat sich die Zeile geändert, seit `sent` gelesen wurde (#1862)? Beide Seiten
 * kommen aus `reloadRow`, tragen ihre Tags also als Liste; der Feldvergleich
 * kennt sie nur als `tags_key`.
 */
function changedSince(module, sent, now) {
  const keyed = (row) => (module === 'tasks' ? { ...row, tags_key: tagsKey(row.tags || []) } : row);
  return mirroredFieldsChanged(module, keyed(sent), keyed(now));
}

/**
 * Schliesst eine hinausgegangene Änderung ab - gegen den Stand von JETZT.
 *
 * Zwischen dem Nachladen vor dem PUT und hier liegt die Anfrage. Trifft in der
 * Zeit eine zweite Bearbeitung ein, steht outbound_dirty schon (wieder) auf 1,
 * und ein pauschales Zurücksetzen löschte genau diese Vormerkung: oben läge
 * die erste Bearbeitung, und der nächste Abruf ersetzte die zweite durch sie.
 * Erledigt ist nur, was hinausging - dasselbe wie `settleOutbound` bei den
 * Terminen. Synchron: zwischen dem Nachladen und dem Schreiben liegt kein await.
 */
function settleOutbound(module, sent) {
  const now = reloadRow(module, sent.id);
  if (!now) return; // inzwischen gelöscht - der Tombstone der Route übernimmt
  if (!changedSince(module, sent, now)) {
    clearOutbound(module, sent.id);
    return;
  }
  const def = moduleDef(module);
  db.get().prepare(
    `UPDATE ${def.table} SET outbound_dirty = 1, outbound_attempts = 0 WHERE id = ?`
  ).run(sent.id);
}

// --------------------------------------------------------
// Vormerkung: Anlegen (#695)
// --------------------------------------------------------

/** Art eines Eintrags im UID-Namensraum (`server/utils/own-uid.js`). */
function uidKind(module) {
  return module === 'shopping' ? 'item' : 'task';
}

/**
 * UID einer in Yuvomi entstandenen Aufgabe oder eines Einkaufsartikels.
 *
 * Aus der Zeilen-Id UND der Kennung dieser Installation abgeleitet, nicht
 * zufällig je Versuch: die UID einer Zeile ist immer dieselbe. Kam ein PUT auf
 * dem Server an, seine Antwort aber nicht hier, trifft der nächste Versuch
 * deshalb auf das eigene Objekt - der Server meldet 412, und `uploadNewTodo`
 * übernimmt es, statt ein zweites anzulegen. Die Installationskennung macht
 * dieses 412 eindeutig: ohne sie konnte an der Adresse auch der Eintrag einer
 * anderen Installation mit derselben Zeilen-Id liegen.
 *
 * Schon gespiegelte Zeilen behalten ihre UID nach dem alten Muster
 * (`yuvomi-task-<id>@yuvomi.local`); umbenannt wird nichts.
 */
export function todoUidFor(module, id) {
  return ownUid(uidKind(module), id, db.get());
}

/**
 * Macht eine lokale Zeile zum Spiegel ihres eigenen, schon auf dem Server
 * liegenden Uploads - der Inbound-Weg der Übernahme. Der Abruf sieht ein Objekt
 * mit der UID dieser Installation, dessen Zeile noch lokal ist: der PUT kam an,
 * die Antwort nicht. Ohne das legte der Abruf eine ZWEITE Zeile an.
 *
 * DIE UID KOMMT VOM SERVER UND IST KEIN AUSWEIS. Die Installationskennung
 * steht in jeder UID auf jedem Server, mit dem je synchronisiert wurde; wer
 * auf eine Collection schreiben darf, kann ein Objekt mit einer UID im Muster
 * dieser Installation und einer beliebigen Zeilen-Id hinlegen. Übernähme der
 * Abruf daraufhin einfach "die lokale Zeile mit dieser Id", würde eine fremde
 * Zeile - die private Aufgabe eines anderen Mitglieds, eine ohne jedes Ziel,
 * eine für ein anderes Konto - an dieses Konto gebunden, als geändert
 * vorgemerkt, und ihr Inhalt ginge mit dem nächsten Outbound auf diesen Server.
 *
 * Die UID benennt deshalb nur, WELCHE Zeile gemeint sein könnte. Ob sie
 * übernommen wird, entscheidet allein der lokale Stand: die Zeile muss genau
 * JETZT auf ihren Upload in genau DIESE Liste dieses Kontos warten - dieselbe
 * Auswahl, aus der der Upload selbst seine Zeilen nimmt (`pendingCreations`,
 * `pendingShoppingCreations`). Dann erfährt der Server nichts, was er nicht
 * ohnehin im selben Lauf per PUT bekäme. Alles andere bleibt ein gewöhnlicher
 * Import als neue Zeile; eine bestehende wird nicht angefasst.
 *
 * Endzustand wie nach dem 412 in `uploadNewTodo`: gespiegelt und als geändert
 * vorgemerkt, damit der lokale Stand hinaufgeht - über den Inhalt auf dem
 * Server wird nicht geraten, und er überschreibt hier nichts (Sichtbarkeit,
 * Zuweisung und alle Felder bleiben die lokalen).
 *
 * @param {string} module
 * @param {string} uid          UID aus dem Serverobjekt
 * @param {number} accountId    Konto, dessen Liste gerade abgerufen wird
 * @param {string} objectUrl    Adresse des Objekts laut Server
 * @param {{listUrl: string, targetListId?: number|null}} where
 *        die Liste, in der das Objekt liegt, und (Einkauf) die ihr zugeordnete
 *        Yuvomi-Liste
 * @returns {boolean} true, wenn eine Zeile übernommen wurde
 */
export function adoptOwnUpload(module, uid, accountId, objectUrl, { listUrl, targetListId = null } = {}) {
  const def = moduleDef(module);
  const rowId = ownUploadRowId(uid, uidKind(module), db.get());
  if (!rowId || !objectUrl || !listUrl) return false;
  // Exakt die UID, die wir für diese Zeile erzeugen würden.
  if (uid !== todoUidFor(module, rowId)) return false;
  // Das Objekt liegt in der Liste, die gerade abgerufen wird - nicht an einer
  // Adresse, die der Server frei gewählt hat.
  if (!sameCollection(collectionUrlOf(objectUrl) || '', listUrl)) return false;

  const waitingHere = module === 'shopping'
    ? !!targetListId && pendingShoppingCreations(targetListId, accountId).some((row) => row.id === rowId)
    : pendingCreations(accountId, module).some(
      (row) => row.id === rowId && sameCollection(row.target_caldav_list_url, listUrl)
    );
  if (!waitingHere) return false;

  // Das Ziel einer Aufgabe fällt im selben Schreibvorgang (wie `bookTodoUpload`).
  const adopted = db.get().prepare(`
    UPDATE ${def.table}
       SET external_source     = 'caldav',
           external_uid        = ?,
           external_account_id = ?,
           external_object_url = ?,${module === 'tasks' ? `
           target_caldav_account_id = NULL,
           target_caldav_list_url   = NULL,` : ''}
           outbound_dirty      = 1,
           outbound_attempts   = 0,
           -- Der Abruf hat das Objekt gerade gefunden (#1839).
           seen_on_server      = 1
     WHERE id = ? AND external_source = 'local'
  `).run(uid, accountId, objectUrl, rowId).changes > 0;
  if (adopted) {
    keepOwnUpload(module, uid, objectUrl);
    // Übernommen ist gebucht: die Notiz des Uploads fällt (#1882).
    settleUploadAttempt({ source: 'caldav', accountId, kind: uidKind(module), rowId, collectionUrl: listUrl });
    log.info(`Adopted the earlier upload of ${def.table} row ${rowId} (${uid}).`);
  }
  return adopted;
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
export function pendingCreations(accountId, module = 'tasks', id = null) {
  const def = moduleDef(module);
  if (module !== 'tasks') return [];
  // Mit `id` dieselbe Frage für EINE Zeile: die Upload-Schleife stellt sie
  // frisch, wenn die Zeile an der Reihe ist (#1881) - durch dieselbe Auswahl.
  return withoutOwnRemoval(module, accountId, db.get().prepare(`
    SELECT * FROM ${def.table}
     WHERE external_source          = 'local'
       AND target_caldav_account_id = ?
       AND target_caldav_list_url IS NOT NULL
       AND parent_task_id IS NULL
       AND (? IS NULL OR id = ?)
     ORDER BY id
  `).all(accountId, id, id));
}

/**
 * Nimmt die Zeilen heraus, deren EIGENES Objekt in diesem Konto noch entfernt
 * werden soll (#1881).
 *
 * Das gibt es, seit ein Zielwechsel während des Uploads das gerade angelegte
 * Objekt zum Löschen vormerkt und die Zeile lokal lässt: Zeile und Auftrag
 * tragen dann dieselbe UID. Ginge die Zeile in der Zeit wieder hinauf, träfe
 * sie in derselben Liste auf genau dieses Objekt, übernähme es (412), und der
 * wartende Auftrag nähme es ihr danach weg; in einer anderen Liste des Kontos
 * stünde die UID zweimal, und der Auftrag kennt keine Liste, nur das Konto
 * (der Abruf verdeckt die UID kontoweit). Also erst fort, dann neu: der
 * Auftrag läuft in jedem Durchgang VOR den Uploads, im Regelfall wartet die
 * Zeile keinen Lauf. Gibt der Auftrag auf, ist sie wieder frei.
 */
function withoutOwnRemoval(module, accountId, rows) {
  if (!rows.length) return rows;
  const removing = pendingDeletionUids(accountId, module);
  if (!removing.size) return rows;
  return rows.filter((row) => !removing.has(todoUidFor(module, row.id)));
}

/** Zwei Schreibweisen derselben Collection-URL: mit und ohne Schlussstrich. */
function sameCollection(a, b) {
  return String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');
}

/**
 * Das Ziel, das die Folgeinstanz einer Serie von ihrer Vorgängerin erbt (#1515),
 * oder null.
 *
 * Eine hier angelegte Aufgabe trägt ihr Ziel nur bis zum Upload in den
 * Zielspalten - processPendingCreations räumt sie danach ab, und ab da steht die
 * Liste nur noch in der Objekt-URL des Spiegels. Das ist der Regelfall, denn der
 * Sofortversuch läuft direkt nach dem Anlegen. Wer nur die Zielspalten
 * weitergäbe, deckte also bloß den Fall ab, dass die Serie abgehakt wird, bevor
 * sie oben ist; die Folgeinstanz einer hochgeladenen Serie bliebe lokal.
 *
 * Einen Spiegel zählt nur mit, wer hier entstanden ist: seine UID ist eine aus
 * dem eigenen Namensraum für genau diese Zeile (altes oder neues Muster). Ein vom Server geholter Eintrag bleibt, wie er war - seine Liste
 * gehört einem anderen Programm, und Yuvomi hat nie zugesagt, dort Einträge
 * anzulegen.
 *
 * Geprüft wird gegen die Auswahltabelle wie beim Anlegen (resolveTaskSyncTarget):
 * ist die Liste inzwischen abgewählt oder das Konto weg, bleibt die
 * Folgeinstanz lokal - derselbe Ausgang, den processPendingCreations einer
 * wartenden Aufgabe mit verschwundener Liste gibt.
 *
 * @returns {{accountId: number, listUrl: string}|null}
 */
export function recurrenceFollowupTarget(task) {
  if (!task || task.parent_task_id) return null;
  let accountId = null;
  let listUrl   = null;
  if (task.external_source === 'local') {
    accountId = task.target_caldav_account_id;
    listUrl   = task.target_caldav_list_url;
  } else if (isMirrored(task) && isOwnUidOfRow(task.external_uid, 'task', task.id)) {
    accountId = task.external_account_id;
    listUrl   = collectionUrlOf(task.external_object_url);
  }
  if (!accountId || !listUrl) return null;

  // Die Schreibweise der Auswahltabelle zurückgeben, nicht die abgeleitete:
  // taskListsOf schlägt die Liste später genau unter diesem Schlüssel nach.
  const selected = db.get().prepare(`
    SELECT list_url FROM caldav_reminder_selection
     WHERE account_id = ? AND enabled = 1 AND target_module = 'tasks'
  `).all(accountId).map((r) => r.list_url);
  const match = selected.find((url) => sameCollection(url, listUrl));
  return match ? { accountId, listUrl: match } : null;
}

/**
 * Einkaufsartikel einer gespiegelten Liste, die es auf dem Server noch nicht gibt.
 *
 * `external_source = 'local'` ist der Spalten-Default, trennt also genau die
 * hier angelegten Artikel von den vom Server geholten Spiegeln.
 *
 * @param {number} listId
 * @param {number|null} [accountId] das Konto, das hochladen würde
 */
/**
 * Wie viele Einträge warten auf ihren Upload in diese Liste (#1840)? Für eine
 * Aufgabenliste die Aufgaben mit ihr als Ziel, für eine Einkaufszuordnung die
 * lokalen Artikel der zugeordneten Liste. Die Einstellungen nennen die Zahl
 * neben einer Liste, die keine neuen Einträge annimmt.
 */
export function countWaitingTodoUploads(accountId, listUrl) {
  const sel = db.get().prepare(`
    SELECT target_module, target_list_id, enabled FROM caldav_reminder_selection
     WHERE account_id = ? AND list_url = ?
  `).get(accountId, listUrl);
  if (!sel) return 0;
  if (sel.target_module === 'shopping') {
    if (!sel.enabled || !sel.target_list_id) return 0;
    return db.get().prepare(`
      SELECT COUNT(*) AS n FROM shopping_items WHERE external_source = 'local' AND list_id = ?
    `).get(sel.target_list_id).n;
  }
  return db.get().prepare(`
    SELECT COUNT(*) AS n FROM tasks
     WHERE external_source = 'local' AND target_caldav_account_id = ?
       AND target_caldav_list_url = ? AND parent_task_id IS NULL
  `).get(accountId, listUrl).n;
}

export function pendingShoppingCreations(listId, accountId = null) {
  const rows = db.get().prepare(`
    SELECT * FROM shopping_items
     WHERE external_source = 'local'
       AND list_id         = ?
     ORDER BY id
  `).all(listId);
  // Mit Konto: ohne die Artikel, deren eigenes Objekt dort noch entfernt
  // werden soll (`withoutOwnRemoval`). Wer nur zählt, ob überhaupt etwas
  // wartet, fragt ohne.
  return accountId == null ? rows : withoutOwnRemoval('shopping', accountId, rows);
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

/**
 * Ein unerreichbares Ziel abräumen - genau das Ziel, das `task` trägt (#1881).
 * Steht an der Zeile inzwischen ein anderes, bleibt es: der Aufrufer hat über
 * das gelesene geurteilt, nicht über das, was danach gewählt wurde. Nach einem
 * geglückten Upload räumt die Buchung selbst ab (`bookTodoUpload`).
 */
function clearCreationTarget(task) {
  db.get().prepare(`
    UPDATE tasks SET target_caldav_account_id = NULL, target_caldav_list_url = NULL
     WHERE id = ? AND target_caldav_account_id IS ? AND target_caldav_list_url IS ?
  `).run(task.id, task.target_caldav_account_id ?? null, task.target_caldav_list_url ?? null);
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
 * @returns {Promise<'mirrored'|'deleted'|'released'|'unchanged'|null>} wie
 *   `bookTodoUpload`; null, wenn sich kein VTODO bauen ließ
 */
async function uploadNewTodo(client, collection, module, row, accountId) {
  const def = moduleDef(module);
  const uid = todoUidFor(module, row.id);
  const ics = buildTodoICS(module, row, uid);
  if (!ics) return null;

  const objectUrl = `${String(collection.url).replace(/\/?$/, '/')}${uid}.ics`;
  // VOR der Anfrage notiert (#1882, `caldav-upload-attempts.js`): geht die
  // Antwort verloren, belegt die Notiz, dass von dieser Zeile etwas an diesem
  // Platz liegen kann. Sie fällt mit der Buchung unten. Synchron, unmittelbar
  // vor der Anfrage.
  const place = { source: 'caldav', accountId, kind: uidKind(module), rowId: row.id, collectionUrl: collection.url };
  noteUploadAttempt({ ...place, uid, objectUrl });
  // Der Name ist vergeben (412) und das Objekt trägt unsere UID: ein früherer
  // PUT kam an, seine Antwort nicht. Übernehmen und den lokalen Stand als
  // Änderung vormerken, statt zu raten, was dort liegt.
  let adopted = false;
  try {
    await client.createCalendarObject({
      calendar:   collection,
      filename:   `${uid}.ics`,
      iCalString: ics,
    });
  } catch (err) {
    if (err?.status !== 412) throw err;
    // Die UID wird im Objekt GELESEN, nicht aus dem Dateinamen geschlossen;
    // liegt dort etwas anderes, bleibt es unangetastet und die Zeile lokal.
    // Gemerkt wird die eigene, berechnete Adresse, nicht eine vom Server genannte.
    if (!(await findObjectWithUid(client, collection.url, objectUrl, uid))) throw err;
    adopted = true;
    log.info(`${def.table} row ${row.id} is already on the server as ${uid}, adopting it.`);
  }

  return bookTodoUpload(module, row, { uid, objectUrl, accountId, collectionUrl: collection.url, adopted });
}

/**
 * Wartet diese Zeile JETZT auf ihren Upload in genau diese Liste dieses Kontos
 * (#1881)? Dieselbe Frage, die die Upload-Schleifen vor der Anfrage stellen,
 * hier NACH ihr gestellt.
 *
 * Eine Aufgabe trägt ihr Ziel selbst. Ein Einkaufsartikel erbt es von der
 * Zuordnung seiner Yuvomi-Liste (`shoppingSelectionsOf`): er wartet hier,
 * solange die Liste, in der er JETZT liegt, dieser Server-Liste zugeordnet ist.
 */
function waitsForUploadHere(module, now, accountId, collectionUrl) {
  if (module === 'shopping') {
    return shoppingSelectionsOf(accountId).some(
      (sel) => sel.targetListId === now.list_id && sameCollection(sel.listUrl, collectionUrl)
    );
  }
  return now.target_caldav_account_id === accountId
    && !!now.target_caldav_list_url
    && sameCollection(now.target_caldav_list_url, collectionUrl)
    && !now.parent_task_id;
}

/**
 * Bucht das Ergebnis eines Uploads - gegen den Stand von JETZT (#1862, #1881):
 * zwischen `sent` und hier lag die Anfrage, und in der Zeit lief die App
 * weiter.
 *
 *   - Die Zeile ist weg: für eine lokale Zeile merkt die Löschroute nichts
 *     vor, das Objekt läge also für immer oben, und der nächste Abruf holte
 *     den gelöschten Eintrag als neue Zeile zurück. Das gerade angelegte
 *     Objekt wird zum Löschen vorgemerkt.
 *   - Die Zeile ist nicht mehr lokal: nichts wird überschrieben.
 *   - Die Zeile wartet nicht mehr auf DIESEN Upload (`waitsForUploadHere`):
 *     ihr Ziel wurde gewechselt oder zurückgenommen, der Artikel liegt in
 *     einer anderen Liste. Einen Umzug zwischen Listen gibt es bewusst nicht -
 *     das gerade angelegte Objekt wird zum Löschen vorgemerkt, die Zeile
 *     bleibt lokal und behält, was jetzt an ihr steht. Hat sie ein neues Ziel,
 *     geht sie dorthin, sobald das alte Objekt fort ist (`withoutOwnRemoval`).
 *   - Die Zeile wurde bearbeitet: oben liegt der Stand davor. Sie wird Spiegel
 *     UND als geändert vorgemerkt, sonst überschriebe der nächste Abruf die
 *     Bearbeitung mit dem alten Stand.
 *
 * Das Ziel einer Aufgabe fällt IM SELBEN Schreibvorgang, der sie zum Spiegel
 * macht, und nur dort. Vorher räumte es der Aufrufer nach jedem geglückten
 * Upload ab - auch das Ziel, das während der Anfrage gerade erst gewählt
 * worden war.
 *
 * Synchron: zwischen dem Nachladen und dem Schreiben liegt kein await, und
 * jeder Ausgang ist EIN Schreibvorgang.
 *
 * Mit jeder Buchung fällt die Notiz des Uploads (#1882). Bei `unchanged`
 * bleibt sie stehen - über das Objekt wurde nichts entschieden, das tut
 * `releaseLeftoverTodoUploads` am Stand der Zeile.
 *
 * @returns {'mirrored'|'deleted'|'released'|'unchanged'}
 */
function bookTodoUpload(module, sent, { uid, objectUrl, accountId, collectionUrl, adopted = false }) {
  const def = moduleDef(module);
  const booked = () => settleUploadAttempt({
    source: 'caldav', accountId, kind: uidKind(module), rowId: sent.id, collectionUrl,
  });
  const queueRemoval = () => {
    db.get().prepare(`
      INSERT INTO caldav_todo_pending_deletions (account_id, module, uid, object_url)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, module, uid)
        DO UPDATE SET object_url = COALESCE(excluded.object_url, object_url)
    `).run(accountId, module, uid, objectUrl);
    booked();
  };

  const now = reloadRow(module, sent.id);
  if (!now) {
    queueRemoval();
    log.info(`${def.table} row ${sent.id} was deleted while its upload was in flight, queued the deletion of ${uid}.`);
    return 'deleted';
  }
  if (now.external_source !== 'local') return 'unchanged';
  if (!waitsForUploadHere(module, now, accountId, collectionUrl)) {
    queueRemoval();
    log.info(`The target of ${def.table} row ${sent.id} was changed while its upload was in flight, queued the deletion of ${uid}.`);
    return 'released';
  }
  const edited = changedSince(module, sent, now);

  const mirrored = db.get().prepare(`
    UPDATE ${def.table}
       SET external_source     = 'caldav',
           external_uid        = ?,
           external_account_id = ?,
           external_object_url = ?,${module === 'tasks' ? `
           target_caldav_account_id = NULL,
           target_caldav_list_url   = NULL,` : ''}
           outbound_dirty      = ?,
           outbound_attempts   = 0,
           -- Ein Upload belegt nichts (#1839): gesehen setzt nur der Abruf.
           seen_on_server      = 0
     WHERE id = ? AND external_source = 'local'
  `).run(uid, accountId, objectUrl, adopted || edited ? 1 : 0, sent.id).changes > 0;
  if (!mirrored) return 'unchanged';
  keepOwnUpload(module, uid, objectUrl);
  booked();
  return 'mirrored';
}

// --------------------------------------------------------
// Der Upload, dessen Antwort nie ankam (#1882)
// --------------------------------------------------------

/**
 * Führt diese Liste des Kontos noch Einträge dieses Moduls? Nein nur, wenn
 * die Auswahl sie inzwischen dem ANDEREN Modul zuordnet (von "Aufgaben" auf
 * "Einkauf" umgestellt): eine Aufgabe trägt ihr Ziel als Konto und Adresse,
 * und beides stimmt dann weiter, obwohl dort keine Aufgabe mehr hingehört.
 * Abgeschaltet oder aus der Auswahl verschwunden zählt nicht als "nein".
 */
function listStillServes(module, accountId, listUrl) {
  const selected = db.get().prepare(
    'SELECT list_url, target_module FROM caldav_reminder_selection WHERE account_id = ?'
  ).all(accountId).filter((sel) => sameCollection(sel.list_url, listUrl));
  return !selected.length
    || selected.some((sel) => (sel.target_module === 'shopping' ? 'shopping' : 'tasks') === module);
}

/**
 * Wie steht die Zeile JETZT zu dem Objekt, das ein nie gebuchter Upload an
 * diesem Platz hinterlassen haben kann? Dieselben drei Antworten wie bei den
 * Terminen (`uploadAttemptState` in calendar-outbound.js):
 *
 *   waiting  - lokal, und sie gehört weiter genau dorthin;
 *   mirrored - Spiegel an genau diesem Platz: das Objekt ist ihres;
 *   leftover - gelöscht, anderes oder kein Ziel, woanders Spiegel.
 *
 * Auch die Mitnahme eines umgezogenen Einkaufsartikels (#1700) schreibt hier
 * mit: die Ablage am neuen Platz ist ein Versuch wie jeder Upload, und nach
 * der Buchung steht für den ALTEN Platz eine Notiz - die Zeile ist dann
 * woanders Spiegel, das Objekt dort also ein Rest. Ein Objekt, das an einem
 * Platz liegt, an den die Mitnahme erst noch gehen soll, ist ebenfalls ein
 * Rest (die Zeile ist Spiegel am alten Platz): es wird entfernt, und die
 * Mitnahme legt das heutige Original neu ab.
 */
function todoAttemptState(module, attempt) {
  const def = moduleDef(module);
  const now = db.get().prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(attempt.row_id);
  if (!now) return 'leftover';
  if (now.external_source === 'local') {
    return waitsForUploadHere(module, now, attempt.account_id, attempt.collection_url)
      && listStillServes(module, attempt.account_id, attempt.collection_url) ? 'waiting' : 'leftover';
  }
  if (now.external_source === 'caldav' && now.external_uid === attempt.uid
      && sameCollection(collectionUrlOf(now.external_object_url) || '', attempt.collection_url)) {
    return 'mirrored';
  }
  return 'leftover';
}

/**
 * Für den Abruf: liegt für das Objekt mit dieser UID in dieser Liste eine
 * Notiz vor, deren Upload nie gebucht wurde und die NICHT schon aufgegangen
 * ist (die Zeile ist nicht Spiegel an diesem Platz)? Dann darf der Aufrufer
 * es nur noch ÜBERNEHMEN (`adoptOwnUpload`, vorher) - sonst weder importieren
 * noch einer Zeile zuordnen. Entfernt wird es von
 * `releaseLeftoverTodoUploads`, für das Konto, dem die Notiz gehört.
 *
 * Über ALLE Konten gefragt: führen zwei Konten dieselbe Liste, sieht der Abruf
 * des einen das Objekt, das über das andere hinaufging.
 *
 * Der Beleg ist die lokale Notiz, nicht die UID. Frisch je Objekt gefragt: die
 * Zeile kann fallen, während der Lauf noch den Server liest.
 */
export function isUnbookedOwnUpload(module, uid, listUrl) {
  // Billig zuerst: das Muster der UID, ohne Datenbank. Die ART kommt aus der
  // UID, nicht aus dem Modul, das die Liste gerade führt: wird eine Liste von
  // "Aufgaben" auf "Einkauf" umgestellt, liegt dort der Rest einer Aufgabe,
  // und der Abruf läse ihn sonst als Einkaufsartikel. `module` sagt nur noch,
  // wer fragt.
  //
  // Jede andere UID kann die eines MITGENOMMENEN Einkaufsartikels sein (#1700):
  // er behält die UID, die sein Objekt schon trug. Notizen der Art `item` zu
  // einer solchen UID schreibt nur die Mitnahme.
  // Das gilt auch für eine UID im Muster einer AUFGABE: ein Artikel trägt sie,
  // wenn seine Liste von "Aufgaben" auf "Einkauf" umgestellt wurde. Gefragt
  // wird deshalb immer auch nach Notizen der Art `item`; jede Notiz wird an
  // der Zeile IHRER Art gemessen.
  const parsed = parseOwnUid(uid);
  const own = !!parsed && ['task', 'item'].includes(parsed.kind) && parsed.installation !== null;
  const kinds = own && parsed.kind === 'task' ? ['task', 'item'] : ['item'];
  moduleDef(module);
  let attempts;
  try {
    attempts = kinds.flatMap((kind) => uploadAttemptsAt({ source: 'caldav', kind, uid, collectionUrl: listUrl }));
  } catch (err) {
    log.warn(`Upload notes are not readable (${err.message}); treating them as none.`);
    return false;
  }
  return attempts.some(
    (attempt) => todoAttemptState(attempt.kind === 'item' ? 'shopping' : 'tasks', attempt) !== 'mirrored'
  );
}

/**
 * Für den Abruf, der einen Rest überspringt: hängt an dem Objekt mit dieser
 * UID in dieser Liste noch ein Einkaufsartikel, der anderswo Spiegel
 * DERSELBEN UID ist?
 *
 * Ein übersprungener Rest zählt sonst nicht als "der Server liefert den
 * Eintrag noch" (#1905). Für diesen einen Fall gilt die ältere Regel der
 * Mitnahme (#1700, `confirmCarriedCopy`): fehlt die Kopie am Platz der Zeile,
 * ist das Objekt hier das letzte, und die Zeile geht zu ihm zurück. Das
 * entscheidet `releaseLeftoverTodoUploads` NACH dem Prune desselben Laufs -
 * der Prune darf die Zeile deshalb nicht vorher abräumen.
 *
 * Dieselbe Frage wie dort an die Zeile, aus dem Stand von jetzt; Notizen der
 * Art `task` zählen nie.
 */
export function leftoverHoldsCarriedItem(uid, listUrl) {
  let attempts;
  try {
    attempts = uploadAttemptsAt({ source: 'caldav', kind: 'item', uid, collectionUrl: listUrl });
  } catch (err) {
    log.warn(`Upload notes are not readable (${err.message}); treating them as none.`);
    return false;
  }
  return attempts.some((attempt) => {
    const row = reloadRow('shopping', attempt.row_id);
    return !!row && row.external_source === 'caldav' && row.external_uid === attempt.uid;
  });
}

/**
 * Entfernt die Reste von Aufgaben- und Einkaufs-Uploads, deren Antwort nie
 * ankam (#1882): die Notizen des Kontos, deren Zeile dort nicht mehr
 * hingehört (`todoAttemptState`). Was dabei gelesen, gelöscht oder stehen
 * gelassen wird, steht an `removeLeftoverUploads`.
 *
 * In jedem Lauf, und im Sofortversuch für jedes Konto, das er ohnehin
 * anfasst, VOR den Uploads: hat die Zeile inzwischen ein anderes Ziel in
 * diesem Konto, ist ihr Rest im Regelfall fort, bevor sie neu hinaufgeht. Und
 * die Regel hängt so an keiner Löschroute.
 *
 * Nur in Listen, die für das Konto eingeschaltet sind. Ein Einkaufsartikel
 * einer abgeschalteten Zuordnung gilt zwar als Rest (er wartet dort nicht),
 * bleibt damit aber unberührt; wird sie wieder eingeschaltet, wartet er
 * wieder, und der Lauf übernimmt das Objekt.
 *
 * DER REST EINER MITNAHME FÄLLT NUR, WENN DIE KOPIE BELEGT IST (#1700). Nach
 * einem Umzug steht für den alten Platz eine Notiz, und die Zeile zeigt auf
 * den neuen. Hat eine andere App die Kopie dort inzwischen gelöscht, wäre das
 * Objekt am alten Platz das letzte - es zu entfernen, nur weil die Zeile
 * woanders hinzeigt, nähme den Eintrag ganz fort, und der Prune danach die
 * Zeile. Vor dem DELETE wird deshalb der Platz GELESEN, auf den die Zeile
 * zeigt (`confirmCarriedCopy`); aus der Zeile geschlossen wird nichts.
 *
 * @param {object} client
 * @param {number} accountId
 * @param {{clientFor?: (accountId: number) => Promise<object|null>, stop?: object}} [opts]
 *        Client eines anderen Kontos - die Kopie kann dort liegen; Stoppsignal
 *        des Durchgangs (#2135)
 * @returns {Promise<number>} entfernte Objekte
 */
export function releaseLeftoverTodoUploads(client, accountId, { clientFor = null, stop = null } = {}) {
  // Nur in Listen, die für dieses Konto eingeschaltet sind.
  const enabled = db.get().prepare(
    'SELECT list_url FROM caldav_reminder_selection WHERE account_id = ? AND enabled = 1'
  ).all(accountId).map((r) => r.list_url);
  return removeLeftoverUploads(client, {
    source: 'caldav', accountId, kinds: ['task', 'item'], stop,
    stateOf: (attempt) => todoAttemptState(attempt.kind === 'item' ? 'shopping' : 'tasks', attempt),
    inScope: (url) => enabled.some((known) => sameCollection(known, url)),
    beforeRemove: (attempt) => confirmCarriedCopy(attempt, client, accountId, clientFor),
    // Die Zeile ist anderswo Spiegel DERSELBEN UID (nach einer Mitnahme, #1700,
    // oder einem Upload, der seinem Ziel gefolgt ist): der Rest liegt dann
    // unter einer UID, die der Abruf dieser Zeile zuordnet. Fiele die Notiz
    // nach der Frist, obwohl der Server das Entfernen weiter ablehnt, läse der
    // Abruf zwei Objekte für eine Zeile - sie wechselte mit jedem Lauf die
    // Liste, über zwei Konten entstünde ein zweiter Artikel. Die Notiz bleibt,
    // bis das Objekt fort ist oder nachweislich ein anderes.
    keepWhileRefused: (attempt) => {
      const def = moduleDef(attempt.kind === 'item' ? 'shopping' : 'tasks');
      const now = db.get().prepare(
        `SELECT external_source, external_uid FROM ${def.table} WHERE id = ?`
      ).get(attempt.row_id);
      return !!now && now.external_source === 'caldav' && now.external_uid === attempt.uid;
    },
    label: 'CalDAV-Todo',
  });
}

/**
 * Darf der Rest an der Adresse dieser Notiz entfernt werden? Gefragt für einen
 * Einkaufsartikel, der anderswo Spiegel DERSELBEN UID ist - der alte Platz
 * nach einer Mitnahme (#1700). Für alles andere gilt die Regel der Notizen
 * unverändert (`true`): die Zeile ist gelöscht oder lokal, der Rest ist ein
 * nie gebuchter Upload.
 *
 *   - Am Platz der Zeile liegt das Objekt mit ihrer UID (gerade gelesen):
 *     der Rest darf fort.
 *   - Dort liegt es NICHT: das Objekt an der Adresse der Notiz ist das, was
 *     der Server von diesem Eintrag noch führt. Es bleibt, die Zeile zeigt
 *     wieder darauf (Konto und Adresse der Notiz), die Notiz fällt, und der
 *     nächste Abruf stellt die Zeile auf die Liste dieser Server-Liste. Der
 *     Eintrag bleibt, wo der Server ihn führt.
 *   - Der Platz der Zeile ist nicht lesbar (Fehler, kein Client für das
 *     andere Konto): nichts wird entfernt, nichts umgeschrieben. Ein Fehler
 *     geht hoch; es gibt keinen Ersatzwert, der "liegt dort" behauptet.
 *
 * Nach dem Lesen wird die Zeile neu gelesen und in einem synchronen Schritt
 * geschrieben.
 */
async function confirmCarriedCopy(attempt, client, accountId, clientFor) {
  if (attempt.kind !== 'item') return true;
  const mirrorElsewhere = (row) => !!row && row.external_source === 'caldav'
    && row.external_uid === attempt.uid && !!row.external_object_url && !!row.external_account_id;
  const row = reloadRow('shopping', attempt.row_id);
  if (!mirrorElsewhere(row)) return true;

  const place = collectionUrlOf(row.external_object_url);
  const other = row.external_account_id === accountId
    ? client
    : (clientFor ? await clientFor(row.external_account_id) : null);
  if (!place || !other) return false;
  const copy = await inspectObjectAt(other, place, row.external_object_url, row.external_uid);
  if (copy.own) return true;

  return db.get().transaction(() => {
    const now = reloadRow('shopping', attempt.row_id);
    if (!mirrorElsewhere(now) || now.external_object_url !== row.external_object_url
        || now.external_account_id !== row.external_account_id) return false;
    db.get().prepare(
      'UPDATE shopping_items SET external_account_id = ?, external_object_url = ? WHERE id = ?'
    ).run(attempt.account_id, attempt.object_url, now.id);
    settleUploadAttempt({
      source: 'caldav', accountId: attempt.account_id, kind: 'item', rowId: now.id, collectionUrl: attempt.collection_url,
    });
    log.warn(
      `Shopping item ${now.id} was carried to ${place}, but its entry is no longer there; `
      + `the one at ${attempt.object_url} is kept and the item follows it.`
    );
    return false;
  })();
}

/**
 * Das Objekt eines eigenen Uploads an dieser Adresse ist ab jetzt gewollt
 * (#1881): Löschaufträge für genau diese UID an genau dieser Adresse fallen,
 * über alle Konten.
 *
 * Im selben Konto kommt es dazu nicht (`withoutOwnRemoval` lässt die Zeile
 * warten). Führen aber zwei Konten dieselbe Liste und wechselt das Ziel
 * während des Uploads von A auf B, trifft der Upload über B auf das Objekt von
 * eben, übernimmt es - und der Auftrag von A löschte es ihm sonst weg. Die UID
 * ist die dieser Installation für diese eine Zeile; ein Auftrag für sie stammt
 * immer aus einem früheren Upload derselben Zeile.
 */
function keepOwnUpload(module, uid, objectUrl) {
  // Die Liste entscheidet, nicht die Schreibweise der Adresse: der Abruf nennt
  // sie, wie der Server sie schreibt (`@` als `%40`), der Auftrag trägt die
  // selbst berechnete.
  const list = collectionUrlOf(objectUrl);
  if (!list) return;
  const waiting = db.get().prepare(
    'SELECT id, object_url FROM caldav_todo_pending_deletions WHERE module = ? AND uid = ?'
  ).all(module, uid);
  for (const row of waiting) {
    const theirs = collectionUrlOf(row.object_url);
    if (theirs && sameCollection(theirs, list)) dropDeletion(row.id);
  }
}

/** EINE Zeile je Liste, die in diesem Lauf abgelehnt hat - mit der Anzahl. */
/** EINE Zeile je nur lesbarer Liste, in die etwas wartet (#1840). */
function reportReadOnlyLists(readOnly, what) {
  for (const [listUrl, waiting] of readOnly) {
    log.warn(`Reminder list ${listUrl} is read-only for this account; `
      + `${waiting} ${what} stay local until it accepts new entries.`);
  }
}

function reportClosedLists(gate, what) {
  gate.report((listUrl, err, waiting) => log.warn(
    `Reminder list ${listUrl} is not accepting uploads (${err.message}); `
    + `${waiting} ${what} stay local and are tried again on the next run.`
  ));
}

/**
 * Legt wartende Aufgaben auf dem Server an und macht sie damit zu Spiegeln.
 *
 * @param {object} client       tsdav-Client
 * @param {number} accountId
 * @param {string} module
 * @param {Map}    listsByUrl   Listen-URL → Collection des Servers
 * @param {{stop?: object}} [opts]  Stoppsignal des Durchgangs (#2135)
 * @returns {Promise<number>} erfolgreich hochgeladene Einträge
 */
export async function processPendingCreations(client, accountId, module, listsByUrl, { stop = null } = {}) {
  const rows = pendingCreations(accountId, module);
  if (rows.length === 0) return 0;

  // Das Stoppsignal des Durchgangs (#2135): nach einer kontoweiten Absage einer
  // früheren Phase geht auch kein Upload mehr hinaus.
  const gate = createUploadGate(stop);
  const readOnly = new Map();
  let done = 0;
  for (const listed of rows) {
    // Frisch lesen, durch dieselbe Auswahl (#1881): die Liste stammt von vor
    // der Schleife, und jeder Upload davor war ein await. Wer inzwischen
    // gelöscht wurde oder nicht mehr auf den Upload über dieses Konto wartet,
    // geht nicht hinauf - und sein Ziel, das jetzt ein anderes sein kann,
    // wird hier weder gelesen noch abgeräumt.
    if (!pendingCreations(accountId, module, listed.id).length) continue;
    const fresh = reloadRow(module, listed.id);
    if (!fresh) continue;

    const collection = listsByUrl.get(fresh.target_caldav_list_url);
    if (!collection) {
      // Die Liste ist weg oder wurde abgewählt. Das Ziel stehen zu lassen hieße,
      // es bei jedem Lauf erneut zu versuchen; die Aufgabe bleibt lokal, was der
      // Zustand vor #695 war und keine Daten kostet.
      // Ausnahme (#1882): von dieser Aufgabe ging schon ein Upload in genau
      // diese Liste, und seine Antwort kam nie an. Ihr Objekt kann dort
      // liegen. Fiele jetzt ihr Ziel, gälte es als Rest und würde gelöscht -
      // abwählen heisst aber "nicht mehr abgleichen", nicht "auf dem Server
      // aufräumen". Das Ziel bleibt, die Notiz auch; ist die Liste wieder da,
      // übernimmt der Lauf das Objekt.
      // Gehört die Liste inzwischen dem anderen Modul, gilt die Notiz als
      // Rest (`todoAttemptState`), wird entfernt, und das Ziel fällt im
      // Durchgang danach.
      if (hasUploadAttempt({
        source: 'caldav', accountId, kind: uidKind(module), rowId: fresh.id,
        collectionUrl: fresh.target_caldav_list_url,
      })) {
        log.debug(`Reminder list ${fresh.target_caldav_list_url} is not available; task ${fresh.id} has an unconfirmed upload there and keeps its target.`);
        continue;
      }
      log.warn(`Reminder list ${fresh.target_caldav_list_url} is not available, keeping task ${fresh.id} local.`);
      clearCreationTarget(fresh);
      continue;
    }

    // Die Liste hat in diesem Lauf schon abgelehnt: nicht für jede wartende
    // Aufgabe dieselbe Absage abholen.
    if (gate.isClosed(collection.url)) continue;

    // Nimmt die Liste laut ihren Rechten keine neuen Einträge an (#1840),
    // geht keine Anfrage hinaus, und das Ziel bleibt stehen: die Aufgabe
    // wartet, die Einstellungen nennen sie neben der Liste.
    if (!acceptsNewEntries(collection)) {
      readOnly.set(collection.url, (readOnly.get(collection.url) || 0) + 1);
      continue;
    }

    try {
      // Das Ziel räumt die Buchung selbst ab, wenn die Aufgabe Spiegel wird
      // (`bookTodoUpload`) - nicht hier, nach dem await: dann stünde dort
      // womöglich schon das Ziel, das während der Anfrage gewählt wurde.
      const booked = await uploadNewTodo(client, collection, module, fresh, accountId);
      if (booked === 'mirrored') {
        done++;
      } else if (booked === null) {
        log.error(`Could not build a VTODO for task ${fresh.id}, keeping it local.`);
        clearCreationTarget(fresh);
      }
    } catch (err) {
      // Kein Zähler und kein Aufgeben: anders als eine Änderung hat ein Upload
      // keinen Stand, der veralten könnte. Er bleibt vorgemerkt und läuft im
      // nächsten Lauf mit, so lange bis er durchgeht oder das Ziel verschwindet.
      if (!gate.refused(collection.url, err)) {
        log.warn(`Could not upload task ${fresh.id} to ${fresh.target_caldav_list_url}: ${err.message}`);
      }
    }
  }
  reportReadOnlyLists(readOnly, 'task(s)');
  reportClosedLists(gate, 'task(s)');
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
 * @param {{stop?: object}} [opts]  Stoppsignal des Durchgangs (#2135)
 * @returns {Promise<number>} erfolgreich hochgeladene Artikel
 */
export async function processPendingShoppingCreations(client, accountId, targets, listsByUrl, { stop = null } = {}) {
  const gate = createUploadGate(stop);
  const readOnly = new Map();
  let done = 0;
  for (const { listUrl, targetListId } of targets) {
    if (!targetListId) continue;
    const collection = listsByUrl.get(listUrl);
    if (!collection) continue;
    // Nur lesbar (#1840): die Artikel bleiben lokal und warten, siehe oben.
    if (!acceptsNewEntries(collection)) {
      const waiting = pendingShoppingCreations(targetListId, accountId).length;
      if (waiting) readOnly.set(collection.url, waiting);
      continue;
    }

    for (const row of pendingShoppingCreations(targetListId, accountId)) {
      if (gate.isClosed(collection.url)) continue;
      const fresh = reloadRow('shopping', row.id);
      // Zwischenzeitlich gelöscht, schon gespiegelt oder in eine andere Liste
      // gewandert (#1881): dann wartet er nicht mehr auf den Upload HIERHER.
      if (!fresh || fresh.external_source !== 'local' || fresh.list_id !== targetListId) continue;

      try {
        const booked = await uploadNewTodo(client, collection, 'shopping', fresh, accountId);
        if (booked === 'mirrored') done++;
        else if (booked === null) log.error(`Could not build a VTODO for shopping item ${fresh.id}, keeping it local.`);
      } catch (err) {
        // Wie oben: bleibt lokal und läuft im nächsten Lauf wieder mit.
        if (!gate.refused(collection.url, err)) {
          log.warn(`Could not upload shopping item ${fresh.id} to ${listUrl}: ${err.message}`);
        }
      }
    }
  }
  reportReadOnlyLists(readOnly, 'shopping item(s)');
  reportClosedLists(gate, 'shopping item(s)');
  return done;
}

// --------------------------------------------------------
// Mitnahme: das Objekt folgt seinem Artikel auf die neue Liste (#1700)
// --------------------------------------------------------

/** Einkaufsartikel dieser Liste, deren Objekt noch nachgezogen werden soll. */
export function pendingShoppingMoves(listId) {
  return db.get().prepare(`
    SELECT * FROM shopping_items
     WHERE external_source = 'caldav' AND outbound_move = 1 AND list_id = ?
     ORDER BY id
  `).all(listId);
}

/** Konten, in deren (eingeschaltete) Liste ein Objekt mitgenommen werden soll. */
function accountsWithPendingShoppingMoves() {
  try {
    return db.get().prepare(`
      SELECT DISTINCT sel.account_id AS account_id
        FROM caldav_reminder_selection sel
        JOIN shopping_items i ON i.list_id = sel.target_list_id
       WHERE sel.enabled = 1
         AND sel.target_module = 'shopping'
         AND sel.target_list_id IS NOT NULL
         AND i.external_source = 'caldav'
         AND i.outbound_move = 1
    `).all().map((r) => r.account_id).filter(Boolean);
  } catch (err) {
    log.warn(`Pending shopping moves are not readable (${err.message}); treating them as none.`);
    return [];
  }
}

/**
 * Umzüge dieses Kontos, deren Zielliste GAR KEINER Server-Liste mehr
 * zugeordnet ist (das Konto des Ziels wurde entfernt, die Zuordnung gelöscht):
 * die Mitnahme hat kein Ziel mehr und wartete sonst für immer, mit einem
 * Objekt, das am alten Platz weiterlebt. Der Artikel steht auf einer Liste
 * ohne Spiegel - dafür gilt dieselbe Regel wie beim Umzug dorthin
 * (`releaseShoppingMirror`). Eine nur ABGEWÄHLTE Zuordnung zählt nicht: sie
 * kann wieder eingeschaltet werden, der Umzug wartet.
 *
 * Synchron, vor dem Abruf des Kontos: der Löschauftrag verdeckt das Objekt
 * dann schon in diesem Lauf.
 *
 * @returns {number} gelöste Zeilen
 */
export function releaseStrandedShoppingMoves(accountId) {
  const rows = db.get().prepare(`
    SELECT * FROM shopping_items
     WHERE external_source = 'caldav' AND external_account_id = ? AND outbound_move = 1
  `).all(accountId);
  let released = 0;
  for (const row of rows) {
    if (shoppingMappingsOf(row.list_id).length) continue;
    db.get().transaction(() => releaseShoppingMirror(row))();
    released++;
    log.info(`Shopping item ${row.id} was moved to a list that is no longer mirrored; its entry on the server is removed and the item stays in Yuvomi.`);
  }
  return released;
}

/**
 * Umzüge in Listen dieses Kontos, deren Server-Liste es NICHT MEHR GIBT: die
 * Auswahl des Kontos kennt sie, die Auflistung dieses Laufs nennt sie nicht.
 * Der Lauf schaltet eine solche Liste ab, und ein Umzug in eine abgeschaltete
 * wartet - ohne das hier für immer, mit einem Objekt, das am alten Platz
 * weiterlebt.
 *
 * Die Zeile geht auf die Liste ihres Objekts zurück (`returnShoppingMove`),
 * sie wird NICHT vom Server gelöst: dass es die Liste nicht mehr gibt, sagt
 * hier eine Auflistung des Servers, nicht der Nutzer, und ein Löschen am alten
 * Platz wäre nicht rückholbar. Hat die Zielliste noch eine andere Server-Liste,
 * die der Server nennt oder über die dieser Lauf nichts weiss (anderes Konto),
 * wartet der Umzug weiter.
 *
 * `listedUrls` ist die Auflistung DIESES Laufs und vom Aufrufer als nicht leer
 * befunden (wie `dropDeletionsOfMissingLists`).
 *
 * @returns {number} zurückgestellte Zeilen
 */
export function returnMovesIntoMissingLists(accountId, listedUrls) {
  const listed = [...(listedUrls || [])];
  if (listed.length === 0) return 0;
  const missing = (sel) => sel.account_id === accountId && !listed.some((url) => sameCollection(url, sel.list_url));
  const targets = db.get().prepare(`
    SELECT DISTINCT target_list_id FROM caldav_reminder_selection
     WHERE account_id = ? AND target_module = 'shopping' AND target_list_id IS NOT NULL
  `).all(accountId).map((r) => r.target_list_id);
  let returned = 0;
  for (const listId of targets) {
    const mappings = shoppingMappingsOf(listId);
    if (!mappings.length || !mappings.every(missing)) continue;
    for (const row of pendingShoppingMoves(listId)) {
      const back = returnShoppingMove(row, 'refused');
      returned++;
      log.warn(
        `The reminder list that shopping item "${row.name}" (${row.id}) was moved to no longer exists on the server. `
        + 'Its entry on the server was not touched'
        + (back ? `, and the item is back on the list it came from (${back}).` : '.')
      );
    }
  }
  return returned;
}

/**
 * UIDs der Artikel dieses Kontos, deren Umzug wartet und deren Objekt in einer
 * Liste liegt, die dieser Lauf NICHT abgerufen hat (die Quelle ist abgewählt).
 * Für den Prune gelten sie als gesehen: er räumt ab, was der Server nicht mehr
 * führt, und über eine nicht gelesene Liste weiss der Lauf das nicht. Ohne das
 * nähme er die Zeile fort, sobald er eine ANDERE Liste des Kontos liest - der
 * Artikel steht ja auf einer eingeschalteten -, und mit ihr alles, was nur
 * hier steht. Liegt das Objekt in einer abgerufenen Liste und fehlte dort,
 * ist es wirklich fort: dann nennt diese Funktion es nicht.
 *
 * @param {string[]} fetchedListUrls  die Listen, die der Lauf gelesen hat
 */
export function uidsOfMovesFromUnfetchedLists(accountId, fetchedListUrls) {
  const fetched = [...(fetchedListUrls || [])];
  return db.get().prepare(`
    SELECT external_uid, external_object_url FROM shopping_items
     WHERE external_source = 'caldav' AND external_account_id = ? AND outbound_move = 1
       AND external_uid IS NOT NULL
  `).all(accountId).filter((row) => {
    const from = collectionUrlOf(row.external_object_url);
    return !from || !fetched.some((url) => sameCollection(url, from));
  }).map((row) => row.external_uid);
}

/** Wartet ein Umzug auf eine Liste dieses Kontos, die gerade nicht eingeschaltet ist? */
export function movesWaitingForSelection(accountId) {
  return db.get().prepare(`
    SELECT COUNT(*) AS n
      FROM caldav_reminder_selection sel
      JOIN shopping_items i ON i.list_id = sel.target_list_id
     WHERE sel.account_id = ? AND sel.enabled = 0 AND sel.target_module = 'shopping'
       AND i.external_source = 'caldav' AND i.outbound_move = 1
  `).get(accountId).n;
}

/**
 * So viele Tage wartet ein Umzug auf die Server-Liste seines Objekts, solange
 * sie nicht eingeschaltet ist (#1911). Danach geht der Artikel zurück
 * (`endWaitingShoppingMoves`).
 */
export const SHOPPING_MOVE_WAIT_DAYS = 7;

/**
 * Umzüge, deren Objekt in einer Server-Liste DIESES Kontos liegt. Ein Konto
 * ohne eingeschaltete Liste fragt der Lauf trotzdem, solange es solche gibt
 * (#1911): sonst kämen das Ende des Wartens und `releaseStrandedShoppingMoves`
 * dort nie an.
 */
export function movesFromAccount(accountId) {
  return db.get().prepare(`
    SELECT COUNT(*) AS n FROM shopping_items
     WHERE external_source = 'caldav' AND external_account_id = ? AND outbound_move = 1
  `).get(accountId).n;
}

/**
 * Ein Umzug, der auf die Quelle wartet, bekommt ein Ende (#1911). Für die
 * Umzüge, deren Objekt in einer Server-Liste dieses Kontos liegt:
 *
 *   - Die Auflistung des Servers nennt die Quelle nicht mehr: mit der Liste
 *     ist ihr Eintrag fort, es gibt nichts mehr mitzunehmen. Der Artikel
 *     bleibt, wo der Nutzer ihn hingestellt hat, und wird dort als neuer
 *     Eintrag angelegt (`releaseShoppingMirror`, dann der Upload des Laufs).
 *     Zurück auf die alte Liste ginge er nicht: deren Objekt fehlt, und der
 *     Prune nähme die Zeile fort. Sofort, wie bei den Löschaufträgen
 *     (`dropDeletionsOfMissingLists`); der Auftrag für das alte Objekt fällt
 *     dort im nächsten Lauf, nennt der Server die Liste dann wieder, löscht er
 *     es - der Artikel ist umgezogen.
 *   - Die Quelle ist nicht (als Einkaufsliste) eingeschaltet, und der Umzug
 *     wartet länger als `SHOPPING_MOVE_WAIT_DAYS`: der Artikel geht auf die
 *     Liste seines Objekts zurück (`returnShoppingMove`), wie nach der
 *     fünften Absage des Ziels. Der Eintrag bleibt, wo der Server ihn führt.
 *
 * `listedUrls` ist die Auflistung DIESES Laufs für dieses Konto; leer heisst
 * "nichts gesagt" (#508), dann gilt nur die Frist.
 *
 * Synchron, vor dem Abruf des Kontos.
 *
 * @returns {{released: number, returned: number}}
 */
export function endWaitingShoppingMoves(accountId, listedUrls) {
  const listed = [...(listedUrls || [])];
  const rows = db.get().prepare(`
    SELECT *, outbound_move_since <= datetime('now', ?) AS overdue FROM shopping_items
     WHERE external_source = 'caldav' AND external_account_id = ? AND outbound_move = 1
     ORDER BY id
  `).all(`-${SHOPPING_MOVE_WAIT_DAYS} days`, accountId);
  let released = 0;
  let returned = 0;
  for (const { overdue, ...row } of rows) {
    const from = collectionUrlOf(row.external_object_url);
    if (!from) continue;
    if (listed.length > 0 && !listed.some((url) => sameCollection(url, from))) {
      db.get().transaction(() => releaseShoppingMirror(row))();
      released++;
      log.warn(
        `The reminder list that shopping item "${row.name}" (${row.id}) was moved away from no longer exists on the server. `
        + 'The item stays on the list it was moved to and is added there as a new entry.'
      );
      continue;
    }
    if (overdue !== 1 || listIsSelected(accountId, from)) continue;
    const back = returnShoppingMove(row, 'waited');
    returned++;
    log.warn(
      `Shopping item "${row.name}" (${row.id}) waited more than ${SHOPPING_MOVE_WAIT_DAYS} days for its reminder list ${from}, which is not selected. `
      + 'Its entry on the server was not touched'
      + (back ? `, and the item is back on the list it came from (${back}).` : '.')
    );
  }
  return { released, returned };
}

/**
 * Soll das Objekt dieser Zeile JETZT an genau diesen Platz mitgenommen werden?
 * Die Zeile ist Spiegel, trägt die Vormerkung, und die Liste, in der sie steht,
 * ist dieser Server-Liste dieses Kontos zugeordnet und eingeschaltet.
 */
function waitsForCarryHere(now, accountId, collectionUrl) {
  return !!now && now.external_source === 'caldav' && now.outbound_move === 1
    && waitsForUploadHere('shopping', now, accountId, collectionUrl);
}

/**
 * Ist diese Server-Liste für das Konto als EINKAUFSLISTE eingeschaltet? Eine
 * inzwischen den Aufgaben zugeordnete zählt nicht (#1911): ihr Objekt gehört
 * dann einer Aufgabe, und der Umzug darf es dort weder lesen noch entfernen.
 */
function listIsSelected(accountId, listUrl) {
  return db.get().prepare(`
    SELECT list_url FROM caldav_reminder_selection
     WHERE account_id = ? AND enabled = 1 AND target_module = 'shopping'
  `).all(accountId).some((sel) => sameCollection(sel.list_url, listUrl));
}

/** Der Name des Objekts in seiner Collection, wie die Adresse ihn schreibt. */
function objectNameOf(objectUrl) {
  const url = String(objectUrl || '');
  const name = url.slice(url.lastIndexOf('/') + 1);
  return name && !/[?#]/.test(name) ? name : null;
}

function clearShoppingMove(id) {
  db.get().prepare(
    'UPDATE shopping_items SET outbound_move = 0, outbound_move_attempts = 0, outbound_move_since = NULL, outbound_move_by = NULL WHERE id = ?'
  ).run(id);
}

/**
 * Das Ziel hat den Umzug endgültig nicht angenommen: die Zeile steht wieder
 * auf der Liste, in deren Server-Liste ihr Objekt liegt - dort, wo sie war.
 * Dieselbe Regel wie bei den Terminen (`clearOutboundMove`): die Vormerkung
 * fällt, das Objekt bleibt unangetastet, und der Eintrag bleibt, wo ihn der
 * Server führt. Gibt es die Zuordnung dieser Server-Liste nicht mehr, fällt
 * nur die Vormerkung; der nächste Abruf ordnet die Zeile wie jede andere.
 *
 * Geht die Zeile auf eine andere Liste zurück, bekommt die Person, die
 * verschoben hat, eine Meldung an der Glocke (#1912, `noteMoveTakenBack`).
 *
 * @param {'refused'|'waited'} reason  warum der Umzug zurückgeht
 * @returns {number|null} die Liste, auf die die Zeile zurückging
 */
function returnShoppingMove(row, reason) {
  const from = collectionUrlOf(row.external_object_url);
  const home = from ? db.get().prepare(`
    SELECT sel.list_url, sel.target_list_id FROM caldav_reminder_selection sel
      JOIN shopping_lists l ON l.id = sel.target_list_id
     WHERE sel.account_id = ? AND sel.target_module = 'shopping'
  `).all(row.external_account_id).find((sel) => sameCollection(sel.list_url, from)) : null;

  // `row` ist die eben gelesene Zeile: zwischen dem Lesen beim Aufrufer und
  // hier liegt kein await.
  const now = row;
  return db.get().transaction(() => {
    // Frisch gelesen: der Aufrufer kann eine Zeile ohne die Spalte halten.
    const movedBy = db.get().prepare('SELECT outbound_move_by FROM shopping_items WHERE id = ?').get(now.id)?.outbound_move_by ?? null;
    clearShoppingMove(now.id);
    if (!home || home.target_list_id === now.list_id) return null;
    noteMoveTakenBack(db.get(), { movedBy, itemId: now.id, itemName: now.name, backListId: home.target_list_id, targetListId: now.list_id, reason });
    // Ans Ende der Kategorie dort, wie bei jedem Listenwechsel (Route).
    db.get().prepare(`
      UPDATE shopping_items SET list_id = ?, sort_order = COALESCE((
        SELECT MAX(sort_order) FROM shopping_items WHERE list_id = ? AND category = ? AND id != ?
      ), 0) + 1 WHERE id = ?
    `).run(home.target_list_id, home.target_list_id, now.category, now.id, now.id);
    return home.target_list_id;
  })();
}

/**
 * Der Inhalt, der an den neuen Platz geht: das Original, Byte für Byte. Nur
 * wenn an der Zeile eine Bearbeitung auf ihren Push wartet, wird sie
 * eingearbeitet - durch denselben Patcher wie jede Änderung. Ohne wartende
 * Bearbeitung gilt der Stand des Servers, auch wenn er neuer ist als die
 * Zeile: der nächste Abruf holt ihn herein.
 */
function carriedContent(row, originalData) {
  if (!row.outbound_dirty) return originalData;
  return patchICSTodo(
    originalData, row.external_uid,
    icsFieldsForShoppingItem(row, hasCompleted(originalData))
  ) || originalData;
}

/**
 * Bucht eine Mitnahme - gegen den Stand von JETZT: zwischen `sent` und hier
 * lagen die Anfragen, und in der Zeit lief die App weiter.
 *
 *   - Die Zeile ist weg: die Löschroute hat ihr Objekt am ALTEN Platz
 *     vorgemerkt. Für das eben abgelegte steht die Notiz des Versuchs; die
 *     Zeile wartet dort nicht mehr, also wird es als Rest entfernt
 *     (`releaseLeftoverTodoUploads`).
 *   - Die Zeile ist nicht mehr dieser Spiegel, oder sie wartet nicht mehr auf
 *     die Mitnahme HIERHER (zurückgezogen, weitergezogen, auf eine Liste ohne
 *     Spiegel): nichts wird umgebucht, das abgelegte Objekt ist derselbe Rest.
 *   - Sonst: die Zeile zeigt ab jetzt auf das Objekt am neuen Platz, die
 *     Vormerkung fällt, und für den ALTEN Platz entsteht die Notiz, dass dort
 *     ein Objekt dieser Zeile liegt, das nicht mehr dorthin gehört. Eine
 *     Bearbeitung aus der Zwischenzeit bleibt vorgemerkt.
 *
 * Der alte Platz bekommt eine NOTIZ und keinen Löschauftrag: ein Auftrag trägt
 * je Konto und UID nur eine Adresse und verdeckt die UID im Abruf kontoweit -
 * nach einem Umzug innerhalb eines Kontos liegt dieselbe UID aber an zwei
 * Adressen, und nur die alte soll fort. Die Notiz gilt je Platz, und vor dem
 * Entfernen wird gelesen, was dort liegt.
 *
 * Synchron, ein Schreibvorgang.
 *
 * @returns {'carried'|'deleted'|'unchanged'|'released'}
 */
function bookShoppingCarry(sent, { accountId, collectionUrl, objectUrl }) {
  return db.get().transaction(() => {
    const now = reloadRow('shopping', sent.id);
    if (!now) return 'deleted';
    if (now.external_source !== 'caldav' || now.external_uid !== sent.external_uid
        || now.external_account_id !== sent.external_account_id
        || now.external_object_url !== sent.external_object_url) return 'unchanged';
    if (!waitsForCarryHere(now, accountId, collectionUrl)) return 'released';

    const edited = changedSince('shopping', sent, now);
    db.get().prepare(`
      UPDATE shopping_items
         SET external_account_id    = ?,
             external_object_url    = ?,
             outbound_move          = 0,
             outbound_move_attempts = 0,
             outbound_move_since    = NULL,
             outbound_dirty         = ?,
             outbound_attempts      = 0
       WHERE id = ?
    `).run(accountId, objectUrl, edited ? 1 : 0, now.id);
    keepOwnUpload('shopping', now.external_uid, objectUrl);
    settleUploadAttempt({ source: 'caldav', accountId, kind: 'item', rowId: now.id, collectionUrl });
    noteUploadAttempt({
      source: 'caldav', accountId: sent.external_account_id, kind: 'item', rowId: now.id,
      collectionUrl: collectionUrlOf(sent.external_object_url),
      uid: now.external_uid, objectUrl: sent.external_object_url,
    });
    return 'carried';
  })();
}

/**
 * Entfernt das Original am alten Platz, gleich nach der Buchung - mit dem
 * ETag, unter dem es gelesen wurde. Passt er nicht mehr (412), hat eine andere
 * App das Objekt zwischen Lesen und Entfernen geändert: ihr Stand wird neu
 * gelesen und an den neuen Platz nachgetragen, bevor der alte fällt. Einmal;
 * was danach noch aussteht, bleibt an der Notiz des alten Platzes und geht mit
 * dem nächsten Durchgang (`releaseLeftoverTodoUploads`).
 */
async function removeCarriedOriginal(source, target, { row, original, from, objectUrl, collectionUrl }) {
  // `row` ist die Zeile, wie sie hinausging. War an ihr eine Bearbeitung
  // vorgemerkt, steht sie im abgelegten Objekt - und die Buchung hat die
  // Vormerkung danach abgeräumt. Das Nachtragen unten schreibt den neuen Platz
  // noch einmal, mit dem neu gelesenen alten Objekt als Grundlage, und muss
  // dieselbe Bearbeitung wieder einarbeiten: sonst stünde am neuen Platz der
  // Name von vor der Bearbeitung, und der nächste Abruf trüge ihn in die Zeile.
  const workedIn = !!row.outbound_dirty;
  const place = { source: 'caldav', accountId: row.external_account_id, kind: 'item', rowId: row.id, collectionUrl: from };
  const gone = (err) => err?.status === 404 || err?.status === 410;
  try {
    await source.deleteCalendarObject({ calendarObject: { url: row.external_object_url, etag: original.etag } });
    settleUploadAttempt(place);
    return;
  } catch (err) {
    if (gone(err)) { settleUploadAttempt(place); return; }
    if (err?.status !== 412) {
      log.warn(`Shopping item ${row.id} was carried to ${collectionUrl}, but its old object could not be removed (${err.message}); tried again on the next run.`);
      return;
    }
  }

  try {
    const again = await inspectObjectAt(source, from, row.external_object_url, row.external_uid);
    if (!again.own) {
      // Fort, oder dort liegt inzwischen nachweislich etwas anderes.
      if (again.foreign) settleUploadAttempt(place);
      return;
    }
    const there = await inspectObjectAt(target, collectionUrl, objectUrl, row.external_uid);
    // Nach den awaits: nur für die Zeile, die weiter an diesem Objekt hängt.
    const now = reloadRow('shopping', row.id);
    if (!there.own || !now || now.external_source !== 'caldav' || now.external_object_url !== objectUrl) return;
    try {
      await target.updateCalendarObject({
        calendarObject: {
          url: objectUrl,
          etag: there.own.etag,
          data: carriedContent({ ...now, outbound_dirty: workedIn || now.outbound_dirty ? 1 : 0 }, again.own.data),
        },
      });
    } catch (err) {
      // Ein Fehler am NEUEN Platz sagt nichts über den alten (#1911): auch
      // ein 404 dort lässt die Notiz des alten stehen, sein Objekt ist dann
      // womöglich das letzte (`confirmCarriedCopy`).
      log.warn(`Shopping item ${row.id}: its old object changed while it was carried over, and the copy at ${objectUrl} could not be updated (${err.message}); tried again on the next run.`);
      return;
    }
    await source.deleteCalendarObject({ calendarObject: { url: row.external_object_url, etag: again.own.etag } });
    settleUploadAttempt(place);
    log.info(`Shopping item ${row.id}: its old object was changed while it was carried over, carried the change along.`);
  } catch (err) {
    if (gone(err)) { settleUploadAttempt(place); return; }
    log.warn(`Shopping item ${row.id}: its old object changed while it was carried over and could not be followed up (${err.message}); tried again on the next run.`);
  }
}

/**
 * Nimmt das Objekt EINES umgezogenen Artikels an seinen neuen Platz mit.
 *
 * Reihenfolge, an der die Zusage hängt, dass nichts verloren geht:
 *
 *   1. Original am alten Platz LESEN (jetzt, nicht aus einem früheren Abruf).
 *   2. Am neuen Platz ABLEGEN, unter dem Namen, den es trug - vorher notiert
 *      (`noteUploadAttempt`): geht die Antwort verloren, verdeckt die Notiz das
 *      Objekt im Abruf, und der nächste Durchgang findet es vor (412).
 *      Liegt dort schon ein Objekt DIESER UID, wird es mit dem heutigen
 *      Original überschrieben; ein Objekt mit anderer UID bleibt unangetastet,
 *      und der Versuch gilt als Absage.
 *   3. BUCHEN (`bookShoppingCarry`), synchron.
 *   4. Am alten Platz ENTFERNEN (`removeCarriedOriginal`).
 *
 * Aus einer abgewählten Liste wird nichts gelesen und nichts entfernt: der
 * Umzug wartet, bis sie wieder eingeschaltet ist. Fehler beim Lesen der Quelle
 * zählen nicht - sie sagen nichts über das Ziel.
 *
 * @returns {Promise<'carried'|'waiting'|'dropped'|'deleted'|'unchanged'|'released'>}
 * @throws wenn das ZIEL die Ablage ablehnt
 */
async function carryShoppingItem(client, accountId, collection, rowId, clientFor) {
  const listed = reloadRow('shopping', rowId);
  if (!waitsForCarryHere(listed, accountId, collection.url)) return 'waiting';

  const from = collectionUrlOf(listed.external_object_url);
  const name = objectNameOf(listed.external_object_url);
  // Ohne Adresse (Bestand von vor #617) ist das Original nicht lesbar; der
  // nächste volle Abruf trägt sie nach.
  if (!from || !name || !listed.external_uid) return 'waiting';
  // Das Objekt liegt schon in der Server-Liste des Ziels. Gefragt wird nach
  // der ADRESSE, nicht nach dem Konto: zwei Konten können dieselbe Liste
  // führen (einem zweiten Mitglied freigegeben), jedes auf eine eigene
  // Einkaufsliste. Zwischen diesen beiden gibt es nichts mitzunehmen - es ist
  // EIN Objekt, und wer es "am alten Platz" entfernte, entfernte es ganz.
  // Die Vormerkung fällt; der nächste Abruf stellt die Zeile wieder auf die
  // Liste, die ihr Konto dieser Server-Liste zuordnet.
  if (sameCollection(from, collection.url)) {
    clearShoppingMove(listed.id);
    return 'dropped';
  }
  if (!listIsSelected(listed.external_account_id, from)) return 'waiting';

  let source;
  let original;
  try {
    source = listed.external_account_id === accountId ? client : await clientFor(listed.external_account_id);
    if (!source) return 'waiting';
    original = (await inspectObjectAt(source, from, listed.external_object_url, listed.external_uid)).own;
  } catch (err) {
    log.warn(`Could not read the object of shopping item ${listed.id} at ${listed.external_object_url} (${err.message}); its move waits.`);
    return 'waiting';
  }

  // Nach den awaits: die Zeile von jetzt.
  // Auch die Quelle von jetzt: wurde sie während des Lesens abgeschaltet,
  // wartet der Umzug wie vorher (#1911).
  const sent = reloadRow('shopping', rowId);
  if (!waitsForCarryHere(sent, accountId, collection.url)
      || sent.external_object_url !== listed.external_object_url
      || sent.external_account_id !== listed.external_account_id
      || !listIsSelected(sent.external_account_id, from)) return 'waiting';

  if (!original) {
    // Am alten Platz liegt das Objekt nicht (mehr): es gibt nichts mitzunehmen,
    // und es wird nichts erfunden. Die Zeile bleibt Spiegel; der nächste Abruf
    // findet ihr Objekt, wo der Server es führt, oder räumt sie ab.
    clearShoppingMove(sent.id);
    log.warn(`The object of shopping item ${sent.id} is no longer at ${sent.external_object_url}; its move to another list is dropped.`);
    return 'dropped';
  }

  const objectUrl = `${String(collection.url).replace(/\/?$/, '/')}${name}`;
  const data = carriedContent(sent, original.data);
  noteUploadAttempt({
    source: 'caldav', accountId, kind: 'item', rowId: sent.id,
    collectionUrl: collection.url, uid: sent.external_uid, objectUrl,
  });
  try {
    // Der Name geht als ein Pfadsegment hinaus: tsdav (ab 2.5.0) setzt das
    // `./` selbst davor, damit ein Name mit Doppelpunkt nicht als eigene URL
    // gelesen wird, und lehnt einen Namen mit `/` ab.
    await client.createCalendarObject({ calendar: collection, filename: name, iCalString: data });
  } catch (err) {
    if (err?.status !== 412) throw err;
    const there = await findObjectWithUid(client, collection.url, objectUrl, sent.external_uid);
    if (!there) throw err;
    await client.updateCalendarObject({ calendarObject: { url: objectUrl, etag: there.etag, data } });
  }

  const booked = bookShoppingCarry(sent, { accountId, collectionUrl: collection.url, objectUrl });
  // Ist die Quelle inzwischen abgeschaltet, wird dort nichts entfernt: die
  // Notiz des alten Platzes bleibt, und der Rest fällt, sobald sie wieder an
  // ist (`releaseLeftoverTodoUploads`, #1911).
  if (booked === 'carried' && listIsSelected(sent.external_account_id, from)) {
    await removeCarriedOriginal(source, client, {
      row: sent, original, from, objectUrl, collectionUrl: collection.url,
    });
  }
  return booked;
}

/**
 * Nimmt die Objekte umgezogener Einkaufsartikel in die Listen dieses Kontos
 * mit (#1700). Aufgerufen für das Konto des ZIELS; die Quelle kann ein anderes
 * Konto sein (`clientFor`).
 *
 * EINE ABSAGE DES ZIELS ZÄHLT (`outbound_move_attempts`), anders als beim
 * Anlegen: ein hier angelegter Artikel hat nur diesen einen Platz und wartet
 * dort beliebig lange. Ein umgezogener hat ein Objekt, das am alten Platz
 * weiterlebt und dort von anderen Apps gesehen und geändert wird - der
 * Zwischenzustand darf nicht für immer stehen. Nach der fünften Absage steht
 * die Zeile wieder auf der Liste ihres Objekts (`returnShoppingMove`), wie ein
 * Termin, dessen Umzug der Server nicht annimmt.
 *
 * Gezählt wird nur, was über den EINTRAG selbst sagt (#2137): 400, 403, 409,
 * 412, 422, 423. Eine Absage, die das Konto oder den Server als Ganzes
 * betrifft (401, 429, 5xx), und ein Fehler ohne Status (Netzfehler) zählen
 * nicht - der Umzug bleibt stehen und verbraucht keinen Versuch, und der
 * Durchgang sendet für dieses Konto nichts mehr (`createRefusalStop`). Ein
 * 403 zählt trotzdem: ein nur lesbares Ziel ist genau der Fall, den
 * `returnShoppingMove` bewältigt, und einen Umzug gibt es zurück.
 *
 * @param {object} client      tsdav-Client des Zielkontos
 * @param {number} accountId
 * @param {Array<{listUrl: string, targetListId: number}>} targets  aktive Zuordnungen
 * @param {Map}    listsByUrl  Listen-URL → Collection des Servers
 * @param {{clientFor?: (accountId: number) => Promise<object|null>, stop?: ReturnType<typeof createRefusalStop>}} [opts]
 * @returns {Promise<number>} mitgenommene Objekte
 */
export async function processPendingShoppingMoves(client, accountId, targets, listsByUrl, { clientFor, stop = createRefusalStop() } = {}) {
  const sourceFor = clientFor || (async () => null);
  let done = 0;
  for (const { listUrl, targetListId } of targets) {
    if (!targetListId) continue;
    const collection = listsByUrl.get(listUrl);
    if (!collection) continue;

    // Nach einer kontoweiten Absage in diesem Durchgang: keine weitere
    // Anfrage an das Konto (#1863, #2137).
    if (stop.blocks(collection.url)) continue;

    for (const listed of pendingShoppingMoves(targetListId)) {
      // Nach einer kontoweiten Absage in diesem Durchgang: keine weitere
      // Anfrage an das Konto (#2143).
      if (stop.blocks(collection.url)) break;
      try {
        if (await carryShoppingItem(client, accountId, collection, listed.id, sourceFor) === 'carried') done++;
      } catch (err) {
        const now = reloadRow('shopping', listed.id);
        if (!waitsForCarryHere(now, accountId, collection.url)) continue;

        // Ein unerreichbarer Server ist keine Absage: er hat nicht geantwortet.
        // Aber er ist nicht erreichbar - für weitere Artikel in diesem Durchgang
        // auch nicht (#2143).
        if (typeof err?.status !== 'number') {
          stop.trip(err, collection.url);
          log.warn(`Could not carry shopping item ${now.id} to ${listUrl}: ${err.message}`);
          continue;
        }

        // Eine kontoweite Absage (401, 429, 5xx) sagt nichts über den Eintrag
        // selbst (#2137): der Umzug bleibt stehen, verbraucht keinen Versuch,
        // und der Durchgang sendet für dieses Konto nichts mehr. Ein 403 zählt
        // trotzdem - ein nur lesbares Ziel ist genau der Fall, den
        // `returnShoppingMove` bewältigt, und einen Umzug gibt es zurück.
        if (isAccountWideRefusal(err) && err.status !== 403) {
          stop.trip(err, collection.url);
          log.warn(`Reminder list ${listUrl} refused shopping item ${now.id} for the whole account, its move waits without using up an attempt: ${err.message}`);
          continue;
        }

        if (now.outbound_move_attempts + 1 >= MAX_OUTBOUND_ATTEMPTS) {
          const back = returnShoppingMove(now, 'refused');
          log.error(
            `Giving up on moving shopping item "${now.name}" (${now.id}) to reminder list ${listUrl} after `
            + `${now.outbound_move_attempts + 1} refusal(s): ${err.message}. Its entry on the server was not touched`
            + (back ? `, and the item is back on the list it came from (${back}).` : '.')
          );
          continue;
        }
        db.get().prepare(
          'UPDATE shopping_items SET outbound_move_attempts = outbound_move_attempts + 1 WHERE id = ?'
        ).run(now.id);
        log.warn(`Reminder list ${listUrl} refused shopping item ${now.id} (attempt ${now.outbound_move_attempts + 1}): ${err.message}`);
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
 *
 * EIN AUFTRAG FÜR EINE ABGEWÄHLTE LISTE WARTET (#1884). Abschalten heisst
 * nicht aufräumen: solange die Liste abgewählt ist, geht dorthin kein DELETE,
 * weder im Lauf noch im Sofortversuch. Der Auftrag bleibt stehen, zählt keinen
 * Versuch und läuft, sobald die Liste wieder eingeschaltet ist; endgültig
 * fällt er, wenn es die Liste nicht mehr gibt (`dropDeletionsOfMissingLists`)
 * oder das Konto gelöscht wird. Führt der Abruf das Objekt inzwischen in einer
 * EINGESCHALTETEN Liste (auf einem anderen Gerät verschoben), wird es dort
 * gelöscht.
 *
 * `stop` (#1863): das Stoppsignal des Durchgangs (`createRefusalStop`). Nach
 * einer kontoweiten Absage geht keine weitere Anfrage an das Konto, die
 * Aufträge bleiben ohne Versuch. Der Aufrufer teilt es mit
 * `processPendingUpdates` und über die Module hinweg.
 * @returns {Promise<number>} erledigte Tombstones
 */
export async function processPendingDeletions(client, accountId, module, objectIndex, complete = false, { stop = createRefusalStop() } = {}) {
  const rows = pendingDeletions(accountId, module);
  if (rows.length === 0) return 0;

  let done = 0;
  for (const row of rows) {
    const known = objectIndex.get(row.uid);
    let url     = row.object_url || known?.url || null;

    // Je Auftrag gelesen, unmittelbar vor seiner Anfrage.
    if (url && inUnselectedList(accountId, url)) {
      if (!known?.url || inUnselectedList(accountId, known.url)) continue;
      url = known.url;
    }

    if (!url) {
      if (complete) {
        log.info(`VTODO ${row.uid} is no longer on the server, dropping the pending deletion.`);
        dropDeletion(row.id);
        done++;
      }
      continue;
    }

    // Nach einer kontoweiten Absage in diesem Durchgang: nichts senden (#1863).
    if (stop.blocks(collectionUrlOf(url))) continue;

    try {
      await client.deleteCalendarObject({ calendarObject: { url, etag: known?.etag } });
      dropDeletion(row.id);
      done++;
    } catch (err) {
      // Die Adresse liegt nicht beim Konto (`createTodoClient`): gesendet
      // wurde nichts, also zählt kein Versuch. Der volle Lauf räumt ab - das
      // Konto führt das Objekt nicht -, der Sofortversuch lässt ihm den Auftrag.
      if (isOriginRefusal(err)) {
        if (complete) {
          log.warn(`The stored address of VTODO ${row.uid} is not on the server of its account, dropping the pending deletion.`);
          dropDeletion(row.id);
          done++;
        } else {
          log.warn(`The stored address of VTODO ${row.uid} is not on the server of its account, leaving its deletion to the next sync run.`);
        }
        continue;
      }
      // Eine kontoweite Absage verbraucht keinen Versuch (#1863).
      const action = davFailureAction(err, row.attempts);
      if (action === 'settled') {
        dropDeletion(row.id);
        done++;
        continue;
      }
      if (action === 'wait') {
        stop.trip(err, collectionUrlOf(url));
        failDeletion(row.id, err, { counts: false });
        log.warn(`Remote deletion of VTODO ${row.uid} was refused for the whole account, it waits without using up an attempt:`, err.message);
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
export async function processPendingUpdates(client, accountId, module, objectIndex, { stop = createRefusalStop() } = {}) {
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

    if (stop.blocks(collectionUrlOf(url))) continue;

    try {
      await client.updateCalendarObject({ calendarObject: { url, etag: known.etag, data: patched } });
      // Erledigt ist nur, was hinausging (#1862).
      settleOutbound(module, fresh);
      done++;
    } catch (err) {
      // Gesendet wurde nichts (`createTodoClient`): kein Versuch, die
      // Bearbeitung bleibt vorgemerkt und der Inbound überschreibt sie nicht.
      if (isOriginRefusal(err)) {
        log.warn(`The stored address of VTODO ${row.external_uid} is not on the server of its account, its update waits.`);
        continue;
      }
      const action = davFailureAction(err, row.outbound_attempts);
      if (action === 'settled') {
        log.warn(`VTODO ${row.external_uid} no longer exists on the server, dropping its update.`);
        clearOutbound(module, row.id);
        continue;
      }
      if (action === 'wait') {
        stop.trip(err, collectionUrlOf(url));
        log.warn(`Outbound update of "${def.labelOf(row)}" was refused for the whole account, it waits without using up an attempt:`, err.message);
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

  // Ein Auftrag, der auf eine abgewählte Liste wartet (#1884), ist keine
  // Arbeit für den Sofortversuch: sonst baute jede Bearbeitung einen Client
  // für ein Konto auf, an das nichts geht.
  for (const row of db.get().prepare(
    'SELECT account_id, module, object_url FROM caldav_todo_pending_deletions'
  ).all()) {
    if (row.object_url && inUnselectedList(row.account_id, row.object_url)) continue;
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
  for (const accountId of accountsWithPendingShoppingMoves()) add(accountId, 'shopping');
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
  const calendars = await listCollections(client);
  return new Map(
    (calendars || []).filter((c) => allowed.has(c.url)).map((c) => [c.url, c])
  );
}

/**
 * Die Collections des Kontos - oder ein Fehler, wenn der Server KEINE nennt.
 *
 * Gefragt wird hier nur, weil ausgewählte Listen auf einen Upload warten; eine
 * Antwort ohne eine einzige Collection ist dann eine unvollständige Antwort
 * (ein Multistatus, der nur die Home-Collection nennt oder jede Ressource mit
 * 403 quittiert) und kein leeres Konto. Als leere Liste gelesen, gälte jedes
 * Upload-Ziel als verschwunden und würde freigegeben - derselbe Leer-Guard wie
 * beim Prune (#508).
 */
async function listCollections(client) {
  const calendars = await client.fetchCalendars();
  if (!calendars || calendars.length === 0) {
    throw new Error('the server listed no collections, although lists are selected');
  }
  return calendars;
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
  const calendars = await listCollections(client);
  return new Map((calendars || []).filter((c) => allowed.has(c.url)).map((c) => [c.url, c]));
}

/**
 * Holt gezielt die betroffenen Kalenderobjekte statt ganzer Listen - die
 * Grundlage des Sofortversuchs direkt nach einer Bearbeitung. Die Collection
 * wird aus der Objekt-URL abgeleitet, weil ein Eintrag nur diese trägt.
 *
 * @returns {Promise<Map>} UID → { url, etag, data }
 */
export async function fetchObjectsByUrl(client, wanted) {
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
        const match = items.find((i) => sameObjectAddress(i.url, obj.url));
        if (!match) continue;
        index.set(match.uid, { url: match.url, etag: obj.etag, data: obj.data });
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
  // Die Quelle einer Mitnahme kann ein anderes Konto sein (#1700).
  const clientFor = async (id) => {
    const other = db.get().prepare('SELECT * FROM caldav_accounts WHERE id = ?').get(id);
    return other ? createTodoClient(other, makeClient) : null;
  };

  for (const [accountId, modules] of work) {
    const account = db.get().prepare('SELECT * FROM caldav_accounts WHERE id = ?').get(accountId);
    if (!account) continue;

    try {
      const client = await createTodoClient(account, makeClient);

      // Ein Stoppsignal für jede schreibende Phase aller Module dieses
      // Kontos (#1863, #2137, #2135): Aufräumen, Löschen, Ändern, Uploads und
      // Mitnahmen. Nach einer kontoweiten Absage geht keine Anfrage mehr an
      // das Konto, auch kein Abruf, der nur einer späteren Phase diente.
      const stop = createRefusalStop();

      // Vor allem anderen: die Reste nie bestätigter Uploads entfernen
      // (#1882), damit eine Zeile mit neuem Ziel nicht neben ihren Rest geht.
      await releaseLeftoverTodoUploads(client, accountId, { clientFor, stop });

      for (const module of modules) {
        if (stop.blocks()) break;
        const wanted = [
          ...pendingDeletions(accountId, module)
            .filter((r) => r.object_url && !inUnselectedList(accountId, r.object_url))
            .map((r) => ({ uid: r.uid, url: r.object_url })),
          ...pendingUpdates(accountId, module)
            .filter((r) => r.external_object_url)
            .map((r) => ({ uid: r.external_uid, url: r.external_object_url })),
        ];

        const objectIndex = await fetchObjectsByUrl(client, wanted);

        // complete = false: ohne vollen Listenabruf ist "der Server führt das
        // Objekt nicht mehr" nicht belegbar; ein Tombstone ohne bekannte URL
        // bleibt für den Sync liegen.
        total.deleted += await processPendingDeletions(client, accountId, module, objectIndex, false, { stop });
        total.updated += await processPendingUpdates(client, accountId, module, objectIndex, { stop });

        // Uploads brauchen die Collection selbst, nicht einzelne Objekte - und
        // damit den einzigen Listenabruf in diesem Pfad. Er läuft deshalb nur,
        // wenn wirklich etwas wartet.
        if (stop.blocks()) break;
        if (module === 'tasks' && pendingCreations(accountId, module).length) {
          total.created += await processPendingCreations(
            client, accountId, module, await taskListsOf(client, accountId), { stop }
          );
        }
        if (module === 'shopping') {
          const selections = shoppingSelectionsOf(accountId);
          const targets = selections
            .filter((tgt) => pendingShoppingCreations(tgt.targetListId, accountId).length);
          // Mitnahme umgezogener Artikel (#1700): dieselben Collections, ein
          // Listenabruf für beides.
          const moves = selections.filter((tgt) => pendingShoppingMoves(tgt.targetListId).length);
          if (targets.length || moves.length) {
            const collections = await collectionsForTargets(client, [...targets, ...moves]);
            if (targets.length) {
              total.created += await processPendingShoppingCreations(client, accountId, targets, collections, { stop });
            }
            if (moves.length) {
              // Als `updated` gezählt: das Objekt ist dasselbe, nur sein Platz nicht.
              // Dasselbe Stoppsignal wie Löschen und Ändern (#1863, #2137).
              total.updated += await processPendingShoppingMoves(client, accountId, moves, collections, { clientFor, stop });
            }
          }
        }
      }
    } catch (err) {
      log.warn(`[Account ${accountId}] Immediate outbound attempt failed: ${err.message}`);
    }
  }
  return total;
}
