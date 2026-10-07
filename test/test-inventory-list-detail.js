/**
 * Test: Inventar in Liste + Detail (Breitenregel, DESIGN.md)
 * Zweck: Inventar haengt den geteilten Baustein utils/master-detail.js ein.
 *        Der Baustein findet seine Zeilen NUR ueber `data-md-id` und fokussiert
 *        bei Pfeiltasten das Element mit `data-md-focus` - fehlt eines, steht
 *        die Detailspalte, aber keine Zeile ist waehlbar und die Pfeiltasten
 *        tun nichts. Seit R17 (E3) ist die Seite EINE Liste aller Gegenstaende,
 *        nach Kategorie gruppiert, die Kategorie ein Filter-Chip mit Adresse;
 *        ein Deep-Link `?open=` muss dafuer sorgen, dass die Zeile des
 *        Gegenstands in der Liste steht, sonst raeumt der erste Neuaufbau die
 *        Auswahl wieder ab (master-detail.js#refresh).
 *        Geprueft wird das VERHALTEN der echten Funktionen, nicht der Quelltext.
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-inventory-list-detail.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { __test: inventory } = await import('../public/pages/inventory.js');

const ITEM = {
  id: 42, name: 'Fernseher', category: 'electronics', status: 'owned', condition: 'good',
  location_path: 'Wohnzimmer', purchase_price: 999, currency: 'EUR', attachments: [], linked_entries: [],
  tracked_dates: [],
};

test('jede Gegenstandszeile ist fuer den Baustein waehlbar (data-md-id) und fokussierbar (data-md-focus)', () => {
  const html = inventory.renderItemRow(ITEM);
  const row = html.match(/<div class="list-row"[^>]*>/)?.[0];
  assert.ok(row, 'Zeile nicht gefunden - der Test liest das Markup nicht mehr');
  assert.match(row, /data-md-id="42"/, 'die Zeile traegt ihre ID fuer utils/master-detail.js');
  const main = html.match(/<button[^>]*data-action="open-detail"[^>]*>/)?.[0];
  assert.ok(main, 'Hauptknopf nicht gefunden');
  assert.match(main, /\bdata-md-focus\b/, 'der Hauptknopf ist das Fokusziel der Pfeiltasten');
});

/** Browser-Umgebung, die revealDeepLinkedItem liest: Adresse und die
 *  gerechnete Darstellung der Detailspalte (die Container Query entscheidet). */
function withEnv({ search, display }, fn) {
  const saved = { location: globalThis.location, gcs: globalThis.getComputedStyle, history: globalThis.history };
  globalThis.location = { search, pathname: '/inventory' };
  globalThis.getComputedStyle = () => ({ display });
  const writes = [];
  globalThis.history = { state: null, replaceState: (_s, _t, url) => writes.push(url) };
  try { return fn(writes); } finally {
    globalThis.location = saved.location;
    globalThis.getComputedStyle = saved.gcs;
    globalThis.history = saved.history;
  }
}

const split = { querySelector: (sel) => (sel === '.split-view__detail' ? {} : null) };

function resetState() {
  inventory.state.items = [ITEM, { ...ITEM, id: 7, category: 'vehicles' }];
  inventory.state.activeCategory = null;
  inventory.state.query = '';
  inventory.state.filterAttention = false;
}

test('Deep-Link ?open= in der Spaltenform: unter „Alle" steht die Zeile schon da, der Filter bleibt', () => {
  resetState();
  withEnv({ search: '?open=7', display: 'flex' }, (writes) => {
    inventory.revealDeepLinkedItem(split);
    assert.equal(inventory.state.activeCategory, null, 'kein Chip wird fuer einen Gegenstand gesetzt');
    assert.deepEqual(writes, [], 'die Adresse bleibt, wie sie kam');
  });
});

test('eine Kategorie-Adresse behaelt ihren Chip, wenn der Gegenstand in ihr liegt', () => {
  resetState();
  inventory.state.activeCategory = 'vehicles';
  withEnv({ search: '?category=vehicles&open=7', display: 'flex' }, (writes) => {
    inventory.revealDeepLinkedItem(split);
    assert.equal(inventory.state.activeCategory, 'vehicles');
    assert.deepEqual(writes, []);
  });
});

