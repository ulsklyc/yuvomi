/**
 * Modul: Der Suchschalter der Kuechenleiste ist 24px breit und trifft 44px (#2043) - Browser-Sonde
 * Zweck: Die Leiste traegt vier Tabs mit Zaehlern UND eine Trailing-Zone mit
 *        Suchschalter. Bei 375px passt das nur, wenn der Schalter wirklich
 *        24px breit ist.
 * Ausfuehren: npm run test:kitchen-tabs-fit-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER. Die Unit-Probe in test-kitchen-tabs.js rechnet mit
 * Deklarationen, und genau daran ist der erste Versuch vorbeigelaufen: das
 * Modul deckelte den Knopf mit `max-width: 24px`, waehrend `.btn--icon` in
 * layout.css `min-width: var(--target-base)` setzt. In CSS gewinnt `min-width`
 * gegen `max-width` - der Knopf blieb 48px breit, die Leiste brauchte 398px
 * von 375, und die Deklaration sagte trotzdem 24. Eine gerechnete Breite kann
 * das nicht sehen; der Browser schon. Seitdem traegt die Shell die Groesse
 * (`.btn--icon-tight`), und hier wird sie GEMESSEN.
 *
 * ZWEITE MESSUNG: die Trefferflaeche. 24px ist der WCAG-2.5.8-Boden, nicht die
 * Flaeche, die ein Finger bekommen soll - ein ::before zieht sie auf
 * --target-base. Gepruefte wird sie mit elementFromPoint an ihren Raendern,
 * nicht an der inset-Deklaration: eine Flaeche, die rechnerisch da ist, aber
 * von einem Nachbarn verdeckt wird, trifft nicht.
 *
 * DIE SONDE PRUEFT ZUERST, DASS SIE ETWAS MISST: ohne die Variante ist der
 * Knopf wieder --target-base breit und die Leiste braucht genau die 24px mehr.
 * Steht beides nicht in der Gegenprobe, misst die Sonde die falsche Kante.
 *
 * WAS HIER NICHT GEPRUEFT WIRD, UND WARUM: die absolute Zusage „374,3px von
 * 375". `--font-sans` ist ein System-Stack (tokens.css) - auf dem iPhone ist
 * das SF Pro Text, in headless Chrome auf einem Linux-Runner die dort
 * installierte Ersatzschrift. Die ist breiter, und die Leiste laeuft in dieser
 * Sonde deshalb auch mit den 24px ueber. Eine absolute Breitenzusage waere hier
 * also eine Zusage ueber die Schriften des Runners, nicht ueber die App. Die
 * kalibrierten Wortbreiten stehen in test-kitchen-tabs.js (`WORD`), gemessen in
 * der echten Schrift; diese Sonde haelt das, was von der Maschine unabhaengig
 * ist: die GERENDERTE Breite des Knopfes, die Trefferflaeche, und dass die
 * Variante der Leiste genau die Differenz der beiden Zielgroessen spart.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { launchBrowser } from '../scripts/lib/chrome-executable.js';
import { tempDir } from './tmp-dir.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHEETS = ['tokens', 'reset', 'layout', 'typography', 'sub-tabs', 'kitchen-tabs'];

/* Die vier Kuechen-Tabs mit den Zaehlern, die Einkauf und Vorrat tragen - der
 * aktive Tab zeigt seinen nicht. Rezepte ist aktiv, weil Rezepte und Vorrat
 * die Zone fuellen und Rezepte das laengere Wort hat. */
const TABS = [
  { label: 'Mahlzeiten', badge: null },
  { label: 'Rezepte', badge: null, active: true },
  { label: 'Einkauf', badge: '23' },
  { label: 'Vorrat', badge: '12' },
];

const tab = ({ label, badge, active }) => `<a class="sub-tab${active ? ' sub-tab--active' : ''}" href="#"${active ? ' aria-current="page"' : ''}>`
  + `<span class="sub-tab__label">${label}</span> `
  + `<span class="sub-tab__badge"${badge ? '' : ' hidden'}>${badge ?? ''}</span></a>`;

