/**
 * Test: Fehlersatz der beiden Wetter-Blaetter (#1723, Punkt 5)
 * Zweck: Fehlten die Koordinaten oder waren sie ungueltig, stand im
 *        Fehlerfeld `Breitengrad / Laengengrad` - die zwei Feldbeschriftungen
 *        mit einem Schraegstrich dazwischen, kein Satz. Ein `role="alert"`
 *        las damit zwei Substantive vor und sagte nicht, was zu tun ist.
 *
 *        Gefahren wird das Absenden beider Blaetter (Haushalt und "Mein
 *        Wetter") ueber den Browser-Loader gegen einen Container ohne DOM:
 *        was im Fehlerfeld steht, ob gespeichert wurde, und - damit der Test
 *        nicht blind ist - dass gueltige Koordinaten ohne Fehler speichern.
 *        Der i18n-Stub gibt den Schluessel zurueck; der zweite Test liest,
 *        was dieser Schluessel in jeder Sprache sagt.
 * Ausfuehren: npm run test:weather-settings-ui
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

globalThis.window = globalThis.window ?? {};

const { resetPreferencesCache } = await import('../public/settings/preferences-cache.js');
const { HOUSEHOLD_WEATHER_SCOPE, PERSONAL_WEATHER_SCOPE } = await import('../public/settings/weather-location.js');

const SHEETS = [
  { name: 'Haushalt', module: '../public/settings/pages/admin-weather.js', scope: HOUSEHOLD_WEATHER_SCOPE },
  { name: 'Mein Wetter', module: '../public/settings/pages/personal-weather.js', scope: PERSONAL_WEATHER_SCOPE },
];

/** Rendert ein Blatt und gibt das Absenden samt Fehlerfeld und Schreibzugriffen zurueck. */
async function mountSheet({ module, scope }, { lat, lon }) {
  const saved = [];
  globalThis.__apiStub = {
    get: async () => ({ data: {} }),
    put: async (_path, body) => { saved.push(body); return { data: body }; },
  };
  resetPreferencesCache();
  const { render } = await import(module);

  let onSubmit = null;
  const error = { hidden: true, textContent: '' };
  const elements = {
    [`#${scope}-form`]: { addEventListener: (type, handler) => { if (type === 'submit') onSubmit = handler; } },
    [`#${scope}-form-error`]: error,
    [`#${scope}-lat`]: { value: lat },
    [`#${scope}-lon`]: { value: lon },
    [`#${scope}-city`]: { value: '' },
    [`#${scope}-units`]: { value: 'metric' },
    [`#${scope}-auto-locate`]: { checked: false, addEventListener() {} },
  };
  const container = {
    isConnected: true,
    replaceChildren() {},
    insertAdjacentHTML() {},
    querySelector: (selector) => elements[selector] ?? null,
  };
  await render(container, { user: null });
  assert.equal(typeof onSubmit, 'function', 'das Formular ist nicht gebunden - der Test misst dann nichts');
  return { submit: () => onSubmit({ preventDefault() {} }), error, saved };
}

for (const sheet of SHEETS) {
  test(`${sheet.name}: ungueltige Koordinaten melden EINEN Satz, nicht die zwei Feldnamen`, async () => {
    try {
      for (const coords of [{ lat: '', lon: '' }, { lat: '52.52', lon: '' }, { lat: '91', lon: '13.41' }, { lat: 'abc', lon: '13.41' }]) {
        const { submit, error, saved } = await mountSheet(sheet, coords);
        await submit();
        assert.equal(error.hidden, false, `${JSON.stringify(coords)}: der Fehler bleibt verborgen`);
        assert.equal(error.textContent, 'settings.weatherCoordsInvalid',
          `${JSON.stringify(coords)}: im Fehlerfeld steht etwas anderes als der Fehlersatz`);
        assert.deepEqual(saved, [], `${JSON.stringify(coords)}: ungueltige Koordinaten wurden gespeichert`);
      }
    } finally {
      delete globalThis.__apiStub;
    }
  });

  test(`${sheet.name}: gueltige Koordinaten speichern ohne Fehlersatz`, async () => {
    try {
      const { submit, error, saved } = await mountSheet(sheet, { lat: '52.52', lon: '13.41' });
      await submit();
      assert.equal(saved.length, 1, 'gueltige Koordinaten wurden nicht gespeichert');
      assert.equal(error.hidden, true);
      assert.equal(error.textContent, '');
    } finally {
      delete globalThis.__apiStub;
    }
  });
}

test('der Fehlersatz ist in jeder Sprache ein Satz und nicht aus den Feldnamen gebaut', () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 20, 'zu wenige Locale-Dateien gelesen');
  for (const file of files) {
    const { settings } = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const sentence = settings.weatherCoordsInvalid;
    assert.equal(typeof sentence, 'string', `${file}: settings.weatherCoordsInvalid fehlt`);
    // Satzschluss je Schrift: Punkt, CJK-Punkt, Danda.
    assert.match(sentence, /[.。।]$/u, `${file}: kein Satzschluss (${sentence})`);
    assert.doesNotMatch(sentence, /\s\/\s/, `${file}: zwei Begriffe mit Schraegstrich sind kein Satz`);
    for (const label of [settings.weatherLatLabel, settings.weatherLonLabel]) {
      assert.notEqual(sentence, label, `${file}: der Fehlersatz ist eine Feldbeschriftung`);
    }
  }
  const de = JSON.parse(readFileSync(new URL('de.json', dir), 'utf8'));
  const en = JSON.parse(readFileSync(new URL('en.json', dir), 'utf8'));
  assert.equal(de.settings.weatherCoordsInvalid, 'Bitte gültige Koordinaten eingeben.');
  assert.equal(en.settings.weatherCoordsInvalid, 'Enter valid coordinates.');
});
