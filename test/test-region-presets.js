import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import {
  CUSTOM_REGION,
  REGION_CODES,
  REGION_PRESETS,
  detectRegion,
  resolveRegion,
  numberLocaleFor,
} from '../public/settings/region-presets.js';
import { CURRENCY_CODES } from '../public/utils/currency-codes.js';
import { REGION_TAG, formatUnit, getNumberFormat } from '../public/i18n.js';
import { withoutCommentsKeepingLines } from './source-text.js';
import { withLocales } from './i18n-env.js';
import { isRegionTag, regionLanguage } from '../server/utils/i18n.js';

// Die Formprüfung aus getFormatLocale() wird IMPORTIERT, nicht gespiegelt. Bis
// 20.09.2026 stand hier eine Kopie des Musters, und eine Kopie belegt nur, dass
// jemand sie einmal abgeschrieben hat: wandert das Original, bleibt der Test
// grün und misst die alte Form weiter.
const BCP47_TAG = REGION_TAG;

async function backendList(name) {
  const src = await readFile(
    new URL('../server/routes/preferences.js', import.meta.url),
    'utf8',
  );
  const match = src.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`));
  assert.ok(match, `${name} must be declared in preferences route`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('every region preset maps to backend-valid currency, date and time values', async () => {
  const currencies = CURRENCY_CODES;
  const dateFormats = await backendList('VALID_DATE_FORMATS');
  const timeFormats = await backendList('VALID_TIME_FORMATS');

  for (const [code, preset] of Object.entries(REGION_PRESETS)) {
    assert.ok(currencies.includes(preset.currency), `${code}: invalid currency ${preset.currency}`);
    assert.ok(dateFormats.includes(preset.date_format), `${code}: invalid date_format ${preset.date_format}`);
    assert.ok(timeFormats.includes(preset.time_format), `${code}: invalid time_format ${preset.time_format}`);
  }
});

test('every preset date_format is selectable in the appearance UI', async () => {
  const src = await readFile(
    new URL('../public/settings/pages/personal-appearance.js', import.meta.url),
    'utf8',
  );
  const block = src.match(/const DATE_FORMATS = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'personal-appearance must declare DATE_FORMATS');
  const uiFormats = [...block[1].matchAll(/\['([^']+)'/g)].map((m) => m[1]);

  for (const [code, preset] of Object.entries(REGION_PRESETS)) {
    assert.ok(uiFormats.includes(preset.date_format), `${code}: ${preset.date_format} missing from UI DATE_FORMATS`);
  }
});

test('detectRegion resolves every preset to a code with identical format values', () => {
  // Several regions intentionally share the same currency/date/time triple
  // (e.g. de-DE and de-AT). Since no `region` is persisted, detectRegion only
  // guarantees a representative code whose preset equals the input values.
  for (const code of REGION_CODES) {
    const resolved = detectRegion(REGION_PRESETS[code]);
    assert.ok(REGION_PRESETS[resolved], `${code}: resolved to unknown code ${resolved}`);
    assert.deepEqual(REGION_PRESETS[resolved], REGION_PRESETS[code], `${code}: resolved preset differs`);
  }
});

test('detectRegion falls back to custom for unknown or partial combinations', () => {
  assert.equal(detectRegion({ currency: 'EUR', date_format: 'mdy', time_format: '12h' }), CUSTOM_REGION);
  assert.equal(detectRegion({ currency: 'EUR', date_format: 'dmy' }), CUSTOM_REGION);
  assert.equal(detectRegion({}), CUSTOM_REGION);
  assert.equal(detectRegion(), CUSTOM_REGION);
});

test('resolveRegion keeps the stored region when its preset still matches (#486)', () => {
  // fr-FR and es-ES share the exact same currency/date/time triple. detectRegion
  // alone always returns the first match (es-ES) — the bug behind #486. With a
  // persisted region, resolveRegion must honour the actual selection.
  assert.deepEqual(REGION_PRESETS['fr-FR'], REGION_PRESETS['es-ES']);
  assert.equal(detectRegion(REGION_PRESETS['fr-FR']), 'es-ES');
  assert.equal(resolveRegion({ region: 'fr-FR', ...REGION_PRESETS['fr-FR'] }), 'fr-FR');
  assert.equal(resolveRegion({ region: 'es-ES', ...REGION_PRESETS['es-ES'] }), 'es-ES');
});

test('resolveRegion falls back to detectRegion for stale, empty or unknown region', () => {
  // Stored region no longer matches the persisted formats (manual format change):
  assert.equal(
    resolveRegion({ region: 'fr-FR', currency: 'EUR', date_format: 'dmy', time_format: '24h' }),
    detectRegion({ currency: 'EUR', date_format: 'dmy', time_format: '24h' }),
  );
  // No / empty / unknown region → pure detection:
  assert.equal(resolveRegion({ ...REGION_PRESETS['de-DE'] }), detectRegion(REGION_PRESETS['de-DE']));
  assert.equal(resolveRegion({ region: '', ...REGION_PRESETS['fr-FR'] }), 'es-ES');
  assert.equal(resolveRegion({ region: 'zz-ZZ', ...REGION_PRESETS['fr-FR'] }), 'es-ES');
  assert.equal(resolveRegion(), CUSTOM_REGION);
});

test('numberLocaleFor yields a region tag that drives Intl number grouping (#521)', () => {
  // Kernfall des Issues: Schweizer Region → Tausender-Apostroph + Punkt-Dezimal.
  const chLocale = numberLocaleFor({ region: 'de-CH', ...REGION_PRESETS['de-CH'] });
  assert.equal(chLocale, 'de-CH');
  assert.equal(new Intl.NumberFormat(chLocale).format(123456.78), "123'456.78");
  // Währung: nur die Gruppierung prüfen; das Leerzeichen vor dem Betrag ist je
  // nach ICU-Version ein schmales geschütztes Leerzeichen (U+202F/U+00A0).
  assert.ok(
    new Intl.NumberFormat(chLocale, { style: 'currency', currency: 'CHF' })
      .format(123456.78)
      .includes("123'456.78"),
  );
  // Deutsche Region bleibt beim gewohnten Format (kein Regressionswechsel).
  assert.equal(
    new Intl.NumberFormat(numberLocaleFor({ region: 'de-DE', ...REGION_PRESETS['de-DE'] })).format(123456.78),
    '123.456,78',
  );
});

test('Malaysia preset formats MYR amounts with the local currency symbol', () => {
  const locale = numberLocaleFor({ region: 'ms-MY', ...REGION_PRESETS['ms-MY'] });
  const formatted = new Intl.NumberFormat(locale, { style: 'currency', currency: 'MYR' })
    .format(1234.56);

  assert.equal(locale, 'ms-MY');
  assert.ok(formatted.includes('RM'));
  assert.ok(formatted.includes('1,234.56'));
});

test('New Zealand preset uses NZD and local number formatting', () => {
  const locale = numberLocaleFor({ region: 'en-NZ', ...REGION_PRESETS['en-NZ'] });
  const formatted = new Intl.NumberFormat(locale, { style: 'currency', currency: 'NZD' })
    .format(1234.56);

  assert.equal(locale, 'en-NZ');
  assert.ok(formatted.includes('$'));
  assert.ok(formatted.includes('1,234.56'));
});

test('numberLocaleFor derives the tag even without a stored region, and empties for custom', () => {
  // Region nicht gesetzt, aber Formate entsprechen einem Preset → abgeleiteter Tag.
  assert.equal(numberLocaleFor({ ...REGION_PRESETS['de-CH'] }), 'de-CH');
  // Kein passendes Preset → leerer String (App fällt auf die UI-Sprache zurück).
  assert.equal(numberLocaleFor({ currency: 'EUR', date_format: 'mdy', time_format: '12h' }), '');
  assert.equal(numberLocaleFor({}), '');
  assert.equal(numberLocaleFor(), '');
  // Jeder gelieferte Tag muss ein gültiger BCP-47-Regionscode sein (getFormatLocale-Regex).
  for (const code of REGION_CODES) {
    const tag = numberLocaleFor({ region: code, ...REGION_PRESETS[code] });
    assert.match(tag, BCP47_TAG, `${code}: numberLocaleFor tag not BCP-47`);
  }
});

// Die Tag-Form wurde an fünf Stellen einzeln geprüft (getFormatLocale,
// VALID_REGION, resolveHouseholdLocale, formatMoney, householdRegion), jede mit
// einem eigenen Literal. Eine Region mit dreibuchstabigem Sprachcode wie fil-PH
// fiel durch jede Stelle, die noch auf {2} stand. Seit 20.09.2026 sind es zwei
// Quellen - eine je Schicht, weil die Schichtgrenze keinen Import zulässt - und
// der Test darüber hält sie aneinander.
//
// Geblieben ist der Schutz, den der alte Quelltext-Scan geleistet hat: es darf
// keine DRITTE Formprüfung dazukommen. Eine neue Kopie irgendwo im Produktivcode
// wandert bei der nächsten Erweiterung nicht mit, und genau so ist #1322
// entstanden. Gesucht wird die Form des Literals, nicht sein Name, denn eine
// Kopie trägt selten denselben.
//
// Gesucht wird ein Regex-Literal, das auf eine VERPFLICHTENDE Region endet
// (`-[A-Z]{2}$`). Das unterscheidet eine Regionsprüfung von LOCALE_FILE_RE in
// derselben Datei, wo die Region optional ist und ein Dateiname folgt - die
// erste Fassung dieses Guards zählte das Dateinamen-Muster mit und stand rot,
// ohne dass eine Kopie existierte.
//
// Die ZWEITE Fassung verlangte `{2}` und `$` unmittelbar nacheinander und war
// damit blind für die naheliegendste Kopie überhaupt: `/^(custom|[a-z]{2,3}-
// [A-Z]{2})$/`, mit einer schliessenden Klammer dazwischen. Gemessen als
// Gegenprobe - Kopie eingezogen, Suite exit 0. Schliessende Klammern gehören
// also dazwischen erlaubt. Ein Guard, den man enger macht, wird still blind,
// und das ist hier innerhalb einer Viertelstunde zweimal passiert.
test('es gibt nur ZWEI Formprüfungen für einen Regions-Tag', async () => {
  const dateien = ['public/i18n.js', 'server/routes/preferences.js', 'server/utils/i18n.js'];
  const gefunden = [];
  for (const file of dateien) {
    const src = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const treffer of src.matchAll(/\[a-z\]\{[^}]+\}[^\n]{0,24}-\[A-Z\]\{2\}\)*\$/g)) {
      gefunden.push(`${file}: ${treffer[0]}`);
    }
  }
  assert.equal(gefunden.length, 2,
    `Erwartet: REGION_TAG (public/i18n.js) und REGION_RE (server/utils/i18n.js). `
    + `Gefunden sind ${gefunden.length}:\n  ${gefunden.join('\n  ')}\n`
    + 'Eine weitere Kopie wandert bei der nächsten Erweiterung nicht mit.');
});

