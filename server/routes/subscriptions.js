import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { requireAdmin } from '../auth.js';
import { color, collectErrors, date, num, oneOf, str, MAX_SHORT, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';
import {
  BILLING_CYCLES,
  CURRENCY_RE,
  addBillingCycle,
  convertAmount,
  monthlyEquivalent,
  parseDateKey,
  reminderDate,
} from '../services/subscriptions.js';
import { getRates } from '../services/subscription-rates.js';
import { findLogo } from '../services/subscription-logo.js';
import { sendAgent } from '../services/subscription-notifications.js';

const log = createLogger('Subscriptions');
const router = express.Router();
const URL_RE = /^https?:\/\/[^\s]+$/i;
const AGENT_TYPES = ['email', 'discord', 'telegram', 'pushover', 'gotify', 'serverchan', 'ntfy', 'webhook'];
const AGENT_REQUIRED_CONFIG = {
  email: ['recipient'],
  discord: ['url'],
  telegram: ['bot_token', 'chat_id'],
  pushover: ['app_token', 'user_key'],
  gotify: ['url', 'token'],
  serverchan: ['send_key'],
  ntfy: ['url', 'topic'],
  webhook: ['url'],
};

function actorId(req) {
  return req.authUserId || req.session.userId;
}

function settings() {
  return db.get().prepare('SELECT * FROM subscription_settings WHERE id = 1').get();
}

function syncReminder(subscription) {
  const database = db.get();
  database.prepare(`
    DELETE FROM reminders WHERE entity_type = 'subscription' AND entity_id = ?
  `).run(subscription.id);
  if (!subscription.enabled) return;
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('subscription', ?, ?, ?)
  `).run(
    subscription.id,
    reminderDate(subscription.next_payment_date, subscription.reminder_days),
    subscription.created_by,
  );
}

function loadSubscription(id) {
  return db.get().prepare(`
    SELECT s.*, c.name AS category_name, c.color AS category_color,
           p.name AS payment_method_name, u.display_name AS creator_name
    FROM budget_subscriptions s
    LEFT JOIN subscription_categories c ON c.id = s.category_id
    LEFT JOIN subscription_payment_methods p ON p.id = s.payment_method_id
    LEFT JOIN users u ON u.id = s.created_by
    WHERE s.id = ?
  `).get(id);
}

function budgetCurrency() {
  return db.get().prepare("SELECT value FROM sync_config WHERE key = 'currency'").get()?.value
    || settings().base_currency
    || 'EUR';
}

async function budgetExpenseAmount(subscription) {
  const currency = budgetCurrency();
  if (subscription.currency === currency) return Math.abs(Number(subscription.amount));
  const result = await getRates(currency, [subscription.currency]);
  return Math.abs(convertAmount(subscription.amount, subscription.currency, currency, result.rates) ?? Number(subscription.amount));
}

function budgetEntryTitle(subscription) {
  const suffix = subscription.currency === budgetCurrency() ? '' : ` (${subscription.currency})`;
  return `${subscription.name}${suffix}`;
}

async function syncBudgetExpense(subscription, { preserveCurrent = false } = {}) {
  const database = db.get();
  if (!subscription.enabled) {
    if (subscription.budget_entry_id) {
      database.prepare('DELETE FROM budget_entries WHERE id = ?').run(subscription.budget_entry_id);
      database.prepare('UPDATE budget_subscriptions SET budget_entry_id = NULL WHERE id = ?').run(subscription.id);
    }
    return loadSubscription(subscription.id);
  }

  const amount = await budgetExpenseAmount(subscription);
  let entryId = preserveCurrent ? null : subscription.budget_entry_id;
  if (entryId) {
    const updated = database.prepare(`
      UPDATE budget_entries
      SET title = ?, amount = ?, category = 'financial_other', subcategory = 'bank_fees', date = ?
      WHERE id = ?
    `).run(budgetEntryTitle(subscription), -amount, subscription.next_payment_date, entryId);
    if (!updated.changes) entryId = null;
  }
  if (!entryId) {
    entryId = database.prepare(`
      INSERT INTO budget_entries
        (title, amount, category, subcategory, date, is_recurring, created_by)
      VALUES (?, ?, 'financial_other', 'bank_fees', ?, 0, ?)
    `).run(
      budgetEntryTitle(subscription),
      -amount,
      subscription.next_payment_date,
      subscription.created_by,
    ).lastInsertRowid;
    database.prepare('UPDATE budget_subscriptions SET budget_entry_id = ? WHERE id = ?').run(entryId, subscription.id);
  }
  return loadSubscription(subscription.id);
}

function publicAgent(row) {
  const config = JSON.parse(row.config_json);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: Boolean(row.enabled),
    configured_fields: Object.keys(config),
    last_test_at: row.last_test_at,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

function validateAgent(body) {
  const name = str(body.name, 'Name', { max: MAX_SHORT });
  const type = oneOf(body.type, AGENT_TYPES, 'Type');
  const errors = collectErrors([name, type]);
  const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
  for (const field of AGENT_REQUIRED_CONFIG[body.type] || []) {
    if (!String(config[field] || '').trim()) errors.push(`${field} is required.`);
  }
  const serialized = JSON.stringify(config);
  if (serialized.length > 10000) errors.push('Notification configuration is too large.');
  return { errors, name: name.value, type: type.value, config };
}

function validatePayload(body, { partial = false } = {}) {
  const checks = [];
  const required = (key) => !partial || body[key] !== undefined;
  if (required('name')) checks.push(str(body.name, 'Name', { max: MAX_TITLE }));
  if (body.description !== undefined) checks.push(str(body.description, 'Description', { max: MAX_TEXT, required: false }));
  if (required('amount')) checks.push(num(body.amount, 'Amount', { required: true }));
  if (required('billing_cycle')) checks.push(oneOf(body.billing_cycle, BILLING_CYCLES, 'Billing cycle'));
  if (required('next_payment_date')) checks.push(date(body.next_payment_date, 'Next payment date', true));
  if (body.brand_color !== undefined) checks.push(color(body.brand_color, 'Brand color'));
  if (body.notes !== undefined) checks.push(str(body.notes, 'Notes', { max: MAX_TEXT, required: false }));
  const errors = collectErrors(checks);

  const currency = body.currency === undefined && partial ? null : String(body.currency || '').toUpperCase();
  if (currency !== null && !CURRENCY_RE.test(currency)) errors.push('Currency must be a three-letter ISO code.');
  const cycleInterval = body.cycle_interval === undefined && partial ? null : Number(body.cycle_interval ?? 1);
  if (cycleInterval !== null && (!Number.isInteger(cycleInterval) || cycleInterval < 1 || cycleInterval > 365)) {
    errors.push('Cycle interval must be between 1 and 365.');
  }
  const reminderDays = body.reminder_days === undefined && partial ? null : Number(body.reminder_days ?? 3);
  if (reminderDays !== null && (!Number.isInteger(reminderDays) || reminderDays < 0 || reminderDays > 365)) {
    errors.push('Reminder days must be between 0 and 365.');
  }
  if (body.amount !== undefined && Number(body.amount) < 0) errors.push('Amount must not be negative.');
  if (body.next_payment_date !== undefined) {
    try { parseDateKey(body.next_payment_date); } catch (err) { errors.push(err.message); }
  }
  if (body.website_url && !URL_RE.test(body.website_url)) errors.push('Website URL must use HTTP or HTTPS.');
  if (body.logo_data && (!String(body.logo_data).startsWith('data:image/') || String(body.logo_data).length > 700000)) {
    errors.push('Logo must be an image data URL smaller than 500 KB.');
  }
  for (const key of ['category_id', 'payment_method_id']) {
    if (body[key] !== undefined && body[key] !== null && (!Number.isInteger(Number(body[key])) || Number(body[key]) < 1)) {
      errors.push(`${key} is invalid.`);
    }
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') errors.push('Enabled must be a boolean.');
  return { errors, currency, cycleInterval, reminderDays };
}

async function subscriptionsWithConversions(rows, baseCurrency, refresh = false) {
  const ratesResult = await getRates(baseCurrency, rows.map((row) => row.currency), { refresh });
  return {
    rows: rows.map((row) => {
      const nativeMonthly = monthlyEquivalent(row.amount, row.billing_cycle, row.cycle_interval);
      const baseMonthly = convertAmount(nativeMonthly, row.currency, baseCurrency, ratesResult.rates);
      return {
        ...row,
        enabled: Boolean(row.enabled),
        monthly_native: Number(nativeMonthly.toFixed(2)),
        monthly_base: baseMonthly === null ? null : Number(baseMonthly.toFixed(2)),
        base_currency: baseCurrency,
      };
    }),
    rates: {
      source: ratesResult.source,
      fetched_at: ratesResult.fetchedAt,
    },
  };
}

router.get('/meta', (_req, res) => {
  const categories = db.get().prepare('SELECT * FROM subscription_categories ORDER BY sort_order, name COLLATE NOCASE').all();
  const paymentMethods = db.get().prepare('SELECT * FROM subscription_payment_methods ORDER BY sort_order, name COLLATE NOCASE').all();
  res.json({ data: { categories, payment_methods: paymentMethods, billing_cycles: BILLING_CYCLES } });
});

router.get('/settings', (_req, res) => {
  res.json({ data: settings() });
});

router.put('/settings', (req, res) => {
  const monthlyBudget = Number(req.body.monthly_budget);
  const baseCurrency = String(req.body.base_currency || '').toUpperCase();
  const errors = [];
  if (!Number.isFinite(monthlyBudget) || monthlyBudget < 0) errors.push('Monthly budget must not be negative.');
  if (!CURRENCY_RE.test(baseCurrency)) errors.push('Base currency must be a three-letter ISO code.');
  if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
  db.get().prepare(`
    UPDATE subscription_settings SET monthly_budget = ?, base_currency = ? WHERE id = 1
  `).run(monthlyBudget, baseCurrency);
  res.json({ data: settings() });
});

router.post('/categories', (req, res) => {
  const name = str(req.body.name, 'Name', { max: MAX_SHORT });
  const categoryColor = color(req.body.color || '#0F766E', 'Color');
  const errors = collectErrors([name, categoryColor]);
  if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
  try {
    const order = db.get().prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM subscription_categories').get().n;
    const result = db.get().prepare('INSERT INTO subscription_categories (name, color, sort_order) VALUES (?, ?, ?)')
      .run(name.value, categoryColor.value, order);
    res.status(201).json({ data: db.get().prepare('SELECT * FROM subscription_categories WHERE id = ?').get(result.lastInsertRowid) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Category already exists.', code: 409 });
    throw err;
  }
});

router.post('/payment-methods', (req, res) => {
  const name = str(req.body.name, 'Name', { max: MAX_SHORT });
  if (name.error) return res.status(400).json({ error: name.error, code: 400 });
  try {
    const order = db.get().prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM subscription_payment_methods').get().n;
    const result = db.get().prepare('INSERT INTO subscription_payment_methods (name, sort_order) VALUES (?, ?)')
      .run(name.value, order);
    res.status(201).json({ data: db.get().prepare('SELECT * FROM subscription_payment_methods WHERE id = ?').get(result.lastInsertRowid) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Payment method already exists.', code: 409 });
    throw err;
  }
});

router.put('/meta/order', (req, res) => {
  const categories = Array.isArray(req.body.categories) ? req.body.categories.map(Number) : null;
  const methods = Array.isArray(req.body.payment_methods) ? req.body.payment_methods.map(Number) : null;
  if (!categories && !methods) return res.status(400).json({ error: 'An order list is required.', code: 400 });
  const updateCategories = db.get().prepare('UPDATE subscription_categories SET sort_order = ? WHERE id = ?');
  const updateMethods = db.get().prepare('UPDATE subscription_payment_methods SET sort_order = ? WHERE id = ?');
  db.get().transaction(() => {
    categories?.forEach((id, index) => updateCategories.run(index, id));
    methods?.forEach((id, index) => updateMethods.run(index, id));
  })();
  res.json({ data: { updated: true } });
});

router.post('/logo-search', async (req, res) => {
  try {
    const website = str(req.body.website_url, 'Website', { max: 2000 });
    if (website.error) return res.status(400).json({ error: website.error, code: 400 });
    const logoData = await findLogo(website.value);
    res.json({ data: { logo_data: logoData } });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Logo could not be found.', code: 400 });
  }
});

router.get('/notification-agents', requireAdmin, (_req, res) => {
  const agents = db.get().prepare(`
    SELECT * FROM subscription_notification_agents ORDER BY created_at, id
  `).all().map(publicAgent);
  res.json({ data: agents });
});

router.post('/notification-agents', requireAdmin, (req, res) => {
  const validated = validateAgent(req.body);
  if (validated.errors.length) return res.status(400).json({ error: validated.errors.join(' '), code: 400 });
  const result = db.get().prepare(`
    INSERT INTO subscription_notification_agents (name, type, config_json, enabled, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    validated.name,
    validated.type,
    JSON.stringify(validated.config),
    req.body.enabled === false ? 0 : 1,
    actorId(req),
  );
  const row = db.get().prepare('SELECT * FROM subscription_notification_agents WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ data: publicAgent(row) });
});

router.put('/notification-agents/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const current = db.get().prepare('SELECT * FROM subscription_notification_agents WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'Notification agent not found.', code: 404 });
  if (req.body.enabled !== undefined && typeof req.body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'Enabled must be a boolean.', code: 400 });
  }
  db.get().prepare('UPDATE subscription_notification_agents SET enabled = ? WHERE id = ?')
    .run(req.body.enabled === undefined ? current.enabled : (req.body.enabled ? 1 : 0), id);
  res.json({ data: publicAgent(db.get().prepare('SELECT * FROM subscription_notification_agents WHERE id = ?').get(id)) });
});

