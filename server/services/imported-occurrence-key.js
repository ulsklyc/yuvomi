/**
 * Modul: Schluessel eingelesener Vorkommen (#2034 Schritt 5, #2000)
 * Zweck: Aus dem Rohwert eines EXDATE oder einer RECURRENCE-ID, wie ihn ein
 *        Anbieter liefert (ICS-Abo, ICS-Import, CalDAV, iCloud), den Schluessel
 *        des gemeinten Vorkommens in Format A machen - und beim Empfang die
 *        alte Zeile heilen, die die Importer bis hierher fuer denselben Rohwert
 *        geschrieben haben.
 * Abhaengigkeiten: server/services/calendar-events.js (`occurrenceClock`),
 *        server/utils/timezone.js
 *
 * Bis Schritt 5 legten die Importer jeden Rohwert als UTC-Tag ab (`YYYY-MM-DD`,
 * `formatICSDate(...).slice(0, 10)`), die Expansion fragte bei einer Serie, die
 * in ihrer Zone rechnet, aber den Ortstag ab. Wo die beiden auseinandergingen -
 * New York 19:30 im Winter, Berlin 01:30 nach der Umstellung -, traf die Absage
 * des Anbieters nichts oder das Nachbarvorkommen (#2000).
 *
 * Der Rohwert sagt das Vorkommen genau: RFC 5545 nennt den Originalstart. Daraus
 * wird hier der Schluessel, den die Uhr der Serie (`occurrenceClock().keyFor`)
 * fuer dieses Vorkommen selbst ausgibt. Ein Rohwert, den die Uhr der Serie
 * keinem Vorkommen zuordnen kann (Datum an einer getimten Serie, eine Zeile
 * ohne `tzid`, deren Vorkommen nach einer Umstellung neben der Absage liegen),
 * behaelt die alte Form - er wirkt dann genau wie bisher, nie schlechter.
 */

import {
  MAX_EXPANSION_ITERATIONS, expandRecurringEvents, occurrenceClock, occurrenceSlotOf, seriesReadingZone,
} from './calendar-events.js';
import { hasExplicitZone, localToUTCOccurrence, shiftDateKey } from '../utils/timezone.js';

/**
 * Hoechstens so viele Pruefungen per Expansion (`healable`) je Serie und
 * Lieferung (Security-Review zu #2300). Jede rollt die Serie ueber drei Tage
 * aus, mit bis zu MAX_EXPANSION_ITERATIONS Schritten; ein fremder Feed mit
 * tausenden EXDATEs haette die Arbeit sonst vervielfacht. Ist das Budget
 * aufgebraucht, wird nicht mehr geheilt (fail closed): die alte Zeile bleibt
 * und wirkt wie bisher, der naechste Empfang heilt weiter.
 */
export const HEAL_CHECK_BUDGET = 16;

const RAW_DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/i;

/** Ganze Sekunde als `YYYY-MM-DDTHH:MM:SSZ`, oder null. */
export function instantKey(value) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * Der Originalstart eines Rohwerts in Format A, ohne die Serie zu fragen:
 * Datum `YYYY-MM-DD`, Zeitpunkt `YYYY-MM-DDTHH:MM:SSZ` (mit `Z` oder `TZID`),
 * Wanduhr `YYYY-MM-DDTHH:MM:SS` (schwebend). Ein schwebender Wert an einer
 * Serie mit Zone gilt in deren Zone, wie RFC 5545 es fuer EXDATE neben einem
 * DTSTART mit TZID meint. Null, wenn der Wert nicht zu lesen ist.
 *
 * @param {{value: string|null, tzid?: string|null, isDate?: boolean}} raw
 * @param {string|null} [seriesTzid]  TZID des Serienstarts
 * @returns {string|null}
 */
