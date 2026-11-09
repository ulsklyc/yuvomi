/**
 * Modul: Sicherer, node-nativer HTTP-Client
 * Zweck: Schlanker Ersatz für node-fetch auf Basis von node:http/https .request.
 *        Liefert eine fetch-ähnliche Response (status, ok, headers.get(name), body
 *        als node Readable von Buffers) und trägt den SSRF-Schutz über einen
 *        request-level `lookup` (Anti-Rebinding, aus server/utils/ssrf.js).
 *
 *        Warum nicht natives global fetch? Es kennt keine Möglichkeit, den
 *        DNS-Lookup pro Verbindung zu validieren (kein `agent`/`lookup`), und sein
 *        Body ist ein WHATWG-Stream aus Uint8Array — `chunk.toString()` läge dort
 *        daneben. node:http gibt Buffers, unterstützt `lookup` nativ und erlaubt
 *        exakt verhaltensgleiche Migration der bisherigen node-fetch-Aufrufe.
 *
 * Abhängigkeiten: node:http, node:https, server/utils/ssrf.js (nur der Typ-Import
 *                 des Lookups; die Aufrufer liefern ihn).
 */

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { isIP } from 'node:net';

const DEFAULT_MAX_REDIRECTS = 5;

// Ein Redirect fuehrt die Anfrage woanders hin, als der Aufrufer geprueft hat.
// Der DNS-Hook (`lookup`) reist mit und haelt private Netze weiter draußen, aber
// zwei Dinge kann er nicht sehen, weil sie nicht an der IP haengen:
//
//   1. Das Schema. `new URL(location, url)` nimmt jedes an; ohne Pruefung faellt
//      alles ausser https: auf den http-Transport - ein `file:`-Redirect wuerde
//      als HTTP-Anfrage an den Host `file` enden, und ein https: → http: als
//      stilles Abstreifen von TLS. Der Aufrufer hat https gewaehlt, also bleibt
//      es dabei; ein Downgrade ist ein Fehler, keine Weiterleitung.
//   2. Wer die Header zu sehen bekommt. `headers` traegt bei CalDAV/WebDAV/DMS
//      ein Authorization mit Klartext-Passwort. Bis hier reichte safeRequest es
//      unveraendert ans Redirect-Ziel weiter: ein boesartiger oder uebernommener
//      Kalenderserver bekam die Zugangsdaten seines Opfers mit einem einzigen
//      302 auf einen fremden Host. Browser und curl entfernen sie deshalb beim
//      Origin-Wechsel - hier jetzt auch.
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

// Header, die nur dem urspruenglichen Origin gelten. Beim Origin-Wechsel fallen
// sie weg; innerhalb desselben Origins (typisch: ein Server, der /cal auf
// /cal/ umleitet) bleiben sie, sonst braeche jeder WebDAV-Sync.
const ORIGIN_BOUND_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

// Ein Host, der schon eine IP ist, bekommt von node:http KEINEN Lookup: die
// Adresse steht ja fest. Damit stand der `lookup`-Hook, der den SSRF-Schutz
// traegt, bei einem Redirect auf `http://169.254.169.254/` einfach nicht im Weg
// (GHSA-9jh6-phj9-m6qr): der erste Hop wurde am Namen geprueft, der zweite als
// Literal ungeprueft verbunden. Deshalb ruft safeRequest den Hook fuer ein
// IP-Literal selbst auf - mit derselben Adresse, die Node verbinden wuerde -,
// und zwar auf jedem Hop, dem ersten eingeschlossen. Der Hook entscheidet;
// hier steht keine eigene Liste privater Netze, sonst gaebe es zwei.
function literalAddress(url) {
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return isIP(host) ? host : null;
}

