import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createInstallerServer } from '../tools/installer/install-server.js';
import { SUPPORTED_LOCALES, resolveLocale } from '../tools/installer/i18n-mini.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOCALES_DIR = new URL('../tools/installer/locales/', import.meta.url);
const HTML_PATH = new URL('../tools/installer/install.html', import.meta.url);
const REFERENCE = 'de';

function loadLocale(locale) {
  return JSON.parse(readFileSync(new URL(`${locale}.json`, LOCALES_DIR), 'utf8'));
}

/** Verschachteltes Objekt zu Dot-Notation-Schlüsselmenge abflachen. */
function flattenKeys(obj, prefix = '', out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenKeys(v, key, out);
    else out.add(key);
  }
  return out;
}

// Dieselbe Zusicherung wie für die App-Locales (test/test-i18n.js), nur mit der
// Einrückung, die HIER gilt: die Installer-Locales stehen auf ZWEI Leerzeichen.
//
// Sie stand dort bis zum 2026-08-20 als Stichprobe über Zeile 2 und übersah damit
// acht völlig uneingerückte Zeilen in allen 24 App-Locales. Hier gab es die Prüfung
// bisher gar nicht - die Dateien sind sauber, aber nichts hielt sie dabei. Da beide
// Verzeichnisse von denselben Skripten und Händen gepflegt werden, gilt die Regel
// an beiden Enden oder an keinem.
test('jede Installer-Locale ist Zeile für Zeile 2-Leerzeichen-formatiert', () => {
  const wrong = [];
  for (const locale of SUPPORTED_LOCALES) {
    const raw = readFileSync(new URL(`${locale}.json`, LOCALES_DIR), 'utf8');
    const canonical = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
    if (raw === canonical) continue;
    const a = raw.split('\n');
    const b = canonical.split('\n');
    const i = a.findIndex((line, n) => line !== b[n]);
    wrong.push(`${locale}.json Zeile ${i + 1}: ${JSON.stringify(a[i])} statt ${JSON.stringify(b[i])}`);
  }
  assert.deepEqual(wrong, [], `nicht kanonisch 2-Leerzeichen-formatiert:\n  ${wrong.join('\n  ')}`);
});

/** Alle in install.html referenzierten i18n-Schlüssel (Attribute, t(), applyRich). */
function referencedKeys() {
  const html = readFileSync(HTML_PATH, 'utf8');
  const attr = [...html.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)].map(m => m[1]);
  const calls = [...html.matchAll(/\bt\('([^']+)'/g)].map(m => m[1]);
  const rich = [...html.matchAll(/applyRich\([^,]+,\s*'([^']+)'/g)].map(m => m[1]);
  return new Set([...attr, ...calls, ...rich]);
}

const referenceKeys = flattenKeys(loadLocale(REFERENCE));

// ── Locale-Dateien vollständig & schlüsselidentisch ──────────────────────────

test('für jede unterstützte Locale existiert genau eine Locale-Datei', () => {
  const files = readdirSync(new URL(LOCALES_DIR)).filter(f => f.endsWith('.json')).sort();
  // Erst abbilden, dann sortieren: `pt-BR.json` steht vor `pt.json` ('-' < '.'),
  // der Code `pt-BR` aber hinter `pt`.
  assert.deepEqual(files, [...SUPPORTED_LOCALES].map(l => `${l}.json`).sort());
});

for (const locale of SUPPORTED_LOCALES) {
  test(`${locale}.json ist schlüsselidentisch zur Referenz ${REFERENCE}.json`, () => {
    const keys = flattenKeys(loadLocale(locale));
    const missing = [...referenceKeys].filter(k => !keys.has(k));
    const extra = [...keys].filter(k => !referenceKeys.has(k));
    assert.deepEqual(missing, [], `${locale}.json fehlen Schlüssel: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${locale}.json hat überzählige Schlüssel: ${extra.join(', ')}`);
  });
}

// ── install.html ⇄ Locales ───────────────────────────────────────────────────

test('install.html enthält i18n-Schlüssel (data-i18n vorhanden)', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const count = (html.match(/data-i18n/g) || []).length;
  assert.ok(count > 0, 'keine data-i18n-Attribute in install.html gefunden');
});

