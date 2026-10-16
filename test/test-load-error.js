/**
 * Tests: Ladefehler nennen die Ursache (Critique R19, 2026-10-16)
 *
 * `mountLoadError` bekam an 17 Stellen fest "Bitte pruefe die Verbindung" und
 * zeigte darunter einen rohen Chip "HTTP 429". Bei einer Bremse oder einem
 * Serverfehler schickte das die Familie an ihr WLAN. Jetzt kommt der Satz aus
 * dem Fehler (loadErrorSentence), die Beschreibung des Aufrufers ist nur noch
 * der Rueckfall, und der Statuscode steht in den aufklappbaren Details.
 *
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-load-error.js
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniDom, MiniElement } from './mini-dom.js';

installMiniDom();
const { mountLoadError, loadErrorHTML } = await import('../public/utils/empty-state.js');

function setOnline(onLine) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine }, configurable: true, writable: true });
}
beforeEach(() => setOnline(true));

const mount = (opts) => {
  const target = new MiniElement('div');
  mountLoadError(target, {
    title: 'Budget konnte nicht geladen werden',
    description: 'common.loadErrorDescription',
    retryLabel: 'common.retry',
    onRetry: () => {},
    ...opts,
  });
  return target.innerHTML;
};

test('eine Bremse (429) sagt "kurz warten" und legt den Code in die Details', () => {
  const html = mount({ error: { status: 429, retryAfter: '30', data: { error: 'Too many requests.' } } });
  assert.match(html, /<p class="empty-state__description">common\.errorRateLimited<\/p>/);
  assert.doesNotMatch(html, /common\.loadErrorDescription/, 'der feste Verbindungssatz steht noch da');
  assert.doesNotMatch(html, /empty-state__hint/, 'der rohe Chip "HTTP 429" steht noch sichtbar da');
  assert.match(html, /<details class="empty-state__details"><summary>common\.errorDetails<\/summary><pre>HTTP 429 \(Retry-After: 30\)<\/pre><\/details>/);
  assert.doesNotMatch(html, /Too many requests/, 'der englische Servertext gehoert nicht in den Satz');
});

test('ein Serverfehler sagt Serverfehler', () => {
  const html = mount({ error: { status: 502, data: { error: 'Bad gateway' } } });
  assert.match(html, /empty-state__description">common\.errorServer</);
  assert.match(html, /<pre>HTTP 502<\/pre>/);
});

test('ohne Antwort bleibt es beim Verbindungssatz, die Details nennen den Wurf', () => {
  const html = mount({ error: new TypeError('Failed to fetch') });
  assert.match(html, /empty-state__description">common\.loadErrorDescription</);
  assert.match(html, /<pre>TypeError: Failed to fetch<\/pre>/);
});

test('eine Ursache ohne eigenen Satz nimmt die Beschreibung des Aufrufers', () => {
  const html = mount({ description: 'health.vitals.loadErrorDesc', error: { status: 400, data: { error: 'Invalid range.' } } });
  assert.match(html, /empty-state__description">health\.vitals\.loadErrorDesc</);
  assert.doesNotMatch(html, /Invalid range/);
});

test('ohne retryLabel gibt es trotzdem einen Ausweg', () => {
  const target = new MiniElement('div');
  mountLoadError(target, { title: 'x', error: { status: 500 }, onRetry: () => {} });
  assert.match(target.innerHTML, /<button[^>]*empty-state__cta[^>]*>.*common\.retry<\/button>/);
});

test('loadErrorHTML verdrahtet ueber attrs und lehnt onRetry ab', () => {
  const html = loadErrorHTML({ title: 'x', error: { status: 429 }, attrs: { 'data-action': 'retry-overview' } });
  assert.match(html, /data-action="retry-overview"/);
  assert.match(html, /common\.errorRateLimited/);
  assert.throws(() => loadErrorHTML({ title: 'x', onRetry: () => {} }), TypeError);
});

// Kein Toast zusaetzlich zum Fehlerzustand: die Stellen, die bis R19 beides
// taten. Am Quelltext, weil die Seiten im Node-Test nicht laufen - der Lauf im
// Browser steht im Handoff der Runde.
test('Schichtplan und Budget melden einen Ladefehler nicht zusaetzlich per Toast', () => {
  const schedule = readFileSync(new URL('../public/pages/schedule.js', import.meta.url), 'utf8');
  for (const field of ['overview', 'statistics']) {
    const hits = [...schedule.matchAll(new RegExp(`${field} = \\{ \\.\\.\\.${field}, loading: false, error[^}]*\\};([^\\n]*\\n){0,3}`, 'g'))];
    assert.ok(hits.length > 0, `${field}: Fehlerzweig nicht gefunden`);
    for (const [block] of hits) {
      assert.doesNotMatch(block, /showToast/, `${field}: Toast neben dem Fehlerzustand`);
      assert.doesNotMatch(block, /error: true/, `${field}: der Fehler reist als true statt als Objekt`);
    }
  }
  const budget = readFileSync(new URL('../public/pages/budget.js', import.meta.url), 'utf8');
  const meta = budget.slice(budget.indexOf('async function loadBudgetMeta'), budget.indexOf('function reportMetaError'));
  assert.doesNotMatch(meta, /showToast/, 'loadBudgetMeta meldet per Toast, bevor klar ist, ob die Seite den Fehler zeigt');
  assert.match(budget, /function reportMetaError\(\) \{\n\s+if \(state\.metaError && !state\.loadError\)/);
});
