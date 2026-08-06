/**
 * Module: Tandoor API Adapter
 * Purpose: Bearer-authenticated read-only client against a self-hosted Tandoor
 *          instance. Read-only mirror only, same contract as MealieAdapter -
 *          see mealie.js and the interface documented in ./index.js.
 *
 *          Requests go through the SSRF-hardened client (server/utils/http.js)
 *          instead of global fetch(): base_url is admin-supplied and must pass
 *          the same anti-rebinding check (server/utils/ssrf.js) as WebDAV
 *          document storage and ICS subscriptions. RECIPE_PROVIDER_ALLOW_
 *          PRIVATE_NETWORK opts out (Docker-internal base_url). Separately,
 *          fetchThumbnail() pins Tandoor's upstream-supplied `image` URL to
 *          this.base's origin before ever attaching the account's Bearer
 *          token to it - Tandoor's own API response is not trusted to name
 *          an arbitrary host (CWE-918/CWE-522).
 * Dependencies: server/utils/http.js (SSRF-hardened HTTP client),
 *               server/utils/ssrf.js, ./categorize.js
 */
import { categorizeIngredient } from './categorize.js';
import { safeRequest } from '../../utils/http.js';
import { createGuardedLookup, readPrivateNetworkOptIn } from '../../utils/ssrf.js';

const REQUEST_TIMEOUT_MS = 8000;
const PAGE_SIZE = 50;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 20 * 1024 * 1024;

const ENV_ALLOW_PRIVATE_NETWORK = 'RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK';

/**
 * Opt-in: allows private/local network targets for the Tandoor base_url (e.g.
 * a Docker-internal compose hostname). Deliberately lifts the SSRF guard -
 * only set in controlled environments. Read at call time so tests can set
 * process.env before invoking.
 */
function isPrivateNetworkAllowed() {
  return readPrivateNetworkOptIn(ENV_ALLOW_PRIVATE_NETWORK);
}

/**
 * Request options including timeout and (unless opted out) the anti-rebinding
 * lookup from ssrf.js - shared by #request/testConnection/fetchThumbnail so
 * none of the three can forget the guard.
 */
