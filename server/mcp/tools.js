/**
 * Modul: MCP-Tools
 * Zweck: MCP-Tool-Set für den internen MCP-Endpoint. Die ursprünglichen
 *        Kern-Tools bleiben DB-gestützt und testbar ohne Server; breitere
 *        Standalone-kompatible Tools rufen die internen HTTP-API-Routen auf.
 * Abhängigkeiten: server/middleware/validate.js, server/openapi.js
 *
 * Architektur: Jedes Tool ist EIN Eintrag in TOOLS (Definition + Handler zusammen)
 *   — daraus werden `tools/list` und der Dispatch abgeleitet, damit Name, Schema
 *   und Implementierung nicht auseinanderlaufen können.
 *
 * Quelle der Validierungs-/Enum-Regeln: server/routes/tasks.js, shopping.js,
 * calendar.js. Bei Änderungen dort diese Datei mitziehen.
 */

import * as v from '../middleware/validate.js';
import { readFileSync } from 'node:fs';
import { buildOpenApiSpec } from '../openapi.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

// Spiegelt server/routes/tasks.js (bewusst dupliziert, um die Tool-Schicht von
// express/db in tasks.js zu entkoppeln — siehe Modul-Header).
const VALID_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const VALID_CATEGORIES = ['household', 'school', 'shopping', 'repair',
                          'health', 'finance', 'leisure', 'misc'];

/** Fehler mit für den aufrufenden Client (LLM) sichtbarer Nachricht. */
class ToolError extends Error {}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const DEFAULT_API_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    payload: { type: 'object', description: 'JSON request body for create/update actions.' },
    query: { type: 'object', description: 'Optional query parameters.' },
    path_params: { type: 'object', description: 'Optional path parameters for generic calls.' },
    content_data: { type: 'string', description: 'Base64 or base64 data URL for binary uploads.' },
  },
  additionalProperties: true,
};

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function openApiSpec() {
  return buildOpenApiSpec(null, pkg.version);
}

function operationKey(method, path) {
  const parts = [];
  for (const segment of path.replace(/^\/+|\/+$/g, '').split('/')) {
    if (segment === 'api' || segment === 'v1') continue;
    if (segment.startsWith('{') && segment.endsWith('}')) {
      parts.push('by', segment.slice(1, -1));
    } else {
      parts.push(segment);
    }
  }
  return `${method.toLowerCase()}_${parts.join('_') || 'root'}`
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function openApiOperations() {
  const spec = openApiSpec();
  const operations = new Map();
  const used = new Map();
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !operation || typeof operation !== 'object') continue;
      let key = operationKey(method, path);
      const count = (used.get(key) || 0) + 1;
      used.set(key, count);
      if (count > 1) key = `${key}_${count}`;
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const requestBody = operation.requestBody && typeof operation.requestBody === 'object' ? operation.requestBody : {};
      const content = requestBody.content && typeof requestBody.content === 'object' ? requestBody.content : {};
      operations.set(key, {
        operation_key: key,
        method: method.toUpperCase(),
        path,
        tag: (operation.tags || [''])[0],
        summary: operation.summary || '',
        description: operation.description || '',
        parameters,
        path_parameters: parameters.filter((p) => p.in === 'path').map((p) => p.name),
        query_parameters: parameters.filter((p) => p.in === 'query').map((p) => p.name),
        header_parameters: parameters.filter((p) => p.in === 'header' && p.name !== 'X-CSRF-Token').map((p) => p.name),
        request_body_required: Boolean(requestBody.required),
        request_content_types: Object.keys(content),
        authenticated: Boolean(operation.security),
      });
    }
  }
  return operations;
}

function publicOperationView(operation, includeParameters = false) {
  const view = {
    operation_key: operation.operation_key,
    method: operation.method,
    path: operation.path,
    tag: operation.tag,
    summary: operation.summary,
    path_parameters: operation.path_parameters,
    query_parameters: operation.query_parameters,
    request_body_required: operation.request_body_required,
    request_content_types: operation.request_content_types,
    authenticated: operation.authenticated,
  };
  if (includeParameters) {
    view.parameters = operation.parameters;
    view.description = operation.description;
    view.header_parameters = operation.header_parameters;
  }
  return view;
}

function resolveOpenApiOperation({ operation_key: key, method, path }) {
  const operations = openApiOperations();
  if (key) {
    const operation = operations.get(key);
    if (!operation) throw new ToolError(`Unknown operation_key: ${key}`);
    return operation;
  }
  if (!method || !path) throw new ToolError('Pass operation_key, or pass both method and path.');
  const normalizedMethod = String(method).toUpperCase();
  const normalizedPath = String(path).startsWith('/') ? String(path) : `/${path}`;
  for (const operation of operations.values()) {
    if (operation.method === normalizedMethod && operation.path === normalizedPath) return operation;
  }
  throw new ToolError(`OpenAPI operation not found for ${normalizedMethod} ${normalizedPath}`);
}

function renderPath(path, pathParams = {}) {
  return path.replace(/\{([^}]+)\}/g, (_match, name) => {
    if (pathParams[name] === undefined || pathParams[name] === null) {
      throw new ToolError(`Missing path parameter: ${name}`);
    }
    return encodeURIComponent(String(pathParams[name]));
  });
}

