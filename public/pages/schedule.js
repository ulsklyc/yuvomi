import { api } from '/api.js';
import { t, formatDate, formatDayMonth, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { todayKey, addLocalDays, parseLocalDateKey, weekStartIndex, startOfLocalWeekKey } from '/utils/date.js';
import { openModal, closeModal, confirmModal, confirmOverModal, advancedSection, reportFieldError, promptModal } from '/components/modal.js';
import { makeSortable } from '/utils/sortable.js';
import { createPageFab, setPageFabAction } from '/utils/fab.js';
import { emptyStateHTML } from '/utils/empty-state.js';
import { wireScrollFade } from '/utils/ux.js';
import { wireTablist } from '/utils/tablist.js';
import { toggleRowHtml } from '/settings/components.js';
import { renderUserMultiSelect, getSelectedUserIds, bindUserMultiSelect } from '/components/user-multi-select.js';
import { isNavModuleReadOnly } from '/permissions.js';
import { scheduleViewFromPath, scheduleRouteForView } from '/utils/schedule-tabs.js';

// ZWEISPALTIG: Schedule is a full-width responsive library and statistics view;
// constraining its row lists to the narrow reading measure would recreate the
// unused desktop column this module intentionally avoids.

let root;
let scheduleFab = null;
let scheduleTablist = null;
let currentUserId = null;
let canManageOthers = false;
let activeView = 'patterns';
// S-07: der Vorgabewert oben gilt nur, bevor jemals entschieden wurde - render()
// ersetzt ihn beim ALLERERSTEN Laden dieses Moduls (in dieser Sitzung) je nach
// Datenlage (siehe dort), aber niemals danach: `activeView` ist ausdruecklich
// Zustand, der einen Tab-Wechsel und einen Seitenbesuch ueberlebt (Kommentar an
// render() weiter unten), ein spaeterer Besuch soll die eigene Tab-Wahl der
// Person nicht wieder ueberschreiben.
let initialViewDecided = false;
// S-03: welche Musterkarten (per `pattern.id`, als String) gerade eine
// ungespeicherte Aenderung im Zyklustage-Editor oder im inline Pattern-
// Formular tragen. renderPage() ersetzt `.schedule-body` komplett bei jedem
// Tab-Wechsel/Neuladen - ohne diese Nachverfolgung verschwand eine getippte,
// aber nicht gespeicherte Aenderung lautlos, sobald irgendetwas einen
// Re-Render ausloeste (Audit-Fund S-03). Ein Set statt eines einzelnen
// Flags: mehrere Musterkarten koennen gleichzeitig geoeffnet und bearbeitet
// sein, eine Rueckfrage beim Schliessen EINER Karte soll nicht von der
// Restlichkeit falsch beeinflusst werden.
let dirtyPatternIds = new Set();
let state = { users: [], types: [], customFields: [], patterns: [], overrides: [], extras: [], entries: [], warnings: [], reminderOffsetMinutes: null, weeklyHours: null, overtimeEnabled: true, hiddenTemplates: [] };
let statistics = { userId: null, range: 'current', monthFrom: '', monthTo: '', from: '', to: '', entries: [], bounds: null, loading: false, error: false };
// Generationszaehler gegen ein Wettrennen zweier ueberlappender Ladevorgaenge
// (schnelles Tab-Wechseln/Woche-Vor-Zurueck/erneutes Absenden des Filters):
// jeder Aufruf reserviert sich vor dem eigentlichen Fetch die naechste Nummer,
// und nur wer beim Zurueckkommen noch die AKTUELLE Nummer traegt, darf sein
// Ergebnis uebernehmen - eine spaeter gestartete, aber frueher zurueckkommende
// Anfrage gewinnt sonst gegen eine juengere, die correcter waere. Dasselbe
// Prinzip wie calendar.js' createCalendarLoadCoordinator(), hier als schlichter
// lokaler Zaehler statt einer geteilten Abstraktion (kein weiteres Modul
// braucht das gleiche Muster).
let statisticsRequestId = 0;
let overviewRequestId = 0;
// "Uebersicht"-Tab: mehrere Haushaltsmitglieder nebeneinander vergleichen
// (#1018 - Stundenplaene mehrerer Kinder). people kommt vorgefiltert vom
// Server (GET /schedule/household-members, isHouseholdMember()); selectedIds
// ist rein clientseitig und loest nie einen Fetch aus - nur der Wochenwechsel
// tut das (siehe refreshOverview()).
const OVERVIEW_SELECTION_KEY = 'yuvomi:schedule:overview:people';
const OVERVIEW_VIEW_KEY = 'yuvomi:schedule:overview:mode';
let overview = { people: [], selectedIds: [], weekCursor: todayKey(), viewMode: loadSavedOverviewViewMode(), entries: [], holidays: [], loading: false, error: false };

function loadSavedOverviewViewMode() {
  try { return localStorage.getItem(OVERVIEW_VIEW_KEY) === 'day' ? 'day' : 'week'; } catch { return 'week'; }
}

function saveOverviewViewMode(mode) {
  try { localStorage.setItem(OVERVIEW_VIEW_KEY, mode); } catch {}
}

/**
 * Reine Filterfunktion: eine gespeicherte Auswahl gegen die Liste der heute
 * tatsaechlich waehlbaren Personen pruefen. Eine veraltete Id (Haushaltshilfe
 * geworden, entfernter Gast, geloeschtes Konto) faellt still heraus statt
 * einen Fehler zu werfen - dieselbe Toleranz wie calendar.js'
 * normalizeCalendarView() gegenueber einem unbekannten gespeicherten Wert.
 */
function normalizeOverviewSelection(rawIds, eligibleIds) {
  if (!Array.isArray(rawIds)) return [];
  const eligible = new Set(eligibleIds);
  return rawIds.filter((id) => eligible.has(id));
}

function loadSavedOverviewSelection() {
  try {
    const raw = localStorage.getItem(OVERVIEW_SELECTION_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch { return []; }
}

function saveOverviewSelection(ids) {
  try { localStorage.setItem(OVERVIEW_SELECTION_KEY, JSON.stringify(ids)); } catch {}
}
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
// Absenz ist kontextunabhaengig - ob Arbeit, Schule oder Uni, es braucht immer
// einen Weg, einen Tag als "nicht da" zu kennzeichnen. Deshalb an jede
// Vorlage angehaengt statt dreifach dupliziert.
const SHARED_PRESETS = Object.freeze([
  { key: 'vacation', shortCode: 'V', startTime: null, endTime: null, color: '#475569', icon: 'tree-palm' },
  { key: 'sick', shortCode: 'S', startTime: null, endTime: null, color: '#B91C1C', icon: 'thermometer' },
]);
// Drei Vorlagen statt einer einzigen festen Liste - derselbe Quickstart-Weg
// (vormals nur Arbeitsschichten) deckt jetzt auch Schule und Universitaet ab.
// Die Zeiten sind Startwerte zum Anpassen, keine Behauptung universeller
// Richtigkeit - dieselbe Haltung wie die bestehenden Arbeits-Presets schon
// immer hatten ("Fruehschicht" 06-14 Uhr passt auch nicht jedem Betrieb).
const PRESET_TEMPLATES = Object.freeze({
  work: Object.freeze([
    { key: 'early', shortCode: 'E', startTime: '06:00', endTime: '14:00', color: '#0E7490', icon: 'sunrise' },
    { key: 'late', shortCode: 'L', startTime: '14:00', endTime: '22:00', color: '#A21CAF', icon: 'sunset' },
    { key: 'night', shortCode: 'N', startTime: '22:00', endTime: '06:00', color: '#4338CA', icon: 'moon' },
    { key: 'day', shortCode: 'D', startTime: '08:00', endTime: '16:00', color: '#15803D', icon: 'sun' },
    { key: 'fullDay', shortCode: '24', startTime: '10:00', endTime: '10:00', color: '#A16207', icon: 'clock' },
    ...SHARED_PRESETS,
  ]),
  school: Object.freeze([
    { key: 'period1', shortCode: 'P1', startTime: '08:00', endTime: '08:45', color: '#0369A1', icon: 'book-open' },
    { key: 'period2', shortCode: 'P2', startTime: '08:55', endTime: '09:40', color: '#0D9488', icon: 'book-open' },
    { key: 'period3', shortCode: 'P3', startTime: '09:55', endTime: '10:40', color: '#B45309', icon: 'book-open' },
    { key: 'period4', shortCode: 'P4', startTime: '10:50', endTime: '11:35', color: '#BE185D', icon: 'book-open' },
    { key: 'exam', shortCode: 'EX', startTime: '09:00', endTime: '11:00', color: '#7C2D12', icon: 'file-text' },
    ...SHARED_PRESETS,
  ]),
  university: Object.freeze([
    { key: 'lecture', shortCode: 'VL', startTime: '09:00', endTime: '10:30', color: '#1D4ED8', icon: 'presentation' },
    { key: 'seminar', shortCode: 'SE', startTime: '10:45', endTime: '12:15', color: '#0F766E', icon: 'users' },
    { key: 'lab', shortCode: 'LAB', startTime: '13:00', endTime: '15:00', color: '#166534', icon: 'flask-conical' },
    { key: 'exam', shortCode: 'EX', startTime: '09:00', endTime: '11:00', color: '#7C2D12', icon: 'file-text' },
    ...SHARED_PRESETS,
  ]),
});
// Fuer den EINZEL-Vorlagen-Waehler im "Schichtart erstellen"-Formular
// (shiftPresetOptions()/applyShiftPreset() weiter unten) - der darf aus JEDER
// Vorlage waehlen, nicht nur aus Arbeit, unabhaengig davon, welche Vorlage
// zuletzt per Quickstart lief. Ein Map-Umweg entdoppelt exam/vacation/sick,
// die in mehreren Vorlagen mit identischen Werten auftauchen.
const ALL_PRESETS = Object.freeze([...new Map(
  [...PRESET_TEMPLATES.work, ...PRESET_TEMPLATES.school, ...PRESET_TEMPLATES.university].map((preset) => [preset.key, preset]),
).values()]);
const SHIFT_COLOR_FALLBACK = PRESET_TEMPLATES.work[0].color;

// Welche Vorlagen ueberhaupt als Knopf angeboten werden, ist selbst haushalt-
// weit konfigurierbar (server/routes/preferences.js#schedule_hidden_templates,
// Settings > Module > Optionen) - ein Haushalt, der nur Arbeit braucht, muss
// nicht dauerhaft Schule/Uni-Knoepfe sehen. `PRESET_TEMPLATES` selbst bleibt
// unveraendert (die Vorlagen existieren weiter, nur ihr Einstiegsknopf kann
// fehlen); bereits angelegte Schichtarten sind davon ohnehin unberuehrt.
const QUICKSTART_TEMPLATES = [['work', 'schedule.templateWork'], ['school', 'schedule.templateSchool'], ['university', 'schedule.templateUniversity']];
function visibleQuickstartTemplates() {
  const hidden = new Set(state.hiddenTemplates ?? []);
  return QUICKSTART_TEMPLATES.filter(([key]) => !hidden.has(key));
}

const option = (value, label, selected = false) => `<option value="${esc(String(value ?? ''))}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
const userName = (id) => state.users.find((user) => Number(user.id) === Number(id))?.display_name
  || state.users.find((user) => Number(user.id) === Number(id))?.username
  || String(id);
const selectedOwner = () => currentUserId ?? state.users[0]?.id ?? '';

/**
 * Nur-lesen-Mitglied fuer das Schedule-Modul (Modulrecht 'read'): der Server
 * blockt jedes POST/PUT/DELETE unter /schedule ohnehin mit 403 (zentrales Gate,
 * server/index.js + moduleAccessVerdict()) - diese Abfrage ist die ehrliche
 * UI-Entsprechung dazu, nicht die eigentliche Sperre. Als Funktion statt einer
 * Konstante, weil ein Rechtewechsel ohne Reload ankommt und jedes Re-Render neu
 * fragen soll. Selbes Muster wie readOnly() in public/pages/waste.js.
 */
function readOnly() {
  return isNavModuleReadOnly('schedule');
}

// canWrite/canEditType tragen jetzt BEIDE Achsen: die Eigentuemer-Pruefung
// (wem gehoert die Zeile) UND das Modul-Nur-lesen-Recht (darf diese Person
// ueberhaupt etwas im Modul schreiben, egal wessen Zeile). Eine zentrale
// Stelle statt eines Extra-`&& !readOnly()` an jeder Aufrufstelle - patternCard(),
// shiftTypeCard(), customFieldRow(), overrideRows() und extraRows() lesen
// beide Funktionen ohnehin schon fuer ihre "gehoert es mir"-Frage.
const canWrite = (userId) => !readOnly() && (canManageOthers || Number(userId) === Number(currentUserId));

// Ein Schichttyp gehoert dem Haushalt und nicht einer Person: jeder darf einen
// anlegen, aendern und loeschen nur der Ersteller oder ein Admin. Ein Typ, dessen
// Ersteller nicht mehr da ist, traegt `created_by = null` und liegt bei den Admins.
// Ohne diese Pruefung stuenden Formular und Loeschknopf bei jedem - und endeten
// verlaesslich in 403.
const canEditType = (type) => !readOnly() && (canManageOthers
  || (type?.created_by != null && Number(type.created_by) === Number(currentUserId)));
const clockLabel = (shiftType) => {
  if (!shiftType?.start_time || !shiftType?.end_time) return t('schedule.allDay');
  const crossesDay = shiftType.end_time <= shiftType.start_time;
  const fullDay = shiftType.end_time === shiftType.start_time;
  return `${shiftType.start_time}–${shiftType.end_time}${crossesDay ? ' +1' : ''}${fullDay ? ' · 24 h' : ''}`;
};

// S-02: der Server antwortet mit technischen Validierungs-/Konflikttexten
// ("shift_type_id must be a positive number.", "cycle_length cannot exclude
// existing pattern days.", "Shift type is in use.") - bisher landeten die
// unveraendert im Toast. Kein bestehendes Modul im Repo bildet dafuer schon
// eine Rohtext-zu-Uebersetzung ab (recherchiert: router.js' und documents.js'
// gleichnamige friendlyError() ordnen nur nach HTTP-Status/Fehlername, nie
// nach dem WORTLAUT der Meldung) - diese Zuordnung hier ist die erste ihrer
// Art. Ein unbekannter Text faellt unveraendert durch (der Rohtext bleibt
// lesbarer als der generische Fehler, falls der Server je einen neuen Text
// ausgibt, den diese Liste noch nicht kennt). Die API-Vertragstexte selbst
// (server/routes/schedule.js) bleiben unangetastet - das hier ist rein
// clientseitige Uebersetzung, kein Vertragswechsel.
const SCHEDULE_SERVER_ERROR_MESSAGES = {
  'shift_type_id must be a positive number.': () => t('schedule.shiftTypeRequiredError'),
  'cycle_length cannot exclude existing pattern days.': () => t('schedule.cycleLengthConflictGeneric'),
  'Shift type is in use.': () => t('schedule.typeInUse'),
};

function scheduleErrorMessage(error) {
  const raw = error?.data?.error ?? error?.message;
  return (raw && SCHEDULE_SERVER_ERROR_MESSAGES[raw]?.()) ?? raw ?? t('common.errorGeneric');
}

async function load() {
  const day = todayKey();
  const [users, types, customFields, patternResult, overrides, extras, entries, preferences, householdPrefs, householdMembers] = await Promise.all([
    api.get('/auth/users'),
    api.get('/schedule/shift-types'),
    api.get('/schedule/custom-fields'),
    api.get('/schedule/patterns'),
    api.get('/schedule/overrides'),
    api.get('/schedule/extras'),
    api.get(`/schedule/entries?from=${day}&to=${day}`),
    api.get('/schedule/preferences'),
    // Haushaltweit, admin-only (server/routes/preferences.js) - welche
    // Quickstart-Vorlagen ueberhaupt angeboten werden, nicht zu verwechseln
    // mit den per-Nutzer-Werten oben aus /schedule/preferences.
    api.get('/preferences').catch(() => ({ data: {} })),
    // Vorgefiltert (isHouseholdMember()) fuer den Uebersicht-Tab - Haushaltshilfen
    // und Split-Expense-Gaeste sollen dort nie eine eigene Spur bekommen.
    api.get('/schedule/household-members').catch(() => ({ data: [] })),
  ]);
  const patterns = patternResult.data ?? [];
  const days = await Promise.all(patterns.map((pattern) => api.get(`/schedule/patterns/${pattern.id}/days`)));
  state = {
    users: users.data ?? [],
    types: types.data ?? [],
    customFields: customFields.data ?? [],
    patterns: patterns.map((pattern, index) => ({ ...pattern, days: days[index].data ?? [] })),
    overrides: overrides.data ?? [],
    extras: extras.data ?? [],
    entries: entries.data?.entries ?? [],
    warnings: entries.data?.warnings ?? [],
    reminderOffsetMinutes: preferences.data?.reminderOffsetMinutes ?? null,
    weeklyHours: preferences.data?.weeklyHours ?? null,
    overtimeEnabled: preferences.data?.overtimeEnabled !== false,
    hiddenTemplates: Array.isArray(householdPrefs.data?.schedule_hidden_templates) ? householdPrefs.data.schedule_hidden_templates : [],
    weekStartPref: householdPrefs.data?.week_start ?? null,
  };
  overview = {
    ...overview,
    people: householdMembers.data ?? [],
    selectedIds: normalizeOverviewSelection(loadSavedOverviewSelection(), (householdMembers.data ?? []).map((person) => person.id)),
  };
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
  // Locale-abhaengiges Dezimaltrennzeichen (Komma im Deutschen) statt eines
  // festen toFixed(1) - der geteilte Zahlenformatierer (i18n.js) traegt
  // dieselbe Rundung auf eine Nachkommastelle, faellt aber bei einer ganzen
  // Zahl von selbst auf keine Nachkommastelle zurueck (minimumFractionDigits
  // bleibt bei 0), genau das vorherige "9" statt "9.0".
  const value = getNumberFormat({ maximumFractionDigits: 1 }).format(hours);
  return t('schedule.hoursValue', { value });
}

// Personenbezogen und konfigurierbar (users.schedule_weekly_hours), NICHT ein
// Haushaltsfeld - ein Teilzeit- und ein Vollzeit-Mitglied im selben Haushalt
// haben unterschiedliche Sollstunden. 40 ist der Rueckfall, solange niemand
// einen eigenen Wert gesetzt hat; die Markierung bleibt ein Hinweis, kein
// Urteil - es gibt keine Ablehnung, nur eine Zahl neben einer anderen.
const DEFAULT_WEEKLY_HOURS = 40;

// Ein ROLLIERENDES 7-Tage-Fenster statt fester Kalenderwochen (Mo-So o.ae.):
// ein Schichtblock kann eine Wochengrenze ueberspannen (z.B. Do-Mo als
// zusammenhaengende fuenf Tage) - feste Wochen zerschneiden ihn dann in zwei
// Haelften, von denen keine allein die Schwelle reisst, obwohl die
// zusammenhaengenden sieben Tage es sehr wohl tun. Der Wochenstart des
// Haushalts ist hier deshalb irrelevant: jedes Fenster von genau sieben
// aufeinanderfolgenden Kalendertagen zaehlt, nicht nur die, die an einem
// bestimmten Wochentag beginnen. Gemeldet wird nur das SCHLIMMSTE Fenster
// (nicht die Summe ueber alle ueberlappenden Fenster - die teilen sich
// dieselben Tage mehrfach, das wuerde denselben Ueberschuss vielfach zaehlen).
// S-02: derselbe Check, den der Server ohnehin durchsetzt (server/routes/
// schedule.js: "SELECT 1 FROM schedule_pattern_days WHERE pattern_id=? AND
// position>=?"), hier VORAB gegen die bereits im Client vorliegenden
// Zyklustage - eine Verkuerzung, die eine bestehende Zeile ausschliessen
// wuerde, kam bisher erst als Rohtext ("cycle_length cannot exclude existing
// pattern days.") vom Server zurueck. Reine Funktion (kein state-Zugriff),
// damit ein Test echte Tage hineingeben kann - dasselbe Muster wie
// overtimeInfo()/rangeDifference() in diesem Modul. `days` ist bewusst KEIN
// state.patterns-Zugriff hier: erwartet wird das bereits geladene
// `pattern.days`-Array (ein Eintrag je tatsaechlich in der Tabelle
// vorhandenen Zyklustag), 1-indexierte Position im Rueckgabewert, weil die
// Kartenansicht Positionen selbst auch 1-indexiert beschriftet (`position + 1`).
function patternDaysExceedingCycleLength(days, cycleLength) {
  const excludedPositions = (days ?? [])
    .map((day) => Number(day.position))
    .filter((position) => position >= cycleLength);
  if (!excludedPositions.length) return null;
  return { from: Math.min(...excludedPositions) + 1, to: Math.max(...excludedPositions) + 1 };
}

// S-04: Tage seit `fromKey` bis `toKey` (kann negativ sein, wenn `toKey` vor
// `fromKey` liegt) - beide sind reine YYYY-MM-DD-Schluessel, `parseLocalDateKey`
// baut daraus lokale Mitternachts-Zeitpunkte. Gerundet statt ganzzahlig geteilt:
// eine Zeitzone mit Sommerzeit-Umstellung zwischen den beiden Tagen liefert
// sonst 23h/25h-Differenzen, die knapp unter/ueber einem vollen Tag landen -
// derselbe Rundungs-Kommentar wie overtimeInfo()'s sixDaysMs-Fenster oben.
function daysBetweenKeys(fromKey, toKey) {
  return Math.round((parseLocalDateKey(toKey).getTime() - parseLocalDateKey(fromKey).getTime()) / 86400000);
}

/**
 * S-04: naechstes Datum (>= todayKeyValue), an dem Zyklusposition `position`
 * (1-indexiert, wie die Kartenanzeige sie schon beschriftet) eintritt. Das
 * Muster wiederholt sich alle `cycleLength` Tage in BEIDE Richtungen ab
 * `anchor` - ein Tag VOR dem Anker ist kein Sonderfall, sondern dieselbe
 * Rechnung rueckwaerts (S-04: genau das war bisher unerklaert). Reine Funktion
 * (kein state-Zugriff) mit Vorgabewert fuer `todayKeyValue`, damit ein Test
 * ein festes "heute" hineingeben kann, ohne die Systemuhr zu faelschen.
 */
function cycleDayNextDate(anchor, cycleLength, position, todayKeyValue = todayKey()) {
  const length = Number(cycleLength);
  if (!anchor || !Number.isInteger(length) || length < 1) return anchor;
  const normalize = (value) => ((value % length) + length) % length;
  const target = normalize(position - 1);
  const diff = daysBetweenKeys(anchor, todayKeyValue);
  const delta = normalize(target - normalize(diff));
  return addLocalDays(anchor, diff + delta);
}

/**
 * S-04: die Kopfzeile einer Zyklusposition ("1 · Do 10.09.") - dieselbe
 * Wochentag-Kurzform wie renderOverview()'s Tageskopf weiter unten
 * (`calendar.dayShort<Weekday>` + formatDayMonth()), hier fuer einen einzelnen
 * Zyklustag statt einer ganzen Woche. Faellt die naechste Wiederholung
 * ausserhalb eines gesetzten Gueltigkeitsfensters (valid_from/valid_until),
 * zeigt der Kopf stattdessen die ERSTE Wiederholung (anchor + position - 1) -
 * nie ein Datum, das das Muster laut seinem eigenen Fenster gar nicht zeigen
 * wuerde.
 */
function cycleDayHeaderLabel(anchor, cycleLength, validFrom, validUntil, position, todayKeyValue = todayKey()) {
  if (!anchor || !cycleLength) return String(position);
  let date = cycleDayNextDate(anchor, cycleLength, position, todayKeyValue);
  if ((validFrom && date < validFrom) || (validUntil && date > validUntil)) {
    date = addLocalDays(anchor, position - 1);
  }
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][parseLocalDateKey(date).getDay()];
  return `${position} · ${t(`calendar.dayShort${weekday}`)} ${formatDayMonth(date)}`;
}

// S-05: Ueberlappungsfenster zweier Gueltigkeitsfenster (valid_from/valid_until,
// leer = unbegrenzt) - dieselbe Bedingung, die der Server beim Aufloesen
// bereits durchsetzt (server/services/schedule.js#resolveEntries:
// "valid_from <= date_key AND valid_until >= date_key"), hier als reiner
// Intervall-Vergleich statt Tag-fuer-Tag. String-Vergleich reicht wieder
// (YYYY-MM-DD sortiert lexikographisch identisch zur Kalenderordnung, siehe
// rangeDifference() oben).
function windowsOverlap(aFrom, aUntil, bFrom, bUntil) {
  const aStart = aFrom || '0000-01-01';
  const aEnd = aUntil || '9999-12-31';
  const bStart = bFrom || '0000-01-01';
  const bEnd = bUntil || '9999-12-31';
  return aStart <= bEnd && bStart <= aEnd;
}

// S-05: findet eine ANDERE aktive Musterkarte derselben Person, deren Fenster
// das neue/gerade bearbeitete ueberschneidet - Grundlage sowohl fuer die
// Rueckfrage vor dem Anlegen (saveCreatedSchedule()) als auch fuer die
// Reaktivieren-Rueckfrage (submitForm()' pattern-update-Zweig).
function findOverlappingActivePattern(patterns, userId, validFrom, validUntil, excludeId = null) {
  return patterns.find((pattern) => pattern.is_active
    && Number(pattern.user_id) === Number(userId)
    && (excludeId == null || Number(pattern.id) !== Number(excludeId))
    && windowsOverlap(pattern.valid_from, pattern.valid_until, validFrom, validUntil));
}

// S-05: dieselbe Prioritaet wie der Server (server/services/schedule.js#
// scheduleData: "ORDER BY user_id, valid_from DESC, id DESC") - SQLite sortiert
// NULL in DESC zuletzt, ein unbegrenztes valid_from verliert also gegen jedes
// gesetzte Datum.
function comparePatternPriority(a, b) {
  const aFrom = a.valid_from ?? null;
  const bFrom = b.valid_from ?? null;
  if (aFrom !== bFrom) {
    if (aFrom == null) return 1;
    if (bFrom == null) return -1;
    return aFrom < bFrom ? 1 : -1;
  }
  return Number(b.id) - Number(a.id);
}

/**
 * S-05: welches Muster gewinnt HEUTE fuer diese Person - null, solange sich
 * keine zwei aktiven Muster ueberhaupt ueberschneiden (eine einzelne aktive
 * Karte braucht kein "gewinnt"-Abzeichen, siehe patternCard()).
 */
function resolveWinningPatternId(patterns, userId, dateKey) {
  const candidates = patterns.filter((pattern) => pattern.is_active
    && Number(pattern.user_id) === Number(userId)
    && (!pattern.valid_from || pattern.valid_from <= dateKey)
    && (!pattern.valid_until || pattern.valid_until >= dateKey));
  if (candidates.length < 2) return null;
  return [...candidates].sort(comparePatternPriority)[0].id;
}

function overtimeInfo(entries, weeklyHours = DEFAULT_WEEKLY_HOURS) {
  const days = entries
    .map((entry) => ({ day: parseLocalDateKey(entry.date_key).getTime(), minutes: entry.shift_type ? (shiftMinutes(entry.shift_type) ?? 0) : 0 }))
    .sort((a, b) => a.day - b.day);
  const sixDaysMs = 6 * 86400000;
  let windowStart = 0;
  let windowSum = 0;
  let worstWindowMinutes = 0;
  for (let end = 0; end < days.length; end += 1) {
    windowSum += days[end].minutes;
    while (days[windowStart].day < days[end].day - sixDaysMs) {
      windowSum -= days[windowStart].minutes;
      windowStart += 1;
    }
    worstWindowMinutes = Math.max(worstWindowMinutes, windowSum);
  }
  const excessMinutes = Math.max(0, worstWindowMinutes - weeklyHours * 60);
  return { over: excessMinutes > 0, excessMinutes };
}

// Feste Presets statt eines freien Zahlenfelds: der Server deckelt ohnehin auf
// 24h (server/routes/schedule-preferences.js), und eine Handvoll sprechender
// Werte ist schneller getroffen als eine Minutenzahl zu tippen.
const REMINDER_OFFSET_PRESETS = [0, 5, 10, 15, 30, 60, 120];

// `selectedMinutes == null` heisst "noch nicht konfiguriert" (Umschalter aus /
// frisches Formular), nicht "0 Minuten Vorlauf" - `Number(null) === 0` waere
// sonst true und liesse den 0-Minuten-Eintrag ("zu Schichtbeginn") als
// vermeintliche Auswahl erscheinen, obwohl niemand ihn gewaehlt hat. Der
// Aendern-Handler liest beim Einschalten genau diesen (dann falschen) Wert aus
// dem <select> zurueck, sein eigener `?? 15`-Rueckfall greift also nie (er
// sieht nie `null`/`undefined`, sondern die Zeichenkette "0"). 15 Minuten ist
// deshalb hier, nicht erst dort, der tatsaechliche Vorgabewert.
function reminderOffsetOptions(selectedMinutes) {
  const effective = selectedMinutes ?? 15;
  const presetsHtml = REMINDER_OFFSET_PRESETS.map((minutes) =>
    `<option value="${minutes}"${Number(effective) === minutes ? ' selected' : ''}>${esc(t(minutes === 0 ? 'schedule.reminderAtStart' : 'schedule.reminderMinutesBefore', { minutes }))}</option>`
  ).join('');
  // S-23 (UX-Audit): der Server erlaubt 0-1440 Minuten (MAX_OFFSET_MINUTES/
  // MAX_REMINDER_OFFSET_MINUTES), diese Liste deckelte die UI zuvor auf 120 -
  // ein bereits gespeicherter Wert ausserhalb der Presets (z.B. per API
  // gesetzt) braucht eine echte, ausgewaehlte Option, sonst zeigt das <select>
  // stillschweigend die falsche Zeile als aktiv an.
  const customValueHtml = Number.isInteger(effective) && !REMINDER_OFFSET_PRESETS.includes(effective)
    ? `<option value="${effective}" selected data-custom-value="1">${esc(effective === 0 ? t('schedule.reminderAtStart') : t('schedule.reminderMinutesBefore', { minutes: effective }))}</option>`
    : '';
  return presetsHtml + customValueHtml + `<option value="custom">${esc(t('schedule.reminderCustomOffset'))}</option>`;
}

/**
 * S-23: "Custom..." selbst ist keine speicherbare Auswahl, sondern der
 * Einstiegspunkt zu promptModal() fuer eine freie Minutenzahl (0-1440, wie
 * der Server sie zulaesst). Erfolgreich bestaetigt, haengt sie sich als
 * echte, ausgewaehlte Option an (dieselbe Form wie ein bereits gespeicherter
 * Fremdwert oben) und meldet die Minuten an `onResolved` zurueck; abgebrochen
 * oder ungueltig, springt das <select> auf seinen letzten echten Wert zurueck -
 * "Custom..." bleibt selbst nie die aktive Auswahl.
 */
async function pickCustomReminderOffset(select, onResolved) {
  const previous = select.dataset.previousValue ?? '15';
  const input = await promptModal(t('schedule.customReminderOffsetPrompt'), '');
  const minutes = input == null ? NaN : Math.round(Number(input));
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
    select.value = previous;
    return;
  }
  let customOption = select.querySelector('option[data-custom-value]');
  if (!customOption) {
    customOption = document.createElement('option');
    customOption.dataset.customValue = '1';
    select.querySelector('option[value="custom"]')?.insertAdjacentElement('beforebegin', customOption);
  }
  customOption.value = String(minutes);
  customOption.textContent = minutes === 0 ? t('schedule.reminderAtStart') : t('schedule.reminderMinutesBefore', { minutes });
  select.value = String(minutes);
  select.dataset.previousValue = String(minutes);
  onResolved(minutes);
}

// Ein eigener Vorlauf je Extra, unabhaengig vom haushaltweiten Feld unten -
// eine Bereitschaft will vielleicht einen laengeren Vorlauf als die eigene
// regulaere Schicht (server/services/schedule-reminders.js#syncExtraRemindersForUser).
// Gleiches Umschalter-plus-Auswahl-Muster wie renderReminderSettings() unten,
// damit sich beide Stellen gleich bedienen, auch wenn diese hier in einem
// Formular statt einer Karte lebt.
function reminderOffsetField(selectedMinutes) {
  const active = selectedMinutes != null;
  return '<div class="form-field schedule-active-field"><span class="label">' + esc(t('schedule.extraReminderOffset')) + '</span><label class="toggle"><input name="reminder_enabled" type="checkbox"' + (active ? ' checked' : '') + '><span class="toggle__track"></span></label></div>'
    + '<select class="input" name="reminder_offset_minutes"' + (active ? '' : ' disabled') + '>' + reminderOffsetOptions(selectedMinutes) + '</select>';
}

function renderReminderSettings() {
  const active = state.reminderOffsetMinutes != null;
  const options = reminderOffsetOptions(state.reminderOffsetMinutes);
  const weeklyHours = state.weeklyHours ?? DEFAULT_WEEKLY_HOURS;
  // S-12 (UX-Audit): NICHT laenger an den Nur-lesen-Zustand des Moduls
  // gekoppelt. "My settings" ist die eigene Erinnerungsvorlaufzeit/
  // Wochenstunden - haengt an der eigenen users-Zeile, unabhaengig davon, ob
  // diese Person fremde Schichtplan-Daten schreiben darf. Vorher war das Feld
  // hier UND server-seitig gesperrt (ein Nur-lesen-Mitglied bekam ein
  // wirkungsloses 403 statt einer gespeicherten Einstellung); server/index.js
  // nimmt `/schedule/preferences` inzwischen aus der Modul-Sperre heraus,
  // dieses Formular darf ihr also folgen.
  return '<div class="card card--padded schedule-reminder-settings">'
    + '<h2 class="u-section-title">' + esc(t('schedule.mySettings')) + '</h2>'
    + '<div class="schedule-reminder-settings__row">'
    + toggleRowHtml({ label: t('schedule.reminderToggle'), checked: active, attrs: { id: 'schedule-reminder-toggle' } })
    + '<select class="input" id="schedule-reminder-offset" data-previous-value="' + esc(String(state.reminderOffsetMinutes ?? 15)) + '"' + (active ? '' : ' disabled') + '>' + options + '</select>'
    + '</div><p class="form-hint">' + esc(t('schedule.reminderHint')) + '</p>'
    // S-24 (UX-Audit, Entscheidung D-C): ein eigener Schalter statt eines
    // wiederverwendeten Sonderwerts (0 Wochenstunden bleibt eine gueltige,
    // ablehnbare Falscheingabe - siehe server/routes/schedule-preferences.js).
    // Aus schaltet die Wochenstunden-Eingabe UND die Ueberstundenkarte in der
    // Statistik gleichermassen ab (renderStatistics()/overtimeInfo() lesen
    // state.overtimeEnabled), statt nur eine der beiden Stellen zu vergessen.
    + '<div class="schedule-reminder-settings__row schedule-reminder-settings__row--overtime-toggle">'
    + toggleRowHtml({ label: t('schedule.overtimeTrackingToggle'), checked: state.overtimeEnabled, attrs: { id: 'schedule-overtime-toggle' } })
    + '</div><p class="form-hint">' + esc(t('schedule.overtimeTrackingHint')) + '</p>'
    + '<div class="schedule-reminder-settings__row schedule-reminder-settings__row--hours">'
    + '<label class="label" for="schedule-weekly-hours">' + esc(t('schedule.weeklyHoursLabel')) + '</label>'
    + '<input class="input" type="number" min="1" max="168" step="1" id="schedule-weekly-hours" value="' + esc(String(weeklyHours)) + '"' + (state.overtimeEnabled ? '' : ' disabled') + '>'
    + '</div><p class="form-hint">' + esc(t('schedule.weeklyHoursHint')) + '</p></div>';
}

async function savePreference(patch) {
  try {
    const result = await api.put('/schedule/preferences', patch);
    state.reminderOffsetMinutes = result.data?.reminderOffsetMinutes ?? null;
    state.weeklyHours = result.data?.weeklyHours ?? null;
    state.overtimeEnabled = result.data?.overtimeEnabled !== false;
  } catch (err) {
    window.yuvomi?.showToast(scheduleErrorMessage(err), 'danger');
  }
  renderPage();
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

// Liest `statisticsRequestId` bewusst OHNE Parameter: der Aufrufer (activateView()/
// submitForm()) erhoeht den geteilten Zaehler synchron, BEVOR er diese Funktion
// ruft (kein await dazwischen), sodass die hier gelesene Nummer garantiert die
// ist, die der Aufrufer gerade reserviert hat. Kommt die Antwort zurueck,
// nachdem ein juengerer Aufruf den Zaehler weitergedreht hat, ist dieses
// Ergebnis veraltet und darf `statistics` nicht mehr ueberschreiben - sonst
// gewinnt ein schnelles Doppel-Klicken auf "Anwenden" oder ein rascher
// Tab-Wechsel manchmal die AELTERE Antwort gegen die juengere.
async function refreshStatistics() {
  const requestId = statisticsRequestId;
  const bounds = statisticBounds();
  // S-06: ein ungueltiger Zeitraum (leer oder umgekehrt, from > to) ist kein
  // Verbindungsfehler - kein Fetch, kein Fehler-Toast, nur der bereits
  // vorhandene "Waehle einen gueltigen Zeitraum"-Zustand (renderStatistics()'
  // !bounds-Zweig unten). Vorher warf diese Funktion hier, und beide Aufrufer
  // (activateView()/submitForm()) fingen das im catch als generischen Fehler
  // auf (statistics.error = true) - der invalidRange-Text existierte zwar
  // schon lange, war aber ueber keinen der beiden Wege je erreichbar.
  if (!bounds) {
    if (requestId !== statisticsRequestId) return; // ueberholt, siehe Kommentar unten
    statistics = { ...statistics, bounds: null, loading: false };
    return;
  }
  const userId = statistics.userId || currentUserId;
  const result = await api.get('/schedule/entries?from=' + encodeURIComponent(bounds.from) + '&to=' + encodeURIComponent(bounds.to) + '&user_id=' + encodeURIComponent(userId));
  if (requestId !== statisticsRequestId) return; // ueberholt - eine juengere Anfrage laeuft/liegt bereits vor
  statistics = { ...statistics, userId: Number(userId), entries: result.data?.entries ?? [], bounds, loading: false };
}

async function activateView(view) {
  activeView = view;
  if (view === 'overview') {
    const requestId = ++overviewRequestId;
    overview = { ...overview, entries: [], holidays: [], loading: true, error: false };
    renderPage();
    try { await refreshOverview(); }
    catch (error) {
      if (requestId !== overviewRequestId) return; // eine juengere Anfrage entscheidet, nicht diese veraltete
      overview = { ...overview, loading: false, error: true };
      window.yuvomi?.showToast(scheduleErrorMessage(error), 'danger');
    }
    if (requestId === overviewRequestId) renderPage();
    return;
  }
  if (view !== 'statistics') { renderPage(); return; }
  const requestId = ++statisticsRequestId;
  statistics = { ...statistics, entries: [], bounds: null, loading: true, error: false };
  renderPage();
  try { await refreshStatistics(); }
  catch (error) {
    if (requestId !== statisticsRequestId) return;
    statistics = { ...statistics, loading: false, error: true };
    window.yuvomi?.showToast(scheduleErrorMessage(error), 'danger');
  }
  if (requestId === statisticsRequestId) renderPage();
}

/**
 * Einen Tag vor dem ersten sichtbaren Tag mitholen: eine Nachtschicht auf dem
 * letzten Tag der VORIGEN Woche wird sonst nie geladen, und ihre Fortsetzung
 * auf dem ersten sichtbaren Tag der neuen Woche faellt ersatzlos weg statt zu
 * erscheinen (Review-Fund 2026-09-05, #1022). buildOverviewLanes() rendert
 * diesen zusaetzlichen Tag nie selbst als Spalte - er dient nur als Quelle
 * fuer eine Fortsetzung, die auf einen Tag aus `weekDays` faellt. Die
 * Feiertage brauchen das nicht, sie kennen keine Fortsetzung ueber Mitternacht.
 */
function overviewFetchRange(weekCursor, weekStartPref) {
  const weekStart = weekStartIndex(weekStartPref);
  const from = startOfLocalWeekKey(weekCursor, weekStart);
  return { entriesFrom: addLocalDays(from, -1), from, to: addLocalDays(from, 6) };
}

/**
 * Woche neu laden, wenn overview.weekCursor sich aendert - die Auswahl der
 * Personen (overview.selectedIds) loest NIE einen Fetch aus, nur eine
 * Neuzeichnung; nur der Wochenwechsel tut das (siehe activateView()/
 * navigateOverviewWeek()).
 *
 * Liest `overviewRequestId` bewusst OHNE Parameter, aus demselben Grund wie
 * refreshStatistics() oben: der Aufrufer erhoeht den Zaehler synchron direkt
 * vor diesem Aufruf, ohne await dazwischen - was hier gelesen wird, ist also
 * garantiert die gerade reservierte Nummer. Kommt die Antwort zurueck,
 * nachdem ein juengerer Wochen-/Tab-Wechsel den Zaehler weitergedreht hat, ist
 * sie veraltet und darf `overview` nicht mehr ueberschreiben (schnelles
 * Vor-/Zurueck-Klicken liess sonst manchmal die AELTERE Woche gewinnen).
 */
async function refreshOverview() {
  const requestId = overviewRequestId;
  const { entriesFrom, from, to } = overviewFetchRange(overview.weekCursor, state.weekStartPref);
  const [entriesRes, holidaysRes] = await Promise.all([
    api.get(`/schedule/entries?from=${entriesFrom}&to=${to}`),
    api.get(`/calendar/holidays?from=${from}&to=${to}`).catch(() => ({ data: [] })),
  ]);
  if (requestId !== overviewRequestId) return; // ueberholt - siehe refreshStatistics()
  overview = {
    ...overview,
    entries: entriesRes.data?.entries ?? [],
    holidays: holidaysRes.data ?? [],
    loading: false,
  };
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
    period1: t('schedule.presets.period1'),
    period2: t('schedule.presets.period2'),
    period3: t('schedule.presets.period3'),
    period4: t('schedule.presets.period4'),
    exam: t('schedule.presets.exam'),
    lecture: t('schedule.presets.lecture'),
    seminar: t('schedule.presets.seminar'),
    lab: t('schedule.presets.lab'),
  };
  return labels[key] ?? '';
}

// S-22 (UX-Audit): 15 Presets in einer einzigen flachen Liste liessen sich
// nur am Namen erkennen, aus welcher Vorlage sie stammen ("Periode 2" neben
// "Vorlesung" neben "Fruehschicht"). Optgroups je Vorlage - dieselben drei,
// die auch die Schnellstart-Knoepfe zeigen, plus eine gemeinsame Gruppe fuer
// die vorlagenuebergreifenden Presets (Urlaub/Krank/Klausur, ueberall
// identisch). Respektiert dieselbe Haushalts-Einstellung wie die Knoepfe
// (visibleQuickstartTemplates()) - ein Haushalt, der nur "Arbeit" braucht,
// sieht hier ebenso wenig Schule/Uni-Eintraege.
function shiftPresetOptgroups() {
  const shared = new Set(SHARED_PRESETS.map((preset) => preset.key));
  shared.add('exam'); // identisch in Schule/Uni, eine gemeinsame Gruppe statt zwei Dopplungen.
  const visible = new Set(visibleQuickstartTemplates().map(([key]) => key));
  const groups = [];
  for (const [templateKey, labelKey] of QUICKSTART_TEMPLATES) {
    if (!visible.has(templateKey)) continue;
    const presets = PRESET_TEMPLATES[templateKey].filter((preset) => !shared.has(preset.key));
    if (presets.length) groups.push({ label: t(labelKey), presets });
  }
  const sharedPresets = ALL_PRESETS.filter((preset) => shared.has(preset.key));
  if (sharedPresets.length) groups.push({ label: t('schedule.presetShared'), presets: sharedPresets });
  return groups;
}

function shiftPresetOptions() {
  const groupsHtml = shiftPresetOptgroups().map((group) => '<optgroup label="' + esc(group.label) + '">'
    + group.presets.map((preset) => option(preset.key, shiftPresetLabel(preset.key))).join('')
    + '</optgroup>').join('');
  return option('', t('schedule.presetCustom'), true) + groupsHtml;
}

function setShiftIconButtonIcon(button, iconName) {
  button.querySelectorAll('i[data-lucide], svg.lucide').forEach((el) => el.remove());
  button.insertAdjacentHTML('afterbegin', '<i data-lucide="' + esc(iconName || 'image-off') + '" aria-hidden="true"></i>');
  window.lucide?.createIcons({ el: button });
}

function applyShiftPreset(form) {
  const selected = ALL_PRESETS.find((preset) => preset.key === form.elements.shift_preset?.value);
  if (!selected) return;
  form.elements.name.value = shiftPresetLabel(selected.key);
  form.elements.short_code.value = selected.shortCode;
  form.elements.start_time.value = selected.startTime;
  form.elements.end_time.value = selected.endTime;
  form.elements.color.value = selected.color;
  form.elements.icon.value = selected.icon ?? '';
  const iconButton = form.querySelector('[data-action="pick-shift-icon"]');
  if (iconButton) setShiftIconButtonIcon(iconButton, selected.icon);
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
    formField(t('schedule.icon'), '<button type="button" class="btn btn--secondary schedule-icon-picker" data-action="pick-shift-icon">'
      + (type.icon ? '<i data-lucide="' + esc(type.icon) + '" aria-hidden="true"></i>' : '<i data-lucide="image-off" aria-hidden="true"></i>')
      + '<span>' + esc(t('schedule.chooseIcon')) + '</span></button>'
      + '<input type="hidden" name="icon" value="' + esc(type.icon ?? '') + '">'),
    formField(t('schedule.startTime'), '<yuvomi-datepicker name="start_time" type="time" label="' + esc(t('schedule.startTime')) + '" value="' + esc(type.start_time ?? '') + '"></yuvomi-datepicker>'),
    formField(t('schedule.endTime'), '<yuvomi-datepicker name="end_time" type="time" label="' + esc(t('schedule.endTime')) + '" value="' + esc(type.end_time ?? '') + '"></yuvomi-datepicker>'),
  ].join('');
}

/**
 * Oeffnet die Symbolauswahl fuer den Knopf, der gerade geklickt wurde, und
 * schreibt das Ergebnis ins versteckte `icon`-Feld desselben Formulars -
 * gemeinsame Logik fuer beide Wege dorthin: den Klick-Delegierten von
 * action() (Inline-Bearbeitung, im DOM von `root`) und die Verdrahtung in
 * openScheduleCreateModal()'s onSave (das Modal haengt an document.body,
 * ausserhalb von `root`, der Delegierte erreicht es nicht).
 */
async function pickShiftIcon(button) {
  const form = button.closest('form');
  const hidden = form?.elements?.icon;
  if (!hidden) return;
  const { openIconPicker } = await import('/components/icon-picker.js');
  const chosen = await openIconPicker(hidden.value || null);
  if (chosen === undefined) return;
  hidden.value = chosen ?? '';
  setShiftIconButtonIcon(button, chosen);
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
    ? `<form class="schedule-form" data-form="shift-update" data-id="${type.id}">${shiftFields(type)}<div class="schedule-actions"><button class="btn btn--secondary">${esc(t('schedule.save'))}</button><button type="button" class="btn btn--danger-outline" data-action="delete-shift" data-id="${type.id}">${esc(t('schedule.delete'))}</button></div></form>`
    : `<p class="schedule-readonly">${esc(type?.created_by == null
        ? t('schedule.typeOrphaned')
        : t('schedule.typeOwnedBy', { user: userName(type.created_by) }))}</p>`;
  const icon = type.icon ? `<i data-lucide="${esc(type.icon)}" class="schedule-type-icon" aria-hidden="true"></i>` : '';
  // Nur zeigen, wenn der Haushalt ueberhaupt Felder definiert hat - eine leere
  // "Eigene Felder"-Sektion auf JEDER Schichttyp-Karte waere fuer den (haeufigen)
  // reinen Arbeitsschicht-Haushalt, der die Registrierung nie anfasst, nur Ballast.
  const fieldsEditor = editable && state.customFields.length ? shiftTypeFieldsEditor(type) : '';
  return `<details class="card schedule-details"><summary><span class="schedule-swatch" style="--schedule-color:${esc(type.color)}"></span>${icon}<span class="u-card-title u-compact">${esc(type.short_code ? `${type.short_code} · ${type.name}` : type.name)}</span> <small>${esc(clockLabel(type))}</small></summary>
    ${body}
    ${fieldsEditor}
  </details>`;
}

function shiftTypeFieldRow(field) {
  return '<div class="schedule-type-field-row" data-type-field-row data-custom-field-id="' + field.id + '">'
    + '<button type="button" class="schedule-type-field-row__handle" aria-hidden="true" tabindex="-1"><i data-lucide="grip-vertical" aria-hidden="true"></i></button>'
    + '<span class="schedule-type-field-row__name">' + esc(field.name) + '</span>'
    + '<label class="toggle schedule-type-field-row__overlay"><input type="checkbox" data-show-in-overlay' + (field.show_in_overlay ? ' checked' : '') + '><span class="toggle__track"></span>' + esc(t('schedule.showInOverlay')) + '</label>'
    + '<button type="button" class="btn btn--secondary btn--icon" data-action="move-type-field" data-direction="up" aria-label="' + esc(t('schedule.moveUp')) + '"><i data-lucide="chevron-up" aria-hidden="true"></i></button>'
    + '<button type="button" class="btn btn--secondary btn--icon" data-action="move-type-field" data-direction="down" aria-label="' + esc(t('schedule.moveDown')) + '"><i data-lucide="chevron-down" aria-hidden="true"></i></button>'
    + '<button type="button" class="btn btn--secondary btn--icon" data-action="remove-type-field" aria-label="' + esc(t('common.delete')) + '"><i data-lucide="x" aria-hidden="true"></i></button>'
    + '</div>';
}

// Eine ZWEITE, unabhaengig gespeicherte Sektion neben dem shift-update-Formular
// oben - derselbe Aufbau wie patternCard()'s Zyklustage-Editor + eigener
// save-days-Knopf: rein lokale Aenderungen (hinzufuegen/entfernen/umsortieren/
// Overlay-Haken), erst der Speichern-Klick hier schreibt etwas.
function shiftTypeFieldsEditor(type) {
  const attachedIds = new Set(type.fields.map((field) => field.id));
  const available = state.customFields.filter((field) => !attachedIds.has(field.id));
  const rows = type.fields.map(shiftTypeFieldRow).join('');
  const picker = available.length
    ? '<div class="schedule-type-field-add">'
      + '<select class="input" data-field-picker="' + type.id + '">' + available.map((field) => option(field.id, field.name)).join('') + '</select>'
      + '<button type="button" class="btn btn--secondary" data-action="add-type-field" data-id="' + type.id + '">' + esc(t('common.add')) + '</button>'
      + '</div>' : '';
  const body = '<div class="schedule-type-fields-rows" data-type-fields-rows="' + type.id + '">'
    + (rows || '<p class="u-meta">' + esc(t('schedule.noFieldsAttached')) + '</p>') + '</div>'
    + picker
    + '<div class="schedule-actions"><button type="button" class="btn btn--secondary" data-action="save-shift-fields" data-id="' + type.id + '">' + esc(t('schedule.save')) + '</button></div>';
  return advancedSection(body, { label: t('schedule.attachedFields') });
}

// Ein Feld gehoert dem Haushalt, nicht einer Person - definiert einmal, an
// beliebig viele Schichttypen anheftbar (Phase 2), damit "Raum" nicht pro
// Schichttyp neu getippt werden muss. Anlegen darf jeder, aendern/loeschen
// nur wer es angelegt hat oder ein Admin - derselbe Massstab wie bei
// Schichttypen (canEditType() liest ohnehin nur created_by/canManageOthers,
// unabhaengig von der Tabelle).
function customFieldRow(field) {
  const editable = canEditType(field);
  const actions = editable
    ? '<span class="schedule-override-actions"><button type="button" class="btn btn--secondary" data-action="edit-custom-field" data-id="' + field.id + '">' + esc(t('common.edit')) + '</button>'
      + '<button type="button" class="btn btn--danger-outline" data-action="delete-custom-field" data-id="' + field.id + '">' + esc(t('schedule.delete')) + '</button></span>'
    : '';
  return '<div class="list-row schedule-custom-field-row"><div class="list-row__main"><span class="list-row__name">' + esc(field.name) + '</span></div>' + actions + '</div>';
}

function emptyCustomFieldsState() {
  return emptyStateHTML({
    icon: 'list-plus',
    title: t('schedule.emptyCustomFieldsTitle'),
    description: t('schedule.emptyCustomFieldsDescription'),
    actions: readOnly() ? [] : [{ label: t('schedule.createCustomField'), icon: 'plus', attrs: { 'data-action': 'open-create-custom-field' } }],
  });
}

function customFieldsSection() {
  return '<section class="schedule-library schedule-library--custom-fields"><div class="schedule-library__head"><h2 class="u-section-title">' + esc(t('schedule.customFields')) + '</h2>'
    + (state.customFields.length && !readOnly() ? '<button type="button" class="btn btn--secondary" data-action="open-create-custom-field"><i data-lucide="plus" aria-hidden="true"></i>' + esc(t('schedule.createCustomField')) + '</button>' : '') + '</div>'
    + (state.customFields.length ? '<div class="list-rows">' + state.customFields.map(customFieldRow).join('') + '</div>' : emptyCustomFieldsState())
    + '</section>';
}

// EIN <select> je Zyklustag reichte, solange ein Tag hoechstens eine Klasse
// trug. Fuer einen Stundenplan (mehrere Klassen zu verschiedenen Zeiten am
// selben Tag) traegt jede Position jetzt eine variable Anzahl Zeilen (0..N),
// mit "+"/"x" zum lokalen Hinzufuegen/Entfernen - erst der Save-Klick schreibt
// etwas. save-days' Handler bleibt unveraendert: er sammelt ohnehin JEDES
// [data-day]-Element, unabhaengig davon, wie viele dieselbe Position tragen.
// Der Feld-Unterblock einer Zeile, sourced aus dem Schichttyp des GERADE
// gewaehlten Werts - dieselbe Funktion baut ihn beim ersten Rendern UND beim
// Nachziehen nach einem Schichttyp-Wechsel (siehe der 'change'-Zweig in
// renderShell() weiter unten), damit beide Wege garantiert dasselbe Markup
// erzeugen.
// `writable=false` disabled JEDES Eingabefeld eines Zyklustags mit, nicht nur
// den Entfernen-Knopf: ein fremdes Muster (patternCard()'s `writable`) rendert
// diese Zeile rein lesend, und ein aktives <select>/<input> ohne Speicherpfad
// (save-days schreibt ohnehin nur nach einem Klick auf den - hier fehlenden -
// Speichern-Knopf) waere eine Eingabe, die niemals ankommt.
function dayRowFieldsHtml(shiftTypeId, fieldValues = {}, writable = true) {
  const type = state.types.find((t) => Number(t.id) === Number(shiftTypeId));
  if (!type?.fields.length) return '';
  const disabledAttr = writable ? '' : ' disabled';
  return '<div class="schedule-day-row-fields" data-day-row-fields>' + type.fields.map((field) =>
    formField(field.name, '<input class="input" data-field-value="' + field.id + '" maxlength="500" value="' + esc(fieldValues[field.id] ?? '') + '"' + disabledAttr + '>')
  ).join('') + '</div>';
}

function dayRowHtml(position, shiftTypeId, writable, fieldValues = {}) {
  const remove = writable ? '<button type="button" class="btn btn--secondary btn--icon" data-action="remove-pattern-day-row" aria-label="' + esc(t('common.delete')) + '"><i data-lucide="x" aria-hidden="true"></i></button>' : '';
  const disabledAttr = writable ? '' : ' disabled';
  return '<div class="schedule-day-row" data-day-row>'
    + '<div class="schedule-day-row__main"><select class="input" data-day="' + position + '"' + disabledAttr + '>' + typeOptions(shiftTypeId) + '</select>' + remove + '</div>'
    + dayRowFieldsHtml(shiftTypeId, fieldValues, writable)
    + '</div>';
}

function patternCard(pattern) {
  const writable = canWrite(pattern.user_id);
  const assigned = new Map();
  for (const day of pattern.days) {
    const position = Number(day.position);
    if (!assigned.has(position)) assigned.set(position, []);
    assigned.get(position).push({ shiftTypeId: day.shift_type_id, fieldValues: day.field_values ?? {} });
  }
  const days = Array.from({ length: pattern.cycle_length }, (_, position) => {
    const classes = assigned.get(position) ?? [{ shiftTypeId: null, fieldValues: {} }];
    const rows = classes.map((day) => dayRowHtml(position, day.shiftTypeId, writable, day.fieldValues)).join('');
    const add = writable ? '<button type="button" class="btn btn--secondary" data-action="add-pattern-day-row" data-position="' + position + '">' + esc(t('common.add')) + '</button>' : '';
    // S-04: die Kopfzeile nennt das naechste tatsaechliche Datum dieser
    // Position ("1 · Do 10.09."), nicht nur eine nackte Nummer - `data-day-
    // group-label` ist der Anker, an dem das Live-Neuberechnen (renderShell()'
    // 'input'/'change'-Delegierte) den Text austauscht, sobald Start-/
    // Zykluslaenge-Feld sich aendert, ohne die Zeilen selbst neu zu bauen.
    const label = cycleDayHeaderLabel(pattern.anchor_date, pattern.cycle_length, pattern.valid_from, pattern.valid_until, position + 1);
    return '<div class="form-field schedule-day-group" data-day-group="' + position + '"><label class="label" data-day-group-label>' + esc(label) + '</label><div class="schedule-day-rows">' + rows + '</div>' + add + '</div>';
  }).join('');
  // S-05: nur sichtbar, wenn diese Karte HEUTE tatsaechlich gegen eine andere
  // aktive Karte derselben Person konkurriert (resolveWinningPatternId()
  // liefert sonst null) - eine einzelne aktive Karte traegt kein Abzeichen.
  const winningId = resolveWinningPatternId(state.patterns, pattern.user_id, todayKey());
  const winsBadge = winningId != null && Number(winningId) === Number(pattern.id)
    ? '<span class="schedule-wins-badge">' + esc(t('schedule.patternWinsBadge')) + '</span>'
    : '';
  return `<details class="card schedule-details" data-pattern="${pattern.id}"><summary><span class="u-card-title u-compact">${esc(pattern.name)}</span> <small>· ${esc(userName(pattern.user_id))}</small>${winsBadge}</summary>
    ${writable ? `<form class="schedule-form" data-form="pattern-update" data-id="${pattern.id}">${patternFields(pattern)}<button class="btn btn--secondary">${esc(t('schedule.save'))}</button></form>` : ''}
    <h3 class="u-card-title">${esc(t('schedule.cycleDays'))}</h3><p class="u-meta schedule-cycle-hint">${esc(t('schedule.cycleDaysHint', { count: pattern.cycle_length }))}</p><div class="schedule-days">${days}</div>
    ${writable ? `<div class="schedule-actions"><button type="button" class="btn btn--secondary" data-action="save-days" data-id="${pattern.id}">${esc(t('schedule.save'))}</button><button type="button" class="btn btn--danger-outline" data-action="delete-pattern" data-id="${pattern.id}">${esc(t('schedule.delete'))}</button></div>` : ''}
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
// Zwei field_values-Objekte gelten als gleich, wenn sie dieselben Schluessel
// UND Werte tragen - Schluesselreihenfolge ist bei einem aus JSON geparsten
// Objekt kein verlaessliches Merkmal, deshalb kein blosser JSON.stringify()-Vergleich.
function sameFieldValues(a = {}, b = {}) {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}

function overrideGroups(overrides = state.overrides) {
  const sorted = [...overrides].sort((a, b) =>
    Number(a.user_id) - Number(b.user_id) || a.date_key.localeCompare(b.date_key));
  const groups = [];
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    const sameSeries = last
      && Number(last.user_id) === Number(row.user_id)
      && ((last.shift_type_id == null && row.shift_type_id == null) || Number(last.shift_type_id) === Number(row.shift_type_id));
    // field_values tragen dieselbe "muss uebereinstimmen, um zu verschmelzen"-
    // Regel wie note schon immer - zwei Tage mit unterschiedlichen Werten sind
    // keine eine Reihe, auch wenn Schichttyp und Notiz zufaellig gleich sind.
    const consecutive = sameSeries && (last.note ?? '') === (row.note ?? '') && sameFieldValues(last.field_values, row.field_values) && addLocalDays(last.to, 1) === row.date_key;
    if (consecutive) {
      last.to = row.date_key;
      last.ids.push(row.id);
    } else {
      groups.push({ user_id: row.user_id, shift_type_id: row.shift_type_id, note: row.note, field_values: row.field_values ?? {}, from: row.date_key, to: row.date_key, ids: [row.id] });
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
    action: readOnly() ? null : { label: t('schedule.createOverride'), icon: 'plus', attrs: { 'data-action': 'open-create-override' } },
  });
}

function overrideRows() {
  const groups = overrideGroups();
  if (!groups.length) return emptyOverrideState();
  return '<div class="list-rows">' + groups.map((group) => {
    const type = state.types.find((item) => Number(item.id) === Number(group.shift_type_id));
    const swatchColor = type ? type.color : 'var(--color-border)';
    const typeLabel = type ? (type.short_code ? `${type.short_code} · ${type.name}` : type.name) : t('schedule.freeDay');
    const meta = [userName(group.user_id), typeLabel, group.note].filter(Boolean).join(' · ');
    const label = group.from === group.to ? formatDate(group.from) : `${formatDate(group.from)} – ${formatDate(group.to)}`;
    const actions = canWrite(group.user_id)
      ? '<span class="schedule-override-actions"><button type="button" class="btn btn--secondary" data-action="edit-override" data-from="' + esc(group.from) + '" data-user-id="' + group.user_id + '">' + esc(t('common.edit')) + '</button><button type="button" class="btn btn--danger-outline" data-action="delete-override-range" data-from="' + esc(group.from) + '" data-to="' + esc(group.to) + '" data-user-id="' + group.user_id + '">' + esc(t('schedule.delete')) + '</button></span>'
      : '';
    const icon = type?.icon ? '<i data-lucide="' + esc(type.icon) + '" class="schedule-type-icon" aria-hidden="true"></i>' : '';
    return '<div class="list-row schedule-override"><span class="schedule-swatch" style="--schedule-color:' + esc(swatchColor) + '"></span>' + icon + '<div class="list-row__main"><span class="list-row__name">' + esc(label) + '</span><span class="list-row__meta">' + esc(meta) + '</span></div>' + actions + '</div>';
  }).join('') + '</div>';
}

// Additiv zu Muster/Override, nie ein Ersatz - dieselbe Kennzeichnung ueberall,
// wo ein Eintrag mit source==='extra' auftauchen kann (Heute-Liste hier,
// Uebersichts-Kachel in dashboard.js, Kalender-Ueberlagerung in calendar.js),
// damit Bereitschaft neben einer regulaeren Schicht auf den ersten Blick als
// ZUSAETZLICH erkennbar bleibt, nicht wie ein zweiter Haupttermin.
function extraBadge() {
  return '<i data-lucide="layers" class="schedule-extra-badge" aria-label="' + esc(t('schedule.extraBadgeLabel')) + '"></i>';
}

function emptyExtraShiftsState() {
  return emptyStateHTML({
    icon: 'calendar-clock',
    title: t('schedule.emptyExtraShiftsTitle'),
    description: t('schedule.emptyExtraShiftsDescription'),
    action: readOnly() ? null : { label: t('schedule.addExtraShift'), icon: 'plus', attrs: { 'data-action': 'open-create-extra' } },
  });
}

/**
 * Dieselbe Zusammenfassung wie overrideGroups(), plus eine Achse, die
 * Overrides nicht kennen: reminder_offset_minutes. "Aufeinanderfolgend"
 * verlangt weiterhin den naechsten Kalendertag - zwei Zusatzschichten am
 * SELBEN Tag (erlaubt, Extras duerfen sich stapeln) verschmelzen deshalb nie,
 * das bleiben zwei Gruppen mit identischem Datum statt einer falsch
 * zusammengefassten.
 */
// Parameter mit state-Default wie overrideGroups(): so laesst sich das
// Verschmelzen behavioral testen, ohne state von aussen zu beschreiben.
function extraGroups(extras = state.extras) {
  const sorted = [...extras].sort((a, b) =>
    Number(a.user_id) - Number(b.user_id) || a.date_key.localeCompare(b.date_key));
  const groups = [];
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    const sameSeries = last
      && Number(last.user_id) === Number(row.user_id)
      && Number(last.shift_type_id) === Number(row.shift_type_id)
      && (last.note ?? '') === (row.note ?? '')
      && (last.reminder_offset_minutes ?? null) === (row.reminder_offset_minutes ?? null)
      && sameFieldValues(last.field_values, row.field_values);
    const consecutive = sameSeries && addLocalDays(last.to, 1) === row.date_key;
    if (consecutive) {
      last.to = row.date_key;
      last.ids.push(row.id);
    } else {
      groups.push({ user_id: row.user_id, shift_type_id: row.shift_type_id, note: row.note, reminder_offset_minutes: row.reminder_offset_minutes, field_values: row.field_values ?? {}, from: row.date_key, to: row.date_key, ids: [row.id] });
    }
  }
  return groups;
}

function extraRows() {
  const groups = extraGroups();
  if (!groups.length) return emptyExtraShiftsState();
  return '<div class="list-rows">' + groups.map((group) => {
    const type = state.types.find((item) => Number(item.id) === Number(group.shift_type_id));
    const swatchColor = type ? type.color : 'var(--color-border)';
    const typeLabel = type ? (type.short_code ? `${type.short_code} · ${type.name}` : type.name) : '';
    const meta = [userName(group.user_id), typeLabel, group.note].filter(Boolean).join(' · ');
    const label = group.from === group.to ? formatDate(group.from) : `${formatDate(group.from)} – ${formatDate(group.to)}`;
    const icon = type?.icon ? '<i data-lucide="' + esc(type.icon) + '" class="schedule-type-icon" aria-hidden="true"></i>' : '';
    const ids = esc(group.ids.join(','));
    const actions = canWrite(group.user_id)
      ? '<span class="schedule-override-actions"><button type="button" class="btn btn--secondary" data-action="edit-extra-range" data-ids="' + ids + '">' + esc(t('common.edit')) + '</button><button type="button" class="btn btn--danger-outline" data-action="delete-extra-range" data-ids="' + ids + '" data-user-id="' + group.user_id + '" data-from="' + esc(group.from) + '" data-to="' + esc(group.to) + '">' + esc(t('schedule.delete')) + '</button></span>'
      : '';
    return '<div class="list-row schedule-override"><span class="schedule-swatch" style="--schedule-color:' + esc(swatchColor) + '"></span>' + icon + extraBadge() + '<div class="list-row__main"><span class="list-row__name">' + esc(label) + '</span><span class="list-row__meta">' + esc(meta) + '</span></div>' + actions + '</div>';
  }).join('') + '</div>';
}

function renderStatistics() {
  const bounds = statistics.bounds || statisticBounds();
  const summary = statisticsSummary();
  const weeklyHours = state.weeklyHours ?? DEFAULT_WEEKLY_HOURS;
  // S-24: aus heisst wirklich aus - keine Karte, kein Rechnen, nicht nur ein
  // verstecktes Ergebnis. `overtime?.over` unten bleibt dieselbe Pruefung wie
  // zuvor, `null` faellt einfach durch wie ein "kein Ueberschuss"-Ergebnis es
  // auch schon tat.
  const overtime = state.overtimeEnabled ? overtimeInfo(statistics.entries, weeklyHours) : null;
  const selectedUser = statistics.userId || currentUserId;
  const range = statistics.range;
  const countItems = [...summary.values];
  if (summary.freeDays) countItems.push({ type: { name: t('schedule.freeDays'), short_code: '', color: 'var(--color-text-secondary)' }, count: summary.freeDays, minutes: 0, hasHours: false });
  const hourItems = summary.values.filter((item) => item.hasHours);
  const controls = range === 'months'
    ? formField(t('schedule.monthFrom'), '<input class="input" required type="month" name="month_from" value="' + esc(statistics.monthFrom || monthKey()) + '">')
      + formField(t('schedule.monthTo'), '<input class="input" required type="month" name="month_to" value="' + esc(statistics.monthTo || monthKey()) + '">')
    : range === 'custom'
      // S-06: "Valid from/until" ist Muster-Vokabular (patternFields() oben) -
      // ein Berichtszeitraum ist kein Gueltigkeitsfenster. rangeFrom/rangeTo
      // sind dieselben Schluessel, die Override-/Extra-Bereiche schon tragen.
      ? formField(t('schedule.rangeFrom'), '<yuvomi-datepicker required name="from" type="date" label="' + esc(t('schedule.rangeFrom')) + '" value="' + esc(statistics.from || bounds?.from || todayKey()) + '"></yuvomi-datepicker>')
        + formField(t('schedule.rangeTo'), '<yuvomi-datepicker required name="to" type="date" label="' + esc(t('schedule.rangeTo')) + '" value="' + esc(statistics.to || bounds?.to || todayKey()) + '"></yuvomi-datepicker>')
      : '';
  // Ohne `bounds` gibt es keine Auswertung, sondern einen ungueltigen Zeitraum:
  // `statisticBounds()` antwortet mit null, `refreshStatistics()` wirft, und der
  // catch-Zweig rendert genau hierher zurueck. Vorher stand da `bounds.from` -
  // ein TypeError, noch bevor der Fehler-Toast lief. Die Seite blieb auf dem
  // vorigen Ergebnis stehen und sagte nichts.
  // Ein fehlgeschlagener Ladevorgang darf NIE als "0 Schichten - 0 h" landen -
  // das ist von einem echten leeren Monat nicht zu unterscheiden und ohne den
  // (laengst verschwundenen) Fehler-Toast bliebe der Nutzer bei einer stillen
  // Falschaussage. Eigener Zweig, denselben Fehlerzustand wie andere Module
  // (mountLoadError/emptyStateHTML variant:'error') statt erfundener Zahlen.
  const results = statistics.loading
    ? '<div class="card card--padded schedule-stat-loading" role="status" aria-live="polite">' + esc(t('common.loading')) + '</div>'
    : statistics.error
      ? emptyStateHTML({ variant: 'error', title: t('common.errorGeneric'), description: t('common.loadErrorDescription'), action: { label: t('common.retry'), icon: 'refresh-cw', attrs: { 'data-action': 'retry-statistics' } } })
      : !bounds
      ? '<p class="card card--padded schedule-stat-empty" role="status">' + esc(t('schedule.invalidRange')) + '</p>'
      : '<p class="schedule-stat-period u-meta">' + esc(t('schedule.statisticsFor', { user: userName(selectedUser), from: formatDate(bounds.from), to: formatDate(bounds.to) })) + '</p>'
      + '<div class="metric-grid schedule-stat-metrics' + (overtime?.over ? ' schedule-stat-metrics--with-overtime' : '') + '">'
      + '<article class="metric-card"><div class="metric-card__label">' + esc(t('schedule.shiftCounts')) + '</div><div class="metric-card__value">' + esc(String(summary.totalCount)) + '</div><div class="metric-card__note">' + esc(t('schedule.shifts')) + '</div></article>'
      + '<article class="metric-card"><div class="metric-card__label">' + esc(t('schedule.workedHours')) + '</div><div class="metric-card__value">' + esc(formatHours(summary.totalMinutes)) + '</div><div class="metric-card__note">' + esc(t('schedule.total')) + '</div></article>'
      + (overtime?.over ? '<article class="metric-card metric-card--warning"><div class="metric-card__label">' + esc(t('schedule.overtime')) + '</div><div class="metric-card__value">+' + esc(formatHours(overtime.excessMinutes)) + '</div><div class="metric-card__note">' + esc(t('schedule.overtimeNote', { hours: weeklyHours })) + '</div></article>' : '')
      + '</div>'
      + '<div class="schedule-stat-sections">'
      + '<section class="card card--padded schedule-stat-card"><div><h2 class="u-section-title">' + esc(t('schedule.shiftCounts')) + '</h2><p class="u-meta">' + esc(t('schedule.shiftCountsDescription')) + '</p></div>' + statisticsRows(countItems, (item) => String(item.count), (item) => item.count, t('schedule.noStatistics')) + '<div class="schedule-stat-total"><span>' + esc(t('schedule.total')) + '</span><strong>' + esc(String(summary.totalCount)) + '</strong></div></section>'
      + '<section class="card card--padded schedule-stat-card"><div><h2 class="u-section-title">' + esc(t('schedule.workedHours')) + '</h2><p class="u-meta">' + esc(t('schedule.workedHoursDescription')) + '</p></div>' + statisticsRows(hourItems, (item) => formatHours(item.minutes), (item) => item.minutes, t('schedule.noStatistics')) + '<div class="schedule-stat-total"><span>' + esc(t('schedule.total')) + '</span><strong>' + esc(formatHours(summary.totalMinutes)) + '</strong></div></section>'
      + '</div>';
  return '<section class="schedule-statistics">'
    + renderReminderSettings()
    + '<form class="card card--padded schedule-stat-filters" data-form="statistics">'
    // S-13 (UX-Audit, Entscheidung D-B): userOptions() statt der vollen
    // state.users-Liste - ein Nicht-Admin sieht hier nur sich selbst, ein
    // Admin weiterhin alle. Das ist eine reine Client-Einschraenkung der
    // AGGREGAT-Ansicht: GET /schedule/entries selbst bleibt fuer jeden mit
    // Schichtplan-Lesezugriff fuer JEDEN user_id abrufbar (Today-Karte/
    // Uebersicht/Kalender/Dashboard-Kachel brauchen genau das, absichtlich
    // haushaltweit) - diese Auswahl versteckt nur die bequeme Auswertungs-
    // Zusammenfassung fuer fremde Konten, sie sperrt keine Rohdaten.
    + formField(t('schedule.owner'), '<select class="input" required name="user_id">' + userOptions(canManageOthers ? selectedUser : currentUserId) + '</select>')
    + '<div class="form-field schedule-stat-range"><span class="label">' + esc(t('schedule.statisticsRange')) + '</span><div class="segmented schedule-stat-range__choices" role="group" aria-label="' + esc(t('schedule.statisticsRange')) + '">'
    + [['current', 'schedule.currentMonth'], ['months', 'schedule.selectedMonths'], ['custom', 'schedule.customRange']].map(([value, label]) => '<button type="button" class="segmented__item' + (range === value ? ' is-active' : '') + '" data-action="statistics-range" data-range="' + value + '" aria-pressed="' + (range === value ? 'true' : 'false') + '">' + esc(t(label)) + '</button>').join('')
    + '</div></div>' + (controls ? '<div class="schedule-stat-dates">' + controls + '</div>' : '')
    + '<div class="schedule-stat-filter-actions"><button class="btn btn--primary">' + esc(t('schedule.applyStatistics')) + '</button>'
    + '<button type="button" class="btn btn--secondary" data-action="print-statistics"><i data-lucide="printer" aria-hidden="true"></i>' + esc(t('schedule.print')) + '</button></div></form>'
    + results + '</section>';
}
// S-07: ohne einen einzigen Schichttyp fuehrt "Schichtplan hinzufuegen" in
// dasselbe Anlege-Formular, dessen Muster-Modus dann nichts zum Waehlen hat
// (typeOptions() liefert nur "Freier Tag") - derselbe Hinweistext wie im
// Anlege-Formular (schedule.noShiftTypesHint, S-02/S-07), hier an die
// Beschreibung angehaengt statt eines zweiten, aehnlich klingenden Schluessels.
function emptyPatternState() {
  const description = state.types.length
    ? t('schedule.emptyPatternsDescription')
    : `${t('schedule.emptyPatternsDescription')} ${t('schedule.noShiftTypesHint')}`;
  return emptyStateHTML({
    icon: 'calendar-clock',
    title: t('schedule.emptyPatternsTitle'),
    description,
    action: readOnly() ? null : { label: t('schedule.addPattern'), icon: 'plus', attrs: { 'data-action': 'open-create', 'data-view': 'patterns' } },
  });
}

// Eine leere Typenliste zwingt sonst dazu, jeden Preset einzeln ueber das
// Anlegen-Formular durchzuklicken, obwohl der Waehler dort (shiftPresetOptions)
// sie schon alle kennt - der Reibungspunkt war die Wiederholung, nicht das
// Fehlen der Presets selbst. Drei Vorlagen statt einer, weil dieselbe
// Bequemlichkeit fuer Schule/Uni genauso gilt wie fuer Arbeit. „Manuell
// anlegen" bleibt letzte Wahl (Grammatik-Praezedenz), fuer wer lieber sofort
// einen eigenen Typ benennt.
function emptyShiftTypesState() {
  return emptyStateHTML({
    icon: 'calendar-clock',
    title: t('schedule.emptyShiftTypesTitle'),
    description: t('schedule.emptyShiftTypesDescription'),
    actions: readOnly() ? [] : [
      ...visibleQuickstartTemplates().map(([key, labelKey]) => ({ label: t(labelKey), icon: 'sparkles', attrs: { 'data-action': 'quick-start-shifts', 'data-template': key } })),
      { label: t('schedule.createShiftType'), icon: 'plus', attrs: { 'data-action': 'open-create', 'data-view': 'shifts' } },
    ],
  });
}

// Note plus jedes ueberlagerungssichtbare Feld mit einem Wert, gemeinsam eine
// Zeile - dieselbe Form nutzen renderToday() hier UND calendar.js'
// scheduleEntryTitle()-Tooltip, damit "was ergaenzt den Namen" an genau einer
// Stelle definiert ist statt zweimal (leicht) verschieden nachgebaut zu werden.
// Bewusst NUR die Felder, deren show_in_overlay gesetzt ist - ein Feld ohne
// diesen Haken ist im Editor pflegbar, aber hier absichtlich unsichtbar.
function overlayMeta(entry) {
  const overlayFields = (entry.shift_type?.fields ?? []).filter((field) => field.show_in_overlay && entry.field_values?.[field.id]);
  return [entry.note, ...overlayFields.map((field) => `${field.name}: ${entry.field_values[field.id]}`)].filter(Boolean).join(' · ');
}

// S-17: Eintraege selbst tragen keine einzelne durchgehende Id - welche Spalte
// zaehlt (pattern_day_id/override_id/extra_id), haengt von `source` ab (siehe
// server/services/schedule.js#scheduleData). Diese zusammengesetzte Kennung
// aus Datum+Person+Herkunft+Herkunfts-Id reicht, um einen Klick auf eine
// gerenderte Zeile/einen Block (Heute-Karte, Uebersicht-Bloecke) wieder auf
// genau dieses Objekt zurueckzufuehren, ohne den Eintrag selbst als
// Data-Attribut zu serialisieren.
function scheduleEntryMatchKey(entry) {
  const sourceId = entry.source === 'pattern' ? (entry.pattern_day_id ?? `p${entry.pattern_id}`)
    : entry.source === 'override' ? entry.override_id : entry.extra_id;
  return [entry.date_key, entry.user_id, entry.source, sourceId].join(':');
}

// Sucht in BEIDEN moeglichen Quellen (Heute-Karte und Uebersicht-Tab laden
// unabhaengig voneinander) - der Schluessel ist global eindeutig (Datum +
// Person + Herkunft + Herkunfts-Id), welche Liste ihn traegt, ist fuer die
// Suche selbst gleichgueltig.
function findScheduleEntry(key) {
  return [...state.entries, ...overview.entries].find((entry) => scheduleEntryMatchKey(entry) === key);
}

function scheduleEntryOriginLabel(entry) {
  if (entry.source === 'pattern') {
    const pattern = state.patterns.find((item) => Number(item.id) === Number(entry.pattern_id));
    return pattern ? `${t('schedule.pattern')} · ${pattern.name}` : t('schedule.pattern');
  }
  if (entry.source === 'override') return t('schedule.override');
  return t('schedule.extraBadgeLabel');
}

/**
 * S-17: read-only Detailinhalt fuer EIN aufgeloestes Vorkommen - kein neues
 * Popover-System (DESIGN.md untersagt eine weitere Kontextmenue-/Popover-
 * Implementierung), dasselbe kleine Modal wie ueberall sonst im Modul.
 * Feldwerte OHNE die show_in_overlay-Einschraenkung von overlayMeta(): die
 * Detailansicht ist ein bewusster Klick, keine beilaeufige Kachel, jedes
 * gepflegte Feld darf hier stehen.
 */
function renderScheduleEntryDetailContent(entry) {
  const type = entry.shift_type;
  const swatchColor = type ? type.color : 'var(--color-border)';
  const icon = type?.icon ? '<i data-lucide="' + esc(type.icon) + '" class="schedule-type-icon" aria-hidden="true"></i>' : '';
  const label = type ? esc(type.short_code ? `${type.short_code} · ${type.name}` : type.name) : esc(t('schedule.freeDay'));
  const time = type ? esc(clockLabel(type)) : '';
  const fieldRows = (type?.fields ?? [])
    .filter((field) => entry.field_values?.[field.id])
    .map((field) => '<div class="schedule-entry-detail__row"><dt>' + esc(field.name) + '</dt><dd>' + esc(entry.field_values[field.id]) + '</dd></div>')
    .join('');
  return '<div class="schedule-entry-detail">'
    + '<div class="schedule-entry-detail__head"><span class="schedule-swatch" style="--schedule-color:' + esc(swatchColor) + '"></span>' + icon + '<span class="u-card-title u-compact">' + label + '</span>' + (time ? '<small>' + time + '</small>' : '') + '</div>'
    + '<dl class="schedule-entry-detail__rows">'
    + '<div class="schedule-entry-detail__row"><dt>' + esc(t('schedule.owner')) + '</dt><dd>' + esc(userName(entry.user_id)) + '</dd></div>'
    + (entry.note ? '<div class="schedule-entry-detail__row"><dt>' + esc(t('schedule.note')) + '</dt><dd>' + esc(entry.note) + '</dd></div>' : '')
    + fieldRows
    + '<div class="schedule-entry-detail__row"><dt>' + esc(t('schedule.origin')) + '</dt><dd>' + esc(scheduleEntryOriginLabel(entry)) + '</dd></div>'
    + '</dl></div>';
}

function openScheduleEntryDetailModal(entry) {
  // dirtyGuard:false - reine Leseansicht ohne Formularfelder, es gibt nichts
  // zu verwerfen.
  openModal({ title: t('schedule.entryDetailTitle'), size: 'sm', content: renderScheduleEntryDetailContent(entry), dirtyGuard: false });
}

function renderToday() {
  if (!state.entries.length) return `<p>${esc(t('schedule.empty'))}</p>`;
  return `<div class="list-rows">${state.entries.map((entry) => {
    const type = entry.shift_type;
    const swatchColor = type ? type.color : 'var(--color-border)';
    const name = type ? esc(type.short_code ? `${type.short_code} · ${type.name}` : type.name) : esc(t('schedule.freeDay'));
    const base = type ? `${esc(userName(entry.user_id))} · ${esc(clockLabel(type))}` : esc(userName(entry.user_id));
    const overlay = overlayMeta(entry);
    const meta = overlay ? `${base} · ${esc(overlay)}` : base;
    const icon = type?.icon ? `<i data-lucide="${esc(type.icon)}" class="schedule-type-icon" aria-hidden="true"></i>` : '';
    const badge = entry.source === 'extra' ? extraBadge() : '';
    // S-17: Zeile ist read-only, aber klickbar/tastaturbedienbar (role=button,
    // dieselbe Enter/Space-Aktivierung wie calendar.js' Agenda-Zeilen) - jede
    // Rolle im Haushalt darf sich einen Eintrag ansehen, deshalb steht die
    // Aktion in READ_SAFE_ACTIONS.
    const key = esc(scheduleEntryMatchKey(entry));
    return `<div class="list-row schedule-entry-row" role="button" tabindex="0" data-action="view-schedule-entry" data-schedule-key="${key}" aria-label="${name}, ${meta}"><span class="schedule-swatch" style="--schedule-color:${esc(swatchColor)}"></span>${icon}${badge}<div class="list-row__main"><span class="list-row__name">${name}</span><span class="list-row__meta">${meta}</span></div></div>`;
  }).join('')}</div>`;
}

// Uebersicht-Tab: mehrere Personen nebeneinander vergleichen.
//
// Feste Spur je Person, nie nach Aktivitaet umsortiert. Die Reihenfolge kommt
// unveraendert aus `getSelectedUserIds()` (DOM-Reihenfolge des Multi-Select-
// Widgets, alphabetisch nach display_name) - NICHT aus der Klickreihenfolge,
// wie ein frueherer Stand dieses Kommentars behauptete (Review-Fund
// 2026-09-05, #1022). Das ist das richtige Verhalten, nur die Beschreibung
// war falsch: alphabetisch bleibt stabil ueber jede Auswahlaenderung hinweg,
// eine Klickreihenfolge wuerde sich bei jedem Abwaehlen/Neuwaehlen verschieben.
// Der ganze Sinn der Ansicht ist, dass "Kind 2s Spalte" jeden Tag an
// derselben Stelle steht, damit das Auge sie ueber eine Woche verfolgen kann;
// eine Person mit vielen Eintraegen darf ihr nicht mehr Platz oder eine
// andere Position erkaufen (anders als layoutOverlaps() in calendar.js, das
// bewusst dynamisch ist - dort geht es um sich ueberschneidende Termine EINER
// Spalte, nicht um Personen-Identitaet). Jede Spur wird gerendert, auch mit
// leerem entries-Array - eine ausgelassene Spur wuerde jede spaetere Spur an
// diesem Tag verschieben und genau das Scan-Muster zerstoeren, fuer das die
// Ansicht existiert.
function isOvernightEntry(entry) {
  const type = entry.shift_type;
  return !!(type?.start_time && type?.end_time && type.end_time <= type.start_time);
}

/**
 * Zaehlt ein Eintrag fuer computeActiveHours() der sichtbaren Tage, obwohl
 * sein eigener date_key evtl. nicht sichtbar ist? Ja, wenn er selbst
 * sichtbar ist ODER er eine Nachtschicht ist, deren Fortsetzung (siehe
 * buildOverviewLanes()) auf einen sichtbaren Tag faellt - sonst hat
 * ausgerechnet die Tagesansicht direkt nach einer Nachtschicht keinen
 * einzigen bezeiteten Eintrag zum Rechnen und faellt auf die Standardstunden
 * zurueck, obwohl die Fortsetzung selbst sehr wohl gerendert wird
 * (Review-Fund 2026-09-05, #1022).
 */
function touchesVisibleDay(entry, visibleDateKeys) {
  return visibleDateKeys.has(entry.date_key)
    || (isOvernightEntry(entry) && visibleDateKeys.has(addLocalDays(entry.date_key, 1)));
}

function buildOverviewLanes(days, selectedUserIds, entries) {
  const byDayAndUser = new Map();
  for (const entry of entries) {
    const key = `${entry.date_key}:${entry.user_id}`;
    if (!byDayAndUser.has(key)) byDayAndUser.set(key, []);
    byDayAndUser.get(key).push(entry);
  }
  // Eine Nachtschicht (Ende <= Beginn, ueber Mitternacht) bekommt eine ZWEITE
  // Zeile auf dem FOLGETag - 00:00 bis zum echten Ende - sonst verschwindet
  // ihre zweite Haelfte komplett, sobald der Starttag vorbei ist (nur die
  // ersten paar Stunden bis Mitternacht waren je sichtbar). Aus den
  // ORIGINALEN Eintraegen erzeugt, nie aus bereits eingefuegten
  // Fortsetzungen - sonst kaeme jeden Tag eine weitere hinzu.
  for (const entry of entries) {
    if (!isOvernightEntry(entry)) continue;
    const nextKey = `${addLocalDays(entry.date_key, 1)}:${entry.user_id}`;
    // Ein "frei"-Eintrag (kein Schichttyp) fuer den Folgetag ist irrefuehrend,
    // sobald eine Fortsetzung von gestern noch bis in den Morgen reicht - die
    // Person ist erst ab Schichtende wirklich frei, nicht den ganzen Tag, und
    // der unbezeitete "Frei"-Block wuerde sonst optisch mit der Fortsetzung
    // an derselben Stelle (oben in der Spur) kollidieren.
    const withoutFreeMarker = (byDayAndUser.get(nextKey) ?? []).filter((item) => item.shift_type);
    byDayAndUser.set(nextKey, [...withoutFreeMarker, { ...entry, __continuation: true }]);
  }
  // Chronologisch innerhalb der Spur - eine Fortsetzung zaehlt als 00:00 (sie
  // IST der Tagesanfang), dann untimed (frei), dann nach Beginn. Wichtig,
  // weil GET /entries keine Sortiergarantie ueber mehrere Bloecke desselben
  // Tages gibt (Migration 188, mehrere Bloecke je Zyklustag).
  const startMinutes = (entry) => {
    if (entry.__continuation) return -1;
    const start = entry.shift_type?.start_time;
    if (!start) return -1;
    const [h, m] = start.split(':').map(Number);
    return h * 60 + m;
  };
  for (const list of byDayAndUser.values()) list.sort((a, b) => startMinutes(a) - startMinutes(b));
  return days.map((dateKey) => ({
    dateKey,
    lanes: selectedUserIds.map((userId, laneIndex) => ({
      userId,
      laneIndex,
      entries: byDayAndUser.get(`${dateKey}:${userId}`) ?? [],
    })),
  }));
}

function overviewVisibleDays() {
  if (overview.viewMode === 'day') return [overview.weekCursor];
  const weekStart = weekStartIndex(state.weekStartPref);
  const from = startOfLocalWeekKey(overview.weekCursor, weekStart);
  return Array.from({ length: 7 }, (_, i) => addLocalDays(from, i));
}

/** Haushaltsweite Ferien-/Feiertagsbanner ueber dem Wochenraster - kein user_id, also keine eigene Spur. */
function overviewHolidaysOnDay(dateKey) {
  return overview.holidays.filter((holiday) => holiday.start_date <= dateKey && holiday.end_date >= dateKey);
}

function overviewLaneHeader(userId) {
  const person = overview.people.find((p) => Number(p.id) === Number(userId));
  const name = person?.display_name ?? userName(userId);
  const initials = (name ?? '').split(' ').map((w) => w[0] ?? '').join('').toUpperCase().slice(0, 2);
  const inner = person?.avatar_data ? `<img src="${esc(person.avatar_data)}" alt="${esc(name)}" loading="lazy">` : esc(initials);
  return `<div class="schedule-overview__lane-head"><span class="schedule-overview__lane-avatar" style="background-color:${esc(person?.avatar_color ?? 'var(--color-border)')}">${inner}</span><span class="schedule-overview__lane-name">${esc(name)}</span></div>`;
}

const OVERVIEW_HOUR_PX = 56;
const OVERVIEW_DEFAULT_HOURS = Array.from({ length: 14 }, (_, i) => i + 6); // 06:00-19:59 Rueckfall ohne bezeitete Eintraege

function overviewPad(n) { return String(n).padStart(2, '0'); }

/**
 * Welche Kalenderstunden (0-23) traegt IRGENDEIN bezeiteter Eintrag der
 * sichtbaren Auswahl - ueber die ganze Woche, nicht je Tag, damit alle Tage
 * dieselbe (verdichtete) Skala teilen und vergleichbar bleiben. Stunden ohne
 * jede Belegung (z. B. 00-08 Uhr an einer Schulwoche ohne Nachtschicht)
 * fallen komplett weg, statt als leerer Platz zu zaehlen - genau das macht
 * eine 45-Minuten-Stunde neben einer 8-Stunden-Schicht wieder lesbar UND
 * masstabsgetreu (Live-Test-Feedback, 2026-09-04).
 *
 * Eine Nachtschicht traegt BEIDE Haelften bei - die Stunden bis Mitternacht
 * UND die Stunden ab 00:00 - nicht nur die erste (Fix 2026-09-04): sonst
 * haette buildOverviewLanes()' Fortsetzungszeile auf dem Folgetag keine
 * einzige aktive Stunde, in die sie sich einordnen koennte.
 */
function computeActiveHours(entries) {
  const active = new Set();
  for (const entry of entries) {
    const type = entry.shift_type;
    if (!type?.start_time || !type?.end_time) continue;
    const [startH] = type.start_time.split(':').map(Number);
    const [endH, endM] = type.end_time.split(':').map(Number);
    if (type.end_time <= type.start_time) {
      for (let h = startH; h < 24; h++) active.add(h);
      const endExclusive = endH + (endM > 0 ? 1 : 0);
      for (let h = 0; h < endExclusive; h++) active.add(h);
    } else {
      const endExclusive = endH + (endM > 0 ? 1 : 0);
      for (let h = startH; h < endExclusive; h++) active.add(h);
    }
  }
  if (!active.size) return OVERVIEW_DEFAULT_HOURS;
  return [...active].sort((a, b) => a - b);
}

/**
 * Minutenwert auf der VERDICHTETEN Skala (nur die Stunden aus activeHours,
 * der Reihe nach, je 60 "verdichtete Minuten"). Ein Eintrag beruehrt nur
 * Stunden, die er selbst beitraegt - computeActiveHours() garantiert also,
 * dass jede von ihm beruehrte Stunde in activeHours steht. Die einzige
 * Ausnahme ist ein Endzeitpunkt genau auf einer Stundengrenze (z. B. endet um
 * 09:00): die gehoert ans Ende der VORIGEN Stunde, nicht an den Anfang einer
 * Stunde, die dieser Eintrag gar nicht mehr beruehrt.
 */
function collapsedMinutes(minutesOfDay, activeHours) {
  let hour = Math.floor(minutesOfDay / 60);
  let minuteInHour = minutesOfDay % 60;
  if (hour >= 24) { hour = 23; minuteInHour = 60; }
  let idx = activeHours.indexOf(hour);
  if (idx === -1 && minuteInHour === 0) {
    idx = activeHours.indexOf(hour - 1);
    if (idx !== -1) minuteInHour = 60;
  }
  if (idx === -1) return null;
  return idx * 60 + minuteInHour;
}

// KEINE ZEITPROPORTIONALE PLATZIERUNG AUF EINER DURCHGEHENDEN 24H-SKALA
// (Kurskorrektur nach Live-Test, 2026-09-04) - eine 45-Minuten-Schulstunde
// neben einer 8-Stunden-Schicht auf DERSELBEN durchgehenden Skala schrumpfte
// auf ein paar Pixel, genau dort, wo Fach/Raum stehen sollten. Die Skala
// traegt jetzt nur noch Stunden, die irgendjemand aus der Auswahl belegt
// (computeActiveHours) - lesbar UND weiterhin masstabsgetreu, nur ohne die
// leeren Stunden dazwischen.
function overviewEntryBlock(entry, activeHours) {
  const type = entry.shift_type;
  const overlay = overlayMeta(entry);
  const label = type ? (type.short_code ? `${type.short_code} · ${type.name}` : type.name) : t('schedule.freeDay');
  // S-17: read-only Detailansicht bei Klick/Enter/Space - dieselbe Aktion wie
  // renderToday()'s Zeilen, derselbe zusammengesetzte Schluessel
  // (scheduleEntryMatchKey()) findet den Eintrag wieder unabhaengig davon, ob
  // dieser Block eine Fortsetzungszeile (`__continuation`) ist oder nicht.
  const detailAttrs = ` role="button" tabindex="0" data-action="view-schedule-entry" data-schedule-key="${esc(scheduleEntryMatchKey(entry))}" aria-label="${esc(scheduleOverviewEntryTitle(entry))}"`;
  if (!type?.start_time || !type?.end_time) {
    return `<div class="schedule-overview__block schedule-overview__block--allday" title="${esc(scheduleOverviewEntryTitle(entry))}"${detailAttrs}><span>${esc(overlay ? `${label} · ${overlay}` : label)}</span></div>`;
  }
  const [startH, startM] = type.start_time.split(':').map(Number);
  const [endH, endM] = type.end_time.split(':').map(Number);
  // Eine Fortsetzungszeile (siehe buildOverviewLanes()) IST der Tagesanfang -
  // sie beginnt bei 00:00, nicht beim echten (gestrigen) Beginn der Schicht.
  // Die ORIGINALZeile auf dem Starttag bleibt weiter bei Mitternacht gekappt.
  const startMin = entry.__continuation ? 0 : startH * 60 + startM;
  const endMin = entry.__continuation ? endH * 60 + endM : ((endH * 60 + endM) <= startMin ? 24 * 60 : endH * 60 + endM);
  const startCollapsed = collapsedMinutes(startMin, activeHours) ?? 0;
  const endCollapsed = collapsedMinutes(endMin, activeHours) ?? startCollapsed;
  const top = (startCollapsed / 60) * OVERVIEW_HOUR_PX;
  const height = Math.max(((endCollapsed - startCollapsed) / 60) * OVERVIEW_HOUR_PX, 18);
  // S-30 (UX-Audit): eine Fortsetzungszeile sitzt auf dem FOLGETAG bei 00:00 -
  // die volle Spanne ("22:00-06:00 +1") daneben liest sich, als begaenne die
  // Schicht heute erneut um 22 Uhr. Ein eigener, kuerzerer Text nennt nur das
  // Ende und benennt die Fortsetzung, statt die Herkunftszeile zu wiederholen.
  const timeLine = entry.__continuation
    ? t('schedule.continuesUntil', { time: type.end_time })
    : overlay ? `${clockLabel(type)} · ${overlay}` : clockLabel(type);
  return `<div class="schedule-overview__block" style="top:${top}px;height:${height}px;--schedule-color:${esc(type.color)}" title="${esc(scheduleOverviewEntryTitle(entry))}"${detailAttrs}><span class="schedule-overview__block-title">${esc(label)}</span><small class="schedule-overview__block-time">${esc(timeLine)}</small></div>`;
}

function scheduleOverviewEntryTitle(entry) {
  const type = entry.shift_type;
  const base = type ? (type.short_code ? `${type.short_code} · ${type.name}` : type.name) : t('schedule.freeDay');
  const overlay = overlayMeta(entry);
  return overlay ? `${base} · ${overlay}` : base;
}

function renderOverview() {
  const picker = renderUserMultiSelect(overview.people, overview.selectedIds, 'overview-people', 'schedule.overviewPeopleLabel', 'schedule.overviewClearSelection');
  const weekDays = overviewVisibleDays();
  const weekLabel = overview.viewMode === 'day'
    ? formatDayMonth(weekDays[0])
    : `${formatDayMonth(weekDays[0])} – ${formatDayMonth(weekDays[weekDays.length - 1])}`;
  const viewToggle = `<div class="segmented" role="group" aria-label="${esc(t('calendar.viewWeek'))}/${esc(t('calendar.viewDay'))}">
    <button type="button" class="segmented__item${overview.viewMode === 'week' ? ' is-active' : ''}" data-action="overview-view-mode" data-mode="week" aria-pressed="${overview.viewMode === 'week' ? 'true' : 'false'}">${esc(t('calendar.viewWeek'))}</button>
    <button type="button" class="segmented__item${overview.viewMode === 'day' ? ' is-active' : ''}" data-action="overview-view-mode" data-mode="day" aria-pressed="${overview.viewMode === 'day' ? 'true' : 'false'}">${esc(t('calendar.viewDay'))}</button>
  </div>`;
  const header = `<div class="schedule-overview__toolbar">
    ${picker}
    <div class="schedule-overview__week-nav" role="group" aria-label="${esc(weekLabel)}">
      ${viewToggle}
      <button type="button" class="btn btn--icon" data-action="overview-week" data-direction="prev" aria-label="${esc(t('calendar.back'))}"><i data-lucide="chevron-left" aria-hidden="true"></i></button>
      <button type="button" class="btn btn--secondary" data-action="overview-week" data-direction="today">${esc(t('calendar.today'))}</button>
      <button type="button" class="btn btn--icon" data-action="overview-week" data-direction="next" aria-label="${esc(t('calendar.forward'))}"><i data-lucide="chevron-right" aria-hidden="true"></i></button>
      <span class="schedule-overview__week-label">${esc(weekLabel)}</span>
    </div>
  </div>`;

  // Ladezustand und Fehlerzustand VOR dem Auswahl-Leerzustand: `loading` wird
  // in activateView() gesetzt, bevor `overview.entries` je gefuellt sind, und
  // `error` bleibt sonst stumm (nur ein voruebergehender Toast) - ein leerer
  // Zeitraum sah bisher genauso aus wie einer, der nie geladen werden konnte.
  if (overview.loading) {
    return `<section class="schedule-overview">${header}<div class="card card--padded schedule-stat-loading" role="status" aria-live="polite">${esc(t('common.loading'))}</div></section>`;
  }
  if (overview.error) {
    return `<section class="schedule-overview">${header}${emptyStateHTML({ variant: 'error', title: t('common.errorGeneric'), description: t('common.loadErrorDescription'), action: { label: t('common.retry'), icon: 'refresh-cw', attrs: { 'data-action': 'retry-overview' } } })}</section>`;
  }

  if (!overview.selectedIds.length) {
    return `<section class="schedule-overview">${header}${emptyStateHTML({ title: t('schedule.overviewEmptyTitle'), description: t('schedule.overviewEmptyDescription') })}</section>`;
  }

  const lanesByDay = buildOverviewLanes(weekDays, overview.selectedIds, overview.entries);
  const laneCount = overview.selectedIds.length;
  // Nur die AUSGEWAEHLTEN Personen UND nur die sichtbaren Tage duerfen die
  // verdichtete Skala bestimmen - overview.entries traegt immer die ganze
  // Woche (der Fetch spart sich einen Refetch beim Wechsel Tag/Woche/Personen,
  // siehe refreshOverview()), eine abgewaehlte Person oder ein gerade nicht
  // sichtbarer Tag (Tagesansicht) soll aber keine Stunde mehr "aktiv" halten,
  // die hier gar nicht zu sehen ist.
  const visibleDateKeys = new Set(weekDays);
  const selectedEntries = overview.entries.filter((entry) => overview.selectedIds.includes(entry.user_id) && touchesVisibleDay(entry, visibleDateKeys));
  const activeHours = computeActiveHours(selectedEntries);
  const gridHeight = activeHours.length * OVERVIEW_HOUR_PX;
  const hourLines = activeHours.map((_, i) => `<div class="schedule-overview__hour-line" style="top:${i * OVERVIEW_HOUR_PX}px"></div>`).join('');

  // Die Zeitspalte ist strukturell ein Tag ohne Inhalt (leerer Tageskopf,
  // leere Feiertage, EINE leere Spur) statt eines separat vermessenen
  // Platzhalters - so bleibt sie garantiert auf derselben Hoehe wie jede
  // echte Tagesspalte ausgerichtet, ohne Zahlen zu erraten.
  const gutterHours = activeHours.map((h, i) => `<div class="schedule-overview__hour-label" style="top:${i * OVERVIEW_HOUR_PX}px">${overviewPad(h)}:00</div>`).join('');
  const gutter = `<div class="schedule-overview__day schedule-overview__gutter">
    <div class="schedule-overview__day-head">&nbsp;</div>
    <div class="schedule-overview__holidays"></div>
    <div class="schedule-overview__lanes" style="grid-template-columns:1fr">
      <div class="schedule-overview__lane">
        <div class="schedule-overview__lane-head">&nbsp;</div>
        <div class="schedule-overview__lane-body" style="height:${gridHeight}px">${gutterHours}</div>
      </div>
    </div>
  </div>`;

  const days = lanesByDay.map(({ dateKey, lanes }) => {
    const holidays = overviewHolidaysOnDay(dateKey);
    const holidayHtml = holidays.map((h) => `<div class="schedule-overview__holiday" style="--holi-color:${esc(h.color)}" title="${esc(h.name)}"><span>${esc(h.name)}</span></div>`).join('');
    const laneHtml = lanes.map((lane) => `<div class="schedule-overview__lane" data-user="${lane.userId}">
      ${overviewLaneHeader(lane.userId)}
      <div class="schedule-overview__lane-body" style="height:${gridHeight}px">${hourLines}${lane.entries.map((entry) => overviewEntryBlock(entry, activeHours)).join('')}</div>
    </div>`).join('');
    return `<div class="schedule-overview__day" data-date="${dateKey}">
      <div class="schedule-overview__day-head">${esc(t(`calendar.dayShort${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][parseLocalDateKey(dateKey).getDay()]}`))} ${esc(formatDayMonth(dateKey))}</div>
      <div class="schedule-overview__holidays">${holidayHtml}</div>
      <div class="schedule-overview__lanes" style="grid-template-columns:repeat(${laneCount},minmax(220px,1fr))">${laneHtml}</div>
    </div>`;
  }).join('');

  return `<section class="schedule-overview">${header}<div class="schedule-overview__scroll"><div class="schedule-overview__grid">${gutter}${days}</div></div></section>`;
}

function renderScheduleWarnings() {
  if (!state.warnings.length) return '';
  return '<div class="schedule-warnings" role="status">' + state.warnings.map((warning) => '<p>' + esc(t('schedule.overlapWarning', { date: formatDate(warning.date_key), user: userName(warning.user_id) })) + '</p>').join('') + '</div>';
}

// S-03: markiert die umschliessende Musterkarte (`[data-pattern]`, siehe
// patternCard()) als dirty - deckt sowohl den Zyklustage-Editor (die
// `[data-day]`-Selects/Feld-Unterbloecke) als auch das inline
// `pattern-update`-Formular ab, beide leben im selben `<details
// data-pattern>`. Kein Effekt ausserhalb einer Musterkarte (z.B. Override-/
// Extra-Zeilen, "Meine Einstellungen") - deren Aenderungen schreiben ohnehin
// sofort (savePreference()) oder haben ihr eigenes Modal mit eigenem
// Dirty-Guard.
function markPatternDirty(target) {
  const details = target?.closest?.('[data-pattern]');
  if (details?.dataset?.pattern) dirtyPatternIds.add(details.dataset.pattern);
}

// S-03: vor einem Tab-Wechsel gefragt, waehrend mindestens eine Musterkarte
// dirty ist. `wireTablist()` malt den Klick bereits VOR diesem Aufruf visuell
// um (setActive() ruft paint() vor onChange()) - bei "Abbrechen" muss der
// Tab-Balken deshalb aktiv auf den alten activeView zurueckgeholt werden
// (sync() loest dabei bewusst kein weiteres onChange aus), das eigentliche
// `.schedule-body` bleibt unveraendert (kein renderPage() gelaufen), die
// Eingabe steht also unveraendert im DOM.
async function guardedActivateView(id) {
  if (activeView === 'patterns' && dirtyPatternIds.size) {
    const confirmed = await confirmModal(
      t('modal.unsavedChanges'),
      { danger: true, confirmLabel: t('modal.discardChanges'), detail: t('schedule.discardCycleDayEditsDetail') },
    );
    if (!confirmed) {
      scheduleTablist?.sync(activeView);
      return;
    }
    dirtyPatternIds.clear();
  }
  // S-10: navigate() statt eines blossen activateView() - haengt Adresse UND
  // Verlaufseintrag an. Da /schedule/<tab> bereits als eigene Route
  // registriert ist (router.js) und dieses Modul schon gerendert ist, nimmt
  // der Router den Soft-Nav-Pfad (update() unten fuehrt dieselbe
  // activateView() dann aus) statt eines vollen Neu-Renderns.
  window.yuvomi?.navigate(scheduleRouteForView(id));
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
    ['patterns', t('schedule.planning')],
    ['statistics', t('schedule.statistics')],
    ['overview', t('schedule.overview')],
  ];
  root.replaceChildren();
  root.insertAdjacentHTML('beforeend', `<div class="schedule-page app-page app-page--full" data-composition="full">
    <header class="page-toolbar schedule-toolbar">
      <h1 class="page-toolbar__title">${esc(t('schedule.title'))}</h1>
      <div class="page-toolbar__actions"></div>
      <div class="sub-tabs-bar schedule-tabs page-toolbar__bar" role="tablist" aria-label="${esc(t('schedule.title'))}">
        ${tabs.map(([id, label]) => `<button class="sub-tab${id === activeView ? ' sub-tab--active' : ''}" type="button" role="tab" data-tab-id="${id}" aria-selected="${id === activeView ? 'true' : 'false'}" tabindex="${id === activeView ? '0' : '-1'}">${esc(label)}</button>`).join('')}
      </div>
    </header>
    <div class="schedule-body"></div>
  </div>`);
  // Geteilte Tablist-Verhaltensschicht (Klick + Pfeiltasten/Home/End + Roving-
  // Tabindex + ARIA, utils/tablist.js) statt einer Handnachbildung ohne
  // Tastatursteuerung - dieselbe Grammatik wie Budget/Kalender/Rewards/
  // Haushaltshilfe fuer ihre jeweilige Haupt-Tab-Leiste. wireTablist() malt den
  // aktiven Tab selbst (Klasse/aria-selected/tabindex) und bringt die
  // Scroll-Fade-Affordanz gleich mit - eine zusaetzliche wireScrollFade()-Zeile
  // hier waere seither doppelt verdrahtet.
  scheduleTablist = wireTablist(root.querySelector('.schedule-tabs'), {
    activeId: activeView,
    onChange: (id) => { guardedActivateView(id); },
  });
  root.addEventListener('submit', submitForm);
  root.addEventListener('click', (event) => {
    // S-03: eine Musterkarte einklappen ist ebenfalls ein "Re-Render" ihrer
    // Sicht (der Zyklustage-Editor darunter verschwindet) - derselbe Verlust
    // wie ein Tab-Wechsel, nur ueber das native <summary>-Toggle statt
    // renderPage(). Der 'toggle'-Event von <details> selbst ist nicht
    // abbrechbar; der Klick auf <summary>, der ihn ausloest, ist es - hier
    // wird nur das SCHLIESSEN einer dirty Karte abgefangen, das Oeffnen
    // (nichts geht dabei verloren) bleibt unangetastet.
    const summary = event.target.closest('summary');
    const details = summary?.closest('[data-pattern]');
    if (details?.open && dirtyPatternIds.has(details.dataset.pattern)) {
      event.preventDefault();
      confirmModal(
        t('modal.unsavedChanges'),
        { danger: true, confirmLabel: t('modal.discardChanges'), detail: t('schedule.discardCycleDayEditsDetail') },
      ).then((confirmed) => {
        if (!confirmed) return;
        dirtyPatternIds.delete(details.dataset.pattern);
        details.open = false;
      });
      return;
    }
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) action({ currentTarget: actionButton });
  });
  // S-03: jede Eingabe im Zyklustage-Editor/inline Pattern-Formular markiert
  // ihre Musterkarte als dirty - 'input' fuer Texteingaben (Name,
  // Zykluslaenge, Feldwerte, tippt man ohne je zu blur'en), 'change'
  // zusaetzlich fuer <select>/<input type=date> (Zyklustag-Auswahl,
  // Anker-/Gueltigkeitsdatum, Aktiv-Schalter), die manchmal ohne 'input' feuern.
  root.addEventListener('input', (event) => {
    if (activeView === 'patterns') markPatternDirty(event.target);
    if (activeView === 'patterns') updateCycleDayHeadersFor(event.target);
  });
  root.addEventListener('change', async (event) => {
    if (activeView === 'patterns') markPatternDirty(event.target);
    if (activeView === 'patterns') updateCycleDayHeadersFor(event.target);
    if (event.target.id === 'schedule-reminder-toggle') {
      const offsetSelect = root.querySelector('#schedule-reminder-offset');
      // Sofort sperren/entsperren statt auf renderPage() nach dem Speichern zu
      // warten (S-25) - sonst wirkt die Auswahl fuer die Dauer des Roundtrips
      // weiter bedienbar, obwohl der Umschalter schon aus ist.
      if (offsetSelect) offsetSelect.disabled = !event.target.checked;
      const offset = event.target.checked ? Number(offsetSelect?.value ?? 15) : null;
      savePreference({ reminderOffsetMinutes: offset });
    } else if (event.target.id === 'schedule-reminder-offset') {
      // S-23: "Custom..." selbst speichert nichts - erst promptModal() liefert
      // eine echte Minutenzahl (oder das <select> springt zurueck), siehe
      // pickCustomReminderOffset().
      if (event.target.value === 'custom') {
        await pickCustomReminderOffset(event.target, (minutes) => savePreference({ reminderOffsetMinutes: minutes }));
      } else {
        event.target.dataset.previousValue = event.target.value;
        savePreference({ reminderOffsetMinutes: Number(event.target.value) });
      }
    } else if (event.target.id === 'schedule-weekly-hours') {
      const hours = Math.min(168, Math.max(1, Math.round(Number(event.target.value) || DEFAULT_WEEKLY_HOURS)));
      savePreference({ weeklyHours: hours });
    } else if (event.target.id === 'schedule-overtime-toggle') {
      // S-24: sofort sperren/entsperren, gleiches Muster wie der Erinnerungs-
      // Umschalter (S-25) - sonst wirkt das Wochenstunden-Feld waehrend des
      // Roundtrips weiter bedienbar, obwohl der Schalter schon aus ist.
      const hoursInput = root.querySelector('#schedule-weekly-hours');
      if (hoursInput) hoursInput.disabled = !event.target.checked;
      savePreference({ overtimeEnabled: event.target.checked });
    } else if (event.target.closest('[data-ms-input="overview-people"]')) {
      // Auswahl ist rein clientseitig - kein Fetch, nur eine Neuzeichnung
      // (siehe Kommentar an overview weiter oben).
      overview = { ...overview, selectedIds: getSelectedUserIds(root, 'overview-people') };
      saveOverviewSelection(overview.selectedIds);
      renderPage();
    } else if (event.target.matches('[data-day]')) {
      // Der gewaehlte Schichttyp entscheidet, welche Felder die Zeile zeigt -
      // ein Wechsel baut den Unterblock neu aus dem NEUEN Typ, ohne die bereits
      // getippten Werte anderer Zeilen anzufassen. Werte fuer Felder, die am
      // neuen Typ nicht mehr haengen, werden dabei mit verworfen (best-effort,
      // spiegelt dieselbe Validierung, die der Server beim Speichern ohnehin durchsetzt).
      const row = event.target.closest('[data-day-row]');
      const existing = row?.querySelector('[data-day-row-fields]');
      const html = dayRowFieldsHtml(event.target.value);
      if (existing) existing.outerHTML = html;
      else if (html) row.insertAdjacentHTML('beforeend', html);
      window.lucide?.createIcons({ el: row });
    }
  });
  // S-17: Tastaturaktivierung der als role="button" ausgezeichneten
  // Heute-Zeilen/Uebersicht-Bloecke (Enter/Space) - dasselbe Muster wie
  // calendar.js' Agenda-Ansicht fuer ihre eigenen role="button"-Zeilen.
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target.closest('[data-action="view-schedule-entry"]');
    if (!target) return;
    event.preventDefault();
    action({ currentTarget: target });
  });
}

