/**
 * Modul: MCP-Tools
 * Zweck: Tool-Set für den internen MCP-Endpoint in zwei bewusst getrennten Schichten:
 *   1. Kuratierte Kern-Tools, die die häufigsten Aktionen abdecken (Tasks,
 *      Shopping, Kalender lesen/anlegen). Die LESENDEN laufen in-process gegen
 *      SQLite - schnell und ohne laufenden Server testbar; sie teilen ihre
 *      Abfragen mit der REST-Seite (`visibleWhere`, der Kalender-Leser). Die
 *      SCHREIBENDEN gehen seit #2616 per Loopback durch ihre eigene Route:
 *      Standardpunkte, die eigenen Kategorien des Haushalts, der Listenstand
 *      und der Sofort-Sync entstehen dort, und eine zweite Fassung davon wich
 *      von der App ab, sobald eine von beiden sich bewegte.
 *   2. EINE generische OpenAPI-Brücke (`list_api_operations`, `get_api_operation`,
 *      `call_api_operation`), die jede dokumentierte REST-Operation erreichbar
 *      macht - ein Mechanismus statt hunderter handgepflegter Wrapper.
 *   Beide Schreibwege nutzen denselben authentifizierten Loopback
 *   (`internalApiRequest`: `fetch` → eigener HTTP-Server) und erben exakt die
 *   Rechte des aufrufenden Tokens; Rollen-, Scope- und CSRF-Prüfung greifen
 *   serverseitig auf `/api/v1/*` wie bei jedem anderen Client.
 * Abhängigkeiten: server/middleware/validate.js, server/openapi.js,
 *                  server/scopes.js + server/authorize/ (Rechte-Durchsetzung)
 *
 * Architektur: Jedes Tool ist EIN Eintrag in der Registry (Definition + Handler
 *   zusammen) — daraus werden `tools/list` und der Dispatch abgeleitet, damit
 *   Name, Schema und Implementierung nicht auseinanderlaufen können.
 *
 * SCHREIBEN ÜBER MCP BRAUCHT EIN API-TOKEN ODER EIN MITGESCHICKTES CSRF-TOKEN:
 * `/mcp` liegt ausserhalb der /api/v1-Gates und kennt kein CSRF, die Route
 * dahinter schon (server/middleware/csrf.js nimmt nur `api_token` aus).
 */

import * as v from '../middleware/validate.js';
import { readFileSync } from 'node:fs';
import { buildOpenApiSpec } from '../openapi.js';
import { authorize, visibleWhere } from '../authorize/index.ts';
import { todayKey } from '../utils/timezone.js';
import { taskScopeNeedsToday, taskScopeWhere } from '../services/task-scope.js';
import { getUpcomingEvents } from '../services/calendar-event-reader.js';
import { loadTagsFor, normalizeTags, tagKey } from '../utils/task-tags.js';
import { readBindAddress, selfCallHost } from '../utils/bind-address.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

// Spiegelt server/routes/tasks.js. Diese Liste ist dort ebenfalls fest
// verdrahtet; die Kategorien stehen dagegen in der Datenbank und werden
// deshalb nicht mehr hier aufgezählt (#2616).
const VALID_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];

/**
 * Fehler mit für den aufrufenden Client (LLM) sichtbarer Nachricht.
 *
 * Kommt er aus einer Routenantwort (`internalApiRequest`), tragen die drei
 * Felder deren Angaben - nur für Aufrufer im Prozess und Tests (#2616). Ein
 * MCP-Client sieht sie nie: `protocol.js` gibt nur `message` hinaus, `reason`
 * steht dort als `[reason: ...]` im Text.
 */
class ToolError extends Error {
  /** @type {number|null} HTTP-Status der Routenantwort, sonst null. */
  status = null;
  /** @type {number|string|null} `code` der Routenantwort, sonst null. */
  code = null;
  /** @type {string|null} `reason` der Routenantwort, sonst null. */
  reason = null;
}

// --------------------------------------------------------
// Kern-Tools: lesend `(db, actorId, args)` in-process, schreibend
// `(ctx, args)` per Loopback durch die eigene Route (#2616).
// --------------------------------------------------------

