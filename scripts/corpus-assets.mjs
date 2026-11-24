#!/usr/bin/env node
/**
 * Chooses the corpus databases for the restore drill (phase 1b, section B, F10).
 *
 * The release list is the manifest of the migration corpus: corpus.yml attaches
 * `yuvomi-<version>-corpus.db` and its `.sha256` to a release (decision E14).
 * This script reads that list and writes one line "<tag> <file>" per asset to
 * download, newest release first. It exits 1, after writing the list, when
 *   - a release carries half a pair (database or checksum alone): corpus.yml
 *     repairs a missing checksum on its next dispatch;
 *   - no release carries a corpus database;
 *   - the newest release has none although its schema version differs from the
 *     newest corpus database: corpus.yml failed or was not started for it.
 * The schema version of a tag is its highest migration, fetched from
 * raw.githubusercontent.com (no token), only when the newest release has no
 * database: the highest `./NNNN.ts` that server/migrations/index.ts imports
 * (one file per migration since phase 2 section F), and for older tags, which
 * have no such file, the highest `version: N,` in server/db.js.
 *
 * Usage:
 *   node scripts/corpus-assets.mjs <releases.jsonl> --repo <owner/name> --out <file>
 * <releases.jsonl>: one JSON object per line, `{"tag": "vX.Y.Z", "assets": ["name", ...]}`,
 * as `gh api repos/<repo>/releases --paginate --jq '.[] | ...'` writes it
 * (.github/workflows/restore-drill.yml).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} below 0 when a is older
 */
export function compareTags(a, b) {
  const pa = a.match(TAG)?.slice(1).map(Number) ?? [];
  const pb = b.match(TAG)?.slice(1).map(Number) ?? [];
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Highest migration version in the text of a server/db.js. Every tag since
 * v0.1.0 writes its migrations as `    version: N,` (checked against all 915
 * tags on 2026-11-11).
 * @param {string} source
 */
export function schemaFromDbSource(source) {
  const versions = [...source.matchAll(/^ {4}version: (\d+),$/gm)].map((m) => Number(m[1]));
  if (versions.length === 0) throw new Error('no migration found in server/db.js');
  return Math.max(...versions);
}

/**
 * Highest migration version in the text of a server/migrations/index.ts: every
 * migration is imported as `import mNNNN from './NNNN.ts';`, and the file name
 * is its version (test:migrations-append-only holds both).
 * @param {string} source
 */
export function schemaFromMigrationIndex(source) {
  const versions = [...source.matchAll(/^import m(\d{4}) from '\.\/(\d{4})\.ts';$/gm)]
    .filter((m) => m[1] === m[2]).map((m) => Number(m[1]));
  if (versions.length === 0) throw new Error('no migration found in server/migrations/index.ts');
  return Math.max(...versions);
}

/**
 * @typedef {{ tag: string, assets: string[] }} Release
 * @typedef {{ tag: string, files: string[] }} CorpusEntry
 * @typedef {{ corpus: CorpusEntry[], incomplete: string[], newestRelease: string | null }} Plan
 */

/**
 * @param {Release[]} releases published releases
 * @returns {Plan}
 */
export function planCorpus(releases) {
  const tagged = releases.filter((r) => TAG.test(r.tag)).sort((a, b) => compareTags(b.tag, a.tag));
  /** @type {CorpusEntry[]} */
  const corpus = [];
  /** @type {string[]} */
  const incomplete = [];
  for (const { tag, assets } of tagged) {
    const db = `yuvomi-${tag.slice(1)}-corpus.db`;
    const sum = `${db}.sha256`;
    const hasDb = assets.includes(db);
    const hasSum = assets.includes(sum);
    if (hasDb && hasSum) corpus.push({ tag, files: [db, sum] });
    else if (hasDb) incomplete.push(`${tag}: ${sum} missing`);
    else if (hasSum) incomplete.push(`${tag}: ${db} missing`);
  }
  return { corpus, incomplete, newestRelease: tagged[0]?.tag ?? null };
}

/**
 * Null when the corpus is complete, otherwise the reason it is not.
 * @param {Plan} plan
 * @param {(tag: string) => Promise<number>} schemaOf
 * @returns {Promise<string | null>}
 */
export async function checkGap(plan, schemaOf) {
  if (plan.incomplete.length > 0) {
    return `half a corpus pair (run corpus.yml again for the tag): ${plan.incomplete.join('; ')}`;
  }
  const newestCorpus = plan.corpus[0];
  if (!newestCorpus) return 'no corpus database on any release';
  const release = plan.newestRelease;
  if (!release || release === newestCorpus.tag) return null;
  const [releaseSchema, corpusSchema] = [await schemaOf(release), await schemaOf(newestCorpus.tag)];
  if (releaseSchema === corpusSchema) return null;
  return `${release} has schema ${releaseSchema} but no corpus database; the newest corpus database is `
    + `${newestCorpus.tag} at schema ${corpusSchema} (gh workflow run corpus.yml --ref main -f tag=${release})`;
}

/**
 * Schema version of one tree, in whichever layout it has: server/migrations/index.ts
 * when the tree has one, otherwise server/db.js.
 * @param {(path: string) => Promise<string | null>} read  file text, or null when the tree has no such file
 * @returns {Promise<number>}
 */
export async function schemaOfTree(read) {
  const index = await read('server/migrations/index.ts');
  if (index !== null) return schemaFromMigrationIndex(index);
  const db = await read('server/db.js');
  if (db === null) throw new Error('neither server/migrations/index.ts nor server/db.js in this tree');
  return schemaFromDbSource(db);
}

/**
 * @param {string} repo owner/name
 * @returns {(tag: string) => Promise<number>}
 */
function schemaFromGitHub(repo) {
  return (tag) => schemaOfTree(async (path) => {
    const url = `https://raw.githubusercontent.com/${repo}/${tag}/${path}`;
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.text();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (/** @type {string} */ name) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args.splice(at, 2)[1];
  };
  const repo = opt('--repo');
  const out = opt('--out');
  const [file] = args;
  if (!file || !repo || !out || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error('usage: node scripts/corpus-assets.mjs <releases.jsonl> --repo <owner/name> --out <file>');
    process.exit(2);
  }
  /** @type {Release[]} */
  const releases = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const plan = planCorpus(releases);
  writeFileSync(out, plan.corpus.flatMap((c) => c.files.map((f) => `${c.tag} ${f}\n`)).join(''));
  console.log(`${plan.corpus.length} corpus databases: ${plan.corpus.map((c) => c.tag).join(', ') || 'none'}`);
  const gap = await checkGap(plan, schemaFromGitHub(repo));
  if (gap) {
    console.error(`::error::${gap}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
