/**
 * Test: Verlauf der geteilten Ausgaben - "Mehr laden" und Tagesdatum (#1309)
 * Zweck: Der Verlauf lud nur die letzten 12 Eintraege, und eine aeltere Zahlung
 *        liess sich in der Oberflaeche nicht stornieren. Jetzt haengt "Mehr
 *        laden" die naechste Seite an (Cursor vom Server), und der Storno-Knopf
 *        an einem nachgeladenen Eintrag ist derselbe wie auf Seite eins.
 *
 *        Gefahren wird ueber den ECHTEN Klickweg: `onActivityClick` ist der
 *        Lauscher, den `renderMain` an `.split-activity` haengt (das haelt
 *        test:budget-readonly-ui fest), und jeder Klick kommt aus dem Markup,
 *        das die Seite selbst gezeichnet hat. Antworten loest der Test von Hand
 *        auf (`globalThis.__apiStub`), damit die Reihenfolge WIRKLICH verdreht
 *        werden kann - eine Antwort nach einem Gruppenwechsel, ein zweiter Klick
 *        waehrend die erste Seite unterwegs ist.
 *
 *        Das Datum laeuft durch das echte `zonedDateKey` (public/utils/timezone.js
 *        stubt der Loader nicht); `formatDate` ist gestubt und reicht den Key
 *        durch, der Test sieht also genau den Tag, den die Seite waehlt.
 * Ausfuehren: npm run test:split-activity-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };

const { installMiniDom } = await import('./mini-dom.js');
const miniDomAbraeumen = installMiniDom();

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { setDisplayTimeZone, _resetDisplayTimeZoneCache } = await import('../public/utils/timezone.js');
const { __test: split } = await import('../public/pages/split-expenses.js');

test.after(() => miniDomAbraeumen());

function withAccess(modules, fn) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try { return fn(); } finally { clearPermissions(); }
}

// Groessere id = spaeterer Zeitpunkt (eine Minute je id): eine absteigende
// id-Liste ist damit auch in der Reihenfolge des Servers (created_at absteigend).
const zeitpunkt = (id) => new Date(Date.UTC(2026, 8, 20, 10, 0, 0) + id * 60000).toISOString().replace('.000Z', 'Z');

function eintrag(id, extra = {}) {
  return { id, type: 'expense_created', entity_type: 'expense', entity_id: id, actor_name: 'Alex', created_at: zeitpunkt(id), ...extra };
}

function zahlung(id, settlementId, extra = {}) {
  return eintrag(id, {
    type: 'payment_registered', entity_type: 'settlement', entity_id: settlementId,
    settlement: {
      id: settlementId, payer_id: 3, payer_name: 'Emma', payee_id: 1, payee_name: 'Alex',
      amount_minor: 2000, amount: '20.00', currency: 'EUR', reversed_at: null, can_reverse: true, ...extra,
    },
  });
}

/** Klick auf ein Element aus dem ECHTEN Markup - Attribute kommen von dort. */
function klickAus(html, selector) {
  const knopf = html.match(new RegExp(`<button [^>]*${selector}[^>]*>`));
  assert.ok(knopf, `kein Knopf ${selector} im Markup`);
  const dataset = {};
  for (const [, name, wert] of knopf[0].matchAll(/data-([\w-]+)(?:="([^"]*)")?/g)) {
    dataset[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = wert ?? '';
  }
  return {
    target: {
      closest: (sel) => {
        const m = sel.match(/^\[data-([\w-]+)\]$/);
        return m && m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()) in dataset ? { dataset } : null;
      },
    },
  };
}

/** Ein Versprechen, das der Test selbst aufloest. */
function offen() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Buehne: eine Gruppe mit geladenem Verlauf, `.split-activity` als Kasten, den
 * renderActivityBox neu zeichnet. `gets` sammelt jeden GET-Pfad, `antwort`
 * entscheidet je Pfad (Funktion, die ein Versprechen oder einen Wert liefert).
 */
