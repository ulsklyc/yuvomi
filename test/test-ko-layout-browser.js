/**
 * Modul: Drei Layoutpunkte aus #1607 an der gerenderten Seite - Browser-Sonde
 * Zweck: (1) Ein Aufgabentitel ohne Leerzeichen lief aus seiner Karte am Brett
 *        (gemessen: 2092px Titel in 188px Spalte). (2) Koreanischer Fliesstext
 *        brach zwischen zwei Silben um ("선택합니 / 다."), 68 Stellen in 27 von
 *        46 Ansichten bei 375px. (3) Die Werteachse des Budget-Verlaufs stand
 *        in Won links ausserhalb ihres Scrollports ("₩6,000,000": 6px bei 375px
 *        Fensterbreite, 13px bei 1280px).
 * Ausfuehren: npm run test:ko-layout-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER. Alle drei Befunde sind Masse eines gesetzten Dokuments: wo
 * eine Zeile umbricht und wie breit "₩6,000,000" in 12px steht, weiss kein
 * Stylesheet-Scan. `getComputedStyle` kennt auch keinen abgeschnittenen
 * SVG-Text - gemessen wird deshalb die Lage des Texts gegen die Kante, die ihn
 * abschneidet. Die Rechnung hinter Punkt 3 haelt `test:chart-gutter` ohne
 * Browser; ob der Budget-Verlauf gemessen wird und Chrome die Formel so
 * anwendet, steht nur hier (die uebrigen Diagramme: `test:chart-gutter-browser`).
 *
 * DIE GANZE APP im Harness der Dokument-Guards: echter Server, Demo-Seed,
 * angemeldet. Was eine Sonde braucht (Aufgaben, Buchungen, Waehrung), legt sie
 * selbst ueber die API an - `reset()` stellt vor jedem Fall den Seed wieder her.
 *
 * JEDE SONDE PRUEFT ZUERST, DASS SIE ETWAS MISST: eine Karte, die nicht da ist,
 * laeuft nirgends heraus, und ein Hinweis in einer Zeile bricht nirgends um.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute } from './document-guards-harness.js';

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

/** Ruft die API aus der Seite heraus, mit dem CSRF-Wert der Sitzung. */
async function api(page, method, path, body) {
  const result = await page.evaluate(async ({ method, path, body }) => {
    const raw = document.cookie.split('; ').find((c) => c.startsWith('csrf-token='));
    const res = await fetch(`/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(raw ? raw.slice('csrf-token='.length) : '') },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, text: (await res.text()).slice(0, 300) };
  }, { method, path, body });
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${path} -> ${result.status} ${result.text}`);
  return result;
}

/* ── 1. Der Titel bleibt in seiner Karte ─────────────────────────────────── */

const MARK = 'q1607';
const TITLES = {
  // 200 Zeichen ist die Obergrenze der Route.
  einWort: `${MARK}${'A'.repeat(195)}`,
  adresse: `${MARK}://example.com/ein/sehr/langer/pfad/der/immer/weiter/geht/ohne/ein/einziges/leerzeichen/index.html?query=1234567890&weiter=abcdefghijklmnopqrstuvwxyz`,
  hangul: `${MARK}${'가나다라마바사아자차카타파하'.repeat(14)}`.slice(0, 200),
  // Der Gegenfall: kurze Woerter brechen weiter NUR an ihren Leerzeichen (keines ist lang
  // genug fuer die Silbentrennung: `hyphenate-limit-chars: 6 4 4` braucht acht Zeichen).
  woerter: `${MARK} ${'Wort Sommer Garten Fenster Abend '.repeat(5)}`.trim(),
};

for (const locale of ['de', 'ko']) {
  test(`Brett (${locale}): ein Titel ohne Leerzeichen bleibt in seiner Karte, ein Titel aus kurzen Woertern bricht am Leerzeichen`, async () => {
    const page = await openPage(harness, { device: 'desktop', locale });
    for (const title of Object.values(TITLES)) await api(page, 'POST', '/tasks', { title, status: 'open' });
    await page.evaluate(() => localStorage.setItem('yuvomi-tasks-view', 'kanban'));
    await gotoRoute(page, '/tasks');
    await page.waitForSelector('.kanban-card__title', { timeout: 15000 });

    const cards = await page.evaluate((mark) => [...document.querySelectorAll('.kanban-card')]
      .filter((card) => card.querySelector('.kanban-card__title')?.textContent.includes(mark))
      .map((card) => {
        const title = card.querySelector('.kanban-card__title');
        const column = card.closest('.kanban-col__body') ?? card.parentElement;
        const node = [...title.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim()) ?? title.firstChild;
        // Eine Zeile, die mitten im Wort beginnt: zwei Buchstaben ohne Leerzeichen dazwischen, auf zwei Zeilen.
        const range = document.createRange();
        const text = node?.nodeValue ?? '';
        let lines = 1;
        let insideWord = 0;
        let lastTop = null;
        let lastChar = ' ';
        for (let i = 0; i < text.length; i += 1) {
          const char = text[i];
          if (/\s/.test(char)) { lastChar = char; continue; }
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getClientRects()[0];
          if (!rect) continue;
          if (lastTop !== null && rect.top > lastTop + 4) {
            lines += 1;
            if (!/\s/.test(lastChar)) insideWord += 1;
          }
          lastTop = rect.top;
          lastChar = char;
        }
        return {
          text: title.textContent.trim().slice(0, 24),
          cardScroll: card.scrollWidth,
          cardClient: card.clientWidth,
          titleScroll: title.scrollWidth,
          titleClient: title.clientWidth,
          pastColumn: Math.round(title.getBoundingClientRect().right - column.getBoundingClientRect().right),
          lines,
          insideWord,
        };
      }), MARK);

    assert.equal(cards.length, Object.keys(TITLES).length, `nicht alle Probe-Karten stehen am Brett: ${JSON.stringify(cards)}`);
    for (const card of cards) {
      assert.ok(card.titleScroll <= card.titleClient + 1, `der Titel "${card.text}" ist ${card.titleScroll}px breit in ${card.titleClient}px`);
      assert.ok(card.cardScroll <= card.cardClient + 1, `die Karte "${card.text}" laeuft ueber: ${card.cardScroll}px Inhalt in ${card.cardClient}px`);
      assert.ok(card.pastColumn <= 0, `der Titel "${card.text}" ragt ${card.pastColumn}px ueber seine Spalte`);
    }
    const lang = cards.find((card) => card.text.startsWith(`${MARK}AAAA`));
    assert.ok(lang.lines > 1, 'der Titel aus einem Wort muss umbrechen, sonst misst die Sonde eine zu breite Spalte');
    const woerter = cards.find((card) => card.text.startsWith(`${MARK} Wort`));
    assert.ok(woerter.lines > 1, 'der Titel aus Woertern muss ueber mehrere Zeilen gehen');
    assert.equal(woerter.insideWord, 0, 'ein Titel aus kurzen Woertern bricht an seinen Leerzeichen, nie mitten im Wort');
    await page.close();
  });
}

/* ── 2. Koreanisch bricht an der Wortgrenze ──────────────────────────────── */

/** Zaehlt in einer Auswahl die Zeilenwechsel zwischen zwei Hangul-Silben ohne Leerzeichen dazwischen. */
function hangulBreaks(page, selector) {
  return page.evaluate((selector) => {
    const hangul = /[가-힣]/;
    const range = document.createRange();
    const found = [];
    let multiLine = 0;
    for (const el of document.querySelectorAll(selector)) {
      if (!el.offsetParent) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      let lines = 1;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue;
        let lastTop = null;
        let lastChar = ' ';
        for (let i = 0; i < text.length; i += 1) {
          const char = text[i];
          if (/\s/.test(char)) { lastChar = char; continue; }
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getClientRects()[0];
          if (!rect) continue;
          if (lastTop !== null && rect.top > lastTop + 4) {
            lines += 1;
            if (hangul.test(char) && hangul.test(lastChar)) found.push(`${text.slice(Math.max(0, i - 6), i)} / ${text.slice(i, i + 6)}`);
          }
          lastTop = rect.top;
          lastChar = char;
        }
      }
      if (lines > 1) multiLine += 1;
    }
    return { found, multiLine, lang: document.documentElement.lang, wordBreak: getComputedStyle(document.body).wordBreak };
  }, selector);
}

// Seit R17 (Einstellungen als Zeilen) steht der erklaerende Text eines Schalters
// in der Zeile selbst; das Blatt "Darstellung" hatte danach noch EINEN
// mehrzeiligen Hinweis der alten Bauarten, und die Sonde mass nichts.
const HINTS = '.form-hint, .settings-leaf-header__description, .settings-card-description, .settings-setting-row__description';

test('Koreanisch: ein Hinweis bricht an der Wortgrenze, nicht zwischen zwei Silben', async () => {
  const page = await openPage(harness, { device: 'mobile', locale: 'ko' });
  for (const route of ['/settings/personal/appearance', '/settings/admin/backup']) {
    await gotoRoute(page, route);
    const result = await hangulBreaks(page, HINTS);
    assert.equal(result.lang, 'ko', `${route}: die Seite steht nicht auf Koreanisch`);
    assert.ok(result.multiLine >= 2, `${route}: zu wenige mehrzeilige Hinweise (${result.multiLine}) - die Sonde misst nichts`);
    assert.deepEqual(result.found, [], `${route}: Umbruch mitten im Wort`);
  }
  await page.close();
});

test('die Regel gilt nur fuer Koreanisch: Deutsch, Japanisch und Chinesisch brechen um wie zuvor', async () => {
  for (const locale of ['de', 'ja', 'zh']) {
    const page = await openPage(harness, { device: 'mobile', locale });
    await gotoRoute(page, '/settings/personal/appearance');
    const style = await page.evaluate(() => {
      const hint = document.querySelector('.form-hint');
      return {
        lang: document.documentElement.lang,
        root: getComputedStyle(document.documentElement).wordBreak,
        hint: getComputedStyle(hint).wordBreak,
        hintWrap: getComputedStyle(hint).overflowWrap,
      };
    });
    assert.equal(style.lang, locale);
    assert.equal(style.root, 'normal', `${locale}: word-break am Wurzelelement`);
    assert.equal(style.hint, 'normal', `${locale}: word-break an einem Hinweis`);
    assert.equal(style.hintWrap, 'normal', `${locale}: overflow-wrap an einem Hinweis`);
    await page.close();
  }
});

/* ── 3. Die Werteachse steht im Bild ─────────────────────────────────────── */

/** Lage der Y-Werte des Budget-Verlaufs gegen die Kante, die sie abschneiden wuerde. */
function axisGeometry(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('svg.chart.budget-stats__trend');
    if (!svg) return null;
    let clip = svg.parentElement;
    while (clip && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement;
    const host = svg.parentElement;
    const labels = [...svg.querySelectorAll('.chart__axis--y')].map((label) => {
      const rect = label.getBoundingClientRect();
      return { text: label.textContent, left: rect.left, width: rect.width };
    });
    const points = [...host.querySelectorAll('.budget-stats__point')].map((p) => {
      const rect = p.getBoundingClientRect();
      return rect.left + rect.width / 2;
    });
    // DIE KURVE IST SEIT R17 AM HEUTIGEN TAG GETEILT (bis heute durchgezogen,
    // danach als eigener Zug): gemessen wird die Spanne ALLER Zuege. Der erste
    // allein endet heute - und der letzte Ablesepunkt steht am Monatsende.
    const spans = [...svg.querySelectorAll('polyline')].map((line) => line.getBoundingClientRect());
    const curve = { left: Math.min(...spans.map((r) => r.left)), right: Math.max(...spans.map((r) => r.right)) };
    return {
      clipLeft: (clip ?? document.documentElement).getBoundingClientRect().left,
      hostWidth: host.getBoundingClientRect().width,
      paddingLeft: parseFloat(getComputedStyle(svg).paddingLeft),
      svgRight: svg.getBoundingClientRect().right,
      hostRight: host.getBoundingClientRect().right,
      labels,
      firstPoint: points[0],
      lastPoint: points[points.length - 1],
      curveLeft: curve.left,
      curveRight: curve.right,
    };
  });
}

