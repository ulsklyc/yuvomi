/**
 * Modul: Dashboard
 * Zweck: Aggregierter Endpoint - liefert Daten aller Dashboard-Widgets in einem Request
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { hydrateBirthday } from '../services/birthdays.js';
import { getUpcomingEvents } from '../services/calendar-events.js';

const log = createLogger('Dashboard');

const ASSIGNED_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color,
    'avatar_data', u.avatar_data
  ))
  FROM task_assignments ta JOIN users u ON u.id = ta.user_id
  WHERE ta.task_id = t.id
) AS assigned_users_json`;

function addAssignedUsers(task) {
  task.assigned_users = task.assigned_users_json ? JSON.parse(task.assigned_users_json) : [];
  delete task.assigned_users_json;
  return task;
}

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

  // Lokaler Datums-/Wochentagsschlüssel für das Health-Widget: die Fälligkeit einer
  // Dosis hängt am lokalen Kalendertag (nicht UTC), sonst driftet die days_mask westlich
  // von UTC um einen Tag. Konvention wie public/utils/health-meds.js: Montag = 0 … Sonntag = 6.
  const todayLocalKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const localWeekdayIdx = (now.getDay() + 6) % 7;

  // Anstehende Termine (nächste 5, ab jetzt).
  // Geteilte Logik mit /calendar/upcoming: expandiert wiederkehrende Serien,
  // sodass auch Termine erscheinen, deren Master-Start in der Vergangenheit liegt.
  try {
    result.upcomingEvents = getUpcomingEvents(d, { userId, limit: 5, fromToday: true })
      .map(({ assigned_users_json, ...event }) => {
        event.assigned_users = assigned_users_json ? JSON.parse(assigned_users_json) : [];
        return event;
      });
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
        ${ASSIGNED_USERS_SQL},
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
    `).all({ now: nowIso }).map(({ __due_sort, ...task }) => addAssignedUsers(task));
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
      `SELECT id, display_name, avatar_color, avatar_data FROM users u
       WHERE NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
       ORDER BY display_name`
    ).all();
  } catch (err) {
    result.users = [];
  }

  try {
    const rows = d.prepare('SELECT * FROM birthdays ORDER BY name COLLATE NOCASE ASC').all();
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

    // Monats-Sparziel (Budgetplan #468): eigener Guard, damit ältere/Minimal-DBs
    // ohne budget_plans-Tabelle die Budget-Aggregation nicht scheitern lassen.
    let savingsGoal = null;
    try {
      const goalRow = d.prepare("SELECT amount FROM budget_plans WHERE category = '__savings__'").get();
      if (goalRow) savingsGoal = Math.round(goalRow.amount * 100) / 100;
    } catch { /* Tabelle fehlt (Legacy/Test) → kein Sparziel */ }

    result.budget = {
      month: currentMonth,
      income: totals?.income || 0,
      expenses: Math.abs(totals?.expenses || 0),
      balance: totals?.balance || 0,
      entryCount: totals?.entry_count || 0,
      topExpenseCategory: topExpense?.category || null,
      topExpenseAmount: Math.abs(topExpense?.amount || 0),
      savingsGoal,
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

  // Belohnungen: Familien-Punktestand (Top 5 aktive Teilnehmer nach Ledger-Saldo)
  // plus offene Freigaben — ein glanceable Mini-Ranking für den Familienalltag.
  try {
    const MEMBER_FILTER = 'NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)';
    const standings = d.prepare(`
      SELECT u.id, u.display_name, u.avatar_color, u.avatar_data, u.family_role,
             COALESCE((SELECT SUM(delta) FROM reward_ledger l WHERE l.user_id = u.id), 0) AS balance
      FROM users u
      JOIN reward_participants rp ON rp.user_id = u.id AND rp.enabled = 1
      WHERE ${MEMBER_FILTER}
      ORDER BY balance DESC, u.display_name COLLATE NOCASE ASC
      LIMIT 5
    `).all();
    const participantCount = d.prepare('SELECT COUNT(*) AS n FROM reward_participants WHERE enabled = 1').get().n;
    const pending = d.prepare("SELECT COUNT(*) AS n FROM reward_redemptions WHERE status = 'pending'").get().n;
    result.rewards = { standings, participantCount, pending };
  } catch (err) {
    log.error('rewards error:', err.message);
    result.rewards = { standings: [], participantCount: 0, pending: 0 };
  }

  // Gesundheit: heute fällige Dosen (nur familiensichtbare Medikamente — private
  // bleiben auf einem ggf. geteilten Familienbildschirm bewusst außen vor) plus
  // Nachbestell-Hinweis. Fälligkeit inline berechnet (days_mask, Zeitraum, Log-Status),
  // da public/utils/health-meds.js browser-Pfade importiert und serverseitig nicht ladbar ist.
  try {
    const meds = d.prepare(`
      SELECT id, name, stock_qty, refill_threshold
      FROM medications
      WHERE active = 1 AND visibility = 'family'
    `).all();
    const scheduleStmt = d.prepare(`
      SELECT time_of_day, days_mask, start_date, end_date
      FROM medication_schedules
      WHERE medication_id = ? AND active = 1
    `);
    const logStmt = d.prepare(`
      SELECT status FROM medication_logs
      WHERE medication_id = ? AND substr(scheduled_at, 1, 10) = ? AND substr(scheduled_at, 12, 5) = ?
      ORDER BY id DESC LIMIT 1
    `);
    let dosesTotal = 0;
    let dosesTaken = 0;
    let dosesSkipped = 0;
    let lowStockCount = 0;
    let nextDose = null;
    for (const med of meds) {
      if (med.stock_qty != null && Number.isFinite(Number(med.stock_qty))) {
        const stock = Number(med.stock_qty);
        const thr = med.refill_threshold != null && Number.isFinite(Number(med.refill_threshold))
          ? Number(med.refill_threshold)
          : null;
        if (stock <= 0 || (thr != null && stock <= thr)) lowStockCount += 1;
      }
      for (const s of scheduleStmt.all(med.id)) {
        if (s.start_date && todayLocalKey < s.start_date) continue;
        if (s.end_date && todayLocalKey > s.end_date) continue;
        const mask = s.days_mask;
        const matches = mask === null || mask === undefined
          ? true
          : (Number(mask) & (1 << localWeekdayIdx)) !== 0;
        if (!matches) continue;
        dosesTotal += 1;
        const time = s.time_of_day || '00:00';
        const logRow = logStmt.get(med.id, todayLocalKey, time);
        if (logRow?.status === 'taken') dosesTaken += 1;
        else if (logRow?.status === 'skipped') dosesSkipped += 1;
        else if (!nextDose || time < nextDose.time) nextDose = { name: med.name, time };
      }
    }
    result.health = {
      hasMeds: meds.length > 0,
      dosesTotal,
      dosesTaken,
      dosesSkipped,
      nextDose,
      lowStockCount,
    };
  } catch (err) {
    log.error('health error:', err.message);
    result.health = { hasMeds: false, dosesTotal: 0, dosesTaken: 0, dosesSkipped: 0, nextDose: null, lowStockCount: 0 };
  }

  // Haushaltshilfe: Anwesenheitsstatus (offene Sitzung), Besuche im laufenden Monat,
  // offener Zahlbetrag und letzter Besuch — ein kompakter Status statt einer Liste.
  try {
    const openSession = d.prepare(`
      SELECT hws.check_in, u.display_name AS worker_name
      FROM housekeeping_work_sessions hws
      LEFT JOIN housekeeping_workers hw ON hw.id = hws.worker_id
      LEFT JOIN users u ON u.id = hw.user_id
      WHERE hws.check_out IS NULL
      ORDER BY hws.check_in DESC LIMIT 1
    `).get();
    const monthRow = d.prepare(`
      SELECT COUNT(*) AS visits,
             COALESCE(SUM(CASE WHEN paid_at IS NULL THEN daily_rate + COALESCE(extras, 0) ELSE 0 END), 0) AS unpaid
      FROM housekeeping_work_sessions
      WHERE substr(check_in, 1, 7) = ? AND check_out IS NOT NULL
    `).get(currentMonth);
    const lastRow = d.prepare(`
      SELECT check_in FROM housekeeping_work_sessions
      WHERE check_out IS NOT NULL ORDER BY check_in DESC LIMIT 1
    `).get();
    const anyRow = d.prepare('SELECT 1 FROM housekeeping_work_sessions LIMIT 1').get()
      || d.prepare('SELECT 1 FROM housekeeping_workers LIMIT 1').get();
    result.housekeeping = {
      configured: Boolean(anyRow),
      present: Boolean(openSession),
      presentSince: openSession?.check_in || null,
      workerName: openSession?.worker_name || null,
      visitsThisMonth: monthRow?.visits || 0,
      unpaidAmount: monthRow?.unpaid || 0,
      lastVisit: lastRow?.check_in || null,
    };
  } catch (err) {
    log.error('housekeeping error:', err.message);
    result.housekeeping = { configured: false, present: false, presentSince: null, workerName: null, visitsThisMonth: 0, unpaidAmount: 0, lastVisit: null };
  }

  res.json(result);
  } catch (err) {
    log.error('Critical error:', err.message);
    res.status(500).json({ error: 'Dashboard could not be loaded.', code: 500 });
  }
});

export default router;
