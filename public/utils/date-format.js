/**
 * Modul: Datums- und Zeitschreibweise (R23, D11)
 * Zweck: EINE Stelle, die sagt, wie die App ein Datum, eine Uhrzeit, eine
 *        Zeitspanne, einen Abstand und einen Anteil hinschreibt.
 * Abhaengigkeiten: i18n.js, utils/timezone.js, utils/countdown.js
 *
 * WARUM EINE DATEI. Die Critique vom 24.10.2026 (Q5) fand dieselbe Auskunft in
 * fuenf Schreibweisen: der Schichtplan schrieb "06:00-14:00" roh in 24 Stunden,
 * auch wer 12 Stunden eingestellt hat; die Entsorgung "6 Tage" wie eine Dauer,
 * die Geburtstage "in 6 Tagen"; das Budget "19.10." neben "25.10.2026"; der
 * Wochenplan das Jahr an beiden Enden; das Abo einen Prozentwert von Hand.
 * Jede dieser Stellen hatte fuer sich einen Grund - zusammen sprach die App
 * fuenf Dialekte. Die Regeln stehen jetzt hier, und die Module fragen sie.
 *
 * DIE REGELN
 *   - Uhrzeit: `formatTime` der i18n (12-/24-Stunden-Einstellung, Ziffern der
 *     Sprache). Das Zeitwort ("Uhr") steht EINMAL am Ende, nie im
 *     12-Stunden-Format (`timeSuffix`).
 *   - Spanne: "06:00 - 14:00" ueber `calendar.dayRangeLabel` (Trenner der
 *     Sprache), eine Schicht ueber Mitternacht mit "+1".
 *   - Datum: kurzer Wochentag auf Wunsch, Tag und Monat in der Schreibweise
 *     der Region, das JAHR NUR AUSSERHALB DES LAUFENDEN - "Sa., 24.10.", aber
 *     "Fr., 08.01.2027".
 *   - Zeitraum: das Jahr hoechstens einmal, am Ende ("19.10. - 25.10."; ueber
 *     den Jahreswechsel an beiden Enden).
 *   - Abstand: "Heute", "Morgen", "Gestern", sonst "in 6 Tagen" / "vor 3
 *     Tagen" (Intl.RelativeTimeFormat der Sprache), ab 31 Tagen in Wochen,
 *     Monaten, Jahren - dieselben Schwellen wie der Countdown (#647).
 *   - Anteil: Intl mit `style: 'percent'` der Region ("53 %", "53%").
 *
 * ZONE. "Heute" ist `todayKey()` der HAUSHALTSZONE (utils/timezone.js), nie
 * der Browserzone. Ein Datums-Key ('2026-10-24') wird GELESEN, ein Zeitpunkt
 * ('2026-10-24T22:30:00Z') in die Anzeigezone UMGERECHNET (`zonedDateKey`).
 * Gerechnet wird nur auf Keys (Date.UTC ueber Jahr/Monat/Tag), der Wochentag
 * kommt aus dem UTC-Mittag des Keys mit `timeZone: 'UTC'` - nichts hier liest
 * die Browser-Getter eines Datums (Guard in test:display-timezone).
 *
 * Browser-absolute Importe wie day-label.js: unter test-browser-loader.mjs
 * bekommt diese Datei denselben i18n-Stub wie die Seite, die sie ruft;
 * test:date-format bildet die Pfade selbst auf public/ ab und faehrt das
 * Original.
 */

import {
  t, getLocale, getNumberFormat, formatDate, formatDayMonth, formatTime, timeSuffix,
} from '/i18n.js';
import { todayKey as householdToday, zonedDateKey } from '/utils/timezone.js';
import { daysBetweenDateKeys, COUNTDOWN_EXACT_DAYS, COUNTDOWN_WEEKS_UNTIL, COUNTDOWN_MONTHS_UNTIL } from '/utils/countdown.js';

const KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Der Kalendertag eines Wertes: ein Key bleibt, ein Zeitpunkt wird umgerechnet. */
function dayKeyOf(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string' && KEY.test(value)) return value;
  return zonedDateKey(value);
}

function noonUtc(key) {
  const m = KEY.exec(key);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)) : null;
}

