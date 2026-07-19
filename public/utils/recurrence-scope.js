/**
 * Reine Hilfslogik für scope-basiertes Bearbeiten/Löschen von Serienterminen (#532).
 *
 * „nur dieser Termin", „dieser und folgende", „ganze Serie" werden clientseitig
 * über die bestehenden Kalender-Endpunkte (PUT/POST/DELETE + /exceptions)
 * orchestriert. Diese Datei kapselt nur die datums-/regel-arithmetischen Teile,
 * damit sie ohne DOM getestet werden können. Bewusst frei von Framework-/DOM-Bezug.
 */

import { parseLocalDateKey, toLocalDateKey, addLocalDays } from './date.js';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}/;

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
  for (const segment of raw.split(';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const key = segment.slice(0, eq).toUpperCase();
    const val = segment.slice(eq + 1);
    if (key === 'FREQ') freq = val;
    else if (key === 'INTERVAL') interval = val;
    else if (key === 'BYDAY') byday = val;
    // UNTIL/COUNT werden bewusst verworfen und durch das neue UNTIL ersetzt.
  }
  if (!freq) return null;
  keep.push(`FREQ=${freq}`);
  if (interval && interval !== '1') keep.push(`INTERVAL=${interval}`);
  if (byday) keep.push(`BYDAY=${byday}`);
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
