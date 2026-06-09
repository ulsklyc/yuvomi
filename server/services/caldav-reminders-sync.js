/**
 * Modul: CalDAV Reminders Sync (Apple Reminders / VTODO)
 * Zweck: Read-only Multi-Account-CalDAV-VTODO-Synchronisation in die Module Tasks & Shopping.
 *        Reuses the existing caldav_accounts; Apple Reminders lists are CalDAV collections
 *        whose supported components include VTODO.
 * Abhängigkeiten: tsdav, server/db.js, server/services/ics-parser.js
 */

import { createLogger } from '../logger.js';
const log = createLogger('CalDAV-Reminders');

import * as db from '../db.js';
import { parseVTODO } from './ics-parser.js';

// --------------------------------------------------------
// Pure Mapping Helpers
// --------------------------------------------------------

/**
 * Map an RFC-5545 VTODO PRIORITY (1–9, 0/undefined) to an Yuvomi task priority.
 * 1–4 → high, 5 → medium, 6–9 → low, else none.
 */
function mapVtodoPriority(p) {
  if (p == null) return 'none';
  if (p >= 1 && p <= 4) return 'high';
  if (p === 5) return 'medium';
  if (p >= 6 && p <= 9) return 'low';
  return 'none';
}

/**
 * Split a formatted DUE value (date or datetime) into { date, time }.
 * Date-only → time is null; datetime → HH:MM.
 */
function splitDue(due) {
  if (!due) return { date: null, time: null };
  if (due.length === 10) return { date: due, time: null };
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
  const comps = cal.components || [];
  return Array.isArray(comps) && comps.map(c => String(c).toUpperCase()).includes('VTODO');
}

async function createClient(account) {
  const { createDAVClient } = await import('tsdav');
  return createDAVClient({
    serverUrl:          account.caldav_url,
    credentials:        { username: account.username, password: account.password },
    authMethod:         'Basic',
    defaultAccountType: 'caldav',
  });
}

// --------------------------------------------------------
// Reminder-List Discovery & Selection
// --------------------------------------------------------

async function getReminderLists(accountId, { refresh = false } = {}) {
  const account = getAccountById(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found.`);
  }

  if (!refresh) {
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
  const client    = await createClient(account);
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
// Upsert Helpers (read-only inbound: iCloud → Yuvomi)
// --------------------------------------------------------

function upsertTask(todo, accountId, createdBy) {
  const { date, time } = splitDue(todo.due);
  const priority = mapVtodoPriority(todo.priority);
  const status   = todo.completed ? 'done' : 'open';

  const existing = db.get().prepare(
    `SELECT id FROM tasks WHERE external_uid = ? AND external_source = 'caldav' AND external_account_id = ?`
  ).get(todo.uid, accountId);

  if (existing) {
    db.get().prepare(`
      UPDATE tasks
      SET title = ?, description = ?, priority = ?, status = ?, due_date = ?, due_time = ?
      WHERE id = ?
    `).run(todo.summary, todo.description, priority, status, date, time, existing.id);
  } else {
    db.get().prepare(`
      INSERT INTO tasks
        (title, description, priority, status, due_date, due_time, created_by, external_uid, external_source, external_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'caldav', ?)
    `).run(todo.summary, todo.description, priority, status, date, time, createdBy, todo.uid, accountId);
  }
}

function upsertShoppingItem(sel, todo, accountId) {
  const listId    = ensureShoppingList(sel);
  const isChecked = todo.completed ? 1 : 0;

  const existing = db.get().prepare(
    `SELECT id FROM shopping_items WHERE external_uid = ? AND external_source = 'caldav' AND external_account_id = ?`
  ).get(todo.uid, accountId);

  if (existing) {
    db.get().prepare(`
      UPDATE shopping_items SET name = ?, is_checked = ?, list_id = ? WHERE id = ?
    `).run(todo.summary, isChecked, listId, existing.id);
  } else {
    db.get().prepare(`
      INSERT INTO shopping_items
        (list_id, name, is_checked, external_uid, external_source, external_account_id)
      VALUES (?, ?, ?, ?, 'caldav', ?)
    `).run(listId, todo.summary, isChecked, todo.uid, accountId);
  }
}

function pruneRemoved(table, accountId, seenUids) {
  if (seenUids.length === 0) {
    db.get().prepare(
      `DELETE FROM ${table} WHERE external_source = 'caldav' AND external_account_id = ?`
    ).run(accountId);
    return;
  }
  const placeholders = seenUids.map(() => '?').join(',');
  db.get().prepare(
    `DELETE FROM ${table}
     WHERE external_source = 'caldav' AND external_account_id = ?
       AND external_uid NOT IN (${placeholders})`
  ).run(accountId, ...seenUids);
}

// --------------------------------------------------------
// Sync (read-only)
// --------------------------------------------------------

async function sync() {
  const accounts = getAllAccounts();
  if (accounts.length === 0) {
    return { success: true, syncedAccounts: 0, syncedItems: 0 };
  }

  let totalItems       = 0;
  let successfulAccounts = 0;

  for (const account of accounts) {
    try {
      const enabledLists = db.get().prepare(`
        SELECT * FROM caldav_reminder_selection WHERE account_id = ? AND enabled = 1
      `).all(account.id);

      if (enabledLists.length === 0) continue;

      const client     = await createClient(account);
      const serverCals  = await client.fetchCalendars();
      const owner       = db.get().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
      const createdBy   = owner ? owner.id : 1;

      const seenByModule = { tasks: [], shopping: [] };

      for (const sel of enabledLists) {
        const serverCal = serverCals.find(c => c.url === sel.list_url);
        if (!serverCal) {
          log.warn(`Reminder list ${sel.list_url} not found on server, disabling.`);
          db.get().prepare('UPDATE caldav_reminder_selection SET enabled = 0 WHERE id = ?').run(sel.id);
          continue;
        }

        let objects;
        try {
          objects = await client.fetchCalendarObjects({ calendar: serverCal });
        } catch (err) {
          log.error(`Failed to fetch VTODOs from "${sel.list_name}":`, err.message);
          continue;
        }

        for (const obj of objects) {
          const todos = parseVTODO(obj.data || '');
          for (const todo of todos) {
            try {
              if (sel.target_module === 'shopping') {
                upsertShoppingItem(sel, todo, account.id);
                seenByModule.shopping.push(todo.uid);
              } else {
                upsertTask(todo, account.id, createdBy);
                seenByModule.tasks.push(todo.uid);
              }
              totalItems++;
            } catch (err) {
              log.error(`Failed to upsert VTODO ${todo.uid}:`, err.message);
            }
          }
        }
      }

      // Prune locally-stored caldav items that vanished remotely (read-only mirror)
      const hasTasks    = enabledLists.some(s => s.target_module === 'tasks');
      const hasShopping = enabledLists.some(s => s.target_module === 'shopping');
      if (hasTasks)    pruneRemoved('tasks', account.id, seenByModule.tasks);
      if (hasShopping) pruneRemoved('shopping_items', account.id, seenByModule.shopping);

      db.get().prepare('UPDATE caldav_accounts SET last_sync = ? WHERE id = ?')
        .run(new Date().toISOString(), account.id);
      successfulAccounts++;
    } catch (err) {
      log.error(`Reminders sync failed for account ${account.id}:`, err.message);
    }
  }

  log.info(`CalDAV reminders sync complete: ${successfulAccounts}/${accounts.length} accounts, ${totalItems} items.`);
  return { success: true, syncedAccounts: successfulAccounts, syncedItems: totalItems };
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
  splitDue,
  getReminderLists,
  updateReminderSelection,
  sync,
  getStatus,
};
