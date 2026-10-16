/**
 * Tests: die Fehler der Gesundheit (#1909)
 * Module: server/routes/health/*.js, public/pages/health.js,
 *         public/settings/pages/modules-health.js
 *
 * Der Server nennt den Fall (`reason`), die Seite sagt den Satz der App - nie
 * den des Servers. Sagt der Grund, dass es das Ziel der Handlung nicht mehr
 * gibt (ein anderes Haushaltsmitglied hat den Eintrag geloescht), schliesst die
 * Seite den offenen Dialog und holt den Bereich selbst neu. Wer etwas LOESCHT,
 * das schon weg ist, hat sein Ziel erreicht: Erfolgsweg, kein Fehler-Toast.
 *
 * Gefahren wird auf beiden Seiten der ECHTE Code:
 * - Server: der echte Health-Router ueber einer migrierten In-Memory-DB; je
 *   Fall die Antwort, die eine Seite bekommt (Status, `reason`, englischer Text).
 * - Seite: die echten Handler bis in ihr catch, ueber den api-Stub des Loaders
 *   (`__apiStub`), den Modal-Stub (`__openModal` faengt die Optionen,
 *   `onSave(panel)` verdrahtet die Zuhoerer an einem Attrappen-Panel) und
 *   `__closeModal`. Die Sichtpruefung im Browser macht dieser Test nicht.
 *
 * Ausfuehren: npm run test:health-errors
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
const toasts = [];
globalThis.window.yuvomi = { ...globalThis.window.yuvomi, showToast: (text, kind) => { toasts.push([text, kind]); } };

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: healthRouter } = await import('../server/routes/health.js');
const { __test: page } = await import('../public/pages/health.js');
const { __test: settings } = await import('../public/settings/pages/modules-health.js');
const { CASE_MESSAGES, GONE_REASONS } = await import('../public/utils/friendly-error.js');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

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
const admin = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('ada', 'Ada', '$2b$12$x', 'admin')`).run().lastInsertRowid;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/health', healthRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
test.after(() => new Promise((r) => server.close(r)));
const base = `http://127.0.0.1:${server.address().port}/api/v1/health`;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const GONE = 999999;
const SERVER_GONE = [
  ['PATCH', `/vitals/${GONE}`, { note: 'x' }, 'health_vital_not_found', 'Measurement not found.'],
  ['DELETE', `/vitals/${GONE}`, null, 'health_vital_not_found', 'Measurement not found.'],
  ['PATCH', `/medications/${GONE}`, { name: 'x' }, 'health_medication_not_found', 'Medication not found.'],
  ['DELETE', `/medications/${GONE}`, null, 'health_medication_not_found', 'Medication not found.'],
  ['POST', `/medications/${GONE}/logs`, { status: 'taken' }, 'health_medication_not_found', 'Medication not found.'],
  ['POST', `/medications/${GONE}/schedules`, { time_of_day: '08:00' }, 'health_medication_not_found', 'Medication not found.'],
  ['DELETE', `/schedules/${GONE}`, null, 'health_schedule_not_found', 'Schedule not found.'],
  ['PATCH', `/logs/${GONE}`, { status: 'pending' }, 'health_dose_not_found', 'Dose entry not found.'],
  ['DELETE', `/logs/${GONE}`, null, 'health_dose_not_found', 'Dose entry not found.'],
  ['POST', `/logs/${GONE}/take`, {}, 'health_dose_not_found', 'Dose entry not found.'],
  ['PATCH', `/labs/${GONE}`, { note: 'x' }, 'health_lab_report_not_found', 'Lab report not found.'],
  ['DELETE', `/labs/${GONE}`, null, 'health_lab_report_not_found', 'Lab report not found.'],
  ['POST', `/labs/${GONE}/results`, { analyte: 'Ferritin', value_num: 1 }, 'health_lab_report_not_found', 'Lab report not found.'],
  ['PATCH', `/results/${GONE}`, { unit: 'x' }, 'health_lab_result_not_found', 'Analyte not found.'],
  ['DELETE', `/results/${GONE}`, null, 'health_lab_result_not_found', 'Analyte not found.'],
  ['PATCH', `/activities/${GONE}`, { note: 'x' }, 'health_activity_not_found', 'Activity not found.'],
  ['DELETE', `/activities/${GONE}`, null, 'health_activity_not_found', 'Activity not found.'],
  ['PATCH', `/prevention/types/${GONE}`, { name: 'x' }, 'health_prevention_type_not_found', 'Type not found.'],
  ['DELETE', `/prevention/types/${GONE}`, null, 'health_prevention_type_not_found', 'Type not found.'],
  ['PATCH', `/prevention/records/${GONE}`, { note: 'x' }, 'health_prevention_record_not_found', 'Record not found.'],
  ['DELETE', `/prevention/records/${GONE}`, null, 'health_prevention_record_not_found', 'Record not found.'],
  ['PATCH', `/nutrition/entries/${GONE}`, { note: 'x' }, 'health_nutrition_entry_not_found', 'Entry not found.'],
  ['DELETE', `/nutrition/entries/${GONE}`, null, 'health_nutrition_entry_not_found', 'Entry not found.'],
  ['PATCH', `/cycle/periods/${GONE}`, { end_date: '2026-01-05' }, 'health_cycle_period_not_found', 'Period not found.'],
  ['DELETE', `/cycle/periods/${GONE}`, null, 'health_cycle_period_not_found', 'Period not found.'],
  ['DELETE', `/cycle/logs/${GONE}`, null, 'health_cycle_log_not_found', 'Day entry not found.'],
];

for (const [method, path, body, reason, error] of SERVER_GONE) {
  test(`Server: ${method} ${path.replace(String(GONE), ':id')} auf etwas, das es nicht mehr gibt, nennt ${reason}`, async () => {
    const r = await call(method, path, body);
    assert.deepEqual([r.status, r.body?.reason, r.body?.error], [404, reason, error]);
  });
}

test('Server: eine Vorsorge mit einer inzwischen geloeschten Art nennt den Fall - beim Anlegen und beim Aendern, Status 400 wie bisher', async () => {
  const created = await call('POST', '/prevention/records', { name: 'Tetanus', given_on: '2026-01-05' });
  assert.equal(created.status, 201);
  for (const [method, path] of [['POST', '/prevention/records'], ['PATCH', `/prevention/records/${created.body.data.id}`]]) {
    const r = await call(method, path, { type_id: GONE, given_on: '2026-01-05' });
    assert.deepEqual([r.status, r.body?.reason, r.body?.error], [400, 'health_prevention_selected_type_not_found', 'Unknown type.'], `${method} ${path}`);
  }
});

test('Server: was ein Import der Perioden-Historie erreicht, traegt Grund und Grenze als Zahl', async () => {
  let r = await call('POST', '/cycle/import', { csv: `start_date,end_date\n${'2026-01-05,\n'.repeat(12000)}` });
  assert.deepEqual([r.status, r.body?.reason, r.body?.params], [400, 'health_cycle_import_too_large', { limit_kb: 100 }]);
  r = await call('POST', '/cycle/import', { csv: 'start_date,end_date' });
  assert.deepEqual([r.status, r.body?.reason], [400, 'health_cycle_import_no_rows']);
  const rows = Array.from({ length: 501 }, (_, i) => `2020-01-${String((i % 28) + 1).padStart(2, '0')},`).join('\n');
  r = await call('POST', '/cycle/import', { csv: rows });
  assert.deepEqual([r.status, r.body?.reason, r.body?.params], [400, 'health_cycle_import_too_many_rows', { limit: 500 }]);
});

// Critique R19: unmoegliche Vitalwerte nennen ihren Fall (server/routes/health/vital-limits.js).
test('Server: ein unmoeglicher Vitalwert nennt seinen Fall, Status 400', async () => {
  const at = '2026-06-05T08:00';
  let r = await call('POST', '/vitals', { type: 'bp', value_num: 80, value_num2: 120, unit: 'mmHg', measured_at: at });
  assert.deepEqual([r.status, r.body?.reason], [400, 'health_vital_bp_order']);
  r = await call('POST', '/vitals', { type: 'spo2', value_num: 101, unit: '%', measured_at: at });
  assert.deepEqual([r.status, r.body?.reason], [400, 'health_vital_out_of_range']);
});

test('Server: jeder Gesundheits-Grund hat einen Satz, und jeder "gibt es nicht mehr" laedt nach', () => {
  const reasons = new Set([...SERVER_GONE.map((c) => c[3]), 'health_prevention_selected_type_not_found',
    'health_cycle_import_too_large', 'health_cycle_import_no_rows', 'health_cycle_import_too_many_rows',
    'health_vital_bp_order', 'health_vital_out_of_range']);
  for (const reason of reasons) {
    assert.ok(CASE_MESSAGES.has(reason), `${reason}: kein Satz`);
    assert.equal(GONE_REASONS.has(reason), reason.endsWith('_not_found'), reason);
  }
  assert.deepEqual([...CASE_MESSAGES.keys()].filter((r) => r.startsWith('health_')).sort(), [...reasons].sort(),
    'ein Grund in CASE_MESSAGES, den kein Server dieser Suite nennt');
});

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

const SERVER_TEXT = 'Server sentence.';
const fehler = (status, reason, params) => Object.assign(new Error(SERVER_TEXT), {
  name: 'ApiError', status,
  data: { error: SERVER_TEXT, code: status, ...(reason ? { reason } : {}), ...(params ? { params } : {}) },
});

/**
 * Mit einem api-Stub laufen lassen. `calls` schreibt jede Anfrage mit,
 * `closed` jedes Schliessen eines Dialogs. Lesen liefert leere Listen; die
 * Schreibwege (`post`, `put`, `patch`, `delete`) nennt der Test.
 */
