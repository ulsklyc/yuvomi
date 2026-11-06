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

// --------------------------------------------------------
// Ortssuche (R20, Ulas 2026-10-17): der Ort wird gesucht, Breite und Laenge
// stehen nur noch als Rueckfall unter "Koordinaten von Hand".
// --------------------------------------------------------
const weatherLocation = await import('../public/settings/weather-location.js');

/** Ein Element-Stub, der Attribute und hidden haelt. */
function el(extra = {}) {
  const attrs = {};
  return {
    hidden: false, value: '', disabled: false,
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute(name) { return attrs[name] ?? null; },
    addEventListener() {}, focus() {},
    attrs, ...extra,
  };
}

for (const sheet of SHEETS) {
  test(`${sheet.name}: ohne Ort meldet die Ortssuche am Feld, nicht "ungueltige Koordinaten"`, async () => {
    const reported = [];
    globalThis.__reportFieldError = (input, message) => reported.push([input, message]);
    try {
      const { submit, error, saved, elements } = await mountSheetWithPlace(sheet, { lat: '', lon: '' });
      await submit();
      assert.deepEqual(reported, [[elements[`#${sheet.scope}-place`], 'settings.weatherPlaceRequired']]);
      assert.equal(error.hidden, true, 'der Koordinatenfehler steht zusaetzlich da');
      assert.deepEqual(saved, []);
    } finally {
      delete globalThis.__reportFieldError;
      delete globalThis.__apiStub;
    }
  });

  test(`${sheet.name}: ungueltige Koordinaten klappen "Koordinaten von Hand" auf, wo der Fehler steht`, async () => {
    try {
      const { submit, error, elements } = await mountSheetWithPlace(sheet, { lat: '91', lon: '13.41' });
      await submit();
      assert.equal(error.textContent, 'settings.weatherCoordsInvalid');
      assert.equal(elements[`#${sheet.scope}-manual-trigger`].getAttribute('aria-expanded'), 'true');
      assert.equal(elements[`#${sheet.scope}-manual-panel`].hidden, false);
    } finally {
      delete globalThis.__apiStub;
    }
  });
}

async function mountSheetWithPlace({ module, scope }, { lat, lon }) {
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
    [`#${scope}-lat`]: el({ value: lat }),
    [`#${scope}-lon`]: el({ value: lon }),
    [`#${scope}-city`]: el(),
    [`#${scope}-units`]: { value: 'metric' },
    [`#${scope}-auto-locate`]: { checked: false, addEventListener() {} },
    [`#${scope}-place`]: el(),
    [`#${scope}-manual-trigger`]: el(),
    [`#${scope}-manual-panel`]: el({ hidden: true }),
  };
  const container = {
    isConnected: true,
    replaceChildren() {},
    insertAdjacentHTML() {},
    querySelector: (selector) => elements[selector] ?? null,
  };
  await render(container, { user: null });
  assert.equal(typeof onSubmit, 'function');
  return { submit: () => onSubmit({ preventDefault() {} }), error, saved, elements };
}

test('das Formular fuehrt mit der Ortssuche; Breite und Laenge stehen zugeklappt darunter', () => {
  const html = weatherLocation.weatherLocationFieldsHtml({ scope: 'pweather', values: { lat: '52.52', lon: '13.41', city: 'Berlin' } });
  const at = (needle) => { const i = html.indexOf(needle); assert.ok(i >= 0, `${needle} fehlt`); return i; };
  assert.ok(at('id="pweather-place"') < at('id="pweather-lat"'), 'die Suche steht nicht vor den Koordinaten');
  assert.ok(at('id="pweather-manual-panel"') < at('id="pweather-lat"'), 'die Koordinaten stehen nicht im Aufklapper');
  assert.match(html, /id="pweather-manual-panel"[^>]*\shidden>/, 'mit gespeichertem Ort ist der Aufklapper zu');
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /id="pweather-place"[^>]*enterkeyhint="search"/);
  assert.match(html, /role="status"/, 'Treffer und Wahl werden angesagt');
  assert.ok(html.includes('settings.weatherPlaceCurrent') && html.includes('Berlin (52.52, 13.41)'), 'die Zeile "Aktuell" nennt den gespeicherten Ort nicht');
  // Koordinaten ohne Ortsname kann die Suche nicht anzeigen - dann offen.
  const bare = weatherLocation.weatherLocationFieldsHtml({ scope: 'weather', values: { lat: '52.52', lon: '13.41' } });
  assert.doesNotMatch(bare, /id="weather-manual-panel"[^>]*\shidden>/);
});

