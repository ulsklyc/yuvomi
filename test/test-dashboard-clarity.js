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

// Refs #1818: die Kachel zeigt die zuletzt geaenderte Liste zuerst, die
// Einkaufsseite oeffnet ohne `?list=` die aelteste. Jede Zeile trug nur
// `/shopping` - der Tipp auf "Drogerie" oeffnete den Wocheneinkauf. Gemessen
// wird der ganze Weg: die gerenderte Zeile durch die echte Verdrahtung
// (`wireLinks`), Klick und Tastatur, bis zu dem Pfad, den der Router bekommt.
test('Einkauf: jede Listenzeile fuehrt zu IHRER Liste, per Klick und per Tastatur', () => {
  const lists = [
    { id: 7, name: 'Drogerie', open_count: 1, total_count: 1, items: [{ id: 70, name: 'Zahnpasta' }] },
    { id: 3, name: 'Baumarkt & "Garten"', open_count: 2, total_count: 4, items: [{ id: 30, name: 'Duebel' }] },
    { id: 1, name: 'Wocheneinkauf', open_count: 8, total_count: 10, items: [{ id: 10, name: 'Milch' }] },
  ];
  const html = __test.renderShoppingLists(lists, 23, 5);

  // Die gerenderten Elemente mit `data-route`, in Dokumentreihenfolge, als das,
  // was `querySelectorAll('[data-route]')` im Browser liefert.
  const unesc = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const elements = [...html.matchAll(/<([a-z]+)\b([^>]*\bdata-route="([^"]*)"[^>]*)>/g)].map((m) => {
    const listeners = {};
    return {
      tagName: m[1].toUpperCase(),
      id: '',
      isListRow: /class="shopping-widget-list"/.test(m[2]),
      attrs: m[2],
      dataset: { route: unesc(m[3]) },
      closest: () => null,
      addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
      fire: (type, event) => (listeners[type] ?? []).forEach((fn) => fn(event)),
    };
  });
  const rows = elements.filter((el) => el.isListRow);
  assert.equal(rows.length, 3, 'Reichweite: drei Listenzeilen stehen im Markup');
  for (const row of rows) {
    assert.match(row.attrs, /role="button"/, 'die Zeile bleibt per Tastatur erreichbar');
    assert.match(row.attrs, /tabindex="0"/);
  }

  const visited = [];
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  globalThis.window = { yuvomi: { navigate: (path) => { visited.push(path); } } };
  try {
    __test.wireLinks({ querySelectorAll: (sel) => (sel === '[data-route]' ? elements : []) }, () => {});
    const key = (k) => ({ key: k, preventDefault() {}, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 });
    // JEDE GESTE WIRD AN IHREM EIGENEN SCHRITT GEMESSEN (#1821). Bis hierher
    // las `target()` einfach den letzten Eintrag: eine Geste, die gar nicht
    // navigierte, bestand ihre Zusicherung am Wert der Geste davor, und rot
    // wurde erst die Summe am Ende - ohne zu sagen, WELCHE Geste fehlt.
    const gesture = (label, fire) => {
      const before = visited.length;
      fire();
      assert.equal(visited.length - before, 1, `${label}: navigiert genau einmal`);
      // Was die Einkaufsseite aus der Adresse liest (shopping.js): `?list=`.
      const url = new URL(visited.at(-1), 'http://yuvomi.test');
      return [url.pathname, url.searchParams.get('list')];
    };
    rows.forEach((row, i) => {
      const want = ['/shopping', String(lists[i].id)];
      const name = `"${lists[i].name}"`;
      assert.deepEqual(gesture(`Klick auf ${name}`, () => row.fire('click', key(''))), want, `Klick auf ${name}`);
      assert.deepEqual(gesture(`Enter auf ${name}`, () => row.fire('keydown', key('Enter'))), want, `Enter auf ${name}`);
      assert.deepEqual(gesture(`Leertaste auf ${name}`, () => row.fire('keydown', key(' '))), want, `Leertaste auf ${name}`);
    });
    assert.equal(visited.length, 9, 'jede Geste hat genau einmal navigiert');

    // Der Kachelkopf zaehlt ueber alle Listen und bleibt ein Sammelverweis.
    const header = elements.find((el) => /widget__link/.test(el.attrs));
    assert.ok(header, 'Reichweite: der Kachelkopf ist verlinkt');
    assert.equal(header.dataset.route, '/shopping');
  } finally {
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
});

// --------------------------------------------------------
// #1821: eine Zeile, die EINEN Eintrag zeigt, fuehrt zu ihm
// --------------------------------------------------------

