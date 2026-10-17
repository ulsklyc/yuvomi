/**
 * Budget structure guard.
 *
 * Sichert die modulare Aufteilung von server/routes/budget.js: der Orchestrator
 * muss die erwartete {Methode, Pfad}-Routentabelle ergeben und die vollständige
 * öffentliche Export-Fläche re-exportieren. Fängt
 * ab, dass ein Cluster-Router still nicht gemountet wird oder eine Route/ein
 * Export beim Umbau verloren geht.
 *
 * Der Verhaltensbeweis liegt in den funktionalen Suiten (test:ncb,
 * test:budget-recurrence, test:budget-stats, test:budget-plans,
 * test:budget-accounts, test:budget-visibility, test:budget-routes-scope,
 * test:subscriptions); dieser Guard pinnt nur die Struktur.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Set the test database before router imports initialise db.js, including direct Node runs.
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'budget-structure-test';

const { default: budgetRouter,
  computeStatsRange,
  generateRecurringInstances, occurrencesPerYear, occurrenceDatesInMonth, effectiveMonthly,
  normalizeIntervalCount, RECURRENCE_INTERVAL_KEYS, MAX_INTERVAL_COUNT,
  categoryInUseCount, subcategoryInUseCount, categoryCountByType, subcategoryCountForCategory,
  resolveExportRange,
  BUDGET_SAVINGS_KEY, computePlanProgress,
  computeStats, statsHandler,
} = await import('../server/routes/budget.js');

const [entries, categories, loans, accounts, plans, stats, transfers] = await Promise.all([
  import('../server/routes/budget/entries.js'),
  import('../server/routes/budget/categories.js'),
  import('../server/routes/budget/loans.js'),
  import('../server/routes/budget/accounts.js'),
  import('../server/routes/budget/plans.js'),
  import('../server/routes/budget/stats.js'),
  import('../server/routes/budget/transfers.js'),
]);
const entriesRouter = entries.default;
const categoriesRouter = categories.default;
const loansRouter = loans.default;
const accountsRouter = accounts.default;
const plansRouter = plans.default;
const statsRouter = stats.default;
const transfersRouter = transfers.default;

/** Sammelt rekursiv alle {METHOD path}-Paare eines Express-Routers (inkl. gemounteter Sub-Router). */
function collectRoutes(router) {
  const out = [];
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        const p = layer.route.path;
        const methods = layer.route.methods || (layer.route.route && layer.route.route.methods) || {};
        for (const m of Object.keys(methods)) {
          if (m === '_all') continue;
          out.push(`${m.toUpperCase()} ${p}`);
        }
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(router.stack);
  return out;
}

const EXPECTED = [
  // transfers
  'GET /transfers/:id',
  'POST /transfers',
  'PUT /transfers/:id',
  'PUT /transfers/:id/series',
  // entries
  'GET /summary',
  'GET /export',
  'GET /',
  'POST /',
  'PUT /:id/series',
  'DELETE /:id/series',
  'PUT /:id',
  'DELETE /:id',
  // categories
  'GET /meta',
  'GET /categories',
  'GET /categories/:categoryKey/subcategories',
  'POST /categories',
  'PUT /categories/:key',
  'DELETE /categories/:key',
  'PATCH /:id/confirm',
  'PATCH /categories/reorder',
  'POST /categories/:categoryKey/subcategories',
  'PUT /categories/:key/subcategories/:subKey',
  'DELETE /categories/:key/subcategories/:subKey',
  'PATCH /categories/:key/subcategories/reorder',
  // loans
  'GET /loans',
  'POST /loans',
  'POST /loans/preview',
  'PUT /loans/:id',
  'POST /loans/:id/payments',
  'DELETE /loans/:id/payments/:paymentId',
  'DELETE /loans/:id',
  // accounts
  'GET /accounts',
  'POST /accounts',
  'PUT /accounts/:id',
  'DELETE /accounts/:id',
  // plans
  'GET /plans',
  'PUT /plans/:category',
  'DELETE /plans/:category',
  // stats
  'GET /stats',
];

test('Orchestrator ergibt exakt die erwartete Routentabelle (39 Routen)', () => {
  const actual = collectRoutes(budgetRouter).sort();
  assert.deepEqual(actual, [...EXPECTED].sort());
  assert.equal(actual.length, 39);
});