test('nennt die Adresse eine ANDERE Kategorie, gewinnt der Gegenstand: es gilt „Alle"', () => {
  resetState();
  inventory.state.activeCategory = 'electronics';
  withEnv({ search: '?category=electronics&open=7', display: 'flex' }, (writes) => {
    inventory.revealDeepLinkedItem(split);
    assert.equal(inventory.state.activeCategory, null);
    assert.deepEqual(writes, ['/inventory?open=7'], 'ersetzt, nicht gestapelt');
  });
});

test('der Deep-Link raeumt Suche und Fristen-Filter - sonst fehlte die Zeile in der Liste', () => {
  // Beide ueberleben den Seitenwechsel. Stuende ein alter davon noch, fehlte
  // die Zeile des Gegenstands, und rechts stuende ein Detail ohne Zeile, das
  // der naechste Listenaufbau abraeumt.
  resetState();
  inventory.state.query = 'bohrmaschine';
  inventory.state.filterAttention = true;
  try {
    withEnv({ search: '?open=7', display: 'flex' }, () => inventory.revealDeepLinkedItem(split));
    assert.equal(inventory.state.query, '', 'die alte Suche faellt weg');
    assert.equal(inventory.state.filterAttention, false, 'der Fristen-Filter faellt weg');
    assert.ok(inventory.visibleGroups().some((g) => g.items.some((i) => i.id === 7)), 'die Zeile steht in der Liste');
  } finally { resetState(); }
});

test('unter der Schwelle loest niemand den Link ein - Suche und Filter bleiben', () => {
  resetState();
  inventory.state.query = 'fern';
  try {
    withEnv({ search: '?open=7', display: 'none' }, () => inventory.revealDeepLinkedItem(split));
    assert.equal(inventory.state.query, 'fern');
  } finally { resetState(); }
});

test('breiter gezogen mit ?open= aus dem Telefon: die Zeile des Gegenstands steht in der Liste', () => {
  // Unter der Schwelle merkte sich der Baustein die ID. Wird das Fenster
  // breiter, malt er das Detail - links muss dann die Zeile stehen (eine Suche
  // vom Telefon kann sie verbergen), sonst raeumt der naechste Neuaufbau
  // Auswahl und Adresse ab.
  resetState();
  inventory.state.query = 'bohrmaschine';
  try {
    inventory.onInventoryModeChange({ split: false, selectedId: '7' });
    assert.equal(inventory.state.query, 'bohrmaschine', 'schmaler: nichts umschalten');
    inventory.onInventoryModeChange({ split: true, selectedId: null });
    assert.equal(inventory.state.query, 'bohrmaschine', 'ohne Auswahl: nichts umschalten');
    inventory.onInventoryModeChange({ split: true, selectedId: '7' });
    assert.equal(inventory.state.query, '', 'die Suche faellt weg, die Zeile steht da');
  } finally { resetState(); }
  const src = readFileSync(new URL('../public/pages/inventory.js', import.meta.url), 'utf8');
  const mount = src.slice(src.indexOf('_md = mountMasterDetail({'));
  assert.match(mount.slice(0, mount.indexOf('\n    });')), /onModeChange: onInventoryModeChange/,
    'der Baustein ruft den Haken beim Wechsel der Darstellung');
});

test('eine unbekannte ID laesst Filter und Suche stehen', () => {
  resetState();
  inventory.state.query = 'fern';
  try {
    withEnv({ search: '?open=999', display: 'flex' }, () => inventory.revealDeepLinkedItem(split));
    assert.equal(inventory.state.query, 'fern');
  } finally { resetState(); }
});

