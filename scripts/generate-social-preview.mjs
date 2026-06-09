/**
 * Generates docs/social-preview.png (1280×640) and docs/og-image.png (1200×630).
 * Renders the C2 "Violet Atmosphere" design via headless Chromium for pixel-perfect
 * text, gradients, and box-shadows — then resizes to final dimensions with sharp.
 *
 * Usage:  node scripts/generate-social-preview.mjs
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import sharp from '../node_modules/sharp/lib/index.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const SCREENSHOT_SRC = resolve(ROOT, 'docs/screenshots/dashboard-dark-web.png');
const OUT_SOCIAL     = resolve(ROOT, 'docs/social-preview.png');
const OUT_OG         = resolve(ROOT, 'docs/og-image.png');

// Embed screenshot as base64 so Playwright doesn't need file access
const screenshotB64 = 'data:image/png;base64,'
  + readFileSync(SCREENSHOT_SRC).toString('base64');

// ── HTML template (rendered at 2× for crisp output) ────────────────────────
// Viewport: 1280×640, deviceScaleFactor: 2 → 2560×1280 raw PNG
// layout maths (all px are CSS px):
//   padding-top:       28
//   logo-row height:   38   (icon 36 + border-radius visual)
//   gap after row:     18
//   screenshot:        520  (920 wide, overflow-hidden)
//   gap before tag:    14
//   tagline:           ~16
//   remaining:         ~6   (visual breathing room at bottom)
//   total ≈            640
const html = (imgSrc) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  width: 1280px; height: 640px; overflow: hidden;
  -webkit-font-smoothing: antialiased;
  font-family: -apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif;
}
body {
  background-color: #0D0818;
  background-image:
    radial-gradient(ellipse 120% 100% at 50% 58%, rgba(91,33,182,.58) 0%, transparent 58%),
    radial-gradient(ellipse 55% 45% at 15% 18%,  rgba(139,92,246,.13) 0%, transparent 50%),
    radial-gradient(ellipse 38% 38% at 85% 88%,  rgba(45,212,191,.07) 0%, transparent 48%);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 28px;
}

/* ── Logo row ── */
.logo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
  flex-shrink: 0;
}
.logo-icon {
  width: 36px; height: 36px; border-radius: 9px;
  background: linear-gradient(135deg, #8b5cf6 0%, #6c3aed 100%);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.logo-icon svg { width: 22px; height: 22px; display: block; }
.logo-name {
  font-size: 26px; font-weight: 800; color: #ffffff; letter-spacing: -.035em;
  line-height: 1;
}
.logo-sep {
  width: 4px; height: 4px; border-radius: 50%; background: #3d3658;
  flex-shrink: 0;
}
.logo-tag {
  font-size: 11px; font-weight: 600; letter-spacing: .13em;
  text-transform: uppercase; color: #a78bfa; line-height: 1;
}

/* ── Screenshot ── */
.screen-wrap {
  flex-shrink: 0;
  width: 920px;
  max-height: 520px;
  overflow: hidden;
  border-radius: 10px;
  box-shadow:
    0 0 90px  rgba(109, 58, 237, .32),
    0 28px 90px rgba(0, 0, 0, .70),
    0 0 0 1px rgba(139, 92, 246, .28);
  /* shimmer on top edge */
  outline: none;
  position: relative;
}
.screen-wrap::after {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0; height: 1px;
  background: linear-gradient(90deg,
    transparent 0%, rgba(167,139,250,.6) 35%, rgba(167,139,250,.6) 65%, transparent 100%);
  border-radius: 10px 10px 0 0;
  pointer-events: none;
}
.screen-img { width: 100%; display: block; vertical-align: top; }

/* ── Tagline ── */
.tagline {
  margin-top: 14px;
  font-size: 13px; font-weight: 400;
  color: #6b7280; letter-spacing: .025em;
  line-height: 1;
  flex-shrink: 0;
}
</style>
</head>
<body>

<div class="logo-row">
  <div class="logo-icon">
    <svg viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M80 36L36 72V120C36 122.2 37.8 124 40 124H68V96H92V124H120C122.2 124 124 122.2 124 120V72L80 36Z" fill="white"/>
      <rect x="100" y="46" width="12" height="22" rx="2" fill="white"/>
    </svg>
  </div>
  <div class="logo-name">Yuvomi</div>
  <div class="logo-sep"></div>
  <div class="logo-tag">Self-hosted &middot; Open Source</div>
</div>

<div class="screen-wrap">
  <img class="screen-img" src="${imgSrc}" alt="Yuvomi Dashboard">
</div>

<div class="tagline">The family planner that respects your privacy</div>

</body>
</html>`;

// ── Render & export ─────────────────────────────────────────────────────────

async function render(outPath, finalW, finalH) {
  const browser = await chromium.launch({ headless: true });
  // Render at 2× for crisp output, then scale down
  const DSF = 2;
  const context = await browser.newContext({
    viewport:          { width: 1280, height: 640 },
    deviceScaleFactor: DSF,
    colorScheme:       'dark',
  });
  const page = await context.newPage();
  await page.setContent(html(screenshotB64), { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const raw = await page.screenshot({ type: 'png' });
  await browser.close();

  // raw is 2560×1280; resize to final dimensions
  await sharp(raw)
    .resize(finalW, finalH, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  console.log(`✓  ${outPath}  (${finalW}×${finalH})`);
}

console.log('Generating social previews…');
await render(OUT_SOCIAL, 1280, 640);
await render(OUT_OG,     1200, 630);
console.log('Done.');