router.post('/notification-agents/:id/test', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const agent = db.get().prepare('SELECT * FROM subscription_notification_agents WHERE id = ?').get(id);
  if (!agent) return res.status(404).json({ error: 'Notification agent not found.', code: 404 });
  const sample = db.get().prepare('SELECT * FROM budget_subscriptions ORDER BY created_at DESC LIMIT 1').get() || {
    id: 0,
    name: 'Example subscription',
    amount: 9.99,
    currency: settings().base_currency,
    next_payment_date: new Date().toISOString().slice(0, 10),
  };
  try {
    await sendAgent(agent, sample);
    db.get().prepare(`
      UPDATE subscription_notification_agents SET last_test_at = ?, last_error = NULL WHERE id = ?
    `).run(new Date().toISOString(), id);
    res.json({ data: { ok: true } });
  } catch (err) {
    db.get().prepare('UPDATE subscription_notification_agents SET last_error = ? WHERE id = ?')
      .run(String(err.message).slice(0, 1000), id);
    res.status(502).json({ error: err.message || 'Notification test failed.', code: 502 });
  }
});

router.delete('/notification-agents/:id', requireAdmin, (req, res) => {
  const result = db.get().prepare('DELETE FROM subscription_notification_agents WHERE id = ?').run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Notification agent not found.', code: 404 });
  res.status(204).end();
});

