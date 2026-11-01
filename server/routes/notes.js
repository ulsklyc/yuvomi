/**
 * Modul: Pinnwand / Notizen (Notes)
 * Zweck: REST-API-Routen für Notizen (CRUD, Pin-Toggle)
 * Abhängigkeiten: express, server/db.js, server/auth.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, color, collectErrors, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { toggleChecklistLine } from '../../public/utils/markdown-checklist.js';
import { mayChangeRecord, resolvePermissions, userForRequest, sendNotOwner } from '../permissions.js';
import {
  categoryNameKey,
  hydrateNotesWithCategories,
  listVisibleCategories,
  NoteCategoryInputError,
  pruneCategoryFromDashboardConfigs,
  replaceEditableAssignments,
  validateCategoryName,
} from '../services/note-categories.js';
import { personAvatarUrlSql } from '../services/person-avatar.js';
import { noteVisibleWhere } from '../services/visibility.js';
import {
  mayChangeNoteLock,
  mayChangeNoteVisibility,
  noteLockedFor,
  noteVisibilityValue,
} from '../../public/utils/note-access.js';

const log = createLogger('Notes');

const router  = express.Router();

function actorId(req) {
  return req.authUserId || req.session.userId;
}

function canManageHousehold(req) {
  if (isAdminRequest(req)) return true;
  const user = db.get().prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(actorId(req));
  return resolvePermissions(db.get(), userForRequest(req, user)).capabilities.notes_manage_household_categories === 'allow';
}

// FREMDE NOTIZEN NUR LESEN (R23, D5). Ohne `notes_edit_others` bearbeitet,
// pinnt und loescht ein Konto nur Notizen, die es angelegt hat. Zwei Gesten
// bleiben bewusst offen: das Abhaken einer Checklisten-Zeile (PATCH /:id/check)
// ist Benutzen einer geteilten Liste wie im Einkauf, kein Umschreiben; und das
// Zuordnen der EIGENEN Kategorien (`category_ids` allein im PUT) aendert nur,
// wie ich die Notiz einsortiere - `replaceEditableAssignments()` laesst ohnehin
// nur zu, was diese Person verwalten darf.
//
// GESPERRTE NOTIZ (#1602): davor steht die Sperre, und sie gilt GANZ - auch die
// beiden offenen Gesten oben (`interaction`) sind dann zu. Was sie freigibt,
// steht in `noteLockedFor()` (public/utils/note-access.js): Ersteller:in und
// Admins.
function refuseForeignNote(req, res, note, { interaction = false } = {}) {
  if (noteLockedFor(note, viewerOf(req))) {
    res.status(403).json(NOTE_LOCKED_ERROR);
    return true;
  }
  if (interaction) return false;
  const own = Number(note?.created_by) === Number(actorId(req));
  if (mayChangeRecord(db.get(), req, 'notes_edit_others', own)) return false;
  sendNotOwner(res);
  return true;
}

const NOTE_LOCKED_ERROR = {
  error: 'This note is locked; only its creator and administrators can change it.',
  code: 403,
  reason: 'note_locked',
};

const NOTE_NOT_FOUND = { error: 'Note not found.', code: 404, reason: 'notes_note_not_found' };

function viewerOf(req) {
  return { userId: actorId(req), isAdmin: isAdminRequest(req) };
}

/**
 * Die Notiz zu einer Kennung - nur, wenn diese Person sie sieht (#1514).
 * Eine private Notiz eines anderen ist fuer jeden Aenderungsweg dasselbe wie
 * eine geloeschte: 404, denn schon ein 403 sagte, dass es sie gibt.
 */
function findVisibleNote(req, id) {
  return db.get().prepare(`SELECT * FROM notes n WHERE n.id = ? AND ${noteVisibleWhere('n')}`)
    .get(id, actorId(req));
}

/**
 * Sichtbarkeit und Sperre aus dem Rumpf (#1514, #1602). Nicht mitgeschickt
 * heisst "nicht angefasst" (`undefined`).
 */
