#!/usr/bin/env node
// Fetches the current GitHub star count and writes it into every element with a
// [data-gh-stars] attribute in docs/index.html and docs/install.html.
//
// This runs at release time, by hand - NOT in the visitor's browser. The landing
// page therefore makes no request to api.github.com when someone opens it, so no
// visitor data is transmitted to a third country (USA).
// See docs/datenschutz.html and docs/legal-audit/clean/F-003-github-api-call-fix.md.
//
// Step 5 of docs/RELEASING.md calls it and stages BOTH files it writes. A weekly
// workflow used to do this until 7 September 2026; it was dropped because a push
// from Actions cannot satisfy the status checks main requires.
//
// Usage: node scripts/update-gh-stars.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = 'ulsklyc/yuvomi';
const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const HTML_FILES = [resolve(DOCS, 'index.html'), resolve(DOCS, 'install.html')];

function fmtStars(n) {
  if (n >= 1000) return '★ ' + Math.round(n / 100) / 10 + 'k';
  return '★ ' + n;
}

// Each marker keeps its [data-gh-stars] attribute so the script is idempotent —
// only the inner text of the span changes on every run.
// Not every marker exists on every page, so each one records which file it
// belongs to; a marker that is missing from its own file is still an error.
const patterns = (stars) => [
  {
    file: 'index.html',
    re: /(<span id="gh-stars-nav" data-gh-stars>)[^<]*(<\/span>)/,
    replacement: `$1&nbsp;${stars}$2`,
  },
  {
    file: 'index.html',
    re: /(<span id="gh-stars-proof" data-gh-stars>)[^<]*(<\/span>)/,
    // No trailing " ·": the proof bar draws its separators in CSS (.proof .pi)
    // so that none is left dangling at the end of a wrapped line.
    replacement: `$1${stars}$2`,
  },
  {
    file: 'index.html',
    re: /(<span id="gh-stars-footer" data-gh-stars>)[^<]*(<\/span>)/,
    replacement: `$1${stars} · $2`,
  },
  {
    file: 'install.html',
    re: /(<span id="gh-stars-install" data-gh-stars>)[^<]*(<\/span>)/,
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

  for (const file of HTML_FILES) {
    const name = file.slice(DOCS.length + 1);
    let html = await readFile(file, 'utf8');
    for (const { file: owner, re, replacement } of patterns(stars)) {
      if (owner !== name) continue;
      if (!re.test(html)) {
        throw new Error(`Marker not found in docs/${name}: ${re}`);
      }
      html = html.replace(re, replacement);
    }
    await writeFile(file, html, 'utf8');
    console.log(`Updated GitHub stars in docs/${name}: ${stars}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
