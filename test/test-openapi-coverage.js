/**
 * Modul: OpenAPI-Vollstaendigkeit
 * Zweck: Jede Route unter /api/v1 steht auch in der Spec.
 *
 * WARUM DAS EIN EIGENER GUARD IST. `/api/v1` ist seit v2.7.1 eine ZUGESAGTE
 * Oberflaeche: die Spec ist das, was ein Integrator liest, und was dort fehlt,
 * existiert fuer ihn nicht. test:openapi-structure sichert bisher nur die
 * FORM der Fragment-Dateien - dass jede importiert und gespreadet ist. Ob die
 * Spec den Code trifft, hat nie jemand geprueft.
 *
 * Gemessen am 2026-08-29, als der erste Anlass auffiel (POST
 * /auth/onboarding-seen kam mit #911 dazu und stand nirgends): 34 von 297
 * Routen fehlten, darunter vier VOLLSTAENDIGE Module - quick-links,
 * screensaver, recipe-providers und permissions. Kein einziger Test hat das je
 * gemeldet, weil keiner in diese Richtung geschaut hat.
 *
 * DER GUARD FOLGT DEN ROUTERN, NICHT EINER DATEILISTE. Vier Module (budget,
 * calendar, health, inventory) verteilen ihre Routen auf Unterdateien, die der
 * gemountete Router seinerseits einbindet. Ein Guard, der nur die in
 * server/index.js genannte Datei liest, waere fuer diese Routen blind - und
 * zwar still: er faende weniger Verstoesse und saehe deshalb gruener aus.
 *
 * Ausfuehren: node --test test/test-openapi-coverage.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sep } from 'node:path';
import { buildOpenApiSpec } from '../server/openapi.js';
// Der Router-Verfolger steht seit #2002 in test/openapi-routes.js, damit
// test:openapi-reasons dieselben Routen liest statt einer zweiten Kopie.
import { allRoutes } from './openapi-routes.js';

const spec = buildOpenApiSpec({});

/**
 * Bewusst nicht dokumentiert - jede Zeile nennt ihren Grund.
 *
 * DERZEIT LEER, und das ist der richtige Zustand: als der Guard entstand, waren
 * alle 40 offenen Routen echte Luecken und keine davon eine bewusste Ausnahme.
 * Die Liste bleibt trotzdem stehen, weil es eine geben KANN - dann aber mit
 * einem Grund an Ort und Stelle. Eine Ausnahme ohne Begruendung ist eine
 * Luecke mit besserer Tarnung.
 */
const INTENTIONALLY_UNDOCUMENTED = new Map([]);

test('jede Route unter /api/v1 steht in der OpenAPI-Spec', () => {
  const routes = allRoutes();

  // Gegen einen Guard, der nur deshalb gruen ist, weil er nichts findet: die
  // Zahl darf schwanken, aber nicht einbrechen.
  assert.ok(routes.length > 250,
    `unerwartet wenige Routen gefunden (${routes.length}) - der Router-Verfolger greift nicht mehr`);

  const missing = routes
    .filter((r) => !spec.paths[r.path]?.[r.verb])
    .map((r) => `${r.verb.toUpperCase()} ${r.path}`)
    .filter((label) => !INTENTIONALLY_UNDOCUMENTED.has(label));

  assert.deepEqual([...new Set(missing)].sort(), [],
    'Diese Routen fehlen in der Spec. /api/v1 ist eine zugesagte Oberflaeche - was dort nicht '
    + 'steht, existiert fuer einen Integrator nicht:\n  ' + [...new Set(missing)].sort().join('\n  '));
});

test('der Router-Verfolger sieht auch die aufgeteilten Module', () => {
  // Ohne diese Probe koennte der Test oben gruen sein, weil er budget/,
  // calendar/, health/ und inventory/ gar nicht erreicht - der teuerste Fall,
  // weil er wie Abdeckung aussieht.
  const routes = allRoutes();
  for (const part of ['routes/calendar/', 'routes/budget/', 'routes/health/', 'routes/inventory/']) {
    assert.ok(routes.some((r) => r.file.split(sep).join('/').includes(part)),
      `keine Route aus ${part} gefunden - der Verfolger geht nicht in die Unterdateien`);
  }
});

test('die Spec beschreibt keine Route, die es nicht gibt', () => {
  // Die Gegenrichtung: eine Zusage ohne Code ist so falsch wie fehlende Doku,
  // nur schwerer zu bemerken - sie faellt erst dem Integrator auf, der sie ruft.
  const real = new Set(allRoutes().map((r) => `${r.verb} ${r.path}`));
  const phantom = [];
  for (const [path, ops] of Object.entries(spec.paths)) {
    if (!path.startsWith('/api/v1/')) continue;
    for (const verb of Object.keys(ops)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(verb)) continue;
      if (!real.has(`${verb} ${path}`)) phantom.push(`${verb.toUpperCase()} ${path}`);
    }
  }
  assert.deepEqual(phantom.sort(), [],
    `Die Spec verspricht Routen, die kein Router bedient:\n  ${phantom.sort().join('\n  ')}`);
});
