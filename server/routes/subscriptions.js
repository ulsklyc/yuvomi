import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { color, collectErrors, date, num, oneOf, str, MAX_SHORT, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';
import {
  BILLING_CYCLES,
  CURRENCY_RE,
  END_TYPES,
  addBillingCycle,
  convertAmount,
  monthlyEquivalent,
  occurrencesRemaining,
  parseDateKey,
  reminderDate,
  resolveRenewal,
} from '../services/subscriptions.js';
import { getRates } from '../services/subscription-rates.js';
import { refuseWhileRestoring } from '../middleware/restore-gate.js';
import { findLogoOptions } from '../services/subscription-logo.js';
import { normalizeObjectVisibility, budgetVisibilityWhere, canEditEntry, resolveBudgetMode } from '../services/budget-visibility.js';
import { dataUrlContentMatches } from '../utils/file-signature.js';

const log = createLogger('Subscriptions');
const router = express.Router();
const URL_RE = /^https?:\/\/[^\s]+$/i;

function actorId(req) {
  return req.authUserId || req.session.userId;
}

// Persönlich/geteilt (#476/#505): Abonnements folgen dem Haushalts-Budget-Modus.
function budgetMode() {
  return resolveBudgetMode(db.get());
}

/** Schreib-Berechtigung im personal-Modus (kein Admin-Bypass); shared-Modus offen. */
function mayEditSub(req, row) {
  if (budgetMode() !== 'personal') return true;
  return canEditEntry(row, { id: actorId(req) });
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
           c.label_key AS category_label_key, c.budget_subcategory_key,
           p.name AS payment_method_name, p.label_key AS payment_method_label_key,
           u.display_name AS creator_name
    FROM budget_subscriptions s
    LEFT JOIN subscription_categories c ON c.id = s.category_id
    LEFT JOIN subscription_payment_methods p ON p.id = s.payment_method_id
    LEFT JOIN users u ON u.id = s.created_by
    WHERE s.id = ?
  `).get(id);
}

function subscriptionStatus(row) {
  if (row.completed_at) return 'completed';
  return row.enabled ? 'active' : 'paused';
}

// Response-Form: enabled als Boolean + abgeleiteter Status + verbleibende Zahlungen.
function decorate(row) {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    status: subscriptionStatus(row),
    occurrences_remaining: occurrencesRemaining(row),
  };
}

// Prüft die Ende-Bedingung gegen die zusammengeführten Effektivwerte (#594).
function endConfigErrors({ end_type, end_date, occurrence_count, next_payment_date, occurrences_done }) {
  const errors = [];
  if (end_type === 'on_date') {
    if (!end_date) { errors.push('An end date is required.'); return errors; }
    try {
      if (parseDateKey(end_date).getTime() < parseDateKey(next_payment_date).getTime()) {
        errors.push('The end date must not be before the next payment date.');
      }
    } catch (err) { errors.push(err.message); }
  } else if (end_type === 'after_count') {
    const count = Number(occurrence_count);
    if (!Number.isInteger(count) || count < 1 || count > 1200) {
      errors.push('Occurrence count must be between 1 and 1200.');
    } else if (count <= Number(occurrences_done || 0)) {
      errors.push('Occurrence count must be greater than the number of payments already made.');
    }
  }
  return errors;
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
    // Eigentümer + Sichtbarkeit mitziehen (#476/#505): ohne das bliebe der
    // verknüpfte Ausgaben-Eintrag beim Umschalten des Abos (shared↔private) auf
    // seinem alten Wert und entkoppelte sich vom Abo (privates Abo → geteilter
    // Eintrag im Haushalts-Topf). Symmetrisch zur INSERT-Branch unten.
    const updated = database.prepare(`
      UPDATE budget_entries
      SET title = ?, amount = ?, category = 'subscriptions', subcategory = ?, date = ?,
          owner_id = ?, visibility = ?
      WHERE id = ?
    `).run(
      budgetEntryTitle(subscription), -amount, subcategory, subscription.next_payment_date,
      subscription.owner_id ?? subscription.created_by, subscription.visibility || 'shared', entryId,
    );
    if (!updated.changes) entryId = null;
  }
  if (!entryId) {
    // Verknüpfter Ausgaben-Eintrag erbt Eigentümer + Sichtbarkeit des Abos (#476/#505).
    entryId = database.prepare(`
      INSERT INTO budget_entries
        (title, amount, category, subcategory, date, is_recurring, created_by, owner_id, visibility)
      VALUES (?, ?, 'subscriptions', ?, ?, 0, ?, ?, ?)
    `).run(
      budgetEntryTitle(subscription),
      -amount,
      subcategory,
      subscription.next_payment_date,
      subscription.created_by,
      subscription.owner_id ?? subscription.created_by,
      subscription.visibility || 'shared',
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
  // Konto/Benutzername, unter dem das Abo laeuft (#1004). KEIN Passwortfeld:
  // die Spalte ist unverschluesselt und wird durchsucht, weil ein Benutzername
  // ohne sein Passwort keinen Schutz braucht. Hier liegt sie in einer Zeile,
  // die owner_id und visibility bereits traegt - sie folgt beiden ohne Zutun.
  if (body.account_username !== undefined && body.account_username !== null
      && String(body.account_username).length > 200) {
    errors.push('Account name must be 200 characters or fewer.');
  }
  if (body.logo_data && (!String(body.logo_data).startsWith('data:image/') || String(body.logo_data).length > 700000)) {
    errors.push('Logo must be an image data URL smaller than 500 KB.');
  } else if (body.logo_data && /;base64,/i.test(String(body.logo_data))
    && !dataUrlContentMatches(body.logo_data)) {
    // Der Typ steht im Praefix und kommt aus dem Browser des Absenders; hier
    // wird geprueft, ob der Inhalt ihn traegt (#937). Nicht-base64-Bilder haben
    // keinen Kopf zum Vergleichen und bleiben bei der bisherigen Pruefung.
    //
    // Case-insensitiv, weil ein data-URL-Leser `;BASE64,` genauso dekodiert:
    // ein exakter Substring-Test haette sich mit einer Grossschreibung umgehen
    // lassen, und zwar genau von dem, der etwas zu verbergen hat.
    errors.push('Logo content does not match its image type.');
  }
  for (const key of ['category_id', 'payment_method_id']) {
    if (body[key] !== undefined && body[key] !== null && (!Number.isInteger(Number(body[key])) || Number(body[key]) < 1)) {
      errors.push(`${key} is invalid.`);
    }
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') errors.push('Enabled must be a boolean.');
  if (body.end_type !== undefined && !END_TYPES.includes(String(body.end_type))) errors.push('End type is invalid.');
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
        status: subscriptionStatus(row),
        occurrences_remaining: occurrencesRemaining(row),
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
    const categories = db.get().prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM budget_subscriptions s WHERE s.category_id = c.id) AS usage_count
      FROM subscription_categories c
      ORDER BY c.sort_order, c.name COLLATE NOCASE
    `).all();
    const paymentMethods = db.get().prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM budget_subscriptions s WHERE s.payment_method_id = p.id) AS usage_count
      FROM subscription_payment_methods p
      ORDER BY p.sort_order, p.name COLLATE NOCASE
    `).all();
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

router.put('/categories/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.get().prepare('SELECT * FROM subscription_categories WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Category not found.', code: 404 });
    const name = str(req.body.name, 'Name', { max: MAX_SHORT });
    const categoryColor = color(req.body.color ?? existing.color, 'Color');
    const errors = collectErrors([name, categoryColor]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const database = db.get();
    database.transaction(() => {
      // UMBENENNEN macht eine Vorgabe zur eigenen Zeile: `label_key` faellt
      // weg, damit der eingegebene Name gilt statt weiterhin uebersetzt zu
      // werden. Dasselbe tun tasks.js, contacts.js und inventory/categories.js.
      //
      // NUR UMBENENNEN, UND DAS IST DER PUNKT. Der Verwalten-Dialog schickt
      // Name und Farbe zusammen, auch wenn nur die Farbe angefasst wurde -
      // ein `label_key = NULL` bei JEDEM Speichern haette die sechs
      // Seed-Kategorien beim ersten Farbwechsel stillschweigend auf die
      // Sprache dieses Klienten festgenagelt. Genau der Verlust, den
      // Migration 143 beim Inventar behoben hat und den der Kommentar in
      // routes/contacts.js beschreibt. Der Vergleich ist der Kanon-Name, den
      // der Klient unveraendert zurueckschickt (data-original-name).
      const categoryRenamed = name.value !== existing.name;
      database.prepare(`UPDATE subscription_categories
                        SET name = ?, color = ?${categoryRenamed ? ', label_key = NULL' : ''}
                        WHERE id = ?`)
        .run(name.value, categoryColor.value, id);
      // Die verknüpfte Budget-Subkategorie führt denselben Namen (POST-Invariante).
      if (existing.budget_subcategory_key) {
        database.prepare('UPDATE budget_subcategories SET name = ? WHERE key = ?')
          .run(name.value, existing.budget_subcategory_key);
      }
    })();
    res.json({ data: database.prepare('SELECT * FROM subscription_categories WHERE id = ?').get(id) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Category already exists.', code: 409 });
    log.error('PUT /categories/:id error:', err);
    res.status(500).json({ error: 'Subscription category could not be saved.', code: 500 });
  }
});

router.delete('/categories/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.get().prepare('SELECT * FROM subscription_categories WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Category not found.', code: 404 });
    const database = db.get();
    const affected = database.transaction(() => {
      const count = database.prepare('SELECT COUNT(*) AS n FROM budget_subscriptions WHERE category_id = ?').get(id).n;
      if (existing.budget_subcategory_key) {
        // Verknüpfte Ausgaben-Einträge lösen ihre - gleich mitentfernte - Subkategorie,
        // statt auf einen toten Schlüssel zu zeigen.
        database.prepare("UPDATE budget_entries SET subcategory = '' WHERE category = 'subscriptions' AND subcategory = ?")
          .run(existing.budget_subcategory_key);
        database.prepare('DELETE FROM budget_subcategories WHERE key = ?').run(existing.budget_subcategory_key);
      }
      // FK ON DELETE SET NULL setzt category_id der betroffenen Abos auf NULL.
      database.prepare('DELETE FROM subscription_categories WHERE id = ?').run(id);
      return count;
    })();
    res.json({ data: { deleted: true, affected } });
  } catch (err) {
    log.error('DELETE /categories/:id error:', err);
    res.status(500).json({ error: 'Subscription category could not be deleted.', code: 500 });
  }
});

router.put('/payment-methods/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.get().prepare('SELECT * FROM subscription_payment_methods WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Payment method not found.', code: 404 });
    const name = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (name.error) return res.status(400).json({ error: name.error, code: 400 });
    // Wie bei den Kategorien: ein eigener Name schlaegt den uebersetzten - aber
    // erst, wenn er WIRKLICH ein anderer ist. Ein unveraendert
    // zurueckgeschickter Name ist keine Umbenennung.
    const renamed = name.value !== existing.name;
    db.get().prepare(`UPDATE subscription_payment_methods
                      SET name = ?${renamed ? ', label_key = NULL' : ''}
                      WHERE id = ?`).run(name.value, id);
    res.json({ data: db.get().prepare('SELECT * FROM subscription_payment_methods WHERE id = ?').get(id) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Payment method already exists.', code: 409 });
    log.error('PUT /payment-methods/:id error:', err);
    res.status(500).json({ error: 'Payment method could not be saved.', code: 500 });
  }
});

router.delete('/payment-methods/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.get().prepare('SELECT * FROM subscription_payment_methods WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Payment method not found.', code: 404 });
    const affected = db.get().prepare('SELECT COUNT(*) AS n FROM budget_subscriptions WHERE payment_method_id = ?').get(id).n;
    // FK ON DELETE SET NULL entkoppelt betroffene Abos von der Zahlungsart.
    db.get().prepare('DELETE FROM subscription_payment_methods WHERE id = ?').run(id);
    res.json({ data: { deleted: true, affected } });
  } catch (err) {
    log.error('DELETE /payment-methods/:id error:', err);
    res.status(500).json({ error: 'Payment method could not be deleted.', code: 500 });
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

// Ein veralteter Wechselkurs wird bei Fixer geholt und danach im Cache
// gespeichert: waehrend eines Restores 503, sonst festgehalten wie eine
// schreibende Anfrage (#1551).
router.get('/', refuseWhileRestoring, async (req, res) => {
  try {
    const clauses = [];
    const params = [];
    // Status-Filter (#594): active/paused/completed statt nur enabled-Boolean.
    // enabled bleibt als Rückfall-Filter für ältere Aufrufer erhalten.
    if (req.query.status === 'active') clauses.push('s.enabled = 1 AND s.completed_at IS NULL');
    else if (req.query.status === 'paused') clauses.push('s.enabled = 0 AND s.completed_at IS NULL');
    else if (req.query.status === 'completed') clauses.push('s.completed_at IS NOT NULL');
    else if (req.query.enabled === 'true' || req.query.enabled === 'false') {
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
    // Sichtbarkeit (#476/#505): im personal-Modus nur geteilte + eigene Abos.
    if (budgetMode() === 'personal') {
      clauses.push(budgetVisibilityWhere('s', '?', { mode: 'personal' }));
      params.push(actorId(req));
    }
    const rows = db.get().prepare(`
      SELECT s.*, c.name AS category_name, c.color AS category_color,
             c.label_key AS category_label_key, c.budget_subcategory_key,
             p.name AS payment_method_name, p.label_key AS payment_method_label_key,
             u.display_name AS creator_name
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
    const completedCount = converted.rows.filter((row) => row.status === 'completed').length;
    const monthlyTotal = enabledRows.reduce((sum, row) => sum + (row.monthly_base || 0), 0);
    // GRUPPIERT WIRD NACH DER ZEILE, NICHT NACH IHREM ANZEIGETEXT. Hier stand
    // `row.category_name || 'Uncategorized'`, und damit erfand die Antwort zwei
    // englische Woerter, die kein Klient uebersetzen konnte - eine Sammelposition
    // hiess auch in einer spanischen Oberflaeche "Unspecified" (#950). Sie traegt
    // jetzt `id: null` und ueberlaesst das Wort dem Leser; eine Vorgabezeile
    // reicht ihren `label_key` durch, eine eigene ihren Namen.
    const byCategory = new Map();
    const byPaymentMethod = new Map();
    const bucket = (map, id, name, labelKey, amount) => {
      const entry = map.get(id) ?? { id, name, label_key: labelKey, amount: 0 };
      entry.amount += amount;
      map.set(id, entry);
    };
    for (const row of enabledRows) {
      const amount = row.monthly_base || 0;
      bucket(byCategory, row.category_id ?? null, row.category_name ?? null, row.category_label_key ?? null, amount);
      bucket(byPaymentMethod, row.payment_method_id ?? null, row.payment_method_name ?? null, row.payment_method_label_key ?? null, amount);
    }
    const breakdown = (map) => [...map.values()].map((e) => ({ ...e, amount: Number(e.amount.toFixed(2)) }));
    res.json({
      data: {
        subscriptions: converted.rows,
        summary: {
          active_count: enabledRows.length,
          disabled_count: converted.rows.length - enabledRows.length,
          completed_count: completedCount,
          monthly_total: Number(monthlyTotal.toFixed(2)),
          monthly_budget: configured.monthly_budget,
          remaining_budget: Number((configured.monthly_budget - monthlyTotal).toFixed(2)),
          base_currency: configured.base_currency,
          by_category: breakdown(byCategory),
          by_payment_method: breakdown(byPaymentMethod),
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
    const endType = req.body.end_type || 'never';
    const endDate = endType === 'on_date' ? req.body.end_date : null;
    const occurrenceCount = endType === 'after_count' ? Number(req.body.occurrence_count) : null;
    const endErrors = endConfigErrors({
      end_type: endType, end_date: endDate, occurrence_count: occurrenceCount,
      next_payment_date: req.body.next_payment_date, occurrences_done: 0,
    });
    if (endErrors.length) return res.status(400).json({ error: endErrors.join(' '), code: 400 });
    const me = actorId(req);
    const visibility = normalizeObjectVisibility(
      req.body.visibility,
      budgetMode() === 'personal' ? 'private' : 'shared'
    );
    const result = db.get().prepare(`
      INSERT INTO budget_subscriptions
        (name, description, amount, currency, billing_cycle, cycle_interval, next_payment_date,
         category_id, payment_method_id, reminder_days, enabled, website_url, logo_data,
         brand_color, notes, account_username, created_by, owner_id, visibility,
         end_type, end_date, occurrence_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.body.name.trim(), req.body.description?.trim() || null, Number(req.body.amount), validated.currency,
      req.body.billing_cycle, validated.cycleInterval, req.body.next_payment_date,
      req.body.category_id || null, req.body.payment_method_id || null, validated.reminderDays,
      req.body.enabled === false ? 0 : 1, req.body.website_url?.trim() || null, req.body.logo_data || null,
      req.body.brand_color || null, req.body.notes?.trim() || null,
      req.body.account_username?.trim() || null, me, me, visibility,
      endType, endDate, occurrenceCount,
    );
    let row = loadSubscription(result.lastInsertRowid);
    row = await syncBudgetExpense(row);
    syncReminder(row);
    res.status(201).json({ data: decorate(row) });
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
    if (!mayEditSub(req, current)) return res.status(403).json({ error: 'You cannot modify this subscription.', code: 403 });
    const validated = validatePayload(req.body, { partial: true });
    if (validated.errors.length) return res.status(400).json({ error: validated.errors.join(' '), code: 400 });
    const value = (key, fallback) => req.body[key] === undefined ? fallback : req.body[key];
    // Sichtbarkeit umschaltbar; owner_id bleibt fix (#476/#505).
    const nextVisibility = req.body.visibility !== undefined
      ? normalizeObjectVisibility(req.body.visibility)
      : current.visibility;
    // Ende-Bedingung aus zusammengeführten Werten (#594): unbenutzte Felder werden
    // konsequent auf null gesetzt, damit ein Moduswechsel keine Altwerte mitschleppt.
    const nextPaymentDate = value('next_payment_date', current.next_payment_date);
    const endType = req.body.end_type !== undefined ? req.body.end_type : current.end_type;
    const endDate = endType === 'on_date'
      ? (req.body.end_date !== undefined ? req.body.end_date : current.end_date)
      : null;
    const occurrenceCount = endType === 'after_count'
      ? (req.body.occurrence_count !== undefined ? Number(req.body.occurrence_count) : current.occurrence_count)
      : null;
    const endErrors = endConfigErrors({
      end_type: endType, end_date: endDate, occurrence_count: occurrenceCount,
      next_payment_date: nextPaymentDate, occurrences_done: current.occurrences_done,
    });
    if (endErrors.length) return res.status(400).json({ error: endErrors.join(' '), code: 400 });
    // Reaktivieren (enabled -> true) hebt einen Abschluss auf.
    const nextEnabled = value('enabled', Boolean(current.enabled)) ? 1 : 0;
    const completedAt = nextEnabled ? null : current.completed_at;
    db.get().prepare(`
      UPDATE budget_subscriptions SET
        name = ?, description = ?, amount = ?, currency = ?, billing_cycle = ?, cycle_interval = ?,
        next_payment_date = ?, category_id = ?, payment_method_id = ?, reminder_days = ?, enabled = ?,
        website_url = ?, logo_data = ?, brand_color = ?, notes = ?, account_username = ?, visibility = ?,
        end_type = ?, end_date = ?, occurrence_count = ?, completed_at = ?
      WHERE id = ?
    `).run(
      value('name', current.name)?.trim(), value('description', current.description)?.trim() || null,
      Number(value('amount', current.amount)), validated.currency || current.currency,
      value('billing_cycle', current.billing_cycle), validated.cycleInterval || current.cycle_interval,
      nextPaymentDate, value('category_id', current.category_id) || null,
      value('payment_method_id', current.payment_method_id) || null,
      validated.reminderDays ?? current.reminder_days, nextEnabled,
      value('website_url', current.website_url)?.trim() || null, value('logo_data', current.logo_data) || null,
      value('brand_color', current.brand_color) || null, value('notes', current.notes)?.trim() || null,
      value('account_username', current.account_username)?.trim() || null, nextVisibility,
      endType, endDate, occurrenceCount, completedAt, id,
    );
    let row = loadSubscription(id);
    row = await syncBudgetExpense(row);
    syncReminder(row);
    res.json({ data: decorate(row) });
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
    const { completed, nextDate, occurrencesDone } = resolveRenewal(current);
    if (completed) {
      // Letzte Zahlung durch: abschließen. enabled = 0 lässt syncBudgetExpense den
      // Ausgaben-Eintrag entfernen und syncReminder die Erinnerung löschen.
      db.get().prepare(`
        UPDATE budget_subscriptions
        SET occurrences_done = ?, enabled = 0, completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?
      `).run(occurrencesDone, id);
      const done = await syncBudgetExpense(loadSubscription(id));
      syncReminder(done);
      return res.json({ data: decorate(done) });
    }
    db.get().prepare('UPDATE budget_subscriptions SET next_payment_date = ?, occurrences_done = ? WHERE id = ?')
      .run(nextDate, occurrencesDone, id);
    let row = loadSubscription(id);
    row = await syncBudgetExpense(row, { preserveCurrent: true });
    syncReminder(row);
    res.json({ data: decorate(row) });
  } catch (err) {
    log.error('POST /:id/renew error:', err);
    res.status(500).json({ error: 'Subscription renewal could not be saved.', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = loadSubscription(id);
    if (!existing) return res.status(404).json({ error: 'Subscription not found.', code: 404 });
    if (!mayEditSub(req, existing)) return res.status(403).json({ error: 'You cannot modify this subscription.', code: 403 });
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
