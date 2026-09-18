/**
 * Tests: Reminder-Offset-Roundtrip (public/utils/reminder-offset.js)
 * Fokus: Issue #354 — beim Speichern wird remind_at via toISOString() als UTC
 *        abgelegt; beim Wiederöffnen muss derselbe Versatz herauskommen, auch
 *        in einer Nicht-UTC-Zeitzone. Vorher wurde remind_at als Lokalzeit
 *        gelesen, wodurch sich der Zonen-Offset bei jedem Speichern aufaddierte.
 *
 * Wir setzen TZ vor jedem Date-Gebrauch auf UTC+5 (Asia/Yekaterinburg), genau
 * die Konstellation des Bug-Reports (300 min Drift).
 * Ausführen: node test/test-reminder-offset.js
 */
process.env.TZ = 'Asia/Yekaterinburg'; // UTC+5, fester DST-freier Offset

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseOffsetMsFromReminder, resolveReminderPreset, remindAtFromPreset } = await import('../public/utils/reminder-offset.js');

// Bildet die Speicherlogik aus tasks.js nach: remind_at = (due - offset) als UTC.
function saveReminder(task, offsetMs) {
  const dueDateTime = task.due_time
    ? new Date(`${task.due_date}T${task.due_time}`)
    : new Date(`${task.due_date}T23:59:59`);
  const remindAt = new Date(dueDateTime.getTime() - offsetMs).toISOString().slice(0, 19);
  return { remind_at: remindAt };
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

test('Roundtrip: 1 Stunde bleibt 1 Stunde (kein Zonen-Drift)', () => {
  const task = { due_date: '2026-06-12', due_time: '18:00' };
  const reminder = saveReminder(task, HOUR);
  assert.equal(parseOffsetMsFromReminder(task, reminder), HOUR);
  assert.deepEqual(resolveReminderPreset(task, reminder), { preset: 'offset_1h', amount: '1', unit: 'days' });
});

test('Roundtrip: 60-Minuten-Custom bleibt 60 Minuten', () => {
  const task = { due_date: '2026-06-12', due_time: '09:30' };
  const reminder = saveReminder(task, 60 * MIN);
  // 60 min trifft das 1h-Preset
  assert.equal(parseOffsetMsFromReminder(task, reminder), 60 * MIN);
});

test('Roundtrip: krummer Custom-Wert (90 min) bleibt erhalten', () => {
  const task = { due_date: '2026-06-12', due_time: '12:00' };
  const reminder = saveReminder(task, 90 * MIN);
  assert.equal(parseOffsetMsFromReminder(task, reminder), 90 * MIN);
  assert.deepEqual(resolveReminderPreset(task, reminder), { preset: 'offset_custom', amount: '90', unit: 'minutes' });
});

test('Roundtrip ohne due_time (23:59:59-Fallback): 1 Tag bleibt 1 Tag', () => {
  const task = { due_date: '2026-06-12', due_time: null };
  const reminder = saveReminder(task, 24 * HOUR);
  assert.equal(parseOffsetMsFromReminder(task, reminder), 24 * HOUR);
  assert.deepEqual(resolveReminderPreset(task, reminder), { preset: 'offset_1d', amount: '1', unit: 'days' });
});

test('Mehrfaches Speichern driftet nicht (Kern des Bug-Reports)', () => {
  const task = { due_date: '2026-06-12', due_time: '18:00' };
  let reminder = saveReminder(task, HOUR);
  // Simuliere wiederholtes Öffnen+Speichern ohne Änderung
  for (let i = 0; i < 3; i++) {
    const offset = parseOffsetMsFromReminder(task, reminder);
    reminder = saveReminder(task, offset);
  }
  assert.equal(parseOffsetMsFromReminder(task, reminder), HOUR);
});

test('remind_at mit explizitem Z wird ebenfalls als UTC gelesen', () => {
  const task = { due_date: '2026-06-12', due_time: '18:00' };
  const reminder = saveReminder(task, HOUR);
  const withZ = { remind_at: `${reminder.remind_at}Z` };
  assert.equal(parseOffsetMsFromReminder(task, withZ), HOUR);
});

test('Fehlende Daten ergeben das Default-Preset', () => {
  assert.equal(parseOffsetMsFromReminder(null, null), null);
  assert.deepEqual(resolveReminderPreset({ due_date: '2026-06-12' }, null), { preset: 'offset_15m', amount: '15', unit: 'minutes' });
});

// --------------------------------------------------------------------------
// Ein Versatz, den kein Preset abbildet
//
// `remind_at` ist ein absoluter Zeitpunkt, der Vorlauf wird zurueckgerechnet.
// Wer die Faelligkeit VOR die bestehende Erinnerung zieht, hat keinen Vorlauf
// mehr. Vorher fiel das auf `offset_at_time` zurueck - der Dialog behauptete
// „Zum Startzeitpunkt" fuer eine Erinnerung, die Tage SPAETER feuert.
// --------------------------------------------------------------------------

test('Faelligkeit vor die Erinnerung gezogen: der Zustand heisst nicht „zum Zeitpunkt"', () => {
  const task = { due_date: '2026-09-18', due_time: null };
  const reminder = { remind_at: '2026-09-25T06:00:00Z' };
  assert.ok(parseOffsetMsFromReminder(task, reminder) < 0, 'der Versatz ist negativ');
  assert.deepEqual(resolveReminderPreset(task, reminder), { preset: 'offset_after_due', amount: '1', unit: 'days' });
});

test('Der Zustand gilt auch schon eine Minute nach der Faelligkeit', () => {
  const task = { due_date: '2026-06-12', due_time: '18:00' };
  const reminder = saveReminder(task, -1 * MIN);
  assert.equal(resolveReminderPreset(task, reminder).preset, 'offset_after_due');
});

test('Sekunden RUND UM die Faelligkeit bleiben „zum Zeitpunkt" - in beide Richtungen', () => {
  const task = { due_date: '2026-06-12', due_time: '18:00' };
  assert.equal(resolveReminderPreset(task, saveReminder(task, -20 * 1000)).preset, 'offset_at_time');
  assert.equal(resolveReminderPreset(task, saveReminder(task, 20 * 1000)).preset, 'offset_at_time');
  assert.equal(resolveReminderPreset(task, saveReminder(task, 0)).preset, 'offset_at_time');
});

// --------------------------------------------------------------------------
// Die Gegenrichtung: was ein Preset beim Speichern ergibt
// --------------------------------------------------------------------------

test('Die Presets rechnen wie bisher - Roundtrip ueber beide Richtungen', () => {
  const task = { due_date: '2026-06-12', due_time: '18:00' };
  for (const [preset, offsetMs] of [
    ['offset_at_time', 0], ['offset_15m', 15 * MIN], ['offset_1h', HOUR],
    ['offset_1d', 24 * HOUR], ['offset_2d', 48 * HOUR],
    ['offset_1w', 7 * 24 * HOUR], ['offset_2w', 14 * 24 * HOUR],
  ]) {
    const remindAt = remindAtFromPreset(preset, { dueDate: task.due_date, dueTime: task.due_time });
    assert.equal(remindAt, saveReminder(task, offsetMs).remind_at, preset);
    assert.equal(resolveReminderPreset(task, { remind_at: remindAt }).preset, preset, preset);
  }
});

test('Eine unbekannte Einheit wird nicht geraten, sondern abgelehnt', () => {
  const opts = { dueDate: '2026-06-12', dueTime: '12:00', amount: '90' };
  // Die abgeloeste if-else-Kette liess jede unbekannte Einheit in ihren letzten
  // Zweig fallen und rechnete sie als WOCHEN - der Zufall einer Schreibweise.
  // Aus dem Auswahlfeld kommen nur die vier bekannten Werte; kaeme je ein
  // fuenfter, ist eine Fehlermeldung ehrlicher als ein stiller Zeitpunkt.
  assert.equal(remindAtFromPreset('offset_custom', { ...opts, unit: 'fortnights' }), null);
  assert.equal(remindAtFromPreset('offset_custom', { ...opts, unit: '' }), null);
  for (const unit of ['minutes', 'hours', 'days', 'weeks']) {
    assert.ok(remindAtFromPreset('offset_custom', { ...opts, unit }), unit);
  }
});

test('Custom rechnet die Einheit um, ohne Faelligkeit ergibt nichts', () => {
  const opts = { dueDate: '2026-06-12', dueTime: '12:00' };
  assert.equal(remindAtFromPreset('offset_custom', { ...opts, amount: '90', unit: 'minutes' }),
    saveReminder({ due_date: '2026-06-12', due_time: '12:00' }, 90 * MIN).remind_at);
  assert.equal(remindAtFromPreset('offset_custom', { ...opts, amount: '0', unit: 'minutes' }), null);
  assert.equal(remindAtFromPreset('offset_15m', { dueDate: '', dueTime: null }), null);
  assert.equal(remindAtFromPreset('offset_none', opts), null);
});

test('„Nach der Faelligkeit" RECHNET NICHT, sondern behaelt den Zeitpunkt', () => {
  const task = { due_date: '2026-09-18', due_time: null };
  const stored = '2026-09-25T06:00:00';
  // Das Speichern darf die Erinnerung nicht anfassen - weder auf die
  // Faelligkeit noch irgendwohin sonst.
  assert.equal(remindAtFromPreset('offset_after_due', { dueDate: task.due_date, storedRemindAt: stored }), stored);
  // Auch mit Zonen-Suffix bleibt derselbe ZEITPUNKT stehen, naiv-UTC notiert.
  assert.equal(remindAtFromPreset('offset_after_due', { dueDate: task.due_date, storedRemindAt: `${stored}Z` }), stored);
  // Ohne gespeicherten Zeitpunkt gibt es nichts zu behalten.
  assert.equal(remindAtFromPreset('offset_after_due', { dueDate: task.due_date, storedRemindAt: null }), null);
});

test('Oeffnen und Speichern ohne Anfassen laesst die Erinnerung stehen (der Kern des Befunds)', () => {
  const task = { due_date: '2026-09-18', due_time: null };
  let reminder = { remind_at: '2026-09-25T06:00:00' };
  // Drei Runden: aufloesen, mit genau dem aufgeloesten Preset speichern.
  for (let i = 0; i < 3; i++) {
    const { preset, amount, unit } = resolveReminderPreset(task, reminder);
    const remindAt = remindAtFromPreset(preset, {
      dueDate: task.due_date, dueTime: task.due_time, amount, unit,
      storedRemindAt: reminder.remind_at,
    });
    reminder = { remind_at: remindAt };
  }
  assert.equal(reminder.remind_at, '2026-09-25T06:00:00', 'der Zeitpunkt wandert nicht');
});