test('jeder in install.html referenzierte Schlüssel existiert in der Referenz', () => {
  const used = referencedKeys();
  const unknown = [...used].filter(k => !referenceKeys.has(k));
  assert.deepEqual(unknown, [], `Unbekannte Schlüssel in install.html: ${unknown.join(', ')}`);
});

test('jeder in install.html referenzierte Schlüssel existiert in jeder Locale', () => {
  const used = referencedKeys();
  for (const locale of SUPPORTED_LOCALES) {
    const keys = flattenKeys(loadLocale(locale));
    const missing = [...used].filter(k => !keys.has(k));
    assert.deepEqual(missing, [], `${locale}.json fehlen genutzte Schlüssel: ${missing.join(', ')}`);
  }
});

// ── Auslieferung über den Installer-Server ────────────────────────────────────

async function withServer(fn) {
  const prev = process.env.OIKOS_INSTALLER_ROOT;
  process.env.OIKOS_INSTALLER_ROOT = REPO_ROOT;
  const server = createInstallerServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(r => server.close(r));
    if (prev === undefined) delete process.env.OIKOS_INSTALLER_ROOT;
    else process.env.OIKOS_INSTALLER_ROOT = prev;
  }
}

test('GET /i18n-mini.js liefert 200 + JavaScript', async () => {
  await withServer(async base => {
    const r = await fetch(`${base}/i18n-mini.js`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.match(await r.text(), /export function t\(/);
  });
});

test('GET /locales/<locale>.json liefert 200 + JSON für jede Locale', async () => {
  await withServer(async base => {
    for (const locale of SUPPORTED_LOCALES) {
      const r = await fetch(`${base}/locales/${locale}.json`);
      assert.equal(r.status, 200, `/locales/${locale}.json lieferte ${r.status}`);
      assert.match(r.headers.get('content-type'), /application\/json/);
      const body = await r.json();
      assert.ok(body.title, `${locale}.json hat keinen title-Schlüssel`);
    }
  });
});

test('GET /locales/* lehnt Path-Traversal und Nicht-JSON mit 404 ab', async () => {
  await withServer(async base => {
    for (const path of ['/locales/../install.html', '/locales/nope.json', '/locales/de.txt']) {
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 404, `${path} hätte 404 liefern müssen`);
    }
  });
});

// ── Regel-Guard: kein Locale-Wert besteht nur aus Zeichensetzung ─────────────
//
// `common.generating` stand in allen 23 Sprachen woertlich auf "…". Der
// Generieren-Button setzt diesen Wert als textContent, verlor damit fuer die
// Dauer der Operation seinen zugaenglichen Namen und wurde als
// "Auslassungspunkte, Schaltflaeche, deaktiviert" vorgelesen.
//
// Der Keyset-Guard darueber konnte das nicht sehen: der Schluessel WAR in jeder
// Sprache vorhanden, nur ohne Inhalt. Ein Wert ohne einen einzigen Buchstaben
// oder eine Ziffer ist keine Uebersetzung, sondern ein Platzhalter, der es in
// den Bestand geschafft hat.
test('kein Locale-Wert besteht ausschliesslich aus Zeichensetzung', () => {
  // \p{L} deckt jedes Alphabet ab (kyrillisch, arabisch, CJK), \p{N} Ziffern.
  // Emoji und Haken duerfen begleiten, aber nicht die ganze Aussage tragen.
  const hasContent = (value) => /[\p{L}\p{N}]/u.test(value);
  const offenders = [];

  for (const locale of SUPPORTED_LOCALES) {
    const walk = (obj, prefix = '') => {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
        else if (typeof v === 'string' && v.length > 0 && !hasContent(v)) {
          offenders.push(`${locale}: ${key} = ${JSON.stringify(v)}`);
        }
      }
    };
    walk(loadLocale(locale));
  }

  assert.deepEqual(offenders, [],
    'Diese Werte enthalten keinen einzigen Buchstaben und keine Ziffer. Steht so '
    + 'einer auf einem Button, hat das Element keinen Namen mehr:\n' + offenders.join('\n'));
});

