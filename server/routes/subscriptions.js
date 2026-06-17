import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
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
import { findLogoOptions } from '../services/subscription-logo.js';

const log = createLogger('Subscriptions');
const router = express.Router();
const URL_RE = /^https?:\/\/[^\s]+$/i;

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
           c.budget_subcategory_key,
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
  const subcategory = subscription.budget_subcategory_key || '';
  let entryId = preserveCurrent ? null : subscription.budget_entry_id;
  if (entryId) {
    const updated = database.prepare(`
      UPDATE budget_entries
      SET title = ?, amount = ?, category = 'subscriptions', subcategory = ?, date = ?
      WHERE id = ?
    `).run(budgetEntryTitle(subscription), -amount, subcategory, subscription.next_payment_date, entryId);
    if (!updated.changes) entryId = null;
  }
  if (!entryId) {
    entryId = database.prepare(`
      INSERT INTO budget_entries
        (title, amount, category, subcategory, date, is_recurring, created_by)
      VALUES (?, ?, 'subscriptions', ?, ?, 0, ?)
    `).run(
      budgetEntryTitle(subscription),
      -amount,
      subcategory,
      subscription.next_payment_date,
      subscription.created_by,
    ).lastInsertRowid;
    database.prepare('UPDATE budget_subscriptions SET budget_entry_id = ? WHERE id = ?').run(entryId, subscription.id);
  }
  return loadSubscription(subscription.id);
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
  try {
    const categories = db.get().prepare('SELECT * FROM subscription_categories ORDER BY sort_order, name COLLATE NOCASE').all();
    const paymentMethods = db.get().prepare('SELECT * FROM subscription_payment_methods ORDER BY sort_order, name COLLATE NOCASE').all();
    res.json({ data: { categories, payment_methods: paymentMethods, billing_cycles: BILLING_CYCLES } });
  } catch (err) {
    log.error('GET /meta error:', err);
    res.status(500).json({ error: 'Subscription metadata could not be loaded.', code: 500 });
  }
});

router.get('/settings', (_req, res) => {
  try {
    res.json({ data: settings() });
  } catch (err) {
    log.error('GET /settings error:', err);
    res.status(500).json({ error: 'Subscription settings could not be loaded.', code: 500 });
  }
});

router.put('/settings', (req, res) => {
  try {
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
  } catch (err) {
    log.error('PUT /settings error:', err);
    res.status(500).json({ error: 'Subscription settings could not be saved.', code: 500 });
  }
});

router.post('/categories', (req, res) => {
  const name = str(req.body.name, 'Name', { max: MAX_SHORT });
  const categoryColor = color(req.body.color || '#0F766E', 'Color');
  const errors = collectErrors([name, categoryColor]);
  if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
  try {
    const database = db.get();
    const category = database.transaction(() => {
      const order = database.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM subscription_categories').get().n;
      const result = database.prepare('INSERT INTO subscription_categories (name, color, sort_order) VALUES (?, ?, ?)')
        .run(name.value, categoryColor.value, order);
      const budgetKey = `subscription_category_${result.lastInsertRowid}`;
      database.prepare('UPDATE subscription_categories SET budget_subcategory_key = ? WHERE id = ?')
        .run(budgetKey, result.lastInsertRowid);
      database.prepare(`
        INSERT INTO budget_subcategories (key, category_key, name, sort_order)
        VALUES (?, 'subscriptions', ?, ?)
      `).run(budgetKey, name.value, order);
      return database.prepare('SELECT * FROM subscription_categories WHERE id = ?').get(result.lastInsertRowid);
    })();
    res.status(201).json({ data: category });
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
  try {
    const categories = Array.isArray(req.body.categories) ? req.body.categories.map(Number) : null;
    const methods = Array.isArray(req.body.payment_methods) ? req.body.payment_methods.map(Number) : null;
    if (!categories && !methods) return res.status(400).json({ error: 'An order list is required.', code: 400 });
    const updateCategories = db.get().prepare('UPDATE subscription_categories SET sort_order = ? WHERE id = ?');
    const updateBudgetSubcategories = db.get().prepare(`
      UPDATE budget_subcategories
      SET sort_order = ?
      WHERE key = (SELECT budget_subcategory_key FROM subscription_categories WHERE id = ?)
    `);
    const updateMethods = db.get().prepare('UPDATE subscription_payment_methods SET sort_order = ? WHERE id = ?');
    db.get().transaction(() => {
      categories?.forEach((id, index) => {
        updateCategories.run(index, id);
        updateBudgetSubcategories.run(index, id);
      });
      methods?.forEach((id, index) => updateMethods.run(index, id));
    })();
    res.json({ data: { updated: true } });
  } catch (err) {
    log.error('PUT /meta/order error:', err);
    res.status(500).json({ error: 'Subscription metadata order could not be saved.', code: 500 });
  }
});

function logoSearchLogError(err) {
  return {
    name: err?.name || 'Error',
    message: err?.message || String(err),
    stack: err?.stack,
  };
}

router.post('/logo-search', async (req, res) => {
  const diagnostics = [];
  let logoQuery = '';
  const started = Date.now();
  try {
    const query = str(req.body.query ?? req.body.website_url, 'Logo search query', { max: 2000 });
    if (query.error) {
      log.warn('Subscription logo search rejected invalid input', { error: query.error });
      return res.status(400).json({ error: query.error, code: 400 });
    }
    logoQuery = query.value;
    const options = await findLogoOptions(logoQuery, { diagnostics });
    if (!options.length) {
      log.warn('Subscription logo search returned no supported logos', {
        query: logoQuery,
        elapsed_ms: Date.now() - started,
        diagnostics,
      });
      return res.status(404).json({ error: 'No supported logo could be found.', code: 404 });
    }
    res.json({ data: { logo_data: options[0].logo_data, options } });
  } catch (err) {
    log.error('Subscription logo search failed', {
      query: logoQuery,
      elapsed_ms: Date.now() - started,
      error: logoSearchLogError(err),
      diagnostics,
    });
    res.status(400).json({ error: err.message || 'Logo could not be found.', code: 400 });
  }
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
             c.budget_subcategory_key,
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
  try {
    const id = Number(req.params.id);
    const current = loadSubscription(id);
    if (!current) return res.status(404).json({ error: 'Subscription not found.', code: 404 });
    const nextDate = addBillingCycle(current.next_payment_date, current.billing_cycle, current.cycle_interval);
    db.get().prepare('UPDATE budget_subscriptions SET next_payment_date = ? WHERE id = ?').run(nextDate, id);
    let row = loadSubscription(id);
    row = await syncBudgetExpense(row, { preserveCurrent: true });
    syncReminder(row);
    res.json({ data: { ...row, enabled: Boolean(row.enabled) } });
  } catch (err) {
    log.error('POST /:id/renew error:', err);
    res.status(500).json({ error: 'Subscription renewal could not be saved.', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
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
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Subscription could not be deleted.', code: 500 });
  }
});

router.use((err, _req, res, _next) => {
  log.error('Unhandled route error:', err);
  res.status(500).json({ error: 'Internal error.', code: 500 });
});

export default router;