async function mit(schreiben, lauf) {
  toasts.length = 0;
  const calls = [];
  const closed = [];
  const stub = {
    get: async (path) => { calls.push(['GET', path]); return { data: [] }; },
  };
  for (const verb of ['post', 'put', 'patch', 'delete']) {
    stub[verb] = async (path, body) => {
      calls.push([verb.toUpperCase(), path]);
      if (!schreiben[verb]) throw new Error(`kein Stub fuer ${verb} ${path}`);
      return schreiben[verb](path, body);
    };
  }
  globalThis.__apiStub = stub;
  globalThis.__closeModal = (opts) => { closed.push(opts ?? {}); return true; };
  try {
    await lauf();
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
  } finally {
    delete globalThis.__apiStub;
    delete globalThis.__closeModal;
  }
  const gets = calls.filter(([verb]) => verb === 'GET').map(([, path]) => path);
  return { calls, closed, gets };
}

/**
 * Oeffnet einen Dialog ueber den Modal-Stub und verdrahtet seine echten
 * Zuhoerer an einem Attrappen-Panel. `werte` belegt Felder. Liefert
 * `absenden(selector)` (der Submit-Handler des Formulars) und `element`.
 */
async function dialog(oeffne, werte = {}) {
  let opts = null;
  globalThis.__openModal = (o) => { opts = o; };
  try { await oeffne(); } finally { delete globalThis.__openModal; }
  assert.ok(opts, 'der Dialog wurde geoeffnet');
  const handlers = new Map();
  const elements = new Map();
  const fokus = [];
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        value: '', checked: false, hidden: false, disabled: false, dataset: {}, files: [], html: null,
        addEventListener(type, fn) { handlers.set(`${selector}:${type}`, fn); },
        focus() { fokus.push(selector); },
        replaceChildren() { this.html = ''; },
        insertAdjacentHTML(_p, html) { this.html = (this.html ?? '') + html; },
        setAttribute() {}, removeAttribute() {}, classList: { add() {}, remove() {}, toggle() {} },
        querySelector: () => null, querySelectorAll: () => [],
        ...werte[selector],
      });
    }
    return elements.get(selector);
  };
  opts.onSave({
    querySelector: (selector) => (selector in werte && werte[selector] === null ? null : element(selector)),
    querySelectorAll: () => [],
    addEventListener() {},
  });
  return {
    element, fokus,
    absenden: (selector) => {
      const fn = handlers.get(`${selector}:submit`);
      assert.equal(typeof fn, 'function', `${selector} hat einen Submit-Handler`);
      return fn({ preventDefault() {} });
    },
  };
}

