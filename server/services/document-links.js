/**
 * Modul: Dokument-Verknuepfungen
 * Zweck: Die eine Mechanik, mit der ein Datensatz Dokumente aus dem
 *        Dokumente-Modul als Beleg traegt (#583).
 *
 * Genutzt von Budget-Buchungen (budget_entry_attachments), geteilten Ausgaben
 * (expense_attachments, settlements.proof_document_id), Inventar
 * (inventory_item_documents) und dem Beleg eines Hauswirtschafts-Besuchs.
 * Alle haben dieselbe Form: Besitzer-Spalte, document_id, created_by - und
 * dieselben drei Regeln, die hier stehen statt je Modul:
 *
 *   1. Verknuepfen kann man nur, was man sehen darf. Sonst liesse sich ueber
 *      geratene IDs der Name eines fremden Dokuments auslesen, indem man es
 *      anhaengt und den Datensatz neu laedt.
 *   2. Entfernen kann man nur, was man sieht. Sonst raeumte das Speichern
 *      eines geteilten Datensatzes den privaten Beleg einer anderen Person
 *      weg, den das Formular nie angezeigt hat.
 *   3. Name und ID eines Belegs gehoeren dem Dokumente-Modul, nicht dem
 *      Datensatz (#1358). Der Pfad-Guard in server/index.js urteilt am ersten
 *      Pfadsegment (`/budget`, `/inventory`, ...) und fragt nie nach
 *      `documents`. Ohne Leserecht dort (Mitgliedsrecht `documents: none` oder
 *      ein Token ohne documents:read) kommt ein Beleg deshalb MASKIERT: die
 *      Zeile bleibt als "da ist einer", Name und ID sind `null`. Verknuepfen
 *      ist dann fuer JEDE ID dieselbe 403 - auch fuer die schon gespeicherte
 *      und fuer eine, die es nicht gibt; unterschiedliche Antworten waeren ein
 *      Orakel fuer die maskierte ID. Eine leere Liste ist kein Verknuepfen und
 *      loest nach Regel 2 nichts, weil ohne Leserecht nichts sichtbar ist.
 *
 * Die Sichtbarkeit des einzelnen Dokuments kommt aus document-access.js, die
 * Modulachse aus `mayReadDocuments()` hier - EINE Stelle fuer beide Achsen
 * (Mitgliedsrecht und Token-Scope), die jeder Aufrufer ueber
 * `documentViewer(req)` bekommt statt sie nachzubauen.
 */

import { hiddenModulesFor } from '../permissions.js';
import { documentVisibleSql, filterVisibleDocumentIds } from './document-access.js';
import { assertDocumentsNotDeleting } from './document-deletion-lock.js';

/** Felder, die ein Beleg preisgibt. Bewusst ohne Dateiinhalt. */
const DOCUMENT_COLUMNS = 'd.name, d.original_name, d.mime_type, d.file_size';

/** Dieselben Felder in maskierter Form: der Beleg ist da, mehr nicht. */
const MASKED_DOCUMENT = Object.freeze({
  document_id: null, name: null, original_name: null, mime_type: null, file_size: null,
});

/**
 * Darf diese Anfrage das Dokumente-Modul LESEN? Beide Achsen in einem Aufruf:
 * das Modulrecht des Mitglieds und der Scope eines API-Tokens
 * (`hiddenModulesFor`). Die eine Stelle fuer diese Frage bei Belegen (#1358).
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function mayReadDocuments(req) {
  return !hiddenModulesFor(req, ['documents']).has('documents');
}

/**
 * Wer schaut, und darf er Dokumente lesen? Einmal je Anfrage gebildet und an
 * jede Funktion dieses Moduls gereicht. Ohne `viewer` gilt die maskierte Form -
 * ein Aufrufer, der ihn vergisst, leakt deshalb nichts.
 * @param {import('express').Request} req
 * @returns {{ userId: number, readsDocuments: boolean }}
 */
export function documentViewer(req) {
  return Object.freeze({
    userId: req.authUserId || req.session?.userId,
    readsDocuments: mayReadDocuments(req),
  });
}

const readsDocuments = (viewer) => viewer?.readsDocuments === true;

/** Abweisung einer Verknuepfung ohne Leserecht auf die Dokumente (Regel 3). */
export class DocumentLinkRefusedError extends Error {
  constructor() {
    super('Linking a document requires access to documents.');
    this.name = 'DocumentLinkRefusedError';
  }
}

/** Beantwortet eine Abweisung aus Regel 3; `false`, wenn `err` keine ist. */
export function sendDocumentLinkRefusal(res, err) {
  if (!(err instanceof DocumentLinkRefusedError)) return false;
  res.status(403).json({ error: err.message, code: 403 });
  return true;
}

/**
 * Belege mehrerer Datensaetze in einer Abfrage (kein N+1 in Listen).
 *
 * Nicht sichtbare Dokumente fallen heraus, statt als leere Huelle zu
 * erscheinen: Wer den Beleg nicht sehen darf, soll auch nicht erfahren, dass
 * es ihn gibt. Ohne Leserecht auf das Dokumente-Modul kommen die sichtbaren
 * maskiert (Regel 3).
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {object} options
 * @param {string} options.table - Verknuepfungstabelle
 * @param {string} options.ownerColumn - Spalte mit der ID des Datensatzes
 * @param {number[]} options.ownerIds
 * @param {{ userId: number, readsDocuments: boolean }} options.viewer - aus `documentViewer(req)`
 * @param {string[]} [options.extraColumns] - zusaetzliche Spalten der Verknuepfung
 * @returns {Map<number, object[]>} owner-ID → Belege
 */