function readAccessFields(body) {
  const out = {};
  if (body?.visibility !== undefined) {
    out.visibility = noteVisibilityValue(body.visibility);
    if (!out.visibility) return { error: 'visibility must be "all" or "private".' };
  }
  if (body?.locked !== undefined) {
    if (![true, false, 0, 1].includes(body.locked)) return { error: 'locked must be a boolean.' };
    out.locked = body.locked ? 1 : 0;
  }
  return out;
}

function categoryPayload(category) {
  return {
    id: category.id,
    name: category.name,
    scope: category.scope,
    owner_user_id: category.owner_user_id,
    sort_order: category.sort_order,
  };
}

function oneWithCategories(note, req) {
  return hydrateNotesWithCategories(db.get(), [note], actorId(req))[0];
}

function categoryInputError(error) {
  return error instanceof NoteCategoryInputError;
}

function categoryDatabaseConflict(error) {
  if (['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error?.code)) return true;
  return error?.code === 'ERR_SQLITE_ERROR'
    && /(FOREIGN KEY constraint failed|database is (busy|locked))/i.test(error?.message || '');
}

function categoryErrorResponse(res, error) {
  const status = Number(error?.status) || 400;
  return res.status(status).json({ error: error.message, code: status, ...(error.reason ? { reason: error.reason } : {}) });
}

function editableCategory(req, id) {
  if (!Number.isInteger(id) || id <= 0) {
    return { status: 400, error: 'Invalid category id.' };
  }
  const category = db.get().prepare('SELECT * FROM note_categories WHERE id = ?').get(id);
  if (!category) return { status: 404, error: 'Category not found.' };
  if (category.scope === 'personal' && Number(category.owner_user_id) !== Number(actorId(req))) {
    return { status: 404, error: 'Category not found.' };
  }
  if (category.scope === 'household' && !canManageHousehold(req)) {
    return { status: 403, error: 'Household category management is not allowed.' };
  }
  return { category };
}

// Kategorien stehen vor /:id, damit Express "categories" nicht als Notiz-ID
// interpretiert. Der Katalog ist leer, bis Nutzer selbst Eintraege anlegen.
router.get('/categories', (req, res) => {
  try {
    res.json({
      data: listVisibleCategories(db.get(), actorId(req)).map(categoryPayload),
      meta: { can_manage_household: canManageHousehold(req) },
    });
  } catch (err) {
    log.error('Category list:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/categories', (req, res) => {
  try {
    const name = validateCategoryName(req.body?.name);
    const requestedScope = req.body?.scope;
    const scope = requestedScope === undefined ? 'personal' : requestedScope;
    if (!['personal', 'household'].includes(scope)) {
      return res.status(400).json({ error: 'Invalid category scope.', code: 400 });
    }
    if (scope === 'household' && !canManageHousehold(req)) {
      return res.status(403).json({ error: 'Household category management is not allowed.', code: 403 });
    }
    const ownerId = scope === 'personal' ? actorId(req) : null;
    const max = db.get().prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS value FROM note_categories
      WHERE scope = ? AND owner_user_id IS ?
    `).get(scope, ownerId).value;
    const result = db.get().prepare(`
      INSERT INTO note_categories (name, name_key, scope, owner_user_id, created_by, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, categoryNameKey(name), scope, ownerId, actorId(req), max + 1);
    const category = db.get().prepare('SELECT * FROM note_categories WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: categoryPayload(category) });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A category with this name already exists.', code: 409, reason: 'category_exists' });
    }
    if (categoryInputError(err)) return categoryErrorResponse(res, err);
    log.error('Category create:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.patch('/categories/reorder', (req, res) => {
  try {
    const order = req.body?.order;
    if (!Array.isArray(order) || order.length > 100) {
      return res.status(400).json({ error: 'Invalid category order.', code: 400 });
    }
    const ids = order.map(Number);
    if (ids.some((id) => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'Invalid category order.', code: 400 });
    }
    const verdicts = ids.map((id) => editableCategory(req, id));
    for (const verdict of verdicts) {
      if (!verdict.category) return res.status(verdict.status).json({ error: verdict.error, code: verdict.status });
    }
    if (new Set(verdicts.map((verdict) => verdict.category.scope)).size > 1) {
      return res.status(400).json({ error: 'Categories can only be reordered within one scope.', code: 400 });
    }
    const update = db.get().prepare('UPDATE note_categories SET sort_order = ? WHERE id = ?');
    const transaction = db.get().transaction(() => ids.forEach((id, index) => update.run(index, id)));
    transaction();
    res.json({
      data: listVisibleCategories(db.get(), actorId(req)).map(categoryPayload),
      meta: { can_manage_household: canManageHousehold(req) },
    });
  } catch (err) {
    log.error('Category reorder:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.put('/categories/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const verdict = editableCategory(req, id);
    if (!verdict.category) return res.status(verdict.status).json({ error: verdict.error, code: verdict.status });
    const name = validateCategoryName(req.body?.name);
    db.get().prepare(`
      UPDATE note_categories
      SET name = ?, name_key = ?
      WHERE id = ?
    `).run(name, categoryNameKey(name), id);
    res.json({ data: categoryPayload(db.get().prepare('SELECT * FROM note_categories WHERE id = ?').get(id)) });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A category with this name already exists.', code: 409, reason: 'category_exists' });
    }
    if (categoryInputError(err)) return categoryErrorResponse(res, err);
    log.error('Category update:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/categories/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const verdict = editableCategory(req, id);
    if (!verdict.category) return res.status(verdict.status).json({ error: verdict.error, code: verdict.status });
    const database = db.get();
    const remove = database.transaction(() => {
      database.prepare('DELETE FROM note_categories WHERE id = ?').run(id);
      pruneCategoryFromDashboardConfigs(database, id);
    });
    remove();
    res.status(204).end();
  } catch (err) {
    log.error('Category delete:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * GET /api/v1/notes
 * Alle Notizen, angepinnte zuerst, dann nach updated_at DESC.
 * Response: { data: Note[] }
 */
router.get('/', (req, res) => {
  try {
    const notes = db.get().prepare(`
      SELECT n.*, u.display_name AS creator_name, u.avatar_color AS creator_color, ${personAvatarUrlSql('u')} AS creator_avatar
      FROM notes n
      LEFT JOIN users u ON u.id = n.created_by
      WHERE ${noteVisibleWhere('n')}
      ORDER BY n.pinned DESC, n.updated_at DESC
    `).all(actorId(req));
    res.json({ data: hydrateNotesWithCategories(db.get(), notes, actorId(req)) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * POST /api/v1/notes
 * Neue Notiz anlegen.
 * Body: { content, title?, color?, pinned? }
 * Response: { data: Note }
 */
router.post('/', (req, res) => {
  try {
    const { pinned = 0 } = req.body;
    const vContent = str(req.body.content, 'content', { max: MAX_TEXT });
    const vTitle   = str(req.body.title,   'title',  { max: MAX_TITLE, required: false });
    const vColor   = color(req.body.color || '#FFEB3B', 'color');
    const errors   = collectErrors([vContent, vTitle, vColor]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const access = readAccessFields(req.body);
    if (access.error) return res.status(400).json({ error: access.error, code: 400 });

    const database = db.get();
    const create = database.transaction(() => {
      const result = database.prepare(`
        INSERT INTO notes (content, title, color, pinned, created_by, visibility, locked)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(vContent.value, vTitle.value, vColor.value, pinned ? 1 : 0, actorId(req),
        access.visibility ?? 'all', access.locked ?? 0);
      if (req.body.category_ids !== undefined) {
        replaceEditableAssignments(database, {
          noteId: result.lastInsertRowid,
          categoryIds: req.body.category_ids,
          userId: actorId(req),
        });
      }
      return result;
    });
    const result = create();

    const note = db.get().prepare(`
      SELECT n.*, u.display_name AS creator_name, u.avatar_color AS creator_color, ${personAvatarUrlSql('u')} AS creator_avatar
      FROM notes n LEFT JOIN users u ON u.id = n.created_by
      WHERE n.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ data: oneWithCategories(note, req) });
  } catch (err) {
    if (req.body?.category_ids !== undefined && categoryDatabaseConflict(err)) {
      return res.status(409).json({ error: 'Categories changed. Refresh and try again.', code: 409, reason: 'notes_selected_category_not_found' });
    }
    if (categoryInputError(err)) return categoryErrorResponse(res, err);
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * PUT /api/v1/notes/:id
 * Notiz bearbeiten.
 * Body: { content?, title?, color?, pinned? }
 * Response: { data: Note }
 */
router.put('/:id', (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    const note = findVisibleNote(req, id);
    if (!note) return res.status(404).json(NOTE_NOT_FOUND);
    const bodyKeys = Object.keys(req.body || {});
    const categoriesOnly = bodyKeys.length === 1 && bodyKeys[0] === 'category_ids';
    if (refuseForeignNote(req, res, note, { interaction: categoriesOnly })) return;

    // WER DIE BEIDEN SCHALTER STELLT (#1514, #1602). Verglichen wird mit dem
    // Bestand, nicht die blosse Anwesenheit: ein Client, der den ganzen Zettel
    // unveraendert zurueckschickt, stellt nichts um.
    const access = readAccessFields(req.body);
    if (access.error) return res.status(400).json({ error: access.error, code: 400 });
    const visibility = access.visibility ?? note.visibility;
    const locked = access.locked ?? note.locked;
    if (visibility !== note.visibility && !mayChangeNoteVisibility(note, viewerOf(req))) return sendNotOwner(res);
    if (locked !== note.locked && !mayChangeNoteLock(note, viewerOf(req))) return sendNotOwner(res);

    const { pinned } = req.body;
    const checks = [];
    if (req.body.content !== undefined) checks.push(str(req.body.content, 'content', { max: MAX_TEXT, required: false }));
    if (req.body.title !== undefined)   checks.push(str(req.body.title,   'title',  { max: MAX_TITLE, required: false }));
    if (req.body.color !== undefined)   checks.push(color(req.body.color, 'color'));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const database = db.get();
    const update = database.transaction(() => {
      database.prepare(`
      UPDATE notes
      SET content = COALESCE(?, content),
          title   = ?,
          color   = COALESCE(?, color),
          pinned  = COALESCE(?, pinned),
          visibility = ?,
          locked  = ?
      WHERE id = ?
      `).run(
      // Wie `str()` oben: der geprüfte Wert ist ein String daraus, auch wenn
      // eine Zahl kam - ein `.trim()` am Rohwert warf dort eine 500.
      req.body.content != null ? String(req.body.content).trim() : null,
      req.body.title !== undefined ? ((req.body.title != null ? String(req.body.title).trim() : '') || null) : note.title,
      req.body.color ?? null,
      pinned !== undefined ? (pinned ? 1 : 0) : null,
      visibility,
      locked,
        id
      );
      if (req.body.category_ids !== undefined) {
        replaceEditableAssignments(database, {
          noteId: id,
          categoryIds: req.body.category_ids,
          userId: actorId(req),
        });
      }
    });
    update();

    const updated = db.get().prepare(`
      SELECT n.*, u.display_name AS creator_name, u.avatar_color AS creator_color, ${personAvatarUrlSql('u')} AS creator_avatar
      FROM notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?
    `).get(id);

    res.json({ data: oneWithCategories(updated, req) });
  } catch (err) {
    if (req.body?.category_ids !== undefined && categoryDatabaseConflict(err)) {
      return res.status(409).json({ error: 'Categories changed. Refresh and try again.', code: 409, reason: 'notes_selected_category_not_found' });
    }
    if (categoryInputError(err)) return categoryErrorResponse(res, err);
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * PATCH /api/v1/notes/:id/pin
 * Pin-Status toggeln.
 * Response: { data: { id, pinned } }
 */
router.patch('/:id/pin', (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    const note = findVisibleNote(req, id);
    if (!note) return res.status(404).json(NOTE_NOT_FOUND);
    if (refuseForeignNote(req, res, note)) return;

    const newPinned = note.pinned ? 0 : 1;
    db.get().prepare('UPDATE notes SET pinned = ? WHERE id = ?').run(newPinned, id);
    res.json({ data: { id, pinned: newPinned } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * PATCH /api/v1/notes/:id/check
 * Einen Checklisten-Eintrag ab- oder anhaken, ohne den Rest des Textes zu
 * berühren (#704).
 *
 * Warum das nicht über PUT läuft: PUT schreibt den ganzen `content`. Zwei
 * Mitglieder, die im selben Moment verschiedene Einträge derselben Notiz
 * abhaken, hätten damit den letzten Schreiber gewinnen lassen - der andere
 * Haken verschwände still. Hier ändert der Server genau eine Zeile des
 * gespeicherten Standes, also gehen zwei Haken in zwei Zeilen beide durch.
 *
 * Adressiert wird über die Zeilennummer, die der Renderer am Kästchen
 * hinterlässt, nicht über den Eintragstext: zwei Zeilen „Milch" sind sonst
 * nicht auseinanderzuhalten. `expect` ist die Gegenprobe dazu - stimmt die
 * Zeile nicht mehr mit der überein, die der Client gesehen hat, hat jemand den
 * Text bearbeitet und der Index zeigt woanders hin. Dann lieber 409 als ein
 * Haken in der falschen Zeile.
 *
 * Body: { line: number, checked: boolean, expect?: string }
 * Response: { data: Note } | 409 { code: 409, reason }
 */
router.patch('/:id/check', (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    const note = findVisibleNote(req, id);
    if (!note) return res.status(404).json(NOTE_NOT_FOUND);
    // Abhaken ist Benutzen - ausser die Notiz ist gesperrt (#1602).
    if (refuseForeignNote(req, res, note, { interaction: true })) return;

    const { line, checked, expect } = req.body;
    if (!Number.isInteger(line) || line < 0)
      return res.status(400).json({ error: 'Invalid line number.', code: 400 });
    if (typeof checked !== 'boolean')
      return res.status(400).json({ error: 'checked must be true or false.', code: 400 });
    if (expect !== undefined && expect !== null && typeof expect !== 'string')
      return res.status(400).json({ error: 'expect must be a string.', code: 400 });

    const result = toggleChecklistLine(note.content, line, checked, expect);
    if (!result.ok) {
      return res.status(409).json({
        error: 'The note has changed in the meantime. Refresh and try again.',
        code:  409,
        reason: result.reason,
      });
    }

    // `changed: false` heißt, der Eintrag stand schon so - dann bleibt auch
    // `updated_at` unangetastet, sonst sortierte ein folgenloser Tap die
    // Pinnwand um.
    if (result.changed) {
      db.get().prepare('UPDATE notes SET content = ? WHERE id = ?').run(result.content, id);
    }

    const updated = db.get().prepare(`
      SELECT n.*, u.display_name AS creator_name, u.avatar_color AS creator_color, ${personAvatarUrlSql('u')} AS creator_avatar
      FROM notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?
    `).get(id);

    res.json({ data: oneWithCategories(updated, req) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * DELETE /api/v1/notes/:id
 * Notiz löschen.
 * Response: 204 No Content
 */
router.delete('/:id', (req, res) => {
  try {
    const id     = parseInt(req.params.id, 10);
    const note   = findVisibleNote(req, id);
    if (!note) return res.status(404).json(NOTE_NOT_FOUND);
    if (refuseForeignNote(req, res, note)) return;
    const result = db.get().prepare('DELETE FROM notes WHERE id = ?').run(id);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Note not found.', code: 404, reason: 'notes_note_not_found' });
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
