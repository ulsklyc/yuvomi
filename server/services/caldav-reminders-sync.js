/**
 * Modul: CalDAV Reminders Sync (Apple Reminders / VTODO)
 * Zweck: Multi-Account-CalDAV-VTODO-Synchronisation in die Module Tasks & Shopping.
 *        Reuses the existing caldav_accounts; Apple Reminders lists are CalDAV collections
 *        whose supported components include VTODO.
 *        Die Rückrichtung (lokale Änderung/Löschung → Server, #617) liegt in
 *        caldav-todo-outbound.js und läuft am Ende jedes Account-Durchlaufs mit.
 * Abhängigkeiten: tsdav, server/db.js, server/services/ics-parser.js
 */

import { createLogger } from '../logger.js';
const log = createLogger('CalDAV-Reminders');

import * as db from '../db.js';
import { parseVTODO } from './ics-parser.js';
import { createCalDAVClient, supportsComponent, writableColumn, writableFromColumn, collectionUrlOf } from '../utils/caldav-client.js';
import { createdHere } from './calendar-prune.js';
import { householdTimeZone, utcToWall } from '../utils/timezone.js';
import { setItemTags, setTags } from '../utils/task-tags.js';
import { syncTaskCompletion, recordCompletion, revokeCompletion } from './task-completions.js';
import * as todoOutbound from './caldav-todo-outbound.js';
import { createRefusalStop } from './calendar-outbound.js';
import { runSerialized } from '../utils/sync-lock.js';
import { calendarDisplayName } from '../utils/calendar-meta.js';
import { readAllDefaultAssignees, readDefaultAssignees, writeDefaultAssignees } from './default-assignees.js';

/** Standard-Personen fuer eine Liste, die nicht auf Aufgaben zeigt (#1221): die Route antwortet 400. */
export class ReminderListAssigneeError extends Error {}

// --------------------------------------------------------
// Pure Mapping Helpers
// --------------------------------------------------------

/**
 * Map an RFC-5545 VTODO PRIORITY (1–9, 0/undefined) to an Yuvomi task priority.
 * 1–4 → high, 5 → medium, 6–9 → low, else none.
 *
 * `current` ist die lokale Priorität, falls es die Aufgabe schon gibt. Yuvomi
 * kennt vier Stufen, RFC 5545 drei Bänder - `urgent` und `high` teilen sich das
 * obere. Meldet der Server dasselbe Band, in dem die Aufgabe lokal schon liegt,
 * bleibt die feinere lokale Angabe stehen; sonst käme jede hochgeschobene
 * dringende Aufgabe beim nächsten Lauf als „hoch" zurück (#617).
 */
function mapVtodoPriority(p, current = null) {
  const band = p == null ? 'none'
    : p >= 1 && p <= 4 ? 'high'
    : p === 5          ? 'medium'
    : p >= 6 && p <= 9 ? 'low'
    : 'none';

  if (band === 'high' && current === 'urgent') return 'urgent';
  return band;
}

// Lokale Zustände, die VTODO nicht ausdrückt und die ein „nicht erledigt" vom
// Server deshalb nicht zurücksetzen darf: `in_progress` schreibt kaum ein Client
// als IN-PROCESS heraus.
// Die Ablage steht seit #688 nicht mehr im Statusfeld, sondern in archived_at -
// der Sync fasst sie gar nicht mehr an und kann sie also auch nicht überschreiben.
const LOCAL_OPEN_STATES = new Set(['in_progress']);

/**
 * VTODO-Status → Yuvomi-Aufgabenstatus, unter Rücksicht auf den lokalen Stand:
 * ohne ihn käme eine begonnene oder abgelegte Aufgabe bei jedem Lauf als
 * „offen" zurück (#617).
 */
function mapVtodoStatus(todo, current = null) {
  if (todo.completed) return 'done';
  if (todo.status === 'in-process') return 'in_progress';
  return LOCAL_OPEN_STATES.has(current) ? current : 'open';
}

/**
 * Split a formatted DUE value (date or datetime) into { date, time }.
 * Date-only → time is null; datetime → HH:MM.
 *
 * Der Parser liefert eine Fälligkeit mit Uhrzeit als UTC-Instant: `DUE:…Z` bleibt
 * UTC, `DUE;TZID=…` wird dorthin umgerechnet. `due_date`/`due_time` einer Aufgabe
 * sind dagegen reine Wanduhr-Werte, die die Oberfläche unverändert anzeigt - der
 * Instant muss deshalb erst in die Zone des Haushalts (#617). Ohne diesen Schritt
 * stand eine um 14:30 fällige Aufgabe in Yuvomi um 12:30, verschoben um genau den
 * Zonenoffset. Eine Fälligkeit ohne Zonenangabe (floating) ist bereits Wanduhr
 * und bleibt unangetastet.
 */
function splitDue(due, tz = householdTimeZone(null)) {
  if (!due) return { date: null, time: null };
  if (due.length === 10) return { date: due, time: null };

  if (due.endsWith('Z')) {
    const wall = utcToWall(due, tz);
    if (wall) return { date: wall.date, time: wall.time.slice(0, 5) };
  }
  return { date: due.slice(0, 10), time: due.slice(11, 16) || null };
}

// --------------------------------------------------------
// Account Helpers (shared caldav_accounts)
// --------------------------------------------------------

function getAccountById(accountId) {
  return db.get().prepare('SELECT * FROM caldav_accounts WHERE id = ?').get(accountId);
}

function getAllAccounts() {
  return db.get().prepare('SELECT * FROM caldav_accounts').all();
}

function isReminderCollection(cal) {
  return supportsComponent(cal, 'VTODO');
}

/**
 * Ohne eigene Angabe filtert `fetchCalendarObjects` auf VEVENT (tsdav-Default).
 * Auf eine Aufgabenliste angewandt fragt der REPORT damit nach Terminen, die es
 * dort nicht gibt - ein regelkonformer Server (Nextcloud/SabreDAV, Radicale)
 * antwortet mit einer leeren Sammlung, der Inbound spiegelt nichts und das Modul
 * bleibt leer, obwohl die Liste in den Einstellungen auftaucht (#586). Der Abruf
 * muss also ausdrücklich nach VTODO fragen.
 */
const VTODO_FILTERS = [{
  'comp-filter': {
    _attributes: { name: 'VCALENDAR' },
    'comp-filter': { _attributes: { name: 'VTODO' } },
  },
}];

const createClient = createCalDAVClient;

// --------------------------------------------------------
// Reminder-List Discovery & Selection
// --------------------------------------------------------

