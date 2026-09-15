/**
 * Modul: Zyklus-ICS-Export
 * Zweck: Eigenständiger, schreibgeschützter iCalendar-Feed aus den geloggten
 *        und vorhergesagten Perioden/Eisprüngen EINES Nutzers - Lock-Screen-/
 *        Kalender-App-Sichtbarkeit ohne native App, derselbe Trick wie der
 *        Haushaltskalender-Feed (server/services/ics-export.js) und der
 *        Inventar-Fristen-Feed (server/services/inventory-deadlines-ics.js),
 *        von denen dieses Modul Muster übernimmt: escapeICSText/foldLine von
 *        dort, das Token-auf-users-Zeile-Muster von beiden.
 *
 * ANDERS ALS DER INVENTAR-FEED: dessen Inhalt ist haushaltweit (Gegenstände
 * haben keinen Eigentümer), nur das Token ist personengebunden. Zyklusdaten
 * SIND personengebunden (cycle_periods.user_id) - der Feed-Inhalt filtert
 * entsprechend auf genau den Token-Besitzer, keine Haushalts-Aggregation.
 * Das hält Zyklusdaten aus dem Betreuungs-Freigabe-System heraus, wie es
 * schon der Rest des Moduls tut (#584) - eine Freigabe bliebe `visibility:
 * 'family'`, nicht ein Feed-Abo für eine andere Person.
 *
 * Vorhersage-Mathematik kommt aus public/utils/health-cycle.js (dieselbe
 * Quelle wie der Zyklus-Tab selbst und server/services/cycle-reminders.js) -
 * kein zweites Rechenmodell hier.
 */

import { randomBytes } from 'node:crypto';
import { resolveHouseholdFormats, translate } from '../utils/i18n.js';
import { escapeICSText, foldLine } from './ics-export.js';
import { projectFutureCycles, suppressesFertility } from '../../public/utils/health-cycle.js';
import { todayKey } from '../utils/timezone.js';

function pad(n) { return String(n).padStart(2, '0'); }

