/**
 * Modul: Trefferarten der globalen Suche (Client)
 * Zweck: EINE Liste, welche Trefferart des Endpunkts GET /api/v1/search in
 *        welcher Reihenfolge, unter welcher Ueberschrift und mit welchem Ziel
 *        erscheint - samt der Modul-Kacheln im Leerzustand, die daraus
 *        abgeleitet sind. Vorher standen die Sektionen als acht Einzelaufrufe
 *        in router.js und die Kacheln als zweite, von Hand gepflegte Liste
 *        daneben; die Kacheln kannten die Entsorgung nicht, obwohl die Suche
 *        sie seit #1063 durchsuchte.
 * Abhaengigkeiten: keine - Uebersetzung und Datumsformat kommen als Helfer
 *        herein, damit test:search-permissions die Liste gegen die Antwort des
 *        Servers pruefen kann (dieselben Schluessel, keiner zu viel oder zu
 *        wenig).
 *
 * Ein Ziel ohne `?open=` fuehrt auf die Modulseite: Dokumente, Vorrat,
 * Geburtstage und Budget kennen (Stand 2026-09-27) keinen Tiefenlink auf einen
 * einzelnen Eintrag.
 */

/**
 * @typedef {object} SearchSection
 * @property {string} bucket    Schluessel in der Antwort des Servers
 * @property {string} labelKey  Ueberschrift (i18n)
 * @property {string} module    Navigations-Modul: Siegel, Kachel, Sichtbarkeit
 * @property {(item: object) => string} route
 * @property {(item: object, fmt: object) => string} [label]
 * @property {(item: object, fmt: object) => string} [meta]
 */

const dateMeta = (field) => (item, fmt) => (item[field] ? fmt.formatDate(item[field]) : '');

/** @type {ReadonlyArray<SearchSection>} */
export const SEARCH_SECTIONS = Object.freeze([
  { bucket: 'tasks', labelKey: 'nav.tasks', module: 'tasks',
    route: (i) => `/tasks?open=${i.id}`, meta: dateMeta('due_date') },
  { bucket: 'events', labelKey: 'nav.calendar', module: 'calendar',
    route: (i) => `/calendar?open=${i.id}`,
    meta: (i, fmt) => (i.start_datetime
      ? `${fmt.formatDate(i.start_datetime)}${i.all_day ? '' : ` · ${fmt.formatTime(i.start_datetime)}`}`
      : '') },
  { bucket: 'notes', labelKey: 'nav.notes', module: 'notes', route: (i) => `/notes?open=${i.id}` },
  { bucket: 'contacts', labelKey: 'nav.contacts', module: 'contacts', route: (i) => `/contacts?open=${i.id}` },
  { bucket: 'items', labelKey: 'nav.shopping', module: 'shopping',
    route: (i) => `/shopping?list=${i.list_id}&highlight=${i.id}` },
  { bucket: 'recipes', labelKey: 'nav.recipes', module: 'recipes', route: (i) => `/recipes?open=${i.id}` },
  { bucket: 'pantry', labelKey: 'nav.pantry', module: 'pantry', route: () => '/pantry', meta: dateMeta('expires_on') },
  { bucket: 'meds', labelKey: 'health.tabs.meds', module: 'health',
    route: () => '/health/meds', meta: (i) => i.dosage_text || '' },
  { bucket: 'activities', labelKey: 'health.tabs.activity', module: 'health',
    route: () => '/health/activity', label: (i, fmt) => fmt.activityLabel(i), meta: dateMeta('performed_at') },
  { bucket: 'documents', labelKey: 'nav.documents', module: 'documents', route: () => '/documents' },
  { bucket: 'inventory', labelKey: 'nav.inventory', module: 'inventory',
    route: (i) => `/inventory?open=${i.id}`, meta: (i) => [i.brand, i.model].filter(Boolean).join(' ') },
  { bucket: 'birthdays', labelKey: 'nav.birthdays', module: 'birthdays', route: () => '/birthdays' },
  { bucket: 'budget', labelKey: 'nav.budget', module: 'budget', route: () => '/budget?tab=budget', meta: dateMeta('date') },
  { bucket: 'waste', labelKey: 'nav.waste', module: 'waste', route: (i) => `/waste?type=${i.id}` },
]);

/**
 * Die Modul-Kacheln im Leerzustand: jedes durchsuchte Modul einmal, in der
 * Reihenfolge der Sektionen, und nur die, die der Betrachter in der Navigation
 * hat (`isAvailable(module)` - abgeschaltet oder gesperrt faellt heraus).
 * @param {(module: string) => boolean} [isAvailable]
 * @returns {string[]} Navigations-Module
 */
export function searchScopeModules(isAvailable = () => true) {
  return [...new Set(SEARCH_SECTIONS.map((s) => s.module))].filter((m) => isAvailable(m));
}

/** Alle Treffer einer Antwort gezaehlt - ueber die Liste, nicht ueber eine zweite Aufzaehlung. */
export function searchResultCount(data) {
  return SEARCH_SECTIONS.reduce((sum, s) => sum + (Array.isArray(data?.[s.bucket]) ? data[s.bucket].length : 0), 0);
}
