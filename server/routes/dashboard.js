/**
 * Modul: Dashboard
 * Zweck: Aggregierter Endpoint - liefert Daten aller Dashboard-Widgets in einem Request
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { hydrateBirthday } from '../services/birthdays.js';

const log = createLogger('Dashboard');

const router = express.Router();

/**
 * GET /api/v1/dashboard
 * Liefert aggregierte Daten für alle Dashboard-Widgets.
 * Jedes Widget-Objekt hat ein eigenes `error`-Feld falls die Abfrage fehlschlägt -
 * so bricht ein fehlerhaftes Widget nicht das gesamte Dashboard.
 *
 * Response: {
 *   upcomingEvents: CalendarEvent[],   // Nächste 5 Termine
 *   urgentTasks:    Task[],            // High/Urgent mit Fälligkeit ≤ 48h
 *   todayMeals:     Meal[],            // Mahlzeiten für heute
 *   pinnedNotes:    Note[],            // Angepinnte Notizen (max. 3)
 *   users:          User[]             // Alle User (für Avatar-Farben)
 * }
 */
router.get('/', (req, res) => {
  try {
  const d = db.get();
  const result = {};
  const userId = req.authUserId || req.session.userId;

  // Heute und +48h als ISO-Strings
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const currentMonth = todayStr.slice(0, 7);
  const deadline48h = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

  // Anstehende Termine (nächste 5, ab jetzt)
  try {
    result.upcomingEvents = d.prepare(`
      SELECT
        ce.*,
        u.display_name  AS assigned_name,
        u.avatar_color  AS assigned_color,
        ec.name  AS cal_name,
        ec.color AS cal_color
      FROM calendar_events ce
      LEFT JOIN users u  ON ce.assigned_to = u.id
      LEFT JOIN external_calendars ec ON ec.id = ce.calendar_ref_id
      WHERE ce.start_datetime >= ?
      ORDER BY ce.start_datetime ASC
      LIMIT 5
    `).all(now.toISOString());
  } catch (err) {
    log.error('upcomingEvents error:', err.message);
    result.upcomingEvents = [];
  }

  // Offene Aufgaben: Sortierung in SQL (overdue zuerst, dann Fälligkeit, dann Priorität).
  // Faithful translation of the previous JS comparator:
  //   1. overdue (due_sort < now) before not-overdue
  //   2. within a group: earlier due date/time first; undated tasks last (NULLS LAST)
  //   3. ties broken by priority rank (urgent=0..none=4)
  // due_sort = due_date + due_time, falling back to 23:59:59 when only a date is set,
  // and NULL when there is no due_date at all.
  try {
    const nowIso = `${todayStr}T${now.toISOString().slice(11, 19)}`;
    result.urgentTasks = d.prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
        CASE WHEN t.due_date IS NULL THEN NULL
             ELSE t.due_date || 'T' || COALESCE(t.due_time, '23:59:59')
        END AS __due_sort
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.status != 'done'
      ORDER BY
        CASE WHEN __due_sort IS NOT NULL AND __due_sort < @now THEN 0 ELSE 1 END ASC,
        __due_sort IS NULL ASC,
        __due_sort ASC,
        CASE t.priority
          WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
          WHEN 'low' THEN 3 ELSE 4
        END ASC
      LIMIT 5
    `).all({ now: nowIso }).map(({ __due_sort, ...task }) => task);
  } catch (err) {
    log.error('urgentTasks error:', err.message);
    result.urgentTasks = [];
  }

  // Heutiges Essen (gefiltert nach haushaltweiten Mahlzeit-Typ-Einstellungen)
  try {
    const ALL_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
    const prefRow = d.prepare('SELECT value FROM sync_config WHERE key = ?').get('visible_meal_types');
    const visibleTypes = prefRow
      ? prefRow.value.split(',').filter((t) => ALL_MEAL_TYPES.includes(t))
      : ALL_MEAL_TYPES;
    const placeholders = visibleTypes.map(() => '?').join(', ');
    result.todayMeals = d.prepare(`
      SELECT * FROM meals
      WHERE date = ?
        AND meal_type IN (${placeholders})
      ORDER BY
        CASE meal_type
          WHEN 'breakfast' THEN 0
          WHEN 'lunch'     THEN 1
          WHEN 'dinner'    THEN 2
          WHEN 'snack'     THEN 3
        END
    `).all(todayStr, ...visibleTypes);
  } catch (err) {
    log.error('todayMeals error:', err.message);
    result.todayMeals = [];
  }

  // Neueste Notizen (gepinnte zuerst, dann aktuellste)
  try {
    result.pinnedNotes = d.prepare(`
      SELECT n.*, u.display_name AS author_name, u.avatar_color AS author_color
      FROM notes n
      LEFT JOIN users u ON n.created_by = u.id
      ORDER BY n.pinned DESC, n.updated_at DESC
      LIMIT 3
    `).all();
  } catch (err) {
    log.error('pinnedNotes error:', err.message);
    result.pinnedNotes = [];
  }

  // Einkaufslisten mit offenen Artikeln (max. 3 Listen, je bis zu 6 offene Items)
  try {
    const lists = d.prepare(`
      SELECT sl.id, sl.name,
        (SELECT COUNT(*) FROM shopping_items si WHERE si.list_id = sl.id AND si.is_checked = 0) AS open_count,
        (SELECT COUNT(*) FROM shopping_items si WHERE si.list_id = sl.id) AS total_count
      FROM shopping_lists sl
      WHERE (SELECT COUNT(*) FROM shopping_items si WHERE si.list_id = sl.id AND si.is_checked = 0) > 0
      ORDER BY sl.updated_at DESC
      LIMIT 3
    `).all();

    for (const list of lists) {
      list.items = d.prepare(`
        SELECT id, name, quantity, is_checked
        FROM shopping_items
        WHERE list_id = ? AND is_checked = 0
        ORDER BY id ASC
        LIMIT 6
      `).all(list.id);
    }
    result.shoppingLists = lists;
  } catch (err) {
    log.error('shoppingLists error:', err.message);
    result.shoppingLists = [];
  }

  // Alle User (für Avatar-Farben in Widgets)
  try {
    result.users = d.prepare(
      'SELECT id, display_name, avatar_color, avatar_data FROM users ORDER BY display_name'
    ).all();
  } catch (err) {
    result.users = [];
  }

  try {
    const rows = d.prepare('SELECT * FROM birthdays WHERE created_by = ? ORDER BY name COLLATE NOCASE ASC').all(userId);
    result.birthdays = rows
      .map((row) => hydrateBirthday(row))
      .sort((a, b) => a.days_until - b.days_until || a.name.localeCompare(b.name))
      .slice(0, 3);
    result.birthdayCount = rows.length;
  } catch (err) {
    log.error('birthdays error:', err.message);
    result.birthdays = [];
    result.birthdayCount = 0;
  }

  try {
    const from = `${currentMonth}-01`;
    const to = `${currentMonth}-31`;
    const totals = d.prepare(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
        SUM(amount) AS balance,
        COUNT(*) AS entry_count
      FROM budget_entries
      WHERE date BETWEEN ? AND ?
    `).get(from, to);

    const topExpense = d.prepare(`
      SELECT category, SUM(amount) AS amount
      FROM budget_entries
      WHERE amount < 0 AND date BETWEEN ? AND ?
      GROUP BY category
      ORDER BY ABS(SUM(amount)) DESC
      LIMIT 1
    `).get(from, to);

    result.budget = {
      month: currentMonth,
      income: totals?.income || 0,
      expenses: Math.abs(totals?.expenses || 0),
      balance: totals?.balance || 0,
      entryCount: totals?.entry_count || 0,
      topExpenseCategory: topExpense?.category || null,
      topExpenseAmount: Math.abs(topExpense?.amount || 0),
    };
  } catch (err) {
    log.error('budget error:', err.message);
    result.budget = {
      month: currentMonth,
      income: 0,
      expenses: 0,
      balance: 0,
      entryCount: 0,
      topExpenseCategory: null,
      topExpenseAmount: 0,
    };
  }

  res.json(result);
  } catch (err) {
    log.error('Critical error:', err.message);
    res.status(500).json({ error: 'Dashboard could not be loaded.', code: 500 });
  }
});

export default router;