function listTasks(db, actorId, args) {
  let sql = `
    SELECT t.id, t.title, t.status, t.priority, t.category, t.due_date, t.due_time
    FROM tasks t
    WHERE ${taskScopeWhere('t', { includeFuture: !!args.include_future, bind: '@today' })}
      -- Sichtbarkeit (#474): kein Zugriff auf private/eingeschränkte Aufgaben
      -- anderer. Stand hier bisher nicht, obwohl die Termin-Abfrage sie führt -
      -- ein MCP-Token sah damit jede private Aufgabe des Haushalts, und mit den
      -- Tags (#586) käme deren Freitext gleich mit.
      AND ${visibleWhere('tasks', 't', '@me')}
  `;
  // Dieselbe Auswahl wie `GET /api/v1/tasks` und die Uebersicht (#825): eine
  // Automatisierung, die andere Aufgaben sieht als das UI, ist der Grund, aus
  // dem hier schon einmal die Sichtbarkeit nachgezogen werden musste.
  const params = { me: actorId };
  if (taskScopeNeedsToday({ includeFuture: !!args.include_future })) params.today = todayKey(db);
  // Das Archiv ist seit #688 eine eigene Achse (tasks.archived_at), kein
  // Statuswert mehr. `status: 'archived'` bleibt als Eingabe erlaubt und meint
  // unverändert „zeig mir die Ablage" - nur wird jetzt die Ablage gefragt und
  // nicht das Statusfeld, das es dort nie sauber ausdrücken konnte.
  if (args.status) {
    const s = v.oneOf(args.status, ['open', 'in_progress', 'done', 'archived'], 'status');
    if (s.error) throw new ToolError(s.error);
    if (args.status === 'archived') {
      sql += ' AND t.archived_at IS NOT NULL';
    } else {
      sql += ' AND t.status = @status AND t.archived_at IS NULL';
      params.status = args.status;
    }
  } else {
    sql += ' AND t.archived_at IS NULL';
  }
  // Tag-Filter, gleiche Semantik wie GET /api/v1/tasks: mehrere Tags engen
  // UND-verknüpft ein, die Schreibweise zählt nicht.
  //
  // Die Form wird ausdrücklich geprüft, statt sich auf das Schema zu verlassen:
  // callTool erzwingt es zur Laufzeit nicht, und normalizeTags macht aus einem
  // Unsinnswert stillschweigend eine leere Liste. Ein einschränkender Filter,
  // der bei Unsinn die VOLLE Liste liefert, ist die gefährliche Richtung - eine
  // Automatisierung handelte dann an fremden Aufgaben.
  if (args.tag !== undefined && args.tag !== null
      && !Array.isArray(args.tag) && typeof args.tag !== 'string') {
    throw new ToolError('tag must be an array of strings or a single string.');
  }
  const tags = normalizeTags(args.tag === undefined ? [] : [args.tag].flat());
  tags.forEach((tag, i) => {
    sql += ` AND EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag_key = @tag${i})`;
    params[`tag${i}`] = tagKey(tag);
  });
  sql += `
    ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date ASC, t.created_at DESC
    LIMIT 100
  `;
  const rows = db.prepare(sql).all(params);
  // Tags als Liste, nicht als group_concat-String: ein Tag darf selbst ein Komma
  // enthalten ("Haus, Hof"), eine verbundene Zeichenkette wäre nicht mehr
  // eindeutig trennbar.
  const tagMap = loadTagsFor(db, rows.map((r) => r.id));
  for (const row of rows) row.tags = tagMap.get(row.id) ?? [];
  return rows;
}

// The slim field selection each write tool answers with, mapped out of the
// route's `data`. The route answers with the whole row - assignments, rotation,
// attachments, sync targets - and an LLM needs none of it; the selection lives
// here so it does not grow with the route's answer.
const TASK_FIELDS = ['id', 'title', 'status', 'priority', 'category', 'due_date', 'due_time', 'tags'];
const ITEM_FIELDS = ['id', 'name', 'quantity', 'category', 'is_checked'];
const EVENT_FIELDS = ['id', 'title', 'start_datetime', 'end_datetime', 'all_day', 'location'];

/**
 * Exactly the listed fields of `row`, in that order; a missing one is null.
 * @param {any} row
 * @param {readonly string[]} fields
 * @returns {Record<string, any>}
 */
function pickFields(row, fields) {
  /** @type {Record<string, any>} */
  const picked = {};
  for (const field of fields) picked[field] = row?.[field] ?? null;
  return picked;
}

