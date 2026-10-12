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
// angekommen, und der nächste Lauf entscheidet am Stand der Zeile, was mit dem
// Objekt geschieht (`releaseLeftoverUploads`, `releaseLeftoverTodoUploads`).
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
// Objekt trotzdem dort liegen. Eine Ausnahme: an der eigenen Adresse liegt
// nachweislich ein Objekt mit FREMDER UID - dann liegt dort nicht unseres.
//
// Geschrieben und gelesen wird nur innerhalb eines serialisierten Durchgangs
// (`server/utils/sync-lock.js`), synchron und ohne await dazwischen.
// --------------------------------------------------------

import * as db from '../db.js';

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
      DO UPDATE SET uid = excluded.uid, object_url = excluded.object_url
  `).run(source, accountId, kind, rowId, collectionUrl, uid, objectUrl);
}

/**
 * Das Ergebnis des Uploads an diesen Platz ist gebucht: die Notiz fällt.
 * Auch in der anderen Schreibweise des Platzes.
 * @returns {number} entfernte Notizen
 */
export function settleUploadAttempt({ source, accountId = null, kind, rowId, collectionUrl }) {
  let removed = 0;
  for (const attempt of uploadAttemptsOf({ source, accountId, kinds: [kind], rowId })) {
    if (!samePlace(attempt.collection_url, collectionUrl)) continue;
    dropUploadAttempt(attempt.id);
    removed++;
  }
  return removed;
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
    SELECT id, source, account_id, kind, row_id, collection_url, uid, object_url
    FROM caldav_upload_attempts
    WHERE source = ? AND account_id IS ?
      AND kind IN (${kinds.map(() => '?').join(',')})
      AND (? IS NULL OR row_id = ?)
      AND (? IS NULL OR uid = ?)
    ORDER BY id
  `).all(source, accountId, ...kinds, rowId, rowId, uid, uid);
}

/** Die Notiz für genau dieses Objekt an genau diesem Platz, oder null. */
export function uploadAttemptAt({ source, accountId = null, kind, uid, collectionUrl }) {
  return uploadAttemptsOf({ source, accountId, kinds: [kind], uid })
    .find((attempt) => samePlace(attempt.collection_url, collectionUrl)) ?? null;
}
