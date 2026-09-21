/**
 * Tests für public/lang-init.js — das synchrone <head>-Bootstrap, das
 * document.documentElement.lang vor dem Render auf die echte Nutzer-Locale setzt
 * (verhindert falsches „aus dem Deutschen übersetzen" in Chromium-Browsern).
 *
 * Die Resolve-Logik muss mit i18n.js (resolveLocale) übereinstimmen:
 *   manueller Override (localStorage) > navigator.languages > 'en', und je Tag
 *   die SPEZIFISCHSTE unterstützte Locale, nicht stur die Basissprache.
 *
 * Beide Dateien tragen diese Logik und ihre Sprachliste eigenständig: ein
 * render-blockierendes <head>-Skript darf kein Modul importieren. Die Tests ab
 * „lang-init.js und i18n.js" halten die beiden Fassungen aneinander - vorher
 * verglich sie niemand, und so fehlte `fil` dort sieben Wochen lang (#1324).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { pickLocale, getSupportedLocales } from '../public/i18n.js';

const SRC = readFileSync(new URL('../public/lang-init.js', import.meta.url), 'utf8');
const I18N_SRC = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');

/** Führt lang-init.js in einer Sandbox aus und liefert die gesetzten HTML-Metadaten. */
function runLangInitState({ stored = null, languages = undefined, language = undefined, throwOnStorage = false, src = SRC } = {}) {
  const html = { lang: '', dir: '' };
  const sandbox = {
    document: { documentElement: html },
    navigator: { languages, language },
    localStorage: {
      getItem(key) {
        if (throwOnStorage) throw new Error('blocked');
        return key === 'yuvomi-locale' ? stored : null;
      },
    },
  };
  runInContext(src, createContext(sandbox));
  return html;
}

function runLangInit(options = {}) {
  return runLangInitState(options).lang;
}

test('gültiger localStorage-Override gewinnt', () => {
  assert.equal(runLangInit({ stored: 'fr', languages: ['de-DE'] }), 'fr');
});

test('ungültiger localStorage-Wert wird ignoriert, Fallback auf navigator', () => {
  assert.equal(runLangInit({ stored: 'xx', languages: ['en-US', 'de'] }), 'en');
});

test('navigator.languages: erstes unterstütztes Basis-Tag gewinnt', () => {
  assert.equal(runLangInit({ languages: ['en-US', 'de'] }), 'en');
});

test('Region-Tag wird auf Basis-Sprache reduziert (de-AT → de)', () => {
  assert.equal(runLangInit({ languages: ['de-AT'] }), 'de');
});

test('nicht unterstützte Sprache fällt auf en zurück (th-TH → en)', () => {
  assert.equal(runLangInit({ languages: ['th-TH'] }), 'en');
});

test('überspringt nicht unterstützte und nimmt das nächste unterstützte Tag', () => {
  assert.equal(runLangInit({ languages: ['th-TH', 'nl-BE'] }), 'nl');
});

test('navigator.language (Singular) als Fallback wenn languages fehlt', () => {
  assert.equal(runLangInit({ language: 'pt-BR' }), 'pt');
});

test('blockierter localStorage (Privatmodus) wirft nicht, nutzt navigator', () => {
  assert.equal(runLangInit({ throwOnStorage: true, languages: ['it-IT'] }), 'it');
});

test('keine brauchbaren Signale → en', () => {
  assert.equal(runLangInit({ languages: [] }), 'en');
});

test('Arabisch setzt vor dem Rendern die Schreibrichtung auf rtl', () => {
  assert.deepEqual(
    runLangInitState({ stored: 'ar', languages: ['de-DE'] }),
    { lang: 'ar', dir: 'rtl' },
  );
});

test('Nicht-RTL-Sprachen setzen die Schreibrichtung explizit auf ltr zurück', () => {
  assert.deepEqual(
    runLangInitState({ stored: 'de', languages: ['ar'] }),
    { lang: 'de', dir: 'ltr' },
  );
});


// --- Die zweite Fassung derselben Logik ------------------------------------
//
// `public/i18n.js` ist die erste. Kein Import verbindet die beiden: lang-init.js
// laeuft render-blockierend im <head>, bevor ein Modul geladen ist, und genau
// darin liegt sein Sinn (Chromium entscheidet die Uebersetzungsfrage beim ersten
// Parse). Ein Kommentar hielt sie bisher zusammen, und ein Kommentar merkt
// nicht, wenn eine Seite sich aendert: `fil` kam am 04.08.2026 als 24. Sprache
// dazu, lang-init.js blieb bei 23, und ein philippinisches System bekam sieben
// Wochen lang `lang="en"` auf einen Body, der auf Filipino rendert (#1324).
//
// Die Frontend-Liste hatte schon einen Gleichstandstest - test-i18n.js stellt
// sie gegen die Serverliste. lang-init.js ist ein DRITTER Leser derselben
// Wahrheit, den keiner der beiden ansah.

