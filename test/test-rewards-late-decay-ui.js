/**
 * Modul: Spaetabzug - Oberflaeche (Toggle im Einstellungsblatt, Vermerk im Verlauf)
 * Zweck: Der Backend-Teil (test-rewards-late-decay.js) bucht den reduzierten
 *        Betrag und traegt `decay_days`/`base_points` ins Ledger. Diese Suite
 *        haelt die zwei Versprechen der Oberflaeche:
 *        (1) Das Einstellungsblatt der Belohnungen zeigt den Admin-Schalter und
 *            schreibt genau `tasks_late_decay_enabled` (opt-in, Standard aus).
 *        (2) Eine Ledger-Zeile mit `decay_days > 0` zeigt den vollen Wert
 *            durchgestrichen neben dem ausgezahlten und einen knappen Vermerk
 *            „N Tage zu spaet" in der Pluralform der Sprache - ohne decay_days
 *            bleibt die Zeile, wie sie war.
 *
 * WIE GEMESSEN WIRD. Der Schalter wird an der Quelle gemessen (Payload-Feld,
 * Schalter-ID, Label-Schluessel), die Zeile wird GEBAUT: ledgerRowHtml wird aus
 * rewards.js extrahiert und mit dem echten t() (aus den echten Locales)
 * ausgefuehrt - wie test-rewards-ui.js die Kaskade für die Klassenliste
 * rechnet, die rewards.js wirklich schreibt.
 *
 * Ausfuehren: npm run test:rewards-late-decay-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const LOCALE_DIR = new URL('../public/locales/', import.meta.url);
const localeFile = (locale) => JSON.parse(readFileSync(new URL(`${locale}.json`, LOCALE_DIR), 'utf8'));

/* ------------------------------------------------------------------ Schalter */

test('das Belohnungen-Blatt zeigt den Spaetabzug-Schalter und schreibt das richtige Feld', () => {
  const page = read('public/settings/pages/modules-rewards.js');
  // Der Schalter folgt dem Muster des Nachbarn: settingSwitchRowHtml mit ID und
  // aria-describedby auf den Beschreibungstext.
  assert.match(page, /settingSwitchRowHtml\(\{[^}]*label: t\('settings\.rewardsLateDecayLabel'\)/s,
    'der Schalter nutzt Label und t() wie der Freigabe-Schalter daneben');
  assert.match(page, /id: 'tasks-late-decay'/, 'der Schalter traegt seine ID');
  // Opt-in: fehlende Einstellung haelt den Schalter aus (der Nachbar ist Standard an).
  assert.match(page, /checked: preferences\.tasks_late_decay_enabled === true/,
    'Standard aus: nur ein gespeichertes true schaltet ein');
  // Speichern heisst: genau das eine Payload-Feld.
  assert.match(page, /savePreferences\(\{ tasks_late_decay_enabled: lateDecayToggle\.checked \}\)/,
    'der Schalter schreibt tasks_late_decay_enabled');
  // Der Abschnitt fuehrt die Option als Sprungziel (tiefe Links, Suche).
  const registry = read('public/settings/registry.js');
  assert.match(registry, /'settings\.rewardsLateDecayLabel'/,
    'registry.js fuehrt die Option des Blatts');
});

/* ------------------------------------------------------------------- Locales */

test('alle 27 Locales tragen Label, Hinweis und den Plural-Vermerk', () => {
  const files = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 27, 'erwartet 27 Locale-Dateien');
  for (const file of files) {
    const data = localeFile(file.replace(/\.json$/, ''));
    for (const key of ['rewardsLateDecayLabel', 'rewardsLateDecayHint']) {
      assert.ok((data.settings?.[key] ?? '').trim(), `${file}: settings.${key} fehlt`);
    }
    const base = data.rewards?.ledgerLateDecayNote ?? '';
    assert.ok(base.includes('{{count}}'), `${file}: rewards.ledgerLateDecayNote braucht {{count}}`);
    assert.ok((data.rewards?.ledgerLateDecayNote_one ?? '').trim(),
      `${file}: rewards.ledgerLateDecayNote_one fehlt (Stand der Referenz de)`);
  }
});

