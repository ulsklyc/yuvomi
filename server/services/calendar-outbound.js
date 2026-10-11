// --------------------------------------------------------
// Ausgehende Kalender-Operationen, providerunabhängig (#593).
//
// Löschen, Ändern und der Wechsel des Zielkalenders müssen beim Provider ankommen,
// aber der Aufruf dorthin ist async und darf weder die HTTP-Antwort verzögern noch
// bei einem Netzfehler die lokale Änderung scheitern lassen. Deshalb wird die
// Absicht erst vorgemerkt und dann vom Sync abgearbeitet (at-least-once):
//
//   Löschen → Zeile in calendar_pending_deletions (überlebt das gelöschte Event)
//   Ändern  → calendar_events.outbound_dirty
//   Umzug   → calendar_events.outbound_move_to
//
// Diese Datei hält die geteilte Semantik: was als gespiegeltes Feld gilt, wie ein
// Provider-Fehler eingeordnet wird, wie oft wiederholt wird. Die Ausführung selbst
// liegt beim jeweiligen Provider-Service, weil sich nur dort entscheidet, ob eine
// Änderung ein API-Call (Google) oder ein PUT auf eine Objekt-URL (CalDAV) ist.
//
// Bewusst ohne Provider-Importe: die Vormerkung läuft synchron im Route-Handler,
// noch vor dem lokalen DELETE. Ein Import der Provider-Services zurück in diese
// Datei wäre ein Zyklus; die wenigen Vorbedingungen werden hier direkt geprüft.
// --------------------------------------------------------

import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { runExternalJob } from '../utils/restore-state.js';
import { ownUid, ownUploadRowId, findObjectWithUid } from '../utils/own-uid.js';
import { collectionUrlOf } from '../utils/caldav-client.js';

const log = createLogger('CalendarOutbound');

// Nach so vielen erfolglosen Versuchen wird eine Operation verworfen. Ohne Limit
// belastet ein dauerhaft unschreibbares Event (Kalender entzogen, Konto getauscht)
// jeden Sync-Lauf für immer mit einem Fehlversuch.
export const MAX_OUTBOUND_ATTEMPTS = 5;

// Provider, die ausgehende Änderungen entgegennehmen. ICS-Abos fehlen bewusst:
// ein abonnierter Feed ist per Definition einseitig.
export const OUTBOUND_SOURCES = ['google', 'caldav', 'apple'];

// Felder, die zum Provider gespiegelt werden. Alles andere (Zuweisung, Sichtbarkeit,
// Icon, Anhang) ist Yuvomi-intern und löst keinen Push aus.
export const MIRRORED_FIELDS = [
  'title', 'description', 'location', 'color',
  'all_day', 'start_datetime', 'end_datetime', 'recurrence_rule',
];

export function mirroredFieldsChanged(before, after) {
  return MIRRORED_FIELDS.some((f) => before?.[f] !== after[f]);
}

/**
 * Einordnung eines Provider-Fehlers.
 *   settled   - Ziel bereits erreicht bzw. gegenstandslos (Objekt existiert nicht mehr)
 *   permanent - wiederholt sich garantiert (z. B. Serieninstanz verschieben)
 *   retry     - alles andere, inkl. 403 (kann rateLimitExceeded sein) und 5xx
 *
 * 412 (Precondition Failed) ist CalDAV-typisch: der etag passt nicht mehr, weil das
 * Objekt serverseitig geändert wurde. Das ist ein echter Wiederholungsfall - der
 * nächste Lauf liest den frischen etag und versucht es erneut.
 */
export function classifyOutboundError(err) {
  const status = err?.code ?? err?.response?.status ?? err?.status;
  if (status === 404 || status === 410) return 'settled';
  if (status === 400) return 'permanent';
  return 'retry';
}

