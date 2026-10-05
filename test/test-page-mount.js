/**
 * Einhaengepunkt der Seite (utils/page-mount.js)
 *
 * Eine Seite ohne Anmeldung bringt ihr eigenes `<main id="main-content">` mit.
 * Wechselt man von einer solchen Seite zur naechsten, darf der Router dieses
 * `main` nicht als Platz der neuen Seite nehmen - sonst steht Seite in Seite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageMountTarget } from '../public/utils/page-mount.js';

/** Ein Dokument, in dem `#main-content` das ist, was gerade im DOM steht. */
function docWith(mainContent) {
  return { getElementById: (id) => (id === 'main-content' ? mainContent : null) };
}

const app = { name: 'app' };

test('von einer Seite ohne Anmeldung zur naechsten: der Platz ist die App-Wurzel', () => {
  // /forgot-password steht im DOM und hat sein eigenes main#main-content.
  const previousAuthMain = { name: 'main.auth-page der Vorseite' };
  const target = pageMountTarget({ path: '/login', requiresAuth: false }, app, docWith(previousAuthMain));
  assert.equal(target, app, 'die neue Seite landete im main der vorigen Auth-Seite');
});

test('eine Seite mit Anmeldung haengt im Scrollport der Shell', () => {
  const shellMain = { name: 'main.app-content' };
  assert.equal(pageMountTarget({ path: '/tasks', requiresAuth: true }, app, docWith(shellMain)), shellMain);
});

test('ohne Shell faellt eine Seite mit Anmeldung auf die App-Wurzel zurueck', () => {
  assert.equal(pageMountTarget({ path: '/tasks', requiresAuth: true }, app, docWith(null)), app);
});

test('renderPage() nimmt den Platz aus pageMountTarget() und sucht ihn nicht selbst', () => {
  const src = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function renderPage(');
  const end = src.indexOf('\nasync function ', start + 1);
  assert.ok(start > 0 && end > start, 'renderPage() in router.js nicht gefunden');
  const body = src.slice(start, end);
  assert.match(body, /const content = pageMountTarget\(route, app\);/);
  assert.doesNotMatch(body, /const content = document\.getElementById\('main-content'\)/);
});

test('jede Seite ohne Shell bringt ihr eigenes main#main-content mit', () => {
  // Die Voraussetzung der Regel: gaebe es eine solche Seite OHNE eigenes main,
  // fehlte ihr an der App-Wurzel die Landmarke.
  for (const page of ['login', 'setup', 'join', 'forgot-password', 'reset-password', 'pair-display']) {
    const src = readFileSync(new URL(`../public/pages/${page}.js`, import.meta.url), 'utf8');
    assert.match(src, /<main class="auth-page" id="main-content">/, `${page}.js`);
  }
});
