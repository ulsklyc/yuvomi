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

/* #2087: die Aufgaben-Kachel bekam keine Groesse und zeigte immer die fuenf
 * dringendsten - auch als 1x1, wo jede andere Liste drei zeigt. */
function onPhone(fn) {
  const prev = globalThis.window;
  globalThis.window = { ...(prev ?? {}), matchMedia: (query) => ({ matches: query === '(max-width: 639px)' }) };
  try {
    return fn();
  } finally {
    globalThis.window = prev;
  }
}
// Was ohne Streckung steht: Zusatzzeilen (U14, `data-fill-row`) zeigt erst applyRowFill.
const taskRows = (html) => (html.match(/<div class="list-row task-item"[^>]*>/g) ?? []).filter((tag) => !tag.includes('data-fill-row')).length;

test('Aufgaben: die Kachel folgt ihrer Groesse wie jede Liste (#2087)', () => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `Aufgabe ${i}`, priority: 'none', status: 'open' }));
  const small = __test.renderUrgentTasks(tasks, 12, '1x1');
  assert.equal(taskRows(small), __test.listRowCap('1x1'), '1x1 zeigt drei');
  assert.equal(taskRows(small), 3);
  assert.equal(badgeOf(small), '12', 'die Badge zaehlt weiter alle offenen');
  assert.match(small, /dashboard\.tasksMore\{&quot;count&quot;:9\}/, 'die Fusszeile nennt, was nicht in DIESER Groesse steht');
  const tall = __test.renderUrgentTasks(tasks, 12, '1x2');
  assert.equal(taskRows(tall), 5);
  assert.match(tall, /dashboard\.tasksMore\{&quot;count&quot;:7\}/);
  assert.equal(taskRows(__test.renderUrgentTasks(tasks, 3, '1x1')), 3);
  assert.ok(!/tasksMore/.test(__test.renderUrgentTasks(tasks.slice(0, 3), 3, '1x1')), 'drei von drei: keine Fusszeile');
  assert.equal(taskRows(onPhone(() => __test.renderUrgentTasks(tasks, 12, '1x2'))), 3, 'die Telefon-Buehne zeigt drei');
});

test('Aufgaben: das Raster reicht der Kachel ihre Groesse durch (#2087)', async () => {
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const tasks = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `Aufgabe ${i}`, priority: 'none', status: 'open' }));
  const layout = (size) => __test.renderDashboardLayout(
    [{ id: 'tasks', visible: true, order: 0, size }], { urgentTasks: tasks, openTaskCount: 12 }, null, 'EUR',
  );
  const prev = globalThis.window;
  globalThis.window = { yuvomi: { isModuleDisabled: () => false }, matchMedia: () => ({ matches: false }) };
  setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });
  try {
    assert.equal(taskRows(layout('1x1')), 3);
    assert.equal(taskRows(layout('1x2')), 5);
  } finally {
    clearPermissions();
    globalThis.window = prev;
  }
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
      isListRow: /class="list-row shopping-widget-list"/.test(m[2]),
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
    .filter((m) => new RegExp(`class="(?:list-row )?${className}(?:["\\s])`).test(m[1]))
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
  // Das Markup kommt seit DW-P1-2 aus dashboardShellHtml(cfg).
  const paint = body.indexOf('setHtml(shell, html);');
  // R19: mobil steht der Anpassen-Einstieg im Menue (`.dashboard-tools-btn`) -
  // der Knopf ist dort nicht gerendert, das Menue ist der Rueckweg.
  // R20 (D, Wand-Modus): nach dem Verlassen der Wand steht danach der
  // Einstieg in die Wand als letzter Kandidat - nach den drei oben.
  // Lauf 2 (Critique 2026-10-26): ganz zuletzt die Ersatzkandidaten des
  // Heute-Blatts fuer einen Buehnenwechsel (todayFocusFallbacks).
  const restore = body.search(/^ {4}restoreFocusAfterRebuild\(container, \[\n {6}keepFocus,\n {6}\.\.\.\(focusAfterRebuild \?\? \[\]\),\n {6}\.\.\.\(hadFocus && modeChanged \? \['#dashboard-customize-btn', '\.dashboard-tools-btn'\] : \[\]\),\n(?: {6}\.\.\.\(takeWallFocusIntent\('leave'\) \? \[[^\n]*\] : \[\]\),\n)? {6}\.\.\.todayFallback,\n {4}\]\);$/m);
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
  const rows = html.split('<div class="list-row family-member');
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
  const played = __test.playTileFlip(root, before, { reduced: false });
  const [moved, grown, shrunk, still, shown] = tiles;

  assert.equal(played.length, 4, 'die ruhende Kachel bewegt sich nicht');
  assert.deepEqual(moved.calls[0].keyframes.map((k) => k.transform), ['translate(-100px, 0px)', 'none']);
  // DW-P2-2: `--ease-out` + `--duration-lg` wie das Raster (playGridShift), nicht
  // die Glasfeder - sie schoss 35/53 px uebers Ziel. Im Test ohne Stylesheet
  // gelten die Rueckfaelle der Tokens.
  for (const tile of [moved, grown, shrunk, shown]) {
    assert.deepEqual(tile.calls[0].timing, { duration: 250, easing: 'ease-out' }, 'Dauer und Kurve aus --duration-lg / --ease-out');
  }
  assert.match(grown.calls[0].keyframes[0].clipPath, /^inset\(0px 100px 0px 0px/, 'wer waechst, deckt seine neue Flaeche von der alten Groesse aus auf');
  assert.match(grown.calls[0].keyframes[1].clipPath, /^inset\(0px 0px 0px 0px/);
  assert.equal(shrunk.calls[0].keyframes[0].opacity, 0.6, 'wer schrumpft, blendet den umgebrochenen Inhalt auf');
  assert.equal(still.calls.length, 0);
  assert.equal(shown.calls[0].keyframes[0].opacity, 0, 'eine wieder eingeblendete Kachel hat keine Vorlage und blendet ein');

  // DW-P3-9: unter reduzierter Bewegung kein Weg, aber auch kein stummer
  // Sprung - was sich bewegt haette, blendet 0,4 -> 1 in --duration-sm
  // (das Muster von swapContent). Die ruhende Kachel bleibt ruhig.
  for (const t of tiles) t.calls = [];
  const reduced = __test.playTileFlip(root, before, { reduced: true });
  assert.equal(reduced.length, 4);
  for (const tile of [moved, grown, shrunk, shown]) {
    assert.deepEqual(tile.calls[0].keyframes, [{ opacity: 0.4 }, { opacity: 1 }], 'nur Deckkraft, kein transform, kein clip-path');
    assert.deepEqual(tile.calls[0].timing, { duration: 150, easing: 'ease-out' });
  }
  assert.equal(still.calls.length, 0);
  for (const t of tiles) t.calls = [];
  assert.deepEqual(__test.playTileFlip(root, null, { reduced: false }), [], 'ohne Vorher-Messung kein Gleiten');
  assert.ok(tiles.every((t) => t.calls.length === 0));
});