/**
 * Was nach einem fehlgeschlagenen Versuch zu tun ist - die Regel, nicht ihre
 * Ausführung. Kalender-Termine und VTODO-Einträge (#617) liegen in verschiedenen
 * Tabellen und merken ihre Absicht verschieden vor, aber sie geben nach denselben
 * Kriterien auf: erledigt, endgültig abgelehnt, oder Versuch verbraucht.
 *
 * @param {Error}  err       Provider-Fehler
 * @param {number} attempts  bisherige Fehlversuche (vor diesem)
 * @returns {'settled'|'give-up'|'retry'}
 */
export function outboundFailureAction(err, attempts) {
  const kind = classifyOutboundError(err);
  if (kind === 'settled') return 'settled';
  if (kind === 'permanent' || attempts + 1 >= MAX_OUTBOUND_ATTEMPTS) return 'give-up';
  return 'retry';
}

// --------------------------------------------------------
// Vormerkung: Löschung
// --------------------------------------------------------

/**
 * Legt einen Tombstone an. Idempotent über den UNIQUE-Index.
 * @returns {boolean} true, wenn eine Löschung vorgemerkt ist
 */
export function queueDeletion({ source, calendarExternalId, eventExternalId, objectUrl = null }, database = null) {
  if (!source || !eventExternalId) return false;
  if (!calendarExternalId && !objectUrl) return false;

  (database || db.get()).prepare(`
    INSERT INTO calendar_pending_deletions (source, calendar_external_id, event_external_id, object_url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source, calendar_external_id, event_external_id)
      DO UPDATE SET object_url = COALESCE(excluded.object_url, object_url)
  `).run(source, calendarExternalId || '', eventExternalId, objectUrl);
  return true;
}

export function pendingDeletions(source) {
  return db.get().prepare(`
    SELECT id, calendar_external_id, event_external_id, object_url, attempts
    FROM calendar_pending_deletions
    WHERE source = ?
    ORDER BY id
  `).all(source);
}

export function pendingDeletionCount(source) {
  return db.get().prepare(
    'SELECT COUNT(*) AS c FROM calendar_pending_deletions WHERE source = ?'
  ).get(source).c;
}

/** Ist für diese externe Event-ID eine Löschung offen? Schützt den Inbound. */
export function hasPendingDeletion(source, eventExternalId) {
  return !!db.get().prepare(
    'SELECT 1 FROM calendar_pending_deletions WHERE source = ? AND event_external_id = ?'
  ).get(source, eventExternalId);
}

/**
 * Alle offenen Tombstone-UIDs eines Providers als Set - einmal je Sync-Lauf statt
 * einer Abfrage pro eingehendem Termin, was bei großen Kalendern messbar ist.
 * Fehlt die Tabelle (gedriftete Datenbank), gilt "keine offenen Löschungen":
 * ein Inbound-Lauf darf daran nicht scheitern.
 */
export function pendingDeletionUids(source) {
  try {
    return new Set(
      db.get().prepare(
        'SELECT event_external_id FROM calendar_pending_deletions WHERE source = ?'
      ).all(source).map((r) => r.event_external_id)
    );
  } catch (err) {
    log.warn(`Pending deletions are not readable (${err.message}); treating them as none.`);
    return new Set();
  }
}

export function dropDeletion(id) {
  db.get().prepare('DELETE FROM calendar_pending_deletions WHERE id = ?').run(id);
}

export function failDeletion(id, err) {
  db.get().prepare(
    'UPDATE calendar_pending_deletions SET attempts = attempts + 1, last_error = ? WHERE id = ?'
  ).run(String(err?.message || err).slice(0, 500), id);
}

/** Objekt-URL eines Tombstones nachtragen, sobald der Sync sie kennt. */
export function recordDeletionObjectUrl(id, objectUrl) {
  if (!objectUrl) return;
  db.get().prepare('UPDATE calendar_pending_deletions SET object_url = ? WHERE id = ?').run(objectUrl, id);
}

