/**
 * Tests: UX Utilities (stagger, vibrate)
 * Läuft im Node-Kontext - kein DOM verfügbar, daher nur Pure-Logic-Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Minimales Window/Navigator-Mock für Node
const { stagger, vibrate, deleteWithUndo } = await (async () => {
  global.window = {
    matchMedia: () => ({ matches: false }),
    oikos: { showToast: () => {} },
  };
  global.t = (k) => k;
  Object.defineProperty(global, 'navigator', {
    value: { vibrate: null },
    writable: true,
    configurable: true,
  });
  return import('./public/utils/ux.js');
})();

const dateStore = new Map();
global.localStorage = {
  getItem: (key) => dateStore.get(key) ?? null,
  setItem: (key, value) => dateStore.set(key, String(value)),
  removeItem: (key) => dateStore.delete(key),
};

const { parseDateInput, isDateInputValid } = await import('./public/i18n.js');

test('stagger: setzt opacity:0 auf alle Elemente', () => {
  const els = [{ style: {} }, { style: {} }, { style: {} }];
  stagger(els, { delay: 0, duration: 0 });
  assert.equal(els[0].style.opacity, '0');
  assert.equal(els[1].style.opacity, '0');
  assert.equal(els[2].style.opacity, '0');
});

test('date inputs: accept slash, dot, and hyphen separators for DMY dates', () => {
  localStorage.setItem('oikos-date-format', 'dmy');
  assert.equal(parseDateInput('26/05/2026'), '2026-05-26');
  assert.equal(parseDateInput('26.05.2026'), '2026-05-26');
  assert.equal(parseDateInput('26-05-2026'), '2026-05-26');
  assert.equal(isDateInputValid('26-05-2026'), true);
});

test('date inputs: accept hyphen separators for YMD dates', () => {
  localStorage.setItem('oikos-date-format', 'ymd');
  assert.equal(parseDateInput('2026-5-6'), '2026-05-06');
  assert.equal(parseDateInput('2026/05/06'), '2026-05-06');
  assert.equal(parseDateInput('2026.05.06'), '2026-05-06');
});

test('task create date fields use a keyboard that allows separators', () => {
  const tasksSource = readFileSync(new URL('./public/pages/tasks.js', import.meta.url), 'utf8');
  const rruleSource = readFileSync(new URL('./public/rrule-ui.js', import.meta.url), 'utf8');
  assert.match(tasksSource, /name="start_date"[\s\S]*?inputmode="text"/);
  assert.match(tasksSource, /name="due_date"[\s\S]*?inputmode="text"/);
  assert.match(rruleSource, /id="\$\{prefix\}-rrule-until"[\s\S]*?inputmode="text"/);
});

test('stagger: tut nichts bei prefers-reduced-motion', () => {
  global.window.matchMedia = () => ({ matches: true });
  const els = [{ style: {} }];
  stagger(els);
  assert.equal(els[0].style.opacity, undefined); // unverändert
  global.window.matchMedia = () => ({ matches: false }); // reset
});

test('vibrate: tut nichts wenn API nicht vorhanden', () => {
  Object.defineProperty(global, 'navigator', { value: { vibrate: null }, writable: true, configurable: true });
  assert.doesNotThrow(() => vibrate(10));
});

test('vibrate: ruft navigator.vibrate auf wenn vorhanden', () => {
  let called = null;
  Object.defineProperty(global, 'navigator', { value: { vibrate: (p) => { called = p; } }, writable: true, configurable: true });
  vibrate(15);
  assert.equal(called, 15);
});

test('deleteWithUndo: ruft onDelete auf', async () => {
  let deleteCalled = false;
  global.window.oikos = { showToast: () => {} };
  await deleteWithUndo({
    onDelete: async () => { deleteCalled = true; },
    toastMessage: 'Gelöscht',
  });
  assert.equal(deleteCalled, true);
});

test('deleteWithUndo: übergibt onUndo an showToast', async () => {
  let undoCalled = false;
  let capturedUndo = null;
  global.window.oikos = {
    showToast: (_msg, _type, _duration, undoFn) => { capturedUndo = undoFn; },
  };
  await deleteWithUndo({
    onDelete: async () => {},
    onUndo: async () => { undoCalled = true; },
    toastMessage: 'Gelöscht',
  });
  assert.ok(capturedUndo, 'showToast muss eine Undo-Funktion erhalten haben');
  await capturedUndo();
  assert.equal(undoCalled, true);
});
