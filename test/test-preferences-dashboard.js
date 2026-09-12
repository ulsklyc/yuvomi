/**
 * Test: Die Übersicht gehört der Person, nicht dem Haushalt (#585),
 * und der Haushalt darf trotzdem eine Vorgabe hinterlegen (#827)
 *
 * Geprüft wird die Regel, die den Umbau trägt: Anordnung und Kopfband werden
 * AUSSCHLIESSLICH pro Nutzer geschrieben und mit Haushalts-Fallback gelesen.
 * Beide Hälften brauchen einen Zeugen - ein Test, der nur "Nutzer 2 sieht etwas
 * anderes" prüft, wäre auch dann grün, wenn der Bestand beim Update verschwände.
 *
 * Der dritte Fall ist der, der beim Bauen wirklich falsch war: die PUT-Antwort
 * las den Haushaltswert weiter und meldete nach dem Speichern den Stand zurück,
 * den man gerade ersetzt hatte.
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';

const { get } = await import('../server/db.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');
// Die Id wird gebaut statt getippt: der Test prueft die ZUSAGE aus MODULES.md,
// nicht eine Zeichenkette, die zufaellig heute passt (#1013).
const { fullWidgetId } = await import('../server/services/module-capabilities.js');

let currentUserId = 1;
let currentRole = 'admin';

const WIDGETS_A = [
  { id: 'tasks', visible: true, order: 0, size: '2x2' },
  { id: 'weather', visible: false, order: 1, size: '1x1' },
];
const WIDGETS_HOUSEHOLD = [{ id: 'calendar', visible: true, order: 0, size: '4x2' }];

function clearDashboardPreferences() {
  get().prepare(`
    DELETE FROM sync_config
    WHERE key IN ('dashboard_widgets', 'dashboard_today_glance',
                  'dashboard_widgets_default', 'dashboard_today_glance_default')
       OR key LIKE 'dashboard_widgets:user:%'
       OR key LIKE 'dashboard_today_glance:user:%'
  `).run();
}

/** Den Zustand eines Bestandshaushalts herstellen: haushaltweit gesetzt, niemand persönlich. */
function seedHouseholdValue(key, value) {
  get().prepare('INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function householdValue(key) {
  return get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value ?? null;
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = currentUserId;
    req.authRole = currentRole;
    next();
  });
  app.use('/', preferencesRouter);

  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

const read = async (baseUrl) => (await (await fetch(`${baseUrl}/`)).json()).data;

const write = async (baseUrl, body) => {
  const response = await fetch(`${baseUrl}/`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()).data };
};

test.beforeEach(() => {
  clearDashboardPreferences();
  currentUserId = 1;
  currentRole = 'admin';
});

test('ohne jede Einstellung bleibt es beim Standard', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const data = await read(baseUrl);
    assert.deepEqual(data.dashboard_widgets, []);
    assert.equal(data.dashboard_today_glance, true);
  } finally {
    await close();
  }
});

test('ein Bestandshaushalt erbt seine Anordnung, solange niemand sie für sich ändert', async () => {
  const { baseUrl, close } = await startApp();
  try {
    seedHouseholdValue('dashboard_widgets', JSON.stringify(WIDGETS_HOUSEHOLD));
    seedHouseholdValue('dashboard_today_glance', '0');

    for (const userId of [1, 2, 3]) {
      currentUserId = userId;
      const data = await read(baseUrl);
      assert.deepEqual(data.dashboard_widgets, WIDGETS_HOUSEHOLD, `Nutzer ${userId} erbt die Anordnung nicht`);
      assert.equal(data.dashboard_today_glance, false, `Nutzer ${userId} erbt das Kopfband nicht`);
    }
  } finally {
    await close();
  }
});

