/**
 * Modul: Google Calendar Sync
 * Zweck: OAuth 2.0 + bidirektionaler Sync mit Google Calendar API v3
 * Abhängigkeiten: googleapis, server/db.js
 *
 * sync_config-Schlüssel:
 *   google_access_token   - OAuth Access Token
 *   google_refresh_token  - OAuth Refresh Token (langlebig)
 *   google_token_expiry   - ISO-8601-Timestamp bis wann Access Token gültig ist
 *   google_sync_token     - Inkrementeller Sync-Token von Google (events.list)
 *   google_last_sync      - ISO-8601-Timestamp des letzten erfolgreichen Syncs
 *   google_calendar_id    - ID des zu synchronisierenden Kalenders (Default: 'primary')
 *   google_last_error     - Fehlermeldung des letzten Laufs, fehlt nach einem sauberen (#820)
 *   google_last_error_at  - ISO-8601-Timestamp dieses Fehlers
 */

import { createLogger } from '../logger.js';
const log = createLogger('Google');

import { google } from 'googleapis';
import crypto from 'node:crypto';
import * as db from '../db.js';
import * as outbound from './calendar-outbound.js';
import { decodeHtmlEntities } from '../utils/html-entities.js';
import { nearestColorId } from '../utils/ical-color.js';
// Fallback-Zone für den Outbound-Sync, wenn Google für den Zielkalender keine liefert.
import { householdTimeZone } from '../utils/timezone.js';
import { outboundEvent } from './outbound-dtstart.js';
import { assignDefaultToEvent } from './sync-assignment.js';
import { countSourceEvents, deleteSourceEvents } from './calendar-prune.js';
import { readSyncOutcome, withSyncOutcome } from './sync-outcome.js';
import { rruleValue } from './recurrence.js';
import { runSerialized } from '../utils/sync-lock.js';

const GOOGLE_COLOR = '#4285F4';

function upsertExternalCalendar(source, externalId, name, color) {
  // Provider-Namen können HTML-entity-encoded sein (Google liefert das z. B. für
  // Import-Kalender) — zu Klartext normalisieren, sonst escaped die UI doppelt.
  const row = db.get().prepare(`
    INSERT INTO external_calendars (source, external_id, name, color)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source, external_id) DO UPDATE SET
      name  = excluded.name,
      color = excluded.color
    RETURNING id
  `).get(source, externalId, decodeHtmlEntities(name), color);
  return row.id;
}

// --------------------------------------------------------
// OAuth2-Client (lazy initialisiert)
// --------------------------------------------------------

function createClient() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('[Google] GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set.');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// --------------------------------------------------------
// sync_config Helfer
// --------------------------------------------------------

