/**
 * Module: Vite plugins of the Yuvomi build (Phase 1a, section D)
 * Purpose: The four things Vite does not do on its own for this tree:
 *   - facades: /api.js, /i18n.js and /utils/html.js stay at their path,
 *     ungehashed and with every export (third-party module contract);
 *   - static copy: the files the app loads by URL, from COPY_LIST, with
 *     stylesheets minified one by one (the cascade order stays index.html's);
 *   - index.html: the router's modulepreload needs the hashed file of a page,
 *     and the start page is preloaded at low priority behind the shell;
 *   - module list: dist/.vite/modules.json names every source module in the
 *     bundle (the copy-list guard and the third-party notices read it).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { transform as transformCss } from 'lightningcss';
import type { Plugin } from 'vite';
import { writeNotices } from '../build-third-party-notices.mjs';
import { FACADES, NOT_COPIED, copyEntryFor } from './static-files.ts';

const toPosix = (p: string): string => p.split(sep).join('/');

/** Hand copies under public/vendor/ are loaded at runtime, not bundled (E12). */
export const isExternal = (id: string): boolean => id.startsWith('/vendor/');

/** Every file under `dir`, relative and with `/`, sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(toPosix(relative(dir, full)));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The source files under `dir`, sorted. In a git checkout: what git tracks plus
 * new files it does not ignore (`*.tsbuildinfo`, editor and sync leftovers stay
 * out, as they would in `git archive`). Without git (a tree unpacked from
 * `git archive`, the determinism check): every file.
 */
export function sourceFiles(dir: string): string[] {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], {
    cwd: dir, encoding: 'utf8', maxBuffer: 1 << 26,
  });
  if (git.status !== 0 || git.error) return listFiles(dir);
  return [...new Set(git.stdout.split('\0').filter(Boolean))]
    .filter((rel) => existsSync(join(dir, rel)))
    .sort();
}

/**
 * Files of public/ the copy list ships, sorted. `also` adds files the default
 * layout does not copy (the test layout copies index.html as it is).
 */
export function copiedFiles(publicDir: string, also: readonly string[] = []): string[] {
  const skip = new Set(NOT_COPIED.map((entry) => entry.path).filter((rel) => !also.includes(rel)));
  return sourceFiles(publicDir).filter((rel) => !skip.has(rel) && (copyEntryFor(rel) !== null || also.includes(rel)));
}

/**
 * The facades as entries of their own, each with `preserveSignature: 'strict'`.
 * Not as `rolldownOptions.input` with a global `preserveEntrySignatures:
 * 'strict'`: measured with Vite 8.3.7, the global setting breaks the HTML entry
 * (no `index.html` in the manifest, 28 script tags instead of one).
 */
export function facadesPlugin(publicDir: string): Plugin {
  return {
    name: 'yuvomi:facades',
    apply: 'build',
    buildStart() {
      for (const file of FACADES) {
        this.emitFile({ type: 'chunk', id: join(publicDir, file), fileName: file, preserveSignature: 'strict' });
      }
    },
  };
}

/** Copies COPY_LIST into the output directory; stylesheets are minified file by file. */
export function staticCopyPlugin(publicDir: string, also: readonly string[] = []): Plugin {
  return {
    name: 'yuvomi:static-copy',
    apply: 'build',
    writeBundle(options) {
      const outDir = String(options.dir);
      for (const rel of copiedFiles(publicDir, also)) {
        const target = join(outDir, rel);
        mkdirSync(dirname(target), { recursive: true });
        const source = readFileSync(join(publicDir, rel));
        if (rel.startsWith('styles/') && rel.endsWith('.css')) {
          const name = rel.slice(rel.lastIndexOf('/') + 1);
          // No targets: minify only, never lower or prefix - the browsers read
          // these sheets unbundled today and keep reading the same syntax.
          const result = transformCss({ filename: name, code: source, minify: true, sourceMap: true });
          writeFileSync(target, `${result.code.toString()}\n/*# sourceMappingURL=${name}.map */\n`);
          if (result.map) writeFileSync(`${target}.map`, result.map);
        } else {
          writeFileSync(target, source);
        }
      }
    },
  };
}

/**
 * Marks every `<link href>` and classic `<script src>` of index.html with
 * `vite-ignore` before Vite reads the page, so Vite leaves them as they are:
 * the stylesheets stay separate files in their cascade order (the component
 * sheets slot in at `<meta name="component-styles">`), the icons keep their
 * names (manifest.json and the push handler use the same ones), and the
 * classic scripts are not modules. Their files come from COPY_LIST. Only
 * `<script type="module">` goes through the bundler. Done here and not in the
 * source, so index.html stays plain HTML for its many text readers.
 */
