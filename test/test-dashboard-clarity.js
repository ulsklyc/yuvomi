/**
 * Tests: Dashboard-Klarheit (Critique 2026-09-23)
 * Zweck: Drei Stellen, an denen die Uebersicht etwas anderes sagte, als sie
 *        meinte:
 *        1. Badges zaehlten die GEZEIGTEN Zeilen statt der Sache - "Notizen 3"
 *           bei fuenf angehefteten, "Geburtstage 5" bei acht, und nichts wies
 *           auf den Rest hin.
 *        2. `relativeDateLabel` sprang nach "morgen" auf das volle Datum mit
 *           Jahr ("26.09.2026" fuer uebermorgen).
 *        3. Die Familienkarte zeigte den ERSTEN Termin des Tages statt des
 *           naechsten (#1449) und wiederholte einen geteilten Termin in jeder
 *           Personenzeile.
 *        Zeit und Zone sind festgenagelt: Berlin wie die Demo-Saat UND je ein
 *        Gegenlauf in einer Zone, die den Tag verschiebt.
 * Ausfuehren: npm run test:dashboard-clarity
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./test-browser-loader.mjs', import.meta.url);

const tz = await import('/utils/timezone.js');
const { __test, renderUpcomingBirthdays } = await import('../public/pages/dashboard.js');

// --------------------------------------------------------
// Festgenagelte Zeit und Zone
// --------------------------------------------------------
const RealDate = Date;

function at(iso, zone, fn) {
  const fixed = RealDate.parse(iso);
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }

    static now() { return fixed; }
  }
  globalThis.Date = FixedDate;
  tz.setDisplayTimeZone(zone);
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
    tz.setDisplayTimeZone(null);
  }
}

// Tag+Monat und volles Datum sind im Browser-Stub beide `String(d)`. Damit der
// Test sieht, WELCHER der beiden gerufen wurde, markiert er die Kurzform.
globalThis.__formatDayMonth = (d) => `DM:${d}`;

const badgeOf = (html) => (/class="widget__badge">([^<]*)</.exec(html) || [])[1] ?? null;

// --------------------------------------------------------
// 1. Badges zaehlen die Sache, nicht die Zeilen
// --------------------------------------------------------

test('Notizen: Badge nennt die Gesamtzahl, der Rest steht als "+N weitere" da', () => {
  const notes = ['A', 'B', 'C', 'D', 'E'].map((x, i) => ({ id: i + 1, title: `Notiz ${x}`, content: x, pinned: 1 }));
  const flat = __test.renderPinnedNotes(notes, '1x1', 8);
  assert.equal(badgeOf(flat), '8', 'die flache Kachel zeigt drei Zeilen, der Haushalt hat acht Notizen');
  assert.match(flat, /dashboard\.notesMore\{&quot;count&quot;:5\}/, 'die fuenf nicht gezeigten werden genannt');

  const tall = __test.renderPinnedNotes(notes, '1x2', 5);
  assert.equal(badgeOf(tall), '5');
  assert.ok(!/notesMore/.test(tall), 'passt alles, gibt es keinen Rest-Hinweis');

  // Ohne Gesamtzahl (aelterer Server) bleibt es bei den geladenen Zeilen -
  // dann stimmt wenigstens der Kachelschnitt.
  assert.equal(badgeOf(__test.renderPinnedNotes(notes, '1x1')), '5');
  assert.match(__test.renderPinnedNotes(notes, '1x1'), /dashboard\.notesMore\{&quot;count&quot;:2\}/);
});

test('Geburtstage: Badge nennt alle anstehenden Anlaesse, nicht die gezeigten', () => {
  const list = Array.from({ length: 5 }, (_, i) => ({
    name: `Person ${i}`, days_until: 10 + i, next_date: '2026-10-10', kind: 'birthday', next_age: 30,
  }));
  const html = renderUpcomingBirthdays(list, '1x1', 8);
  assert.equal(badgeOf(html), '8');
  assert.match(html, /dashboard\.birthdaysMore\{&quot;count&quot;:5\}/);
});

test('Aufgaben: Badge nennt alle offenen, nicht die fuenf dringendsten', () => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `Aufgabe ${i}`, priority: 'none', status: 'open' }));
  const html = __test.renderUrgentTasks(tasks, 12);
  assert.equal(badgeOf(html), '12');
  assert.match(html, /dashboard\.tasksMore\{&quot;count&quot;:7\}/);
  assert.equal(badgeOf(__test.renderUrgentTasks(tasks, 5)), '5');
  assert.ok(!/tasksMore/.test(__test.renderUrgentTasks(tasks, 5)));
});

test('Kalender: keine Badge - "5" waere nur die Obergrenze der Liste', () => {
  // Die Liste ist nach vorn offen (bis 90 Tage) und bei fuenf geschnitten; eine
  // Gesamtzahl gibt es nicht. Eine Badge "5" stuende genau so lange da, wie
  // mindestens fuenf Termine kommen - die gefaehrlichste Sorte Zahl.
  const events = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, title: `Termin ${i}`, start_datetime: `2026-10-0${i + 1}T10:00`, assigned_users: [],
  }));
  assert.equal(badgeOf(__test.renderUpcomingEvents(events)), null);
});

test('Einkauf: Badge nennt alle offenen Artikel, weitere Listen werden genannt', () => {
  const lists = [{ id: 1, name: 'Wocheneinkauf', open_count: 8, total_count: 10, items: [{ id: 1, name: 'Milch' }] }];
  const html = __test.renderShoppingLists(lists, 23, 3);
  assert.equal(badgeOf(html), '23', 'der Server zeigt hoechstens drei Listen, gezaehlt wird ueber alle');
  assert.match(html, /dashboard\.shoppingMoreLists\{&quot;count&quot;:2\}/);
  assert.equal(badgeOf(__test.renderShoppingLists(lists)), '8', 'ohne Gesamtzahl: die geladenen Listen');
});

test('der Aufrufer reicht die Gesamtzahlen aus der Antwort an die Kacheln durch', () => {
  // Der Renderer allein beweist nichts, wenn niemand ihm die Zahl gibt.
  const prevWindow = global.window;
  global.window = { yuvomi: { isModuleDisabled: () => false } };
  try {
    const notes = ['A', 'B', 'C', 'D', 'E'].map((x, i) => ({ id: i + 1, title: `Notiz ${x}`, content: x, pinned: 1 }));
    const tasks = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `Aufgabe ${i}`, priority: 'none', status: 'open' }));
    const birthdays = Array.from({ length: 5 }, (_, i) => ({ name: `P${i}`, days_until: 10 + i, next_date: '2026-10-10', kind: 'birthday' }));
    const html = __test.renderDashboardLayout(
      [
        { id: 'notes', visible: true, size: '1x1' },
        { id: 'tasks', visible: true, size: '1x2' },
        { id: 'birthdays', visible: true, size: '1x1' },
      ],
      {
        pinnedNotes: notes, notesTotal: 9,
        urgentTasks: tasks, openTaskCount: 12,
        birthdays, birthdayTotal: 8,
        users: [],
      },
      null,
      'EUR',
    );
    assert.match(html, /dashboard\.notesMore\{&quot;count&quot;:6\}/, 'notesTotal kommt an');
    assert.match(html, /dashboard\.tasksMore\{&quot;count&quot;:7\}/, 'openTaskCount kommt an');
    assert.match(html, /dashboard\.birthdaysMore\{&quot;count&quot;:5\}/, 'birthdayTotal kommt an');
  } finally {
    global.window = prevWindow;
  }
});

test('Kennzahlen nennen Zustand und Zeitraum: "2 offen", "9 im Monat", "im Haus seit 08:30"', () => {
  const prevWindow = global.window;
  global.window = { yuvomi: { isModuleDisabled: () => false } };
  try {
    at('2026-09-23T19:18:00Z', 'Europe/Berlin', () => {
      const tiles = __test.selectMetricTiles({
        health: { hasMeds: true, dosesTotal: 3, dosesTaken: 1, dosesSkipped: 0, lowStockCount: 0, nextDose: { time: '20:00', name: 'Vitamin D3' } },
        housekeeping: { configured: true, present: true, presentSince: '2026-09-23T06:30:00.000Z', visitsThisMonth: 9 },
      }, 'EUR');
      const health = tiles.find((tile) => tile.id === 'health');
      const hk = tiles.find((tile) => tile.id === 'housekeeping');
      assert.equal(health.value, 'dashboard.metricDoses{"count":2}');
      assert.equal(health.note, '20:00 Vitamin D3', 'die Zweitzeile nennt die NAECHSTE Dosis mit Uhrzeit');
      assert.equal(hk.value, 'dashboard.metricVisitsMonth{"count":9}', 'der Zeitraum steht im Wert');
      // 06:30Z ist 08:30 in Berlin - heute, also nur die Uhrzeit.
      assert.equal(hk.note, 'dashboard.housekeepingPresentSince{"time":"2026-09-23T06:30:00.000Z"}');
    });
    at('2026-09-24T19:18:00Z', 'Europe/Berlin', () => {
      // Dieselbe offene Sitzung einen Tag spaeter: eine vergessene Abmeldung.
      const [, hk] = __test.selectMetricTiles({
        health: { hasMeds: true, dosesTotal: 1, dosesTaken: 0, dosesSkipped: 0, lowStockCount: 0, nextDose: { time: '20:00', name: 'X' } },
        housekeeping: { configured: true, present: true, presentSince: '2026-09-23T06:30:00.000Z', visitsThisMonth: 9 },
      }, 'EUR');
      assert.match(hk.note, /DM:2026-09-23, /, `ein Beginn von gestern nennt sein Datum, bekam: ${hk.note}`);
    });
  } finally {
    global.window = prevWindow;
  }
});

// --------------------------------------------------------
// 2. Relative Daten: heute, morgen, Wochentag, Datum ohne Jahr
// --------------------------------------------------------

// Mittwoch, 23.09.2026, 21:18 in Berlin - der Stand der Critique.
const CRITIQUE_NOW = '2026-09-23T19:18:00Z';

// Der erwartete Kurzname aus Intl selbst: ob „Sa" oder „Sa." dasteht, haengt an
// der ICU-Version, nicht an der App. Dass es ein NAME ist und kein Datum, prueft
// der Test daneben.
const wd = (key, locale = 'de') => {
  const name = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
  assert.doesNotMatch(name, /\d/, `Vorbedingung: ${name} ist ein Wochentagsname`);
  return name;
};

test('relativeDateLabel: innerhalb von sechs Tagen der Wochentag, danach Datum ohne Jahr', () => {
  at(CRITIQUE_NOW, 'Europe/Berlin', () => {
    globalThis.__locale = 'de';
    const label = __test.relativeDateLabel;
    assert.equal(label('2026-09-23'), 'common.today');
    assert.equal(label('2026-09-24'), 'common.tomorrow');
    assert.equal(label('2026-09-26'), wd('2026-09-26'), 'uebermorgen+1 heisst Samstag, nicht 26.09.2026');
    assert.equal(label('2026-09-29'), wd('2026-09-29'), 'sechs Tage voraus traegt noch den Wochentag');
    assert.equal(label('2026-09-30'), 'DM:2026-09-30', 'ab sieben Tagen waere der Wochentag mehrdeutig');
    assert.equal(label('2026-09-20'), 'DM:2026-09-20', 'Vergangenes bekommt nie einen Wochentag');
    assert.equal(label('2027-01-05'), '2027-01-05', 'ein anderes Jahr steht mit Jahr da');
    // Ein Zeitpunkt wird umgerechnet: 08:00Z am Samstag ist in Berlin Samstag.
    assert.equal(label('2026-09-26T08:00:00Z'), wd('2026-09-26'));
    globalThis.__locale = 'en';
    assert.equal(label('2026-09-26'), wd('2026-09-26', 'en'), 'der Name folgt der App-Sprache');
  });
  globalThis.__locale = undefined;
});

test('relativeDateLabel: die Haushaltszone entscheidet, welcher Tag heute ist', () => {
  // Derselbe Zeitpunkt ist auf Kiritimati (UTC+14) schon Donnerstag, 09:18.
  at(CRITIQUE_NOW, 'Pacific/Kiritimati', () => {
    const label = __test.relativeDateLabel;
    assert.equal(label('2026-09-24'), 'common.today');
    assert.equal(label('2026-09-25'), 'common.tomorrow');
    assert.equal(label('2026-09-30'), wd('2026-09-30'), 'von Donnerstag aus sind es sechs Tage');
    assert.equal(label('2026-10-01'), 'DM:2026-10-01');
  });
});

test('Aufgaben-Faelligkeit spricht dieselbe Sprache wie der Kalender daneben', () => {
  // Dieselbe Kachelreihe zeigte „Sa 10:00" am Termin und „25.09.2026" an der
  // Aufgabe zwei Tage voraus. Die Faelligkeit nimmt jetzt dieselbe Stufung.
  at(CRITIQUE_NOW, 'Europe/Berlin', () => {
    assert.equal(__test.formatDueDate('2026-09-26', null).text, wd('2026-09-26'));
    assert.equal(__test.formatDueDate('2026-09-26', '10:00').text, `${wd('2026-09-26')}, 2026-09-26T10:00`);
    assert.equal(__test.formatDueDate('2026-10-15', null).text, 'DM:2026-10-15');
  });
});

test('relativeDateLabel: ueber den Jahreswechsel zaehlt der Abstand, nicht das Jahr', () => {
  at('2026-12-30T12:00:00Z', 'Europe/Berlin', () => {
    const label = __test.relativeDateLabel;
    assert.equal(label('2027-01-02'), wd('2027-01-02'),'drei Tage voraus, auch im neuen Jahr');
    assert.equal(label('2027-01-10'), '2027-01-10', 'im neuen Jahr und ausser Reichweite: mit Jahr');
  });
});

// --------------------------------------------------------
// 3. Familienkarte: der naechste Termin, geteilte Termine einmal
// --------------------------------------------------------

const ALEX = { id: 1, display_name: 'Alex', avatar_color: '#2563EB' };
const LEO = { id: 2, display_name: 'Leo', avatar_color: '#F97316' };
const LINDA = { id: 3, display_name: 'Linda', avatar_color: '#EC4899' };
const who = (...people) => people.map((p) => ({ id: p.id, display_name: p.display_name, avatar_color: p.avatar_color }));
const ev = (id, title, start, end, people, allDay = 0) => ({
  id, title, start_datetime: start, end_datetime: end, all_day: allDay, assigned_users: who(...people),
});

/** Der Status-Text der Zeile, die mit diesem Namen beginnt. */
function rowStatus(html, name) {
  const rows = html.split('<div class="family-member');
  const row = rows.find((chunk) => chunk.includes(`family-member__name">${name}<`));
  if (!row) return null;
  return (/family-member__status[^"]*">([\s\S]*?)<\/span>/.exec(row) || [])[1]?.trim() ?? null;
}

test('Familienkarte: am Nachmittag steht der naechste Termin da, nicht der von 06:30 (#1449)', () => {
  // 14:00 in Berlin.
  at('2026-09-23T12:00:00Z', 'Europe/Berlin', () => {
    const events = [
      ev(1, 'Frueh', '2026-09-23T06:30', '2026-09-23T07:00', [ALEX]),
      ev(2, 'Ganztag Leo', '2026-09-23', '2026-09-24', [LEO], 1),
      ev(3, 'Abend', '2026-09-23T21:00', '2026-09-23T22:00', [ALEX]),
      ev(4, 'Abend Leo', '2026-09-23T21:00', '2026-09-23T22:00', [LEO]),
      ev(5, 'Morgens Linda', '2026-09-23T06:30', '2026-09-23T07:00', [LINDA]),
      ev(6, 'Vormittag Linda', '2026-09-23T08:00', '2026-09-23T09:00', [LINDA]),
    ];
    const html = __test.renderFamilyWidget([ALEX, LEO, LINDA], { upcomingEvents: events });
    assert.match(rowStatus(html, 'Alex'), /Abend/, `Alex: 06:30 ist vorbei, als Naechstes kommt 21:00 - bekam: ${rowStatus(html, 'Alex')}`);
    assert.doesNotMatch(rowStatus(html, 'Alex'), /Frueh/);
    assert.match(rowStatus(html, 'Leo'), /Abend Leo/, 'ein Termin mit Uhrzeit geht dem ganztaegigen vor');
    assert.equal(rowStatus(html, 'Linda'), 'dashboard.familyDoneToday', 'wer heute Termine hatte und keine mehr hat, ist fuer heute durch');
  });
});

test('Familienkarte: ein laufender Termin gilt noch als der naechste', () => {
  at('2026-09-23T12:00:00Z', 'Europe/Berlin', () => {
    const html = __test.renderFamilyWidget([ALEX, LEO], {
      upcomingEvents: [ev(1, 'Laeuft', '2026-09-23T13:30', '2026-09-23T15:00', [ALEX])],
    });
    assert.match(rowStatus(html, 'Alex'), /Laeuft/);
  });
});

test('Familienkarte: "vorbei" entscheidet die Haushaltszone, nicht das Geraet', () => {
  const events = [ev(1, 'Zehn Uhr', '2026-09-23T10:00', '2026-09-23T11:00', [ALEX])];
  // 12:00Z ist in Berlin 14:00 - der Termin ist vorbei.
  at('2026-09-23T12:00:00Z', 'Europe/Berlin', () => {
    const html = __test.renderFamilyWidget([ALEX, LEO], { upcomingEvents: events });
    assert.equal(rowStatus(html, 'Alex'), 'dashboard.familyDoneToday');
  });
  // Derselbe Zeitpunkt ist in Chicago 07:00 - er liegt noch vor Alex.
  at('2026-09-23T12:00:00Z', 'America/Chicago', () => {
    const html = __test.renderFamilyWidget([ALEX, LEO], { upcomingEvents: events });
    assert.match(rowStatus(html, 'Alex'), /Zehn Uhr/);
  });
});

/* EINE REGEL FUER "VORBEI" (Integration 2026-09-23, a2 x a4). Seit /dashboard
 * die heute schon beendeten Termine mitliefert (`keepEndedToday`), filtert die
 * Familienkarte sie selbst aus - und die Termin-Kachel stellt dieselben Termine
 * als "Vorbei" zurueck. Beide fragen `eventHasEnded`; hatte jede ihre eigene
 * Rechnung, sagte die Kachel "vorbei" und die Karte "als Naechstes" (oder
 * umgekehrt), sobald ein Termin aus dem Rahmen faellt - etwa ein synchronisierter
 * Termin mit Uhrzeit, dessen Ende nur ein Datum ist. */
test('Familienkarte und Termin-Kachel nennen dieselben Termine "vorbei"', () => {
  at('2026-09-23T12:00:00Z', 'Europe/Berlin', () => {
    const cases = [
      ev(1, 'Beendet', '2026-09-23T10:00', '2026-09-23T11:00', [ALEX]),
      ev(2, 'Laeuft', '2026-09-23T13:30', '2026-09-23T15:00', [ALEX]),
      ev(3, 'OhneEndeFrueh', '2026-09-23T09:00', null, [ALEX]),
      ev(4, 'OhneEndeAbend', '2026-09-23T20:00', null, [ALEX]),
      ev(5, 'InstantBeendet', '2026-09-23T11:00:00Z', '2026-09-23T11:30:00Z', [ALEX]),
      ev(6, 'InstantKommt', '2026-09-23T16:00:00Z', '2026-09-23T17:00:00Z', [ALEX]),
      ev(7, 'EndeNurDatum', '2026-09-23T09:00', '2026-09-23', [ALEX]),
      ev(8, 'Ganztag', '2026-09-23', '2026-09-24', [ALEX], 1),
    ];
    for (const e of cases) {
      const tileSaysEnded = /event-item--ended/.test(__test.renderUpcomingEvents([e]));
      const status = rowStatus(__test.renderFamilyWidget([ALEX, LEO], { upcomingEvents: [e] }), 'Alex') ?? '';
      const cardShowsIt = status.includes(e.title);
      assert.equal(cardShowsIt, !tileSaysEnded,
        `${e.title}: Kachel sagt ${tileSaysEnded ? 'vorbei' : 'kommt'}, Karte ${cardShowsIt ? 'zeigt ihn' : 'zeigt ihn nicht'} (${status})`);
    }
  });
});

test('Familienkarte: ein geteilter Termin steht einmal da, nicht in jeder Zeile', () => {
  at(CRITIQUE_NOW, 'Europe/Berlin', () => {
    const events = [
      ev(1, 'Zahnarzt - Familie', '2026-09-26T10:00', '2026-09-26T11:30', [ALEX, LEO, LINDA]),
      ev(2, 'Training', '2026-09-26T17:00', '2026-09-26T18:30', [LEO]),
    ];
    const html = __test.renderFamilyWidget([ALEX, LEO, LINDA], { upcomingEvents: events });
    const count = (html.match(/Zahnarzt - Familie/g) || []).length;
    assert.equal(count, 1, `der Familientermin stand ${count}-mal da`);
    assert.match(html, /dashboard\.familyEveryone/, 'die Sammelzeile nennt, wen er betrifft');
    // Leos eigener Termin bleibt in seiner Zeile; wer nichts Eigenes hat, ist heute frei.
    assert.match(rowStatus(html, 'Leo'), /Training/);
    assert.equal(rowStatus(html, 'Alex'), 'dashboard.todayFree');
  });
});

test('Familienkarte: ein geteilter Termin nur fuer zwei nennt die beiden', () => {
  at(CRITIQUE_NOW, 'Europe/Berlin', () => {
    const events = [ev(1, 'Elternabend', '2026-09-26T18:30', '2026-09-26T20:00', [ALEX, LINDA])];
    const html = __test.renderFamilyWidget([ALEX, LEO, LINDA], { upcomingEvents: events });
    assert.equal((html.match(/Elternabend/g) || []).length, 1);
    assert.ok(!/familyEveryone/.test(html), 'Leo ist nicht dabei - "Alle" waere falsch');
    assert.match(html, /Alex/);
    assert.match(html, /Linda/);
  });
});

test('Familienkarte: wer heute nur einen gemeinsamen Termin hat, ist nicht "frei"', () => {
  at('2026-09-23T08:00:00Z', 'Europe/Berlin', () => {
    const events = [ev(1, 'Brunch', '2026-09-23T11:00', '2026-09-23T13:00', [ALEX, LEO])];
    const html = __test.renderFamilyWidget([ALEX, LEO, LINDA], { upcomingEvents: events });
    assert.equal((html.match(/Brunch/g) || []).length, 1);
    assert.equal(rowStatus(html, 'Alex'), 'dashboard.familyOnlyShared');
    assert.equal(rowStatus(html, 'Linda'), 'dashboard.todayFree');
  });
});

test('Raster-Hinweis: der Knopf sagt, was er tut - die Groesse uebernehmen, nicht "Hinzufuegen"', () => {
  // `common.apply` heisst ausserhalb von de "Add"/"Ajouter"/"Añadir" (Rezepte, Einkauf, Aufgaben);
  // der Knopf aendert aber die Groesse einer vorhandenen Kachel.
  const html = __test.renderGridHint({ id: 'budget', size: 'wide' });
  const label = html.match(/data-grid-hint-apply[^>]*>([^<]*)</)?.[1];
  assert.ok(label, 'Reichweite: der Knopf wird gerendert');
  assert.equal(label, 'dashboard.gridHoleApply');
});

// --------------------------------------------------------
// 4. Anpassen-Modus: die Kacheln gleiten (FLIP), das Raster zeigt nur eine Kante
//    (Critique 2026-09-26, A7 P2)
// --------------------------------------------------------

function flipTile(id, rect) {
  const tile = {
    dataset: { widgetId: id }, rect, calls: [],
    getBoundingClientRect: () => tile.rect,
    animate(keyframes, timing) { tile.calls.push({ keyframes, timing }); return { keyframes, timing }; },
  };
  return tile;
}
const box = (left, top, width, height) => ({ left, top, width, height });

test('FLIP: jede Kachel laeuft von ihrer alten Lage in die neue, statt zu springen', () => {
  const before = new Map([
    ['moved', box(0, 0, 100, 100)],
    ['grown', box(200, 0, 100, 100)],
    ['shrunk', box(0, 200, 200, 100)],
    ['still', box(400, 0, 100, 100)],
  ]);
  const tiles = [
    flipTile('moved', box(100, 0, 100, 100)),
    flipTile('grown', box(200, 0, 200, 100)),
    flipTile('shrunk', box(0, 200, 100, 100)),
    flipTile('still', box(400, 0, 100, 100)),
    flipTile('shown', box(0, 400, 100, 100)),
  ];
  const root = { querySelectorAll: (sel) => (sel === '#dashboard-widget-grid > .widget-wrapper[data-widget-id]' ? tiles : []) };
  const timing = { duration: 250, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' };
  const played = __test.playTileFlip(root, before, { reduced: false, timing });
  const [moved, grown, shrunk, still, shown] = tiles;

  assert.equal(played.length, 4, 'die ruhende Kachel bewegt sich nicht');
  assert.deepEqual(moved.calls[0].keyframes.map((k) => k.transform), ['translate(-100px, 0px)', 'none']);
  assert.equal(moved.calls[0].timing.duration, 250);
  assert.match(grown.calls[0].keyframes[0].clipPath, /^inset\(0px 100px 0px 0px/, 'wer waechst, deckt seine neue Flaeche von der alten Groesse aus auf');
  assert.match(grown.calls[0].keyframes[1].clipPath, /^inset\(0px 0px 0px 0px/);
  assert.equal(shrunk.calls[0].keyframes[0].opacity, 0.6, 'wer schrumpft, blendet den umgebrochenen Inhalt auf');
  assert.equal(still.calls.length, 0);
  assert.equal(shown.calls[0].keyframes[0].opacity, 0, 'eine wieder eingeblendete Kachel hat keine Vorlage und blendet ein');

  // Reduzierte Bewegung: es bleibt beim Sprung - und ohne Vorher-Messung auch.
  for (const t of tiles) t.calls = [];
  assert.deepEqual(__test.playTileFlip(root, before, { reduced: true, timing }), []);
  assert.deepEqual(__test.playTileFlip(root, null, { reduced: false, timing }), []);
  assert.ok(tiles.every((t) => t.calls.length === 0));
});

test('FLIP haengt am Neuaufbau: vorher messen, nach dem setHtml abspielen - nur innerhalb des Anpassen-Modus', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const body = src.match(/function rebuildDashboard\(cfg\) \{[\s\S]*?\n {2}\}\n/)?.[0];
  assert.ok(body, 'rebuildDashboard() nicht gefunden - die Signatur greift nicht mehr');
  const capture = body.search(/const tileRectsBefore = isCustomizing && renderedCustomizing === true \? captureTileRects\(shell\) : null;/);
  const rebuild = body.search(/setHtml\(shell, `\s*<section class="dashboard-masthead/);
  const play = body.search(/playTileFlip\(shell, tileRectsBefore\)/);
  assert.ok(capture > -1 && rebuild > -1 && play > -1, 'Messen, Neuaufbau und Abspielen stehen alle drei im Neuaufbau');
  assert.ok(capture < rebuild && rebuild < play, 'erst messen, dann neu bauen, dann abspielen');
  assert.ok(capture < body.indexOf('renderedCustomizing = isCustomizing;'),
    'gemessen wird, bevor der Modus des letzten Aufbaus ueberschrieben ist - sonst gleitet auch das Betreten des Modus');
});

// R16 (Bewegung): beim Betreten/Verlassen des Anpassen-Modus sprang das Raster
// (Gruss bricht um, Ablage schiebt sich davor - gemessen y 486 -> 868). Die
// Kacheln bleiben ruhig (Test darueber), aber das Raster gleitet ALS GANZES.
test('Anpassen-Modus betreten/verlassen: das Raster gleitet als Ganzes, ohne Feder, nicht unter reduzierter Bewegung', async () => {
  const calls = [];
  const grid = {
    top: 868,
    getBoundingClientRect: () => ({ top: grid.top }),
    animate: (keyframes, timing) => { calls.push({ keyframes, timing }); return {}; },
  };
  const root = { querySelector: (sel) => (sel === '#dashboard-widget-grid' ? grid : null) };
  __test.playGridShift(root, 486, { reduced: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].keyframes, [{ transform: 'translateY(-382px)' }, { transform: 'none' }], 'von der alten Oberkante an die neue');
  assert.equal(calls[0].timing.duration, 250, '--duration-lg');
  assert.equal(calls[0].timing.easing, 'ease-out', 'Rueckfall der --ease-out; keine Feder ueber hunderte Pixel');
  assert.equal(calls[0].timing.fill, undefined, 'kein fill: der Endzustand steht vor der Animation');

  __test.playGridShift(root, 486, { reduced: true });
  __test.playGridShift(root, null, { reduced: false });
  __test.playGridShift(root, 868.4, { reduced: false });
  __test.playGridShift({ querySelector: () => ({ getBoundingClientRect: () => ({ top: 0 }) }) }, 100, { reduced: false });
  assert.equal(calls.length, 1, 'reduzierte Bewegung, kein Vorher-Wert, kein Versatz, kein animate: nichts');

  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const body = src.match(/function rebuildDashboard\(cfg\) \{[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
  const capture = body.search(/const gridTopBefore = modeChanged\s*\?/);
  const rebuild = body.search(/setHtml\(shell, `\s*<section class="dashboard-masthead/);
  const play = body.search(/playGridShift\(shell, gridTopBefore\)/);
  assert.ok(capture > -1 && capture < rebuild && rebuild < play, 'nur beim Moduswechsel: vorher messen, neu bauen, gleiten');
});

test('Anpassen-Modus: das Raster traegt eine Kante, keine Toenung ueber allen Kacheln', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)].filter((r) => r.selector.split(',').some((s) => s.trim().startsWith('.dashboard__grid--editing')));
  assert.ok(rules.length > 0, 'die Regel fuer das Raster im Anpassen-Modus fehlt');
  assert.ok(rules.some((r) => /border:\s*1px dashed/.test(r.body)), 'die Kante bleibt');
  assert.deepEqual(rules.filter((r) => /background(-color|-image)?\s*:/.test(r.body)).map((r) => r.selector), [],
    'keine Flaeche ueber dem ganzen Raster');
});

// --------------------------------------------------------
// Groessennamen sagen, was passiert (Re-Critique 2026-09-27, W2)
// --------------------------------------------------------
// „Schmal (2×1)" hiess die Groesse, die eine Kachel ZWEI Spalten breit macht -
// wer woertlich liest, bekam das Gegenteil. Im Japanischen hiessen 2×1 und 1×2
// beide „縦長". Die Regel: 2×1 heisst in de/en „breit", und in keiner Sprache
// tragen zwei waehlbare Groessen denselben Namen.
test('die Groessennamen der Uebersicht sagen die Form, in jeder Sprache verschieden', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { WIDGET_SIZE_PRESETS } = await import('../public/utils/dashboard-widgets.js');
  const dir = new URL('../public/locales/', import.meta.url);
  // Umbenannt ist nur der Name, nie der gespeicherte Wert: Nutzer- und
  // Haushalts-Layouts (DB, Layout-Hinweis im Geraet) tragen '2x1' - wanderte der
  // Wert mit, verloeren Bestandsinstallationen ihre Kachelgroessen.
  assert.deepEqual(WIDGET_SIZE_PRESETS.map((p) => p.value), ['1x1', '2x1', '1x2', '2x2'],
    'die gespeicherten Groessenwerte bleiben, wie sie sind');
  const wide = WIDGET_SIZE_PRESETS.find((p) => p.value === '2x1');
  assert.ok(wide, '2x1 ist keine waehlbare Groesse mehr - der Test prueft dann nichts');
  assert.doesNotMatch(wide.labelKey, /narrow/i, '2 Spalten x 1 Zeile ist breit, nicht schmal');
  const label = (locale, key) => key.split('.').reduce((o, k) => o?.[k],
    JSON.parse(readFileSync(new URL(`${locale}.json`, dir), 'utf8')));
  assert.match(label('de', wide.labelKey), /^Breit\b/);
  assert.match(label('en', wide.labelKey), /^Wide\b/);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const locale = file.slice(0, -5);
    const names = WIDGET_SIZE_PRESETS.map((p) => label(locale, p.labelKey).replace(/\s*\(.*\)$/, ''));
    assert.equal(new Set(names).size, names.length, `${locale}: zwei Groessen heissen gleich (${names.join(', ')})`);
  }
});

