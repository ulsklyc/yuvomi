/**
 * Modul: Housekeeping
 * Zweck: REST-API fuer Ponto/Financeiro, tarefas dinamicas, insumos e ocorrencias
 * Abhängigkeiten: express, server/db.js
 */

import express from 'express';
import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import { hashPassword } from '../utils/password.js';
import * as db from '../db.js';
import { normalizeAvatarData, syncFamilyMemberArtifacts } from '../auth.js';
import { collectErrors, color, date, datetime, month, num, oneOf, str, id as validateId, MAX_SHORT, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';
import { minutesBetween, computeHourlyAmount } from '../services/housekeeping-billing.js';
import { sendDocumentDeletionConflict } from '../services/document-deletion-lock.js';
import { assertDocumentLinkTargetsAvailable } from '../services/document-links.js';
import { dataUrlContentMatches } from '../utils/file-signature.js';
import {
  formatDateKey,
  formatMoney,
  householdRegion,
  resolveHouseholdFormats,
  translate,
} from '../utils/i18n.js';
import {
  OUTBOUND_SOURCES,
  mirroredFieldsChanged,
  queueEventDeletion,
} from '../services/calendar-outbound.js';

const log = createLogger('Housekeeping');
const router = express.Router();

const MAX_PHOTO_DATA_LENGTH = 6 * 1024 * 1024;
const IMAGE_DATA_RE = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i;
const PAYMENT_SCHEDULES = ['daily', 'twice_monthly', 'monthly'];
const DEFAULT_CALENDAR_COLOR = '#7C3AED';
const HOUSEKEEPING_EVENT_ICON = 'paintbrush';
const PAYMENT_TASKS_PREF = 'housekeeping_payment_tasks';

const TASK_TEMPLATES = [
  { key: 'cleanBathrooms', name: 'Clean bathrooms', area: 'Bathrooms', frequency_days: 7 },
  { key: 'mopKitchenFloor', name: 'Mop kitchen floor', area: 'Kitchen', frequency_days: 7 },
  { key: 'dustLivingRoom', name: 'Dust living room', area: 'Living room', frequency_days: 14 },
  { key: 'changeBedLinens', name: 'Change bed linens', area: 'Bedrooms', frequency_days: 14 },
  { key: 'cleanRefrigerator', name: 'Clean refrigerator', area: 'Kitchen', frequency_days: 30 },
  { key: 'cleanWindows', name: 'Clean windows', area: 'Whole house', frequency_days: 30 },
  { key: 'deepCleanOven', name: 'Deep clean oven', area: 'Kitchen', frequency_days: 60 },
  { key: 'washOutdoor', name: 'Wash balcony/patio', area: 'Outdoor', frequency_days: 30 },
];

function userId(req) {
  return req.authUserId || req.session.userId;
}

function nowIso() {
  return new Date().toISOString();
}

function currentMonth() {
  return nowIso().slice(0, 7);
}

function localDateString(dateValue = new Date()) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function localDayContext(source = {}) {
  const dateValue = typeof source.local_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source.local_date)
    ? source.local_date
    : localDateString();
  const offset = Number(source.timezone_offset_minutes);
  return {
    localDate: dateValue,
    timezoneOffsetMinutes: Number.isFinite(offset) ? offset : new Date().getTimezoneOffset(),
  };
}

function localDayRange(context = localDayContext()) {
  const normalized = context && typeof context === 'object' && typeof context.localDate === 'string'
    ? context
    : localDayContext();
  const [year, monthValue, day] = normalized.localDate.split('-').map(Number);
  const startMs = Date.UTC(year, monthValue - 1, day) + (normalized.timezoneOffsetMinutes * 60_000);
  const start = new Date(startMs);
  const end = new Date(startMs + 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function publicSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    worker_id: row.worker_id ?? null,
    calendar_event_id: row.calendar_event_id ?? null,
    payment_task_id: row.payment_task_id ?? null,
    receipt_document_id: row.receipt_document_id ?? null,
    check_in: row.check_in,
    check_out: row.check_out,
    daily_rate: Number(row.daily_rate || 0),
    extras: Number(row.extras || 0),
    paid_at: row.paid_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    rate_type: row.rate_type || 'daily',
    hourly_rate: Number(row.hourly_rate || 0),
    minutes_worked: row.minutes_worked ?? null,
  };
}