/**
 * Fehlerbehandlung einer vorgemerkten Löschung, geteilt von allen Providern.
 * @returns {boolean} true, wenn der Tombstone erledigt (oder aufgegeben) ist
 */
export function handleDeletionError(err, row, provider) {
  const action = outboundFailureAction(err, row.attempts);
  if (action === 'settled') {
    dropDeletion(row.id);
    return true;
  }
  const attempts = row.attempts + 1;
  failDeletion(row.id, err);
  if (action === 'give-up') {
    log.error(`[${provider}] Giving up on remote deletion of ${row.event_external_id} after ${attempts} attempt(s):`, err.message);
    dropDeletion(row.id);
    return true;
  }
  log.warn(`[${provider}] Remote deletion failed for ${row.event_external_id} (attempt ${attempts}):`, err.message);
  return false;
}

// --------------------------------------------------------
// Vormerkung: Änderung und Umzug
// --------------------------------------------------------

/**
 * Markiert ein Event für den Push und/oder den Umzug.
 *
 * Ein Umzug überlebt bewusst jede Vormerkung, die keinen kennt: COALESCE lässt die
 * bestehende Absicht stehen, damit eine Feldänderung einen wartenden Umzug nicht
 * verschluckt. Zurücknehmen lässt er sich deshalb nur ausdrücklich über
 * `cancelMove` - ein `moveTo: null` kommt gegen das COALESCE nicht an.
 *
 * @param {number} eventId
 * @param {{dirty?: boolean, moveTo?: string|null, cancelMove?: boolean}} what
 * @returns {boolean} true, wenn danach ausgehende Arbeit ansteht - nicht nur die
 *   dieses Aufrufs: nimmt er einen Umzug zurück, kann aus einem früheren,
 *   gescheiterten Versuch noch ein Push offen sein, und der Aufrufer entscheidet
 *   daran über seinen Sofortversuch.
 */
export function markOutbound(eventId, { dirty = false, moveTo = null, cancelMove = false } = {}) {
  if (!dirty && !moveTo && !cancelMove) return false;
  const row = db.get().prepare(`
    UPDATE calendar_events
    SET outbound_dirty    = CASE WHEN ? THEN 1 ELSE outbound_dirty END,
        outbound_move_to  = CASE WHEN ? THEN NULL ELSE COALESCE(?, outbound_move_to) END,
        outbound_attempts = 0
    WHERE id = ?
    RETURNING outbound_dirty, outbound_move_to
  `).get(dirty ? 1 : 0, cancelMove ? 1 : 0, moveTo, eventId);
  return !!(row && (row.outbound_dirty || row.outbound_move_to));
}

export function pendingUpdates(source) {
  return db.get().prepare(`
    SELECT * FROM calendar_events
    WHERE (outbound_dirty = 1 OR outbound_move_to IS NOT NULL)
      AND external_source = ? AND external_calendar_id IS NOT NULL
    ORDER BY id
  `).all(source);
}

export function pendingUpdateCount(source) {
  return db.get().prepare(`
    SELECT COUNT(*) AS c FROM calendar_events
    WHERE (outbound_dirty = 1 OR outbound_move_to IS NOT NULL)
      AND external_source = ? AND external_calendar_id IS NOT NULL
  `).get(source).c;
}

/** Alles erledigt: Push und Umzug. */
export function clearOutbound(eventId) {
  db.get().prepare(`
    UPDATE calendar_events
    SET outbound_dirty = 0, outbound_move_to = NULL, outbound_attempts = 0
    WHERE id = ?
  `).run(eventId);
}

/**
 * Nur der Umzug fällt weg - eine gleichzeitig vorgemerkte Feldänderung soll
 * trotzdem noch rausgehen, dann eben im bisherigen Kalender.
 */
export function clearOutboundMove(eventId) {
  db.get().prepare(
    'UPDATE calendar_events SET outbound_move_to = NULL, outbound_attempts = 0 WHERE id = ?'
  ).run(eventId);
}

