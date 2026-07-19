/**
 * Modul: CardDAV Contacts Sync
 * Zweck: Multi-Account CardDAV synchronization with addressbook selection
 * Abhängigkeiten: tsdav, server/db.js
 */

import { createLogger } from '../logger.js';
const log = createLogger('CardDAV');

import * as db from '../db.js';

// --------------------------------------------------------
// Helper Functions
// --------------------------------------------------------

/**
 * Hebt vCard-Escapes in einem Wert auf: `\,` `\;` `\\` sowie `\n`/`\N`
 * (RFC 6350 / 2426). Manche Server (z. B. mailbox.org, Issue #531) liefern
 * FN/N/ADR mit literalen Backslash-Sequenzen wie `Surname\, Given`.
 * @param {string} value
 * @returns {string}
 */
function unescapeVCardValue(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\\([\\,;nN])/g, (_, ch) =>
    (ch === 'n' || ch === 'N') ? '\n' : ch
  );
}

/**
 * Zerlegt einen strukturierten vCard-Wert (N, ADR) an *unescapten*
 * Trennzeichen. Ein maskiertes `\;`/`\,` innerhalb einer Komponente bleibt
 * dabei erhalten und wird erst anschließend per unescapeVCardValue aufgelöst.
 * @param {string} value
 * @param {string} separator - Einzelzeichen (';' oder ',')
 * @returns {Array<string>}
 */
function splitVCardValue(value, separator) {
  const parts = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      current += ch + value[i + 1];
      i++;
    } else if (ch === separator) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Parse vCard text into structured object
 * @param {string} vCardText - Raw vCard data
 * @returns {Object} Parsed vCard object
 */
function parseVCard(vCardText) {
  const lines = vCardText.split(/\r?\n/).filter(line => line.trim());
  const vcard = {
    uid: null,
    name: null,
    phones: [],
    emails: [],
    addresses: [],
    organization: null,
    jobTitle: null,
    website: null,
    birthday: null,
    photo: null,
    nickname: null,
    notes: null,
    categories: null,
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Handle line folding (continuation lines start with space or tab)
    while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) {
      line += lines[i + 1].substring(1);
      i++;
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const fullKey = line.substring(0, colonIndex);
    const value = line.substring(colonIndex + 1).trim();

    // Parse property and parameters
    const [prop, ...params] = fullKey.split(';');
    const property = prop.toUpperCase();

    switch (property) {
      case 'UID':
        vcard.uid = value;
        break;

      case 'FN':
        if (!vcard.name) vcard.name = unescapeVCardValue(value);
        break;

      case 'N':
        // N is fallback if FN is not present
        // Format: Family;Given;Middle;Prefix;Suffix
        if (!vcard.name) {
          const parts = splitVCardValue(value, ';').map(unescapeVCardValue).filter(p => p.trim());
          vcard.name = parts.join(' ').trim();
        }
        break;

      case 'TEL':
        const phoneType = extractType(params) || 'other';
        vcard.phones.push({ label: phoneType, value: unescapeVCardValue(value) });
        break;

      case 'EMAIL':
        const emailType = extractType(params) || 'other';
        vcard.emails.push({ label: emailType, value: unescapeVCardValue(value) });
        break;

      case 'ADR':
        // Format: POBox;Extended;Street;City;State;Postal;Country
        const adrParts = splitVCardValue(value, ';').map(unescapeVCardValue);
        const adrType = extractType(params) || 'other';
        vcard.addresses.push({
          label: adrType,
          street: adrParts[2] || null,
          city: adrParts[3] || null,
          state: adrParts[4] || null,
          postalCode: adrParts[5] || null,
          country: adrParts[6] || null,
        });
        break;

      case 'ORG':
        vcard.organization = unescapeVCardValue(value);
        break;

      case 'TITLE':
        vcard.jobTitle = unescapeVCardValue(value);
        break;

      case 'URL':
        // Take first URL if multiple exist
        if (!vcard.website) vcard.website = value;
        break;

      case 'BDAY':
        // Parse birthday to ISO format (YYYY-MM-DD)
        vcard.birthday = parseBirthday(value);
        break;

      case 'PHOTO':
        // Handle base64 encoded photos
        if (params.some(p => p.toUpperCase().includes('ENCODING=BASE64') || p.toUpperCase().includes('ENCODING=B'))) {
          // Photo might span multiple lines in old vCard format
          vcard.photo = value;
        }
        break;

      case 'NICKNAME':
        vcard.nickname = unescapeVCardValue(value);
        break;

      case 'NOTE':
        vcard.notes = unescapeVCardValue(value);
        break;

      case 'CATEGORIES':
        vcard.categories = unescapeVCardValue(value);
        break;
    }
  }

  return vcard;
}

/**
 * Extract TYPE parameter from vCard property parameters
 * @param {Array<string>} params - Property parameters
 * @returns {string|null} Type value
 */
function extractType(params) {
  // Priority order: more specific types first
  const typeHierarchy = ['CELL', 'MOBILE', 'HOME', 'WORK', 'FAX', 'OTHER', 'VOICE'];

  let foundType = null;

  for (const param of params) {
    const upper = param.toUpperCase();
    if (upper.startsWith('TYPE=')) {
      return param.substring(5).toLowerCase();
    }
    // Some vCards use TYPE without =
    if (typeHierarchy.includes(upper)) {
      // Keep the most specific type (earlier in hierarchy)
      const currentIndex = typeHierarchy.indexOf(upper);
      const foundIndex = foundType ? typeHierarchy.indexOf(foundType.toUpperCase()) : -1;

      if (foundIndex === -1 || currentIndex < foundIndex) {
        foundType = upper.toLowerCase();
      }
    }
  }

  return foundType;
}

