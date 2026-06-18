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

test('die Produkt-Typografie nutzt feste semantische Rollenwerte', () => {
  const tokens = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');

  const expectedTokens = [
    ['--type-hero-mobile', '1.5rem'],
    ['--type-hero-desktop', '1.875rem'],
    ['--type-page-title-mobile', '1.375rem'],
    ['--type-page-title-desktop', '1.75rem'],
    ['--type-section-title', '1.125rem'],
    ['--type-card-title', '1rem'],
    ['--type-body', '1rem'],
    ['--type-secondary', '0.875rem'],
    ['--type-caption', '0.75rem'],
    ['--type-micro', '0.625rem'],
  ];

  for (const [token, value] of expectedTokens) {
    assert.match(
      tokens,
      new RegExp(`${token}:\\s*${value.replace('.', '\\.')}`),
      `${token} muss als fester Rollenwert ${value} definiert sein`,
    );
  }
  assert.doesNotMatch(
    tokens,
    /--type-page-title-size:\s*clamp\(/,
    'Seitentitel dürfen in der Produktoberfläche nicht fluid skalieren',
  );
  assert.match(
    tokens,
    /--text-sm:\s*0\.875rem/,
    'die kompakte Sekundärstufe muss mindestens 14px groß sein',
  );
});

test('Raster und Liste der Dokumente verwenden dieselbe Titelrolle', () => {
  const typography = readFileSync(new URL('../public/styles/typography.css', import.meta.url), 'utf8');
  const cardTitleRole = typography.match(/\.u-card-title,[\s\S]*?\{[\s\S]*?font-size:\s*var\(--type-card-title\)/);

  assert.ok(cardTitleRole, 'die Karten-Titelrolle mit semantischem Token fehlt');
  assert.match(cardTitleRole[0], /\.document-card__title/, 'Dokumentkarten fehlen in der Titelrolle');
  assert.match(cardTitleRole[0], /\.document-row__title/, 'Dokumentzeilen fehlen in der Titelrolle');
});

test('sichtbare Split-Expense-Überschriften besitzen explizite Rollen', () => {
  const typography = readFileSync(new URL('../public/styles/typography.css', import.meta.url), 'utf8');

  assert.match(
    typography,
    /\.split-group-header h2[\s\S]*?font-size:\s*var\(--type-section-title\)/,
    'Gruppenüberschriften dürfen nicht auf die Browser-Standardgröße zurückfallen',
  );
  assert.match(
    typography,
    /\.split-card h3[\s\S]*?font-size:\s*var\(--type-card-title\)/,
    'Kartenüberschriften dürfen nicht auf die Browser-Standardgröße zurückfallen',
  );
});

test('Settings zeigen auf Leaf-Seiten nur den Leaf-Titel als sichtbare Hauptüberschrift', () => {
  const shell = readFileSync(new URL('../public/settings/shell.js', import.meta.url), 'utf8');
  const settingsCss = readFileSync(new URL('../public/styles/settings.css', import.meta.url), 'utf8');

  assert.match(
    shell,
    /classList\.toggle\('settings-page--leaf',\s*Boolean\(activeLeaf\)\)/,
    'die Settings-Shell muss Leaf-Seiten für die eindeutige Titelhierarchie markieren',
  );
  assert.match(
    settingsCss,
    /\.settings-page--leaf\s+\.settings-shell-header\s*\{\s*display:\s*none;/,
    'der globale Settings-Titel muss auf Leaf-Seiten visuell entfallen',
  );
  assert.doesNotMatch(
    shell,
    /renderDomainsOverview[\s\S]*?settings\.mobileOverviewTitle[\s\S]*?content\.replaceChildren/,
    'die mobile Root-Übersicht darf den sichtbaren Titel Einstellungen nicht duplizieren',
  );
});

test('lange Inhalts- und interaktive Texte verwenden mindestens die Sekundärrolle', () => {
  const dashboard = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const notes = readFileSync(new URL('../public/styles/notes.css', import.meta.url), 'utf8');
  const recipes = readFileSync(new URL('../public/styles/recipes.css', import.meta.url), 'utf8');
  const calendar = readFileSync(new URL('../public/styles/calendar.css', import.meta.url), 'utf8');

  for (const selector of [
    '.widget__link',
    '.event-item__time',
    '.meal-slot__title',
    '.shopping-widget-item',
    '.note-item__content',
    '.budget-widget__footer',
  ]) {
    assert.match(
      dashboard,
      new RegExp(`${selector.replace('.', '\\.')}[\\s\\S]*?font-size:\\s*var\\(--type-secondary\\)`),
      `${selector} muss mindestens die 14px-Sekundärrolle verwenden`,
    );
  }
  assert.match(
    notes,
    /\.note-card__content[\s\S]*?font-size:\s*var\(--type-body\)/,
    'Notiz-Fließtext muss die 16px-Bodyrolle verwenden',
  );
  for (const selector of ['.recipe-card__notes', '.recipe-card__ingredient']) {
    assert.match(
      recipes,
      new RegExp(`${selector.replace('.', '\\.')}[\\s\\S]*?font-size:\\s*var\\(--type-body\\)`),
      `${selector} muss die 16px-Bodyrolle verwenden`,
    );
  }
  assert.match(
    calendar,
    /\.cal-toolbar__view-btn[\s\S]*?font-size:\s*var\(--type-secondary\)/,
    'interaktive Kalender-Ansichtsschalter müssen mindestens 14px groß sein',
  );
});

test('globale Toolbar- und Kartentitel folgen den semantischen Rollen', () => {
  const layout = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const typography = readFileSync(new URL('../public/styles/typography.css', import.meta.url), 'utf8');

  // Canonical Page Head: der Modul-Toolbartitel folgt der 20px-Rolle in
  // typography.css (gemeinsam mit Settings-Leaf + Split), nicht mehr der
  // Abschnittsrolle (18px) in layout.css.
  assert.match(
    typography,
    /\.page-toolbar__title[\s\S]*?font-size:\s*var\(--type-toolbar-title\)/,
    'Modul-Toolbartitel müssen die Canonical-Page-Head-Rolle (--type-toolbar-title, 20px) verwenden',
  );
  assert.doesNotMatch(
    layout,
    /\.page-toolbar__title\s*\{[^}]*font-size:/,
    'layout.css darf die Toolbartitel-Größe nicht mehr setzen — die Rolle in typography.css ist die Quelle',
  );
  assert.doesNotMatch(
    layout,
    /@media \(max-width:\s*640px\)[\s\S]*?\.page-toolbar__title\s*\{[\s\S]*?font-size:/,
    'Toolbartitel dürfen mobil nicht auf eine kleinere semantische Stufe fallen',
  );
  assert.match(
    layout,
    /\.card__title[\s\S]*?font-size:\s*var\(--type-card-title\)/,
    'generische Kartentitel müssen die 16px-Kartentitelrolle verwenden',
  );
});

test('Such- und Schnellformular-Eingaben bleiben bei 16px', () => {
  const notes = readFileSync(new URL('../public/styles/notes.css', import.meta.url), 'utf8');
  const contacts = readFileSync(new URL('../public/styles/contacts.css', import.meta.url), 'utf8');
  const shopping = readFileSync(new URL('../public/styles/shopping.css', import.meta.url), 'utf8');

  assert.doesNotMatch(
    notes,
    /\.notes-toolbar__search-input\s*\{\s*font-size:\s*var\(--text-sm\)/,
    'die Notizsuche darf auf Desktop nicht unter 16px fallen',
  );
  assert.doesNotMatch(
    contacts,
    /\.contacts-toolbar__search-input\s*\{\s*font-size:\s*var\(--text-sm\)/,
    'die Kontaktsuche darf auf Desktop nicht unter 16px fallen',
  );
  for (const selector of ['quick-add__qty', 'quick-add__cat']) {
    assert.doesNotMatch(
      shopping,
      new RegExp(`\\.${selector}\\s*\\{\\s*font-size:\\s*var\\(--text-sm\\)`),
      `${selector} darf auf Desktop nicht unter 16px fallen`,
    );
  }
});