// Und der Verhaltensbeleg dazu: was die beiden Quellen mit einem
// dreibuchstabigen Sprachcode tun. Der alte Guard las dafür den QUANTOR aus dem
// Quelltext ({2,3}) - eine Schreibweise, die nichts darüber sagt, ob der
// Ausdruck fil-PH am Ende durchlässt.
test('beide Formprüfungen nehmen zwei- UND dreibuchstabige Sprachcodes', () => {
  for (const code of ['de-DE', 'fil-PH', 'zh-Hant-TW']) {
    assert.ok(REGION_TAG.test(code), `${code} faellt durch die Client-Formprüfung`);
    assert.ok(isRegionTag(code), `${code} faellt durch die Server-Formprüfung`);
  }
});

// --------------------------------------------------------------------------
// #521 und #1365: WELCHE Locale formatiert eine Zahl, und welche ein Wort.
//
// Die Zahl gehört dem Haushalt, das Wort der Person. Ziffern, Trenner und
// Beträge folgen der Region (`getFormatLocale()`, über `getNumberFormat()`),
// ein Wert mit Einheit bekommt sein Wort aus der UI-Sprache und seine Zahl aus
// der Region (`formatUnit()`). Beides lebt in public/i18n.js.
//
// Der Vorgänger dieses Guards las die SCHREIBWEISE `NumberFormat(getLocale()`
// und war damit an zwei Stellen blind: `new Intl.NumberFormat(currentLocale)`
// in i18n.js sah er nicht, und `getNumberFormat({ style: 'unit' })` sah er als
// richtig an - die Region lieferte dort auch das Wort, und eine englische
// Oberfläche zeigte „3 Wochen" (#1365). Er prüft jetzt die REGEL: Intl.NumberFormat
// nur an den Stellen unten, `style: 'unit'` nur im Helfer.
//
// Gelesen wird über withoutCommentsKeepingLines() aus source-text.js: ein
// Kommentar, der Intl.NumberFormat NENNT, formatiert nichts, und ein Guard, der
// ihn meldet, prüft wieder eine Schreibweise. Code hinter einer URL in einem
// String (`'https://...'`) bleibt dabei sichtbar - das hält der Test mit den
// Proben unten fest, bevor er dem Leser den Bestand glaubt.
// --------------------------------------------------------------------------

