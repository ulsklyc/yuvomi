/**
 * Vite 8 build of the web app (Phase 1a, section D; docs/plans/2026-11-08-phase-1a-plan.md).
 * public/ stays the source (E9), dist/ is the output the server serves.
 * What is bundled: index.html with its module scripts, the pages behind
 * `import.meta.glob` in router.js and everything they import, plus the three
 * facades. What is copied by name: scripts/build/static-files.ts.
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import {
  facadesPlugin,
  moduleListPlugin,
  nonModuleTagsPlugin,
  indexHtmlPlugin,
  isExternal,
  staticCopyPlugin,
} from './scripts/build/vite-plugins.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const publicDir = fileURLToPath(new URL('./public', import.meta.url));

export default defineConfig({
  root: publicDir,
  // Off: with root public/ the default would be public/public. The named copy
  // list in static-files.ts replaces it.
  publicDir: false,
  appType: 'spa',
  plugins: [
    nonModuleTagsPlugin(),
    facadesPlugin(publicDir),
    staticCopyPlugin(publicDir),
    indexHtmlPlugin(publicDir, 'pages/dashboard.js'),
    moduleListPlugin(repoRoot),
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
    rolldownOptions: {
      input: { index: fileURLToPath(new URL('./public/index.html', import.meta.url)) },
      external: isExternal,
    },
  },
});
