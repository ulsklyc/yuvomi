import test from 'node:test';
import assert from 'node:assert/strict';
import { getPermissions, setPermissions } from '../public/permissions.js';

const { __test: calendar } = await import('../public/pages/calendar.js');

test('the default local calendar displays its saved name', () => {
  assert.equal(
    calendar.localCalendarDisplayName({ id: 1, name: 'Yuvomi', is_default: true }),
    'Yuvomi',
  );
});

test('renamed and additional calendars display their saved names', () => {
  assert.equal(
    calendar.localCalendarDisplayName({ id: 1, name: 'Renamed default', is_default: true }),
    'Renamed default',
  );
  assert.equal(
    calendar.localCalendarDisplayName({ id: 2, name: 'Work', is_default: false }),
    'Work',
  );
  assert.equal(
    calendar.localCalendarDisplayName({ id: 2, name: 'Yuvomi', is_default: false }),
    'Yuvomi',
  );
});

test('one local calendar adds neither an event name nor a destination picker', () => {
  const before = calendar.localCalendarState.localCalendars;
  const event = { local_calendar_id: 1, local_calendar_name: 'Yuvomi' };
  try {
    calendar.localCalendarState.localCalendars = [{ id: 1, name: 'Yuvomi', is_default: true }];
    assert.equal(calendar.eventLocalCalendarDisplayName(event), '');
    assert.equal(calendar.eventLocalCalendarDisplayName({ cal_name: 'External' }), 'External');
    assert.doesNotMatch(calendar.buildEventModalContent({ mode: 'create', date: '2035-05-01' }), /id="event-local-calendar"/);
    calendar.localCalendarState.localCalendars.push({ id: 2, name: 'Work' });
    assert.equal(calendar.eventLocalCalendarDisplayName(event), 'Yuvomi');
    assert.match(calendar.buildEventModalContent({ mode: 'create', date: '2035-05-01' }), /id="event-local-calendar"/);
  } finally { calendar.localCalendarState.localCalendars = before; }
});

// R24 (E6): die Zeile ist Punkt, Name und Terminzahl - ihr Hauptteil oeffnet
// das Bearbeiten-Blatt; Speichern steht im Blatt, nicht mehr in der Zeile.
test('calendar manager rows keep edit and more visible, with labelled feed and destructive actions in the menu', () => {
  const previous = getPermissions();
  try {
    for (const admin of [true, false]) {
      for (const isDefault of [true, false]) {
        for (const hasFeed of [true, false]) {
          setPermissions({ admin, modules: { calendar: 'write' } });
          const html = calendar.renderLocalCalendarRow({ id: 7, name: 'Family', color: '#336699',
            is_default: isDefault, feed_url: hasFeed ? 'http://lan/feed/calendar/token.ics' : null });
          const buttons = html.match(/<button\b[^>]*>/g) ?? [];
          const visible = buttons.filter(button => !button.includes('role="menuitem"'));
          assert.ok(visible.length <= 2, 'at most the row body and the menu remain outside the menu');
          assert.ok(visible.some(button => button.includes('js-calendar-edit')), 'the row body opens the edit sheet');
          assert.ok(!/js-calendar-save|type="color"/.test(html), 'no save button and no raw colour field in the row');
          const expected = [];
          if (admin) {
            if (hasFeed) expected.push('calendar-copy-feed', 'calendar-disable-feed');
            else expected.push('calendar-enable-feed');
          }
          if (!isDefault) expected.push('calendar-delete');
          const actions = [...html.matchAll(/role="menuitem"[^>]*data-action="([^"]+)"/g)].map(match => match[1]);
          assert.deepEqual(actions, expected);
          assert.equal(visible.some(button => button.includes('popover-menu__trigger')), expected.length > 0);
          for (const action of ['calendar-disable-feed', 'calendar-delete']) {
            const item = buttons.find(button => button.includes(`data-action="${action}"`));
            if (item) assert.ok(item.includes('popover-menu__item--danger'));
          }
          if (admin && hasFeed) assert.match(html, /<span>calendar.localCalendarCopyExport<\/span>/);
          if (!isDefault) assert.match(html, /<span>common.delete<\/span>/);
        }
      }
    }
  } finally { setPermissions(previous); }
});

