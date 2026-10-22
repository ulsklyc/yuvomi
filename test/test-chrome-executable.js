/**
 * Modul: Test-Infrastruktur - welcher Chrome startet (#2155)
 * Zweck: `resolveChromeExecutable()` nimmt den gepinnten Chrome, solange er da
 *        ist, faellt sonst laut auf einen System-Chrome zurueck und bricht,
 *        wenn gar keiner da ist, mit dem Befehl ab, der den gepinnten holt.
 *        Dazu: jede Stelle, die Puppeteer startet, geht ueber `launchBrowser()`.
 * Ausfuehren: npm run test:chrome-executable
 *
 * ANLASS: nach dem Bump auf puppeteer 25.14.0 (#2103) starb jede Sonde des
 * Handlaufs nach Sekunden mit "Could not find Chrome (ver. ...)", obwohl ein
 * System-Chrome installiert war. Dateisystem, `which` und Versionsabfrage sind
 * hier gestubbt - die Suite braucht keinen Browser und laeuft in `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_COMMAND, launchBrowser, resolveChromeExecutable } from './chrome-executable.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PINNED = '/home/u/.cache/puppeteer/chrome/mac_arm-155.0.8059.79/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Ein Rechner, auf dem genau `files` existieren und `which` nur `onPath` kennt. */
function machine({ files = [], onPath = {}, env = {}, platform = 'darwin', pinnedPath = PINNED } = {}) {
  const asked = [];
  return {
    asked,
    deps: {
      env,
      platform,
      home: '/home/u',
      pinnedPath,
      exists: (p) => files.includes(p),
      which: (cmd) => { asked.push(cmd); return onPath[cmd] ?? null; },
      versionOf: () => 'Google Chrome 141.0.7390.54\n',
    },
  };
}

test('gepinnter Chrome vorhanden: er startet, ohne Warnung - auch wenn ein System-Chrome daneben liegt', () => {
  const { deps } = machine({ files: [PINNED, MAC_CHROME] });
  assert.deepEqual(resolveChromeExecutable(deps), { path: PINNED, source: 'pinned', warning: null });
});

test('gepinnter Chrome fehlt (macOS): System-Chrome mit Warnung, beide Versionen und der Befehl', () => {
  const { deps } = machine({ files: [MAC_CHROME] });
  const got = resolveChromeExecutable(deps);
  assert.equal(got.path, MAC_CHROME);
  assert.equal(got.source, 'system');
  assert.match(got.warning, /gepinnter Chrome 155\.0\.8059\.79 fehlt/);
  assert.match(got.warning, /System-Chrome 141\.0\.7390\.54/);
  assert.ok(got.warning.includes(INSTALL_COMMAND), got.warning);
});

test('gepinnter Chrome fehlt (Linux): System-Chrome ueber which, in der Reihenfolge der Kandidaten', () => {
  const { deps, asked } = machine({
    platform: 'linux',
    files: ['/usr/bin/chromium'],
    onPath: { chromium: '/usr/bin/chromium' },
  });
  const got = resolveChromeExecutable(deps);
  assert.equal(got.path, '/usr/bin/chromium');
  assert.equal(got.source, 'system');
  assert.deepEqual(asked, ['google-chrome-stable', 'google-chrome', 'chromium']);
});

test('weder gepinnt noch System-Chrome: Fehler mit genau dem Installationsbefehl', () => {
  const { deps } = machine({ files: [] });
  assert.throws(() => resolveChromeExecutable(deps), (err) => {
    assert.ok(err.message.includes(INSTALL_COMMAND), err.message);
    assert.match(err.message, /155\.0\.8059\.79/);
    return true;
  });
  assert.equal(INSTALL_COMMAND, 'npx puppeteer browsers install chrome');
});

test('executablePath() warf (kein Pfad bekannt): trotzdem Rueckfall auf den System-Chrome', () => {
  const { deps } = machine({ files: [MAC_CHROME], pinnedPath: null });
  const got = resolveChromeExecutable(deps);
  assert.equal(got.path, MAC_CHROME);
  assert.match(got.warning, /gepinnter Chrome unbekannt fehlt/);
});

test('PUPPETEER_EXECUTABLE_PATH geht vor, auch vor einem vorhandenen gepinnten', () => {
  const { deps } = machine({ files: ['/opt/chrome', PINNED], env: { PUPPETEER_EXECUTABLE_PATH: '/opt/chrome' } });
  assert.deepEqual(resolveChromeExecutable(deps), { path: '/opt/chrome', source: 'env', warning: null });
});

test('PUPPETEER_EXECUTABLE_PATH auf eine fehlende Datei: Fehler, kein stiller Rueckfall', () => {
  const { deps } = machine({ files: [PINNED, MAC_CHROME], env: { PUPPETEER_EXECUTABLE_PATH: '/nirgends/chrome' } });
  assert.throws(() => resolveChromeExecutable(deps), /PUPPETEER_EXECUTABLE_PATH zeigt auf "\/nirgends\/chrome"/);
});

test('launchBrowser() reicht den aufgeloesten Pfad und die Optionen an launch() weiter', async () => {
  const calls = [];
  const fake = {
    executablePath: async () => { throw new Error('kein Cache'); },
    launch: async (opts) => { calls.push(opts); return 'browser'; },
  };
  const saved = process.env.PUPPETEER_EXECUTABLE_PATH;
  process.env.PUPPETEER_EXECUTABLE_PATH = process.execPath; // eine Datei, die es sicher gibt
  try {
    assert.equal(await launchBrowser(fake, { headless: true, args: ['--no-sandbox'] }), 'browser');
  } finally {
    if (saved === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = saved;
  }
  assert.deepEqual(calls, [{ headless: true, args: ['--no-sandbox'], executablePath: process.execPath }]);
});

test('jede Stelle, die Puppeteer startet, geht ueber launchBrowser() - keine eigene Aufloesung', () => {
  const direct = [];
  for (const dir of ['test', 'scripts']) {
    for (const name of readdirSync(join(REPO, dir))) {
      if (!/\.(m?js)$/.test(name) || name === 'chrome-executable.js') continue;
      const src = readFileSync(join(REPO, dir, name), 'utf8');
      if (/\bpuppeteer\.launch\(/.test(src.replace(/^\s*(\/\/|\*).*$/gm, ''))) direct.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(direct, [], `startet Puppeteer an launchBrowser() vorbei:\n  ${direct.join('\n  ')}`);
});