export function failOutbound(eventId) {
  db.get().prepare(
    'UPDATE calendar_events SET outbound_attempts = outbound_attempts + 1 WHERE id = ?'
  ).run(eventId);
}

/**
 * Fehlerbehandlung einer ausgehenden Änderung, geteilt von allen Providern.
 * `giveUp` bestimmt, was beim Aufgeben fallen gelassen wird: beim Umzug nur die
 * Umzugs-Vormerkung (clearOutboundMove), beim Push alles (clearOutbound).
 */
export function handleUpdateError(err, event, what, provider, giveUp = clearOutbound) {
  const action = outboundFailureAction(err, event.outbound_attempts);
  if (action === 'settled') {
    log.warn(`[${provider}] Event ${event.external_calendar_id} no longer exists at the provider, dropping outbound ${what}.`);
    clearOutbound(event.id);
    return;
  }
  if (action === 'give-up') {
    // giveUp setzt den Zähler ohnehin zurück, deshalb hier kein failOutbound.
    log.error(`[${provider}] Giving up on outbound ${what} of event ${event.id} after ${event.outbound_attempts + 1} attempt(s):`, err.message);
    giveUp(event.id);
    return;
  }
  const attempts = event.outbound_attempts + 1;
  failOutbound(event.id);
  log.warn(`[${provider}] Outbound ${what} failed for event ${event.id} (attempt ${attempts}):`, err.message);
}

/**
 * Spalte mit dem gewählten Zielkalender eines Providers. Umzug kennt nur, wer ein
 * wählbares Ziel hat: der Apple-Legacy-Sync lädt in den ersten verfügbaren
 * Kalender, dort gibt es nichts zu wechseln.
 */
function targetFieldFor(source) {
  if (source === 'google') return 'target_google_calendar_id';
  if (source === 'caldav') return 'target_caldav_calendar_url';
  return null;
}

/** Externe Kennung des Kalenders, in dem der Termin laut calendar_ref_id liegt. */
function currentCalendarId(event) {
  if (!event.calendar_ref_id) return null;
  return db.get().prepare('SELECT external_id FROM external_calendars WHERE id = ? AND source = ?')
    .get(event.calendar_ref_id, event.external_source)?.external_id ?? null;
}

/** Der Event-Stand unmittelbar vor dem Provider-Aufruf; null, wenn parallel gelöscht. */
export function reloadEvent(eventId) {
  return db.get().prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId) ?? null;
}

/**
 * Schliesst die ausgehende Arbeit eines Termins nach dem Provider-Aufruf ab.
 *
 * Zwischen dem Nachladen vor dem Aufruf und hier liegt mindestens ein await. Trifft
 * in dieser Zeit eine Bearbeitung ein, setzt die Route outbound_dirty erneut, und
 * ein pauschales clearOutbound löschte genau diese Markierung: beim Provider läge
 * der ältere Stand, und der nächste Inbound überschriebe die neuere lokale
 * Änderung. Ein in dieser Zeit vorgemerkter Umzug fiele genauso weg. Erledigt ist
 * deshalb nur, was hinausging - verglichen an den gespiegelten Feldern und an dem
 * Umzug, den dieser Aufruf ausgeführt hat.
 *
 * @param {object}      sent           die Zeile, aus der der Aufruf gebaut wurde
 * @param {string|null} handledMoveTo  der Umzug, den dieser Aufruf erledigt hat
 * @param {object}      requested      die Zeile, auf deren Ziel der Umzug beruhte.
 *   Gleich `sent`, wenn Umzug und Änderung ein Aufruf sind (CalDAV); älter, wenn
 *   ein Provider erst verschiebt und danach getrennt patcht (Google).
 */
