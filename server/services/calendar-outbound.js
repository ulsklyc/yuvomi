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
// CalDAV führt mehrere Konten in denselben beiden Tabellen. Ein gespiegelter
// Termin und sein Löschauftrag tragen deshalb ihr Konto
// (`caldav_account_id`, Migration 238, #1860), und jede Abfrage für 'caldav'
// läuft je Konto: gesendet wird ein Termin nur über das Konto, dem er gehört.
// Google und Apple kennen je genau eine Verbindung und filtern wie bisher nur
// auf die Quelle; ihre Abfragen nennen die Spalte gar nicht erst.
//
// Bewusst ohne Provider-Importe: die Vormerkung läuft synchron im Route-Handler,
// noch vor dem lokalen DELETE. Ein Import der Provider-Services zurück in diese
// Datei wäre ein Zyklus; die wenigen Vorbedingungen werden hier direkt geprüft.
// --------------------------------------------------------

import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { runExternalJob } from '../utils/restore-state.js';
import { ownUid, ownUploadRowId, parseOwnUid, findObjectWithUid } from '../utils/own-uid.js';
import { collectionUrlOf } from '../utils/caldav-client.js';
import {
  noteUploadAttempt, settleUploadAttempt, uploadAttemptsAt, removeLeftoverUploads,
} from './caldav-upload-attempts.js';

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
// local_calendar_id is intentionally absent: moving local calendars never pushes outward.
// A sync target and a local calendar are mutually exclusive.
export const MIRRORED_FIELDS = [
  'title', 'description', 'location', 'color',
  'all_day', 'start_datetime', 'end_datetime', 'recurrence_rule',
];

export function mirroredFieldsChanged(before, after) {
  return MIRRORED_FIELDS.some((f) => before?.[f] !== after[f]);
}