function contentBytes(contentData) {
  let raw = String(contentData || '').trim();
  if (raw.startsWith('data:')) {
    const match = raw.match(/^data:[^;,]+;base64,(.+)$/is);
    if (!match) throw new ToolError('content_data must be a valid base64 data URL.');
    raw = match[1];
  }
  raw = raw.replace(/\s+/g, '');
  if (!raw) throw new ToolError('content_data is required.');
  return Buffer.from(raw, 'base64');
}

function internalBaseUrl() {
  return (
    process.env.MCP_INTERNAL_BASE_URL
    || process.env.BASE_URL
    || `http://127.0.0.1:${process.env.PORT || 3000}`
  ).replace(/\/+$/, '');
}

function forwardedAuthHeaders(ctx) {
  const headers = {};
  const source = ctx.requestHeaders || {};
  const auth = source.authorization || source.Authorization;
  const apiKey = source['x-api-key'] || source['X-API-Key'];
  const primaryApiKey = source['api-key'] || source['API-Key'];
  const cookie = source.cookie || source.Cookie;
  const csrf = source['x-csrf-token'] || source['X-CSRF-Token'];
  if (auth) headers.Authorization = auth;
  if (apiKey) headers['X-API-Key'] = apiKey;
  if (primaryApiKey) {
    headers['API-Key'] = primaryApiKey;
    if (!apiKey) headers['X-API-Key'] = primaryApiKey;
  }
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  return headers;
}

async function internalApiRequest(ctx, method, path, { query, payload, contentData, contentType } = {}) {
  const url = new URL(path, `${internalBaseUrl()}/`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { Accept: 'application/json', ...forwardedAuthHeaders(ctx) };
  const options = { method, headers };
  if (contentData !== undefined && contentData !== null) {
    options.body = contentBytes(contentData);
    headers['Content-Type'] = contentType || 'application/octet-stream';
  } else if (!['GET', 'HEAD'].includes(method.toUpperCase()) && payload !== undefined) {
    options.body = JSON.stringify(payload ?? {});
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, options);
  const responseContentType = response.headers.get('content-type') || '';
  let data;
  if (responseContentType.includes('application/json')) {
    data = await response.json().catch(() => null);
  } else if (responseContentType.startsWith('text/') || responseContentType.includes('text/calendar')) {
    data = { text: await response.text(), content_type: responseContentType };
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());
    data = buffer.length
      ? {
          content_base64: buffer.toString('base64'),
          content_type: responseContentType,
          content_length: buffer.length,
        }
      : null;
  }

  if (!response.ok) {
    const message = data && typeof data === 'object' && data.error
      ? data.error
      : `HTTP ${response.status}`;
    throw new ToolError(`${message}`);
  }
  return data;
}

function argumentPayload(args, fallback = {}) {
  if (args.payload && typeof args.payload === 'object') return args.payload;
  if (args.updates && typeof args.updates === 'object') return args.updates;
  return fallback;
}

function apiTool(name, description, method, path, build = () => ({})) {
  return {
    name,
    description,
    inputSchema: DEFAULT_API_TOOL_SCHEMA,
    handler: (ctx, args) => {
      const request = build(args || {});
      return internalApiRequest(ctx, method, renderPath(path, request.pathParams || {}), {
        query: request.query,
        payload: request.payload,
        contentData: request.contentData,
        contentType: request.contentType,
      });
    },
  };
}

// --------------------------------------------------------
// Tool-Implementierungen (reine Funktionen)
// --------------------------------------------------------

function listTasks(db, args) {
  let sql = `
    SELECT id, title, status, priority, category, due_date, due_time
    FROM tasks
    WHERE parent_task_id IS NULL
  `;
  const params = [];
  if (args.status) {
    const s = v.oneOf(args.status, ['open', 'in_progress', 'done', 'archived'], 'status');
    if (s.error) throw new ToolError(s.error);
    sql += ' AND status = ?';
    params.push(args.status);
  } else {
    sql += " AND status != 'archived'";
  }
  sql += `
    ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, created_at DESC
    LIMIT 100
  `;
  return db.prepare(sql).all(...params);
}

function createTask(db, actorId, args) {
  const title = v.str(args.title, 'title', { required: true });
  const description = v.str(args.description, 'description', { required: false, max: v.MAX_TEXT });
  const priority = v.oneOf(args.priority, VALID_PRIORITIES, 'priority');
  const category = v.oneOf(args.category, VALID_CATEGORIES, 'category');
  const dueDate = v.date(args.due_date, 'due_date');
  const dueTime = v.time(args.due_time, 'due_time');

  const errors = v.collectErrors([title, description, priority, category, dueDate, dueTime]);
  if (errors.length) throw new ToolError(errors.join(' '));

  const result = db.prepare(`
    INSERT INTO tasks (title, description, category, priority, due_date, due_time, created_by, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
  `).run(
    title.value,
    description.value,
    category.value || 'Sonstiges',
    priority.value || 'none',
    dueDate.value,
    dueTime.value,
    actorId,
  );

  return db.prepare(
    'SELECT id, title, status, priority, category, due_date, due_time FROM tasks WHERE id = ?'
  ).get(result.lastInsertRowid);
}

