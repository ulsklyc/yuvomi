/**
 * Module: shared recurrence engine (#1063 Phase 9) - ordinal BYDAY
 * Purpose: server/services/recurrence.js's first dedicated unit-test file.
 *          Prior coverage was entirely indirect, through consumers
 *          (test-caldav-recurrence.js, test-tasks-recurrence.js, ...).
 *          This file exercises parseRRule/nextOccurrence/matchesRRuleByday/
 *          nextOccurrenceAfter/hasAnyOccurrence/seriesStartFor directly for
 *          the new ordinal-BYDAY shape ("2MO", "-1FR"), added once here and
 *          shared by every existing caller (Tasks, Calendar/CalDAV/ICS,
 *          Waste) rather than as a Waste-only branch.
 * Ausführen: node --test test/test-recurrence.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  parseRRule, nextOccurrence, nextOccurrenceAfter, matchesRRuleByday, hasAnyOccurrence, seriesStartFor,
} = await import('../server/services/recurrence.js');

// -------------------------------------------------------------------------
// parseRRule: what gets recognized as ordinal BYDAY, and what deliberately doesn't
// -------------------------------------------------------------------------

test('parseRRule: a single ordinal BYDAY token at FREQ=MONTHLY is recognized', () => {
  assert.deepEqual(parseRRule('FREQ=MONTHLY;BYDAY=2MO').bydayOrdinal, { ordinal: 2, weekday: 1 });
  assert.deepEqual(parseRRule('FREQ=MONTHLY;BYDAY=-1FR').bydayOrdinal, { ordinal: -1, weekday: 5 });
  assert.deepEqual(parseRRule('FREQ=MONTHLY;BYDAY=4SU').bydayOrdinal, { ordinal: 4, weekday: 0 });
  // A recognized ordinal token contributes nothing to the plain weekday-set filter.
  assert.deepEqual(parseRRule('FREQ=MONTHLY;BYDAY=2MO').byday, []);
});

test('parseRRule: a plain (non-ordinal) BYDAY is unaffected, at any FREQ', () => {
  assert.equal(parseRRule('FREQ=WEEKLY;BYDAY=MO,TH').bydayOrdinal, null);
  assert.deepEqual(parseRRule('FREQ=WEEKLY;BYDAY=MO,TH').byday, [1, 4]);
  assert.equal(parseRRule('FREQ=MONTHLY;BYDAY=MO').bydayOrdinal, null);
});

test('parseRRule: an ordinal outside 1-4/-1 (e.g. "5MO") is not accepted - not every month has a fifth', () => {
  const parsed = parseRRule('FREQ=MONTHLY;BYDAY=5MO');
  assert.equal(parsed.bydayOrdinal, null);
  assert.deepEqual(parsed.byday, [], 'an unaccepted ordinal token must not leak into the plain weekday filter either');
});

test('parseRRule: an ordinal BYDAY at FREQ=WEEKLY/YEARLY is not accepted (only MONTHLY is unambiguous here)', () => {
  assert.equal(parseRRule('FREQ=WEEKLY;BYDAY=2MO').bydayOrdinal, null);
  assert.equal(parseRRule('FREQ=YEARLY;BYDAY=2MO').bydayOrdinal, null);
});

test('parseRRule: multiple BYDAY tokens (ordinal or mixed) are not accepted as a single ordinal rule', () => {
  assert.equal(parseRRule('FREQ=MONTHLY;BYDAY=2MO,2TU').bydayOrdinal, null);
  assert.equal(parseRRule('FREQ=MONTHLY;BYDAY=2MO,FR').bydayOrdinal, null);
});

// -------------------------------------------------------------------------
// nextOccurrence: the concrete date an ordinal rule computes
// -------------------------------------------------------------------------

test('nextOccurrence: "2nd Monday" resolves to the correct calendar date, jumping to next month once this month\'s own has passed', () => {
  // December 2025: Mondays are 1, 8, 15, 22, 29 - 2nd Monday is Dec 8, already
  // behind Dec 15 - so the next occurrence is next month's: January 2026
  // (Mondays 5, 12, 19, 26), 2nd = Jan 12.
  assert.equal(nextOccurrence('2025-12-15', 'FREQ=MONTHLY;BYDAY=2MO'), '2026-01-12');
});

test('nextOccurrence: "last Friday" can still be ahead within the SAME month (mirrors BYMONTHDAY=-1\'s own same-month rule)', () => {
  // December 2025: Fridays are 5, 12, 19, 26 - the last Friday (26th) is still
  // ahead of Dec 15, so the next occurrence stays in December.
  assert.equal(nextOccurrence('2025-12-15', 'FREQ=MONTHLY;BYDAY=-1FR'), '2025-12-26');
});

test('nextOccurrence: the 4th weekday always exists, even in February', () => {
  // January 2026: Thursdays are 1, 8, 15, 22, 29 - the 4th (22nd) has already
  // passed by the 23rd, so the next occurrence is February's. February 2026
  // (not a leap year, 28 days): Thursdays are 5, 12, 19, 26 - the 4th is the
  // 26th, right at the edge of the month.
  assert.equal(nextOccurrence('2026-01-23', 'FREQ=MONTHLY;BYDAY=4TH'), '2026-02-26');
});

test('nextOccurrence: leap-year February still resolves correctly', () => {
  // January 2028: Mondays are 3, 10, 17, 24, 31 - the last Monday IS the 31st
  // itself, so starting exactly there jumps to next month. February 2028 IS a
  // leap year (29 days); Mondays: 7, 14, 21, 28 - last Monday is the 28th.
  assert.equal(nextOccurrence('2028-01-31', 'FREQ=MONTHLY;BYDAY=-1MO'), '2028-02-28');
});

test('nextOccurrence: the next occurrence can land in the SAME month as base, mirroring BYMONTHDAY=-1\'s own rule', () => {
  // Anchored series created on the 1st: the 2nd Monday of that same month is
  // still ahead, so it must not skip straight to next month.
  assert.equal(nextOccurrence('2026-01-01', 'FREQ=MONTHLY;BYDAY=2MO', { anchor: '2026-01-01' }), '2026-01-12');
  // But once base is already past this month's target day, it jumps forward.
  assert.equal(nextOccurrence('2026-01-15', 'FREQ=MONTHLY;BYDAY=2MO', { anchor: '2026-01-01' }), '2026-02-09');
});

test('nextOccurrence: INTERVAL > 1 steps whole months at a time, not just +1', () => {
  // Every 3rd month, 2nd Monday: Jan 12 2026 -> Apr 13 2026 (Mondays in April: 6,13,20,27).
  assert.equal(nextOccurrence('2026-01-12', 'FREQ=MONTHLY;INTERVAL=3;BYDAY=2MO'), '2026-04-13');
});

test('nextOccurrence: fromArbitraryDate suppresses the same-month check (task "from completion" anchoring)', () => {
  // Completing on the 5th (before the 2nd Monday of that same month) must
  // still count the FULL interval forward from THIS arbitrary date, not
  // collapse onto this month's own occurrence - same rule fromArbitraryDate
  // already applies to BYMONTHDAY=-1.
  const withFlag = nextOccurrence('2026-01-05', 'FREQ=MONTHLY;BYDAY=2MO', { fromArbitraryDate: true });
  assert.equal(withFlag, '2026-02-09', 'must jump a full month ahead, not resolve to the 12th');
});

// -------------------------------------------------------------------------
// matchesRRuleByday: the occurrence-membership predicate
// -------------------------------------------------------------------------

test('matchesRRuleByday: only the exact nth/last weekday of ITS OWN month passes', () => {
  assert.equal(matchesRRuleByday('2026-01-12', 'FREQ=MONTHLY;BYDAY=2MO'), true);
  assert.equal(matchesRRuleByday('2026-01-05', 'FREQ=MONTHLY;BYDAY=2MO'), false, 'the 1st Monday is not the 2nd');
  assert.equal(matchesRRuleByday('2026-01-19', 'FREQ=MONTHLY;BYDAY=2MO'), false, 'the 3rd Monday is not the 2nd');
  assert.equal(matchesRRuleByday('2026-01-12', 'FREQ=MONTHLY;BYDAY=-1FR'), false, 'wrong weekday entirely');
  assert.equal(matchesRRuleByday('2026-01-30', 'FREQ=MONTHLY;BYDAY=-1FR'), true);
});

test('matchesRRuleByday: utcDiffersFromLocal disables the ordinal check the same way it disables BYMONTHDAY=-1', () => {
  assert.equal(matchesRRuleByday('2026-01-05', 'FREQ=MONTHLY;BYDAY=2MO', { utcDiffersFromLocal: true }), true);
});

// -------------------------------------------------------------------------
// nextOccurrenceAfter: catch-up, COUNT non-enforcement, UNTIL
// -------------------------------------------------------------------------

test('nextOccurrenceAfter: catches up to a future lower bound and still lands on the correct ordinal date', () => {
  const result = nextOccurrenceAfter('2025-06-01', 'FREQ=MONTHLY;BYDAY=2MO', '2026-01-01', { seriesStart: '2025-06-01' });
  assert.equal(result, '2026-01-12');
});

test('nextOccurrenceAfter: COUNT is never enforced on an ordinal rule (fastForward/lastOccurrenceOf both bail out), same caution as plain BYDAY', () => {
  // A tight COUNT must not silently cut the series short - "one occurrence
  // too many" is the accepted tradeoff for a shape this module cannot count
  // via fixed interval multiplication.
  const result = nextOccurrenceAfter('2026-01-12', 'FREQ=MONTHLY;BYDAY=2MO;COUNT=1', '2026-02-01', { seriesStart: '2026-01-12' });
  assert.equal(result, '2026-02-09', 'must still produce a 2nd occurrence despite COUNT=1');
});

test('nextOccurrenceAfter: UNTIL still ends the series', () => {
  const result = nextOccurrenceAfter('2026-01-12', 'FREQ=MONTHLY;BYDAY=2MO;UNTIL=20260201', '2026-02-01', { seriesStart: '2026-01-12' });
  assert.equal(result, null, 'Feb 9 is after the Feb 1 UNTIL cutoff');
});

// -------------------------------------------------------------------------
// hasAnyOccurrence / seriesStartFor: an unsynchronized DTSTART
// -------------------------------------------------------------------------

test('hasAnyOccurrence: a DTSTART that does not itself land on the ordinal day still has occurrences', () => {
  assert.equal(hasAnyOccurrence('2026-01-05', 'FREQ=MONTHLY;BYDAY=2MO'), true);
});

test('seriesStartFor: an unsynchronized DTSTART resolves to the real first occurrence, same guarantee as BYMONTHDAY=-1', () => {
  assert.equal(seriesStartFor('2026-01-05', 'FREQ=MONTHLY;BYDAY=2MO'), '2026-01-12');
  // Already-synchronized DTSTART is returned unchanged.
  assert.equal(seriesStartFor('2026-01-12', 'FREQ=MONTHLY;BYDAY=2MO'), '2026-01-12');
});