/**
 * Only the fields the caller actually passed. A field left out stays out of the
 * request body, so the ROUTE's default applies - that is the whole point of
 * going through it (default points, fallback category, fallback visibility).
 *
 * `null` AND `''` COUNT AS NOT PASSED, exactly as they did before #2616: the
 * old tool read both through `v.str`/`v.oneOf`, which answer `null` for them. A
 * client that serializes an unset optional argument as `null` sends
 * `{ category: null }`, and the route reads that differently - `textShape`
 * WITHOUT `{ nullable: true }` makes it "category must be text.", a 400. `''`
 * passes the route's checks, but its defaults (`category = FALLBACK_CATEGORY`,
 * `priority = 'none'`) apply to `undefined` only: the row got the orphan key
 * `''` (cleaned up by migration v114), `priority: ''` ran into the CHECK as a
 * 500, `description: ''` stored `''` instead of NULL. No field of the three
 * tool schemas is nullable, and none gives `''` a meaning of its own.
 * @param {Record<string, any>} fields
 * @returns {Record<string, any>}
 */
function passedFields(fields) {
  /** @type {Record<string, any>} */
  const body = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value != null && value !== '') body[key] = value;
  }
  return body;
}

/**
 * A finite number in a TEXT field becomes its text, as the old tool's `v.str`
 * did with `String(val)`: `{ title: 42 }` created a task "42" before #2616, and
 * the route's `textShape` refuses a number. Only for the free-text fields -
 * a number as category or priority was refused before as well.
 * @param {any} value
 * @returns {any}
 */
function asText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
}

