import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { SUPPORTED_LOCALES } from '../tools/installer/i18n-mini.js';

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