/**
 * S-04: Start-/Zykluslaengen-Feld einer Musterkarte hat sich geaendert - die
 * Kopfzeilen ihrer bereits gerenderten Zyklustage neu beschriften, rein aus
 * den LIVE-Formularwerten (noch ungespeichert), ohne die Zeilen selbst
 * anzufassen. Kein Server-Roundtrip, reine Datumsrechnung (cycleDayHeaderLabel()).
 */
function updateCycleDayHeadersFor(target) {
  const name = target?.name || target?.getAttribute?.('name');
  if (name !== 'anchor_date' && name !== 'cycle_length') return;
  const details = target.closest('[data-pattern]');
  const form = details?.querySelector('[data-form="pattern-update"]');
  if (!form) return;
  const anchor = formValue(form, 'anchor_date');
  const cycleLength = Number(formValue(form, 'cycle_length'));
  const validFrom = formValue(form, 'valid_from') || null;
  const validUntil = formValue(form, 'valid_until') || null;
  if (!anchor || !cycleLength) return;
  details.querySelectorAll('[data-day-group]').forEach((group) => {
    const position = Number(group.dataset.dayGroup) + 1;
    const label = group.querySelector('[data-day-group-label]');
    if (label) label.textContent = cycleDayHeaderLabel(anchor, cycleLength, validFrom, validUntil, position);
  });
}