test('calendar ordering menus disable boundaries and moving saves the complete order without optimistic changes', async () => {
  const before = calendar.localCalendarState.localCalendars;
  const permissions = getPermissions();
  const apiStub = globalThis.__apiStub;
  const calls = [];
  const rows = [1, 2, 3].map(id => ({ id, name: `Calendar ${id}`, color: '#336699', sort_order: 40 }));
  try {
    calendar.localCalendarState.localCalendars = rows;
    setPermissions({ admin: false, modules: { calendar: 'write' } });
    for (const [index, row] of rows.entries()) {
      const html = calendar.renderLocalCalendarRow(row);
      for (const [direction, disabled] of [['up', index === 0], ['down', index === rows.length - 1]]) {
        const button = (html.match(/<button\b[^>]*>/g) ?? []).find(tag => tag.includes(`data-action="calendar-move-${direction}"`));
        assert.ok(button);
        assert.equal(/\sdisabled(?:\s|>)/.test(button), disabled);
      }
      assert.equal((html.match(/<button\b[^>]*>/g) ?? []).filter(tag => !tag.includes('role="menuitem"')).length, 2);
    }
    globalThis.__apiStub = { patch: async (...args) => { calls.push(args); return { data: true }; } };
    assert.equal(await calendar.moveLocalCalendar(2, -1), true);
    assert.deepEqual(calls.pop(), ['/calendar/calendars/reorder', { order: [2, 1, 3] }]);
    assert.equal(await calendar.moveLocalCalendar(2, 1), true);
    assert.deepEqual(calls.pop(), ['/calendar/calendars/reorder', { order: [1, 3, 2] }]);
    assert.equal(await calendar.moveLocalCalendar(1, -1), false);
    assert.equal(await calendar.moveLocalCalendar(3, 1), false);
    assert.equal(await calendar.moveLocalCalendar(999, 1), false);
    setPermissions({ admin: false, modules: { calendar: 'read' } });
    assert.doesNotMatch(calendar.renderLocalCalendarRow(rows[1]), /calendar-move-/);
    assert.equal(await calendar.moveLocalCalendar(2, 1), false);
    assert.equal(calls.length, 0);
    setPermissions({ admin: false, modules: { calendar: 'write' } });
    globalThis.__apiStub = { patch: async () => { throw new Error('Save failed'); } };
    await assert.rejects(calendar.moveLocalCalendar(2, 1), /Save failed/);
    assert.deepEqual(calendar.localCalendarState.localCalendars, rows);
  } finally {
    calendar.localCalendarState.localCalendars = before;
    setPermissions(permissions);
    if (apiStub === undefined) delete globalThis.__apiStub;
    else globalThis.__apiStub = apiStub;
  }
});

