/**
 * Modul: Meldung "Umzug zurückgenommen" (#1912)
 * Zweck: Geht der Umzug eines gespiegelten Einkaufsartikels zurück (fünfte
 *        Absage des Ziels, Zielliste auf dem Server fort, Frist aus #1911),
 *        erfährt es die Person, die verschoben hat - an der Glocke, als
 *        sofort fällige Erinnerung `shopping_move_returned`.
 * Abhängigkeiten: server/permissions.js, server/services/account-state.js
 *
 * EINE MOMENTAUFNAHME, KEIN VERWEIS: nach der Frist steht der Artikel auf einer
 * abgeschalteten Liste, und der nächste Abruf nimmt ihn dort lokal fort. Die
 * Meldung trägt deshalb die Namen von Artikel und Listen selbst
 * (`shopping_move_notices`, Migration 260); die Verweise tragen nur den Sprung
 * auf die Liste.
 */

import { resolvePermissions } from '../permissions.js';
import { activeAccountSql } from './account-state.js';

/**
 * Legt Meldung und Erinnerung an - nur für die Person, die verschoben hat. Ohne
 * bekannte Person (Umzug von vor dem Update, Konto gelöscht oder
 * deaktiviert) oder ohne Einkaufsrecht bleibt es beim Log des Aufrufers.
 * Synchron, in der Transaktion des Rückwegs.
 *
 * @param {object} database
 * @param {{movedBy: number|null, itemId: number, itemName: string,
 *          backListId: number, targetListId: number, reason: 'refused'|'waited'}} notice
 * @returns {number|null} die Kennung der Meldung
 */
export function noteMoveTakenBack(database, { movedBy, itemId, itemName, backListId, targetListId, reason }) {
  if (!movedBy) return null;
  const user = database.prepare(
    `SELECT id, role, family_role FROM users WHERE id = ? AND ${activeAccountSql('users')}`
  ).get(movedBy);
  if (!user || resolvePermissions(database, user).modules.shopping === 'none') return null;
  const listName = (id) => database.prepare('SELECT name FROM shopping_lists WHERE id = ?').get(id)?.name ?? '';
  const noticeId = Number(database.prepare(`
    INSERT INTO shopping_move_notices (user_id, item_id, item_name, back_list_id, back_list_name, target_list_name, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(movedBy, itemId, itemName, backListId, listName(backListId), listName(targetListId), reason === 'waited' ? 'waited' : 'refused').lastInsertRowid);
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('shopping_move_returned', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)
  `).run(noticeId, movedBy);
  return noticeId;
}

/**
 * Die Felder, die eine `shopping_move_returned`-Zeile für Glocke und Push
 * braucht. Verzögert und nur für solche Zeilen geholt, nicht in den
 * Sammelabfragen: dort wird jeder Zweig beim Prepare geprüft, auch in
 * Testschemata ohne diese Tabelle.
 *
 * @returns {{item_name: string, back_list_id: number|null, back_list_name: string,
 *            target_list_name: string, reason: string}|null}
 */
export function moveNoticeFields(database, noticeId) {
  try {
    return database.prepare(`
      SELECT item_name, back_list_id, back_list_name, target_list_name, reason
        FROM shopping_move_notices WHERE id = ?
    `).get(noticeId) ?? null;
  } catch {
    return null;
  }
}