/**
 * Parse birthday from various vCard formats to ISO date
 * @param {string} value - Birthday value from vCard
 * @returns {string|null} ISO date (YYYY-MM-DD) or null
 */
function parseBirthday(value) {
  if (!value) return null;

  // Remove any non-numeric characters except hyphens
  const cleaned = value.replace(/[^\d-]/g, '');

  // Try ISO format (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return cleaned;
  }

  // Try compact format (YYYYMMDD)
  if (/^\d{8}$/.test(cleaned)) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`;
  }

  // Try year only
  if (/^\d{4}$/.test(cleaned)) {
    return `${cleaned}-01-01`;
  }

  return null;
}

/**
 * Leitet die Legacy-Skalarfelder (phone/email/address) aus den Multi-Value-
 * Listen einer vCard ab. Die Kontaktliste und der Bearbeiten-Dialog lesen diese
 * Basisspalten direkt (Issue #531); ohne sie bleiben synchronisierte Kontakte
 * ohne sichtbare Telefonnummer/E-Mail/Adresse.
 * @param {Object} vcard - Geparste vCard
 * @returns {{ phone: string|null, email: string|null, address: string|null }}
 */
function deriveScalarContactFields(vcard) {
  const phone = vcard.phones?.[0]?.value || null;
  const email = vcard.emails?.[0]?.value || null;

  const a = vcard.addresses?.[0] || null;
  let address = null;
  if (a) {
    const cityLine = [a.postalCode, a.city].filter(Boolean).join(' ');
    address = [a.street, cityLine, a.state, a.country].filter(Boolean).join(', ') || null;
  }

  return { phone, email, address };
}

/**
 * Bildet den vCard-CATEGORIES-Wert auf einen *stabilen* Kontakt-Kategorie-Key ab.
 * Ein freier oder fehlender Wert (z. B. `Sonstiges`, `Friends`) fällt konsistent
 * auf `misc` zurück, statt eine nicht existierende Kategorie zu speichern, die die
 * UI dann als „Sonstiges" gruppiert, aber im Select auf den ersten Eintrag setzt
 * (Issue #531). Nur der erste Wert einer Komma-Liste wird betrachtet.
 * @param {string|null} rawCategories - vCard-CATEGORIES-Wert
 * @param {Array<{key: string, name: string|null}>} categories - bekannte Kategorien
 * @returns {string} Kategorie-Key
 */
function resolveContactCategory(rawCategories, categories) {
  const list = categories || [];
  // Normalerweise 'misc'; falls der Haushalt diese Kategorie gelöscht hat, auf den
  // ersten vorhandenen Key ausweichen, damit nie ein verwaister Key gespeichert wird.
  const fallback = list.some((c) => c.key === 'misc') ? 'misc' : (list[0]?.key ?? 'misc');
  if (!rawCategories) return fallback;

  const first = String(rawCategories).split(',')[0]?.trim();
  if (!first) return fallback;

  const lower = first.toLowerCase();
  const match = list.find((c) =>
    c.key.toLowerCase() === lower ||
    (c.name && c.name.toLowerCase() === lower)
  );

  return match ? match.key : fallback;
}

// --------------------------------------------------------
// Account Management
// --------------------------------------------------------

/**
 * Test CardDAV connection
 * @param {string} cardavUrl - CardDAV server URL
 * @param {string} username - Username
 * @param {string} password - Password
 * @returns {Promise<Object>} { ok: true, addressbooks: [...] }
 */
async function testConnection(cardavUrl, username, password) {
  // Use mock if set (for testing)
  if (_testConnectionMock) {
    return _testConnectionMock(cardavUrl, username, password);
  }

  try {
    const { createDAVClient } = await import('tsdav');
    const client = await createDAVClient({
      serverUrl: cardavUrl,
      credentials: { username, password },
      authMethod: 'Basic',
      defaultAccountType: 'carddav',
    });

    const addressbooks = await client.fetchAddressBooks();
    if (!addressbooks.length) {
      throw new Error('Connected, but no addressbooks found.');
    }

    return { ok: true, addressbooks };
  } catch (err) {
    log.error('Connection test failed:', err.message);
    throw new Error(`CardDAV connection failed: ${err.message}`);
  }
}

/**
 * Add new CardDAV account
 * @param {string} name - Account display name
 * @param {string} cardavUrl - CardDAV server URL
 * @param {string} username - Username
 * @param {string} password - Password
 * @returns {Promise<Object>} { accountId, addressbooks }
 */
async function addAccount(name, cardavUrl, username, password) {
  try {
    // Validate inputs
    if (!name || !cardavUrl || !username || !password) {
      throw new Error('All fields required: name, cardavUrl, username, password');
    }

    // Test connection first
    const { addressbooks } = await testConnection(cardavUrl, username, password);

    // Check for duplicate
    const existing = db.get().prepare(
      'SELECT id FROM carddav_accounts WHERE carddav_url = ? AND username = ?'
    ).get(cardavUrl, username);

    if (existing) {
      throw new Error('Account with this URL and username already exists.');
    }

    // Warn if DB_ENCRYPTION_KEY not set
    if (!process.env.DB_ENCRYPTION_KEY) {
      log.warn('WARNING: DB_ENCRYPTION_KEY is not set - CardDAV credentials will be stored unencrypted.');
    }

    // Insert account
    const result = db.get().prepare(`
      INSERT INTO carddav_accounts (name, carddav_url, username, password)
      VALUES (?, ?, ?, ?)
    `).run(name, cardavUrl, username, password);

    const accountId = result.lastInsertRowid;

    // Insert addressbook selections (all enabled by default)
    const addressbookData = [];
    for (const abook of addressbooks) {
      const abookName = abook.displayName || 'Unnamed Addressbook';

      db.get().prepare(`
        INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
        VALUES (?, ?, ?, 1)
      `).run(accountId, abook.url, abookName);

      addressbookData.push({ url: abook.url, name: abookName, enabled: true });
    }

    log.info(`Added CardDAV account "${name}" with ${addressbooks.length} addressbooks.`);

    const account = {
      id: accountId,
      name,
      cardavUrl,
      username,
      createdAt: new Date().toISOString(),
      lastSync: null
    };

    return { account, addressbooks: addressbookData };
  } catch (err) {
    log.error('Failed to add account:', err.message);
    throw err;
  }
}

/**
 * Get all CardDAV accounts
 * @returns {Array<Object>} Array of account objects (without passwords)
 */
function getAllAccounts() {
  try {
    const accounts = db.get().prepare(`
      SELECT id, name, carddav_url, username, created_at, last_sync, last_error, last_error_at
      FROM carddav_accounts
      ORDER BY created_at DESC
    `).all();

    // Kein Passwort in der Antwort.
    return accounts.map(acc => ({
      id: acc.id,
      name: acc.name,
      cardavUrl: acc.carddav_url,
      username: acc.username,
      createdAt: acc.created_at,
      lastSync: acc.last_sync,
      lastError: acc.last_error ?? null,
      lastErrorAt: acc.last_error_at ?? null,
    }));
  } catch (err) {
    log.error('Failed to get accounts:', err.message);
    throw err;
  }
}

/**
 * Zugangsdaten eines Kontos ändern. Die Adressbuch-Auswahl bleibt erhalten -
 * genau dafür existiert dieser Pfad: ein rotiertes Passwort soll nicht bedeuten,
 * dass das Konto gelöscht und die Auswahl neu getroffen werden muss.
 *
 * Ein Wechsel von URL oder Benutzername kann mit einem anderen Konto kollidieren
 * (UNIQUE(carddav_url, username)); der Fall wird als 'conflict' gemeldet statt
 * als Ausnahme.
 *
 * @param {number} accountId
 * @param {{name:string, cardavUrl:string, username:string, password:string|null}} fields
 *        password === null lässt das gespeicherte Passwort unberührt.
 * @returns {Object|'not-found'|'conflict'} Konto ohne Passwort
 */
function updateAccount(accountId, { name, cardavUrl, username, password }) {
  const database = db.get();
  const account = database.prepare('SELECT * FROM carddav_accounts WHERE id = ?').get(accountId);
  if (!account) return 'not-found';

  const clash = database.prepare(`
    SELECT id FROM carddav_accounts
    WHERE carddav_url = ? AND username = ? AND id != ?
  `).get(cardavUrl, username, accountId);
  if (clash) return 'conflict';

  database.prepare(`
    UPDATE carddav_accounts
    SET name = ?, carddav_url = ?, username = ?, password = COALESCE(?, password)
    WHERE id = ?
  `).run(name, cardavUrl, username, password, accountId);

  // Geänderte Zugangsdaten machen einen alten Fehler gegenstandslos - er wird
  // beim nächsten Lauf neu gesetzt, wenn er weiterbesteht.
  if (password !== null || cardavUrl !== account.carddav_url || username !== account.username) {
    database.prepare('UPDATE carddav_accounts SET last_error = NULL, last_error_at = NULL WHERE id = ?').run(accountId);
  }

  log.info(`Updated CardDAV account ${accountId} ("${name}").`);

  const row = database.prepare(`
    SELECT id, name, carddav_url, username, created_at, last_sync, last_error, last_error_at
    FROM carddav_accounts WHERE id = ?
  `).get(accountId);
  return {
    id: row.id,
    name: row.name,
    cardavUrl: row.carddav_url,
    username: row.username,
    createdAt: row.created_at,
    lastSync: row.last_sync,
    lastError: row.last_error ?? null,
    lastErrorAt: row.last_error_at ?? null,
  };
}

/**
 * Delete CardDAV account
 * @param {number} accountId - Account ID
 * @returns {Object} { success: true }
 */
function deleteAccount(accountId) {
  try {
    const account = db.get().prepare('SELECT * FROM carddav_accounts WHERE id = ?').get(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found.`);
    }

    // CASCADE will delete carddav_addressbook_selection entries
    // Contacts will have carddav_account_id SET NULL (see migration)
    db.get().prepare('DELETE FROM carddav_accounts WHERE id = ?').run(accountId);

    log.info(`Deleted CardDAV account ${accountId} ("${account.name}").`);

    return { success: true };
  } catch (err) {
    log.error('Failed to delete account:', err.message);
    throw err;
  }
}

