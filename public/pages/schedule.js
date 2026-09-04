import { api } from '/api.js';
import { t, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import { todayKey, addLocalDays, startOfLocalWeekKey } from '/utils/date.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';
import { createPageFab, setPageFabAction } from '/utils/fab.js';
import { emptyStateHTML } from '/utils/empty-state.js';
import { wireScrollFade } from '/utils/ux.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';

// ZWEISPALTIG: Schedule is a full-width responsive library and statistics view;
// constraining its row lists to the narrow reading measure would recreate the
// unused desktop column this module intentionally avoids.

let root;
let scheduleFab = null;
let currentUserId = null;
let canManageOthers = false;
let activeView = 'timetable';
let timetableView = 'week';
let timetableUserId = 'all';
let timetableDayIndex = 0;
let timetableWeekStart = startOfLocalWeekKey(todayKey(), 1);
let timetableLoading = false;
let holidayLoading = false;
let state = { users: [], types: [], patterns: [], overrides: [], entries: [], warnings: [], holidayCountries: [], holidaySubdivisions: [], holidays: [], holidayCountry: '', holidaySubdivision: '', holidayFrom: todayKey(), holidayTo: addLocalDays(todayKey(), 1095), holidayUserId: '', holidayShiftTypeId: '' };
let statistics = { userId: null, range: 'current', monthFrom: '', monthTo: '', from: '', to: '', entries: [], bounds: null, loading: false };
// Schichtfarben sind NUTZERFARBEN (freier Waehler im Formular); die Presets
// sind nur Startwerte. Eine Grenze gilt trotzdem: keine davon darf die STIMME
// imitieren. „Spaet" trug #7C3AED - eine Ziffer neben der Marke #6C3AED - und
// der Waehler-Default war die Marke selbst: eine Schicht im Quasi-Markenviolett
// liest sich im Kalender als Systemzustand statt als Inhalt (Eine-Stimme-Regel;
// Critique 2026-08-27 + Detektor design-system-color). Jetzt Magenta fuer die
// Abendschicht, und neue Typen starten auf dem Fruehschicht-Cyan.
// `vacation`/`sick` tragen bewusst KEINE Uhrzeiten (start_time/end_time bleiben
// beide NULL - der CHECK der Tabelle verlangt genau das paarweise): sie sind
// keine Arbeitsschicht, sondern ein Tages-ETIKETT ohne Dauer. Das Datenmodell
// erlaubt das schon seit Migration 165 (ein Schichttyp ohne Zeiten rendert als
// "ganztaegig", clockLabel() oben), nur bot bisher nichts diesen Weg an - eine
// Ausnahme liess sich nur ueber "Freier Tag" (kein Typ) oder eine echte Schicht
// abbilden, nichts dazwischen. Eigene Farben ausserhalb der fuenf Arbeits-Presets:
// Blaugrau fuer Urlaub (Abwesenheit, keine Dringlichkeit), Rot fuer krank
// (der einzige Rot-Ton unter den Presets).
const SHIFT_PRESETS = Object.freeze([
  { key: 'early', shortCode: 'E', startTime: '06:00', endTime: '14:00', color: '#0E7490' },
  { key: 'late', shortCode: 'L', startTime: '14:00', endTime: '22:00', color: '#A21CAF' },
  { key: 'night', shortCode: 'N', startTime: '22:00', endTime: '06:00', color: '#4338CA' },
  { key: 'day', shortCode: 'D', startTime: '08:00', endTime: '16:00', color: '#15803D' },
  { key: 'fullDay', shortCode: '24', startTime: '10:00', endTime: '10:00', color: '#A16207' },
  { key: 'vacation', shortCode: 'V', startTime: null, endTime: null, color: '#475569' },
  { key: 'sick', shortCode: 'S', startTime: null, endTime: null, color: '#B91C1C' },
]);
const SHIFT_COLOR_FALLBACK = SHIFT_PRESETS[0].color;

const option = (value, label, selected = false) => `<option value="${esc(String(value ?? ''))}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
const userName = (id) => state.users.find((user) => Number(user.id) === Number(id))?.display_name
  || state.users.find((user) => Number(user.id) === Number(id))?.username
  || String(id);
const selectedOwner = () => currentUserId ?? state.users[0]?.id ?? '';
const canWrite = (userId) => canManageOthers || Number(userId) === Number(currentUserId);

// Ein Schichttyp gehoert dem Haushalt und nicht einer Person: jeder darf einen
// anlegen, aendern und loeschen nur der Ersteller oder ein Admin. Ein Typ, dessen
// Ersteller nicht mehr da ist, traegt `created_by = null` und liegt bei den Admins.
// Ohne diese Pruefung stuenden Formular und Loeschknopf bei jedem - und endeten
// verlaesslich in 403.
const canEditType = (type) => canManageOthers
  || (type?.created_by != null && Number(type.created_by) === Number(currentUserId));
const clockLabel = (shiftType) => {
  if (!shiftType?.start_time || !shiftType?.end_time) return t('schedule.allDay');
  const crossesDay = shiftType.end_time <= shiftType.start_time;
  const fullDay = shiftType.end_time === shiftType.start_time;
  return `${shiftType.start_time}–${shiftType.end_time}${crossesDay ? ' +1' : ''}${fullDay ? ' · 24 h' : ''}`;
};

async function load() {
  const day = todayKey();
  const weekStart = timetableWeekStart || startOfLocalWeekKey(day, 1);
  const weekEnd = addLocalDays(weekStart, 6);
  const [users, types, patternResult, overrides, entries, preferences, countries] = await Promise.all([
    api.get('/auth/users'),
    api.get('/schedule/shift-types'),
    api.get('/schedule/patterns'),
    api.get('/schedule/overrides'),
    api.get(`/schedule/entries?from=${weekStart}&to=${weekEnd}`),
    getPreferences().catch(() => ({})),
    api.get('/preferences/holidays/countries').catch(() => ({ data: [] })),
  ]);
  const patterns = patternResult.data ?? [];
  const days = await Promise.all(patterns.map((pattern) => api.get(`/schedule/patterns/${pattern.id}/days`)));
  state = {
    users: users.data ?? [],
    types: types.data ?? [],
    patterns: patterns.map((pattern, index) => ({ ...pattern, days: days[index].data ?? [] })),
    overrides: overrides.data ?? [],
    entries: entries.data?.entries ?? [],
    warnings: entries.data?.warnings ?? [],
    holidayCountries: Array.isArray(countries.data) ? countries.data : [],
    holidaySubdivisions: [],
    holidays: [],
    holidayCountry: preferences?.holiday_country ?? '',
    holidaySubdivision: preferences?.holiday_subdivision ?? '',
  };
  if (state.holidayCountry) {
    const subdivisions = await api.get(`/preferences/holidays/subdivisions/${state.holidayCountry}`).catch(() => ({ data: [] }));
    state.holidaySubdivisions = subdivisions.data ?? [];
  }
}

async function loadTimetableWeek() {
  const weekEnd = addLocalDays(timetableWeekStart, 6);
  const entries = await api.get(`/schedule/entries?from=${timetableWeekStart}&to=${weekEnd}`);
  state.entries = entries.data?.entries ?? [];
  state.warnings = entries.data?.warnings ?? [];
}

function monthKey(dateKey = todayKey()) { return dateKey.slice(0, 7); }

function monthBounds(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return null;
  const [year, value] = month.split('-').map(Number);
  if (value < 1 || value > 12) return null;
  const lastDay = new Date(Date.UTC(year, value, 0)).getUTCDate();
  return { from: month + '-01', to: month + '-' + String(lastDay).padStart(2, '0') };
}

function statisticBounds() {
  const current = monthBounds(monthKey());
  if (statistics.range === 'current') return current;
  if (statistics.range === 'months') {
    const first = monthBounds(statistics.monthFrom);
    const last = monthBounds(statistics.monthTo);
    if (!first || !last || first.from > last.from) return null;
    return { from: first.from, to: last.to };
  }
  if (!statistics.from || !statistics.to || statistics.from > statistics.to) return null;
  return { from: statistics.from, to: statistics.to };
}

function shiftMinutes(shiftType) {
  if (!shiftType?.start_time || !shiftType?.end_time) return null;
  const toMinutes = (value) => {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  };
  const start = toMinutes(shiftType.start_time);
  let end = toMinutes(shiftType.end_time);
  if (end <= start) end += 24 * 60;
  return end - start;
}

function formatHours(minutes) {
  const hours = minutes / 60;
  const value = Number.isInteger(hours) ? String(hours) : hours.toFixed(1).replace(/\.0$/, '');
  return t('schedule.hoursValue', { value });
}

function statisticsSummary() {
  const types = new Map();
  let freeDays = 0;
  for (const entry of statistics.entries) {
    if (!entry.shift_type) { freeDays += 1; continue; }
    const id = Number(entry.shift_type.id);
    const item = types.get(id) || { type: entry.shift_type, count: 0, minutes: 0, hasHours: false };
    const minutes = shiftMinutes(entry.shift_type);
    item.count += 1;
    if (minutes != null) { item.minutes += minutes; item.hasHours = true; }
    types.set(id, item);
  }
  const values = [...types.values()].sort((a, b) => b.count - a.count || a.type.name.localeCompare(b.type.name));
  return { values, freeDays, totalCount: values.reduce((total, item) => total + item.count, 0), totalMinutes: values.reduce((total, item) => total + item.minutes, 0) };
}

/**
 * `magnitudeOf` gives the raw number the bar length compares (count or
 * minutes); `valueFor` gives its display string ("9" vs "9 h"). The bar
 * scales relative to the largest item in THIS list, not a fixed axis - a
 * floor keeps the smallest bar visible instead of collapsing to a hairline.
 */
function statisticsRows(items, valueFor, magnitudeOf, emptyLabel) {
  if (!items.length) return '<p class="schedule-stat-empty">' + esc(emptyLabel) + '</p>';
  const max = Math.max(...items.map(magnitudeOf), 1);
  return '<div class="schedule-stat-list">' + items.map((item) => {
    const scale = Math.max(0.03, magnitudeOf(item) / max).toFixed(3);
    const color = esc(item.type.color);
    const name = esc(item.type.short_code ? item.type.short_code + ' · ' + item.type.name : item.type.name);
    return '<div class="schedule-stat-row">'
      + '<div class="schedule-stat-row__head">'
      + '<span class="schedule-swatch" style="--schedule-color:' + color + '"></span>'
      + '<span class="schedule-stat-row__name">' + name + '</span>'
      + '<strong>' + esc(valueFor(item)) + '</strong>'
      + '</div>'
      + '<div class="schedule-stat-row__track"><div class="schedule-stat-row__fill" style="--schedule-color:' + color + '; --bar-scale:' + scale + '"></div></div>'
      + '</div>';
  }).join('') + '</div>';
}

async function refreshStatistics() {
  const bounds = statisticBounds();
  if (!bounds) throw new Error(t('schedule.invalidRange'));
  const userId = statistics.userId || currentUserId;
  const result = await api.get('/schedule/entries?from=' + encodeURIComponent(bounds.from) + '&to=' + encodeURIComponent(bounds.to) + '&user_id=' + encodeURIComponent(userId));
  statistics = { ...statistics, userId: Number(userId), entries: result.data?.entries ?? [], bounds, loading: false };
}

async function activateView(view) {
  activeView = view;
  if (view !== 'statistics') { renderPage(); return; }
  statistics = { ...statistics, entries: [], bounds: null, loading: true };
  renderPage();
  try { await refreshStatistics(); }
  catch (error) {
    statistics = { ...statistics, loading: false };
    window.yuvomi?.showToast(error.data?.error ?? error.message ?? t('common.errorGeneric'), 'danger');
  }
  renderPage();
}

function typeOptions(selected, includeFree = true) {
  const free = includeFree ? option('', t('schedule.freeDay'), selected == null || selected === '') : '';
  return `${free}${state.types.map((type) => option(type.id, type.short_code ? `${type.short_code} · ${type.name}` : type.name, Number(selected) === Number(type.id))).join('')}`;
}

function shiftPresetLabel(key) {
  const labels = {
    early: t('schedule.presets.early'),
    late: t('schedule.presets.late'),
    night: t('schedule.presets.night'),
    day: t('schedule.presets.day'),
    fullDay: t('schedule.presets.fullDay'),
    vacation: t('schedule.presets.vacation'),
    sick: t('schedule.presets.sick'),
  };
  return labels[key] ?? '';
}

function shiftPresetOptions() {
  return option('', t('schedule.presetCustom'), true)
    + SHIFT_PRESETS.map((preset) => option(preset.key, shiftPresetLabel(preset.key))).join('');
}

function applyShiftPreset(form) {
  const selected = SHIFT_PRESETS.find((preset) => preset.key === form.elements.shift_preset?.value);
  if (!selected) return;
  form.elements.name.value = shiftPresetLabel(selected.key);
  form.elements.short_code.value = selected.shortCode;
  form.elements.start_time.value = selected.startTime;
  form.elements.end_time.value = selected.endTime;
  form.elements.color.value = selected.color;
}
function userOptions(selected) {
  return state.users.filter((user) => canManageOthers || Number(user.id) === Number(currentUserId)).map((user) => option(user.id, user.display_name || user.username, Number(selected) === Number(user.id))).join('');
}

function formField(label, control, className = '') {
  return '<div class="form-field ' + className + '"><label class="label">' + esc(label) + '</label>' + control + '</div>';
}

function shiftFields(type = {}) {
  return [
    formField(t('schedule.name'), '<input class="input" required name="name" maxlength="200" value="' + esc(type.name ?? '') + '">'),
    formField(t('schedule.shortCode'), '<input class="input" name="short_code" maxlength="12" value="' + esc(type.short_code ?? '') + '">'),
    formField(t('schedule.color'), '<input class="input form-input--color" required name="color" type="color" value="' + esc(type.color ?? SHIFT_COLOR_FALLBACK) + '">', 'schedule-color-field'),
    formField(t('schedule.startTime'), '<yuvomi-datepicker name="start_time" type="time" label="' + esc(t('schedule.startTime')) + '" value="' + esc(type.start_time ?? '') + '"></yuvomi-datepicker>'),
    formField(t('schedule.endTime'), '<yuvomi-datepicker name="end_time" type="time" label="' + esc(t('schedule.endTime')) + '" value="' + esc(type.end_time ?? '') + '"></yuvomi-datepicker>'),
  ].join('');
}

function patternFields(pattern = {}) {
  const active = pattern.is_active === false || pattern.is_active === 0 ? '' : ' checked';
  return [
    formField(t('schedule.name'), '<input class="input" required name="name" maxlength="200" value="' + esc(pattern.name ?? '') + '">'),
    formField(t('schedule.anchorDate'), '<yuvomi-datepicker required name="anchor_date" type="date" label="' + esc(t('schedule.anchorDate')) + '" value="' + esc(pattern.anchor_date ?? todayKey()) + '"></yuvomi-datepicker>'),
    formField(t('schedule.cycleLength'), '<input class="input" required name="cycle_length" type="number" min="1" max="366" value="' + esc(String(pattern.cycle_length ?? 7)) + '">'),
    formField(t('schedule.validFrom'), '<yuvomi-datepicker name="valid_from" type="date" label="' + esc(t('schedule.validFrom')) + '" value="' + esc(pattern.valid_from ?? '') + '"></yuvomi-datepicker>'),
    formField(t('schedule.validUntil'), '<yuvomi-datepicker name="valid_until" type="date" label="' + esc(t('schedule.validUntil')) + '" value="' + esc(pattern.valid_until ?? '') + '"></yuvomi-datepicker>'),
    '<div class="form-field schedule-active-field"><span class="label">' + esc(t('schedule.active')) + '</span><label class="toggle"><input name="is_active" type="checkbox"' + active + '><span class="toggle__track"></span></label></div>',
  ].join('');
}

function shiftTypeCard(type) {
  const editable = canEditType(type);
  const body = editable
    ? `<form class="schedule-form" data-form="shift-update" data-id="${type.id}">${shiftFields(type)}<div class="schedule-actions"><button class="btn btn--secondary">${esc(t('schedule.save'))}</button><button type="button" class="btn btn--danger" data-action="delete-shift" data-id="${type.id}">${esc(t('schedule.delete'))}</button></div></form>`
    : `<p class="schedule-readonly">${esc(type?.created_by == null
        ? t('schedule.typeOrphaned')
        : t('schedule.typeOwnedBy', { user: userName(type.created_by) }))}</p>`;
  return `<details class="card schedule-details"><summary><span class="schedule-swatch" style="--schedule-color:${esc(type.color)}"></span><span class="u-card-title u-compact">${esc(type.short_code ? `${type.short_code} · ${type.name}` : type.name)}</span> <small>${esc(clockLabel(type))}</small></summary>
    ${body}
  </details>`;
}

function timetableBlockFields(position, block = {}) {
  const blockColor = block.color || '#6C3AED';
  return '<div class="schedule-day-block" data-day="' + position + '">'
    + '<label class="schedule-day-block__field"><span>' + esc(t('schedule.subject')) + '</span><input class="input" data-field="subject" maxlength="200" value="' + esc(block.subject ?? '') + '"></label>'
    + '<label class="schedule-day-block__field"><span>' + esc(t('schedule.startTime')) + '</span><input class="input" data-field="start_time" type="time" value="' + esc(block.start_time ?? '') + '"></label>'
    + '<label class="schedule-day-block__field"><span>' + esc(t('schedule.endTime')) + '</span><input class="input" data-field="end_time" type="time" value="' + esc(block.end_time ?? '') + '"></label>'
    + '<label class="schedule-day-block__field"><span>' + esc(t('schedule.instructor')) + '</span><input class="input" data-field="instructor" maxlength="100" value="' + esc(block.instructor ?? '') + '"></label>'
    + '<label class="schedule-day-block__field"><span>' + esc(t('schedule.room')) + '</span><input class="input" data-field="room" maxlength="100" value="' + esc(block.room ?? '') + '"></label>'
    + '<label class="schedule-day-block__field"><span>' + esc(t('schedule.period')) + '</span><input class="input" data-field="period_number" type="number" min="1" max="30" value="' + esc(block.period_number ?? '') + '"></label>'
    + '<label class="schedule-day-block__field schedule-day-block__color"><span>' + esc(t('schedule.color')) + '</span><span class="schedule-day-block__color-control"><input class="input" data-field="color" type="color" value="' + esc(blockColor) + '"' + (block.color ? '' : ' data-color-null="true"') + '><button type="button" class="btn btn--secondary btn--sm" data-action="clear-block-color">' + esc(t('schedule.clearColor')) + '</button></span></label>'
    + '<label class="schedule-day-block__field schedule-day-block__notes"><span>' + esc(t('schedule.notes')) + '</span><textarea class="input" data-field="notes" rows="1" maxlength="5000">' + esc(block.notes ?? '') + '</textarea></label>'
    + '<select class="input schedule-day-block__type" data-field="shift_type_id" aria-label="' + esc(t('schedule.shiftType')) + '">' + typeOptions(block.shift_type_id) + '</select>'
    + '<button type="button" class="btn btn--danger btn--sm" data-action="remove-block" title="' + esc(t('common.delete')) + '">' + esc(t('common.delete')) + '</button>'
    + '</div>';
}

function patternCard(pattern) {
  const writable = canWrite(pattern.user_id);
  const daysByPosition = new Map();
  pattern.days.forEach((day) => {
    const blocks = daysByPosition.get(Number(day.position)) || [];
    blocks.push(day);
    daysByPosition.set(Number(day.position), blocks);
  });
  const days = Array.from({ length: pattern.cycle_length }, (_, position) => {
    const blocks = daysByPosition.get(position) || [{}];
    return '<section class="schedule-cycle-day" data-cycle-day="' + position + '">'
      + '<div class="schedule-cycle-day__header"><h4>' + esc(t('schedule.cycleDay')) + ' ' + (position + 1) + '</h4>'
      + '<button type="button" class="btn btn--secondary btn--sm" data-action="add-block" data-position="' + position + '">' + esc(t('schedule.addLesson')) + '</button></div>'
      + '<div class="schedule-cycle-day__blocks">' + blocks.map((block) => timetableBlockFields(position, block)).join('') + '</div>'
      + '</section>';
  }).join('');
  return `<details class="card schedule-details" data-pattern="${pattern.id}"><summary><span class="u-card-title u-compact">${esc(pattern.name)}</span> <small>· ${esc(userName(pattern.user_id))}</small></summary>
    ${writable ? `<form class="schedule-form" data-form="pattern-update" data-id="${pattern.id}">${patternFields(pattern)}<button class="btn btn--secondary">${esc(t('schedule.save'))}</button></form>` : ''}
    <h3 class="u-card-title">${esc(t('schedule.cycleDays'))}</h3><div class="schedule-days">${days}</div>
    ${writable ? `<div class="schedule-actions"><button type="button" class="btn btn--secondary" data-action="save-days" data-id="${pattern.id}">${esc(t('schedule.save'))}</button><button type="button" class="btn btn--danger" data-action="delete-pattern" data-id="${pattern.id}">${esc(t('schedule.delete'))}</button></div>` : ''}
  </details>`;
}

/**
 * Fasst zusammenhaengende Tage derselben Person mit derselben Schichtart/Notiz
 * zu EINER Zeile zusammen - reine Anzeige- und Sammelaktions-Ebene, die
 * Tabelle bleibt unveraendert ein Eintrag pro Tag. Ohne das zeigte ein
 * zweiwoechiger "frei"-Bereich vierzehn identische Zeilen und liess sich nur
 * Tag fuer Tag bearbeiten oder loeschen - genau die Muehe, die `overrides/fill`
 * beim Anlegen schon abgenommen hatte (Nutzer-Feedback nach dem Live-Test).
 */
function overrideGroups(overrides = state.overrides) {
  const sorted = [...overrides].sort((a, b) =>
    Number(a.user_id) - Number(b.user_id) || a.date_key.localeCompare(b.date_key));
  const groups = [];
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    const sameSeries = last
      && Number(last.user_id) === Number(row.user_id)
      && ((last.shift_type_id == null && row.shift_type_id == null) || Number(last.shift_type_id) === Number(row.shift_type_id));
    const consecutive = sameSeries && (last.note ?? '') === (row.note ?? '') && addLocalDays(last.to, 1) === row.date_key;
    if (consecutive) {
      last.to = row.date_key;
      last.ids.push(row.id);
    } else {
      groups.push({ user_id: row.user_id, shift_type_id: row.shift_type_id, note: row.note, from: row.date_key, to: row.date_key, ids: [row.id] });
    }
  }
  return groups;
}

/**
 * Was von der ALTEN Spanne ausserhalb der NEUEN liegt - 0 bis 2 Reststuecke
 * (verkuerzt sie an einem Ende, an beiden, oder erweitert sie nur, dann keins).
 * String-Vergleich reicht: YYYY-MM-DD sortiert lexikographisch identisch zur
 * Kalenderordnung, dieselbe Eigenschaft, auf der `date_key >= ?` in den Routen
 * schon beruht.
 */
function rangeDifference(oldFrom, oldTo, newFrom, newTo) {
  const spans = [];
  if (oldFrom < newFrom) {
    const end = addLocalDays(newFrom, -1) < oldTo ? addLocalDays(newFrom, -1) : oldTo;
    if (oldFrom <= end) spans.push({ from: oldFrom, to: end });
  }
  if (oldTo > newTo) {
    const start = addLocalDays(newTo, 1) > oldFrom ? addLocalDays(newTo, 1) : oldFrom;
    if (start <= oldTo) spans.push({ from: start, to: oldTo });
  }
  return spans;
}

// Dieselbe Grammatik wie die Muster- und Schichtarten-Leerzustaende
// (emptyStateHTML) statt eines blossen Absatzes - die drei Tabs derselben
// Seite sollen sich wie ein Modul lesen, nicht wie drei verschiedene.
function emptyOverrideState() {
  return emptyStateHTML({
    icon: 'calendar-clock',
    title: t('schedule.emptyOverridesTitle'),
    description: t('schedule.emptyOverridesDescription'),
    action: { label: t('schedule.createOverride'), icon: 'plus', attrs: { 'data-action': 'open-create', 'data-view': 'overrides' } },
  });
}

function overrideRows() {
  const groups = overrideGroups();
  const rows = groups.length ? '<div class="list-rows">' + groups.map((group) => {
    const type = state.types.find((item) => Number(item.id) === Number(group.shift_type_id));
    const swatchColor = type ? type.color : 'var(--color-border)';
    const typeLabel = type ? (type.short_code ? `${type.short_code} · ${type.name}` : type.name) : t('schedule.freeDay');
    const meta = [userName(group.user_id), typeLabel, group.note].filter(Boolean).join(' · ');
    const label = group.from === group.to ? formatDate(group.from) : `${formatDate(group.from)} – ${formatDate(group.to)}`;
    const actions = canWrite(group.user_id)
      ? '<span class="schedule-override-actions"><button type="button" class="btn btn--secondary" data-action="edit-override" data-from="' + esc(group.from) + '" data-user-id="' + group.user_id + '">' + esc(t('common.edit')) + '</button><button type="button" class="btn btn--danger" data-action="delete-override-range" data-from="' + esc(group.from) + '" data-to="' + esc(group.to) + '" data-user-id="' + group.user_id + '">' + esc(t('schedule.delete')) + '</button></span>'
      : '';
    return '<div class="list-row schedule-override"><span class="schedule-swatch" style="--schedule-color:' + esc(swatchColor) + '"></span><div class="list-row__main"><span class="list-row__name">' + esc(label) + '</span><span class="list-row__meta">' + esc(meta) + '</span></div>' + actions + '</div>';
  }).join('') + '</div>' : emptyOverrideState();
  return renderSchoolHolidayPicker() + rows;
}

function renderSchoolHolidayPicker() {
  const countryOptions = '<option value="">' + esc(t('schedule.selectCountry')) + '</option>'
    + state.holidayCountries.map((country) => '<option value="' + esc(country.isoCode) + '"' + (country.isoCode === state.holidayCountry ? ' selected' : '') + '>' + esc(country.name) + '</option>').join('');
  const subdivisionOptions = '<option value="">' + esc(t('schedule.selectSubdivision')) + '</option>'
    + state.holidaySubdivisions.map((subdivision) => '<option value="' + esc(subdivision.isoCode) + '"' + (subdivision.isoCode === state.holidaySubdivision ? ' selected' : '') + '>' + esc(subdivision.name) + '</option>').join('');
  const memberOptions = state.users.map((user) => option(user.id, userName(user.id), Number(user.id) === Number(state.holidayUserId || selectedOwner()))).join('');
  const holidays = state.holidays.map((holiday) => '<div class="list-row schedule-holiday-row"><div class="list-row__main"><span class="list-row__name">' + esc(holiday.name) + '</span><span class="list-row__meta">' + esc(formatDate(holiday.start_date) + ' – ' + formatDate(holiday.end_date)) + '</span></div><button type="button" class="btn btn--secondary btn--sm" data-action="apply-holiday" data-from="' + esc(holiday.start_date) + '" data-to="' + esc(holiday.end_date) + '">' + esc(t('schedule.addHoliday')) + '</button></div>').join('');
  return '<section class="schedule-holidays card card--padded"><h3 class="u-card-title">' + esc(t('schedule.schoolHolidays')) + '</h3><div class="schedule-holiday-location"><label class="schedule-timetable-filter"><span>' + esc(t('schedule.country')) + '</span><select class="input" data-holiday-country>' + countryOptions + '</select></label><label class="schedule-timetable-filter"><span>' + esc(t('schedule.subdivision')) + '</span><select class="input" data-holiday-subdivision' + (state.holidayCountry ? '' : ' disabled') + '>' + subdivisionOptions + '</select></label><label class="schedule-timetable-filter"><span>' + esc(t('schedule.rangeFrom')) + '</span><input class="input" type="date" data-holiday-from value="' + esc(state.holidayFrom) + '"></label><label class="schedule-timetable-filter"><span>' + esc(t('schedule.rangeTo')) + '</span><input class="input" type="date" data-holiday-to value="' + esc(state.holidayTo) + '"></label><button type="button" class="btn btn--secondary" data-action="load-holidays"' + (state.holidayCountry && !holidayLoading ? '' : ' disabled') + '>' + esc(t('schedule.loadHolidays')) + '</button></div><div class="schedule-holiday-defaults"><label class="schedule-timetable-filter"><span>' + esc(t('schedule.member')) + '</span><select class="input" data-holiday-user>' + memberOptions + '</select></label><label class="schedule-timetable-filter"><span>' + esc(t('schedule.shiftType')) + '</span><select class="input" data-holiday-type>' + typeOptions(state.holidayShiftTypeId) + '</select></label></div>' + (holidays ? '<div class="schedule-holiday-list">' + holidays + '<button type="button" class="btn btn--primary" data-action="apply-all-holidays">' + esc(t('schedule.applyAllHolidays')) + '</button></div>' : '') + '</section>';
}

function renderStatistics() {
  const bounds = statistics.bounds || statisticBounds();
  const summary = statisticsSummary();
  const selectedUser = statistics.userId || currentUserId;
  const range = statistics.range;
  const countItems = [...summary.values];
  if (summary.freeDays) countItems.push({ type: { name: t('schedule.freeDays'), short_code: '', color: 'var(--color-text-secondary)' }, count: summary.freeDays, minutes: 0, hasHours: false });
  const hourItems = summary.values.filter((item) => item.hasHours);
  const controls = range === 'months'
    ? formField(t('schedule.monthFrom'), '<input class="input" required type="month" name="month_from" value="' + esc(statistics.monthFrom || monthKey()) + '">')
      + formField(t('schedule.monthTo'), '<input class="input" required type="month" name="month_to" value="' + esc(statistics.monthTo || monthKey()) + '">')
    : range === 'custom'
      ? formField(t('schedule.validFrom'), '<yuvomi-datepicker required name="from" type="date" label="' + esc(t('schedule.validFrom')) + '" value="' + esc(statistics.from || bounds?.from || todayKey()) + '"></yuvomi-datepicker>')
        + formField(t('schedule.validUntil'), '<yuvomi-datepicker required name="to" type="date" label="' + esc(t('schedule.validUntil')) + '" value="' + esc(statistics.to || bounds?.to || todayKey()) + '"></yuvomi-datepicker>')
      : '';
  // Ohne `bounds` gibt es keine Auswertung, sondern einen ungueltigen Zeitraum:
  // `statisticBounds()` antwortet mit null, `refreshStatistics()` wirft, und der
  // catch-Zweig rendert genau hierher zurueck. Vorher stand da `bounds.from` -
  // ein TypeError, noch bevor der Fehler-Toast lief. Die Seite blieb auf dem
  // vorigen Ergebnis stehen und sagte nichts.
  const results = statistics.loading
    ? '<div class="card card--padded schedule-stat-loading" role="status" aria-live="polite">' + esc(t('common.loading')) + '</div>'
    : !bounds
      ? '<p class="card card--padded schedule-stat-empty" role="status">' + esc(t('schedule.invalidRange')) + '</p>'
      : '<p class="schedule-stat-period u-meta">' + esc(t('schedule.statisticsFor', { user: userName(selectedUser), from: formatDate(bounds.from), to: formatDate(bounds.to) })) + '</p>'
      + '<div class="metric-grid schedule-stat-metrics">'
      + '<article class="metric-card"><div class="metric-card__label">' + esc(t('schedule.shiftCounts')) + '</div><div class="metric-card__value">' + esc(String(summary.totalCount)) + '</div><div class="metric-card__note">' + esc(t('schedule.shifts')) + '</div></article>'
      + '<article class="metric-card"><div class="metric-card__label">' + esc(t('schedule.workedHours')) + '</div><div class="metric-card__value">' + esc(formatHours(summary.totalMinutes)) + '</div><div class="metric-card__note">' + esc(t('schedule.total')) + '</div></article>'
      + '</div>'
      + '<div class="schedule-stat-sections">'
      + '<section class="card card--padded schedule-stat-card"><div><h2 class="u-section-title">' + esc(t('schedule.shiftCounts')) + '</h2><p class="u-meta">' + esc(t('schedule.shiftCountsDescription')) + '</p></div>' + statisticsRows(countItems, (item) => String(item.count), (item) => item.count, t('schedule.noStatistics')) + '<div class="schedule-stat-total"><span>' + esc(t('schedule.total')) + '</span><strong>' + esc(String(summary.totalCount)) + '</strong></div></section>'
      + '<section class="card card--padded schedule-stat-card"><div><h2 class="u-section-title">' + esc(t('schedule.workedHours')) + '</h2><p class="u-meta">' + esc(t('schedule.workedHoursDescription')) + '</p></div>' + statisticsRows(hourItems, (item) => formatHours(item.minutes), (item) => item.minutes, t('schedule.noStatistics')) + '<div class="schedule-stat-total"><span>' + esc(t('schedule.total')) + '</span><strong>' + esc(formatHours(summary.totalMinutes)) + '</strong></div></section>'
      + '</div>';
  return '<section class="schedule-statistics">'
    + '<form class="card card--padded schedule-stat-filters" data-form="statistics">'
    + formField(t('schedule.owner'), '<select class="input" required name="user_id">' + state.users.map((user) => option(user.id, user.display_name || user.username, Number(selectedUser) === Number(user.id))).join('') + '</select>')
    + '<div class="form-field schedule-stat-range"><span class="label">' + esc(t('schedule.statisticsRange')) + '</span><div class="segmented schedule-stat-range__choices" role="group" aria-label="' + esc(t('schedule.statisticsRange')) + '">'
    + [['current', 'schedule.currentMonth'], ['months', 'schedule.selectedMonths'], ['custom', 'schedule.customRange']].map(([value, label]) => '<button type="button" class="segmented__item' + (range === value ? ' is-active' : '') + '" data-action="statistics-range" data-range="' + value + '" aria-pressed="' + (range === value ? 'true' : 'false') + '">' + esc(t(label)) + '</button>').join('')
    + '</div></div>' + (controls ? '<div class="schedule-stat-dates">' + controls + '</div>' : '')
    + '<div class="schedule-stat-filter-actions"><button class="btn btn--primary">' + esc(t('schedule.applyStatistics')) + '</button></div></form>'
    + results + '</section>';
}
function emptyPatternState() {
  return emptyStateHTML({
    icon: 'calendar-clock',
    title: t('schedule.emptyPatternsTitle'),
    description: t('schedule.emptyPatternsDescription'),
    action: { label: t('schedule.addPattern'), icon: 'plus', attrs: { 'data-action': 'open-create', 'data-view': 'patterns' } },
  });
}

// Eine leere Typenliste zwingt sonst dazu, jeden der sieben Presets einzeln ueber
// das Anlegen-Formular durchzuklicken, obwohl der Waehler dort (shiftPresetOptions)
// genau diese sieben Werte schon kennt - der Reibungspunkt war die Wiederholung,
// nicht das Fehlen der Presets selbst. „Schnellstart" bleibt zweite Wahl neben
// dem manuellen Anlegen (Grammatik-Praezedenz: zwei CTAs wie bei einer leeren
// Dokumentensuche), fuer wer lieber sofort einen eigenen Typ benennt.
function emptyShiftTypesState() {
  return emptyStateHTML({
    icon: 'calendar-clock',
    title: t('schedule.emptyShiftTypesTitle'),
    description: t('schedule.emptyShiftTypesDescription'),
    actions: [
      { label: t('schedule.quickStartShiftTypes'), icon: 'sparkles', attrs: { 'data-action': 'quick-start-shifts' } },
      { label: t('schedule.createShiftType'), icon: 'plus', tone: 'secondary', attrs: { 'data-action': 'open-create', 'data-view': 'shifts' } },
    ],
  });
}

function renderToday() {
  const entries = state.entries.filter((entry) => entry.date_key === todayKey());
  if (!entries.length) {
    return state.entries.length
      ? `<p>${esc(t('schedule.emptyToday'))}</p>`
      : `<p>${esc(t('schedule.empty'))}</p>`;
  }
  return `<div class="list-rows">${entries.map((entry) => {
    const type = entry.shift_type;
    const swatchColor = type ? type.color : 'var(--color-border)';
    const name = esc(entry.subject || type?.name || t('schedule.freeDay'));
    const time = entry.start_time || type?.start_time;
    const end = entry.end_time || type?.end_time;
    const details = [
      userName(entry.user_id),
      entry.period_number ? `${entry.period_number}.` : '',
      time && end ? `${time}–${end}` : type ? clockLabel(type) : '',
      entry.instructor,
      entry.room,
        entry.notes,
      ].filter(Boolean).join(' · ');
    const meta = esc(details);
    return `<div class="list-row schedule-entry-row"><span class="schedule-swatch" style="--schedule-color:${esc(swatchColor)}"></span><div class="list-row__main"><span class="list-row__name">${name}</span><span class="list-row__meta">${meta}</span></div></div>`;
  }).join('')}</div>`;
}

function renderTimetable() {
  const startTime = (entry) => entry.start_time || entry.shift_type?.start_time;
  const endTime = (entry) => entry.end_time || entry.shift_type?.end_time;
  const weekdayLabels = [
    t('calendar.dayLongMonday'), t('calendar.dayLongTuesday'),
    t('calendar.dayLongWednesday'), t('calendar.dayLongThursday'),
    t('calendar.dayLongFriday'), t('calendar.dayLongSaturday'),
    t('calendar.dayLongSunday'),
  ];
  const allDays = Array.from({ length: 7 }, (_, index) => {
    const dateKey = addLocalDays(timetableWeekStart, index);
    const entries = state.entries.filter((entry) => entry.date_key === dateKey && startTime(entry));
    const times = [...new Set(entries.map(startTime))].sort();
    return { dateKey, entries, times };
  });
  const selectedEntries = (entries) => timetableUserId === 'all'
    ? entries
    : entries.filter((entry) => Number(entry.user_id) === Number(timetableUserId));
  const days = allDays.map((day) => ({ ...day, entries: selectedEntries(day.entries), times: selectedEntries(day.entries).map(startTime) }));
  const visibleDays = timetableView === 'day' ? [days[timetableDayIndex]] : days;
  const weekLabel = formatDate(timetableWeekStart) + ' – ' + formatDate(addLocalDays(timetableWeekStart, 6));
  const controls = '<div class="schedule-timetable-controls"><div class="schedule-timetable-navigation"><button type="button" class="icon-btn" data-timetable-nav="-7" title="' + esc(t('schedule.previousWeek')) + '"' + (timetableLoading ? ' disabled' : '') + '><i data-lucide="chevron-left"></i></button><strong>' + esc(weekLabel) + '</strong><button type="button" class="icon-btn" data-timetable-nav="7" title="' + esc(t('schedule.nextWeek')) + '"' + (timetableLoading ? ' disabled' : '') + '><i data-lucide="chevron-right"></i></button><button type="button" class="btn btn--secondary btn--sm" data-timetable-today' + (timetableLoading ? ' disabled' : '') + '>' + esc(t('schedule.today')) + '</button></div><label class="schedule-timetable-filter"><span>' + esc(t('schedule.member')) + '</span><select class="input" data-timetable-user><option value="all"' + (timetableUserId === 'all' ? ' selected' : '') + '>' + esc(t('schedule.allMembers')) + '</option>' + state.users.map((user) => '<option value="' + user.id + '"' + (Number(timetableUserId) === Number(user.id) ? ' selected' : '') + '>' + esc(userName(user.id)) + '</option>').join('') + '</select></label><div class="segmented" role="group" aria-label="' + esc(t('schedule.viewMode')) + '">' + [['week', 'schedule.viewWeek'], ['day', 'schedule.viewDay'], ['list', 'schedule.viewList']].map(([view, label]) => '<button type="button" class="segmented__item' + (timetableView === view ? ' is-active' : '') + '" data-timetable-view="' + view + '">' + esc(t(label)) + '</button>').join('') + '</div>' + (timetableView === 'day' ? '<div class="segmented" role="group" aria-label="' + esc(t('schedule.day')) + '">' + days.map((day, index) => '<button type="button" class="segmented__item' + (timetableDayIndex === index ? ' is-active' : '') + '" data-timetable-day="' + index + '">' + esc(formatDate(day.dateKey)) + '</button>').join('') + '</div>' : '') + '</div>';
  const toMinutes = (value) => {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  };
  const visibleEntries = visibleDays.flatMap((day) => day.entries);
  if (!visibleEntries.length) return controls + '<section class="schedule-timetable-empty-state"><p>' + esc(t('schedule.emptyToday')) + '</p></section>';
  const firstHour = Math.floor(Math.min(...visibleEntries.map((entry) => toMinutes(startTime(entry)))) / 60);
  const lastEndHour = Math.ceil(Math.max(...visibleEntries.map((entry) => toMinutes(endTime(entry)))) / 60);
  const times = Array.from({ length: Math.max(1, lastEndHour - firstHour) }, (_, index) => String(firstHour + index).padStart(2, '0') + ':00');
  const cell = (day, memberId, slotStartTime) => day.entries.filter((entry) => Number(entry.user_id) === Number(memberId) && startTime(entry)?.slice(0, 2) === slotStartTime.slice(0, 2)).map((entry) => {
      const type = entry.shift_type;
      const title = entry.subject || type?.name || t('schedule.freeDay');
      const detail = [entry.instructor, entry.room].filter(Boolean).join(' · ');
      const period = entry.period_number ? entry.period_number + '. ' : '';
      return '<div class="schedule-timetable-block" style="--schedule-color:' + esc(entry.color || type?.color || 'var(--module-schedule)') + '"><strong>' + esc(period + title) + '</strong><span>' + esc((startTime(entry) || '') + '–' + (endTime(entry) || '')) + '</span>' + (entry.instructor ? '<small><i data-lucide="user"></i>' + esc(entry.instructor) + '</small>' : '') + (entry.room ? '<small><i data-lucide="map-pin"></i>' + esc(entry.room) + '</small>' : '') + (entry.notes ? '<small class="schedule-timetable-block__note">' + esc(entry.notes) + '</small>' : '') + '</div>';
    }).join('') || '<span class="schedule-timetable-empty">&nbsp;</span>';
  const dayLabels = visibleDays.map((day) => {
    const dayIndex = days.findIndex((item) => item.dateKey === day.dateKey);
    const isToday = day.dateKey === todayKey();
    return '<div class="schedule-timetable__day-header' + (isToday ? ' is-today' : '') + '"><strong>' + esc(weekdayLabels[dayIndex]) + '</strong><span>' + esc(formatDate(day.dateKey)) + '</span>' + (isToday ? '<small>' + esc(t('schedule.today')) + '</small>' : '') + '</div>';
  }).join('');
  const memberIds = timetableUserId === 'all' ? state.users.map((user) => user.id) : [Number(timetableUserId)];
  const currentMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const showNow = currentMinutes >= firstHour * 60 && currentMinutes <= lastEndHour * 60;
  const rows = times.map((time) => '<div class="schedule-timetable__time-row"><span>' + esc(time) + '</span>' + visibleDays.map((day) => '<div>' + memberIds.map((userId) => cell(day, userId, time)).join('') + (day.dateKey === todayKey() && time === times[0] && showNow ? '<span class="schedule-timetable-now" style="top:' + (((currentMinutes - firstHour * 60) / 60) * 6) + 'rem"></span>' : '') + '</div>').join('') + '</div>').join('');
  if (timetableView === 'list') {
    const rows = allDays.map((day) => {
      const dayEntries = selectedEntries(day.entries).sort((a, b) => startTime(a).localeCompare(startTime(b)));
      if (!dayEntries.length) return '';
      return '<section class="schedule-timetable-list-day"><h3>' + esc(formatDate(day.dateKey)) + '</h3><div class="list-rows">' + dayEntries.map((entry) => '<div class="list-row"><div class="list-row__main"><span class="list-row__name">' + esc(entry.period_number ? entry.period_number + '. ' + (entry.subject || entry.shift_type?.name || t('schedule.freeDay')) : (entry.subject || entry.shift_type?.name || t('schedule.freeDay'))) + '</span><span class="list-row__meta">' + esc(startTime(entry) + '–' + endTime(entry) + ' · ' + userName(entry.user_id) + (entry.instructor ? ' · ' + entry.instructor : '') + (entry.room ? ' · ' + entry.room : '')) + '</span></div></div>').join('') + '</div></section>';
    }).join('');
    return controls + (rows || '<p>' + esc(t('schedule.empty')) + '</p>');
  }
  const hasEntries = visibleDays.some((day) => day.entries.length);
  return controls + (hasEntries ? '<div class="schedule-timetable-week" role="table"><div class="schedule-timetable-week__header"><strong>' + esc(t('reminders.timeLabel')) + '</strong>' + dayLabels + '</div><div class="schedule-timetable-week__body">' + rows + '</div></div>' : '<section class="schedule-timetable-empty-state"><p>' + esc(t('schedule.empty')) + '</p><button type="button" class="btn btn--primary" data-action="open-patterns">' + esc(t('schedule.addPattern')) + '</button></section>') + '<p class="schedule-timetable-edit-hint"><button type="button" class="btn btn--secondary" data-action="open-patterns">' + esc(t('schedule.addPattern')) + '</button></p>';
}

function renderScheduleWarnings() {
  if (!state.warnings.length) return '';
  return '<div class="schedule-warnings" role="status">' + state.warnings.map((warning) => '<p>' + esc(t('schedule.overlapWarning', { date: warning.date_key, user: userName(warning.user_id) })) + '</p>').join('') + '</div>';
}

/**
 * Builds the toolbar and tab rail ONCE. `renderPage()` below only touches
 * `.schedule-body` on a tab switch, so a FAB the router docks into
 * `.page-toolbar__actions` survives every subsequent tab change instead of
 * being destroyed along with a full-page reset.
 */
function renderShell() {
  const tabs = [
    ['shifts', t('schedule.shiftTypes')],
    ['patterns', t('schedule.patterns')],
    ['timetable', t('schedule.timetable')],
    ['overrides', t('schedule.overrides')],
    ['statistics', t('schedule.statistics')],
  ];
  root.replaceChildren();
  root.insertAdjacentHTML('beforeend', `<div class="schedule-page app-page app-page--full" data-composition="full">
    <header class="page-toolbar schedule-toolbar">
      <h1 class="page-toolbar__title">${esc(t('schedule.title'))}</h1>
      <div class="page-toolbar__actions"></div>
      <div class="sub-tabs-bar schedule-tabs page-toolbar__bar" role="tablist" aria-label="${esc(t('schedule.title'))}">
        ${tabs.map(([id, label]) => `<button class="sub-tab" type="button" role="tab" data-tab="${id}">${esc(label)}</button>`).join('')}
      </div>
    </header>
    <div class="schedule-body"></div>
  </div>`);
  // Scroll-Affordanz der Bar-Zeile (geteilter Peek-Fade, .page-toolbar__bar).
  wireScrollFade(root.querySelector('.schedule-tabs'));
  root.addEventListener('submit', submitForm);
  root.addEventListener('click', (event) => {
    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) { activateView(tabButton.dataset.tab); return; }
    const timetableButton = event.target.closest('[data-timetable-view]');
    if (timetableButton) { action({ currentTarget: timetableButton }); return; }
    const timetableDayButton = event.target.closest('[data-timetable-day]');
    if (timetableDayButton) { timetableDayIndex = Number(timetableDayButton.dataset.timetableDay); renderPage(); return; }
    const timetableNavButton = event.target.closest('[data-timetable-nav]');
    if (timetableNavButton) { action({ currentTarget: timetableNavButton }); return; }
    const timetableTodayButton = event.target.closest('[data-timetable-today]');
    if (timetableTodayButton) { action({ currentTarget: timetableTodayButton }); return; }
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) action({ currentTarget: actionButton });
  });
  root.addEventListener('change', (event) => {
    if (event.target.matches('[data-field="color"]')) {
      delete event.target.dataset.colorNull;
    }
    if (event.target.matches('[data-timetable-user]')) {
      timetableUserId = event.target.value;
      renderPage();
    }
    if (event.target.matches('[data-holiday-country]')) {
      state.holidayCountry = event.target.value;
      state.holidaySubdivision = '';
      state.holidaySubdivisions = [];
      state.holidays = [];
      if (state.holidayCountry) {
        api.get(`/preferences/holidays/subdivisions/${state.holidayCountry}`).then((response) => {
          state.holidaySubdivisions = response.data ?? [];
          renderPage();
        });
      }
      savePreferences({ holiday_country: state.holidayCountry, holiday_subdivision: null, holiday_show_school: true }).catch(() => {});
      renderPage();
    }
    if (event.target.matches('[data-holiday-subdivision]')) {
      state.holidaySubdivision = event.target.value;
      savePreferences({ holiday_country: state.holidayCountry, holiday_subdivision: state.holidaySubdivision || null, holiday_show_school: true }).catch(() => {});
      renderPage();
    }
  });
}

function renderPage() {
  root.querySelectorAll('[data-tab]').forEach((button) => {
    const isActive = button.dataset.tab === activeView;
    button.classList.toggle('sub-tab--active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });
  const panel = activeView === 'shifts'
    ? '<section class="schedule-library schedule-library--shifts"><h2 class="u-section-title">' + esc(t('schedule.shiftTypes')) + '</h2>' + (state.types.length ? state.types.map(shiftTypeCard).join('') : emptyShiftTypesState()) + '</section>'
    : activeView === 'patterns'
      ? '<section class="schedule-library schedule-library--patterns"><h2 class="u-section-title">' + esc(t('schedule.patterns')) + '</h2>' + (state.patterns.length ? state.patterns.map(patternCard).join('') : emptyPatternState()) + '</section>'
      : activeView === 'timetable'
        ? '<section class="schedule-library schedule-library--timetable"><h2 class="u-section-title">' + esc(t('schedule.timetable')) + '</h2>' + renderTimetable() + '</section>'
      : activeView === 'overrides'
        ? '<section class="schedule-library schedule-library--overrides"><h2 class="u-section-title">' + esc(t('schedule.overrides')) + '</h2>' + overrideRows() + '</section>'
        : renderStatistics();
  const body = root.querySelector('.schedule-body');
  body.replaceChildren();
  // Die Heute-Karte erst, wenn das Modul in Betrieb ist: ein frischer Haushalt
  // sah sonst ZWEI Leerzustaende uebereinander („Noch keine Schichteintraege."
  // + „Noch kein Schichtplan") - zwei Meldungen fuer eine Tatsache, und die
  // Onboarding-Anleitung des Panels stand erst an zweiter Stelle
  // (Critique 2026-08-27, P2).
  const inUse = state.types.length || state.patterns.length
    || state.overrides.length || state.entries.length;
  body.insertAdjacentHTML('beforeend',
    (activeView === 'statistics' || activeView === 'timetable' || !inUse ? '' : '<section class="card card--padded schedule-today"><h2 class="u-section-title">' + esc(t('schedule.today')) + '</h2>' + renderToday() + renderScheduleWarnings() + '</section>')
    + `<div class="schedule-content">${panel}</div>`);
  updateScheduleFab();
  window.lucide?.createIcons({ el: body });
}
function updateScheduleFab() {
  if (!scheduleFab) return;
  const labels = {
    shifts: t('schedule.createShiftType'),
    patterns: t('schedule.addPattern'),
    overrides: t('schedule.createOverride'),
  };
  const dockLabels = {
    shifts: t('schedule.shiftType'),
    patterns: t('schedule.pattern'),
    overrides: t('schedule.override'),
  };
  setPageFabAction(scheduleFab, {
    label: labels[activeView],
    dockLabel: dockLabels[activeView],
    hidden: activeView === 'statistics',
    onClick: () => openScheduleCreateModal(activeView),
  });
}

/**
 * Bearbeitet eine ganze Gruppe (siehe overrideGroups()) statt eines einzelnen
 * Tages - auch ein Einzeltag ist nur eine Gruppe der Groesse 1. Von/Bis sind
 * bewusst EDITIERBAR (anders als frueher, wo nur das Datum stand): die Reihe
 * so anzupassen, wie man sie angelegt hat, statt sie erst zu loeschen und neu
 * zu fuellen, ist genau die Bedienung, die das Nutzer-Feedback nach dem
 * Live-Test verlangt hat. `saveCreatedSchedule()` gleicht Erweiterung und
 * Verkuerzung der Spanne beim Speichern automatisch ab (fill + Rest-Deltas).
 */
function openOverrideEditModal(group) {
  const type = state.types.find((item) => Number(item.id) === Number(group.shift_type_id));
  const content = '<form id="schedule-create-form" class="form-stack schedule-modal-form" data-form="override-edit">'
    + '<input type="hidden" name="user_id" value="' + esc(String(group.user_id)) + '">'
    + '<input type="hidden" name="original_from" value="' + esc(group.from) + '">'
    + '<input type="hidden" name="original_to" value="' + esc(group.to) + '">'
    + formField(t('schedule.owner'), '<input class="input" readonly value="' + esc(userName(group.user_id)) + '">')
    + formField(t('schedule.rangeFrom'), '<yuvomi-datepicker required name="from" type="date" label="' + esc(t('schedule.rangeFrom')) + '" value="' + esc(group.from) + '"></yuvomi-datepicker>')
    + formField(t('schedule.rangeTo'), '<yuvomi-datepicker required name="to" type="date" label="' + esc(t('schedule.rangeTo')) + '" value="' + esc(group.to) + '"></yuvomi-datepicker>')
    + formField(t('schedule.shiftTypes'), '<select class="input" name="shift_type_id">' + typeOptions(type?.id ?? null) + '</select>')
    + formField(t('schedule.note'), '<input class="input" name="note" maxlength="5000" value="' + esc(group.note ?? '') + '">')
    + '<div class="modal-actions"><button type="submit" class="btn btn--primary">' + esc(t('schedule.save')) + '</button></div></form>';
  openModal({
    title: t('schedule.editOverride'),
    size: 'md',
    content,
    onSave: (modal) => modal.querySelector('#schedule-create-form')?.addEventListener('submit', saveCreatedSchedule),
  });
}

function openScheduleCreateModal(view) {
  let title;
  let content;
  if (view === 'shifts') {
    title = t('schedule.createShiftType');
    content = '<form id="schedule-create-form" class="form-stack schedule-modal-form" data-form="shift-create">'
      + formField(t('schedule.preset'), '<select class="input" name="shift_preset">' + shiftPresetOptions() + '</select>')
      + shiftFields()
      + '<div class="modal-actions"><button type="submit" class="btn btn--primary">' + esc(t('common.create')) + '</button></div></form>';
  } else if (view === 'patterns') {
    title = t('schedule.addPattern');
    content = '<form id="schedule-create-form" class="form-stack schedule-modal-form" data-form="pattern-create">'
      + formField(t('schedule.owner'), '<select class="input" required name="user_id">' + userOptions(selectedOwner()) + '</select>')
      + patternFields()
      + '<div class="modal-actions"><button type="submit" class="btn btn--primary">' + esc(t('common.create')) + '</button></div></form>';
  } else {
    title = t('schedule.createOverride');
    content = '<form id="schedule-create-form" class="form-stack schedule-modal-form" data-form="override-create">'
      + formField(t('schedule.owner'), '<select class="input" required name="user_id">' + userOptions(selectedOwner()) + '</select>')
      + '<div class="form-field schedule-active-field"><span class="label">' + esc(t('schedule.fillRange')) + '</span><label class="toggle"><input name="fill_range" type="checkbox"><span class="toggle__track"></span></label></div>'
      + '<div data-field="single-date">' + formField(t('schedule.date'), '<yuvomi-datepicker required name="date_key" type="date" label="' + esc(t('schedule.date')) + '" value="' + esc(todayKey()) + '"></yuvomi-datepicker>') + '</div>'
      + '<div data-field="range-dates" hidden>'
      + formField(t('schedule.rangeFrom'), '<yuvomi-datepicker name="range_from" type="date" label="' + esc(t('schedule.rangeFrom')) + '" value="' + esc(todayKey()) + '"></yuvomi-datepicker>')
      + formField(t('schedule.rangeTo'), '<yuvomi-datepicker name="range_to" type="date" label="' + esc(t('schedule.rangeTo')) + '" value="' + esc(todayKey()) + '"></yuvomi-datepicker>')
      + '</div>'
      + formField(t('schedule.shiftTypes'), '<select class="input" name="shift_type_id">' + typeOptions(null) + '</select>')
      + formField(t('schedule.note'), '<input class="input" name="note" maxlength="5000">')
      + '<div class="modal-actions"><button type="submit" class="btn btn--primary">' + esc(t('schedule.save')) + '</button></div></form>';
  }
  openModal({
    title,
    size: 'md',
    content,
    onSave: (modal) => {
      const form = modal.querySelector('#schedule-create-form');
      form?.querySelector('[name="shift_preset"]')?.addEventListener('change', () => applyShiftPreset(form));
      // Ein Umschalter statt zweier getrennter Formulare: beide Feldsaetze
      // leben im selben `<form>`, damit Besitzer/Schichtart/Notiz nicht doppelt
      // gepflegt werden muessen. `yuvomi-datepicker` kennt kein `required`
      // (kein Eintrag in observedAttributes, keine ElementInternals-Validitaet
      // dafuer) - das Feld ist rein optisch versteckt, die eigentliche Pflicht
      // prueft der Server (`date(..., true)` in der jeweiligen Route).
      form?.querySelector('[name="fill_range"]')?.addEventListener('change', (event) => {
        const range = event.currentTarget.checked;
        form.querySelector('[data-field="single-date"]').hidden = range;
        form.querySelector('[data-field="range-dates"]').hidden = !range;
      });
      form?.addEventListener('submit', saveCreatedSchedule);
    },
  });
}

async function saveCreatedSchedule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = formData(form);
  try {
    if (form.dataset.form === 'shift-create') await api.post('/schedule/shift-types', data);
    if (form.dataset.form === 'pattern-create') {
      data.user_id = Number(data.user_id);
      data.cycle_length = Number(data.cycle_length);
      data.is_active = form.elements.is_active.checked;
      await api.post('/schedule/patterns', data);
    }
    if (form.dataset.form === 'override-create') {
      const userId = Number(data.user_id);
      const shiftTypeId = data.shift_type_id ? Number(data.shift_type_id) : null;
      if (form.elements.fill_range?.checked) {
        const type = state.types.find((item) => Number(item.id) === shiftTypeId);
        const typeLabel = type ? (type.short_code ? `${type.short_code} · ${type.name}` : type.name) : t('schedule.freeDay');
        const confirmed = await confirmModal(
          t('schedule.fillRangeConfirmTitle'),
          { confirmLabel: t('schedule.fillRange'), detail: t('schedule.fillRangeConfirmDetail', { from: formatDate(data.range_from), to: formatDate(data.range_to), type: typeLabel }) },
        );
        if (!confirmed) return;
        await api.post('/schedule/overrides/fill', { user_id: userId, from: data.range_from, to: data.range_to, shift_type_id: shiftTypeId, note: data.note });
      } else {
        await api.put('/schedule/overrides/' + encodeURIComponent(data.date_key), { user_id: userId, shift_type_id: shiftTypeId, note: data.note });
      }
    }
    if (form.dataset.form === 'override-edit') {
      const userId = Number(data.user_id);
      const shiftTypeId = data.shift_type_id ? Number(data.shift_type_id) : null;
      const type = state.types.find((item) => Number(item.id) === shiftTypeId);
      const typeLabel = type ? (type.short_code ? `${type.short_code} · ${type.name}` : type.name) : t('schedule.freeDay');
      const confirmed = await confirmModal(
        t('schedule.fillRangeConfirmTitle'),
        { confirmLabel: t('schedule.save'), detail: t('schedule.fillRangeConfirmDetail', { from: formatDate(data.from), to: formatDate(data.to), type: typeLabel }) },
      );
      if (!confirmed) return;
      await api.post('/schedule/overrides/fill', { user_id: userId, from: data.from, to: data.to, shift_type_id: shiftTypeId, note: data.note });
      // Was ausserhalb der neuen Spanne lag, aber zur alten gehoerte, muss weg -
      // sonst bliebe ein verkuerztes Ende als Karteileiche stehen (fill fasst
      // nur die neue Spanne an, nie das, was davor oder danach lag).
      const leftovers = rangeDifference(data.original_from, data.original_to, data.from, data.to);
      for (const span of leftovers) {
        await api.delete(`/schedule/overrides?user_id=${userId}&from=${span.from}&to=${span.to}`);
      }
    }
    await load();
    renderPage();
    await closeModal({ force: true });
    window.yuvomi?.showToast(t('schedule.saved'), 'success');
  } catch (error) {
    window.yuvomi?.showToast(error.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form));
}

function formValue(form, name, fallback = '') {
  return form.elements?.namedItem(name)?.value || form.querySelector('[name="' + name + '"]')?.value || fallback;
}

async function submitForm(event) {
  event.preventDefault();
  const form = event.target;
  const data = formData(form);
  try {
    if (form.dataset.form === 'statistics') {
      statistics = {
        ...statistics,
        userId: Number(formValue(form, 'user_id', data.user_id)),
        monthFrom: formValue(form, 'month_from', data.month_from || statistics.monthFrom).slice(0, 7),
        monthTo: formValue(form, 'month_to', data.month_to || statistics.monthTo).slice(0, 7),
        from: formValue(form, 'from', data.from || statistics.from),
        to: formValue(form, 'to', data.to || statistics.to),
        entries: [],
        bounds: null,
        loading: true,
      };
      renderPage();
      await refreshStatistics();
      renderPage();
      return;
    }
    if (form.dataset.form === 'shift-create') await api.post('/schedule/shift-types', data);
    if (form.dataset.form === 'shift-update') await api.put(`/schedule/shift-types/${form.dataset.id}`, data);
    if (form.dataset.form === 'pattern-create') {
      data.user_id = Number(data.user_id);
      data.cycle_length = Number(data.cycle_length);
      data.is_active = form.elements.is_active.checked;
      await api.post('/schedule/patterns', data);
    }
    if (form.dataset.form === 'pattern-update') {
      data.cycle_length = Number(data.cycle_length);
      data.is_active = form.elements.is_active.checked;
      await api.put(`/schedule/patterns/${form.dataset.id}`, data);
    }
    if (form.dataset.form === 'override-create') {
      const dateKey = data.date_key;
      delete data.date_key;
      data.user_id = Number(data.user_id);
      data.shift_type_id = data.shift_type_id ? Number(data.shift_type_id) : null;
      await api.put(`/schedule/overrides/${dateKey}`, data);
    }
    await load();
    renderPage();
    window.yuvomi?.showToast(t('schedule.saved'), 'success');
  } catch (error) {
    if (form.dataset.form === 'statistics') {
      statistics = { ...statistics, loading: false };
      renderPage();
    }
    window.yuvomi?.showToast(error.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

async function action(event) {
  const button = event.currentTarget;
  try {
    if (button.dataset.action === 'open-create') {
      openScheduleCreateModal(button.dataset.view || activeView);
      return;
    }
    // Ein zweiter Klick vor dem ersten `load()` darf nicht alle sieben Presets
    // doppelt anlegen. `state.types.length` allein schuetzt davor nicht: es
    // wird erst von `load()` im `finally` aktualisiert, ein zweiter Klick
    // waehrend der sieben Requests sieht also noch `state.types.length === 0`
    // (Review #930: `schedule_shift_types` hat kein UNIQUE auf name/short_code,
    // ein zweiter Durchlauf legt also still 14 Typen mit doppelten Namen an).
    // Die Schaltflaeche synchron zu deaktivieren schliesst genau dieses Fenster.
    // `finally` statt nur dem Erfolgspfad: schlaegt ein Preset mitten in der
    // Schleife fehl (Netzwerk, doppelter Kurzcode), sollen die bereits
    // angelegten trotzdem sichtbar werden - sonst zeigt die Seite weiter den
    // Leerzustand, obwohl schon Typen existieren.
    if (button.dataset.action === 'quick-start-shifts') {
      if (state.types.length) return;
      button.disabled = true;
      try {
        for (const preset of SHIFT_PRESETS) {
          await api.post('/schedule/shift-types', {
            name: shiftPresetLabel(preset.key),
            short_code: preset.shortCode,
            start_time: preset.startTime,
            end_time: preset.endTime,
            color: preset.color,
          });
        }
      } finally {
        await load();
        renderPage();
      }
      window.yuvomi?.showToast(t('schedule.saved'), 'success');
      return;
    }
    if (button.dataset.action === 'statistics-range') {
      statistics = { ...statistics, range: button.dataset.range, entries: [], bounds: null, loading: false };
      renderPage();
      return;
    }
    if (button.dataset.action === 'edit-override') {
      const group = overrideGroups().find((item) => item.from === button.dataset.from && Number(item.user_id) === Number(button.dataset.userId));
      if (group) openOverrideEditModal(group);
      return;
    }
    if (button.dataset.action === 'add-block') {
      const day = button.closest('.schedule-cycle-day');
      const template = day?.querySelector('.schedule-day-block');
      if (day && template) {
        const clone = template.cloneNode(true);
        clone.querySelectorAll('[data-field]').forEach((field) => { field.value = ''; delete field.dataset.colorNull; });
        day.querySelector('.schedule-cycle-day__blocks')?.appendChild(clone);
      }
      return;
    }
    if (button.dataset.action === 'remove-block') {
      const block = button.closest('.schedule-day-block');
      const day = button.closest('.schedule-cycle-day');
      if (block && day) {
        const blocks = day.querySelectorAll('.schedule-day-block');
        if (blocks.length > 1) block.remove();
        else block.querySelectorAll('[data-field]').forEach((field) => { field.value = ''; });
      }
      return;
    }
    if (button.dataset.action === 'open-patterns') {
      activeView = 'patterns';
      renderPage();
      return;
    }
    if (button.dataset.action === 'clear-block-color') {
      const color = button.closest('.schedule-day-block')?.querySelector('[data-field="color"]');
      if (color) color.dataset.colorNull = 'true';
      return;
    }
    if (button.dataset.timetableNav || button.dataset.timetableToday !== undefined) {
      if (timetableLoading) return;
      timetableLoading = true;
      timetableWeekStart = button.dataset.timetableToday !== undefined
        ? startOfLocalWeekKey(todayKey(), 1)
        : addLocalDays(timetableWeekStart, Number(button.dataset.timetableNav));
      timetableDayIndex = 0;
      try {
        await loadTimetableWeek();
      } finally {
        timetableLoading = false;
        renderPage();
      }
      return;
    }
    if (button.dataset.action === 'load-holidays') {
      if (holidayLoading) return;
      holidayLoading = true;
      state.holidayFrom = root.querySelector('[data-holiday-from]')?.value || state.holidayFrom;
      state.holidayTo = root.querySelector('[data-holiday-to]')?.value || state.holidayTo;
      renderPage();
      try {
        await savePreferences({ holiday_country: state.holidayCountry, holiday_subdivision: state.holidaySubdivision || null, holiday_show_school: true });
        await api.post('/preferences/holidays/sync');
        const response = await api.get(`/calendar/holidays?from=${encodeURIComponent(state.holidayFrom)}&to=${encodeURIComponent(state.holidayTo)}`);
        state.holidays = (response.data ?? []).filter((holiday) => holiday.type === 'school');
        window.yuvomi?.showToast(state.holidays.length ? t('schedule.holidaysLoaded') : t('schedule.noHolidaysFound'), state.holidays.length ? 'success' : 'warning');
      } finally {
        holidayLoading = false;
        renderPage();
      }
      return;
    }
    if (button.dataset.action === 'apply-all-holidays') {
      const rows = [...root.querySelectorAll('.schedule-holiday-row')];
      const userId = Number(root.querySelector('[data-holiday-user]')?.value);
      const shiftTypeId = root.querySelector('[data-holiday-type]')?.value;
      await Promise.all(rows.map((row) => {
        const applyButton = row.querySelector('[data-action="apply-holiday"]');
        return api.post('/schedule/overrides/fill', {
          user_id: userId,
          from: applyButton?.dataset.from,
          to: applyButton?.dataset.to,
          shift_type_id: shiftTypeId ? Number(shiftTypeId) : null,
          note: row.querySelector('.list-row__name')?.textContent || '',
        });
      }));
      await load();
      renderPage();
      return;
    }
    if (button.dataset.action === 'apply-holiday') {
      const row = button.closest('.schedule-holiday-row');
      const userId = Number(root.querySelector('[data-holiday-user]')?.value);
      const shiftTypeId = root.querySelector('[data-holiday-type]')?.value;
      await api.post('/schedule/overrides/fill', { user_id: userId, from: button.dataset.from, to: button.dataset.to, shift_type_id: shiftTypeId ? Number(shiftTypeId) : null, note: row?.querySelector('.list-row__name')?.textContent || '' });
      await load();
      renderPage();
      return;
    }
    if (button.dataset.timetableView) {
      timetableView = button.dataset.timetableView;
      renderPage();
      return;
    }
    if (button.dataset.action === 'delete-shift') await api.delete(`/schedule/shift-types/${button.dataset.id}`);
    // Ein Muster loeschen nimmt seine Zyklustage mit (ON DELETE CASCADE): eine
    // Achttage-Rotation ist mit einem Fingertipp weg, und es gibt keinen Weg
    // zurueck. Deshalb fragt genau DIESE Loeschung nach und nennt dabei, was
    // dranhaengt - die anderen beiden sind je eine Zeile und ohne Nachfrage.
    if (button.dataset.action === 'delete-pattern') {
      const pattern = state.patterns.find((item) => Number(item.id) === Number(button.dataset.id));
      const confirmed = await confirmModal(
        t('schedule.deletePatternTitle', { name: pattern?.name ?? '' }),
        {
          danger: true,
          confirmLabel: t('schedule.delete'),
          detail: t('schedule.deletePatternDetail', { count: pattern?.cycle_length ?? 0 }),
        },
      );
      if (!confirmed) return;
      await api.delete(`/schedule/patterns/${button.dataset.id}`);
    }
    // Ein Bereich kann viele Tage tragen, darum fragt das Loeschen hier nach,
    // anders als ein Einzeltag frueher (der jetzt selbst eine Gruppe der
    // Groesse 1 ist und denselben Weg nimmt - eine Rueckfrage fuer einen Tag
    // ist kein Verlust, eine fehlende fuer vierzehn waere einer).
    if (button.dataset.action === 'delete-override-range') {
      const { from, to, userId } = button.dataset;
      const confirmed = await confirmModal(
        t('schedule.deleteOverrideRangeTitle'),
        { danger: true, confirmLabel: t('schedule.delete'), detail: t('schedule.deleteOverrideRangeDetail', { from: formatDate(from), to: formatDate(to), user: userName(userId) }) },
      );
      if (!confirmed) return;
      await api.delete(`/schedule/overrides?user_id=${userId}&from=${from}&to=${to}`);
    }
    if (button.dataset.action === 'save-days') {
      const details = button.closest('[data-pattern]');
      const days = [...details.querySelectorAll('.schedule-day-block')].map((block) => {
        const value = (field) => block.querySelector(`[data-field="${field}"]`)?.value?.trim() || null;
        const color = block.querySelector('[data-field="color"]');
        return { position: Number(block.dataset.day), shift_type_id: value('shift_type_id') ? Number(value('shift_type_id')) : null, start_time: value('start_time'), end_time: value('end_time'), subject: value('subject'), room: value('room'), instructor: value('instructor'), period_number: value('period_number') ? Number(value('period_number')) : null, color: color?.dataset.colorNull ? null : color?.value || null, notes: value('notes') };
      });
      await api.put(`/schedule/patterns/${button.dataset.id}/days`, { days });
    }
    await load();
    renderPage();
    window.yuvomi?.showToast(button.dataset.action.startsWith('delete') ? t('schedule.deleted') : t('schedule.saved'), 'success');
  } catch (error) {
    window.yuvomi?.showToast(error.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

export async function render(container, { user } = {}) {
  root = container;
  activeView = 'timetable';
  currentUserId = user?.id ?? null;
  canManageOthers = user?.role === 'admin';
  await load();
  statistics = { ...statistics, userId: currentUserId, monthFrom: monthKey(), monthTo: monthKey(), from: todayKey(), to: todayKey() };
  renderShell();
  scheduleFab = createPageFab({ id: 'schedule-fab' });
  root.querySelector('.schedule-page')?.appendChild(scheduleFab);
  renderPage();
  window.lucide?.createIcons({ el: root });
}

// Reines Verhalten statt Text-Muster (PR #930 review): beide Funktionen sind
// bereits pur bzw. nehmen ihre Eingabe jetzt als Parameter statt sie fest aus
// `state` zu lesen - ein Test kann so echte Tage hineingeben und das Ergebnis
// pruefen, statt nur zu belegen, dass der Funktionsname im Quelltext steht.
export const __test = { overrideGroups, rangeDifference };