test('gleichnamige Orte derselben Region tragen ihren Kreis, alle anderen nicht', () => {
  const a = { name: 'Halle', admin1: 'Flandern', admin2: 'Flämisch-Brabant', country: 'Belgien' };
  const b = { name: 'Halle', admin1: 'Flandern', admin2: 'Antwerpen', country: 'Belgien' };
  const c = { name: 'Halle', admin1: 'Niedersachsen', admin2: 'Holzminden', country: 'Deutschland' };
  const list = [a, b, c];
  assert.equal(weatherLocation.weatherPlaceMeta(a, list), 'Flämisch-Brabant, Flandern, Belgien');
  assert.equal(weatherLocation.weatherPlaceMeta(b, list), 'Antwerpen, Flandern, Belgien');
  assert.equal(weatherLocation.weatherPlaceMeta(c, list), 'Niedersachsen, Deutschland');
  assert.equal(weatherLocation.weatherPlaceMeta({ name: 'Berlin', admin1: 'Berlin', country: 'Deutschland' }), 'Deutschland');
  // Ohne unterscheidenden Kreis bleiben nur die Koordinaten.
  const d = { name: 'Halle', admin1: 'Niedersachsen', country: 'Deutschland', latitude: 51.987, longitude: 9.4 };
  const e = { name: 'Halle', admin1: 'Niedersachsen', country: 'Deutschland', latitude: 52.36, longitude: 7.62 };
  assert.equal(weatherLocation.weatherPlaceMeta(d, [d, e]), 'Niedersachsen, Deutschland, 51.99, 9.40');
});

test('Ortssuche: ein Zeichen fragt nicht, Name und Sprache gehen hinaus, Fehler stehen uebersetzt am Feld', async () => {
  const reported = [];
  const calls = [];
  globalThis.__reportFieldError = (input, message) => reported.push(message);
  const input = el({ value: 'B' });
  const results = el({ hidden: true, replaceChildren() {} });
  const elements = { '#w-place': input, '#w-place-results': results, '#w-place-status': el(), '#w-place-btn': el() };
  const container = { isConnected: true, querySelector: (s) => elements[s] ?? null };
  input.isConnected = true;
  const state = { seq: 0, controller: null };
  try {
    globalThis.__apiStub = { get: async (path) => { calls.push(path); return { data: null, reason: 'upstream_error' }; } };
    await weatherLocation.__test.searchPlace(container, 'w', state);
    assert.deepEqual(calls, [], 'ein Zeichen ging an den Server');
    assert.deepEqual(reported, ['settings.weatherPlaceTooShort']);

    input.value = '  Halle ';
    globalThis.__locale = 'fr';
    await weatherLocation.__test.searchPlace(container, 'w', state);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0], 'http://x');
    assert.equal(url.pathname, '/weather/geocode');
    assert.deepEqual([...url.searchParams.entries()], [['name', 'Halle'], ['lang', 'fr']]);
    assert.equal(reported.at(-1), 'settings.weatherPlaceUnavailable');

    globalThis.__apiStub = { get: async () => ({ data: [] }) };
    await weatherLocation.__test.searchPlace(container, 'w', state);
    assert.equal(reported.at(-1), 'settings.weatherPlaceNotFound');
    assert.equal(results.hidden, true);
  } finally {
    delete globalThis.__reportFieldError;
    delete globalThis.__apiStub;
    delete globalThis.__locale;
  }
  assert.equal(weatherLocation.geocodeErrorKey({ data: { reason: 'name_too_short' } }), 'settings.weatherPlaceTooShort');
  assert.equal(weatherLocation.geocodeErrorKey(new Error('offline')), 'settings.weatherPlaceUnavailable');
});

