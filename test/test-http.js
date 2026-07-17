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

import { safeRequest } from '../server/utils/http.js';

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
