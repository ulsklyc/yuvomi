/**
 * Test: die UI des LLM-Rezeptimports (Einstellungen-Karte, Neu-Menue, Dialog)
 * Module: public/settings/pages/modules-kitchen.js, public/pages/recipes.js,
 *         public/utils/friendly-error.js
 *
 * Der Backend-Weg (Route, Grund, Bremse) messen test:recipe-llm-import und
 * test:recipes-routes. Dieser Suite gehoeren die drei Stuecke der Oberflaeche:
 *
 * 1) DIE KARTE in den Kuechen-Einstellungen. Sie ist Fuehrungskraft-Sache —
 *    wie der Riegel auf dem Server (routes/preferences.js, 403): ein Mitglied
 *    sieht sie nicht. Der Schluessel ist write-only; die Karte zeigt nur die
 *    Frage "ist einer hinterlegt?" (`llmImportApiKeySet` ueber
 *    `has_llm_api_key`). Speichern geht ueber PUT /preferences (via
 *    savePreferences), der leere Schluessel faellt dabei ganz weg — leer
 *    heisst "unveraendert", nichts anderes darf ein leeres Feld bewirken.
 *    Der Erfolg sagt `llmImportSaved`.
 *
 * 2) DAS NEU-MENUE. Der Anlegeknopf oeffnet es; es traegt beide Wege zum
 *    Rezept: tippen und "Mit KI importieren" (`llmImportOption`).
 *
 * 3) DER DIALOG. Quelle als Umschaltung (Adresse oder Text, Text mindestens
 *    so lang wie ein Rezept), `Analyze` fragt das Modell mit
 *    `{ preview: true }` und zeigt Titel, Zutaten (Menge als Satz) und
 *    Schritte; `Speichern` sendet GENAU das Gezeigte als
 *    `{ confirmed: true, recipe }` — im Modell-Format (amount/unit,
 *    instructions), damit auf dem Weg zur Route nichts verloren geht, was die
 *    Vorschau zeigte. Wahrend des Laufs steht der Satz `llmImportAnalyzing`;
 *    der Erfolg heisst `llmImportToast` und laedt die Liste neu
 *    (ueber reloadAfterSave — das Nachladen gilt nie als Speichern-Fehler,
 *    #2069). Fehler sagt `errorSentence`: jeder Grund der Route
 *    (`llm_import_*`) hat seinen Satz in utils/friendly-error.js.
 *
 * Gefahren wird der echte Code: die Einstellungen uber `render()` gegen einen
 * Container ohne DOM (dasselbe Muster wie test-weather-settings-ui.js), der
 * Dialog uber den Modal-Stub des Loaders (`__openModal`) mit einem Attrappen-
 * Panel, bis in die Handler in `onSave`. Der i18n-Stub gibt den Schluessel
 * zurueck — zugesichert wird also, WELCHER Satz gezeigt wuerde.
 *
 * Ausfuehren: npm run test:recipes-llm-import-ui
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window ?? {};
globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();

const toasts = [];
globalThis.window.yuvomi = {
  ...globalThis.window.yuvomi,
  showToast: (text, tone) => { toasts.push([text, tone]); },
};

const { resetPreferencesCache } = await import('../public/settings/preferences-cache.js');
const { setPermissions } = await import('../public/permissions.js');
const kitchen = await import('../public/settings/pages/modules-kitchen.js');
const { __test: recipes } = await import('../public/pages/recipes.js');

/* ===========================================================================
 * 1) Die Karte in den Kuechen-Einstellungen
 * ======================================================================== */

/** Ein Element der Attrappen-Welt: Werte, Listener, still mitgeschriebene Zustande. */
function fakeEl(extra = {}) {
  return {
    hidden: true, textContent: '', value: '', checked: false, disabled: false,
    listeners: {}, attrs: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    fire(type, event = {}) { (this.listeners[type] ?? []).forEach((fn) => fn(event)); },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] ?? null; },
    ...extra,
  };
}

/**
 * Das Kuechen-Blatt rendern und den Speichern-Weg der LLM-Karte freigeben.
 * `antworten.put` wirft im Fehlerfall - alles andere speichert.
 */
