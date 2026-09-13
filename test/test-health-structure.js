/**
 * Health structure guard.
 *
 * Sichert die modulare Aufteilung von server/routes/health.js: der Orchestrator
 * muss dieselbe {Methode, Pfad}-Routentabelle wie vor dem Split ergeben (45
 * Routen: 42 aus dem Split, dazu die drei Betreuungs-Routen aus #584), und die Tab-Cluster-Router müssen zusammen exakt diese Routen ergeben
 * (keine verlorene/doppelte Route). Fängt ab, dass ein Cluster-Router still nicht
 * gemountet wird oder eine Route beim Umbau verloren geht/umbenannt wird.
 *
 * Dazu ein Scope-Guard (#884): ein abhängiger Datensatz - Zeitplan, Dosis-
 * Eintrag, Analyt - darf sein Schreibrecht nur über `writableChild()` aus
 * helpers.js beziehen. Ein handgeschriebenes `m.user_id = ?` sieht daneben
 * harmlos aus und schneidet die Betreuung (#584) still weg: anlegen ging,
 * wegräumen nicht. Der Guard ist deshalb eine Regel und keine Liste bekannter
 * Stellen - eine neue Route mit demselben Griff fällt sofort auf.
 *
 * Der Verhaltensbeweis liegt in den funktionalen Suiten (test:health-api,
 * test:health-vitals, test:health-meds, test:health-labs, test:health-activity,
 * test:health-cycle, test:health-overview, test:health-nav,
 * test:medication-scheduler); dieser Guard pinnt nur die Struktur.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import healthRouter from '../server/routes/health.js';

import vitalsRouter from '../server/routes/health/vitals.js';
import medicationsRouter from '../server/routes/health/medications.js';
import labsRouter from '../server/routes/health/labs.js';
import activitiesRouter from '../server/routes/health/activities.js';
import exportRouter from '../server/routes/health/export.js';
import cycleRouter from '../server/routes/health/cycle.js';
import cycleFeedRouter from '../server/routes/health/cycle-feed.js';
import caregiversRouter from '../server/routes/health/caregivers.js';
import visibilityDefaultsRouter from '../server/routes/health/visibility-defaults.js';
import fastingRouter from '../server/routes/health/fasting.js';

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
  // Korrigieren und Zuruecknehmen (#701): take/skip waren zwei Einbahnstrassen,
  // und die falsche Uhrzeit stand auch im Export.
  'PATCH /logs/:id',
  'DELETE /logs/:id',
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
  // Zyklus-ICS-Feed-Token (Migration 180)
  'GET /cycle/feed',
  'POST /cycle/feed/regenerate',
  'DELETE /cycle/feed',
  // Betreuung (#584): wer darf fuer wen eintragen
  'GET /caregivers/me',
  'GET /caregivers',
  'PUT /caregivers/:subjectId',
  // Persoenliche Standard-Sichtbarkeit je Bereich (#958)
  'GET /visibility-defaults',
  'PUT /visibility-defaults',
  'PATCH /visibility-defaults/apply',
  // fasting
  'GET /fasting',
  'POST /fasting',
  'GET /fasting/state',
  'GET /fasting/history',
  'GET /fasting/stats',
  'GET /fasting/settings',
  'PUT /fasting/settings',
  'POST /fasting/acknowledge-safety',
  'PATCH /fasting/:id',
  'DELETE /fasting/:id',
  'POST /fasting/:id/finish',
  'GET /export/fasting',
];

test('Orchestrator ergibt exakt die erwartete Routentabelle', () => {
  const actual = collectRoutes(healthRouter).sort();
  assert.deepEqual(actual, [...EXPECTED].sort());
  assert.equal(actual.length, EXPECTED.length);
});

test('die Cluster-Router zusammen ergeben genau die Orchestrator-Routen (keine verlorene/doppelte Route)', () => {
  const perModule = [
    vitalsRouter, medicationsRouter, labsRouter, activitiesRouter, exportRouter, cycleRouter,
    cycleFeedRouter, caregiversRouter, visibilityDefaultsRouter, fastingRouter,
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

// --------------------------------------------------------
// Scope-Guard (#884)
// --------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_DIR = path.join(HERE, '..', 'server', 'routes', 'health');

// helpers.js ist die eine Stelle, an der die Klausel gebaut werden DARF -
// dort steht sie in Template-Strings und ist genau der Helfer, den alle
// anderen benutzen sollen.
const SCOPE_OWNER = 'helpers.js';

// Ein Alias vor `user_id` heisst: die Spalte gehoert einer gejointen
// Eltern-Tabelle. Unqualifiziertes `user_id = ?` ist davon nicht betroffen -
// das ist die eigene Spalte, etwa im bewusst rein persoenlichen cycle.js.
const RAW_PARENT_SCOPE = /\b[a-z][a-z0-9_]*\.user_id\s*=\s*\?/;

test('kein handgeschriebenes <alias>.user_id = ? ausserhalb von helpers.js (#884)', () => {
  const offenders = [];
  for (const file of fs.readdirSync(ROUTE_DIR).filter((f) => f.endsWith('.js') && f !== SCOPE_OWNER)) {
    const lines = fs.readFileSync(path.join(ROUTE_DIR, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (RAW_PARENT_SCOPE.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    'Scoping ueber einen Eltern-Alias gehoert in writableChild()/writableClause(), sonst faellt die Betreuung (#584) still weg');
});

// Gegenprobe zur Regel selbst: ohne sie waere der Guard gruen, weil das Muster
// nie zutrifft - nicht, weil die Routen sauber sind.
test('der Scope-Guard erkennt das Muster, das er verbietet', () => {
  assert.ok(RAW_PARENT_SCOPE.test('WHERE s.id = ? AND m.user_id = ?'), 'Verstoss wird nicht erkannt');
  assert.ok(!RAW_PARENT_SCOPE.test("SELECT * FROM cycle_settings WHERE user_id = ?"), 'eigene Spalte faelschlich beanstandet');
});
