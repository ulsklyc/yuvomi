/**
 * Baut die Umbrel-Store-Gallery (deploy/umbrel/gallery/1.webp … 5.webp) aus den
 * vorhandenen EN-Light-Screenshots, im Stil der vom Umbrel-Team gestalteten
 * Bestandsbilder: Pastellgradient, fette schwarze Headline, Safari-Fenster mit
 * `umbrel.local`, Deko-Elemente, Fenster läuft unten aus dem Bild.
 *
 * Zielformat (de-facto-Standard im umbrel-apps-gallery-Repo): 2160×1350 WebP.
 * Eingereicht wird über einen PR an getumbrel/umbrel-apps-gallery bzw. als
 * Roh-Screenshots im Body des nächsten umbrel-apps-PRs (siehe deploy/umbrel/README.md).
 *
 * Usage:  node scripts/build-umbrel-gallery.mjs
 */

import puppeteer from 'puppeteer';
import { launchBrowser } from '../test/chrome-executable.js';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'deploy/umbrel/gallery');
const FONT_SRC = resolve(ROOT, 'docs/fonts/plus-jakarta-sans-variable.woff2');
const fontB64 = readFileSync(FONT_SRC).toString('base64');

const SLIDES = [
  { n: 1, shot: 'dashboard-light-web.png', l1: 'A private planner,', l2: 'for family life.' },
  { n: 2, shot: 'calendar-light-web.png',  l1: 'Everyone’s calendar,', l2: 'in one place.' },
  { n: 3, shot: 'meals-light-web.png',     l1: 'From meal plan', l2: 'to shopping list.' },
  { n: 4, shot: 'budget-light-web.png',    l1: 'The household budget,', l2: 'at a glance.' },
  { n: 5, shot: 'tasks-light-web.png',     l1: 'Chores, points', l2: 'and rewards.' },
];

const html = ({ imgB64, l1, l2 }) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
@font-face { font-family: 'Jakarta'; src: url(data:font/woff2;base64,${fontB64}) format('woff2'); font-weight: 200 800; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 2160px; height: 1350px; overflow: hidden; -webkit-font-smoothing: antialiased;
  font-family: 'Jakarta', -apple-system, sans-serif; }