// --------------------------------------------------------
// Addressbook Discovery & Selection
// --------------------------------------------------------

/**
 * Discover addressbooks for an account (refresh from server)
 * @param {number} accountId - Account ID
 * @returns {Promise<Array<Object>>} Array of addressbook objects
 */
async function discoverAddressbooks(accountId) {
  try {
    const account = db.get().prepare('SELECT * FROM carddav_accounts WHERE id = ?').get(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found.`);
    }

    const { addressbooks } = await testConnection(account.carddav_url, account.username, account.password);

    // UPSERT into carddav_addressbook_selection
    const result = [];
    for (const abook of addressbooks) {
      const abookName = abook.displayName || 'Unnamed Addressbook';

      // Check if exists
      const existing = db.get().prepare(`
        SELECT id, enabled FROM carddav_addressbook_selection
        WHERE account_id = ? AND addressbook_url = ?
      `).get(accountId, abook.url);

      if (existing) {
        // Update name only (preserve enabled state)
        db.get().prepare(`
          UPDATE carddav_addressbook_selection
          SET addressbook_name = ?
          WHERE id = ?
        `).run(abookName, existing.id);

        result.push({
          id: existing.id,
          url: abook.url,
          name: abookName,
          enabled: existing.enabled === 1
        });
      } else {
        // Insert new (enabled by default)
        const insertResult = db.get().prepare(`
          INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
          VALUES (?, ?, ?, 1)
        `).run(accountId, abook.url, abookName);

        result.push({
          id: insertResult.lastInsertRowid,
          url: abook.url,
          name: abookName,
          enabled: true
        });
      }
    }

    log.info(`Discovered ${addressbooks.length} addressbooks for account ${accountId}.`);

    return result;
  } catch (err) {
    log.error('Failed to discover addressbooks:', err.message);
    throw err;
  }
}

/**
 * Toggle addressbook enabled state
 * @param {number} addressbookId - Addressbook selection ID
 * @param {boolean} enabled - Enable or disable
 * @returns {Object} { success: true }
 */
function toggleAddressbook(addressbookId, enabled) {
  try {
    const enabledValue = enabled ? 1 : 0;

    const result = db.get().prepare(`
      UPDATE carddav_addressbook_selection
      SET enabled = ?
      WHERE id = ?
    `).run(enabledValue, addressbookId);

    if (result.changes === 0) {
      throw new Error(`Addressbook ${addressbookId} not found.`);
    }

    log.info(`Addressbook ${addressbookId} ${enabled ? 'enabled' : 'disabled'}.`);

    return { success: true };
  } catch (err) {
    log.error('Failed to toggle addressbook:', err.message);
    throw err;
  }
}

// --------------------------------------------------------
// Contact Sync
// --------------------------------------------------------

/**
 * Synchronisiert alle konfigurierten CardDAV-Accounts. Einstiegspunkt des
 * Auto-Sync-Schedulers; kehrt sofort zurück, wenn keine Accounts existieren.
 *
 * Ein fehlgeschlagener Account bricht die übrigen nicht ab.
 *
 * @returns {Promise<{ success: boolean, syncedAccounts: number, syncedContacts: number }>}
 */
async function sync() {
  const accounts = getAllAccounts();

  if (accounts.length === 0) {
    log.info('No CardDAV accounts configured.');
    return { success: true, syncedAccounts: 0, syncedContacts: 0 };
  }

  let syncedContacts = 0;
  let successfulAccounts = 0;

  for (const account of accounts) {
    try {
      const { synced } = await syncAccount(account.id);
      syncedContacts += synced;
      successfulAccounts++;
    } catch (err) {
      // syncAccount loggt bereits; hier nur weitermachen statt abbrechen.
      log.error(`Sync failed for account ${account.id}:`, err.message);
    }
  }

  log.info(`CardDAV sync complete: ${successfulAccounts}/${accounts.length} accounts, ${syncedContacts} contacts.`);

  return { success: true, syncedAccounts: successfulAccounts, syncedContacts };
}

/**
 * Entfernt lokal die Kontakte eines Adressbuchs, die der Server nicht mehr liefert.
 *
 * Kontakte sind keine Termine: die Smart-Merge-Logik adoptiert bestehende lokale
 * Kontakte (Treffer über E-Mail/Telefon) und hängt ihnen eine `carddav_uid` an.
 * Solche Kontakte (`carddav_origin = 'merged'`) tragen lokal gepflegte Daten, die
 * remote nie existiert haben, und werden deshalb nur **entkoppelt** statt gelöscht —
 * sie bleiben als rein lokale Kontakte bestehen. Nur rein aus CardDAV entstandene
 * Kontakte (`'remote'`) werden wirklich gelöscht.
 *
 * Bestandskontakte aus der Zeit vor Migration v89 tragen 'merged' und werden damit
 * bewusst konservativ behandelt: ihre Herkunft ist nicht mehr rekonstruierbar.
 *
 * Leer-Guard: Liefert ein Adressbuch keine einzige UID, obwohl lokal Kontakte daran
 * hängen, passiert nichts. Ein leeres Ergebnis ist weit häufiger ein stiller Server-
 * oder Auth-Fehler als ein tatsächlich geleertes Adressbuch.
 *
 * @param {object} database
 * @param {number} accountId
 * @param {string} addressbookUrl
 * @param {Set}    seenUids  UIDs, die der Server geliefert hat
 * @returns {{ deleted: number, decoupled: number }}
 */
export function pruneRemovedContacts(database, accountId, addressbookUrl, seenUids) {
  const local = database.prepare(`
    SELECT id, carddav_uid, carddav_origin FROM contacts
    WHERE carddav_account_id = ? AND carddav_addressbook_url = ? AND carddav_uid IS NOT NULL
  `).all(accountId, addressbookUrl);

  const stale = local.filter(c => !seenUids.has(c.carddav_uid));
  if (stale.length === 0) return { deleted: 0, decoupled: 0 };

  if (seenUids.size === 0) {
    log.warn(
      `Addressbook ${addressbookUrl}: server returned no contacts, but ${stale.length} exist ` +
      `locally. Skipping — assuming a fetch error rather than an emptied addressbook.`
    );
    return { deleted: 0, decoupled: 0 };
  }

  const del = database.prepare('DELETE FROM contacts WHERE id = ?');
  const decouple = database.prepare(`
    UPDATE contacts
    SET carddav_account_id = NULL, carddav_uid = NULL,
        carddav_addressbook_url = NULL, carddav_origin = NULL
    WHERE id = ?
  `);

  let deleted = 0;
  let decoupled = 0;

  for (const contact of stale) {
    // Alles außer einem nachweislich rein remote entstandenen Kontakt wird nur
    // entkoppelt — im Zweifel lieber eine Karteileiche als verlorene Nutzerdaten.
    if (contact.carddav_origin === 'remote') {
      del.run(contact.id);
      deleted++;
    } else {
      decouple.run(contact.id);
      decoupled++;
    }
  }

  return { deleted, decoupled };
}

/**
 * Sync all enabled addressbooks for an account
 * @param {number} accountId - Account ID
 * @returns {Promise<Object>} { synced, errors }
 */
async function syncAccount(accountId) {
  // Use mock if set (for testing)
  if (_syncAccountMock) {
    return _syncAccountMock(accountId);
  }

  try {
    const account = db.get().prepare('SELECT * FROM carddav_accounts WHERE id = ?').get(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found.`);
    }

    log.info(`Syncing CardDAV account ${accountId} ("${account.name}")...`);

    // Create tsdav client
    const { createDAVClient } = await import('tsdav');
    const client = await createDAVClient({
      serverUrl: account.carddav_url,
      credentials: { username: account.username, password: account.password },
      authMethod: 'Basic',
      defaultAccountType: 'carddav',
    });

    // Get enabled addressbooks for this account
    const enabledAddressbooks = db.get().prepare(`
      SELECT id, addressbook_url, addressbook_name
      FROM carddav_addressbook_selection
      WHERE account_id = ? AND enabled = 1
    `).all(accountId);

    if (enabledAddressbooks.length === 0) {
      log.info(`Account ${accountId}: no enabled addressbooks, skipping.`);
      return { synced: 0, errors: 0 };
    }

    let totalSynced = 0;
    let totalErrors = 0;
    const failures = [];

    // Fetch all addressbooks from server
    const serverAddressbooks = await client.fetchAddressBooks();

    for (const selAbook of enabledAddressbooks) {
      // Find matching addressbook from server
      const serverAbook = serverAddressbooks.find(sa => sa.url === selAbook.addressbook_url);

      if (!serverAbook) {
        log.warn(`Addressbook ${selAbook.addressbook_url} not found on server, disabling.`);
        db.get().prepare(`
          UPDATE carddav_addressbook_selection SET enabled = 0
          WHERE id = ?
        `).run(selAbook.id);
        const message = 'not found on server';
        recordAddressbookOutcome(selAbook.id, message);
        failures.push(`${selAbook.addressbook_name || selAbook.addressbook_url}: ${message}`);
        continue;
      }

      // Sync this addressbook
      const { synced, errors, errorMessage } = await syncAddressbook(accountId, selAbook.addressbook_url, client, serverAbook);
      totalSynced += synced;
      totalErrors += errors;
      // Fehler an der Zeile festhalten, die ihn verursacht hat - der Konto-Text
      // allein lässt sich in der Liste nicht zuordnen.
      recordAddressbookOutcome(selAbook.id, errorMessage ?? null);
      if (errorMessage) failures.push(errorMessage);
    }

    // Update last_sync for account
    db.get().prepare(`
      UPDATE carddav_accounts SET last_sync = ? WHERE id = ?
    `).run(new Date().toISOString(), accountId);

    // Teilfehler festhalten statt nur loggen: ein Adressbuch kann scheitern,
    // während die übrigen sauber durchlaufen - das UI meldete bisher trotzdem
    // uneingeschränkten Erfolg (#534).
    recordSyncOutcome(accountId, failures);

    log.info(`Account ${accountId} sync complete: ${totalSynced} contacts synced, ${totalErrors} errors.`);

    return { synced: totalSynced, errors: totalErrors };
  } catch (err) {
    log.error(`Sync failed for account ${accountId}:`, err.message);
    recordSyncOutcome(accountId, [err.message]);
    throw err;
  }
}

