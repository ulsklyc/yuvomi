/**
 * Modul: MCP-Tools
 * Zweck: Tool-Set für den internen MCP-Endpoint in zwei bewusst getrennten Schichten:
 *   1. Kuratierte Kern-Tools als reine `(db, actor, args)`-Funktionen — schnell,
 *      in-process gegen SQLite, ohne laufenden Server testbar. Deckt die
 *      häufigsten Aktionen ab (Tasks, Shopping, Kalender lesen/anlegen).
 *   2. EINE generische OpenAPI-Brücke (`list_api_operations`, `get_api_operation`,
 *      `call_api_operation`), die jede dokumentierte REST-Operation erreichbar
 *      macht — ein Mechanismus statt hunderter handgepflegter Wrapper. Der Aufruf
 *      geht per authentifiziertem Loopback (`fetch` → eigener HTTP-Server) und
 *      erbt exakt die Rechte des aufrufenden API-Tokens; Rollen- und
 *      CSRF-Prüfung greifen serverseitig auf `/api/v1/*` wie bei jedem Client.
 * Abhängigkeiten: server/middleware/validate.js, server/openapi.js
 *
 * Architektur: Jedes Tool ist EIN Eintrag in der Registry (Definition + Handler
 *   zusammen) — daraus werden `tools/list` und der Dispatch abgeleitet, damit
 *   Name, Schema und Implementierung nicht auseinanderlaufen können.
 *
 * Quelle der Validierungs-/Enum-Regeln der Kern-Tools: server/routes/tasks.js,
 * shopping.js, calendar.js. Bei Änderungen dort diese Datei mitziehen.
 */

import * as v from '../middleware/validate.js';
import { readFileSync } from 'node:fs';
import { buildOpenApiSpec } from '../openapi.js';
import { tokenAllows } from '../scopes.js';
import { visibilityWhere } from '../services/visibility.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

// Spiegelt server/routes/tasks.js (bewusst dupliziert, um die Tool-Schicht von
// express/db in tasks.js zu entkoppeln — siehe Modul-Header).
const VALID_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const VALID_CATEGORIES = ['household', 'school', 'shopping', 'repair',
                          'health', 'finance', 'leisure', 'misc'];

/** Fehler mit für den aufrufenden Client (LLM) sichtbarer Nachricht. */
class ToolError extends Error {}

// --------------------------------------------------------
// Kern-Tools: reine Funktionen (db, actorId, args)
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

function listUpcomingEvents(db, actorId, args) {
  let limit = parseInt(args.limit, 10);
  if (!Number.isFinite(limit)) limit = 20;
  limit = Math.min(Math.max(limit, 1), 100);
  // Sichtbarkeit (#474): kein Zugriff auf private/eingeschränkte Termine anderer.
  return db.prepare(`
    SELECT e.id, e.title, e.start_datetime, e.end_datetime, e.all_day, e.location
    FROM calendar_events e
    WHERE date(e.start_datetime) >= date('now')
      AND ${visibilityWhere('e', 'event_assignments', 'event_id')}
    ORDER BY e.start_datetime ASC
    LIMIT ?
  `).all(actorId, actorId, limit);
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
// OpenAPI-Brücke: EIN generischer Zugang zur gesamten REST-API.
// Der Loopback re-authentifiziert über die weitergereichten Header des
// eingehenden MCP-Requests, daher erbt jeder Aufruf die Rechte des Tokens.
// --------------------------------------------------------

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

// Die OpenAPI-Spec ist zur Laufzeit statisch (hängt nur an der Paketversion) —
// einmal ableiten und cachen statt bei jedem Tool-Aufruf neu zu bauen.
let cachedOperations = null;

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
  if (cachedOperations) return cachedOperations;
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
  cachedOperations = operations;
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

// Reicht die Authentifizierung des eingehenden MCP-Requests an den Loopback
// weiter (Bearer-Token, API-Key, Session-Cookie samt CSRF-Token).
function forwardedAuthHeaders(ctx) {
  const headers = {};
  const source = ctx.requestHeaders || {};
  const auth = source.authorization || source.Authorization;
  const apiKey = source['x-api-key'] || source['X-API-Key'] || source['api-key'] || source['API-Key'];
  const cookie = source.cookie || source.Cookie;
  const csrf = source['x-csrf-token'] || source['X-CSRF-Token'];
  if (auth) headers.Authorization = auth;
  if (apiKey) headers['X-API-Key'] = apiKey;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  return headers;
}

// Obergrenze für inline durchgereichte Binärantworten. Die Brücke base64-kodiert
// den Body für die JSON-RPC-Antwort — ein LLM kann mit größeren Blobs ohnehin
// nichts anfangen, und ohne Deckel würde ein großes Backup/Dokument mehrere
// Vollkopien im Prozess allokieren (OOM-Risiko). Große Downloads laufen weiter
// über die dedizierte, streamende REST-Route.
const MAX_BINARY_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MiB

// Liest einen Binär-Response speicherbeschränkt: verwirft früh anhand von
// Content-Length und bricht sonst den Stream ab, sobald der Deckel überschritten
// wird — es wird also nie mehr als der Deckel gepuffert.
async function readCappedBinary(response, cap = MAX_BINARY_RESPONSE_BYTES) {
  const tooLarge = (size) => new ToolError(
    `Binary response too large for the MCP bridge (${size} bytes, max ${cap}). `
    + 'Use the dedicated download route directly instead.',
  );

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) throw tooLarge(declared);

  const reader = response.body && typeof response.body.getReader === 'function'
    ? response.body.getReader()
    : null;
  if (!reader) {
    // Kein Stream-Reader (z. B. im Test): puffern und danach prüfen.
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > cap) throw tooLarge(buffer.length);
    return buffer;
  }

  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw tooLarge(total);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
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
    const buffer = await readCappedBinary(response);
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

