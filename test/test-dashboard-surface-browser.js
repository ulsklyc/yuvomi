/**
 * Modul: Flaeche und Raster der Uebersicht - Browser-Sonde
 * Zweck: misst im GERENDERTEN Dokument, was die Critique vom 23.09.2026 an der
 *        Flaeche fand: den Nachlauf am Seitenende, den mobilen Kopf, die
 *        kompakte Hoehenklasse und die Rasterloecher bei eigener Reihenfolge.
 * Ausfuehren: npm run test:dashboard-surface-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER: alle vier Befunde sind im Stylesheet unsichtbar.
 *   - Der Nachlauf STAND im Stylesheet (`padding-block-end: 96px` an
 *     `.app-content`) und griff trotzdem nicht: `.page-transition` hat eine
 *     feste Hoehe, der Inhalt laeuft darueber hinaus, und das Polster eines
 *     Scrollports haengt am Ende seines Fluss-Kindes, nicht am Ende des
 *     Ueberlaufs. Gemessen blieben 24px statt 96px, der FAB lag am Seitenende
 *     auf der rechten Spalte. Ein Guard, der den CSS-Wert liest, war gruen.
 *   - Der Kopf brach bei 390px dreizeilig um, weil ein Element mit
 *     `flex: 0 0 100%` die Werkzeugspalte auf 187px aufblaehte - eine Regel,
 *     deren Wirkung nur die Layout-Engine kennt.
 *   - Ob das Raster Loecher hat, entscheidet der Auto-Placement-Algorithmus.
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function freeze(page) {
  await page.evaluate(() => {
    document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* endlos */ } });
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Der Nachlauf reitet am Inhaltsende
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Faehrt `.app-content` ans Ende und misst den Abstand zwischen der Unterkante
 * des letzten GEMALTEN Inhalts und der Unterkante des Scrollports.
 *
 * „Gemalt" heisst: ein Blatt ohne Element-Kinder oder eine Box mit Flaeche,
 * Rahmen oder Schatten. Eine transparente Huelle zaehlt nicht - `.dashboard`
 * etwa reicht mit ihrem eigenen Polster bis an die Kante und wuerde jeden
 * Nachlauf als 0 melden.
 */
async function tailAtEnd(page) {
  await freeze(page);
  const toEnd = () => page.evaluate(() => {
    const ac = document.querySelector('.app-content');
    ac.scrollTop = ac.scrollHeight;
  });
  await toEnd();
  await wait(400);
  await toEnd();
  await wait(300);
  return page.evaluate(() => {
    const ac = document.querySelector('.app-content');
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;inline-size:0;block-size:var(--shell-tail)';
    ac.append(probe);
    const shellTail = probe.getBoundingClientRect().height;
    probe.remove();

    const bottom = ac.getBoundingClientRect().bottom;
    let last = 0;
    let who = '';
    for (const el of ac.querySelectorAll('.page-transition *')) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.visibility === 'hidden') continue;
      const painted = !el.children.length
        || cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
        || cs.boxShadow !== 'none'
        || parseFloat(cs.borderBottomWidth) > 0;
      if (!painted) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.bottom > last) { last = r.bottom; who = String(el.className || el.tagName).slice(0, 60); }
    }
    return {
      path: location.pathname,
      shellTail: Math.round(shellTail),
      tail: Math.round(bottom - last),
      scrolls: ac.scrollHeight > ac.clientHeight + 1,
      ownScrollport: !!document.querySelector('.page-scrollport'),
      who,
    };
  });
}

/* Die Routen, auf denen `.app-content` selbst scrollt. Der Nachlauf ist dort
 * nur zu sehen, wenn eine fixierte Flaeche ihn verlangt - ausser der Uebersicht
 * (FAB am Zeiger) keine davon im Seed. Das Install-Banner ist der dritte
 * Summand und gilt auf JEDER Route; die Sonde setzt seinen Summanden so, wie es
 * `:root:has(yuvomi-install-prompt[data-shown])` tut, statt das Bauteil
 * vorzutaeuschen. Die Rechnung darueber (`--shell-tail` an `.app-content`)
 * laeuft unveraendert. */
const PAGE_SCROLL_ROUTES = ['/', '/tasks', '/settings', '/documents', '/health', '/housekeeping', '/rewards', '/birthdays'];

