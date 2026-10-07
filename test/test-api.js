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

test('api.post: 429 übernimmt Retry-After in den ApiError', async () => {
  setup();
  _mockFetch = () => mockResponse(
    429,
    { error: 'Too many requests.', code: 429 },
    { 'Retry-After': '7' },
  );

  await assert.rejects(
    () => api.post('/documents', {}),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfter, '7');
      return true;
    },
  );
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
  assert.deepEqual(document.properties.storage_backend.enum, ['local', 'webdav', 'google_drive', 'dms']);
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
  assert.deepEqual(data.properties.active_upload_backend.enum, ['local', 'local_folder', 'webdav', 'google_drive']);
});

test('OpenAPI dokumentiert admin-only WebDAV-Konfiguration ohne Passwortausgabe', () => {
  const path = openApi.paths['/api/v1/documents/storage/config'];
  assert.ok(path.get.responses[403]);
  assert.ok(path.put.responses[403]);

  const request = openApi.components.schemas.DocumentStorageConfigRequest;
  for (const field of [
    'selected_upload_backend',
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
    'selected_upload_backend',
    'active_upload_backend',
    'effective_target',
    'webdav_document_count',
    'google_drive_document_count',
    'google_drive',
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
  const driveStatus = openApi.components.schemas.GoogleDriveStorageStatus;
  for (const secret of ['access_token', 'refresh_token', 'folder_id', 'code', 'raw']) {
    assert.equal(Object.hasOwn(driveStatus.properties, secret), false, `Drive status leaks ${secret}`);
  }
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

test('OpenAPI documents Google Drive OAuth, test and protected disconnect paths', () => {
  for (const path of [
    '/api/v1/documents/storage/google-drive/auth',
    '/api/v1/documents/storage/google-drive/callback',
    '/api/v1/documents/storage/google-drive/test',
    '/api/v1/documents/storage/google-drive/disconnect',
  ]) {
    assert.ok(openApi.paths[path], `Drive path missing: ${path}`);
  }
  assert.ok(openApi.paths['/api/v1/documents/storage/google-drive/disconnect'].delete.responses[409]);
  assert.match(
    openApi.paths['/api/v1/documents/storage/google-drive/callback'].get.description,
    /does not select Drive/i
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

test('OpenAPI dokumentiert die Ausschluss-Semantik der Serienoperationen', () => {
  const occurrence = openApi.paths['/api/v1/calendar/{seriesId}/occurrences/{recurrenceId}'];
  const following = openApi.paths[
    '/api/v1/calendar/{seriesId}/occurrences/{recurrenceId}/following'
  ];

  assert.match(occurrence.put.description, /linked replacement existed/i);
  assert.match(occurrence.put.description, /remains excluded/i);
  assert.match(following.put.description, /every later exclusion except the selected slot/i);
  assert.match(following.delete.description, /preserves later exclusions/i);
  assert.doesNotMatch(following.delete.description, /removes .*deletion exceptions/i);
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

test('OpenAPI dokumentiert Konflikte bei Verknüpfungen zu laufend gelöschten Dokumenten', () => {
  const operations = [
    openApi.paths['/api/v1/documents/{id}/archive'].patch,
    openApi.paths['/api/v1/tasks/{id}/documents'].put,
    openApi.paths['/api/v1/housekeeping/visits/{id}'].put,
    openApi.paths['/api/v1/budget'].post,
    openApi.paths['/api/v1/budget/{id}'].put,
    openApi.paths['/api/v1/inventory/items'].post,
    openApi.paths['/api/v1/inventory/items/{id}'].put,
    openApi.paths['/api/v1/split-expenses/groups/{id}/expenses'].post,
    openApi.paths['/api/v1/split-expenses/groups/{id}/settlements'].post,
    openApi.paths['/api/v1/split-expenses/expenses/{id}'].put,
  ];
  for (const operation of operations) {
    assert.match(operation.responses[409].description, /DOCUMENT_DELETE_IN_PROGRESS/);
  }
});

test('OpenAPI erlaubt DMS-Push für local, webdav und google_drive, aber nicht dms', () => {
  const push = openApi.paths['/api/v1/documents/dms/push'].post;
  assert.match(push.description, /local.*webdav.*google_drive/i);
  assert.match(push.description, /storage_backend.*dms/i);

  const linked = openApi.components.schemas.DmsLinkResponse.properties.data;
  assert.deepEqual(linked.properties.storage_backend.enum, ['dms']);
  assert.ok(linked.required.includes('storage_backend'));
});

// ─── Mitleser eines Moduls nach einer Kontoaenderung neu holen (#1228) ──────

test('auth.updateUser holt danach /auth/me, damit othersCanRead in derselben Sitzung stimmt', async () => {
  setup();
  const calls = [];
  _mockFetch = (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${url}`);
    return mockResponse(200, { data: {}, householdSize: 1, othersCanRead: ['tasks'] });
  };

  await auth.updateUser(7, { role: 'member' });

  const patch = calls.findIndex((c) => /^PATCH .*\/auth\/users\/7$/.test(c));
  const me = calls.findIndex((c) => /^GET .*\/auth\/me$/.test(c));
  assert.ok(patch >= 0, `PATCH fehlt: ${calls.join(', ')}`);
  assert.ok(me > patch, `nach dem PATCH fehlt GET /auth/me: ${calls.join(', ')}`);
});

// ─── Gleiche Initialen im Haushalt (#1464) ──────────────────────────────────
// Der Helfer kennt den Haushalt nur aus den Auth-Antworten. Gemessen wird am
// ECHTEN Helfer: was `initials()` nach dem Aufruf liefert.

test('auth.me, login und verifyTwoFactor reichen initialsRoster an den Initialen-Helfer; logout nimmt ihn zurueck', async () => {
  const { initials, clearInitialsRoster } = await import('../public/utils/initials.js');
  for (const [name, run] of [
    ['me', () => auth.me()],
    ['login', () => auth.login('linda', 'pw')],
    ['verifyTwoFactor', () => auth.verifyTwoFactor('123456')],
  ]) {
    setup();
    clearInitialsRoster();
    assert.equal(initials('Linda Johnson'), 'LJ', `${name}: Vorbedingung`);
    _mockFetch = () => mockResponse(200, { user: {}, initialsRoster: ['Linda Johnson', 'Leo Johnson'] });
    await run();
    assert.equal(initials('Linda Johnson'), 'LI', `${name}: der Haushalt ist angekommen`);
    assert.equal(initials('Leo Johnson'), 'LE', name);
  }

  // logout() raeumt auch die Wurzelklasse des Solo-Haushalts ab und braucht
  // dafuer ein Wurzelelement, das dieser Lauf sonst nicht hat.
  const hadRoot = Object.hasOwn(globalThis.document, 'documentElement');
  const root = globalThis.document.documentElement;
  if (!root) globalThis.document.documentElement = { classList: { remove() {}, toggle() {} } };
  try {
    _mockFetch = () => mockResponse(200, {});
    await auth.logout();
  } finally {
    if (!hadRoot) delete globalThis.document.documentElement;
    else globalThis.document.documentElement = root;
  }
  assert.equal(initials('Linda Johnson'), 'LJ', 'nach dem Abmelden kennt der Helfer den Haushalt nicht mehr');
});

test('auth.updateProfile holt danach /auth/me: der eigene neue Name steht sofort im Haushalt', async () => {
  const { initials, clearInitialsRoster } = await import('../public/utils/initials.js');
  setup();
  clearInitialsRoster();
  const calls = [];
  _mockFetch = (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${url}`);
    return mockResponse(200, { user: { display_name: 'Leo Johnson' }, initialsRoster: ['Linda Johnson', 'Leo Johnson'] });
  };
  try {
    const res = await auth.updateProfile({ display_name: 'Leo Johnson' });
    assert.equal(res.user.display_name, 'Leo Johnson', 'die Antwort des PATCH kommt unveraendert zurueck');
    const patch = calls.findIndex((c) => /^PATCH .*\/auth\/me\/profile$/.test(c));
    const me = calls.findIndex((c) => /^GET .*\/auth\/me$/.test(c));
    assert.ok(patch >= 0 && me > patch, `nach dem PATCH fehlt GET /auth/me: ${calls.join(', ')}`);
    assert.equal(initials('Leo Johnson'), 'LE');
  } finally {
    clearInitialsRoster();
  }
});

// ─── #1431: 503 waehrend eines Restores ─────────────────────────────────────

test('503 mit reason restore_in_progress: uebersetzte Meldung statt englischem Servertext', async () => {
  setup();
  _mockFetch = () => mockResponse(503, {
    error: 'A backup is being restored right now. This change was not saved - try again in a minute.',
    code: 503,
    reason: 'restore_in_progress',
  });
  await assert.rejects(
    () => api.post('/tasks', { title: 'x' }),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.message, 'common.errorRestoreInProgress');
      assert.equal(err.data.reason, 'restore_in_progress');
      return true;
    },
  );
});

// ─── #1607: 403 des Modul-Gates ─────────────────────────────────────────────
// Der Server antwortet englisch; die Seiten zeigen `err.message` oder
// `err.data.error` (Gesundheit, Einstellungen) - beide tragen die Uebersetzung.

test('403 mit reason module_access_denied / module_read_only: uebersetzt in message UND data.error', async () => {
  for (const [reason, serverText, key] of [
    ['module_access_denied', 'You do not have access to this module.', 'common.errorModuleNoAccess'],
    ['module_read_only', 'You have read-only access to this module.', 'settings.permReadOnlyBanner'],
  ]) {
    setup();
    _mockFetch = () => mockResponse(403, { error: serverText, code: 403, reason });
    await assert.rejects(
      () => api.get('/health/vitals'),
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.message, key, `${reason}: message`);
        assert.equal(err.data.error, key, `${reason}: data.error`);
        assert.equal(err.data.reason, reason, 'der Grund bleibt lesbar');
        return true;
      },
    );
  }
});

// ─── #1640: Absagen mit eigenem Satz ────────────────────────────────────────
// Bis dahin kam bei diesen der englische Satz des Servers beim Nutzer an.

test('403 mit reason task_locked / recipe_mirrored / csrf_invalid: der Satz der App statt des Servertexts', async () => {
  for (const [reason, serverText, key] of [
    ['task_locked', 'This task is locked; only its creator and administrators can change it.', 'tasks.errorLocked'],
    ['recipe_mirrored', 'Mirrored recipes are managed by their source provider and cannot be edited here.', 'recipes.errorMirrored'],
    ['recipe_mirrored', 'Mirrored recipes are managed by their source provider and cannot be deleted here.', 'recipes.errorMirrored'],
    ['csrf_invalid', 'Invalid CSRF token.', 'common.errorFormExpired'],
    ['contact_email_protected', 'Only this member or an admin, signed in or with a full-access token, can change the email addresses of a household member.', 'contacts.emailLockedHint'],
  ]) {
    setup();
    _mockFetch = () => mockResponse(403, { error: serverText, code: 403, reason });
    await assert.rejects(
      () => api.get('/tasks/1'),
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.message, key, `${reason}: message`);
        assert.equal(err.data.error, key, `${reason}: data.error`);
        assert.equal(err.data.reason, reason, 'der Grund bleibt lesbar');
        return true;
      },
    );
  }
});

test('csrf_invalid bei einem Schreibzugriff: einmal wiederholt, erst dann der Satz', async () => {
  setup();
  let calls = 0;
  // Ohne Token im Kopf der Absage: der Client holt es ueber /auth/me.
  _mockFetch = (url) => {
    calls += 1;
    if (String(url).endsWith('/auth/me')) return mockResponse(200, { user: { id: 1 }, csrfToken: 'fresh' });
    return mockResponse(403, { error: 'Invalid CSRF token.', code: 403, reason: 'csrf_invalid' });
  };
  await assert.rejects(
    () => api.put('/tasks/1', { title: 'x' }),
    (err) => err.status === 403 && err.message === 'common.errorFormExpired' && err.data.error === 'common.errorFormExpired',
  );
  assert.equal(calls, 3, 'PUT, /auth/me, PUT - und kein vierter Versuch');
});

// ─── #1669: nur eine Absage wegen des Tokens wird wiederholt ────────────────
// Bis dahin ging JEDE 403 auf einen Schreibzugriff ein zweites Mal an den
// Server - auch die gesperrte Aufgabe und das fehlende Recht, an denen ein
// frisches Token nichts aendert. Gemessen wird die Zahl der Anfragen.

/** Zaehlt die Anfragen und merkt sich das Token, das jede mitbrachte. */
function countingFetch(respond) {
  const seen = [];
  _mockFetch = (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? 'GET', token: init.headers?.['X-CSRF-Token'] });
    return respond(String(url), seen.length);
  };
  return seen;
}

