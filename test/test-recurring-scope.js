/**
 * Tests: Serientermin-Scope-Logik (public/utils/recurrence-scope.js, #532)
 * Fokus:
 *  - truncateRuleBefore kürzt Serien per UNTIL (Vortag, inklusiv) und wirft
 *    bestehendes UNTIL/COUNT ab; Reihenfolge FREQ;INTERVAL;BYDAY;UNTIL.
 *  - Die gekürzte Regel entfernt in der echten Expansion genau die Vorkommen
 *    ab dem Grenzdatum (End-to-End gegen server/services/calendar-events.js).
 *  - shiftSeriesStart / shiftEndForStart erhalten die Verschiebung bzw. Dauer.
 *  - isLocalRecurringSeries / isExternalRecurringSeries trennen, WELCHE Serie
 *    sich überhaupt zerlegen lässt - daran hängt der Löschumfang (#880).
 * Rein im Node-Kontext (keine DOM-/i18n-Abhängigkeiten).
 * Ausführen: node test/test-recurring-scope.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const { withoutBlockComments } = await import('./source-text.js');

const recurrenceScope = await import('../public/utils/recurrence-scope.js');
const { truncateRuleBefore, shiftSeriesStart, shiftEndForStart,
        isLocalRecurringSeries, isExternalRecurringSeries, canOverrideCalendarOccurrence,
        followingMeansWholeSeries, requiresWholeSeriesConfirmation } = recurrenceScope;
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');

test('outbound-local occurrence editing uses legacy detach and carries provider targets', async () => {
  const calls = [];
  const event = { id: 9, series_id: 9, recurrence_id: '2026-10-03',
    recurrence_rule: 'FREQ=DAILY', is_local_recurring_series: true,
    can_override_occurrence: false, can_detach_occurrence: true };
  const api = {
    post: async (path, body) => { calls.push({ path, body }); return { data: { id: 10 } }; },
    put: async () => { throw new Error('Linked endpoint is forbidden'); },
  };
  const result = await recurrenceScope.requestCalendarOccurrenceMutation({
    api, event, scope: 'this', body: { title: 'Moved', target_google_calendar_id: 'family' },
  });
  assert.equal(result.data.id, 10);
  assert.deepEqual(calls, [
    { path: '/calendar', body: { title: 'Moved', target_google_calendar_id: 'family', recurrence_rule: null } },
    { path: '/calendar/9/exceptions', body: { date: '2026-10-03' } },
  ]);
  assert.equal(recurrenceScope.requiresWholeSeriesConfirmation(event), false);
});

test('outbound-local occurrence deletion uses EXDATE and following uses legacy truncation', async () => {
  const calls = [];
  const event = { id: 9, series_id: 9, recurrence_id: '2026-10-03',
    recurrence_rule: 'FREQ=DAILY', is_recurring_instance: 1, is_series_start: 0,
    can_detach_occurrence: true, can_override_occurrence: false };
  const api = Object.fromEntries(['post', 'put', 'delete'].map((method) => [method,
    async (...args) => calls.push([method, ...args])]));
  await recurrenceScope.requestCalendarOccurrenceDelete({ api, event, scope: 'this', keepalive: true });
  await recurrenceScope.requestCalendarOccurrenceDelete({ api, event, scope: 'following', keepalive: true });
  await recurrenceScope.requestCalendarOccurrenceDelete({ api, event: { ...event, is_series_start: 1 }, scope: 'following' });
  assert.deepEqual(calls, [
    ['post', '/calendar/9/exceptions', { date: '2026-10-03' }, { keepalive: true }],
    ['put', '/calendar/9', { recurrence_rule: 'FREQ=DAILY;UNTIL=20261002' }, { keepalive: true }],
    ['delete', '/calendar/9', { keepalive: false }],
  ]);
  assert.throws(() => recurrenceScope.requestCalendarOccurrenceDelete({ api, event, scope: 'typo' }), TypeError);
  assert.equal(calls.length, 3, 'unknown scope must not delete the whole series');
});

test('outbound-local following edit truncates before creating the provider-targeted successor', async () => {
  const calls = [];
  const event = { id: 9, series_id: 9, recurrence_id: '2026-10-03',
    recurrence_rule: 'FREQ=DAILY', is_recurring_instance: 1, is_series_start: 0,
    can_detach_occurrence: true, can_override_occurrence: false };
  const body = { title: 'Successor', recurrence_rule: 'FREQ=WEEKLY', target_outlook_account_id: 2,
    target_outlook_calendar_id: 'family', start_datetime: '2026-10-03T12:00' };
  const api = {
    put: async (...args) => calls.push(['put', ...args]),
    post: async (...args) => { calls.push(['post', ...args]); return { data: { id: 10 } }; },
  };
  const result = await recurrenceScope.requestCalendarOccurrenceMutation({ api, event, scope: 'following', body });
  assert.equal(result.data.id, 10);
  assert.deepEqual(calls, [
    ['put', '/calendar/9', { recurrence_rule: 'FREQ=DAILY;UNTIL=20261002' }],
    ['post', '/calendar', body],
  ]);
});

// Der Server-Validator, gegen den gekürzte Regeln bestehen müssen.
const RRULE_RE = /^(FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;INTERVAL=\d{1,2})?(;BYDAY=[A-Z,]{2,}(,[A-Z]{2})*)?(;(UNTIL=\d{8}(T\d{6}Z)?|COUNT=\d{1,4}))?)?$/;

// --- truncateRuleBefore ---

test('truncateRuleBefore: setzt UNTIL auf den Vortag (inklusive Grenze)', () => {
  assert.equal(
    truncateRuleBefore('FREQ=WEEKLY', '2026-07-19'),
    'FREQ=WEEKLY;UNTIL=20260718'
  );
});

test('truncateRuleBefore: erhält INTERVAL und BYDAY in kanonischer Reihenfolge', () => {
  assert.equal(
    truncateRuleBefore('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', '2026-07-20'),
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20260719'
  );
});

test('truncateRuleBefore: wirft bestehendes UNTIL/COUNT ab', () => {
  assert.equal(
    truncateRuleBefore('FREQ=DAILY;UNTIL=20261231T235959Z', '2026-07-10'),
    'FREQ=DAILY;UNTIL=20260709'
  );
  assert.equal(
    truncateRuleBefore('FREQ=DAILY;COUNT=10', '2026-07-10'),
    'FREQ=DAILY;UNTIL=20260709'
  );
});

test('truncateRuleBefore: INTERVAL=1 wird weggelassen (wie beim UI-Builder)', () => {
  assert.equal(truncateRuleBefore('FREQ=DAILY;INTERVAL=1', '2026-07-10'), 'FREQ=DAILY;UNTIL=20260709');
});

test('truncateRuleBefore: Ergebnis besteht den Server-RRULE-Validator', () => {
  for (const rule of ['FREQ=DAILY', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR', 'FREQ=MONTHLY;COUNT=5']) {
    const out = truncateRuleBefore(rule, '2026-08-15');
    assert.ok(RRULE_RE.test(out), `ungültige Regel: ${out}`);
  }
});

test('truncateRuleBefore: null bei fehlender Regel oder ungültigem Datum', () => {
  assert.equal(truncateRuleBefore('', '2026-07-19'), null);
  assert.equal(truncateRuleBefore('FREQ=DAILY', 'kaputt'), null);
  assert.equal(truncateRuleBefore('FREQ=DAILY', ''), null);
});

// --- End-to-End: gekürzte Regel entfernt Vorkommen ab Grenzdatum ---

test('gekürzte Serie: Vorkommen ab Grenzdatum entfallen, davor bleiben', () => {
  const base = {
    id: 1,
    title: 'Standup',
    start_datetime: '2026-07-06T09:00',
    end_datetime: '2026-07-06T09:15',
    all_day: 0,
  };
  // Wöchentlich montags ab 06.07.; „dieser und folgende" ab dem 20.07. löschen.
  const truncated = truncateRuleBefore('FREQ=WEEKLY', '2026-07-20');
  const dates = expandRecurringEvents(
    [{ ...base, recurrence_rule: truncated }],
    '2026-07-01', '2026-08-31'
  ).map((e) => e.start_datetime.slice(0, 10));
  assert.deepEqual(dates, ['2026-07-06', '2026-07-13']); // 20.07. und später entfallen
});

// --- shiftSeriesStart: Delta auf den Master anwenden ---

test('shiftSeriesStart: nur Titel geändert (kein Zeitversatz) → Master-Start unverändert', () => {
  // Instanz #3 geöffnet, Zeit unverändert → Master behält seinen DTSTART.
  assert.equal(
    shiftSeriesStart('2026-07-06T09:00', '2026-07-20T09:00', '2026-07-20T09:00', false),
    '2026-07-06T09:00'
  );
});

test('shiftSeriesStart: Uhrzeit verschoben → gleiche Verschiebung am Master', () => {
  assert.equal(
    shiftSeriesStart('2026-07-06T09:00', '2026-07-20T09:00', '2026-07-20T10:30', false),
    '2026-07-06T10:30'
  );
});

test('shiftSeriesStart: ganztägig, um zwei Tage verschoben', () => {
  assert.equal(
    shiftSeriesStart('2026-07-06', '2026-07-20', '2026-07-22', true),
    '2026-07-08'
  );
});

// --- shiftEndForStart: Dauer erhalten ---

test('shiftEndForStart: Dauer bleibt am neuen Start erhalten', () => {
  assert.equal(
    shiftEndForStart('2026-07-06T10:30', '2026-07-20T10:30', '2026-07-20T11:00', false),
    '2026-07-06T11:00'
  );
});

test('shiftEndForStart: ohne Ende → null', () => {
  assert.equal(shiftEndForStart('2026-07-06T10:30', '2026-07-20T10:30', null, false), null);
});

test('shiftEndForStart: ganztägig mehrtägig, Dauer in Tagen erhalten', () => {
  assert.equal(
    shiftEndForStart('2026-07-08', '2026-07-22', '2026-07-24', true),
    '2026-07-10'
  );
});

// --------------------------------------------------------
// Welche Serie lässt sich zerlegen? (#880)
//
// Die Trennung entscheidet den Löschumfang: eine lokale Serie bekommt die
// Scope-Auswahl, eine fremde wird immer ganz gelöscht - und muss das vorher
// sagen. Beide Funktionen sind hier zusammen geprüft, weil sie zusammen eine
// vollständige Fallunterscheidung ergeben sollen: was weder lokal noch extern
// wiederkehrend ist, ist ein Einzeltermin, und für den gilt keine der beiden.
// --------------------------------------------------------

const RULE = 'FREQ=WEEKLY';

test('isLocalRecurringSeries: eine rein lokale Serie', () => {
  assert.equal(isLocalRecurringSeries({
    recurrence_rule: RULE,
    external_source: 'local',
    is_local_recurring_series: true,
    can_override_occurrence: true,
  }), true);
});

test('isLocalRecurringSeries: linked child without its own rule uses server capability', () => {
  assert.equal(isLocalRecurringSeries({
    recurrence_rule: null,
    series_id: 41,
    recurrence_id: '2026-10-31',
    is_local_recurring_series: true,
    can_override_occurrence: true,
  }), true);
});

test('isLocalRecurringSeries: ein Einzeltermin ist keine Serie', () => {
  assert.equal(isLocalRecurringSeries({ external_source: 'local' }), false);
  assert.equal(isLocalRecurringSeries({ recurrence_rule: '', external_source: 'local' }), false);
});

test('isLocalRecurringSeries: jede fremde Quelle schließt aus', () => {
  for (const source of ['google', 'apple', 'caldav', 'ics', 'outlook']) {
    assert.equal(
      isLocalRecurringSeries({ recurrence_rule: RULE, external_source: source }),
      false,
      `external_source=${source} gilt fälschlich als lokal`,
    );
  }
});

test('isLocalRecurringSeries: ein Kalenderbezug schließt aus, auch bei source=local', () => {
  // Beide Achsen zählen einzeln - eine Zeile kann ihren Ursprung noch als
  // 'local' führen und trotzdem an einem fremden Kalender hängen.
  assert.equal(isLocalRecurringSeries({ recurrence_rule: RULE, external_source: 'local', calendar_ref_id: 7 }), false);
  assert.equal(isLocalRecurringSeries({ recurrence_rule: RULE, external_source: 'local', subscription_id: 3 }), false);
});

test('isLocalRecurringSeries: client does not override a negative server capability', () => {
  assert.equal(isLocalRecurringSeries({
    recurrence_rule: RULE,
    external_source: 'local',
    is_local_recurring_series: true,
    can_override_occurrence: false,
  }), true);
});

test('canOverrideCalendarOccurrence remains actor-specific for a non-owner local series', () => {
  const visibleNonOwnerSeries = {
    recurrence_rule: RULE,
    external_source: 'local',
    is_local_recurring_series: true,
    can_override_occurrence: false,
  };
  assert.equal(isLocalRecurringSeries(visibleNonOwnerSeries), true);
  assert.equal(isExternalRecurringSeries(visibleNonOwnerSeries), false);
  assert.equal(canOverrideCalendarOccurrence(visibleNonOwnerSeries), false);
});

test('a structurally local series without occurrence authority requires a whole-series confirmation', () => {
  const localNonOwnerSeries = {
    recurrence_rule: RULE,
    is_local_recurring_series: true,
    can_override_occurrence: false,
  };
  assert.equal(requiresWholeSeriesConfirmation(localNonOwnerSeries), true);
  assert.equal(requiresWholeSeriesConfirmation({
    ...localNonOwnerSeries,
    can_override_occurrence: true,
  }), false);
  assert.equal(requiresWholeSeriesConfirmation({
    recurrence_rule: RULE,
    is_local_recurring_series: false,
    can_override_occurrence: false,
  }), false);
});

test('isExternalRecurringSeries ist das Gegenstück, nicht die Verneinung', () => {
  // Der Unterschied ist der Einzeltermin: er ist nicht lokal-wiederkehrend,
  // aber auch nicht extern-wiederkehrend - er darf keine Rückfrage auslösen.
  const single   = { external_source: 'caldav', calendar_ref_id: 7 };
  const external = { recurrence_rule: RULE, external_source: 'caldav', calendar_ref_id: 7, can_override_occurrence: false };
  const local    = { recurrence_rule: RULE, external_source: 'local', is_local_recurring_series: true, can_override_occurrence: true };

  assert.equal(isExternalRecurringSeries(single),   false, 'Einzeltermin würde nachfragen');
  assert.equal(isExternalRecurringSeries(external), true,  'fremde Serie fragt nicht nach');
  assert.equal(isExternalRecurringSeries(local),    false, 'lokale Serie bekäme die Rückfrage statt der Auswahl');
});

test('Die beiden Fälle überschneiden sich nie', () => {
  const cases = [
    {},
    { recurrence_rule: RULE, can_override_occurrence: false },
    { recurrence_rule: RULE, external_source: 'google', can_override_occurrence: false },
    { recurrence_rule: RULE, external_source: 'local', calendar_ref_id: 1, can_override_occurrence: false },
    { recurrence_rule: RULE, external_source: 'local', subscription_id: 1, can_override_occurrence: false },
    { external_source: 'google', calendar_ref_id: 1 },
  ];
  for (const ev of cases) {
    assert.ok(
      !(isLocalRecurringSeries(ev) && isExternalRecurringSeries(ev)),
      `beide zugleich wahr für ${JSON.stringify(ev)}`,
    );
  }
});

test('Jede Serie fällt in genau einen der beiden Fälle', () => {
  // Sonst gäbe es eine Serie, die weder die Auswahl noch die Rückfrage bekommt
  // und damit wortlos ganz gelöscht würde - genau der Zustand aus #880.
  const series = [
    { recurrence_rule: RULE, external_source: 'local', can_override_occurrence: true },
    { recurrence_rule: RULE, external_source: 'caldav', calendar_ref_id: 4, can_override_occurrence: false },
    { recurrence_rule: RULE, subscription_id: 9, can_override_occurrence: false },
    { recurrence_rule: RULE, can_override_occurrence: false },
  ];
  for (const ev of series) {
    assert.ok(
      isLocalRecurringSeries(ev) !== isExternalRecurringSeries(ev),
      `keiner der beiden Fälle greift für ${JSON.stringify(ev)}`,
    );
  }
});

test('mutation targets use the server series and original slot for a moved linked child', () => {
  const moved = {
    id: 99,
    series_id: 41,
    recurrence_id: '2026-10-31',
    start_datetime: '2026-11-02T11:00',
    can_override_occurrence: true,
  };

  assert.deepEqual(recurrenceScope.calendarOccurrenceMutationTarget(moved, 'this'), {
    method: 'put',
    path: '/calendar/41/occurrences/2026-10-31',
    carriesReminderOffsets: true,
  });
  assert.deepEqual(recurrenceScope.calendarOccurrenceMutationTarget(moved, 'following'), {
    method: 'put',
    path: '/calendar/41/occurrences/2026-10-31/following',
    carriesReminderOffsets: true,
  });
  assert.deepEqual(recurrenceScope.calendarOccurrenceMutationTarget(moved, 'series'), {
    method: 'put',
    path: '/calendar/41',
    carriesReminderOffsets: false,
  });
  assert.deepEqual(recurrenceScope.calendarOccurrenceDeleteTarget(moved, 'this'), {
    method: 'delete',
    path: '/calendar/41/occurrences/2026-10-31',
  });
  assert.deepEqual(recurrenceScope.calendarOccurrenceDeleteTarget(moved, 'following'), {
    method: 'delete',
    path: '/calendar/41/occurrences/2026-10-31/following',
  });
});

test('only-this save sends one atomic request with offsets and no series-owned fields', async () => {
  const calls = [];
  const event = {
    id: 99,
    series_id: 41,
    recurrence_id: '2026-10-31',
    start_datetime: '2026-11-02T11:00',
  };
  const response = await recurrenceScope.requestCalendarOccurrenceMutation({
    api: {
      put: async (path, body) => {
        calls.push({ path, body });
        return { data: { id: 99 } };
      },
    },
    event,
    scope: 'this',
    body: {
      title: 'Moved appointment',
      recurrence_rule: 'FREQ=MONTHLY',
      target_google_calendar_id: 'provider-calendar',
    },
    reminderOffsets: [60, 1440],
    confirmCount: async () => true,
  });

  assert.deepEqual(calls, [{
    path: '/calendar/41/occurrences/2026-10-31',
    body: {
      title: 'Moved appointment',
      reminder_offsets: [60, 1440],
    },
  }]);
  assert.equal(response.data.id, 99);
});

test('following save keeps validated successor sync targets and reminder offsets', async () => {
  const calls = [];
  await recurrenceScope.requestCalendarOccurrenceMutation({
    api: { put: async (path, body) => { calls.push({ path, body }); return { data: { id: 42 } }; } },
    event: { series_id: 41, recurrence_id: '2026-10-31' },
    scope: 'following',
    body: {
      title: 'Synced successor',
      target_google_calendar_id: null,
      target_caldav_account_id: 7,
      target_caldav_calendar_url: 'https://dav.test/family/',
      target_outlook_account_id: null,
      target_outlook_calendar_id: null,
    },
    reminderOffsets: [15],
    confirmCount: async () => true,
  });

  assert.deepEqual(calls, [{
    path: '/calendar/41/occurrences/2026-10-31/following',
    body: {
      title: 'Synced successor',
      target_google_calendar_id: null,
      target_caldav_account_id: 7,
      target_caldav_calendar_url: 'https://dav.test/family/',
      target_outlook_account_id: null,
      target_outlook_calendar_id: null,
      reminder_offsets: [15],
    },
  }]);
});

test('recurring delete sends the selected server target and keepalive option', async () => {
  const calls = [];
  await recurrenceScope.requestCalendarOccurrenceDelete({
    api: { delete: async (path, options) => { calls.push({ path, options }); } },
    event: { series_id: 41, recurrence_id: '2026-10-31' },
    scope: 'this',
    keepalive: true,
  });
  assert.deepEqual(calls, [{
    path: '/calendar/41/occurrences/2026-10-31',
    options: { keepalive: true },
  }]);
});

test('orphan confirmation retries the exact count the user confirmed', async () => {
  const attempts = [];
  const confirmations = [];
  const result = await recurrenceScope.withCalendarOrphanConfirmation(
    async (confirmedCount) => {
      attempts.push(confirmedCount);
      if (attempts.length === 1) {
        const error = new Error('server prose must not be rendered');
        error.status = 409;
        error.data = {
          code: 409,
          conflict: 'calendar_override_orphans',
          orphaned_override_count: 2,
        };
        throw error;
      }
      return { data: { id: 41 } };
    },
    async (count) => { confirmations.push(count); return true; },
  );

  assert.deepEqual(attempts, [undefined, 2]);
  assert.deepEqual(confirmations, [2]);
  assert.equal(result.data.id, 41);
});

test('a stale orphan count requires a fresh confirmation before another retry', async () => {
  const attempts = [];
  const confirmations = [];
  const counts = [2, 3];
  const result = await recurrenceScope.withCalendarOrphanConfirmation(
    async (confirmedCount) => {
      attempts.push(confirmedCount);
      if (counts.length) {
        const error = new Error('server prose must not be rendered');
        error.status = 409;
        error.data = {
          code: 409,
          conflict: 'calendar_override_orphans',
          orphaned_override_count: counts.shift(),
        };
        throw error;
      }
      return { data: { id: 41 } };
    },
    async (count) => { confirmations.push(count); return true; },
  );

  assert.deepEqual(attempts, [undefined, 2, 3]);
  assert.deepEqual(confirmations, [2, 3]);
  assert.equal(result.data.id, 41);
});

test('orphan confirmation stops after three changing conflicts', async () => {
  let count = 0;
  await assert.rejects(
    recurrenceScope.withCalendarOrphanConfirmation(async () => {
      const error = new Error('conflict');
      error.status = 409;
      error.data = {
        conflict: 'calendar_override_orphans',
        orphaned_override_count: ++count,
      };
      throw error;
    }, async () => true),
    /changed too many times/,
  );
  assert.equal(count, 3);
});

// --------------------------------------------------------
// Der Löschpfad selbst (#880)
//
// Die Klassifikation oben ist nur die halbe Zusicherung: sie kann richtig sein,
// während `requestDeleteEvent` sie gar nicht benutzt - genau so stand es vor
// #880 da, wo eine fremde Serie wortlos komplett gelöscht wurde. Geprüft wird
// deshalb die QUELLE der Seite; der Löschpfad hängt an Modal, i18n und Toast
// und ist ohne halben Browser nicht zu fahren.
//
// Kommentare werden vorher geschnitten: der Kommentar über der Funktion nennt
// beide gesuchten Namen, und ein Guard, der Prosa liest, wäre auch dann grün,
// wenn der Code sie nicht mehr enthält.
// --------------------------------------------------------

const calendarSrc = withoutBlockComments(
  readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf-8'),
);

function requestDeleteEventBody() {
  const start = calendarSrc.indexOf('async function requestDeleteEvent(');
  assert.ok(start > 0, 'requestDeleteEvent nicht auffindbar - Guard greift ins Leere');
  const end = calendarSrc.indexOf('\n}', start);
  assert.ok(end > start, 'Funktionsende nicht auffindbar');
  return calendarSrc.slice(start, end);
}

test('requestDeleteEvent prüft zuerst auf eine fremde Serie', () => {
  const body = requestDeleteEventBody();
  const guard  = body.indexOf('isExternalRecurringSeries(');
  const delete_ = body.indexOf('deleteEvent(');
  assert.ok(guard > 0, 'der Löschpfad fragt nicht nach einer fremden Serie');
  assert.ok(guard < delete_, 'gelöscht wird, bevor die fremde Serie erkannt ist');
});

test('Eine fremde Serie wird nur gelöscht, wenn sie bestätigt wurde', () => {
  // Nicht die Reihenfolge zweier Aufrufe, sondern die ABHAENGIGKEIT: `await`
  // vor der Rueckfrage und das Loeschen in ihrem Ergebnis. Ohne das `await`
  // waere die Zusage ein Promise, immer wahr, und der Dialog reine Zierde -
  // gelöscht wuerde trotzdem.
  const body = requestDeleteEventBody();
  const branch = body.slice(body.indexOf('isExternalRecurringSeries('));
  const confirm = branch.indexOf('confirmExternalSeriesDelete(');
  const del     = branch.indexOf('deleteEvent(');
  assert.ok(confirm > 0, 'keine Rueckfrage im Zweig der fremden Serie - sie verschwindet wortlos');
  assert.ok(confirm < del, 'gelöscht wird vor der Bestätigung');
  assert.match(
    branch.slice(0, del),
    /if\s*\(\s*await\s+confirmExternalSeriesDelete\(/,
    'das Löschen haengt nicht am ERGEBNIS der Rueckfrage',
  );
});

test('a local series without occurrence authority confirms edit and delete as whole-series actions', () => {
  const deleteBody = requestDeleteEventBody();
  const restrictedBranch = deleteBody.slice(deleteBody.indexOf('!canEditCalendarOccurrence('));
  assert.match(
    restrictedBranch,
    /if\s*\(\s*await\s+confirmLocalWholeSeriesDelete\(event\)\s*\)\s*await\s+deleteEvent\(event\)/,
    'restricted local series deletion is not conditional on the whole-series confirmation',
  );

  const saveStart = calendarSrc.indexOf('async function saveEvent(');
  const saveEnd = calendarSrc.indexOf('\n}', saveStart);
  const saveBody = calendarSrc.slice(saveStart, saveEnd);
  assert.match(saveBody, /requiresWholeSeriesConfirmation\(event\)/);
  assert.match(saveBody, /await\s+confirmLocalWholeSeriesEdit\(event\)/);

  const renderStart = calendarSrc.indexOf('function buildEventModalContent(');
  const renderEnd = calendarSrc.indexOf('\n}', renderStart);
  const renderBody = calendarSrc.slice(renderStart, renderEnd);
  assert.match(renderBody, /requiresWholeSeriesConfirmation\(event\)/);
  assert.match(renderBody, /calendar\.wholeSeriesOnlyNotice/);
  assert.match(
    renderBody,
    /isLocalRecurringSeries\(event\)\s*&&\s*canEditCalendarOccurrence\(event\)[\s\S]*renderRecurringScopeChooser/,
    'occurrence scope chooser is not guarded by occurrence authority',
  );
});

test('Jede fremde Serie bekommt die Auskunft, die auf sie zutrifft', () => {
  // Drei Faelle, drei verschiedene Wahrheiten. Nur bei Google, CalDAV und Apple
  // greift die Loeschung bis zur Quelle durch. Ein Geburtstagstermin ist das
  // Abbild seines Geburtstags und wird neu angelegt; ein Termin aus einem
  // ICS-Abo ist doppelt unloeschbar - `OUTBOUND_SOURCES` kennt kein `ics`, und
  // der naechste Aboabruf legt ihn wieder an. Eine Zusage, die nicht haelt, ist
  // schlimmer als gar keine: sie ist der einzige Grund, ueberhaupt zu fragen.
  const src = calendarSrc.slice(calendarSrc.indexOf('function confirmExternalSeriesDelete'));
  const chooser = src.slice(0, src.indexOf('\n}'));
  assert.ok(chooser.includes('birthday_name'),
    'der Loeschpfad erkennt keinen Geburtstagstermin');
  assert.ok(chooser.includes('subscription_id'),
    'der Loeschpfad erkennt keinen Termin aus einem ICS-Abo - er verspricht ihm dann eine '
    + 'Loeschung an der Quelle, die es dort gar nicht gibt');
  assert.ok(chooser.includes("birthday_event_kind === 'name_day'"),
    'the delete prompt does not distinguish a name day from a birthday');
  for (const n of ['NameDayEvent', 'BirthdayEvent', 'SubscribedSeries', 'ExternalSeries']) {
    assert.ok(chooser.includes(`calendar.delete${n}Detail`), `der Fall ${n} hat keinen eigenen Text`);
  }

  // Und der Loeschpfad muss den Waehler auch BENUTZEN.
  const body = requestDeleteEventBody();
  assert.ok(body.includes('confirmExternalSeriesDelete('),
    'requestDeleteEvent waehlt den Text nicht nach dem Fall aus');
});

test('Jede Rückfrage ist als zerstörend ausgewiesen', () => {
  const src = calendarSrc.slice(calendarSrc.indexOf('function confirmExternalSeriesDelete'));
  const chooser = src.slice(0, src.indexOf('\n}'));
  assert.equal((chooser.match(/danger:\s*true/g) || []).length, 4,
    'not all four delete prompts are marked as destructive');
});

test('Die Schlüssel beider Rückfragen stehen in allen Locales', () => {
  const dir = new URL('../public/locales/', import.meta.url);
  // Die Schlüssel werden im Code aus einem Präfix ZUSAMMENGESETZT
  // (`${prompt}Title`), tauchen also nirgends vollständig auf. Ein fehlender
  // fiele erst im Dialog auf - deshalb hier vollständig aufgeführt.
  const keys = ['External Series', 'Name Day Event', 'Birthday Event', 'Subscribed Series']
    .flatMap((n) => ['Title', 'Detail', 'Confirm']
      .map((part) => `delete${n.replace(/ /g, '')}${part}`));
  const locales = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''));
  assert.equal(locales.length, 24);
  for (const loc of locales) {
    const cal = JSON.parse(readFileSync(new URL(`${loc}.json`, dir), 'utf-8')).calendar;
    for (const k of keys) {
      assert.ok(typeof cal?.[k] === 'string' && cal[k].trim(), `${loc}.json: calendar.${k} fehlt oder ist leer`);
    }
    for (const k of ['deleteExternalSeriesDetail', 'deleteNameDayEventDetail', 'deleteBirthdayEventDetail', 'deleteSubscribedSeriesDetail']) {
      assert.ok(cal[k].includes('{{title}}'), `${loc}.json: ${k} nennt den Termin nicht`);
    }
  }
  const cs = JSON.parse(readFileSync(new URL('cs.json', dir), 'utf-8')).calendar;
  assert.equal(cs.deleteNameDayEventTitle, 'Odstranit svátek?');
});

test('whole-series-only warnings are meaningful in every locale and use no dash punctuation', () => {
  const keys = [
    'wholeSeriesOnlyNotice',
    'editWholeSeriesOnlyTitle',
    'editWholeSeriesOnlyDetail',
    'editWholeSeriesOnlyConfirm',
    'deleteWholeSeriesOnlyTitle',
    'deleteWholeSeriesOnlyDetail',
    'deleteWholeSeriesOnlyConfirm',
  ];
  const dir = new URL('../public/locales/', import.meta.url);
  const locales = readdirSync(dir).filter((file) => file.endsWith('.json'));
  assert.equal(locales.length, 24);
  for (const file of locales) {
    const cal = JSON.parse(readFileSync(new URL(file, dir), 'utf-8')).calendar;
    for (const key of keys) {
      assert.ok(typeof cal?.[key] === 'string' && cal[key].trim().length >= 4,
        `${file}: calendar.${key} fehlt oder ist bedeutungslos`);
      assert.doesNotMatch(cal[key], /[\u2010-\u2015]/, `${file}: calendar.${key} contains dash punctuation`);
    }
    assert.ok(cal.editWholeSeriesOnlyDetail.includes('{{title}}'), `${file}: edit detail omits title`);
    assert.ok(cal.deleteWholeSeriesOnlyDetail.includes('{{title}}'), `${file}: delete detail omits title`);
  }

  const de = JSON.parse(readFileSync(new URL('de.json', dir), 'utf-8')).calendar;
  assert.equal(de.editWholeSeriesOnlyTitle, 'Ganze Serie bearbeiten?');
  assert.equal(de.deleteWholeSeriesOnlyTitle, 'Ganze Serie löschen?');
});

test('truncateRuleBefore behaelt "am letzten Tag des Monats" (#960)', async () => {
  // Der Schnitt baut die Regel aus ihren Teilen NEU. Was er dabei nicht kennt,
  // faellt weg - und der zurueckbleibende Teil der Serie lief danach auf dem
  // Tag seines Startdatums statt am Monatsende. Dieselbe stille Umschreibung,
  // die die Wortlaut-Regel aus #756 an anderer Stelle verhindert.
  assert.equal(truncateRuleBefore('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-05-31'),
    'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260530');
  assert.equal(truncateRuleBefore('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=-1;COUNT=9', '2026-05-31'),
    'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=-1;UNTIL=20260530');

  // Nur bei MONTHLY, und nur `-1` - der Validator nimmt nichts anderes an.
  assert.equal(truncateRuleBefore('FREQ=YEARLY;BYMONTHDAY=-1', '2026-05-31'),
    'FREQ=YEARLY;UNTIL=20260530');
  assert.equal(truncateRuleBefore('FREQ=MONTHLY;BYMONTHDAY=15', '2026-05-31'),
    'FREQ=MONTHLY;UNTIL=20260530');

  // Und das Ergebnis muss der Server annehmen, sonst scheitert das Speichern
  // des zurueckbleibenden Teils.
  const { RRULE_RE } = await import('../server/middleware/validate.js');
  assert.ok(RRULE_RE.test(truncateRuleBefore('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-05-31')));
});

test('followingMeansWholeSeries: der Anfang ist kein Schnitt', () => {
  // Der Master selbst (kein expandiertes Vorkommen).
  assert.equal(followingMeansWholeSeries({ is_recurring_instance: 0 }), true);
  // Eine spaetere Instanz: hier wird wirklich geschnitten.
  assert.equal(followingMeansWholeSeries({ is_recurring_instance: 1, is_series_start: 0 }), false);
  // DER FALL, UM DEN ES GEHT: erstes Vorkommen, das vom gespeicherten Datum
  // abweicht - abweichend UND trotzdem der Anfang.
  assert.equal(followingMeansWholeSeries({ is_recurring_instance: 1, is_series_start: 1 }), true);
  // Ohne das Feld (aeltere Antwort) bleibt es beim vorherigen Verhalten.
  assert.equal(followingMeansWholeSeries({ is_recurring_instance: 1 }), false);
});

test('Die Expansion markiert das erste Vorkommen, auch wenn es vom Start abweicht', () => {
  const base = {
    id: 1, title: 'Monatsletzter', all_day: 0,
    start_datetime: '2026-01-15T09:00', end_datetime: '2026-01-15T09:15',
    recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
  };
  const inst = expandRecurringEvents([base], '2026-01-01', '2026-04-30');
  const tage = inst.map((e) => e.start_datetime.slice(0, 10));
  assert.deepEqual(tage, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  // Der 31. Januar weicht vom gespeicherten 15. ab UND ist der Serienanfang.
  assert.equal(inst[0].is_recurring_instance, 1, 'weicht vom gespeicherten Datum ab');
  assert.equal(inst[0].is_series_start, 1, 'und ist trotzdem das erste Vorkommen');
  assert.equal(inst[1].is_series_start, 0, 'der zweite ist es nicht');
});

test('Ein Schnitt am ersten Vorkommen wuerde die Serie leeren - deshalb die Regel', () => {
  // DER BELEG FUER DIE REGEL, NICHT NUR IHRE WIEDERHOLUNG. Wer am ersten
  // Vorkommen \"diesen und alle folgenden\" waehlt und trotzdem kuerzt, baut ein
  // UNTIL vor den Anfang: eine Serie ohne jedes Vorkommen. Der Server lehnt
  // sie ab, und der erste sichtbare Termin liesse sich weder loeschen noch
  // bearbeiten.
  const base = {
    id: 1, title: 'Monatsletzter', all_day: 0,
    start_datetime: '2026-01-15T09:00', end_datetime: '2026-01-15T09:15',
    recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
  };
  const erste = expandRecurringEvents([base], '2026-01-01', '2026-04-30')[0];
  assert.equal(followingMeansWholeSeries(erste), true, 'die Regel greift hier');

  const gekuerzt = truncateRuleBefore(base.recurrence_rule, erste.start_datetime.slice(0, 10));
  const uebrig = expandRecurringEvents(
    [{ ...base, recurrence_rule: gekuerzt }], '2026-01-01', '2027-12-31'
  );
  assert.equal(uebrig.length, 0, `der Schnitt liesse nichts stehen: ${gekuerzt}`);
});

test('Die Kalenderseite delegiert die Scope-Arithmetik an die getesteten Helfer', () => {
  assert.doesNotMatch(calendarSrc, /truncateRuleBefore\(/,
    'Verknüpfte Scopes nutzen atomare Endpunkte; nur der Legacy-Helfer kürzt clientseitig');
});