test('copying a calendar feed works without Clipboard API and exposes the link if copying fails', async () => {
  const previous = { document: globalThis.document, window: globalThis.window,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    promptModal: globalThis.__promptModal, askOverModal: globalThis.__askOverModal };
  const copied = [], prompts = [];
  let removed = false, restoredFocus = false, modalQuestions = 0;
  let succeeds = true;
  const textarea = { style: {}, focus() {}, select() {}, remove() { removed = true; } };
  globalThis.document = { createElement: () => textarea, body: { appendChild() {} },
    activeElement: { focus() { restoredFocus = true; } }, execCommand(command) { copied.push([command, textarea.value]); return succeeds; } };
  globalThis.window = { yuvomi: { showToast() {} } };
  globalThis.__promptModal = (...args) => {
    assert.equal(removed, true, 'temporary input is removed before opening the modal');
    assert.equal(restoredFocus, true, 'focus is restored before opening the modal');
    prompts.push(args);
    return null;
  };
  globalThis.__askOverModal = (ask) => { modalQuestions++; return ask(); };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  try {
    await calendar.copyText('http://lan/feed/calendar/token.ics', 'calendar.localCalendarExportCopied');
    assert.deepEqual(copied, [['copy', 'http://lan/feed/calendar/token.ics']]);
    assert.equal(prompts.length, 0, 'successful copying does not open a modal');
    succeeds = false;
    removed = restoredFocus = false;
    await calendar.copyText('http://lan/feed/calendar/token.ics', 'calendar.localCalendarExportCopied');
    assert.deepEqual(prompts[0], ['calendar.localCalendarCopyExport', 'http://lan/feed/calendar/token.ics']);
    globalThis.document.execCommand = () => { throw new Error('Copy unavailable'); };
    removed = restoredFocus = false;
    await calendar.copyText('http://lan/feed/calendar/token.ics', 'calendar.localCalendarExportCopied');
    assert.equal(prompts[1][1], 'http://lan/feed/calendar/token.ics');
    assert.equal(modalQuestions, 2, 'fallback prompts preserve the open calendar manager');
  } finally {
    globalThis.document = previous.document; globalThis.window = previous.window;
    if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator);
    else delete globalThis.navigator;
    if (previous.promptModal === undefined) delete globalThis.__promptModal;
    else globalThis.__promptModal = previous.promptModal;
    if (previous.askOverModal === undefined) delete globalThis.__askOverModal;
    else globalThis.__askOverModal = previous.askOverModal;
  }
});

