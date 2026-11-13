/**
 * Module: row visibility and ownership of documents (phase 2, section B3; until then
 *         server/services/document-access.js, moved whole)
 * Purpose: who sees a document of the documents module, who may write a visible one,
 *          and how an attachment follows the audience of the event it hangs on.
 *
 * Dependencies: none (the connection is a parameter). Erasable TS syntax only (runs
 * through type stripping, no build).
 */

import type { Database } from '../catalog.ts';

/** The audience of an event as eventAudienceChanged() compares it. */
type EventAudience = { visibility?: string | null; userIds?: readonly unknown[] | null };

/** The switches of applyDocumentAccess(). */
type DocumentAccessTarget = {
  visibility: string;
  userIds?: readonly unknown[];
  mayWiden?: boolean;
  mayNarrow?: boolean;
  grantAssignees?: boolean;
};

/** What documentWidenPredicate() and documentClonePredicate() know about the caller. */
type AttachmentCaller = { actorId?: number | null; isAdmin?: boolean | null; documentsWritable?: unknown };

/**
 * Modul: Dokument-Sichtbarkeit und -Besitz
 * Zweck: Die eine Regel, wer ein Dokument aus dem Dokumente-Modul sehen darf,
 *        und die eine, wer ein sichtbares Dokument schreiben darf.
 *
 * Sichtbar ist ein Dokument fuer Ersteller:in, bei visibility='family' oder ueber
 * einen expliziten Freigabe-Eintrag (family_document_access).
 *
 * Warum hier und nicht je Modul: Bis #583 stand dieses SQL-Fragment in drei
 * Modulen woertlich nebeneinander (documents, tasks, dms). Jede Kopie war eine
 * Stelle, an der eine kuenftige Aenderung des Sichtbarkeitsmodells haette
 * vergessen werden koennen - und jede vergessene Kopie leakt private Dokumente.
 * Wer Dokumente verknuepft, verknuepft ueber diese Datei.
 */

/**
 * SQL-Fragment fuer die WHERE-Klausel: ist das Dokument fuer @<param> sichtbar?
 * @param {string} alias - Tabellen-Alias der family_documents-Zeile
 * @param {string} param - Name des benannten Bind-Parameters mit der User-ID
 * @returns {string}
 */
export function documentVisibleSql(alias: string = 'd', param: string = 'userId'): string {
  return documentVisibleWhere(alias, `@${param}`);
}

/**
 * The same fragment with the viewer as a bind token ('@me', '?', a column
 * expression), the form visibleWhere('documents', ...) passes on. The text for
 * documentVisibleSql(alias, param) is the one documentVisibleWhere(alias, '@' + param)
 * builds.
 */
export function documentVisibleWhere(alias: string, viewer: string): string {
  return `(
    ${alias}.created_by = ${viewer}
    OR ${alias}.visibility = 'family'
    OR EXISTS (
      SELECT 1 FROM family_document_access a
      WHERE a.document_id = ${alias}.id AND a.user_id = ${viewer}
    )
  )`;
}

/**
 * Reduziert eine Liste von Dokument-IDs auf die, die diese Person sehen darf.
 * Unbekannte und unsichtbare IDs fallen still heraus - der Aufrufer erfaehrt
 * damit nicht, ob eine ID gar nicht existiert oder nur fremd ist.
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {number[]} ids
 * @param {number} userId
 * @returns {number[]} sichtbare IDs, Reihenfolge wie uebergeben, ohne Duplikate
 */
function filterVisibleDocumentIds(database: Database, ids: readonly unknown[] | null | undefined, userId: unknown): number[] {
  return filterVisibleIds(database, 'family_documents', documentVisibleSql('d'), ids, userId);
}

/**
 * The query behind filterVisibleDocumentIds() for any table: `visible` is a
 * fragment over the alias `d` with the viewer bound as `@userId`. filterVisible()
 * (rows/index.ts) passes visibleWhere(type, 'd', '@userId'); for documents that is
 * the text filterVisibleDocumentIds() builds, so both run the same SQL.
 */
