/**
 * Reine Hilfslogik für scope-basiertes Bearbeiten/Löschen von Serienterminen (#532).
 *
 * „nur dieser Termin", „dieser und folgende", „ganze Serie" nutzen für lokale
 * verknüpfte Ausnahmen atomare Endpunkte. Lokal verwaltete Serien, die keine
 * verknüpften Ausnahmen nutzen können - einschließlich ausgehend synchronisierter
 * und generierter Serien - behalten den bisherigen mehrstufigen Ablauf
 * (Einzeltermin + EXDATE bzw. Kürzen + Folgeserie). Datumsarithmetik und
 * Request-Auswahl bleiben DOM-frei testbar.
 */

import { parseLocalDateKey, addLocalDays } from './date.js';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Trägt eine Serie Yuvomi selbst, oder gehört sie einem anderen Kalender?
 *
 * Die Frage entscheidet über den Löschumfang, deshalb steht sie hier neben der
 * Scope-Arithmetik statt in der Seite: nur eine LOKALE Serie lässt sich in „nur
 * dieser Termin" / „dieser und folgende" / „ganze Serie" zerlegen. Bei einer
 * Serie aus Google, Apple, CalDAV oder einem ICS-Abo käme ein lokal
 * ausgenommenes Vorkommen beim nächsten Sync zurück (#489/#532).
 *
 * `external_source` ist serverseitig NOT NULL DEFAULT 'local'; das `?? 'local'`
 * fängt eine Antwort ab, die die Spalte gar nicht mitliefert.
 */
export function isLocalRecurringSeries(event) {
  return event?.is_local_recurring_series === true;
}

/** Whether this actor may use the occurrence-only mutation endpoints. */
export function canOverrideCalendarOccurrence(event) {
  return event?.can_override_occurrence === true;
}

export function canEditCalendarOccurrence(event) {
  return canOverrideCalendarOccurrence(event) || event?.can_detach_occurrence === true;
}

/** Whether this actor must acknowledge that only whole-series actions are available. */
export function requiresWholeSeriesConfirmation(event) {
  return isLocalRecurringSeries(event) && !canEditCalendarOccurrence(event);
}

/**
 * Das Gegenstück: wiederkehrend, aber einem anderen Kalender gehörend. Genau
 * dieser Fall löscht mehr, als der angetippte Termin vermuten lässt, und muss
 * es deshalb sagen, bevor er es tut (#880).
 */
export function isExternalRecurringSeries(event) {
  return !!event?.recurrence_rule && !isLocalRecurringSeries(event);
}

function serverSeriesId(event) {
  const seriesId = Number(event?.series_id);
  if (!Number.isInteger(seriesId) || seriesId < 1) {
    throw new TypeError('A server-provided calendar series_id is required.');
  }
  return seriesId;
}

function serverRecurrenceId(event) {
  const recurrenceId = event?.recurrence_id;
  if (typeof recurrenceId !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(recurrenceId)) {
    throw new TypeError('A server-provided calendar recurrence_id is required.');
  }
  return recurrenceId;
}

/** Selects the one server mutation used by each recurring edit scope. */
export function calendarOccurrenceMutationTarget(event, scope) {
  const seriesId = serverSeriesId(event);
  if (scope === 'series') {
    return { method: 'put', path: `/calendar/${seriesId}`, carriesReminderOffsets: false };
  }
  const recurrenceId = encodeURIComponent(serverRecurrenceId(event));
  if (scope === 'this') {
    return {
      method: 'put',
      path: `/calendar/${seriesId}/occurrences/${recurrenceId}`,
      carriesReminderOffsets: true,
    };
  }
  if (scope === 'following') {
    return {
      method: 'put',
      path: `/calendar/${seriesId}/occurrences/${recurrenceId}/following`,
      carriesReminderOffsets: true,
    };
  }
  throw new TypeError(`Unknown recurring calendar scope: ${scope}`);
}

/** Selects the atomic server delete used by each recurring delete scope. */
export function calendarOccurrenceDeleteTarget(event, scope) {
  const seriesId = serverSeriesId(event);
  if (scope === 'series') return { method: 'delete', path: `/calendar/${seriesId}` };
  const recurrenceId = encodeURIComponent(serverRecurrenceId(event));
  if (scope === 'this') {
    return { method: 'delete', path: `/calendar/${seriesId}/occurrences/${recurrenceId}` };
  }
  if (scope === 'following') {
    return {
      method: 'delete',
      path: `/calendar/${seriesId}/occurrences/${recurrenceId}/following`,
    };
  }
  throw new TypeError(`Unknown recurring calendar scope: ${scope}`);
}

function orphanConflictCount(error) {
  const data = error?.data;
  const count = data?.orphaned_override_count;
  if (error?.status !== 409
      || data?.conflict !== 'calendar_override_orphans'
      || !Number.isInteger(count)
      || count < 0) return null;
  return count;
}

/** Retries a series mutation only for the exact orphan count the user saw. */
export async function withCalendarOrphanConfirmation(request, confirmCount) {
  let confirmedCount;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await request(confirmedCount);
    } catch (error) {
      const currentCount = orphanConflictCount(error);
      if (currentCount === null || currentCount === confirmedCount) throw error;
      if (!await confirmCount(currentCount)) return null;
      confirmedCount = currentCount;
    }
  }
  throw new Error('Calendar override conflict changed too many times; reload and try again.');
}

