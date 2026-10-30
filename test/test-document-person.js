/**
 * Modul: Die Person an einem Dokument und seine Frist in der Kachel (#1705)
 * Zweck: Der Rest von #1705, durch die echten Router und die echte Zustellung:
 *        1. `subject_user_id`: eine Person aus der Mitgliederliste, als Filter
 *           nutzbar, und sie erweitert NIE die Sichtbarkeit (DECISIONS 1, 4);
 *        2. die Ablauf-Erinnerung geht an diese Person und an die ablegende,
 *           einmal bei derselben, und nur an wen das Dokument oeffnen darf;
 *        3. Dokumente als dritte Quelle der Kachel, ab genau dem Tag, an dem
 *           auch Chip und Erinnerung stehen (die eine Regel aus #1036), hinter
 *           Modulschalter und Rechten an der einen Stelle (DECISIONS 11).
 * Ausführen: npm run test:document-person
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'document-person-test-secret';
process.env.TZ = 'UTC';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: documentsRouter } = await import('../server/routes/documents.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { getCountdowns } = await import('../server/services/countdowns.js');
const { processDueNotifications } = await import('../server/services/notifications.js');
const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
const {
  DEFAULT_EXPIRY_LEAD_DAYS, expiryLeadDays, documentExpiryStatus, expiryDueSoon,
} = await import('../public/utils/document-expiry.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase();
_setTestDatabase(suiteDatabase);
moduleDatabase.close();
test.after(() => suiteDatabase.close());

function buildMigratedDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const migration of MIGRATIONS) {
    if (typeof migration.up === 'function') migration.up(db);
    else db.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return db;
}

function seedUser(name = 'Mitglied', role = 'member') {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, 'hash', ?, 'other')
  `).run(`doc-person-${randomUUID()}`, name, role).lastInsertRowid;
}

function setConfig(key, value) {
  get().prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

setConfig('household_timezone', 'UTC');
setConfig('disabled_modules', '[]');

const OWNER = seedUser('Ulrike');
const JOHN = seedUser('John');
const MIRA = seedUser('Mira');

function harness(userId = OWNER, { role = 'member' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = userId;
    req.authRole = role;
    req.session = { userId, role };
    req.authScopes = null;
    req.sessionModuleAccess = null;
    next();
  });
  app.use('/api/v1/documents', documentsRouter);
  app.use('/api/v1/reminders', remindersRouter);
  const server = http.createServer(app);
  const request = async (base, method, pathname, body) => {
    if (!server.listening) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const res = await fetch(`http://127.0.0.1:${server.address().port}${base}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return {
    call: (method, pathname, body) => request('/api/v1/documents', method, pathname, body),
    reminders: (method, pathname, body) => request('/api/v1/reminders', method, pathname, body),
    close: () => new Promise((resolve) => (server.listening ? server.close(resolve) : resolve())),
  };
}

async function asUser(userId, fn, options) {
  const h = harness(userId, options);
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

function dateIn(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  // TZ und Haushaltszone stehen oben auf UTC: das ist hier der Haushaltstag.
  return [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')].join('-');
}

const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test').toString('base64')}`;

function payload(overrides = {}) {
  return {
    name: `Reisepass ${randomUUID().slice(0, 6)}`,
    original_name: 'pass.pdf',
    content_data: PDF,
    category: 'identity',
    visibility: 'family',
    ...overrides,
  };
}

async function fileDocument(overrides = {}, userId = OWNER) {
  const res = await asUser(userId, (h) => h.call('POST', '', payload(overrides)));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

const remindersOf = (id) => get().prepare(`
  SELECT created_by FROM reminders WHERE entity_type = 'document_expiry' AND entity_id = ?
  ORDER BY created_by
`).all(id).map((row) => row.created_by);

const makeDue = (id) => get().prepare(`
  UPDATE reminders SET remind_at = '2000-01-01T09:00'
  WHERE entity_type = 'document_expiry' AND entity_id = ?
`).run(id);

const sorted = (...ids) => [...ids].sort((a, b) => a - b);

function documentItems(userId, { hiddenModules = null, todayKey = dateIn(0) } = {}) {
  return getCountdowns(get(), { userId, todayKey, hiddenModules, limit: 500 }).items
    .filter((item) => item.source === 'document');
}

function denyDocuments(userId) {
  get().prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'documents', 'none')
  `).run(String(userId));
}

function allowDocuments(userId) {
  get().prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(userId));
}

// ------------------------------------------------------------------
// 1. Das Feld
// ------------------------------------------------------------------

test('POST legt die Person ab, die Liste nennt sie mit Name und Farbe', async () => {
  const doc = await fileDocument({ subject_user_id: JOHN });
  assert.equal(doc.subject_user_id, JOHN);
  assert.equal(doc.subject_name, 'John');
  const list = await asUser(OWNER, (h) => h.call('GET', '?status=active'));
  const row = list.body.data.find((d) => d.id === doc.id);
  assert.equal(row.subject_user_id, JOHN);
  assert.equal(row.subject_name, 'John');
  assert.ok('subject_color' in row);
});

test('ohne Angabe bleibt ein Dokument ohne Person', async () => {
  const doc = await fileDocument();
  assert.equal(doc.subject_user_id, null);
});

test('gewaehlt wird aus der Mitgliederliste: Personal und unbekannte Konten nicht', async () => {
  const worker = seedUser('Clara');
  get().prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(worker);
  const staff = await asUser(OWNER, (h) => h.call('POST', '', payload({ subject_user_id: worker })));
  assert.equal(staff.status, 400);
  const unknown = await asUser(OWNER, (h) => h.call('POST', '', payload({ subject_user_id: 999999 })));
  assert.equal(unknown.status, 400);
  const garbage = await asUser(OWNER, (h) => h.call('POST', '', payload({ subject_user_id: 'john' })));
  assert.equal(garbage.status, 400);
});

test('PUT ohne Feld laesst die Person stehen, null nimmt sie weg', async () => {
  const doc = await fileDocument({ subject_user_id: JOHN });
  await asUser(OWNER, async (h) => {
    const kept = await h.call('PUT', `/${doc.id}`, { name: 'Neu' });
    assert.equal(kept.body.data.subject_user_id, JOHN);
    const cleared = await h.call('PUT', `/${doc.id}`, { subject_user_id: null });
    assert.equal(cleared.body.data.subject_user_id, null);
  });
});

test('eine gespeicherte Person, die kein Mitglied mehr ist, bleibt speicherbar', async () => {
  const later = seedUser('Spaeter Personal');
  const doc = await fileDocument({ subject_user_id: later });
  get().prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(later);
  const res = await asUser(OWNER, (h) => h.call('PUT', `/${doc.id}`, { subject_user_id: later, name: 'X' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.subject_user_id, later);
});

test('wird das Konto geloescht, verliert das Dokument nur die Person', async () => {
  const gone = seedUser('Weg');
  const doc = await fileDocument({ subject_user_id: gone });
  get().prepare('DELETE FROM users WHERE id = ?').run(gone);
  const row = get().prepare('SELECT subject_user_id FROM family_documents WHERE id = ?').get(doc.id);
  assert.equal(row.subject_user_id, null);
});

test('Sichtbarkeit: die Person an einem privaten Dokument sieht es nicht (DECISIONS 1)', async () => {
  const doc = await fileDocument({ subject_user_id: JOHN, visibility: 'private' });
  await asUser(JOHN, async (h) => {
    const list = await h.call('GET', '?status=active');
    assert.ok(!list.body.data.some((d) => d.id === doc.id), 'die Liste nennt das private Dokument');
    const filtered = await h.call('GET', `?subject_user_id=${JOHN}`);
    assert.ok(!filtered.body.data.some((d) => d.id === doc.id), 'der Filter oeffnet es');
    const edit = await h.call('PUT', `/${doc.id}`, { name: 'Fremd' });
    assert.equal(edit.status, 404);
  });
});

test('die Person darf das Dokument nicht verwalten, nur weil es sie betrifft', async () => {
  const doc = await fileDocument({ subject_user_id: JOHN });
  const res = await asUser(JOHN, (h) => h.call('PUT', `/${doc.id}`, { name: 'Meins' }));
  assert.equal(res.status, 403);
});

test('Filter: subject_user_id liefert nur die sichtbaren Dokumente dieser Person', async () => {
  const mine = await fileDocument({ subject_user_id: MIRA });
  const hidden = await fileDocument({ subject_user_id: MIRA, visibility: 'private' });
  const other = await fileDocument({ subject_user_id: JOHN });
  await asUser(JOHN, async (h) => {
    const res = await h.call('GET', `?subject_user_id=${MIRA}`);
    assert.equal(res.status, 200);
    const ids = res.body.data.map((d) => d.id);
    assert.ok(ids.includes(mine.id));
    assert.ok(!ids.includes(hidden.id));
    assert.ok(!ids.includes(other.id));
    assert.equal((await h.call('GET', '?subject_user_id=abc')).status, 400);
  });
});

// ------------------------------------------------------------------
// 2. Die Erinnerung
// ------------------------------------------------------------------

const withExpiry = (overrides = {}) => ({ expires_at: dateIn(60), expiry_reminder_days: 10, ...overrides });

test('Erinnerung: an die Person und die Ablegende, zwei Zeilen', async () => {
  const doc = await fileDocument(withExpiry({ subject_user_id: JOHN }));
  assert.deepEqual(remindersOf(doc.id), sorted(OWNER, JOHN));
});

test('Erinnerung: einmal, wenn es dieselbe Person ist', async () => {
  const doc = await fileDocument(withExpiry({ subject_user_id: OWNER }));
  assert.deepEqual(remindersOf(doc.id), [OWNER]);
});

test('Erinnerung: Personenwechsel zieht die Zeilen nach, Entfernen laesst die Ablegende', async () => {
  const doc = await fileDocument(withExpiry({ subject_user_id: JOHN }));
  await asUser(OWNER, async (h) => {
    await h.call('PUT', `/${doc.id}`, { subject_user_id: MIRA });
    assert.deepEqual(remindersOf(doc.id), sorted(OWNER, MIRA));
    await h.call('PUT', `/${doc.id}`, { subject_user_id: null });
    assert.deepEqual(remindersOf(doc.id), [OWNER]);
  });
});

test('Erinnerung: aendert ein Admin fremdes Dokument, bleiben die Empfaenger dieselben', async () => {
  const admin = seedUser('Admin', 'admin');
  const doc = await fileDocument(withExpiry({ subject_user_id: JOHN }));
  await asUser(admin, (h) => h.call('PUT', `/${doc.id}`, { expiry_reminder_days: 5 }), { role: 'admin' });
  assert.deepEqual(remindersOf(doc.id), sorted(OWNER, JOHN));
});

test('Erinnerung: Archivieren raeumt beide ab, Reaktivieren stellt beide wieder her', async () => {
  const doc = await fileDocument(withExpiry({ subject_user_id: JOHN }));
  await asUser(OWNER, async (h) => {
    await h.call('PATCH', `/${doc.id}/archive`, {});
    assert.deepEqual(remindersOf(doc.id), []);
    await h.call('PATCH', `/${doc.id}/archive`, { archived: false });
    assert.deepEqual(remindersOf(doc.id), sorted(OWNER, JOHN));
  });
});

test('/pending: die Person sieht die Meldung nur, solange sie das Dokument oeffnen darf', async () => {
  const doc = await fileDocument(withExpiry({ subject_user_id: JOHN, visibility: 'private' }));
  makeDue(doc.id);
  const rows = async () => {
    const res = await asUser(JOHN, (h) => h.reminders('GET', '/pending'));
    return res.body.data.filter((r) => r.entity_id === doc.id && r.entity_type === 'document_expiry');
  };
  assert.equal((await rows()).length, 0, 'privates Dokument, John darf es nicht oeffnen');
  await asUser(OWNER, (h) => h.call('PUT', `/${doc.id}`, { visibility: 'restricted', allowed_member_ids: [JOHN] }));
  makeDue(doc.id);
  assert.equal((await rows()).length, 1, 'ausdruecklich freigegeben');
});

test('GET /reminders und /all: wer das Dokument nicht oeffnen darf, liest auch die Erinnerung nicht', async () => {
  const doc = await fileDocument(withExpiry({ subject_user_id: JOHN, visibility: 'private' }));
  const query = `entity_type=document_expiry&entity_id=${doc.id}`;
  const read = async () => ({
    one: (await asUser(JOHN, (h) => h.reminders('GET', `/?${query}`))).body.data,
    all: (await asUser(JOHN, (h) => h.reminders('GET', `/all?${query}`))).body.data,
  });
  assert.deepEqual(await read(), { one: null, all: [] }, 'Dokument-ID und Termin bleiben verborgen');
  const owner = await asUser(OWNER, (h) => h.reminders('GET', `/?${query}`));
  assert.equal(owner.body.data?.entity_id, doc.id, 'die Ablegende liest ihre Zeile weiter');

  await asUser(OWNER, (h) => h.call('PUT', `/${doc.id}`, { visibility: 'restricted', allowed_member_ids: [JOHN] }));
  const shared = await read();
  assert.equal(shared.one?.entity_id, doc.id, 'nach der Freigabe sichtbar');
  assert.equal(shared.all.length, 1);
});

async function deliver() {
  const push = [];
  const channel = [];
  await processDueNotifications({
    database: get(),
    channelStore: createNotificationChannelStore({ db: get() }),
    pushService: { sendPushToUser: async (userId, message) => { push.push({ userId, ...message }); return 1; } },
    providers: {
      ntfy: {
        id: 'ntfy',
        send: async ({ channel: target, payload: message }) => { channel.push({ ...message, scope: target.scope }); },
      },
    },
    now: new Date(),
  });
  return { push, channel };
}

const subscribe = (userId) => get().prepare(`
  INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, 'p', 'a')
`).run(userId, `https://push.test/${userId}/${randomUUID()}`);

const settleEverything = () => get()
  .prepare("UPDATE reminders SET pushed_at = '2000-01-01T00:00:00Z' WHERE pushed_at IS NULL").run();

const rowIdOf = (documentId, userId) => get().prepare(`
  SELECT id FROM reminders WHERE entity_type = 'document_expiry' AND entity_id = ? AND created_by = ?
`).get(documentId, userId)?.id;

const pushedTo = (run, documentId, userId) => run.push
  .some((p) => p.userId === userId && p.tag === `reminder-${rowIdOf(documentId, userId)}`);

function householdChannel(name) {
  const store = createNotificationChannelStore({ db: get() });
  const channel = store.createChannel({
    provider: 'ntfy', name, enabled: true,
    config: { baseUrl: 'https://ntfy.test', topic: name }, secrets: {},
  });
  return () => store.deleteChannel(channel.id);
}

test('Zustellung: Push an beide bei einem Dokument fuer alle', async () => {
  const person = seedUser('Beide');
  subscribe(OWNER);
  subscribe(person);
  settleEverything();
  const doc = await fileDocument(withExpiry({ subject_user_id: person }));
  makeDue(doc.id);
  const run = await deliver();
  assert.ok(pushedTo(run, doc.id, OWNER));
  assert.ok(pushedTo(run, doc.id, person));
});

test('Zustellung: an einem privaten Dokument kein Push an die Person', async () => {
  const person = seedUser('Aussen');
  subscribe(person);
  settleEverything();
  const doc = await fileDocument(withExpiry({ subject_user_id: person, visibility: 'private' }));
  makeDue(doc.id);
  const run = await deliver();
  assert.ok(pushedTo(run, doc.id, OWNER), 'die Ablegende darf es oeffnen');
  assert.ok(!pushedTo(run, doc.id, person), 'die Meldung nennt ein Dokument, das sie nicht oeffnen darf');
  assert.equal(get().prepare('SELECT pushed_at FROM reminders WHERE id = ?').get(rowIdOf(doc.id, person)).pushed_at, null,
    'die Zeile bleibt ausstehend, falls das Dokument spaeter freigegeben wird');
});

test('Zustellung: wer das Modul Dokumente nicht hat, bekommt keinen Push', async () => {
  const person = seedUser('Ohne Modul');
  subscribe(person);
  denyDocuments(person);
  settleEverything();
  const doc = await fileDocument(withExpiry({ subject_user_id: person }));
  makeDue(doc.id);
  const run = await deliver();
  assert.ok(!pushedTo(run, doc.id, person));
});

test('Zustellung: der Haushaltskanal hoert eine Frist einmal, nicht je Empfaenger', async () => {
  const remove = householdChannel('familie-eins');
  try {
    settleEverything();
    const doc = await fileDocument(withExpiry({ subject_user_id: JOHN }));
    makeDue(doc.id);
    const run = await deliver();
    assert.equal(run.channel.filter((p) => p.scope === 'household').length, 1,
      'zwei Zeilen duerfen im Haushaltskanal nicht zwei Meldungen werden');
    assert.equal((await deliver()).channel.length, 0);
  } finally {
    remove();
  }
});

test('Zustellung: eine spaet faellige zweite Zeile meldet sich dort nicht noch einmal', async () => {
  const person = seedUser('Spaet');
  const remove = householdChannel('familie-zwei');
  try {
    settleEverything();
    const doc = await fileDocument(withExpiry({ subject_user_id: person }));
    makeDue(doc.id);
    denyDocuments(person);
    const first = await deliver();
    assert.equal(first.channel.filter((p) => p.scope === 'household').length, 1);
    allowDocuments(person);
    const second = await deliver();
    assert.equal(second.channel.filter((p) => p.scope === 'household').length, 0,
      'dieselbe Frist kam ein zweites Mal in den Haushaltskanal');
  } finally {
    remove();
  }
});

// ------------------------------------------------------------------
// 3. Die Kachel
// ------------------------------------------------------------------

const archiveEverything = () => get().prepare("UPDATE family_documents SET status = 'archived'").run();

test('Kachel: ein Dokument steht ab seinem Vorlauf, nicht frueher', async () => {
  archiveEverything();
  const inside = await fileDocument({ expires_at: dateIn(90), expiry_reminder_days: 90 });
  const outside = await fileDocument({ expires_at: dateIn(91), expiry_reminder_days: 90 });
  const ids = documentItems(OWNER).map((item) => item.id);
  assert.ok(ids.includes(inside.id));
  assert.ok(!ids.includes(outside.id));
});

test('Kachel: ohne Vorlauf gilt der Standard, ein Vorlauf von 0 nur der Tag selbst', async () => {
  archiveEverything();
  const plain = await fileDocument({ expires_at: dateIn(DEFAULT_EXPIRY_LEAD_DAYS) });
  const tooFar = await fileDocument({ expires_at: dateIn(DEFAULT_EXPIRY_LEAD_DAYS + 1) });
  const today = await fileDocument({ expires_at: dateIn(0), expiry_reminder_days: 0 });
  const tomorrow = await fileDocument({ expires_at: dateIn(1), expiry_reminder_days: 0 });
  const ids = documentItems(OWNER).map((item) => item.id);
  assert.ok(ids.includes(plain.id));
  assert.ok(!ids.includes(tooFar.id));
  assert.ok(ids.includes(today.id), 'ein explizites 0 faellt nicht auf den Standard zurueck');
  assert.ok(!ids.includes(tomorrow.id));
});

test('Kachel: die Zeile traegt Quelle, Datum, Tageszahl und die Person', async () => {
  archiveEverything();
  const doc = await fileDocument({ expires_at: dateIn(5), expiry_reminder_days: 10, subject_user_id: JOHN });
  const [item] = documentItems(OWNER);
  assert.equal(item.id, doc.id);
  assert.equal(item.title, doc.name);
  assert.equal(item.date, dateIn(5));
  assert.equal(item.days_until, 5);
  assert.equal(item.person_name, 'John');
  assert.equal(item.recurring, false);
});

test('Kachel: ein archiviertes Dokument faellt heraus', async () => {
  archiveEverything();
  const doc = await fileDocument({ expires_at: dateIn(5) });
  assert.equal(documentItems(OWNER).length, 1);
  await asUser(OWNER, (h) => h.call('PATCH', `/${doc.id}/archive`, {}));
  assert.equal(documentItems(OWNER).length, 0);
});

test('Kachel: es gilt die Dokumentregel, die Person erweitert nichts', async () => {
  archiveEverything();
  await fileDocument({ expires_at: dateIn(5), subject_user_id: JOHN, visibility: 'private' });
  const shared = await fileDocument({ expires_at: dateIn(6), visibility: 'restricted', allowed_member_ids: [MIRA] });
  assert.equal(documentItems(JOHN).length, 0);
  assert.deepEqual(documentItems(MIRA).map((item) => item.id), [shared.id]);
  assert.equal(documentItems(OWNER).length, 2);
});

test('Kachel: die Nachfrist gilt auch fuer Dokumente', async () => {
  archiveEverything();
  setConfig('countdown_grace_days', '3');
  try {
    await fileDocument({ expires_at: dateIn(5) });
    assert.equal(documentItems(OWNER, { todayKey: dateIn(8) })[0]?.days_until, -3);
    assert.equal(documentItems(OWNER, { todayKey: dateIn(9) }).length, 0);
  } finally {
    get().prepare("DELETE FROM sync_config WHERE key = 'countdown_grace_days'").run();
  }
});

test('Kachel: Modulschalter und Rechte nehmen Dokumente vor Schnitt und Gesamtzahl heraus', async () => {
  archiveEverything();
  await fileDocument({ expires_at: dateIn(5) });
  const total = (opts = {}) => getCountdowns(get(), { userId: OWNER, todayKey: dateIn(0), limit: 500, ...opts }).total;
  const before = total();
  assert.equal(total({ hiddenModules: new Set(['documents']) }), before - 1, 'dem Betrachter entzogen');
  setConfig('disabled_modules', '["documents"]');
  try {
    assert.equal(total(), before - 1, 'im Haushalt abgeschaltet');
    assert.equal(documentItems(OWNER).length, 0);
    // Abschalten ist keine Sperre: die Route des Moduls bleibt offen (DECISIONS 11).
    assert.equal((await asUser(OWNER, (h) => h.call('GET', '?status=active'))).status, 200);
  } finally {
    setConfig('disabled_modules', '[]');
  }
});

test('Kachel: alle drei Quellen stehen in EINER nach Naehe sortierten Liste', async () => {
  archiveEverything();
  const task = get().prepare(`
    INSERT INTO tasks (title, category, status, created_by, visibility, due_date, countdown)
    VALUES ('Aufgabe', 'misc', 'open', ?, 'all', ?, 1)
  `).run(OWNER, dateIn(4)).lastInsertRowid;
  const event = get().prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, created_by, visibility, countdown)
    VALUES ('Termin', ?, 1, ?, 'all', 1)
  `).run(dateIn(6), OWNER).lastInsertRowid;
  const doc = await fileDocument({ expires_at: dateIn(5) });
  const wanted = new Set([`task:${task}`, `document:${doc.id}`, `event:${event}`]);
  const items = getCountdowns(get(), { userId: OWNER, todayKey: dateIn(0), limit: 500 }).items
    .filter((item) => wanted.has(`${item.source}:${item.id}`));
  assert.deepEqual(items.map((item) => item.source), ['task', 'document', 'event']);
});

// ------------------------------------------------------------------
// Die eine Regel fuer Vorlauf-Tag und Markierung (#1036)
// ------------------------------------------------------------------

test('der Standard-Vorlauf ist die Schwelle des Ablauf-Chips, keine zweite Zahl', () => {
  // date-status.js importiert ueber den Browser-Pfad /utils/date.js und laesst
  // sich hier nicht laden, deshalb liest der Test die Konstante aus der Quelle.
  const source = readFileSync(new URL('../public/utils/date-status.js', import.meta.url), 'utf8');
  assert.equal(Number(/DATE_STATUS_ALERT_DAYS = (\d+)/.exec(source)[1]), DEFAULT_EXPIRY_LEAD_DAYS);
});

test('expiryLeadDays: gesetzter Vorlauf gewinnt, 0 bleibt 0, sonst der Standard', () => {
  assert.equal(expiryLeadDays({ expiry_reminder_days: 90 }), 90);
  assert.equal(expiryLeadDays({ expiry_reminder_days: 0 }), 0);
  assert.equal(expiryLeadDays({ expiry_reminder_days: null }), DEFAULT_EXPIRY_LEAD_DAYS);
  assert.equal(expiryLeadDays({}), DEFAULT_EXPIRY_LEAD_DAYS);
});

test('expiryDueSoon: dieselbe Grenze wie der Erinnerungstag', () => {
  assert.equal(expiryDueSoon(90, { expiry_reminder_days: 90 }), true);
  assert.equal(expiryDueSoon(91, { expiry_reminder_days: 90 }), false);
  assert.equal(expiryDueSoon(-1, { expiry_reminder_days: 0 }), true);
});

test('documentExpiryStatus: der Chip folgt dem Vorlauf in beide Richtungen', () => {
  const at = (days) => ({ state: days < 0 ? 'expired' : days <= 30 ? 'expiring' : 'valid', endDateKey: '2030-01-01', days });
  assert.equal(documentExpiryStatus(at(80), { expiry_reminder_days: 90 }).state, 'expiring', 'frueher als 30 Tage');
  assert.equal(documentExpiryStatus(at(20), { expiry_reminder_days: 7 }).state, 'valid', 'spaeter als 30 Tage');
  assert.equal(documentExpiryStatus(at(20), {}).state, 'expiring', 'ohne Vorlauf wie bisher');
  assert.equal(documentExpiryStatus(at(-2), { expiry_reminder_days: 7 }).state, 'expired');
  assert.equal(documentExpiryStatus(null, {}), null);
});