router.get('/', async (req, res) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.enabled === 'true' || req.query.enabled === 'false') {
      clauses.push('s.enabled = ?');
      params.push(req.query.enabled === 'true' ? 1 : 0);
    }
    if (req.query.category_id) {
      clauses.push('s.category_id = ?');
      params.push(Number(req.query.category_id));
    }
    if (req.query.payment_method_id) {
      clauses.push('s.payment_method_id = ?');
      params.push(Number(req.query.payment_method_id));
    }
    if (req.query.q) {
      clauses.push('(s.name LIKE ? OR s.description LIKE ? OR s.notes LIKE ?)');
      const query = `%${String(req.query.q).slice(0, 100)}%`;
      params.push(query, query, query);
    }
    const rows = db.get().prepare(`
      SELECT s.*, c.name AS category_name, c.color AS category_color,
             p.name AS payment_method_name, u.display_name AS creator_name
      FROM budget_subscriptions s
      LEFT JOIN subscription_categories c ON c.id = s.category_id
      LEFT JOIN subscription_payment_methods p ON p.id = s.payment_method_id
      LEFT JOIN users u ON u.id = s.created_by
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY s.next_payment_date, s.name COLLATE NOCASE
    `).all(...params);
    const configured = settings();
    const converted = await subscriptionsWithConversions(rows, configured.base_currency, req.query.refresh_rates === 'true');
    const enabledRows = converted.rows.filter((row) => row.enabled);
    const monthlyTotal = enabledRows.reduce((sum, row) => sum + (row.monthly_base || 0), 0);
    const byCategory = new Map();
    const byPaymentMethod = new Map();
    for (const row of enabledRows) {
      const category = row.category_name || 'Uncategorized';
      const method = row.payment_method_name || 'Unspecified';
      byCategory.set(category, (byCategory.get(category) || 0) + (row.monthly_base || 0));
      byPaymentMethod.set(method, (byPaymentMethod.get(method) || 0) + (row.monthly_base || 0));
    }
    res.json({
      data: {
        subscriptions: converted.rows,
        summary: {
          active_count: enabledRows.length,
          disabled_count: converted.rows.length - enabledRows.length,
          monthly_total: Number(monthlyTotal.toFixed(2)),
          monthly_budget: configured.monthly_budget,
          remaining_budget: Number((configured.monthly_budget - monthlyTotal).toFixed(2)),
          base_currency: configured.base_currency,
          by_category: [...byCategory].map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) })),
          by_payment_method: [...byPaymentMethod].map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) })),
        },
        rates: converted.rates,
      },
    });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Subscriptions could not be loaded.', code: 500 });
  }
});

