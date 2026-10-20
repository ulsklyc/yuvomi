/**
 * Modul: Kontakte (Contacts)
 * Zweck: REST-API-Routen für wichtige Familienkontakte
 * Abhängigkeiten: express, server/db.js, server/auth.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, oneOf, date, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT } from '../middleware/validate.js';
import { uniqueKey } from '../utils/category-slug.js';
import { composeDisplayName, normalizeNameParts } from '../../public/utils/contact-name.js';
import { CONTACT_PHONE_MAX_LENGTH } from '../../public/utils/contact-limits.js';
import { toE164, defaultCountryFromConfig } from '../utils/phone.js';
import { birthDateInput, placeholderBirthDate, validateYearUnknown } from '../services/birthdays.js';
import {
  contactActorFromRequest, mayChangeContactEmails, bodyChangesContactEmails,
  emailsTakenByOtherAccounts, EMAIL_IN_USE_MESSAGE,
} from '../services/contact-identity.js';

const log = createLogger('Contacts');

const router  = express.Router();

const FALLBACK_CATEGORY = 'misc';

/**
 * Liest die strukturierten Namensteile aus einem Request-Body (#535) und leitet
 * den Anzeigenamen daraus ab. Ein mitgesendetes `name` gilt nur, solange keine
 * Komponenten vorliegen - sonst wäre die Anzeige wieder quellenabhängig.
 * @param {Object} body - Request-Body
 * @returns {{parts: Object, provided: boolean, displayName: string|null}}
 */
function readNameParts(body) {
  const parts = normalizeNameParts({
    firstName:  body.firstName,
    lastName:   body.lastName,
    middleName: body.middleName,
    namePrefix: body.namePrefix,
    nameSuffix: body.nameSuffix,
  });
  const provided = ['firstName', 'lastName', 'middleName', 'namePrefix', 'nameSuffix']
    .some((k) => body[k] !== undefined);
  return { parts, provided, displayName: composeDisplayName(parts) };
}

/**
 * Ein Textfeld mit Laengengrenze, das seinen Fall benennt (#1909): ist es zu
 * lang, traegt die Pruefung `case` mit Grund und Grenze. Die Antwort reicht
 * ihn als `reason` und `params.limit` neben `error` weiter (fieldCase), und die
 * App sagt ihren Satz statt des englischen Servertexts. Gemeint ist vor allem
 * der vCard-Import: dort nannte der Toast bis dahin den rohen Text, weil er das
 * abgewiesene Feld nennt. Ein fehlender Pflichtwert ist kein "zu lang" und
 * bleibt ohne Grund.
 */
function limitedStr(val, label, max, { reason }, required = false) {
  const check = str(val, label, { max, required });
  if (check.error && val !== undefined && val !== null && String(val).trim().length > max) {
    check.case = { reason, params: { limit: max } };
  }
  return check;
}

/** Längen-Validierung der Namensteile (gleiche Grenze wie der Anzeigename). */
function namePartChecks(parts) {
  return [
    limitedStr(parts.firstName,  'Vorname',      MAX_TITLE, { reason: 'contacts_name_too_long' }),
    limitedStr(parts.lastName,   'Nachname',     MAX_TITLE, { reason: 'contacts_name_too_long' }),
    limitedStr(parts.middleName, 'Zweitname',    MAX_TITLE, { reason: 'contacts_name_too_long' }),
    limitedStr(parts.namePrefix, 'Namenszusatz', MAX_SHORT, { reason: 'contacts_name_too_long' }),
    limitedStr(parts.nameSuffix, 'Namenssuffix', MAX_SHORT, { reason: 'contacts_name_too_long' }),
  ];
}

/** Ein Geburtstag, den der Server als Datum abweist, benennt seinen Fall (#1909). */
function birthdayCheck(check) {
  if (check.error) check.case = { reason: 'contacts_birthday_invalid' };
  return check;
}

/** Verwaltbare Kontakt-Kategorien aus der DB (nach sort_order). */
function loadContactCategories() {
  return db.get().prepare(
    'SELECT key, name, label_key, icon, sort_order, color FROM contact_categories ORDER BY sort_order ASC, key ASC'
  ).all();
}

/**
 * Die kuratierten Toene, aus denen eine Kategorie waehlen darf.
 *
 * EINE ALLOWLIST, KEIN FREIER FARBWAEHLER, und der Grund ist gemessen: die
 * Kategoriescheibe ist eine VOLLTON-Marke, ihre Tinte ist die feste
 * `--color-ink-on-vivid` (Vollton-Regel, DESIGN.md). Das haelt nur ueber
 * kuratierten Toenen - eine frei gewaehlte Farbe hat unbestimmte Helligkeit und
 * muesste als Kante statt als Flaeche erscheinen, also als zweites Gesicht
 * derselben Marke. Sieben Toene sind fuer ein Kategorie-Vokabular reichlich,
 * und es sind exakt die sieben, die vorher in contacts.css standen: bestehende
 * Haushalte sehen nach der Migration genau dasselbe wie davor.
 *
 * Der leere Wert gehoert dazu und heisst NEUTRAL - siehe Migration 152.
 */
const CONTACT_CATEGORY_COLORS = Object.freeze([
  'var(--color-success)',
  'var(--color-warning)',
  'var(--color-accent)',
  'var(--module-budget)',
  'var(--module-meals)',
  'var(--color-danger)',
  'var(--color-text-secondary)',
]);

