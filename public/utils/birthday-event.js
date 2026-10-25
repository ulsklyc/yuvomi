/**
 * Geburtstags-Termin-Lokalisierung (Issue #524)
 *
 * Geburtstags-Termine aus dem Geburtstags-Modul werden serverseitig mit einem
 * sprachneutralen Titel („Birthday: <Name>") in calendar_events gespeichert, weil
 * die Anzeigesprache nur clientseitig bekannt ist. Der Kalender-Read liefert bei
 * solchen Terminen birthday_name (+ birthday_date) mit; hier werden Titel und
 * Beschreibung in die aktive Sprache übersetzt.
 *
 * Geteilt von Kalender- und Dashboard-Seite, damit das Format nur an einer Stelle
 * gepflegt wird.
 *
 * Bewusste Grenze (Suche): Der FTS-Index (server/db.js, trg_search_events_*)
 * indexiert den gespeicherten, sprachneutralen Titel. Geburtstags-Termine sind
 * daher über den Personennamen auffindbar (z. B. „Emma"), aber nicht über das
 * übersetzte Wort „Geburtstag" - nur über „Birthday". Das ist akzeptiert: Namen
 * sind der übliche Suchbegriff. Eine sprachunabhängige Indizierung wäre für den
 * Nutzen unverhältnismäßig.
 */
import { t } from '/i18n.js';
import { dateText } from '/utils/date-format.js';

/**
 * Übersetzt Titel/Beschreibung eines Geburtstags-Termins in die aktive Sprache.
 * Nicht-Geburtstags-Termine (kein birthday_name) werden unverändert zurückgegeben.
 * @param {object} ev  Serialisierter Termin (ggf. mit birthday_name/birthday_date)
 * @returns {object}   Derselbe Termin bzw. eine Kopie mit lokalisiertem Titel/Text
 */
export function localizeBirthdayEvent(ev) {
  if (!ev || !ev.birthday_name) return ev;
  const name = ev.birthday_name;
  if (ev.birthday_event_kind === 'name_day') {
    return {
      ...ev,
      title: t('birthdays.nameDayCalendarEventTitle', { name }),
      description: t('birthdays.nameDayCalendarEventDescription', { name }),
    };
  }
  return {
    ...ev,
    title: t('birthdays.calendarEventTitle', { name }),
    description: ev.birthday_date
      ? t('birthdays.calendarEventDescription', { name, date: dateText(ev.birthday_date, { year: true }) })
      : t('birthdays.calendarEventDescriptionNoDate', { name }),
  };
}