/** Die `data-route`-Ziele eines Markups, in Dokumentreihenfolge und entschluesselt. */
function rowRoutesOf(html, className) {
  const unesc = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return [...html.matchAll(/<[a-z]+\b([^>]*\bdata-route="([^"]*)"[^>]*)>/g)]
    .filter((m) => new RegExp(`class="${className}(?:["\\s])`).test(m[1]))
    .map((m) => unesc(m[2]));
}

test('#1821 Notizen: jede Zeile fuehrt zu IHRER Notiz, der Kopf bleibt Sammelverweis', () => {
  const notes = [{ id: 12, title: 'WLAN', content: 'a', pinned: 1 }, { id: 5, title: 'Schule', content: 'b', pinned: 0 }];
  const html = __test.renderPinnedNotes(notes, '1x2', 2);
  assert.deepEqual(rowRoutesOf(html, 'note-item'), ['/notes?open=12', '/notes?open=5']);
  assert.deepEqual(rowRoutesOf(html, 'widget__link'), ['/notes']);
});

test('#1821 Geburtstage: jede Zeile fuehrt zu IHREM Anlass', () => {
  const rows = [
    { id: 4, name: 'Mike', next_birthday: '2026-11-02', days_until: 25, next_age: 41 },
    { id: 9, name: 'Lena', next_birthday: '2026-11-09', days_until: 32, next_age: 8 },
  ];
  const html = renderUpcomingBirthdays(rows, '1x2', 2);
  assert.deepEqual(rowRoutesOf(html, 'birthday-widget-item'), ['/birthdays?open=4', '/birthdays?open=9']);
});

test('#1821 Entsorgung: auch die Zeile OHNE naechsten Termin fuehrt zu ihrer Tonne', () => {
  const html = __test.renderWasteWidget({
    needsRefresh: false,
    items: [
      { type: { id: 3, name: 'Glas', sort_order: 1, color: null, icon: null }, next: null },
      { type: { id: 8, name: 'Papier', sort_order: 0, color: null, icon: null },
        next: { date_key: '2026-10-12', moved: false, coalesced: false, origins: [], deep_link: '?type=8&date=2026-10-12' } },
    ],
  }, '1x2');
  // Die Seite liest `?type=` ohne Datum und hebt dann die Karte der Tonne hervor
  // (parseDeepLinkParams / deepLinkSelectors in pages/waste.js).
  assert.deepEqual(rowRoutesOf(html, 'waste-widget-row'), ['/waste?type=8&date=2026-10-12', '/waste?type=3']);
});

test('#1821 Einkauf im Heute-Blatt: eine einzige Liste mit Offenem ist das Ziel, mehrere sind die Seite', () => withSheet(() => {
  const list = (id, open) => ({ id, name: `L${id}`, open_count: open, total_count: open, items: [] });
  const one = { shoppingLists: [list(7, 4)], shoppingOpenCount: 4, shoppingOpenLists: 1 };
  const two = { shoppingLists: [list(7, 4), list(2, 1)], shoppingOpenCount: 5, shoppingOpenLists: 2 };
  assert.equal(__test.shoppingSoleListRoute(one), '/shopping?list=7');
  assert.equal(__test.shoppingSoleListRoute(two), '/shopping');
  // Der Server kappt bei drei Listen: vier offene Listen duerfen nicht auf die
  // erste geladene zeigen, nur weil die Antwort sie zuerst nennt.
  assert.equal(__test.shoppingSoleListRoute({ ...one, shoppingOpenLists: 4 }), '/shopping');
  // Aelterer Server ohne Zaehler: lieber die Seite als eine geratene Liste.
  assert.equal(__test.shoppingSoleListRoute({ shoppingLists: [list(7, 4)] }), '/shopping');
  assert.equal(__test.shoppingSoleListRoute({}), '/shopping');

  // Durch den echten Aufrufer: die Schlusszeile des Blatts.
  const row = (data) => {
    const model = __test.buildTodayCockpitModel(data, [], { cap: __test.PROGRAM_ROW_CAP, groupOverdue: false });
    let found;
    JSON.stringify(model, (_, value) => {
      if (value && value.kind === 'shopping') found = value.route;
      return value;
    });
    return found;
  };
  assert.equal(row(one), '/shopping?list=7', 'Schlusszeile, eine Liste');
  assert.equal(row(two), '/shopping', 'Schlusszeile, zwei Listen');
}));

// --------------------------------------------------------
// #1821: eine Zeile mit Query im Ziel waermt ihr Modul vor
// --------------------------------------------------------

test('#1821 Prefetch: die Query faellt auch von `data-route` ab', async () => {
  const { prefetchPathOf } = await import('../public/utils/router-navigate.js');
  // Bis #1821 fiel sie nur von `data-nav-href` ab: diese Ziele fanden keine Route.
  assert.equal(prefetchPathOf({ route: '/shopping?list=7' }), '/shopping');
  assert.equal(prefetchPathOf({ route: '/calendar?open=3&date=2026-10-08' }), '/calendar');
  assert.equal(prefetchPathOf({ route: '/waste?type=2' }), '/waste');
  assert.equal(prefetchPathOf({ route: '/tasks' }), '/tasks');
  assert.equal(prefetchPathOf({ route: '/schedule/patterns' }), '/schedule/patterns');
  // `data-nav-href` gewinnt, wie beim Klick der Navigation.
  assert.equal(prefetchPathOf({ navHref: '/meals?week=1', route: '/kitchen' }), '/meals');
  assert.equal(prefetchPathOf({ route: '/notes#x' }), '/notes');
  assert.equal(prefetchPathOf({}), null);
  assert.equal(prefetchPathOf(null), null);
  assert.equal(prefetchPathOf({ route: '?x=1' }), null);

  // Der Aufrufer: der Hover-/Press-Handler der Shell reicht genau das weiter.
  const { readFileSync } = await import('node:fs');
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const handler = router.slice(router.indexOf('const prefetchFromEvent = (e) => {'));
  const body = handler.slice(0, handler.indexOf('};')).replace(/^\s*\/\/.*$/gm, '');
  assert.match(body, /prefetchRoute\(prefetchPathOf\(el\.dataset\)\)/);
  assert.doesNotMatch(body, /dataset\.route\)/, 'kein zweiter Weg mit der rohen Route');
});

