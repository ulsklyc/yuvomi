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
