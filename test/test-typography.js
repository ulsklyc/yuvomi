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
  assertTypeRole(typography, 'typography.css', '.split-card-title', '--type-card-title',
    'Kartenüberschriften dürfen nicht auf die Browser-Standardgröße zurückfallen');
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
  const { SETTINGS_LEAVES } = await import('../public/settings/registry.js');
  const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
  const translate = (key) => key.split('.').reduce((value, segment) => value?.[segment], de);
  const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  const failures = [];
  for (const leaf of SETTINGS_LEAVES) {
    const file = String(leaf.loader).match(/\/settings\/(pages\/[\w-]+\.js)/)?.[1];
    assert.ok(file, `${leaf.id}: Loader-Pfad nicht erkennbar`);
    const source = readFileSync(new URL(`../public/settings/${file}`, import.meta.url), 'utf8');
    const label = normalize(translate(leaf.labelKey));

    // Statische Überschriften im Markup: <h2 …>${t('key')}</h2>, auch via esc().
    for (const match of source.matchAll(/<h([23])\b[^>]*>\s*\$\{(?:esc\()?\s*t\(\s*['"]([\w.]+)['"]/g)) {
      const [, level, key] = match;
      if (normalize(translate(key)) === label) {
        failures.push(`${leaf.id}: <h${level}> wiederholt den Blatt-Titel "${translate(key)}" (${key})`);
      }
    }
  }
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
    '.event-item__time',
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
  assertTypeRole(calendar, 'calendar.css', '.cal-toolbar__view-btn', '--type-secondary',
    'interaktive Kalender-Ansichtsschalter müssen mindestens 14px groß sein');
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