test('wer sein Dashboard umbaut, ändert nur sein eigenes', async () => {
  const { baseUrl, close } = await startApp();
  try {
    seedHouseholdValue('dashboard_widgets', JSON.stringify(WIDGETS_HOUSEHOLD));

    const saved = await write(baseUrl, { dashboard_widgets: WIDGETS_A, dashboard_today_glance: false });
    assert.equal(saved.status, 200);

    // Die Antwort auf das Schreiben muss den gerade gespeicherten Stand tragen,
    // nicht den Haushaltswert, den sie ersetzt hat.
    assert.deepEqual(saved.data.dashboard_widgets, WIDGETS_A);
    assert.equal(saved.data.dashboard_today_glance, false);

    currentUserId = 2;
    const other = await read(baseUrl);
    assert.deepEqual(other.dashboard_widgets, WIDGETS_HOUSEHOLD,
      'Nutzer 2 hat die Anordnung von Nutzer 1 bekommen - der Wert wirkt weiter haushaltweit');
    assert.equal(other.dashboard_today_glance, true);

    currentUserId = 1;
    const mine = await read(baseUrl);
    assert.deepEqual(mine.dashboard_widgets, WIDGETS_A);
    assert.equal(mine.dashboard_today_glance, false);
  } finally {
    await close();
  }
});

test('der Haushaltswert bleibt beim Speichern unangetastet', async () => {
  const { baseUrl, close } = await startApp();
  try {
    seedHouseholdValue('dashboard_widgets', JSON.stringify(WIDGETS_HOUSEHOLD));
    seedHouseholdValue('dashboard_today_glance', '1');

    await write(baseUrl, { dashboard_widgets: WIDGETS_A, dashboard_today_glance: false });

    // Der Bestand ist der Fallback für jeden, der noch nichts eigenes hat -
    // ihn zu überschreiben hiesse, den Umbau eines Einzelnen allen zu geben.
    assert.deepEqual(JSON.parse(householdValue('dashboard_widgets')), WIDGETS_HOUSEHOLD);
    assert.equal(householdValue('dashboard_today_glance'), '1');
    assert.ok(householdValue('dashboard_widgets:user:1'), 'der persönliche Wert wurde nicht abgelegt');
  } finally {
    await close();
  }
});

test('die Prüfung der Anordnung gilt weiterhin, auch pro Nutzer', async () => {
  const { baseUrl, close } = await startApp();
  try {
    assert.equal((await write(baseUrl, { dashboard_widgets: {} })).status, 400);
    assert.equal((await write(baseUrl, { dashboard_widgets: [{ id: '../weather', size: '1x1' }] })).status, 400);
    assert.equal((await write(baseUrl, { dashboard_today_glance: '0' })).status, 400);
    assert.equal(householdValue('dashboard_widgets:user:1'), null,
      'eine abgewiesene Anordnung darf nichts hinterlassen');
  } finally {
    await close();
  }
});

// ── Die Vorgabe des Haushalts (#827) ─────────────────────────────────────────
//
// Der Wunsch: der Admin richtet die Übersicht so ein, wie sie für die Familie
// sinnvoll ist, und wer nie in den Anpassen-Modus geht, bekommt genau das. Die
// Mechanik dafür lag längst da - gelesen wurde der Haushaltswert bei jedem
// Request -, geschrieben hat ihn nur nie jemand.

const WIDGETS_DEFAULT = [
  { id: 'calendar', visible: true, order: 0, size: '4x2' },
  { id: 'tasks', visible: true, order: 1, size: '2x2' },
];

test('der Admin hinterlegt eine Vorgabe, und wer nichts Eigenes hat, bekommt sie', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const saved = await write(baseUrl, {
      dashboard_widgets_default: WIDGETS_DEFAULT,
      dashboard_today_glance_default: false,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(householdValue('dashboard_widgets_default')), WIDGETS_DEFAULT);
    assert.equal(householdValue('dashboard_today_glance_default'), '0');

    for (const userId of [2, 3]) {
      currentUserId = userId;
      const data = await read(baseUrl);
      assert.deepEqual(data.dashboard_widgets, WIDGETS_DEFAULT, `Nutzer ${userId} bekommt die Vorgabe nicht`);
      assert.equal(data.dashboard_today_glance, false);
      assert.equal(data.dashboard_follows_default, true);
    }
  } finally {
    await close();
  }
});

