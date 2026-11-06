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
  const items = [
    item({ expires_on: '2026-07-01' }),                     // expired
    item({ expires_on: '2026-07-31' }),                     // soon
    item({ quantity: 0 }),                                  // low (leer)
    item({ quantity: 0, expires_on: '2026-07-02' }),        // expired UND low
    item({ quantity: 9 }),                                  // nichts
  ];
  assert.deepEqual(pantryFilterCounts(items, TODAY), { expired: 2, soon: 1, low: 2 });
});

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