function buehne({ activity, cursor, antwort, groupId = 2, modus = 'write' }) {
  const gets = [];
  const posts = [];
  const box = {
    html: '',
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_p, m) { this.html += m; },
    querySelector: () => ({ focus() {} }),
  };
  // Alles ausser dem Verlauf: ein stummes Element, damit renderAll() nach
  // einem Storno durchlaeuft (Kopf, Gruppen, Hauptteil).
  const leer = {
    hidden: false, removeAttribute() {}, replaceChildren() {}, insertAdjacentHTML() {},
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  };
  const vorher = { ...split.state };
  Object.assign(split.state, {
    activeGroupId: groupId, groupStatus: 'active', user: null,
    groups: [{ id: groupId, name: 'Urlaub Ostsee', type: 'trip', description: '' }, { id: 5, name: 'WG', type: 'household', description: '' }],
    expenses: [], balances: { balances: [], simplified_debts: [] },
    meta: { currencies: ['EUR'], default_currency: 'EUR' },
    activity, activityCursor: cursor, activityGroupId: groupId, activityLoadingMore: false,
  });
  split.renderMainForTest({ querySelector: (sel) => (sel === '.split-activity' ? box : leer) });
  globalThis.__apiStub = {
    get: async (path) => { gets.push(path); return antwort(path); },
    post: async (path, body) => { posts.push([path, body]); return { data: {} }; },
  };
  globalThis.__confirmModal = async () => true;
  setPermissions({ admin: false, modules: { budget: modus }, widgets: {}, capabilities: {} });
  const zeichne = () => { box.replaceChildren(); box.insertAdjacentHTML('beforeend', split.renderActivity()); return box.html; };
  zeichne();
  return {
    box, gets, posts, zeichne,
    abbauen() {
      clearPermissions();
      delete globalThis.__apiStub;
      delete globalThis.__confirmModal;
      Object.assign(split.state, vorher);
    },
  };
}

const CURSOR = { before_at: '2026-09-20T10:00:00Z', before_id: 12 };
const ersteSeite = () => Array.from({ length: 12 }, (_, i) => eintrag(100 - i));

test('"Mehr laden" steht nur, solange der Server eine weitere Seite meldet - bei jedem Recht und im Archiv', () => {
  const vorher = { ...split.state };
  try {
    for (const modus of ['write', 'read']) {
      for (const archiviert of [false, true]) {
        Object.assign(split.state, { activity: ersteSeite(), activityCursor: CURSOR, activityLoadingMore: false, groupStatus: archiviert ? 'archived' : 'active' });
        const html = withAccess({ budget: modus }, () => split.renderActivity());
        assert.match(html, /<button type="button" class="btn btn--secondary split-activity-more" data-activity-more>splitExpenses\.loadMoreActivity<\/button>/, `${modus} archiv=${archiviert}`);
      }
    }
    Object.assign(split.state, { activity: ersteSeite(), activityCursor: null, groupStatus: 'active' });
    assert.doesNotMatch(withAccess({ budget: 'write' }, () => split.renderActivity()), /data-activity-more/, 'alles geladen');
    Object.assign(split.state, { activity: ersteSeite(), activityCursor: CURSOR, activityLoadingMore: true });
    assert.match(withAccess({ budget: 'write' }, () => split.renderActivity()), /data-activity-more aria-disabled="true" aria-busy="true"/, 'waehrend des Ladens gesperrt');
  } finally { Object.assign(split.state, vorher); }
});

test('Mehr laden: Klick aus dem Markup holt die Seite hinter dem Cursor und haengt sie an', async () => {
  const b = buehne({
    activity: ersteSeite(), cursor: CURSOR,
    antwort: () => ({ data: [eintrag(88), zahlung(87, 7)], pagination: { limit: 12, has_more: false, next_cursor: null } }),
  });
  try {
    await split.onActivityClick(klickAus(b.box.html, 'data-activity-more'));
    assert.deepEqual(b.gets, ['/split-expenses/groups/2/activity?limit=12&before_at=2026-09-20T10%3A00%3A00Z&before_id=12']);
    assert.deepEqual(split.state.activity.map((a) => a.id), [...ersteSeite().map((a) => a.id), 88, 87]);
    assert.equal(split.state.activityCursor, null);
    assert.match(b.box.html, /data-reverse-settlement="7"/, 'der nachgeladene Eintrag steht im Kasten');
    assert.doesNotMatch(b.box.html, /data-activity-more/, 'letzte Seite: kein Knopf mehr');
  } finally { b.abbauen(); }
});

