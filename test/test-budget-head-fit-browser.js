/**
 * Modul: Der Budget-Kopf an der gerenderten Seite (#2443) - Browser-Sonde
 * Zweck: Neben dem 192px-Stepper bleiben dem Large Title Breite minus 264px.
 *        #2440 legte den Stepper nur unter 390px in eine eigene Zeile; ab 390px
 *        stand der Titel in elf Sprachen gekuerzt (es "Presupues..." bei 390px,
 *        el selbst bei 430px). Jetzt misst der Kopf: passt der Titel neben dem
 *        Stepper nicht ganz, bekommt der Stepper die eigene Zeile, bei jeder
 *        Breite (`budget-nav--period-own-row`, pages/budget.js watchHeadFit).
 * Ausfuehren: npm run test:budget-head-fit-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER. Ob "Presupuesto" in 34px neben den Stepper passt, weiss kein
 * Stylesheet-Scan; gemessen wird der Titel selbst (scrollWidth gegen
 * clientWidth), wie ihn Chrome setzt.
 *
 * JEDE SONDE PRUEFT ZUERST, DASS SIE ETWAS MISST: ohne Titel und Stepper im
 * Kopf ist "nicht gekuerzt" kein Befund.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute, DEVICES } from './document-guards-harness.js';

let harness;

before(async () => {
  harness = await startHarness();
});

beforeEach(async () => {
  await harness.reset();
});

after(async () => {
  await harness?.close();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Titel, Stepper und Kopf, wie sie gerade stehen. */
function measureHead(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('.budget-nav');
    const title = nav?.querySelector(':scope > .page-toolbar__title');
    const prev = nav?.querySelector('#budget-prev');
    if (!nav || !title || !prev) return null;
    const t = title.getBoundingClientRect();
    const p = prev.getBoundingClientRect();
    return {
      text: title.textContent.trim(),
      titleScroll: title.scrollWidth,
      titleClient: title.clientWidth,
      // Der Pfeil steht in der Zeile des Titels, wenn er dessen Hoehe kreuzt.
      oneRow: p.top < t.bottom && p.bottom > t.top,
      ownRow: nav.classList.contains('budget-nav--period-own-row'),
      head: Math.round(nav.getBoundingClientRect().height),
      collapsed: nav.classList.contains('is-collapsed'),
    };
  });
}

async function openBudget(locale, width) {
  const page = await openPage(harness, { device: 'mobile', locale });
  await page.setViewport({ ...DEVICES.mobile, width });
  await gotoRoute(page, '/budget');
  await page.waitForSelector('.budget-nav #budget-prev', { timeout: 15000 });
  return page;
}

const CASES = [
  // de passt ab 390px neben den Stepper und bleibt dort einzeilig.
  { locale: 'de', width: 390, oneRow: true },
  { locale: 'de', width: 430, oneRow: true },
  { locale: 'de', width: 360, oneRow: false },
  // es "Presupuesto" (206px) und el (vorher "Προϋπολογισμός", 282px) passen
  // bei 390 und 430px nicht neben den Stepper.
  { locale: 'es', width: 390, oneRow: false },
  { locale: 'es', width: 430, oneRow: false },
  { locale: 'el', width: 390, oneRow: false },
  { locale: 'el', width: 430, oneRow: false },
  // Griechisch kuerzte selbst in der eigenen Zeile (320px, 271px Text in 252px):
  // der Budget-Kopf traegt dort "Οικονομικά", die Navigation den langen Namen.
  { locale: 'el', width: 320, oneRow: false },
  // Ein kurzer Titel behaelt den Stepper neben sich, auch unter 390px: die
  // feste Grenze aus #2440 schob ihn dort ohne Not darunter.
  { locale: 'ja', width: 360, oneRow: true },
];

