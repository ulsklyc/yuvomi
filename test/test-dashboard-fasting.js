import test from 'node:test';
import assert from 'node:assert/strict';
import { WIDGET_IDS, defaultWidgetSize } from '../public/utils/dashboard-widgets.js';
import { PERMISSION_WIDGETS } from '../server/permissions.js';

test('fasting dashboard widget is registered and sized as a compact timer', () => {
  assert.ok(WIDGET_IDS.includes('fasting'));
  assert.equal(defaultWidgetSize('fasting'), '2x1');
  assert.deepEqual(PERMISSION_WIDGETS.find((item) => item.id === 'fasting'), { id: 'fasting', module: 'health' });
});