async function mountKitchen({ role = 'admin', preferences = {}, elements = {}, antworten = {} } = {}) {
  const saved = [];
  globalThis.__apiStub = {
    get: async (path) => (path === '/preferences' ? { data: preferences } : { data: [] }),
    put: async (path, body) => {
      saved.push([path, body]);
      if (antworten.put) return antworten.put(path, body);
      return { data: {} };
    },
  };
  resetPreferencesCache();
  toasts.length = 0;

  const submitBtn = fakeEl();
  const form = fakeEl({
    querySelector: (sel) => (sel === 'button[type=submit]' ? submitBtn : null),
  });
  elements = { '#llm-import-form': form, ...elements };
  const container = {
    isConnected: true,
    html: '',
    replaceChildren() {},
    insertAdjacentHTML(_pos, markup) { this.html += markup; },
    querySelector: (sel) => elements[sel] ?? null,
  };
  await kitchen.render(container, { user: { role } });
  const onSubmit = form.listeners.submit?.[0] ?? null;
  return { html: container.html, submit: onSubmit, submitBtn, saved, error: elements['#llm-import-error'] ?? null };
}

test('die LLM-Karte ist Fuehrungskraft-Sache: ein Mitglied sieht das Formular nicht', async () => {
  try {
    const { html } = await mountKitchen({ role: 'member' });
    assert.ok(!html.includes('llm-import-form'), 'das Formular steht im Blatt eines Mitglieds');
    assert.ok(!html.includes('llm-base-url'), 'die Adresse steht im Blatt eines Mitglieds');
    // Gegenprobe desselben Renderns: der Rest des Blatts ist da.
    assert.ok(html.includes('recipe-provider-add-account-btn'), 'der Leser sieht das Blatt nicht - die Gegenprobe gilt nicht');
  } finally { delete globalThis.__apiStub; }
});

test('die Karte zeigt Schalter, Adresse, Schluessel und Modell - den Satz "hinterlegt" nur mit Schluessel', async () => {
  try {
    const ohne = await mountKitchen({ preferences: { has_llm_api_key: false } });
    assert.match(ohne.html, /id="llm-import-enabled"/);
    assert.match(ohne.html, /id="llm-base-url"/);
    assert.match(ohne.html, /type="password"/, 'der Schluessel ist ein Geheimfeld');
    assert.match(ohne.html, /id="llm-model"/);
    assert.ok(!ohne.html.includes('settings.llmImportApiKeySet'), '"hinterlegt" steht ohne Schluessel');

    const mit = await mountKitchen({ preferences: { has_llm_api_key: true, llm_import_enabled: true } });
    assert.ok(mit.html.includes('settings.llmImportApiKeySet'), 'der Satz "hinterlegt" fehlt');
    // Der Schluessel selbst kommt nie ins Markup - er wird nie ausgeliefert.
    assert.ok(!mit.html.includes('value="sk-'), 'ein Schluesselwert steht im Markup');
  } finally { delete globalThis.__apiStub; }
});

test('Speichern der Karte: EIN PUT /preferences, wahrer Schalter, trimmte Felder - der leere Schluessel faellt weg', async () => {
  try {
    const elements = {
      '#llm-import-enabled': fakeEl({ checked: true }),
      '#llm-base-url': fakeEl({ value: '  https://api.example.com/v1  ' }),
      '#llm-model': fakeEl({ value: '  llama-3  ' }),
      '#llm-api-key': fakeEl({ value: '' }),
      '#llm-import-error': fakeEl({ hidden: true }),
    };
    const { submit, saved } = await mountKitchen({ preferences: {}, elements });
    assert.equal(typeof submit, 'function', 'das Formular ist nicht gebunden - der Test misst dann nichts');
    await submit({ preventDefault() {} });
    assert.equal(saved.length, 1, 'erwartet genau einen Schreibzugriff');
    const [path, body] = saved[0];
    assert.equal(path, '/preferences');
    assert.deepEqual(Object.keys(body).sort(), ['llm_base_url', 'llm_import_enabled', 'llm_model']);
    assert.equal(body.llm_import_enabled, true, 'der Schalter geht als BOOLEAN weg');
    assert.equal(body.llm_base_url, 'https://api.example.com/v1');
    assert.equal(body.llm_model, 'llama-3');
    assert.deepEqual(toasts.at(-1), ['settings.llmImportSaved', 'success']);
  } finally { delete globalThis.__apiStub; }
});

