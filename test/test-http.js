/**
 * Testsuite: node-nativer Safe-HTTP-Client (server/utils/http.js)
 *
 * Verifiziert gegen einen echten lokalen HTTP-Server die verhaltensrelevanten
 * Eigenschaften, die beim Ersatz von node-fetch erhalten bleiben müssen:
 * Buffer-Bodies (kein Uint8Array.toString-Trap), Content-Length bei PUT,
 * fetch-ähnliche Response, Redirect-Following/Cap/manual und die Durchreichung
 * des SSRF-lookups an die Socket-Verbindung.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

import { safeRequest, resolveRedirect, headersForRedirect, remoteFailure } from '../server/utils/http.js';

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('GET: fetch-ähnliche Response, Body ist Buffer-Stream mit korrektem toString()', async () => {
  const { base, close } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', ETag: '"abc"' });
    res.end('Grüße über UTF-8: ä ö ü');
  });
  try {
    const resp = await safeRequest(`${base}/`);
    assert.equal(resp.status, 200);
    assert.equal(resp.ok, true);
    assert.equal(resp.headers.get('content-type'), 'text/plain');
    assert.equal(resp.headers.get('ETag'), '"abc"'); // case-insensitiv
    let body = '';
    for await (const chunk of resp.body) {
      assert.ok(Buffer.isBuffer(chunk), 'chunk muss ein Buffer sein');
      body += chunk.toString();
    }
    assert.equal(body, 'Grüße über UTF-8: ä ö ü');
  } finally {
    await close();
  }
});

test('Content-Encoding gzip: Body wird transparent dekomprimiert (node-fetch-Parität)', async () => {
  const payload = 'ICS-Nutzdaten mit Umlauten: ä ö ü — '.repeat(40);
  const { base, close } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/calendar', 'Content-Encoding': 'gzip' });
    res.end(zlib.gzipSync(Buffer.from(payload, 'utf8')));
  });
  try {
    const resp = await safeRequest(`${base}/feed.ics`);
    let body = '';
    for await (const chunk of resp.body) body += chunk.toString();
    assert.equal(body, payload, 'gzip-Body muss dekomprimiert und identisch sein');
  } finally {
    await close();
  }
});

test('Content-Encoding br: Brotli-Body wird dekomprimiert', async () => {
  const payload = Buffer.from([0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff, 0x42, 0x00, 0x99]);
  const { base, close } = await startServer((res_req, res) => {
    res.writeHead(200, { 'Content-Encoding': 'br' });
    res.end(zlib.brotliCompressSync(payload));
  });
  try {
    const resp = await safeRequest(`${base}/doc`);
    const chunks = [];
    for await (const chunk of resp.body) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), payload);
  } finally {
    await close();
  }
});

test('Accept-Encoding wird gesendet (node-fetch-Parität)', async () => {
  let seen = null;
  const { base, close } = await startServer((req, res) => {
    seen = req.headers['accept-encoding'] ?? null;
    res.writeHead(200);
    res.end('ok');
  });
  try {
    await safeRequest(`${base}/`);
    assert.ok(seen && /gzip/.test(seen), `Accept-Encoding muss gzip enthalten: ${seen}`);
  } finally {
    await close();
  }
});

test('nicht-2xx: ok=false, status durchgereicht', async () => {
  const { base, close } = await startServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  try {
    const resp = await safeRequest(`${base}/missing`);
    assert.equal(resp.status, 404);
    assert.equal(resp.ok, false);
  } finally {
    await close();
  }
});

test('304: durchgereicht (kein Redirect-Handling)', async () => {
  const { base, close } = await startServer((req, res) => {
    res.writeHead(304);
    res.end();
  });
  try {
    const resp = await safeRequest(`${base}/`);
    assert.equal(resp.status, 304);
  } finally {
    await close();
  }
});

test('PUT mit Buffer-Body: Bytes exakt übertragen + Content-Length gesetzt', async () => {
  const received = {};
  const { base, close } = await startServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received.body = Buffer.concat(chunks);
    received.contentLength = req.headers['content-length'];
    received.method = req.method;
    res.writeHead(201);
    res.end();
  });
  try {
    const payload = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42, 0x00]); // binär inkl. NUL
    const resp = await safeRequest(`${base}/doc`, { method: 'PUT', body: payload });
    assert.equal(resp.status, 201);
    assert.equal(received.method, 'PUT');
    assert.deepEqual(received.body, payload, 'Bytes müssen exakt ankommen');
    assert.equal(received.contentLength, String(payload.length));
  } finally {
    await close();
  }
});

test('Default-Header: User-Agent + Accept werden gesetzt (node-fetch-Parität)', async () => {
  const seen = {};
  const { base, close } = await startServer((req, res) => {
    seen.ua = req.headers['user-agent'] ?? null;
    seen.accept = req.headers.accept ?? null;
    res.writeHead(200);
    res.end('ok');
  });
  try {
    await safeRequest(`${base}/`);
    assert.ok(seen.ua && seen.ua.length > 0, 'User-Agent muss gesetzt sein');
    assert.equal(seen.accept, '*/*');
  } finally {
    await close();
  }
});