for (const { locale, width, oneRow } of CASES) {
  test(`Budget-Kopf ${locale} ${width}px: der Titel steht ganz${oneRow ? ', der Stepper bleibt in seiner Zeile' : ', der Stepper nimmt eine eigene Zeile'}`, async () => {
    const page = await openBudget(locale, width);
    const head = await measureHead(page);
    assert.ok(head && head.text, 'kein Titel und kein Stepper im Kopf - die Sonde misst nichts');
    assert.equal(head.collapsed, false, 'der Kopf ist eingeklappt, gemessen wird der ausgeklappte');
    assert.ok(head.titleScroll <= head.titleClient,
      `"${head.text}" ist gekuerzt: ${head.titleScroll}px Text in ${head.titleClient}px (${JSON.stringify(head)})`);
    assert.equal(head.oneRow, oneRow, `Stepper ${oneRow ? 'in' : 'unter'} der Titelzeile erwartet: ${JSON.stringify(head)}`);

    // Der Monatswechsel bewegt nichts: weder die Zeile noch die Hoehe des Kopfs.
    await page.click('#budget-next');
    await wait(600);
    const after = await measureHead(page);
    assert.equal(after.head, head.head, `der Monatswechsel aendert die Kopfhoehe: ${head.head} -> ${after.head}px`);
    assert.equal(after.oneRow, head.oneRow, 'der Monatswechsel schiebt den Stepper in eine andere Zeile');
    await page.close();
  });
}

/* KEIN HIN UND HER (Hysterese). Gemessen wird der Titel gegen den Platz in
 * EINER Zeile, nicht gegen den Zustand, in dem der Kopf gerade steht: in der
 * eigenen Zeile passt jeder Titel, und eine Rechnung ueber den aktuellen
 * Zustand schaltete sofort zurueck. Breiter und wieder schmaler gezogen steht
 * der Kopf jeweils so wie beim frischen Laden in dieser Breite. */
test('Budget-Kopf de: hin und zurueck ueber die Grenze steht er wie frisch geladen', async () => {
  const page = await openBudget('de', 360);
  const narrow = await measureHead(page);
  assert.equal(narrow.oneRow, false, `bei 360px steht der Stepper unter dem Titel: ${JSON.stringify(narrow)}`);
  await page.setViewport({ ...DEVICES.mobile, width: 430 });
  await wait(400);
  const wide = await measureHead(page);
  assert.equal(wide.oneRow, true, `bei 430px rueckt er zurueck: ${JSON.stringify(wide)}`);
  assert.ok(wide.titleScroll <= wide.titleClient, `"${wide.text}" gekuerzt nach dem Verbreitern`);
  await page.setViewport({ ...DEVICES.mobile, width: 360 });
  await wait(400);
  const again = await measureHead(page);
  assert.deepEqual(again, narrow, 'zurueck bei 360px steht der Kopf anders als frisch geladen');
  await page.close();
});

/* EINGEKLAPPT BLEIBT R19 (169 -> 65px): Reiter und Stepper teilen die eine
 * Zeile, auch wenn der Stepper ausgeklappt eine eigene Zeile hat. Eingeklappt
 * misst der Kopf nicht - der Titel ist aus dem Bild -, und ausgeklappt steht
 * er wieder wie vorher. */
test('Budget-Kopf es 390px: eingeklappt eine Zeile, ausgeklappt wieder die eigene', async () => {
  const page = await openBudget('es', 390);
  const open = await measureHead(page);
  assert.equal(open.ownRow, true, `bei 390px braucht "Presupuesto" die eigene Zeile: ${JSON.stringify(open)}`);
  const box = await page.evaluate(() => {
    const r = document.querySelector('.page-scrollport').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 100 };
  });
  await page.mouse.move(box.x, box.y);
  for (let i = 0; i < 6; i += 1) { await page.mouse.wheel({ deltaY: 80 }); await wait(120); }
  await wait(900);
  const folded = await measureHead(page);
  assert.equal(folded.collapsed, true, 'der Kopf klappt beim Scrollen nicht ein - die Sonde misst nichts');
  assert.equal(folded.head, 65, `eingeklappt misst der Kopf wie in R19 65px, nicht ${folded.head}px`);
  for (let i = 0; i < 8; i += 1) { await page.mouse.wheel({ deltaY: -120 }); await wait(120); }
  await wait(900);
  const back = await measureHead(page);
  assert.equal(back.collapsed, false, 'der Kopf klappt oben nicht wieder auf');
  assert.equal(back.head, open.head, `ausgeklappt steht der Kopf anders als vorher: ${open.head} -> ${back.head}px`);
  assert.equal(back.ownRow, true, 'ausgeklappt fehlt die eigene Zeile wieder');
  await page.close();
});
