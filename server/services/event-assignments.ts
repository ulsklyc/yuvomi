/**
 * Event assignments: the one write path for who is assigned to a calendar event.
 *
 * Moved out of server/routes/calendar/helpers.js so the calendar syncs
 * (sync-assignment.js, ics-subscription.js) no longer import a route module;
 * helpers.js re-exports setEventAssignments for the calendar routes and the tests.
 * syncAttachmentDocumentAccess had no caller outside this path and is module-private.
 * The code and its comments moved verbatim; no behaviour changed.
 */

import type { Database } from '../authorize/index.ts';
import {
  applyDocumentAccess,
  attachmentAccessMode,
  eventAudienceChanged,
} from '../authorize/index.ts';
import {
  fanOutEventReminders, dropInheritedEventReminders, eventAuthorId,
} from './event-reminder-fanout.js';

/** A caller's verdict on widening an attachment document (see attachmentAccessMode()). */
type WidenVerdict = (documentId: unknown) => unknown;

type AttachmentAccessOptions = {
  mayWiden?: WidenVerdict;
  grantAssignees?: boolean;
  before?: { visibility?: string | null; userIds?: readonly unknown[] | null } | null;
  attachmentSet?: boolean;
};

type EventAssignmentOptions = {
  mayWidenAttachment?: WidenVerdict;
  grantAssigneesOnly?: boolean;
  previous?: { visibility?: string | null } | null;
  attachmentSet?: boolean;
};

/**
 * Das Anhang-Dokument folgt Sichtbarkeit und Zuweisung des Termins - aber nur,
 * wenn `mayWiden(documentId)` das zugesteht: `true` (Dokumente schreiben, das
 * Dokument sehen UND verwalten, #1358) gleicht voll ab, `ATTACHMENT_NARROW_ONLY`
 * (in diesem Schreiben neu hochgeladen) verengt nur. Sonst bleibt das Dokument,
 * wie die Besitzerin es gesetzt hat (#1443): `applyDocumentAccess()` in
 * authorize/rows/documents.ts.
 *
 * UND NUR, WENN SICH DAS PUBLIKUM AENDERT (#1443): `before` ist, wer den Termin
 * vor diesem Speichern sah (`{ visibility, userIds }`, `null` fuer einen neuen
 * Termin). Bleibt es gleich, bleibt auch das Dokument - ausser der Anhang ist
 * in diesem Speichern neu gesetzt (`attachmentSet`), denn ein neues Anhang-
 * Dokument entsteht als `family` und bekommt seine Rechte erst hier.
 */
function syncAttachmentDocumentAccess(d: Database, documentId: unknown, eventVisibility: string | null | undefined, userIds: readonly unknown[], {
  mayWiden = () => false, grantAssignees = false, before = null, attachmentSet = false,
}: AttachmentAccessOptions = {}): void {
  if (!documentId) return;
  if (!attachmentSet && !eventAudienceChanged(before, { visibility: eventVisibility, userIds })) return;
  const visibility = eventVisibility === 'private'
    ? 'private'
    : eventVisibility === 'assignees'
      ? 'restricted'
      : 'family';
  applyDocumentAccess(d, documentId, {
    visibility, userIds, ...attachmentAccessMode(mayWiden(documentId)), grantAssignees,
  });
}

/**
 * `options.mayWidenAttachment` kommt vom Aufrufer (`attachmentRights()` in
 * crud.js); ohne ihn bleibt das Anhang-Dokument unangetastet (#1443).
 * `options.grantAssigneesOnly` (Standard-Zuweisung der Kalender-Syncs): der
 * Sync aendert Dokumentrechte nie, ausser dass an einem Termin fuer
 * Zugewiesene ein schon eingeschraenktes Dokument die Zugewiesenen als
 * Freigabe dazubekommt - nichts wird `family`, nichts Privates geht auf,
 * nichts wird enger, keine Freigabe faellt weg.
 *
 * Das Dokument wird nur abgeglichen, wenn sich in diesem Speichern aendert, wer
 * den Termin sieht (#1443). Die Zugewiesenen davor liest diese Funktion selbst;
 * die Sichtbarkeit davor kennt nur der Aufrufer, der sie schreibt:
 *   - `options.previous: { visibility }` - der Stand vor dem UPDATE;
 *   - `options.previous: null` - ein neuer Termin, immer abgleichen;
 *   - ohne `previous` - der Aufrufer aendert die Sichtbarkeit nicht (Syncs).
 * `options.attachmentSet`: der Anhang ist in diesem Speichern neu gesetzt.
 */
export function setEventAssignments(d: Database, eventId: unknown, userIds: readonly unknown[], {
  mayWidenAttachment, grantAssigneesOnly = false, previous, attachmentSet = false,
}: EventAssignmentOptions = {}): void {
  // Wer VORHER dranstand - gebraucht wird das eine Zeile weiter unten, um die
  // Erinnerungen derer abzuraeumen, die nicht mehr dranstehen (#921). Deshalb
  // hier und nicht erst nach dem DELETE, das die Auskunft vernichtet.
  const before = (d.prepare('SELECT user_id FROM event_assignments WHERE event_id = ?')
    .all(eventId) as { user_id: unknown }[]).map((r) => r.user_id);

  d.prepare('DELETE FROM event_assignments WHERE event_id = ?').run(eventId);
  const ins = d.prepare('INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)');
  for (const uid of userIds) ins.run(eventId, uid);

  /* DIE ERINNERUNGEN FOLGEN DER ZUWEISUNG (#921).
   *
   * Hier und nicht in den beiden Routen, die diese Funktion rufen: eine
   * Zuweisung, die die Erinnerung NICHT mitbringt, meldet sich nicht - sie
   * aeussert sich als ein Termin, von dem jemand nichts erfahren hat. Genau so
   * war der Fall gemeldet. An der einen Schreibstelle kann kein Aufrufer sie
   * vergessen.
   *
   * Beim ANLEGEN eines Termins ist hier noch nichts zu verteilen: das Formular
   * speichert erst den Termin und dann die Erinnerungen, und der zweite Schritt
   * fuehrt denselben Abgleich noch einmal aus. Beide Wege enden gleich. */
  const author = eventAuthorId(d, eventId);
  const removed = before.filter((uid) => !userIds.includes(uid));
  dropInheritedEventReminders(d, eventId, removed);
  if (author !== null) fanOutEventReminders(d, eventId, author);

  const event = d.prepare(`
    SELECT attachment_document_id, visibility
    FROM calendar_events
    WHERE id = ?
  `).get(eventId) as { attachment_document_id: unknown; visibility: string | null } | undefined;
  syncAttachmentDocumentAccess(
    d,
    event?.attachment_document_id,
    event?.visibility,
    userIds,
    {
      mayWiden: mayWidenAttachment,
      grantAssignees: grantAssigneesOnly,
      before: previous === null ? null : { visibility: previous?.visibility ?? event?.visibility, userIds: before },
      attachmentSet,
    },
  );
}