test('Default-Header: Aufrufer überschreibt case-insensitiv', async () => {
  const seen = {};
  const { base, close } = await startServer((req, res) => {
    seen.ua = req.headers['user-agent'] ?? null;
    res.writeHead(200);
    res.end('ok');
  });
  try {
    await safeRequest(`${base}/`, { headers: { 'user-agent': 'Custom/1.0' } });
    assert.equal(seen.ua, 'Custom/1.0');
  } finally {
    await close();
  }
});

test('Header-Durchreichung inkl. Authorization', async () => {
  const seen = {};
  const { base, close } = await startServer((req, res) => {
    seen.auth = req.headers.authorization;
    seen.custom = req.headers['x-custom'];
    res.writeHead(200);
    res.end('ok');
  });
  try {
    await safeRequest(`${base}/`, { headers: { Authorization: 'Basic Zm9v', 'X-Custom': 'yes' } });
    assert.equal(seen.auth, 'Basic Zm9v');
    assert.equal(seen.custom, 'yes');
  } finally {
    await close();
  }
});

test('Redirect follow: folgt 302 zum Ziel', async () => {
  const { base, close } = await startServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/final' });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end('final-body');
  });
  try {
    const resp = await safeRequest(`${base}/start`);
    assert.equal(resp.status, 200);
    let body = '';
    for await (const c of resp.body) body += c.toString();
    assert.equal(body, 'final-body');
  } finally {
    await close();
  }
});

test('Redirect manual: 302 wird nicht verfolgt', async () => {
  const { base, close } = await startServer((req, res) => {
    res.writeHead(302, { Location: '/final' });
    res.end();
  });
  try {
    const resp = await safeRequest(`${base}/start`, { redirect: 'manual' });
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get('location'), '/final');
  } finally {
    await close();
  }
});

test('Redirect-Cap: zu viele Redirects → Fehler', async () => {
  const { base, close } = await startServer((req, res) => {
    res.writeHead(302, { Location: '/again' });
    res.end();
  });
  try {
    await assert.rejects(
      () => safeRequest(`${base}/loop`, { maxRedirects: 2 }),
      /redirect/i,
    );
  } finally {
    await close();
  }
});

// --------------------------------------------------------
// Redirect-Haertung (#937)
// --------------------------------------------------------
// Der DNS-Hook sieht nur IPs. Schema-Wechsel und Empfaengerwechsel der Header
// muessen deshalb hier geprueft werden - beides kann ein Ziel-Server ausloesen.

test('Redirect auf ein fremdes Protokoll wird abgelehnt', async () => {
  const { base, close } = await startServer((req, res) => {
    res.writeHead(302, { Location: 'file:///etc/passwd' });
    res.end();
  });
  try {
    await assert.rejects(
      () => safeRequest(`${base}/start`),
      /unsupported protocol/i,
    );
  } finally {
    await close();
  }
});

test('resolveRedirect: https → http wird abgelehnt (kein stilles TLS-Downgrade)', () => {
  const from = new URL('https://cal.example/dav/');
  assert.throws(() => resolveRedirect(from, 'http://cal.example/dav/'), /downgrade/i);
  assert.throws(() => resolveRedirect(from, 'http://anderswo.example/'), /downgrade/i);
});