function renderPage() {
  // Rebuilding .schedule-body below can destroy whatever currently holds
  // focus (e.g. the weekly-hours input right after the user typed into it) -
  // losing focus resets it to <body>, and the browser scrolls the page's
  // real scrollport (#main-content, see router.js) back to the top to show
  // it. Statistics is the one tab with persistent on-page form controls that
  // trigger a render while focused, so it's the one tab where this was
  // visible; restoring the scroll position afterward papers over it for
  // every tab uniformly rather than special-casing statistics.
  const scrollPort = document.getElementById('main-content');
  const scrollTop = scrollPort?.scrollTop ?? 0;
  // Repaint statt Neubau: wireTablist() haelt Klasse/aria-selected/tabindex der
  // schon bestehenden Knoepfe selbst nach (sync() loest dabei bewusst KEIN
  // erneutes onChange aus - activeView aendert sich hier ueber Wege, die die
  // Leiste selbst nie angeklickt haben, z. B. den FAB oder "Heute" im
  // Uebersicht-Tab).
  scheduleTablist?.sync(activeView);
  const locked = readOnly();
  const panel = activeView === 'shifts'
    // Der Quickstart bleibt erreichbar, auch nachdem der erste Typ existiert -
    // ein Haushalt kann durchaus "Arbeit" fuer ein Mitglied und spaeter
    // "Schule" fuer ein anderes brauchen, nicht nur beim allerersten Typ.
    ? '<section class="schedule-library schedule-library--shifts"><div class="schedule-library__head"><h2 class="u-section-title">' + esc(t('schedule.shiftTypes')) + '</h2>'
      + (locked ? '' : (state.types.length && visibleQuickstartTemplates().length ? '<div class="segmented" role="group" aria-label="' + esc(t('schedule.quickStartShiftTypes')) + '">'
        + visibleQuickstartTemplates().map(([template, key]) => '<button type="button" class="segmented__item" data-action="quick-start-shifts" data-template="' + template + '">' + esc(t(key)) + '</button>').join('')
        + '</div>' : '')) + '</div>'
      + (state.types.length ? state.types.map(shiftTypeCard).join('') : emptyShiftTypesState()) + '</section>'
      + customFieldsSection()
    : activeView === 'patterns'
      ? '<section class="schedule-library schedule-library--patterns"><h2 class="u-section-title">' + esc(t('schedule.patterns')) + '</h2>' + (state.patterns.length ? state.patterns.map(patternCard).join('') : emptyPatternState()) + '</section>'
        + '<section class="schedule-library schedule-library--overrides"><div class="schedule-library__head"><h2 class="u-section-title">' + esc(t('schedule.overrides')) + '</h2>' + (locked ? '' : '<button type="button" class="btn btn--secondary" data-action="open-create-override"><i data-lucide="plus" aria-hidden="true"></i>' + esc(t('schedule.createOverride')) + '</button>') + '</div>' + overrideRows() + '</section>'
        + '<section class="schedule-library schedule-library--extras"><div class="schedule-library__head"><h2 class="u-section-title">' + esc(t('schedule.extraShifts')) + '</h2>' + (locked ? '' : '<button type="button" class="btn btn--secondary" data-action="open-create-extra"><i data-lucide="plus" aria-hidden="true"></i>' + esc(t('schedule.addExtraShift')) + '</button>') + '</div>' + extraRows() + '</section>'
      : activeView === 'overview'
        ? renderOverview()
        : renderStatistics();
  const body = root.querySelector('.schedule-body');
  body.replaceChildren();
  // Die Heute-Karte erst, wenn das Modul in Betrieb ist: ein frischer Haushalt
  // sah sonst ZWEI Leerzustaende uebereinander („Noch keine Schichteintraege."
  // + „Noch kein Schichtplan") - zwei Meldungen fuer eine Tatsache, und die
  // Onboarding-Anleitung des Panels stand erst an zweiter Stelle
  // (Critique 2026-08-27, P2). Die Uebersicht zeigt bereits mehrere Personen
  // ueber eine ganze Woche - dieselbe "Heute"-Karte daneben waere redundant,
  // genau wie bei Statistics.
  const inUse = state.types.length || state.patterns.length
    || state.overrides.length || state.entries.length;
  body.insertAdjacentHTML('beforeend',
    (activeView === 'statistics' || activeView === 'overview' || !inUse ? '' : '<section class="card card--padded schedule-today"><h2 class="u-section-title">' + esc(t('schedule.today')) + '</h2>' + renderToday() + renderScheduleWarnings() + '</section>')
    + `<div class="schedule-content">${panel}</div>`);
  updateScheduleFab();
  window.lucide?.createIcons({ el: body });
  wireShiftTypeFieldSortables(body);
  if (activeView === 'overview') {
    bindUserMultiSelect(body, 'overview-people');
    wireScrollFade(body.querySelector('.schedule-overview__scroll'));
  }
  if (scrollPort) scrollPort.scrollTop = scrollTop;
}