// ---------------------------------------------------------------------------
// Die Detailspalte steht in Ruhe ganz im Fenster (Runde 5, 2026-09-26)
// ---------------------------------------------------------------------------
// Ihre Hoehe rechnete nur den Kopf; in Ruhe steht darunter aber die Filterzeile,
// und die Spalte ragte um deren Hoehe unter den Falz (1440x900: Oberkante 133,
// Hoehe 803, Unterkante 936). Jetzt misst die Seite die Oberkante der Spalte,
// und die CSS rechnet von dort.

function fakePage() {
  const props = new Map();
  return { props, style: { setProperty: (k, v) => props.set(k, v) } };
}
const fakeDetail = (top, shown = true) => ({
  getClientRects: () => (shown ? [{}] : []),
  getBoundingClientRect: () => ({ top }),
});

test('syncDetailTop setzt die gemessene Oberkante der Spalte (Ruhe und Klebestand)', () => {
  const page = fakePage();
  inventory.syncDetailTop(page, fakeDetail(133.4));
  assert.equal(page.props.get('--inventory-detail-top'), '133px', 'Ruhe: unter Kopf UND Filterzeile');
  inventory.syncDetailTop(page, fakeDetail(81));
  assert.equal(page.props.get('--inventory-detail-top'), '81px', 'Klebestand: unter dem Kopf');
});

test('syncDetailTop laesst eine ausgeblendete Spalte (unter der Schwelle) und fehlende Knoten in Ruhe', () => {
  const page = fakePage();
  inventory.syncDetailTop(page, fakeDetail(0, false));
  inventory.syncDetailTop(page, null);
  inventory.syncDetailTop(null, fakeDetail(10));
  assert.equal(page.props.size, 0);
});

test('die Hoehe der klebenden Spalte rechnet ab ihrer gemessenen Oberkante bis zur Luft ueber dem Fensterrand', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/inventory.css', import.meta.url), 'utf8');
  const rule = [...eachRule(css)].find((r) => r.selector === '.inventory-page .split-view__detail'
    && r.at.some((a) => /module-surface/.test(a)));
  assert.ok(rule, 'Regel der klebenden Detailspalte fehlt');
  assert.match(rule.body, /position:\s*sticky/);
  // R10 L3 (A8 P1-2): VOLLE Hoehe (`height`, nicht `max-height` - sonst eine
  // 301px-Karte) und buendig mit der Liste (kein Versatz nach unten).
  assert.doesNotMatch(rule.body, /max-height\s*:/, 'die Spalte ist ein Ort, keine mit dem Inhalt wachsende Karte');
  assert.doesNotMatch(rule.body, /margin-block-start\s*:/, 'die Spalte beginnt buendig mit der Liste');
  const maxHeight = rule.body.match(/(?:^|;|\s)height:\s*([^;]+);/)?.[1] ?? '';
  // Die Oberkante ist der Messwert; ohne ihn (erster Frame) der Klebestand.
  // Und sie endet ueber dem Nachlauf der Shell (Installationsbanner, FAB):
  // eine klebende Spalte bis an den Fensterrand liegt sonst mit ihrem Fuss
  // darunter (R10, test:dashboard-surface-browser).
  assert.match(maxHeight, /^calc\(var\(--viewport-height\) - var\(--inventory-detail-top, calc\(var\(--inventory-head-block, 0px\) \+ var\(--space-3\)\)\) - var\(--space-4\) - var\(--shell-tail, 0px\)\)$/);
  // Rechnung am gemessenen Fall: 900 - 133 - 16 = 751, Unterkante 884 < 900.
  const top = 133; const vh = 900; const space4 = 16;
  assert.ok(top + (vh - top - space4) <= vh);
});

