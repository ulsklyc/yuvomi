/**
 * Modul: Waste collection - Kalenderprojektion (#1063 Phase 5)
 * Zweck: die Waste-Ebene im Kalender - der geraetelokale Ebenen-Schalter
 *        (availableLayers/activeFilterCount/Reset, wie holidays/schedule/
 *        birthdays), der eigenstaendige Bereichs-Fetch (loadWasteRange, mit
 *        eigenem Fehlerzustand statt eines mit events/tasks/holidays/schedule
 *        geteilten), das Personenfilter-Ausnehmen (haushaltsweit, wie
 *        Feiertage), und die Darstellung/Klick-Verdrahtung je echtem
 *        Ansichts-Aufrufer (Monat/Woche/Tag/Agenda) - ein Klick fuehrt direkt
 *        in die Waste-Seite, nie in den Termin-Editor.
 *
 *        Folgt demselben bespoke test()/assert()-Muster wie test-calendar.js
 *        (nicht node:test), weil dieselben __test-Exporte, denselben
 *        fakeContainer()/globalThis.window-Swap und dieselbe
 *        renderWeekView()/renderDayView()-Aufrufer-Konvention wiederverwendet
 *        werden. Der Loader-Stub von /i18n.js echoet t('key', values) als
 *        "key" + JSON.stringify(values) - Assertions pruefen also gegen diese
 *        vorhersagbare Form, nicht gegen echten Uebersetzungstext.
 * Ausführen: node --loader ./test/test-browser-loader.mjs test/test-waste-calendar.js
 */

import { readFileSync } from 'node:fs';
const { __test: calendarHelpers } = await import('../public/pages/calendar.js');
const permissions = await import('../public/permissions.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

const src = () => readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');

// -------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------

function occurrence(overrides = {}) {
  return {
    key: '1:2026-09-10', date_key: '2026-09-10', type_id: 1,
    type_name: 'Bioabfall', type_icon: 'trash-2', type_color: '#4CAF50',
    type_sort_order: 0, moved: false, coalesced: false,
    origins: [{ kind: 'schedule', schedule_id: 1, original_date: null, moved: false }],
    deep_link: '?type=1&date=2026-09-10',
    ...overrides,
  };
}

/** Ein Klick-Ziel, das nur den angegebenen Selektor(en) "ist" - alles andere
 *  liefert closest() als null, wie ein echtes DOM-Element ausserhalb des
 *  passenden Vorfahren. */
function fakeClickTarget(matches = [], dataset = {}) {
  return {
    dataset,
    closest(selector) { return matches.includes(selector) ? this : null; },
  };
}

/** Ein Container, der (anders als ein reines HTML-Sammelbecken) registrierte
 *  Click-/Keydown-Handler je Selektor festhaelt, damit ein Test sie mit einem
 *  synthetischen Event tatsaechlich AUSLOESEN kann - die einzige Weise, den
 *  echten Delegations-Code in renderWeekView()/renderDayView()/
 *  renderMonthView()/renderAgendaView() zu pruefen, statt nur ihre
 *  HTML-Ausgabe. */
function listenerContainer() {
  let html = '';
  const listeners = new Map();
  const elFor = (selector) => ({
    addEventListener: (evt, handler) => listeners.set(`${selector}::${evt}`, handler),
    getBoundingClientRect: () => ({ height: 1440 }),
    scrollTop: 0,
    observe() {}, disconnect() {},
  });
  return {
    replaceChildren: () => { html = ''; },
    insertAdjacentHTML: (_pos, chunk) => { html += chunk; },
    querySelector: (selector) => elFor(selector),
    querySelectorAll: () => [],
    get html() { return html; },
    fire(selector, evt, event) {
      const handler = listeners.get(`${selector}::${evt}`);
      if (!handler) throw new Error(`kein Listener fuer ${selector}::${evt} registriert`);
      handler(event);
    },
  };
}

class FakeResizeObserver {
  constructor(cb) { this.cb = cb; }
  observe() {}
  disconnect() {}
}

/** Fuehrt fn() mit einem sauberen state/window/ResizeObserver-Fixture aus und
 *  stellt beides hinterher wieder her - wie withOverlappingScheduleState() in
 *  test-calendar.js. */
function withWasteViewState(extra, windowExtra, fn) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousWindow = globalThis.window;
  const hadRO = Object.prototype.hasOwnProperty.call(globalThis, 'ResizeObserver');
  const previousRO = globalThis.ResizeObserver;
  const previousState = { ...calendarHelpers.state };
  const navigated = [];
  try {
    globalThis.ResizeObserver = FakeResizeObserver;
    globalThis.window = {
      matchMedia: () => ({ matches: false }),
      yuvomi: { navigate: (path) => navigated.push(path), isModuleDisabled: () => false },
      ...windowExtra,
    };
    Object.assign(calendarHelpers.state, {
      cursor: '2026-09-10',
      today: '2026-09-10',
      weekStart: 1,
      layerSchedule: true,
      layerWaste: true,
      layerHolidays: true,
      layerBirthdays: true,
      assignedToMe: false,
      people: new Set(),
      events: [],
      tasks: [],
      holidays: [],
      users: [],
      scheduleEntries: [],
      wasteOccurrences: [],
      ...extra,
    });
    fn(navigated);
  } finally {
    Object.assign(calendarHelpers.state, previousState);
    if (hadWindow) globalThis.window = previousWindow; else delete globalThis.window;
    if (hadRO) globalThis.ResizeObserver = previousRO; else delete globalThis.ResizeObserver;
  }
}