// --------------------------------------------------------
// Ein einfacher Bindestrich in Faelligkeit und Leerwerten (#1455)
// --------------------------------------------------------
// `formatDueDate` verband seine vier beschrifteten Zweige mit einem Halbgeviert
// (U+2013), der leere Mahlzeiten-Slot trug einen Geviertstrich (U+2014) und die
// Sparquote ohne Einnahmen wieder einen Halbgeviert. Erledigt hat es #1472 mit
// einem Textwaechter ueber die Seiten (test-frontend-audit.js); dieser Test
// misst die AUSGABE unter fester Uhr, Zweig fuer Zweig.
const TYPO_DASH = /[–—]/;

test('#1455: formatDueDate verbindet jeden beschrifteten Zweig mit "-"', () => {
  const branches = [];
  at('2026-09-24T08:00:00Z', 'Europe/Berlin', () => {
    // 10:00 in Berlin.
    branches.push(['ueberfaellig', __test.formatDueDate('2026-09-23', '18:00')]);
    branches.push(['heute mit Uhrzeit', __test.formatDueDate('2026-09-24', '18:00')]);
    branches.push(['morgen mit Uhrzeit', __test.formatDueDate('2026-09-25', '09:00')]);
  });
  at('2026-09-24T21:00:00Z', 'Europe/Berlin', () => {
    // 23:00 in Berlin: morgen 22:30 liegt unter 24 Stunden voraus.
    branches.push(['bald (morgen spaet)', __test.formatDueDate('2026-09-25', '22:30')]);
  });
  const keys = ['dashboard.overdue', 'dashboard.dueToday', 'dashboard.dueTomorrow', 'dashboard.dueSoon'];
  for (const [name, label] of branches) {
    assert.ok(label?.text, `${name}: kein Label`);
    assert.doesNotMatch(label.text, TYPO_DASH, `${name}: ${label.text}`);
    // Welches Bindezeichen, legt dieser Test nicht fest - die Aufgabenseite
    // verbindet inzwischen mit „·" (#1492); hier zaehlt nur: kein Gedankenstrich.
    assert.ok(keys.some((key) => label.text.startsWith(key) && label.text.length > key.length),
      `${name}: "<Zustand> <Bindezeichen> <Wann>" erwartet, bekam ${label.text}`);
  }
  assert.equal(branches.length, 4, 'Reichweite: vier Zweige gemessen');
});

