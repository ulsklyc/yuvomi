/**
 * Modul: Schichtplan-ICS-Export
 * Zweck: Eigenstaendiger, schreibgeschuetzter iCalendar-Feed der EIGENEN
 *        aufgeloesten Schichtplan-Eintraege - "meine Schichten in meinem
 *        Kalender", nicht der ganze Haushalt (anders als der Inventar-Fristen-
 *        Feed, der haushaltweiten Inhalt hinter einem persoenlichen Token
 *        ausliefert: Inventar hat keinen Eigentuemer, ein Schichtplan schon).
 *        Token liegt pro Nutzer auf der users-Zeile, gleiches Muster wie
 *        calendar_feed_token (Migration 61) und
 *        inventory_deadlines_feed_token (Migration 144).
 */

import { randomBytes } from 'node:crypto';
import { createLogger } from '../logger.js';
import { escapeICSText, foldLine, resolveFeedZone, stampProp } from './ics-export.js';
import { scheduleData } from './schedule.js';
import { todayKey, shiftDateKey, householdTimeZone } from '../utils/timezone.js';
import { vtimezoneFor } from '../utils/vtimezone.js';

const log = createLogger('ScheduleICS');

// Rueckblickend genug, um kuerzlich vergangene Schichten im abonnierten
// Kalender nicht sofort verschwinden zu lassen; vorausschauend genug fuer ein
// Jahr Vorlauf bei Mustern mit langem Zyklus. 395 Tage bleiben klar unter dem
// 731-Tage-Deckel von /entries - der gilt fuer den worst case ueber ALLE
// Haushaltsmitglieder auf einmal, hier ist es eine Person und ein fester
// Ausschnitt, kein Nutzereingang.
const FEED_PAST_DAYS = 30;
const FEED_FUTURE_DAYS = 365;

