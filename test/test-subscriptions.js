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
  assert.ok(logoService.serviceDomainCandidates('Amazon Prime').includes('amazon.com'));
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
