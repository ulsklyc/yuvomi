/**
 * Modul: Kalender (Calendar) - CalDAV Multi-Account Sync (Events + Reminders/VTODO)
 */

import { createLogger } from '../../logger.js';
import { integrationDetailsVisible } from '../../scopes.js';
import express from 'express';
import { validateRequest } from '../../api/validate-request.ts';
import * as caldavSync from '../../services/caldav-sync.js';
import * as caldavReminders from '../../services/caldav-reminders-sync.js';
import { requireAdmin } from '../../auth.js';
import { secret } from '../../api/formats.ts';
import { refuseWhileRestoring } from '../../middleware/restore-gate.js';
import * as db from '../../db.js';
import { readDefaultAssignees, validateAssigneeIds } from '../../services/default-assignees.js';
import { remoteFailure } from '../../utils/http.js';

const log = createLogger('Calendar');

/**
 * The answer of a route that asks the CalDAV server, once its own named cases
 * are handled (Phase 0 section H): a failure of the server as its class (502,
 * `reason` + `detail` such as `HTTP 401` or `ECONNREFUSED`, which the settings
 * page shows the admin). Never the text of the server or of tsdav - it names
 * hosts, ports and paths. Anything local (a database error, which
 * remoteFailure() does not take for a refusal) goes on to the central error
 * handler (#2810, group 10b).
 * @param {any} res
 * @param {unknown} err
 * @param {string} logLine the line the route logs a refusal under
 */
function sendCaldavFailure(res, err, logLine) {
  const failure = remoteFailure(err);
  if (!failure) throw err;
  log.error(logLine, err);
  return res.status(502).json({ error: 'The CalDAV server refused the request or could not be reached.', code: 502, ...failure });
}

/**
 * The account id in the path: the schema lets plain decimal digits through only
 * (`idParam()`, #2810).
 * @param {any} req
 * @param {string} [name]
 */
function pathId(req, name = 'id') {
  return Number(req.params[name]);
}

/**
 * An account in the path that does not exist (#2810, group 10b, decision 11):
 * asked before the service, whose plain Error for it answered 500 or a 502
 * `remote_failed` - a refusal of the CalDAV server that never happened.
 * @param {{ status: (code: number) => { json: (body: unknown) => unknown } }} res
 * @param {number} accountId
 * @returns {boolean} true when the answer is sent
 */
function refuseUnknownAccount(res, accountId) {
  if (caldavSync.accountExists(accountId)) return false;
  sendAccountNotFound(res);
  return true;
}

/** @param {{ status: (code: number) => { json: (body: unknown) => unknown } }} res */
function sendAccountNotFound(res) {
  return res.status(404).json({ error: 'CalDAV account not found.', code: 404, reason: 'caldav_account_not_found' });
}

/**
 * The account was deleted while the service waited for the CalDAV server
 * (#2947): the same answer as for an unknown account before it.
 * @param {any} res
 * @param {any} err
 * @returns {boolean} true when the answer is sent
 */
function refuseGoneAccount(res, err) {
  if (err?.code !== 'caldav_account_gone') return false;
  sendAccountNotFound(res);
  return true;
}
const router = express.Router();

// --------------------------------------------------------
// CalDAV Multi-Account Sync Routes
// --------------------------------------------------------

// Account Management

router.post('/caldav/accounts', requireAdmin, validateRequest(), async (req, res) => {
  try {
    const { name, caldavUrl, username, password } = req.body;

    if (!name || !caldavUrl || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields.', code: 400 });
    }
    // Passwort ungetrimmt und mit derselben Grenze wie CardDAV und Apple (#2575).
    const vPassword = secret(password, 'Password');
    if (vPassword.error) return res.status(400).json({ error: vPassword.error, code: 400 });

    const result = await caldavSync.addAccount(name, caldavUrl, username, password);
    res.json({ data: result });
  } catch (err) {
    // Die zwei Faelle, die die App selbst kennt (#1909). Alles andere ist eine
    // Absage des fremden Servers: die Seite zeigt dem Admin ihre Klasse.
    if (err.code === 'caldav_account_exists') {
      return res.status(409).json({ error: err.message, code: 409, reason: 'caldav_account_exists' });
    }
    if (err.code === 'caldav_no_calendars') {
      return res.status(400).json({ error: err.message, code: 400, reason: 'caldav_no_calendars' });
    }
    sendCaldavFailure(res, err, 'CalDAV account creation failed:');
  }
});

