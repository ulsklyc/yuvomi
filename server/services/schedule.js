/** Resolve schedule patterns without materialising calendar events. */
import { daysBetweenDateKeys, shiftDateKey } from '../utils/timezone.js';
import * as db from '../db.js';

export function cyclePosition(anchorDate, cycleLength, dateKey) {
  const days = daysBetweenDateKeys(anchorDate, dateKey);
  const length = Number(cycleLength);
  if (days === null || !Number.isInteger(length) || length < 1) return null;
  return ((days % length) + length) % length;
}

export function dateKeysInRange(from, to) {
  const count = daysBetweenDateKeys(from, to);
  if (count === null || count < 0) return [];
  return Array.from({ length: count + 1 }, (_, index) => shiftDateKey(from, index));
}

/**
 * Resolve one user's patterns and overrides in an inclusive date window.
 * `patterns` must be ordered by descending valid_from, so the first matching
 * pattern is the documented winner when a user accidentally overlaps them.
 *
 * `patternDays` maps "patternId:position" to an ARRAY of schedule_pattern_days
 * rows, not a single row - a cycle day may carry several classes at different
 * times (a timetable), each its own shift_type_id. An empty/missing array
 * still resolves to exactly one explicit free-day entry (never zero entries),
 * matching what an unset position has always meant.
 */
export function resolveEntries({ from, to, userId, patterns, patternDays, overrides }) {
  const overrideByDate = new Map(overrides.map((row) => [row.date_key, row]));
  const entries = [];
  const warnings = [];
  for (const date_key of dateKeysInRange(from, to)) {
    const override = overrideByDate.get(date_key);
    if (override) {
      entries.push({ user_id: userId, date_key, source: 'override', override_id: override.id, pattern_day_id: null,
        shift_type_id: override.shift_type_id, note: override.note ?? null, is_free: override.shift_type_id == null });
      continue;
    }
    const matches = patterns.filter((pattern) =>
      (!pattern.valid_from || pattern.valid_from <= date_key) && (!pattern.valid_until || pattern.valid_until >= date_key));
    if (!matches.length) continue;
    if (matches.length > 1) warnings.push({ user_id: userId, date_key, pattern_ids: matches.map((p) => p.id) });
    const pattern = matches[0];
    const position = cyclePosition(pattern.anchor_date, pattern.cycle_length, date_key);
    const days = patternDays.get(`${pattern.id}:${position}`) ?? [];
    if (!days.length) {
      entries.push({ user_id: userId, date_key, source: 'pattern', pattern_id: pattern.id, position, pattern_day_id: null,
        shift_type_id: null, note: null, is_free: true });
      continue;
    }
    for (const day of days) {
      entries.push({ user_id: userId, date_key, source: 'pattern', pattern_id: pattern.id, position, pattern_day_id: day.id,
        shift_type_id: day.shift_type_id, note: null, is_free: day.shift_type_id == null });
    }
  }
  return { entries, warnings };
}


export const typeColumns = 'id, name, short_code, start_time, end_time, color, icon, created_by, created_at, updated_at';

// Liefert je Schichttyp-Id die an ihm haengenden Felder (Migration 189), sortiert nach ihrer
// gespeicherten Anzeige-Reihenfolge. Eine Map statt einer flachen Liste, weil der Aufrufer sie
// je Schichttyp-Zeile braucht.
export function fieldsForShiftTypes(typeIds) {
  const map = new Map();
  if (!typeIds.length) return map;
  const rows = db.get().prepare(`
    SELECT stf.shift_type_id, cf.id, cf.name, stf.position, stf.show_in_overlay
    FROM schedule_shift_type_fields stf
    JOIN schedule_custom_fields cf ON cf.id = stf.custom_field_id
    WHERE stf.shift_type_id IN (${typeIds.map(() => '?').join(',')})
    ORDER BY stf.shift_type_id, stf.position
  `).all(...typeIds);
  for (const row of rows) {
    if (!map.has(row.shift_type_id)) map.set(row.shift_type_id, []);
    map.get(row.shift_type_id).push({ id: row.id, name: row.name, position: row.position, show_in_overlay: Boolean(row.show_in_overlay) });
  }
  return map;
}

// SQLite begrenzt die Zahl gebundener Platzhalter je Statement (historisch
// 999, neuere Builds bis rund 32766) - ein Haushalt mit genug Overrides/Extras
// wuerde diesen Deckel irgendwann treffen, und ein `prepare()` darueber wirft,
// nicht nur diese eine Anfrage, sondern GET /overrides und GET /extras fuer
// den ganzen Haushalt dauerhaft. 500 pro Los liegt deutlich darunter, auch auf
// dem kleinsten bekannten Limit.
const FIELD_VALUES_CHUNK_SIZE = 500;
/** Batch-Nachschlag ueber mehrere Vorkommen derselben Art, ohne N+1. */
export function fieldValuesFor(entryType, entryIds) {
  const map = new Map();
  if (!entryIds.length) return map;
  for (let i = 0; i < entryIds.length; i += FIELD_VALUES_CHUNK_SIZE) {
    const chunk = entryIds.slice(i, i + FIELD_VALUES_CHUNK_SIZE);
    const rows = db.get().prepare(`SELECT entry_id, custom_field_id, value FROM schedule_custom_field_values WHERE entry_type = ? AND entry_id IN (${chunk.map(() => '?').join(',')})`).all(entryType, ...chunk);
    for (const row of rows) {
      if (!map.has(row.entry_id)) map.set(row.entry_id, {});
      map.get(row.entry_id)[row.custom_field_id] = row.value;
    }
  }
  return map;
}