// -------------------------------------------------------------------------
// wasteOccurrencesOnDay(): Ebene, kein Personenfilter (#1054-Muster)
// -------------------------------------------------------------------------

test('wasteOccurrencesOnDay(): filtert nach Tag und respektiert allein layerWaste', () => {
  withWasteViewState({
    wasteOccurrences: [occurrence(), occurrence({ key: '2:2026-09-11', date_key: '2026-09-11', type_id: 2 })],
  }, {}, () => {
    assert(calendarHelpers.wasteOccurrencesOnDay('2026-09-10').length === 1, 'nur der Tag muss zaehlen');
    calendarHelpers.state.layerWaste = false;
    assert(calendarHelpers.wasteOccurrencesOnDay('2026-09-10').length === 0, 'layerWaste=false muss die Ebene komplett verbergen');
  });
});

test('wasteOccurrencesOnDay(): UNBEEINFLUSST vom Personenfilter und "Mir zugewiesen" - Waste ist haushaltsweit (#1054)', () => {
  withWasteViewState({
    wasteOccurrences: [occurrence()],
    users: [{ id: 1 }, { id: 2 }],
    currentUserId: 2,
  }, {}, () => {
    calendarHelpers.state.people = new Set([1]);
    assert(calendarHelpers.wasteOccurrencesOnDay('2026-09-10').length === 1,
      'eine Waste-Abholung gehoert niemandem einzeln - der Personenfilter darf sie nicht wegnehmen');
    calendarHelpers.state.people = new Set();
    calendarHelpers.state.assignedToMe = true;
    assert(calendarHelpers.wasteOccurrencesOnDay('2026-09-10').length === 1,
      '"Mir zugewiesen" darf Waste ebenfalls nicht filtern');
  });
});

// -------------------------------------------------------------------------
// wasteEnabled(): Modul-Abschaltung UND Leserechte (staerker als scheduleEnabled)
// -------------------------------------------------------------------------

test('wasteEnabled(): false, wenn das Modul abgeschaltet ist', () => {
  withWasteViewState({}, { yuvomi: { isModuleDisabled: () => true, navigate: () => {} } }, () => {
    assert(calendarHelpers.wasteEnabled() === false);
  });
});

test('wasteEnabled(): false, wenn das Modul zwar an, aber ohne Leserechte ist (moduleAccess=none)', () => {
  const saved = permissions.getPermissions();
  try {
    permissions.setPermissions({ admin: false, modules: { waste: 'none' }, widgets: {} });
    withWasteViewState({}, {}, () => {
      assert(calendarHelpers.wasteEnabled() === false,
        'PLAN.md Phase 5 verlangt "enabled AND readable" - staerker als scheduleEnabled(), das nur die Abschaltung prueft');
    });
  } finally {
    permissions.setPermissions(saved);
  }
});

