/**
 * Module: Module install from GitHub
 * Purpose: Turn a GitHub URL into a downloaded zipball for module-install.js -
 *          URL parsing, ref resolution via the GitHub API, and a download that
 *          only ever talks to GitHub hosts.
 * Dependencies: server/utils/http.js (safeRequest), server/utils/ssrf.js
 *
 * WHY A HOST ALLOWLIST ON TOP OF THE SSRF GUARD. The guarded lookup keeps private
 * networks out, but it would happily follow a redirect to any public host. The
 * admin typed a GitHub URL; the bytes we install must come from GitHub. Redirects
 * are therefore followed by hand (`redirect: 'manual'`) and every hop is checked
 * against the hosts GitHub actually uses for archives.
 *
 * TESTS NEVER HIT THE NETWORK: the transport is injectable, either per installer
 * (`createGithubInstaller({ request })`) or process-wide for route tests
 * (`__setGithubRequestForTests(fn)`).
 */

import { readFileSync } from 'node:fs';
import { createLogger } from '../logger.js';
import { safeRequest, resolveRedirect } from '../utils/http.js';
import { createGuardedLookup } from '../utils/ssrf.js';
import { InstallError, MAX_ZIP_BYTES, MAX_ZIP_MB, normalizeSubPath } from './module-install.js';

const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0';
  } catch {
    return '0';
  }
})();

const log = createLogger('ModuleGithub');

export const GITHUB_USER_AGENT = `yuvomi/${PKG_VERSION}`;
const API = 'https://api.github.com';
const MAX_HOPS = 5;
const TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 1024 * 1024;

// Exactly the hosts a zipball travels through: the API answers with a redirect
// to codeload. The *.githubusercontent.com hosts serve release ASSETS and raw
// user content - never a zipball - and anyone can put a file there, so they
// stay out.
export const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'codeload.github.com',
]);
const URL_HOSTS = new Set(['github.com', 'www.github.com']);

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
// Git allows more in a ref than this, but nothing a module release needs; the
// narrow set keeps the value safe to put into an API path.
const REF_RE = /^[A-Za-z0-9._\-/+]{1,200}$/;

let testRequest = null;

/** Replaces the transport for every installer created without an explicit `request`. */
export function __setGithubRequestForTests(fn) {
  testRequest = fn || null;
}

const guardedLookup = createGuardedLookup();

function badUrl(message = 'Enter a GitHub repository URL such as https://github.com/owner/repo.') {
  return new InstallError('bad_url', message);
}

function validRepoParts(owner, repo) {
  return OWNER_RE.test(owner) && REPO_RE.test(repo) && repo !== '.' && repo !== '..';
}

export function isValidRef(ref) {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) return false;
  if (ref.startsWith('/') || ref.endsWith('/') || ref.includes('//')) return false;
  return !ref.split('/').some((s) => s === '.' || s === '..');
}

/**
 * Parses the accepted URL forms. Returns
 * `{ owner, repo, kind: 'repo'|'tree'|'tag'|'latest', ref?, segments? }`.
 * Throws InstallError('bad_url') for anything else.
 */
export function parseGithubUrl(input) {
  let text = String(input ?? '').trim();
  if (!text || text.length > 2000) throw badUrl();
  // What people copy from the address bar without the scheme. Only these two
  // hosts get a scheme added; `gitlab.com/...` stays a bad URL instead of
  // turning into something the bare owner/repo form below would accept.
  if (/^(www\.)?github\.com\//i.test(text)) text = `https://${text}`;

  const bare = text.match(/^([^/\s:]+)\/([^/\s:]+?)(?:\.git)?\/?$/);
  if (bare && !text.includes('://')) {
    const [, owner, repo] = bare;
    if (!validRepoParts(owner, repo)) throw badUrl();
    return { owner, repo, kind: 'repo' };
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw badUrl();
  }
  if (url.protocol !== 'https:') throw badUrl('Only https:// GitHub URLs are accepted.');
  if (!URL_HOSTS.has(url.hostname.toLowerCase()) || url.port || url.username || url.password) {
    throw badUrl('Only repositories on github.com can be installed.');
  }

  let segments;
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw badUrl();
  }
  if (segments.length < 2) throw badUrl();
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');
  if (!validRepoParts(owner, repo)) throw badUrl();

  const rest = segments.slice(2);
  if (rest.length === 0) return { owner, repo, kind: 'repo' };
  if (rest[0] === 'tree' && rest.length >= 2) {
    const tree = rest.slice(1);
    if (tree.some((s) => s === '.' || s === '..')) throw badUrl();
    return { owner, repo, kind: 'tree', segments: tree };
  }
  if (rest[0] === 'releases' && rest[1] === 'tag' && rest.length === 3) {
    if (!isValidRef(rest[2])) throw badUrl('The release tag is not valid.');
    return { owner, repo, kind: 'tag', ref: rest[2] };
  }
  if (rest[0] === 'releases' && rest[1] === 'latest' && rest.length === 2) {
    return { owner, repo, kind: 'latest' };
  }
  throw badUrl('Use a repository, tree, release tag or releases/latest URL.');
}

