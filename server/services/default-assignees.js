/**
 * Modul: Standard-Personen einer Sync-Quelle (#1897, #1221)
 * Zweck: Die EINE Lese- und Schreibstelle der Join-Tabellen aus Migration 265.
 *        Ein synchronisierter Kalender (Google, CalDAV, iCloud), ein ICS-Abo
 *        und eine CalDAV-Erinnerungsliste tragen je eine MENGE Personen, die
 *        neue Eintraege dieser Quelle bekommen. Die Reihenfolge ist die der
 *        Wahl; die erste Person wird die primaere Zuweisung (`assigned_to`).
 *
 *        Die alte Spalte `default_assignee_user_id` (Migration 79) liest
 *        niemand mehr; nur das Entfernen eines Kontos leert sie noch. Sie
 *        bleibt stehen, weil Migrationen nicht zurueckgenommen werden.
 *
 *        Verwaiste Personen (Konto geloescht) koennen hier nicht stehen - die
 *        Fremdschluessel raeumen sie ab -, der JOIN auf `users` bleibt trotzdem,
 *        damit eine Datenbank mit ausgeschalteten Fremdschluesseln (Restore,
 *        Testschema) dieselbe Antwort gibt.
 * Abhängigkeiten: server/services/household-members.js
 */

import { newNonMembers, nonMemberMessage } from './household-members.js';

// Die drei Quellen und ihre Tabellen. Feste Bezeichner, nie aus einer Anfrage.
const KINDS = Object.freeze({
  calendar:     { table: 'external_calendar_assignees', key: 'calendar_id' },
  subscription: { table: 'ics_subscription_assignees',  key: 'subscription_id' },
  reminderList: { table: 'caldav_reminder_assignees',   key: 'selection_id' },
});

function kindOf(kind) {
  const k = KINDS[kind];
  if (!k) throw new Error(`Unknown default-assignee source: ${kind}`);
  return k;
}

/**
 * Die Standard-Personen EINER Quelle, in der Reihenfolge der Wahl.
 * @param {object} d better-sqlite3 Datenbank-Handle
 * @param {'calendar'|'subscription'|'reminderList'} kind
 * @param {number|null} ownerId Zeile der Elterntabelle
 * @returns {number[]}
 */
export function readDefaultAssignees(d, kind, ownerId) {
  if (ownerId == null) return [];
  const { table, key } = kindOf(kind);
  return d.prepare(`
    SELECT a.user_id FROM ${table} a JOIN users u ON u.id = a.user_id
    WHERE a.${key} = ? ORDER BY a.position, a.user_id
  `).all(ownerId).map((r) => Number(r.user_id));
}

/**
 * Die Standard-Personen ALLER Quellen einer Art auf einmal - fuer Listen, die
 * je Zeile die Menge zeigen (Einstellungen, Ziel-Auswahl), statt einer Abfrage
 * je Zeile.
 * @param {object} d
 * @param {'calendar'|'subscription'|'reminderList'} kind
 * @returns {Map<number, number[]>} Eltern-Id -> Personen
 */
export function readAllDefaultAssignees(d, kind) {
  const { table, key } = kindOf(kind);
  const map = new Map();
  const rows = d.prepare(`
    SELECT a.${key} AS owner, a.user_id FROM ${table} a JOIN users u ON u.id = a.user_id
    ORDER BY a.${key}, a.position, a.user_id
  `).all();
  for (const r of rows) {
    const owner = Number(r.owner);
    if (!map.has(owner)) map.set(owner, []);
    map.get(owner).push(Number(r.user_id));
  }
  return map;
}

/**
 * Ersetzt die Standard-Personen einer Quelle. Die Aufrufer haben die Ids
 * geprueft (normalizeAssigneeIds, Haushaltsmitglieder); Doppelte fallen hier
 * heraus, die erste Nennung zaehlt.
 * @param {object} d
 * @param {'calendar'|'subscription'|'reminderList'} kind
 * @param {number} ownerId
 * @param {number[]} userIds
 */
export function writeDefaultAssignees(d, kind, ownerId, userIds) {
  const { table, key } = kindOf(kind);
  const ids = [...new Set((userIds ?? []).map(Number))];
  d.transaction(() => {
    d.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).run(ownerId);
    const ins = d.prepare(`INSERT INTO ${table} (${key}, user_id, position) VALUES (?, ?, ?)`);
    ids.forEach((uid, position) => ins.run(ownerId, uid, position));
  })();
}

