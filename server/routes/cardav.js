/**
 * Modul: CardDAV Management
 * Zweck: REST-API-Routen für CardDAV Account Management, Addressbook Discovery, Sync
 * Abhängigkeiten: express, server/db.js, server/services/cardav-sync.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import * as CardDAVSync from '../services/cardav-sync.js';
import { str, secret, collectErrors, MAX_TITLE } from '../api/formats.ts';
import { requireAdmin } from '../middleware/require-admin.js';
import { remoteFailure } from '../utils/http.js';
import { validateRequest } from '../api/validate-request.ts';

const log = createLogger('CardDAV');
const MAX_URL = 500;
const router = express.Router();

// JEDE ROUTE HIER IST KONTOVERWALTUNG, und die gehoert dem Admin - wie bei
// CalDAV (routes/calendar/caldav.js). Bis v2.69.0 stand die Grenze nur in der
// Oberflaeche (`adminOnly` am Blatt `sync-contacts`), der Server fragte nur das
// Modulrecht `contacts` ab. Das haben Mitglieder standardmaessig, und damit
// konnte jedes Mitglied und jedes Token mit `contacts:write` die Adresse eines
// Haushaltskontos umbiegen und die gespeicherten Zugangsdaten per Test oder
// Sync an einen beliebigen Host schicken, dazu Konten auflisten, anlegen und
// loeschen.
//
// Als Router-Riegel und nicht je Route: eine neue Route erbt ihn, statt ihn
// vergessen zu koennen. Tokens laufen ueber dieselbe Regel - `req.authRole`
// ist die Rolle des Token-Subjekts -, und der Scope `contacts` bleibt davor
// zusaetzlich Pflicht (Scope-Gate in server/index.js). Der Kontakt-Abgleich
// selbst laeuft im Hintergrund (`sync()`), und Kontakte lesen geht ueber
// /contacts; beides beruehrt dieser Riegel nicht.
//
// Er steht vor validateRequest() in jeder Route (#2810): ein Nicht-Admin
// bekommt seine 403 vor jeder Pruefung der Anfrage, wie bisher.
router.use(requireAdmin);

/**
 * A path id as the number the schema checked: plain decimal digits with an
 * optional minus, at most MAX_PATH_ID (validateRequest(), #2810). `parseInt`
 * read `7abc` as 7 until the schema stood in front; it lets nothing but digits
 * through now, so `Number` reads the same value. `0`, `-0` and `-1` keep the
 * route's own 400 `invalid_id`, a leading zero reaches the row.
 * @param {any} req
 * @param {string} [name]
 * @returns {number}
 */
function pathId(req, name = 'id') {
  return Number(req.params[name]);
}

/**
 * Fehlerantwort mit stabilem, maschinenlesbarem Schlüssel. Der Client übersetzt
 * über `errorCode`; `error` bleibt eine englische Entwickler-Notiz und wird nur
 * als Fallback angezeigt.
 *
 * Die 500 `internal` der catch-Bloecke bleibt vorerst (#2810, Gruppe 7):
 * ohne `errorCode` sagte die Einstellungsseite an zwei Stellen (Kontenliste,
 * Sync) ihren eigenen Satz statt des allgemeinen; ob das gewollt ist, ist
 * noch nicht entschieden.
 *
 * Vorher standen hier deutsche Klartexte („Konto mit dieser URL … existiert
 * bereits"), die unübersetzt in 22 von 23 Locales landeten - ausgerechnet beim
 * gescheiterten Speichern von Zugangsdaten.
 */
function fail(res, status, errorCode, devMessage) {
  return res.status(status).json({ error: devMessage, errorCode, code: status });
}

/**
 * The user's server refused or could not be reached - not an internal error,
 * and "Internal error" tells nobody about a wrong password or a read-only
 * account. `testConnection` marks exactly these cases with the code
 * `carddav_connection_failed`; the answer carries their class in `reason` and
 * `detail` (`HTTP 401`, `ECONNREFUSED`), which the page shows the admin.
 * Everything else stays a 500.
 *
 * @returns {boolean} true, wenn geantwortet wurde
 */
function failIfConnection(res, err) {
  if (err?.code !== 'carddav_connection_failed') return false;
  // Phase 0 section H: the class of the failure (status, network code), never
  // the server's or the library's text - it names hosts and paths.
  const failure = remoteFailure(err) ?? { reason: 'remote_failed' };
  res.status(502).json({
    error: 'The CardDAV server refused the request or could not be reached.',
    errorCode: 'connection_failed',
    code: 502,
    ...failure,
  });
  return true;
}

