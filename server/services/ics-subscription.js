/**
 * Modul: ICS-Abonnements
 * Zweck: Fetch, Parsing, CRUD und periodischer Sync für ICS-URL-Kalenderabonnements.
 *        Enthält SSRF-Schutz, ETag-basiertes Conditional Fetching und RRULE-Expansion.
 * Abhängigkeiten: node-fetch, node:dns/promises, server/db.js, server/services/ics-parser.js
 */

import dns from 'node:dns/promises';
import fetch from 'node-fetch';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { parseICS, expandRRULE } from './ics-parser.js';

const log = createLogger('ICS');

const SYNC_WINDOW_PAST_MONTHS   = 6;
const SYNC_WINDOW_FUTURE_MONTHS = 12;
const MAX_RESPONSE_BYTES        = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS          = 15_000;

const PRIVATE_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^::1$/, /^f[cd]/i, /^fe[89ab]/i,
];

const syncingNow = new Set();

function normalizeUrl(raw) {
  const url = new URL(raw.replace(/^webcal:\/\//i, 'https://'));
  if (url.protocol !== 'https:') throw new Error('Only https:// and webcal:// URLs are allowed.');
  return url.href;
}

async function checkSSRF(urlStr) {
  const hostname = new URL(urlStr).hostname;
  const v4 = await dns.resolve4(hostname).catch(() => []);
  const v6 = await dns.resolve6(hostname).catch(() => []);
  for (const addr of [...v4, ...v6]) {
    if (PRIVATE_RANGES.some((re) => re.test(addr))) {
      throw new Error(`URL resolves to a private IP address: ${addr}`);
    }
  }
}

async function fetchAndParse(urlRaw, etag, lastModified) {
  const url = normalizeUrl(urlRaw);
  await checkSSRF(url);

  const headers = {};
  if (etag)         headers['If-None-Match']     = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } finally { clearTimeout(timer); }

  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const cl = parseInt(res.headers.get('content-length') || '0', 10);
  if (cl > MAX_RESPONSE_BYTES) throw new Error('ICS file exceeds the 10 MB limit.');

  let body = '', received = 0;
  for await (const chunk of res.body) {
    received += chunk.length;
    if (received > MAX_RESPONSE_BYTES) throw new Error('ICS file exceeds the 10 MB limit.');
    body += chunk.toString();
  }

  return {
    events:          parseICS(body),
    newEtag:         res.headers.get('etag') || null,
    newLastModified: res.headers.get('last-modified') || null,
    notModified:     false,
  };
}

function syncWindow() {
  const now = new Date();
  const past = new Date(now); past.setMonth(past.getMonth() - SYNC_WINDOW_PAST_MONTHS);
  const future = new Date(now); future.setMonth(future.getMonth() + SYNC_WINDOW_FUTURE_MONTHS);
  return { windowStart: past.toISOString().slice(0, 10), windowEnd: future.toISOString().slice(0, 10) };
}

async function syncOne(sub) {
  if (syncingNow.has(sub.id)) {
    log.info(`Subscription ${sub.id} is already syncing - skipped.`);
    return;
  }
  syncingNow.add(sub.id);
  try {
    let result;
    try { result = await fetchAndParse(sub.url, sub.etag, sub.last_modified); }
    catch (err) {
      log.warn(`Subscription ${sub.id} (${sub.name}): fetch failed - ${err.message}`);
      return;
    }

    if (result.notModified) {
      db.get().prepare(`UPDATE ics_subscriptions SET last_sync = ? WHERE id = ?`)
        .run(new Date().toISOString(), sub.id);
      return;
    }

    const { events, newEtag, newLastModified } = result;
    const { windowStart, windowEnd } = syncWindow();
    const owner    = db.get().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
    const createdBy = sub.created_by ?? owner?.id;
    if (!createdBy) { log.warn('No user found.'); return; }

    const flatEvents = [];
    for (const ev of events) {
      if (ev.rrule) {
        flatEvents.push(...expandRRULE(ev, windowStart, windowEnd));
      } else if (ev.dtstart >= windowStart && ev.dtstart <= windowEnd) {
        flatEvents.push(ev);
      }
    }

    const seenUids = new Set(flatEvents.map((e) => e.uid));

    const upsert = db.get().prepare(`
      INSERT INTO calendar_events
        (title, description, start_datetime, end_datetime, all_day, location,
         color, external_calendar_id, external_source, subscription_id, recurrence_rule, user_modified, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ics', ?, ?, 0, ?)
      ON CONFLICT(subscription_id, external_calendar_id) DO UPDATE SET
        title          = excluded.title,
        description    = excluded.description,
        start_datetime = excluded.start_datetime,
        end_datetime   = excluded.end_datetime,
        all_day        = excluded.all_day,
        location       = excluded.location,
        color          = excluded.color
      WHERE user_modified = 0
    `);

    const deleteStale = db.get().prepare(`
      DELETE FROM calendar_events
      WHERE subscription_id = ?
        AND external_calendar_id NOT IN (SELECT value FROM json_each(?))
        AND user_modified = 0
    `);

    db.get().transaction(() => {
      for (const ev of flatEvents) {
        try {
          // Event-Eigenfarbe (RFC 7986) hat Vorrang, sonst die Abo-Farbe.
          upsert.run(ev.summary, ev.description, ev.dtstart, ev.dtend,
            ev.allDay ? 1 : 0, ev.location, ev.color || sub.color, ev.uid, sub.id, ev.rrule, createdBy);
        } catch (err) { log.error(`Upsert UID ${ev.uid}: ${err.message}`); }
      }
      deleteStale.run(sub.id, JSON.stringify([...seenUids]));
      db.get().prepare(`UPDATE ics_subscriptions SET last_sync = ?, etag = ?, last_modified = ? WHERE id = ?`)
        .run(new Date().toISOString(), newEtag, newLastModified, sub.id);
    })();

    log.info(`Subscription ${sub.id} (${sub.name}): ${flatEvents.length} events synced.`);
  } finally { syncingNow.delete(sub.id); }
}

async function sync(subscriptionId) {
  const subs = subscriptionId
    ? db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').all(subscriptionId)
    : db.get().prepare('SELECT * FROM ics_subscriptions').all();
  for (const sub of subs) {
    try { await syncOne(sub); }
    catch (err) { log.error(`Subscription ${sub.id} sync failed: ${err.message}`); }
  }
}

function getAll(userId) {
  return db.get().prepare(`
    SELECT * FROM ics_subscriptions WHERE shared = 1 OR created_by = ? ORDER BY name ASC
  `).all(userId);
}

async function create(userId, { name, url, color, shared }) {
  const normalizedUrl = normalizeUrl(url);
  await checkSSRF(normalizedUrl);
  const subId = db.get().prepare(
    `INSERT INTO ics_subscriptions (name,url,color,shared,created_by) VALUES (?,?,?,?,?)`
  ).run(name, normalizedUrl, color, shared ? 1 : 0, userId).lastInsertRowid;
  const newSub = db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId);
  let syncError = null;
  try { await syncOne(newSub); } catch (err) { syncError = err.message; }
  return { sub: newSub, syncError };
}

function update(userId, subId, fields, isAdmin) {
  const sub = db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId);
  if (!sub) return null;
  if (!isAdmin && sub.created_by !== userId) throw new Error('Not authorized.');
  const name   = fields.name   !== undefined ? fields.name   : sub.name;
  const color  = fields.color  !== undefined ? fields.color  : sub.color;
  const shared = fields.shared !== undefined ? (fields.shared ? 1 : 0) : sub.shared;
  db.get().prepare(`UPDATE ics_subscriptions SET name = ?, color = ?, shared = ? WHERE id = ?`)
    .run(name, color, shared, subId);
  return db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId);
}

function remove(userId, subId, isAdmin) {
  const sub = db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId);
  if (!sub) return false;
  if (!isAdmin && sub.created_by !== userId) throw new Error('Not authorized.');
  db.get().prepare('DELETE FROM ics_subscriptions WHERE id = ?').run(subId);
  return true;
}

export { sync, getAll, create, update, remove, fetchAndParse };
