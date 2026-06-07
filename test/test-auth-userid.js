/**
 * Auth-User-ID regression guard (Issue #270).
 *
 * API-Token-Requests haben kein `req.session` — `requireAuth` setzt für beide
 * Auth-Methoden (Session + Token) `req.authUserId`. Route-Handler, die bare
 * `req.session.userId` lesen (z. B. für `created_by`-Inserts), crashen daher mit
 * NOT-NULL-Constraint, sobald ein API-Token genutzt wird. Dieser Test stellt
 * sicher, dass keine Route `req.session.userId` ohne `req.authUserId`-Fallback
 * verwendet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const routesDir = new URL('../server/routes/', import.meta.url);

function routeFiles() {
  return readdirSync(routesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name);
}

test('route handlers never read bare req.session.userId (must use req.authUserId)', () => {
  const offenders = [];

  for (const file of routeFiles()) {
    const source = readFileSync(new URL(file, routesDir), 'utf8');
    source.split('\n').forEach((line, index) => {
      if (!line.includes('req.session.userId')) return;
      // Erlaubt: der Fallback-Ausdruck `req.authUserId || req.session.userId`.
      const sanitized = line.replaceAll('req.authUserId || req.session.userId', '');
      if (sanitized.includes('req.session.userId')) {
        offenders.push(`${file}:${index + 1}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Diese Stellen lesen bare req.session.userId und brechen bei API-Token-Auth:\n${offenders.join('\n')}`,
  );
});
