/**
 * Cold start measurement for /calendar - Yuvomi
 *
 * Ausführen: node scripts/measure-cold-start.mjs
 *
 * Optional:  --runs <n>    runs per round (default 5)
 *            --rounds <n>  rounds in a row (default 1); with 2 or more the
 *                          script also checks that the round medians differ by
 *                          less than 10 % and exits 1 otherwise (stability probe)
 *
 * Measures how long a first visit to /calendar takes until the largest
 * contentful paint, and how many requests the page started until then. This
 * is the before/after mark for phase 1a (roadmap criterion F8): section D
 * changes how the frontend is delivered, and this number shows what that did.
 *
 * The run shape is fixed and must stay the same for "before" and "after"
 * (otherwise the two numbers are not comparable):
 *   - a demo database is seeded once (scripts/seed-demo.js, locale en) into a
 *     temp directory; every run starts on a fresh copy of it
 *   - every run starts its own server: `node server/index.js` with
 *     NODE_ENV=production, DB_PATH on the copy, bound to 127.0.0.1, plain HTTP
 *     (Node's http server speaks HTTP/1.1 only, no proxy in between)
 *   - session cookies are not `Secure` (SESSION_SECURE=false), whatever the
 *     calling shell exports: the server speaks plain HTTP
 *   - the database stays unencrypted (DB_ENCRYPTION_KEY removed from the
 *     environment, DB_ENCRYPTION_AUTO_KEY=false) and no `.env` is read: the
 *     seed runs with the temp directory as working directory, the server is
 *     started without `--import dotenv/config`
 *   - every run uses a fresh browser context (own cache, cookies, sockets);
 *     the service worker is never registered (`navigator.serviceWorker.register`
 *     is stubbed before any page script runs), so its precache cannot compete
 *     for the six HTTP/1.1 connections and nothing is served from it
 *   - network: Puppeteer PredefinedNetworkConditions['Fast 4G'];
 *     CPU: 4x throttling
 *   - login: POST /api/v1/auth/login with the demo account from the seed,
 *     done from Node; the session cookie goes into the context, so the first
 *     page load of the context is the measured navigation to /calendar
 *   - the run ends when the boot screen (#app-loading) is gone, the network
 *     was idle for 1 s and 2 s more have passed
 *   - metric: startTime of the last `largest-contentful-paint` entry, and the
 *     number of requests whose start lies at or before that time (the
 *     document plus every resource timing entry); the total number of
 *     requests until the end of the run is reported next to it
 *
 * Output: one line per run and a closing sentence on stderr, the result as
 * JSON on stdout (so `> result.json` keeps a parseable file).
 * Side effects: a temp directory under the OS temp dir (removed on exit) and
 * one server process per run on a free port.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer, { PredefinedNetworkConditions } from 'puppeteer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NETWORK_PRESET = 'Fast 4G';
const CPU_THROTTLING = 4;
const STABILITY_LIMIT = 0.10;
const DEMO_USER = 'linda';
// The seed gives every demo user the same password (scripts/seed-demo.js header).
const DEMO_PASSWORD = 'demo1234';
const PAGE_PATH = '/calendar';
const NAV_TIMEOUT_MS = 120_000;
const IDLE_MS = 1_000;
const SETTLE_MS = 2_000;

function intArg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const n = Number.parseInt(process.argv[i + 1], 10);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${name} needs a positive integer`);
    process.exit(2);
  }
  return n;
}

const RUNS = intArg('--runs', 5);
const ROUNDS = intArg('--rounds', 1);

const network = PredefinedNetworkConditions[NETWORK_PRESET];
if (!network) {
  console.error(`Puppeteer has no network preset "${NETWORK_PRESET}" `
    + `(known: ${Object.keys(PredefinedNetworkConditions).join(', ')})`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Environment for seed and server: no inherited DB settings, no key. */
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of ['DB_PATH', 'DB_ENCRYPTION_KEY', 'DB_ENCRYPTION_KEY_FILE', 'PORT', 'BIND_ADDRESS']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

function copyDb(from, to) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(from + suffix)) copyFileSync(from + suffix, to + suffix);
  }
}