async function getReminderLists(accountId, { refresh = false, createClient: makeClient } = {}) {
  const account = getAccountById(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found.`);
  }

  // Ohne gelaufene Suche entdeckt ein frisch angelegtes Konto nur Kalender: die
  // Seite zeigte einen leeren Zustand, bis jemand "Aktualisieren" drückte, und wer
  // den Knopf nicht fand, hielt den Aufgaben-Abgleich für kaputt (#617). Deshalb
  // sucht der erste Aufruf selbst. Der Zeitstempel (v125) merkt sich, dass die
  // Suche lief, auch wenn sie nichts fand - sonst befragte ein Server ohne
  // VTODO-Sammlungen bei jedem Seitenaufruf erneut das Netz.
  if (!refresh && account.reminders_discovered_at) {
    const rows = db.get().prepare(`
      SELECT id, list_url, list_name, target_module, enabled, writable
      FROM caldav_reminder_selection
      WHERE account_id = ?
      ORDER BY list_name
    `).all(accountId);
    const sets = readAllDefaultAssignees(db.get(), 'reminderList');

    return rows.map(r => ({
      listUrl:      r.list_url,
      listName:     r.list_name,
      targetModule: r.target_module,
      enabled:      r.enabled === 1,
      // Standard-Personen neuer Aufgaben aus dieser Liste (#1221).
      defaultAssigneeUserIds: sets.get(Number(r.id)) ?? [],
      // Nimmt die Liste neue Einträge an (#1840)? null: der Server sagt es
      // nicht. Dazu, was auf den Upload hierher wartet.
      writable:       writableFromColumn(r.writable),
      waitingUploads: todoOutbound.countWaitingTodoUploads(accountId, r.list_url),
    }));
  }

  // Refresh from server, preserving existing enabled/target_module settings
  const client    = await (makeClient || createClient)(account);
  const calendars = await client.fetchCalendars();
  const lists     = calendars.filter(isReminderCollection);

  const result = [];
  for (const cal of lists) {
    const name     = calendarDisplayName(cal.displayName, 'Reminders');
    const existing = db.get().prepare(
      'SELECT id, target_module, enabled FROM caldav_reminder_selection WHERE account_id = ? AND list_url = ?'
    ).get(accountId, cal.url);

    const targetModule = existing ? existing.target_module : 'tasks';
    const enabled      = existing ? existing.enabled : 0;

    db.get().prepare(`
      INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, writable)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, list_url) DO UPDATE SET list_name = excluded.list_name,
                                                     writable  = excluded.writable
    `).run(accountId, cal.url, name, targetModule, enabled, writableColumn(cal));

    result.push({
      listUrl: cal.url, listName: name, targetModule, enabled: enabled === 1,
      defaultAssigneeUserIds: existing ? readDefaultAssignees(db.get(), 'reminderList', existing.id) : [],
      writable: writableFromColumn(writableColumn(cal)),
    });
  }

  db.get().prepare(`
    UPDATE caldav_accounts
       SET reminders_discovered_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ?
  `).run(accountId);

  log.info(`Discovered ${result.length} reminder list(s) for account ${accountId}.`);
  return result;
}

/**
 * Die Schreibrechte aus einer Auflistung in die Auswahl übernehmen (#1840),
 * wie `rememberCalendarWritability` bei den Terminen. Eine Liste, die die
 * Auflistung nicht nennt, bleibt, wie sie war.
 */
function rememberListWritability(accountId, serverCals) {
  const update = db.get().prepare(`
    UPDATE caldav_reminder_selection SET writable = ?
    WHERE account_id = ? AND list_url = ?
  `);
  for (const cal of serverCals || []) {
    if (!cal?.url) continue;
    update.run(writableColumn(cal), accountId, cal.url);
  }
}

function ensureShoppingList(sel) {
  if (sel.target_list_id) {
    const existing = db.get().prepare('SELECT id FROM shopping_lists WHERE id = ?').get(sel.target_list_id);
    if (existing) return sel.target_list_id;
  }
  const owner     = db.get().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  const createdBy = owner ? owner.id : 1;
  const row       = db.get().prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)').run(sel.list_name, createdBy);
  const id        = row.lastInsertRowid;
  db.get().prepare('UPDATE caldav_reminder_selection SET target_list_id = ? WHERE id = ?').run(id, sel.id);
  sel.target_list_id = id;
  return id;
}

/**
 * @param {number} accountId
 * @param {string} listUrl
 * @param {{ enabled?: boolean, targetModule?: string, defaultAssigneeUserIds?: number[] }} [changes]
 *   `defaultAssigneeUserIds` (#1221): von der Route geprueft; nur fuer eine
 *   Liste, die auf Aufgaben zeigt - fuer eine Einkaufsliste wirft der Aufruf.
 */
function updateReminderSelection(accountId, listUrl, { enabled, targetModule, defaultAssigneeUserIds } = {}) {
  const account = getAccountById(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found.`);
  }

  const sel = db.get().prepare(
    'SELECT * FROM caldav_reminder_selection WHERE account_id = ? AND list_url = ?'
  ).get(accountId, listUrl);
  if (!sel) {
    throw new Error(`Reminder list not found for account ${accountId}.`);
  }

  const newModule = targetModule || sel.target_module;
  if (newModule !== 'tasks' && newModule !== 'shopping') {
    throw new Error('Invalid target module (expected "tasks" or "shopping").');
  }
  const newEnabled = enabled === undefined ? sel.enabled : (enabled ? 1 : 0);
  // Ein Einkaufseintrag hat keine Person (#1221).
  if (defaultAssigneeUserIds !== undefined && defaultAssigneeUserIds.length && newModule !== 'tasks') {
    throw new ReminderListAssigneeError('Default assignees can only be set for a list mapped to Tasks.');
  }

  let targetListId = sel.target_list_id;
  if (newModule === 'shopping' && newEnabled === 1) {
    targetListId = ensureShoppingList(sel);
  }

  db.get().prepare(`
    UPDATE caldav_reminder_selection
    SET enabled = ?, target_module = ?, target_list_id = ?
    WHERE account_id = ? AND list_url = ?
  `).run(newEnabled, newModule, targetListId, accountId, listUrl);
  if (defaultAssigneeUserIds !== undefined) {
    writeDefaultAssignees(db.get(), 'reminderList', sel.id, defaultAssigneeUserIds);
  }

  log.info(`Reminder selection updated: account ${accountId}, list ${listUrl}, module=${newModule}, enabled=${newEnabled}`);
  return { success: true };
}

// --------------------------------------------------------
// Upsert Helpers (Inbound: Server → Yuvomi)
// --------------------------------------------------------

/**
 * Standard-Personen einer Erinnerungsliste (#1221) an eine NEU eingelesene
 * Aufgabe - dieselben zwei Stellen wie jede Zuweisung einer Aufgabe
 * (`tasks.assigned_to` fuer die erste, `task_assignments` fuer alle). Nur
 * beim ersten Einlesen: was danach an der Aufgabe zugewiesen oder von Hand
 * entfernt wird, fasst der Sync nicht mehr an, wie bei Kalendern (#459). Ein
 * VTODO traegt keine Person, also geht nichts zurueck zum Server.
 * Verwaiste Personen fallen heraus (readDefaultAssignees liest ueber users).
 */
function assignListDefault(d, taskId, userIds) {
  if (!taskId || !userIds?.length) return;
  d.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ? AND assigned_to IS NULL').run(userIds[0], taskId);
  const ins = d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const userId of userIds) ins.run(taskId, userId);
}

/**
 * Die Zeile, die zu dieser UID gehört - über ALLE Konten (#1906, wie
 * `rowForUid` bei Terminen, #1879). Dieselbe UID aus zwei Konten ist EINE
 * Zeile, und das Konto, das sie zuerst geliefert hat, besitzt sie:
 *   - eigene Zeile: wird aktualisiert;
 *   - Zeile eines anderen Kontos: bleibt unberührt, und es entsteht keine
 *     zweite (`{ foreign: true }`);
 *   - Zeile ohne Konto (ihr Konto wurde gelöscht, #1885): wird übernommen.
 * @returns {{row: object|null, foreign: boolean}}
 */
function rowForTodoUid(d, table, columns, uid, accountId) {
  const rows = d.prepare(
    `SELECT id, external_account_id, ${columns} FROM ${table}
      WHERE external_uid = ? AND external_source = 'caldav' ORDER BY id`
  ).all(uid);
  const own = rows.find((r) => r.external_account_id === accountId);
  if (own) return { row: own, foreign: false };
  if (rows.some((r) => r.external_account_id != null)) return { row: null, foreign: true };
  const free = rows[0];
  if (!free) return { row: null, foreign: false };
  d.prepare(`UPDATE ${table} SET external_account_id = ? WHERE id = ? AND external_account_id IS NULL`).run(accountId, free.id);
  return { row: free, foreign: false };
}

