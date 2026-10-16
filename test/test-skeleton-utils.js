/**
 * Tests: Skeleton-Lade-Hilfen (public/utils/skeleton.js)
 * Reine String-Funktionen — kein DOM erforderlich.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { renderSkeletonCard, renderSkeletonList, placeSkeletonUntilContent } from '../public/utils/skeleton.js';

test('renderSkeletonCard: Default = 2 Zeilen (Titel + 1)', () => {
  const html = renderSkeletonCard();
  const lineDivs = html.match(/class="skeleton skeleton-line skeleton-line--/g) || [];
  assert.equal(lineDivs.length, 2);
  assert.match(html, /skeleton-card/);
  assert.match(html, /skeleton-line--title/);
});

test('renderSkeletonCard: lines steuert Zeilenanzahl', () => {
  const html = renderSkeletonCard({ lines: 4 });
  // 4 line-Divs → "skeleton-line" erscheint 4× (plus Varianten-Suffixe zählen separat)
  const lineDivs = html.match(/class="skeleton skeleton-line skeleton-line--/g) || [];
  assert.equal(lineDivs.length, 4);
});

test('renderSkeletonCard: erste Zeile ist Titel-Variante, Rest rotiert', () => {
  const html = renderSkeletonCard({ lines: 3 });
  assert.match(html, /skeleton-line--title/);
  assert.match(html, /skeleton-line--medium/);
  assert.match(html, /skeleton-line--full/);
});

test('renderSkeletonCard: lines<1 wird auf 1 geklemmt', () => {
  const html = renderSkeletonCard({ lines: 0 });
  const lineDivs = html.match(/class="skeleton skeleton-line/g) || [];
  assert.equal(lineDivs.length, 1);
});

test('renderSkeletonList: Default = 5 Karten', () => {
  const html = renderSkeletonList();
  const cards = html.match(/skeleton-card/g) || [];
  assert.equal(cards.length, 5);
});

test('renderSkeletonList: rows steuert Kartenanzahl', () => {
  const html = renderSkeletonList({ rows: 3 });
  const cards = html.match(/skeleton-card/g) || [];
  assert.equal(cards.length, 3);
});

test('renderSkeletonList: Wrapper ist aria-hidden (dekorativ)', () => {
  const html = renderSkeletonList({ rows: 1 });
  assert.match(html, /<div class="skeleton-list" aria-hidden="true">/);
});

test('renderSkeletonList: rows=0 erzeugt leeren, aber gültigen Wrapper', () => {
  const html = renderSkeletonList({ rows: 0 });
  assert.match(html, /skeleton-list/);
  const cards = html.match(/skeleton-card/g) || [];
  assert.equal(cards.length, 0);
});

test('renderSkeletonList: nutzt nur global definierte Klassen (keine widget-skeleton)', () => {
  const html = renderSkeletonList();
  assert.doesNotMatch(html, /widget-skeleton/);
});

// R16 (Bewegung): die Statistik laedt in Diagrammform, nicht als Liste.
test('renderSkeletonChart: Titel, Diagrammblock und Legendenzeile je Karte', async () => {
  const { renderSkeletonChart } = await import('../public/utils/skeleton.js');
  const html = renderSkeletonChart({ charts: 2 });
  assert.equal((html.match(/class="skeleton skeleton-chart"/g) || []).length, 2);
  assert.equal((html.match(/skeleton-line--title/g) || []).length, 2);
  assert.match(html, /^<div class="skeleton-list" aria-hidden="true">/, 'dieselbe Huelle wie die Liste, fuer Screenreader stumm');
  assert.equal((renderSkeletonChart({ charts: 0 }).match(/skeleton-chart/g) || []).length, 1, 'mindestens eine Flaeche');
});

// ── Skelett, das von selbst geht (Critique R19, 2026-10-16) ─────────────────
//
// Ein Mini-DOM mit genau dem, was placeSkeletonUntilContent und ein Abschnitt
// der Einstellungen anfassen, dazu ein MutationObserver, der wie im Browser
// als Mikrotask nach der Aenderung ruft.
class FakeNode {
  constructor(name) { this.name = name; this.parentNode = null; this.childNodes = []; this.connected = false; }
  get isConnected() { return this.connected || Boolean(this.parentNode?.isConnected); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastElementChild() { return this.childNodes.at(-1) ?? null; }
  appendChild(node) { node.parentNode = this; this.childNodes.push(node); this.notify(); return node; }
  insertAdjacentHTML(_where, html) { this.appendChild(new FakeNode(/class="([^"]+)"/.exec(html)?.[1] ?? 'node')); }
  replaceChildren(...nodes) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    for (const n of nodes) { n.parentNode = this; this.childNodes.push(n); }
    this.notify();
  }
  remove() {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    parent.childNodes = parent.childNodes.filter((n) => n !== this);
    this.parentNode = null;
    parent.notify();
  }
  notify() { for (const o of FakeObserver.all) if (o.target === this && !o.queued) { o.queued = true; queueMicrotask(() => { o.queued = false; if (o.target) o.cb(); }); } }
}
class FakeObserver {
  static all = [];
  constructor(cb) { this.cb = cb; this.target = null; FakeObserver.all.push(this); }
  observe(target) { this.target = target; }
  disconnect() { this.target = null; }
}

/** Ein Abschnitt wie modules-active.js: leeren, warten, dann HINTEN anhaengen. */
async function sectionThatAppends(host, waitMs) {
  host.replaceChildren();
  await delay(waitMs);
  host.insertAdjacentHTML('beforeend', '<section class="settings-section"></section>');
}