/** Maximale Länge der gespeicherten Fehlermeldung - schützt vor Server-Stacktraces. */
const MAX_SYNC_ERROR_LENGTH = 500;

/**
 * Schreibt das Ergebnis eines Sync-Laufs an das Konto: die gesammelten
 * Fehlermeldungen oder NULL, wenn der Lauf sauber war. NULL ist die Aussage
 * „zuletzt lief alles durch" und muss deshalb aktiv gesetzt werden.
 *
 * @param {number} accountId
 * @param {string[]} failures - leere Liste = sauberer Lauf
 */
/**
 * Schreibt das Ergebnis eines Adressbuch-Laufs an dessen Auswahlzeile.
 * @param {number} selectionId
 * @param {string|null} message - null = dieses Adressbuch lief sauber
 */
function recordAddressbookOutcome(selectionId, message) {
  try {
    db.get().prepare(`
      UPDATE carddav_addressbook_selection SET last_error = ? WHERE id = ?
    `).run(message ? String(message).slice(0, MAX_SYNC_ERROR_LENGTH) : null, selectionId);
  } catch (err) {
    log.error(`Failed to record addressbook outcome for ${selectionId}:`, err.message);
  }
}

function recordSyncOutcome(accountId, failures = []) {
  try {
    const message = failures.length
      ? failures.join(' · ').slice(0, MAX_SYNC_ERROR_LENGTH)
      : null;
    db.get().prepare(`
      UPDATE carddav_accounts SET last_error = ?, last_error_at = ? WHERE id = ?
    `).run(message, message ? new Date().toISOString() : null, accountId);
  } catch (err) {
    // Der Sync selbst darf daran nicht scheitern.
    log.error(`Failed to record sync outcome for account ${accountId}:`, err.message);
  }
}

