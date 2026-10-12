// --------------------------------------------------------
// Der Beleg für einen Upload, dessen Ergebnis noch nicht gebucht ist (#1882).
//
// Ein hier angelegter Eintrag geht per PUT auf einen CalDAV-Server. Kommt die
// Antwort an, wird gebucht (`bookEventUpload`, `bookTodoUpload`). Kommt sie
// NICHT an, liegt das Objekt womöglich trotzdem oben - und lokal stand bisher
// nichts, was das sagte. Solange die Zeile weiter auf denselben Platz wartet,
// fängt die Übernahme das auf (`adoptOwnEventUpload`, `adoptOwnUpload`). Wird
// sie vorher gelöscht oder bekommt sie ein anderes Ziel, wusste niemand mehr,
// dass dort etwas von ihr liegt.
//
// Deshalb wird jeder Upload VOR der Anfrage notiert: welche Zeile, über
// welches Konto, an welchen Platz, unter welcher UID und Adresse. Die Notiz
// fällt, sobald das Ergebnis gebucht ist. Steht sie noch, ist die Antwort nie
// angekommen, und der nächste Lauf entscheidet am Stand der Zeile und am
// Stand des Servers, was mit dem Objekt geschieht (`removeLeftoverUploads`).
//
// WARUM EINE NOTIZ UND NICHT DIE UID. Die UID eines Objekts kommt vom Server
// und weist nichts aus (`server/utils/own-uid.js`). Ein Objekt zu löschen, nur
// weil seine UID auf eine Zeile dieser Installation zeigt, die es nicht (mehr)
// gibt, träfe nach dem Einspielen eines älteren Backups die Einträge, die
// danach entstanden sind. Die Notiz ist lokaler Stand: sie belegt, dass genau
// diese Zeile an genau diesen Platz geschickt wurde.
//
// DIE NOTIZ FÄLLT NIE BEI EINEM FEHLSCHLAG. Eine Absage sagt nur etwas über
// DIESEN Versuch; von einem früheren, dessen Antwort verloren ging, kann das
// Objekt trotzdem dort liegen. Und sie belegt nur den VERSUCH: was heute an
// der Adresse liegt, wird gelesen, bevor dort etwas gelöscht wird.
//
// Geschrieben und gelesen wird nur innerhalb eines serialisierten Durchgangs
// (`server/utils/sync-lock.js`), synchron und ohne await dazwischen.
// --------------------------------------------------------

import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { inspectObjectAt } from '../utils/own-uid.js';

const log = createLogger('CalDAV-Upload-Notes');

/** Zwei Schreibweisen derselben Collection-URL: mit und ohne Schlussstrich. */
function samePlace(a, b) {
  const trim = (url) => String(url || '').replace(/\/+$/, '');
  return trim(a) === trim(b);
}

function assertAttempt({ source, kind, rowId, collectionUrl, uid, objectUrl }) {
  if (!source || !kind || !rowId || !collectionUrl || !uid || !objectUrl) {
    throw new Error('Upload attempt is incomplete: source, kind, row, collection, UID and address are all required.');
  }
}

/**
 * Notiert einen Upload, unmittelbar bevor seine Anfrage hinausgeht. Wer das
 * nicht kann (unvollständige Angaben, CalDAV ohne Konto), schickt auch nichts:
 * der Fehler geht hoch, und der Eintrag bleibt lokal.
 */
export function noteUploadAttempt(attempt) {
  assertAttempt(attempt);
  const { source, accountId = null, kind, rowId, collectionUrl, uid, objectUrl } = attempt;
  if (source === 'caldav' && accountId == null) {
    throw new Error('Upload attempt for CalDAV needs the account it goes through.');
  }
  db.get().prepare(`
    INSERT INTO caldav_upload_attempts (source, account_id, kind, row_id, collection_url, uid, object_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, COALESCE(account_id, 0), kind, row_id, collection_url)
      DO UPDATE SET uid = excluded.uid, object_url = excluded.object_url,
                    created_at = excluded.created_at
  `).run(source, accountId, kind, rowId, collectionUrl, uid, objectUrl);
}