function formatUTCStamp(now) {
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
         `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
}

function formatDateValue(dateKey) {
  return dateKey.replace(/-/g, '');
}

// Wie inventory-deadlines-ics.js#addDaysDateKey: DTEND ist exklusiv (RFC 5545),
// ein eigenständiger Ein-Zeilen-Helfer statt eines Imports aus date.js - dieses
// Modul braucht sonst keine weitere Datumsarithmetik aus health-cycle.js.
function addDaysDateKey(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function buildSpanVEvent({ uid, start, end, summary }, dtstamp) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}@yuvomi`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${formatDateValue(start)}`,
    `DTEND;VALUE=DATE:${addDaysDateKey(end, 1)}`,
    `SUMMARY:${escapeICSText(summary)}`,
    'END:VEVENT',
  ];
  return lines.map(foldLine);
}

function buildDayVEvent({ uid, date, summary }, dtstamp) {
  return buildSpanVEvent({ uid, start: date, end: date, summary }, dtstamp);
}

/**
 * Baut den VCALENDAR-Text für einen Nutzer: alle geloggten Perioden (echte
 * Zeilen, stabile UID über die DB-Id) plus - sofern nicht schwanger und genug
 * Historie für eine Prognose - bis zu drei vorhergesagte Folgezyklen
 * (Periode, und bei aktivierter Fruchtbarkeitsverfolgung auch Eisprung/
 * fruchtbares Fenster), klar als "vorhergesagt" beschriftet. Die UID
 * vorhergesagter Termine ist aus Nutzer+Startdatum abgeleitet (kein DB-Row),
 * bleibt also stabil, solange sich die Prognose nicht verschiebt.
 *
 * @param {import('better-sqlite3').Database} conn
 * @param {number} userId
 * @param {Date} [now]
 * @returns {string}
 */
function buildCycleFeed(conn, userId, now = new Date()) {
  const periods = conn.prepare(
    `SELECT id, start_date, end_date FROM cycle_periods WHERE user_id = ? ORDER BY start_date ASC`
  ).all(userId);
  const settings = conn.prepare(`SELECT * FROM cycle_settings WHERE user_id = ?`).get(userId) || {};

  // Serverseitig erzeugter Kalendertext folgt der Datensprache des Haushalts,
  // genau wie beim Inventar-Feed - der Abonnent sieht den Text roh aus dem
  // Feed, es läuft keine clientseitige Übersetzung mehr darüber.
  const { locale } = resolveHouseholdFormats(conn);
  const dtstamp = formatUTCStamp(now);

  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Yuvomi//Cycle Feed//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeICSText(translate(locale, 'health.cycle.ics.calendarName'))}`,
  ];

  for (const p of periods) {
    out.push(...buildSpanVEvent({
      uid: `cycle-period-${p.id}`,
      start: p.start_date,
      end: p.end_date || p.start_date,
      summary: translate(locale, 'health.cycle.ics.periodSummary'),
    }, dtstamp));
  }

  const projected = projectFutureCycles(periods, settings, todayKey(conn, now));
  for (const cyc of projected) {
    out.push(...buildSpanVEvent({
      uid: `cycle-period-predicted-${userId}-${cyc.start}`,
      start: cyc.start,
      end: cyc.end,
      summary: translate(locale, 'health.cycle.ics.predictedPeriodSummary'),
    }, dtstamp));

    // Dieselbe Bedingung wie predictCycle() (public/utils/health-cycle.js):
    // eine hormonelle Verhuetungsmethode pausiert Eisprung/fruchtbares Fenster
    // genauso wie ein manuell abgeschaltetes track_fertility - der abonnierte
    // Feed darf diese Termine sonst weiter verschicken, waehrend der Zyklus-Tab
    // selbst die Vorhersage laengst pausiert.
    const trackFertility = settings.track_fertility === undefined ? true : !!settings.track_fertility;
    if (trackFertility && !suppressesFertility(settings)) {
      out.push(...buildSpanVEvent({
        uid: `cycle-fertile-predicted-${userId}-${cyc.start}`,
        start: cyc.fertileStart,
        end: cyc.fertileEnd,
        summary: translate(locale, 'health.cycle.ics.fertileWindowSummary'),
      }, dtstamp));
      out.push(...buildDayVEvent({
        uid: `cycle-ovulation-predicted-${userId}-${cyc.start}`,
        date: cyc.ovulation,
        summary: translate(locale, 'health.cycle.ics.ovulationSummary'),
      }, dtstamp));
    }
  }

  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

function getFeedToken(conn, userId) {
  const row = conn.prepare(`SELECT cycle_feed_token AS t FROM users WHERE id = ?`).get(userId);
  return row?.t ?? null;
}

function regenerateFeedToken(conn, userId) {
  const token = randomBytes(32).toString('base64url');
  conn.prepare(`UPDATE users SET cycle_feed_token = ? WHERE id = ?`).run(token, userId);
  return token;
}

function clearFeedToken(conn, userId) {
  conn.prepare(`UPDATE users SET cycle_feed_token = NULL WHERE id = ?`).run(userId);
}

// Löst das Token auf seinen Besitzer auf statt nur "gültig/ungültig" zu sagen,
// genau wie beim Kalender-/Inventar-Feed - der aufgelöste Nutzer geht hier
// zusätzlich in buildCycleFeed ein: Zyklusdaten sind personengebunden, der
// Feed-Inhalt filtert also auf ihn, nicht nur der Zugang.
function findUserIdByFeedToken(conn, token) {
  if (!token) return null;
  const row = conn.prepare(`SELECT id FROM users WHERE cycle_feed_token = ?`).get(token);
  return row?.id ?? null;
}

export {
  buildCycleFeed,
  getFeedToken, regenerateFeedToken, clearFeedToken, findUserIdByFeedToken,
};
