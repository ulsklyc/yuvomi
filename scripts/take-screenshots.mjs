/**
 * Screenshot Script - Oikos Mobile Views
 * Captures all modules in light + dark mode at 85% zoom, mobile viewport.
 * Usage: node scripts/take-screenshots.mjs
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = resolve(__dirname, '..', 'docs', 'screenshots');
const BASE_URL = 'http://localhost:3001';

// iPhone 12 at 85% zoom: viewport = 390/0.85 × 844/0.85 so content fills
// the full viewport without CSS zoom → no gray bar at the bottom.
const VIEWPORT = { width: Math.round(390 / 0.85), height: Math.round(844 / 0.85) }; // 459 × 993
const DEVICE_SCALE = 2;

const MODULES = [
  { path: '/',             name: 'dashboard'    },
  { path: '/tasks',        name: 'tasks'        },
  { path: '/calendar',     name: 'calendar'     },
  { path: '/meals',        name: 'meals'        },
  { path: '/recipes',      name: 'recipes'      },
  { path: '/shopping',     name: 'shopping'     },
  { path: '/birthdays',    name: 'birthdays'    },
  { path: '/notes',        name: 'notes'        },
  { path: '/contacts',     name: 'contacts'     },
  { path: '/budget',       name: 'budget'       },
  { path: '/documents',    name: 'documents'    },
  { path: '/housekeeping', name: 'housekeeping' },
  { path: '/settings',     name: 'settings'     },
];

mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function dismissOverlays(page) {
  // Close any open modals or overlays
  const closeBtn = page.locator('.modal-close, .onboarding-overlay .btn--ghost, .onboarding-overlay .btn--primary').first();
  if (await closeBtn.count() > 0) {
    try { await closeBtn.click({ timeout: 500 }); } catch {}
  }
}

async function applyZoomAndLocale(page) {
  await page.evaluate(() => {
    localStorage.setItem('oikos-locale', 'en');
    localStorage.setItem('oikos-onboarded', '1');
  });
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    localStorage.setItem('oikos-theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}

async function waitForPageLoad(page, path) {
  // Wait for SPA to finish loading (no skeleton visible, content present)
  try {
    await page.waitForFunction(() => {
      const loading = document.getElementById('app-loading');
      return !loading || loading.hidden || loading.style.display === 'none';
    }, { timeout: 10000 });
  } catch {
    // Continue even if timeout
  }
  // Extra wait for animations/data rendering
  await wait(1200);
}

async function screenshot(page, name, theme) {
  const filepath = `${SCREENSHOT_DIR}/${name}-${theme}-mobile.png`;
  await page.screenshot({ path: filepath, fullPage: false });
  console.log(`  ✓ ${name}-${theme}-mobile.png`);
  return filepath;
}

async function login(page, context) {
  console.log('Logging in as alex…');

  // Log in via Playwright's request API to get session cookies first
  const loginResp = await context.request.post(`${BASE_URL}/api/v1/auth/login`, {
    data: { username: 'alex', password: 'demo1234' },
    headers: { 'Content-Type': 'application/json' },
  });

  if (!loginResp.ok()) {
    throw new Error(`Login API failed: ${loginResp.status()} ${await loginResp.text()}`);
  }

  const loginBody = await loginResp.json();

  // Now navigate with session cookies already set
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });

  // Set locale flags (initScript should have set these, but be explicit)
  await page.evaluate(() => {
    localStorage.setItem('oikos-locale', 'en');
    localStorage.setItem('oikos-onboarded', '1');
  });

  await wait(2500);
  await waitForPageLoad(page, '/');

  const url = page.url();
  if (url.includes('/login')) {
    throw new Error(`Still on login page after auth: ${url}`);
  }
  console.log('  Logged in ✓ (URL:', url, ')');
}

async function captureModule(page, mod, theme) {
  // Set theme BEFORE navigation so theme-init.js picks it up
  await setTheme(page, theme);

  // Navigate via SPA navigate() to avoid full reload
  await page.evaluate((path) => {
    if (window.navigate) {
      window.navigate(path);
    } else {
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }, mod.path);

  await waitForPageLoad(page, mod.path);
  await applyZoomAndLocale(page);
  await dismissOverlays(page);

  // Extra settle time for complex pages
  await wait(400);

  await screenshot(page, mod.name, theme);
}

async function main() {
  console.log('Launching browser…');
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
    locale: 'en-US',
  });

  const page = await context.newPage();

  // Suppress PWA install prompt
  await page.addInitScript(() => {
    window.addEventListener('beforeinstallprompt', e => e.preventDefault());
    localStorage.setItem('oikos-locale', 'en');
    localStorage.setItem('oikos-onboarded', '1');
  });

  await login(page, context);

  // Set English locale and re-trigger locale load
  await page.evaluate(async () => {
    localStorage.setItem('oikos-locale', 'en');
    localStorage.setItem('oikos-onboarded', '1');
    if (window.setLocale) {
      await window.setLocale('en');
    }
  });
  await wait(500);

  for (const theme of ['light', 'dark']) {
    console.log(`\n── ${theme.toUpperCase()} MODE ─────────────────────────`);
    for (const mod of MODULES) {
      process.stdout.write(`  ${mod.name}… `);
      try {
        await captureModule(page, mod, theme);
      } catch (err) {
        console.error(`  ✗ ${mod.name}-${theme}: ${err.message}`);
      }
    }
  }

  await browser.close();
  console.log('\nDone! Screenshots saved to docs/screenshots/');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
