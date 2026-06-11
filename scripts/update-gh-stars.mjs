#!/usr/bin/env node
// Fetches the current GitHub star count and writes it into every element with a
// [data-gh-stars] attribute in docs/index.html.
//
// This runs at build/release time (locally or in CI) — NOT in the visitor's
// browser. The landing page therefore makes no request to api.github.com when
// someone opens it, so no visitor data is transmitted to a third country (USA).
// See docs/datenschutz.html and docs/legal-audit/clean/F-003-github-api-call-fix.md.
//
// Usage: node scripts/update-gh-stars.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = 'ulsklyc/yuvomi';
const HTML_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'index.html');

function fmtStars(n) {
  if (n >= 1000) return '★ ' + Math.round(n / 100) / 10 + 'k';
  return '★ ' + n;
}

// Each marker keeps its [data-gh-stars] attribute so the script is idempotent —
// only the inner text of the span changes on every run.
const patterns = (stars) => [
  {
    re: /(<span id="gh-stars-nav" data-gh-stars>)[^<]*(<\/span>)/,
    replacement: `$1&nbsp;${stars}$2`,
  },
  {
    re: /(<span id="gh-stars-proof" data-gh-stars>)[^<]*(<\/span>)/,
    replacement: `$1${stars} ·$2`,
  },
  {
    re: /(<span id="gh-stars-footer" data-gh-stars>)[^<]*(<\/span>)/,
    replacement: `$1${stars} · $2`,
  },
];

async function main() {
  const res = await fetch(`https://api.github.com/repos/${REPO}`, {
    headers: { 'User-Agent': 'yuvomi-build-script' },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  if (typeof data.stargazers_count !== 'number') {
    throw new Error('Unexpected GitHub API response: stargazers_count missing');
  }
  const stars = fmtStars(data.stargazers_count);

  let html = await readFile(HTML_FILE, 'utf8');
  for (const { re, replacement } of patterns(stars)) {
    if (!re.test(html)) {
      throw new Error(`Marker not found in docs/index.html: ${re}`);
    }
    html = html.replace(re, replacement);
  }

  await writeFile(HTML_FILE, html, 'utf8');
  console.log(`Updated GitHub stars in docs/index.html: ${stars}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
