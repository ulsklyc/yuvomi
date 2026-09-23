import express from 'express';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { collectErrors, date as validateDate, oneOf, str, MAX_SHORT, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';
import { dataUrlContentMatches } from '../utils/file-signature.js';
import { mayReadModule } from '../permissions.js';
import {
  deleteBirthdayArtifacts,
  hydrateBirthday,
  syncBirthdayArtifacts,
  syncAllBirthdayReminders,
  listBirthdayImportCandidates,
  importBirthdaysFromContacts,
} from '../services/birthdays.js';

const log = createLogger('Birthdays');
const router = express.Router();
const MAX_PHOTO_LENGTH = 6_990_507; // ~5 MB raw image in base64
const PHOTO_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function validatePhotoData(val) {
  if (val === undefined) return { value: undefined, error: null };
  if (val === null || val === '') return { value: null, error: null };
  const s = String(val).trim();
  if (s.length > MAX_PHOTO_LENGTH) return { value: null, error: 'Profile picture is too large.' };
  if (!PHOTO_RE.test(s)) return { value: null, error: 'Profile picture must be a valid image data URL.' };
  // Der Regex prueft die Deklaration, diese Zeile den Inhalt (#937).
  if (!dataUrlContentMatches(s)) return { value: null, error: 'Profile picture content does not match its image type.' };
  return { value: s, error: null };
}

function validateNameDay(val) {
  if (val === undefined) return { value: undefined, error: null };
  if (val === null || val === '') return { value: null, error: null };
  const value = String(val).trim();
  const match = /^(\d{2})-(\d{2})$/.exec(value);
  if (!match) return { value: null, error: 'Name day must use MM-DD.' };
  const month = Number(match[1]);
  const day = Number(match[2]);
  const candidate = new Date(Date.UTC(2000, month - 1, day));
  if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
    return { value: null, error: 'Name day must be a valid month and day.' };
  }
  return { value, error: null };
}

/**
 * DIE ERINNERUNG EINES GEBURTSTAGS: drei Felder, die der Server bis hierher
 * ungeprueft schrieb - negative Zahlen, Kommazahlen, Freitext.
 *
 * `reminder_offset` ist Text und traegt eine von vier Formen, so wie
 * `getOffsetMinutes()` und `syncBirthdayCalendarEvent()` in
 * server/services/birthdays.js sie lesen: `''` = keine Erinnerung und kein
 * Termin, `null` = am Tag selbst, `'custom'` = Anzahl und Einheit, sonst ganze
 * Minuten vor 12:00. Neue Minutenwerte muessen ganz und ab 0 sein: ein
 * negativer Wert erinnert NACH dem Mittag, und das bietet kein Editor an.
 * Obergrenze ist die groesste Angabe, die die eigene Angabe ausdruecken kann
 * (999 Wochen) - eine Vorgabe soll nicht weiter reichen als der Weg daneben.
 *
 * `reminder_custom_amount` ist 1-999 wie das Zahlenfeld im Editor
 * (`min="1" max="999"`), `reminder_custom_unit` eine der vier Einheiten, die
 * `getOffsetMinutes()` kennt. Leer oder null heisst bei beiden „nicht gesetzt";
 * der Server rechnet dann mit 1 und Tagen, wie bisher.
 *
 * BESTANDSWERTE BLEIBEN SCHREIBBAR. Bis v1.6.5 bot der Editor '15', '60' und
 * '20160' an, und die API nahm jeden Wert. Ein Wert, der GENAU dem
 * gespeicherten entspricht, geht deshalb unveraendert durch: `PUT` mit einem
 * zurueckgeschickten Datensatz (GET, ein Feld aendern, PUT) scheitert nicht an
 * einem Feld, das niemand angefasst hat. Der Editor schickt die Erinnerung nur,
 * wenn sie sich geaendert hat (#1363) - dann aber alle drei Felder, auch die
 * verborgene Anzahl, die seit dem Oeffnen den gespeicherten Wert zeigt.
 */
