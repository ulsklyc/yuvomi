/**
 * Dashboard-only screenshot helper — runs the same setup as take-screenshots.mjs
 * but captures only the dashboard module in light + dark × web + mobile.
 *
 * Usage:  node scripts/take-dashboard-screenshots.mjs
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT        = resolve(__dirname, '..');
const SCREENSHOT_DIR = resolve(ROOT, 'docs', 'screenshots');
const DEMO_DB     = '/tmp/oikos-screenshot.db';
const PORT        = 3099;
const BASE_URL    = `http://localhost:${PORT}`;
const SESSION_SECRET = 'screenshots_secret_123';

mkdirSync(SCREENSHOT_DIR, { recursive: true });

const IPHONE_UA  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const DEVICES = [
  {
    name:     'web',
    target:   { w: 2752, h: 2064 },
    viewport: { w: 1376, h: 1032 },
    zoom:     1,
    isMobile: false,
    hasTouch: false,
    ua:       DESKTOP_UA,
    locale:   'en-US',
  },
  {
    name:     'mobile',
    target:   { w: 1320, h: 2868 },
    viewport: { w: 440,  h: 956  },
    zoom:     0.9,
    isMobile: true,
    hasTouch: true,
    ua:       IPHONE_UA,
    locale:   'en-US',
  },
];

const MODULES = [{ path: '/', name: 'dashboard' }];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function initFlags(theme) {
  return (_t) => {
    try {
      localStorage.setItem('oikos-locale', 'en');
      localStorage.setItem('oikos-onboarded', '1');
      localStorage.setItem('oikos-install-dismissed', String(Date.now()));
      localStorage.setItem('oikos-theme', theme);
    } catch {}
    window.addEventListener('beforeinstallprompt', (e) => e.preventDefault());
  };
}

async function dismissOverlays(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.onboarding-overlay, oikos-install-prompt').forEach((el) => el.remove());
  });
  const closeBtn = page.locator('.modal-close').first();
  if (await closeBtn.count() > 0) {
    try { await closeBtn.click({ timeout: 400 }); } catch {}
  }
}

async function applyAppState(page, theme) {
  await page.evaluate((t) => {
    localStorage.setItem('oikos-locale', 'en');
    localStorage.setItem('oikos-onboarded', '1');
    localStorage.setItem('oikos-install-dismissed', String(Date.now()));
    localStorage.setItem('oikos-theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}

async function waitForPageLoad(page) {
  try {
    await page.waitForFunction(() => {
      const loading = document.getElementById('app-loading');
      return !loading || loading.hidden || loading.style.display === 'none';
    }, { timeout: 12000 });
  } catch {}
  await wait(1200);
}

async function login(context, page) {
  const resp = await context.request.post(`${BASE_URL}/api/v1/auth/login`, {
    data: { username: 'linda', password: 'demo1234' },
    headers: { 'Content-Type': 'application/json' },
  });
  if (!resp.ok()) throw new Error(`Login failed: ${resp.status()} ${await resp.text()}`);
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  await wait(2500);
  await waitForPageLoad(page);
  if (page.url().includes('/login') || page.url().includes('/setup')) {
    throw new Error(`Not authenticated, landed on ${page.url()}`);
  }
}

async function captureModule(page, dev, theme, mod) {
  await page.evaluate((path) => {
    if (window.navigate) window.navigate(path);
    else { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }
  }, mod.path);

  await waitForPageLoad(page);
  await applyAppState(page, theme);
  await dismissOverlays(page);
  await wait(600);

  const filepath = `${SCREENSHOT_DIR}/${mod.name}-${theme}-${dev.name}.png`;
  await page.screenshot({ path: filepath });
  console.log(`  ✓ ${mod.name}-${theme}-${dev.name}.png`);
}

let serverProcess = null;

async function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DEMO_DB,
      SESSION_SECRET,
      NODE_NO_WARNINGS: '1',
    };
    serverProcess = spawn(
      'node',
      ['--import', 'dotenv/config', 'server/index.js'],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const onData = (chunk) => {
      const line = chunk.toString();
      if (line.includes(`port ${PORT}`)) {
        serverProcess.stdout.off('data', onData);
        resolve();
      }
    };
    serverProcess.stdout.on('data', onData);
    serverProcess.stderr.on('data', (d) => {
      const s = d.toString();
      if (s.includes('Error') || s.includes('fatal')) process.stderr.write(s);
    });
    serverProcess.on('exit', (code) => {
      if (code !== null && code !== 0) reject(new Error(`Server exited with code ${code}`));
    });
    setTimeout(() => reject(new Error('Server startup timed out')), 30000);
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE_URL}/api/v1/version`);
      if (r.ok) return;
    } catch {}
    await wait(500);
  }
  throw new Error('Server did not become reachable');
}

async function setupDemoDb(browser) {
  console.log('Setting up demo database…');

  for (const suffix of ['', '-shm', '-wal']) {
    if (existsSync(DEMO_DB + suffix)) unlinkSync(DEMO_DB + suffix);
  }

  console.log('  Starting server for migrations…');
  await startServer();
  await waitForServer();
  stopServer();
  await wait(500);

  console.log('  Running seed-demo.js…');
  const seed = spawnSync(
    'node',
    [resolve(ROOT, 'scripts/seed-demo.js'), '--db', DEMO_DB],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (seed.status !== 0) throw new Error('seed-demo.js failed');

  console.log('  Generating Linda avatar…');
  const tempCtx = await browser.newContext({ viewport: { width: 400, height: 400 } });
  const tmpPage = await tempCtx.newPage();
  await tmpPage.goto('about:blank');
  const lindaAvatar = await tmpPage.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#EC4899';
    ctx.beginPath();
    ctx.arc(100, 100, 100, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'white';
    ctx.font = 'bold 112px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('L', 100, 108);
    return canvas.toDataURL('image/png');
  });
  await tempCtx.close();

  console.log('  Adding Linda user and weather settings…');
  await startServer();
  await waitForServer();

  const apiCtx = await browser.newContext();

  const loginResp = await apiCtx.request.post(`${BASE_URL}/api/v1/auth/login`, {
    data: { username: 'alex', password: 'demo1234' },
    headers: { 'Content-Type': 'application/json' },
  });
  if (!loginResp.ok()) throw new Error(`Admin login failed: ${await loginResp.text()}`);

  const prefResp = await apiCtx.request.get(`${BASE_URL}/api/v1/preferences`);
  const csrfToken = prefResp.headers()['x-csrf-token'];
  if (!csrfToken) throw new Error('Could not obtain CSRF token');

  const createResp = await apiCtx.request.post(`${BASE_URL}/api/v1/auth/users`, {
    data: {
      username:     'linda',
      display_name: 'Linda',
      password:     'demo1234',
      avatar_color: '#EC4899',
      avatar_data:  lindaAvatar,
      role:         'admin',
      family_role:  'mom',
    },
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
  });
  if (!createResp.ok()) throw new Error(`Failed to create Linda: ${await createResp.text()}`);
  console.log('  Linda user created ✓');

  const weatherResp = await apiCtx.request.put(`${BASE_URL}/api/v1/preferences`, {
    data: {
      weather_provider: 'open-meteo',
      weather_lat:   52.5200,
      weather_lon:   13.4050,
      weather_city:  'Berlin',
      weather_units: 'metric',
    },
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
  });
  if (!weatherResp.ok()) throw new Error(`Failed to set weather: ${await weatherResp.text()}`);
  console.log('  Weather set to Berlin ✓');

  await apiCtx.close();
  stopServer();
  await wait(500);
  console.log('Demo database ready.\n');
}

// Fill the server-side weather cache so the dashboard widget renders instantly.
async function warmWeatherCache(browser) {
  try {
    const ctx = await browser.newContext();
    const loginResp = await ctx.request.post(`${BASE_URL}/api/v1/auth/login`, {
      data: { username: 'alex', password: 'demo1234' },
      headers: { 'Content-Type': 'application/json' },
    });
    if (loginResp.ok()) {
      const wRes = await ctx.request.get(`${BASE_URL}/api/v1/weather`);
      const body = await wRes.json().catch(() => ({}));
      console.log(body?.data ? '  Weather cache warmed (Berlin) ✓' : '  ⚠️  Weather cache empty (data: null)');
    }
    await ctx.close();
  } catch (err) {
    console.log(`  ⚠️  Weather warm-up skipped: ${err.message}`);
  }
}

async function main() {
  console.log('Launching browser…');
  const browser = await chromium.launch({ headless: true });

  try {
    await setupDemoDb(browser);

    console.log('Starting server for screenshots…');
    await startServer();
    await waitForServer();
    await warmWeatherCache(browser);
    console.log(`Server ready at ${BASE_URL}\n`);

    for (const dev of DEVICES) {
      const renderW = Math.round(dev.viewport.w / dev.zoom);
      const DSF     = dev.target.w / renderW;
      const renderH = Math.round(dev.target.h / DSF);

      for (const theme of ['light', 'dark']) {
        console.log(`\n── ${dev.name.toUpperCase()} · ${theme.toUpperCase()}  →  ${dev.target.w}×${dev.target.h} ──`);

        const context = await browser.newContext({
          viewport:          { width: renderW, height: renderH },
          deviceScaleFactor: DSF,
          userAgent:         dev.ua,
          isMobile:          dev.isMobile,
          hasTouch:          dev.hasTouch,
          locale:            dev.locale,
          colorScheme:       theme === 'dark' ? 'dark' : 'light',
        });
        await context.addInitScript(initFlags(theme), theme);

        const page = await context.newPage();
        try {
          await login(context, page);
          await applyAppState(page, theme);
          await page.evaluate(async () => { if (window.setLocale) await window.setLocale('en'); });
          await wait(400);

          for (const mod of MODULES) {
            await captureModule(page, dev, theme, mod);
          }
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    stopServer();
    await browser.close();
  }

  console.log('\nDone! Dashboard screenshots saved to docs/screenshots/');
}

main().catch((err) => {
  stopServer();
  console.error('Fatal:', err);
  process.exit(1);
});