/** '' und null bedeuten beide "kein Ton"; alles ausserhalb der Liste wird abgewiesen. */
function normalizeCategoryColor(value) {
  if (value === undefined) return { skip: true };
  if (value === null || value === '') return { value: null };
  if (!CONTACT_CATEGORY_COLORS.includes(value)) return { error: 'Unknown category colour.' };
  return { value };
}

/** Nur die Keys — für die dynamische Kategorie-Validierung. */
function validContactCategoryKeys() {
  return loadContactCategories().map((c) => c.key);
}

/**
 * Die im Formular GEWAEHLTE Kategorie gibt es nicht mehr (#1909): jemand hat sie
 * geloescht, waehrend das Formular offen war. Der Grund nennt den Fall nur, wenn
 * er der EINZIGE Befund ist - die Seite haelt das Formular dann offen und bietet
 * die aktuellen Kategorien an. Fehlt die Kategorie im Rumpf, ist nichts gewaehlt.
 */
function selectedCategoryGone(vCat, errors) {
  return vCat?.error && errors.length === 1 ? { reason: 'contacts_selected_category_not_found' } : {};
}

/**
 * Der Fall einer abgewiesenen Eingabe (#1909): die geloeschte Kategorie, wenn
 * sie der einzige Befund ist (selectedCategoryGone), sonst das ERSTE Feld, das
 * seinen Fall benennt (limitedStr, birthdayCheck). Der Satz dazu nennt dieses
 * Feld - stimmt also auch, wenn daneben ein zweites scheitert. Ohne benannten
 * Fall: nichts, und die App sagt ihren allgemeinen Satz.
 */
function fieldCase(vCat, checks, errors) {
  const gone = selectedCategoryGone(vCat, errors);
  if (gone.reason) return gone;
  return checks.find((check) => check?.error && check.case)?.case ?? {};
}

/** Anzahl Kontakte, die eine Kategorie referenzieren (Guard vor dem Löschen). */
function contactCategoryInUseCount(key) {
  return db.get().prepare('SELECT COUNT(*) AS n FROM contacts WHERE category = ?').get(key).n;
}

/**
 * Loads multi-value fields (phones, emails, addresses) for a contact.
 * @param {number} contactId - Contact ID
 * @returns {{ phones: Array, emails: Array, addresses: Array }}
 */
function loadMultiValueFields(contactId) {
  const phones = db.get().prepare(`
    SELECT id, label, value, is_primary FROM contact_phones
    WHERE contact_id = ?
    ORDER BY is_primary DESC, id ASC
  `).all(contactId).map(p => ({
    id: p.id,
    label: p.label,
    value: p.value,
    isPrimary: p.is_primary === 1
  }));

  const emails = db.get().prepare(`
    SELECT id, label, value, is_primary FROM contact_emails
    WHERE contact_id = ?
    ORDER BY is_primary DESC, id ASC
  `).all(contactId).map(e => ({
    id: e.id,
    label: e.label,
    value: e.value,
    isPrimary: e.is_primary === 1
  }));

  const addresses = db.get().prepare(`
    SELECT id, label, street, city, state, postal_code, country, is_primary
    FROM contact_addresses
    WHERE contact_id = ?
    ORDER BY is_primary DESC, id ASC
  `).all(contactId).map(a => ({
    id: a.id,
    label: a.label,
    street: a.street,
    city: a.city,
    state: a.state,
    postalCode: a.postal_code,
    country: a.country,
    isPrimary: a.is_primary === 1
  }));

  return { phones, emails, addresses };
}

/**
 * Die Mehrfachfelder (phones, emails, addresses) benennen jede Absage als Fall
 * (#1909), wie die Einzelfelder (limitedStr): `case` traegt Grund und, wo es
 * eine Grenze gibt, die Zahl. Die Antwort reicht ihn als `reason` und
 * `params.limit` neben dem unveraenderten `error` weiter. Gemeint ist vor allem
 * das Kontaktformular: es schickt jede Telefonnummer und Adresse als Eintrag,
 * und eine E-Mail-Adresse ohne @ oder eine zu lange Nummer bekam bis dahin nur
 * den allgemeinen Satz. Der ERSTE Eintrag, der scheitert, wird
 * benannt; die Felder nacheinander (phones, emails, addresses), alle erst nach
 * den Einzelfeldern.
 *
 * Was nur ein API-Client falsch schicken kann (keine Liste, kein Objekt, ohne
 * Bezeichnung oder Wert, kein Text, `isPrimary` kein Boolean), ist EIN Fall je
 * Feld (`*_entry_invalid`): der Satz dazu sagt "unvollstaendig oder ungueltig",
 * und das stimmt fuer jede dieser Absagen. Zu lang, zu viele und die E-Mail
 * ohne gueltige Form haben je einen eigenen Satz, weil der Nutzer daran
 * etwas aendern kann.
 */
const MV_MAX_ENTRIES = 20;
const MV_MAX_LABEL = 50;
// Dieselbe Grenze wie das Einzelfeld `phone`: das Formular schickt die erste
// Nummer in beiden, und zwei Grenzen nannten nacheinander zwei Zahlen.
const MV_MAX_PHONE = CONTACT_PHONE_MAX_LENGTH;
const MV_MAX_EMAIL = 255;
const MV_MAX_ADDRESS_PART = 255;

/** Eine Absage eines Mehrfachfelds mit ihrem Fall (`params.limit` nur, wo der Satz eine Grenze nennt). */
function refuse(error, refusal) {
  return { valid: false, error, case: refusal };
}