test('#1455: leerer Mahlzeiten-Slot und Sparquote ohne Einnahmen zeigen "-"', () => {
  const meals = __test.renderTodayMeals([], ['breakfast']);
  const empty = /meal-slot__title--empty">([^<]*)</.exec(meals)?.[1];
  assert.equal(empty, '-', `leerer Slot: ${empty}`);

  const budget = __test.renderBudgetWidget({ income: 0, expenses: 120, balance: -120, entryCount: 3 }, 'EUR');
  assert.doesNotMatch(budget, TYPO_DASH, 'die Budget-Kachel traegt keinen Halbgeviert');
  assert.match(budget, /<strong>-<\/strong>/, 'die Sparquote ohne Einnahmen ist ein einfacher Bindestrich');
});

// --------------------------------------------------------
// Geburtstage, Countdowns, letzter Besuch und Zyklus (#1454)
// --------------------------------------------------------
// Die Geburtstagszeile schrieb `formatDate` - immer mit Jahr, auch drei Tage
// voraus („26.09.2026 · 3 Tage") -, waehrend der Termin daneben „Sa." sagte.
// Dieselbe Stufung wie `relativeDateLabel` gilt jetzt fuer alles Kommende der
// Uebersicht; der letzte Besuch liest rueckwaerts (`earnedWhenLabel`). Nennt
// die Zeile daneben schon „Heute"/„Morgen", steht das Wort einmal da.
const metaOf = (html, cls) => [...html.matchAll(new RegExp(`class="${cls}">([^<]*)<`, 'g'))].map((m) => m[1]);

