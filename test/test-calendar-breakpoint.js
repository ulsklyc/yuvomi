/**
 * Modul: Der Kalender ueber die Telefonschwelle (#1504)
 * Zweck: Die Woche ist am Telefon ein 3-Tage-Fenster um den Cursor und am
 *        Desktop die ganze Woche; Label, Pfeile und Ladefenster folgen
 *        derselben Query. Beim Wechsel ueber die Schwelle zeichnete nur der
 *        Monat neu. Gemessen im Browser: 1280 -> 390 liess sieben Spalten zu
 *        je 49px unter "KW 41" stehen, 390 -> 1280 drei Spalten zu je 311px
 *        unter der Tagesspanne.
 *
 *        GEMESSEN WIRD AM AUFRUFER: der Listener, den die Seite an die
 *        MediaQueryList haengt, laeuft gegen den echten Renderer; gezaehlt
 *        werden die Spalten im Markup, das er schreibt, gelesen wird das
 *        Label, das er setzt, und die Abfragen, die er schickt. Gestubt sind
 *        nur die Huellen (Container, matchMedia, api) - test-browser-loader.mjs.
 *
 *        Feste Tage, "heute" steht im Zustand: nichts haengt an der Uhr.
 * Ausfuehren: npm run test:calendar-breakpoint
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let phone = false;
globalThis.window = globalThis.window ?? {};
// Jede Query der Seite, die nach der Telefonbreite fragt, folgt dem Schalter.
globalThis.window.matchMedia = (query) => ({ matches: /max-width:\s*639px/.test(String(query)) ? phone : false });
globalThis.window.yuvomi = { showToast: () => {} };
globalThis.ResizeObserver = globalThis.ResizeObserver ?? class { observe() {} disconnect() {} };

const { __test: calendar } = await import('../public/pages/calendar.js');

function node() {
  const classes = new Set();
  const attrs = {};
  return {
    html: '',
    textContent: '',
    title: '',
    dataset: {},
    scrollTop: 0,
    children: [],
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on) => { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return attrs[k] ?? null; },
    removeAttribute(k) { delete attrs[k]; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 1440 }),
    closest: () => null,
    querySelector() { return node(); },
    querySelectorAll: () => [],
    append() {},
    remove() {},
    focus() {},
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_position, markup) { this.html += markup; },
  };
}

/** Die Seite, so weit der Wechsel sie anfasst: Koerper, Label, Pfeile. */
function mountPage() {
  const parts = { '#cal-body': node(), '#cal-label': node(), '#cal-prev': node(), '#cal-next': node(), '#calendar-page': node() };
  const container = {
    isConnected: true,
    querySelector: (sel) => parts[sel] ?? null,
    querySelectorAll: () => [],
  };
  calendar.setContainerForTest(container);
  return {
    columns: () => [...parts['#cal-body'].html.matchAll(/class="week-view__col" data-date="(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]),
    label: () => parts['#cal-label'].textContent,
    nextLabel: () => parts['#cal-next'].getAttribute('aria-label'),
  };
}

async function withWeek({ cursor }, fn) {
  const previous = { ...calendar.state };
  Object.assign(calendar.state, {
    view: 'week', cursor, today: cursor, weekStart: 1, loadError: null,
    scheduleDisplay: 'compact', layerSchedule: false, layerBirthdays: true, layerHolidays: false,
    layerSchool: false, layerWaste: false, assignedToMe: false,
    people: new Set(), hiddenSources: new Set(),
    events: [], tasks: [], holidays: [], users: [], scheduleEntries: [],
  });
  // Geladen ist das Fenster der Fassung, in der die Seite VOR dem Wechsel stand.
  const loaded = calendar.getRangeForView('week', cursor);
  calendar.state.rangeFrom = loaded.from;
  calendar.state.rangeTo = loaded.to;
  const requests = [];
  globalThis.__apiStub = { get: async (path) => { requests.push(String(path)); return { data: [] }; } };
  try {
    await fn(requests);
  } finally {
    delete globalThis.__apiStub;
    calendar.setContainerForTest(null);
    Object.assign(calendar.state, previous);
    phone = false;
  }
}

// Mittwoch, 2026-06-17; die Woche beginnt am Montag (weekStart 1).
const WEEK = ['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21'];

test('Desktop -> Telefon: die Woche wird zum 3-Tage-Fenster, das Label nennt die Spanne', async () => {
  phone = false;
  await withWeek({ cursor: '2026-06-17' }, async () => {
    const page = mountPage();
    phone = true;
    await calendar.onPhoneQueryChange();
    assert.deepEqual(page.columns(), ['2026-06-16', '2026-06-17', '2026-06-18'], 'drei Spalten um den Cursor');
    assert.match(page.label(), /^calendar\.dayRangeLabel\b.*2026-06-16.*2026-06-18/, 'das Label nennt die sichtbaren Tage, nicht die KW');
    assert.equal(page.nextLabel(), calendar.periodArrowLabels(calendar.periodStepOf('week', { mobile: true })).next,
      'der Pfeil nennt den Schritt des 3-Tage-Fensters');
  });
});

test('Telefon -> Desktop: die Woche zeigt wieder sieben Tage unter der KW', async () => {
  phone = true;
  await withWeek({ cursor: '2026-06-17' }, async () => {
    const page = mountPage();
    phone = false;
    await calendar.onPhoneQueryChange();
    assert.deepEqual(page.columns(), WEEK, 'sieben Spalten, Montag bis Sonntag');
    assert.match(page.label(), /^calendar\.weekNumberLabel\b.*"week":25/, 'das Label nennt die Kalenderwoche');
    assert.equal(page.nextLabel(), calendar.periodArrowLabels(calendar.periodStepOf('week', { mobile: false })).next);
  });
});

test('Cursor am Wochenrand: das Telefonfenster reicht in die Nachbarwoche und wird nachgeladen', async () => {
  // Montag: am Telefon steht der Sonntag davor in der ersten Spalte - der
  // liegt ausserhalb der geladenen Desktop-Woche.
  phone = false;
  await withWeek({ cursor: '2026-06-15' }, async (requests) => {
    assert.equal(calendar.state.rangeFrom, '2026-06-15', 'geladen ist die Desktop-Woche ab Montag');
    const page = mountPage();
    phone = true;
    await calendar.onPhoneQueryChange();
    assert.deepEqual(page.columns(), ['2026-06-14', '2026-06-15', '2026-06-16']);
    assert.equal(calendar.state.rangeFrom, '2026-06-14', 'das geladene Fenster beginnt am ersten sichtbaren Tag');
    assert.ok(requests.some((p) => p.startsWith('/calendar?from=')), 'die Termine des neuen Fensters wurden geholt');
  });
});

test('Gleiches Fenster: der Wechsel zeichnet neu, ohne nachzuladen', async () => {
  phone = false;
  await withWeek({ cursor: '2026-06-17' }, async (requests) => {
    const page = mountPage();
    phone = true;
    await calendar.onPhoneQueryChange();
    assert.equal(page.columns().length, 3, 'neu gezeichnet wurde');
    assert.deepEqual(requests, [], 'mitten in der Woche deckt das geladene Fenster die drei Tage schon');
  });
});

// R17 Schritt 8: eingeklappt (Telefon) faltet die Suche ins Ansichtsmenue. Ihr
// Knopf ist dann `display: none` - `focus()` darauf tut nichts, und nach Esc in
// der Suche stand der Fokus auf dem Dokument. Er geht an den Menue-Knopf.
test('Suche schliessen: der Fokus geht an den Suchknopf, gefaltet an das Ansichtsmenue', () => {
  const stage = (visible) => {
    const focused = [];
    const menu = { focus: () => focused.push('menu') };
    const toolbar = { querySelector: (sel) => (sel === '[data-collapse-fold-menu]' ? menu : null) };
    const toggle = {
      setAttribute() {}, removeAttribute() {}, classList: { remove() {} },
      getClientRects: () => (visible ? [{}] : []),
      closest: (sel) => (sel === '.cal-toolbar' ? toolbar : null),
      focus: () => focused.push('search'),
    };
    const container = { querySelector: (sel) => (sel === '#cal-search' ? toggle : null) };
    calendar.closeSearchForTest(container);
    return focused;
  };
  assert.deepEqual(stage(true), ['search'], 'sichtbar: zurueck an den Knopf der Suche');
  assert.deepEqual(stage(false), ['menu'], 'gefaltet: an den Knopf, ueber den die Suche erreicht wurde');
});
