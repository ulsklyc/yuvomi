/**
 * Modul: Dokument-Ablauf + Erinnerungs-Sync
 * Zweck: expires_at/expiry_reminder_days auf family_documents - Validierung
 *        (inkl. eines erhaltenen expliziten 0), die Erinnerung, die bei jedem
 *        Schreiben neu berechnet wird (server/routes/inventory/items.js#syncReminder
 *        ist das Vorbild), und ihr Abbau auf jedem Weg, der ein Dokument aus dem
 *        aktiven Bestand nimmt: Loeschen, Ordner-Baum-Loeschen, Archivieren.
 * Ausführen: npm run test:document-expiry
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test, { mock } from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'document-expiry-test-secret';
// Explizit, nicht dem Zufall der Umgebung ueberlassen (Review-Runde 2): jeder
// Test ausser dem Haushaltszonen-Test unten setzt kein eigenes
// household_timezone, faellt also auf serverTimeZone() zurueck, die ohne
// diese Zeile die TZ des CI-Containers erbt. dateKey()/daysFromToday() weiter
// unten rechnen bewusst in UTC - ohne einen Pin liefe der Rest der Datei nur
// zufaellig auf derselben Uhr wie die Serverseite.
process.env.TZ = 'UTC';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: documentsRouter } = await import('../server/routes/documents.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

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

function seedUser(role = 'member') {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', ?)
  `).run(`doc-expiry-${role}-${randomUUID()}`, `Doc Expiry ${role}`, role).lastInsertRowid;
}

const OWNER = seedUser('member');
const ADMIN = seedUser('admin');
const OTHER_MEMBER = seedUser('member');

// `authScopes`/`sessionModuleAccess` sind pro Aufruf setzbar (Default: null =
// unbeschraenkt), damit die Rechte-/Sichtbarkeitsachse in den Tests unten
// geprueft werden kann - derselbe echte `deniedModules()`/`tokenAllows()`-Pfad
// wie in server/index.js, nicht ein Stub, der ihn umgeht.
function createHarness({ userId = OWNER, role = 'member', authScopes = null, sessionModuleAccess = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use(defaultEmptyBody);
  app.use((req, _res, next) => {
    req.authUserId = userId;
    req.authRole = role;
    req.session = { userId, role };
    req.authScopes = authScopes;
    req.sessionModuleAccess = sessionModuleAccess;
    next();
  });
  app.use('/api/v1/documents', documentsRouter);
  app.use('/api/v1/reminders', remindersRouter);
  // The central error handler answers the 400 of validateRequest() as JSON (#2810).
  app.use(createErrorHandler({ warn: () => {}, error: () => {} }));
  const server = http.createServer(app);
  return {
    async call(method, pathname, body) {
      if (!server.listening) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      }
      const base = `http://127.0.0.1:${server.address().port}/api/v1/documents`;
      const res = await fetch(`${base}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async callReminders(method, pathname, body) {
      if (!server.listening) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      }
      const base = `http://127.0.0.1:${server.address().port}/api/v1/reminders`;
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

function dateKey(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function daysFromToday(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return dateKey(d);
}

const PDF_DATA_URL = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test').toString('base64')}`;

function uploadPayload(overrides = {}) {
  return {
    name: 'Reisepass',
    original_name: 'passport.pdf',
    content_data: PDF_DATA_URL,
    category: 'identity',
    visibility: 'family',
    ...overrides,
  };
}

function reminderRows(entityId) {
  return get().prepare(`
    SELECT * FROM reminders WHERE entity_type = 'document_expiry' AND entity_id = ?
  `).all(entityId);
}

// --------------------------------------------------------
// Validierung
// --------------------------------------------------------

test('POST /documents akzeptiert ein explizites 0 als Erinnerungs-Vorlauf', async () => {
  const h = createHarness();
  try {
    const res = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 0,
    }));
    assert.equal(res.status, 201);
    assert.equal(res.body.data.expiry_reminder_days, 0, '0 darf nicht auf den Default zurueckfallen');
  } finally {
    await h.close();
  }
});

test('POST /documents lehnt einen Vorlauf ausserhalb von 0-365 ab', async () => {
  const h = createHarness();
  try {
    const tooHigh = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 366,
    }));
    assert.equal(tooHigh.status, 400);

    const negative = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: -1,
    }));
    assert.equal(negative.status, 400);
  } finally {
    await h.close();
  }
});

test('POST /documents lehnt ein falsch formatiertes Ablaufdatum ab', async () => {
  const h = createHarness();
  try {
    const res = await h.call('POST', '', uploadPayload({ expires_at: '30.09.2026' }));
    assert.equal(res.status, 400);
  } finally {
    await h.close();
  }
});

test('GET /documents gibt expires_at und expiry_reminder_days zurueck', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(45),
      expiry_reminder_days: 10,
    }));
    assert.equal(created.status, 201);
    const list = await h.call('GET', '?status=active');
    const row = list.body.data.find((d) => d.id === created.body.data.id);
    assert.equal(row.expires_at, daysFromToday(45));
    assert.equal(row.expiry_reminder_days, 10);
  } finally {
    await h.close();
  }
});

// --------------------------------------------------------
// Erinnerungs-Sync bei jedem Schreiben
// --------------------------------------------------------

test('POST /documents legt eine document_expiry-Erinnerung an, Besitzer ist created_by', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    assert.equal(created.status, 201);
    const rows = reminderRows(created.body.data.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].remind_at, `${daysFromToday(25)}T09:00`);
    assert.equal(rows[0].created_by, OWNER);
  } finally {
    await h.close();
  }
});

test('kein Ablaufdatum oder kein Vorlauf legt keine Erinnerung an', async () => {
  const h = createHarness();
  try {
    const noExpiry = await h.call('POST', '', uploadPayload({}));
    assert.equal(reminderRows(noExpiry.body.data.id).length, 0);

    const noLead = await h.call('POST', '', uploadPayload({ expires_at: daysFromToday(30) }));
    assert.equal(reminderRows(noLead.body.data.id).length, 0);
  } finally {
    await h.close();
  }
});

test('ein bereits vergangener Erinnerungstermin wird nicht angelegt', async () => {
  const h = createHarness();
  try {
    // Ablauf gestern, kein Vorlauf: remind_at liegt in der Vergangenheit.
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(-1),
      expiry_reminder_days: 0,
    }));
    assert.equal(created.status, 201);
    assert.equal(reminderRows(created.body.data.id).length, 0);
  } finally {
    await h.close();
  }
});

test('PUT /documents/:id verschiebt die Erinnerung, wenn sich das Ablaufdatum aendert', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id)[0].remind_at, `${daysFromToday(25)}T09:00`);

    await h.call('PUT', `/${id}`, { expires_at: daysFromToday(60), expiry_reminder_days: 5, allowed_member_ids: [] });
    const rows = reminderRows(id);
    assert.equal(rows.length, 1, 'die alte Zeile darf nicht liegen bleiben');
    assert.equal(rows[0].remind_at, `${daysFromToday(55)}T09:00`);
  } finally {
    await h.close();
  }
});

test('PUT /documents/:id raeumt die Erinnerung ab, wenn das Ablaufdatum entfernt wird', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id).length, 1);

    await h.call('PUT', `/${id}`, { expires_at: null, allowed_member_ids: [] });
    assert.equal(reminderRows(id).length, 0);
  } finally {
    await h.close();
  }
});

// --------------------------------------------------------
// Abbau, wo ein Dokument den aktiven Bestand verlaesst
// --------------------------------------------------------

test('DELETE /documents/:id raeumt die Erinnerung ab', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id).length, 1);

    const del = await h.call('DELETE', `/${id}`);
    assert.equal(del.status, 204);
    assert.equal(reminderRows(id).length, 0);
  } finally {
    await h.close();
  }
});

test('PATCH /documents/:id/archive raeumt die Erinnerung ab - ein archiviertes Dokument darf nicht nagen', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id).length, 1);

    const archived = await h.call('PATCH', `/${id}/archive`, {});
    assert.equal(archived.status, 200);
    assert.equal(reminderRows(id).length, 0);

    // Reaktivieren stellt sie wieder her, solange der Ablauf noch in der Zukunft liegt.
    const restored = await h.call('PATCH', `/${id}/archive`, { archived: false });
    assert.equal(restored.status, 200);
    assert.equal(reminderRows(id).length, 1);
  } finally {
    await h.close();
  }
});

test('PUT /documents/:id mit status=archived raeumt die Erinnerung ebenso ab', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id).length, 1);

    await h.call('PUT', `/${id}`, { status: 'archived', allowed_member_ids: [] });
    assert.equal(reminderRows(id).length, 0);
  } finally {
    await h.close();
  }
});

test('DELETE /folders/:id?documents=delete raeumt die Erinnerungen des ganzen Zweigs ab', async () => {
  const h = createHarness();
  try {
    const folder = await h.call('POST', '/folders', { name: `Zweig-${randomUUID()}` });
    const folderId = folder.body.data.id;
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
      folder_id: folderId,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id).length, 1);

    const impact = await h.call('GET', `/folders/${folderId}/delete-impact`);
    const del = await h.call(
      'DELETE',
      `/folders/${folderId}?documents=delete&expected_snapshot=${impact.body.data.snapshot}`,
    );
    assert.equal(del.status, 200);
    assert.equal(reminderRows(id).length, 0);
  } finally {
    await h.close();
  }
});

test('die Erinnerung gehoert created_by, nicht der bearbeitenden Person (Admin)', async () => {
  const owner = createHarness({ userId: OWNER, role: 'member' });
  const admin = createHarness({ userId: ADMIN, role: 'admin' });
  try {
    const created = await owner.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id)[0].created_by, OWNER);

    // Ein Admin darf das fremde Dokument bearbeiten (#989) - die Erinnerung
    // bleibt trotzdem bei der Person, die das Dokument angelegt hat.
    const edited = await admin.call('PUT', `/${id}`, { expires_at: daysFromToday(90), expiry_reminder_days: 3, allowed_member_ids: [] });
    assert.equal(edited.status, 200);
    const rows = reminderRows(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].created_by, OWNER);
  } finally {
    await owner.close();
    await admin.close();
  }
});

// --------------------------------------------------------
// ?expiring=<days>-Filter
// --------------------------------------------------------

test('GET /documents?expiring=<days> zeigt nur bald ablaufende/ueberfaellige Dokumente', async () => {
  const h = createHarness();
  try {
    const soon = await h.call('POST', '', uploadPayload({ name: 'Bald faellig', expires_at: daysFromToday(5) }));
    const later = await h.call('POST', '', uploadPayload({ name: 'Weit weg', expires_at: daysFromToday(200) }));
    const none = await h.call('POST', '', uploadPayload({ name: 'Ohne Ablauf' }));

    const res = await h.call('GET', '?expiring=10');
    const ids = res.body.data.map((d) => d.id);
    assert.ok(ids.includes(soon.body.data.id));
    assert.ok(!ids.includes(later.body.data.id));
    assert.ok(!ids.includes(none.body.data.id));
  } finally {
    await h.close();
  }
});

/** Dieselbe Stelle, die die Einstellungsseite schreibt. */
function setHouseholdTimeZone(zone) {
  get().prepare(`
    INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(zone);
}

/** Nachtraeglich gesetzte Zeile wieder entfernen - ohne das faellt jeder nach
 *  dieser Stelle deklarierte Test in dieser Datei auf UTC+14 zurueck, statt
 *  auf den Pin oben (Review-Runde 2, nice to have). */
function clearHouseholdTimeZone() {
  get().prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
}

// DIE UHR WIRD AUF DEN RAND GESTELLT (Muster wie test-budget-month-zone.js):
// ein Test zur Tagesmitte waere in jeder Zone gruen und wuerde nichts messen.
// `expires_at` ist ein lokal eingegebener Kalendertag - der Filter muss den
// Haushalts-Tag als Grenze nehmen, nicht den UTC-Tag von `date('now')`.
test('GET /documents?expiring=<days> nimmt den Haushaltstag als Grenze, nicht den UTC-Tag', async () => {
  const h = createHarness();
  try {
    setHouseholdTimeZone('Pacific/Kiritimati'); // UTC+14
    // 2026-08-31 20:00 UTC ist in Kiritimati bereits der 2026-09-01.
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-31T20:00:00Z') });
    try {
      assert.equal(new Date().toISOString().slice(0, 10), '2026-08-31', 'UTC steht auf den 31.08.');
      // Haushaltstag (01.09.) + 5 Tage = 06.09. Ein rein UTC-basierter Filter
      // rechnete vom 31.08. + 5 Tage = 05.09. und liesse dieses Dokument aussen
      // vor - genau der Unterschied, den dieser Test misst.
      const doc = await h.call('POST', '', uploadPayload({ name: 'Haushaltsrand', expires_at: '2026-09-06' }));
      const res = await h.call('GET', '?expiring=5');
      const ids = res.body.data.map((d) => d.id);
      assert.ok(ids.includes(doc.body.data.id),
        'der 06.09. liegt innerhalb von "Haushaltstag + 5", auch wenn UTC noch auf dem 31.08. steht');
    } finally {
      mock.timers.reset();
      clearHouseholdTimeZone();
    }
  } finally {
    await h.close();
  }
});

// --------------------------------------------------------
// document_expiry ist abgeleitet - kein Schreibweg darf es von Hand setzen
// --------------------------------------------------------

test('POST /reminders lehnt document_expiry ab - die Erinnerung leitet sich aus dem Dokument ab', async () => {
  const h = createHarness();
  try {
    const doc = await h.call('POST', '', uploadPayload({ name: 'Privat', visibility: 'private' }));
    // Vor der Review-Korrektur war document_expiry hier setzbar: ein Mitglied
    // konnte per {entity_type: 'document_expiry', entity_id: <fremde id>} eine
    // eigene Erinnerung anlegen und deren entity_title (der Dokumentname) ueber
    // die eigene /pending-Liste zurücklesen - ganz ohne Sichtbarkeitspruefung
    // auf das einzelne Dokument.
    const res = await h.callReminders('POST', '', {
      entity_type: 'document_expiry', entity_id: doc.body.data.id, remind_at: '2099-01-01T09:00',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /derived from the item itself/);
  } finally {
    await h.close();
  }
});

test('/pending kennt document_expiry weiterhin - der Toast muss die faellige Erinnerung zeigen und wegwischen koennen', async () => {
  const h = createHarness();
  try {
    const doc = await h.call('POST', '', uploadPayload({
      name: 'Reisepass faellig', expires_at: daysFromToday(30), expiry_reminder_days: 5,
    }));
    get().prepare("UPDATE reminders SET remind_at = '2000-01-01T09:00' WHERE entity_type = 'document_expiry' AND entity_id = ?")
      .run(doc.body.data.id);

    const pending = await h.callReminders('GET', '/pending');
    assert.equal(pending.status, 200);
    const match = pending.body.data.find((r) => r.entity_type === 'document_expiry' && r.entity_id === doc.body.data.id);
    assert.ok(match, 'die faellige Erinnerung fehlt in /pending');
    assert.equal(match.entity_title, 'Reisepass faellig');
  } finally {
    await h.close();
  }
});

test('/pending: ein zweites Haushaltsmitglied sieht die faellige Erinnerung eines privaten Dokuments nicht', async () => {
  // Die Achse, die Runde 1 offen liess: bisher liefen alle Tests als OWNER
  // oder ADMIN, keiner als ein ECHTES zweites Mitglied gegen ein 'private'
  // Dokument. Die Erinnerung gehoert created_by (dem Ersteller), und /pending
  // filtert WHERE r.created_by = ? - dieser Test misst genau das, nicht nur
  // den Modul-Scope von oben.
  const owner = createHarness({ userId: OWNER });
  try {
    const doc = await owner.call('POST', '', uploadPayload({
      name: 'Privater Reisepass', visibility: 'private', expires_at: daysFromToday(30), expiry_reminder_days: 5,
    }));
    get().prepare("UPDATE reminders SET remind_at = '2000-01-01T09:00' WHERE entity_type = 'document_expiry' AND entity_id = ?")
      .run(doc.body.data.id);

    const ownPending = await owner.callReminders('GET', '/pending');
    assert.ok(ownPending.body.data.some((r) => r.entity_type === 'document_expiry' && r.entity_id === doc.body.data.id),
      'Vorbedingung: der Eigentuemer selbst sieht seine eigene faellige Erinnerung');
  } finally {
    await owner.close();
  }

  const other = createHarness({ userId: OTHER_MEMBER });
  try {
    const pending = await other.callReminders('GET', '/pending');
    assert.equal(pending.status, 200);
    assert.deepEqual(pending.body.data, [], 'ein anderes Mitglied sieht keine fremde Dokument-Erinnerung, privat oder nicht');
  } finally {
    await other.close();
  }
});

// --------------------------------------------------------
// Rechteachse: ein Zugriff ohne `documents`-Scope sieht/loescht nichts
// --------------------------------------------------------

test('/pending mit einem Token ohne documents-Scope zeigt keine document_expiry-Erinnerung', async () => {
  const h = createHarness({ authScopes: null });
  try {
    const doc = await h.call('POST', '', uploadPayload({
      name: 'Faellig, aber ausser Reichweite', expires_at: daysFromToday(30), expiry_reminder_days: 5,
    }));
    get().prepare("UPDATE reminders SET remind_at = '2000-01-01T09:00' WHERE entity_type = 'document_expiry' AND entity_id = ?")
      .run(doc.body.data.id);
  } finally {
    await h.close();
  }

  // Zweiter Harness, echtes gescoptes Credential: nur calendar:read, kein
  // documents-Scope - derselbe echte mayTouchOrigin()-Pfad wie in
  // server/index.js, nicht ein Stub, der ihn umgeht.
  const scoped = createHarness({ authScopes: ['calendar:read'] });
  try {
    const pending = await scoped.callReminders('GET', '/pending');
    assert.equal(pending.status, 200);
    assert.ok(!pending.body.data.some((r) => r.entity_type === 'document_expiry'),
      'ein Credential ohne documents-Scope darf keine Dokumentnamen ueber den Erinnerungs-Toast sehen');
  } finally {
    await scoped.close();
  }
});