test('wasteEnabled(): true, wenn eingeschaltet und lesbar (Standard ohne geladene Rechte: fail-open)', () => {
  withWasteViewState({}, {}, () => {
    assert(calendarHelpers.wasteEnabled() === true);
  });
});

// -------------------------------------------------------------------------
// activeFilterCount() / availableLayers(): dieselbe Ebenen-Buchhaltung wie
// holidays/school/schedule/birthdays
// -------------------------------------------------------------------------

test('activeFilterCount(): zaehlt eine abgeschaltete Waste-Ebene nur, wenn das Modul ueberhaupt lesbar ist', () => {
  withWasteViewState({ layerWaste: false, layerBirthdays: true, holidayPrefs: {} }, {}, () => {
    const withAccess = calendarHelpers.activeFilterCount();
    assert(withAccess === 1, `layerWaste=false bei lesbarem Modul muss zaehlen: ${withAccess}`);
  });
  withWasteViewState(
    { layerWaste: false, layerBirthdays: true, holidayPrefs: {} },
    { yuvomi: { isModuleDisabled: () => true, navigate: () => {} } },
    () => {
      const withoutAccess = calendarHelpers.activeFilterCount();
      assert(withoutAccess === 0, `ein abgeschaltetes Modul darf keinen Filter zaehlen, den niemand umschalten kann: ${withoutAccess}`);
    },
  );
});

test('availableLayers(): enthaelt die waste-Zeile nur, wenn wasteEnabled() true ist', () => {
  withWasteViewState({ layerWaste: true, holidayPrefs: {} }, {}, () => {
    const rows = calendarHelpers.availableLayers();
    const row = rows.find((r) => r.key === 'waste');
    assert(row, 'die waste-Zeile fehlt, obwohl das Modul lesbar ist');
    assert(row.checked === true && row.color === null,
      'wie die schedule-Zeile traegt waste keinen Farbfleck (gemischte Typfarben, keine Legende)');
  });
  withWasteViewState(
    { holidayPrefs: {} },
    { yuvomi: { isModuleDisabled: () => true, navigate: () => {} } },
    () => {
      const rows = calendarHelpers.availableLayers();
      assert(!rows.find((r) => r.key === 'waste'), 'ein abgeschaltetes Modul darf keine Schalterzeile anbieten');
    },
  );
});

// -------------------------------------------------------------------------
// Verdrahtung, die sich nicht ohne echtes Modal-DOM aufrufen laesst
// (Filter-Blatt LAYER_STATE + Reset, loadRange()s eigenstaendiger Waste-Fetch) -
// wie test-waste-dashboard.js's Quelltext-Verdrahtungspruefungen.
// -------------------------------------------------------------------------

test('PLAN.md Phase 0: die Waste-Ebene startet AUS (Erststand UND localStorage-Wiederherstellung), anders als holidays/school/schedule/birthdays', () => {
  const text = src();
  const stateLiteralStart = text.indexOf('layerWaste:');
  assert(/layerWaste:\s*false,/.test(text.slice(stateLiteralStart, stateLiteralStart + 30)),
    'der Erststand von state.layerWaste muss false sein, wie DEFAULT_HIDDEN_WIDGETS es fuer das Dashboard-Widget bereits vorgibt');
  const restoreIdx = text.indexOf('localStorage.getItem(LAYER_WASTE_KEY)');
  const restoreLine = text.slice(restoreIdx, restoreIdx + 80);
  assert(/localStorage\.getItem\(LAYER_WASTE_KEY\)\s*===\s*'true'/.test(restoreLine),
    "die Wiederherstellung muss Opt-in sein (=== 'true'), nicht Opt-out (!== 'false') wie holidays/school/schedule/birthdays");
});

test('openCalendarFilters(): LAYER_STATE kennt waste, wie holidays/school/schedule/birthdays', () => {
  const text = src();
  const block = text.slice(text.indexOf('const LAYER_STATE ='), text.indexOf('const LAYER_STATE =') + 400);
  assert(
    /waste:\s*\['layerWaste',\s*LAYER_WASTE_KEY\]/.test(block),
    'LAYER_STATE muss waste auf state.layerWaste/LAYER_WASTE_KEY abbilden, sonst aendert die Checkbox im Blatt nichts',
  );
});

