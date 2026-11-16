/**
 * Module: what the build ships besides the module graph (Phase 1a, section D)
 * Purpose: Vite bundles what `index.html` and the facades reach through `import`.
 *          Everything else the app loads by URL - classic scripts in <head>, the
 *          stylesheets the router attaches per page, locale files fetched by
 *          i18n.js, icons, the hand-copied vendor packages - is copied from
 *          public/ to dist/ by name from this list. `publicDir` is off on
 *          purpose: it copies whatever someone drops in, this list makes every
 *          shipped file a decision (`test:static-copy-list` holds it against the
 *          directory). Plain data, no imports: the tests read it natively.
 * Paths are relative to public/. An entry is a file, a directory ending in `/`
 * (copied recursively) or `dir/*.ext` (one level, one extension). The first
 * matching entry decides whether a file is precached by the service worker.
 * Abhaengigkeiten: keine (reine Daten; Build-Plugins und Tests lesen sie nativ)
 */

export interface CopyEntry {
  path: string;
  precache: boolean;
  why: string;
}

/** Ungehashed module entries with a fixed path: the third-party module contract (docs/SPEC.md, "Third-Party Modules"). */
export const FACADES: readonly string[] = ['api.js', 'i18n.js', 'utils/html.js'];

export const COPY_LIST: readonly CopyEntry[] = [
  { path: 'browser-floor.js', precache: true, why: 'classic ES5 script, first in <head> of index.html and offline.html: sends a browser below the floor to browser-too-old.html' },
  { path: 'browser-too-old.html', precache: true, why: 'the static notice for browsers below the floor; precached so a worker from before an update serves it offline too' },
  { path: 'static-page-title.js', precache: true, why: 'classic ES5 script at the end of browser-too-old.html and offline.html, sets <title> in the page language' },
  { path: 'night-hours.js', precache: true, why: 'classic script in <head> of index.html and offline.html' },
  { path: 'theme-init.js', precache: true, why: 'classic script in <head>, sets the theme before the first paint' },
  { path: 'lang-init.js', precache: true, why: 'classic script in <head>, sets lang before the first paint' },
  { path: 'boot-fetch.js', precache: true, why: 'classic script in <head>, starts the boot requests' },
  { path: 'lucide.min.js', precache: true, why: 'classic deferred script, the icon bundle (window.lucide)' },
  { path: 'lucide-scope.js', precache: true, why: 'classic deferred script right after the icon bundle' },
  { path: 'favicon.ico', precache: true, why: 'linked from index.html' },
  { path: 'icons/', precache: true, why: 'linked from index.html, manifest.json and the push handler in sw.js' },
  { path: 'manifest.json', precache: true, why: 'the PWA manifest file (the /manifest.webmanifest route renders its own)' },
  { path: 'offline.html', precache: true, why: 'the service worker answers with it when nothing else is cached' },
  { path: 'robots.txt', precache: false, why: 'for crawlers, not for the app' },
  { path: 'locales/de.json', precache: true, why: 'DEFAULT_LOCALE of i18n.js: the fallback language must be there offline' },
  { path: 'locales/*.json', precache: false, why: 'fetched by i18n.js; the worker caches the device language on demand (CACHE_LOCALE)' },
  { path: 'styles/', precache: true, why: 'linked from index.html (vite-ignore keeps the cascade order) or attached by the router per page' },
  { path: 'vendor/sortablejs/sortable.esm.min.js', precache: true, why: 'hand copy, imported by utils/sortable.js at runtime (external)' },
  { path: 'vendor/libphonenumber/core.min.mjs', precache: true, why: 'hand copy, imported by utils/phone.js at runtime, offline phone formatting' },
  { path: 'vendor/libphonenumber/metadata.min.json', precache: true, why: 'fetched by utils/phone.js next to core.min.mjs' },
  { path: 'vendor/', precache: false, why: 'hand copies with LICENSE and README; pdf.js is never cached at all: documents are not offline, and public/sw.js lets /vendor/pdfjs/ pass to the browser (#2634)' },
];

/**
 * Shipped, but left out of the precache although the copy list or the module
 * graph reaches them. Same set as the hand lists in sw.js before the build:
 * opt-in modules most installations never open, the sign-up and recovery pages
 * that make no sense offline, and stylesheets that were never precached.
 */
export const OFFLINE_EXCLUDED: readonly string[] = [
  'pages/join.js',
  'pages/forgot-password.js',
  'pages/reset-password.js',
  'pages/setup.js',
  'pages/waste.js',
  'pages/schedule.js',
  'pages/housekeeping.js',
  'styles/waste.css',
  'styles/housekeeping.css',
  'styles/subscriptions.css',
  'styles/split-expenses.css',
  'styles/rewards.css',
  'styles/health.css',
];

/** Files under public/ that never reach dist/ as they are. */
export const NOT_COPIED: readonly { path: string; why: string }[] = [
  { path: 'index.html', why: 'the HTML entry, written by Vite' },
  { path: 'sw.js', why: 'written to dist/ by the service-worker plugin with the precache list filled in' },
  { path: 'tsconfig.json', why: 'type checking of the sources, not part of the app' },
];

/** Is `rel` (relative to public/) matched by `entry`? */
export function matchesEntry(entry: CopyEntry, rel: string): boolean {
  if (entry.path.endsWith('/')) return rel.startsWith(entry.path);
  const star = entry.path.indexOf('/*.');
  if (star >= 0) {
    const dir = entry.path.slice(0, star + 1);
    const ext = entry.path.slice(star + 2);
    return rel.startsWith(dir) && !rel.slice(dir.length).includes('/') && rel.endsWith(ext);
  }
  return rel === entry.path;
}

/** The first entry of COPY_LIST that matches, or null. */
export function copyEntryFor(rel: string): CopyEntry | null {
  return COPY_LIST.find((entry) => matchesEntry(entry, rel)) ?? null;
}
