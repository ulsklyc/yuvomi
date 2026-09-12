/**
 * Module: Waste collection - automatic ICS URL sources (#1063 Phase 7)
 * Purpose: fetch a subscribed ICS URL (SSRF-guarded, conditional GET, size-
 *          capped, timed out), decide whether the result can auto-commit
 *          through the existing file-import path unchanged, and record the
 *          scheduling/backoff state a source needs between attempts.
 *          Never parses ICS independently - waste-import.js's
 *          buildImportPreview (via waste-store.js#previewImport) remains the
 *          one place preview/commit logic lives, for both source kinds.
 * Dependencies: server/utils/ssrf.js (central SSRF guard), server/utils/http.js
 *               (safe HTTP client), and ics-subscription.js#checkSSRF itself
 *               (parameterized by opt-in rather than copied) - this file
 *               does not reimplement or duplicate that protection.
 */

import { createLogger } from '../logger.js';
import { readPrivateNetworkOptIn, createGuardedLookup } from '../utils/ssrf.js';
import { safeRequest } from '../utils/http.js';
import { checkSSRF as checkSSRFWithOptIn } from './ics-subscription.js';
import { url as validateUrl, num } from '../middleware/validate.js';
import { MAX_ICS_BYTES } from './waste-import.js';
import * as store from './waste-store.js';
import { WasteValidationError, WasteNotFoundError, WasteConflictError } from './waste-store.js';

const log = createLogger('Waste');

const FETCH_TIMEOUT_MS = 15_000;
const ENV_ALLOW_PRIVATE_NETWORK = 'WASTE_SOURCE_ALLOW_PRIVATE_NETWORK';

// A subscribed municipal waste calendar changes rarely (annual re-publish at
// most); bound the cadence between "at most every hour" and "at least once a
// month" so a mistyped value can't hammer a remote server nor go silently
// stale for a year (invariant #6, "needs refresh" still watches for a future
// pickup independent of this).
export const MIN_REFRESH_INTERVAL_MINUTES = 60;
export const MAX_REFRESH_INTERVAL_MINUTES = 43_200;
export const DEFAULT_REFRESH_INTERVAL_MINUTES = 1440;

const MAX_BACKOFF_MINUTES = 24 * 60;

function isPrivateNetworkAllowed() {
  return readPrivateNetworkOptIn(ENV_ALLOW_PRIVATE_NETWORK);
}

/** Validates a candidate subscription URL: http(s) only (opt-in-gated), bounded length. Throws WasteValidationError. */
export function validateSourceUrl(raw) {
  const v = validateUrl(raw, 'url');
  if (v.error) throw new WasteValidationError([v.error]);
  if (!v.value) throw new WasteValidationError(['url is required.']);
  const allowPrivate = isPrivateNetworkAllowed();
  if (!allowPrivate && new URL(v.value).protocol !== 'https:') {
    throw new WasteValidationError(['url must be an https:// URL.']);
  }
  return v.value;
}

export function validateRefreshIntervalMinutes(raw) {
  const v = num(raw, 'refresh_interval_minutes', { required: false });
  if (v.error) throw new WasteValidationError([v.error]);
  const minutes = v.value ?? DEFAULT_REFRESH_INTERVAL_MINUTES;
  if (!Number.isInteger(minutes) || minutes < MIN_REFRESH_INTERVAL_MINUTES || minutes > MAX_REFRESH_INTERVAL_MINUTES) {
    throw new WasteValidationError([
      `refresh_interval_minutes must be an integer between ${MIN_REFRESH_INTERVAL_MINUTES} and ${MAX_REFRESH_INTERVAL_MINUTES}.`,
    ]);
  }
  return minutes;
}

/**
 * SSRF pre-check against DNS-resolved addresses - the actual check lives once
 * in ics-subscription.js#checkSSRF; this only supplies WASTE's own opt-in
 * instead of keeping a second copy of the whole function. Literal IPs are
 * checked directly since resolve4/6 do not resolve them. The real request
 * additionally validates at connect time via createGuardedLookup below,
 * which also defeats DNS-rebinding between this check and the request.
 */