/** Vergleicht zwei URLs auf Pfad-Ebene (Trailing-Slash-tolerant). */
function sameResource(a, b) {
  const norm = (u) => {
    try { return new URL(u).pathname.replace(/\/+$/, ''); }
    catch { return String(u || '').replace(/\/+$/, ''); }
  };
  return norm(a) === norm(b);
}

/**
 * Holt vCards aus einem Adressbuch und umgeht dabei einen leeren Multistatus,
 * den manche Server (z. B. mailbox.org, Issue #529) auf die gefilterte
 * Standard-Abfrage liefern: tsdav enumeriert vCards per `addressbook-query` mit
 * `<card:prop-filter name="FN"/>`. Für diese exakt gefilterte Query antworten
 * einige Server mit 0 Objekten, obwohl das Adressbuch gefüllt ist. Liefert die
 * Standard-Abfrage nichts, enumerieren wir die Objekt-URLs stattdessen filterfrei
 * per PROPFIND (depth:1) und holen die vCards per Multiget.
 *
 * @param {Object} client - tsdav DAVClient (Auth-Header bereits gebunden)
 * @param {Object} addressBook - Adressbuch-Objekt mit `.url`
 * @returns {Promise<Array>} vCard-Objekte ({ url, etag, data })
 */
async function fetchVCardsResilient(client, addressBook) {
  const primary = await client.fetchVCards({ addressBook });
  if (primary && primary.length > 0) return primary;

  let members;
  try {
    members = await client.propfind({
      url: addressBook.url,
      props: { 'd:getetag': {} },
      depth: '1',
    });
  } catch (err) {
    log.warn(`PROPFIND fallback failed for ${addressBook.url}: ${err.message}`);
    return primary || [];
  }

  const objectUrls = (members || [])
    .map((m) => m?.href)
    .filter(Boolean)
    .map((href) => new URL(href, addressBook.url).href)
    // Die Kollektion selbst (das Adressbuch) ist kein Kontakt.
    .filter((href) => !sameResource(href, addressBook.url));

  if (objectUrls.length === 0) return primary || [];

  log.info(
    `Addressbook ${addressBook.url}: FN-filtered query returned 0, ` +
    `PROPFIND fallback found ${objectUrls.length} object(s) (#529).`
  );
  return client.fetchVCards({ addressBook, objectUrls });
}