// ---------------------------------------------------------------- Uhrzeit

/** Haengt das Zeitwort der Sprache an ("Uhr"), im 12-Stunden-Format nichts. */
export function withTimeSuffix(text) {
  return `${text} ${timeSuffix()}`.trimEnd();
}

/**
 * Eine Uhrzeit in der Einstellung des Nutzers. Nimmt einen Zeitpunkt, eine
 * zonenlose Wanduhr ('2026-10-24T09:00') oder eine reine Uhrzeit ('09:00').
 * `suffix: false` ist die Rasterfassung ohne "Uhr".
 */
export function clockText(value, { suffix = true } = {}) {
  const time = formatTime(value);
  if (!time) return '';
  return suffix ? withTimeSuffix(time) : time;
}

/**
 * Von-bis: "10:00 - 11:30 Uhr", das Zeitwort einmal am Ende. Ohne Ende die
 * Anfangszeit allein; ein Ende gleich dem Anfang zaehlt als keines.
 */
export function timeSpanText(start, end, { suffix = true } = {}) {
  if (!end || end === start) return clockText(start, { suffix });
  const span = t('calendar.dayRangeLabel', { from: formatTime(start), to: formatTime(end) });
  return suffix ? withTimeSuffix(span) : span;
}

/**
 * Die Spanne einer Schichtart ({start_time, end_time} als 'HH:MM'):
 * "22:00 - 06:00 +1" ueber Mitternacht, "06:00 - 06:00 · 24 h" rund um die
 * Uhr, '' ohne Zeiten (ganztaegig - den Wortlaut waehlt der Aufrufer).
 */
export function shiftTimeText(type, { suffix = false } = {}) {
  if (!type?.start_time || !type?.end_time) return '';
  const fullDay = type.end_time === type.start_time;
  const crossesDay = type.end_time < type.start_time;
  const span = withOptionalSuffix(
    t('calendar.dayRangeLabel', { from: formatTime(type.start_time), to: formatTime(type.end_time) }),
    suffix,
  );
  return span + (crossesDay || fullDay ? ' +1' : '') + (fullDay ? ' · 24 h' : '');
}

function withOptionalSuffix(text, suffix) {
  return suffix ? withTimeSuffix(text) : text;
}

// ---------------------------------------------------------------- Datum

/** Der kurze Wochentag eines Tages in der App-Sprache ("Sa."). */
export function weekdayShort(value) {
  const noon = noonUtc(dayKeyOf(value));
  if (!noon) return '';
  return new Intl.DateTimeFormat(getLocale(), { weekday: 'short', timeZone: 'UTC' }).format(noon);
}

/**
 * Ein Tag als Datum: "24.10." im laufenden Jahr, "08.01.2027" ausserhalb,
 * mit `weekday: true` davor der kurze Wochentag ("Sa., 24.10.").
 * Reihenfolge und Trenner folgen der Datumsformat-Einstellung der Region.
 * `year: true` erzwingt das Jahr (Felder, deren Aussage das Jahr ist).
 */
export function dateText(value, { weekday = false, year = false, today = householdToday() } = {}) {
  const key = dayKeyOf(value);
  if (!key) return value ? formatDate(value) : '';
  const showYear = year || key.slice(0, 4) !== String(today).slice(0, 4);
  const date = showYear ? formatDate(key) : formatDayMonth(key);
  return weekday ? `${weekdayShort(key)}, ${date}` : date;
}

/**
 * Ein Zeitraum zweier Tage: das Jahr hoechstens einmal. "19.10. - 25.10." im
 * laufenden Jahr, "19.10.2027 - 25.10.2027" -> "19.10. - 25.10.2027" in einem
 * anderen, "28.12.2026 - 03.01.2027" ueber den Jahreswechsel.
 */
export function dateRangeText(from, to, { today = householdToday() } = {}) {
  const a = dayKeyOf(from);
  const b = dayKeyOf(to);
  if (!a || !b) return dateText(a || b, { today });
  if (a === b) return dateText(a, { today });
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  const current = String(today).slice(0, 4);
  let left;
  let right;
  if (sameYear && a.slice(0, 4) === current) {
    left = formatDayMonth(a);
    right = formatDayMonth(b);
  } else if (sameYear) {
    left = formatDayMonth(a);
    right = formatDate(b);
  } else {
    left = formatDate(a);
    right = formatDate(b);
  }
  return t('calendar.dayRangeLabel', { from: left, to: right });
}