/* ------------------------------------------------- Die Gebaute Buchungszeile */

// i18n.js ist Browser-Code: Umgebung stellen, bevor das Modul geladen wird
// (dasselbe Muster wie test-i18n-plural.js).
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

/** ledgerRowHtml aus rewards.js herausloesen und mit Mocks der Hilfsfunktionen bauen. */
function buildLedgerRowHtml() {
  const src = read('public/pages/rewards.js');
  const fn = src.match(/function decayDaysOf\(row\) \{[\s\S]*?\n\}\n\n\/\*\*[\s\S]*?\nfunction ledgerRowHtml\(row\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'ledgerRowHtml (mit den decay-Helfern) nicht in rewards.js gefunden');
  const factory = new Function(
    'esc', 't', 'fmtPoints', 'dateText', 'LEDGER_ICON', 'ledgerReason',
    `${fn[0]}; return ledgerRowHtml;`,
  );
  return factory(
    (s) => String(s),
    t,
    (n) => String(n),
    () => '30.10.2026',
    { earn: 'check-circle' },
    (row) => row.reason ?? row.type,
  );
}

const ledgerRowHtml = buildLedgerRowHtml();

test('eine Gutschrift mit decay_days=3, base_points=5: voller Wert durchgestrichen, Auszahlung und Vermerk', async () => {
  await setLocale('de');
  const html = ledgerRowHtml({
    type: 'earn', reason: 'Zähne putzen', user_name: 'Max', created_at: '2026-10-30T09:00:00.000Z',
    delta: 2, base_points: 5, decay_days: 3,
  });
  assert.match(html, /<s class="rw-delta__base" aria-hidden="true">5<\/s>/,
    'der volle Wert steht durchgestrichen (line-through-Klasse) vor der Auszahlung, stumm fuer Screen-Reader');
  assert.match(html, /<span class="rw-delta rw-delta--pos">.*>5<\/s><span class="sr-only"> statt 5<\/span> \+2<\/span>/s,
    'die ausgezahlten +2 Punkte stehen direkt daneben, der Grundwert bekommt eine eigene Ansage');
  assert.match(html, /3 Tage zu spät/, 'der Vermerk nennt die Ueberfaelligkeit in der Pluralform');
});

test('ein Tag: Singular-Form, kein decay: Zeile unveraendert', async () => {
  await setLocale('de');
  const oneDay = ledgerRowHtml({
    type: 'earn', reason: 'Müll raus', user_name: 'Max', created_at: '2026-10-30T09:00:00.000Z',
    delta: 4, base_points: 5, decay_days: 1,
  });
  assert.match(oneDay, /1 Tag zu spät/, 'count=1 waehlt die _one-Form („Tag", nicht „Tage")');

  await setLocale('en');
  const plain = ledgerRowHtml({
    type: 'earn', reason: 'Tidy room', user_name: 'Max', created_at: '2026-10-30T09:00:00.000Z',
    delta: 5,
  });
  assert.doesNotMatch(plain, /<s\b|late-decay|days late/,
    'ohne decay_days (der Regelfall) traegt die Zeile keinen Vermerk und keinen Strich');
  const three = ledgerRowHtml({
    type: 'earn', reason: 'Tidy room', user_name: 'Max', created_at: '2026-10-30T09:00:00.000Z',
    delta: 2, base_points: 5, decay_days: 3,
  });
  assert.match(three, /3 days late/, 'englisch: Pluralform');
  const one = ledgerRowHtml({
    type: 'earn', reason: 'Tidy room', user_name: 'Max', created_at: '2026-10-30T09:00:00.000Z',
    delta: 4, base_points: 5, decay_days: 1,
  });
  assert.match(one, /1 day late/, 'englisch: Singularform');
});