router.post('/', async (req, res) => {
  try {
    const validated = validatePayload(req.body);
    if (validated.errors.length) return res.status(400).json({ error: validated.errors.join(' '), code: 400 });
    const result = db.get().prepare(`
      INSERT INTO budget_subscriptions
        (name, description, amount, currency, billing_cycle, cycle_interval, next_payment_date,
         category_id, payment_method_id, reminder_days, enabled, website_url, logo_data,
         brand_color, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.body.name.trim(), req.body.description?.trim() || null, Number(req.body.amount), validated.currency,
      req.body.billing_cycle, validated.cycleInterval, req.body.next_payment_date,
      req.body.category_id || null, req.body.payment_method_id || null, validated.reminderDays,
      req.body.enabled === false ? 0 : 1, req.body.website_url?.trim() || null, req.body.logo_data || null,
      req.body.brand_color || null, req.body.notes?.trim() || null, actorId(req),
    );
    let row = loadSubscription(result.lastInsertRowid);
    row = await syncBudgetExpense(row);
    syncReminder(row);
    res.status(201).json({ data: { ...row, enabled: Boolean(row.enabled) } });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Subscription could not be created.', code: 500 });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const current = loadSubscription(id);
    if (!current) return res.status(404).json({ error: 'Subscription not found.', code: 404 });
    const validated = validatePayload(req.body, { partial: true });
    if (validated.errors.length) return res.status(400).json({ error: validated.errors.join(' '), code: 400 });
    const value = (key, fallback) => req.body[key] === undefined ? fallback : req.body[key];
    db.get().prepare(`
      UPDATE budget_subscriptions SET
        name = ?, description = ?, amount = ?, currency = ?, billing_cycle = ?, cycle_interval = ?,
        next_payment_date = ?, category_id = ?, payment_method_id = ?, reminder_days = ?, enabled = ?,
        website_url = ?, logo_data = ?, brand_color = ?, notes = ?
      WHERE id = ?
    `).run(
      value('name', current.name)?.trim(), value('description', current.description)?.trim() || null,
      Number(value('amount', current.amount)), validated.currency || current.currency,
      value('billing_cycle', current.billing_cycle), validated.cycleInterval || current.cycle_interval,
      value('next_payment_date', current.next_payment_date), value('category_id', current.category_id) || null,
      value('payment_method_id', current.payment_method_id) || null,
      validated.reminderDays ?? current.reminder_days, value('enabled', Boolean(current.enabled)) ? 1 : 0,
      value('website_url', current.website_url)?.trim() || null, value('logo_data', current.logo_data) || null,
      value('brand_color', current.brand_color) || null, value('notes', current.notes)?.trim() || null, id,
    );
    let row = loadSubscription(id);
    row = await syncBudgetExpense(row);
    syncReminder(row);
    res.json({ data: { ...row, enabled: Boolean(row.enabled) } });
  } catch (err) {
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Subscription could not be updated.', code: 500 });
  }
});

router.post('/:id/renew', async (req, res) => {
  const id = Number(req.params.id);
  const current = loadSubscription(id);
  if (!current) return res.status(404).json({ error: 'Subscription not found.', code: 404 });
  const nextDate = addBillingCycle(current.next_payment_date, current.billing_cycle, current.cycle_interval);
  db.get().prepare('UPDATE budget_subscriptions SET next_payment_date = ? WHERE id = ?').run(nextDate, id);
  let row = loadSubscription(id);
  row = await syncBudgetExpense(row, { preserveCurrent: true });
  syncReminder(row);
  res.json({ data: { ...row, enabled: Boolean(row.enabled) } });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!loadSubscription(id)) return res.status(404).json({ error: 'Subscription not found.', code: 404 });
  db.get().transaction(() => {
    const subscription = loadSubscription(id);
    db.get().prepare("DELETE FROM reminders WHERE entity_type = 'subscription' AND entity_id = ?").run(id);
    db.get().prepare('DELETE FROM budget_subscriptions WHERE id = ?').run(id);
    if (subscription?.budget_entry_id) {
      db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(subscription.budget_entry_id);
    }
  })();
  res.status(204).end();
});

router.use((err, _req, res, _next) => {
  log.error('Unhandled route error:', err);
  res.status(500).json({ error: 'Internal error.', code: 500 });
});

export default router;