test('ein getippter Schluessel geht mit; ein Scheitern sagt den Fehlersatz, nie einen Erfolg', async () => {
  try {
    const elements = {
      '#llm-import-enabled': fakeEl({ checked: false }),
      '#llm-base-url': fakeEl({ value: 'https://api.example.com/v1' }),
      '#llm-model': fakeEl({ value: 'llama-3' }),
      '#llm-api-key': fakeEl({ value: 'sk-geheim' }),
      '#llm-import-error': fakeEl({ hidden: true }),
    };
    const { submit, saved } = await mountKitchen({ preferences: {}, elements });
    await submit({ preventDefault() {} });
    assert.equal(saved[0][1].llm_api_key, 'sk-geheim');
  } finally { delete globalThis.__apiStub; }

  try {
    const elements = {
      '#llm-import-enabled': fakeEl({ checked: true }),
      '#llm-base-url': fakeEl({ value: '' }),
      '#llm-model': fakeEl({ value: '' }),
      '#llm-api-key': fakeEl({ value: '' }),
      '#llm-import-error': fakeEl({ hidden: true }),
    };
    const { submit, saved, error, submitBtn } = await mountKitchen({
      preferences: {},
      elements,
      antworten: { put: async () => { throw new Error('boom'); } },
    });
    await submit({ preventDefault() {} });
    assert.equal(saved.length, 1, 'der Versuch wurde versucht');
    assert.equal(error.hidden, false, 'der Fehlersatz bleibt verborgen');
    assert.equal(error.textContent, 'settings.preferenceSaveFailed');
    assert.ok(!toasts.some(([text]) => text === 'settings.llmImportSaved'), 'Erfolg gemeldet, obwohl nichts ankam');
    assert.equal(submitBtn.disabled, false, 'der Speichern-Knopf bleibt gesperrt');
  } finally { delete globalThis.__apiStub; }
});

/* ===========================================================================
 * 2) Das Neu-Menue
 * ======================================================================== */

test('das Neu-Menue traegt beide Wege zum Rezept - Tippen und Import - als Punkte mit Aktion', () => {
  const html = recipes.recipeNewMenuHtml();
  assert.match(html, /data-action="new-recipe"/);
  assert.match(html, /data-action="llm-import"/);
  assert.ok(html.includes('recipes.addRecipe'), 'der Tipp-Punkt nennt seinen Schluessel');
  assert.ok(html.includes('recipes.llmImportOption'), 'der Import-Punkt nennt seinen Schluessel');
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, 2, 'zwei Punkte, nicht mehr und nicht weniger');
});

/* ===========================================================================
 * 3) Der Importdialog
 * ======================================================================== */

const REZEPT_TEXT = 'Kartoffelsalat: Kartoffeln kochen, pellen, mit Bruhe uebergiessen, '
  + 'Zwiebeln und Essig dazu, eine Nacht ziehen lassen. Dazu passt ein Bier.';

/** Die Vorschau, wie die Route sie liefert: das fertige Rezept der App. */
const VORSCHAU = {
  title: 'Kartoffelsalat',
  notes: 'Ein Salat fuer den Sommer.\n\nZubereitung:\n1. Kartoffeln kochen.\n2. Anrichten.\n\nZeit: 30 Min.',
  recipe_url: 'https://example.org/salat',
  servings: 6,
  ingredients: [
    { name: 'Kartoffeln', quantity: '1 kg', category: null },
    { name: 'Salz', quantity: '', category: null },
    { name: 'Pfeffer', quantity: 'nach Geschmack', category: null },
  ],
};

