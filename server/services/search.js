/**
 * Modul: Such-Service (FTS5)
 * Zweck: Reine Suchlogik gegen den FTS5-Index `search_index` (Migration 44).
 *        Keine Abhängigkeit auf db.js - die Datenbank wird hereingereicht, damit
 *        die Logik direkt mit node:sqlite getestet werden kann.
 */

export const SEARCH_LIMIT = 5;

/**
 * Wandelt eine rohe Nutzereingabe in eine sichere FTS5-MATCH-Query um.
 * Jedes Token wird als Phrase in doppelte Anführungszeichen gesetzt (eingebettete
 * Anführungszeichen verdoppelt) und als Präfix (`*`) gematcht, damit Teiltreffer
 * wie bei der alten LIKE-Suche funktionieren. Tokens werden mit AND verknüpft.
 * Gibt null zurück, wenn nichts Suchbares übrig bleibt.
 */
export function buildMatchQuery(q) {
  const tokens = String(q || '')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]+/gu, ''))
    .filter(Boolean);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
}

/**
 * Führt die Suche aus und liefert dieselbe Ergebnis-Form wie zuvor:
 * { tasks, events, notes, contacts, items }.
 * Pro Entität wird der FTS-Treffer auf die Quelltabelle zurückgejoined,
 * um exakt die alten Felder, Besitzer-Filter und Sortierung zu erhalten.
 */
export function runSearch(database, q, userId) {
  const match = buildMatchQuery(q);
  if (!match) return { tasks: [], events: [], notes: [], contacts: [], items: [] };
  const limit = SEARCH_LIMIT;

  const tasks = database.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date
    FROM search_index s
    JOIN tasks t ON t.id = s.entity_id
    WHERE s.entity = 'task' AND s.search_index MATCH @match
      AND t.parent_task_id IS NULL
      AND (t.created_by = @userId OR t.assigned_to = @userId)
    ORDER BY CASE t.status WHEN 'done' THEN 1 ELSE 0 END,
             t.due_date ASC NULLS LAST
    LIMIT @limit
  `).all({ match, userId, limit });

  const events = database.prepare(`
    SELECT e.id, e.title, e.start_datetime, e.all_day
    FROM search_index s
    JOIN calendar_events e ON e.id = s.entity_id
    WHERE s.entity = 'event' AND s.search_index MATCH @match
      AND e.created_by = @userId
    ORDER BY e.start_datetime ASC
    LIMIT @limit
  `).all({ match, userId, limit });

  const notes = database.prepare(`
    SELECT n.id, n.title, n.content
    FROM search_index s
    JOIN notes n ON n.id = s.entity_id
    WHERE s.entity = 'note' AND s.search_index MATCH @match
      AND n.created_by = @userId
    ORDER BY n.pinned DESC, n.updated_at DESC
    LIMIT @limit
  `).all({ match, userId, limit });

  const contacts = database.prepare(`
    SELECT c.id, c.name AS title
    FROM search_index s
    JOIN contacts c ON c.id = s.entity_id
    WHERE s.entity = 'contact' AND s.search_index MATCH @match
    ORDER BY c.name ASC
    LIMIT @limit
  `).all({ match, limit });

  const items = database.prepare(`
    SELECT i.id, i.name AS title, i.list_id
    FROM search_index s
    JOIN shopping_items i ON i.id = s.entity_id
    WHERE s.entity = 'item' AND s.search_index MATCH @match
    ORDER BY i.name ASC
    LIMIT @limit
  `).all({ match, limit });

  return { tasks, events, notes, contacts, items };
}
