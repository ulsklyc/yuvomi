/**
 * Tests: UX Utilities (stagger, vibrate)
 * Läuft im Node-Kontext - kein DOM verfügbar, daher nur Pure-Logic-Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

// Minimales Window/Navigator-Mock für Node
const { stagger, vibrate, withBusy, scheduleUndoableDelete, wireSwipeToDismiss } = await (async () => {
  global.window = {
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
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

/*
 * DAS EINBLENDEN ENDET AUF DEM STYLESHEET, NICHT AUF EINEM INLINE-WERT.
 *
 * `stagger()` liess `opacity: 1`, `transform: translateY(0)` und die eigene
 * `transition` inline stehen. Das Inline-`opacity: 1` schlug jede Zustandsregel
 * der Zeile selbst: `.shopping-item--checked { opacity: 0.45 }` und
 * `.kanban-card--done { opacity: 0.6 }` griffen nur unter
 * prefers-reduced-motion (dort kehrt stagger frueh zurueck), sonst nie - zwei
 * Aussehen fuer denselben Zustand (Kontrastmessung nach dem HIG-Redesign,
 * #1230). Dasselbe Inline-Opacity hielt die Drag-Geister
 * (`.sortable-ghost { opacity: 0.4 }`) deckend.
 */
test('stagger: hinterlaesst nach dem Einblenden kein Inline-opacity, -transform oder -transition', async () => {
  const els = [{ style: {} }, { style: {} }, { style: {} }];
  stagger(els, { delay: 0, duration: 0 });
  await new Promise((r) => setTimeout(r, 40));
  els.forEach((el, i) => {
    assert.equal(el.style.opacity || '', '', `Element ${i}: Inline-opacity "${el.style.opacity}" ueberdeckt die Zustandsregeln der Zeile`);
    assert.equal(el.style.transform || '', '', `Element ${i}: Inline-transform "${el.style.transform}" bleibt stehen`);
    assert.equal(el.style.transition || '', '', `Element ${i}: Inline-transition "${el.style.transition}" ueberdeckt die Transitions des Stylesheets`);
  });
});

