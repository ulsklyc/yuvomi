import test from 'node:test';
import assert from 'node:assert/strict';
import { fastingDateKey, parseFastingDateRange } from '../server/services/fasting-dates.js';

test('date-only range parsing and formatting preserve early four-digit years', () => {
  assert.deepEqual(parseFastingDateRange('0001-01-01', '0099-12-31', assert.fail), {
    from: '0001-01-01',
    to: '0099-12-31',
  });
  assert.equal(fastingDateKey('0001-01-01T00:00:00.000Z'), '0001-01-01');
  assert.equal(fastingDateKey('0000-01-02T00:00:00.000Z'), '0000-01-02');
  assert.equal(fastingDateKey('-000001-01-02T00:00:00.000Z'), '-000001-01-02');
  assert.throws(() => parseFastingDateRange('0099-02-29', null, () => { throw new Error('invalid'); }), /invalid/);
});
