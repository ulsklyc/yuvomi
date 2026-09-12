/**
 * Modul: Waste collection ICS import (pure) (#1063 Phase 3)
 * Zweck: server/services/waste-import.js's buildImportPreview/computeDigest -
 *        label/candidate normalization, fallback identity, tz_note,
 *        diagnostics (info and blocking), and the measured work caps. Two
 *        anonymized provider fixture families (CATEGORIES+UID vs
 *        SUMMARY-only+no-UID) stand in for real municipal ICS exports.
 * Ausführen: npm run test:waste-import
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildImportPreview, computeDigest, WasteImportError,
  MAX_VEVENTS, MAX_ICS_BYTES, MAX_DISTINCT_LABELS, MAX_CANDIDATE_INSTANCES, IMPORT_WINDOW_PAST_DAYS,
} from '../server/services/waste-import.js';
import { shiftDateKey } from '../server/utils/timezone.js';

const TODAY = '2026-06-15';

function vcalendar(events) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('\r\n')}\r\nEND:VCALENDAR`;
}

// -------------------------------------------------------------------------
// Provider A: real UID per instance, CATEGORIES carries the waste type.
// -------------------------------------------------------------------------

function providerAFixture() {
  return vcalendar([
    'BEGIN:VEVENT\r\nUID:provA-1@muni.example\r\nSUMMARY:Abfuhr\r\nCATEGORIES:Restmüll\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT',
    'BEGIN:VEVENT\r\nUID:provA-2@muni.example\r\nSUMMARY:Abfuhr\r\nCATEGORIES:Restmüll\r\nDTSTART;VALUE=DATE:20260715\r\nEND:VEVENT',
    'BEGIN:VEVENT\r\nUID:provA-3@muni.example\r\nSUMMARY:Abfuhr\r\nCATEGORIES:Papier\r\nDTSTART;VALUE=DATE:20260703\r\nEND:VEVENT',
  ]);
}

// -------------------------------------------------------------------------
// Provider B: no UID at all, no CATEGORIES - SUMMARY is the label, a bounded
// weekly RRULE covers the whole run instead of one VEVENT per date.
// -------------------------------------------------------------------------

function providerBFixture() {
  return vcalendar([
    'BEGIN:VEVENT\r\nSUMMARY:Bio-Tonne\r\nDTSTART;VALUE=DATE:20260706\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEND:VEVENT',
  ]);
}

test('computeDigest: identical content hashes identically; any byte change hashes differently', () => {
  const a = computeDigest('hello');
  const b = computeDigest('hello');
  const c = computeDigest('hellO');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('Provider A: two distinct CATEGORIES labels, real UIDs, all-day dates', () => {
  const preview = buildImportPreview(providerAFixture(), { today: TODAY });
  assert.equal(preview.counts.events, 3);
  assert.equal(preview.counts.candidates, 3);
  assert.equal(preview.labels.length, 2);
  const restmuell = preview.labels.find((l) => l.normalized_label === 'restmüll');
  assert.equal(restmuell.count, 2);
  assert.equal(restmuell.original_label, 'Restmüll');
  const paper = preview.labels.find((l) => l.normalized_label === 'papier');
  assert.equal(paper.count, 1);
  assert.deepEqual(preview.coverage, { start: '2026-07-01', end: '2026-07-15' });
  const dates = preview.candidates.map((c) => c.date_key).sort();
  assert.deepEqual(dates, ['2026-07-01', '2026-07-03', '2026-07-15']);
  for (const c of preview.candidates) {
    assert.equal(c.tz_note, 'all-day');
    assert.ok(c.external_uid, 'Provider A candidates keep their real UID');
    assert.ok(c.identity_key.startsWith('uid:'));
  }
});

test('Provider B: SUMMARY fallback label, no UID, bounded weekly RRULE expands into 4 fallback-identity candidates', () => {
  const preview = buildImportPreview(providerBFixture(), { today: TODAY });
  assert.equal(preview.counts.candidates, 4);
  assert.equal(preview.labels.length, 1);
  assert.equal(preview.labels[0].normalized_label, 'bio-tonne');
  for (const c of preview.candidates) {
    assert.equal(c.external_uid, null);
    assert.ok(c.identity_key.startsWith('fp:'), 'no-UID candidates use the deterministic fingerprint identity');
  }
  const diag = preview.diagnostics.find((d) => d.code === 'missing_uid_fallback');
  assert.ok(diag, 'a missing_uid_fallback diagnostic is reported');
  assert.equal(diag.count, 1, 'the count is per SOURCE EVENT, not per expanded instance');
});

test('fallback identity is stable across two independent parses of the same file (needed to diff a re-import)', () => {
  const p1 = buildImportPreview(providerBFixture(), { today: TODAY });
  const p2 = buildImportPreview(providerBFixture(), { today: TODAY });
  assert.deepEqual(
    p1.candidates.map((c) => c.identity_key).sort(),
    p2.candidates.map((c) => c.identity_key).sort(),
  );
});

test('duplicate instances (same fallback identity_key, two UID-less events with the same label and date) collapse into one candidate with a diagnostic', () => {
  const ics = vcalendar([
    'BEGIN:VEVENT\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:20260801\r\nEND:VEVENT',
    'BEGIN:VEVENT\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:20260801\r\nEND:VEVENT',
  ]);
  const preview = buildImportPreview(ics, { today: TODAY });
  assert.equal(preview.counts.candidates, 1);
  assert.ok(preview.diagnostics.some((d) => d.code === 'duplicate_instance'));
});

test('STATUS:CANCELLED events are excluded with an info diagnostic', () => {
  const ics = vcalendar([
    'BEGIN:VEVENT\r\nUID:cancel@x\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:20260801\r\nSTATUS:CANCELLED\r\nEND:VEVENT',
    'BEGIN:VEVENT\r\nUID:keep@x\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:20260802\r\nEND:VEVENT',
  ]);
  const preview = buildImportPreview(ics, { today: TODAY });
  assert.equal(preview.counts.candidates, 1);
  assert.equal(preview.candidates[0].date_key, '2026-08-02');
  const diag = preview.diagnostics.find((d) => d.code === 'cancelled_excluded');
  assert.equal(diag.count, 1);
});

test('RDATE is a blocking diagnostic and the affected event contributes no candidates', () => {
  const ics = vcalendar([
    'BEGIN:VEVENT\r\nUID:rdate@x\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:20260801\r\nRDATE;VALUE=DATE:20260901\r\nEND:VEVENT',
  ]);
  const preview = buildImportPreview(ics, { today: TODAY });
  assert.equal(preview.counts.candidates, 0);
  const diag = preview.diagnostics.find((d) => d.code === 'unsupported_rdate');
  assert.ok(diag);
  assert.equal(diag.severity, 'blocking');
  assert.equal(diag.event_key, 'uid:rdate@x');
});

test('an RRULE without COUNT or UNTIL is blocked as unbounded recurrence', () => {
  const ics = vcalendar([
    'BEGIN:VEVENT\r\nUID:unbounded@x\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:20260701\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT',
  ]);
  const preview = buildImportPreview(ics, { today: TODAY });
  assert.equal(preview.counts.candidates, 0);
  const diag = preview.diagnostics.find((d) => d.code === 'unbounded_recurrence');
  assert.ok(diag);
  assert.equal(diag.severity, 'blocking');
});

test('an RRULE with UNTIL is bounded and expands normally (not blocking)', () => {
  const ics = vcalendar([
    'BEGIN:VEVENT\r\nUID:until@x\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:20260701\r\nRRULE:FREQ=WEEKLY;UNTIL=20260722\r\nEND:VEVENT',
  ]);
  const preview = buildImportPreview(ics, { today: TODAY });
  assert.ok(preview.candidates.length >= 3);
  assert.ok(!preview.diagnostics.some((d) => d.severity === 'blocking'));
});

test('timezone notes: TZID, UTC, and floating times are each labeled distinctly', () => {
  const ics = vcalendar([
    'BEGIN:VEVENT\r\nUID:tz1@x\r\nSUMMARY:Restmüll\r\nDTSTART;TZID=Europe/Berlin:20260701T060000\r\nEND:VEVENT',
    'BEGIN:VEVENT\r\nUID:tz2@x\r\nSUMMARY:Restmüll\r\nDTSTART:20260702T060000Z\r\nEND:VEVENT',
    'BEGIN:VEVENT\r\nUID:tz3@x\r\nSUMMARY:Restmüll\r\nDTSTART:20260703T060000\r\nEND:VEVENT',
  ]);
  const preview = buildImportPreview(ics, { today: TODAY });
  const byDate = new Map(preview.candidates.map((c) => [c.date_key, c.tz_note]));
  assert.equal(byDate.get('2026-07-01'), 'TZID Europe/Berlin');
  assert.equal(byDate.get('2026-07-02'), 'UTC');
  assert.equal(byDate.get('2026-07-03'), 'floating (no timezone in source)');
});

test('a TZID event just after local midnight lands on ITS local day when the household zone is non-UTC, not the UTC day before', () => {
  // Round-3 review, should-fix 4: no test bound the pickupDateKey fix to a
  // real non-UTC household zone. Berlin midnight 2026-07-01 is
  // 2026-06-30T22:00:00Z - deciding the day in UTC (the pre-fix behaviour,
  // reinstated by `timeZone = 'UTC'` at the top of buildImportPreview) files
  // the pickup one day early. 06:00 fixtures never catch this because they
  // are nowhere near midnight in either zone.
  const ics = vcalendar([
    'BEGIN:VEVENT\r\nUID:midnight@x\r\nSUMMARY:Restmüll\r\nDTSTART;TZID=Europe/Berlin:20260701T000000\r\nEND:VEVENT',
  ]);
  const preview = buildImportPreview(ics, { today: TODAY, timeZone: 'Europe/Berlin' });
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].date_key, '2026-07-01',
    'the household-local day, not the UTC day before (2026-06-30)');
});

test('a label with no CATEGORIES falls back to SUMMARY', () => {
  const ics = vcalendar(['BEGIN:VEVENT\r\nUID:nocat@x\r\nSUMMARY:Gelber Sack\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT']);
  const preview = buildImportPreview(ics, { today: TODAY });
  assert.equal(preview.labels[0].original_label, 'Gelber Sack');
});

test('a trailing "*" footnote marker on one instance\'s SUMMARY does not split it into a second label group (holiday-shifted pickup, e.g. aha-region.de)', () => {
  const ics = vcalendar([
    'BEGIN:VEVENT\r\nUID:h1@x\r\nSUMMARY:Bioabfall\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT',
    'BEGIN:VEVENT\r\nUID:h2@x\r\nSUMMARY:Bioabfall\r\nDTSTART;VALUE=DATE:20260715\r\nEND:VEVENT',
    'BEGIN:VEVENT\r\nUID:h3@x\r\nSUMMARY:Bioabfall *\r\nDTSTART;VALUE=DATE:20260729\r\nEND:VEVENT',
  ]);
  const preview = buildImportPreview(ics, { today: TODAY });
  assert.equal(preview.labels.length, 1, 'the starred instance must join the plain one\'s label group, not open a second');
  assert.equal(preview.labels[0].count, 3);
  assert.equal(preview.labels[0].normalized_label, 'bioabfall');
  // The display text of each instance keeps its own original SUMMARY verbatim
  // (including the asterisk) - only the grouping/matching key is normalized.
  const summaries = preview.candidates.map((c) => c.original_summary).sort();
  assert.deepEqual(summaries, ['Bioabfall', 'Bioabfall *', 'Bioabfall'].sort());
});

test('a trailing "*" also matches an existing type by name, so it does not suggest creating a duplicate', () => {
  const ics = vcalendar(['BEGIN:VEVENT\r\nUID:h4@x\r\nSUMMARY:Restmüll *\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT']);
  const preview = buildImportPreview(ics, {
    today: TODAY, existingTypes: [{ id: 9, name: 'Restmüll' }],
  });
  assert.equal(preview.labels[0].suggested_type_id, 9);
});

// -------------------------------------------------------------------------
// A provider whose CATEGORIES is generic on every event (the real type is
// only in SUMMARY), and whose own annotation convention is a trailing
// "(verschoben)" rather than "*" - reported live from a Hildesheim-region
// feed (#1063). chooseLabelSource()/stripTrailingAnnotation() are general
// mechanisms, not hardcoded to this one provider's wording.
// -------------------------------------------------------------------------

function hildesheimStyleFixture() {
  const ev = (uid, dateKey, summary) => `BEGIN:VEVENT\r\nUID:${uid}@x\r\nCATEGORIES:Abfuhrkalender\r\nSUMMARY:${summary}\r\nDTSTART;VALUE=DATE:${dateKey}\r\nEND:VEVENT`;
  return vcalendar([
    ev('hd1', '20260909', 'Abfuhr Bioabfall'),
    ev('hd2', '20260910', 'Abfuhr Gelbe Tonne'),
    ev('hd3', '20260923', 'Abfuhr Bioabfall'),
    ev('hd4', '20260929', 'Abfuhr Altpapier'),
    ev('hd5', '20261124', 'Abfuhr Altpapier'),
    ev('hd6', '20261221', 'Abfuhr Altpapier (verschoben)'),
  ]);
}

test('chooseLabelSource: a CATEGORIES value identical on every event yields to SUMMARY, which actually distinguishes types', () => {
  const preview = buildImportPreview(hildesheimStyleFixture(), { today: TODAY });
  const names = preview.labels.map((l) => l.original_label).sort();
  assert.deepEqual(names, ['Abfuhr Altpapier', 'Abfuhr Bioabfall', 'Abfuhr Gelbe Tonne'],
    'falling back to the uniform CATEGORIES value would have collapsed all three types into one label');
});

test('chooseLabelSource: a "(verschoben)" instance folds into its unmarked sibling, without hardcoding that specific word', () => {
  const preview = buildImportPreview(hildesheimStyleFixture(), { today: TODAY });
  const altpapier = preview.labels.find((l) => l.original_label === 'Abfuhr Altpapier');
  assert.ok(altpapier, 'the moved instance must not have opened its own "Abfuhr Altpapier (verschoben)" label');
  assert.equal(altpapier.count, 3);
});

test('chooseLabelSource: CATEGORIES that genuinely distinguishes types keeps the original CATEGORIES-first behavior', () => {
  // Regression guard for Provider A (real UID + CATEGORIES carries the type,
  // SUMMARY is uniformly "Abfuhr" for every event) - must not flip to SUMMARY.
  const preview = buildImportPreview(providerAFixture(), { today: TODAY });
  const names = preview.labels.map((l) => l.original_label).sort();
  assert.deepEqual(names, ['Papier', 'Restmüll']);
});

test('an annotated label with no unmarked sibling in the file or existing type stays its own distinct label, not silently merged', () => {
  // Two genuinely different parenthetical qualifiers for the same underlying
  // "Restabfall" bin - real report data. Neither has a bare "Restabfall"
  // anywhere to anchor a merge onto, so both stay separate: an ambiguous
  // substantive difference is left for the household's own manual-merge
  // decision (renaming one "new type" field to match the other), not guessed.
  const ics = vcalendar([
    'BEGIN:VEVENT\r\nUID:r1@x\r\nCATEGORIES:Abfuhrkalender\r\nSUMMARY:Restabfall (14tägige Abfuhr)\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT',
    'BEGIN:VEVENT\r\nUID:r2@x\r\nCATEGORIES:Abfuhrkalender\r\nSUMMARY:Restabfall (14tägige und vierwöchentliche Abfuhr)\r\nDTSTART;VALUE=DATE:20260708\r\nEND:VEVENT',
  ]);
  const preview = buildImportPreview(ics, { today: TODAY });
  assert.equal(preview.labels.length, 2, 'with no bare "Restabfall" to anchor onto, the two qualified forms must not be merged automatically');
});

test('suggested_type_id matches an existing type by case-insensitive name', () => {
  const ics = vcalendar(['BEGIN:VEVENT\r\nUID:s1@x\r\nSUMMARY:restmüll\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT']);
  const preview = buildImportPreview(ics, {
    today: TODAY, existingTypes: [{ id: 42, name: 'Restmüll' }],
  });
  assert.equal(preview.labels[0].suggested_type_id, 42);
});

test('existingMappings prefill remembered_type_id / remembered_ignored for a re-import preview', () => {
  const ics = vcalendar(['BEGIN:VEVENT\r\nUID:r1@x\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT']);
  const preview = buildImportPreview(ics, {
    today: TODAY,
    existingMappings: new Map([['restmüll', { type_id: 7, ignored: false, original_label: 'Restmüll' }]]),
  });
  assert.equal(preview.labels[0].remembered_type_id, 7);
  assert.equal(preview.labels[0].remembered_ignored, false);
});

test('events outside the import window are silently excluded from candidates', () => {
  const ics = vcalendar(['BEGIN:VEVENT\r\nUID:far@x\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:20300701\r\nEND:VEVENT']);
  const preview = buildImportPreview(ics, { today: TODAY });
  assert.equal(preview.counts.candidates, 0);
});

test('rejects an empty file', () => {
  assert.throws(() => buildImportPreview('', { today: TODAY }), WasteImportError);
});

test('rejects a file over the upload byte limit', () => {
  const huge = vcalendar(['BEGIN:VEVENT\r\nUID:huge@x\r\nSUMMARY:X\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT'])
    + '\r\n' + 'X'.repeat(MAX_ICS_BYTES + 1);
  assert.throws(() => buildImportPreview(huge, { today: TODAY }), /file_too_large|exceeds/);
});

test('rejects a file with more VEVENTs than MAX_VEVENTS', () => {
  const events = [];
  for (let i = 0; i < MAX_VEVENTS + 1; i++) {
    events.push(`BEGIN:VEVENT\r\nUID:many-${i}@x\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT`);
  }
  assert.throws(() => buildImportPreview(vcalendar(events), { today: TODAY }), (err) => err.code === 'event_cap_exceeded');
});

test('rejects a file whose distinct labels exceed MAX_DISTINCT_LABELS', () => {
  const events = [];
  for (let i = 0; i < MAX_DISTINCT_LABELS + 1; i++) {
    events.push(`BEGIN:VEVENT\r\nUID:label-${i}@x\r\nSUMMARY:Label-${i}\r\nCATEGORIES:Label-${i}\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT`);
  }
  assert.throws(() => buildImportPreview(vcalendar(events), { today: TODAY }), (err) => err.code === 'label_cap_exceeded');
});

test('rejects a file whose expanded candidate instances exceed MAX_CANDIDATE_INSTANCES', () => {
  // A single RRULE expansion is itself capped (ics-parser.js's own MAX_ITER,
  // and the import window itself), so several distinct bounded VEVENTs -
  // each anchored at the import window's own start, to maximize how many of
  // their instances actually land in-window - are combined to exceed the total.
  const anchor = shiftDateKey(TODAY, -IMPORT_WINDOW_PAST_DAYS).replace(/-/g, '');
  const events = [];
  for (let i = 0; i < 6; i++) {
    events.push(`BEGIN:VEVENT\r\nUID:many-instances-${i}@x\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:${anchor}\r\nRRULE:FREQ=DAILY;COUNT=1500\r\nEND:VEVENT`);
  }
  assert.throws(() => buildImportPreview(vcalendar(events), { today: TODAY }), (err) => err.code === 'instance_cap_exceeded');
});

test('folded lines and an escaped comma inside a CATEGORIES value are unfolded/unescaped before becoming the label', () => {
  // RFC 5545 line folding: a CRLF followed by a single space/tab continues
  // the previous line. "Haus\, Garten" is one label with an escaped comma,
  // not two labels split at the comma.
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:fold@x\r\nSUMMARY:Restmüll\r\nCATEGORIES:Haus\\, Gar\r\n ten\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const preview = buildImportPreview(ics, { today: TODAY });
  assert.equal(preview.labels.length, 1);
  assert.equal(preview.labels[0].original_label, 'Haus, Garten');
});

test('a VEVENT with more than one CATEGORIES tag uses only the first as the label (documented, not a bug)', () => {
  const ics = vcalendar(['BEGIN:VEVENT\r\nUID:multi@x\r\nSUMMARY:Restmüll\r\nCATEGORIES:Restmüll,Sonderabfuhr\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT']);
  const preview = buildImportPreview(ics, { today: TODAY });
  assert.equal(preview.labels.length, 1);
  assert.equal(preview.labels[0].original_label, 'Restmüll');
});
