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

const DEFAULT_MAX_REDIRECTS = 5;

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

    const req = transport.request(url, { method, headers: outHeaders, lookup, signal }, (res) => {
      const status = res.statusCode;
      if (redirect === 'follow' && status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // Redirect-Body verwerfen, Socket freigeben
        if (maxRedirects <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        const next = new URL(res.headers.location, url).href;
        resolve(safeRequest(next, {
          method, headers, body, lookup, signal, redirect, maxRedirects: maxRedirects - 1,
        }));
        return;
      }
      resolve(fetchLike(res));
    });

    req.on('error', reject);
    if (hasBody) req.write(body);
    req.end();
  });
}