// Die Objekt-URL (obj.url des Abrufs) wandert bei jedem Upsert mit: ohne sie ist
// ein gespiegelter Eintrag für spätere Änderungen und Löschungen unerreichbar
// (#617). COALESCE, weil ein Abruf ohne URL den gespeicherten Wert nicht
// entwerten darf.
function upsertTask(todo, accountId, createdBy, objectUrl = null, { completions = null, defaultAssignees = [] } = {}) {
  const d = db.get();
  const { date, time } = splitDue(todo.due, householdTimeZone(d));

  // Zeile und Tags in einer Transaktion. Der STATUS einer schon gespiegelten
  // Zeile gehört nicht dazu: er wird zusammen mit seinem Erledigungseintrag in
  // applySyncedCompletions geschrieben (#1836, siehe unten).
  return d.transaction(() => {
    const { row: existing, foreign } = rowForTodoUid(d, 'tasks', 'priority, status', todo.uid, accountId);
    // Ein anderes Konto führt die Aufgabe schon (#1906): nichts anlegen, nichts ändern.
    if (foreign) return null;

    const priority = mapVtodoPriority(todo.priority, existing?.priority);
    const status   = mapVtodoStatus(todo, existing?.status);

    let taskId;
    if (existing) {
      d.prepare(`
        UPDATE tasks
        SET title = ?, description = ?, priority = ?, due_date = ?, due_time = ?,
            external_object_url = COALESCE(?, external_object_url)
        WHERE id = ?
      `).run(todo.summary, todo.description, priority, date, time, objectUrl, existing.id);
      taskId = existing.id;
    } else {
      // category bleibt beim Spalten-Default 'misc' (v114) - VTODO kennt keine
      // Entsprechung, und CATEGORIES ist die Tag-Liste, nicht die Schublade.
      const row = d.prepare(`
        INSERT INTO tasks
          (title, description, priority, status, due_date, due_time, created_by, external_uid, external_source, external_account_id, external_object_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'caldav', ?, ?)
      `).run(todo.summary, todo.description, priority, status, date, time, createdBy, todo.uid, accountId, objectUrl);
      taskId = row.lastInsertRowid;
      assignListDefault(d, Number(taskId), defaultAssignees);
    }

    // Derselbe Erledigungseintrag wie beim Abhaken in Yuvomi (#1836): ohne ihn
    // fehlte eine auf dem Telefon abgehakte Aufgabe im Verlauf und an der Wand
    // ("heute erledigt"), und eine dort wieder geöffnete behielte ihren Eintrag.
    // Keine Person - der Sync weiss nicht, wer abgehakt hat (Begründung an
    // syncTaskCompletion).
    //
    // NUR FÜR EINE SCHON GESPIEGELTE ZEILE. Eine neu eingelesene, bereits
    // erledigte Aufgabe ist kein Übergang, den hier jemand erlebt hat: der erste
    // Abruf einer Liste brächte sonst jede je abgehakte Erinnerung auf einmal in
    // den Verlauf - genau der Nachtrag, den #1836 ausschliesst.
    //
    // IM LAUF ERST NACH DER HIERARCHIE, UND MIT IHM DER STATUS (Review zu
    // #1836). Ob die Zeile eine Teilaufgabe ist - und damit keinen Eintrag
    // bekommt -, entscheidet erst applyTaskRelations nach allen Listen. Wer
    // `completions` mitgibt (sync()), bekommt den Übergang dort hinein und
    // spielt ihn mit applySyncedCompletions nach; ohne gilt er sofort. Der
    // Status wartet mit, damit Status und Eintrag nur gemeinsam entstehen:
    // stürbe der Lauf zwischen beiden, sähe der nächste "unverändert", und der
    // Eintrag fehlte für immer. Bis zum Abschluss liest im Lauf nichts den
    // neuen Status (Hierarchie, dann Übergänge, erst danach Prune und Push).
    //
    // JE AUFGABE EIN ÜBERGANG, DER LETZTE GEWINNT. Dieselbe UID darf in
    // mehreren Listen stehen, und wie Titel und Tags bestimmt das zuletzt
    // gelesene Objekt auch den Status. Jeder Upsert liest dabei den noch
    // ungeschriebenen Status aus der Zeile: ein späteres Objekt, das ihn
    // bestätigt, nimmt einen früher vorgemerkten Wechsel deshalb zurück.
    //
    // AUCH OHNE WECHSEL STEHT DIE ZEILE IN DER WARTESCHLANGE (#2078). Ändert
    // der Lauf nur RELATED-TO, entscheidet die Hierarchie trotzdem über den
    // Eintrag, und eine herausgelöste erledigte Aufgabe braucht dafür das
    // COMPLETED genau dieses Objekts. Ein Eintrag mit gleichem alten und neuen
    // Status ist kein Übergang; applySyncedCompletions gleicht ihn nur ab,
    // wenn sich der Elternteil geändert hat.
    if (existing) {
      const id = Number(taskId);
      const seen = { taskId: id, oldStatus: existing.status, newStatus: status, completedAt: pastOrNull(todo.completedAt) };
      if (completions) completions.set(id, seen);
      else if (existing.status !== status) applySyncedCompletions(d, [seen]);
    }

    // CATEGORIES → Tags (#586). Der Server führt sie, also gewinnt er auch: eine
    // lokale Bearbeitung, die noch aussteht, kommt hier gar nicht an - der
    // Aufrufer überspringt dirty markierte Einträge (#617).
    setTags(d, taskId, todo.tags);
    return taskId;
  })();
}

/**
 * Die Statuswechsel eines Laufs schreiben: Status UND Erledigungseintrag in
 * einer Transaktion (#1836), nachdem die Hierarchie steht - recordCompletion
 * fragt `parent_task_id`.
 *
 * Nur, wo die Zeile noch auf dem Status steht, den der Upsert gesehen hat, und
 * keine lokale Bearbeitung auf ihren Push wartet: zwischen Upsert und hier
 * liegen die Abrufe der übrigen Listen. Wer die Aufgabe in der Zeit in Yuvomi
 * umgeschaltet oder bearbeitet hat, gewinnt wie sonst im Inbound (#617), und
 * ihren Eintrag hat die Route schon richtig gestellt.
 *
 * NUR DIE HIERARCHIE GEÄNDERT (#2078). Für die Aufgaben in `reparented`
 * (applyTaskRelations), deren Status der Lauf NICHT ändert, gilt dieselbe
 * Regel wie beim Abhaken: Teilaufgaben stehen nie im Verlauf, also verliert
 * eine untergeordnete ihren Eintrag. Eine herausgelöste erledigte Aufgabe
 * bekommt ihn mit dem COMPLETED der Erinnerung; fehlt es oder ist es
 * unbrauchbar, bleibt sie ohne - ein Eintrag mit der Laufzeit wäre ein
 * Nachtrag, den #1836 schon beim ersten Abruf ausschliesst. Dieselben
 * Schutzregeln wie für den Status: nur auf dem gesehenen Status, ohne
 * wartenden Push.
 *
 * @param {Map|Array} pending       je Aufgabe der gesehene Stand aus upsertTask
 * @param {Set<number>} [reparented] Aufgaben, deren parent_task_id der Lauf geändert hat
 */
