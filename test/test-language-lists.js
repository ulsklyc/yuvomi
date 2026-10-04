/**
 * Sprachlisten ausserhalb von SUPPORTED_LOCALES (#1523).
 *
 * Drei Stellen im Server hielten eine eigene Liste der App-Sprachen, und keine
 * wuchs mit, als Sprachen dazukamen: die Budget-Kategorien (19 Codes, alles
 * andere bekam Englisch), die OpenAPI-Beschreibung von `lang` (15 Codes, gueltige
 * Sprachen standen dort als ungueltig) und der Wetter-Proxy, der den App-Code
 * unveraendert an OpenWeatherMap gab - OWM schreibt Koreanisch `kr`, Tschechisch
 * `cz` und Brasilianisch `pt_br`, und Unbekanntes beantwortet es auf Englisch.
 *
 * Die Gegenseite liest diese Suite aus public/i18n.js, NICHT aus
 * getSupportedLocales(): Budget und OpenAPI leiten ihre Werte jetzt von dort ab,
 * und ein Vergleich gegen dieselbe Funktion waere ein Vergleich mit sich selbst.
 * Dass getSupportedLocales() und SUPPORTED_LOCALES uebereinstimmen, haelt
 * test:i18n.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutCommentsKeepingLines } from './source-text.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// Derselbe Leser wie in test:i18n: jeder quotierte String, keine Zeichenklasse,
// die einen Code mit Grossbuchstaben (`pt-BR`) still verschlucken koennte.
function parseSupportedLocales(src) {
  const match = src.match(/const SUPPORTED_LOCALES = \[([^\]]+)\]/);
  assert.ok(match, 'SUPPORTED_LOCALES nicht in public/i18n.js gefunden');
  return match[1].match(/'([^']*)'/g).map((s) => s.slice(1, -1));
}

const APP_LOCALES = parseSupportedLocales(readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8'));
const sorted = (list) => [...list].sort();

test('der Leser findet die App-Sprachen samt Region', () => {
  assert.ok(APP_LOCALES.length >= 20, `nur ${APP_LOCALES.length} Codes gelesen`);
  assert.ok(APP_LOCALES.includes('pt-BR'), 'pt-BR fehlt - der Leser verschluckt Grossbuchstaben');
  assert.ok(APP_LOCALES.includes('fil'), 'fil fehlt');
});

// ── Budget ──────────────────────────────────────────────────────────

test('Budget: jede App-Sprache beschriftet ihre Kategorien selbst', async () => {
  const { normalizeLang, budgetMessages } = await import('../server/routes/budget/helpers.js');
  const aufEnglisch = APP_LOCALES.filter((locale) => normalizeLang(locale) !== locale);
  assert.deepEqual(aufEnglisch, [],
    `Diese App-Sprachen bekommen Budget-Kategorien in einer anderen Sprache: ${aufEnglisch.join(', ')}`);
  // Und die Datei dahinter laedt wirklich - normalizeLang() allein sagt nur, welcher Name gilt.
  for (const locale of APP_LOCALES) {
    assert.equal(typeof budgetMessages(locale).catHousing, 'string', `${locale}: budget.catHousing fehlt`);
  }
});

test('Budget: Tags mit Region und fremder Schreibung finden ihre Sprache, Unbekanntes faellt auf Englisch', async () => {
  const { normalizeLang } = await import('../server/routes/budget/helpers.js');
  const faelle = [
    ['pt-BR', 'pt-BR'], ['pt_br', 'pt-BR'], ['PT-br', 'pt-BR'], ['pt-PT', 'pt'],
    ['de-AT', 'de'], ['DE', 'de'], [' nb ', 'nb'], ['zh-Hant-TW', 'zh'], ['es-419', 'es'],
    ['xx', 'en'], ['', 'en'], [undefined, 'en'], [['de'], 'en'], ['../de', 'en'], ['de/../en', 'en'],
    // `no` (Makrosprache) und `nn` (Nynorsk) meinen die norwegische Datei.
    ['no', 'nb'], ['no-NO', 'nb'], ['NO_no', 'nb'], ['nn', 'nb'], ['nn-NO', 'nb'],
  ];
  for (const [eingabe, erwartet] of faelle) {
    assert.equal(normalizeLang(eingabe), erwartet, `normalizeLang(${JSON.stringify(eingabe)})`);
  }
});

// ── OpenAPI ─────────────────────────────────────────────────────────

test('OpenAPI: `lang` nennt genau die App-Sprachen', async () => {
  const { buildOpenApiSpec } = await import('../server/openapi.js');
  const spec = buildOpenApiSpec({});
  const langParams = [];
  for (const [route, ops] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(ops)) {
      for (const param of operation?.parameters ?? []) {
        if (param.name === 'lang' && param.in === 'query') langParams.push({ where: `${method.toUpperCase()} ${route}`, param });
      }
    }
  }
  assert.ok(langParams.length >= 2, `nur ${langParams.length} lang-Parameter gefunden - liest der Test die Spec noch?`);

  for (const { where, param } of langParams) {
    assert.deepEqual(sorted(param.schema.enum), sorted(APP_LOCALES), `${where}: lang-Enum weicht von SUPPORTED_LOCALES ab`);
    const genannt = param.description.match(/Supported values: ([^.]+)\./)?.[1].split(', ') ?? [];
    assert.deepEqual(sorted(genannt), sorted(APP_LOCALES), `${where}: die Beschreibung nennt andere Sprachen als das Enum`);
    assert.ok(param.schema.enum.includes(param.schema.default), `${where}: Default ${param.schema.default} nicht im Enum`);
  }
});

// ── OpenWeatherMap ──────────────────────────────────────────────────

test('OWM: jede App-Sprache ist abgebildet oder bewusst auf Englisch gesetzt', async () => {
  const { OWM_LANG_BY_LOCALE } = await import('../server/routes/weather.js');
  const fehlt = APP_LOCALES.filter((locale) => !Object.hasOwn(OWM_LANG_BY_LOCALE, locale));
  assert.deepEqual(fehlt, [],
    `Ohne Zeile in OWM_LANG_BY_LOCALE (server/routes/weather.js): ${fehlt.join(', ')}. `
    + 'Den OWM-Code aus https://openweathermap.org/current#multi eintragen oder null, wenn OWM die Sprache nicht kennt.');
  const ueberzaehlig = Object.keys(OWM_LANG_BY_LOCALE).filter((locale) => !APP_LOCALES.includes(locale));
  assert.deepEqual(ueberzaehlig, [], `OWM_LANG_BY_LOCALE fuehrt Sprachen, die die App nicht hat: ${ueberzaehlig.join(', ')}`);
});

test('OWM: jedes Ziel der Zuordnung ist ein Code der Anbieter-Liste', async () => {
  const { OWM_LANG_BY_LOCALE, OWM_LANGUAGES } = await import('../server/routes/weather.js');
  const unbekannt = Object.entries(OWM_LANG_BY_LOCALE)
    .filter(([, code]) => code !== null && !OWM_LANGUAGES.has(code))
    .map(([locale, code]) => `${locale} -> ${code}`);
  assert.deepEqual(unbekannt, [], `Ziel nicht in OWM_LANGUAGES: ${unbekannt.join(', ')}`);
});

test('OWM: owmLanguage() bildet ab, laesst OWM-Codes durch und sonst nichts in die URL', async () => {
  const { owmLanguage } = await import('../server/routes/weather.js');
  const faelle = [
    ['pt-BR', 'pt_br'], ['zh', 'zh_cn'], ['ko', 'kr'], ['cs', 'cz'], ['nb', 'no'], ['uk', 'uk'], ['de', 'de'],
    ['fil', null],                       // OWM kennt kein Filipino
    ['zh_tw', 'zh_tw'], ['ZH_CN', 'zh_cn'], ['ua', 'ua'],   // OPENWEATHER_LANG traegt OWM-Codes
    ['de-AT', 'de'], ['pt_BR', 'pt_br'],
    ['no', 'no'],                        // schon ein OWM-Code, geht wie geschrieben
    ['nn', 'no'], ['nn-NO', 'no'], ['no-NO', 'no'],   // ueber den Alias auf nb, und nb heisst bei OWM `no`
    ['xx', null], ['', null], [undefined, null], [['de'], null], ['de&appid=x', null],
  ];
  for (const [eingabe, erwartet] of faelle) {
    assert.equal(owmLanguage(eingabe), erwartet, `owmLanguage(${JSON.stringify(eingabe)})`);
  }
});

// ── Keine weitere Kopie ─────────────────────────────────────────────

// Eine Liste ist erkennbar an mehreren App-Codes hintereinander als Literale.
// Vier reichen: die OWM-Codeliste in weather.js traegt hoechstens drei App-Codes
// am Stueck (`'fa', 'pl', 'pt'`), die alten Kopien trugen 15 und 19.
// Die zwei Frontend-Listen haben eigene Guards: public/i18n.js IST die Quelle,
// public/lang-init.js haelt test:lang-init an ihr fest; den Installer mit
// i18n-mini.js und install.sh halten test:installer-i18n/-cli-i18n.
const OWN_GUARD = new Set(['public/i18n.js', 'public/lang-init.js', 'tools/installer/i18n-mini.js']);

function* jsFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === 'vendor' || name === 'locales') continue;
    if (statSync(full).isDirectory()) yield* jsFiles(full);
    else if (/\.(m?js)$/.test(name)) yield full;
  }
}

function localeRuns(src, locales, minRun = 4) {
  const code = withoutCommentsKeepingLines(src);
  const funde = [];
  const literal = /(['"])([^'"\n]*)\1/g;
  let lauf = [];
  let ende = -1;
  for (const m of code.matchAll(literal)) {
    const zwischen = ende < 0 ? '' : code.slice(ende, m.index);
    const anschluss = /^\s*,\s*$/.test(zwischen);
    if (locales.includes(m[2]) && (lauf.length === 0 || anschluss)) {
      lauf.push(m[2]);
    } else {
      if (lauf.length >= minRun) funde.push(lauf);
      lauf = locales.includes(m[2]) ? [m[2]] : [];
    }
    ende = m.index + m[0].length;
  }
  if (lauf.length >= minRun) funde.push(lauf);
  return funde;
}

test('der Listen-Detektor sieht eine Kopie und laesst Einzelwerte stehen', () => {
  const locales = ['de', 'en', 'fr', 'pt-BR', 'uk'];
  assert.equal(localeRuns("const X = new Set(['de', 'en', 'fr', 'uk']);", locales).length, 1);
  assert.equal(localeRuns('enum: ["de", "en",\n  "fr", "pt-BR"]', locales).length, 1);
  assert.equal(localeRuns("f('de', 'en', 'fr');", locales).length, 0, 'drei sind noch keine Liste');
  assert.equal(localeRuns("// ['de', 'en', 'fr', 'uk']", locales).length, 0, 'Kommentare zaehlen nicht');
  assert.equal(localeRuns("['de', 'en', 'xx', 'fr', 'uk']", locales).length, 0, 'ein fremder Code bricht die Folge');
});

test('keine weitere Sprachliste in server/, public/ oder tools/', () => {
  const funde = [];
  for (const dir of ['server', 'public', 'tools']) {
    for (const file of jsFiles(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (OWN_GUARD.has(rel)) continue;
      for (const lauf of localeRuns(readFileSync(file, 'utf8'), APP_LOCALES)) {
        funde.push(`${rel}: ${lauf.join(', ')}`);
      }
    }
  }
  assert.deepEqual(funde, [],
    'Eine eigene Liste der App-Sprachen bleibt zurueck, sobald eine Sprache dazukommt (#1523). '
    + 'Im Server getSupportedLocales()/supportedLocaleFor() aus server/utils/i18n.js nehmen.');
});

// ── Sprach-Aliase ───────────────────────────────────────────────────
//
// `no` (Makrosprache Norwegisch) und `nn` (Nynorsk) meinen die Datei `nb`. Fuenf
// Stellen bilden einen Sprach-Tag von aussen auf eine Locale ab, und kein Import
// verbindet sie: public/i18n.js ist ein Browser-Modul, lang-init.js laeuft vor
// jedem Modul, i18n-mini.js gehoert dem Installer, install.sh ist Shell und
// server/utils/i18n.js liegt hinter der Schichtgrenze. Was die einzelne Stelle
// daraus MACHT, messen ihre eigenen Suiten (test:lang-init, test:installer-i18n,
// test:installer-cli-i18n und oben normalizeLang/owmLanguage); hier steht nur,
// dass alle fuenf dieselbe Zuordnung fuehren.

/** `{ no: 'nb', nn: 'nb' }` aus einem JS-Quelltext, als Objekt. */
function readJsAlias(rel) {
  const src = readFileSync(path.join(ROOT, rel), 'utf8');
  const match = src.match(/LANGUAGE_ALIAS = (?:Object\.freeze\()?\{([^}]*)\}/);
  assert.ok(match, `LANGUAGE_ALIAS nicht in ${rel} gefunden`);
  const paare = [...match[1].matchAll(/['"]?([A-Za-z-]+)['"]?\s*:\s*'([^']*)'/g)].map((m) => [m[1], m[2]]);
  assert.ok(paare.length > 0, `LANGUAGE_ALIAS in ${rel} wurde leer gelesen`);
  return Object.fromEntries(paare);
}

/** Dieselbe Zuordnung aus dem `case` von normalize_locale in install.sh. */
function readShellAlias() {
  const sh = readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  const start = sh.indexOf('normalize_locale() {');
  const fn = sh.slice(start, sh.indexOf('\n}\n', start));
  const out = {};
  for (const m of fn.matchAll(/^\s*([a-z|]+)\)\s*alias="([^"]+)"\s*;;/gm)) {
    for (const lang of m[1].split('|')) out[lang] = m[2];
  }
  assert.ok(Object.keys(out).length > 0, 'kein Alias-Zweig in normalize_locale gefunden');
  return out;
}

test('der Alias-Leser verschluckt keinen Eintrag', () => {
  assert.deepEqual(readJsAlias('public/i18n.js'), { no: 'nb', nn: 'nb' },
    'Die Quelle selbst, als Literal: liest der Leser weniger, waere der Gleichstand darunter gruen ueber nichts.');
});

test('alle fuenf Stellen fuehren dieselben Sprach-Aliase', () => {
  const quelle = readJsAlias('public/i18n.js');
  for (const rel of ['public/lang-init.js', 'tools/installer/i18n-mini.js', 'server/utils/i18n.js']) {
    assert.deepEqual(readJsAlias(rel), quelle, `${rel} fuehrt andere Sprach-Aliase als public/i18n.js`);
  }
  assert.deepEqual(readShellAlias(), quelle, 'install.sh fuehrt andere Sprach-Aliase als public/i18n.js');
});

test('ein Alias zeigt auf eine App-Sprache und ueberdeckt keine', () => {
  for (const [von, nach] of Object.entries(readJsAlias('public/i18n.js'))) {
    assert.ok(APP_LOCALES.includes(nach), `${von} -> ${nach}: das Ziel ist keine App-Sprache`);
    // Kein Fehler im Verhalten - der Alias ist ein Rueckfall und kaeme nie zum
    // Zug -, aber toter Text, der beim Lesen wie eine geltende Regel aussieht.
    assert.ok(!APP_LOCALES.includes(von), `${von} hat inzwischen eine eigene Locale, der Alias ist tot`);
  }
});
