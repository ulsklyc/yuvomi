/**
 * Test: Inventar in Liste + Detail (Breitenregel, DESIGN.md)
 * Zweck: Inventar haengt den geteilten Baustein utils/master-detail.js ein.
 *        Der Baustein findet seine Zeilen NUR ueber `data-md-id` und fokussiert
 *        bei Pfeiltasten das Element mit `data-md-focus` - fehlt eines, steht
 *        die Detailspalte, aber keine Zeile ist waehlbar und die Pfeiltasten
 *        tun nichts. Und ein Deep-Link `?open=` in der Spaltenform muss die
 *        Kategorie des Gegenstands oeffnen, sonst steht seine Zeile nicht in
 *        der Liste (die Startseite zeigt nur Kategorien) und der erste
 *        Neuaufbau raeumt die Auswahl wieder ab (master-detail.js#refresh).
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

/** Browser-Umgebung, die openDeepLinkedCategory liest: Adresse und die
 *  gerechnete Darstellung der Detailspalte (die Container Query entscheidet). */
function withEnv({ search, display }, fn) {
  const saved = { location: globalThis.location, gcs: globalThis.getComputedStyle };
  globalThis.location = { search };
  globalThis.getComputedStyle = () => ({ display });
  try { return fn(); } finally {
    globalThis.location = saved.location;
    globalThis.getComputedStyle = saved.gcs;
  }
}

const split = { querySelector: (sel) => (sel === '.split-view__detail' ? {} : null) };

function resetState() {
  inventory.state.items = [ITEM, { ...ITEM, id: 7, category: 'vehicles' }];
  inventory.state.view = 'browse';
  inventory.state.activeCategory = null;
}

test('Deep-Link ?open= in der Spaltenform oeffnet die Kategorie des Gegenstands', () => {
  resetState();
  withEnv({ search: '?open=7', display: 'flex' }, () => inventory.openDeepLinkedCategory(split));
  assert.equal(inventory.state.view, 'category');
  assert.equal(inventory.state.activeCategory, 'vehicles');
});

test('der Deep-Link raeumt Suche und Fristen-Filter wie ein Klick auf die Kategorie', () => {
  // Beide ueberleben den Seitenwechsel. Stuende ein alter davon noch, fehlte
  // die Zeile des Gegenstands in seiner Kategorie, und rechts stuende ein
  // Detail ohne Zeile, das der naechste Listenaufbau abraeumt.
  resetState();
  inventory.state.query = 'bohrmaschine';
  inventory.state.filterAttention = true;
  try {
    withEnv({ search: '?open=7', display: 'flex' }, () => inventory.openDeepLinkedCategory(split));
    assert.equal(inventory.state.activeCategory, 'vehicles');
    assert.equal(inventory.state.query, '', 'die alte Suche faellt weg');
    assert.equal(inventory.state.filterAttention, false, 'der Fristen-Filter faellt weg');
  } finally {
    inventory.state.query = '';
    inventory.state.filterAttention = false;
  }
});

test('unter der Schwelle bleibt die Startseite - kein Link springt beim Laden auf', () => {
  resetState();
  withEnv({ search: '?open=7', display: 'none' }, () => inventory.openDeepLinkedCategory(split));
  assert.equal(inventory.state.view, 'browse');
  assert.equal(inventory.state.activeCategory, null);
});

test('breiter gezogen mit ?open= aus dem Telefon: die Kategorie des Gegenstands geht auf', () => {
  // Unter der Schwelle blieb die Startseite stehen, der Baustein merkte sich
  // die ID. Wird das Fenster breiter, malt er das Detail - links muss dann die
  // Zeile stehen, sonst raeumt der naechste Neuaufbau Auswahl und Adresse ab.
  resetState();
  inventory.state.query = 'bohrmaschine';
  try {
    inventory.onInventoryModeChange({ split: false, selectedId: '7' });
    assert.equal(inventory.state.view, 'browse', 'schmaler: nichts umschalten');
    inventory.onInventoryModeChange({ split: true, selectedId: null });
    assert.equal(inventory.state.view, 'browse', 'ohne Auswahl: nichts umschalten');
    inventory.onInventoryModeChange({ split: true, selectedId: '7' });
    assert.equal(inventory.state.view, 'category');
    assert.equal(inventory.state.activeCategory, 'vehicles');
    assert.equal(inventory.state.query, '', 'wie ein Klick auf die Kategorie');
  } finally {
    inventory.state.query = '';
  }
  const src = readFileSync(new URL('../public/pages/inventory.js', import.meta.url), 'utf8');
  const mount = src.slice(src.indexOf('_md = mountMasterDetail({'));
  assert.match(mount.slice(0, mount.indexOf('\n    });')), /onModeChange: onInventoryModeChange/,
    'der Baustein ruft den Haken beim Wechsel der Darstellung');
});