/**
 * Nimmt ein Konto aus jeder Menge (Entfernen eines Kontos, user-removal.js).
 * Beim Loeschen erledigt das der Fremdschluessel; beim Deaktivieren bleibt die
 * users-Zeile, und die Person soll trotzdem nichts mehr bekommen - wie die
 * alte Spalte, die dort auf NULL ging.
 * @param {object} d
 * @param {number} userId
 */
export function dropDefaultAssignee(d, userId) {
  for (const { table } of Object.values(KINDS)) {
    d.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
  }
}

/**
 * Liest die Personen aus einem Request-Body: `default_assignee_user_ids`
 * (Liste) oder, fuer bestehende Aufrufer, die Altform
 * `default_assignee_user_id` (eine Person oder null). Die Liste gewinnt, wenn
 * beide kommen.
 *
 * @param {object} body
 * @param {{ listField?: string, singleField?: string }} [names]
 * @returns {{ present: false } | { present: true, ids: number[] } | { present: true, error: string }}
 *   `present: false`: der Body nennt keines der Felder (PATCH laesst den Wert stehen).
 */
export function assigneeIdsFromBody(body, {
  listField = 'default_assignee_user_ids',
  singleField = 'default_assignee_user_id',
} = {}) {
  const list = body?.[listField];
  const single = body?.[singleField];
  if (list !== undefined) {
    if (list === null) return { present: true, ids: [] };
    if (!Array.isArray(list)) return { present: true, error: `${listField} must be an array of user ids.` };
    if (list.length > 100) return { present: true, error: `${listField} names too many people.` };
    const ids = [];
    for (const raw of list) {
      const id = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (!Number.isInteger(id) || id < 1) {
        return { present: true, error: `${listField} must be an array of user ids.` };
      }
      if (!ids.includes(id)) ids.push(id);
    }
    return { present: true, ids };
  }
  if (single !== undefined) {
    if (single === null || single === '') return { present: true, ids: [] };
    const id = Number(single);
    if (!Number.isInteger(id) || id < 1) {
      return { present: true, error: `${singleField} must be a number or null.` };
    }
    return { present: true, ids: [id] };
  }
  return { present: false };
}

/**
 * Welche der Ids kein Konto sind - fuer die 400 "unknown user".
 * @param {object} d
 * @param {number[]} ids
 * @returns {number[]}
 */
export function unknownUserIds(d, ids) {
  const exists = d.prepare('SELECT 1 FROM users WHERE id = ?');
  return ids.filter((id) => !exists.get(id));
}

/**
 * Die Ausgabe einer Quelle fuer die API: die Liste und, fuer Aufrufer der
 * Altform, die primaere Person (die erste) als Einzelwert.
 * @param {number[]} ids
 * @returns {{ default_assignee_user_ids: number[], default_assignee_user_id: number|null }}
 */
export function assigneeFields(ids) {
  return { default_assignee_user_ids: ids, default_assignee_user_id: ids[0] ?? null };
}

/**
 * Prueft die Personen eines Request-Bodys fuer eine Quelle - die eine Pruefung
 * fuer Kalender, Abo, Erinnerungsliste und Import:
 *   - eine Liste von Ids (oder die Altform: eine Id oder null),
 *   - jede ein Konto,
 *   - neu nur Haushaltsmitglieder (#1207); wer schon an der Quelle steht
 *     (`stored`), bleibt gueltig, damit sich eine Quelle mit einer
 *     ehemaligen Person weiter speichern laesst.
 *
 * @param {object} d
 * @param {object} body
 * @param {{ stored?: number[], listField?: string, singleField?: string }} [options]
 * @returns {{ present: false } | { present: true, ids: number[] }
 *   | { present: true, error: string, reason: string }}
 */
export function validateAssigneeIds(d, body, { stored = [], listField, singleField } = {}) {
  const parsed = assigneeIdsFromBody(body, { listField, singleField });
  if (!parsed.present) return parsed;
  if (parsed.error) return { present: true, error: parsed.error, reason: 'calendar_assignee_invalid' };
  const unknown = unknownUserIds(d, parsed.ids);
  if (unknown.length) {
    return { present: true, error: `Unknown user ID: ${unknown.join(', ')}.`, reason: 'calendar_assignee_unknown' };
  }
  const strangers = newNonMembers(parsed.ids, { stored, db: d });
  if (strangers.length) {
    return { present: true, error: nonMemberMessage(strangers), reason: 'calendar_assignee_not_member' };
  }
  return parsed;
}
