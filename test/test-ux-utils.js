/**
 * Tests: UX Utilities (stagger, vibrate)
 * Läuft im Node-Kontext - kein DOM verfügbar, daher nur Pure-Logic-Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

// Minimales Window/Navigator-Mock für Node
const { stagger, vibrate, withBusy, scheduleUndoableDelete, wireSwipeToDismiss, wireCollapsingHeader, collapseOut, expandIn, watchNavCapsuleHeight, wireScrollFade } = await (async () => {
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

/*
 * DAS EINBLENDEN GEHOERT ZUM ERSTEN AUFBAU (Critique 2026-09-26, A3 P1-4).
 *
 * renderTaskList() rief stagger() bei jedem Neuzeichnen - nach dem Abhaken,
 * jedem Filter, jedem Tastendruck -, und die ganze Liste fuhr jedes Mal neu
 * ein. Die Zeilen sind nach dem Neuzeichnen neue Knoten; was bleibt, ist ihr
 * Traeger. Deshalb die Zeilen hier FRISCH je Aufruf, der Traeger derselbe.
 */
function fakeRows(host, n = 3) {
  return Array.from({ length: n }, () => ({ style: {}, parentElement: host }));
}

test('stagger: blendet je Listentraeger nur beim ersten Aufbau ein, nicht bei jedem Neuzeichnen', () => {
  const host = { contains: () => true, parentElement: null };
  const first = fakeRows(host);
  stagger(first, { host, delay: 0, duration: 0 });
  assert.equal(first[0].style.opacity, '0', 'Vorbedingung: der erste Aufbau blendet ein');
  const again = fakeRows(host);
  stagger(again, { host, delay: 0, duration: 0 });
  assert.equal(again[0].style.opacity, undefined,
    'das Neuzeichnen derselben Liste hat wieder eingeblendet - die Liste faehrt nach jedem Abhaken neu ein');
});

test('stagger: ohne host gilt der gemeinsame Vorfahr der Zeilen als Traeger', () => {
  const host = { contains: () => true, parentElement: null };
  stagger(fakeRows(host), { delay: 0, duration: 0 });
  const again = fakeRows(host);
  stagger(again, { delay: 0, duration: 0 });
  assert.equal(again[0].style.opacity, undefined, 'zweiter Aufruf am selben Vorfahr hat wieder eingeblendet');
});

test('stagger: ein Aufruf ohne Zeilen verbraucht den ersten Aufbau nicht (Skelett, Leerzustand)', () => {
  const host = { contains: () => true, parentElement: null };
  stagger([], { host });
  const rows = fakeRows(host);
  stagger(rows, { host, delay: 0, duration: 0 });
  assert.equal(rows[0].style.opacity, '0', 'die erste echte Liste nach einem leeren Aufruf blendet nicht mehr ein');
});

test('stagger: ein neuer Traeger (Seite neu aufgebaut) blendet wieder ein', () => {
  const a = { contains: () => true, parentElement: null };
  const b = { contains: () => true, parentElement: null };
  stagger(fakeRows(a), { host: a, delay: 0, duration: 0 });
  const rows = fakeRows(b);
  stagger(rows, { host: b, delay: 0, duration: 0 });
  assert.equal(rows[0].style.opacity, '0');
});

/*
 * Jeder Aufrufer nennt seinen Traeger. Der Rueckfall (gemeinsamer Vorfahr)
 * trifft bei gruppierten Listen die Gruppe - und die ist nach jedem
 * Neuzeichnen neu, also blendete die Liste wieder bei jedem Aufruf ein.
 */
