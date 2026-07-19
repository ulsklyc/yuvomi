/**
 * Tests: UX Utilities (stagger, vibrate)
 * Läuft im Node-Kontext - kein DOM verfügbar, daher nur Pure-Logic-Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// Minimales Window/Navigator-Mock für Node
const { stagger, vibrate, deleteWithUndo, withBusy } = await (async () => {
  global.window = {
    matchMedia: () => ({ matches: false }),
    yuvomi: { showToast: () => {} },
  };
  global.t = (k) => k;
  Object.defineProperty(global, 'navigator', {
    value: { vibrate: null },
    writable: true,
    configurable: true,
  });
  return import('../public/utils/ux.js');
})();

const dateStore = new Map();
global.localStorage = {
  getItem: (key) => dateStore.get(key) ?? null,
  setItem: (key, value) => dateStore.set(key, String(value)),
  removeItem: (key) => dateStore.delete(key),
};

const { parseDateInput, isDateInputValid, parseTimeInput, formatTimeInput } = await import('../public/i18n.js');

test('stagger: setzt opacity:0 auf alle Elemente', () => {
  const els = [{ style: {} }, { style: {} }, { style: {} }];
  stagger(els, { delay: 0, duration: 0 });
  assert.equal(els[0].style.opacity, '0');
  assert.equal(els[1].style.opacity, '0');
  assert.equal(els[2].style.opacity, '0');
});

test('date inputs: accept slash, dot, and hyphen separators for DMY dates', () => {
  localStorage.setItem('yuvomi-date-format', 'dmy');
  assert.equal(parseDateInput('26/05/2026'), '2026-05-26');
  assert.equal(parseDateInput('26.05.2026'), '2026-05-26');
  assert.equal(parseDateInput('26-05-2026'), '2026-05-26');
  assert.equal(isDateInputValid('26-05-2026'), true);
});

test('date inputs: accept hyphen separators for YMD dates', () => {
  localStorage.setItem('yuvomi-date-format', 'ymd');
  assert.equal(parseDateInput('2026-5-6'), '2026-05-06');
  assert.equal(parseDateInput('2026/05/06'), '2026-05-06');
  assert.equal(parseDateInput('2026.05.06'), '2026-05-06');
});

test('task + recurrence date fields use the shared yuvomi-datepicker', () => {
  const tasksSource = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  const rruleSource = readFileSync(new URL('../public/rrule-ui.js', import.meta.url), 'utf8');
  // Freies Tippen (inkl. Trennzeichen, #442) lebt jetzt im Component; die
  // Formulare binden nur noch das gemeinsame Element ein.
  assert.match(tasksSource, /<yuvomi-datepicker type="date"[\s\S]*?name="start_date"/);
  assert.match(tasksSource, /<yuvomi-datepicker type="date"[\s\S]*?name="due_date"/);
  assert.match(tasksSource, /<yuvomi-datepicker type="time"[\s\S]*?name="due_time"/);
  assert.match(rruleSource, /<yuvomi-datepicker type="date"[\s\S]*?id="\$\{prefix\}-rrule-until"/);
  assert.doesNotMatch(tasksSource, /js-date-input|js-time-input/);
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

// ---------------------------------------------------------------------------
// withBusy - Fokus-Rückgabe nach einer asynchronen Aktion (#534-Audit).
// `disabled` entzieht dem fokussierten Element den Fokus; ohne Rückgabe landet
// die Tastatur nach jedem Toggle wieder am Seitenanfang.
// ---------------------------------------------------------------------------

/** Minimales Control-Mock, das die relevanten DOM-Effekte nachbildet. */
function makeControl({ connected = true } = {}) {
  const classes = new Set();
  const attrs = new Map();
  const control = {
    isConnected: connected,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      has: (c) => classes.has(c),
    },
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    focus: () => { global.document.activeElement = control; },
  };
  // Wie im Browser: disabled = true nimmt dem fokussierten Element den Fokus.
  let disabled = false;
  Object.defineProperty(control, 'disabled', {
    get: () => disabled,
    set: (value) => {
      disabled = value;
      if (value && global.document.activeElement === control) {
        global.document.activeElement = { tag: 'body' };
      }
    },
  });
  return control;
}

test('withBusy: gibt den Fokus nach der Aktion an das Control zurück', async () => {
  global.document = { activeElement: null };
  const control = makeControl();
  global.document.activeElement = control;

  await withBusy(control, async () => {
    assert.equal(control.disabled, true, 'während der Aktion gesperrt');
    assert.equal(control.getAttribute('aria-busy'), 'true', 'aria-busy gesetzt');
    assert.notEqual(global.document.activeElement, control, 'disabled entzieht den Fokus');
  });

  assert.equal(control.disabled, false, 'danach wieder bedienbar');
  assert.equal(control.getAttribute('aria-busy'), null, 'aria-busy entfernt');
  assert.equal(global.document.activeElement, control, 'Fokus zurück auf dem Control');
});