function seedTemplate(workDir) {
  const dbPath = join(workDir, 'template.db');
  const seed = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'seed-demo.js'), '--db', dbPath, '--locale', 'en'],
    {
      cwd: workDir,
      env: cleanEnv({ DB_ENCRYPTION_AUTO_KEY: 'false', NODE_NO_WARNINGS: '1' }),
      encoding: 'utf8',
    },
  );
  if (seed.status !== 0) {
    throw new Error(`seed-demo.js failed (exit ${seed.status}):\n${seed.stderr || seed.stdout}`);
  }
  return dbPath;
}

async function startServer({ dbPath, port, sessionSecret }) {
  const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    cwd: dirname(dbPath),
    env: cleanEnv({
      NODE_ENV: 'production',
      DB_PATH: dbPath,
      DB_ENCRYPTION_AUTO_KEY: 'false',
      SESSION_SECRET: sessionSecret,
      // Plain HTTP: a secure cookie from an exported SESSION_SECURE=true
      // would never come back, and the run would end on the login page.
      SESSION_SECURE: 'false',
      PORT: String(port),
      BIND_ADDRESS: '127.0.0.1',
      NODE_NO_WARNINGS: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${base}/api/v1/version`);
      if (res.ok) return { child, base, exited };
    } catch { /* not listening yet */ }
    await sleep(200);
  }
  child.kill('SIGTERM');
  throw new Error(`server did not come up on ${base}:\n${log.slice(-2000)}`);
}

async function stopServer({ child, exited }) {
  if (child.exitCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(timer);
}

async function loginCookies(base) {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: DEMO_USER, password: DEMO_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  const cookies = res.headers.getSetCookie().map((line) => {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
  });
  if (!cookies.length) throw new Error('login answered without a cookie');
  return cookies;
}

// Runs in the page before any of its scripts.
function pageInit() {
  // The default buffer holds 250 entries; the shell alone preloads more.
  performance.setResourceTimingBufferSize(10_000);
  if ('serviceWorker' in navigator) {
    // Never settles: no registration, no warning in the console.
    navigator.serviceWorker.register = () => new Promise(() => {});
  }
}

// Runs in the page after it went idle.
async function pageResult() {
  const lcp = await new Promise((done) => {
    const timer = setTimeout(() => done([]), 1_000);
    new PerformanceObserver((list) => {
      clearTimeout(timer);
      done(list.getEntries());
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  const last = lcp.at(-1);
  if (!last) return { lcp: null };
  const el = last.element;
  const describe = el
    ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`
    : (last.url || 'unknown');
  const resources = performance.getEntriesByType('resource');
  const nav = performance.getEntriesByType('navigation')[0];
  const protocols = [...new Set([nav, ...resources].map((e) => e?.nextHopProtocol).filter(Boolean))];
  return {
    lcp: last.startTime,
    lcpEntries: lcp.length,
    lcpElement: describe,
    requestsUntilLcp: 1 + resources.filter((e) => e.startTime <= last.startTime).length,
    requestsTotal: 1 + resources.length,
    protocols,
    path: location.pathname,
  };
}

async function measureOnce(browser, templateDb, workDir, index) {
  const dbPath = join(workDir, `run-${index}.db`);
  copyDb(templateDb, dbPath);
  const port = await freePort();
  const server = await startServer({ dbPath, port, sessionSecret: randomBytes(32).toString('hex') });
  const context = await browser.createBrowserContext();
  try {
    const cookies = await loginCookies(server.base);
    await context.setCookie(...cookies.map((c) => ({ ...c, domain: '127.0.0.1', path: '/' })));
    const page = await context.newPage();
    await page.setBypassServiceWorker(true);
    await page.evaluateOnNewDocument(pageInit);
    await page.emulateNetworkConditions(network);
    await page.emulateCPUThrottling(CPU_THROTTLING);
    await page.goto(`${server.base}${PAGE_PATH}`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    // Network idle alone ends too early: under 4x CPU throttling the module
    // graph can pause the network for longer than any idle window while the
    // boot screen still stands. #app-loading lives in #app and goes with the
    // first render of the shell (public/router.js renderPage); after that the
    // page and its data requests run, then the network goes quiet.
    await page.waitForFunction(() => !document.getElementById('app-loading'), { timeout: NAV_TIMEOUT_MS, polling: 100 });
    await page.waitForNetworkIdle({ idleTime: IDLE_MS, timeout: NAV_TIMEOUT_MS });
    await sleep(SETTLE_MS);
    const result = await page.evaluate(pageResult);
    if (result.path !== PAGE_PATH) throw new Error(`landed on ${result.path} instead of ${PAGE_PATH}`);
    if (result.lcp === null) throw new Error('no largest-contentful-paint entry');
    return result;
  } finally {
    await context.close();
    await stopServer(server);
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  }
}

function commitInfo() {
  try {
    return execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const workDir = mkdtempSync(join(tmpdir(), 'yuvomi-cold-start-'));
  const browser = await puppeteer.launch({ headless: true, args: ['--no-proxy-server'] });
  const browserName = await browser.version();
  const rounds = [];
  try {
    console.error('Seeding demo database...');
    const templateDb = seedTemplate(workDir);
    for (let r = 1; r <= ROUNDS; r += 1) {
      const runs = [];
      for (let i = 1; i <= RUNS; i += 1) {
        const res = await measureOnce(browser, templateDb, workDir, `${r}-${i}`);
        runs.push(res);
        console.error(`  round ${r} run ${i}: LCP ${Math.round(res.lcp)} ms, `
          + `${res.requestsUntilLcp} requests until LCP (${res.requestsTotal} total), `
          + `element ${res.lcpElement}, ${res.protocols.join('/')}`);
      }
      rounds.push({
        medianLcpMs: Math.round(median(runs.map((x) => x.lcp))),
        medianRequestsUntilLcp: median(runs.map((x) => x.requestsUntilLcp)),
        medianRequestsTotal: median(runs.map((x) => x.requestsTotal)),
        lcpMs: runs.map((x) => Math.round(x.lcp)),
        requestsUntilLcp: runs.map((x) => x.requestsUntilLcp),
        requestsTotal: runs.map((x) => x.requestsTotal),
        lcpElements: [...new Set(runs.map((x) => x.lcpElement))],
        protocols: [...new Set(runs.flatMap((x) => x.protocols))],
      });
    }
  } finally {
    await browser.close();
    rmSync(workDir, { recursive: true, force: true });
  }

  const medians = rounds.map((x) => x.medianLcpMs);
  const spread = medians.length > 1 ? (Math.max(...medians) - Math.min(...medians)) / Math.min(...medians) : null;
  const stable = spread === null ? null : spread < STABILITY_LIMIT;
  const result = {
    page: PAGE_PATH,
    version,
    commit: commitInfo(),
    measuredAt: new Date().toISOString(),
    runShape: {
      network: { preset: NETWORK_PRESET, ...network },
      cpuThrottling: CPU_THROTTLING,
      protocol: 'HTTP/1.1, no proxy, 127.0.0.1',
      serviceWorker: 'not registered',
      nodeEnv: 'production',
      browser: browserName,
      node: process.version,
      runsPerRound: RUNS,
    },
    rounds,
    medianLcpMs: rounds.at(-1).medianLcpMs,
    medianRequestsUntilLcp: rounds.at(-1).medianRequestsUntilLcp,
    medianRequestsTotal: rounds.at(-1).medianRequestsTotal,
    stability: spread === null ? null : { spreadPercent: Math.round(spread * 1000) / 10, limitPercent: STABILITY_LIMIT * 100, stable },
  };
  console.log(JSON.stringify(result, null, 2));
  const last = rounds.at(-1);
  console.error(`Cold start ${PAGE_PATH} (${NETWORK_PRESET}, HTTP/1.1, CPU ${CPU_THROTTLING}x, no service worker, `
    + `${RUNS} runs): median LCP ${last.medianLcpMs} ms, median ${last.medianRequestsUntilLcp} requests until LCP (${last.medianRequestsTotal} in the whole run)`
    + (spread === null ? '.' : `; ${ROUNDS} rounds, medians ${medians.join(' / ')} ms, spread ${result.stability.spreadPercent} % `
      + `(${stable ? 'stable' : 'NOT stable'}, limit ${STABILITY_LIMIT * 100} %).`));
  if (stable === false) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