test('der Generieren-Button traegt waehrend der Operation einen Namen und haengt nicht', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  // Der Zustand muss angesagt werden, nicht nur bebildert.
  assert.match(html, /btn\.setAttribute\('aria-busy', 'true'\)/,
    'der Generieren-Button meldet seinen Betriebszustand nicht');
  // Ohne finally blieb der Button nach einem Fehlschlag dauerhaft deaktiviert
  // und im Ersatztext stehen: der Schritt war nur per Reload verlassbar.
  assert.match(html, /\} finally \{[\s\S]*?btn\.disabled = false;[\s\S]*?btn\.textContent = t\('common\.generate'\);/,
    'der Generieren-Button wird nicht in jedem Fall zurueckgesetzt');
});

test('Zahlenbereiche in Fehlermeldungen sind mit ASCII-Minus geschrieben', () => {
  // "Ungültiger Breitengrad (–90 bis 90)" nannte in 19 Sprachen einen Wert, den
  // das Feld gar nicht annimmt: <input type="number"> kennt nur ASCII-Minus.
  // Wer die Zahl aus der Meldung kopierte, bekam dieselbe Meldung erneut.
  //
  // Die Regel trifft nur Striche, die unmittelbar an einer Ziffer kleben -
  // Vorzeichen und Bis-Striche. Der Gedankenstrich als Satzzeichen ist davon
  // unberührt: er trägt in ru, uk, fr, ja und zh die Satzstruktur und bleibt.
  const offenders = [];
  for (const locale of SUPPORTED_LOCALES) {
    const walk = (obj, prefix = '') => {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
        else if (typeof v === 'string' && /[–—](?=[0-9])/u.test(v)) {
          offenders.push(`${locale}: ${key} = ${JSON.stringify(v)}`);
        }
      }
    };
    walk(loadLocale(locale));
  }
  assert.deepEqual(offenders, [],
    'En-/Em-Dash direkt vor einer Ziffer ist ein Vorzeichen oder Bis-Strich und '
    + 'gehört als ASCII "-" geschrieben:\n' + offenders.join('\n'));
});

/* Ein data-i18n-Attribut auf einem Schluessel MIT Platzhalter ist immer kaputt.
 *
 * applyTranslations ruft `t(key)` ohne Parameter und schreibt das Ergebnis in
 * textContent. Traegt der Wert ein {{...}}, landet der Platzhalter woertlich auf
 * dem Bildschirm - und zwar erst beim Sprachwechsel, weil der Text bis dahin von
 * der Laufzeit korrekt gesetzt war. Genau deshalb faellt es beim Bauen nicht auf.
 *
 * Dreimal derselbe Fehler an drei Stellen (cfg-prereq, welcome-prereq,
 * simple-access-desc, Critique 2026-08-15) sind kein Zufall mehr, sondern eine
 * fehlende Regel: solche Elemente werden ueber applyRich() oder einen eigenen
 * t()-Aufruf in localize() versorgt und tragen KEIN data-i18n. */
test('kein data-i18n zeigt auf einen Schluessel mit Platzhalter', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const reference = loadLocale(REFERENCE);
  const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), reference);

  const offenders = [];
  for (const [, key] of html.matchAll(/\bdata-i18n="([^"]+)"/g)) {
    const value = lookup(key);
    if (typeof value === 'string' && /\{\{\w+\}\}/.test(value)) {
      offenders.push(`${key} -> "${value}"`);
    }
  }
  assert.deepEqual(offenders, [],
    `data-i18n auf interpolierten Schluesseln (applyTranslations kann sie nicht fuellen): ${offenders.join(' | ')}`);
});

