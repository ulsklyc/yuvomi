/**
 * Test: Rezept-Vorschaubilder laden faul und tragen ihre Version (#2048)
 * Zweck: Ein Nutzer mit 500 gespiegelten Mealie-Rezepten bekam auf dem iPhone
 *        beim Oeffnen der Rezeptliste HTTP 429. Zwei Ursachen auf der
 *        Client-Seite, beide hier gemessen:
 *
 *        1. `img.src` stand VOR `img.loading = 'lazy'`. Mit `src` startet der
 *           Abruf; Safari und Firefox entscheiden in dem Moment, ob er faul
 *           ist, und holten so jedes Bild der Liste sofort. Gemessen wird die
 *           REIHENFOLGE der Zuweisungen am echten recipeThumbEl()/recipeHeroEl(),
 *           dazu ein Sweep ueber jedes `createElement('img')` in public/.
 *        2. Die Adresse trug keine Version, der Server durfte das Bild deshalb
 *           nicht cachen. Jetzt `?v=<provider_updated_at>` - und die echten
 *           Aufrufer (Rezeptliste, Planer, Uebersichtskachel) reichen sie durch.
 *
 * Ausfuehren: npm run test:recipe-thumb-lazy
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Ein Element, das jede Zuweisung an `src`, `loading` und `decoding` der Reihe
// nach mitschreibt - genau die Reihenfolge, auf die es ankommt.
function fakeElement(tag) {
  const writes = [];
  const values = {};
  const el = {
    tagName: tag.toUpperCase(),
    writes,
    children: [],
    className: '',
    alt: '',
    classList: { add() {} },
    dataset: {},
    insertAdjacentHTML() {},
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    remove() {},
  };
  for (const key of ['src', 'loading', 'decoding']) {
    Object.defineProperty(el, key, {
      get: () => values[key],
      set: (v) => { writes.push(key); values[key] = v; },
    });
  }
  return el;
}

globalThis.document = { createElement: (tag) => fakeElement(tag) };

const { recipeThumbEl, recipeHeroEl, recipeThumbHtml } = await import('../public/utils/recipe-thumb.js');

function assertLazyBeforeSrc(img, label) {
  const src = img.writes.indexOf('src');
  const loading = img.writes.indexOf('loading');
  assert.ok(src >= 0, `${label}: src wird gesetzt`);
  assert.ok(loading >= 0, `${label}: loading wird gesetzt`);
  assert.equal(img.loading, 'lazy', `${label}: loading ist lazy`);
  assert.ok(loading < src, `${label}: loading muss VOR src stehen, Reihenfolge war ${img.writes.join(' -> ')}`);
  const decoding = img.writes.indexOf('decoding');
  assert.ok(decoding >= 0 && decoding < src, `${label}: decoding vor src, Reihenfolge war ${img.writes.join(' -> ')}`);
}

test('#2048 recipeThumbEl: loading und decoding vor src (Providerbild)', () => {
  const slot = recipeThumbEl({ recipeId: 7, hasImage: true, imageVersion: '2026-10-01T08:15:30', className: 'recipe-row__thumb' });
  const img = slot.children[0];
  assertLazyBeforeSrc(img, 'Providerbild');
});

test('#2048 recipeThumbEl: loading und decoding vor src (eigenes Bild)', () => {
  const slot = recipeThumbEl({ recipeId: 7, hasOwnImage: true, className: 'recipe-row__thumb' });
  assertLazyBeforeSrc(slot.children[0], 'eigenes Bild');
});

test('#2048 recipeHeroEl: loading und decoding vor src', () => {
  const frame = recipeHeroEl({ recipeId: 7, hasOwnImage: true });
  assertLazyBeforeSrc(frame.children[0], 'Kopfbild');
});

test('#2048 die Providerbild-Adresse traegt die Version, URL-kodiert', () => {
  const slot = recipeThumbEl({ recipeId: 7, hasImage: true, imageVersion: '2026-10-01T08:15:30+00:00', className: 'x' });
  assert.equal(slot.children[0].src, '/api/v1/recipes/7/provider-thumbnail?v=2026-10-01T08%3A15%3A30%2B00%3A00');
  const html = recipeThumbHtml({ recipeId: 7, hasImage: true, imageVersion: '2026-10-01T08:15:30', className: 'meal-card__thumb' });
  assert.match(html, /src="\/api\/v1\/recipes\/7\/provider-thumbnail\?v=2026-10-01T08%3A15%3A30"/);
  assert.match(html, /loading="lazy"/);
  // Ohne Version keine leere Abfrage, das eigene Bild nie mit Version.
  assert.equal(recipeThumbEl({ recipeId: 7, hasImage: true, className: 'x' }).children[0].src, '/api/v1/recipes/7/provider-thumbnail');
  assert.equal(recipeThumbEl({ recipeId: 7, hasImage: true, hasOwnImage: true, imageVersion: 'a', className: 'x' }).children[0].src, '/api/v1/recipes/7/image');
});

test('#2048 die echten Aufrufer reichen die Version durch', () => {
  const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');
  const cases = [
    ['pages/recipes.js', /recipeThumbEl\(\{[^}]*imageVersion:\s*recipe\.provider_updated_at/],
    ['pages/meals.js', /recipeThumbHtml\(\{[^}]*imageVersion:\s*meal\.recipe_image_version/],
    ['pages/dashboard.js', /recipeThumbHtml\(\{[^}]*imageVersion:\s*meal\.recipe_image_version/],
  ];
  for (const [file, re] of cases) assert.match(read(file), re, `${file} reicht imageVersion nicht durch`);
});

// Jedes <img>, das per DOM-API entsteht und faul laden soll, setzt `loading`
// vor `src`. Gelesen wird der Block ab `createElement('img')` bis zum
// naechsten `createElement` derselben Variable oder 40 Zeilen.
function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === 'vendor') continue;
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('#2048 Sweep: kein <img> aus der DOM-API setzt src vor loading', () => {
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  const offenders = [];
  let checked = 0;
  for (const file of jsFiles(publicDir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = /(?:const|let)\s+(\w+)\s*=\s*document\.createElement\(\s*['"]img['"]\s*\)/.exec(line);
      if (!m) return;
      const v = m[1];
      const block = lines.slice(i + 1, i + 41);
      const at = (re) => block.findIndex((l) => re.test(l));
      const src = at(new RegExp(`\\b${v}\\.src\\s*=`));
      const loading = at(new RegExp(`\\b${v}\\.loading\\s*=`));
      if (loading < 0) return;
      checked += 1;
      if (src >= 0 && src < loading) offenders.push(`${file.slice(publicDir.length)}:${i + 1}`);
    });
  }
  assert.ok(checked >= 4, `der Sweep sieht die faulen Bilder (gefunden: ${checked})`);
  assert.deepEqual(offenders, [], 'loading vor src setzen, sonst laedt Safari sofort');
});
