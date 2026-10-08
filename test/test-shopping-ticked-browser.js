/**
 * Modul: Abschnitt "Abgehakt" im Einkauf (#1816) - Browser-Sonde
 * Zweck: Eine abgehakte Zeile zieht als DOM-KNOTEN in den Abschnitt am
 *        Listenende, nicht ueber einen Neuaufbau der Liste. Was dabei zaehlt,
 *        sieht kein Loader ohne DOM: WANN sie umzieht (eine gemeinsame Pause,
 *        nichts bewegt sich unter dem Finger), wohin (nach Kategorieposition
 *        und Rang), was mit Zaehlern und leeren Gruppen passiert, und wo der
 *        Fokus danach steht.
 * Ausfuehren: npm run test:shopping-ticked-browser (haengt an test:document-guards)
 *
 * OHNE SERVER UND OHNE PORT. Die Seite laeuft als das, was sie ist: das echte
 * `public/pages/shopping.js` mit den echten Stylesheets in Chromium. Jede
 * Anfrage wird abgefangen - Dateien kommen aus `public/`, `/api/*` aus einem
 * Stub, der mitschreibt und auf Wunsch spaet ablehnt. Getrieben wird die Seite
 * ueber ihren `__test`-Export (Bestand setzen, Liste bauen, Verteiler
 * verdrahten) und danach ueber echte Zeiger- und Tastaturereignisse.
 *
 * JEDE SONDE PRUEFT ZUERST, DASS SIE ETWAS MISST: der Ausgangszustand wird
 * gelesen, bevor etwas passiert, und der Umzug muss am Ende wirklich
 * stattgefunden haben - eine Liste, in der sich nie etwas bewegt, bestuende
 * "nichts bewegt sich unter dem Finger" sonst von selbst.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.html': 'text/html', '.svg': 'image/svg+xml',
};

const sheets = [...readFileSync(join(PUB, 'index.html'), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
if (!sheets.includes('/styles/shopping.css')) sheets.push('/styles/shopping.css');

/* Das Geruest, das render() um die Liste legt - nur die Knoten, nach denen die
 * hier gerufenen Funktionen fragen. */
