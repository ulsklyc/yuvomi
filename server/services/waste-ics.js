/**
 * Module: Waste collection ICS export (#1063 Phase 10)
 * Purpose: an independent, read-only iCalendar feed of upcoming (and
 *          recently past) waste pickups, mirroring the existing per-module
 *          feeds (server/services/inventory-deadlines-ics.js,
 *          server/services/schedule-ics.js). Reuses only the two pure text
 *          helpers from server/services/ics-export.js (escapeICSText,
 *          foldLine) - building VEVENTs here is trivial (all-day only, no
 *          VTIMEZONE) compared to the household calendar feed's timed events.
 *
 * Token lives on the users row, same pattern as calendar_feed_token (Migration
 * 61) / inventory_deadlines_feed_token (Migration 144) / schedule_feed_token
 * (Migration 176): waste types/schedules/pickups have no owner or visibility
 * column, so the feed CONTENT stays household-wide, but the TOKEN is
 * per-user - a revoke costs exactly one subscription, not every subscriber's.
 *
 * waste_feed_type_ids stores the subscriber's optional type selection
 * alongside the token (NULL = every active type) rather than as a query
 * parameter on the public URL, so the subscription URL stays stable across
 * edits to the selection (see Migration 205).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as store from './waste-store.js';
import { resolveHouseholdFormats, translate } from '../utils/i18n.js';
import { escapeICSText, foldLine } from './ics-export.js';
import { todayKey, shiftDateKey } from '../utils/timezone.js';

const FEED_PAST_DAYS = 30;
const FEED_FUTURE_DAYS = 365;

function pad(n) { return String(n).padStart(2, '0'); }

function formatUTCStamp(now) {
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
         `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
}

function formatDateValue(dateKey) {
  return dateKey.replace(/-/g, '');
}

function addDaysDateKey(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function buildVEvent(occurrence, dtstamp, locale) {
  const lines = [
    'BEGIN:VEVENT',
    // Stable per (type, date) - the same identity waste-domain.js's own
    // coalesceOccurrences() already assigns as `key` (invariant: a moved or
    // coalesced occurrence still resolves to one UID, never a duplicate).
    `UID:waste-pickup-${occurrence.type_id}-${occurrence.date_key}@yuvomi`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${formatDateValue(occurrence.date_key)}`,
    // DTEND ist exklusiv (RFC 5545), wie jeder andere all-day Feed hier.
    `DTEND;VALUE=DATE:${addDaysDateKey(occurrence.date_key, 1)}`,
    `SUMMARY:${escapeICSText(translate(locale, 'waste.icsPickupSummary', { name: occurrence.type_name }))}`,
    'END:VEVENT',
  ];
  return lines.map(foldLine);
}

/**
 * @param {object} conn
 * @param {number} userId whose feed to build (resolves the type selection)
 * @param {Date} [now]
 */
function buildWasteFeed(conn, userId, now = new Date()) {
  const today = todayKey(conn);
  const from = shiftDateKey(today, -FEED_PAST_DAYS);
  const to = shiftDateKey(today, FEED_FUTURE_DAYS);
  const occurrences = store.getOccurrences(conn, { from, to });

  const typeIds = getFeedTypeIds(conn, userId);
  const filtered = typeIds === null
    ? occurrences
    : occurrences.filter((o) => typeIds.includes(o.type_id));

  const { locale } = resolveHouseholdFormats(conn);
  const dtstamp = formatUTCStamp(now);
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Yuvomi//Waste Collection Feed//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeICSText(translate(locale, 'waste.icsCalendarName'))}`,
  ];
  for (const occurrence of filtered) {
    out.push(...buildVEvent(occurrence, dtstamp, locale));
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

function getFeedToken(conn, userId) {
  const row = conn.prepare(`SELECT waste_feed_token AS t FROM users WHERE id = ?`).get(userId);
  return row?.t ?? null;
}

function regenerateFeedToken(conn, userId) {
  const token = randomBytes(32).toString('base64url');
  conn.prepare(`UPDATE users SET waste_feed_token = ? WHERE id = ?`).run(token, userId);
  return token;
}

function clearFeedToken(conn, userId) {
  conn.prepare(`UPDATE users SET waste_feed_token = NULL, waste_feed_type_ids = NULL WHERE id = ?`)
    .run(userId);
}

// Löst das Token auf seinen Besitzer auf statt nur "gültig/ungültig" zu
// sagen - so trifft ein Rückzug genau ein Abo, wie bei jedem anderen Feed in
// dieser Datei.
//
// timingSafeEqual je Zeile statt einer SQL-Gleichheit `WHERE token = ?`
// (derselbe Fix wie ics-export.js#findUserIdByFeedToken - siehe dort fuer die
// Begruendung). Ein Haushalt hat hoechstens eine Handvoll Nutzer, ein voller
// Tabellenscan ist hier also kein Performance-Thema.
function findUserIdByFeedToken(conn, token) {
  if (!token) return null;
  const candidate = Buffer.from(token, 'utf8');
  for (const row of conn.prepare(`SELECT id, waste_feed_token AS t FROM users WHERE waste_feed_token IS NOT NULL`).all()) {
    const stored = Buffer.from(row.t, 'utf8');
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) return row.id;
  }
  return null;
}

/** null = every active type (default, and also what a malformed/cleared value falls back to). */
function getFeedTypeIds(conn, userId) {
  const row = conn.prepare(`SELECT waste_feed_type_ids AS v FROM users WHERE id = ?`).get(userId);
  if (!row?.v) return null;
  try {
    const parsed = JSON.parse(row.v);
    return Array.isArray(parsed) && parsed.every((n) => Number.isInteger(n)) ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {number[]|null} typeIds null clears the selection back to "every type" */
function setFeedTypeIds(conn, userId, typeIds) {
  const value = typeIds === null ? null : JSON.stringify(typeIds);
  conn.prepare(`UPDATE users SET waste_feed_type_ids = ? WHERE id = ?`).run(value, userId);
}

export {
  buildWasteFeed,
  getFeedToken, regenerateFeedToken, clearFeedToken, findUserIdByFeedToken,
  getFeedTypeIds, setFeedTypeIds,
};