test('die Cluster-Router zusammen ergeben genau die Orchestrator-Routen (keine verlorene/doppelte Route)', () => {
  const perModule = [
    entriesRouter, categoriesRouter, loansRouter, accountsRouter, plansRouter, statsRouter, transfersRouter,
  ].flatMap(collectRoutes);
  // keine Route kommt in mehr als einem Cluster-Router vor
  const seen = new Set();
  for (const r of perModule) {
    assert.ok(!seen.has(r), `Route ${r} kommt in mehreren Cluster-Routern vor`);
    seen.add(r);
  }
  assert.deepEqual(perModule.sort(), collectRoutes(budgetRouter).sort());
});

test('öffentliche Export-Fläche vollständig re-exportiert', () => {
  assert.equal(typeof budgetRouter, 'function', 'default export ist kein Router');
  const fns = {
    computeStatsRange, generateRecurringInstances, occurrencesPerYear, occurrenceDatesInMonth,
    normalizeIntervalCount, effectiveMonthly,
    categoryInUseCount, subcategoryInUseCount, categoryCountByType, subcategoryCountForCategory,
    resolveExportRange, computePlanProgress, computeStats, statsHandler,
  };
  for (const [name, fn] of Object.entries(fns)) {
    assert.equal(typeof fn, 'function', `${name} fehlt oder ist keine Funktion`);
  }
  assert.ok(Array.isArray(RECURRENCE_INTERVAL_KEYS), 'RECURRENCE_INTERVAL_KEYS fehlt');
  // Einheit + Anzahl statt fester Rhythmen (#636): 'half_year' ist monatlich x 6.
  assert.deepEqual(RECURRENCE_INTERVAL_KEYS, ['weekly', 'monthly', 'yearly']);
  assert.equal(MAX_INTERVAL_COUNT, 99, 'dieselbe Obergrenze wie im RRULE-Formular');
  assert.equal(BUDGET_SAVINGS_KEY, '__savings__');
});

// --------------------------------------------------------
// Erwartete Buchungen zählen in keiner Summe mit (#637)
// --------------------------------------------------------

/**
 * Als Regel über alle Dateien formuliert, nicht als Liste geprüfter Stellen:
 * eine neue Aggregation entsteht irgendwann, und eine Allowlist deckt genau die
 * nicht ab. Eine vergessene Stelle fällt sonst niemandem auf - sie zeigt nur
 * eine Zahl, die um eine erwartete Buchung danebenliegt.
 */
const SUM_SOURCES = [
  'server/routes/budget/entries.js',
  'server/routes/budget/stats.js',
  'server/routes/budget/plans.js',
  'server/routes/budget/helpers.js',
  'server/routes/dashboard.js',
];

/** Zerlegt eine Datei in ihre SQL-Template-Literale. */
function sqlStatements(source) {
  return [...source.matchAll(/`([^`]*)`/g)].map((m) => m[1]).filter((sql) => /\bFROM\s+budget_entries\b/i.test(sql));
}

test('jede Summe über budget_entries schließt erwartete Buchungen aus', () => {
  const offenders = [];
  for (const file of SUM_SOURCES) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const sql of sqlStatements(source)) {
      if (!/\bSUM\s*\(/i.test(sql)) continue;
      // Die Kennzahl der ausstehenden Buchungen selbst ist die Ausnahme: sie
      // zählt genau das Gegenteil und sagt es im Ausdruck auch so.
      if (/is_pending\s*=\s*1/.test(sql)) continue;
      const guarded = /bookedOnly\(/.test(sql) || /is_pending\s*=\s*0/.test(sql);
      if (!guarded) offenders.push(`${file}: ${sql.trim().slice(0, 90).replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(offenders, [], `Summe ohne is_pending-Filter:\n${offenders.join('\n')}`);
});

test('der Ausschluss kommt aus einer Quelle, nicht aus verstreuten Literalen', () => {
  const helpers = readFileSync(new URL('../server/routes/budget/helpers.js', import.meta.url), 'utf8');
  assert.match(helpers, /export function bookedOnly\(/, 'bookedOnly fehlt als geteilter Helfer');
  for (const file of ['server/routes/budget/entries.js', 'server/routes/budget/stats.js', 'server/routes/budget/plans.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes('bookedOnly'), `${file} nutzt den geteilten Helfer nicht`);
  }
});
