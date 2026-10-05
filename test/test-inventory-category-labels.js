/**
 * Test: Kategorie-Beschriftung im Frontend (#783)
 * Zweck: Eine Seed-Kategorie traegt ihren Namen nicht in `name`, sondern als
 *        i18n-Key in `label_key` (inventory: Migration 143, tasks: 83,
 *        contacts: analog) - `name` ist dort NULL. Wer das Label roh aus
 *        `name` liest, rendert eine LEERE Beschriftung: genau so stand die
 *        Kategorie-Auswahl im Gegenstands-Formular unbeschriftet da (#783).
 *        Geprueft wird beides: das Verhalten der Auswahl-Erzeugung und - als
 *        Regel ueber alle Seiten, nicht als Liste bekannter Fundstellen - dass
 *        keine Seite mit label_key-Kategorien ein <option>-Label direkt aus
 *        `.name` speist.
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-inventory-category-labels.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { withoutBlockComments } from './source-text.js';

const { __test: inventory } = await import('../public/pages/inventory.js');

// Wie die API sie liefert (siehe test:inventory-categories-routes): Seed-Zeilen
// mit label_key und name = NULL, Custom-Zeilen mit name und label_key = NULL.
const SEED = [
  { key: 'electronics', name: null, label_key: 'inventory.categoryElectronics', icon: 'cpu' },
  { key: 'vehicles',    name: null, label_key: 'inventory.categoryVehicles',    icon: 'car' },
  { key: 'household',   name: null, label_key: 'inventory.categoryHousehold',   icon: 'home' },
  { key: 'sports',      name: null, label_key: 'inventory.categorySports',      icon: 'dumbbell' },
  { key: 'other',       name: null, label_key: 'inventory.categoryOther',       icon: 'package' },
];
const CUSTOM = { key: 'werkzeug', name: 'Werkzeug', label_key: null, icon: 'wrench' };

/** Beschriftungen aus einer <option>-Liste ziehen (leere Labels bleiben sichtbar). */
function optionLabels(html) {
  return [...html.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)]
    .map((m) => ({ value: m[1], label: m[2] }));
}

test('die Kategorie-Auswahl beschriftet Seed-Kategorien (name = NULL) nicht leer', () => {
  const options = optionLabels(inventory.categoryOptionsHtml(SEED));
  assert.equal(options.length, SEED.length, 'jede Kategorie ergibt genau eine Option');
  for (const { value, label } of options) {
    assert.notEqual(label, '', `Kategorie "${value}" steht ohne Beschriftung in der Auswahl`);
  }
  // t() liefert im Test den Key zurueck - das Label muss aus label_key kommen
  // und nicht aus einem Rueckfall auf den technischen Key.
  assert.deepEqual(options.map((o) => o.label), SEED.map((c) => c.label_key));
});

test('die Kategorie-Auswahl beschriftet Custom-Kategorien mit ihrem Namen', () => {
  const options = optionLabels(inventory.categoryOptionsHtml([CUSTOM]));
  assert.deepEqual(options, [{ value: 'werkzeug', label: 'Werkzeug' }]);
});

test('die Auswahl behaelt Reihenfolge und Key als Wert (die Vorauswahl haengt am Key)', () => {
  const options = optionLabels(inventory.categoryOptionsHtml([...SEED, CUSTOM]));
  assert.deepEqual(options.map((o) => o.value), [...SEED.map((c) => c.key), CUSTOM.key]);
});

test('categoryLabel faellt der Reihe nach auf label_key, name, key zurueck', () => {
  assert.equal(inventory.categoryLabel({ key: 'other', name: null, label_key: 'inventory.categoryOther' }),
    'inventory.categoryOther');
  assert.equal(inventory.categoryLabel({ key: 'werkzeug', name: 'Werkzeug', label_key: null }), 'Werkzeug');
  assert.equal(inventory.categoryLabel({ key: 'unbekannt', name: null, label_key: null }), 'unbekannt');
  assert.equal(inventory.categoryLabel(null), '');
});

test('itemCategoryLabel loest die denormalisierten Item-Felder gleich auf', () => {
  assert.equal(inventory.itemCategoryLabel({ category: 'other', category_name: null, category_label_key: 'inventory.categoryOther' }),
    'inventory.categoryOther');
  assert.equal(inventory.itemCategoryLabel({ category: 'werkzeug', category_name: 'Werkzeug', category_label_key: null }),
    'Werkzeug');
  assert.equal(inventory.itemCategoryLabel({ category: 'weg', category_name: null, category_label_key: null }), 'weg');
});