/**
 * GET /api/v1/contacts/cardav/accounts
 * Liste aller CardDAV Accounts.
 * Response: { data: Account[] }
 */
router.get('/accounts', validateRequest(), async (req, res) => {
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
router.post('/accounts', validateRequest(), async (req, res) => {
  try {
    const vName     = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vUrl      = str(req.body.cardavUrl, 'CardDAV URL', { max: MAX_URL });
    const vUsername = str(req.body.username, 'Username', { max: MAX_TITLE });
    const vPassword = secret(req.body.password, 'Password');
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
    if (failIfConnection(res, err)) return;
    fail(res, 500, 'internal', 'Internal error');
  }
});

/**
 * PUT /api/v1/contacts/cardav/accounts/:id
 * Zugangsdaten eines Kontos ändern. Ohne diesen Pfad blieb bei einem rotierten
 * Passwort nur Löschen und Neuanlegen - samt Verlust der Adressbuch-Auswahl.
 * Body: { name, cardavUrl, username, password? } - leeres Passwort = unverändert,
 * aber nur solange Server (Schema, Host, Port) und Benutzername bleiben; sonst
 * 400 `password_required` (siehe `updateAccount`).
 * Response: { data: Account }
 */
router.put('/accounts/:id', validateRequest(), async (req, res) => {
  try {
    const id = pathId(req);
    if (!id || id < 1) return fail(res, 400, 'invalid_id', 'Invalid ID');

    const vName     = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vUrl      = str(req.body.cardavUrl, 'CardDAV URL', { max: MAX_URL });
    const vUsername = str(req.body.username, 'Username', { max: MAX_TITLE });
    const errors = collectErrors([vName, vUrl, vUsername]);
    if (errors.length) return fail(res, 400, 'validation', errors.join(' '));

    // Passwort ist optional: leer heißt „bestehendes behalten". Ein Wert, der
    // kein Text ist, weist seit #2810 das Schema ab; die Typpruefung bleibt,
    // weil gleich `.trim()` auf dem Rohwert laeuft (Senke, nicht Route).
    const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
    let password = null;
    if (rawPassword.trim().length > 0) {
      const vPassword = secret(rawPassword, 'Password');
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
    if (updated === 'password-required') {
      return fail(res, 400, 'password_required', 'A new server or username needs the password again');
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
router.delete('/accounts/:id', validateRequest(), async (req, res) => {
  try {
    const id = pathId(req);
    if (!id || id < 1) return fail(res, 400, 'invalid_id', 'Invalid ID');

    // Ein Konto, das es nicht gibt, ist 404 wie bei test, refresh und sync:
    // deleteAccount() wirft dafuer, und bis #2810 kam das als 500 `internal`
    // an, und die Seite zeigte nur den allgemeinen Fehlersatz.
    const account = db.get().prepare('SELECT id FROM carddav_accounts WHERE id = ?').get(id);
    if (!account) return fail(res, 404, 'account_not_found', 'Account not found');

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
router.post('/accounts/:id/test', validateRequest(), async (req, res) => {
  try {
    const id = pathId(req);
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
    if (failIfConnection(res, err)) return;
    fail(res, 500, 'internal', 'Internal error');
  }
});

/**
 * GET /api/v1/contacts/cardav/accounts/:id/addressbooks
 * Addressbooks für Account auflisten.
 * Response: { data: Addressbook[] }
 */
router.get('/accounts/:id/addressbooks', validateRequest(), async (req, res) => {
  try {
    const id = pathId(req);
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
router.post('/accounts/:id/addressbooks/refresh', validateRequest(), async (req, res) => {
  try {
    const id = pathId(req);
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
router.put('/addressbooks/:id', validateRequest(), async (req, res) => {
  try {
    const id = pathId(req);
    if (!id || id < 1) return fail(res, 400, 'invalid_id', 'Invalid ID');

    // `enabled` ist Pflicht und ein JSON-Boolean: das prueft seit #2810 das
    // Schema, bevor der Handler laeuft (`bool()` sagte dasselbe mit
    // `errorCode: validation`).
    const enabled = req.body.enabled;

    const exists = db.get()
      .prepare('SELECT id FROM carddav_addressbook_selection WHERE id = ?')
      .get(id);
    if (!exists) return fail(res, 404, 'addressbook_not_found', 'Addressbook not found');

    CardDAVSync.toggleAddressbook(id, enabled);

    res.json({ data: { updated: true, enabled } });
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
router.post('/accounts/:id/sync', validateRequest(), async (req, res) => {
  try {
    const id = pathId(req);
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