function applySyncedCompletions(d, pending, reparented = null) {
  // Der Lauf führt eine Map je Aufgabe, der Einzelaufruf eine Liste.
  const entries = pending instanceof Map ? [...pending.values()] : pending;
  if (!entries.length) return;
  const write = d.prepare(`
    UPDATE tasks SET status = ?
     WHERE id = ? AND status = ? AND COALESCE(outbound_dirty, 0) = 0
  `);
  const untouched = d.prepare(`
    SELECT parent_task_id FROM tasks
     WHERE id = ? AND status = ? AND COALESCE(outbound_dirty, 0) = 0
  `);
  d.transaction(() => {
    for (const { taskId, oldStatus, newStatus, completedAt } of entries) {
      if (oldStatus === newStatus) {
        if (!reparented?.has(taskId)) continue;
        const row = untouched.get(taskId, oldStatus);
        if (!row) continue;
        if (row.parent_task_id != null) revokeCompletion(d, taskId);
        else if (newStatus === 'done' && completedAt) {
          recordCompletion(d, taskId, null, null, { source: 'caldav', completedAt });
        }
        continue;
      }
      if (write.run(newStatus, taskId, oldStatus).changes === 0) continue;
      syncTaskCompletion(d, taskId, oldStatus, newStatus, null, null, { source: 'caldav', completedAt });
    }
  })();
}

/**
 * Ein COMPLETED aus der Zukunft (Uhr des Telefons vorgestellt) wäre ein Haken,
 * der erst noch passiert; dann gilt der Zeitpunkt des Laufs.
 */
function pastOrNull(iso) {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at <= Date.now() ? iso : null;
}

/**
 * Löst RELATED-TO in `tasks.parent_task_id` auf (#671).
 *
 * Läuft als zweite Phase, nachdem alle Listen eines Kontos verarbeitet sind:
 * ein VTODO kann seinen Elternteil vor sich selbst im Objektstrom haben oder
 * danach, und über Listengrenzen hinweg ohnehin. Erst wenn alle UIDs eine
 * lokale ID haben, ist die Zuordnung entscheidbar.
 *
 * Yuvomi kennt genau eine Ebene (die POST-Route weist ein Enkelkind ab), CalDAV
 * kennt beliebig tiefe Ketten. Ein Enkel wird deshalb an den obersten Vorfahren
 * gehängt statt fallen gelassen - flach unter dem falschen Kopf ist immer noch
 * eine Hierarchie, gar keine wäre der gemeldete Zustand.
 *
 * Liefert die Aufgaben, deren `parent_task_id` sich dabei geändert hat: für
 * sie stimmt der Erledigungseintrag womöglich nicht mehr (#2078,
 * applySyncedCompletions). Der Lauf ruft das in einer eigenen Transaktion,
 * damit ein Fehler mitten in der Schleife keine halbe Hierarchie hinterlässt,
 * zu der die gemeldete Menge nicht passt.
 *
 * @param {Map<string, {taskId: number, parentUid: string|null, childUids: string[]}>} seen
 * @returns {Set<number>}
 */
function applyTaskRelations(seen) {
  const idByUid = new Map([...seen].map(([uid, entry]) => [uid, entry.taskId]));

  // Beide Richtungen auf dieselbe Aussage bringen: Kind -> Elternteil.
  const parentUidOf = new Map();
  for (const [uid, entry] of seen) {
    if (entry.parentUid && idByUid.has(entry.parentUid)) parentUidOf.set(uid, entry.parentUid);
  }
  for (const [uid, entry] of seen) {
    for (const childUid of entry.childUids || []) {
      // Ein am Kind gesetztes PARENT ist die genauere Angabe und bleibt stehen.
      if (idByUid.has(childUid) && !parentUidOf.has(childUid)) parentUidOf.set(childUid, uid);
    }
  }

  /** Oberster Vorfahre, oder null bei Zyklus/Selbstbezug. */
  const rootOf = (uid) => {
    const path = new Set([uid]);
    let current = parentUidOf.get(uid);
    while (current && parentUidOf.has(current)) {
      if (path.has(current)) return null;      // Zyklus: lieber flach als falsch
      path.add(current);
      current = parentUidOf.get(current);
    }
    return current && current !== uid ? current : null;
  };

  const update = db.get().prepare('UPDATE tasks SET parent_task_id = ? WHERE id = ? AND parent_task_id IS NOT ?');
  const changed = new Set();
  for (const [uid, entry] of seen) {
    // Eine Aufgabe eines anderen Kontos (#1906) ist hier nur Elternteil.
    if (entry.foreign) continue;
    const rootUid = parentUidOf.has(uid) ? rootOf(uid) : null;
    const parentId = rootUid ? idByUid.get(rootUid) ?? null : null;
    // Auch der NULL-Fall muss geschrieben werden: wer auf dem Server aus der
    // Unterliste gezogen wurde, ist sonst in Yuvomi für immer ein Kind.
    if (update.run(parentId, entry.taskId, parentId).changes > 0) changed.add(Number(entry.taskId));
  }
  return changed;
}

function upsertShoppingItem(sel, todo, accountId, objectUrl = null) {
  const listId    = ensureShoppingList(sel);
  const isChecked = todo.completed ? 1 : 0;

  // Über alle Konten (#1906): die Liste des Kontos, das den Artikel zuerst
  // geliefert hat, gilt - auch wenn ein zweites dieselbe Server-Liste einer
  // anderen lokalen Liste zuordnet.
  const { row: existing, foreign } = rowForTodoUid(db.get(), 'shopping_items', 'outbound_move', todo.uid, accountId);
  if (foreign) return;

  // DER ARTIKEL IST HIER UMGEZOGEN, SEIN OBJEKT NOCH NICHT (#1700). Der Abruf
  // liest es am alten Platz und stellte die Zeile sonst dorthin zurück - der
  // Server folgt hier der Zeile, nicht umgekehrt. Frisch an der Zeile gelesen,
  // nicht aus dem Stand vom Anfang des Laufs: der Umzug kann eintreffen,
  // während der Lauf noch den Server liest. Nur eine fehlende Adresse wird
  // nachgetragen, ohne sie ist das Original nicht lesbar.
  if (existing?.outbound_move) {
    if (objectUrl) {
      db.get().prepare(
        'UPDATE shopping_items SET external_object_url = COALESCE(external_object_url, ?) WHERE id = ?'
      ).run(objectUrl, existing.id);
    }
    return;
  }

  let itemId;
  if (existing) {
    db.get().prepare(`
      UPDATE shopping_items
      SET name = ?, is_checked = ?, list_id = ?, external_object_url = COALESCE(?, external_object_url)
      WHERE id = ?
    `).run(todo.summary, isChecked, listId, objectUrl, existing.id);
    itemId = existing.id;
  } else {
    // category bleibt beim Spalten-Default - die Kategorie ist hier der Gang im
    // Laden, eine verwaltete Liste. CATEGORIES landet in den Tags.
    const row = db.get().prepare(`
      INSERT INTO shopping_items
        (list_id, name, is_checked, external_uid, external_source, external_account_id, external_object_url)
      VALUES (?, ?, ?, ?, 'caldav', ?, ?)
    `).run(listId, todo.summary, isChecked, todo.uid, accountId, objectUrl);
    itemId = row.lastInsertRowid;
  }

  // CATEGORIES → Tags (#586). Anders als bei Aufgaben ist das eine Einbahn-
  // straße: der Einkauf zeigt die Etiketten der Quellliste, verwaltet sie aber
  // nicht. Entsprechend nimmt icsFieldsForShoppingItem CATEGORIES nicht auf -
  // ein Push darf die Werte des Servers nicht anfassen.
  setItemTags(db.get(), itemId, todo.tags);
}

// Nur diese Tabellen dürfen geprunt werden. `table` wird interpoliert (SQLite
// erlaubt keine Bind-Parameter für Bezeichner), deshalb die harte Whitelist.
const PRUNABLE_TABLES = new Set(['tasks', 'shopping_items']);

