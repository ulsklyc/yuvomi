/**
 * Test: Inventar-Fristen-Validierung (reine Funktionen, kein DB-Zugriff)
 * Zweck: validateTrackedDatesInput ist der Torwaechter vor jedem Schreiben -
 *        Feld-Validierung, Obergrenze, Default-Vorlauf.
 * Ausführen: node --test test/test-item-dates-validation.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTrackedDatesInput, MAX_TRACKED_DATES_PER_ITEM } from '../server/routes/inventory/item-dates.js';

test('MAX_TRACKED_DATES_PER_ITEM ist 10', () => {
  assert.equal(MAX_TRACKED_DATES_PER_ITEM, 10);
});

test('leeres/fehlendes Array ist gültig (keine Fristen)', () => {
  assert.deepEqual(validateTrackedDatesInput(undefined), { values: [], errors: [] });
  assert.deepEqual(validateTrackedDatesInput([]), { values: [], errors: [] });
});

test('gültige Zeile mit explizitem Vorlauf', () => {
  const result = validateTrackedDatesInput([{ label: 'TÜV', date: '2027-06-01', reminder_offset_days: 60 }]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.values, [{
    label: 'TÜV', date: '2027-06-01', reminder_offset_days: 60,
    interval_months: null, interval_distance: null,
  }]);
});

test('interval_months/interval_distance bleiben NULL, wenn weggelassen (heutiges Einmal-Verhalten)', () => {
  const result = validateTrackedDatesInput([{ label: 'Service', date: '2027-06-01' }]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.values[0].interval_months, null);
  assert.equal(result.values[0].interval_distance, null);
});

test('gültiges interval_months/interval_distance wird übernommen', () => {
  const result = validateTrackedDatesInput([{
    label: 'TÜV', date: '2027-06-01', interval_months: 24, interval_distance: 15000,
  }]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.values[0].interval_months, 24);
  assert.equal(result.values[0].interval_distance, 15000);
});

test('interval_months außerhalb 1-600 ist ein Fehler', () => {
  assert.ok(validateTrackedDatesInput([{ label: 'TÜV', date: '2027-06-01', interval_months: 0 }]).errors.length > 0);
  assert.ok(validateTrackedDatesInput([{ label: 'TÜV', date: '2027-06-01', interval_months: 601 }]).errors.length > 0);
});

test('interval_distance muss eine positive ganze Zahl sein', () => {
  assert.ok(validateTrackedDatesInput([{ label: 'TÜV', date: '2027-06-01', interval_distance: 0 }]).errors.length > 0);
  assert.ok(validateTrackedDatesInput([{ label: 'TÜV', date: '2027-06-01', interval_distance: -5 }]).errors.length > 0);
  assert.ok(validateTrackedDatesInput([{ label: 'TÜV', date: '2027-06-01', interval_distance: 1.5 }]).errors.length > 0);
});

test('fehlender Vorlauf bekommt den Default 30', () => {
  const result = validateTrackedDatesInput([{ label: 'Service', date: '2027-06-01' }]);
  assert.equal(result.values[0].reminder_offset_days, 30);
});

test('expliziter Vorlauf 0 bleibt 0 und wird nicht zum Default umgeschrieben', () => {
  // Regression gegen `Number(x) || 30`: 0 ("am Tag selbst erinnern") ist falsy
  // und wurde im Frontend still zu 30. Der Validator darf denselben Fehler nicht
  // machen - 0 ist ein gueltiger Wert (input min="0", DB-CHECK BETWEEN 0 AND 365).
  const result = validateTrackedDatesInput([{ label: 'TÜV', date: '2027-06-01', reminder_offset_days: 0 }]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.values[0].reminder_offset_days, 0);
});

test('fehlendes Label oder Datum ist ein Fehler', () => {
  assert.ok(validateTrackedDatesInput([{ label: '', date: '2027-06-01' }]).errors.length > 0);
  assert.ok(validateTrackedDatesInput([{ label: 'TÜV', date: '' }]).errors.length > 0);
});

test('unmögliches Kalenderdatum ist ein Fehler', () => {
  assert.ok(validateTrackedDatesInput([{ label: 'TÜV', date: '2027-02-30' }]).errors.length > 0);
});

test('Vorlauf außerhalb 0-365 ist ein Fehler', () => {
  assert.ok(validateTrackedDatesInput([{ label: 'TÜV', date: '2027-06-01', reminder_offset_days: 400 }]).errors.length > 0);
  assert.ok(validateTrackedDatesInput([{ label: 'TÜV', date: '2027-06-01', reminder_offset_days: -1 }]).errors.length > 0);
});

test('mehr als 10 Zeilen ist ein Fehler, ohne einzelne Zeilen zu validieren', () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ label: `Frist ${i}`, date: '2027-06-01' }));
  const result = validateTrackedDatesInput(rows);
  assert.equal(result.values, null);
  assert.equal(result.errors.length, 1);
});
