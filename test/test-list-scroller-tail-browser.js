/**
 * Modul: Das Ende einer Zeilenliste steht ueber der Navigation (#2346) - Browser-Sonde
 * Zweck: Auf dem iPhone lag die letzte Rezeptzeile am Scrollende hinter der
 *        Kapsel: sie liess sich nur im Gummiband kurz hervorziehen und sprang
 *        beim Loslassen zurueck. Der Nachlauf (`padding-block-end` der Rolle
 *        `.page-scrollport`) stand zwar am Scroller, zaehlte aber nicht:
 *        `.row-carrier` traegt `overflow: hidden`, seine automatische
 *        Mindesthoehe ist damit 0, und die `auto`-Spur von `.list-scroller`
 *        blieb auf der Hoehe des Ports stehen. Der Traeger lief ueber die Spur
 *        hinaus, das Polster haengt am Ende der SPUR. Gemessen in Safari
 *        (iOS 27, Simulator) und Chrome gleich: 14 Rezepte, Scrollhoehe 925px
 *        statt 1005px, der Nachlauf von 80px fehlte ganz.
 * Ausfuehren: npm run test:list-scroller-tail-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER. Was als scrollbarer Ueberlauf zaehlt, entscheidet erst die
 * Spurberechnung; im CSS-Text steht der Nachlauf in beiden Fassungen gleich
 * richtig da. Die Sonde braucht weder Server noch Anmeldung: eine statische
 * Seite mit den ECHTEN Stylesheets und dem Geruest aus router.js und recipes.js.
 *
 * DIE SONDE PRUEFT ZUERST, DASS SIE ETWAS MISST: die Liste muss ueberlaufen, und
 * der Nachlauf muss die Hoehe der Kapsel haben. Eine kurze Liste faende nichts.
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
const SHEETS = ['tokens', 'reset', 'layout', 'typography', 'list-row', 'recipes', 'pantry'];

const rows = (count) => Array.from({ length: count }, (_, i) => `
  <li class="recipe-row-item list-row" style="min-height: 64px"><div class="list-row__main"><span class="list-row__name">Rezept ${i + 1}</span></div></li>`).join('');

const shell = (inner) => `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${SHEETS.map((name) => `<link rel="stylesheet" href="${pathToFileURL(join(ROOT, 'public/styles', `${name}.css`)).href}">`).join('\n')}
</head><body><div class="app-shell"><main class="app-content"><div class="page-transition">${inner}</div></main></div></body></html>`;

/* Rezepte: der Traeger ist direktes Kind des Scrollers (recipes.js). */
const CARRIER = shell(`<div class="recipes-page">
  <div class="list-scroller page-scrollport recipes-list" id="port"><ul class="row-carrier">${rows(30)}</ul></div>
</div>`);

/* Zwei Traeger nebeneinander, wie sie ein flacher Filter im Vorrat stellen kann:
 * ohne Spurhoehe aus dem Inhalt laegen sie uebereinander. */
const TWO_CARRIERS = shell(`<div class="recipes-page">
  <div class="list-scroller page-scrollport recipes-list" id="port"><ul class="row-carrier">${rows(16)}</ul><ul class="row-carrier">${rows(16)}</ul></div>
</div>`);

/* Gegenprobe am Messgeraet: mit der Gruppe dazwischen stand die Spur schon
 * immer auf Inhaltshoehe. Dieser Fall war nie rot und zeigt, was „gut" misst. */
const GROUPED = shell(`<div class="recipes-page">
  <div class="list-scroller page-scrollport recipes-list" id="port"><div class="list-group"><ul class="row-carrier">${rows(30)}</ul></div></div>
</div>`);

let browser;

before(async () => {
  browser = await launchBrowser(puppeteer, { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

after(async () => {
  await browser?.close();
});

async function measure(html, { width = 390, height = 844 } = {}) {
  const file = join(tempDir('yuvomi-list-tail-'), 'list.html');
  writeFileSync(file, html);
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, isMobile: true, hasTouch: true });
    await page.goto(pathToFileURL(file).href);
    return await page.evaluate(() => {
      const port = document.getElementById('port');
      const tail = parseFloat(getComputedStyle(port).paddingBlockEnd);
      port.scrollTop = 1e6;
      const carriers = [...port.querySelectorAll('.row-carrier')].map((el) => el.getBoundingClientRect());
      const last = carriers.at(-1);
      return {
        tail,
        overflow: port.scrollHeight - port.clientHeight,
        // Luft zwischen dem Ende der Liste und der Unterkante des Ports am Scrollende.
        room: Math.round(port.getBoundingClientRect().bottom - last.bottom),
        overlap: carriers.slice(1).some((rect, i) => rect.top < carriers[i].bottom - 1),
      };
    });
  } finally {
    await page.close();
  }
}

test('die Sonde misst: die Liste laeuft ueber, der Nachlauf hat die Hoehe der Kapsel', async () => {
  const { tail, overflow } = await measure(GROUPED);
  assert.ok(overflow > 0, `die Liste muss ueberlaufen, sonst misst die Sonde nichts (Ueberlauf ${overflow}px)`);
  assert.ok(tail >= 64, `Nachlauf ${tail}px - unter 1024px traegt ihn die Kapsel (--nav-tail)`);
});

test('Gegenprobe: in einer Gruppe steht der Traeger ueber der Navigation', async () => {
  const { tail, room } = await measure(GROUPED);
  assert.ok(room >= tail, `Luft ${room}px bei Nachlauf ${tail}px`);
});

test('#2346: ein Traeger als direktes Kind des Scrollers endet ueber der Navigation', async () => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 393, height: 660 }, { width: 320, height: 568 }]) {
    const { tail, room, overflow } = await measure(CARRIER, viewport);
    assert.ok(overflow > 0, `${viewport.width}x${viewport.height}: die Liste muss ueberlaufen`);
    assert.ok(room >= tail, `${viewport.width}x${viewport.height}: am Scrollende ${room}px Luft unter der `
      + `letzten Zeile, der Nachlauf verlangt ${tail}px - die Zeile liegt hinter der Kapsel`);
  }
});

test('#2346: zwei Traeger im Scroller liegen untereinander, das Ende ueber der Navigation', async () => {
  const { tail, room, overlap } = await measure(TWO_CARRIERS);
  assert.equal(overlap, false, 'die Traeger ueberlappen: die Spur richtet sich nicht nach ihrem Inhalt');
  assert.ok(room >= tail, `Luft ${room}px bei Nachlauf ${tail}px`);
});