function formatUTCStamp(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
         `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
}

function formatDateValue(dateKey) {
  return dateKey.replace(/-/g, '');
}

// Note plus jedes ueberlagerungssichtbare eigene Feld mit einem Wert
// (Migration 189) - dieselbe Berechnung wie schedule.js' overlayMeta() und
// calendar.js' scheduleOverlayMeta(), hier eigenstaendig nachgebaut statt
// importiert (server- vs. clientseitig, kein gemeinsames Modul).
function overlayMeta(entry) {
  const overlayFields = (entry.shift_type?.fields ?? []).filter((field) => field.show_in_overlay && entry.field_values?.[field.id]);
  return [entry.note, ...overlayFields.map((field) => `${field.name}: ${entry.field_values[field.id]}`)].filter(Boolean).join(' · ');
}

function buildVEvent(entry, dtstamp, feedZone) {
  const type = entry.shift_type;
  const summary = type.short_code ? `${type.short_code} · ${type.name}` : type.name;
  const lines = [
    'BEGIN:VEVENT',
    // Ein Override bleibt bei hoechstens einem Eintrag je (Nutzer, Tag), der
    // UID braucht dort nichts weiter. Ein Extra steht NEBEN dem primaeren
    // Eintrag, auch mehrfach am selben Tag, und ein Musterzyklus-Tag kann
    // selbst mehrere Klassen tragen (Stundenplan) - in beiden Faellen traegt
    // die UID die jeweils eigene, stabile Id (extra_id bzw. pattern_day_id).
    // Ohne das traegen zwei VEVENTs desselben Tages dieselbe UID, und ein
    // Kalender-Client (Google/Apple/Outlook) dedupliziert per RFC 5545
    // danach: eine der beiden Schichten verschwaende beim Abonnenten spurlos.
    `UID:schedule-entry-${entry.user_id}-${entry.date_key}${entry.source === 'extra' ? `-extra-${entry.extra_id}` : entry.source === 'pattern' ? `-pattern-${entry.pattern_day_id}` : ''}@yuvomi`,
    `DTSTAMP:${dtstamp}`,
  ];
  // Ein Schichttyp ohne Zeiten (z.B. Urlaub, Krank) ist ein GANZTAGS-Eintrag,
  // dieselbe Regel wie clockLabel() im Client (public/pages/schedule.js) fuer
  // "ganztaegig" liest. `crosses_midnight` (server/services/schedule.js,
  // scheduleData) sagt bereits, ob eine Nachtschicht ueber Mitternacht reicht;
  // die endet dann am naechsten Tag, nicht am selben.
  if (!type.start_time || !type.end_time) {
    lines.push(
      `DTSTART;VALUE=DATE:${formatDateValue(entry.date_key)}`,
      `DTEND;VALUE=DATE:${formatDateValue(shiftDateKeyUTC(entry.date_key, 1))}`,
    );
  } else {
    // Naiv wie jede Wanduhrzeit im Modul (Migration 181ff.) - ohne Verankerung
    // legen Google/Apple/Thunderbird/Outlook/Home Assistant sie in der Praxis
    // auf UTC (#818, ics-export.js): eine 16:00-Schicht in Madrid erschiene um
    // 18:00, sofort, im eigenen Kalender. stampProp() verankert an feedZone
    // (bzw. haengt ein 'Z' an, wenn die Haushaltszone UTC-gleich ist).
    const endDate = entry.crosses_midnight ? shiftDateKeyUTC(entry.date_key, 1) : entry.date_key;
    lines.push(
      stampProp('DTSTART', `${entry.date_key}T${type.start_time}`, feedZone),
      stampProp('DTEND', `${endDate}T${type.end_time}`, feedZone),
    );
  }
  lines.push(`SUMMARY:${escapeICSText(summary)}`);
  const description = overlayMeta(entry);
  if (description) lines.push(`DESCRIPTION:${escapeICSText(description)}`);
  lines.push('END:VEVENT');
  return lines.map(foldLine);
}

// Lokale, zonlose Tagesarithmetik fuer ICS-Datumswerte - dieselbe Reihe wie
// shiftDateKey() aus utils/timezone.js, nur ohne die Zeitzonen-Anbindung
// dieser Datei zu importieren: ein reiner Kalendertag-Schritt braucht sie
// nicht, und ein zweiter Import derselben Sache waere eine zweite Wahrheit.
function shiftDateKeyUTC(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function buildScheduleFeed(conn, userId, now = new Date()) {
  const today = todayKey(conn);
  const from = shiftDateKey(today, -FEED_PAST_DAYS);
  const to = shiftDateKey(today, FEED_FUTURE_DAYS);
  const { entries } = scheduleData(from, to, userId);
  const timedEntries = entries.filter((entry) => entry.shift_type && entry.shift_type.start_time && entry.shift_type.end_time);

  // Gleiche Verankerung wie der Kalender-Feed (#818, ics-export.js): naive
  // Wanduhrzeit bekommt die Haushaltszone statt floating/UTC-per-Client-Rauten.
  const feedZone = resolveFeedZone(householdTimeZone(conn));

  const dtstamp = formatUTCStamp(now);
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Yuvomi//Schedule Feed//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Yuvomi Schedule',
  ];
  if (feedZone) out.push(`X-WR-TIMEZONE:${feedZone}`);
  // Genau ein VTIMEZONE fuer die Feed-Zone (RFC 5545: vor den VEVENTs), nur
  // wenn ueberhaupt ein zeitgebundener Eintrag im Fenster liegt.
  if (feedZone && timedEntries.length) {
    out.push(...vtimezoneFor(feedZone, now.getUTCFullYear()).map(foldLine));
  }
  // Freie Tage bleiben aussen vor - ein Feed voller "nichts los" waere Rauschen
  // im abonnierten Kalender, den Zweck (die Schichten sehen) verfehlte er.
  for (const entry of entries) {
    if (!entry.shift_type) continue;
    out.push(...buildVEvent(entry, dtstamp, feedZone));
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

function getFeedToken(conn, userId) {
  const row = conn.prepare('SELECT schedule_feed_token AS t FROM users WHERE id = ?').get(userId);
  return row?.t ?? null;
}

function regenerateFeedToken(conn, userId) {
  const token = randomBytes(32).toString('base64url');
  conn.prepare('UPDATE users SET schedule_feed_token = ? WHERE id = ?').run(token, userId);
  return token;
}

function clearFeedToken(conn, userId) {
  conn.prepare('UPDATE users SET schedule_feed_token = NULL WHERE id = ?').run(userId);
}

// Loest das Token auf seinen Besitzer auf: der Inhalt IST bereits an die
// Person gebunden (anders als beim Inventar-Feed), das Aufloesen entscheidet
// hier also gleich zweifach - Zugang UND Umfang.
function findUserIdByFeedToken(conn, token) {
  if (!token) return null;
  const row = conn.prepare('SELECT id FROM users WHERE schedule_feed_token = ?').get(token);
  return row?.id ?? null;
}

export {
  buildScheduleFeed,
  getFeedToken, regenerateFeedToken, clearFeedToken, findUserIdByFeedToken,
};
