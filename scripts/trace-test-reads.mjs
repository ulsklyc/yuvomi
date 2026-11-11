/**
 * Module: test inventory - what the suites read at run time
 * Purpose: scripts/test-inventory.mjs reads the suites as text and cannot follow a path
 *          that only exists at run time (a walk over the routers, an import graph).
 *          This preload records what test code really reads under public/ and server/
 *          while the chain runs, so the inventory can be checked against it.
 * Run: TEXT_READER_TRACE=<file> NODE_OPTIONS="--import file://<repo>/scripts/trace-test-reads.mjs" \
 *        npm run test-parallel
 *      The preload is named as a file: URL. A bare absolute path would be taken for an
 *      app path by test/test-browser-loader.mjs, and every suite that runs through that
 *      loader would fail before its first test.
 *      node scripts/test-inventory.mjs --trace <file>     (compares with the inventory)
 * Without TEXT_READER_TRACE the module does nothing.
 *
 * WHAT COUNTS. A call of readFileSync, readFile, readdirSync, readdir, opendirSync or
 * createReadStream (and their promise forms) whose path lies under public/ or server/,
 * made by a file under test/, in a process that runs one suite (test/test-*.js). App
 * code that reads its own files while a suite runs it is not a read by the suite, and
 * the browser loader that loads app modules for a suite is not one either.
 * One line per suite and path: `<suite>\t<path>`, a directory with "/" at the end.
 */

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.env.TEXT_READER_TRACE;
const suite = /(?:^|[\\/])test[\\/](test-[^\\/]+\.js)$/.exec(process.argv[1] ?? '')?.[1];

if (out && suite) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const append = fs.appendFileSync.bind(fs);
  /** @type {Set<string>} */
  const seen = new Set();

  /**
   * @param {unknown} target what the read call was given
   * @param {boolean} directory
   */
  const record = (target, directory) => {
    /** @type {string} */
    let file;
    try {
      if (target instanceof URL) file = fileURLToPath(target);
      else if (typeof target === 'string' || Buffer.isBuffer(target)) file = resolve(String(target));
      else return;
    } catch { return; }
    if (!file.startsWith(root)) return;
    const rel = file.slice(root.length).split(sep).join('/').replace(/\/+$/, '') + (directory ? '/' : '');
    if (!/^(?:public|server)\//.test(rel) || seen.has(rel)) return;
    // The caller is the first frame that is neither Node nor this file.
    const frame = String(new Error().stack).split('\n').slice(1)
      .find((line) => !line.includes('node:') && !line.includes('trace-test-reads.mjs'));
    const from = /((?:file:\/\/)?\/[^():]+):\d+:\d+/.exec(frame ?? '')?.[1] ?? '';
    const caller = from.startsWith('file://') ? fileURLToPath(from) : from;
    if (!caller.startsWith(resolve(root, 'test') + sep) || caller.endsWith('test-browser-loader.mjs')) return;
    seen.add(rel);
    append(out, `${suite}\t${rel}\n`);
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