export function settleOutbound(sent, handledMoveTo = null, requested = sent) {
  const now = reloadEvent(sent.id);
  if (!now) return;
  const edited = mirroredFieldsChanged(sent, now);
  let nextMove = (now.outbound_move_to ?? null) !== handledMoveTo ? now.outbound_move_to : null;
  // Einen Zielwechsel während eines Umzugs hat die Route noch gegen die QUELLE
  // gerechnet: calendar_ref_id wandert erst nach dem Umzug. Ein Rückweg dorthin
  // sah wie "kein Umzug" aus und liess die alte Vormerkung stehen, die hier als
  // erledigt gälte. Massgeblich ist dann das Ziel der Anfrage, gegen den Kalender,
  // in dem der Termin jetzt liegt. Dasselbe gilt für jeden während des Aufrufs
  // vorgemerkten Umzug, auch ohne Umzug in diesem Aufruf: er stammt aus einem
  // Zielwechsel, und ein späterer Wechsel zurück auf den Kalender, in dem der
  // Termin liegt, kann ihn in der Route nicht mehr zurücknehmen - das aktuelle
  // Ziel ist der letzte Wunsch.
  const targetField = targetFieldFor(now.external_source);
  const retargeted  = handledMoveTo && now[targetField] !== requested[targetField];
  if (targetField && (nextMove || retargeted)) {
    const target  = now[targetField] || null;
    const current = currentCalendarId(now) ?? handledMoveTo;
    nextMove = target && target !== current ? target : null;
  }
  if (!edited && !nextMove) {
    clearOutbound(sent.id);
    return;
  }
  db.get().prepare(`
    UPDATE calendar_events
    SET outbound_dirty = ?, outbound_move_to = ?, outbound_attempts = 0
    WHERE id = ?
  `).run(edited ? 1 : 0, nextMove, sent.id);
}

export function recordObjectUrl(eventId, objectUrl) {
  if (!objectUrl) return;
  db.get().prepare('UPDATE calendar_events SET external_object_url = ? WHERE id = ?').run(objectUrl, eventId);
}

// --------------------------------------------------------
// Fassade für die Route
// --------------------------------------------------------

function cfg(key) {
  return db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value ?? null;
}

/** Externe Kalender-Kennung, in der das Event beim Provider liegt. */
function calendarExternalId(event, database = null) {
  if (event.calendar_ref_id) {
    const row = (database || db.get()).prepare(
      'SELECT external_id FROM external_calendars WHERE id = ? AND source = ?'
    ).get(event.calendar_ref_id, event.external_source);
    if (row?.external_id) return row.external_id;
  }
  // Termine, die Yuvomi selbst hochgeladen hat, tragen kein calendar_ref_id -
  // dort steht das ursprünglich gewählte Ziel noch in den target_*-Feldern.
  if (event.external_source === 'google') return event.target_google_calendar_id || null;
  if (event.external_source === 'caldav') return event.target_caldav_calendar_url || null;
  return null;
}

/** Nimmt der Provider dieses Events gerade ausgehende Änderungen entgegen? */
function acceptsOutbound(source) {
  if (source === 'google') return !!cfg('google_refresh_token') && cfg('google_readonly') !== '1';
  if (source === 'caldav') {
    return !!db.get().prepare('SELECT 1 FROM caldav_accounts LIMIT 1').get();
  }
  if (source === 'apple') {
    return !!(cfg('apple_caldav_url') || process.env.APPLE_CALDAV_URL);
  }
  return false;
}

/**
 * Merkt ein gerade lokal gelöschtes Event für die Löschung beim Provider vor.
 * Muss VOR dem lokalen DELETE mit der noch vorhandenen Zeile aufgerufen werden.
 * @returns {boolean} true, wenn ein Tombstone entstanden ist
 */