const REMINDER_UNITS = ['minutes', 'hours', 'days', 'weeks'];
const MAX_REMINDER_AMOUNT = 999;
const MAX_REMINDER_MINUTES = MAX_REMINDER_AMOUNT * 10080;

function isStoredValue(val, stored) {
  return stored !== undefined && stored !== null && String(val) === String(stored);
}

/** Eine ganze Zahl ohne Vorzeichen, als Zahl oder als Ziffernfolge. */
function wholeNumber(val) {
  if (typeof val === 'number') return Number.isSafeInteger(val) && val >= 0 ? val : null;
  if (typeof val === 'string' && /^\d{1,9}$/.test(val)) return Number(val);
  return null;
}

function validateReminderOffset(val, stored) {
  if (val === undefined) return { value: undefined, error: null };
  if (val === null || val === '' || val === 'custom') return { value: val, error: null };
  if (isStoredValue(val, stored)) return { value: stored, error: null };
  const minutes = wholeNumber(val);
  if (minutes === null || minutes > MAX_REMINDER_MINUTES) {
    return {
      value: null,
      error: `Reminder must be empty, "custom" or whole minutes from 0 to ${MAX_REMINDER_MINUTES}.`,
    };
  }
  return { value: String(minutes), error: null };
}

function validateReminderAmount(val, stored) {
  if (val === undefined) return { value: undefined, error: null };
  if (val === null || val === '') return { value: null, error: null };
  if (isStoredValue(val, stored)) return { value: stored, error: null };
  const amount = wholeNumber(val);
  if (amount === null || amount < 1 || amount > MAX_REMINDER_AMOUNT) {
    return { value: null, error: `Custom reminder amount must be a whole number from 1 to ${MAX_REMINDER_AMOUNT}.` };
  }
  return { value: amount, error: null };
}

function validateReminderUnit(val, stored) {
  if (val === undefined) return { value: undefined, error: null };
  if (val === null || val === '') return { value: null, error: null };
  if (isStoredValue(val, stored)) return { value: stored, error: null };
  return oneOf(val, REMINDER_UNITS, 'Custom reminder unit');
}

function validateReminder(body, existing = {}) {
  return {
    offset: validateReminderOffset(body.reminder_offset, existing.reminder_offset),
    amount: validateReminderAmount(body.reminder_custom_amount, existing.reminder_custom_amount),
    unit: validateReminderUnit(body.reminder_custom_unit, existing.reminder_custom_unit),
  };
}

/**
 * EIN GEBURTSTAG BRINGT DIE IDENTITAET SEINES MITGLIEDS MIT.
 *
 * `SELECT *` liefert `family_user_id`, aber nicht die Farbe dahinter - und
 * damit stand jedes Haushaltsmitglied in der Geburtstagsliste auf derselben
 * neutralen Scheibe, waehrend dieselbe Person auf der Uebersicht, im Kalender,
 * in den Aufgaben und (seit v2.22.0) in den Kontakten ihre eigene Farbe traegt.
 * Die Uebersichtskachel hatte den Join laengst (dashboard.js), die Modulseite
 * nie - dieselbe Reichweiten-Luecke wie bei der Vollton-Kante im Kalender.
 *
 * EIN Select fuer alle drei Lesewege (Liste, Naechste, Einzelabruf), damit die
 * Luecke nicht an einem davon zurueckkommt.
 */
const BIRTHDAY_SELECT = `
  SELECT birthdays.*,
         u.display_name AS family_display_name,
         u.avatar_color AS family_avatar_color,
         u.avatar_data  AS family_avatar_data
    FROM birthdays
    LEFT JOIN users u ON u.id = birthdays.family_user_id`;

function loadBirthday(id) {
  return db.get().prepare(`${BIRTHDAY_SELECT} WHERE birthdays.id = ?`).get(id);
}


function sortHydrated(rows) {
  return rows
    .map((row) => hydrateBirthday(db.get(), row))
    .sort((a, b) => a.days_until - b.days_until || a.name.localeCompare(b.name));
}

