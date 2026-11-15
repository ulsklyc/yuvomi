/**
 * Modul: MCP-Server (HTTP-Transport)
 * Zweck: Streamable-HTTP-Endpoint (stateless) für MCP-Clients. Authentifizierung
 *        erfolgt über die bestehenden Bearer-API-Tokens (siehe server/auth.js);
 *        der Router wird in index.js hinter `requireAuth` gemountet, daher greift
 *        der CSRF-Bypass für `api_token` automatisch.
 *
 *        Hier bekommt die Tool-Schicht ihren Akteur. Das ist keine Formsache:
 *        die Kern-Tools laufen in-process gegen SQLite und sehen die
 *        /api/v1-Middleware NIE. Was diese Middleware an Rechten prüft, muss
 *        deshalb im Akteur mitreisen - Token-Scopes, Modulrechte des Nutzers
 *        (#467/#823), der Split-Guest-Status (#823) und das Wandtablett (#1208).
 *        Gebaut wird er seit Phase 2 (B1) an EINER Stelle,
 *        `actorFromRequest()` in server/authorize/: `kind` ist dort `guest` oder
 *        `display`, und ein Lesefehler zählt als die engere Art.
 * Abhängigkeiten: express, server/db.js, server/logger.js, server/mcp/protocol.js,
 *        server/authorize/
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { handleMcpRequest, PARSE_ERROR } from './protocol.js';
import { actorFromRequest } from '../authorize/index.ts';
import { hadNoBody } from '../middleware/empty-body.js';

const log = createLogger('MCP');
const router = express.Router();

// POST: einzelne JSON-RPC-Nachricht → einzelne JSON-Antwort (oder 202 bei Notification).
router.post('/', async (req, res) => {
  try {
    // hadNoBody: server/index.js setzt ohne Rumpf `{}` (#2209); das bleibt hier
    // ein Parse-Error und wird keine Anfrage ohne Methode.
    if (hadNoBody(req) || req.body === undefined || req.body === null || typeof req.body !== 'object') {
      return res.status(400).json({
        jsonrpc: '2.0', id: null,
        error: { code: PARSE_ERROR, message: 'Parse error: expected a JSON-RPC 2.0 body.' },
      });
    }
    // Wandtablett (#1208) und Ausgaben-Gast (#823) stecken in `actor.kind`:
    // `/mcp` liegt bewusst ausserhalb der /api/v1-Gates, ohne sie erreichte
    // ein Tablett hier Werkzeuge, die ihm die REST-Seite verweigert.
    const actor = actorFromRequest(req);
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
