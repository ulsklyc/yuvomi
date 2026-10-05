/**
 * Modul: Setup - optionale Sprache und Zeitzone beim Ersteinrichten
 * Zweck: `POST /api/v1/auth/setup` nimmt `language` und `timezone` ADDITIV an.
 *        Die Route ist zugesagte `/api/v1`-Oberflaeche, deshalb prueft diese
 *        Suite beide Richtungen: was die neuen Felder bewirken, und dass ein
 *        Body ohne sie exakt das alte Ergebnis liefert.
 *
 * Warum `language` nur schreibt, wenn die Automatik etwas anderes ergaebe:
 * ein explizites `en` ueberstimmte eine spaetere Regionswahl, die die
 * Datensprache heute noch mitzieht (siehe resolveHouseholdLocale). Ein Setup
 * auf Englisch muss deshalb denselben Zustand hinterlassen wie eines ohne Feld.
 *
 * Unbekannte Felder: der Web-Installer schickt die neuen Felder auch an aeltere
 * Images. Das geht nur, solange die Route fremde Felder ignoriert statt sie
 * abzuweisen - der letzte Fall haelt genau das fest.
 *
 * Ein Server je Prozess (der Import startet ihn), deshalb setzt `resetUsers()`
 * die Datenbank zwischen den Faellen auf "noch niemand eingerichtet" zurueck.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'setup-language',
  // Die Ablehnungsfaelle zaehlen gegen den Login-Limiter (5 je Minute).
  env: { SESSION_SECRET: 'test-setup-language-secret-32-chars-min', RATE_LIMIT_MAX_ATTEMPTS: '1000' },
});
const db = await import('../server/db.js');
const { todayKey, configuredHouseholdTimeZone } = await import('../server/utils/timezone.js');

const BASE_BODY = { username: 'admin', display_name: 'Admin', password: 'password123' };

async function setup(extra = {}) {
  return fetch(`${BASE}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...BASE_BODY, ...extra }),
  });
}

function cfg(key) {
  return db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value ?? null;
}

function userCount() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/** Zurueck auf "noch niemand eingerichtet": Nutzer samt Haushaltswerten weg. */
function resetUsers() {
  const conn = db.get();
  conn.pragma('foreign_keys = OFF');
  try {
    conn.prepare('DELETE FROM users').run();
    conn.prepare("DELETE FROM sync_config WHERE key IN ('language', 'household_timezone', 'region')").run();
  } finally {
    conn.pragma('foreign_keys = ON');
  }
  assert.equal(userCount(), 0);
}

test('unsupported language: 400 with the usual error shape, nothing created', async () => {
  const res = await setup({ language: 'xx' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 400);
  assert.match(body.error, /language/i);
  assert.equal(Object.hasOwn(body, 'reason'), false, 'only the time zone rejection carries the anchor');
  assert.equal(userCount(), 0);
  assert.equal(cfg('language'), null);
});

test('language of the wrong type or form: 400', async () => {
  for (const language of [123, ['de'], { code: 'de' }, 'DE', 'de-DE', ' de']) {
    const res = await setup({ language });
    assert.equal(res.status, 400, `language ${JSON.stringify(language)} must be rejected`);
  }
  assert.equal(userCount(), 0);
});

test('unknown time zone: 400, nothing created', async () => {
  for (const timezone of ['Mars/Olympus', 42, '   ']) {
    const res = await setup({ language: 'de', timezone });
    assert.equal(res.status, 400, `timezone ${JSON.stringify(timezone)} must be rejected`);
    const body = await res.json();
    assert.equal(body.code, 400);
    assert.match(body.error, /time zone/i);
    // Der Anker, an dem die Setup-Seite ihre eine Wiederholung ohne Zone
    // festmacht - additiv, `error` und `code` bleiben wie sie waren.
    assert.equal(body.reason, 'invalid_timezone');
  }
  assert.equal(userCount(), 0);
  assert.equal(cfg('language'), null);
  assert.equal(cfg('household_timezone'), null);
});

test('language + timezone: set the household data language and zone', async () => {
  const res = await setup({ language: 'de', timezone: 'Europe/Berlin' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).user.role, 'admin');
  assert.equal(cfg('language'), 'de');
  assert.equal(cfg('household_timezone'), 'Europe/Berlin');
  // Region, Waehrung und Datumsformat werden NICHT aus der Sprache geraten.
  assert.equal(cfg('region'), null);
  assert.equal(cfg('currency'), null);
  assert.equal(cfg('date_format'), null);
});

test('timezone: the server day follows the zone the setup sent (#1607)', async () => {
  // 18:30 UTC am 1. ist in Seoul 03:30 am 2. Ohne Haushaltszone liest der
  // Server den Tag in der Zone des Containers, mit ihr in der des Haushalts -
  // das ist der Unterschied zwischen "Essen heute" leer und gefuellt.
  const at = new Date('2026-10-01T18:30:00Z');
  resetUsers();
  assert.equal((await setup()).status, 201);
  assert.equal(configuredHouseholdTimeZone(db.get()), null);
  const before = todayKey(db.get(), at);

  resetUsers();
  assert.equal((await setup({ timezone: 'Asia/Seoul' })).status, 201);
  assert.equal(configuredHouseholdTimeZone(db.get()), 'Asia/Seoul');
  assert.equal(todayKey(db.get(), at), '2026-10-02');

  resetUsers();
  assert.equal((await setup({ timezone: 'Pacific/Honolulu' })).status, 201);
  assert.equal(todayKey(db.get(), at), '2026-10-01');
  // Ohne Zone haengt die Antwort an der Maschine - nur festhalten, dass sie
  // einer der beiden Tage ist, die es um diese Zeit auf der Erde gibt.
  assert.ok(['2026-10-01', '2026-10-02'].includes(before));
});

test('a language with a subtag-free three-letter code is accepted (fil)', async () => {
  resetUsers();
  const res = await setup({ language: 'fil' });
  assert.equal(res.status, 201);
  assert.equal(cfg('language'), 'fil');
  assert.equal(cfg('household_timezone'), null);
});

test('language en: no explicit data language, same state as without the field', async () => {
  resetUsers();
  const res = await setup({ language: 'en' });
  assert.equal(res.status, 201);
  assert.equal(cfg('language'), null, 'an explicit en would override a later region choice');
});

test('without the new fields (and with null/empty): behaviour as before', async () => {
  for (const extra of [{}, { language: null, timezone: null }, { language: '', timezone: '' }]) {
    resetUsers();
    const res = await setup(extra);
    assert.equal(res.status, 201, `body extra ${JSON.stringify(extra)}`);
    assert.equal(cfg('language'), null);
    assert.equal(cfg('household_timezone'), null);
  }
});

test('unknown body fields are ignored, not rejected', async () => {
  resetUsers();
  const res = await setup({ some_future_field: 'x', region: 'de-DE', currency: 'CHF' });
  assert.equal(res.status, 201);
  // Ignoriert heisst auch: nicht still als Haushaltswert uebernommen.
  assert.equal(cfg('region'), null);
  assert.equal(cfg('currency'), null);
});