function cfgGet(key) {
  const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function cfgSet(key, value) {
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(key, value);
}

function cfgDel(key) {
  db.get().prepare('DELETE FROM sync_config WHERE key = ?').run(key);
}

function isReadonly() {
  return cfgGet('google_readonly') === '1';
}

function setReadonly(enabled) {
  if (enabled) {
    cfgSet('google_readonly', '1');
  } else {
    cfgDel('google_readonly');
  }
}

/** Nur owner/writer dürfen via events.insert beschrieben werden. */
function isWritableRole(role) {
  return role === 'owner' || role === 'writer';
}

/** Ist überhaupt ein Google-Konto verbunden? (Refresh-Token = dauerhafte Verbindung) */
function isConnected() {
  return !!cfgGet('google_refresh_token');
}

// --------------------------------------------------------
// Ausgehende Löschungen und Änderungen (Issue #593)
// Vormerkung, Versuchslimit und Fehlereinordnung sind providerunabhängig und
// liegen in calendar-outbound.js; hier steht nur die Google-Ausführung.
// --------------------------------------------------------

/**
 * Kalender-Metadaten (Rolle, Zeitzone, Name, Farbe) einmal je Sync-Lauf holen.
 * Inbound braucht Name/Farbe, Outbound Rolle/Zeitzone - beides steckt in
 * derselben calendarList.get-Antwort.
 * @returns {Promise<{role:string|null,timeZone:string|null,name:string,color:string,refId:number}|null>}
 *          null, wenn der Kalender nicht (mehr) zugänglich ist.
 */
async function loadCalendarMeta(calendar, calendarId, cache) {
  if (cache.has(calendarId)) return cache.get(calendarId);
  let info = null;
  try {
    const meta  = await calendar.calendarList.get({ calendarId });
    const color = meta.data.backgroundColor || GOOGLE_COLOR;
    const name  = meta.data.summaryOverride || meta.data.summary || 'Google Calendar';
    info = {
      role:     meta.data.accessRole ?? null,
      timeZone: meta.data.timeZone || null,
      name,
      color,
      refId:    upsertExternalCalendar('google', calendarId, name, color),
    };
  } catch (err) {
    log.warn(`Calendar metadata is not accessible (${calendarId}):`, err.message);
  }
  cache.set(calendarId, info);
  return info;
}

/**
 * Kalender, in dem das Event bei Google tatsächlich liegt - aufgelöst über
 * calendar_ref_id, das Inbound wie Outbound-Push setzen. null, wenn unbekannt.
 */
function currentGoogleCalendarId(event) {
  if (!event.calendar_ref_id) return null;
  const row = db.get().prepare(
    `SELECT external_id FROM external_calendars WHERE id = ? AND source = 'google'`
  ).get(event.calendar_ref_id);
  return row?.external_id || null;
}

/**
 * Google-Kalender-ID für ausgehende Operationen: der tatsächliche Kalender,
 * ersatzweise das gewählte Outbound-Ziel (Altzeilen ohne calendar_ref_id).
 */
function googleCalendarIdForEvent(event) {
  return currentGoogleCalendarId(event) || event.target_google_calendar_id || null;
}

/** Anzahl offener Google-Tombstones. */
function pendingDeletionCount() {
  return outbound.pendingDeletionCount('google');
}

/**
 * Arbeitet die vorgemerkten Löschungen bei Google ab.
 * @param {import('googleapis').calendar_v3.Calendar} calendar
 * @returns {Promise<number>} erledigte Tombstones
 */
async function processPendingDeletions(calendar) {
  const rows = outbound.pendingDeletions('google');
  if (rows.length === 0) return 0;

  let done = 0;
  for (const row of rows) {
    try {
      await calendar.events.delete({
        calendarId: row.calendar_external_id,
        eventId:    row.event_external_id,
      });
      outbound.dropDeletion(row.id);
      done++;
    } catch (err) {
      // 404/410 zählen als erledigt (bei Google bereits weg), alles andere
      // wandert in den Retry bis zum gemeinsamen Versuchslimit.
      if (outbound.handleDeletionError(err, row, 'Google')
          && outbound.classifyOutboundError(err) === 'settled') {
        done++;
      }
    }
  }
  return done;
}

/** Anzahl der Events, die auf einen Push oder Umzug zu Google warten. */
function pendingUpdateCount() {
  return outbound.pendingUpdateCount('google');
}

/**
 * Schiebt lokal bearbeitete, bereits gespiegelte Events zu Google.
 * @param {import('googleapis').calendar_v3.Calendar} calendar
 * @param {Record<string,string>} colorMap
 * @param {Map} metaCache
 * @returns {Promise<number>} erfolgreich gepushte Events
 */
async function processPendingUpdates(calendar, colorMap = {}, metaCache = new Map()) {
  const events = outbound.pendingUpdates('google');
  if (events.length === 0) return 0;

  const clear     = outbound.clearOutbound;
  const clearMove = outbound.clearOutboundMove;
  // Nach dem Umzug zeigt die Zeile auf den Zielkalender. Ohne das ginge ein
  // späteres Löschen an den alten Kalender und liefe dort ins Leere, während der
  // Termin in Google stehen bliebe. Die Vormerkung dieses Umzugs fällt gleich mit,
  // eine während des Aufrufs neu vorgemerkte bleibt stehen (über sie entscheidet
  // settleOutbound). Bliebe die erledigte bis nach dem Patch liegen, räumte sie
  // bei einem scheiternden Patch erst der nächste Lauf per clearOutboundMove ab -
  // und der setzt dabei den Fehlversuchszähler des Patches zurück.
  const applyMove = db.get().prepare(`
    UPDATE calendar_events
    SET calendar_ref_id = ?, external_calendar_id = ?,
        outbound_move_to = CASE WHEN outbound_move_to = ? THEN NULL ELSE outbound_move_to END
    WHERE id = ?
  `);

  const handleError = (err, event, what, giveUp) =>
    outbound.handleUpdateError(err, event, what, 'Google', giveUp);

  let done = 0;
  for (const event of events) {
    let calendarId = googleCalendarIdForEvent(event);
    let eventId    = event.external_calendar_id;
    if (!calendarId) {
      log.warn(`No Google calendar known for event ${event.id}, outbound work skipped.`);
      clear(event.id);
      continue;
    }

    const meta = await loadCalendarMeta(calendar, calendarId, metaCache);
    if (!isWritableRole(meta?.role ?? null)) {
      log.warn(`Calendar ${calendarId} has no writable role (role=${meta?.role ?? null}), skipping outbound work for event ${event.id}.`);
      clear(event.id);
      continue;
    }
    // Zeigt nach einem Umzug auf den Zielkalender - dessen Zone gilt für den Patch.
    let activeMeta = meta;
    // Der Umzug, den dieser Lauf bei Google ausgeführt hat.
    let movedTo = null;

    // ── Umzug in einen anderen Kalender (events.move) ────────────────────────
    const moveTo = event.outbound_move_to;
    if (moveTo && moveTo !== calendarId) {
      const destMeta = await loadCalendarMeta(calendar, moveTo, metaCache);
      if (!isWritableRole(destMeta?.role ?? null)) {
        // Der Zielkalender bleibt unangetastet: nur die Vormerkung fällt weg,
        // der Termin bleibt in Google, wo er ist.
        log.warn(`Destination calendar ${moveTo} has no writable role (role=${destMeta?.role ?? null}), keeping event ${event.id} in ${calendarId}.`);
        clearMove(event.id);
      } else {
        try {
          const moved = await calendar.events.move({
            calendarId,
            eventId:     event.external_calendar_id,
            destination: moveTo,
          });
          eventId    = moved?.data?.id || event.external_calendar_id;
          calendarId = moveTo;
          activeMeta = destMeta;
          applyMove.run(destMeta.refId, eventId, moveTo, event.id);
          movedTo = moveTo;
        } catch (err) {
          // Der Umzug ist die Voraussetzung für den Patch im Zielkalender -
          // hier abbrechen, statt im alten Kalender zu patchen. Wird der Umzug
          // aufgegeben, bleibt eine vorgemerkte Feldänderung für den nächsten
          // Lauf bestehen.
          handleError(err, event, 'move', clearMove);
          continue;
        }
      }
    } else if (moveTo) {
      // Ziel == aktueller Kalender: nichts zu tun (z. B. Umzug bereits erfolgt).
      clearMove(event.id);
    }

    // ── Geänderte Felder pushen (events.patch) ───────────────────────────────
    // Frisch nachladen: zwischen der Auswahl oben und hier liegt mindestens ein
    // await, in dem eine weitere Bearbeitung eingetroffen sein kann. Sonst ginge
    // der ältere Stand raus. Auch ob überhaupt gepatcht wird, entscheidet dieser
    // Stand: eine Bearbeitung während des Umzugs geht so noch im Zielkalender
    // hinaus, statt auf den nächsten Lauf zu warten.
    const fresh = outbound.reloadEvent(event.id);
    if (!fresh) continue; // parallel gelöscht - der Tombstone-Pfad übernimmt

    // Das Ziel, auf dem der Umzug beruhte, steht in der Auswahl: `fresh` kommt erst
    // nach events.move und kennt einen Zielwechsel währenddessen schon.
    if (!fresh.outbound_dirty) {
      if (movedTo) {
        outbound.settleOutbound(fresh, movedTo, event);
        done++;
      }
      continue;
    }

    try {
      const gEvent = localEventToGoogle(fresh, colorMap, activeMeta?.timeZone || householdTimeZone(db.get()));
      await calendar.events.patch({ calendarId, eventId, requestBody: gEvent });
      // Während des Patches Eingetroffenes bleibt vorgemerkt.
      outbound.settleOutbound(fresh, movedTo, event);
      done++;
    } catch (err) {
      // Mit dem Zähler des nachgeladenen Stands: eine Bearbeitung seit der Auswahl
      // hat ihn zurückgesetzt und bekommt ihre eigenen Versuche.
      handleError(err, fresh, 'update', clear);
    }
  }
  return done;
}

/**
 * Sofortiger Best-Effort-Durchlauf direkt nach einer lokalen Änderung oder
 * Löschung, damit Google nicht erst beim nächsten Sync-Intervall nachzieht.
 * Fehler sind unkritisch - die Vormerkung bleibt stehen und der Sync holt nach.
 * @returns {Promise<{deleted:number,updated:number}>}
 */
async function flushOutbound() {
  return runSerialized('google', 'flush', runFlushOutbound);
}

async function runFlushOutbound() {
  const idle = { deleted: 0, updated: 0 };
  if (!isConnected() || isReadonly()) return idle;

  const hasDeletions = pendingDeletionCount() > 0;
  const hasUpdates   = pendingUpdateCount() > 0;
  if (!hasDeletions && !hasUpdates) return idle;

  const calendar = google.calendar({ version: 'v3', auth: loadAuthorizedClient() });
  const deleted = hasDeletions ? await processPendingDeletions(calendar) : 0;
  const updated = hasUpdates
    ? await processPendingUpdates(calendar, await fetchEventColorMap(calendar), new Map())
    : 0;
  return { deleted, updated };
}

// --------------------------------------------------------
// Kalenderauswahl (Mehrkalender, Issue #237)
// --------------------------------------------------------

/** Alle bekannten Kalenderauswahl-Zeilen. */
function listSelection() {
  return db.get().prepare(
    'SELECT calendar_id, name, color, enabled, sync_token, last_sync FROM google_calendar_selection'
  ).all();
}

/** IDs der aktuell aktivierten Kalender. */
function enabledCalendarIds() {
  return db.get().prepare(
    'SELECT calendar_id FROM google_calendar_selection WHERE enabled = 1'
  ).all().map((r) => r.calendar_id);
}

/**
 * Aktiviert/deaktiviert einen Kalender. Beim Aktivieren werden name/color
 * (sofern übergeben) als Metadaten gespeichert. Beim Deaktivieren werden die
 * importierten Events dieses Kalenders entfernt und der Sync-Token zurückgesetzt,
 * damit ein erneutes Aktivieren sauber von Grund auf neu liest.
 * @param {string} calendarId
 * @param {boolean} enabled
 * @param {{name?:string,color?:string}} [meta]
 */
function setCalendarEnabled(calendarId, enabled, meta = {}) {
  if (typeof calendarId !== 'string' || calendarId.trim().length === 0) {
    throw new Error('[Google] calendarId fehlt oder ist ungültig.');
  }
  const id = calendarId.trim();
  const flag = enabled ? 1 : 0;

  db.get().prepare(`
    INSERT INTO google_calendar_selection (calendar_id, name, color, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(calendar_id) DO UPDATE SET
      enabled = excluded.enabled,
      name    = COALESCE(excluded.name, google_calendar_selection.name),
      color   = COALESCE(excluded.color, google_calendar_selection.color)
  `).run(id, meta.name || id, meta.color || null, flag);

  if (!enabled) {
    db.get().prepare(`
      DELETE FROM calendar_events
      WHERE external_source = 'google' AND calendar_ref_id IN (
        SELECT id FROM external_calendars WHERE source = 'google' AND external_id = ?
      )
    `).run(id);
    db.get().prepare(
      'UPDATE google_calendar_selection SET sync_token = NULL, last_sync = NULL WHERE calendar_id = ?'
    ).run(id);
  }
}

/** Per-Kalender-Sync-Token + last_sync nach erfolgreichem Inbound speichern. */
function recordSyncToken(calendarId, token) {
  db.get().prepare(`
    UPDATE google_calendar_selection
    SET sync_token = ?, last_sync = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE calendar_id = ?
  `).run(token, calendarId);
}

function getSyncToken(calendarId) {
  const row = db.get().prepare(
    'SELECT sync_token FROM google_calendar_selection WHERE calendar_id = ?'
  ).get(calendarId);
  return row ? row.sync_token : null;
}

/**
 * Listet die für den verbundenen Account verfügbaren Google-Kalender.
 * @returns {Promise<Array<{id,summary,primary,backgroundColor,enabled,accessRole,writable}>>}
 */
async function listCalendars() {
  const client   = loadAuthorizedClient();
  const calendar = google.calendar({ version: 'v3', auth: client });
  const enabledSet = new Set(enabledCalendarIds());
  // Standard-Zuweisung je Kalender (#459) aus der geteilten external_calendars-Tabelle.
  const assigneeMap = new Map(
    db.get().prepare(`SELECT external_id, default_assignee_user_id FROM external_calendars WHERE source = 'google'`)
      .all().map((r) => [r.external_id, r.default_assignee_user_id])
  );

  const items = [];
  let pageToken;
  do {
    const res = await calendar.calendarList.list({ pageToken, maxResults: 250 });
    for (const cal of res.data.items || []) {
      items.push({
        id:              cal.id,
        summary:         cal.summaryOverride || cal.summary || cal.id,
        primary:         !!cal.primary,
        backgroundColor: cal.backgroundColor || GOOGLE_COLOR,
        enabled:         enabledSet.has(cal.id),
        accessRole:      cal.accessRole ?? null,
        writable:        isWritableRole(cal.accessRole),
        default_assignee_user_id: assigneeMap.get(cal.id) ?? null,
        synced:          assigneeMap.has(cal.id),
      });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return items;
}

// --------------------------------------------------------
// Client mit gespeicherten Tokens laden
// --------------------------------------------------------

function loadAuthorizedClient() {
  const accessToken  = cfgGet('google_access_token');
  const refreshToken = cfgGet('google_refresh_token');

  if (!accessToken || !refreshToken) {
    throw new Error('[Google] Not configured - complete OAuth first.');
  }

  const client = createClient();
  client.setCredentials({
    access_token:  accessToken,
    refresh_token: refreshToken,
    expiry_date:   cfgGet('google_token_expiry') ? parseInt(cfgGet('google_token_expiry'), 10) : undefined,
  });

  // Token-Refresh automatisch speichern
  client.on('tokens', (tokens) => {
    if (tokens.access_token) cfgSet('google_access_token', tokens.access_token);
    if (tokens.expiry_date)  cfgSet('google_token_expiry', String(tokens.expiry_date));
  });

  return client;
}

// --------------------------------------------------------
// Öffentliche API
// --------------------------------------------------------

/**
 * Generiert die Google OAuth2-URL zum Weiterleiten des Admins.
 * @returns {string} Auth-URL
 */
/**
 * Generiert die Google OAuth2-URL zum Weiterleiten des Admins.
 * Enthalt einen CSRF-sicheren state-Parameter.
 * @param {object} session - Express-Session-Objekt (state wird dort gespeichert)
 * @returns {string} Auth-URL
 */
function getAuthUrl(session) {
  const client = createClient();
  const state = crypto.randomBytes(32).toString('hex');
  if (session) session.googleOAuthState = state;
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       ['https://www.googleapis.com/auth/calendar'],
    state,
  });
}

/**
 * OAuth-Callback: tauscht Code gegen Tokens, speichert in sync_config.
 * @param {string} code - Code aus dem OAuth-Callback-Query-Parameter
 */
async function handleCallback(code) {
  const client = createClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error('[Google] No refresh token received. Revoke access in your Google account and connect again.');
  }

  cfgSet('google_access_token',  tokens.access_token);
  cfgSet('google_refresh_token', tokens.refresh_token);
  if (tokens.expiry_date) cfgSet('google_token_expiry', String(tokens.expiry_date));

  log.info('OAuth successful - tokens saved.');
}

