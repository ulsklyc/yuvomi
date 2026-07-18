import express from 'express';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { collectErrors, date as validateDate, str, MAX_SHORT, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';
import {
  deleteBirthdayArtifacts,
  hydrateBirthday,
  syncBirthdayArtifacts,
  syncAllBirthdayReminders,
  listBirthdayImportCandidates,
  importBirthdaysFromContacts,
} from '../services/birthdays.js';

const log = createLogger('Birthdays');
const router = express.Router();
const MAX_PHOTO_LENGTH = 6_990_507; // ~5 MB raw image in base64
const PHOTO_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function validatePhotoData(val) {
  if (val === undefined) return { value: undefined, error: null };
  if (val === null || val === '') return { value: null, error: null };
  const s = String(val).trim();
  if (s.length > MAX_PHOTO_LENGTH) return { value: null, error: 'Profile picture is too large.' };
  if (!PHOTO_RE.test(s)) return { value: null, error: 'Profile picture must be a valid image data URL.' };
  return { value: s, error: null };
}

function loadBirthday(id) {
  return db.get().prepare('SELECT * FROM birthdays WHERE id = ?').get(id);
}


function sortHydrated(rows) {
  return rows
    .map((row) => hydrateBirthday(row))
    .sort((a, b) => a.days_until - b.days_until || a.name.localeCompare(b.name));
}

router.get('/', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;
    syncAllBirthdayReminders(db.get(), userId);

    let sql = 'SELECT * FROM birthdays WHERE 1=1';
    const params = [];

    if (req.query.q) {
      sql += ' AND name LIKE ?';
      params.push(`%${String(req.query.q).trim()}%`);
    }

    sql += ' ORDER BY name COLLATE NOCASE ASC';

    const rows = db.get().prepare(sql).all(...params);
    res.json({ data: sortHydrated(rows) });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.get('/upcoming', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;
    syncAllBirthdayReminders(db.get(), userId);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 50);
    const rows = db.get().prepare('SELECT * FROM birthdays ORDER BY name COLLATE NOCASE ASC').all();
    res.json({ data: sortHydrated(rows).slice(0, limit) });
  } catch (err) {
    log.error('GET /upcoming error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.post('/', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vBirthDate = validateDate(req.body.birth_date, 'Birth date', true);
    const vNotes = str(req.body.notes, 'Notes', { max: MAX_TEXT, required: false });
    const vPhoto = validatePhotoData(req.body.photo_data);
    const errors = collectErrors([vName, vBirthDate, vNotes, vPhoto]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const result = db.get().prepare(`
      INSERT INTO birthdays (name, birth_date, notes, photo_data, created_by, reminder_offset, reminder_custom_amount, reminder_custom_unit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vName.value,
      vBirthDate.value,
      vNotes.value,
      vPhoto.value ?? null,
      req.authUserId || req.session.userId,
      req.body.reminder_offset ?? null,
      req.body.reminder_custom_amount ?? null,
      req.body.reminder_custom_unit ?? null
    );

    const birthday = loadBirthday(result.lastInsertRowid);
    const synced = db.transaction(() => syncBirthdayArtifacts(db.get(), birthday));
    res.status(201).json({ data: hydrateBirthday(loadBirthday(synced.id)) });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.get('/import/candidates', (req, res) => {
  try {
    const data = listBirthdayImportCandidates(db.get());
    res.json({ data });
  } catch (err) {
    log.error('GET /import/candidates error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.post('/import', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;
    const ids = Array.isArray(req.body.contact_ids) ? req.body.contact_ids : null;
    if (!ids || ids.length === 0) {
      return res.status(400).json({ error: 'contact_ids must be a non-empty array.', code: 400 });
    }
    if (ids.length > 500) {
      return res.status(400).json({ error: 'Too many contacts selected.', code: 400 });
    }

    const result = db.transaction(() => importBirthdaysFromContacts(db.get(), ids, userId));
    res.status(201).json({ data: result });
  } catch (err) {
    log.error('POST /import error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.put('/:id', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;
    const id = parseInt(req.params.id, 10);
    const existing = loadBirthday(id);
    if (!existing) return res.status(404).json({ error: 'Birthday not found.', code: 404 });

    const checks = [];
    if (req.body.name !== undefined) checks.push(str(req.body.name, 'Name', { max: MAX_TITLE, required: false }));
    if (req.body.birth_date !== undefined) checks.push(validateDate(req.body.birth_date, 'Birth date'));
    if (req.body.notes !== undefined) checks.push(str(req.body.notes, 'Notes', { max: MAX_TEXT, required: false }));
    if (req.body.photo_data !== undefined) checks.push(validatePhotoData(req.body.photo_data));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const vPhoto = req.body.photo_data !== undefined ? validatePhotoData(req.body.photo_data) : { value: undefined };

    db.get().prepare(`
      UPDATE birthdays
      SET name = COALESCE(?, name),
          birth_date = COALESCE(?, birth_date),
          notes = ?,
          photo_data = ?,
          reminder_offset = ?,
          reminder_custom_amount = ?,
          reminder_custom_unit = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(
      req.body.name?.trim() ?? null,
      req.body.birth_date ?? null,
      req.body.notes !== undefined ? (req.body.notes?.trim() || null) : existing.notes,
      req.body.photo_data !== undefined ? (vPhoto.value ?? null) : existing.photo_data,
      req.body.reminder_offset !== undefined ? req.body.reminder_offset : existing.reminder_offset,
      req.body.reminder_custom_amount !== undefined ? req.body.reminder_custom_amount : existing.reminder_custom_amount,
      req.body.reminder_custom_unit !== undefined ? req.body.reminder_custom_unit : existing.reminder_custom_unit,
      id,
    );

    const updated = loadBirthday(id);
    db.transaction(() => syncBirthdayArtifacts(db.get(), updated));
    res.json({ data: hydrateBirthday(loadBirthday(id)) });
  } catch (err) {
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;
    const id = parseInt(req.params.id, 10);
    const existing = loadBirthday(id);
    if (!existing) return res.status(404).json({ error: 'Birthday not found.', code: 404 });

    db.transaction(() => {
      deleteBirthdayArtifacts(db.get(), existing);
      db.get().prepare('DELETE FROM birthdays WHERE id = ?').run(id);
    });

    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.get('/meta/options', (_req, res) => {
  res.json({ data: { photoMaxBytes: MAX_PHOTO_LENGTH, acceptedImageTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] } });
});

export default router;