test('#1454: die Geburtstagszeile sagt Wochentag, Tag+Monat oder Datum mit Jahr', () => {
  at(CRITIQUE_NOW, 'Europe/Berlin', () => {
    globalThis.__locale = 'de';
    const html = renderUpcomingBirthdays([
      { name: 'Heute', days_until: 0, next_date: '2026-09-23', kind: 'birthday' },
      { name: 'Samstag', days_until: 3, next_date: '2026-09-26', kind: 'birthday' },
      { name: 'Oktober', days_until: 22, next_date: '2026-10-15', kind: 'birthday' },
      { name: 'Januar', days_until: 104, next_date: '2027-01-05', kind: 'birthday' },
    ], '1x2', 4);
    assert.deepEqual(metaOf(html, 'birthday-widget-item__meta'), [
      'common.today',
      `${wd('2026-09-26')} · dashboard.daysLeft{"count":3}`,
      'DM:2026-10-15 · dashboard.daysLeft{"count":22}',
      '2027-01-05 · dashboard.daysLeft{"count":104}',
    ]);
  });
});

test('#1454: ueber den Tag der Geburtstagszeile entscheidet die Haushaltszone', () => {
  const row = [{ name: 'Mi', days_until: 6, next_date: '2026-09-30', kind: 'birthday' }];
  // Derselbe Zeitpunkt: in Berlin noch der 23. (sieben Tage bis zum 30.), auf
  // Kiritimati schon der 24. (sechs Tage - der Wochentag).
  at(CRITIQUE_NOW, 'Europe/Berlin', () => {
    assert.match(metaOf(renderUpcomingBirthdays(row, '1x1', 1), 'birthday-widget-item__meta')[0], /^DM:2026-09-30 · /);
  });
  at(CRITIQUE_NOW, 'Pacific/Kiritimati', () => {
    globalThis.__locale = 'de';
    assert.equal(metaOf(renderUpcomingBirthdays(row, '1x1', 1), 'birthday-widget-item__meta')[0].split(' · ')[0], wd('2026-09-30'));
  });
});