// The limit of the `Idempotency-Key` header, as server/middleware/idempotency.js
// draws it (MAX_KEY_LENGTH, printable ASCII). Named a second time instead of
// imported: that module pulls in server/db.js, and this layer stays testable
// without the database module; test:idempotency binds the two numbers. A value
// the route judges differently still gets the route's own 400 - this check only
// keeps `fetch` from throwing on a header value it cannot send.
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * The extra request headers for a write tool: opt-in retry safety (#2616).
 * Without the argument no header goes out, so nothing changes for callers that
 * do not ask for it. NOT derived from the JSON-RPC id: a client counting its
 * ids up would get a promise it never ordered, and one reusing them would get a
 * 409 for a genuinely new task.
 * @param {any} args
 * @returns {{ 'Idempotency-Key': string }|undefined}
 */
function idempotencyHeader(args) {
  const raw = args.idempotency_key;
  // `''` like `null`: not given, as for every other optional field.
  if (raw === undefined || raw === null || raw === '') return undefined;
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH || /[^\x20-\x7E]/.test(key)) {
    throw new ToolError(
      `idempotency_key must be printable ASCII, 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    );
  }
  return { 'Idempotency-Key': key };
}

async function createTask(ctx, args) {
  const data = await internalApiRequest(ctx, 'POST', '/api/v1/tasks', {
    // Validation, the category check and the fallbacks all belong to the route
    // (#2616): the fixed list here refused a household's own category and still
    // wrote a default key the household had deleted.
    payload: passedFields({
      title: asText(args.title),
      description: asText(args.description),
      category: args.category,
      priority: args.priority,
      due_date: args.due_date,
      due_time: args.due_time,
      // Tags travel along (#586). The route's setTags takes an array as well as
      // a comma-separated string - an LLM client sends one or the other.
      tags: args.tags,
    }),
    headers: idempotencyHeader(args),
  });
  return pickFields(data?.data, TASK_FIELDS);
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

async function addShoppingItem(ctx, args) {
  // RESOLVING THE LIST BY NAME IS WHAT ONLY THIS TOOL CAN DO: the route knows
  // its id, not its name, and an LLM names lists the way a person does. Read
  // only, and the two messages stay word for word what they were.
  const list = args.list
    ? ctx.db.prepare('SELECT id, name FROM shopping_lists WHERE name = ? ORDER BY id LIMIT 1').get(String(args.list).trim())
    : ctx.db.prepare('SELECT id, name FROM shopping_lists ORDER BY id LIMIT 1').get();

  if (!list) {
    throw new ToolError(args.list
      ? `No shopping list named "${args.list}" found.`
      : 'No shopping list exists yet. Create one in the app first.');
  }

  const data = await internalApiRequest(ctx, 'POST', `/api/v1/shopping/${encodeURIComponent(list.id)}/items`, {
    // No category of our own any more (#2616): the route checks it against
    // `validCategoryNames()` and falls back on the household's own rule. The
    // fixed 'Sonstiges' here wrote a name a renamed household no longer had.
    payload: passedFields({ name: asText(args.name), quantity: asText(args.quantity), category: args.category }),
    headers: idempotencyHeader(args),
  });
  // `list` as a NAME: the route answers with the item row, which only carries
  // the list id. The name comes from the same row the id was resolved from.
  return { ...pickFields(data?.data, ITEM_FIELDS), list: list.name };
}

function listUpcomingEvents(db, actorId, args) {
  let limit = parseInt(args.limit, 10);
  if (!Number.isFinite(limit)) limit = 20;
  limit = Math.min(Math.max(limit, 1), 100);
  // Reuse the calendar/dashboard service so recurrence expansion, EXDATEs,
  // displayed moved children and visibility stay one contract across REST and
  // MCP. fromToday preserves this tool's existing calendar-day boundary.
  return getUpcomingEvents(db, {
    userId: actorId,
    limit,
    // The shared reader bounds eligible occurrences per series by limit.
    windowDays: null,
    fromToday: true,
  }).map((event) => ({
    id: event.id,
    title: event.title,
    start_datetime: event.start_datetime,
    end_datetime: event.end_datetime,
    all_day: event.all_day,
    location: event.location,
    ...(event.is_occurrence_override ? {
      series_id: event.series_id,
      recurrence_id: event.recurrence_id,
      is_occurrence_override: true,
      assignment_owner_id: event.assignment_owner_id,
      attachment_owner_id: event.attachment_owner_id,
      reminder_owner_id: event.reminder_owner_id,
      reminder_anchor_start: event.reminder_anchor_start,
    } : {}),
  }));
}

async function createEvent(ctx, args) {
  const data = await internalApiRequest(ctx, 'POST', '/api/v1/calendar', {
    // The same path as any other client (#1364 included): a `Z` or an offset -
    // the obvious form for an LLM client - is converted into the household zone
    // instead of being cut off, and for an all-day event only the date counts.
    // The route does that itself, and since #2616 it is the ONLY place that
    // does; it also flushes a waiting sync target right away.
    payload: passedFields({
      title: asText(args.title),
      description: asText(args.description),
      start_datetime: args.start_datetime,
      end_datetime: args.end_datetime,
      // THE TOOL'S OWN COERCION STAYS. The route reads `!!req.body.all_day`,
      // so every truthy value counts - the string "false" would turn a 09:30
      // appointment into an all-day entry and drop its time. This tool has
      // always accepted only the boolean `true`, and its schema says `boolean`.
      all_day: args.all_day == null ? undefined : args.all_day === true,
      location: asText(args.location),
    }),
    headers: idempotencyHeader(args),
  });
  return pickFields(data?.data, EVENT_FIELDS);
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
let cachedExcluded = null;

// OpenAPI-Operationen mit `x-mcp-exclude: true` gibt es fuer die Bruecke nicht:
// weder in list_api_operations noch ueber call_api_operation. Gedacht fuer
// Routen, die ein Token ohnehin abweisen (Modul installieren/loeschen: nur aus
// einer Browser-Sitzung) - ein Assistent soll keinen Schritt planen, den er nie
// ausfuehren kann. Die Route selbst bleibt die eigentliche Grenze.
const MCP_EXCLUDE = 'x-mcp-exclude';

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
  const excluded = new Set();
  const used = new Map();
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !operation || typeof operation !== 'object') continue;
      let key = operationKey(method, path);
      const count = (used.get(key) || 0) + 1;
      used.set(key, count);
      if (count > 1) key = `${key}_${count}`;
      // Erst NACH der Zaehlung: so behalten die uebrigen Operationen dieselben
      // Schluessel, ob die ausgeschlossene nun mitzaehlt oder nicht.
      if (operation[MCP_EXCLUDE] === true) {
        excluded.add(key);
        excluded.add(`${method.toUpperCase()} ${path}`);
        continue;
      }
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
  cachedExcluded = excluded;
  return operations;
}

function excludedOperation(keyOrMethodPath) {
  openApiOperations();
  return cachedExcluded.has(keyOrMethodPath);
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
    if (!operation && excludedOperation(key)) {
      throw new ToolError(`Operation ${key} is not available through MCP. Use the web interface.`);
    }
    if (!operation) throw new ToolError(`Unknown operation_key: ${key}`);
    return operation;
  }
  if (!method || !path) throw new ToolError('Pass operation_key, or pass both method and path.');
  const normalizedMethod = String(method).toUpperCase();
  const normalizedPath = String(path).startsWith('/') ? String(path) : `/${path}`;
  for (const operation of operations.values()) {
    if (operation.method === normalizedMethod && operation.path === normalizedPath) return operation;
  }
  if (excludedOperation(`${normalizedMethod} ${normalizedPath}`)) {
    throw new ToolError(`${normalizedMethod} ${normalizedPath} is not available through MCP. Use the web interface.`);
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

// Serialisiert den JSON-Body. MCP-Clients, die Tool-Argumente typkoerzieren,
// schicken das Payload bereits als JSON-Text — der wird durchgereicht statt ein
// zweites Mal kodiert, sonst käme beim Server ein String-Primitive an, das
// `express.json({ strict: true })` ablehnt.
function jsonBody(payload) {
  if (typeof payload !== 'string') return JSON.stringify(payload ?? {});
  const trimmed = payload.trim();
  if (!trimmed) return '{}';
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ToolError('payload must be a JSON object (or a string containing one).');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ToolError('payload must be a JSON object (or a string containing one).');
  }
  return JSON.stringify(parsed);
}

function internalBaseUrl() {
  return (
    process.env.MCP_INTERNAL_BASE_URL
    || process.env.BASE_URL
    // Dieselbe Adresse, auf der server/index.js lauscht: bindet der Server nur
    // an eine LAN-Adresse, ginge ein Aufruf an 127.0.0.1 ins Leere.
    || `http://${selfCallHost(readBindAddress(process.env.BIND_ADDRESS))}:${process.env.PORT || 3000}`
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

// Die Zusatzkoepfe, die ein Werkzeug mitgeben darf (klein geschrieben). Eine
// Erlaubnisliste statt einer Reihenfolge: nur so kann ein Zusatzkopf die
// weitergereichte Authentifizierung in KEINER Schreibweise beruehren.
const EXTRA_REQUEST_HEADERS = new Set(['idempotency-key']);

/**
 * Ein authentifizierter Loopback-Aufruf auf die eigene REST-API.
 * @param {{ requestHeaders?: object }} ctx
 * @param {string} method
 * @param {string} path
 * @param {{ query?: object, payload?: any, contentData?: string, contentType?: string, headers?: object }} [options]
 * @returns {Promise<any>} der geparste Antwortrumpf
 * @throws {ToolError} bei `!response.ok`, mit `status`, `code` und `reason`
 */
async function internalApiRequest(ctx, method, path, {
  query, payload, contentData, contentType, headers: extraHeaders,
} = {}) {
  const url = new URL(path, `${internalBaseUrl()}/`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  // Nur gelistete Zusatzkoepfe, die Auth danach: die Reihenfolge allein reicht
  // nicht, `fetch` fasst `authorization` und `Authorization` zu EINEM Kopf mit
  // beiden Werten zusammen.
  /** @type {Record<string, string>} */
  const allowed = { Accept: 'application/json' };
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    if (EXTRA_REQUEST_HEADERS.has(name.toLowerCase())) allowed[name] = value;
  }
  const headers = { ...allowed, ...forwardedAuthHeaders(ctx) };
  const options = { method, headers };
  if (contentData !== undefined && contentData !== null) {
    options.body = contentBytes(contentData);
    headers['Content-Type'] = contentType || 'application/octet-stream';
  } else if (!['GET', 'HEAD'].includes(method.toUpperCase()) && payload !== undefined) {
    options.body = jsonBody(payload);
    headers['Content-Type'] = 'application/json';
  }

  // EIN TRANSPORTFEHLER IST EINE MELDUNG, KEIN INTERNER FEHLER. Der Loopback
  // folgt `MCP_INTERNAL_BASE_URL`, sonst `BASE_URL` - und das ist auf vielen
  // Installationen die oeffentliche Adresse hinter einem Reverse Proxy, die aus
  // dem Prozess selbst nicht erreichbar sein muss. Ohne diesen Fang wirft
  // `fetch` einen TypeError, und der Aufrufer liest "Internal error executing
  // tool." - ein Satz, aus dem niemand den Namen der Einstellung errät. Die
  // Meldung ist fest: weder der Text der Bibliothek (Regel ERROR-TEXT) noch die
  // interne Adresse geht hinaus. Der Originalfehler bleibt als `cause` am Fehler.
  let response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    throw new ToolError(
      'Could not reach the Yuvomi API from the server itself. '
      + 'Set MCP_INTERNAL_BASE_URL to an address the app can reach locally '
      + '(for example http://127.0.0.1:3000).',
      { cause },
    );
  }
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
    const body = data && typeof data === 'object' ? /** @type {any} */ (data) : null;
    const message = body && body.error ? body.error : `HTTP ${response.status}`;
    // `reason` ist der maschinenlesbare Grund der Route (#1607): derselbe 403
    // heisst "kein Modulzugriff", "nur lesen" oder "CSRF fehlt", und der
    // englische Satz allein sagt dem Aufrufer nicht, was er aendern soll. Steht
    // einer in der Antwort, haengt er sichtbar an der Meldung; ohne ihn bleibt
    // der Text Zeichen fuer Zeichen der von vorher.
    const reason = body && typeof body.reason === 'string' ? body.reason : null;
    const error = new ToolError(reason ? `${message} [reason: ${reason}]` : `${message}`);
    error.status = response.status;
    error.code = body && body.code !== undefined ? body.code : null;
    error.reason = reason;
    throw error;
  }
  return data;
}

// --------------------------------------------------------
// Registry: Definition + Handler je Tool an EINER Stelle.
// `handler(ctx, args)` mit ctx = { db, actor, requestHeaders }; der Akteur kommt
// aus server/authorize/ (`actorFromRequest`), die Handler lesen `actor.userId`.
// --------------------------------------------------------

// One wording for all three write tools (#2616): the same promise, so a client
// that learned it on one tool can use it on the next.
const IDEMPOTENCY_KEY_SCHEMA = {
  type: 'string',
  description: 'Optional retry safety: repeating the call with the same key does not create a second row but returns the first answer. Printable ASCII, at most 255 characters. Leave it out and every call creates its own row; reusing a key for different content is an error.',
};

const CORE_TOOLS = [
  {
    name: 'list_tasks',
    description: 'List the family\'s current top-level tasks (open by default). Optionally filter by status and tags. Each task carries its tags; tags are free-form labels mirrored from CalDAV task lists and are distinct from the single category a task has.',
    scope: { module: 'tasks', access: 'read' },
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'archived'], description: 'Filter by task status. "archived" is not a status but the separate archive: it lists the filed-away tasks with whatever status they carry.' },
        include_future: { type: 'boolean', description: 'Include tasks that only start at a later date. Left out by default, matching the app: a task with a start date next week is not up yet.' },
        tag: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags. Several tags narrow the list (a task must carry all of them). Case-insensitive.',
        },
      },
    },
    handler: (ctx, args) => listTasks(ctx.db, ctx.actor.userId, args),
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
        // No enum: a household manages its own categories, and a fixed list
        // refused them while still accepting a default key the household had
        // deleted (#2616).
        category:    { type: 'string', description: 'Optional category key. The valid keys are the household\'s own task categories, as listed by list_tasks and by GET /api/v1/tasks/categories; left out, the task falls back on "misc".' },
        priority:    { type: 'string', enum: VALID_PRIORITIES, description: 'Optional priority (default none).' },
        due_date:    { type: 'string', description: 'Optional due date, format YYYY-MM-DD.' },
        due_time:    { type: 'string', description: 'Optional due time, format HH:MM.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional free-form tags. Unlike the single category, a task can carry many. Mirrored to CATEGORIES on CalDAV task lists.',
        },
        idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
      },
      required: ['title'],
    },
    handler: createTask,
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
        category: { type: 'string', description: 'Optional category name. The valid names are the household\'s own shopping categories, as listed by list_shopping_items and by GET /api/v1/shopping/categories.' },
        list:     { type: 'string', description: 'Optional target list name.' },
        idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
      },
      required: ['name'],
    },
    handler: addShoppingItem,
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
    handler: (ctx, args) => listUpcomingEvents(ctx.db, ctx.actor.userId, args),
  },
  {
    name: 'create_event',
    description: 'Create a calendar event.',
    scope: { module: 'calendar', access: 'write' },
    inputSchema: {
      type: 'object',
      properties: {
        title:          { type: 'string', description: 'Event title (required).' },
        start_datetime: { type: 'string', description: 'Start, format YYYY-MM-DD or YYYY-MM-DDTHH:MM in household wall-clock time (required). A value with Z or a numeric offset is converted into the household time zone; for all-day events only its date counts.' },
        end_datetime:   { type: 'string', description: 'Optional end, same format as start.' },
        all_day:        { type: 'boolean', description: 'Whether the event lasts all day.' },
        location:       { type: 'string', description: 'Optional location.' },
        description:    { type: 'string', description: 'Optional description.' },
        idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
      },
      required: ['title', 'start_datetime'],
    },
    handler: createEvent,
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
        payload: { type: 'object', description: 'JSON request body.' },
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
      const sendsBody = !['GET', 'HEAD'].includes(operation.method);
      const hasContent = args.content_data !== undefined && args.content_data !== null;
      let payload = args.payload;
      // DER BODY GEHOERT IN `payload` (#2197). Ein Assistent, der die Felder
      // neben `operation_key` legte ({ operation_key, title }), schickte einen
      // POST ohne Body - die Felder fielen still weg, und die Route antwortete
      // mit 500. Fremde Schluessel auf oberster Ebene sind dann fast sicher der
      // gemeinte Body: lieber sagen, wohin er gehoert, als ohne ihn anfragen.
      if (sendsBody && payload === undefined && !hasContent) {
        const stray = Object.keys(args).filter((key) => !CALL_API_ARGUMENTS.has(key));
        if (stray.length) {
          throw new ToolError(
            `Unknown argument(s) ${stray.join(', ')}. Put the request body of ${operation.method} ${operation.path} into "payload", `
            + `for example { "operation_key": "${operation.operation_key}", "payload": { ... } }.`,
          );
        }
        // Ein Pflicht-Body ohne Felder geht als `{}` raus, so wie Express 4
        // ihn der Route gegeben haette: dann sagt deren Validierung, was fehlt.
        if (operation.request_body_required && contentType === 'application/json') payload = {};
      }
      return internalApiRequest(ctx, operation.method, path, {
        query: args.query,
        payload,
        contentData: args.content_data,
        contentType,
      });
    },
  },
];

