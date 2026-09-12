/**
 * Module: Waste collection ICS import (pure)
 * Purpose: convert server/services/ics-parser.js VEVENTs into preview
 *          candidates, normalize labels, suggest mappings, and compute a
 *          content digest (#1063 Phase 3). No Express, no database handle -
 *          server/services/waste-store.js loads/saves rows and calls into
 *          this file only. Never parses ICS independently; ics-parser.js
 *          remains the one RFC 5545 implementation in this codebase.
 */

import crypto from 'node:crypto';
import { parseICS, normalizeRecurrenceOverrides, expandRRULE } from './ics-parser.js';
import { shiftDateKey, utcToWall } from '../utils/timezone.js';
import { MAX_UPLOAD_BYTES } from '../utils/upload-limit.js';

export const MAX_ICS_BYTES = MAX_UPLOAD_BYTES;

// A file import is a bounded, one-shot read, not a periodic sync (that's
// Phase 7's URL source). The window is generous enough to cover "import a
// fresh annual file mid-year, it still lists a few already-past dates" and a
// full forward horizon, but it is still an explicit, measured cap
// (invariant #8) - never an unbounded scan driven by the file's own RRULEs.
export const IMPORT_WINDOW_PAST_DAYS = 366;
export const IMPORT_WINDOW_FUTURE_DAYS = 731;

// Sized generously above any real municipal waste calendar (typically a
// handful of types x roughly fifty pickups a year): large enough that a
// legitimate file never gets close, small enough that a malformed or
// adversarial file fails fast with an honest diagnostic instead of grinding
// the process. Exceeding a cap REJECTS the whole import - it is never
// silently truncated into a plausible-looking partial calendar (invariant #8).
export const MAX_VEVENTS = 5000;
export const MAX_DISTINCT_LABELS = 200;
export const MAX_CANDIDATE_INSTANCES = 5000;

export class WasteImportError extends Error {
  constructor(message, code = 'import_error') {
    super(message);
    this.name = 'WasteImportError';
    this.code = code;
  }
}

/** sha256 of the raw ICS text - stored as the source's content_hash. NOT used for the commit
 * concurrency guard (see computeReviewDigest) - a URL source's preview and commit each fetch the
 * text independently, and a feed whose bytes change on every request (e.g. a DTSTAMP carrying the
 * request time) would never match itself byte-for-byte between the two fetches. */
export function computeDigest(icsText) {
  return crypto.createHash('sha256').update(icsText, 'utf8').digest('hex');
}

/**
 * sha256 of what a preview actually SHOWS a reviewer (candidates/labels/diagnostics), not of the
 * raw bytes behind it. Used as the commit concurrency guard: two fetches of the same underlying
 * feed that differ only in volatile bytes irrelevant to the parsed result (a request-time DTSTAMP,
 * incidental whitespace, ...) still produce the same review digest, so a URL source doesn't get
 * stuck refusing every commit with "content changed since you last previewed it" purely because it
 * was fetched twice. A genuine content change - a different candidate, label, or diagnostic - does
 * change the digest, so the guard still does its real job.
 */
