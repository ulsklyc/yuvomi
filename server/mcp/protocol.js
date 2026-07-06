/**
 * Modul: MCP-Protokoll (JSON-RPC 2.0)
 * Zweck: Stateless-Dispatcher für die MCP-Methoden `initialize`, `tools/list`,
 *        `tools/call`, `ping` sowie Notifications. Rein und seiteneffektfrei —
 *        `handleMcpRequest(database, actorId, body)` gibt das JSON-RPC-Antwort-
 *        objekt zurück (oder null bei Notifications). Testbar ohne db/express.
 * Abhängigkeiten: server/mcp/tools.js, package.json (Versionsangabe)
 */

import { readFileSync } from 'node:fs';
import { TOOL_DEFINITIONS, callTool, ToolError } from './tools.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

// Vom Server unterstützte MCP-Protokollversionen (neueste zuerst).
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const SERVER_INFO = { name: 'yuvomi', version: pkg.version };

// JSON-RPC-Fehlercodes
const PARSE_ERROR      = -32700;
const INVALID_REQUEST  = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS   = -32602;
const INTERNAL_ERROR   = -32603;

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Verarbeitet eine einzelne JSON-RPC-Nachricht.
 * @param {object} database - DB-Handle (better-sqlite3 oder node:sqlite)
 * @param {{ id: number, role?: string }} actor - authentifizierter Akteur
 * @param {any}    body      - geparster Request-Body
 * @param {(err: Error) => void} [onInternalError] - Logging-Hook für interne Fehler
 * @param {{ requestHeaders?: object }} [requestContext] - Request context for internal API-backed tools
 * @returns {object|null} JSON-RPC-Antwort oder null (Notification)
 */
async function handleMcpRequest(database, actor, body, onInternalError, requestContext = {}) {
  // Batches werden ab MCP 2025-06-18 nicht unterstützt.
  if (Array.isArray(body)) {
    return fail(null, INVALID_REQUEST, 'Batch requests are not supported.');
  }
  if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return fail(null, INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request.');
  }

  const { method, params } = body;
  const id = Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : undefined;
  const isNotification = id === undefined;

  try {
    // Notifications erwarten keine Antwort.
    if (isNotification) {
      // z. B. notifications/initialized — bestätigt, kein Response-Body.
      return null;
    }

    switch (method) {
      case 'initialize': {
        const requested = params && params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
        return ok(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      }

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, { tools: TOOL_DEFINITIONS });

      case 'tools/call': {
        const name = params && params.name;
        if (!name || typeof name !== 'string') {
          return fail(id, INVALID_PARAMS, 'Missing tool name.');
        }
        const args = (params && params.arguments) || {};
        try {
          const data = await callTool(
            { db: database, actor, requestHeaders: requestContext.requestHeaders || {} },
            name,
            args,
          );
          return ok(id, {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            isError: false,
          });
        } catch (err) {
          // Tool-/Validierungsfehler sind für das LLM sichtbar (isError), interne
          // Fehler werden generisch gemeldet und geloggt.
          if (err instanceof ToolError) {
            return ok(id, { content: [{ type: 'text', text: err.message }], isError: true });
          }
          if (onInternalError) onInternalError(err);
          return ok(id, { content: [{ type: 'text', text: 'Internal error executing tool.' }], isError: true });
        }
      }

      default:
        return fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    if (onInternalError) onInternalError(err);
    return fail(id ?? null, INTERNAL_ERROR, 'Internal error.');
  }
}

export {
  handleMcpRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  SERVER_INFO,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
};
