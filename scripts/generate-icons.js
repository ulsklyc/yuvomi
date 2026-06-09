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

/** Logo SVG (any): rounded corners, gradient background */
function createLogoSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 160 160" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="160" y2="160" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#8b5cf6"/>
      <stop offset="100%" stop-color="#6c3aed"/>
    </linearGradient>
  </defs>
  <rect width="160" height="160" rx="36" fill="url(#bg)"/>
  <path d="M80 36L36 72V120C36 122.2 37.8 124 40 124H68V96H92V124H120C122.2 124 124 122.2 124 120V72L80 36Z" fill="white"/>
  <rect x="100" y="46" width="12" height="22" rx="2" fill="white"/>
</svg>`;
}

/** Maskable logo SVG: full-bleed background (no rx), logo within safe zone */
function createMaskableLogoSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 160 160" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="160" y2="160" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#8b5cf6"/>
      <stop offset="100%" stop-color="#6c3aed"/>
    </linearGradient>
  </defs>
  <rect width="160" height="160" fill="url(#bg)"/>
  <path d="M80 36L36 72V120C36 122.2 37.8 124 40 124H68V96H92V124H120C122.2 124 124 122.2 124 120V72L80 36Z" fill="white"/>
  <rect x="100" y="46" width="12" height="22" rx="2" fill="white"/>
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