test('Mehr laden: ein zweiter Klick waehrend die Seite unterwegs ist, laedt nicht doppelt', async () => {
  const seite = offen();
  const b = buehne({ activity: ersteSeite(), cursor: CURSOR, antwort: () => seite.promise });
  try {
    const klick = klickAus(b.box.html, 'data-activity-more');
    const erster = split.onActivityClick(klick);
    const zweiter = split.onActivityClick(klick);
    assert.match(b.box.html, /data-activity-more aria-disabled="true" aria-busy="true"/, 'der Knopf ist gesperrt');
    seite.resolve({ data: [eintrag(88)], pagination: { limit: 12, has_more: true, next_cursor: { before_at: '2026-09-19T08:00:00Z', before_id: 88 } } });
    await Promise.all([erster, zweiter]);
    assert.equal(b.gets.length, 1);
    assert.deepEqual(split.state.activity.map((a) => a.id).filter((id) => id === 88), [88], 'einmal angehaengt');
    assert.deepEqual(split.state.activityCursor, { before_at: '2026-09-19T08:00:00Z', before_id: 88 });
    assert.match(b.box.html, /data-activity-more>/, 'weitere Seite: der Knopf ist wieder bedienbar');
  } finally { b.abbauen(); }
});

test('Mehr laden: eine Antwort nach dem Gruppenwechsel haengt nichts an die neue Gruppe', async () => {
  const alteSeite = offen();
  const b = buehne({
    activity: ersteSeite(), cursor: CURSOR,
    antwort: (path) => {
      if (path.includes('/groups/2/activity')) return alteSeite.promise;
      if (path.includes('/groups/5/activity')) return { data: [eintrag(500)], pagination: { limit: 12, offset: 0, has_more: false, next_cursor: null } };
      return { data: [] };
    },
  });
  try {
    const laden = split.onActivityClick(klickAus(b.box.html, 'data-activity-more'));
    split.state.activeGroupId = 5;
    await split.loadGroupData();
    assert.deepEqual(split.state.activity.map((a) => a.id), [500]);
    alteSeite.resolve({ data: [eintrag(88)], pagination: { limit: 12, has_more: true, next_cursor: { before_at: 'x', before_id: 1 } } });
    await laden;
    assert.deepEqual(split.state.activity.map((a) => a.id), [500], 'die alte Seite ist verworfen');
    assert.equal(split.state.activityCursor, null, 'und ihr Cursor auch');
    assert.equal(split.state.activityGroupId, 5);
  } finally { b.abbauen(); }
});

test('Gruppenwechsel faengt vorn an, mit der Seitengroesse 12', async () => {
  const b = buehne({
    activity: [...ersteSeite(), eintrag(88)], cursor: null,
    antwort: (path) => (path.includes('/activity') ? { data: [eintrag(500)], pagination: { limit: 12, offset: 0, has_more: true, next_cursor: CURSOR } } : { data: [] }),
  });
  try {
    split.state.activeGroupId = 5;
    await split.loadGroupData();
    assert.deepEqual(b.gets.filter((p) => p.includes('/activity')), ['/split-expenses/groups/5/activity?limit=12']);
    assert.deepEqual(split.state.activityCursor, CURSOR);
  } finally { b.abbauen(); }
});