function encodeRef(ref) {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function isAllowedHop(url) {
  return url.protocol === 'https:' && !url.port && ALLOWED_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase());
}

function rateLimitError(res) {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
  return new InstallError('rate_limited',
    `GitHub's rate limit for this server is used up.${resetAt ? ` Try again after ${resetAt}.` : ' Try again later.'}`,
    resetAt ? { resetAt } : {});
}

function discardBody(res) {
  try { res.body?.resume?.(); } catch { /* ignore */ }
}

async function readBodyCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.body?.destroy?.();
    throw new InstallError('too_large', `The module archive is too large. The limit is ${MAX_ZIP_MB} MB.`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) {
      res.body.destroy?.();
      throw new InstallError('too_large', `The module archive is too large. The limit is ${MAX_ZIP_MB} MB.`);
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

export function createGithubInstaller({
  request,
  maxBytes = MAX_ZIP_BYTES,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const send = (url, opts) => (request || testRequest || safeRequest)(url, opts);

  /**
   * GET with a hand-made redirect loop. Returns `{ status, body: Buffer|null }`
   * for 2xx and for the statuses in `missing` (body null); throws InstallError
   * for everything else. `readBody: false` answers a 2xx without reading the
   * body at all - for probes, where only the status matters.
   */
  async function githubGet(rawUrl, { accept, signal, limit, missing = [404], readBody = true }) {
    let url = new URL(rawUrl);
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      if (!isAllowedHop(url)) {
        throw new InstallError('github_failed', `Refused to download from ${url.host}: only GitHub hosts are allowed.`);
      }
      let res;
      try {
        res = await send(url.href, {
          method: 'GET',
          headers: { 'User-Agent': GITHUB_USER_AGENT, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
          lookup: guardedLookup,
          signal,
          redirect: 'manual',
        });
      } catch (err) {
        if (err instanceof InstallError) throw err;
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        if (timedOut) throw new InstallError('github_failed', 'GitHub did not answer in time.');
        // The raw message can name resolved addresses or the SSRF guard's
        // verdict about them; that belongs in the server log, not in a response.
        log.warn(`Request to ${url.host} failed:`, err?.message || err);
        throw new InstallError('github_failed', 'Could not reach GitHub.');
      }
      const { status } = res;
      if (status >= 300 && status < 400) {
        const location = res.headers.get('location');
        discardBody(res);
        if (!location) throw new InstallError('github_failed', `GitHub answered ${status} without a location.`);
        try {
          url = resolveRedirect(url, location);
        } catch (err) {
          throw new InstallError('github_failed', `GitHub sent an invalid redirect: ${err.message}`);
        }
        continue;
      }
      if ((status === 403 || status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
        discardBody(res);
        throw rateLimitError(res);
      }
      if (missing.includes(status)) {
        discardBody(res);
        return { status, body: null };
      }
      if (status < 200 || status >= 300) {
        discardBody(res);
        throw new InstallError('github_failed', `GitHub answered with status ${status}.`);
      }
      if (!readBody) {
        // destroy, not resume: resume() would still pull the whole body.
        try { res.body?.destroy?.(); } catch { /* ignore */ }
        return { status, body: null };
      }
      try {
        return { status, body: await readBodyCapped(res, limit) };
      } catch (err) {
        if (err instanceof InstallError) throw err;
        log.warn(`Download from ${url.host} failed:`, err?.message || err);
        throw new InstallError('github_failed', 'Download from GitHub failed.');
      }
    }
    throw new InstallError('github_failed', 'GitHub redirected too often.');
  }

  async function githubJson(apiPath, signal) {
    const res = await githubGet(`${API}${apiPath}`, { accept: 'application/vnd.github+json', signal, limit: MAX_JSON_BYTES });
    if (res.status === 404) return null;
    try {
      return JSON.parse(res.body.toString('utf8'));
    } catch {
      throw new InstallError('github_failed', 'GitHub answered with invalid JSON.');
    }
  }

  /**
   * Whether `ref` names a branch, tag or commit. Asks for the bare SHA
   * (`application/vnd.github.sha`) and never reads the answer: the default
   * media type returns the whole commit with its diff, which for a large merge
   * runs into megabytes - and a body over the JSON cap would have surfaced as
   * "archive too large" for a URL that is merely ambiguous. 422 is GitHub's
   * answer to a ref that is not even a valid name; both it and 404 mean "try
   * the next candidate".
   */
  async function refExists(repoPath, ref, signal) {
    const res = await githubGet(`${API}${repoPath}/commits/${encodeRef(ref)}`, {
      accept: 'application/vnd.github.sha',
      signal,
      limit: 0,
      missing: [404, 422],
      readBody: false,
    });
    return res.status >= 200 && res.status < 300;
  }

  async function resolveDefaultRef(repoPath, signal) {
    const latest = await githubJson(`${repoPath}/releases/latest`, signal);
    if (latest) {
      // A release exists, so it is what the admin means by "the module". Falling
      // back to the default branch here would silently install unreleased code
      // under the label of the latest release.
      if (typeof latest.tag_name === 'string' && isValidRef(latest.tag_name)) return latest.tag_name;
      throw new InstallError('ref_not_found',
        'The latest release has a tag name Yuvomi cannot use. Open the release and install from its tag or tree URL instead.');
    }
    const repo = await githubJson(repoPath, signal);
    if (!repo) throw new InstallError('repo_not_found', 'The GitHub repository was not found (or is private).');
    if (typeof repo.default_branch !== 'string' || !isValidRef(repo.default_branch)) {
      throw new InstallError('github_failed', 'GitHub did not report a default branch.');
    }
    return repo.default_branch;
  }

  /**
   * Resolves `{ owner, repo, ref, path }` from the URL plus optional overrides.
   *
   * `path` is `null` when nobody named a folder (the installer then looks for
   * the module itself) and a string otherwise - `''` included, which means
   * "the repository root" and is what the candidate list sends when the admin
   * picks the root module. An explicit `path` wins over the folder in a tree
   * URL: it comes from that very list, made from this URL's archive.
   */
  async function resolveTarget(input, { ref: refOverride, path: pathOverride, signal } = {}) {
    const parsed = parseGithubUrl(input);
    const repoPath = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;

    const explicitPath = pathOverride !== undefined && pathOverride !== null;
    let urlPath = '';

    let ref = null;
    if (refOverride !== undefined && refOverride !== null && String(refOverride).trim() !== '') {
      ref = String(refOverride).trim();
      if (!isValidRef(ref)) throw badUrl('The ref is not a valid branch, tag or commit name.');
      if (parsed.kind === 'tree') {
        // The URL's tree segments still carry the path after the ref.
        const refParts = ref.split('/');
        const head = parsed.segments.slice(0, refParts.length).join('/');
        if (head === ref) urlPath = parsed.segments.slice(refParts.length).join('/');
      }
    } else if (parsed.kind === 'tag') {
      ref = parsed.ref;
    } else if (parsed.kind === 'tree') {
      // `tree/feature/x/modules/demo`: the ref may itself contain slashes, and
      // the URL does not say where it ends. Ask GitHub, shortest first, at most
      // three segments - the same guess GitHub's own UI makes.
      const segs = parsed.segments;
      for (let i = 1; i <= Math.min(3, segs.length); i += 1) {
        const cand = segs.slice(0, i).join('/');
        if (!isValidRef(cand)) continue;
        if (await refExists(repoPath, cand, signal)) {
          ref = cand;
          urlPath = segs.slice(i).join('/');
          break;
        }
      }
      if (!ref) throw new InstallError('ref_not_found', 'The branch or tag in the URL was not found on GitHub.');
    } else {
      ref = await resolveDefaultRef(repoPath, signal);
    }

    // One normalization for both sources, so the path stored in the install
    // record (shown under Details, offered again on the next replace) has a
    // single spelling.
    let subPath = null;
    if (explicitPath || urlPath) {
      subPath = normalizeSubPath(explicitPath ? pathOverride : urlPath);
      if (subPath === null) throw badUrl('The module path is not a valid folder path.');
    }

    return { owner: parsed.owner, repo: parsed.repo, ref, path: subPath };
  }

  /**
   * Resolves and downloads. Returns `{ buffer, owner, repo, ref, path, url }`.
   * One 30 s budget covers the API calls and the download together.
   */
  async function fetchArchive(input, { ref, path } = {}) {
    const signal = AbortSignal.timeout(timeoutMs);
    const target = await resolveTarget(input, { ref, path, signal });
    const zipUrl = `${API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/zipball/${encodeRef(target.ref)}`;
    const res = await githubGet(zipUrl, { accept: 'application/vnd.github+json', signal, limit: maxBytes });
    if (res.status === 404) {
      throw new InstallError('ref_not_found', `GitHub has no archive for "${target.ref}".`);
    }
    return {
      ...target,
      buffer: res.body,
      url: `https://github.com/${target.owner}/${target.repo}`,
    };
  }

  return { resolve: resolveTarget, fetchArchive };
}
