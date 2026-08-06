/**
 * Calendar structure guard.
 *
 * Sichert die modulare Aufteilung von server/routes/calendar.js: der Orchestrator
 * muss dieselbe {Methode, Pfad}-Routentabelle wie vor dem Split ergeben (55
 * Routen), und die Cluster-Router müssen zusammen exakt diese Routen ergeben
 * (keine verlorene/doppelte Route). Zusätzlich wird die extern konsumierte
 * Re-Export-Fläche (__test.googleTarget, genutzt von test:google-multi) gepinnt.
 * Fängt ab, dass ein Cluster-Router still nicht gemountet wird, eine Route beim
 * Umbau verloren geht/umbenannt wird oder der named export wegbricht.
 *
 * Der Verhaltensbeweis liegt in den funktionalen Suiten (test:calendar,
 * test:calendar-routes, test:calendar-search, test:calendar-exceptions,
 * test:calendar-defaults, test:ics-import, test:ics-export, test:google-multi,
 * test:caldav, test:caldav-event-target); dieser Guard pinnt nur die Struktur.
 *
 * Reihenfolge-Vertrag: Die spezifischen Pfade (/google, /apple, /subscriptions,
 * /feed, /holidays, /upcoming, /search, /sync-targets) werden im Orchestrator vor dem CRUD-Router
 * (mit /:id) gemountet, sonst würde /:id sie verschlucken. Dieser Guard prüft
 * zusätzlich, dass GET /:id NACH allen kollisionsgefährdeten GET-Pfaden steht.
 */
// Sub-Router importieren auth.js (requireAdmin), das ohne SESSION_SECRET beim
// Modul-Load wirft; daher Env vor den dynamischen Imports setzen.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { default: calendarRouter, __test } = await import('../server/routes/calendar.js');

const { default: readRouter } = await import('../server/routes/calendar/read.js');
const { default: googleRouter } = await import('../server/routes/calendar/google.js');
const { default: appleRouter } = await import('../server/routes/calendar/apple.js');
const { default: subscriptionsRouter } = await import('../server/routes/calendar/subscriptions.js');
const { default: feedRouter } = await import('../server/routes/calendar/feed.js');
const { default: crudRouter } = await import('../server/routes/calendar/crud.js');
const { default: caldavRouter } = await import('../server/routes/calendar/caldav.js');
const { default: syncTargetsRouter } = await import('../server/routes/calendar/sync-targets.js');
const { default: outlookRouter } = await import('../server/routes/calendar/outlook.js');

/** Sammelt geordnet alle {METHOD path}-Paare eines Express-Routers (inkl. gemounteter Sub-Router). */
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
  // read
  'GET /',
  'GET /upcoming',
  'GET /search',
  // google + external-calendars
  'GET /google/auth',
  'GET /google/callback',
  'POST /google/sync',
  'GET /google/status',
  'GET /google/calendars',
  'PATCH /google/calendars',
  'PATCH /external-calendars',
  'DELETE /google/disconnect',
  'PUT /google/readonly',
  // apple
  'GET /apple/status',
  'POST /apple/sync',
  'POST /apple/connect',
  'DELETE /apple/disconnect',
  // subscriptions + import
  'GET /subscriptions',
  'POST /subscriptions',
  'PATCH /subscriptions/:id',
  'DELETE /subscriptions/:id',
  'POST /subscriptions/:id/sync',
  'POST /import',
  // feed + holidays
  'GET /feed',
  'PUT /feed',
  'POST /feed/regenerate',
  'DELETE /feed',
  'GET /holidays',
  // sync-targets (Auswahlliste des Event-Modals, #618)
  'GET /sync-targets',
  // crud (/:id-Familie)
  'GET /:id',
  'POST /',
  'PUT /:id',
  'POST /:id/reset',
  'POST /:id/exceptions',
  'DELETE /:id',
  // caldav (events + reminders)
  'POST /caldav/accounts',
  'GET /caldav/accounts',
  'PUT /caldav/accounts/:id',
  'DELETE /caldav/accounts/:id',
  'GET /caldav/accounts/:id/calendars',
  'PATCH /caldav/accounts/:id/calendars',
  'POST /caldav/sync',
  'GET /caldav/status',
  'GET /caldav/accounts/:id/reminder-lists',
  'PATCH /caldav/accounts/:id/reminder-lists',
  'POST /caldav/reminders/sync',
  'GET /caldav/reminders/status',
  // outlook (Microsoft Graph, one-way push)
  'GET /outlook/auth',
  'GET /outlook/callback',
  'GET /outlook/accounts',
  'PUT /outlook/accounts/:id',
  'DELETE /outlook/accounts/:id',
  'GET /outlook/accounts/:id/calendars',
  'PATCH /outlook/accounts/:id/calendars',
  'POST /outlook/sync',
  'GET /outlook/status',
];

test('Orchestrator ergibt exakt die erwartete Routentabelle (55 Routen)', () => {
  const actual = collectRoutes(calendarRouter).sort();
  assert.deepEqual(actual, [...EXPECTED].sort());
  assert.equal(actual.length, 55);
});

test('die Cluster-Router zusammen ergeben genau die Orchestrator-Routen (keine verlorene/doppelte Route)', () => {
  const perModule = [
    readRouter, googleRouter, appleRouter, subscriptionsRouter, feedRouter, crudRouter, caldavRouter,
    syncTargetsRouter, outlookRouter,
  ].flatMap(collectRoutes);
  // keine Route kommt in mehr als einem Cluster-Router vor
  const seen = new Set();
  for (const r of perModule) {
    assert.ok(!seen.has(r), `Route ${r} kommt in mehreren Cluster-Routern vor`);
    seen.add(r);
  }
  assert.deepEqual(perModule.sort(), collectRoutes(calendarRouter).sort());
});

test('GET /:id wird nach allen kollisionsgefährdeten GET-Pfaden gemountet', () => {
  const ordered = collectRoutes(calendarRouter);
  const idxCatchAll = ordered.indexOf('GET /:id');
  assert.ok(idxCatchAll >= 0, 'GET /:id fehlt');
  // Jede spezifische GET-Route mit genau einem Pfadsegment (die /:id verschlucken
  // könnte) muss vor GET /:id registriert sein.
  const collisionProne = ['GET /upcoming', 'GET /search', 'GET /holidays', 'GET /sync-targets'];
  for (const route of collisionProne) {
    const idx = ordered.indexOf(route);
    assert.ok(idx >= 0, `${route} fehlt`);
    assert.ok(idx < idxCatchAll, `${route} muss vor GET /:id gemountet sein (Reihenfolge-Vertrag)`);
  }
});

test('Default-Export ist ein montierbarer Router', () => {
  assert.equal(typeof calendarRouter, 'function', 'default export ist kein Router');
});

test('Re-Export-Fläche __test.googleTarget bleibt erhalten (test:google-multi)', () => {
  assert.equal(typeof __test?.googleTarget, 'function', '__test.googleTarget fehlt oder ist keine Funktion');
});
