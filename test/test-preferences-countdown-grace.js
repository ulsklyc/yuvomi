/**
 * Test: Konfigurierbare Nachfrist für abgelaufene Countdowns (#969)
 * Zweck: Deckt die Invarianten des Features ab -
 *        - countdown_grace_days ist admin-only und wird validiert (0..90)
 *        - GET liefert ohne Einstellung den Standard (7)
 *        - 0 ist ein gültiger, bewusst gesetzter Wert - kein Rückfall auf 7
 *        - das Einstellungsformular fällt ohne gespeicherten Wert auf
 *          denselben Standard zurück wie der Server (#1027; läuft deshalb
 *          mit dem Browser-Loader)
 *        - die eigentliche Auswirkung (services/countdowns.js) hat ihre
 *          eigenen Tests in test/test-countdown.js
 * Ausführen: npm run test:preferences-countdown-grace
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'preferences-countdown-grace-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');
const { DEFAULT_OVERDUE_GRACE_DAYS } = await import('../server/services/countdowns.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

function applyMigration(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
  database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(database, migration);
  return database;
}

function seedUser(prefix, role = 'member') {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'hash', '#007AFF', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

const ADMIN  = seedUser('admin', 'admin');
const MEMBER = seedUser('member', 'member');

let actor = { id: ADMIN, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/api/v1/preferences', preferencesRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}/api/v1`;

test.after(() => { server.close(); db.close(); });

async function call(method, path, { as, body } = {}) {
  if (as) actor = as;
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const asAdmin  = { id: ADMIN,  role: 'admin' };
const asMember = { id: MEMBER, role: 'member' };

const setGraceDays = (days, as = asAdmin) =>
  call('PUT', '/preferences', { as, body: { countdown_grace_days: days } });

test('GET /preferences: countdown_grace_days ist standardmäßig 7', async () => {
  const r = await call('GET', '/preferences', { as: asAdmin });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.countdown_grace_days, 7);
});

test('PUT /preferences: Admin speichert die Nachfrist, GET liefert sie zurück', async () => {
  const put = await setGraceDays(3);
  assert.equal(put.status, 200);
  assert.equal(put.body.data.countdown_grace_days, 3);

  const getRes = await call('GET', '/preferences', { as: asAdmin });
  assert.equal(getRes.body.data.countdown_grace_days, 3);
});

test('PUT /preferences: 0 ist ein gültiger Wert, kein Rückfall auf den Standard', async () => {
  const put = await setGraceDays(0);
  assert.equal(put.status, 200);
  assert.equal(put.body.data.countdown_grace_days, 0);

  const getRes = await call('GET', '/preferences', { as: asAdmin });
  assert.equal(getRes.body.data.countdown_grace_days, 0, '0 bleibt 0, wird nicht als "nicht gesetzt" gelesen');

  await setGraceDays(7); // zurück auf den Standard für die folgenden Tests
});

test('PUT /preferences: Nicht-Admin bekommt 403', async () => {
  const r = await setGraceDays(2, asMember);
  assert.equal(r.status, 403);

  const getRes = await call('GET', '/preferences', { as: asAdmin });
  assert.equal(getRes.body.data.countdown_grace_days, 7, 'Wert unverändert');
});

for (const invalid of [-1, 91, 7.5, 'sieben']) {
  test(`PUT /preferences: ungültige Nachfrist ${JSON.stringify(invalid)} → 400`, async () => {
    const r = await setGraceDays(invalid);
    assert.equal(r.status, 400);
  });
}

test('das Einstellungsformular fällt auf denselben Standard zurück wie der Server', async () => {
  // Das Formular trägt eine eigene Kopie des Standards für Einstellungen ohne
  // Wert (public/settings/pages/modules-countdowns.js); ein Browser-Modul kann
  // server/services/countdowns.js nicht importieren. Die Kopie greift an ZWEI
  // Stellen: am Feldwert beim Rendern und am gemerkten Stand, gegen den ein
  // Absenden verglichen wird. Geprüft wird deshalb, was die Seite tut, nicht
  // wie die Konstante heisst - driftet eine der beiden, zeigt oder speichert
  // das Formular eine andere Nachfrist als die, nach der der Server abgelaufene
  // Countdowns ausblendet (#1027).
  const saved = [];
  globalThis.__apiStub = {
    get: async () => ({ data: {} }), // Einstellungen ohne Nachfrist
    put: async (_path, body) => { saved.push(body); return { data: body }; },
  };
  try {
    const { resetPreferencesCache } = await import('../public/settings/preferences-cache.js');
    const { render } = await import('../public/settings/pages/modules-countdowns.js');
    resetPreferencesCache();

    let markup = '';
    let onSubmit = null;
    const input = { value: '', disabled: false, isConnected: true };
    const elements = {
      '#countdown-grace-days-form': {
        addEventListener: (type, handler) => { if (type === 'submit') onSubmit = handler; },
        querySelector: () => ({ disabled: false, isConnected: true }),
      },
      '#countdown-grace-days': input,
      '#countdown-grace-days-error': { hidden: true, textContent: '' },
    };
    const container = {
      replaceChildren: () => { markup = ''; },
      insertAdjacentHTML: (_position, html) => { markup += html; },
      querySelector: (selector) => elements[selector] ?? null,
    };

    await render(container, { user: null });

    const field = markup.match(/id="countdown-grace-days"[^>]*value="([^"]*)"/);
    assert.ok(field, 'das Nachfrist-Feld fehlt im Markup');
    assert.equal(Number(field[1]), DEFAULT_OVERDUE_GRACE_DAYS,
      'das Feld zeigt ohne gespeicherten Wert eine andere Nachfrist als der Server');

    assert.equal(typeof onSubmit, 'function', 'das Formular ist nicht gebunden');
    input.value = String(DEFAULT_OVERDUE_GRACE_DAYS);
    await onSubmit({ preventDefault() {} });
    assert.deepEqual(saved, [],
      'den Server-Standard abzuschicken ist keine Änderung - das Formular hielt einen anderen Stand für gespeichert');
  } finally {
    delete globalThis.__apiStub;
  }
});