test('#1821 Suche: ein Geburtstags-Treffer fuehrt zu SEINEM Anlass', async () => {
  const { SEARCH_SECTIONS } = await import('../public/utils/search-sections.js');
  const route = (bucket, item) => SEARCH_SECTIONS.find((s) => s.bucket === bucket).route(item, {});
  assert.equal(route('birthdays', { id: 4 }), '/birthdays?open=4');
  // Derselbe Parameter wie bei den Nachbarn mit Tiefenlink.
  assert.equal(route('notes', { id: 4 }), '/notes?open=4');
  assert.equal(route('contacts', { id: 4 }), '/contacts?open=4');
});

// --------------------------------------------------------
// #1821: wohin der Router den Fokus nach einer Navigation legt
// --------------------------------------------------------

/** Die echte Funktion des Routers, mit einem Dokument, das nur den Fokus kennt. */
async function navigateFocus({ path = '/', active, overlayOpen = false, inMain = [], atFrame = null }) {
  const { focusMainAfterNavigation } = await import('../public/utils/router-navigate.js');
  const frames = [];
  const focused = [];
  const doc = { activeElement: active };
  const main = {
    contains: (el) => el === main || inMain.includes(el),
    focus(options) { focused.push(options); doc.activeElement = main; },
  };
  doc.getElementById = (id) => (id === 'main-content' ? main : null);
  let overlay = overlayOpen;
  focusMainAfterNavigation(path, {
    document: doc,
    requestAnimationFrame: (cb) => { frames.push(cb); },
    hasOpenOverlay: () => overlay,
  });
  const queued = frames.length;
  const focusedBeforeFrame = focused.length;
  // Zwischen Aufbau und Frame: jemand tabbt in die Seite, die Seite oeffnet einen Dialog.
  atFrame?.({ doc, main, openOverlay: () => { overlay = true; } });
  frames.forEach((cb) => cb());
  return { queued, focusedBeforeFrame, focused, activeIsMain: doc.activeElement === main, active: doc.activeElement };
}

test('#1821 Router-Fokus: nach einer Navigation aus Seitenleiste oder Tableiste bekommt <main> den Fokus', async () => {
  // Der Zweck der Funktion - und der Rueckschritt, der mit den Ausnahmen unten
  // nicht passieren darf: der Fokus bliebe auf dem Link, der die Seite oeffnete.
  const navLink = { name: 'nav' };
  const fromNav = await navigateFocus({ active: navLink });
  assert.equal(fromNav.queued, 1, 'genau ein Frame');
  assert.equal(fromNav.focusedBeforeFrame, 0, 'gefragt und fokussiert wird IM Frame, nicht davor');
  assert.deepEqual(fromNav.focused, [{ preventScroll: true }]);
  assert.equal(fromNav.activeIsMain, true);

  // Die Zeile der ALTEN Seite ist mit ihr verschwunden: der Fokus liegt auf <body>.
  const body = { name: 'body' };
  assert.equal((await navigateFocus({ active: body })).activeIsMain, true);
  assert.equal((await navigateFocus({ active: null })).activeIsMain, true);
  // Ein Element ausserhalb von <main>, das kein Overlay ist (Suchfeld der Shell).
  assert.equal((await navigateFocus({ active: { name: 'shell-search' } })).activeIsMain, true);
});

