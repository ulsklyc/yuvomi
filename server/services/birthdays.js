import { formatDateKey, resolveHouseholdFormats, translate } from '../utils/i18n.js';
import { householdTimeZone, localToUTC, todayKey } from '../utils/timezone.js';
import { OUTBOUND_SOURCES, markEventOutbound, queueEventDeletion } from './calendar-outbound.js';

const BIRTHDAY_COLOR = '#E11D48';
const BIRTHDAY_RRULE = 'FREQ=YEARLY;INTERVAL=1';

// Felder, die der Geburtstag selbst hervorbringt: Titel und Beschreibung aus dem
// Namen, Startdatum aus dem Geburtsdatum. Nur ihre Änderung darf einen Push zum
// Provider auslösen.
//
// Bewusst NICHT dabei: Farbe, Ende, Ganztags-Flag und Ort sind Beiwerk, das der
// Provider auf dem Rückweg normalisiert (der ICS-Export schreibt für ganztägige
// Termine immer ein DTEND, eine Farbe überträgt er gar nicht) - sie mitzuzählen
// erzeugte eine Endlosschleife aus Rückschreiben und Pushen, ausgelöst schon von
// einem GET /birthdays. Die Serienregel fehlt aus einem anderen Grund: sie ist
// bei einem Geburtstag konstant jährlich, und dasselbe Ergebnis existiert in
// zwei Schreibweisen - lokal ohne, aus ICS mit `RRULE:`-Präfix (beide gültig,
// server/services/recurrence.js:18 nimmt sie entgegen). Als Vergleichswert wäre
// sie also nur eine weitere Quelle für Scheinänderungen.
const AUTHORED_FIELDS = ['title', 'description', 'start_datetime'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function leapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function normalizedMonthDay(birthDate, year) {
  const [, monthStr, dayStr] = String(birthDate).split('-');
  const month = parseInt(monthStr, 10);
  let day = parseInt(dayStr, 10);
  if (month === 2 && day === 29 && !leapYear(year)) day = 28;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function normalizedNameDay(nameDay, year) {
  const [monthStr, dayStr] = String(nameDay).split('-');
  const month = parseInt(monthStr, 10);
  let day = parseInt(dayStr, 10);
  if (month === 2 && day === 29 && !leapYear(year)) day = 28;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Ein Geburtstag ist ein Kalendertag, kein Zeitpunkt - deshalb rechnen diese
 * Helfer auf Datums-Keys statt auf `Date`. Vorher mischte `nextBirthdayDate`
 * zwei Uhren in DREI Zeilen: das Jahr kam aus `getFullYear()` (Zone des
 * Containers), der Vergleichstag aus `toISOString()` (UTC). Am 31.12. um 22:00
 * in Toronto lieferte das Jahr 2026 und den Tag 2027-01-01 - ein Geburtstag am
 * 31.12. galt damit als vorbei und rutschte um ein volles Jahr nach vorn.
 * `todayKey` ist jetzt die einzige Uhr, und sie ist die des Haushalts (#829).
 */
function nextBirthdayDate(birthDate, today = todayKey(null)) {
  const year = parseInt(String(today).slice(0, 4), 10);
  const thisYear = normalizedMonthDay(birthDate, year);
  return thisYear >= today ? thisYear : normalizedMonthDay(birthDate, year + 1);
}

function nextBirthdayAge(birthDate, today = todayKey(null)) {
  const next = nextBirthdayDate(birthDate, today);
  return parseInt(next.slice(0, 4), 10) - parseInt(String(birthDate).slice(0, 4), 10);
}

function daysUntilBirthday(birthDate, today = todayKey(null)) {
  const next = nextBirthdayDate(birthDate, today);
  const keyUtc = (key) => Date.UTC(
    parseInt(key.slice(0, 4), 10),
    parseInt(key.slice(5, 7), 10) - 1,
    parseInt(key.slice(8, 10), 10),
  );
  return Math.round((keyUtc(next) - keyUtc(String(today).slice(0, 10))) / 86400000);
}

function nextNameDayDate(nameDay, today = todayKey(null)) {
  if (!nameDay) return null;
  const year = parseInt(String(today).slice(0, 4), 10);
  const thisYear = normalizedNameDay(nameDay, year);
  return thisYear >= today ? thisYear : normalizedNameDay(nameDay, year + 1);
}

function daysUntilNameDay(nameDay, today = todayKey(null)) {
  const next = nextNameDayDate(nameDay, today);
  if (!next) return null;
  const keyUtc = (key) => Date.UTC(
    parseInt(key.slice(0, 4), 10),
    parseInt(key.slice(5, 7), 10) - 1,
    parseInt(key.slice(8, 10), 10),
  );
  return Math.round((keyUtc(next) - keyUtc(String(today).slice(0, 10))) / 86400000);
}

function getOffsetMinutes(birthday) {
  if (birthday.reminder_offset === 'custom') {
    const amount = parseInt(birthday.reminder_custom_amount, 10) || 1;
    const unit = birthday.reminder_custom_unit || 'days';
    if (unit === 'weeks') return amount * 10080;
    if (unit === 'days') return amount * 1440;
    if (unit === 'hours') return amount * 60;
    return amount;
  }
  return parseInt(birthday.reminder_offset, 10) || 0;
}

// Erinnert wird mittags - und zwar mittags dort, wo der Haushalt lebt. Vorher
// stand hier 12:00 UTC, was in Auckland der Abend und in Los Angeles der frühe
// Morgen ist; "mittags" ist eine Wanduhrzeit und trägt keine eigene Zone (#829).
function birthdayReminderAt(birthDate, offsetMin = 0, today = todayKey(null), tz = householdTimeZone(null)) {
  const next = nextBirthdayDate(birthDate, today);
  const baseTime = new Date(localToUTC(`${next}T12:00:00`, tz)).getTime();
  return new Date(baseTime - (offsetMin || 0) * 60000).toISOString();
}

// Titel/Beschreibung werden in der Datensprache des Haushalts gespeichert
// (resolveHouseholdLocale, siehe server/utils/i18n.js). Grund: die Zeile in
// calendar_events ist das, was REST-API, ICS-Feed, CalDAV-/Google-Outbound und
// der FTS-Suchindex zu sehen bekommen - keiner dieser Kanäle durchläuft die
// clientseitige Übersetzung (#631, #632). Vorher stand hier ein fest englischer
// Titel, den nur die Web-UI über birthday_name übersetzt hat (#524).
//
// Die clientseitige Übersetzung in public/utils/birthday-event.js bleibt: sie ist
// jetzt der Override für Nutzer, deren Anzeigesprache von der Datensprache des
// Haushalts abweicht.
function eventTitle(name, locale) {
  return translate(locale, 'birthdays.calendarEventTitle', { name });
}

function eventDescription(name, birthDate, locale, dateFormat) {
  return birthDate
    ? translate(locale, 'birthdays.calendarEventDescription', {
        name,
        date: formatDateKey(birthDate, dateFormat),
      })
    : translate(locale, 'birthdays.calendarEventDescriptionNoDate', { name });
}

function nameDayEventTitle(name, locale) {
  return translate(locale, 'birthdays.nameDayCalendarEventTitle', { name });
}

function nameDayEventDescription(name, locale) {
  return translate(locale, 'birthdays.nameDayCalendarEventDescription', { name });
}

/**
 * Löscht einen Geburtstags-Termin und merkt die beim Provider liegende Kopie zur
 * Löschung vor. Die Vormerkung muss davor passieren: danach fehlt der Weg zum
 * entfernten Objekt (Kalender-ID und Objekt-URL stehen in der Zeile), und der
 * nächste Inbound-Lauf spielte den Termin sonst wieder ein.
 *
 * Die Connection wird durchgereicht: `syncBirthdayArtifacts` läuft auch mit einer
 * eigenen (processDueNotifications gibt seine weiter, test-dashboard.js nutzt
 * das). Über `db.get()` geschrieben landete die Vormerkung sonst in einer anderen
 * Datenbank als der Termin, auf den sie sich bezieht.
 */
function deleteCalendarEvent(database, eventId) {
  const event = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId);
  if (event) queueEventDeletion(event, database);
  database.prepare('DELETE FROM calendar_events WHERE id = ?').run(eventId);
}

function syncBirthdayCalendarEvent(database, birthday, kind = 'birthday') {
  const isNameDay = kind === 'name_day';
  const eventIdField = isNameDay ? 'name_day_calendar_event_id' : 'calendar_event_id';
  const linkedEventId = birthday[eventIdField];
  const sourceDate = isNameDay
    ? (birthday.name_day ? `2000-${birthday.name_day}` : null)
    : birthday.birth_date;

  // "Keine Benachrichtigung" → Geburtstag soll weder im Dashboard noch im
  // Kalender als Termin erscheinen. Vorhandenes Event löschen und null zurückgeben.
  if (!sourceDate || birthday.reminder_offset === '') {
    if (linkedEventId) {
      database.prepare(`
        DELETE FROM reminders
        WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
      `).run(linkedEventId, birthday.created_by);
      deleteCalendarEvent(database, linkedEventId);
      database.prepare(`UPDATE birthdays SET ${eventIdField} = NULL WHERE id = ?`).run(birthday.id);
    }
    return null;
  }

  const { locale, dateFormat } = resolveHouseholdFormats(database);
  const payload = {
    title: isNameDay ? nameDayEventTitle(birthday.name, locale) : eventTitle(birthday.name, locale),
    description: isNameDay
      ? nameDayEventDescription(birthday.name, locale)
      : eventDescription(birthday.name, birthday.birth_date, locale, dateFormat),
    start_datetime: sourceDate,
    end_datetime: null,
    all_day: 1,
    location: null,
    color: BIRTHDAY_COLOR,
    icon: isNameDay ? 'balloon' : 'cake',
    assigned_to: null,
    recurrence_rule: BIRTHDAY_RRULE,
    created_by: birthday.created_by,
  };

  if (linkedEventId) {
    const existing = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(linkedEventId);
    if (existing) {
      // `external_source` wird bewusst NICHT auf 'local' zurückgesetzt. Das tat
      // diese Anweisung seit dem ersten Geburtstags-Commit, lange bevor es einen
      // Outbound-Sync gab - und seither entkoppelte jede Bearbeitung den Termin
      // von seiner Kopie beim Provider: `pendingUpdates` sucht nach
      // external_source='apple', der Neu-Upload nach external_calendar_id IS NULL,
      // und mit 'local' + gesetzter Kalender-ID traf keiner von beiden zu. Ein
      // einmal gespiegelter Geburtstag fror dort für immer ein.
      //
      // Folge, die dazugehört: die Zeile bleibt damit auch im Blick von
      // pruneDeletedEvents (calendar-prune.js). Wer den Termin beim Provider
      // löscht, den Geburtstag in Yuvomi aber behält, bekommt ihn beim nächsten
      // Sync neu angelegt und hochgeladen. Das ist die konsequente Fortsetzung
      // davon, dass der Geburtstag die Quelle ist und der Kalendereintrag sein
      // Abbild - wer ihn loswerden will, stellt die Erinnerung auf "keine" oder
      // löscht den Geburtstag.
      const mirrored = OUTBOUND_SOURCES.includes(existing.external_source) && !!existing.external_calendar_id;

      if (mirrored) {
        // Bei einer gespiegelten Zeile nur schreiben, was der Geburtstag selbst
        // hervorbringt. Der Weg über den Provider ist nicht wertneutral: der
        // ICS-Export schreibt für einen ganztägigen Termin immer ein DTEND, und
        // der Inbound macht daraus ein `end_datetime`, wo vorher NULL stand;
        // eine Farbe überträgt er gar nicht, also kommt die des Kalenders
        // zurück. Würde dieser Sync das stumpf zurückschreiben, sähe der
        // Feldvergleich bei JEDEM Lauf eine Änderung - und weil
        // syncAllBirthdayReminders schon an einem GET /birthdays hängt, wäre das
        // ein Push pro Geburtstag pro Abruf, endlos. Diese Felder gehören
        // deshalb dem Provider, sobald er die Zeile einmal angefasst hat.
        // `end_datetime` folgt dem Start, statt zu bleiben: der Inbound legt bei
        // einem ganztägigen Termin ein Ende gleich dem Startdatum ab. Bliebe es
        // beim Verschieben des Geburtsdatums stehen, läge das Ende vor dem
        // Beginn - die Outbound-Serializer machen daraus ein DTEND vor DTSTART
        // bzw. einen mehrtägigen Geburtstag. NULL bleibt NULL, damit ein noch
        // nicht normalisierter Termin keine Scheinänderung bekommt.
        database.prepare(`
          UPDATE calendar_events
          SET title = ?, description = ?, start_datetime = ?,
              end_datetime = CASE WHEN end_datetime IS NULL THEN NULL ELSE ? END
          WHERE id = ?
        `).run(
          payload.title,
          payload.description,
          payload.start_datetime,
          payload.start_datetime,
          linkedEventId,
        );

        // Marker inline statt über markEventOutbound: das schreibt über db.get()
        // und würde die übergebene Connection umgehen (dieselbe Überlegung wie
        // in retitleBirthdayEvents). Verglichen wird genau das, was oben
        // geschrieben wurde - alles andere ist Provider-Normalisierung und darf
        // keinen Push auslösen.
        const authoredChanged = AUTHORED_FIELDS.some((f) => existing[f] !== payload[f]);
        if (authoredChanged) {
          database.prepare(
            'UPDATE calendar_events SET outbound_dirty = 1, outbound_attempts = 0 WHERE id = ?'
          ).run(linkedEventId);
        }
      } else {
        database.prepare(`
          UPDATE calendar_events
          SET title = ?, description = ?, start_datetime = ?, end_datetime = ?, all_day = ?,
              location = ?, color = ?, icon = ?, assigned_to = ?, recurrence_rule = ?, created_by = ?
          WHERE id = ?
        `).run(
          payload.title,
          payload.description,
          payload.start_datetime,
          payload.end_datetime,
          payload.all_day,
          payload.location,
          payload.color,
          payload.icon,
          payload.assigned_to,
          payload.recurrence_rule,
          payload.created_by,
          linkedEventId,
        );
      }
      return linkedEventId;
    }
  }

  const result = database.prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, all_day, location, color,
       icon, assigned_to, created_by, recurrence_rule, external_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')
  `).run(
    payload.title,
    payload.description,
    payload.start_datetime,
    payload.end_datetime,
    payload.all_day,
    payload.location,
    payload.color,
    payload.icon,
    payload.assigned_to,
    payload.created_by,
    payload.recurrence_rule,
  );

  database.prepare(`UPDATE birthdays SET ${eventIdField} = ? WHERE id = ?`)
    .run(result.lastInsertRowid, birthday.id);
  return result.lastInsertRowid;
}

function syncBirthdayReminder(database, birthday, from = new Date(), kind = 'birthday') {
  const isNameDay = kind === 'name_day';
  const eventId = isNameDay ? birthday.name_day_calendar_event_id : birthday.calendar_event_id;
  const sourceDate = isNameDay ? `2000-${birthday.name_day}` : birthday.birth_date;
  if (!eventId || (isNameDay && !birthday.name_day)) return null;
  const today = todayKey(database, from);
  const tz    = householdTimeZone(database);

  if (birthday.reminder_offset === '') {
    database.prepare(`
      DELETE FROM reminders
      WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
    `).run(eventId, birthday.created_by);
    return null;
  }

  const offsetMin = getOffsetMinutes(birthday);
  const desired = birthdayReminderAt(sourceDate, offsetMin, today, tz);
  const existing = database.prepare(`
    SELECT * FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
    ORDER BY created_at DESC
  `).all(eventId, birthday.created_by);

  // EINE ZEILE JE TERMIN, verworfen oder nicht. Hier stand
  // `existing.find((row) => row.dismissed === 0)`: nach dem Verwerfen fand die
  // Suche nichts, loeschte alles und legte dieselbe Erinnerung unverworfen neu
  // an. `GET /reminders/pending` gleicht bei jedem Poll ab, also stand sie eine
  // Minute spaeter wieder da, mit leerem `pushed_at` auch fuer den Push-Scheduler.
  // Ersetzt wird nur, wenn sich der Termin selbst aendert: anderer Vorlauf,
  // anderes Datum, oder der Geburtstag ist vorbei und das naechste Jahr dran.
  const current = existing.find((row) => row.remind_at === desired && row.dismissed === 0)
    ?? existing.find((row) => row.remind_at === desired);
  if (current) return current.id;

  database.prepare(`
    DELETE FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
  `).run(eventId, birthday.created_by);

  const result = database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('event', ?, ?, ?)
  `).run(eventId, desired, birthday.created_by);

  return result.lastInsertRowid;
}

function syncBirthdayArtifacts(database, birthday, from = new Date()) {
  const calendarEventId = syncBirthdayCalendarEvent(database, birthday);
  let refreshed = { ...birthday, calendar_event_id: calendarEventId };
  syncBirthdayReminder(database, refreshed, from);
  const nameDayCalendarEventId = syncBirthdayCalendarEvent(database, refreshed, 'name_day');
  refreshed = { ...refreshed, name_day_calendar_event_id: nameDayCalendarEventId };
  syncBirthdayReminder(database, refreshed, from, 'name_day');
  return refreshed;
}

function deleteBirthdayArtifacts(database, birthday) {
  for (const eventId of [birthday.calendar_event_id, birthday.name_day_calendar_event_id]) {
    if (!eventId) continue;
    database.prepare(`
      DELETE FROM reminders
      WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
    `).run(eventId, birthday.created_by);
    deleteCalendarEvent(database, eventId);
  }
}

/**
 * Betitelt alle vorhandenen Geburtstags-Termine in der aktuellen Datensprache des
 * Haushalts neu.
 *
 * Nötig beim Wechsel der Sprache: die Titel stehen als Text in calendar_events,
 * ein Umschalten allein ändert die Bestandszeilen nicht. Ohne diesen Lauf würde
 * der Haushalt bis zum nächsten Geburtstags-Sync eine Mischung aus alter und
 * neuer Sprache sehen - und in externen Kalendern noch länger.
 *
 * Ein umbenannter Termin, der bereits beim Provider liegt, wird für den Push
 * vorgemerkt. Ohne das bliebe genau der Kanal englisch, um den es hier geht:
 * `title` und `description` stehen in MIRRORED_FIELDS, aber der Sync holt sich
 * seine Arbeit ausschließlich über `outbound_dirty` (pendingUpdates in
 * server/services/calendar-outbound.js). Geburtstags-Termine landen dort, weil
 * der Apple-Sync jedes lokale Event ohne Kalenderzuordnung hochlädt und die
 * Zeile danach auf `external_source = 'apple'` stellt.
 *
 * Der Marker wird bewusst inline gesetzt statt über markOutbound(): das schreibt
 * über db.get() und würde die übergebene Connection umgehen.
 *
 * @param {object} database
 * @returns {number} Zahl der tatsächlich geänderten Termine
 */
function retitleBirthdayEvents(database) {
  const { locale, dateFormat } = resolveHouseholdFormats(database);
  const rows = database.prepare(`
    SELECT b.name, b.birth_date, 'birthday' AS event_kind,
           e.id, e.title, e.description, e.external_source, e.external_calendar_id
    FROM birthdays b
    JOIN calendar_events e ON e.id = b.calendar_event_id
    UNION ALL
    SELECT b.name, NULL AS birth_date, 'name_day' AS event_kind,
           e.id, e.title, e.description, e.external_source, e.external_calendar_id
    FROM birthdays b
    JOIN calendar_events e ON e.id = b.name_day_calendar_event_id
  `).all();

  const update = database.prepare(
    'UPDATE calendar_events SET title = ?, description = ? WHERE id = ?'
  );
  // Kein Reset von outbound_dirty auf 0: ein anderer Grund für einen
  // ausstehenden Push darf durch diesen Lauf nicht verlorengehen.
  const markDirty = database.prepare(
    'UPDATE calendar_events SET outbound_dirty = 1, outbound_attempts = 0 WHERE id = ?'
  );

  let changed = 0;
  for (const row of rows) {
    const title = row.event_kind === 'name_day'
      ? nameDayEventTitle(row.name, locale)
      : eventTitle(row.name, locale);
    const description = row.event_kind === 'name_day'
      ? nameDayEventDescription(row.name, locale)
      : eventDescription(row.name, row.birth_date, locale, dateFormat);
    if (title === row.title && description === (row.description ?? null)) continue;

    update.run(title, description, row.id);
    changed++;

    if (OUTBOUND_SOURCES.includes(row.external_source) && row.external_calendar_id) {
      markDirty.run(row.id);
    }
  }
  return changed;
}

/**
 * `database` ist hier NICHT Beiwerk: `next_birthday` und `days_until` sind
 * Kalendertage, und welcher Tag heute ist, weiss nur die Haushaltszone - die
 * steht in sync_config (#829). Ohne Verbindung bliebe es beim Rueckfall auf die
 * Umgebung, und die Uebersicht zaehlte westlich von UTC abends einen Tag zu wenig.
 */
function hydrateBirthday(database, row, from = new Date()) {
  const today = todayKey(database, from);
  const next_birthday = nextBirthdayDate(row.birth_date, today);
  return {
    ...row,
    next_birthday,
    next_age: nextBirthdayAge(row.birth_date, today),
    days_until: daysUntilBirthday(row.birth_date, today),
    next_name_day: row.name_day ? nextNameDayDate(row.name_day, today) : null,
    name_day_days_until: row.name_day ? daysUntilNameDay(row.name_day, today) : null,
  };
}

function hydrateBirthdayOccurrences(database, row, from = new Date()) {
  const birthday = hydrateBirthday(database, row, from);
  const occurrences = [{
    ...birthday,
    kind: 'birthday',
    next_date: birthday.next_birthday,
  }];
  if (birthday.name_day && birthday.next_name_day) {
    occurrences.push({
      ...birthday,
      kind: 'name_day',
      next_date: birthday.next_name_day,
      days_until: birthday.name_day_days_until,
      next_age: null,
    });
  }
  return occurrences;
}

function syncAllBirthdayReminders(database, userId, from = new Date()) {
  const birthdays = database.prepare(`
    SELECT * FROM birthdays WHERE created_by = ? ORDER BY birth_date ASC
  `).all(userId);
  birthdays.forEach((birthday) => syncBirthdayArtifacts(database, birthday, from));
}

/**
 * Liefert Kontakte als Import-Kandidaten für Geburtstage. Kontakte, die ein
 * Haushaltsmitglied im Housekeeping repräsentieren, werden ausgeschlossen (wie
 * GET /contacts). Kandidaten werden nach "mit Geburtstag" (importierbar) und
 * "ohne Geburtstag" (nur zur Information, manuell zu ergänzen) getrennt.
 *
 * `already_imported` markiert Kontakte, die über birthdays.contact_id bereits an
 * einen Geburtstag gekoppelt sind (haushaltsweit, nicht pro Nutzer).
 *
 * @param {object} database
 * @returns {{ withBirthday: Array<{id:number,name:string,birthday:string,already_imported:boolean}>, withoutBirthday: Array<{id:number,name:string}> }}
 */
function listBirthdayImportCandidates(database) {
  const rows = database.prepare(`
    SELECT c.id, c.name, c.birthday,
           EXISTS(SELECT 1 FROM birthdays b WHERE b.contact_id = c.id) AS already_imported
    FROM contacts c
    WHERE NOT EXISTS (
      SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = c.family_user_id
    )
    ORDER BY c.name COLLATE NOCASE ASC
  `).all();

  const withBirthday = [];
  const withoutBirthday = [];
  for (const r of rows) {
    if (r.birthday && String(r.birthday).trim()) {
      withBirthday.push({
        id: r.id,
        name: r.name,
        birthday: r.birthday,
        already_imported: r.already_imported === 1,
      });
    } else {
      withoutBirthday.push({ id: r.id, name: r.name });
    }
  }
  return { withBirthday, withoutBirthday };
}

/**
 * Importiert ausgewählte Kontakte als Geburtstage und erzeugt die zugehörigen
 * Kalender-/Reminder-Artefakte über den bestehenden Sync-Pfad.
 *
 * Idempotent: Kontakte ohne verwertbares Geburtsdatum, unbekannte IDs und
 * bereits gekoppelte Kontakte werden übersprungen. Der partielle Unique-Index
 * auf birthdays.contact_id ist die DB-seitige Absicherung.
 *
 * Das Kontaktfoto wird bewusst NICHT übernommen: contacts.photo ist rohes
 * vCard-Base64, birthdays.photo_data erwartet dagegen eine Data-URL.
 *
 * @param {object} database
 * @param {Array<number|string>} contactIds
 * @param {number} userId  created_by der neuen Geburtstage
 * @param {Date}   from
 * @returns {{ imported: number, skipped: number }}
 */
function importBirthdaysFromContacts(database, contactIds, userId, from = new Date()) {
  let imported = 0;
  let skipped = 0;

  const getContact = database.prepare('SELECT id, name, birthday FROM contacts WHERE id = ?');
  const alreadyLinked = database.prepare('SELECT 1 FROM birthdays WHERE contact_id = ?');
  const insert = database.prepare(`
    INSERT INTO birthdays (name, birth_date, created_by, contact_id, reminder_offset)
    VALUES (?, ?, ?, ?, NULL)
  `);
  const load = database.prepare('SELECT * FROM birthdays WHERE id = ?');

  for (const rawId of contactIds) {
    const id = parseInt(rawId, 10);
    if (!Number.isInteger(id)) { skipped++; continue; }

    const contact = getContact.get(id);
    if (!contact || !contact.birthday || !String(contact.birthday).trim()) { skipped++; continue; }
    if (alreadyLinked.get(id)) { skipped++; continue; }

    const newId = insert.run(contact.name, contact.birthday, userId, id).lastInsertRowid;
    syncBirthdayArtifacts(database, load.get(newId), from);
    imported++;
  }

  return { imported, skipped };
}

export {
  BIRTHDAY_COLOR,
  BIRTHDAY_RRULE,
  birthdayReminderAt,
  daysUntilBirthday,
  daysUntilNameDay,
  deleteBirthdayArtifacts,
  eventDescription,
  eventTitle,
  hydrateBirthday,
  hydrateBirthdayOccurrences,
  importBirthdaysFromContacts,
  listBirthdayImportCandidates,
  nextBirthdayAge,
  nextBirthdayDate,
  nextNameDayDate,
  retitleBirthdayEvents,
  syncAllBirthdayReminders,
  syncBirthdayArtifacts,
};
