import test from 'node:test';
import assert from 'node:assert/strict';
import { fastingNotificationAvailability } from '../public/utils/health-fasting.js';

test('notification availability respects no goal and the 24-hour boundary', () => {
  assert.deepEqual(fastingNotificationAvailability(null), { goal: false, next: false });
  assert.deepEqual(fastingNotificationAvailability(1380), { goal: true, next: true });
  assert.deepEqual(fastingNotificationAvailability(1440), { goal: true, next: false });
  assert.deepEqual(fastingNotificationAvailability(4320), { goal: true, next: false });
});