/**
 * Entfernt lokal die gespiegelten VTODO-Einträge, die der Server nicht mehr liefert.
 *
 * Leer-Guard (#508): eine leere UID-Liste bedeutet **nicht** "alles löschen". Ein
 * leeres Ergebnis ist weit häufiger ein stiller Server- oder Auth-Fehler als eine
 * tatsächlich geleerte Liste, und der Preis für die falsche Annahme wäre der
 * Totalverlust aller gespiegelten Aufgaben des Accounts — samt Unteraufgaben,
 * Zuweisungen und Dokument-Verknüpfungen, die per CASCADE mitgehen. Der Preis für
 * den Guard: eine wirklich geleerte Liste behält ihre lokalen Einträge, bis sie von
 * Hand entfernt werden.
 *
 * Der Aufrufer muss zusätzlich sicherstellen, dass **jede** Liste dieses Moduls
 * erfolgreich abgerufen wurde: `tasks`/`shopping_items` tragen nur die Account-ID,
 * nicht die Listen-URL, also lässt sich ein Prune nicht auf eine einzelne Liste
 * eingrenzen.
 *
 * @returns {number} Anzahl gelöschter Einträge.
 */
/**
 * Markiert die Zeilen dieses Kontos, deren UID ein Abruf geliefert hat, als
 * gesehen (#1839). Unabhängig vom Prune: auch ein Lauf, der wegen einer nicht
 * abgerufenen Liste nicht prunt, hat die übrigen gesehen.
 */
export function markSeen(database, table, accountId, seenUids) {
  if (!PRUNABLE_TABLES.has(table)) {
    throw new Error(`markSeen: refusing to mark unknown table "${table}".`);
  }
  const seen = new Set(seenUids);
  if (!seen.size) return;
  const rows = database.prepare(
    `SELECT id, external_uid FROM ${table}
     WHERE external_source = 'caldav' AND external_account_id = ? AND seen_on_server = 0`
  ).all(accountId);
  const mark = database.prepare(`UPDATE ${table} SET seen_on_server = 1 WHERE id = ?`);
  for (const row of rows) if (seen.has(row.external_uid)) mark.run(row.id);
}

/**
 * @param {string[]} [keepUids]  UIDs, die nicht fallen, ohne gesehen zu sein
 *        (ein wartender Umzug aus einer nicht abgerufenen Liste, #1700)
 */
export function pruneRemoved(database, table, accountId, seenUids, keepUids = []) {
  if (!PRUNABLE_TABLES.has(table)) {
    throw new Error(`pruneRemoved: refusing to prune unknown table "${table}".`);
  }

  const uids = [...new Set([...seenUids, ...keepUids])];

  if (uids.length === 0) {
    const remaining = database.prepare(
      `SELECT COUNT(*) AS count FROM ${table}
       WHERE external_source = 'caldav' AND external_account_id = ?`
    ).get(accountId).count;

    if (remaining > 0) {
      log.warn(
        `Account ${accountId}: server returned no reminders, but ${remaining} ${table} row(s) ` +
        `exist locally. Skipping deletion — assuming a fetch error rather than an emptied list.`
      );
    }
    return 0;
  }

  // Gesehen (#1839): was dieser Abruf liefert, ist ab jetzt belegt gespiegelt.
  markSeen(database, table, accountId, seenUids);
  const seen = new Set(uids);
  const rows = database.prepare(
    `SELECT id, external_uid, seen_on_server FROM ${table}
     WHERE external_source = 'caldav' AND external_account_id = ?`
  ).all(accountId);

  // NUR WAS GESEHEN WURDE, FÄLLT (#1839), wie beim Termin (`pruneDeletedEvents`):
  // eine nie gesehene, hier angelegte Zeile geht zurück auf lokal und erneut
  // hinauf, eine fremde bleibt stehen.
  const kind = table === 'tasks' ? 'task' : 'item';
  const del = database.prepare(`DELETE FROM ${table} WHERE id = ?`);
  let removed = 0;
  let restored = 0;
  for (const row of rows) {
    if (seen.has(row.external_uid)) continue;
    if (row.seen_on_server) {
      removed += Number(del.run(row.id).changes);
    } else if (createdHere(database, row.external_uid, kind, row.id)) {
      restored += todoBackToLocal(database, table, row, accountId);
    }
  }
  if (restored) {
    log.warn(`Account ${accountId}: ${restored} ${table} row(s) created here were never seen on the server; they are local again and are uploaded once more.`);
  }
  return removed;
}

/**
 * Macht eine nie gesehene, hier angelegte Aufgabe oder einen Einkaufsartikel
 * wieder lokal (#1839). Die Aufgabe bekommt ihr Ziel zurück - Konto und die
 * Liste, in der ihr Objekt liegen sollte -, der Artikel braucht keines: die
 * Zuordnung seiner Liste ist das Ziel. Der nächste Upload trägt dieselbe UID;
 * liegt das Objekt doch oben, übernimmt er es (412).
 * @returns {number} 1, wenn die Zeile zurückgesetzt wurde
 */
function todoBackToLocal(database, table, row, accountId) {
  const objectUrl = database.prepare(`SELECT external_object_url FROM ${table} WHERE id = ?`).get(row.id)?.external_object_url;
  const derived = collectionUrlOf(objectUrl || '') || null;
  // Das Ziel in der Schreibweise der Auswahl (Review): die Uploads suchen die
  // Liste mit genau dieser URL, und eine Liste ohne Schlussstrich fände sich
  // unter der abgeleiteten sonst nicht - die Aufgabe bliebe für immer lokal.
  const trim = (url) => String(url || '').replace(/\/+$/, '');
  const listUrl = derived && table === 'tasks'
    ? database.prepare(
      "SELECT list_url FROM caldav_reminder_selection WHERE account_id = ? AND target_module = 'tasks'"
    ).all(accountId).map((r) => r.list_url).find((url) => trim(url) === trim(derived)) ?? derived
    : derived;
  const target = table === 'tasks'
    ? `target_caldav_account_id = ${listUrl ? '?' : 'NULL'}, target_caldav_list_url = ${listUrl ? '?' : 'NULL'},`
    : 'outbound_move = 0, outbound_move_attempts = 0, outbound_move_since = NULL, outbound_move_by = NULL,';
  const args = table === 'tasks' && listUrl ? [accountId, listUrl] : [];
  return Number(database.prepare(`
    UPDATE ${table}
       SET external_source = 'local', external_uid = NULL, external_account_id = NULL,
           external_object_url = NULL, ${target}
           outbound_dirty = 0, outbound_attempts = 0, seen_on_server = 0
     WHERE id = ? AND external_source = 'caldav'
  `).run(...args, row.id).changes);
}

// --------------------------------------------------------
// Sync (inbound + Rückrichtung, #617)
// --------------------------------------------------------

/**
 * Ein Sync-Lauf, serialisiert gegen den Sofortversuch der VTODO-Rückrichtung und
 * gegen sich selbst (#593) - dieselbe Regel wie beim Kalender, eigener
 * Schlüssel: Aufgaben und Einkauf führen ihre Buchhaltung in eigenen Tabellen.
 */
async function sync(opts = {}) {
  return runSerialized('caldav-todo', 'sync', () => runSync(opts));
}

// Konto → Zahl der wartenden Aufträge, die zuletzt gemeldet wurde: im
// Standard-Log steht der Zustand, wenn er sich ändert, nicht bei jedem Lauf.
const reportedWaiting = new Map();

/**
 * Meldet, wie viele Löschaufträge dieses Kontos auf eine abgewählte Liste
 * warten (#1884).
 */
