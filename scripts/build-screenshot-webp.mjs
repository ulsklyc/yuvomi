/**
 * WebP-Derivate der Screenshots - Yuvomi
 *
 * Die GitHub-Pages-Seite lädt jeden Screenshot als WebP in zwei Breiten
 * (`<name>@1x.webp` 1x, `<name>.webp` 2x) und fällt per onerror auf das PNG
 * zurück (docs/index.html, shotSrc). Desktopaufnahmen im großen Slot bekommen
 * eine dritte Breite (`<name>@2400.webp`, Profil `web-lead`, s. WIDTHS). Die PNGs sind 5-10x größer als der Slot,
 * in dem sie landen - ohne die Derivate zieht die Startseite mehrere Megabyte.
 *
 * Bis hierher entstanden sie von Hand, was nach jedem Screenshot-Lauf einen
 * stillen Rückfall auf die PNGs bedeutete (die WebP zeigten dann noch den alten
 * Stand, denn onerror greift nur bei FEHLENDEN Dateien, nicht bei veralteten).
 *
 * Usage: node scripts/build-screenshot-webp.mjs [muster ...]
 *
 * Ohne Argument wird alles gebaut. Ein Argument beschränkt den Lauf auf
 * Dateinamen, die es enthalten (`… dashboard-light-mobile`) - gedacht für den
 * Fall, dass sich eine einzelne Aufnahme oder ihr Profil geändert hat und ein
 * Vollauf sonst hundertfünfzig unveränderte Dateien anfasst.
 *
 * Welche Bilder Derivate bekommen, steht nicht hier, sondern in den HTML-Dateien
 * unter docs/: gebaut wird, was `data-light`/`data-dark` referenziert, plus alles,
 * was schon ein WebP hat. Eine zweite Liste hier würde von der ersten abdriften.
 *
 * Konvertiert wird über den WebP-Encoder von Chromium (Playwright ist für die
 * Screenshots ohnehin da) - cwebp/ImageMagick sind auf dem Zielrechner nicht
 * installiert und ffmpeg ist ohne libwebp gebaut.
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DOCS = resolve(ROOT, 'docs');
const SHOTS = resolve(DOCS, 'screenshots');

// Anzeigebreiten der Geräteprofile auf der Seite. 2x ist die Retina-Variante,
// 1x exakt die Hälfte.
//
// `mobile-lead` kam mit der Critique vom 2026-08-20 dazu, und der Grund ist ein
// Konstruktionsfehler: EINE Telefonaufnahme bediente zwei völlig verschiedene
// Slots. In den Modulkarten landet sie bei 176px, im Hero und in der Galerie
// bei 340px. Auf 480px ausgelegt deckte sie damit den kleinen Slot dreifach und
// den großen gar nicht - gemessen lieferte der mobile Hero bei DPR3 nur 0,47
// der nötigen Pixel und war schon bei DPR1 auf das 1,42-fache hochskaliert.
// Das Ausgangs-PNG hat 1320px, die Schärfe war also die ganze Zeit da; es fehlte
// die Stufe, die sie abholt.
//
// Welche Aufnahme im großen Slot steht, entscheidet nicht dieses Skript, sondern
// das Markup: `data-shot-profile="lead"` am <img>. Eine Liste hier wäre die
// zweite Quelle, vor der schon der Kopf dieser Datei warnt.
//
// `web-lead` kam mit S10 (Website-Critique 24.10.) dazu, aus demselben Grund
// eine Ebene höher: Hero und Galerie zeigen die Desktopaufnahme am breiten
// Schirm bis 1150/1152px breit. Mit 1400px als größter Stufe bekam ein
// Retina-Schirm (DPR 2) 0,61 der nötigen Pixel. Die dritte Stufe (`xl`, Datei
// `<name>@2400.webp`) deckt 1152px x DPR 2 aus den 2752px-PNGs. Sie ist NUR
// über einen Breiten-Deskriptor erreichbar (docs/index.html, SHOT_W und das
// Hero-Kopfskript): ein DPR-1-Schirm nimmt weiter die 1400px-Datei. Welche
// Aufnahme im großen Slot steht, sagt wieder das Markup
// (`data-shot-profile="lead"` an einer Desktopaufnahme).
const WIDTHS = {
  'web-lead':    { xl: 2400, '2x': 1400, '1x': 700 },  // 1152px Slot x DPR2
  web:           { '2x': 1400, '1x': 700 },
  'mobile-lead': { '2x': 1020, '1x': 510 },  // 340px Slot x DPR3
  mobile:        { '2x': 480,  '1x': 240 },  // 176px Slot, mit Reserve
};
/** Dateiname je Stufe; `2x` ist der Name ohne Zusatz (Altbestand). */
const SUFFIX = { xl: '@2400.webp', '2x': '.webp', '1x': '@1x.webp' };
/** Größte Stufe eines Profils - für "der größere Slot gewinnt". */
const maxWidth = (profile) => Math.max(...Object.values(WIDTHS[profile]));
const QUALITY = 0.82;

