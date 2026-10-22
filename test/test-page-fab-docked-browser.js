/**
 * Modul: Der angedockte Primaerknopf im Kopf ("+ Nomen") - Browser-Sonde
 * Zweck: Am Desktop dockt die Shell den FAB in `.page-toolbar__actions`
 *        (dockFabIntoToolbar in router.js) und haengt ihm `btn btn--primary
 *        page-fab--docked` an; `.page-fab` bleibt am Element. Was er dann
 *        ist, entscheidet die Kaskade, und die sieht nur ein Browser:
 *          1. Seine Hoehe ist die Zielgroesse der Geraetewelt wie bei jedem
 *             Knopf im Kopf - `--target-md` am Zeiger, `--target-lg` am
 *             Finger, auch auf einem Tablet ab 1024px (DESIGN.md: "das
 *             Kriterium ist die Zeigerfaehigkeit, nicht die Breite").
 *          2. Jede Deklaration der Docked-Regeln wirkt. Bis 2026-10-22 standen
 *             dort min-height, gap, padding-inline und box-shadow, die `.btn`
 *             bzw. `.btn--primary` (gleiche Spezifitaet, spaeter in der Datei)
 *             seit dem Andocken (dc23972f9, 2026-08-12) ueberstimmten; in
 *             glass.css wiederholte eine zweite Regel Flaeche und Hover von
 *             `.btn--primary` wortgleich.
 *          3. Angedockt faehrt er nicht ein. `fab-in` haengt an `.page-fab`,
 *             und der Kopf steht beim Seitenwechsel still (R18) - die Pille
 *             darin poppte beim Kaltstart trotzdem von halber Groesse auf.
 * Ausfuehren: npm run test:page-fab-docked-browser (haengt an test:document-guards)
 *
 * OHNE SERVER UND OHNE PORT: eine statische Seite mit den Stylesheets aus
 * index.html in derselben Reihenfolge und dem Markup, das router.js beim
 * Andocken schreibt. Jede Anfrage wird abgefangen, Dateien kommen aus
 * `public/`.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { launchBrowser } from '../scripts/lib/chrome-executable.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

const sheets = [...readFileSync(join(PUB, 'index.html'), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);

/* Der Kopf mit einem gewoehnlichen Knopf daneben und dem angedockten FAB, wie
 * dockFabIntoToolbar ihn hinterlaesst (Klassen und Label-Span aus router.js). */
