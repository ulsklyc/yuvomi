/**
 * Regression: Split-Guest-Redirect-Schleife (#480)
 *
 * Ein Nutzer mit access_scope 'split_guest' UND einer Familienrolle ohne
 * Budget-Recht geriet in eine Endlosschleife:
 *   '/'      → split_guest-Weiche schickt auf '/budget'
 *   '/budget'→ Modul-Guard (kein Budget-Recht) schickt zurück auf '/'
 * … bis „Maximum call stack size exceeded".
 *
 * Fix: Die split_guest→/budget-Weiche greift nur noch, wenn Budget auch
 * tatsächlich zugänglich ist (canAccessNavModule('budget')). Ohne Budget-Recht
 * fällt der Nutzer durch und landet auf einer erlaubten Seite.
 *
 * router.js ist browser-gekoppelt und nicht direkt importierbar; daher prüft
 * dieser Test die Weiche statisch am Quelltext und das zugrunde liegende
 * Rechte-Verhalten am echten public/permissions.js-Store.
 *
 * Ausführen: node --test test/test-router-guest-guard.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  setPermissions,
  clearPermissions,
  canAccessNavModule,
} from '../public/permissions.js';

const routerSrc = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');

test('jede split_guest→/budget-Weiche prüft canAccessNavModule("budget")', () => {
  // Alle Vorkommen der Weiche einsammeln und sicherstellen, dass die
  // Rechteprüfung Teil der Bedingung ist (Schutz gegen Reintroduktion).
  const guardRe = /access_scope === 'split_guest'[\s\S]{0,200}?navigate\('\/budget'\)/g;
  const matches = routerSrc.match(guardRe) ?? [];
  assert.ok(matches.length >= 2, `erwartet ≥2 split_guest→/budget-Weichen, gefunden ${matches.length}`);
  for (const block of matches) {
    assert.match(
      block,
      /canAccessNavModule\('budget'\)/,
      'split_guest→/budget-Weiche ohne Budget-Rechteprüfung → Schleifengefahr (#480)',
    );
  }
});

test('Budget-gesperrter Gast: Weiche feuert nicht (canAccessNavModule false)', () => {
  // Familienrolle setzt Budget auf 'none' → Gast darf NICHT nach /budget.
  setPermissions({ admin: false, modules: { budget: 'none' }, widgets: {} });
  assert.equal(canAccessNavModule('budget'), false);
  clearPermissions();
});

test('regulärer Gast ohne Einschränkung: Weiche feuert weiterhin', () => {
  // Reiner split_guest ohne Rechte-Overrides → Vollzugriff (fail-open).
  setPermissions({ admin: false, modules: {}, widgets: {} });
  assert.equal(canAccessNavModule('budget'), true);
  clearPermissions();
});