function listShoppingItems(db, args) {
  let sql = `
    SELECT si.id, si.name, si.quantity, si.category, si.is_checked, sl.name AS list
    FROM shopping_items si
    JOIN shopping_lists sl ON sl.id = si.list_id
  `;
  if (args.include_checked !== true) sql += ' WHERE si.is_checked = 0';
  sql += ' ORDER BY si.created_at DESC LIMIT 200';
  return db.prepare(sql).all();
}

function addShoppingItem(db, actorId, args) {
  const name = v.str(args.name, 'name', { required: true });
  const quantity = v.str(args.quantity, 'quantity', { required: false, max: v.MAX_SHORT });
  const category = v.str(args.category, 'category', { required: false, max: v.MAX_SHORT });

  const errors = v.collectErrors([name, quantity, category]);
  if (errors.length) throw new ToolError(errors.join(' '));

  const list = args.list
    ? db.prepare('SELECT id FROM shopping_lists WHERE name = ? ORDER BY id LIMIT 1').get(String(args.list).trim())
    : db.prepare('SELECT id FROM shopping_lists ORDER BY id LIMIT 1').get();

  if (!list) {
    throw new ToolError(args.list
      ? `No shopping list named "${args.list}" found.`
      : 'No shopping list exists yet. Create one in the app first.');
  }

  const result = db.prepare(`
    INSERT INTO shopping_items (list_id, name, quantity, category)
    VALUES (?, ?, ?, ?)
  `).run(list.id, name.value, quantity.value, category.value || 'Sonstiges');

  return db.prepare(`
    SELECT si.id, si.name, si.quantity, si.category, si.is_checked, sl.name AS list
    FROM shopping_items si JOIN shopping_lists sl ON sl.id = si.list_id
    WHERE si.id = ?
  `).get(result.lastInsertRowid);
}

function listUpcomingEvents(db, args) {
  let limit = parseInt(args.limit, 10);
  if (!Number.isFinite(limit)) limit = 20;
  limit = Math.min(Math.max(limit, 1), 100);
  return db.prepare(`
    SELECT id, title, start_datetime, end_datetime, all_day, location
    FROM calendar_events
    WHERE date(start_datetime) >= date('now')
    ORDER BY start_datetime ASC
    LIMIT ?
  `).all(limit);
}

