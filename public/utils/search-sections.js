/**
 * Modul: Trefferarten der globalen Suche (Client)
 * Zweck: EINE Liste, welche Trefferart des Endpunkts GET /api/v1/search in
 *        welcher Reihenfolge, unter welcher Ueberschrift und mit welchem Ziel
 *        erscheint, dazu die Befehlspalette (Orte, Anlege-Aktionen, Markierung
 *        der Fundstelle; Abschnitt unten). Vorher standen die Sektionen als acht Einzelaufrufe
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
 * Die durchsuchten Module: jedes einmal, in der Reihenfolge der Sektionen, und
 * nur die, die der Betrachter hat (`isAvailable(module)`). Bis 2026-09-28 waren
 * das auch die Kacheln im Leerzustand - denen fehlten damit Schichtplan,
 * Haushaltshilfe, Belohnungen und Mahlzeiten (keine Daten in der Suche). Die
 * Kacheln sind jetzt die sichtbaren Navigationsziele (router.js).
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

/* --------------------------------------------------------------------------
 * BEFEHLSPALETTE (Re-Critique 2026-09-28, A1 P2-1/P2-2)
 *
 * ⌘K war eine reine Datensuche, und der Hinweis darueber versprach "alle
 * Bereiche": "Schichtplan" ergab "Keine Ergebnisse", und die Kacheln kannten
 * vier Module nicht. Die Palette fuehrt jetzt zuerst zu ORTEN ("Gehe zu":
 * sichtbare Navigationsziele und Einstellungsblaetter), dann zu HANDLUNGEN
 * ("Neu anlegen": die Primaeraktion eines Moduls), und erst danach zu Daten.
 * Die Orte und Handlungen kennt der Client selbst; sie erscheinen ab dem
 * ersten Zeichen, die Daten ab zweien (Server).
 * -------------------------------------------------------------------------- */

/**
 * Die Module, deren Seite beim Betreten eine Anlege-Aktion als FAB traegt -
 * `labelKey` ist das Nomen, das der FAB angedockt zeigt (`newLabel.*`). Die
 * Palette oeffnet die Seite und loest ihren FAB aus (triggerPageFab), genau
 * wie der Kurzbefehl `n`. Nicht dabei sind die Kontext-FABs, deren Aktion dem
 * Tab folgt (Gesundheit, Haushaltshilfe, Schichtplan) - ihr Nomen staende auf
 * dem Einstiegs-Tab nicht fest.
 * @type {ReadonlyArray<{ module: string, route: string, labelKey: string }>}
 */
export const NEW_ACTIONS = Object.freeze([
  { module: 'tasks', route: '/tasks', labelKey: 'newLabel.tasks' },
  { module: 'calendar', route: '/calendar', labelKey: 'newLabel.calendar' },
  { module: 'notes', route: '/notes', labelKey: 'newLabel.notes' },
  { module: 'shopping', route: '/shopping', labelKey: 'newLabel.shopping' },
  { module: 'meals', route: '/meals', labelKey: 'newLabel.meals' },
  { module: 'recipes', route: '/recipes', labelKey: 'newLabel.recipes' },
  { module: 'pantry', route: '/pantry', labelKey: 'newLabel.pantry' },
  { module: 'contacts', route: '/contacts', labelKey: 'newLabel.contacts' },
  { module: 'birthdays', route: '/birthdays', labelKey: 'newLabel.birthdays' },
  { module: 'documents', route: '/documents', labelKey: 'newLabel.documents' },
  { module: 'inventory', route: '/inventory', labelKey: 'newLabel.inventory' },
  { module: 'budget', route: '/budget', labelKey: 'newLabel.budget' },
  { module: 'waste', route: '/waste', labelKey: 'newLabel.waste' },
  { module: 'rewards', route: '/rewards', labelKey: 'newLabel.rewards' },
]);

/**
 * Die Faltung des Servers (services/search.js foldSearchText): klein, ohne
 * Akzente, ß -> ss. Je Zeichen, damit eine Fundstelle im gefalteten Text auf
 * den Originaltext zurueckfuehrt.
 */
function foldChar(ch) {
  return ch.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ß/g, 'ss');
}

