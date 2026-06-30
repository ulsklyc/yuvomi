/**
 * Tests: Kitchen-Tabs Utility (pure functions)
 * Läuft mit: node --loader ./test-browser-loader.mjs test-kitchen-tabs.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { KITCHEN_ROUTES, KITCHEN_STORAGE_KEY, getLastKitchenRoute, isKitchenRoute } = await (async () => {
  global.window = { yuvomi: null };
  global.document = {
    createElement: () => ({
      className: '', dataset: {}, style: {},
      setAttribute() {}, appendChild() {},
      classList: { add() {}, toggle() {} },
      insertAdjacentElement() {},
      addEventListener() {},
    }),
  };
  const storage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = v; },
  };
  global.sessionStorage = storage;
  global.t = (k) => k;
  return import('../public/utils/kitchen-tabs.js');
})();

test('KITCHEN_ROUTES enthält alle drei Sub-Routen', () => {
  assert.deepEqual(KITCHEN_ROUTES, ['/meals', '/recipes', '/shopping']);
});

test('KITCHEN_ROUTES ist eingefroren (kanonische Kitchen-Routen)', () => {
  assert.equal(Object.isFrozen(KITCHEN_ROUTES), true);
});

test('KITCHEN_STORAGE_KEY ist korrekt', () => {
  assert.equal(KITCHEN_STORAGE_KEY, 'yuvomi-kitchen-tab');
});

test('getLastKitchenRoute: Standardwert /meals wenn kein Storage-Eintrag', () => {
  global.sessionStorage._d = {};
  assert.equal(getLastKitchenRoute(), '/meals');
});

test('getLastKitchenRoute: gibt gespeicherte Route zurück', () => {
  global.sessionStorage._d = { 'yuvomi-kitchen-tab': '/recipes' };
  assert.equal(getLastKitchenRoute(), '/recipes');
});

test('getLastKitchenRoute: ignoriert ungültige gespeicherte Route', () => {
  global.sessionStorage._d = { 'yuvomi-kitchen-tab': '/admin' };
  assert.equal(getLastKitchenRoute(), '/meals');
});

test('isKitchenRoute: erkennt Kitchen-Routen', () => {
  assert.equal(isKitchenRoute('/meals'), true);
  assert.equal(isKitchenRoute('/recipes'), true);
  assert.equal(isKitchenRoute('/shopping'), true);
});

test('isKitchenRoute: lehnt Nicht-Kitchen-Routen ab', () => {
  assert.equal(isKitchenRoute('/tasks'), false);
  assert.equal(isKitchenRoute('/'), false);
  assert.equal(isKitchenRoute('/calendar'), false);
  assert.equal(isKitchenRoute(''), false);
});