/** Das Attrappen-Panel fuer `onSave`: je id ein Element, der Quell-Umschalter mit. */
function fakePanel() {
  const els = {
    '#llm-import-error': fakeEl({ hidden: true }),
    '#llm-import-url': fakeEl(),
    '#llm-import-text': fakeEl(),
    '#llm-import-url-group': fakeEl({ hidden: false }),
    '#llm-import-text-group': fakeEl({ hidden: true }),
    '#llm-import-analyze': fakeEl(),
    '#llm-import-save': fakeEl({ disabled: true }),
    '#llm-import-cancel': fakeEl(),
    '#llm-import-preview': fakeEl({ hidden: true }),
    '#llm-import-preview-title': fakeEl(),
    '#llm-import-preview-ingredients': fakeEl({ children: [], replaceChildren(...nodes) { this.children = nodes; } }),
    '#llm-import-preview-steps': fakeEl({ children: [], replaceChildren(...nodes) { this.children = nodes; } }),
  };
  const chipUrl = fakeEl({ attrs: {}, dataset: { llmSource: 'url' } });
  const chipText = fakeEl({ attrs: {}, dataset: { llmSource: 'text' } });
  const source = fakeEl();
  return {
    els, chipUrl, chipText, source,
    querySelector: (sel) => (sel === '.llm-import-source' ? source : (els[sel] ?? null)),
    querySelectorAll: () => [chipUrl, chipText],
  };
}

/** Den Dialog oeffnen (ueber den Modal-Stub) und `onSave` am Attrappen-Panel verdrahten. */
async function mitDialog(lauf) {
  const closed = [];
  globalThis.__openModal = (opts) => { globalThis.__lastModal = opts; return true; };
  globalThis.__closeModal = (opts) => { closed.push(opts ?? {}); return true; };
  setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });
  toasts.length = 0;
  recipes.openLlmImportModal();
  const modal = globalThis.__lastModal;
  assert.equal(modal?.title, 'recipes.llmImportTitle', 'der Dialog oeffnet sich nicht mit seinem Titel');
  const panel = fakePanel();
  modal.onSave(panel);
  try {
    return await lauf({ modal, panel, closed });
  } finally {
    delete globalThis.__openModal;
    delete globalThis.__closeModal;
  }
}

test('der Dialog nennt Quelle, Platzhalter, Ueberschriften und seine drei Knoepfe', async () => {
  await mitDialog(({ modal }) => {
    assert.ok(modal.content.includes('recipes.llmImportSourceLabel'));
    assert.ok(modal.content.includes('recipes.llmImportSourceUrl'));
    assert.ok(modal.content.includes('recipes.llmImportSourceText'));
    assert.ok(modal.content.includes('recipes.llmImportUrlPlaceholder'));
    assert.ok(modal.content.includes('recipes.llmImportTextPlaceholder'));
    assert.ok(modal.content.includes('recipes.llmImportPreviewTitle'));
    assert.ok(modal.content.includes('recipes.llmImportIngredientsHeading'));
    assert.ok(modal.content.includes('recipes.llmImportStepsHeading'));
    assert.ok(modal.content.includes('recipes.llmImportAnalyze'));
    assert.ok(modal.content.includes('recipes.llmImportSave'));
  });
});

test('ohne Quelle (und mit Text unter der Rezeptlaenge) sagt der Dialog den Satz der Quelle - die Anfrage bleibt aus', async () => {
  await mitDialog(async ({ panel }) => {
    const rufe = [];
    globalThis.__apiStub = { post: async (path, body) => { rufe.push([path, body]); return { data: { recipe: VORSCHAU } }; } };
    try {
      panel.els['#llm-import-url'].value = '   ';
      panel.els['#llm-import-analyze'].fire('click');
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(panel.els['#llm-import-error'].textContent, 'friendlyError.reasons.llmImportSourceRequired');
      assert.equal(panel.els['#llm-import-error'].hidden, false);
      assert.deepEqual(rufe, [], 'ohne Quelle wird das Modell nicht gefragt');

      // Auf Text umschalten: der Adressblock geht, der Textblock kommt.
      panel.source.fire('click', { target: { closest: () => panel.chipText } });
      assert.equal(panel.els['#llm-import-url-group'].hidden, true);
      assert.equal(panel.els['#llm-import-text-group'].hidden, false);
      assert.equal(panel.chipText.getAttribute('aria-pressed'), 'true');
      assert.equal(panel.chipUrl.getAttribute('aria-pressed'), 'false');

      panel.els['#llm-import-text'].value = 'zu kurz';
      panel.els['#llm-import-analyze'].fire('click');
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(panel.els['#llm-import-error'].textContent, 'friendlyError.reasons.llmImportSourceRequired');
      assert.deepEqual(rufe, [], 'ein Stichwort ist noch kein Rezept');
    } finally { delete globalThis.__apiStub; }
  });
});