// ---------------------------------------------------------------- Abstand

/**
 * Die Zahl eines RelativeTimeFormat-Ergebnisses in den Ziffern der REGION -
 * wie `formatUnit` in i18n.js: das Wort gehoert der Sprache, die Zahl dem
 * Haushalt.
 */
function relativeUnit(value, unit) {
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'always' });
  const parts = rtf.formatToParts(value, unit);
  const number = getNumberFormat({ maximumFractionDigits: 0 }).format(Math.abs(value));
  let replaced = false;
  return parts.map((part) => {
    if (part.type === 'literal') return part.value;
    if (replaced) return '';
    replaced = true;
    return number;
  }).join('');
}

/**
 * Wie weit ein Tag von heute weg ist, in Worten: "Heute", "Morgen", "Gestern",
 * sonst "in 6 Tagen" / "vor 3 Tagen"; ab 31 Tagen "in 5 Wochen", ab 61
 * "in 3 Monaten", ab 365 "in 2 Jahren".
 */
export function relativeDayText(value, { today = householdToday() } = {}) {
  const key = dayKeyOf(value);
  const days = key ? daysBetweenDateKeys(today, key) : null;
  return days === null ? '' : daysFromTodayText(days);
}

/**
 * Dasselbe fuer eine schon gezaehlte Tagesdifferenz - fuer Antworten, in denen
 * der Server den Abstand auf dem Tag der Haushaltszone mitliefert
 * (`days_until` der Geburtstage).
 */
export function daysFromTodayText(value) {
  if (value === null || value === undefined || value === '') return '';
  const days = Math.trunc(Number(value));
  if (!Number.isFinite(days)) return '';
  if (days === 0) return t('common.today');
  if (days === 1) return t('common.tomorrow');
  if (days === -1) return t('common.yesterday');
  const sign = days < 0 ? -1 : 1;
  const abs = Math.abs(days);
  if (abs <= COUNTDOWN_EXACT_DAYS) return relativeUnit(days, 'day');
  if (abs <= COUNTDOWN_WEEKS_UNTIL) return relativeUnit(sign * Math.round(abs / 7), 'week');
  if (abs <= COUNTDOWN_MONTHS_UNTIL) return relativeUnit(sign * Math.round(abs / 30.44), 'month');
  return relativeUnit(sign * Math.max(1, Math.round(abs / 365.25)), 'year');
}

/**
 * Datum und Abstand in einer Zeile: "Fr., 30.10. · in 6 Tagen". Heute und
 * morgen sagen beide Haelften dasselbe - dann steht das Wort allein da.
 * Vergangenes traegt keinen Abstand, wenn `past: false`.
 */
export function dateWithDistanceText(value, { today = householdToday(), weekday = true, past = true } = {}) {
  const key = dayKeyOf(value);
  if (!key) return '';
  const days = daysBetweenDateKeys(today, key);
  if (days === 0 || days === 1) return relativeDayText(key, { today });
  // Jede Haelfte bricht nicht in sich ("Fr., 30.10. · in | 6 Tagen" stand
  // mobil so da), umbrechen darf die Zeile nur am Trenner.
  const date = unbreakable(dateText(key, { weekday, today }));
  if (days === null || (days < 0 && !past)) return date;
  return `${date} · ${unbreakable(relativeDayText(key, { today }))}`;
}

function unbreakable(text) {
  return String(text).replace(/ /g, '\u00a0');
}

// ---------------------------------------------------------------- Anteil

/**
 * Ein Anteil in der Schreibweise der Region. `value` ist ein Prozentwert
 * (53 fuer 53 %), mit `ratio: true` ein Bruch (0.53). Ganze Prozent, bis
 * `maximumFractionDigits` es anders will.
 */
export function percentText(value, { ratio = false, maximumFractionDigits = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return getNumberFormat({ style: 'percent', maximumFractionDigits }).format(ratio ? n : n / 100);
}
