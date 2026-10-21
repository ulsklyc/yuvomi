/**
 * Test: PWA-Manifest (zwei Quellen, eine Wahrheit)
 * Zweck: Das Manifest liegt doppelt vor - `public/manifest.json` als statische
 *        Datei (vom Service Worker precached) und `/manifest.webmanifest` aus
 *        server/index.js, das den in den Einstellungen gesetzten App-Namen
 *        einsetzt. Beide zusammenzuhalten war bisher ein Kommentar; ein
 *        Kommentar merkt nicht, wenn eine der beiden Stellen geaendert wird.
 *
 *        Dazu die Orientierung: `orientation` ist eine Sperre, keine
 *        Bevorzugung. `portrait-primary` zwang die installierte App auf einem
 *        Tablet in den schmalen Hochkant-Streifen (#890) - der Schluessel
 *        gehoert in keine der beiden Quellen, auch nicht als 'any'.
 * Ausführen: node --test test/test-pwa-manifest.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_PATH = path.join(HERE, '..', 'public', 'manifest.json');
const SERVER_PATH = path.join(HERE, '..', 'server', 'index.js');

const staticManifest = JSON.parse(fs.readFileSync(STATIC_PATH, 'utf8'));
const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');

/**
 * Das Objektliteral der `/manifest.webmanifest`-Route als Text.
 *
 * Bewusst statisch statt per Import: server/index.js startet beim Laden den
 * Server samt DB.
 */
function serverManifestSource() {
  const start = serverSource.indexOf("app.get('/manifest.webmanifest'");
  assert.notEqual(start, -1, 'Route /manifest.webmanifest nicht gefunden');
  const end = serverSource.indexOf('\n});', start);
  assert.notEqual(end, -1, 'Routenende nicht gefunden');
  return serverSource.slice(start, end);
}

/**
 * Das Manifest der Route als echtes Objekt.
 *
 * Ausgewertet statt zeilenweise gelesen: ein Regex ueber `key: wert,` sieht nur
 * einzeilige Eintraege, und genau daran waere der Guard vorbeigelaufen - ein
 * ueber drei Zeilen verteiltes Ternaer haette `orientation` klaglos wieder
 * eingefuehrt. Der Wert wird ausgerechnet, nicht erraten; `appName` ist die
 * einzige Laufzeit-Groesse und bekommt einen festen Platzhalter.
 */
function serverManifest() {
  const src = serverManifestSource();
  const objStart = src.indexOf('res.json({');
  assert.notEqual(objStart, -1, 'res.json({...}) nicht gefunden');
  const literal = src.slice(objStart + 'res.json('.length).trimEnd().replace(/\);?$/, '');
  // eslint-disable-next-line no-new-func
  return new Function('appName', `return ${literal};`)('TEST_APP_NAME');
}

// --------------------------------------------------------
// Orientierung (#890)
// --------------------------------------------------------

test('kein orientation-Schluessel im statischen Manifest (#890)', () => {
  assert.ok(!('orientation' in staticManifest),
    'orientation sperrt die installierte App auf eine Lage; ohne den Schluessel folgt sie dem Geraet');
});

test('kein orientation-Schluessel in der Server-Route (#890)', () => {
  assert.ok(!('orientation' in serverManifest()),
    'orientation sperrt die installierte App auf eine Lage; ohne den Schluessel folgt sie dem Geraet');
});

// Zweite Klinke am selben Schluessel: die Auswertung oben liefert nur das
// Ergebnis. Wer `orientation` in einen Zweig legt, den der Testlauf nicht
// nimmt, faellt hier auf - im Quelltext hat der Schluessel nichts zu suchen.
test('orientation kommt im Routen-Quelltext gar nicht erst vor (#890)', () => {
  const code = serverManifestSource().split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/\borientation\s*:/.test(code),
    'orientation steht wieder in der Route - auch bedingt gesetzt ist es eine Sperre');
});

// --------------------------------------------------------
// Die zwei Quellen bleiben zusammen
// --------------------------------------------------------

// name/short_name stehen bewusst ausserhalb: die Server-Route setzt dort den in
// den Einstellungen gewaehlten App-Namen ein, die statische Datei den Standard.
const DYNAMIC_KEYS = ['name', 'short_name'];

/** Alles ausser den beiden namensabhaengigen Feldern. */
function comparable(manifest) {
  return Object.fromEntries(Object.entries(manifest).filter(([k]) => !DYNAMIC_KEYS.includes(k)));
}

// Als Regel und nicht als Liste bekannter Felder: eine Allowlist sagt zu jedem
// neuen Schluessel ja, und genau der waere dann der, der auseinanderlaeuft.
test('beide Manifest-Quellen sind Feld fuer Feld gleich (ausser name/short_name)', () => {
  assert.deepEqual(comparable(serverManifest()), comparable(staticManifest),
    'die zwei Manifest-Quellen sind auseinandergelaufen - eine wurde ohne die andere geaendert');
});

test('die namensabhaengigen Felder gibt es in beiden Quellen', () => {
  const server = serverManifest();
  for (const key of DYNAMIC_KEYS) {
    assert.ok(key in server, `${key} fehlt in der Server-Route`);
    assert.ok(key in staticManifest, `${key} fehlt in der statischen Datei`);
  }
  assert.ok(server.name.includes('TEST_APP_NAME'), 'die Route setzt den App-Namen nicht mehr ein');
  assert.equal(server.short_name, 'TEST_APP_NAME');
});

// D15 (Critique R21): die Beschreibungstexte sagten "Familienplaner" - wer
// allein oder zu zweit wohnt, war darin nicht gemeint (wie Anmeldung und
// Rundgang, test:i18n). Der App-NAME (`name`) bleibt: Bestandsinstallationen
// tragen ihn als Titel des installierten Symbols.
test('die Beschreibungen sprechen vom Zuhause, nicht vom Familienplaner (D15)', () => {
  assert.doesNotMatch(staticManifest.description, /familienplaner|family planner/i, 'manifest.json description');
  assert.doesNotMatch(serverManifest().description, /familienplaner|family planner/i, 'Route /manifest.webmanifest description');
  const html = fs.readFileSync(path.join(HERE, '..', 'public', 'index.html'), 'utf8');
  const meta = html.match(/<meta name="description" content="([^"]*)"/);
  assert.ok(meta, 'index.html traegt eine meta description');
  assert.doesNotMatch(meta[1], /familienplaner|family planner/i, 'index.html meta description');
});

test('theme_color folgt dem Rohwert von --_neutral-100 aus tokens.css', () => {
  const tokens = fs.readFileSync(path.join(HERE, '..', 'public', 'styles', 'tokens.css'), 'utf8');
  const m = tokens.match(/--_neutral-100:\s*(#[0-9a-fA-F]{3,8})\s*;/);
  assert.notEqual(m, null, '--_neutral-100 nicht in tokens.css gefunden');
  assert.equal(staticManifest.theme_color.toUpperCase(), m[1].trim().toUpperCase(),
    'der App-Grund im Manifest ist nicht mehr der Token-Wert');
});

// Gegenprobe zur Ableitung selbst: liest der Guard die Route ueberhaupt, oder
// verglichen die Tests oben ein leeres Objekt mit sich selbst?
test('die Route wird wirklich ausgelesen', () => {
  const server = serverManifest();
  assert.equal(server.display, 'standalone');
  assert.ok(Object.keys(server).length >= 10, 'die Route liefert auffaellig wenige Schluessel');
  assert.ok(server.icons.length >= 4, 'die Route fuehrt keine Icons');
});
