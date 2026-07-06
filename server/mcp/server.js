/**
 * Modul: MCP-Server (HTTP-Transport)
 * Zweck: Streamable-HTTP-Endpoint (stateless) für MCP-Clients. Authentifizierung
 *        erfolgt über die bestehenden Bearer-API-Tokens (siehe server/auth.js);
 *        der Router wird in index.js hinter `requireAuth` gemountet, daher greift
 *        der CSRF-Bypass für `api_token` automatisch.
 * Abhängigkeiten: express, server/db.js, server/logger.js, server/mcp/protocol.js
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { handleMcpRequest, PARSE_ERROR } from './protocol.js';

const log = createLogger('MCP');
const router = express.Router();

// POST: einzelne JSON-RPC-Nachricht → einzelne JSON-Antwort (oder 202 bei Notification).
router.post('/', async (req, res) => {
  try {
    if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
      return res.status(400).json({
        jsonrpc: '2.0', id: null,
        error: { code: PARSE_ERROR, message: 'Parse error: expected a JSON-RPC 2.0 body.' },
      });
    }
    const actor = { id: req.authUserId, role: req.authRole };
    const response = await handleMcpRequest(
      db.get(),
      actor,
      req.body,
      (err) => {
        log.error('MCP tool error:', err);
      },
      { requestHeaders: req.headers },
    );
    if (response === null) return res.status(202).end();
    return res.json(response);
  } catch (err) {
    log.error('MCP request error:', err);
    return res.status(500).json({
      jsonrpc: '2.0', id: null,
      error: { code: -32603, message: 'Internal error.' },
    });
  }
});

// Der stateless Endpoint bietet keinen server-initiierten SSE-Stream an.
router.get('/', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0', id: null,
    error: { code: -32000, message: 'Method Not Allowed: use POST for MCP requests.' },
  });
});

export default router;