test('die Vorgabe überschreibt niemanden, der sich seine Übersicht eingerichtet hat', async () => {
  const { baseUrl, close } = await startApp();
  try {
    currentUserId = 2;
    await write(baseUrl, { dashboard_widgets: WIDGETS_A, dashboard_today_glance: false });

    currentUserId = 1;
    await write(baseUrl, { dashboard_widgets_default: WIDGETS_DEFAULT });

    currentUserId = 2;
    const mine = await read(baseUrl);
    assert.deepEqual(mine.dashboard_widgets, WIDGETS_A,
      'die Vorgabe hat eine persönliche Anordnung plattgemacht');
    assert.equal(mine.dashboard_follows_default, false);
    // Wohin ein Zurücksetzen führen würde, muss die Oberfläche zeigen können.
    assert.deepEqual(mine.dashboard_widgets_default, WIDGETS_DEFAULT);
  } finally {
    await close();
  }
});

test('zurücksetzen löscht den eigenen Stand, statt die Vorgabe zu kopieren', async () => {
  const { baseUrl, close } = await startApp();
  try {
    await write(baseUrl, { dashboard_widgets_default: WIDGETS_DEFAULT, dashboard_today_glance_default: true });

    currentUserId = 2;
    await write(baseUrl, { dashboard_widgets: WIDGETS_A, dashboard_today_glance: false });
    assert.ok(householdValue('dashboard_widgets:user:2'));

    const reset = await write(baseUrl, { dashboard_widgets: null, dashboard_today_glance: null });
    assert.equal(reset.status, 200);
    assert.equal(householdValue('dashboard_widgets:user:2'), null, 'der eigene Stand liegt noch da');
    assert.equal(householdValue('dashboard_today_glance:user:2'), null);
    assert.deepEqual(reset.data.dashboard_widgets, WIDGETS_DEFAULT);
    assert.equal(reset.data.dashboard_follows_default, true);

    // DER EIGENTLICHE PUNKT: nach dem Zurücksetzen wirkt auch die NÄCHSTE
    // Änderung des Admins. Ein Zurücksetzen, das die Vorgabe kopiert hätte,
    // wäre hier grün und in vier Wochen still falsch.
    currentUserId = 1;
    await write(baseUrl, { dashboard_widgets_default: WIDGETS_HOUSEHOLD });
    currentUserId = 2;
    assert.deepEqual((await read(baseUrl)).dashboard_widgets, WIDGETS_HOUSEHOLD);
  } finally {
    await close();
  }
});

test('die Vorgabe geht dem Bestandswert vor, und ohne Vorgabe bleibt der Bestand', async () => {
  const { baseUrl, close } = await startApp();
  try {
    // Der alte haushaltweite Schlüssel ist ein Fossil aus der Zeit vor #585:
    // er trägt, was zuletzt jemand gespeichert hat. Er bleibt der Fallback,
    // solange niemand eine Vorgabe gesetzt hat.
    seedHouseholdValue('dashboard_widgets', JSON.stringify(WIDGETS_HOUSEHOLD));
    currentUserId = 2;
    assert.deepEqual((await read(baseUrl)).dashboard_widgets, WIDGETS_HOUSEHOLD);
    // Und er ist KEINE Vorgabe: die Oberfläche darf einen Zufallsstand nicht
    // als bewusste Entscheidung des Haushalts ausgeben.
    assert.equal((await read(baseUrl)).dashboard_widgets_default, null);

    currentUserId = 1;
    await write(baseUrl, { dashboard_widgets_default: WIDGETS_DEFAULT });
    currentUserId = 2;
    assert.deepEqual((await read(baseUrl)).dashboard_widgets, WIDGETS_DEFAULT);

    currentUserId = 1;
    await write(baseUrl, { dashboard_widgets_default: null });
    currentUserId = 2;
    assert.deepEqual((await read(baseUrl)).dashboard_widgets, WIDGETS_HOUSEHOLD,
      'ohne Vorgabe muss der Bestand wieder greifen');
  } finally {
    await close();
  }
});

test('nur ein Admin hinterlegt die Vorgabe - der eigene Stand bleibt jedem selbst überlassen', async () => {
  const { baseUrl, close } = await startApp();
  try {
    currentRole = 'member';
    assert.equal((await write(baseUrl, { dashboard_widgets_default: WIDGETS_DEFAULT })).status, 403);
    assert.equal((await write(baseUrl, { dashboard_today_glance_default: false })).status, 403);
    assert.equal(householdValue('dashboard_widgets_default'), null);

    // Das eigene Layout und das Zurücksetzen brauchen kein Admin-Recht.
    assert.equal((await write(baseUrl, { dashboard_widgets: WIDGETS_A })).status, 200);
    assert.equal((await write(baseUrl, { dashboard_widgets: null })).status, 200);
  } finally {
    await close();
  }
});

