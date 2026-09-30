import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createInstallerServer } from '../tools/installer/install-server.js';

// Repo-Root = Verzeichnis dieser Testdatei. Die statischen Routen liefern aus
// public/ relativ zu PROJECT_ROOT, daher zeigt OIKOS_INSTALLER_ROOT dorthin.
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

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

// ── Statische App-Assets ─────────────────────────────────────────────────────

test('GET /tokens.css liefert 200 + text/css aus public/styles', async () => {
  await withServer(async base => {
    const r = await fetch(`${base}/tokens.css`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/css/);
    const body = await r.text();
    assert.match(body, /--color-accent/, 'tokens.css enthält die App-Akzent-Variable nicht');
  });
});

/**
 * HIER STANDEN ZWEI FONT-TESTS - einer sicherte der /fonts/-Route ihre 200 zu,
 * der andere haertete sie gegen Path-Traversal und Nicht-woff2.
 *
 * Die Route ist entfallen (Begruendung in install-server.js), und mit ihr die
 * beiden Dateien. Der Haertungstest waere dabei GRUEN GEBLIEBEN, ohne noch
 * irgendetwas zu haerten: ohne Route liefert jeder /fonts/-Pfad 404, also auch
 * die drei Angriffspfade. Ein Test, dessen Aussage sich still von „die Route
 * wehrt ab" zu „es gibt keine Route" verschiebt, ist keine Zusicherung mehr -
 * deshalb sagt der Nachfolger, was er wirklich prueft.
 */
test('der Installer serviert keine Schriften mehr - auch nicht die der App', async () => {
  await withServer(async base => {
    // Die frueher ausgelieferte Datei zuerst: sie ist der Beleg, dass hier die
    // ROUTE fehlt und nicht nur eine Datei.
    for (const path of [
      '/fonts/plus-jakarta-sans-variable.woff2',
      '/fonts/nope.woff2',
      '/fonts/../install.html',
      '/fonts/evil.css',
    ]) {
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 404, `${path} hätte 404 liefern müssen`);
    }
  });

  // Und die Gegenrichtung: die Schrift darf auch nicht ueber ein Stylesheet
  // zurueckkommen. `public/` fuehrt seit dem Redesign kein @font-face - faellt
  // diese Zusicherung, steht wieder eine Schrift im Spiel, fuer die es keine
  // Auslieferung gibt.
  const tokens = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
  assert.doesNotMatch(tokens, /@font-face/, 'tokens.css deklariert wieder eine Schrift');
  assert.doesNotMatch(tokens, /Plus Jakarta/i, 'tokens.css nennt wieder Plus Jakarta Sans');
});

// ── Token-Parität: install.html nutzt App-Tokens, keine eigenen Hardcodes ─────

test('install.html bindet tokens.css ein und verwendet App-Tokens', () => {
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  assert.match(src, /<link[^>]+href="\/tokens\.css"/, 'install.html bindet /tokens.css nicht ein');
  assert.match(src, /var\(--color-accent\)/, 'install.html nutzt nicht --color-accent');
  assert.match(src, /var\(--font-sans\)/, 'install.html nutzt nicht --font-sans');
});

test('install.html enthält keine alten Hardcode-Tokens mehr', () => {
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  for (const needle of ['#2563eb', '#f0f2f5', '--r-sm']) {
    assert.ok(!src.includes(needle), `Alter Token "${needle}" noch in install.html vorhanden`);
  }
});

// ── "Als Naechstes": jedes Ziel ist ein echtes Einstellungsblatt ──────────────
//
// Der Link "Module waehlen" zeigte auf /settings/modules/options. Das war bis
// #1489 ein Blatt und ist seither ein Alt-Pfad, den die App ins Budget-Blatt
// weiterleitet - wer nach der Installation Module waehlen wollte, landete bei
// den Budget-Optionen. Nichts hat es bemerkt: die Adresse lebte als Text in
// install.html, die Wahrheit in public/settings/registry.js, ohne Naht.
//
// Die Allowlist kommt aus der Registry selbst (SETTINGS_LEAVES), die Sperrliste
// aus ihren Weiterleitungen (RENAMED_SETTINGS_SOURCE_PATHS). Ein kuenftiger
// Umbau der Einstellungen macht diesen Guard rot, nicht die Nutzer ratlos.
test('die Ziele der naechsten Schritte sind echte Einstellungsblaetter, keine Weiterleitungen', async () => {
  const { SETTINGS_LEAVES, RENAMED_SETTINGS_SOURCE_PATHS } = await import('../public/settings/registry.js');
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');

  const leaves = new Set(SETTINGS_LEAVES.map(leaf => leaf.path));
  const redirects = new Set(RENAMED_SETTINGS_SOURCE_PATHS);
  assert.ok(leaves.size > 0 && redirects.size > 0, 'Registry liefert keine Pfade - der Import greift nicht');

  // Aus dem Markup gezaehlt, nicht angenommen: jeder verlinkte naechste Schritt.
  const anchors = [...src.matchAll(/<a\b[^>]*\bid="(next-[\w-]+)"/g)].map(m => m[1]);
  assert.ok(anchors.length > 0, 'keine next-*-Links im Markup gefunden - der Scanner greift nicht');

  const targets = new Map();
  for (const [, id, path] of src.matchAll(/\$\('(next-[\w-]+)'\)\.href\s*=\s*`\$\{appUrl\}([^`]*)`/g)) {
    targets.set(id, path);
  }

  const problems = [];
  for (const id of anchors) {
    if (!targets.has(id)) {
      problems.push(`${id}: keine lesbare href-Zuweisung (\`\${appUrl}/pfad\`) gefunden`);
      continue;
    }
    const path = targets.get(id).split(/[?#]/)[0];
    if (redirects.has(path)) problems.push(`${id}: ${path} ist eine Weiterleitung, kein Blatt`);
    else if (!leaves.has(path)) problems.push(`${id}: ${path} ist kein Blatt aus SETTINGS_LEAVES`);
  }
  assert.deepEqual(problems, [], problems.join(' | '));
});