test('unter der Schwelle: das Blatt eines Gegenstands geht nach dem Laden nur auf, solange das Signal steht', async () => {
  // openItemDetail() laedt erst den Verlauf. Ging der Nutzer dazwischen
  // zurueck, wurde das Fenster breit oder die Seite verlassen, legte sich das
  // alte Blatt sonst ueber den neuen Zustand oder die Zielseite.
  resetState();
  const opened = [];
  let release;
  globalThis.__apiStub = { get: () => new Promise((r) => { release = () => r({ data: { timeline: [] } }); }) };
  globalThis.__openDetailView = (o) => opened.push(o.title);
  try {
    const stale = new AbortController();
    const first = inventory.openItemNarrow('7', null, { signal: stale.signal });
    stale.abort();
    release();
    await first;
    assert.deepEqual(opened, [], 'ueberholt: kein Blatt');
    const second = inventory.openItemNarrow('7', null, { signal: new AbortController().signal });
    release();
    await second;
    assert.equal(opened.length, 1, 'steht das Signal, geht das Blatt auf');
  } finally {
    delete globalThis.__apiStub;
    delete globalThis.__openDetailView;
  }
  const src = readFileSync(new URL('../public/pages/inventory.js', import.meta.url), 'utf8');
  const mount = src.slice(src.indexOf('_md = mountMasterDetail({'));
  assert.match(mount.slice(0, mount.indexOf('\n    });')), /openNarrow: openItemNarrow,/,
    'der Baustein ruft den Weg, der sein Signal weiterreicht');
});


// ── R10 L3: Detail gegliedert, Status nur als Ausnahme, Kennzahlen als Zeilen ──

test('die Zeile nennt den Status nur, wenn er vom Normalfall abweicht (A6 P3-3)', () => {
  assert.doesNotMatch(inventory.renderItemRow({ ...ITEM, status: 'active' }), /inventory-status-badge/,
    '„Vorhanden" in jeder Zeile ist Rauschen');
  assert.match(inventory.renderItemRow({ ...ITEM, status: 'sold' }), /inventory-status-badge--sold/,
    'die Ausnahme bleibt sichtbar');
});

test('das Detail ist gegliedert: Kopfzeilen, dann Kauf / Garantie / Zustand / Belege statt dreizehn loser Zeilen', async () => {
  const { installMiniDom } = await import('./mini-dom.js');
  const restore = installMiniDom();
  let sections;
  try {
    sections = inventory.renderItemDetail({ ...ITEM, condition: 'good' }, { timeline: [] }, () => {}, false);
  } finally { restore(); }
  const groups = sections.filter((s) => Array.isArray(s.rows)).map((s) => s.group);
  assert.deepEqual(groups, [
    'inventory.detailGroupPurchase', 'inventory.detailGroupWarranty',
    'inventory.detailGroupCondition', 'inventory.detailGroupRecords',
  ]);
  assert.ok(sections.length <= 7, `oberste Ebene ${sections.length} Eintraege - wieder eine lose Liste`);
  const labels = (g) => sections.find((s) => s.group === g).rows.map((r) => r.label);
  assert.ok(labels('inventory.detailGroupPurchase').includes('inventory.purchasePriceLabel'));
  assert.ok(labels('inventory.detailGroupWarranty').includes('documents.category.warranty'));
  assert.ok(labels('inventory.detailGroupCondition').includes('inventory.statusLabel'), 'das Detail nennt den Status immer');
  // Keine Zeile ging beim Gliedern verloren.
  const all = sections.flatMap((s) => (Array.isArray(s.rows) ? s.rows : [s])).map((r) => r.label);
  assert.equal(all.length, 19, 'alle Angaben des Gegenstands stehen weiter im Detail');
});

test('die geteilte Leseansicht zeichnet Gruppen mit Titel und laesst leere ganz weg', async () => {
  const { installMiniDom, MiniElement } = await import('./mini-dom.js');
  const restore = installMiniDom();
  const hadHtmlElement = 'HTMLElement' in globalThis;
  const savedHtmlElement = globalThis.HTMLElement;
  globalThis.HTMLElement = MiniElement;
  try {
    const dv = await import('../public/components/detail-view.js');
    const pane = globalThis.document.createElement('div');
    dv.openDetailView({
      title: 'Fernseher',
      pane,
      sections: [
        { icon: 'map-pin', label: 'Ort', value: 'Wohnzimmer' },
        { group: 'Kauf', rows: [{ icon: 'banknote', label: 'Preis', value: '999 EUR' }, { label: 'Haendler', value: '' }] },
        { group: 'Leer', rows: [{ label: 'Nichts', value: '' }] },
      ],
    });
    const html = pane.outerHTML;
    assert.equal(html.match(/class="detail-group"/g)?.length, 1, 'eine Gruppe ohne Inhalt faellt samt Titel weg');
    assert.match(html, /<section class="detail-group" aria-label="Kauf"><h3 class="detail-group__title">Kauf<\/h3>/);
    assert.doesNotMatch(html, /Leer|Haendler/, 'leere Zeilen und Gruppen stehen nicht da');
    assert.match(html, /999 EUR/);
  } finally {
    restore();
    if (hadHtmlElement) globalThis.HTMLElement = savedHtmlElement; else delete globalThis.HTMLElement;
  }
});