test('resolveRedirect: erlaubte Wechsel bleiben erlaubt', () => {
  // http → https ist ein Upgrade, http → http der Normalfall, und ein relatives
  // Location erbt sein Schema von der Quelle.
  assert.equal(
    resolveRedirect(new URL('http://cal.example/a'), 'https://cal.example/b').href,
    'https://cal.example/b',
  );
  assert.equal(
    resolveRedirect(new URL('http://cal.example/a'), 'http://cal.example/b').href,
    'http://cal.example/b',
  );
  assert.equal(
    resolveRedirect(new URL('https://cal.example/a'), '/b').href,
    'https://cal.example/b',
  );
});

test('resolveRedirect: fremde Protokolle und unlesbare Ziele werfen', () => {
  const from = new URL('https://cal.example/a');
  assert.throws(() => resolveRedirect(from, 'file:///etc/passwd'), /unsupported protocol/i);
  assert.throws(() => resolveRedirect(from, 'ftp://cal.example/x'), /unsupported protocol/i);
  assert.throws(() => resolveRedirect(from, 'http://['), /invalid redirect/i);
});

test('headersForRedirect: Origin entscheidet ueber die Zugangsdaten', () => {
  const headers = { Authorization: 'Basic x', Cookie: 'sid=1', 'User-Agent': 'Yuvomi' };
  const from = new URL('https://cal.example/a');

  // Gleicher Origin: unveraendert (dieselbe Referenz, kein Kopieraufwand).
  assert.equal(headersForRedirect(headers, from, new URL('https://cal.example/b')), headers);

  // Anderer Port und anderes Schema sind eigene Origins, nicht nur ein anderer Host.
  for (const target of ['https://boese.example/', 'https://cal.example:8443/', 'http://cal.example/']) {
    const out = headersForRedirect(headers, from, new URL(target));
    assert.deepEqual(out, { 'User-Agent': 'Yuvomi' }, `Zugangsdaten an ${target} durchgereicht`);
  }
});

test('Redirect auf fremden Origin entfernt Authorization und Cookie', async () => {
  let seen = null;
  const target = await startServer((req, res) => {
    seen = req.headers;
    res.writeHead(200);
    res.end('ziel');
  });
  // Zweiter Server = zweiter Port = fremder Origin.
  const source = await startServer((req, res) => {
    res.writeHead(302, { Location: `${target.base}/final` });
    res.end();
  });
  try {
    const resp = await safeRequest(`${source.base}/start`, {
      headers: { Authorization: 'Basic Z2VoZWlt', Cookie: 'sid=abc', 'X-Harmlos': 'ja' },
    });
    assert.equal(resp.status, 200);
    assert.equal(seen.authorization, undefined, 'Authorization darf den Origin nicht verlassen');
    assert.equal(seen.cookie, undefined, 'Cookie darf den Origin nicht verlassen');
    assert.equal(seen['x-harmlos'], 'ja', 'sonstige Header bleiben erhalten');
  } finally {
    await source.close();
    await target.close();
  }
});

test('Redirect innerhalb desselben Origins behaelt Authorization', async () => {
  let seen = null;
  const { base, close } = await startServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/final' });
      res.end();
      return;
    }
    seen = req.headers;
    res.writeHead(200);
    res.end('ziel');
  });
  try {
    // Der Normalfall jedes WebDAV-Servers, der /cal auf /cal/ umleitet: ohne die
    // Zugangsdaten braeche der Sync mit 401 ab.
    const resp = await safeRequest(`${base}/start`, {
      headers: { Authorization: 'Basic Z2VoZWlt' },
    });
    assert.equal(resp.status, 200);
    assert.equal(seen.authorization, 'Basic Z2VoZWlt');
  } finally {
    await close();
  }
});

test('lookup wird pro Request an die Verbindung durchgereicht (SSRF-Hook)', async () => {
  let called = false;
  const { server, base, close } = await startServer((req, res) => { res.end('ok'); });
  const port = server.address().port;
  const lookup = (hostname, options, callback) => {
    called = true;
    const all = options && typeof options === 'object' && options.all;
    if (all) return callback(null, [{ address: '127.0.0.1', family: 4 }]);
    return callback(null, '127.0.0.1', 4);
  };
  try {
    // Host bewusst als Name, damit ein Lookup nötig ist:
    const resp = await safeRequest(`http://localhost:${port}/`, { lookup });
    assert.equal(resp.status, 200);
    assert.equal(called, true, 'lookup muss aufgerufen worden sein');
    assert.equal(base.includes(String(port)), true);
  } finally {
    await close();
  }
});