const HTML = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${sheets.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n')}
<script src="/lucide.min.js"></script>
</head><body><main id="c" class="app-content"><div class="shopping-page page-measure--narrow">
<div id="list-content" style="flex:1;display:flex;flex-direction:column">
<div class="list-scroller page-scrollport items-list" id="items-list"></div>
<div class="sr-only" role="status" aria-live="polite" id="items-reorder-announce"></div>
</div></div></main></body></html>`;

/** Die Pause in den meisten Faellen: kurz genug fuer die Suite, lang genug zum Messen. */
const PAUSE = 500;

let browser;
let page;
const api = { log: [], patch: 'ok' };
const pageErrors = [];

before(async () => {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    if (url.pathname === '/probe.html') return req.respond({ status: 200, contentType: 'text/html', body: HTML });
    if (url.pathname.startsWith('/api/')) {
      api.log.push({ method: req.method(), path: url.pathname, body: req.postData() ? JSON.parse(req.postData()) : null });
      if (req.method() === 'PATCH' && api.patch === 'refuse-late') {
        await new Promise((r) => setTimeout(r, PAUSE + 500));
        return req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Nein.', code: 500 }) });
      }
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: null }) });
    }
    const file = join(PUB, url.pathname);
    if (!existsSync(file) || statSync(file).isDirectory()) return req.respond({ status: 404, body: '' });
    return req.respond({ status: 200, contentType: MIME[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('http://probe.local/probe.html', { waitUntil: 'load' });
  // Die echten Texte (de): die Griffe nennen ihre Position im Klartext, und
  // nur so ist sie messbar.
  await page.evaluate(async () => { const { initI18n } = await import('/i18n.js'); await initI18n(); });
});

after(async () => {
  await browser?.close();
});

const item = (id, name, category, over = {}) => ({
  id, list_id: 5, name, quantity: null, category, is_checked: 0,
  price_cents: null, store_id: null, url: null, notes: null, tags: [], sort_order: id, ...over,
});

/** Bestand setzen, Liste bauen, Verteiler verdrahten. */
async function setup(items, { tickedOpen = false, pause = PAUSE, reducedMotion = false } = {}) {
  api.log.length = 0;
  api.patch = 'ok';
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }]);
  await page.evaluate(async (list, open, pauseMs) => {
    const { __test: s } = await import('/pages/shopping.js');
    window.s = s;
    window.yuvomi = { ...window.yuvomi, showToast: (text, kind) => { (window.toasts ??= []).push([text, kind]); } };
    window.toasts = [];
    s.intents.clear();
    s.pendingRemovals.clear();
    s.resetLoadOrderForTest();
    s.resetPillMachine();
    s.resetPlacementHold();
    s.setSettlePauseMsForTest(pauseMs);
    const LISTE = { id: 5, name: 'Woche', item_total: list.length, item_checked: list.filter((i) => i.is_checked).length };
    Object.assign(s.state, {
      lists: [LISTE], activeList: LISTE, activeListId: 5, items: list,
      categories: [{ id: 1, name: 'Obst', icon: 'apple', sort_order: 0 }, { id: 2, name: 'Milch', icon: 'milk', sort_order: 1 }],
      stores: [], currency: 'EUR', currentUserId: 7, listsError: null, itemsError: null,
      collapsedCategories: new Set(), tickedOpen: open,
    });
    s.setItemsListForTest(5);
    const c = document.getElementById('c');
    document.activeElement?.blur?.();
    s.updateItemsList(c);
    s.wireListContentEvents(c);
  }, items, tickedOpen, pause);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Die Liste, wie sie dasteht: je Gruppe Name, Sichtbarkeit, Zaehler, Zeilen - und der Fokus. */
const snap = () => page.evaluate(() => {
  const groups = [...document.querySelectorAll('#items-list .list-group')].map((g) => ({
    name: g.dataset.category ?? 'ABGEHAKT',
    shown: getComputedStyle(g).display !== 'none',
    count: g.querySelector('.list-group__count').textContent,
    rows: [...g.querySelectorAll('.row-carrier > .swipe-row')].map((r) => Number(r.dataset.swipeId)),
  }));
  const a = document.activeElement;
  const focus = !a || a === document.body ? 'BODY'
    : a.hasAttribute('data-ticked-toggle') ? 'kopf:ABGEHAKT'
      : a.hasAttribute('data-category-toggle') ? `kopf:${a.closest('.list-group').dataset.category}`
        : a.matches('.item-check') ? `haken:${a.closest('.swipe-row').dataset.swipeId}` : a.className;
  return { groups, focus };
});
const rows = (state, name) => state.groups.find((g) => g.name === name).rows;
const group = (state, name) => state.groups.find((g) => g.name === name);

const check = (id) => `.swipe-row[data-swipe-id="${id}"] .item-check`;
/** Mitte des Hakens einer Zeile, in Seitenkoordinaten. */
const centre = (id) => page.evaluate((sel) => {
  const r = document.querySelector(sel).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, check(id));
/** Welche Zeile liegt an diesem Punkt? */
const rowAt = (point) => page.evaluate((p) => Number(document.elementFromPoint(p.x, p.y)?.closest('.swipe-row')?.dataset.swipeId ?? 0), point);

// --------------------------------------------------------------------------
// Die gemeinsame Pause
// --------------------------------------------------------------------------

test('Die Pause der Seite ist 1,2 s: das Dreifache von --duration-2xl aus dem echten Stylesheet', async () => {
  await setup([item(1, 'Apfel', 'Obst')], { pause: null });
  const { pauseMs, token } = await page.evaluate(() => ({
    pauseMs: window.s.settlePauseMs(),
    token: getComputedStyle(document.documentElement).getPropertyValue('--duration-2xl').trim(),
  }));
  assert.equal(token, '400ms', 'der Schritt, auf dem die Pause steht');
  assert.equal(pauseMs, 1200);
});

test('Nichts bewegt sich unter dem Finger: jeder Haken stellt die Uhr fuer ALLE neu, dann ziehen sie zusammen um', async () => {
  await setup([item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst'), item(3, 'Kiwi', 'Obst'), item(4, 'Butter', 'Milch')]);
  const at = { r2: await centre(2), r3: await centre(3) };
  assert.equal(await rowAt(at.r3), 3, 'die Sonde trifft Zeile 3');

  // Erster Haken; kurz vor Ablauf SEINER Pause der zweite - gezielt auf den
  // Punkt, an dem Zeile 2 beim Start stand.
  const p1 = await centre(1);
  await page.mouse.click(p1.x, p1.y);
  await wait(PAUSE - 150);
  assert.equal(await rowAt(at.r2), 2, 'Zeile 2 liegt noch, wo sie lag');
  await page.mouse.click(at.r2.x, at.r2.y);
  const second = Date.now();

  // Bis kurz vor Ablauf der NEU gestellten Uhr steht alles: die Pause des
  // ersten Hakens ist laengst um, er zieht trotzdem nicht allein.
  const seen = [];
  while (Date.now() - second < PAUSE - 120) {
    seen.push(await rowAt(at.r3));
    await wait(40);
  }
  assert.ok(seen.length >= 4, 'die Sonde hat mehrfach gemessen');
  assert.deepEqual([...new Set(seen)], [3], 'an der Stelle von Zeile 3 liegt die ganze Zeit Zeile 3');
  const during = await snap();
  assert.deepEqual(rows(during, 'Obst'), [1, 2, 3], 'beide abgehakten Zeilen warten in ihrer Kategorie');
  assert.deepEqual(rows(during, 'ABGEHAKT'), []);

  await wait(PAUSE + 600);
  const end = await snap();
  assert.deepEqual(rows(end, 'Obst'), [3]);
  assert.deepEqual(rows(end, 'ABGEHAKT'), [1, 2], 'zusammen umgezogen, in ihrer Reihenfolge');
  assert.equal(group(end, 'Obst').count, '1');
  assert.equal(group(end, 'ABGEHAKT').count, '2');
  assert.equal(group(end, 'ABGEHAKT').shown, true);
  assert.deepEqual(api.log.map((c) => `${c.method} ${c.path}`), ['PATCH /api/v1/shopping/items/1', 'PATCH /api/v1/shopping/items/2']);
});

test('Haken und Gegenhaken in der Pause: die Zeile bleibt, und nichts bewegt sich', async () => {
  await setup([item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst')]);
  await page.click(check(1));
  await wait(150);
  await page.click(check(1));
  await wait(PAUSE + 500);
  const end = await snap();
  assert.deepEqual(rows(end, 'Obst'), [1, 2]);
  assert.equal(group(end, 'ABGEHAKT').shown, false);
  assert.equal(await page.$eval(check(1), (el) => el.dataset.checked), '0');
});

test('Ein Neuaufbau in der Pause laesst die wartende Zeile, wo sie wartet', async () => {
  await setup([item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst')], { reducedMotion: true });
  await page.click(check(1));
  // Jemand anderes fuegt einen Artikel hinzu: die Liste wird neu gebaut.
  await page.evaluate(() => {
    window.s.state.items.push({ ...window.s.state.items[1], id: 9, name: 'Mango', sort_order: 9 });
    window.s.updateItemsList(document.getElementById('c'));
  });
  const during = await snap();
  assert.deepEqual(rows(during, 'Obst'), [1, 2, 9], 'der Apfel steht noch in seiner Kategorie');
  assert.equal(await page.$eval(check(1), (el) => el.dataset.checked), '1', 'abgehakt ist er');
  await wait(PAUSE + 150);
  const end = await snap();
  assert.deepEqual(rows(end, 'Obst'), [2, 9]);
  assert.deepEqual(rows(end, 'ABGEHAKT'), [1], 'nach der Pause zieht er um');
});

test('Reduzierte Bewegung: die Pause bleibt, nur das Gleiten entfaellt', async () => {
  await setup([item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst')], { reducedMotion: true });
  await page.click(check(1));
  await wait(PAUSE - 150);
  assert.deepEqual(rows(await snap(), 'Obst'), [1, 2], 'auch ohne Bewegung zieht die Zeile nicht sofort um');
  await wait(250);
  const end = await snap();
  assert.deepEqual(rows(end, 'ABGEHAKT'), [1], 'nach der Pause steht sie ohne Uebergang im Abschnitt');
  assert.equal(await page.$eval('.swipe-row[data-swipe-id="1"]', (row) => row.getAnimations().length), 0);
});

test('Fremder Haken aus dem Feed: sofort, solange hier niemand tippt - sonst mit der laufenden Pause', async () => {
  await setup([item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst'), item(3, 'Kiwi', 'Obst')], { reducedMotion: true });
  // Niemand tippt: Zeile 3 wird von jemand anderem abgehakt.
  await page.evaluate(() => {
    const c = document.getElementById('c');
    const it = window.s.state.items.find((i) => i.id === 3);
    it.is_checked = 1;
    window.s.updateItemRow(c, it);
    window.s.placeOrHold(c, 3);
  });
  assert.deepEqual(rows(await snap(), 'ABGEHAKT'), [3], 'ohne eigene Aktivitaet sofort');

  // Jetzt tippt hier jemand - und waehrenddessen hakt der andere Zeile 2 ab.
  await page.click(check(1));
  await page.evaluate(() => {
    const c = document.getElementById('c');
    const it = window.s.state.items.find((i) => i.id === 2);
    it.is_checked = 1;
    window.s.updateItemRow(c, it);
    window.s.placeOrHold(c, 2);
  });
  assert.deepEqual(rows(await snap(), 'Obst'), [1, 2], 'der fremde Haken wartet mit');
  await wait(PAUSE + 150);
  const end = await snap();
  assert.deepEqual(rows(end, 'ABGEHAKT'), [1, 2, 3]);
  assert.equal(group(end, 'Obst').shown, false, 'die leer gehakte Kategorie steht nicht mehr im Bild');
  assert.equal(group(end, 'Obst').count, '0');
});

// --------------------------------------------------------------------------
// Wohin die Zeile zieht
// --------------------------------------------------------------------------

test('Im Abschnitt stehen die Zeilen nach Kategorieposition und Rang, zurueck kommt eine an ihren Rang', async () => {
  await setup([
    item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst'), item(3, 'Kiwi', 'Obst'),
    item(4, 'Butter', 'Milch'), item(5, 'Quark', 'Milch'),
  ], { tickedOpen: true, reducedMotion: true });
  // Erst Milch, dann Obst abgehakt - die Reihenfolge der Tipps entscheidet nicht.
  await page.click(check(5));
  await page.click(check(2));
  await page.click(check(4));
  await wait(PAUSE + 150);
  let state = await snap();
  assert.deepEqual(rows(state, 'ABGEHAKT'), [2, 4, 5]);
  assert.deepEqual(rows(state, 'Obst'), [1, 3]);
  assert.equal(group(state, 'Milch').shown, false);

  // Die Birne zurueck: zwischen Apfel und Kiwi, nicht ans Ende.
  await page.click(check(2));
  await wait(PAUSE + 150);
  state = await snap();
  assert.deepEqual(rows(state, 'Obst'), [1, 2, 3]);
  assert.deepEqual(rows(state, 'ABGEHAKT'), [4, 5]);
  assert.equal(group(state, 'ABGEHAKT').count, '2');
  // Der Griff der zurueckgeholten Zeile ist wieder bedienbar, der im Abschnitt gesperrt.
  assert.equal(await page.$eval('.swipe-row[data-swipe-id="2"] .list-row__drag', (el) => el.disabled), false);
  assert.equal(await page.$eval('.swipe-row[data-swipe-id="4"] .list-row__drag', (el) => el.disabled), true);
  // Und die Griffe der Kategorie nennen die NEUE Position: die Kiwi ist wieder die dritte von drei.
  const labels = await page.$$eval('.item-category[data-category="Obst"] .list-row__drag', (els) => els.map((el) => el.getAttribute('aria-label')));
  assert.deepEqual(labels.map((l) => l.match(/(\d+) von (\d+)/)?.slice(1, 3).join('/')), ['1/3', '2/3', '3/3'], labels.join(' | '));
});

test('Lehnt der Server nach dem Umzug ab, kommt die Zeile zurueck', async () => {
  await setup([item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst')], { reducedMotion: true });
  api.patch = 'refuse-late';
  await page.click(check(1));
  await wait(PAUSE + 150);
  assert.deepEqual(rows(await snap(), 'ABGEHAKT'), [1], 'umgezogen, die Antwort steht noch aus');
  await wait(600);
  const end = await snap();
  assert.deepEqual(rows(end, 'Obst'), [1, 2], 'zurueck an ihrem Rang');
  assert.equal(group(end, 'ABGEHAKT').shown, false);
  assert.deepEqual(await page.evaluate(() => window.toasts), [['Nein.', 'danger']]);
});

test('Umsortieren in der Pause nennt auch die Zeile, die noch im Abschnitt wartet', async () => {
  await setup([item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst'), item(3, 'Kiwi', 'Obst', { is_checked: 1 })],
    { tickedOpen: true, reducedMotion: true });
  await page.click(check(3)); // zurueckgeholt, wartet im Abschnitt
  await page.focus('.swipe-row[data-swipe-id="1"] .list-row__drag');
  await page.keyboard.press('ArrowDown');
  await wait(200);
  const reorder = api.log.filter((c) => c.path.endsWith('/items/reorder'));
  assert.equal(reorder.length, 1);
  assert.deepEqual(reorder[0].body, { category: 'Obst', order: [2, 1, 3] },
    'ohne die wartende Zeile lehnt die Route ab (order muss alle Artikel der Kategorie enthalten)');
});

test('Eine Zeile aus dem zugeklappten Abschnitt gleitet beim Neuaufbau nicht aus der Fensterecke herein', async () => {
  await setup([item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst'), item(3, 'Kiwi', 'Obst', { is_checked: 1 })]);
  const result = await page.evaluate(() => {
    const c = document.getElementById('c');
    // Jemand anderes holt die Kiwi zurueck UND fuegt etwas hinzu: Neuaufbau.
    window.s.state.items.find((i) => i.id === 3).is_checked = 0;
    window.s.state.items.push({ ...window.s.state.items[0], id: 9, name: 'Mango', sort_order: 0 });
    window.s.updateItemsList(c);
    const glide = (id) => document.querySelector(`.swipe-row[data-swipe-id="${id}"]`).getAnimations()
      .map((a) => a.effect.getKeyframes()[0]?.transform).filter((tr) => tr && tr !== 'none');
    return { back: glide(3), shifted: glide(1) };
  });
  assert.deepEqual(result.back, [], 'ohne Vorher-Lage erscheint sie wie eine neue Zeile');
  assert.equal(result.shifted.length, 1, 'die Sonde misst: eine verschobene Zeile gleitet');
});

// --------------------------------------------------------------------------
// Fokus
// --------------------------------------------------------------------------

test('Fokus: die naechste offene Zeile in Lesereihenfolge, ueber die Kategoriegrenze hinweg', async () => {
  await setup([item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst'), item(4, 'Butter', 'Milch')], { reducedMotion: true });
  await page.focus(check(1));
  await page.keyboard.press('Space');
  await wait(PAUSE + 150);
  assert.equal((await snap()).focus, 'haken:2', 'mittendrin: die naechste Zeile');

  // Die Birne ist jetzt die letzte offene Zeile von Obst.
  await page.keyboard.press('Space');
  await wait(PAUSE + 150);
  const end = await snap();
  assert.equal(group(end, 'Obst').shown, false);
  assert.equal(end.focus, 'haken:4', 'weiter bei Milch - nicht am Kopf von "Abgehakt" am Listenende');
});

test('Fokus: mehrere Zeilen ziehen zusammen um - er geht auf die naechste, die BLEIBT', async () => {
  await setup([item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst'), item(3, 'Kiwi', 'Obst')], { reducedMotion: true });
  // Erst die Birne, dann der Apfel: der Fokus steht am Apfel, und die naechste
  // Zeile nach ihm - die Birne - zieht im selben Zug mit um.
  await page.focus(check(2));
  await page.keyboard.press('Space');
  await page.focus(check(1));
  await page.keyboard.press('Space');
  await wait(PAUSE + 150);
  const end = await snap();
  assert.deepEqual(rows(end, 'ABGEHAKT'), [1, 2]);
  assert.equal(end.focus, 'haken:3');
});

test('Fokus: die letzte offene Zeile ueberhaupt - der Kopf des zugeklappten Abschnitts nimmt ihn', async () => {
  await setup([item(1, 'Apfel', 'Obst')], { reducedMotion: true });
  await page.focus(check(1));
  await page.keyboard.press('Space');
  await wait(PAUSE + 150);
  assert.equal((await snap()).focus, 'kopf:ABGEHAKT');
});

test('Fokus: die EINZIGE Zeile des offenen Abschnitts zurueckgeholt - er bleibt an ihrem Haken, nicht auf body', async () => {
  await setup([item(1, 'Apfel', 'Obst'), item(5, 'Quark', 'Milch', { is_checked: 1 })], { tickedOpen: true, reducedMotion: true });
  await page.focus(check(5));
  await page.keyboard.press('Space');
  await wait(PAUSE + 150);
  const end = await snap();
  assert.equal(group(end, 'ABGEHAKT').shown, false, 'der Abschnitt ist mit seiner letzten Zeile verschwunden');
  assert.deepEqual(rows(end, 'Milch'), [5]);
  assert.equal(end.focus, 'haken:5');
});

test('Fokus: eine von zwei Zeilen des Abschnitts zurueckgeholt - er geht auf die andere', async () => {
  await setup([item(5, 'Quark', 'Milch', { is_checked: 1 }), item(6, 'Kaese', 'Milch', { is_checked: 1 })], { tickedOpen: true, reducedMotion: true });
  await page.focus(check(5));
  await page.keyboard.press('Space');
  await wait(PAUSE + 150);
  assert.equal((await snap()).focus, 'haken:6');
});

// --------------------------------------------------------------------------
// Der Kopf des Abschnitts
// --------------------------------------------------------------------------

test('Der Kopf von "Abgehakt" ist ein volles Ziel, traegt Wort und Zahl im Namen und klappt per Klick', async () => {
  await setup([item(1, 'Apfel', 'Obst'), item(5, 'Quark', 'Milch', { is_checked: 1 })]);
  const head = await page.evaluate(() => {
    const el = document.querySelector('[data-ticked-toggle]');
    const r = el.getBoundingClientRect();
    const target = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--target-base'));
    const hit = (dy) => Boolean(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2 + dy)?.closest('[data-ticked-toggle]'));
    return {
      height: r.height, target,
      hitTop: hit(-(target / 2 - 2)), hitBottom: hit(target / 2 - 2),
      name: el.getAttribute('aria-labelledby').split(' ').map((id) => document.getElementById(id).textContent).join(' '),
      expanded: el.getAttribute('aria-expanded'),
      firstRowBelow: document.querySelector('.item-ticked .row-carrier').hidden,
    };
  });
  assert.ok(head.target >= 44, 'die Sonde liest --target-base');
  assert.ok(head.height >= head.target, `Kopf ${head.height}px gegen --target-base ${head.target}px`);
  assert.equal(head.hitTop && head.hitBottom, true, 'die ganze Hoehe trifft den Knopf');
  assert.equal(head.name, 'Abgehakt 1');
  assert.equal(head.expanded, 'false');

  await page.click('[data-ticked-toggle]');
  await wait(400);
  const open = await page.evaluate(() => ({
    expanded: document.querySelector('[data-ticked-toggle]').getAttribute('aria-expanded'),
    visible: getComputedStyle(document.querySelector('#shopping-ticked-rows')).display !== 'none',
    stored: localStorage.getItem(window.s.tickedOpenStorageKey(7, 5)),
  }));
  assert.deepEqual(open, { expanded: 'true', visible: true, stored: '1' });
  await page.evaluate(() => localStorage.clear());
});

test('Keine Seite hat geworfen', () => {
  assert.deepEqual(pageErrors, []);
});