/**
 * Alle von den Doc-Seiten referenzierten Screenshot-Dateinamen, je mit dem
 * Profil, in dem sie angezeigt werden.
 *
 * Gelesen wird je `<img>`-Tag statt über die ganze Datei, weil
 * `data-shot-profile` dem Bild gehört, an dem es steht - ein Treffer quer über
 * zwei Tags hinweg ordnete das Profil dem falschen Bild zu.
 *
 * `data-light-m`/`data-dark-m` standen bis zum 2026-08-20 NICHT in diesem
 * Ausdruck: die Telefonvarianten des Heroes fielen durch und überlebten nur,
 * weil `shotsWithExistingWebp()` sie am alten Bestand wieder einsammelte. Eine
 * NEU hinzugefügte Telefonvariante hätte nie Ableitungen bekommen - während
 * `test-docs-landing.js` sie längst einfordert, denn dessen Guard (4) las die
 * beiden Attribute von Anfang an. Zwei Ausdrücke für dieselbe Frage, einer
 * davon lückenhaft.
 */
const SHOT_ATTR = /(?:src|data-light|data-dark|data-light-m|data-dark-m)="screenshots\/([^"]+\.png)"/g;
const IS_MOBILE = /-mobile(?=[.@]|$)/;

function referencedShots() {
  const shots = new Map();
  for (const file of readdirSync(DOCS).filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(resolve(DOCS, file), 'utf8');
    for (const tag of html.matchAll(/<img\b[^>]*>/g)) {
      const lead = /data-shot-profile="lead"/.test(tag[0]);
      for (const m of tag[0].matchAll(SHOT_ATTR)) {
        const name = m[1];
        const mobile = IS_MOBILE.test(name.replace(/\.png$/, ''));
        const profile = mobile ? (lead ? 'mobile-lead' : 'mobile') : (lead ? 'web-lead' : 'web');
        // Steht dieselbe Datei in zwei Slots, gewinnt der GRÖSSERE: zu scharf
        // kostet Bytes, zu unscharf ist nicht reparierbar.
        const seen = shots.get(name);
        if (!seen || maxWidth(profile) > maxWidth(seen)) shots.set(name, profile);
      }
    }
  }
  return shots;
}

/** Dateien, die bereits ein WebP haben - sie bleiben aktuell, auch wenn die
 *  Seite sie gerade nicht mehr referenziert. */
function shotsWithExistingWebp(dir) {
  const names = new Set();
  if (!existsSync(dir)) return names;
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(.+?)(?:@1x|@2400)?\.webp$/);
    if (m) names.add(`${m[1]}.png`);
  }
  return names;
}

/** Locale-Ordner: die Wurzel (englisch) plus jeder Unterordner, dessen Name ein
 *  Sprach-Tag ist. Bewusst am Namen und nicht daran, ob PNGs drinliegen -
 *  `screenshots/unraid/` enthält ebenfalls PNGs, aber keine Übersetzung des
 *  Screenshot-Satzes. */
const LOCALE_DIR = /^[a-z]{2}(-[a-z]{2})?$/;
function localeDirs() {
  const dirs = [SHOTS];
  for (const entry of readdirSync(SHOTS, { withFileTypes: true })) {
    if (!entry.isDirectory() || !LOCALE_DIR.test(entry.name)) continue;
    dirs.push(resolve(SHOTS, entry.name));
  }
  return dirs;
}

async function convert(page, pngPath, outPath, width) {
  const base64 = readFileSync(pngPath).toString('base64');
  const dataUrl = await page.evaluate(async ({ b64, w, q }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = Math.round((img.naturalHeight / img.naturalWidth) * w);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', q);
  }, { b64: base64, w: width, q: QUALITY });

  if (!dataUrl.startsWith('data:image/webp')) {
    throw new Error(`Chromium returned no WebP for ${pngPath}`);
  }
  writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><title>webp</title>');

  const filters = process.argv.slice(2);
  const wantedByFilter = (name) => !filters.length || filters.some((f) => name.includes(f));
  if (filters.length) console.log(`Filter: ${filters.join(', ')}`);

  let written = 0;
  let skipped = 0;
  let filtered = 0;

  try {
    for (const dir of localeDirs()) {
      const label = dir === SHOTS ? 'en' : dir.slice(SHOTS.length + 1);
      // Referenzierte Aufnahmen bringen ihr Profil aus dem Markup mit;
      // Altbestand ohne Referenz bekommt es aus dem Namen - er stand vor dieser
      // Aenderung ohnehin im kleinen Profil.
      const wanted = new Map(referencedShots());
      for (const name of shotsWithExistingWebp(dir)) {
        if (!wanted.has(name)) {
          wanted.set(name, IS_MOBILE.test(name.replace(/\.png$/, '')) ? 'mobile' : 'web');
        }
      }
      console.log(`\n── ${label} (${wanted.size} shots) ──`);

      for (const [name, profile] of [...wanted].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (!wantedByFilter(name)) { filtered++; continue; }
        const png = resolve(dir, name);
        if (!existsSync(png)) {
          console.log(`  – ${name} (no PNG in this locale)`);
          skipped++;
          continue;
        }
        const stem = name.replace(/\.png$/, '');
        const tiers = Object.entries(WIDTHS[profile]);
        for (const [tier, width] of tiers) {
          await convert(page, png, resolve(dir, stem + SUFFIX[tier]), width);
        }
        written += tiers.length;
        console.log(`  ✓ ${stem}: ${tiers.map(([t]) => SUFFIX[t]).join(' + ')}  (${profile}: ${tiers.map(([, w]) => w).join('/')}px)`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nDone. ${written} WebP files written, ${skipped} shot(s) skipped`
    + (filtered ? `, ${filtered} filtered out.` : '.'));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