test('openCalendarFilters(): der Reset-Knopf setzt layerWaste auf SEINE EIGENE Vorgabe (aus) zurueck, nicht auf "an" wie die uebrigen Ebenen', () => {
  const text = src();
  const start = text.indexOf("#cal-filters-reset')?.addEventListener('click'");
  const block = text.slice(start, start + 900);
  assert(/state\.layerWaste = false;/.test(block),
    'Reset heisst "auf die Vorgabe zurueck" - PLAN.md Phase 0 legt die Waste-Ebenen-Vorgabe ausdruecklich auf AUS fest, anders als holidays/school/schedule/birthdays');
  assert(/localStorage\.setItem\(LAYER_WASTE_KEY, 'false'\);/.test(block), 'Reset muss den Waste-Schluessel im localStorage auf false zuruecksetzen');
});

test('loadRange(): der Waste-Fetch laeuft eigenstaendig (eigener Fehlerzustand statt eines mit events/tasks/holidays/schedule geteilten)', () => {
  const text = src();
  const fnStart = text.indexOf('async function loadRange(from, to)');
  const fnBody = text.slice(fnStart, text.indexOf('\nasync function openTaskFromCalendar'));
  assert(/const wastePromise = loadWasteRange\(from, to\);/.test(fnBody),
    'loadRange() muss loadWasteRange() parallel zum Haupt-Koordinator anstossen');
  assert(/await wastePromise;/.test(fnBody),
    'loadRange() muss auf den Waste-Fetch warten, sonst sehen Aufrufer wie render()/reloadForView() eine unvollstaendige Waste-Ebene');
});

