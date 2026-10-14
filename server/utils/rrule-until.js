/**
 * Modul: Serienende fuer den ausgehenden Weg
 * Zweck: Macht aus einem reinen Datum als UNTIL das Ende dieses Ortstags als
 *        UTC-Zeitpunkt - fuer jeden Empfaenger, der an einer getimten Serie
 *        einen Zeitpunkt verlangt.
 * Abhaengigkeiten: server/utils/timezone.js
 *
 * EIN REINES DATUM IST DIE KANONISCHE FORM (#1974). Yuvomi liest
 * `UNTIL=20351010` als Tag: das letzte Vorkommen ist das am 10. Oktober, in der
 * Zone, in der die Serie expandiert wird. So schreibt es das Formular
 * (`public/rrule-ui.js`), so schreibt es der Serienschnitt
 * (`calendar-occurrence-overrides.js`, der Vortag).
 *
 * Die Empfaenger lesen es nicht so. RFC 5545 §3.3.10 verlangt, dass UNTIL den
 * Werttyp von DTSTART hat: an einem DTSTART mit Zone ein Zeitpunkt in UTC. Ein
 * Datum dort ist ein ungueltiges Objekt, und das Formular schrieb deshalb bis
 * hierher selbst `T235959Z` - das Ende des UTC-Tags, nicht des Ortstags.
 * Oestlich von UTC zeigte der Empfaenger damit ein Vorkommen mehr (00:30 am 11.
 * in Berlin ist 22:30Z am 10.), westlich eines weniger.
 *
 * Also wird erst beim Hinausgehen umgerechnet, je Empfaenger in der Zone, in der
 * er die Vorkommen rechnet: bei Google die mitgesendete `timeZone`
 * (google-calendar.js), bei CalDAV, iCloud und dem ICS-Feed die TZID des
 * DTSTART - oder UTC, wenn DTSTART selbst in UTC steht.
 */

import { localToUTCPrecise, shiftDateKey, utcToWall } from './timezone.js';

/**
 * Das Ende des Ortstags `YYYYMMDD` in `timeZone` als `YYYYMMDDTHHMMSSZ`.
 * Ohne lesbares Datum oder Zone bleibt es beim Tagesende in UTC.
 *
 * DER ERSTE AUGENBLICK DES FOLGETAGS. Wird die Uhr kurz nach Mitternacht
 * zurueckgestellt, gibt es die erste Stunde des Folgetags zweimal (Asia/Amman,
 * 29.10.2021: 00:59 +03 -> 00:00 +02). `localToUTCPrecise` nennt fuer "00:00"
 * den spaeteren der beiden Zeitpunkte, und eine Grenze davor liesse den
 * Empfaenger das Vorkommen um 00:30 des ersten Durchgangs noch zeigen (RFC 5545
 * meint bei einer doppelten Ortszeit den ersten). Deshalb wird von dort
 * minutenweise zurueckgegangen, solange die Wanduhr noch den Folgetag zeigt -
 * hoechstens drei Stunden, weiter reicht keine Zeitumstellung.
 */
export function localDayEndUtc(datePart, timeZone) {
  const fallback = `${datePart}T235959Z`;
  if (!/^\d{8}$/.test(datePart) || !timeZone) return fallback;
  const dayKey = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
  const nextDay = shiftDateKey(dayKey, 1);
  let nextDayStartMs = Date.parse(localToUTCPrecise(`${nextDay}T00:00:00`, timeZone));
  if (!Number.isFinite(nextDayStartMs)) return fallback;
  for (let step = 0; step < 180; step++) {
    const earlier = utcToWall(new Date(nextDayStartMs - 60000).toISOString(), timeZone);
    if (!earlier || earlier.date < nextDay) break;
    nextDayStartMs -= 60000;
  }
  return utcStamp(nextDayStartMs - 1000);
}

/** ms seit Epoch -> `YYYYMMDDTHHMMSSZ`. */
export function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Die Regel einer GETIMTEN Serie mit dem reinen Datum als UNTIL in UTC
 * umgerechnet - Ende des Ortstags in `zone`, ohne Zone in UTC.
 *
 * Alles andere bleibt Zeichen fuer Zeichen stehen, auch das `RRULE:`-Praefix:
 * eine eingelesene Regel geht Wort fuer Wort zurueck (#756), und ein UNTIL mit
 * Uhrzeit hat sein Empfaenger selbst so geschrieben.
 *
 * @param {string} rule   Regel mit oder ohne `RRULE:`
 * @param {string|null} zone  IANA-Zone, in der der Empfaenger die Vorkommen rechnet
 * @returns {string}
 */
export function timedSeriesUntil(rule, zone) {
  const text = String(rule ?? '');
  const prefix = /^RRULE:/i.exec(text)?.[0] ?? '';
  const body = text.slice(prefix.length);
  let changed = false;
  const parts = body.split(';').map((segment) => {
    const m = /^(\s*UNTIL\s*=\s*)(\d{8})\s*$/i.exec(segment);
    if (!m) return segment;
    changed = true;
    return `${m[1]}${localDayEndUtc(m[2], zone)}`;
  });
  return changed ? `${prefix}${parts.join(';')}` : text;
}