test('Storno an einem nachgeladenen Eintrag: POST an dessen Zahlung, danach bleibt die Tiefe', async () => {
  // Der Server: Seite 1 (12 Eintraege), Seite 2 mit der Zahlung 7. Nach dem
  // Storno steht vorn ein neuer Eintrag (payment_reversed), die Zahlung ist
  // storniert.
  let storniert = false;
  const serverListe = () => [
    ...(storniert ? [eintrag(200, { type: 'payment_reversed', entity_type: 'settlement', entity_id: 7 })] : []),
    ...ersteSeite(),
    zahlung(87, 7, storniert ? { reversed_at: '2026-09-21T08:00:00Z', can_reverse: false } : {}),
    eintrag(86),
  ];
  const b = buehne({
    activity: ersteSeite(), cursor: CURSOR,
    antwort: (path) => {
      if (!path.includes('/activity')) return { data: [] };
      const q = new URL(path, 'http://x').searchParams;
      const liste = serverListe();
      const ab = q.get('before_id') ? liste.findIndex((a) => a.id === Number(q.get('before_id'))) + 1 : 0;
      const seite = liste.slice(ab, ab + Number(q.get('limit')));
      const mehr = ab + seite.length < liste.length;
      const last = seite[seite.length - 1];
      return { data: seite, pagination: { limit: Number(q.get('limit')), has_more: mehr, next_cursor: mehr ? { before_at: last.created_at, before_id: last.id } : null } };
    },
  });
  try {
    // Der Cursor, wie ihn dieser Server-Doppel nach Seite 1 geliefert haette.
    split.state.activityCursor = { before_at: zeitpunkt(89), before_id: 89 };
    b.zeichne();
    await split.onActivityClick(klickAus(b.box.html, 'data-activity-more'));
    assert.deepEqual(split.state.activity.slice(-2).map((a) => a.id), [87, 86]);
    const post = globalThis.__apiStub.post;
    globalThis.__apiStub.post = async (...args) => { storniert = true; return post(...args); };
    await split.onActivityClick(klickAus(b.box.html, 'data-reverse-settlement="7"'));
    assert.deepEqual(b.posts, [['/split-expenses/groups/2/settlements/7/reverse', {}]]);
    // Nach dem Neuladen: die Zahlung ist noch geladen, jetzt als storniert.
    const nachher = split.state.activity.find((a) => a.id === 87);
    assert.ok(nachher, 'die stornierte Zahlung ist nach dem Neuladen noch im Verlauf');
    assert.equal(nachher.settlement.reversed_at, '2026-09-21T08:00:00Z');
    assert.equal(split.state.activity[0].id, 200, 'der Storno-Eintrag steht vorn');
    assert.equal(new Set(split.state.activity.map((a) => a.id)).size, split.state.activity.length, 'keine Dubletten');
    // Die erste Abfrage nach dem Storno fragt die ganze bisherige Tiefe (+1 fuer den neuen Eintrag).
    const nachStorno = b.gets.filter((p) => p.includes('/activity') && !p.includes('before_id'));
    assert.equal(new URL(nachStorno.at(-1), 'http://x').searchParams.get('limit'), '15');
  } finally { b.abbauen(); }
});

test('Neuladen in derselben Gruppe blaettert nach, bis der bisher letzte Eintrag wieder da ist', async () => {
  // 30 von 60 Eintraegen geladen; der Server liefert je Anfrage hoechstens 20 -
  // der Rest muss per Cursor nachkommen, sonst schrumpft der Verlauf.
  const liste = Array.from({ length: 60 }, (_, i) => eintrag(1000 - i));
  const b = buehne({
    activity: liste.slice(0, 30), cursor: { before_at: liste[29].created_at, before_id: 971 },
    antwort: (path) => {
      if (!path.includes('/activity')) return { data: [] };
      const q = new URL(path, 'http://x').searchParams;
      const ab = q.get('before_id') ? liste.findIndex((a) => a.id === Number(q.get('before_id'))) + 1 : 0;
      const seite = liste.slice(ab, ab + Math.min(20, Number(q.get('limit'))));
      const mehr = ab + seite.length < liste.length;
      return { data: seite, pagination: { has_more: mehr, next_cursor: mehr ? { before_at: seite.at(-1).created_at, before_id: seite.at(-1).id } : null } };
    },
  });
  try {
    await split.loadGroupData();
    assert.ok(split.state.activity.length >= 30, `Tiefe gehalten (${split.state.activity.length})`);
    assert.ok(split.state.activity.some((a) => a.id === 971), 'der bisher letzte Eintrag ist wieder geladen');
    assert.ok(split.state.activityCursor, 'und es geht weiter');
  } finally { b.abbauen(); }
});