// Codex-Review PR #2053 (P2): eine zu kurze Suche meldete "zu kurz", liess
// aber die alte Trefferliste stehen, und eine noch laufende Anfrage fuellte
// die Liste danach wieder.
test('Ortssuche: eine zu kurze Suche raeumt die Liste und ueberholt die laufende Anfrage', async () => {
  const reported = [];
  globalThis.__reportFieldError = (input, message) => reported.push(message);
  const input = el({ value: 'Halle' });
  input.isConnected = true;
  let cleared = 0;
  const results = el({ hidden: false, replaceChildren() { cleared += 1; }, append() { throw new Error('die ueberholte Antwort schrieb in die Liste'); } });
  const status = el();
  status.textContent = 'settings.weatherPlacePick';
  const elements = { '#w-place': input, '#w-place-results': results, '#w-place-status': status, '#w-place-btn': el() };
  const container = { isConnected: true, querySelector: (s) => elements[s] ?? null };
  const state = { seq: 0, controller: null };
  let release;
  let signal = null;
  globalThis.__apiStub = { get: (_path, opts) => { signal = opts?.signal; return new Promise((resolve) => { release = resolve; }); } };
  try {
    const slow = weatherLocation.__test.searchPlace(container, 'w', state);
    input.value = 'H';
    await weatherLocation.__test.searchPlace(container, 'w', state);
    assert.deepEqual(reported, ['settings.weatherPlaceTooShort']);
    assert.equal(results.hidden, true, 'die alte Trefferliste steht noch');
    assert.ok(cleared >= 1, 'die alte Trefferliste wurde nicht geleert');
    assert.equal(signal?.aborted, true, 'die laufende Anfrage wurde nicht abgebrochen');
    assert.equal(status.textContent, '', 'die Ansage "waehle einen Treffer" steht noch');
    release({ data: [{ name: 'Halle', latitude: 51.5, longitude: 11.9, country: 'Deutschland' }] });
    await slow;
    assert.equal(results.hidden, true, 'die ueberholte Antwort hat die Liste wieder geoeffnet');
  } finally {
    delete globalThis.__reportFieldError;
    delete globalThis.__apiStub;
  }
});

// Codex-Review PR #2053, zweite Runde (P2): ein zweiter Versuch mit demselben
// Namen feuert weder `input` noch `change`. Klappte er, stand der Fehler des
// ersten Versuchs weiter am Feld, neben den waehlbaren Treffern.
test('Ortssuche: ein erfolgreicher neuer Versuch raeumt den alten Feldfehler', async () => {
  const events = [];
  globalThis.__reportFieldError = (field, message) => events.push(['report', field, message]);
  globalThis.__clearFieldError = (field) => events.push(['clear', field]);
  const input = el({ value: 'Halle' });
  input.isConnected = true;
  const results = el({ hidden: true, replaceChildren() {}, append() {} });
  const elements = { '#w-place': input, '#w-place-results': results, '#w-place-status': el(), '#w-place-btn': el() };
  const container = { isConnected: true, querySelector: (s) => elements[s] ?? null };
  const state = { seq: 0, controller: null };
  const hadDocument = 'document' in globalThis;
  const keptDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ append() {}, addEventListener() {} }) };
  try {
    globalThis.__apiStub = { get: async () => ({ data: null, reason: 'upstream_error' }) };
    await weatherLocation.__test.searchPlace(container, 'w', state);
    assert.deepEqual(events.at(-1), ['report', input, 'settings.weatherPlaceUnavailable']);

    globalThis.__apiStub = { get: async () => ({ data: [{ name: 'Halle', latitude: 51.5, longitude: 11.9, country: 'Deutschland' }] }) };
    await weatherLocation.__test.searchPlace(container, 'w', state);
    assert.equal(results.hidden, false, 'Reichweite: der zweite Versuch zeigt Treffer');
    const lastReport = events.map((e) => e[0]).lastIndexOf('report');
    const lastClear = events.map((e) => e[0]).lastIndexOf('clear');
    assert.ok(lastClear > lastReport, 'der Fehler des ersten Versuchs steht noch am Feld');
    assert.equal(events[lastClear][1], input, 'geraeumt wird das Suchfeld');
  } finally {
    delete globalThis.__reportFieldError;
    delete globalThis.__clearFieldError;
    delete globalThis.__apiStub;
    if (hadDocument) globalThis.document = keptDocument; else delete globalThis.document;
  }
});
