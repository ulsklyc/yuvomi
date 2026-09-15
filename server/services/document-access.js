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
export function documentVisibleSql(alias = 'd', param = 'userId') {
  return `(
    ${alias}.created_by = @${param}
    OR ${alias}.visibility = 'family'
    OR EXISTS (
      SELECT 1 FROM family_document_access a
      WHERE a.document_id = ${alias}.id AND a.user_id = @${param}
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
export function filterVisibleDocumentIds(database, ids, userId) {
  const wanted = [...new Set((ids || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0))];
  if (!wanted.length) return [];

  const placeholders = wanted.map(() => '?').join(', ');
  const visible = new Set(database.prepare(`
    SELECT d.id FROM family_documents d
    WHERE d.id IN (${placeholders}) AND ${documentVisibleSql('d')}
  `).all(...wanted, { userId }).map((row) => row.id));

  return wanted.filter((id) => visible.has(id));
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
export function canManageDocument(document, { userId, isAdmin }) {
  return isAdmin || document.created_by === userId;
}