router.get('/caldav/accounts', requireAdmin, validateRequest(), (req, res) => {
  const accounts = caldavSync.listAccounts();
  res.json({ data: accounts });
});

router.put('/caldav/accounts/:id', requireAdmin, validateRequest(), async (req, res) => {
  try {
    const accountId = pathId(req);
    const { name, caldavUrl, username, password } = req.body;
    // Leer heisst "bestehendes behalten" (siehe updateAccount).
    const vPassword = secret(password, 'Password', { required: false });
    if (vPassword.error) return res.status(400).json({ error: vPassword.error, code: 400 });
    if (refuseUnknownAccount(res, accountId)) return;

    const result = await caldavSync.updateAccount(accountId, { name, caldavUrl, username, password });
    res.json({ data: result });
  } catch (err) {
    // Neuer Server oder Benutzer ohne neues Passwort - keine Stoerung, sondern
    // eine Eingabe, die fehlt (siehe updateAccount).
    if (err.code === 'password_required') {
      return res.status(400).json({ error: err.message, errorCode: 'password_required', code: 400 });
    }
    if (refuseGoneAccount(res, err)) return;
    sendCaldavFailure(res, err, 'CalDAV account update failed:');
  }
});

router.delete('/caldav/accounts/:id', requireAdmin, validateRequest(), (req, res) => {
  const accountId = pathId(req);
  // Query statt Body: DELETE-Requests tragen in dieser App keinen Body, und
  // der Client soll die Wahl ausdruecklich mitschicken (#732).
  const deleteEvents = req.query.deleteEvents === 'true';
  if (refuseUnknownAccount(res, accountId)) return;
  const result = caldavSync.deleteAccount(accountId, { deleteEvents });
  res.json({ data: result });
});

// Calendar Selection

// `?refresh=true` schreibt die Kalenderliste nach dem Abruf neu: waehrend eines
// Restores 503, sonst festgehalten wie eine schreibende Anfrage (#1551).
router.get('/caldav/accounts/:id/calendars', requireAdmin, refuseWhileRestoring, validateRequest(), async (req, res) => {
  try {
    const accountId = pathId(req);
    const refresh = req.query.refresh === 'true';
    if (refuseUnknownAccount(res, accountId)) return;

    const calendars = await caldavSync.getCalendars(accountId, { refresh });
    res.json({ data: calendars });
  } catch (err) {
    if (refuseGoneAccount(res, err)) return;
    sendCaldavFailure(res, err, 'CalDAV calendars fetch failed:');
  }
});

router.patch('/caldav/accounts/:id/calendars', requireAdmin, validateRequest(), (req, res) => {
  const accountId = pathId(req);
  const { calendarUrl, enabled, deleteEvents } = req.body;

  // `enabled` (Pflicht) und `deleteEvents` als Boolean prueft das Schema
  // (CaldavCalendarSelectionInput); eine leere Adresse kennt es nicht.
  if (!calendarUrl) {
    return res.status(400).json({ error: 'Missing calendarUrl or enabled field.', code: 400 });
  }
  if (refuseUnknownAccount(res, accountId)) return;

  const result = caldavSync.updateCalendarSelection(accountId, calendarUrl, enabled, {
    deleteEvents: deleteEvents === true,
  });
  res.json({ data: result });
});

// Sync & Status

router.post('/caldav/sync', requireAdmin, validateRequest(), async (req, res) => {
  const result = await caldavSync.sync();
  res.json({ data: result });
});

