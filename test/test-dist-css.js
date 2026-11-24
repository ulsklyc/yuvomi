/**
 * Modul: Der Minifier nimmt den Blaettern keine Deklaration (Phase 1a, Abschnitt D)
 * Zweck: Das Kopier-Plugin minifiziert jedes Blatt unter public/styles/ einzeln
 *        (scripts/build/vite-plugins.ts). lightningcss, der erste Minifier,
 *        fasste die von Hand gefuehrten Paare `-webkit-backdrop-filter` +
 *        `backdrop-filter` zu EINER Zeile zusammen und kuerzte die @supports-
 *        Bedingung mit beiden Schreibweisen: in dist/ standen 31 Deklarationen
 *        weniger, Chrome und Firefox zeigten kein Glas mehr (Sonde 12 der
 *        document-guards, rot auf #2631). Die Quelle fuehrt beide Zeilen fuer
 *        die Untergrenze Safari 15.4; der Minifier darf keine davon anfassen.
 *        Geprueft wird je Blatt: jeder deklarierte Eigenschaftsname der Quelle
 *        kommt in dist/ mindestens so oft vor, und die @supports-Bedingungen
 *        sind dieselben.
 * Ausfuehren: npm run build && node --test test/test-dist-css.js
 * Abhaengigkeiten: dist/ (npm run build, Buendel-Anordnung)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DIST, requireDist } from './dist-build.js';

const STYLES = new URL('../public/styles/', import.meta.url);

/** Text ohne Kommentare und ohne den Inhalt von Zeichenketten. @param {string} css */
function code(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
}

/** Zaehlung der deklarierten Eigenschaftsnamen. @param {string} css */
function declarations(css) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const m of code(css).matchAll(/[{;]\s*(-?[a-z][-a-z]*)\s*:/gi)) {
    const name = m[1].toLowerCase();
    out.set(name, (out.get(name) ?? 0) + 1);
  }
  return out;
}

/** @supports-Bedingungen ohne Leerraum, sortiert. @param {string} css */
function supports(css) {
  return [...code(css).matchAll(/@supports\s*([^{]+)\{/gi)].map((m) => m[1].replace(/\s+/g, '')).sort();
}

test('jedes Blatt in dist/styles/ behaelt jede Deklaration und jede @supports-Bedingung der Quelle', () => {
  requireDist();
  const sheets = readdirSync(STYLES).filter((f) => f.endsWith('.css')).sort();
  assert.ok(sheets.length >= 40, `nur ${sheets.length} Blaetter gelesen`);
  const lost = [];
  const changed = [];
  let total = 0;
  for (const sheet of sheets) {
    const source = readFileSync(new URL(sheet, STYLES), 'utf8');
    const built = readFileSync(`${DIST}styles/${sheet}`, 'utf8');
    const want = declarations(source);
    const have = declarations(built);
    for (const [name, count] of want) {
      total += count;
      const got = have.get(name) ?? 0;
      if (got < count) lost.push(`${sheet}: ${name} ${count} -> ${got}`);
    }
    if (JSON.stringify(supports(built)) !== JSON.stringify(supports(source))) {
      changed.push(`${sheet}: ${supports(source).join(' | ')} -> ${supports(built).join(' | ')}`);
    }
  }
  assert.ok(total > 5000, `nur ${total} Deklarationen gezaehlt - der Leser greift nicht`);
  assert.deepEqual(lost, [], 'der Minifier hat diese Deklarationen entfernt');
  assert.deepEqual(changed, [], 'der Minifier hat diese @supports-Bedingungen geaendert');
});
