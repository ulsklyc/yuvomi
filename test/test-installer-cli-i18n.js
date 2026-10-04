import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, copyFileSync, cpSync,
  chmodSync, rmSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_LOCALES } from '../tools/installer/i18n-mini.js';
import { tempDir } from './tmp-dir.js';

const CLI_LOCALES_DIR = new URL('../tools/installer/locales/cli/', import.meta.url);
const INSTALL_SH = new URL('../install.sh', import.meta.url);
const REFERENCE = 'en'; // Fallback-/Schlüssel-Referenz; de muss schlüsselidentisch sein.

/** Variablennamen (MSG_…) aus einer gesourcten Locale-Datei extrahieren. */
function localeVars(locale) {
  const src = readFileSync(new URL(`${locale}.sh`, CLI_LOCALES_DIR), 'utf8');
  return new Set([...src.matchAll(/^(MSG_[A-Za-z0-9_]+)=/gm)].map(m => m[1]));
}

/** Alle in install.sh per `t <punkt.schlüssel>` referenzierten Schlüssel → MSG_-Variablen. */
function referencedVars() {
  const sh = readFileSync(INSTALL_SH, 'utf8');
  const keys = [...sh.matchAll(/[\s("]t ([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)/g)].map(m => m[1]);
  return new Set(keys.map(k => `MSG_${k.replace(/\./g, '_')}`));
}

const referenceVars = localeVars(REFERENCE);

// ── Locale-Dateien vollständig & schlüsselidentisch ──────────────────────────

test('für jede unterstützte Locale existiert genau eine CLI-Locale-Datei', () => {
  const files = readdirSync(new URL(CLI_LOCALES_DIR)).filter(f => f.endsWith('.sh')).sort();
  // Erst abbilden, dann sortieren: `pt-BR.sh` steht vor `pt.sh` ('-' < '.'),
  // der Code `pt-BR` aber hinter `pt`.
  assert.deepEqual(files, [...SUPPORTED_LOCALES].map(l => `${l}.sh`).sort());
});

test('Referenz en.sh definiert eine nichtleere Schlüsselmenge', () => {
  assert.ok(referenceVars.size > 0, 'en.sh definiert keine MSG_-Variablen');
});

for (const locale of SUPPORTED_LOCALES) {
  test(`${locale}.sh ist schlüsselidentisch zur Referenz ${REFERENCE}.sh`, () => {
    const vars = localeVars(locale);
    const missing = [...referenceVars].filter(k => !vars.has(k));
    const extra = [...vars].filter(k => !referenceVars.has(k));
    assert.deepEqual(missing, [], `${locale}.sh fehlen Schlüssel: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${locale}.sh hat überzählige Schlüssel: ${extra.join(', ')}`);
  });
}

// ── install.sh ⇄ CLI-Locales ─────────────────────────────────────────────────

test('install.sh referenziert i18n-Schlüssel über t()', () => {
  assert.ok(referencedVars().size > 0, 'keine t <schlüssel>-Aufrufe in install.sh gefunden');
});

test('jeder in install.sh referenzierte Schlüssel existiert in der Referenz en.sh', () => {
  const used = referencedVars();
  const unknown = [...used].filter(k => !referenceVars.has(k));
  assert.deepEqual(unknown, [], `Unbekannte Schlüssel in install.sh: ${unknown.join(', ')}`);
});

test('jeder in install.sh referenzierte Schlüssel existiert in jeder Locale', () => {
  const used = referencedVars();
  for (const locale of SUPPORTED_LOCALES) {
    const vars = localeVars(locale);
    const missing = [...used].filter(k => !vars.has(k));
    assert.deepEqual(missing, [], `${locale}.sh fehlen genutzte Schlüssel: ${missing.join(', ')}`);
  }
});

// ── install.sh verdrahtet die i18n-Maschinerie ───────────────────────────────

test('install.sh enthält die i18n-Maschinerie und das --lang-Flag', () => {
  const sh = readFileSync(INSTALL_SH, 'utf8');
  assert.match(sh, /CLI_LOCALES_DIR=/, 'install.sh kennt CLI_LOCALES_DIR nicht');
  assert.match(sh, /load_locale\b/, 'install.sh definiert load_locale nicht');
  assert.match(sh, /^t\(\)/m, 'install.sh definiert die t()-Funktion nicht');
  assert.match(sh, /--lang/, 'install.sh wertet --lang nicht aus');
  assert.match(sh, /OIKOS_INSTALLER_LANG/, 'install.sh erkennt die Umgebungssprache nicht');
});

test('SUPPORTED_LOCALES in install.sh deckt sich mit i18n-mini.js', () => {
  const sh = readFileSync(INSTALL_SH, 'utf8');
  const m = sh.match(/SUPPORTED_LOCALES=\(([^)]+)\)/);
  assert.ok(m, 'keine SUPPORTED_LOCALES-Definition in install.sh');
  const locales = m[1].trim().split(/\s+/).sort();
  assert.deepEqual(locales, [...SUPPORTED_LOCALES].sort(),
    'SUPPORTED_LOCALES in install.sh weicht von i18n-mini.js ab');
});

// Eine Locale mit Region (pt-BR, #1437) muss aus der Umgebung ankommen:
// `LANG=pt_BR.UTF-8` hiess bisher `pt`, weil normalize_locale alles ab dem
// Unterstrich abschnitt. Die Funktion laeuft hier isoliert - install.sh selbst
// startet am Ende den Wizard - und unter der bash, die gerade da ist; auf macOS
// ist das die 3.2, die `${x,,}` nicht kennt.
test('normalize_locale nimmt erst Sprache mit Region, dann die Basissprache', () => {
  const sh = readFileSync(INSTALL_SH, 'utf8');
  const start = sh.indexOf('SUPPORTED_LOCALES=(');
  const end = sh.indexOf('resolve_locale()');
  assert.ok(start !== -1 && end > start, 'normalize_locale nicht in install.sh gefunden');
  const fn = sh.slice(start, end);
  const run = (raw) => execFileSync('bash', ['-c', `set -euo pipefail\n${fn}\nnormalize_locale "$1"`, 'probe', raw],
    { encoding: 'utf8' });

  assert.equal(run('pt_BR.UTF-8'), 'pt-BR');
  assert.equal(run('PT_br'), 'pt-BR');
  assert.equal(run('pt-BR'), 'pt-BR', 'so kommt es ueber --lang');
  assert.equal(run('pt_PT.UTF-8'), 'pt');
  assert.equal(run('pt'), 'pt');
  assert.equal(run('de_DE.UTF-8'), 'de');
  assert.equal(run('de_DE@euro'), 'de');
  assert.equal(run('fil_PH.UTF-8'), 'fil');
  assert.equal(run('nb_NO.UTF-8'), 'nb', 'Norwegisch bokmaal aus der Shell (#1529)');
  // `no_NO` ist auf vielen Systemen der Name fuer Norwegisch, `nn_NO` ist
  // Nynorsk ohne eigene Datei. Beide fallen auf nb statt auf Englisch.
  assert.equal(run('no_NO.UTF-8'), 'nb');
  assert.equal(run('no'), 'nb', 'so kommt es ueber --lang');
  assert.equal(run('NO_no'), 'nb');
  assert.equal(run('nn_NO.UTF-8'), 'nb');
  assert.equal(run('nn'), 'nb');
  assert.equal(run('zh_TW.UTF-8'), 'zh');
  assert.equal(run('C.UTF-8'), 'en');
  assert.equal(run(''), 'en');
});

// ── Generator-Quelle ist nicht erforderlich, aber Verzeichnis muss existieren ─

test('CLI-Locale-Verzeichnis existiert', () => {
  assert.ok(existsSync(new URL(CLI_LOCALES_DIR)), 'tools/installer/locales/cli fehlt');
});

// ── Regel-Guard: printf-Formate ⇄ Aufrufstellen ─────────────────────────────
//
// `t()` reicht den Locale-Wert als FORMAT an printf: `printf "$fmt" "$@"`. Damit
// ist jede Übersetzung ausführbarer Code, nicht nur Text.
//
// Eine Sprache, die `%d` statt `%s` schreibt, bricht bei einem nicht-numerischen
// Argument; ein `%s` zu viel frisst still das nächste Argument oder gibt leer
// aus; ein `%` im Fliesstext (etwa "100% offline") wird als Formatangabe
// gelesen. Der Keyset-Guard sieht davon nichts - der Schlüssel ist ja da.
//
// Deshalb gegen die AUFRUFSTELLEN prüfen, nicht gegen die Referenzsprache:
// dort steht, wie viele Argumente ein Schlüssel tatsächlich bekommt.
test('jeder CLI-Locale-Wert ist ein printf-Format, das zu seiner Aufrufstelle passt', () => {
  const sh = readFileSync(INSTALL_SH, 'utf8');

  const expectedArgs = new Map();
  for (const m of sh.matchAll(/t ([a-z][a-zA-Z0-9_.]*)((?: "[^"]*")*)/g)) {
    const args = (m[2].match(/"/g) || []).length / 2;
    const key = `MSG_${m[1].replace(/\./g, '_')}`;
    expectedArgs.set(key, Math.max(expectedArgs.get(key) ?? 0, args));
  }
  assert.ok(expectedArgs.size > 0, 'keine t()-Aufrufe in install.sh gefunden');

  const offenders = [];
  for (const locale of SUPPORTED_LOCALES) {
    const src = readFileSync(new URL(`${locale}.sh`, CLI_LOCALES_DIR), 'utf8');
    for (const [, key, value] of src.matchAll(/^(MSG_[A-Za-z0-9_]+)="(.*)"$/gm)) {
      const specs = [...value.matchAll(/%./g)].map(s => s[0]);
      const invalid = specs.filter(s => s !== '%s' && s !== '%%');
      const placeholders = specs.filter(s => s === '%s').length;
      const expected = expectedArgs.get(key) ?? 0;

      if (invalid.length) {
        offenders.push(`${locale}.sh ${key}: unzulässige Formatangabe ${invalid.join(' ')} (nur %s und %% erlaubt)`);
      }
      if (placeholders !== expected) {
        offenders.push(`${locale}.sh ${key}: ${placeholders}× %s, die Aufrufstelle übergibt ${expected} Argument(e)`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    `printf-Format und Aufrufstelle passen nicht zusammen:\n${offenders.join('\n')}`);
});

// ── Ja/Nein-Antworten in der Sprache des Prompts ─────────────────────────────
//
// Die Prompts zeigen den Buchstaben ihrer Sprache - `[j/N]` auf Deutsch,
// `[s/N]` auf Spanisch, `[e/H]` auf Tuerkisch, `[R]učně` auf Tschechisch -,
// install.sh verglich aber nur mit `y`, `n` und `m`. Wer der Anzeige folgte,
// bekam still ein Nein, und das Wetter, der Kalender-Sync oder die
// Dokumentablage blieben aus. Dazu war der Vergleich `${x,,}` bash-4-Syntax:
// unter der bash 3.2 von macOS brach der Installer mit "bad substitution" ab.
//
// Geprueft wird deshalb an zwei Stellen: der Helfer in einer echten bash (auf
// macOS ist `bash` die 3.2, `/bin/bash` wird zusaetzlich gefahren, wenn es eine
// andere ist), und die Locale-Dateien gegen ihre eigenen Prompts - eine neue
// Sprache, die `[x/N]` zeigt, muss `x` auch annehmen.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Die bash-Binaries, unter denen install.sh laufen muss (dedupliziert). */
function bashBinaries() {
  const seen = new Map();
  for (const bin of ['bash', '/bin/bash']) {
    let real;
    try {
      real = execFileSync(bin, ['-c', 'printf "%s" "$BASH_VERSION"'], { encoding: 'utf8' });
    } catch { continue; }
    if (![...seen.values()].includes(real)) seen.set(bin, real);
  }
  return [...seen.keys()];
}
const BASHES = bashBinaries();

/** i18n-Block aus install.sh: Locale laden, t(), is_yes/is_no/is_manual. */
function helperSlice() {
  const sh = readFileSync(INSTALL_SH, 'utf8');
  const start = sh.indexOf('SCRIPT_DIR=');
  const end = sh.indexOf('generate_secret() {');
  assert.ok(start !== -1 && end > start, 'i18n-Block nicht in install.sh gefunden');
  // `bash -c` hat kein BASH_SOURCE; die Locales liegen relativ zum Repo.
  return sh.slice(start, end).replace(/^SCRIPT_DIR=.*$/m, 'SCRIPT_DIR="$REPO_ROOT"');
}

function answer(bin, fn, locale, input) {
  const script = `set -euo pipefail\n${helperSlice()}\nif ${fn} "$1"; then printf yes; else printf no; fi`;
  return execFileSync(bin, ['-c', script, 'probe', input], {
    encoding: 'utf8',
    env: { ...process.env, OIKOS_INSTALLER_LANG: locale, REPO_ROOT },
  });
}

test('mindestens eine bash steht fuer die Verhaltenstests bereit', () => {
  assert.ok(BASHES.length > 0, 'keine bash gefunden - die Verhaltenstests unten liefen leer');
});

for (const bin of BASHES) {
  test(`is_yes/is_no/is_manual nehmen den Buchstaben der Sprache an (${bin})`, () => {
    const cases = [
      ['is_yes', 'de', 'j', 'yes'], ['is_yes', 'de', 'J', 'yes'], ['is_yes', 'de', 'ja', 'yes'],
      ['is_yes', 'de', 'y', 'yes'], ['is_yes', 'de', 'n', 'no'], ['is_yes', 'de', '', 'no'],
      ['is_yes', 'de', 'nein', 'no'],
      ['is_no', 'de', 'n', 'yes'], ['is_no', 'de', 'Nein', 'yes'], ['is_no', 'de', '', 'no'],
      ['is_no', 'de', 'j', 'no'],
      ['is_yes', 'en', 'y', 'yes'], ['is_yes', 'en', 'yes', 'yes'], ['is_yes', 'en', 'Y', 'yes'],
      ['is_yes', 'en', 'j', 'no'], ['is_yes', 'en', '', 'no'],
      ['is_yes', 'es', 's', 'yes'], ['is_yes', 'fr', 'o', 'yes'], ['is_yes', 'pl', 't', 'yes'],
      ['is_yes', 'cs', 'a', 'yes'], ['is_yes', 'tr', 'E', 'yes'], ['is_yes', 'pt-BR', 's', 'yes'],
      ['is_no', 'tr', 'h', 'yes'], ['is_no', 'tr', 'H', 'yes'], ['is_no', 'tr', 'e', 'no'],
      ['is_manual', 'en', 'M', 'yes'], ['is_manual', 'en', '', 'no'], ['is_manual', 'en', 'g', 'no'],
      ['is_manual', 'nl', 'h', 'yes'], ['is_manual', 'cs', 'R', 'yes'], ['is_manual', 'cs', 'g', 'no'],
      // Gross geschrieben ausserhalb von A-Z: tr faltet das nicht, die Locale fuehrt es.
      ['is_yes', 'es', 'SÍ', 'yes'], ['is_yes', 'es', 'Sí', 'yes'], ['is_yes', 'it', 'SÌ', 'yes'],
      ['is_no', 'pt', 'NÃO', 'yes'], ['is_no', 'pt-BR', 'Não', 'yes'],
      ['is_no', 'tr', 'HAYİR', 'yes'], ['is_no', 'tr', 'HAYIR', 'yes'], ['is_no', 'tr', 'Hayır', 'yes'],
      ['is_yes', 'ru', 'ДА', 'yes'], ['is_yes', 'ru', 'Да', 'yes'], ['is_no', 'ru', 'НЕТ', 'yes'],
      ['is_yes', 'ru', 'НЕТ', 'no'], ['is_yes', 'el', 'ΝΑΙ', 'yes'], ['is_no', 'el', 'Όχι', 'yes'],
      ['is_yes', 'uk', 'ТАК', 'yes'], ['is_no', 'vi', 'KHÔNG', 'yes'],
      // Eigene Schrift: die Woerter der Sprache, nicht nur y/n.
      ['is_yes', 'ar', 'نعم', 'yes'], ['is_no', 'ar', 'لا', 'yes'], ['is_no', 'fa', 'خیر', 'yes'],
      ['is_yes', 'hi', 'हाँ', 'yes'], ['is_yes', 'ja', 'はい', 'yes'], ['is_no', 'ja', 'いいえ', 'yes'],
      ['is_yes', 'ko', '네', 'yes'], ['is_yes', 'zh', '是', 'yes'], ['is_no', 'zh', '否', 'yes'],
      ['is_yes', 'zh', '否', 'no'], ['is_yes', 'ru', 'y', 'yes'], ['is_no', 'ja', 'n', 'yes'],
    ];
    const wrong = cases
      .map(([fn, locale, input, want]) => [fn, locale, input, want, answer(bin, fn, locale, input)])
      .filter(([, , , want, got]) => got !== want)
      .map(([fn, locale, input, want, got]) => `${fn} ${locale} "${input}": erwartet ${want}, bekam ${got}`);
    assert.deepEqual(wrong, []);
  });
}

/** MSG_-Werte einer Locale als Map. */
function localeValues(locale) {
  const src = readFileSync(new URL(`${locale}.sh`, CLI_LOCALES_DIR), 'utf8');
  return new Map([...src.matchAll(/^(MSG_[A-Za-z0-9_]+)="(.*)"$/gm)].map(m => [m[1], m[2]]));
}

/** answer_matches in JS: roh oder nur A-Z gefaltet (LC_ALL=C tr A-Z a-z). */
const asciiLower = s => s.replace(/[A-Z]/g, c => c.toLowerCase());
const accepts = (words, input) => words.has(input) || words.has(asciiLower(input));

/** Was is_yes/is_no/is_manual in dieser Locale annehmen - Spiegel des Helfers. */
function acceptedWords(values) {
  const words = (always, key) => new Set([...always, ...(values.get(key) ?? '').split(/\s+/).filter(Boolean)]);
  return {
    yes: words(['y', 'yes'], 'MSG_yes_chars'),
    no: words(['n', 'no'], 'MSG_no_chars'),
    manual: words(['m'], 'MSG_manual_chars'),
  };
}

test('en.sh legt die Antwortwoerter als Basis fest', () => {
  for (const key of ['MSG_yes_chars', 'MSG_no_chars', 'MSG_manual_chars']) {
    assert.ok(referenceVars.has(key), `en.sh definiert ${key} nicht - der Keyset-Guard prueft es sonst nirgends`);
  }
});

test('jeder Ja/Nein-Prompt nimmt die Buchstaben an, die er anzeigt', () => {
  const PROMPT = /\[(\p{L})\/(\p{L})\]/u;
  const expected = [...localeValues(REFERENCE).values()].filter(v => PROMPT.test(v)).length;
  assert.ok(expected >= 8, `en.sh zeigt nur ${expected} Ja/Nein-Prompts - der Guard wuerde leer urteilen`);

  const offenders = [];
  for (const locale of SUPPORTED_LOCALES) {
    const values = localeValues(locale);
    const accepted = acceptedWords(values);
    let prompts = 0;
    for (const [key, value] of values) {
      const m = value.match(PROMPT);
      if (!m) continue;
      prompts++;
      const [yes, no] = [m[1], m[2]];
      if (!accepts(accepted.yes, yes)) offenders.push(`${locale}.sh ${key}: zeigt "${m[1]}" als Ja, MSG_yes_chars nimmt es nicht an`);
      if (!accepts(accepted.no, no)) offenders.push(`${locale}.sh ${key}: zeigt "${m[2]}" als Nein, MSG_no_chars nimmt es nicht an`);
    }
    if (prompts !== expected) offenders.push(`${locale}.sh: ${prompts} Ja/Nein-Prompts erkannt, en.sh hat ${expected}`);
    const both = [...accepted.yes].filter(w => accepted.no.has(w));
    if (both.length) offenders.push(`${locale}.sh: ${both.join(', ')} gilt zugleich als Ja und als Nein`);
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

// Angenommen werden y/n immer, angezeigt werden soll aber in einer Sprache ueberall
// dasselbe Paar: de fragte die drei Dokument-Prompts mit [y/N], alles andere mit [j/N].
// Gross/klein steht fuer den Default ([J/n] vs. [j/N]) und zaehlt hier nicht.
test('jede Locale zeigt in allen Ja/Nein-Prompts dieselben Buchstaben', () => {
  const PROMPT = /\[(\p{L})\/(\p{L})\]/u;
  const offenders = [];
  for (const locale of SUPPORTED_LOCALES) {
    const pairs = new Map();
    for (const [key, value] of localeValues(locale)) {
      const m = value.match(PROMPT);
      if (!m) continue;
      const pair = `${m[1].toLocaleLowerCase(locale)}/${m[2].toLocaleLowerCase(locale)}`;
      if (!pairs.has(pair)) pairs.set(pair, []);
      pairs.get(pair).push(key);
    }
    if (pairs.size > 1) {
      offenders.push(`${locale}.sh zeigt ${pairs.size} Paare: ${[...pairs].map(([p, keys]) => `[${p}] in ${keys.join(', ')}`).join(' | ')}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

// Gross/klein faltet install.sh nur fuer A-Z (bash 3.2 kennt ${x,,} nicht, tr
// faltet je nach System verschieden). Ein Wort mit anderen Zeichen muss deshalb
// auch in Grossbuchstaben und gross geschrieben in der Liste stehen - sonst ist
// `SÍ`, `НЕТ` oder das tuerkische `HAYİR` still eine andere Antwort.
test('jedes Antwortwort wird auch gross geschrieben angenommen', () => {
  const offenders = [];
  for (const locale of SUPPORTED_LOCALES) {
    const values = localeValues(locale);
    for (const key of ['MSG_yes_chars', 'MSG_no_chars', 'MSG_manual_chars']) {
      const words = new Set((values.get(key) ?? '').split(/\s+/).filter(Boolean));
      for (const w of words) {
        const variants = [w.toLocaleUpperCase(locale), w[0].toLocaleUpperCase(locale) + w.slice(1)];
        for (const v of variants) {
          if (!accepts(words, v)) offenders.push(`${locale}.sh ${key}: "${w}" fehlt als "${v}"`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

// Eine Locale, deren Liste nur y/yes bzw. n/no traegt, nimmt das Wort ihrer
// eigenen Sprache nicht an - so standen ar, el, fa, hi, ja, ru, uk und zh da.
test('jede Locale nimmt ihr eigenes Ja und Nein an, nicht nur y/n', () => {
  const PLACEHOLDER = new Set(['y', 'yes', 'n', 'no']);
  // Ausnahmen, in denen das englische Wort das eigene ist: "no" heisst auf
  // Spanisch und Italienisch nein. Wird ein Eintrag ueberfluessig, meldet der
  // Test das, damit die Karte nicht still waechst.
  const SAME_AS_ENGLISH = new Set(['es MSG_no_chars', 'it MSG_no_chars']);
  const offenders = [];
  for (const locale of SUPPORTED_LOCALES.filter(l => l !== REFERENCE)) {
    const values = localeValues(locale);
    for (const key of ['MSG_yes_chars', 'MSG_no_chars']) {
      const words = (values.get(key) ?? '').split(/\s+/).filter(Boolean);
      const onlyPlaceholder = !words.some(w => !PLACEHOLDER.has(w));
      const excepted = SAME_AS_ENGLISH.has(`${locale} ${key}`);
      if (onlyPlaceholder && !excepted) offenders.push(`${locale}.sh ${key}: nur ${words.join(' ') || '(leer)'}`);
      if (!onlyPlaceholder && excepted) offenders.push(`${locale}.sh ${key}: Ausnahme in SAME_AS_ENGLISH ist ueberfluessig`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('die Schluesselwahl nimmt den angezeigten Buchstaben fuer "manuell" an', () => {
  const offenders = [];
  for (const locale of SUPPORTED_LOCALES) {
    const values = localeValues(locale);
    const letters = [...(values.get('MSG_secrets_choice') ?? '').matchAll(/\[(\p{L})\]/gu)].map(m => m[1]);
    if (letters.length < 2) { offenders.push(`${locale}.sh: MSG_secrets_choice zeigt keine zwei [X]-Buchstaben`); continue; }
    const [generate, manual] = letters;
    const accepted = acceptedWords(values).manual;
    if (!accepts(accepted, manual)) offenders.push(`${locale}.sh: zeigt "${manual}" fuer manuell, MSG_manual_chars nimmt es nicht an`);
    if (accepts(accepted, generate)) offenders.push(`${locale}.sh: "${generate}" steht fuer Generieren und gilt trotzdem als manuell`);
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('install.sh vergleicht Antworten nur ueber die Helfer und ohne bash-4-Syntax', () => {
  const code = readFileSync(INSTALL_SH, 'utf8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  const caseMod = code.match(/\$\{[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?(?:,,?|\^\^?)[^}]*\}/g) ?? [];
  assert.deepEqual(caseMod, [], 'Gross/klein per ${x,,}/${x^^} kennt die bash 3.2 von macOS nicht');
  const literal = code.match(/=\s*"(?:y|yes|n|no|m)"/gi) ?? [];
  assert.deepEqual(literal, [], 'Ja/Nein-Antworten laufen ueber is_yes/is_no/is_manual, nicht ueber einen festen Buchstaben');
});

// ── Der ganze Dialog als Programm ────────────────────────────────────────────
//
// Die Helfer allein beweisen nicht, dass der Dialog sie erreicht: bis hierher
// hat kein Test install.sh je als Programm gestartet, und der Dialog endete
// lautlos direkt nach der Voraussetzungspruefung (`[ $ok -eq 0 ] && err` als
// letzte Zeile gab 1 zurueck, `set -e` beendete das Skript). Deshalb laeuft er
// hier von vorn bis hinter das Schreiben der .env - in einem Wegwerf-Ordner, mit
// einem docker-Stub, der `compose up` verweigert, damit nichts gestartet wird.

function runInstaller(bin, locale, lines, { up = 'refuse' } = {}) {
  const dir = tempDir('yuvomi-cli-yes-');
  try {
    copyFileSync(INSTALL_SH, join(dir, 'install.sh'));
    cpSync(new URL(CLI_LOCALES_DIR), join(dir, 'tools/installer/locales/cli'), { recursive: true });
    const stubs = join(dir, 'stub-bin');
    mkdirSync(stubs);
    writeFileSync(join(stubs, 'docker'), [
      '#!/bin/sh',
      'case "$*" in',
      '  "compose version") exit 0 ;;',
      up === 'ok'
        ? '  "compose up -d") exit 0 ;;'
        : '  "compose up -d") echo "STUB-UP-REFUSED" >&2; exit 3 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'));
    chmodSync(join(stubs, 'docker'), 0o755);
    // curl nur fuer den vollen Lauf: Health 200, Konto 201. Ohne Stub fragte
    // der Health-Poll einen echten Dienst auf localhost:3000.
    writeFileSync(join(stubs, 'curl'), [
      '#!/bin/sh',
      'case "$*" in',
      '  */health*) printf 200 ;;',
      '  */auth/setup*) printf \'{"ok":true}\\n201\' ;;',
      '  *) exit 7 ;;',
      'esac',
    ].join('\n'));
    chmodSync(join(stubs, 'curl'), 0o755);
    const r = spawnSync(bin, ['install.sh'], {
      cwd: dir,
      input: `${lines.join('\n')}\n`,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, OIKOS_INSTALLER_LANG: locale },
    });
    const envPath = join(dir, '.env');
    return { ...r, env: existsSync(envPath) ? readFileSync(envPath, 'utf8') : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const bin of BASHES) {
  test(`Dialog auf Deutsch: "j" und "ja" schalten ein, was sie sollen (${bin})`, () => {
    const r = runInstaller(bin, 'de', [
      '', '', 'Europe/Berlin', '',   // Host, Port, Zeitzone, Basis-URL
      '', '',                        // beide Schluessel generieren
      'j', '52.5', '13.4', 'Berlin', '', // Wetter [j/N]
      'n', '', 'N',                  // Google, Apple, Outlook
      'ja', '',                      // lokaler Ordner [y/N], Pfad
      'nein', '',                    // WebDAV, Google Drive
      '',                            // Fortfahren? [J/n]
    ]);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.doesNotMatch(out, /bad substitution/, out);
    assert.match(r.stdout, /Schritt 1\/7/, `Dialog endete vor Schritt 1:\n${out}`);
    assert.match(r.stdout, /Breitengrad/, `"j" auf [j/N] hat die Wetterfragen nicht geoeffnet:\n${out}`);
    assert.match(out, /STUB-UP-REFUSED/, `Dialog kam nicht bis zum Containerstart:\n${out}`);
    assert.ok(r.env, `keine .env geschrieben:\n${out}`);
    assert.match(r.env, /^WEATHER_LAT=52\.5$/m, '"j" auf [j/N] hat das Wetter nicht eingeschaltet');
    assert.match(r.env, /^WEATHER_CITY=Berlin$/m);
    assert.match(r.env, /^DOCUMENT_STORAGE_LOCAL_ENABLED=true$/m, '"ja" hat den lokalen Ordner nicht eingeschaltet');
    assert.match(r.env, /^DOCUMENT_STORAGE_WEBDAV_ENABLED=false$/m);
    assert.match(r.env, /^GOOGLE_CLIENT_ID=$/m);
    assert.match(r.env, /^APPLE_USERNAME=$/m);
  });

  test(`Dialog auf Tuerkisch: "h" bricht die Zusammenfassung ab (${bin})`, () => {
    const r = runInstaller(bin, 'tr', [
      '', '', 'Europe/Istanbul', '',
      '', '',
      'e', '41', '29', '', '',       // Wetter [e/H]
      '', '', '',
      '', '', '',
      'h',                           // Devam edilsin mi? [E/h]
    ]);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.doesNotMatch(out, /bad substitution/, out);
    assert.match(r.stdout, /Adım 1\/7/, `Dialog endete vor Schritt 1:\n${out}`);
    assert.match(r.stdout, /Enlem/, `"e" auf [e/H] hat die Wetterfragen nicht geoeffnet:\n${out}`);
    assert.match(r.stdout, /41, 29/, `"e" auf [e/H] hat das Wetter nicht eingeschaltet:\n${out}`);
    assert.match(r.stdout, /İptal edildi\./, `"h" hat nicht abgebrochen:\n${out}`);
    assert.equal(r.status, 0, out);
    assert.equal(r.env, null, '"h" hat trotzdem eine .env geschrieben');
  });

  test(`Dialog auf Englisch laeuft durch alle sieben Schritte (${bin})`, () => {
    const r = runInstaller(bin, 'en', [
      '', '', 'UTC', '',
      '', '',
      'yes', '10', '20', '', 'imperial', // Weather [y/N]
      '', '', '',
      '', 'Y', 'https://dav.example.com', 'u', 'p', '', // WebDAV [y/N]
      '',
      'y',                           // Proceed? [Y/n]
      'admin', 'Admin', 'pw-probe', 'pw-probe',
    ], { up: 'ok' });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.doesNotMatch(out, /bad substitution|illegal line count/, out);
    assert.match(r.stdout, /Admin account created!/, `Schritt 7 kam nicht an:\n${out}`);
    assert.equal(r.status, 0, out);
    assert.match(r.env, /^WEATHER_UNITS=imperial$/m, '"yes" hat das Wetter nicht eingeschaltet');
    assert.match(r.env, /^DOCUMENT_STORAGE_WEBDAV_ENABLED=true$/m, '"Y" hat WebDAV nicht eingeschaltet');
  });
}