function guardedRequestOptions(headers) {
  const opts = { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  if (!isPrivateNetworkAllowed()) opts.lookup = createGuardedLookup();
  return opts;
}

/**
 * Drains safeRequest()'s body stream into a size-capped Buffer (idiom from
 * document-storage.js#readResponseBuffer) - there's no res.json()/
 * res.arrayBuffer() here, safeRequest hands back a raw Readable of Buffers.
 */
async function drainBody(res, maxBytes, tooLargeMessage) {
  const chunks = [];
  let total = 0;
  for await (const value of res.body) {
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      res.body.destroy();
      throw new Error(tooLargeMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function readJson(res) {
  const buffer = await drainBody(res, MAX_RESPONSE_BYTES, 'Tandoor response exceeds the 10 MB limit.');
  return JSON.parse(buffer.toString('utf8'));
}

// Tandoor's Ingredient has an explicit no_amount flag (unlike Mealie's implicit
// "amount defaults to 0" signal) - no falsy-amount inference needed here.
function formatQuantity(amount, unit, noAmount) {
  if (noAmount || !amount) return null;
  const value = Number.isInteger(amount) ? String(amount) : String(Math.round(amount * 100) / 100);
  return unit?.name ? `${value} ${unit.name}` : value;
}

// Tandoor represents ingredient-list section dividers ("For the sauce:") as
// ingredient rows with is_header=true and no food - not a real ingredient.
function flattenIngredient(ing) {
  if (ing.is_header) return null;
  const foodName = ing.food?.name?.trim();
  const name = foodName || (ing.original_text || '').trim() || '?';
  const quantity = foodName ? formatQuantity(ing.amount, ing.unit, ing.no_amount) : null;
  const category = categorizeIngredient({ foodName });
  return { name, quantity, category };
}

export class TandoorAdapter {
  constructor(account) {
    this.provider = 'tandoor';
    this.base = String(account.base_url || '').replace(/\/+$/, '');
    this.token = account.api_token;
    this.linkBase = String(account.external_url || account.base_url || '').replace(/\/+$/, '');
  }

  headers(extra = {}) {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...extra };
  }

  async #request(path, opts = {}) {
    const reqOpts = { ...opts, ...guardedRequestOptions(this.headers(opts.headers)) };
    const res = await safeRequest(`${this.base}${path}`, reqOpts);
    if (!res.ok) {
      const err = new Error(`Tandoor request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  // DRF's DefaultPagination annotates {count, next, previous, timestamp, results};
  // /api/recipe/?page_size=1 is a cheap authenticated call that also proves the
  // token works, same role as Mealie's /api/users/self (Tandoor has no equivalent
  // "who am I" endpoint exposed without OAuth2 scopes, so this doubles as that).
  async testConnection() {
    try {
      const res = await safeRequest(`${this.base}/api/recipe/?page_size=1`, guardedRequestOptions(this.headers()));
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true, status: res.status };
    } catch (err) {
      return { ok: false, status: 0, error: err.message };
    }
  }

  async listRecipeSummaries() {
    const summaries = [];
    let path = `/api/recipe/?page=1&page_size=${PAGE_SIZE}`;
    while (path) {
      const res = await this.#request(path);
      const body = await readJson(res);
      for (const r of body.results || []) {
        summaries.push({ id: String(r.id), ref: String(r.id), updatedAt: r.updated_at });
      }
      // body.next is DRF's self-reported absolute URL, which can name a host that
      // differs from this.base (e.g. behind a reverse proxy rewriting its own
      // URLs) - parse out just the path+query and keep issuing requests against
      // this.base regardless of what host `next` claims.
      const next = body.next ? new URL(body.next, this.base) : null;
      path = next ? next.pathname + next.search : null;
    }
    return summaries;
  }

  async getRecipe(ref) {
    const res = await this.#request(`/api/recipe/${encodeURIComponent(ref)}/`);
    const detail = await readJson(res);
    const ingredients = (detail.steps || [])
      .flatMap((step) => step.ingredients || [])
      .map(flattenIngredient)
      .filter(Boolean);
    return {
      id: String(detail.id),
      updatedAt: detail.updated_at,
      // Tandoor's `image` is normally an ABSOLUTE URL (confirmed against a real
      // instance - the serializer builds it via request.build_absolute_uri()),
      // not a base_url-relative path. Persisted verbatim in provider_slug so
      // fetchThumbnail() can reconstruct the request without a re-fetch of the
      // recipe; fetchThumbnail() also tolerates a relative path in case some
      // deployment configures MEDIA_URL without a host, and refuses to follow
      // an absolute URL whose origin doesn't match this.base (see fetchThumbnail).
      slug: detail.image || null,
      title: detail.name,
      notes: detail.description || null,
      hasImage: Boolean(detail.image),
      ingredients,
    };
  }

  // Tandoor's recipe view has no group/space segment in its path, unlike Mealie -
  // linkContext is unused here, kept in the signature only to satisfy the shared
  // adapter interface.
  recipeUrl(_linkContext, { id }) {
    return `${this.linkBase}/view/recipe/${encodeURIComponent(id)}`;
  }

  async fetchThumbnail({ slug }) {
    if (!slug) {
      const err = new Error('Tandoor thumbnail request failed (no image path)');
      err.status = 404;
      throw err;
    }
    let url;
    if (/^https?:\/\//i.test(slug)) {
      // Upstream-supplied absolute URL (Tandoor's own API response, not admin
      // config) - only ever follow it if it still points at the configured
      // account's own origin. Refusing to fall back silently here is
      // deliberate: a mismatch means the persisted image path is no longer
      // trustworthy, and this request carries the account's Bearer token.
      if (new URL(slug).origin !== new URL(this.base).origin) {
        const err = new Error('Tandoor thumbnail image host does not match the configured account');
        err.status = 502;
        throw err;
      }
      url = slug;
    } else {
      url = `${this.base}${slug}`;
    }
    const res = await safeRequest(url, guardedRequestOptions(this.headers({ Accept: 'image/*' })));
    if (!res.ok) {
      const err = new Error(`Tandoor thumbnail request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const buffer = await drainBody(res, MAX_THUMBNAIL_BYTES, 'Tandoor thumbnail exceeds the 20 MB limit.');
    return { buffer, mime: res.headers.get('content-type') || 'image/jpeg' };
  }
}
