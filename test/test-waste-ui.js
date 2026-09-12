/**
 * Modul: Waste collection page (#1063 Phase 2)
 * Zweck: pure UI-logic exported from public/pages/waste.js via __test - the
 *        deep-link contract (?type=<id>&date=<YYYY-MM-DD>), the schedule
 *        origin lookup that backs move/skip/restore, and the recurrence
 *        summary / provenance badge text that make overlapping origins
 *        (invariant #3/#4) visible in the UI. Uses the shared minimal DOM
 *        stub + browser-path loader (same pattern as test-shopping-ux.js);
 *        the loader's /i18n.js stub echoes t('key', params) as
 *        "key" + JSON.stringify(params), so assertions check against that
 *        predictable shape rather than real translated text. Full modal
 *        open/save/dirty-close flows are covered by manual browser testing
 *        instead of here, since modal.js's dirty-close machinery is generic,
 *        shared, and already covered by its own tests - this repo has no
 *        jsdom dependency, and open/save/dirty-close flows need a real DOM.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-waste-ui.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

global.HTMLElement = class HTMLElement {};
global.customElements = { define() {}, get() { return undefined; } };
global.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, yuvomi: {} };
global.document = {
  getElementById: () => null,
  createElement: () => Object.assign(new global.HTMLElement(), {
    style: {}, setAttribute() {}, appendChild() {}, addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
  }),
  addEventListener() {},
  documentElement: { lang: 'de' },
};

const { __test } = await import('../public/pages/waste.js');
const {
  findScheduleOrigin, parseDeepLinkParams, deepLinkSelectors, recurrenceSummary, originBadges,
  defaultLabelDecision, unresolvedBlockingDiagnostics, buildMappingDecisions, sourceHealthBadgeInfo,
  splitUpcomingByType, deepLinkNeedsExpand,
} = __test;

// -------------------------------------------------------------------------
// findScheduleOrigin - backs move/skip/restore
// -------------------------------------------------------------------------

test('findScheduleOrigin: returns the schedule id and original date for a schedule-origin occurrence', () => {
  const occurrences = [{
    key: '1:2026-01-05', date_key: '2026-01-05',
    origins: [{ kind: 'schedule', schedule_id: 10, original_date: null, moved: false }],
  }];
  const found = findScheduleOrigin('1:2026-01-05', occurrences);
  assert.equal(found.scheduleId, 10);
  assert.equal(found.originalDate, '2026-01-05', 'falls back to the occurrence date when original_date is null (unmoved)');
});

test('findScheduleOrigin: uses the recorded original_date for a moved occurrence', () => {
  const occurrences = [{
    key: '1:2026-01-14', date_key: '2026-01-14',
    origins: [{ kind: 'schedule', schedule_id: 10, original_date: '2026-01-12', moved: true }],
  }];
  const found = findScheduleOrigin('1:2026-01-14', occurrences);
  assert.equal(found.originalDate, '2026-01-12');
});

test('findScheduleOrigin: returns null for a one-off-only occurrence (nothing to move/skip)', () => {
  const occurrences = [{
    key: '1:2026-01-12', date_key: '2026-01-12',
    origins: [{ kind: 'one_off', one_off_id: 5, original_date: null, moved: false }],
  }];
  assert.equal(findScheduleOrigin('1:2026-01-12', occurrences), null);
});

test('findScheduleOrigin: returns null for an unknown key', () => {
  assert.equal(findScheduleOrigin('missing', []), null);
});

// -------------------------------------------------------------------------
// Deep-link contract: ?type=<id>&date=<YYYY-MM-DD>
// -------------------------------------------------------------------------

test('parseDeepLinkParams: reads a well-formed type + date', () => {
  assert.deepEqual(parseDeepLinkParams('?type=7&date=2026-03-01'), { typeId: 7, date: '2026-03-01' });
});

test('parseDeepLinkParams: type alone (no date) is valid', () => {
  assert.deepEqual(parseDeepLinkParams('?type=7'), { typeId: 7, date: null });
});

test('parseDeepLinkParams: no type at all yields typeId: null regardless of date', () => {
  assert.deepEqual(parseDeepLinkParams('?date=2026-03-01'), { typeId: null, date: '2026-03-01' });
  assert.deepEqual(parseDeepLinkParams(''), { typeId: null, date: null });
});

test('parseDeepLinkParams: rejects a malformed date instead of passing it through unescaped', () => {
  assert.deepEqual(parseDeepLinkParams('?type=7&date=not-a-date'), { typeId: 7, date: null });
  assert.deepEqual(parseDeepLinkParams('?type=7&date=2026-3-1'), { typeId: 7, date: null });
});

test('parseDeepLinkParams: rejects a non-positive or non-numeric type', () => {
  assert.deepEqual(parseDeepLinkParams('?type=0'), { typeId: null, date: null });
  assert.deepEqual(parseDeepLinkParams('?type=-1'), { typeId: null, date: null });
  assert.deepEqual(parseDeepLinkParams('?type=abc'), { typeId: null, date: null });
});

test('deepLinkSelectors: null when there is no type to link to', () => {
  assert.equal(deepLinkSelectors({ typeId: null, date: null }), null);
});

test('deepLinkSelectors: a type + date targets the occurrence row, with a card fallback', () => {
  const selectors = deepLinkSelectors({ typeId: 7, date: '2026-03-01' });
  assert.equal(selectors.rowSelector, '.waste-occurrence-row[data-type-id="7"][data-date="2026-03-01"]');
  assert.equal(selectors.cardSelector, '.waste-type-card[data-type-id="7"]');
});

test('deepLinkSelectors: a type alone has no row selector, only the card fallback', () => {
  const selectors = deepLinkSelectors({ typeId: 7, date: null });
  assert.equal(selectors.rowSelector, null);
  assert.equal(selectors.cardSelector, '.waste-type-card[data-type-id="7"]');
});

// -------------------------------------------------------------------------
// splitUpcomingByType / deepLinkNeedsExpand - the collapsed "rest" section
// -------------------------------------------------------------------------

function occ(typeId, dateKey) {
  return { key: `${typeId}:${dateKey}`, date_key: dateKey, type_id: typeId };
}

test('splitUpcomingByType: one primary row per type (its earliest, since occurrences arrive date-sorted), everything else in rest', () => {
  const occurrences = [
    occ(1, '2026-01-05'), occ(2, '2026-01-06'), occ(1, '2026-01-12'), occ(1, '2026-01-19'), occ(2, '2026-01-13'),
  ];
  const { primary, rest } = splitUpcomingByType(occurrences);
  assert.deepEqual(primary.map((o) => o.key), ['1:2026-01-05', '2:2026-01-06'], 'the first occurrence encountered per type is primary');
  assert.deepEqual(rest.map((o) => o.key), ['1:2026-01-12', '1:2026-01-19', '2:2026-01-13']);
});

test('splitUpcomingByType: a single occurrence per type leaves rest empty', () => {
  const { primary, rest } = splitUpcomingByType([occ(1, '2026-01-05'), occ(2, '2026-01-06')]);
  assert.equal(primary.length, 2);
  assert.equal(rest.length, 0);
});

test('deepLinkNeedsExpand: false without a type/date, or when the target is a type\'s own primary row', () => {
  const occurrences = [occ(1, '2026-01-05'), occ(1, '2026-01-12')];
  assert.equal(deepLinkNeedsExpand(occurrences, { typeId: null, date: null }), false);
  assert.equal(deepLinkNeedsExpand(occurrences, { typeId: 1, date: null }), false);
  assert.equal(deepLinkNeedsExpand(occurrences, { typeId: 1, date: '2026-01-05' }), false, 'the primary row is already visible without expanding');
});

test('deepLinkNeedsExpand: true when the target date only exists in the collapsed rest section', () => {
  const occurrences = [occ(1, '2026-01-05'), occ(1, '2026-01-12')];
  assert.equal(deepLinkNeedsExpand(occurrences, { typeId: 1, date: '2026-01-12' }), true);
});

// -------------------------------------------------------------------------
// recurrenceSummary - the text a schedule row actually shows
// -------------------------------------------------------------------------

test('recurrenceSummary: weekly, single interval, joins weekday labels', () => {
  const schedule = { recurrence_kind: 'weekly', weekdays: 'MO,TH', interval: 1 };
  const days = 'waste.weekdayMon, waste.weekdayThu';
  assert.equal(recurrenceSummary(schedule), `waste.summaryWeekly{"days":"${days}"}`);
});

test('recurrenceSummary: weekly with interval > 1 uses the interval-aware key', () => {
  const schedule = { recurrence_kind: 'weekly', weekdays: 'MO', interval: 2 };
  assert.equal(recurrenceSummary(schedule), 'waste.summaryWeeklyInterval{"interval":2,"days":"waste.weekdayMon"}');
});

test('recurrenceSummary: monthly fixed day', () => {
  const schedule = { recurrence_kind: 'monthly_fixed_day', month_day: 15, interval: 1 };
  assert.equal(recurrenceSummary(schedule), 'waste.summaryMonthly{"day":"waste.summaryMonthDayN{\\"day\\":15}"}');
});

test('recurrenceSummary: monthly last-day-of-month uses the dedicated label, not summaryMonthDayN', () => {
  const schedule = { recurrence_kind: 'monthly_fixed_day', month_day: -1, interval: 1 };
  assert.equal(recurrenceSummary(schedule), 'waste.summaryMonthly{"day":"waste.monthDayLastDay"}');
});

test('recurrenceSummary: monthly with interval > 1 uses the interval-aware key', () => {
  const schedule = { recurrence_kind: 'monthly_fixed_day', month_day: 1, interval: 3 };
  assert.equal(recurrenceSummary(schedule), 'waste.summaryMonthlyInterval{"interval":3,"day":"waste.summaryMonthDayN{\\"day\\":1}"}');
});

// -------------------------------------------------------------------------
// originBadges - provenance visibility (invariant #3/#4)
// -------------------------------------------------------------------------

test('originBadges: an unmoved, non-coalesced occurrence shows no badges', () => {
  const occurrence = { moved: false, coalesced: false, origins: [{ kind: 'schedule', moved: false }] };
  assert.equal(originBadges(occurrence), '');
});

test('originBadges: a moved occurrence names its original date', () => {
  const occurrence = {
    moved: true, coalesced: false,
    origins: [{ kind: 'schedule', moved: true, original_date: '2026-01-12' }],
  };
  assert.match(originBadges(occurrence), /waste-badge--moved/);
  assert.match(originBadges(occurrence), /waste\.movedFromBadge/);
});

test('originBadges: a coalesced occurrence names the overlap, so editing one origin never looks like it erased the other', () => {
  const occurrence = {
    moved: false, coalesced: true,
    origins: [{ kind: 'schedule', moved: false }, { kind: 'one_off', moved: false }],
  };
  assert.match(originBadges(occurrence), /waste-badge--coalesced/);
});

test('originBadges: a moved AND coalesced occurrence shows both badges', () => {
  const occurrence = {
    moved: true, coalesced: true,
    origins: [{ kind: 'schedule', moved: true, original_date: '2026-01-12' }, { kind: 'one_off', moved: false }],
  };
  const html = originBadges(occurrence);
  assert.match(html, /waste-badge--moved/);
  assert.match(html, /waste-badge--coalesced/);
});

// -------------------------------------------------------------------------
// Import wizard pure helpers (#1063 Phase 3)
// -------------------------------------------------------------------------

test('defaultLabelDecision: remembered_ignored beats remembered_type_id beats suggested_type_id beats "create new"', () => {
  assert.equal(defaultLabelDecision({ remembered_ignored: true, remembered_type_id: 5, suggested_type_id: 9 }), '');
  assert.equal(defaultLabelDecision({ remembered_ignored: false, remembered_type_id: 5, suggested_type_id: 9 }), '5');
  assert.equal(defaultLabelDecision({ remembered_ignored: false, remembered_type_id: null, suggested_type_id: 9 }), '9');
  assert.equal(defaultLabelDecision({ remembered_ignored: false, remembered_type_id: null, suggested_type_id: null }), '__new__');
});

test('unresolvedBlockingDiagnostics: only blocking diagnostics count, and an explicit skip resolves one', () => {
  const diagnostics = [
    { severity: 'info', code: 'cancelled_excluded', event_key: null },
    { severity: 'blocking', code: 'unbounded_recurrence', event_key: 'uid:a' },
    { severity: 'blocking', code: 'unsupported_rdate', event_key: 'uid:b' },
  ];
  assert.equal(unresolvedBlockingDiagnostics(diagnostics, []).length, 2);
  assert.equal(unresolvedBlockingDiagnostics(diagnostics, ['uid:a']).length, 1);
  assert.equal(unresolvedBlockingDiagnostics(diagnostics, ['uid:a', 'uid:b']).length, 0);
});

test('buildMappingDecisions: builds type_id / new_type / ignored entries from each row\'s decision', () => {
  const rows = [
    { normalized_label: 'restmüll', decision: '5', newTypeName: '' },
    { normalized_label: 'papier', decision: '__new__', newTypeName: 'Papier' },
    { normalized_label: 'sperrmüll', decision: '', newTypeName: '' },
  ];
  const { mappings, error } = buildMappingDecisions(rows);
  assert.equal(error, undefined);
  assert.deepEqual(mappings, [
    { normalized_label: 'restmüll', type_id: 5 },
    { normalized_label: 'papier', new_type: { name: 'Papier' } },
    { normalized_label: 'sperrmüll', ignored: true },
  ]);
});

test('buildMappingDecisions: a "create new" decision without a name reports an error instead of committing a blank type', () => {
  const rows = [{ normalized_label: 'papier', decision: '__new__', newTypeName: '  ' }];
  const result = buildMappingDecisions(rows);
  assert.equal(result.error, 'missing_new_type_name');
  assert.equal(result.label, 'papier');
});

test('sourceHealthBadgeInfo: an error takes priority over needs_refresh, and a healthy source shows nothing', () => {
  assert.equal(sourceHealthBadgeInfo({ last_error: 'boom', needs_refresh: true }).code, 'error');
  assert.equal(sourceHealthBadgeInfo({ last_error: null, needs_refresh: true }).code, 'needs-refresh');
  assert.equal(sourceHealthBadgeInfo({ last_error: null, needs_refresh: false }), null);
});
