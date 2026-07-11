/**
 * Icon Generator for Yuvomi PWA
 * Generates icons from docs/logo.svg
 * Sizes: 192px and 512px, both "any" and "maskable" variants
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

const icons = [
  { name: 'icon-192.png',          size: 192, svg: createLogoSvg(192)         },
  { name: 'icon-512.png',          size: 512, svg: createLogoSvg(512)         },
  { name: 'icon-maskable-192.png', size: 192, svg: createMaskableLogoSvg(192) },
  { name: 'icon-maskable-512.png', size: 512, svg: createMaskableLogoSvg(512) },
  { name: 'apple-touch-icon.png',  size: 180, svg: createAppleTouchSvg()      },
  { name: 'favicon-32.png',        size: 32,  svg: createFaviconSvg()         },
];

for (const icon of icons) {
  const outputPath = join(ICONS_DIR, icon.name);
  await sharp(Buffer.from(icon.svg))
    .png()
    .toFile(outputPath);
  console.log(`  ✓ ${icon.name} (${icon.size}x${icon.size})`);
}

console.log('\nIcons generated in public/icons/');