for (const device of ['desktop', 'mobile']) {
  test(`Nachlauf: am Seitenende liegt der volle Nachlauf unter dem letzten Inhalt (${device})`, async () => {
    const page = await openPage(harness, { device });
    const findings = [];
    const seen = [];
    for (const path of PAGE_SCROLL_ROUTES) {
      await gotoRoute(page, path);
      // Die Uebersicht bringt ihren FAB am Zeiger selbst mit; dort wird der
      // echte Summand gemessen, nicht der gesetzte.
      if (path !== '/' || device === 'mobile') {
        await page.evaluate(() => document.documentElement.style.setProperty('--install-prompt-tail', '96px'));
      }
      const m = await tailAtEnd(page);
      if (m.ownScrollport) continue;
      seen.push(path);
      if (m.shellTail < 1) {
        findings.push(`${path}: Reichweite - --shell-tail ist 0, es gibt nichts zu messen`);
        continue;
      }
      if (m.tail < m.shellTail - 1) {
        findings.push(`${path}: ${m.tail}px unter dem letzten Inhalt (${m.who}), verlangt ${m.shellTail}px `
          + `(scrollt: ${m.scrolls})`);
      }
    }
    await page.close();
    assert.ok(seen.length >= 6, `Reichweite: nur ${seen.length} Routen ohne eigenen Scrollport gesehen (${seen.join(', ')})`);
    assert.deepEqual(findings, [], `Der Nachlauf greift nicht:\n${findings.join('\n')}`);
  });
}

test('Nachlauf: am Seitenende der Uebersicht liegt der FAB auf keinem Widget (desktop)', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  // Die rechte Spalte reicht bis ans Ende - der Anlassfall der Critique. Endet
  // das Raster links, liegt unter dem Knopf ohnehin nichts, und die Sonde
  // waere mit jedem Nachlauf gruen.
  await saveLayout(page, [
    { id: 'calendar', size: '2x1' },
    { id: 'tasks', size: '1x2' },
    { id: 'notes', size: '2x1' },
    { id: 'shopping', size: '2x1' },
    { id: 'birthdays', size: '1x2' },
  ]);
  await gotoRoute(page, '/');
  await tailAtEnd(page);
  const hits = await page.evaluate(() => {
    const fab = document.querySelector('.page-fab:not([hidden])');
    if (!fab) return null;
    const f = fab.getBoundingClientRect();
    const wrappers = [...document.querySelectorAll('.widget-wrapper')];
    const lowest = wrappers.reduce((a, w) => (w.getBoundingClientRect().bottom > (a?.getBoundingClientRect().bottom ?? -1) ? w : a), null);
    return {
      reach: !!lowest && lowest.getBoundingClientRect().right > f.left,
      ids: wrappers
        .filter((w) => {
          const r = w.getBoundingClientRect();
          return r.left < f.right && r.right > f.left && r.top < f.bottom && r.bottom > f.top;
        })
        .map((w) => w.dataset.widgetId),
    };
  });
  await page.close();
  assert.ok(hits, 'Reichweite: auf der Uebersicht am Zeiger schwebt kein FAB');
  assert.ok(hits.reach, 'Reichweite: das Raster endet nicht unter dem Knopf');
  assert.deepEqual(hits.ids, [], `Am Seitenende liegt der FAB auf: ${hits.ids.join(', ')}`);
});