/** Selects linked deletion or the fallback for locally owned series without linked overrides. */
export function requestCalendarOccurrenceDelete({ api, event, scope, keepalive = false }) {
  const target = calendarOccurrenceDeleteTarget(event, scope);
  if (event?.can_detach_occurrence && !canOverrideCalendarOccurrence(event)) {
    const path = `/calendar/${serverSeriesId(event)}`;
    if (scope === 'this') {
      return api.post(`${path}/exceptions`, { date: serverRecurrenceId(event) }, { keepalive });
    }
    if (scope === 'following' && !followingMeansWholeSeries(event)) {
      return api.put(path, {
        recurrence_rule: truncateRuleBefore(event.recurrence_rule, serverRecurrenceId(event)),
      }, { keepalive });
    }
    return api.delete(path, { keepalive });
  }
  return api.delete(target.path, { keepalive });
}

/** Linked edits are atomic; locally owned fallback edits retain their legacy request sequence. */
export async function requestCalendarOccurrenceMutation({
  api,
  event,
  scope,
  body,
  reminderOffsets = [],
  confirmCount,
}) {
  // Locally owned series that cannot use linked overrides retain the pre-#975 workflow (#532).
  // These separate requests intentionally retain its existing atomicity limits.
  if (event?.can_detach_occurrence && !canOverrideCalendarOccurrence(event) && scope !== 'series') {
    const path = `/calendar/${serverSeriesId(event)}`;
    const date = serverRecurrenceId(event);
    if (scope === 'this') {
      const response = await api.post('/calendar', { ...body, recurrence_rule: null });
      await api.post(`${path}/exceptions`, { date });
      return response;
    }
    if (scope === 'following' && !followingMeansWholeSeries(event)) {
      await api.put(path, { recurrence_rule: truncateRuleBefore(event.recurrence_rule, date) });
      return api.post('/calendar', body);
    }
    throw new TypeError('The first following occurrence must use the whole-series edit path.');
  }
  const target = calendarOccurrenceMutationTarget(event, scope);
  const payload = { ...body };
  if (target.carriesReminderOffsets) {
    if (scope === 'this') {
      for (const seriesOwnedField of [
        'target_google_calendar_id',
        'target_caldav_account_id',
        'target_caldav_calendar_url',
        'target_outlook_account_id',
        'target_outlook_calendar_id',
      ]) delete payload[seriesOwnedField];
      delete payload.recurrence_rule;
    }
    payload.reminder_offsets = reminderOffsets;
  }
  return withCalendarOrphanConfirmation(
    (confirmedCount) => api.put(target.path, confirmedCount === undefined
      ? payload
      : { ...payload, confirmed_orphan_count: confirmedCount }),
    confirmCount,
  );
}

/**
 * Meint "dieser und alle folgenden" hier die GANZE Serie?
 *
 * Am Anfang einer Serie ist der Schnitt kein Schnitt: es bleibt nichts davor
 * stehen. Loeschen heisst dann die ganze Serie loeschen, Bearbeiten heisst den
 * Master aendern - in beiden Faellen ohne die Regel zu kuerzen.
 *
 * `is_recurring_instance` REICHT ALS FRAGE NICHT MEHR. Es sagt nur, ob das
 * Vorkommen vom gespeicherten Datum abweicht, und bis #960 fielen "weicht ab"
 * und "ist nicht der Anfang" zusammen. Seit ein Start neben dem Raster seiner
 * Regel liegen darf (15. Januar, "am Monatsletzten"), ist das erste Vorkommen
 * der 31.: eine Instanz, die abweicht, und trotzdem der Anfang. Der Schnitt
 * kuerzte die Regel dort auf den 30. - eine leere Serie, die der Server
 * ablehnt, womit sich der erste sichtbare Termin weder loeschen noch
 * bearbeiten liess.
 *
 * Fehlt `is_series_start` (aeltere Antwort, nicht expandierter Termin), bleibt
 * es beim vorherigen Verhalten.
 */
export function followingMeansWholeSeries(event) {
  return !event?.is_recurring_instance || !!event?.is_series_start;
}

/** Tagesdifferenz (ganze Tage) zwischen zwei YYYY-MM-DD-Schlüsseln. */
function dayDelta(fromKey, toKey) {
  return Math.round((parseLocalDateKey(toKey) - parseLocalDateKey(fromKey)) / 86400000);
}

/** 'YYYY-MM-DDTHH:MM' aus einem lokalen Date-Objekt (Sekunden werden verworfen). */
function formatLocalDateTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
       + `T${p(date.getHours())}:${p(date.getMinutes())}`;
}

