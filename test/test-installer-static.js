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
