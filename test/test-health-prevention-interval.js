/**
 * Modul: Vorsorge - Intervall-Eingabe (public/utils/health-prevention.js)
 * Zweck: Monate<->Jahre-Umrechnung fuer die beiden Formulare (Typ-Register,
 *        Datensatz-Override) - gespeichert wird immer in Monaten.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-health-prevention-interval.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { intervalMonthsToInput, intervalInputToMonths } = await import('../public/utils/health-prevention.js');

test('ein glattes Vielfaches von 12 zeigt sich als Jahre', () => {
  assert.deepEqual(intervalMonthsToInput(120), { value: 10, unit: 'years' });
  assert.deepEqual(intervalMonthsToInput(12), { value: 1, unit: 'years' });
});

test('ein krummer Wert bleibt in Monaten', () => {
  assert.deepEqual(intervalMonthsToInput(18), { value: 18, unit: 'months' });
  assert.deepEqual(intervalMonthsToInput(1), { value: 1, unit: 'months' });
});

test('leer/null bleibt leer, in Monaten (kein Intervall)', () => {
  assert.deepEqual(intervalMonthsToInput(null), { value: '', unit: 'months' });
  assert.deepEqual(intervalMonthsToInput(''), { value: '', unit: 'months' });
});

test('die Umrechnung ist eine echte Umkehrung fuer glatte Jahre', () => {
  for (const months of [12, 24, 60, 120, 600]) {
    const input = intervalMonthsToInput(months);
    assert.equal(intervalInputToMonths(input.value, input.unit), months);
  }
});

test('intervalInputToMonths rechnet Jahre in Monate um', () => {
  assert.equal(intervalInputToMonths(10, 'years'), 120);
  assert.equal(intervalInputToMonths(1, 'years'), 12);
});

test('intervalInputToMonths laesst Monate unveraendert', () => {
  assert.equal(intervalInputToMonths(18, 'months'), 18);
});

test('intervalInputToMonths: leer ist null, keine Zahl ist NaN', () => {
  assert.equal(intervalInputToMonths('', 'months'), null);
  assert.equal(intervalInputToMonths(null, 'years'), null);
  assert.ok(Number.isNaN(intervalInputToMonths('abc', 'months')));
});