function createEvent(db, actorId, args) {
  const title = v.str(args.title, 'title', { required: true });
  const start = v.datetime(args.start_datetime, 'start_datetime', true);
  const end = v.datetime(args.end_datetime, 'end_datetime', false);
  const location = v.str(args.location, 'location', { required: false, max: v.MAX_SHORT });
  const description = v.str(args.description, 'description', { required: false, max: v.MAX_TEXT });

  const errors = v.collectErrors([title, start, end, location, description]);
  if (errors.length) throw new ToolError(errors.join(' '));

  const result = db.prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, all_day, location, created_by, external_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'local')
  `).run(
    title.value,
    description.value,
    start.value,
    end.value,
    args.all_day === true ? 1 : 0,
    location.value,
    actorId,
  );

  return db.prepare(`
    SELECT id, title, start_datetime, end_datetime, all_day, location
    FROM calendar_events WHERE id = ?
  `).get(result.lastInsertRowid);
}

// --------------------------------------------------------
// Registry: Definition + Handler je Tool an EINER Stelle.
// `handler(ctx, args)` mit ctx = { db, actor: { id, role } }.
// --------------------------------------------------------

const TOOLS = [
  {
    name: 'list_tasks',
    description: 'List the family\'s current top-level tasks (open by default). Optionally filter by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'archived'], description: 'Filter by task status.' },
      },
    },
    handler: (ctx, args) => listTasks(ctx.db, args),
  },
  {
    name: 'create_task',
    description: 'Create a new task on the family planner.',
    inputSchema: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'Short task title (required).' },
        description: { type: 'string', description: 'Optional longer description.' },
        category:    { type: 'string', enum: VALID_CATEGORIES, description: 'Optional category.' },
        priority:    { type: 'string', enum: VALID_PRIORITIES, description: 'Optional priority (default none).' },
        due_date:    { type: 'string', description: 'Optional due date, format YYYY-MM-DD.' },
        due_time:    { type: 'string', description: 'Optional due time, format HH:MM.' },
      },
      required: ['title'],
    },
    handler: (ctx, args) => createTask(ctx.db, ctx.actor.id, args),
  },
  {
    name: 'list_shopping_items',
    description: 'List shopping items across all lists (unchecked by default).',
    inputSchema: {
      type: 'object',
      properties: {
        include_checked: { type: 'boolean', description: 'Also include already-checked items.' },
      },
    },
    handler: (ctx, args) => listShoppingItems(ctx.db, args),
  },
  {
    name: 'add_shopping_item',
    description: 'Add an item to a shopping list. Uses the first list if none is named.',
    inputSchema: {
      type: 'object',
      properties: {
        name:     { type: 'string', description: 'Item name (required).' },
        quantity: { type: 'string', description: 'Optional quantity, e.g. "2" or "500 g".' },
        category: { type: 'string', description: 'Optional category.' },
        list:     { type: 'string', description: 'Optional target list name.' },
      },
      required: ['name'],
    },
    handler: (ctx, args) => addShoppingItem(ctx.db, ctx.actor.id, args),
  },
  {
    name: 'list_upcoming_events',
    description: 'List upcoming calendar events from today onward.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max number of events (1-100, default 20).' },
      },
    },
    handler: (ctx, args) => listUpcomingEvents(ctx.db, args),
  },
  {
    name: 'create_event',
    description: 'Create a calendar event.',
    inputSchema: {
      type: 'object',
      properties: {
        title:          { type: 'string', description: 'Event title (required).' },
        start_datetime: { type: 'string', description: 'Start, format YYYY-MM-DD or YYYY-MM-DDTHH:MM (required).' },
        end_datetime:   { type: 'string', description: 'Optional end, same format as start.' },
        all_day:        { type: 'boolean', description: 'Whether the event lasts all day.' },
        location:       { type: 'string', description: 'Optional location.' },
        description:    { type: 'string', description: 'Optional description.' },
      },
      required: ['title', 'start_datetime'],
    },
    handler: (ctx, args) => createEvent(ctx.db, ctx.actor.id, args),
  },
];

const OPENAPI_TOOLS = [
  {
    name: 'list_api_operations',
    description: 'List all FamilyPlanner API operations available through call_api_operation.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Optional OpenAPI tag filter.' },
        search: { type: 'string', description: 'Optional text search across key, path, tag and summary.' },
        include_parameters: { type: 'boolean', description: 'Include full OpenAPI parameter metadata.' },
      },
    },
    handler: (_ctx, args) => {
      const tagFilter = args.tag ? normalizeText(args.tag) : '';
      const searchFilter = args.search ? normalizeText(args.search) : '';
      const operations = [];
      for (const operation of openApiOperations().values()) {
        const haystack = normalizeText([
          operation.operation_key,
          operation.method,
          operation.path,
          operation.tag,
          operation.summary,
          operation.description,
        ].join(' '));
        if (tagFilter && normalizeText(operation.tag) !== tagFilter) continue;
        if (searchFilter && !haystack.includes(searchFilter)) continue;
        operations.push(publicOperationView(operation, args.include_parameters === true));
      }
      operations.sort((a, b) => `${a.tag} ${a.path} ${a.method}`.localeCompare(`${b.tag} ${b.path} ${b.method}`));
      return { count: operations.length, operations };
    },
  },
  {
    name: 'get_api_operation',
    description: 'Return OpenAPI metadata for one operation key.',
    inputSchema: {
      type: 'object',
      properties: {
        operation_key: { type: 'string', description: 'Operation key returned by list_api_operations.' },
      },
      required: ['operation_key'],
    },
    handler: (_ctx, args) => publicOperationView(resolveOpenApiOperation(args), true),
  },
  {
    name: 'call_api_operation',
    description: 'Call any FamilyPlanner API operation from the current OpenAPI spec.',
    inputSchema: {
      type: 'object',
      properties: {
        operation_key: { type: 'string', description: 'Operation key returned by list_api_operations.' },
        method: { type: 'string', description: 'HTTP method, used with path when operation_key is omitted.' },
        path: { type: 'string', description: 'OpenAPI path, used with method when operation_key is omitted.' },
        path_params: { type: 'object', description: 'Values for path template parameters.' },
        query: { type: 'object', description: 'Query string parameters.' },
        payload: { description: 'JSON request body.' },
        content_data: { type: 'string', description: 'Base64 or base64 data URL for binary uploads.' },
      },
    },
    handler: (ctx, args) => {
      const operation = resolveOpenApiOperation(args);
      const path = renderPath(operation.path, args.path_params || {});
      const contentTypes = operation.request_content_types || [];
      const contentType = contentTypes.includes('application/octet-stream')
        ? 'application/octet-stream'
        : contentTypes[0];
      return internalApiRequest(ctx, operation.method, path, {
        query: args.query,
        payload: args.payload,
        contentData: args.content_data,
        contentType,
      });
    },
  },
];

const STANDALONE_API_TOOLS = [
  apiTool('server_health', 'Check FamilyPlanner server reachability without authentication.', 'GET', '/health'),
  apiTool('server_version', 'Fetch the FamilyPlanner application version.', 'GET', '/api/v1/version'),
  {
    name: 'get_openapi_spec',
    description: 'Return the live FamilyPlanner OpenAPI specification.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => openApiSpec(),
  },
  {
    name: 'auth_status',
    description: 'Inspect current MCP authentication state.',
    inputSchema: { type: 'object', properties: {} },
    handler: (ctx) => ({
      authenticated: Boolean(ctx.actor?.id),
      actor: ctx.actor,
      internal_base_url: internalBaseUrl(),
      forwards_authorization_header: Boolean(ctx.requestHeaders?.authorization || ctx.requestHeaders?.Authorization),
      forwards_api_key_header: Boolean(
        ctx.requestHeaders?.['x-api-key']
        || ctx.requestHeaders?.['X-API-Key']
        || ctx.requestHeaders?.['api-key']
        || ctx.requestHeaders?.['API-Key']
      ),
    }),
  },
  {
    name: 'configure_api_key',
    description: 'Compatibility no-op: the internal MCP uses the request authentication handled by FamilyPlanner.',
    inputSchema: { type: 'object', properties: { api_key: { type: 'string' } } },
    handler: () => ({ configured: false, message: 'Internal MCP uses the authenticated /mcp request; configure API tokens in FamilyPlanner.' }),
  },
  {
    name: 'clear_api_key',
    description: 'Compatibility no-op: the internal MCP does not store API keys in process memory.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ configured: false, message: 'Internal MCP does not store API keys.' }),
  },
  apiTool('current_user', 'Return the current authenticated FamilyPlanner user.', 'GET', '/api/v1/auth/me'),
  apiTool('create_initial_admin', 'Run first-time setup to create the initial admin account.', 'POST', '/api/v1/auth/setup', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('login', 'Authenticate with username and password.', 'POST', '/api/v1/auth/login', (a) => ({ payload: argumentPayload(a, { username: a.username, password: a.password }) })),
  apiTool('logout', 'Log out the current web session.', 'POST', '/api/v1/auth/logout', () => ({ payload: {} })),
  apiTool('change_my_password', 'Change the current user password.', 'PATCH', '/api/v1/auth/me/password', (a) => ({ payload: argumentPayload(a, { currentPassword: a.current_password, newPassword: a.new_password }) })),
  apiTool('update_my_profile', 'Update the current user profile.', 'PATCH', '/api/v1/auth/me/profile', (a) => ({ payload: argumentPayload(a, a.updates || {}) })),
  apiTool('list_users', 'List FamilyPlanner users. Admin-only.', 'GET', '/api/v1/auth/users'),
  apiTool('create_user', 'Create a FamilyPlanner user. Admin-only.', 'POST', '/api/v1/auth/users', (a) => ({ payload: argumentPayload(a, a.user || a) })),
  apiTool('delete_user', 'Delete a FamilyPlanner user. Admin-only.', 'DELETE', '/api/v1/auth/users/{id}', (a) => ({ pathParams: { id: a.user_id ?? a.id } })),
  apiTool('update_user', 'Update a FamilyPlanner user. Admin-only.', 'PATCH', '/api/v1/auth/users/{id}', (a) => ({ pathParams: { id: a.user_id ?? a.id }, payload: argumentPayload(a, a.updates || {}) })),
  apiTool('list_api_tokens', 'List FamilyPlanner API tokens. Admin-only.', 'GET', '/api/v1/auth/api-tokens'),
  apiTool('create_api_token', 'Create a FamilyPlanner API token. Admin-only.', 'POST', '/api/v1/auth/api-tokens', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('revoke_api_token', 'Revoke a FamilyPlanner API token. Admin-only.', 'DELETE', '/api/v1/auth/api-tokens/{id}', (a) => ({ pathParams: { id: a.token_id ?? a.id } })),
  apiTool('get_dashboard', 'Fetch the FamilyPlanner dashboard payload.', 'GET', '/api/v1/dashboard'),
  apiTool('search', 'Search across FamilyPlanner modules.', 'GET', '/api/v1/search', (a) => ({ query: { q: a.query ?? a.q } })),
  apiTool('get_preferences', 'Fetch preferences.', 'GET', '/api/v1/preferences'),
  apiTool('update_preferences', 'Update preferences.', 'PUT', '/api/v1/preferences', (a) => ({ payload: argumentPayload(a, a.updates || {}) })),
  apiTool('get_task', 'Fetch one task.', 'GET', '/api/v1/tasks/{id}', (a) => ({ pathParams: { id: a.task_id ?? a.id } })),
  apiTool('update_task', 'Update a task.', 'PUT', '/api/v1/tasks/{id}', (a) => ({ pathParams: { id: a.task_id ?? a.id }, payload: argumentPayload(a, a.updates || {}) })),
  apiTool('set_task_status', 'Update task status.', 'PATCH', '/api/v1/tasks/{id}/status', (a) => ({ pathParams: { id: a.task_id ?? a.id }, payload: { status: a.status } })),
  apiTool('delete_task', 'Delete a task.', 'DELETE', '/api/v1/tasks/{id}', (a) => ({ pathParams: { id: a.task_id ?? a.id } })),
  apiTool('list_task_meta', 'Fetch task metadata.', 'GET', '/api/v1/tasks/meta/options'),
  apiTool('list_shopping_lists', 'List shopping lists.', 'GET', '/api/v1/shopping'),
  apiTool('create_shopping_list', 'Create a shopping list.', 'POST', '/api/v1/shopping', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('update_shopping_list', 'Update a shopping list.', 'PUT', '/api/v1/shopping/{id}', (a) => ({ pathParams: { id: a.list_id ?? a.id }, payload: argumentPayload(a, a) })),
  apiTool('delete_shopping_list', 'Delete a shopping list.', 'DELETE', '/api/v1/shopping/{id}', (a) => ({ pathParams: { id: a.list_id ?? a.id } })),
  apiTool('update_shopping_item', 'Update a shopping item.', 'PATCH', '/api/v1/shopping/items/{id}', (a) => ({ pathParams: { id: a.item_id ?? a.id }, payload: argumentPayload(a, a.updates || {}) })),
  apiTool('delete_shopping_item', 'Delete a shopping item.', 'DELETE', '/api/v1/shopping/items/{id}', (a) => ({ pathParams: { id: a.item_id ?? a.id } })),
  apiTool('clear_checked_shopping_items', 'Delete checked shopping items from a list.', 'DELETE', '/api/v1/shopping/{id}/items/checked', (a) => ({ pathParams: { id: a.list_id ?? a.id } })),
  apiTool('list_shopping_categories', 'List shopping categories.', 'GET', '/api/v1/shopping/categories'),
  apiTool('create_shopping_category', 'Create a shopping category.', 'POST', '/api/v1/shopping/categories', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('update_shopping_category', 'Update a shopping category.', 'PUT', '/api/v1/shopping/categories/{id}', (a) => ({ pathParams: { id: a.category_id ?? a.cat_id ?? a.id }, payload: argumentPayload(a, a) })),
  apiTool('delete_shopping_category', 'Delete a shopping category.', 'DELETE', '/api/v1/shopping/categories/{id}', (a) => ({ pathParams: { id: a.category_id ?? a.cat_id ?? a.id } })),
  apiTool('reorder_shopping_categories', 'Reorder shopping categories.', 'PATCH', '/api/v1/shopping/categories/reorder', (a) => ({ payload: argumentPayload(a, { order: a.order }) })),
  apiTool('shopping_suggestions', 'Get shopping suggestions.', 'GET', '/api/v1/shopping/suggestions', (a) => ({ query: { q: a.query ?? a.q } })),
  apiTool('list_meals', 'List meal plan entries.', 'GET', '/api/v1/meals', (a) => ({ query: { week: a.week } })),
  apiTool('meal_suggestions', 'Get meal suggestions.', 'GET', '/api/v1/meals/suggestions', (a) => ({ query: { q: a.query ?? a.q } })),
  apiTool('create_meal', 'Create a meal plan entry.', 'POST', '/api/v1/meals', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('update_meal', 'Update a meal plan entry.', 'PUT', '/api/v1/meals/{id}', (a) => ({ pathParams: { id: a.meal_id ?? a.id }, payload: argumentPayload(a, a.updates || {}) })),
  apiTool('delete_meal', 'Delete a meal plan entry.', 'DELETE', '/api/v1/meals/{id}', (a) => ({ pathParams: { id: a.meal_id ?? a.id } })),
  apiTool('add_meal_ingredient', 'Add a meal ingredient.', 'POST', '/api/v1/meals/{id}/ingredients', (a) => ({ pathParams: { id: a.meal_id ?? a.id }, payload: argumentPayload(a, a) })),
  apiTool('update_meal_ingredient', 'Update a meal ingredient.', 'PATCH', '/api/v1/meals/ingredients/{id}', (a) => ({ pathParams: { id: a.ingredient_id ?? a.ing_id ?? a.id }, payload: argumentPayload(a, a.updates || {}) })),
  apiTool('delete_meal_ingredient', 'Delete a meal ingredient.', 'DELETE', '/api/v1/meals/ingredients/{id}', (a) => ({ pathParams: { id: a.ingredient_id ?? a.ing_id ?? a.id } })),
  apiTool('add_meal_to_shopping_list', 'Transfer meal ingredients to a shopping list.', 'POST', '/api/v1/meals/{id}/to-shopping-list', (a) => ({ pathParams: { id: a.meal_id ?? a.id }, payload: argumentPayload(a, a) })),
  apiTool('add_week_meals_to_shopping_list', 'Transfer weekly meal ingredients to a shopping list.', 'POST', '/api/v1/meals/week-to-shopping-list', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('list_recipes', 'List recipes.', 'GET', '/api/v1/recipes'),
  apiTool('create_recipe', 'Create a recipe.', 'POST', '/api/v1/recipes', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('update_recipe', 'Update a recipe.', 'PUT', '/api/v1/recipes/{id}', (a) => ({ pathParams: { id: a.recipe_id ?? a.id }, payload: argumentPayload(a, a.updates || {}) })),
  apiTool('delete_recipe', 'Delete a recipe.', 'DELETE', '/api/v1/recipes/{id}', (a) => ({ pathParams: { id: a.recipe_id ?? a.id } })),
  apiTool('list_calendar_events', 'List calendar events.', 'GET', '/api/v1/calendar', (a) => ({ query: { from: a.from_date ?? a.from, to: a.to_date ?? a.to, assigned_to: a.assigned_to, source: a.source } })),
  apiTool('get_calendar_event', 'Fetch one calendar event.', 'GET', '/api/v1/calendar/{id}', (a) => ({ pathParams: { id: a.event_id ?? a.id } })),
  apiTool('create_calendar_event', 'Create a calendar event.', 'POST', '/api/v1/calendar', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('update_calendar_event', 'Update a calendar event.', 'PUT', '/api/v1/calendar/{id}', (a) => ({ pathParams: { id: a.event_id ?? a.id }, payload: argumentPayload(a, a.updates || {}) })),
  apiTool('reset_calendar_event_recurrence', 'Reset an external calendar event instance.', 'POST', '/api/v1/calendar/{id}/reset', (a) => ({ pathParams: { id: a.event_id ?? a.id }, payload: argumentPayload(a, {}) })),
  apiTool('delete_calendar_event', 'Delete a calendar event.', 'DELETE', '/api/v1/calendar/{id}', (a) => ({ pathParams: { id: a.event_id ?? a.id } })),
  apiTool('calendar_google_status', 'Fetch Google Calendar status.', 'GET', '/api/v1/calendar/google/status'),
  apiTool('calendar_google_auth_url', 'Start Google Calendar OAuth.', 'GET', '/api/v1/calendar/google/auth'),
  apiTool('calendar_google_sync', 'Run Google Calendar sync.', 'POST', '/api/v1/calendar/google/sync', () => ({ payload: {} })),
  apiTool('calendar_google_disconnect', 'Disconnect Google Calendar.', 'DELETE', '/api/v1/calendar/google/disconnect'),
  apiTool('calendar_apple_status', 'Fetch Apple Calendar status.', 'GET', '/api/v1/calendar/apple/status'),
  apiTool('calendar_apple_connect', 'Connect Apple Calendar.', 'POST', '/api/v1/calendar/apple/connect', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('calendar_apple_sync', 'Run Apple Calendar sync.', 'POST', '/api/v1/calendar/apple/sync', () => ({ payload: {} })),
  apiTool('calendar_apple_disconnect', 'Disconnect Apple Calendar.', 'DELETE', '/api/v1/calendar/apple/disconnect'),
  apiTool('list_calendar_subscriptions', 'List ICS subscriptions.', 'GET', '/api/v1/calendar/subscriptions'),
  apiTool('create_calendar_subscription', 'Create an ICS subscription.', 'POST', '/api/v1/calendar/subscriptions', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('update_calendar_subscription', 'Update an ICS subscription.', 'PATCH', '/api/v1/calendar/subscriptions/{id}', (a) => ({ pathParams: { id: a.subscription_id ?? a.id }, payload: argumentPayload(a, a.updates || {}) })),
  apiTool('sync_calendar_subscription', 'Sync an ICS subscription.', 'POST', '/api/v1/calendar/subscriptions/{id}/sync', (a) => ({ pathParams: { id: a.subscription_id ?? a.id }, payload: {} })),
  apiTool('delete_calendar_subscription', 'Delete an ICS subscription.', 'DELETE', '/api/v1/calendar/subscriptions/{id}', (a) => ({ pathParams: { id: a.subscription_id ?? a.id } })),
  apiTool('get_document_meta_options', 'Fetch document metadata options.', 'GET', '/api/v1/documents/meta/options'),
  apiTool('list_documents', 'List family documents.', 'GET', '/api/v1/documents', (a) => ({ query: { status: a.status, category: a.category } })),
  apiTool('create_document', 'Upload a family document.', 'POST', '/api/v1/documents', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('update_document', 'Update family document metadata.', 'PUT', '/api/v1/documents/{id}', (a) => ({ pathParams: { id: a.document_id ?? a.id }, payload: argumentPayload(a, a.updates || {}) })),
  apiTool('archive_document', 'Archive or restore a family document.', 'PATCH', '/api/v1/documents/{id}/archive', (a) => ({ pathParams: { id: a.document_id ?? a.id }, payload: { archived: a.archived !== false } })),
  apiTool('download_document', 'Download a family document file as base64 content.', 'GET', '/api/v1/documents/{id}/download', (a) => ({ pathParams: { id: a.document_id ?? a.id } })),
  apiTool('delete_document', 'Delete a family document.', 'DELETE', '/api/v1/documents/{id}', (a) => ({ pathParams: { id: a.document_id ?? a.id } })),
  apiTool('backup_status', 'Fetch backup status.', 'GET', '/api/v1/backup/status'),
  apiTool('download_database_backup', 'Download a database backup as base64 content.', 'GET', '/api/v1/backup/database'),
  apiTool('restore_database_backup', 'Restore a database backup.', 'POST', '/api/v1/backup/restore', (a) => ({ contentData: a.content_data, contentType: 'application/octet-stream' })),
  apiTool('list_notes', 'List notes.', 'GET', '/api/v1/notes'),
  apiTool('create_note', 'Create a note.', 'POST', '/api/v1/notes', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('update_note', 'Update a note.', 'PUT', '/api/v1/notes/{id}', (a) => ({ pathParams: { id: a.note_id ?? a.id }, payload: argumentPayload(a, a.updates || {}) })),
  apiTool('pin_note', 'Pin or unpin a note.', 'PATCH', '/api/v1/notes/{id}/pin', (a) => ({ pathParams: { id: a.note_id ?? a.id }, payload: { pinned: a.pinned } })),
  apiTool('delete_note', 'Delete a note.', 'DELETE', '/api/v1/notes/{id}', (a) => ({ pathParams: { id: a.note_id ?? a.id } })),
  apiTool('list_contacts', 'List contacts.', 'GET', '/api/v1/contacts'),
  apiTool('get_contact_meta', 'Fetch contact metadata.', 'GET', '/api/v1/contacts/meta'),
  apiTool('create_contact', 'Create a contact.', 'POST', '/api/v1/contacts', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('update_contact', 'Update a contact.', 'PUT', '/api/v1/contacts/{id}', (a) => ({ pathParams: { id: a.contact_id ?? a.id }, payload: argumentPayload(a, a.updates || {}) })),
  apiTool('delete_contact', 'Delete a contact.', 'DELETE', '/api/v1/contacts/{id}', (a) => ({ pathParams: { id: a.contact_id ?? a.id } })),
  apiTool('export_contact_vcard', 'Export a contact as vCard.', 'GET', '/api/v1/contacts/{id}/vcard', (a) => ({ pathParams: { id: a.contact_id ?? a.id } })),
  apiTool('list_family_members', 'List available family members.', 'GET', '/api/v1/family/members'),
  apiTool('list_birthdays', 'List birthdays.', 'GET', '/api/v1/birthdays'),
  apiTool('get_birthday_meta_options', 'Fetch birthday metadata options.', 'GET', '/api/v1/birthdays/meta/options'),
  apiTool('list_upcoming_birthdays', 'List upcoming birthdays.', 'GET', '/api/v1/birthdays/upcoming'),
  apiTool('create_birthday', 'Create a birthday entry.', 'POST', '/api/v1/birthdays', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('update_birthday', 'Update a birthday entry.', 'PUT', '/api/v1/birthdays/{id}', (a) => ({ pathParams: { id: a.birthday_id ?? a.id }, payload: argumentPayload(a, a.updates || {}) })),
  apiTool('delete_birthday', 'Delete a birthday entry.', 'DELETE', '/api/v1/birthdays/{id}', (a) => ({ pathParams: { id: a.birthday_id ?? a.id } })),
  apiTool('list_budget_entries', 'List budget entries.', 'GET', '/api/v1/budget', (a) => ({ query: { month: a.month, category: a.category, type: a.type_filter ?? a.type } })),
  apiTool('get_budget_summary', 'Fetch budget summary.', 'GET', '/api/v1/budget/summary', (a) => ({ query: { month: a.month } })),
  apiTool('get_budget_meta', 'Fetch budget metadata.', 'GET', '/api/v1/budget/meta'),
  apiTool('list_budget_categories', 'List budget categories.', 'GET', '/api/v1/budget/categories', (a) => ({ query: { lang: a.lang } })),
  apiTool('create_budget_category', 'Create a budget category.', 'POST', '/api/v1/budget/categories', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('list_budget_subcategories', 'List budget subcategories.', 'GET', '/api/v1/budget/categories/{key}/subcategories', (a) => ({ pathParams: { key: a.category_key ?? a.key }, query: { lang: a.lang } })),
  apiTool('create_budget_subcategory', 'Create a budget subcategory.', 'POST', '/api/v1/budget/categories/{key}/subcategories', (a) => ({ pathParams: { key: a.category_key ?? a.key }, payload: argumentPayload(a, a) })),
  apiTool('create_budget_entry', 'Create a budget entry.', 'POST', '/api/v1/budget', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('update_budget_entry', 'Update a budget entry.', 'PUT', '/api/v1/budget/{id}', (a) => ({ pathParams: { id: a.entry_id ?? a.id }, payload: argumentPayload(a, a.updates || {}) })),
  apiTool('delete_budget_entry', 'Delete a budget entry.', 'DELETE', '/api/v1/budget/{id}', (a) => ({ pathParams: { id: a.entry_id ?? a.id } })),
  apiTool('export_budget', 'Export budget data.', 'GET', '/api/v1/budget/export', (a) => ({ query: { month: a.month } })),
  apiTool('list_reminders', 'List reminders.', 'GET', '/api/v1/reminders'),
  apiTool('list_pending_reminders', 'List pending reminders.', 'GET', '/api/v1/reminders/pending'),
  apiTool('create_reminder', 'Create a reminder.', 'POST', '/api/v1/reminders', (a) => ({ payload: argumentPayload(a, a) })),
  apiTool('dismiss_reminder', 'Dismiss a reminder.', 'PATCH', '/api/v1/reminders/{id}/dismiss', (a) => ({ pathParams: { id: a.reminder_id ?? a.id }, payload: {} })),
  apiTool('delete_reminder', 'Delete a reminder.', 'DELETE', '/api/v1/reminders/{id}', (a) => ({ pathParams: { id: a.reminder_id ?? a.id } })),
  apiTool('delete_reminders_by_filter', 'Delete reminders by filter.', 'DELETE', '/api/v1/reminders', (a) => ({ query: a.query || {} })),
  apiTool('get_weather', 'Fetch weather data.', 'GET', '/api/v1/weather', (a) => ({ query: { city: a.city } })),
  apiTool('get_weather_icon', 'Fetch a weather icon asset descriptor.', 'GET', '/api/v1/weather/icon/{code}', (a) => ({ pathParams: { code: a.code } })),
];

const EXISTING_TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));
const ALL_TOOLS = [
  ...TOOLS,
  ...OPENAPI_TOOLS,
  ...STANDALONE_API_TOOLS.filter((tool) => !EXISTING_TOOL_NAMES.has(tool.name)),
];

// Abgeleitet aus der zusammengeführten Tool-Liste — keine getrennt zu pflegende Struktur.
const TOOL_DEFINITIONS = ALL_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/**
 * Führt ein Tool aus.
 * @param {{ db: object, actor: { id: number, role?: string } }} ctx
 * @param {string} name  - Tool-Name
 * @param {object} args  - Tool-Argumente
 * @returns {any} rohes Ergebnis (wird vom Protokoll-Layer serialisiert)
 * @throws {ToolError} bei unbekanntem Tool oder Validierungsfehler
 */
async function callTool(ctx, name, args = {}) {
  const tool = TOOL_MAP.get(name);
  if (!tool) throw new ToolError(`Unknown tool: ${name}`);
  return tool.handler(ctx, args || {});
}

export { TOOL_DEFINITIONS, callTool, ToolError };