// EINE Aufloesung fuer alle Abnehmer (GET /entries, ICS-Feed, Reminder-Sync)
// statt je einer Fassung, die bei der naechsten Aenderung auseinanderlaeuft.
// Lebt hier im Service statt in routes/schedule.js, damit der Reminder-Sync
// sie importieren kann, waehrend der Router den Sync importiert - sonst
// entstuende genau der Rueckimport-Zyklus, den routes/schedule-extras.js'
// Kopfkommentar seit jeher vermeidet.
export function scheduleData(from, to, userId) {
  const database = db.get();
  const condition = userId ? 'AND user_id = ?' : '';
  const patterns = database.prepare(`SELECT * FROM schedule_patterns WHERE is_active = 1
    AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until >= ?) ${condition}
    ORDER BY user_id, valid_from DESC, id DESC`).all(...(userId ? [to, from, userId] : [to, from]));
  // Ein Zyklustag kann mehrere Zeilen tragen (Stundenplan, mehrere Klassen am
  // selben Tag) - deshalb ein Array je Schluessel, nicht die letzte Zeile
  // gewinnt wie frueher.
  const patternDays = new Map();
  if (patterns.length) {
    const ids = patterns.map((p) => p.id);
    for (const row of database.prepare(`SELECT * FROM schedule_pattern_days WHERE pattern_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
      const key = `${row.pattern_id}:${row.position}`;
      if (patternDays.has(key)) patternDays.get(key).push(row);
      else patternDays.set(key, [row]);
    }
  }
  const users = userId ? [userId] : database.prepare('SELECT id FROM users ORDER BY id').all().map((row) => row.id);
  const entries = []; const warnings = [];
  for (const memberId of users) {
    const overrides = database.prepare('SELECT * FROM schedule_overrides WHERE user_id = ? AND date_key BETWEEN ? AND ?').all(memberId, from, to);
    const resolved = resolveEntries({ from, to, userId: memberId, patterns: patterns.filter((p) => p.user_id === memberId), patternDays, overrides });
    entries.push(...resolved.entries); warnings.push(...resolved.warnings);
    // Additiv zum Ergebnis von resolveEntries(), nie ein Ersatz dafuer: ein
    // Extra (Bereitschaft neben einer regulaeren Schicht) zaehlt unabhaengig
    // davon, ob der Tag ueberhaupt eine primaere Schicht hat. Deshalb kein
    // Umweg ueber resolveEntries()'s Tag-fuer-Tag-Schleife - eine
    // schedule_extra_shifts-Zeile ist schon eine fertige Tatsache fuer genau
    // dieses Datum, es gibt nichts an ihr aufzuloesen.
    const extras = database.prepare('SELECT * FROM schedule_extra_shifts WHERE user_id = ? AND date_key BETWEEN ? AND ?').all(memberId, from, to);
    for (const row of extras) {
      entries.push({ user_id: memberId, date_key: row.date_key, source: 'extra', extra_id: row.id,
        shift_type_id: row.shift_type_id, note: row.note ?? null, reminder_offset_minutes: row.reminder_offset_minutes, is_free: false });
    }
  }
  const typeIds = [...new Set(entries.map((entry) => entry.shift_type_id).filter(Boolean))];
  const types = new Map();
  if (typeIds.length) for (const row of database.prepare(`SELECT ${typeColumns} FROM schedule_shift_types WHERE id IN (${typeIds.map(() => '?').join(',')})`).all(...typeIds)) types.set(row.id, row);
  // Ein zweiter, unabhaengiger Aufruf gegenueber GET /shift-types - diese
  // Funktion baut ihre eigene types-Map fuer nur die Typen, die im Zeitraum
  // TATSAECHLICH aufgeloest wurden, nicht fuer alle Typen des Haushalts.
  const typeFields = fieldsForShiftTypes(typeIds);
  // Werte je Herkunftsart getrennt nachgeschlagen (ein Aufruf je Art statt
  // N+1 je Eintrag) - welche Id-Spalte zaehlt, haengt von entry.source ab.
  const patternDayValues = fieldValuesFor('pattern_day', entries.filter((e) => e.source === 'pattern' && e.pattern_day_id != null).map((e) => e.pattern_day_id));
  const overrideValues = fieldValuesFor('override', entries.filter((e) => e.source === 'override').map((e) => e.override_id));
  const extraValues = fieldValuesFor('extra_shift', entries.filter((e) => e.source === 'extra').map((e) => e.extra_id));
  const fieldValuesForEntry = (entry) => {
    if (entry.source === 'pattern') return patternDayValues.get(entry.pattern_day_id) ?? {};
    if (entry.source === 'override') return overrideValues.get(entry.override_id) ?? {};
    return extraValues.get(entry.extra_id) ?? {};
  };
  return {
    entries: entries.map((entry) => {
      const type = entry.shift_type_id ? types.get(entry.shift_type_id) : null;
      return {
        ...entry,
        shift_type: type ? { ...type, fields: typeFields.get(type.id) ?? [] } : null,
        crosses_midnight: Boolean(type?.start_time && type?.end_time && type.end_time <= type.start_time),
        field_values: fieldValuesForEntry(entry),
      };
    }),
    warnings,
  };
}
