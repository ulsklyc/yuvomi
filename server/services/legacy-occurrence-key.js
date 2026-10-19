/**
 * Modul: Alter Vorkommens-Schluessel (#2034, eingefroren)
 * Zweck: Die Lesart des Schluessels `YYYY-MM-DD`, die bis Schritt 4 des
 *        Zeitzonen-Buendels galt: der UTC-Tag eines Vorkommens, gerechnet ueber
 *        die alte Uhr (`localToUTC`, Offset an der Schein-UTC-Zeit gelesen).
 * Abhaengigkeiten: server/utils/timezone.js (nur lesende Helfer)
 *
 * EINGEFROREN. Alles, was vor Schritt 4 in `calendar_event_exceptions` und
 * `calendar_events.recurrence_id` geschrieben wurde, traegt diese Form, und es
 * gibt keine Migration, die es umschreibt (die kommt mit Schritt 6). Bis dahin
 * bedeutet ein alter Schluessel an einer getimten Serie IMMER das, was er auf
 * main bedeutete - auch dort, wo das falsch war: in der Umstellungsnacht teilen
 * sich zwei Vorkommen denselben Tag (Europe/Berlin 01:30, Start im Sommer:
 * 24. und 25.03.2035 -> `2035-03-24`), und eine alte Ausnahme blendet beide aus.
 *
 * Deshalb ist hier alles eine woertliche Kopie aus calendar-events.js und
 * utils/timezone.js (Stand c5751b3c5), auch die Uhr: wer `localToUTC` dort
 * spaeter verbessert, darf die Bedeutung gespeicherter Daten nicht mitaendern.
 * Nicht anfassen, ausser um einen Fehler zu beheben, der schon auf main falsch
 * GELESEN hat - und dann mit Begruendung und Golden Snapshot
 * (test/test-occurrence-key-legacy.js).
 */

import { hasExplicitZone, storedToInstantIso, utcToWall } from '../utils/timezone.js';

/** Woertlich `wholeSecondMs` aus utils/timezone.js. */
function wholeSecondMs(ms) {
  return Math.floor(ms / 1000) * 1000;
}

/** Woertlich `localToUTC` aus utils/timezone.js (die alte Uhr). */
function frozenLocalToUTC(localStr, tzid) {
  try {
    const fakeUTC = new Date(localStr + 'Z');
    if (isNaN(fakeUTC.getTime())) return localStr;
    const wholeMs = wholeSecondMs(fakeUTC.getTime());
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
    }).formatToParts(new Date(wholeMs));
    const get = (type) => {
      const part = parts.find((p) => p.type === type);
      const v = part ? part.value : '0';
      if (type === 'hour' && v === '24') return 0;
      return parseInt(v, 10);
    };
    const asUTC = Date.UTC(
      get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')
    );
    const offsetMs = wholeMs - asUTC;
    return new Date(fakeUTC.getTime() + offsetMs).toISOString().replace('.000Z', 'Z');
  } catch { return localStr; }
}

/**
 * Die alte Identitaet `utcTagFuer` einer Serie, als Funktion des Schleifentags.
 *
 * Der Schleifentag ist der Tag, auf dem die Expansion laeuft (der Ortstag der
 * Serienzone, wo sie in ihr rechnet, sonst der gespeicherte Tag) - derselbe,
 * den `occurrenceClock()` in calendar-events.js fuehrt. Die Modusfrage ist hier
 * mit eingefroren, damit eine spaetere Aenderung der Expansion die Bedeutung
 * alter Schluessel nicht still verschiebt.
 *
 * @param {object} event          Serienzeile (start_datetime, all_day, tzid)
 * @param {string|null} householdZone  Zone, in der zonenlose Ziffern neben
 *        einer `tzid` gelesen werden (#1993); Pflicht fuer eine solche Zeile
 * @returns {(tag: string) => string}  Schleifentag -> alter Schluessel
 */
export function legacyOccurrenceKeyFor(event, householdZone = null) {
  const isAllDay = !!event.all_day;
  const zonedNaive = !!event.tzid && !isAllDay && !hasExplicitZone(event.start_datetime);
  const startText = zonedNaive
    ? (storedToInstantIso(event.start_datetime, householdZone) ?? event.start_datetime)
    : event.start_datetime;
  const wall = (event.tzid && !isAllDay) ? utcToWall(startText, event.tzid) : null;
  const tzAware = wall && wall.date === startText.slice(0, 10);
  const zonenUnsicher = !!event.tzid && !tzAware;
  const lokalRechnen = zonenUnsicher && !!wall && !isAllDay;
  // Woertlich `utcTagFuer` aus `expandRecurringEvents` (Stand c5751b3c5).
  return (tag) => (lokalRechnen
    ? String(frozenLocalToUTC(`${tag}T${wall.time}`, event.tzid)).slice(0, 10)
    : tag);
}
