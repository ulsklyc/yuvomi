/**
 * Modul: Welches Vorkommen ein angetippter Serientermin meint (#1607, Punkt 2)
 * Zweck: Die Vorkommen einer Serie tragen alle die id ihrer Stammzeile. Monat,
 *        Woche und Tag suchten den angetippten Termin nur ueber diese id und
 *        bekamen das ERSTE geladene Vorkommen - bei einer taeglichen Serie den
 *        Randtag des Ladefensters, einen Tag vor dem sichtbaren Bereich. Wer
 *        den 17. antippte, sah, bearbeitete und loeschte („nur diesen Termin")
 *        den 14.
 *
 *        GEMESSEN WIRD AM AUFRUFER. Die Ansicht entsteht aus dem echten
 *        Renderer, der Chip aus dem Markup, das er schreibt (Klassen und
 *        data-Attribute, nichts von Hand gesetzt), und geklickt wird ueber den
 *        Listener, den die Ansicht selbst angehaengt hat. Heraus kommt, was die
 *        Detailansicht zeigt, womit das Formular aufgeht und welches Vorkommen
 *        der Loeschdialog nennt. Gestubt sind nur die Huellen (Detailansicht,
 *        Modal) - test-browser-loader.mjs.
 *
 *        Alle Zeitpunkte sind zonenlose Wanduhrzeit an festen Tagen, „heute"
 *        steht im Zustand: nichts haengt an der Uhr des Laufs.
 * Ausfuehren: npm run test:calendar-occurrence-scope
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = () => ({ matches: false });
globalThis.window.yuvomi = { showToast: () => {} };
// Der Monat misst seine Zellen; ohne Layout gibt es nichts zu messen.
globalThis.ResizeObserver = globalThis.ResizeObserver ?? class { observe() {} disconnect() {} };

const { __test: calendar } = await import('../public/pages/calendar.js');
const { scopeQuestion, settles } = await import('./calendar-scope-question.js');
const { dayHeadingLabel } = await import('../public/utils/day-label.js');

const SERIES_ID = 77;
// Der 14. ist der Randtag: das Ladefenster reicht einen Tag vor die sichtbare
// Woche (fetchWindow), und genau dort landete jeder Klick.
const DAYS = ['14', '15', '16', '17', '18', '19', '20', '21', '22'].map((d) => `2026-06-${d}`);

function occurrence(day, { allDay = false } = {}) {
  return {
    id: SERIES_ID,
    series_id: SERIES_ID,
    title: 'Training',
    start_datetime: allDay ? day : `${day}T09:00`,
    end_datetime: allDay ? day : `${day}T10:00`,
    all_day: allDay ? 1 : 0,
    recurrence_rule: 'FREQ=DAILY',
    recurrence_id: day,
    is_recurring_instance: day === DAYS[0] ? 0 : 1,
    is_series_start: day === DAYS[0] ? 1 : 0,
    is_local_recurring_series: true,
    can_override_occurrence: true,
    external_source: 'local',
    assigned_users: [],
  };
}

function withState(extra, fn) {
  const previous = { ...calendar.state };
  Object.assign(calendar.state, {
    cursor: '2026-06-17',
    today: '2026-06-17',
    weekStart: 0,
    scheduleDisplay: 'compact',
    layerSchedule: false,
    layerBirthdays: true,
    layerHolidays: false,
    layerSchool: false,
    layerWaste: false,
    assignedToMe: false,
    people: new Set(),
    hiddenSources: new Set(),
    events: [],
    tasks: [],
    holidays: [],
    users: [],
    scheduleEntries: [],
    ...extra,
  });
  return Promise.resolve().then(fn).finally(() => Object.assign(calendar.state, previous));
}

/** Rendert eine Ansicht und haelt Markup und Listener fest. */
function mount(render) {
  let html = '';
  const nodes = new Map();
  const node = (sel) => {
    if (!nodes.has(sel)) {
      nodes.set(sel, {
        listeners: [],
        addEventListener(type, fn) { this.listeners.push({ type, fn }); },
        getBoundingClientRect: () => ({ top: 0, height: 1440 }),
        dataset: {},
        scrollTop: 0,
        closest: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        children: [],
        append() {},
      });
    }
    return nodes.get(sel);
  };
  const container = {
    replaceChildren() {},
    insertAdjacentHTML(_position, markup) { html += markup; },
    querySelector: node,
    querySelectorAll: () => [],
  };
  render(container);
  const fire = (sel, type, event) => {
    for (const l of node(sel).listeners) if (l.type === type) l.fn(event);
  };
  return { html: () => html, fire };
}

const ATTR = /([\w-]+)="([^"]*)"/g;

/**
 * Die Chips der Serie, so wie das Markup sie traegt: Klassen und dataset aus
 * dem geschriebenen Tag, dazu der Tag der Spalte bzw. Zelle, in der er steht
 * (das letzte `data-date` davor).
 */
