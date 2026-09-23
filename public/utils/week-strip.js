/**
 * Modul: Wochenstreifen (Dashboard, Kalender-Widget in 2x1)
 * Zweck: Aus einer Terminliste das Modell von sieben Tagen ab heute machen -
 *        je Tag die Punkte der Zeittermine, dazu die Baender der ganztaegigen
 *        und mehrtaegigen Termine mit ihrer Spur. Rein: kein DOM, kein t(),
 *        damit die Tageszuordnung ohne Browser pruefbar ist.
 * Abhaengigkeiten: ./timezone.js, ./event-color.js
 * Guards: test/test-dashboard-week.js
 *
 * DER TAG KOMMT AUS DER ANZEIGEZONE, nie aus dem Geraet. In `start_datetime`
 * liegen zwei Formen in einer Spalte (zonenlose Wanduhrzeit und Instants mit
 * Zone, siehe utils/timezone.js); `zonedFields` liest die erste und rechnet die
 * zweite um. Ein Umweg ueber `new Date()` und `getDate()` haette einen
 * synchronisierten Termin um 23:30 Haushaltszeit auf dem Telefon eines
 * Reisenden auf den Folgetag gelegt - der Fehler, den `eventOccurrenceDateKey`
 * in pages/dashboard.js bis zu diesem Streifen hatte.
 *
 * DIE REGELN FUER „WELCHE TAGE BELEGT EIN TERMIN" SIND DIE DES KALENDERS
 * (pages/calendar.js: eventEndDate, isAllDayLike, spansFullDayOrLonger), hier
 * nachgebaut statt importiert, weil jene Datei eine ganze Seite ist. Wer dort
 * eine Regel aendert, prueft sie hier:
 *   - ganztaegig speichert sein Ende INKLUSIV (Reise 07.-09.09. endet
 *     '2026-09-09T00:00'),
 *   - ein Zeittermin, der exakt um Mitternacht endet, belegt den Folgetag
 *     nicht (#804),
 *   - ein Band wird ein Termin erst ab 24 Stunden ueber mehrere Tage; ein
 *     kurzer Nachttermin ist an beiden Tagen ein Punkt (#1313).
 */

import { zonedFields, displayTimeZone } from './timezone.js';
import { resolveEventColor } from './event-color.js';

export const WEEK_STRIP_DAYS = 7;
export const WEEK_STRIP_MAX_DOTS = 6;
export const WEEK_STRIP_MAX_LANES = 2;