// Die Argumente von `call_api_operation`, gelesen aus seinem eigenen
// inputSchema - alles andere auf oberster Ebene ist ein verirrter Body (#2197).
const CALL_API_ARGUMENTS = new Set(Object.keys(
  OPENAPI_TOOLS.find((tool) => tool.name === 'call_api_operation').inputSchema.properties,
));

const ALL_TOOLS = [...CORE_TOOLS, ...OPENAPI_TOOLS];

// Abgeleitet aus der Registry — keine getrennt zu pflegende Struktur.
const TOOL_DEFINITIONS = ALL_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/**
 * Darf dieser Akteur das Tool nutzen? Zwei voneinander unabhängige Grenzen, und
 * BEIDE müssen zustimmen:
 *
 *   1. Token-Scopes — Least Privilege des Integrationstokens selbst.
 *      `scopes === null` = kein Scoping (Legacy-Token, voller Zugriff).
 *   2. Modulrechte des Nutzers (#467) — was das Mitglied hinter dem Token
 *      überhaupt darf. `moduleAccess === null` = Admin oder unbeschränkt.
 *
 * Punkt 2 fehlte hier (#823): die LESENDEN Kern-Tools laufen in-process gegen
 * SQLite und sehen die /api/v1-Middleware nie, ein Mitglied mit `tasks: none`
 * bekam über `list_tasks` trotzdem die Aufgaben. Ein Scope kann Rechte nur
 * einschränken, niemals erweitern - deshalb ist die Reihenfolge egal, aber die
 * Konjunktion nicht.
 *
 * DIESE PRÜFUNG BLEIBT AUCH FÜR DIE SCHREIBENDEN, obwohl sie seit #2616 per
 * Loopback über /api/v1 gehen und dort denselben Stapel noch einmal treffen:
 * ein Werkzeug, das erst schreibt und dann meckert, wäre die schlimmere
 * Variante, und `tools/list` soll kein Werkzeug nennen, das der nächste Aufruf
 * verweigert. Sie steht deshalb VOR dem Loopback.
 *
 * Tools ohne `scope` (Meta-/Brücken-Tools) bleiben erlaubt: die OpenAPI-Brücke
 * ruft per Loopback über /api/v1 auf und erbt dort Scopes, Modulrechte und
 * Guest-Guard vom echten Middleware-Stapel. Ausnahme sind Split-Guests, die
 * gar keinen Haushaltszugriff haben — für sie sind alle Kern-Tools zu.
 *
 * @param {{ kind?: string, userId?: number|null, role?: string|null, familyRole?: string|null, scopes?: readonly string[]|null, moduleAccess?: object|null, unresolved?: boolean }|null} actor
 * @param {{ scope?: { module: string, access: 'read'|'write' } }} tool
 * @returns {boolean}
 */