test('in der Spalte: Kennzahlen als Zeilen ohne Wortbruch, nicht als drei 136px-Kacheln (A8 P1-2)', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/inventory.css', import.meta.url), 'utf8');
  const inSplit = [...eachRule(css)].filter((r) => r.at.some((a) => /module-surface/.test(a)));
  const body = (sel) => inSplit.filter((r) => r.selector.trim() === sel).map((r) => r.body).join(';');
  assert.match(body('.inventory-list .metric-grid'), /grid-template-columns:\s*minmax\(0, 1fr\)/, 'eine Kennzahl je Zeile');
  assert.match(body('.inventory-list .metric-grid > .metric-card'), /flex-direction:\s*row/, 'Wort links, Zahl rechts');
  const label = body('.inventory-list .metric-grid .metric-card__label');
  assert.match(label, /overflow-wrap:\s*normal/, 'kein Bruch mitten im Wort („AUFMERKSAMKE/IT")');
  assert.match(label, /white-space:\s*nowrap/);
});

// Review R11: der Kilometerstand-Trend rechnet X nach dem Datum. Zwei
// Wartungen am selben Tag gaben der Achse keine Spanne, und jeder Punkt fiel
// auf die linke Kante - ein Punkt, keine Linie. Die geteilte Geometrie
// (utils/chart.js#chartTimePositions) verteilt dann nach dem Index.
test('Kilometerstand: Wartungen am selben Tag fallen nicht auf einen Punkt', async () => {
  const { chartScales } = await import('../public/utils/chart.js');
  const { left, right } = chartScales();
  const cxOf = (svg) => [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));

  const gleicherTag = inventory.odometerChartMarkup([
    { date: '2026-05-01', value: 12000 },
    { date: '2026-05-01', value: 12040 },
  ], 'km');
  const cx = cxOf(gleicherTag);
  assert.equal(cx.length, 2, 'zwei Messpunkte - der Test liest das Markup nicht mehr');
  assert.ok(Math.abs(cx[0] - left) < 0.5, `erster Punkt bei ${cx[0]}, erwartet ${left}`);
  assert.ok(Math.abs(cx[1] - right) < 0.5, `zweiter Punkt bei ${cx[1]}, erwartet ${right} - nicht auf dem ersten`);

  // Mit Spanne bleibt es die Zeitachse: der Februar steht bei seinem Tag.
  const verteilt = cxOf(inventory.odometerChartMarkup([
    { date: '2026-01-01', value: 1000 },
    { date: '2026-02-01', value: 1500 },
    { date: '2026-12-31', value: 9000 },
  ], 'km'));
  const erwartet = left + (31 / 364) * (right - left);
  assert.ok(Math.abs(verteilt[1] - erwartet) < 1, `Februar bei ${verteilt[1]}, erwartet ${erwartet.toFixed(1)}`);
});

// ---------------------------------------------------------------------------
// Eine Liste, die Kategorie ist ein Filter (Critique R17, E3)
// ---------------------------------------------------------------------------
// Bis R17 zeigte `/inventory` vier Kategoriezeilen und KEINEN Gegenstand
// (1280x800: 460px leer, zwei Klicks bis zum Detail); die Kategorie war eine
// zweite Ebene mit eigenem Kopf und Rueckweg. Jetzt: links alle Gegenstaende
// nach Kategorie gruppiert, darueber die Kategorien als Chips, rechts das
// Detail. `?category=` waehlt den Chip vor und wird ERSETZT, nicht gestapelt.