/* `btn--icon-tight` ist die Variante, um die es geht. Die Gegenprobe nimmt sie
 * dem Knopf wieder weg, deshalb steht die Leiste zweimal auf der Seite.
 *
 * Die Klassen sind die von renderSubTabs(): `sub-tabs-bar kitchen-tabs-bar`.
 * Darauf kommt es an - `.sub-tabs-bar` traegt `overflow-x: auto` und
 * `.sub-tab` traegt `flex-shrink: 0`, also SCROLLT die Leiste, statt Labels zu
 * kuerzen. Siegel und Titel stehen mit in der Probe, weil die echte Leiste sie
 * baut; mobil nimmt ihnen kitchen-tabs.css die Breite (`display: none`). */
const bar = (id, tightClass) => `<div id="${id}" class="kitchen-tabs-host">
  <nav class="sub-tabs-bar kitchen-tabs-bar" aria-label="Kueche">
    <span class="module-seal module-seal--head" aria-hidden="true"><i data-lucide="utensils"></i></span>
    <span class="sub-tabs-bar__title" aria-hidden="true">Kueche</span>
    ${TABS.map(tab).join('\n    ')}
    <div class="kitchen-tabs-bar__trailing">
      <button type="button" class="btn btn--icon ${tightClass} btn--ghost recipes-search-toggle" aria-label="Suche">
        <i data-lucide="search" aria-hidden="true"></i>
      </button>
    </div>
  </nav>
</div>`;

const PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${SHEETS.map((name) => `<link rel="stylesheet" href="${pathToFileURL(join(ROOT, 'public/styles', `${name}.css`)).href}">`).join('\n')}
<style>
  /* Das Seitenpolster der Shell, in dem die Leiste steht (--space-4 je Seite). */
  .kitchen-tabs-host { padding-inline: var(--space-4); }