test('#1821 Router-Fokus: wer schon auf einer Zeile der neuen Seite steht, bleibt dort', async () => {
  const row = { name: 'row' };
  // Schon beim Aufruf dort ...
  const there = await navigateFocus({ active: { name: 'nav' }, inMain: [row], atFrame: ({ doc }) => { doc.activeElement = row; } });
  assert.deepEqual(there.focused, [], '<main> zieht den Fokus nicht von der Zeile ab');
  assert.equal(there.active, row);
  // ... und <main> selbst zaehlt nicht als "in der Seite".
  const onMain = await navigateFocus({ active: null, atFrame: ({ doc, main }) => { doc.activeElement = main; } });
  assert.equal(onMain.focused.length, 1);
});

test('#1821 Router-Fokus: ein Dialog, den die neue Seite oeffnet, behaelt den Fokus', async () => {
  // `/notes?open=5` im verdeckten Tab: der Dialog nimmt den Fokus, der Frame
  // des Routers ruht bis zum Zeigen des Tabs. Das Overlay liegt AUSSERHALB von
  // <main> - `main.focus()` zoege den Fokus hinter den offenen Dialog.
  const dialogButton = { name: 'dialog-close' };
  const opened = await navigateFocus({
    active: { name: 'nav' },
    atFrame: ({ doc, openOverlay }) => { openOverlay(); doc.activeElement = dialogButton; },
  });
  assert.deepEqual(opened.focused, []);
  assert.equal(opened.active, dialogButton);
  // Auch wenn der Dialog den Fokus (noch) nicht hat: hinter ihn gehoert er nicht.
  const pending = await navigateFocus({ active: { name: 'body' }, overlayOpen: true });
  assert.deepEqual(pending.focused, []);
});

test('#1821 Router-Fokus: Anmeldung und Einrichtung bleiben unberuehrt, und der Router ruft genau diese Funktion', async () => {
  assert.equal((await navigateFocus({ path: '/login', active: null })).queued, 0);
  assert.equal((await navigateFocus({ path: '/setup', active: null })).queued, 0);

  // router.js laesst sich nicht importieren; sein Anteil ist das Hereinreichen.
  const { readFileSync } = await import('node:fs');
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const fn = router.slice(router.indexOf('function focusMainContentAfterNavigation('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2).replace(/\s+/g, ' ');
  assert.equal(body,
    'function focusMainContentAfterNavigation(path) { focusMainAfterNavigation(path, { document, requestAnimationFrame: (cb) => requestAnimationFrame(cb), hasOpenOverlay, }); }',
    'der Router fuegt keine eigene Bedingung hinzu - jede Regel steht in der gemessenen Funktion');
  assert.match(router, /focusMainContentAfterNavigation, showToast, t,/, 'und reicht sie an navigate() weiter');
});

// --------------------------------------------------------
// #1821: der Fokus auf einer Inhaltszeile ueberlebt den stillen Neuaufbau
// --------------------------------------------------------

/** Ein Element, wie `focusKeyOf` es liest - ohne DOM, mit benannten Vorfahren. */
function fakeEl({ attrs = {}, classes = [], ancestors = {}, matches = [] } = {}) {
  const el = {
    id: attrs.id ?? '',
    classList: classes,
    dataset: Object.fromEntries(Object.entries(attrs)
      .filter(([k]) => k.startsWith('data-'))
      .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v])),
    hasAttribute: (name) => name in attrs,
    getAttribute: (name) => attrs[name] ?? null,
    ownerDocument: { querySelectorAll: () => matches },
    closest(selector) {
      for (const part of selector.split(',').map((x) => x.trim())) {
        if (part in ancestors) return ancestors[part];
        const own = /^\[([a-z-]+)\]$/.exec(part);
        if (own && own[1] in attrs) return el;
      }
      return null;
    },
  };
  return el;
}

