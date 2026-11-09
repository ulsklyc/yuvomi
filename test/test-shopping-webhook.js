/**
 * Test: Die offenen Artikel einer Liste an einen Webhook (#2502)
 * Zweck: Der Weg nach draussen hatte keine einzige Probe. Festgenagelt wird -
 *        - die Adresse ist admin-only im SCHREIBEN (PUT /preferences -> 403)
 *          und im LESEN (GET gibt sie nur der Adminperson, allen anderen das
 *          Flag `shopping_webhook_configured`): eine Webhook-Adresse ist oft
 *          selbst der Zugang
 *        - sie wird validiert: keine Adresse, ein anderes Schema -> 400
 *        - `null`/`''` loescht sie
 *        - die Absagen der Route mit ihren Gruenden:
 *          `shopping_webhook_unconfigured`, `nothing_open` und
 *          `shopping_webhook_private_network`
 *        - die Form der Nutzlast: { list: {id,name}, items: [...], sentAt },
 *          und dass nur die OFFENEN Artikel darin stehen
 *        - der SSRF-Schutz greift wirklich: ein Ziel im eigenen Netz wird ohne
 *          NOTIFICATION_ALLOW_PRIVATE_NETWORK abgewiesen - gegen den echten
 *          Guard, nicht gegen einen eingesetzten Lookup
 * Ausführen: npm run test:shopping-webhook
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'shopping-webhook-test-secret';
process.env.DB_PATH = ':memory:';
// Der Guard liest zur Laufzeit; der Default dieser Probe ist AUS.
delete process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK;

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');
const db = dbmod.get();

const ADMIN = db.prepare(
  "INSERT INTO users (username, display_name, password_hash, avatar_color, role) VALUES ('a','Admin','x','#FF3B30','admin')",
).run().lastInsertRowid;
const MEMBER = db.prepare(
  "INSERT INTO users (username, display_name, password_hash, avatar_color, role) VALUES ('m','Member','x','#34C759','member')",
).run().lastInsertRowid;

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
app.use('/api/v1/shopping', shoppingRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

/** Das Ziel des Webhooks: ein echter Server, der mitschreibt, was ankommt. */
const received = [];
const target = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ method: req.method, contentType: req.headers['content-type'], body });
    res.writeHead(200).end('ok');
  });
});
await new Promise((r) => target.listen(0, '127.0.0.1', r));
const targetUrl = `http://127.0.0.1:${target.address().port}/hook`;

test.after(() => { server.close(); target.close(); });

const asAdmin  = { id: ADMIN,  role: 'admin' };
const asMember = { id: MEMBER, role: 'member' };