test('lookup, der ablehnt, bricht die Anfrage ab (SSRF-Block)', async () => {
  const { server, close } = await startServer((req, res) => { res.end('ok'); });
  const port = server.address().port;
  const lookup = (hostname, options, callback) => {
    callback(new Error('URL resolves to a private IP address: 169.254.169.254'));
  };
  try {
    await assert.rejects(
      () => safeRequest(`http://evil.example:${port}/`, { lookup }),
      /private IP/i,
    );
  } finally {
    await close();
  }
});

test('signal/abort: bricht laufende Anfrage ab', async () => {
  const { base, close } = await startServer((req, res) => {
    // absichtlich nie antworten
  });
  try {
    await assert.rejects(
      () => safeRequest(`${base}/hang`, { signal: AbortSignal.timeout(150) }),
    );
  } finally {
    await close();
  }
});

// --------------------------------------------------------
// IP-Literal im Redirect (GHSA-9jh6-phj9-m6qr)
// --------------------------------------------------------
// node:http ruft `lookup` nur fuer NAMEN auf. Ein 302 auf http://169.254.169.254/
// lief deshalb am SSRF-Hook vorbei, obwohl er mitgereicht wurde. safeRequest
// fragt den Hook fuer ein Literal jetzt selbst - und der Test prueft die WIRKUNG:
// der interne Pfad darf den Server nie erreichen.

function literalAwareLookup(log) {
  // Namen loesen auf 127.0.0.1 auf (der Testserver), Literale werden abgelehnt -
  // genau die Entscheidung, die createGuardedLookup fuer eine private IP trifft.
  return (hostname, options, callback) => {
    log.push(hostname);
    if (/^[\d.]+$|:/.test(hostname)) {
      return callback(new Error(`URL resolves to a private IP address: ${hostname}`));
    }
    const all = options && typeof options === 'object' && options.all;
    if (all) return callback(null, [{ address: '127.0.0.1', family: 4 }]);
    return callback(null, '127.0.0.1', 4);
  };
}

test('Redirect auf ein IP-Literal fragt den lookup-Hook und bricht ab', async () => {
  const hits = [];
  const { server, close } = await startServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/start') {
      res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/internal` });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end('secret');
  });
  const port = server.address().port;
  const asked = [];
  try {
    await assert.rejects(
      () => safeRequest(`http://first.example:${port}/start`, { lookup: literalAwareLookup(asked) }),
      /private IP/i,
    );
    assert.deepEqual(hits, ['/start'], 'der interne Pfad darf nie erreicht werden');
    assert.deepEqual(asked, ['first.example', '127.0.0.1'], 'der Hook sieht beide Hops, das Literal eingeschlossen');
  } finally {
    await close();
  }
});

test('Ein IP-Literal als erster Hop fragt den lookup-Hook ebenfalls', async () => {
  const { server, close } = await startServer((req, res) => { res.end('ok'); });
  const port = server.address().port;
  const asked = [];
  try {
    await assert.rejects(
      () => safeRequest(`http://127.0.0.1:${port}/`, { lookup: literalAwareLookup(asked) }),
      /private IP/i,
    );
    assert.deepEqual(asked, ['127.0.0.1']);
    // IPv6-Literal: die Klammern der URL-Schreibweise erreichen den Hook nicht.
    const asked6 = [];
    await assert.rejects(
      () => safeRequest(`http://[::1]:${port}/`, { lookup: literalAwareLookup(asked6) }),
      /private IP/i,
    );
    assert.deepEqual(asked6, ['::1']);
  } finally {
    await close();
  }
});

test('Ein IP-Literal, das der Hook annimmt, wird normal verbunden', async () => {
  const { server, base, close } = await startServer((req, res) => { res.end('ok'); });
  void server;
  const asked = [];
  const lookup = (hostname, options, callback) => {
    asked.push(hostname);
    const all = options && typeof options === 'object' && options.all;
    if (all) return callback(null, [{ address: hostname, family: 4 }]);
    return callback(null, hostname, 4);
  };
  try {
    const resp = await safeRequest(`${base}/`, { lookup });
    assert.equal(resp.status, 200);
    assert.deepEqual(asked, ['127.0.0.1']);
  } finally {
    await close();
  }
});

