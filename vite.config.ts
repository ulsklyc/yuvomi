/**
 * Vite 8 build of the web app (Phase 1a, section D; docs/plans/2026-11-08-phase-1a-plan.md).
 * public/ stays the source (E9), dist/ is the output the server serves.
 * What is bundled: index.html with its module scripts, the pages behind
 * `import.meta.glob` in router.js and everything they import, plus the three
 * facades. What is copied by name: scripts/build/static-files.ts. The service
 * worker is copied with its precache list filled in: scripts/build/service-worker.ts.
 * Abhaengigkeiten: vite, scripts/build/*.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import {
  facadesPlugin,
  moduleListPlugin,
  nonModuleTagsPlugin,
  noticesPlugin,
  indexHtmlPlugin,
  isExternal,
  staticCopyPlugin,
} from './scripts/build/vite-plugins.ts';
import { serviceWorkerPlugin } from './scripts/build/service-worker.ts';
import { devProxy } from './scripts/build/dev-proxy.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// `npm run dev` (scripts/dev.mjs): Vite serves public/ on 5173, everything the
// Express server answers itself goes through to it (scripts/build/dev-proxy.ts).
// PORT and BIND_ADDRESS come from scripts/dev.mjs, which reads .env for both processes.
const backendPort = process.env.PORT || 3000;
const publicDir = fileURLToPath(new URL('./public', import.meta.url));

// TEST LAYOUT for the browser suites (test:document-guards, test:fasting-browser):
// YUVOMI_BUILD_LAYOUT=modules. Those suites import modules by their source
// path inside the running app (`await import('/components/modal.js')`) and need
// the SAME instance the app uses - a bundle has no file at that path. Here every
// module keeps its path (Rolldown `preserveModules`), the module scripts of
// index.html are the entries, and index.html is copied as it is, so the app
// starts in the same order. Same code, same minifier, same server; only the
// file layout differs. Never shipped: image, tarball and `npm run build` use
// the default layout.
const modulesLayout = process.env.YUVOMI_BUILD_LAYOUT === 'modules';
const moduleScripts = [...readFileSync(`${publicDir}/index.html`, 'utf8').matchAll(/<script type="module" src="\/([^"]+)"/g)]
  .map((m) => String(m[1]));

export default defineConfig({
  root: publicDir,
  // Off: with root public/ the default would be public/public. The named copy
  // list in static-files.ts replaces it.
  publicDir: false,
  appType: 'spa',
  server: {
    port: 5173,
    strictPort: true,
    // Host stays localhost:5173 (no changeOrigin): the session cookie and the
    // CSRF origin check see the address the browser uses.
    proxy: devProxy(backendPort, process.env.BIND_ADDRESS),
  },
  plugins: modulesLayout ? [
    staticCopyPlugin(publicDir, ['index.html']),
    moduleListPlugin(repoRoot),
    serviceWorkerPlugin(repoRoot, publicDir),
    noticesPlugin(repoRoot),
  ] : [
    nonModuleTagsPlugin(),
    facadesPlugin(publicDir),
    staticCopyPlugin(publicDir),
    indexHtmlPlugin(publicDir, 'pages/dashboard.js'),
    moduleListPlugin(repoRoot),
    serviceWorkerPlugin(repoRoot, publicDir),
    noticesPlugin(repoRoot),
  ],
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    // outDir lies outside root, Vite only empties it when told to.
    emptyOutDir: true,
    manifest: true,
    // Shipped (E11): minified code points back to the source line.
    sourcemap: true,
    // The browser floor supports modulepreload natively.
    modulePreload: { polyfill: false },
    target: ['chrome105', 'firefox115', 'safari15.4'],
    // One shared chunk above Vite's 500 kB default is expected (the router).
    chunkSizeWarningLimit: 1024,
    reportCompressedSize: false,
    rolldownOptions: modulesLayout ? {
      input: Object.fromEntries(moduleScripts.map((file) => [file.replace(/\.js$/, ''), `${publicDir}/${file}`])),
      external: isExternal,
      preserveEntrySignatures: 'strict',
      output: { preserveModules: true, preserveModulesRoot: publicDir, entryFileNames: '[name].js' },
    } : {
      input: { index: fileURLToPath(new URL('./public/index.html', import.meta.url)) },
      external: isExternal,
    },
  },
});