test('withBusy: stiehlt keinen Fokus, wenn das Control ihn vorher nicht hatte', async () => {
  global.document = { activeElement: { tag: 'other' } };
  const control = makeControl();
  await withBusy(control, async () => {});
  assert.notEqual(global.document.activeElement, control);
});

test('withBusy: kein focus() auf abgehängten Controls (Re-Render)', async () => {
  global.document = { activeElement: null };
  const control = makeControl({ connected: false });
  global.document.activeElement = control;
  await withBusy(control, async () => {});
  assert.notEqual(global.document.activeElement, control, 'abgehängtes Control bekommt keinen Fokus');
});

test('withBusy: räumt Lade-Klasse und Sperre auch im Fehlerfall auf', async () => {
  global.document = { activeElement: null };
  const control = makeControl();
  await assert.rejects(
    () => withBusy(control, async () => { throw new Error('boom'); }, { loadingClass: 'btn--loading' }),
    /boom/,
  );
  assert.equal(control.disabled, false);
  assert.equal(control.classList.has('btn--loading'), false);
  assert.equal(control.getAttribute('aria-busy'), null);
});

test('withBusy: reicht den Rückgabewert der Aktion durch', async () => {
  global.document = { activeElement: null };
  const control = makeControl();
  assert.equal(await withBusy(control, async () => 42), 42);
});

test('vibrate: ruft navigator.vibrate auf wenn vorhanden', () => {
  let called = null;
  Object.defineProperty(global, 'navigator', { value: { vibrate: (p) => { called = p; } }, writable: true, configurable: true });
  vibrate(15);
  assert.equal(called, 15);
});

test('readable text color selects a WCAG-safe ink for arbitrary card colors', async () => {
  const utilityUrl = new URL('../public/utils/color.js', import.meta.url);
  assert.equal(existsSync(utilityUrl), true, 'expected a shared color contrast utility');

  const { getReadableTextColor } = await import(utilityUrl);
  assert.equal(getReadableTextColor('#F97316'), 'var(--color-ink-on-bright)');
  assert.equal(getReadableTextColor('#10B981'), 'var(--color-ink-on-bright)');
  assert.equal(getReadableTextColor('#6B7280'), 'var(--color-text-on-accent)');
  assert.equal(getReadableTextColor('#111827'), 'var(--color-text-on-accent)');
  assert.equal(getReadableTextColor('#FFFFFF'), 'var(--color-ink-on-bright)');
});

test('deleteWithUndo: ruft onDelete auf', async () => {
  let deleteCalled = false;
  global.window.yuvomi = { showToast: () => {} };
  await deleteWithUndo({
    onDelete: async () => { deleteCalled = true; },
    toastMessage: 'Gelöscht',
  });
  assert.equal(deleteCalled, true);
});

test('deleteWithUndo: übergibt onUndo an showToast', async () => {
  let undoCalled = false;
  let capturedUndo = null;
  global.window.yuvomi = {
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

test('parseTimeInput: bare hour (24 h) expands to HH:00', () => {
  localStorage.setItem('yuvomi-time-format', '24h');
  assert.equal(parseTimeInput('15'), '15:00');
  assert.equal(parseTimeInput('9'),  '09:00');
  assert.equal(parseTimeInput('0'),  '00:00');
  assert.equal(parseTimeInput('23'), '23:00');
});

test('parseTimeInput: bare hour out-of-range returns empty string', () => {
  localStorage.setItem('yuvomi-time-format', '24h');
  assert.equal(parseTimeInput('24'), '');
  assert.equal(parseTimeInput('99'), '');
});

test('formatTimeInput: bare hour (12 h) formats with AM/PM', () => {
  localStorage.setItem('yuvomi-time-format', '12h');
  assert.equal(formatTimeInput('9'),  '9:00 AM');
  assert.equal(formatTimeInput('15'), '3:00 PM');
  localStorage.setItem('yuvomi-time-format', '24h');
});

test('parseDateInput: 8 raw digits (DMY)', () => {
  localStorage.setItem('yuvomi-date-format', 'dmy');
  assert.equal(parseDateInput('09062026'), '2026-06-09');
  assert.equal(parseDateInput('01012000'), '2000-01-01');
});

test('parseDateInput: 8 raw digits (MDY)', () => {
  localStorage.setItem('yuvomi-date-format', 'mdy');
  assert.equal(parseDateInput('09062026'), '2026-09-06');
});

test('parseDateInput: 8 raw digits (YMD)', () => {
  localStorage.setItem('yuvomi-date-format', 'ymd');
  assert.equal(parseDateInput('20260609'), '2026-06-09');
});

test('parseDateInput: 8 raw digits — invalid date returns empty string', () => {
  localStorage.setItem('yuvomi-date-format', 'dmy');
  assert.equal(parseDateInput('99992026'), '');
  assert.equal(parseDateInput('00000000'), '');
});
