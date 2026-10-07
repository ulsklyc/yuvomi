/**
 * Modul: Sprachwechsel und Offline-Vorsorge (Critique R18)
 * Zweck: Der Service Worker cacht vorab nur noch die Rueckfallsprache; jede
 *        andere kommt beim ersten Abruf in den Cache. Zwei Zusagen von
 *        public/i18n.js haengen daran:
 *   1. EIN GESCHEITERTER WECHSEL AENDERT NICHTS. Offline auf eine Sprache, die
 *      dieses Geraet nie geladen hat: vorher standen Speicher und
 *      `currentLocale` schon auf der neuen Sprache, die Texte blieben in der
 *      alten, und der naechste Start fiel still auf Deutsch.
 *   2. DIE SPRACHE DES GERAETS WIRD DEM WORKER GENANNT (CACHE_LOCALE) - beim
 *      Start, beim Wechsel und wenn ein neuer Worker uebernimmt.
 * Ausfuehren: node --test test/test-i18n-switch.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LOCALE_DIR = new URL('../public/locales/', import.meta.url);
const localeFile = (locale) => JSON.parse(readFileSync(new URL(`${locale}.json`, LOCALE_DIR), 'utf8'));

// i18n.js ist Browser-Code: Umgebung stellen, bevor das Modul geladen wird.
const store = new Map([['yuvomi-locale', 'en']]);
global.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
global.document = { documentElement: { lang: '', dir: '' } };
const events = [];
global.window = { dispatchEvent: (e) => { events.push(e.type); }, matchMedia: () => ({ matches: false }) };
global.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };

/** Welche Sprachdateien das "Netz" gerade liefert; alles andere scheitert. */
let reachable = new Set(['de', 'en', 'fr']);
/** Die Offline-Seite des Workers: Status 200, aber HTML statt JSON. */
const offlinePage = { ok: true, json: async () => { throw new SyntaxError("Unexpected token '<'"); } };
global.fetch = async (url) => {
  const locale = String(url).replace('/locales/', '').replace('.json', '');
  if (!reachable.has(locale)) return offlinePage;
  return { ok: true, json: async () => localeFile(locale) };
};

const messages = [];
const swListeners = {};
const serviceWorker = {
  controller: { postMessage: (msg) => messages.push(msg) },
  addEventListener: (type, fn) => { (swListeners[type] ||= []).push(fn); },
};
Object.defineProperty(global, 'navigator', {
  value: { languages: ['en-US'], language: 'en-US', serviceWorker },
  writable: true,
  configurable: true,
});

const { initI18n, setLocale, getLocale, t } = await import('../public/i18n.js');
await initI18n();

const localeMessages = () => messages.filter((m) => m.type === 'CACHE_LOCALE').map((m) => m.locale);

test('the start names the device language to the worker', () => {
  assert.equal(getLocale(), 'en');
  assert.deepEqual(localeMessages(), ['en']);
});

test('a switch that cannot load its file changes nothing and throws', async () => {
  messages.length = 0;
  events.length = 0;
  reachable = new Set(['de', 'en']);
  const before = t('common.reload');

  await assert.rejects(setLocale('it'));

  assert.equal(getLocale(), 'en', 'die Sprache gilt weiter');
  assert.equal(store.get('yuvomi-locale'), 'en', 'der naechste Start darf nicht still auf die Rueckfallsprache fallen');
  assert.equal(t('common.reload'), before, 'Texte unveraendert');
  assert.equal(global.document.documentElement.lang, 'en');
  assert.deepEqual(events, [], 'kein locale-changed fuer einen Wechsel, der nicht stattfand');
  assert.deepEqual(localeMessages(), []);
});

test('a switch that loads commits everything at once and names the language to the worker', async () => {
  messages.length = 0;
  events.length = 0;
  reachable = new Set(['de', 'en', 'fr']);

  await setLocale('fr');

  assert.equal(getLocale(), 'fr');
  assert.equal(store.get('yuvomi-locale'), 'fr');
  assert.equal(t('common.reload'), localeFile('fr').common.reload);
  assert.deepEqual(events, ['locale-changed']);
  assert.deepEqual(localeMessages(), ['fr']);
});

test('a switch that was overtaken sets nothing', async () => {
  reachable = new Set(['de', 'en', 'fr', 'es']);
  const slow = setLocale('es');
  const fast = setLocale('en');
  await Promise.all([slow, fast]);
  assert.equal(getLocale(), 'en');
  assert.equal(store.get('yuvomi-locale'), 'en');
});

test('a new worker taking over is told the language again', () => {
  messages.length = 0;
  assert.ok(swListeners.controllerchange?.length, 'i18n.js hoert nicht auf controllerchange');
  swListeners.controllerchange.forEach((fn) => fn());
  assert.deepEqual(localeMessages(), ['en']);
});

test('the fallback language needs no message: the worker precaches it', async () => {
  messages.length = 0;
  await setLocale('de');
  assert.deepEqual(localeMessages(), []);
});

test('the settings page puts the selection back and says why', () => {
  const page = readFileSync(new URL('../public/settings/pages/personal-appearance.js', import.meta.url), 'utf8');
  assert.match(page, /const appliedLocaleChoice = localeSelect\?\.value;/);
  assert.match(page, /\} catch \{[\s\S]{0,500}localeSelect\.value = appliedLocaleChoice;\s*showError\(errorElement, t\('common\.errorOffline'\)\);/,
    'kein roher Parserfehler in der Fehlerzeile');
});