// Regel statt Fundstellen-Liste: welche Seiten label_key-Kategorien fuehren,
// wird aus dem Quelltext ABGELEITET - ein neues Modul mit lokalisierten
// Kategorien faellt damit automatisch unter die Regel, statt an einer Allowlist
// vorbeizulaufen.
const pagesDir = new URL('../public/pages/', import.meta.url);
const localizedPages = readdirSync(pagesDir)
  .filter((f) => f.endsWith('.js'))
  // Kommentare raus, bevor der Guard liest: ein Kommentar, der `label_key` oder
  // `.name` erwaehnt, ist keine Regel (siehe Kopf von test/source-text.js).
  .map((f) => ({
    file: f,
    src: withoutBlockComments(readFileSync(new URL(f, pagesDir), 'utf8')).replace(/^\s*\/\/.*$/gm, ''),
  }))
  .filter(({ src }) => /label_key/.test(src));

test('mindestens die drei bekannten Seiten mit lokalisierten Kategorien werden erfasst', () => {
  const files = localizedPages.map((p) => p.file).sort();
  for (const expected of ['contacts.js', 'inventory.js', 'tasks.js']) {
    assert.ok(files.includes(expected), `${expected} fuehrt label_key-Kategorien, wird aber nicht geprueft - `
      + 'der Ableitungs-Filter greift nicht mehr');
  }
});

/* EIN AUSWAHLFELD IST NICHT IMMER EIN <option> (#814). Die Uebersicht bietet
 * die Aufgaben-Kategorien als Checkbox-Liste an - dieselbe Sorte Beschriftung,
 * dieselbe Falle, aber ein anderes Tag. Die erste Fassung suchte woertlich nach
 * <option> und meldete die neue Seite als "Muster greift nicht mehr": richtig
 * alarmiert, falsch begruendet.
 *
 * Gesucht wird deshalb der TRAEGER DES SCHLUESSELS und die Beschriftung bis zum
 * Ende seines Elements. Das deckt <option> wie <label> ab und faellt beim
 * naechsten Tag nicht wieder um.
 *
 * DER TRAEGER IST NICHT IMMER `.key` (#950). Die Abo-Kategorien und
 * -Zahlungsarten sind AUTOINCREMENT-Zeilen; ihre Auswahl schreibt
 * `value="${item.id}"`. Als subscriptions.js seinen Label-Resolver bekam, fiel
 * die Datei in den Erfassungsbereich dieses Guards - und er meldete "das Muster
 * greift nicht mehr", weil er dort keine einzige Auswahl fand. Wieder richtig
 * alarmiert; die Regel gilt fuer beide Schluesselarten. */
const CATEGORY_CONTROL_RE = /value="\$\{(?:esc\((\w+)\.key\)|(\w+)\.id)\}"([\s\S]*?)<\/(?:option|label)>/g;

/* DIE AUSWAHL STEHT NICHT IMMER ALS MARKUP IM MAP (Budget-Critique 2026-09-25).
 * Das Abo-Filterblatt baut seine Selects ueber einen Helfer, der Paare
 * `[wert, beschriftung]` bekommt; der Verwalten-Dialog uebergibt Objekte
 * `{ value, label }`. Das `<option>` entsteht dann im Helfer, weit weg von der
 * Liste - und der Guard fand in subscriptions.js "keine Auswahl mehr", obwohl
 * die Regel dieselbe ist: die Beschriftung einer Seed-Kategorie darf nicht aus
 * `.name` kommen. Gesucht wird deshalb auch die ZUORDNUNG von Schluessel zu
 * Beschriftung, wo immer sie steht. Gruppe 1 = Liste, 2 = Variable, 3/4 = Label. */
const CATEGORY_PAIR_RE = /([\w.]+)\s*\.\s*map\(\((\w+)\)\s*=>\s*(?:\[\s*\2\.(?:id|key)\s*,([^\]]*)\]|\(\{\s*value:\s*\2\.(?:id|key)\s*,\s*label:\s*([^}]*)\}\))/g;