export function markNonModuleTags(html: string): string {
  return html.replace(/<(link|script)\b([^>]*)>/gi, (tag: string, name: string, attrs: string) => {
    if (/\bvite-ignore\b/i.test(attrs)) return tag;
    if (name.toLowerCase() === 'script' && (!/\bsrc=/i.test(attrs) || /\btype=["']?module\b/i.test(attrs))) return tag;
    if (name.toLowerCase() === 'link' && /\brel=["']?modulepreload\b/i.test(attrs)) return tag;
    const selfClosing = /\/\s*$/.test(attrs);
    const body = selfClosing ? attrs.replace(/\s*\/\s*$/, '') : attrs;
    return `<${name}${body} vite-ignore${selfClosing ? ' /' : ''}>`;
  });
}

export function nonModuleTagsPlugin(): Plugin {
  return {
    name: 'yuvomi:non-module-tags',
    apply: 'build',
    transformIndexHtml: { order: 'pre', handler: (html) => markNonModuleTags(html) },
  };
}

/** Escapes JSON for a <script type="application/json"> block. */
function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Two additions to dist/index.html, both read from the finished bundle:
 *   - `#yuvomi-page-urls`: the table "source path of a page -> built file". The
 *     router uses it only for `modulepreload`; loading a page goes through
 *     `import.meta.glob`. A JSON block is data, not a script: no CSP hash needed.
 *   - the start page (the overview) and its static imports as modulepreload with
 *     `fetchpriority="low"`, after the links Vite writes for the shell. That is
 *     the start chain index.html carried by hand before the build (Critique
 *     R19): without it the browser finds the overview a level later; at low
 *     priority so the first API requests do not queue behind it.
 */
export function indexHtmlPlugin(publicDir: string, startPage: string): Plugin {
  const pagesDir = `${toPosix(join(publicDir, 'pages'))}/`;
  const startId = toPosix(join(publicDir, startPage));
  return {
    name: 'yuvomi:index-html',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
        const urls: Record<string, string> = {};
        for (const chunk of chunks) {
          if (!chunk.facadeModuleId) continue;
          const id = toPosix(chunk.facadeModuleId);
          if (id.startsWith(pagesDir)) urls[`/pages/${id.slice(pagesDir.length)}`] = `/${chunk.fileName}`;
        }
        const sorted = Object.fromEntries(Object.entries(urls).sort(([a], [b]) => a.localeCompare(b)));

        const byFile = new Map(chunks.map((c) => [c.fileName, c]));
        const start = chunks.find((c) => c.facadeModuleId && toPosix(c.facadeModuleId) === startId);
        if (!start) throw new Error(`[yuvomi:index-html] start page ${startPage} is not in the bundle`);
        const already = new Set([...html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="\/([^"]+)"/g)].map((m) => m[1]));
        const order: string[] = [];
        const queue = [start.fileName];
        const seen = new Set(queue);
        while (queue.length) {
          const file = queue.shift() as string;
          if (!already.has(file)) order.push(file);
          for (const dep of byFile.get(file)?.imports ?? []) {
            if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
          }
        }
        return {
          html,
          tags: [
            ...order.map((file) => ({
              tag: 'link',
              attrs: { rel: 'modulepreload', crossorigin: true, fetchpriority: 'low', href: `/${file}` },
              injectTo: 'head' as const,
            })),
            {
              tag: 'script',
              attrs: { type: 'application/json', id: 'yuvomi-page-urls' },
              children: jsonForHtml(sorted),
              injectTo: 'head' as const,
            },
          ],
        };
      },
    },
  };
}

/**
 * Source module id as a repository path (`public/...`, `node_modules/...`), or
 * `virtual:<id>` for helpers the toolchain injects (`\0vite/preload-helper.js`,
 * `\0rolldown/runtime.js`, `\0@oxc-project+runtime@<v>/...`).
 */
function repoPath(repoRoot: string, id: string): string {
  if (id.startsWith('\0')) return `virtual:${id.slice(1)}`;
  const clean = id.split('?')[0] ?? id;
  return toPosix(relative(repoRoot, clean));
}

/**
 * dist/.vite/modules.json, sorted:
 *   - `graph`: every module the build resolved through `import`, also those whose
 *     code was inlined or shaken out (a constant like MAX_INTERVAL_COUNT leaves
 *     no module behind in a chunk) - the copy-list guard reads this;
 *   - `rendered`: the modules whose code is in a chunk - the third-party notices
 *     read this, it is what ships;
 *   - `external`: runtime imports left as they are (the hand copies in vendor/);
 *   - `chunks`: which modules each output chunk carries (guards that ask "is
 *     this source module in the precache" read it).
 */
export function moduleListPlugin(repoRoot: string): Plugin {
  return {
    name: 'yuvomi:module-list',
    apply: 'build',
    generateBundle(_options, bundle) {
      const rendered = new Set<string>();
      const chunks: Record<string, string[]> = {};
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const ids = chunk.moduleIds.map((id) => repoPath(repoRoot, id)).sort();
        ids.forEach((id) => rendered.add(id));
        chunks[chunk.fileName] = ids;
      }
      const byFile = Object.fromEntries(Object.entries(chunks).sort(([x], [y]) => x.localeCompare(y)));
      const graph = new Set<string>();
      const external = new Set<string>();
      for (const id of this.getModuleIds()) {
        if (isExternal(id)) external.add(id);
        else graph.add(repoPath(repoRoot, id));
      }
      this.emitFile({
        type: 'asset',
        fileName: '.vite/modules.json',
        source: `${JSON.stringify({ layout: process.env.YUVOMI_BUILD_LAYOUT === 'modules' ? 'modules' : 'bundle', graph: [...graph].sort(), rendered: [...rendered].sort(), external: [...external].sort(), chunks: byFile }, null, 2)}\n`,
      });
    },
  };
}

/** dist/THIRD-PARTY-NOTICES.txt from the module list (scripts/build-third-party-notices.mjs). */
export function noticesPlugin(repoRoot: string): Plugin {
  return {
    name: 'yuvomi:third-party-notices',
    apply: 'build',
    writeBundle(options) {
      writeNotices(String(options.dir), repoRoot);
    },
  };
}
