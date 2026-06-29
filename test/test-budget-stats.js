/**
 * Modul: Budget-Statistik - Tests
 * Zweck: computeStatsRange (Zeitraum/Buckets) + computeStats (Aggregation) + /stats-Validierung.
 * Ausführen: node --experimental-sqlite test/test-budget-stats.js
 */
import { computeStatsRange } from '../server/routes/budget.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