const assertNoServerText = () => {
  for (const [text] of toasts) assert.doesNotMatch(String(text), /Server sentence/, 'der Text des Servers im Toast');
};

// Loeschen: die 404 der Gesundheit heisst "geloescht" ODER "Betreuung entzogen,
// die Zeile steht noch" - deshalb nie ein Erfolg, sondern der Satz und frischer
// Stand vom Server (Codex an #1971).
const LOESCHEN = [
  ['Medikament', () => page.deleteMed({ id: 3 }), '/health/medications/3', 'health_medication_not_found', 'health.errorMedicationGone', 'health.meds.deleteError', null],
  ['Dosis-Eintrag', () => page.deleteMedLog({ id: 4 }), '/health/logs/4', 'health_dose_not_found', 'health.errorDoseGone', 'health.meds.log.saveError', null],
  ['Befund', () => page.deleteLabReport({ id: 5 }), '/health/labs/5', 'health_lab_report_not_found', 'health.errorLabReportGone', 'health.labs.deleteError', '/health/labs'],
  ['Aktivitaet', () => page.deleteActivity({ id: 6 }), '/health/activities/6', 'health_activity_not_found', 'health.errorActivityGone', 'health.activity.deleteError', '/health/activities'],
  ['Periode', () => page.deletePeriod({ id: 7 }), '/health/cycle/periods/7', 'health_cycle_period_not_found', 'health.errorPeriodGone', 'health.cycle.deleteError', '/health/cycle/periods'],
  ['Tageseintrag', () => page.deleteDayLog({ id: 8 }), '/health/cycle/logs/8', 'health_cycle_log_not_found', 'health.errorCycleDayGone', 'health.cycle.deleteError', '/health/cycle/logs'],
];