export function loadDocumentLinks(database, { table, ownerColumn, ownerIds, viewer, extraColumns = [] }) {
  const ids = [...new Set((ownerIds || []).filter((id) => Number.isInteger(id) && id > 0))];
  const byOwner = new Map();
  if (!ids.length) return byOwner;

  const placeholders = ids.map(() => '?').join(', ');
  const extra = extraColumns.length ? `, ${extraColumns.map((c) => `a.${c}`).join(', ')}` : '';
  const rows = database.prepare(`
    SELECT a.${ownerColumn} AS ownerId, a.id, a.document_id, a.created_at${extra}, ${DOCUMENT_COLUMNS}
    FROM ${table} a
    JOIN family_documents d ON d.id = a.document_id
    WHERE a.${ownerColumn} IN (${placeholders}) AND ${documentVisibleSql('d')}
    ORDER BY a.id ASC
  `).all(...ids, { userId: viewer?.userId ?? null });

  const reads = readsDocuments(viewer);
  for (const { ownerId, ...attachment } of rows) {
    if (!byOwner.has(ownerId)) byOwner.set(ownerId, []);
    byOwner.get(ownerId).push(reads ? attachment : { ...attachment, ...MASKED_DOCUMENT });
  }
  return byOwner;
}

/**
 * Belege eines einzelnen Datensatzes.
 * @returns {object[]}
 */
export function documentLinksFor(database, { table, ownerColumn, ownerId, viewer, extraColumns }) {
  return loadDocumentLinks(database, { table, ownerColumn, ownerIds: [ownerId], viewer, extraColumns })
    .get(ownerId) || [];
}

/**
 * Setzt die Belege eines Datensatzes auf die uebergebene Dokumentenliste.
 * Siehe die drei Regeln im Modulkopf.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {object} options
 * @param {string} options.table
 * @param {string} options.ownerColumn
 * @param {number} options.ownerId
 * @param {any} options.documentIds - Rohwert aus dem Request-Body
 * @param {{ userId: number, readsDocuments: boolean }} options.viewer
 * @param {object} [options.extraValues] - konstante Zusatzspalten beim Insert
 */
export function replaceDocumentLinks(database, { table, ownerColumn, ownerId, documentIds, viewer, extraValues = {} }) {
  const wanted = assertDocumentLinkTargetsAvailable(database, documentIds, viewer);
  // Ohne Leserecht ist nichts sichtbar - also auch nichts zu entfernen.
  if (!readsDocuments(viewer)) return;

  const visibleExisting = database.prepare(`
    SELECT a.document_id
    FROM ${table} a
    JOIN family_documents d ON d.id = a.document_id
    WHERE a.${ownerColumn} = @ownerId AND ${documentVisibleSql('d')}
  `).all({ ownerId, userId: viewer.userId }).map((row) => row.document_id);

  const keep = new Set(wanted);
  const remove = visibleExisting.filter((id) => !keep.has(id));

  const extraNames = Object.keys(extraValues);
  const columns = [ownerColumn, 'document_id', 'created_by', ...extraNames];
  const insert = database.prepare(`
    INSERT OR IGNORE INTO ${table} (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `);
  const drop = database.prepare(
    `DELETE FROM ${table} WHERE ${ownerColumn} = ? AND document_id = ?`
  );

  database.transaction(() => {
    for (const documentId of remove) drop.run(ownerId, documentId);
    for (const documentId of wanted) {
      insert.run(ownerId, documentId, viewer.userId, ...extraNames.map((name) => extraValues[name]));
    }
  })();
}

/**
 * Prüft Ziel-Dokumente vor einem Schreibvorgang und gibt die sichtbaren IDs
 * zurück. Ohne Leserecht auf die Dokumente wirft eine nicht leere Liste
 * `DocumentLinkRefusedError` - VOR der Sichtbarkeit und der Loeschsperre,
 * damit keine ID anders antwortet als eine andere (Regel 3).
 */
export function assertDocumentLinkTargetsAvailable(database, documentIds, viewer) {
  const requested = Array.isArray(documentIds) ? documentIds : [];
  if (!readsDocuments(viewer)) {
    if (requested.length) throw new DocumentLinkRefusedError();
    return [];
  }
  const visibleIds = filterVisibleDocumentIds(database, requested, viewer.userId);
  assertDocumentsNotDeleting(visibleIds);
  return visibleIds;
}

/**
 * Prueft eine einzelne optionale Dokument-Referenz (z. B. settlements.proof_document_id).
 * Ein fehlender oder leerer Wert ist kein Verknuepfen.
 * @returns {number|null} die ID, wenn sichtbar - sonst null
 */
export function visibleDocumentRef(database, rawId, viewer) {
  if (rawId === undefined || rawId === null || rawId === '') return null;
  return assertDocumentLinkTargetsAvailable(database, [rawId], viewer)[0] ?? null;
}

/**
 * Lesende Gegenstelle zu `visibleDocumentRef`: eine gespeicherte Referenz, wie
 * sie diesem Betrachter gezeigt werden darf - die ID, wenn er das Dokumente-
 * Modul lesen darf und das Dokument sieht, sonst `null`.
 * @returns {number|null}
 */
export function documentRefForViewer(database, storedId, viewer) {
  if (storedId == null || !readsDocuments(viewer)) return null;
  return filterVisibleDocumentIds(database, [storedId], viewer.userId)[0] ?? null;
}