test('#1454: Countdown-Zeilen folgen derselben Stufung und sagen „Heute" nicht zweimal', () => {
  const prevWindow = global.window;
  global.window = { yuvomi: { isModuleDisabled: () => false } };
  try { at(CRITIQUE_NOW, 'Europe/Berlin', () => {
    globalThis.__locale = 'de';
    const html = __test.renderCountdowns([
      { id: 1, source: 'task', title: 'Heute', date: '2026-09-23', days_until: 0 },
      { id: 2, source: 'event', title: 'Samstag', date: '2026-09-26', days_until: 3 },
      { id: 3, source: 'event', title: 'Oktober', date: '2026-10-15', days_until: 22 },
    ], '1x2', 3);
    assert.deepEqual(metaOf(html, 'countdown-item__meta'), [wd('2026-09-26'), 'DM:2026-10-15'],
      'der Countdown von heute traegt keine zweite „Heute"-Zeile neben dem Zaehler');
  }); } finally {
    global.window = prevWindow;
  }
});

test('#1454: der letzte Besuch liest rueckwaerts, ohne Jahr', () => {
  const prevWindow = global.window;
  global.window = { yuvomi: { isModuleDisabled: () => false } };
  try {
    at(CRITIQUE_NOW, 'Europe/Berlin', () => {
      const hk = (lastVisit) => ({ configured: true, present: false, unpaidAmount: 0, visitsThisMonth: 3, lastVisit });
      // Zwei Kacheln, sonst ist es keine Reihe (selectMetricTiles).
      const health = { hasMeds: true, dosesTotal: 1, dosesTaken: 0, dosesSkipped: 0, lowStockCount: 0, nextDose: { time: '22:00', name: 'X' } };
      const note = (lastVisit) => __test.selectMetricTiles({ health, housekeeping: hk(lastVisit) }, 'EUR')
        .find((tile) => tile.id === 'housekeeping').note;
      assert.equal(note('2026-09-22T07:00:00.000Z'), 'dashboard.housekeepingLastVisit{"date":"common.yesterday"}');
      assert.equal(note('2026-09-10T07:00:00.000Z'), 'dashboard.housekeepingLastVisit{"date":"DM:2026-09-10T07:00:00.000Z"}');
      const widget = __test.renderHousekeepingWidget(hk('2026-09-22T07:00:00.000Z'), 'EUR');
      assert.match(widget, /dashboard\.housekeepingLastVisit\{"date":"common\.yesterday"\}/,
        'Kachel und Widget sagen dasselbe');
    });
  } finally {
    global.window = prevWindow;
  }
});