test('Nachlauf: eine Seite mit eigenem Scrollport behaelt ihre Hoehe (desktop)', async () => {
  // Gegenrichtung: der Nachlauf der Seitenscroller darf die Seiten, deren Root
  // `height: 100%` traegt, nicht aus dem Fenster schieben - dort scrollt
  // `.app-content` gar nicht.
  const page = await openPage(harness, { device: 'desktop' });
  const findings = [];
  for (const path of ['/notes', '/budget', '/calendar', '/contacts']) {
    await gotoRoute(page, path);
    await page.evaluate(() => document.documentElement.style.setProperty('--install-prompt-tail', '96px'));
    const m = await page.evaluate(() => {
      const ac = document.querySelector('.app-content');
      return { own: !!document.querySelector('.page-scrollport'), over: ac.scrollHeight - ac.clientHeight };
    });
    if (!m.own) findings.push(`${path}: Reichweite - kein .page-scrollport`);
    else if (m.over > 1) findings.push(`${path}: .app-content scrollt ${m.over}px, obwohl die Seite ihren Scrollport mitbringt`);
  }
  await page.close();
  assert.deepEqual(findings, [], findings.join('\n'));
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Der Kopf der Uebersicht
 * ──────────────────────────────────────────────────────────────────────────── */

async function measureHead(page) {
  await freeze(page);
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const title = q('.dashboard-overview__title');
    const lines = (text) => {
      title.textContent = text;
      const cs = getComputedStyle(title);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      return Math.round(title.getBoundingClientRect().height / lh);
    };
    const original = title.textContent;
    // Alle drei Tageszeiten: die Sonde darf nicht an der Uhrzeit des Laufs haengen.
    const variants = ['Guten Morgen, Linda', 'Guten Tag, Linda', 'Guten Abend, Linda'];
    const titleLines = Object.fromEntries(variants.map((v) => [v, lines(v)]));
    title.textContent = original;
    const box = (s) => {
      const el = q(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
        shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 1 && r.height > 1,
      };
    };
    const first = q('.dashboard-masthead .today-cockpit') || q('.dashboard__grid');
    return {
      titleLines,
      titleText: title.textContent.trim(),
      date: box('.dashboard-overview__date'),
      title: box('.dashboard-overview__title'),
      tools: box('.dashboard-overview__tools'),
      overview: box('.dashboard-overview'),
      updated: box('.dashboard-overview__updated'),
      firstContent: first ? Math.round(first.getBoundingClientRect().top) : null,
    };
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 812 }]) {
  test(`Kopf mobil ${viewport.width}x${viewport.height}: Large Title einzeilig, Knoepfe in der Datumszeile`, async () => {
    const page = await openPage(harness, { device: 'mobile' });
    await page.setViewport({ ...viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await gotoRoute(page, '/');
    const m = await measureHead(page);
    await page.close();

    const umbrochen = Object.entries(m.titleLines).filter(([, n]) => n !== 1);
    assert.deepEqual(umbrochen, [], `Der Gruss bricht um: ${umbrochen.map(([t, n]) => `"${t}" ${n} Zeilen`).join(', ')}`);
    assert.ok(m.tools.bottom <= m.title.top + 1,
      `Die Werkzeuge stehen neben dem Titel statt in der Datumszeile (Werkzeuge bis ${m.tools.bottom}, Titel ab ${m.title.top})`);
    assert.ok(m.date.top < m.title.top && m.date.bottom <= m.title.top + 1, 'Das Datum steht ueber dem Titel');
    assert.ok(!m.updated?.shown, 'Der Stand-Anker gehoert der Wand, nicht dem Telefon');
    // Vorher 227px (ohne Wetterzeile) bzw. 274px (mit). Die Grenze laesst der
    // Wetterzeile Platz, die der Seed nicht immer traegt.
    assert.ok(m.firstContent !== null && m.firstContent <= 190,
      `Der erste Inhalt beginnt erst bei ${m.firstContent}px`);
  });
}

test('Kopf desktop: nicht hoeher als vorher, Werkzeuge rechts auf Hoehe des Datums', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  await gotoRoute(page, '/');
  const m = await measureHead(page);
  await page.close();
  // Vorher 67px: Datum, Titel und darunter rechts der Stand-Anker unter den
  // Knoepfen. Ohne den Anker sind es Datum plus Titel.
  assert.ok(m.overview.height <= 67, `Der Kopf ist am Desktop ${m.overview.height}px hoch`);
  assert.equal(m.titleLines['Guten Morgen, Linda'], 1);
  assert.ok(Math.abs(m.tools.top - m.date.top) <= 2, 'Die Werkzeuge haengen oben, auf der Datumszeile');
  assert.ok(!m.updated?.shown, 'Kein Stand-Anker ausserhalb des Wand-Modus');
});

test('Kopf in der kompakten Hoehenklasse (640x400): nur die Datumszeile bleibt sichtbar', async () => {
  const page = await openPage(harness, { device: 'short' });
  await gotoRoute(page, '/');
  const m = await measureHead(page);
  const a11y = await page.evaluate(() => {
    const t = document.querySelector('.dashboard-overview__title');
    return { tag: t?.tagName, text: t?.textContent.trim() };
  });
  await page.close();
  assert.ok(!m.title.shown, 'Der Large Title steht in 400px Hoehe noch sichtbar da');
  assert.equal(a11y.tag, 'H2', 'Die Ueberschrift bleibt fuer Screenreader im Dokument');
  assert.ok(a11y.text.length > 0);
  assert.ok(m.date.shown && m.tools.shown, 'Datum und Werkzeuge bleiben');
  // Datumszeile (Knopf 44px) plus Polster - vorher 150px und mehr.
  assert.ok(m.overview.height <= 72, `Der Kopf ist in 400px Hoehe ${m.overview.height}px hoch`);
});

test('Wand-Modus: der Stand-Anker steht weiter auf der Wand', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  await page.evaluate(() => localStorage.setItem('yuvomi-wall-mode', '1'));
  await gotoRoute(page, '/');
  await page.waitForFunction(() => document.querySelector('.wall__updated')?.textContent.trim(), { timeout: 10000 })
    .catch(() => {});
  const stamp = await page.evaluate(() => {
    const el = document.querySelector('.wall__updated');
    const r = el?.getBoundingClientRect();
    return { text: el?.textContent.trim() ?? '', shown: !!r && r.width > 1 && r.height > 1 };
  });
  await page.evaluate(() => localStorage.removeItem('yuvomi-wall-mode'));
  await page.close();
  assert.match(stamp.text, /\d{1,2}:\d{2}/, `Kein Stand auf der Wand: "${stamp.text}"`);
  assert.ok(stamp.shown, 'Der Stand steht nicht sichtbar auf der Wand');
});

