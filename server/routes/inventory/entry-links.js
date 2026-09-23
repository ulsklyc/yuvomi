/**
 * Modul: Inventar – Buchungsverknuepfungen
 * Zweck: n:m-Verknuepfung zu Budget-Buchungen (Stufe 3). Eigene,
 *        inventarspezifische Helfer statt eines geteilten services/-Moduls,
 *        weil bisher kein anderes Modul diese Kombination (n:m, rollenbehaftet,
 *        budget-sichtbarkeitsgefiltert) braucht - anders als document-links.js,
 *        das von Budget UND Split-Expenses geteilt wird.
 *
 * Sichtbarkeit wie server/routes/budget/helpers.js#budgetFilter():
 * im 'shared'-Modus (Standard) sieht jede:r alles, erst 'personal' filtert
 * nach visibility/owner_id. Kein Admin-Bypass.
 *
 * MIT EINER ABWEICHUNG (#659): fremde 'shared_amount'-Buchungen sind hier
 * unsichtbar, obwohl ihr Betrag anderswo mitzaehlt. Eine Verknuepfung sagt
 * aus, WOFUER das Geld war - also genau das, was die Stufe verbirgt - und
 * anders als bei einem Kontostand fehlt hier keine Summe, wenn die Buchung
 * wegbleibt. Deshalb budgetDetailsVisibleWhere() statt budgetVisibilityWhere().
 *
 * UND NUR MIT LESERECHT AUF DAS BUDGET. Der Pfad gehoert `inventory`, Titel,
 * Betrag und Datum kommen aus `budget`. Jede Funktion hier nimmt deshalb
 * einen `viewer` aus `budgetViewer(req)` statt einer nackten Nutzer-ID: ohne
 * `budget: read` (Mitgliedsrecht UND Token-Scope) gibt es keine Buchung - die
 * Liste bleibt leer, ein Nachschlagen antwortet wie bei einer unbekannten ID.
 * Ohne `viewer` gilt dasselbe, ein vergessener Aufrufer leakt also nichts
 * (Muster wie `documentViewer()` in services/document-links.js).
 *
 * Erwartete (is_pending) Buchungen sind grundsaetzlich nicht verknuepfbar -
 * nicht nur aus der Summe ausgeschlossen (Design-Doc §5.3), sondern gar nicht
 * erst linkbar, damit ein Verknuepfen nie unsichtbar folgenlos bleibt.
 */

import * as db from '../../db.js';
import { resolveBudgetMode, budgetDetailsVisibleWhere } from '../../services/budget-visibility.js';
import { mayReadModule } from '../../permissions.js';

export const ROLES = ['purchase', 'refund', 'instalment', 'maintenance', 'accessory'];

function mode() {
  return resolveBudgetMode(db.get());
}

/**
 * Wer schaut, und darf er das Budget lesen? Einmal je Anfrage gebildet und an
 * jede Funktion dieses Moduls gereicht.
 * @param {import('express').Request} req
 * @returns {{ userId: number, readsBudget: boolean }}
 */
export function budgetViewer(req) {
  return Object.freeze({
    userId: req.authUserId || req.session?.userId,
    readsBudget: mayReadModule(req, 'budget'),
  });
}

const readsBudget = (viewer) => viewer?.readsBudget === true;

/**
 * Liest eine einzelne Buchung, wenn sie fuer diese:n Betrachter:in sichtbar
 * ist - sonst null (bewusst nicht zwischen "existiert nicht" und "fremd"
 * unterschieden, das verriete ueber geratene IDs, welche Buchungen existieren).
 */
export function visibleEntry(entryId, viewer) {
  if (!readsBudget(viewer)) return null;
  const m = mode();
  const clause = budgetDetailsVisibleWhere('be', '?', { mode: m });
  const params = [entryId];
  if (m === 'personal') params.push(viewer.userId);
  return db.get().prepare(`SELECT be.* FROM budget_entries be WHERE be.id = ? AND ${clause}`).get(...params);
}