test('403 mit einem Grund, der nichts mit dem Token zu tun hat: genau EINE Anfrage', async () => {
  for (const [reason, serverText] of [
    ['task_locked', 'This task is locked; only its creator and administrators can change it.'],
    ['module_read_only', 'You have read-only access to this module.'],
    ['cross_module_access', 'Write access to the shopping list is required.'],
    ['not_authorized', 'Du darfst diese Terminserie nicht bearbeiten.'],
    ['some_future_reason', 'A sentence this client has never seen.'],
  ]) {
    // Mit Token im Kopf der Absage (so antwortet der Server hinter der
    // CSRF-Pruefung) und ohne (eine Sperre davor) - beide Wege der Wiederholung.
    for (const headers of [{ 'X-CSRF-Token': 'fresh' }, {}]) {
      for (const verb of ['post', 'put', 'patch', 'delete']) {
        setup();
        const seen = countingFetch(() => mockResponse(403, { error: serverText, code: 403, reason }, headers));
        await assert.rejects(
          () => (verb === 'delete' ? api.delete('/tasks/1') : api[verb]('/tasks/1', { title: 'x' })),
          (err) => err.status === 403 && err.data.reason === reason,
        );
        assert.deepEqual(
          seen.map((r) => `${r.method} ${r.url}`), [`${verb.toUpperCase()} /api/v1/tasks/1`],
          `${reason} (${verb}, ${headers['X-CSRF-Token'] ? 'mit' : 'ohne'} Token im Kopf): eine Anfrage, keine Wiederholung, kein /auth/me`,
        );
      }
    }
  }
});

