/**
 * Icon Generator for Yuvomi PWA
 * Generates icons from docs/logo.svg
 * Sizes: 192px and 512px, both "any" and "maskable" variants
 * Plus the notification badge (96px): the three circles alone, white on transparent
 * Maskable icons: full-bleed background, logo content stays within 80% safe zone
 *
 * Usage: node scripts/generate-icons.js
 * Dependencies: sharp (devDependency)
 */

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, '..', 'public', 'icons');

mkdirSync(ICONS_DIR, { recursive: true });

/**
 * Drei transluzente, ineinander übergehende Kreise (Familie).
 * Überlappungen verdichten sich zu helleren Linsen -> weicher Blend.
 * Liegen innerhalb der maskable-Safe-Zone (Ø 80 %).
 */
const CIRCLES = `<g fill="#fff" fill-opacity="0.82">
    <circle cx="64" cy="72" r="27"/>
    <circle cx="100" cy="78" r="25"/>
    <circle cx="80" cy="106" r="24"/>
  </g>`;

/** Gemeinsame Gradient-Defs: Marken-Violett + dezenter Top-Sheen (Glas-Charakter) */
const DEFS = `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="160" y2="160" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#8b5cf6"/>
      <stop offset="100%" stop-color="#6c3aed"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="160" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.14"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>`;

/** Logo SVG (any): rounded corners, gradient background + sheen */
function createLogoSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 160 160" fill="none">
  ${DEFS}
  <rect width="160" height="160" rx="36" fill="url(#bg)"/>
  <rect width="160" height="160" rx="36" fill="url(#sheen)"/>
  ${CIRCLES}
</svg>`;
}

/** Maskable logo SVG: full-bleed background (no rx), logo within safe zone */
function createMaskableLogoSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 160 160" fill="none">
  ${DEFS}
  <rect width="160" height="160" fill="url(#bg)"/>
  <rect width="160" height="160" fill="url(#sheen)"/>
  ${CIRCLES}
</svg>`;
}

/** Apple Touch Icon (180x180): same as any-icon */
function createAppleTouchSvg() {
  return createLogoSvg(180);
}

/** Favicon (32x32): simplified - just gradient background with house */
function createFaviconSvg() {
  return createLogoSvg(32);
}

/**
 * Notification badge (Android status bar): the mark without its tile.
 * Android keeps only the alpha channel of a badge and paints it in one colour,
 * so a coloured tile with rounded corners shows up as a white square. What it
 * needs is the shape alone: the three circles, white on transparent. They are
 * fully opaque here (the mark's 0.82 would read as grey seams where they
 * overlap once the colour is gone), and the square viewBox is centred on them
 * with some margin, because the status bar draws the badge small.
 * The circles span x 37-125 and y 45-130 on the 160 grid.
 *
 * @param {number} size
 */
function createBadgeSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="28.5 35 105 105" fill="none">
  <g fill="#fff">
    <circle cx="64" cy="72" r="27"/>
    <circle cx="100" cy="78" r="25"/>
    <circle cx="80" cy="106" r="24"/>
  </g>
</svg>`;
}

const icons = [
  { name: 'icon-192.png',          size: 192, svg: createLogoSvg(192)         },
  { name: 'icon-512.png',          size: 512, svg: createLogoSvg(512)         },
  { name: 'icon-maskable-192.png', size: 192, svg: createMaskableLogoSvg(192) },
  { name: 'icon-maskable-512.png', size: 512, svg: createMaskableLogoSvg(512) },
  { name: 'apple-touch-icon.png',  size: 180, svg: createAppleTouchSvg()      },
  { name: 'favicon-32.png',        size: 32,  svg: createFaviconSvg()         },
  { name: 'badge-96.png',          size: 96,  svg: createBadgeSvg(96)         },
];

for (const icon of icons) {
  const outputPath = join(ICONS_DIR, icon.name);
  await sharp(Buffer.from(icon.svg))
    .png()
    .toFile(outputPath);
  console.log(`  ✓ ${icon.name} (${icon.size}x${icon.size})`);
}

console.log('\nIcons generated in public/icons/');