function toolAllowed(actor, tool) {
  // EIN WANDTABLETT ERREICHT GAR KEIN WERKZEUG, auch keines ohne `scope`
  // (#1208). `/mcp` liegt bewusst ausserhalb der /api/v1-Gates, und der
  // Display-Zweig in `requireAuth` setzt Scopes unabhaengig vom Pfad - ohne
  // diese Zeile laege hier eine Tuer offen, die die REST-Seite verschlossen
  // hat. Dieselbe Klasse wie GHSA-4jcg-7jvj-p4v9: eine Regel, die je Pfad statt
  // zentral steht.
  //
  // WARUM VOR der Abkuerzung darunter, der Gast-Riegel aber dahinter bleibt:
  // ohne `scope` sind `list_api_operations`, `get_api_operation` und
  // `call_api_operation`. Der letzte laeuft ueber `internalApiRequest` in die
  // REST-Schicht zurueck und traegt damit deren Gates - fuer einen
  // Ausgaben-Gast IST das sein Weg zu /split-expenses ueber MCP, und ihn
  // zuzumachen naehme echten Zugang weg (test-mcp.js haelt genau diese drei
  // Namen fuer ihn fest). Ein Display hat dort nichts zu holen: seine vier
  // Lesemodule erreicht es ueber REST, und einen Integrationskanal braucht ein
  // Geraet an der Wand nicht.
  //
  // OFFEN UND NICHT HIER ENTSCHIEDEN: dass ein Gast ueber die beiden anderen
  // den vollstaendigen OpenAPI-Katalog liest, obwohl `/openapi.json` ueber REST
  // administratorgesperrt ist. Das ist ein eigener Befund, aelter als #1208.
  // `unresolved`: a lookup that decides the kind failed or contradicts the other
  // (server/authorize/) - closed like a display, as the old lookups said true then.
  if (actor && (actor.kind === 'display' || actor.unresolved)) return false;
  if (!tool.scope) return true;
  // Gast-Konten für geteilte Ausgaben erreichen unter /api/v1 nur
  // /split-expenses; kein Kern-Tool liegt dort, also alle gesperrt.
  if (actor && actor.kind === 'guest') return false;
  // No actor: neither scopes nor module rights narrow anything, and the tool is
  // allowed, as before B2 (`listToolDefinitions()` without an actor lists every
  // tool). authorize() answers `null` with 'no_actor', so it is caught here.
  if (!actor) return true;
  // Token scopes, then the module rights - the module verdict of server/authorize/.
  const verdict = authorize(/** @type {import('../authorize/index.ts').Actor} */ (actor), tool.scope.access, { module: tool.scope.module });
  return verdict.allowed;
}