test('stagger: raeumt nur die eigenen Werte ab, nicht was inzwischen jemand anderes gesetzt hat', async () => {
  const el = { style: {} };
  stagger([el], { delay: 5, duration: 0 });
  // Eine Wischgeste setzt waehrend des Einblendens ihr eigenes transform.
  el.style.transform = 'translateX(-40px)';
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(el.style.transform, 'translateX(-40px)', 'stagger hat ein fremdes Inline-transform ueberschrieben');
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

// Löschen mit Undo läuft ausschließlich über scheduleUndoableDelete: der
// Server-Delete wird bis zum Ablauf des Undo-Fensters zurückgehalten und bei
// pagehide per keepalive nachgereicht. Die frühere deleteWithUndo-API löschte
// sofort und überließ das Zurückholen dem Aufrufer — in Birthdays stellte das
// Undo nur den lokalen State wieder her, der Eintrag war serverseitig weg.
// Die Invariante, an der der alte Birthdays-Pfad scheiterte: dort lief der
// Server-Delete sofort und „Rückgängig" stellte nur den lokalen State her —
// der Eintrag kam sichtbar zurück und war beim nächsten Reload trotzdem weg.
test('scheduleUndoableDelete: Undo verhindert den Server-Delete', async () => {
  let committed = false;
  let restored = false;
  let capturedUndo = null;
  global.window.yuvomi = { showToast: (_msg, _type, _duration, undoFn) => { capturedUndo = undoFn; } };

  scheduleUndoableDelete({
    message: 'Gelöscht',
    duration: 40,
    commit: async () => { committed = true; },
    restore: () => { restored = true; },
  });

  assert.ok(capturedUndo, 'der Undo-Toast muss eine Rückgängig-Aktion tragen');
  capturedUndo();
  await new Promise((resolve) => setTimeout(resolve, 90));

  assert.equal(committed, false, 'nach Undo darf kein DELETE an den Server gehen');
  assert.equal(restored, true, 'die UI muss zurückgesetzt werden');
});

test('scheduleUndoableDelete: ohne Undo läuft der Delete nach dem Fenster', async () => {
  let committed = false;
  let keepaliveFlag = null;
  global.window.yuvomi = { showToast: () => {} };

  scheduleUndoableDelete({
    message: 'Gelöscht',
    duration: 20,
    commit: async ({ keepalive }) => { committed = true; keepaliveFlag = keepalive; },
  });

  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(committed, true, 'ohne Undo muss der Delete nach Ablauf des Fensters laufen');
  assert.equal(keepaliveFlag, false, 'der reguläre Commit läuft ohne keepalive');
});

test('scheduleUndoableDelete: pagehide-Fehler kann den optimistischen Zustand einmalig zurücksetzen', { timeout: 5000 }, async () => {
  const previousWindow = global.window;
  const listeners = new Map();
  let capturedUndo = null;
  global.window = {
    matchMedia: () => ({ matches: false }),
    addEventListener: (type, handler) => { listeners.set(type, handler); },
    yuvomi: {
      showToast: (_message, _type, _duration, undo) => { capturedUndo = undo; },
    },
  };

  try {
    const moduleUrl = new URL('../public/utils/ux.js', import.meta.url);
    moduleUrl.searchParams.set('pagehide-folder-test', String(Date.now()));
    const { scheduleUndoableDelete: freshSchedule } = await import(moduleUrl);
    const failure = new Error('keepalive failed');
    let restoreCount = 0;
    let restoredError = null;
    let resolveRestored;
    const restored = new Promise((resolve) => { resolveRestored = resolve; });

    freshSchedule({
      message: 'Gelöscht',
      duration: 10_000,
      restoreOnKeepaliveError: true,
      commit: async ({ keepalive }) => {
        assert.equal(keepalive, true);
        throw failure;
      },
      restore: (err) => {
        restoreCount += 1;
        restoredError = err;
        resolveRestored();
      },
    });

    assert.ok(listeners.get('pagehide'), 'der pagehide-Flush muss registriert sein');
    listeners.get('pagehide')();
    await restored;
    capturedUndo?.();

    assert.equal(restoreCount, 1, 'pagehide und ein späterer Undo-Klick dürfen nicht doppelt restoren');
    assert.equal(restoredError, failure);
  } finally {
    global.window = previousWindow;
  }
});

test('scheduleUndoableDelete: regulärer Commit-Fehler wird einmalig zurückgesetzt und gemeldet', { timeout: 5000 }, async () => {
  const previousWindow = global.window;
  const listeners = new Map();
  let capturedUndo = null;
  global.window = {
    matchMedia: () => ({ matches: false }),
    addEventListener: (type, handler) => { listeners.set(type, handler); },
    yuvomi: {
      showToast: (_message, _type, _duration, undo) => { capturedUndo = undo; },
    },
  };

  try {
    const moduleUrl = new URL('../public/utils/ux.js', import.meta.url);
    moduleUrl.searchParams.set('timeout-failure-test', String(Date.now()));
    const { scheduleUndoableDelete: freshSchedule } = await import(moduleUrl);
    const failure = new Error('regular commit failed');
    let restoreCount = 0;
    let restoredError = null;
    let resolveRestored;
    const restored = new Promise((resolve) => { resolveRestored = resolve; });

    freshSchedule({
      message: 'Gelöscht',
      duration: 5,
      commit: async ({ keepalive }) => {
        assert.equal(keepalive, false);
        throw failure;
      },
      restore: (err) => {
        restoreCount += 1;
        restoredError = err;
        resolveRestored();
      },
    });

    await restored;
    capturedUndo?.();
    listeners.get('pagehide')?.();
    await Promise.resolve();

    assert.equal(restoreCount, 1, 'Timeout, Undo und pagehide dürfen nicht doppelt restoren');
    assert.equal(restoredError, failure, 'der Aufrufer braucht denselben Fehler für den globalen Toast');
  } finally {
    global.window = previousWindow;
  }
});

test('scheduleUndoableDelete ist das einzige Undo-Löschmuster', () => {
  const ux = readFileSync(new URL('../public/utils/ux.js', import.meta.url), 'utf8');
  assert.ok(
    ux.includes('export function scheduleUndoableDelete'),
    'scheduleUndoableDelete muss die kanonische Undo-Lösch-API bleiben',
  );
  assert.ok(
    !ux.includes('deleteWithUndo'),
    'deleteWithUndo löscht sofort und ist ersatzlos entfernt — nicht wieder einführen',
  );

  // Aufruf oder Import — erklärende Kommentare dürfen den alten Namen nennen.
  const usage = /deleteWithUndo\s*\(|import\s*\{[^}]*\bdeleteWithUndo\b/;
  const pages = globSync('public/{pages,settings/pages,components,utils}/**/*.js');
  const offenders = pages.filter((file) => usage.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, [], 'deleteWithUndo darf nirgends mehr verwendet werden');
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

// --------------------------------------------------------
// Wischen zum Verwerfen (#821)
// --------------------------------------------------------

/* WARUM DIESE GESTE EINEN TEST BRAUCHT UND NICHT NUR EINEN BLICK:
 * Sie war app-weit kaputt, sah dabei aber heil aus. Der Toast trug seinen
 * „Rückgängig"-Knopf, der Knopf trug seinen Handler - nur erreichte ihn kein
 * Mausklick mehr, weil der Zeiger schon beim `pointerdown` eingefangen wurde
 * und der `click` damit ans einfangende Element ging. Per Tastatur und per
 * Touch löste derselbe Knopf weiterhin aus, also blieb der Bruch unter jeder
 * flüchtigen Prüfung. Gemessen an echtem Chrome, hier festgehalten. */

function swipeStub() {
  const handlers = {};
  const el = {
    style: {},
    captured: [],
    addEventListener: (name, fn) => { (handlers[name] ??= []).push(fn); },
    setPointerCapture: (id) => { el.captured.push(id); },
  };
  const fire = (name, props = {}) => {
    for (const fn of handlers[name] ?? []) fn({ button: 0, pointerId: 1, clientX: 0, ...props });
  };
  return { el, fire };
}

test('wireSwipeToDismiss: blosses Drüberfahren verschiebt nichts', () => {
  const { el, fire } = swipeStub();
  wireSwipeToDismiss(el, { onDismiss: () => {} });

  // Maus fährt über den Toast, ohne gedrückt zu sein: die Falle war, dass der
  // Startpunkt noch auf 0 stand und der Toast damit um die halbe Fensterbreite
  // wegrutschte - unsichtbar (opacity 0), bevor der Zeiger seinen Knopf erreichte.
  fire('pointermove', { clientX: 787 });

  assert.equal(el.style.transform, undefined, 'ohne gedrückte Taste darf sich nichts verschieben');
  assert.equal(el.style.opacity, undefined, 'ohne gedrückte Taste darf nichts ausgeblendet werden');
});

test('wireSwipeToDismiss: ein Klick fängt den Zeiger nicht ein', () => {
  const { el, fire } = swipeStub();
  let dismissed = false;
  wireSwipeToDismiss(el, { onDismiss: () => { dismissed = true; } });

  fire('pointerdown', { clientX: 100 });
  fire('pointermove', { clientX: 104 }); // innerhalb der Klick-Toleranz
  fire('pointerup', { clientX: 104 });

  assert.deepEqual(el.captured, [], 'unterhalb der Wisch-Schwelle darf kein Pointer-Capture gesetzt werden');
  assert.equal(dismissed, false, 'ein Klick verwirft nicht');
});

test('wireSwipeToDismiss: aus dem Druck wird eine Wischgeste', () => {
  const { el, fire } = swipeStub();
  let dismissed = false;
  wireSwipeToDismiss(el, { onDismiss: () => { dismissed = true; } });

  fire('pointerdown', { clientX: 100 });
  fire('pointermove', { clientX: 130 });
  assert.deepEqual(el.captured, [1], 'jenseits der Toleranz wird der Zeiger genau einmal eingefangen');
  assert.equal(el.style.transform, 'translateX(30px)');

  fire('pointermove', { clientX: 160 });
  assert.deepEqual(el.captured, [1], 'ein zweites Capture wäre überflüssig');

  fire('pointerup', { clientX: 160 });
  assert.equal(dismissed, true, 'jenseits der Schwelle wird verworfen');
  assert.equal(el.style.transform, '', 'der Versatz wird zurückgenommen');
  assert.equal(el.style.opacity, '');
});

test('wireSwipeToDismiss: ein zu kurzer Wisch federt zurück', () => {
  const { el, fire } = swipeStub();
  let dismissed = false;
  wireSwipeToDismiss(el, { onDismiss: () => { dismissed = true; } });

  fire('pointerdown', { clientX: 100 });
  fire('pointermove', { clientX: 125 }); // über die Toleranz, unter der Schwelle
  fire('pointerup', { clientX: 125 });

  assert.equal(dismissed, false, 'unter der Schwelle bleibt der Toast stehen');
  assert.equal(el.style.transform, '', 'der Versatz wird zurückgenommen');
});

test('wireSwipeToDismiss: ein abgebrochener Zeiger lässt nichts verschoben zurück', () => {
  const { el, fire } = swipeStub();
  wireSwipeToDismiss(el, { onDismiss: () => {} });

  // Übernimmt der Browser die Geste als Bildlauf, kommt `pointercancel` statt
  // `pointerup` - ohne diesen Pfad bliebe der Toast halbtransparent hängen.
  fire('pointerdown', { clientX: 100 });
  fire('pointermove', { clientX: 140 });
  fire('pointercancel');

  assert.equal(el.style.transform, '', 'nach dem Abbruch steht der Toast wieder gerade');
  assert.equal(el.style.opacity, '');

  fire('pointermove', { clientX: 400 });
  assert.equal(el.style.transform, '', 'der abgebrochene Druck zählt nicht weiter');
});

test('wireSwipeToDismiss: die Sekundärtaste startet keine Geste', () => {
  const { el, fire } = swipeStub();
  wireSwipeToDismiss(el, { onDismiss: () => {} });

  fire('pointerdown', { clientX: 100, button: 2 });
  fire('pointermove', { clientX: 200 });

  assert.equal(el.style.transform, undefined, 'ein Rechtsklick ist keine Wischgeste');
});

test('der Toast überlässt die waagerechte Geste dem Script', () => {
  // Gegenstück zum Handler: ohne `touch-action` hält der Browser sich die
  // Deutung offen, übernimmt den waagerechten Wisch als Bildlauf und beendet
  // den Zeiger mit `pointercancel` - auf dem Telefon war der Wisch damit nie
  // auslösbar (gemessen in Chrome mit Touch-Emulation).
  const css = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const toastRule = [...eachRule(css)].find(
    (r) => r.selector === '.toast' && r.at.length === 0,
  );
  assert.ok(toastRule, '.toast muss eine Basisregel in layout.css haben');
  assert.match(
    toastRule.body,
    /touch-action:\s*pan-y/,
    '.toast braucht touch-action: pan-y, sonst frisst der Bildlauf die Wischgeste',
  );
});

test('showToast verdrahtet die Geste über den geteilten Helfer', () => {
  // Der Inline-Zwilling im Router war die Fassung mit den zwei Fallen. Bleibt
  // er weg, kann er sie nicht ein zweites Mal einsammeln.
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  assert.ok(
    router.includes('wireSwipeToDismiss(toast'),
    'der Toast muss die Geste aus utils/ux.js beziehen',
  );
  assert.ok(
    !router.includes('setPointerCapture'),
    'die Shell darf keinen eigenen Wisch-Zwilling mit Pointer-Capture halten',
  );
});