test('loadWasteRange(): loest keinen Request aus, wenn wasteEnabled() false ist, und setzt statt eines Fehlers eine leere Liste', () => {
  const text = src();
  const fnStart = text.indexOf('async function loadWasteRange(from, to)');
  const fnBody = text.slice(fnStart, fnStart + 1000);
  assert(/if \(!wasteEnabled\(\)\) \{/.test(fnBody), 'ein abgeschaltetes/ungelesenes Modul darf keinen Request ausloesen');
  assert(/state\.wasteLoadError = err;/.test(fnBody),
    'ein echter Ladefehler muss state.wasteLoadError setzen - unabhaengig von state.loadError (#1063 Phase 5: "distinguish Waste load failure from no Waste pickups")');
});

// -------------------------------------------------------------------------
// renderWasteChip(): Icon+Text immer zusammen (Farbe ist Dekoration), moved/
// coalesced-Flags, Deep-Link-Datenattribut
// -------------------------------------------------------------------------

test('renderWasteChip(): traegt Icon UND Typname zusammen - Farbe ist nie der einzige Identitaetstraeger', () => {
  const html = calendarHelpers.renderWasteChip(occurrence());
  assert(html.includes('data-lucide="trash-2"'), 'das Typ-Icon muss stehen');
  assert(html.includes('Bioabfall'), 'der Typname muss als Text stehen, nicht nur als Farbe');
  assert(html.includes('--holi-color:#4CAF50'), 'die Farbe traegt trotzdem als Akzent, ueber dasselbe --holi-color-Rezept wie Feiertag/Schichtplan');
});

test('renderWasteChip(): icon:false (Monatsansicht-Kanon) laesst das Icon weg, behaelt aber den Text', () => {
  const html = calendarHelpers.renderWasteChip(occurrence(), { icon: false });
  assert(!html.includes('data-lucide="trash-2"'), 'im Monatsraster bleiben Chips text-only, wie Feiertag/Schichtplan');
  assert(html.includes('Bioabfall'));
});

test('renderWasteChip(): data-deep-link uebernimmt den Server-Fragment-Vertrag unveraendert', () => {
  const html = calendarHelpers.renderWasteChip(occurrence({ deep_link: '?type=1&date=2026-09-10' }));
  assert(html.includes('data-deep-link="?type=1&amp;date=2026-09-10"'),
    'der Deep-Link muss aus der Server-Antwort uebernommen werden, nie neu zusammengesetzt');
});

test('renderWasteChip(): ein verschobener Termin zeigt das Verschoben-Flag mit dem urspruenglichen Datum', () => {
  const html = calendarHelpers.renderWasteChip(occurrence({
    moved: true,
    origins: [{ kind: 'schedule', schedule_id: 1, original_date: '2026-09-05', moved: true }],
  }));
  assert(html.includes('data-lucide="move"'), 'ein verschobener Termin braucht das Verschoben-Icon, wie die Dashboard-Kachel');
  assert(html.includes('waste.movedFromBadge{&quot;date&quot;:&quot;2026-09-05&quot;}'),
    'die aria-label muss das urspruengliche Datum nennen');
});

test('renderWasteChip(): ein coalesced Termin zeigt das Mehrfach-Herkunft-Flag', () => {
  const html = calendarHelpers.renderWasteChip(occurrence({ coalesced: true }));
  assert(html.includes('data-lucide="layers"'), 'ein coalesced Termin braucht das Mehrfach-Herkunft-Icon');
  assert(html.includes('waste.coalescedHint'), 'die aria-label muss den Hinweistext tragen');
});

test('renderWasteChip(): interactive:true (Agenda) traegt role=button/tabindex und ein aria-label mit Typ+Datum', () => {
  const html = calendarHelpers.renderWasteChip(occurrence(), { interactive: true });
  assert(html.includes('role="button"') && html.includes('tabindex="0"'), 'Agenda-Zeilen brauchen einen eigenen Tab-Stopp, wie renderAgendaEvent()');
  assert(html.includes('aria-label="Bioabfall,'), 'die aria-label muss Typname und Datum nennen');
});

test('renderWasteChip(): interactive:false (Monat/Woche/Tag) traegt kein role/tabindex - der Chip ist reines Klickziel ohne Tab-Stopp', () => {
  const html = calendarHelpers.renderWasteChip(occurrence());
  assert(!html.includes('role="button"'), 'wie .month-day__event/.schedule-entry bleibt der Chip ausserhalb der Agenda ohne eigenen Tab-Stopp');
});

// -------------------------------------------------------------------------
// Echte Ansichts-Aufrufer: Rendering + Klick-Delegation (nie der Termin-Editor)
// -------------------------------------------------------------------------

test('renderMonthView: eine Waste-Abholung erscheint als Balken in der Tageszelle', () => {
  withWasteViewState({ wasteOccurrences: [occurrence()] }, {}, () => {
    const container = listenerContainer();
    calendarHelpers.renderMonthView(container);
    assert(container.html.includes('waste-occurrence-chip'), 'die Zelle des 10.9. muss den Waste-Chip zeigen');
    assert(container.html.includes('data-deep-link="?type=1&amp;date=2026-09-10"'));
  });
});

test('renderMonthView: Klick (Desktop) auf den Waste-Chip navigiert direkt und fuehrt NICHT in switchToDayView', () => {
  withWasteViewState({ wasteOccurrences: [occurrence()] }, {}, (navigated) => {
    const container = listenerContainer();
    calendarHelpers.renderMonthView(container);
    // Der Klick muss AUCH die '.month-day'-Zelle treffen (closest() faellt sonst
    // schon an der ersten Zeile des Handlers ("if (!dayEl) return;") heraus, wie
    // bei einem echten DOM-Element, dessen Chip innerhalb der Zelle liegt).
    const target = fakeClickTarget(['.waste-occurrence-chip', '.month-day'], { deepLink: '?type=1&date=2026-09-10' });
    container.fire('#month-grid', 'click', { target, stopPropagation() {} });
    assert(navigated.length === 1 && navigated[0] === '/waste?type=1&date=2026-09-10',
      `der Klick muss window.yuvomi.navigate('/waste?type=1&date=2026-09-10') ausloesen: ${JSON.stringify(navigated)}`);
    assert(calendarHelpers.state.view !== 'day',
      'ein Waste-Chip-Klick darf switchToDayView() nicht durchfallen lassen - state.view aendert sich synchron am Anfang von switchToDayView()');
  });
});

test('renderWeekView: die Ganztagszeile zeigt den Waste-Chip fuer den richtigen Tag, und ein Klick darauf navigiert', () => {
  withWasteViewState({ wasteOccurrences: [occurrence()] }, {}, (navigated) => {
    const container = listenerContainer();
    calendarHelpers.renderWeekView(container);
    assert(container.html.includes('waste-occurrence-chip'), 'die Woche vom 10.9. muss den Chip zeigen');

    const target = fakeClickTarget(['.waste-occurrence-chip'], { deepLink: '?type=1&date=2026-09-10' });
    container.fire('.allday-row', 'click', { target });
    assert(navigated.length === 1 && navigated[0] === '/waste?type=1&date=2026-09-10',
      `der Klick auf die Ganztagszeile muss navigieren, nie openEventDetail() erreichen: ${JSON.stringify(navigated)}`);
  });
});

test('renderDayView: die Ganztagszeile zeigt den Waste-Chip, und ein Klick darauf navigiert statt den Termin-Editor zu oeffnen', () => {
  withWasteViewState({ wasteOccurrences: [occurrence()] }, {}, (navigated) => {
    const container = listenerContainer();
    calendarHelpers.renderDayView(container);
    assert(container.html.includes('waste-occurrence-chip'));

    const target = fakeClickTarget(['.waste-occurrence-chip'], { deepLink: '?type=1&date=2026-09-10' });
    container.fire('.allday-row', 'click', { target });
    assert(navigated.length === 1 && navigated[0] === '/waste?type=1&date=2026-09-10');
  });
});

test('renderAgendaView: ein Tag MIT NUR einer Waste-Abholung (keine Termine/Aufgaben/Feiertage/Schichtplan) bekommt trotzdem seine eigene Gruppe', () => {
  withWasteViewState({ wasteOccurrences: [occurrence()] }, {}, () => {
    const container = listenerContainer();
    calendarHelpers.renderAgendaView(container);
    assert(container.html.includes('waste-occurrence-chip'),
      'ohne diesen Fall in groups.filter() wuerde ein reiner Waste-Tag als "kein Eintrag" stillschweigend uebersprungen');
  });
});

test('renderAgendaView: Klick auf den Waste-Chip navigiert direkt (nie openEventDetail)', () => {
  withWasteViewState({ wasteOccurrences: [occurrence()] }, {}, (navigated) => {
    const container = listenerContainer();
    calendarHelpers.renderAgendaView(container);
    const target = fakeClickTarget(['.waste-occurrence-chip'], { deepLink: '?type=1&date=2026-09-10' });
    container.fire('#agenda-view', 'click', { target });
    assert(navigated.length === 1 && navigated[0] === '/waste?type=1&date=2026-09-10');
  });
});

test('renderAgendaView: Enter auf dem fokussierten Waste-Chip (Tastatur) navigiert ebenfalls', () => {
  withWasteViewState({ wasteOccurrences: [occurrence()] }, {}, (navigated) => {
    const container = listenerContainer();
    calendarHelpers.renderAgendaView(container);
    const target = fakeClickTarget(['.waste-occurrence-chip'], { deepLink: '?type=1&date=2026-09-10' });
    container.fire('#agenda-view', 'keydown', { key: 'Enter', target, preventDefault() {} });
    assert(navigated.length === 1 && navigated[0] === '/waste?type=1&date=2026-09-10',
      'die Agenda verspricht Tastaturaktivierung fuer jede role=button-Zeile - der Waste-Chip muss dieselbe Zusage einloesen');
  });
});

// -------------------------------------------------------------------------
// Per-Typ-Sichtbarkeit unter der EINEN Waste-Ebene (#1063 Phase 10)
// -------------------------------------------------------------------------

test('wasteTypeOptions(): ein Eintrag je distinktem Typ, aus den geladenen Vorkommen selbst abgeleitet, alphabetisch', () => {
  withWasteViewState({
    wasteOccurrences: [
      occurrence({ type_id: 2, type_name: 'Restmüll', type_color: '#333', date_key: '2026-09-11' }),
      occurrence({ type_id: 1, type_name: 'Bioabfall', type_color: '#4CAF50', date_key: '2026-09-10' }),
      occurrence({ type_id: 1, type_name: 'Bioabfall', type_color: '#4CAF50', date_key: '2026-09-17' }),
    ],
  }, {}, () => {
    const options = calendarHelpers.wasteTypeOptions();
    assert(options.length === 2, `zwei distinkte Typen erwartet, erhalten ${options.length}`);
    assert(options[0].name === 'Bioabfall' && options[1].name === 'Restmüll', 'alphabetisch sortiert');
    assert(options[0].id === 1 && options[0].color === '#4CAF50');
  });
});

test('passesWasteTypeFilter(): leeres Set heisst ALLE, ein nicht-leeres Set laesst nur seine eigenen Typen durch', () => {
  withWasteViewState({ wasteVisibleTypeIds: new Set() }, {}, () => {
    assert(calendarHelpers.passesWasteTypeFilter(occurrence({ type_id: 1 })) === true, 'leeres Set = alle');
    assert(calendarHelpers.passesWasteTypeFilter(occurrence({ type_id: 999 })) === true, 'leeres Set = alle, auch fuer unbekannte Typen');
  });
  withWasteViewState({ wasteVisibleTypeIds: new Set([1]) }, {}, () => {
    assert(calendarHelpers.passesWasteTypeFilter(occurrence({ type_id: 1 })) === true, 'eigener Typ bleibt sichtbar');
    assert(calendarHelpers.passesWasteTypeFilter(occurrence({ type_id: 2 })) === false, 'ein anderer Typ wird ausgefiltert');
  });
});

test('wasteOccurrencesOnDay(): der Typfilter wirkt zusaetzlich zur Ebene und zum Tag', () => {
  withWasteViewState({
    layerWaste: true,
    wasteVisibleTypeIds: new Set([1]),
    wasteOccurrences: [
      occurrence({ type_id: 1, date_key: '2026-09-10' }),
      occurrence({ type_id: 2, date_key: '2026-09-10' }),
    ],
  }, {}, () => {
    const rows = calendarHelpers.wasteOccurrencesOnDay('2026-09-10');
    assert(rows.length === 1 && rows[0].type_id === 1, 'nur der ausgewaehlte Typ bleibt sichtbar');
  });
});

test('restoreWasteTypeFilter(): parst eine gueltige Liste, faellt bei kaputtem/atypischem JSON auf ein leeres Set zurueck', () => {
  const hadLS = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const previousLS = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem: () => '[1, 2, "3"]' };
    const valid = calendarHelpers.restoreWasteTypeFilter();
    assert(valid.size === 3 && valid.has(1) && valid.has(2) && valid.has(3), 'Zahlen und numerische Strings landen im Set');

    globalThis.localStorage = { getItem: () => '{"not":"an array"}' };
    assert(calendarHelpers.restoreWasteTypeFilter().size === 0, 'kein Array -> leeres Set');

    globalThis.localStorage = { getItem: () => 'not json at all' };
    assert(calendarHelpers.restoreWasteTypeFilter().size === 0, 'kaputtes JSON -> leeres Set, kein Wurf nach aussen');

    globalThis.localStorage = { getItem: () => null };
    assert(calendarHelpers.restoreWasteTypeFilter().size === 0, 'nichts gespeichert -> leeres Set');
  } finally {
    if (hadLS) globalThis.localStorage = previousLS; else delete globalThis.localStorage;
  }
});

