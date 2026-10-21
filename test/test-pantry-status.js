/**
 * Tests: Vorrats-Status und -Einheiten (#596)
 * Zweck: Die reinen Ableitungen, an denen die Zeilen-Darstellung hängt -
 *        Ablauf-Schwelle, Tagesdifferenz, "fast leer" vs. "leer", Filter-Zählung
 *        sowie Mengen-/Einheiten-Normalisierung und Stepper-Schrittweite.
 *        Läuft mit festem Bezugstag, damit die Zusicherungen nicht mit dem
 *        Kalender kippen.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-pantry-status.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  EXPIRY_SOON_DAYS, PANTRY_FILTERS,
  pantryItemStatus, daysUntil, matchesPantryFilter, pantryFilterCounts,
  pantryStockStatus, pantryProductStock, hasPantryMinimum,
} = await import('../public/utils/pantry-status.js');

const {
  PANTRY_UNITS, DEFAULT_PANTRY_UNIT, MAX_PANTRY_QUANTITY,
  normalizePantryUnit, normalizePantryQuantity, pantryUnitStep,
} = await import('../public/utils/pantry-units.js');

const TODAY = '2026-07-29';
const item = (over = {}) => ({ name: 'X', quantity: 1, unit: 'pcs', min_quantity: null, expires_on: null, ...over });

// --------------------------------------------------------------------------
// Ablauf
// --------------------------------------------------------------------------
test('ohne MHD gibt es keinen Ablauf-Status', () => {
  assert.equal(pantryItemStatus(item(), TODAY).expiry, null);
});

test('MHD vor heute → expired, heute und morgen → soon', () => {
  assert.equal(pantryItemStatus(item({ expires_on: '2026-07-28' }), TODAY).expiry, 'expired');
  assert.equal(pantryItemStatus(item({ expires_on: TODAY }), TODAY).expiry, 'soon');
  assert.equal(pantryItemStatus(item({ expires_on: '2026-07-30' }), TODAY).expiry, 'soon');
});

test('die Soon-Schwelle ist inklusiv und endet exakt nach EXPIRY_SOON_DAYS', () => {
  assert.equal(EXPIRY_SOON_DAYS, 7);
  // +7 Tage zählt noch als "bald", +8 nicht mehr.
  assert.equal(pantryItemStatus(item({ expires_on: '2026-08-05' }), TODAY).expiry, 'soon');
  assert.equal(pantryItemStatus(item({ expires_on: '2026-08-06' }), TODAY).expiry, null);
});

test('daysUntil zählt Kalendertage vorwärts wie rückwärts', () => {
  assert.equal(daysUntil(TODAY, TODAY), 0);
  assert.equal(daysUntil('2026-07-30', TODAY), 1);
  assert.equal(daysUntil('2026-08-05', TODAY), 7);
  assert.equal(daysUntil('2026-07-28', TODAY), -1);
  // Über einen Monatswechsel hinweg (Juli hat 31 Tage).
  assert.equal(daysUntil('2026-08-01', TODAY), 3);
});

// --------------------------------------------------------------------------
// Bestand
// --------------------------------------------------------------------------
test('ohne Mindestbestand ist ein Artikel nie "fast leer"', () => {
  const status = pantryItemStatus(item({ quantity: 0.1 }), TODAY);
  assert.equal(status.low, false);
  assert.equal(status.out, false);
});

test('Menge <= Mindestbestand ist "fast leer", Menge 0 ist "leer" (nicht beides)', () => {
  const low = pantryItemStatus(item({ quantity: 2, min_quantity: 2 }), TODAY);
  assert.deepEqual({ low: low.low, out: low.out }, { low: true, out: false });

  const out = pantryItemStatus(item({ quantity: 0, min_quantity: 2 }), TODAY);
  assert.deepEqual({ low: out.low, out: out.out }, { low: false, out: true });

  const fine = pantryItemStatus(item({ quantity: 3, min_quantity: 2 }), TODAY);
  assert.deepEqual({ low: fine.low, out: fine.out }, { low: false, out: false });
});

test('Menge 0 ohne Mindestbestand gilt trotzdem als leer', () => {
  assert.equal(pantryItemStatus(item({ quantity: 0 }), TODAY).out, true);
});

// --------------------------------------------------------------------------
// Filter
// --------------------------------------------------------------------------
test('kein Filter bzw. "all" lässt alles durch', () => {
  const any = item({ quantity: 5 });
  assert.equal(matchesPantryFilter(any, null, TODAY), true);
  assert.equal(matchesPantryFilter(any, 'all', TODAY), true);
});

test('der Low-Filter umfasst auch leere Artikel', () => {
  const empty = item({ quantity: 0 });
  assert.equal(matchesPantryFilter(empty, 'low', TODAY), true);
  const low = item({ quantity: 1, min_quantity: 1 });
  assert.equal(matchesPantryFilter(low, 'low', TODAY), true);
});

test('expired und soon schließen sich gegenseitig aus', () => {
  const past = item({ expires_on: '2026-07-01' });
  assert.equal(matchesPantryFilter(past, 'expired', TODAY), true);
  assert.equal(matchesPantryFilter(past, 'soon', TODAY), false);
});

test('pantryFilterCounts zählt jeden Zustand einzeln, Mehrfachtreffer inklusive', () => {
  // Batches without a product stand for themselves (#1448): one id each.
  const items = [
    item({ id: 1, expires_on: '2026-07-01' }),                     // expired
    item({ id: 2, expires_on: '2026-07-31' }),                     // soon
    item({ id: 3, quantity: 0 }),                                  // low (leer)
    item({ id: 4, quantity: 0, expires_on: '2026-07-02' }),        // expired UND low
    item({ id: 5, quantity: 9 }),                                  // nichts
  ];
  assert.deepEqual(pantryFilterCounts(items, TODAY), { expired: 2, soon: 1, low: 2 });
});

// --------------------------------------------------------------------------
// Low and out over the product (#1448, step 3)
// --------------------------------------------------------------------------
const batch = (id, productId, over = {}) => item({ id, product_id: productId, ...over });

test('pantryStockStatus: at or below the minimum is low, 0 is out and not low, no minimum is never low', () => {
  assert.deepEqual(pantryStockStatus(5, 5), { out: false, low: true }, 'the boundary counts as low, as for a batch');
  assert.deepEqual(pantryStockStatus(5.01, 5), { out: false, low: false });
  assert.deepEqual(pantryStockStatus(0, 5), { out: true, low: false });
  assert.deepEqual(pantryStockStatus(0, null), { out: true, low: false });
  assert.deepEqual(pantryStockStatus(0.1, null), { out: false, low: false });
});

test('#2118: a product without batches is out only with a minimum above 0; a batch at 0 is out with or without one', () => {
  assert.equal(hasPantryMinimum(null), false);
  assert.equal(hasPantryMinimum(undefined), false);
  assert.equal(hasPantryMinimum(''), false);
  assert.equal(hasPantryMinimum(0), false, 'a minimum of 0 never warns, so it is none here either');
  assert.equal(hasPantryMinimum('0'), false);
  assert.equal(hasPantryMinimum(0.5), true);
  assert.equal(hasPantryMinimum('2'), true);

  const products = [
    { id: 1, min_quantity: null }, { id: 2, min_quantity: 0 }, { id: 3, min_quantity: 2 },
    { id: 4, min_quantity: null },
  ];
  const stock = pantryProductStock([batch(9, 4, { quantity: 0 })], products);
  assert.deepEqual([1, 2, 3, 4].map((id) => stock.get(`p${id}`).out), [false, false, true, true],
    'none, 0, 2 without batches; the last has a batch at 0, which is out with or without a minimum');
  assert.ok([1, 2, 3, 4].every((id) => stock.get(`p${id}`).low === false));
  assert.equal(pantryFilterCounts([batch(9, 4, { quantity: 0 })], TODAY, products).low, 2,
    'the "Running low" chip counts the product with a minimum and the batch at 0');
});

test('pantryProductStock: milk 1 l + 1 l + 2 l against a minimum of 5 is low as a product, each batch alone would say nothing else', () => {
  // The API returns the product minimum on every batch (min_quantity mirrors it).
  const items = [
    batch(1, 10, { quantity: 1, unit: 'l', min_quantity: 5 }),
    batch(2, 10, { quantity: 1, unit: 'l', min_quantity: 5 }),
    batch(3, 10, { quantity: 2, unit: 'l', min_quantity: 5 }),
    batch(4, 11, { quantity: 1, min_quantity: 3 }),   // toothpaste: 1 in the bathroom ...
    batch(5, 11, { quantity: 8, min_quantity: 3 }),   // ... and 8 in the attic: 9, not low
  ];
  const products = [
    { id: 10, name: 'Milch', unit: 'l', min_quantity: 5 },
    { id: 11, name: 'Zahnpasta', unit: 'pcs', min_quantity: 3 },
    { id: 12, name: 'Seife', unit: 'pcs', min_quantity: 2 },   // no batch left
    { id: 13, name: 'Salz', unit: 'pcs', min_quantity: null }, // no batch, no minimum
  ];
  const stock = pantryProductStock(items, products);
  assert.deepEqual(pick(stock.get('p10')), { total: 4, min: 5, low: true, out: false });
  assert.deepEqual(pick(stock.get('p11')), { total: 9, min: 3, low: false, out: false },
    'the bathroom batch alone (1 <= 3) is not low: the household has 9');
  assert.equal(pantryItemStatus(items[3], TODAY).low, true, 'counter-proof: read alone, the batch would be low');
  assert.deepEqual(pick(stock.get('p12')), { total: 0, min: 2, low: false, out: true }, 'a product without batches and with a minimum is out');
  assert.deepEqual(pick(stock.get('p13')), { total: 0, min: null, low: false, out: false },
    'without a minimum it is not (#2118, point 3): it tells nobody that something is missing');
  assert.deepEqual(stock.get('p10').batches.map((b) => b.id), [1, 2, 3]);

  // The total is rounded like a quantity: 0.1 + 0.2 meets a minimum of 0.3.
  const floats = pantryProductStock([batch(7, 20, { quantity: 0.1 }), batch(8, 20, { quantity: 0.2 })],
    [{ id: 20, min_quantity: 0.3 }]);
  assert.equal(floats.get('p20').total, 0.3);
  assert.equal(floats.get('p20').low, true);

  // A batch without a product stands for itself, with its own minimum.
  const loose = pantryProductStock([item({ id: 9, quantity: 1, min_quantity: 1 })], []);
  assert.deepEqual(pick(loose.get('b9')), { total: 1, min: 1, low: true, out: false });
});

test('the "Running low" count and filter are per product; expired and soon stay per batch', () => {
  const items = [
    batch(1, 10, { quantity: 1, min_quantity: 5, expires_on: '2026-07-01' }),  // expired, product low
    batch(2, 10, { quantity: 1, min_quantity: 5, expires_on: '2026-07-02' }),  // expired, product low
    batch(3, 11, { quantity: 1, min_quantity: 3 }),
    batch(4, 11, { quantity: 8, min_quantity: 3 }),
  ];
  const products = [
    { id: 10, min_quantity: 5 }, { id: 11, min_quantity: 3 }, { id: 12, min_quantity: 2 },
  ];
  assert.deepEqual(pantryFilterCounts(items, TODAY, products), { expired: 2, soon: 0, low: 2 },
    'two expired batches; low: milk once (two batches, one product) and the product without batches');
  assert.deepEqual(pantryFilterCounts(items, TODAY, []), { expired: 2, soon: 0, low: 1 },
    'without the product list the empty product is unknown, the rest is the same');

  const stock = pantryProductStock(items, products);
  assert.equal(matchesPantryFilter(items[2], 'low', TODAY, stock), false, 'the bathroom batch of a product with 9 is not low');
  assert.equal(matchesPantryFilter(items[2], 'low', TODAY), true, 'counter-proof: read alone it would be');
  assert.equal(matchesPantryFilter(items[0], 'low', TODAY, stock), true);
  assert.equal(matchesPantryFilter(items[0], 'expired', TODAY, stock), true);
});

function pick(entry) {
  return { total: entry.total, min: entry.min, low: entry.low, out: entry.out };
}

test('PANTRY_FILTERS deckt genau die gezählten Zustände ab', () => {
  assert.deepEqual([...PANTRY_FILTERS].sort(), Object.keys(pantryFilterCounts([], TODAY)).sort());
});

// --------------------------------------------------------------------------
// Einheiten und Mengen
// --------------------------------------------------------------------------
test('unbekannte oder leere Einheiten fallen auf den Default zurück', () => {
  assert.equal(normalizePantryUnit('kg'), 'kg');
  assert.equal(normalizePantryUnit(' kg '), 'kg');
  assert.equal(normalizePantryUnit('KG'), DEFAULT_PANTRY_UNIT); // bewusst case-sensitiv: Schlüssel, kein Label
  assert.equal(normalizePantryUnit(''), DEFAULT_PANTRY_UNIT);
  assert.equal(normalizePantryUnit(undefined), DEFAULT_PANTRY_UNIT);
});

test('normalizePantryQuantity rundet, klemmt und fängt Unsinn ab', () => {
  assert.equal(normalizePantryQuantity(0.1 + 0.2), 0.3);   // Fließkomma-Artefakt
  assert.equal(normalizePantryQuantity(-5), 0);            // keine negativen Bestände
  assert.equal(normalizePantryQuantity(1e9), MAX_PANTRY_QUANTITY);
  assert.equal(normalizePantryQuantity('abc'), 1);         // Default-Fallback
  assert.equal(normalizePantryQuantity('abc', { fallback: 7 }), 7);
  assert.equal(normalizePantryQuantity('2.5'), 2.5);
});

test('jede Einheit hat eine Schrittweite; Gewicht und Volumen schreiten in Haushaltsportionen', () => {
  for (const unit of PANTRY_UNITS) {
    assert.ok(pantryUnitStep(unit) > 0, `${unit} ohne Schrittweite`);
  }
  assert.equal(pantryUnitStep('pcs'), 1);
  assert.equal(pantryUnitStep('g'), 100);
  assert.equal(pantryUnitStep('kg'), 0.5);
  assert.equal(pantryUnitStep('l'), 0.5);
  assert.equal(pantryUnitStep('unbekannt'), 1);
});

test('PANTRY_UNITS ist eingefroren (kanonische Einheiten-Liste)', () => {
  assert.equal(Object.isFrozen(PANTRY_UNITS), true);
});
