/**
 * Modul: ICS-Abonnements
 * Zweck: Fetch, Parsing, CRUD und periodischer Sync für ICS-URL-Kalenderabonnements.
 *        Enthält SSRF-Schutz, ETag-basiertes Conditional Fetching und RRULE-Expansion.
 * Abhängigkeiten: node:dns/promises, server/db.js, server/services/ics-parser.js,
 *                  server/utils/ssrf.js (zentraler SSRF-Schutz),
 *                  server/utils/http.js (node-nativer Safe-HTTP-Client)
 */

import { localCalendarIdSql, defaultCalendarId, validateCalendarId } from './local-calendars.js';

import { runExternalJob } from '../utils/restore-state.js';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { assignDefaultToEvent, settlePastInheritedReminders } from './sync-assignment.js';
import { assigneeFields, readAllDefaultAssignees, readDefaultAssignees, writeDefaultAssignees } from './default-assignees.js';
import { setEventAssignments } from '../routes/calendar/helpers.js';
import { remindAtCompareKey } from '../utils/reminder-schedule.js';
import { parseICS, expandRRULE, normalizeRecurrenceOverrides } from './ics-parser.js';
import { isBlockedAddress, readPrivateNetworkOptIn, createGuardedLookup, BlockedAddressError } from '../utils/ssrf.js';
import { safeRequest } from '../utils/http.js';
import { followInboundStartChange } from './calendar-occurrence-overrides.js';
import { storeImportedExceptions } from './imported-occurrence-key.js';
import { isValidTimeZone } from '../utils/timezone.js';

const log = createLogger('ICS');

const SYNC_WINDOW_PAST_MONTHS   = 6;
const SYNC_WINDOW_FUTURE_MONTHS = 12;
const MAX_RESPONSE_BYTES        = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS          = 15_000;

const ENV_ALLOW_PRIVATE_NETWORK = 'ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK';

const syncingNow = new Set();

/**
 * Opt-in: erlaubt http:// sowie private/lokale Netzwerkziele (z. B. ein Sonarr-,
 * Radarr- oder Home-Assistant-Feed im selben LAN). Hebt den SSRF-Schutz bewusst
 * auf — nur in kontrollierten Umgebungen setzen. Wird zur Laufzeit gelesen, damit
 * Tests process.env vor dem Aufruf setzen können.
 */