// ── Pfade in den Hinweisen: "Einstellungen → Bereich → Blatt" gibt es ────────
//
// Dieselbe Naht wie oben, nur als Text: vier Hinweise des Wizards nannten nach
// dem Einstellungs-Umbau (#1489) Pfade, die es nicht mehr gab (#1574) -
// "Einstellungen → Integrationen", "→ Darstellung", "→ E-Mail (SMTP)",
// "→ Kalender", ohne den Bereich dazwischen. In jeder Sprache.
//
// Die gueltigen Pfade kommen aus der Registry und den App-Locales derselben
// Sprache: Einstellungen (`nav.settings`), Bereich (SETTINGS_DOMAINS), Blatt
// (SETTINGS_LEAVES, nur Blaetter DIESES Bereichs). Jeder Pfeil zwischen zwei
// Woertern muss zu so einem Pfad gehoeren - ein Pfad ohne Bereich, mit einem
// Blatt aus dem falschen Bereich oder eine Ebene zu tief faellt auf. Nach dem
// Blatt wird nichts verlangt: im Koreanischen haengt die Partikel direkt dran.
test('Einstellungs-Pfade in Hinweisen, Fallbacks und README gibt es in der App', async () => {
  const { SETTINGS_DOMAINS, SETTINGS_LEAVES } = await import('../public/settings/registry.js');
  const { SUPPORTED_LOCALES } = await import('../tools/installer/i18n-mini.js');
  const readJson = rel => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
  const lookup = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);
  // Ein Pfeil ZWISCHEN zwei Woertern; "Yuvomi oeffnen →" am Ende ist keiner.
  const ARROW = /(?<=\S)\s[→←]\s(?=\S)/g;
  const hasArrow = text => (text.match(ARROW)?.length ?? 0) > 0;

  function pathProblems(label, text, app) {
    const settings = lookup(app, 'nav.settings');
    const problems = [];
    let paths = 0;
    for (const arrow of ['→', '←']) {
      const head = `${settings} ${arrow} `;
      for (let at = text.indexOf(head); at !== -1; at = text.indexOf(head, at + head.length)) {
        paths += 1;
        const rest = text.slice(at + head.length);
        const hit = SETTINGS_LEAVES.some((leaf) => {
          const domain = SETTINGS_DOMAINS.find((d) => d.id === leaf.domainId);
          const tail = `${lookup(app, domain.labelKey)} ${arrow} ${lookup(app, leaf.labelKey)}`;
          return rest.startsWith(tail) && !rest.slice(tail.length).startsWith(` ${arrow}`);
        });
        if (!hit) problems.push(`${label}: "${text.slice(at, at + head.length + 40)}…" ist kein Pfad aus der Registry`);
      }
    }
    const arrows = text.match(ARROW)?.length ?? 0;
    if (arrows !== paths * 2) {
      problems.push(`${label}: ${arrows} Pfeile zwischen Woertern, aber ${paths} Pfad(e) "${settings} → Bereich → Blatt"`);
    }
    return { problems, paths };
  }

  const problems = [];
  const seen = new Map();
  for (const locale of SUPPORTED_LOCALES) {
    const app = readJson(`../public/locales/${locale}.json`);
    const inst = readJson(`../tools/installer/locales/${locale}.json`);
    const walk = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object') { walk(v, key); continue; }
        if (typeof v !== 'string' || !hasArrow(v)) continue;
        const result = pathProblems(`${locale} ${key}`, v, app);
        problems.push(...result.problems);
        if (result.paths) seen.set(locale, (seen.get(locale) ?? 0) + 1);
      }
    };
    walk(inst, '');
  }

  const en = readJson('../public/locales/en.json');
  const html = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  let htmlPaths = 0;
  for (const [, key, text] of html.matchAll(/data-i18n="([\w.]+)"[^>]*>([^<]*)</g)) {
    if (!hasArrow(text)) continue;
    const result = pathProblems(`install.html ${key}`, text, en);
    problems.push(...result.problems);
    htmlPaths += result.paths;
  }
  const readme = readFileSync(new URL('../tools/installer/README.md', import.meta.url), 'utf8');
  const readmeResult = pathProblems('tools/installer/README.md', readme, en);
  problems.push(...readmeResult.problems);

  // Gezaehlt, nicht angenommen: findet der Scanner nichts, prueft er nichts.
  assert.equal(seen.size, SUPPORTED_LOCALES.length, `nur ${seen.size} Sprachen mit Pfad gefunden - der Scanner greift nicht`);
  assert.ok(htmlPaths > 0 && readmeResult.paths > 0, 'keine Pfade in install.html oder README - der Scanner greift nicht');
  assert.deepEqual(problems, [], problems.join('\n'));
});
