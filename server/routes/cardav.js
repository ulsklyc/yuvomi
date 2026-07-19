/**
 * Modul: CardDAV Management
 * Zweck: REST-API-Routen für CardDAV Account Management, Addressbook Discovery, Sync
 * Abhängigkeiten: express, server/db.js, server/services/cardav-sync.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import * as CardDAVSync from '../services/cardav-sync.js';
import { str, bool, collectErrors, MAX_TITLE } from '../middleware/validate.js';

const log = createLogger('CardDAV');
const MAX_URL = 500;
const router = express.Router();

/**
 * Fehlerantwort mit stabilem, maschinenlesbarem Schlüssel. Der Client übersetzt
 * über `errorCode`; `error` bleibt eine englische Entwickler-Notiz und wird nur
 * als Fallback angezeigt.
 *
 * Vorher standen hier deutsche Klartexte („Konto mit dieser URL … existiert
 * bereits"), die unübersetzt in 22 von 23 Locales landeten - ausgerechnet beim
 * gescheiterten Speichern von Zugangsdaten.
 */
function fail(res, status, errorCode, devMessage) {
  return res.status(status).json({ error: devMessage, errorCode, code: status });
}

/**
 * GET /api/v1/contacts/cardav/accounts
 * Liste aller CardDAV Accounts.
 * Response: { data: Account[] }
 */
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await CardDAVSync.getAllAccounts();
    res.json({ data: accounts });
  } catch (err) {
    log.error('Error fetching accounts:', err);
    fail(res, 500, 'internal', 'Internal error');
  }
});

/**
 * POST /api/v1/contacts/cardav/accounts
 * Neuen CardDAV Account erstellen und Addressbooks discovern.
 * Body: { name, cardavUrl, username, password }
 * Response: { data: { account, addressbooks } }
 */
router.post('/accounts', async (req, res) => {
  try {
    const vName     = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vUrl      = str(req.body.cardavUrl, 'CardDAV URL', { max: MAX_URL });
    const vUsername = str(req.body.username, 'Username', { max: MAX_TITLE });
    const vPassword = str(req.body.password, 'Password', { max: MAX_TITLE });
    const errors = collectErrors([vName, vUrl, vUsername, vPassword]);
    if (errors.length) return fail(res, 400, 'validation', errors.join(' '));

    const result = await CardDAVSync.addAccount(
      vName.value,
      vUrl.value,
      vUsername.value,
      vPassword.value
    );

    res.status(201).json({ data: result });
  } catch (err) {
    log.error('Error adding CardDAV account:', err);
    fail(res, 500, 'internal', 'Internal error');
  }
});

/**
 * PUT /api/v1/contacts/cardav/accounts/:id
 * Zugangsdaten eines Kontos ändern. Ohne diesen Pfad blieb bei einem rotierten
 * Passwort nur Löschen und Neuanlegen - samt Verlust der Adressbuch-Auswahl.
 * Body: { name, cardavUrl, username, password? } - leeres Passwort = unverändert.
 * Response: { data: Account }
 */
router.put('/accounts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id < 1) return fail(res, 400, 'invalid_id', 'Invalid ID');

    const vName     = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vUrl      = str(req.body.cardavUrl, 'CardDAV URL', { max: MAX_URL });
    const vUsername = str(req.body.username, 'Username', { max: MAX_TITLE });
    const errors = collectErrors([vName, vUrl, vUsername]);
    if (errors.length) return fail(res, 400, 'validation', errors.join(' '));

    // Passwort ist optional: leer heißt „bestehendes behalten".
    const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
    let password = null;
    if (rawPassword.trim().length > 0) {
      const vPassword = str(rawPassword, 'Password', { max: MAX_TITLE });
      const pwErrors = collectErrors([vPassword]);
      if (pwErrors.length) return fail(res, 400, 'validation', pwErrors.join(' '));
      password = vPassword.value;
    }

    const updated = CardDAVSync.updateAccount(id, {
      name: vName.value,
      cardavUrl: vUrl.value,
      username: vUsername.value,
      password,
    });

    if (updated === 'not-found') return fail(res, 404, 'account_not_found', 'Account not found');
    if (updated === 'conflict') {
      return fail(res, 409, 'account_duplicate', 'Account with this URL and username already exists');
    }

    res.json({ data: updated });
  } catch (err) {
    log.error('Error updating CardDAV account:', err);
    fail(res, 500, 'internal', 'Internal error');
  }
});

/**
 * DELETE /api/v1/contacts/cardav/accounts/:id
 * CardDAV Account löschen (CASCADE löscht addressbooks + contacts).
 * Response: { data: { deleted: true } }
 */
