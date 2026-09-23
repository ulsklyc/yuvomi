/**
 * Modul: Health-API-Test
 * Zweck: CRUD, user_id-Scoping und Visibility für Vitalwerte, Medikamente
 *        (+ Schedules/Logs), Laborbefunde (+ Analyten) und Aktivitäten.
 * Ausführen: node --test test/test-health-api.js
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';

const {
  MIGRATIONS,
  _setTestDatabase,
} = await import('../server/db.js');
const { default: healthRouter } = await import('../server/routes/health.js');

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);

const userA = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('alice', 'Alice', '$2b$12$x', 'member')`).run().lastInsertRowid;
const userB = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('bob', 'Bob', '$2b$12$x', 'member')`).run().lastInsertRowid;

let session = { userId: userA, role: 'member' };
const app = express();
// Grosszuegiger als der express.json()-Standard (100kb): sonst wuerde
// body-parser einen ueberlangen Cycle-Import-Body schon VOR der Route mit
// einem HTML-413 abweisen, statt der Route ihre eigene 100-KB-Grenze mit
// einem JSON-400 pruefen zu lassen - genau wie in server/index.js, wo
// BODY_LIMIT (server/utils/upload-limit.js) aus demselben Grund groesser ist
// als jede einzelne Feature-Obergrenze.
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  req.authUserId = session.userId;
  req.authRole = session.role;
  req.session = { userId: session.userId, role: session.role };
  next();
});
app.use('/api/v1/health', healthRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/health`;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function asA() { session = { userId: userA, role: 'member' }; }
function asB() { session = { userId: userB, role: 'member' }; }

// ========================================================
// Vitalwerte
// ========================================================

test('Vitals: POST erstellt Messung, default visibility=private', async () => {
  asA();
  const res = await call('POST', '/vitals', {
    type: 'bp', value_num: 120, value_num2: 80, value_num3: 60, unit: 'mmHg',
    measured_at: '2026-06-01T08:00',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.type, 'bp');
  assert.equal(res.body.data.value_num, 120);
  assert.equal(res.body.data.value_num2, 80);
  assert.equal(res.body.data.visibility, 'private');
  assert.equal(res.body.data.user_id, userA);
});

test('Vitals: POST ohne measured_at → 400', async () => {
  asA();
  const res = await call('POST', '/vitals', { type: 'weight', value_num: 70 });
  assert.equal(res.status, 400);
});

test('Vitals: GET liefert eigene Messungen', async () => {
  asA();
  const res = await call('GET', '/vitals');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
});

test('Vitals: type-Filter greift', async () => {
  asA();
  await call('POST', '/vitals', { type: 'weight', value_num: 71, unit: 'kg', measured_at: '2026-06-02T08:00' });
  const bp = await call('GET', '/vitals?type=bp');
  assert.equal(bp.body.data.length, 1);
  const weight = await call('GET', '/vitals?type=weight');
  assert.equal(weight.body.data.length, 1);
});

test('Vitals: Scoping — Bob sieht Alices private Messungen nicht', async () => {
  asB();
  const res = await call('GET', '/vitals');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 0);
});

test('Vitals: Visibility=family macht Messung für Bob sichtbar', async () => {
  asA();
  const created = await call('POST', '/vitals', {
    type: 'glucose', value_num: 95, unit: 'mg/dL', measured_at: '2026-06-03T08:00', visibility: 'family',
  });
  assert.equal(created.status, 201);
  asB();
  const res = await call('GET', '/vitals');
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].type, 'glucose');
});

test('Vitals: Personen-Filter user_id zeigt nur family-Zeilen fremder Person', async () => {
  asB();
  const res = await call('GET', `/vitals?user_id=${userA}`);
  // Nur die glucose-Messung (family), nicht bp/weight (private)
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].visibility, 'family');
});

test('Vitals: PATCH durch Nicht-Eigentümer → 404', async () => {
  asA();
  const glucose = (await call('GET', '/vitals?type=glucose')).body.data[0];
  asB();
  const res = await call('PATCH', `/vitals/${glucose.id}`, { value_num: 200 });
  assert.equal(res.status, 404);
});

test('Vitals: PATCH durch Eigentümer aktualisiert', async () => {
  asA();
  const glucose = (await call('GET', '/vitals?type=glucose')).body.data[0];
  const res = await call('PATCH', `/vitals/${glucose.id}`, { value_num: 99, visibility: 'private' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.value_num, 99);
  assert.equal(res.body.data.visibility, 'private');
});

test('Vitals: DELETE durch Eigentümer, danach 404', async () => {
  asA();
  const weight = (await call('GET', '/vitals?type=weight')).body.data[0];
  const del = await call('DELETE', `/vitals/${weight.id}`);
  assert.equal(del.status, 204);
  const patch = await call('PATCH', `/vitals/${weight.id}`, { value_num: 1 });
  assert.equal(patch.status, 404);
});

// ========================================================
// Medikamente + Schedules + Logs
// ========================================================

let medId, scheduleId, logId;

test('Medications: POST erstellt Medikament mit Defaults active=1/prn=0', async () => {
  asA();
  const res = await call('POST', '/medications', {
    name: 'Ibuprofen', dosage_text: '400mg', form: 'pill', stock_qty: 20, stock_unit: 'Stk', refill_threshold: 5,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.name, 'Ibuprofen');
  assert.equal(res.body.data.active, 1);
  assert.equal(res.body.data.prn, 0);
  assert.equal(res.body.data.stock_qty, 20);
  medId = res.body.data.id;
});

test('Medications: POST ohne name → 400', async () => {
  asA();
  const res = await call('POST', '/medications', { dosage_text: 'x' });
  assert.equal(res.status, 400);
});

test('Medications: active-Filter', async () => {
  asA();
  await call('POST', '/medications', { name: 'Altmedikament', active: false });
  const active = await call('GET', '/medications?active=true');
  assert.ok(active.body.data.every((m) => m.active === 1));
  const inactive = await call('GET', '/medications?active=false');
  assert.equal(inactive.body.data.length, 1);
  assert.equal(inactive.body.data[0].name, 'Altmedikament');
});

test('Medications: Bob sieht Alices privates Medikament nicht', async () => {
  asB();
  const res = await call('GET', '/medications');
  assert.equal(res.body.data.length, 0);
});

test('Schedules: POST fügt Zeitfenster hinzu', async () => {
  asA();
  const res = await call('POST', `/medications/${medId}/schedules`, {
    time_of_day: '08:00', days_mask: 127, dose_qty: 1,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.time_of_day, '08:00');
  assert.equal(res.body.data.days_mask, 127);
  scheduleId = res.body.data.id;
});

test('Schedules: ungültige days_mask → 400', async () => {
  asA();
  const res = await call('POST', `/medications/${medId}/schedules`, { time_of_day: '09:00', days_mask: 200 });
  assert.equal(res.status, 400);
});

test('Schedules: POST ohne time_of_day → 400', async () => {
  asA();
  const res = await call('POST', `/medications/${medId}/schedules`, { dose_qty: 1 });
  assert.equal(res.status, 400);
});

test('Schedules: Bob kann kein Zeitfenster zu Alices Med hinzufügen → 404', async () => {
  asB();
  const res = await call('POST', `/medications/${medId}/schedules`, { time_of_day: '10:00' });
  assert.equal(res.status, 404);
});

test('Schedules: GET listet, PATCH und DELETE durch Eigentümer', async () => {
  asA();
  const list = await call('GET', `/medications/${medId}/schedules`);
  assert.equal(list.body.data.length, 1);
  const patch = await call('PATCH', `/schedules/${scheduleId}`, { active: false, days_mask: null });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.data.active, 0);
  assert.equal(patch.body.data.days_mask, null);
  const del = await call('DELETE', `/schedules/${scheduleId}`);
  assert.equal(del.status, 204);
});

test('Logs: POST erstellt Dosis-Eintrag (default pending)', async () => {
  asA();
  const res = await call('POST', `/medications/${medId}/logs`, {
    scheduled_at: '2026-06-04T08:00',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'pending');
  logId = res.body.data.id;
});

test('Logs: POST mit pending oder skipped verwirft eine mitgeschickte Einnahmezeit', async () => {
  // Dieselbe Regel wie PATCH und skip: die Zeit gehoert zum Status. Ein
  // "steht aus" oder "nicht genommen" mit Einnahmezeit stuende sonst so im Export.
  asA();
  for (const status of ['pending', 'skipped']) {
    const res = await call('POST', `/medications/${medId}/logs`, {
      status, scheduled_at: '2026-06-03T08:00', taken_at: '2026-06-03T08:05',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, status);
    assert.equal(res.body.data.taken_at, null, `${status} darf keine Einnahmezeit tragen`);
    db.prepare('DELETE FROM medication_logs WHERE id = ?').run(res.body.data.id);
  }
});

test('Logs: take markiert genommen und setzt taken_at', async () => {
  asA();
  const res = await call('POST', `/logs/${logId}/take`, { taken_at: '2026-06-04T08:05' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'taken');
  assert.equal(res.body.data.taken_at, '2026-06-04T08:05');
});

test('Logs: skip markiert übersprungen und löscht taken_at', async () => {
  asA();
  const res = await call('POST', `/logs/${logId}/skip`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'skipped');
  assert.equal(res.body.data.taken_at, null);
});

test('Logs: Bob kann Alices Dosis nicht take → 404', async () => {
  asB();
  const res = await call('POST', `/logs/${logId}/take`);
  assert.equal(res.status, 404);
});

// --------------------------------------------------------
// Korrigieren und Zurücknehmen (#701)
//
// Vorher gab es nur take/skip, also zwei Einbahnstraßen: ein Fehlgriff blieb
// stehen, und zwar nicht nur in der App - die falsche Uhrzeit steht genauso im
// Export, den jemand einer Ärztin hinlegt.
// --------------------------------------------------------

test('Logs: PATCH korrigiert die Einnahmezeit', async () => {
  asA();
  await call('POST', `/logs/${logId}/take`, { taken_at: '2026-06-04T08:05' });
  const res = await call('PATCH', `/logs/${logId}`, { taken_at: '2026-06-04T07:40' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'taken', 'Ohne status-Feld bleibt der Stand, was er war');
  assert.equal(res.body.data.taken_at, '2026-06-04T07:40');
});

test('Logs: PATCH auf pending nimmt das Abhaken zurück und räumt die Uhrzeit ab', async () => {
  asA();
  const res = await call('PATCH', `/logs/${logId}`, { status: 'pending' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'pending');
  assert.equal(res.body.data.taken_at, null,
    'Ein „steht aus" mit Einnahmezeit wäre ein Eintrag, der sich selbst widerspricht');
});

test('Logs: PATCH auf taken ohne Uhrzeit setzt eine, statt eine leere Angabe zu speichern', async () => {
  asA();
  const res = await call('PATCH', `/logs/${logId}`, { status: 'taken' });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.taken_at, 'genommen ohne Zeitpunkt ist keine Aufzeichnung');
});

test('Logs: PATCH mit unbekanntem Status → 400', async () => {
  asA();
  const res = await call('PATCH', `/logs/${logId}`, { status: 'vielleicht' });
  assert.equal(res.status, 400);
});

test('Logs: Bob kann Alices Dosis weder korrigieren noch löschen → 404', async () => {
  asB();
  assert.equal((await call('PATCH', `/logs/${logId}`, { status: 'pending' })).status, 404);
  assert.equal((await call('DELETE', `/logs/${logId}`)).status, 404);
});

test('Logs: ein Eintrag ohne Zeitplan lässt sich löschen', async () => {
  asA();
  const created = await call('POST', `/medications/${medId}/logs`, {
    status: 'taken', taken_at: '2026-06-05T14:00',
  });
  const adHocId = created.body.data.id;
  const res = await call('DELETE', `/logs/${adHocId}`);
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM medication_logs WHERE id = ?').get(adHocId).c, 0);
});

test('Logs: ein geplanter Eintrag lässt sich nicht löschen, nur zurücknehmen', async () => {
  // Der Scheduler legt ihn beim nächsten Lauf wieder an, weil die Dosis
  // weiterhin für diesen Zeitpunkt geplant ist. Das Löschen sähe aus wie ein
  // Erfolg und wäre eine Rückkehr auf Raten.
  asA();
  const sched = await call('POST', `/medications/${medId}/schedules`, { time_of_day: '08:00' });
  const created = await call('POST', `/medications/${medId}/logs`, {
    schedule_id: sched.body.data.id, scheduled_at: '2026-06-06T08:00', status: 'taken',
    taken_at: '2026-06-06T08:03',
  });
  const plannedId = created.body.data.id;

  const res = await call('DELETE', `/logs/${plannedId}`);
  assert.equal(res.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM medication_logs WHERE id = ?').get(plannedId).c, 1);

  const undone = await call('PATCH', `/logs/${plannedId}`, { status: 'pending' });
  assert.equal(undone.status, 200);
  assert.equal(undone.body.data.status, 'pending');
});

// --------------------------------------------------------
// Bedarfsmedikation (#700)
// --------------------------------------------------------

test('PRN: Mindestabstand und Bedarfsdosis werden gespeichert und geändert', async () => {
  asA();
  const created = await call('POST', '/medications', {
    name: 'Excedrin', prn: true, min_interval_hours: 6, prn_dose_qty: 2,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.prn, 1);
  assert.equal(created.body.data.min_interval_hours, 6);
  assert.equal(created.body.data.prn_dose_qty, 2);

  // Halbe Stunden kommen auf Beipackzetteln vor - der Wert ist deshalb REAL.
  const patched = await call('PATCH', `/medications/${created.body.data.id}`, { min_interval_hours: 4.5 });
  assert.equal(patched.body.data.min_interval_hours, 4.5);

  // Und wieder abräumen, wenn der Bedarfshaken fällt.
  const cleared = await call('PATCH', `/medications/${created.body.data.id}`, {
    prn: false, min_interval_hours: null, prn_dose_qty: null,
  });
  assert.equal(cleared.body.data.min_interval_hours, null);
  assert.equal(cleared.body.data.prn_dose_qty, null);
});

test('PRN: ein unmöglicher Mindestabstand wird abgewiesen', async () => {
  asA();
  // 0 und negativ ergäben einen Countdown, der immer abgelaufen ist; alles über
  // vier Wochen beschreibt keine Bedarfsdosis mehr, sondern einen Zeitplan.
  for (const value of [0, -1, 24 * 29, 'bald']) {
    const res = await call('POST', '/medications', { name: 'Kaputt', prn: true, min_interval_hours: value });
    assert.equal(res.status, 400, `min_interval_hours=${value} hätte 400 geben müssen`);
  }
});

test('PRN: eine Dosis ohne Zeitplan taucht in ihrem Zeitraum auf', async () => {
  // Der Kern von #700: Ein Bedarfsmedikament hat keinen Zeitplan, also ist
  // `scheduled_at` NULL - und ein Vergleich mit NULL ist unbekannt. Vorher fiel
  // die Dosis damit aus JEDEM Zeitraum heraus, war also weder im Protokoll zu
  // finden noch als Grundlage für den Countdown zu lesen.
  asA();
  const med = await call('POST', '/medications', { name: 'Bedarfsmittel', prn: true, min_interval_hours: 6 });
  const id = med.body.data.id;

  const logged = await call('POST', `/medications/${id}/logs`, {
    status: 'taken', taken_at: '2026-06-10T12:40',
  });
  assert.equal(logged.status, 201);
  assert.equal(logged.body.data.scheduled_at, null);

  const inRange = await call('GET', `/medications/${id}/logs?from=2026-06-10T00:00&to=2026-06-10T23:59`);
  assert.equal(inRange.body.data.length, 1);
  assert.equal(inRange.body.data[0].taken_at, '2026-06-10T12:40');

  // Und außerhalb ihres Tages bleibt sie draußen - der Filter ist nicht bloß
  // durchlässig geworden.
  const outside = await call('GET', `/medications/${id}/logs?from=2026-06-11T00:00&to=2026-06-11T23:59`);
  assert.equal(outside.body.data.length, 0);
});

test('PRN: die letzte Minute des Tages fällt nicht aus ihrem Tag', async () => {
  // In derselben Spalte liegen zwei Schreibweisen: Wanduhrzeit ohne Zone und
  // ISO mit 'Z' und Sekunden. Ohne den Schnitt auf Minuten wäre '…T23:59:30Z'
  // größer als die Obergrenze '…T23:59'.
  asA();
  const med = await call('POST', '/medications', { name: 'Spätdosis', prn: true });
  const id = med.body.data.id;
  db.prepare(
    "INSERT INTO medication_logs (medication_id, status, taken_at, created_at) VALUES (?, 'taken', NULL, ?)"
  ).run(id, '2026-06-12T23:59:30Z');

  const res = await call('GET', `/medications/${id}/logs?from=2026-06-12T00:00&to=2026-06-12T23:59`);
  assert.equal(res.body.data.length, 1);
});

test('Medications: DELETE kaskadiert Logs (kein Fremdzugriff mehr)', async () => {
  asA();
  const del = await call('DELETE', `/medications/${medId}`);
  assert.equal(del.status, 204);
  const logs = db.prepare('SELECT COUNT(*) AS c FROM medication_logs WHERE medication_id = ?').get(medId);
  assert.equal(logs.c, 0);
});

// ========================================================
// Laborwerte
// ========================================================

let reportId;

test('Labs: POST erstellt Befund mit Analyten + Flag-Ableitung', async () => {
  asA();
  const res = await call('POST', '/labs', {
    report_date: '2026-05-20', lab_name: 'Hausarzt', visibility: 'family',
    results: [
      { analyte: 'Hämoglobin', value_num: 12, unit: 'g/dL', ref_low: 13, ref_high: 17 },   // low
      { analyte: 'Ferritin', value_num: 100, unit: 'ng/mL', ref_low: 30, ref_high: 300 },   // normal
      { analyte: 'CRP', value_num: 8, unit: 'mg/L', ref_low: 0, ref_high: 5 },               // high
    ],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.results.length, 3);
  const byName = Object.fromEntries(res.body.data.results.map((r) => [r.analyte, r.flag]));
  assert.equal(byName['Hämoglobin'], 'low');
  assert.equal(byName['Ferritin'], 'normal');
  assert.equal(byName['CRP'], 'high');
  reportId = res.body.data.id;
});

test('Labs: POST ohne report_date → 400', async () => {
  asA();
  const res = await call('POST', '/labs', { lab_name: 'X' });
  assert.equal(res.status, 400);
});

test('Labs: GET listet Befunde mit results; family für Bob sichtbar', async () => {
  asB();
  const res = await call('GET', '/labs');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].results.length, 3);
});

test('Labs: GET :id durch Bob (family) erlaubt, PATCH durch Bob → 404', async () => {
  asB();
  const get = await call('GET', `/labs/${reportId}`);
  assert.equal(get.status, 200);
  const patch = await call('PATCH', `/labs/${reportId}`, { lab_name: 'Hack' });
  assert.equal(patch.status, 404);
});

test('Labs: POST /results fügt Analyt hinzu, DELETE entfernt ihn', async () => {
  asA();
  const add = await call('POST', `/labs/${reportId}/results`, {
    analyte: 'Vitamin D', value_num: 25, unit: 'ng/mL', ref_low: 30, ref_high: 100,
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.data.flag, 'low');
  const del = await call('DELETE', `/results/${add.body.data.id}`);
  assert.equal(del.status, 204);
});

test('Labs: Bob kann Analyt nicht hinzufügen → 404', async () => {
  asB();
  const res = await call('POST', `/labs/${reportId}/results`, { analyte: 'X', value_num: 1 });
  assert.equal(res.status, 404);
});

test('Labs: DELETE Befund kaskadiert Analyten', async () => {
  asA();
  const del = await call('DELETE', `/labs/${reportId}`);
  assert.equal(del.status, 204);
  const results = db.prepare('SELECT COUNT(*) AS c FROM health_lab_results WHERE report_id = ?').get(reportId);
  assert.equal(results.c, 0);
});

// ========================================================
// Aktivitäten
// ========================================================

test('Activities: POST/GET/PATCH/DELETE durch Eigentümer', async () => {
  asA();
  const create = await call('POST', '/activities', {
    type: 'run', duration_min: 30, distance_km: 5, performed_at: '2026-06-05T18:00',
  });
  assert.equal(create.status, 201);
  assert.equal(create.body.data.type, 'run');
  const id = create.body.data.id;

  const list = await call('GET', '/activities');
  assert.equal(list.body.data.length, 1);

  const patch = await call('PATCH', `/activities/${id}`, { duration_min: 45 });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.data.duration_min, 45);

  const del = await call('DELETE', `/activities/${id}`);
  assert.equal(del.status, 204);
});

test('Activities: Scoping — Bob sieht Alices private Aktivität nicht', async () => {
  asA();
  await call('POST', '/activities', { type: 'walk', duration_min: 20, performed_at: '2026-06-06T09:00' });
  asB();
  const res = await call('GET', '/activities');
  assert.equal(res.body.data.length, 0);
});

test('Activities: POST ohne performed_at → 400', async () => {
  asA();
  const res = await call('POST', '/activities', { type: 'run', duration_min: 10 });
  assert.equal(res.status, 400);
});

// ========================================================
// CSV-Export
// ========================================================

async function callCsv(path) {
  const res = await fetch(`${base}${path}`, { method: 'GET' });
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    disposition: res.headers.get('content-disposition'),
    text,
  };
}

test('Export vitals: text/csv-Header, Attachment, Header-Zeile + eigene Daten', async () => {
  asA();
  await call('POST', '/vitals', { type: 'weight', value_num: 77, unit: 'kg', measured_at: '2026-06-20T08:00', note: 'exp-marker-A' });
  const res = await callCsv('/export/vitals');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/csv/);
  assert.match(res.disposition, /attachment; filename="health-vitals/);
  assert.ok(res.text.includes('"measured_at","type","value_num"'));
  assert.ok(res.text.includes('exp-marker-A'));
});

test('Export vitals: Scoping — Bob sieht Alices private Zeile nicht', async () => {
  asB();
  const res = await callCsv('/export/vitals');
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes('exp-marker-A'));
});

test('Export vitals: Zeitraum-Filter greift', async () => {
  asA();
  await call('POST', '/vitals', { type: 'weight', value_num: 70, unit: 'kg', measured_at: '2020-01-01T08:00', note: 'exp-old-marker' });
  const inRange = await callCsv('/export/vitals?from=2026-01-01&to=2026-12-31');
  assert.ok(!inRange.text.includes('exp-old-marker'));
  const all = await callCsv('/export/vitals');
  assert.ok(all.text.includes('exp-old-marker'));
});

test('Export meds-logs: enthält Medikamentenname und Status', async () => {
  asA();
  const med = await call('POST', '/medications', { name: 'ExportMed-Zed' });
  const medId = med.body.data.id;
  await call('POST', `/medications/${medId}/logs`, { status: 'taken', scheduled_at: '2026-06-21T08:00', taken_at: '2026-06-21T08:05', dose_qty: 1 });
  const res = await callCsv('/export/meds-logs');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/csv/);
  assert.ok(res.text.includes('"scheduled_at","medication","status"'));
  assert.ok(res.text.includes('ExportMed-Zed'));
  assert.ok(res.text.includes('"taken"'));
});

test('Export labs: eine Zeile je Analyt', async () => {
  asA();
  await call('POST', '/labs', {
    report_date: '2026-06-22', lab_name: 'ExportLab-Q', visibility: 'private',
    results: [
      { analyte: 'ExpHb', value_num: 14, unit: 'g/dL', ref_low: 13, ref_high: 17 },
      { analyte: 'ExpGlc', value_num: 90, unit: 'mg/dL' },
    ],
  });
  const res = await callCsv('/export/labs');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('ExpHb'));
  assert.ok(res.text.includes('ExpGlc'));
});

// ========================================================
// ZYKLUS (Menstruation)
// ========================================================

test('Cycle: Periode anlegen, lesen, patchen, löschen', async () => {
  asA();
  const created = await call('POST', '/cycle/periods', { start_date: '2026-05-01', end_date: '2026-05-05', note: 'cycle-marker-A' });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal(created.body.data.visibility, 'private');

  const list = await call('GET', '/cycle/periods');
  assert.ok(list.body.data.some((p) => p.id === id));

  const patched = await call('PATCH', `/cycle/periods/${id}`, { end_date: '2026-05-06' });
  assert.equal(patched.body.data.end_date, '2026-05-06');

  const del = await call('DELETE', `/cycle/periods/${id}`);
  assert.equal(del.status, 204);
});

test('Cycle: end_date vor start_date wird abgelehnt', async () => {
  asA();
  const res = await call('POST', '/cycle/periods', { start_date: '2026-05-10', end_date: '2026-05-01' });
  assert.equal(res.status, 400);
});

test('Cycle: Scoping — Bob sieht Alices private Periode nicht, family schon', async () => {
  asA();
  const priv = await call('POST', '/cycle/periods', { start_date: '2026-06-01', note: 'cycle-priv-A' });
  const fam = await call('POST', '/cycle/periods', { start_date: '2026-06-02', visibility: 'family', note: 'cycle-fam-A' });
  asB();
  const asBob = await call('GET', `/cycle/periods?user_id=${userA}`);
  const ids = asBob.body.data.map((p) => p.id);
  assert.ok(ids.includes(fam.body.data.id));
  assert.ok(!ids.includes(priv.body.data.id));
  // Fremde Periode darf Bob nicht ändern/löschen (404 statt Fremdzugriff).
  const forbidden = await call('PATCH', `/cycle/periods/${priv.body.data.id}`, { note: 'hack' });
  assert.equal(forbidden.status, 404);
});

test('Cycle-Log: Upsert je Person/Tag (zweiter POST aktualisiert)', async () => {
  asA();
  const first = await call('POST', '/cycle/logs', { log_date: '2026-05-02', flow: 'light', symptoms: ['cramps', 'fatigue'], mood: 'sad' });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.flow, 'light');
  // symptoms ist seit Phase 2 {key, intensity}[] statt einer Komma-Zeile - das
  // alte String-Array-Format bleibt als Eingabe gültig, ergibt aber
  // intensity: null (die gab es vor Phase 2 nicht).
  assert.deepEqual(first.body.data.symptoms, [{ key: 'cramps', intensity: null }, { key: 'fatigue', intensity: null }]);
  const firstId = first.body.data.id;

  const second = await call('POST', '/cycle/logs', { log_date: '2026-05-02', flow: 'heavy', symptoms: [{ key: 'cramps', intensity: 2 }] });
  assert.equal(second.body.data.id, firstId); // gleiche Zeile
  assert.equal(second.body.data.flow, 'heavy');
  // Voller Ersatz, kein Merge: 'fatigue' aus dem ersten POST ist weg.
  assert.deepEqual(second.body.data.symptoms, [{ key: 'cramps', intensity: 2 }]);

  const list = await call('GET', '/cycle/logs');
  assert.equal(list.body.data.filter((l) => l.log_date === '2026-05-02').length, 1);
});

test('Cycle-Log: ungültiger Flow-Wert wird abgelehnt', async () => {
  asA();
  const res = await call('POST', '/cycle/logs', { log_date: '2026-05-03', flow: 'gushing' });
  assert.equal(res.status, 400);
});

test('Cycle-Settings: Default ohne Zeile, dann Upsert', async () => {
  asB();
  const def = await call('GET', '/cycle/settings');
  assert.equal(def.status, 200);
  assert.equal(def.body.data.luteal_length, 14);
  assert.equal(def.body.data.cycle_length_avg, null);

  const saved = await call('PUT', '/cycle/settings', { cycle_length_avg: 30, period_length_avg: 6, luteal_length: 13, track_fertility: false });
  assert.equal(saved.body.data.cycle_length_avg, 30);
  assert.equal(saved.body.data.track_fertility, 0);

  const reread = await call('GET', '/cycle/settings');
  assert.equal(reread.body.data.cycle_length_avg, 30);
});

test('Cycle-Settings: Werte außerhalb des Bereichs werden abgelehnt', async () => {
  asA();
  const res = await call('PUT', '/cycle/settings', { cycle_length_avg: 99 });
  assert.equal(res.status, 400);
});

test('Cycle-Settings: Schwangerschafts-Modus + Entbindungstermin (#450)', async () => {
  asB();
  const def = await call('GET', '/cycle/settings');
  assert.equal(def.body.data.pregnancy_mode, 0);
  assert.equal(def.body.data.pregnancy_due_date, null);

  const saved = await call('PUT', '/cycle/settings', { pregnancy_mode: true, pregnancy_due_date: '2027-01-15' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.pregnancy_mode, 1);
  assert.equal(saved.body.data.pregnancy_due_date, '2027-01-15');

  // Modus aus → Termin bleibt erhalten (nur im aktiven Modus genutzt), damit
  // versehentliches Umschalten die Eingabe nicht löscht.
  const off = await call('PUT', '/cycle/settings', { pregnancy_mode: false, pregnancy_due_date: '2027-01-15' });
  assert.equal(off.body.data.pregnancy_mode, 0);
  assert.equal(off.body.data.pregnancy_due_date, '2027-01-15');
});

test('Cycle-Settings: ungültiges Entbindungsdatum wird abgelehnt', async () => {
  asA();
  const res = await call('PUT', '/cycle/settings', { pregnancy_mode: true, pregnancy_due_date: '15.01.2027' });
  assert.equal(res.status, 400);
});

test('Cycle-Settings: default_visibility – Default privat, Upsert, Validierung (#550)', async () => {
  asB();
  const def = await call('GET', '/cycle/settings');
  assert.equal(def.body.data.default_visibility, 'private');

  const saved = await call('PUT', '/cycle/settings', { default_visibility: 'family' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.default_visibility, 'family');

  const bad = await call('PUT', '/cycle/settings', { default_visibility: 'public' });
  assert.equal(bad.status, 400);
});

test('Cycle-Settings: neue Felder - Default, Upsert (Verhütung, Perimenopause, PMS)', async () => {
  asB();
  const def = await call('GET', '/cycle/settings');
  assert.equal(def.body.data.contraception, null);
  assert.equal(def.body.data.perimenopause_mode, 0);
  assert.equal(def.body.data.show_pms, 1);
  assert.equal(def.body.data.notify_partner_user_id, null);
  assert.equal(def.body.data.notify_partner_days_before, null);

  const saved = await call('PUT', '/cycle/settings', {
    contraception: 'hormonal_iud', perimenopause_mode: true, show_pms: false,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.contraception, 'hormonal_iud');
  assert.equal(saved.body.data.perimenopause_mode, 1);
  assert.equal(saved.body.data.show_pms, 0);

  const reread = await call('GET', '/cycle/settings');
  assert.equal(reread.body.data.contraception, 'hormonal_iud');
});

test('Cycle-Settings: ungültiger contraception-Wert wird abgelehnt', async () => {
  asB();
  const res = await call('PUT', '/cycle/settings', { contraception: 'herbal' });
  assert.equal(res.status, 400);
});

test('Cycle-Settings: Partner-Benachrichtigung - gültiges Haushaltsmitglied, dann per Voll-Ersetzen wieder gelöscht', async () => {
  asA();
  const saved = await call('PUT', '/cycle/settings', {
    notify_partner_user_id: userB, notify_partner_days_before: 2,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.notify_partner_user_id, userB);
  assert.equal(saved.body.data.notify_partner_days_before, 2);

  // Diese Route ersetzt vollständig (wie jedes andere Feld hier) - ein PUT
  // ohne das Feld räumt es wieder ab, statt den Bestandswert zu erhalten.
  const cleared = await call('PUT', '/cycle/settings', {});
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.notify_partner_user_id, null);
});

test('Cycle-Settings: PUT liefert eligible_partners mit, damit zwei Saves hintereinander den Partner nicht verlieren', async () => {
  asA();
  const first = await call('PUT', '/cycle/settings', {
    notify_partner_user_id: userB, notify_partner_days_before: 2,
  });
  assert.equal(first.status, 200);
  assert.ok(Array.isArray(first.body.data.eligible_partners), 'PUT muss eligible_partners wie GET mitliefern');
  assert.ok(first.body.data.eligible_partners.some((p) => p.id === userB));

  // Zweiter Save wie es das Frontend tatsaechlich tut: das im Speicher
  // gehaltene cycle.settings-Objekt (aus der ersten Antwort) wird vollstaendig
  // erneut gesendet, nur ein unbeteiligtes Feld (show_pms) aendert sich. Ohne
  // eligible_partners in der ersten Antwort waere die Partner-Auswahl im
  // Modal beim erneuten Oeffnen leer gewesen und ein Save haette
  // notify_partner_user_id stillschweigend auf null gesetzt.
  const second = await call('PUT', '/cycle/settings', {
    notify_partner_user_id: first.body.data.notify_partner_user_id,
    notify_partner_days_before: first.body.data.notify_partner_days_before,
    show_pms: false,
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.notify_partner_user_id, userB, 'der Partner muss den zweiten Save unveraendert ueberleben');
  assert.equal(second.body.data.show_pms, 0);
  assert.ok(Array.isArray(second.body.data.eligible_partners), 'auch die zweite Antwort muss eligible_partners tragen');
  assert.ok(second.body.data.eligible_partners.some((p) => p.id === userB));
});

test('Cycle-Settings: notify_partner_user_id lehnt eine unbekannte Person ab (400)', async () => {
  asA();
  const res = await call('PUT', '/cycle/settings', { notify_partner_user_id: 999999 });
  assert.equal(res.status, 400);
});

test('Cycle-Settings: notify_partner_user_id lehnt einen nicht-numerischen Wert ab (400), statt ihn wie parseInt() vorne abzuschneiden', async () => {
  asA();
  // Der Praefix ist absichtlich Bobs echte (gueltige) user_id: parseInt()
  // wuerde still `${userB}` lesen und die eigentlich unsinnige Eingabe als
  // gueltigen, sogar berechtigten Partner akzeptieren - Number.isInteger()
  // auf Number(...) muss den Wert als Ganzes ablehnen.
  const res = await call('PUT', '/cycle/settings', { notify_partner_user_id: `${userB}abc` });
  assert.equal(res.status, 400);
});

test('Cycle-Settings: notify_partner_user_id lehnt die aufrufende Person selbst ab (400)', async () => {
  asA();
  const res = await call('PUT', '/cycle/settings', { notify_partner_user_id: userA });
  assert.equal(res.status, 400);
});

test('Cycle-Settings: notify_partner_days_before außerhalb 0-14 wird abgelehnt', async () => {
  asA();
  const res = await call('PUT', '/cycle/settings', { notify_partner_user_id: userB, notify_partner_days_before: 30 });
  assert.equal(res.status, 400);
});

// eligible_partners - nur wer die Meldung tatsaechlich bekaeme
// (Haushaltsmitglied, Health-Zugriff, kein Kind), nie die aufrufende Person
// selbst.
const userChild = db.prepare(`INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('junior', 'Junior', '$2b$12$x', 'member', 'child')`).run().lastInsertRowid;
const userNoHealth = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('nora', 'Nora', '$2b$12$x', 'member')`).run().lastInsertRowid;
db.prepare(`INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
  VALUES ('user', ?, 'module', 'health', 'none')`).run(String(userNoHealth));

test('Cycle-Settings: eligible_partners nennt Haushaltsmitglieder mit Health-Zugriff, nie sich selbst, nie Kinder, nie Health-gesperrte', async () => {
  asA();
  const res = await call('GET', '/cycle/settings');
  assert.equal(res.status, 200);
  const ids = res.body.data.eligible_partners.map((p) => p.id);
  assert.ok(ids.includes(userB), 'Bob hat Health-Zugriff und ist kein Kind - muss auftauchen');
  assert.ok(!ids.includes(userA), 'die aufrufende Person selbst darf nicht in ihrer eigenen Liste stehen');
  assert.ok(!ids.includes(userChild), 'ein Kind darf nicht als Partner-Ziel angeboten werden');
  assert.ok(!ids.includes(userNoHealth), 'wer keinen Health-Zugriff hat, bekaeme die Meldung nie und darf nicht auftauchen');
  const bobEntry = res.body.data.eligible_partners.find((p) => p.id === userB);
  assert.equal(bobEntry.display_name, 'Bob');
});

test('Cycle-Settings: notify_partner_user_id lehnt ein Kind ab (400)', async () => {
  asA();
  const res = await call('PUT', '/cycle/settings', { notify_partner_user_id: userChild });
  assert.equal(res.status, 400);
});

test('Cycle-Settings: notify_partner_user_id lehnt ein Haushaltsmitglied ohne Health-Zugriff ab (400)', async () => {
  asA();
  const res = await call('PUT', '/cycle/settings', { notify_partner_user_id: userNoHealth });
  assert.equal(res.status, 400);
});

test('Cycle: Bulk-Sichtbarkeit flippt eigene Einträge, fremde bleiben unberührt (#550)', async () => {
  asA();
  const foreign = await call('POST', '/cycle/periods', { start_date: '2026-09-01', note: 'bulk-foreign-A' });

  asB();
  const p = await call('POST', '/cycle/periods', { start_date: '2026-09-02', note: 'bulk-B-period' });
  const l = await call('POST', '/cycle/logs', { log_date: '2026-09-02', flow: 'light' });
  assert.equal(p.body.data.visibility, 'private');
  assert.equal(l.body.data.visibility, 'private');

  const bulk = await call('PATCH', '/cycle/visibility', { visibility: 'family' });
  assert.equal(bulk.status, 200);
  assert.ok(bulk.body.data.periods >= 1);
  assert.ok(bulk.body.data.logs >= 1);

  const periods = await call('GET', '/cycle/periods');
  assert.equal(periods.body.data.find((x) => x.id === p.body.data.id).visibility, 'family');
  const logs = await call('GET', '/cycle/logs');
  assert.equal(logs.body.data.find((x) => x.id === l.body.data.id).visibility, 'family');

  // Bulk ist strikt eigen-scoped: Alices Periode bleibt privat.
  asA();
  const aPeriods = await call('GET', '/cycle/periods');
  assert.equal(aPeriods.body.data.find((x) => x.id === foreign.body.data.id).visibility, 'private');

  // Ungültiger Wert wird abgelehnt.
  const badVal = await call('PATCH', '/cycle/visibility', { visibility: 'public' });
  assert.equal(badVal.status, 400);
});

test('Export cycle: CSV mit Perioden- und Zykluslänge', async () => {
  asA();
  await call('POST', '/cycle/periods', { start_date: '2026-01-05', end_date: '2026-01-09', note: 'exp-cyc-1' });
  await call('POST', '/cycle/periods', { start_date: '2026-02-02', end_date: '2026-02-06', note: 'exp-cyc-2' });
  const res = await callCsv('/export/cycle');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/csv/);
  assert.ok(res.text.includes('"start_date","end_date","period_length_days","cycle_length_days"'));
  assert.ok(res.text.includes('exp-cyc-1'));
  assert.ok(res.text.includes('"28"')); // Abstand 05.01 → 02.02
});

// ========================================================
// ZYKLUS: Perioden-Historie-Import
// ========================================================

test('Cycle-Import: ohne csv-Feld -> 400', async () => {
  asA();
  const res = await call('POST', '/cycle/import', {});
  assert.equal(res.status, 400);
});

test('Cycle-Import: CSV mit Kopfzeile importiert alle gültigen Zeilen', async () => {
  asA();
  const csv = 'start_date,end_date\n2027-01-01,2027-01-05\n2027-02-01,2027-02-06\n';
  const res = await call('POST', '/cycle/import', { csv });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.imported, 2);
  assert.equal(res.body.data.skipped, 0);
  assert.deepEqual(res.body.data.errors, []);

  const list = await call('GET', '/cycle/periods?from=2027-01-01&to=2027-02-01');
  assert.ok(list.body.data.some((p) => p.start_date === '2027-01-01' && p.end_date === '2027-01-05'));
  assert.ok(list.body.data.some((p) => p.start_date === '2027-02-01' && p.end_date === '2027-02-06'));
});

test('Cycle-Import: eine Zeile mit vorhandenem start_date wird übersprungen (gezählt, kein Fehler)', async () => {
  asA();
  const csv = 'start_date,end_date\n2027-01-01,2027-01-04\n2027-03-01,2027-03-05\n';
  const res = await call('POST', '/cycle/import', { csv });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.imported, 1);
  assert.equal(res.body.data.skipped, 1);

  // Die vorhandene Periode (aus dem Test darüber) behält ihr eigenes end_date -
  // ein Duplikat wird übersprungen, nicht überschrieben.
  const list = await call('GET', '/cycle/periods?from=2027-01-01&to=2027-01-02');
  assert.equal(list.body.data.find((p) => p.start_date === '2027-01-01').end_date, '2027-01-05');
});

test('Cycle-Import: Semikolon-Trennzeichen und DD.MM.YYYY (deutscher Excel-Export), ohne Kopfzeile', async () => {
  asA();
  const csv = '01.04.2027;05.04.2027\n15.04.2027;';
  const res = await call('POST', '/cycle/import', { csv });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.imported, 2);

  const list = await call('GET', '/cycle/periods?from=2027-04-01&to=2027-04-30');
  assert.ok(list.body.data.some((p) => p.start_date === '2027-04-01' && p.end_date === '2027-04-05'));
  assert.ok(list.body.data.some((p) => p.start_date === '2027-04-15' && p.end_date === null));
});

test('Cycle-Import: eine ungültige Zeile verwirft den gesamten Import (Transaktion, nichts wird eingefügt)', async () => {
  asA();
  const before = await call('GET', '/cycle/periods');
  const beforeCount = before.body.data.length;

  const csv = 'start_date,end_date\n2027-05-01,2027-05-05\n2027-06-99,\n';
  const res = await call('POST', '/cycle/import', { csv });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
  assert.equal(res.body.errors.length, 1);
  assert.match(res.body.errors[0], /Row 2/);

  const after = await call('GET', '/cycle/periods');
  assert.equal(after.body.data.length, beforeCount, 'nichts darf eingefügt worden sein');
});

test('Cycle-Import: end_date vor start_date ist ein Zeilenfehler (400, nichts eingefügt)', async () => {
  asA();
  const before = await call('GET', '/cycle/periods');
  const csv = 'start_date,end_date\n2033-01-10,2033-01-01\n';
  const res = await call('POST', '/cycle/import', { csv });
  assert.equal(res.status, 400);
  assert.match(res.body.errors[0], /end_date must not be before start_date/);
  const after = await call('GET', '/cycle/periods');
  assert.equal(after.body.data.length, before.body.data.length);
});

test('Cycle-Import: Fehlerliste ist auf die ersten 10 Zeilen begrenzt', async () => {
  asA();
  const rows = Array.from({ length: 15 }, () => '2034-99-99,').join('\n');
  const csv = `start_date,end_date\n${rows}`;
  const res = await call('POST', '/cycle/import', { csv });
  assert.equal(res.status, 400);
  assert.equal(res.body.errors.length, 10);
});

test('Cycle-Import: mehr als 500 Datenzeilen werden abgelehnt (400)', async () => {
  asA();
  const rows = Array.from({ length: 501 }, () => '2030-01-01,').join('\n');
  const csv = `start_date,end_date\n${rows}`;
  const res = await call('POST', '/cycle/import', { csv });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /500/);
});

test('Cycle-Import: CSV über 100 KB wird abgelehnt (400)', async () => {
  asA();
  const csv = 'start_date,end_date\n' + '2030-02-01,2030-02-05\n'.repeat(6000);
  const res = await call('POST', '/cycle/import', { csv });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /102400 bytes/);
});

test('Cycle-Import: übernimmt die eigene default_visibility aus den Cycle-Settings', async () => {
  asA();
  await call('PUT', '/cycle/settings', { default_visibility: 'family' });
  const csv = 'start_date,end_date\n2031-01-01,2031-01-05\n';
  const res = await call('POST', '/cycle/import', { csv });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.imported, 1);

  const list = await call('GET', '/cycle/periods?from=2031-01-01&to=2031-01-02');
  assert.equal(list.body.data.find((p) => p.start_date === '2031-01-01').visibility, 'family');

  await call('PUT', '/cycle/settings', { default_visibility: 'private' });
});

test('Cycle-Import: importierte Perioden bleiben scoped wie jede andere - Bob sieht Alices Import nicht', async () => {
  asA();
  const csv = 'start_date,end_date\n2032-01-01,2032-01-05\n';
  await call('POST', '/cycle/import', { csv });

  asB();
  const list = await call('GET', '/cycle/periods?from=2032-01-01&to=2032-01-02');
  assert.equal(list.body.data.length, 0);
});

// ========================================================
// ZYKLUS v2: Zervixschleim/Tests/Intimacy, Mehrfach-Gefühle (Migrationen 210-211)
// ========================================================

test('Cycle-Log: neue Skalarfelder + feelings im Round-Trip', async () => {
  asA();
  const created = await call('POST', '/cycle/logs', {
    log_date: '2030-01-01', flow: 'light',
    cervix_mucus: 'eggwhite', lh_test: 'positive', pregnancy_test: 'negative',
    intimacy: 'protected', feelings: ['good', 'irritable'],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.cervix_mucus, 'eggwhite');
  assert.equal(created.body.data.lh_test, 'positive');
  assert.equal(created.body.data.pregnancy_test, 'negative');
  assert.equal(created.body.data.intimacy, 'protected');
  assert.deepEqual(created.body.data.feelings, ['good', 'irritable']);
  // Die mood-Spalte wird seit Migration 211 nie mehr beschrieben, auch nicht,
  // wenn nur `feelings` gesendet wird.
  assert.equal(created.body.data.mood, null);

  const list = await call('GET', '/cycle/logs?from=2030-01-01&to=2030-01-01');
  const row = list.body.data.find((l) => l.log_date === '2030-01-01');
  assert.deepEqual(row.feelings, ['good', 'irritable']);
  assert.equal(row.cervix_mucus, 'eggwhite');
  assert.equal(row.intimacy, 'protected');
});

test('Cycle-Log: ungültige Werte für die neuen Enum-Felder werden je einzeln abgelehnt (400)', async () => {
  asA();
  const cases = [
    { cervix_mucus: 'slippery' },
    { lh_test: 'maybe' },
    { pregnancy_test: 'unsure' },
    { intimacy: 'yes' },
  ];
  for (const extra of cases) {
    const res = await call('POST', '/cycle/logs', { log_date: '2030-01-02', ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra));
  }
});

test('Cycle-Log: unbekannter feelings-Schlüssel wird abgelehnt (400)', async () => {
  asA();
  const res = await call('POST', '/cycle/logs', { log_date: '2030-01-03', feelings: ['ecstatic'] });
  assert.equal(res.status, 400);
});

test('Cycle-Log: legacy mood ohne feelings wird zu feelings:[mood], mood-Spalte bleibt NULL', async () => {
  asA();
  const res = await call('POST', '/cycle/logs', { log_date: '2030-01-04', mood: 'sensitive' });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.data.feelings, ['sensitive']);
  assert.equal(res.body.data.mood, null);
});

test('Cycle-Log: ungültiger legacy mood-Wert wird abgelehnt wie ein ungültiges feelings-Element', async () => {
  asA();
  const res = await call('POST', '/cycle/logs', { log_date: '2030-01-05', mood: 'furious' });
  assert.equal(res.status, 400);
});

// Der Upsert setzt `mood = NULL` nur dann aktiv, wenn der Request `feelings`
// oder das legacy `mood`-Feld tatsaechlich als Schluessel enthaelt - er will
// dann diesen Wert ersetzen. Ein Save, der keinen der beiden Schluessel
// mitschickt (z. B. nur `flow` aendert), darf einen schon vor Migration 211
// (oder direkt in der DB) eingefrorenen Legacy-Wert nicht zerstoeren, sonst
// vernichtet JEDE unbeteiligte Aenderung an einem solchen Tag dauerhaft einen
// echten Freitext-Mood.
test('Cycle-Log: ein eingefrorener Legacy-mood-Wert wird genullt, wenn feelings/mood explizit mitgeschickt werden', async () => {
  asA();
  const created = await call('POST', '/cycle/logs', { log_date: '2030-01-06', flow: 'light' });
  assert.equal(created.status, 201);
  const id = created.body.data.id;

  // Legacy-Zustand simulieren: `mood` direkt setzen, wie es eine Zeile von vor
  // Migration 211 (oder ein alter Client) getragen haette - die API selbst
  // schreibt `mood` nie mehr.
  db.prepare('UPDATE cycle_day_logs SET mood = ? WHERE id = ?').run('sad', id);
  assert.equal(db.prepare('SELECT mood FROM cycle_day_logs WHERE id = ?').get(id).mood, 'sad');

  // Erneutes Speichern desselben Tages MIT `feelings` im Body (auch ein
  // leeres Array zaehlt, siehe normalizeFeelings()) - muss die Spalte jetzt
  // aktiv leeren.
  const updated = await call('POST', '/cycle/logs', { log_date: '2030-01-06', flow: 'heavy', feelings: [] });
  assert.equal(updated.status, 201);
  assert.equal(updated.body.data.id, id);
  assert.equal(updated.body.data.mood, null);
  assert.equal(db.prepare('SELECT mood FROM cycle_day_logs WHERE id = ?').get(id).mood, null);
});

test('Cycle-Log: ein eingefrorener Legacy-mood-Wert bleibt erhalten, wenn ein Save weder feelings noch mood mitschickt', async () => {
  asA();
  // Zuerst eine echte Gefuehls-Zeile anlegen (statt eines Tages ohne jede
  // Gefuehls-Angabe) - sonst waere "feelings bleibt leer" weiter unten trivial
  // wahr und ein Bug, der bestehende Gefuehle bei jedem Save loescht, wuerde
  // gar nicht auffallen.
  const created = await call('POST', '/cycle/logs', { log_date: '2030-01-07', flow: 'light', feelings: ['good'] });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.deepEqual(created.body.data.feelings, ['good']);

  // Gleicher Legacy-Zustand wie oben.
  db.prepare('UPDATE cycle_day_logs SET mood = ? WHERE id = ?').run('melancholic', id);
  assert.equal(db.prepare('SELECT mood FROM cycle_day_logs WHERE id = ?').get(id).mood, 'melancholic');

  // Erneutes Speichern desselben Tages OHNE `feelings`/`mood` im Body - nur
  // unbeteiligte Felder (flow, note, basal_temp) aendern sich. Der Altwert
  // muss unangetastet bleiben.
  const updated = await call('POST', '/cycle/logs', {
    log_date: '2030-01-07', flow: 'heavy', note: 'nur eine Notiz', basal_temp: 36.6, basal_temp_unit: 'c',
  });
  assert.equal(updated.status, 201);
  assert.equal(updated.body.data.id, id);
  assert.equal(updated.body.data.flow, 'heavy');
  assert.equal(updated.body.data.mood, 'melancholic');
  assert.equal(db.prepare('SELECT mood FROM cycle_day_logs WHERE id = ?').get(id).mood, 'melancholic');
  // Auch die zuvor gesetzte Gefuehls-Zeile muss ein Save ohne `feelings`/`mood`
  // unangetastet lassen - nicht nur "leer bleibt leer".
  assert.deepEqual(updated.body.data.feelings, ['good']);
});

test('Cycle-Log: intimacy ist hart privat - Eigentümer sieht es, family-Mitglied nicht', async () => {
  asA();
  const created = await call('POST', '/cycle/logs', {
    log_date: '2030-01-06', flow: 'medium', intimacy: 'unprotected', visibility: 'family',
  });
  assert.equal(created.body.data.intimacy, 'unprotected');

  asB();
  const asBob = await call('GET', `/cycle/logs?user_id=${userA}&from=2030-01-06&to=2030-01-06`);
  const bobRow = asBob.body.data.find((l) => l.log_date === '2030-01-06');
  assert.ok(bobRow, 'Bob sollte die family-Zeile sehen');
  assert.ok(!('intimacy' in bobRow), 'intimacy darf für Bob nicht einmal als Schlüssel auftauchen');

  asA();
  const asAlice = await call('GET', '/cycle/logs?from=2030-01-06&to=2030-01-06');
  assert.equal(asAlice.body.data.find((l) => l.log_date === '2030-01-06').intimacy, 'unprotected');
});

test('Cycle: Bulk-Sichtbarkeit auf family lässt intimacy trotzdem verborgen', async () => {
  asA();
  await call('POST', '/cycle/logs', { log_date: '2030-01-07', intimacy: 'solo', visibility: 'private' });
  const bulk = await call('PATCH', '/cycle/visibility', { visibility: 'family' });
  assert.equal(bulk.status, 200);

  asB();
  const asBob = await call('GET', `/cycle/logs?user_id=${userA}&from=2030-01-07&to=2030-01-07`);
  const bobRow = asBob.body.data.find((l) => l.log_date === '2030-01-07');
  assert.ok(bobRow, 'nach dem Bulk-Umschalten sollte Bob die jetzt family-sichtbare Zeile sehen');
  assert.ok(!('intimacy' in bobRow));
});

// Owner-only wie intimacy: cervix_mucus, lh_test und pregnancy_test sind
// ebenfalls hart privat, unabhängig von der Zeilen-Sichtbarkeit - dieselbe
// Erwartung, drei Felder, je ein eigener Test.
test('Cycle-Log: cervix_mucus ist hart privat - Eigentümer sieht es, family-Mitglied nicht', async () => {
  asA();
  const created = await call('POST', '/cycle/logs', {
    log_date: '2030-01-08', flow: 'medium', cervix_mucus: 'eggwhite', visibility: 'family',
  });
  assert.equal(created.body.data.cervix_mucus, 'eggwhite');

  asB();
  const asBob = await call('GET', `/cycle/logs?user_id=${userA}&from=2030-01-08&to=2030-01-08`);
  const bobRow = asBob.body.data.find((l) => l.log_date === '2030-01-08');
  assert.ok(bobRow, 'Bob sollte die family-Zeile sehen');
  assert.ok(!('cervix_mucus' in bobRow), 'cervix_mucus darf für Bob nicht einmal als Schlüssel auftauchen');

  asA();
  const asAlice = await call('GET', '/cycle/logs?from=2030-01-08&to=2030-01-08');
  assert.equal(asAlice.body.data.find((l) => l.log_date === '2030-01-08').cervix_mucus, 'eggwhite');
});

test('Cycle-Log: lh_test ist hart privat - Eigentümer sieht es, family-Mitglied nicht', async () => {
  asA();
  const created = await call('POST', '/cycle/logs', {
    log_date: '2030-01-09', flow: 'medium', lh_test: 'positive', visibility: 'family',
  });
  assert.equal(created.body.data.lh_test, 'positive');

  asB();
  const asBob = await call('GET', `/cycle/logs?user_id=${userA}&from=2030-01-09&to=2030-01-09`);
  const bobRow = asBob.body.data.find((l) => l.log_date === '2030-01-09');
  assert.ok(bobRow, 'Bob sollte die family-Zeile sehen');
  assert.ok(!('lh_test' in bobRow), 'lh_test darf für Bob nicht einmal als Schlüssel auftauchen');

  asA();
  const asAlice = await call('GET', '/cycle/logs?from=2030-01-09&to=2030-01-09');
  assert.equal(asAlice.body.data.find((l) => l.log_date === '2030-01-09').lh_test, 'positive');
});

test('Cycle-Log: pregnancy_test ist hart privat - Eigentümer sieht es, family-Mitglied nicht', async () => {
  asA();
  const created = await call('POST', '/cycle/logs', {
    log_date: '2030-01-10', flow: 'medium', pregnancy_test: 'negative', visibility: 'family',
  });
  assert.equal(created.body.data.pregnancy_test, 'negative');

  asB();
  const asBob = await call('GET', `/cycle/logs?user_id=${userA}&from=2030-01-10&to=2030-01-10`);
  const bobRow = asBob.body.data.find((l) => l.log_date === '2030-01-10');
  assert.ok(bobRow, 'Bob sollte die family-Zeile sehen');
  assert.ok(!('pregnancy_test' in bobRow), 'pregnancy_test darf für Bob nicht einmal als Schlüssel auftauchen');

  asA();
  const asAlice = await call('GET', '/cycle/logs?from=2030-01-10&to=2030-01-10');
  assert.equal(asAlice.body.data.find((l) => l.log_date === '2030-01-10').pregnancy_test, 'negative');
});

test('Cycle: Bulk-Sichtbarkeit auf family lässt cervix_mucus/lh_test/pregnancy_test trotzdem verborgen', async () => {
  asA();
  await call('POST', '/cycle/logs', {
    log_date: '2030-01-11', cervix_mucus: 'watery', lh_test: 'negative', pregnancy_test: 'negative', visibility: 'private',
  });
  const bulk = await call('PATCH', '/cycle/visibility', { visibility: 'family' });
  assert.equal(bulk.status, 200);

  asB();
  const asBob = await call('GET', `/cycle/logs?user_id=${userA}&from=2030-01-11&to=2030-01-11`);
  const bobRow = asBob.body.data.find((l) => l.log_date === '2030-01-11');
  assert.ok(bobRow, 'nach dem Bulk-Umschalten sollte Bob die jetzt family-sichtbare Zeile sehen');
  assert.ok(!('cervix_mucus' in bobRow));
  assert.ok(!('lh_test' in bobRow));
  assert.ok(!('pregnancy_test' in bobRow));
});

// ========================================================
// Ungültige IDs, Filter, partielle Updates, Edge-Validierung (Härtung)
// ========================================================

test('Invalid-ID: nicht-numerische IDs liefern 400 auf allen :id-Routen', async () => {
  asA();
  const cases = [
    ['PATCH', '/vitals/abc'], ['DELETE', '/vitals/abc'],
    ['PATCH', '/medications/abc'], ['DELETE', '/medications/abc'],
    ['GET', '/medications/abc/schedules'], ['POST', '/medications/abc/schedules'],
    ['PATCH', '/schedules/abc'], ['DELETE', '/schedules/abc'],
    ['GET', '/medications/abc/logs'], ['POST', '/medications/abc/logs'],
    ['POST', '/logs/abc/take'], ['POST', '/logs/abc/skip'],
    ['GET', '/labs/abc'], ['PATCH', '/labs/abc'], ['DELETE', '/labs/abc'],
    ['POST', '/labs/abc/results'], ['DELETE', '/results/abc'],
    ['PATCH', '/activities/abc'], ['DELETE', '/activities/abc'],
    ['PATCH', '/cycle/periods/abc'], ['DELETE', '/cycle/periods/abc'],
    ['DELETE', '/cycle/logs/abc'],
  ];
  for (const [m, p] of cases) {
    const body = (m === 'GET' || m === 'DELETE') ? undefined : {};
    const r = await call(m, p, body);
    assert.equal(r.status, 400, `${m} ${p} sollte 400 liefern`);
  }
});

test('Vitals: GET from/to grenzt auf Zeitfenster ein', async () => {
  asA();
  await call('POST', '/vitals', { type: 'hr', value_num: 60, measured_at: '2027-07-01T08:00', note: 'flt-in-hr' });
  await call('POST', '/vitals', { type: 'hr', value_num: 61, measured_at: '2027-07-20T08:00', note: 'flt-out-hr' });
  const r = await call('GET', '/vitals?type=hr&from=2027-07-01T00:00&to=2027-07-10T00:00');
  const notes = r.body.data.map((x) => x.note);
  assert.ok(notes.includes('flt-in-hr'));
  assert.ok(!notes.includes('flt-out-hr'));
});

test('Medications: PATCH aktualisiert alle Kopf-Felder + Bool-Flags', async () => {
  asA();
  const med = await call('POST', '/medications', { name: 'PatchMed', stock_qty: 10 });
  const id = med.body.data.id;
  const r = await call('PATCH', `/medications/${id}`, {
    name: 'PatchMed2', dosage_text: '500mg', form: 'capsule', stock_qty: 42, stock_unit: 'Stk',
    refill_threshold: 7, note: 'Notiz', visibility: 'family', active: false, prn: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.name, 'PatchMed2');
  assert.equal(r.body.data.form, 'capsule');
  assert.equal(r.body.data.stock_qty, 42);
  assert.equal(r.body.data.active, 0);
  assert.equal(r.body.data.prn, 1);
  assert.equal(r.body.data.visibility, 'family');
});

test('Medications: PATCH mit nicht-boolescher active → 400', async () => {
  asA();
  const med = await call('POST', '/medications', { name: 'BoolMed' });
  const r = await call('PATCH', `/medications/${med.body.data.id}`, { active: 'vielleicht' });
  assert.equal(r.status, 400);
});

test('Schedules: PATCH aktualisiert alle Felder inkl. days_mask (Zahl und null)', async () => {
  asA();
  const med = await call('POST', '/medications', { name: 'SchedMed' });
  const medId = med.body.data.id;
  const sched = await call('POST', `/medications/${medId}/schedules`, { time_of_day: '07:00', dose_qty: 1 });
  const sid = sched.body.data.id;
  const full = await call('PATCH', `/schedules/${sid}`, {
    time_of_day: '20:00', dose_qty: 2, start_date: '2026-06-01', end_date: '2026-12-31', active: false, days_mask: 31,
  });
  assert.equal(full.status, 200);
  assert.equal(full.body.data.time_of_day, '20:00');
  assert.equal(full.body.data.dose_qty, 2);
  assert.equal(full.body.data.days_mask, 31);
  assert.equal(full.body.data.active, 0);
  const cleared = await call('PATCH', `/schedules/${sid}`, { days_mask: null });
  assert.equal(cleared.body.data.days_mask, null);
});

test('Schedules: PATCH mit leerem time_of_day → 400', async () => {
  asA();
  const med = await call('POST', '/medications', { name: 'SchedMed2' });
  const sched = await call('POST', `/medications/${med.body.data.id}/schedules`, { time_of_day: '07:00' });
  const r = await call('PATCH', `/schedules/${sched.body.data.id}`, { time_of_day: '' });
  assert.equal(r.status, 400);
});

test('Logs: POST mit gültiger schedule_id verknüpft, fremde schedule_id → 400', async () => {
  asA();
  const medA = await call('POST', '/medications', { name: 'LogMedA' });
  const medAId = medA.body.data.id;
  const schedA = await call('POST', `/medications/${medAId}/schedules`, { time_of_day: '08:00' });
  const ok = await call('POST', `/medications/${medAId}/logs`, { scheduled_at: '2026-06-10T08:00', schedule_id: schedA.body.data.id, status: 'taken', taken_at: '2026-06-10T08:03' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.schedule_id, schedA.body.data.id);
  assert.equal(ok.body.data.status, 'taken');

  const medB = await call('POST', '/medications', { name: 'LogMedB' });
  const schedB = await call('POST', `/medications/${medB.body.data.id}/schedules`, { time_of_day: '09:00' });
  const bad = await call('POST', `/medications/${medAId}/logs`, { scheduled_at: '2026-06-11T08:00', schedule_id: schedB.body.data.id });
  assert.equal(bad.status, 400, 'schedule_id fremder Medikamente wird abgelehnt');
});

test('Logs: GET from/to-Filter + take mit ungültigem taken_at → 400', async () => {
  asA();
  const med = await call('POST', '/medications', { name: 'FilterLogMed' });
  const medId = med.body.data.id;
  await call('POST', `/medications/${medId}/logs`, { scheduled_at: '2026-08-01T08:00', note: 'log-in' });
  const out = await call('POST', `/medications/${medId}/logs`, { scheduled_at: '2026-08-20T08:00', note: 'log-out' });
  const list = await call('GET', `/medications/${medId}/logs?from=2026-08-01T00:00&to=2026-08-05T00:00`);
  const notes = list.body.data.map((x) => x.note);
  assert.ok(notes.includes('log-in') && !notes.includes('log-out'));

  const bad = await call('POST', `/logs/${out.body.data.id}/take`, { taken_at: 'kein-datum' });
  assert.equal(bad.status, 400);
});

test('Labs: GET :id für Unbekanntes → 404; POST mit ungültigem Analyt → 400', async () => {
  asA();
  const notFound = await call('GET', '/labs/999999');
  assert.equal(notFound.status, 404);
  const bad = await call('POST', '/labs', { report_date: '2026-06-01', results: [{ analyte: '', value_num: 1 }] });
  assert.equal(bad.status, 400);
});

test('Labs: PATCH aktualisiert Kopf-Felder', async () => {
  asA();
  const lab = await call('POST', '/labs', { report_date: '2026-06-01', lab_name: 'Alt' });
  const id = lab.body.data.id;
  const r = await call('PATCH', `/labs/${id}`, { report_date: '2026-06-02', lab_name: 'Neu', note: 'Kommentar', visibility: 'family' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.lab_name, 'Neu');
  assert.equal(r.body.data.report_date, '2026-06-02');
  assert.equal(r.body.data.visibility, 'family');
});

test('Labs: from/to-Filter auf GET /labs', async () => {
  asA();
  await call('POST', '/labs', { report_date: '2026-09-05', lab_name: 'lab-in-range' });
  await call('POST', '/labs', { report_date: '2026-09-25', lab_name: 'lab-out-range' });
  const r = await call('GET', '/labs?from=2026-09-01&to=2026-09-10');
  const names = r.body.data.map((x) => x.lab_name);
  assert.ok(names.includes('lab-in-range') && !names.includes('lab-out-range'));
});

test('Activities: PATCH aller Felder + type/from/to-Filter', async () => {
  asA();
  const a = await call('POST', '/activities', { type: 'run', duration_min: 30, performed_at: '2026-10-01T18:00' });
  const id = a.body.data.id;
  const patched = await call('PATCH', `/activities/${id}`, {
    type: 'bike', distance_km: 12, intensity: 'high', calories: 400, performed_at: '2026-10-02T18:00', note: 'Tour', visibility: 'family',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.type, 'bike');
  assert.equal(patched.body.data.distance_km, 12);
  assert.equal(patched.body.data.calories, 400);
  assert.equal(patched.body.data.visibility, 'family');

  await call('POST', '/activities', { type: 'swim', duration_min: 20, performed_at: '2026-10-20T09:00', note: 'act-out' });
  const filtered = await call('GET', '/activities?type=bike&from=2026-10-01T00:00&to=2026-10-10T00:00');
  assert.ok(filtered.body.data.every((x) => x.type === 'bike'));
  assert.ok(filtered.body.data.some((x) => x.id === id));
});

test('Export activities: text/csv-Header mit eigener Zeile', async () => {
  asA();
  await call('POST', '/activities', { type: 'yoga', duration_min: 45, performed_at: '2026-11-01T07:00', note: 'exp-act-marker' });
  const res = await callCsv('/export/activities');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/csv/);
  assert.match(res.disposition, /attachment; filename="health-activities/);
  assert.ok(res.text.includes('exp-act-marker'));
});

test('Export: from/to-Zeitraum + Personen-Filter über alle CSV-Endpunkte', async () => {
  asA();
  const labsRange = await callCsv('/export/labs?from=2026-09-01&to=2026-09-10');
  assert.equal(labsRange.status, 200);
  assert.match(labsRange.disposition, /health-labs-2026-09-01_2026-09-10/);
  const medsRange = await callCsv('/export/meds-logs?from=2026-08-01&to=2026-08-05');
  assert.equal(medsRange.status, 200);
  const cycleRange = await callCsv('/export/cycle?from=2026-01-01&to=2026-12-31');
  assert.equal(cycleRange.status, 200);
  // Personen-Filter (user_id) auf Export: Bob sieht nur family-Vitals von Alice.
  asB();
  const vitalsPerson = await callCsv(`/export/vitals?user_id=${userA}`);
  assert.equal(vitalsPerson.status, 200);
});

test('Export: eine Bedarfsdosis steht im Auszug ihres Zeitraums (#700)', async () => {
  // Der Auszug ist der Ort, an dem das Fehlen am teuersten ist: er wird
  // ausgedruckt und einer Ärztin hingelegt. Ohne Zeitplan ist `scheduled_at`
  // NULL, und der Zeitraumfilter warf die Zeile damit lautlos heraus.
  asA();
  const med = await call('POST', '/medications', { name: 'exp-prn-marker', prn: true });
  await call('POST', `/medications/${med.body.data.id}/logs`, {
    status: 'taken', taken_at: '2026-08-03T21:15',
  });

  const inRange = await callCsv('/export/meds-logs?from=2026-08-01&to=2026-08-05');
  assert.equal(inRange.status, 200);
  assert.ok(inRange.text.includes('exp-prn-marker'), 'Bedarfsdosis fehlt im Auszug');

  const outOfRange = await callCsv('/export/meds-logs?from=2026-08-06&to=2026-08-10');
  assert.ok(!outOfRange.text.includes('exp-prn-marker'), 'Bedarfsdosis steht im falschen Zeitraum');
});

test('Cycle: Perioden from/to-Filter + Log löschen', async () => {
  asA();
  await call('POST', '/cycle/periods', { start_date: '2028-03-01', note: 'per-in' });
  await call('POST', '/cycle/periods', { start_date: '2028-04-15', note: 'per-out' });
  const filtered = await call('GET', '/cycle/periods?from=2028-03-01&to=2028-03-31');
  const notes = filtered.body.data.map((x) => x.note);
  assert.ok(notes.includes('per-in') && !notes.includes('per-out'));

  const logged = await call('POST', '/cycle/logs', { log_date: '2028-03-05', flow: 'light' });
  const logsFiltered = await call('GET', '/cycle/logs?from=2028-03-01&to=2028-03-31');
  assert.ok(logsFiltered.body.data.some((l) => l.id === logged.body.data.id));
  const del = await call('DELETE', `/cycle/logs/${logged.body.data.id}`);
  assert.equal(del.status, 204);
});

test('Cycle-Log: zu lange Symptomliste → 400', async () => {
  asA();
  // Deckel liegt seit Phase 2 auf der ANZAHL (MAX_SYMPTOMS_COUNT = 40), nicht
  // mehr auf der Zeichenlänge einer Komma-Zeile - 41 eindeutige Einträge
  // reißen die Grenze, 40 selbst nicht.
  const many = Array.from({ length: 41 }, (_, i) => `symptomlongtoken${i}`);
  const r = await call('POST', '/cycle/logs', { log_date: '2028-05-01', symptoms: many });
  assert.equal(r.status, 400);
});

test('Cycle-Log: Symptom-Intensität wird gespeichert, gelesen und über PATCH-artigen Re-POST ersetzt', async () => {
  asA();
  const created = await call('POST', '/cycle/logs', {
    log_date: '2028-05-02',
    symptoms: [{ key: 'headache', intensity: 3 }, { key: 'nausea' }],
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.data.symptoms, [{ key: 'headache', intensity: 3 }, { key: 'nausea', intensity: null }]);

  const list = await call('GET', '/cycle/logs?from=2028-05-02&to=2028-05-02');
  const row = list.body.data.find((l) => l.log_date === '2028-05-02');
  assert.deepEqual(row.symptoms, [{ key: 'headache', intensity: 3 }, { key: 'nausea', intensity: null }]);
});

test('Cycle-Log: Basaltemperatur wird gespeichert, gelesen und beim Weglassen gelöscht', async () => {
  asA();
  const created = await call('POST', '/cycle/logs', { log_date: '2028-05-03', basal_temp: 36.42, basal_temp_unit: 'c' });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.basal_temp, 36.42);
  assert.equal(created.body.data.basal_temp_unit, 'c');

  const list = await call('GET', '/cycle/logs?from=2028-05-03&to=2028-05-03');
  const row = list.body.data.find((l) => l.log_date === '2028-05-03');
  assert.equal(row.basal_temp, 36.42);
  assert.equal(row.basal_temp_unit, 'c');

  // Voller Ersatz wie bei allen anderen Feldern dieser Route: weggelassen heißt geloescht.
  const cleared = await call('POST', '/cycle/logs', { log_date: '2028-05-03', flow: 'light' });
  assert.equal(cleared.body.data.basal_temp, null);
  assert.equal(cleared.body.data.basal_temp_unit, null);
});

test('Cycle-Log: Basaltemperatur ohne Einheit, mit unbekannter Einheit oder außerhalb des Plausibilitätsbereichs → 400', async () => {
  asA();
  const noUnit = await call('POST', '/cycle/logs', { log_date: '2028-05-04', basal_temp: 36.5 });
  assert.equal(noUnit.status, 400);

  const badUnit = await call('POST', '/cycle/logs', { log_date: '2028-05-04', basal_temp: 36.5, basal_temp_unit: 'k' });
  assert.equal(badUnit.status, 400);

  const tooLowC = await call('POST', '/cycle/logs', { log_date: '2028-05-04', basal_temp: 10, basal_temp_unit: 'c' });
  assert.equal(tooLowC.status, 400);

  const tooHighF = await call('POST', '/cycle/logs', { log_date: '2028-05-04', basal_temp: 200, basal_temp_unit: 'f' });
  assert.equal(tooHighF.status, 400);
});

test('Cycle-Log: Basaltemperatur in Fahrenheit wird unverändert gespeichert (keine serverseitige Umrechnung)', async () => {
  asA();
  const r = await call('POST', '/cycle/logs', { log_date: '2028-05-05', basal_temp: 97.9, basal_temp_unit: 'f' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.basal_temp, 97.9);
  assert.equal(r.body.data.basal_temp_unit, 'f');
});

test('Cycle-Periode: PATCH aller Felder + Fremdzugriff-404', async () => {
  asA();
  const p = await call('POST', '/cycle/periods', { start_date: '2028-06-01' });
  const id = p.body.data.id;
  const r = await call('PATCH', `/cycle/periods/${id}`, { start_date: '2028-06-02', end_date: '2028-06-08', note: 'Update', visibility: 'family' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.end_date, '2028-06-08');
  assert.equal(r.body.data.visibility, 'family');
});

test('Cycle-Settings: nicht-boolesche track_fertility/pregnancy_mode → 400', async () => {
  asA();
  const bad1 = await call('PUT', '/cycle/settings', { track_fertility: 'ja' });
  assert.equal(bad1.status, 400);
  const bad2 = await call('PUT', '/cycle/settings', { pregnancy_mode: 'ja' });
  assert.equal(bad2.status, 400);
});

test('Nicht-Eigentümer: DELETE auf Schedule/Result/Cycle-Period/Cycle-Log → 404', async () => {
  asA();
  const med = await call('POST', '/medications', { name: 'OwnMed' });
  const sched = await call('POST', `/medications/${med.body.data.id}/schedules`, { time_of_day: '06:00' });
  const lab = await call('POST', '/labs', { report_date: '2026-07-01', results: [{ analyte: 'X', value_num: 1 }] });
  const resultId = lab.body.data.results[0].id;
  const period = await call('POST', '/cycle/periods', { start_date: '2029-01-01' });
  const log = await call('POST', '/cycle/logs', { log_date: '2029-01-02', flow: 'light' });

  asB();
  assert.equal((await call('DELETE', `/schedules/${sched.body.data.id}`)).status, 404);
  assert.equal((await call('DELETE', `/results/${resultId}`)).status, 404);
  assert.equal((await call('DELETE', `/cycle/periods/${period.body.data.id}`)).status, 404);
  assert.equal((await call('DELETE', `/cycle/logs/${log.body.data.id}`)).status, 404);
});

test('Logs: take ohne taken_at setzt Zeitstempel automatisch', async () => {
  asA();
  const med = await call('POST', '/medications', { name: 'TakeNowMed' });
  const logRow = await call('POST', `/medications/${med.body.data.id}/logs`, { scheduled_at: '2026-06-15T08:00' });
  const r = await call('POST', `/logs/${logRow.body.data.id}/take`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'taken');
  assert.ok(r.body.data.taken_at, 'taken_at automatisch gesetzt');
});

test('Labs: POST /results mit explizitem flag übernimmt diesen', async () => {
  asA();
  const lab = await call('POST', '/labs', { report_date: '2026-07-02' });
  const r = await call('POST', `/labs/${lab.body.data.id}/results`, { analyte: 'TSH', value_num: 2, flag: 'high' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.flag, 'high', 'expliziter Flag überschreibt Ableitung');
});

// ========================================================
// Betreuung: eine Person trägt für eine andere ein (#584)
// ========================================================
// userC ist das Kind, userA die betreuende Person. Die Beziehung wird über die
// Admin-Route gesetzt, nicht per direktem INSERT - so deckt jeder Test hier auch
// den Weg mit ab, über den sie im Betrieb entsteht.

const userC = db.prepare(`INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('kid', 'Kid', '$2b$12$x', 'member', 'child')`).run().lastInsertRowid;

function asAdmin() { session = { userId: userA, role: 'admin' }; }
function asC() { session = { userId: userC, role: 'member' }; }

test('Betreuung: nur Admins dürfen sie setzen', async () => {
  asA();
  const denied = await call('PUT', `/caregivers/${userC}`, { caregiver_ids: [userA] });
  assert.equal(denied.status, 403);

  asAdmin();
  const ok = await call('PUT', `/caregivers/${userC}`, { caregiver_ids: [userA] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.data.caregiver_ids, [userA]);
});

test('Betreuung: jede Person erfährt, für wen sie eintragen darf', async () => {
  asA();
  const mine = await call('GET', '/caregivers/me');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.data, [userC]);

  asB();
  const none = await call('GET', '/caregivers/me');
  assert.deepEqual(none.body.data, [], 'ohne Betreuung eine leere Liste, kein Fehler');
});

test('Betreuung: Betreuer trägt einen Vitalwert für die betreute Person ein', async () => {
  asA();
  const res = await call('POST', '/vitals', {
    type: 'temp', value_num: 39.1, unit: '°C', measured_at: '2026-08-01T20:00', user_id: userC,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.user_id, userC, 'der Eintrag gehört dem Kind, nicht dem Elternteil');
});

// Der Kern des Wunsches: ohne Lesezugriff waere der eben eingetragene Wert fuer
// die eintragende Person sofort unsichtbar - Schreiben allein reicht nicht.
test('Betreuung: der eingetragene private Wert bleibt für den Betreuer sichtbar', async () => {
  asA();
  const list = await call('GET', `/vitals?user_id=${userC}`);
  assert.equal(list.status, 200);
  const temps = list.body.data.filter((r) => r.type === 'temp');
  assert.equal(temps.length, 1);
  assert.equal(temps[0].visibility, 'private');
});

test('Betreuung: Unbeteiligte sehen die privaten Werte weiterhin nicht', async () => {
  asB();
  const list = await call('GET', `/vitals?user_id=${userC}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.filter((r) => r.type === 'temp').length, 0);
});

test('Betreuung: ohne Beziehung wird das Eintragen für Fremde mit 403 abgelehnt', async () => {
  asB();
  const res = await call('POST', '/vitals', {
    type: 'temp', value_num: 38, unit: '°C', measured_at: '2026-08-01T21:00', user_id: userC,
  });
  assert.equal(res.status, 403);
});

test('Betreuung: Medikamente sind der zweite Alltagsfall aus der Meldung', async () => {
  asA();
  const med = await call('POST', '/medications', { name: 'Ibuprofen Saft', user_id: userC });
  assert.equal(med.status, 201);
  assert.equal(med.body.data.user_id, userC);

  // Einnahme protokollieren: haengt am Medikament und erbt dessen Scoping.
  const logRes = await call('POST', `/medications/${med.body.data.id}/logs`, {
    scheduled_at: '2026-08-01T20:00', status: 'taken',
  });
  assert.equal(logRes.status, 201);
});

test('Betreuung: Betreuer darf einen Eintrag der betreuten Person korrigieren und löschen', async () => {
  asA();
  const created = await call('POST', '/vitals', {
    type: 'weight', value_num: 30, unit: 'kg', measured_at: '2026-08-02T08:00', user_id: userC,
  });
  const id = created.body.data.id;

  const patched = await call('PATCH', `/vitals/${id}`, { value_num: 31 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.value_num, 31);

  asB();
  const denied = await call('DELETE', `/vitals/${id}`);
  assert.equal(denied.status, 404, 'ohne Betreuung bleibt der Eintrag unerreichbar');

  asA();
  assert.equal((await call('DELETE', `/vitals/${id}`)).status, 204);
});

// Die eine bewusste Ausnahme: Fuersorge deckt Fieber und Medikamente, nicht das
// Zyklus-Tagebuch. Bricht dieser Test, ist cycle.js versehentlich mit umgestellt
// worden.
test('Betreuung: Zyklusdaten der betreuten Person bleiben verschlossen', async () => {
  asC();
  const own = await call('POST', '/cycle/periods', { start_date: '2026-08-01' });
  assert.equal(own.status, 201);
  assert.equal(own.body.data.visibility, 'private');

  asA();
  const list = await call('GET', `/cycle/periods?user_id=${userC}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 0, 'Betreuung öffnet den Zyklus-Tab nicht');
});

test('Betreuung: eine leere Liste entzieht sie wieder', async () => {
  asAdmin();
  const cleared = await call('PUT', `/caregivers/${userC}`, { caregiver_ids: [] });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.data.caregiver_ids, []);

  asA();
  assert.deepEqual((await call('GET', '/caregivers/me')).body.data, []);
  const res = await call('POST', '/vitals', {
    type: 'temp', value_num: 37, unit: '°C', measured_at: '2026-08-03T08:00', user_id: userC,
  });
  assert.equal(res.status, 403, 'nach dem Entzug ist der Weg sofort zu');
});

// Die Meldung aus #884: angelegt werden konnte beides, weggeraeumt nichts. Ein
// Zeitplan und ein Dosis-Eintrag haben keine eigene `user_id` - sie haengen am
// Medikament und muessen dessen Scoping erben, Betreuung eingeschlossen. Der
// Alltagsfall ist die betreuende Person, die den Plan des Kindes wieder
// loeschen oder dessen Dosis abhaken will.
test('Betreuung: Zeitplan der betreuten Person laesst sich aendern und loeschen (#884)', async () => {
  asAdmin();
  await call('PUT', `/caregivers/${userC}`, { caregiver_ids: [userA] });

  asA();
  const med = await call('POST', '/medications', { name: 'Vitamin D', user_id: userC });
  assert.equal(med.body.data.user_id, userC);

  const sched = await call('POST', `/medications/${med.body.data.id}/schedules`, {
    time_of_day: '07:00', dose_qty: 1,
  });
  assert.equal(sched.status, 201, 'anlegen ging schon vorher');
  const schedId = sched.body.data.id;

  const patched = await call('PATCH', `/schedules/${schedId}`, { dose_qty: 2 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.dose_qty, 2);

  asB();
  assert.equal((await call('DELETE', `/schedules/${schedId}`)).status, 404,
    'ohne Betreuung bleibt der Plan unerreichbar');

  asA();
  assert.equal((await call('DELETE', `/schedules/${schedId}`)).status, 204);
});

// Warum die Meldung „zufaellig" klang: solange der Betreuer die Dosis selbst
// anlegt, laeuft sie ueber das Medikament und geht. Sobald der Scheduler den
// Eintrag vorab erzeugt hat, tippt die Oberflaeche auf /logs/:id/take - und nur
// dieser Weg war zu. Derselbe Knopf, mal so, mal so.
test('Betreuung: eine vorab erzeugte Dosis der betreuten Person ist abhakbar (#884)', async () => {
  asA();
  const med = await call('POST', '/medications', { name: 'Eisen', user_id: userC });
  const medId = med.body.data.id;
  const sched = await call('POST', `/medications/${medId}/schedules`, { time_of_day: '08:00' });

  // So legt der Scheduler ihn an: pending, mit schedule_id, ohne Zutun des Betreuers.
  const logId = db.prepare(`INSERT INTO medication_logs (medication_id, schedule_id, scheduled_at, status)
    VALUES (?, ?, '2026-08-05T08:00', 'pending')`).run(medId, sched.body.data.id).lastInsertRowid;

  asB();
  assert.equal((await call('POST', `/logs/${logId}/take`, {})).status, 404,
    'ohne Betreuung bleibt fremdes Protokoll zu');

  asA();
  const taken = await call('POST', `/logs/${logId}/take`, {});
  assert.equal(taken.status, 200);
  assert.equal(taken.body.data.status, 'taken');

  const back = await call('PATCH', `/logs/${logId}`, { status: 'pending' });
  assert.equal(back.status, 200);
  assert.equal(back.body.data.status, 'pending');
  assert.equal(back.body.data.taken_at, null);

  const skipped = await call('POST', `/logs/${logId}/skip`, {});
  assert.equal(skipped.status, 200);
});

// Dieselbe Luecke, nur nie gemeldet: ein Analyt haengt am Befund wie der
// Zeitplan am Medikament. Anlegen ging, loeschen nicht.
test('Betreuung: Analyt der betreuten Person laesst sich wieder loeschen (#884)', async () => {
  asA();
  const lab = await call('POST', '/labs', { report_date: '2026-08-05', user_id: userC });
  assert.equal(lab.body.data.user_id, userC);
  const resu = await call('POST', `/labs/${lab.body.data.id}/results`, { analyte: 'Ferritin', value_num: 40 });
  assert.equal(resu.status, 201);

  asB();
  assert.equal((await call('DELETE', `/results/${resu.body.data.id}`)).status, 404);

  asA();
  assert.equal((await call('DELETE', `/results/${resu.body.data.id}`)).status, 204);
});

test('Betreuung: niemand wird sein eigener Betreuer, Unbekannte werden abgelehnt', async () => {
  asAdmin();
  const self = await call('PUT', `/caregivers/${userC}`, { caregiver_ids: [userC, userA] });
  assert.equal(self.status, 200);
  assert.deepEqual(self.body.data.caregiver_ids, [userA], 'die Person selbst fällt still heraus');

  const unknown = await call('PUT', `/caregivers/${userC}`, { caregiver_ids: [999999] });
  assert.equal(unknown.status, 400);

  const noList = await call('PUT', `/caregivers/${userC}`, { caregiver_ids: 'alle' });
  assert.equal(noList.status, 400);

  // Aufräumen, damit die Reihenfolge späterer Tests keine Rolle spielt.
  await call('PUT', `/caregivers/${userC}`, { caregiver_ids: [] });
});

test.after(() => { server.close(); });

test('PRN: 0 als Mindestabstand nennt seine Grenze richtig', async () => {
  // Die Meldung sagte „between 0 and 672", wies die 0 aber ab - und das
  // Formularfeld liess sie zu. Wer 0 eintippt, soll lesen, was gilt.
  asA();
  const res = await call('POST', '/medications', { name: 'Grenzfall', prn: true, min_interval_hours: 0 });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.body), /greater than 0 and at most 672/);
});

test('PRN: eine negative Bedarfsdosis wird abgewiesen', async () => {
  // `v.num` nimmt negative Zahlen an (das Budget rechnet damit), und der
  // Bestandsabzug rechnet `stock_qty - dose`: -2 würde den Bestand bei jeder
  // Einnahme ERHÖHEN. Das Formularfeld sperrt das, ein API-Token nicht.
  asA();
  const res = await call('POST', '/medications', { name: 'Minusdosis', prn: true, prn_dose_qty: -2 });
  assert.equal(res.status, 400);

  const ok = await call('POST', '/medications', { name: 'Plusdosis', prn: true, prn_dose_qty: 2 });
  assert.equal(ok.status, 201);
  const patched = await call('PATCH', `/medications/${ok.body.data.id}`, { prn_dose_qty: -1 });
  assert.equal(patched.status, 400);
});
