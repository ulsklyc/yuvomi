/**
 * Module: test inventory - what the suites read at run time
 * Purpose: scripts/test-inventory.mjs reads the suites as text and cannot follow a path
 *          that only exists at run time (a walk over the routers, an import graph).
 *          This preload records what test code really reads under public/ and server/
 *          while the chain runs, so the inventory can be checked against it.
 * Run: rm -rf <dir>
 *      TEXT_READER_TRACE=<dir> NODE_OPTIONS="--import file://<repo>/scripts/trace-test-reads.mjs" \
 *        npm run test-parallel
 *      node scripts/test-inventory.mjs --trace <dir>      (compares with the inventory)
 *      The preload is named as a file: URL. A bare absolute path would be taken for an
 *      app path by test/test-browser-loader.mjs, and every suite that runs through that
 *      loader would fail before its first test.
 * Without TEXT_READER_TRACE the module does nothing.
 *
 * ONE FILE PER PROCESS. The chain runs its suites side by side. Every process writes
 * `<dir>/<suite>.<pid>.tsv` of its own, so no two processes share a file and no line
 * can be torn by another writer. A run only adds files: remove the directory before a
 * run, or the reads of an earlier run stay in it and the comparison reports files no
 * suite reads any more.
 *
 * WHAT COUNTS. A call of readFileSync, readFile, readdirSync, readdir, opendirSync or
 * createReadStream (and their promise forms) whose path lies under public/ or server/,
 * made by a file under test/, in a process that runs one suite (test/test-*.js). App
 * code that reads its own files while a suite runs it is not a read by the suite, and
 * the browser loader that loads app modules for a suite is not one either.
 * One line per suite and path: `<suite>\t<path>`, a directory with "/" at the end.
 *
 * WHO CALLED. The caller comes from V8's call sites (Error.prepareStackTrace), not
 * from the text of a stack trace, so a changed trace format or source maps do not
 * move it. If this Node hands out no call sites, the preload throws when it loads:
 * a trace that silently records nothing would read as "the inventory is complete".
 *
 * TEXT_READER_TRACE_ROOT replaces the repository root. It exists for the suite that
 * tests this preload on a tree of its own.
 */

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.env.TEXT_READER_TRACE;
const suite = /(?:^|[\\/])test[\\/](test-[^\\/]+\.js)$/.exec(process.argv[1] ?? '')?.[1];

if (out && suite) {
  const self = fileURLToPath(import.meta.url);
  const root = join(resolve(process.env.TEXT_READER_TRACE_ROOT ?? fileURLToPath(new URL('..', import.meta.url))), sep);
  const tests = join(root, 'test', sep);
  const append = fs.appendFileSync.bind(fs);
  fs.mkdirSync(out, { recursive: true });
  const file = join(out, `${suite}.${process.pid}.tsv`);
  /** @type {Set<string>} */
  const seen = new Set();

  /** The file that called the read: the first call site that is neither Node nor this module. */
  const callerOf = () => {
    const prepare = Error.prepareStackTrace;
    try {
      Error.prepareStackTrace = (_error, sites) => sites;
      const sites = /** @type {unknown} */ (new Error().stack);
      if (!Array.isArray(sites) || typeof sites[0]?.getFileName !== 'function') {
        throw new Error('trace-test-reads: this Node hands out no call sites, the trace would stay empty.');
      }
      for (const site of /** @type {NodeJS.CallSite[]} */ (sites)) {
        const name = site.getFileName();
        if (!name || name.startsWith('node:')) continue;
        const path = name.startsWith('file://') ? fileURLToPath(name) : name;
        if (path !== self) return path;
      }
      return '';
    } finally {
      Error.prepareStackTrace = prepare;
    }
  };
  // Fails here, once and loudly, where call sites are not available.
  callerOf();

  /**
   * @param {unknown} target what the read call was given
   * @param {boolean} directory
   */
  const record = (target, directory) => {
    /** @type {string} */
    let path;
    try {
      if (target instanceof URL) path = fileURLToPath(target);
      else if (typeof target === 'string' || Buffer.isBuffer(target)) path = resolve(String(target));
      else return;
    } catch { return; }
    if (!path.startsWith(root)) return;
    const rel = path.slice(root.length).split(sep).join('/').replace(/\/+$/, '') + (directory ? '/' : '');
    if (!/^(?:public|server)\//.test(rel) || seen.has(rel)) return;
    const caller = callerOf();
    if (!caller.startsWith(tests) || caller.endsWith('test-browser-loader.mjs')) return;
    seen.add(rel);
    append(file, `${suite}\t${rel}\n`);
  };

  /**
   * @param {Record<string, any>} owner
   * @param {string} name
   * @param {boolean} directory
   */
  const wrap = (owner, name, directory) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = function traced(/** @type {unknown[]} */ ...args) {
      record(args[0], directory);
      return original.apply(this, args);
    };
  };

  for (const name of ['readFileSync', 'readFile', 'createReadStream']) wrap(fs, name, false);
  for (const name of ['readdirSync', 'readdir', 'opendirSync', 'opendir']) wrap(fs, name, true);
  wrap(fs.promises, 'readFile', false);
  wrap(fs.promises, 'readdir', true);
  wrap(fs.promises, 'opendir', true);
  syncBuiltinESMExports();
}