/** Der HTTP-Status eines Provider-Fehlers, gleich aus welchem Client er kommt. */
export function outboundErrorStatus(err) {
  return err?.code ?? err?.response?.status ?? err?.status;
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
  const status = outboundErrorStatus(err);
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
 * Konto-Filter einer Abfrage, die Arbeit AUSGIBT (#1860). Für 'caldav' ist das
 * Konto Pflicht: ein Durchgang arbeitet für genau ein Konto, und eine Liste
 * über alle Konten hinweg gäbe ihm die Arbeit der anderen in die Hand. Fehlt
 * es, ist das ein Fehler im Aufrufer - er wird gemeldet, und die Abfrage
 * liefert nichts.
 *
 * @returns {{sql: string, args: Array}|null} null = nichts ausgeben
 */
function accountFilter(source, accountId, caller) {
  if (source !== 'caldav') return { sql: '', args: [] };
  if (accountId == null) {
    log.error(`${caller}('caldav') was called without an account. This is a bug in the caller; nothing is returned.`);
    return null;
  }
  return { sql: ' AND caldav_account_id = ?', args: [accountId] };
}

/**
 * Konto-Filter einer Abfrage, die nur ZÄHLT. Ohne Konto zählt sie für 'caldav'
 * alles, was überhaupt einem Konto gehört - die Frage "gibt es für diesen
 * Anbieter Arbeit?" stellt die Fassade unten, bevor sie ihn lädt. Was keinem
 * Konto gehört, wird nie gesendet und zählt deshalb nicht mit.
 */
function accountCountFilter(source, accountId) {
  if (source !== 'caldav') return { sql: '', args: [] };
  if (accountId == null) return { sql: ' AND caldav_account_id IS NOT NULL', args: [] };
  return { sql: ' AND caldav_account_id = ?', args: [accountId] };
}

/**
 * Legt einen Tombstone an. Idempotent über den UNIQUE-Index.
 *
 * Ein CalDAV-Tombstone trägt das Konto, über das er gesendet wird (#1860).
 * Ohne Konto entsteht keiner: es gäbe keinen Server, an den er gehen dürfte.
 *
 * `etag` (#1883) macht den Auftrag BEDINGT: er gilt dem Objekt an `objectUrl`
 * in genau diesem Stand und fällt, sobald dort etwas anderes liegt. Ohne ETag
 * gilt er dem Termin, gleich in welchem Stand - so merkt die Löschroute vor,
 * denn wer in Yuvomi löscht, will den Termin fort haben. Ein ETag ohne Adresse
 * bedingt nichts und wird nicht gespeichert.
 *
 * Trifft ein Auftrag ohne ETag auf einen bedingten, gilt danach der
 * unbedingte: die Bedingung fällt. Löscht der Nutzer den Termin, fällt sie
 * auch an den Aufträgen derselben UID in anderen Kalendern
 * (`queueEventDeletion`). Umgekehrt bekommt ein bestehender Auftrag
 * nachträglich keine - Adresse und ETag benennen zusammen EIN Objekt, und die
 * Adresse des bestehenden bleibt.
 * @returns {boolean} true, wenn eine Löschung vorgemerkt ist
 */
export function queueDeletion({ source, calendarExternalId, eventExternalId, objectUrl = null, accountId = null, etag = null }, database = null) {
  if (!source || !eventExternalId) return false;
  if (!calendarExternalId && !objectUrl) return false;
  const state = objectUrl && etag ? String(etag) : null;

  if (source === 'caldav') {
    if (accountId == null) {
      log.error("queueDeletion('caldav') was called without an account. This is a bug in the caller; nothing is queued.");
      return false;
    }
    // Konto UND Adresse eines Auftrags gehören zusammen: sie benennen EIN
    // Objekt auf EINEM Server. Trifft ein neuer Auftrag auf einen bestehenden
    // (gleiche UID in gleichem Kalender), bleibt der bestehende unangetastet
    // und der neue füllt nur, was dort noch fehlt - nie die Adresse des einen
    // mit dem Konto des anderen paaren. Fehlt die Adresse, findet der Lauf das
    // Objekt über seinen Abruf (`processPendingDeletions`).
    (database || db.get()).prepare(`
      INSERT INTO calendar_pending_deletions
        (source, calendar_external_id, event_external_id, object_url, caldav_account_id, etag)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, calendar_external_id, event_external_id)
        DO UPDATE SET object_url = COALESCE(object_url, excluded.object_url),
                      caldav_account_id = COALESCE(caldav_account_id, excluded.caldav_account_id),
                      etag = CASE WHEN excluded.etag IS NULL THEN NULL ELSE etag END
    `).run(source, calendarExternalId || '', eventExternalId, objectUrl, accountId, state);
    return true;
  }

  // Hier gewinnt die neue Adresse, also auch ihr Stand; ohne neue Adresse ist
  // der neue Auftrag unbedingt, und die Bedingung fällt.
  (database || db.get()).prepare(`
    INSERT INTO calendar_pending_deletions (source, calendar_external_id, event_external_id, object_url, etag)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source, calendar_external_id, event_external_id)
      DO UPDATE SET object_url = COALESCE(excluded.object_url, object_url),
                    etag = excluded.etag
  `).run(source, calendarExternalId || '', eventExternalId, objectUrl, state);
  return true;
}

/** @param {{accountId?: number|null}} [scope] für 'caldav' Pflicht */
export function pendingDeletions(source, { accountId = null } = {}) {
  const filter = accountFilter(source, accountId, 'pendingDeletions');
  if (!filter) return [];
  return db.get().prepare(`
    SELECT id, calendar_external_id, event_external_id, object_url, attempts, etag
    FROM calendar_pending_deletions
    WHERE source = ?${filter.sql}
    ORDER BY id
  `).all(source, ...filter.args);
}

export function pendingDeletionCount(source, { accountId = null } = {}) {
  const filter = accountCountFilter(source, accountId);
  return db.get().prepare(
    `SELECT COUNT(*) AS c FROM calendar_pending_deletions WHERE source = ?${filter.sql}`
  ).get(source, ...filter.args).c;
}

/** Ist für diese externe Event-ID eine Löschung offen? Schützt den Inbound. */
export function hasPendingDeletion(source, eventExternalId, { accountId = null } = {}) {
  const filter = accountFilter(source, accountId, 'hasPendingDeletion');
  if (!filter) return false;
  return !!db.get().prepare(
    `SELECT 1 FROM calendar_pending_deletions WHERE source = ? AND event_external_id = ?${filter.sql}`
  ).get(source, eventExternalId, ...filter.args);
}

/**
 * Alle offenen Tombstone-UIDs eines Providers als Set - einmal je Sync-Lauf statt
 * einer Abfrage pro eingehendem Termin, was bei großen Kalendern messbar ist.
 * Für 'caldav' je Konto: die Löschung in einem Konto sagt nichts über den
 * Termin, den ein anderes unter derselben UID führt.
 * Fehlt die Tabelle (gedriftete Datenbank), gilt "keine offenen Löschungen":
 * ein Inbound-Lauf darf daran nicht scheitern.
 */
export function pendingDeletionUids(source, { accountId = null } = {}) {
  const filter = accountFilter(source, accountId, 'pendingDeletionUids');
  if (!filter) return new Set();
  try {
    return new Set(
      db.get().prepare(
        `SELECT event_external_id FROM calendar_pending_deletions WHERE source = ?${filter.sql}`
      ).all(source, ...filter.args).map((r) => r.event_external_id)
    );
  } catch (err) {
    log.warn(`Pending deletions are not readable (${err.message}); treating them as none.`);
    return new Set();
  }
}

/**
 * Dieselbe Frage wie `pendingDeletionUids`, aber je OBJEKT statt je UID: steht
 * für dieses Objekt eine Löschung aus (#1861)?
 *
 * Eine UID allein sagt das nicht. Derselbe Termin kann in zwei Kalendern eines
 * Kontos liegen - nach einem Umzug, dessen Quelle das Löschen abgelehnt hat.
 * Der Auftrag gilt dann genau dem Objekt in der Quelle; über die UID verdeckte
 * er auch die Kopie im Ziel, und der Abruf sähe deren Änderungen nicht mehr.
 *
 * Ein Auftrag nennt seinen Kalender, und der entscheidet. Nur wo er fehlt,
 * entscheidet die Adresse, und zwar wörtlich: gleiche Adresse oder nicht. Ist
 * eine der beiden Adressen unbekannt, bleibt das Objekt verdeckt - lieber eine
 * Runde zu lang verborgen als ein gelöschter Termin, der zurückkommt.
 *
 * Ein BEDINGTER Auftrag (`isConditionalDeletion`, #1883) verdeckt enger: nur
 * das Objekt an seiner Adresse, und nur in dem Stand, für den er vorgemerkt
 * wurde. Liegt der Termin dort inzwischen anders oder im selben Kalender unter
 * einer anderen Adresse, ist das nicht mehr der Rest eines Umzugs, sondern der
 * Termin selbst (auf einem anderen Gerät zurückgelegt): der Abruf übernimmt
 * ihn, und `processPendingDeletions` verwirft den Auftrag im selben Lauf.
 * Liefert der Server zu dem Objekt keinen ETag, bleibt es verdeckt; dann
 * entscheidet die Vorbedingung am DELETE.
 *
 * @returns {(uid: string, calendarUrl: string, objectUrl?: string|null, etag?: string|null) => boolean}
 */
export function pendingDeletionGuard(source, { accountId = null } = {}) {
  const filter = accountFilter(source, accountId, 'pendingDeletionGuard');
  if (!filter) return () => false;
  let rows;
  try {
    rows = db.get().prepare(`
      SELECT event_external_id, calendar_external_id, object_url, etag
      FROM calendar_pending_deletions WHERE source = ?${filter.sql}
    `).all(source, ...filter.args);
  } catch (err) {
    log.warn(`Pending deletions are not readable (${err.message}); treating them as none.`);
    return () => false;
  }
  const byUid = new Map();
  for (const row of rows) {
    if (!byUid.has(row.event_external_id)) byUid.set(row.event_external_id, []);
    byUid.get(row.event_external_id).push(row);
  }
  return (uid, calendarUrl, objectUrl = null, etag = null) => (byUid.get(uid) || []).some((row) => {
    if (row.calendar_external_id && row.calendar_external_id !== calendarUrl) return false;
    if (isConditionalDeletion(row) && objectUrl) {
      return row.object_url === objectUrl && (!etag || row.etag === etag);
    }
    if (row.calendar_external_id) return true;
    if (!row.object_url || !objectUrl) return true;
    return row.object_url === objectUrl;
  });
}

/**
 * Gilt dieser Auftrag nur einem Objekt in einem bestimmten Stand (#1883)?
 * Dazu braucht er beides, Adresse und ETag.
 */
export function isConditionalDeletion(row) {
  return !!(row?.etag && row?.object_url);
}

/**
 * Merkt eine Löschung vor, deren erster Versuch gerade abgelehnt wurde (#1861):
 * die Quelle eines Umzugs, die ihr Objekt nicht hergibt. Die Absage zählt als
 * Versuch, wie bei jeder anderen abgelehnten Löschung.
 *
 * Steht für dieselbe UID in demselben Kalender schon ein Auftrag DESSELBEN
 * Kontos, behält er seine Adresse (`queueDeletion`) und zählt die Absage; der
 * Lauf findet das Objekt über seinen Abruf, auch wenn die ältere Adresse nicht
 * mehr stimmt.
 *
 * Gehört der bestehende Auftrag einem ANDEREN CalDAV-Konto (zwei Konten
 * führen denselben Kalender), bleibt er unberührt: weder Zähler noch
 * Fehlertext noch Adresse. Der Schlüssel der Tabelle kennt das Konto nicht,
 * einen zweiten Auftrag kann dieses Konto also nicht anlegen - dann `false`,
 * und der Aufrufer lässt seine eigene Arbeit offen.
 *
 * `target.etag` (#1883): der Stand des Objekts, an das das abgelehnte DELETE
 * ging. Mit ihm wartet der Auftrag nur auf dieses Objekt in diesem Stand.
 *
 * @returns {boolean} true, wenn die Absage an einem Auftrag dieses Kontos gezählt ist
 */
export function queueRefusedDeletion(target, err) {
  const forCaldav = target.source === 'caldav';
  const key = [target.source, target.calendarExternalId || '', target.eventExternalId];
  if (forCaldav) {
    // Lesen und Schreiben ohne await dazwischen.
    const existing = db.get().prepare(`
      SELECT caldav_account_id FROM calendar_pending_deletions
      WHERE source = ? AND calendar_external_id = ? AND event_external_id = ?
    `).get(...key);
    if (existing && existing.caldav_account_id != null && existing.caldav_account_id !== target.accountId) return false;
  }
  if (!queueDeletion(target)) return false;
  db.get().prepare(`
    UPDATE calendar_pending_deletions SET attempts = attempts + 1, last_error = ?
    WHERE source = ? AND calendar_external_id = ? AND event_external_id = ?${forCaldav ? ' AND caldav_account_id = ?' : ''}
  `).run(String(err?.message || err).slice(0, 500), ...key, ...(forCaldav ? [target.accountId] : []));
  return true;
}

/**
 * Nimmt den Löschauftrag für das Objekt eines Termins in EINEM Kalender zurück
 * (#1861): der Termin ist gerade dorthin gezogen, sein Objekt dort ist also
 * gewollt. Ohne das träfe ein Auftrag aus einem früheren Umzug in die
 * Gegenrichtung genau dieses Objekt, und der Termin wäre überall fort.
 * Für 'caldav' nur der Auftrag des Kontos, das umgezogen hat.
 */
export function dropDeletionsIn({ source, calendarExternalId, eventExternalId, accountId = null }) {
  if (!source || !calendarExternalId || !eventExternalId) return 0;
  const filter = accountFilter(source, accountId, 'dropDeletionsIn');
  if (!filter) return 0;
  return Number(db.get().prepare(`
    DELETE FROM calendar_pending_deletions
    WHERE source = ? AND calendar_external_id = ? AND event_external_id = ?${filter.sql}
  `).run(source, calendarExternalId, eventExternalId, ...filter.args).changes) || 0;
}

/**
 * Räumt CalDAV-Löschaufträge ab, die keinem Konto gehören (#1860): Bestand,
 * den Migration 238 nicht sicher zuordnen konnte. Es gibt kein Konto, über das
 * sie gesendet werden dürften, und ohne dieses Abräumen blieben sie für immer
 * liegen. Der Termin kann danach einmal zurückkommen.
 * @returns {number} Zahl der abgeräumten Aufträge
 */
export function dropDeletionsWithoutAccount() {
  let removed = 0;
  try {
    removed = Number(db.get().prepare(
      "DELETE FROM calendar_pending_deletions WHERE source = 'caldav' AND caldav_account_id IS NULL"
    ).run().changes) || 0;
  } catch (err) {
    log.warn(`Pending deletions are not readable (${err.message}); nothing was cleared.`);
    return 0;
  }
  if (removed) {
    log.warn(`Dropped ${removed} pending deletion(s) that belong to no CalDAV account; the event(s) may come back once.`);
  }
  return removed;
}

/**
 * Räumt die Löschaufträge ab, deren Kalender es auf dem Server nicht mehr gibt
 * (#1884): mit dem Kalender ist auch das Objekt fort, der Auftrag hat sein
 * Ziel erreicht. Ohne das wartete er für immer - der Lauf liest einen
 * verschwundenen Kalender nie wieder (er schaltet ihn ab), und ein Auftrag
 * ohne gespeicherte Adresse hat keinen anderen Weg.
 *
 * `listedUrls` ist die Auflistung DIESES Laufs und muss vom Aufrufer als
 * brauchbar befunden sein: eine leere gilt bei allen Anbietern als
 * unvollständige Antwort, nicht als leeres Konto, und darf hier nicht ankommen.
 * Dieselbe Auflistung schaltet auch einen eingeschalteten Kalender ab, der in
 * ihr fehlt. Verglichen wird ohne Rücksicht auf den Schlussstrich.
 *
 * Ohne Anfrage an den Server. Taucht der Kalender doch wieder auf (die
 * Auflistung war unvollständig), kann der gelöschte Termin einmal zurückkommen.
 *
 * @param {string} source 'caldav' | 'apple'
 * @param {object} p
 * @param {number} [p.accountId]  bei CalDAV das Konto, dessen Auflistung das ist
 * @param {Iterable<string>} p.listedUrls  jede Collection, die der Server nennt
 * @returns {number} abgeräumte Aufträge
 */
export function dropDeletionsOfMissingCalendars(source, { accountId = null, listedUrls }) {
  const listed = [...(listedUrls || [])];
  if (listed.length === 0) return 0;
  let rows;
  try {
    rows = pendingDeletions(source, { accountId });
  } catch (err) {
    log.warn(`Pending deletions are not readable (${err.message}); nothing was cleared.`);
    return 0;
  }
  const gone = new Map();
  for (const row of rows) {
    const calendarUrl = row.calendar_external_id;
    if (!calendarUrl || listed.some((url) => sameCalendarUrl(url, calendarUrl))) continue;
    dropDeletion(row.id);
    gone.set(calendarUrl, (gone.get(calendarUrl) || 0) + 1);
  }
  let dropped = 0;
  for (const [calendarUrl, count] of gone) {
    dropped += count;
    log.warn(`[${source === 'apple' ? 'Apple' : 'CalDAV'}] Calendar ${calendarUrl} no longer exists on the server: dropped ${count} pending deletion(s) for it, its entries are gone with it.`);
  }
  return dropped;
}

/**
 * Wie viele Löschaufträge dieses Kontos warten, weil ihr Kalender abgewählt
 * ist (#1884)? Für die Meldung des Laufs.
 * @param {(calendarUrl: string) => boolean} isSelected
 */
export function deletionsWaitingForSelection(source, { accountId = null, isSelected }) {
  return pendingDeletions(source, { accountId })
    .filter((row) => row.calendar_external_id && !isSelected(row.calendar_external_id)).length;
}

export function dropDeletion(id) {
  db.get().prepare('DELETE FROM calendar_pending_deletions WHERE id = ?').run(id);
}

export function failDeletion(id, err) {
  db.get().prepare(
    'UPDATE calendar_pending_deletions SET attempts = attempts + 1, last_error = ? WHERE id = ?'
  ).run(String(err?.message || err).slice(0, 500), id);
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
/**
 * Der Inline-Marker fuer gespiegelte Termine, deren Zeile schon in der Hand
 * ist und die ueber EINE uebergebene Verbindung geschrieben werden muss
 * (housekeeping.js, birthdays.js). Anders als `markEventOutbound` laeuft er
 * nicht ueber `db.get()` und lehnt keinen schreibgeschuetzten Provider ab: der
 * Marker ist auch der Schutz davor, dass der Inbound die lokale Aenderung
 * ueberschreibt (`if (existing?.outbound_dirty) continue`).
 *
 * Nimmt ein gespiegelter CalDAV-Termin OHNE Konto (#1860) teil, wird nichts
 * vorgemerkt: er wird nie gesendet, und der Marker hielte die Zeile sonst von
 * der Uebernahme durch das naechste Konto fern. Der Aufrufer entscheidet
 * VORHER, ob ein gespiegeltes Feld sich geaendert hat; diese Funktion
 * entscheidet, OB die Zeile ueberhaupt vormerkbar ist, und schreibt dann.
 *
 * @param {object} database  die Verbindung, in der auch der Termin liegt
 * @param {{id:number, external_source:string, external_calendar_id:?string, caldav_account_id:?number}} event
 * @returns {boolean} true, wenn vorgemerkt wurde
 */
export function markInlineOutbound(database, event) {
  if (!event || !OUTBOUND_SOURCES.includes(event.external_source) || !event.external_calendar_id) return false;
  if (event.external_source === 'caldav' && event.caldav_account_id == null) return false;
  database.prepare(
    'UPDATE calendar_events SET outbound_dirty = 1, outbound_attempts = 0 WHERE id = ?'
  ).run(event.id);
  return true;
}

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

/** @param {{accountId?: number|null}} [scope] für 'caldav' Pflicht */
export function pendingUpdates(source, { accountId = null } = {}) {
  const filter = accountFilter(source, accountId, 'pendingUpdates');
  if (!filter) return [];
  return db.get().prepare(`
    SELECT * FROM calendar_events
    WHERE (outbound_dirty = 1 OR outbound_move_to IS NOT NULL)
      AND external_source = ? AND external_calendar_id IS NOT NULL${filter.sql}
    ORDER BY id
  `).all(source, ...filter.args);
}

export function pendingUpdateCount(source, { accountId = null } = {}) {
  const filter = accountCountFilter(source, accountId);
  return db.get().prepare(`
    SELECT COUNT(*) AS c FROM calendar_events
    WHERE (outbound_dirty = 1 OR outbound_move_to IS NOT NULL)
      AND external_source = ? AND external_calendar_id IS NOT NULL${filter.sql}
  `).get(source, ...filter.args).c;
}

/**
 * Wartende Arbeit an CalDAV-Zeilen, die keinem Konto gehören (#1860): eine
 * Bearbeitung von vor Migration 238 an einer Zeile, die sie nicht sicher
 * zuordnen konnte. Gesendet wird sie nie - es gibt kein Konto, über das sie
 * hinausdürfte. Übernommen wird die Zeile aber auch nicht, solange etwas an
 * ihr wartet, sonst ginge die Bearbeitung an das Konto, das zufällig zuerst
 * ihre UID liefert.
 *
 * Damit sie nicht für immer wartet, zählt jeder Lauf einen Versuch, meldet es
 * einmal und gibt nach MAX_OUTBOUND_ATTEMPTS auf. Danach ist die Zeile sauber,
 * und das nächste Konto, das ihre UID liefert, übernimmt sie mit dem Stand des
 * Servers.
 * @returns {number} Zahl der Zeilen, an denen noch etwas wartet
 */
export function ageUpdatesWithoutAccount() {
  let rows;
  try {
    rows = db.get().prepare(`
      SELECT id, outbound_attempts FROM calendar_events
      WHERE external_source = 'caldav' AND caldav_account_id IS NULL
        AND (outbound_dirty = 1 OR outbound_move_to IS NOT NULL)
      ORDER BY id
    `).all();
  } catch (err) {
    log.warn(`Pending changes are not readable (${err.message}); nothing was counted.`);
    return 0;
  }
  let waiting = 0;
  for (const row of rows) {
    if (row.outbound_attempts + 1 >= MAX_OUTBOUND_ATTEMPTS) {
      log.error(`Giving up on the local change of event ${row.id} after ${row.outbound_attempts + 1} run(s): it belongs to no CalDAV account.`);
      clearOutbound(row.id);
    } else {
      failOutbound(row.id);
      waiting++;
    }
  }
  if (waiting) {
    log.warn(`${waiting} local change(s) wait on event(s) that belong to no CalDAV account and are not sent.`);
  }
  return waiting;
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

/**
 * Nimmt der Provider DIESES Events gerade ausgehende Änderungen entgegen?
 *
 * Für CalDAV entscheidet die Zeile, nicht "irgendein Konto existiert" (#1860):
 * gesendet wird nur über das Konto, dem der Termin gehört. Eine Zeile ohne
 * Konto hat keinen Server, an den sie dürfte.
 */
function acceptsOutbound(event) {
  const source = event.external_source;
  if (source === 'google') return !!cfg('google_refresh_token') && cfg('google_readonly') !== '1';
  if (source === 'caldav') {
    if (event.caldav_account_id == null) return false;
    return !!db.get().prepare('SELECT 1 FROM caldav_accounts WHERE id = ?').get(event.caldav_account_id);
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
  // Lokal wird gelöscht, beim Anbieter nicht: ohne Konto gibt es keinen Weg
  // dorthin. Liefert ein Konto die UID weiter, kommt der Termin zurück - dann
  // gehört er diesem Konto und lässt sich dort löschen.
  if (event.external_source === 'caldav' && event.caldav_account_id == null) {
    log.warn(`Event ${event.id} belongs to no CalDAV account, deletion at the provider skipped.`);
    return false;
  }
  if (!acceptsOutbound(event)) return false;

  const calId = calendarExternalId(event, database);
  // Ohne Kalender und ohne Objekt-URL gibt es keinen Weg zum entfernten Objekt.
  if (!calId && !event.external_object_url) {
    log.warn(`No remote calendar known for event ${event.id}, deletion at the provider skipped.`);
    return false;
  }

  const accountId = event.external_source === 'caldav' ? event.caldav_account_id : null;
  const queued = queueDeletion({
    source:             event.external_source,
    calendarExternalId: calId,
    eventExternalId:    event.external_calendar_id,
    objectUrl:          event.external_object_url || null,
    accountId,
  }, database);
  // Wartet für diesen Termin noch der Rest eines Umzugs in einem ANDEREN
  // Kalender (#1883), gilt für ihn ab jetzt dasselbe wie für die Zeile: der
  // Nutzer will den Termin fort haben, gleich in welchem Stand. Bliebe der
  // Auftrag bedingt, fiele er bei einem geänderten Rest, und der gelöschte
  // Termin käme von dort zurück. Der Schlüssel der Tabelle nennt den
  // Kalender, das ON CONFLICT oben erreicht diesen Auftrag also nicht.
  if (queued) {
    (database || db.get()).prepare(`
      UPDATE calendar_pending_deletions SET etag = NULL
      WHERE source = ? AND event_external_id = ? AND etag IS NOT NULL
        AND caldav_account_id IS ?
    `).run(event.external_source, event.external_calendar_id, accountId);
  }
  return queued;
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
  if (!acceptsOutbound(after)) {
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
 * VOR der Anfrage wird der Upload notiert (#1882, `caldav-upload-attempts.js`):
 * geht die Antwort verloren, belegt die Notiz, dass von diesem Termin etwas an
 * diesem Platz liegen kann. Sie fällt mit der Buchung (`bookEventUpload`) - der
 * Aufrufer MUSS danach buchen - und nie, weil der Versuch scheiterte.
 *
 * @param {object} attempt
 * @param {string} attempt.source      'caldav' | 'apple'
 * @param {number} attempt.eventId     die Zeile, die hinaufgeht
 * @param {number} [attempt.accountId] bei CalDAV das Konto, über das sie geht
 * @returns {Promise<{objectUrl: string, adopted: boolean}>}
 */
export async function uploadNewEvent(client, calendar, uid, ics, { source, eventId, accountId = null } = {}) {
  const filename      = `${uid}.ics`;
  const collectionUrl = String(calendar.url).replace(/\/?$/, '/');
  const objectUrl     = `${collectionUrl}${filename}`;
  const place = { source, accountId, kind: 'event', rowId: eventId, collectionUrl: calendar.url };
  // Synchron und unmittelbar vor der Anfrage; wirft, wenn Angaben fehlen -
  // dann geht auch nichts hinaus.
  noteUploadAttempt({ ...place, uid, objectUrl });
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
 * `accountId`: bei CalDAV das Konto, über das der Upload lief; ihm gehört der
 * Termin danach.
 *
 * `moveTo`: der Kalender, in den der Termin von hier aus weiterziehen soll
 * (#1881, siehe `bookEventUpload`). Im selben Schreibvorgang vorgemerkt.
 *
 * @returns {boolean} true, wenn die Zeile umgeschrieben wurde
 */
export function markEventUploaded(eventId, { source, uid, objectUrl, calRefId, adopted = false, onlyIfLocal = false, accountId = null, moveTo = null }) {
  // Ein CalDAV-Upload macht die Zeile zum Termin DIESES Kontos (#1860). Die
  // Spalte steht nur im CalDAV-Statement: Apple kennt kein Konto und lässt sie
  // unberührt.
  const forCaldav = source === 'caldav';
  if (forCaldav && accountId == null) {
    log.error(`markEventUploaded('caldav') was called without an account for event ${eventId}. This is a bug in the caller; the row stays local.`);
    return false;
  }
  return db.get().prepare(`
    UPDATE calendar_events
    SET external_source = ?, external_calendar_id = ?, local_calendar_id = NULL,
        external_object_url = ?, calendar_ref_id = ?,${forCaldav ? '\n        caldav_account_id = ?,' : ''}
        color_modified = CASE WHEN color IS NOT NULL THEN 1 ELSE color_modified END,
        outbound_dirty = CASE WHEN ? = 1 THEN 1 ELSE outbound_dirty END,
        outbound_move_to = COALESCE(?, outbound_move_to),
        outbound_attempts = CASE WHEN ? = 1 THEN 0 ELSE outbound_attempts END
    WHERE id = ?
      AND (? = 0 OR external_source = 'local')
  `).run(
    source, uid, objectUrl, calRefId, ...(forCaldav ? [accountId] : []),
    adopted ? 1 : 0, moveTo, adopted || moveTo ? 1 : 0, eventId, onlyIfLocal ? 1 : 0
  ).changes > 0;
}

/**
 * Bucht das Ergebnis eines Uploads - gegen den Stand von JETZT, nicht gegen
 * den, aus dem die Anfrage gebaut wurde (#1862).
 *
 * Zwischen dem Lesen der Zeile und hier liegt die Anfrage an den Server, und
 * in der Zeit läuft die App weiter:
 *
 *   - Die Zeile ist weg: der Nutzer hat den Termin gelöscht. Für eine lokale
 *     Zeile merkt die Löschroute nichts vor (es gab noch nichts zu löschen),
 *     das Objekt läge also für immer oben, und der nächste Abruf holte den
 *     gelöschten Termin als neue Zeile zurück. Das gerade angelegte Objekt
 *     wird deshalb zum Löschen vorgemerkt - bei CalDAV für das Konto, über
 *     das der Upload lief.
 *   - Die Zeile wurde bearbeitet: oben liegt der Stand von vor der
 *     Bearbeitung. Eine lokale Zeile merkt auch das nicht vor. Sie würde zum
 *     sauberen Spiegel, und der nächste Abruf überschriebe die Bearbeitung mit
 *     dem alten Stand. Sie wird Spiegel UND als geändert vorgemerkt.
 *   - Die Zeile ist nicht mehr lokal (ein anderer Weg hat sie inzwischen zum
 *     Spiegel gemacht): nichts wird überschrieben.
 *   - Das Ziel wurde gewechselt (#1881, nur wo ein Termin sein Ziel selbst
 *     trägt, also CalDAV). Eine lokale Zeile merkt auch das nicht vor: die
 *     Route kennt für sie weder Umzug noch Löschung. Gebucht gegen das Ziel
 *     der ANFRAGE, wäre sie sauberer Spiegel in einem Kalender, den niemand
 *     mehr gewählt hat, und das neue Ziel gälte nie - auch ein erneutes
 *     Speichern merkte nichts vor, weil sich dabei kein Ziel mehr ändert.
 *       - Anderer Kalender desselben Kontos: die Zeile wird Spiegel dort, wo
 *         das Objekt liegt, und der Umzug ins neue Ziel ist vorgemerkt.
 *       - Kein Ziel oder ein anderes Konto: das gerade angelegte Objekt wird
 *         zum Löschen vorgemerkt, die Zeile bleibt lokal und behält ihr neues
 *         Ziel. Ein Umzug über Konten hinweg ist kein Umzug (Anlegen und
 *         Löschen laufen über EIN Konto); das andere Konto lädt sie hoch,
 *         wenn es an der Reihe ist.
 *   - Die Zeile wartet gar nicht mehr auf diesen Upload (#1926, nur wo der
 *     Aufrufer das fragen lässt: `wantsUploadHere`). Die alte Apple-Verbindung
 *     kennt kein Ziel am Termin, aber eine Auswahl: hinauf geht, was in keinem
 *     oder im Standardkalender liegt. Wer inzwischen in einen anderen lokalen
 *     Kalender verschoben wurde, bleibt lokal und BEHÄLT ihn - gebucht verlöre
 *     er ihn (ein Spiegel trägt keinen) und läge bei iCloud, obwohl der
 *     Haushalt ihn gerade lokal gestellt hat. Das angelegte Objekt wird zum
 *     Löschen vorgemerkt.
 *
 * Wird die Zeile Spiegel, ist das Objekt an dieser Stelle ab jetzt gewollt:
 * ein Löschauftrag, der aus einem früheren Zielwechsel noch für genau dieses
 * Objekt wartet, fällt (`keepOwnUpload`). Sonst nähme er der Zeile ihr
 * Objekt wieder weg, sobald der Server das Löschen zulässt.
 *
 * Synchron: zwischen dem Nachladen und dem Schreiben liegt kein await, und
 * jeder Ausgang ist EIN Schreibvorgang an der Zeile oder am Löschauftrag.
 *
 * Mit jeder Buchung fällt die Notiz des Uploads (#1882): die Antwort ist
 * angekommen und verarbeitet. Bei `unchanged` bleibt sie stehen - über das
 * Objekt wurde nichts entschieden, das tut `releaseLeftoverUploads` am Stand
 * der Zeile.
 *
 * @param {object} sent  die Zeile, aus der die Anfrage gebaut wurde
 * @param {object} what  wie `markEventUploaded`, dazu `calendarUrl`
 * @param {(row: object) => boolean} [what.wantsUploadHere]  wartet die Zeile
 *   JETZT noch auf diesen Upload? Die Antwort gibt die Auswahl, aus der der
 *   Aufrufer seine Termine nimmt - keine zweite, ähnliche Bedingung hier
 *   (wie `releaseLeftoverUploads`, das dieselbe Frage für den Upload stellt,
 *   dessen Antwort nie ankam). Ohne sie entscheidet allein das Ziel.
 * @returns {'mirrored'|'deleted'|'released'|'unchanged'}
 */
export function bookEventUpload(sent, { source, uid, objectUrl, calRefId, calendarUrl, adopted = false, accountId = null, wantsUploadHere = null }) {
  const booked = () => settleUploadAttempt({ source, accountId, kind: 'event', rowId: sent.id, collectionUrl: calendarUrl });
  const now = reloadEvent(sent.id);
  if (!now) {
    queueDeletion({ source, calendarExternalId: calendarUrl, eventExternalId: uid, objectUrl, accountId });
    booked();
    log.info(`Event ${sent.id} was deleted while its upload was in flight, queued the deletion of ${uid}.`);
    return 'deleted';
  }
  if (now.external_source !== 'local') return 'unchanged';

  const wanted = uploadTargetNow(now, { source, calendarUrl, accountId, wantsUploadHere });
  if (wanted.released) {
    queueDeletion({ source, calendarExternalId: calendarUrl, eventExternalId: uid, objectUrl, accountId });
    booked();
    log.info(`Event ${sent.id} stopped waiting for this upload while it was in flight (its target or its calendar was changed), queued the deletion of ${uid} in ${calendarUrl}.`);
    return 'released';
  }

  // Spiegel und Umzug in EINEM Schreibvorgang: ein Spiegel ohne den Umzug
  // wäre genau der Zustand, den #1881 beschreibt.
  const edited = mirroredFieldsChanged(sent, now);
  const mirrored = markEventUploaded(sent.id, {
    source, uid, objectUrl, calRefId, adopted: adopted || edited, onlyIfLocal: true, accountId,
    moveTo: wanted.moveTo,
  });
  if (!mirrored) return 'unchanged';
  keepOwnUpload({ source, calendarUrl, uid });
  booked();
  if (wanted.moveTo) {
    log.info(`The target of event ${sent.id} was changed while its upload was in flight, queued its move to ${wanted.moveTo}.`);
  }
  return 'mirrored';
}

/**
 * Das Objekt eines eigenen Uploads in diesem Kalender ist ab jetzt gewollt
 * (#1881): Löschaufträge für genau diese UID in genau diesem Kalender fallen.
 *
 * Über ALLE Konten, anders als `dropDeletionsIn`. Die UID ist die dieser
 * Installation für diese eine Zeile, ein Auftrag für sie kann also nur aus
 * einem früheren Upload derselben Zeile stammen - auch der eines ANDEREN
 * Kontos, das denselben Kalender führt: wechselt das Ziel während des Uploads
 * von Konto A auf Konto B mit demselben Kalender, übernimmt B das Objekt, und
 * der Auftrag von A löschte es ihm sonst im nächsten Lauf weg.
 */
function keepOwnUpload({ source, calendarUrl, uid }) {
  if (!source || !calendarUrl || !uid) return;
  // Der Kalender entscheidet, nicht seine Schreibweise: zwei Konten können ihn
  // mit und ohne Schlussstrich führen (wie `keepOwnUpload` der Aufgaben).
  const waiting = db.get().prepare(
    'SELECT id, calendar_external_id FROM calendar_pending_deletions WHERE source = ? AND event_external_id = ?'
  ).all(source, uid);
  for (const row of waiting) {
    if (row.calendar_external_id && sameCalendarUrl(row.calendar_external_id, calendarUrl)) dropDeletion(row.id);
  }
}

/**
 * Wohin will die Zeile JETZT, gemessen an dem Upload, der gerade ankam (#1881)?
 *
 * Ein Ziel trägt nur der CalDAV-Termin: als Paar aus Konto und Kalender.
 * Apple lädt in den ersten verfügbaren Kalender, es gibt nichts zu wechseln -
 * dort entscheidet allein, ob die Zeile überhaupt noch wartet (#1926). Diese
 * Frage beantwortet der Aufrufer aus seiner eigenen Auswahl
 * (`wantsUploadHere`); wer sie nicht stellt, bekommt die Antwort von vorher.
 *
 * @returns {{released: boolean, moveTo: string|null}}
 *   `released`: die Zeile will nicht (mehr) über dieses Konto hinaus;
 *   `moveTo`: sie will in einen anderen Kalender desselben Kontos
 */
function uploadTargetNow(now, { source, calendarUrl, accountId, wantsUploadHere = null }) {
  if (typeof wantsUploadHere === 'function' && !wantsUploadHere(now)) return { released: true, moveTo: null };
  if (source !== 'caldav') return { released: false, moveTo: null };
  const target = now.target_caldav_calendar_url || null;
  if (!target || now.target_caldav_account_id !== accountId) return { released: true, moveTo: null };
  // Derselbe Kalender in anderer Schreibweise (mit und ohne Schlussstrich) ist
  // kein Umzug: der legte im Ziel an und löschte in der Quelle - dasselbe Objekt.
  return { released: false, moveTo: sameCalendarUrl(target, calendarUrl) ? null : target };
}

/** Zwei Schreibweisen derselben Kalender-URL: mit und ohne Schlussstrich. */
export function sameCalendarUrl(a, b) {
  const trim = (url) => String(url || '').replace(/\/+$/, '');
  return trim(a) === trim(b);
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
 * @param {number}   [p.accountId]     CalDAV-Konto, das gerade abgerufen wird
 * @param {(eventId: number) => boolean} p.isWaitingHere
 * @returns {boolean} true, wenn eine Zeile übernommen wurde
 */
export function adoptOwnEventUpload({ source, uid, objectUrl, calendarUrl, calRefId, isWaitingHere, accountId = null }) {
  const eventId = ownUploadRowId(uid, 'event', db.get());
  if (!eventId || !objectUrl || !calendarUrl || typeof isWaitingHere !== 'function') return false;
  // Exakt die UID, die wir für diesen Termin erzeugen würden.
  if (uid !== eventUidFor(eventId)) return false;
  // Das Objekt liegt in dem Kalender, der gerade abgerufen wird - nicht an
  // einer Adresse, die der Server frei gewählt hat.
  if (!sameCalendarUrl(collectionUrlOf(objectUrl), calendarUrl)) return false;
  if (!isWaitingHere(eventId)) return false;

  const adopted = markEventUploaded(eventId, {
    source, uid, objectUrl, calRefId, adopted: true, onlyIfLocal: true, accountId,
  });
  if (adopted) {
    keepOwnUpload({ source, calendarUrl, uid });
    // Übernommen ist gebucht: die Notiz des Uploads fällt (#1882).
    settleUploadAttempt({ source, accountId, kind: 'event', rowId: eventId, collectionUrl: calendarUrl });
    log.info(`Adopted the earlier upload of event ${eventId} (${uid}).`);
  }
  return adopted;
}

// --------------------------------------------------------
// Der Upload, dessen Antwort nie ankam (#1882)
// --------------------------------------------------------

/**
 * Wartet ein lokaler CalDAV-Termin auf den Upload an diesen Platz? Massgeblich
 * ist sein Ziel, das Paar aus Konto und Kalender - nicht, ob der Kalender
 * gerade eingeschaltet ist: ein abgewähltes Ziel bleibt stehen und wartet.
 * iCloud kennt kein Ziel an der Zeile; dort fragt der Aufrufer selbst.
 */
function wantsCaldavUploadAt(row, attempt) {
  return row.target_caldav_account_id === attempt.account_id
    && !!row.target_caldav_calendar_url
    && sameCalendarUrl(row.target_caldav_calendar_url, attempt.collection_url);
}

/**
 * Wie steht die Zeile JETZT zu dem Objekt, das ein nie gebuchter Upload an
 * diesem Platz hinterlassen haben kann?
 *
 *   waiting  - sie ist lokal und will weiter genau dorthin: der nächste Upload
 *              oder der Abruf übernimmt das Objekt.
 *   mirrored - sie ist Spiegel an genau diesem Platz (über einen anderen Weg
 *              gebucht, etwa von einem zweiten Konto mit demselben Kalender,
 *              oder unter der anderen Quelle, wenn derselbe Kalender als
 *              CalDAV-Konto UND über iCloud verbunden ist): das Objekt ist
 *              ihres.
 *   leftover - alles andere: die Zeile ist gelöscht, hat ein anderes oder kein
 *              Ziel, oder ist woanders Spiegel. Dann gehört das Objekt dort zu
 *              nichts mehr, und der Abruf darf es nicht als Termin lesen.
 *
 * Synchron, aus dem Stand von jetzt.
 */
function uploadAttemptState(attempt, wantsUploadHere) {
  const row = reloadEvent(attempt.row_id);
  if (!row) return 'leftover';
  if (row.external_source === 'local') {
    const waiting = wantsUploadHere ? wantsUploadHere(row, attempt.collection_url) : wantsCaldavUploadAt(row, attempt);
    return waiting ? 'waiting' : 'leftover';
  }
  if (row.external_calendar_id === attempt.uid
      && sameCalendarUrl(calendarExternalId(row), attempt.collection_url)) {
    return 'mirrored';
  }
  return 'leftover';
}

/**
 * Für den Abruf: liegt für das Objekt mit dieser UID in diesem Kalender eine
 * Notiz vor, deren Upload nie gebucht wurde und die NICHT schon aufgegangen
 * ist (die Zeile ist nicht Spiegel an diesem Platz)? Dann ist das Objekt kein
 * Eintrag wie jeder andere: der Aufrufer darf es nur noch ÜBERNEHMEN
 * (`adoptOwnEventUpload`, für die Zeile, die genau hier wartet) - sonst weder
 * importieren noch einer Zeile zuordnen. Entfernt wird es von
 * `releaseLeftoverUploads`, für das Konto, dem die Notiz gehört.
 *
 * Über ALLE Konten der Quelle gefragt: führen zwei Konten denselben Kalender,
 * sieht der Abruf des einen das Objekt, das über das andere hinaufging, und
 * importierte den gelöschten Termin sonst für einen Lauf.
 *
 * Der Beleg ist die lokale Notiz, nicht die UID (`caldav-upload-attempts.js`).
 * Ohne Notiz ist das Objekt ein Eintrag wie jeder andere.
 *
 * Frisch je Objekt gefragt, nicht einmal je Lauf: die Zeile kann fallen,
 * während der Lauf noch den Server liest.
 *
 * @param {object} p
 * @param {string} p.source
 * @param {string} p.uid          UID aus dem Serverobjekt
 * @param {string} p.calendarUrl  Kalender, der gerade abgerufen wird
 * @returns {boolean}
 */
export function isUnbookedOwnUpload({ source, uid, calendarUrl }) {
  // Billig zuerst: das Muster der UID, ohne Datenbank. Fast jedes Objekt
  // eines Kalenders scheidet hier aus.
  const parsed = parseOwnUid(uid);
  if (!parsed || parsed.kind !== 'event' || parsed.installation === null) return false;
  let attempts;
  try {
    attempts = uploadAttemptsAt({ source, kind: 'event', uid, collectionUrl: calendarUrl });
  } catch (err) {
    log.warn(`Upload notes are not readable (${err.message}); treating them as none.`);
    return false;
  }
  // `waiting` und `leftover` zählen beide: was mit einer wartenden Zeile
  // geschieht, entscheidet die Übernahme, nicht der Import.
  return attempts.some((attempt) => uploadAttemptState(attempt, () => true) !== 'mirrored');
}

/**
 * Entfernt die Reste von Termin-Uploads, deren Antwort nie ankam (#1882): die
 * Notizen dieser Verbindung, deren Zeile dort nicht mehr hingehört
 * (`uploadAttemptState`). Was dabei gelesen, gelöscht oder stehen gelassen
 * wird, steht an `removeLeftoverUploads`.
 *
 * Aufgerufen im vollen Lauf nach dem Abruf, nicht im Sofortversuch und nicht
 * aus einer Route: die Regel hängt so an keiner Löschroute - gleich auf
 * welchem Weg die Zeile fiel, der nächste Lauf findet die Notiz.
 *
 * @param {object} client
 * @param {object} p
 * @param {string} p.source
 * @param {number} [p.accountId]
 * @param {(row: object, calendarUrl: string) => boolean} [p.wantsUploadHere]
 *        iCloud: will diese lokale Zeile weiter hinauf?
 * @param {Set<string>} [p.calendarUrls]  die in diesem Lauf abgerufenen Kalender
 * @returns {Promise<number>} entfernte Objekte
 */
export function releaseLeftoverUploads(client, { source, accountId = null, wantsUploadHere = null, calendarUrls = null }) {
  return removeLeftoverUploads(client, {
    source, accountId, kinds: ['event'],
    stateOf: (attempt) => uploadAttemptState(attempt, wantsUploadHere),
    inScope: calendarUrls
      ? (url) => [...calendarUrls].some((known) => sameCalendarUrl(known, url))
      : null,
    label: source === 'apple' ? 'Apple' : 'CalDAV',
  });
}