body { position: relative;
  background:
    radial-gradient(ellipse 60% 70% at 8% 20%, rgba(164,146,230,.55) 0%, transparent 60%),
    radial-gradient(ellipse 55% 65% at 96% 30%, rgba(247,220,175,.65) 0%, transparent 60%),
    linear-gradient(115deg, #cfc6ef 0%, #eae5f4 45%, #f8eedd 100%);
}
.headline { position: absolute; top: 96px; left: 0; right: 0; text-align: center;
  font-size: 104px; font-weight: 800; line-height: 1.1; letter-spacing: -.025em; color: #101014;
  text-shadow: 0 2px 24px rgba(255,255,255,.5); }
/* Safari-Fenster, läuft unten aus dem Canvas */
.window { position: absolute; top: 408px; left: 50%; transform: translateX(-50%);
  width: 1685px; height: 1100px; background: #f7f5f3; border-radius: 18px 18px 0 0;
  box-shadow: 0 40px 120px rgba(40,25,90,.28), 0 8px 30px rgba(40,25,90,.14); overflow: hidden; }
.chrome { height: 88px; display: flex; align-items: center; gap: 22px; padding: 0 30px;
  background: linear-gradient(#f2efec, #eceae7); border-bottom: 1px solid #ddd9d4; }
.lights { display: flex; gap: 13px; }
.lights i { width: 19px; height: 19px; border-radius: 50%; }
.lights i:nth-child(1) { background: #ff5f57; } .lights i:nth-child(2) { background: #febc2e; }
.lights i:nth-child(3) { background: #28c840; }
.navicons { display: flex; gap: 24px; }
.navicons svg, .rights svg { width: 30px; height: 30px; stroke: #86828c; }
.urlbar { flex: 1; max-width: 720px; margin: 0 auto; height: 52px; background: #e6e3df;
  border-radius: 12px; display: flex; align-items: center; justify-content: center; gap: 10px;
  font-size: 26px; color: #45414a; font-weight: 500; }
.rights { display: flex; gap: 26px; }
.shot { display: block; width: 100%; }
/* Deko: Apple-Emojis + Coin, gestrichelte Verbinder */
.deco { position: absolute; font-size: 170px; filter: drop-shadow(0 18px 30px rgba(60,40,120,.25)); }
.tile { position: absolute; width: 200px; height: 200px; border-radius: 46px;
  background: linear-gradient(160deg, #ffffff, #f3ede4); display: flex; align-items: center;
  justify-content: center; font-size: 110px;
  box-shadow: 0 24px 50px rgba(60,40,120,.22), inset 0 2px 0 rgba(255,255,255,.9); }
.coin { position: absolute; width: 150px; height: 150px; border-radius: 50%;
  background: linear-gradient(150deg, #a78bfa, #7c5ce0); display: flex; align-items: center;
  justify-content: center; box-shadow: 0 20px 44px rgba(90,60,180,.35), inset 0 3px 0 rgba(255,255,255,.35); }
.coin span { font-size: 86px; font-weight: 800; color: #fff; }
svg.wire { position: absolute; overflow: visible; }
svg.wire path { fill: none; stroke: #b3a4e4; stroke-width: 3.5; stroke-dasharray: 10 14; stroke-linecap: round; opacity: .8; }
</style></head><body>
  <svg class="wire" style="left:255px;top:330px;width:340px;height:260px"><path d="M20 10 C 180 40, 300 140, 320 250"/></svg>
  <svg class="wire" style="left:1790px;top:300px;width:300px;height:220px"><path d="M280 10 C 140 60, 40 130, 20 210"/></svg>
  <svg class="wire" style="left:1890px;top:850px;width:220px;height:260px"><path d="M200 10 C 120 90, 60 180, 90 250"/></svg>
  <svg class="wire" style="left:60px;top:760px;width:200px;height:320px"><path d="M60 10 C 10 120, 40 240, 120 310"/></svg>
  <div class="deco" style="left:130px;top:150px;">\u{1F6CD}\u{FE0F}</div>
  <div class="deco" style="left:55px;top:620px;font-size:150px;">\u{1F4C5}</div>
  <div class="deco" style="left:80px;top:1060px;font-size:130px;">\u{2705}</div>
  <div class="tile" style="right:120px;top:130px;">\u{1F374}</div>
  <div class="coin" style="right:105px;top:880px;"><span>$</span></div>
  <div class="headline">${l1}<br>${l2}</div>
  <div class="window">
    <div class="chrome">
      <div class="lights"><i></i><i></i><i></i></div>
      <div class="navicons">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" opacity=".45"><path d="M9 18l6-6-6-6"/></svg>
      </div>
      <div class="urlbar"><span>umbrel.local</span></div>
      <div class="rights">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></svg>
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><rect x="3" y="7" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/></svg>
      </div>
    </div>
    <img class="shot" src="${imgB64}">
  </div>
</body></html>`;

const browser = await launchBrowser(puppeteer);
const page = await browser.newPage();
await page.setViewport({ width: 2160, height: 1350, deviceScaleFactor: 1 });
for (const s of SLIDES) {
  const imgB64 = 'data:image/png;base64,'
    + readFileSync(resolve(ROOT, 'docs/screenshots', s.shot)).toString('base64');
  await page.setContent(html({ imgB64, l1: s.l1, l2: s.l2 }), { waitUntil: 'load', timeout: 120_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const img = document.querySelector('img.shot');
    if (img && !img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
    await img?.decode?.().catch(() => {});
  });
  const png = await page.screenshot({ type: 'png' });
  const out = resolve(OUT_DIR, `${s.n}.webp`);
  await sharp(png).webp({ quality: 82 }).toFile(out);
  console.log(`geschrieben: ${out}`);
}
await browser.close();
