/**
 * Ausschnitte der Screenshots - Yuvomi
 *
 * Die Startseite (docs/index.html, Sektion "Alles greift ineinander") zeigt je
 * Verbindung zwei Ausschnitte aus Telefonaufnahmen: wo etwas passiert und wo
 * es danach ankommt. Dazu kommt das Wandtablet der Hero-Buehne (S7): dort
 * steht es rund 200-370px breit, und die volle 1400px-Aufnahme lud ~50 KB,
 * die niemand sah; gross zeigt es die Familien-Sektion. Ein Ausschnitt ist eine Zeilengruppe, kein ganzer
 * Bildschirm - per CSS aus der vollen Aufnahme geschnitten, haette jede Karte
 * die ganze Hochkant-Datei geladen und sie gezoomt unscharf gezeigt. Hier
 * entstehen sie als eigene WebP-Dateien in drei Breiten:
 *
 *   docs/screenshots[/<locale>]/crops/<name>-<theme>@1x.webp  (320px)
 *   docs/screenshots[/<locale>]/crops/<name>-<theme>.webp     (640px)
 *   docs/screenshots[/<locale>]/crops/<name>-<theme>@3x.webp  (960px)
 *
 * Die dritte Stufe seit S7 (Re-Critique 2026-10-30): am Telefon steht eine
 * Karte 272px breit, bei DPR 3 also 816 Bildpunkte - die 640er war mit 0,79
 * sichtbar weich. Die Seite waehlt per Breiten-Deskriptor (320w/640w/960w).
 *
 * Quelle ist das PNG der Aufnahme: standardmaessig die Telefonaufnahme
 * (<from>-<theme>-mobile.png, 1320px breit, Layout 440 CSS-Pixel mal 3),
 * mit shot: 'web' die Desktopaufnahme (<from>-<theme>-web.png, 2752px breit,
 * Layout 1376 CSS-Pixel mal 2). Die Rechtecke unten stehen in diesen
 * CSS-Pixeln, damit man sie an der App nachmessen kann. Nach jedem
 * Screenshot-Lauf neu bauen, sonst zeigen die Ausschnitte den alten Stand:
 *
 *   node scripts/build-screenshot-crops.mjs [name ...]
 *
 * test:docs-landing prueft, dass jeder Ausschnitt, den die Seite nennt, hier
 * steht und in jedem Sprachordner in beiden Themes und Breiten existiert.
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SHOTS = resolve(ROOT, 'docs', 'screenshots');

/** Faktor zwischen PNG-Pixeln und CSS-Pixeln je Aufnahmeart. */
const SCALE = { mobile: 3, web: 2 };
/** Dateiendung je Stufe -> Breite in Bildpunkten. */
export const WIDTHS = { '@1x': 320, '': 640, '@3x': 960 };
const QUALITY = 0.82;

/**
 * name: Dateiname unter crops/. from: Motiv der Aufnahme. shot: 'mobile'
 * (Standard) oder 'web'. rect: [x, y, w, h] in CSS-Pixeln, 16:10 wie der
 * Rahmen auf der Seite.
 */
export const CROPS = [
  { name: 'handoff-meals',            from: 'meals',     rect: [8, 108, 400, 250] },
  { name: 'handoff-shopping-produce', from: 'shopping',  rect: [8, 94, 400, 250] },
  { name: 'handoff-tasks',            from: 'tasks',     rect: [8, 64, 400, 250] },
  { name: 'handoff-rewards',          from: 'rewards',   rect: [8, 645, 400, 250] },
  { name: 'handoff-documents',        from: 'documents', rect: [8, 420, 400, 250] },
  { name: 'handoff-budget',           from: 'budget',    rect: [8, 176, 400, 250] },
  { name: 'handoff-pantry',           from: 'pantry',    rect: [8, 360, 400, 250] },
  { name: 'handoff-shopping-bakery',  from: 'shopping',  rect: [8, 404, 400, 250] },
  { name: 'hero-wall',                from: 'dashboard-wall', shot: 'web', rect: [0, 0, 1376, 860] },
];

const LOCALE_DIR = /^[a-z]{2}(-[a-z]{2})?$/;
function localeDirs() {
  const dirs = [SHOTS];
  for (const e of readdirSync(SHOTS, { withFileTypes: true })) {
    if (e.isDirectory() && LOCALE_DIR.test(e.name)) dirs.push(resolve(SHOTS, e.name));
  }
  return dirs;
}

async function crop(page, pngPath, rect, scale, outPath, width) {
  const b64 = readFileSync(pngPath).toString('base64');
  const [x, y, w, h] = rect.map((n) => n * scale);
  const dataUrl = await page.evaluate(async ({ b64, x, y, w, h, width, q }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.round((h / w) * width);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', q);
  }, { b64, x, y, w, h, width, q: QUALITY });
  if (!dataUrl.startsWith('data:image/webp')) throw new Error(`Chromium returned no WebP for ${pngPath}`);
  writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

async function main() {
  const only = new Set(process.argv.slice(2));
  const unknown = [...only].filter((n) => !CROPS.some((c) => c.name === n));
  if (unknown.length) { console.error(`Unknown crop: ${unknown.join(', ')}`); process.exit(1); }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><title>crops</title>');
  let written = 0;
  for (const dir of localeDirs()) {
    const out = resolve(dir, 'crops');
    mkdirSync(out, { recursive: true });
    for (const c of CROPS) {
      if (only.size && !only.has(c.name)) continue;
      for (const theme of ['light', 'dark']) {
        const shot = c.shot || 'mobile';
        const src = resolve(dir, `${c.from}-${theme}-${shot}.png`);
        if (!existsSync(src)) { console.error(`  missing ${src}`); process.exitCode = 1; continue; }
        for (const [suffix, width] of Object.entries(WIDTHS)) {
          await crop(page, src, c.rect, SCALE[shot], resolve(out, `${c.name}-${theme}${suffix}.webp`), width);
          written += 1;
        }
      }
    }
  }
  await browser.close();
  console.log(`Done. ${written} WebP files written.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