test('#1454: der naechste Zyklusbeginn sagt den Wochentag', () => {
  at(CRITIQUE_NOW, 'Europe/Berlin', () => {
    globalThis.__locale = 'de';
    // Letzter Beginn 29.08., 28 Tage Zyklus: naechster am 26.09., in drei Tagen.
    const html = __test.renderCycleWidget({ periods: [{ start_date: '2026-08-29', end_date: '2026-09-02' }], settings: {} });
    const date = metaOf(html, 'cycle-widget__date')[0];
    assert.ok(date, 'Reichweite: das Datum steht in der Kachel');
    assert.equal(date, wd('2026-09-26'), `Wochentag statt Datum mit Jahr, bekam ${date}`);
  });
});

// --------------------------------------------------------
// Heute-Blatt: ein Check-in von gestern nennt sein Datum (#1452)
// --------------------------------------------------------
// Die Kennzahl-Kachel sagte „23.09., 08:30", das Heute-Blatt fuer dieselbe
// offene Sitzung nur „seit 08:30" und sortierte sie zwischen die heutigen
// 08:00- und 09:00-Zeilen - als waere die Hilfe heute frueh gekommen. Beide
// lesen jetzt EINEN Helfer (utils/day-label.js), und ein Beginn vor heute
// steht oben bei den ganztaegigen Zeilen.
async function withSheet(fn) {
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const prevWindow = global.window;
  global.window = { yuvomi: { isModuleDisabled: () => false } };
  setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });
  try {
    return fn();
  } finally {
    clearPermissions();
    global.window = prevWindow;
  }
}