/**
 * Prueft, ob eine (bereits als sichtbar bestaetigte) Buchung ueberhaupt
 * verknuepfbar ist: keine materialisierte Serieninstanz, bereits gebucht.
 * Eine Stelle fuer beide Regeln, genutzt von linkEntry() UND vom
 * Kaufpreis-Vorbelegungs-Pfad in items.js#POST / - kann so nie auseinanderlaufen.
 * @returns {{error:string, code:number}|null}
 */
export function linkabilityError(entry) {
  if (entry.recurrence_parent_id != null) {
    return { error: 'Cannot link a generated recurrence instance - link the series entry instead.', code: 400 };
  }
  if (entry.is_pending) {
    return { error: 'Cannot link an expected booking that has not been booked yet.', code: 400 };
  }
  return null;
}

/** Fuer die Kaufpreis-Vorbelegung (Design-Doc §5.6): hat diese Buchung bereits irgendeine Verknuepfung? */
export function entryHasLinks(entryId) {
  return db.get().prepare('SELECT 1 FROM inventory_item_entries WHERE entry_id = ?').get(entryId) != null;
}

/**
 * Verknuepft eine Buchung mit einem Gegenstand.
 * @returns {{ok:true}|{error:string, code:number}}
 */
export function linkEntry({ itemId, entryId, role, amountShare, viewer }) {
  const entry = visibleEntry(entryId, viewer);
  if (!entry) return { error: 'Booking not found.', code: 404 };
  const linkError = linkabilityError(entry);
  if (linkError) return linkError;

  const existing = db.get().prepare(`
    SELECT id FROM inventory_item_entries WHERE item_id = ? AND entry_id = ? AND role = ?
  `).get(itemId, entryId, role);
  if (existing) return { error: 'This booking is already linked with this role.', code: 409 };

  db.get().prepare(`
    INSERT INTO inventory_item_entries (item_id, entry_id, role, amount_share, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(itemId, entryId, role, amountShare ?? null, viewer.userId);
  return { ok: true };
}

/**
 * Entfernt alle Verknuepfungen zwischen einem Gegenstand und einer Buchung
 * (rollenunabhaengig - der Pfad hat kein Rollen-Segment).
 * @returns {{ok:true}|{error:string, code:number}}
 */
export function unlinkEntry({ itemId, entryId, viewer }) {
  const entry = visibleEntry(entryId, viewer);
  if (!entry) return { error: 'Booking not found.', code: 404 };
  db.get().prepare('DELETE FROM inventory_item_entries WHERE item_id = ? AND entry_id = ?').run(itemId, entryId);
  return { ok: true };
}

/**
 * Verknuepfte, sichtbare, gebuchte Buchungen mehrerer Gegenstaende in einer
 * Abfrage (kein N+1 in Listen). Map itemId -> Buchungen, neueste zuerst.
 */
export function loadLinkedEntriesForItems(itemIds, viewer) {
  const ids = [...new Set((itemIds || []).filter((id) => Number.isInteger(id) && id > 0))];
  const byItem = new Map();
  if (!ids.length || !readsBudget(viewer)) return byItem;

  const m = mode();
  const visClause = budgetDetailsVisibleWhere('be', '?', { mode: m });
  const placeholders = ids.map(() => '?').join(', ');
  const params = [...ids];
  if (m === 'personal') params.push(viewer.userId);

  const rows = db.get().prepare(`
    SELECT iie.item_id AS itemId, iie.id, iie.entry_id, iie.role, iie.amount_share, iie.created_at,
           be.title, be.amount, be.date
    FROM inventory_item_entries iie
    JOIN budget_entries be ON be.id = iie.entry_id
    WHERE iie.item_id IN (${placeholders}) AND be.is_pending = 0 AND ${visClause}
    ORDER BY be.date DESC, iie.id DESC
  `).all(...params);

  for (const { itemId, ...link } of rows) {
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId).push(link);
  }
  return byItem;
}

/** Verknuepfte Buchungen eines einzelnen Gegenstands. */
export function loadLinkedEntries(itemId, viewer) {
  return loadLinkedEntriesForItems([itemId], viewer).get(itemId) || [];
}

/** Vorzeichenbehaftete Summe ueber die (bereits gebucht/sichtbar gefilterten) Verknuepfungen. */
export function computeTotal(links) {
  return links.reduce((sum, link) => sum + link.amount, 0);
}
