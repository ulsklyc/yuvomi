/**
 * Typografie-Guard.
 * Hält die Phase-1–3-Konsolidierung dauerhaft: Schriftgröße und Letter-Spacing
 * dürfen nur über Tokens (var(--…)) gesetzt werden, niemals als roher px/rem/em-
 * Wert. Verhindert das erneute Auseinanderdriften der Module.
 *
 * Erlaubt:
 *   - var(--…) (auch mit Fallback)
 *   - 0, normal, inherit
 *   - reset.css: die 1rem-Basis (font-size: 100%) — Fundament der rem-Skala,
 *     folgt der Browser-Schriftgrößen-Einstellung (WCAG 1.4.4)
 *   - tokens.css: die Token-Definitionen selbst
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { eachRule } from './css-rules.js';

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

/**
 * Prueft die Schriftrolle eines Selektors ueber SEINE Regeln.
 *
 * Der Vorgaenger war `new RegExp(selector + '[\\s\\S]*?font-size: var(--rolle)')`
 * ueber die ganze Datei - und der ist unbegrenzt: der Lazy-Match ueberspringt
 * die eigene Regel des Selektors und laeuft bis zur naechsten passenden
 * Deklaration IRGENDWO danach. Nachgestellt: setzt man .widget__link in
 * dashboard.css auf --type-micro, bleibt die Assertion gruen, weil der Match
 * bei einer fremden Regel weiter unten faellig wird. Behauptet wurde "dieser
 * Selektor traegt die Rolle", geprueft wurde "der Klassenname steht irgendwo
 * vor irgendeiner passenden Deklaration".
 *
 * Drei Zusagen statt einer, alle drei ueber `eachRule` (der kennt den
 * Regelkontext und steigt korrekt in @media ab):
 *   1. Der Selektor existiert ueberhaupt. Ein Guard auf einem Selektor, den es
 *      nicht mehr gibt, ist vakuum-wahr und faellt nie wieder um.
 *   2. Mindestens eine seiner Regeln setzt die erwartete Rolle.
 *   3. KEINE seiner Regeln setzt eine abweichende font-size - auch nicht in
 *      einer Media-Query. Das deckt zusaetzlich ab, was vorher als eigene
 *      doesNotMatch-Assertion danebenstand.
 */
function assertTypeRole(css, file, selector, token, message, alsoAllowed = []) {
  // Der gesuchte Ausdruck muss das ZIEL des Selektors sein, nicht ein Vorfahre
  // darin: `.note-item__content .note-md-p { font-size: inherit }` setzt die
  // Groesse der Kinder und sagt nichts ueber die Rolle des Containers. Deshalb
  // muss der Komma-Teil auf den Ausdruck enden - nachfolgende Pseudoklassen und
  // Attributselektoren zaehlen noch dazu, ein weiteres Compound nicht mehr.
  // Funktioniert dadurch fuer `.widget__link` wie fuer `.split-card h3`.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const targets = new RegExp(`${escaped}(?![\\w-])(?:[:[][^\\s]*)*$`);
  const targetsSelector = (selectorText) => selectorText
    .split(',')
    .some((part) => targets.test(part.trim().replace(/\s+/g, ' ')));

  const rules = [...eachRule(css)].filter((rule) => targetsSelector(rule.selector));

  assert.ok(
    rules.length > 0,
    `${selector} kommt in ${file} in keiner Regel vor. Der Guard prueft damit nichts - `
    + 'wurde die Klasse umbenannt oder entfernt?',
  );

  const sizes = rules.flatMap((rule) => [...rule.body.matchAll(/font-size:\s*([^;]+)/g)]
    .map((m) => ({ value: m[1].trim(), where: rule.at.length ? `${rule.at.join(' / ')} { ${rule.selector} }` : rule.selector })));

  assert.ok(
    sizes.some(({ value }) => value === `var(${token})`),
    `${message}\n  ${selector} in ${file} setzt ${token} in keiner seiner ${rules.length} Regeln.`
    + `\n  Gefunden: ${sizes.map((s) => s.value).join(', ') || '(gar keine font-size)'}`,
  );

  // `inherit`/`0`/`normal` sind keine konkurrierende Groesse, sondern die
  // ausdrueckliche Weitergabe der geerbten - sie widersprechen der Rolle nicht.
  // `alsoAllowed` ist fuer den Fall, dass ein Selektor in einem Breakpoint
  // bewusst eine ZWEITE Rolle traegt (der Modul-Kopftitel wird mobil zum Large
  // Title). Die Ausnahme steht am Aufrufort und muss dort begruendet sein - im
  // Helper waere sie eine unsichtbare Aufweichung fuer alle.
  const NEUTRAL = new Set(['inherit', 'unset', 'revert', '0', 'normal']);
  const allowed = new Set([`var(${token})`, ...alsoAllowed.map((t) => `var(${t})`)]);
  const wrong = sizes.filter(({ value }) => !allowed.has(value) && !NEUTRAL.has(value));
  assert.deepEqual(
    wrong.map((w) => `${w.where}: font-size: ${w.value}`),
    [],
    `${message}\n  ${selector} in ${file} setzt daneben eine abweichende Groesse - `
    + 'die spaetere gewinnt, die Rolle ist dann nur noch behauptet.',
  );
}

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

/**
 * Die Grenze gehoert der GROSSEN Seite: aufwaerts `min-width: 640px`, abwaerts
 * `max-width: 639px`. Ein `max-width` exakt AUF einem Kanonwert laesst bei
 * dieser Breite beide Seiten zugleich gelten - gemessen bei 640px: mobile
 * Kompaktregeln UND 3-Spalten-Kanban gleichzeitig (Audit 2026-08-31; 33
 * Fundstellen in 15 Dateien, waehrend 768/1024 laengst korrekt als 767/1023
 * gepaart waren). Regel statt Liste: keine Media-Query darf ein max-width auf
 * einem der vier Kanonwerte fuehren.
 *
 * NUR IM PRELUDE, UND DAS IST DIE KORREKTUR AN DIESEM GUARD SELBST. Die erste
 * Fassung suchte `max-width: 640px` IRGENDWO im Stylesheet und traf damit zwei
 * Deklarationen, die keine Schwelle sind: `.budget-tab-panel--reading` und
 * `.perm-matrix` fuehren eine Lesespaltenbreite. Bei denen gibt es keine zweite
 * Seite, mit der sie sich ueberlappen koennten - die Paarungsregel gilt fuer
 * Viewport-Grenzen, nicht fuer Elementbreiten. Der Sweep hat beide auf 639px
 * gezogen, WEIL der Guard sie rot faerbte; ein Guard, der beim Richtigstellen
 * rot wird, prueft die Schreibweise statt der Sache.
 */
