/**
 * Modul: Budget-Konten (#495)
 * Zweck: CRUD für Konten, laufender Saldo (Startsaldo + zugeordnete Einträge),
 *        Nettovermögen, account_id-Verdrahtung (POST/PUT/Filter) und die
 *        Invariante beim Löschen: Einträge bleiben erhalten, account_id → NULL.
 * Ausführen: npm run test:budget-accounts
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'budget-accounts-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

const ADMIN_ID = seedUser();
// Eine garantiert gültige Kategorie je Typ ermitteln (Migrationen seeden Standardkategorien).
const EXPENSE_CAT = pickCategory('expense');
const INCOME_CAT = pickCategory('income');

test.after(() => suiteDatabase.close());

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(db, migration);
  return db;
}

function seedUser() {
  const info = suiteDatabase.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('admin', 'Admin', 'x', 'admin')
  `).run();
  return Number(info.lastInsertRowid);
}

function pickCategory(type) {
  const row = suiteDatabase.prepare(
    'SELECT key FROM budget_categories WHERE type = ? ORDER BY sort_order ASC LIMIT 1'
  ).get(type);
  assert.ok(row, `Standardkategorie für ${type} muss durch Migrationen existieren`);
  return row.key;
}

function createHarness({ userId = ADMIN_ID, role = 'admin' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = userId;
    req.authRole = role;
    req.session = { userId, role };
    next();
  });
  app.use('/api/v1/budget', budgetRouter);
  const server = http.createServer(app);
  return {
    async call(method, pathname, body) {
      if (!server.listening) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      }
      const base = `http://127.0.0.1:${server.address().port}/api/v1/budget`;
      const res = await fetch(`${base}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    close() {
      return new Promise((resolve) => (server.listening ? server.close(resolve) : resolve()));
    },
  };
}

function cleanup() {
  suiteDatabase.exec('DELETE FROM budget_entries; DELETE FROM budget_accounts;');
}

const PAST = '2020-06-15';        // zählt zum aktuellen Saldo (date <= heute)
const FUTURE = '2999-01-01';      // nur im projizierten Saldo

test('POST /accounts legt Konto an; Saldo = Startsaldo ohne Einträge', async () => {
  cleanup();
  const h = createHarness();
  try {
    const res = await h.call('POST', '/accounts', { name: 'Girokonto', type: 'checking', starting_balance: 1000 });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.name, 'Girokonto');
    assert.equal(res.body.data.type, 'checking');
    assert.equal(res.body.data.starting_balance, 1000);
    assert.equal(res.body.data.current_balance, 1000);
    assert.equal(res.body.data.projected_balance, 1000);
  } finally { await h.close(); }
});

test('laufender Saldo = Startsaldo + zugeordnete Einträge bis heute', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Konto', starting_balance: 100 })).body.data;
    // Einkommen +50 (heute-vergangen), Ausgabe -30 (vergangen), +200 (Zukunft, nur projiziert)
    await h.call('POST', '', { title: 'Lohn', amount: 50, category: INCOME_CAT, date: PAST, account_id: acc.id });
    await h.call('POST', '', { title: 'Kauf', amount: -30, category: EXPENSE_CAT, date: PAST, account_id: acc.id });
    await h.call('POST', '', { title: 'Zukunft', amount: 200, category: INCOME_CAT, date: FUTURE, account_id: acc.id });

    const list = (await h.call('GET', '/accounts')).body.data;
    const a = list.accounts.find((x) => x.id === acc.id);
    assert.equal(a.current_balance, 120);        // 100 + 50 - 30
    assert.equal(a.projected_balance, 320);      // + 200 Zukunft
    assert.equal(list.net_worth, 120);           // Nettovermögen = aktueller Saldo
  } finally { await h.close(); }
});

test('Nettovermögen summiert nur aktive Konten', async () => {
  cleanup();
  const h = createHarness();
  try {
    const a = (await h.call('POST', '/accounts', { name: 'A', starting_balance: 100 })).body.data;
    const b = (await h.call('POST', '/accounts', { name: 'B', starting_balance: 250 })).body.data;
    await h.call('PUT', `/accounts/${b.id}`, { archived: true });

    const res = (await h.call('GET', '/accounts')).body.data;
    assert.equal(res.accounts.length, 1, 'archivierte Konten sind standardmäßig ausgeblendet');
    assert.equal(res.net_worth, 100);

    const all = (await h.call('GET', '/accounts?include_archived=1')).body.data;
    assert.equal(all.accounts.length, 2);
    assert.equal(all.net_worth, 100, 'net_worth ignoriert archivierte auch bei include_archived');
    assert.ok(a && b);
  } finally { await h.close(); }
});

test('account_id-Filter in GET /budget', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Konto', starting_balance: 0 })).body.data;
    const month = PAST.slice(0, 7);
    await h.call('POST', '', { title: 'Mit Konto', amount: -10, category: EXPENSE_CAT, date: PAST, account_id: acc.id });
    await h.call('POST', '', { title: 'Ohne Konto', amount: -20, category: EXPENSE_CAT, date: PAST });

    const filtered = (await h.call('GET', `/?month=${month}&account_id=${acc.id}`)).body.data;
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].title, 'Mit Konto');
    assert.equal(filtered[0].account_id, acc.id);

    const all = (await h.call('GET', `/?month=${month}`)).body.data;
    assert.equal(all.length, 2);
  } finally { await h.close(); }
});

test('POST /budget: ungültige account_id → 400', async () => {
  cleanup();
  const h = createHarness();
  try {
    const res = await h.call('POST', '', { title: 'x', amount: -5, category: EXPENSE_CAT, date: PAST, account_id: 99999 });
    assert.equal(res.status, 400);
  } finally { await h.close(); }
});

test('PUT /budget/:id setzt und entfernt account_id', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Konto', starting_balance: 0 })).body.data;
    const entry = (await h.call('POST', '', { title: 'x', amount: -5, category: EXPENSE_CAT, date: PAST })).body.data;
    assert.equal(entry.account_id, null);

    const set = await h.call('PUT', `/${entry.id}`, { account_id: acc.id });
    assert.equal(set.body.data.account_id, acc.id);

    const cleared = await h.call('PUT', `/${entry.id}`, { account_id: null });
    assert.equal(cleared.body.data.account_id, null);

    // account_id nicht mitsenden ⇒ unverändert
    await h.call('PUT', `/${entry.id}`, { account_id: acc.id });
    const untouched = await h.call('PUT', `/${entry.id}`, { title: 'y' });
    assert.equal(untouched.body.data.account_id, acc.id);
  } finally { await h.close(); }
});

test('PUT /accounts/:id aktualisiert Felder', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Alt', type: 'checking', starting_balance: 10 })).body.data;
    const res = await h.call('PUT', `/accounts/${acc.id}`, { name: 'Neu', type: 'savings', starting_balance: 500 });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.name, 'Neu');
    assert.equal(res.body.data.type, 'savings');
    assert.equal(res.body.data.starting_balance, 500);
    assert.equal(res.body.data.current_balance, 500);
  } finally { await h.close(); }
});

test('DELETE /accounts/:id: Einträge bleiben erhalten, account_id → NULL', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Konto', starting_balance: 0 })).body.data;
    const entry = (await h.call('POST', '', { title: 'x', amount: -5, category: EXPENSE_CAT, date: PAST, account_id: acc.id })).body.data;

    const del = await h.call('DELETE', `/accounts/${acc.id}`);
    assert.equal(del.status, 204);

    const row = suiteDatabase.prepare('SELECT * FROM budget_entries WHERE id = ?').get(entry.id);
    assert.ok(row, 'Eintrag muss erhalten bleiben');
    assert.equal(row.account_id, null, 'Zuordnung muss geleert sein');

    const list = (await h.call('GET', '/accounts')).body.data;
    assert.equal(list.accounts.length, 0);
  } finally { await h.close(); }
});

test('POST /accounts validiert Name und Typ', async () => {
  cleanup();
  const h = createHarness();
  try {
    assert.equal((await h.call('POST', '/accounts', { name: '', type: 'checking' })).status, 400);
    assert.equal((await h.call('POST', '/accounts', { name: 'X', type: 'bogus' })).status, 400);
    // Negativer Startsaldo ist erlaubt (z. B. Kreditkarte)
    const credit = await h.call('POST', '/accounts', { name: 'Karte', type: 'credit', starting_balance: -300 });
    assert.equal(credit.status, 201);
    assert.equal(credit.body.data.current_balance, -300);
  } finally { await h.close(); }
});

test('color: gültiger HEX wird gespeichert, ungültiger abgelehnt', async () => {
  cleanup();
  const h = createHarness();
  try {
    const ok = await h.call('POST', '/accounts', { name: 'Farbig', color: '#2563EB' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.color, '#2563EB');
    // #542: Der Konto-Farbpicker speichert theme-aware Serien-Tokens statt Hex -
    // die müssen akzeptiert werden, sonst schlägt "Konto anlegen" mit Farbwahl fehl.
    const token = await h.call('POST', '/accounts', { name: 'Token', color: 'var(--chart-series-2)' });
    assert.equal(token.status, 201);
    assert.equal(token.body.data.color, 'var(--chart-series-2)');
    // PUT akzeptiert das Token ebenfalls
    const tokenPut = await h.call('PUT', `/accounts/${ok.body.data.id}`, { color: 'var(--chart-series-5)' });
    assert.equal(tokenPut.body.data.color, 'var(--chart-series-5)');
    // Ungültige Farbe (kein #RRGGBB) → 400
    assert.equal((await h.call('POST', '/accounts', { name: 'X', color: 'blau' })).status, 400);
    // Beliebiger CSS-Ausdruck bleibt abgelehnt (Allowlist ist eng, kein style-Injection)
    assert.equal((await h.call('POST', '/accounts', { name: 'Y', color: 'var(--x); background:url(evil)' })).status, 400);
    assert.equal((await h.call('POST', '/accounts', { name: 'Z', color: 'var(--module-accent)' })).status, 400);
    // Farbe entfernen (leerer Wert → NULL)
    const cleared = await h.call('PUT', `/accounts/${ok.body.data.id}`, { color: '' });
    assert.equal(cleared.body.data.color, null);
  } finally { await h.close(); }
});

test('archived: PUT toggelt, include_archived steuert Sichtbarkeit, net_worth ignoriert archivierte', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Alt', starting_balance: 400 })).body.data;
    await h.call('PUT', `/accounts/${acc.id}`, { archived: true });

    const active = (await h.call('GET', '/accounts')).body.data;
    assert.equal(active.accounts.length, 0, 'archiviert ⇒ standardmäßig unsichtbar');
    assert.equal(active.net_worth, 0);

    const withArchived = (await h.call('GET', '/accounts?include_archived=1')).body.data;
    assert.equal(withArchived.accounts.length, 1);
    assert.equal(withArchived.accounts[0].archived, 1);

    // Wiederherstellen
    await h.call('PUT', `/accounts/${acc.id}`, { archived: false });
    const restored = (await h.call('GET', '/accounts')).body.data;
    assert.equal(restored.accounts.length, 1);
    assert.equal(restored.net_worth, 400);
  } finally { await h.close(); }
});

test('Kreditkarte: Bank und Kreditrahmen werden gespeichert und wieder geliefert (#541)', async () => {
  cleanup();
  const h = createHarness();
  try {
    const res = await h.call('POST', '/accounts', {
      name: 'Visa', type: 'credit', starting_balance: 0, credit_bank: 'Musterbank', credit_limit: 2000,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.credit_bank, 'Musterbank');
    assert.equal(res.body.data.credit_limit, 2000);

    const updated = await h.call('PUT', `/accounts/${res.body.data.id}`, { credit_bank: 'Andere Bank', credit_limit: 3500 });
    assert.equal(updated.body.data.credit_bank, 'Andere Bank');
    assert.equal(updated.body.data.credit_limit, 3500);

    // Leerer String löscht, undefined lässt unangetastet: ein Teil-Update darf
    // Bank und Rahmen nicht nebenbei verwerfen.
    const cleared = await h.call('PUT', `/accounts/${res.body.data.id}`, { credit_bank: '', credit_limit: '' });
    assert.equal(cleared.body.data.credit_bank, null);
    assert.equal(cleared.body.data.credit_limit, null);

    await h.call('PUT', `/accounts/${res.body.data.id}`, { credit_limit: 1000 });
    const renamed = await h.call('PUT', `/accounts/${res.body.data.id}`, { name: 'Visa Gold' });
    assert.equal(renamed.body.data.credit_limit, 1000, 'Namensänderung darf den Rahmen nicht löschen');
  } finally { await h.close(); }
});

test('available_limit: nur bei Kreditkarte mit Rahmen, Schuld zieht ab, Guthaben vergrößert nicht (#541)', async () => {
  cleanup();
  const h = createHarness();
  try {
    const card = (await h.call('POST', '/accounts', {
      name: 'Visa', type: 'credit', starting_balance: 0, credit_limit: 1000,
    })).body.data;
    assert.equal(card.available_limit, 1000, 'ohne Buchungen steht der volle Rahmen');

    await h.call('POST', '', { title: 'Einkauf', amount: -250, category: EXPENSE_CAT, date: PAST, account_id: card.id });
    const charged = (await h.call('GET', '/accounts')).body.data.accounts[0];
    assert.equal(charged.current_balance, -250);
    assert.equal(charged.available_limit, 750);

    // Guthaben auf der Karte hebt den Rahmen nicht an.
    await h.call('POST', '', { title: 'Gutschrift', amount: 400, category: INCOME_CAT, date: PAST, account_id: card.id });
    const inCredit = (await h.call('GET', '/accounts')).body.data.accounts[0];
    assert.equal(inCredit.current_balance, 150);
    assert.equal(inCredit.available_limit, 1000);

    // Ohne Rahmen und bei jedem anderen Kontotyp bleibt das Feld null.
    cleanup();
    await h.call('POST', '/accounts', { name: 'Ohne Rahmen', type: 'credit', starting_balance: 0 });
    await h.call('POST', '/accounts', { name: 'Giro', type: 'checking', starting_balance: 500, credit_limit: 9000 });
    const rest = (await h.call('GET', '/accounts')).body.data.accounts;
    assert.equal(rest.find((a) => a.name === 'Ohne Rahmen').available_limit, null);
    assert.equal(rest.find((a) => a.name === 'Giro').available_limit, null, 'kein Kreditkonto ⇒ kein Rahmen');
  } finally { await h.close(); }
});

test('POST/PUT /accounts weisen einen negativen Kreditrahmen ab (#541)', async () => {
  cleanup();
  const h = createHarness();
  try {
    const bad = await h.call('POST', '/accounts', { name: 'Visa', type: 'credit', credit_limit: -100 });
    assert.equal(bad.status, 400);

    const ok = (await h.call('POST', '/accounts', { name: 'Visa', type: 'credit', credit_limit: 500 })).body.data;
    const badUpdate = await h.call('PUT', `/accounts/${ok.id}`, { credit_limit: -1 });
    assert.equal(badUpdate.status, 400);

    const unchanged = (await h.call('GET', '/accounts')).body.data.accounts[0];
    assert.equal(unchanged.credit_limit, 500, 'abgewiesenes Update darf nichts verändern');
  } finally { await h.close(); }
});

// Critique R23 (Rest aus S4, Sicherheitspruefung): ein Konto zu loeschen nimmt
// seinen Buchungen die Zuordnung. Im personal-Modus kann daran eine private
// Buchung eines anderen Mitglieds haengen, die der Loeschende weder sieht noch
// zaehlt - der Server nahm ihr still Konto und Saldo. Jede eigene Antwort darauf
// (409, ein Feld in der Liste) waere ein Orakel. Jetzt loest der Loeschende nur,
// was er sieht; der Rest haelt das Konto als Huelle, die nur der Besitzer sieht
// (archiviert), und fuer den Loeschenden ist alles wie bei einem echten Loeschen.
test('DELETE /accounts/:id: fremde private Buchungen behalten ihr Konto, und der Loeschende merkt nichts (personal)', async () => {
  cleanup();
  const setMode = (mode) => suiteDatabase.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(mode);
  const otherId = Number(suiteDatabase.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('member-b', 'B', 'x', 'member')
  `).run().lastInsertRowid);
  setMode('personal');
  const a = createHarness();
  const b = createHarness({ userId: otherId, role: 'member' });
  const listA = async () => (await a.call('GET', '/accounts?include_archived=1')).body.data;
  try {
    const plain = (await a.call('POST', '/accounts', { name: 'Leer', starting_balance: 0 })).body.data;
    const shared = (await a.call('POST', '/accounts', { name: 'Gemeinsam', starting_balance: 0 })).body.data;
    const foreign = await b.call('POST', '', {
      title: 'Privat B', amount: -40, category: EXPENSE_CAT, date: PAST, account_id: shared.id, visibility: 'private',
    });
    assert.equal(foreign.status, 201, JSON.stringify(foreign.body));
    // Zeitstempel gehoeren nicht zum Vergleich: die beiden Konten entstehen
    // nacheinander, und faellt eine Sekundengrenze dazwischen, unterschieden
    // sie sich nur darin (CI-Flake an #2208). Verglichen wird, was eine fremde
    // private Buchung verraten koennte - Salden, Zaehler, Rahmen.
    const strip = ({ id, name, sort_order, created_at, updated_at, ...rest }) => rest;
    assert.deepEqual(strip((await listA()).accounts.find((x) => x.id === shared.id)),
      strip((await listA()).accounts.find((x) => x.id === plain.id)), 'vorher: beide Konten sehen fuer A gleich aus');

    const delPlain = await a.call('DELETE', `/accounts/${plain.id}`);
    const delShared = await a.call('DELETE', `/accounts/${shared.id}`);
    assert.deepEqual(delShared, delPlain, 'gleicher Status, gleicher Body');
    assert.equal(delShared.status, 204);
    const after = await listA();
    assert.deepEqual(after.accounts, [], 'fuer A sind beide weg');
    assert.equal(after.net_worth, 0);

    // Auch danach antwortet die Huelle A wie ein geloeschtes Konto.
    assert.deepEqual(await a.call('PUT', `/accounts/${shared.id}`, { name: 'x' }), await a.call('PUT', `/accounts/${plain.id}`, { name: 'x' }));
    assert.deepEqual(await a.call('DELETE', `/accounts/${shared.id}`), await a.call('DELETE', `/accounts/${plain.id}`));
    const viaEntry = (accountId) => a.call('POST', '', { title: 'y', amount: -1, category: EXPENSE_CAT, date: PAST, account_id: accountId });
    assert.deepEqual(await viaEntry(shared.id), await viaEntry(plain.id), 'als Kontowahl einer Buchung: nicht gefunden');

    // Die fremde Buchung behaelt ihr Konto, ihr Besitzer sieht es archiviert.
    const row = suiteDatabase.prepare('SELECT account_id FROM budget_entries WHERE id = ?').get(foreign.body.data.id);
    assert.equal(row.account_id, shared.id, 'die fremde Buchung behaelt ihr Konto');
    const seenByB = (await b.call('GET', '/accounts?include_archived=1')).body.data.accounts;
    assert.deepEqual(seenByB.map((x) => [x.id, x.archived, x.entry_count, x.current_balance]), [[shared.id, 1, 1, -40]]);
    assert.equal((await b.call('GET', '/accounts')).body.data.accounts.length, 0, 'in der aktiven Liste steht es nicht');

    // Die Huelle verraet sich auch nicht ueber die Position des naechsten Kontos:
    // nach zwei echten Loeschungen begaenne die Reihe wieder bei 0.
    const next = (await a.call('POST', '/accounts', { name: 'Neu', starting_balance: 0 })).body.data;
    assert.equal(next.sort_order, 0, 'die Huelle zaehlt bei der Position nicht mit');
    assert.equal((await a.call('DELETE', `/accounts/${next.id}`)).status, 204);

    // Auch ihr Rest-Besitzer holt sie nicht ins Aktive zurueck - A saehe sonst
    // das geloeschte Konto wieder.
    assert.equal((await b.call('PUT', `/accounts/${shared.id}`, { archived: false, name: 'Wieder da' })).status, 200);
    assert.deepEqual((await listA()).accounts, [], 'fuer A bleibt es weg');
    assert.equal(suiteDatabase.prepare('SELECT archived FROM budget_accounts WHERE id = ?').get(shared.id).archived, 2);

    // Loescht B es, ist nichts Fremdes mehr daran: echt geloescht.
    assert.equal((await b.call('DELETE', `/accounts/${shared.id}`)).status, 204);
    assert.equal(suiteDatabase.prepare('SELECT 1 FROM budget_accounts WHERE id = ?').get(shared.id), undefined);
  } finally {
    setMode('shared');
    await a.close();
    await b.close();
  }
});
