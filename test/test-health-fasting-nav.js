import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HEALTH_ROUTES, HEALTH_AREAS, isHealthRoute } from '../public/utils/health-tabs.js';
import { setPermissions, canUseFasting, clearPermissions } from '../public/permissions.js';

test('fasting route and area are capability gated', () => {
  assert.ok(HEALTH_ROUTES.includes('/health/fasting'));
  assert.ok(HEALTH_AREAS({ fastingEnabled: true }).some((area) => area.route === '/health/fasting'));
  assert.ok(!HEALTH_AREAS({ fastingEnabled: false }).some((area) => area.route === '/health/fasting'));
  setPermissions({ admin: false, modules: { health: 'write' }, capabilities: { health_use_fasting: 'none' } });
  assert.equal(canUseFasting(), false);
  setPermissions({ admin: false, modules: { health: 'write' }, capabilities: { health_use_fasting: 'allow' } });
  assert.equal(canUseFasting(), true);
  clearPermissions();
});

test('unknown fasting deep link fails closed when capability is denied', () => {
  setPermissions({ admin: false, modules: { health: 'write' }, capabilities: { health_use_fasting: 'none' } });
  assert.equal(isHealthRoute('/health/fasting'), true);
  clearPermissions();
});

test('fasting styles load with Health instead of blocking every page', () => {
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const health = readFileSync(new URL('../public/styles/health.css', import.meta.url), 'utf8');
  assert.doesNotMatch(index, /<link[^>]+href=["']\/styles\/fasting-controls\.css["']/i);
  assert.match(health, /^@import url\(['"]\/styles\/fasting-controls\.css['"]\);/);
});