for (const [name, loesche, path, reason, goneKey, fallbackKey, reloadPrefix] of LOESCHEN) {
  test(`Seite: ${name} loeschen, das "nicht gefunden" wird - kein Erfolg, sein Satz, der Dialog geht zu, der Bereich kommt frisch`, async () => {
    const { calls, closed, gets } = await mit({ delete: async () => { throw fehler(404, reason); } }, loesche);
    assert.deepEqual(calls[0], ['DELETE', path]);
    assert.deepEqual(toasts, [[goneKey, 'danger']]);
    assert.equal(closed.length, 1);
    // Die Medikamente laden nur, was gemountet ist - ohne Wurzel ist das nichts.
    if (reloadPrefix) assert.ok(gets.some((p) => p.startsWith(reloadPrefix)), `nachgeladen: ${gets.join(', ')}`);
  });

  test(`Seite: ${name} loeschen scheitert an etwas anderem - der allgemeine Satz der Stelle, nie der des Servers`, async () => {
    for (const err of [fehler(400), fehler(404), fehler(500), fehler(404, 'health_future_not_found')]) {
      await mit({ delete: async () => { throw err; } }, loesche);
      assert.deepEqual(toasts, [[fallbackKey, 'danger']], `${err.status} ${err.data.reason ?? ''}`);
      assertNoServerText();
    }
  });
}

test('Seite: ein Messwert mit Ruecknahme-Toast, dessen Loeschen "nicht gefunden" wird - nicht zurueckgestellt, sondern Satz und frischer Stand', async () => {
  const row = { id: 11, type: 'weight', value_num: 70, measured_at: '2026-01-05T08:00' };
  for (const [err, expected, restored] of [
    [fehler(404, 'health_vital_not_found'), [['health.errorVitalGone', 'danger']], false],
    [fehler(500), [], true],
  ]) {
    page.setViewStateForTest('vitals', { rows: [row] });
    let opts = null;
    globalThis.__undoStub = (o) => { opts = o; };
    try {
      page.deleteVitalWithUndo(11);
    } finally {
      delete globalThis.__undoStub;
    }
    assert.ok(opts, 'der Ruecknahme-Weg wurde gestartet');
    // Wie utils/ux.js nach Ablauf der Frist: commit, und scheitert er, restore(err).
    const { calls, gets, closed } = await mit({ delete: async () => { throw err; } }, async () => {
      try { await opts.commit({ keepalive: false }); } catch (e) { opts.restore(e); }
    });
    assert.deepEqual(calls[0], ['DELETE', '/health/vitals/11']);
    assert.deepEqual(toasts, expected);
    assert.equal(gets.some((p) => p.startsWith('/health/vitals')), !restored, `nachgeladen: ${gets.join(', ')}`);
    // Das Loeschen laeuft nach der Frist: ein Dialog, der jetzt offen ist,
    // gehoert zu einer spaeteren Handlung und bleibt (Codex an #1971).
    assert.deepEqual(closed, [], 'kein Dialog wird geschlossen');
    assert.equal(gets.includes('/health/caregivers/me'), !restored, 'die Betreuungen kommen mit');
    page.setViewStateForTest('vitals', { rows: [] });
  }
});