function chipsOf(html, className) {
  const chips = [];
  const tag = new RegExp(`<div class="([^"]*\\b${className}\\b[^"]*)"([^>]*)>`, 'g');
  for (const m of html.matchAll(tag)) {
    const attrs = Object.fromEntries([...m[2].matchAll(ATTR)].map(([, k, v]) => [k, v]));
    if (attrs['data-id'] !== String(SERIES_ID)) continue;
    const dataset = {};
    for (const [name, value] of Object.entries(attrs)) {
      if (name.startsWith('data-')) dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
    }
    const classes = m[1].split(/\s+/).filter(Boolean);
    const el = { dataset, classes };
    const has = (selector) => selector.split(',').some((part) => {
      const cls = /\.([\w-]+)\s*$/.exec(part.trim())?.[1];
      // Ein Nachfahren-Selektor (`.month-bands .cal-band`) trifft den Chip
      // nur, wenn er ein Band ist - das sagt seine eigene Klasse.
      return cls && classes.includes(cls) && (!/\s/.test(part.trim()) || classes.includes('cal-band'));
    });
    el.closest = (selector) => (has(selector) ? el : null);
    el.matches = (selector) => has(selector);
    const before = html.slice(0, m.index);
    let column;
    if (className === 'allday-event') {
      // Die Zellen der Ganztagszeile tragen keinen Tag, nur ihre Reihenfolge:
      // die n-te Zelle gehoert zur n-ten Tagesspalte des Rasters darunter.
      const cell = (before.match(/class="allday-cell"/g) ?? []).length - 1;
      column = [...html.matchAll(/class="week-view__col" data-date="(\d{4}-\d{2}-\d{2})"/g)][cell]?.[1] ?? null;
    } else {
      column = [...before.matchAll(/data-date="(\d{4}-\d{2}-\d{2})"/g)].at(-1)?.[1] ?? null;
    }
    chips.push({ el, column });
  }
  return chips;
}

/**
 * Der Tag, den die geoeffnete Detailansicht nennt. Seit R18 steht WANN im Kopf
 * und in Worten (`dayHeadingLabel`: "Heute", sonst Wochentag mit Datum) statt
 * als Zeile mit Tagesschluessel - gesucht wird deshalb der Tag der Reihe,
 * dessen Wort die Unterzeile anfuehrt. Jeder Tag hat sein eigenes Wort.
 */
function shownDay(options) {
  const when = options.head?.subtitle;
  assert.ok(when, 'die Detailansicht nennt im Kopf nicht, wann der Termin ist');
  assert.equal(options.head.subtitleLabel, 'calendar.detailWhen', 'Screenreader hoeren weiter "Wann"');
  const hits = DAYS.filter((day) => String(when).startsWith(dayHeadingLabel(day)));
  assert.equal(hits.length, 1, `"${when}" nennt genau einen Tag der Reihe (${hits.join(', ')})`);
  return hits[0];
}

/** Klickt einen Chip ueber den Listener der Ansicht; liefert die geoeffnete Detailansicht. */
function open(view, sel, type, el, extra = {}) {
  let opened = null;
  globalThis.__openDetailView = (options) => { opened = options; };
  globalThis.__apiStub = { get: async () => ({ data: [] }) };
  try {
    view.fire(sel, type, { target: el, preventDefault() {}, stopPropagation() {}, ...extra });
  } finally {
    delete globalThis.__openDetailView;
  }
  return opened;
}

const VIEWS = [
  { name: 'Woche, Zeitblock', view: 'week', render: 'renderWeekView', chip: 'week-event', sel: '#week-cols', type: 'click' },
  { name: 'Woche, Tastatur', view: 'week', render: 'renderWeekView', chip: 'week-event', sel: '.week-view', type: 'keydown', extra: { key: 'Enter' }, self: true },
  { name: 'Woche, Ganztagszeile', view: 'week', render: 'renderWeekView', chip: 'allday-event', sel: '.allday-row', type: 'click', allDay: true },
  { name: 'Tag, Zeitblock', view: 'day', render: 'renderDayView', chip: 'day-event', sel: '#day-col', type: 'click' },
  { name: 'Monat, Chip', view: 'month', render: 'renderMonthView', chip: 'month-day__event', sel: '#month-grid', type: 'click', cell: '.month-day' },
];