/**
 * Liest ein Array-Literal aus dem Quelltext: jeden quotierten String, nicht eine
 * Zeichenklasse erlaubter Zeichen.
 *
 * `/'([a-z-]+)'/g` stand bis zum 20.09.2026 in test-i18n.js und verschluckte
 * `zh-Hant` still - ein Code mit Grossbuchstaben fiel einfach aus der Liste.
 * Gefaehrlich daran ist nicht der Verlust, sondern die Symmetrie: liest ein
 * Guard BEIDE Seiten durch denselben engen Leser, verlieren beide denselben
 * Eintrag und der Vergleich bleibt gruen. Hier liest deshalb nur die
 * lang-init-Seite Text; die i18n-Seite kommt aus dem Modul selbst.
 */
function parseQuotedList(literal) {
  return (literal.match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1));
}

function langInitSupported(src = SRC) {
  const treffer = src.match(/var SUPPORTED = \[([^\]]*)\]/);
  assert.ok(treffer, 'SUPPORTED nicht in public/lang-init.js gefunden');
  return parseQuotedList(treffer[1]);
}

function i18nRtlLocales() {
  const treffer = I18N_SRC.match(/const RTL_LOCALES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(treffer, 'RTL_LOCALES nicht in public/i18n.js gefunden');
  const codes = parseQuotedList(treffer[1]);
  assert.ok(codes.length > 0, 'RTL_LOCALES wurde leer gelesen - der Test waere gruen ueber nichts');
  return new Set(codes);
}

test('der Leser von SUPPORTED verschluckt keinen Code', () => {
  assert.deepEqual(
    langInitSupported("  var SUPPORTED = ['de', 'fil', 'zh-Hant', 'pt-BR'];"),
    ['de', 'fil', 'zh-Hant', 'pt-BR'],
    'Ein Code mit Bindestrich oder Grossbuchstaben faellt aus dem Vergleich, und '
    + 'der Gleichstand darunter waere gruen, weil ihn beide Seiten verloren haben.',
  );
});

test('lang-init.js und i18n.js fuehren dieselbe Sprachliste', () => {
  assert.deepEqual(langInitSupported(), getSupportedLocales(),
    'public/lang-init.js kennt andere Sprachen als public/i18n.js. Eine Sprache, '
    + 'die nur i18n.js kennt, bekommt beim ersten Paint ein falsches lang-Attribut '
    + 'auf einen bereits uebersetzten Body - genau der Fall von `fil` (#1324).');
});

test('lang-init.js setzt die Schreibrichtung fuer dieselben Sprachen wie i18n.js', () => {
  const rtl = i18nRtlLocales();
  for (const locale of getSupportedLocales()) {
    assert.equal(runLangInitState({ stored: locale, languages: [] }).dir,
      rtl.has(locale) ? 'rtl' : 'ltr',
      `lang-init.js setzt fuer ${locale} eine andere Schreibrichtung als RTL_LOCALES in i18n.js.`);
  }
});

// --- Aufloesung auf die spezifischste Locale --------------------------------
//
// Gemessen wird mit Listen, die es im Repository nicht gibt. Ueber den echten
// Bestand - 24 reine Sprachcodes - liefern die alte und die neue Aufloesung
// dasselbe Ergebnis, ein Test darueber misst also nichts. Deshalb nimmt
// pickLocale() die Liste als Argument.

test('i18n.js loest ein Regions-Tag auf die spezifischste unterstuetzte Locale auf', () => {
  const mitHant = ['de', 'en', 'zh', 'zh-Hant'];
  const ohneHant = ['de', 'en', 'zh'];

  assert.equal(pickLocale(['zh-TW'], mitHant), 'zh-Hant',
    'Ein taiwanisches System meldet `zh-TW`, nie `zh-Hant`. Ohne die Zuordnung '
    + 'Region -> Schrift waere eine traditionelle Locale nur ueber den manuellen '
    + 'Waehler erreichbar, nie automatisch.');
  assert.equal(pickLocale(['zh-TW'], ohneHant), 'zh',
    'Solange es die Schrift-Locale nicht gibt, bleibt die Basissprache die Antwort.');
  assert.equal(pickLocale(['zh-CN'], mitHant), 'zh',
    'Unser `zh` ist Vereinfacht - `CN` darf keine traditionelle Schrift implizieren.');
  assert.equal(pickLocale(['zh-CN'], ohneHant), 'zh');
  assert.equal(pickLocale(['zh-Hant-TW'], mitHant), 'zh-Hant');
  assert.equal(pickLocale(['zh-Hant-TW'], ohneHant), 'zh',
    'Der letzte Subtag faellt weg, bis etwas passt: zh-Hant-TW > zh-Hant > zh.');
  assert.equal(pickLocale(['ZH-hant-tw'], mitHant), 'zh-Hant',
    'Ein Browser darf beliebig schreiben; verglichen wird gegen die kanonische Form.');
  assert.equal(pickLocale(['th-TH', 'zh-TW'], mitHant), 'zh-Hant',
    'Die Reihenfolge von navigator.languages entscheidet, nicht die Laenge des Tags.');
  assert.equal(pickLocale(['th-TH'], mitHant), 'en');
  assert.equal(pickLocale([], mitHant), 'en');
});

test('keine der 24 Sprachen loest anders auf als bisher', () => {
  const alle = getSupportedLocales();
  for (const locale of alle) {
    assert.equal(pickLocale([locale], alle), locale, `${locale} findet sich selbst nicht mehr`);
  }
  assert.equal(pickLocale(['de-AT'], alle), 'de');
  assert.equal(pickLocale(['pt-BR'], alle), 'pt');
  assert.equal(pickLocale(['en-US'], alle), 'en');
  assert.equal(pickLocale(['fil-PH'], alle), 'fil');
  assert.equal(pickLocale(['zh-TW'], alle), 'zh',
    'Ohne eine traditionelle Locale im Bestand bleibt `zh` die Antwort.');
  assert.equal(pickLocale(['th-TH'], alle), 'en');
  assert.equal(pickLocale(['th-TH', 'nl-BE'], alle), 'nl');
});

test('lang-init.js loest dieselben Tags auf wie i18n.js', () => {
  const alle = getSupportedLocales();
  for (const tag of ['zh-TW', 'zh-CN', 'de-AT', 'pt-BR', 'th-TH', 'en-US', 'fil-PH',
    'fil', 'ZH-hant-TW', 'ar-EG', 'fa-IR', 'id-ID', 'xx-YY', '']) {
    assert.equal(runLangInit({ languages: [tag] }), pickLocale([tag], alle),
      `Die beiden Fassungen der Resolve-Logik beantworten ${tag || '(leer)'} verschieden. `
      + 'Der Body rendert dann in der einen Sprache und das lang-Attribut nennt die andere.');
  }
});

/**
 * Setzt eine andere Sprachliste in den Quelltext ein.
 *
 * Die Liste ist eine Konstante in einer IIFE - kein Export, kein Import, und das
 * soll so bleiben: ein Testhaken in einem render-blockierenden <head>-Skript
 * waere Ballast auf dem kritischen Pfad jeder Seite. Gemessen wird deshalb der
 * ECHTE Quelltext mit ausgetauschter Eingabe, nicht ein Nachbau der Logik.
 *
 * Damit die Ersetzung nicht still danebengeht und der Test dann ueber die echten
 * 24 Codes gruen ist, prueft jeder Aufrufer zuerst eine Antwort, die nur mit der
 * eingesetzten Liste herauskommen kann.
 */
function withSupported(locales) {
  const literal = `var SUPPORTED = [${locales.map((l) => `'${l}'`).join(', ')}];`;
  const ersetzt = SRC.replace(/var SUPPORTED = \[[^\]]*\];/, literal);
  assert.notEqual(ersetzt, SRC, 'Das SUPPORTED-Literal in lang-init.js wurde nicht gefunden');
  return ersetzt;
}

test('lang-init.js loest zh-TW auf zh-Hant auf, sobald es diese Locale gibt', () => {
  const mitHant = withSupported(['de', 'en', 'zh', 'zh-Hant']);
  assert.equal(runLangInit({ languages: ['zh-Hant'], src: mitHant }), 'zh-Hant',
    'Die eingesetzte Liste wirkt nicht - alles darunter waere ueber dem echten Bestand gemessen.');
  assert.equal(runLangInit({ languages: ['zh-TW'], src: mitHant }), 'zh-Hant');
  assert.equal(runLangInit({ languages: ['zh-CN'], src: mitHant }), 'zh');
  assert.equal(runLangInit({ languages: ['zh-Hant-TW'], src: mitHant }), 'zh-Hant');

  const ohneHant = withSupported(['de', 'en', 'zh']);
  assert.equal(runLangInit({ languages: ['zh-TW'], src: ohneHant }), 'zh');
  assert.equal(runLangInit({ languages: ['zh-CN'], src: ohneHant }), 'zh');
});