export function computeReviewDigest({ candidates, labels, diagnostics }) {
  const candidateLines = candidates
    .map((c) => `${c.identity_key}|${c.normalized_label}|${c.date_key}`)
    .sort();
  const labelLines = labels
    .map((l) => `${l.normalized_label}|${l.original_label}|${l.count}`)
    .sort();
  const diagnosticLines = diagnostics
    .map((d) => `${d.severity}|${d.code}|${d.event_key ?? ''}|${d.count ?? ''}|${d.message ?? ''}`)
    .sort();
  const canonical = JSON.stringify({ candidates: candidateLines, labels: labelLines, diagnostics: diagnosticLines });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function baseNormalizeLabel(label) {
  return String(label || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// A trailing "*" or a single trailing "(...)" group is very often a footnote
// marker, not part of the waste type's own name - German municipal calendars
// commonly flag one instance of an otherwise-ordinary type (a holiday-shifted
// pickup, a rescheduled date, ...) this way, each provider in its own
// wording ("Bioabfall *" at aha-region.de, "Altpapier (verschoben)" at
// others - #1063 live reports). Hardcoding every provider's own marker text
// does not scale, so this only strips one when doing so lands on ANOTHER
// label this same file already uses unmarked - the annotated form is then
// unambiguously the same type, not a guess. A label with no unmarked sibling
// (e.g. a genuinely distinct qualifier the file never uses bare) is left
// alone; the mapping step's "create new" name field remains the household's
// own manual merge tool for anything this heuristic does not catch.
function stripTrailingAnnotation(baseLabel) {
  const asteriskStripped = baseLabel.replace(/\s*\*+$/, '').trim();
  if (asteriskStripped !== baseLabel) return asteriskStripped;
  const parenStripped = baseLabel.replace(/\s*\([^()]*\)$/, '').trim();
  if (parenStripped !== baseLabel) return parenStripped;
  return baseLabel;
}

/**
 * Builds a `rawLabel -> canonical normalized_label` resolver (see
 * stripTrailingAnnotation). `anchors` are the base-normalized forms an
 * annotated label is allowed to fold into: every other label this same file
 * already uses unmarked, PLUS every existing waste type's own name - a type
 * the household already has is just as trustworthy a match as a sibling
 * label in the same file (this is also what lets a single annotated
 * instance, alone in its own file, still resolve onto an existing type).
 */
function canonicalLabelResolver(rawLabels, existingTypeNames = []) {
  const anchors = new Set([...rawLabels, ...existingTypeNames].map(baseNormalizeLabel));
  return (rawLabel) => {
    const base = baseNormalizeLabel(rawLabel);
    const stripped = stripTrailingAnnotation(base);
    return stripped !== base && anchors.has(stripped) ? stripped : base;
  };
}

// Some providers set an identical, generic CATEGORIES value on every single
// VEVENT (e.g. "Abfuhrkalender" - the calendar's own name, not a waste type)
// and put the real, varying waste type only in SUMMARY ("Abfuhr Bioabfall",
// "Abfuhr Gelbe Tonne", ... - #1063 live report). Always preferring CATEGORIES
// there collapsed every type into one label and the import caught nothing.
// Decided once for the whole file, never per event, so labels never mix
// sources within the same import; a file whose CATEGORIES genuinely does
// distinguish (or where SUMMARY doesn't distinguish any better) keeps the
// original CATEGORIES-first behavior unchanged.
function chooseLabelSource(events) {
  const distinctCategories = new Set(events.map((e) => e.categories?.[0]).filter(Boolean).map(baseNormalizeLabel));
  const distinctSummaries = new Set(events.map((e) => e.summary).filter(Boolean).map(baseNormalizeLabel));
  return distinctCategories.size <= 1 && distinctSummaries.size > distinctCategories.size ? 'summary' : 'categories';
}

function labelTextFor(event, source) {
  const primary = source === 'summary' ? event.summary : event.categories?.[0];
  const fallback = source === 'summary' ? event.categories?.[0] : event.summary;
  return (primary || fallback || '').trim() || '(untitled)';
}

/** Deterministic fallback identity for a UID-less event: content-based, not positional, so it is stable across re-imports of the same file. */
function fingerprintIdentity(normalizedLabel, dateKey) {
  return `fp:${crypto.createHash('sha256').update(`${normalizedLabel}|${dateKey}`).digest('hex').slice(0, 24)}`;
}

function tzNoteFor(event) {
  if (event.allDay) return 'all-day';
  if (event.tzid) return `TZID ${event.tzid}`;
  if (event.dtstart?.endsWith('Z')) return 'UTC';
  return 'floating (no timezone in source)';
}

function isUnboundedRecurrence(rrule) {
  // (^|;) not just ';' - an RRULE beginning with UNTIL=/COUNT= (RFC 5545 does
  // not mandate FREQ first, only that it appear exactly once) had no leading
  // semicolon to match against and was misclassified as unbounded, raising a
  // false blocking diagnostic on an otherwise perfectly bounded recurrence.
  return !!rrule && !/(^|;)(UNTIL=|COUNT=)/.test(rrule);
}

/**
 * Which household-local DAY is this VEVENT's pickup on?
 *
 * ics-parser.js normalizes a timed DTSTART to a UTC instant - `...Z` stays as
 * it is, a `TZID=` form is converted (formatICSDate -> tzLocalToUTC). Slicing
 * the first ten characters off that instant therefore yields the UTC calendar
 * day, which is NOT the household's day whenever the local wall clock and UTC
 * fall either side of midnight. A Berlin pickup at `TZID=Europe/Berlin` 00:30
 * on 2027-07-01 is stored as 2027-06-30T22:30:00Z and used to import as JUNE
 * 30th - a whole day early, silently, for every early-morning pickup in a
 * zone ahead of UTC (which includes every German municipal calendar this
 * importer exists for).
 *
 * The three DTSTART shapes need three different answers:
 *  - `YYYY-MM-DD` (all-day / VALUE=DATE): already a calendar day, and RFC 5545
 *    says a DATE has no zone at all. Converting it would invent one.
 *  - `...Z` (an instant, from `Z` or from TZID): the real fix - ask what day
 *    that instant falls on in the household's zone.
 *  - `YYYY-MM-DDTHH:MM:SS` (floating, no zone in the source): RFC 5545 floating
 *    time means "whatever the local clock reads", so the date part is already
 *    the intended local day. Converting it would be the same off-by-one in
 *    reverse.
 */
function pickupDateKey(dtstart, timeZone) {
  const value = String(dtstart || '');
  if (!value.includes('T')) return value.slice(0, 10);
  if (!value.endsWith('Z')) return value.slice(0, 10);
  return utcToWall(value, timeZone)?.date ?? value.slice(0, 10);
}

/**
 * Parses `icsText` and builds the full preview: candidate pickup instances,
 * per-label mapping suggestions, and diagnostics. Blocking diagnostics
 * (unbounded recurrence, unsupported RDATE) always exclude their event's
 * instances from `candidates` - the caller decides whether to allow a commit
 * to proceed with those events explicitly skipped (`skipEventKeys`) or to
 * refuse the commit while any blocking diagnostic remains unresolved.
 *
 * @param {string} icsText
 * @param {object} opts
 * @param {string} opts.today YYYY-MM-DD, the household-local "today" the import window is anchored to
 * @param {string} [opts.timeZone] IANA zone the pickup DAY is decided in (see pickupDateKey).
 *   Defaults to UTC so this stays a pure function; waste-store.js passes the household zone.
 * @param {object[]} [opts.existingTypes] `{id, name}` rows, for mapping suggestions
 * @param {Map<string,{type_id:number|null, ignored:boolean, original_label:string}>} [opts.existingMappings] normalized_label -> remembered decision (re-import)
 * @returns {object} preview - `diagnostics` entries with `severity: 'blocking'` carry an
 *   `event_key`; the caller (waste-store.js#commitImport) decides whether an
 *   explicit `skipEventKeys` list covers every blocking key before allowing a commit.
 */
export function buildImportPreview(icsText, {
  today, timeZone = 'UTC', existingTypes = [], existingMappings = new Map(),
} = {}) {
  if (typeof icsText !== 'string' || !icsText.trim()) {
    throw new WasteImportError('An ICS file is required.', 'empty_file');
  }
  if (Buffer.byteLength(icsText, 'utf8') > MAX_ICS_BYTES) {
    throw new WasteImportError(`The file exceeds the ${Math.round(MAX_ICS_BYTES / (1024 * 1024))} MB upload limit.`, 'file_too_large');
  }

  const skipped = [];
  const rawEvents = parseICS(icsText, { allowMissingUid: true, onSkip: (info) => skipped.push(info) });

  if (rawEvents.length > MAX_VEVENTS) {
    throw new WasteImportError(`The file contains more than ${MAX_VEVENTS} calendar entries; split it into smaller files.`, 'event_cap_exceeded');
  }

  // Correlate UID-based recurrence overrides (RECURRENCE-ID) the same way
  // every other ICS consumer in this app does. UID-less events cannot be
  // correlated this way by definition (RECURRENCE-ID targets a UID) and are
  // passed through untouched.
  const withUid = rawEvents.filter((e) => e.uid);
  const withoutUid = rawEvents.filter((e) => !e.uid);
  const normalizedWithUid = normalizeRecurrenceOverrides(withUid);
  const allEvents = [...normalizedWithUid, ...withoutUid];

  const windowStart = shiftDateKey(today, -IMPORT_WINDOW_PAST_DAYS);
  const windowEnd = shiftDateKey(today, IMPORT_WINDOW_FUTURE_DAYS);

  // Decided once for the whole file - see chooseLabelSource/canonicalLabelResolver.
  const labelSource = chooseLabelSource(allEvents);
  const resolveCanonicalLabel = canonicalLabelResolver(
    allEvents.map((e) => labelTextFor(e, labelSource)),
    existingTypes.map((t) => t.name),
  );

  const diagnostics = [];
  let cancelledCount = 0;
  let fallbackIdentityCount = 0;

  const candidatesByIdentity = new Map();
  let duplicateInstanceCount = 0;

  allEvents.forEach((event, index) => {
    const eventKey = event.uid ? `uid:${event.uid}` : `noUid:${index}`;

    if ((event.status || '') === 'CANCELLED') { cancelledCount++; return; }

    if (event.hasRDate) {
      diagnostics.push({
        severity: 'blocking', code: 'unsupported_rdate', event_key: eventKey,
        // `name` is the event's own title (falling back to its key) for a
        // CLIENT-side translated rendering (public/pages/waste.js); `message`
        // stays the English sentence a server-side 400 uses verbatim when a
        // blocking diagnostic goes unresolved into commitImport (both
        // channels need the same underlying fact, in different shapes).
        name: event.summary || eventKey,
        message: `"${event.summary || eventKey}" uses RDATE, which this importer does not expand.`,
      });
    }
    if (isUnboundedRecurrence(event.rrule)) {
      diagnostics.push({
        severity: 'blocking', code: 'unbounded_recurrence', event_key: eventKey,
        name: event.summary || eventKey,
        message: `"${event.summary || eventKey}" repeats without an end (no COUNT or UNTIL), so it cannot be safely expanded.`,
      });
    }
    // A blocking event contributes zero candidates either way - explicitly
    // skipping it only decides whether the *rest* of the file may still
    // commit (see the unresolved-diagnostic check in waste-store.js).
    if (event.hasRDate || isUnboundedRecurrence(event.rrule)) return;

    const label = labelTextFor(event, labelSource);
    const normalizedLabel = resolveCanonicalLabel(label);
    if (!event.uid) fallbackIdentityCount++;

    const pushInstance = (dateKey) => {
      if (dateKey < windowStart || dateKey > windowEnd) return;
      const identityKey = event.uid ? `uid:${event.uid}::${dateKey}` : fingerprintIdentity(normalizedLabel, dateKey);
      if (candidatesByIdentity.has(identityKey)) { duplicateInstanceCount++; return; }
      candidatesByIdentity.set(identityKey, {
        identity_key: identityKey,
        external_uid: event.uid || null,
        original_summary: event.summary || null,
        label,
        normalized_label: normalizedLabel,
        date_key: dateKey,
        tz_note: tzNoteFor(event),
      });
    };

    if (event.rrule) {
      for (const inst of expandRRULE(event, windowStart, windowEnd)) pushInstance(pickupDateKey(inst.dtstart, timeZone));
    } else if (event.dtstart) {
      pushInstance(pickupDateKey(event.dtstart, timeZone));
    }
  });

  const candidates = [...candidatesByIdentity.values()];
  if (candidates.length > MAX_CANDIDATE_INSTANCES) {
    throw new WasteImportError(`The file expands to more than ${MAX_CANDIDATE_INSTANCES} pickup dates; split it into smaller files.`, 'instance_cap_exceeded');
  }

  if (skipped.length) {
    diagnostics.push({ severity: 'info', code: 'skipped_unparsable', count: skipped.length, message: `${skipped.length} calendar entries were skipped (missing or unparsable start date).` });
  }
  if (cancelledCount) {
    diagnostics.push({ severity: 'info', code: 'cancelled_excluded', count: cancelledCount, message: `${cancelledCount} cancelled calendar entries were excluded.` });
  }
  if (fallbackIdentityCount) {
    diagnostics.push({ severity: 'info', code: 'missing_uid_fallback', count: fallbackIdentityCount, message: `${fallbackIdentityCount} calendar entries had no UID; a fallback identity based on label and date was used.` });
  }
  if (duplicateInstanceCount) {
    diagnostics.push({ severity: 'info', code: 'duplicate_instance', count: duplicateInstanceCount, message: `${duplicateInstanceCount} duplicate pickup instances (same identity) were collapsed into one.` });
  }

  // Group by label for the mapping step. suggested_type_id is a same-name
  // (case-insensitive) match against an existing type - a convenience
  // default, never a silent auto-decision; every label still needs an
  // explicit decision to commit.
  const labelGroups = new Map();
  for (const c of candidates) {
    if (!labelGroups.has(c.normalized_label)) {
      labelGroups.set(c.normalized_label, { normalized_label: c.normalized_label, original_label: c.label, count: 0, sample_summary: c.original_summary });
    }
    labelGroups.get(c.normalized_label).count++;
  }
  if (labelGroups.size > MAX_DISTINCT_LABELS) {
    throw new WasteImportError(`The file contains more than ${MAX_DISTINCT_LABELS} distinct labels; this is almost always a parsing mismatch rather than genuinely that many waste types.`, 'label_cap_exceeded');
  }

  const typesByLowerName = new Map(existingTypes.map((t) => [t.name.trim().toLowerCase(), t.id]));
  const labels = [...labelGroups.values()].map((g) => {
    const remembered = existingMappings.get(g.normalized_label) ?? null;
    return {
      ...g,
      suggested_type_id: typesByLowerName.get(g.normalized_label) ?? null,
      remembered_type_id: remembered?.type_id ?? null,
      remembered_ignored: remembered?.ignored ?? false,
    };
  }).sort((a, b) => a.normalized_label.localeCompare(b.normalized_label));

  const dateKeys = candidates.map((c) => c.date_key).sort();
  const coverage = dateKeys.length ? { start: dateKeys[0], end: dateKeys[dateKeys.length - 1] } : { start: null, end: null };

  return {
    digest: computeReviewDigest({ candidates, labels, diagnostics }),
    coverage,
    counts: { events: rawEvents.length, candidates: candidates.length, distinct_labels: labels.length },
    diagnostics,
    labels,
    candidates,
  };
}

export const __test = {
  normalizeLabel: baseNormalizeLabel, stripTrailingAnnotation, chooseLabelSource, labelTextFor,
  fingerprintIdentity, isUnboundedRecurrence,
};