/**
 * Validates phones array for multi-value contact fields.
 * @param {Array} phones - Array of { label, value, isPrimary? }
 * @returns {{ valid: boolean, error?: string, case?: { reason: string, params?: { limit: number } } }}
 */
function validatePhones(phones) {
  const invalid = (error) => refuse(error, { reason: 'contacts_phone_entry_invalid' });
  if (!Array.isArray(phones)) return invalid('Phones must be an array');
  if (phones.length > MV_MAX_ENTRIES) {
    return refuse(`Too many phone entries (max ${MV_MAX_ENTRIES})`, { reason: 'contacts_phones_too_many', params: { limit: MV_MAX_ENTRIES } });
  }
  for (const p of phones) {
    if (!p || typeof p !== 'object') return invalid('Phone entry must be an object');
    if (!p.label || !p.value) return invalid('Phone requires label and value');
    if (typeof p.label !== 'string' || p.label.trim().length === 0) return invalid('Phone label invalid or too long');
    if (p.label.length > MV_MAX_LABEL) {
      return refuse('Phone label invalid or too long', { reason: 'contacts_phone_label_too_long', params: { limit: MV_MAX_LABEL } });
    }
    if (typeof p.value !== 'string' || p.value.trim().length === 0) return invalid('Phone value invalid or too long');
    if (p.value.length > MV_MAX_PHONE) {
      return refuse('Phone value invalid or too long', { reason: 'contacts_phone_too_long', params: { limit: MV_MAX_PHONE } });
    }
    if (p.isPrimary !== undefined && typeof p.isPrimary !== 'boolean') {
      return invalid('Phone isPrimary must be boolean');
    }
  }
  return { valid: true };
}

/**
 * Validates emails array for multi-value contact fields.
 * @param {Array} emails - Array of { label, value, isPrimary? }
 * @returns {{ valid: boolean, error?: string, case?: { reason: string, params?: { limit: number } } }}
 */
function validateEmails(emails) {
  const invalid = (error) => refuse(error, { reason: 'contacts_email_entry_invalid' });
  if (!Array.isArray(emails)) return invalid('Emails must be an array');
  if (emails.length > MV_MAX_ENTRIES) {
    return refuse(`Too many email entries (max ${MV_MAX_ENTRIES})`, { reason: 'contacts_emails_too_many', params: { limit: MV_MAX_ENTRIES } });
  }
  for (const e of emails) {
    if (!e || typeof e !== 'object') return invalid('Email entry must be an object');
    if (!e.label || !e.value) return invalid('Email requires label and value');
    if (typeof e.label !== 'string' || e.label.trim().length === 0) return invalid('Email label invalid or too long');
    if (e.label.length > MV_MAX_LABEL) {
      return refuse('Email label invalid or too long', { reason: 'contacts_email_label_too_long', params: { limit: MV_MAX_LABEL } });
    }
    if (typeof e.value !== 'string' || e.value.trim().length === 0) return invalid('Email value invalid or too long');
    if (e.value.length > MV_MAX_EMAIL) {
      return refuse('Email value invalid or too long', { reason: 'contacts_email_too_long', params: { limit: MV_MAX_EMAIL } });
    }
    if (!/^.+@.+$/.test(e.value)) {
      return refuse('Email value must be a valid email address', { reason: 'contacts_email_invalid' });
    }
    if (e.isPrimary !== undefined && typeof e.isPrimary !== 'boolean') {
      return invalid('Email isPrimary must be boolean');
    }
  }
  return { valid: true };
}

/** Die Teile einer Adresse, die je hoechstens MV_MAX_ADDRESS_PART Zeichen tragen. */
const ADDRESS_PARTS = ['street', 'city', 'state', 'postalCode', 'country'];

/**
 * Validates addresses array for multi-value contact fields.
 * @param {Array} addresses - Array of { label, street?, city?, state?, postalCode?, country?, isPrimary? }
 * @returns {{ valid: boolean, error?: string, case?: { reason: string, params?: { limit: number } } }}
 */
function validateAddresses(addresses) {
  const invalid = (error) => refuse(error, { reason: 'contacts_address_entry_invalid' });
  if (!Array.isArray(addresses)) return invalid('Addresses must be an array');
  if (addresses.length > MV_MAX_ENTRIES) {
    return refuse(`Too many address entries (max ${MV_MAX_ENTRIES})`, { reason: 'contacts_addresses_too_many', params: { limit: MV_MAX_ENTRIES } });
  }
  for (const a of addresses) {
    if (!a || typeof a !== 'object') return invalid('Address entry must be an object');
    if (!a.label) return invalid('Address requires label');
    if (typeof a.label !== 'string' || a.label.trim().length === 0) return invalid('Address label invalid or too long');
    if (a.label.length > MV_MAX_LABEL) {
      return refuse('Address label invalid or too long', { reason: 'contacts_address_label_too_long', params: { limit: MV_MAX_LABEL } });
    }
    for (const part of ADDRESS_PARTS) {
      if (a[part] === undefined) continue;
      if (typeof a[part] !== 'string') return invalid(`Address ${part} invalid or too long`);
      if (a[part].length > MV_MAX_ADDRESS_PART) {
        return refuse(`Address ${part} invalid or too long`, { reason: 'contacts_address_part_too_long', params: { limit: MV_MAX_ADDRESS_PART } });
      }
    }
    if (a.isPrimary !== undefined && typeof a.isPrimary !== 'boolean') {
      return invalid('Address isPrimary must be boolean');
    }
  }
  return { valid: true };
}