test('deleting a calendar names the iCloud upload only while the default calendar uploads', async () => {
  const previous = { document: globalThis.document, window: globalThis.window, apiStub: globalThis.__apiStub,
    confirmOverModal: globalThis.__confirmOverModal, askOverModal: globalThis.__askOverModal, calendars: calendar.localCalendarState.localCalendars };
  const permissions = getPermissions();
  const questions = [];
  const deleted = [];
  let served = [];
  const handlers = {};
  const panel = { dataset: {}, addEventListener(type, handler) { handlers[type] = handler; }, querySelector: () => null, querySelectorAll: () => [] };
  // A click on "Delete" in the row of calendar 2, as the manager's listener reads it.
  const row = { dataset: { calendarId: '2' } };
  const click = { target: { closest: (selector) => {
    if (selector === '.cal-calendar-row') return row;
    return selector === '[data-action="calendar-delete"]' ? {} : null;
  } } };
  globalThis.document = { querySelector: (selector) => (selector.includes('.modal-panel') ? panel : null),
    querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  globalThis.window = { yuvomi: { showToast() {} } };
  globalThis.__apiStub = {
    get: async () => ({ data: served }),
    delete: async (...args) => { deleted.push(args); return { data: true }; },
  };
  globalThis.__confirmOverModal = async (...args) => { questions.push(args); return false; };
  try {
    setPermissions({ admin: true, modules: { calendar: 'write' } });
    for (const [uploads, expected] of [
      [false, 'calendar.localCalendarDeleteDetail'],
      [true, 'calendar.localCalendarDeleteDetailIcloud'],
      [undefined, 'calendar.localCalendarDeleteDetail'],
    ]) {
      served = [
        { id: 1, name: 'Yuvomi', color: '#007AFF', is_default: true, uploads_to_icloud: uploads },
        { id: 2, name: 'School', color: '#336699', is_default: false, uploads_to_icloud: false },
      ];
      await calendar.openLocalCalendarsModal();
      await handlers.click(click);
      const [title, options] = questions.pop();
      assert.match(title, /^calendar.localCalendarDeleteConfirm.*School/);
      assert.equal(options.detail, expected, `default calendar uploads: ${uploads}`);
      assert.equal(options.danger, true);
    }
    assert.equal(deleted.length, 0, 'a declined confirmation deletes nothing');
  } finally {
    calendar.localCalendarState.localCalendars = previous.calendars;
    setPermissions(permissions);
    globalThis.document = previous.document; globalThis.window = previous.window;
    if (previous.apiStub === undefined) delete globalThis.__apiStub; else globalThis.__apiStub = previous.apiStub;
    if (previous.confirmOverModal === undefined) delete globalThis.__confirmOverModal;
    else globalThis.__confirmOverModal = previous.confirmOverModal;
    if (previous.askOverModal === undefined) delete globalThis.__askOverModal;
    else globalThis.__askOverModal = previous.askOverModal;
  }
});

// #1909: die Verwaltung sagt den Satz der App, nie den des Servers. Ein Fehler
// wie ihn api.js wirft: Status, Rumpf mit dem (hier deutschen) Servertext.
function apiError(status, body) {
  return Object.assign(new Error(body.error), { name: 'ApiError', status, data: body });
}

async function withManager(api, run) {
  const previous = { document: globalThis.document, window: globalThis.window, apiStub: globalThis.__apiStub,
    confirmOverModal: globalThis.__confirmOverModal, askOverModal: globalThis.__askOverModal, calendars: calendar.localCalendarState.localCalendars };
  const permissions = getPermissions();
  const toasts = [];
  const handlers = {};
  const gets = [];
  const panel = { dataset: {}, addEventListener(type, handler) { handlers[type] = handler; }, querySelector: () => null, querySelectorAll: () => [] };
  globalThis.document = { querySelector: (selector) => (selector.includes('.modal-panel') ? panel : null),
    querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  globalThis.window = { yuvomi: { showToast(message, type) { toasts.push([message, type]); } } };
  const served = [
    { id: 1, name: 'Yuvomi', color: '#007AFF', is_default: true },
    { id: 2, name: 'School', color: '#336699', is_default: false },
  ];
  globalThis.__apiStub = { get: async (...args) => { gets.push(args); return { data: served }; }, ...api };
  globalThis.__confirmOverModal = async () => true;
  // Seit R24 (E6) fragen Anlegen und Bearbeiten im Blatt ueber der Verwaltung
  // (askOverModal); hier antwortet das Blatt mit einem gueltigen Namen.
  let sheetAnswer = null;
  globalThis.__askOverModal = async () => sheetAnswer;
  calendar.setContainerForTest({ querySelector: () => null, querySelectorAll: () => [] });
  try {
    setPermissions({ admin: false, modules: { calendar: 'write' } });
    await calendar.openLocalCalendarsModal();
    gets.length = 0;
    const click = (action) => {
      if (action === 'save') sheetAnswer = { name: 'School 2', color: '#336699' };
      return handlers.click({ target: { closest: (selector) => {
        if (selector === '.cal-calendar-row') return { dataset: { calendarId: '2' } };
        if (action === 'save') return selector === '.js-calendar-edit' ? {} : null;
        return selector.split(',').map(part => part.trim()).includes(`[data-action="${action}"]`) ? {} : null;
      } } });
    };
    // Anlegen: „+ Kalender" oeffnet das Blatt, das mit Name und Farbe antwortet.
    const submit = () => {
      sheetAnswer = { name: 'Work', color: '#112233' };
      return handlers.click({ target: { closest: (selector) => (selector === '.js-calendar-add' ? {} : null) } });
    };
    await run({ click, submit, toasts, gets });
  } finally {
    calendar.localCalendarState.localCalendars = previous.calendars;
    setPermissions(permissions);
    calendar.setContainerForTest(null);
    globalThis.document = previous.document; globalThis.window = previous.window;
    if (previous.apiStub === undefined) delete globalThis.__apiStub; else globalThis.__apiStub = previous.apiStub;
    if (previous.confirmOverModal === undefined) delete globalThis.__confirmOverModal;
    else globalThis.__confirmOverModal = previous.confirmOverModal;
    if (previous.askOverModal === undefined) delete globalThis.__askOverModal;
    else globalThis.__askOverModal = previous.askOverModal;
  }
}

const GONE = apiError(404, { error: 'Kalender nicht gefunden', code: 404, reason: 'calendar_calendar_not_found' });

test('a calendar that is gone says the app sentence and reloads the manager (#1909)', async () => {
  for (const [action, api] of [
    ['save', { put: async () => { throw GONE; } }],
    ['calendar-enable-feed', { post: async () => { throw GONE; } }],
  ]) {
    await withManager(api, async ({ click, toasts, gets }) => {
      await click(action);
      assert.deepEqual(toasts, [['calendar.errorCalendarGone', 'danger']], action);
      assert.equal(gets.length, 1, `${action}: the manager reloads itself`);
    });
  }
});

test('deleting a calendar that is already gone is a success (#1909)', async () => {
  await withManager({ delete: async () => { throw GONE; } }, async ({ click, toasts, gets }) => {
    await click('calendar-delete');
    assert.deepEqual(toasts, [['calendar.localCalendarDeleted', 'success']]);
    assert.equal(gets.length, 1);
  });
});

test('the manager names an invalid name, a changed order and an export only an admin may delete (#1909)', async () => {
  const invalid = apiError(400, { error: 'Name: Gib einen Namen mit höchstens 80 Zeichen ein.', code: 400,
    reason: 'calendar_name_invalid', params: { limit: 80 } });
  await withManager({ post: async () => { throw invalid; }, put: async () => { throw invalid; } }, async ({ click, submit, toasts }) => {
    await submit();
    await click('save');
    assert.deepEqual(toasts, [
      ['calendar.errorCalendarNameInvalid{"limit":80}', 'danger'],
      ['calendar.errorCalendarNameInvalid{"limit":80}', 'danger'],
    ]);
  });
  const changed = apiError(400, { error: 'Reihenfolge: Gib jeden Kalender genau einmal an.', code: 400, reason: 'calendar_order_changed' });
  await withManager({ patch: async () => { throw changed; } }, async ({ click, toasts, gets }) => {
    await click('calendar-move-up');
    assert.deepEqual(toasts, [['calendar.errorCalendarOrderChanged', 'danger']]);
    assert.equal(gets.length, 1, 'the manager shows the current order');
  });
  const refused = apiError(403, { error: 'Admin access required.', code: 403, reason: 'calendar_feed_admin_only' });
  await withManager({ delete: async () => { throw refused; } }, async ({ click, toasts }) => {
    await click('calendar-delete');
    assert.deepEqual(toasts, [['calendar.errorDeleteFeedAdminOnly', 'danger']]);
  });
  // Ein Fall ohne eigenen Satz: der allgemeine der Stelle, nie der Servertext.
  const unknown = apiError(400, { error: 'Farbe: Gib eine gültige Hex-Farbe an.', code: 400 });
  await withManager({ post: async () => { throw unknown; }, put: async () => { throw unknown; } }, async ({ click, submit, toasts }) => {
    await submit();
    await click('save');
    assert.deepEqual(toasts, [['calendar.saveError', 'danger'], ['calendar.saveError', 'danger']]);
  });
});

test('renaming a calendar has the same length limit as creating one (#1909)', async () => {
  // Seit R24 (E6) benennt EIN Blatt beim Anlegen und Bearbeiten - mit einem Feld.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const sheet = src.slice(src.indexOf('function localCalendarSheet('), src.indexOf('\n}\n', src.indexOf('function localCalendarSheet(')));
  assert.match(sheet, /<input class="form-input" id="local-calendar-name" maxlength="80" required/);
  assert.match(src, /askOverModal\(\(\) => localCalendarSheet\(\)\)/, 'Anlegen nimmt dasselbe Blatt');
  assert.match(src, /askOverModal\(\(\) => localCalendarSheet\(calendar\)\)/, 'Umbenennen ebenso');
});

// #1909, Termine: Speichern, Zuruecksetzen und Loeschen sagen den Satz der App,
// nie den Text des Servers (hier der deutsche von vor #1909).
test('saving an event says the app sentence, never the server text (#1909)', () => {
  const cases = [
    [apiError(404, { error: 'Termin nicht gefunden', code: 404, reason: 'calendar_event_not_found' }), 'calendar.errorEventGone'],
    [apiError(404, { error: 'Terminserie nicht gefunden. Lade den Kalender erneut.', code: 404, reason: 'calendar_series_not_found' }), 'calendar.errorEventGone'],
    [apiError(400, { error: 'Kalender: Dieser Kalender existiert nicht mehr.', code: 400, reason: 'calendar_selected_calendar_not_found' }), 'calendar.errorSelectedCalendarGone'],
    [apiError(400, { error: 'recurrence_rule: the rule has no occurrence on or after the start date.', code: 400, reason: 'calendar_series_no_occurrence' }), 'calendar.errorSeriesNoOccurrence'],
    [apiError(400, { error: 'Die Folgeserie enthält ab ihrem Startdatum keinen Termin.', code: 400, reason: 'empty_successor_series' }), 'calendar.errorSeriesNoOccurrence'],
    [apiError(400, { error: 'recurrence_rule: the series ends before the start date.', code: 400, reason: 'calendar_series_ends_before_start' }), 'calendar.recurrenceEndBeforeStart'],
    // Ohne eigenen Satz: der allgemeine der Stelle.
    [apiError(400, { error: 'Titel: Gib einen gültigen Text ein.', code: 400 }), 'calendar.saveError'],
    [apiError(400, { error: 'Die Einzelausnahme konnte nicht geändert werden.', code: 400, reason: 'invalid_override_fields' }), 'calendar.saveError'],
  ];
  for (const [err, key] of cases) assert.equal(calendar.calendarSaveErrorMessage(err), key, err.data.error);
});

test('an event that is gone counts as deleted, every other failure stays one (#1909)', async () => {
  const gone = apiError(404, { error: 'Termin nicht gefunden', code: 404, reason: 'calendar_event_not_found' });
  const seriesGone = apiError(404, { error: 'Calendar series not found.', code: 404, reason: 'calendar_series_not_found' });
  for (const err of [gone, seriesGone]) {
    assert.equal(calendar.eventGone(err), true);
    await calendar.deleteUnlessGone(async () => { throw err; });
  }
  const others = [
    apiError(403, { error: 'Nope', code: 403, reason: 'calendar_event_not_found' }),
    apiError(404, { error: 'Not found', code: 404 }),
    apiError(400, { error: 'x', code: 400, reason: 'calendar_selected_calendar_not_found' }),
    apiError(400, { error: 'x', code: 400, reason: 'invalid_recurrence_id' }),
  ];
  for (const err of others) {
    assert.equal(calendar.eventGone(err), false, JSON.stringify(err.data));
    await assert.rejects(calendar.deleteUnlessGone(async () => { throw err; }), err);
  }
  // Der Satz eines gescheiterten Loeschens.
  assert.equal(calendar.occurrenceErrorMessage(seriesGone), 'calendar.errorEventGone');
  assert.equal(calendar.occurrenceErrorMessage(others[3]), 'calendar.occurrenceGoneError');
  assert.equal(calendar.occurrenceErrorMessage(others[1]), null);
});

test('the three event delete paths: gone is done, any other failure says the app sentence (#1909)', async () => {
  const previous = { window: globalThis.window, apiStub: globalThis.__apiStub, undoStub: globalThis.__undoStub,
    events: calendar.localCalendarState.events };
  const toasts = [];
  let expire = null;
  globalThis.window = { yuvomi: { showToast(message, type) { toasts.push([message, type]); } } };
  // Der Undo-Toast (utils/ux.js, im Loader ersetzt): sein Ablauf schreibt.
  globalThis.__undoStub = ({ commit, restore }) => {
    expire = async () => { try { await commit({ keepalive: false }); } catch (err) { restore(err); } };
  };
  calendar.setContainerForTest({ isConnected: false, querySelector: () => null, querySelectorAll: () => [] });
  const single = { id: 41, title: 'Arzt', start_datetime: '2035-05-02T09:00', visibility: 'all' };
  const occurrence = { id: 42, series_id: 42, title: 'Turnen', start_datetime: '2035-05-02T09:00',
    recurrence_id: '2035-05-02T09:00:00', recurrence_rule: 'FREQ=WEEKLY', can_override_occurrence: true, visibility: 'all' };
  const GONE = apiError(404, { error: 'Termin nicht gefunden', code: 404, reason: 'calendar_event_not_found' });
  const SERIES_GONE = apiError(404, { error: 'Terminserie nicht gefunden.', code: 404, reason: 'calendar_series_not_found' });
  const OTHER = apiError(400, { error: 'Der Termin konnte nicht gelöscht werden.', code: 400 });
  try {
    for (const [label, run, event, err] of [
      ['deleteEvent', calendar.deleteEvent, single, GONE],
      ['deleteThisAndFollowing', calendar.deleteThisAndFollowing, occurrence, SERIES_GONE],
      ['deleteSingleOccurrence', calendar.deleteSingleOccurrence, occurrence, SERIES_GONE],
    ]) {
      for (const [thrown, expected] of [[err, []], [OTHER, [['calendar.deleteError', 'danger']]]]) {
        toasts.length = 0;
        expire = null;
        calendar.localCalendarState.events = [{ ...event }];
        globalThis.__apiStub = {
          delete: async () => { throw thrown; },
          post: async () => { throw thrown; },
          put: async () => { throw thrown; },
          get: async () => ({ data: [] }),
        };
        await run(event);
        assert.equal(typeof expire, 'function', `${label}: the undo toast holds the delete`);
        await expire();
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(toasts, expected, `${label}: ${thrown.data.error}`);
        assert.equal(calendar.localCalendarState.events.length, thrown === OTHER ? 1 : 0,
          `${label}: ${thrown === OTHER ? 'a failed delete brings the event back' : 'a gone event stays gone'}`);
      }
    }
  } finally {
    calendar.localCalendarState.events = previous.events;
    calendar.setContainerForTest(null);
    globalThis.window = previous.window;
    if (previous.apiStub === undefined) delete globalThis.__apiStub; else globalThis.__apiStub = previous.apiStub;
    if (previous.undoStub === undefined) delete globalThis.__undoStub; else globalThis.__undoStub = previous.undoStub;
  }
});

// #1927: die Hilfezeile unter der Kalenderwahl nennt den iCloud-Upload, sobald
// der gewaehlte Kalender hochlaedt - ohne Rueckfrage beim Speichern und ohne
// Zeile, solange keiner hochlaedt.
test('the event form names the iCloud upload under the calendar picker while the chosen calendar uploads', () => {
  const before = calendar.localCalendarState.localCalendars;
  const fakeSelect = () => {
    const attrs = {};
    return { value: '', setAttribute(name, value) { attrs[name] = value; }, removeAttribute(name) { delete attrs[name]; }, attrs };
  };
  try {
    for (const uploads of [true, false, undefined]) {
      calendar.localCalendarState.localCalendars = [
        { id: 1, name: 'Yuvomi', is_default: true, uploads_to_icloud: uploads },
        { id: 2, name: 'School', is_default: false, uploads_to_icloud: false },
      ];
      const html = calendar.buildEventModalContent({ mode: 'create', date: '2035-05-01' });
      assert.match(html, /id="event-local-calendar-upload-hint" hidden>calendar\.localCalendarUploadsHint</,
        'the line is part of the picker and starts hidden');

      const select = fakeSelect();
      const hint = { id: 'event-local-calendar-upload-hint', hidden: true };
      const panel = { querySelector: (sel) => (sel === '#event-local-calendar' ? select
        : sel === '#event-local-calendar-upload-hint' ? hint : null) };

      select.value = '1';
      calendar.syncLocalCalendarUploadHint(panel);
      assert.equal(hint.hidden, uploads !== true, `default calendar, uploads: ${uploads}`);
      assert.equal(select.attrs['aria-describedby'], uploads === true ? hint.id : undefined);

      select.value = '2';
      calendar.syncLocalCalendarUploadHint(panel);
      assert.equal(hint.hidden, true, 'a calendar that stays local shows no line');
      assert.equal(select.attrs['aria-describedby'], undefined);
    }
  } finally { calendar.localCalendarState.localCalendars = before; }
});

// #1927, Folge: auch ohne Kalenderwahl (ein einziger lokaler Kalender) nennt
// das Formular den iCloud-Upload - ruhig unter dem Zeitblock, derselbe Satz.
// Waehlt der Termin ein Google- oder CalDAV-Ziel, landet er nicht im lokalen
// Kalender, und die Zeile geht.
test('with a single local calendar the event form names the iCloud upload under the time block', () => {
  const before = calendar.localCalendarState.localCalendars;
  const fakeEl = (value = '') => {
    const attrs = {};
    return { value, hidden: true, id: '', setAttribute(n, v) { attrs[n] = v; }, removeAttribute(n) { delete attrs[n]; }, attrs };
  };
  try {
    for (const uploads of [true, false]) {
      calendar.localCalendarState.localCalendars = [{ id: 1, name: 'Yuvomi', is_default: true, uploads_to_icloud: uploads }];
      const html = calendar.buildEventModalContent({ mode: 'create', date: '2035-05-01' });
      assert.doesNotMatch(html, /id="event-local-calendar"/, 'no picker with one calendar');
      const hintAt = html.indexOf('id="event-local-calendar-upload-hint"');
      assert.ok(hintAt > html.indexOf('id="allday-fields"'), 'the line sits under the time block');
      assert.match(html, /id="event-local-calendar-upload-hint" hidden>calendar\.localCalendarUploadsHint</);

      const hint = { ...fakeEl(), id: 'event-local-calendar-upload-hint' };
      const syncTarget = fakeEl('');
      const panel = { querySelector: (sel) => (sel === '#event-local-calendar-upload-hint' ? hint
        : sel === '#event-sync-target' ? syncTarget : null) };
      calendar.syncLocalCalendarUploadHint(panel);
      assert.equal(hint.hidden, !uploads, `uploads: ${uploads}`);

      syncTarget.value = 'caldav:4|https://dav.example.org/cal/family/';
      calendar.syncLocalCalendarUploadHint(panel);
      assert.equal(hint.hidden, true, 'an event with a CalDAV target does not go to iCloud');
      syncTarget.value = 'google:family@group.calendar.google.com';
      calendar.syncLocalCalendarUploadHint(panel);
      assert.equal(hint.hidden, true, 'nor one with a Google target');
    }

    // Ein schon zu einem anderen Anbieter gespiegelter Termin bekommt die Zeile nicht.
    calendar.localCalendarState.localCalendars = [{ id: 1, name: 'Yuvomi', is_default: true, uploads_to_icloud: true }];
    const mirrored = calendar.buildEventModalContent({ mode: 'edit', event: {
      id: 3, title: 'Termin', start_datetime: '2035-05-01T10:00', end_datetime: '2035-05-01T11:00',
      external_source: 'apple', assigned_users: [],
    } });
    assert.doesNotMatch(mirrored, /id="event-local-calendar-upload-hint"/);
  } finally { calendar.localCalendarState.localCalendars = before; }
});