export function queueEventDeletion(event, database = null) {
  if (!event || !OUTBOUND_SOURCES.includes(event.external_source)) return false;
  if (!event.external_calendar_id) return false;
  if (!acceptsOutbound(event.external_source)) return false;

  const calId = calendarExternalId(event, database);
  // Ohne Kalender und ohne Objekt-URL gibt es keinen Weg zum entfernten Objekt.
  if (!calId && !event.external_object_url) {
    log.warn(`No remote calendar known for event ${event.id}, deletion at the provider skipped.`);
    return false;
  }

  return queueDeletion({
    source:             event.external_source,
    calendarExternalId: calId,
    eventExternalId:    event.external_calendar_id,
    objectUrl:          event.external_object_url || null,
  }, database);
}

/**
 * Merkt die ausgehende Arbeit nach einer lokalen Bearbeitung vor: geänderte
 * gespiegelte Felder → Push, geänderter Zielkalender → Umzug.
 *
 * Der Umzug hängt bewusst an der *Änderung im Request*, nicht am Zustand:
 * Bestandsdaten können ein Ziel tragen, das vom tatsächlichen Kalender abweicht
 * (die target_*-Felder waren für gespiegelte Termine folgenlos setzbar), und das
 * darf nicht nachträglich als Umzugswunsch gelesen werden. Aus demselben Grund
 * nimmt nur eine Zielwahl im Request einen vorgemerkten Umzug zurück.
 * @returns {boolean} true, wenn etwas aussteht
 */
export function markEventOutbound(before, after) {
  if (!after || !OUTBOUND_SOURCES.includes(after.external_source)) return false;
  if (!after.external_calendar_id) return false;

  const dirty = mirroredFieldsChanged(before, after);

  const targetField = targetFieldFor(after.external_source);

  let moveTo     = null;
  let cancelMove = false;
  if (targetField) {
    const target   = after[targetField] || null;
    const previous = before?.[targetField] || null;
    const current  = currentCalendarId(after);
    if (target && target !== previous && current) {
      // Zurück auf den Kalender, in dem der Termin liegt: ein noch nicht
      // ausgeführter Umzug ist damit widerrufen und muss fallen. Ohne das bliebe
      // er stehen (COALESCE) und der nächste Sync schöbe den Termin in einen
      // Kalender, den niemand mehr gewählt hat.
      if (target === current) cancelMove = true;
      else moveTo = target;
    }
  }

  // Vormerken kann nur, wer überhaupt hinausschreiben darf. Das Zurücknehmen
  // nicht: es ist eine rein lokale Buchung, und genau in einer Nur-Lesen-Phase
  // muss sie durchkommen - sonst steht nach dem Abschalten des Nur-Lesen-Modus
  // noch ein Umzug an, den der Nutzer längst widerrufen hat. Ein Sofortversuch
  // lohnt dann trotzdem nicht, deshalb false.
  if (!acceptsOutbound(after.external_source)) {
    if (cancelMove) markOutbound(after.id, { cancelMove });
    return false;
  }

  if (!dirty && !moveTo && !cancelMove) return false;
  return markOutbound(after.id, { dirty, moveTo, cancelMove });
}

/**
 * Sofortiger Best-Effort-Durchlauf direkt nach einer lokalen Änderung oder
 * Löschung, damit der Provider nicht erst beim nächsten Sync-Intervall nachzieht.
 * Fehler sind unkritisch - die Vormerkung bleibt stehen und der Sync holt nach.
 *
 * Läuft über alle Provider, die gerade offene Arbeit haben. Jeder für sich in
 * try/catch: ein nicht erreichbarer Server darf die anderen nicht blockieren.
 * Die Provider-Module werden dynamisch geladen, damit diese Datei importfrei
 * bleibt und synchron aus dem Route-Handler heraus nutzbar ist.
 *
 * Als Job (#1532): der Sofortversuch laeuft nach der Antwort weiter und liest
 * zwischen den Anbietern die offene Arbeit - nach einem await, also womoeglich
 * mitten in einem Restore bei geschlossener Verbindung. Waehrend eines Restores
 * beginnt er deshalb nicht, und ein laufender wird abgewartet. Die Vormerkung
 * bleibt dabei stehen; der naechste Sync-Lauf holt sie nach, falls es sie im
 * eingespielten Stand gibt.
 */
