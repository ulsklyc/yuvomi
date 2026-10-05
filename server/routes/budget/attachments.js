/**
 * Modul: Budget-Tracker - Belege
 * Zweck: Verknuepfung zwischen Buchungen und Dokumenten aus dem Dokumente-Modul (#583).
 *
 * Ein Beleg ist immer ein Dokument in family_documents - das Budget speichert
 * keine Dateien selbst. Damit gilt fuer Belege dieselbe Sichtbarkeit wie im
 * Dokumente-Modul, und ein Beleg bleibt dort auffindbar, auch wenn die Buchung
 * geloescht wird.
 *
 * Die Mechanik steckt in services/document-links.js und wird mit den geteilten
 * Ausgaben geteilt; hier stehen nur die Tabellennamen dieses Moduls. `viewer`
 * ist ueberall `documentViewer(req)` von dort: wer schaut, und ob er das
 * Dokumente-Modul lesen darf (#1358).
 */

import * as db from '../../db.js';
import {
  documentLinksFor, documentLinksOf, loadDocumentLinks, replaceDocumentLinks,
} from '../../services/document-links.js';

const TABLE = { table: 'budget_entry_attachments', ownerColumn: 'entry_id' };

/**
 * Belege einer einzelnen Buchung.
 * @param {number} entryId
 * @param {{ userId: number, readsDocuments: boolean }} viewer
 * @returns {object[]|null} `null` ohne Leserecht auf die Dokumente (#1358)
 */
export function attachmentsFor(entryId, viewer) {
  return documentLinksFor(db.get(), { ...TABLE, ownerId: entryId, viewer });
}

/**
 * Haengt die Belege an eine Eintragsliste an (fuer GET-Antworten).
 * @param {object[]} entries
 * @param {{ userId: number, readsDocuments: boolean }} viewer
 * @returns {object[]} dieselben Eintraege, jeweils mit `attachments` (`null`
 *          ohne Leserecht auf die Dokumente: weder Belege noch ihre Anzahl)
 */
export function withAttachments(entries, viewer) {
  const byEntry = loadDocumentLinks(db.get(), { ...TABLE, ownerIds: entries.map((e) => e.id), viewer });
  return entries.map((entry) => ({ ...entry, attachments: documentLinksOf(byEntry, entry.id, viewer) }));
}

/**
 * Setzt die Belege einer Buchung auf die uebergebene Dokumentenliste.
 * @param {number} entryId
 * @param {any} rawDocumentIds - Rohwert aus dem Request-Body
 * @param {{ userId: number, readsDocuments: boolean }} viewer
 */
export function replaceAttachments(entryId, rawDocumentIds, viewer) {
  replaceDocumentLinks(db.get(), { ...TABLE, ownerId: entryId, documentIds: rawDocumentIds, viewer });
}