/**
 * Sync a specific addressbook
 * @param {number} accountId - Account ID
 * @param {string} addressbookUrl - Addressbook URL
 * @param {Object} client - tsdav client instance (optional, will create if not provided)
 * @param {Object} serverAddressbook - Server addressbook object (optional)
 * @returns {Promise<Object>} { synced, errors }
 */
async function syncAddressbook(accountId, addressbookUrl, client = null, serverAddressbook = null) {
  try {
    const account = db.get().prepare('SELECT * FROM carddav_accounts WHERE id = ?').get(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found.`);
    }

    // Create client if not provided
    if (!client) {
      const { createDAVClient } = await import('tsdav');
      client = await createDAVClient({
        serverUrl: account.carddav_url,
        credentials: { username: account.username, password: account.password },
        authMethod: 'Basic',
        defaultAccountType: 'carddav',
      });
    }

    // Find addressbook if not provided
    if (!serverAddressbook) {
      const addressbooks = await client.fetchAddressBooks();
      serverAddressbook = addressbooks.find(ab => ab.url === addressbookUrl);

      if (!serverAddressbook) {
        throw new Error(`Addressbook ${addressbookUrl} not found on server.`);
      }
    }

    // Fetch vCards from addressbook (mit FN-Filter-Fallback für mailbox.org etc., #529)
    let vcardObjects;
    try {
      vcardObjects = await fetchVCardsResilient(client, serverAddressbook);
    } catch (err) {
      log.error(`Failed to fetch vCards from ${addressbookUrl}:`, err.message);
      // Die Meldung wird mit zurückgegeben, damit sie der Aufrufer am Konto
      // festhalten kann - im Log allein sieht sie niemand (#534).
      const label = serverAddressbook?.displayName || addressbookUrl;
      return { synced: 0, errors: 1, errorMessage: `${label}: ${err.message}` };
    }

    let synced = 0;
    let errors = 0;
    const seenUids = new Set();

    // Parse and merge each vCard
    for (const vcardObj of vcardObjects) {
      try {
        const vCardText = vcardObj.data || '';
        if (!vCardText.trim()) continue;

        // UID vor dem Merge sammeln: ein fehlgeschlagener Merge darf nicht dazu
        // führen, dass der Kontakt anschließend als remote gelöscht gilt.
        const uid = parseVCard(vCardText).uid;
        if (uid) seenUids.add(uid);

        await parseAndMergeContact(vCardText, accountId, addressbookUrl);
        synced++;
      } catch (err) {
        log.error(`Failed to parse/merge vCard:`, err.message);
        errors++;
      }
    }

    // Löschphase (nur wenn jede vCard verstanden wurde): bei Fehlern ist `seenUids`
    // unvollständig und ein Prune träfe Kontakte, die auf dem Server noch existieren.
    let deleted = 0;
    let decoupled = 0;
    if (errors > 0) {
      log.warn(
        `Addressbook ${addressbookUrl}: ${errors} vCard(s) could not be processed, ` +
        `skipping deletion to avoid removing contacts that still exist remotely.`
      );
    } else {
      ({ deleted, decoupled } = pruneRemovedContacts(db.get(), accountId, addressbookUrl, seenUids));
    }

    log.info(
      `Addressbook ${addressbookUrl}: ${synced} contacts synced, ${errors} errors` +
      `${deleted   > 0 ? `, ${deleted} deleted` : ''}` +
      `${decoupled > 0 ? `, ${decoupled} kept as local contacts` : ''}.`
    );

    return { synced, errors, deleted, decoupled };
  } catch (err) {
    log.error(`Failed to sync addressbook ${addressbookUrl}:`, err.message);
    throw err;
  }
}

/**
 * Parse vCard and merge with existing contact using Smart Merge Logic
 * @param {string} vCardText - Raw vCard data
 * @param {number} accountId - Account ID
 * @param {string} addressbookUrl - Addressbook URL
 * @returns {Promise<number>} Contact ID
 */
async function parseAndMergeContact(vCardText, accountId, addressbookUrl) {
  try {
    const vcard = parseVCard(vCardText);

    if (!vcard.uid) {
      throw new Error('vCard missing UID, skipping.');
    }

    if (!vcard.name) {
      throw new Error('vCard missing name (FN/N), skipping.');
    }

    // Smart Merge Logic (see design doc)

    // Step 1: Check for existing contact by cardav_uid
    let contact = db.get().prepare(`
      SELECT * FROM contacts
      WHERE carddav_account_id = ? AND carddav_addressbook_url = ? AND carddav_uid = ?
    `).get(accountId, addressbookUrl, vcard.uid);

    if (contact) {
      // Update existing contact (only fill NULL fields to preserve manual changes)
      updateContact(contact.id, vcard, false);
      updateContactMultiValues(contact.id, vcard);
      return contact.id;
    }

    // Step 2: Check for existing contact by email or phone match
    contact = findContactByEmailOrPhone(vcard.emails, vcard.phones);

    if (contact) {
      // Update existing contact and establish CardDAV link
      updateContact(contact.id, vcard, true);

      // Set CardDAV link. origin = 'merged': dieser Kontakt existierte lokal schon
      // und wurde nur adoptiert — er darf beim Remote-Löschen nicht mitgehen,
      // sondern wird nur entkoppelt (siehe pruneRemovedContacts).
      db.get().prepare(`
        UPDATE contacts
        SET carddav_account_id = ?, carddav_uid = ?, carddav_addressbook_url = ?,
            carddav_origin = 'merged'
        WHERE id = ?
      `).run(accountId, vcard.uid, addressbookUrl, contact.id);

      updateContactMultiValues(contact.id, vcard);
      return contact.id;
    }

    // Step 3: No match - insert new contact.
    // origin = 'remote': rein aus CardDAV entstanden, trägt keine lokal gepflegten
    // Daten und darf beim Remote-Löschen entfernt werden.
    const knownCategories = db.get().prepare('SELECT key, name FROM contact_categories').all();
    const scalar = deriveScalarContactFields(vcard);
    const result = db.get().prepare(`
      INSERT INTO contacts (
        name, category, phone, email, address, organization, job_title, birthday, website,
        photo, nickname, notes,
        carddav_account_id, carddav_uid, carddav_addressbook_url, carddav_origin
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'remote')
    `).run(
      vcard.name,
      resolveContactCategory(vcard.categories, knownCategories),
      scalar.phone,
      scalar.email,
      scalar.address,
      vcard.organization,
      vcard.jobTitle,
      vcard.birthday,
      vcard.website,
      vcard.photo,
      vcard.nickname,
      vcard.notes,
      accountId,
      vcard.uid,
      addressbookUrl
    );

    const contactId = result.lastInsertRowid;

    // Insert multi-value fields
    insertContactMultiValues(contactId, vcard);

    return contactId;
  } catch (err) {
    log.error('Failed to parse and merge contact:', err.message);
    throw err;
  }
}

/**
 * Find existing contact by email or phone match
 * @param {Array<Object>} emails - Array of email objects
 * @param {Array<Object>} phones - Array of phone objects
 * @returns {Object|null} Contact object or null
 */
function findContactByEmailOrPhone(emails, phones) {
  // Try email match first
  for (const email of emails) {
    const contact = db.get().prepare(`
      SELECT c.* FROM contacts c
      LEFT JOIN contact_emails ce ON c.id = ce.contact_id
      WHERE c.email = ? OR ce.value = ?
      LIMIT 1
    `).get(email.value, email.value);

    if (contact) return contact;
  }

  // Try phone match
  for (const phone of phones) {
    const contact = db.get().prepare(`
      SELECT c.* FROM contacts c
      LEFT JOIN contact_phones cp ON c.id = cp.contact_id
      WHERE c.phone = ? OR cp.value = ?
      LIMIT 1
    `).get(phone.value, phone.value);

    if (contact) return contact;
  }

  return null;
}

/**
 * Update existing contact with vCard data (only NULL fields)
 * @param {number} contactId - Contact ID
 * @param {Object} vcard - Parsed vCard object
 * @param {boolean} fillAll - If true, update all fields; if false, only update NULL fields
 */
function updateContact(contactId, vcard, fillAll = false) {
  const contact = db.get().prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!contact) return;

  const updates = [];
  const values = [];

  // Helper to conditionally update field
  const maybeUpdate = (field, dbColumn, vcardValue) => {
    if (vcardValue !== null && vcardValue !== undefined) {
      if (fillAll || contact[dbColumn] === null) {
        updates.push(`${dbColumn} = ?`);
        values.push(vcardValue);
      }
    }
  };

  // Legacy-Skalarfelder aus den Multi-Value-Listen ableiten (siehe #531), damit
  // Liste und Bearbeiten-Dialog sichtbare Werte haben. Bei bestehenden, vor diesem
  // Fix synchronisierten Kontakten füllt fillAll=false die noch NULL-en Spalten nach.
  const scalar = deriveScalarContactFields(vcard);

  // Kategorie nur auflösen, wenn die vCard überhaupt eine liefert (spart sonst die
  // DB-Abfrage). Eine echte Zuordnung wird immer übernommen; den misc-Fallback nur,
  // wenn lokal noch keine Kategorie gesetzt ist — sonst würde die Adoption (fillAll)
  // eine gültige manuelle Kategorie auf misc herabstufen (#531-Audit).
  let resolvedCategory = null;
  if (vcard.categories != null) {
    const knownCategories = db.get().prepare('SELECT key, name FROM contact_categories').all();
    const resolved = resolveContactCategory(vcard.categories, knownCategories);
    resolvedCategory = (resolved !== 'misc' || !contact.category) ? resolved : null;
  }

  maybeUpdate('name', 'name', vcard.name);
  maybeUpdate('phone', 'phone', scalar.phone);
  maybeUpdate('email', 'email', scalar.email);
  maybeUpdate('address', 'address', scalar.address);
  maybeUpdate('organization', 'organization', vcard.organization);
  maybeUpdate('jobTitle', 'job_title', vcard.jobTitle);
  maybeUpdate('birthday', 'birthday', vcard.birthday);
  maybeUpdate('website', 'website', vcard.website);
  maybeUpdate('photo', 'photo', vcard.photo);
  maybeUpdate('nickname', 'nickname', vcard.nickname);
  maybeUpdate('notes', 'notes', vcard.notes);
  maybeUpdate('categories', 'category', resolvedCategory);

  if (updates.length === 0) return;

  values.push(contactId);

  db.get().prepare(`
    UPDATE contacts SET ${updates.join(', ')} WHERE id = ?
  `).run(...values);
}

/**
 * Update contact multi-value fields (phones, emails, addresses)
 * Preserves primary entries, replaces non-primary entries
 * @param {number} contactId - Contact ID
 * @param {Object} vcard - Parsed vCard object
 */
function updateContactMultiValues(contactId, vcard) {
  const transaction = db.get().transaction(() => {
    // Delete non-primary entries
    db.get().prepare('DELETE FROM contact_phones WHERE contact_id = ? AND is_primary = 0').run(contactId);
    db.get().prepare('DELETE FROM contact_emails WHERE contact_id = ? AND is_primary = 0').run(contactId);
    db.get().prepare('DELETE FROM contact_addresses WHERE contact_id = ? AND is_primary = 0').run(contactId);

    // Insert new entries from vCard
    insertContactMultiValues(contactId, vcard);
  });

  transaction();
}

/**
 * Insert contact multi-value fields (phones, emails, addresses)
 * @param {number} contactId - Contact ID
 * @param {Object} vcard - Parsed vCard object
 */
function insertContactMultiValues(contactId, vcard) {
  // Check if primary entries exist
  const hasPrimaryPhone = db.get().prepare(
    'SELECT 1 FROM contact_phones WHERE contact_id = ? AND is_primary = 1'
  ).get(contactId);

  const hasPrimaryEmail = db.get().prepare(
    'SELECT 1 FROM contact_emails WHERE contact_id = ? AND is_primary = 1'
  ).get(contactId);

  const hasPrimaryAddress = db.get().prepare(
    'SELECT 1 FROM contact_addresses WHERE contact_id = ? AND is_primary = 1'
  ).get(contactId);

  // Batch insert phones
  if (vcard.phones && vcard.phones.length > 0) {
    const placeholders = vcard.phones.map(() => '(?, ?, ?, ?)').join(', ');
    const values = vcard.phones.flatMap((phone, i) => [
      contactId,
      phone.label || null,
      phone.value,
      (!hasPrimaryPhone && i === 0) ? 1 : 0
    ]);

    db.get().prepare(`
      INSERT INTO contact_phones (contact_id, label, value, is_primary)
      VALUES ${placeholders}
    `).run(...values);
  }

  // Batch insert emails
  if (vcard.emails && vcard.emails.length > 0) {
    const placeholders = vcard.emails.map(() => '(?, ?, ?, ?)').join(', ');
    const values = vcard.emails.flatMap((email, i) => [
      contactId,
      email.label || null,
      email.value,
      (!hasPrimaryEmail && i === 0) ? 1 : 0
    ]);

    db.get().prepare(`
      INSERT INTO contact_emails (contact_id, label, value, is_primary)
      VALUES ${placeholders}
    `).run(...values);
  }

  // Batch insert addresses
  if (vcard.addresses && vcard.addresses.length > 0) {
    const placeholders = vcard.addresses.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const values = vcard.addresses.flatMap((addr, i) => [
      contactId,
      addr.label || null,
      addr.street,
      addr.city,
      addr.state,
      addr.postalCode,
      addr.country,
      (!hasPrimaryAddress && i === 0) ? 1 : 0
    ]);

    db.get().prepare(`
      INSERT INTO contact_addresses (contact_id, label, street, city, state, postal_code, country, is_primary)
      VALUES ${placeholders}
    `).run(...values);
  }
}

// --------------------------------------------------------
// Exports
// --------------------------------------------------------

export {
  // Account Management
  addAccount,
  getAllAccounts,
  updateAccount,
  deleteAccount,
  testConnection,

  // Addressbook Discovery
  discoverAddressbooks,
  toggleAddressbook,

  // Contact Sync
  sync,
  syncAccount,
  syncAddressbook,
  parseAndMergeContact,

  // Helpers (exported for testing)
  parseVCard,
  unescapeVCardValue,
  splitVCardValue,
  deriveScalarContactFields,
  resolveContactCategory,
  fetchVCardsResilient,
  _mockTestConnection,
  _mockSyncAccount,
};

// --------------------------------------------------------
// Test Mocking Support
// --------------------------------------------------------

let _testConnectionMock = null;
let _syncAccountMock = null;

/**
 * ONLY FOR TESTING: Mock testConnection for unit tests
 * @param {Function|null} mockFn - Mock function or null to reset
 */
function _mockTestConnection(mockFn) {
  _testConnectionMock = mockFn;
}

/**
 * ONLY FOR TESTING: Mock syncAccount for unit tests
 * @param {Function|null} mockFn - Mock function or null to reset
 */
function _mockSyncAccount(mockFn) {
  _syncAccountMock = mockFn;
}