test('Wand-Modus 1280x800: Abschnittstitel aus zwei Metern lesbar, ein ruhiger Tag spricht groesser', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  await page.evaluate(() => localStorage.setItem('yuvomi-wall-mode', '1'));
  await gotoRoute(page, '/');
  await page.waitForSelector('.wall-program__list .wall-row', { timeout: 10000 }).catch(() => {});
  await freeze(page);
  const m = await page.evaluate(() => {
    const px = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0);
    const list = document.querySelector('.wall-program__list');
    const rows = list ? list.children.length : 0;
    const foot = document.querySelector('.wall__foot')?.getBoundingClientRect();
    return {
      rows,
      section: px(document.querySelector('.wall__section-title')),
      rowTitle: px(document.querySelector('.wall-row__title')),
      fits: !!foot && foot.bottom <= innerHeight + 1,
    };
  });
  await page.evaluate(() => localStorage.removeItem('yuvomi-wall-mode'));
  await page.close();
  assert.ok(m.rows > 0, 'Reichweite: die Wand zeigt kein Programm');
  // Vorher 20px - an `vw` gebunden und bei 1280px gekappt.
  assert.ok(m.section >= 24, `Abschnittstitel ${m.section}px`);
  assert.ok(m.fits, 'Der Fuss mit Stand und Ausstieg liegt nicht mehr im Bild');
  if (m.rows <= 3) {
    // Vorher 32px, egal wie viel auf der Wand stand.
    assert.ok(m.rowTitle >= 40, `${m.rows} Zeilen, aber der Zeilentitel steht bei ${m.rowTitle}px`);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Das Raster packt dicht, auch mit eigener Reihenfolge
 * ──────────────────────────────────────────────────────────────────────────── */

async function saveLayout(page, layout) {
  await page.evaluate(async (items) => {
    const { api } = await import('/api.js');
    const { WIDGET_IDS } = await import('/utils/dashboard-widgets.js');
    // JEDE bekannte Id steht im Layout, die uebrigen ausgeblendet. Fehlt eine,
    // ergaenzt die Normalisierung sie mit ihrer Default-Sichtbarkeit - im Seed
    // war das `metrics`, und die Sonde mass ein Raster mit einer vierten Kachel.
    const visible = new Map(items.map((w) => [w.id, { ...w, visible: true }]));
    const rest = WIDGET_IDS.filter((id) => !visible.has(id)).map((id) => ({ id, size: '1x1', visible: false }));
    const cfg = [...visible.values(), ...rest].map((w, i) => ({ ...w, order: i }));
    await api.put('/preferences', { dashboard_widgets: cfg });
  }, layout);
}

/** Belegt die Zellen aus den gerenderten Rechtecken - nicht aus der eigenen Rechnung. */
async function gridCells(page) {
  return page.evaluate(() => {
    const g = document.getElementById('dashboard-widget-grid');
    const cs = getComputedStyle(g);
    const colsT = cs.gridTemplateColumns.split(' ').map(parseFloat);
    const rowsT = cs.gridTemplateRows.split(' ').map(parseFloat);
    const cg = parseFloat(cs.columnGap);
    const rg = parseFloat(cs.rowGap);
    const gr = g.getBoundingClientRect();
    const offX = parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    const offY = parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
    const trackAt = (tracks, gap, off) => {
      let p = 0;
      for (let i = 0; i < tracks.length; i += 1) {
        if (off < p + tracks[i] / 2) return i;
        p += tracks[i] + gap;
      }
      return tracks.length - 1;
    };
    const trackEnd = (tracks, gap, start, end) => {
      let p = 0;
      let last = start;
      for (let i = 0; i < tracks.length; i += 1) {
        if (i >= start && p + tracks[i] / 2 <= end) last = i;
        p += tracks[i] + gap;
      }
      return last;
    };
    const occ = rowsT.map(() => Array(colsT.length).fill(null));
    const order = [];
    for (const it of g.querySelectorAll(':scope > .widget-wrapper')) {
      const r = it.getBoundingClientRect();
      const x0 = r.left - gr.left - offX;
      const y0 = r.top - gr.top - offY;
      const c0 = trackAt(colsT, cg, x0);
      const r0 = trackAt(rowsT, rg, y0);
      const c1 = trackEnd(colsT, cg, c0, x0 + r.width);
      const r1 = trackEnd(rowsT, rg, r0, y0 + r.height);
      for (let a = r0; a <= r1; a += 1) for (let b = c0; b <= c1; b += 1) occ[a][b] = it.dataset.widgetId;
      order.push(it.dataset.widgetId);
    }
    const lastRow = occ.length - 1;
    const inner = [];
    occ.forEach((row, ri) => row.forEach((v, ci) => { if (!v && ri < lastRow) inner.push(`${ri}/${ci}`); }));
    return {
      cols: colsT.length,
      flow: cs.gridAutoFlow,
      order,
      inner,
      map: occ.map((row) => row.map((v) => (v || '.').slice(0, 8)).join(' | ')).join('\n'),
    };
  });
}

async function enterEditMode(page) {
  await page.click('#dashboard-customize-btn');
  await page.waitForSelector('#dashboard-widget-grid .widget-wrapper--editing', { timeout: 10000 });
  await wait(300);
  await freeze(page);
}

// Umsortiert (calendar vor tasks): bisher schaltete das auf preserve-order, und
// die 1x1-Kachel blieb hinter der zweiten Breitkachel stehen - ein Loch rechts
// neben der ersten.
const REORDERED = [
  { id: 'calendar', size: '2x1' },
  { id: 'tasks', size: '2x1' },
  { id: 'notes', size: '1x1' },
];

test('Raster: eine eigene Reihenfolge laesst keine Loecher, in Ansicht UND Bearbeiten', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  await saveLayout(page, REORDERED);
  await gotoRoute(page, '/');
  const view = await gridCells(page);
  await enterEditMode(page);
  const edit = await gridCells(page);
  await page.close();

  assert.equal(view.cols, 3, `Reichweite: ${view.cols} Spalten statt 3`);
  assert.deepEqual(view.order, ['calendar', 'tasks', 'notes'], 'Die gespeicherte Reihenfolge bleibt die Rangfolge im Dokument');
  assert.deepEqual(view.inner, [], `Loch in der Ansicht:\n${view.map}`);
  assert.deepEqual(edit.inner, [], `Loch im Bearbeiten-Modus:\n${edit.map}`);
  assert.equal(edit.map, view.map, 'Beim Umschalten springen Karten');
});

