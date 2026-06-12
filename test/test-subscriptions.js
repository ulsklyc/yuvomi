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
const aiService = await import('../server/services/subscription-ai.js');
const notificationService = await import('../server/services/subscription-notifications.js');

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
  assert.equal(aiService.parseRecommendations('[{"subscription_id":1,"title":"Review","insight":"Check usage","type":"review"}]').length, 1);
  assert.equal(aiService.localRecommendations([{ id: 1, name: 'A', monthly_base: 10 }], 'EUR')[0].subscription_id, 1);
  await assert.rejects(
    notificationService.assertAllowedUrl('http://127.0.0.1:8080/hook'),
    /Private notification targets/,
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
    'subscription_notification_agents',
    'subscription_notification_deliveries',
    'subscription_payment_methods',
    'subscription_settings',
  ]);
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'budget_subscriptions'").get());
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subscription_notification_agents'").get());

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
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()).data;
    assert.equal(created.name, 'Video service');
    assert.equal(created.enabled, true);

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

    const agentResponse = await fetch(`${baseUrl}/notification-agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Family webhook',
        type: 'webhook',
        config: { url: 'https://example.com/hook', token: 'secret-token' },
      }),
    });
    assert.equal(agentResponse.status, 201);
    const agent = (await agentResponse.json()).data;
    assert.deepEqual(agent.configured_fields.sort(), ['token', 'url']);
    assert.equal(JSON.stringify(agent).includes('secret-token'), false);

    const agentsResponse = await fetch(`${baseUrl}/notification-agents`);
    assert.equal(agentsResponse.status, 200);
    assert.equal(JSON.stringify(await agentsResponse.json()).includes('secret-token'), false);
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