test('kein max-width einer Media-Query sitzt exakt auf einem Breakpoint-Kanonwert', () => {
  const violations = [];
  for (const file of cssFiles) {
    const css = stripComments(readFileSync(new URL(file, STYLES_DIR), 'utf8'));
    for (const at of css.matchAll(/@media([^{]*)\{/g)) {
      for (const bp of [640, 768, 1024, 1440]) {
        if (!new RegExp(`max-width:\\s*${bp}px`).test(at[1])) continue;
        const line = css.slice(0, at.index).split('\n').length;
        violations.push(`${file}:${line} → @media max-width: ${bp}px (Paarung: ${bp - 1}px)`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `max-width auf Kanonwert - die Grenze gehoert der grossen Seite (min-width):\n${violations.join('\n')}`,
  );
});

/**
 * Die Rollen-Schicht traegt, was sie als REGEL fuehrt - nicht, was ihr
 * Kommentar erwaehnt.
 *
 * Die Vorfassung prüfte `typography.includes('.u-eyebrow')` und war damit
 * ZWEIMAL falsch. Erstens las sie Kommentare mit: `.u-eyebrow` steht seit dem
 * HIG-Rollout nur noch in dem Absatz, der sein ENTFALLEN begruendet
 * (typography.css:139) - der Guard war gruen auf einer Fundstelle, die das
 * Gegenteil seiner Zusage belegt. Zweitens verlangte er damit ausgerechnet die
 * Klasse, die die Echte-Information-Regel VERBIETET: „Dekorative Kicker und
 * Eyebrows ohne Informationswert bleiben verboten; die generische Opt-in-Klasse
 * dafuer ist mit dem Rollout entfallen, weil ihr Name zur Rueckkehr des Musters
 * einlud." Ein Guard, der ein Verbot als Pflicht fuehrt, haelt die Tuer auf.
 *
 * Deshalb laeuft die Pruefung ueber `eachRule()` statt ueber `includes()`:
 * gezaehlt wird nur, was als Selektor einer Regel dasteht.
 */
test('die Typografie-Rollen-Schicht steht als Regel, und der Eyebrow bleibt entfallen', () => {
  const typography = readFileSync(new URL('../public/styles/typography.css', import.meta.url), 'utf8');
  const selectors = [...eachRule(typography)].flatMap(({ selector }) => selector.split(','))
    .map((part) => part.trim());

  for (const role of ['.u-card-title', '.u-section-title', '.u-page-title']) {
    const declared = selectors.some((selector) => new RegExp(`(^|[\\s>+~])\\${role}([\\s.:[]|$)`).test(selector));
    assert.ok(declared, `Rollen-Klasse ${role} steht in typography.css in keiner Regel (nur ein Kommentar zaehlt nicht)`);
  }

  const eyebrow = selectors.filter((selector) => /(^|[\s>+~])\.u-eyebrow([\s.:[]|$)/.test(selector));
  assert.deepEqual(
    eyebrow,
    [],
    'Die Echte-Information-Regel verbietet die generische Eyebrow-Klasse - sie ist mit dem Rollout entfallen und darf nicht zurueckkehren',
  );

  const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(
    indexHtml.includes('styles/typography.css'),
    'typography.css ist nicht in index.html eingebunden',
  );
});

/**
 * Und sie bleibt auch aus dem MARKUP weg. Ein Guard nur ueber das Stylesheet
 * haette den Ruecksprung durch die andere Tuer gelassen: eine Klasse ohne Regel
 * ist stumm, aber sie ist der Wiedereinstieg - erst steht sie im Markup, dann
 * „fehlt" ihr Stil.
 */
test('kein Markup greift die entfallene Eyebrow-Klasse wieder auf', () => {
  const roots = ['../public/pages/', '../public/components/', '../public/settings/', '../public/utils/'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory()) { walk(`${path}/`); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (/\bu-eyebrow\b/.test(readFileSync(new URL(path, import.meta.url), 'utf8'))) offenders.push(path);
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, [], `u-eyebrow ist entfallen und steht wieder im Markup:\n${offenders.join('\n')}`);
});

/**
 * Die Kopf-Titelrolle (Canonical Page Head) ist seit 2026-08-31 nicht mehr
 * frei adressierbar: die einzige Utility-Vergabe außerhalb der Shell waren
 * acht Sektionsköpfe des Gesundheitsmoduls - drei Hierarchie-Ebenen
 * kollabierten auf eine, und keine der übrigen 20+ Seiten hatte die Klasse je
 * gebraucht. Die Rolle beziehen NUR die konkreten Shell-Klassen in
 * typography.css (page-toolbar, dock, Settings, Split, Sub-Tabs-Leiste).
 * Regel statt Allowlist, und über BEIDE Türen: kein Stylesheet deklariert die
 * Utility-Klasse, kein Markup vergibt sie - eine Klasse ohne Regel wäre stumm,
 * aber der Wiedereinstieg (siehe den Eyebrow-Guard direkt darüber).
 */
test('die Kopf-Titelrolle ist nicht frei adressierbar (u-toolbar-title bleibt entfallen)', () => {
  for (const file of cssFiles) {
    const css = stripComments(readFileSync(new URL(file, STYLES_DIR), 'utf8'));
    const declaring = [...eachRule(css)].flatMap(({ selector }) => selector.split(','))
      .map((part) => part.trim())
      .filter((part) => /(^|[\s>+~])\.u-toolbar-title([\s.:[]|$)/.test(part));
    assert.deepEqual(
      declaring,
      [],
      `${file} deklariert .u-toolbar-title - die Kopf-Titelrolle gehört den Shell-Klassen in typography.css`,
    );
  }

  const roots = ['../public/pages/', '../public/components/', '../public/settings/', '../public/utils/'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory()) { walk(`${path}/`); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (/\bu-toolbar-title\b/.test(readFileSync(new URL(path, import.meta.url), 'utf8'))) offenders.push(path);
    }
  };
  for (const root of roots) walk(root);
  for (const single of ['../public/router.js', '../public/index.html', '../public/offline.html']) {
    if (/\bu-toolbar-title\b/.test(readFileSync(new URL(single, import.meta.url), 'utf8'))) offenders.push(single);
  }
  assert.deepEqual(
    offenders,
    [],
    `u-toolbar-title ist entfallen - die Kopf-Titelrolle wird nur über Shell-Klassen bezogen:\n${offenders.join('\n')}`,
  );
});

test('die Produkt-Typografie nutzt feste semantische Rollenwerte', () => {
  const tokens = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');

  // Apple-Typo-Skala (HIG-Rollout 2026-08, DESIGN.md „Typography"): Large Title
  // 34 / Title 2 22 / Title 3 20 / Headline 17 / Body 17 / Subheadline 15 /
  // Footnote 13 / Caption 2 11. Die abgelöste Reihe (Hero 24→30, Body 16) war
  // die eigene Skala des Violett-Glas-Hybrids.
  //
  // Hero UND Page-Title stehen bewusst auf demselben Wert: in der HIG-Welt ist
  // der Dashboard-Gruß derselbe Large Title wie jeder Seitentitel, und er wächst
  // auf dem Desktop NICHT mit - die Überschriften-Skala endet bei 34px.
  const expectedTokens = [
    ['--type-hero-mobile', '2.125rem'],
    ['--type-hero-desktop', '2.125rem'],
    ['--type-page-title-mobile', '2.125rem'],
    ['--type-page-title-desktop', '2.125rem'],
    ['--type-toolbar-title', '1.375rem'],
    ['--type-section-title', '1.25rem'],
    ['--type-card-title', '1.0625rem'],
    ['--type-body', '1.0625rem'],
    ['--type-secondary', '0.9375rem'],
    ['--type-caption', '0.8125rem'],
    ['--type-micro', '0.6875rem'],
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

  // Klassen statt Tags: eingebettet rendert die Seite <h3>/<h4>, sonst <h2>/<h3> (#1148).
  assertTypeRole(typography, 'typography.css', '.split-group-name', '--type-section-title',
    'Gruppenüberschriften dürfen nicht auf die Browser-Standardgröße zurückfallen');
  // Seit R16 Schritt 2b stehen Salden, Ausgaben und Verlauf als Abschnittstitel
  // auf der Buehne (`.u-section-title`), nicht mehr als Kartentitel in der Flaeche.
  assertTypeRole(typography, 'typography.css', '.u-section-title', '--type-section-title',
    'Abschnittsüberschriften dürfen nicht auf die Browser-Standardgröße zurückfallen');
  assert.doesNotMatch(typography, /\.split-card-title/, 'die Kartentitel-Rolle der Aufteilung ist entfallen');
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

test('Settings-Blätter wiederholen ihren eigenen Titel nicht als Unterüberschrift', async () => {
  // Der Test darüber prüft nur, dass die Shell ihren globalen Titel versteckt.
  // Er hat nie gesehen, dass ein Blatt seinen EIGENEN Titel direkt darunter als
  // h2 wiederholt - fünf taten es, eines sogar mit demselben i18n-Key. Die Suite
  // war grün und der Defekt drei Critique-Läufe lang vorhanden (2026-07-27).
  // Seit R10 besteht ein Blatt aus Abschnitten (fruehere Blaetter, je ein
  // Loader): geprueft wird jeder Abschnitt gegen den Titel SEINES Blatts.
  const { SETTINGS_LEAVES, settingsSheetSections } = await import('../public/settings/registry.js');
  const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
  const translate = (key) => key.split('.').reduce((value, segment) => value?.[segment], de);
  const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  const failures = [];
  let seen = 0;
  for (const leaf of SETTINGS_LEAVES) {
    const label = normalize(translate(leaf.labelKey));
    for (const section of settingsSheetSections(leaf, null, { all: true })) {
      const file = String(section.loader).match(/\/settings\/(pages\/[\w-]+\.js)/)?.[1];
      assert.ok(file, `${section.id}: Loader-Pfad nicht erkennbar`);
      seen += 1;
      const source = readFileSync(new URL(`../public/settings/${file}`, import.meta.url), 'utf8');

      // Statische Überschriften im Markup: <h2 …>${t('key')}</h2>, auch via esc().
      for (const match of source.matchAll(/<h([23])\b[^>]*>\s*\$\{(?:esc\()?\s*t\(\s*['"]([\w.]+)['"]/g)) {
        const [, level, key] = match;
        if (normalize(translate(key)) === label) {
          failures.push(`${leaf.id}/${section.id}: <h${level}> wiederholt den Blatt-Titel "${translate(key)}" (${key})`);
        }
      }
    }
  }
  assert.ok(seen >= 30, `nur ${seen} Abschnitte gelesen`);
  assert.deepEqual(failures, []);
});

test('kein sichtbarer Titel wiederholt den Namen eines Tabs seiner eigenen Leiste', async () => {
  // WAS SICH GEÄNDERT HAT (Redesign Runde 6, Phase 2): Dieser Guard las bis
  // hierher ZWEI fest verdrahtete Dateien - health-tabs.js und health.js. Sein
  // eigener Kommentar sagte, „eine Regel, die nur eine Modulfamilie kennt, ist
  // eine Allowlist", und behob das, indem er eine ZWEITE Familie aufnahm. Das
  // ist eine Allowlist mit zwei Einträgen. Er prüft jetzt JEDES Modul, das eine
  // Leiste rendert, und leitet Leiste wie Überschriften aus dem Markup ab.
  //
  // Gemessener Anlass für die Verallgemeinerung: das Budget zeigte live genau
  // die Verdopplung, die der Guard verbietet - Titel „Budget" über einem Tab
  // „Budget". Kein Bericht hat sie gemeldet; der erste Lauf der Regel fand sie.
  //
  // Erlaubt bleibt die UNSICHTBARE Wiederholung: die Überschrift hält die
  // Dokumentgliederung zwischen dem h1 des Moduls und den h3 der Abschnitte.
  // Verboten ist nur, sie zu ZEIGEN.
  const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
  const translate = (key) => key.split('.').reduce((value, segment) => value?.[segment], de);
  const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  // Quellen je Seite: die Seitendatei plus ihre eigenen /utils/-Importe. Dort
  // liegen die geteilten Leisten (health-tabs.js, kitchen-tabs.js); die Module
  // stehen nicht als Liste im Test.
  const readPublic = (path) => readFileSync(new URL(`../public${path}`, import.meta.url), 'utf8');
  const pageFiles = readdirSync(new URL('../public/pages/', import.meta.url))
    .filter((name) => name.endsWith('.js'));

  const failures = [];
  let barsSeen = 0;

  for (const name of pageFiles) {
    const page = readPublic(`/pages/${name}`);
    const sources = [page];
    for (const m of page.matchAll(/from\s+'(\/utils\/[\w./-]+\.js)'/g)) {
      try { sources.push(readPublic(m[1])); } catch { /* nicht aufloesbar */ }
    }

    // 1. Die Labels der Leiste. Zwei Bauarten, beide über ihre Signatur
    //    gefunden statt über einen Helfernamen:
    //    (a) deklarative Tab-Listen tragen `route:` UND `labelKey:` im selben
    //        Eintrag. Das `route:` gehört zur Signatur: ein blosses
    //        `labelKey:` trägt auch jede Optionsliste (ACTIVITY_TYPES in
    //        health-activity.js hat sieben davon), und die sind keine Tabs.
    //    (b) Markup-Leisten tragen ihre Labels als `t('x.y')` INNERHALB des
    //        Elements mit role="tablist" - auch dann, wenn ein Helfer sie
    //        entgegennimmt (`${renderTabButton('id', 'icon', t('x.y'))}`).
    const labelKeys = new Set();
    for (const src of sources) {
      for (const entry of src.matchAll(/\{[^{}]*\}/g)) {
        if (!/\broute:\s*['"]/.test(entry[0])) continue;
        const key = entry[0].match(/\blabelKey:\s*['"]([\w.]+)['"]/)?.[1];
        if (key) labelKeys.add(key);
      }
      for (const m of src.matchAll(/role="tablist"/g)) {
        const open = src.indexOf('>', m.index);
        if (open === -1) continue;
        const rest = src.slice(open + 1);
        const end = Math.min(
          ...[rest.indexOf('</nav>'), rest.indexOf('</div>')].filter((i) => i >= 0),
          rest.length,
        );
        for (const label of rest.slice(0, end).matchAll(/\bt\(\s*['"]([\w.]+)['"]/g)) {
          labelKeys.add(label[1]);
        }
      }
    }
    if (!labelKeys.size) continue;
    barsSeen += 1;

    const tabLabels = new Set([...labelKeys].map((key) => normalize(translate(key))).filter(Boolean));

    // 2. Alle SICHTBAREN Überschriften der Seite. `panel.titleKey` ist die
    //    Schleifenvariable über alle Panels - ihre Werte sind genau die Titel,
    //    die auch die Leiste führt.
    //
    //    BEWUSST JE SEITE, NICHT JE LEISTE: eine Seite kann mehrere Leisten
    //    tragen (die Gesundheit hat neben den Sub-Tabs je Panel eine
    //    Personen- und eine Zeitraum-Reihe), und ihre Labels landen in einem
    //    Topf. Das ist strenger als der Regelsatz - gemeldet wird auch eine
    //    Überschrift, die den Namen einer NACHBAR-Leiste trägt. Es bleibt
    //    richtig: zwei wortgleiche Beschriftungen auf einer Seite benennen
    //    keine Ebene, egal welche Leiste die zweite führt.
    for (const match of page.matchAll(/<h([1-3])\b([^>]*)>\s*\$\{(?:esc\()?\s*t\(\s*(?:(panel\.titleKey)|['"]([\w.]+)['"])/g)) {
      const [, level, attrs, loopVar, key] = match;
      if (/\bsr-only\b/.test(attrs)) continue;
      const titles = loopVar ? [...tabLabels] : [normalize(translate(key))];
      for (const title of titles) {
        if (title && tabLabels.has(title)) {
          failures.push(`${name}: sichtbares <h${level}> wiederholt den Leisten-Namen „${title}"`);
        }
      }
    }
  }

  assert.ok(
    barsSeen >= 5,
    `Nur ${barsSeen} Module mit Leiste gefunden - der Guard misst dann fast nichts. `
    + 'Hat sich die Schreibweise der Tab-Leisten geändert?',
  );
  assert.deepEqual(failures, []);
});

test('kein sichtbarer Titel wiederholt den Namen des gewählten Eintrags einer Auswahlleiste', () => {
  // DIE ZWEITE HÄLFTE DERSELBEN REGEL. Der Guard darüber vergleicht ÜBERSETZTE
  // Labels - er findet „Übersicht" über „Übersicht". Der Einkauf verletzte
  // dieselbe Regel mit LAUFZEITDATEN: die Listenwahl zeigte „Wocheneinkauf" als
  // aktiven Chip, und der Kopf direkt darunter zeigte denselben Namen noch
  // einmal. Aus DREI Gründen unsichtbar für den Nachbarn: die Chip-Leiste trägt
  // kein `role="tablist"`, der Titel war kein <h1-3> (ein <span
  // class="page-toolbar__title">), und der Name ist gar kein i18n-Key, sondern
  // `state.activeList.name` - ein Wert, den kein statischer Test übersetzen
  // kann. Gemessen kostete das mobil rund 64px: /shopping lag bei 53 %
  // Contentfläche gegen 62-63 % bei /tasks und /budget.
  //
  // WAS STATT DES WERTES GEPRÜFT WIRD: die Struktur. Rendert eine Seite eine
  // Auswahlleiste über eine Sammlung (gemappte Einträge mit einem Aktivzustand)
  // UND zeigt sie dasselbe Feld des GEWÄHLTEN Eintrags noch einmal in einem
  // Titel-Slot, dann steht derselbe Text zweimal auf der Seite - unabhängig
  // davon, welchen Wert er zur Laufzeit hat. Guard-Ebene Signatur: weder
  // Dateiname noch Helfername, weder `role` noch Elementtyp.
  const readPublic = (path) => readFileSync(new URL(`../public${path}`, import.meta.url), 'utf8');
  const pageFiles = readdirSync(new URL('../public/pages/', import.meta.url))
    .filter((name) => name.endsWith('.js'));

  // Ein Titel-Slot ist, was die Shell als Titel setzt (.page-toolbar__title,
  // .panel-head__title) oder was als Überschrift ausgezeichnet ist. sr-only
  // zählt nicht: unsichtbare Wiederholung ist ausdrücklich erlaubt.
  const TITLE_SLOT = /<(?:h[1-3]|span|div|p)\b([^>]*\b(?:page-toolbar__title|panel-head__title|list-header__name)\b[^>]*|[^>]*)>\s*\$\{(?:esc\()?\s*([\w.?[\]]+)/g;
  const HEADING = /<h[1-3]\b([^>]*)>\s*\$\{(?:esc\()?\s*([\w.?[\]]+)/g;

  const failures = [];
  let barsSeen = 0;

  for (const name of pageFiles) {
    const page = readPublic(`/pages/${name}`);

    // 1. Auswahlleisten: eine Sammlung wird zu Einträgen gemappt, und einer
    //    davon trägt einen Aktivzustand. Beides muss im selben map()-Ausdruck
    //    stehen - eine Liste ohne Auswahlzustand ist keine Leiste, und ein
    //    Aktivzustand ohne Sammlung ist ein einzelner Knopf.
    const selected = new Map();   // Feldname -> Set der Sammlungen
    for (const m of page.matchAll(/\b(?:state\.)?(\w+)\s*\.map\(\s*\(?\s*(\w+)/g)) {
      const [, collection, item] = m;
      const body = page.slice(m.index, m.index + 900);
      // NUR ECHTE ZUSTANDSMARKER. Ein blosses `selected` stand hier zuerst und
      // machte das `<option selected>` des Quick-Add zur „Auswahlleiste": der
      // Befund im Einkauf war richtig, nannte aber `categories` als Quelle
      // statt `lists`. Ein Guard, der aus dem falschen Grund recht hat, schickt
      // den nächsten Leser in die falsche Datei.
      if (!/--active\b|aria-selected|\bis-active\b|aria-current/.test(body)) continue;
      // Welches Feld beschriftet den Eintrag?
      for (const label of body.matchAll(new RegExp(`\\$\\{(?:esc\\()?\\s*${item}\\.(\\w+)`, 'g'))) {
        if (!selected.has(label[1])) selected.set(label[1], new Set());
        selected.get(label[1]).add(collection);
      }
    }
    if (!selected.size) continue;
    barsSeen += 1;

    // 2. Titel-Slots, die ein Feld des GEWÄHLTEN Eintrags zeigen. „Gewählt"
    //    erkennt man am Bezeichner: state.activeList, state.selectedAccount,
    //    state.currentBoard - die Schreibweise, die dieses Repo durchgängig
    //    verwendet.
    for (const pattern of [TITLE_SLOT, HEADING]) {
      pattern.lastIndex = 0;
      for (const m of page.matchAll(pattern)) {
        const [, attrs, expression] = m;
        if (/\bsr-only\b/.test(attrs)) continue;
        const field = expression.match(/\b(?:active|selected|current)\w*\??\.(\w+)$/i)?.[1];
        if (!field || !selected.has(field)) continue;
        const bars = [...selected.get(field)].join('`, `');
        failures.push(
          `${name}: sichtbarer Titel zeigt \`${expression}\` - dasselbe Feld beschriftet `
          + `bereits den aktiven Eintrag der Auswahlleiste über \`${bars}\`. `
          + 'Der gewählte Eintrag IST der Titel; was der Kopf sonst trägt, gehört neben ihn.',
        );
      }
    }
  }

  assert.ok(
    barsSeen >= 1,
    `Keine Auswahlleiste mit Aktivzustand gefunden (${barsSeen}) - der Guard misst dann nichts. `
    + 'Hat sich die Schreibweise der gemappten Leisten geändert?',
  );
  assert.deepEqual(failures, []);
});

test('lange Inhalts- und interaktive Texte verwenden mindestens die Sekundärrolle', () => {
  const dashboard = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const notes = readFileSync(new URL('../public/styles/notes.css', import.meta.url), 'utf8');
  const recipes = readFileSync(new URL('../public/styles/recipes.css', import.meta.url), 'utf8');
  const calendar = readFileSync(new URL('../public/styles/calendar.css', import.meta.url), 'utf8');

  for (const selector of [
    '.widget__link',
    // `.event-item__time` ist seit DW-P1-4 die Metazeile der Terminzeile
    // (`.list-row__meta`, Footnote 13 - R21 D4); gehalten von "R21 S5 + DW-P1-4".
    '.meal-slot__title',
    '.shopping-widget-item',
    '.note-item__content',
    '.budget-widget__footer',
  ]) {
    assertTypeRole(dashboard, 'dashboard.css', selector, '--type-secondary',
      `${selector} muss mindestens die 14px-Sekundärrolle verwenden`);
  }
  assertTypeRole(notes, 'notes.css', '.note-card__content', '--type-body',
    'Notiz-Fließtext muss die 16px-Bodyrolle verwenden');
  // Umbenannt mit dem Wechsel von der Rezeptkarte zur Rezeptzeile mit
  // Aufklapp-Detail: die Fließtext-Rolle gilt jetzt für den Detail-Inhalt.
  for (const selector of ['.recipe-detail__notes', '.recipe-detail__ingredient']) {
    assertTypeRole(recipes, 'recipes.css', selector, '--type-body',
      `${selector} muss die 16px-Bodyrolle verwenden`);
  }
  // Die Kalender-Ansichtswahl ist das Segment der Shell und schreibt seit R22
  // (D8) wie jedes Segment 14px (`--text-sm` an `.segmented__item`, panel.css);
  // die eigene 15px-Regel ist entfallen. Gehalten wird hier, dass sie nicht
  // zurueckkommt - die Mindestgroesse steht an der Segment-Regel.
  const panel = readFileSync(new URL('../public/styles/panel.css', import.meta.url), 'utf8');
  assertTypeRole(panel, 'panel.css', '.segmented__item', '--text-sm',
    'Segmente schreiben ueberall 14px - die Kompakt-Interaktion, nicht kleiner');
  const ownCalSize = [...eachRule(calendar)]
    .filter((r) => r.selector.split(',').some((x) => /\.cal-toolbar__view-btn(?![\w-])/.test(x)) && /font-size:/.test(r.body));
  assert.deepEqual(ownCalSize.map((r) => r.selector.trim()), [],
    'die Kalender-Ansichtswahl setzt wieder eine eigene Schriftgroesse - Segmente schreiben ueberall 14px');
});

test('globale Toolbar- und Kartentitel folgen den semantischen Rollen', () => {
  const layout = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const typography = readFileSync(new URL('../public/styles/typography.css', import.meta.url), 'utf8');

  // Canonical Page Head: der Modul-Toolbartitel folgt der 20px-Rolle in
  // typography.css (gemeinsam mit Settings-Leaf + Split), nicht mehr der
  // Abschnittsrolle (18px) in layout.css.
  // Mobil traegt derselbe Titel bewusst den Large Title: --type-page-title-mobile
  // ist 34px gegen 22px, also GROESSER - die Zusage "faellt mobil auf keine
  // kleinere Stufe" bleibt damit gewahrt. Jede dritte Groesse faellt auf.
  assertTypeRole(typography, 'typography.css', '.page-toolbar__title', '--type-toolbar-title',
    'Modul-Toolbartitel müssen die Canonical-Page-Head-Rolle (--type-toolbar-title, 22px) verwenden',
    ['--type-page-title-mobile']);

  // layout.css darf die Groesse gar nicht setzen - die Rolle in typography.css
  // ist die Quelle. Deckt zugleich ab, was hier vorher als zweite Assertion mit
  // einem @media-Muster stand: `eachRule` steigt in jede At-Regel ab, also faellt
  // eine mobile Verkleinerung genauso auf wie eine auf der Basisebene.
  const toolbarTitleInLayout = [...eachRule(layout)]
    .filter((rule) => /\.page-toolbar__title(?![\w-])/.test(rule.selector))
    .flatMap((rule) => [...rule.body.matchAll(/font-size:\s*([^;]+)/g)]
      .map((m) => `${rule.at.join(' / ') || 'Basisebene'}: ${rule.selector} -> ${m[1].trim()}`));
  assert.deepEqual(
    toolbarTitleInLayout,
    [],
    'layout.css darf die Toolbartitel-Größe nicht mehr setzen - die Rolle in typography.css ist die Quelle, '
    + 'und mobil darf der Titel auf keine kleinere semantische Stufe fallen.',
  );

  assertTypeRole(layout, 'layout.css', '.card__title', '--type-card-title',
    'generische Kartentitel müssen die 16px-Kartentitelrolle verwenden');
});

test('Such- und Schnellformular-Eingaben bleiben bei 16px', () => {
  const notes = readFileSync(new URL('../public/styles/notes.css', import.meta.url), 'utf8');
  const contacts = readFileSync(new URL('../public/styles/contacts.css', import.meta.url), 'utf8');
  const shopping = readFileSync(new URL('../public/styles/shopping.css', import.meta.url), 'utf8');

  // Hier standen zwei doesNotMatch auf .notes-toolbar__search-input und
  // .contacts-toolbar__search-input. Beide Klassen existieren in keinem der 37
  // Stylesheets mehr - die Suchfelder sind zur geteilten .page-search-Komponente
  // zusammengezogen worden. Zwei Assertions, die seitdem vakuum-wahr waren und
  // es fuer immer geblieben waeren. Die Zusage gilt jetzt an der einen Stelle,
  // an der sie noch etwas bedeutet: 16px, damit iOS beim Fokus nicht zoomt.
  const pageSearch = readFileSync(new URL('../public/styles/page-search.css', import.meta.url), 'utf8');
  assertTypeRole(pageSearch, 'page-search.css', '.page-search__input', '--text-base',
    'die geteilte Seitensuche darf nicht unter 16px fallen (sonst zoomt iOS beim Fokus)');
  for (const selector of ['quick-add__qty', 'quick-add__cat']) {
    assert.doesNotMatch(
      shopping,
      new RegExp(`\\.${selector}\\s*\\{\\s*font-size:\\s*var\\(--text-sm\\)`),
      `${selector} darf auf Desktop nicht unter 16px fallen`,
    );
  }
});

// ---------------------------------------------------------------------------
// EIN WORT BRICHT NUR MIT STRICH (Re-Critique 2026-09-27, W1)
//
// `overflow-wrap: break-word | anywhere` (und `word-break: break-word |
// break-all`) erlauben dem Browser, ein Wort zu brechen, das nicht in die Zeile
// passt - und zwar an JEDER Stelle, ohne Zeichen. Gemessen: „Tomatensupp / e"
// im Essensplan, „SAUERSTOFFSÄTTI / GUNG" in der Gesundheit, „AUFMERKSAMKE / IT"
// im Inventar. `hyphens: auto` fragt vorher das Silbenwoerterbuch der
// Dokumentsprache (lang folgt der Locale, i18n.js) und setzt den Strich an eine
// Silbengrenze; break-word bleibt dann die letzte Stufe fuer Woerter ohne
// Trennstelle.
//
// Die Regel, nicht die Schreibweise: gefragt wird, ob eine Regel, die ein Wort
// brechen LAESST, fuer ihr Subjekt (die letzte Klasse des Selektors) auch die
// Silbentrennung hat - in derselben Regel, in einer Basisregel desselben
// Subjekts oder in einer Regel im selben @media-Kontext. Kommentare zaehlen
// nicht (eachRule entfernt sie), und ein `hyphens: auto` in einer Media-Query
// deckt die Basis NICHT - mobil bricht sonst, was am Desktop trennt.
// ---------------------------------------------------------------------------

/** Letzter Wert einer Eigenschaft im Rumpf einer Regel (die spaetere gewinnt). */
function lastDeclaration(body, prop) {
  const all = [...body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, 'g'))];
  return all.length ? all[all.length - 1][1].trim() : '';
}

/**
 * Jede Regel je Komma-Teil mit ihrem Subjekt: der letzten Klasse des letzten
 * Compounds. Argumente von Pseudoklassen zaehlen nicht - in
 * `.btn:not(.btn--icon)` ist das Subjekt `.btn`, nicht die ausgeschlossene
 * Klasse.
 */
function wordBreakRules() {
  const out = [];
  for (const file of cssFiles) {
    const css = readFileSync(new URL(file, STYLES_DIR), 'utf8');
    for (const { selector, body, at } of eachRule(css)) {
      const overflowWrap = lastDeclaration(body, 'overflow-wrap');
      const wordBreak = lastDeclaration(body, 'word-break');
      const hyphens = lastDeclaration(body, 'hyphens');
      const whiteSpace = lastDeclaration(body, 'white-space');
      for (const part of selector.split(',')) {
        const sel = part.trim().replace(/\s+/g, ' ');
        let compound = sel.split(/[\s>+~]+/).pop();
        // Pseudoklassen-Argumente bis zur Stabilitaet entfernen (verschachtelt).
        for (let prev = ''; prev !== compound;) {
          prev = compound;
          compound = compound.replace(/:[\w-]+\([^()]*\)/g, '');
        }
        const subject = (compound.match(/\.[\w-]+/g) ?? []).pop();
        if (!subject) continue;
        out.push({
          file, selector: sel, subject, context: at.join(' | '),
          breaks: /break-word|anywhere/.test(overflowWrap) || /break-word|break-all/.test(wordBreak),
          hyphens,
          // Eine Regel, die gar nicht umbricht, braucht keinen Strich.
          keepsWhole: /nowrap/.test(whiteSpace) || overflowWrap === 'normal',
        });
      }
    }
  }
  return out;
}

/**
 * Brechende Regeln OHNE Silbentrennung - der eingefrorene Bestand. Die Karte darf
 * nur schrumpfen: ein neuer Eintrag ist rot, ein erfuellter auch.
 *
 * NO_SYLLABLES  Der Inhalt hat keine Silben: Adresse, Link, Datei- oder
 *               Pfadname, Zahl. Ein Trennstrich darin waere eine Falschauskunft
 *               (ein „-" mitten in einer URL gehoert zur URL). Dauerhaft.
 * DELIBERATE    Am Ort begruendete Asymmetrie (Datei nennen, Kommentar dort).
 * LEGACY        Text mit Silben, der noch ohne Trennung bricht. Wer die Datei
 *               anfasst, zieht `hyphens: auto; hyphenate-limit-chars: 6 4 4`
 *               nach und streicht den Eintrag.
 */
const BREAKS_WITHOUT_HYPHENS = {
  '.contact-detail__link': 'NO_SYLLABLES',
  '.document-dropzone__file': 'NO_SYLLABLES',
  '.folder-upload-preview': 'NO_SYLLABLES',
  '.folder-upload-tree__name': 'NO_SYLLABLES',
  '.fasting-widget__timer': 'NO_SYLLABLES',
  '.fasting-hero__timer': 'NO_SYLLABLES',
  '.inventory-detail-list__link': 'NO_SYLLABLES',
  '.caldav-calendar-source': 'NO_SYLLABLES',
  '.item-details__link': 'NO_SYLLABLES',
  '.note-md-link': 'NO_SYLLABLES',
  // list-row.css: „NUR HIER, NICHT AN DER METAZEILE" - hyphens: auto wuerde dort
  // auch trennen, wo ein Umbruch an einer Leerstelle moeglich ist.
  '.list-row__meta': 'DELIBERATE',
  '.btn': 'LEGACY',
  '.calendar-all-day-label': 'LEGACY',
  '.contact-card__sub': 'LEGACY',
  '.detail-row__value': 'LEGACY',
  '.document-dropzone__hint': 'LEGACY',
  '.documents-folder-browser__toggle-label': 'LEGACY',
  '.documents-folder-item__name': 'LEGACY',
  '.document-row__title': 'LEGACY',
  '.folder-upload-tree__status': 'LEGACY',
  '.document-viewer__text': 'LEGACY',
  '.dms-preview__title': 'LEGACY',
  '.health-dose__name': 'LEGACY',
  '.health-nutrition-progress__label': 'LEGACY',
  '.health-nutrition-row__title': 'LEGACY',
  '.split-view__detail-title': 'LEGACY',
  '.note-card__title': 'LEGACY',
  '.note-category-badge__name': 'LEGACY',
  '.note-card__content': 'LEGACY',
  '.note-read__body': 'LEGACY',
  '.settings-shell__navigation-result-text': 'LEGACY',
  '.settings-info-value--danger': 'LEGACY',
  '.settings-document-storage-error': 'LEGACY',
  '.caldav-calendar-name': 'LEGACY',
  '.caldav-calendar-error': 'LEGACY',
  '.backfill-moved__title': 'LEGACY',
  '.split-group-meta': 'LEGACY',
  '.task-comment__text': 'LEGACY',
};

/** Die harte Form desselben Fehlers: ausdruecklich `hyphens: manual | none`
 *  neben einem Bruch. Ohne Ausnahme - bis auf die Wunsch-Diffs, die ein anderer
 *  Schritt anwendet (Eintrag wird dann rot und faellt weg). */
const OPT_OUT_PENDING = {};

test('wer ein Wort brechen laesst, schaltet den Strich nicht ab (W1)', () => {
  const rules = wordBreakRules();
  assert.ok(rules.filter((r) => r.breaks).length > 40,
    'kaum brechende Regeln gefunden - misst der Scanner noch?');
  const optOut = rules
    .filter((r) => /^(manual|none)\b/.test(r.hyphens) && !r.keepsWhole)
    .filter((r) => rules.some((o) => o.subject === r.subject && o.breaks))
    .map((r) => r.selector);
  const fresh = [...new Set(optOut)].filter((s) => !(s in OPT_OUT_PENDING));
  assert.deepEqual(fresh, [],
    'hyphens: manual/none neben overflow-wrap: break-word/anywhere bricht Woerter OHNE Strich '
    + '(„Tomatensupp / e"). Stattdessen hyphens: auto; hyphenate-limit-chars: 6 4 4.');
  const stale = Object.keys(OPT_OUT_PENDING).filter((s) => !optOut.includes(s));
  assert.deepEqual(stale, [], 'erfuellte Eintraege aus OPT_OUT_PENDING streichen');
});

test('ein brechendes Wort wird silbengetrennt, nicht zerhackt (W1)', () => {
  const rules = wordBreakRules();
  const hyphenated = (r) => rules.some((o) => o.subject === r.subject && /^auto\b/.test(o.hyphens)
    && (o.context === '' || o.context === r.context));
  const missing = new Map();
  for (const r of rules.filter((x) => x.breaks && !hyphenated(x))) {
    missing.set(r.subject, [...(missing.get(r.subject) ?? []), `${r.file}: ${r.selector}`]);
  }
  const fresh = [...missing.keys()].filter((s) => !(s in BREAKS_WITHOUT_HYPHENS));
  assert.deepEqual(fresh.map((s) => `${s} (${missing.get(s).join('; ')})`), [],
    'diese Regeln lassen ein Wort brechen, ohne dass das Subjekt Silbentrennung hat - '
    + 'hyphens: auto; hyphenate-limit-chars: 6 4 4 ergaenzen (Basisregel oder derselbe @media-Kontext)');
  const stale = Object.keys(BREAKS_WITHOUT_HYPHENS).filter((s) => !missing.has(s));
  assert.deepEqual(stale, [], 'erfuellte Eintraege aus BREAKS_WITHOUT_HYPHENS streichen');
});

test('die Messwoerter der Re-Critique trennen an der Basis ihres Subjekts (W1)', () => {
  // Die drei gemessenen Brueche als Ankerfaelle: ihr Subjekt muss existieren und
  // ohne Media-Query `hyphens: auto` tragen. Ein Guard ueber verschwundene
  // Klassen waere vakuum-wahr.
  const rules = wordBreakRules();
  for (const subject of ['.meal-card__title-text', '.metric-card__label', '.meal-slot__type-text']) {
    const own = rules.filter((r) => r.subject === subject);
    assert.ok(own.length, `${subject} kommt in keinem Stylesheet mehr vor`);
    assert.ok(own.some((r) => /^auto\b/.test(r.hyphens) && r.context === ''),
      `${subject}: hyphens: auto fehlt an der Basisregel`);
  }
});

/* R16 (Critique 2026-10-05, P1 Bausteine): der Name einer Listenzeile stand in
 * vier Schnitten da (15/600, 16/400, 16/500, 17/600). Kanon ist 16px medium,
 * registriert als Rolle Zeilentitel. Gegen den Stand davor rot gelaufen. */
// ---------------------------------------------------------------------------
// DIE TRENNGRENZE GILT AUCH IN SAFARI (#1774)
//
// `hyphenate-limit-chars` kennt Safari nicht (Stand Safari 27; nur die
// Technology Preview parst sie). Die Deklaration faellt dort weg, und
// `hyphens: auto` trennt ohne Untergrenze: „Wertpapierde-pot". WebKit fuehrt
// dieselbe Grenze als `-webkit-hyphenate-limit-before` / `-after`. Verlangt
// wird das Paar in DERSELBEN Regel und mit DENSELBEN Zahlen - eine Regel, die
// in Chromium bei 4 trennt und in Safari bei 2, ist derselbe Befund in klein.
// Keine Anzahl, keine Dateiliste: jede Regel unter public/styles wird gefragt.
// ---------------------------------------------------------------------------

/** Regeln, deren Safari-Grenze fehlt oder von `hyphenate-limit-chars` abweicht. */
function hyphenLimitGaps() {
  const gaps = [];
  let seen = 0;
  for (const file of cssFiles) {
    const css = readFileSync(new URL(file, STYLES_DIR), 'utf8');
    for (const { selector, body, at } of eachRule(css)) {
      const chars = lastDeclaration(body, 'hyphenate-limit-chars');
      if (!chars) continue;
      seen += 1;
      // Kurzform nach CSS Text 4: <wort> [<vor> [<nach>]]; fehlt <nach>, gilt <vor>.
      const [, before = 'auto', after = before] = chars.split(/\s+/);
      const where = `${file} ${[...at, selector].join(' | ')}`;
      for (const [prop, want] of [['-webkit-hyphenate-limit-before', before], ['-webkit-hyphenate-limit-after', after]]) {
        const got = lastDeclaration(body, prop);
        if (got !== want) gaps.push(`${where}: ${prop} ist "${got}", erwartet "${want}" (hyphenate-limit-chars: ${chars})`);
      }
    }
  }
  return { gaps, seen };
}

test('jede Trenngrenze steht auch in der Safari-Schreibweise, mit denselben Zahlen (#1774)', () => {
  const { gaps, seen } = hyphenLimitGaps();
  assert.ok(seen > 0, 'der Guard hat keine einzige hyphenate-limit-chars-Regel gefunden - er misst nichts');
  assert.deepEqual(gaps, [],
    'Safari kennt hyphenate-limit-chars nicht und trennt ohne Grenze. Direkt darunter '
    + '-webkit-hyphenate-limit-before / -after mit denselben Zahlen ergaenzen.');
});

test('der Zeilentitel ist eine Rolle (R16)', () => {
  const typo = [...eachRule(readFileSync(new URL('typography.css', STYLES_DIR), 'utf8'))];
  const sels = (rule) => rule.selector.split(',').map((s) => s.trim());
  const rolle = typo.find((rule) => sels(rule).includes('.list-row__name'));
  assert.ok(rolle, 'typography.css registriert `.list-row__name`');
  assert.match(rolle.body, /font-size:\s*var\(--text-base\)/);
  assert.match(rolle.body, /font-weight:\s*var\(--font-weight-medium\)/);
  for (const sel of ['.u-row-title', '.agenda-event__title', '.contact-item__name', '.subscription-card__name', '.rw-standing__name']) {
    assert.ok(sels(rolle).includes(sel), `${sel} nimmt die Rolle`);
  }

  // Eine Zeile steht nicht in der Headline-Registrierung (17/600) und nicht in
  // ihrer Dichte-Variante (15/600): das sind Karten-Titel.
  const ZEILEN = ['.agenda-event__title', '.budget-entry__title', '.contact-item__name', '.birthday-item__name',
    '.housekeeping-task__body h2', '.subscription-card__name', '.task-card__title'];
  const headline = typo.filter((rule) => /--type-card-title|--type-secondary/.test(rule.body) && /font-weight-semibold/.test(rule.body));
  assert.ok(headline.length >= 2, 'Headline und Dichte-Variante gefunden');
  const doppelt = headline.flatMap(sels).filter((sel) => ZEILEN.includes(sel));
  assert.deepStrictEqual(doppelt, [], 'Zeilen stehen nicht in der Karten-Titel-Rolle');

  // Der Knopf-Reset der Buchungszeile nahm das Gewicht mit (16/400).
  const budget = [...eachRule(readFileSync(new URL('budget.css', STYLES_DIR), 'utf8'))];
  const knopf = budget.find((rule) => rule.selector.trim() === 'button.budget-entry__title');
  assert.ok(knopf);
  assert.doesNotMatch(knopf.body, /(?:^|[;\s])font:\s*inherit/, '`font: inherit` setzt das Gewicht der Rolle zurueck');

  // R24 (Critique G6 P2-1): dieselbe Falle am Mitgliedsnamen der Familie - der
  // Knopf stand auf 16/400, die Einladung darunter (kein Knopf) auf 17/600.
  assert.ok(sels(rolle).includes('.settings-member__name'), '.settings-member__name nimmt die Rolle Zeilentitel');
  assert.ok(!headline.flatMap(sels).includes('.settings-member__name'), '.settings-member__name steht nicht mehr in der Headline-Rolle');
  const settingsCss = [...eachRule(readFileSync(new URL('settings.css', STYLES_DIR), 'utf8'))];
  const mitglied = settingsCss.find((rule) => rule.selector.trim() === '.settings-member__open');
  assert.ok(mitglied);
  assert.doesNotMatch(mitglied.body, /(?:^|[;\s])font:\s*inherit/, '`font: inherit` am Mitgliedsnamen setzt die Rolle zurueck');

  // Die Aufgabenzeile traegt die Rolle, nicht mehr die Dichte-Variante der Headline.
  const tasks = readFileSync(new URL('../pages/tasks.js', STYLES_DIR), 'utf8');
  assert.match(tasks, /class="task-card__title u-row-title"/);

  // Und kein Modul setzt am Zeilennamen ein eigenes Gewicht als Literal.
  const funde = [];
  for (const name of cssFiles.filter((n) => n !== 'typography.css' && n !== 'list-row.css')) {
    for (const rule of eachRule(readFileSync(new URL(name, STYLES_DIR), 'utf8'))) {
      if (!sels(rule).some((sel) => /\.(?:list-row__name|rw-standing__name|subscription-card__name|contact-item__name)$/.test(sel))) continue;
      const w = rule.body.match(/font-weight:\s*([^;]+)/);
      if (w && !/font-weight-medium/.test(w[1])) funde.push(`${name}: ${rule.selector.trim()} { font-weight: ${w[1].trim()} }`);
    }
  }
  assert.deepStrictEqual(funde, [], 'ein eigenes Gewicht am Zeilentitel ist ein Dialekt');
});

// R19 (Critique 2026-10-16, "Titel-Kuerzung: vier Regeln"): EINE Titelregel
// fuer Listenzeilen - hoechstens zwei Zeilen, dann Ellipse. Vorher einzeilig
// (Aufgaben, Kontakte, Geburtstage, Belohnungen, Abos, Buchungen, Agenda am
// Desktop) oder unbegrenzt (Einkauf/Vorrat/Rezepte, Agenda mobil).
test('R19: die Titelregel - Zeilentitel hoechstens zwei Zeilen, kein Modul weicht ab', () => {
  const typo = [...eachRule(readFileSync(new URL('typography.css', STYLES_DIR), 'utf8'))];
  const sels = (rule) => rule.selector.split(',').map((s) => s.trim());
  const TITLES = ['.list-row__name', '.task-card__title', '.contact-item__name', '.subscription-card__name', '.rw-standing__name', '.agenda-event__title > span'];
  const regel = typo.find((rule) => !rule.at.length && TITLES.every((sel) => sels(rule).includes(sel)));
  assert.ok(regel, 'typography.css fuehrt die Titelregel fuer alle Zeilentitel');
  assert.match(regel.body, /display:\s*-webkit-box/);
  assert.match(regel.body, /-webkit-line-clamp:\s*2/);
  assert.match(regel.body, /(?:^|[;\s])line-clamp:\s*2/);
  assert.match(regel.body, /overflow:\s*hidden/);
  // Kein Modulblatt setzt am Zeilentitel eine eigene Fassung: einzeilig,
  // eine andere Zeilenzahl oder eine Anzeige, die die Kappung aufhebt.
  const TITLE_RE = /\.(?:list-row__name|task-card__title|contact-item__name|subscription-card__name|rw-standing__name|birthday-item__name|budget-entry__title)$|\.agenda-event__title(?:\s*>\s*span)?$/;
  // EINE benannte Ausnahme (U1 b, DW-P1-3, 2026-10-27): die Zeilen der
  // Listen-Kacheln der Uebersicht stehen ab 768px in EINER Zeile. Die Kachel
  // ist dort so hoch wie ihre Zeilen (`contentSpanRows`), und das geht nur,
  // wenn eine Zeile eine Hoehe HAT - ein Name, der in einer 330px-Spalte
  // umbricht, machte sie 71 statt 54px hoch. Die Kachel ist eine Vorschau
  // (wie ein Apple-Widget); die Zeile oeffnet ihr Objekt, dort gilt die Regel.
  const widgetRowsWide = (name, rule) => name === 'dashboard.css'
    && /^\.widget__rows > \.list-row:not\(/.test(rule.selector.trim())
    && rule.at.some((a) => /min-width:\s*768px/.test(a));
  const funde = [];
  for (const name of cssFiles.filter((n) => n !== 'typography.css')) {
    for (const rule of eachRule(readFileSync(new URL(name, STYLES_DIR), 'utf8'))) {
      if (!sels(rule).some((sel) => TITLE_RE.test(sel))) continue;
      if (widgetRowsWide(name, rule)) continue;
      if (/white-space:\s*nowrap/.test(rule.body)) funde.push(`${name}: ${rule.selector.trim()} nowrap`);
      const clamp = rule.body.match(/line-clamp:\s*(\d+)/);
      if (clamp && clamp[1] !== '2') funde.push(`${name}: ${rule.selector.trim()} line-clamp ${clamp[1]}`);
      const display = rule.body.match(/(?:^|[;\s])display:\s*([^;]+)/);
      if (display && !/-webkit-box|flex$/.test(display[1].trim())) funde.push(`${name}: ${rule.selector.trim()} display ${display[1].trim()}`);
      if (display && /flex/.test(display[1]) && !/agenda-event__title$/.test(rule.selector.trim())) funde.push(`${name}: ${rule.selector.trim()} display ${display[1].trim()}`);
    }
  }
  assert.deepStrictEqual(funde, [], 'eigene Titel-Kuerzung in einem Modul');
});

// R19 (Critique 2026-10-16, "Ziffern: tabular-nums nur im Zeitraster"): im
// ganzen Kalender stehen gleich breite Ziffern - Monat, Agenda, Zeitraum-Label.
// Die Wurzel der Seite traegt sie, alles darunter erbt; keine Regel darunter
// schaltet sie zurueck.
test('R19: der Kalender setzt Ziffern ueberall gleich breit', () => {
  const css = readFileSync(new URL('calendar.css', STYLES_DIR), 'utf8');
  const root = [...eachRule(css)].filter((r) => !r.at.length && r.selector.trim() === '.calendar-page');
  assert.ok(root.some((r) => /font-variant-numeric:\s*tabular-nums/.test(r.body)), '.calendar-page traegt tabular-nums');
  const back = [...eachRule(css)].filter((r) => /font-variant-numeric:\s*(?:normal|proportional-nums)/.test(r.body)).map((r) => r.selector.trim());
  assert.deepStrictEqual(back, [], 'eine Regel im Kalender schaltet die gleich breiten Ziffern zurueck');
});

// R19 (Critique 2026-10-16): im Gesundheitsmodul standen 70 Textknoten bei
// 10px (Zyklus-Legende, Wochentage, Verlaufs-Chips, Labor-Badge, Medikamente).
// Die Mindestgroesse der Skala ist Caption 2 (`--type-micro`, 11px). Und das
// Labor spricht EINE Flag-Sprache: jede Abweichung in der Warnfarbe, die
// Richtung sagen Pfeil und Wort; die Fastenwoche zeichnet im Modulton wie
// jedes andere Gesundheitsdiagramm.
test('R19 Gesundheit: keine Schrift unter Caption 2, eine Flag-Sprache, ein Diagrammton', () => {
  const css = readFileSync(new URL('health.css', STYLES_DIR), 'utf8');
  assert.doesNotMatch(css, /var\(--text-2xs\)/, 'health.css nutzt 10px (--text-2xs)');
  for (const rule of eachRule(css)) {
    const m = rule.body.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
    if (m) assert.ok(Number(m[1]) >= 11, `${rule.selector}: ${m[0]}`);
  }
  const body = (sel) => [...eachRule(css)].find((r) => !r.at.length && r.selector.split(',').map((x) => x.trim()).includes(sel))?.body ?? '';
  for (const sel of ['.health-lab-flag--low', '.health-lab-flag--high', '.health-lab-rows__row--low .health-lab-rows__value', '.health-lab-rows__row--high .health-lab-rows__value']) {
    assert.match(body(sel), /color:\s*var\(--color-warning-ink\)/, `${sel} spricht nicht die Flag-Sprache der Befundkarte`);
  }
  assert.match(body('.health-lab-badge--warn'), /color:\s*var\(--color-warning-ink\)/);
  assert.doesNotMatch(css, /fasting-week__[a-z]+[^{]*\{[^}]*chart-series/, 'die Fastenwoche laeuft auf fremden Serienfarben');
});

// R21 (Critique 2026-10-21, D4): DIE METAZEILE IST EINE ROLLE - Footnote 13.
// Gemessen stand dieselbe Stelle in drei Groessen: Aufgaben 12 (`.due-date`,
// `.priority-badge`), Budget/Inventar/Kontakte/Agenda 14 (`.list-row__meta`,
// `.contact-item__meta`, `.agenda-event__meta`), das Dashboard 12 neben seiner
// eigenen 13er Cockpitzeile. Die Rolle steht in typography.css; ein Modulblatt
// traegt Farbe und Layout, keine Groesse.
//
// Der Guard prueft das SUBJEKT, nicht eine Liste: jede Klasse, die als BEM-
// Element `__meta` (oder als Block `-meta`) heisst - im Stylesheet ODER im
// Markup -, ist in der Rolle registriert oder steht als benannte Ausnahme mit
// Grund darunter. Eine neue Metazeile, die niemand registriert, erbt sonst die
// Groesse ihres Traegers und faellt hier auf statt in der naechsten Critique.
test('R21: die Metazeile ist eine Rolle - Footnote 13, kein Modul setzt eine eigene Groesse', () => {
  const typo = [...eachRule(readFileSync(new URL('typography.css', STYLES_DIR), 'utf8'))];
  const sels = (rule) => rule.selector.split(',').map((s) => s.trim());
  const rolle = typo.find((rule) => !rule.at.length && sels(rule).includes('.list-row__meta'));
  assert.ok(rolle, 'typography.css registriert die Metazeile (`.list-row__meta`)');
  assert.match(rolle.body, /font-size:\s*var\(--type-caption\)/, 'die Metazeile ist Footnote 13 (--type-caption)');
  assert.match(rolle.body, /font-weight:\s*var\(--font-weight-regular\)/);
  const registriert = sels(rolle);
  const klassen = new Set(registriert.filter((s) => /^\.[\w-]+$/.test(s)).map((s) => s.slice(1)));

  // Benannte Ausnahmen - jede mit dem Grund, warum sie KEINE Metazeile ist.
  const AUSNAHMEN = new Map([
    ['u-meta', 'die Subheadline-Utility (15) fuer Sekundaertext; der Name ist aelter als die Rollen'],
    ['day-event__meta', 'Mikrotext im Zeitraster: die Zeile lebt in einem Terminblock, dessen Hoehe die Dauer ist'],
  ]);

  const META = /(?<![\w-])([a-z][a-z0-9_-]*(?:__|-)meta)(?![\w-])/g;
  const gefunden = new Map();
  const merke = (cls, wo) => { if (!gefunden.has(cls)) gefunden.set(cls, wo); };
  for (const name of cssFiles) {
    for (const rule of eachRule(readFileSync(new URL(name, STYLES_DIR), 'utf8'))) {
      for (const m of rule.selector.matchAll(META)) merke(m[1], name);
    }
  }
  const PUBLIC = new URL('../', STYLES_DIR);
  const jsFiles = (dir) => readdirSync(new URL(dir, PUBLIC), { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'vendor' ? [] : jsFiles(`${dir}${e.name}/`);
    return e.name.endsWith('.js') ? [`${dir}${e.name}`] : [];
  });
  for (const file of jsFiles('')) {
    const src = readFileSync(new URL(file, PUBLIC), 'utf8');
    for (const m of src.matchAll(/class(?:Name)?\s*[=:]\s*["'`]([^"'`]*)["'`]/g)) {
      for (const k of m[1].matchAll(META)) merke(k[1], file);
    }
  }
  assert.ok(gefunden.size >= 40, `nur ${gefunden.size} Meta-Klassen gefunden - liest der Guard noch?`);
  const offen = [...gefunden].filter(([cls]) => !klassen.has(cls) && !AUSNAHMEN.has(cls)).map(([cls, wo]) => `.${cls} (${wo})`);
  assert.deepStrictEqual(offen, [], 'Metazeilen ohne Rolle - in typography.css registrieren oder als Ausnahme begruenden');

  // Kein Blatt ausser typography.css setzt am Subjekt einer Metazeile eine
  // Groesse - auch nicht in einer Media- oder Container-Query. Ein Chip IN der
  // Zeile (`.x__meta .chip`) ist ein anderes Subjekt und darf Caption 1 tragen.
  const subjekt = (sel) => sel.split(/\s*[\s>+~]\s*/).pop();
  const trifft = (sel) => registriert.some((r) => {
    if (r.includes(' ')) return sel.replace(/\s+/g, ' ') === r;
    return new RegExp(`${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(subjekt(sel));
  });
  const dialekt = [];
  for (const name of cssFiles.filter((n) => n !== 'typography.css')) {
    for (const rule of eachRule(readFileSync(new URL(name, STYLES_DIR), 'utf8'))) {
      const fs = rule.body.match(/font-size:\s*([^;]+)/);
      if (!fs || ['inherit', 'unset', 'revert'].includes(fs[1].trim())) continue;
      const hit = sels(rule).filter(trifft);
      if (hit.length) dialekt.push(`${name}: ${hit.join(', ')} { font-size: ${fs[1].trim()} }`);
    }
  }
  assert.deepStrictEqual(dialekt, [], 'eine eigene Groesse an der Metazeile ist ein Dialekt - die Rolle in typography.css ist die Quelle');
});

// R21 S5 (Critique 2026-10-21, D5): DAS INNENLEBEN DER UEBERSICHT LIEST IN
// ROLLEN. Nach S4 trugen die Kacheln noch 14 und 12 an Lesetext: Zaehler
// ("1/2"), Restzeit ("in 22 Tagen", "Noch 2 Tage"), Mengen, das leere Widget,
// die Beschriftungen der Budget-Kachel und - bei 12 - jede Fussnote
// "+N weitere". D4: 14 gehoert Bedienelementen, 12 Badges, Avataren und
// Mikro-Labels. Dieser Guard listet, was in dashboard.css noch 14 oder 12
// traegt, und jede Stelle steht mit ihrem Grund da - eine neue Lesezeile in
// diesen Groessen faellt hier auf.
test('R21 S5: die Uebersicht traegt 14 und 12 nur an Bedienelementen, Badges, Avataren und Mikro-Labels', () => {
  const ERLAUBT = new Map([
    ['.widget__badge', 'Badge'], ['.event-time-badge', 'Badge'], ['.shopping-widget-list__count', 'Zaehler-Badge der Liste'],
    ['.family-member__count', 'Badge am Avatar'], ['.health-widget__next-time', 'Uhrzeit als Pille'],
    ['.task-item__avatar', 'Avatar-Initialen'], ['.birthday-widget-item__avatar', 'Avatar-Initialen'],
    ['.family-widget-avatar', 'Avatar-Initialen'], ['.rewards-member__avatar', 'Avatar-Initialen'],
    ['.schedule-widget-row__avatar', 'Avatar-Initialen'],
    ['.week-strip__weekday', 'Mikro-Label der Wochenleiste'], ['.week-strip__date', 'Ziffer im Tageskaestchen'],
    ['.weather-forecast__label', 'Mikro-Label der Vorhersage'], ['.weather-forecast__temps', 'Mikro-Label der Vorhersage'],
    ['.dashboard-overview__date', 'Mikro-Label ueber dem Gruss (versal)'], ['.quick-link-tile__name', 'Mikro-Label unter dem Symbol'],
    ['.fab-action__label', 'Bedienelement'], ['.widget-restore-chip', 'Bedienelement'], ['.dashboard-customize-scope', 'Bedienelement'],
    ['.widget-restore__title', 'Anpassen-Ablage (Bedienflaeche)'], ['.dashboard-customize-footnote', 'Anpassen-Fussnote (Bedienflaeche)'],
    ['.quick-link-manage-row__host', 'Verwalten-Dialog (Formular)'], ['.quick-link-manage-row__locked', 'Verwalten-Dialog (Formular)'],
    // Der Titel IM Block der Zeitleiste (Entwurf „Heute wichtig", 2026-10-26): ein
    // Blocklabel wie am Kalenderblock (.week-event, Caption 1), kein Lesetext - der
    // ganze Termin steht in der Zeile, die der Block aufklappt.
    ['.today-timeline__title', 'Blocklabel der Zeitleiste'],
  ]);
  const css = readFileSync(new URL('dashboard.css', STYLES_DIR), 'utf8');
  const funde = [];
  for (const rule of eachRule(css)) {
    const fs = rule.body.match(/font-size:\s*var\(--text-(sm|xs)\)/);
    if (!fs) continue;
    for (const sel of rule.selector.split(',').map((x) => x.trim().replace(/\s+/g, ' '))) {
      if (!ERLAUBT.has(sel)) funde.push(`${sel} { font-size: var(--text-${fs[1]}) }`);
    }
  }
  assert.deepStrictEqual(funde, [], 'Lesetext der Uebersicht in 14 oder 12 - in die Rolle (typography.css) oder mit Grund hier eintragen');
  // Und die Fussnote "+N weitere" jeder Listenkachel ist mindestens Footnote 13.
  const typo = [...eachRule(readFileSync(new URL('typography.css', STYLES_DIR), 'utf8'))];
  const rolle = typo.find((r) => !r.at.length && r.selector.split(',').map((x) => x.trim()).includes('.list-row__meta'));
  for (const sel of ['.widget-list-more', '.countdown-more', '.waste-widget-more', '.pantry-widget-more', '.week-strip__more']) {
    assert.ok(rolle.selector.split(',').map((x) => x.trim()).includes(sel), `${sel} nimmt die Metazeile (13)`);
  }
});

// R21 S5 + DW-P1-4 (Critique DW 2026-10-26): DIE ZEILEN DER LISTEN-KACHELN
// STEHEN IN DEN D4-ROLLEN. Gemessen standen in einem Raster neun Zeilen-
// Dialekte: Titel 15/600, 16/600, 16/500, 17/600, 15/400; Endangaben als Pille,
// 15/700, 12/500. Jede Listenzeile der Uebersicht ist jetzt die geteilte Zeile:
// ihr Titel nimmt `.list-row__name` (16/500), ihre Metazeile `.list-row__meta`
// (13), ihre Endangabe `.list-row__end` (13/600), ihr Zeichen `.list-row__lead`
// (32px). Der Guard liest das MARKUP (jede Klasse der Zeile traegt ihre Rolle
// mit) und das STYLESHEET (kein Subjekt setzt dort eine eigene Groesse oder
// ein eigenes Gewicht). Eine neue Listen-Kachel, die ihre Zeile selbst baut,
// faellt hier auf - und eine bestehende, die zurueckfaellt, ebenso.
test('R21 S5 + DW-P1-4: die Zeilen der Listen-Kacheln stehen in den Rollen der geteilten Zeile', () => {
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('dashboard.css', STYLES_DIR), 'utf8');
  const ROLES = {
    'list-row': ['task-item', 'event-item', 'birthday-widget-item', 'countdown-item', 'pantry-widget-row', 'schedule-widget-row',
      'waste-widget-row', 'family-member', 'rewards-member', 'shopping-widget-list'],
    'list-row__lead': ['task-item__lead', 'event-item__lead', 'birthday-widget-item__avatar', 'countdown-item__icon', 'pantry-widget-row__icon',
      'schedule-widget-row__avatar', 'family-member__face', 'rewards-member__avatar', 'shopping-widget-list__icon'],
    'list-row__name': ['task-item__title', 'event-item__title', 'birthday-widget-item__name', 'countdown-item__title', 'pantry-widget-row__name',
      'schedule-widget-row__name', 'waste-widget-row__name', 'family-member__name', 'rewards-member__name', 'shopping-widget-list__name'],
    'list-row__meta': ['task-item__meta', 'event-item__time', 'birthday-widget-item__meta', 'countdown-item__meta', 'pantry-widget-row__meta',
      'schedule-widget-row__shift', 'family-member__status'],
    'list-row__end': ['birthday-widget-item__age', 'countdown-item__days', 'pantry-widget-row__days', 'waste-widget-row__date',
      'rewards-member__points', 'shopping-widget-list__count'],
  };
  // Die Mehr-Zelle der Familie ist eine Fussnote, kein Eintrag.
  const NOT_A_ROW = new Set(['family-member--more']);
  const classAttrs = [...src.matchAll(/class="([^"]*)"/g)].map((m) => m[1].split(/\s+/).map((c) => c.split('$')[0]).filter(Boolean));
  const missing = [];
  let seen = 0;
  for (const [role, subjects] of Object.entries(ROLES)) {
    for (const subject of subjects) {
      const uses = classAttrs.filter((cls) => cls.includes(subject) && !cls.some((c) => NOT_A_ROW.has(c)));
      if (!uses.length) missing.push(`${subject}: steht nicht mehr im Markup - Liste nachziehen`);
      seen += uses.length;
      for (const cls of uses) if (!cls.includes(role)) missing.push(`${subject} ohne ${role} (class="${cls.join(' ')}")`);
    }
  }
  assert.ok(seen >= 40, `nur ${seen} Zeilenklassen gefunden - liest der Guard noch?`);
  assert.deepEqual(missing, [], 'eine Zeile der Uebersicht baut ihre Rolle selbst');

  // Kein Subjekt setzt in dashboard.css eine eigene Groesse oder ein eigenes
  // Gewicht: das tun die Rollen (typography.css). Benannte Ausnahme mit Grund.
  const AUSNAHMEN = new Map([
    ['.family-member--shared .family-member__name', 'Telefon: die Namensliste des gemeinsamen Termins unter der Avatar-Reihe (R19) ist Absender in Footnote, kein Zeilentitel'],
  ]);
  const subjects = new Set([...ROLES['list-row__name'], ...ROLES['list-row__meta'], ...ROLES['list-row__end']]);
  const dialekt = [];
  for (const rule of eachRule(css)) {
    if (!/(?:^|;)\s*font-(?:size|weight):/.test(rule.body)) continue;
    for (const sel of rule.selector.split(',').map((x) => x.trim().replace(/\s+/g, ' '))) {
      const last = sel.split(/\s*[\s>+~]\s*/).pop();
      const hit = [...subjects].find((sub) => new RegExp(`\\.${sub}(?![\\w-])`).test(last));
      if (hit && !AUSNAHMEN.has(sel)) dialekt.push(`${sel} { ${/font-(?:size|weight):[^;]+/.exec(rule.body)[0]} }`);
    }
  }
  assert.deepEqual(dialekt, [], 'eine Zeile der Uebersicht setzt eine eigene Groesse oder ein eigenes Gewicht - die Rolle ist die Quelle');

  // Die Rollen selbst: Endzone Footnote halbfett mit gleich breiten Ziffern.
  const typo = [...eachRule(readFileSync(new URL('typography.css', STYLES_DIR), 'utf8'))];
  const end = typo.find((r) => !r.at.length && r.selector.split(',').map((x) => x.trim()).includes('.list-row__end'));
  assert.ok(end, 'typography.css registriert die Endzone (`.list-row__end`)');
  assert.match(end.body, /font-size:\s*var\(--type-caption\)/);
  assert.match(end.body, /font-weight:\s*var\(--font-weight-semibold\)/);
  assert.match(end.body, /font-variant-numeric:\s*tabular-nums/);
});

// R21 (D4): SEKUNDAERTEXT IST SUBHEADLINE 15. Die Erklaerung eines Leerzustands,
// die Beschreibung einer Dokumentkarte, der Untertitel eines Kontaktkopfs
// standen bei 14 - der Stufe der Bedienelemente. Die Rolle steht in
// typography.css; kein Blatt setzt an diesen Subjekten eine eigene Groesse.
// Einzige Variante: der kompakte Leerzustand (Widgets, Seitenspalten) geht
// eine Stufe TIEFER auf die Footnote, damit kein neuer Umbruch entsteht.
test('R21: Sekundaertext ist Subheadline 15 - eine Rolle in typography.css', () => {
  const typo = [...eachRule(readFileSync(new URL('typography.css', STYLES_DIR), 'utf8'))];
  const sels = (rule) => rule.selector.split(',').map((s) => s.trim());
  const rolle = typo.find((rule) => !rule.at.length && sels(rule).includes('.u-meta'));
  assert.ok(rolle, '.u-meta steht in typography.css');
  assert.match(rolle.body, /font-size:\s*var\(--type-secondary\)/);
  // R21 S9b: die Beschreibung einer Einstellungskarte stand noch bei 14.
  const SEKUNDAER = ['.u-meta', '.empty-state__description', '.document-card__description', '.settings-card-description', '.contact-card__sub', '.task-comments__status'];
  for (const sel of SEKUNDAER) assert.ok(sels(rolle).includes(sel), `${sel} nimmt die Sekundaerrolle`);

  const VARIANTE = new Map([['.empty-state--compact .empty-state__description', 'var(--type-caption)']]);
  const funde = [];
  for (const name of cssFiles.filter((n) => n !== 'typography.css')) {
    for (const rule of eachRule(readFileSync(new URL(name, STYLES_DIR), 'utf8'))) {
      const fs = rule.body.match(/font-size:\s*([^;]+)/);
      if (!fs) continue;
      for (const sel of sels(rule)) {
        const last = sel.split(/\s*[\s>+~]\s*/).pop();
        if (!SEKUNDAER.some((s) => new RegExp(`${s.replace('.', '\\.')}(?![\\w-])`).test(last))) continue;
        if (VARIANTE.get(sel.replace(/\s+/g, ' ')) === fs[1].trim()) continue;
        funde.push(`${name}: ${sel} { font-size: ${fs[1].trim()} }`);
      }
    }
  }
  assert.deepStrictEqual(funde, [], 'eine eigene Groesse am Sekundaertext ist ein Dialekt');
});

// R21 S9b (D4; DESIGN.md "Footnote ... in medium das Label ueber Feldern"):
// DAS FELD SPRICHT IN FOOTNOTE 13. Gemessen in 10 Anlege-Dialogen und 8
// Einstellungsblaettern (390/1280): Labels 92x 14/500, Hinweise 46x 14 und 13x
// 12, Feldgruppen-Legende 14/600 - drei Groessen fuer dieselbe Stelle, keine
// davon die des Systems. 14 gehoert Bedienelementen, 12 Badges.
//
// Der Guard prueft das SUBJEKT: jede Regel, deren letztes Glied ein Feldlabel,
// ein Feldfehler oder eine Klasse auf `-hint`/`__hint` ist und eine Groesse
// setzt, setzt Footnote 13 - oder die Klasse steht als benannte Ausnahme mit
// Grund darunter (Hinweise, die nicht unter einem Feld stehen).
test('R21 S9b: Label, Hinweis und Fehler am Feld sind Footnote 13', () => {
  const FELD = /\.(label|form-label|form-field__error|settings-fieldset__legend|[a-z][\w-]*(?:-|__)hint)(?![\w-])/;
  const AUSNAHMEN = new Map([
    ['form-label__hint', 'Nebensatz IM Label - eine Stufe leiser als das Label (Caption 1)'],
    ['empty-state__hint', 'Leerzustand, kein Feld'],
    ['empty-hint', 'Leerzustand der Fastenhistorie, kein Feld'],
    ['day-view__empty-hint', 'Leerzustand im Zeitraster, kein Feld'],
    ['dashboard-grid-hint', 'Hinweisband beim Anpassen der Uebersicht, Sekundaertext'],
    ['document-dropzone__hint', 'Text IN einer Ablageflaeche, nicht unter einem Feld'],
    ['document-viewer__unsupported-hint', 'Leerzustand im Dokumentbetrachter'],
    ['health-results-hint', 'Erklaerung ueber der Befundtabelle, kein Feld'],
    ['health-overview__export-hint', 'Erklaerung neben dem Export, kein Feld'],
    ['shopping-transfer__hint', 'Einleitung des Uebertragen-Blatts, Sekundaertext'],
    ['recipe-sidebar__hint', 'Leerzustand der Rezept-Seitenspalte'],
    ['rw-own__hint', 'Fortschritt auf der eigenen Karte, Sekundaertext'],
    ['rw-detail-hint', 'Zeile in der Leseansicht, kein Feld'],
    ['perm-matrix__hint', 'Einleitung der Rechte-Matrix, Sekundaertext'],
    ['perm-row__hint', 'Stand einer Rechtezeile (Metazeile der Matrix)'],
    ['bd-import__without-hint', 'Fussnote der Importliste, kein Feld'],
  ]);
  const funde = [];
  let geprueft = 0;
  for (const name of cssFiles) {
    for (const rule of eachRule(readFileSync(new URL(name, STYLES_DIR), 'utf8'))) {
      const fs = rule.body.match(/font-size:\s*([^;]+)/);
      if (!fs || ['inherit', 'unset', 'revert'].includes(fs[1].trim())) continue;
      for (const sel of rule.selector.split(',').map((x) => x.trim())) {
        const m = sel.split(/\s*[\s>+~]\s*/).pop().match(FELD);
        if (!m || AUSNAHMEN.has(m[1])) continue;
        geprueft += 1;
        if (fs[1].trim() !== 'var(--type-caption)') funde.push(`${name}: ${sel} { font-size: ${fs[1].trim()} }`);
      }
    }
  }
  assert.ok(geprueft >= 15, `nur ${geprueft} Feld-Regeln gefunden - liest der Guard noch?`);
  assert.deepStrictEqual(funde, [], 'Label, Hinweis oder Fehler am Feld nicht in Footnote 13 - var(--type-caption) oder als Ausnahme begruenden');

  // Die Beschreibung einer Einstellungszeile und die Nebenwerte der mobilen
  // Kurzzeile stehen UNTER bzw. NEBEN einem Namen: Metazeile (typography.css).
  const typo = [...eachRule(readFileSync(new URL('typography.css', STYLES_DIR), 'utf8'))];
  const rolle = typo.find((r) => !r.at.length && r.selector.split(',').map((x) => x.trim()).includes('.list-row__meta'));
  for (const sel of ['.settings-setting-row__description', '.budget-glance__flows']) {
    assert.ok(rolle.selector.split(',').map((x) => x.trim()).includes(sel), `${sel} nimmt die Metazeile (13)`);
  }
  // Der Tageskopf der Agenda: Subheadline 15, halbfett (nicht 14/700).
  const cal = [...eachRule(readFileSync(new URL('calendar.css', STYLES_DIR), 'utf8'))];
  const body = (sel) => cal.filter((r) => !r.at.length && r.selector.trim() === sel).map((r) => r.body).join(';');
  for (const sel of ['.agenda-day__header', '.agenda-day__date', '.agenda-day__weekday']) {
    assert.match(body(sel), /font-size:\s*var\(--type-secondary\)/, `${sel} ist nicht Subheadline 15`);
  }
  assert.match(body('.agenda-day__date'), /font-weight:\s*var\(--font-weight-semibold\)/, 'das Datum im Tageskopf ist halbfett, nicht fett');
});

// R21 (D4): ERHOEHTER KONTRAST HEBT AUCH DEN METATEXT. Unter
// `prefers-contrast: more` wurden Glas, Kanten und Blur gehaertet, aber die
// Metazeile blieb gemessen in derselben Farbe (hell #63615B, dunkel #B4AEA5) -
// gerade die kleinste Schrift des Schirms bekam nichts. Sekundaer- und
// Tertiaertext stehen dort eine Rampenstufe naeher an der Textfarbe; ueber die
// Rampe statt als Literal, damit der Wert dem Theme folgt (die Dark-Bloecke
// setzen nur die private Haelfte, siehe tokens.css).
test('R21: prefers-contrast: more hebt Sekundaer- und Tertiaertext eine Rampenstufe an', () => {
  const tokens = readFileSync(new URL('tokens.css', STYLES_DIR), 'utf8');
  const rules = [...eachRule(tokens)];
  const kontrast = rules.filter((r) => r.at.some((a) => /prefers-contrast:\s*more/.test(a)) && r.selector.trim() === ':root');
  assert.ok(kontrast.length, 'tokens.css fuehrt einen :root-Block unter prefers-contrast: more');
  const body = kontrast.map((r) => r.body).join(';');
  for (const token of ['--color-text-secondary', '--color-text-tertiary']) {
    const m = body.match(new RegExp(`${token}:\\s*([^;]+)`));
    assert.ok(m, `${token} bleibt unter prefers-contrast: more unveraendert`);
    assert.match(m[1].trim(), /^var\(--neutral-(?:700|800|900)\)$/, `${token} folgt der Rampe (eine Stufe naeher an der Textfarbe), kein Literal`);
  }
  const hex = (name) => tokens.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`))?.[1];
  const lum = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  assert.ok(ratio(hex('--_neutral-700'), '#FFFFFF') >= 7, 'hell: mindestens 7:1 (AAA) auf Weiss');
});

// R21 (D4, Persona Inge, 834px): die Stellen, an denen Lesetext unter 13 lag.
// Gemessen: Tab-Labels 11px am Tablet, Kalender-Chips 12px auf im Mittel 12,6
// sichtbare Zeichen (40 von 51 gekuerzt) in 118x170er Zellen, Budget-Summen,
// Plan und Veraenderung 12px, Darlehen-Meta 12px, Aufgaben in der Agenda 12px.
test('R21 Inge: am Tablet keine Lesezeile unter 13, Nav-Label 12; R23: Monatstitel einzeilig', () => {
  const rules = (name) => [...eachRule(readFileSync(new URL(name, STYLES_DIR), 'utf8'))];
  const sels = (rule) => rule.selector.split(',').map((s) => s.trim());

  const label = rules('layout.css').find((r) => r.at.some((a) => /min-width:\s*640px/.test(a)) && sels(r).includes('.nav-bottom .nav-item__label'));
  assert.ok(label, 'ab 640px eine eigene Regel fuer das Tab-Label');
  assert.match(label.body, /font-size:\s*var\(--text-xs\)/, 'am Tablet Caption 1 (12) statt Caption 2 (11)');

  const tablet = (r) => r.at.some((a) => /min-width:\s*640px/.test(a) && /max-width:\s*1023px/.test(a));
  const cal = rules('calendar.css');
  // R23 (D14): am Tablet EINE Zeile mit Ellipse - der Zweizeilen-Block (R21 D4)
  // ist entfallen, die Grundregel des Chips gilt wieder allein.
  const zweizeilig = cal.filter((r) => tablet(r) && sels(r).some((s) => /\.month-day \.(?:month-day__event|cal-task-chip)/.test(s)));
  assert.deepEqual(zweizeilig.map((r) => r.selector), [], 'keine Tablet-Ausnahme fuer die Chips der Monatszelle');
  const grund = cal.find((r) => !r.at.length && r.selector.trim() === '.month-day__event');
  assert.match(grund?.body ?? '', /white-space:\s*nowrap/);
  assert.match(grund?.body ?? '', /text-overflow:\s*ellipsis/, 'eine Zeile mit Ellipse');
  const agenda = cal.find((r) => !r.at.length && r.selector.trim() === '.agenda-tasks .cal-task-chip');
  assert.match(agenda?.body ?? '', /font-size:\s*var\(--type-caption\)/, 'die Aufgabe in der Agenda ist eine Zeile, kein Etikett');

  const budget = rules('budget.css');
  for (const sel of ['.budget-bar-row__label', '.budget-bar-row__amount']) {
    const base = budget.find((r) => !r.at.length && r.selector.trim() === sel && /font-size/.test(r.body));
    assert.match(base?.body ?? '', /font-size:\s*var\(--type-caption\)/, `${sel}: Footnote 13 statt 12`);
  }
});

/* EINE ROLLE, EIN GEWICHT: TITLE 1 IST SEMIBOLD (DW-P2-7 Nachtrag p6b,
 * Entscheidung Ulas 2026-10-26). Die Leitzahl und die ruhigen Werte einer
 * gefuehrten Reihe standen seit R23 D12 auf semibold, die Kachelreihe der
 * Uebersicht seit p6 - die uebrigen Kennzahlen (Gesundheit, Inventar,
 * Haushaltshilfe, Abos, Aufteilung) und die anderen Nutzer der Rolle
 * (Kontosaldo der Budget-Kachel, Fasten-Timer) weiter auf 700: dieselbe Rolle
 * in zwei Gewichten. Gefragt wird jede Regel, die eine Groesse der Rolle setzt
 * oder den Wert der Kennzahlkarte trifft - keine Dateiliste. Gegen den Stand
 * davor rot gelaufen (Dateikopie). */
test('Title 1 traegt semibold: keine Kennzahl und kein Wert der Rolle steht in 700', () => {
  const title1 = /font-size:\s*var\(--(?:text-3xl|metric-value-size\s*,\s*var\(--text-3xl\))\)/;
  const bold = [];
  let base = null;
  for (const file of cssFiles) {
    const css = readFileSync(new URL(file, STYLES_DIR), 'utf8');
    for (const { selector, body, at } of eachRule(css)) {
      const weight = lastDeclaration(body, 'font-weight');
      const valueRule = /\.metric-card__value\b/.test(selector);
      if (file === 'panel.css' && at.length === 0 && selector.trim() === '.metric-card__value' && title1.test(body)) base = weight;
      if (!weight || !(valueRule || title1.test(body))) continue;
      if (/--font-weight-(?:bold|heavy|black)\b|\b[789]00\b/.test(weight)) bold.push(`${file}: ${[...at, selector.trim().replace(/\s+/g, ' ')].join(' | ')}`);
    }
  }
  assert.ok(base !== null, 'die Grundregel `.metric-card__value` in panel.css muss es geben - sonst prueft dieser Guard nichts');
  assert.equal(base, 'var(--font-weight-semibold)', 'die Kennzahl der geteilten Karte steht semibold');
  assert.deepEqual(bold, [], 'diese Regeln setzen eine Title-1-Groesse oder den Kennzahlwert in Fett');
});

// R24 (Critique 2026-10-26, G0-Shell-P2-4 "Abschnittstitel in neun Groessen",
// G5-Gesundheit-P2-2/P3-2, G1-Kalender-P3-3, G0-Inv-4, G4-Budget-P3-6): die
// Titelleiter Gruppe 12 - Abschnitt 20 - Detailtitel 22 - Kartentitel 17 -
// Zeilentitel 16, dazu EIN Blocktitel im Zeitraster und EINE Betragsform. Jede
// Stelle unten stand vorher in einer Stufe ausserhalb der Rollen.
test('R24: die Titelleiter - jede Ueberschrift nimmt eine Rolle, kein Modul setzt eine eigene Stufe', () => {
  const css = (name) => readFileSync(new URL(name, STYLES_DIR), 'utf8');
  const typo = [...eachRule(css('typography.css'))].filter((rule) => rule.at.length === 0);
  const sels = (rule) => rule.selector.split(',').map((s) => s.trim());
  const rolle = (sel) => typo.filter((rule) => sels(rule).includes(sel));
  const body = (sel) => rolle(sel).map((rule) => rule.body).join(';');
  const eigen = (file, sel, prop) => [...eachRule(css(file))]
    .filter((rule) => sels(rule).includes(sel) && new RegExp(`(?:^|[;\\s])${prop}:`).test(rule.body))
    .map((rule) => `${file}: ${[...rule.at, rule.selector.trim()].join(' | ')}`);

  // Detailtitel: Title 2 semibold, an EINER Stelle.
  assert.match(body('.split-view__detail-title'), /font-size:\s*var\(--text-2xl\)/, 'Detailtitel = 22');
  assert.match(body('.split-view__detail-title'), /font-weight:\s*var\(--font-weight-semibold\)/);
  assert.deepEqual([...eigen('layout.css', '.split-view__detail-title', 'font-size'), ...eigen('health.css', '.health-detail-head__title', 'font-size')], [],
    'kein Modulblatt schreibt dem Detailtitel eine Groesse vor (vorher 18 in layout.css und health.css)');

  // Abschnitt: der Kopf der Ordnerspalte wie "Alle Bereiche" der Gesundheit.
  assert.match(body('.documents-folder-browser__title'), /font-size:\s*var\(--type-section-title\)/, 'Ordnerspalte: Abschnitt 20');
  assert.deepEqual(eigen('documents.css', '.documents-folder-browser__title', 'font-(?:size|weight)'), [], 'documents.css setzt keine 14/600 mehr');

  // Kartentitel: Untertitel der Gesundheit in Headline.
  for (const [file, sel] of [['health.css', '.health-chart-section__title'], ['health.css', '.health-recent__title'], ['settings.css', '.settings-status-summary__title']]) {
    assert.match(body(sel), /font-size:\s*var\(--type-card-title\)/, `${sel} = Headline 17`);
    assert.deepEqual(eigen(file, sel, 'font-(?:size|weight)'), [], `${file} setzt ${sel} keine eigene Stufe`);
  }

  // Zeilentitel: die offene Anfrage der Belohnungen.
  assert.ok(sels(typo.find((rule) => sels(rule).includes('.list-row__name'))).includes('.rw-pending__title'), '.rw-pending__title nimmt den Zeilentitel');
  assert.deepEqual(eigen('rewards.css', '.rw-pending__title', 'font-weight'), [], 'kein Literal-Gewicht 600 an der Anfrage');

  // Blocktitel im Zeitraster: Termin und Schicht, Woche und Tag in EINER Regel.
  const block = typo.find((rule) => sels(rule).includes('.schedule-time-block__title'));
  assert.ok(block, 'der Schichtblock nimmt die Rolle Blocktitel');
  for (const sel of ['.week-event__title', '.day-event__title']) assert.ok(sels(block).includes(sel), `${sel} in derselben Rolle`);
  assert.match(block.body, /font-size:\s*var\(--text-xs\)/);
  assert.match(block.body, /font-weight:\s*var\(--font-weight-semibold\)/);
  for (const sel of ['.week-event__title', '.day-event__title', '.schedule-time-block__title']) {
    assert.deepEqual(eigen('calendar.css', sel, 'font-(?:size|weight)'), [], `calendar.css setzt ${sel} keine eigene Stufe`);
  }
  // Seit R24 E5 ist die Schicht ein Band: EINE Zeile (das Kurzetikett), keine
  // Zeitzeile mehr - die Uhrzeit sagen Band-Laenge, Name und Detail.
  const cal = [...eachRule(css('calendar.css'))];
  assert.ok(!cal.some((rule) => /\.schedule-time-block__time/.test(rule.selector)), 'keine eigene Zeitzeile im Schichtband');

  // Betrag: eine Groesse in der Zeile (16), ein Gewicht ueberall (semibold).
  const budget = [...eachRule(css('budget.css'))].filter((rule) => rule.at.length === 0);
  const b = (sel) => budget.filter((rule) => sels(rule).includes(sel)).map((rule) => rule.body).join(';');
  assert.match(b('.budget-account__balance'), /font-size:\s*var\(--text-base\)/, 'Kontosaldo 16 wie die Buchung (vorher 18)');
  assert.match(b('.budget-plan-row__amounts strong'), /font-size:\s*var\(--text-base\)/, 'Planwert 16 (vorher 14)');
  assert.match(b('.budget-loan-card__amounts strong'), /font-weight:\s*var\(--font-weight-semibold\)/, 'die Rate ist kein Browser-Fett');
  assert.match(b('.budget-bar-row__amount'), /font-weight:\s*var\(--font-weight-semibold\)/, 'Diagrammbetrag semibold (vorher medium)');
  for (const sel of ['.subscription-card__cost > strong', '.subscriptions-chart-row > strong', '.subscriptions-chart__figure strong']) {
    assert.match(b(sel), /font-weight:\s*var\(--font-weight-semibold\)/, `${sel}: kein Browser-Fett`);
  }
});