/* WAS EINE KATEGORIE-AUSWAHL IST, WIRD ABGELEITET - aus den Tabellen in
 * server/db.js, die eine `label_key`-Spalte fuehren. Ohne diese Einschraenkung
 * traefe das erweiterte `.id`-Muster auch die Lagerort-Auswahl im Inventar
 * (`inventory_locations`), deren `name` NOT NULL ist und die gar keinen
 * Schluessel kennt: ein Fehlalarm, der den Guard nur muerbe machen wuerde.
 *
 * Abgeleitet wird der Sammelname, unter dem das Frontend die Liste fuehrt -
 * `subscription_payment_methods` → `payment_methods`, `task_categories` →
 * `categories`. Ein neues Modul mit lokalisierten Kategorien faellt damit
 * automatisch darunter, statt an einer Allowlist vorbeizulaufen. */
function labelKeyCollections() {
  const dbSrc = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  const namen = new Set();
  for (const m of dbSrc.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\);/g)) {
    if (!/^\s*label_key\s/m.test(m[2])) continue;
    namen.add(m[1].replace(/^(?:task|contact|inventory|subscription|budget)_/, ''));
  }
  for (const m of dbSrc.matchAll(/ALTER TABLE (\w+)\s+ADD COLUMN label_key\b/g)) {
    namen.add(m[1].replace(/^(?:task|contact|inventory|subscription|budget)_/, ''));
  }
  return [...namen];
}

const LABEL_KEY_COLLECTIONS = labelKeyCollections();

test('die label_key-Sammlungen werden aus server/db.js abgeleitet', () => {
  // Ohne diese Probe liefe der Guard darunter ueber eine leere Menge und waere
  // gruen, ohne noch irgendetwas zu pruefen.
  for (const erwartet of ['categories', 'payment_methods']) {
    assert.ok(LABEL_KEY_COLLECTIONS.includes(erwartet),
      `"${erwartet}" fehlt in der Ableitung aus db.js - greift das Tabellen-Muster noch? `
      + `gefunden: ${LABEL_KEY_COLLECTIONS.join(', ') || '(nichts)'}`);
  }
});

for (const { file, src } of localizedPages) {
  test(`${file}: kein Kategorie-Label kommt roh aus .name`, () => {
    const controls = [...src.matchAll(CATEGORY_CONTROL_RE)]
      // Nur Auswahlen ueber eine Liste, die ueberhaupt label_key fuehren kann.
      // Massgeblich ist die QUELLE DER ITERATIONSVARIABLEN, nicht was zufaellig
      // in der Naehe steht: im Gegenstands-Formular des Inventars steht die
      // Kategorie-Auswahl zwei Zeilen ueber der Lagerort-Auswahl, und ein Blick
      // auf die letzten 200 Zeichen haelt deshalb `root` faelschlich fuer eine
      // Kategorie. Gesucht wird die naechstgelegene Bindung dieser Variablen -
      // `<quelle>.map((<var>` oder `for (const <var> of <quelle>)`.
      .filter((m) => {
        const variable = m[1] ?? m[2];
        const vorlauf = src.slice(0, m.index);
        const bindungen = [
          ...vorlauf.matchAll(new RegExp(`([\\w.]+)\\s*\\.\\s*map\\(\\(${variable}\\b`, 'g')),
          ...vorlauf.matchAll(new RegExp(`for \\(const ${variable} of ([\\w.]+)`, 'g')),
        ];
        if (bindungen.length === 0) return false;
        const naechste = bindungen.reduce((a, b) => (a.index > b.index ? a : b));
        return LABEL_KEY_COLLECTIONS.some((c) => new RegExp(`\\b${c}$`).test(naechste[1]));
      });
    const pairs = [...src.matchAll(CATEGORY_PAIR_RE)]
      .filter((m) => LABEL_KEY_COLLECTIONS.some((c) => new RegExp(`\\b${c}$`).test(m[1])))
      .map((m) => ({ variable: m[2], label: m[3] ?? m[4] }));
    const alle = [
      ...controls.map((m) => ({ variable: m[1] ?? m[2], label: m[3] })),
      ...pairs,
    ];
    assert.ok(alle.length > 0, `keine Kategorie-Auswahl in ${file} gefunden - das Muster greift nicht mehr`);
    for (const { variable, label } of alle) {
      assert.ok(!new RegExp(`\\b${variable}\\.name\\b`).test(label),
        `${file}: die Auswahl liest ihr Label direkt aus ${variable}.name - bei einer Seed-Kategorie `
        + 'ist name NULL und die Beschriftung bleibt leer (#783). Ueber den Label-Resolver gehen.');
    }
  });
}
