/**
 * Modul: Kalender (Calendar) - CalDAV Multi-Account Sync (Events + Reminders/VTODO)
 */

import { createLogger } from '../../logger.js';
import { integrationDetailsVisible } from '../../scopes.js';
import express from 'express';
import * as caldavSync from '../../services/caldav-sync.js';
import * as caldavReminders from '../../services/caldav-reminders-sync.js';
import { requireAdmin } from '../../auth.js';

const log = createLogger('Calendar');
const router = express.Router();

// --------------------------------------------------------
// CalDAV Multi-Account Sync Routes
// --------------------------------------------------------

// Account Management

router.post('/caldav/accounts', requireAdmin, async (req, res) => {
  try {
    const { name, caldavUrl, username, password } = req.body;

    if (!name || !caldavUrl || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields.', code: 400 });
    }

    const result = await caldavSync.addAccount(name, caldavUrl, username, password);
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV account creation failed:', err);
    res.status(500).json({ error: err.message || 'Failed to create CalDAV account.', code: 500 });
  }
});

router.get('/caldav/accounts', requireAdmin, (req, res) => {
  try {
    const accounts = caldavSync.listAccounts();
    res.json({ data: accounts });
  } catch (err) {
    log.error('CalDAV accounts list failed:', err);
    res.status(500).json({ error: 'Failed to list CalDAV accounts.', code: 500 });
  }
});

router.put('/caldav/accounts/:id', requireAdmin, async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const { name, caldavUrl, username, password } = req.body;

    const result = await caldavSync.updateAccount(accountId, { name, caldavUrl, username, password });
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV account update failed:', err);
    res.status(500).json({ error: err.message || 'Failed to update CalDAV account.', code: 500 });
  }
});

router.delete('/caldav/accounts/:id', requireAdmin, (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    // Query statt Body: DELETE-Requests tragen in dieser App keinen Body, und
    // der Client soll die Wahl ausdruecklich mitschicken (#732).
    const deleteEvents = req.query.deleteEvents === 'true';
    const result = caldavSync.deleteAccount(accountId, { deleteEvents });
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV account deletion failed:', err);
    res.status(500).json({ error: err.message || 'Failed to delete CalDAV account.', code: 500 });
  }
});

// Calendar Selection

router.get('/caldav/accounts/:id/calendars', requireAdmin, async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const refresh = req.query.refresh === 'true';

    const calendars = await caldavSync.getCalendars(accountId, { refresh });
    res.json({ data: calendars });
  } catch (err) {
    log.error('CalDAV calendars fetch failed:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch calendars.', code: 500 });
  }
});

router.patch('/caldav/accounts/:id/calendars', requireAdmin, (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const { calendarUrl, enabled, deleteEvents } = req.body;

    if (!calendarUrl || enabled === undefined) {
      return res.status(400).json({ error: 'Missing calendarUrl or enabled field.', code: 400 });
    }
    if (deleteEvents !== undefined && typeof deleteEvents !== 'boolean') {
      return res.status(400).json({ error: 'deleteEvents must be a boolean.', code: 400 });
    }

    const result = caldavSync.updateCalendarSelection(accountId, calendarUrl, enabled, {
      deleteEvents: deleteEvents === true,
    });
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV calendar selection update failed:', err);
    res.status(500).json({ error: err.message || 'Failed to update calendar selection.', code: 500 });
  }
});

// Sync & Status

router.post('/caldav/sync', requireAdmin, async (req, res) => {
  try {
    const result = await caldavSync.sync();
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV sync failed:', err);
    res.status(500).json({ error: 'CalDAV sync failed.', code: 500 });
  }
});

router.get('/caldav/status', (req, res) => {
  try {
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
  } catch (err) {
    log.error('CalDAV status failed:', err);
    res.status(500).json({ error: 'Failed to get CalDAV status.', code: 500 });
  }
});

// --------------------------------------------------------
// CalDAV Reminders (VTODO) Sync Routes — Tasks & Shopping, in beide Richtungen (#617)
// --------------------------------------------------------

// Reminder-list discovery & selection

router.get('/caldav/accounts/:id/reminder-lists', requireAdmin, async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const refresh = req.query.refresh === 'true';

    const lists = await caldavReminders.getReminderLists(accountId, { refresh });
    res.json({ data: lists });
  } catch (err) {
    log.error('CalDAV reminder lists fetch failed:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch reminder lists.', code: 500 });
  }
});

router.patch('/caldav/accounts/:id/reminder-lists', requireAdmin, (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const { listUrl, enabled, targetModule } = req.body;

    if (!listUrl || (enabled === undefined && targetModule === undefined)) {
      return res.status(400).json({ error: 'Missing listUrl or update fields.', code: 400 });
    }

    const result = caldavReminders.updateReminderSelection(accountId, listUrl, { enabled, targetModule });
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV reminder selection update failed:', err);
    res.status(500).json({ error: err.message || 'Failed to update reminder selection.', code: 500 });
  }
});

// Sync & Status

router.post('/caldav/reminders/sync', requireAdmin, async (req, res) => {
  try {
    const result = await caldavReminders.sync();
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV reminders sync failed:', err);
    res.status(500).json({ error: 'CalDAV reminders sync failed.', code: 500 });
  }
});

router.get('/caldav/reminders/status', (req, res) => {
  try {
    const status = caldavReminders.getStatus();
    res.json({ data: status });
  } catch (err) {
    log.error('CalDAV reminders status failed:', err);
    res.status(500).json({ error: 'Failed to get reminders status.', code: 500 });
  }
});

export default router;
