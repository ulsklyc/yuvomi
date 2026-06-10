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
