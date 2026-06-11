/**
 * Modul: Papra-DMS-Adapter-Test
 * Zweck: Validiert den Papra-Adapter (search/fetchContent/upload/testConnection)
 *        gegen ein gemocktes fetch — keine echte Netzwerkverbindung.
 * Ausführen: node --test test/test-dms-papra-adapter.js
 */
import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import { PapraAdapter } from '../server/services/dms/papra.js';
import { getAdapter } from '../server/services/dms/index.js';

const account = {
  provider: 'papra',
  base_url: 'https://papra.example.com/',
  api_token: 'tok123',
  org_id: 'org_abc',
};

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

function binaryResponse(buffer, mime, status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? mime : null) },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

test('search: baut Query-URL, setzt Bearer-Header, mappt Treffer', async () => {
  mockFetch(() => jsonResponse({
    documents: [{
      id: 'doc_1', name: 'Stromrechnung', originalName: 'strom.pdf',
      mimeType: 'application/pdf', createdAt: '2026-01-02T10:00:00.000Z',
    }],
    documentsCount: 1,
  }));
  const adapter = new PapraAdapter(account);
  const results = await adapter.search('strom', { limit: 10 });

  assert.equal(calls[0].url, 'https://papra.example.com/api/organizations/org_abc/documents?searchQuery=strom&pageSize=10');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok123');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    id: 'doc_1',
    title: 'Stromrechnung',
    created: '2026-01-02T10:00:00.000Z',
    filename: 'strom.pdf',
    url: 'https://papra.example.com/documents/org_abc/doc_1',
  });
});

test('search: leerer Query liefert leeres Array ohne fetch', async () => {
  mockFetch(() => { throw new Error('should not fetch'); });
  const adapter = new PapraAdapter(account);
  assert.deepEqual(await adapter.search('   '), []);
  assert.equal(calls.length, 0);
});

test('search: HTTP-Fehler wirft mit Statuscode', async () => {
  mockFetch(() => jsonResponse({}, 401));
  const adapter = new PapraAdapter(account);
  await assert.rejects(() => adapter.search('x'), /DMS request failed \(401\)/);
});

test('getDocument: liefert normalisierte Metadaten', async () => {
  mockFetch(() => jsonResponse({
    document: {
      id: 'doc_1', name: 'Rechnung', originalName: 'rechnung.pdf',
      mimeType: 'application/pdf', createdAt: '2026-01-02T10:00:00.000Z',
      tags: [{ id: 'tag_1', name: 'Finanzen', color: '#ff0000' }],
    },
  }));
  const adapter = new PapraAdapter(account);
  const doc = await adapter.getDocument('doc_1');

  assert.equal(calls[0].url, 'https://papra.example.com/api/organizations/org_abc/documents/doc_1');
  assert.equal(doc.id, 'doc_1');
  assert.equal(doc.title, 'Rechnung');
  assert.equal(doc.filename, 'rechnung.pdf');
  assert.equal(doc.url, 'https://papra.example.com/documents/org_abc/doc_1');
  assert.equal(doc.correspondent, null);
  assert.equal(doc.tags.length, 1);
});

test('fetchContent: lädt Binärdaten herunter, gibt buffer + mime zurück', async () => {
  const buf = Buffer.from('%PDF-1.4 fake');
  mockFetch(() => binaryResponse(buf, 'application/pdf'));
  const adapter = new PapraAdapter(account);
  const out = await adapter.fetchContent('doc_1');

  assert.equal(calls[0].url, 'https://papra.example.com/api/organizations/org_abc/documents/doc_1/file');
  assert.equal(out.mime, 'application/pdf');
  assert.ok(Buffer.isBuffer(out.buffer));
  assert.equal(out.buffer.toString(), '%PDF-1.4 fake');
});

test('upload: POSTet multipart, gibt taskId aus doc.id zurück', async () => {
  mockFetch(() => jsonResponse({ document: { id: 'doc_new', name: 'Test.pdf' } }));
  const adapter = new PapraAdapter(account);
  const out = await adapter.upload({
    buffer: Buffer.from('hello'), filename: 'test.pdf', mime: 'application/pdf', title: 'Test',
  });

  assert.equal(calls[0].url, 'https://papra.example.com/api/organizations/org_abc/documents');
  assert.equal(calls[0].opts.method, 'POST');
  assert.ok(calls[0].opts.body instanceof FormData);
  assert.equal(out.taskId, 'doc_new');
});

test('upload: erfordert filename', async () => {
  const adapter = new PapraAdapter(account);
  await assert.rejects(
    () => adapter.upload({ buffer: Buffer.from('x'), mime: 'application/pdf' }),
    /requires a filename/,
  );
});

test('testConnection: ok=true bei 200 auf /api/api-keys/current', async () => {
  mockFetch(() => jsonResponse({ apiKey: { id: 'apk_1', name: 'test' } }));
  const adapter = new PapraAdapter(account);
  const out = await adapter.testConnection();

  assert.equal(calls[0].url, 'https://papra.example.com/api/api-keys/current');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok123');
  assert.equal(out.ok, true);
});

test('testConnection: ok=false bei 401', async () => {
  mockFetch(() => jsonResponse({}, 401));
  const adapter = new PapraAdapter(account);
  const out = await adapter.testConnection();
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
});

test('testConnection: ok=false bei Netzwerkfehler', async () => {
  mockFetch(() => { throw new Error('ECONNREFUSED'); });
  const adapter = new PapraAdapter(account);
  const out = await adapter.testConnection();
  assert.equal(out.ok, false);
  assert.equal(out.status, 0);
  assert.match(out.error, /ECONNREFUSED/);
});

test('getAdapter: liefert PapraAdapter für provider=papra', () => {
  const a = getAdapter({ provider: 'papra', base_url: 'https://x/', api_token: 't', org_id: 'org_1' });
  assert.equal(a.provider, 'papra');
  assert.equal(a.orgId, 'org_1');
});

test('docUrl: enthält orgId und docId', () => {
  const adapter = new PapraAdapter(account);
  assert.equal(adapter.docUrl('doc_42'), 'https://papra.example.com/documents/org_abc/doc_42');
});

test('Base-URL: trailing slash wird entfernt', () => {
  const adapter = new PapraAdapter({ ...account, base_url: 'https://papra.example.com///' });
  assert.equal(adapter.base, 'https://papra.example.com');
});
