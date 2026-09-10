/**
 * Module: Waste collection domain (pure)
 * Purpose: recurrence adapter onto server/services/recurrence.js, bounded range
 *          resolution, next-per-type, and provenance-preserving coalescing for
 *          the Waste module (#1063). No Express, no database handle - callers
 *          (waste-store.js) load rows and pass plain objects in.
 */

import { nextOccurrence, matchesRRuleByday } from './recurrence.js';
import { shiftDateKey } from '../utils/timezone.js';
import { str, color as validateColorField, collectErrors } from '../middleware/validate.js';

export const RECURRENCE_KINDS = Object.freeze(['weekly', 'monthly_fixed_day', 'monthly_ordinal_weekday']);
export const WEEKDAY_CODES = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
export const WEEKLY_INTERVAL_MAX = 52;
export const MONTHLY_INTERVAL_MAX = 24;
// -1 (last) or 1-4 (nth) - the same bound server/services/recurrence.js's own
// `bydayOrdinal` accepts, for the same reason: every month has at least four
// of any given weekday, so only these values are ever guaranteed to exist
// (#1063 Phase 9).
export const ORDINAL_WEEKDAY_VALUES = Object.freeze([-1, 1, 2, 3, 4]);

// Matches Schedule's own established ceiling (invariant #7 in PLAN.md) - a
// range read is never allowed to scan an arbitrary multi-year window.
export const OCCURRENCE_RANGE_MAX_DAYS = 731;

// A safety fuse, not a normal limit. Since the walk catches up to the
// requested window in whole rule periods (see catchUpToFloor), the step count
// is bounded by the window itself - a daily series across the 731-day ceiling
// is ~731 steps, and no realistic input comes close to this number.
//
// HITTING IT IS AN ERROR, NOT A LIMIT. It used to return whatever it had
// accumulated so far, which for a weekly schedule anchored in 2010 was NOTHING
// at all: the pickup vanished from the list, the dashboard, the calendar, the
// feed and the reminder scan at once, and the API answered 200 (#1063). A
// wrong-but-plausible empty answer is worse than a loud failure, and PLAN.md
// invariant #8 says as much - every limit is measured and none truncates
// silently.
const MAX_EXPANSION_ITERATIONS = 5000;

/**
 * Raised when a schedule cannot be expanded within MAX_EXPANSION_ITERATIONS.
 * Deliberately NOT a WasteValidationError: the request is fine, the stored
 * schedule is not, so this must surface as a server fault rather than being
 * blamed on the caller.
 */
export class WasteExpansionError extends Error {
  constructor(schedule, from, to) {
    super(`Waste schedule ${schedule?.id ?? '(unsaved)'} could not be expanded for ${from}..${to} `
      + `within ${MAX_EXPANSION_ITERATIONS} steps.`);
    this.name = 'WasteExpansionError';
    this.scheduleId = schedule?.id ?? null;
  }
}