test('Seite: das Medikament ist weg, waehrend der Dialog offen ist - sein Satz, der Dialog geht zu, die Seite laedt nach', async () => {
  // Ein anderer Fall des "gibt es nicht mehr" am Loeschweg: nicht das Ding selbst.
  const { closed } = await mit({ delete: async () => { throw fehler(404, 'health_dose_not_found'); } },
    () => page.deleteMed({ id: 3 }));
  assert.deepEqual(toasts, [['health.errorDoseGone', 'danger']]);
  assert.equal(closed.length, 1);
});

test('Seite: Periode heute beenden, die es nicht mehr gibt - ihr Satz statt des Servertexts, der Zyklus kommt frisch, und ein spaeter geoeffneter Dialog bleibt', async () => {
  page.setViewStateForTest('cycle', { periods: [{ id: 9, start_date: '2020-01-05', end_date: null }], logs: [] });
  try {
    const { calls, closed, gets } = await mit({ patch: async () => { throw fehler(404, 'health_cycle_period_not_found'); } },
      () => page.cycleEndPeriodToday());
    assert.deepEqual(calls[0], ['PATCH', '/health/cycle/periods/9']);
    assert.deepEqual(toasts, [['health.errorPeriodGone', 'danger']]);
    // Kein Dialog gehoert zu dieser Handlung: was jetzt offen ist, wurde
    // spaeter geoeffnet und bleibt (Codex an #1971).
    assert.deepEqual(closed, []);
    assert.ok(gets.some((p) => p.startsWith('/health/cycle/periods')), `nachgeladen: ${gets.join(', ')}`);
    // Die 404 kann "Betreuung entzogen" heissen: die Betreuungen kommen mit
    // (Codex an #1971), sonst boeten die Knoepfe das Schreiben weiter an.
    assert.ok(gets.includes('/health/caregivers/me'), `Betreuungen nachgeladen: ${gets.join(', ')}`);
  } finally {
    page.setViewStateForTest('cycle', { periods: [], logs: [] });
  }
});

test('Seite: Periode heute beginnen, Server lehnt ohne bekannten Fall ab - der allgemeine Satz, kein Nachladen', async () => {
  const { closed, gets } = await mit({ post: async () => { throw fehler(400); } }, () => page.cycleStartPeriodToday());
  assert.deepEqual(toasts, [['health.cycle.saveError', 'danger']]);
  assert.deepEqual([closed, gets], [[], []]);
});