test('stagger: jeder Aufruf in public/ nennt seinen Listentraeger (host)', () => {
  const offenders = [];
  for (const file of globSync('public/**/*.js', { cwd: new URL('..', import.meta.url).pathname })) {
    if (file.includes('vendor') || file.endsWith('utils/ux.js')) continue;
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/\bstagger\(/g)) {
      // Bis zur schliessenden Klammer des Aufrufs: Klammern zaehlen.
      let depth = 0; let end = m.index + 'stagger'.length;
      for (; end < src.length; end++) {
        if (src[end] === '(') depth++;
        else if (src[end] === ')' && --depth === 0) break;
      }
      const call = src.slice(m.index, end + 1);
      // `stagger()` ohne Argument ist kein Aufruf, sondern die Nennung in einem Kommentar.
      if (call === 'stagger()') continue;
      if (!/\bhost\b/.test(call)) offenders.push(`${file}: ${call.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [], `stagger() ohne host:\n${offenders.join('\n')}`);
});

test('collapseOut/expandIn: loesen ohne Animation sofort auf (reduzierte Bewegung, kein animate)', async () => {
  await collapseOut(null);
  await expandIn({ style: {} });
  global.window.matchMedia = () => ({ matches: true });
  let animated = false;
  const el = { style: {}, animate: () => { animated = true; } };
  await collapseOut(el);
  await expandIn(el);
  global.window.matchMedia = () => ({ matches: false });
  assert.equal(animated, false, 'unter prefers-reduced-motion darf keine Hoehe animieren');
});

/**
 * Einklappen und Aufziehen laufen auf der SYMMETRISCHEN Kurve `--ease-in-out`
 * (Runde 3, Entscheid 26.09.): `--ease-out` nahm 80 % der Hoehe in den ersten
 * 60ms, die Nachbarn sprangen hinterher - ein Ruck statt eines Nachrueckens.
 * Gemessen wird ueber den AUFRUF (collapseOut/expandIn mit gestubtem
 * `animate`), die Kurve selbst aus tokens.css (x1 + x2 = 1, y1 + y2 = 1).
 */
test('collapseOut/expandIn: Hoehe laeuft auf der symmetrischen Kurve --ease-in-out', async () => {
  const tokens = { '--ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)', '--ease-in-out': 'cubic-bezier(0.42, 0, 0.58, 1)', '--duration-lg': '250ms' };
  const docEl = {};
  const prevDoc = global.document;
  const prevGcs = global.getComputedStyle;
  global.document = { documentElement: docEl };
  global.getComputedStyle = (node) => (node === docEl
    ? { getPropertyValue: (name) => tokens[name] ?? '' }
    : { opacity: '1', paddingTop: '4px', paddingBottom: '4px', marginTop: '0px', marginBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px' });
  const easings = [];
  const el = {
    style: {},
    getBoundingClientRect: () => ({ height: 40 }),
    animate: (_frames, opts) => { easings.push(opts.easing); return { finished: Promise.resolve() }; },
  };
  try {
    await collapseOut(el);
    await expandIn(el);
  } finally {
    global.document = prevDoc;
    global.getComputedStyle = prevGcs;
  }
  assert.deepEqual(easings, [tokens['--ease-in-out'], tokens['--ease-in-out']]);

  const css = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
  const m = css.match(/--ease-in-out:\s*cubic-bezier\(([^)]*)\)/);
  assert.ok(m, 'tokens.css definiert --ease-in-out nicht als cubic-bezier');
  const [x1, y1, x2, y2] = m[1].split(',').map(Number);
  assert.ok(Math.abs(x1 + x2 - 1) < 1e-9 && Math.abs(y1 + y2 - 1) < 1e-9,
    `--ease-in-out ist nicht symmetrisch: ${m[1]}`);
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
  // showToast lebt seit 2026-09-28 in utils/toast-show.js (Frist mit Pause);
  // der Router reicht sie nur weiter. Beide duerfen keinen Zwilling halten.
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const toastShow = readFileSync(new URL('../public/utils/toast-show.js', import.meta.url), 'utf8');
  assert.match(router, /import \{ showToast \} from '\/utils\/toast-show\.js'/,
    'der Router muss showToast aus utils/toast-show.js beziehen, sonst lebt ein Zwilling');
  assert.ok(
    toastShow.includes('wireSwipeToDismiss(toast'),
    'der Toast muss die Geste aus utils/ux.js beziehen',
  );
  for (const [name, src] of [['router.js', router], ['utils/toast-show.js', toastShow]]) {
    assert.ok(
      !src.includes('setPointerCapture'),
      `${name} darf keinen eigenen Wisch-Zwilling mit Pointer-Capture halten`,
    );
  }
});

/* DER KOPF KLAPPT NUR AUF EINEN SCROLL, DEN DER NUTZER FUEHRT (Re-Kritik
 * Kalender 2026-09-25, P2). Woche und Tag stellen ihr Raster beim Rendern auf
 * „jetzt"; gewertet wie ein Nutzer-Scroll, klappte der Tipp auf „Tag" den
 * Titel ein und zog die Ansichts-Tabs mobil von y 105 auf y 60. Die Attrappe
 * baut die gedeckelte Architektur nach: Shell (scrollt) > Modul-Root
 * (overflow hidden, traegt den Lauscher) > Kopf mit zwei Zeilen + innerer
 * Port. */
function collapsingStub() {
  class FakeEl {
    constructor(name, { overflowY = 'visible', rect = null } = {}) {
      this.name = name;
      this.cs = { overflowY, paddingBlockStart: '0', paddingInlineStart: '0', paddingInlineEnd: '0', columnGap: '0' };
      this.rect = rect;
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.style = { setProperty() {}, removeProperty() {} };
      this.handlers = {};
      this.scrollTop = 0;
      this.scrollHeight = 0;
      this.clientHeight = 0;
      this.scrollWidth = 0;
      this.clientWidth = 360;
      const set = new Set();
      this.classList = {
        add: (...c) => c.forEach((x) => set.add(x)),
        remove: (...c) => c.forEach((x) => set.delete(x)),
        toggle: (c, on) => { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c); },
        contains: (c) => set.has(c),
      };
    }
    append(...kids) { for (const k of kids) { k.parentElement = this; this.children.push(k); } return this; }
    contains(n) { for (let x = n; x; x = x.parentElement) if (x === this) return true; return false; }
    querySelector() { return null; }
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
    removeEventListener() {}
    getBoundingClientRect() { const r = this.rect ?? { top: 0, bottom: 0 }; return { ...r, height: r.bottom - r.top, width: 100 }; }
    getClientRects() { return this.rect ? [this.rect] : []; }
    get offsetParent() { return this.rect ? this.parentElement : null; }
  }
  const saved = {};
  for (const k of ['Element', 'getComputedStyle', 'ResizeObserver', 'MutationObserver', 'IntersectionObserver']) saved[k] = global[k];
  global.Element = FakeEl;
  global.getComputedStyle = (el) => el.cs;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.MutationObserver = class { observe() {} disconnect() {} };
  global.IntersectionObserver = class { observe() {} disconnect() {} };
  const restore = () => { for (const [k, v] of Object.entries(saved)) global[k] = v; };

  const shell = new FakeEl('shell', { overflowY: 'auto' });
  const root = new FakeEl('root', { overflowY: 'hidden' });
  const toolbar = new FakeEl('toolbar', { rect: { top: 0, bottom: 90 } });
  const titleRow = new FakeEl('title', { rect: { top: 0, bottom: 40 } });
  const tab = new FakeEl('tab', { rect: { top: 50, bottom: 90 } });
  toolbar.append(titleRow, tab);
  const port = new FakeEl('port', { overflowY: 'auto' });
  const cell = new FakeEl('cell');
  port.append(cell);
  port.scrollHeight = 1600;
  port.clientHeight = 500;
  shell.append(root);
  root.append(toolbar, port);
  const fire = (type, target) => { for (const fn of root.handlers[type] ?? []) fn({ target }); };
  const scrollTo = (p, top) => { p.scrollTop = top; fire('scroll', p); };
  return { FakeEl, root, toolbar, tab, port, cell, fire, scrollTo, restore };
}

test('wireCollapsingHeader: ein Scroll, den die Seite selbst setzt, klappt den Kopf nicht ein', () => {
  const s = collapsingStub();
  try {
    wireCollapsingHeader(s.toolbar);
    assert.ok(s.toolbar.classList.contains('page-toolbar--capped'), 'Attrappe muss die gedeckelte Architektur ergeben');
    // Der Tipp auf den Tab liegt im Kopf, danach stellt die Seite „jetzt" ein.
    s.fire('pointerdown', s.tab);
    s.scrollTo(s.port, 424);
    assert.equal(s.toolbar.classList.contains('is-collapsed'), false,
      'der Scroll auf „jetzt" ist keine Nutzergeste und darf die Tabs nicht verschieben');
    // Ganz ohne Geste (erster Render) ebenso.
    s.scrollTo(s.port, 500);
    assert.equal(s.toolbar.classList.contains('is-collapsed'), false);
  } finally { s.restore(); }
});

test('wireCollapsingHeader: der Nutzer-Scroll klappt weiter ein und aus', () => {
  const s = collapsingStub();
  try {
    wireCollapsingHeader(s.toolbar);
    s.fire('touchstart', s.cell);
    s.scrollTo(s.port, 120);
    assert.equal(s.toolbar.classList.contains('is-collapsed'), true, 'Wisch im Port klappt ein');
    s.scrollTo(s.port, 0);
    assert.equal(s.toolbar.classList.contains('is-collapsed'), false, 'zurueck oben klappt aus');
    s.fire('wheel', s.port);
    s.scrollTo(s.port, 200);
    assert.equal(s.toolbar.classList.contains('is-collapsed'), true, 'Mausrad/Scrollbalken im Port klappt ein');
  } finally { s.restore(); }
});

test('wireCollapsingHeader: ein Ansichtswechsel haelt den eingeklappten Kopf, wo der neue Port ihn tragen kann', () => {
  const s = collapsingStub();
  try {
    wireCollapsingHeader(s.toolbar);
    s.fire('touchstart', s.cell);
    s.scrollTo(s.port, 300);
    assert.equal(s.toolbar.classList.contains('is-collapsed'), true);
    // Tipp auf „Tag": neuer Port mit Reserve, die Seite stellt ihn auf „jetzt"
    // und nahe an den Anfang (frueher Morgen) - beides ohne Geste.
    s.fire('pointerdown', s.tab);
    const dayPort = new s.FakeEl('day-scroll', { overflowY: 'auto' });
    dayPort.scrollHeight = 1600;
    dayPort.clientHeight = 500;
    s.root.append(dayPort);
    s.scrollTo(dayPort, 4);
    assert.equal(s.toolbar.classList.contains('is-collapsed'), true,
      'ein Scroll ohne Geste darf den Kopf nicht aufklappen, wenn der Port ihn traegt');
  } finally { s.restore(); }
});

test('wireCollapsingHeader: ein Port, der den Kollaps nicht traegt, klappt auch ohne Geste auf', () => {
  // Die Gegenseite (Critique 2026-09-24): der Monat scrollt nicht. Bliebe der
  // Kopf der Woche dort eingeklappt, holte ihn kein Scroll mehr zurueck.
  const s = collapsingStub();
  try {
    wireCollapsingHeader(s.toolbar);
    s.fire('touchstart', s.cell);
    s.scrollTo(s.port, 300);
    s.fire('pointerdown', s.tab);
    const monthRows = new s.FakeEl('month-rows', { overflowY: 'auto' });
    s.root.append(monthRows);
    s.scrollTo(monthRows, 0);
    assert.equal(s.toolbar.classList.contains('is-collapsed'), false);
  } finally { s.restore(); }
});

test('watchNavCapsuleHeight: die gemessene Kapselhoehe steht am Root, eine verborgene Kapsel raeumt sie (Review zu #1475)', () => {
  // Die Kapsel waechst mit umbrechenden Labels ueber 60px (lange Sprachen,
  // 320px). Der Nachlauf rechnete fest mit der Token-Hoehe, und die letzte
  // Zeile lag teilweise unter dem Glas. Gemessen, nicht gerechnet - wie das
  // Installationsbanner (`--install-prompt-height`).
  const saved = globalThis.ResizeObserver;
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  };
  const props = new Map();
  const root = { style: {
    setProperty: (k, v) => props.set(k, v),
    removeProperty: (k) => props.delete(k),
  } };
  const items = { isConnected: true };
  try {
    watchNavCapsuleHeight(items, root);
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0].targets, [items], 'beobachtet wird die Kapsel selbst');
    const fire = (blockSize) => observers[0].cb([{ target: items, borderBoxSize: [{ blockSize }] }]);
    fire(60);
    assert.equal(props.get('--nav-capsule-height'), '60px');
    fire(72.1875);
    assert.equal(props.get('--nav-capsule-height'), '72.1875px', 'zweizeilige Labels: die echte Hoehe, ungerundet');
    fire(0);
    assert.equal(props.has('--nav-capsule-height'), false,
      'ohne gerenderte Kapsel (Desktop, Wand-Modus) gilt wieder die Token-Hoehe');
    fire(74);
    items.isConnected = false;
    fire(0);
    assert.equal(props.get('--nav-capsule-height'), '74px',
      'eine ersetzte, abgehaengte Kapsel raeumt den Wert ihrer Nachfolgerin nicht');
    assert.equal(observers[0].disconnected, true, 'und ihr Beobachter endet');
  } finally {
    globalThis.ResizeObserver = saved;
  }
});

test('wireScrollFade: eine abgehaengte Leiste haengt ihre Beobachter selbst ab, eine noch lose bekommt ihren Fade (Critique 2026-09-26, Beifang R5)', () => {
  // sub-tabs.js baut bei jedem Eintritt eine neue Leiste und haelt `destroy`
  // nicht fest - jede alte liess ihren ResizeObserver am abgehaengten Knoten
  // (Sonde: vier Kuechen-Eintritte, vier lebende Observer). Der Observer
  // meldet sich, wenn sein Element das Dokument verlaesst; dort endet er.
  const savedRO = globalThis.ResizeObserver;
  const savedMO = globalThis.MutationObserver;
  const ros = [];
  const mos = [];
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.disconnected = false; ros.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb; this.disconnected = false; mos.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  const bar = () => {
    const classes = new Set();
    const listeners = new Map();
    return {
      isConnected: true, scrollLeft: 0, scrollWidth: 500, clientWidth: 300,
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
        contains: (c) => classes.has(c),
      },
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
      listeners,
    };
  };
  try {
    const el = bar();
    wireScrollFade(el);
    assert.equal(el.classList.contains('has-fade-end'), true, 'ueberlaufende Leiste traegt den End-Fade');
    assert.equal(el.listeners.has('scroll'), true);
    el.isConnected = false;
    ros[0].cb([]);
    assert.equal(ros[0].disconnected, true, 'ResizeObserver endet mit der Leiste');
    assert.equal(mos[0].disconnected, true, 'MutationObserver auch');
    assert.equal(el.listeners.has('scroll'), false, 'und der Scroll-Hoerer');

    // Verdrahtet, BEVOR sie eingefuegt ist: kein Abbau, der Fade kommt mit dem Einhaengen.
    const loose = bar();
    loose.isConnected = false;
    wireScrollFade(loose);
    assert.equal(ros[1].disconnected, false, 'eine noch lose Leiste wird nicht abgebaut');
    loose.isConnected = true;
    ros[1].cb([]);
    assert.equal(loose.classList.contains('has-fade-end'), true);
  } finally {
    globalThis.ResizeObserver = savedRO;
    globalThis.MutationObserver = savedMO;
  }
});

/**
 * NIE EIN KOPF OHNE ORTSANGABE (Re-Critique 2026-09-27, R9 M9, A1 P2-4).
 *
 * Die Attrappe baut die SCROLLENDE Architektur der Aufgaben bei 390px nach
 * (Innenbreite 358px): Titelzeile, darunter Lupe (48) + Aktionen (277) mit
 * Ansichts-Segment (104), Filter (117) und Werkzeugmenue (48). Gemessen liess
 * die Bar-Zeile dem angedockten Titel 17px - er fiel weg, angedockt stand kein
 * Wort, wo man ist.
 */
function dockStub({ withMenu = true, tabBar = false, padTop = 0, barTop = 57 } = {}) {
  const matchOne = (el, s) => {
    const m = s.match(/^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/i);
    if (!m) throw new Error(`Attrappe kennt den Selektor nicht: ${s}`);
    const [, tag, cls, attrs] = m;
    if (tag && el.tag !== tag.toLowerCase()) return false;
    for (const c of cls.split('.').filter(Boolean)) if (!el.classes.has(c)) return false;
    for (const a of (attrs.match(/[\w-]+/g) ?? [])) if (!(a in el.attrs)) return false;
    return true;
  };
  const matches = (el, sel) => sel.split(',').map((s) => s.trim()).some((s) => matchOne(el, s));
  const all = (el) => el.children.flatMap((c) => [c, ...all(c)]);
  class El {
    constructor(tag, { cls = [], attrs = {}, rect = null, cs = {} } = {}) {
      this.tag = tag; this.classes = new Set(cls); this.attrs = { ...attrs }; this.rect = rect;
      this.children = []; this.parentElement = null; this.dataset = {}; this.handlers = {};
      this.cs = { overflowY: 'visible', paddingBlockStart: '0', paddingInlineStart: '0', paddingInlineEnd: '0', columnGap: '0', ...cs };
      this.props = new Map();
      this.style = { setProperty: (k, v) => this.props.set(k, v), removeProperty: (k) => this.props.delete(k) };
      this.clientWidth = rect ? rect.width : 0; this.textContent = ''; this.clicks = 0;
      const set = this.classes;
      this.classList = {
        add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)),
        toggle: (c, on) => { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c); },
        contains: (c) => set.has(c),
      };
    }
    get id() { return this.attrs.id ?? ''; }
    set className(v) { this.classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classes.add(c)); }
    get nextElementSibling() { const s = this.parentElement?.children; return s ? s[s.indexOf(this) + 1] ?? null : null; }
    get offsetParent() { return this.visible() ? this.parentElement : null; }
    visible() { return Boolean(this.rect) && !this.attrs.hidden && !this.hiddenByCss?.(); }
    append(...kids) { for (const k of kids) { k.parentElement = this; this.children.push(k); } }
    prepend(...kids) { for (const k of kids.reverse()) { k.parentElement = this; this.children.unshift(k); } }
    insertBefore(k, ref) { k.remove(); k.parentElement = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(k); else this.children.splice(i, 0, k); }
    remove() { const p = this.parentElement; if (p) p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; }
    matches(sel) { return matches(this, sel); }
    querySelectorAll(sel) {
      const scoped = sel.startsWith(':scope > ');
      const pool = scoped ? this.children : all(this);
      return pool.filter((c) => matches(c, scoped ? sel.slice(9) : sel));
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
    hasAttribute(n) { return n in this.attrs; }
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    removeAttribute(n) { delete this.attrs[n]; }
    toggleAttribute(n, on) { if (on) this.attrs[n] = ''; else delete this.attrs[n]; }
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
    removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] ?? []).filter((f) => f !== fn); }
    click() { this.clicks += 1; for (const fn of this.handlers.click ?? []) fn({ target: this }); }
    getClientRects() { return this.visible() ? [this.rect] : []; }
    getBoundingClientRect() {
      const r = this.visible() ? this.rect : { top: 0, bottom: 0, left: 0, width: 0 };
      return { ...r, height: r.bottom - r.top, right: (r.left ?? 0) + r.width };
    }
  }
  const box = (top, bottom, width) => ({ top, bottom, left: 0, width });
  const scrollport = new El('main', { cs: { overflowY: 'auto' }, rect: box(0, 844, 390) });
  const toolbar = new El('div', { cls: ['page-toolbar'], rect: box(0, 112, 358) });
  toolbar.cs.columnGap = '8';
  toolbar.cs.paddingBlockStart = String(padTop);
  const title = new El('h1', { cls: ['page-toolbar__title'], rect: box(8, 49, 322) });
  title.textContent = 'Aufgaben';
  const search = new El('label', { cls: ['page-search', 'page-toolbar__center'], rect: box(60, 108, 48) });
  const actions = new El('div', { cls: ['page-toolbar__actions'], rect: box(57, 111, 277) });
  actions.cs.columnGap = '8';
  const seg = new El('div', { cls: ['group-toggle'], attrs: { role: 'group' }, rect: box(57, 111, 104) });
  const list = new El('button', { attrs: { 'aria-label': 'Listenansicht', 'aria-pressed': 'true' }, rect: box(59, 107, 48) });
  const kanban = new El('button', { attrs: { 'aria-label': 'Kanban-Ansicht', 'aria-pressed': 'false' }, rect: box(59, 107, 48) });
  seg.append(list, kanban);
  const filter = new El('button', { cls: ['btn', 'page-filter-btn'], attrs: { 'aria-label': '1 Filter aktiv' }, rect: box(60, 108, 117) });
  actions.append(seg, filter);
  let panel = null;
  if (withMenu) {
    const trigger = new El('button', { cls: ['btn', 'page-tools-btn', 'popover-menu__trigger'], attrs: { popovertarget: 'tasks-tools-menu' }, rect: box(60, 108, 48) });
    panel = new El('div', { cls: ['popover-menu'], attrs: { id: 'tasks-tools-menu', popover: '' } });
    panel.append(new El('button', { cls: ['popover-menu__item'], attrs: { role: 'menuitem' } }));
    actions.append(trigger, panel);
  }
  // Schichtplan, Haushaltshilfe, Belohnungen (R11 H1): die Bar-Zeile ist eine
  // Tab-Leiste ueber die ganze Innenbreite, kein Werkzeugmenue daneben.
  const tabs = new El('div', { cls: ['sub-tabs-bar'], attrs: { role: 'tablist' }, rect: box(barTop, barTop + 48, 358) });
  if (tabBar) {
    title.textContent = 'Schichtplan';
    toolbar.append(title, tabs);
  } else {
    toolbar.append(title, search, actions);
  }
  scrollport.append(toolbar);
  // Angedockt blendet das CSS die markierten Kontrollen aus.
  for (const el of [seg, filter]) {
    el.hiddenByCss = () => toolbar.classList.contains('page-toolbar--dock-fold')
      && toolbar.classList.contains('is-docked') && 'data-dock-fold' in el.attrs;
  }

  const saved = {};
  for (const k of ['Element', 'getComputedStyle', 'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'document']) saved[k] = global[k];
  global.Element = El;
  global.getComputedStyle = (el) => el.cs;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.MutationObserver = class { observe() {} disconnect() {} };
  const ioOptions = [];
  global.IntersectionObserver = class { constructor(cb, opts) { ioOptions.push(opts); } observe() {} disconnect() {} };
  global.document = {
    body: null,
    createElement: (tag) => new El(tag, { rect: box(60, 87, 0) }),
    getElementById: () => null,
  };
  const restore = () => { for (const [k, v] of Object.entries(saved)) global[k] = v; };
  const dockTitle = () => toolbar.children.find((c) => c.classes.has('page-toolbar__dock-title')) ?? null;
  const toggleMenu = (newState) => { for (const fn of toolbar.handlers.beforetoggle ?? []) fn({ target: panel, newState }); };
  return { toolbar, actions, seg, filter, list, kanban, panel, title, tabs, ioOptions, dockTitle, toggleMenu, restore };
}

test('M9: laesst die Bar-Zeile dem Titel keine 88px, falten die Kontrollen und der Titel erscheint', () => {
  const s = dockStub();
  try {
    const header = wireCollapsingHeader(s.toolbar);
    assert.ok(s.toolbar.classList.contains('page-toolbar--stacked'), 'Attrappe muss einen gestapelten Kopf ergeben');
    assert.ok(s.toolbar.classList.contains('page-toolbar--dock-fold'), 'ohne Faltung stuende angedockt kein Titel');
    assert.equal(s.dockTitle()?.textContent, 'Aufgaben', 'der angedockte Titel nennt den Ort');
    assert.equal(s.dockTitle()?.nextElementSibling, s.actions, 'er steht vor den Aktionen, in der Bar-Zeile');
    assert.ok(s.seg.hasAttribute('data-dock-fold'), 'das Ansichts-Segment faltet');
    assert.ok(s.filter.hasAttribute('data-dock-fold'), 'der Filter faltet');
    const trigger = s.actions.querySelector(':scope > .page-tools-btn[popovertarget]');
    assert.equal(trigger.hasAttribute('data-dock-fold'), false, 'das „..." bleibt - dorthin wird gefaltet');
    assert.equal(s.toolbar.props.get('--dock-fold-bar-h'), '54px', 'die Bar-Zeile behaelt ihre Hoehe');

    // Angedockt sind die Kontrollen weg; eine neue Messung darf die Faltung
    // nicht zuruecknehmen, sonst pendelt der Kopf.
    s.toolbar.classList.add('is-docked');
    header.update();
    assert.ok(s.toolbar.classList.contains('page-toolbar--dock-fold'), 'gefaltet gemessen wird nicht neu entschieden');
    assert.ok(s.seg.hasAttribute('data-dock-fold'));
    header.destroy();
    assert.equal(s.seg.hasAttribute('data-dock-fold'), false, 'destroy raeumt die Markierung ab');
  } finally { s.restore(); }
});

test('M9: im Werkzeugmenue stehen die gefalteten Kontrollen, ein Eintrag klickt das Original', () => {
  const s = dockStub();
  try {
    wireCollapsingHeader(s.toolbar);
    s.toolbar.classList.add('is-docked');
    s.toggleMenu('open');
    const items = s.panel.children.filter((c) => c.classes.has('page-toolbar__fold-item'));
    assert.deepEqual(items.map((i) => [i.getAttribute('role'), i.getAttribute('aria-checked'), i.children.at(-1)?.textContent]), [
      ['menuitemradio', 'true', 'Listenansicht'],
      ['menuitemradio', 'false', 'Kanban-Ansicht'],
      ['menuitem', null, '1 Filter aktiv'],
      ['separator', null, undefined],
    ], 'Segment als Einfachauswahl mit dem Ist-Zustand, Filter als Eintrag, dann eine Trennlinie');
    assert.equal(s.panel.children.indexOf(items[0]), 0, 'oben im Menue');
    items[1].click();
    assert.equal(s.kanban.clicks, 1, 'der Eintrag loest die Aktion des Originals aus, keine zweite Kopie');
    s.toggleMenu('closed');
    assert.equal(s.panel.children.filter((c) => c.classes.has('page-toolbar__fold-item')).length, 0, 'geschlossen: Stellvertreter wieder weg');

    s.toolbar.classList.remove('is-docked');
    s.toggleMenu('open');
    assert.equal(s.panel.children.filter((c) => c.classes.has('page-toolbar__fold-item')).length, 0,
      'ausgeklappt stehen die Kontrollen selbst da - keine Doppelung im Menue');
  } finally { s.restore(); }
});

test('M9: ohne Werkzeugmenue faltet nichts (eine Kontrolle verschwindet nie ersatzlos)', () => {
  const s = dockStub({ withMenu: false });
  try {
    wireCollapsingHeader(s.toolbar);
    assert.equal(s.toolbar.classList.contains('page-toolbar--dock-fold'), false);
    assert.equal(s.seg.hasAttribute('data-dock-fold'), false);
  } finally { s.restore(); }
});

/**
 * NIE EIN KOPF OHNE ORTSANGABE, AUCH OHNE „..." (Re-Critique 2026-09-27, R11 H1).
 *
 * Schichtplan, Haushaltshilfe und Belohnungen: die Bar-Zeile ist eine
 * Tab-Leiste ueber die ganze Breite, es gibt kein Werkzeugmenue, in das etwas
 * falten koennte. Vorher stand angedockt nur die Leiste da - kein Titel, kein
 * Wort, in welchem Modul. Jetzt klebt der Kopf um die Hoehe des Titels tiefer
 * (Band), der Titel steht in diesem Streifen, und die Andock-Schwelle rueckt
 * um denselben Streifen.
 */
test('H1: eine Tab-Leiste als Bar-Zeile bekommt angedockt trotzdem ihren Titel (Band)', () => {
  const s = dockStub({ tabBar: true });
  try {
    const header = wireCollapsingHeader(s.toolbar);
    assert.ok(s.toolbar.classList.contains('page-toolbar--stacked'), 'Attrappe muss einen gestapelten Kopf ergeben');
    assert.equal(s.toolbar.classList.contains('page-toolbar--dock-fold'), false, 'ohne Menue faltet nichts');
    assert.equal(s.dockTitle()?.textContent, 'Schichtplan', 'angedockt steht der Ortsname - nie nur die Leiste');
    assert.ok(s.toolbar.classList.contains('page-toolbar--dock-band'), 'der Titel bekommt den Streifen, keine eigene Zeile');
    assert.equal(s.toolbar.props.get('--dock-band-h'), '27px', 'der Streifen ist so hoch wie der gemessene Titel');
    assert.ok(s.title.hasAttribute('data-dock-lead'), 'der Large Title gehoert zur Lead-Zone und blendet angedockt aus');
    assert.equal(s.tabs.hasAttribute('data-dock-lead'), false, 'die Leiste bleibt');
    assert.equal(s.ioOptions.at(-1)?.rootMargin, '-28px 0px 0px 0px',
      'die Schwelle rueckt um den Streifen, sonst dockte der tiefer klebende Kopf nie an');
    header.destroy();
    assert.equal(s.title.hasAttribute('data-dock-lead'), false, 'destroy raeumt die Markierung ab');
    assert.equal(s.toolbar.props.has('--dock-band-h'), false);
    assert.equal(s.toolbar.classList.contains('page-toolbar--dock-band'), false);
  } finally { s.restore(); }
});

test('H1: wo der Titel in die Bar-Zeile passt oder faltet, bleibt es beim alten Kopf ohne Band', () => {
  const s = dockStub();
  try {
    wireCollapsingHeader(s.toolbar);
    assert.equal(s.toolbar.classList.contains('page-toolbar--dock-band'), false);
    assert.equal(s.toolbar.props.has('--dock-band-h'), false);
    assert.equal(s.ioOptions.at(-1)?.rootMargin, '-1px 0px 0px 0px');
  } finally { s.restore(); }
});

/**
 * DIE ERSTE ZEILE RAGT UM DIE DIFFERENZ AUS POLSTER UND LUECKE UNTER DIE
 * LEAD-ZONE (Dokument-Guards, Sonde 8, nach R11 H1). Die Attrappe oben hat
 * kein Polster; die Haushaltshilfe hat 8px oben und 4px Zeilenluecke: Titel
 * 8-49, Leiste ab 53, Lead-Zone 53 - 8 = 45. Geklebt steht der Kopf bei
 * -(45 - 27) = -18, der Titel reicht bis 31 - unter den alten 28px-Rahmen,
 * und der Kopf dockte nie an. Der Rahmen schrumpft um die 4px mit.
 */
test('H1: ragt die erste Zeile unter die Lead-Zone, rueckt die Andock-Schwelle mit', () => {
  const s = dockStub({ tabBar: true, padTop: 8, barTop: 53 });
  try {
    wireCollapsingHeader(s.toolbar);
    assert.equal(s.toolbar.props.get('--page-toolbar-lead'), '45px', 'Attrappe muss die gemessene Lead-Zone ergeben');
    assert.ok(s.toolbar.classList.contains('page-toolbar--dock-band'), 'Attrappe muss den Band-Modus ergeben');
    assert.equal(s.ioOptions.at(-1)?.rootMargin, '-32px 0px 0px 0px',
      'Streifen (27) + Ueberhang des Titels (49 - 45) + 1: erst dann hat die erste Zeile den Port verlassen');
  } finally { s.restore(); }
});

/**
 * DER UEBERHANG WIRD AN DER KANTE GEMESSEN, AUF DER DER KOPF JETZT STEHT.
 * Der Kopf klebt mit einem `top` aus `--page-toolbar-lead` und `--dock-band-h`,
 * und `update` schreibt beide, bevor es den Ueberhang misst. Aendert sich der
 * Streifen, waehrend der Kopf klebt (Neuaufbau, andere Schrift), rueckt der
 * ganze Kopf mit - eine Oberkante von VOR dem Schreiben verschiebt den
 * Ueberhang um genau diesen Weg (claude-review an #1491).
 */
test('H1: rueckt der klebende Kopf beim Schreiben des Streifens, misst der Ueberhang die neue Kante', () => {
  const s = dockStub({ tabBar: true, padTop: 8, barTop: 53 });
  try {
    // Geklebt mit einem alten Streifen von 22px; die Messung ergibt 27px, und
    // mit dem Schreiben rueckt der Kopf samt Inhalt um 5px tiefer.
    const moved = [s.toolbar, ...s.toolbar.children];
    s.toolbar.props.set('--dock-band-h', '22px');
    const set = s.toolbar.style.setProperty;
    s.toolbar.style.setProperty = (k, v) => {
      if (k === '--dock-band-h') {
        const delta = parseFloat(v) - parseFloat(s.toolbar.props.get(k) ?? '0');
        for (const el of moved) el.rect = { ...el.rect, top: el.rect.top + delta, bottom: el.rect.bottom + delta };
      }
      set(k, v);
    };
    wireCollapsingHeader(s.toolbar);
    assert.equal(s.toolbar.props.get('--dock-band-h'), '27px', 'Attrappe muss den neuen Streifen ergeben');
    assert.equal(s.ioOptions.at(-1)?.rootMargin, '-32px 0px 0px 0px',
      'dieselbe Schwelle wie ohne Verschiebung: der Kopf ist mitgerueckt, der Titel ragt weiter 4px unter die Lead-Zone');
  } finally { s.restore(); }
});

/**
 * EINE ZEILE HAT KEINE LEAD-ZONE (Dokument-Guards, Sonde 8, nach R9 M10).
 * Rezepte und Vorrat legen ihren Kopf mobil in die 56px-Zeile der
 * Kuechen-Leiste, ohne Polster; die 48px-Lupe sitzt mittig, also 4px tief.
 * Die Rechnung „Oberkante der letzten Zeile minus Polster" machte daraus 4px
 * Lead-Zone und ein `--stacked`, das die Trennlinie dauerhaft verbarg.
 */
test('wireCollapsingHeader: ein einzeiliger Kopf mit mittig versetztem Inhalt bekommt keine Lead-Zone', () => {
  const s = dockStub({ withMenu: false });
  try {
    // Nur die Lupe, 4px unter der Kopfkante - Titel und Aktionen tragen keine Hoehe.
    s.toolbar.children.splice(0, s.toolbar.children.length);
    const search = new s.title.constructor('label', { cls: ['page-search', 'page-toolbar__center'], rect: { top: 4, bottom: 52, left: 0, width: 48 } });
    s.toolbar.append(search);
    wireCollapsingHeader(s.toolbar);
    assert.equal(s.toolbar.props.get('--page-toolbar-lead'), '0px');
    assert.equal(s.toolbar.classList.contains('page-toolbar--stacked'), false,
      'ohne zweite Zeile kein --stacked: es verbirgt die Trennlinie, und nichts holt sie zurueck');
    assert.equal(s.toolbar.classList.contains('is-docked'), true, 'ohne Lead-Zone steht die Linie durchgehend');
  } finally { s.restore(); }
});

test('H1: das CSS klebt den Band-Kopf um den Streifen tiefer und blendet nur angedockt um', () => {
  const css = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const compact = [...eachRule(css)].filter((r) => r.at.some((a) => /max-width:\s*1023px/.test(a)));
  const body = (sel) => compact.find((r) => r.selector.trim() === sel)?.body ?? '';
  assert.match(body('.page-toolbar--stacked.page-toolbar--dock-band'),
    /top:\s*calc\(-1 \* \(var\(--page-toolbar-lead, 0px\) - var\(--dock-band-h, 0px\)\)\)/);
  const title = body('.page-toolbar--stacked.page-toolbar--dock-band > .page-toolbar__dock-title');
  assert.match(title, /position:\s*absolute/, 'der Titel macht keine eigene Zeile auf');
  assert.match(title, /visibility:\s*hidden/, 'ausgeklappt gerendert, aber unsichtbar');
  assert.match(body('.page-toolbar--stacked.page-toolbar--dock-band.is-docked > .page-toolbar__dock-title'), /visibility:\s*visible/);
  const lead = body('.page-toolbar--stacked.page-toolbar--dock-band.is-docked > [data-dock-lead]');
  assert.match(lead, /opacity:\s*0/);
  assert.doesNotMatch(lead, /visibility|display/, 'der Large Title bleibt die Ueberschrift im Baum');
});

test('M9: das CSS blendet nur angedockt und gefaltet aus und haelt die Zeilenhoehe', () => {
  const css = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const compact = [...eachRule(css)].filter((r) => r.at.some((a) => /max-width:\s*1023px/.test(a)));
  const body = (sel) => compact.find((r) => r.selector.trim() === sel)?.body ?? '';
  assert.match(body('.page-toolbar--stacked.page-toolbar--dock-fold.is-docked > .page-toolbar__actions > [data-dock-fold]'),
    /display:\s*none/);
  assert.match(body('.page-toolbar--stacked.page-toolbar--dock-fold.is-docked > .page-toolbar__actions'),
    /min-block-size:\s*var\(--dock-fold-bar-h/);
});

/* DIE KUECHEN-KONTEXTZEILE FALTET BEIM ANDOCKEN (R17 K1, A4 P2-4 / A8 P3-2).
 * Rezepte und Vorrat tragen unter der Kuechen-Leiste eine eigene Zeile, die
 * mobil nur Werkzeuge haelt (Lupe, "..."): 65px fuer ein bis zwei Icons. Sie
 * haengt jetzt an derselben Schwelle und Klasse wie der Kopf der gedeckelten
 * Module: ein Nutzer-Scroll im Port klappt sie ein (`is-collapsed`), zurueck
 * oben kommt sie wieder. Eine Kontextzeile, die etwas BENENNT (Wochenstepper
 * im Essensplan, Listen-Kapseln im Einkauf), bleibt stehen - wie der Zeitraum
 * im Kalender. Die Attrappe baut Shell > Seite (overflow hidden) > Kopf in
 * EINER Zeile + innerer Port. */
function kitchenFoldStub({ centerCls = ['page-search', 'page-toolbar__center'] } = {}) {
  class FakeEl {
    constructor(name, { overflowY = 'visible', rect = null, cls = [] } = {}) {
      this.name = name;
      this.cs = { overflowY, paddingBlockStart: '8', paddingInlineStart: '16', paddingInlineEnd: '16', columnGap: '8', borderBottomWidth: '1px' };
      this.rect = rect;
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.props = new Map();
      this.style = { setProperty: (k, v) => this.props.set(k, v), removeProperty: (k) => this.props.delete(k) };
      this.handlers = {};
      this.scrollTop = 0;
      this.scrollHeight = 0;
      this.clientHeight = 0;
      this.scrollWidth = 0;
      this.clientWidth = 390;
      const set = new Set(cls);
      this.classList = {
        add: (...c) => c.forEach((x) => set.add(x)),
        remove: (...c) => c.forEach((x) => set.delete(x)),
        toggle: (c, on) => { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c); },
        contains: (c) => set.has(c),
      };
    }
    append(...kids) { for (const k of kids) { k.parentElement = this; this.children.push(k); } return this; }
    contains(n) { for (let x = n; x; x = x.parentElement) if (x === this) return true; return false; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
    removeEventListener() {}
    getBoundingClientRect() { const r = this.rect ?? { top: 0, bottom: 0 }; return { ...r, height: r.bottom - r.top, width: 48 }; }
    getClientRects() { return this.rect ? [this.rect] : []; }
    get offsetParent() { return this.rect ? this.parentElement : null; }
  }
  const saved = {};
  for (const k of ['Element', 'getComputedStyle', 'ResizeObserver', 'MutationObserver', 'IntersectionObserver']) saved[k] = global[k];
  global.Element = FakeEl;
  global.getComputedStyle = (el) => el.cs;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.MutationObserver = class { observe() {} disconnect() {} };
  global.IntersectionObserver = class { observe() {} disconnect() {} };
  const restore = () => { for (const [k, v] of Object.entries(saved)) global[k] = v; };

  const shell = new FakeEl('shell', { overflowY: 'auto' });
  const page = new FakeEl('page', { overflowY: 'hidden' });
  // 8 Polster + 48 Lupe + 8 Polster + 1 Linie = 65px, wie gemessen (390x844).
  const toolbar = new FakeEl('toolbar', { rect: { top: 0, bottom: 65 }, cls: ['page-toolbar', 'page-toolbar--in-group'] });
  const center = new FakeEl('center', { rect: { top: 8, bottom: 56 }, cls: centerCls });
  const actions = new FakeEl('actions', { rect: { top: 8, bottom: 56 }, cls: ['page-toolbar__actions'] });
  toolbar.append(center, actions);
  const port = new FakeEl('port', { overflowY: 'auto' });
  const row = new FakeEl('row');
  port.append(row);
  port.scrollHeight = 2400;
  port.clientHeight = 723;
  shell.append(page);
  page.append(toolbar, port);
  const fire = (type, target) => { for (const fn of page.handlers[type] ?? []) fn({ target }); };
  const scrollTo = (top) => { port.scrollTop = top; fire('scroll', port); };
  return { toolbar, port, row, fire, scrollTo, restore };
}

test('K1: die Kuechen-Kontextzeile aus reinen Werkzeugen klappt beim Andocken ein und oben wieder aus', () => {
  const s = kitchenFoldStub();
  try {
    wireCollapsingHeader(s.toolbar);
    assert.equal(s.toolbar.classList.contains('page-toolbar--fold-row'), true, 'eine Werkzeugzeile unter der Leiste ist eine Faltzeile');
    assert.equal(s.toolbar.props.get('--fold-row-h'), '64px', 'gefaltet wird die Zeile ohne ihre Linie - die bleibt als Kante unter der Leiste');
    assert.equal(s.toolbar.props.get('--page-toolbar-lead') ?? '0px', '0px', 'keine Lead-Zone: der Kopf ist einzeilig (Sonde 8)');
    assert.equal(s.toolbar.classList.contains('is-collapsed'), false, 'ungescrollt steht die Zeile wie bisher');
    // Ohne Geste (die Seite stellt etwas ein) klappt nichts.
    s.scrollTo(200);
    assert.equal(s.toolbar.classList.contains('is-collapsed'), false, 'nur ein Scroll des Nutzers faltet');
    s.fire('touchstart', s.row);
    s.scrollTo(120);
    assert.equal(s.toolbar.classList.contains('is-collapsed'), true, 'angedockt faltet die Zeile ein');
    assert.equal(s.toolbar.classList.contains('is-docked'), true, 'die Linie bleibt - sie ist die Kante des angedockten Kopfes');
    s.scrollTo(0);
    assert.equal(s.toolbar.classList.contains('is-collapsed'), false, 'zurueck oben kommt sie wieder');
  } finally { s.restore(); }
});

test('K1: eine Kontextzeile, die etwas benennt, und ein kurzer Port falten nicht', () => {
  const named = kitchenFoldStub({ centerCls: ['page-toolbar__center', 'week-nav'] });
  try {
    wireCollapsingHeader(named.toolbar);
    assert.equal(named.toolbar.classList.contains('page-toolbar--fold-row'), false, 'Wochenstepper und Listen-Kapseln bleiben stehen');
    named.fire('touchstart', named.row);
    named.scrollTo(120);
    assert.equal(named.toolbar.classList.contains('is-collapsed'), false);
  } finally { named.restore(); }
  const short = kitchenFoldStub();
  try {
    short.port.scrollHeight = short.port.clientHeight + 90;
    wireCollapsingHeader(short.toolbar);
    short.fire('touchstart', short.row);
    short.scrollTo(60);
    assert.equal(short.toolbar.classList.contains('is-collapsed'), false,
      'ein Port, der die zurueckkehrende Zeile nicht traegt, faltet nicht - sonst pendelt beides');
  } finally { short.restore(); }
});

test('K1: das CSS faltet die Zeile nur eingeklappt, nie mit Fokus, Suchbegriff oder offenem Menue, und ohne Bewegung bei reduced motion', () => {
  const css = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const compact = rules.filter((r) => r.at.some((a) => /max-width:\s*1023px/.test(a)) && !r.at.some((a) => /reduce/.test(a)));
  const folded = compact.filter((r) => /\.page-toolbar--fold-row\.is-collapsed/.test(r.selector));
  assert.ok(folded.length, 'die Faltung haengt an der Dock-Klasse is-collapsed');
  const body = folded.map((r) => r.body).join(';');
  assert.match(body, /margin-block-end:\s*calc\(-1 \* var\(--fold-row-h/, 'die Zeile gibt ihre Hoehe frei');
  assert.match(body, /opacity:\s*0/, 'mit Blende');
  assert.match(body, /pointer-events:\s*none/);
  for (const r of folded) {
    assert.match(r.selector, /:not\(:focus-within\)/, `${r.selector}: wer darin steht, behaelt die Zeile`);
    assert.match(r.selector, /:not\(:has\(input:not\(:placeholder-shown\)\)\)/, `${r.selector}: ein Suchbegriff haelt die Zeile offen`);
    assert.match(r.selector, /:not\(:has\(:popover-open\)\)/, `${r.selector}: ein offenes Menue haelt seinen Knopf`);
  }
  assert.doesNotMatch(folded.filter((r) => !/>\s*\*\s*$/.test(r.selector)).map((r) => r.body).join(';'), /opacity/,
    'die Zeile selbst blendet nicht aus - ihre Linie bleibt die Kante unter der Leiste');
  const base = compact.find((r) => r.selector.trim() === '.page-toolbar--fold-row');
  assert.ok(base && /transition:[^;]*margin-block-end/.test(base.body) && /translate/.test(base.body), 'die freiwerdende Hoehe gleitet');
  const kids = compact.find((r) => r.selector.trim() === '.page-toolbar--fold-row > *');
  assert.ok(kids && /transition:\s*opacity/.test(kids.body), 'der Inhalt blendet');
  const reduced = rules.filter((r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a))
    && /\.page-toolbar--fold-row/.test(r.selector));
  assert.ok(reduced.some((r) => /\.page-toolbar--fold-row\s*,|^\.page-toolbar--fold-row$/.test(r.selector.trim()) && /transition:\s*none/.test(r.body)),
    'reduzierte Bewegung: ohne Bewegung');
});

test('K1: die gefaltete Zeile misst die Reserve ausgeklappt - sonst pendelt sie bei knappen Listen', () => {
  // Gemessen an den Rezepten (390x844, ein Rezept aufgeklappt): 166px Reserve
  // ausgeklappt, 102px gefaltet. Gegen die gefaltete Reserve gemessen, fiele
  // die Zeile beim naechsten Scroll-Ereignis unter 64 + 48 und klappte aus -
  // und mit ihr wieder ein.
  const s = kitchenFoldStub();
  try {
    s.port.scrollHeight = s.port.clientHeight + 166;
    wireCollapsingHeader(s.toolbar);
    s.fire('touchstart', s.row);
    s.scrollTo(100);
    assert.equal(s.toolbar.classList.contains('is-collapsed'), true);
    // Gefaltet: der Port waechst um die Zeile, die Zeile traegt ihren negativen Rand.
    s.port.clientHeight += 64;
    s.toolbar.cs.marginBlockEnd = '-64px';
    s.scrollTo(101);
    assert.equal(s.toolbar.classList.contains('is-collapsed'), true, 'die Zeile bleibt gefaltet');
  } finally { s.restore(); }
});

/*
 * growBars (Critique R16, P2 Bewegung): die Budget-Balken tragen eine
 * Transition, die nie lief, weil `--bar-scale` schon am Endwert im Markup
 * steht. Der Helfer setzt kurz den Startwert und sofort wieder den Endwert.
 * Drei Zusagen: (a) der Endwert wird IMMER erreicht - per rAF oder per Timer,
 * wer zuerst kommt; (b) reduzierte Bewegung und verdeckter Tab fassen nichts
 * an; (c) ein unveraenderter Balken ruehrt sich beim Neuzeichnen nicht.
 */
function barEl(key, value) {
  const props = new Map([['--bar-scale', value]]);
  const el = {
    dataset: { barKey: key },
    writes: [],
    offsetWidth: 100,
    style: {
      getPropertyValue: (name) => props.get(name) ?? '',
      setProperty: (name, v) => { props.set(name, String(v)); el.writes.push(String(v)); },
    },
    value: () => props.get('--bar-scale'),
  };
  return el;
}

async function withBarEnv({ reduced = false, visibility = 'visible', raf = 'never' }, fn) {
  const { growBars } = await import('../public/utils/ux.js');
  const saved = { matchMedia: global.window.matchMedia, document: global.document, raf: global.requestAnimationFrame };
  const frames = [];
  global.window.matchMedia = (q) => ({ matches: reduced && /prefers-reduced-motion/.test(q) });
  global.document = { visibilityState: visibility };
  if (raf === 'missing') delete global.requestAnimationFrame;
  else global.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  try { return await fn(growBars, frames); } finally {
    global.window.matchMedia = saved.matchMedia;
    if (saved.document === undefined) delete global.document; else global.document = saved.document;
    if (saved.raf === undefined) delete global.requestAnimationFrame; else global.requestAnimationFrame = saved.raf;
  }
}

test('growBars: startet bei 0, und der Endwert kommt auch OHNE rAF (Timer-Rueckfall)', async () => {
  await withBarEnv({ raf: 'never' }, async (growBars, frames) => {
    const a = barEl('a', '0.4000');
    const b = barEl('b', '1.0000');
    const root = { querySelectorAll: () => [a, b] };
    assert.equal(growBars(root, { selector: '.bar', memo: 'test-timer' }), 2);
    assert.equal(a.value(), '0', 'der Balken steht fuer einen Frame am Startwert');
    assert.equal(frames.length, 1, 'ein Frame ist angefragt');
    // rAF feuert NIE (verdeckter Tab nach dem Start): der Timer muss es richten.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(a.value(), '0.4000');
    assert.equal(b.value(), '1.0000');
    // Ein spaet doch noch feuernder Frame schreibt nichts Falsches mehr.
    frames[0]();
    assert.deepEqual(a.writes, ['0', '0.4000']);
  });
});

test('growBars: mit rAF setzt der Frame den Endwert, der Timer danach nichts mehr', async () => {
  await withBarEnv({ raf: 'never' }, async (growBars, frames) => {
    const a = barEl('a', '0.2500');
    growBars({ querySelectorAll: () => [a] }, { selector: '.bar', memo: 'test-raf' });
    frames[0]();
    assert.equal(a.value(), '0.2500');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(a.writes, ['0', '0.2500'], 'genau ein Zuruecksetzen, genau ein Endwert');
  });
});

test('growBars: reduzierte Bewegung, verdeckter Tab und fehlendes rAF fassen den Endwert nicht an', async () => {
  for (const env of [{ reduced: true }, { visibility: 'hidden' }, { raf: 'missing' }]) {
    await withBarEnv(env, async (growBars) => {
      const a = barEl('a', '0.7000');
      const moved = growBars({ querySelectorAll: () => [a] }, { selector: '.bar', memo: `test-still-${JSON.stringify(env)}` });
      assert.equal(moved, 0, JSON.stringify(env));
      assert.deepEqual(a.writes, [], `${JSON.stringify(env)}: der Balken bleibt am Wert aus dem Markup`);
    });
  }
  // Nichts zu tun, nichts kaputt.
  const { growBars } = await import('../public/utils/ux.js');
  assert.equal(growBars(null, { selector: '.bar', memo: 'x' }), 0);
});

test('growBars: ein unveraenderter Balken ruehrt sich beim Neuzeichnen nicht, ein geaenderter waechst vom alten Wert', async () => {
  await withBarEnv({ raf: 'never' }, async (growBars, frames) => {
    const memo = 'test-memo';
    growBars({ querySelectorAll: () => [barEl('a', '0.4000'), barEl('b', '0.6000')] }, { selector: '.bar', memo });
    frames.splice(0).forEach((cb) => cb());
    // Neuzeichnen: neue Knoten, a gleich, b geaendert, c neu.
    const a = barEl('a', '0.4000');
    const b = barEl('b', '0.9000');
    const c = barEl('c', '0.1000');
    assert.equal(growBars({ querySelectorAll: () => [a, b, c] }, { selector: '.bar', memo }), 2);
    assert.deepEqual(a.writes, [], 'gleich geblieben: keine Bewegung');
    assert.equal(b.value(), '0.6000', 'geaendert: startet am zuletzt gezeigten Wert');
    assert.equal(c.value(), '0', 'neu: startet bei 0');
    frames.splice(0).forEach((cb) => cb());
    assert.equal(b.value(), '0.9000');
    assert.equal(c.value(), '0.1000');
  });
});

/*
 * toggleRegion (R16, Bewegung): der Zustand ist `hidden`, nicht die Animation.
 * Auf faellt `hidden` sofort; zu setzt es NACH dem Einklappen - und auch dann,
 * wenn `finish` nie kommt. Ein Oeffnen, das ein Zuklappen ueberholt, gewinnt.
 */
function regionEl({ hidden = true, animates = true } = {}) {
  const el = {
    hidden,
    style: {},
    calls: [],
    cancelled: 0,
    getBoundingClientRect: () => ({ height: 120 }),
    getAnimations: () => el.calls.map(() => ({ cancel: () => { el.cancelled += 1; } })),
  };
  if (animates) el.animate = (keyframes, timing) => { el.calls.push({ keyframes, timing }); return { finished: new Promise(() => {}) }; };
  return el;
}

test('toggleRegion: auf faellt hidden sofort, zu erst nach dem Einklappen - auch ohne finish', async () => {
  const { toggleRegion } = await import('../public/utils/ux.js');
  const savedGcs = global.getComputedStyle;
  const savedDoc = global.document;
  global.getComputedStyle = () => ({ getPropertyValue: () => '', opacity: '1', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px' });
  global.document = { documentElement: {} };
  try {
    const region = regionEl({ hidden: true });
    const opening = toggleRegion(region, true);
    assert.equal(region.hidden, false, 'der Inhalt ist im selben Moment erreichbar');
    assert.equal(region.calls.length, 1, 'die Hoehe zieht auf');
    await opening;

    const closing = toggleRegion(region, false);
    assert.equal(region.hidden, false, 'solange es einklappt, steht die Region noch');
    await closing; // `finished` loest nie auf - der Timer muss es tun
    assert.equal(region.hidden, true, 'der Zustand kommt an');
    assert.ok(region.cancelled > 0, 'die gehaltene Hoehe 0 ist verworfen');

    // Zuklappen, sofort wieder oeffnen: das Oeffnen gewinnt.
    region.hidden = false;
    const late = toggleRegion(region, false);
    toggleRegion(region, true);
    await late;
    assert.equal(region.hidden, false, 'ein ueberholtes Zuklappen raeumt nicht ab');

    // Ohne animate (und damit auch unter reduzierter Bewegung): im selben Takt.
    const plain = regionEl({ hidden: false, animates: false });
    await toggleRegion(plain, false);
    assert.equal(plain.hidden, true);
    await toggleRegion(plain, true);
    assert.equal(plain.hidden, false);
    await toggleRegion(null, true);
  } finally {
    if (savedGcs === undefined) delete global.getComputedStyle; else global.getComputedStyle = savedGcs;
    if (savedDoc === undefined) delete global.document; else global.document = savedDoc;
  }
});