// Jede Stelle, an der Intl.NumberFormat stehen darf, mit Funktion und Grund.
// Eine neue braucht einen Eintrag hier, und eine verwaiste Erlaubnis fällt auf.
const NUMBER_FORMAT_PLACES = [
  { file: 'public/i18n.js', fn: 'getNumberFormat',
    why: 'Zahlen und Beträge in der Format-Locale der Region (#521)' },
  { file: 'public/i18n.js', fn: 'formatUnit',
    why: 'Wert mit Einheit: Wort aus der UI-Sprache, Zahl aus der Region (#1365)' },
  { file: 'public/utils/money.js', fn: 'numberSeparators',
    why: 'misst Dezimal- und Gruppentrenner JEDER Region für die Eingabe, zeigt nichts an' },
  { file: 'public/utils/digits.js', fn: 'buildDigitMap',
    why: 'liest die Ziffern jedes Ziffernsystems über das neutrale en, zeigt nichts an' },
];

// `style: 'unit'` macht aus einer Zahl ein Wort, und das Wort gehört der
// UI-Sprache. Nur der Helfer darf es: er setzt die Zahl der Region ein.
const UNIT_STYLE_PLACES = [
  { file: 'public/i18n.js', fn: 'formatUnit', why: 'der Helfer selbst (#1365)' },
];