function assertLookupAcceptsLiteral(lookup, url) {
  const address = literalAddress(url);
  if (!lookup || !address) return Promise.resolve();
  return new Promise((resolve, reject) => {
    lookup(address, { all: true }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Ziel-URL eines Redirects, oder ein Fehler. Ausgelagert und exportiert, weil
 * sich die Regel sonst nur ueber einen echten TLS-Server pruefen liesse - ein
 * Test, der stattdessen auf "irgendein Fehler" prueft, waere auch ohne den
 * Downgrade-Zweig gruen.
 *
 * @param {URL} from        URL, die den Redirect geliefert hat
 * @param {string} location Wert des Location-Headers (relativ erlaubt)
 * @returns {URL}
 */
export function resolveRedirect(from, location) {
  let next;
  try {
    next = new URL(location, from);
  } catch {
    throw new Error('Invalid redirect location');
  }
  if (!ALLOWED_PROTOCOLS.has(next.protocol)) {
    throw new Error(`Redirect to unsupported protocol: ${next.protocol}`);
  }
  if (from.protocol === 'https:' && next.protocol === 'http:') {
    throw new Error('Redirect downgrades https to http');
  }
  return next;
}

/**
 * Header fuer das Redirect-Ziel. Gleicher Origin (Schema + Host + Port) → alles
 * unveraendert; sonst ohne die origin-gebundenen Zugangsdaten.
 */
export function headersForRedirect(headers, from, to) {
  if (from.origin === to.origin) return headers;
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!ORIGIN_BOUND_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

// node:http sendet standardmäßig KEINEN User-Agent/Accept/Accept-Encoding-Header;
// node-fetch tat das (`User-Agent: node-fetch`, `Accept: */*`, `Accept-Encoding:
// gzip, deflate, br`) und dekomprimierte transparent. Diese Defaults halten das
// bisherige Verhalten aufrecht: Manche Ziel-Server (Cloudflare-/WAF-geschützte
// ICS-Feeds, strikte WebDAV-Server) weisen Requests ohne User-Agent mit 403 ab; und
// ein Server, der komprimiert, würde ohne die zu `Content-Encoding` passende
// Dekompression (siehe decodeBody) rohe/korrupte Bytes liefern. Aufrufer, die einen
// dieser Header selbst (case-insensitiv) setzen, überschreiben den Default.
const DEFAULT_HEADERS = {
  'User-Agent': 'Yuvomi (+https://github.com/ulsklyc/yuvomi)',
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br',
};

/**
 * Liefert den Response-Body als Readable von Buffers — transparent dekomprimiert,
 * wenn der Server `Content-Encoding: gzip|deflate|br` gesetzt hat (node-fetch-Parität).
 * Ohne Encoding wird die rohe IncomingMessage zurückgegeben. Fehler und ein vorzeitiges
 * `destroy()` (z. B. beim Überschreiten einer Größengrenze) werden zwischen Socket und
 * Dekompressor propagiert, damit keine Verbindung hängen bleibt.
 */
function decodeBody(res) {
  // 204/304 und explizit leere Bodies tragen nie eine sinnvolle Kompression; ein
  // Dekompressor auf 0 Bytes würde fälschlich "unexpected end of file" werfen.
  if (res.statusCode === 204 || res.statusCode === 304
    || res.headers['content-length'] === '0') {
    return res;
  }
  const encoding = String(res.headers['content-encoding'] || '').toLowerCase().trim();
  let decompressor;
  if (encoding === 'gzip' || encoding === 'x-gzip') decompressor = zlib.createGunzip();
  else if (encoding === 'deflate') decompressor = zlib.createInflate();
  else if (encoding === 'br') decompressor = zlib.createBrotliDecompress();
  else return res;

  res.on('error', (err) => decompressor.destroy(err));
  decompressor.on('close', () => res.destroy());
  res.pipe(decompressor);
  return decompressor;
}

/**
 * Hüllt eine node http.IncomingMessage in eine fetch-ähnliche Fassade. `body` ist eine
 * Readable von Buffers (ggf. dekomprimiert) — so funktionieren sowohl
 * `for await (const chunk of res.body)` mit `chunk.toString()`/`chunk.length` als auch
 * `res.body.destroy()` unverändert weiter.
 */
function fetchLike(res) {
  return {
    status: res.statusCode,
    get ok() { return res.statusCode >= 200 && res.statusCode < 300; },
    headers: {
      get(name) {
        const value = res.headers[String(name).toLowerCase()];
        return Array.isArray(value) ? value.join(', ') : (value ?? null);
      },
    },
    body: decodeBody(res),
  };
}

/**
 * Führt eine HTTP(S)-Anfrage aus und liefert eine fetch-ähnliche Response.
 *
 * @param {string} rawUrl
 * @param {object} [options]
 * @param {string}   [options.method='GET']
 * @param {object}   [options.headers={}]
 * @param {Buffer|string} [options.body]  Request-Body; für Buffer/String wird
 *        Content-Length gesetzt (wie node-fetch), damit Ziele ohne Chunked-Support
 *        (z. B. manche WebDAV-Server bei PUT) korrekt bedient werden.
 * @param {Function} [options.lookup]  Node-style lookup(hostname, opts, cb) — trägt
 *        den SSRF-Schutz. Wird pro Request an die Socket-Verbindung durchgereicht.
 * @param {AbortSignal} [options.signal]
 * @param {'follow'|'manual'} [options.redirect='follow']
 * @param {number}   [options.maxRedirects=5]
 * @returns {Promise<{status:number, ok:boolean, headers:{get:Function}, body:import('node:http').IncomingMessage}>}
 */
export function safeRequest(rawUrl, {
  method = 'GET',
  headers = {},
  body,
  lookup,
  signal,
  redirect = 'follow',
  maxRedirects = DEFAULT_MAX_REDIRECTS,
} = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (err) {
      reject(err);
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    const outHeaders = { ...headers };
    const lowerKeys = new Set(Object.keys(outHeaders).map((h) => h.toLowerCase()));
    // Default-Header nur setzen, wenn der Aufrufer sie nicht selbst (in beliebiger
    // Schreibweise) mitgibt.
    for (const [name, value] of Object.entries(DEFAULT_HEADERS)) {
      if (!lowerKeys.has(name.toLowerCase())) outHeaders[name] = value;
    }
    const hasBody = body !== undefined && body !== null;
    // Content-Length wie node-fetch setzen (nur wenn der Aufrufer keinen eigenen
    // Wert und keine explizite Transfer-Encoding vorgibt).
    if (hasBody
      && (typeof body === 'string' || Buffer.isBuffer(body))
      && !Object.keys(outHeaders).some((h) => h.toLowerCase() === 'content-length')
      && !Object.keys(outHeaders).some((h) => h.toLowerCase() === 'transfer-encoding')) {
      outHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const start = () => transport.request(url, { method, headers: outHeaders, lookup, signal }, (res) => {
      const status = res.statusCode;
      if (redirect === 'follow' && status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // Redirect-Body verwerfen, Socket freigeben
        if (maxRedirects <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        let next;
        try {
          next = resolveRedirect(url, res.headers.location);
        } catch (err) {
          reject(err);
          return;
        }
        resolve(safeRequest(next.href, {
          method,
          headers: headersForRedirect(headers, url, next),
          body,
          lookup,
          signal,
          redirect,
          maxRedirects: maxRedirects - 1,
        }));
        return;
      }
      resolve(fetchLike(res));
    });

    assertLookupAcceptsLiteral(lookup, url).then(() => {
      const req = start();
      req.on('error', reject);
      if (hasBody) req.write(body);
      req.end();
    }, reject);
  });
}

// ── A failed request to a foreign server, as its class ──────────────────────
// Phase 0 section H (roadmap decision 19, E4 of 08.11.2026): an admin's
// connection test or sync answers with a fixed sentence, a `reason` and the
// error class in `detail` - never the message of the library or the network
// stack, which names hosts, ports and paths. Judged by the class of the error
// (HTTP status, network code, error type), never by its wording, the same rule
// as classifyProviderFailure (server/services/recipe-providers/failure.js).

// No machine at this address, or it does not answer; TLS refused the peer.
const REMOTE_NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH',
  'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'EPROTO', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// The server does not know the credentials (401) or does not let them read (403).
const REMOTE_AUTH_STATUSES = new Set([401, 403]);

/** The error and its causes, nearest first (a wrapper keeps the original as `cause`). */
function* errorChain(err) {
  let current = err;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    yield current;
    current = current.cause;
  }
}

function httpStatusOf(err) {
  for (const e of errorChain(err)) {
    const status = e.status ?? e.statusCode ?? e.response?.status;
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return null;
}

function isTimeout(err) {
  for (const e of errorChain(err)) {
    if (e.name === 'TimeoutError') return true;
    if (e.name === 'AbortError' && e.cause?.name === 'TimeoutError') return true;
  }
  return false;
}

/**
 * The class of a failed request to a foreign server, or null when the error is
 * not one (a database error in the same catch): the route then answers with
 * its fixed 500.
 *
 *   HTTP 401/403                     -> remote_auth_failed, detail `HTTP 401`
 *   any other HTTP status            -> remote_http_status, detail `HTTP 503`, params.status
 *   timeout                          -> remote_unreachable, detail `timeout`
 *   private address refused (SSRF)   -> remote_unreachable, detail `blocked`
 *   network or TLS code              -> remote_unreachable, detail the code (`ECONNREFUSED`)
 *   anything else                    -> remote_failed, no detail
 *
 * @param {unknown} err
 * @returns {{ reason: string, detail?: string, params?: { status: number } } | null}
 */
export function remoteFailure(err) {
  for (const e of errorChain(err)) {
    if (typeof e.code === 'string' && /^(SQLITE_|ERR_SQLITE)/.test(e.code)) return null;
  }
  const status = httpStatusOf(err);
  if (REMOTE_AUTH_STATUSES.has(status)) return { reason: 'remote_auth_failed', detail: `HTTP ${status}` };
  if (status !== null && (status < 200 || status >= 300)) {
    return { reason: 'remote_http_status', detail: `HTTP ${status}`, params: { status } };
  }
  if (isTimeout(err)) return { reason: 'remote_unreachable', detail: 'timeout' };
  for (const e of errorChain(err)) {
    if (e.name === 'BlockedAddressError') return { reason: 'remote_unreachable', detail: 'blocked' };
    if (typeof e.code === 'string' && REMOTE_NETWORK_CODES.has(e.code)) return { reason: 'remote_unreachable', detail: e.code };
    // nodemailer replaces `code` with its own type (ESOCKET, EDNS) and keeps
    // the socket's code in `originalCode`.
    if (typeof e.originalCode === 'string' && REMOTE_NETWORK_CODES.has(e.originalCode)) {
      return { reason: 'remote_unreachable', detail: e.originalCode };
    }
  }
  return { reason: 'remote_failed' };
}

/**
 * Whether a failure happened on this server rather than at the foreign one
 * (#2622): a system error of the filesystem or the OS (`errno`/`syscall`, such
 * as ENOENT from reading the backup file) or a crypto error (`ERR_OSSL_*`,
 * `ERR_CRYPTO_*`), with no HTTP status anywhere in the chain. A socket error
 * carries `syscall` too (`connect`), but its code is a network code and stays
 * remote. A route answers a local failure with its own 500, never as the
 * foreign server's (`remote_failed`).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isLocalFailure(err) {
  if (httpStatusOf(err) !== null) return false;
  for (const e of errorChain(err)) {
    const code = typeof e.code === 'string' ? e.code : '';
    if (REMOTE_NETWORK_CODES.has(code)) return false;
    if (typeof e.originalCode === 'string' && REMOTE_NETWORK_CODES.has(e.originalCode)) return false;
    // A socket or name lookup with a code the list above does not know.
    if (e.syscall === 'connect' || e.syscall === 'getaddrinfo') return false;
  }
  for (const e of errorChain(err)) {
    const code = typeof e.code === 'string' ? e.code : '';
    if (typeof e.syscall === 'string' || Number.isInteger(e.errno)) return true;
    if (/^ERR_(?:OSSL|CRYPTO)_/.test(code)) return true;
  }
  return false;
}