test('Analyze mit Adresse: preview-Anfrage, der Satz des Laufs, dann Titel, Zutaten (Menge als Satz) und Schritte', async () => {
  await mitDialog(async ({ panel }) => {
    const rufe = [];
    globalThis.__apiStub = {
      get: async () => ({ data: [] }),
      post: async (path, body) => { rufe.push([path, body]); return { data: { recipe: VORSCHAU } }; },
    };
    try {
      panel.els['#llm-import-url'].value = ' https://example.org/salat ';
      // `fire` ruft den asynchronen Handler auf - die Makrotask-Warteschleife
      // laesst alle Mikrotask-Stufen des Handlers durchlaufen.
      panel.els['#llm-import-analyze'].fire('click');
      await new Promise((r) => setImmediate(r));
      assert.equal(rufe.length, 1, 'genau eine Anfrage');
      assert.equal(rufe[0][0], '/recipes/llm-import');
      assert.deepEqual(rufe[0][1], { preview: true, source_url: 'https://example.org/salat' });
      assert.ok(toasts.some(([text]) => text === 'recipes.llmImportAnalyzing'), 'der Satz des Laufs fehlt');
      assert.equal(panel.els['#llm-import-preview'].hidden, false, 'die Vorschau bleibt verborgen');
      assert.equal(panel.els['#llm-import-preview-title'].textContent, 'Kartoffelsalat');
      assert.deepEqual(
        panel.els['#llm-import-preview-ingredients'].children.map((n) => n.textContent),
        ['1 kg Kartoffeln', 'Salz', 'nach Geschmack Pfeffer'],
        'die Mengen sind keine Saetze',
      );
      assert.deepEqual(
        panel.els['#llm-import-preview-steps'].children.map((n) => n.textContent),
        ['Kartoffeln kochen.', 'Anrichten.'],
        'die Schritte kommen nicht aus dem Notizblock heraus',
      );
      assert.equal(panel.els['#llm-import-save'].disabled, false, 'Speichern ist erst nach der Vorschau frei');
    } finally { delete globalThis.__apiStub; }
  });
});

test('Analyze mit Text: derselbe Endpunkt, die Quelle als text', async () => {
  await mitDialog(async ({ panel }) => {
    const rufe = [];
    globalThis.__apiStub = { post: async (path, body) => { rufe.push([path, body]); return { data: { recipe: VORSCHAU } }; } };
    try {
      panel.source.fire('click', { target: { closest: () => panel.chipText } });
      panel.els['#llm-import-text'].value = REZEPT_TEXT;
      panel.els['#llm-import-analyze'].fire('click');
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(rufe[0][1], { preview: true, text: REZEPT_TEXT });
    } finally { delete globalThis.__apiStub; }
  });
});