// --------------------------------------------------------
// Registry: Definition + Handler je Tool an EINER Stelle.
// `handler(ctx, args)` mit ctx = { db, actor: { id, role }, requestHeaders }.
// --------------------------------------------------------

const CORE_TOOLS = [
  {
    name: 'list_tasks',
    description: 'List the family\'s current top-level tasks (open by default). Optionally filter by status.',
    scope: { module: 'tasks', access: 'read' },
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
    scope: { module: 'tasks', access: 'write' },
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
    scope: { module: 'shopping', access: 'read' },
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
    scope: { module: 'shopping', access: 'write' },
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
    scope: { module: 'calendar', access: 'read' },
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max number of events (1-100, default 20).' },
      },
    },
    handler: (ctx, args) => listUpcomingEvents(ctx.db, ctx.actor.id, args),
  },
  {
    name: 'create_event',
    description: 'Create a calendar event.',
    scope: { module: 'calendar', access: 'write' },
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

// Generische Brücke — hält die Tool-Liste schlank und deckt trotzdem die
// gesamte dokumentierte API ab, ohne pro Route einen Wrapper zu pflegen.
const OPENAPI_TOOLS = [
  {
    name: 'list_api_operations',
    description: 'List Yuvomi REST API operations reachable through call_api_operation.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Optional OpenAPI tag filter (e.g. Budget, Calendar).' },
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
    description: 'Return OpenAPI metadata for one Yuvomi API operation key.',
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
    description: 'Call any Yuvomi REST API operation from the live OpenAPI spec. Runs with the permissions of the authenticated MCP token — admin-only routes require an admin token.',
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

const ALL_TOOLS = [...CORE_TOOLS, ...OPENAPI_TOOLS];

// Abgeleitet aus der Registry — keine getrennt zu pflegende Struktur.
const TOOL_DEFINITIONS = ALL_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/**
 * Darf der Token dieses Tool nutzen? Tools ohne `scope` (Meta-/Brücken-Tools) sind
 * immer erlaubt — die OpenAPI-Brücke setzt Scopes ohnehin serverseitig am
 * Loopback-REST-Layer durch. `scopes === null` = kein Scoping (voller Zugriff).
 * @param {string[]|null} scopes
 * @param {{ scope?: { module: string, access: 'read'|'write' } }} tool
 * @returns {boolean}
 */
function toolAllowed(scopes, tool) {
  if (!tool.scope) return true;
  return tokenAllows(scopes, tool.scope.module, tool.scope.access);
}

/**
 * Tool-Definitionen für `tools/list`, gefiltert auf die Scopes des Tokens —
 * ein LLM sieht nur Tools, die es auch aufrufen darf.
 * @param {string[]|null} scopes
 * @returns {Array<{ name: string, description: string, inputSchema: object }>}
 */
function listToolDefinitions(scopes = null) {
  return ALL_TOOLS
    .filter((tool) => toolAllowed(scopes, tool))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/**
 * Führt ein Tool aus.
 * @param {{ db: object, actor: { id: number, role?: string, scopes?: string[]|null }, requestHeaders?: object }} ctx
 * @param {string} name  - Tool-Name
 * @param {object} args  - Tool-Argumente
 * @returns {Promise<any>} rohes Ergebnis (wird vom Protokoll-Layer serialisiert)
 * @throws {ToolError} bei unbekanntem Tool, fehlender Scope-Berechtigung oder Validierungsfehler
 */
async function callTool(ctx, name, args = {}) {
  const tool = TOOL_MAP.get(name);
  if (!tool) throw new ToolError(`Unknown tool: ${name}`);
  const scopes = ctx.actor ? (ctx.actor.scopes ?? null) : null;
  if (!toolAllowed(scopes, tool)) {
    throw new ToolError(`Tool "${name}" is not permitted by this token's scopes.`);
  }
  return tool.handler(ctx, args || {});
}

export { TOOL_DEFINITIONS, listToolDefinitions, callTool, ToolError };