export function filterVisibleIds(
  database: Database,
  table: string,
  visible: string,
  ids: readonly unknown[] | null | undefined,
  userId: unknown,
): number[] {
  const wanted = [...new Set((ids || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0))];
  if (!wanted.length) return [];

  const placeholders = wanted.map(() => '?').join(', ');
  const rows = new Set((database.prepare(`
    SELECT d.id FROM ${table} d
    WHERE d.id IN (${placeholders}) AND ${visible}
  `).all(...wanted, { userId }) as { id: number }[]).map((row) => row.id));

  return wanted.filter((id) => rows.has(id));
}

/**
 * Die Besitzregel fuer Schreibzugriffe: ein sichtbares Dokument aendern,
 * archivieren oder loeschen darf, wer es angelegt hat, oder ein Admin.
 * Sichtbarkeit allein reicht nie - ein Familien-Dokument sehen alle.
 *
 * Bis #989 stand die Regel fuenfmal in routes/documents.js: dreimal woertlich
 * an den Einzelrouten, zweimal fuer einen ganzen Ordnerzweig umgestellt. Eine
 * kuenftige Rolle, die Dokumente pflegen darf, aendert diese eine Stelle.
 * @param {{created_by: number}} document
 * @param {{userId: number, isAdmin: boolean}} actor
 * @returns {boolean}
 */
export function canManageDocument(
  document: { created_by?: unknown },
  { userId, isAdmin }: { userId: unknown; isAdmin?: boolean | null },
): boolean {
  return isAdmin || document.created_by === userId;
}

/**
 * Die Sichtbarkeit eines Dokuments aus der eines Datensatzes nachziehen, an dem
 * es als Anhang haengt (Kalender: Termin-Sichtbarkeit und Zugewiesene).
 *
 * NUR, WER DAS DOKUMENT VERWALTEN DARF (#1358, #1443). Bis #1358 kopierte jedes
 * Speichern eines Termins dessen Sichtbarkeit auf das Dokument - auch wenn die
 * Bearbeiterin das Dokument gar nicht sah oder kein Dokumentenrecht hatte. Ein
 * privates Dokument einer anderen Person wurde so mit einem normalen Speichern
 * wieder `family`. Jetzt gilt:
 *   - `mayWiden` (Dokumente schreiben, das Dokument sehen UND es verwalten
 *     duerfen, siehe `documentWidenPredicate()`): die Zielsichtbarkeit gilt wie
 *     bisher, auch weiter als vorher;
 *   - `grantAssignees` (Abgleich der Standard-Zuweisung durch die Kalender-
 *     Syncs, ohne Person dahinter): aendert Dokumentrechte nie, ausser dass
 *     an einem Termin fuer Zugewiesene ein schon eingeschraenktes Dokument
 *     die Zugewiesenen als Freigabe dazubekommt. Nichts wird `family`, ein
 *     privates Dokument bleibt zu, keine Freigabe faellt weg;
 *   - `mayNarrow` (ein Anhang, der in DIESEM Schreiben neu entstanden ist und
 *     der Terminerstellerin gehoert, siehe `ATTACHMENT_NARROW_ONLY`): nur enger,
 *     `family` -> `restricted`/`private`, `restricted` verliert Personen, die
 *     nicht mehr drankommen, `private` bleibt `private`. Niemand bekommt Zugriff,
 *     den er vorher nicht hatte;
 *   - sonst bleibt das Dokument UNANGETASTET (#1443). Auch das Verengen war ein
 *     Eingriff in ein fremdes Dokument: jedes Speichern, auch nur des Titels,
 *     loeschte die Freigaben, die die Besitzerin im Dokumente-Modul gesetzt
 *     hatte, und ein privater Termin machte ihr Dokument privat. Wer ein
 *     Dokument nicht verwalten darf, aendert seine Rechte nicht - wie im
 *     Dokumente-Modul (`canManageDocument`). Wer den Anhang am Termin sieht,
 *     entscheidet ohnehin das Dokument selbst (#1432).
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {number} documentId
 * @param {{ visibility: 'private'|'restricted'|'family', userIds: number[], mayWiden: boolean, mayNarrow: boolean }} target
 */