test('#1821 Fokus: eine Zeile nennt sich ueber Ziel, Kachel und Stelle', () => {
  const hadCss = 'CSS' in globalThis;
  const prevCss = globalThis.CSS;
  // Node kennt `CSS.escape` nicht; die Probe braucht nur, dass die Werte
  // unveraendert im Selektor ankommen.
  globalThis.CSS = { escape: (v) => String(v) };
  try {
    const shellOf = (matches) => ({ querySelectorAll: () => matches });
    const tile = { dataset: { widgetId: 'shopping' } };

    // Bis #1821 hatte eine Inhaltszeile KEINEN Schluessel: der stille Neuaufbau
    // (Rueckkehr in den Tab, Viertelstundentakt) liess den Fokus auf <body>.
    const row = fakeEl({ attrs: { 'data-route': '/shopping?list=7' } });
    row.closest = ((orig) => (sel) => (sel === '.widget-wrapper[data-widget-id]' ? tile
      : sel === '#dashboard-shell' ? shellOf([row]) : orig(sel)))(row.closest);
    assert.deepEqual(__test.focusKeyOf(row), {
      selector: '.widget-wrapper[data-widget-id="shopping"] [data-route="/shopping?list=7"]',
      index: 0,
      preventScroll: true,
    });

    // Mehrere Zeilen mit demselben Ziel (Schichtplan): die Stelle entscheidet.
    const other = {};
    const third = fakeEl({ attrs: { 'data-route': '/schedule/patterns' } });
    third.closest = ((orig) => (sel) => (sel === '#dashboard-shell' ? shellOf([other, other, third]) : orig(sel)))(third.closest);
    assert.equal(__test.focusKeyOf(third).index, 2);
    assert.equal(__test.focusKeyOf(third).selector, '[data-route="/schedule/patterns"]');

    // Der Tabstopp der Notizkarte ist ein KIND der Zeile.
    const card = fakeEl({ attrs: { 'data-route': '/notes?open=5' } });
    const body = fakeEl({ classes: ['note-item__body'], ancestors: { '[data-route]': card } });
    assert.equal(__test.focusKeyOf(body).selector, '[data-route="/notes?open=5"] .note-item__body');
    // Die Stelle zaehlt das KIND, nicht die Zeile: liegt der Fokus auf dem
    // zweiten Treffer des Kind-Selektors, ist es der zweite - die Zeile selbst
    // steht in dieser Trefferliste gar nicht.
    const otherBody = {};
    card.closest = ((orig) => (sel) => (sel === '#dashboard-shell' ? { querySelectorAll: () => [otherBody, body] } : orig(sel)))(card.closest);
    assert.equal(__test.focusKeyOf(body).index, 1);

    // Eine Aufgabenzeile fuehrt nirgendhin, sie oeffnet ein Objekt.
    const task = fakeEl({ attrs: { 'data-task-id': '31' } });
    assert.equal(__test.focusKeyOf(task).selector, '[data-task-id="31"]');

    // Die Heute-Zeile einer Aufgabe: Ziel UND Objekt, sonst traefe `/tasks` die erste.
    const cockpit = fakeEl({ attrs: { 'data-route': '/tasks', 'data-object-kind': 'task', 'data-object-id': '31' } });
    assert.equal(__test.focusKeyOf(cockpit).selector, '[data-route="/tasks"][data-object-kind="task"][data-object-id="31"]');

    // Was vorher galt, gilt weiter: Id zuerst, dann die Bearbeiten-Attribute.
    assert.equal(__test.focusKeyOf(fakeEl({ attrs: { id: 'dashboard-customize-btn', 'data-route': '/x' } })), '#dashboard-customize-btn');
    assert.equal(__test.focusKeyOf(fakeEl({ attrs: { 'data-widget-hide': 'notes' } })), '[data-widget-hide="notes"]');
    // Und was keine Zeile ist, bekommt keinen Schluessel.
    assert.equal(__test.focusKeyOf(fakeEl({ classes: ['widget__title'] })), null);
  } finally {
    if (hadCss) globalThis.CSS = prevCss; else delete globalThis.CSS;
  }
});

/**
 * Eine Flaeche fuer captureRebuildFocus/restoreFocusAfterRebuild: `nodes` sind
 * die Elemente, die `selector` jeweils trifft - wie der Neuaufbau sie liefert.
 */
function fakeSurface(nodes) {
  const log = [];
  const make = (name, extra = {}) => ({ name, disabled: false, focus(options) { log.push([name, options]); }, ...extra });
  const table = Object.fromEntries(Object.entries(nodes).map(([selector, list]) => [selector,
    list.map((entry) => (typeof entry === 'string' ? make(entry) : make(entry.name, entry)))]));
  return {
    log,
    table,
    querySelector: (selector) => table[selector]?.[0] ?? null,
    querySelectorAll: (selector) => table[selector] ?? [],
  };
}

