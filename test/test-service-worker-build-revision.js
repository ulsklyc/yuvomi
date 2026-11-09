/**
 * Modul: Service-Worker-Build-Revision
 * Zweck: Gleichversionige Images dürfen keine ältere PWA-Shell wiederverwenden.
 * Run: node --test test/test-service-worker-build-revision.js
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const serviceWorkerModule = await import('../server/utils/service-worker.js');

test('renders a distinct service worker response for each same-version build revision', () => {
  assert.equal(typeof serviceWorkerModule.renderServiceWorkerSource, 'function');

  const template = "globalThis.cacheRevision = '__YUVOMI_BUILD_REVISION__';";
  const first = serviceWorkerModule.renderServiceWorkerSource(template, 'acceptance-a');
  const second = serviceWorkerModule.renderServiceWorkerSource(template, 'acceptance-b');

  assert.equal(first, "globalThis.cacheRevision = 'acceptance-a';");
  assert.equal(second, "globalThis.cacheRevision = 'acceptance-b';");
  assert.notEqual(first, second);
});

test('the shipped service worker gives same-version builds different cache namespaces', () => {
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const first = serviceWorkerModule.renderServiceWorkerSource(source, 'acceptance-a');
  const second = serviceWorkerModule.renderServiceWorkerSource(source, 'acceptance-b');

  assert.notEqual(first, second);
  assert.match(first, /const APP_BUILD_REVISION\s*=\s*'acceptance-a'/);
  assert.match(first, /yuvomi-shell-\$\{CACHE_RELEASE\}/);
  assert.doesNotMatch(first, /__YUVOMI_BUILD_REVISION__/);
});

test('builds a non-cacheable service worker response and falls back to the app version', () => {
  assert.equal(typeof serviceWorkerModule.buildServiceWorkerResponse, 'function');

  const response = serviceWorkerModule.buildServiceWorkerResponse(
    "globalThis.cacheRevision = '__YUVOMI_BUILD_REVISION__';",
    { appVersion: '2.59.0', buildRevision: '' },
  );

  assert.deepEqual(response, {
    body: "globalThis.cacheRevision = '2.59.0';",
    contentType: 'text/javascript; charset=utf-8',
    cacheControl: 'no-store, max-age=0',
    cdnCacheControl: 'no-store',
    cloudflareCdnCacheControl: 'no-store',
  });
});

test('rejects unsafe APP_BUILD_REVISION values with the variable name and allowed format', () => {
  for (const value of [
    "a'; fetch('//evil')//",
    'a\\',
    'a\nb',
    '</script>',
    'a'.repeat(81),
    '',
  ]) {
    assert.throws(
      () => serviceWorkerModule.renderServiceWorkerSource('revision: __YUVOMI_BUILD_REVISION__', value),
      /\[SW\] APP_BUILD_REVISION must match \/\^\[A-Za-z0-9\._-\]\{1,80\}\$\//,
    );
  }
});

test('falls back to the app version when APP_BUILD_REVISION is blank after trimming', () => {
  const response = serviceWorkerModule.buildServiceWorkerResponse(
    "globalThis.cacheRevision = '__YUVOMI_BUILD_REVISION__';",
    { appVersion: '2.59.0', buildRevision: '   ' },
  );

  assert.equal(response.body, "globalThis.cacheRevision = '2.59.0';");
});

test('reloads an edited service worker source from an isolated file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuvomi-service-worker-'));
  const sourcePath = join(directory, 'sw.js');

  try {
    writeFileSync(sourcePath, "globalThis.cacheRevision = '__YUVOMI_BUILD_REVISION__';\n");
    const load = serviceWorkerModule.createServiceWorkerResponseLoader(sourcePath, {
      appVersion: '2.59.0',
      buildRevision: 'acceptance-route-test',
    });

    assert.equal(
      load().body,
      "globalThis.cacheRevision = 'acceptance-route-test';\n",
    );

    writeFileSync(
      sourcePath,
      "globalThis.cacheRevision = '__YUVOMI_BUILD_REVISION__';\n// edited\n",
    );

    assert.match(load().body, /\/\/ edited/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// --------------------------------------------------------
// Seit dem Build (Phase 1a, Abschnitt D): Version und Revision setzt
// scripts/build/service-worker.ts in dist/sw.js ein, nicht mehr der Server
// und nicht mehr eine Hand-Zeile in public/sw.js.
// --------------------------------------------------------
const build = await import('../scripts/build/service-worker.ts');
const { readDist } = await import('./dist-build.js');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('public/sw.js traegt beide Tokens und keine Version von Hand', () => {
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(source, /const APP_RELEASE {8}= '__YUVOMI_APP_RELEASE__';/);
  assert.match(source, /const APP_BUILD_REVISION = '__YUVOMI_BUILD_REVISION__';/);
  assert.doesNotMatch(source, /const APP_RELEASE\s*=\s*'\d/, 'eine Version von Hand driftet von package.json');
});

test('the build gives same-version builds different cache namespaces', () => {
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const base = { precache: ['/'], locales: [], release: '2.59.0' };
  const first = build.renderServiceWorker(source, { ...base, revision: 'acceptance-a' });
  const second = build.renderServiceWorker(source, { ...base, revision: 'acceptance-b' });
  assert.notEqual(first, second);
  assert.match(first, /const APP_BUILD_REVISION = 'acceptance-a'/);
  assert.match(first, /const APP_RELEASE {8}= '2\.59\.0'/);
  assert.doesNotMatch(first, /__YUVOMI_(?:BUILD_REVISION|APP_RELEASE)__/);
});

test('the build rejects an unsafe revision and a source without its tokens', () => {
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  for (const revision of ["a'; fetch('//evil')//", '</script>', 'a'.repeat(81), '']) {
    assert.throws(() => build.renderServiceWorker(source, { precache: [], locales: [], release: '2.59.0', revision }), /APP_BUILD_REVISION must match/);
  }
  assert.throws(() => build.renderServiceWorker('const x = 1;', { precache: [], locales: [], release: '2.59.0', revision: 'a' }), /lost the token/);
});

test('revision: APP_BUILD_REVISION, else git, else the version', () => {
  assert.equal(build.buildRevision('/', '2.59.0', { APP_BUILD_REVISION: ' abc123 ' }), 'abc123');
  const outside = mkdtempSync(join(tmpdir(), 'yuvomi-no-git-'));
  try {
    assert.equal(build.buildRevision(outside, '2.59.0', {}), '2.59.0');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('dist/sw.js carries the release of package.json and a filled revision', () => {
  const built = readDist('sw.js');
  assert.equal(built.match(/const APP_RELEASE\s*=\s*'([^']+)'/)?.[1], pkg.version, 'dist/sw.js APP_RELEASE != package.json version');
  assert.match(built, /const APP_BUILD_REVISION = '[A-Za-z0-9._-]{1,80}'/);
  assert.doesNotMatch(built, /__YUVOMI_(?:BUILD_REVISION|APP_RELEASE)__/);
});

test('the server leaves a built worker without the token as it is', () => {
  const built = "self.__PRECACHE__ = ['/'];\nconst APP_BUILD_REVISION = 'abc';\n";
  const response = serviceWorkerModule.buildServiceWorkerResponse(built, { appVersion: '2.59.0', buildRevision: 'other' });
  assert.equal(response.body, built);
  assert.equal(response.cacheControl, 'no-store, max-age=0');
});