test('eine unbekannte ID laesst die Startseite stehen', () => {
  resetState();
  withEnv({ search: '?open=999', display: 'flex' }, () => inventory.openDeepLinkedCategory(split));
  assert.equal(inventory.state.view, 'browse');
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
  assert.ok(labels('inventory.detailGroupWarranty').includes('inventory.warrantyMonthsLabel'));
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
// Die Kategorie hat eine Adresse (Re-Critique 2026-09-28, A6 P1-1 / A8 P2-1)
// ---------------------------------------------------------------------------
// `openCategory()` setzte nur `state.view`; die URL blieb `/inventory`. Casey
// wischte zurueck und landete im vorigen Modul statt in der Kategorienliste.
// Jetzt: `/inventory?category=<key>` per pushState, Zurueck/Vor stellt die
// Ebene aus der Adresse wieder her, und oben steht „‹ Inventar".

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
    back() { index -= 1; setUrl(entries[index].url); hist.backs += 1; },
    backs: 0,
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
  const vorher = { items: inventory.state.items, categories: inventory.state.categories, view: inventory.state.view, active: inventory.state.activeCategory };
  inventory.state.items = [ITEM, { ...ITEM, id: 7, category: 'vehicles' }];
  inventory.state.categories = [{ key: 'electronics', name: 'Elektronik' }, { key: 'vehicles', name: 'Fahrzeuge' }];
  inventory.state.view = 'browse';
  inventory.state.activeCategory = null;
  try { return await fn(); } finally {
    Object.assign(inventory.state, { items: vorher.items, categories: vorher.categories, view: vorher.view, activeCategory: vorher.active });
    abraeumen();
  }
}

test('W1: eine Kategorie oeffnen legt einen History-Eintrag mit ihrer Adresse an', async () => {
  await withInventoryState(() => withHistory('/inventory', ({ entries, hist }) => {
    inventory.openCategory('vehicles');
    assert.equal(inventory.state.view, 'category');
    assert.deepEqual(entries(), ['/inventory', '/inventory?category=vehicles'], 'pushState, nicht nur ein Zustandswechsel');
    assert.equal(hist.state?.path, '/inventory?category=vehicles', 'der Router liest `path` bei popstate');
  }));
});

test('W1: Zurueck/Vor stellt die Ebene aus der Adresse wieder her', async () => {
  await withInventoryState(() => withHistory('/inventory', ({ loc }) => {
    inventory.openCategory('vehicles');
    // Zurueck: die Adresse ist wieder die Kategorienliste.
    loc.search = '';
    inventory.syncLevelFromAddress();
    assert.equal(inventory.state.view, 'browse', 'Zurueck fuehrt zur Kategorienliste, nicht aus dem Modul');
    assert.equal(inventory.state.activeCategory, null);
    // Vor: die Kategorie steht wieder da.
    loc.search = '?category=electronics';
    inventory.syncLevelFromAddress();
    assert.equal(inventory.state.view, 'category');
    assert.equal(inventory.state.activeCategory, 'electronics');
    // Eine Adresse mit einer Kategorie, die es nicht (mehr) gibt: Startseite.
    loc.search = '?category=weg';
    inventory.syncLevelFromAddress();
    assert.equal(inventory.state.view, 'browse');
  }));
});

test('W1: „‹ Inventar" geht den Schritt zurueck, den das Oeffnen angelegt hat - sonst ein neuer Eintrag', async () => {
  await withInventoryState(() => withHistory('/inventory', ({ hist, entries }) => {
    inventory.openCategory('vehicles');
    inventory.backToBrowse();
    assert.equal(hist.backs, 1, 'direkt aus der Liste geoeffnet: history.back() wie Apples Zurueck-Knopf');
  }));
  await withInventoryState(() => withHistory('/inventory?category=vehicles', ({ hist, entries }) => {
    // Per Link hereingekommen: kein Eintrag, zu dem es zurueckginge.
    inventory.syncLevelFromAddress();
    inventory.backToBrowse();
    assert.equal(hist.backs, 0);
    assert.deepEqual(entries(), ['/inventory?category=vehicles', '/inventory']);
    assert.equal(inventory.state.view, 'browse');
  }));
});

test('W1: der Deep-Link auf einen Gegenstand schreibt auch seine Kategorie in die Adresse', async () => {
  await withInventoryState(() => withHistory('/inventory?open=7', ({ entries }) => {
    const saved = globalThis.getComputedStyle;
    globalThis.getComputedStyle = () => ({ display: 'flex' });
    try { inventory.openDeepLinkedCategory(split); } finally { globalThis.getComputedStyle = saved; }
    assert.deepEqual(entries(), ['/inventory?category=vehicles&open=7'], 'ersetzt, nicht gestapelt');
  }));
});

test('W1: die Adresse einer Auswahl behaelt die Kategorie (master-detail `address`)', async () => {
  await withInventoryState(() => withHistory('/inventory', ({ loc }) => {
    inventory.openCategory('vehicles');
    assert.equal(inventory.mdAddress.href('7'), '/inventory?category=vehicles&open=7');
    assert.equal(inventory.mdAddress.href(null), '/inventory?category=vehicles');
    assert.equal(inventory.mdAddress.read({ pathname: '/inventory', search: '?category=vehicles&open=7' }), '7');
    assert.equal(inventory.mdAddress.read({ pathname: '/inventory', search: '?category=vehicles' }), null,
      'eine andere Ebene ist dieselbe Seite - Zurueck/Vor zeichnet sie nicht neu');
    assert.equal(inventory.mdAddress.read({ pathname: '/tasks', search: '' }), undefined);
  }));
  const src = readFileSync(new URL('../public/pages/inventory.js', import.meta.url), 'utf8');
  const mount = src.slice(src.indexOf('_md = mountMasterDetail({'));
  assert.match(mount.slice(0, mount.indexOf('\n    });')), /address: mdAddress/, 'der Baustein liest die Adresse ueber mdAddress');
});

test('W1: im Kategorie-Kopf steht „‹ Inventar" oben und der Kategoriename als Titel', async () => {
  await withInventoryState(() => withHistory('/inventory', () => {
    const title = { textContent: 'Inventar' };
    const back = { hidden: true };
    const page = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    const container = { querySelector: (sel) => ({ '.inventory-toolbar .page-toolbar__title': title, '.inventory-toolbar__back': back, '.inventory-page': page }[sel] ?? null) };
    inventory.syncInventoryHeader(container);
    assert.equal(back.hidden, true, 'auf der Startseite kein Rueckweg');
    assert.equal(page.attrs['data-inventory-level'], 'categories');
    inventory.state.view = 'category';
    inventory.state.activeCategory = 'vehicles';
    inventory.syncInventoryHeader(container);
    assert.equal(back.hidden, false);
    assert.equal(title.textContent, 'Fahrzeuge');
    assert.equal(page.attrs['data-inventory-level'], 'category');
    inventory.state.view = 'browse';
    inventory.state.query = 'bohr';
    try {
      inventory.syncInventoryHeader(container);
      assert.equal(page.attrs['data-inventory-level'], 'search', 'Treffer sind Gegenstaende - dort steht die Spalte');
    } finally { inventory.state.query = ''; }
  }));
  const src = readFileSync(new URL('../public/pages/inventory.js', import.meta.url), 'utf8');
  assert.match(src, /class="inventory-toolbar__back" href="\/inventory" hidden/, 'der Rueckweg steht im Kopf, nicht als Textlink unter den Chips');
  assert.doesNotMatch(src, /class="inventory-back-link"/);
});

test('W1: am Desktop fuellen die Kategorien die Flaeche - keine Spalte, die „Waehle einen Gegenstand" fordert', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/inventory.css', import.meta.url), 'utf8');
  const split = [...eachRule(css)].filter(({ at }) => at.some((a) => /module-surface \(min-width: 65rem\)/.test(a)));
  const detail = split.find(({ selector }) => selector.trim() === '.inventory-page[data-inventory-level="categories"] .split-view__detail');
  assert.ok(detail && /display:\s*none/.test(detail.body), 'auf der Kategorie-Ebene keine Detailspalte');
  const grid = split.find(({ selector }) => selector.trim() === '.inventory-page[data-inventory-level="categories"] .split-view');
  assert.ok(grid && /grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(grid.body), 'die Liste nimmt die ganze Breite');
});