test('403 mit fremdem Grund: das Token aus dem Kopf der Absage gilt trotzdem fuer die naechste Anfrage', async () => {
  setup();
  let seen = countingFetch(() => mockResponse(403, { error: 'locked', code: 403, reason: 'task_locked' }, { 'X-CSRF-Token': 'token-from-refusal' }));
  await assert.rejects(() => api.put('/tasks/1', { title: 'x' }), (err) => err.status === 403);
  assert.equal(seen.length, 1);
  seen = countingFetch(() => mockResponse(200, { data: {} }));
  await api.put('/tasks/2', { title: 'y' });
  assert.equal(seen[0].token, 'token-from-refusal');
});

test('csrf_invalid mit Token im Kopf der Absage: zwei Anfragen, die zweite mit dem neuen Token', async () => {
  setup();
  const seen = countingFetch((url, n) => (n === 1
    ? mockResponse(403, { error: 'Invalid CSRF token.', code: 403, reason: 'csrf_invalid' }, { 'X-CSRF-Token': 'renewed' })
    : mockResponse(200, { data: { id: 1 } })));
  const result = await api.put('/tasks/1', { title: 'x' });
  assert.deepEqual(result, { data: { id: 1 } });
  assert.deepEqual(seen.map((r) => `${r.method} ${r.url}`), ['PUT /api/v1/tasks/1', 'PUT /api/v1/tasks/1']);
  assert.equal(seen[1].token, 'renewed', 'die Wiederholung traegt das erneuerte Token');
});

test('csrf_invalid ohne Token im Kopf: PUT, /auth/me, PUT mit dem Token von dort', async () => {
  setup();
  const seen = countingFetch((url, n) => {
    if (url.endsWith('/auth/me')) return mockResponse(200, { user: { id: 1 }, csrfToken: 'from-me' });
    return n === 1
      ? mockResponse(403, { error: 'Invalid CSRF token.', code: 403, reason: 'csrf_invalid' })
      : mockResponse(200, { data: { id: 1 } });
  });
  await api.put('/tasks/1', { title: 'x' });
  assert.deepEqual(seen.map((r) => `${r.method} ${r.url}`), ['PUT /api/v1/tasks/1', 'GET /api/v1/auth/me', 'PUT /api/v1/tasks/1']);
  assert.equal(seen[2].token, 'from-me');
});

test('die Absage der echten CSRF-Middleware loest die Wiederholung aus', async () => {
  // Der Grund steht im Client als Konstante. Hier laeuft die Middleware selbst
  // und ihr Rumpf geht durch api.js - benennt der Server den Grund um, sind es
  // nicht mehr zwei Anfragen.
  const { csrfMiddleware } = await import('../server/middleware/csrf.js');
  const refuse = (headerToken) => {
    const out = { headers: {} };
    const res = {
      cookie() {},
      setHeader(name, value) { out.headers[name] = value; },
      status(code) { out.status = code; return this; },
      json(body) { out.body = body; return this; },
    };
    let passed = false;
    csrfMiddleware(
      { method: 'PUT', headers: { 'x-csrf-token': headerToken }, session: { csrfToken: 'a'.repeat(64) } },
      res, () => { passed = true; },
    );
    return { ...out, passed };
  };
  assert.equal(refuse('a'.repeat(64)).passed, true, 'das richtige Token kommt durch - sonst misst der Fall nichts');
  const refusal = refuse('b'.repeat(64));
  assert.equal(refusal.status, 403);
  assert.equal(typeof refusal.body.reason, 'string');

  setup();
  const seen = countingFetch((url, n) => (n === 1
    ? mockResponse(refusal.status, refusal.body, refusal.headers)
    : mockResponse(200, { data: { id: 1 } })));
  await api.put('/tasks/1', { title: 'x' });
  assert.equal(seen.length, 2, 'Absage der Middleware, dann die Wiederholung');
  assert.equal(seen[1].token, 'a'.repeat(64), 'mit dem Token aus dem Kopf der Absage');
});

test('403 ohne Grund bleibt wiederholt: ohne lesbaren Rumpf, mit leerem oder fehlendem reason', async () => {
  // Kein Grund heisst: die Absage kann von einem Proxy oder einer Sperre
  // stammen, die das Token meint, es aber nicht sagt.
  const unreadable = () => Promise.resolve({
    status: 403, ok: false, headers: { get: (name) => (name === 'X-CSRF-Token' ? 'fresh' : null) },
    json: () => Promise.reject(new SyntaxError('Unexpected token <')),
  });
  for (const [label, respond] of [
    ['HTML-Rumpf', unreadable],
    ['kein reason', () => mockResponse(403, { error: 'Not authorized.', code: 403 }, { 'X-CSRF-Token': 'fresh' })],
    ['reason null', () => mockResponse(403, { error: 'Not authorized.', code: 403, reason: null }, { 'X-CSRF-Token': 'fresh' })],
    ['reason leer', () => mockResponse(403, { error: 'Not authorized.', code: 403, reason: '' }, { 'X-CSRF-Token': 'fresh' })],
  ]) {
    setup();
    const seen = countingFetch(respond);
    await assert.rejects(() => api.post('/tasks', { title: 'x' }), (err) => err.status === 403);
    assert.equal(seen.length, 2, `${label}: einmal wiederholt`);
  }
});

test('403 auf einen Lesezugriff: nie wiederholt, mit welchem Grund auch immer', async () => {
  for (const body of [
    { error: 'Invalid CSRF token.', code: 403, reason: 'csrf_invalid' },
    { error: 'Not authorized.', code: 403 },
  ]) {
    setup();
    const seen = countingFetch(() => mockResponse(403, body, { 'X-CSRF-Token': 'fresh' }));
    await assert.rejects(() => api.get('/tasks'), (err) => err.status === 403);
    assert.equal(seen.length, 1);
  }
});

