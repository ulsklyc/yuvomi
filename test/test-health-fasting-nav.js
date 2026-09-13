import test from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH_ROUTES, HEALTH_TABS, isHealthRoute } from '../public/utils/health-tabs.js';
import { setPermissions, canUseFasting, clearPermissions } from '../public/permissions.js';

test('fasting route and tab are capability gated', () => {
  assert.ok(HEALTH_ROUTES.includes('/health/fasting'));
  assert.ok(HEALTH_TABS({ fastingEnabled: true }).some((tab) => tab.route === '/health/fasting'));
  assert.ok(!HEALTH_TABS({ fastingEnabled: false }).some((tab) => tab.route === '/health/fasting'));
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
