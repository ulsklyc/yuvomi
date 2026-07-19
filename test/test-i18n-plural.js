/**
 * Tests: Pluralformen in t() (Audit-Befund nach #534)
 * Zweck: `{{count}}`-Strings waren hart im Plural formuliert - „1 Adressbücher
 *        aktiviert". t() wählt jetzt über Intl.PluralRules die passende Variante
 *        (`key_one`, `key_few`, …) und fällt auf den Basisschlüssel zurück,
 *        wenn eine Locale die Variante nicht kennt.
 * Ausführen: node test/test-i18n-plural.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const LOCALE_DIR = new URL('../public/locales/', import.meta.url);
const localeFile = (locale) => JSON.parse(readFileSync(new URL(`${locale}.json`, LOCALE_DIR), 'utf8'));

// i18n.js ist Browser-Code: Umgebung stellen, bevor das Modul geladen wird.
const store = new Map();
global.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
global.document = { documentElement: { lang: '', dir: '' } };
global.window = { dispatchEvent: () => {}, matchMedia: () => ({ matches: false }) };
global.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
global.fetch = async (url) => {
  const locale = String(url).replace('/locales/', '').replace('.json', '');
  return { ok: true, json: async () => localeFile(locale) };
};
Object.defineProperty(global, 'navigator', {
  value: { languages: ['de-DE'], language: 'de-DE' },
  writable: true,
  configurable: true,
});

const { initI18n, setLocale, t } = await import('../public/i18n.js');
await initI18n();

test('Deutsch: Singular und Plural je nach count', async () => {
  await setLocale('de');
  assert.equal(t('settings.enabledAddressbookCount', { count: 1 }), '1 Adressbuch aktiviert');
  assert.equal(t('settings.enabledAddressbookCount', { count: 2 }), '2 Adressbücher aktiviert');
  assert.equal(t('settings.enabledAddressbookCount', { count: 0 }), '0 Adressbücher aktiviert');
});

test('Englisch: Singular und Plural je nach count', async () => {
  await setLocale('en');
  assert.equal(t('settings.enabledAddressbookCount', { count: 1 }), '1 address book enabled');
  assert.equal(t('settings.enabledAddressbookCount', { count: 3 }), '3 address books enabled');
  assert.equal(t('settings.enabledCalendarCount', { count: 1 }), '1 calendar enabled');
  assert.equal(t('settings.enabledReminderListCount', { count: 1 }), '1 reminder list enabled');
});

test('Sprachen ohne Zahlflexion liefern für jede Anzahl denselben Satz', async () => {
  await setLocale('ja');
  const one = t('settings.enabledCalendarCount', { count: 1 });
  const many = t('settings.enabledCalendarCount', { count: 5 });
  assert.equal(one.replace('1', 'N'), many.replace('5', 'N'));
});

test('Polnisch: fehlende few/many-Variante fällt auf den Basisschlüssel zurück', async () => {
  await setLocale('pl');
  // pl kennt one/few/many/other; hinterlegt sind Basis + _one. Kein Absturz,
  // und das zählunabhängige „Label: N"-Muster bleibt korrekt.
  for (const count of [1, 2, 5, 22]) {
    assert.match(t('settings.enabledCalendarCount', { count }), /Włączone kalendarze: \d+/);
  }
});

test('„N von M"-Zähler nutzt bei einem Eintrag die Singularform', async () => {
  // Die _one-Variante ging beim Umbenennen einer früheren Runde verloren:
  // „1 von 1 Adressbüchern aktiv". t() wählt über count (= Gesamtzahl).
  await setLocale('de');
  assert.equal(
    t('settings.addressbooksEnabledOfTotal', { enabled: 1, total: 1, count: 1 }),
    '1 von 1 Adressbuch aktiv',
  );
  assert.equal(
    t('settings.addressbooksEnabledOfTotal', { enabled: 1, total: 3, count: 3 }),
    '1 von 3 Adressbüchern aktiv',
  );
  await setLocale('en');
  assert.equal(
    t('settings.calendarsEnabledOfTotal', { enabled: 0, total: 1, count: 1 }),
    '0 of 1 calendar active',
  );
  assert.equal(
    t('settings.calendarsEnabledOfTotal', { enabled: 2, total: 4, count: 4 }),
    '2 of 4 calendars active',
  );
});

test('Schlüssel ohne Pluralvarianten funktionieren unverändert', async () => {
  await setLocale('de');
  assert.equal(t('common.save'), localeFile('de').common.save);
  // count-Parameter ohne _one-Variante: Basisschlüssel plus Interpolation.
  assert.equal(
    t('settings.enabledCalendarCount', { count: 7 }),
    '7 Kalender aktiviert',
  );
});

test('unbekannter Schlüssel liefert den Schlüssel selbst zurück - auch mit count', async () => {
  await setLocale('de');
  assert.equal(t('gibt.es.nicht'), 'gibt.es.nicht');
  assert.equal(t('gibt.es.nicht', { count: 2 }), 'gibt.es.nicht');
});

test('jede Pluralvariante hat einen zählenden Basisschlüssel in allen Locales', () => {
  const files = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'));
  const flatten = (obj, prefix = '', out = new Map()) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') flatten(v, key, out);
      else out.set(key, v);
    }
    return out;
  };
  // Pluralvariante = Suffix einer CLDR-Kategorie UND ein {{count}} im Wert.
  // Das trennt sie von echten Enum-Werten wie `budget.accountType_other`.
  for (const file of files) {
    const entries = flatten(JSON.parse(readFileSync(new URL(file, LOCALE_DIR), 'utf8')));
    for (const [key, value] of entries) {
      if (!/_(one|two|few|many|other)$/.test(key)) continue;
      if (typeof value !== 'string' || !value.includes('{{count}}')) continue;
      const base = key.replace(/_(one|two|few|many|other)$/, '');
      assert.ok(entries.has(base), `${file}: ${key} ohne Basisschlüssel ${base}`);
      assert.match(entries.get(base), /\{\{count\}\}/, `${file}: ${base} zählt nicht`);
    }
  }
});