function reportWaitingDeletions(account) {
  const waiting = todoOutbound.deletionsWaitingForSelection(account.id).length;
  const before = reportedWaiting.get(account.id) || 0;
  reportedWaiting.set(account.id, waiting);
  if (!waiting) return;
  const line = `Account ${account.id} ("${account.name}"): ${waiting} pending deletion(s) wait for a reminder list that is not selected. `
    + 'Nothing is deleted there while it is switched off; they are carried out once it is selected again and dropped if it no longer exists on the server.';
  if (waiting !== before) log.info(line);
  else log.debug(line);
}

async function runSync({ createClient: makeClient } = {}) {
  const accounts = getAllAccounts();
  if (accounts.length === 0) {
    return { success: true, syncedAccounts: 0, syncedItems: 0 };
  }

  // Client-Factory injizierbar (Tests), Default = echter tsdav-Client.
  const clientFactory = makeClient || createClient;
  // Die Quelle einer Mitnahme (#1700) kann ein anderes Konto sein.
  const clientFor = async (id) => {
    const other = getAccountById(id);
    return other ? todoOutbound.createTodoClient(other, clientFactory) : null;
  };

  let totalItems       = 0;
  let totalPushed      = 0;
  let successfulAccounts = 0;

  // Standard-Personen je Liste (#1221), einmal je Lauf aufgeloest.
  const listAssignees = new Map();

  for (const account of accounts) {
    try {
      const enabledLists = db.get().prepare(`
        SELECT * FROM caldav_reminder_selection WHERE account_id = ? AND enabled = 1
      `).all(account.id);

      // Ohne eingeschaltete Liste gibt es nichts abzurufen. Wartet aber ein
      // Löschauftrag auf eine abgewählte (#1884), fragt der Lauf trotzdem die
      // Auflistung ab: nur sie sagt, ob es die Liste noch gibt.
      // Dasselbe für einen Umzug in eine abgewählte Liste (#1700) und für einen
      // Umzug AUS einer Liste dieses Kontos (#1911): sein Warten endet hier.
      const waitsForSelection = todoOutbound.deletionsWaitingForSelection(account.id).length > 0
        || todoOutbound.movesWaitingForSelection(account.id) > 0
        || todoOutbound.movesFromAccount(account.id) > 0;
      if (enabledLists.length === 0 && !waitsForSelection) continue;

      // Gezielte Anfragen nur an den Server dieses Kontos (`createTodoClient`).
      const client     = await todoOutbound.createTodoClient(account, clientFactory);
      const serverCals  = await client.fetchCalendars();

      if (enabledLists.length === 0) {
        // Eine leere Auflistung sagt auch hier nichts.
        if (serverCals.length > 0) {
          todoOutbound.dropDeletionsOfMissingLists(account.id, serverCals.map((c) => c.url));
          todoOutbound.returnMovesIntoMissingLists(account.id, serverCals.map((c) => c.url));
        }
        // Umzüge aus den Listen dieses Kontos (#1911): auch ohne eingeschaltete
        // Liste fällt ein Umzug ohne Ziel, und ein wartender bekommt sein Ende.
        todoOutbound.releaseStrandedShoppingMoves(account.id);
        todoOutbound.endWaitingShoppingMoves(account.id, serverCals.map((c) => c.url));
        reportWaitingDeletions(account);
        continue;
      }
      // Der Server nennt KEINE Collection, obwohl Listen ausgewählt sind: das
      // ist eine unvollständige Antwort (ein Multistatus, der nur die
      // Home-Collection nennt oder jede Ressource mit 403 quittiert), kein
      // leeres Konto. Derselbe Leer-Guard wie beim Prune (#508) - sonst gälte
      // jede Liste als verschwunden und würde abgeschaltet.
      if (serverCals.length === 0) {
        log.warn(
          `Account ${account.id}: the server listed no collections, but ${enabledLists.length} reminder ` +
          `list(s) are selected. Skipping this run - assuming an incomplete answer rather than a deleted account.`
        );
        continue;
      }
      // Schreibrechte je Liste für die Zielauswahl der Formulare (#1840).
      rememberListWritability(account.id, serverCals);
      // Löschaufträge für Listen, die der Server nicht mehr nennt, haben ihr
      // Ziel erreicht (#1884). Vor dem Lesen der Aufträge für den Abruf unten.
      todoOutbound.dropDeletionsOfMissingLists(account.id, serverCals.map((c) => c.url));
      // Ein Umzug in eine Liste, die der Server nicht mehr nennt, geht zurück (#1700).
      todoOutbound.returnMovesIntoMissingLists(account.id, serverCals.map((c) => c.url));
      // Ein Umzug aus einer Liste, die der Server nicht mehr nennt oder die zu
      // lange abgeschaltet ist, bekommt sein Ende (#1911).
      todoOutbound.endWaitingShoppingMoves(account.id, serverCals.map((c) => c.url));

      const owner       = db.get().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
      const createdBy   = owner ? owner.id : 1;

      const seenByModule = { tasks: [], shopping: [] };
      // #508: Module, bei denen mindestens eine Liste nicht abgerufen werden konnte,
      // dürfen nicht geprunt werden. tasks/shopping_items tragen nur die Account-ID,
      // nicht die Listen-URL — ein Prune träfe sonst auch die Einträge der Liste, die
      // gerade nur wegen eines Server-Fehlers leer aussieht.
      const incompleteModules = new Set();

      // Ein Umzug, dessen Zielliste gar keinen Platz auf einem Server mehr hat
      // (#1700), wird zum Löschen am Server - vor dem Lesen der Aufträge.
      todoOutbound.releaseStrandedShoppingMoves(account.id);

      // Ausstehende Rückrichtung einmal je Lauf und Modul (#617): eine lokal
      // gelöschte Aufgabe darf der Inbound nicht wieder anlegen, eine lokal
      // bearbeitete nicht mit dem alten Serverstand überschreiben.
      const pendingByModule = {
        tasks: {
          deleted: todoOutbound.pendingDeletionUids(account.id, 'tasks'),
          dirty:   todoOutbound.pendingUpdateUids(account.id, 'tasks'),
        },
        shopping: {
          deleted: todoOutbound.pendingDeletionUids(account.id, 'shopping'),
          dirty:   todoOutbound.pendingUpdateUids(account.id, 'shopping'),
        },
      };
      // UID → Kalenderobjekt dieses Laufs. Ausgehende Löschungen brauchen dessen
      // URL, Änderungen zusätzlich seinen Originalinhalt zum Patchen.
      const objectsByModule = { tasks: new Map(), shopping: new Map() };
      // UID → lokale Aufgabe dieses Laufs, für die Hierarchie-Auflösung nach
      // allen Listen (#671). Nur Aufgaben: der Einkauf kennt keine Unterposten.
      const taskRelations = new Map();
      // Statuswechsel dieses Laufs je Aufgabe (#1836), erst nach der Hierarchie
      // geschrieben (applySyncedCompletions).
      const completionTransitions = new Map();

      for (const sel of enabledLists) {
        const module = sel.target_module === 'shopping' ? 'shopping' : 'tasks';
        const serverCal = serverCals.find(c => c.url === sel.list_url);
        if (!serverCal) {
          log.warn(`Reminder list ${sel.list_url} not found on server, disabling.`);
          db.get().prepare('UPDATE caldav_reminder_selection SET enabled = 0 WHERE id = ?').run(sel.id);
          incompleteModules.add(module);
          continue;
        }

        let objects;
        try {
          objects = await client.fetchCalendarObjects({ calendar: serverCal, filters: VTODO_FILTERS });
        } catch (err) {
          log.error(`Failed to fetch VTODOs from "${sel.list_name}":`, err.message);
          incompleteModules.add(module);
          continue;
        }

        for (const obj of objects) {
          const todos = parseVTODO(obj.data || '');
          for (const todo of todos) {
            try {
              // Für dieses Objekt steht die Notiz eines Uploads, der nie
              // gebucht wurde (#1882) - gleich über welches Konto er lief.
              // Dann ist es kein Eintrag wie jeder andere: wartet seine Zeile
              // genau hier, wird es übernommen; sonst wird es weder
              // importiert noch einer Zeile zugeordnet (gelöscht, anderes
              // Ziel, woanders gespiegelt, oder sie wartet über ein anderes
              // Konto), und es kommt auch nicht in den Index dieses Laufs -
              // dieselbe UID kann rechtmässig in einer anderen Liste des
              // Kontos liegen. Entfernt wird es von
              // `releaseLeftoverTodoUploads`. Frisch gefragt: die Zeile kann
              // gefallen sein, während dieser Lauf noch liest.
              const unbooked = todoOutbound.isUnbookedOwnUpload(module, todo.uid, sel.list_url);
              // Der eigene Upload, dessen Antwort verloren ging: in die noch
              // lokale Zeile übernehmen statt eine zweite anzulegen; ihr
              // lokaler Stand geht mit dem Outbound dieses Laufs hinauf. Nur
              // für eine Zeile, die auf den Upload in GENAU diese Liste
              // wartet - die UID kommt vom Server und weist nichts aus.
              const adoptOwn = () => !!obj.url && todoOutbound.adoptOwnUpload(module, todo.uid, account.id, obj.url, {
                listUrl: sel.list_url, targetListId: sel.target_list_id,
              });
              //
              // Ein übersprungener Rest zählt NICHT als gesehen (#1905): er
              // gehört zu keiner Zeile. Ist seine Zeile inzwischen in einer
              // anderen Liste des Kontos Spiegel derselben UID und wurde sie
              // dort auf dem Server gelöscht, hielte der Rest sie sonst fest -
              // einen Lauf lang, und so lange der Server sein Entfernen
              // ablehnt, bis zum Ende der Frist der Notiz.
              // Die eine Ausnahme ist der Einkaufsartikel, der anderswo
              // Spiegel derselben UID ist (#1700): fehlt seine Kopie dort,
              // ist dieses Objekt das letzte, und die Zeile geht nach dem
              // Prune zu ihm zurück (`confirmCarriedCopy`).
              if (unbooked && !adoptOwn()) {
                if (todoOutbound.leftoverHoldsCarriedItem(todo.uid, sel.list_url)) {
                  seenByModule.shopping.push(todo.uid);
                }
                continue;
              }

              // Gesehen ist der Eintrag auch dann, wenn er weiter unten
              // übersprungen wird (lokal gelöscht, lokal bearbeitet) - sonst
              // würde der Prune ihn gleich wieder entfernen.
              seenByModule[module].push(todo.uid);

              if (obj.url) {
                objectsByModule[module].set(todo.uid, {
                  url: obj.url, etag: obj.etag, data: obj.data,
                });
              }
              if (unbooked) {
                totalItems++;
                continue;
              }

              // Lokal gelöscht und noch nicht auf dem Server: nicht wieder
              // anlegen, sonst kehrt der Eintrag bei jedem Sync zurück.
              if (pendingByModule[module].deleted.has(todo.uid)) continue;
              // Lokale Bearbeitung wartet auf ihren Push: der alte Serverstand
              // darf sie nicht überschreiben.
              if (pendingByModule[module].dirty.has(todo.uid)) continue;

              if (adoptOwn()) {
                totalItems++;
                continue;
              }

              if (module === 'shopping') {
                upsertShoppingItem(sel, todo, account.id, obj.url || null);
              } else {
                if (!listAssignees.has(sel.id)) listAssignees.set(sel.id, readDefaultAssignees(db.get(), 'reminderList', sel.id));
                const taskId = upsertTask(todo, account.id, createdBy, obj.url || null, {
                  completions: completionTransitions,
                  defaultAssignees: listAssignees.get(sel.id),
                });
                // Die Aufgabe gehört einem anderen Konto (#1906): dessen
                // Abruf verdrahtet IHRE Hierarchie. Als Elternteil eigener
                // Kinder bleibt sie auffindbar (Review), geändert wird sie
                // hier nicht (`foreign`).
                if (taskId == null) {
                  const owned = db.get().prepare(
                    "SELECT id FROM tasks WHERE external_uid = ? AND external_source = 'caldav' ORDER BY id LIMIT 1"
                  ).get(todo.uid);
                  if (owned) taskRelations.set(todo.uid, { taskId: owned.id, parentUid: null, childUids: todo.childUids || [], foreign: true });
                  totalItems++;
                  continue;
                }
                taskRelations.set(todo.uid, {
                  taskId,
                  parentUid: todo.parentUid || null,
                  childUids: todo.childUids || [],
                });
              }
              totalItems++;
            } catch (err) {
              log.error(`Failed to upsert VTODO ${todo.uid}:`, err.message);
            }
          }
        }
      }

      // Unteraufgaben verdrahten, sobald alle Listen des Kontos gelesen sind
      // (#671) - vorher ist die UID des Elternteils womöglich noch keine ID.
      // Hierarchie und Erledigungen in EINER Transaktion (#2078): stürbe der
      // Lauf dazwischen, sähe der nächste den neuen Elternteil als
      // unverändert, und der Eintrag bliebe für immer falsch. Jede Hälfte
      // ist ein eigener Savepoint, ein Fehler in einer lässt die andere stehen.
      db.get().transaction(() => {
        let reparented = new Set();
        if (taskRelations.size > 0) {
          try {
            reparented = db.get().transaction(() => applyTaskRelations(taskRelations))();
          } catch (err) {
            log.error(`Failed to apply VTODO relations for account ${account.id}:`, err.message);
          }
        }
        try {
          applySyncedCompletions(db.get(), completionTransitions, reparented);
        } catch (err) {
          log.error(`Failed to record synced task completions for account ${account.id}:`, err.message);
        }
      })();

      // Prune locally-stored caldav items that vanished remotely.
      // Module mit einer nicht abgerufenen Liste werden übersprungen (#508).
      const hasTasks    = enabledLists.some(s => s.target_module === 'tasks');
      const hasShopping = enabledLists.some(s => s.target_module === 'shopping');

      if (hasTasks) {
        if (incompleteModules.has('tasks')) {
          log.warn(`Account ${account.id}: a reminder list could not be fetched, skipping task deletion.`);
          markSeen(db.get(), 'tasks', account.id, seenByModule.tasks);
        } else {
          pruneRemoved(db.get(), 'tasks', account.id, seenByModule.tasks);
        }
      }

      if (hasShopping) {
        if (incompleteModules.has('shopping')) {
          log.warn(`Account ${account.id}: a reminder list could not be fetched, skipping shopping deletion.`);
          markSeen(db.get(), 'shopping_items', account.id, seenByModule.shopping);
        } else {
          // Ein wartender Umzug, dessen Objekt in einer nicht abgerufenen
          // Liste liegt (#1700), ist nicht "auf dem Server gelöscht".
          //
          // NUR ZUSÄTZLICH zu dem, was der Server geliefert hat. Hat er nichts
          // geliefert, bleibt die Liste leer und der Leer-Guard von
          // `pruneRemoved` (#508) greift: eine einzige hier ergänzte UID
          // machte sonst aus "nichts gesehen" ein "alles andere ist fort", und
          // der Prune räumte jeden Einkaufsartikel des Kontos ab.
          // Scheitert das Lesen der wartenden Umzüge, geht der Fehler hoch und
          // dieser Lauf prunt gar nicht - es gibt hier keinen leeren Ersatzwert.
          // Gelesen heisst: als Einkaufsliste gelesen. Eine inzwischen den
          // Aufgaben zugeordnete Quelle liefert ihre UID nur an die Aufgaben
          // (#1911), für den Einkauf bleibt sie ungelesen.
          const shielded = seenByModule.shopping.length
            ? todoOutbound.uidsOfMovesFromUnfetchedLists(
              account.id,
              enabledLists.filter((s) => s.target_module === 'shopping').map((s) => s.list_url),
            )
            : [];
          // `shielded` hält, ohne als gesehen zu gelten (#1839).
          pruneRemoved(db.get(), 'shopping_items', account.id, seenByModule.shopping, shielded);
        }
      }

      // Rückrichtung (#617). Nach dem Inbound, weil der Weg zum Objekt für
      // Bestandseinträge erst aus dessen Abruf bekannt wird; der Inbound
      // überspringt dafür alles, was hier noch aussteht.
      //
      // `complete` heißt: jede Liste dieses Moduls wurde abgerufen. Nur dann ist
      // ein Tombstone ohne auffindbares Objekt wirklich erledigt statt bloß
      // unerreichbar - dieselbe Vorsicht wie beim Prune (#508).
      // Ein Stoppsignal für jede schreibende Phase aller Module dieses Kontos
      // (#1863, #2135): Löschen, Ändern, Aufräumen, Uploads und Mitnahmen.
      const stop = createRefusalStop();
      for (const module of ['tasks', 'shopping']) {
        const complete = !incompleteModules.has(module);
        try {
          const removed = await todoOutbound.processPendingDeletions(
            client, account.id, module, objectsByModule[module], complete, { stop }
          );
          const pushed = await todoOutbound.processPendingUpdates(
            client, account.id, module, objectsByModule[module], { stop }
          );
          totalPushed += pushed;
          if (removed) log.info(`${removed} pending VTODO deletion(s) applied on the server.`);
          if (pushed)  log.info(`${pushed} local VTODO change(s) pushed to the server.`);
        } catch (err) {
          log.error(`Outbound VTODO changes failed for account ${account.id} (${module}):`, err.message);
        }
      }

      reportWaitingDeletions(account);

      // Die Reste nie bestätigter Uploads entfernen (#1882). Nach dem Abruf,
      // der sie nicht importiert hat, und vor den Uploads: eine Zeile mit
      // neuem Ziel in diesem Konto geht so nicht neben ihren Rest.
      try {
        const cleared = await todoOutbound.releaseLeftoverTodoUploads(client, account.id, { clientFor, stop });
        if (cleared) log.info(`${cleared} leftover(s) of unconfirmed uploads removed from the server.`);
      } catch (err) {
        log.error(`Removing leftovers of unconfirmed uploads failed for account ${account.id}:`, err.message);
      }

      // Hier angelegte Aufgaben hochladen (#695). Bewusst als LETZTER Schritt:
      // bis hierher ist der Prune gelaufen, und der sieht eine Aufgabe, die
      // gerade erst zum Spiegel geworden ist, in diesem Lauf noch nicht auf dem
      // Server - er würde sie also sofort wieder entfernen. Die Listen stammen
      // aus dem Abruf oben, es kommt kein zweiter hinzu.
      try {
        const taskLists = new Map(
          enabledLists
            .filter((s) => s.target_module !== 'shopping')
            .map((s) => [s.list_url, serverCals.find((c) => c.url === s.list_url)])
            .filter(([, cal]) => cal)
        );
        const created = await todoOutbound.processPendingCreations(
          client, account.id, 'tasks', taskLists, { stop }
        );
        totalPushed += created;
        if (created) log.info(`${created} locally created task(s) uploaded to the server.`);
      } catch (err) {
        log.error(`Uploading local tasks failed for account ${account.id}:`, err.message);
      }

      // Dasselbe für den Einkauf (#831). Ein Artikel trägt kein eigenes Ziel -
      // die Zuordnung Server-Liste ↔ Yuvomi-Liste ist die Zielangabe, also
      // reicht sie hier hinein.
      try {
        const shoppingSelections = enabledLists.filter((s) => s.target_module === 'shopping');
        const shoppingLists = new Map(
          shoppingSelections
            .map((s) => [s.list_url, serverCals.find((c) => c.url === s.list_url)])
            .filter(([, cal]) => cal)
        );
        const created = await todoOutbound.processPendingShoppingCreations(
          client,
          account.id,
          shoppingSelections.map((s) => ({ listUrl: s.list_url, targetListId: s.target_list_id })),
          shoppingLists,
          { stop }
        );
        totalPushed += created;
        if (created) log.info(`${created} locally created shopping item(s) uploaded to the server.`);
      } catch (err) {
        log.error(`Uploading local shopping items failed for account ${account.id}:`, err.message);
      }

      // Umgezogene Einkaufsartikel nehmen ihr Objekt mit (#1700). Ebenfalls
      // nach dem Prune: die Zeile zeigt danach auf ein Objekt, das dieser Lauf
      // in der neuen Liste noch nicht gelesen hat.
      try {
        const targets = db.get().prepare(`
          SELECT list_url, target_list_id FROM caldav_reminder_selection
           WHERE account_id = ? AND enabled = 1 AND target_module = 'shopping' AND target_list_id IS NOT NULL
        `).all(account.id);
        const lists = new Map(
          targets.map((s) => [s.list_url, serverCals.find((c) => c.url === s.list_url)]).filter(([, cal]) => cal)
        );
        const carried = await todoOutbound.processPendingShoppingMoves(
          client,
          account.id,
          targets.map((s) => ({ listUrl: s.list_url, targetListId: s.target_list_id })),
          lists,
          { clientFor, stop }
        );
        totalPushed += carried;
        if (carried) log.info(`${carried} moved shopping item(s) carried to their new list on the server.`);
      } catch (err) {
        log.error(`Carrying moved shopping items failed for account ${account.id}:`, err.message);
      }

      db.get().prepare('UPDATE caldav_accounts SET last_sync = ? WHERE id = ?')
        .run(new Date().toISOString(), account.id);
      successfulAccounts++;
    } catch (err) {
      log.error(`Reminders sync failed for account ${account.id}:`, err.message);
    }
  }

  log.info(`CalDAV reminders sync complete: ${successfulAccounts}/${accounts.length} accounts, ${totalItems} items.`);
  return {
    success: true,
    syncedAccounts: successfulAccounts,
    syncedItems: totalItems,
    pushedItems: totalPushed,
  };
}

function getStatus() {
  const accounts = getAllAccounts();

  const accountStatus = accounts.map(acc => {
    const enabledLists = db.get().prepare(
      'SELECT COUNT(*) AS c FROM caldav_reminder_selection WHERE account_id = ? AND enabled = 1'
    ).get(acc.id).c;
    return {
      id:           acc.id,
      name:         acc.name,
      lastSync:     acc.last_sync,
      enabledLists,
    };
  });

  const totalEnabledLists = db.get().prepare(
    'SELECT COUNT(*) AS c FROM caldav_reminder_selection WHERE enabled = 1'
  ).get().c;

  return {
    accounts: accountStatus,
    totalAccounts: accounts.length,
    totalEnabledLists,
  };
}

// --------------------------------------------------------
// Exports
// --------------------------------------------------------

export {
  mapVtodoPriority,
  mapVtodoStatus,
  upsertTask,
  applySyncedCompletions,
  splitDue,
  applyTaskRelations,
  getReminderLists,
  updateReminderSelection,
  sync,
  getStatus,
};