test('die Prüfung gilt auch für die Vorgabe', async () => {
  const { baseUrl, close } = await startApp();
  try {
    assert.equal((await write(baseUrl, { dashboard_widgets_default: {} })).status, 400);
    assert.equal((await write(baseUrl, { dashboard_widgets_default: [{ id: '../weather' }] })).status, 400);
    assert.equal((await write(baseUrl, { dashboard_today_glance_default: '0' })).status, 400);
    assert.equal(householdValue('dashboard_widgets_default'), null,
      'eine abgewiesene Vorgabe darf nichts hinterlassen');
  } finally {
    await close();
  }
});

// ── Fremdmodul-Widgets in der Anordnung (#1013) ──────────────────────────────
//
// Die Speicherform kannte den Doppelpunkt nicht, den `fullWidgetId()` baut. Der
// Preis war nicht "das fremde Widget faellt weg", sondern 400 fuer das GANZE
// Array: wer ein Extension-Widget auf der Uebersicht hatte, konnte keine Kachel
// mehr verschieben, ausblenden oder in der Groesse aendern.
//
// WARUM DIESER TEST NEBEN DEM UNIT-TEST STEHT: `isWidgetId()` in
// test/test-modules.js zu pruefen beweist nur, dass der Helfer richtig ist. Ein
// richtiger Helfer, den die Route nicht aufruft, waere gruen - dieselbe Trennung
// wie bei #1009. Dieser Test haengt an der Route.

test('ein Fremdmodul-Widget ueberlebt Speichern und Lesen (#1013)', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const withExtension = [
      { id: 'tasks', visible: true, order: 0, size: '2x2' },
      { id: fullWidgetId('my-addon', 'chart'), visible: true, order: 1, size: '1x2' },
    ];
    const written = await write(baseUrl, { dashboard_widgets: withExtension });
    assert.equal(written.status, 200);
    assert.deepEqual(written.data.dashboard_widgets.map((w) => w.id), ['tasks', 'my-addon:chart']);
    assert.deepEqual((await read(baseUrl)).dashboard_widgets.map((w) => w.id), ['tasks', 'my-addon:chart']);
  } finally {
    await close();
  }
});

test('die Vorgabe des Haushalts nimmt dieselbe Form an (#1013)', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const written = await write(baseUrl, {
      dashboard_widgets_default: [{ id: fullWidgetId('my-addon', 'chart'), visible: true, order: 0, size: '1x2' }],
    });
    assert.equal(written.status, 200);
    assert.deepEqual(written.data.dashboard_widgets_default.map((w) => w.id), ['my-addon:chart']);
  } finally {
    await close();
  }
});

test('eine kaputte Namensraum-Id bleibt abgewiesen (#1013)', async () => {
  const { baseUrl, close } = await startApp();
  try {
    // Zwei Doppelpunkte heissen nicht Verschachtelung, sondern kaputte Id, und
    // eine Modul-Id unter drei Zeichen gibt es nicht. Der Fix weitet die
    // Schreibweise, er schaltet sie nicht ab.
    assert.equal((await write(baseUrl, { dashboard_widgets: [{ id: 'a:b:c', size: '1x1' }] })).status, 400);
    assert.equal((await write(baseUrl, { dashboard_widgets: [{ id: 'my-addon:', size: '1x1' }] })).status, 400);
    assert.equal((await write(baseUrl, { dashboard_widgets: [{ id: 'mo:chart', size: '1x1' }] })).status, 400);
    assert.equal(householdValue('dashboard_widgets:user:1'), null,
      'eine abgewiesene Anordnung darf nichts hinterlassen');
  } finally {
    await close();
  }
});

// ── Widget-Optionen (#814) ───────────────────────────────────────────────────
//
// Der Server speichert sie und prüft ihre FORM - was drinsteht, weiß allein das
// Frontend. Genau wie bei den Widget-Ids: ein neues Widget darf keine
// Backend-Änderung kosten.