test('FLIP haengt am Neuaufbau: vorher messen, nach dem setHtml abspielen - im Anpassen-Modus und beim stillen Abgleich', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const body = src.match(/function rebuildDashboard\(cfg\) \{[\s\S]*?\n {2}\}\n/)?.[0];
  assert.ok(body, 'rebuildDashboard() nicht gefunden - die Signatur greift nicht mehr');
  // U1 b: auch ein stiller Abgleich gleitet (die Spanne einer Kachel folgt ihren
  // Daten) - nicht aus dem Skelett und nicht beim Moduswechsel.
  const quiet = body.search(/const quietRebuild = !isCustomizing && !modeChanged && !shell\.querySelector\('\.widget-skeleton'\);/);
  const capture = body.search(/const tileRectsBefore = \(isCustomizing && renderedCustomizing === true\) \|\| quietRebuild \? captureTileRects\(shell\) : null;/);
  // Das Markup kommt seit DW-P1-2 aus dashboardShellHtml(cfg).
  const rebuild = body.search(/setHtml\(shell, html\);/);
  const restore = body.search(/if \(scroller && scroller\.scrollTop !== keptScroll\) scroller\.scrollTop = keptScroll;/);
  const play = body.search(/if \(tileRectsBefore\?\.size\) playTileFlip\(shell, tileRectsBefore\)/);
  assert.ok(quiet > -1 && capture > -1 && rebuild > -1 && play > -1, 'Messen, Neuaufbau und Abspielen stehen alle drei im Neuaufbau');
  assert.ok(quiet < capture && capture < rebuild && rebuild < restore && restore < play,
    'erst messen, dann neu bauen, die Scrolllage zurueck, dann abspielen');
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
  // Das Markup kommt seit DW-P1-2 aus dashboardShellHtml(cfg).
  const rebuild = body.search(/setHtml\(shell, html\);/);
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
  // U1 b / DW-P2-9: ab 768px liegt die Kante ausserhalb (outline) - ein Polster
  // machte die Spalten im Anpassen-Modus schmaler als danach.
  assert.ok(rules.some((r) => r.selector.trim() === '.dashboard__grid--editing' && r.at.some((a) => /min-width:\s*768px/.test(a))
    && /outline:[^;]*dashed/.test(r.body) && /padding:\s*0/.test(r.body)), 'breit: die Kante als outline, ohne Polster');
  // Flaechen tragen nur die Leiste und der Geist einer Fuellung, nie das Raster.
  assert.deepEqual(rules.filter((r) => /background(-color|-image)?\s*:/.test(r.body)
    && !/widget-edit-controls|::after/.test(r.selector)).map((r) => r.selector), [],
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
const metaOf = (html, cls) => [...html.matchAll(new RegExp(`class="(?:list-row__meta )?${cls}">([^<]*)<`, 'g'))].map((m) => m[1]);

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
      // R23 (D11): der Abstand wie im Geburtstagsmodul ("in 3 Tagen", jenseits
      // eines Monats grob), nicht "3 Tage" wie eine Dauer.
      `${wd('2026-09-26')} · in 3 Tagen`,
      'DM:2026-10-15 · in 22 Tagen',
      '2027-01-05 · in 3 Monaten',
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
      // Seit R23 S11 ueber dateText: der Tag der Haushaltszone, dann ohne Jahr.
      assert.equal(note('2026-09-10T07:00:00.000Z'), 'dashboard.housekeepingLastVisit{"date":"DM:2026-09-10"}');
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

test('#1607 + R21: der Monatssaldo steht nur im Budget-Widget, und dessen Kopf nennt denselben Reiter', async () => {
  const { readFileSync } = await import('node:fs');
  const prevWindow = global.window;
  global.window = { yuvomi: { isModuleDisabled: () => false } };
  try {
    // R21 (D5): die Kennzahlreihe fuehrt keinen Kontostand mehr - auch wenn
    // das Budget-Widget fehlt, was seit R21 die Vorgabe ist.
    const tiles = __test.selectMetricTiles({
      budget: { income: 100, expenses: 40, balance: 60, entryCount: 2 },
      housekeeping: { configured: true, present: false, visitsThisMonth: 4 },
      birthdays: [{ name: 'Oma', days_until: 3 }],
    }, 'EUR');
    assert.ok(tiles.length >= 2, 'Reichweite: die Reihe steht');
    assert.ok(!tiles.some((entry) => entry.id === 'budget'), 'kein Saldo in der Reihe');
  } finally {
    global.window = prevWindow;
  }
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.match(src, /const BUDGET_MONTH_ROUTE = '\/budget\?tab=budget';/);
  assert.match(src, /widgetHeader\('budget', t\('nav\.budget'\), null, BUDGET_MONTH_ROUTE\)/,
    'der Widget-Kopf fuehrt in den Monatsreiter');
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
    // Die Zeilentitel und Endangaben der Listen-Kacheln (Geburtstage,
    // Belohnungen) stehen seit DW-P1-4 in den Rollen der geteilten Zeile
    // (`.list-row__name` 16/500, `.list-row__end` 13/600) - gehalten von
    // test:typography "R21 S5 + DW-P1-4".
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
  for (const selector of ['.budget-widget__savings strong', '.budget-widget__flow-item > strong']) {
    const body = rules.filter((r) => r.at.length === 0 && r.selector.split(',').some((s) => s.trim() === selector)).map((r) => r.body).join(';');
    assert.match(body, /font-weight:\s*var\(--font-weight-semibold\)/, selector);
  }
});

// Critique R19: das Onboarding nannte am Desktop einen "+-Knopf unten rechts".
// Ab der Breite, ab der die Seitenleiste steht, dockt der Router den FAB als
// Pille in den Modulkopf oben rechts (dockFabIntoToolbar/isDesktopViewport).
// Die Desktop-Fassung beschreibt diesen Ort, in jeder Sprache, und beide Seiten
// schalten an derselben Breite.
test('Onboarding Schritt 3 nennt am Desktop den Knopf oben rechts, nicht unten (Critique R19)', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dashboard = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const steps = dashboard.slice(dashboard.indexOf('function getOnboardingSteps'), dashboard.indexOf('function showOnboarding'));
  const onboardingBreak = /matchMedia\('\(min-width: (\d+)px\)'\)/.exec(steps)?.[1];
  const dockBreak = /function isDesktopViewport\(\) \{\s*return window\.matchMedia\('\(min-width: (\d+)px\)'\)/.exec(router)?.[1];
  assert.ok(onboardingBreak && dockBreak, 'Breakpoints nicht gefunden');
  assert.equal(onboardingBreak, dockBreak, 'Onboarding und angedockter Knopf schalten an verschiedenen Breiten');
  const bottom = { de: /unten/, en: /bottom/, fr: /\ben bas\b/, es: /inferior/, nl: /onder/, it: /in basso/ };
  const top = { de: /oben rechts/, en: /top right/, fr: /en haut/, es: /arriba/, nl: /rechtsboven/, it: /in alto/ };
  const dir = new URL('../public/locales/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const loc = file.slice(0, -5);
    const text = JSON.parse(readFileSync(new URL(file, dir), 'utf8')).onboarding.step3BodyDesktop;
    if (bottom[loc]) assert.doesNotMatch(text, bottom[loc], `${loc}: ${text}`);
    if (top[loc]) assert.match(text, top[loc], `${loc}: ${text}`);
  }
});

// Re-Critique 2026-10-17 (A1, Shell): der Rundgang war austauschbar - ein
// Lucide-Haus statt der Bildmarke, und Leiste und Plus-Knopf nur beschrieben.
// Schritt 1 traegt die Marke aus utils/brand-mark.js, Schritt 2 und 3 zeigen
// per Lichtring auf das echte Bedienelement, das ihr Text nennt. Der Ring ist
// Anzeige: das Overlay faengt weiter die Klicks, und die Tafel liegt ueber
// seinem Abdunkler (positioniert), sonst stuende sie selbst im Grau.
test('Onboarding: Bildmarke im ersten Schritt, Lichtring auf Leiste und Plus-Knopf (Re-Critique 2026-10-17)', async () => {
  const { readFileSync } = await import('node:fs');
  const dashboard = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const steps = dashboard.slice(dashboard.indexOf('function getOnboardingSteps'), dashboard.indexOf('function showOnboarding'));
  const show = dashboard.slice(dashboard.indexOf('function showOnboarding'), dashboard.indexOf('function maybeHintCustomize'));
  assert.doesNotMatch(steps, /icon:\s*'home'/, 'kein generisches Haus als Zeichen des Produkts');
  assert.match(dashboard, /import \{ brandMarkSvg \} from '\/utils\/brand-mark\.js'/);
  assert.match(steps, /\{ mark: true,[^\n]*step1Title/, 'Schritt 1 traegt die Bildmarke');
  assert.match(show, /brandMarkSvg\(\)/);
  assert.match(steps, /step2Title[^\n]*\n\s*target: \(\) => document\.querySelector\(desktop \? '\.nav-sidebar' : '\.nav-bottom__items'\)/,
    'Schritt 2 zeigt auf die Seitenleiste bzw. die Kapsel');
  assert.match(steps, /step3Title[^\n]*\n\s*target: \(\) => \[\.\.\.document\.querySelectorAll\('\.page-fab'\)\]/,
    'Schritt 3 zeigt auf den sichtbaren Plus-Knopf');
  assert.match(show, /function placeSpotlight\(\)/);
  assert.match(show, /classList\.toggle\('onboarding-overlay--spot', shown\)/, 'ohne sichtbares Ziel bleibt die Unschaerfe');
  assert.match(show, /spot\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(show, /removeEventListener\('resize', onResize\)/, 'der Ring haengt nach dem Rundgang an keinem Resize mehr');
  const rule = (sel) => (css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`)) || [])[1] || '';
  assert.match(rule('.onboarding-overlay--spot'), /backdrop-filter:\s*none/);
  assert.match(rule('.onboarding-spotlight'), /pointer-events:\s*none/);
  assert.match(rule('.onboarding-spotlight'), /box-shadow:[^;]*100vmax/);
  assert.match(rule('.onboarding-card'), /position:\s*relative/, 'die Tafel liegt ueber dem Abdunkler');
});

// Re-Critique 2026-10-17 (A1): "Widgets anpassen" am Telefon trug je Zeile vier
// umrandete 48px-Kreise. Hoch/Runter liegen jetzt in EINER Kapsel auf der
// Mulde, Groesse und Ausblenden ohne Ring daneben; die Ziele bleiben 48px.
test('Anpassen am Telefon: eine Kapsel fuer Hoch/Runter, keine Ringe je Knopf (Re-Critique 2026-10-17)', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const phone = css.slice(css.indexOf('ANPASSEN AUF DEM TELEFON IST EINE LISTE'));
  const block = phone.slice(0, phone.indexOf('@media (max-width: 767px)'));
  assert.match(block, /\.widget-edit-controls__hide,\s*\.widget-edit-controls__options,\s*\.widget-edit-controls__size-trigger\s*\) \{\s*border-color: transparent;\s*background: transparent;/,
    'Groesse, Optionen und Ausblenden ohne Ring');
  assert.match(block, /\.widget-edit-controls__move \{\s*gap: 0;\s*border-radius: var\(--radius-full\);\s*background: var\(--color-fill-well\);/,
    'Hoch und Runter in einer Kapsel');
  assert.match(block, /\.widget-edit-controls__move-btn \{\s*border: none;/);
  // Die Zielgroesse kommt weiter aus der Fingerregel (48px).
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?\.widget-edit-controls__move-btn \{\s*min-width: var\(--target-base\);\s*min-height: var\(--target-base\);/);
});

// --------------------------------------------------------
// Critique R19 (layout): die Uebersicht steht auf derselben Inhaltsspalte wie
// jedes Modul. Bis R19 war sie bis 1680px breit mit eigenem Polster; bei 1920
// begann sie bei x 270, die Module bei x 430. Ein eigenes Hoechstmass oder ein
// fester Seitenrand am Desktop liesse die Kante wieder springen.
// --------------------------------------------------------
test('die Uebersicht polstert am Desktop mit --page-inline-pad und kennt kein eigenes Hoechstmass', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const root = [...eachRule(css)].filter((r) => r.selector.trim() === '.dashboard');
  const desktop = root.filter((r) => r.at.some((a) => /min-width:\s*(\d+)px/.test(a) && Number(/min-width:\s*(\d+)px/.exec(a)[1]) >= 1024));
  assert.ok(desktop.length >= 1, 'keine Desktop-Regel fuer .dashboard');
  for (const rule of desktop) {
    const pad = /padding(?:-inline)?:\s*([^;]+);/.exec(rule.body)?.[1] ?? '';
    assert.match(pad, /var\(--page-inline-pad\)/, `${rule.at.join(' ')}: die Uebersicht polstert mit "${pad}" statt mit der Kante der Module`);
  }
  // Die zuletzt geltende Breite ohne At-Regel: kein festes Mass.
  const widths = root.filter((r) => !r.at.length && /max-width:/.test(r.body)).map((r) => /max-width:\s*([^;]+);/.exec(r.body)[1].trim());
  assert.equal(widths.at(-1), 'none', `die Uebersicht deckelt sich auf ${widths.at(-1)} - ihre Kante wiche von den Modulen ab`);
});

/* R19 (Entscheidung Ulas 2026-10-16, Critique P2 mobil): DIE UEBERSICHT AUF DEM
 * TELEFON. Die Familie belegte 427px (51 % des Viewports) fuer fuenf Zeilen
 * "1 Aufgabe", das Wetter begann bei y 1438, ueber dem Gruss standen drei
 * Icon-Knoepfe. Jetzt: eine Avatar-Reihe mit Zaehler, die Wetterzeile im
 * Masthead auch neben der Karte, der Wand-Modus im Anpassen-Menue. */
test('R19 mobil: die Familie ist eine Avatar-Reihe mit Zaehler, Name und Satz bleiben im Baum', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const html = __test.renderFamilyWidget([ALEX, LEO, LINDA], { memberTodayTasks: [{ user_id: 1, open_count: 2 }] });
  // DIE MARKE NENNT IHRE EINHEIT (Critique R21, clarify): eine nackte "1" am
  // Gesicht las sich wie eine Benachrichtigung - eins wovon? Vor der Zahl
  // steht das Zeichen der Aufgaben (MODULE_ICON.tasks), dasselbe wie in der
  // Leiste; die Zahl allein sagte nichts.
  assert.match(html, /<span class="list-row__lead family-member__face">[\s\S]*?class="family-widget-avatar"[\s\S]*?<span class="family-member__count" aria-hidden="true"><i data-lucide="check-square" class="family-member__count-icon"><\/i>2<\/span>/,
    'die Zahl offener Aufgaben steht als Marke am Gesicht, mit dem Aufgaben-Zeichen als Einheit');
  const badge = [...eachRule(css)].filter((r) => r.selector.trim() === '.family-member__count-icon');
  assert.ok(badge.some((r) => /inline-size:\s*var\(--icon-sm\)/.test(r.body)), 'das Zeichen hat die Groesse eines Inline-Markers');
  assert.equal((html.match(/family-member__count"/g) || []).length, 1, 'nur wer offene Aufgaben hat, traegt eine Marke');
  assert.match(html, /<span class="family-member__short" aria-hidden="true">Alex<\/span>/, 'der Vorname unter dem Gesicht');
  assert.match(html, /<span class="list-row__name family-member__name">Alex<\/span>/, 'der volle Name bleibt der Name fuer Screenreader');
  const phone = css.slice(css.indexOf('MOBIL IST DIE FAMILIE EINE AVATAR-REIHE'));
  const block = phone.slice(phone.indexOf('@media (max-width: 639px) {'), phone.indexOf('\n}\n') + 2);
  assert.match(block, /\.family-widget__list \{[^}]*flex-flow:\s*row wrap/, 'eine Reihe statt einer Liste');
  assert.match(block, /\.family-member:not\(\.family-member--shared\) > \.family-member__body \{[^}]*clip-path:\s*inset\(50%\)/,
    'Name und Satz geclippt, nicht entfernt');
  assert.doesNotMatch(block, /\.family-member__body \{[^}]*display:\s*none/);
  assert.match(block, /\.family-member--shared \{[^}]*order:\s*1;[^}]*flex:\s*1 0 100%/, 'der gemeinsame Termin als Zeile unter der Reihe');
  assert.match(block, /\.family-widget__footer \{\s*display:\s*none/, 'die Tagesbilanz steht in den Marken');
});

test('R21 S7 mobil: ab sechs Gesichtern liegt keine Marke auf dem Nachbarn, der gemeinsame Termin bleibt lesbar', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  // Gemessen 390px mit sechs Personen: Zelle 52px, die 33px-Marke ragte 25px
  // hinaus und lag dreimal 7x16px auf dem naechsten Gesicht.
  const cell = rules.find((r) => /\.family-member:not\(\.family-member--more, \.family-member--shared\)/.test(r.selector)
    && r.at.some((a) => /max-width:\s*639px/.test(a)));
  assert.ok(cell && /container:\s*family-member \/ inline-size/.test(cell.body), 'jede Person ist ihr eigener Container');
  const narrow = rules.find((r) => r.selector.trim() === '.family-member__count' && r.at.some((a) => /@container family-member \(max-width: \d+px\)/.test(a)));
  assert.ok(narrow, 'in der engen Zelle eine eigene Lage fuer die Marke');
  assert.match(narrow.body, /inset-inline-start:\s*auto/, 'eng haengt sie nicht ueber die Kante hinaus');
  assert.match(narrow.body, /inset-inline-end:\s*calc\(-1 \* var\(--space-1\)\)/);
  // Teilt nur ein Teil der Familie den Termin, stehen die Namen statt "Alle":
  // sie kuerzen, der Termin nicht.
  // DW-P2-10: der Termin nimmt die volle Breite - kein Prozentdeckel mehr (60 %
  // eines inhaltsbreiten Koerpers kuerzten "20:00 Filmabend" auf 82px neben
  // "Alle"); die Namen schrumpfen zuerst, hundertfach schneller als er.
  const name = rules.find((r) => r.selector.trim() === '.family-member--shared .family-member__name');
  const shrink = (body) => Number(/flex:\s*0 (\d+) auto/.exec(body)?.[1]);
  assert.ok(shrink(name.body) >= 100, 'die Namensliste schrumpft zuerst');
  assert.match(name.body, /min-inline-size:\s*0/);
  const status = rules.find((r) => r.selector.trim() === '.family-member--shared .family-member__status');
  assert.ok(status && shrink(status.body) === 1, 'der Termin schrumpft erst, wenn die Namen am Ende sind');
  assert.doesNotMatch(status.body, /max-inline-size:\s*\d+%/, 'kein Prozentdeckel am Termin');
});

test('R24 E7: die Wetterzeile steht im Masthead auch neben der Karte, in jeder Breite', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  assert.match(src, /renderDashboardOverview\(user, isCustomizing, weather, \{ followsDefault, canPublish, weatherCard: weatherCardShown \}\)/,
    'das Wetter geht immer in den Kopf, die Karte nur als Merkmal');
  const weather = { current: { temp: 18, desc: 'Sonnig', icon: '01d' }, units: 'metric' };
  const head = __test.renderDashboardOverview({ display_name: 'Linda' }, false, weather, { weatherCard: true });
  assert.match(head, /class="dashboard-overview__weather dashboard-overview__weather--card"/);
  // Bis R24 blendete ab 768px eine Regel die Zeile aus, sobald die Karte stand -
  // am Desktop lag das Jetzt dann nur unter der Falz (Critique G1-Uebersicht-P3-5).
  const { eachRule } = await import('./css-rules.js');
  const hides = [...eachRule(css)].filter((r) => r.selector.includes('dashboard-overview__weather--card') && /display:\s*none/.test(r.body));
  assert.deepEqual(hides.map((r) => r.selector), [], 'keine Breite blendet die Wetterzeile neben der Karte aus');
});

test('R19 mobil: der Wand-Modus steht im Anpassen-Menue, je Breite ein Weg', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const head = __test.renderDashboardOverview({ display_name: 'Linda' }, false, null, {});
  assert.match(head, /class="btn btn--secondary btn--icon dashboard-icon-btn dashboard-tools-btn popover-menu__trigger"/);
  assert.match(head, /data-action="dashboard-customize"[\s\S]*data-action="dashboard-wall"/, 'Anpassen und Wand-Modus als Eintraege');
  assert.match(head, /id="dashboard-wall-enter"/, 'der Wand-Knopf bleibt im Baum - die Eintraege klicken ihn');
  const display = __test.renderDashboardOverview({ display_name: 'Wand', access_scope: 'display' }, false, null, {});
  assert.doesNotMatch(display, /dashboard-tools-btn/, 'ein Display hat kein Anpassen und damit kein Menue');
  assert.match(css, /\.dashboard-tools-btn \{\s*display: none;\s*\}/, 'breit gibt es das Menue nicht');
  assert.match(css, /@media \(max-width: 767px\) \{\s*\.dashboard-tools-btn \{\s*display: inline-flex;\s*\}\s*\.dashboard-overview__tools:has\(> \.dashboard-tools-btn\) > #dashboard-wall-enter,\s*\.dashboard-overview__tools:has\(> \.dashboard-tools-btn\) > #dashboard-customize-btn \{\s*display: none;/,
    'schmal ersetzt das Menue die zwei Knoepfe');
  assert.match(src, /if \(action === 'dashboard-wall'\) container\.querySelector\('#dashboard-wall-enter'\)\?\.click\(\);/);
});

// --------------------------------------------------------
// R21: der Rueckweg zeichnet den eben geladenen Stand sofort
// --------------------------------------------------------
// Zurueck auf der Uebersicht stand das Skelett ohne Gruss im neuen Bild der
// Seitenblende, der Inhalt schnitt danach hart darueber - auch wenn derselbe
// Stand Sekunden vorher schon dagewesen war. Gemessen mobil: neues Bild bei
// +108 ms (4x: +141) aus dem Netz, aus dem gemerkten Stand bei +26-32 ms
// (4x: +84-87), ohne Neubau danach, wenn die Nachfrage dasselbe liefert.
test('R21 Rueckweg: ein frischer Stand desselben Mitglieds taugt, ein alter, fremder oder gestriger nicht', () => {
  const at = new RealDate('2026-10-21T08:00:00Z');
  const memo = { key: '7|de', at, day: '2026-10-21' };
  const use = (overrides = {}) => __test.usableOverviewMemo(memo, {
    key: '7|de', now: new RealDate(at.getTime() + 5_000), today: '2026-10-21', ...overrides,
  });
  assert.equal(use(), memo, 'fuenf Sekunden alt, dasselbe Mitglied: sofort zeichnen');
  assert.equal(use({ key: '8|de' }), null, 'ein anderes Mitglied bekommt nie den Stand eines anderen');
  assert.equal(use({ key: '7|en' }), null, 'eine andere Sprache uebersetzt neu');
  assert.equal(use({ now: new RealDate(at.getTime() + 61_000) }), null, 'aelter als eine Minute: neu laden');
  assert.equal(use({ today: '2026-10-22' }), null, 'ein neuer Haushaltstag: "Heute" waere gestern');
  assert.equal(__test.usableOverviewMemo(null, { key: '7|de', now: at, today: '2026-10-21' }), null);
});

test('R21 Rueckweg: ein Schreibvorgang irgendwo verwirft den gemerkten Stand', () => {
  const prev = globalThis.window;
  const target = new EventTarget();
  globalThis.window = { addEventListener: target.addEventListener.bind(target) };
  try {
    __test.watchOverviewWrites();
    __test.setOverviewMemo({ key: '7|de' });
    target.dispatchEvent(new Event('yuvomi:other'));
    assert.ok(__test.getOverviewMemo(), 'ein fremdes Ereignis verwarf den Stand');
    // Dasselbe Ereignis, das api.js nach jedem geglueckten Schreiben meldet (test:api).
    target.dispatchEvent(new Event('yuvomi:write'));
    assert.equal(__test.getOverviewMemo(), null, 'nach einem Schreibvorgang zeichnete die Uebersicht den alten Stand');
  } finally {
    globalThis.window = prev;
    __test.setOverviewMemo(null);
  }
});

test('R21 Rueckweg: die Nachfrage vergleicht den Inhalt, nicht die Reihenfolge der Slices', async () => {
  const a = { events: [1, 2], pendingReminders: [], cycle: null, schedule: { x: 1 } };
  const b = { cycle: null, schedule: { x: 1 }, events: [1, 2], pendingReminders: [] };
  assert.equal(__test.overviewSignature(a), __test.overviewSignature(b));
  assert.notEqual(__test.overviewSignature(a), __test.overviewSignature({ ...b, events: [1] }));
  // Und render() nimmt den Stand wirklich (ohne DOM nur am Quelltext lesbar;
  // die Wirkung misst die Browser-Sonde oben): kein Skelett, keine Anfrage
  // davor, danach still nachfragen und nur bei Aenderung neu bauen.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const render = src.slice(src.indexOf('export async function render('));
  assert.match(render, /: memo \? '' : renderDashboardSkeleton\(user, \{ head \}\)/, 'mit gemerktem Stand steht wieder ein Skelett im ersten Bild');
  assert.match(render, /= memo\s*\? \[memo\.data, memo\.weatherRes, \{ data: memo\.prefs \}, memo\.data\.pendingReminders\]\s*: await Promise\.all\(/,
    'der gemerkte Stand wird nicht ohne Anfrage gezeichnet');
  assert.match(render, /if \(memo\) refreshDashboardData\(\{ onlyIfChanged: true \}\);/, 'nach dem Zeichnen aus dem Stand fragt die Seite nicht nach');
  // Seit DW-P1-2 klappen gehende Zeilen vorher aus (closeLeavingRows) - gebaut
  // wird weiterhin nur bei geaenderter Antwort.
  assert.match(render, /if \(unchanged\) return;\n[\s\S]{0,700}?rebuildDashboard\(widgetConfig\);/, 'eine gleiche Antwort baut die Flaeche trotzdem neu');
});

// Review zu R21 (PR #2142): der gemerkte Stand traegt die eigenen Slices
// (Abfuhr, Zyklus), die /dashboard nie mitliefert - die ensure*-Aufrufe fragen
// beim Aufbau daraus nichts. Reichte die stille Nachfrage sie dann nur weiter
// (`fresh.waste = data.waste;`) und stempelte den Stand neu (`rememberOverview`),
// hielten Besuche unter einer Minute Abstand einen alten Abholtermin oder einen
// auf einem anderen Geraet geaenderten Zyklus unbegrenzt. Vorher holte jedes
// Mounten die Slices neu. Jeder Slice, den die Nachfrage in den neuen Stand
// uebernimmt, wird deshalb vorher zurueckgesetzt und neu geholt - derselbe Weg
// wie beim Dienstplan (test:dashboard, M-6a).
test('R21 Rueckweg: die stille Nachfrage holt jeden eigenen Slice neu, bevor sie den Stand neu stempelt', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const refreshFn = src.slice(src.indexOf('async function refreshDashboardData('), src.indexOf('const refreshTimerId'));
  assert.ok(refreshFn.length > 0, 'refreshDashboardData() nicht gefunden');
  const carried = [...refreshFn.matchAll(/fresh\.(\w+) = data\.\1;/g)].map((m) => m[1]);
  for (const slice of ['cycle', 'waste']) {
    assert.ok(carried.includes(slice), `fresh.${slice} wird in der Nachfrage gar nicht mehr gesetzt - die Kachel fiele auf ihren Leerzustand`);
  }
  const stamp = refreshFn.indexOf('rememberOverview();');
  assert.ok(stamp > 0, 'die Nachfrage merkt den neuen Stand nicht mehr');
  for (const slice of carried) {
    const ensure = `ensure${slice[0].toUpperCase()}${slice.slice(1)}Slice`;
    // Ohne Ruecksetzen kehrt ensure*() an seinem eigenen "schon geladen" um.
    assert.match(src, new RegExp(`async function ${ensure}\\(\\) \\{\\s*if \\(data\\.${slice} !== undefined\\) return;`),
      `${ensure}() laedt nicht mehr nur bei undefined - dann misst dieser Test das Falsche`);
    const visible = refreshFn.indexOf(`widgetConfig.some((w) => w.id === '${slice}' && w.visible)`);
    const reset = refreshFn.indexOf(`data.${slice} = undefined;`);
    const reload = refreshFn.indexOf(`await ${ensure}();`);
    const carry = refreshFn.indexOf(`fresh.${slice} = data.${slice};`);
    assert.ok(visible > -1 && reset > visible,
      `${slice}: die Nachfrage setzt den Slice nicht (fuer eine sichtbare Kachel) zurueck - er reist nur weiter und bleibt alt, solange man unter einer Minute wiederkommt`);
    assert.ok(reload > reset, `${slice}: nach dem Ruecksetzen wird nicht neu geholt`);
    assert.ok(carry > reload, `${slice}: der Slice wird uebernommen, bevor er neu geholt ist`);
    assert.ok(stamp > carry, `${slice}: der Stand wird neu gestempelt, bevor der Slice neu ist`);
  }
});

// R22 S9 (Critique 2026-10-22, a1 Klein): Schritt 2 trug den Lucide-Ortungspfeil
// (`navigation`) zu einem Text ueber Leiste und Module, Schritt 3 versprach das
// Wischen fuer alle Listeneintraege - es gibt es in Aufgaben, Einkauf, Vorrat.
test('R22: der Rundgang zeigt in Schritt 2 Module und verspricht das Wischen nur, wo es geht', async () => {
  const { readFileSync } = await import('node:fs');
  const dashboard = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const steps = dashboard.slice(dashboard.indexOf('function getOnboardingSteps'), dashboard.indexOf('function showOnboarding'));
  assert.match(steps, /icon: 'layout-grid',\s+title: t\('onboarding\.step2Title'\)/);
  assert.doesNotMatch(steps, /icon: 'navigation'/, 'kein Ortungspfeil');
  const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8')).onboarding.step3Body;
  assert.match(de, /In Aufgaben, Einkauf und Vorrat wischst du/);
  assert.doesNotMatch(de, /Wische Listeneinträge/);
  const en = JSON.parse(readFileSync(new URL('../public/locales/en.json', import.meta.url), 'utf8')).onboarding.step3Body;
  assert.match(en, /In Tasks, Shopping and Pantry/);
});

// "+ NEU > AUFGABE" OEFFNET DAS ANLEGEN-BLATT (DW-P1-1, Critique 2026-10-26).
// Pille und Speed-Dial wechseln ins Modul und klicken dort dessen Anlegen-Knopf.
// Die Aufgaben-Seite heisst ihn seit #1483 `fab-new-task`, die Uebersicht suchte
// weiter `#btn-new-task` - der Tipp landete in der Liste, und nichts ging auf.
// Gemessen wird die Map aus dem geladenen Modul gegen das Markup der Zielseite
// (welche Datei, sagt die Routentabelle des Routers) und die Verdrahtung beider
// Wege mit dem echten `findPageFab()`.
function stubEl(extra = {}) {
  const listeners = [];
  return {
    dataset: {}, listeners, tabIndex: 0, hidden: false,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, focus() {},
    addEventListener(type, fn, opts) { listeners.push({ type, fn, opts }); },
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    ...extra,
  };
}

async function withNewTargets(fn) {
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const visited = [];
  const clicked = [];
  // Jeder Knopf, den die Zielseite tatsaechlich traegt, ist per Id auffindbar -
  // eine andere Id liefert wie im Browser `null`.
  const pageIds = new Set();
  const byId = (id) => (pageIds.has(id) ? { click: () => clicked.push(id) } : null);
  globalThis.document = {
    getElementById: byId,
    // Auch der Selektor-Weg sieht nur Knoepfe, die es gibt - so misst die Probe
    // das Ziel, nicht die Art der Suche.
    querySelector: (sel) => (sel.startsWith('#') ? byId(sel.slice(1)) : null),
    addEventListener() {},
  };
  globalThis.window = {
    yuvomi: { navigate: async (route) => { visited.push(route); }, isModuleDisabled: () => false },
    matchMedia: () => ({ matches: false }),
  };
  setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });
  try {
    return await fn({ visited, clicked, pageIds });
  } finally {
    clearPermissions();
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }
}

test('DW-P1-1: jedes "+ Neu"-Ziel nennt eine Id, die seine Zielseite traegt', async () => {
  const { readFileSync } = await import('node:fs');
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const targets = __test.FAB_NEW_BTN;
  assert.ok(targets && typeof targets === 'object', 'FAB_NEW_BTN ist nicht erreichbar');
  await withNewTargets(async () => {
    const offered = __test.FAB_ACTIONS().map((a) => a.route);
    assert.deepEqual(offered.slice().sort(), Object.keys(targets).sort(),
      'Speed-Dial und Pille bieten genau die Ziele an, fuer die die Map einen Knopf kennt');
  });
  for (const [route, id] of Object.entries(targets)) {
    assert.match(id, /^[a-z][\w-]*$/, `${route}: "${id}" ist eine Id fuer findPageFab(), kein Selektor`);
    const page = new RegExp(`\\{ path: '${route}',\\s*page: '([^']+)'`).exec(router)?.[1];
    assert.ok(page, `${route}: keine Seite in der Routentabelle`);
    const src = readFileSync(new URL(`../public${page}`, import.meta.url), 'utf8');
    assert.ok(src.includes(`id="${id}"`), `${route}: ${page} traegt keinen Knopf mit id="${id}" - "+ Neu" oeffnet dort nichts`);
  }
});

test('DW-P1-1 + U2: ohne Blatt ueber der Uebersicht wechseln Pille und Speed-Dial ins Modul und klicken dort den Knopf', async () => {
  const targets = __test.FAB_NEW_BTN;
  assert.ok(targets, 'FAB_NEW_BTN ist nicht erreichbar');
  // Die Zielseiten tragen die Knoepfe, die ihr Markup traegt (vorige Probe).
  const real = ['fab-new-task', 'fab-new-event', 'fab-new-item', 'fab-new-note'];
  // Seit U2 oeffnen Aufgabe, Termin und Notiz ihr Blatt ueber der Uebersicht
  // (test:dashboard). Der Weg ins Modul bleibt fuer Einkauf - und fuer jedes
  // Ziel, dessen Blatt nicht laedt: hier scheitern alle Blaetter.
  const sheets = __test.NEW_SHEETS;
  const original = { ...sheets };
  for (const route of Object.keys(sheets)) sheets[route] = async () => { throw new Error('offline'); };
  const origError = console.error;
  console.error = () => {};
  try {
    await withNewTargets(async ({ visited, clicked, pageIds }) => {
      real.forEach((id) => pageIds.add(id));
      // Pille (Desktop): Klick auf einen Menuepunkt im Seiten-Container.
      const container = stubEl();
      __test.wireNewMenu(container, new AbortController().signal);
      const onClick = container.listeners.find((l) => l.type === 'click' && !l.opts?.capture)?.fn;
      assert.ok(onClick, 'wireNewMenu haengt keinen Klick an den Container');
      for (const route of Object.keys(targets)) {
        const item = stubEl({ dataset: { newRoute: route } });
        await onClick({ target: { closest: (sel) => (sel === '[data-new-route]' ? item : null) } });
      }
      assert.deepEqual(visited, Object.keys(targets));
      assert.deepEqual(clicked, real, 'Pille: jedes Ziel oeffnet sein Anlegen-Blatt');

      // Speed-Dial (Telefon): der Knopf lebt in der Shell-Layer, findPageFab findet ihn.
      visited.length = 0;
      clicked.length = 0;
      const items = Object.keys(targets).map((route) => stubEl({ dataset: { route } }));
      const fabActions = stubEl({ querySelectorAll: (sel) => (sel === '[data-route]' ? items : []) });
      const group = stubEl({ querySelector: (sel) => (sel === '#fab-actions' ? fabActions : null) });
      const fabMain = stubEl({ closest: (sel) => (sel === '.page-fab-group' ? group : null) });
      const getById = globalThis.document.getElementById;
      globalThis.document.getElementById = (id) => (id === 'fab-main' ? fabMain : getById(id));
      __test.initFab(new AbortController().signal);
      for (const el of items) {
        const go = el.listeners.find((l) => l.type === 'click')?.fn;
        assert.ok(go, `Speed-Dial: ${el.dataset.route} ist nicht verdrahtet`);
        await go();
        // `go` wartet auf den Wechsel und klickt dann - einen Takt Luft fuer den Klick.
        await new Promise((r) => setImmediate(r));
      }
      assert.deepEqual(visited, Object.keys(targets));
      assert.deepEqual(clicked, real, 'Speed-Dial: jedes Ziel oeffnet sein Anlegen-Blatt');
    });
  } finally {
    console.error = origError;
    Object.assign(sheets, original);
  }
});

test('U2: jedes Blatt ueber der Uebersicht ruft eine Anlegen-Funktion, die sein Modul exportiert', async () => {
  const { readFileSync } = await import('node:fs');
  const sheets = __test.NEW_SHEETS;
  assert.ok(sheets, 'NEW_SHEETS ist nicht erreichbar');
  await withNewTargets(async () => {
    const offered = __test.FAB_ACTIONS().map((a) => a.route);
    for (const route of Object.keys(sheets)) assert.ok(offered.includes(route), `${route}: ein Blatt fuer ein Ziel, das "+ Neu" nicht anbietet`);
  });
  for (const [route, open] of Object.entries(sheets)) {
    const m = /import\('([^']+)'\)\)\.(\w+)\(/.exec(String(open));
    assert.ok(m, `${route}: das Blatt laedt sein Modul nicht beim Tipp nach`);
    const src = readFileSync(new URL(`../public${m[1]}`, import.meta.url), 'utf8');
    assert.match(src, new RegExp(`export async function ${m[2]}\\(`), `${m[1]} exportiert ${m[2]} nicht - "+ Neu" fiele still ins Modul zurueck`);
  }
});
