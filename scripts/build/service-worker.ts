/**
 * Module: service worker of the build (Phase 1a, section D2)
 * Purpose: dist/sw.js is public/sw.js copied, not bundled, with three values
 *          filled in that only the build knows:
 *   - `self.__PRECACHE__`: every file the module graph reaches from the entries
 *     (index.html and the facades), following static AND dynamic imports - the
 *     pages are dynamic imports of the router and must be there offline - plus
 *     the copied files marked `precache` in static-files.ts, minus
 *     OFFLINE_EXCLUDED (the same gaps the hand lists had);
 *   - `self.__LOCALES__`: every locale file the build copies (the allowlist of
 *     the CACHE_LOCALE message);
 *   - APP_RELEASE from package.json and APP_BUILD_REVISION (env, else the git
 *     commit, else the version), the tokens `__YUVOMI_APP_RELEASE__` and
 *     `__YUVOMI_BUILD_REVISION__`.
 * The hand lists (368 lines) are gone; test:sw-precache checks the output.
 * Abhaengigkeiten: node:child_process (git), node:fs, ./static-files.ts, ./vite-plugins.ts, vite (Typen)
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { OFFLINE_EXCLUDED, copyEntryFor } from './static-files.ts';
import { copiedFiles } from './vite-plugins.ts';

export const APP_RELEASE_TOKEN = '__YUVOMI_APP_RELEASE__';
export const BUILD_REVISION_TOKEN = '__YUVOMI_BUILD_REVISION__';
const SAFE_BUILD_REVISION = /^[A-Za-z0-9._-]{1,80}$/;

export interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
}
export type Manifest = Record<string, ManifestChunk>;

/**
 * The precache list: `/`, `/index.html`, then every file reached from the
 * manifest entries and every copied file marked for the precache, sorted.
 * `copied` are paths relative to public/. Deterministic: same input, same list.
 */
export function computePrecache(manifest: Manifest, copied: readonly string[]): string[] {
  const excluded = new Set(OFFLINE_EXCLUDED);
  const files = new Set<string>();
  const seen = new Set<string>();
  const queue = Object.keys(manifest).filter((key) => manifest[key]?.isEntry).sort();
  while (queue.length) {
    const key = queue.shift() as string;
    if (seen.has(key)) continue;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`[yuvomi:sw] manifest key ${key} is referenced but missing`);
    if (chunk.src && excluded.has(chunk.src)) continue;
    // The HTML entry's own file is its JS chunk; the page itself is "/index.html".
    files.add(`/${chunk.file}`);
    for (const f of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) files.add(`/${f}`);
    for (const dep of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  for (const rel of copied) {
    if (excluded.has(rel)) continue;
    if (copyEntryFor(rel)?.precache) files.add(`/${rel}`);
  }
  return ['/', '/index.html', ...[...files].sort()];
}

/** Every copied locale file, as the URL the worker sees. */
export function localeList(copied: readonly string[]): string[] {
  return copied.filter((rel) => /^locales\/[^/]+\.json$/.test(rel)).map((rel) => `/${rel}`).sort();
}

/** APP_BUILD_REVISION from the environment, else the git commit, else the version. */
export function buildRevision(repoRoot: string, version: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = String(env.APP_BUILD_REVISION ?? '').trim();
  if (fromEnv) return fromEnv;
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const sha = git.status === 0 ? git.stdout.trim() : '';
  return sha || version;
}

/** The text of dist/sw.js. Throws when a token is missing or the revision is unsafe for a script. */
export function renderServiceWorker(source: string, opts: {
  precache: readonly string[];
  locales: readonly string[];
  release: string;
  revision: string;
}): string {
  if (!SAFE_BUILD_REVISION.test(opts.revision)) {
    throw new Error(`[yuvomi:sw] APP_BUILD_REVISION must match ${SAFE_BUILD_REVISION} (got ${JSON.stringify(opts.revision)})`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(opts.release)) {
    throw new Error(`[yuvomi:sw] package.json version ${JSON.stringify(opts.release)} is not a release`);
  }
  for (const token of [APP_RELEASE_TOKEN, BUILD_REVISION_TOKEN]) {
    if (!source.includes(token)) throw new Error(`[yuvomi:sw] public/sw.js lost the token ${token}`);
  }
  const head = `self.__PRECACHE__ = ${JSON.stringify(opts.precache)};\nself.__LOCALES__ = ${JSON.stringify(opts.locales)};\n`;
  return head + source.replaceAll(APP_RELEASE_TOKEN, opts.release).replaceAll(BUILD_REVISION_TOKEN, opts.revision);
}

export function serviceWorkerPlugin(repoRoot: string, publicDir: string): Plugin {
  return {
    name: 'yuvomi:service-worker',
    apply: 'build',
    writeBundle(options, bundle) {
      const asset = bundle['.vite/manifest.json'];
      if (!asset || asset.type !== 'asset') throw new Error('[yuvomi:sw] build.manifest is off - the precache needs it');
      const manifest = JSON.parse(String(asset.source)) as Manifest;
      const copied = copiedFiles(publicDir);
      const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
      const text = renderServiceWorker(readFileSync(join(publicDir, 'sw.js'), 'utf8'), {
        precache: computePrecache(manifest, copied),
        locales: localeList(copied),
        release: version,
        revision: buildRevision(repoRoot, version),
      });
      writeFileSync(join(String(options.dir), 'sw.js'), text);
    },
  };
}
