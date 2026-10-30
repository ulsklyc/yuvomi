/**
 * Ausschnitte der Screenshots - Yuvomi
 *
 * Die Startseite (docs/index.html, Sektion "Alles greift ineinander") zeigt je
 * Verbindung zwei Ausschnitte aus Telefonaufnahmen: wo etwas passiert und wo
 * es danach ankommt. Ein Ausschnitt ist eine Zeilengruppe, kein ganzer
 * Bildschirm - per CSS aus der vollen Aufnahme geschnitten, haette jede Karte
 * die ganze Hochkant-Datei geladen und sie gezoomt unscharf gezeigt. Hier
 * entstehen sie als eigene WebP-Dateien in zwei Breiten:
 *
 *   docs/screenshots[/<locale>]/crops/<name>-<theme>.webp     (640px, 2x)
 *   docs/screenshots[/<locale>]/crops/<name>-<theme>@1x.webp  (320px, 1x)
 *
 * Quelle ist das PNG der Telefonaufnahme (<from>-<theme>-mobile.png, 1320px
 * breit, Layout 440 CSS-Pixel mal 3). Die Rechtecke unten stehen in diesen
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

/** Faktor zwischen PNG-Pixeln und CSS-Pixeln der Telefonaufnahme. */
const SCALE = 3;
const WIDTHS = { '2x': 640, '1x': 320 };
const QUALITY = 0.82;

/**
 * name: Dateiname unter crops/. from: Motiv der Telefonaufnahme.
 * rect: [x, y, w, h] in CSS-Pixeln, 16:10 wie der Rahmen auf der Seite.
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
];

const LOCALE_DIR = /^[a-z]{2}(-[a-z]{2})?$/;
function localeDirs() {
  const dirs = [SHOTS];
  for (const e of readdirSync(SHOTS, { withFileTypes: true })) {
    if (e.isDirectory() && LOCALE_DIR.test(e.name)) dirs.push(resolve(SHOTS, e.name));
  }
  return dirs;
}

async function crop(page, pngPath, rect, outPath, width) {
  const b64 = readFileSync(pngPath).toString('base64');
  const [x, y, w, h] = rect.map((n) => n * SCALE);
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
        const src = resolve(dir, `${c.from}-${theme}-mobile.png`);
        if (!existsSync(src)) { console.error(`  missing ${src}`); process.exitCode = 1; continue; }
        await crop(page, src, c.rect, resolve(out, `${c.name}-${theme}.webp`), WIDTHS['2x']);
        await crop(page, src, c.rect, resolve(out, `${c.name}-${theme}@1x.webp`), WIDTHS['1x']);
        written += 2;
      }
    }
  }
  await browser.close();
  console.log(`Done. ${written} WebP files written.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