test('buildLayerRowsHtml(): die Waste-Zeile traegt eine eingerueckte Typ-Unterliste nur, solange ihre Ebene AN ist', () => {
  withWasteViewState({
    layerWaste: true,
    holidayPrefs: {},
    wasteOccurrences: [occurrence({ type_id: 1, type_name: 'Bioabfall' })],
  }, {}, () => {
    const html = calendarHelpers.buildLayerRowsHtml(calendarHelpers.availableLayers());
    assert(html.includes('cal-filters__nested'), 'die Unterliste muss erscheinen, solange layerWaste an ist');
    assert(html.includes('data-filter-waste-type="1"'), 'die Unterzeile traegt die Typ-Id als data-Attribut');
  });
  withWasteViewState({
    layerWaste: false,
    holidayPrefs: {},
    wasteOccurrences: [occurrence({ type_id: 1, type_name: 'Bioabfall' })],
  }, {}, () => {
    const html = calendarHelpers.buildLayerRowsHtml(calendarHelpers.availableLayers());
    assert(!html.includes('cal-filters__nested'), 'die Unterliste darf nicht erscheinen, solange die Ebene aus ist');
  });
});

// -------------------------------------------------------------------------
// Ergebnis
// -------------------------------------------------------------------------
console.log(`\n[Waste-Calendar-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
