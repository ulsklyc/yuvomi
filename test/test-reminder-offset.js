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

const { parseOffsetMsFromReminder, resolveReminderPreset } = await import('../public/utils/reminder-offset.js');

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
