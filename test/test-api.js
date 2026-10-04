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
// der Satz selbst ist die Auskunft (gesperrte Aufgabe, CSRF, Display-Konto).
// Der allgemeine Satz wuerde sie verschlucken.
test('403 mit einem anderen reason: Servertext und Rumpf bleiben, wie sie sind', async () => {
  for (const [reason, serverText] of [
    ['csrf_invalid', 'Invalid CSRF token.'],
    ['task_locked', 'This task is locked; only its creator and administrators can change it.'],
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
