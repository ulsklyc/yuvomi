/**
 * Test: Schichtplan-Quickstart-Vorlagen in der Preferences-API
 * Zweck: GET liefert schedule_hidden_templates mit Default []; PUT speichert
 *        eine Teilmenge von work/school/university — aber NUR für Admins
 *        (Nicht-Admin → 403), unbekannte Werte fallen heraus, Ungültiges → 400.
 *        Haushaltweit wie disabled_modules, nicht pro Nutzer wie hidden_modules -
 *        die Vorlagen legen geteilte Schichtarten an.
 * Ausführen: node --experimental-sqlite --test test/test-preferences-schedule-templates.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { get } = await import('../server/db.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

function clearSchedulePreference() {
  get().prepare("DELETE FROM sync_config WHERE key = 'schedule_hidden_templates'").run();
}

let currentUserId = 1;
let currentRole = 'admin';

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = currentUserId; req.authRole = currentRole; next(); });
  app.use('/', preferencesRouter);
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise((r) => s.close(r)),
    }));
  });
}

const read = async (baseUrl) => (await (await fetch(`${baseUrl}/`)).json()).data;
const write = async (baseUrl, body) => {
  const response = await fetch(`${baseUrl}/`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()).data };
};

test.beforeEach(() => { clearSchedulePreference(); currentUserId = 1; currentRole = 'admin'; });

test('GET /preferences: schedule_hidden_templates defaults to an empty array', async () => {
  const { baseUrl, close } = await startApp();
  try {
    assert.deepEqual((await read(baseUrl)).schedule_hidden_templates, []);
  } finally { await close(); }
});

test('an admin can hide school and university, keeping only work visible', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const saved = await write(baseUrl, { schedule_hidden_templates: ['school', 'university'] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.schedule_hidden_templates.sort(), ['school', 'university']);
    assert.deepEqual((await read(baseUrl)).schedule_hidden_templates.sort(), ['school', 'university']);
  } finally { await close(); }
});

test('unknown keys fall out, duplicates collapse', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const saved = await write(baseUrl, { schedule_hidden_templates: ['school', 'school', 'gibtsnicht', 'work'] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.schedule_hidden_templates.sort(), ['school', 'work']);
  } finally { await close(); }
});

test('hiding every template is allowed - "Create shift type" always stays as a manual way forward', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const saved = await write(baseUrl, { schedule_hidden_templates: ['work', 'school', 'university'] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.schedule_hidden_templates.sort(), ['school', 'university', 'work']);
  } finally { await close(); }
});

test('a non-admin cannot change schedule_hidden_templates (403)', async () => {
  currentRole = 'member';
  const { baseUrl, close } = await startApp();
  try {
    const res = await write(baseUrl, { schedule_hidden_templates: ['school'] });
    assert.equal(res.status, 403);
  } finally { await close(); }
});

test('not an array -> 400, nothing is stored', async () => {
  const { baseUrl, close } = await startApp();
  try {
    assert.equal((await write(baseUrl, { schedule_hidden_templates: 'school' })).status, 400);
    assert.deepEqual((await read(baseUrl)).schedule_hidden_templates, []);
  } finally { await close(); }
});

// The templates are household-shared (they create shared shift types), unlike
// hidden_modules which is deliberately per-user - this is the assertion that
// distinguishes the two mechanisms, mirroring the same check hidden_modules
// itself has for the opposite direction.
test('the setting is shared across the whole household, not per member', async () => {
  const { baseUrl, close } = await startApp();
  try {
    await write(baseUrl, { schedule_hidden_templates: ['university'] });
    currentUserId = 2;
    currentRole = 'member';
    assert.deepEqual((await read(baseUrl)).schedule_hidden_templates, ['university'],
      'a different household member sees a different value - then this is not household-wide');
  } finally { await close(); }
});