/** Eine History, die mitschreibt, und eine Adresse, die ihr folgt. */
function withHistory(start, fn) {
  const saved = { history: globalThis.history, location: globalThis.location };
  const entries = [{ state: null, url: start }];
  let index = 0;
  const loc = { pathname: '', search: '' };
  const setUrl = (url) => { const [p, q = ''] = url.split('?'); loc.pathname = p; loc.search = q ? `?${q}` : ''; };
  setUrl(start);
  const hist = {
    get state() { return entries[index].state; },
    pushState(state, _t, url) { entries.splice(index + 1); entries.push({ state, url }); index += 1; setUrl(url); },
    replaceState(state, _t, url) { entries[index] = { state, url }; setUrl(url); },
  };
  globalThis.history = hist;
  globalThis.location = loc;
  try { return fn({ hist, entries: () => entries.map((e) => e.url), loc }); } finally {
    globalThis.history = saved.history;
    globalThis.location = saved.location;
  }
}

async function withInventoryState(fn) {
  const { installMiniDom } = await import('./mini-dom.js');
  const abraeumen = installMiniDom();
  const vorher = { ...inventory.state };
  inventory.state.items = [
    { ...ITEM, category_name: 'Elektronik' },
    { ...ITEM, id: 8, name: 'Monitor', category_name: 'Elektronik', location_id: null, location_path: null },
    { ...ITEM, id: 7, name: 'Auto', category: 'vehicles', category_name: 'Fahrzeuge', location_id: null, location_path: null },
  ];
  inventory.state.categories = [
    { key: 'electronics', name: 'Elektronik' }, { key: 'vehicles', name: 'Fahrzeuge' }, { key: 'sports', name: 'Sport' },
  ];
  inventory.state.locations = [];
  inventory.state.activeCategory = null;
  inventory.state.query = '';
  inventory.state.filterAttention = false;
  try { return await fn(); } finally {
    Object.assign(inventory.state, vorher);
    abraeumen();
  }
}

