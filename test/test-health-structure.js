/**
 * Health structure guard.
 *
 * Sichert die modulare Aufteilung von server/routes/health.js: der Orchestrator
 * muss dieselbe {Methode, Pfad}-Routentabelle wie vor dem Split ergeben (42
 * Routen), und die Tab-Cluster-Router müssen zusammen exakt diese Routen ergeben
 * (keine verlorene/doppelte Route). Fängt ab, dass ein Cluster-Router still nicht
 * gemountet wird oder eine Route beim Umbau verloren geht/umbenannt wird.
 *
 * Der Verhaltensbeweis liegt in den funktionalen Suiten (test:health-api,
 * test:health-vitals, test:health-meds, test:health-labs, test:health-activity,
 * test:health-cycle, test:health-overview, test:health-nav,
 * test:medication-scheduler); dieser Guard pinnt nur die Struktur.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import healthRouter from '../server/routes/health.js';

import vitalsRouter from '../server/routes/health/vitals.js';
import medicationsRouter from '../server/routes/health/medications.js';
import labsRouter from '../server/routes/health/labs.js';
import activitiesRouter from '../server/routes/health/activities.js';
import exportRouter from '../server/routes/health/export.js';
import cycleRouter from '../server/routes/health/cycle.js';

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
  // vitals
  'GET /vitals',
  'POST /vitals',
  'PATCH /vitals/:id',
  'DELETE /vitals/:id',
  // medications + schedules + logs
  'GET /medications',
  'POST /medications',
  'PATCH /medications/:id',
  'DELETE /medications/:id',
  'GET /medications/:id/schedules',
  'POST /medications/:id/schedules',
  'PATCH /schedules/:id',
  'DELETE /schedules/:id',
  'GET /medications/:id/logs',
  'POST /medications/:id/logs',
  'POST /logs/:id/take',
  'POST /logs/:id/skip',
  // labs + results
  'GET /labs',
  'GET /labs/:id',
  'POST /labs',
  'PATCH /labs/:id',
  'DELETE /labs/:id',
  'POST /labs/:id/results',
  'DELETE /results/:id',
  // activities
  'GET /activities',
  'POST /activities',
  'PATCH /activities/:id',
  'DELETE /activities/:id',
  // CSV-Übersichts-Exporte
  'GET /export/vitals',
  'GET /export/activities',
  'GET /export/labs',
  'GET /export/meds-logs',
  // cycle
  'GET /cycle/periods',
  'POST /cycle/periods',
  'PATCH /cycle/periods/:id',
  'DELETE /cycle/periods/:id',
  'GET /cycle/logs',
  'POST /cycle/logs',
  'DELETE /cycle/logs/:id',
  'GET /cycle/settings',
  'PUT /cycle/settings',
  'PATCH /cycle/visibility',
  'GET /export/cycle',
];

test('Orchestrator ergibt exakt die erwartete Routentabelle (42 Routen)', () => {
  const actual = collectRoutes(healthRouter).sort();
  assert.deepEqual(actual, [...EXPECTED].sort());
  assert.equal(actual.length, 42);
});

test('die Cluster-Router zusammen ergeben genau die Orchestrator-Routen (keine verlorene/doppelte Route)', () => {
  const perModule = [
    vitalsRouter, medicationsRouter, labsRouter, activitiesRouter, exportRouter, cycleRouter,
  ].flatMap(collectRoutes);
  // keine Route kommt in mehr als einem Cluster-Router vor
  const seen = new Set();
  for (const r of perModule) {
    assert.ok(!seen.has(r), `Route ${r} kommt in mehreren Cluster-Routern vor`);
    seen.add(r);
  }
  assert.deepEqual(perModule.sort(), collectRoutes(healthRouter).sort());
});

test('Default-Export ist ein montierbarer Router', () => {
  assert.equal(typeof healthRouter, 'function', 'default export ist kein Router');
});
