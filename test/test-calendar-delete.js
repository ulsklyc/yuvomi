/**
 * Test: Undo orchestration for calendar deletion.
 * Purpose: keep pending event removals authoritative across range reloads.
 * Run: npm run test:calendar
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyPendingCalendarDeleteOverlay,
  beginOptimisticCalendarDelete,
  createCalendarLoadCoordinator,
  scheduleCalendarDeleteWithUndo,
} from '../public/utils/calendar-delete.js';

function makeState() {
  return {
    events: [
      { id: 7, title: 'January', start_datetime: '2027-01-29T18:00:00' },
      { id: 7, title: 'February', start_datetime: '2027-02-28T18:00:00' },
      { id: 8, title: 'Independent', start_datetime: '2027-02-15T09:00:00' },
    ],
  };
}

function makeMovedLinkedState(suffix = '') {
  return {
    events: [
      {
        id: 7,
        series_id: 7,
        recurrence_id: '2027-05-01',
        title: `May${suffix}`,
        start_datetime: '2027-05-01T18:00:00',
      },
      {
        id: 7,
        series_id: 7,
        recurrence_id: '2027-07-01',
        title: `July${suffix}`,
        start_datetime: '2027-07-01T18:00:00',
      },
      {
        id: 99,
        series_id: 7,
        recurrence_id: '2027-06-01',
        title: `Moved June child${suffix}`,
        start_datetime: '2027-08-02T18:00:00',
      },
      {
        id: 8,
        title: `Independent${suffix}`,
        start_datetime: '2027-06-15T09:00:00',
      },
    ],
  };
}

test('whole-event transition hides every expanded occurrence and Undo restores canonical order', () => {
  const state = makeState();
  const transition = beginOptimisticCalendarDelete(state, {
    eventId: 7,
    scope: 'all',
  });

  assert.deepEqual(state.events.map(({ id }) => id), [8]);
  assert.equal(transition.restore(), true);
  assert.deepEqual(state.events.map(({ title }) => title), [
    'January',
    'February',
    'Independent',
  ]);
});

test('whole-series delete from a moved child overlays every series row across reload and Undo', () => {
  const state = makeMovedLinkedState();
  const transition = beginOptimisticCalendarDelete(state, {
    eventId: 99,
    seriesId: 7,
    scope: 'all',
  });

  assert.deepEqual(state.events.map(({ title }) => title), ['Independent']);

  state.events = makeMovedLinkedState(' fresh').events;
  applyPendingCalendarDeleteOverlay(state, { freshEvents: true });
  assert.deepEqual(state.events.map(({ title }) => title), ['Independent fresh']);

  assert.equal(transition.restore(), true);
  assert.deepEqual(state.events.map(({ title }) => title), [
    'May fresh',
    'July fresh',
    'Moved June child fresh',
    'Independent fresh',
  ]);
});

test('following delete from a moved child overlays by original slot across reload and Undo', () => {
  const state = makeMovedLinkedState();
  const transition = beginOptimisticCalendarDelete(state, {
    eventId: 99,
    seriesId: 7,
    scope: 'following',
    occurrenceDate: '2027-08-02',
    recurrenceId: '2027-06-01',
  });

  assert.deepEqual(state.events.map(({ title }) => title), ['May', 'Independent']);

  state.events = makeMovedLinkedState(' fresh').events;
  applyPendingCalendarDeleteOverlay(state, { freshEvents: true });
  assert.deepEqual(state.events.map(({ title }) => title), ['May fresh', 'Independent fresh']);

  assert.equal(transition.restore(), true);
  assert.deepEqual(state.events.map(({ title }) => title), [
    'May fresh',
    'July fresh',
    'Moved June child fresh',
    'Independent fresh',
  ]);
});

test('single-occurrence transition hides only the selected recurrence date', () => {
  const state = makeState();
  beginOptimisticCalendarDelete(state, {
    eventId: 7,
    scope: 'this',
    occurrenceDate: '2027-01-29',
  });

  assert.deepEqual(state.events.map(({ title }) => title), [
    'February',
    'Independent',
  ]);
});

test('this-and-following transition keeps earlier occurrences visible', () => {
  const state = makeState();
  beginOptimisticCalendarDelete(state, {
    eventId: 7,
    scope: 'following',
    occurrenceDate: '2027-02-01',
  });

  assert.deepEqual(state.events.map(({ title }) => title), [
    'January',
    'Independent',
  ]);
});

test('a range reload stays hidden and Undo restores its fresh row exactly once', () => {
  const state = makeState();
  const transition = beginOptimisticCalendarDelete(state, {
    eventId: 7,
    scope: 'this',
    occurrenceDate: '2027-01-29',
  });

  state.events = [
    { id: 8, title: 'Independent', start_datetime: '2027-02-15T09:00:00' },
    { id: 7, title: 'January from reload', start_datetime: '2027-01-29T18:00:00' },
    { id: 7, title: 'February', start_datetime: '2027-02-28T18:00:00' },
  ];
  applyPendingCalendarDeleteOverlay(state, { freshEvents: true });

  assert.deepEqual(state.events.map(({ title }) => title), ['Independent', 'February']);
  assert.equal(transition.restore(), true);
  assert.deepEqual(state.events.map(({ title }) => title), [
    'Independent',
    'January from reload',
    'February',
  ]);
  assert.equal(
    state.events.filter(({ start_datetime }) => start_datetime === '2027-01-29T18:00:00').length,
    1,
  );
});

test('Undo deduplicates an occurrence already present in the visible snapshot', () => {
  const state = makeState();
  const transition = beginOptimisticCalendarDelete(state, {
    eventId: 7,
    scope: 'this',
    occurrenceDate: '2027-01-29',
  });

  state.events.push({
    id: 7,
    title: 'January already reloaded',
    start_datetime: '2027-01-29T18:00:00',
  });
  transition.restore();

  assert.equal(
    state.events.filter(({ start_datetime }) => start_datetime === '2027-01-29T18:00:00').length,
    1,
  );
  assert.equal(
    state.events.find(({ start_datetime }) => start_datetime === '2027-01-29T18:00:00').title,
    'January already reloaded',
  );
});

test('a stale pre-delete range response cannot overwrite the post-commit reload', async () => {
  const loads = createCalendarLoadCoordinator();
  const state = {
    events: [],
    tasks: ['new task'],
    holidays: ['new holiday'],
    rangeFrom: '2027-02-01',
    rangeTo: '2027-02-28',
  };
  let resolveStale;
  let resolveFresh;

  const stale = loads.run(
    () => new Promise((resolve) => { resolveStale = resolve; }),
    { apply: (snapshot) => { Object.assign(state, snapshot); } },
  );
  const fresh = loads.run(
    () => new Promise((resolve) => { resolveFresh = resolve; }),
    { apply: (snapshot) => { Object.assign(state, snapshot); } },
  );

  resolveFresh({
    events: [],
    tasks: ['new task'],
    holidays: ['new holiday'],
    rangeFrom: '2027-02-01',
    rangeTo: '2027-02-28',
  });
  assert.equal(await fresh, true);
  resolveStale({
    events: [{ id: 7, start_datetime: '2027-01-29T18:00:00' }],
    tasks: ['old task'],
    holidays: ['old holiday'],
    rangeFrom: '2027-01-01',
    rangeTo: '2027-01-31',
  });
  assert.equal(await stale, false);
  assert.deepEqual(state, {
    events: [],
    tasks: ['new task'],
    holidays: ['new holiday'],
    rangeFrom: '2027-02-01',
    rangeTo: '2027-02-28',
  });
});

test('successful delayed delete settles the overlay then reloads the active range', async () => {
  const state = makeState();
  let scheduled;
  let requestedKeepalive = null;
  let reloads = 0;
  let renders = 0;

  scheduleCalendarDeleteWithUndo({
    state,
    deleteScope: { eventId: 7, scope: 'this', occurrenceDate: '2027-01-29' },
    message: 'Deleted',
    schedule: (options) => { scheduled = options; },
    requestDelete: async ({ keepalive }) => { requestedKeepalive = keepalive; },
    isViewActive: () => true,
    reloadEvents: async () => { reloads += 1; },
    handleError: () => {},
    render: () => { renders += 1; },
  });

  assert.deepEqual(state.events.map(({ title }) => title), ['February', 'Independent']);
  assert.equal(renders, 1);
  assert.equal(scheduled.restoreOnKeepaliveError, true);

  await scheduled.commit({ keepalive: false });

  assert.equal(requestedKeepalive, false);
  assert.equal(reloads, 1);
  assert.equal(renders, 2);
});

test('scheduler Undo after a range reload restores one row and never calls the API', () => {
  const state = makeState();
  let scheduled;
  let requests = 0;
  scheduleCalendarDeleteWithUndo({
    state,
    deleteScope: { eventId: 7, scope: 'this', occurrenceDate: '2027-01-29' },
    message: 'Deleted',
    schedule: (options) => { scheduled = options; },
    requestDelete: async () => { requests += 1; },
    isViewActive: () => true,
    reloadEvents: async () => {},
    handleError: () => {},
    render: () => {},
  });

  state.events = makeState().events;
  applyPendingCalendarDeleteOverlay(state, { freshEvents: true });
  scheduled.restore();

  assert.equal(requests, 0);
  assert.equal(state.events.length, 3);
  assert.equal(
    state.events.filter(({ start_datetime }) => start_datetime === '2027-01-29T18:00:00').length,
    1,
  );
});

test('failed delayed delete restores the latest range state and reports the same error', async () => {
  const state = makeState();
  let scheduled;
  let handled = null;
  const failure = new Error('offline');
  scheduleCalendarDeleteWithUndo({
    state,
    deleteScope: { eventId: 7, scope: 'following', occurrenceDate: '2027-02-01' },
    message: 'Deleted',
    schedule: (options) => { scheduled = options; },
    requestDelete: async () => { throw failure; },
    isViewActive: () => true,
    reloadEvents: async () => {},
    handleError: (err) => { handled = err; },
    render: () => {},
  });

  await assert.rejects(() => scheduled.commit({ keepalive: false }), failure);
  scheduled.restore(failure);

  assert.deepEqual(state.events.map(({ title }) => title), [
    'January',
    'February',
    'Independent',
  ]);
  assert.equal(handled, failure);
});

test('pagehide commit keeps the inactive view untouched and forwards keepalive', async () => {
  const state = makeState();
  let scheduled;
  let keepaliveReceived = null;
  let reloads = 0;
  scheduleCalendarDeleteWithUndo({
    state,
    deleteScope: { eventId: 7, scope: 'all' },
    message: 'Deleted',
    schedule: (options) => { scheduled = options; },
    requestDelete: async ({ keepalive }) => { keepaliveReceived = keepalive; },
    isViewActive: () => false,
    reloadEvents: async () => { reloads += 1; },
    handleError: () => {},
    render: () => {},
  });

  await scheduled.commit({ keepalive: true });

  assert.equal(keepaliveReceived, true);
  assert.equal(reloads, 0);
  assert.deepEqual(state.events.map(({ id }) => id), [8]);
});

test('two pending removals remain independent when one is undone', () => {
  const state = makeState();
  const january = beginOptimisticCalendarDelete(state, {
    eventId: 7,
    scope: 'this',
    occurrenceDate: '2027-01-29',
  });
  const independent = beginOptimisticCalendarDelete(state, {
    eventId: 8,
    scope: 'all',
  });

  january.restore();
  assert.deepEqual(state.events.map(({ title }) => title), ['January', 'February']);
  independent.restore();
  assert.deepEqual(state.events.map(({ title }) => title), [
    'January',
    'February',
    'Independent',
  ]);
});

test('overlapping occurrence and whole-series deletes restore in either Undo order', () => {
  for (const undoOccurrenceFirst of [true, false]) {
    const state = makeState();
    const occurrence = beginOptimisticCalendarDelete(state, {
      eventId: 7,
      scope: 'this',
      occurrenceDate: '2027-01-29',
    });
    const series = beginOptimisticCalendarDelete(state, {
      eventId: 7,
      scope: 'all',
    });

    if (undoOccurrenceFirst) {
      occurrence.restore();
      series.restore();
    } else {
      series.restore();
      occurrence.restore();
    }
    assert.deepEqual(state.events.map(({ title }) => title), [
      'January',
      'February',
      'Independent',
    ]);
  }
});

test('overlapping occurrence and following deletes restore in either Undo order', () => {
  for (const undoOccurrenceFirst of [true, false]) {
    const state = makeState();
    const occurrence = beginOptimisticCalendarDelete(state, {
      eventId: 7,
      scope: 'this',
      occurrenceDate: '2027-01-29',
    });
    const following = beginOptimisticCalendarDelete(state, {
      eventId: 7,
      scope: 'following',
      occurrenceDate: '2027-01-01',
    });

    if (undoOccurrenceFirst) {
      occurrence.restore();
      following.restore();
    } else {
      following.restore();
      occurrence.restore();
    }
    assert.deepEqual(state.events.map(({ title }) => title), [
      'January',
      'February',
      'Independent',
    ]);
  }
});

test('a committed overlapping delete cannot be resurrected by another Undo', () => {
  for (const commitOccurrenceFirst of [true, false]) {
    const state = makeState();
    const occurrence = beginOptimisticCalendarDelete(state, {
      eventId: 7,
      scope: 'this',
      occurrenceDate: '2027-01-29',
    });
    const series = beginOptimisticCalendarDelete(state, {
      eventId: 7,
      scope: 'all',
    });

    if (commitOccurrenceFirst) {
      occurrence.commit();
      series.restore();
      assert.deepEqual(state.events.map(({ title }) => title), [
        'February',
        'Independent',
      ]);
    } else {
      series.commit();
      occurrence.restore();
      assert.deepEqual(state.events.map(({ title }) => title), ['Independent']);
    }
  }
});

test('calendar page guards the complete range', () => {
  const calendarPageSource = readFileSync(
    new URL('../public/pages/calendar.js', import.meta.url),
    'utf8',
  );
  function functionIndex(name, from = 0) {
    const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
      .exec(calendarPageSource.slice(from));
    return match ? from + match.index : -1;
  }
  function functionSource(name, nextName = null) {
    const start = functionIndex(name);
    const end = nextName ? functionIndex(nextName, start + 1) : calendarPageSource.length;
    assert.notEqual(start, -1, `${name} must exist`);
    if (nextName) assert.notEqual(end, -1, `${nextName} must follow ${name}`);
    return calendarPageSource.slice(start, end);
  }

  const loadRange = functionSource('loadRange', 'openTaskFromCalendar');
  assert.match(loadRange, /calendarLoads\.run/);
  assert.match(loadRange, /isCurrent:/);
  assert.match(loadRange, /state\.rangeFrom\s*=\s*from/);
  assert.match(loadRange, /applyPendingCalendarDeleteOverlay/);

  const reloadForView = functionSource('reloadForView');
  assert.match(reloadForView, /calendarLoads\.invalidate\(\)/);
});

test('latest response applier ignores an obsolete request failure', async () => {
  const loads = createCalendarLoadCoordinator();
  let rejectStale;
  const handled = [];
  const stale = loads.run(
    () => new Promise((resolve, reject) => { rejectStale = reject; }),
    {
      apply: () => { throw new Error('stale response must not apply'); },
      applyError: (err) => { handled.push(err.message); },
    },
  );
  assert.equal(await loads.run(async () => [], { apply: () => {} }), true);
  rejectStale(new Error('old request failed'));
  assert.equal(await stale, false);
  assert.deepEqual(handled, []);
});

test('latest response applier applies the current request failure exactly once', async () => {
  const loads = createCalendarLoadCoordinator();
  const handled = [];
  const failure = new Error('current request failed');

  assert.equal(await loads.run(
    async () => { throw failure; },
    {
      apply: () => { throw new Error('failed response must not apply as success'); },
      applyError: (err) => { handled.push(err); },
    },
  ), true);
  assert.deepEqual(handled, [failure]);
});

test('returning to a cached range invalidates the range request just left', async () => {
  const loads = createCalendarLoadCoordinator();
  const january = {
    events: ['January event'], tasks: ['January task'], holidays: ['January holiday'],
    scheduleEntries: ['January shift'], scheduleWarnings: ['January warning'],
    offlineSince: 'January cache', loadError: null,
    rangeFrom: '2027-01-01', rangeTo: '2027-01-31',
  };
  const state = { ...january };
  let desiredRange = 'February';
  let resolveFebruary;
  const february = loads.run(
    () => new Promise((resolve) => { resolveFebruary = resolve; }),
    {
      isCurrent: () => desiredRange === 'February',
      apply: (snapshot) => { Object.assign(state, snapshot); },
      applyError: (err) => { state.loadError = err; },
    },
  );

  desiredRange = 'January';
  loads.invalidate();
  resolveFebruary({
    events: ['February event'], tasks: ['February task'], holidays: ['February holiday'],
    scheduleEntries: ['February shift'], scheduleWarnings: ['February warning'],
    offlineSince: null, loadError: null,
    rangeFrom: '2027-02-01', rangeTo: '2027-02-28',
  });

  assert.equal(await february, false);
  assert.deepEqual(state, january);
});

test('full and event-only responses share one generation lane in both orders', async () => {
  for (const olderKind of ['events', 'range']) {
    const loads = createCalendarLoadCoordinator();
    const state = {
      events: ['baseline event'], tasks: ['baseline task'], holidays: ['baseline holiday'],
      scheduleEntries: ['baseline shift'], scheduleWarnings: ['baseline warning'],
      offlineSince: null, loadError: null,
      rangeFrom: '2027-02-01', rangeTo: '2027-02-28',
    };
    let resolveOlder;
    const older = loads.run(
      () => new Promise((resolve) => { resolveOlder = resolve; }),
      {
        apply: (snapshot) => { Object.assign(state, snapshot); },
      },
    );
    const newerSnapshot = olderKind === 'events'
      ? {
          events: ['new full event'], tasks: ['new task'], holidays: ['new holiday'],
          scheduleEntries: ['new shift'], scheduleWarnings: ['new warning'],
          offlineSince: 'new cache', loadError: null,
          rangeFrom: '2027-03-01', rangeTo: '2027-03-31',
        }
      : { events: ['new event-only result'] };
    assert.equal(await loads.run(
      async () => newerSnapshot,
      { apply: (snapshot) => { Object.assign(state, snapshot); } },
    ), true);

    resolveOlder(olderKind === 'events'
      ? { events: ['old event-only result'] }
      : {
          events: ['old full event'], tasks: ['old task'], holidays: ['old holiday'],
          scheduleEntries: ['old shift'], scheduleWarnings: ['old warning'],
          offlineSince: 'old cache', loadError: new Error('old error'),
          rangeFrom: '2027-01-01', rangeTo: '2027-01-31',
        });
    assert.equal(await older, false);
    assert.deepEqual(state.events, newerSnapshot.events);
    if (olderKind === 'events') assert.equal(state.rangeFrom, '2027-03-01');
    else assert.equal(state.tasks[0], 'baseline task');
  }
});

test('an obsolete event-only response cannot repopulate Undo after an overlapping commit', async () => {
  const state = makeState();
  const loads = createCalendarLoadCoordinator();
  const occurrence = beginOptimisticCalendarDelete(state, {
    eventId: 7,
    scope: 'this',
    occurrenceDate: '2027-01-29',
  });
  const series = beginOptimisticCalendarDelete(state, { eventId: 7, scope: 'all' });
  let resolveObsolete;
  const obsolete = loads.run(
    () => new Promise((resolve) => { resolveObsolete = resolve; }),
    {
      apply: (events) => {
        state.events = events;
        applyPendingCalendarDeleteOverlay(state, { freshEvents: true });
      },
    },
  );

  series.commit();
  await loads.run(
    async () => [{ id: 8, title: 'Independent', start_datetime: '2027-02-15T09:00:00' }],
    {
      apply: (events) => {
        state.events = events;
        applyPendingCalendarDeleteOverlay(state, { freshEvents: true });
      },
    },
  );
  resolveObsolete(makeState().events);
  assert.equal(await obsolete, false);
  occurrence.restore();

  assert.deepEqual(state.events.map(({ title }) => title), ['Independent']);
});

test('following deletes for one series reach the server in initiation order', async () => {
  const state = makeState();
  let juneScheduled;
  let mayScheduled;
  let releaseJune;
  let serverRule = 'unbounded';
  const requestOrder = [];
  const common = {
    state,
    message: 'Deleted',
    isViewActive: () => false,
    reloadEvents: async () => {},
    handleError: () => {},
    render: () => {},
  };

  scheduleCalendarDeleteWithUndo({
    ...common,
    deleteScope: { eventId: 7, scope: 'following', occurrenceDate: '2027-06-01' },
    schedule: (options) => { juneScheduled = options; },
    requestDelete: async () => {
      requestOrder.push('June started');
      await new Promise((resolve) => { releaseJune = resolve; });
      serverRule = 'until May';
    },
  });
  scheduleCalendarDeleteWithUndo({
    ...common,
    deleteScope: { eventId: 7, scope: 'following', occurrenceDate: '2027-05-01' },
    schedule: (options) => { mayScheduled = options; },
    requestDelete: async () => {
      requestOrder.push('May started');
      serverRule = 'until April';
    },
  });

  const juneCommit = juneScheduled.commit({ keepalive: false });
  const mayCommit = mayScheduled.commit({ keepalive: false });
  await Promise.resolve();
  assert.deepEqual(requestOrder, ['June started']);
  releaseJune();
  await Promise.all([juneCommit, mayCommit]);

  assert.deepEqual(requestOrder, ['June started', 'May started']);
  assert.equal(serverRule, 'until April');
});

test('linked child and master deletes share series ordering without changing overlay identity', async () => {
  const state = {
    events: [
      {
        id: 99,
        series_id: 7,
        title: 'Moved child',
        start_datetime: '2027-06-02T18:00:00',
      },
      { id: 7, title: 'Later master occurrence', start_datetime: '2027-07-01T18:00:00' },
    ],
  };
  let childScheduled;
  let masterScheduled;
  let releaseChild;
  const requestOrder = [];
  const common = {
    state,
    message: 'Deleted',
    isViewActive: () => false,
    reloadEvents: async () => {},
    handleError: () => {},
    render: () => {},
  };

  scheduleCalendarDeleteWithUndo({
    ...common,
    deleteScope: {
      eventId: 99,
      seriesId: 7,
      scope: 'this',
      occurrenceDate: '2027-06-02',
    },
    schedule: (options) => { childScheduled = options; },
    requestDelete: async () => {
      requestOrder.push('child started');
      await new Promise((resolve) => { releaseChild = resolve; });
    },
  });
  scheduleCalendarDeleteWithUndo({
    ...common,
    deleteScope: { eventId: 7, seriesId: 7, scope: 'all' },
    schedule: (options) => { masterScheduled = options; },
    requestDelete: async () => { requestOrder.push('master started'); },
  });

  assert.deepEqual(state.events, [], 'each overlay still matches its concrete displayed row');
  const childCommit = childScheduled.commit({ keepalive: false });
  const masterCommit = masterScheduled.commit({ keepalive: false });
  await Promise.resolve();
  assert.deepEqual(requestOrder, ['child started']);
  releaseChild();
  await Promise.all([childCommit, masterCommit]);
  assert.deepEqual(requestOrder, ['child started', 'master started']);
});

test('Undo releases a reserved series write so the next deletion can commit', async () => {
  const state = makeState();
  const scheduled = [];
  const requests = [];
  const common = {
    state,
    message: 'Deleted',
    schedule: (options) => { scheduled.push(options); },
    isViewActive: () => false,
    reloadEvents: async () => {},
    handleError: () => {},
    render: () => {},
  };
  scheduleCalendarDeleteWithUndo({
    ...common,
    deleteScope: { eventId: 7, scope: 'this', occurrenceDate: '2027-01-29' },
    requestDelete: async () => { requests.push('first'); },
  });
  scheduleCalendarDeleteWithUndo({
    ...common,
    deleteScope: { eventId: 7, scope: 'all' },
    requestDelete: async () => { requests.push('second'); },
  });

  scheduled[0].restore();
  await scheduled[1].commit({ keepalive: false });
  assert.deepEqual(requests, ['second']);
});
