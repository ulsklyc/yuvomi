/**
 * Test: Jedes Mitglied blendet Module für sich aus (#673)
 *
 * Der Rest des Wunsches, nachdem die Übersicht persönlich geworden war (#585):
 * Module abschalten konnte nur eine Adminin, und zwar gleich für alle. Geprüft
 * wird deshalb genau der Unterschied zum Nachbarschlüssel `disabled_modules`:
 * kein Admin-Gate, pro Nutzer abgelegt, und ohne Wirkung auf den Haushalt.
 *
 * Die Trennung selbst ist die Zusicherung: `disabled_modules` bleibt admin-only
 * und haushaltweit. Fielen beide zusammen, könnte ein Mitglied dem Haushalt ein
 * Modul wegnehmen - das ist der Regress, den der letzte Fall ausschliesst.
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';

const { get } = await import('../server/db.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

let currentUserId = 1;
let currentRole = 'member';

function clearModulePreferences() {
  get().prepare(`
    DELETE FROM sync_config
    WHERE key IN ('disabled_modules', 'hidden_modules')
       OR key LIKE 'hidden_modules:user:%'
  `).run();
}

function rawValue(key) {
  return get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value ?? null;
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = currentUserId;
    req.authRole = currentRole;
    next();
  });
  app.use('/', preferencesRouter);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

const read = async (baseUrl) => (await (await fetch(`${baseUrl}/`)).json()).data;

const write = async (baseUrl, body) => {
  const response = await fetch(`${baseUrl}/`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()).data };
};

test.beforeEach(() => {
  clearModulePreferences();
  currentUserId = 1;
  currentRole = 'member';
});

test('ohne Einstellung ist nichts ausgeblendet', async () => {
  const { baseUrl, close } = await startApp();
  try {
    assert.deepEqual((await read(baseUrl)).hidden_modules, []);
  } finally {
    await close();
  }
});

test('ein Mitglied darf ausblenden - das ist der ganze Punkt', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const saved = await write(baseUrl, { hidden_modules: ['health', 'housekeeping'] });
    assert.equal(saved.status, 200, 'ein Mitglied wurde abgewiesen - dann ist #673 nicht gelöst');
    assert.deepEqual(saved.data.hidden_modules.sort(), ['health', 'housekeeping']);
    assert.deepEqual((await read(baseUrl)).hidden_modules.sort(), ['health', 'housekeeping']);
  } finally {
    await close();
  }
});

test('das Ausblenden bleibt beim Ausblendenden', async () => {
  const { baseUrl, close } = await startApp();
  try {
    await write(baseUrl, { hidden_modules: ['health'] });

    currentUserId = 2;
    assert.deepEqual((await read(baseUrl)).hidden_modules, [],
      'Nutzer 2 hat die Ausblendung von Nutzer 1 geerbt - dann wirkt sie haushaltweit');

    currentUserId = 1;
    assert.deepEqual((await read(baseUrl)).hidden_modules, ['health']);
  } finally {
    await close();
  }
});

test('unbekannte Slugs fallen heraus, Übersicht und Einstellungen sind nicht ausblendbar', async () => {
  const { baseUrl, close } = await startApp();
  try {
    // `dashboard` und `settings` stehen bewusst nicht in TOGGLEABLE_MODULES:
    // wer sie ausblendet, versteckt sich den Weg zurück zu diesem Schalter.
    const saved = await write(baseUrl, {
      hidden_modules: ['health', 'dashboard', 'settings', 'gibtsnicht', 'health'],
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.hidden_modules, ['health']);
  } finally {
    await close();
  }
});

test('kein Array -> 400, und nichts wird abgelegt', async () => {
  const { baseUrl, close } = await startApp();
  try {
    assert.equal((await write(baseUrl, { hidden_modules: 'health' })).status, 400);
    assert.equal(rawValue('hidden_modules:user:1'), null);
  } finally {
    await close();
  }
});

test('Ausblenden rührt den Haushalts-Schalter nicht an', async () => {
  const { baseUrl, close } = await startApp();
  try {
    currentRole = 'admin';
    await write(baseUrl, { disabled_modules: ['rewards'] });
    currentRole = 'member';

    await write(baseUrl, { hidden_modules: ['health'] });

    const data = await read(baseUrl);
    assert.deepEqual(data.disabled_modules, ['rewards'], 'der Haushaltswert hat sich mitbewegt');
    assert.deepEqual(data.hidden_modules, ['health']);
    assert.equal(rawValue('hidden_modules'), null,
      'die persönliche Ausblendung landete unter dem haushaltweiten Schlüssel');
  } finally {
    await close();
  }
});

test('der Haushalts-Schalter bleibt Adminsache', async () => {
  const { baseUrl, close } = await startApp();
  try {
    // Die Gegenprobe zur zweiten Zusicherung: dass ein Mitglied ausblenden darf,
    // heisst nicht, dass es abschalten darf.
    assert.equal((await write(baseUrl, { disabled_modules: ['health'] })).status, 403);
  } finally {
    await close();
  }
});
