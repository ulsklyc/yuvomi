/**
 * Budget structure guard.
 *
 * Sichert die modulare Aufteilung von server/routes/budget.js: der Orchestrator
 * muss dieselbe {Methode, Pfad}-Routentabelle wie vor dem Split ergeben (33
 * Routen) und die vollständige öffentliche Export-Fläche re-exportieren. Fängt
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

import budgetRouter, {
  computeStatsRange,
  generateRecurringInstances, monthsPerInterval, effectiveMonthly, RECURRENCE_INTERVAL_KEYS,
  categoryInUseCount, subcategoryInUseCount, categoryCountByType, subcategoryCountForCategory,
  resolveExportRange,
  BUDGET_SAVINGS_KEY, computePlanProgress,
  computeStats, statsHandler,
} from '../server/routes/budget.js';

import entriesRouter from '../server/routes/budget/entries.js';
import categoriesRouter from '../server/routes/budget/categories.js';
import loansRouter from '../server/routes/budget/loans.js';
import accountsRouter from '../server/routes/budget/accounts.js';
import plansRouter from '../server/routes/budget/plans.js';
import statsRouter from '../server/routes/budget/stats.js';

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
  'PATCH /categories/reorder',
  'POST /categories/:categoryKey/subcategories',
  'PUT /categories/:key/subcategories/:subKey',
  'DELETE /categories/:key/subcategories/:subKey',
  'PATCH /categories/:key/subcategories/reorder',
  // loans
  'GET /loans',
  'POST /loans',
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

test('Orchestrator ergibt exakt die erwartete Routentabelle (33 Routen)', () => {
  const actual = collectRoutes(budgetRouter).sort();
  assert.deepEqual(actual, [...EXPECTED].sort());
  assert.equal(actual.length, 33);
});

test('die Cluster-Router zusammen ergeben genau die Orchestrator-Routen (keine verlorene/doppelte Route)', () => {
  const perModule = [
    entriesRouter, categoriesRouter, loansRouter, accountsRouter, plansRouter, statsRouter,
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
    computeStatsRange, generateRecurringInstances, monthsPerInterval, effectiveMonthly,
    categoryInUseCount, subcategoryInUseCount, categoryCountByType, subcategoryCountForCategory,
    resolveExportRange, computePlanProgress, computeStats, statsHandler,
  };
  for (const [name, fn] of Object.entries(fns)) {
    assert.equal(typeof fn, 'function', `${name} fehlt oder ist keine Funktion`);
  }
  assert.ok(Array.isArray(RECURRENCE_INTERVAL_KEYS), 'RECURRENCE_INTERVAL_KEYS fehlt');
  assert.deepEqual(RECURRENCE_INTERVAL_KEYS, ['monthly', 'half_year', 'yearly']);
  assert.equal(BUDGET_SAVINGS_KEY, '__savings__');
});
