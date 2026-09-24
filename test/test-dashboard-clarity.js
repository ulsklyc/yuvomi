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