function isPrivateNetworkAllowed() {
  return readPrivateNetworkOptIn(ENV_ALLOW_PRIVATE_NETWORK);
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

/**
 * `allowPrivateNetwork` defaults to this module's own opt-in
 * (ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK) but can be swapped for another
 * module's - waste-url-source.js passes its own WASTE_SOURCE_ALLOW_PRIVATE_NETWORK
 * check here instead of keeping a second copy of this whole function.
 */
async function checkSSRF(urlStr, allowPrivateNetwork = isPrivateNetworkAllowed) {
  if (allowPrivateNetwork()) return;
  const hostname = new URL(urlStr).hostname;
  // URL.hostname liefert IPv6 in Klammern ([::1]) – für isIP/Filter entfernen.
  const host = hostname.replace(/^\[|\]$/g, '');
  // Literale IPs werden von dns.resolve4/6 nicht aufgelöst (liefert []), müssen
  // also direkt geprüft werden – sonst schlüpft https://192.168.0.1/ durch.
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new BlockedAddressError(host);
    return;
  }
  const v4 = await dns.resolve4(hostname).catch(() => []);
  const v6 = await dns.resolve6(hostname).catch(() => []);
  for (const addr of [...v4, ...v6]) {
    if (isBlockedAddress(addr)) {
      throw new BlockedAddressError(addr);
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
  // createGuardedLookup validiert die Ziel-IP JEDER Verbindung — auch die von
  // Redirect-Zielen — zum Verbindungszeitpunkt (Anti-Rebinding). Bei aktivem Opt-in
  // für private Netze entfällt er bewusst (Default-DNS).
  const reqOpts = { headers, signal: controller.signal };
  if (!isPrivateNetworkAllowed()) reqOpts.lookup = createGuardedLookup();
  let res;
  try {
    res = await safeRequest(url, reqOpts);
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

    // RECURRENCE-ID-Overrides zusammenführen: der Master behält die RRULE (sonst
    // überschreibt ein geändertes Einzel-Vorkommen die Serie), verschobene
    // Instanzen bleiben als eigenständige Termine erhalten (#549).
    const normalized = normalizeRecurrenceOverrides(events);
    const flatEvents = [];
    for (const ev of normalized) {
      if (ev.rrule) {
        flatEvents.push(...expandRRULE(ev, windowStart, windowEnd));
      } else if (ev.dtstart >= windowStart && ev.dtstart <= windowEnd) {
        flatEvents.push(ev);
      }
    }

    const seenUids = new Set(flatEvents.map((e) => e.uid));

    // #459: Vor dem Upsert die bereits vorhandenen UIDs merken, damit die
    // Standard-Zuweisung nur NEUE Termine trifft (nicht rückwirkend, kein
    // Wiederkehren nach manuellem Entfernen).
    const existingUids = new Set(
      db.get().prepare('SELECT external_calendar_id FROM calendar_events WHERE subscription_id = ?')
        .all(sub.id).map((r) => r.external_calendar_id)
    );

    // Bekannte UIDs werden nachgeschlagen statt blind eingefügt: ein INSERT mit
    // ON CONFLICT reserviert bei AUTOINCREMENT auch dann eine neue Rowid und
    // schreibt sqlite_sequence fort, wenn das DO UPDATE per WHERE unterdrückt
    // wird. Ein unveränderter Lauf würde also weiterhin schreiben, nur für
    // changes und total_changes() unsichtbar.
    const findExisting = db.get().prepare(`
      SELECT id, start_datetime FROM calendar_events
      WHERE subscription_id = ? AND external_calendar_id = ?
    `);

    const insertEvent = db.get().prepare(`
      INSERT INTO calendar_events
        (title, description, start_datetime, end_datetime, all_day, location,
         color, external_calendar_id, external_source, subscription_id, recurrence_rule, user_modified, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ics', ?, ?, 0, ?)
    `);

    // Der Wertvergleich hält Schreibvorgänge ab, die nichts ändern: liefert ein
    // Server kein ETag, kommt bei jedem Lauf der komplette Kalender erneut an.
    // IS NOT statt Ungleich wegen der NULL-Sicherheit. Verglichen wird genau
    // über die Spalten, die auch gesetzt werden - recurrence_rule bleibt beim
    // Update außen vor, wie zuvor beim ON CONFLICT, und darf deshalb auch den
    // Vergleich nicht auslösen.
    const updateEvent = db.get().prepare(`
      UPDATE calendar_events
      SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
          all_day = ?, location = ?, color = ?
      WHERE id = ? AND user_modified = 0
        AND (   title          IS NOT ?
             OR description    IS NOT ?
             OR start_datetime IS NOT ?
             OR end_datetime   IS NOT ?
             OR all_day        IS NOT ?
             OR location       IS NOT ?
             OR color          IS NOT ?
            )
    `);

    const deleteStale = db.get().prepare(`
      DELETE FROM calendar_events
      WHERE subscription_id = ?
        AND external_calendar_id NOT IN (SELECT value FROM json_each(?))
        AND user_modified = 0
    `);

    // Zählt, was den lokalen Stand wirklich verändert hat. Gesehen ist nicht
    // geändert: ein Abo mit 200 Terminen liefert bei jedem Lauf 200 Events,
    // im Regelfall aber keine einzige Änderung.
    let changedEvents = 0;

    db.get().transaction(() => {
      for (const ev of flatEvents) {
        try {
          // NUR die Eigenfarbe des Termins (RFC 7986 COLOR); die Abo-Farbe ist
          // geerbt und gehoert nicht in die Eigenfarb-Spalte (#891), sonst
          // verdraengt sie dauerhaft die Farbe der zugewiesenen Person. Der
          // Lesepfad liefert sie als cal_color aus ics_subscriptions nach.
          const color    = ev.color ?? null;
          const existing = findExisting.get(sub.id, ev.uid);
          if (existing) {
            // Dieselben Werte binden die SET-Liste und den Vergleich.
            const values = [
              ev.summary, ev.description, ev.dtstart, ev.dtend,
              ev.allDay ? 1 : 0, ev.location, color,
            ];
            const updated = updateEvent.run(...values, existing.id, ...values).changes;
            changedEvents += updated;
            // Im Feed verschoben (#1377): die Erinnerungen ziehen mit. Nur wenn
            // das UPDATE griff - eine lokal bearbeitete Zeile (user_modified)
            // behaelt ihren Start und damit auch ihre Erinnerungen.
            if (updated) followInboundStartChange(db.get(), existing.id, existing.start_datetime, ev.dtstart);
          } else {
            insertEvent.run(ev.summary, ev.description, ev.dtstart, ev.dtend,
              ev.allDay ? 1 : 0, ev.location, color, ev.uid, sub.id, ev.rrule, createdBy);
            changedEvents++;
          }
        } catch (err) { log.error(`Upsert UID ${ev.uid}: ${err.message}`); }
      }
      changedEvents += deleteStale.run(sub.id, JSON.stringify([...seenUids])).changes;

      // #459, #1897: neu importierte Termine den Standard-Personen zuweisen.
      const defaultAssignees = readDefaultAssignees(db.get(), 'subscription', sub.id);
      if (defaultAssignees.length) {
        for (const ev of flatEvents) {
          if (existingUids.has(ev.uid)) continue;
          const row = db.get().prepare(
            'SELECT id FROM calendar_events WHERE subscription_id = ? AND external_calendar_id = ?'
          ).get(sub.id, ev.uid);
          if (row) assignDefaultToEvent(db.get(), row.id, defaultAssignees);
        }
      }

      db.get().prepare(`UPDATE ics_subscriptions SET last_sync = ?, etag = ?, last_modified = ? WHERE id = ?`)
        .run(new Date().toISOString(), newEtag, newLastModified, sub.id);
    })();

    // Ein Lauf, der nichts verändert hat, gehört nicht ins Standard-Log: er
    // wiederholt sich bei jedem Scheduler-Tick.
    const summary = `Subscription ${sub.id} (${sub.name}): ${flatEvents.length} events seen, ${changedEvents} changed.`;
    if (changedEvents > 0) log.info(summary);
    else log.debug(summary);
  } finally { syncingNow.delete(sub.id); }
}

/**
 * Als Job, der liest, auf einen Anbieter wartet und dann schreibt: waehrend
 * eines Restores beginnt er nicht, ein laufender wird abgewartet - sonst
 * schriebe er sein Ergebnis in die gerade eingespielte Datenbank (Codex-Befund
 * in #1431, siehe server/utils/restore-state.js).
 */
function sync(subscriptionId) {
  return runExternalJob(() => syncUntracked(subscriptionId));
}

async function syncUntracked(subscriptionId) {
  const subs = subscriptionId
    ? db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').all(subscriptionId)
    : db.get().prepare('SELECT * FROM ics_subscriptions').all();
  for (const sub of subs) {
    try { await syncOne(sub); }
    catch (err) { log.error(`Subscription ${sub.id} sync failed: ${err.message}`); }
  }
}

/**
 * Ein Abo, wie die API es zeigt: die Standard-Personen aus der Join-Tabelle
 * (#1897). Die alte Spalte gilt nicht mehr und wird mit der primaeren Person
 * ueberschrieben, damit ein Aufrufer der Altform nichts Veraltetes liest.
 */
function withAssignees(sub, ids = readDefaultAssignees(db.get(), 'subscription', sub.id)) {
  return { ...sub, ...assigneeFields(ids) };
}

/** Ein Abo mit seinen Standard-Personen, oder undefined. */
function getOne(subId) {
  const sub = db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId);
  return sub ? withAssignees(sub) : undefined;
}

function getAll(userId) {
  const sets = readAllDefaultAssignees(db.get(), 'subscription');
  return db.get().prepare(`
    SELECT * FROM ics_subscriptions WHERE shared = 1 OR created_by = ? ORDER BY name ASC
  `).all(userId).map((sub) => withAssignees(sub, sets.get(Number(sub.id)) ?? []));
}

/**
 * Reduziert eine ICS-RRULE auf das lokal unterstützte Subset
 * (FREQ / INTERVAL / BYDAY / UNTIL / COUNT) und gibt sie ohne "RRULE:"-Präfix
 * zurück – passend zum rrule()-Validator und zur Recurrence-Engine. Nicht
 * abbildbare Regeln (BYMONTHDAY, Ordinal-BYDAY …) ergeben null → Einzeltermin.
 * COUNT begrenzt endliche Serien; ohne Erhalt würde aus einer 10-fachen
 * Wiederholung eine unendliche Serie (#513). COUNT und UNTIL schließen sich
 * laut RFC 5545 aus – bei beidem gewinnt COUNT (die konkrete Anzahl).
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
  // Genau `-1` bei MONTHLY, in der Reihenfolge, die der Validator erwartet
  // (#960). Der Reduzierer laesst alles weg, was die Engine nicht bedient - und
  // seit "am letzten Tag des Monats" darstellbar ist, gehoert es dazu. Ohne
  // diese Zeile kaeme eine importierte Monatsletzten-Serie als blosses
  // `FREQ=MONTHLY` an und liefe danach auf dem Tag ihres Startdatums.
  if (freq === 'MONTHLY' && String(parts.BYMONTHDAY ?? '').trim() === '-1') rule += ';BYMONTHDAY=-1';
  const count = parts.COUNT ? parseInt(parts.COUNT, 10) : null;
  if (Number.isInteger(count) && count > 0) {
    rule += `;COUNT=${count}`;
  } else if (parts.UNTIL) {
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
 * PERSONEN FUER DEN LAUF (#1940). `assigneeIds` (geprueft von der Route,
 * Haushaltsmitglieder) bekommt jeder neue Termin dieses Laufs. Ein Termin, den
 * dieselbe Person schon importiert hat (gleiche UID), wird dann nicht bloss
 * uebersprungen: die gewaehlten Personen kommen zu denen dazu, die schon daran
 * stehen. So landet der Zahnarzttermin zweier Kinder aus zwei Links als EIN
 * Termin mit beiden. Gesucht wird dann in jedem lokalen Kalender - die Frage
 * ist "ist der Termin schon hier", nicht "in diesem Kalender". Nichts wird
 * entfernt, nichts sonst am Termin geaendert. Ohne Personen bleibt alles wie
 * bisher. Die Personen werden nicht gespeichert: ein Import hat keinen
 * Kalender, der sie fuer spaeter tragen koennte.
 *
 * @returns {Promise<{ imported:number, skipped:number, assigned:number, total:number }>}
 *   `assigned`: schon vorhandene Termine, die dabei eine Person dazubekamen
 *   (sie zaehlen auch in `skipped`).
 */
async function importToLocal(userId, { ics, url, color, localCalendarId = null, assigneeIds = [] } = {}) {
  let rawEvents;
  if (typeof ics === 'string' && ics.trim()) {
    rawEvents = parseICS(ics);
  } else if (typeof url === 'string' && url.trim()) {
    const result = await fetchAndParse(url, null, null);
    rawEvents = result.events || [];
  } else {
    throw new Error('Either an ICS file or a URL is required.');
  }
  const calendarCheck = validateCalendarId(db.get(), localCalendarId);
  if (calendarCheck.error) throw new TypeError(calendarCheck.error);
  // RECURRENCE-ID-Overrides zusammenführen: Master behält die Serie, geänderte
  // Einzel-Vorkommen werden eigenständige Termine statt die Serie zu killen (#549).
  rawEvents = normalizeRecurrenceOverrides(rawEvents);

  // HIER bleibt der Fallback bewusst stehen, anders als im Abo-Sync oben (#891).
  // Ein einmaliger Import macht aus den Terminen LOKALE Termine ohne Quelle -
  // sie haben danach keinen Kalender mehr, von dem sie eine Farbe erben koennten,
  // und `color` ist der Wert, den der Nutzer fuer genau diesen Import angegeben
  // hat. Das ist eine Wahl und gehoert deshalb in die Eigenfarb-Spalte.
  const fallbackColor = color || '#007AFF';
  // `series_authored = 1`: die Termine gehoeren nach dem Import dem Nutzer und
  // sind lokale Zeilen wie jede hier angelegte - so hat sie der ausgehende Weg
  // schon behandelt, als er noch `external_source` las (#1935).
  const insert = db.get().prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, all_day, location,
       color, external_calendar_id, external_source, subscription_id,
       recurrence_rule, tzid, user_modified, created_by, local_calendar_id, series_authored)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'local', NULL, ?, ?, 0, ?, ?, 1)
  `);
  const existsStmt = db.get().prepare(`
    SELECT 1 FROM calendar_events e
    WHERE e.created_by = ? AND e.subscription_id IS NULL AND e.external_calendar_id = ?
      AND ${localCalendarIdSql()} = ?
    LIMIT 1
  `);

  // Mit Personen: der Termin derselben Person mit derselben UID, in jedem
  // lokalen Kalender. Die aelteste Zeile, falls ein frueherer Lauf ohne Personen
  // ihn in zwei Kalender gelegt hat.
  //
  // NUR EIN FRUEHERER IMPORT, NIE EIN GESPIEGELTER TERMIN (Review zu #1940):
  // ein aus CalDAV, iCloud oder Google eingelesener Termin traegt dieselbe Art
  // UID in `external_calendar_id`, gehoert dem Konto, das den Sync betreibt, und
  // hat keine `subscription_id` - ohne `external_source = 'local'` haette der
  // Import an ihm Zuweisung, Erinnerungen und Anhangrechte geaendert.
  const existingAnyCalendar = db.get().prepare(`
    SELECT e.id, e.assigned_to FROM calendar_events e
    WHERE e.created_by = ? AND e.subscription_id IS NULL AND e.external_source = 'local'
      AND e.external_calendar_id = ?
    ORDER BY e.id LIMIT 1
  `);
  const assigneesOf = db.get().prepare('SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id');
  const setPrimary = db.get().prepare('UPDATE calendar_events SET assigned_to = ? WHERE id = ? AND assigned_to IS NULL');
  const people = [...new Set((assigneeIds ?? []).map(Number))];
  const nowKey = remindAtCompareKey(new Date());

  // Die Personen zu einem schon vorhandenen Termin dazu. Ueber
  // setEventAssignments(), die eine Schreibstelle der Zuweisung: sie gibt der
  // neuen Person die Erinnerungen des Anlegers und gleicht die Freigabe eines
  // Anhangs an - nur dazu, nie enger (#1358). Vergangene geerbte Erinnerungen
  // gelten als verworfen wie beim Nachtragen (#1154).
  // @returns {boolean} true, wenn mindestens eine Person dazukam
  const addPeople = (eventId, primary) => {
    const before = assigneesOf.all(eventId).map((r) => Number(r.user_id));
    const added = people.filter((id) => !before.includes(id));
    if (primary == null) setPrimary.run(people[0], eventId);
    if (!added.length) return false;
    setEventAssignments(db.get(), eventId, [...before, ...added], { grantAssigneesOnly: true });
    settlePastInheritedReminders(db.get(), eventId, added, nowKey);
    return true;
  };

  let imported = 0;
  let skipped  = 0;
  let assigned = 0;
  const total  = rawEvents.length;

  db.get().transaction(() => {
    for (const ev of rawEvents) {
      if (!ev.dtstart) { skipped++; continue; }
      if (ev.uid && people.length) {
        const existing = existingAnyCalendar.get(userId, ev.uid);
        if (existing) {
          skipped++;
          if (addPeople(existing.id, existing.assigned_to)) assigned++;
          continue;
        }
      } else if (ev.uid && existsStmt.get(userId, ev.uid, localCalendarId ?? defaultCalendarId(db.get()))) {
        skipped++;
        continue;
      }
      try {
        const localRule = toLocalRRule(ev.rrule);
        // Die Zone des DTSTART bleibt an der Serie (#2306), wie bei CalDAV und
        // iCloud: ohne sie liefen die Vorkommen nach einer Umstellung auf der
        // UTC-Uhr des Starts weiter, und eine Absage traf den Nachbartag.
        // Nur an einer Serie - ein Einzeltermin hat keine Vorkommen zu halten -
        // und nur eine IANA-Zone: einen fremden Namen (Windows-Zonen) kennt
        // die Expansion nicht, der Start bleibt dann wie bisher ohne Zone.
        const tzid = localRule && !ev.allDay && isValidTimeZone(ev.tzid) ? ev.tzid : null;
        const info = insert.run(
          ev.summary, ev.description, ev.dtstart, ev.dtend,
          ev.allDay ? 1 : 0, ev.location, ev.color || fallbackColor,
          ev.uid || null, localRule, tzid, userId, localCalendarId,
        );
        // EXDATE nur übernehmen, wenn die Serie erhalten blieb (localRule != null).
        // Schluessel in Format A, wo die Uhr der Zeile das Vorkommen kennt
        // (#2000, #2034 Schritt 5).
        if (localRule && Array.isArray(ev.exdates) && ev.exdates.length) {
          storeImportedExceptions(db.get(), Number(info.lastInsertRowid), ev);
        }
        if (people.length) assignDefaultToEvent(db.get(), Number(info.lastInsertRowid), people);
        imported++;
      } catch (err) {
        log.error(`Import UID ${ev.uid}: ${err.message}`);
        skipped++;
      }
    }
  })();

  log.info(`Imported ${imported}/${total} events for user ${userId} (${skipped} skipped, ${assigned} assigned).`);
  return { imported, skipped, assigned, total };
}

async function create(userId, { name, url, color, shared, default_assignee_user_ids = [] }) {
  const normalizedUrl = normalizeUrl(url);
  await checkSSRF(normalizedUrl);
  // Die Zuweisung steht VOR dem ersten syncOne() in der Zeile - danach gesetzt
  // hätte sie die eben eingelesenen Termine nicht mehr erreicht (#730).
  const subId = db.get().transaction(() => {
    const id = Number(db.get().prepare(
      `INSERT INTO ics_subscriptions (name,url,color,shared,created_by)
       VALUES (?,?,?,?,?)`
    ).run(name, normalizedUrl, color, shared ? 1 : 0, userId).lastInsertRowid);
    writeDefaultAssignees(db.get(), 'subscription', id, default_assignee_user_ids);
    return id;
  })();
  const newSub = db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId);
  let syncError = null;
  try { await syncOne(newSub); } catch (err) { syncError = err.message; }
  return { sub: withAssignees(newSub), syncError };
}

function update(userId, subId, fields, isAdmin) {
  const sub = db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId);
  if (!sub) return null;
  if (!isAdmin && sub.created_by !== userId) throw new Error('Not authorized.');
  const name   = fields.name   !== undefined ? fields.name   : sub.name;
  const color  = fields.color  !== undefined ? fields.color  : sub.color;
  const shared = fields.shared !== undefined ? (fields.shared ? 1 : 0) : sub.shared;
  db.get().transaction(() => {
    db.get().prepare(`UPDATE ics_subscriptions SET name = ?, color = ?, shared = ? WHERE id = ?`)
      .run(name, color, shared, subId);
    if (fields.default_assignee_user_ids !== undefined) {
      writeDefaultAssignees(db.get(), 'subscription', subId, fields.default_assignee_user_ids);
    }
  })();
  return withAssignees(db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId));
}

function remove(userId, subId, isAdmin) {
  const sub = db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId);
  if (!sub) return false;
  if (!isAdmin && sub.created_by !== userId) throw new Error('Not authorized.');
  db.get().prepare('DELETE FROM ics_subscriptions WHERE id = ?').run(subId);
  return true;
}

export { sync, getAll, getOne, create, update, remove, importToLocal, toLocalRRule, fetchAndParse, normalizeUrl, checkSSRF, isPrivateNetworkAllowed };
