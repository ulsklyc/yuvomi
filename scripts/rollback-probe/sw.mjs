// Browser probe: one Chrome profile across every image switch, so the service
// worker of the previous stage stays installed and has to update or step back.
// Usage: node sw.mjs <stage>   -> $PROBE_DIR/sw-<stage>.json, screenshots in $PROBE_DIR/shots/
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { launchBrowser } from '../lib/chrome-executable.js';
import { DEMO_LOGIN } from './api-probe.mjs';
import { probeBase, probeDir } from './probe-env.mjs';

const stage = process.argv[2];
if (!stage) {
  console.error('Usage: node sw.mjs <stage>');
  process.exit(2);
}
const dir = probeDir();
const BASE = probeBase();
mkdirSync(join(dir, 'shots'), { recursive: true });
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const browser = await launchBrowser(puppeteer, {
  headless: true, userDataDir: join(dir, 'chrome-profile'), defaultViewport: { width: 1280, height: 800 },
});
const page = /** @type {import('puppeteer').Page} */ (await browser.newPage());
/** @type {Record<'console' | 'pageerror' | 'failed' | 'bad' | 'nav', string[]>} */
const events = { console: [], pageerror: [], failed: [], bad: [], nav: [] };
page.on('console', (m) => { if (m.type() === 'error') events.console.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => events.pageerror.push(String(/** @type {Error} */ (e).message).slice(0, 200)));
page.on('requestfailed', (r) => events.failed.push(`${r.failure()?.errorText} ${r.url().replace(BASE, '')}`.slice(0, 160)));
page.on('response', (r) => { if (r.status() >= 400) events.bad.push(`${r.status()} ${r.url().replace(BASE, '')}`.slice(0, 160)); });
page.on('framenavigated', (f) => { if (f === page.mainFrame()) events.nav.push(f.url().replace(BASE, '')); });

/** @param {string} tag */
async function state(tag) {
  /** @type {any} */
  let s;
  for (let i = 0; i < 5; i++) {
    try {
      s = await page.evaluate(async () => {
        // Runs in the page; through globalThis so the Node type check needs no DOM library.
        const { document, navigator, location, caches, getComputedStyle } = /** @type {any} */ (globalThis);
        const reg = await navigator.serviceWorker.getRegistration();
        const swText = await fetch('/sw.js', { cache: 'no-store' }).then((r) => r.text()).catch(() => '');
        const app = document.getElementById('app');
        const loading = document.getElementById('app-loading');
        return {
          path: location.pathname,
          title: document.title,
          controller: navigator.serviceWorker.controller?.scriptURL || null,
          reg: reg ? { active: reg.active?.state || null, waiting: !!reg.waiting, installing: !!reg.installing } : null,
          caches: await caches.keys(),
          serverRelease: (swText.match(/\b\d+\.\d+\.\d+\b/) || ['?'])[0],
          builtShell: !!document.querySelector('script[src^="/assets/"], link[href^="/assets/"]'),
          modulepreload: document.querySelectorAll('link[rel="modulepreload"]').length,
          appChildren: app ? app.children.length : -1,
          loadingVisible: loading ? getComputedStyle(loading).display !== 'none' && !loading.hidden : false,
          nav: !!document.querySelector('nav, [role="navigation"]'),
          loginForm: !!document.getElementById('username'),
          h1: document.querySelector('h1')?.textContent?.trim().slice(0, 60) || null,
          text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
        };
      });
      break;
    } catch (e) {
      await sleep(1500);
      if (i === 4) s = { evalError: String(/** @type {Error} */ (e).message).slice(0, 120) };
    }
  }
  await page.screenshot({ path: /** @type {`${string}.png`} */ (join(dir, 'shots', `${stage}-${tag}.png`)) }).catch(() => {});
  return s;
}

/** @type {{ stage: string, steps: Record<string, any>, gotoError?: string, loggedIn?: boolean, events?: typeof events }} */
const out = { stage, steps: {} };
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 }).catch((/** @type {Error} */ e) => { out.gotoError = String(e.message).slice(0, 120); });
await sleep(8000);
if (await page.$('#username')) {
  await page.type('#username', DEMO_LOGIN.username);
  await page.type('#password', DEMO_LOGIN.password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    page.keyboard.press('Enter'),
  ]);
  out.loggedIn = true;
  await sleep(5000);
}
out.steps.first = await state('1-first');
await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
await sleep(6000);
out.steps.reload = await state('2-reload');
out.events = events;
writeFileSync(join(dir, `sw-${stage}.json`), JSON.stringify(out, null, 1));
for (const [k, s] of Object.entries(out.steps)) {
  console.log(`${stage}/${k}: path ${s.path}, server ${s.serverRelease}, caches [${(s.caches || []).join(', ')}], built shell ${s.builtShell}, `
    + `SW ${s.reg?.active}${s.reg?.waiting ? '+waiting' : ''}, nav ${s.nav}, login ${s.loginForm}, loading ${s.loadingVisible}, h1 "${s.h1}"`);
}
console.log(`${stage}: navigations ${events.nav.length} [${events.nav.join(' ')}], console.error ${events.console.length}, `
  + `pageerror ${events.pageerror.length}, requestfailed ${events.failed.length}, >=400 ${events.bad.length}`);
for (const k of /** @type {const} */ (['console', 'pageerror', 'failed', 'bad'])) {
  for (const e of [...new Set(events[k])].slice(0, 6)) console.log(`   ${k}: ${e}`);
}
await browser.close();
