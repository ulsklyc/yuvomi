/**
 * Modul: DMS-Adapter-Test
 * Zweck: Validiert den Paperless-ngx-Adapter (search/fetchContent/upload/testConnection)
 *        gegen ein gemocktes fetch — keine echte Netzwerkverbindung.
 * Ausführen: node --test test/test-dms-adapter.js
 */
import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import { PaperlessAdapter } from '../server/services/dms/paperless.js';

const account = { provider: 'paperless', base_url: 'https://dms.example.com/', api_token: 'tok123' };

let calls;
const realFetch = globalThis.fetch;
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(handler) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('search: baut Query-URL, setzt Token-Header, mappt Treffer', async () => {
  mockFetch(() => jsonResponse({
    count: 1,
    results: [{
      id: 42, title: 'Stromrechnung', created: '2026-01-02T00:00:00Z',
      correspondent: 7, tags: [3, 4],
      archived_file_name: 'stromrechnung.pdf', original_file_name: 'scan.pdf',
    }],
  }));
  const adapter = new PaperlessAdapter(account);
  const results = await adapter.search('strom', { limit: 10 });

  assert.equal(calls[0].url, 'https://dms.example.com/api/documents/?query=strom&page_size=10');
  assert.equal(calls[0].opts.headers.Authorization, 'Token tok123');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    id: '42', title: 'Stromrechnung', created: '2026-01-02T00:00:00Z',
    filename: 'stromrechnung.pdf',
    url: 'https://dms.example.com/documents/42',
  });
});

test('search: leerer Query liefert leeres Array ohne fetch', async () => {
  mockFetch(() => { throw new Error('should not fetch'); });
  const adapter = new PaperlessAdapter(account);
  assert.deepEqual(await adapter.search('   '), []);
  assert.equal(calls.length, 0);
});

test('search: HTTP-Fehler wirft mit Statuscode', async () => {
  mockFetch(() => jsonResponse({}, 401));
  const adapter = new PaperlessAdapter(account);
  await assert.rejects(() => adapter.search('x'), /DMS request failed \(401\)/);
});

function binaryResponse(buffer, mime, status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? mime : null) },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

test('getDocument: liefert normalisierte Metadaten (id, title, filename, url, tags)', async () => {
  mockFetch(() => jsonResponse({
    id: 42, title: 'Stromrechnung', created: '2026-01-02T00:00:00Z',
    correspondent: 7, tags: [3], archived_file_name: 'strom.pdf',
    original_file_name: 'scan.pdf', archive_serial_number: null,
  }));
  const adapter = new PaperlessAdapter(account);
  const doc = await adapter.getDocument('42');
  assert.equal(calls[0].url, 'https://dms.example.com/api/documents/42/');
  assert.equal(doc.id, '42');
  assert.equal(doc.title, 'Stromrechnung');
  assert.equal(doc.filename, 'strom.pdf');
  assert.equal(doc.url, 'https://dms.example.com/documents/42');
});

test('fetchContent: lädt Binärdaten herunter, gibt buffer + mime zurück', async () => {
  const buf = Buffer.from('%PDF-1.4 fake');
  mockFetch(() => binaryResponse(buf, 'application/pdf'));
  const adapter = new PaperlessAdapter(account);
  const out = await adapter.fetchContent('42');
  assert.equal(calls[0].url, 'https://dms.example.com/api/documents/42/download/');
  assert.equal(out.mime, 'application/pdf');
  assert.ok(Buffer.isBuffer(out.buffer));
  assert.equal(out.buffer.toString(), '%PDF-1.4 fake');
});

test('testConnection: ok=true bei 200 auf /api/', async () => {
  mockFetch(() => jsonResponse({ documents: 'https://dms.example.com/api/documents/' }));
  const adapter = new PaperlessAdapter(account);
  const out = await adapter.testConnection();
  assert.equal(calls[0].url, 'https://dms.example.com/api/');
  assert.equal(calls[0].opts.headers.Authorization, 'Token tok123');
  assert.equal(out.ok, true);
});

test('testConnection: ok=false bei 403', async () => {
  mockFetch(() => jsonResponse({}, 403));
  const adapter = new PaperlessAdapter(account);
  const out = await adapter.testConnection();
  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
});