test('Optionen überleben den Weg durch Speichern und Lesen', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const layout = [
      { id: 'calendar', visible: true, order: 0, size: '1x2', options: { scope: 'mine' } },
      { id: 'tasks', visible: true, order: 1, size: '1x2', options: { categories: ['household', 'school'] } },
    ];
    const saved = await write(baseUrl, { dashboard_widgets: layout });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.dashboard_widgets[0].options, { scope: 'mine' });
    assert.deepEqual(saved.data.dashboard_widgets[1].options, { categories: ['household', 'school'] });
    assert.deepEqual((await read(baseUrl)).dashboard_widgets[1].options, { categories: ['household', 'school'] });
  } finally {
    await close();
  }
});

test('ein Widget ohne Optionen trägt kein leeres Optionsfeld mit sich', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const saved = await write(baseUrl, { dashboard_widgets: WIDGETS_A });
    assert.equal(saved.status, 200);
    for (const widget of saved.data.dashboard_widgets) {
      assert.equal('options' in widget, false, 'ein leeres Objekt wäre in jedem Layout dieselbe leere Klammer');
    }
    // Und ein ausdrücklich leeres Objekt verschwindet genauso: gespeichert
    // aussehen soll ein Layout, das den Dialog geöffnet und nichts gewählt hat,
    // wie eines, das ihn nie gesehen hat.
    const emptied = await write(baseUrl, { dashboard_widgets: [{ id: 'tasks', visible: true, order: 0, size: '1x1', options: {} }] });
    assert.equal('options' in emptied.data.dashboard_widgets[0], false);
  } finally {
    await close();
  }
});

test('die Form der Optionen wird geprüft, ihre Bedeutung nicht', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const withOptions = (options) => write(baseUrl, {
      dashboard_widgets: [{ id: 'tasks', visible: true, order: 0, size: '1x1', options }],
    });

    // Der Server kennt kein Widget und keine Option - eine ausgedachte geht
    // durch, weil sonst hier eine Registry stünde, die jedes neue Widget
    // nachziehen müsste.
    assert.equal((await withOptions({ was_auch_immer: true })).status, 200);

    // Eine Liste darf auch Zahlen tragen (#1063 Phase 10: die Waste-Kachel
    // filtert nach Typ-Ids, keine Kategorie-Schlüsseln) - gemischt mit Strings,
    // solange jedes Element für sich gültig ist. Vor den restlichen Checks,
    // damit der Endstand unten weiter der ERSTE erfolgreiche Schreibvorgang ist.
    assert.equal((await withOptions({ list: [1, 2, 3] })).status, 200, 'eine Zahlenliste ist eine gültige Optionsform');
    assert.equal((await withOptions({ list: ['a', 2, 'c'] })).status, 200, 'Strings und Zahlen dürfen sich mischen');
    assert.equal((await withOptions({ was_auch_immer: true })).status, 200);

    assert.equal((await withOptions('mine')).status, 400, 'ein String ist kein Optionsobjekt');
    assert.equal((await withOptions([1, 2])).status, 400, 'ein Array ist kein Optionsobjekt');
    assert.equal((await withOptions({ 'Groß': true })).status, 400, 'Schlüssel sind klein und schlicht');
    assert.equal((await withOptions({ nested: { a: 1 } })).status, 400, 'verschachtelt hätte keine Tiefengrenze');
    assert.equal((await withOptions({ list: [{ a: 1 }] })).status, 400);
    assert.equal((await withOptions({ list: [Infinity] })).status, 400, 'eine nicht-endliche Zahl bleibt ungültig, wie beim Einzelwert');
    assert.equal((await withOptions({ list: [NaN] })).status, 400);
    assert.equal((await withOptions({ text: 'x'.repeat(65) })).status, 400);
    assert.equal((await withOptions({ list: Array.from({ length: 51 }, (_, i) => `c${i}`) })).status, 400);
    assert.equal((await withOptions(Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`k${i}`, true]),
    ))).status, 400, 'acht Optionen sind genug für ein Widget');

    // Eine abgewiesene Option darf den vorherigen Stand nicht anfassen.
    assert.deepEqual(
      (await read(baseUrl)).dashboard_widgets[0].options,
      { was_auch_immer: true },
    );
  } finally {
    await close();
  }
});
