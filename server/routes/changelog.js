/**
 * Modul: Changelog
 * Zweck: Authentifizierter Proxy fuer GitHub-Releases, auf UI-relevante
 *        Versionshinweise reduziert.
 * Abhängigkeiten: express, node:fs, logger
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import { createLogger } from '../logger.js';

const log = createLogger('Changelog');

const RELEASES_URL = 'https://api.github.com/repos/ulsklyc/yuvomi/releases?per_page=30';
const CACHE_TTL_MS = 30 * 60 * 1000;
const REQUEST_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Yuvomi/1.0 (+https://github.com/ulsklyc/yuvomi)',
  'X-GitHub-Api-Version': '2022-11-28',
};

const { version: APP_VERSION } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
);

function normalizeVersion(value) {
  return String(value || '')
    .trim()
    .replace(/^release[-_\s]*/i, '')
    .replace(/^v/i, '')
    .toLowerCase();
}

function cleanMarkdownText(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNoiseLine(value) {
  return /^(assets?|downloads?|source code|full changelog|compare|all reactions?)\b/i.test(value)
    || /^https:\/\/github\.com\/.+\/compare\//i.test(value);
}

function ensureSection(sections, title) {
  const requestedTitle = title || 'Changes';
  let current = sections[sections.length - 1];
  if (!title && current) return current;
  if (!current || current.title !== requestedTitle) {
    current = { title: requestedTitle, items: [] };
    sections.push(current);
  }
  return current;
}

function parseReleaseBody(body) {
  const sections = [];
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      const title = cleanMarkdownText(heading[1]);
      if (title && !isNoiseLine(title)) ensureSection(sections, title);
      continue;
    }

    const bullet = line.match(/^(?:[-*+]|\d+\.)\s+(.+)$/);
    const text = cleanMarkdownText(bullet ? bullet[1] : line);
    if (!text || isNoiseLine(text)) continue;

    const current = ensureSection(sections);
    if (bullet || current.items.length === 0) {
      current.items.push(text);
    } else {
      current.items[current.items.length - 1] = `${current.items[current.items.length - 1]} ${text}`.trim();
    }
  }

  return sections
    .map((section) => ({
      title: section.title,
      items: section.items.filter(Boolean),
    }))
    .filter((section) => section.items.length);
}

function releaseVersion(release) {
  return String(release?.tag_name || release?.name || '').trim();
}

function normalizeRelease(release) {
  const version = releaseVersion(release);
  return {
    version,
    sections: parseReleaseBody(release?.body),
  };
}

function buildChangelogPayload(releases, currentVersion = APP_VERSION) {
  const normalized = (Array.isArray(releases) ? releases : [])
    .filter((release) => release && release.draft !== true)
    .map(normalizeRelease)
    .filter((release) => release.version);

  const currentKey = normalizeVersion(currentVersion);
  const latestVersion = normalized[0]?.version || null;
  const currentInReleases = Boolean(currentKey)
    && normalized.some((release) => normalizeVersion(release.version) === currentKey);

  return {
    current_version: currentVersion,
    latest_version: latestVersion,
    current_in_releases: currentInReleases,
    releases: normalized,
  };
}

export function buildRouter({
  fetchFn = globalThis.fetch,
  appVersion = APP_VERSION,
  now = () => Date.now(),
} = {}) {
  const router = express.Router();
  let cachedPayload = null;
  let cachedAt = 0;

  router.get('/', async (_req, res) => {
    const age = now() - cachedAt;
    if (cachedPayload && age >= 0 && age < CACHE_TTL_MS) {
      return res.json({ data: cachedPayload });
    }

    try {
      const response = await fetchFn(RELEASES_URL, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        throw new Error(`GitHub releases returned ${response.status}`);
      }

      const releases = await response.json();
      cachedPayload = buildChangelogPayload(releases, appVersion);
      cachedAt = now();
      return res.json({ data: cachedPayload });
    } catch (err) {
      log.warn('Unable to load GitHub releases:', err.message);
      if (cachedPayload) return res.json({ data: cachedPayload, stale: true });
      return res.status(502).json({ error: 'Release notes could not be loaded.', code: 502 });
    }
  });

  return router;
}

const router = buildRouter();

export default router;
export const __test = {
  normalizeVersion,
  cleanMarkdownText,
  parseReleaseBody,
  buildChangelogPayload,
};