export function flushOutbound() {
  return runExternalJob(() => flushOutboundUntracked());
}

async function flushOutboundUntracked() {
  const total = { deleted: 0, updated: 0 };

  const providers = [
    { source: 'google', load: () => import('./google-calendar.js') },
    { source: 'caldav', load: () => import('./caldav-sync.js') },
    { source: 'apple',  load: () => import('./apple-calendar.js') },
  ];

  for (const { source, load } of providers) {
    if (pendingDeletionCount(source) === 0 && pendingUpdateCount(source) === 0) continue;
    try {
      const mod = await load();
      const res = await mod.flushOutbound();
      total.deleted += res?.deleted ?? 0;
      total.updated += res?.updated ?? 0;
    } catch (err) {
      log.warn(`[${source}] Immediate outbound attempt failed: ${err.message}`);
    }
  }
  return total;
}

// --------------------------------------------------------
// Anlegen: lokaler Termin → CalDAV-Server (CalDAV-Konten und iCloud)
// --------------------------------------------------------

/**
 * UID, unter der diese Installation einen hier angelegten Termin hochlädt.
 * Schon gespiegelte Termine behalten `oikos-<id>@oikos.local`; das Muster und
 * seine Begründung stehen in `server/utils/own-uid.js`.
 */
export function eventUidFor(eventId) {
  return ownUid('event', eventId, db.get());
}

/**
 * Lädt einen lokalen Termin hoch.
 *
 * Meldet der Server 412, ist der Name vergeben. Trägt das Objekt dort unsere
 * UID, kam ein früherer PUT an und nur seine Antwort ging verloren: es wird
 * übernommen (`adopted`), und der Aufrufer merkt den lokalen Stand als Änderung
 * vor, statt zu raten, was dort liegt. Jede andere Absage geht als Fehler hoch.
 *
 * @returns {Promise<{objectUrl: string, adopted: boolean}>}
 */
export async function uploadNewEvent(client, calendar, uid, ics) {
  const filename      = `${uid}.ics`;
  const collectionUrl = String(calendar.url).replace(/\/?$/, '/');
  const objectUrl     = `${collectionUrl}${filename}`;
  try {
    await client.createCalendarObject({ calendar, filename, iCalString: ics });
    return { objectUrl, adopted: false };
  } catch (err) {
    if (err?.status !== 412) throw err;
    // Die UID wird im Objekt GELESEN, nicht aus dem Dateinamen geschlossen;
    // liegt dort etwas anderes, bleibt es unangetastet und der Termin lokal.
    // Gemerkt wird die eigene, berechnete Adresse, nicht eine vom Server genannte.
    if (!(await findObjectWithUid(client, collectionUrl, objectUrl, uid))) throw err;
    return { objectUrl, adopted: true };
  }
}

/**
 * Macht den lokalen Termin zum Spiegel seines Uploads. Objekt-URL und
 * Kalenderzuordnung werden gleich festgehalten: ohne sie wäre der Termin für
 * spätere Änderungen und Löschungen unerreichbar, bis ihn der nächste Abruf
 * wiederfindet (#593).
 *
 * `color_modified` geht mit hoch: die Farbe, die als CSS3-Name hinausging, ist
 * unsere. Der Name ist eine verlustbehaftete Abbildung des Hex-Werts, und ohne
 * das Flag holte der nächste Abruf genau ihn zurück (#899). Ein Termin ohne
 * eigene Farbe behält seinen Zustand.
 *
 * `adopted`: das Objekt lag schon dort (siehe `uploadNewEvent`); dann geht der
 * lokale Stand als Änderung hinterher.
 *
 * @returns {boolean} true, wenn die Zeile umgeschrieben wurde
 */