test('Seite: zwei Messwerte in der Ruecknahmefrist, das erste Loeschen wird "nicht gefunden" - das zweite kommt beim Nachladen nicht zurueck', async () => {
  const a = { id: 21, type: 'weight', value_num: 70, measured_at: '2026-01-05T08:00' };
  const b = { id: 22, type: 'weight', value_num: 71, measured_at: '2026-01-06T08:00' };
  page.setViewStateForTest('vitals', { rows: [a, b] });
  const undo = [];
  globalThis.__undoStub = (o) => { undo.push(o); };
  try {
    page.deleteVitalWithUndo(21);
    page.deleteVitalWithUndo(22);
  } finally {
    delete globalThis.__undoStub;
  }
  assert.equal(undo.length, 2);
  // Der Server kennt beide noch: 21 hat ein anderes Mitglied schon geloescht
  // (Antwort: nicht gefunden), 22 steht bis zu seinem eigenen Loeschen.
  await mit({ delete: async () => { throw fehler(404, 'health_vital_not_found'); } }, async () => {
    const get = globalThis.__apiStub.get;
    globalThis.__apiStub.get = async (path) => (path.startsWith('/health/vitals') ? { data: [b] } : get(path));
    try { await undo[0].commit({ keepalive: false }); } catch (e) { undo[0].restore(e); }
  });
  assert.deepEqual(toasts, [['health.errorVitalGone', 'danger']]);
  assert.deepEqual(page.vitalRowIdsForTest(), [], 'die zweite, noch nicht geloeschte Zeile bleibt verborgen');
  // Ihr eigenes Loeschen laeuft danach durch und laedt nicht nach.
  await mit({ delete: async () => ({}) }, () => undo[1].commit({ keepalive: false }));
  assert.deepEqual(page.vitalRowIdsForTest(), []);
  page.setViewStateForTest('vitals', { rows: [] });
});

test('Seite: ein Nachladen, das vor dem gelungenen Loeschen losging, bringt die geloeschte Zeile nicht zurueck', async () => {
  const a = { id: 31, type: 'weight', value_num: 70, measured_at: '2026-01-05T08:00' };
  const b = { id: 32, type: 'weight', value_num: 71, measured_at: '2026-01-06T08:00' };
  page.setViewStateForTest('vitals', { rows: [a, b] });
  const undo = [];
  globalThis.__undoStub = (o) => { undo.push(o); };
  try {
    page.deleteVitalWithUndo(31);
    page.deleteVitalWithUndo(32);
  } finally {
    delete globalThis.__undoStub;
  }
  let release;
  const held = new Promise((r) => { release = r; });
  await mit({ delete: async (path) => {
    if (path === '/health/vitals/31') throw fehler(404, 'health_vital_not_found');
    return {};
  } }, async () => {
    const get = globalThis.__apiStub.get;
    // Die Antwort des Nachladens kommt erst, nachdem das zweite Loeschen
    // gelungen ist - sie traegt die Zeile 32 noch (Codex an #1971).
    globalThis.__apiStub.get = async (path) => {
      if (!path.startsWith('/health/vitals')) return get(path);
      await held;
      return { data: [b] };
    };
    try { await undo[0].commit({ keepalive: false }); } catch (e) { undo[0].restore(e); }
    await undo[1].commit({ keepalive: false });
    release();
  });
  assert.deepEqual(page.vitalRowIdsForTest(), [], 'die veraltete Antwort bringt die geloeschte Zeile nicht zurueck');
  page.setViewStateForTest('vitals', { rows: [] });
});

const vorsorgeDialog = (row) => dialog(() => page.openPreventionModal(row), {
  '#prevention-type': { value: '12' }, '#prevention-name': { value: '' }, '#prevention-given-on': { value: '2026-01-05' },
  '#prevention-next-due': null,
});

test('Seite: die gewaehlte Vorsorgeart ist weg - der Dialog bleibt, die Auswahl steht auf "keine Art", die Arten kommen frisch', async () => {
  page.setViewStateForTest('prevention', { types: [{ id: 12, name: 'Tetanus' }], records: [] });
  try {
    const d = await vorsorgeDialog(null);
    const { calls, closed, gets } = await mit({ post: async () => { throw fehler(400, 'health_prevention_selected_type_not_found'); } },
      () => d.absenden('#prevention-form'));
    assert.deepEqual(calls[0], ['POST', '/health/prevention/records']);
    assert.deepEqual(toasts, [['health.errorSelectedPreventionTypeGone', 'danger']]);
    assert.deepEqual(closed, [], 'der Dialog bleibt mit den Eingaben offen');
    assert.ok(gets.includes('/health/prevention/types'), `Arten nachgeladen: ${gets.join(', ')}`);
    const select = d.element('#prevention-type');
    assert.equal(select.value, '');
    assert.doesNotMatch(select.html, /Tetanus/, 'die geloeschte Art steht nicht mehr zur Wahl');
    assert.equal(d.element('#prevention-name-field').hidden, false, 'das Namensfeld ist wieder da');
    assert.deepEqual(d.fokus, ['#prevention-type']);
  } finally {
    page.setViewStateForTest('prevention', { types: [], records: [] });
  }
});