function publicWorker(row, context = localDayContext()) {
  if (!row) return null;
  const todaySession = loadTodaySession(row.id, context);
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    display_name: row.display_name,
    avatar_color: row.avatar_color,
    avatar_data: row.avatar_data ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    birth_date: row.birth_date ?? null,
    daily_rate: Number(row.daily_rate || 0),
    rate_type: row.rate_type || 'daily',
    hourly_rate: Number(row.hourly_rate || 0),
    payment_schedule: row.payment_schedule,
    calendar_color: row.calendar_color || DEFAULT_CALENDAR_COLOR,
    // Zwei verschiedene Fragen, die vorher dieselbe Zeile beantworteten:
    // `current_session` heisst "arbeitet gerade" und traegt den Auscheck-Knopf,
    // `today_session` heisst "war heute da" und traegt die Zeitangabe darunter.
    // Solange beide die letzte Sitzung des Tages lieferten, blieb ein Arbeiter
    // nach dem Auschecken "eingecheckt" (#1133).
    current_session: publicSession(loadOpenSession(row.id)),
    today_session: publicSession(todaySession),
    notes: row.notes ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function taskUrgency(row, now = new Date()) {
  const frequencyDays = Math.max(1, Number(row.frequency_days || 1));
  const completed = row.last_completed ? new Date(row.last_completed) : null;
  if (!completed || Number.isNaN(completed.getTime())) {
    return { urgency: Number.MAX_SAFE_INTEGER, status: 'overdue', due_date: null };
  }

  const due = new Date(completed);
  due.setDate(due.getDate() + frequencyDays);

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const elapsedDays = Math.max(0, (now.getTime() - completed.getTime()) / 86_400_000);
  const urgency = elapsedDays / frequencyDays;

  let status = 'ok';
  if (today.getTime() > dueDay.getTime()) status = 'overdue';
  else if (today.getTime() === dueDay.getTime()) status = 'today';

  return { urgency, status, due_date: due.toISOString() };
}

function publicDecayTask(row) {
  const computed = taskUrgency(row);
  return {
    id: row.id,
    name: row.name,
    area: row.area,
    frequency_days: row.frequency_days,
    last_completed: row.last_completed,
    urgency: computed.urgency === Number.MAX_SAFE_INTEGER ? null : Number(computed.urgency.toFixed(3)),
    urgency_status: computed.status,
    due_date: computed.due_date,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validatePhotoUrl(value) {
  if (value === undefined || value === null || value === '') return { value: null, error: null };
  if (typeof value !== 'string') return { value: null, error: 'Photo must be a data URL string.' };
  const trimmed = value.trim();
  if (trimmed.length > MAX_PHOTO_DATA_LENGTH) return { value: null, error: 'Photo is too large.' };
  if (!IMAGE_DATA_RE.test(trimmed)) return { value: null, error: 'Photo must be PNG, JPEG, or WebP.' };
  // Der Regex prueft die Deklaration, diese Zeile den Inhalt (#937).
  if (!dataUrlContentMatches(trimmed)) return { value: null, error: 'Photo content does not match its image type.' };
  return { value: trimmed, error: null };
}

function loadOpenSession(workerId = null) {
  if (workerId) {
    return db.get().prepare(`
      SELECT * FROM housekeeping_work_sessions
      WHERE check_out IS NULL AND worker_id = ?
      ORDER BY check_in DESC
      LIMIT 1
    `).get(workerId);
  }
  return db.get().prepare(`
    SELECT * FROM housekeeping_work_sessions
    WHERE check_out IS NULL
    ORDER BY check_in DESC
    LIMIT 1
  `).get();
}

function loadTodaySession(workerId, context = localDayContext()) {
  const { start, end } = localDayRange(context);
  return db.get().prepare(`
    SELECT * FROM housekeeping_work_sessions
    WHERE worker_id = ? AND check_in >= ? AND check_in < ?
    ORDER BY check_in DESC
    LIMIT 1
  `).get(workerId, start, end);
}

function housekeepingPaymentTasksEnabled(database = db.get()) {
  const row = database.prepare('SELECT value FROM sync_config WHERE key = ?').get(PAYMENT_TASKS_PREF);
  return row?.value === '1';
}

function defaultDailyRate() {
  const worker = loadWorker();
  if (worker) return Number(worker.daily_rate || 0);
  const row = db.get().prepare(`
    SELECT daily_rate FROM housekeeping_work_sessions
    ORDER BY check_in DESC
    LIMIT 1
  `).get();
  return Number(row?.daily_rate || 0);
}

function loadWorker() {
  return loadWorkers()[0] ?? null;
}

function loadWorkers() {
  return db.get().prepare(`
    SELECT hw.*,
           u.username,
           u.display_name,
           u.avatar_color,
           u.avatar_data,
           c.phone,
           c.email,
           b.birth_date
    FROM housekeeping_workers hw
    JOIN users u ON u.id = hw.user_id
    LEFT JOIN contacts c ON c.family_user_id = u.id
    LEFT JOIN birthdays b ON b.family_user_id = u.id
    ORDER BY u.display_name COLLATE NOCASE ASC
  `).all();
}

// Die Oberfläche schickt Titel und Beschreibung fertig übersetzt mit
// (`visitTextPayload` in public/pages/housekeeping.js). Diese Fallbacks greifen
// für alles, was die API direkt anspricht - MCP, Skripte, Integrationen. Sie
// standen fest auf Englisch, obwohl die Texte in `calendar_events`/`tasks`
// landen und von dort in API, ICS-Feed und Sync gehen; deshalb dieselbe
// Datensprache wie bei den Geburtstags-Terminen (#631, #632). Die Locale-Keys
// sind dieselben, die der Client benutzt - eine Formulierung, zwei Aufrufer.
function visitTitleFallback(database, worker) {
  const { locale } = resolveHouseholdFormats(database);
  return translate(locale, 'housekeeping.calendarVisitTitle', { name: worker.display_name });
}

function paymentTitleFallback(database, worker) {
  const { locale } = resolveHouseholdFormats(database);
  return translate(locale, 'housekeeping.paymentTaskTitle', { name: worker.display_name });
}

function paymentDescriptionFallback(database, visitDate, amount) {
  const { locale, dateFormat, currency } = resolveHouseholdFormats(database);
  return translate(locale, 'housekeeping.paymentTaskDescription', {
    date: formatDateKey(visitDate, dateFormat),
    amount: formatMoney(amount, { locale, currency, region: householdRegion(database) }),
  });
}

function createVisitCalendarEvent(database, worker, checkIn, actorId, title = null, visitDateOverride = null) {
  const visitDate = visitDateOverride || checkIn.slice(0, 10);
  const result = database.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, color, icon, assigned_to, created_by, external_source)
    VALUES (?, ?, NULL, 1, ?, ?, ?, ?, 'local')
  `).run(
    title || visitTitleFallback(database, worker),
    visitDate,
    worker.calendar_color || DEFAULT_CALENDAR_COLOR,
    HOUSEKEEPING_EVENT_ICON,
    worker.user_id,
    actorId,
  );
  database.prepare('INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)')
    .run(result.lastInsertRowid, worker.user_id);
  return result.lastInsertRowid;
}

function createPaymentTask(database, worker, checkIn, amount, actorId, title = null, description = null, visitDateOverride = null) {
  const visitDate = visitDateOverride || checkIn.slice(0, 10);
  const result = database.prepare(`
    INSERT INTO tasks (title, description, due_date, priority, category, status, created_by)
    VALUES (?, ?, ?, 'medium', 'household', 'open', ?)
  `).run(
    title || paymentTitleFallback(database, worker),
    description || paymentDescriptionFallback(database, visitDate, amount),
    visitDate,
    actorId,
  );
  return result.lastInsertRowid;
}

function updateVisitLinks(database, session, worker, checkIn, dailyRate, extras, eventTitle = null, paymentTitle = null, paymentDescription = null) {
  const visitDate = checkIn.slice(0, 10);
  if (session.calendar_event_id) {
    // Datum, Titel und Farbe des Termins stehen in MIRRORED_FIELDS. Ein Besuch,
    // den der Apple-Sync bereits hochgeladen hat, trägt external_source='apple'
    // und erreicht den Provider nur noch über outbound_dirty - ohne die
    // Vormerkung bliebe die Verschiebung eines Besuchs lokal (dieselbe Lücke wie
    // bei den Geburtstags-Titeln in #632).
    const before = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(session.calendar_event_id);
    database.prepare(`
      UPDATE calendar_events
      SET title = COALESCE(?, title),
          start_datetime = ?,
          end_datetime = NULL,
          all_day = 1,
          color = ?,
          -- Die Farbe kommt von der Betreuungskraft, nicht vom Provider: mit dem
          -- Flag daneben führt Yuvomi sie auch weiter (#899). Ohne es schriebe
          -- der Outbound sie als CSS3-Namen hinaus und der nächste Inbound-Lauf
          -- holte den gerundeten Wert zurück - der Besuch wechselte still seine
          -- Farbe, obwohl niemand sie angefasst hat.
          color_modified = 1,
          icon = ?
      WHERE id = ?
    `).run(
      eventTitle,
      visitDate,
      worker?.calendar_color || DEFAULT_CALENDAR_COLOR,
      HOUSEKEEPING_EVENT_ICON,
      session.calendar_event_id,
    );
    const after = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(session.calendar_event_id);
    // Marker inline statt über markEventOutbound, aus zwei Gründen:
    //
    //   - markEventOutbound lehnt einen schreibgeschützten Provider ab
    //     (`google_readonly`). Der Marker ist aber nicht nur ein Push-Auftrag,
    //     sondern auch der Schutz davor, dass der Inbound die lokale Änderung
    //     überschreibt - `if (existing?.outbound_dirty) continue`. Ohne ihn
    //     verlöre ein verschobener Besuch sein Datum an den alten Serverstand,
    //     sobald jemand den Nur-Lesen-Modus einschaltet.
    //   - Es schreibt über db.get() und umginge die hier übergebene Connection.
    //
    // Der Feldvergleich bleibt derselbe: mirroredFieldsChanged prüft genau die
    // Felder, die zum Provider gespiegelt werden.
    const mirrored = after && OUTBOUND_SOURCES.includes(after.external_source) && !!after.external_calendar_id;
    if (before && mirrored && mirroredFieldsChanged(before, after)) {
      database.prepare(
        'UPDATE calendar_events SET outbound_dirty = 1, outbound_attempts = 0 WHERE id = ?'
      ).run(session.calendar_event_id);
    }
  }
  if (session.payment_task_id) {
    const totalAmount = Number(dailyRate || 0) + Number(extras || 0);
    database.prepare(`
      UPDATE tasks
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          due_date = ?
      WHERE id = ?
    `).run(
      paymentTitle,
      paymentDescription || paymentDescriptionFallback(database, visitDate, totalAmount),
      visitDate,
      session.payment_task_id,
    );
  }
}

function deleteVisitLinks(database, session) {
  if (session.calendar_event_id) {
    // Beim Provider liegende Kopie mit abräumen: ein reines DELETE hier ließe
    // den Termin in iCloud/Google/Nextcloud stehen, und der nächste Inbound-Lauf
    // spielte ihn womöglich wieder ein.
    const event = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(session.calendar_event_id);
    if (event) queueEventDeletion(event, database);
    database.prepare('DELETE FROM calendar_events WHERE id = ?').run(session.calendar_event_id);
  }
  if (session.payment_task_id) database.prepare('DELETE FROM tasks WHERE id = ?').run(session.payment_task_id);
}

function reconcilePaymentTasks(database = db.get()) {
  database.prepare(`
    UPDATE housekeeping_work_sessions
    SET paid_at = COALESCE(paid_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    WHERE payment_task_id IS NOT NULL
      AND paid_at IS NULL
      AND EXISTS (
        SELECT 1 FROM tasks
        WHERE tasks.id = housekeeping_work_sessions.payment_task_id
          AND tasks.status = 'done'
      )
  `).run();
}

function loadWorkerById(workerId) {
  return db.get().prepare(`
    SELECT hw.*,
           u.username,
           u.display_name,
           u.avatar_color,
           u.avatar_data,
           c.phone,
           c.email,
           b.birth_date
    FROM housekeeping_workers hw
    JOIN users u ON u.id = hw.user_id
    LEFT JOIN contacts c ON c.family_user_id = u.id
    LEFT JOIN birthdays b ON b.family_user_id = u.id
    WHERE hw.id = ?
  `).get(workerId);
}

function monthlySummary(monthValue = currentMonth()) {
  const row = db.get().prepare(`
    SELECT
      COUNT(*) AS session_count,
      COALESCE(SUM(daily_rate), 0) AS daily_total,
      COALESCE(SUM(extras), 0) AS extras_total,
      COALESCE(SUM(daily_rate + extras), 0) AS total_amount
    FROM housekeeping_work_sessions
    WHERE substr(check_in, 1, 7) = ?
  `).get(monthValue);

  return {
    month: monthValue,
    session_count: row.session_count,
    daily_total: Number(row.daily_total || 0),
    extras_total: Number(row.extras_total || 0),
    total_amount: Number(row.total_amount || 0),
  };
}

function housekeepingDashboard() {
  reconcilePaymentTasks();
  const monthValue = currentMonth();
  const context = localDayContext();
  const workers = loadWorkers().map((row) => publicWorker(row, context));
  const worker = workers[0] ?? null;
  const summary = monthlySummary(monthValue);
  const lastVisit = db.get().prepare(`
    SELECT * FROM housekeeping_work_sessions
    ORDER BY check_in DESC
    LIMIT 1
  `).get();
  const payment = db.get().prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN paid_at IS NULL THEN daily_rate + extras ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN paid_at IS NOT NULL THEN daily_rate + extras ELSE 0 END), 0) AS paid
    FROM housekeeping_work_sessions
    WHERE substr(check_in, 1, 7) = ?
  `).get(monthValue);
  const taskRows = db.get().prepare('SELECT * FROM housekeeping_decay_tasks').all();
  const tasks = taskRows.map(publicDecayTask);
  const chart = db.get().prepare(`
    SELECT substr(check_in, 1, 7) AS month,
           COALESCE(SUM(daily_rate + extras), 0) AS total,
           COALESCE(SUM(CASE WHEN paid_at IS NULL THEN daily_rate + extras ELSE 0 END), 0) AS pending
    FROM housekeeping_work_sessions
    WHERE check_in >= strftime('%Y-%m-01T00:00:00Z', 'now', '-5 months')
    GROUP BY substr(check_in, 1, 7)
    ORDER BY month ASC
  `).all().map((row) => ({
    month: row.month,
    total: Number(row.total || 0),
    pending: Number(row.pending || 0),
  }));

  return {
    worker,
    workers,
    current_session: null,
    visits_this_month: summary.session_count,
    last_visit: publicSession(lastVisit),
    pending_tasks: tasks.filter((task) => task.urgency_status !== 'ok').length,
    finished_tasks_this_month: taskRows.filter((task) => task.last_completed?.slice(0, 7) === monthValue).length,
    pending_payments: Number(payment.pending || 0),
    paid_this_month: Number(payment.paid || 0),
    monthly_payments: chart,
  };
}

function assertAdmin(req, res) {
  if (req.authRole === 'admin') return true;
  res.status(403).json({ error: 'Permission denied.', code: 403 });
  return false;
}

// Ein bezahlter Besuch ist abgerechnet: der Betrag ist an eine reale Person
// geflossen. Bis zur Bezahlung darf jedes Mitglied Datum, Satz und Extras
// pflegen - wer die Hilfe ein- und auscheckt, korrigiert auch den Zettel.
// Danach gilt dieselbe Grenze wie beim Anlegen des Arbeitsverhaeltnisses
// (POST /worker): nur ein Admin aendert, loescht oder bucht einen bezahlten
// Besuch erneut (GHSA-4p5w-5346-8598).
function assertMayTouchSettled(existing, req, res) {
  if (!existing.paid_at) return true;
  return assertAdmin(req, res);
}

async function createWorkerUser({ username, displayName, avatarColor, avatarData, actorUserId }) {
  const finalUsername = username || `housekeeper_${Date.now()}`;
  const password = crypto.randomBytes(24).toString('base64url');
  const hash = await hashPassword(password);
  const result = db.get().prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, avatar_data, role, family_role)
    VALUES (?, ?, ?, ?, ?, 'member', 'other')
  `).run(finalUsername, displayName, hash, avatarColor || '#7C3AED', avatarData ?? null);
  syncFamilyMemberArtifacts(db.get(), result.lastInsertRowid, {
    displayName,
    avatarData: avatarData ?? null,
    actorUserId,
  });
  return result.lastInsertRowid;
}

function defaultShoppingCategory() {
  const preferred = db.get()
    .prepare("SELECT name FROM shopping_categories WHERE name = 'Haushalt' COLLATE NOCASE LIMIT 1")
    .get();
  if (preferred) return preferred.name;
  const fallback = db.get()
    .prepare("SELECT name FROM shopping_categories WHERE name = 'Sonstiges' COLLATE NOCASE LIMIT 1")
    .get();
  return fallback?.name || 'Sonstiges';
}

function defaultShoppingList(actorId) {
  const existing = db.get().prepare(`
    SELECT id FROM shopping_lists
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `).get();
  if (existing) return existing.id;

  const result = db.get()
    .prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)')
    .run('Housekeeping', actorId);
  return result.lastInsertRowid;
}

router.get('/dashboard', (_req, res) => {
  try {
    res.json({ data: housekeepingDashboard() });
  } catch (err) {
    log.error('GET /dashboard error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/task-templates', (_req, res) => {
  try {
    res.json({ data: TASK_TEMPLATES });
  } catch (err) {
    log.error('GET /task-templates error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/worker', (req, res) => {
  try {
    res.json({ data: publicWorker(loadWorker(), localDayContext(req.query)) });
  } catch (err) {
    log.error('GET /worker error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/workers', (req, res) => {
  try {
    const context = localDayContext(req.query);
    res.json({ data: loadWorkers().map((worker) => publicWorker(worker, context)) });
  } catch (err) {
    log.error('GET /workers error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/worker', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const vWorkerId = req.body.id !== undefined && req.body.id !== null && req.body.id !== ''
      ? validateId(req.body.id, 'id')
      : { value: null, error: null };
    if (vWorkerId.error) return res.status(400).json({ error: vWorkerId.error, code: 400 });
    const existing = vWorkerId.value ? loadWorkerById(vWorkerId.value) : null;
    if (vWorkerId.value && !existing) return res.status(404).json({ error: 'Housekeeper not found.', code: 404 });

    const vDisplayName = str(req.body.display_name, 'display_name', { max: 128 });
    const vUsername = str(req.body.username, 'username', { max: 64, required: false });
    const vPhone = str(req.body.phone, 'phone', { max: MAX_SHORT, required: false });
    const vEmail = str(req.body.email, 'email', { max: MAX_TITLE, required: false });
    const vBirthDate = date(req.body.birth_date, 'birth_date');
    const vDailyRate = num(req.body.daily_rate, 'daily_rate', { required: true });
    const vSchedule = oneOf(req.body.payment_schedule || 'monthly', PAYMENT_SCHEDULES, 'payment_schedule');
    const vCalendarColor = color(req.body.calendar_color || DEFAULT_CALENDAR_COLOR, 'calendar_color');
    const vNotes = str(req.body.notes, 'notes', { max: MAX_TEXT, required: false });
    const vRateType = oneOf(req.body.rate_type || 'daily', ['daily', 'hourly'], 'rate_type');
    const vHourlyRate = num(req.body.hourly_rate, 'hourly_rate');
    const errors = collectErrors([vDisplayName, vUsername, vPhone, vEmail, vBirthDate, vDailyRate, vSchedule, vCalendarColor, vNotes, vRateType, vHourlyRate]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (vUsername.value && !/^[a-zA-Z0-9._-]{3,64}$/.test(vUsername.value)) {
      return res.status(400).json({ error: 'Username must be 3-64 characters long and may only contain letters, numbers, dots, hyphens, and underscores.', code: 400 });
    }
    if (vDailyRate.value < 0) {
      return res.status(400).json({ error: 'daily_rate must be greater than or equal to zero.', code: 400 });
    }
    if ((vHourlyRate.value ?? 0) < 0) {
      return res.status(400).json({ error: 'hourly_rate must be greater than or equal to zero.', code: 400 });
    }
    const avatarColor = String(req.body.avatar_color || '#7C3AED').trim();
    const avatarData = req.body.avatar_data !== undefined
      ? normalizeAvatarData(req.body.avatar_data)
      : existing?.avatar_data ?? null;
    if (avatarData?.error) {
      return res.status(400).json({ error: avatarData.error, code: 400 });
    }

    const actorId = userId(req);
    const targetUserId = existing ? existing.user_id : await createWorkerUser({
      username: vUsername.value,
      displayName: vDisplayName.value,
      avatarColor,
      avatarData,
      actorUserId: actorId,
    });

    db.get().transaction(() => {
      db.get().prepare(`
        UPDATE users
        SET username = ?, display_name = ?, avatar_color = ?, avatar_data = ?
        WHERE id = ?
      `).run(
        vUsername.value || existing?.username || `housekeeper_${targetUserId}`,
        vDisplayName.value,
        avatarColor || '#7C3AED',
        avatarData ?? null,
        targetUserId,
      );
      db.get().prepare(`
        INSERT INTO housekeeping_workers (user_id, daily_rate, payment_schedule, calendar_color, notes, rate_type, hourly_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          daily_rate = excluded.daily_rate,
          payment_schedule = excluded.payment_schedule,
          calendar_color = excluded.calendar_color,
          notes = excluded.notes,
          rate_type = excluded.rate_type,
          hourly_rate = excluded.hourly_rate
      `).run(targetUserId, vDailyRate.value, vSchedule.value, vCalendarColor.value, vNotes.value, vRateType.value, vHourlyRate.value ?? 0);
      syncFamilyMemberArtifacts(db.get(), targetUserId, {
        displayName: vDisplayName.value,
        phone: vPhone.value,
        email: vEmail.value,
        birthDate: vBirthDate.value,
        avatarData: avatarData ?? null,
        actorUserId: actorId,
      });
    })();

    const saved = existing ? loadWorkerById(existing.id) : loadWorkers().find((worker) => worker.user_id === targetUserId);
    res.status(existing ? 200 : 201).json({ data: publicWorker(saved) });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Username is already taken.', code: 409 });
    }
    log.error('POST /worker error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/summary', (req, res) => {
  try {
    const vMonth = month(req.query.month, 'month');
    if (vMonth.error) return res.status(400).json({ error: vMonth.error, code: 400 });
    res.json({
      data: {
        current_session: publicSession(loadOpenSession()),
        default_daily_rate: defaultDailyRate(),
        summary: monthlySummary(vMonth.value || currentMonth()),
      },
    });
  } catch (err) {
    log.error('GET /summary error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/work-sessions', (req, res) => {
  try {
    reconcilePaymentTasks();
    const vMonth = month(req.query.month, 'month');
    if (vMonth.error) return res.status(400).json({ error: vMonth.error, code: 400 });
    const rows = db.get().prepare(`
      SELECT * FROM housekeeping_work_sessions
      WHERE substr(check_in, 1, 7) = ?
      ORDER BY check_in DESC
    `).all(vMonth.value || currentMonth());
    res.json({ data: rows.map(publicSession) });
  } catch (err) {
    log.error('GET /work-sessions error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/visits', (req, res) => {
  try {
    reconcilePaymentTasks();
    const vMonth = month(req.query.month, 'month');
    if (vMonth.error) return res.status(400).json({ error: vMonth.error, code: 400 });
    const vWorkerId = req.query.worker_id !== undefined && req.query.worker_id !== ''
      ? validateId(req.query.worker_id, 'worker_id')
      : { value: null, error: null };
    if (vWorkerId.error) return res.status(400).json({ error: vWorkerId.error, code: 400 });
    const selectedMonth = vMonth.value || currentMonth();
    const rows = db.get().prepare(`
      SELECT hws.*,
             hw.payment_schedule,
             u.display_name AS worker_name,
             u.avatar_color AS worker_avatar_color,
             u.avatar_data AS worker_avatar_data,
             t.status AS payment_task_status,
             t.title AS payment_task_title,
             fd.name AS receipt_document_name
      FROM housekeeping_work_sessions hws
      LEFT JOIN housekeeping_workers hw ON hw.id = hws.worker_id
      LEFT JOIN users u ON u.id = hw.user_id
      LEFT JOIN tasks t ON t.id = hws.payment_task_id
      LEFT JOIN family_documents fd ON fd.id = hws.receipt_document_id
      WHERE substr(hws.check_in, 1, 7) = ?
        AND (? IS NULL OR hws.worker_id = ?)
      ORDER BY hws.check_in DESC
    `).all(selectedMonth, vWorkerId.value, vWorkerId.value);
    const visits = rows.map((row) => ({
      ...publicSession(row),
      worker_name: row.worker_name ?? null,
      worker_avatar_color: row.worker_avatar_color ?? DEFAULT_CALENDAR_COLOR,
      worker_avatar_data: row.worker_avatar_data ?? null,
      payment_schedule: row.payment_schedule ?? 'monthly',
      payment_task_status: row.payment_task_status ?? null,
      payment_task_title: row.payment_task_title ?? null,
      receipt_document_name: row.receipt_document_name ?? null,
      total_amount: Number(row.daily_rate || 0) + Number(row.extras || 0),
    }));
    const totals = visits.reduce((acc, visit) => {
      acc.total += visit.total_amount;
      if (visit.paid_at) acc.paid += visit.total_amount;
      else acc.pending += visit.total_amount;
      return acc;
    }, { total: 0, paid: 0, pending: 0 });
    res.json({ data: { month: selectedMonth, visits, totals } });
  } catch (err) {
    log.error('GET /visits error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/work-sessions/check-in', (req, res) => {
  try {
    if (loadWorkers().length === 0) {
      return res.status(400).json({ error: 'Add a housekeeper before checking in.', code: 400 });
    }
    const vWorkerId = validateId(req.body.worker_id, 'worker_id');
    if (vWorkerId.error) return res.status(400).json({ error: vWorkerId.error, code: 400 });
    const worker = loadWorkerById(vWorkerId.value);
    if (!worker) return res.status(404).json({ error: 'Housekeeper not found.', code: 404 });
    const workerRateType = worker.rate_type || 'daily';
    const workerHourlyRate = worker.hourly_rate ?? 0;
    const context = localDayContext(req.body);
    // Nur eine OFFENE Sitzung sperrt. Vorher sperrte jede Sitzung des Tages,
    // auch eine laengst abgeschlossene - geteilte Schichten, eine Pause mit
    // Wiederaufnahme und zwei getrennte Besuche am selben Tag waren damit
    // unmoeglich (#1138).
    if (loadOpenSession(worker.id)) return res.status(409).json({ error: 'This housekeeper is already checked in.', code: 409 });

    const vDailyRate = num(req.body.daily_rate, 'daily_rate', { required: true });
    const vExtras = num(req.body.extras, 'extras');
    const vEventTitle = str(req.body.event_title, 'event_title', { max: MAX_TITLE, required: false });
    const vPaymentTitle = str(req.body.payment_title, 'payment_title', { max: MAX_TITLE, required: false });
    const vPaymentDescription = str(req.body.payment_description, 'payment_description', { max: MAX_TEXT, required: false });
    const errors = collectErrors([vDailyRate, vExtras, vEventTitle, vPaymentTitle, vPaymentDescription]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (vDailyRate.value < 0 || (vExtras.value ?? 0) < 0) {
      return res.status(400).json({ error: 'Amounts must be greater than or equal to zero.', code: 400 });
    }

    const actorId = userId(req);
    const checkIn = nowIso();
    const result = db.get().transaction(() => {
      const eventId = createVisitCalendarEvent(db.get(), worker, checkIn, actorId, vEventTitle.value, context.localDate);
      const totalAmount = Number(vDailyRate.value || 0) + Number(vExtras.value || 0);
      const taskId = housekeepingPaymentTasksEnabled(db.get())
        ? createPaymentTask(db.get(), worker, checkIn, totalAmount, actorId, vPaymentTitle.value, vPaymentDescription.value, context.localDate)
        : null;
      return db.get().prepare(`
        INSERT INTO housekeeping_work_sessions (worker_id, check_in, check_out, daily_rate, extras, calendar_event_id, payment_task_id, created_by, rate_type, hourly_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(worker.id, checkIn, null, vDailyRate.value, vExtras.value ?? 0, eventId, taskId, actorId, workerRateType, workerHourlyRate);
    })();
    const row = db.get().prepare('SELECT * FROM housekeeping_work_sessions WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: publicSession(row), summary: monthlySummary() });
  } catch (err) {
    log.error('POST /work-sessions/check-in error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/visits/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const row = db.get().prepare(`
      SELECT hws.*,
             hw.payment_schedule,
             u.display_name AS worker_name,
             u.avatar_color AS worker_avatar_color,
             u.avatar_data  AS worker_avatar_data,
             t.status  AS payment_task_status,
             t.title   AS payment_task_title,
             fd.name   AS receipt_document_name
      FROM housekeeping_work_sessions hws
      LEFT JOIN housekeeping_workers hw ON hw.id = hws.worker_id
      LEFT JOIN users u ON u.id = hw.user_id
      LEFT JOIN tasks t ON t.id = hws.payment_task_id
      LEFT JOIN family_documents fd ON fd.id = hws.receipt_document_id
      WHERE hws.id = ?
    `).get(vId.value);
    if (!row) return res.status(404).json({ error: 'Visit not found.', code: 404 });
    const visit = {
      ...publicSession(row),
      worker_name: row.worker_name ?? null,
      worker_avatar_color: row.worker_avatar_color ?? null,
      worker_avatar_data: row.worker_avatar_data ?? null,
      payment_schedule: row.payment_schedule ?? 'monthly',
      payment_task_status: row.payment_task_status ?? null,
      payment_task_title: row.payment_task_title ?? null,
      receipt_document_name: row.receipt_document_name ?? null,
      total_amount: Number(row.daily_rate || 0) + Number(row.extras || 0),
    };
    res.json({ data: visit });
  } catch (err) {
    log.error('GET /visits/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.put('/visits/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const existing = db.get().prepare('SELECT * FROM housekeeping_work_sessions WHERE id = ?').get(vId.value);
    if (!existing) return res.status(404).json({ error: 'Visit not found.', code: 404 });
    if (!assertMayTouchSettled(existing, req, res)) return;

    const vDate = date(req.body.date, 'date', true);
    const isHourly = existing.rate_type === 'hourly';
    const vDailyRate = num(req.body.daily_rate, 'daily_rate', { required: !isHourly });
    const vExtras = num(req.body.extras, 'extras');
    const vEventTitle = str(req.body.event_title, 'event_title', { max: MAX_TITLE, required: false });
    const vPaymentTitle = str(req.body.payment_title, 'payment_title', { max: MAX_TITLE, required: false });
    const vPaymentDescription = str(req.body.payment_description, 'payment_description', { max: MAX_TEXT, required: false });
    const vReceiptId = req.body.receipt_document_id !== undefined && req.body.receipt_document_id !== null && req.body.receipt_document_id !== ''
      ? validateId(req.body.receipt_document_id, 'receipt_document_id')
      : { value: null, error: null };
    const vMinutesWorked = isHourly && req.body.minutes_worked !== undefined
      ? num(req.body.minutes_worked, 'minutes_worked')
      : { value: null, error: null };
    if (vMinutesWorked.error) return res.status(400).json({ error: vMinutesWorked.error, code: 400 });
    const errors = collectErrors([vDate, vDailyRate, vExtras, vEventTitle, vPaymentTitle, vPaymentDescription, vReceiptId]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const receiptDocumentId = req.body.receipt_document_id !== undefined && vReceiptId.value !== null
      ? assertDocumentLinkTargetsAvailable(
        db.get(),
        [vReceiptId.value],
        req.authUserId || req.session.userId,
      )[0] ?? null
      : vReceiptId.value;
    if (vDailyRate.value < 0 || (vExtras.value ?? 0) < 0) {
      return res.status(400).json({ error: 'Amounts must be greater than or equal to zero.', code: 400 });
    }

    let effectiveDailyRate = vDailyRate.value ?? existing.daily_rate;
    if (isHourly && vMinutesWorked.value !== null) {
      effectiveDailyRate = computeHourlyAmount(vMinutesWorked.value, existing.hourly_rate || 0);
    }

    const originalTime = existing.check_in?.slice(11) || '09:00:00.000Z';
    const checkIn = `${vDate.value}T${originalTime}`;
    const worker = existing.worker_id ? loadWorkerById(existing.worker_id) : null;
    db.get().transaction(() => {
      db.get().prepare(`
        UPDATE housekeeping_work_sessions
        SET check_in = ?, check_out = ?, daily_rate = ?, extras = ?, receipt_document_id = ?, minutes_worked = ?
        WHERE id = ?
      `).run(
        checkIn,
        checkIn,
        effectiveDailyRate,
        vExtras.value ?? 0,
        req.body.receipt_document_id !== undefined ? receiptDocumentId : existing.receipt_document_id,
        vMinutesWorked.value !== null ? vMinutesWorked.value : existing.minutes_worked,
        existing.id,
      );
      updateVisitLinks(
        db.get(),
        existing,
        worker,
        checkIn,
        effectiveDailyRate,
        vExtras.value ?? 0,
        vEventTitle.value,
        vPaymentTitle.value,
        vPaymentDescription.value,
      );
    })();
    const row = db.get().prepare('SELECT * FROM housekeeping_work_sessions WHERE id = ?').get(existing.id);
    res.json({ data: publicSession(row), summary: monthlySummary(row.check_in.slice(0, 7)) });
  } catch (err) {
    if (sendDocumentDeletionConflict(res, err)) return;
    log.error('PUT /visits/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/visits/:id/pay', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const existing = db.get().prepare('SELECT * FROM housekeeping_work_sessions WHERE id = ?').get(vId.value);
    if (!existing) return res.status(404).json({ error: 'Visit not found.', code: 404 });
    if (!assertMayTouchSettled(existing, req, res)) return;
    const paidAt = nowIso();
    db.get().transaction(() => {
      db.get().prepare('UPDATE housekeeping_work_sessions SET paid_at = ? WHERE id = ?').run(paidAt, existing.id);
      if (existing.payment_task_id) {
        db.get().prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', existing.payment_task_id);
      }
    })();
    const row = db.get().prepare('SELECT * FROM housekeeping_work_sessions WHERE id = ?').get(existing.id);
    res.json({ data: publicSession(row), summary: monthlySummary(row.check_in.slice(0, 7)) });
  } catch (err) {
    log.error('POST /visits/:id/pay error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/visits/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const existing = db.get().prepare('SELECT * FROM housekeeping_work_sessions WHERE id = ?').get(vId.value);
    if (!existing) return res.status(404).json({ error: 'Visit not found.', code: 404 });
    if (!assertMayTouchSettled(existing, req, res)) return;
    db.get().transaction(() => {
      deleteVisitLinks(db.get(), existing);
      db.get().prepare('DELETE FROM housekeeping_work_sessions WHERE id = ?').run(existing.id);
    })();
    res.json({ data: { summary: monthlySummary() } });
  } catch (err) {
    log.error('DELETE /visits/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/work-sessions/check-out', (req, res) => {
  try {
    const vWorkerId = validateId(req.body.worker_id, 'worker_id');
    if (vWorkerId.error) return res.status(400).json({ error: vWorkerId.error, code: 400 });
    const session = loadOpenSession(vWorkerId.value);
    if (!session) return res.status(404).json({ error: 'No open work session found.', code: 404 });

    const vExtras = num(req.body.extras, 'extras');
    if (vExtras.error) return res.status(400).json({ error: vExtras.error, code: 400 });
    if ((vExtras.value ?? session.extras) < 0) {
      return res.status(400).json({ error: 'Extras must be greater than or equal to zero.', code: 400 });
    }

    const checkOut = nowIso();
    const worker = session.worker_id ? loadWorkerById(session.worker_id) : null;
    let updateRate = session.daily_rate;
    let minutesWorked = session.minutes_worked ?? null;
    let sessionRateType = session.rate_type || 'daily';
    let sessionHourlyRate = session.hourly_rate ?? 0;
    if (worker?.rate_type === 'hourly') {
      sessionRateType = 'hourly';
      sessionHourlyRate = worker.hourly_rate;
      minutesWorked = minutesBetween(session.check_in, checkOut);
      updateRate = computeHourlyAmount(minutesWorked ?? 0, worker.hourly_rate);
    }
    db.get().transaction(() => {
      db.get().prepare(`
        UPDATE housekeeping_work_sessions
        SET check_out = ?, extras = ?, daily_rate = ?, minutes_worked = ?, rate_type = ?, hourly_rate = ?
        WHERE id = ?
      `).run(checkOut, vExtras.value ?? session.extras, updateRate, minutesWorked, sessionRateType, sessionHourlyRate, session.id);
    })();
    const row = db.get().prepare('SELECT * FROM housekeeping_work_sessions WHERE id = ?').get(session.id);
    res.json({ data: publicSession(row), summary: monthlySummary(row.check_in.slice(0, 7)) });
  } catch (err) {
    log.error('POST /work-sessions/check-out error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/decay-tasks', (_req, res) => {
  try {
    const rows = db.get().prepare('SELECT * FROM housekeeping_decay_tasks ORDER BY area COLLATE NOCASE, name COLLATE NOCASE').all();
    const tasks = rows
      .map(publicDecayTask)
      .sort((a, b) => {
        const rank = { overdue: 0, today: 1, ok: 2 };
        const rankDiff = rank[a.urgency_status] - rank[b.urgency_status];
        if (rankDiff !== 0) return rankDiff;
        return (b.urgency ?? 9999) - (a.urgency ?? 9999);
      });
    res.json({ data: tasks });
  } catch (err) {
    log.error('GET /decay-tasks error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/decay-tasks', (req, res) => {
  try {
    const vName = str(req.body.name, 'name', { max: MAX_TITLE });
    const vArea = str(req.body.area, 'area', { max: MAX_SHORT });
    const vFrequency = num(req.body.frequency_days, 'frequency_days', { required: true });
    const vCompleted = datetime(req.body.last_completed, 'last_completed');
    const errors = collectErrors([vName, vArea, vFrequency, vCompleted]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (!Number.isInteger(vFrequency.value) || vFrequency.value < 1) {
      return res.status(400).json({ error: 'frequency_days must be a positive integer.', code: 400 });
    }

    const result = db.get().prepare(`
      INSERT INTO housekeeping_decay_tasks (name, area, frequency_days, last_completed, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(vName.value, vArea.value, vFrequency.value, vCompleted.value, userId(req));
    const row = db.get().prepare('SELECT * FROM housekeeping_decay_tasks WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: publicDecayTask(row) });
  } catch (err) {
    log.error('POST /decay-tasks error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.patch('/decay-tasks/:taskId', (req, res) => {
  try {
    const vId = validateId(req.params.taskId, 'taskId');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const existing = db.get().prepare('SELECT * FROM housekeeping_decay_tasks WHERE id = ?').get(vId.value);
    if (!existing) return res.status(404).json({ error: 'Task not found.', code: 404 });

    const vName = req.body.name !== undefined ? str(req.body.name, 'name', { max: MAX_TITLE }) : { value: existing.name, error: null };
    const vArea = req.body.area !== undefined ? str(req.body.area, 'area', { max: MAX_SHORT }) : { value: existing.area, error: null };
    const vFrequency = req.body.frequency_days !== undefined ? num(req.body.frequency_days, 'frequency_days', { required: true }) : { value: existing.frequency_days, error: null };
    const vCompleted = req.body.last_completed !== undefined ? datetime(req.body.last_completed, 'last_completed') : { value: existing.last_completed, error: null };
    const errors = collectErrors([vName, vArea, vFrequency, vCompleted]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (!Number.isInteger(Number(vFrequency.value)) || Number(vFrequency.value) < 1) {
      return res.status(400).json({ error: 'frequency_days must be a positive integer.', code: 400 });
    }

    db.get().prepare(`
      UPDATE housekeeping_decay_tasks
      SET name = ?, area = ?, frequency_days = ?, last_completed = ?
      WHERE id = ?
    `).run(vName.value, vArea.value, Number(vFrequency.value), vCompleted.value, vId.value);
    const row = db.get().prepare('SELECT * FROM housekeeping_decay_tasks WHERE id = ?').get(vId.value);
    res.json({ data: publicDecayTask(row) });
  } catch (err) {
    log.error('PATCH /decay-tasks/:taskId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/decay-tasks/:taskId/complete', (req, res) => {
  try {
    const vId = validateId(req.params.taskId, 'taskId');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const existing = db.get().prepare('SELECT * FROM housekeeping_decay_tasks WHERE id = ?').get(vId.value);
    if (!existing) return res.status(404).json({ error: 'Task not found.', code: 404 });

    db.get().prepare('UPDATE housekeeping_decay_tasks SET last_completed = ? WHERE id = ?').run(nowIso(), vId.value);
    const row = db.get().prepare('SELECT * FROM housekeeping_decay_tasks WHERE id = ?').get(vId.value);
    res.json({ data: publicDecayTask(row) });
  } catch (err) {
    log.error('POST /decay-tasks/:taskId/complete error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/decay-tasks/:taskId', (req, res) => {
  try {
    const vId = validateId(req.params.taskId, 'taskId');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const result = db.get().prepare('DELETE FROM housekeeping_decay_tasks WHERE id = ?').run(vId.value);
    if (result.changes === 0) return res.status(404).json({ error: 'Task not found.', code: 404 });
    res.json({ data: null });
  } catch (err) {
    log.error('DELETE /decay-tasks/:taskId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/supply-requests', (req, res) => {
  try {
    const vName = str(req.body.name, 'name', { max: MAX_TITLE });
    const vQuantity = str(req.body.quantity, 'quantity', { max: MAX_SHORT, required: false });
    const errors = collectErrors([vName, vQuantity]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const actorId = userId(req);
    const result = db.get().transaction(() => {
      const listId = defaultShoppingList(actorId);
      const item = db.get().prepare(`
        INSERT INTO shopping_items (list_id, name, quantity, category)
        VALUES (?, ?, ?, ?)
      `).run(listId, vName.value, vQuantity.value, defaultShoppingCategory());
      const request = db.get().prepare(`
        INSERT INTO housekeeping_supply_requests (name, quantity, shopping_item_id, created_by)
        VALUES (?, ?, ?, ?)
      `).run(vName.value, vQuantity.value, item.lastInsertRowid, actorId);
      return {
        requestId: request.lastInsertRowid,
        shoppingItemId: item.lastInsertRowid,
      };
    })();

    const row = db.get().prepare('SELECT * FROM housekeeping_supply_requests WHERE id = ?').get(result.requestId);
    res.status(201).json({ data: row, shopping_item_id: result.shoppingItemId });
  } catch (err) {
    log.error('POST /supply-requests error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/maintenance-log', (_req, res) => {
  try {
    const rows = db.get().prepare('SELECT * FROM housekeeping_maintenance_log ORDER BY created_at DESC, id DESC').all();
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /maintenance-log error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/maintenance-log', (req, res) => {
  try {
    const vDescription = str(req.body.description, 'description', { max: MAX_TEXT });
    const vPhoto = validatePhotoUrl(req.body.photo_url);
    const errors = collectErrors([vDescription, vPhoto]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const result = db.get().prepare(`
      INSERT INTO housekeeping_maintenance_log (description, photo_url, created_by)
      VALUES (?, ?, ?)
    `).run(vDescription.value, vPhoto.value, userId(req));
    const row = db.get().prepare('SELECT * FROM housekeeping_maintenance_log WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('POST /maintenance-log error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
