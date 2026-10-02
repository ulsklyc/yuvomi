/**
 * Tests: eine abgelehnte Sichtbarkeitsaenderung bleibt nicht im Auswahlfeld
 *        stehen (#1607)
 * Modul: /public/settings/pages/personal-health.js  (bindVisibilityEvents)
 *
 * DIE GEMESSENE LAGE: "Standard-Sichtbarkeit" eines Gesundheitsbereichs von
 * privat auf Familie, der Server lehnt mit 403 ab. Der Toast kam, das
 * Auswahlfeld zeigte weiter "Familie". Die beiden Schalter darueber drehen
 * sich im Fehlerfall zurueck, dieses Feld nicht - und es ist ausgerechnet das,
 * an dem eine Privatsphaere-Zusage haengt: die Oberflaeche behauptete eine
 * Freigabe (oder ihr Ende), die es nie gab.
 *
 * Gemessen wird das Blatt selbst: `render()` baut und verdrahtet es, das
 * `change` wird zugestellt, und die Antwort des Servers kommt aus dem
 * `__apiStub` des Test-Loaders. Der Container ist ein Stub, der die Knoten
 * liefert, nach denen das Blatt fragt - kein jsdom (siehe test/mini-dom.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeNode(extra = {}) {
  const listeners = [];
  return {
    hidden: false,
    disabled: false,
    isConnected: true,
    textContent: '',
    dataset: {},
    addEventListener(type, handler) { listeners.push({ type, handler }); },
    async _fire(type) {
      await Promise.all(listeners.filter((l) => l.type === type).map((l) => l.handler({ type })));
    },
    ...extra,
  };
}

/** Ein Blatt mit einem Auswahlfeld fuer den Bereich `meds`, Stand `saved`. */
function makeContainer(saved) {
  const select = makeNode({ value: saved, dataset: { scope: 'meds' } });
  const nodes = {
    '#hv-apply': makeNode({ hidden: true }),
    '#hv-apply-text': makeNode(),
    '#hv-apply-btn': makeNode(),
  };
  const container = {
    replaceChildren() {},
    insertAdjacentHTML() {},
    querySelector: (selector) => nodes[selector] ?? null,
    querySelectorAll: (selector) => (selector === '[data-scope]' ? [select] : []),
  };
  return { container, select, applyBox: nodes['#hv-apply'] };
}

const toasts = [];
globalThis.window = { yuvomi: { showToast: (message, kind) => toasts.push({ message, kind }) } };
globalThis.CSS = { escape: (value) => String(value) };

const { render } = await import('../public/settings/pages/personal-health.js');

/** Oeffnet das Blatt; `put` entscheidet, wie der Server auf die Aenderung antwortet. */
async function openSheet(saved, put) {
  toasts.length = 0;
  const calls = [];
  globalThis.__apiStub = {
    get: async (path) => (path === '/health/visibility-defaults'
      ? { data: { defaults: { meds: saved } } }
      : { data: {} }),
    put: async (path, body) => { calls.push({ path, body }); return put(path, body); },
  };
  const sheet = makeContainer(saved);
  await render(sheet.container, { user: { id: 1 } });
  return { ...sheet, calls };
}

const forbidden = () => {
  const error = new Error('Kein Zugriff');
  error.status = 403;
  throw error;
};

test('eine abgelehnte Aenderung springt auf den gespeicherten Wert zurueck', async () => {
  const sheet = await openSheet('private', forbidden);
  sheet.select.value = 'family';
  await sheet.select._fire('change');

  assert.deepEqual(sheet.calls, [{ path: '/health/visibility-defaults', body: { defaults: { meds: 'family' } } }],
    'die Aenderung ging gar nicht an den Server - der Test misst nichts');
  assert.equal(toasts.at(-1)?.kind, 'danger');
  assert.equal(sheet.select.value, 'private', 'das Feld zeigt eine Freigabe, die der Server abgelehnt hat');
  assert.equal(sheet.applyBox.hidden, true, 'die Frage nach den bestehenden Eintraegen steht trotz Ablehnung da');
  assert.equal(sheet.select.disabled, false, 'das Feld bleibt nach dem Fehler gesperrt');
});

test('auch die Gegenrichtung springt zurueck: Familie bleibt Familie', async () => {
  // Der Vorwert ist der GESPEICHERTE Stand, nicht pauschal "privat".
  const sheet = await openSheet('family', forbidden);
  sheet.select.value = 'private';
  await sheet.select._fire('change');
  assert.equal(sheet.select.value, 'family');
});

test('nach einem Erfolg ist der neue Wert der Stand, auf den ein spaeterer Fehler zurueckfaellt', async () => {
  // Der Merker muss mitwandern. Bliebe er auf dem Stand beim Oeffnen, drehte
  // der zweite, abgelehnte Versuch eine Aenderung zurueck, die gespeichert ist.
  let reject = false;
  const sheet = await openSheet('private', () => (reject ? forbidden() : { data: {} }));
  sheet.select.value = 'family';
  await sheet.select._fire('change');
  assert.equal(sheet.select.value, 'family', 'eine angenommene Aenderung wurde zurueckgedreht');
  assert.equal(sheet.applyBox.hidden, false);

  reject = true;
  sheet.select.value = 'private';
  await sheet.select._fire('change');
  assert.equal(sheet.select.value, 'family', 'der Ruecksprung landet auf dem Stand beim Oeffnen statt auf dem gespeicherten');
});