export function rawOccurrenceKey(raw, seriesTzid = null) {
  const value = String(raw?.value ?? '').trim();
  if (raw?.isDate || /^\d{8}$/.test(value)) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(value);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  const m = RAW_DATE_TIME.exec(value);
  if (!m) return null;
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`;
  if (m[7]) return instantKey(`${local}Z`);
  const zone = raw.tzid || seriesTzid;
  if (!zone) return local;
  const converted = localToUTCOccurrence(local, zone);
  return hasExplicitZone(converted) ? instantKey(converted) : null;
}

/**
 * Der Schluessel, unter dem eine eingelesene Ausnahme an DIESER Serie liegt.
 *
 * `legacy` ist, was der Importer bis Schritt 5 fuer denselben Rohwert schrieb
 * (der UTC-Tag). `key` ist der Schluessel in Format A, wenn die Uhr der Serie
 * genau ein Vorkommen mit diesem Originalstart kennt - sonst die alte Form.
 *
 * @param {{value: string|null, tzid?: string|null, isDate?: boolean, legacy: string}} raw
 * @param {object} series  Serienzeile (start_datetime, all_day, tzid)
 * @param {{householdZone?: string|null, clock?: object}} [options]
 * @returns {{key: string, legacy: string}}
 */
export function occurrenceKeyFromRaw(raw, series, { householdZone = null, clock = null } = {}) {
  const legacy = raw.legacy;
  if (series.all_day || !raw.value) return { key: legacy, legacy };
  const candidate = rawOccurrenceKey(raw, series.tzid ?? null);
  // Ein Datum an einer getimten Serie bleibt beim alten Lesen (Schleifentag).
  if (!candidate || candidate.length === 10) return { key: legacy, legacy };
  let seriesClock = clock;
  try {
    seriesClock ??= occurrenceClock(series, householdZone);
  } catch {
    return { key: legacy, legacy };
  }
  return seriesClock.dayCandidatesOfKey(candidate).length === 1
    ? { key: candidate, legacy }
    : { key: legacy, legacy };
}

/**
 * Legt die eingelesenen Ausnahmen einer Serie ab und heilt die alte Form.
 *
 * Additiv wie bisher (`INSERT OR IGNORE`): eine lokal ausgenommene Ausnahme
 * bleibt stehen. Geheilt wird die Zeile, die der Importer bis Schritt 5 fuer
 * DENSELBEN Rohwert geschrieben hat - nur wenn der Schluessel jetzt ein anderer
 * ist, kein anderer Rohwert dieser Lieferung die alte Form noch braucht und die
 * alte Zeile kein ANDERES Vorkommen der Serie meinen kann (`healable`). Jeder
 * Empfang heilt so, was er liefert; was er nicht mehr liefert oder was offen
 * bleibt, bleibt bis zur Migration (Schritt 6) in der alten Form.
 *
 * Synchron, kein `await`: Lesen und Schreiben derselben Serie in einem Zug.
 *
 * @param {object} database  better-sqlite3-Connection
 * @param {number} eventId   die gespeicherte Serie
 * @param {object} ev        Ergebnis von `normalizeRecurrenceOverrides` (`exdateRaws`, `exdates`)
 * @param {{healCheckBudget?: number}} [options]  Budget der Pruefungen (Tests)
 * @returns {number}  geaenderte Zeilen (neu angelegt oder geheilt)
 */
export function storeImportedExceptions(database, eventId, ev, { healCheckBudget = HEAL_CHECK_BUDGET } = {}) {
  const raws = Array.isArray(ev?.exdateRaws)
    ? ev.exdateRaws
    : (Array.isArray(ev?.exdates) ? ev.exdates.map((legacy) => ({ value: null, legacy })) : []);
  if (!raws.length) return 0;
  const series = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId);
  if (!series) return 0;
  let householdZone = null;
  let clock = null;
  try {
    householdZone = seriesReadingZone(database, series);
    clock = occurrenceClock(series, householdZone);
  } catch { /* ohne Uhr bleibt jede Ausnahme in der alten Form */ }

  const pairs = raws
    .filter((raw) => raw && raw.legacy)
    .map((raw) => (clock ? occurrenceKeyFromRaw(raw, series, { householdZone, clock }) : { key: raw.legacy, legacy: raw.legacy }));
  const keys = new Set(pairs.map((pair) => pair.key));

  const insert = database.prepare(
    'INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)',
  );
  const heal = database.prepare(
    'DELETE FROM calendar_event_exceptions WHERE event_id = ? AND exception_date = ?',
  );
  let changes = 0;
  const budget = { left: healCheckBudget };
  for (const key of keys) changes += insert.run(eventId, key).changes;
  for (const { key, legacy } of pairs) {
    if (key !== legacy && !keys.has(legacy) && healable(series, clock, householdZone, key, legacy, budget)) {
      changes += heal.run(eventId, legacy).changes;
    }
  }
  return changes;
}

/**
 * Darf die alte Zeile `legacy` beim Empfang von `key` fort?
 *
 * Eine alte Zeile verraet nicht, wer sie schrieb: derselbe Tag kann die Absage
 * sein, die der Importer frueher fuer diesen Rohwert ablegte, oder eine lokal
 * ausgenommene Ausnahme eines Nachbarvorkommens (Review zu #2300: New York
 * taeglich 19:30, lokal abgesagt der 13.11. als `2035-11-13`, vom Anbieter
 * abgesagt der 12.11. mit demselben alten Tag). Fort darf sie deshalb nur, wenn
 * sie in der alten Lesart kein anderes Vorkommen der Serie trifft als das, das
 * jetzt unter `key` liegt - dann geht beim Loeschen nichts verloren. Sonst
 * bleibt sie stehen und wirkt wie bisher (Schritt 6 entscheidet). Ebenso, wenn
 * das Budget der Pruefungen (`HEAL_CHECK_BUDGET`) aufgebraucht ist.
 */
function healable(series, clock, householdZone, key, legacy, budget) {
  const own = new Set(clock.dayCandidatesOfKey(key));
  const others = clock.dayCandidatesOfKey(legacy).filter((day) => !own.has(day));
  for (const day of others) {
    if (budget.left <= 0) return false;
    budget.left -= 1;
    let hits;
    try {
      hits = expandRecurringEvents([series], shiftDateKey(day, -1), shiftDateKey(day, 1), null, {
        householdZone, maxIterations: MAX_EXPANSION_ITERATIONS, resumeNear: day,
      });
    } catch {
      return false;
    }
    if (hits.some((instance) => occurrenceSlotOf(instance)?.day === day)) return false;
  }
  return true;
}