test('Datum: der Tag in der Haushaltszone, nicht der UTC-Tag', () => {
  const vorher = { ...split.state };
  try {
    Object.assign(split.state, { activity: [eintrag(1, { created_at: '2026-09-20T23:30:00Z' })], activityCursor: null, groupStatus: 'active' });
    setDisplayTimeZone('Europe/Berlin');
    const berlin = withAccess({ budget: 'write' }, () => split.renderActivity());
    assert.match(berlin, /Alex · 2026-09-21</, '23:30 UTC ist in Berlin schon der 21.');
    setDisplayTimeZone('America/New_York');
    assert.match(withAccess({ budget: 'write' }, () => split.renderActivity()), /Alex · 2026-09-20</, 'in New York noch der 20.');
    Object.assign(split.state, { activity: [eintrag(1, { created_at: '2026-09-21T02:30:00Z' })] });
    assert.match(withAccess({ budget: 'write' }, () => split.renderActivity()), /Alex · 2026-09-20</, '02:30 UTC ist in New York noch der Vortag');
  } finally {
    setDisplayTimeZone(null);
    _resetDisplayTimeZoneCache();
    Object.assign(split.state, vorher);
  }
});

test('geloeschte Ausgabe (#1382): Zeichen am Anlege-Eintrag, Loesch-Eintrag nennt sie ohne Zeichen', () => {
  const vorher = { ...split.state };
  const ausgabe = (extra = {}) => ({ id: 9, title: 'Einkauf', amount_minor: 3000, amount: '30.00', currency: 'EUR', deleted_at: null, ...extra });
  const zeichne = (activity, modus = 'write') => {
    Object.assign(split.state, { activity, activityCursor: null, groupStatus: 'active' });
    return withAccess({ budget: modus }, () => split.renderActivity());
  };
  try {
    // Aktiv: die Zeile nennt die Ausgabe, kein Zeichen, nicht durchgestrichen.
    const aktiv = zeichne([eintrag(1, { entity_id: 9, expense: ausgabe() })]);
    // Der t()-Stub haengt die Parameter an: Titel und der Betrag in seiner Waehrung.
    const detail = /<span class="split-activity-payment">splitExpenses\.expenseDetail\{&quot;title&quot;:&quot;Einkauf&quot;,&quot;amount&quot;:&quot;30,00\s€&quot;\}<\/span>/;
    assert.match(aktiv, detail);
    assert.doesNotMatch(aktiv, /split-activity-item--reversed|split-activity-reversed/);

    // Geloescht: bei jedem Recht das Zeichen und die durchgestrichene Zeile.
    const weg = ausgabe({ deleted_at: '2026-09-21T08:00:00Z' });
    for (const modus of ['write', 'read']) {
      const html = zeichne([
        eintrag(2, { type: 'expense_deleted', entity_id: 9, expense: weg }),
        eintrag(1, { entity_id: 9, expense: weg }),
      ], modus);
      const [loeschung, anlage] = html.split('<div class="split-activity-item').slice(1);
      assert.match(anlage, /^ split-activity-item--reversed"/, modus);
      assert.match(anlage, /<span class="split-activity-reversed">splitExpenses\.expenseDeleted<\/span>/, modus);
      assert.match(loeschung, /^"/, `${modus}: der Loesch-Eintrag ist nicht durchgestrichen`);
      assert.match(loeschung, detail, modus);
      assert.doesNotMatch(loeschung, /split-activity-reversed/, modus);
      assert.doesNotMatch(html, /data-reverse-settlement/, `${modus}: keine Handlung`);
    }
  } finally {
    Object.assign(split.state, vorher);
  }
});