const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' -> ms der UTC-Mitternacht; reine Feldarithmetik, kein Zeitpunkt. */
function keyMs(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

function shiftKey(key, days) {
  const ms = keyMs(key);
  if (!Number.isFinite(ms)) return key;
  const d = new Date(ms + days * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function daysBetween(a, b) {
  return Math.round((keyMs(b) - keyMs(a)) / DAY_MS);
}

/** Tag und Minute eines gespeicherten Werts in der Anzeigezone. */
function wall(value, timeZone) {
  const f = zonedFields(value, timeZone);
  if (!f) return null;
  return { key: `${f.year}-${pad2(f.month)}-${pad2(f.day)}`, minutes: f.hour * 60 + f.minute };
}

/**
 * Welche Tage belegt ein Termin, und ist er ein Band?
 * @returns {{startKey:string,endKey:string,band:boolean,startMinutes:number}|null}
 */
export function eventDaySpan(event, timeZone = displayTimeZone()) {
  const startRaw = String(event?.start_datetime ?? '');
  if (!startRaw) return null;
  const allDay = Boolean(event.all_day) || !startRaw.includes('T');
  const endRaw = event.end_datetime ? String(event.end_datetime) : '';

  if (allDay) {
    // Ganztaegig ist ein Kalendertag, kein Zeitpunkt: gelesen wird das Datum,
    // nie umgerechnet - auch dann nicht, wenn ein Import es mit 'T00:00Z'
    // gespeichert hat.
    const startKey = startRaw.slice(0, 10);
    const endCandidate = endRaw ? endRaw.slice(0, 10) : startKey;
    const endKey = endCandidate > startKey ? endCandidate : startKey;
    if (!Number.isFinite(keyMs(startKey))) return null;
    return { startKey, endKey, band: true, startMinutes: -1 };
  }

  const start = wall(startRaw, timeZone);
  if (!start) return null;
  const end = endRaw ? wall(endRaw, timeZone) : null;
  let endKey = start.key;
  if (end && end.key > start.key) {
    endKey = end.minutes === 0 ? shiftKey(end.key, -1) : end.key;
    if (endKey < start.key) endKey = start.key;
  }
  const spanMinutes = end
    ? daysBetween(start.key, end.key) * 1440 + end.minutes - start.minutes
    : 0;
  const band = endKey !== start.key && spanMinutes >= 1440;
  return { startKey: start.key, endKey, band, startMinutes: start.minutes };
}

/**
 * Das Modell des Streifens.
 *
 * @param {object[]} events   serialisierte Termine (auch expandierte Vorkommen)
 * @param {string}   fromKey  der erste Tag, 'YYYY-MM-DD' - „heute" des Haushalts
 * @param {object}   [opts]
 * @param {number}   [opts.days=7]
 * @param {number}   [opts.maxDots=6]   Punkte je Tag, der Rest zaehlt als `more`
 * @param {number}   [opts.maxLanes=2]  Spuren fuer Baender, der Rest zaehlt als `more`
 * @param {string|null} [opts.timeZone] Anzeigezone; Standard wie ueberall
 * @returns {{
 *   days: {key:string,index:number,isToday:boolean,weekday:number,dayOfMonth:number,
 *          dots:{id:*,color:string,title:string}[],more:number,count:number,titles:string[]}[],
 *   bands: {id:*,color:string,title:string,startIndex:number,endIndex:number,
 *           continuesBefore:boolean,continuesAfter:boolean,lane:number}[],
 *   laneCount:number
 * }}
 */
export function buildWeekStrip(events, fromKey, {
  days = WEEK_STRIP_DAYS,
  maxDots = WEEK_STRIP_MAX_DOTS,
  maxLanes = WEEK_STRIP_MAX_LANES,
  timeZone = displayTimeZone(),
} = {}) {
  const dayList = Array.from({ length: days }, (_, index) => {
    const key = shiftKey(fromKey, index);
    const ms = keyMs(key);
    return {
      key,
      index,
      isToday: index === 0,
      weekday: new Date(ms).getUTCDay(),
      dayOfMonth: new Date(ms).getUTCDate(),
      dots: [],
      more: 0,
      count: 0,
      titles: [],
    };
  });
  const lastKey = dayList[dayList.length - 1]?.key ?? fromKey;

  const timed = [];
  const bandCandidates = [];
  for (const event of Array.isArray(events) ? events : []) {
    const span = eventDaySpan(event, timeZone);
    if (!span || span.endKey < fromKey || span.startKey > lastKey) continue;
    const first = Math.max(0, daysBetween(fromKey, span.startKey));
    const last = Math.min(days - 1, daysBetween(fromKey, span.endKey));
    const entry = {
      id: event.id,
      color: resolveEventColor(event),
      title: String(event.title ?? ''),
      first,
      last,
      startMinutes: span.startMinutes,
      startKey: span.startKey,
      endKey: span.endKey,
    };
    for (let i = first; i <= last; i++) {
      dayList[i].count++;
      if (entry.title) dayList[i].titles.push(entry.title);
    }
    (span.band ? bandCandidates : timed).push(entry);
  }

  // Punkte: in zeitlicher Reihenfolge, je Tag gedeckelt.
  timed.sort((a, b) => a.startKey.localeCompare(b.startKey) || a.startMinutes - b.startMinutes);
  for (const entry of timed) {
    for (let i = entry.first; i <= entry.last; i++) {
      const day = dayList[i];
      if (day.dots.length < maxDots) day.dots.push({ id: entry.id, color: entry.color, title: entry.title });
      else day.more++;
    }
  }

  // Baender: das frueheste und bei Gleichstand das laengste zuerst in die
  // niedrigste freie Spur - dieselbe Packung wie die Ganztagszeile im Kalender.
  bandCandidates.sort((a, b) => a.first - b.first || (b.last - b.first) - (a.last - a.first));
  const laneEnds = [];
  const bands = [];
  for (const entry of bandCandidates) {
    let lane = laneEnds.findIndex((end) => end < entry.first);
    if (lane === -1 && laneEnds.length < maxLanes) lane = laneEnds.length;
    if (lane === -1) {
      for (let i = entry.first; i <= entry.last; i++) dayList[i].more++;
      continue;
    }
    laneEnds[lane] = entry.last;
    bands.push({
      id: entry.id,
      color: entry.color,
      title: entry.title,
      startIndex: entry.first,
      endIndex: entry.last,
      continuesBefore: entry.startKey < fromKey,
      continuesAfter: entry.endKey > lastKey,
      lane,
    });
  }

  return { days: dayList, bands, laneCount: laneEnds.length };
}
