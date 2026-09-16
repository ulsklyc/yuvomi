/**
 * Modul: MCP-Server (HTTP-Transport)
 * Zweck: Streamable-HTTP-Endpoint (stateless) für MCP-Clients. Authentifizierung
 *        erfolgt über die bestehenden Bearer-API-Tokens (siehe server/auth.js);
 *        der Router wird in index.js hinter `requireAuth` gemountet, daher greift
 *        der CSRF-Bypass für `api_token` automatisch.
 *
 *        Hier wird der Akteur für die Tool-Schicht zusammengesetzt. Das ist
 *        keine Formsache: die Kern-Tools laufen in-process gegen SQLite und
 *        sehen die /api/v1-Middleware NIE. Was diese Middleware an Rechten
 *        prüft, muss deshalb im Akteur mitreisen - Token-Scopes, Modulrechte
 *        des Nutzers (#467/#823) und der Split-Guest-Status (#823).
 * Abhängigkeiten: express, server/db.js, server/logger.js, server/mcp/protocol.js
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { handleMcpRequest, PARSE_ERROR } from './protocol.js';
import { isDisplayAccount } from '../services/display-accounts.js';

const log = createLogger('MCP');
const router = express.Router();

// Gast-Konto für geteilte Ausgaben? Unter /api/v1 sperrt ein eigener Guard diese
// Konten auf /split-expenses ein; /mcp liegt bewusst ausserhalb davon und hatte
// die Sperre damit gar nicht. Fehler beim Lesen zählen als Gast: im Zweifel
// zumachen, nicht aufmachen.
function isSplitGuest(userId) {
  if (userId == null) return true;
  try {
    return Boolean(db.get().prepare('SELECT 1 FROM split_expense_guest_users WHERE user_id = ?').get(userId));
  } catch (err) {
    log.error('Split-guest lookup failed:', err.message);
    return true;
  }
}

/** Wandtablett? Fehler beim Lesen zaehlen als Display: im Zweifel zumachen. */
function isDisplay(userId) {
  if (userId == null) return true;
  try {
    return isDisplayAccount(userId);
  } catch (err) {
    log.error('Display lookup failed:', err.message);
    return true;
  }
}

// POST: einzelne JSON-RPC-Nachricht → einzelne JSON-Antwort (oder 202 bei Notification).
router.post('/', async (req, res) => {
  try {
    if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
      return res.status(400).json({
        jsonrpc: '2.0', id: null,
        error: { code: PARSE_ERROR, message: 'Parse error: expected a JSON-RPC 2.0 body.' },
      });
    }
    const actor = {
      id: req.authUserId,
      role: req.authRole,
      scopes: req.authScopes ?? null,
      // Von requireAuth aufgelöst: null = Admin oder unbeschränkt.
      moduleAccess: req.sessionModuleAccess ?? null,
      splitGuest: isSplitGuest(req.authUserId),
      // Wandtablett (#1208)? `/mcp` liegt bewusst ausserhalb der /api/v1-Gates,
      // und der Display-Zweig in `requireAuth` setzt Scopes unabhaengig vom
      // Pfad - ohne diese Zeile erreichte ein Tablett hier Werkzeuge, die ihm
      // die REST-Seite verweigert. Dieselbe Klasse wie GHSA-4jcg-7jvj-p4v9:
      // eine Regel, die je Pfad statt zentral steht. Fehler beim Lesen zaehlen
      // als Display - im Zweifel zumachen.
      display: isDisplay(req.authUserId),
    };
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