/**
 * Tool-Definitionen für `tools/list`, gefiltert auf das, was der Akteur wirklich
 * aufrufen darf — ein LLM sieht kein Tool, das ihm der nächste Aufruf verweigert.
 * @param {{ kind?: string, userId?: number|null, role?: string|null, familyRole?: string|null, scopes?: readonly string[]|null, moduleAccess?: object|null, unresolved?: boolean }|null} actor
 * @returns {Array<{ name: string, description: string, inputSchema: object }>}
 */
function listToolDefinitions(actor = null) {
  return ALL_TOOLS
    .filter((tool) => toolAllowed(actor, tool))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/**
 * Führt ein Tool aus.
 * @param {{ db: object, actor: { kind?: string, userId: number|null, role?: string|null, familyRole?: string|null, scopes?: readonly string[]|null, moduleAccess?: object|null, unresolved?: boolean }, requestHeaders?: object }} ctx
 * @param {string} name  - Tool-Name
 * @param {object} args  - Tool-Argumente
 * @returns {Promise<any>} rohes Ergebnis (wird vom Protokoll-Layer serialisiert)
 * @throws {ToolError} bei unbekanntem Tool, fehlender Berechtigung oder Validierungsfehler
 */
async function callTool(ctx, name, args = {}) {
  const tool = TOOL_MAP.get(name);
  if (!tool) throw new ToolError(`Unknown tool: ${name}`);
  const actor = ctx.actor || null;
  if (!toolAllowed(actor, tool)) {
    // Eine Meldung für beide Gründe: welche der zwei Grenzen zugeschlagen hat,
    // geht den Aufrufer nichts an (und verriete, dass es das Modul gibt).
    throw new ToolError(`Tool "${name}" is not permitted for this account.`);
  }
  return tool.handler(ctx, args || {});
}

export { TOOL_DEFINITIONS, listToolDefinitions, callTool, ToolError, MAX_IDEMPOTENCY_KEY_LENGTH };