for (const spec of VIEWS) {
  test(`${spec.name}: jeder Chip oeffnet das Vorkommen SEINES Tages`, async () => {
    await withState({ view: spec.view, events: DAYS.map((d) => occurrence(d, { allDay: spec.allDay })) }, () => {
      const view = mount((c) => calendar[spec.render](c));
      const chips = chipsOf(view.html(), spec.chip);
      assert.ok(chips.length >= 1, `die Ansicht zeigt keinen Chip der Serie (${spec.chip})`);
      if (spec.view !== 'day') {
        assert.ok(chips.length >= 3, `die Ansicht zeigt nur ${chips.length} Chip(s) - zu wenig, um Vorkommen zu unterscheiden`);
      }
      const seen = [];
      for (const chip of chips) {
        if (spec.self) chip.el.closest = (s) => (/role="button"/.test(s) ? chip.el : null);
        if (spec.cell) {
          // Der Chip steht in seiner Tageszelle; der Listener fragt zuerst nach ihr.
          const inChip = chip.el.closest;
          chip.el.closest = (s) => (s === spec.cell ? { dataset: { date: chip.column } } : inChip(s));
        }
        const opened = open(view, spec.sel, spec.type, chip.el, spec.extra);
        assert.ok(opened, `der Chip am ${chip.column} oeffnete nichts`);
        assert.equal(shownDay(opened), chip.column, `der Chip am ${chip.column} oeffnete ein anderes Vorkommen`);
        seen.push(shownDay(opened));
      }
      assert.equal(new Set(seen).size, chips.length, 'jedes Vorkommen genau einmal');
      delete globalThis.__apiStub;
    });
  });
}

test('Woche: der Loeschdialog des angetippten Chips nennt dessen Tag, nicht den Randtag', async () => {
  await withState({ view: 'week', events: DAYS.map((d) => occurrence(d)) }, async () => {
    const view = mount((c) => calendar.renderWeekView(c));
    const chip = chipsOf(view.html(), 'week-event').find((c) => c.column === '2026-06-17');
    assert.ok(chip, 'der 17. steht in der Woche');
    const opened = open(view, '#week-cols', 'click', chip.el);
    const remove = opened.actions.find((a) => a.id === 'detail-delete');
    assert.ok(remove, 'die Detailansicht bietet Loeschen an');

    const question = scopeQuestion('cancel');
    const calls = [];
    globalThis.__apiStub = { get: async () => ({ data: [] }), delete: async (path) => { calls.push(path); return { data: null }; } };
    try {
      await settles(remove.onClick({ close: async () => {} }), 'Loeschen');
    } finally {
      question.uninstall();
      delete globalThis.__apiStub;
    }
    const line = String(question.dialogs[0]?.options.content ?? '');
    const named = /calendar\.recurringScopeOccurrence[^<]*?(\d{4}-\d{2}-\d{2})/.exec(line)?.[1];
    assert.equal(named, '2026-06-17', 'der Dialog nennt das angetippte Vorkommen');
    assert.deepEqual(calls, [], 'Abbrechen loescht nichts');
  });
});

test('Woche: Bearbeiten oeffnet das Formular mit dem Tag des angetippten Chips', async () => {
  await withState({ view: 'week', events: DAYS.map((d) => occurrence(d)) }, async () => {
    const view = mount((c) => calendar.renderWeekView(c));
    const chip = chipsOf(view.html(), 'week-event').find((c) => c.column === '2026-06-17');
    const opened = open(view, '#week-cols', 'click', chip.el);
    const forms = [];
    globalThis.__openModal = (options) => forms.push(options);
    globalThis.__apiStub = { get: async () => ({ data: [] }) };
    try {
      await settles(opened.edit.standalone(), 'Bearbeiten');
    } finally {
      delete globalThis.__openModal;
      delete globalThis.__apiStub;
    }
    const content = String(forms[0]?.content ?? '');
    assert.match(content, /2026-06-17/, 'das Formular traegt den angetippten Tag');
    assert.doesNotMatch(content, /2026-06-14/, 'und nicht den Randtag des Ladefensters');
  });
});

test('ein Chip ohne passendes Vorkommen oeffnet NICHTS statt eines anderen Vorkommens', () => {
  const events = DAYS.map((d) => occurrence(d));
  assert.equal(calendar.eventForChip({ dataset: { id: String(SERIES_ID), occurrence: '2026-07-01T09:00' } }, events), null);
  assert.equal(calendar.eventForChip({ dataset: { id: String(SERIES_ID) } }, events), null,
    'ohne das Attribut ist die id einer Serie nicht eindeutig');
  const single = { id: 5, title: 'Einzeln', start_datetime: '2026-06-17T09:00' };
  assert.equal(calendar.eventForChip({ dataset: { id: '5' } }, [single]), single,
    'ein Einzeltermin ist ueber seine id eindeutig');
});

test('keine Ansicht loest einen Chip mehr nur ueber seine id auf', () => {
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const hits = src.match(/events\.find\(\(\w+\) => \w+\.id === parseInt\(\w+\.dataset\.id/g) ?? [];
  assert.deepEqual(hits, [], 'ein Chip nennt sein Vorkommen ueber eventForChip()');
});