// --------------------------------------------------------
// Kategorie-Verwaltung (#357)
// Statische /categories-Pfade MÜSSEN vor den dynamischen /:id-Routen stehen.
// --------------------------------------------------------

// GET /api/v1/contacts/categories → { data: ContactCategory[] }
router.get('/categories', (_req, res) => {
  try {
    res.json({ data: loadContactCategories() });
  } catch (err) {
    log.error('GET /categories error:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// POST /api/v1/contacts/categories  Body: { name } → { data: ContactCategory }
router.post('/categories', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM contact_categories WHERE COALESCE(name, key) = ? COLLATE NOCASE
    `).get(vName.value);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    const vColor = normalizeCategoryColor(req.body.color);
    if (vColor.error) return res.status(400).json({ error: vColor.error, code: 400 });

    const maxOrder = db.get().prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM contact_categories').get().m;
    const key = uniqueKey(db.get(), 'contact_categories', vName.value);
    db.get().prepare(
      "INSERT INTO contact_categories (key, name, label_key, icon, sort_order, color) VALUES (?, ?, NULL, 'tag', ?, ?)"
    ).run(key, vName.value, maxOrder + 1, vColor.skip ? null : vColor.value);

    const cat = db.get().prepare('SELECT key, name, label_key, icon, sort_order, color FROM contact_categories WHERE key = ?').get(key);
    res.status(201).json({ data: cat });
  } catch (err) {
    log.error('POST /categories error:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// PATCH /api/v1/contacts/categories/reorder  Body: { order: string[] }
router.patch('/categories/reorder', (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    const update = db.get().prepare('UPDATE contact_categories SET sort_order = ? WHERE key = ?');
    db.get().transaction(() => order.forEach((key, i) => update.run(i, key)))();
    res.json({ data: loadContactCategories() });
  } catch (err) {
    log.error('PATCH /categories/reorder error:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// PUT /api/v1/contacts/categories/:key  Body: { name } → umbenennen (Key bleibt stabil).
router.put('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM contact_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const vColor = normalizeCategoryColor(req.body.color);
    if (vColor.error) return res.status(400).json({ error: vColor.error, code: 400 });

    // NUR die Farbe aendern, ohne den Namen mitzuschicken: die sieben
    // Seed-Kategorien tragen ihren Namen als `label_key` (uebersetzt), und ein
    // Umweg ueber `name` wuerde sie beim Farbwechsel stillschweigend auf die
    // Sprache des Klienten festnageln - genau der Verlust, den Migration 143
    // beim Inventar behoben hat.
    if (req.body.name === undefined && !vColor.skip) {
      db.get().prepare('UPDATE contact_categories SET color = ? WHERE key = ?').run(vColor.value, cat.key);
      return res.json({ data: db.get().prepare('SELECT key, name, label_key, icon, sort_order, color FROM contact_categories WHERE key = ?').get(cat.key) });
    }

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM contact_categories WHERE COALESCE(name, key) = ? COLLATE NOCASE AND key != ?
    `).get(vName.value, cat.key);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    db.get().prepare('UPDATE contact_categories SET name = ?, label_key = NULL WHERE key = ?').run(vName.value, cat.key);
    if (!vColor.skip) db.get().prepare('UPDATE contact_categories SET color = ? WHERE key = ?').run(vColor.value, cat.key);
    const updated = db.get().prepare('SELECT key, name, label_key, icon, sort_order, color FROM contact_categories WHERE key = ?').get(cat.key);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /categories/:key error:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// DELETE /api/v1/contacts/categories/:key → 409 wenn in Benutzung oder letzte Kategorie.
router.delete('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM contact_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const inUse = contactCategoryInUseCount(cat.key);
    if (inUse > 0) {
      return res.status(409).json({ error: `Category is in use by ${inUse} contact${inUse === 1 ? '' : 's'}.`, code: 409, count: inUse, reason: 'category_in_use' });
    }
    const total = db.get().prepare('SELECT COUNT(*) AS n FROM contact_categories').get().n;
    if (total <= 1) return res.status(409).json({ error: 'Cannot delete the last category.', code: 409, reason: 'category_last' });

    db.get().prepare('DELETE FROM contact_categories WHERE key = ?').run(cat.key);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /categories/:key error:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * EIN MENSCH, EINE FARBE - auch hier.
 *
 * Ein Kontakt mit `family_user_id` IST ein Haushaltsmitglied, und die
 * Identitaetsfarben-Regel (DESIGN.md) sagt, dass eine Person ueberall in ihrer
 * eigenen Farbe erscheint. Die Kontaktzeile konnte das nicht: sie kannte nur
 * die Id und zeigte deshalb den Modulton - dieselbe rosa Scheibe fuer jedes
 * Mitglied, waehrend dieselben Menschen auf dem Dashboard, im Kalender und in
 * den Aufgaben ihre eigene tragen. Derselbe Befund, den v2.19 an der
 * Geburtstagskachel behoben hat, ein Modul weiter.
 *
 * DER JOIN KOSTET FAST NICHTS AN NUTZLAST: `avatar_data` entsteht nur fuer
 * Zeilen MIT Verknuepfung, und davon gibt es hoechstens so viele wie
 * Haushaltsmitglieder. Die drei Felder sind additiv, fuer `/api/v1`-Verbraucher
 * also unkritisch.
 *
 * EIN AUSDRUCK FUER ALLE LESER, und das ist der Punkt: Liste, Detail und die
 * Antwort des Schreibens holen denselben Kontakt: laege der Join nur in der
 * Liste, zeigte die Zeile die Mitgliedsfarbe und die geoeffnete Karte daneben
 * wieder den Modulton (`reference_codebase_gotchas`: die Reichweite einer
 * Korrektur ist nicht ihre Datei).
 */
const CONTACT_SELECT = `
  SELECT contacts.*,
         u.display_name  AS family_display_name,
         u.avatar_color  AS family_avatar_color,
         u.avatar_data   AS family_avatar_data
    FROM contacts
    LEFT JOIN users u ON u.id = contacts.family_user_id`;

/**
 * GET /api/v1/contacts
 * Alle Kontakte, optional nach Kategorie gefiltert und nach Name gesucht.
 * Query: ?category=<cat>&q=<search>
 * Response: { data: Contact[] }
 */
router.get('/', (req, res) => {
  try {
    let sql    = CONTACT_SELECT;
    const params = [];
    const where  = ['NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = contacts.family_user_id)'];

    if (req.query.category && validContactCategoryKeys().includes(req.query.category)) {
      where.push('contacts.category = ?');
      params.push(req.query.category);
    }

    if (req.query.q) {
      where.push('(contacts.name LIKE ? OR contacts.phone LIKE ? OR contacts.email LIKE ?)');
      const like = `%${req.query.q}%`;
      params.push(like, like, like);
    }

    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    // Sortiert nach Nachname, wo er bekannt ist; sonst nach dem Anzeigenamen (#535).
    // Spalten qualifiziert: seit dem Join auf `users` waeren `name` und
    // `category` sonst mehrdeutig.
    sql += ' ORDER BY contacts.category ASC, COALESCE(NULLIF(contacts.last_name, \'\'), contacts.name) COLLATE NOCASE ASC, contacts.name COLLATE NOCASE ASC';

    const contacts = db.get().prepare(sql).all(...params);
    res.json({ data: contacts });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * POST /api/v1/contacts
 * Neuen Kontakt anlegen.
 * Body: { name, category?, phone?, email?, address?, notes?, phones?, emails?, addresses? }
 * Response: { data: Contact }
 */
router.post('/', (req, res) => {
  try {
    // Strukturierte Namensteile haben Vorrang vor einem mitgesendeten `name` (#535).
    const nameParts = readNameParts(req.body);
    const vName    = limitedStr(nameParts.displayName ?? req.body.name, 'Name', MAX_TITLE, { reason: 'contacts_name_too_long' }, true);
    const vCat     = oneOf(req.body.category || FALLBACK_CATEGORY, validContactCategoryKeys(), 'Category');
    const vPhone   = limitedStr(req.body.phone,   'Telefon', CONTACT_PHONE_MAX_LENGTH, { reason: 'contacts_phone_too_long' });
    const vEmail   = limitedStr(req.body.email,   'E-Mail',  MAX_TITLE, { reason: 'contacts_email_too_long' });
    const vAddress = limitedStr(req.body.address, 'Adresse', MAX_TEXT,  { reason: 'contacts_address_too_long' });
    const vNotes   = limitedStr(req.body.notes,   'Notizen', MAX_TEXT,  { reason: 'contacts_notes_too_long' });
    // Geburtstag (ISO YYYY-MM-DD, optional) - u. a. aus vCard-BDAY beim Import.
    // Speist den bestehenden #518-Geburtstags-Import (GET /birthdays/import/candidates).
    // Ohne Jahr (#2095): `birthday_year_unknown` setzt das Jahr auf den
    // Platzhalter, die Anzeige laesst es weg.
    const vYearUnknown = validateYearUnknown(req.body.birthday_year_unknown, 'birthday_year_unknown');
    const vBirthday = birthdayCheck(date(birthDateInput(req.body.birthday, vYearUnknown.value === true), 'Geburtstag', false));
    const checks   = [vName, vCat, vPhone, vEmail, vAddress, vNotes, vYearUnknown, vBirthday,
                      ...namePartChecks(nameParts.parts)];
    const errors   = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400, ...fieldCase(vCat, checks, errors) });

    // Validate multi-value fields if provided
    if (req.body.phones !== undefined) {
      const phonesValidation = validatePhones(req.body.phones);
      if (!phonesValidation.valid) {
        return res.status(400).json({ error: phonesValidation.error, code: 400, ...phonesValidation.case });
      }
    }

    if (req.body.emails !== undefined) {
      const emailsValidation = validateEmails(req.body.emails);
      if (!emailsValidation.valid) {
        return res.status(400).json({ error: emailsValidation.error, code: 400, ...emailsValidation.case });
      }
    }

    if (req.body.addresses !== undefined) {
      const addressesValidation = validateAddresses(req.body.addresses);
      if (!addressesValidation.valid) {
        return res.status(400).json({ error: addressesValidation.error, code: 400, ...addressesValidation.case });
      }
    }

    // Insert contact and multi-value fields in a transaction
    const transaction = db.get().transaction(() => {
      const result = db.get().prepare(`
        INSERT INTO contacts (name, category, phone, email, address, notes, birthday, birthday_year_unknown,
                              first_name, last_name, middle_name, name_prefix, name_suffix)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(vName.value, vCat.value || FALLBACK_CATEGORY, vPhone.value, vEmail.value,
             vAddress.value, vNotes.value, vBirthday.value, vBirthday.value && vYearUnknown.value ? 1 : 0,
             nameParts.parts.firstName, nameParts.parts.lastName, nameParts.parts.middleName,
             nameParts.parts.namePrefix, nameParts.parts.nameSuffix);

      const contactId = result.lastInsertRowid;

      // Insert phones. value_e164 ist additiv (Phase 2): der rohe value bleibt die
      // Wahrheit; value_e164 wird nur gesetzt, wo parsebar (sonst NULL).
      if (req.body.phones && Array.isArray(req.body.phones)) {
        const defaultCountry = defaultCountryFromConfig(db.get());
        const insertPhone = db.get().prepare(`
          INSERT INTO contact_phones (contact_id, label, value, is_primary, value_e164)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const phone of req.body.phones) {
          insertPhone.run(contactId, phone.label, phone.value, phone.isPrimary ? 1 : 0,
                          toE164(phone.value, defaultCountry));
        }
      }

      // Insert emails
      if (req.body.emails && Array.isArray(req.body.emails)) {
        const insertEmail = db.get().prepare(`
          INSERT INTO contact_emails (contact_id, label, value, is_primary)
          VALUES (?, ?, ?, ?)
        `);
        for (const email of req.body.emails) {
          insertEmail.run(contactId, email.label, email.value, email.isPrimary ? 1 : 0);
        }
      }

      // Insert addresses
      if (req.body.addresses && Array.isArray(req.body.addresses)) {
        const insertAddress = db.get().prepare(`
          INSERT INTO contact_addresses (contact_id, label, street, city, state, postal_code, country, is_primary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const address of req.body.addresses) {
          insertAddress.run(
            contactId,
            address.label,
            address.street || null,
            address.city || null,
            address.state || null,
            address.postalCode || null,
            address.country || null,
            address.isPrimary ? 1 : 0
          );
        }
      }

      return contactId;
    });

    const contactId = transaction();

    // Query the created contact with multi-value fields
    const contact = db.get().prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
    const multiValueFields = loadMultiValueFields(contactId);

    res.status(201).json({
      data: {
        ...contact,
        ...multiValueFields
      }
    });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * PUT /api/v1/contacts/:id
 * Kontakt bearbeiten.
 * Body: alle Felder optional, phones/emails/addresses mit Replacement-Semantik
 * Response: { data: Contact }
 */
router.put('/:id', (req, res) => {
  try {
    const id      = parseInt(req.params.id, 10);
    const contact = db.get().prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    if (!contact) return res.status(404).json({ error: 'Contact not found.', code: 404, reason: 'contacts_contact_not_found' });

    // Namensteile (#535): sobald welche mitkommen, ersetzen sie die gespeicherten
    // und der Anzeigename wird neu daraus abgeleitet.
    const nameParts = readNameParts(req.body);
    const derivedName = nameParts.provided ? nameParts.displayName : null;

    const checks = [];
    if (nameParts.provided)              checks.push(...namePartChecks(nameParts.parts));
    if (req.body.name     !== undefined) checks.push(limitedStr(req.body.name, 'Name', MAX_TITLE, { reason: 'contacts_name_too_long' }));
    const vCat = req.body.category !== undefined ? oneOf(req.body.category, validContactCategoryKeys(), 'Category') : null;
    if (vCat) checks.push(vCat);
    if (req.body.phone    !== undefined) checks.push(limitedStr(req.body.phone,   'Telefon', CONTACT_PHONE_MAX_LENGTH, { reason: 'contacts_phone_too_long' }));
    if (req.body.email    !== undefined) checks.push(limitedStr(req.body.email,   'E-Mail',  MAX_TITLE, { reason: 'contacts_email_too_long' }));
    if (req.body.address  !== undefined) checks.push(limitedStr(req.body.address, 'Adresse', MAX_TEXT,  { reason: 'contacts_address_too_long' }));
    if (req.body.notes    !== undefined) checks.push(limitedStr(req.body.notes,   'Notizen', MAX_TEXT,  { reason: 'contacts_notes_too_long' }));
    // Fehlt `birthday_year_unknown`, bleibt die gespeicherte Marke (#2095); wer
    // sie abnimmt, schickt das Jahr mit, sonst wuerde der Platzhalter 2000 zum
    // echten Geburtsjahr.
    const vYearUnknown = validateYearUnknown(req.body.birthday_year_unknown, 'birthday_year_unknown');
    checks.push(vYearUnknown);
    const yearUnknown = vYearUnknown.value ?? contact.birthday_year_unknown === 1;
    let birthday = contact.birthday;
    if (req.body.birthday !== undefined) {
      const vBirthday = birthdayCheck(date(birthDateInput(req.body.birthday, yearUnknown), 'Geburtstag', false));
      checks.push(vBirthday);
      birthday = vBirthday.value;
    } else if (yearUnknown && contact.birthday_year_unknown !== 1 && contact.birthday) {
      birthday = placeholderBirthDate(contact.birthday);
    } else if (vYearUnknown.value === false && contact.birthday_year_unknown === 1 && contact.birthday) {
      checks.push({ value: null, error: 'Birthday with its year is required when birthday_year_unknown is turned off.' });
    }
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400, ...fieldCase(vCat, checks, errors) });

    // Validate multi-value fields if provided
    if (req.body.phones !== undefined) {
      const phonesValidation = validatePhones(req.body.phones);
      if (!phonesValidation.valid) {
        return res.status(400).json({ error: phonesValidation.error, code: 400, ...phonesValidation.case });
      }
    }

    if (req.body.emails !== undefined) {
      const emailsValidation = validateEmails(req.body.emails);
      if (!emailsValidation.valid) {
        return res.status(400).json({ error: emailsValidation.error, code: 400, ...emailsValidation.case });
      }
    }

    if (req.body.addresses !== undefined) {
      const addressesValidation = validateAddresses(req.body.addresses);
      if (!addressesValidation.valid) {
        return res.status(400).json({ error: addressesValidation.error, code: 400, ...addressesValidation.case });
      }
    }

    // Die E-Mail-Adressen eines verknuepften Kontakts fuehren zu seinem Konto
    // (Passwort-Reset, SSO-Verknuepfung): sie aendern nur die Person selbst
    // oder ein Admin. Die Regel steht in services/contact-identity.js.
    const actor = contactActorFromRequest(req);
    if (!mayChangeContactEmails(contact, actor)) {
      const storedEmails = db.get()
        .prepare('SELECT value FROM contact_emails WHERE contact_id = ?')
        .all(id).map((r) => r.value);
      if (bodyChangesContactEmails(contact, storedEmails, req.body)) {
        return res.status(403).json({
          error: 'Only this member or an admin, signed in or with a full-access token, can change the email addresses of a household member.',
          code: 403,
          reason: 'contact_email_protected',
        });
      }
      // Gleiche Adressen (etwa nur anders geschrieben): die gespeicherten
      // bleiben unangetastet, wie sie sind.
      delete req.body.email;
      delete req.body.emails;
    } else if (contact.family_user_id && !actor.isAdmin
      && (req.body.email !== undefined || Array.isArray(req.body.emails))) {
      // Die Person selbst an ihrem eigenen Kontakt: eine Adresse, die schon ein
      // anderes Konto traegt, fuehrt sie nicht neu ein (GHSA-6pmj-w42g-g6qv,
      // dieselbe Regel wie PATCH /auth/me/profile). Synchron bis zum
      // Schreiben, kein await dazwischen.
      const storedEmails = db.get()
        .prepare('SELECT value FROM contact_emails WHERE contact_id = ?')
        .all(id).map((r) => r.value);
      const taken = emailsTakenByOtherAccounts(db.get(), {
        userId: contact.family_user_id,
        before: [contact.email, ...storedEmails],
        after: [
          req.body.email !== undefined ? req.body.email : contact.email,
          ...(Array.isArray(req.body.emails) ? req.body.emails.map((e) => e?.value) : storedEmails),
        ],
      });
      if (taken.length) {
        return res.status(409).json({ error: EMAIL_IN_USE_MESSAGE, code: 409, reason: 'email_in_use' });
      }
    }

    // Update contact and multi-value fields in a transaction
    const transaction = db.get().transaction(() => {
      // Update scalar fields
      db.get().prepare(`
        UPDATE contacts
        SET name        = COALESCE(?, name),
            category    = COALESCE(?, category),
            phone       = ?,
            email       = ?,
            address     = ?,
            notes       = ?,
            birthday    = ?,
            birthday_year_unknown = ?,
            first_name  = ?,
            last_name   = ?,
            middle_name = ?,
            name_prefix = ?,
            name_suffix = ?
        WHERE id = ?
      `).run(
        derivedName ?? req.body.name?.trim() ?? null,
        req.body.category ?? null,
        req.body.phone   !== undefined ? (req.body.phone?.trim()   || null) : contact.phone,
        req.body.email   !== undefined ? (req.body.email?.trim()   || null) : contact.email,
        req.body.address !== undefined ? (req.body.address?.trim() || null) : contact.address,
        req.body.notes   !== undefined ? (req.body.notes?.trim()   || null) : contact.notes,
        birthday || null,
        birthday && yearUnknown ? 1 : 0,
        nameParts.provided ? nameParts.parts.firstName  : contact.first_name,
        nameParts.provided ? nameParts.parts.lastName   : contact.last_name,
        nameParts.provided ? nameParts.parts.middleName : contact.middle_name,
        nameParts.provided ? nameParts.parts.namePrefix : contact.name_prefix,
        nameParts.provided ? nameParts.parts.nameSuffix : contact.name_suffix,
        id
      );

      // Replace phones (delete all, insert new). value_e164 additiv mitberechnen
      // (Phase 2), value bleibt der rohe Eingabewert.
      if (req.body.phones !== undefined && Array.isArray(req.body.phones)) {
        db.get().prepare('DELETE FROM contact_phones WHERE contact_id = ?').run(id);

        const defaultCountry = defaultCountryFromConfig(db.get());
        const insertPhone = db.get().prepare(`
          INSERT INTO contact_phones (contact_id, label, value, is_primary, value_e164)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const phone of req.body.phones) {
          insertPhone.run(id, phone.label, phone.value, phone.isPrimary ? 1 : 0,
                          toE164(phone.value, defaultCountry));
        }
      }

      // Replace emails (delete all, insert new)
      if (req.body.emails !== undefined && Array.isArray(req.body.emails)) {
        db.get().prepare('DELETE FROM contact_emails WHERE contact_id = ?').run(id);

        const insertEmail = db.get().prepare(`
          INSERT INTO contact_emails (contact_id, label, value, is_primary)
          VALUES (?, ?, ?, ?)
        `);
        for (const email of req.body.emails) {
          insertEmail.run(id, email.label, email.value, email.isPrimary ? 1 : 0);
        }
      }

      // Replace addresses (delete all, insert new)
      if (req.body.addresses !== undefined && Array.isArray(req.body.addresses)) {
        db.get().prepare('DELETE FROM contact_addresses WHERE contact_id = ?').run(id);

        const insertAddress = db.get().prepare(`
          INSERT INTO contact_addresses (contact_id, label, street, city, state, postal_code, country, is_primary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const address of req.body.addresses) {
          insertAddress.run(
            id,
            address.label,
            address.street || null,
            address.city || null,
            address.state || null,
            address.postalCode || null,
            address.country || null,
            address.isPrimary ? 1 : 0
          );
        }
      }
    });

    transaction();

    // Query the updated contact with multi-value fields
    const updated = db.get().prepare(`${CONTACT_SELECT} WHERE contacts.id = ?`).get(id);
    const multiValueFields = loadMultiValueFields(id);

    res.json({
      data: {
        ...updated,
        ...multiValueFields
      }
    });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * DELETE /api/v1/contacts/:id
 * Kontakt löschen.
 * Response: 204 No Content
 */
router.delete('/:id', (req, res) => {
  try {
    const id     = parseInt(req.params.id, 10);
    const contact = db.get().prepare('SELECT family_user_id FROM contacts WHERE id = ?').get(id);
    if (!contact) return res.status(404).json({ error: 'Contact not found.', code: 404, reason: 'contacts_contact_not_found' });
    
    if (contact.family_user_id) {
      return res.status(403).json({ error: 'Familienmitglieder können nicht aus der Kontaktliste gelöscht werden.', code: 403, reason: 'family_member_contact' });
    }

    const result = db.get().prepare('DELETE FROM contacts WHERE id = ?').run(id);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Contact not found.', code: 404, reason: 'contacts_contact_not_found' });
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * GET /api/v1/contacts/meta
 * Kategorien-Liste für Dropdowns, dazu die waehlbaren Kategorie-Toene.
 *
 * `categoryColors` steht hier und nicht im Klienten, damit die Auswahl und die
 * Annahme dieselbe Liste sind: eine zweite Aufzaehlung im Frontend waere beim
 * naechsten Ton stumm veraltet und der Server wiese sie mit 400 ab.
 *
 * Response: { data: { categories, categoryColors } }
 */
router.get('/meta', (_req, res) => {
  try {
    res.json({ data: { categories: loadContactCategories(), categoryColors: CONTACT_CATEGORY_COLORS } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * GET /api/v1/contacts/:id
 * Einzelnen Kontakt abrufen mit Multi-Value Fields (phones, emails, addresses).
 * Response: { data: Contact }
 */
router.get('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const contact = db.get().prepare(`${CONTACT_SELECT} WHERE contacts.id = ?`).get(id);
    if (!contact) return res.status(404).json({ error: 'Contact not found.', code: 404, reason: 'contacts_contact_not_found' });

    // Load multi-value fields
    const multiValueFields = loadMultiValueFields(id);

    res.json({
      data: {
        ...contact,
        ...multiValueFields
      }
    });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * GET /api/v1/contacts/:id/vcard
 * Kontakt als vCard 3.0 (.vcf) exportieren.
 * Response: text/vcard Dateidownload
 */
router.get('/:id/vcard', (req, res) => {
  try {
    const id      = parseInt(req.params.id, 10);
    const contact = db.get().prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    if (!contact) return res.status(404).json({ error: 'Contact not found.', code: 404, reason: 'contacts_contact_not_found' });

    const esc = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${esc(contact.name)}`,
      // Strukturierte Komponenten exportieren, wo bekannt (#535); sonst trägt
      // das Familiennamen-Feld weiterhin den Anzeigenamen als Ganzes.
      (contact.first_name || contact.last_name)
        ? `N:${esc(contact.last_name)};${esc(contact.first_name)};${esc(contact.middle_name)};${esc(contact.name_prefix)};${esc(contact.name_suffix)}`
        : `N:${esc(contact.name)};;;;`,
    ];
    if (contact.phone)   lines.push(`TEL;TYPE=VOICE:${esc(contact.phone)}`);
    if (contact.email)   lines.push(`EMAIL:${esc(contact.email)}`);
    if (contact.address) lines.push(`ADR;TYPE=HOME:;;${esc(contact.address)};;;;`);
    if (contact.notes)   lines.push(`NOTE:${esc(contact.notes)}`);
    // Ohne Jahr in Apples Form (#2095): vCard 3.0 kennt kein `--MMDD`, und
    // sabre/vobject (Nextcloud, Baikal) schreibt jahrlose Geburtstage in 3.0
    // genau so. Apple liest die Marke und zeigt kein Jahr; der eigene Import
    // (Sync und .vcf) erkennt sie ebenfalls.
    if (contact.birthday && contact.birthday_year_unknown === 1) {
      lines.push(`BDAY;X-APPLE-OMIT-YEAR=1604:1604${esc(contact.birthday).slice(4, 10)}`);
    } else if (contact.birthday) {
      lines.push(`BDAY:${esc(contact.birthday)}`);
    }
    if (contact.category) lines.push(`CATEGORIES:${esc(contact.category)}`);
    lines.push('END:VCARD');

    const vcf      = lines.join('\r\n');
    const filename = encodeURIComponent(contact.name.replace(/[^a-zA-Z0-9-_ ]/g, '_')) + '.vcf';

    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(vcf);
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
export { validatePhones, validateEmails, validateAddresses };