router.get('/caldav/status', validateRequest(), (req, res) => {
  const status = caldavSync.getStatus();
  // SERVER-ADRESSE UND BENUTZERNAME SIND VERWALTUNGSDATEN, keine Kalenderdaten.
  // `calendar:read` reicht bis hierher, weil der Pfad-Guard am ersten Segment
  // urteilt - ein Wandtablett an der Kuechenwand haette damit ausgelesen,
  // gegen welchen Server dieser Haushalt mit welchem Namen synchronisiert.
  // Die Regel steht in scopes.js, gemessen an den Scopes und nicht am
  // Kontotyp; eine Sitzung sieht unveraendert alles.
  const data = integrationDetailsVisible(req)
    ? status
    : {
      ...status,
      accounts: (status.accounts || []).map(({ caldavUrl, username, ...rest }) => rest),
    };
  res.json({ data });
});

// --------------------------------------------------------
// CalDAV Reminders (VTODO) Sync Routes — Tasks & Shopping, in beide Richtungen (#617)
// --------------------------------------------------------

// Reminder-list discovery & selection

// Der erste Aufruf und `?refresh=true` schreiben die Listen nach dem Abruf (#1551).
router.get('/caldav/accounts/:id/reminder-lists', requireAdmin, refuseWhileRestoring, validateRequest(), async (req, res) => {
  try {
    const accountId = pathId(req);
    const refresh = req.query.refresh === 'true';
    if (refuseUnknownAccount(res, accountId)) return;

    const lists = await caldavReminders.getReminderLists(accountId, { refresh });
    res.json({ data: lists });
  } catch (err) {
    if (refuseGoneAccount(res, err)) return;
    sendCaldavFailure(res, err, 'CalDAV reminder lists fetch failed:');
  }
});

// `defaultAssigneeUserIds` (#1221): die Personen, die eine neu eingelesene
// Aufgabe aus dieser Liste bekommt. Nur Haushaltsmitglieder, nur fuer eine
// Liste, die auf Aufgaben zeigt.
router.patch('/caldav/accounts/:id/reminder-lists', requireAdmin, validateRequest(), (req, res) => {
  try {
    const accountId = pathId(req);
    const { listUrl, enabled, targetModule } = req.body;
    const touchesAssignees = req.body.defaultAssigneeUserIds !== undefined || req.body.defaultAssigneeUserId !== undefined;

    if (!listUrl || (enabled === undefined && targetModule === undefined && !touchesAssignees)) {
      return res.status(400).json({ error: 'Missing listUrl or update fields.', code: 400 });
    }

    let defaultAssigneeUserIds;
    if (touchesAssignees) {
      const sel = db.get().prepare('SELECT id FROM caldav_reminder_selection WHERE account_id = ? AND list_url = ?')
        .get(accountId, listUrl);
      const checked = validateAssigneeIds(db.get(), req.body, {
        listField: 'defaultAssigneeUserIds',
        singleField: 'defaultAssigneeUserId',
        stored: sel ? readDefaultAssignees(db.get(), 'reminderList', sel.id) : [],
      });
      if (checked.error) return res.status(400).json({ error: checked.error, code: 400, reason: checked.reason });
      defaultAssigneeUserIds = checked.ids;
    }
    if (refuseUnknownAccount(res, accountId)) return;

    const result = caldavReminders.updateReminderSelection(accountId, listUrl, { enabled, targetModule, defaultAssigneeUserIds });
    res.json({ data: result });
  } catch (err) {
    if (err instanceof caldavReminders.ReminderListAssigneeError) {
      return res.status(400).json({ error: err.message, code: 400, reason: 'reminder_list_assignee_not_tasks' });
    }
    throw err;
  }
});

// Sync & Status

router.post('/caldav/reminders/sync', requireAdmin, validateRequest(), async (req, res) => {
  const result = await caldavReminders.sync();
  res.json({ data: result });
});

router.get('/caldav/reminders/status', validateRequest(), (req, res) => {
  const status = caldavReminders.getStatus();
  res.json({ data: status });
});

export default router;