/**
 * Verbindungsstatus zurückgeben.
 * @returns {{ configured: boolean, connected: boolean, lastSync: string|null }}
 */
function getStatus() {
  const configured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
  const connected  = !!(cfgGet('google_access_token') && cfgGet('google_refresh_token'));
  const lastSync   = cfgGet('google_last_sync');
  return {
    configured,
    connected,
    lastSync,
    selectedCount: enabledCalendarIds().length,
    readonly: isReadonly(),
    // Reist mit dem Status, damit die Rückfrage vor dem Löschen die Zahl sofort
    // nennen kann - und damit die Einstellungen den Rückstand auch dann noch
    // zeigen, wenn längst getrennt wurde (#820).
    mirroredEvents: countSourceEvents(db.get(), 'google'),
    // Ein still gescheiterter Lauf sah bisher aus wie ein Kalender, der einfach
    // aufhoert zu aktualisieren - der Fehler stand nur im Serverlog (#820).
    ...readSyncOutcome(db.get(), 'google'),
  };
}

/**
 * Entfernt die lokal gespiegelten Google-Termine (#820). Ohne Wirkung nach außen:
 * der Google-Kalender bleibt unberührt, geräumt wird nur die Kopie.
 * @returns {number} Anzahl gelöschter Termine
 */
