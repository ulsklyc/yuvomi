/**
 * Modul: Rezept-Provider - Fall eines gescheiterten Abrufs
 * Zweck: Aus dem, was ein Adapter wirft oder als Verbindungstest meldet, der
 *        Fall (#1909): eine kleine feste Menge `reason`s, dazu hoechstens der
 *        Status als Zahl. Die Konto-Karte in Einstellungen > Kueche sagt den
 *        Satz dazu in der Sprache der App (public/utils/friendly-error.js);
 *        `last_error` behaelt den rohen Text fuer Log und API.
 *
 *        Geurteilt wird nach der KLASSE eines Fehlers (Status, Fehlercode des
 *        Netzes, Fehlertyp), nie nach dem Wortlaut seiner Meldung - der gehoert
 *        Node, dem Adapter oder dem Anbieter und aendert sich ohne Ansage.
 *        Was hier nicht einzuordnen ist, bekommt keinen Fall (null): die Karte
 *        sagt dann den allgemeinen Satz.
 * Abhaengigkeiten: keine
 */

/**
 * Eine Antwort des Anbieters, die sich nicht lesen laesst, obwohl sie mit
 * Erfolg kam: zu gross. Eine eigene Klasse, damit `classifyProviderFailure`
 * den Fall erkennt, ohne die Meldung zu lesen. Unlesbares JSON wirft
 * JSON.parse selbst als SyntaxError.
 */
export class ProviderResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderResponseError';
  }
}

// Kein Rechner unter dieser Adresse, oder er nimmt nicht an. Das Ende einer
// Wartezeit (ETIMEDOUT am Verbindungsaufbau) steht bei `timeout`.
const UNREACHABLE_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED',
  'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'EPROTO',
]);

// Die Zertifikatspruefung von TLS (node:tls), etwa ein selbst signiertes
// Zertifikat im Heimnetz - der haeufigste Fall, den eine Adresse mit https://
// sonst als "nicht erreichbar" meldete.
const CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// Der Anbieter kennt den Token nicht (401) oder laesst ihn nicht lesen (403).
const AUTH_STATUSES = new Set([401, 403]);

/** Der Fall eines HTTP-Status, den der Anbieter statt eines Erfolgs schickte. */
function statusFailure(status) {
  if (AUTH_STATUSES.has(status)) return { reason: 'recipe_providers_sync_auth_failed' };
  if (status === 404) return { reason: 'recipe_providers_sync_wrong_url' };
  return { reason: 'recipe_providers_sync_http_status', params: { status } };
}

function isTimeout(err) {
  if (err?.name === 'TimeoutError' || err?.code === 'ETIMEDOUT') return true;
  // node:http meldet den Ablauf von AbortSignal.timeout() als AbortError mit
  // dem TimeoutError als Ursache.
  return err?.name === 'AbortError' && err?.cause?.name === 'TimeoutError';
}

/**
 * Der Fall eines gescheiterten Abrufs, oder null, wenn er sich nicht einordnen
 * laesst.
 *
 * @param {unknown} err - was ein Adapter warf (Fehler mit `status` aus einer
 *   Antwort ohne Erfolg, ein Netzfehler, ein SyntaxError) oder ein Objekt mit
 *   einem `status` (der Verbindungstest)
 * @returns {{ reason: string, params?: { status: number } } | null}
 */
export function classifyProviderFailure(err) {
  if (!err || typeof err !== 'object') return null;
  // Die Ablehnung des Lookup-Hooks (server/utils/ssrf.js, BlockedAddressError):
  // derselbe Fall, den die Route schon beim Anlegen nennt.
  if (err.name === 'BlockedAddressError') return { reason: 'recipe_providers_private_network' };
  const { status } = err;
  if (Number.isInteger(status) && status > 0 && (status < 200 || status >= 300)) return statusFailure(status);
  if (isTimeout(err)) return { reason: 'recipe_providers_sync_timeout' };
  if (typeof err.code === 'string' && CERTIFICATE_CODES.has(err.code)) return { reason: 'recipe_providers_sync_certificate' };
  if (typeof err.code === 'string' && UNREACHABLE_CODES.has(err.code)) return { reason: 'recipe_providers_sync_unreachable' };
  if (err instanceof SyntaxError || err instanceof ProviderResponseError) return { reason: 'recipe_providers_sync_bad_response' };
  return null;
}

/**
 * Der Fall eines Verbindungstests (`adapter.testConnection()`), der nicht ok
 * war. Ein Adapter, der den Fall seines Wurfs schon kennt, gibt ihn als
 * `reason`/`params` mit; sonst entscheidet der Status.
 *
 * @param {{ ok: boolean, status?: number, reason?: string|null, params?: object }} probe
 * @returns {{ reason: string, params?: object } | null}
 */
export function classifyProbe(probe) {
  if (!probe || probe.ok) return null;
  if (probe.reason !== undefined) {
    if (typeof probe.reason !== 'string') return null;
    return { reason: probe.reason, ...(probe.params && { params: probe.params }) };
  }
  return classifyProviderFailure({ status: probe.status });
}

/**
 * Was ein Adapter in `testConnection()` neben `error` mitgibt, wenn der Abruf
 * warf: `reason` (null, wenn sich der Wurf nicht einordnen laesst) und
 * hoechstens `params`. So geht der Fall nicht mit dem Fehlerobjekt verloren -
 * der Verbindungstest gibt nur dessen Meldung weiter.
 *
 * @param {unknown} err
 * @returns {{ reason: string|null, params?: object }}
 */
export function probeFailure(err) {
  const failure = classifyProviderFailure(err);
  return { reason: failure?.reason ?? null, ...(failure?.params && { params: failure.params }) };
}