test('eine Absage des Servers sagt den Satz ihres Grunds - nie den Text des Servers', async () => {
  for (const [status, reason, key] of [
    [403, 'llm_import_disabled', 'friendlyError.reasons.llmImportDisabled'],
    [403, 'llm_import_not_configured', 'friendlyError.reasons.llmImportNotConfigured'],
    [429, 'llm_import_rate_limited', 'friendlyError.reasons.llmImportRateLimited'],
    [400, 'llm_import_url_blocked', 'friendlyError.reasons.llmImportUrlBlocked'],
    [502, 'llm_import_bad_response', 'friendlyError.reasons.llmImportBadResponse'],
  ]) {
    await mitDialog(async ({ panel }) => {
      globalThis.__apiStub = {
        post: async () => {
          throw Object.assign(new Error('Raw server sentence.'), {
            name: 'ApiError', status, data: { error: 'Raw server sentence.', code: status, reason },
          });
        },
      };
      try {
        panel.els['#llm-import-url'].value = 'https://example.org/salat';
        panel.els['#llm-import-analyze'].fire('click');
        await new Promise((r) => setImmediate(r));
        assert.equal(panel.els['#llm-import-error'].textContent, key, reason);
        assert.equal(panel.els['#llm-import-error'].hidden, false);
        assert.equal(panel.els['#llm-import-preview'].hidden, true);
        assert.equal(panel.els['#llm-import-save'].disabled, true, 'Speichern bleibt gesperrt');
        assert.equal(panel.els['#llm-import-analyze'].disabled, false, 'ein neuer Versuch ist moeglich');
      } finally { delete globalThis.__apiStub; }
    });
  }
});

test('eine Vorschau ohne Titel ist keine Vorschau: der Satz der Antwort, kein Speichern-Weg', async () => {
  await mitDialog(async ({ panel }) => {
    globalThis.__apiStub = { post: async () => ({ data: { recipe: { title: '', ingredients: [] } } }) };
    try {
      panel.els['#llm-import-url'].value = 'https://example.org/salat';
      panel.els['#llm-import-analyze'].fire('click');
      await new Promise((r) => setImmediate(r));
      assert.equal(panel.els['#llm-import-error'].textContent, 'friendlyError.reasons.llmImportBadResponse');
      assert.equal(panel.els['#llm-import-save'].disabled, true);
    } finally { delete globalThis.__apiStub; }
  });
});

test('Speichern sendet das Modell-Format der Vorschau (Menge und Schritte bleiben erhalten), sagt den Erfolg und laedt die Liste neu', async () => {
  await mitDialog(async ({ panel, closed }) => {
    const rufe = [];
    globalThis.__apiStub = {
      get: async (path) => { rufe.push(['GET', path]); return { data: [] }; },
      post: async (path, body) => {
        rufe.push(['POST', path, body]);
        return body?.preview === true ? { data: { recipe: VORSCHAU } } : { data: { id: 7, title: 'Kartoffelsalat' } };
      },
    };
    recipes.setContainerForTest({ querySelector: () => null, querySelectorAll: () => [], isConnected: true });
    try {
      panel.els['#llm-import-url'].value = 'https://example.org/salat';
      panel.els['#llm-import-analyze'].fire('click');
      await new Promise((r) => setImmediate(r));
      panel.els['#llm-import-save'].fire('click');
      await new Promise((r) => setImmediate(r));

      const bestaetigung = rufe.find((r) => r[0] === 'POST' && r[2]?.confirmed === true);
      assert.ok(bestaetigung, 'der bestaetigte Weg fehlt');
      const rezept = bestaetigung[2].recipe;
      assert.equal(rezept.title, 'Kartoffelsalat');
      assert.equal(rezept.description, 'Ein Salat fuer den Sommer.');
      assert.deepEqual(rezept.instructions, ['Kartoffeln kochen.', 'Anrichten.'],
        'die Schritte der Vorschau gehen auf dem Weg zur Bestaetigung verloren');
      assert.deepEqual(rezept.ingredients, [
        { name: 'Kartoffeln', amount: 1, unit: 'kg' },
        { name: 'Salz', amount: null, unit: null },
        { name: 'Pfeffer', amount: null, unit: 'nach Geschmack' },
      ], 'die Mengen der Vorschau sind keine Mengen mehr');
      assert.equal(rezept.servings, 6);
      assert.equal(rezept.prep_time_minutes, 30);

      assert.equal(closed.length, 1, 'der Dialog geht zu');
      assert.ok(closed[0]?.force === true);
      assert.ok(toasts.some(([text, tone]) => text === 'recipes.llmImportToast' && tone === 'success'),
        'der Erfolgssatz fehlt');
      assert.ok(rufe.some((r) => r[0] === 'GET' && r[1] === '/recipes'), 'die Liste kommt nicht frisch');
    } finally {
      delete globalThis.__apiStub;
      recipes.setContainerForTest(null);
    }
  });
});

