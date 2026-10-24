/**
 * Test: Fremdes aendern nur mit Recht (R23, D5 + D15)
 * Zweck: Ohne `calendar_edit_others`, `notes_edit_others` und
 *        `inventory_edit_others` liest ein Konto alles, aendert und loescht
 *        aber nur Eigenes - am Server, nicht nur in der Oberflaeche. Ohne
 *        `inventory_view_prices` fehlen Kaufpreis und Waehrung in jeder
 *        Antwort, und ein Schreiben laesst den gespeicherten Preis stehen. Ohne
 *        `tasks_reorder_family` bleibt die Handordnung der Aufgaben, wie sie ist.
 *        Alle Anfragen laufen mit API-Tokens durch `requireAuth`: derselbe Weg,
 *        den eine Integration und die MCP-Bruecke (`call_api_operation`, per
 *        Loopback auf dieselben Routen) nehmen.
 * Ausfuehren: node --experimental-sqlite --test test/test-edit-others-permissions.js
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'edit-others-test-secret';
process.env.DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';

const dbmod = await import('../server/db.js');
const { requireAuth } = await import('../server/auth.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { default: notesRouter } = await import('../server/routes/notes.js');
const { default: inventoryRouter } = await import('../server/routes/inventory/index.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const {
  applyChildStartPermissions, CHILD_START_PERMISSIONS, PERMISSION_CAPABILITIES, resolvePermissions,
} = await import('../server/permissions.js');
const db = dbmod.get();

function user(username, role, familyRole) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, 'x', ?, ?)
  `).run(username, username, role, familyRole).lastInsertRowid);
}

const ADMIN = user('linda', 'admin', 'mom');
const PARENT = user('tom', 'member', 'dad');
const CHILD = user('emma', 'member', 'child');
applyChildStartPermissions(db, { id: CHILD, role: 'member', family_role: 'child' });

const tokens = {};
for (const [name, id] of Object.entries({ admin: ADMIN, parent: PARENT, child: CHILD })) {
  const token = `yuvomi_edit_others_${name}`;
  db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id)
    VALUES (?, ?, 'yuvomi_edit', ?, ?)
  `).run(name, crypto.createHash('sha256').update(token).digest('hex'), ADMIN, id);
  tokens[name] = token;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/calendar', requireAuth, calendarRouter);
app.use('/notes', requireAuth, notesRouter);
app.use('/inventory', requireAuth, inventoryRouter);
app.use('/tasks', requireAuth, tasksRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((resolve) => server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(who, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

function setCapability(userId, key, access) {
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'capability', ?, ?)
    ON CONFLICT(subject_type, subject_id, resource_type, resource_key) DO UPDATE SET access = excluded.access
  `).run(String(userId), key, access);
}

// ── Katalog und Startrechte ───────────────────────────────────────────────────

test('Katalog: die fuenf neuen Rechte stehen auf allow - bestehende Konten bleiben, wie sie sind', () => {
  for (const key of ['calendar_edit_others', 'notes_edit_others', 'inventory_edit_others', 'inventory_view_prices', 'tasks_reorder_family']) {
    const item = PERMISSION_CAPABILITIES.find((entry) => entry.key === key);
    assert.ok(item, `${key} fehlt im Katalog`);
    assert.equal(item.default, 'allow', `${key}: Standard muss allow sein`);
    assert.ok(item.labelKey, `${key}: ohne Beschriftung`);
  }
  const parent = resolvePermissions(db, { id: PARENT, role: 'member', family_role: 'dad' });
  assert.equal(parent.capabilities.calendar_edit_others, 'allow');
  assert.equal(parent.capabilities.inventory_view_prices, 'allow');
  assert.equal(parent.modules.waste, 'write');
});

test('Startrechte: ein neues Kinderkonto liest Fremdes nur, sieht keine Kaufpreise, Entsorgung nur lesen (D15)', () => {
  assert.equal(CHILD_START_PERMISSIONS.modules.waste, 'read');
  const child = resolvePermissions(db, { id: CHILD, role: 'member', family_role: 'child' });
  for (const key of ['calendar_edit_others', 'notes_edit_others', 'inventory_edit_others', 'inventory_view_prices', 'tasks_reorder_family']) {
    assert.equal(child.capabilities[key], 'none', `${key}`);
  }
  assert.equal(child.modules.waste, 'read');
  // Kontakte bleiben bewusst aussen vor: ein Kontakt traegt keinen Ersteller.
  assert.equal(PERMISSION_CAPABILITIES.some((entry) => entry.key === 'contacts_edit_others'), false);
});

// ── Kalender ──────────────────────────────────────────────────────────────────

function event({ createdBy, title = 'Termin', rule = null, assignedTo = null }) {
  return Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, created_by, recurrence_rule, assigned_to)
    VALUES (?, '2026-11-02T10:00', '2026-11-02T11:00', ?, ?, ?)
  `).run(title, createdBy, rule, assignedTo).lastInsertRowid);
}

const eventBody = { title: 'Geaendert', start_datetime: '2026-11-02T12:00', end_datetime: '2026-11-02T13:00' };

test('Kalender: ein Kind liest Familientermine, aendert und loescht sie aber nicht', async () => {
  const foreign = event({ createdBy: PARENT, title: 'Elternabend' });
  const read = await call('child', 'GET', `/calendar/${foreign}`);
  assert.equal(read.status, 200);

  const put = await call('child', 'PUT', `/calendar/${foreign}`, eventBody);
  assert.equal(put.status, 403);
  assert.equal(put.body.reason, 'not_owner');
  const del = await call('child', 'DELETE', `/calendar/${foreign}`);
  assert.equal(del.status, 403);
  const row = db.prepare('SELECT title FROM calendar_events WHERE id = ?').get(foreign);
  assert.equal(row.title, 'Elternabend', 'der Termin steht unveraendert');
});

test('Kalender: Eigenes und Zugewiesenes darf das Kind aendern', async () => {
  const own = event({ createdBy: CHILD, title: 'Mein Training' });
  assert.equal((await call('child', 'PUT', `/calendar/${own}`, eventBody)).status, 200);

  const assigned = event({ createdBy: PARENT, title: 'Zahnarzt Emma' });
  db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(assigned, CHILD);
  assert.equal((await call('child', 'PUT', `/calendar/${assigned}`, eventBody)).status, 200);

  const single = event({ createdBy: PARENT, title: 'Abholen', assignedTo: CHILD });
  assert.equal((await call('child', 'PUT', `/calendar/${single}`, eventBody)).status, 200);

  assert.equal((await call('child', 'DELETE', `/calendar/${own}`)).status, 204);
});

test('Kalender: Serien - Einzelausnahme, Kuerzen und Auslassen fremder Serien sind gesperrt', async () => {
  const series = event({ createdBy: PARENT, title: 'Schwimmen', rule: 'FREQ=WEEKLY' });
  const occ = '2026-11-09T10:00:00';
  const putOcc = await call('child', 'PUT', `/calendar/${series}/occurrences/${occ}`, { title: 'X' });
  assert.equal(putOcc.status, 403);
  assert.equal(putOcc.body.reason, 'not_owner');
  assert.equal((await call('child', 'PUT', `/calendar/${series}/occurrences/${occ}/following`, { title: 'X' })).status, 403);
  assert.equal((await call('child', 'DELETE', `/calendar/${series}/occurrences/${occ}`)).status, 403);
  assert.equal((await call('child', 'DELETE', `/calendar/${series}/occurrences/${occ}/following`)).status, 403);
  assert.equal((await call('child', 'POST', `/calendar/${series}/exceptions`, { date: '2026-11-09' })).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_event_exceptions WHERE event_id = ?').get(series).n, 0);
});

test('Kalender: Erwachsene behalten den heutigen Stand, und das Recht oeffnet es auch dem Kind', async () => {
  const foreign = event({ createdBy: ADMIN, title: 'Familienfest' });
  assert.equal((await call('parent', 'PUT', `/calendar/${foreign}`, eventBody)).status, 200);
  setCapability(CHILD, 'calendar_edit_others', 'allow');
  try {
    assert.equal((await call('child', 'PUT', `/calendar/${foreign}`, eventBody)).status, 200);
  } finally {
    setCapability(CHILD, 'calendar_edit_others', 'none');
  }
});

// ── Notizen ───────────────────────────────────────────────────────────────────

function note(createdBy, content = 'Notiz') {
  return Number(db.prepare('INSERT INTO notes (content, created_by) VALUES (?, ?)').run(content, createdBy).lastInsertRowid);
}

test('Notizen: fremde Notiz lesen ja, bearbeiten, pinnen und loeschen nein', async () => {
  const foreign = note(PARENT, 'Einkaufsideen');
  const list = await call('child', 'GET', '/notes');
  assert.ok(list.body.data.some((n) => n.id === foreign));

  const put = await call('child', 'PUT', `/notes/${foreign}`, { content: 'weg damit' });
  assert.equal(put.status, 403);
  assert.equal(put.body.reason, 'not_owner');
  assert.equal((await call('child', 'PATCH', `/notes/${foreign}/pin`)).status, 403);
  assert.equal((await call('child', 'DELETE', `/notes/${foreign}`)).status, 403);
  const row = db.prepare('SELECT content, pinned FROM notes WHERE id = ?').get(foreign);
  assert.deepEqual({ ...row }, { content: 'Einkaufsideen', pinned: 0 });
});

test('Notizen: eigene Notiz frei; Checkliste abhaken und eigene Kategorien bleiben auch an fremden offen', async () => {
  const own = note(CHILD, 'Mein Zettel');
  assert.equal((await call('child', 'PUT', `/notes/${own}`, { content: 'Neu' })).status, 200);
  assert.equal((await call('child', 'PATCH', `/notes/${own}/pin`)).status, 200);

  const list = note(PARENT, '- [ ] Zelt\n- [ ] Schlafsack');
  const check = await call('child', 'PATCH', `/notes/${list}/check`, { line: 0, checked: true });
  assert.equal(check.status, 200);
  const cats = await call('child', 'PUT', `/notes/${list}`, { category_ids: [] });
  assert.equal(cats.status, 200);
  assert.equal((await call('child', 'DELETE', `/notes/${own}`)).status, 204);
});

test('Notizen: Erwachsene loeschen weiter fremde Notizen (Standard allow)', async () => {
  const foreign = note(CHILD, 'Kinderzettel');
  assert.equal((await call('parent', 'DELETE', `/notes/${foreign}`)).status, 204);
});

// ── Inventar ──────────────────────────────────────────────────────────────────

function item(createdBy, name = 'Bohrmaschine', price = 129.9) {
  return Number(db.prepare(`
    INSERT INTO inventory_items (name, category, purchase_price, currency, created_by)
    VALUES (?, 'other', ?, 'EUR', ?)
  `).run(name, price, createdBy).lastInsertRowid);
}

test('Inventar: ohne Preisrecht fehlen Kaufpreis und Waehrung in Liste, Detail und Schreibantwort', async () => {
  const id = item(PARENT, 'Fernseher', 899);
  const list = await call('child', 'GET', '/inventory/items');
  const row = list.body.data.find((entry) => entry.id === id);
  assert.ok(row, 'der Gegenstand ist lesbar');
  assert.equal('purchase_price' in row, false);
  assert.equal('currency' in row, false);
  const detail = await call('child', 'GET', `/inventory/items/${id}`);
  assert.equal('purchase_price' in detail.body.data, false);

  const created = await call('child', 'POST', '/inventory/items', { name: 'Mein Rad', purchase_price: 300, currency: 'EUR' });
  assert.equal(created.status, 201);
  assert.equal('purchase_price' in created.body.data, false);
  assert.equal(db.prepare('SELECT purchase_price FROM inventory_items WHERE id = ?').get(created.body.data.id).purchase_price, null,
    'wer keine Preise sieht, schreibt auch keine');

  const adult = await call('parent', 'GET', `/inventory/items/${id}`);
  assert.equal(adult.body.data.purchase_price, 899);
});

test('Inventar: eigener Gegenstand bearbeitbar, der gespeicherte Preis bleibt dabei stehen', async () => {
  const own = item(CHILD, 'Skateboard', 80);
  const put = await call('child', 'PUT', `/inventory/items/${own}`, { name: 'Skateboard Pro' });
  assert.equal(put.status, 200);
  const stored = db.prepare('SELECT name, purchase_price, currency FROM inventory_items WHERE id = ?').get(own);
  assert.deepEqual({ ...stored }, { name: 'Skateboard Pro', purchase_price: 80, currency: 'EUR' });
});

test('Inventar: fremder Gegenstand - jeder Schreibweg 403, Lesen bleibt', async () => {
  const foreign = item(ADMIN, 'Rasenmaeher');
  const paths = [
    ['PUT', `/inventory/items/${foreign}`, { name: 'X' }],
    ['DELETE', `/inventory/items/${foreign}`],
    ['POST', `/inventory/items/${foreign}/service-log`, { label: 'Oel', performed_on: '2026-10-01' }],
    ['POST', `/inventory/items/${foreign}/entries`, { entry_id: 1 }],
    ['DELETE', `/inventory/items/${foreign}/entries/1`],
    ['POST', `/inventory/items/${foreign}/dates/1/complete`, { performed_on: '2026-10-01' }],
    ['PUT', `/inventory/items/${foreign}/service-log/1`, { label: 'Oel', performed_on: '2026-10-01' }],
    ['DELETE', `/inventory/items/${foreign}/service-log/1`],
  ];
  for (const [method, path, body] of paths) {
    const r = await call('child', method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.body.reason, 'not_owner', `${method} ${path}`);
  }
  assert.equal(db.prepare('SELECT name FROM inventory_items WHERE id = ?').get(foreign).name, 'Rasenmaeher');
  assert.equal((await call('parent', 'PUT', `/inventory/items/${foreign}`, { name: 'Rasenmaeher 2' })).status, 200);
});

// ── Aufgaben: Handordnung (D15) ───────────────────────────────────────────────

test('Aufgaben: die Familienreihenfolge sortiert ein Kind nicht um, Erwachsene schon', async () => {
  const a = Number(db.prepare("INSERT INTO tasks (title, created_by) VALUES ('A', ?)").run(PARENT).lastInsertRowid);
  const b = Number(db.prepare("INSERT INTO tasks (title, created_by) VALUES ('B', ?)").run(PARENT).lastInsertRowid);
  const child = await call('child', 'PATCH', '/tasks/reorder', { order: [b, a] });
  assert.equal(child.status, 403);
  assert.equal(child.body.reason, 'reorder_not_allowed');
  assert.equal((await call('child', 'POST', '/tasks/reorder/reset', { ids: [a, b] })).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE sort_order IS NOT NULL').get().n, 0);
  assert.equal((await call('parent', 'PATCH', '/tasks/reorder', { order: [b, a] })).status, 200);
});