/**
 * Das Ergebnis des Uploads an diesen Platz ist gebucht: die Notiz fällt.
 * Auch in der anderen Schreibweise des Platzes.
 *
 * Wirft nie. Wer bucht, hat die Zeile schon umgeschrieben; scheiterte er hier
 * (gedriftete Datenbank ohne die Tabelle), meldete der Aufrufer einen Fehler
 * für etwas, das gelungen ist. Ohne Tabelle gab es auch keine Notiz.
 * @returns {number} entfernte Notizen
 */
export function settleUploadAttempt({ source, accountId = null, kind, rowId, collectionUrl }) {
  let removed = 0;
  try {
    for (const attempt of uploadAttemptsOf({ source, accountId, kinds: [kind], rowId })) {
      if (!samePlace(attempt.collection_url, collectionUrl)) continue;
      dropUploadAttempt(attempt.id);
      removed++;
    }
  } catch (err) {
    log.warn(`Upload notes are not writable (${err.message}); none was settled.`);
  }
  return removed;
}

/**
 * Die Verbindung selbst fällt weg (iCloud getrennt, CalDAV-Konto gelöscht):
 * ohne sie gibt es keinen Weg mehr zu den Objekten, von denen die Notizen
 * handeln. Für ein CalDAV-Konto tut das auch der Fremdschlüssel; hier steht
 * es ausdrücklich, damit es nicht davon abhängt, dass er durchgesetzt wird.
 * @returns {number} entfernte Notizen
 */
export function dropUploadAttemptsOf({ source, accountId = null }) {
  try {
    return Number(db.get().prepare(
      'DELETE FROM caldav_upload_attempts WHERE source = ? AND account_id IS ?'
    ).run(source, accountId).changes) || 0;
  } catch (err) {
    log.warn(`Upload notes are not writable (${err.message}); none was dropped.`);
    return 0;
  }
}

export function dropUploadAttempt(id) {
  db.get().prepare('DELETE FROM caldav_upload_attempts WHERE id = ?').run(id);
}

/**
 * Die offenen Notizen einer Verbindung, optional für eine Zeile oder eine UID.
 * @param {object} q
 * @param {string}   q.source
 * @param {number}   [q.accountId]  bei CalDAV das Konto; iCloud kennt keines
 * @param {string[]} q.kinds        'event' | 'task' | 'item'
 * @param {number}   [q.rowId]
 * @param {string}   [q.uid]
 */
export function uploadAttemptsOf({ source, accountId = null, kinds, rowId = null, uid = null }) {
  return db.get().prepare(`
    SELECT id, source, account_id, kind, row_id, collection_url, uid, object_url, created_at
    FROM caldav_upload_attempts
    WHERE source = ? AND account_id IS ?
      AND kind IN (${kinds.map(() => '?').join(',')})
      AND (? IS NULL OR row_id = ?)
      AND (? IS NULL OR uid = ?)
    ORDER BY id
  `).all(source, accountId, ...kinds, rowId, rowId, uid, uid);
}

/**
 * Alle Notizen für dieses Objekt an diesem Platz - über ALLE Konten der
 * Quelle. Zwei Konten können denselben Kalender führen, und der Abruf des
 * einen sieht das Objekt, das über das andere hinaufging: ob es als Eintrag
 * gelesen werden darf, hängt nicht davon ab, wessen Abruf gerade läuft.
 */
export function uploadAttemptsAt({ source, kind, uid, collectionUrl }) {
  return db.get().prepare(`
    SELECT id, source, account_id, kind, row_id, collection_url, uid, object_url, created_at
    FROM caldav_upload_attempts
    WHERE source = ? AND kind = ? AND uid = ?
    ORDER BY id
  `).all(source, kind, uid).filter((attempt) => samePlace(attempt.collection_url, collectionUrl));
}

/** Gibt es für diese Zeile eine Notiz an diesem Platz dieses Kontos? */
export function hasUploadAttempt({ source, accountId = null, kind, rowId, collectionUrl }) {
  return uploadAttemptsOf({ source, accountId, kinds: [kind], rowId })
    .some((attempt) => samePlace(attempt.collection_url, collectionUrl));
}

