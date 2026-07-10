/**
 * Modul: Budget-Statistik - Tests
 * Zweck: computeStatsRange (Zeitraum/Buckets) + computeStats (Aggregation) + /stats-Validierung.
 * Ausführen: node --experimental-sqlite test/test-budget-stats.js
 */
import { computeStatsRange, computeStats, statsHandler, resolveExportRange } from '../server/routes/budget.js';
import { DatabaseSync } from 'node:sqlite';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }
function eq(a, b, msg) { assert(a === b, `${msg || ''} (erwartet ${b}, war ${a})`); }

// --- computeStatsRange ---
test('month: from/to + 1 Bucket pro Tag', () => {
  const r = computeStatsRange('month', '2026-06-15');
  eq(r.from, '2026-06-01', 'from');
  eq(r.to, '2026-06-30', 'to');
  eq(r.granularity, 'day', 'granularity');
  eq(r.bucketKeys.length, 30, 'anzahl tage');
  eq(r.bucketKeys[0], '2026-06-01', 'erster bucket');
  eq(r.bucketKeys[29], '2026-06-30', 'letzter bucket');
  eq(r.prevFrom, '2026-05-01', 'prevFrom');
  eq(r.prevTo, '2026-05-31', 'prevTo');
});

test('year: 12 Monats-Buckets', () => {
  const r = computeStatsRange('year', '2026-06-15');
  eq(r.from, '2026-01-01', 'from');
  eq(r.to, '2026-12-31', 'to');
  eq(r.granularity, 'month', 'granularity');
  eq(r.bucketKeys.length, 12, 'anzahl monate');
  eq(r.bucketKeys[0], '2026-01', 'erster bucket');
  eq(r.bucketKeys[11], '2026-12', 'letzter bucket');
  eq(r.prevFrom, '2025-01-01', 'prevFrom');
  eq(r.prevTo, '2025-12-31', 'prevTo');
});

test('week: Mo-So, 7 Tages-Buckets', () => {
  // 2026-06-15 ist ein Montag
  const r = computeStatsRange('week', '2026-06-17'); // Mittwoch
  eq(r.from, '2026-06-15', 'from (Montag)');
  eq(r.to, '2026-06-21', 'to (Sonntag)');
  eq(r.bucketKeys.length, 7, 'anzahl tage');
  eq(r.prevFrom, '2026-06-08', 'prevFrom');
  eq(r.prevTo, '2026-06-14', 'prevTo');
});

test('ungültiger range wirft', () => {
  let threw = false;
  try { computeStatsRange('decade', '2026-06-15'); } catch { threw = true; }
  assert(threw, 'sollte werfen');
});

test('ungültiger anchor wirft', () => {
  let threw = false;
  try { computeStatsRange('month', 'not-a-date'); } catch { threw = true; }
  assert(threw, 'sollte werfen');
});

// --- computeStats ---
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE budget_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, amount REAL NOT NULL,
      category TEXT NOT NULL DEFAULT 'Sonstiges', subcategory TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL, is_recurring INTEGER NOT NULL DEFAULT 0, created_by INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE budget_plans (
      category TEXT NOT NULL PRIMARY KEY, amount REAL NOT NULL,
      created_by TEXT, updated_at TEXT
    );
  `);
  return db;
}
function add(db, date, amount, category = 'food') {
  db.prepare('INSERT INTO budget_entries (title, amount, category, date) VALUES (?,?,?,?)')
    .run('x', amount, category, date);
}

test('computeStats month: totals + series-länge + zero-fill', () => {
  const db = freshDb();
  add(db, '2026-06-02', 1000, 'salary');   // income
  add(db, '2026-06-02', -200, 'food');     // expense
  add(db, '2026-06-20', -50, 'leisure');
  const r = computeStats(db, { range: 'month', anchor: '2026-06-15' });
  eq(r.totals.income, 1000, 'income');
  eq(r.totals.expenses, -250, 'expenses');
  eq(r.totals.balance, 750, 'balance');
  eq(r.series.length, 30, 'series len');
  eq(r.series[1].period, '2026-06-02', 'bucket 2 period');
  eq(r.series[1].balance, 800, 'bucket 2 balance (1000-200)');
  eq(r.series[0].income, 0, 'leerer bucket zero-filled');
});

test('computeStats byCategory: aggregiert + sortiert', () => {
  const db = freshDb();
  add(db, '2026-06-02', -200, 'food');
  add(db, '2026-06-10', -100, 'food');
  add(db, '2026-06-05', -500, 'rent');
  const r = computeStats(db, { range: 'month', anchor: '2026-06-15' });
  eq(r.byCategory[0].category, 'rent', 'größte zuerst');
  eq(r.byCategory[0].total, -500, 'rent total');
  eq(r.byCategory[1].category, 'food', 'food zweite');
  eq(r.byCategory[1].expenses, -300, 'food summe');
});

test('computeStats comparison: Vormonat', () => {
  const db = freshDb();
  add(db, '2026-05-10', -400, 'food'); // Vormonat
  add(db, '2026-06-10', -100, 'food'); // aktueller
  const r = computeStats(db, { range: 'month', anchor: '2026-06-15' });
  eq(r.totals.expenses, -100, 'aktuell');
  eq(r.comparison.expenses, -400, 'vormonat');
});

test('computeStats year: 12 buckets, monatliche aggregation', () => {
  const db = freshDb();
  add(db, '2026-03-10', -100, 'food');
  add(db, '2026-03-20', -50, 'food');
  const r = computeStats(db, { range: 'year', anchor: '2026-06-15' });
  eq(r.series.length, 12, '12 monate');
  eq(r.series[2].period, '2026-03', 'märz bucket');
  eq(r.series[2].expenses, -150, 'märz summe');
});

test('computeStats leer: alles 0, series zero-filled', () => {
  const r = computeStats(freshDb(), { range: 'month', anchor: '2026-06-15' });
  eq(r.totals.income, 0, 'income 0');
  eq(r.series.length, 30, 'series trotzdem 30');
  eq(r.series[0].balance, 0, 'bucket 0');
});

// --- statsHandler (HTTP-Validierung) ---
function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

test('statsHandler: 400 bei ungültigem range', () => {
  const res = mockRes();
  statsHandler({ query: { range: 'decade', anchor: '2026-06-15' } }, res);
  eq(res.statusCode, 400, 'status');
});

test('statsHandler: 400 bei ungültigem anchor', () => {
  const res = mockRes();
  statsHandler({ query: { range: 'month', anchor: 'xx' } }, res);
  eq(res.statusCode, 400, 'status');
});

// --- resolveExportRange ---
test('resolveExportRange: from/to hat Vorrang', () => {
  const r = resolveExportRange({ from: '2026-01-01', to: '2026-03-31', month: '2026-06' });
  eq(r.from, '2026-01-01', 'from'); eq(r.to, '2026-03-31', 'to');
});
test('resolveExportRange: fällt auf month zurück', () => {
  const r = resolveExportRange({ month: '2026-06' });
  eq(r.from, '2026-06-01', 'from'); eq(r.to, '2026-06-31', 'to');
});
test('resolveExportRange: ungültiges from/to → month-Fallback', () => {
  const r = resolveExportRange({ from: 'x', to: 'y', month: '2026-06' });
  eq(r.from, '2026-06-01', 'fallback from');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