test('Seite: die gewaehlte Vorsorgeart ist weg und das Nachladen der Arten scheitert - die geloeschte Art steht trotzdem nicht mehr zur Wahl', async () => {
  page.setViewStateForTest('prevention', { types: [{ id: 12, name: 'Tetanus' }, { id: 13, name: 'Grippe' }], records: [] });
  try {
    const d = await vorsorgeDialog(null);
    const { closed } = await mit({ post: async () => { throw fehler(400, 'health_prevention_selected_type_not_found'); } },
      async () => {
        const get = globalThis.__apiStub.get;
        globalThis.__apiStub.get = async (path) => {
          if (path === '/health/prevention/types') throw fehler(500);
          return get(path);
        };
        await d.absenden('#prevention-form');
      });
    assert.deepEqual(toasts, [['health.errorSelectedPreventionTypeGone', 'danger']]);
    assert.deepEqual(closed, []);
    const select = d.element('#prevention-type');
    assert.doesNotMatch(select.html, /Tetanus/, 'die geloeschte Art steht nicht mehr zur Wahl');
    assert.match(select.html, /Grippe/, 'die anderen bleiben');
  } finally {
    page.setViewStateForTest('prevention', { types: [], records: [] });
  }
});

test('Seite: der Vorsorge-Eintrag ist weg - sein Satz, der Dialog geht zu', async () => {
  page.setViewStateForTest('prevention', { types: [{ id: 12, name: 'Tetanus' }], records: [] });
  try {
    const d = await vorsorgeDialog({ id: 30, type_id: 12, given_on: '2026-01-05' });
    const { closed } = await mit({ patch: async () => { throw fehler(404, 'health_prevention_record_not_found'); } },
      () => d.absenden('#prevention-form'));
    assert.deepEqual(toasts, [['health.errorPreventionRecordGone', 'danger']]);
    assert.equal(closed.length, 1);
  } finally {
    page.setViewStateForTest('prevention', { types: [], records: [] });
  }
});

test('Seite: der Import der Historie sagt die Grenze in der Sprache der App, nicht den Text des Servers', async () => {
  for (const [err, expected] of [
    [fehler(400, 'health_cycle_import_too_large', { limit_kb: 100 }), 'health.errorCycleImportTooLarge{"limit_kb":100}'],
    [fehler(400, 'health_cycle_import_too_many_rows', { limit: 500 }), 'health.errorCycleImportTooManyRows{"limit":500}'],
    [fehler(400, 'health_cycle_import_no_rows'), 'health.errorCycleImportNoRows'],
    [fehler(400), 'health.cycle.import.error'],
  ]) {
    const d = await dialog(() => page.openCycleImportModal(), { '#cycle-import-paste': { value: 'start_date' } });
    await mit({ post: async () => { throw err; } }, () => d.absenden('#cycle-import-form'));
    assert.deepEqual(toasts, [[expected, 'danger']]);
    assertNoServerText();
  }
});

// Einstellungen: das Register der Vorsorgearten.
test('Einstellungen: eine Vorsorgeart speichern, die ein anderer Admin geloescht hat - ihr Satz, der Dialog geht zu', async () => {
  const d = await dialog(() => settings.openTypeModal({ id: 12, name: 'Tetanus', kind: 'vaccination', icon: 'syringe' }), {
    '#hpt-name': { value: 'Tetanus' }, '#hpt-kind': { value: 'vaccination' }, '#hpt-interval': { value: '' },
    '#hpt-interval-unit': { value: 'months' }, '#hpt-icon': { value: 'syringe' },
  });
  const { closed } = await mit({ patch: async () => { throw fehler(404, 'health_prevention_type_not_found'); } },
    () => d.absenden('#health-prevention-type-form'));
  assert.deepEqual(toasts, [['health.errorPreventionTypeGone', 'danger']]);
  assert.equal(closed.length, 1);
});