async function openTrend(page, { currency, region, amounts }) {
  await api(page, 'PUT', '/preferences', { currency, region });
  const month = await page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  for (const [index, amount] of amounts.entries()) {
    await api(page, 'POST', '/budget', { title: `${MARK} ${index}`, amount, date: `${month}-01` });
  }
  await gotoRoute(page, '/budget?tab=reports');
  await page.waitForSelector('svg.chart.budget-stats__trend .chart__axis--y', { timeout: 15000 });
  return axisGeometry(page);
}

for (const device of ['mobile', 'desktop']) {
  test(`Budget-Verlauf in Won (${device}): jeder Achsenwert steht ganz im Bild`, async () => {
    const page = await openPage(harness, { device, locale: 'ko' });
    const geo = await openTrend(page, { currency: 'KRW', region: 'ko-KR', amounts: [4250000, 1250000, -1250000, -385000] });
    const widest = Math.max(...geo.labels.map((label) => label.width));
    assert.ok(geo.labels.some((label) => /^₩\d{1,3}(,\d{3}){2}$/.test(label.text)),
      `die Achse traegt keine Millionen in koreanischer Schreibweise: ${geo.labels.map((l) => l.text).join(' | ')}`);
    assert.ok(widest > 60, `der breiteste Wert misst nur ${widest.toFixed(1)}px - das ist nicht der Fall, um den es geht`);
    for (const label of geo.labels) {
      assert.ok(label.left >= geo.clipLeft - 0.5,
        `"${label.text}" beginnt ${(geo.clipLeft - label.left).toFixed(1)}px links von der Kante, die ihn abschneidet`);
    }
    // Was ueber der Flaeche liegt, rechnet gegen dieselbe Zeichenbreite.
    assert.ok(Math.abs(geo.firstPoint - geo.curveLeft) <= 1, `der erste Ablesepunkt steht ${(geo.firstPoint - geo.curveLeft).toFixed(1)}px neben dem Anfang der Kurve`);
    assert.ok(Math.abs(geo.lastPoint - geo.curveRight) <= 1, `der letzte Ablesepunkt steht ${(geo.lastPoint - geo.curveRight).toFixed(1)}px neben dem Ende der Kurve`);
    assert.ok(geo.svgRight <= geo.hostRight + 0.5, 'das Diagramm ist rechts nicht breiter geworden als sein Traeger');
    await page.close();
  });

  test(`Budget-Verlauf in Euro (${device}): kurze Werte lassen das Diagramm, wo es stand`, async () => {
    const page = await openPage(harness, { device, locale: 'de' });
    const geo = await openTrend(page, { currency: 'EUR', region: 'de-DE', amounts: [120, -80] });
    const widest = Math.max(...geo.labels.map((label) => label.width));
    assert.ok(widest > 0 && widest < 54, `der breiteste Wert misst ${widest.toFixed(1)}px - fuer diesen Fall muss er kurz sein`);
    for (const label of geo.labels) assert.ok(label.left >= geo.clipLeft - 0.5, `"${label.text}" ragt links hinaus`);
    // Die Mindestbreite aus :root (panel.css): (64 * 600 - P * 56) / 544, nie unter 0.
    const before = Math.max(0, (64 * 600 - geo.hostWidth * 56) / 544);
    assert.ok(Math.abs(geo.paddingLeft - before) <= 0.5,
      `das Polster ist ${geo.paddingLeft.toFixed(2)}px statt ${before.toFixed(2)}px - ein kurzer Wert darf das Diagramm nicht verschieben`);
    await page.close();
  });
}
