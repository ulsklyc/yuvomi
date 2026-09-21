/**
 * Test: der Geburtstags-Editor prueft die eigene Anzahl selbst, bevor er
 *       speichert (Nachzug zu #1384)
 *
 * Seit #1384 weist der Server eine Anzahl ausserhalb 1-999 ab. Der Editor
 * schickte sie trotzdem, und der Toast zeigte die ENGLISCHE Servermeldung.
 * Zwei Faelle:
 *   - "Eigene Angabe" ist gewaehlt: eine leere, gebrochene oder zu grosse
 *     Anzahl haelt das Speichern an, mit einem Text aus t().
 *   - Eine Vorgabe ist gewaehlt: Anzahl und Einheit stehen verborgen mit. Hat
 *     jemand vorher eine ungueltige Anzahl getippt und dann doch eine Vorgabe
 *     genommen, gehen beide nicht mit - sie bedeuten nichts, und der Server
 *     wuerde das ganze Speichern an einem Feld scheitern lassen, das niemand sieht.
 *
 * Ausfuehren: npm run test:birthday-localization
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const { reminderToSave } = await import('../public/pages/birthdays.js');

const custom = (amount) => ({
  reminder_offset: 'custom', reminder_custom_amount: amount, reminder_custom_unit: 'days',
});

test('eigene Angabe: 1 bis 999 geht unveraendert durch', () => {
  for (const amount of ['1', '7', '999', '007']) {
    assert.deepEqual(reminderToSave(custom(amount)), { reminder: custom(amount), invalid: false }, amount);
  }
});

test('eigene Angabe: leer, 0, ueber 999, gebrochen oder Exponent haelt das Speichern an', () => {
  for (const amount of ['', '0', '1000', '1.5', '-3', '1e2', ' ']) {
    assert.equal(reminderToSave(custom(amount)).invalid, true, JSON.stringify(amount));
  }
});

test('Vorgabe gewaehlt: eine ungueltige verborgene Anzahl geht samt Einheit nicht mit', () => {
  const reminder = { reminder_offset: '1440', reminder_custom_amount: '0', reminder_custom_unit: 'weeks' };
  assert.deepEqual(reminderToSave(reminder), { reminder: { reminder_offset: '1440' }, invalid: false });
});

test('Vorgabe gewaehlt: eine gueltige verborgene Anzahl bleibt, wie sie ist', () => {
  const reminder = { reminder_offset: '', reminder_custom_amount: '3', reminder_custom_unit: 'hours' };
  assert.deepEqual(reminderToSave(reminder), { reminder, invalid: false });
});

test('der Speichern-Weg des Editors fragt reminderToSave() und meldet ueber t()', () => {
  const source = readFileSync(new URL('../public/pages/birthdays.js', import.meta.url), 'utf8');
  const save = source.slice(source.indexOf("panel.querySelector('#bd-save').addEventListener"));
  assert.match(save, /reminderToSave\(readReminder\(\)\)/, 'der Editor liest die Erinnerung ueber den Pruefer');
  assert.match(save, /t\('birthdays\.reminderAmountInvalid'/, 'der Hinweis kommt aus t(), nicht vom Server');
});

test('birthdays.reminderAmountInvalid steht in jeder Sprache', () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const missing = readdirSync(dir).filter((file) => file.endsWith('.json')).filter((file) => {
    const value = JSON.parse(readFileSync(new URL(file, dir), 'utf8')).birthdays?.reminderAmountInvalid;
    return typeof value !== 'string' || !value.includes('{{max}}');
  });
  assert.deepEqual(missing, []);
});