function checkSSRF(urlStr) {
  return checkSSRFWithOptIn(urlStr, isPrivateNetworkAllowed);
}

/**
 * Fetches raw ICS text (never parses it - that stays buildImportPreview's
 * job, so both source kinds share one parser entry point). Conditional GET
 * via etag/lastModified; `{ notModified: true }` short-circuits a 304.
 */
export async function fetchIcsText(rawUrl, { etag = null, lastModified = null } = {}) {
  const url = validateSourceUrl(rawUrl);
  await checkSSRF(url);

  const headers = {};
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const reqOpts = { headers, signal: controller.signal };
  if (!isPrivateNetworkAllowed()) reqOpts.lookup = createGuardedLookup();

  let res;
  try {
    res = await safeRequest(url, reqOpts);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const cl = parseInt(res.headers.get('content-length') || '0', 10);
  if (cl > MAX_ICS_BYTES) throw new Error(`ICS file exceeds the ${Math.round(MAX_ICS_BYTES / (1024 * 1024))} MB limit.`);

  // Buffer chunks and decode ONCE at the end, not per chunk: a multi-byte
  // UTF-8 character split across a chunk boundary would otherwise decode as
  // two U+FFFD replacement characters mid-string, silently corrupting a
  // label like "Grünschnitt" and breaking its remembered-mapping match.
  const chunks = [];
  let received = 0;
  for await (const chunk of res.body) {
    received += chunk.length;
    if (received > MAX_ICS_BYTES) throw new Error(`ICS file exceeds the ${Math.round(MAX_ICS_BYTES / (1024 * 1024))} MB limit.`);
    chunks.push(chunk);
  }

  return {
    notModified: false,
    text: Buffer.concat(chunks).toString('utf8'),
    etag: res.headers.get('etag') || null,
    lastModified: res.headers.get('last-modified') || null,
  };
}

/** Every label needs a REMEMBERED decision (never a bare suggestion) to auto-commit; an unresolved blocking diagnostic also blocks auto-commit - neither may be decided by a machine. */
function buildAutoMappingDecisions(preview) {
  const decisions = [];
  for (const label of preview.labels) {
    if (label.remembered_ignored) decisions.push({ normalized_label: label.normalized_label, ignored: true });
    else if (label.remembered_type_id != null) decisions.push({ normalized_label: label.normalized_label, type_id: label.remembered_type_id });
    else return null; // an unmapped label - cannot auto-decide
  }
  const unresolvedBlocking = preview.diagnostics.some((diag) => diag.severity === 'blocking');
  if (unresolvedBlocking) return null; // auto-refresh never auto-skips a blocking diagnostic
  return decisions;
}

function backoffMinutes(consecutiveFailures) {
  return Math.min(MAX_BACKOFF_MINUTES, 15 * 2 ** Math.min(consecutiveFailures, 10));
}

/**
 * Die Quellen, die GERADE aktualisiert werden - je Quelle, nicht je Scan.
 *
 * WARUM UEBERHAUPT: `refreshUrlSource` hat zwei Aufrufer, den Scheduler und
 * den Handknopf (routes/waste/sources.js#POST /:id/refresh), und der Riegel im
 * Scheduler (`scanRunning`) kennt nur SICH SELBST. Ein Handrefresh waehrend
 * eines laufenden Scans lief also parallel auf derselben Quelle: beide holen,
 * beide werten aus, beide schreiben `recordUrlSourceAttempt`. Wessen Schreiben
 * zuletzt landet, entscheidet - und wenn das der needs_mapping-Zweig ist,
 * steht die Quelle danach auf `needs_mapping = 1, next_attempt_at = NULL` und
 * faellt damit dauerhaft aus `listDueUrlSources` heraus, obwohl der andere
 * Lauf gerade erfolgreich uebernommen hat. Eine Quelle, die sich nie wieder
 * von selbst meldet, ist genau die Art stiller Fehler, die diese App durchgaengig
 * vermeidet: jede Grenze/jeder Fehlerfall bekommt eine ehrliche Meldung statt
 * eines plausibel aussehenden, aber falschen stillen Zustands.
 *
 * WARUM IN-PROCESS UND NICHT IN DER DATENBANK: Diese App laeuft als EIN
 * Node-Prozess (`npm start` startet genau einen, kein cluster/pm2-fork), und
 * beide Aufrufer sitzen darin. Ein Claim-Feld in `waste_sources` waere eine
 * Migration fuer einen Prozess-Nachbarn, den es nicht gibt - und braechte das
 * eigene Problem verwaister Claims nach einem Absturz mit. Wer den Server
 * einmal mehrfach startet, holt das hier nach; bis dahin ist das Set die
 * ehrliche Entsprechung der tatsaechlichen Topologie.
 */
const inFlight = new Set();

/**
 * Haelt eine fehlgeschlagene Auswertung im selben Zustand fest wie einen
 * fehlgeschlagenen ABRUF - und gibt den Fehler danach weiter.
 *
 * Vorher lagen `previewImport`/`commitImport` blank im Ablauf: eine Datei, die
 * sich zwar laden, aber nicht auswerten liess (kaputtes ICS, ueberschrittene
 * Label-/Instanz-Grenze, eine Zuordnung auf einen inzwischen geloeschten Typ),
 * flog aus `refreshUrlSource` heraus, der Scheduler protokollierte sie und
 * versuchte es in fuenf Minuten unveraendert erneut - ohne Backoff, ohne
 * `last_error`, ohne `consecutive_failures`. Die Oberflaeche zeigte eine
 * gesunde Quelle, die in Wahrheit alle fuenf Minuten gegen dieselbe Wand lief.
 *
 * WEITERGEWORFEN statt in `outcome: 'error'` verwandelt: der Handknopf soll
 * die echte Meldung sehen (400/409 ueber wasteErrorResponse), nicht ein
 * freundliches "hat nicht geklappt". Der Scheduler faengt sie ohnehin je
 * Quelle ab. Der Zustand ist zu diesem Zeitpunkt schon geschrieben, der
 * Backoff greift also unabhaengig davon, wer den Fehler am Ende liest.
 */
function recordFailureAndRethrow(d, source, err) {
  const failures = (source.consecutive_failures ?? 0) + 1;
  try {
    store.recordUrlSourceAttempt(d, source.id, {
      errorMessage: err?.message || 'Import failed.',
      consecutiveFailures: failures,
      nextAttemptAt: minutesFromNow(backoffMinutes(failures)),
    });
  } catch (recordErr) {
    // Der urspruengliche Fehler ist der interessante; ein Fehlschlag beim
    // Protokollieren darf ihn nicht verdecken.
    log.error(`Waste source ${source.id}: could not record failure state -`, recordErr?.message || recordErr);
  }
  log.warn(`Waste source ${source.id} (${source.name}): import failed - ${err?.message || err}`);
  throw err;
}

export function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * Performs one fetch attempt against a URL source and applies its outcome:
 *   - unchanged (304)      -> reset failures, reschedule at the normal cadence
 *   - fetch/network failure -> record last_error, back off (failure preserves
 *                              the last good snapshot - nothing else is touched)
 *   - fully mapped          -> commit via the same commitImport() every file
 *                              re-import uses, reschedule at the normal cadence
 *   - new/unmapped label(s)
 *     or an unresolved
 *     blocking diagnostic   -> needs_mapping=1, scheduler skips this source
 *                              until a reviewed manual refresh resolves it
 *
 * @returns {{source: object, outcome: 'unchanged'|'error'|'committed'|'needs_mapping', diff?: object, preview?: object}}
 */
export async function refreshUrlSource(d, sourceId) {
  if (inFlight.has(sourceId)) {
    throw new WasteConflictError('This source is already being refreshed; try again in a moment.');
  }
  inFlight.add(sourceId);
  try {
    return await refreshUrlSourceUnclaimed(d, sourceId);
  } finally {
    inFlight.delete(sourceId);
  }
}

async function refreshUrlSourceUnclaimed(d, sourceId) {
  const source = store.getSource(d, sourceId);
  if (!source) throw new WasteNotFoundError('Waste import source not found.');
  if (source.kind !== 'url') throw new WasteValidationError(['This source is not a URL subscription.']);

  let fetched;
  try {
    fetched = await fetchIcsText(source.url, { etag: source.etag, lastModified: source.last_modified });
  } catch (err) {
    const failures = (source.consecutive_failures ?? 0) + 1;
    const updated = store.recordUrlSourceAttempt(d, sourceId, {
      errorMessage: err.message || 'Fetch failed.',
      consecutiveFailures: failures,
      nextAttemptAt: minutesFromNow(backoffMinutes(failures)),
    });
    log.warn(`Waste source ${sourceId} (${source.name}): fetch failed - ${err.message}`);
    return { source: updated, outcome: 'error' };
  }

  if (fetched.notModified) {
    const updated = store.recordUrlSourceAttempt(d, sourceId, {
      errorMessage: null,
      consecutiveFailures: 0,
      nextAttemptAt: minutesFromNow(source.refresh_interval_minutes),
    });
    return { source: updated, outcome: 'unchanged' };
  }

  let preview;
  let mappingDecisions;
  try {
    preview = store.previewImport(d, { sourceId, icsText: fetched.text });
    mappingDecisions = buildAutoMappingDecisions(preview);
  } catch (err) {
    return recordFailureAndRethrow(d, source, err);
  }

  if (mappingDecisions === null) {
    // Content changed but cannot auto-commit - do NOT persist the new
    // etag/last_modified: the next attempt (auto or manual) must re-fetch
    // the same full content again, not silently treat it as already seen.
    const updated = store.recordUrlSourceAttempt(d, sourceId, {
      needsMapping: true,
      errorMessage: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
    });
    return { source: updated, outcome: 'needs_mapping', preview };
  }

  let result;
  try {
    result = store.commitImport(d, {
      sourceId,
      name: source.name,
      icsText: fetched.text,
      mappingDecisions,
      skipEventKeys: [],
      expectedVersion: source.version,
      previewDigest: preview.digest,
      userId: source.created_by ?? null,
    });
  } catch (err) {
    return recordFailureAndRethrow(d, source, err);
  }
  const updated = store.recordUrlSourceAttempt(d, sourceId, {
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    needsMapping: false,
    errorMessage: null,
    consecutiveFailures: 0,
    nextAttemptAt: minutesFromNow(source.refresh_interval_minutes),
  });
  return { source: updated, outcome: 'committed', diff: result.diff };
}

export const __test = { buildAutoMappingDecisions, backoffMinutes, checkSSRF };

/**
 * Creates the source row, then performs its first fetch synchronously (same
 * UX as a fresh file import - the caller sees the result immediately, not
 * after the next scheduler tick).
 *
 * A NETWORK-fetch failure does not fail creation: refreshUrlSource returns
 * `{outcome: 'error'}` normally in that case, the row is created either way,
 * and the scheduler retries per its own backoff. A PARSE or COMMIT failure is
 * different - refreshUrlSource's recordFailureAndRethrow re-throws those, so
 * this whole call rejects and the caller's create request fails outright. The
 * placeholder row would otherwise survive that rejection as an orphan: it
 * exists in the household's source list, but the request that made it
 * reported failure and the caller has no reference to retry or delete it. It
 * is removed here on that path only - a graceful `outcome: 'error'` still
 * keeps the row, exactly as documented above.
 */
export async function createUrlSource(d, { name, url: rawUrl, refreshIntervalMinutes, userId }) {
  const validatedUrl = validateSourceUrl(rawUrl);
  const validatedInterval = validateRefreshIntervalMinutes(refreshIntervalMinutes);
  const source = store.createUrlSourcePlaceholder(d, {
    name, url: validatedUrl, refreshIntervalMinutes: validatedInterval, userId,
  });
  try {
    return await refreshUrlSource(d, source.id);
  } catch (err) {
    try {
      store.deleteSource(d, source.id);
    } catch (cleanupErr) {
      log.error(`Waste source ${source.id}: could not remove orphaned placeholder after a failed first fetch -`, cleanupErr?.message || cleanupErr);
    }
    throw err;
  }
}
