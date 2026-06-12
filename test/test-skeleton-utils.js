/**
 * Tests: Skeleton-Lade-Hilfen (public/utils/skeleton.js)
 * Reine String-Funktionen — kein DOM erforderlich.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSkeletonCard, renderSkeletonList } from '../public/utils/skeleton.js';

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