/* Der Sprachumschalter bietet GENAU die unterstuetzten Sprachen an.
 *
 * `fil` fehlte in der Optionsliste, obwohl SUPPORTED_LOCALES es fuehrt und
 * fil.json ausgeliefert wird (Critique 2026-08-15). Folge: bei einem
 * philippinischen Browser stand `$('lang-switch').value = getLocale()` auf einem
 * Wert ohne Option, der Umschalter war LEER - und wer einmal wechselte, kam nie
 * zurueck. Die vorhandenen Tests pruefen Dateibestand, Keyparitaet, Auslieferung
 * und Platzhalter; die Optionsliste hat nie jemand gegen die Sprachliste
 * gehalten, obwohl sie die einzige Stelle ist, an der der Nutzer sie sieht. */
test('der Sprachumschalter bietet genau die unterstuetzten Sprachen an', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const select = html.match(/<select id="lang-switch"[\s\S]*?<\/select>/);
  assert.ok(select, 'lang-switch nicht gefunden');

  const offered = [...select[0].matchAll(/<option value="([^"]+)"/g)].map(m => m[1]).sort();
  const supported = [...SUPPORTED_LOCALES].sort();

  assert.deepEqual(offered, supported,
    `Optionsliste weicht von SUPPORTED_LOCALES ab. Nur im Select: ${offered.filter(l => !supported.includes(l))}; `
    + `nur in SUPPORTED_LOCALES: ${supported.filter(l => !offered.includes(l))}`);
});

// Der Web-Installer loest wie die App auf: erst der volle Tag, dann die
// Basissprache. Er nahm bisher nur den Teil vor dem ersten Bindestrich, und ein
// brasilianischer Browser bekam `pt` (#1437).
test('resolveLocale nimmt erst den vollen Tag, dann die Basissprache', () => {
  assert.equal(resolveLocale(['pt-BR']), 'pt-BR');
  assert.equal(resolveLocale(['pt-br']), 'pt-BR');
  assert.equal(resolveLocale(['pt-PT']), 'pt');
  assert.equal(resolveLocale(['pt']), 'pt');
  assert.equal(resolveLocale(['de-AT']), 'de');
  assert.equal(resolveLocale(['fil-PH']), 'fil');
  assert.equal(resolveLocale(['nb-NO']), 'nb');
  assert.equal(resolveLocale(['th-TH', 'nl-BE']), 'nl');
  assert.equal(resolveLocale(['th-TH']), 'en');
});

// `no` ist die Makrosprache, die ein norwegischer Browser haeufig meldet, `nn`
// (Nynorsk) hat keine eigene Datei. Beide bekamen den Installer auf Englisch.
test('resolveLocale: `no` und `nn` fallen auf `nb`', () => {
  for (const tag of ['no', 'no-NO', 'NO-no', 'nn', 'nn-NO']) {
    assert.equal(resolveLocale([tag]), 'nb', tag);
  }
  assert.equal(resolveLocale(['nn-NO', 'de']), 'nb');
  assert.equal(resolveLocale(['th-TH', 'no']), 'nb');
});

/* Die Sprache, die der Installer als `language` an /api/v1/auth/setup reicht,
 * muss die App kennen - in BEIDE Richtungen gemessen.
 *
 * Die App nimmt nur Codes aus getSupportedLocales() an (server/utils/i18n.js),
 * und die kommen aus den Dateinamen in public/locales/ - Kurzcodes wie `de`,
 * `pt`, `fil`. Hiesse eine Installer-Locale einmal `pt-BR` oder `zh-Hans`,
 * waehrend die App `pt`/`zh` fuehrt, bekaeme genau dieser Haushalt still eine
 * englische Datensprache (der Proxy wiederholt nach einem 400 ohne Sprache).
 * Gelesen wird die echte Funktion, nicht eine abgeschriebene Liste: kommt in
 * der App eine Sprache dazu, faellt die Rueckrichtung hier auf. */
