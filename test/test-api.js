/**
 * Tests: API-Client (public/api.js)
 * Fokus: CSRF-Token-Handling, auth:expired-Dispatch-Verhalten
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Browser-Globals für Node-Kontext simulieren
global.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

let dispatchedEvents = [];
global.window = {
  dispatchEvent(e) { dispatchedEvents.push(e); },
  addEventListener() {},
};
global.document = { cookie: '' };

// fetch-Mock: wird pro Test überschrieben
let _mockFetch = null;
global.fetch = (...args) => _mockFetch(...args);

function mockResponse(status, body = {}, headers = {}) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) { return headers[name] ?? null; },
    },
    json: () => Promise.resolve(body),
  });
}

const { api, auth, ApiError } = await import('../public/api.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');

function setup() {
  dispatchedEvents = [];
  document.cookie = '';
}

// ─── 401 auf Login-Endpunkt ──────────────────────────────────────────────────

test('auth.login: 401 feuert kein auth:expired', async () => {
  setup();
  _mockFetch = () => mockResponse(401, { error: 'Invalid credentials.', code: 401 });

  await assert.rejects(
    () => auth.login('user', 'wrong'),
    (err) => {
      assert.equal(err.constructor.name, 'ApiError');
      assert.equal(err.status, 401);
      return true;
    },
  );

  const expired = dispatchedEvents.filter((e) => e.type === 'auth:expired');
  assert.equal(expired.length, 0, 'auth:expired darf bei Login-401 nicht gefeuert werden');
});

test('auth.login: 401 wirft ApiError mit status 401', async () => {
  setup();
  _mockFetch = () => mockResponse(401, { error: 'Invalid credentials.', code: 401 });

  let thrownErr;
  try {
    await auth.login('user', 'wrong');
  } catch (e) {
    thrownErr = e;
  }

  assert.ok(thrownErr instanceof ApiError, 'Muss ApiError sein');
  assert.equal(thrownErr.status, 401);
});

// ─── 401 auf anderen Endpunkten ─────────────────────────────────────────────

test('api.get: 401 auf geschütztem Endpunkt feuert auth:expired', async () => {
  setup();
  _mockFetch = () => mockResponse(401, { error: 'Not authenticated.', code: 401 });

  await assert.rejects(() => api.get('/tasks'));

  const expired = dispatchedEvents.filter((e) => e.type === 'auth:expired');
  assert.equal(expired.length, 1, 'auth:expired muss bei 401 auf geschütztem Endpunkt gefeuert werden');
});

test('api.post: 401 auf Logout-Endpunkt feuert auth:expired', async () => {
  setup();
  _mockFetch = () => mockResponse(401, { error: 'Not authenticated.', code: 401 });

  await assert.rejects(() => api.post('/auth/logout', {}));

  const expired = dispatchedEvents.filter((e) => e.type === 'auth:expired');
  assert.equal(expired.length, 1, 'auth:expired muss bei 401 auf /auth/logout gefeuert werden');
});

// ─── Erfolgreicher Login ─────────────────────────────────────────────────────

test('auth.login: Erfolg speichert csrfToken aus Body', async () => {
  setup();
  const token = 'abc123def456';
  _mockFetch = () => mockResponse(200, {
    user: { id: 1, username: 'admin' },
    csrfToken: token,
  });

  const result = await auth.login('admin', 'password');
  assert.equal(result.user.username, 'admin');
  assert.equal(result.csrfToken, token);
  assert.equal(dispatchedEvents.length, 0, 'Kein Event bei erfolgreichem Login');
});

// ─── OpenAPI: Dokument-Storage-Vertrag ──────────────────────────────────────

function schemaProperties(spec, name) {
  return spec.components.schemas[name]?.properties ?? {};
}

function responseSchema(operation, status = 200) {
  const schema = operation.responses[status].content['application/json'].schema;
  if (!schema.$ref) return schema;
  return openApi.components.schemas[schema.$ref.split('/').pop()];
}

const openApi = buildOpenApiSpec({}, 'test');

test('OpenAPI dokumentiert Dokument-Backend und Legacy-Provider', () => {
  const document = openApi.components.schemas.FamilyDocument;
  assert.deepEqual(document.properties.storage_backend.enum, ['local', 'webdav', 'dms']);
  assert.deepEqual(document.properties.storage_provider.enum, ['local', 'external']);
  assert.ok(document.required.includes('storage_backend'));

  const list = responseSchema(openApi.paths['/api/v1/documents'].get);
  assert.equal(list.properties.data.items.$ref, '#/components/schemas/FamilyDocument');
  const create = responseSchema(openApi.paths['/api/v1/documents'].post, 201);
  assert.equal(create.properties.data.$ref, '#/components/schemas/FamilyDocument');
});

test('OpenAPI dokumentiert aktive Upload-Backend-Option bei stabilem Legacy-Provider', () => {
  const options = responseSchema(openApi.paths['/api/v1/documents/meta/options'].get);
  const data = options.properties.data;
  assert.deepEqual(data.properties.storage_providers.items.enum, ['local', 'external']);
  assert.deepEqual(data.properties.active_upload_backend.enum, ['local', 'webdav']);
});

test('OpenAPI dokumentiert admin-only WebDAV-Konfiguration ohne Passwortausgabe', () => {
  const path = openApi.paths['/api/v1/documents/storage/config'];
  assert.ok(path.get.responses[403]);
  assert.ok(path.put.responses[403]);

  const request = openApi.components.schemas.DocumentStorageConfigRequest;
  for (const field of [
    'enabled',
    'url',
    'username',
    'password',
    'path',
    'confirm_existing_access',
    'clear_password',
  ]) {
    assert.ok(request.properties[field], `Requestfeld fehlt: ${field}`);
  }

  const status = openApi.components.schemas.DocumentStorageStatus;
  for (const field of [
    'enabled',
    'configured',
    'active_upload_backend',
    'effective_target',
    'webdav_document_count',
    'last_test',
    'last_error',
    'env_controlled',
  ]) {
    assert.ok(status.properties[field], `Statusfeld fehlt: ${field}`);
  }
  assert.deepEqual(
    Object.keys(status.properties.env_controlled.properties),
    ['enabled', 'url', 'username', 'password', 'path']
  );
  assert.equal(Object.hasOwn(status.properties, 'password'), false);
  assert.equal(
    responseSchema(path.get).properties.data.$ref,
    '#/components/schemas/DocumentStorageStatus'
  );

  const testPath = openApi.paths['/api/v1/documents/storage/test'].post;
  assert.ok(testPath.responses[403]);
  assert.equal(
    testPath.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/DocumentStorageTestRequest'
  );
});

test('OpenAPI dokumentiert Kalender-Dokumentlinks und Legacy-Anhangsdaten', () => {
  const calendarEvent = schemaProperties(openApi, 'CalendarEvent');
  assert.equal(calendarEvent.attachment_document_id.type.includes('null'), true);
  assert.equal(calendarEvent.attachment_preview_url.type.includes('null'), true);
  assert.equal(calendarEvent.attachment_download_url.type.includes('null'), true);
  assert.equal(calendarEvent.attachment_data.type.includes('null'), true);

  const list = responseSchema(openApi.paths['/api/v1/calendar'].get);
  assert.equal(list.properties.data.items.$ref, '#/components/schemas/CalendarEvent');
});

test('OpenAPI dokumentiert stabile Storage-Fehlercodes', () => {
  const codes = openApi.components.schemas.DocumentStorageErrorCode.enum;
  for (const suffix of [
    'INVALID_CONFIG',
    'NOT_CONFIGURED',
    'UPLOAD_FAILED',
    'READ_FAILED',
    'DELETE_FAILED',
    'CLEANUP_FAILED',
    'TOO_LARGE',
    'CONNECTION_TEST_FAILED',
    'CONFIG_PROTECTED',
  ]) {
    assert.ok(
      codes.includes(`DOCUMENT_STORAGE_${suffix}`),
      `Storage-Fehlercode fehlt: ${suffix}`
    );
  }
  assert.equal(
    openApi.components.schemas.ApiError.properties.storage_code.$ref,
    '#/components/schemas/DocumentStorageErrorCode'
  );
});

test('OpenAPI erlaubt DMS-Push für local und webdav, aber nicht dms', () => {
  const push = openApi.paths['/api/v1/documents/dms/push'].post;
  assert.match(push.description, /local.*webdav/i);
  assert.match(push.description, /storage_backend.*dms/i);

  const linked = openApi.components.schemas.DmsLinkResponse.properties.data;
  assert.deepEqual(linked.properties.storage_backend.enum, ['dms']);
  assert.ok(linked.required.includes('storage_backend'));
});