function clearMirroredEvents() {
  return deleteSourceEvents(db.get(), 'google');
}

/**
 * Tokens und Sync-State löschen (Verbindung trennen).
 * @param {object} [opts]
 * @param {boolean} [opts.deleteEvents] Gespiegelte Termine mitnehmen (#820).
 * @returns {{ removed: number }}
 */
function disconnect({ deleteEvents = false } = {}) {
  // Vor dem Trennen: danach ist die Kalenderauswahl fort, und ein Aufräumen nach
  // Kalender wäre nicht mehr möglich. Beides in einer Transaktion, damit nicht die
  // Termine fallen und die Verbindung stehen bleibt (oder umgekehrt).
  return db.get().transaction(() => {
    const removed = deleteEvents ? clearMirroredEvents() : 0;
    ['google_access_token', 'google_refresh_token', 'google_token_expiry',
     'google_last_sync', 'google_readonly',
     // Der Fehlerstand gehoert zur Verbindung: bliebe er stehen, meldete die
     // Karte nach dem Trennen einen Ausfall, den es nicht mehr gibt (#820).
     'google_last_error', 'google_last_error_at'].forEach(cfgDel);
    db.get().prepare('DELETE FROM google_calendar_selection').run();
    // Offene Löschungen verfallen mit der Verbindung: ohne Token gibt es niemanden
    // mehr, bei dem gelöscht werden könnte (#593).
    db.get().prepare(`DELETE FROM calendar_pending_deletions WHERE source = 'google'`).run();
    log.info('Disconnected.' + (removed ? ` ${removed} mirrored event(s) removed.` : ''));
    return { removed };
  })();
}

/**
 * Bidirektionaler Sync.
 * Inbound:  Google → lokale DB (Upsert via external_calendar_id)
 * Outbound: lokale Termine (external_source='local', external_calendar_id IS NULL) → Google
 */
/**
 * Ein Lauf, dessen Ausgang den Lauf überlebt (#820). Der Wrapper liegt um
 * runSync() statt in ihm, damit JEDER Ausstieg erfasst wird - auch das frühe
 * Werfen bei fehlendem Token, das ohne Verbindung der wahrscheinlichste Fall ist.
 */
async function sync() {
  return runSerialized('google', 'sync', () => withSyncOutcome(db.get(), 'google', runSync));
}

async function runSync() {
  const client   = loadAuthorizedClient();
  const calendar = google.calendar({ version: 'v3', auth: client });

  // Event-Farbpalette (colorId → Hex) einmalig für den ganzen Sync laden.
  const eventColorMap = await fetchEventColorMap(calendar);

  const calendarIds = enabledCalendarIds();
  // Kalender-Metadaten (Rolle, Zeitzone, Name, Farbe), memoisiert über alle Phasen.
  const metaCache = new Map();

  // --------------------------------------------------------
  // Löschungen und Änderungen zuerst (#593): vor dem Inbound, damit ein lokal
  // gelöschter Termin bei einem Full-Resync (verfallener syncToken) nicht kurz
  // wieder auftaucht und eine lokale Bearbeitung Google erreicht, bevor der
  // Inbound den alten Google-Stand über sie schreiben könnte.
  // --------------------------------------------------------
  if (!isReadonly()) {
    const removed = await processPendingDeletions(calendar);
    if (removed) log.info(`${removed} pending deletion(s) applied at Google.`);
    const pushed = await processPendingUpdates(calendar, eventColorMap, metaCache);
    if (pushed) log.info(`${pushed} local change(s) pushed to Google.`);
  }

  // --------------------------------------------------------
  // Inbound: jeder aktivierte Kalender mit eigenem syncToken
  // --------------------------------------------------------
  for (const calendarId of calendarIds) {
    const meta     = await loadCalendarMeta(calendar, calendarId, metaCache);
    const calRefId = meta?.refId ?? null;
    const calColor = meta?.color ?? GOOGLE_COLOR;

    let syncToken    = getSyncToken(calendarId);
    let pageToken    = undefined;
    let newSyncToken = null;

    do {
      // singleEvents:false liefert eine Serie als EINEN Master mit ihrer RRULE
      // statt als hunderte Einzelvorkommen - so, wie CalDAV und ICS sie schon
      // immer liefern, und wie Yuvomi Serien lokal führt und expandiert (#593).
      // showDeleted:true ist dabei Pflicht: ein einzeln abgesagtes Vorkommen ist
      // nur als cancelled-Instanz erkennbar, aus der das EXDATE entsteht.
      const listParams = { calendarId, singleEvents: false, showDeleted: true, pageToken };
      if (syncToken) {
        listParams.syncToken = syncToken;
      } else {
        // Kein timeMin: ohne singleEvents wird der Zeitraum gegen den Serienstart
        // geprüft, nicht gegen die Vorkommen. Eine 2019 begonnene, bis heute
        // laufende Wochenserie fiele damit aus dem Abruf. Das kostet nichts an
        // Volumen - ein Master ersetzt alle seine Instanzen.
        listParams.timeMax = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      }

      let response;
      try {
        response = await calendar.events.list(listParams);
      } catch (err) {
        if (err.code === 410) {
          log.warn(`syncToken invalid (${calendarId}) - full resync.`);
          recordSyncToken(calendarId, null);
          syncToken = null;
          continue;
        }
        throw err;
      }

      upsertGoogleEvents(response.data.items || [], calRefId, calColor, eventColorMap,
        { fullResync: !syncToken, calTimeZone: meta?.timeZone ?? null });
      pageToken    = response.data.nextPageToken;
      newSyncToken = response.data.nextSyncToken || newSyncToken;
    } while (pageToken);

    if (newSyncToken) recordSyncToken(calendarId, newSyncToken);
  }

  // --------------------------------------------------------
  // Outbound: nur lokale Events mit explizitem Google-Ziel
  // --------------------------------------------------------
  if (isReadonly()) {
    log.debug('Read-only mode – outbound sync skipped.');
  } else {
    const localEvents = db.get().prepare(`
      SELECT * FROM calendar_events
      WHERE external_source = 'local' AND target_google_calendar_id IS NOT NULL
    `).all();

    const activeIds = new Set(calendarIds);
    for (const event of localEvents) {
      const targetId = event.target_google_calendar_id;
      if (!activeIds.has(targetId)) {
        log.warn(`Target calendar ${targetId} not active, skipping event ${event.id}.`);
        continue;
      }
      // Metadaten-Abruf fehlgeschlagen (meta === null) zählt als nicht schreibbar.
      const meta = await loadCalendarMeta(calendar, targetId, metaCache);
      const role = meta?.role ?? null;
      if (!isWritableRole(role)) {
        log.warn(`Target calendar ${targetId} has no writable role (role=${role}), skipping event ${event.id}.`);
        continue;
      }
      try {
        const gEvent  = localEventToGoogle(event, eventColorMap, meta?.timeZone || householdTimeZone(db.get()));
        const created = await calendar.events.insert({ calendarId: targetId, requestBody: gEvent });
        // refId aus den Metadaten: trägt Name und Farbe des Kalenders statt der
        // rohen ID als Notnamen.
        const calRefId = meta.refId;
        // `color_modified` mit hoch: die gerade hinausgegangene Farbe ist unsere.
        // Die elf `colorId`s sind eine verlustbehaftete Abbildung des Hex-Werts -
        // ohne das Flag holte der nächste Inbound-Lauf die gemappte Farbe zurück
        // und ersetzte damit die gewählte (#899).
        db.get().prepare(`
          UPDATE calendar_events
          SET external_calendar_id = ?, external_source = 'google', calendar_ref_id = ?,
              color_modified = CASE WHEN color IS NOT NULL THEN 1 ELSE color_modified END
          WHERE id = ?
        `).run(created.data.id, calRefId, event.id);
      } catch (err) {
        log.error(`Outbound error for event ${event.id}:`, err.message);
      }
    }
    // Ohne Kandidaten hat der Outbound nichts getan - das gehört nicht in jeden
    // Scheduler-Tick des Standard-Logs.
    const outboundSummary = `Sync completed - ${localEvents.length} candidate local → Google.`;
    if (localEvents.length > 0) log.info(outboundSummary);
    else log.debug(outboundSummary);
  }

  cfgSet('google_last_sync', new Date().toISOString());
}