/** Die Woerter der Eingabe, gefaltet - wie der Server sie sieht. */
export function paletteTokens(query) {
  return String(query ?? '')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_]+/gu, ''))
    .filter(Boolean)
    .map((w) => [...w].map(foldChar).join(''))
    .filter(Boolean);
}

/** Trifft die Eingabe diesen Text? Jedes Wort muss darin stehen (UND). */
export function paletteMatches(query, ...texts) {
  const tokens = paletteTokens(query);
  if (!tokens.length) return false;
  const hay = [...texts.filter(Boolean).join(' ')].map(foldChar).join('');
  return tokens.every((tok) => hay.includes(tok));
}

/**
 * Zerlegt `text` in Stuecke, markiert, wo ein Suchwort steht - ueber dieselbe
 * Faltung wie der Server, also findet "muller" das "Müller" und markiert es im
 * Original. Ueberlappende Fundstellen verschmelzen.
 * @param {string} text
 * @param {string} query
 * @returns {Array<{ text: string, mark: boolean }>}
 */
export function markSegments(text, query) {
  const source = String(text ?? '');
  const tokens = paletteTokens(query);
  if (!source || !tokens.length) return source ? [{ text: source, mark: false }] : [];
  let folded = '';
  const map = [];
  let offset = 0;
  for (const ch of source) {
    const f = foldChar(ch);
    for (let i = 0; i < f.length; i += 1) map.push(offset);
    folded += f;
    offset += ch.length;
  }
  map.push(offset);
  const ranges = [];
  for (const tok of tokens) {
    for (let at = folded.indexOf(tok); at >= 0; at = folded.indexOf(tok, at + 1)) {
      ranges.push([map[at], map[at + tok.length]]);
    }
  }
  if (!ranges.length) return [{ text: source, mark: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0].slice()];
  for (const [from, to] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  const out = [];
  let cursor = 0;
  for (const [from, to] of merged) {
    if (from > cursor) out.push({ text: source.slice(cursor, from), mark: false });
    out.push({ text: source.slice(from, to), mark: true });
    cursor = to;
  }
  if (cursor < source.length) out.push({ text: source.slice(cursor), mark: false });
  return out;
}

/**
 * Die Orte und Handlungen zu einer Eingabe - ohne Server, sofort.
 *
 * @param {string} query
 * @param {object} input
 * @param {Array<{ label: string, route: string, module: string, icon?: string }>} input.places
 *        sichtbare Navigationsziele (router.js navItems)
 * @param {Array<{ label: string, route: string, context?: string }>} [input.settings]
 *        Treffer aus der Einstellungssuche (settings/registry.js searchSettings)
 * @param {Array<{ label: string, route: string, module: string, context?: string }>} [input.actions]
 *        die Anlege-Aktionen, die der Betrachter ausfuehren darf
 * @param {Array<{ label: string, run: Function }>} [input.commands]
 *        Befehle ohne eigene Seite - Hilfe, Tastenkombinationen, Neuigkeiten
 *        (R14, A1 P3-6: am Desktop lagen sie nur hinter dem Avatar). Sie
 *        stehen mit den Orten unter "Gehe zu", weil sie wie ein Ort an EINE
 *        Stelle fuehren; `run` statt `route`.
 * @param {number} [input.cap=6] hoechstens so viele je Abschnitt
 * @returns {{ places: object[], actions: object[] }}
 */
export function paletteCommands(query, { places = [], settings = [], actions = [], commands = [], cap = 6 } = {}) {
  if (!paletteTokens(query).length) return { places: [], actions: [] };
  const hitPlaces = [...places, ...commands].filter((p) => paletteMatches(query, p.label));
  // Nur Einstellungen, deren NAME passt: die Einstellungssuche trifft auch
  // Beschreibungen, und ein Treffer ohne sichtbaren Grund ("sch" -> "Budget")
  // ist genau das, was die Markierung abschaffen soll.
  const hitSettings = settings.filter((s) => paletteMatches(query, s.label))
    .slice(0, Math.max(0, cap - hitPlaces.length));
  const hitActions = actions.filter((a) => paletteMatches(query, a.label, a.context, a.verb));
  return {
    places: [...hitPlaces, ...hitSettings].slice(0, cap),
    actions: hitActions.slice(0, cap),
  };
}