// --------------------------------------------------------
// Der Rest eines nie gebuchten Uploads wird entfernt
// --------------------------------------------------------

/**
 * So lange nach dem letzten Versuch kann ein PUT, dessen Antwort ausblieb,
 * beim Server noch ankommen. Gemessen (test:caldav-own-uid, "der PUT wird erst
 * gespeichert, NACHDEM ..."): der Client hat aufgegeben, der Eintrag wird
 * gelöscht, ein Lauf findet nichts vor - und danach liegt das Objekt doch
 * oben. Fiele die Notiz mit dem ersten "liegt nicht dort", käme der gelöschte
 * Eintrag damit zurück. Sie bleibt deshalb diese Frist lang stehen und
 * verdeckt ihr Objekt, sobald es auftaucht.
 *
 * Ein Tag: weit über jedem Zeitlimit eines Servers oder Proxys, und der Preis
 * ist eine Zeile in einer Tabelle. Dieselbe Frist begrenzt, wie lange ein
 * abgelehntes Löschen wiederholt wird.
 */
export const UPLOAD_NOTE_GRACE_MS = 24 * 60 * 60 * 1000;

function isExpired(attempt, now) {
  const noted = Date.parse(attempt.created_at);
  return !Number.isFinite(noted) || now - noted > UPLOAD_NOTE_GRACE_MS;
}

function attemptById(id) {
  return db.get().prepare(`
    SELECT id, source, account_id, kind, row_id, collection_url, uid, object_url, created_at
    FROM caldav_upload_attempts WHERE id = ?
  `).get(id) ?? null;
}

/**
 * Entfernt die Reste von Uploads, deren Antwort nie ankam: für jede stehen
 * gebliebene Notiz dieser Verbindung wird am Stand der Zeile entschieden
 * (`stateOf`: 'waiting' | 'mirrored' | 'leftover'), und für einen Rest am
 * Stand des SERVERS - gelesen wird das Objekt an genau der Adresse, an die der
 * Upload ging (`inspectObjectAt`), unmittelbar bevor etwas geschieht:
 *
 *   - dort liegt das Objekt mit der UID des Uploads: DELETE an diese Adresse,
 *     mit dem gerade gelesenen ETag als If-Match. Die Notiz fällt, wenn es
 *     fort ist. Ohne Bedingung an den INHALT: der Eintrag ist in Yuvomi
 *     gelöscht oder gehört dort nicht mehr hin, gleich was eine andere App
 *     inzwischen daran geändert hat. Ändert es sich zwischen Lesen und
 *     Löschen, antwortet der Server 412 und der nächste Durchgang liest neu.
 *   - dort liegt ein Objekt mit FREMDER UID: nicht unseres. Nichts wird
 *     gelöscht, die Notiz fällt - sie belegt den Versuch, nicht, was heute an
 *     der Adresse liegt.
 *   - dort liegt nichts: der PUT kam nie an, oder er ist noch unterwegs. Die
 *     Notiz bleibt bis zum Ende der Frist (`UPLOAD_NOTE_GRACE_MS`) und fällt
 *     dann ohne Anfrage.
 *
 * Kein Löschauftrag in `calendar_pending_deletions` bzw.
 * `caldav_todo_pending_deletions`: deren Aufträge gehen ohne diesen Blick an
 * die gespeicherte Adresse, auch im Sofortversuch, und gelten nach einem 404
 * als erledigt. Beides ist für ein Objekt falsch, von dem lokal nur ein
 * Versuch belegt ist.
 *
 * Nach jedem await wird die Notiz neu gelesen und ihr Stand in einem
 * synchronen Schritt neu entschieden, bevor geschrieben oder gesendet wird.
 *
 * @param {object} client  tsdav-Client der Verbindung
 * @param {object} p
 * @param {string}   p.source
 * @param {number}   [p.accountId]
 * @param {string[]} p.kinds
 * @param {(attempt: object) => 'waiting'|'mirrored'|'leftover'} p.stateOf
 * @param {(collectionUrl: string) => boolean} [p.inScope]  nur Reste an Plätzen,
 *        die dieser Durchgang führt (eingeschaltete Kalender bzw. Listen);
 *        alles andere bleibt unberührt stehen
 * @param {(attempt: object) => boolean} [p.keepWhileRefused]  Reste, deren
 *        Notiz auch NACH der Frist stehen bleibt, solange der Server das
 *        Entfernen ablehnt: die Zeile ist anderswo Spiegel DERSELBEN UID, und
 *        ohne die Notiz läse der Abruf zwei Objekte für eine Zeile
 * @param {(attempt: object) => Promise<boolean>} [p.beforeRemove]  letzte
 *        Frage vor dem DELETE eines Rests, an dessen Adresse das Objekt mit
 *        der UID des Uploads liegt: `false` lässt Objekt und Notiz stehen (der
 *        Aufrufer hat selbst entschieden, was mit der Notiz geschieht). Wirft
 *        sie, wird nichts entfernt und die Notiz bleibt.
 * @param {string} p.label  für das Log
 * @returns {Promise<number>} entfernte Objekte
 */
