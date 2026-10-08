import test from 'node:test';
import assert from 'node:assert/strict';

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

test('copying a calendar feed works without Clipboard API and exposes the link if copying fails', async () => {
  const previous = { document: globalThis.document, window: globalThis.window,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  const copied = [], prompts = [];
  let succeeds = true;
  const textarea = { style: {}, focus() {}, select() {}, remove() {} };
  globalThis.document = { createElement: () => textarea, body: { appendChild() {} },
    activeElement: { focus() {} }, execCommand(command) { copied.push([command, textarea.value]); return succeeds; } };
  globalThis.window = { yuvomi: { showToast() {} }, prompt: (...args) => prompts.push(args) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  try {
    await calendar.copyText('http://lan/feed/calendar/token.ics', 'calendar.localCalendarExportCopied');
    assert.deepEqual(copied, [['copy', 'http://lan/feed/calendar/token.ics']]);
    succeeds = false;
    await calendar.copyText('http://lan/feed/calendar/token.ics', 'calendar.localCalendarExportCopied');
    assert.equal(prompts[0][1], 'http://lan/feed/calendar/token.ics');
    globalThis.document.execCommand = () => { throw new Error('Copy unavailable'); };
    await calendar.copyText('http://lan/feed/calendar/token.ics', 'calendar.localCalendarExportCopied');
    assert.equal(prompts[1][1], 'http://lan/feed/calendar/token.ics');
  } finally {
    globalThis.document = previous.document; globalThis.window = previous.window;
    if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator);
    else delete globalThis.navigator;
  }
});
