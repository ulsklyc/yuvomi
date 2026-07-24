import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.DB_PATH = path.join(os.tmpdir(), `oikos-subscriptions-${process.pid}.db`);
process.env.SESSION_SECRET = 'subscription-test-session-secret-32-bytes';

const service = await import('../server/services/subscriptions.js');
const db = await import('../server/db.js');
const { default: subscriptionsRouter } = await import('../server/routes/subscriptions.js');
const logoService = await import('../server/services/subscription-logo.js');

try {
  assert.equal(service.addBillingCycle('2026-01-31', 'monthly', 1), '2026-02-28');
  assert.equal(service.addBillingCycle('2024-02-29', 'yearly', 1), '2025-02-28');
  assert.equal(service.addBillingCycle('2026-06-12', 'weekly', 2), '2026-06-26');
  assert.equal(service.nextRenewalOnOrAfter('2026-01-31', 'monthly', 1, '2026-03-01'), '2026-03-28');
  assert.equal(service.reminderDate('2026-06-12', 3), '2026-06-09T09:00');

  assert.equal(service.monthlyEquivalent(120, 'yearly', 1), 10);
  assert.equal(service.monthlyEquivalent(20, 'monthly', 2), 10);
  assert.ok(Math.abs(service.monthlyEquivalent(7, 'weekly', 1) - 30.436875) < 0.000001);
  assert.equal(service.convertAmount(10, 'USD', 'EUR', { USD: 0.9 }), 9);
  assert.equal(service.convertAmount(10, 'EUR', 'EUR', {}), 10);
  assert.equal(service.convertAmount(10, 'USD', 'EUR', {}), null);
  assert.equal(logoService.privateAddress('127.0.0.1'), true);
  assert.equal(logoService.privateAddress('192.168.1.4'), true);
  assert.equal(logoService.privateAddress('8.8.8.8'), false);
  assert.deepEqual(
    logoService.iconUrls(
      '<link rel="apple-touch-icon" href="/large.png"><link rel="icon" href="/small.png">',
      new URL('https://example.com/path'),
    ),
    ['https://example.com/small.png', 'https://example.com/large.png', 'https://example.com/favicon.ico'],
  );
  assert.deepEqual(
    logoService.websiteImageUrls(
      '<meta property="og:image" content="/brand.png"><img alt="Example logo" src="/logo.svg">',
      new URL('https://example.com/path'),
    ),
    ['https://example.com/favicon.ico', 'https://example.com/brand.png', 'https://example.com/logo.svg'],
  );
  assert.deepEqual(
    logoService.serviceDomainCandidates('Netflix').slice(0, 3),
    ['netflix.com', 'netflix.io', 'netflix.app'],
  );
  assert.ok(logoService.serviceDomainCandidates('Amazon Prime').some((domain) => domain === 'amazon.com'));
  assert.deepEqual(
    logoService.serviceDomainCandidates('https://www.example.com/billing'),
    ['example.com'],
  );

  const database = db.get();
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'subscription%'
    ORDER BY name
  `).all().map((row) => row.name);
  assert.deepEqual(tables, [
    'subscription_categories',
    'subscription_exchange_rates',
    'subscription_payment_methods',
    'subscription_settings',
  ]);
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'budget_subscriptions'").get());
  assert.equal(
    database.prepare("SELECT name FROM budget_categories WHERE key = 'subscriptions'").get().name,
    'Subscription',
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS n FROM budget_subcategories WHERE category_key = 'subscriptions'").get().n,
    6,
  );

  database.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('owner', 'Owner', 'x', 'admin')
  `).run();
  const subscriptionId = database.prepare(`
    INSERT INTO budget_subscriptions
      (name, amount, currency, billing_cycle, next_payment_date, created_by)
    VALUES ('Example', 12.5, 'EUR', 'monthly', '2026-07-01', 1)
  `).run().lastInsertRowid;
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('subscription', ?, '2026-06-28T09:00', 1)
  `).run(subscriptionId);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS n FROM reminders WHERE entity_type = 'subscription'").get().n,
    1,
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = 1;
    req.authRole = 'admin';
    next();
  });
  app.use('/subscriptions', subscriptionsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/subscriptions`;
    const entertainment = database.prepare(
      "SELECT id FROM subscription_categories WHERE name = 'Entertainment'",
    ).get();
    const createResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Video service',
        amount: 120,
        currency: 'EUR',
        billing_cycle: 'yearly',
        cycle_interval: 1,
        next_payment_date: '2026-08-10',
        reminder_days: 5,
        category_id: entertainment.id,
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()).data;
    assert.equal(created.name, 'Video service');
    assert.equal(created.enabled, true);
    assert.ok(created.budget_entry_id);
    const linkedExpense = database.prepare('SELECT * FROM budget_entries WHERE id = ?').get(created.budget_entry_id);
    assert.equal(linkedExpense.title, 'Video service');
    assert.equal(linkedExpense.amount, -120);
    assert.equal(linkedExpense.date, '2026-08-10');
    assert.equal(linkedExpense.category, 'subscriptions');
    assert.equal(linkedExpense.subcategory, 'subscription_entertainment');

    const listResponse = await fetch(baseUrl);
    assert.equal(listResponse.status, 200);
    const list = (await listResponse.json()).data;
    assert.equal(list.subscriptions.length, 2);
    assert.equal(list.summary.monthly_total, 22.5);

    const disableResponse = await fetch(`${baseUrl}/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disableResponse.status, 200);
    assert.equal((await disableResponse.json()).data.enabled, false);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM reminders WHERE entity_type = 'subscription' AND entity_id = ?").get(created.id).n,
      0,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM budget_entries WHERE id = ?').get(created.budget_entry_id).n, 0);

    const enableResponse = await fetch(`${baseUrl}/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, amount: 144, next_payment_date: '2026-09-10' }),
    });
    assert.equal(enableResponse.status, 200);
    const enabled = (await enableResponse.json()).data;
    const renewedExpense = database.prepare('SELECT * FROM budget_entries WHERE id = ?').get(enabled.budget_entry_id);
    assert.equal(renewedExpense.amount, -144);
    assert.equal(renewedExpense.date, '2026-09-10');

    const renewResponse = await fetch(`${baseUrl}/${created.id}/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(renewResponse.status, 200);
    const renewed = (await renewResponse.json()).data;
    assert.equal(renewed.next_payment_date, '2027-09-10');
    assert.notEqual(renewed.budget_entry_id, enabled.budget_entry_id);
    assert.ok(database.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(enabled.budget_entry_id));
    assert.equal(
      database.prepare('SELECT date FROM budget_entries WHERE id = ?').get(renewed.budget_entry_id).date,
      '2027-09-10',
    );

    const categoryResponse = await fetch(`${baseUrl}/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Developer tools',
        color: '#334155',
      }),
    });
    assert.equal(categoryResponse.status, 201);
    const category = (await categoryResponse.json()).data;
    assert.equal(category.budget_subcategory_key, `subscription_category_${category.id}`);
    assert.equal(
      database.prepare('SELECT name FROM budget_subcategories WHERE key = ?').get(category.budget_subcategory_key).name,
      'Developer tools',
    );

    // ------------------------------------------------------------------
    // Härtung: netz-freie Routen-Schicht (Metadaten, Einstellungen,
    // Zahlungsarten, Sortierung, Validierung, Filter, Löschung) und der
    // personal-Modus-Sicherheitspfad (kein Admin-Bypass). Der Fixer-fetch
    // (refresh_rates) und die Logo-Suche bleiben bewusst ausgeklammert.
    // ------------------------------------------------------------------
    const jsonReq = async (method, subPath, body) => {
      const res = await fetch(`${baseUrl}${subPath}`, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let payload = null;
      try { payload = await res.json(); } catch { /* 204 hat keinen Body */ }
      return { status: res.status, body: payload };
    };

    // PUT /:id auf ein aktives Abo mit bestehendem Budget-Eintrag deckt den
    // syncBudgetExpense-UPDATE-Zweig (Betrag/Eigentümer/Sichtbarkeit mitziehen)
    // und die Sichtbarkeits-Umschaltung. (created.id ist nach renew aktiv.)
    const updatedSub = await jsonReq('PUT', `/${created.id}`, { amount: 99, visibility: 'shared' });
    assert.equal(updatedSub.status, 200);
    assert.equal(updatedSub.body.data.amount, 99);
    const updatedEntry = database.prepare('SELECT amount, visibility FROM budget_entries WHERE id = ?').get(updatedSub.body.data.budget_entry_id);
    assert.equal(updatedEntry.amount, -99);
    assert.equal(updatedEntry.visibility, 'shared');

    // GET /meta + GET /settings (Lese-Handler).
    const meta = await jsonReq('GET', '/meta');
    assert.equal(meta.status, 200);
    assert.ok(Array.isArray(meta.body.data.categories));
    assert.ok(Array.isArray(meta.body.data.payment_methods));
    assert.ok(Array.isArray(meta.body.data.billing_cycles));
    const settingsGet = await jsonReq('GET', '/settings');
    assert.equal(settingsGet.status, 200);
    assert.ok('base_currency' in settingsGet.body.data);

    // PUT /settings: Validierung + Persistenz (currency wird großgeschrieben).
    assert.equal((await jsonReq('PUT', '/settings', { monthly_budget: -5, base_currency: 'EUR' })).status, 400);
    assert.equal((await jsonReq('PUT', '/settings', { monthly_budget: 10, base_currency: 'EU' })).status, 400);
    const settingsPut = await jsonReq('PUT', '/settings', { monthly_budget: 200, base_currency: 'usd' });
    assert.equal(settingsPut.status, 200);
    assert.equal(settingsPut.body.data.monthly_budget, 200);
    assert.equal(settingsPut.body.data.base_currency, 'USD');
    // Zustand für nachfolgende (netz-freie) GET / wieder auf EUR zurücksetzen.
    assert.equal((await jsonReq('PUT', '/settings', { monthly_budget: 50, base_currency: 'EUR' })).body.data.base_currency, 'EUR');

    // POST /payment-methods: 400 (kein Name), 201, 409 (Dublette).
    assert.equal((await jsonReq('POST', '/payment-methods', {})).status, 400);
    const method = await jsonReq('POST', '/payment-methods', { name: 'Kreditkarte' });
    assert.equal(method.status, 201);
    const methodId = method.body.data.id;
    assert.equal((await jsonReq('POST', '/payment-methods', { name: 'Kreditkarte' })).status, 409);

    // POST /categories: Dublette -> 409 (der Happy-Fall lief oben).
    assert.equal((await jsonReq('POST', '/categories', { name: 'Developer tools' })).status, 409);

    // PUT /meta/order: 400 (keine Liste) + Persistenz der Reihenfolge.
    assert.equal((await jsonReq('PUT', '/meta/order', {})).status, 400);
    const reorder = await jsonReq('PUT', '/meta/order', { categories: [category.id], payment_methods: [methodId] });
    assert.equal(reorder.status, 200);
    assert.equal(reorder.body.data.updated, true);
    assert.equal(database.prepare('SELECT sort_order FROM subscription_categories WHERE id = ?').get(category.id).sort_order, 0);
    assert.equal(database.prepare('SELECT sort_order FROM subscription_payment_methods WHERE id = ?').get(methodId).sort_order, 0);
    // Die verknüpfte Budget-Subkategorie erbt die Reihenfolge.
    assert.equal(database.prepare('SELECT sort_order FROM budget_subcategories WHERE key = ?').get(category.budget_subcategory_key).sort_order, 0);

    // POST /logo-search: netz-freier Eingabe-Gate (leere Anfrage -> 400).
    assert.equal((await jsonReq('POST', '/logo-search', {})).status, 400);

    // GET / mit Filtern (enabled/category_id/payment_method_id/q).
    for (const query of ['?enabled=true', '?enabled=false', `?category_id=${entertainment.id}`, `?payment_method_id=${methodId}`, '?q=Video']) {
      const filtered = await jsonReq('GET', query);
      assert.equal(filtered.status, 200, `GET /${query}`);
      assert.ok(Array.isArray(filtered.body.data.subscriptions));
    }

    // validatePayload: 400-Durchlauf über POST / (jeweils ein ungültiges Feld).
    const validBase = { name: 'Payload', amount: 5, currency: 'EUR', billing_cycle: 'monthly', next_payment_date: '2026-10-01' };
    const invalidCases = [
      { ...validBase, name: undefined },
      { ...validBase, amount: -5 },
      { ...validBase, currency: 'EU' },
      { ...validBase, billing_cycle: 'invalid_cycle' },
      { ...validBase, cycle_interval: 0 },
      { ...validBase, reminder_days: 400 },
      { ...validBase, website_url: 'ftp://example.com' },
      { ...validBase, logo_data: 'notadataurl' },
      { ...validBase, category_id: 0 },
      { ...validBase, enabled: 'yes' },
    ];
    for (const [index, body] of invalidCases.entries()) {
      assert.equal((await jsonReq('POST', '', body)).status, 400, `ungültiger Payload #${index}`);
    }
    // Keiner der 400-Fälle hat eine Zeile angelegt.
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM budget_subscriptions WHERE name = 'Payload'").get().n, 0);

    // PUT/renew auf unbekannte ID -> 404.
    assert.equal((await jsonReq('PUT', '/999999', { name: 'x' })).status, 404);
    assert.equal((await jsonReq('POST', '/999999/renew', {})).status, 404);

    // DELETE /:id: 404 + vollständige Löschung (Abo, Erinnerung, Budget-Eintrag).
    assert.equal((await jsonReq('DELETE', '/999999')).status, 404);
    const delTarget = await jsonReq('POST', '', { name: 'Löschbar', amount: 9, currency: 'EUR', billing_cycle: 'monthly', next_payment_date: '2026-11-01', reminder_days: 3 });
    const delId = delTarget.body.data.id;
    const delEntryId = delTarget.body.data.budget_entry_id;
    assert.ok(delEntryId, 'Budget-Eintrag verknüpft');
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM reminders WHERE entity_type = 'subscription' AND entity_id = ?").get(delId).n, 1);
    assert.equal((await jsonReq('DELETE', `/${delId}`)).status, 204);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM budget_subscriptions WHERE id = ?').get(delId).n, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM reminders WHERE entity_type = 'subscription' AND entity_id = ?").get(delId).n, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM budget_entries WHERE id = ?').get(delEntryId).n, 0);

    // ------------------------------------------------------------------
    // Meta-Bearbeitung/-Löschung (#551): Kategorien + Zahlungsarten editier-
    // und entfernbar; verknüpfte Budget-Subkategorie + Abos ziehen korrekt mit.
    // ------------------------------------------------------------------
    // Kategorie umbenennen + neu färben -> Budget-Subkategorie erbt den Namen.
    const catEdit = await jsonReq('PUT', `/categories/${category.id}`, { name: 'Dev tooling', color: '#111827' });
    assert.equal(catEdit.status, 200);
    assert.equal(catEdit.body.data.name, 'Dev tooling');
    assert.equal(catEdit.body.data.color, '#111827');
    assert.equal(
      database.prepare('SELECT name FROM budget_subcategories WHERE key = ?').get(category.budget_subcategory_key).name,
      'Dev tooling',
    );
    assert.equal((await jsonReq('PUT', '/categories/999999', { name: 'x' })).status, 404);
    // Namensdublette gegen Default-Kategorie -> 409 (COLLATE NOCASE UNIQUE).
    assert.equal((await jsonReq('PUT', `/categories/${category.id}`, { name: 'Entertainment' })).status, 409);

    // GET /meta liefert usage_count je Eintrag.
    const usageMeta = await jsonReq('GET', '/meta');
    assert.equal(usageMeta.body.data.categories.find((c) => c.id === category.id).usage_count, 0);

    // Weich löschen einer genutzten Kategorie: Abo -> uncategorized, Budget-
    // Subkategorie entfernt, Ausgaben-Eintrag von der toten Subkategorie gelöst.
    const linkCat = await jsonReq('POST', '/categories', { name: 'Streaming', color: '#7C3AED' });
    const linkCatId = linkCat.body.data.id;
    const linkCatKey = linkCat.body.data.budget_subcategory_key;
    const linkedSub = await jsonReq('POST', '', {
      name: 'Streamer', amount: 12, currency: 'EUR', billing_cycle: 'monthly',
      next_payment_date: '2026-10-05', reminder_days: 3, category_id: linkCatId,
    });
    const linkedSubId = linkedSub.body.data.id;
    const linkedEntryId = linkedSub.body.data.budget_entry_id;
    assert.equal(database.prepare('SELECT subcategory FROM budget_entries WHERE id = ?').get(linkedEntryId).subcategory, linkCatKey);
    assert.equal((await jsonReq('GET', '/meta')).body.data.categories.find((c) => c.id === linkCatId).usage_count, 1);
    const catDel = await jsonReq('DELETE', `/categories/${linkCatId}`);
    assert.equal(catDel.status, 200);
    assert.equal(catDel.body.data.affected, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM subscription_categories WHERE id = ?').get(linkCatId).n, 0);
    assert.equal(database.prepare('SELECT category_id FROM budget_subscriptions WHERE id = ?').get(linkedSubId).category_id, null);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM budget_subcategories WHERE key = ?').get(linkCatKey).n, 0);
    assert.equal(database.prepare('SELECT subcategory FROM budget_entries WHERE id = ?').get(linkedEntryId).subcategory, '');
    assert.equal((await jsonReq('DELETE', '/categories/999999')).status, 404);

    // Zahlungsart umbenennen (404/400-Pfade) + löschen entkoppelt Abos (FK SET NULL).
    const pmEdit = await jsonReq('PUT', `/payment-methods/${methodId}`, { name: 'Kreditkarte Gold' });
    assert.equal(pmEdit.status, 200);
    assert.equal(pmEdit.body.data.name, 'Kreditkarte Gold');
    assert.equal((await jsonReq('PUT', '/payment-methods/999999', { name: 'x' })).status, 404);
    assert.equal((await jsonReq('PUT', `/payment-methods/${methodId}`, {})).status, 400);
    const pmSub = await jsonReq('POST', '', {
      name: 'Karten-Abo', amount: 7, currency: 'EUR', billing_cycle: 'monthly',
      next_payment_date: '2026-10-06', reminder_days: 3, payment_method_id: methodId,
    });
    const pmSubId = pmSub.body.data.id;
    const pmDel = await jsonReq('DELETE', `/payment-methods/${methodId}`);
    assert.equal(pmDel.status, 200);
    assert.equal(pmDel.body.data.affected, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM subscription_payment_methods WHERE id = ?').get(methodId).n, 0);
    assert.equal(database.prepare('SELECT payment_method_id FROM budget_subscriptions WHERE id = ?').get(pmSubId).payment_method_id, null);
    assert.equal((await jsonReq('DELETE', '/payment-methods/999999')).status, 404);

    // Personal-Modus: kein Admin-Bypass auf fremde private Abos (#476/#505).
    database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('other', 'Other', 'x', 'member')").run();
    const otherId = database.prepare("SELECT id FROM users WHERE username = 'other'").get().id;
    database.prepare("INSERT INTO sync_config (key, value) VALUES ('budget_mode', 'personal') ON CONFLICT(key) DO UPDATE SET value = 'personal'").run();
    const foreignId = database.prepare(`
      INSERT INTO budget_subscriptions (name, amount, currency, billing_cycle, next_payment_date, created_by, owner_id, visibility)
      VALUES ('Fremd', 5, 'EUR', 'monthly', '2026-12-01', ?, ?, 'private')
    `).run(otherId, otherId).lastInsertRowid;
    // Admin (User 1) ist weder Eigentümer noch Ersteller -> 403, DB unverändert.
    assert.equal((await jsonReq('PUT', `/${foreignId}`, { name: 'Hack' })).status, 403);
    assert.equal((await jsonReq('DELETE', `/${foreignId}`)).status, 403);
    assert.equal(database.prepare('SELECT name FROM budget_subscriptions WHERE id = ?').get(foreignId).name, 'Fremd');
    // GET / blendet fremde private Abos aus.
    const scoped = await jsonReq('GET', '');
    assert.ok(!scoped.body.data.subscriptions.some((row) => row.id === foreignId), 'fremdes privates Abo nicht sichtbar');
    // Modus zurücksetzen, damit der Rest im shared-Standard läuft.
    database.prepare("UPDATE sync_config SET value = 'shared' WHERE key = 'budget_mode'").run();

    const removedNotificationsResponse = await fetch(`${baseUrl}/notification-agents`);
    assert.equal(removedNotificationsResponse.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }

  console.log('Subscription tests passed');
} finally {
  db.get().close();
  fs.rmSync(process.env.DB_PATH, { force: true });
  fs.rmSync(`${process.env.DB_PATH}-wal`, { force: true });
  fs.rmSync(`${process.env.DB_PATH}-shm`, { force: true });
}