test('placeSkeletonUntilContent: kommt der Inhalt nach dem Skelett, geht das Skelett (Critique R19)', async () => {
  const host = new FakeNode('host');
  host.connected = true;
  // Kuenstliche Verzoegerung: der Abschnitt antwortet nach 40 ms, das Skelett
  // kommt nach 10 ms - das Rennen, das in Einstellungen -> Module mit einer
  // langsamen /modules-Antwort fast immer verloren ging.
  const render = sectionThatAppends(host, 40);
  await delay(10);
  const skeleton = placeSkeletonUntilContent(host, renderSkeletonList({ rows: 2, lines: 3 }), { Observer: FakeObserver });
  assert.ok(skeleton, 'Vorbedingung: der leere Traeger bekommt ein Skelett');
  assert.deepEqual(host.childNodes.map((n) => n.name), ['skeleton-list']);
  await render;
  await delay(0);
  assert.deepEqual(host.childNodes.map((n) => n.name), ['settings-section'],
    'das Skelett steht noch vor dem fertigen Inhalt');
});

test('placeSkeletonUntilContent: ein Traeger mit Inhalt oder ausserhalb des Dokuments bekommt keins', () => {
  const host = new FakeNode('host');
  assert.equal(placeSkeletonUntilContent(host, renderSkeletonList(), { Observer: FakeObserver }), null);
  host.connected = true;
  host.appendChild(new FakeNode('content'));
  assert.equal(placeSkeletonUntilContent(host, renderSkeletonList(), { Observer: FakeObserver }), null);
  assert.deepEqual(host.childNodes.map((n) => n.name), ['content']);
});

test('placeSkeletonUntilContent: ersetzt der Abschnitt den Traeger, bleibt nur sein Inhalt', async () => {
  const host = new FakeNode('host');
  host.connected = true;
  placeSkeletonUntilContent(host, renderSkeletonList(), { Observer: FakeObserver });
  host.replaceChildren(new FakeNode('retry-state'));
  await delay(0);
  assert.deepEqual(host.childNodes.map((n) => n.name), ['retry-state']);
});

test('die Einstellungs-Shell legt ihr Skelett ueber placeSkeletonUntilContent', () => {
  const shell = readFileSync(new URL('../public/settings/shell.js', import.meta.url), 'utf8');
  const timer = shell.slice(shell.indexOf('const skeletonTimer'), shell.indexOf('SKELETON_DELAY_MS);', shell.indexOf('const skeletonTimer')));
  assert.match(timer, /placeSkeletonUntilContent\(host, renderSkeletonList/);
  assert.doesNotMatch(timer, /insertAdjacentHTML/, 'die Shell legt das Skelett wieder selbst ab - es raeumt sich dann nicht');
});