// ─── #1607: jede andere Absage ohne Grund ───────────────────────────────────
// Rund 110 Routen antworten auf fehlende Berechtigung mit einem englischen
// Satz ("Not authorized.", "Admin access required."), ein paar mit einem
// deutschen. Ohne `reason` sagt keiner davon mehr als "das darfst du nicht" -
// also ein uebersetzter Satz. Der Server bleibt sprachfrei.

test('403 ohne reason: ein uebersetzter Satz in message UND data.error', async () => {
  for (const serverText of [
    'Admin access required.', 'Not authorized.', 'Permission denied.', 'Forbidden.',
    'You cannot modify this entry.', 'Nicht autorisiert.', 'Keine Berechtigung',
  ]) {
    setup();
    _mockFetch = () => mockResponse(403, { error: serverText, code: 403 });
    await assert.rejects(
      () => api.get('/backup'),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.message, 'common.errorNoPermission', `${serverText}: message`);
        assert.equal(err.data.error, 'common.errorNoPermission', `${serverText}: data.error`);
        assert.equal(err.data.code, 403, 'der Rest des Rumpfs bleibt');
        return true;
      },
    );
  }
});

test('403 ohne reason bei einem Schreibzugriff: derselbe Satz, nach dem CSRF-Wiederholungsversuch', async () => {
  setup();
  let calls = 0;
  _mockFetch = () => {
    calls += 1;
    return mockResponse(403, { error: 'Not authorized.', code: 403 }, { 'X-CSRF-Token': 'fresh' });
  };
  await assert.rejects(
    () => api.delete('/documents/7'),
    (err) => err.status === 403 && err.message === 'common.errorNoPermission',
  );
  assert.equal(calls, 2, 'einmal wiederholt, dann die Absage');
});

// Wer einen Grund nennt, sagt mehr als "das darfst du nicht" - und eine Seite
// liest ihn (Anmeldung, Zwei-Faktor, Kalender-Anhang, Ordner loeschen) oder
// der Satz selbst ist die Auskunft (Display-Konto, Recht in einem zweiten
// Modul). Der allgemeine Satz wuerde sie verschlucken. Welche das sind, haelt
// die Liste REASONS_WITHOUT_SENTENCE weiter unten.
test('403 mit einem anderen reason: Servertext und Rumpf bleiben, wie sie sind', async () => {
  for (const [reason, serverText] of [
    ['cross_module_access', 'Write access to the shopping list is required.'],
    ['display_account', 'A paired display cannot use the account routes.'],
    ['password_login_disabled', 'Password login is disabled.'],
    ['required', 'Two-factor authentication is required for this household.'],
    ['FOLDER_DOCUMENTS_NOT_MANAGEABLE', 'Not authorized to delete every document in this folder.'],
    ['ATTACHMENT_CHANGE_REFUSED', 'Changing an attachment requires write access to documents.'],
    ['FASTING_SUBJECT_FORBIDDEN', 'This person does not permit fasting access.'],
    ['not_authorized', 'Not authorized.'],
    ['some_future_reason', 'A sentence this client has never seen.'],
  ]) {
    setup();
    const body = { error: serverText, code: 403, reason };
    _mockFetch = () => mockResponse(403, body);
    await assert.rejects(
      () => api.get('/tasks/1'),
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.message, serverText, `${reason}: message`);
        assert.deepEqual(err.data, body, `${reason}: data`);
        return true;
      },
    );
  }
});

test('403 ohne lesbaren Rumpf: kein Urteil ueber Rechte', async () => {
  // Ein vorgeschalteter Proxy antwortet mit HTML - das ist keine Absage der App.
  setup();
  _mockFetch = () => Promise.resolve({
    status: 403,
    ok: false,
    headers: { get: () => null },
    json: () => Promise.reject(new SyntaxError('Unexpected token <')),
  });
  await assert.rejects(
    () => api.get('/tasks'),
    (err) => err.status === 403 && err.message === 'HTTP 403' && err.data === null,
  );
});

test('andere Statuscodes ohne reason behalten ihren Servertext', async () => {
  for (const [status, serverText] of [
    [400, 'Title is required.'], [404, 'Task not found.'], [409, 'Category already exists.'], [500, 'Internal server error.'],
  ]) {
    setup();
    _mockFetch = () => mockResponse(status, { error: serverText, code: status });
    await assert.rejects(
      () => api.get('/tasks/1'),
      (err) => err.status === status && err.message === serverText && err.data.error === serverText,
    );
  }
});

// ─── #1607: welche Absage der allgemeine Satz ersetzen darf ─────────────────
// Die Regel oben haengt daran, dass eine 403 MIT eigener Auskunft am Server
// einen `reason` traegt. Zwei Richtungen:
//   1. die bekannten Auskuenfte tragen ihren Grund (sonst verschluckte sie der Satz),
//   2. jeder 403-Satz OHNE Grund steht in der Liste der Saetze, die nur
//      "das darfst du nicht" sagen - eine neue Absage muss sich einordnen.

const { readFileSync, readdirSync, statSync } = await import('node:fs');
const serverRoot = new URL('../server/', import.meta.url);
const serverSource = (rel) => readFileSync(new URL(rel, serverRoot), 'utf8');

