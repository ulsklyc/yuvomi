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

test('calendar manager rows keep save and more visible, with labelled feed and destructive actions in the menu', () => {
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
          assert.ok(visible.length <= 2, 'at most two icon actions remain outside the menu');
          assert.ok(visible.some(button => button.includes('js-calendar-save')));
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
    confirmOverModal: globalThis.__confirmOverModal, calendars: calendar.localCalendarState.localCalendars };
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
  }
});