export const DEFAULT_TYPE_ICON = 'trash-2';
export const DEFAULT_TYPE_COLOR = '#22C55E';
export const TYPE_NAME_MAX = 100;
export const NOTE_MAX = 500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateKey(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

function daysBetween(fromKey, toKey) {
  const a = new Date(`${fromKey}T00:00:00Z`).getTime();
  const b = new Date(`${toKey}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}

/**
 * Validates a waste type's editable fields. With `partial: true`, only the
 * keys present on `input` are checked/returned (PUT semantics); otherwise all
 * fields are required (POST semantics).
 * @returns {{ value: object, errors: string[] }}
 */
export function validateType(input, { partial = false } = {}) {
  const checks = [];
  const value = {};

  if (!partial || input.name !== undefined) {
    const v = str(input.name, 'name', { max: TYPE_NAME_MAX });
    checks.push(v);
    value.name = v.value;
  }
  if (!partial || input.icon !== undefined) {
    const v = str(input.icon ?? DEFAULT_TYPE_ICON, 'icon', { max: 60 });
    checks.push(v);
    value.icon = v.value;
  }
  if (!partial || input.color !== undefined) {
    const v = validateColorField(input.color ?? DEFAULT_TYPE_COLOR, 'color');
    checks.push(v);
    value.color = v.value;
  }
  if (input.archived !== undefined) value.archived = input.archived ? 1 : 0;
  if (input.sort_order !== undefined) {
    const n = Number(input.sort_order);
    if (!Number.isInteger(n)) checks.push({ error: 'sort_order must be an integer.' });
    else value.sort_order = n;
  }

  return { value, errors: collectErrors(checks) };
}

/**
 * Validates a one-off pickup's editable fields (type_id is validated by the
 * caller, which is the only place that knows whether it resolves to a row).
 * @returns {{ value: object, errors: string[] }}
 */
export function validateOneOff(input, { partial = false } = {}) {
  const checks = [];
  const value = {};

  if (!partial || input.date !== undefined) {
    if (!isDateKey(input.date)) checks.push({ error: 'date must be a valid YYYY-MM-DD date.' });
    else value.date = input.date;
  }
  if (input.note !== undefined) {
    const v = str(input.note, 'note', { max: NOTE_MAX, required: false });
    checks.push(v);
    value.note = v.value;
  }

  return { value, errors: collectErrors(checks) };
}

/**
 * Structural validation for a schedule's recurrence fields - the same
 * invariants as waste_schedules' CHECK constraints, plus the one thing SQLite
 * can't express: for a fixed month-day (not -1), anchor_date's own day-of-month
 * must equal month_day, because that's what carries the day through
 * recurrence.js's MONTHLY branch (it reads the anchor's day, not a stored
 * BYMONTHDAY, for anything other than "last day of month").
 * @returns {string[]} error messages; empty means valid
 */
export function validateScheduleRecurrence(schedule) {
  const errors = [];
  const { recurrence_kind: kind, anchor_date: anchor, interval, weekdays, month_day: monthDay, valid_until: validUntil } = schedule;

  if (!RECURRENCE_KINDS.includes(kind)) {
    errors.push(`recurrence_kind must be one of: ${RECURRENCE_KINDS.join(', ')}.`);
  }
  if (!isDateKey(anchor)) {
    errors.push('anchor_date must be a valid YYYY-MM-DD date.');
  }
  if (validUntil !== null && validUntil !== undefined && !isDateKey(validUntil)) {
    errors.push('valid_until must be a valid YYYY-MM-DD date.');
  }
  if (isDateKey(anchor) && isDateKey(validUntil) && validUntil < anchor) {
    errors.push('valid_until must not be before anchor_date.');
  }

  if (kind === 'weekly') {
    if (!Number.isInteger(interval) || interval < 1 || interval > WEEKLY_INTERVAL_MAX) {
      errors.push(`interval must be an integer between 1 and ${WEEKLY_INTERVAL_MAX} for a weekly schedule.`);
    }
    const codes = String(weekdays ?? '').split(',').filter(Boolean);
    if (codes.length === 0 || codes.some((c) => !WEEKDAY_CODES.includes(c))) {
      errors.push(`weekdays must be a non-empty list of: ${WEEKDAY_CODES.join(', ')}.`);
    }
    if (monthDay !== null && monthDay !== undefined) {
      errors.push('month_day must not be set for a weekly schedule.');
    }
  } else if (kind === 'monthly_fixed_day') {
    if (!Number.isInteger(interval) || interval < 1 || interval > MONTHLY_INTERVAL_MAX) {
      errors.push(`interval must be an integer between 1 and ${MONTHLY_INTERVAL_MAX} for a monthly schedule.`);
    }
    if (monthDay !== -1 && (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31)) {
      errors.push('month_day must be -1 (last day of month) or an integer between 1 and 31.');
    }
    if (weekdays !== null && weekdays !== undefined) {
      errors.push('weekdays must not be set for a monthly schedule.');
    }
    if (isDateKey(anchor) && Number.isInteger(monthDay) && monthDay >= 1 && monthDay <= 31) {
      const anchorDay = Number(anchor.slice(8, 10));
      if (anchorDay !== monthDay) {
        errors.push('anchor_date must fall on month_day itself (its day-of-month must equal month_day).');
      }
    }
    if (isDateKey(anchor) && monthDay === -1) {
      const [y, m] = anchor.split('-').map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      if (Number(anchor.slice(8, 10)) !== lastDay) {
        errors.push('anchor_date must be the last day of its month when month_day is -1.');
      }
    }
  } else if (kind === 'monthly_ordinal_weekday') {
    if (!Number.isInteger(interval) || interval < 1 || interval > MONTHLY_INTERVAL_MAX) {
      errors.push(`interval must be an integer between 1 and ${MONTHLY_INTERVAL_MAX} for a monthly schedule.`);
    }
    // Reuses `weekdays` (exactly ONE code here, not the CSV list a weekly
    // schedule stores) and `month_day` (the ordinal position, not a day
    // number) - see migration 201's own comment for why no new columns exist.
    const codes = String(weekdays ?? '').split(',').filter(Boolean);
    const singleWeekdayValid = codes.length === 1 && WEEKDAY_CODES.includes(codes[0]);
    if (!singleWeekdayValid) {
      errors.push(`weekdays must be exactly one of: ${WEEKDAY_CODES.join(', ')} for an ordinal-weekday schedule.`);
    }
    const ordinalValid = ORDINAL_WEEKDAY_VALUES.includes(monthDay);
    if (!ordinalValid) {
      errors.push(`month_day must be one of ${ORDINAL_WEEKDAY_VALUES.join(', ')} (the ordinal position: -1 for last, 1-4 for nth) for an ordinal-weekday schedule.`);
    }
    if (isDateKey(anchor) && singleWeekdayValid && ordinalValid) {
      // The same consistency rule monthly_fixed_day's own anchor_date check
      // above enforces: the stored day must actually BE the occurrence it
      // claims to be, not merely a plausible-looking date. Reuses
      // recurrence.js's own ordinal predicate rather than duplicating its
      // date math here.
      if (!matchesRRuleByday(anchor, `FREQ=MONTHLY;BYDAY=${monthDay}${codes[0]}`)) {
        errors.push(`anchor_date must itself be the ${monthDay}${codes[0]} occurrence (the chosen ordinal weekday) of its own month.`);
      }
    }
  }

  return errors;
}

/**
 * Validates an override's dates in isolation (no schedule/range context - the
 * caller is responsible for confirming original_date is really one of the
 * schedule's calculated occurrences).
 * @returns {string[]}
 */
export function validateOverride({ original_date: original, replacement_date: replacement }) {
  const errors = [];
  if (!isDateKey(original)) errors.push('original_date must be a valid YYYY-MM-DD date.');
  if (replacement !== null && replacement !== undefined && !isDateKey(replacement)) {
    errors.push('replacement_date must be a valid YYYY-MM-DD date, or null to skip.');
  }
  if (isDateKey(original) && isDateKey(replacement) && original === replacement) {
    errors.push('replacement_date must differ from original_date.');
  }
  return errors;
}

/**
 * Validates an inclusive occurrence range against the 731-day ceiling
 * (invariant #7). Does not check `from <= to` inclusivity beyond ordering.
 * @returns {string[]}
 */
export function validateRange(from, to) {
  const errors = [];
  if (!isDateKey(from)) errors.push('from must be a valid YYYY-MM-DD date.');
  if (!isDateKey(to)) errors.push('to must be a valid YYYY-MM-DD date.');
  if (errors.length) return errors;
  if (to < from) errors.push('to must not be before from.');
  else if (daysBetween(from, to) + 1 > OCCURRENCE_RANGE_MAX_DAYS) {
    errors.push(`Range must not exceed ${OCCURRENCE_RANGE_MAX_DAYS} days.`);
  }
  return errors;
}

/**
 * Converts a stored schedule row into the RRULE subset recurrence.js
 * understands, plus the anchor date it's evaluated against. valid_until maps
 * onto RRULE's own UNTIL so series-end is enforced by nextOccurrence itself
 * rather than reimplemented here.
 */
export function scheduleToRule(schedule) {
  const until = schedule.valid_until ? `;UNTIL=${schedule.valid_until.replace(/-/g, '')}` : '';
  if (schedule.recurrence_kind === 'weekly') {
    return {
      rrule: `FREQ=WEEKLY;INTERVAL=${schedule.interval};BYDAY=${schedule.weekdays}${until}`,
      anchor: schedule.anchor_date,
    };
  }
  if (schedule.recurrence_kind === 'monthly_ordinal_weekday') {
    return {
      rrule: `FREQ=MONTHLY;INTERVAL=${schedule.interval};BYDAY=${schedule.month_day}${schedule.weekdays}${until}`,
      anchor: schedule.anchor_date,
    };
  }
  const bymonthday = schedule.month_day === -1 ? ';BYMONTHDAY=-1' : '';
  return {
    rrule: `FREQ=MONTHLY;INTERVAL=${schedule.interval}${bymonthday}${until}`,
    anchor: schedule.anchor_date,
  };
}

/**
 * How far back the walk really has to start.
 *
 * The walk must see any occurrence whose ORIGINAL date lies before `from` but
 * whose override moves it into range - and nothing earlier than that. Overrides
 * are a finite, known list, so the earliest date that can still matter is the
 * earliest of `from` and every override's original date.
 */
function expansionFloor(overrides, from) {
  let floor = from;
  for (const o of overrides || []) {
    if (o.original_date && o.original_date < floor) floor = o.original_date;
  }
  return floor;
}

/**
 * Skips whole rule periods from the anchor up to - never past - `floor`.
 *
 * WHY WHOLE PERIODS AND NOT A JUMP TO `floor` ITSELF. Every kind here repeats
 * on a fixed period: 7*interval days for weekly, `interval` months for both
 * monthly kinds, whose day-of-month recurrence.js derives from the ANCHOR
 * rather than from the previous occurrence (so the series does not drift, and
 * month index k always carries the same day). Landing on a period boundary
 * therefore leaves the walk in exactly the phase it would have had if it had
 * counted its way here, one occurrence at a time.
 *
 * An arbitrary date would not. recurrence.js carries the weekly interval in
 * the STEP - the ISO-week-boundary rule at its WEEKLY branch, not the anchor -
 * so seeding an off-period base silently moves which weeks the series lands
 * in. That is why this jumps in periods and lets the loop below do the rest,
 * instead of using fastForward(), which declines BYDAY rules for the same
 * reason.
 *
 * Deliberately lands at or before `floor`: the loop must still be the thing
 * that finds the first in-range occurrence.
 */
function catchUpToFloor(schedule, anchor, floor) {
  if (anchor >= floor) return anchor;

  if (schedule.recurrence_kind === 'weekly') {
    const period = 7 * schedule.interval;
    const steps = Math.floor(daysBetween(anchor, floor) / period);
    return steps > 0 ? shiftDateKey(anchor, steps * period) : anchor;
  }

  const [ay, am, ad] = anchor.split('-').map(Number);
  const [fy, fm] = floor.split('-').map(Number);
  const steps = Math.floor(((fy - ay) * 12 + (fm - am)) / schedule.interval);
  if (steps <= 0) return anchor;

  // 0-based and deliberately allowed past 11: Date.UTC normalises the year
  // rollover itself, which is why no separate year arithmetic appears here.
  const targetMonth = (am - 1) + steps * schedule.interval;
  const lastDay = new Date(Date.UTC(ay, targetMonth + 1, 0)).getUTCDate();

  // The seed has to be a date the series itself would produce. For the ordinal
  // kind the 1st deliberately is not one: recurrence.js resolves the ordinal
  // occurrence WITHIN the base's own month when the base sits before it, so
  // seeding the 1st yields that month's occurrence rather than the next
  // period's - and on the months where the 1st IS the occurrence, the loop's
  // own matchesRRuleByday check picks it up instead.
  let day;
  if (schedule.recurrence_kind === 'monthly_ordinal_weekday') day = 1;
  else if (schedule.month_day === -1) day = lastDay;
  else day = Math.min(ad, lastDay);

  return new Date(Date.UTC(ay, targetMonth, day)).toISOString().slice(0, 10);
}

/**
 * All of a schedule's occurrences whose EFFECTIVE date (after applying any
 * override) falls within [from, to] - inclusive on both ends.
 *
 * Walks from the schedule's own anchor rather than from `from`, so a move or
 * skip whose ORIGINAL calculated date sits before `from` (e.g. last week's
 * pickup, moved forward into this week) is still found - but catches up to
 * that starting point in whole rule periods rather than one occurrence at a
 * time, so the cost is set by the requested window and not by how old the
 * schedule is. Once the walk position itself passes `to`, later originals are
 * not considered, so an override moving a date from beyond `to` back into
 * range is a deliberate, documented limitation (real usage only ever nudges a
 * pickup by days).
 *
 * @param {object} schedule
 * @param {Array<{original_date:string, replacement_date:string|null}>} overrides
 * @param {string} from YYYY-MM-DD
 * @param {string} to   YYYY-MM-DD
 * @returns {Array<{date_key:string, original_date:string|null, moved:boolean}>}
 * @throws {WasteExpansionError} rather than returning a partial result
 */
export function expandSchedule(schedule, overrides, from, to) {
  const overridesByOriginal = new Map((overrides || []).map((o) => [o.original_date, o]));
  const { rrule, anchor } = scheduleToRule(schedule);
  const result = [];
  const until = schedule.valid_until || null;

  let currentDate = catchUpToFloor(schedule, anchor, expansionFloor(overrides, from));
  let iterations = 0;

  while (currentDate && currentDate <= to) {
    if (iterations++ >= MAX_EXPANSION_ITERATIONS) throw new WasteExpansionError(schedule, from, to);

    // The catch-up above can seed a date past the series' own end, which the
    // step-by-step walk could never reach (nextOccurrence stops at UNTIL).
    if (until && currentDate > until) break;

    if (!matchesRRuleByday(currentDate, rrule)) {
      const next = nextOccurrence(currentDate, rrule, { anchor });
      if (!next || next <= currentDate) break;
      currentDate = next;
      continue;
    }

    const override = overridesByOriginal.get(currentDate);
    const effectiveDate = override ? override.replacement_date : currentDate;
    if (effectiveDate && effectiveDate >= from && effectiveDate <= to) {
      result.push({
        date_key: effectiveDate,
        original_date: override ? currentDate : null,
        moved: !!override && !!override.replacement_date,
      });
    }

    const next = nextOccurrence(currentDate, rrule, { anchor });
    if (!next || next <= currentDate) break;
    currentDate = next;
  }

  return result;
}

const ORIGIN_KIND_ORDER = { schedule: 0, one_off: 1, import: 2 };

function compareOrigins(a, b) {
  return (ORIGIN_KIND_ORDER[a.kind] ?? 9) - (ORIGIN_KIND_ORDER[b.kind] ?? 9)
    || (a.schedule_id ?? 0) - (b.schedule_id ?? 0)
    || (a.one_off_id ?? 0) - (b.one_off_id ?? 0)
    || (a.source_id ?? 0) - (b.source_id ?? 0);
}

/**
 * Coalesces raw per-origin occurrences that land on the same (type_id,
 * date_key) into one visible WasteOccurrence with ordered provenance
 * (invariant #3) - manual/import overlap can never duplicate a Dashboard or
 * Calendar row.
 * @param {Array<{type_id:number, date_key:string, origin:object}>} rawOccurrences
 * @param {Map<number, object>} typesById
 * @returns {object[]} sorted by date, then type order, then type id
 */
export function coalesceOccurrences(rawOccurrences, typesById) {
  const groups = new Map();
  for (const item of rawOccurrences) {
    const key = `${item.type_id}:${item.date_key}`;
    if (!groups.has(key)) groups.set(key, { type_id: item.type_id, date_key: item.date_key, origins: [] });
    groups.get(key).origins.push(item.origin);
  }

  const occurrences = [...groups.values()].map((group) => {
    const type = typesById.get(group.type_id) ?? null;
    const origins = [...group.origins].sort(compareOrigins);
    return {
      key: `${group.type_id}:${group.date_key}`,
      date_key: group.date_key,
      type_id: group.type_id,
      type_name: type?.name ?? null,
      type_icon: type?.icon ?? null,
      type_color: type?.color ?? null,
      type_sort_order: type?.sort_order ?? 0,
      moved: origins.some((o) => o.moved),
      coalesced: origins.length > 1,
      origins,
      deep_link: `?type=${group.type_id}&date=${group.date_key}`,
    };
  });

  occurrences.sort((a, b) => a.date_key.localeCompare(b.date_key)
    || a.type_sort_order - b.type_sort_order
    || a.type_id - b.type_id);

  return occurrences;
}

/**
 * Resolves the coalesced, provenance-preserving occurrence list for a range.
 * Inactive (paused) schedules contribute nothing; archived types still
 * project whatever their schedules/one-offs produce, so past history and any
 * not-yet-deactivated future occurrences stay visible - archived only blocks
 * deletion (invariant #5) and hides the type from "next per type", not from
 * the range read.
 * @param {object} opts
 * @param {object[]} opts.types
 * @param {object[]} opts.schedules
 * @param {Map<number, Array>} [opts.overridesBySchedule] schedule_id -> overrides[]
 * @param {object[]} opts.oneOffs
 * @param {object[]} [opts.importedPickups] committed import rows (#1063 Phase 3):
 *   `{ type_id, date_key, source_id, source_name, original_summary }`
 * @param {string} opts.from
 * @param {string} opts.to
 * @returns {object[]}
 */
export function resolveOccurrences({ types, schedules, overridesBySchedule, oneOffs, importedPickups, from, to }) {
  const typesById = new Map(types.map((t) => [t.id, t]));
  const raw = [];

  for (const schedule of schedules) {
    if (!schedule.active) continue;
    if (!typesById.has(schedule.type_id)) continue;
    const overrides = overridesBySchedule?.get(schedule.id) ?? [];
    for (const occ of expandSchedule(schedule, overrides, from, to)) {
      raw.push({
        type_id: schedule.type_id,
        date_key: occ.date_key,
        origin: {
          kind: 'schedule',
          schedule_id: schedule.id,
          original_date: occ.original_date,
          moved: occ.moved,
        },
      });
    }
  }

  for (const oneOff of oneOffs ?? []) {
    if (oneOff.date < from || oneOff.date > to) continue;
    if (!typesById.has(oneOff.type_id)) continue;
    raw.push({
      type_id: oneOff.type_id,
      date_key: oneOff.date,
      origin: { kind: 'one_off', one_off_id: oneOff.id, original_date: null, moved: false },
    });
  }

  for (const imported of importedPickups ?? []) {
    if (imported.date_key < from || imported.date_key > to) continue;
    if (!typesById.has(imported.type_id)) continue;
    raw.push({
      type_id: imported.type_id,
      date_key: imported.date_key,
      origin: {
        kind: 'import',
        source_id: imported.source_id,
        source_name: imported.source_name ?? null,
        original_summary: imported.original_summary ?? null,
        original_date: null,
        moved: false,
      },
    });
  }

  return coalesceOccurrences(raw, typesById);
}

/**
 * One next occurrence per active (non-archived) type, at or after `todayKey`,
 * within the same bounded ceiling range reads use - next-per-type does not
 * scan an arbitrary multi-year range (invariant #7).
 * @returns {Array<{type:object, next:object|null}>} sorted by type sort_order, then id
 */
export function nextPerType({ types, schedules, overridesBySchedule, oneOffs, importedPickups, todayKey, horizonDays = OCCURRENCE_RANGE_MAX_DAYS }) {
  const to = shiftDateKey(todayKey, horizonDays - 1);
  const occurrences = resolveOccurrences({ types, schedules, overridesBySchedule, oneOffs, importedPickups, from: todayKey, to });

  const earliestByType = new Map();
  for (const occ of occurrences) {
    if (!earliestByType.has(occ.type_id)) earliestByType.set(occ.type_id, occ);
  }

  return types
    .filter((t) => !t.archived)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    .map((type) => ({ type, next: earliestByType.get(type.id) ?? null }));
}

export { isDateKey };
