/**
 * Test: geteilte Monats-/Jahres-Addition mit Tages-Klemmung (server/utils/interval-date.js)
 * Zweck: die extrahierte Rechnung selbst, plus eine Paritaets-Probe, dass
 *        subscriptions.js#addBillingCycle und inventory-deadlines.js#warrantyEndDate
 *        nach der Extraktion dieselben Ergebnisse liefern wie vorher.
 * Ausführen: node --test test/test-interval-date.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonthsClamped, addYearsClamped, liftToAnchorDay } from '../server/utils/interval-date.js';
import { addBillingCycle } from '../server/services/subscriptions.js';
import { warrantyEndDate } from '../server/services/inventory-deadlines.js';

test('addMonthsClamped addiert Monate exakt', () => {
  assert.equal(addMonthsClamped('2026-01-15', 24), '2028-01-15');
});

test('addMonthsClamped klemmt auf den letzten Tag eines kürzeren Zielmonats', () => {
  assert.equal(addMonthsClamped('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsClamped('2024-01-31', 1), '2024-02-29'); // Schaltjahr
});

test('addMonthsClamped mit 0 Monaten gibt das Datum zurück', () => {
  assert.equal(addMonthsClamped('2026-03-01', 0), '2026-03-01');
});

test('addMonthsClamped wirft bei ungültigem Datum', () => {
  assert.throws(() => addMonthsClamped('not-a-date', 12));
});

test('addYearsClamped addiert Jahre exakt', () => {
  assert.equal(addYearsClamped('2026-03-11', 10), '2036-03-11');
});

test('addYearsClamped klemmt einen Schalttag auf ein Nicht-Schaltjahr', () => {
  assert.equal(addYearsClamped('2024-02-29', 1), '2025-02-28');
});

test('Parität: addBillingCycle(monthly) stimmt mit addMonthsClamped überein', () => {
  assert.equal(addBillingCycle('2026-01-31', 'monthly', 1), addMonthsClamped('2026-01-31', 1));
  assert.equal(addBillingCycle('2026-01-15', 'monthly', 24), addMonthsClamped('2026-01-15', 24));
});

test('Parität: addBillingCycle(yearly) stimmt mit addYearsClamped überein', () => {
  assert.equal(addBillingCycle('2024-02-29', 'yearly', 1), addYearsClamped('2024-02-29', 1));
});

test('Parität: warrantyEndDate stimmt mit addMonthsClamped überein', () => {
  assert.equal(warrantyEndDate('2026-01-31', 1), addMonthsClamped('2026-01-31', 1));
});

// liftToAnchorDay (#1721): das Gegenstueck zum Klemmen. Der Monat bleibt,
// gesenkt wird nie, und ohne brauchbaren Anker bleibt das Datum, wie es ist.
test('liftToAnchorDay hebt auf den Anker, wo der Monat ihn hat, sonst auf den Monatsletzten', () => {
  assert.equal(liftToAnchorDay('2026-03-28', 31), '2026-03-31');
  assert.equal(liftToAnchorDay('2026-04-28', 31), '2026-04-30');
  assert.equal(liftToAnchorDay('2026-02-28', 31), '2026-02-28');
  assert.equal(liftToAnchorDay('2028-02-28', 29), '2028-02-29');
  assert.equal(liftToAnchorDay(addMonthsClamped(addMonthsClamped('2026-01-31', 1), 1), 31), '2026-03-31');
});

test('liftToAnchorDay senkt nie und laesst ohne Anker alles stehen', () => {
  assert.equal(liftToAnchorDay('2026-03-20', 15), '2026-03-20');
  assert.equal(liftToAnchorDay('2026-03-15', 15), '2026-03-15');
  for (const anker of [null, undefined, 0, 32, 1.5, '31', NaN]) {
    assert.equal(liftToAnchorDay('2026-03-28', anker), '2026-03-28', String(anker));
  }
  assert.throws(() => liftToAnchorDay('2026-02-31', 31));
});