// Google Calendar uses exclusive end dates for all-day events (RFC 5545).
// A 2-day event Jan 1–2 is stored as end.date = "2026-01-03" (exclusive).
// Subtract 1 day to convert to Yuvomi-style inclusive end date.
function googleAllDayEndToInclusive(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Yuvomi stores inclusive end dates. Add 1 day when sending to Google (exclusive).
function localAllDayEndToExclusive(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// --------------------------------------------------------
// Helfer: Event-Farbpalette (colorId → Hex)
// --------------------------------------------------------

// Die Event-Palette ist praktisch statisch — modul-weit cachen, damit nicht jeder
// Sync (u. U. alle paar Minuten) einen colors.get-Roundtrip auslöst.
let _eventColorCache = null; // { map: Record<string,string>, ts: number }
const EVENT_COLOR_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Lädt Googles Event-Farbpalette und mappt colorId ("1".."11") auf den jeweiligen
 * Hintergrund-Hex. Google liefert Event-Farben ausschließlich als Paletten-ID; die
 * realen Hex-Werte stehen nur im colors-Endpoint. Ergebnis wird 24 h gecacht. Bei
 * Fehlern → letzter Cache, sonst leeres Objekt (Sync fällt auf Kalenderfarbe zurück).
 * @param {import('googleapis').calendar_v3.Calendar} calendar
 * @returns {Promise<Record<string,string>>}
 */
async function fetchEventColorMap(calendar) {
  if (_eventColorCache && (Date.now() - _eventColorCache.ts) < EVENT_COLOR_TTL_MS) {
    return _eventColorCache.map;
  }
  try {
    const res   = await calendar.colors.get();
    const event = res.data?.event || {};
    const map   = {};
    for (const [id, def] of Object.entries(event)) {
      if (def?.background) map[id] = String(def.background).toUpperCase();
    }
    _eventColorCache = { map, ts: Date.now() };
    return map;
  } catch (err) {
    log.warn('Event color palette not available:', err.message);
    return _eventColorCache?.map || {};
  }
}

// --------------------------------------------------------
// Helfer: Google-Event in lokale DB upserten
// --------------------------------------------------------

/**
 * Die RRULE-Zeile aus Googles `recurrence`-Liste. Die Liste führt neben der Regel
 * auch EXDATE/RDATE, deren Reihenfolge nicht zugesichert ist.
 */
function recurrenceRuleOf(item) {
  if (!Array.isArray(item.recurrence)) return null;
  return item.recurrence.find((line) => /^RRULE[:;]/i.test(line)) || null;
}

/** Die EXDATE-Daten (YYYY-MM-DD) aus Googles `recurrence`-Liste. */
function exdatesOf(item) {
  if (!Array.isArray(item.recurrence)) return [];
  const dates = [];
  for (const line of item.recurrence) {
    if (!/^EXDATE[:;]/i.test(line)) continue;
    const values = line.slice(line.indexOf(':') + 1).split(',');
    for (const value of values) {
      const digits = value.trim().replace(/[^0-9]/g, '');
      if (digits.length >= 8) {
        dates.push(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`);
      }
    }
  }
  return dates;
}

/**
 * Datum, an dem ein Ausnahme-Vorkommen ursprünglich lag - das ist der Slot, den
 * die Serienexpansion überspringen muss, nicht der (womöglich verschobene) neue
 * Termin.
 */
function originalStartDate(item) {
  const raw = item.originalStartTime?.dateTime || item.originalStartTime?.date || null;
  return raw ? String(raw).slice(0, 10) : null;
}

function upsertGoogleEvents(items, calRefId = null, calColor = GOOGLE_COLOR, colorMap = {}, { fullResync = false, calTimeZone = null } = {}) {
  // Auf den meldenden Kalender eingegrenzt: wird ein Event in Google von Kalender
  // A nach B verschoben, meldet A es als 'cancelled', während B es als aktiv
  // liefert - bei beiden dieselbe Event-ID. Ein ID-only-DELETE löscht dann je
  // nach Abarbeitungsreihenfolge die Zeile, die B gerade aktualisiert hat, und
  // der Termin verschwindet lokal, obwohl er in Google existiert.
  // Ohne bekannten calRefId (Metadaten nicht abrufbar) und für Altzeilen ohne
  // calendar_ref_id bleibt es beim ID-only-Verhalten - sonst kämen echte
  // Löschungen dort nicht mehr an.
  const del = db.get().prepare(`
    DELETE FROM calendar_events
    WHERE external_calendar_id = ? AND external_source = 'google'
      AND (? IS NULL OR calendar_ref_id IS NULL OR calendar_ref_id = ?)
  `);

  // Standard-Zuweisung dieses Kalenders (#459) — einmal auflösen.
  const defaultAssignee = calRefId
    ? db.get().prepare('SELECT default_assignee_user_id FROM external_calendars WHERE id = ?')
        .get(calRefId)?.default_assignee_user_id ?? null
    : null;

  // Ein Event mit offenem Tombstone ist lokal bereits gelöscht und wartet nur
  // noch auf die Löschung bei Google. Solange darf der Inbound es nicht wieder
  // anlegen - sonst kehrt es bei jedem Full-Resync zurück (#593).
  const pendingDeletion = db.get().prepare(
    `SELECT 1 FROM calendar_pending_deletions WHERE source = 'google' AND event_external_id = ?`
  );

  const dropRow = db.get().prepare('DELETE FROM calendar_events WHERE id = ?');
  // Ausgenommene Vorkommen einer Serie (#489). Additiv: eine vom Nutzer lokal
  // gesetzte Ausnahme wird dabei nicht entfernt.
  const insException = db.get().prepare(
    'INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)'
  );
  const findLocal = db.get().prepare(
    `SELECT id, start_datetime FROM calendar_events WHERE external_calendar_id = ? AND external_source = 'google'`
  );

  // created_by ist ein Fremdschlüssel auf users, und hier stand die 1 fest. Wer
  // den bei der Installation angelegten Nutzer löscht, bekommt seither jeden
  // Insert mit "FOREIGN KEY constraint failed" zurück (#839): der Sync läuft
  // durch, importiert aber nichts. CalDAV und Apple hatten denselben Fehler,
  // Google wurde damals nicht nachgezogen. Einmal auflösen statt je Event - die
  // Zeile ist über den ganzen Lauf konstant.
  const ownerRow  = db.get().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  const createdBy = ownerRow ? ownerRow.id : null;
  if (createdBy === null) log.warn('No user in database - new events are not imported.');

  const insertOrUpdate = db.get().transaction((item) => {
    // Löschung aus diesem Kalender - eine Zeile, die inzwischen zu einem anderen
    // Kalender gehört, ist davon nicht gemeint.
    if (item.status === 'cancelled') {
      // Abgesagtes Einzelvorkommen einer Serie: nicht die Serie löschen, sondern
      // genau dieses Datum aus ihr ausnehmen.
      if (item.recurringEventId) {
        const master = findLocal.get(item.recurringEventId);
        const date   = originalStartDate(item);
        if (master && date) insException.run(master.id, date);
      }
      del.run(item.id, calRefId, calRefId);
      return;
    }
    // Tombstone: diese Event-ID darf lokal gar nicht existieren, unabhängig vom
    // Kalender - der Nutzer hat den Termin gelöscht.
    if (pendingDeletion.get(item.id)) {
      del.run(item.id, null, null);
      return;
    }
    // Geändertes Einzelvorkommen: als eigenständiger Termin führen und sein
    // ursprüngliches Datum aus der Serie ausnehmen, sonst stünde es doppelt -
    // einmal aus der Expansion des Masters, einmal als Ausnahme. Dasselbe
    // Verfahren wie bei CalDAV/ICS (normalizeRecurrenceOverrides).
    if (item.recurringEventId) {
      const master = findLocal.get(item.recurringEventId);
      const date   = originalStartDate(item);
      if (master && date) insException.run(master.id, date);
    }

    const allDay      = !!(item.start?.date && !item.start?.dateTime);
    const startDt     = allDay ? item.start.date : (item.start?.dateTime || item.start?.date);
    const endDt       = allDay
      ? googleAllDayEndToInclusive(item.end?.date)
      : (item.end?.dateTime || item.end?.date || null);
    // Zeitzone der Serie (#829). Google liefert die IANA-Zone neben der Zeit;
    // ohne sie wiederholt die Expansion den festen Offset des ersten Vorkommens
    // und die Serie driftet über die Sommer-/Winterzeit-Grenze um eine Stunde -
    // derselbe Fehler, der für CalDAV/Apple schon als #549 behoben wurde, nur
    // hier nie nachgezogen. Ganztags-Termine tragen keine Zone.
    const tzid        = allDay ? null : (item.start?.timeZone || calTimeZone || null);
    const title       = item.summary || '(kein Titel)';
    const description = item.description || null;
    const location    = item.location    || null;
    // recurrence ist eine Liste von RFC-5545-Zeilen und enthält neben der RRULE
    // auch EXDATE/RDATE. Gezielt die RRULE greifen statt blind die erste Zeile -
    // steht ein EXDATE vorn, landete es sonst als Wiederholungsregel in der DB.
    const rrule       = recurrenceRuleOf(item);

    // NUR die Eigenfarbe des Termins, aufgelöst aus Googles colorId (die API
    // liefert die Paletten-ID, nicht den Hex-Wert). Die Kalenderfarbe gehört
    // NICHT hierher: sie ist geerbt und sagt über diesen einen Termin nichts.
    // Sie hier einzusetzen hat sie ununterscheidbar von einer ausdrücklichen
    // Angabe gemacht und damit die Farbe der zugewiesenen Person verdrängt
    // (#891). Der Lesepfad holt sie weiterhin als cal_color über calendar_ref_id.
    //
    // Google selbst denkt genauso: ein Event ohne colorId erbt dort die
    // Kalenderfarbe, und `localEventToGoogle` schickt für einen Termin ohne
    // eigene Farbe folgerichtig keine colorId zurück.
    const evColor = (item.colorId && colorMap[item.colorId]) || null;

    const existing = db.get().prepare(
      'SELECT id, outbound_dirty FROM calendar_events WHERE external_calendar_id = ? AND external_source = ?'
    ).get(item.id, 'google');

    // Eine lokale Bearbeitung, die noch auf ihren Push wartet, darf der Inbound
    // nicht mit dem alten Google-Stand überschreiben (#593). Der Push kommt im
    // selben Lauf davor; kommt er nicht durch, gewinnt die lokale Änderung bis
    // sie durchgeht - sonst verschwände sie beim Nutzer ohne jede Spur.
    if (existing?.outbound_dirty) return;

    if (existing) {
      // color nur überschreiben, solange der Nutzer nicht lokal umgefärbt hat
      // (color_modified = 0). Dadurch bleiben benutzerdefinierte Event-Farben über
      // Syncs hinweg erhalten (Issue #219), während echte Google-Farbänderungen
      // weiterhin durchkommen. Titel/Zeit bleiben unverändert remote-geführt.
      //
      // Das Gatter hing bis #899 an `user_modified`, das JEDE Bearbeitung setzt:
      // wer den Titel änderte, fror die Farbspalte für immer ein und erfuhr von
      // einer Umfärbung in Google nie mehr etwas.
      // Der Vergleich in der WHERE-Klausel hält Schreibvorgänge ab, die nichts
      // ändern: ein Full-Resync (abgelaufener syncToken) liefert den kompletten
      // Kalender erneut, und ohne den Vergleich würde jede Zeile davon neu
      // geschrieben. `IS NOT` statt `<>`, weil der Vergleich NULL-sicher sein
      // muss; die Farbspalte wiederholt ihren SET-Ausdruck, damit eine lokale
      // Umfärbung (color_modified) nicht als Unterschied zählt. Die Bindings der
      // SET-Liste kommen dafür ein zweites Mal.
      const values = [
        title, description, startDt, endDt, allDay ? 1 : 0, location, rrule, tzid, evColor, calRefId,
      ];
      db.get().prepare(`
        UPDATE calendar_events
        SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
            all_day = ?, location = ?, recurrence_rule = ?, tzid = ?,
            color = CASE WHEN color_modified = 0 THEN ? ELSE color END,
            calendar_ref_id = ?
        WHERE id = ?
          AND (   title           IS NOT ?
               OR description     IS NOT ?
               OR start_datetime  IS NOT ?
               OR end_datetime    IS NOT ?
               OR all_day         IS NOT ?
               OR location        IS NOT ?
               OR recurrence_rule IS NOT ?
               OR tzid            IS NOT ?
               OR color           IS NOT CASE WHEN color_modified = 0 THEN ? ELSE color END
               OR calendar_ref_id IS NOT ?
              )
      `).run(...values, existing.id, ...values);
    } else {
      // Ohne Nutzer gibt es niemanden, dem der Termin gehören könnte. Die Zweige
      // darüber - Aktualisierung und Löschung - kommen ohne ihn aus und laufen
      // weiter; gewarnt wurde einmal beim Auflösen, nicht je Event.
      if (createdBy === null) return;
      const inserted = db.get().prepare(`
        INSERT INTO calendar_events
          (title, description, start_datetime, end_datetime, all_day,
           location, color, external_calendar_id, external_source, recurrence_rule, tzid, calendar_ref_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'google', ?, ?, ?, ?)
      `).run(title, description, startDt, endDt, allDay ? 1 : 0, location, evColor, item.id, rrule, tzid, calRefId, createdBy);
      assignDefaultToEvent(db.get(), inserted.lastInsertRowid, defaultAssignee);
    }

    // EXDATEs, die Google an der Serie selbst führt, als Ausnahmen ablegen.
    if (rrule) {
      const row = findLocal.get(item.id);
      if (row) for (const date of exdatesOf(item)) insException.run(row.id, date);
    }
  });

  // Master vor ihren Ausnahmen: ein Ausnahme-Vorkommen braucht die Master-Zeile,
  // um sein EXDATE daran zu hängen. Googles Reihenfolge ist nicht zugesichert.
  const ordered = items.filter(Boolean)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.recurringEventId ? 1 : 0) - (b.item.recurringEventId ? 1 : 0) || a.index - b.index)
    .map((entry) => entry.item);

  for (const item of ordered) {
    try {
      insertOrUpdate(item);
    } catch (err) {
      log.error(`Upsert error for event ${item?.id}:`, err.message);
    }
  }

  // Beim Full-Resync: Zeilen aus der Zeit vor der Umstellung aufräumen. Damals
  // wurde jede Serie als ihre Einzelvorkommen gespeichert (`<masterId>_<stamp>`);
  // neben dem jetzt geführten Master wären das lauter Dubletten. Nur beim
  // Full-Resync, weil nur dort alle echten Ausnahmen in derselben Antwort liegen
  // und sich damit von Altlasten unterscheiden lassen.
  if (fullResync) {
    const seen = new Set(ordered.map((item) => item.id));
    for (const item of ordered) {
      if (item.recurringEventId || !recurrenceRuleOf(item)) continue;
      try {
        retireLegacyInstances(item.id, seen);
      } catch (err) {
        log.error(`Could not retire legacy instances of ${item.id}:`, err.message);
      }
    }
  }
}

/**
 * Wandelt die Einzelvorkommen um, die vor der Umstellung auf Serien-Master
 * gespeichert wurden (#593).
 *
 * Unangetastete Zeilen verschwinden - der Master deckt sie ab. Zeilen mit
 * eigener Farbe oder Zuweisung werden dagegen zu eigenständigen lokalen
 * Terminen und ihr Datum aus der Serie ausgenommen: so bleibt die Arbeit des
 * Nutzers erhalten, ohne dass der Termin doppelt erscheint.
 */
function retireLegacyInstances(masterExternalId, seen) {
  const master = db.get().prepare(
    `SELECT id FROM calendar_events WHERE external_calendar_id = ? AND external_source = 'google'`
  ).get(masterExternalId);
  if (!master) return;

  const legacy = db.get().prepare(`
    SELECT e.id, e.external_calendar_id, e.start_datetime, e.user_modified,
           (SELECT COUNT(*) FROM event_assignments ea WHERE ea.event_id = e.id) AS assignments
    FROM calendar_events e
    WHERE e.external_source = 'google'
      AND e.external_calendar_id LIKE ? ESCAPE '\\'
      AND e.id <> ?
  `).all(`${masterExternalId.replace(/([%_\\])/g, '\\$1')}\\_%`, master.id);

  const drop     = db.get().prepare('DELETE FROM calendar_events WHERE id = ?');
  const detach   = db.get().prepare(`
    UPDATE calendar_events
    SET external_source = 'local', external_calendar_id = NULL, recurrence_rule = NULL
    WHERE id = ?
  `);
  const insException = db.get().prepare(
    'INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)'
  );

  let removed = 0;
  let kept = 0;
  for (const row of legacy) {
    // In dieser Antwort enthalten heißt: echte Ausnahme, kein Altbestand.
    if (seen.has(row.external_calendar_id)) continue;

    if (row.user_modified === 0 && row.assignments === 0) {
      drop.run(row.id);
      removed++;
    } else {
      insException.run(master.id, String(row.start_datetime).slice(0, 10));
      detach.run(row.id);
      kept++;
    }
  }
  if (removed || kept) {
    log.info(
      `Series ${masterExternalId}: ${removed} legacy occurrence(s) folded into the series` +
      `${kept ? `, ${kept} kept as separate event(s) because they carry local edits` : ''}.`
    );
  }
}

// Yuvomi speichert getimte Events als "YYYY-MM-DDTHH:MM" (ohne Sekunden,
// siehe validate.js). Die Google Calendar API verlangt RFC 3339 mit
// Sekunden, sonst "Bad Request" bzw. bei Wiederholungen "Invalid
// recurrence rule" (Issue #217). Sekunden ergänzen, falls sie fehlen.
function toRfc3339(dt) {
  if (!dt) return dt;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt) ? `${dt}:00` : dt;
}

// RFC 5545: Der Werttyp von UNTIL muss dem von DTSTART entsprechen.
// buildRRule liefert UNTIL immer als DATE-TIME (YYYYMMDDTHHMMSSZ).
//   - all-day-Events (start.date):    UNTIL muss DATE sein (YYYYMMDD)
//   - getimte Events (start.dateTime): UNTIL muss UTC DATE-TIME sein
// Andernfalls lehnt Google die Recurrence ab ("Invalid recurrence rule").
function normalizeRecurrenceUntil(rule, allDay) {
  return rule.split(';').map((segment) => {
    const eq = segment.indexOf('=');
    if (eq === -1) return segment;
    if (segment.slice(0, eq).toUpperCase() !== 'UNTIL') return segment;
    const digits   = segment.slice(eq + 1).replace(/\D/g, '');
    const datePart = digits.slice(0, 8);
    if (allDay) return `UNTIL=${datePart}`;
    const timePart = digits.length > 8 ? digits.slice(8, 14).padEnd(6, '0') : '235959';
    return `UNTIL=${datePart}T${timePart}Z`;
  }).join(';');
}

/**
 * Lokales Event → Google-Event-Body.
 * @param {object} event
 * @param {Record<string,string>} colorMap
 * @param {string} [timeZone]  IANA-Zone, in der Google die Wanduhrzeit interpretiert.
 *                             Normalerweise die Zone des Zielkalenders (siehe sync()).
 */
function localEventToGoogle(rawEvent, colorMap = {}, timeZone = householdTimeZone(null)) {
  // Start und Ende mit der eigenen Wiederholungsregel in Einklang (#986), bevor
  // irgendein Feld daraus abgeleitet wird - ein importiertes DTSTART bleibt
  // unberuehrt (#756). Begruendung in services/outbound-dtstart.js.
  const event = outboundEvent(rawEvent);
  const allDay = !!event.all_day;
  const gEvent = {
    summary:     event.title,
    description: event.description || undefined,
    location:    event.location    || undefined,
  };

  // Event-Farbe verlustbehaftet auf die nächste der 11 Google-colorIds mappen.
  // Ohne verfügbare Palette (colors.get fehlgeschlagen) bleibt colorId ungesetzt,
  // dann erbt das Event in Google die Kalenderfarbe.
  //
  // NULL STATT WEGLASSEN, wenn der Nutzer die Farbe GELEERT hat (#891/#899).
  // Der Unterschied zählt nur beim Update, und dort entscheidet er alles: der
  // Push ist ein `events.patch`, und ein PATCH fasst genau die Felder an, die im
  // Body STEHEN. Ein fehlendes `colorId` heißt also "nicht anfassen", nicht
  // "löschen" - Google behielte seine alte Farbe, während Yuvomi die der
  // zugewiesenen Person zeigt, und die beiden blieben dauerhaft verschieden.
  //
  // ABER NUR BEI EINEM ECHTEN LEEREN, und das ist der Unterschied zu #891: dort
  // ging das null bei jedem Termin ohne Farbe hinaus, auch bei einem, der nie
  // eine hatte. Ein Termin kommt ohne `colorId` herein (lokal NULL), jemand
  // färbt ihn später in Google, und die nächste beliebige Bearbeitung in Yuvomi
  // hätte dessen Farbe abgeräumt, ohne dass sie hier je jemand angefasst hätte.
  // `color_modified` trennt die beiden Zustände: nur wer die Farbe wirklich
  // geleert hat, leert sie auch drüben.
  //
  // Eine fehlende Palette ist wieder etwas anderes als eine fehlende Farbe: dann
  // trägt der Termin sehr wohl eine, wir können sie nur nicht auf eine colorId
  // abbilden. Dort ist "nicht anfassen" richtig, und ein Nullwert würde eine in
  // Google gesetzte Farbe löschen, obwohl niemand das wollte.
  if (event.color) {
    const colorId = nearestColorId(event.color, colorMap);
    if (colorId) gEvent.colorId = colorId;
  } else if (event.color_modified) {
    gEvent.colorId = null;
  }

  if (allDay) {
    const startDate = event.start_datetime.slice(0, 10);
    const endDate   = event.end_datetime ? event.end_datetime.slice(0, 10) : startDate;
    gEvent.start = { date: startDate };
    gEvent.end   = { date: localAllDayEndToExclusive(endDate) };
  } else {
    // Yuvomi speichert getimte Events als naive Wanduhrzeit ohne Zone. Ohne
    // timeZone lehnt Google Serien ab ("recurring events: field is required"),
    // mit einer festen Zone landet das Event bei allen Nutzern außerhalb dieser
    // Zone verschoben (Issue #572: Australien = +7,5 h gegenüber Europe/Berlin).
    // Die Zone des Zielkalenders ist die, in der Google die Zeit anzeigt - damit
    // steht in Google dieselbe Uhrzeit wie in Yuvomi.
    const startDt = toRfc3339(event.start_datetime);
    const endDt   = toRfc3339(event.end_datetime) || startDt;
    gEvent.start = { dateTime: startDt, timeZone };
    gEvent.end   = { dateTime: endDt,   timeZone };
  }

  if (event.recurrence_rule) {
    gEvent.recurrence = [`RRULE:${normalizeRecurrenceUntil(rruleValue(event.recurrence_rule), allDay)}`];
  }

  return gEvent;
}

export { getAuthUrl, handleCallback, getStatus, disconnect, clearMirroredEvents, sync,
         listCalendars, listSelection, setCalendarEnabled, setReadonly, flushOutbound };
export const __test = {
  localEventToGoogle, googleAllDayEndToInclusive, localAllDayEndToExclusive,
  upsertGoogleEvents, upsertExternalCalendar, setReadonly, isReadonly, isWritableRole,
  listSelection, setCalendarEnabled, recordSyncToken, getSyncToken, enabledCalendarIds,
  fetchEventColorMap, householdTimeZone,
  processPendingDeletions, pendingDeletionCount,
  processPendingUpdates, pendingUpdateCount,
  googleCalendarIdForEvent, currentGoogleCalendarId, loadCalendarMeta,
  // Providerunabhängige Vormerkung: durchgereicht, damit die Google-Suite die
  // Kette Vormerken → Ausführen weiterhin an einem Stück prüfen kann.
  queueEventDeletion: outbound.queueEventDeletion,
  markEventOutbound:  outbound.markEventOutbound,
  MIRRORED_FIELDS:    outbound.MIRRORED_FIELDS,
  classifyOutboundError: outbound.classifyOutboundError,
  MAX_OUTBOUND_ATTEMPTS: outbound.MAX_OUTBOUND_ATTEMPTS,
};
