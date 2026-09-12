/**
 * Modul: Waste collection page (#1063 Phase 2)
 * Zweck: pure UI-logic exported from public/pages/waste.js via __test - the
 *        deep-link contract (?type=<id>&date=<YYYY-MM-DD>), the schedule
 *        origin lookup that backs move/skip/restore, and the recurrence
 *        summary / provenance badge text that make overlapping origins
 *        (invariant #3/#4) visible in the UI. Uses the shared minimal DOM
 *        stub + browser-path loader (same pattern as test-shopping-ux.js);
 *        the loader's /i18n.js stub echoes t('key', params) as
 *        "key" + JSON.stringify(params), so assertions check against that
 *        predictable shape rather than real translated text. Full modal
 *        open/save/dirty-close flows are covered by manual browser testing
 *        instead of here, since modal.js's dirty-close machinery is generic,
 *        shared, and already covered by its own tests - this repo has no
 *        jsdom dependency, and open/save/dirty-close flows need a real DOM.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-waste-ui.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

global.HTMLElement = class HTMLElement {};
global.customElements = { define() {}, get() { return undefined; } };
global.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, yuvomi: {} };
global.document = {
  getElementById: () => null,
  createElement: () => Object.assign(new global.HTMLElement(), {
    style: {}, setAttribute() {}, appendChild() {}, addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
  }),
  addEventListener() {},
  documentElement: { lang: 'de' },
};

const { __test } = await import('../public/pages/waste.js');
const {
  findScheduleOrigin, parseDeepLinkParams, deepLinkSelectors, recurrenceSummary, originBadges,
  defaultLabelDecision, unresolvedBlockingDiagnostics, buildMappingDecisions, sourceHealthBadgeInfo,
  splitUpcomingByType, deepLinkNeedsExpand,
  typeCardHtml, scheduleRowHtml, sourceRowHtml, TYPE_PRESETS, WASTE_TYPE_COLORS,
} = __test;

// -------------------------------------------------------------------------
// findScheduleOrigin - backs move/skip/restore
// -------------------------------------------------------------------------

test('findScheduleOrigin: returns the schedule id and original date for a schedule-origin occurrence', () => {
  const occurrences = [{
    key: '1:2026-01-05', date_key: '2026-01-05',
    origins: [{ kind: 'schedule', schedule_id: 10, original_date: null, moved: false }],
  }];
  const found = findScheduleOrigin('1:2026-01-05', occurrences);
  assert.equal(found.scheduleId, 10);
  assert.equal(found.originalDate, '2026-01-05', 'falls back to the occurrence date when original_date is null (unmoved)');
});

test('findScheduleOrigin: uses the recorded original_date for a moved occurrence', () => {
  const occurrences = [{
    key: '1:2026-01-14', date_key: '2026-01-14',
    origins: [{ kind: 'schedule', schedule_id: 10, original_date: '2026-01-12', moved: true }],
  }];
  const found = findScheduleOrigin('1:2026-01-14', occurrences);
  assert.equal(found.originalDate, '2026-01-12');
});

test('findScheduleOrigin: returns null for a one-off-only occurrence (nothing to move/skip)', () => {
  const occurrences = [{
    key: '1:2026-01-12', date_key: '2026-01-12',
    origins: [{ kind: 'one_off', one_off_id: 5, original_date: null, moved: false }],
  }];
  assert.equal(findScheduleOrigin('1:2026-01-12', occurrences), null);
});

test('findScheduleOrigin: returns null for an unknown key', () => {
  assert.equal(findScheduleOrigin('missing', []), null);
});

// -------------------------------------------------------------------------
// Deep-link contract: ?type=<id>&date=<YYYY-MM-DD>
// -------------------------------------------------------------------------

test('parseDeepLinkParams: reads a well-formed type + date', () => {
  assert.deepEqual(parseDeepLinkParams('?type=7&date=2026-03-01'), { typeId: 7, date: '2026-03-01' });
});

test('parseDeepLinkParams: type alone (no date) is valid', () => {
  assert.deepEqual(parseDeepLinkParams('?type=7'), { typeId: 7, date: null });
});

test('parseDeepLinkParams: no type at all yields typeId: null regardless of date', () => {
  assert.deepEqual(parseDeepLinkParams('?date=2026-03-01'), { typeId: null, date: '2026-03-01' });
  assert.deepEqual(parseDeepLinkParams(''), { typeId: null, date: null });
});

test('parseDeepLinkParams: rejects a malformed date instead of passing it through unescaped', () => {
  assert.deepEqual(parseDeepLinkParams('?type=7&date=not-a-date'), { typeId: 7, date: null });
  assert.deepEqual(parseDeepLinkParams('?type=7&date=2026-3-1'), { typeId: 7, date: null });
});

test('parseDeepLinkParams: rejects a non-positive or non-numeric type', () => {
  assert.deepEqual(parseDeepLinkParams('?type=0'), { typeId: null, date: null });
  assert.deepEqual(parseDeepLinkParams('?type=-1'), { typeId: null, date: null });
  assert.deepEqual(parseDeepLinkParams('?type=abc'), { typeId: null, date: null });
});

test('deepLinkSelectors: null when there is no type to link to', () => {
  assert.equal(deepLinkSelectors({ typeId: null, date: null }), null);
});

test('deepLinkSelectors: a type + date targets the occurrence row, with a card fallback', () => {
  const selectors = deepLinkSelectors({ typeId: 7, date: '2026-03-01' });
  assert.equal(selectors.rowSelector, '.waste-occurrence-row[data-type-id="7"][data-date="2026-03-01"]');
  assert.equal(selectors.cardSelector, '.waste-type-card[data-type-id="7"]');
});

test('deepLinkSelectors: a type alone has no row selector, only the card fallback', () => {
  const selectors = deepLinkSelectors({ typeId: 7, date: null });
  assert.equal(selectors.rowSelector, null);
  assert.equal(selectors.cardSelector, '.waste-type-card[data-type-id="7"]');
});

// -------------------------------------------------------------------------
// splitUpcomingByType / deepLinkNeedsExpand - the collapsed "rest" section
// -------------------------------------------------------------------------

function occ(typeId, dateKey) {
  return { key: `${typeId}:${dateKey}`, date_key: dateKey, type_id: typeId };
}

test('splitUpcomingByType: one primary row per type (its earliest, since occurrences arrive date-sorted), everything else in rest', () => {
  const occurrences = [
    occ(1, '2026-01-05'), occ(2, '2026-01-06'), occ(1, '2026-01-12'), occ(1, '2026-01-19'), occ(2, '2026-01-13'),
  ];
  const { primary, rest } = splitUpcomingByType(occurrences);
  assert.deepEqual(primary.map((o) => o.key), ['1:2026-01-05', '2:2026-01-06'], 'the first occurrence encountered per type is primary');
  assert.deepEqual(rest.map((o) => o.key), ['1:2026-01-12', '1:2026-01-19', '2:2026-01-13']);
});

test('splitUpcomingByType: a single occurrence per type leaves rest empty', () => {
  const { primary, rest } = splitUpcomingByType([occ(1, '2026-01-05'), occ(2, '2026-01-06')]);
  assert.equal(primary.length, 2);
  assert.equal(rest.length, 0);
});

test('deepLinkNeedsExpand: false without a type/date, or when the target is a type\'s own primary row', () => {
  const occurrences = [occ(1, '2026-01-05'), occ(1, '2026-01-12')];
  assert.equal(deepLinkNeedsExpand(occurrences, { typeId: null, date: null }), false);
  assert.equal(deepLinkNeedsExpand(occurrences, { typeId: 1, date: null }), false);
  assert.equal(deepLinkNeedsExpand(occurrences, { typeId: 1, date: '2026-01-05' }), false, 'the primary row is already visible without expanding');
});

test('deepLinkNeedsExpand: true when the target date only exists in the collapsed rest section', () => {
  const occurrences = [occ(1, '2026-01-05'), occ(1, '2026-01-12')];
  assert.equal(deepLinkNeedsExpand(occurrences, { typeId: 1, date: '2026-01-12' }), true);
});

// -------------------------------------------------------------------------
// recurrenceSummary - the text a schedule row actually shows
// -------------------------------------------------------------------------

test('recurrenceSummary: weekly, single interval, joins weekday labels', () => {
  const schedule = { recurrence_kind: 'weekly', weekdays: 'MO,TH', interval: 1 };
  const days = 'waste.weekdayMon, waste.weekdayThu';
  assert.equal(recurrenceSummary(schedule), `waste.summaryWeekly{"days":"${days}"}`);
});

test('recurrenceSummary: weekly with interval > 1 uses the interval-aware key', () => {
  const schedule = { recurrence_kind: 'weekly', weekdays: 'MO', interval: 2 };
  assert.equal(recurrenceSummary(schedule), 'waste.summaryWeeklyInterval{"interval":2,"days":"waste.weekdayMon"}');
});

test('recurrenceSummary: monthly fixed day', () => {
  const schedule = { recurrence_kind: 'monthly_fixed_day', month_day: 15, interval: 1 };
  assert.equal(recurrenceSummary(schedule), 'waste.summaryMonthly{"day":"waste.summaryMonthDayN{\\"day\\":15}"}');
});

test('recurrenceSummary: monthly last-day-of-month uses the dedicated label, not summaryMonthDayN', () => {
  const schedule = { recurrence_kind: 'monthly_fixed_day', month_day: -1, interval: 1 };
  assert.equal(recurrenceSummary(schedule), 'waste.summaryMonthly{"day":"waste.monthDayLastDay"}');
});

test('recurrenceSummary: monthly with interval > 1 uses the interval-aware key', () => {
  const schedule = { recurrence_kind: 'monthly_fixed_day', month_day: 1, interval: 3 };
  assert.equal(recurrenceSummary(schedule), 'waste.summaryMonthlyInterval{"interval":3,"day":"waste.summaryMonthDayN{\\"day\\":1}"}');
});

// -------------------------------------------------------------------------
// originBadges - provenance visibility (invariant #3/#4)
// -------------------------------------------------------------------------

test('originBadges: an unmoved, non-coalesced occurrence shows no badges', () => {
  const occurrence = { moved: false, coalesced: false, origins: [{ kind: 'schedule', moved: false }] };
  assert.equal(originBadges(occurrence), '');
});

test('originBadges: a moved occurrence names its original date', () => {
  const occurrence = {
    moved: true, coalesced: false,
    origins: [{ kind: 'schedule', moved: true, original_date: '2026-01-12' }],
  };
  assert.match(originBadges(occurrence), /waste-badge--moved/);
  assert.match(originBadges(occurrence), /waste\.movedFromBadge/);
});

test('originBadges: a coalesced occurrence names the overlap, so editing one origin never looks like it erased the other', () => {
  const occurrence = {
    moved: false, coalesced: true,
    origins: [{ kind: 'schedule', moved: false }, { kind: 'one_off', moved: false }],
  };
  assert.match(originBadges(occurrence), /waste-badge--coalesced/);
});

test('originBadges: a moved AND coalesced occurrence shows both badges', () => {
  const occurrence = {
    moved: true, coalesced: true,
    origins: [{ kind: 'schedule', moved: true, original_date: '2026-01-12' }, { kind: 'one_off', moved: false }],
  };
  const html = originBadges(occurrence);
  assert.match(html, /waste-badge--moved/);
  assert.match(html, /waste-badge--coalesced/);
});

// -------------------------------------------------------------------------
// Import wizard pure helpers (#1063 Phase 3)
// -------------------------------------------------------------------------

test('defaultLabelDecision: remembered_ignored beats remembered_type_id beats suggested_type_id beats "create new"', () => {
  assert.equal(defaultLabelDecision({ remembered_ignored: true, remembered_type_id: 5, suggested_type_id: 9 }), '');
  assert.equal(defaultLabelDecision({ remembered_ignored: false, remembered_type_id: 5, suggested_type_id: 9 }), '5');
  assert.equal(defaultLabelDecision({ remembered_ignored: false, remembered_type_id: null, suggested_type_id: 9 }), '9');
  assert.equal(defaultLabelDecision({ remembered_ignored: false, remembered_type_id: null, suggested_type_id: null }), '__new__');
});

test('unresolvedBlockingDiagnostics: only blocking diagnostics count, and an explicit skip resolves one', () => {
  const diagnostics = [
    { severity: 'info', code: 'cancelled_excluded', event_key: null },
    { severity: 'blocking', code: 'unbounded_recurrence', event_key: 'uid:a' },
    { severity: 'blocking', code: 'unsupported_rdate', event_key: 'uid:b' },
  ];
  assert.equal(unresolvedBlockingDiagnostics(diagnostics, []).length, 2);
  assert.equal(unresolvedBlockingDiagnostics(diagnostics, ['uid:a']).length, 1);
  assert.equal(unresolvedBlockingDiagnostics(diagnostics, ['uid:a', 'uid:b']).length, 0);
});

test('buildMappingDecisions: builds type_id / new_type / ignored entries from each row\'s decision', () => {
  const rows = [
    { normalized_label: 'restmüll', decision: '5', newTypeName: '' },
    { normalized_label: 'papier', decision: '__new__', newTypeName: 'Papier' },
    { normalized_label: 'sperrmüll', decision: '', newTypeName: '' },
  ];
  const { mappings, error } = buildMappingDecisions(rows);
  assert.equal(error, undefined);
  assert.deepEqual(mappings, [
    { normalized_label: 'restmüll', type_id: 5 },
    { normalized_label: 'papier', new_type: { name: 'Papier' } },
    { normalized_label: 'sperrmüll', ignored: true },
  ]);
});

test('buildMappingDecisions: a "create new" decision without a name reports an error instead of committing a blank type', () => {
  const rows = [{ normalized_label: 'papier', decision: '__new__', newTypeName: '  ' }];
  const result = buildMappingDecisions(rows);
  assert.equal(result.error, 'missing_new_type_name');
  assert.equal(result.label, 'papier');
});

test('sourceHealthBadgeInfo: an error takes priority over needs_refresh, and a healthy source shows nothing', () => {
  assert.equal(sourceHealthBadgeInfo({ last_error: 'boom', needs_refresh: true }).code, 'error');
  assert.equal(sourceHealthBadgeInfo({ last_error: null, needs_refresh: true }).code, 'needs-refresh');
  assert.equal(sourceHealthBadgeInfo({ last_error: null, needs_refresh: false }), null);
});

// -------------------------------------------------------------------------
// Zeilengrammatik: EIN "..."-Menue statt nackter Icon-Knoepfe (Audit UX,
// 2026-09-12). Die drei Zeilentypen boten ihre Aktionen vorher auf drei
// verschiedene Arten an; die Abholzeile fuehrte als einzige ein Menue. Diese
// Tests halten die Vereinheitlichung fest - inklusive der Bedingung, die am
// Markup selbst nicht mehr sichtbar ist: an den Enden der Liste FEHLT der
// jeweilige Pfeil, statt ausgegraut dazustehen.
// -------------------------------------------------------------------------

const TYPE = { id: 7, name: 'Restmüll', icon: 'trash-2', color: '#64748B', archived: false };

test('typeCardHtml: die drei nackten Icon-Knoepfe sind einem einzigen "..."-Menue gewichen', () => {
  const html = typeCardHtml(TYPE, 1, 3);
  // Genau ein sichtbarer Zeilenknopf, und der oeffnet das Menue.
  assert.equal((html.match(/class="row-action"/g) ?? []).length, 1);
  assert.match(html, /popovertarget="waste-type-menu-7"/);
  assert.match(html, /<div class="popover-menu" id="waste-type-menu-7" popover role="menu">/);
  // Die Aktionen liegen jetzt als beschriftete Eintraege im Menue, nicht mehr
  // als aria-label an einem Icon.
  for (const action of ['move-type-up', 'move-type-down', 'add-schedule']) {
    assert.match(html, new RegExp(`class="popover-menu__item" data-action="${action}"`), `${action} fehlt im Menue`);
  }
  // Loeschen gibt es auf Zeilenebene weiterhin nicht - das bleibt im Dialog.
  assert.doesNotMatch(html, /popover-menu__item--danger/);
});

test('typeCardHtml: der Datenschluessel jeder Aktion ueberlebt den Umzug ins Menue', () => {
  const html = typeCardHtml(TYPE, 1, 3);
  // Der delegierte Handler liest `dataset.id` bzw. `dataset.typeId` DIREKT am
  // Knoten mit data-action - ein Menueeintrag ohne diese Attribute waere still
  // wirkungslos geworden.
  assert.match(html, /data-action="move-type-up" data-id="7"/);
  assert.match(html, /data-action="add-schedule" data-type-id="7"/);
});

test('typeCardHtml: an den Enden der Liste fehlt der jeweilige Pfeil, statt tot dazustehen', () => {
  const first = typeCardHtml(TYPE, 0, 3);
  assert.doesNotMatch(first, /move-type-up/, 'die erste Abfallart kann nicht weiter nach oben');
  assert.match(first, /move-type-down/);

  const last = typeCardHtml(TYPE, 2, 3);
  assert.match(last, /move-type-up/);
  assert.doesNotMatch(last, /move-type-down/, 'die letzte Abfallart kann nicht weiter nach unten');

  // Und kein `disabled` mehr: der Eintrag ist weg, nicht ausgegraut.
  assert.doesNotMatch(first + last, /\bdisabled\b/);
});

test('typeCardHtml: bei genau einer Abfallart bleibt nur das Anlegen einer Serie uebrig', () => {
  const only = typeCardHtml(TYPE, 0, 1);
  assert.doesNotMatch(only, /move-type-up|move-type-down/, 'Sortieren gibt es bei einer einzigen Art nicht');
  assert.match(only, /data-action="add-schedule"/);
});

test('scheduleRowHtml: die Loeschung liegt hinter dem Menue und ist als gefaehrlich markiert', () => {
  const html = scheduleRowHtml({ id: 42, type_id: 7, active: true, freq: 'weekly', weekday: 1, interval: 1 });
  assert.equal((html.match(/class="row-action"/g) ?? []).length, 1);
  assert.match(html, /popovertarget="waste-schedule-menu-42"/);
  assert.match(html, /<div class="popover-menu" id="waste-schedule-menu-42" popover role="menu">/);
  assert.match(html, /class="popover-menu__item popover-menu__item--danger" data-action="delete-schedule" data-id="42"/);
  // Der nackte Muelltonnen-Knopf direkt in der Zeile ist weg - ein Fehlgriff
  // daneben loeschte vorher sofort eine ganze Serie.
  assert.doesNotMatch(html, /class="row-action" data-action="delete-schedule"/);
});

test('scheduleRowHtml: eine pausierte Serie traegt ihren eigenen Chip', () => {
  const paused = scheduleRowHtml({ id: 43, type_id: 7, active: false, freq: 'weekly', weekday: 1, interval: 1 });
  assert.match(paused, /class="waste-badge waste-badge--paused"/);
  const active = scheduleRowHtml({ id: 44, type_id: 7, active: true, freq: 'weekly', weekday: 1, interval: 1 });
  assert.doesNotMatch(active, /waste-badge--paused/);
});

test('sourceRowHtml: die wechselnde Zeilenaktion traegt im Menue endlich ihren Satz', () => {
  // Zwei der drei Faelle benutzten dasselbe `refresh-cw`; welcher gemeint war,
  // stand nur im aria-label und war fuer sehende Nutzer unsichtbar.
  const url = sourceRowHtml({ id: 3, kind: 'url', name: 'Stadt', needs_mapping: false });
  assert.match(url, /popovertarget="waste-source-menu-3"/);
  assert.match(url, /data-action="refresh-source" data-id="3"/);
  assert.match(url, /waste\.refreshNowAction/, 'der Eintrag traegt seine eigene Beschriftung');

  const needsMapping = sourceRowHtml({ id: 4, kind: 'url', name: 'Stadt', needs_mapping: true });
  assert.match(needsMapping, /data-action="review-source-mapping" data-id="4"/);

  const file = sourceRowHtml({ id: 5, kind: 'file', name: 'kalender.ics', needs_mapping: false });
  assert.match(file, /data-action="reimport-source" data-id="5"/);

  // Die Loeschung einer Quelle bleibt, wo sie war (Detail-Dialog).
  assert.doesNotMatch(url + file, /delete-source|popover-menu__item--danger/);
});

test('sourceRowHtml: jede Quelle bekommt ihr eigenes Menue', () => {
  const a = sourceRowHtml({ id: 3, kind: 'url', name: 'A', needs_mapping: false });
  const b = sourceRowHtml({ id: 9, kind: 'url', name: 'B', needs_mapping: false });
  assert.match(a, /id="waste-source-menu-3"/);
  assert.match(b, /id="waste-source-menu-9"/);
});

// -------------------------------------------------------------------------
// EINE Zeilengrammatik, auch im Bauplan (Browser-Pruefung, 2026-09-12)
//
// Die "..."-Knoepfe sassen nicht am Zeilenende, sondern klebten am Text: bei
// der Abfallart 372px zu frueh, bei der Serie 197px, bei der Quelle 354px -
// gemessen bei 1280px am gebauten Stand. Ursache war keine fehlende
// Ausrichtungsregel, sondern eine fehlende KLASSE: der Zeilenkoerper trug nur
// `list-row__main--interactive`, und dieser Modifikator traegt ausschliesslich
// die Knopf-Zuruecksetzung. `flex: 1 1 auto` und `min-width: 0` - das, was die
// Textspalte wachsen und die Bedienzone ans Ende ruecken laesst - stehen in
// der BASISKLASSE. Dieselbe Luecke stellte in allen vier Zeilentypen das
// Symbol ueber statt neben den Namen.
//
// Beide Zusagen sind reine Bauplan-Pruefungen: die Ausrichtung selbst
// entsteht im Browser. Aber genau die zwei Klassen, ohne die sie nicht
// entstehen KANN, lassen sich hier festnageln - und es ist die Art Fehler,
// die beim naechsten Umbau still zurueckkommt.
// -------------------------------------------------------------------------

test('jede Zeile des Moduls traegt die gemeinsame Marke waste-row', () => {
  // Ohne sie greift keine der beiden Grammatik-Regeln in waste.css, denn sie
  // haengen alle an `.waste-row > .list-row__main`.
  const rows = [
    typeCardHtml({ id: 1, name: 'A', color: '#16A34A' }, 0, 1),
    scheduleRowHtml({ id: 2, type_id: 1, recurrence_kind: 'weekly', interval: 1, weekdays: 'MO', active: true }),
    sourceRowHtml({ id: 3, kind: 'url', name: 'Q', needs_mapping: false }),
  ];
  for (const html of rows) {
    assert.match(html, /class="list-row waste-row /, 'die Marke steht direkt neben .list-row');
  }
  // Und die Abholzeile, die schon vorher richtig ausgerichtet war, ebenfalls -
  // sonst faellt ausgerechnet die Referenzzeile aus der gemeinsamen Regel.
  assert.match(WASTE_SRC, /class="list-row waste-row waste-occurrence-row"/);
});

test('der Zeilenkoerper traegt IMMER die Basisklasse, --interactive nur zusaetzlich', () => {
  // Vorrat und Inventar schreiben beide Klassen nebeneinander; hier stand der
  // Modifikator allein, und die Textspalte loeste damit auf ihre Inhaltsbreite
  // auf statt zu wachsen.
  const solo = WASTE_CODE.match(/class="[^"]*list-row__main--interactive[^"]*"/g) ?? [];
  assert.ok(solo.length >= 3, 'die drei schreibbaren Zeilenkoerper muessen auffindbar bleiben');
  for (const cls of solo) {
    assert.match(cls, /list-row__main(?!--)/, `${cls} braucht die Basisklasse list-row__main`);
  }
});

// -------------------------------------------------------------------------
// Farbpalette der Abfallart (Audit UX, 2026-09-12)
// -------------------------------------------------------------------------

test('WASTE_TYPE_COLORS: jede Preset-Farbe liegt im Raster', () => {
  // Sonst setzt die Vorlagen-Auswahl im Dialog eine Farbe, zu der es keinen
  // Swatch gibt - das Raster stuende dann ohne Markierung da.
  for (const preset of TYPE_PRESETS) {
    assert.ok(WASTE_TYPE_COLORS.includes(preset.color),
      `Preset ${preset.key} (${preset.color}) fehlt in WASTE_TYPE_COLORS`);
  }
});

test('WASTE_TYPE_COLORS: eine kuratierte Auswahl ohne Dubletten und ohne Extremwerte', () => {
  assert.equal(new Set(WASTE_TYPE_COLORS).size, WASTE_TYPE_COLORS.length, 'keine doppelten Farben');
  assert.ok(WASTE_TYPE_COLORS.length >= 8, 'zu wenig Auswahl ist auch keine');
  for (const hex of WASTE_TYPE_COLORS) {
    assert.match(hex, /^#[0-9A-F]{6}$/, `${hex} ist kein normalisierter Hex-Wert`);
    // Der eigentliche Zweck der Palette: kein Weiss und kein Schwarz mehr.
    // Genau die liessen sich im freien `<input type="color">` waehlen und
    // machten das Symbol der Abfallart auf hellem bzw. dunklem Grund unsichtbar.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    assert.ok(luminance > 0.08 && luminance < 0.72,
      `${hex} liegt ausserhalb des Helligkeitsbands der Palette (${luminance.toFixed(3)})`);
  }
});

// -------------------------------------------------------------------------
// Quelltext-Zusicherungen (Audit UX, 2026-09-12).
//
// Die folgenden Zusagen haengen an `renderPage()`/`bindEvents()` und am
// Leerzustand - alles Stellen, die einen echten DOM und einen laufenden Router
// brauchen und deshalb oben bewusst nicht nachgebaut werden (siehe Kopf).
// Geprueft wird stattdessen der Vertrag im Quelltext, so wie es
// test-frontend-audit.js fuer die geteilten Blaetter tut. Das ist schwaecher
// als ein Klick, aber deutlich staerker als gar nichts - und es faengt genau
// den Rueckschritt ab, der hier teuer waere: einen Schreib-Weg, der einem
// Nur-lesen-Mitglied ins Markup rutscht.
// -------------------------------------------------------------------------

const { readFileSync } = await import('node:fs');
const WASTE_SRC = readFileSync(new URL('../public/pages/waste.js', import.meta.url), 'utf8');
// Fuer die "das gibt es nicht mehr"-Zusagen: die Begruendungen im Quelltext
// NENNEN die abgeschafften Dinge ausdruecklich (`toolbar-new-btn`,
// `<input type="color">`), damit der naechste Leser weiss, warum sie fehlen.
// Ohne diesen Schnitt wuerde ausgerechnet die Erklaerung den Test ausloesen.
const WASTE_CODE = WASTE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('die Seite hat einen sichtbaren, beschrifteten Weg zur ersten Abfallart, und das Ueberlaufmenue bietet ihn nicht doppelt an', () => {
  // Vorher lagen ALLE vier Aktionen hinter dem unbeschrifteten "..." - eine
  // frische Installation zeigte keinen einzigen sichtbaren Weg zur ersten
  // Abfallart.
  //
  // SEKUNDAER FESTGENAGELT, nicht nur "irgendein Knopf": ab 1024px dockt der
  // FAB in dieselbe Werkzeugleiste (dockFabIntoToolbar in router.js) und
  // rendert dort als gefuellte Primaerpille. Als `btn--primary` standen hier
  // zwei gefuellte Violettknoepfe nebeneinander, und die Seite sagte nicht
  // mehr, welcher der Hauptweg ist (Eine-Stimme-Regel, DESIGN.md). Keine
  // statische Pruefung faengt das, weil beide Knoepfe je fuer sich
  // regelkonform sind - erst ihre Nachbarschaft ist der Fehler. Deshalb steht
  // die Variante hier ausdruecklich im Test und nicht nur im Kommentar.
  assert.match(WASTE_SRC, /class="btn btn--secondary" id="waste-add-type-btn" data-action="add-type"/);
  assert.doesNotMatch(WASTE_CODE, /class="btn btn--primary" id="waste-add-type-btn"/);
  // Und genau einmal: der Menueeintrag ist beim Befoerdern entfallen.
  assert.equal((WASTE_SRC.match(/data-action="add-type"/g) ?? []).length, 1);
  assert.doesNotMatch(WASTE_SRC, /action: 'add-type'/, 'add-type darf nicht mehr im Ueberlaufmenue stehen');
  // Die drei uebrigen Kopf-Aktionen bleiben im Menue.
  for (const a of ['open-import', 'open-url-source', 'open-reminder-settings']) {
    assert.match(WASTE_SRC, new RegExp(`action: '${a}'`), `${a} gehoert weiter ins Ueberlaufmenue`);
  }
});

test('der neue Kopfknopf traegt bewusst KEIN toolbar-new-btn', () => {
  // Diese Klasse blendet ab 1024px den FAB aus
  // (`body:has(.toolbar-new-btn:not([hidden])) #fab-layer .page-fab`). Der FAB
  // der Abfallseite legt aber eine ABHOLUNG an, nicht eine Abfallart - mit der
  // Klasse waere die Abholung am Desktop ersatzlos verschwunden.
  assert.doesNotMatch(WASTE_CODE, /toolbar-new-btn/);
  assert.match(WASTE_SRC, /class="page-fab" id="waste-fab-new-pickup"/, 'der FAB bleibt, wo er war');
});

test('der FAB fuehrt ohne Abfallart nicht mehr ins Leere', () => {
  // Vorher: Toast, `return`, Ende - der prominenteste Knopf einer frischen
  // Installation war der einzige, der garantiert nirgendwohin fuehrte.
  const branch = WASTE_SRC.match(/if \(!state\.types\.filter\([\s\S]{0,400}?\n {4}\}/);
  assert.ok(branch, 'der Zweig ohne Abfallart muss auffindbar bleiben');
  assert.match(branch[0], /openTypeModal\(\)/, 'der Hinweis muss jetzt auch den Weg oeffnen');
  // Der Satz bleibt: der FAB ist mit "Abholung" beschriftet, und ein Dialog,
  // der unangekuendigt nach einer Abfallart fragt, braucht seine Erklaerung.
  assert.match(branch[0], /waste\.addTypeFirstHint/);
});

test('beide Leerzustaende bieten ihren Weg an - und beide nur dem, der schreiben darf', () => {
  // Der Quellen-Leerzustand nannte den Weg in seiner Beschreibung, ohne ihn
  // anzubieten ("Importiere eine ICS-Datei deiner Kommune...").
  assert.match(WASTE_SRC, /action: readOnly\(\) \? null : \{ label: t\('waste\.addType'\)/);
  assert.match(WASTE_SRC, /action: readOnly\(\) \? null : \{ label: t\('waste\.importFileAction'\)/);
  assert.match(WASTE_SRC, /#waste-empty-add-source'\)\?\.addEventListener\('click', \(\) => openImportWizard\(\)\)/);
});

test('jeder Schreib-Weg im Kopf bleibt hinter dem Nur-lesen-Riegel', () => {
  // Nicht "optisch versteckt", sondern gar nicht erst im Markup: das ist der
  // Unterschied, auf dem dieses Modul seit der ersten Fassung besteht.
  assert.match(WASTE_SRC, /actions: readOnly\(\) \? '' : renderPageActions\(\[/);
  // Und die Zeilenmenues ebenso - je einmal pro Zeilentyp.
  assert.equal((WASTE_SRC.match(/\$\{ro \? '' : `\n\s*<div class="row-actions">/g) ?? []).length, 2,
    'Serien- und Typzeile unterdruecken ihre Aktionen ueber dasselbe `ro`');
  assert.match(WASTE_SRC, /\$\{readOnly\(\) \? '' : `\n\s*<div class="row-actions">/, 'die Quellenzeile ebenso');
});

test('der freie Farbwaehler ist aus dem Abfallart-Dialog verschwunden', () => {
  // 16,7 Millionen Farben ohne Untergrenze: Weiss oder Schwarz liessen das
  // Symbol der Abfallart auf hellem bzw. dunklem Grund verschwinden.
  assert.doesNotMatch(WASTE_CODE, /type="color"/);
  assert.doesNotMatch(WASTE_CODE, /form-input--color/);
  assert.match(WASTE_SRC, /class="waste-color-picker" role="radiogroup" aria-labelledby="wtm-color-label"/);
  // Die gespeicherte Farbe gewinnt ihren eigenen Swatch, statt still ersetzt
  // zu werden - Abfallarten aus der Zeit des freien Waehlers tragen beliebige
  // Hex-Werte.
  assert.match(WASTE_SRC, /WASTE_TYPE_COLORS\.includes\(selColor\) \? WASTE_TYPE_COLORS : \[\.\.\.WASTE_TYPE_COLORS, selColor\]/);
});