const SINCE_YESTERDAY = '2026-09-23T06:30:00.000Z'; // 08:30 in Berlin
const hkRow = (now) => __test.buildTodayCockpitModel({
  housekeeping: { configured: true, present: true, presentSince: SINCE_YESTERDAY, workerName: 'Maria', visitsThisMonth: 9 },
}, [], { now }).rows.find((row) => row.kind === 'housekeeping');
const tileNote = () => __test.selectMetricTiles({
  health: { hasMeds: true, dosesTotal: 1, dosesTaken: 0, dosesSkipped: 0, lowStockCount: 0, nextDose: { time: '22:00', name: 'X' } },
  housekeeping: { configured: true, present: true, presentSince: SINCE_YESTERDAY, visitsThisMonth: 9 },
}, 'EUR').find((tile) => tile.id === 'housekeeping').note;
const timeParam = (text) => JSON.parse(String(text).replace(/^[^{]*/, '')).time;

test('#1452: der Check-in von gestern steht im Heute-Blatt mit Datum und oben', () => withSheet(() => {
  at('2026-09-24T19:18:00Z', 'Europe/Berlin', () => {
    const row = hkRow(new Date());
    assert.ok(row, 'Reichweite: die Haushaltshilfe steht im Blatt');
    assert.match(row.timeLabel, /DM:2026-09-23, /, `das Datum steht da, bekam ${row.timeLabel}`);
    assert.equal(timeParam(row.timeLabel), timeParam(tileNote()), 'dieselbe Angabe wie die Kennzahl-Kachel');
    assert.equal(row.sortKey, '00:01', 'ein Beginn vor heute sortiert nicht auf 08:30 in den heutigen Tag');
  });
}));

test('#1452: am selben Tag bleibt es bei der Uhrzeit', () => withSheet(() => {
  at('2026-09-23T19:18:00Z', 'Europe/Berlin', () => {
    const row = hkRow(new Date());
    assert.equal(timeParam(row.timeLabel), SINCE_YESTERDAY, 'nur die Uhrzeit (Formatierer-Stub: der Wert selbst)');
    assert.equal(row.sortKey, '08:30');
  });
}));

test('#1452: ob der Check-in von heute ist, entscheidet die Haushaltszone', () => withSheet(() => {
  // Derselbe Zeitpunkt, 2026-09-23T20:00Z, und derselbe Check-in (06:30Z):
  // in Berlin ist beides der 23. (08:30 und 22:00) - heute, nur die Uhrzeit;
  // in Honolulu begann die Sitzung am 22. um 20:30, und jetzt ist der 23.
  at('2026-09-23T20:00:00Z', 'Europe/Berlin', () => {
    const row = hkRow(new Date());
    assert.equal(timeParam(row.timeLabel), SINCE_YESTERDAY, 'Berlin: heute, nur die Uhrzeit');
    assert.equal(row.sortKey, '08:30');
  });
  at('2026-09-23T20:00:00Z', 'Pacific/Honolulu', () => {
    const row = hkRow(new Date());
    assert.match(row.timeLabel, /DM:2026-09-22, /, `Honolulu: gestern, mit Datum - bekam ${row.timeLabel}`);
    assert.equal(row.sortKey, '00:01');
  });
}));

// --------------------------------------------------------
// #1607: die Budget-Kachel fuehrt auf die Monatsuebersicht
// --------------------------------------------------------
// Das Budget merkt sich seinen zuletzt offenen Reiter (Modul-Singleton). Wer
// zuletzt in der Statistik stand, landete ueber „Eintrag hinzufuegen" der
// Kachel dort - auf einem Reiter ohne Anlegen. Die Kachel zeigt Einnahmen,
// Ausgaben und Saldo des Monats, also nennt jeder ihrer Wege diesen Reiter.
const routesOf = (html) => [...html.matchAll(/data-route="([^"]*)"/g)].map((m) => m[1]);

test('#1607: jeder Weg aus der Budget-Kachel nennt den Reiter der Monatsuebersicht', () => {
  const leer = routesOf(__test.renderBudgetWidget({ entryCount: 0 }, 'EUR'));
  assert.equal(leer.length, 2, `Reichweite: Kopf-Link und „Eintrag hinzufuegen", bekam ${leer}`);
  assert.deepEqual([...new Set(leer)], ['/budget?tab=budget']);

  const gefuellt = routesOf(__test.renderBudgetWidget({ income: 100, expenses: 40, balance: 60, entryCount: 2 }, 'EUR'));
  assert.ok(gefuellt.length >= 1, 'Reichweite: der Kopf-Link');
  assert.deepEqual([...new Set(gefuellt)], ['/budget?tab=budget']);
});

test('#1607: die Kennzahl-Kachel „Monatssaldo" nennt denselben Reiter', () => {
  const prevWindow = global.window;
  global.window = { yuvomi: { isModuleDisabled: () => false } };
  try {
    // Zwei Kacheln, sonst ist es keine Reihe (selectMetricTiles).
    const tile = __test.selectMetricTiles({
      budget: { income: 100, expenses: 40, balance: 60, entryCount: 2 },
      housekeeping: { configured: true, present: false, visitsThisMonth: 4 },
    }, 'EUR').find((entry) => entry.id === 'budget');
    assert.ok(tile, 'Reichweite: die Budget-Kachel steht in der Reihe');
    assert.equal(tile.route, '/budget?tab=budget');
  } finally {
    global.window = prevWindow;
  }
});

test('#1607: der Reiter aus der Kachel ist einer, den das Budget kennt', async () => {
  globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
  globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
  globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };
  const { __test: budget } = await import('../public/pages/budget.js');
  assert.equal(budget.tabFromQuery('?tab=budget'), 'budget');
});
