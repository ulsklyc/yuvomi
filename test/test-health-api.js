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
import Database from 'better-sqlite3';

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
app.use(express.json());
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
  assert.equal(first.body.data.symptoms, 'cramps,fatigue');
  const firstId = first.body.data.id;

  const second = await call('POST', '/cycle/logs', { log_date: '2026-05-02', flow: 'heavy', symptoms: ['cramps'] });
  assert.equal(second.body.data.id, firstId); // gleiche Zeile
  assert.equal(second.body.data.flow, 'heavy');
  assert.equal(second.body.data.symptoms, 'cramps');

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

  // Modus aus → Entbindungstermin wird geleert.
  const off = await call('PUT', '/cycle/settings', { pregnancy_mode: false, pregnancy_due_date: '2027-01-15' });
  assert.equal(off.body.data.pregnancy_mode, 0);
  assert.equal(off.body.data.pregnancy_due_date, null);
});

test('Cycle-Settings: ungültiges Entbindungsdatum wird abgelehnt', async () => {
  asA();
  const res = await call('PUT', '/cycle/settings', { pregnancy_mode: true, pregnancy_due_date: '15.01.2027' });
  assert.equal(res.status, 400);
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

test.after(() => { server.close(); });
