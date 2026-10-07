/**
 * Modul: Übersichts-/Export-Logik-Test
 * Zweck: Reine Funktionen des Übersicht-Tabs — upcomingDoses() (heute noch offene
 *        Zeitfenster) und computeAdherenceStreak() (Einnahme-Serie) — sowie die
 *        server-seitige CSV-Serialisierung (health-export.js: Escaping, Header,
 *        Analyt-Flattening). DOM-frei.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-health-overview.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { upcomingDoses, computeAdherenceStreak } = await import('../public/utils/health-overview.js');
const {
  csvCell, toCsv, vitalsToCsv, activitiesToCsv, labsToCsv, medLogsToCsv,
} = await import('../server/services/health-export.js');

// Tägliche Einnahmepläne (days_mask null = jeden Tag).
const dailyAt = (id, time) => ({ id, medication_id: 1, time_of_day: time, days_mask: null, active: 1, dose_qty: 1 });
const TODAY = '2026-07-01'; // Mittwoch

// --------------------------------------------------------
// upcomingDoses
// --------------------------------------------------------

test('upcomingDoses: nur Zeitfenster ab nowTime, chronologisch', () => {
  const schedules = [dailyAt(1, '08:00'), dailyAt(2, '20:00')];
  const up = upcomingDoses(schedules, [], { today: TODAY, nowTime: '12:00' });
  assert.equal(up.length, 1);
  assert.equal(up[0].time, '20:00');
});

test('upcomingDoses: bereits genommene/übersprungene Dosen fallen raus', () => {
  const schedules = [dailyAt(1, '08:00'), dailyAt(2, '20:00')];
  const logs = [{ schedule_id: 1, scheduled_at: `${TODAY}T08:00`, status: 'taken' }];
  const up = upcomingDoses(schedules, logs, { today: TODAY, nowTime: '07:00' });
  assert.deepEqual(up.map((d) => d.time), ['20:00']);
});

test('upcomingDoses: pending-Log bleibt offen; limit greift', () => {
  const schedules = [dailyAt(1, '08:00'), dailyAt(2, '12:00'), dailyAt(3, '20:00')];
  const logs = [{ schedule_id: 1, scheduled_at: `${TODAY}T08:00`, status: 'pending' }];
  const up = upcomingDoses(schedules, logs, { today: TODAY, nowTime: '00:00', limit: 2 });
  assert.equal(up.length, 2);
  assert.deepEqual(up.map((d) => d.time), ['08:00', '12:00']);
});

test('upcomingDoses: ohne today leer', () => {
  assert.deepEqual(upcomingDoses([dailyAt(1, '08:00')], [], {}), []);
});

// --------------------------------------------------------
// computeAdherenceStreak
// --------------------------------------------------------

const takenOn = (day) => ({ schedule_id: 1, scheduled_at: `${day}T08:00`, status: 'taken' });

test('computeAdherenceStreak: aufeinanderfolgende volle Tage zählen', () => {
  const schedules = [dailyAt(1, '08:00')];
  const logs = [takenOn('2026-07-01'), takenOn('2026-06-30'), takenOn('2026-06-29')];
  assert.equal(computeAdherenceStreak(schedules, logs, { today: TODAY }), 3);
});

test('computeAdherenceStreak: vergangener offener Tag beendet die Serie', () => {
  const schedules = [dailyAt(1, '08:00')];
  // 06-30 fehlt → Serie bricht dort ab, nur heute zählt.
  const logs = [takenOn('2026-07-01'), takenOn('2026-06-29')];
  assert.equal(computeAdherenceStreak(schedules, logs, { today: TODAY }), 1);
});

test('computeAdherenceStreak: heute noch offen bricht Serie nicht', () => {
  const schedules = [dailyAt(1, '08:00')];
  // heute keine Einnahme, aber gestern/vorgestern voll → Serie = 2.
  const logs = [takenOn('2026-06-30'), takenOn('2026-06-29')];
  assert.equal(computeAdherenceStreak(schedules, logs, { today: TODAY }), 2);
});

test('computeAdherenceStreak: keine Logs → 0', () => {
  assert.equal(computeAdherenceStreak([dailyAt(1, '08:00')], [], { today: TODAY }), 0);
});

// --------------------------------------------------------
// CSV-Serialisierung (health-export.js)
// --------------------------------------------------------

test('csvCell: quotet, verdoppelt Anführungszeichen, entschärft Formel-Injection', () => {
  assert.equal(csvCell('abc'), '"abc"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell('=SUM(A1)'), `"'=SUM(A1)"`);
  assert.equal(csvCell('+49'), `"'+49"`);
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.equal(csvCell(120), '"120"');
});

test('toCsv: Header + Zeilen, nur Header ohne Zeilen', () => {
  assert.equal(toCsv(['a', 'b'], []), '"a","b"');
  assert.equal(toCsv(['a', 'b'], [[1, 2]]), '"a","b"\n"1","2"');
});

test('vitalsToCsv: Header-Reihenfolge + Werte', () => {
  const csv = vitalsToCsv([{
    measured_at: '2026-06-01T08:00', type: 'bp', value_num: 120, value_num2: 80,
    value_num3: 60, unit: 'mmHg', note: 'ok', visibility: 'private',
  }]);
  const [head, row] = csv.split('\n');
  assert.equal(head, '"measured_at","type","value_num","value_num2","value_num3","unit","note","visibility"');
  assert.ok(row.startsWith('"2026-06-01T08:00","bp","120","80","60","mmHg","ok","private"'));
});

test('activitiesToCsv: Header + Zeile', () => {
  const csv = activitiesToCsv([{
    performed_at: '2026-07-01T07:00', type: 'running', duration_min: 30,
    distance_km: 5, intensity: 'hoch', calories: 300, note: '', visibility: 'family',
  }]);
  const [head, row] = csv.split('\n');
  assert.equal(head, '"performed_at","type","duration_min","distance_km","intensity","calories","note","visibility"');
  assert.ok(row.includes('"running"') && row.includes('"5"'));
});

test('labsToCsv: eine Zeile je Analyt; Befund ohne Analyten → eine Kopfzeile', () => {
  const csv = labsToCsv([
    {
      report_date: '2026-06-01', lab_name: 'Labor A', visibility: 'private', note: '',
      results: [
        { analyte: 'Hb', value_num: 14, unit: 'g/dL', ref_low: 13, ref_high: 17, flag: 'normal' },
        { analyte: 'Glc', value_num: 110, unit: 'mg/dL', ref_low: 70, ref_high: 100, flag: 'high' },
      ],
    },
    { report_date: '2026-05-01', lab_name: 'Labor B', visibility: 'family', note: 'leer', results: [] },
  ]);
  const lines = csv.split('\n');
  assert.equal(lines[0], '"report_date","lab_name","analyte","value_num","unit","ref_low","ref_high","flag","visibility","note"');
  assert.equal(lines.length, 4); // Header + 2 Analyten + 1 leerer Befund
  assert.ok(lines[1].includes('"Hb"') && lines[1].includes('"Labor A"'));
  assert.ok(lines[3].startsWith('"2026-05-01","Labor B","","","","","","","family","leer"'));
});

test('medLogsToCsv: Header + medication_name', () => {
  const csv = medLogsToCsv([{
    scheduled_at: '2026-07-01T08:00', medication_name: 'Aspirin', status: 'taken',
    taken_at: '2026-07-01T08:05', dose_qty: 1, note: '',
  }]);
  const [head, row] = csv.split('\n');
  assert.equal(head, '"scheduled_at","medication","status","taken_at","dose_qty","note"');
  assert.ok(row.includes('"Aspirin"') && row.includes('"taken"'));
});

// ---------------------------------------------------------------------------
// Critique R17: Abstand vor dem Vitalwerte-Band, und der Name in der Dosiszeile
// ---------------------------------------------------------------------------
test('R17: das Vitalwerte-Band bringt seinen Abstand selbst mit - welche Spalte auch die hoechste ist', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/health.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)].filter((r) => r.at.length === 0);
  const body = (sel) => rules.filter((r) => r.selector.trim() === sel).map((r) => r.body).join(';');
  // Der Abstand zwischen den Karten ist ihr margin-bottom; vor einem
  // Spaltenumbruch wird er abgeschnitten. War eine vordere Spalte die
  // hoechste, begann das Band 0px unter ihr („Einnahmetreue" endet y=433,
  // „Letzte Vitalwerte" beginnt y=433).
  assert.match(body('.health-overview__card'), /margin-bottom:\s*var\(--space-4\)/, 'Vorbedingung: der Kartenabstand ist ein margin-bottom');
  assert.match(body('.health-overview__card--vitals'), /column-span:\s*all/, 'Vorbedingung: das Band ueberspannt die Spalten');
  assert.match(body('.health-overview__card:has(+ .health-overview__card--vitals)'), /margin-bottom:\s*0/,
    'die Karte vor dem Band gibt ihren (mal abgeschnittenen, mal gezaehlten) Abstand ab');
  assert.match(body('.health-overview__card--vitals:not(:first-child)'), /margin-top:\s*var\(--space-4\)/,
    'das Band traegt den regulaeren Abschnittsabstand selbst');
});

test('R17: schmal bekommt der Medikamentenname die Zeile, die Aktionen stehen darunter', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/health.css', import.meta.url), 'utf8');
  const narrow = [...eachRule(css)].filter((r) => r.at.some((a) => /@container list-rows \(max-width: 26rem\)/.test(a)));
  const row = narrow.find((r) => r.selector.trim() === '.health-dose');
  assert.match(row?.body ?? '', /flex-wrap:\s*wrap/, 'nur diese Zeile, nur schmal, bricht um');
  const name = narrow.find((r) => r.selector.trim() === '.health-dose > .health-dose__name');
  assert.match(name?.body ?? '', /flex:\s*1 0 100%/, 'der Name nimmt die ganze erste Zeile (vorher 81px, Bruch mitten im Wort)');
  assert.match(name?.body ?? '', /order:\s*-1/, 'vor der Uhrzeit - Uhrzeit und Aktionen teilen die zweite Zeile');
  // Die geteilte Zeile bleibt nowrap: die Regel steht NUR in der Container-Abfrage.
  const flat = [...eachRule(css)].filter((r) => r.at.length === 0 && r.selector.trim() === '.health-dose');
  for (const r of flat) assert.doesNotMatch(r.body, /flex-wrap/, 'ausserhalb der schmalen Stufe bricht die Dosiszeile nicht um');
});

// --------------------------------------------------------
// Ladewellen der Uebersicht (Critique R18)
//
// Gemessen am gedrosselten Telefon lud die Uebersicht in sechs Wellen:
// Mitglieder, dann Vitalwerte + Medikamente, dann Zyklus-Perioden + -Logs, dann
// Zyklus-Einstellungen, dann je Medikament Plaene + Logs. Was nicht voneinander
// abhaengt, steht jetzt in EINER Welle. loadOverview() laeuft hier als PROGRAMM:
// sein Quelltext aus health.js, mit einer `api`, die erst antwortet, wenn der
// Test es sagt - so ist sichtbar, welche Abrufe gleichzeitig offen sind.
// --------------------------------------------------------

async function loadOverviewHarness({ cycleEnabled, personId, meId, meds = [] }) {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function loadOverview() {');
  const end = src.indexOf('\nfunction overviewAllSchedules()');
  assert.ok(start > 0 && end > start, 'loadOverview() nicht gefunden');
  const body = src.slice(start, end);

  const open = [];
  const api = {
    get: (path) => new Promise((resolve, reject) => { open.push({ path, resolve, reject }); }),
  };
  const overview = { personId, meId, vitals: null, meds: null, cyclePeriods: null, cycleLogs: null, cycleSettings: undefined };
  const AsyncFunction = (async () => {}).constructor;
  const run = new AsyncFunction(
    'overview', 'api', 'cycleEnabled', 'todayKey', 'addLocalDays', 'medLogWindowDays', 'OVERVIEW_ADHERENCE_DAYS',
    `${body}\nreturn loadOverview();`,
  );
  const done = run(overview, api, cycleEnabled, () => '2026-10-07', (key) => key, () => 30, 30);
  // Eine Welle = alles, was offen ist, sobald der Code nicht mehr weiterkommt.
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const answer = (pick) => {
    for (const req of open.splice(0)) {
      if (req.path.includes('/medications?') || req.path === '/health/medications') req.resolve({ data: meds });
      else if (pick) pick(req);
      else req.resolve({ data: req.path === '/health/cycle/settings' ? {} : [] });
    }
  };
  // FRIST IM TEST SELBST: braucht der Code mehr Wellen, als der Fall
  // beantwortet (der Stand vor R18), bliebe `done` fuer immer offen und die
  // Suite hinge, statt rot zu werden.
  const finished = () => {
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`loadOverview() wartet noch auf: ${paths(open).join(', ')}`)), 500);
    });
    return Promise.race([done, late]).finally(() => clearTimeout(timer));
  };
  return { open, overview, done, finished, settle, answer };
}

const paths = (open) => open.map((req) => req.path.replace(/\?.*$/, '')).sort();

test('overview: vitals, medications and all three cycle requests are one wave', async () => {
  const h = await loadOverviewHarness({ cycleEnabled: true, personId: 4, meId: 4, meds: [{ id: 9 }] });
  await h.settle();

  assert.deepEqual(paths(h.open), [
    '/health/cycle/logs', '/health/cycle/periods', '/health/cycle/settings',
    '/health/medications', '/health/vitals',
  ], 'fuenf Abrufe gleichzeitig offen, keiner wartet auf einen anderen');

  h.answer();
  await h.settle();
  assert.deepEqual(paths(h.open), ['/health/medications/9/logs', '/health/medications/9/schedules'],
    'erst die zweite Welle haengt an der Medikamentenliste');
  h.answer();
  await h.finished();
  assert.deepEqual(h.overview.cycleSettings, {});
});

test('overview: the cycle rule still decides what is requested at all', async () => {
  const off = await loadOverviewHarness({ cycleEnabled: false, personId: 4, meId: 4 });
  await off.settle();
  assert.deepEqual(paths(off.open), ['/health/medications', '/health/vitals'], 'Zyklus abgewaehlt: kein Zyklus-Abruf');
  off.answer();
  await off.finished();
  assert.deepEqual([off.overview.cyclePeriods, off.overview.cycleLogs, off.overview.cycleSettings], [[], [], null]);

  const other = await loadOverviewHarness({ cycleEnabled: true, personId: 5, meId: 4 });
  await other.settle();
  assert.deepEqual(paths(other.open), ['/health/cycle/logs', '/health/cycle/periods', '/health/medications', '/health/vitals'],
    'fremde Person: die privaten Einstellungen werden nicht angefragt');
  assert.ok(other.open.every((req) => req.path.endsWith('?user_id=5')));
  other.answer();
  await other.finished();
  assert.equal(other.overview.cycleSettings, null);
});

test('overview: failing cycle settings stay harmless, any other failure aborts the load', async () => {
  const soft = await loadOverviewHarness({ cycleEnabled: true, personId: 4, meId: 4 });
  await soft.settle();
  soft.answer((req) => (req.path === '/health/cycle/settings' ? req.reject(new Error('500')) : req.resolve({ data: [] })));
  await soft.finished();
  assert.deepEqual(soft.overview.cycleSettings, {});

  const hard = await loadOverviewHarness({ cycleEnabled: true, personId: 4, meId: 4 });
  await hard.settle();
  hard.answer((req) => (req.path.startsWith('/health/cycle/periods') ? req.reject(new Error('403')) : req.resolve({ data: [] })));
  await assert.rejects(hard.finished(), /403/);
});

test('overview: members and data load side by side once the person is known', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  const mount = src.slice(src.indexOf('async function mountOverview() {'), src.indexOf('async function loadOverview() {'));
  assert.match(mount, /const person = overview\.personId \?\? overview\.meId;/);
  assert.match(mount, /await Promise\.all\(\[loadHealthMembers\(overview, healthUser\), loadOverview\(\)\]\);/);
  assert.match(mount, /\} else \{\s*await loadHealthMembers\(overview, healthUser\);\s*await loadOverview\(\);/,
    'ohne bekannte Person bestimmt weiter die Mitgliederliste, wer gezeigt wird');
});
