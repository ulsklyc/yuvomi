/**
 * Modul: Idempotenz der öffentlichen API (#822)
 * Zweck: End-to-End über die echte Middleware vor dem echten Tasks-Router -
 *        wiederholter POST mit demselben `Idempotency-Key` legt genau einmal
 *        an, gibt beim zweiten Mal die erste Antwort zurück, und meldet einen
 *        Schlüssel, der für zwei verschiedene Anfragen benutzt wurde, als
 *        Konflikt. Dazu die Ränder: Ablauf, laufender Vorgang, abgebrochener
 *        Vorgang, Fehlschläge, fremder Akteur, Schlüsselreihenfolge im Rumpf.
 * Ausführen: npm run test:idempotency
 *
 * WORUM ES GEHT: geht die Antwort auf einen POST unterwegs verloren, weiß der
 * Aufrufer nicht, ob angelegt wurde. Genau dieser Fall - dieselbe Anfrage ein
 * zweites Mal - ist hier der Normalfall und nicht der Ausnahmezweig.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'idempotency-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: idempotencyMiddleware, canonicalize, fingerprint } = await import('../server/middleware/idempotency.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

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

const ALICE = seedUser('alice', 'admin');
const BOB   = seedUser('bob', 'admin');

let actor = { id: ALICE, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
// Genau die Reihenfolge aus server/index.js: die Middleware sieht den Pfad
// relativ zu ihrem eigenen Mount, der Router hängt eine Ebene tiefer.
app.use('/api/v1', idempotencyMiddleware);
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;

test.after(() => { server.close(); db.close(); });

async function call(method, path, { as, body, key, headers = {} } = {}) {
  if (as) actor = as;
  const hdrs = { ...headers };
  if (body !== undefined) hdrs['Content-Type'] = 'application/json';
  if (key !== undefined) hdrs['Idempotency-Key'] = key;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: Object.keys(hdrs).length ? hdrs : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    replayed: res.headers.get('idempotent-replayed'),
  };
}

const countTasks = (title) =>
  db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE title = ?').get(title).n;

// --------------------------------------------------------
// Der Fall aus dem Issue
// --------------------------------------------------------

test('derselbe Schlüssel mit derselben Nutzlast legt genau einmal an', async () => {
  const key = randomUUID();
  const body = { title: 'Muell rausbringen', priority: 'high' };

  const first = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body, key });
  const second = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body, key });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201, 'die Wiederholung behält den Status des ersten Versuchs');
  assert.equal(second.body.data.id, first.body.data.id, 'sie muss dieselbe Aufgabe zurückgeben');
  assert.deepEqual(second.body, first.body, 'und zwar dieselbe Antwort, nicht nur dieselbe id');
  assert.equal(second.replayed, 'true', 'die Wiedergabe muss als solche erkennbar sein');
  assert.equal(first.replayed, null, 'der erste Versuch ist keine Wiedergabe');
  assert.equal(countTasks('Muell rausbringen'), 1, 'zwei Versuche, eine Aufgabe');
});

test('der Schlüssel überlebt in der Datenbank, nicht im Prozessspeicher', async () => {
  const key = randomUUID();
  await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Dauerhaft' }, key });

  const row = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(key);
  assert.ok(row, 'der Vorgang muss festgehalten sein');
  assert.equal(row.user_id, ALICE);
  assert.equal(row.method, 'POST');
  assert.equal(row.path, '/tasks/');
  assert.equal(row.status, 201);
  assert.ok(row.completed_at, 'ein abgeschlossener Vorgang trägt seinen Abschluss');
  assert.equal(JSON.parse(row.response_body).data.title, 'Dauerhaft');
});

test('derselbe Schlüssel mit anderer Nutzlast ist ein Konflikt', async () => {
  const key = randomUUID();
  await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Erste' }, key });
  const clash = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Zweite' }, key });

  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /different request/i);
  assert.equal(clash.body.reason, 'idempotency_key_reused');
  assert.equal(countTasks('Zweite'), 0, 'die abweichende Anfrage darf nicht durchlaufen');
});

test('die Reihenfolge der Felder im Rumpf ist kein Unterschied', async () => {
  // Ein Aufrufer, der sein Objekt beim Retry neu zusammensetzt, schickt
  // dieselbe Anfrage - nur womöglich mit anderer Schlüsselreihenfolge. Ein
  // Fingerabdruck über die rohe Zeichenkette würde ihm dafür einen Konflikt
  // geben, und zwar ausgerechnet im Wiederholungsfall.
  const key = randomUUID();
  const first  = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Sortiert', priority: 'low', points: 3 }, key });
  const second = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { points: 3, title: 'Sortiert', priority: 'low' }, key });

  assert.equal(second.status, 201);
  assert.equal(second.body.data.id, first.body.data.id);
  assert.equal(countTasks('Sortiert'), 1);
});

test('canonicalize: gleiche Daten, gleiche Zeichenkette', () => {
  assert.equal(canonicalize({ a: 1, b: [2, { d: 4, c: 3 }] }), canonicalize({ b: [2, { c: 3, d: 4 }], a: 1 }));
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: '1' }), 'Typen bleiben unterscheidbar');
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]), 'die Reihenfolge einer Liste ist Inhalt');
  assert.equal(canonicalize(null), 'null');
  assert.equal(canonicalize(undefined), 'null');
});

// --------------------------------------------------------
// Ränder
// --------------------------------------------------------

test('ohne Schlüssel bleibt alles wie vorher', async () => {
  const body = { title: 'Ohne Schluessel' };
  const first  = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body });
  const second = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(second.body.data.id, first.body.data.id);
  assert.equal(countTasks('Ohne Schluessel'), 2, 'ohne Zusage keine Zusammenfassung');
});

test('derselbe Schlüssel bei zwei Konten sind zwei Vorgänge', async () => {
  const key = randomUUID();
  const body = { title: 'Geteilter Schluessel' };
  const mine     = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body, key });
  const theirs   = await call('POST', '/tasks/', { as: { id: BOB, role: 'admin' }, body, key });

  assert.equal(theirs.status, 201);
  assert.notEqual(theirs.body.data.id, mine.body.data.id, 'niemand darf die Antwort eines anderen sehen');
  assert.equal(countTasks('Geteilter Schluessel'), 2);
});

test('ein Fehlschlag verbraucht den Schlüssel nicht', async () => {
  // Sonst wäre der Aufrufer nach einem 400 mit demselben Schlüssel dauerhaft
  // an seine eigene Fehleingabe gebunden.
  const key = randomUUID();
  const bad = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { title: 'X', priority: 'sofort' }, key });
  assert.equal(bad.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?').get(key).n, 0,
    'der Platzhalter muss wieder weg sein');

  const good = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Korrigiert', priority: 'high' }, key });
  assert.equal(good.status, 201, 'mit korrigierter Eingabe muss derselbe Schlüssel wieder gehen');
});

test('ein unbrauchbarer Schlüssel wird abgewiesen, nicht ignoriert', async () => {
  const tooLong = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Zu lang' }, key: 'k'.repeat(256) });
  assert.equal(tooLong.status, 400);
  assert.equal(countTasks('Zu lang'), 0, 'ein abgewiesener Schlüssel darf nichts anlegen');

  // HTTP schneidet fuehrende und schliessende Leerzeichen selbst weg - beim
  // Server kommt ein leerer Header an, und der ist ein Aufrufer, der sich in
  // Sicherheit wiegt, ohne welche zu haben.
  const blank = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Leer' }, key: '   ' });
  assert.equal(blank.status, 400);
  assert.equal(countTasks('Leer'), 0);

  const nonAscii = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Umlaut' }, key: 'schluessel-\u00e4\u00f6\u00fc' });
  assert.equal(nonAscii.status, 400);
  assert.equal(countTasks('Umlaut'), 0);
});

test('GET trägt keinen Vorgang ein', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get().n;
  const r = await call('GET', '/tasks/', { as: { id: ALICE, role: 'admin' }, key: randomUUID() });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get().n, before,
    'nur schreibende Anfragen brauchen ein Gedächtnis');
});

test('ein laufender Vorgang weist die Wiederholung ab', async () => {
  // Der Fall, für den der Header überhaupt geschickt wird: der Client bricht ab
  // und wiederholt sofort, während der erste Versuch noch arbeitet.
  const key = randomUUID();
  const body = { title: 'Parallel' };
  db.prepare(`
    INSERT INTO idempotency_keys (user_id, key, method, path, request_hash)
    VALUES (?, ?, 'POST', '/tasks/', ?)
  `).run(ALICE, key, fingerprint({ method: 'POST', path: '/tasks/', body }));

  const r = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body, key });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /in progress/i);
  assert.equal(r.body.reason, 'idempotency_in_progress');
  assert.equal(countTasks('Parallel'), 0);
});

test('ein abgebrochener Vorgang blockiert seinen Schlüssel nicht für immer', async () => {
  // Stirbt der Prozess mitten in der Ausführung, bleibt ein Platzhalter ohne
  // Antwort zurück. Ohne Frist käme der Aufrufer bis zum Ablauf der TTL nicht
  // mehr durch - und das trifft jeden Abbruch, nicht nur den seltenen Fall.
  const key = randomUUID();
  const body = { title: 'Wiederaufnahme' };
  db.prepare(`
    INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, created_at)
    VALUES (?, ?, 'POST', '/tasks/', ?, datetime('now', '-10 minutes'))
  `).run(ALICE, key, fingerprint({ method: 'POST', path: '/tasks/', body }));

  const r = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body, key });
  assert.equal(r.status, 201);
  assert.equal(countTasks('Wiederaufnahme'), 1);
});

test('ein abgelaufener Schlüssel ist wieder frei', async () => {
  const key = randomUUID();
  const first = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Abgelaufen' }, key });
  db.prepare(`UPDATE idempotency_keys SET created_at = datetime('now', '-25 hours') WHERE key = ?`).run(key);

  const second = await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Abgelaufen' }, key });
  assert.equal(second.status, 201);
  assert.notEqual(second.body.data.id, first.body.data.id, 'nach Ablauf ist es ein neuer Vorgang');
  assert.equal(countTasks('Abgelaufen'), 2);
});

test('das Aufräumen fasst nur Abgelaufenes an', async () => {
  const fresh = randomUUID();
  await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Frisch' }, key: fresh });

  const stale = randomUUID();
  db.prepare(`
    INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, status, response_body, created_at)
    VALUES (?, ?, 'POST', '/tasks/', 'egal', 201, '{}', datetime('now', '-48 hours'))
  `).run(ALICE, stale);

  await call('POST', '/tasks/', { as: { id: ALICE, role: 'admin' }, body: { title: 'Ausloeser' }, key: randomUUID() });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?').get(stale).n, 0,
    'Abgelaufenes geht beim nächsten Schlüssel-Request mit');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?').get(fresh).n, 1,
    'Frisches bleibt');
});

test('die Middleware liegt hinter Auth, Scopes und CSRF', async () => {
  // Ein abgewiesener Aufruf darf keinen Schlüssel verbrauchen - sonst könnte
  // ein 403 den Schlüssel des rechtmäßigen Aufrufers belegen.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const csrf = src.indexOf("app.use('/api/v1', csrfMiddleware)");
  const idem = src.indexOf("app.use('/api/v1', idempotencyMiddleware)");
  const firstRouter = src.indexOf("app.use('/api/v1/dashboard'");
  assert.ok(csrf > 0 && idem > 0 && firstRouter > 0, 'alle drei Stellen müssen existieren');
  assert.ok(idem > csrf, 'die Idempotenz gehört hinter den CSRF-Schutz');
  assert.ok(idem < firstRouter, 'und vor jeden Router, den sie abdecken soll');
});

// --------------------------------------------------------
// Der dokumentierte Vertrag
// --------------------------------------------------------

test('die Spec nennt den Header an jedem POST, den die Middleware erreicht', async () => {
  const { buildOpenApiSpec } = await import('../server/openapi.js');
  const spec = buildOpenApiSpec({}, '0.0.0-test');

  const posts = Object.entries(spec.paths).filter(([, item]) => item?.post);
  assert.ok(posts.length > 10, 'die Spec muss ihre POST-Operationen überhaupt kennen');

  const covered = posts.filter(([p]) => p.startsWith('/api/v1/') && !p.startsWith('/api/v1/auth/'));
  assert.ok(covered.length > 0);
  for (const [path, item] of covered) {
    const names = (item.post.parameters ?? []).map((param) => param.name);
    assert.ok(names.includes('Idempotency-Key'), `${path} muss den Header dokumentieren`);
    assert.ok(item.post.responses?.[409], `${path} muss den Konflikt dokumentieren`);
  }

  // Der Auth-Router hängt vor requireAuth und damit vor der Middleware - eine
  // dort dokumentierte Zusage löste niemand ein.
  for (const [path, item] of posts.filter(([p]) => p.startsWith('/api/v1/auth/'))) {
    const names = (item.post.parameters ?? []).map((param) => param.name);
    assert.ok(!names.includes('Idempotency-Key'), `${path} liegt vor der Middleware und darf nichts versprechen`);
  }
});