// Die Option in jeder Schreibweise, auch als Objekt in einer Variablen oder als
// Zuweisung: `style: 'unit'`, `'style': "unit"`, `opts.style = 'unit'`,
// `opts['style'] = 'unit'`. Ein Vergleich (`style === 'unit'`) setzt nichts.
const UNIT_STYLE = /(?:\bstyle\b|\[\s*(['"`])style\1\s*\]|(['"`])style\2)\s*(?::|=(?!=))\s*(['"`])unit\3/g;
const NUMBER_FORMAT = /\bNumberFormat\b/g;

/** Umfang einer Funktion auf oberster Ebene: vom Kopf bis zur `}` am Zeilenanfang. */
function functionSpan(code, name) {
  const head = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').exec(code);
  if (!head) return null;
  const end = code.indexOf('\n}', head.index);
  return end === -1 ? null : { from: head.index, to: end + 2 };
}

const lineOf = (code, index) => code.slice(0, index).split('\n').length;

/**
 * Wo steht `pattern` ausserhalb der erlaubten Stellen? Liefert die Funde als
 * `datei:zeile` und die Stellen, die nichts mehr brauchen oder fehlen.
 * @param {{ rel: string, src: string }[]} files
 */
function placesReport(files, places, pattern) {
  const offenders = [];
  const used = new Set();
  const missing = [];
  for (const { rel, src } of files) {
    const code = withoutCommentsKeepingLines(src);
    const spans = [];
    for (const place of places.filter((p) => p.file === rel)) {
      const span = functionSpan(code, place.fn);
      if (span) spans.push({ ...span, place });
      else missing.push(`${place.file}: function ${place.fn}`);
    }
    for (const hit of code.matchAll(pattern)) {
      const inside = spans.find((s) => hit.index >= s.from && hit.index < s.to);
      if (inside) used.add(inside.place);
      else offenders.push(`${rel}:${lineOf(code, hit.index)}`);
    }
  }
  const unused = places.filter((p) => !used.has(p) && !missing.some((m) => m.endsWith(` ${p.fn}`)));
  return { offenders, missing, unused: unused.map((p) => `${p.file}: ${p.fn}`) };
}

async function publicScripts() {
  const root = new URL('../public/', import.meta.url);
  const files = [];
  async function walk(url) {
    for (const ent of await readdir(url, { withFileTypes: true })) {
      if (ent.name === 'lucide.min.js') continue;
      const child = new URL(ent.name + (ent.isDirectory() ? '/' : ''), url);
      if (ent.isDirectory()) await walk(child);
      else if (ent.name.endsWith('.js')) {
        files.push({ rel: `public/${child.href.slice(root.href.length)}`, src: await readFile(child, 'utf8') });
      }
    }
  }
  await walk(root);
  return files;
}

test('der Leser sieht Code hinter einer URL und Optionen in Variablen, keine Kommentare', () => {
  const probe = (src, places, pattern) => placesReport([{ rel: 'public/probe.js', src }], places, pattern);
  const helper = [{ file: 'public/probe.js', fn: 'formatUnit', why: 'Probe' }];

  // Die zwei Rückfälle aus #1365: getLocale() irgendwo, currentLocale ausserhalb des Helfers.
  assert.deepEqual(probe(
    "const url = 'https://example.org/a//b'; const f = new Intl.NumberFormat(getLocale(), {});",
    [], NUMBER_FORMAT,
  ).offenders, ['public/probe.js:1'], 'Code hinter `//` in einem String muss sichtbar bleiben');
  assert.deepEqual(probe([
    'export function formatUnit(value) {',
    "  return new Intl.NumberFormat(currentLocale, { style: 'unit', unit: 'day' }).format(value);",
    '}',
    'export function formatDate(value) {',
    '  return new Intl.NumberFormat(currentLocale).format(value);',
    '}',
  ].join('\n'), helper, NUMBER_FORMAT).offenders, ['public/probe.js:5'],
  'im Helfer erlaubt, eine Funktion weiter nicht');
  assert.deepEqual(probe('const { NumberFormat } = Intl;\nconst f = Intl["NumberFormat"];', [], NUMBER_FORMAT).offenders,
    ['public/probe.js:1', 'public/probe.js:2'], 'auch ohne den Punkt');
  assert.deepEqual(probe('// new Intl.NumberFormat(getLocale())\n/* Intl.NumberFormat */', [], NUMBER_FORMAT).offenders, [],
    'ein Kommentar formatiert nichts');

  // style: 'unit' in jeder Schreibweise, auch als Objekt in einer Variablen.
  assert.deepEqual(probe([
    "const opts = { style: 'unit', unit: 'week' };",
    'getNumberFormat(opts).format(3);',
    "const b = { 'style': \"unit\" };",
    "b.style = 'unit';",
    "b['style'] = `unit`;",
    "if (b.style === 'unit') b.ok = true;",
  ].join('\n'), [], UNIT_STYLE).offenders,
  ['public/probe.js:1', 'public/probe.js:3', 'public/probe.js:4', 'public/probe.js:5']);

  // Eine Erlaubnis, deren Funktion fehlt, meldet sich - sonst deckte sie still nichts.
  assert.deepEqual(probe('const x = 1;', helper, NUMBER_FORMAT).missing, ['public/probe.js: function formatUnit']);
});

test('Intl.NumberFormat steht nur an den erlaubten Stellen (#521, #1365)', async () => {
  const report = placesReport(await publicScripts(), NUMBER_FORMAT_PLACES, NUMBER_FORMAT);
  assert.deepEqual(report.missing, [], 'eine erlaubte Stelle gibt es nicht mehr - Liste nachziehen');
  assert.deepEqual(report.offenders, [],
    'Intl.NumberFormat ausserhalb der erlaubten Stellen. Zahlen und Beträge laufen über '
    + 'getNumberFormat() (Region, #521), ein Wert mit Einheit über formatUnit() (Wort aus der '
    + 'UI-Sprache, Zahl aus der Region, #1365). Eine eigene Stelle braucht einen Eintrag mit Grund '
    + `in NUMBER_FORMAT_PLACES:\n  ${report.offenders.join('\n  ')}`);
  assert.deepEqual(report.unused, [], 'eine Erlaubnis ohne Intl.NumberFormat deckt morgen eine neue Stelle');
});

test("style: 'unit' steht nur im Helfer formatUnit() (#1365)", async () => {
  const report = placesReport(await publicScripts(), UNIT_STYLE_PLACES, UNIT_STYLE);
  assert.deepEqual(report.missing, [], 'der Helfer fehlt');
  assert.deepEqual(report.offenders, [],
    "style: 'unit' ausserhalb von formatUnit(): das Wort käme aus der Region statt aus der "
    + `UI-Sprache. formatUnit(wert, einheit, { unitDisplay }) nehmen:\n  ${report.offenders.join('\n  ')}`);
  assert.deepEqual(report.unused, [], 'der Helfer setzt style: unit nicht mehr - dann misst dieser Guard nichts');
});

// Die Zahl gehört dem Haushalt, das Wort der Person. Gefahren wird die ECHTE
// i18n.js mit getrennt gesetzter UI-Sprache und Region (test/i18n-env.js).
const UNIT_CASES = [
  { language: 'en', region: 'de-DE', weeks: '3 weeks', hours: '1,5 hours' },
  { language: 'fr', region: 'de-CH', weeks: '3 semaines', hours: '1.5 heure' },
  { language: 'de', region: 'de-DE', weeks: '3 Wochen', hours: '1,5 Stunden' },
  // Arabische Ziffern (arab) aus der Region, das Wort aus der Sprache.
  { language: 'ar', region: 'ar-SA', weeks: '٣ أسابيع', hours: '١٫٥ ساعة' },
  { language: 'en', region: 'ar-SA', weeks: '٣ weeks', hours: '١٫٥ hours' },
  // Persisch bringt eigene Ziffern (arabext) mit - die Region ersetzt sie ganz.
  { language: 'fa', region: 'fa-IR', weeks: '۳ هفته', hours: '۱٫۵ ساعت' },
  { language: 'fa', region: 'de-DE', weeks: '3 هفته', hours: '1,5 ساعت' },
  { language: 'en', region: 'fa-IR', weeks: '۳ weeks', hours: '۱٫۵ hours' },
];

test('Wert mit Einheit: Wort aus der UI-Sprache, Zahl aus der Region (#1365)', async () => {
  for (const { language, region, weeks, hours } of UNIT_CASES) {
    await withLocales({ language, region }, () => {
      assert.equal(formatUnit(3, 'week', { unitDisplay: 'long' }), weeks, `UI ${language} + Region ${region}`);
      assert.equal(formatUnit(1.5, 'hour', { unitDisplay: 'long' }), hours, `UI ${language} + Region ${region}`);
    });
  }
  // Wo Sprache und Region zusammenpassen, bleibt es beim Wortlaut von vorher.
  await withLocales({ language: 'de', region: 'de-DE' }, () => {
    const vorher = (value, unit) => new Intl.NumberFormat('de-DE', { style: 'unit', unit, unitDisplay: 'long' }).format(value);
    assert.equal(formatUnit(3, 'week', { unitDisplay: 'long' }), vorher(3, 'week'));
    assert.equal(formatUnit(1.5, 'hour', { unitDisplay: 'long' }), vorher(1.5, 'hour'));
  });
});

test('Arabisch 1 und 2 haben keinen Zahlteil und bleiben, wie die Sprache sie schreibt', async () => {
  for (const region of ['ar-SA', 'de-DE']) {
    await withLocales({ language: 'ar', region }, () => {
      assert.equal(formatUnit(1, 'week', { unitDisplay: 'long' }), 'أسبوع', region);
      assert.equal(formatUnit(2, 'week', { unitDisplay: 'long' }), 'أسبوعان', region);
    });
  }
});

test('die Region ersetzt die Zahl ganz: Gruppierung, Vorzeichen und seine Richtungsmarke', async () => {
  await withLocales({ language: 'en', region: 'de-CH' }, () => {
    assert.equal(formatUnit(1234.5, 'hour', { unitDisplay: 'long' }), "1'234.5 hours");
  });
  // ar-SA setzt ein ALM vor das Minus - es kommt mit der Zahl.
  await withLocales({ language: 'en', region: 'ar-SA' }, () => {
    assert.equal(formatUnit(-1.5, 'hour', { unitDisplay: 'long' }), '؜-١٫٥ hours');
  });
  // fa schreibt LRM und U+2212 vor seine Zahl - beides geht mit ihr.
  await withLocales({ language: 'fa', region: 'de-DE' }, () => {
    assert.equal(formatUnit(-1.5, 'hour', { unitDisplay: 'long' }), '-1,5 ساعت');
  });
});

test('ein Regionswechsel ohne setLocale() trifft keinen alten Formatter (Cache-Schlüssel)', async () => {
  await withLocales({ language: 'en', region: 'de-DE' }, ({ setRegion }) => {
    const hours = () => formatUnit(1.5, 'hour', { unitDisplay: 'long' });
    assert.equal(hours(), '1,5 hours');
    setRegion('de-CH');
    assert.equal(hours(), '1.5 hours');
    setRegion('ar-SA');
    assert.equal(hours(), '١٫٥ hours');
    setRegion(null);
    assert.equal(hours(), '1.5 hours', 'ohne Region folgt auch die Zahl der UI-Sprache');
  });
});

test('Zahlen und Beträge folgen weiter allein der Region (#521)', async () => {
  await withLocales({ language: 'en', region: 'de-DE' }, () => {
    assert.equal(getNumberFormat({ maximumFractionDigits: 1 }).format(1234.5), '1.234,5');
    assert.equal(getNumberFormat({ style: 'currency', currency: 'EUR' }).format(1234.5), '1.234,50 €');
  });
});

// Birthdays und andere Seiten laden '/i18n.js' unter test-browser-loader.mjs als
// Stub, und dessen formatUnit ist ein Nachbau. Er muss rechnen wie das
// Original, sonst messen deren Suiten den Stub statt der App.
test('der formatUnit-Stub des Browser-Loaders rechnet wie das Original', async () => {
  const { resolve } = await import('./test-browser-loader.mjs');
  const { url } = await resolve('/i18n.js', {}, () => { throw new Error('/i18n.js ist kein Stub mehr'); });
  const stub = await import(url);
  const values = [0, 1, 2, 3, 11, -1.5, 1.5, 1234.5];
  const pairs = [...UNIT_CASES.map(({ language, region }) => [language, region]), ['ar', 'de-DE'], ['de', 'de-CH']];
  const vorher = { locale: globalThis.__locale, formatLocale: globalThis.__formatLocale };
  try {
    for (const [language, region] of pairs) {
      globalThis.__locale = language;
      globalThis.__formatLocale = region;
      await withLocales({ language, region }, () => {
        for (const unit of ['minute', 'hour', 'day', 'week']) {
          for (const unitDisplay of ['short', 'long']) {
            for (const value of values) {
              assert.equal(stub.formatUnit(value, unit, { unitDisplay }), formatUnit(value, unit, { unitDisplay }),
                `${language} + ${region}: ${value} ${unit} ${unitDisplay}`);
            }
          }
        }
      });
    }
  } finally {
    globalThis.__locale = vorher.locale;
    globalThis.__formatLocale = vorher.formatLocale;
  }
});

test('i18n.js exports getFormatLocale + gecachten getNumberFormat als Zahl-Formatier-Quelle', async () => {
  const src = await readFile(new URL('../public/i18n.js', import.meta.url), 'utf8');
  assert.match(src, /export function getFormatLocale\(/, 'getFormatLocale muss existieren');
  assert.match(src, /export function getNumberFormat\(/, 'gecachter getNumberFormat muss existieren');
  assert.match(src, /NUMBER_LOCALE_KEY\s*=\s*'yuvomi-number-locale'/, 'localStorage-Schlüssel gepinnt');
});

// Die Route prüft die Region nicht mehr mit einem eigenen Literal, sondern mit
// isRegionTag() aus utils/i18n.js plus 'custom'. Der Test misst deshalb diese
// Regel statt ein Muster aus dem Quelltext zu schneiden - was er vorher tat, und
// was nur solange funktioniert, wie die Prüfung als ein Literal mit genau
// diesem Namen dasteht.
//
// 'custom' gehört bewusst NUR hierher: es ist kein Regions-Tag, sondern die
// Abwesenheit einer Region. Die drei Leser (Sprachableitung, Zahlenformat,
// Regionsabfrage) dürfen es nicht als Tag nehmen, sonst ginge ein
// Anzeige-Hinweis als Locale an Intl.
test('preferences route validates the region field shape', async () => {
  const akzeptiert = (value) => value === 'custom' || isRegionTag(value);

  for (const code of REGION_CODES) {
    assert.ok(akzeptiert(code), `${code} must pass the region check`);
  }
  assert.ok(akzeptiert('custom'));
  assert.ok(akzeptiert('fil-PH'), 'fil-PH - der Fall, der die {2,3}-Erweiterung erzwang');
  assert.ok(!akzeptiert('french'));
  assert.ok(!akzeptiert('fr_FR'));
  assert.ok(!akzeptiert(''));
  assert.ok(!isRegionTag('custom'), "'custom' ist kein Tag - kein Leser darf es als Locale nehmen");

  // Und die Route greift wirklich danach, statt ein eigenes Muster zu tragen.
  const src = await readFile(
    new URL('../server/routes/preferences.js', import.meta.url),
    'utf8',
  );
  assert.match(src, /isRegionTag/,
    'Die Route prüft die Region nicht mehr über isRegionTag - es gibt einen zweiten Pfad.');
});

// --------------------------------------------------------------------------
// #297: Der Melder fand VND nicht mehr in der Auswahl, obwohl `vi.json`
// ausgeliefert wird. Der Code war beim Vereinheitlichen der vier
// Waehrungskopien (#340) verschwunden und zwei Monate lang niemandem
// aufgefallen - weil ihn nichts geprueft hat.
//
// DER GUARD IST EINE REGEL UEBER DEN BESTAND, KEINE LISTE VON DATEIEN. Eine
// Allowlist deckt genau die Faelle, die schon richtig sind; die drei Locales
// ohne Region (el, hu, vi) standen in keiner. Er liest `public/locales/` und
// erfaehrt so von einer neuen Sprache, ohne dass jemand ihn nachtraegt.
//
// Die Gegenrichtung - jedes Preset nennt eine waehlbare Waehrung - steht schon
// im ersten Test dieser Datei. Zusammen schliessen die beiden den Kreis, der
// bei #297 offen war: eine Sprache ohne Region konnte keine Waehrung fordern,
// und so fiel niemandem auf, dass ihre fehlte.
// --------------------------------------------------------------------------

test('jede ausgelieferte Sprache hat mindestens ein Region-Preset (#297)', async () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const locales = (await readdir(dir))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''));

  assert.ok(locales.length > 0, 'public/locales/ muss Sprachdateien enthalten');

  const languagesWithRegion = new Set(REGION_CODES.map((code) => code.split('-')[0]));
  const orphans = locales.filter((locale) => !languagesWithRegion.has(locale));

  assert.deepEqual(
    orphans,
    [],
    'Ohne Region landet diese Sprache zwangslaeufig auf "Benutzerdefiniert" und muss '
    + `Waehrung, Datum und Zeit einzeln raten: ${orphans.join(', ')}`,
  );
});