const EXPLAINED_REFUSALS = [
  // [Datei, Satzanfang, Grund] - der Grund steht hoechstens 160 Zeichen dahinter.
  ['middleware/csrf.js', 'Invalid CSRF token.', 'csrf_invalid'],
  ['auth.js', 'A paired display cannot use the account routes.', 'display_account'],
  ['auth.js', 'This account cannot sign in.', 'account_cannot_sign_in'],
  ['auth.js', 'Password login is disabled.', 'password_login_disabled'],
  ['auth.js', 'Only a signed-in browser session can sign out other sessions.', 'browser_session_required'],
  ['auth.js', 'Setup has already been completed.', 'setup_completed'],
  ['auth.js', 'Two-factor authentication is required for this household.', 'required'],
  ['index.js', 'This account can only access Shared expenses.', 'split_guest_scope'],
  ['routes/tasks.js', 'This task is locked; only its creator and administrators can change it.', 'task_locked'],
  ['routes/tasks.js', 'A paired display can only tick a task off.', 'display_action'],
  ['routes/tasks.js', 'Write access to tasks is required.', 'cross_module_access'],
  ['routes/tasks.js', 'Reading linked documents requires access to documents.', 'cross_module_access'],
  ['services/display-acting.js', 'The selected person does not have access to this module.', 'acting_person_no_access'],
  ['routes/displays.js', 'This route is for paired displays.', 'display_only'],
  ['routes/recipes.js', 'Mirrored recipes are managed by their source provider and cannot be edited here.', 'recipe_mirrored'],
  ['routes/recipes.js', 'Mirrored recipes are managed by their source provider and cannot be deleted here.', 'recipe_mirrored'],
  ['routes/recipes.js', 'Write access to the shopping list is required.', 'cross_module_access'],
  ['routes/recipes.js', 'Write access to the pantry is required.', 'cross_module_access'],
  ['routes/shopping.js', 'Write access to the meal plan is required.', 'cross_module_access'],
  ['routes/shopping.js', 'Read access to the pantry is required.', 'cross_module_access'],
  ['routes/meals.js', 'Write access to the shopping list is required.', 'cross_module_access'],
  ['routes/pantry.js', 'Read access to the shopping list is required.', 'cross_module_access'],
  ['routes/housekeeping.js', 'Write access to the shopping list is required.', 'cross_module_access'],
  ['routes/birthdays.js', 'Contact access is required to import birthdays.', 'cross_module_access'],
  ['routes/split-expenses.js', 'Write access to contacts is required to add a contact without an account.', 'cross_module_access'],
  ['routes/calendar/sync-targets.js', 'Write access to the calendar is required.', 'cross_module_access'],
  // Der Satz steht in der Fehlerklasse; die Antwort baut `sendDocumentLinkRefusal`.
  ['services/document-links.js', 'err.message, code: 403', 'cross_module_access'],
  ['routes/contacts.js', 'Familienmitglieder können nicht aus der Kontaktliste gelöscht werden.', 'family_member_contact'],
  ['routes/contacts.js', 'can change the email addresses of a household member.', 'contact_email_protected'],
  ['routes/documents.js', 'Not authorized to delete every document in this folder.', 'FOLDER_DOCUMENTS_NOT_MANAGEABLE'],
];

test('jede 403 mit eigener Auskunft traegt ihren reason', () => {
  for (const [file, text, reason] of EXPLAINED_REFUSALS) {
    const src = serverSource(file);
    let from = 0;
    let seen = 0;
    for (;;) {
      const at = src.indexOf(text, from);
      if (at === -1) break;
      from = at + text.length;
      // Nur der Satz im Rumpf einer Antwort zaehlt (`error: '...'`), kein
      // Kommentar, kein Logeintrag und kein `new Error(...)` eines anderen Wegs.
      const lineStart = src.lastIndexOf('\n', at) + 1;
      if (!/^\s*(return |const \w+ = )?.*\berror: /.test(src.slice(lineStart, at))) continue;
      seen += 1;
      assert.ok(
        src.slice(at, at + text.length + 160).includes(`reason: '${reason}'`),
        `${file}: "${text}" ohne reason '${reason}' - api.js machte daraus den allgemeinen Satz`,
      );
    }
    assert.ok(seen > 0, `${file}: "${text}" steht nicht mehr da - die Liste hier ist veraltet`);
  }
});

// ─── #1640: jeder Grund einer Absage ist eingeordnet ────────────────────────
// Ein `reason` an einer 403 nimmt der Antwort den allgemeinen Satz (oben). Was
// der Nutzer stattdessen liest, entscheidet sich an genau einer von drei Stellen:
//   1. REFUSAL_MESSAGES (utils/friendly-error.js): der Satz der App,
//   2. eine Seite liest den Grund selbst und hat ihren eigenen Satz,
//   3. noch nichts - der englische Satz des Servers kommt durch.
// Die dritte Liste ist die offene Rechnung, nicht der Normalfall: ein neuer
// Grund am Server macht diesen Test rot, bis er in einer der drei steht.

const { REFUSAL_MESSAGES } = await import('../public/utils/friendly-error.js');
const publicSource = (rel) => readFileSync(new URL(`../public/${rel}`, import.meta.url), 'utf8');

// Grund -> Datei unter public/, die ihn liest.
const REASONS_READ_BY_A_PAGE = new Map([
  ['ATTACHMENT_CHANGE_REFUSED', 'pages/calendar.js'],
  ['ATTACHMENT_UPLOAD_REFUSED', 'pages/calendar.js'],
  ['FOLDER_DOCUMENTS_NOT_MANAGEABLE', 'utils/document-folder-delete.js'],
]);

const REASONS_WITHOUT_SENTENCE = new Set([
  // Je Aufruf ein anderes Modul und ein anderes Recht - ein Satz fuer alle
  // braeuchte den Modulnamen aus der Antwort.
  'cross_module_access',
  // Anmeldung und Einrichtung: die Seiten zeigen den Servertext oder lesen ihn
  // per Muster (login.js: "password login is disabled").
  'account_cannot_sign_in', 'password_login_disabled', 'setup_completed', 'required',
  'browser_session_required',
  // Wandtablett und Gastkonto: aus der Oberflaeche dieser Konten nicht erreichbar.
  'display_account', 'display_only', 'display_action', 'acting_person_no_access', 'split_guest_scope',
  // Taschengeld am Wandtablett (#1734): die Seite fragt dort gar nicht erst nach Geld.
  'money_not_on_display',
  // Die Oberflaeche bietet das Loeschen dort nicht an; der Servertext ist deutsch.
  'family_member_contact',
  'FASTING_CAPABILITY_REQUIRED', 'FASTING_SUBJECT_FORBIDDEN', 'FASTING_ACK_FORBIDDEN', 'FASTING_SETTINGS_FORBIDDEN',
  // Fremde Terminserie (Einzelausnahme): der Grund reist als `reason: error.code`
  // durch eine Variable und fehlte dem Leser bis #1669. Der Servertext ist deutsch.
  'not_authorized',
  // Haushaltsreihenfolge (#1644): das Blatt, das sie setzt, erreicht nur ein
  // Administrator, und es zeigt bei jedem Scheitern seinen eigenen Satz.
  'admin_required',
]);