test('#1821 Fokus: der Neuaufbau gibt der Zeile den Fokus zurueck - an ihrer Stelle, ohne zu scrollen', () => {
  const hadCss = 'CSS' in globalThis;
  const prevCss = globalThis.CSS;
  globalThis.CSS = { escape: (v) => String(v) };
  try {
    // VORHER: die dritte Schichtplan-Zeile hat den Fokus.
    const body = {};
    const rowsBefore = [{}, {}, null];
    const row = fakeEl({ attrs: { 'data-route': '/schedule/patterns' } });
    rowsBefore[2] = row;
    const shellBefore = { contains: (el) => el === row, querySelectorAll: () => rowsBefore };
    row.closest = ((orig) => (sel) => (sel === '#dashboard-shell' ? shellBefore : orig(sel)))(row.closest);
    const before = __test.captureRebuildFocus(shellBefore, row, body);
    assert.equal(before.had, true);
    assert.deepEqual(before.key, { selector: '[data-route="/schedule/patterns"]', index: 2, preventScroll: true },
      'die Erfassung gibt den Zeilenschluessel weiter');

    // NACHHER: neue Elemente, derselbe Selektor. Die dritte bekommt den Fokus.
    const after = fakeSurface({ '[data-route="/schedule/patterns"]': ['erste', 'zweite', 'dritte'] });
    const got = __test.restoreFocusAfterRebuild(after, [before.key]);
    assert.equal(got?.name, 'dritte');
    assert.deepEqual(after.log, [['dritte', { preventScroll: true }]]);

    // Die Zeile gibt es nach dem Neuaufbau nicht mehr (eine weniger): kein Fokus, kein Wurf.
    const fewer = fakeSurface({ '[data-route="/schedule/patterns"]': ['erste', 'zweite'] });
    assert.equal(__test.restoreFocusAfterRebuild(fewer, [before.key]), null);
    assert.deepEqual(fewer.log, []);
  } finally {
    if (hadCss) globalThis.CSS = prevCss; else delete globalThis.CSS;
  }
});

test('#1821 Fokus: ausserhalb der Flaeche oder auf <body> wird nichts erfasst', () => {
  const body = {};
  const outside = fakeEl({ attrs: { id: 'nav-link' } });
  const shell = { contains: () => false };
  assert.deepEqual(__test.captureRebuildFocus(shell, outside, body), { key: null, had: false });
  assert.deepEqual(__test.captureRebuildFocus({ contains: () => true }, body, body), { key: null, had: false });
  assert.deepEqual(__test.captureRebuildFocus({ contains: () => true }, null, body), { key: null, had: false });
  // In der Flaeche, aber ohne Identitaet: Fokus war da, einen Schluessel gibt es nicht.
  assert.deepEqual(__test.captureRebuildFocus({ contains: () => true }, fakeEl({ classes: ['widget__title'] }), body), { key: null, had: true });
});

test('#1821 Fokus: Selektor-Kandidaten des Anpassen-Modus gelten weiter - erster Treffer, mit Scrollen, in Reihenfolge', () => {
  // Was vor #1821 galt: Ids und Bearbeiten-Knoepfe sind Selektoren. Ihr Fokus
  // darf scrollen (die Geste hat ihn ausgeloest), und es gilt der ERSTE Treffer.
  const surface = fakeSurface({
    '#dashboard-customize-cancel': ['abbrechen'],
    '#dashboard-customize-btn': ['anpassen'],
    '[data-widget-hide="notes"]': ['ausblenden-a', 'ausblenden-b'],
    '#gesperrt': [{ name: 'gesperrt', disabled: true }],
  });
  assert.equal(__test.restoreFocusAfterRebuild(surface, ['[data-widget-hide="notes"]', '#dashboard-customize-btn']).name, 'ausblenden-a');
  assert.deepEqual(surface.log.at(-1), ['ausblenden-a', undefined], 'ohne preventScroll');
  // Der erste Kandidat fehlt nach dem Aufbau: der naechste ist dran.
  assert.equal(__test.restoreFocusAfterRebuild(surface, [null, '#gibt-es-nicht', '#dashboard-customize-cancel', '#dashboard-customize-btn']).name, 'abbrechen');
  // Ein gesperrter Knopf wird uebersprungen.
  assert.equal(__test.restoreFocusAfterRebuild(surface, ['#gesperrt', '#dashboard-customize-btn']).name, 'anpassen');
  assert.equal(__test.restoreFocusAfterRebuild(surface, []), null);
  assert.equal(__test.restoreFocusAfterRebuild(surface, null), null);
  assert.equal(surface.log.length, 3);
});

