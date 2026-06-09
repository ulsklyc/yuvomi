/**
 * Generates docs/social-preview.png (1280×640) and docs/og-image.png (1200×630).
 *
 * Design "Editorial Violet" — a modern, professional split layout:
 *   left  → brand lockup, kicker, headline, feature chips (real Lucide icons), meta
 *   right → dashboard screenshot inside a macOS-style window frame with an
 *           ambient violet glow and premium shadow, bleeding off the right edge.
 *
 * Rendered via headless Chromium for pixel-perfect text/gradients/shadows, with
 * the brand font (Plus Jakarta Sans) embedded as base64, then resized with sharp.
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
const FONT_SRC       = resolve(ROOT, 'docs/fonts/plus-jakarta-sans-variable.woff2');
const OUT_SOCIAL     = resolve(ROOT, 'docs/social-preview.png');
const OUT_OG         = resolve(ROOT, 'docs/og-image.png');

const screenshotB64 = 'data:image/png;base64,'
  + readFileSync(SCREENSHOT_SRC).toString('base64');
const fontB64 = readFileSync(FONT_SRC).toString('base64');

// ── Inline Lucide stroke icons (24×24, currentColor) ───────────────────────
const ICON = {
  tasks:    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  meals:    '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  budget:   '<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>',
};

const chip = (icon, label) => `
  <div class="chip">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round">${ICON[icon]}</svg>
    <span>${label}</span>
  </div>`;

// ── HTML template (rendered at 2× for crisp output) ────────────────────────
const html = (imgSrc) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
@font-face {
  font-family: 'Jakarta';
  src: url(data:font/woff2;base64,${fontB64}) format('woff2');
  font-weight: 200 800;
  font-display: block;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  width: 1280px; height: 640px; overflow: hidden;
  -webkit-font-smoothing: antialiased;
  font-family: 'Jakarta', -apple-system, 'Segoe UI', sans-serif;
}
body {
  position: relative;
  background-color: #0B0711;
  background-image:
    radial-gradient(ellipse 78% 95% at 74% 52%, rgba(108,58,237,.42) 0%, transparent 58%),
    radial-gradient(ellipse 50% 50% at 6% 8%,   rgba(139,92,246,.14) 0%, transparent 55%),
    radial-gradient(ellipse 40% 40% at 96% 96%, rgba(45,212,191,.06) 0%, transparent 50%);
}
/* fine tech grid overlay, faded toward edges */
body::before {
  content: '';
  position: absolute; inset: 0;
  background-image:
    linear-gradient(rgba(255,255,255,.030) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.030) 1px, transparent 1px);
  background-size: 46px 46px;
  -webkit-mask-image: radial-gradient(ellipse 75% 75% at 40% 50%, #000 30%, transparent 80%);
          mask-image: radial-gradient(ellipse 75% 75% at 40% 50%, #000 30%, transparent 80%);
  pointer-events: none;
}
/* thin top accent line */
body::after {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, transparent 0%, #8b5cf6 30%, #6c3aed 55%, transparent 100%);
  opacity: .85;
}

/* ── Left content column ── */
.left {
  position: absolute;
  top: 0; left: 0; bottom: 0;
  width: 600px;
  padding: 0 0 0 72px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  z-index: 2;
}

.brand {
  display: flex; align-items: center; gap: 13px;
  margin-bottom: 30px;
}
.brand .mark {
  width: 46px; height: 46px; border-radius: 13px;
  background: linear-gradient(135deg, #8b5cf6 0%, #6c3aed 100%);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 8px 24px rgba(108,58,237,.45), inset 0 1px 0 rgba(255,255,255,.25);
  flex-shrink: 0;
}
.brand .mark svg { width: 28px; height: 28px; display: block; }
.brand .name {
  font-size: 30px; font-weight: 800; color: #fff; letter-spacing: -.035em; line-height: 1;
}

.kicker {
  display: inline-flex; align-items: center; align-self: flex-start; gap: 8px;
  padding: 7px 14px; margin-bottom: 22px;
  border: 1px solid rgba(167,139,250,.35);
  border-radius: 999px;
  background: rgba(139,92,246,.10);
  font-size: 11.5px; font-weight: 700; letter-spacing: .14em;
  text-transform: uppercase; color: #c4b5fd; line-height: 1;
}
.kicker .dot {
  width: 6px; height: 6px; border-radius: 50%; background: #34d399;
  box-shadow: 0 0 8px rgba(52,211,153,.9);
}

.headline {
  font-size: 50px; font-weight: 800; line-height: 1.04; letter-spacing: -.032em;
  color: #fff; margin-bottom: 20px;
}
.headline .grad {
  background: linear-gradient(100deg, #c4b5fd 0%, #8b5cf6 55%, #a78bfa 100%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}

.sub {
  font-size: 16.5px; font-weight: 400; line-height: 1.55; letter-spacing: -.005em;
  color: #9b93ad; max-width: 430px; margin-bottom: 30px;
}

.chips { display: flex; flex-wrap: wrap; gap: 9px; margin-bottom: 30px; }
.chip {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 15px 9px 13px;
  border: 1px solid rgba(255,255,255,.09);
  border-radius: 11px;
  background: rgba(255,255,255,.035);
  color: #d6d2e0; font-size: 13.5px; font-weight: 600; letter-spacing: -.01em;
}
.chip svg { width: 16px; height: 16px; color: #a78bfa; flex-shrink: 0; }

.meta {
  display: flex; align-items: center; gap: 11px;
  font-size: 12.5px; font-weight: 500; color: #6c6580; letter-spacing: .01em;
}
.meta .sep { width: 3px; height: 3px; border-radius: 50%; background: #4a4460; }

/* ── Right product window ── */
.stage {
  position: absolute;
  top: 50%; left: 624px;
  transform: translateY(-50%);
  width: 770px;
  z-index: 1;
}
.glow {
  position: absolute; inset: -60px -40px -60px -40px;
  background: radial-gradient(ellipse at center, rgba(108,58,237,.55) 0%, transparent 65%);
  filter: blur(20px);
  z-index: 0;
}
.window {
  position: relative; z-index: 1;
  border-radius: 14px;
  overflow: hidden;
  background: #15101f;
  border: 1px solid rgba(167,139,250,.20);
  box-shadow:
    0 40px 90px rgba(0,0,0,.65),
    0 8px 30px rgba(91,33,182,.30),
    inset 0 1px 0 rgba(255,255,255,.06);
}
.titlebar {
  height: 40px;
  display: flex; align-items: center; gap: 9px;
  padding: 0 16px;
  background: linear-gradient(180deg, #211a33 0%, #1a1428 100%);
  border-bottom: 1px solid rgba(255,255,255,.05);
}
.tl { width: 12px; height: 12px; border-radius: 50%; }
.tl.r { background: #ff5f57; } .tl.y { background: #febc2e; } .tl.g { background: #28c840; }
.titlebar .addr {
  margin-left: 14px;
  height: 22px; flex: 1; max-width: 330px;
  display: flex; align-items: center;
  padding: 0 12px;
  border-radius: 7px;
  background: rgba(0,0,0,.28);
  color: #7e7691; font-size: 11.5px; font-weight: 500; letter-spacing: .01em;
}
.titlebar .addr svg { width: 11px; height: 11px; margin-right: 7px; color: #34d399; }
.window img { width: 100%; display: block; vertical-align: top; }
/* top shimmer edge */
.window::after {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(196,181,253,.6) 40%, rgba(196,181,253,.6) 60%, transparent);
}
</style>
</head>
<body>

<div class="left">
  <div class="brand">
    <div class="mark">
      <svg viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M80 36L36 72V120C36 122.2 37.8 124 40 124H68V96H92V124H120C122.2 124 124 122.2 124 120V72L80 36Z" fill="white"/>
        <rect x="100" y="46" width="12" height="22" rx="2" fill="white"/>
      </svg>
    </div>
    <div class="name">Yuvomi</div>
  </div>

  <div class="kicker"><span class="dot"></span>Self-hosted · Open Source</div>

  <h1 class="headline">The family planner<br>that's <span class="grad">truly yours.</span></h1>

  <p class="sub">Tasks, calendar, meals, shopping and budget — private by design, beautifully organized on your own server.</p>

  <div class="chips">
    ${chip('tasks', 'Tasks')}
    ${chip('calendar', 'Calendar')}
    ${chip('meals', 'Meals')}
    ${chip('budget', 'Budget')}
  </div>

  <div class="meta">
    <span>Docker</span><span class="sep"></span>
    <span>PWA</span><span class="sep"></span>
    <span>No tracking</span><span class="sep"></span>
    <span>MIT License</span>
  </div>
</div>

<div class="stage">
  <div class="glow"></div>
  <div class="window">
    <div class="titlebar">
      <span class="tl r"></span><span class="tl y"></span><span class="tl g"></span>
      <span class="addr">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
             stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        yuvomi.local
      </span>
    </div>
    <img src="${imgSrc}" alt="Yuvomi Dashboard">
  </div>
</div>

</body>
</html>`;

// ── Render & export ─────────────────────────────────────────────────────────

async function render(outPath, finalW, finalH) {
  const browser = await chromium.launch({ headless: true });
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
