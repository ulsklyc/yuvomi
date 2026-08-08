/**
 * API integration tokens may act as an explicitly selected family member while
 * retaining the administrator who created the credential as the audit owner.
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'api-token-subject-test-secret';
process.env.DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import express from 'express';

const dbmod = await import('../server/db.js');
const { router: authRouter, requireAuth } = await import('../server/auth.js');
const { csrfMiddleware } = await import('../server/middleware/csrf.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');
const database = dbmod.get();

const adminId = Number(database.prepare(`
  INSERT INTO users(username, display_name, password_hash, role)
  VALUES ('subject-admin', 'Subject Admin', 'x', 'admin')
`).run().lastInsertRowid);
const memberId = Number(database.prepare(`
  INSERT INTO users(username, display_name, password_hash, role)
  VALUES ('subject-member', 'Subject Member', 'x', 'member')
`).run().lastInsertRowid);
const adminToken = 'yuvomi_subject_admin_test_token';
database.prepare(`
  INSERT INTO api_tokens(name, token_hash, token_prefix, created_by)
  VALUES ('Test admin', ?, 'yuvomi_subj', ?)
`).run(crypto.createHash('sha256').update(adminToken).digest('hex'), adminId);

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
app.get('/auth-context', requireAuth, (req, res) => res.json({
  user_id: req.authUserId,
  role: req.authRole,
  module_access: req.sessionModuleAccess,
}));
app.use('/budget', requireAuth, csrfMiddleware, budgetRouter);
const server = app.listen(0);
const baseUrl = await new Promise((resolve) => server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, route, token, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test('admin may create a scoped token for a selected member and token writes belong to that member', async () => {
  const created = await call('POST', '/auth/api-tokens', adminToken, {
    name: 'Akahu for member',
    subject_user_id: memberId,
    scopes: ['budget:write'],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.created_by, adminId);
  assert.equal(created.body.data.subject_user_id, memberId);
  assert.equal(created.body.data.subject_name, 'Subject Member');
  const listed = await call('GET', '/auth/api-tokens', adminToken);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.subjects.some((subject) => subject.id === memberId));

  database.prepare(`
    INSERT INTO access_permissions(subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'budget', 'none')
  `).run(String(memberId));
  const context = await call('GET', '/auth-context', created.body.token);
  assert.equal(context.status, 200);
  assert.equal(context.body.user_id, memberId);
  assert.equal(context.body.role, 'member');
  assert.equal(context.body.module_access.budget, 'none');
  database.prepare(`
    DELETE FROM access_permissions
    WHERE subject_type = 'user' AND subject_id = ? AND resource_type = 'module' AND resource_key = 'budget'
  `).run(String(memberId));

  const entry = await call('POST', '/budget', created.body.token, {
    title: 'Power bill', amount: -125.5, date: '2026-08-01', visibility: 'private',
  });
  assert.equal(entry.status, 201);
  assert.equal(entry.body.data.owner_id, memberId);
  assert.equal(entry.body.data.created_by, memberId);
});

test('API token settings let an admin select the token subject', () => {
  const source = readFileSync(new URL('../public/settings/pages/admin-api.js', import.meta.url), 'utf8');
  assert.match(source, /id="api-token-subject"/);
  assert.match(source, /subject_user_id/);
  assert.match(source, /tokenResponse\.subjects/);
});

test('subject token schema is documented and deleting its subject removes the token', async () => {
  const schema = buildOpenApiSpec({}, 'test').components.schemas;
  assert.ok(schema.ApiToken.properties.subject_user_id);
  assert.ok(schema.ApiToken.properties.subject_name);
  assert.ok(schema.ApiTokenCreateRequest.properties.subject_user_id);

  const disposable = Number(database.prepare(`
    INSERT INTO users(username, display_name, password_hash, role)
    VALUES ('subject-disposable', 'Disposable', 'x', 'member')
  `).run().lastInsertRowid);
  const created = await call('POST', '/auth/api-tokens', adminToken, { name: 'Disposable integration', subject_user_id: disposable });
  assert.equal(created.status, 201);
  database.prepare('DELETE FROM users WHERE id=?').run(disposable);
  assert.equal(database.prepare('SELECT count(*) AS count FROM api_tokens WHERE id=?').get(created.body.data.id).count, 0);
});

test('a split-expense guest cannot be selected as an integration-token subject', async () => {
  const guestId = Number(database.prepare(`
    INSERT INTO users(username, display_name, password_hash, role)
    VALUES ('subject-guest', 'Guest', 'x', 'member')
  `).run().lastInsertRowid);
  const groupId = Number(database.prepare("INSERT INTO expense_groups(name, default_currency, created_by) VALUES ('Guest group', 'EUR', ?)").run(adminId).lastInsertRowid);
  database.prepare('INSERT INTO split_expense_guest_users(user_id, group_id, created_by) VALUES (?, ?, ?)').run(guestId, groupId, adminId);
  const response = await call('POST', '/auth/api-tokens', adminToken, { name: 'Invalid guest integration', subject_user_id: guestId });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /guest|subject/i);
});
