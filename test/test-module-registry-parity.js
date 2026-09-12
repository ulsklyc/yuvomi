/**
 * Test: Modul-Register-Parität Client ↔ Server
 * Zweck: Mehrere Client-Listen spiegeln serverseitig gepflegte Modul-Register.
 *        Jede trägt einen Kommentar „muss zu server/… passen" - und dieser
 *        Kommentar war bislang die einzige Durchsetzung. Beim Einbau des
 *        Vorrats-Moduls (#596) war der Server lückenlos verdrahtet, während
 *        ALLE sechs Client-Zwillinge durchrutschten: nicht vergebbare API-Scopes,
 *        ein nicht greifendes Nav-Gate, ein Modul außerhalb der Küchen-Gruppe,
 *        ein fehlender Akzentpunkt und ein offline ungestyltes Stylesheet.
 *
 *        Dieser Guard prüft die Spiegelung mechanisch statt kommentarisch.
 *        Er ist bewusst als Mengen-Vergleich formuliert: ein neues Modul fällt
 *        dadurch beim ersten Testlauf auf, egal welche Liste vergessen wurde.
 * Ausführen: node --test test/test-module-registry-parity.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const { MODULE_KEYS } = await import('../server/scopes.js');
const { PERMISSION_MODULES } = await import('../server/permissions.js');
const { KITCHEN_CHILD_IDS } = await import('../public/settings/module-order.js');

/**
 * Liest ein Array-Literal aus einer Frontend-Quelldatei.
 * Die Settings-Seiten importieren Browser-Module (`/api.js` & Co.) und lassen
 * sich in Node nicht laden - deshalb Textextraktion statt Import.
 */
function arrayLiteral(source, name) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  assert.ok(match, `${name} nicht gefunden`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Liest die Schlüssel eines Objekt-Literals aus einer Frontend-Quelldatei. */
function objectKeys(source, name) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*(?:Object\\.freeze\\()?\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `${name} nicht gefunden`);
  return [...match[1].matchAll(/^\s*([A-Za-z_][\w-]*)\s*:/gm)].map((m) => m[1]);
}

// --------------------------------------------------------------------------
// Scopes: die API-Token-Oberfläche muss jeden scopebaren Modulschlüssel kennen
// --------------------------------------------------------------------------
test('admin-api.js CORE_SCOPE_MODULE_KEYS deckt jeden Scope-Modulschlüssel ab', () => {
  const client = arrayLiteral(read('../public/settings/pages/admin-api.js'), 'CORE_SCOPE_MODULE_KEYS');
  const missing = MODULE_KEYS.filter((key) => !client.includes(key));
  const extra = client.filter((key) => !MODULE_KEYS.includes(key));

  assert.deepEqual(missing, [], 'Scopes ohne UI: diese Module lassen sich nicht an ein Token vergeben');
  assert.deepEqual(extra, [], 'UI bietet Scopes an, die der Server nicht kennt');
});

// --------------------------------------------------------------------------
// Nav-Gate: jede navId eines gateable Moduls braucht ihre Zuordnung im Client
// --------------------------------------------------------------------------
test('permissions.js NAV_TO_MODULE kennt jede navId aus PERMISSION_MODULES', () => {
  const client = objectKeys(read('../public/permissions.js'), 'NAV_TO_MODULE');
  const navIds = PERMISSION_MODULES.flatMap((m) => m.navIds);
  const missing = navIds.filter((id) => !client.includes(id));

  // canAccessNavModule() gibt für unbekannte Keys `true` zurück - ein fehlender
  // Eintrag sperrt also nichts, sondern zeigt das Modul trotz Recht "none".
  assert.deepEqual(missing, [], 'ungegatete navIds: das Modul bleibt trotz Recht "none" sichtbar');
});

test('admin-permissions.js MODULE_ACCENT deckt jedes Permissions-Modul ab', () => {
  const client = objectKeys(read('../public/settings/pages/admin-permissions.js'), 'MODULE_ACCENT');
  const missing = PERMISSION_MODULES.map((m) => m.key).filter((key) => !client.includes(key));

  assert.deepEqual(missing, [], 'Module ohne Akzentpunkt in der Rechte-Verwaltung');
});