test('ein Scheitern des bestaetigten Wegs haelt den Dialog offen und sagt den Satz des Grunds', async () => {
  await mitDialog(async ({ panel, closed }) => {
    globalThis.__apiStub = {
      post: async (_path, body) => {
        if (body?.preview === true) return { data: { recipe: VORSCHAU } };
        throw Object.assign(new Error('Rate.'), {
          name: 'ApiError', status: 429, data: { error: 'Rate.', code: 429, reason: 'llm_import_rate_limited' },
        });
      },
    };
    try {
      panel.els['#llm-import-url'].value = 'https://example.org/salat';
      panel.els['#llm-import-analyze'].fire('click');
      await new Promise((r) => setImmediate(r));
      panel.els['#llm-import-save'].fire('click');
      await new Promise((r) => setImmediate(r));
      assert.equal(closed.length, 0, 'der Dialog geht bei einem Fehlschlag nicht zu');
      assert.equal(panel.els['#llm-import-error'].textContent, 'friendlyError.reasons.llmImportRateLimited');
      assert.equal(panel.els['#llm-import-save'].disabled, false, 'ein zweiter Versuch ist moeglich');
      assert.ok(!toasts.some(([text]) => text === 'recipes.llmImportToast'), 'Erfolg gemeldet, obwohl nichts ankam');
    } finally { delete globalThis.__apiStub; }
  });
});

test('bei Nur-lesen-Rechten oeffnet der Importdialog nicht (der Riegel sitzt vor jeder Vorbereitung)', async () => {
  globalThis.__openModal = () => { assert.fail('der Dialog oeffnet sich bei Nur-lesen'); };
  try {
    setPermissions({ admin: false, modules: { meals: 'read', shopping: 'read', pantry: 'read' }, widgets: {}, capabilities: {} });
    recipes.openLlmImportModal();
  } finally {
    delete globalThis.__openModal;
    setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });
  }
});

test('die Stuecke der Vorschau: der Notizblock gibt Beschreibung, Schritte und Zeit her', () => {
  const teile = recipes.llmPreviewParts(VORSCHAU);
  assert.equal(teile.title, 'Kartoffelsalat');
  assert.equal(teile.description, 'Ein Salat fuer den Sommer.');
  assert.deepEqual(teile.steps, ['Kartoffeln kochen.', 'Anrichten.']);
  assert.equal(teile.prepMinutes, 30);
  assert.deepEqual(teile.ingredients.map((ing) => ing.line), ['1 kg Kartoffeln', 'Salz', 'nach Geschmack Pfeffer']);
  // Ohne Beschreibung und ohne Zeit: die reste bleiben leer, der Rest stimmt.
  const knapp = recipes.llmPreviewParts({ title: 'Nur Schritte', notes: 'Zubereitung:\n1. Los.', ingredients: [] });
  assert.equal(knapp.description, '');
  assert.equal(knapp.prepMinutes, null);
  assert.deepEqual(knapp.steps, ['Los.']);
});

test('die Uebersetzung der Vorschau zurueck ins Modell-Format: Mengen als Zahl plus Einheit, Komma wie Punkt', () => {
  const rezept = recipes.llmConfirmedRecipe({
    title: 'Pfannkuchen',
    notes: 'Zubereitung:\n1. Teig ruehren.\n\nZeit: 20 Min.',
    servings: 4,
    ingredients: [
      { name: 'Mehl', quantity: '500 g' },
      { name: 'Milch', quantity: '1,5 l' },
      { name: 'Eier', quantity: '3' },
      { name: 'Oel', quantity: '' },
    ],
  });
  assert.deepEqual(rezept.ingredients, [
    { name: 'Mehl', amount: 500, unit: 'g' },
    { name: 'Milch', amount: 1.5, unit: 'l' },
    { name: 'Eier', amount: 3, unit: null },
    { name: 'Oel', amount: null, unit: null },
  ]);
  assert.deepEqual(rezept.instructions, ['Teig ruehren.']);
  assert.equal(rezept.prep_time_minutes, 20);
  assert.equal(rezept.servings, 4);
});