/**
 * Kürzt eine RRULE so, dass alle Vorkommen AB `occurrenceDateKey` entfallen.
 * Setzt UNTIL auf den Vortag (inklusive Grenze in der Expansion) und entfernt ein
 * evtl. vorhandenes UNTIL/COUNT. Reihenfolge bleibt FREQ;INTERVAL;BYDAY;UNTIL,
 * damit der Server-Validator (RRULE_RE) greift.
 *
 * @param {string} rule              Bestehende RRULE (ggf. mit „RRULE:"-Präfix)
 * @param {string} occurrenceDateKey YYYY-MM-DD des ersten zu entfernenden Vorkommens
 * @returns {string|null}            Gekürzte RRULE oder null bei ungültiger Eingabe
 */
export function truncateRuleBefore(rule, occurrenceDateKey) {
  if (!rule || !DATE_KEY_RE.test(occurrenceDateKey || '')) return null;
  const raw = rule.startsWith('RRULE:') ? rule.slice(6) : rule;
  const keep = [];
  let freq = null;
  let interval = null;
  let byday = null;
  let monthday = null;
  for (const segment of raw.split(';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const key = segment.slice(0, eq).toUpperCase();
    const val = segment.slice(eq + 1);
    if (key === 'FREQ') freq = val;
    else if (key === 'INTERVAL') interval = val;
    else if (key === 'BYDAY') byday = val;
    // "Am letzten Tag des Monats" (#960) gehoert zur Aussage der Serie, nicht zu
    // ihrer Laenge. Ohne diese Zeile verlor der zurueckbleibende Teil beim
    // "diesen und alle folgenden"-Schnitt seinen Monatsletzten und lief danach
    // auf dem Tag seines Startdatums weiter - dieselbe stille Umschreibung, die
    // die Wortlaut-Regel in #756 an anderer Stelle verhindert.
    else if (key === 'BYMONTHDAY' && val.trim() === '-1') monthday = '-1';
    // UNTIL/COUNT werden bewusst verworfen und durch das neue UNTIL ersetzt.
  }
  if (!freq) return null;
  keep.push(`FREQ=${freq}`);
  if (interval && interval !== '1') keep.push(`INTERVAL=${interval}`);
  if (byday) keep.push(`BYDAY=${byday}`);
  // Nur bei MONTHLY, wie ueberall sonst auch: der Validator nimmt die Angabe
  // unter keiner anderen Frequenz an.
  if (monthday && String(freq).toUpperCase() === 'MONTHLY') keep.push('BYMONTHDAY=-1');
  const untilKey = addLocalDays(occurrenceDateKey.slice(0, 10), -1); // Vortag, inklusiv
  keep.push(`UNTIL=${untilKey.replace(/-/g, '')}`);
  return keep.join(';');
}

/**
 * Neuer Serien-Start (DTSTART) bei „ganze Serie"-Bearbeitung: Der im Modal
 * angezeigte Instanz-Start kann verschoben worden sein; dieselbe Verschiebung
 * wird auf den Master-Start angewendet, damit die Serie nicht neu verankert wird.
 *
 * @param {string}  masterStart   Aktueller DTSTART des Masters
 * @param {string}  instanceStart Ursprünglicher Start der geöffneten Instanz
 * @param {string}  editedStart   Im Modal gewählter Start
 * @param {boolean} allDay        Ganztägig (datums-genaue Verschiebung)
 * @returns {string}              Neuer Master-Start
 */
export function shiftSeriesStart(masterStart, instanceStart, editedStart, allDay) {
  if (allDay) {
    const delta = dayDelta(instanceStart.slice(0, 10), editedStart.slice(0, 10));
    return addLocalDays(masterStart.slice(0, 10), delta);
  }
  const deltaMs = new Date(editedStart).getTime() - new Date(instanceStart).getTime();
  const shifted = new Date(new Date(masterStart).getTime() + deltaMs);
  return formatLocalDateTime(shifted);
}

/**
 * Ende passend zu einem neuen Start, unter Beibehaltung der im Modal gewählten
 * Dauer. Gibt null zurück, wenn kein Ende gesetzt ist.
 *
 * @param {string}      newStart    Neuer Start (Master oder neue Serie)
 * @param {string}      editedStart Im Modal gewählter Start
 * @param {string|null} editedEnd   Im Modal gewähltes Ende
 * @param {boolean}     allDay      Ganztägig
 * @returns {string|null}           Neues Ende oder null
 */
export function shiftEndForStart(newStart, editedStart, editedEnd, allDay) {
  if (!editedEnd) return null;
  if (allDay) {
    const durationDays = dayDelta(editedStart.slice(0, 10), editedEnd.slice(0, 10));
    return addLocalDays(newStart.slice(0, 10), durationDays);
  }
  const durationMs = new Date(editedEnd).getTime() - new Date(editedStart).getTime();
  const shifted = new Date(new Date(newStart).getTime() + durationMs);
  return formatLocalDateTime(shifted);
}
