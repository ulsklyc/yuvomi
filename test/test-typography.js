/**
 * Typografie-Guard.
 * Hält die Phase-1–3-Konsolidierung dauerhaft: Schriftgröße und Letter-Spacing
 * dürfen nur über Tokens (var(--…)) gesetzt werden, niemals als roher px/rem/em-
 * Wert. Verhindert das erneute Auseinanderdriften der Module.
 *
 * Erlaubt:
 *   - var(--…) (auch mit Fallback)
 *   - 0, normal, inherit
 *   - reset.css: die 1rem-Basis (font-size: 16px) — Fundament der rem-Skala
 *   - tokens.css: die Token-Definitionen selbst
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const STYLES_DIR = new URL('../public/styles/', import.meta.url);

const cssFiles = readdirSync(STYLES_DIR)
  .filter((name) => name.endsWith('.css'))
  .filter((name) => name !== 'tokens.css'); // Token-Quelle ist per Definition ausgenommen

/** Neutralisiert /* … *\/-Blockkommentare (dokumentierte px-Werte sind keine Treffer),
 *  erhält dabei die Zeilenzahl, damit gemeldete Zeilennummern stimmen. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Liefert { line, text } je Deklaration der gegebenen Property. */
function declarations(css, prop) {
  const out = [];
  const re = new RegExp(`${prop}\\s*:\\s*([^;}]+)`, 'gi');
  let m;
  while ((m = re.exec(css)) !== null) {
    const line = css.slice(0, m.index).split('\n').length;
    out.push({ line, value: m[1].trim() });
  }
  return out;
}

const LITERAL = /(^|[\s(])-?\d*\.?\d+(px|rem|em)\b/; // roher Längen-Literalwert

test('font-size wird ausschließlich über Tokens gesetzt (außer reset.css-Basis)', () => {
  const violations = [];
  for (const file of cssFiles) {
    if (file === 'reset.css') continue; // 1rem-Fundament
    const css = stripComments(readFileSync(new URL(file, STYLES_DIR), 'utf8'));
    for (const { line, value } of declarations(css, 'font-size')) {
      if (value.startsWith('var(')) continue;
      if (LITERAL.test(value)) violations.push(`${file}:${line} → font-size: ${value}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Hartkodierte font-size gefunden — stattdessen ein --text-*-Token nutzen:\n${violations.join('\n')}`,
  );
});

test('letter-spacing wird ausschließlich über Tracking-Tokens gesetzt', () => {
  const violations = [];
  for (const file of cssFiles) {
    const css = stripComments(readFileSync(new URL(file, STYLES_DIR), 'utf8'));
    for (const { line, value } of declarations(css, 'letter-spacing')) {
      if (value.startsWith('var(')) continue;
      if (/^(0|normal|inherit)$/.test(value)) continue;
      if (LITERAL.test(value)) {
        violations.push(`${file}:${line} → letter-spacing: ${value}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Hartkodiertes letter-spacing gefunden — stattdessen --tracking-tight/-normal/-label nutzen:\n${violations.join('\n')}`,
  );
});

test('die kanonischen Breakpoint-Tokens existieren in tokens.css', () => {
  const tokens = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
  for (const bp of ['--bp-mobile', '--bp-tablet', '--bp-desktop', '--bp-wide']) {
    assert.ok(tokens.includes(bp), `Breakpoint-Token ${bp} fehlt in tokens.css`);
  }
});

test('die Typografie-Rollen-Schicht ist vorhanden und eingebunden', () => {
  const typography = readFileSync(new URL('../public/styles/typography.css', import.meta.url), 'utf8');
  for (const role of ['.u-eyebrow', '.u-card-title', '.u-section-title', '.u-page-title']) {
    assert.ok(typography.includes(role), `Rollen-Klasse ${role} fehlt in typography.css`);
  }
  const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(
    indexHtml.includes('styles/typography.css'),
    'typography.css ist nicht in index.html eingebunden',
  );
});