// Die Form eines Regions-Tags lebt zwangsläufig zweimal: `REGION_TAG` in
// public/i18n.js und `REGION_RE` in server/utils/i18n.js. Ein Import über die
// Grenze gibt es nicht - test/test-layer-boundary.js lässt keinen Modulweg
// zwischen public/ und server/ zu, und das ist so gewollt.
//
// Also muss ein Test halten, was kein Import halten kann. Er prüft die beiden
// gegen dieselben Proben, statt eine Schreibweise zu vergleichen: zwei Regexe
// können gleich aussehen und verschieden greifen, und genau die Frage ist hier
// zu beantworten. Läuft eine Seite weiter als die andere, ist die Folge kein
// Absturz, sondern Stille - eine Region, die der Client anbietet und der Server
// mit 400 abweist, oder eine, die gespeichert wird und die kein Leser danach
// wiedererkennt.
test('client and server agree on the shape of a region tag', () => {
  const proben = [
    'de-DE', 'fil-PH', 'pt-BR', 'zh-Hant-TW', 'sr-Latn-RS', 'zh-TW', 'en-US',
    'custom', 'de', 'de-de', 'DE-DE', 'zh-hant-TW', 'de-DEU', 'a-DE', 'de-D', '',
  ];
  const drift = proben.filter((p) => REGION_TAG.test(p) !== isRegionTag(p));
  assert.deepEqual(drift, [],
    `Client und Server beurteilen dieselbe Region verschieden: ${drift.join(', ')}. `
    + 'Sie wird entweder beim Speichern abgewiesen oder gespeichert und nie gelesen.');
});