// --------------------------------------------------------------------------
// Küchen-Gruppe: drei Listen müssen sich gemeinsam bewegen
// --------------------------------------------------------------------------
test('die drei Kitchen-Child-Listen tragen dieselben IDs', () => {
  // Seit dem Umzug des Haushalts-Schalters (Critique 2026-08-16) lesen ZWEI
  // Blaetter dieselben Kuechen-Kinder; die Listen wohnen deshalb im geteilten
  // module-order.js statt in einem der beiden.
  const source = read('../public/settings/module-order.js');
  const labels = objectKeys(source, 'KITCHEN_CHILD_LABEL_KEYS');

  // Fehlt eine ID in den Labels, rendert der Nav-Editor `t(undefined)`.
  assert.deepEqual(labels, [...KITCHEN_CHILD_IDS], 'KITCHEN_CHILD_LABEL_KEYS weicht ab');

  // DIE DRITTE LISTE IST UMGEZOGEN, NICHT ENTFALLEN. Hier stand
  // `KITCHEN_CHILD_ICONS` aus derselben Datei; seit 2026-08-17 steht jedes
  // Modulzeichen in `MODULE_ICON` (nav-icons.js), weil dieselbe Zuordnung
  // vorher an fuenf Stellen stand und auseinandergelaufen war. Die Zusicherung
  // bleibt Wort fuer Wort dieselbe - fehlt eine ID, rendert die Zeile ein
  // `data-lucide="undefined"` und damit gar nichts.
  const icons = objectKeys(read('../public/nav-icons.js'), 'MODULE_ICON');
  const fehlend = KITCHEN_CHILD_IDS.filter((id) => !icons.includes(id));
  assert.deepEqual(fehlend, [], 'Kitchen-Kind ohne Zeichen in MODULE_ICON');
});

test('server KITCHEN_NAV_IDS enthält jedes Kitchen-Kind des Clients', () => {
  const source = read('../server/routes/preferences.js');
  const match = source.match(/KITCHEN_NAV_IDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match, 'KITCHEN_NAV_IDS nicht gefunden');
  const serverIds = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const missing = KITCHEN_CHILD_IDS.filter((id) => !serverIds.includes(id));
  assert.deepEqual(missing, [], 'Kitchen-Kind fehlt in der serverseitigen Nav-Validierung');
});

// --------------------------------------------------------------------------
// Service Worker: jedes Modul mit eigenem Stylesheet gehört in die App-Shell,
// sonst rendert die Seite offline unformatiert
// --------------------------------------------------------------------------
// Auf die Deklarationen ankern, nicht auf den ersten Namenstreffer: beide
// Konstanten werden im Kopfkommentar der Datei erwähnt.
function swArray(sw, name) {
  const start = sw.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `const ${name} = [ nicht gefunden`);
  const end = sw.indexOf('];', start);
  assert.notEqual(end, -1, `Ende von ${name} nicht gefunden`);
  return sw.slice(start, end);
}

test('sw.js APP_SHELL cacht das Stylesheet jedes Kitchen-Moduls', () => {
  const shell = swArray(read('../public/sw.js'), 'APP_SHELL');

  for (const id of KITCHEN_CHILD_IDS) {
    assert.ok(
      shell.includes(`'/styles/${id}.css'`),
      `/styles/${id}.css fehlt in APP_SHELL - die Seite rendert offline ungestylt`
    );
  }
});

test('sw.js PAGE_MODULES cacht die Seite jedes Kitchen-Moduls', () => {
  const modules = swArray(read('../public/sw.js'), 'PAGE_MODULES');

  for (const id of KITCHEN_CHILD_IDS) {
    assert.ok(
      modules.includes(`'/pages/${id}.js'`),
      `/pages/${id}.js fehlt in PAGE_MODULES`
    );
  }
});