test('Ohne lookup bleibt ein IP-Literal unveraendert erreichbar', async () => {
  const { base, close } = await startServer((req, res) => { res.end('ok'); });
  try {
    const resp = await safeRequest(`${base}/`);
    assert.equal(resp.status, 200);
  } finally {
    await close();
  }
});

// ── remoteFailure: the class of a failed request, never its text (Phase 0 H) ──

test('remoteFailure: judged by status, network code and type, never by the message', () => {
  const withStatus = (status, message = 'x') => Object.assign(new Error(message), { status });
  const withCode = (code) => Object.assign(new Error(`connect ${code} 10.0.0.5:8443`), { code });
  assert.deepEqual(remoteFailure(withStatus(401)), { reason: 'remote_auth_failed', detail: 'HTTP 401' });
  assert.deepEqual(remoteFailure(withStatus(403)), { reason: 'remote_auth_failed', detail: 'HTTP 403' });
  assert.deepEqual(remoteFailure(withStatus(503)), { reason: 'remote_http_status', detail: 'HTTP 503', params: { status: 503 } });
  assert.deepEqual(remoteFailure({ statusCode: 404 }), { reason: 'remote_http_status', detail: 'HTTP 404', params: { status: 404 } });
  assert.deepEqual(remoteFailure({ response: { status: 500 } }), { reason: 'remote_http_status', detail: 'HTTP 500', params: { status: 500 } });
  assert.deepEqual(remoteFailure(withCode('ECONNREFUSED')), { reason: 'remote_unreachable', detail: 'ECONNREFUSED' });
  assert.deepEqual(remoteFailure(withCode('CERT_HAS_EXPIRED')), { reason: 'remote_unreachable', detail: 'CERT_HAS_EXPIRED' });
  // Native fetch: TypeError "fetch failed" with the network error as its cause.
  const fetchFailed = new TypeError('fetch failed', { cause: withCode('ENOTFOUND') });
  assert.deepEqual(remoteFailure(fetchFailed), { reason: 'remote_unreachable', detail: 'ENOTFOUND' });
  // A wrapper keeps the original as cause (caldav-sync, cardav-sync).
  const wrapped = new Error('CalDAV connection failed: Invalid credentials', { cause: withStatus(401) });
  assert.deepEqual(remoteFailure(wrapped), { reason: 'remote_auth_failed', detail: 'HTTP 401' });
  const timeout = Object.assign(new Error('aborted'), { name: 'AbortError', cause: Object.assign(new Error('t'), { name: 'TimeoutError' }) });
  assert.deepEqual(remoteFailure(timeout), { reason: 'remote_unreachable', detail: 'timeout' });
  assert.deepEqual(remoteFailure(Object.assign(new Error('10.0.0.1 is private'), { name: 'BlockedAddressError' })), { reason: 'remote_unreachable', detail: 'blocked' });
  // nodemailer swaps `code` for its own type and keeps the socket's code in `originalCode`.
  const smtp = Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:587'), { code: 'ESOCKET', originalCode: 'ECONNREFUSED' });
  assert.deepEqual(remoteFailure(smtp), { reason: 'remote_unreachable', detail: 'ECONNREFUSED' });
  // The wording decides nothing: a message that names 401 is still unclassified.
  assert.deepEqual(remoteFailure(new Error('PROPFIND https://dav.lan/ returned 401 Unauthorized')), { reason: 'remote_failed' });
  // An own code in lower case is not a network code.
  assert.deepEqual(remoteFailure(Object.assign(new Error('x'), { code: 'caldav_no_calendars' })), { reason: 'remote_failed' });
  // A database error in the same catch is not a remote failure: the route answers 500.
  assert.equal(remoteFailure(Object.assign(new Error('no such table: x'), { code: 'SQLITE_ERROR' })), null);
  assert.equal(remoteFailure(new Error('w', { cause: Object.assign(new Error('d'), { code: 'ERR_SQLITE_ERROR' }) })), null);
});