// Die Presets sind die einzigen Regionen, die die Oberfläche tatsächlich
// anbietet - der Realitätsanker unter der Formprüfung.
test('every region preset passes both shape checks', () => {
  const abgewiesen = Object.keys(REGION_PRESETS)
    .filter((r) => !REGION_TAG.test(r) || !isRegionTag(r));
  assert.deepEqual(abgewiesen, [],
    `Diese Presets stehen im Dropdown, werden aber als Region abgewiesen: ${abgewiesen.join(', ')}`);
});

// Der Sprachteil ist das, was aus einer Region eine Datensprache macht
// (resolveHouseholdLocale). Er trägt den Schrift-Subtag NICHT, weil die
// Locale-Dateien reine Sprachcodes heissen: aus `zh-Hant-TW` muss `zh` werden,
// sonst fiele ein chinesischer Haushalt auf Englisch zurück.
test('the language part of a region drops the script subtag', () => {
  assert.equal(regionLanguage('fil-PH'), 'fil');
  assert.equal(regionLanguage('de-DE'), 'de');
  assert.equal(regionLanguage('zh-Hant-TW'), 'zh');
  assert.equal(regionLanguage('sr-Latn-RS'), 'sr');
  assert.equal(regionLanguage('custom'), null);
  assert.equal(regionLanguage(null), null);
});