test('jede Installer-Sprache ist eine App-Sprache, und umgekehrt', async () => {
  const { getSupportedLocales } = await import('../server/utils/i18n.js');
  const { SETUP_LANGUAGES, setupLanguage } = await import('../tools/installer/install-server.js');
  const app = getSupportedLocales();
  assert.ok(app.length >= 2, `getSupportedLocales() lieferte nur ${app} - der Leser greift nicht`);

  const installer = [...SETUP_LANGUAGES].sort();
  assert.deepEqual(installer, [...SUPPORTED_LOCALES].sort(),
    'die Allowlist des Proxys muss aus den Installer-Locales kommen');

  const unknownToApp = installer.filter(l => !app.includes(l));
  assert.deepEqual(unknownToApp, [],
    `Installer-Sprachen, die /auth/setup mit 400 ablehnen wuerde: ${unknownToApp}. `
    + 'Code auf den App-Code abbilden (setupLanguage) statt ihn roh weiterzureichen.');
  const missingInInstaller = app.filter(l => !installer.includes(l));
  assert.deepEqual(missingInInstaller, [],
    `App-Sprachen ohne Installer-Locale: ${missingInInstaller} - wer sie spricht, kann sie im Wizard nicht waehlen.`);

  for (const l of installer) assert.equal(setupLanguage(l), l, `${l} muss unveraendert durchgehen`);
});

/* Begriffe, die der Installer mit der App teilt, heissen in jeder Sprache wie
 * in der App - der Nutzer sucht sie dort wieder. Gelesen aus public/locales,
 * nicht abgeschrieben: benennt die App einen Begriff um, faellt es hier auf.
 * Anlass (Critique 2026-09-29): "Module waehlen" fuehrte auf das Blatt "Aktive
 * Module", "Single Sign-On" hiess in der App "Single Sign-on", und der
 * deutsche Installer sagte "Dokumentspeicher" und "Passwort-Reset". */
/* Bewusste Ausnahme mit Verfallsdatum an BEIDEN Enden: die nl-Pruefzeile sagt
 * "Single sign-on", die App "Eenmalige aanmelding" (die Ueberschrift im
 * Erweitert-Schritt ist schon angeglichen). Die Angleichung senkt die Zahl
 * englischer Werte in nl - und test/test-i18n-translated.js verlangt dann,
 * dass test/i18n-translated-baseline.json mitsinkt. Die Datei liegt ausserhalb
 * dessen, was der Installer-Zweig bis zum Release aendern darf (main ist
 * eingefroren). Folge-Ticket: nl angleichen UND die Baseline senken, dann
 * diesen Eintrag loeschen. Faellt rot, sobald nl von selbst passt. */
const SSO_TERM_PENDING = { nl: 'Single sign-on' };

test('geteilte Begriffe heissen wie in der App', () => {
  const appLocale = locale => JSON.parse(readFileSync(new URL(`../public/locales/${locale}.json`, import.meta.url), 'utf8'));
  for (const [locale, value] of Object.entries(SSO_TERM_PENDING)) {
    assert.notEqual(appLocale(locale).settings.oidcLinkTitle, value,
      `${locale}: die App sagt inzwischen selbst "${value}" - Ausnahme loeschen`);
    assert.equal(loadLocale(locale).review.oidc, value,
      `${locale}: review.oidc ist angeglichen - Ausnahme in SSO_TERM_PENDING loeschen`);
  }
  for (const locale of SUPPORTED_LOCALES) {
    const inst = loadLocale(locale);
    const app = appLocale(locale).settings;
    assert.equal(inst.done.nextModules, app.pageActiveModules,
      `${locale}: der Link auf die aktiven Module heisst anders als das Blatt in der App`);
    assert.ok(inst.advanced.oidc.startsWith(app.oidcLinkTitle),
      `${locale}: advanced.oidc "${inst.advanced.oidc}" beginnt nicht mit dem App-Begriff "${app.oidcLinkTitle}"`);
    if (locale in SSO_TERM_PENDING) continue;
    assert.equal(inst.review.oidc, app.oidcLinkTitle, `${locale}: review.oidc weicht vom App-Begriff ab`);
  }
  const de = JSON.stringify(loadLocale('de'));
  assert.doesNotMatch(de, /Dokumentspeicher/, 'de: "Dokumentspeicher" statt "Dokumentenspeicher" (App)');
  assert.doesNotMatch(de, /Passwort-Reset/, 'de: "Passwort-Reset" statt "Passwort zuruecksetzen" (App)');
  assert.match(loadLocale('de').storage.sectionDocuments, new RegExp(appLocale('de').settings.pageDocumentStorage));
});
