/**
 * Modul: Notiz-Kategorien
 * Zweck: Sichtbarkeit und sichere Zuordnungen fuer persoenliche und
 *        haushaltsweite Kategorien an einer zentralen Stelle erzwingen.
 */

import { categoryNameKey } from '../../public/utils/note-category-name.js';
export { categoryNameKey };

export class NoteCategoryInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'NoteCategoryInputError';
    this.status = status;
  }
}

function normalizedIds(value) {
  if (!Array.isArray(value)) throw new NoteCategoryInputError('category_ids must be an array');
  if (value.length > 50) throw new NoteCategoryInputError('Too many categories');
  const ids = value.map((id) => Number(id));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new NoteCategoryInputError('Invalid category id');
  }
  return [...new Set(ids)];
}

export function listVisibleCategories(database, userId) {
  return database.prepare(`
    SELECT id, name, scope, owner_user_id, sort_order
    FROM note_categories
    WHERE scope = 'household' OR (scope = 'personal' AND owner_user_id = ?)
    ORDER BY CASE scope WHEN 'household' THEN 0 ELSE 1 END,
             sort_order ASC, name COLLATE NOCASE ASC, id ASC
  `).all(userId);
}

export function hydrateNotesWithCategories(database, notes, userId) {
  if (!notes.length) return notes.map((note) => ({ ...note, categories: [] }));
  const noteIds = notes.map((note) => Number(note.id));
  // SQLite builds differ in MAX_VARIABLE_NUMBER. Kleine Batches halten selbst
  // sehr grosse Pinnwaende unter dem konservativen 999-Parameter-Limit.
  const rows = [];
  const chunkSize = 500;
  for (let offset = 0; offset < noteIds.length; offset += chunkSize) {
    const chunk = noteIds.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    rows.push(...database.prepare(`
      SELECT a.note_id, c.id, c.name, c.scope, c.owner_user_id, c.sort_order
      FROM note_category_assignments a
      JOIN note_categories c ON c.id = a.category_id
      WHERE a.note_id IN (${placeholders})
        AND (c.scope = 'household' OR (c.scope = 'personal' AND c.owner_user_id = ?))
      ORDER BY CASE c.scope WHEN 'household' THEN 0 ELSE 1 END,
               c.sort_order ASC, c.name COLLATE NOCASE ASC, c.id ASC
    `).all(...chunk, userId));
  }
  const byNote = new Map();
  for (const row of rows) {
    if (!byNote.has(row.note_id)) byNote.set(row.note_id, []);
    const { note_id: _noteId, ...category } = row;
    byNote.get(row.note_id).push(category);
  }
  return notes.map((note) => ({ ...note, categories: byNote.get(Number(note.id)) || [] }));
}

/**
 * Ersetzt nur Zuordnungen, die der Akteur sehen und an einer Notiz verwenden
 * darf: alle Haushaltskategorien plus die eigenen persoenlichen Kategorien.
 * Unsichtbare persoenliche Zuordnungen anderer Konten bleiben unangetastet.
 */
export function replaceEditableAssignments(database, {
  noteId,
  categoryIds,
  userId,
}) {
  const ids = normalizedIds(categoryIds);
  let categories = [];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    categories = database.prepare(`
      SELECT id, scope, owner_user_id
      FROM note_categories
      WHERE id IN (${placeholders})
    `).all(...ids);
    if (categories.length !== ids.length) throw new NoteCategoryInputError('Category is not available');
    for (const category of categories) {
      if (category.scope === 'personal' && Number(category.owner_user_id) !== Number(userId)) {
        throw new NoteCategoryInputError('Category is not available');
      }
    }
  }

  const run = () => {
    database.prepare(`
      DELETE FROM note_category_assignments
      WHERE note_id = ? AND category_id IN (
        SELECT id FROM note_categories
        WHERE owner_user_id = ? OR scope = 'household'
      )
    `).run(noteId, userId);
    const insert = database.prepare(`
      INSERT INTO note_category_assignments (note_id, category_id, assigned_by)
      VALUES (?, ?, ?)
    `);
    for (const id of ids) insert.run(noteId, id, userId);
  };

  if (database.inTransaction) {
    run();
  } else {
    database.exec('BEGIN');
    try {
      run();
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

export function validateCategoryName(value) {
  if (typeof value !== 'string') throw new NoteCategoryInputError('Category name is required');
  const name = value.trim();
  if (!name || name.length > 80) {
    throw new NoteCategoryInputError('Category name must contain 1 to 80 characters');
  }
  return name;
}

export function pruneCategoryFromDashboardConfigs(database, categoryId) {
  const rows = database.prepare(`
    SELECT key, value FROM sync_config
    WHERE key IN ('dashboard_widgets', 'dashboard_widgets_default')
       OR key LIKE 'dashboard_widgets:user:%'
  `).all();
  const update = database.prepare('UPDATE sync_config SET value = ? WHERE key = ?');
  const target = String(categoryId);
  for (const row of rows) {
    let config;
    try { config = JSON.parse(row.value); } catch { continue; }
    if (!Array.isArray(config)) continue;
    let changed = false;
    for (const widget of config) {
      if (widget?.id !== 'notes' || !Array.isArray(widget.options?.categories)) continue;
      const next = widget.options.categories.filter((id) => String(id) !== target);
      if (next.length === widget.options.categories.length) continue;
      changed = true;
      if (next.length) widget.options.categories = next;
      else {
        delete widget.options.categories;
        if (!Object.keys(widget.options).length) delete widget.options;
      }
    }
    if (changed) update.run(JSON.stringify(config), row.key);
  }
}