const HTML = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${sheets.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n')}
</head><body><main id="main-content" class="app-content">
<div class="page-toolbar"><div class="page-toolbar__title">Rezepte</div>
<div class="page-toolbar__actions" id="slot"><button type="button" class="btn btn--secondary" id="neighbour">Importieren</button></div>
</div></main></body></html>`;

const DOCKED = `<button type="button" class="page-fab btn btn--primary page-fab--docked" id="fab" data-dock-label="Rezept">
<svg width="20" height="20" aria-hidden="true"></svg><span class="toolbar-new-btn__label">Rezept</span></button>`;

/* Die zwei Geraetewelten ab 1024px. Das Tablet meldet `hover: none` - das ist
 * das Kriterium, ueber das tokens.css `--target-base` schaltet. */
const WORLDS = {
  zeiger: { viewport: { width: 1280, height: 800 }, target: '--target-md', px: 40, hoverNone: false },
  finger: { viewport: { width: 1180, height: 820, hasTouch: true, isMobile: true }, target: '--target-lg', px: 48, hoverNone: true },
};

let browser;
const pages = {};

before(async () => {
  browser = await launchBrowser(puppeteer, { headless: true, args: ['--no-sandbox'] });
  for (const [name, world] of Object.entries(WORLDS)) {
    const page = await browser.newPage();
    await page.setViewport(world.viewport);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname === '/probe.html') return req.respond({ status: 200, contentType: 'text/html', body: HTML });
      const file = join(PUB, url.pathname);
      if (!existsSync(file) || statSync(file).isDirectory()) return req.respond({ status: 404, body: '' });
      return req.respond({ status: 200, contentType: MIME[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
    });
    await page.goto('http://probe.local/probe.html', { waitUntil: 'load' });
    pages[name] = page;
  }
});

after(async () => {
  await browser?.close();
});

/** Setzt den Knopf frisch ein - so, wie er beim Kaltstart im Kopf ankommt. */
const dock = (page) => page.evaluate((html) => {
  document.getElementById('fab')?.remove();
  document.getElementById('slot').insertAdjacentHTML('beforeend', html);
}, DOCKED);

test('die Sonde misst zwei Geraetewelten', async () => {
  for (const [name, world] of Object.entries(WORLDS)) {
    const seen = await pages[name].evaluate(() => ({
      hoverNone: matchMedia('(hover: none)').matches,
      wide: matchMedia('(min-width: 1024px)').matches,
    }));
    assert.deepEqual(seen, { hoverNone: world.hoverNone, wide: true }, `${name}: die Welt, die gemessen werden soll`);
  }
});

test('der angedockte Knopf ist so hoch wie jeder Knopf im Kopf: die Zielgroesse der Geraetewelt', async () => {
  for (const [name, world] of Object.entries(WORLDS)) {
    await dock(pages[name]);
    const m = await pages[name].evaluate((token) => {
      const px = (el) => parseFloat(getComputedStyle(el).minHeight);
      document.getElementById('fab').getAnimations().forEach((a) => a.finish());
      return {
        token: parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token)),
        fab: px(document.getElementById('fab')),
        fabHeight: document.getElementById('fab').getBoundingClientRect().height,
        neighbour: px(document.getElementById('neighbour')),
      };
    }, world.target);
    assert.equal(m.token, world.px, `${name}: ${world.target} ist ${world.px}px`);
    assert.equal(m.neighbour, world.px, `${name}: ein gewoehnlicher .btn im Kopf misst ${m.neighbour}px statt ${world.target} (${world.px}px)`);
    assert.equal(m.fab, world.px, `${name}: der angedockte Knopf misst ${m.fab}px statt ${world.px}px`);
    assert.equal(m.fabHeight, world.px, `${name}: gerendert ${m.fabHeight}px hoch`);
  }
});

/* TOT IST, WAS IN KEINER GERAETEWELT WIRKT. `height: auto` etwa aendert am
 * Finger nichts, weil `--fab-size` dort zufaellig so gross ist wie die
 * Mindesthoehe (48px) - am Zeiger macht es 40 gegen 48px. */
test('jede Deklaration der Docked-Regeln wirkt', async () => {
  const deadIn = {};
  for (const name of Object.keys(WORLDS)) {
    await dock(pages[name]);
    const dead = await pages[name].evaluate(() => {
      const fab = document.getElementById('fab');
      fab.getAnimations().forEach((a) => a.finish());
      const snap = () => {
        const cs = getComputedStyle(fab);
        return [...cs].map((p) => `${p}=${cs.getPropertyValue(p)}`).join('\n');
      };
      /* Je Deklaration, wie die Regel sie schreibt: `cssText` fasst Langformen
       * wieder zur Kurzform zusammen. Einzeln entfernt bewirkt etwa
       * `animation-delay` aus `animation: none` nichts, die ganze Kurzform schon. */
      const declared = (rule) => rule.style.cssText.split(';').map((d) => d.split(':')[0].trim()).filter(Boolean);
      const found = [];
      const visit = (rules, file) => {
        for (const rule of rules) {
          if (rule.selectorText === undefined && rule.cssRules) visit(rule.cssRules, file);
          // Nur Regeln, die gerade greifen: eine Hover-Regel misst der naechste Fall.
          if (rule.selectorText?.split(',').some((s) => s.trim() === '.page-fab--docked') && fab.matches(rule.selectorText)) {
            found.push({ rule, file });
          }
        }
      };
      for (const sheet of document.styleSheets) visit(sheet.cssRules, sheet.href.split('/').pop());
      const out = { rules: found.length, dead: [] };
      const before = snap();
      for (const { rule, file } of found) {
        for (const prop of declared(rule)) {
          const value = rule.style.getPropertyValue(prop);
          const prio = rule.style.getPropertyPriority(prop);
          rule.style.removeProperty(prop);
          if (snap() === before) out.dead.push(`${file} ${rule.selectorText} { ${prop}: ${value} }`);
          rule.style.setProperty(prop, value, prio);
        }
      }
      return out;
    });
    assert.ok(dead.rules > 0, `${name}: die Sonde findet die Docked-Regel`);
    deadIn[name] = dead.dead;
  }
  const [first, ...rest] = Object.values(deadIn);
  assert.deepEqual(first.filter((d) => rest.every((other) => other.includes(d))), [],
    'Deklarationen ohne Wirkung in jeder Geraetewelt - eine spaetere Regel gleicher Spezifitaet setzt sie schon');
});

test('jede Deklaration der Docked-Regeln wirkt auch unter dem Zeiger', async () => {
  const page = pages.zeiger;
  // Ein Tab im Hintergrund bekommt keine Zeigerereignisse - page.hover wartete ewig.
  await page.bringToFront();
  await dock(page);
  await page.hover('#fab');
  const hover = await page.evaluate(() => {
    const fab = document.getElementById('fab');
    fab.getAnimations().forEach((a) => a.finish());
    const snap = () => {
      const cs = getComputedStyle(fab);
      return [...cs].map((p) => `${p}=${cs.getPropertyValue(p)}`).join('\n');
    };
    /* Je Deklaration, wie die Regel sie schreibt: `cssText` fasst Langformen
     * wieder zur Kurzform zusammen. Einzeln entfernt bewirkt etwa
     * `animation-delay` aus `animation: none` nichts, die ganze Kurzform schon. */
    const declared = (rule) => rule.style.cssText.split(';').map((d) => d.split(':')[0].trim()).filter(Boolean);
    const found = [];
    const visit = (list, file) => {
      for (const rule of list) {
        if (rule.selectorText === undefined && rule.cssRules) visit(rule.cssRules, file);
        if (/\.page-fab--docked:hover/.test(rule.selectorText ?? '') && fab.matches(rule.selectorText)) found.push({ rule, file });
      }
    };
    for (const sheet of document.styleSheets) visit(sheet.cssRules, sheet.href.split('/').pop());
    const before = snap();
    const dead = [];
    for (const { rule, file } of found) {
      for (const prop of declared(rule)) {
        const value = rule.style.getPropertyValue(prop);
        const prio = rule.style.getPropertyPriority(prop);
        rule.style.removeProperty(prop);
        if (snap() === before) dead.push(`${file} ${rule.selectorText} { ${prop}: ${value} }`);
        rule.style.setProperty(prop, value, prio);
      }
    }
    return { hovered: fab.matches(':hover'), dead };
  });
  assert.equal(hover.hovered, true, 'die Sonde steht wirklich ueber dem Knopf');
  assert.deepEqual(hover.dead, [], 'Hover-Deklarationen ohne Wirkung - `.btn--primary:hover` setzt dasselbe');
});

test('angedockt faehrt der Knopf nicht ein - schwebend schon', async () => {
  for (const name of Object.keys(WORLDS)) {
    const seen = await pages[name].evaluate((html) => {
      // Gegenstueck: derselbe Knopf schwebend, wie er in der FAB-Ebene ankommt.
      document.body.insertAdjacentHTML('beforeend', '<button type="button" class="page-fab" id="floating"></button>');
      const floating = document.getElementById('floating').getAnimations().map((a) => a.animationName);
      document.getElementById('floating').remove();
      document.getElementById('fab')?.remove();
      document.getElementById('slot').insertAdjacentHTML('beforeend', html);
      return { floating, docked: document.getElementById('fab').getAnimations().map((a) => a.animationName) };
    }, DOCKED);
    assert.deepEqual(seen.floating, ['fab-in'], `${name}: die Sonde sieht die Einfahrt des schwebenden Knopfs`);
    assert.deepEqual(seen.docked, [], `${name}: der angedockte Knopf spielt ${seen.docked.join(', ')} im Kopf`);
  }
});