</style>
</head><body>
${bar('host-tight', 'btn--icon-tight')}
${bar('host-plain', '')}
</body></html>`;

let browser;
let url;

before(async () => {
  // tempDir() raeumt beim Prozessende weg (test/tmp-dir.js, test:tmp-clean).
  const file = join(tempDir('yuvomi-kitchen-fit-'), 'bar.html');
  writeFileSync(file, PAGE);
  url = pathToFileURL(file).href;
  browser = await launchBrowser(puppeteer, { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

after(async () => {
  await browser?.close();
});

/**
 * Misst eine der beiden Leisten bei 375px am FINGER: `hover: none` schaltet
 * --target-base in tokens.css auf --target-lg (48px), und das ist der Fall,
 * in dem die Leiste zu breit wurde.
 */
async function measure(hostId) {
  const page = await browser.newPage();
  try {
    // `hasTouch`/`isMobile` statt emulateMediaFeatures: Puppeteer kennt
    // `hover` dort nicht, und die uebrigen Sonden des Repos stellen den Finger
    // genauso ein (test-dashboard-surface-browser.js).
    await page.setViewport({
      width: 375, height: 760, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate((hostId) => {
      // Nur die gemessene Leiste steht auf der Seite - die andere wuerde mit
      // ihrer eigenen Breite nichts verfaelschen, aber elementFromPoint soll
      // eindeutig sein.
      for (const host of document.querySelectorAll('.kitchen-tabs-host')) {
        if (host.id !== hostId) host.remove();
      }
      const host = document.getElementById(hostId);
      const nav = host.querySelector('.kitchen-tabs-bar');
      const btn = host.querySelector('.kitchen-tabs-bar__trailing .btn--icon');
      const r = btn.getBoundingClientRect();

      // Die Trefferflaeche, wie sie der Finger findet: vom ::before nach oben
      // und unten gezogen. Gesucht wird der aeusserste Punkt auf der
      // Mittelachse des Knopfes, der noch den Knopf trifft.
      const x = Math.round(r.left + r.width / 2);
      const hits = (y) => {
        const el = document.elementFromPoint(x, y);
        return !!el && (el === btn || btn.contains(el));
      };
      let top = Math.round(r.top + r.height / 2);
      let bottom = top;
      while (top > 0 && hits(top - 1)) top -= 1;
      while (bottom < window.innerHeight - 1 && hits(bottom + 1)) bottom += 1;

      return {
        // Die gerenderte Breite des Knopfes - der Wert, den die Deklaration
        // behauptete und nicht lieferte.
        width: Math.round(r.width * 10) / 10,
        height: Math.round(r.height * 10) / 10,
        // Die gemessene Trefferflaeche, nicht die gerechnete.
        hitHeight: bottom - top + 1,
        // Laeuft die Leiste ueber? scrollWidth > clientWidth heisst: sie scrollt.
        barScrollWidth: nav.scrollWidth,
        barClientWidth: nav.clientWidth,
        overflow: nav.scrollWidth - nav.clientWidth,
        targetBase: getComputedStyle(document.documentElement).getPropertyValue('--target-base').trim(),
      };
    }, hostId);
  } finally {
    await page.close();
  }
}

test('der Suchschalter misst gerenderte 24px, nicht die 48px der Shell-Basis', async () => {
  const m = await measure('host-tight');

  // Die Vorbedingung des Falls: am Finger steht --target-base auf 48px.
  assert.equal(m.targetBase, '48px',
    `am Finger muss --target-base 48px sein, gemessen: ${m.targetBase}`);

  assert.ok(Math.abs(m.width - 24) <= 0.5,
    `der Schalter ist ${m.width}px breit, erwartet werden 24px (--space-6). `
    + 'Deckelt ein Modul ihn wieder mit max-width, gewinnt min-width aus .btn--icon '
    + 'und der Knopf steht still auf --target-base.');
  assert.ok(Math.abs(m.height - 24) <= 0.5,
    `der Schalter ist ${m.height}px hoch, erwartet werden 24px`);
});

test('die Trefferflaeche des 24px-Schalters erreicht --target-base', async () => {
  const m = await measure('host-tight');

  // 24px ist der WCAG-Boden der SICHTBAREN Taste; der Finger bekommt
  // --target-base, gezogen vom ::before der Zone.
  assert.ok(m.hitHeight >= 44,
    `die Trefferflaeche ist ${m.hitHeight}px hoch, mindestens 44px werden getroffen `
    + '(::before der Trailing-Zone). Verdeckt ein Nachbar sie, faellt der Wert hier und nicht in der Deklaration.');
});

test('die Gegenprobe: ohne die Variante kostet der Schalter die Leiste genau die Differenz', async () => {
  const tight = await measure('host-tight');
  const plain = await measure('host-plain');

  assert.ok(Math.abs(plain.width - parseFloat(plain.targetBase)) <= 0.5,
    `ohne btn--icon-tight muss der Schalter wieder --target-base (${plain.targetBase}) breit sein, `
    + `gemessen: ${plain.width}px. Tut er das nicht, misst die Sonde nicht die Breite des Knopfes.`);

  // Der Gewinn der Variante, unabhaengig von der Schrift des Runners: die
  // Leiste braucht genau die Differenz der beiden Zielgroessen weniger.
  const gewinn = plain.barScrollWidth - tight.barScrollWidth;
  const erwartet = plain.width - tight.width;
  assert.ok(Math.abs(gewinn - erwartet) <= 1,
    `die Variante muss der Leiste ${erwartet}px sparen, gemessen: ${gewinn}px `
    + `(${plain.barScrollWidth}px ohne, ${tight.barScrollWidth}px mit). Spart sie nichts, `
    + 'steht der Knopf nicht in der Zone, die die Breite der Leiste bestimmt.');
});