// --------------------------------------------------------------------------
// Toggle-Register: was der Nav-Editor als Kitchen-Kind führt, muss auch
// abschaltbar sein - sonst hat die Gruppe ein Kind ohne Schalter
// --------------------------------------------------------------------------
test('TOGGLEABLE_MODULES enthält jedes Kitchen-Kind', () => {
  const source = read('../server/routes/preferences.js');
  const match = source.match(/TOGGLEABLE_MODULES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(match, 'TOGGLEABLE_MODULES nicht gefunden');
  const toggleable = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const missing = KITCHEN_CHILD_IDS.filter((id) => !toggleable.includes(id));
  assert.deepEqual(missing, [], 'Kitchen-Kind ohne Abschalt-Möglichkeit');
});

// --------------------------------------------------------------------------
// Die kanonische Modulliste: README.md
//
// CLAUDE.md nennt die Tabelle in README.md die kanonische Modulliste, und
// genau dort stand ein neu gebautes Modul zuletzt nicht drin. Aufgefallen ist
// es niemandem: `test:readme-consistency` prueft die README gegen sich selbst
// und gegen die Homepage - fehlt ein Modul auf BEIDEN Flaechen, ist das
// konsistent. Kein Test hat die ausgelieferten Module je gegen die Tabelle
// gehalten.
//
// Die Zuordnung unten ist KEIN Ausnahmeverzeichnis, sondern eine Uebersetzung:
// die Ueberschriften weichen bewusst von den Schluesseln ab (`notes` und
// `contacts` teilen sich eine Zeile). Ein Schluessel ohne Eintrag laesst den
// Test fallen - eine Allowlist wuerde ihn durchwinken.
//
// Geprueft wird die englische README; dass die deutsche dieselbe Struktur
// traegt, haelt `test:readme-consistency` fest.
// --------------------------------------------------------------------------
const README_HEADINGS = {
  tasks: 'Tasks',
  shopping: 'Shopping',
  meals: 'Meals',
  pantry: 'Pantry',
  inventory: 'Inventory',
  calendar: 'Calendar',
  notes: 'Notes &amp; Contacts',
  contacts: 'Notes &amp; Contacts',
  schedule: 'Schedule',
  budget: 'Budget',
  documents: 'Documents',
  health: 'Health',
  rewards: 'Rewards',
  housekeeping: 'Housekeeping',
  waste: 'Waste collection',
};

/** Die fett gesetzten Ueberschriften der Modultabelle, in Dokumentreihenfolge. */
function readmeModuleHeadings(md) {
  return [...md.matchAll(/^\|\s\*\*([^*]+)\*\*\s\|/gm)].map((m) => m[1].trim());
}

test('jedes rechteverwaltete Modul hat eine Zeile in der README-Modultabelle', () => {
  const headings = readmeModuleHeadings(read('../README.md'));
  assert.ok(headings.length >= 15, `nur ${headings.length} Tabellenzeilen gefunden - der Leser greift nicht mehr`);

  const unmapped = PERMISSION_MODULES.map((m) => m.key).filter((key) => !(key in README_HEADINGS));
  assert.deepEqual(unmapped, [], 'Modul ohne Zuordnung zu einer README-Ueberschrift - Zuordnung ergaenzen, nicht den Test lockern');

  const missing = PERMISSION_MODULES
    .map((m) => README_HEADINGS[m.key])
    .filter((heading) => !headings.includes(heading));
  assert.deepEqual([...new Set(missing)], [], 'Modul fehlt in der kanonischen Modulliste (README.md)');
});

// Gegenprobe zur Ableitung: liest der Test die Tabelle ueberhaupt, oder
// verglich er eine leere Liste mit einer leeren?
test('der README-Leser findet die Tabelle wirklich', () => {
  const headings = readmeModuleHeadings('| Module | In one line |\n|---|---|\n| **Foo** | Bar. |\n| **Baz** | Qux. |\n');
  assert.deepEqual(headings, ['Foo', 'Baz']);
  assert.deepEqual(readmeModuleHeadings('kein Markup'), []);
});

// --------------------------------------------------------------------------
// Die Navigation: was rechteverwaltet ist, muss auch erreichbar sein
//
// `navItems()` in public/router.js speist Seitenleiste, Mobil-Navigation UND
// den Modulkatalog. Ein Modul, das dort herausfaellt, ist nur noch ueber die
// direkt eingetippte Adresse zu erreichen - die Route bleibt ja registriert,
// deshalb faellt es auch keinem Routing-Test auf. Genau das passierte beim
// Rebase eines Feature-Branches: die `rewards`-Zeile verschwand still.
// --------------------------------------------------------------------------

/** Die `module:`-Schluessel aus dem Rueckgabe-Array von navItems(). */
function navModuleKeys(source) {
  const start = source.indexOf('function navItems(');
  assert.notEqual(start, -1, 'navItems() nicht gefunden');
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, 'Ende von navItems() nicht gefunden');
  return [...source.slice(start, end).matchAll(/module:\s*'([a-z-]+)'/g)].map((m) => m[1]);
}

test('jedes rechteverwaltete Modul hat einen Eintrag in navItems()', () => {
  const keys = navModuleKeys(read('../public/router.js'));
  assert.ok(keys.length >= 15, `nur ${keys.length} Nav-Eintraege gefunden - der Leser greift nicht mehr`);

  const missing = PERMISSION_MODULES.map((m) => m.key).filter((key) => !keys.includes(key));
  assert.deepEqual(missing, [],
    'Modul ohne Nav-Eintrag: die Route bleibt registriert, aber Seitenleiste, Mobilnavigation und Katalog verlieren es');
});

// Gegenprobe zur Ableitung: liest der Test die Funktion ueberhaupt aus?
test('der navItems-Leser findet die Eintraege wirklich', () => {
  const fake = "function navItems({ x } = {}) {\n  return [\n    { path: '/a', module: 'alpha' },\n    { path: '/b', module: 'beta' },\n  ];\n}\n";
  assert.deepEqual(navModuleKeys(fake), ['alpha', 'beta']);
});