export async function removeLeftoverUploads(client, { source, accountId = null, kinds, stateOf, inScope = null, keepWhileRefused = null, beforeRemove = null, label }) {
  let attempts;
  try {
    attempts = uploadAttemptsOf({ source, accountId, kinds });
  } catch (err) {
    log.warn(`Upload notes are not readable (${err.message}); nothing was released.`);
    return 0;
  }
  let removed = 0;
  for (const listed of attempts) {
    const first = stateOf(listed);
    if (first === 'waiting') continue;
    if (first === 'mirrored') { dropUploadAttempt(listed.id); continue; }
    if (inScope && !inScope(listed.collection_url)) continue;

    let found;
    try {
      found = await inspectObjectAt(client, listed.collection_url, listed.object_url, listed.uid);
    } catch (err) {
      log.warn(`[${label}] Could not read ${listed.object_url} (${err.message}); the leftover of an unconfirmed upload stays noted.`);
      continue;
    }

    // Nach dem await: Notiz und Zeile von jetzt.
    const attempt = attemptById(listed.id);
    if (!attempt) continue;
    const state = stateOf(attempt);
    if (state === 'waiting') continue;
    if (state === 'mirrored') { dropUploadAttempt(attempt.id); continue; }

    if (found.foreign) {
      log.info(`[${label}] Another entry lives at ${attempt.object_url}, the address of an unconfirmed upload; nothing is removed there.`);
      dropUploadAttempt(attempt.id);
      continue;
    }
    if (!found.own) {
      if (isExpired(attempt, Date.now())) dropUploadAttempt(attempt.id);
      continue;
    }

    if (beforeRemove) {
      let allowed;
      try {
        allowed = await beforeRemove(attempt);
      } catch (err) {
        log.warn(`[${label}] Could not confirm that ${attempt.uid} may be removed at ${attempt.object_url} (${err.message}); nothing is removed there.`);
        continue;
      }
      // Nach dem await: Notiz und Zeile von jetzt.
      const still = attemptById(attempt.id);
      if (!allowed || !still || stateOf(still) !== 'leftover') continue;
    }

    try {
      await client.deleteCalendarObject({ calendarObject: { url: attempt.object_url, etag: found.own.etag } });
    } catch (err) {
      const status = err?.status;
      if (status !== 404 && status !== 410) {
        if (isExpired(attempt, Date.now()) && !(keepWhileRefused && keepWhileRefused(attempt))) {
          log.error(`[${label}] Giving up on removing ${attempt.uid}, the leftover of an unconfirmed upload: ${err.message}`);
          dropUploadAttempt(attempt.id);
        } else {
          log.warn(`[${label}] Could not remove ${attempt.uid}, the leftover of an unconfirmed upload (${err.message}); tried again on the next pass.`);
        }
        continue;
      }
    }
    // Das Objekt ist fort. Die Notiz fällt über ihre Id: was an der Zeile
    // während des DELETE geschah, ändert daran nichts mehr.
    dropUploadAttempt(attempt.id);
    removed++;
    log.info(`[${label}] The upload of ${attempt.kind} ${attempt.row_id} to ${attempt.collection_url} was never confirmed and the entry no longer belongs there, removed ${attempt.uid}.`);
  }
  return removed;
}
