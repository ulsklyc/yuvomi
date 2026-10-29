/**
 * Modul: Erste Schritte auf der Uebersicht (R23 D14, Critique G6 P2 "Nach Tour
 *        Sackgasse"). Haelt die Bedingung (nur nach dem Rundgang, nur Admin,
 *        nie an der Wand), die drei Haken und ihr Ende, die Bauform und die
 *        Verdrahtung in dashboard.js fest.
 * Ausfuehren: node --test test/test-first-steps.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FIRST_STEPS, startFirstSteps, markFirstStep, dismissFirstSteps, firstStepsModel, firstStepsHtml, firstStepsActive,
} from '../public/utils/first-steps.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}
const admin = { id: 1, role: 'admin' };
const t = (key) => key;

test('ohne Rundgang keine Karte - Bestandshaushalte sehen sie nach einem Update nie', () => {
  const storage = memoryStorage();
  assert.equal(firstStepsModel({ user: admin, storage }), null);
  startFirstSteps(storage);
  assert.ok(firstStepsModel({ user: admin, storage }), 'nach dem Rundgang steht sie');
});

test('nur fuer Admins, nie an der Wand, nie am Display-Konto', () => {
  const storage = memoryStorage();
  startFirstSteps(storage);
  assert.equal(firstStepsModel({ user: { role: 'member' }, storage }), null);
  assert.equal(firstStepsModel({ user: admin, wall: true, storage }), null);
  assert.equal(firstStepsModel({ user: { role: 'admin', access_scope: 'display' }, storage }), null);
});

test('drei Haken: Mitglieder aus der Zahl, Module und Region aus dem genommenen Weg; erledigt endet sie', () => {
  const storage = memoryStorage();
  startFirstSteps(storage);
  assert.deepEqual(FIRST_STEPS.map((s) => s.id), ['family', 'modules', 'region']);
  let model = firstStepsModel({ user: admin, storage, memberCount: 1 });
  assert.equal(model.doneCount, 0);
  model = firstStepsModel({ user: admin, storage, memberCount: 3 });
  assert.deepEqual(model.steps.map((s) => s.done), [true, false, false], 'zwei oder mehr Mitglieder: erledigt');
  markFirstStep('modules', storage);
  markFirstStep('region', storage);
  assert.equal(firstStepsModel({ user: admin, storage, memberCount: 3 }), null, 'alles erledigt: die Karte tritt ab');
  assert.equal(firstStepsModel({ user: admin, storage, memberCount: 1 }), null, 'und kommt nicht wieder');
});

test('weggeklickt bleibt weg, auch ein zweiter Rundgang startet sie nicht neu', () => {
  const storage = memoryStorage();
  startFirstSteps(storage);
  dismissFirstSteps(storage);
  assert.equal(firstStepsModel({ user: admin, storage }), null);
  startFirstSteps(storage);
  assert.equal(firstStepsModel({ user: admin, storage }), null);
});

test('Bauform: Abhakkreis als Zeichen, Zaehler, Schliessen mit Namen, erledigt fuer den Screenreader', () => {
  const storage = memoryStorage();
  startFirstSteps(storage);
  const html = firstStepsHtml(firstStepsModel({ user: admin, storage, memberCount: 2 }), t);
  assert.match(html, /<h2 class="first-steps__title" id="first-steps-title">firstSteps\.title<\/h2>/);
  assert.match(html, /class="first-steps__count">1\/3</);
  assert.match(html, /check-ring check-ring--static first-steps__ring check-ring--done/);
  assert.match(html, /<span class="sr-only">, firstSteps\.stepDone<\/span>/);
  assert.match(html, /aria-label="firstSteps\.dismiss"/);
  for (const step of FIRST_STEPS) assert.match(html, new RegExp(`href="${step.href}" data-first-step="${step.id}"`));
  // Eine Uebersetzung mit Markup darin wird Text, nicht HTML.
  const evil = firstStepsHtml(firstStepsModel({ user: admin, storage }), () => '<img src=x onerror=alert(1)>');
  assert.doesNotMatch(evil, /<img/);
});

test('dashboard.js: die Karte steht vom ersten Bild an neben dem Zonen-Hinweis und beginnt nach dem Rundgang', () => {
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ firstStepsActive, mountFirstSteps, startFirstSteps \} from '\/utils\/first-steps\.js';/);
  assert.match(src, /let firstSteps = mountSteps\(\);/);
  assert.match(src, /firstSteps\.update\(Array\.isArray\(data\?\.users\) \? data\.users\.length : null\);/);
  assert.match(src, /if \(!replayTour\) startFirstSteps\(\);/, 'nach dem ersten Rundgang, nicht nach einer Wiederholung aus der Hilfe');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  assert.match(css, /\.first-steps \{[^}]*background-color: var\(--color-surface\);/);
});

// R23 S10 (Critique G6 P3 "Tour ohne Zurueck", "Hilfe nur Kuerzel"): der
// Rundgang hat ab Schritt 2 einen Weg zurueck und laesst sich aus der Hilfe
// wiederholen.
test('Rundgang: Zurueck ab Schritt 2, Wiederholen aus der Hilfe', () => {
  const dash = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.match(dash, /if \(current > 0\) actions\.appendChild\(backBtn\);\s*else if \(!isLast\) actions\.appendChild\(skipBtn\);/);
  assert.match(dash, /swapContent\(stepEl, \(\) => \{ next = fillStep\(\); \}, \{ direction: -1 \}\);/);
  assert.match(dash, /replayTour = sessionStorage\.getItem\('yuvomi-replay-tour'\) === '1'; sessionStorage\.removeItem\('yuvomi-replay-tour'\);/);
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const help = router.slice(router.indexOf('function showHelpModal()'), router.indexOf('function showHelpModal()') + 6000);
  assert.match(help, /data-help-tour/);
  assert.match(help, /sessionStorage\.setItem\('yuvomi-replay-tour', '1'\)/);
  assert.match(help, /navigate\('\/'\);/);
});

test('R24: firstStepsActive sagt, ob die Karte laeuft', () => {
  const data = new Map();
  const storage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
  assert.equal(firstStepsActive(storage), false, 'vor dem Rundgang');
  startFirstSteps(storage);
  assert.equal(firstStepsActive(storage), true, 'nach dem Rundgang');
  dismissFirstSteps(storage);
  assert.equal(firstStepsActive(storage), false, 'weggeklickt');
});
