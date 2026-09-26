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

test('unter der Schwelle bleibt die Startseite - kein Link springt beim Laden auf', () => {
  resetState();
  withEnv({ search: '?open=7', display: 'none' }, () => inventory.openDeepLinkedCategory(split));
  assert.equal(inventory.state.view, 'browse');
  assert.equal(inventory.state.activeCategory, null);
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
  const maxHeight = rule.body.match(/max-height:\s*([^;]+);/)?.[1] ?? '';
  // Die Oberkante ist der Messwert; ohne ihn (erster Frame) der Klebestand.
  assert.match(maxHeight, /^calc\(var\(--viewport-height\) - var\(--inventory-detail-top, calc\(var\(--inventory-head-block, 0px\) \+ var\(--space-3\)\)\) - var\(--space-4\)\)$/);
  // Rechnung am gemessenen Fall: 900 - 133 - 16 = 751, Unterkante 884 < 900.
  const top = 133; const vh = 900; const space4 = 16;
  assert.ok(top + (vh - top - space4) <= vh);
});