export function applyDocumentAccess(database: Database, documentId: unknown, {
  visibility, userIds = [], mayWiden = false, mayNarrow = false, grantAssignees = false,
}: DocumentAccessTarget): void {
  if (!documentId) return;
  const current = database.prepare('SELECT visibility FROM family_documents WHERE id = ?').get(documentId) as { visibility: string } | undefined;
  if (!current) return;
  const setVisibility = database.prepare('UPDATE family_documents SET visibility = ? WHERE id = ?');
  const clearAccess = database.prepare('DELETE FROM family_document_access WHERE document_id = ?');
  const grant = database.prepare('INSERT OR IGNORE INTO family_document_access (document_id, user_id) VALUES (?, ?)');
  const wanted = [...new Set(userIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];

  // Der Sync der Standard-Zuweisung (keine Person dahinter) aendert
  // Dokumentrechte NIE - mit einer Ausnahme: an einem Termin fuer Zugewiesene
  // (Ziel `restricted`) bekommt ein schon eingeschraenktes Dokument die neue
  // Person als Freigabe dazu, denn sie sieht den Termin. Sonst bleibt alles,
  // wie die Besitzerin es gesetzt hat: nichts wird enger, nichts weiter, keine
  // Freigabe faellt weg (Re-Review #1432).
  if (grantAssignees && !mayWiden) {
    if (visibility === 'restricted' && current.visibility === 'restricted') {
      for (const userId of wanted) grant.run(documentId, userId);
    }
    return;
  }

  // Weder verwalten noch gerade selbst angelegt: die Rechte der Besitzerin bleiben (#1443).
  if (!mayWiden && !mayNarrow) return;

  if (mayWiden || visibility === 'private' || current.visibility === 'family') {
    // Voller Abgleich: erlaubt, oder das Ziel ist ohnehin enger als/gleich `family`.
    if (!mayWiden && visibility === 'family') return;
    setVisibility.run(visibility, documentId);
    clearAccess.run(documentId);
    if (visibility === 'restricted') for (const userId of wanted) grant.run(documentId, userId);
    return;
  }
  // Ohne Erweiterungsrecht, Dokument ist `private` oder `restricted`.
  if (current.visibility !== 'restricted') return;
  if (visibility === 'family') return;
  // restricted -> restricted: nur Personen herausnehmen, niemanden hinzufuegen.
  const keep = new Set(wanted);
  const existing = (database.prepare('SELECT user_id FROM family_document_access WHERE document_id = ?')
    .all(documentId) as { user_id: number }[]).map((row) => row.user_id);
  const drop = database.prepare('DELETE FROM family_document_access WHERE document_id = ? AND user_id = ?');
  for (const userId of existing) if (!keep.has(userId)) drop.run(documentId, userId);
}

/**
 * Hat sich in diesem Speichern geaendert, wer einen Termin sieht (#1443)? Nur
 * dann gleicht der Kalender das Anhang-Dokument ab - auch fuer die Besitzerin.
 * Bis dahin lief jedes Speichern (auch nur des Titels oder der Zeit) ueber das
 * Dokument und loeschte die Freigaben, die die Besitzerin im Dokumente-Modul an
 * Personen ausserhalb des Termins vergeben hatte.
 *
 * Verglichen wird das Publikum, auf das das Dokument abgeglichen wuerde: die
 * Sichtbarkeit, und die Zugewiesenen nur an einem Termin fuer Zugewiesene - an
 * einem Termin fuer alle oder einem privaten bestimmen sie nichts.
 * `before === null` heisst: es gab keinen Vorzustand (neuer Termin), also
 * abgleichen.
 * @param {{ visibility: string, userIds: number[] } | null} before
 * @param {{ visibility: string, userIds: number[] }} after
 * @returns {boolean}
 */
export function eventAudienceChanged(before: EventAudience | null | undefined, after: EventAudience): boolean {
  if (!before) return true;
  const visibility = before.visibility ?? 'all';
  if (visibility !== (after.visibility ?? 'all')) return true;
  if (visibility !== 'assignees') return false;
  const ids = (list: readonly unknown[] | null | undefined) => new Set((list || []).map(Number).filter((id) => Number.isInteger(id) && id > 0));
  const was = ids(before.userIds);
  const is = ids(after.userIds);
  return was.size !== is.size || [...was].some((id) => !is.has(id));
}

/**
 * Das Urteil eines `mayWiden`-Praedikats fuer einen Anhang, den der Aufrufer in
 * diesem Schreiben selbst hochgeladen hat, ohne ihn zu verwalten (#1443): ein
 * neues Anhang-Dokument entsteht als `family` und gehoert der Terminerstellerin;
 * seine Rechte bekommt es erst aus dem Termin. Dieses Nachziehen darf es nur
 * enger machen - ein Praedikat, das eine ID irrtuemlich fuer neu haelt, oeffnet
 * damit nichts.
 */
export const ATTACHMENT_NARROW_ONLY = 'narrow-only';

/**
 * Uebersetzt das Urteil eines `mayWiden`-Praedikats in die Schalter von
 * `applyDocumentAccess()`: `true` gleicht voll ab, `ATTACHMENT_NARROW_ONLY`
 * verengt nur, alles andere laesst das Dokument unangetastet.
 * @returns {{ mayWiden: boolean, mayNarrow: boolean }}
 */
export function attachmentAccessMode(verdict: unknown): { mayWiden: boolean; mayNarrow: boolean } {
  return { mayWiden: verdict === true, mayNarrow: verdict === ATTACHMENT_NARROW_ONLY };
}

/**
 * Darf dieser Aufrufer ein Anhang-Dokument weiter oeffnen als bisher? Nur mit
 * Dokumente-Schreibrecht (`documentsWritable`, vom Aufrufer aus
 * `mayWriteModule(req, 'documents')`), wenn er das Dokument sieht UND es
 * verwalten darf (`canManageDocument`: Erstellerin oder Admin). Sehen allein
 * reicht nicht - das Dokumente-Modul verweigert einer Nicht-Besitzerin das
 * Aendern der Sichtbarkeit ebenso. Ein Termin-Anhang gehoert der Person, die
 * den Termin angelegt hat (`created_by` des Dokuments), sie behaelt das Recht.
 * @returns {(documentId: number) => boolean}
 */
export function documentWidenPredicate(
  database: Database,
  { actorId, isAdmin = false, documentsWritable }: AttachmentCaller,
): (documentId: number) => boolean {
  return (documentId: number) => {
    if (documentsWritable !== true || actorId == null) return false;
    if (!documentSeenBy(database, documentId, actorId)) return false;
    const document = database.prepare('SELECT created_by FROM family_documents WHERE id = ?').get(documentId) as { created_by: number } | undefined;
    return Boolean(document) && canManageDocument(document as { created_by: number }, { userId: actorId, isAdmin });
  };
}

/**
 * Darf dieser Aufrufer ein Anhang-Dokument KOPIEREN (Split, Abloesen)? Mit
 * Dokumente-Schreibrecht und Sicht auf die Quelle; die Kopie gehoert danach
 * der Besitzerin des Quelldokuments und wird nur von einer Verwalterin weiter
 * geoeffnet.
 * @returns {(documentId: number) => boolean}
 */
export function documentClonePredicate(
  database: Database,
  { actorId, documentsWritable }: AttachmentCaller,
): (documentId: number) => boolean {
  return (documentId: number) => documentsWritable === true
    && actorId != null
    && documentSeenBy(database, documentId, actorId);
}

function documentSeenBy(database: Database, documentId: number, userId: number): boolean {
  return filterVisibleDocumentIds(database, [documentId], userId).length > 0;
}