router.get('/', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;
    syncAllBirthdayReminders(db.get(), userId);

    // Spalten qualifiziert: seit dem Join auf `users` waere `name` mehrdeutig.
    let sql = `${BIRTHDAY_SELECT} WHERE 1=1`;
    const params = [];

    if (req.query.q) {
      sql += ' AND birthdays.name LIKE ?';
      params.push(`%${String(req.query.q).trim()}%`);
    }

    sql += ' ORDER BY birthdays.name COLLATE NOCASE ASC';

    const rows = db.get().prepare(sql).all(...params);
    res.json({ data: sortHydrated(rows) });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.get('/upcoming', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;
    syncAllBirthdayReminders(db.get(), userId);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 50);
    const rows = db.get().prepare(`${BIRTHDAY_SELECT} ORDER BY birthdays.name COLLATE NOCASE ASC`).all();
    res.json({ data: sortHydrated(rows).slice(0, limit) });
  } catch (err) {
    log.error('GET /upcoming error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.post('/', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vBirthDate = validateDate(req.body.birth_date, 'Birth date', true);
    const vNotes = str(req.body.notes, 'Notes', { max: MAX_TEXT, required: false });
    const vPhoto = validatePhotoData(req.body.photo_data);
    const vNameDay = validateNameDay(req.body.name_day);
    const vReminder = validateReminder(req.body);
    const errors = collectErrors([vName, vBirthDate, vNotes, vPhoto, vNameDay, ...Object.values(vReminder)]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const result = db.get().prepare(`
      INSERT INTO birthdays (name, birth_date, name_day, notes, photo_data, created_by, reminder_offset, reminder_custom_amount, reminder_custom_unit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vName.value,
      vBirthDate.value,
      vNameDay.value ?? null,
      vNotes.value,
      vPhoto.value ?? null,
      req.authUserId || req.session.userId,
      vReminder.offset.value ?? null,
      vReminder.amount.value ?? null,
      vReminder.unit.value ?? null
    );

    const birthday = loadBirthday(result.lastInsertRowid);
    const synced = db.transaction(() => syncBirthdayArtifacts(db.get(), birthday));
    res.status(201).json({ data: hydrateBirthday(db.get(), loadBirthday(synced.id)) });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});


/**
 * Die beiden Import-Routen lesen aus KONTAKTEN, nicht aus Geburtstagen.
 *
 * DER PFAD SAGT `birthdays`, DER INHALT KOMMT AUS `contacts` - und der
 * Scope-Guard in server/index.js urteilt nur nach dem ersten Pfadsegment:
 * `moduleForPath('/birthdays')` ergibt `calendar`. Jedes Credential mit
 * `calendar:read` kam damit an die Kandidatenliste, und die zaehlt JEDEN
 * Kontakt des Haushalts mit Namen und Geburtsdatum auf, ohne
 * Sichtbarkeitsfilter. Gemeldet fuer das Wandtablett aus #1208 (Scopes:
 * dashboard, calendar, tasks, rewards, wetter - `contacts` ist NICHT dabei,
 * seine aufgeloesten Rechte melden `contacts: none`), aber die Luecke ist
 * aelter und trifft jedes gescopte API-Token genauso.
 *
 * `mayReadModule()` prueft beide Achsen in einem Aufruf - Token-Scopes UND
 * die Modulrechte der Rolle. Dieselbe Klasse Befund wie die Abo-URLs in
 * #1241 Runde 1 und wie #823: eine Mischstelle braucht ihre eigene Pruefung,
 * weil die Middleware am Pfad haengt.
 */
function contactsHidden(req) {
  return !mayReadModule(req, 'contacts');
}

router.get('/import/candidates', (req, res) => {
  try {
    if (contactsHidden(req)) {
      return res.status(403).json({ error: 'Contact access is required to import birthdays.', code: 403 });
    }
    const data = listBirthdayImportCandidates(db.get());
    res.json({ data });
  } catch (err) {
    log.error('GET /import/candidates error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.post('/import', (req, res) => {
  try {
    // Schreibt Geburtstage, LIEST aber Kontakte: ohne diesen Riegel waere der
    // Umweg offen, sich die abgewiesene Liste ueber die angelegten
    // Geburtstagseintraege doch noch zusammenzusetzen.
    if (contactsHidden(req)) {
      return res.status(403).json({ error: 'Contact access is required to import birthdays.', code: 403 });
    }
    const userId = req.authUserId || req.session.userId;
    const ids = Array.isArray(req.body.contact_ids) ? req.body.contact_ids : null;
    if (!ids || ids.length === 0) {
      return res.status(400).json({ error: 'contact_ids must be a non-empty array.', code: 400 });
    }
    if (ids.length > 500) {
      return res.status(400).json({ error: 'Too many contacts selected.', code: 400 });
    }

    const result = db.transaction(() => importBirthdaysFromContacts(db.get(), ids, userId));
    res.status(201).json({ data: result });
  } catch (err) {
    log.error('POST /import error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.put('/:id', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;
    const id = parseInt(req.params.id, 10);
    const existing = loadBirthday(id);
    if (!existing) return res.status(404).json({ error: 'Birthday not found.', code: 404 });

    const checks = [];
    if (req.body.name !== undefined) checks.push(str(req.body.name, 'Name', { max: MAX_TITLE, required: false }));
    if (req.body.birth_date !== undefined) checks.push(validateDate(req.body.birth_date, 'Birth date'));
    if (req.body.notes !== undefined) checks.push(str(req.body.notes, 'Notes', { max: MAX_TEXT, required: false }));
    if (req.body.photo_data !== undefined) checks.push(validatePhotoData(req.body.photo_data));
    if (req.body.name_day !== undefined) checks.push(validateNameDay(req.body.name_day));
    const vReminder = validateReminder(req.body, existing);
    checks.push(...Object.values(vReminder));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const vPhoto = req.body.photo_data !== undefined ? validatePhotoData(req.body.photo_data) : { value: undefined };
    const vNameDay = req.body.name_day !== undefined ? validateNameDay(req.body.name_day) : { value: undefined };

    db.get().prepare(`
      UPDATE birthdays
      SET name = COALESCE(?, name),
          birth_date = COALESCE(?, birth_date),
          name_day = ?,
          notes = ?,
          photo_data = ?,
          reminder_offset = ?,
          reminder_custom_amount = ?,
          reminder_custom_unit = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(
      req.body.name?.trim() ?? null,
      req.body.birth_date ?? null,
      req.body.name_day !== undefined ? vNameDay.value : existing.name_day,
      req.body.notes !== undefined ? (req.body.notes?.trim() || null) : existing.notes,
      req.body.photo_data !== undefined ? (vPhoto.value ?? null) : existing.photo_data,
      vReminder.offset.value !== undefined ? vReminder.offset.value : existing.reminder_offset,
      vReminder.amount.value !== undefined ? vReminder.amount.value : existing.reminder_custom_amount,
      vReminder.unit.value !== undefined ? vReminder.unit.value : existing.reminder_custom_unit,
      id,
    );

    const updated = loadBirthday(id);
    db.transaction(() => syncBirthdayArtifacts(db.get(), updated));
    res.json({ data: hydrateBirthday(db.get(), loadBirthday(id)) });
  } catch (err) {
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;
    const id = parseInt(req.params.id, 10);
    const existing = loadBirthday(id);
    if (!existing) return res.status(404).json({ error: 'Birthday not found.', code: 404 });

    db.transaction(() => {
      deleteBirthdayArtifacts(db.get(), existing);
      db.get().prepare('DELETE FROM birthdays WHERE id = ?').run(id);
    });

    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.get('/meta/options', (_req, res) => {
  res.json({ data: { photoMaxBytes: MAX_PHOTO_LENGTH, acceptedImageTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] } });
});

export default router;