// ─── #1669: ein Grund, der durch eine Variable gereicht wird ────────────────
// Der Leser unten sieht nur `reason: 'x'`. `reason: error.code` sah er nicht -
// und damit auch nicht, dass `not_authorized` an einer 403 haengt. Aufloesen
// laesst sich eine Variable aus dem Quelltext nicht ehrlich; also ist jede
// solche Stelle hier VON HAND gefuehrt: Datei und Ausdruck, wie oft er dort
// steht, und welche Gruende ueber sie an einer 403 ankommen koennen (`at403`,
// je mit der Datei, in der das Literal steht). Eine neue Stelle, eine weitere
// Wiederholung oder eine verschwundene macht den Test rot. Was er NICHT prueft:
// dass `at403` vollstaendig ist - das ist die Zusage dessen, der die Zeile schreibt.
const REASONS_PASSED_THROUGH = new Map([
  ['routes/calendar/crud.js: error.code', { sites: 1, at403: [['not_authorized', 'services/calendar-occurrence-overrides.js']],
    why: 'sendCalendarOccurrenceError: 403 nur bei not_authorized, sonst 400/404/409' }],
  ['routes/calendar/crud.js: eligibility.reason', { sites: 1, at403: [], why: 'feste 400' }],
  ['services/calendar-occurrence-overrides.js: eligible ? null : \'ineligible_series\'', { sites: 1, at403: [],
    why: 'keine Antwort; wird zu error.code und reist mit 400' }],
  ['routes/tasks.js: actor.reason', { sites: 1, at403: [['acting_person_no_access', 'services/display-acting.js']],
    why: 'displayActingPerson: 400 ohne Grund oder 403 mit diesem' }],
  ['routes/rewards.js: actor.reason', { sites: 1, at403: [['acting_person_no_access', 'services/display-acting.js']],
    why: 'displayActingPerson, wie in tasks.js' }],
  ['routes/health/fasting.js: error.reason', { sites: 1, at403: [
    ['FASTING_CAPABILITY_REQUIRED', 'services/fasting.js'], ['FASTING_SUBJECT_FORBIDDEN', 'services/fasting.js'],
    ['FASTING_ACK_FORBIDDEN', 'services/fasting.js'], ['FASTING_SETTINGS_FORBIDDEN', 'services/fasting.js'],
  ], why: 'FastingError: jeder Grund aus fail(403, ...)' }],
  ['routes/health/visibility-defaults.js: error.reason', { sites: 1, at403: [['FASTING_CAPABILITY_REQUIRED', 'services/fasting.js']],
    why: 'requireFastingCapability wirft nur diesen' }],
  ['routes/split-expenses.js: err.reason', { sites: 1, at403: [],
    why: 'Refusal: ein Grund nur an 409 (email_in_use); die 403 dort tragen keinen' }],
  ['auth.js: err.code', { sites: 1, at403: [], why: 'feste 409 (2FA)' }],
  ['routes/notes.js: result.reason', { sites: 1, at403: [], why: 'feste 409' }],
  ['routes/family.js: problem.reason', { sites: 1, at403: [], why: 'memberOrderProblem: feste 400; die 403 daneben traegt ein Literal' }],
  ['routes/tasks.js: result.reason', { sites: 1, at403: [], why: 'feste 409' }],
  ['routes/backup.js: err.reason', { sites: 1, at403: [], why: 'Restore: 409, 503 oder 400' }],
  // refuse() (#1656, #1668): die eine Stelle, ueber die jede Absage der
  // Budget-Routen ihren Grund bekommt. Ihr Status ist 400 oder, an zwei
  // Stellen ausgeschrieben, 409 - eine 403 baut sie nie.
  ['routes/budget/helpers.js: first.reason', { sites: 1, at403: [], why: '400 oder 409' }],
  ['routes/budget/loans.js: derived.reason', { sites: 1, at403: [], why: 'Vorschau: 200 mit ok: false' }],
  ['services/document-deletion-lock.js: err.reason', { sites: 1, at403: [], why: 'feste 409' }],
  ['middleware/error-handler.js: err.reason', { sites: 1, at403: [], why: 'feste 503' }],
  ['middleware/restore-gate.js: RESTORE_IN_PROGRESS_REASON', { sites: 1, at403: [], why: '503 oder 409' }],
  ['routes/weather.js: WEATHER_REASON.NOT_CONFIGURED', { sites: 1, at403: [], why: 'Antwort 200 ohne Daten' }],
  ['routes/weather.js: WEATHER_REASON.UPSTREAM_ERROR', { sites: 3, at403: [], why: 'Antwort 200 ohne Daten' }],
  ['routes/rewards.js: item.name', { sites: 1, at403: [], why: 'Buchungstext im Punktekonto, keine Antwort' }],
  ['routes/rewards.js: row.reward_name', { sites: 1, at403: [], why: 'Buchungstext im Punktekonto, keine Antwort' }],
  ['routes/rewards.js: row.note', { sites: 1, at403: [], why: 'Buchungstext im Taschengeldkonto (#1734), keine Antwort' }],
  // Eingabefehler am Taschengeld (#1734): der einzige Grund ist `currency_mismatch`, immer an einer 400.
  ['routes/rewards.js: input.reason', { sites: 1, at403: [], why: 'feste 400' }],
  ['services/reward-money.js: err.reason', { sites: 1, at403: [], why: 'Rueckgabe an die Route, dort feste 400' }],
  ['services/ics-parser.js: !uid ? \'missing UID\' : \'missing or unparsable DTSTART\'', { sites: 1, at403: [],
    why: 'onSkip fuers Log, keine Antwort' }],
]);

/**
 * Jede Stelle im Server, an der `reason` KEIN Literal bekommt: `reason: <Ausdruck>`
 * und die Kurzform `{ ..., reason }` in einer Zeile, die eine Antwort baut.
 * @returns {Map<string, number>} "Datei: Ausdruck" -> Anzahl
 */
function nonLiteralReasonSites(root = serverRoot, source = null) {
  const sites = new Map();
  const note = (key) => sites.set(key, (sites.get(key) ?? 0) + 1);
  const scan = (rel, src) => {
    for (const line of src.split('\n')) {
      if (/^\s*(\/\/|\/?\*)/.test(line)) continue;
      for (const m of line.matchAll(/\breason: (?!'[A-Za-z_]+')/g)) {
        note(`${rel}: ${reasonExpression(line.slice(m.index + m[0].length))}`);
      }
      // Die Kurzform traegt immer eine Variable. Gezaehlt nur, wo die Zeile eine
      // Antwort baut - sonst faende sie jede Destrukturierung und jede SQL-Spalte.
      if (/[{,]\s*reason\s*[,}]/.test(line) && /\.json\(|\bcode:/.test(line)) note(`${rel}: reason (Kurzform)`);
    }
  };
  if (source) { scan(source.rel, source.src); return sites; }
  (function walk(dir, rel) {
    for (const name of readdirSync(dir)) {
      if (rel === '' && name === 'openapi') continue;
      const url = new URL(name, dir);
      if (statSync(url).isDirectory()) { walk(new URL(`${name}/`, dir), `${rel}${name}/`); continue; }
      if (name.endsWith('.js')) scan(`${rel}${name}`, readFileSync(url, 'utf8'));
    }
  }(root, ''));
  return sites;
}

/** Der Ausdruck hinter `reason: ` bis zum Komma oder zur Klammer, die das Feld beendet. */
function reasonExpression(rest) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return rest.slice(0, i).trim(); depth -= 1; }
    else if (c === ',' && depth === 0) return rest.slice(0, i).trim();
  }
  return rest.trim();
}