test('Raster: Ziehen und Ablegen ordnet im dichten Raster weiter um', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  await saveLayout(page, REORDERED);
  await gotoRoute(page, '/');
  await enterEditMode(page);
  // Natives HTML5-Drag (draggable="true" am Wrapper): dieselben Ereignisse, die
  // der Browser beim Ziehen schickt, mit einem echten DataTransfer.
  await page.evaluate(() => {
    const grid = document.getElementById('dashboard-widget-grid');
    const from = grid.querySelector('[data-widget-id="notes"]');
    const to = grid.querySelector('[data-widget-id="calendar"]').getBoundingClientRect();
    const dt = new DataTransfer();
    const at = { clientX: to.left + 10, clientY: to.top + to.height / 2 };
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    grid.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
    grid.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
  });
  await wait(300);
  const after = await gridCells(page);
  await page.close();
  assert.deepEqual(after.order, ['notes', 'calendar', 'tasks'], `Ablegen vor "calendar" ergab ${after.order.join(', ')}`);
  assert.deepEqual(after.inner, [], `Loch nach dem Ablegen:\n${after.map}`);
});

// Drei Breitkacheln in drei Spalten: auch dicht gepackt bleibt rechts je eine
// Zelle frei, weil keine spaetere Kachel hineinpasst. Das ist der Fall fuer den
// Hinweis - und eine Groesse, die ihn loest, gibt es.
const UNFILLABLE = [
  { id: 'calendar', size: '2x1' },
  { id: 'tasks', size: '2x1' },
  { id: 'notes', size: '2x1' },
];