async function call(method, path, { as, body } = {}) {
  if (as) actor = as;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const setUrl = (value, as = asAdmin) =>
  call('PUT', '/api/v1/preferences', { as, body: { shopping_webhook_url: value } });

/** Eine Liste mit den angegebenen Artikeln; `checked` kommt abgehakt hinein. */
function seedList(name, items) {
  const listId = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)').run(name, ADMIN).lastInsertRowid;
  for (const [i, item] of items.entries()) {
    db.prepare(`
      INSERT INTO shopping_items (list_id, name, quantity, category, is_checked, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(listId, item.name, item.quantity ?? null, item.category ?? 'Sonstiges',
      item.checked ? 1 : 0, i);
  }
  return listId;
}

// --------------------------------------------------------
// Die Adresse: wer sie setzen und wer sie sehen darf
// --------------------------------------------------------

test('PUT /preferences: ein Mitglied darf die Webhook-Adresse nicht setzen', async () => {
  const r = await setUrl('https://example.com/hook', asMember);
  assert.equal(r.status, 403);
  const after = await call('GET', '/api/v1/preferences', { as: asAdmin });
  assert.equal(after.body.data.shopping_webhook_url, null, 'der abgewiesene PUT hat nichts geschrieben');
});

test('GET /preferences: nur die Adminperson bekommt die Adresse, das Mitglied das Flag', async () => {
  await setUrl('https://example.com/hook', asAdmin);

  const admin = await call('GET', '/api/v1/preferences', { as: asAdmin });
  assert.equal(admin.body.data.shopping_webhook_url, 'https://example.com/hook');
  assert.equal(admin.body.data.shopping_webhook_configured, true);

  const member = await call('GET', '/api/v1/preferences', { as: asMember });
  // DAS IST DER PUNKT: eine Webhook-Adresse ist oft selbst das Geheimnis.
  assert.ok(!('shopping_webhook_url' in member.body.data),
    'das Mitglied darf die Adresse nicht bekommen - sie traegt oft Webhook-Id oder Token');
  assert.equal(member.body.data.shopping_webhook_configured, true,
    'die Tatsache bekommt es: nur daran haengt der Menuepunkt der Liste');
});

test('PUT /preferences: ungueltige Adressen werden abgewiesen', async () => {
  await setUrl('https://example.com/hook', asAdmin);
  for (const invalid of ['keine-adresse', 'ftp://example.com/hook', 'javascript:alert(1)']) {
    const r = await setUrl(invalid, asAdmin);
    assert.equal(r.status, 400, `${invalid} muss 400 sein`);
  }
  const after = await call('GET', '/api/v1/preferences', { as: asAdmin });
  assert.equal(after.body.data.shopping_webhook_url, 'https://example.com/hook', 'unveraendert');
});

test('PUT /preferences: die abgewiesene Adresse nennt ihren Grund (#1909)', async () => {
  // DER SERVER BENENNT DEN FALL, DIE APP BESITZT DEN SATZ. Ohne `reason` bliebe
  // der Oberflaeche nur der Allgemeinsatz - und den Text des Servers zu zeigen
  // verbietet test:frontend-audit (die Seite steht dort auf 0). Der Grund hat
  // in CASE_MESSAGES (utils/friendly-error.js) seinen Schluessel.
  const r = await setUrl('keine-adresse', asAdmin);
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'shopping_webhook_url_invalid');

  const { readFileSync } = await import('node:fs');
  const map = readFileSync('public/utils/friendly-error.js', 'utf8');
  assert.match(map, /\['shopping_webhook_url_invalid',\s*'settings\.shoppingWebhookUrlInvalid'\]/,
    'der Grund braucht seinen Satz in CASE_MESSAGES, sonst zeigt die Seite den Allgemeinsatz');

  const locale = JSON.parse(readFileSync('public/locales/en.json', 'utf8'));
  assert.ok(locale.settings.shoppingWebhookUrlInvalid, 'und den Schluessel in den Sprachdateien');
});

test('PUT /preferences: null und der leere String loeschen die Adresse', async () => {
  for (const clearing of [null, '']) {
    await setUrl('https://example.com/hook', asAdmin);
    const r = await setUrl(clearing, asAdmin);
    assert.equal(r.status, 200);
    const after = await call('GET', '/api/v1/preferences', { as: asAdmin });
    assert.equal(after.body.data.shopping_webhook_url, null,
      `${JSON.stringify(clearing)} loescht die Adresse, und GET antwortet null (nicht '')`);
    assert.equal(after.body.data.shopping_webhook_configured, false);
  }
});

// --------------------------------------------------------
// Die Absagen der Route
// --------------------------------------------------------

test('POST send-webhook: ohne eingerichtete Adresse 422 shopping_webhook_unconfigured', async () => {
  await setUrl(null, asAdmin);
  const listId = seedList('ohne Ziel', [{ name: 'Milch' }]);
  const r = await call('POST', `/api/v1/shopping/${listId}/send-webhook`, { as: asMember, body: {} });
  assert.equal(r.status, 422);
  assert.equal(r.body.reason, 'shopping_webhook_unconfigured');
});

test('POST send-webhook: ohne offene Artikel 422 nothing_open', async () => {
  process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK = 'true';
  try {
    await setUrl(targetUrl, asAdmin);
    const listId = seedList('alles abgehakt', [{ name: 'Milch', checked: true }]);
    const r = await call('POST', `/api/v1/shopping/${listId}/send-webhook`, { as: asMember, body: {} });
    assert.equal(r.status, 422);
    assert.equal(r.body.reason, 'nothing_open');
  } finally {
    delete process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK;
  }
});

test('POST send-webhook: eine unbekannte Liste ist 404', async () => {
  await setUrl(targetUrl, asAdmin);
  const r = await call('POST', '/api/v1/shopping/999999/send-webhook', { as: asMember, body: {} });
  assert.equal(r.status, 404);
  assert.equal(r.body.reason, 'shopping_list_not_found');
});

// --------------------------------------------------------
// Der SSRF-Schutz
// --------------------------------------------------------

test('POST send-webhook: ein Ziel im eigenen Netz wird abgewiesen, mit eigenem Grund', async () => {
  // GEGEN DEN ECHTEN GUARD, nicht gegen einen eingesetzten Lookup: die Route
  // ruft guardedFetch ohne `lookup`, also entscheidet createGuardedLookup -
  // und 127.0.0.1 ist eine blockierte Adresse (utils/ssrf.js).
  assert.equal(process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK, undefined,
    'die Vorbedingung dieser Probe: der Schalter ist AUS');
  await setUrl(targetUrl, asAdmin);
  const listId = seedList('LAN-Ziel', [{ name: 'Milch' }]);

  const before = received.length;
  const r = await call('POST', `/api/v1/shopping/${listId}/send-webhook`, { as: asMember, body: {} });
  assert.equal(r.status, 422);
  assert.equal(r.body.reason, 'shopping_webhook_private_network',
    'der haeufigste Fall braucht seinen eigenen Grund - als 502 "nicht erreichbar" '
    + 'sucht der Admin den Fehler beim Ziel');
  assert.equal(received.length, before, 'und es wurde nichts gesendet');
});

test('POST send-webhook: mit dem Opt-in geht derselbe Aufruf durch', async () => {
  // Die Gegenprobe zum Test darueber: ohne sie saehe eine Route, die das Ziel
  // aus einem anderen Grund nie erreicht, genauso aus.
  process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK = 'true';
  try {
    await setUrl(targetUrl, asAdmin);
    const listId = seedList('LAN-Ziel erlaubt', [{ name: 'Milch' }]);
    const r = await call('POST', `/api/v1/shopping/${listId}/send-webhook`, { as: asMember, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.sent, true);
  } finally {
    delete process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK;
  }
});

// --------------------------------------------------------
// Die Nutzlast
// --------------------------------------------------------

test('POST send-webhook: die Nutzlast traegt nur die offenen Artikel, in der Form der Doku', async () => {
  process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK = 'true';
  try {
    await setUrl(targetUrl, asAdmin);
    const listId = seedList('Wocheneinkauf', [
      { name: 'Milch', quantity: '2 l', category: 'Molkerei' },
      { name: 'Brot', quantity: null, category: 'Backwaren', checked: true },
      { name: 'Apfel', quantity: '6 Stk', category: 'Obst' },
    ]);

    const before = received.length;
    const r = await call('POST', `/api/v1/shopping/${listId}/send-webhook`, { as: asMember, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.items, 2, 'gezaehlt werden die gesendeten, nicht alle Artikel');
    assert.equal(received.length, before + 1, 'genau eine Anfrage am Ziel');

    const got = received.at(-1);
    assert.equal(got.method, 'POST');
    assert.match(got.contentType, /application\/json/);

    const payload = JSON.parse(got.body);
    assert.deepEqual(payload.list, { id: listId, name: 'Wocheneinkauf' });
    assert.deepEqual(payload.items, [
      { name: 'Milch', quantity: '2 l', category: 'Molkerei' },
      { name: 'Apfel', quantity: '6 Stk', category: 'Obst' },
    ], 'das abgehakte Brot steht NICHT darin, und jeder Artikel traegt genau die drei Felder');
    assert.match(payload.sentAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'sentAt ist ein ISO-Zeitpunkt');
  } finally {
    delete process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK;
  }
});

test('der Aufruf traegt ein Zeitlimit', async () => {
  // Nicht gegen die Uhr geprueft: PROVIDER_TIMEOUT_MS sind 8 Sekunden, und ein
  // Test, der die abwartet, ist seine Laufzeit nicht wert. Geprueft wird, DASS
  // ein Signal mitgeht - `safeRequest` bringt von sich aus keines mit, ein
  // stummes Ziel haelt den Request sonst offen.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('server/routes/shopping.js', 'utf8');
  const callSite = source.match(/const response = await guardedFetch\(webhookUrl, \{[\s\S]*?\}\);/)?.[0];
  assert.ok(callSite, 'der guardedFetch-Aufruf der Webhook-Route wurde nicht gefunden');
  assert.match(callSite, /signal:\s*AbortSignal\.timeout\(PROVIDER_TIMEOUT_MS\)/,
    'der Aufruf braucht ein Zeitlimit, und zwar dasselbe wie die Benachrichtigungswege');
});