test('jede Stelle, die einen reason durch eine Variable reicht, ist gefuehrt', () => {
  const found = nonLiteralReasonSites();
  assert.ok(found.size >= 15, `zu wenige Stellen gelesen (${found.size}) - das Muster greift nicht mehr`);
  const expected = new Map([...REASONS_PASSED_THROUGH].map(([key, { sites }]) => [key, sites]));
  const show = (map) => [...map].map(([key, n]) => `${key} (${n}x)`).sort();
  assert.deepEqual(
    show(found), show(expected),
    'ein reason wird durch eine Variable gereicht, und die Stelle ist nicht gefuehrt (oder gefuehrt und nicht mehr da): '
    + 'entweder ein Literal schreiben, oder die Stelle in REASONS_PASSED_THROUGH eintragen - mit jedem Grund, der dort an einer 403 ankommen kann',
  );
  for (const [key, { at403, why }] of REASONS_PASSED_THROUGH) {
    assert.ok(typeof why === 'string' && why.length > 0, `${key}: ohne Begruendung`);
    for (const [reason, file] of at403) {
      assert.ok(serverSource(file).includes(`'${reason}'`), `${key}: '${reason}' steht nicht mehr in server/${file}`);
    }
  }
});

test('der Leser fuer gereichte Gruende sieht, was er sehen soll', () => {
  const read = (src) => [...nonLiteralReasonSites(serverRoot, { rel: 'x.js', src })].map(([key, n]) => `${key} (${n}x)`);
  assert.deepEqual(read("res.status(403).json({ error: 'No.', code: 403, reason: 'task_locked' });"), []);
  assert.deepEqual(read('res.status(403).json({ error: e.message, code: 403, reason: e.code });'), ['x.js: e.code (1x)']);
  assert.deepEqual(read('    ...(e.conflict ? { conflict: e.conflict } : { reason: e.code }),'), ['x.js: e.code (1x)']);
  assert.deepEqual(read('res.status(403).json({ error, code: 403, reason });'), ['x.js: reason (Kurzform) (1x)']);
  assert.deepEqual(read("  reason: ok ? null : 'a_b',"), ["x.js: ok ? null : 'a_b' (1x)"]);
  assert.deepEqual(read('reason: `tpl_${x}`,'), ['x.js: `tpl_${x}` (1x)']);
  assert.deepEqual(read('reason: pick(a, b),\nreason: pick(a, b) };'), ['x.js: pick(a, b) (2x)']);
  // Kommentare, SQL-Spalten und Destrukturierung sind keine Stellen.
  assert.deepEqual(read(' * Response: 409 { code: 409, reason }\n// reason: x\nconst { ok, reason } = f();\nSELECT delta, reason, at FROM l'), []);
});

