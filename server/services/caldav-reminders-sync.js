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
import { createCalDAVClient, supportsComponent } from '../utils/caldav-client.js';
import { householdTimeZone, utcToWall } from '../utils/timezone.js';
import { setItemTags, setTags } from '../utils/task-tags.js';
import * as todoOutbound from './caldav-todo-outbound.js';
import { runSerialized } from '../utils/sync-lock.js';

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
      SELECT list_url, list_name, target_module, enabled
      FROM caldav_reminder_selection
      WHERE account_id = ?
      ORDER BY list_name
    `).all(accountId);

    return rows.map(r => ({
      listUrl:      r.list_url,
      listName:     r.list_name,
      targetModule: r.target_module,
      enabled:      r.enabled === 1,
    }));
  }

  // Refresh from server, preserving existing enabled/target_module settings
  const client    = await (makeClient || createClient)(account);
  const calendars = await client.fetchCalendars();
  const lists     = calendars.filter(isReminderCollection);

  const result = [];
  for (const cal of lists) {
    const name     = cal.displayName || 'Reminders';
    const existing = db.get().prepare(
      'SELECT target_module, enabled FROM caldav_reminder_selection WHERE account_id = ? AND list_url = ?'
    ).get(accountId, cal.url);

    const targetModule = existing ? existing.target_module : 'tasks';
    const enabled      = existing ? existing.enabled : 0;

    db.get().prepare(`
      INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, list_url) DO UPDATE SET list_name = excluded.list_name
    `).run(accountId, cal.url, name, targetModule, enabled);

    result.push({ listUrl: cal.url, listName: name, targetModule, enabled: enabled === 1 });
  }

  db.get().prepare(`
    UPDATE caldav_accounts
       SET reminders_discovered_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ?
  `).run(accountId);

  log.info(`Discovered ${result.length} reminder list(s) for account ${accountId}.`);
  return result;
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

function updateReminderSelection(accountId, listUrl, { enabled, targetModule } = {}) {
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

  let targetListId = sel.target_list_id;
  if (newModule === 'shopping' && newEnabled === 1) {
    targetListId = ensureShoppingList(sel);
  }

  db.get().prepare(`
    UPDATE caldav_reminder_selection
    SET enabled = ?, target_module = ?, target_list_id = ?
    WHERE account_id = ? AND list_url = ?
  `).run(newEnabled, newModule, targetListId, accountId, listUrl);

  log.info(`Reminder selection updated: account ${accountId}, list ${listUrl}, module=${newModule}, enabled=${newEnabled}`);
  return { success: true };
}

// --------------------------------------------------------
// Upsert Helpers (Inbound: Server → Yuvomi)
// --------------------------------------------------------

// Die Objekt-URL (obj.url des Abrufs) wandert bei jedem Upsert mit: ohne sie ist
// ein gespiegelter Eintrag für spätere Änderungen und Löschungen unerreichbar
// (#617). COALESCE, weil ein Abruf ohne URL den gespeicherten Wert nicht
// entwerten darf.
function upsertTask(todo, accountId, createdBy, objectUrl = null) {
  const { date, time } = splitDue(todo.due, householdTimeZone(db.get()));

  const existing = db.get().prepare(
    `SELECT id, priority, status FROM tasks WHERE external_uid = ? AND external_source = 'caldav' AND external_account_id = ?`
  ).get(todo.uid, accountId);

  const priority = mapVtodoPriority(todo.priority, existing?.priority);
  const status   = mapVtodoStatus(todo, existing?.status);

  let taskId;
  if (existing) {
    db.get().prepare(`
      UPDATE tasks
      SET title = ?, description = ?, priority = ?, status = ?, due_date = ?, due_time = ?,
          external_object_url = COALESCE(?, external_object_url)
      WHERE id = ?
    `).run(todo.summary, todo.description, priority, status, date, time, objectUrl, existing.id);
    taskId = existing.id;
  } else {
    // category bleibt beim Spalten-Default 'misc' (v114) - VTODO kennt keine
    // Entsprechung, und CATEGORIES ist die Tag-Liste, nicht die Schublade.
    const row = db.get().prepare(`
      INSERT INTO tasks
        (title, description, priority, status, due_date, due_time, created_by, external_uid, external_source, external_account_id, external_object_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'caldav', ?, ?)
    `).run(todo.summary, todo.description, priority, status, date, time, createdBy, todo.uid, accountId, objectUrl);
    taskId = row.lastInsertRowid;
  }

  // CATEGORIES → Tags (#586). Der Server führt sie, also gewinnt er auch: eine
  // lokale Bearbeitung, die noch aussteht, kommt hier gar nicht an - der
  // Aufrufer überspringt dirty markierte Einträge (#617).
  setTags(db.get(), taskId, todo.tags);
  return taskId;
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
 * @param {Map<string, {taskId: number, parentUid: string|null, childUids: string[]}>} seen
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
  for (const [uid, entry] of seen) {
    const rootUid = parentUidOf.has(uid) ? rootOf(uid) : null;
    const parentId = rootUid ? idByUid.get(rootUid) ?? null : null;
    // Auch der NULL-Fall muss geschrieben werden: wer auf dem Server aus der
    // Unterliste gezogen wurde, ist sonst in Yuvomi für immer ein Kind.
    update.run(parentId, entry.taskId, parentId);
  }
}

function upsertShoppingItem(sel, todo, accountId, objectUrl = null) {
  const listId    = ensureShoppingList(sel);
  const isChecked = todo.completed ? 1 : 0;

  const existing = db.get().prepare(
    `SELECT id FROM shopping_items WHERE external_uid = ? AND external_source = 'caldav' AND external_account_id = ?`
  ).get(todo.uid, accountId);

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
export function pruneRemoved(database, table, accountId, seenUids) {
  if (!PRUNABLE_TABLES.has(table)) {
    throw new Error(`pruneRemoved: refusing to prune unknown table "${table}".`);
  }

  const uids = [...new Set(seenUids)];

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

  const placeholders = uids.map(() => '?').join(',');
  const result = database.prepare(
    `DELETE FROM ${table}
     WHERE external_source = 'caldav' AND external_account_id = ?
       AND external_uid NOT IN (${placeholders})`
  ).run(accountId, ...uids);

  return result.changes;
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

async function runSync({ createClient: makeClient } = {}) {
  const accounts = getAllAccounts();
  if (accounts.length === 0) {
    return { success: true, syncedAccounts: 0, syncedItems: 0 };
  }

  // Client-Factory injizierbar (Tests), Default = echter tsdav-Client.
  const clientFactory = makeClient || createClient;

  let totalItems       = 0;
  let totalPushed      = 0;
  let successfulAccounts = 0;

  for (const account of accounts) {
    try {
      const enabledLists = db.get().prepare(`
        SELECT * FROM caldav_reminder_selection WHERE account_id = ? AND enabled = 1
      `).all(account.id);

      if (enabledLists.length === 0) continue;

      const client     = await clientFactory(account);
      const serverCals  = await client.fetchCalendars();
      const owner       = db.get().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
      const createdBy   = owner ? owner.id : 1;

      const seenByModule = { tasks: [], shopping: [] };
      // #508: Module, bei denen mindestens eine Liste nicht abgerufen werden konnte,
      // dürfen nicht geprunt werden. tasks/shopping_items tragen nur die Account-ID,
      // nicht die Listen-URL — ein Prune träfe sonst auch die Einträge der Liste, die
      // gerade nur wegen eines Server-Fehlers leer aussieht.
      const incompleteModules = new Set();

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
              if (obj.url) {
                objectsByModule[module].set(todo.uid, {
                  url: obj.url, etag: obj.etag, data: obj.data,
                });
              }
              // Gesehen ist der Eintrag auch dann, wenn er hier übersprungen
              // wird - sonst würde der Prune ihn gleich wieder entfernen.
              seenByModule[module].push(todo.uid);

              // Lokal gelöscht und noch nicht auf dem Server: nicht wieder
              // anlegen, sonst kehrt der Eintrag bei jedem Sync zurück.
              if (pendingByModule[module].deleted.has(todo.uid)) continue;
              // Lokale Bearbeitung wartet auf ihren Push: der alte Serverstand
              // darf sie nicht überschreiben.
              if (pendingByModule[module].dirty.has(todo.uid)) continue;

              if (module === 'shopping') {
                upsertShoppingItem(sel, todo, account.id, obj.url || null);
              } else {
                const taskId = upsertTask(todo, account.id, createdBy, obj.url || null);
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
      if (taskRelations.size > 0) {
        try {
          applyTaskRelations(taskRelations);
        } catch (err) {
          log.error(`Failed to apply VTODO relations for account ${account.id}:`, err.message);
        }
      }

      // Prune locally-stored caldav items that vanished remotely.
      // Module mit einer nicht abgerufenen Liste werden übersprungen (#508).
      const hasTasks    = enabledLists.some(s => s.target_module === 'tasks');
      const hasShopping = enabledLists.some(s => s.target_module === 'shopping');

      if (hasTasks) {
        if (incompleteModules.has('tasks')) {
          log.warn(`Account ${account.id}: a reminder list could not be fetched, skipping task deletion.`);
        } else {
          pruneRemoved(db.get(), 'tasks', account.id, seenByModule.tasks);
        }
      }

      if (hasShopping) {
        if (incompleteModules.has('shopping')) {
          log.warn(`Account ${account.id}: a reminder list could not be fetched, skipping shopping deletion.`);
        } else {
          pruneRemoved(db.get(), 'shopping_items', account.id, seenByModule.shopping);
        }
      }

      // Rückrichtung (#617). Nach dem Inbound, weil der Weg zum Objekt für
      // Bestandseinträge erst aus dessen Abruf bekannt wird; der Inbound
      // überspringt dafür alles, was hier noch aussteht.
      //
      // `complete` heißt: jede Liste dieses Moduls wurde abgerufen. Nur dann ist
      // ein Tombstone ohne auffindbares Objekt wirklich erledigt statt bloß
      // unerreichbar - dieselbe Vorsicht wie beim Prune (#508).
      for (const module of ['tasks', 'shopping']) {
        const complete = !incompleteModules.has(module);
        try {
          const removed = await todoOutbound.processPendingDeletions(
            client, account.id, module, objectsByModule[module], complete
          );
          const pushed = await todoOutbound.processPendingUpdates(
            client, account.id, module, objectsByModule[module]
          );
          totalPushed += pushed;
          if (removed) log.info(`${removed} pending VTODO deletion(s) applied on the server.`);
          if (pushed)  log.info(`${pushed} local VTODO change(s) pushed to the server.`);
        } catch (err) {
          log.error(`Outbound VTODO changes failed for account ${account.id} (${module}):`, err.message);
        }
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
          client, account.id, 'tasks', taskLists
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
          shoppingLists
        );
        totalPushed += created;
        if (created) log.info(`${created} locally created shopping item(s) uploaded to the server.`);
      } catch (err) {
        log.error(`Uploading local shopping items failed for account ${account.id}:`, err.message);
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
  splitDue,
  applyTaskRelations,
  getReminderLists,
  updateReminderSelection,
  sync,
  getStatus,
};
