/**
 * Modul: DMS-Adapter-Test
 * Zweck: Validiert den Paperless-ngx-Adapter (search/fetchContent/upload/testConnection)
 *        gegen ein gemocktes fetch — keine echte Netzwerkverbindung.
 * Ausführen: node --test test/test-dms-adapter.js
 */
import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import { PaperlessAdapter } from '../server/services/dms/paperless.js';
import { getAdapter } from '../server/services/dms/index.js';

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

test('testConnection: fordert explizite API-Version im Accept-Header an', async () => {
  mockFetch(() => jsonResponse({}));
  const adapter = new PaperlessAdapter(account);
  await adapter.testConnection();
  assert.match(calls[0].opts.headers.Accept, /application\/json; version=\d+/);
});

test('testConnection: 406 löst Fallback ohne Version aus (#438)', async () => {
  mockFetch((_url, opts) => {
    const hasVersion = /version=/.test(opts.headers.Accept);
    return jsonResponse(hasVersion ? { detail: 'Not Acceptable' } : { documents: 'x' }, hasVersion ? 406 : 200);
  });
  const adapter = new PaperlessAdapter(account);
  const out = await adapter.testConnection();
  assert.equal(calls.length, 2);
  assert.match(calls[0].opts.headers.Accept, /version=/);
  assert.equal(calls[1].opts.headers.Accept, 'application/json');
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
});

test('search: 406 auf versionierten Request fällt auf unversioniert zurück (#438)', async () => {
  mockFetch((_url, opts) => {
    if (/version=/.test(opts.headers.Accept)) return jsonResponse({ detail: 'Not Acceptable' }, 406);
    return jsonResponse({ results: [{ id: 5, title: 'Vertrag', original_file_name: 'v.pdf' }] });
  });
  const adapter = new PaperlessAdapter(account);
  const results = await adapter.search('vertrag');
  assert.equal(calls.length, 2);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, '5');
});

test('upload: POSTet multipart an post_document/, gibt taskId zurück', async () => {
  mockFetch(() => jsonResponse('b7c4-task-uuid'));
  const adapter = new PaperlessAdapter(account);
  const out = await adapter.upload({
    buffer: Buffer.from('hello'), filename: 'a.pdf', mime: 'application/pdf', title: 'Brief',
  });
  assert.equal(calls[0].url, 'https://dms.example.com/api/documents/post_document/');
  assert.equal(calls[0].opts.method, 'POST');
  assert.ok(calls[0].opts.body instanceof FormData);
  assert.equal(out.taskId, 'b7c4-task-uuid');
});

test('upload: übergibt tags als wiederholte Felder und erfordert filename', async () => {
  mockFetch(() => jsonResponse('uuid-abc'));
  const adapter = new PaperlessAdapter(account);
  const out = await adapter.upload({
    buffer: Buffer.from('x'), filename: 'b.pdf', mime: 'application/pdf', tags: [3, 7],
  });
  assert.equal(out.taskId, 'uuid-abc');
  assert.equal(calls[0].opts.method, 'POST');
  await assert.rejects(
    () => adapter.upload({ buffer: Buffer.from('x'), mime: 'application/pdf' }),
    /requires a filename/,
  );
});

test('getAdapter: liefert PaperlessAdapter für provider=paperless', () => {
  const a = getAdapter({ provider: 'paperless', base_url: 'https://x/', api_token: 't' });
  assert.equal(a.provider, 'paperless');
});

test('getAdapter: wirft bei unbekanntem Provider', () => {
  assert.throws(() => getAdapter({ provider: 'nope' }), /Unknown DMS provider/);
});