// Drag ist NIE der einzige Weg (siehe utils/sortable.js) - die Auf/Ab-Knoepfe
// in shiftTypeFieldRow() bedienen dieselbe lokale Umsortierung tastaturbasiert.
// `onEnd` bleibt bewusst leer: SortableJS hat das DOM bereits physisch
// umgestellt, und wie beim Zyklustage-Editor schreibt erst der eigene
// Speichern-Klick etwas - keine Instanz-Nachverfolgung noetig, `renderPage()`
// ersetzt den ganzen Teilbaum bei jeder Aenderung ohnehin neu.
function wireShiftTypeFieldSortables(body) {
  body.querySelectorAll('[data-type-fields-rows]').forEach((listEl) => {
    makeSortable(listEl, { handle: '.schedule-type-field-row__handle', onEnd: () => {} }).catch(() => {});
  });
}
function updateScheduleFab() {
  if (!scheduleFab) return;
  // Sichtbares Dock-Label = aria-label: beide nennen die AKTION ("Add entry",
  // "Create shift type"), nicht den aktiven Tab (S-09) - vorher stand hier ein
  // eigenes `dockLabels`-Kurzwort ("Planning"), das am Docking-Ort aussah, als
  // liesse sich der Tabname selbst antippen statt die Anlege-Aktion dahinter.
  const labels = {
    shifts: t('schedule.createShiftType'),
    patterns: t('schedule.addEntry'),
  };
  setPageFabAction(scheduleFab, {
    label: labels[activeView],
    dockLabel: labels[activeView],
    // Statistics und Overview sind beide reine Leseansichten - kein "Anlegen".
    // Ausgeblendet ist nicht dasselbe wie unerreichbar (siehe readOnly()/
    // action()) - der Handler bleibt trotzdem gesperrt.
    hidden: readOnly() || activeView === 'statistics' || activeView === 'overview',
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
    + formField(t('schedule.shiftType'), '<select class="input" name="shift_type_id">' + typeOptions(type?.id ?? null) + '</select>')
    + formField(t('schedule.note'), '<input class="input" name="note" maxlength="5000" value="' + esc(group.note ?? '') + '">')
    + dayRowFieldsHtml(type?.id ?? null, group.field_values)
    + '<div class="modal-actions"><button type="submit" class="btn btn--primary">' + esc(t('schedule.save')) + '</button></div></form>';
  openModal({
    title: t('schedule.editOverride'),
    size: 'md',
    content,
    onSave: (modal) => {
      const form = modal.querySelector('#schedule-create-form');
      wireOccurrenceFieldReactivity(form);
      form?.addEventListener('submit', saveCreatedSchedule);
    },
  });
}

// Die Override-/Extra-Modale haengen am document.body, ausserhalb von `root` -
// der Klick-/Change-Delegierte in renderShell() erreicht sie nicht, deshalb
// hier eigens verdrahtet (derselbe Grund wie pick-shift-icon). Ein Feld-
// Unterblock direkt nach dem Schichttyp-Feld, neu gebaut bei jedem Wechsel -
// dieselbe dayRowFieldsHtml(), die auch der Zyklustage-Editor benutzt.
// JEDES [name="shift_type_id"] im Bereich wird verdrahtet, nicht nur das
// erste - das gemeinsame Anlege-Formular (openScheduleCreateModal) traegt
// zwei davon (Ersetzen/Hinzufuegen, je ein eigenes <fieldset>, per
// disabled/hidden nur eines davon aktiv), und jedes braucht seinen eigenen,
// auf sein EIGENES Fieldset begrenzten Feld-Unterblock.
function wireOccurrenceFieldReactivity(scope) {
  scope?.querySelectorAll('[name="shift_type_id"]').forEach((select) => {
    select.addEventListener('change', () => {
      const container = select.closest('fieldset') ?? select.closest('form');
      const existing = container?.querySelector('[data-day-row-fields]');
      const html = dayRowFieldsHtml(select.value);
      if (existing) existing.outerHTML = html;
      else if (html) select.closest('.form-field')?.insertAdjacentHTML('afterend', html);
      window.lucide?.createIcons({ el: container });
    });
  });
}

/**
 * Additiv zu Muster/Override, deshalb ein eigenes, kleineres Formular statt
 * einer weiteren Verzweigung in openScheduleCreateModal(). Eine Gruppe statt
 * einer einzelnen Zeile - wie openOverrideEditModal(), eine einzelne Zusatz-
 * schicht ist nur eine Gruppe der Groesse 1 (from === to). Extras haben aber
 * kein ON CONFLICT wie Overrides: das Speichern legt fuer den neuen Zeitraum
 * zuerst frische Zeilen an und loescht die alten IDs erst danach - schlaegt
 * das Anlegen fehl, bleiben hoechstens Duplikate statt eines Datenverlusts.
 */
function openExtraGroupEditModal(group) {
  const content = '<form id="schedule-create-form" class="form-stack schedule-modal-form" data-form="extra-edit-range">'
    + '<input type="hidden" name="ids" value="' + esc(group.ids.join(',')) + '">'
    + '<input type="hidden" name="user_id" value="' + esc(String(group.user_id)) + '">'
    + formField(t('schedule.owner'), '<input class="input" readonly value="' + esc(userName(group.user_id)) + '">')
    + formField(t('schedule.rangeFrom'), '<yuvomi-datepicker required name="from" type="date" label="' + esc(t('schedule.rangeFrom')) + '" value="' + esc(group.from) + '"></yuvomi-datepicker>')
    + formField(t('schedule.rangeTo'), '<yuvomi-datepicker required name="to" type="date" label="' + esc(t('schedule.rangeTo')) + '" value="' + esc(group.to) + '"></yuvomi-datepicker>')
    + formField(t('schedule.shiftType'), '<select class="input" required name="shift_type_id">' + typeOptions(group.shift_type_id, false) + '</select>')
    + formField(t('schedule.note'), '<input class="input" name="note" maxlength="5000" value="' + esc(group.note ?? '') + '">')
    + reminderOffsetField(group.reminder_offset_minutes)
    + dayRowFieldsHtml(group.shift_type_id, group.field_values)
    + '<div class="modal-actions"><button type="submit" class="btn btn--primary">' + esc(t('schedule.save')) + '</button></div></form>';
  openModal({
    title: t('schedule.editExtraShift'),
    size: 'md',
    content,
    onSave: (modal) => {
      const form = modal.querySelector('#schedule-create-form');
      form?.querySelector('[name="reminder_enabled"]')?.addEventListener('change', (event) => {
        form.querySelector('[name="reminder_offset_minutes"]').disabled = !event.currentTarget.checked;
      });
      wireOccurrenceFieldReactivity(form);
      form?.addEventListener('submit', saveCreatedSchedule);
    },
  });
}

function openScheduleCreateModal(view, { mode = 'pattern' } = {}) {
  let title;
  let content;
  if (view === 'shifts') {
    title = t('schedule.createShiftType');
    content = '<form id="schedule-create-form" class="form-stack schedule-modal-form" data-form="shift-create">'
      + formField(t('schedule.preset'), '<select class="input" name="shift_preset">' + shiftPresetOptions() + '</select>')
      + shiftFields()
      + '<div class="modal-actions"><button type="submit" class="btn btn--primary">' + esc(t('common.create')) + '</button></div></form>';
  } else if (view === 'patterns') {
    // EIN Formular fuer drei Faelle statt drei getrennter Modale: eine
    // wiederkehrende Rotation (Muster), eine einmalige ERSETZUNG eines Tages
    // (frueher "Override", ersetzt was das Muster sagt - NULL ist ein
    // ausdruecklich freier Tag) und eine einmalige ZUSAETZLICHE Schicht
    // (Extra, stapelt sich immer, egal was sonst an dem Tag steht). EIN
    // dreiteiliger Umschalter (.segmented, wie schedule-stat-range__choices)
    // statt zweier verschachtelter Kippschalter - jeder Modus lebt in einem
    // eigenen <fieldset>, das ausser dem aktiven immer disabled ist. Das ist
    // absichtlich mehr als Kosmetik: ein disabled fieldset nimmt FormData UND
    // die native Validierung automatisch aus - ein verstecktes, aber weiterhin
    // required und aktives Feld (wie zuvor "name") blockiert sonst den Submit
    // lautlos, weil Chromium ein unsichtbares Pflichtfeld nicht fokussieren
    // kann, um den Fehler zu zeigen.
    title = t('schedule.addEntry');
    const modes = [['pattern', 'schedule.pattern'], ['replace', 'schedule.override'], ['add', 'schedule.extraBadgeLabel']];
    content = '<form id="schedule-create-form" class="form-stack schedule-modal-form" data-form="pattern-create">'
      + formField(t('schedule.owner'), '<select class="input" required name="user_id">' + userOptions(selectedOwner()) + '</select>')
      // data-dirty-ignore (S-14): merely switching the segmented Pattern/
      // Override/Extra control rewrites this hidden value - without the
      // opt-out, modal.js's dirty guard read that as a real change and
      // prompted "Discard changes?" on Escape even though nothing was typed.
      + '<input type="hidden" name="mode" value="' + esc(mode) + '" data-dirty-ignore>'
      // Kein zweites sichtbares Label hier - der Modaltitel sagt bereits
      // "Add entry", ein identisches Label direkt darunter war reine
      // Wiederholung. `aria-label` traegt den Kontext weiterhin fuer
      // Screenreader, ohne ihn ein zweites Mal sichtbar zu zeigen.
      + '<div class="segmented schedule-create-mode" role="group" aria-label="' + esc(t('schedule.addEntry')) + '">'
      + modes.map(([value, key]) => '<button type="button" class="segmented__item' + (mode === value ? ' is-active' : '') + '" data-mode="' + value + '" aria-pressed="' + (mode === value ? 'true' : 'false') + '">' + esc(t(key)) + '</button>').join('')
      + '</div>'
      + '<fieldset data-field="mode-pattern"' + (mode === 'pattern' ? '' : ' hidden disabled') + '>' + patternFields() + '</fieldset>'
      // Kein Einzeltag-/Zeitraum-Umschalter mehr: ein einzelner Tag ist einfach
      // ein Zeitraum, dessen Von und Bis gleich sind (beide defaulten auf
      // heute) - dieselbe Sache doppelt abzufragen war die eigentliche
      // Redundanz. saveCreatedSchedule() entscheidet an einer Stelle
      // (range_from === range_to), ob der Einzeltag-Endpunkt oder /fill mit
      // Rueckfrage genommen wird - fuer den haeufigen Einzeltag-Fall aendert
      // sich am Verhalten nichts.
      + '<fieldset data-field="one-time-shared"' + (mode === 'pattern' ? ' hidden disabled' : '') + '>'
      + formField(t('schedule.rangeFrom'), '<yuvomi-datepicker name="range_from" type="date" label="' + esc(t('schedule.rangeFrom')) + '" value="' + esc(todayKey()) + '"></yuvomi-datepicker>')
      + formField(t('schedule.rangeTo'), '<yuvomi-datepicker name="range_to" type="date" label="' + esc(t('schedule.rangeTo')) + '" value="' + esc(todayKey()) + '"></yuvomi-datepicker>')
      + formField(t('schedule.note'), '<input class="input" name="note" maxlength="5000">')
      + '</fieldset>'
      // Zwei Auswahlfelder, nicht eins: ein Override darf frei sein (NULL,
      // schedule_overrides.shift_type_id ist nullable), ein Extra nicht
      // (schedule_extra_shifts.shift_type_id ist NOT NULL) - deshalb traegt
      // nur die Ersetzen-Variante die Option "Freier Tag".
      + '<fieldset data-field="mode-replace"' + (mode === 'replace' ? '' : ' hidden disabled') + '>' + formField(t('schedule.shiftType'), '<select class="input" name="shift_type_id">' + typeOptions(null) + '</select>') + '</fieldset>'
      // Anders als "Ersetzen" (dessen freier Tag defaultet, also nie eigene
      // Felder traegt) waehlt ein natives <select> ohne `includeFree` und ohne
      // explizit markierte Auswahl (typeOptions(null, false)) schon selbst den
      // ERSTEN echten Schichttyp - der Feld-Unterblock muss also von Anfang an
      // zu GENAU diesem (impliziten) Typ passen, nicht erst nach dem ersten
      // manuellen Wechsel (der einzige Moment, in dem
      // wireOccurrenceFieldReactivity() ihn bisher nachzog). Dieselbe
      // Reihenfolge wie openExtraGroupEditModal(): Reminder-Feld, dann der
      // Feld-Unterblock.
      // S-02/S-07: ohne einen einzigen Schichttyp ist typeOptions(null, false)
      // ein <select> mit NULL Optionen - ein Klick auf Speichern landete bisher
      // beim Server, der den rohen Text "shift_type_id must be a positive
      // number." zurueckgab. `required` laesst den Browser das jetzt selbst
      // verhindern, der Hinweis ersetzt das leere <select> ganz (ein leerer
      // Waehler ist kein Formularfeld, das ausfuellbar waere), und der
      // Speichern-Knopf bleibt fuer diesen Modus zusaetzlich gesperrt
      // (updateAddModeAvailability() unten) - kein einziger Weg mehr zu einem
      // Absenden ohne Typ.
      + '<fieldset data-field="mode-add"' + (mode === 'add' ? '' : ' hidden disabled') + '>' + (state.types.length
        ? formField(t('schedule.shiftType'), '<select class="input" required name="shift_type_id">' + typeOptions(null, false) + '</select>')
        : '<p class="form-hint schedule-no-types-hint">' + esc(t('schedule.noShiftTypesHint')) + '</p>')
      + reminderOffsetField(null) + dayRowFieldsHtml(state.types[0]?.id ?? null) + '</fieldset>'
      + '<div class="modal-actions"><button type="submit" class="btn btn--primary" data-role="save-entry">' + esc(t('schedule.save')) + '</button></div></form>';
  }
  openModal({
    title,
    size: 'md',
    content,
    onSave: (modal) => {
      const form = modal.querySelector('#schedule-create-form');
      form?.querySelector('[name="shift_preset"]')?.addEventListener('change', () => applyShiftPreset(form));
      // Wie der Fuell-Umschalter direkt darunter: das Modal haengt an
      // document.body, ausserhalb von `root` - der Klick-Delegierte in
      // action() erreicht es nicht, also eigens verdrahten.
      form?.querySelector('[data-action="pick-shift-icon"]')?.addEventListener('click', (event) => pickShiftIcon(event.currentTarget));
      // Ein dreiteiliger Umschalter statt zweier verschachtelter Kippschalter:
      // jeder Klick setzt `hidden` UND `disabled` gemeinsam auf jedem
      // <fieldset> - `disabled` ist der eigentliche Fix, nicht nur Kosmetik,
      // siehe Kommentar oben an der Formularerzeugung.
      // S-02/S-07: der Speichern-Knopf bleibt gesperrt, solange der Modus
      // "Extra" aktiv ist UND kein Schichttyp existiert - dieselbe Bedingung,
      // unter der die Fieldset oben den Hinweis statt eines leeren <select>
      // zeigt. Jeder andere Modus/Zustand bleibt unberuehrt.
      const updateAddModeAvailability = () => {
        const saveButton = form.querySelector('[data-role="save-entry"]');
        if (!saveButton) return;
        const currentMode = form.querySelector('[name="mode"]')?.value;
        saveButton.disabled = currentMode === 'add' && !state.types.length;
      };
      form?.querySelectorAll('[data-mode]').forEach((button) => {
        button.addEventListener('click', () => {
          const mode = button.dataset.mode;
          form.querySelector('[name="mode"]').value = mode;
          form.querySelectorAll('[data-mode]').forEach((item) => {
            const active = item.dataset.mode === mode;
            item.classList.toggle('is-active', active);
            item.setAttribute('aria-pressed', String(active));
          });
          const setGroup = (field, enabled) => {
            const fieldset = form.querySelector('[data-field="' + field + '"]');
            fieldset.hidden = !enabled;
            fieldset.disabled = !enabled;
          };
          setGroup('mode-pattern', mode === 'pattern');
          setGroup('one-time-shared', mode !== 'pattern');
          setGroup('mode-replace', mode === 'replace');
          setGroup('mode-add', mode === 'add');
          updateAddModeAvailability();
        });
      });
      updateAddModeAvailability();
      form?.querySelector('[name="reminder_enabled"]')?.addEventListener('change', (event) => {
        form.querySelector('[name="reminder_offset_minutes"]').disabled = !event.currentTarget.checked;
      });
      wireOccurrenceFieldReactivity(form);
      form?.addEventListener('submit', saveCreatedSchedule);
    },
  });
}

// `[data-field-value]`-Eingaben tragen bewusst kein `name` - ihr Schluessel
// ist die Feld-Id, nicht ein fester Formularname, deshalb liest sie die
// native FormData() nicht mit. Auf den uebergebenen Bereich begrenzt statt
// das ganze Formular zu durchsuchen: das gemeinsame Anlege-Formular haelt
// bis zu zwei Feld-Unterbloecke gleichzeitig im DOM (Ersetzen/Hinzufuegen je
// eigenes <fieldset>), nur einer davon aktiv - sonst laesen bereits
// getippte, aber inzwischen verlassene Werte des anderen Modus mit hinein.
function collectFieldValues(scope) {
  const values = {};
  scope?.querySelectorAll('[data-field-value]').forEach((input) => {
    if (input.value.trim()) values[input.dataset.fieldValue] = input.value.trim();
  });
  return values;
}

async function saveCreatedSchedule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = formData(form);
  try {
    if (form.dataset.form === 'shift-create') await api.post('/schedule/shift-types', data);
    if (form.dataset.form === 'pattern-create') {
      if (data.mode === 'pattern') {
        data.user_id = Number(data.user_id);
        data.cycle_length = Number(data.cycle_length);
        data.is_active = form.elements.is_active.checked;
        // S-05: eine neue AKTIVE Karte, die eine bestehende aktive Karte
        // derselben Person ueberschneidet, flippt jede Ansicht sofort auf sich
        // selbst (server-seitig gewinnt "valid_from DESC, id DESC" - siehe
        // resolveWinningPatternId()) - bisher war der Ueberlappungs-Banner das
        // einzige (nachtraegliche) Signal dafuer. Eine inaktive Karte kann
        // nichts ueberschreiben, deshalb kein Check in diesem Zweig.
        if (data.is_active) {
          const overlap = findOverlappingActivePattern(state.patterns, data.user_id, data.valid_from || null, data.valid_until || null);
          if (overlap) {
            // confirmOverModal statt confirmModal: dieses Anlege-Formular ist
            // noch offen (siehe der gleiche Grund am "replace"-Zweig unten) -
            // "Abbrechen" soll die getippten Felder nicht loeschen.
            const confirmed = await confirmOverModal(
              t('schedule.patternOverlapConfirmTitle', { user: userName(data.user_id) }),
              { confirmLabel: t('schedule.patternOverlapConfirmAction'), detail: t('schedule.patternOverlapConfirmDetail', { name: overlap.name }) },
            );
            if (!confirmed) return;
          }
        }
        await api.post('/schedule/patterns', data);
      } else if (data.mode === 'replace') {
        const userId = Number(data.user_id);
        const shiftTypeId = data.shift_type_id ? Number(data.shift_type_id) : null;
        const fieldValues = collectFieldValues(form.querySelector('[data-field="mode-replace"]'));
        // Kein Umschalter mehr - ein einzelner Tag ist einfach ein Zeitraum,
        // dessen Von und Bis gleich sind. Nur ein echter Mehrtagesbereich
        // bekommt die Rueckfrage, das entspricht dem bisherigen Verhalten
        // fuer den (haeufigeren) Einzeltag-Fall unveraendert.
        if (data.range_from === data.range_to) {
          await api.put('/schedule/overrides/' + encodeURIComponent(data.range_from), { user_id: userId, shift_type_id: shiftTypeId, note: data.note, field_values: fieldValues });
        } else {
          const type = state.types.find((item) => Number(item.id) === shiftTypeId);
          const typeLabel = type ? (type.short_code ? `${type.short_code} · ${type.name}` : type.name) : t('schedule.freeDay');
          // confirmOverModal statt confirmModal: dieser Aufruf laeuft WAEHREND
          // das Anlege-Formular noch offen ist. confirmModal haengt an
          // openModal, und das schliesst ein bereits offenes Modal mit
          // `force: true` weg (kein Stacking) - "Abbrechen" hier, der einzige
          // Grund ueberhaupt nachzufragen, vernichtete damit lautlos jedes
          // getippte Feld. confirmOverModal parkt das Formular stattdessen und
          // gibt es bei "Abbrechen" unveraendert zurueck (H-3).
          const confirmed = await confirmOverModal(
            t('schedule.fillRangeConfirmTitle'),
            { confirmLabel: t('schedule.fillRange'), detail: t('schedule.fillRangeConfirmDetail', { from: formatDate(data.range_from), to: formatDate(data.range_to), type: typeLabel }) },
          );
          if (!confirmed) return;
          await api.post('/schedule/overrides/fill', { user_id: userId, from: data.range_from, to: data.range_to, shift_type_id: shiftTypeId, note: data.note, field_values: fieldValues });
        }
      } else {
        const payload = {
          user_id: Number(data.user_id),
          shift_type_id: Number(data.shift_type_id),
          note: data.note,
          reminder_offset_minutes: form.elements.reminder_enabled.checked ? Number(data.reminder_offset_minutes) : null,
          field_values: collectFieldValues(form.querySelector('[data-field="mode-add"]')),
        };
        if (data.range_from === data.range_to) {
          await api.post('/schedule/extras', { ...payload, date_key: data.range_from });
        } else {
          await api.post('/schedule/extras/fill', { ...payload, from: data.range_from, to: data.range_to });
        }
      }
    }
    if (form.dataset.form === 'override-edit') {
      const userId = Number(data.user_id);
      const shiftTypeId = data.shift_type_id ? Number(data.shift_type_id) : null;
      const type = state.types.find((item) => Number(item.id) === shiftTypeId);
      const typeLabel = type ? (type.short_code ? `${type.short_code} · ${type.name}` : type.name) : t('schedule.freeDay');
      const fieldValues = collectFieldValues(form);
      // Gleicher Grund wie im "replace"-Zweig oben: das Editier-Formular ist
      // beim Speichern noch offen, confirmOverModal parkt es statt es beim
      // Nachfragen zu vernichten (H-3).
      const confirmed = await confirmOverModal(
        t('schedule.fillRangeConfirmTitle'),
        { confirmLabel: t('schedule.save'), detail: t('schedule.fillRangeConfirmDetail', { from: formatDate(data.from), to: formatDate(data.to), type: typeLabel }) },
      );
      if (!confirmed) return;
      await api.post('/schedule/overrides/fill', { user_id: userId, from: data.from, to: data.to, shift_type_id: shiftTypeId, note: data.note, field_values: fieldValues });
      // Was ausserhalb der neuen Spanne lag, aber zur alten gehoerte, muss weg -
      // sonst bliebe ein verkuerztes Ende als Karteileiche stehen (fill fasst
      // nur die neue Spanne an, nie das, was davor oder danach lag).
      const leftovers = rangeDifference(data.original_from, data.original_to, data.from, data.to);
      for (const span of leftovers) {
        await api.delete(`/schedule/overrides?user_id=${userId}&from=${span.from}&to=${span.to}`);
      }
    }
    if (form.dataset.form === 'extra-edit-range') {
      const payload = {
        user_id: Number(data.user_id),
        shift_type_id: Number(data.shift_type_id),
        note: data.note,
        reminder_offset_minutes: form.elements.reminder_enabled.checked ? Number(data.reminder_offset_minutes) : null,
        field_values: collectFieldValues(form),
      };
      // Extras kennen kein ON CONFLICT wie Overrides - erst die neuen Zeilen
      // fuer den (moeglicherweise verschobenen/veraenderten) Zeitraum anlegen,
      // dann die alten IDs loeschen. In dieser Reihenfolge kostet ein
      // fehlgeschlagener zweiter Schritt hoechstens ein Duplikat, nie einen
      // Datenverlust.
      if (data.from === data.to) {
        await api.post('/schedule/extras', { ...payload, date_key: data.from });
      } else {
        await api.post('/schedule/extras/fill', { ...payload, from: data.from, to: data.to });
      }
      for (const id of data.ids.split(',')) {
        await api.delete(`/schedule/extras/${id}`);
      }
    }
    await load();
    renderPage();
    await closeModal({ force: true });
    window.yuvomi?.showToast(t('schedule.saved'), 'success');
  } catch (error) {
    window.yuvomi?.showToast(scheduleErrorMessage(error), 'danger');
  }
}

// Eigenes, kleines Modal statt eines vierten Zweigs in saveCreatedSchedule():
// die Registrierung eines Feldes ist ein Ein-Feld-Formular ohne Beruehrung mit
// Mustern/Ausnahmen/Extras, ein weiterer Zweig dort haette nur die ohnehin
// schon grosse Funktion weiter aufgeblaeht.
function openCustomFieldModal(field = null) {
  const isEdit = Boolean(field);
  openModal({
    title: isEdit ? t('schedule.editCustomField') : t('schedule.createCustomField'),
    size: 'sm',
    content: '<form id="schedule-custom-field-form" class="form-stack schedule-modal-form">'
      + formField(t('schedule.fieldName'), '<input class="input" required name="name" maxlength="100" value="' + esc(field?.name ?? '') + '">')
      + '<div class="modal-actions"><button type="submit" class="btn btn--primary">' + esc(t('schedule.save')) + '</button></div></form>',
    onSave: (modal) => {
      modal.querySelector('#schedule-custom-field-form')?.addEventListener('submit', (event) => saveCustomField(event, field?.id ?? null));
    },
  });
}

async function saveCustomField(event, fieldId) {
  event.preventDefault();
  const data = formData(event.currentTarget);
  try {
    if (fieldId) await api.put(`/schedule/custom-fields/${fieldId}`, data);
    else await api.post('/schedule/custom-fields', data);
    await load();
    renderPage();
    await closeModal({ force: true });
    window.yuvomi?.showToast(t('schedule.saved'), 'success');
  } catch (error) {
    window.yuvomi?.showToast(scheduleErrorMessage(error), 'danger');
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
  // Reserviert die Generation dieses Statistik-Ladevorgangs (siehe
  // refreshStatistics()/activateView()) - nur fuer den 'statistics'-Zweig
  // gesetzt, aber ausserhalb von try/catch deklariert, damit der catch-Zweig
  // unten denselben Wert lesen kann.
  let statisticsRequest = null;
  try {
    if (form.dataset.form === 'statistics') {
      statisticsRequest = ++statisticsRequestId;
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
        error: false,
      };
      renderPage();
      await refreshStatistics();
      // Ueberholt? Eine juengere Anfrage (Tab-Wechsel, erneutes Absenden) hat
      // den Zaehler inzwischen weitergedreht - ihr Ergebnis zaehlt, nicht
      // dieses.
      if (statisticsRequest === statisticsRequestId) renderPage();
      return;
    }
    // Keine Zweige fuer 'shift-create'/'pattern-create'/'override-create' hier:
    // alle drei werden ausschliesslich im Erstellen-Modal gebaut (an
    // document.body, nicht in `root`), das direkt an saveCreatedSchedule()
    // verdrahtet - dieser Delegierte an `root` sieht so ein Formular nie.
    // Nur die INLINE-Bearbeitungsformulare (Update) leben in `root`.
    if (form.dataset.form === 'shift-update') await api.put(`/schedule/shift-types/${form.dataset.id}`, data);
    if (form.dataset.form === 'pattern-update') {
      data.cycle_length = Number(data.cycle_length);
      data.is_active = form.elements.is_active.checked;
      // S-02/S-37: vorab pruefen statt den Rohtext des Servers abzuwarten -
      // pattern.days liegt bereits geladen im state, dieselbe Bedingung, die
      // der Server ohnehin durchsetzt (siehe patternDaysExceedingCycleLength()).
      // Feldbezogen statt Toast: das Feld liegt direkt in diesem (nicht-modalen)
      // Inline-Formular, reportFieldError() setzt/loescht die Meldung genau wie
      // in den Modal-Formularen anderer Seiten.
      const pattern = state.patterns.find((item) => Number(item.id) === Number(form.dataset.id));
      const conflict = patternDaysExceedingCycleLength(pattern?.days, data.cycle_length);
      if (conflict) {
        reportFieldError(form.querySelector('[name="cycle_length"]'), t('schedule.cycleLengthTooShort', conflict));
        return;
      }
      // S-05: ein Umschalten von aus -> an kann genau denselben stillen
      // Ueberlappungs-Sieg ausloesen wie eine neu angelegte aktive Karte -
      // derselbe Check, dasselbe confirmModal (kein Anlege-Formular offen,
      // dieses Formular lebt inline in der Karte selbst, kein confirmOverModal
      // noetig).
      if (data.is_active && !pattern?.is_active) {
        const overlap = findOverlappingActivePattern(state.patterns, pattern?.user_id, data.valid_from || null, data.valid_until || null, pattern?.id);
        if (overlap) {
          const confirmed = await confirmModal(
            t('schedule.patternOverlapConfirmTitle', { user: userName(pattern?.user_id) }),
            { confirmLabel: t('schedule.patternOverlapConfirmAction'), detail: t('schedule.patternOverlapConfirmDetail', { name: overlap.name }) },
          );
          if (!confirmed) return;
        }
      }
      await api.put(`/schedule/patterns/${form.dataset.id}`, data);
      dirtyPatternIds.delete(String(form.dataset.id)); // S-03: gespeichert, nichts mehr zu verwerfen
    }
    await load();
    renderPage();
    window.yuvomi?.showToast(t('schedule.saved'), 'success');
  } catch (error) {
    if (form.dataset.form === 'statistics' && statisticsRequest === statisticsRequestId) {
      statistics = { ...statistics, loading: false, error: true };
      renderPage();
    }
    window.yuvomi?.showToast(scheduleErrorMessage(error), 'danger');
  }
}

// Jede `data-action` dieser Seite, die NICHT schreibt (reine Navigation/
// Ansicht). Eine Positivliste, damit eine spaeter ergaenzte Schreib-Aktion
// standardmaessig gesperrt ist statt standardmaessig offen - die
// Markup-Unterdrueckung (readOnly()-Abfragen in den render*-Funktionen) ist die
// erste Verteidigungslinie, dieser Wachposten in action() die zweite (ein
// veralteter oder per Devtools wiederbelebter Knopf findet denselben Riegel).
// Selbes Muster wie READ_SAFE_ACTIONS in public/pages/waste.js.
const READ_SAFE_ACTIONS = new Set([
  'print-statistics', 'statistics-range', 'overview-week', 'overview-view-mode',
  'retry-statistics', 'retry-overview',
  // S-17: nur ein Lesevorgang (openScheduleEntryDetailModal ruft nie eine
  // schreibende API) - auch ein Nur-lesen-Mitglied darf einen Eintrag ansehen.
  'view-schedule-entry',
]);

async function action(event) {
  const button = event.currentTarget;
  if (readOnly() && !READ_SAFE_ACTIONS.has(button.dataset.action)) return;
  try {
    if (button.dataset.action === 'open-create') {
      openScheduleCreateModal(button.dataset.view || activeView);
      return;
    }
    if (button.dataset.action === 'view-schedule-entry') {
      const entry = findScheduleEntry(button.dataset.scheduleKey);
      if (entry) openScheduleEntryDetailModal(entry);
      return;
    }
    // `button.disabled` statt eines `state.types.length`-Torwaechters: der
    // alte Wachposten blockierte JEDE weitere Vorlage, sobald irgendein Typ
    // existierte - richtig, solange es nur eine Vorlage gab, falsch, sobald
    // ein Haushalt z.B. "Arbeit" fuer ein Mitglied und spaeter "Schule" fuer
    // ein anderes braucht. Ein bereits vorhandener Kurzcode wird stattdessen
    // je Preset uebersprungen, nicht der ganze Lauf verweigert - ein zweiter
    // Klick auf dieselbe Vorlage legt so nichts doppelt an. `finally` statt
    // nur dem Erfolgspfad: schlaegt ein Preset mitten in der Schleife fehl
    // (Netzwerk, doppelter Kurzcode einer eigenen Anlage), sollen die bereits
    // angelegten trotzdem sichtbar werden.
    if (button.dataset.action === 'quick-start-shifts') {
      button.disabled = true;
      const template = PRESET_TEMPLATES[button.dataset.template] ?? [];
      const existingCodes = new Set(state.types.map((type) => type.short_code));
      let createdCount = 0;
      try {
        for (const preset of template) {
          if (existingCodes.has(preset.shortCode)) continue;
          await api.post('/schedule/shift-types', {
            name: shiftPresetLabel(preset.key),
            short_code: preset.shortCode,
            start_time: preset.startTime,
            end_time: preset.endTime,
            color: preset.color,
            icon: preset.icon,
          });
          createdCount += 1;
        }
      } finally {
        await load();
        renderPage();
      }
      // Zaehlend statt "Gespeichert." fuer beide Faelle (S-11): ein erneuter
      // Klick auf dieselbe Vorlage legt nichts mehr an (siehe Kommentar oben,
      // existingCodes ueberspringt jeden schon vorhandenen Kurzcode) - das war
      // vorher nicht vom Erfolgsfall zu unterscheiden.
      window.yuvomi?.showToast(
        createdCount > 0 ? t('schedule.quickStartCreated', { count: createdCount }) : t('schedule.quickStartNothingNew'),
        'success'
      );
      return;
    }
    if (button.dataset.action === 'pick-shift-icon') {
      await pickShiftIcon(button);
      return;
    }
    if (button.dataset.action === 'print-statistics') {
      window.print();
      return;
    }
    if (button.dataset.action === 'statistics-range') {
      statistics = { ...statistics, range: button.dataset.range, entries: [], bounds: null, loading: false };
      renderPage();
      return;
    }
    // Wiederholen-CTA des Fehlerzustands (renderStatistics()/renderOverview()) -
    // laeuft ueber activateView(), denselben Weg wie ein Tab-Wechsel, damit
    // Ladezustand, Generationszaehler und Fehler-Rueckstellung an genau einer
    // Stelle bleiben statt hier verdoppelt zu werden.
    if (button.dataset.action === 'retry-statistics') {
      await activateView('statistics');
      return;
    }
    if (button.dataset.action === 'retry-overview') {
      await activateView('overview');
      return;
    }
    if (button.dataset.action === 'overview-week') {
      const step = overview.viewMode === 'day' ? 1 : 7;
      const days = button.dataset.direction === 'prev' ? -step : button.dataset.direction === 'next' ? step : null;
      overview = { ...overview, weekCursor: days ? addLocalDays(overview.weekCursor, days) : todayKey() };
      await activateView('overview');
      return;
    }
    if (button.dataset.action === 'overview-view-mode') {
      overview = { ...overview, viewMode: button.dataset.mode };
      saveOverviewViewMode(overview.viewMode);
      renderPage();
      return;
    }
    if (button.dataset.action === 'edit-override') {
      const group = overrideGroups().find((item) => item.from === button.dataset.from && Number(item.user_id) === Number(button.dataset.userId));
      if (group) openOverrideEditModal(group);
      return;
    }
    // Bisher die einzige Loeschung im Modul ohne Rueckfrage (S-01) - Muster,
    // Override-Bereich, Extra-Bereich und Eigenes Feld fragen alle schon nach,
    // ein Schichttyp verschwand mit einem Klick, ohne Undo. Derselbe
    // confirmModal-Aufbau wie 'delete-pattern' direkt unten.
    if (button.dataset.action === 'delete-shift') {
      const type = state.types.find((item) => Number(item.id) === Number(button.dataset.id));
      const confirmed = await confirmModal(
        t('schedule.deleteShiftTypeTitle'),
        { danger: true, confirmLabel: t('schedule.delete'), detail: t('schedule.deleteShiftTypeDetail', { name: type?.name ?? '' }) },
      );
      if (!confirmed) return;
      await api.delete(`/schedule/shift-types/${button.dataset.id}`);
    }
    if (button.dataset.action === 'open-create-custom-field') {
      openCustomFieldModal();
      return;
    }
    if (button.dataset.action === 'edit-custom-field') {
      const field = state.customFields.find((item) => Number(item.id) === Number(button.dataset.id));
      if (field) openCustomFieldModal(field);
      return;
    }
    // Kaskadiert serverseitig ueber Zuordnung UND Werte (ON DELETE CASCADE,
    // Migration 189) - anders als ein Schichttyp (409, solange er noch
    // referenziert ist) ist das Loeschen eines Feldes eine bewusst
    // bestaetigte Aktion, deshalb die Rueckfrage hier statt eines
    // Server-Schutzes.
    if (button.dataset.action === 'delete-custom-field') {
      const field = state.customFields.find((item) => Number(item.id) === Number(button.dataset.id));
      const affected = state.types.filter((type) => (type.fields ?? []).some((f) => Number(f.id) === Number(button.dataset.id))).length;
      const confirmed = await confirmModal(
        t('schedule.deleteCustomFieldTitle', { name: field?.name ?? '' }),
        { danger: true, confirmLabel: t('schedule.delete'), detail: t('schedule.deleteCustomFieldDetail', { count: affected }) },
      );
      if (!confirmed) return;
      await api.delete(`/schedule/custom-fields/${button.dataset.id}`);
    }
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
      dirtyPatternIds.delete(String(button.dataset.id)); // S-03: die Karte selbst ist weg, nichts mehr zu verwerfen
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
    if (button.dataset.action === 'open-create-extra') {
      openScheduleCreateModal('patterns', { mode: 'add' });
      return;
    }
    if (button.dataset.action === 'open-create-override') {
      openScheduleCreateModal('patterns', { mode: 'replace' });
      return;
    }
    if (button.dataset.action === 'edit-extra-range') {
      const group = extraGroups().find((item) => item.ids.join(',') === button.dataset.ids);
      if (group) openExtraGroupEditModal(group);
      return;
    }
    // Dieselbe Begruendung wie 'delete-override-range': ein Bereich kann viele
    // Tage tragen, darum fragt das Loeschen hier nach - ein Extra-Tag ist
    // seitdem selbst nur eine Gruppe der Groesse 1 und nimmt denselben Weg.
    if (button.dataset.action === 'delete-extra-range') {
      const { from, to, userId } = button.dataset;
      const confirmed = await confirmModal(
        t('schedule.deleteOverrideRangeTitle'),
        { danger: true, confirmLabel: t('schedule.delete'), detail: t('schedule.deleteOverrideRangeDetail', { from: formatDate(from), to: formatDate(to), user: userName(userId) }) },
      );
      if (!confirmed) return;
      try {
        for (const id of button.dataset.ids.split(',')) {
          await api.delete(`/schedule/extras/${id}`);
        }
      } catch (error) {
        // Extras haben kein Range-Delete-Endpoint - die Schleife loescht Zeile
        // fuer Zeile, und ein Fehlschlag in der Mitte hat bereits einige davon
        // entfernt, bevor der Fehler auftrat. Ohne Neuladen bliebe die alte
        // (jetzt falsche) Liste stehen und taeuschte vor, nichts sei passiert.
        await load();
        renderPage();
        window.yuvomi?.showToast(scheduleErrorMessage(error), 'danger');
        return;
      }
    }
    // Rein lokale Aenderungen am Tageseditor, kein API-Aufruf - erst der
    // 'save-days'-Klick unten schreibt etwas. Deshalb ein fruehes `return`:
    // das gemeinsame `await load(); renderPage();` am Ende dieser Funktion
    // wuerde sonst die gerade hinzugefuegte/entfernte Zeile mit dem
    // Server-Stand ueberschreiben, bevor sie je gespeichert wurde.
    if (button.dataset.action === 'add-pattern-day-row') {
      button.closest('[data-day-group]')?.querySelector('.schedule-day-rows')?.insertAdjacentHTML('beforeend', dayRowHtml(Number(button.dataset.position), null, true));
      window.lucide?.createIcons({ el: root });
      markPatternDirty(button); // S-03: eine hinzugefuegte, aber ungespeicherte Zeile
      return;
    }
    if (button.dataset.action === 'remove-pattern-day-row') {
      markPatternDirty(button); // S-03: siehe add-pattern-day-row
      button.closest('[data-day-row]')?.remove();
      return;
    }
    // Dieselbe lokal-erst-Regel wie die Zyklustage-Zeilen oben: hinzufuegen,
    // entfernen und umsortieren aendern nur das DOM, bis 'save-shift-fields'
    // unten den ganzen Satz an /schedule/shift-types/:id/fields schreibt.
    if (button.dataset.action === 'add-type-field') {
      const container = document.querySelector(`[data-type-fields-rows="${button.dataset.id}"]`);
      const picker = document.querySelector(`[data-field-picker="${button.dataset.id}"]`);
      if (!container || !picker?.value) return;
      const field = state.customFields.find((item) => Number(item.id) === Number(picker.value));
      if (!field) return;
      container.querySelector('.u-meta')?.remove();
      container.insertAdjacentHTML('beforeend', shiftTypeFieldRow({ ...field, show_in_overlay: false }));
      picker.querySelector(`option[value="${field.id}"]`)?.remove();
      window.lucide?.createIcons({ el: container.parentElement });
      return;
    }
    if (button.dataset.action === 'remove-type-field') {
      const row = button.closest('[data-type-field-row]');
      const container = row?.closest('[data-type-fields-rows]');
      row?.remove();
      if (container && !container.children.length) container.insertAdjacentHTML('beforeend', '<p class="u-meta">' + esc(t('schedule.noFieldsAttached')) + '</p>');
      return;
    }
    // Tastaturbedienbarer Reorder-Pfad neben dem Ziehen ueber makeSortable()
    // oben (utils/sortable.js verlangt genau das) - dieselbe Richtung ('up'/
    // 'down') treibt beide Knopf-Varianten, nur je Zeile lokal statt ueber
    // einen Server-Aufruf.
    if (button.dataset.action === 'move-type-field') {
      const row = button.closest('[data-type-field-row]');
      const sibling = button.dataset.direction === 'up' ? row?.previousElementSibling : row?.nextElementSibling;
      if (!row || !sibling) return;
      if (button.dataset.direction === 'up') row.parentElement.insertBefore(row, sibling);
      else row.parentElement.insertBefore(sibling, row);
      return;
    }
    if (button.dataset.action === 'save-shift-fields') {
      const container = document.querySelector(`[data-type-fields-rows="${button.dataset.id}"]`);
      const fields = [...(container?.querySelectorAll('[data-type-field-row]') ?? [])].map((row, index) => ({
        custom_field_id: Number(row.dataset.customFieldId),
        position: index,
        show_in_overlay: row.querySelector('[data-show-in-overlay]')?.checked ?? false,
      }));
      await api.put(`/schedule/shift-types/${button.dataset.id}/fields`, { fields });
    }
    if (button.dataset.action === 'save-days') {
      const details = button.closest('[data-pattern]');
      const days = [...details.querySelectorAll('[data-day-row]')].map((row) => {
        const select = row.querySelector('[data-day]');
        const field_values = {};
        row.querySelectorAll('[data-field-value]').forEach((input) => { if (input.value.trim()) field_values[input.dataset.fieldValue] = input.value.trim(); });
        return { position: Number(select.dataset.day), shift_type_id: select.value ? Number(select.value) : null, field_values };
      });
      await api.put(`/schedule/patterns/${button.dataset.id}/days`, { days });
      dirtyPatternIds.delete(String(button.dataset.id)); // S-03: gespeichert, nichts mehr zu verwerfen
    }
    await load();
    renderPage();
    window.yuvomi?.showToast(button.dataset.action.startsWith('delete') ? t('schedule.deleted') : t('schedule.saved'), 'success');
  } catch (error) {
    window.yuvomi?.showToast(scheduleErrorMessage(error), 'danger');
  }
}

export async function render(container, { user } = {}) {
  root = container;
  currentUserId = user?.id ?? null;
  canManageOthers = user?.role === 'admin';
  await load();
  // S-10: ein ausdruecklicher Tab-Deep-Link (Dashboard-Kachel, Erinnerung,
  // ein gemerkter Browser-Verlaufseintrag) gewinnt IMMER - er ist eine
  // explizite Anfrage, keine geerbte Sitzungsvorgabe. Nur die nackte Wurzel
  // '/schedule' faellt auf die S-07-Datenlage-Vorgabe zurueck (oder, nach dem
  // allerersten Laden, auf die eigene Tab-Wahl der Person - siehe naechster
  // Kommentar).
  const requestedView = scheduleViewFromPath(window.location.pathname);
  if (requestedView) {
    activeView = requestedView;
    initialViewDecided = true;
  } else if (!initialViewDecided) {
    // S-07: die Vorgabe fuer den allerersten Tab dieser Sitzung haengt von der
    // Datenlage ab - "Planung" (Muster/Ausnahmen/Extras) ist ohne einen einzigen
    // Schichttyp eine Sackgasse (jedes Formular dahinter dead-endet in einer
    // leeren Auswahl). Nur beim allerersten Laden entschieden (initialViewDecided),
    // niemals danach - ein spaeterer Besuch soll die eigene Tab-Wahl der Person
    // nicht ueberschreiben (siehe Kommentar an `activeView` oben).
    activeView = state.types.length ? 'patterns' : 'shifts';
    initialViewDecided = true;
  }
  // `statistics`/`overview`/`activeView` sind Modul-globaler Zustand, der eine
  // Client-Route ueberlebt (SPA, kein Reload zwischen zwei Seitenbesuchen) -
  // ein blosses Zuruecksetzen von userId/from/to reichte nicht: `entries`/
  // `bounds`/`holidays` blieben sonst vom LETZTEN Besuch stehen und erschienen
  // unter den frisch zurueckgesetzten Filterwerten, so als gehoerten sie dazu
  // (M-5, z.B. ein anderer Nutzer in der Statistik-Auswahl). `weekCursor`
  // stammte bisher aus `todayKey()` beim MODUL-LADEN (einmalig) statt bei
  // jedem Seitenbesuch - nach Mitternacht zeigte "Heute" so noch den Vortag,
  // bis irgendjemand aktiv auf "Heute" klickte.
  statistics = { ...statistics, userId: currentUserId, monthFrom: monthKey(), monthTo: monthKey(), from: todayKey(), to: todayKey(), entries: [], bounds: null, error: false };
  overview = { ...overview, weekCursor: todayKey(), entries: [], holidays: [], error: false };
  // S-03: `load()` gerade eben hat frische Musterkarten aus dem Server
  // geholt - eine Dirty-Markierung vom letzten Seitenbesuch waere jetzt ein
  // Geisterzustand ohne zugehoerige ungespeicherte DOM-Aenderung.
  dirtyPatternIds = new Set();
  renderShell();
  scheduleFab = createPageFab({ id: 'schedule-fab' });
  root.querySelector('.schedule-page')?.appendChild(scheduleFab);
  // activateView() statt eines blossen renderPage(): fuer 'statistics'/
  // 'overview' raeumt sie den obigen Reset ins Bild UND laedt frisch nach
  // (genau das, was ein Tab-Wechsel ohnehin tut); fuer 'shifts'/'patterns'
  // entspricht sie unveraendert einem einzelnen renderPage().
  await activateView(activeView);
  // S-10: die Adresse auf die konkrete Tab-Route normalisieren - ein Besuch
  // ueber die nackte Wurzel (Seitenleiste, alter Bookmark) zeigt danach genau
  // den Tab, auf dem die Person tatsaechlich steht (Neuladen/Zurueck landen
  // dann direkt dort, statt wieder auf der Wurzel zu entscheiden).
  const resolvedRoute = scheduleRouteForView(activeView);
  if (window.location.pathname !== resolvedRoute) {
    history.replaceState({ path: resolvedRoute }, '', resolvedRoute);
  }
  window.lucide?.createIcons({ el: root });
}

/**
 * S-10: Soft-Navigation zwischen Schedule-Tabs (vom Router aufgerufen, wenn
 * dieses Modul bereits gerendert ist - siehe router.js' SCHEDULE_PAGE_ROUTES).
 * Tauscht nur `.schedule-body` aus (ueber activateView(), dieselbe Funktion
 * wie ein Tab-Klick), kein Full-Reload. Rueckgabe false erzwingt volles
 * Rendern (hier nur, wenn der Container bereits verschwunden ist).
 */
export async function update({ path } = {}) {
  if (!root?.isConnected) return false;
  const requestedView = scheduleViewFromPath(path || window.location.pathname);
  const nextView = requestedView ?? activeView;
  const resolvedRoute = scheduleRouteForView(nextView);
  if (window.location.pathname !== resolvedRoute) {
    history.replaceState({ path: resolvedRoute }, '', resolvedRoute);
  }
  if (nextView !== activeView) {
    // S-03 Restluecke (bewusst offen, siehe PLAN.md): ein Browser-Zurueck ruft
    // diese Funktion ueber popstate direkt auf und umgeht damit
    // guardedActivateView()s Rueckfrage - dieselbe Einschraenkung wie die
    // anderen "load()+renderPage()"-Pfade, die eine offene Zyklustage-
    // Bearbeitung stillschweigend verwerfen wuerden. Volle Abdeckung braeuchte
    // eine Kopplung an handleBackNavigation() (#871) und ist hier bewusst
    // nicht gebaut.
    await activateView(nextView);
  }
  return true;
}

// Reines Verhalten statt Text-Muster (PR #930 review): beide Funktionen sind
// bereits pur bzw. nehmen ihre Eingabe jetzt als Parameter statt sie fest aus
// `state` zu lesen - ein Test kann so echte Tage hineingeben und das Ergebnis
// pruefen, statt nur zu belegen, dass der Funktionsname im Quelltext steht.
export const __test = { overrideGroups, extraGroups, rangeDifference, setShiftIconButtonIcon, overtimeInfo, sameFieldValues, overlayMeta, buildOverviewLanes, normalizeOverviewSelection, computeActiveHours, collapsedMinutes, isOvernightEntry, touchesVisibleDay, overviewFetchRange, patternDaysExceedingCycleLength, scheduleErrorMessage, cycleDayNextDate, cycleDayHeaderLabel, windowsOverlap, findOverlappingActivePattern, resolveWinningPatternId, scheduleEntryMatchKey };