router.delete('/accounts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id < 1) return fail(res, 400, 'invalid_id', 'Invalid ID');

    await CardDAVSync.deleteAccount(id);

    res.json({ data: { deleted: true } });
  } catch (err) {
    log.error('Error deleting CardDAV account:', err);
    fail(res, 500, 'internal', 'Internal error');
  }
});

/**
 * POST /api/v1/contacts/cardav/accounts/:id/test
 * Connection testen (ohne Account zu speichern).
 * Response: { data: { ok, addressbooks } }
 */
router.post('/accounts/:id/test', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id < 1) return fail(res, 400, 'invalid_id', 'Invalid ID');

    const account = db.get().prepare('SELECT * FROM carddav_accounts WHERE id = ?').get(id);
    if (!account) return fail(res, 404, 'account_not_found', 'Account not found');

    const result = await CardDAVSync.testConnection(
      account.carddav_url,
      account.username,
      account.password
    );

    res.json({ data: result });
  } catch (err) {
    log.error('Error testing CardDAV connection:', err);
    fail(res, 500, 'internal', 'Internal error');
  }
});

/**
 * GET /api/v1/contacts/cardav/accounts/:id/addressbooks
 * Addressbooks für Account auflisten.
 * Response: { data: Addressbook[] }
 */
router.get('/accounts/:id/addressbooks', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id < 1) return fail(res, 400, 'invalid_id', 'Invalid ID');

    const addressbooks = db.get().prepare(`
      SELECT id, addressbook_url as url, addressbook_name as name, enabled,
             last_error as lastError
      FROM carddav_addressbook_selection
      WHERE account_id = ?
      ORDER BY addressbook_name
    `).all(id);

    res.json({ data: addressbooks });
  } catch (err) {
    log.error('Error fetching addressbooks:', err);
    fail(res, 500, 'internal', 'Internal error');
  }
});

/**
 * POST /api/v1/contacts/cardav/accounts/:id/addressbooks/refresh
 * Addressbooks neu discovern (PROPFIND).
 * Response: { data: Addressbook[] }
 */
router.post('/accounts/:id/addressbooks/refresh', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id < 1) return fail(res, 400, 'invalid_id', 'Invalid ID');

    const account = db.get().prepare('SELECT * FROM carddav_accounts WHERE id = ?').get(id);
    if (!account) return fail(res, 404, 'account_not_found', 'Account not found');

    await CardDAVSync.discoverAddressbooks(id);

    const addressbooks = db.get().prepare(`
      SELECT id, addressbook_url as url, addressbook_name as name, enabled,
             last_error as lastError
      FROM carddav_addressbook_selection
      WHERE account_id = ?
      ORDER BY addressbook_name
    `).all(id);

    res.json({ data: addressbooks });
  } catch (err) {
    log.error('Error refreshing addressbooks:', err);
    fail(res, 500, 'internal', 'Internal error');
  }
});

/**
 * PUT /api/v1/contacts/cardav/addressbooks/:id
 * Toggle Addressbook enabled/disabled.
 * Body: { enabled: boolean }
 * Response: { data: { updated: true, enabled: boolean } }
 */
router.put('/addressbooks/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id < 1) return fail(res, 400, 'invalid_id', 'Invalid ID');

    const vEnabled = bool(req.body.enabled, 'enabled');
    const errors = collectErrors([vEnabled]);
    if (errors.length) return fail(res, 400, 'validation', errors.join(' '));

    const exists = db.get()
      .prepare('SELECT id FROM carddav_addressbook_selection WHERE id = ?')
      .get(id);
    if (!exists) return fail(res, 404, 'addressbook_not_found', 'Addressbook not found');

    CardDAVSync.toggleAddressbook(id, vEnabled.value);

    res.json({ data: { updated: true, enabled: vEnabled.value } });
  } catch (err) {
    log.error('Error toggling addressbook:', err);
    fail(res, 500, 'internal', 'Internal error');
  }
});

/**
 * POST /api/v1/contacts/cardav/accounts/:id/sync
 * Sync all enabled addressbooks for account.
 * Response: { data: { synced: boolean, contactsAdded: number, contactsUpdated: number } }
 */
router.post('/accounts/:id/sync', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id < 1) return fail(res, 400, 'invalid_id', 'Invalid ID');

    const account = db.get().prepare('SELECT * FROM carddav_accounts WHERE id = ?').get(id);
    if (!account) return fail(res, 404, 'account_not_found', 'Account not found');

    const result = await CardDAVSync.syncAccount(id);

    res.json({ data: result });
  } catch (err) {
    log.error('Error syncing account:', err);
    fail(res, 500, 'internal', 'Internal error');
  }
});

export default router;