test('E3: die Liste zeigt ALLE Gegenstaende nach Kategorie gruppiert - kein Kategorie-Zwischenschritt', async () => {
  await withInventoryState(() => {
    const groups = inventory.visibleGroups();
    assert.deepEqual(groups.map((g) => [g.key, g.items.map((i) => i.id)]), [['electronics', [42, 8]], ['vehicles', [7]]],
      'jeder Gegenstand steht auf der Wurzel, in der Gruppe seiner Kategorie, in der Reihenfolge der Kategorien');
  });
  const src = readFileSync(new URL('../public/pages/inventory.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /data-action="open-category"/, 'keine Kategoriezeile mehr, die eine Ebene oeffnet');
  assert.doesNotMatch(src, /inventory-toolbar__back/, 'kein Rueckweg aus einer Ebene, die es nicht mehr gibt');
  assert.doesNotMatch(src, /data-inventory-level|inventoryLevel/, 'die Seite fuehrt keine Ebenen mehr');
});

test('E3: die Kategorien stehen als Chips - nur solche mit Bestand, mit ihrer Anzahl', async () => {
  await withInventoryState(() => {
    assert.deepEqual(inventory.categoryChips(), [
      { key: 'electronics', name: 'Elektronik', count: 2 },
      { key: 'vehicles', name: 'Fahrzeuge', count: 1 },
    ], 'die leere Kategorie „Sport" bekommt keinen Chip');
  });
  const src = readFileSync(new URL('../public/pages/inventory.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function updateFilterChips()'), src.indexOf('\n}\n', src.indexOf('function updateFilterChips()')));
  assert.match(fn, /class="filter-chip filter-chip--sm/, 'der geteilte Chip (styles/filter-chip.css)');
  assert.match(fn, /data-category=""[^>]*aria-pressed/, '„Alle" ist der erste Chip und nennt seinen Zustand');
  assert.match(fn, /categoryChips\(\)/);
});

test('E3: ein Chip zeigt nur seine Kategorie (nach Ort gruppiert) und ersetzt die Adresse', async () => {
  await withInventoryState(() => withHistory('/inventory', ({ entries, hist }) => {
    inventory.selectCategory('electronics');
    assert.equal(inventory.state.activeCategory, 'electronics');
    assert.deepEqual(entries(), ['/inventory?category=electronics'], 'ein Filter ist kein Schritt fuer die Zurueck-Taste');
    assert.equal(hist.state?.path, '/inventory?category=electronics', 'der Router liest `path` bei popstate');
    const groups = inventory.visibleGroups();
    assert.deepEqual(groups.flatMap((g) => g.items.map((i) => i.id)).sort(), [42, 8].sort());
    assert.ok(groups.every((g) => g.icon === 'map-pin'), 'unter einem Chip gruppiert der Ort - der Kategoriename stuende sonst doppelt');
    inventory.selectCategory(null);
    assert.deepEqual(entries(), ['/inventory'], '„Alle" nimmt die Kategorie aus der Adresse');
    inventory.selectCategory('sports');
    assert.equal(inventory.state.activeCategory, null, 'eine Kategorie ohne Gegenstand ist nicht waehlbar');
  }));
});

test('E3: Suche und Fristen-Filter greifen IM Chip statt ihn zu loeschen', async () => {
  await withInventoryState(() => withHistory('/inventory', () => {
    inventory.state.query = 'moni';
    inventory.selectCategory('electronics');
    assert.equal(inventory.state.query, 'moni', 'der Chip laesst die Suche stehen');
    assert.deepEqual(inventory.visibleGroups().flatMap((g) => g.items.map((i) => i.id)), [8]);
    inventory.selectCategory('vehicles');
    assert.deepEqual(inventory.visibleGroups(), [], 'nichts trifft: Leerzustand statt fremder Zeilen');
  }));
});

test('E3: Zurueck/Vor stellt den Chip aus der Adresse wieder her', async () => {
  await withInventoryState(() => withHistory('/inventory', ({ loc }) => {
    loc.search = '?category=vehicles&open=7';
    assert.equal(inventory.syncCategoryFromAddress(), true);
    assert.equal(inventory.state.activeCategory, 'vehicles');
    assert.equal(inventory.syncCategoryFromAddress(), false, 'derselbe Stand zeichnet nicht neu');
    loc.search = '';
    inventory.syncCategoryFromAddress();
    assert.equal(inventory.state.activeCategory, null);
    // Eine Adresse mit einer Kategorie, die es nicht (mehr) gibt: „Alle".
    loc.search = '?category=weg';
    inventory.syncCategoryFromAddress();
    assert.equal(inventory.state.activeCategory, null);
  }));
});

test('E3: die Adresse einer Auswahl behaelt den Chip (master-detail `address`)', async () => {
  await withInventoryState(() => withHistory('/inventory', () => {
    inventory.selectCategory('vehicles');
    assert.equal(inventory.mdAddress.href('7'), '/inventory?category=vehicles&open=7');
    assert.equal(inventory.mdAddress.href(null), '/inventory?category=vehicles');
    assert.equal(inventory.mdAddress.read({ pathname: '/inventory', search: '?category=vehicles&open=7' }), '7');
    assert.equal(inventory.mdAddress.read({ pathname: '/inventory', search: '?category=vehicles' }), null,
      'ein anderer Filterstand ist dieselbe Seite - Zurueck/Vor zeichnet sie nicht neu');
    assert.equal(inventory.mdAddress.read({ pathname: '/tasks', search: '' }), undefined);
  }));
  const src = readFileSync(new URL('../public/pages/inventory.js', import.meta.url), 'utf8');
  const mount = src.slice(src.indexOf('_md = mountMasterDetail({'));
  assert.match(mount.slice(0, mount.indexOf('\n    });')), /address: mdAddress/, 'der Baustein liest die Adresse ueber mdAddress');
});

test('E3: am Desktop steht die Detailspalte IMMER - keine Ebene blendet sie aus', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/inventory.css', import.meta.url), 'utf8');
  for (const { selector, body } of eachRule(css)) {
    assert.doesNotMatch(selector, /data-inventory-level/, `Ebenen-Regel uebrig: ${selector}`);
    if (/\.split-view__detail\s*$/.test(selector.trim())) {
      assert.doesNotMatch(body, /display:\s*none/, 'die Spalte wird im Inventar nie verborgen (das tut nur die Schwelle in layout.css)');
    }
  }
});

test('E3: das Detail setzt kurze Angaben zweispaltig, wenn die SPALTE es traegt', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/inventory.css', import.meta.url), 'utf8');
  const pane = [...eachRule(css)].filter(({ at }) => at.some((a) => /^@container detail-pane \(min-width: \d+rem\)/.test(a.trim())));
  const grid = pane.find(({ selector }) => selector.trim() === '.inventory-page .detail-group__rows');
  assert.ok(grid, 'die Regel fragt die Detailspalte (Container `detail-pane`), nicht das Fenster');
  assert.match(grid.body, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  const wide = pane.find(({ selector }) => /detail-row--multiline/.test(selector));
  assert.ok(wide && /grid-column:\s*1\s*\/\s*-1/.test(wide.body), 'Notizen, Fristen, Belege und Verlauf nehmen beide Spalten');
  assert.match(wide.selector, /\.detail-row__value:not\(span\)/, 'ein Knoten statt eines kurzen Werts nimmt die Zeile');
});

test('E3: die Garantie-Zeile heisst „Garantie" und nennt Dauer UND Stand', async () => {
  // t() gibt im Test-Loader den Key samt Parametern zurueck.
  const item = { ...ITEM, condition: 'good', purchase_date: '2020-01-15', warranty_months: 24 };
  const value = inventory.warrantyDetailValue(item);
  assert.match(value, /^inventory\.warrantyMonthsValue\{"count":24\} · inventory\.warrantyStatusExpired/,
    `erst die Dauer, dahinter der berechnete Stand: ${value}`);
  assert.equal(inventory.warrantyDetailValue({ ...ITEM, warranty_months: 12, purchase_date: null }),
    'inventory.warrantyMonthsValue{"count":12}', 'ohne Kaufdatum nur die Dauer');
  const { installMiniDom } = await import('./mini-dom.js');
  const restore = installMiniDom();
  let rows;
  try { rows = inventory.renderItemDetail(item, { timeline: [] }, () => {}, false); } finally { restore(); }
  const warranty = rows.flatMap((r) => r.rows ?? [r]).find((r) => r.icon === 'shield');
  assert.equal(warranty.label, 'documents.category.warranty',
    'das Formular-Label „Garantie (Monate)" verspraeche eine Zahl, der Wert nennt ein Datum');
  assert.equal(warranty.value, value);
});

test('R17: nach dem Loeschen raeumt die Liste die Adresse erst, wenn die Rueckfrage ihren History-Marker zurueckgegeben hat', () => {
  // Die Rueckfrage gibt ihren Marker per `history.back()` zurueck, und das
  // kommt erst nach ihrem Ausblenden an. Schrieb der Listenaufbau vorher,
  // landete `?open=` ohne den geloeschten Gegenstand auf dem MARKER-Eintrag,
  // und das `back()` trug die alte Adresse wieder herein (`?open=9` blieb).
  const src = readFileSync(new URL('../public/pages/inventory.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function removeItem(item)');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const code = body.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const settled = code.indexOf('await whenHistorySettled();');
  const redraw = code.indexOf('renderList({ repaint: true, motion: true })');
  assert.ok(settled > 0, 'removeItem wartet auf die History');
  assert.ok(redraw > settled, 'und zeichnet die Liste (samt Adresse der Auswahl) erst danach');
  assert.match(src, /import \{[^}]*\bwhenHistorySettled\b[^}]*\} from '\/utils\/overlay-history\.js'/);
});
