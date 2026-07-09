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

const ENV_ALLOW_PRIVATE_NETWORK = 'ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK';

const syncingNow = new Set();

/**
 * Opt-in: erlaubt http:// sowie private/lokale Netzwerkziele (z. B. ein Sonarr-,
 * Radarr- oder Home-Assistant-Feed im selben LAN). Hebt den SSRF-Schutz bewusst
 * auf — nur in kontrollierten Umgebungen setzen. Wird zur Laufzeit gelesen, damit
 * Tests process.env vor dem Aufruf setzen können.
 */
function isPrivateNetworkAllowed() {
  const raw = process.env[ENV_ALLOW_PRIVATE_NETWORK];
  return raw !== undefined && (raw.trim() === 'true' || raw.trim() === '1');
}

function normalizeUrl(raw) {
  const allowPrivate = isPrivateNetworkAllowed();
  const url = new URL(raw.replace(/^webcal:\/\//i, 'https://'));
  const allowed = allowPrivate ? ['https:', 'http:'] : ['https:'];
  if (!allowed.includes(url.protocol)) {
    throw new Error(allowPrivate
      ? 'Only http://, https:// and webcal:// URLs are allowed.'
      : 'Only https:// and webcal:// URLs are allowed.');
  }
  return url.href;
}

async function checkSSRF(urlStr) {
  if (isPrivateNetworkAllowed()) return;
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

/**
 * Reduziert eine ICS-RRULE auf das lokal unterstützte Subset
 * (FREQ / INTERVAL / BYDAY / UNTIL) und gibt sie ohne "RRULE:"-Präfix zurück –
 * passend zum rrule()-Validator und zur Recurrence-Engine. Nicht abbildbare
 * Regeln (reines COUNT, BYMONTHDAY, Ordinal-BYDAY …) ergeben null → Einzeltermin.
 */
function toLocalRRule(raw) {
  if (!raw) return null;
  const body  = String(raw).replace(/^RRULE:/i, '');
  const parts = {};
  for (const seg of body.split(';')) {
    const eq = seg.indexOf('=');
    if (eq === -1) continue;
    parts[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).toUpperCase();
  }
  const freq = parts.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  let rule = `FREQ=${freq}`;
  const interval = parseInt(parts.INTERVAL ?? '1', 10);
  if (Number.isInteger(interval) && interval > 1 && interval < 100) rule += `;INTERVAL=${interval}`;
  if (parts.BYDAY) {
    const days = parts.BYDAY.split(',')
      .map((d) => d.trim())
      .filter((d) => /^(MO|TU|WE|TH|FR|SA|SU)$/.test(d));
    if (days.length) rule += `;BYDAY=${days.join(',')}`;
  }
  if (parts.UNTIL) {
    const m = /^(\d{8})(T\d{6}Z)?/.exec(parts.UNTIL);
    if (m) rule += `;UNTIL=${m[1]}${m[2] || ''}`;
  }
  return rule;
}

/**
 * Einmaliger Import von Terminen aus einer ICS-Datei (roher Text) oder einem
 * geteilten Kalender-Feed (URL) in echte, bearbeitbare lokale Termine
 * (external_source='local', subscription_id=NULL). Anders als ein Abonnement
 * werden die Termine nicht periodisch synchronisiert und gehören danach dem
 * Nutzer. Wiederholungsserien bleiben als Serie erhalten (RRULE, nicht
 * expandiert); die Herkunfts-UID wird als external_calendar_id gespeichert, um
 * versehentliche Doppelimporte desselben Feeds zu überspringen.
 *
 * @returns {Promise<{ imported:number, skipped:number, total:number }>}
 */
async function importToLocal(userId, { ics, url, color } = {}) {
  let rawEvents;
  if (typeof ics === 'string' && ics.trim()) {
    rawEvents = parseICS(ics);
  } else if (typeof url === 'string' && url.trim()) {
    const result = await fetchAndParse(url, null, null);
    rawEvents = result.events || [];
  } else {
    throw new Error('Either an ICS file or a URL is required.');
  }

  const fallbackColor = color || '#007AFF';
  const insert = db.get().prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, all_day, location,
       color, external_calendar_id, external_source, subscription_id,
       recurrence_rule, user_modified, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'local', NULL, ?, 0, ?)
  `);
  const existsStmt = db.get().prepare(`
    SELECT 1 FROM calendar_events
    WHERE created_by = ? AND subscription_id IS NULL AND external_calendar_id = ?
    LIMIT 1
  `);

  let imported = 0;
  let skipped  = 0;
  const total  = rawEvents.length;

  db.get().transaction(() => {
    for (const ev of rawEvents) {
      if (!ev.dtstart) { skipped++; continue; }
      if (ev.uid && existsStmt.get(userId, ev.uid)) { skipped++; continue; }
      try {
        insert.run(
          ev.summary, ev.description, ev.dtstart, ev.dtend,
          ev.allDay ? 1 : 0, ev.location, ev.color || fallbackColor,
          ev.uid || null, toLocalRRule(ev.rrule), userId,
        );
        imported++;
      } catch (err) {
        log.error(`Import UID ${ev.uid}: ${err.message}`);
        skipped++;
      }
    }
  })();

  log.info(`Imported ${imported}/${total} events for user ${userId} (${skipped} skipped).`);
  return { imported, skipped, total };
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

export { sync, getAll, create, update, remove, importToLocal, toLocalRRule, fetchAndParse, normalizeUrl, checkSSRF, isPrivateNetworkAllowed };