/** Jeder `reason` im Server, der an einer 403 haengt: die literalen und die gefuehrten gereichten. */
function refusalReasonsAtTheServer() {
  const reasons = new Map();
  const note = (reason, where) => { if (!reasons.has(reason)) reasons.set(reason, where); };
  (function walk(dir, rel) {
    for (const name of readdirSync(dir)) {
      if (rel === '' && name === 'openapi') continue;
      const url = new URL(name, dir);
      if (statSync(url).isDirectory()) { walk(new URL(`${name}/`, dir), `${rel}${name}/`); continue; }
      if (!name.endsWith('.js')) continue;
      const src = readFileSync(url, 'utf8');
      // `{ error: ..., code: 403, reason: 'x' }`, auch ueber mehrere Zeilen:
      // die Anweisung beginnt an der letzten Zeile mit `return` oder `const`.
      for (const m of src.matchAll(/\breason: '([A-Za-z_]+)'/g)) {
        const before = src.slice(0, m.index);
        const start = Math.max(before.lastIndexOf('return '), before.lastIndexOf('const '));
        if (start === -1) continue;
        const statement = src.slice(src.lastIndexOf('\n', start) + 1, m.index);
        if (/^\s*(\/\/|\*)/.test(statement)) continue;
        if (/\b403\b/.test(statement)) note(m[1], `${rel}${name}`);
      }
      // `fail(403, 'FASTING_...', '...')` und der Vorgabewert, den `fail(403, reason, ...)` weiterreicht.
      for (const m of src.matchAll(/\bfail\(403, '([A-Z_]+)'/g)) note(m[1], `${rel}${name}`);
      for (const m of src.matchAll(/\breason = '([A-Z_]+)'[^\n]*\n[^\n]*\bfail\(403, reason\b/g)) note(m[1], `${rel}${name}`);
    }
  }(serverRoot, ''));
  // Was durch eine Variable an eine 403 kommt, steht in REASONS_PASSED_THROUGH (#1669).
  for (const [key, { at403 }] of REASONS_PASSED_THROUGH) {
    for (const [reason] of at403) note(reason, key);
  }
  return reasons;
}

test('jeder reason, den der Server an einer 403 schickt, ist eingeordnet', () => {
  const atServer = refusalReasonsAtTheServer();
  assert.ok(atServer.size >= 20, `zu wenige Gruende gelesen (${atServer.size}) - das Muster greift nicht mehr`);
  // Die Liste der Absagen mit Auskunft weiter oben und dieser Leser sehen dasselbe.
  for (const [file, , reason] of EXPLAINED_REFUSALS) {
    assert.ok(atServer.has(reason), `${file}: reason '${reason}' steht in EXPLAINED_REFUSALS, der Leser hier findet ihn nicht`);
  }

  const classified = (reason) => [
    REFUSAL_MESSAGES.has(reason), REASONS_READ_BY_A_PAGE.has(reason), REASONS_WITHOUT_SENTENCE.has(reason),
  ].filter(Boolean).length;
  const unclassified = [...atServer].filter(([reason]) => classified(reason) === 0).map(([reason, file]) => `${file}: ${reason}`);
  assert.deepEqual(
    unclassified, [],
    'ein reason an einer 403 ohne Einordnung: er braucht einen Satz in REFUSAL_MESSAGES (utils/friendly-error.js), '
    + 'eine Seite, die ihn liest, oder einen Eintrag in REASONS_WITHOUT_SENTENCE',
  );
  const twice = [...atServer.keys()].filter((reason) => classified(reason) > 1);
  assert.deepEqual(twice, [], 'ein reason steht in zwei Listen');

  // Keine Liste fuehrt einen Grund, den der Server nicht mehr schickt.
  for (const reason of [...REFUSAL_MESSAGES.keys(), ...REASONS_READ_BY_A_PAGE.keys(), ...REASONS_WITHOUT_SENTENCE]) {
    assert.ok(atServer.has(reason), `'${reason}' ist eingeordnet, aber der Server schickt ihn an keiner 403 mehr`);
  }
  for (const [reason, file] of REASONS_READ_BY_A_PAGE) {
    assert.ok(publicSource(file).includes(`'${reason}'`), `public/${file} liest '${reason}' nicht mehr`);
  }
});

test('die drei Absagen aus #1640 haben ihren Satz, und jeder Satz steht in jeder Sprache', () => {
  assert.equal(REFUSAL_MESSAGES.get('task_locked'), 'tasks.errorLocked');
  assert.equal(REFUSAL_MESSAGES.get('recipe_mirrored'), 'recipes.errorMirrored');
  assert.equal(REFUSAL_MESSAGES.get('csrf_invalid'), 'common.errorFormExpired');

  const dir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 26, `zu wenige Sprachdateien gelesen (${files.length})`);
  const NEW_SENTENCES = new Set(['tasks.errorLocked', 'recipes.errorMirrored', 'common.errorFormExpired']);
  const sentence = (name, key) => key.split('.').reduce((node, part) => node?.[part], JSON.parse(readFileSync(new URL(name, dir), 'utf8')));
  for (const [reason, key] of REFUSAL_MESSAGES) {
    const seen = new Map();
    for (const name of files) {
      const text = sentence(name, key);
      assert.ok(typeof text === 'string' && text.trim().length > 0, `${name}: ${key} (fuer '${reason}') fehlt`);
      // Nur die neuen Saetze: ein aelterer (zh, settings.permReadOnlyBanner) traegt noch einen.
      if (NEW_SENTENCES.has(key)) assert.doesNotMatch(text, /[\u2013\u2014]/, `${name}: ${key} traegt einen Gedankenstrich`);
      seen.set(name, text);
    }
    // Eine echte Uebersetzung: der deutsche oder englische Satz steht in keiner dritten Datei.
    for (const [name, text] of seen) {
      if (name === 'de.json' || name === 'en.json') continue;
      assert.notEqual(text, seen.get('de.json'), `${name}: ${key} ist der deutsche Satz`);
      assert.notEqual(text, seen.get('en.json'), `${name}: ${key} ist der englische Satz`);
    }
  }
});

// Saetze ohne Grund: sie sagen nur, DASS die Berechtigung fehlt.
const PLAIN_REFUSALS = new Set([
  'Admin access required.', 'Not authorized.', 'Permission denied.', 'Forbidden.', 'Not allowed.',
  'Nicht autorisiert.', 'Keine Berechtigung', 'Keine Berechtigung fuer dieses Ziel.',
  'Keine Berechtigung, für diese Person einzutragen.',
  'You cannot modify this entry.', 'You cannot modify this loan.', 'You cannot modify this subscription.',
  'You cannot change a receipt you may not see.', 'Household category management is not allowed.',
  // Nur mit API-Token erreichbar, nie aus der App.
  'Token scope does not permit this operation.',
]);

test('jeder 403-Satz ohne reason sagt nur, dass die Berechtigung fehlt', () => {
  const files = [];
  (function walk(dir, rel) {
    for (const name of readdirSync(dir)) {
      if (rel === '' && name === 'openapi') continue;
      const url = new URL(name, dir);
      if (statSync(url).isDirectory()) walk(new URL(`${name}/`, dir), `${rel}${name}/`);
      else if (name.endsWith('.js')) files.push(`${rel}${name}`);
    }
  }(serverRoot, ''));

  const found = [];
  const unclassified = [];
  for (const file of files) {
    serverSource(file).split('\n').forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line) || !/\b403\b/.test(line) || line.includes('reason:')) return;
      // Der Satz der Absage: das Literal hinter `error:` oder hinter der 403.
      const m = line.match(/error: '((?:[^'\\]|\\.)*)'/) ?? line.match(/\b403, '((?:[^'\\]|\\.)*)'/);
      if (!m) return;
      // Eine Zeile mit zwei Ausgaengen (`=== 403 ? 'Not authorized.' : 'Comment not found.'`) nennt den 403-Satz zuerst.
      const text = line.match(/403 \? '((?:[^'\\]|\\.)*)'/)?.[1] ?? m[1];
      // `fail(403, 'FASTING_...', '...')` nennt an dieser Stelle den Grund, nicht den Satz.
      if (/^[A-Z_]+$/.test(text)) return;
      found.push(text);
      if (!PLAIN_REFUSALS.has(text)) unclassified.push(`${file}:${index + 1}: ${text}`);
    });
  }
  assert.ok(found.length > 80, `zu wenige Absagen gelesen (${found.length}) - das Muster greift nicht mehr`);
  assert.deepEqual(
    unclassified, [],
    'eine 403 ohne reason, deren Satz nicht als allgemein gefuehrt ist: entweder traegt sie eine Auskunft '
    + '(dann einen reason geben und oben eintragen) oder sie sagt nur "das darfst du nicht" (dann in PLAIN_REFUSALS)',
  );
});

// ─── Setup: die Sprache der Setup-Seite reist mit ───────────────────────────

test('auth.setup: schickt language mit, und laesst das Feld ohne Angabe weg', async () => {
  setup();
  const bodies = [];
  _mockFetch = (url, opts) => {
    bodies.push({ url: String(url), body: JSON.parse(opts.body) });
    return mockResponse(201, { user: { id: 1 } });
  };

  await auth.setup('admin', 'Admin', 'password123', 'de');
  await auth.setup('admin', 'Admin', 'password123');

  assert.match(bodies[0].url, /\/auth\/setup$/);
  assert.equal(bodies[0].body.language, 'de');
  // Ohne Angabe darf der Schluessel gar nicht erst im Body stehen: ein
  // Server vor der Erweiterung sieht dann exakt den alten Body.
  assert.equal(Object.hasOwn(bodies[1].body, 'language'), false);
  assert.deepEqual(Object.keys(bodies[1].body).sort(), ['display_name', 'password', 'username']);
});

test('auth.setup: schickt timezone mit, und laesst das Feld ohne Angabe weg', async () => {
  setup();
  const bodies = [];
  _mockFetch = (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return mockResponse(201, { user: { id: 1 } });
  };

  await auth.setup('admin', 'Admin', 'password123', 'de', 'Asia/Seoul');
  await auth.setup('admin', 'Admin', 'password123', 'de');

  assert.equal(bodies[0].timezone, 'Asia/Seoul');
  assert.equal(bodies[0].language, 'de');
  assert.equal(Object.hasOwn(bodies[1], 'timezone'), false);
});

test('OpenAPI beschreibt language und timezone als optionale Setup-Felder', () => {
  const schema = openApi.components.schemas.SetupRequest;
  assert.equal(schema.properties.language?.type, 'string');
  assert.equal(schema.properties.timezone?.type, 'string');
  assert.deepEqual(schema.required, ['username', 'display_name', 'password']);
  assert.ok(openApi.paths['/api/v1/auth/setup'].post.responses[400]);
});