test('Raster: bleibt im Bearbeiten-Modus ein Loch, schlaegt ein Hinweis eine Groesse vor, die es schliesst', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  await saveLayout(page, UNFILLABLE);
  await gotoRoute(page, '/');
  const view = await page.evaluate(() => !!document.querySelector('.dashboard-grid-hint'));
  await enterEditMode(page);
  const before = await gridCells(page);
  const hint = await page.evaluate(() => {
    const el = document.querySelector('.dashboard-grid-hint');
    const btn = el?.querySelector('[data-grid-hint-apply]');
    return el ? { text: el.textContent.replace(/\s+/g, ' ').trim(), apply: !!btn } : null;
  });
  assert.ok(!view, 'Der Hinweis gehoert in den Bearbeiten-Modus, nicht in die Ansicht');
  assert.ok(before.inner.length > 0, `Reichweite: kein Loch im Ausgangsraster\n${before.map}`);
  assert.ok(hint, `Kein Hinweis trotz Loch:\n${before.map}`);
  assert.ok(hint.apply, 'Der Hinweis bietet seinen Vorschlag nicht zum Uebernehmen an');

  await page.click('.dashboard-grid-hint [data-grid-hint-apply]');
  await wait(400);
  await freeze(page);
  const after = await gridCells(page);
  const still = await page.evaluate(() => !!document.querySelector('.dashboard-grid-hint'));
  await page.close();
  assert.deepEqual(after.inner, [], `Der Vorschlag schliesst das Loch nicht:\n${after.map}`);
  assert.ok(!still, 'Der Hinweis bleibt stehen, obwohl kein Loch mehr da ist');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Die hohe Budget-Kachel fuellt ihre Hoehe mit Inhalt
 * ──────────────────────────────────────────────────────────────────────────── */

test('Budget 1x2: zwischen Einnahmen/Ausgaben und Fusszeile steht kein leeres Band', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  // Drei hohe Karten nebeneinander: die Zeilenhoehe kommt von den Listen links
  // und rechts, nicht von der Budget-Karte - genau die Lage der Critique.
  await saveLayout(page, [
    { id: 'birthdays', size: '1x2' },
    { id: 'budget', size: '1x2' },
    { id: 'tasks', size: '1x2' },
  ]);
  await gotoRoute(page, '/');
  await freeze(page);
  const m = await page.evaluate(() => {
    const card = document.querySelector('[data-widget-id="budget"]');
    const flow = card?.querySelector('.budget-widget__flow');
    const foot = card?.querySelector('.budget-widget__footer');
    if (!flow || !foot) return null;
    return {
      band: Math.round(foot.getBoundingClientRect().top - flow.getBoundingClientRect().bottom),
      rows: foot.querySelectorAll('li').length,
    };
  });
  await page.close();
  assert.ok(m, 'Reichweite: die Budget-Kachel traegt keine Buchungen oder keine Fusszeile');
  // Vorher 69px bei 1280px (90px bei 1440px): Abstand der Zeile plus ein Band,
  // das die unten verankerte Fusszeile aufgerissen hat.
  assert.ok(m.band <= 40, `Zwischen Ein-/Ausgaben und Fusszeile stehen ${m.band}px leer`);
  assert.ok(m.rows >= 2, `Die hohe Kachel nennt nur ${m.rows} Ausgabenkategorie(n)`);
});

test('Raster: ohne Loch schweigt der Hinweis', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  await saveLayout(page, REORDERED);
  await gotoRoute(page, '/');
  await enterEditMode(page);
  const hint = await page.evaluate(() => !!document.querySelector('.dashboard-grid-hint'));
  await page.close();
  assert.ok(!hint, 'Ein Hinweis ohne Loch ist Laerm');
});