test('#1821 Fokus: der Neuaufbau der Seite ruft Erfassen und Wiederfokus, um das setHtml herum', async () => {
  // rebuildDashboard() lebt im Abschluss von render() und laesst sich nicht
  // rufen. Was die beiden Funktionen TUN, messen die Tests darueber; hier steht
  // nur, dass der Abschluss sie in dieser Reihenfolge und mit diesen Werten ruft.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('  function rebuildDashboard(cfg) {'));
  const body = fn.slice(0, fn.indexOf('\n  }\n')).split('\n').filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join('\n');
  const capture = body.indexOf('const { key: keepFocus, had: hadFocus } = captureRebuildFocus(shell, document.activeElement, document.body);');
  const paint = body.indexOf('setHtml(shell, `\n      <section class="dashboard-masthead');
  const restore = body.search(/^ {4}restoreFocusAfterRebuild\(container, \[\n {6}keepFocus,\n {6}\.\.\.\(focusAfterRebuild \?\? \[\]\),\n {6}\.\.\.\(hadFocus && modeChanged \? \['#dashboard-customize-btn'\] : \[\]\),\n {4}\]\);$/m);
  assert.ok(capture > 0, 'erfasst wird vor dem Aufbau');
  assert.ok(paint > capture, 'dann wird gebaut');
  assert.ok(restore > paint, 'und danach wieder fokussiert: eigener Schluessel, Nachfolger der Geste, Anpassen-Knopf');
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

// „Standard (2×2)" hiess die groesste der vier Formen - aber keine Kachel
// beginnt in ihr (#1723). Ein Name, der einen Ausgangswert behauptet, den es
// nicht gibt, ist dieselbe Sorte Fehler wie „Schmal" fuer zwei Spalten.
test('2×2 heisst nach seiner Form, nicht „Standard" - keine Kachel beginnt in dieser Groesse', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { WIDGET_SIZE_PRESETS, WIDGET_IDS, defaultWidgetSize } = await import('../public/utils/dashboard-widgets.js');
  const square = WIDGET_SIZE_PRESETS.find((p) => p.value === '2x2');
  assert.ok(square, '2x2 ist keine waehlbare Groesse mehr - der Test prueft dann nichts');
  // Die Voraussetzung des Namens, gemessen statt behauptet: sobald ein Widget
  // wieder in 2x2 beginnt, ist diese Zeile rot und der Name neu zu entscheiden.
  assert.ok(WIDGET_IDS.length > 5, 'zu wenige Widgets gelesen');
  assert.deepEqual(WIDGET_IDS.filter((id) => defaultWidgetSize(id) === '2x2'), [],
    'ein Widget beginnt in 2x2');
  assert.doesNotMatch(square.labelKey, /standard|default/i, 'der Schluessel nennt 2x2 den Ausgangswert');
  const dir = new URL('../public/locales/', import.meta.url);
  const label = (file) => square.labelKey.split('.').reduce((o, k) => o?.[k],
    JSON.parse(readFileSync(new URL(file, dir), 'utf8')));
  assert.equal(label('de.json'), 'Quadrat (2×2)');
  assert.equal(label('en.json'), 'Square (2×2)');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const { dashboard } = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    assert.equal(dashboard.widgetSizeStandard, undefined, `${file}: der alte Name ist als toter Schluessel geblieben`);
    // Das Malzeichen und die Ziffern der Sprache bleiben, wie die Nachbarn sie fuehren.
    assert.match(label(file), /\s\((2×2|۲×۲)\)$/u, `${file}: die Massangabe fehlt (${label(file)})`);
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

/* ZAHLEN TABELLARISCH (Critique R18, 2026-10-07). Gemessen trugen auf der
 * Uebersicht 20 von 62 Textknoten mit Ziffern `tabular-nums`: der Budgetsaldo
 * ja, die beiden Betraege darunter nicht; die Uhrzeit des Termins ja, die der
 * Familienkarte nicht. Die Liste nennt die Traeger von Geld, Zeit und Zaehlern
 * der Uebersicht; jeder muss von EINER tabular-Regel gedeckt sein (eigene
 * Klasse im letzten Glied, `font-variant-numeric` erbt auf die Kinder) und im
 * Markup der Uebersicht vorkommen - sonst prueft die Liste Luft. */
test('R18: Geld, Zeit und Zaehler der Uebersicht stehen in tabular-nums', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const tabular = new Set();
  for (const file of ['dashboard.css', 'panel.css', 'layout.css']) {
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      if (!/font-variant-numeric:\s*tabular-nums/.test(rule.body)) continue;
      for (const part of rule.selector.split(',')) {
        const last = part.trim().split(/[\s>+~]+/).pop();
        for (const cls of last.match(/\.[\w-]+/g) ?? []) tabular.add(cls.slice(1));
      }
    }
  }
  const source = read('../public/pages/dashboard.js');
  const carriers = [
    'dashboard-overview__date', 'today-cockpit-card__value', 'today-cockpit-card__sub', 'today-cockpit__more',
    'family-member__status', 'family-widget__footer', 'budget-widget__savings', 'budget-widget__flow-item',
    'widget__badge', 'widget-list-more', 'birthday-widget-item__meta', 'birthday-widget-item__age',
    'rewards-widget__footer', 'metric-card__value', 'metric-card__note',
  ];
  const missing = carriers.filter((cls) => !tabular.has(cls));
  assert.deepEqual(missing, [], `Zahlentraeger ohne tabular-nums: ${missing.join(', ')}`);
  const gone = carriers.filter((cls) => !source.includes(cls));
  assert.deepEqual(gone, [], `nicht mehr im Markup der Uebersicht: ${gone.join(', ')}`);
});

/* VIER LESESTUFEN (Critique R18, 2026-10-07): 17 / 15 / 13 / 12 auf den
 * Inhaltsflaechen der Uebersicht; 14 und 16 bleiben den Bedienelementen.
 * Gemessen im Browser (1440, hell): 22 -> 16 Groesse/Gewicht-Paare, kein
 * Inhalt der genannten Klassen mehr auf 14, 16 oder 18px; bei 390px in `fi`
 * und `de` kein Umbruch und keine Ellipse an ihnen.
 *
 * Dieser Guard ist NICHT die Messung - die braucht ein Layout. Er haelt, was
 * sich am Stylesheet halten laesst: die Klassen, die umgestellt wurden, stehen
 * in JEDER ihrer Regeln auf einem Token der Leiter. */
test('R18: die umgestellten Inhaltsklassen der Uebersicht stehen auf der Lese-Leiter (17/15/13/12)', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const tokens = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
  const LADDER = { '--type-card-title': '1.0625rem', '--type-secondary': '0.9375rem', '--type-caption': '0.8125rem', '--text-xs': '0.75rem' };
  for (const [token, value] of Object.entries(LADDER)) {
    assert.match(tokens, new RegExp(`${token}:\\s*${value.replace('.', '\\.')};`), `${token} ist ${value}`);
  }
  const expected = {
    '.weather-widget__range': '--type-caption',
    '.weather-widget__desc': '--type-caption',
    '.weather-widget__city': '--type-caption',
    '.budget-widget__savings span': '--type-caption',
    '.budget-widget__savings strong': '--type-card-title',
    '.budget-widget__flow-item > strong': '--type-caption',
    '.birthday-widget-item__name': '--type-secondary',
    '.birthday-widget-item__age': '--type-caption',
    '.rewards-member__name': '--type-secondary',
  };
  const rules = [...eachRule(css)];
  for (const [selector, token] of Object.entries(expected)) {
    const sized = rules.filter((r) => r.selector.split(',').some((s) => s.trim() === selector) && /font-size:/.test(r.body));
    assert.ok(sized.length >= 1, `${selector} nennt seine Groesse selbst (16px waeren sonst geerbt)`);
    for (const rule of sized) {
      const size = /font-size:\s*([^;]+);/.exec(rule.body)[1].trim();
      assert.ok(Object.keys(LADDER).some((step) => size === `var(${step})`), `${selector} (${rule.at.join(' ') || 'Basis'}): ${size} liegt nicht auf der Leiter`);
    }
    assert.ok(sized.some((r) => r.at.length === 0 && new RegExp(`font-size:\\s*var\\(${token}\\)`).test(r.body)), `${selector}: Basis ${token}`);
  }
  // Kein Fett auf den Nebenwerten: semibold traegt die Zahl, bold bleibt Kennzahl und Avatar.
  for (const selector of ['.budget-widget__savings strong', '.budget-widget__flow-item > strong', '.birthday-widget-item__age']) {
    const body = rules.filter((r) => r.at.length === 0 && r.selector.split(',').some((s) => s.trim() === selector)).map((r) => r.body).join(';');
    assert.match(body, /font-weight:\s*var\(--font-weight-semibold\)/, selector);
  }
});