export function markEventUploaded(eventId, { source, uid, objectUrl, calRefId, adopted = false, onlyIfLocal = false }) {
  return db.get().prepare(`
    UPDATE calendar_events
    SET external_source = ?, external_calendar_id = ?,
        external_object_url = ?, calendar_ref_id = ?,
        color_modified = CASE WHEN color IS NOT NULL THEN 1 ELSE color_modified END,
        outbound_dirty = CASE WHEN ? = 1 THEN 1 ELSE outbound_dirty END,
        outbound_attempts = CASE WHEN ? = 1 THEN 0 ELSE outbound_attempts END
    WHERE id = ?
      AND (? = 0 OR external_source = 'local')
  `).run(source, uid, objectUrl, calRefId, adopted ? 1 : 0, adopted ? 1 : 0, eventId, onlyIfLocal ? 1 : 0)
    .changes > 0;
}

/**
 * Der Inbound-Weg der Übernahme: der Abruf sieht ein Objekt mit der UID dieser
 * Installation, dessen Zeile noch lokal ist - der PUT kam an, die Antwort
 * nicht. In die bestehende Zeile übernehmen, statt eine zweite anzulegen.
 * Endzustand wie nach dem 412 im Upload: gespiegelt und als geändert vorgemerkt.
 *
 * DIE UID KOMMT VOM SERVER UND IST KEIN AUSWEIS. Die Installationskennung
 * steht in jeder UID auf jedem Server, mit dem je synchronisiert wurde; wer in
 * einen Kalender schreiben darf, kann ein Objekt mit einer UID im Muster
 * dieser Installation und einer beliebigen Zeilen-Id hinlegen. Die UID benennt
 * deshalb nur, WELCHER Termin gemeint sein könnte. Übernommen wird er allein
 * nach dem lokalen Stand: `isWaitingHere` muss bestätigen, dass genau dieser
 * Termin JETZT auf seinen Upload in genau DIESEN Kalender wartet - aus
 * derselben Auswahl, aus der der Upload seine Termine nimmt. Dann erfährt der
 * Server nichts, was er nicht im selben Lauf per PUT bekäme. Sonst würde ein
 * fremder, privater oder für ein anderes Konto bestimmter Termin an diesen
 * Kalender gebunden und sein Inhalt mit dem nächsten Outbound hinaufgetragen.
 *
 * Der Serverinhalt überschreibt beim Übernehmen nichts: Felder, Sichtbarkeit
 * und Zuweisung bleiben die lokalen.
 *
 * @param {object}   p
 * @param {string}   p.source          'caldav' | 'apple'
 * @param {string}   p.uid             UID aus dem Serverobjekt
 * @param {string}   p.objectUrl       Adresse des Objekts laut Server
 * @param {string}   p.calendarUrl     Kalender, der gerade abgerufen wird
 * @param {number}   p.calRefId
 * @param {(eventId: number) => boolean} p.isWaitingHere
 * @returns {boolean} true, wenn eine Zeile übernommen wurde
 */
export function adoptOwnEventUpload({ source, uid, objectUrl, calendarUrl, calRefId, isWaitingHere }) {
  const eventId = ownUploadRowId(uid, 'event', db.get());
  if (!eventId || !objectUrl || !calendarUrl || typeof isWaitingHere !== 'function') return false;
  // Exakt die UID, die wir für diesen Termin erzeugen würden.
  if (uid !== eventUidFor(eventId)) return false;
  // Das Objekt liegt in dem Kalender, der gerade abgerufen wird - nicht an
  // einer Adresse, die der Server frei gewählt hat.
  const trim = (url) => String(url || '').replace(/\/+$/, '');
  if (trim(collectionUrlOf(objectUrl)) !== trim(calendarUrl)) return false;
  if (!isWaitingHere(eventId)) return false;

  const adopted = markEventUploaded(eventId, {
    source, uid, objectUrl, calRefId, adopted: true, onlyIfLocal: true,
  });
  if (adopted) log.info(`Adopted the earlier upload of event ${eventId} (${uid}).`);
  return adopted;
}
