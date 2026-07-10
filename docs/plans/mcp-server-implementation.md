# Implementierungsplan: MCP-Server für Yuvomi

> Quelle: GitHub Discussion [#429](https://github.com/ulsklyc/yuvomi/discussions/429) — „Is there any plan to add an MCP to the tool?"
> Ziel: Ein `/mcp`-Endpoint, über den LLM-/Agent-Clients (Claude Desktop etc.) Yuvomi-Entitäten per natürlicher Sprache lesen und anlegen können.
> Dieser Plan ist so geschrieben, dass er in einem **frischen Kontextfenster** ausgeführt werden kann. Er setzt Kenntnis der Hard Constraints aus `CLAUDE.md` voraus.

## 0. Wichtigste Erkenntnis (spart die halbe Arbeit)

**Die Auth-Grundlage existiert bereits vollständig.** Yuvomi hat schon ein persistentes Personal-Access-Token-System (Bearer):

| Baustein | Ort |
|----------|-----|
| Tabelle `api_tokens` (`name`, `token_hash` sha256, `token_prefix`, `created_by`, `expires_at`, `revoked_at`, `last_used_at`, `created_at` + Indizes) | [server/db.js:807](../../server/db.js) |
| `extractApiToken()` — liest `Authorization: Bearer <token>` **oder** `X-API-Key` | [server/auth.js:214](../../server/auth.js) |
| `hashApiToken()` — sha256 | [server/auth.js:210](../../server/auth.js) |
| `authenticateApiToken()` — Hash-Lookup, Revoke-/Expiry-Prüfung, `last_used_at`-Update, mappt auf Ersteller-User + Rolle | [server/auth.js:387](../../server/auth.js) |
| `requireAuth` — probiert zuerst Token, dann Session → `req.authMethod='api_token'`, `req.authUserId`, `req.authRole` | [server/auth.js:427](../../server/auth.js) |
| CSRF-Bypass für Token-Requests (`if (req.authMethod === 'api_token') return next();`) | [server/middleware/csrf.js](../../server/middleware/csrf.js) |
| Admin-CRUD `GET/POST/DELETE /api/v1/auth/api-tokens` | [server/auth.js:978](../../server/auth.js) ff. |
| Settings-UI zum Erzeugen/Widerrufen | [public/settings/pages/admin-api.js](../../public/settings/pages/admin-api.js) |
| OpenAPI-Doku der Token-Auth | [server/openapi.js](../../server/openapi.js) |

**Konsequenz:** Es wird **keine neue Migration und keine neue Auth-Schicht** gebraucht. MCP ist eine dünne Protokoll-Schicht über der bestehenden REST-/DB-Logik, authentifiziert per vorhandenem Bearer-Token. Token werden heute vom Admin erzeugt und erben dessen Rolle — für v1 ausreichend.

## 1. Scope v1 (bewusst klein halten)

Kuratiertes Tool-Set für die häufigsten „quick add"-Fälle. Pro Entität je ein Read- und ein Create-Tool:

| MCP-Tool | Aktion | Referenz-Route (Validierung + Shape spiegeln) |
|----------|--------|-----------------------------------------------|
| `list_tasks` | offene Tasks lesen | `server/routes/tasks.js` (GET) |
| `create_task` | Task anlegen (Titel, optional Fälligkeit/Assignee) | `server/routes/tasks.js` (POST) |
| `list_shopping_items` | Einkaufsliste lesen | `server/routes/shopping.js` (GET) |
| `add_shopping_item` | Artikel hinzufügen | `server/routes/shopping.js` (POST) |
| `list_upcoming_events` | kommende Termine lesen | `server/routes/calendar.js` (GET) |
| `create_event` | Termin anlegen | `server/routes/calendar.js` (POST) |

Bewusst **nicht** in v1: Budget, Kontakte, Health, Dokumente (sensibel bzw. komplexes Schema). Erweiterung nach demselben Muster später.

## 2. Architektur-Entscheidungen

### 2.1 Kein SDK — Bare JSON-RPC über Streamable HTTP (Empfehlung)
- MCP-Kernprotokoll ist JSON-RPC 2.0. Für ein reines CRUD-Tool-Set werden nur drei Methoden gebraucht: `initialize`, `tools/list`, `tools/call` (keine `resources`, `prompts`, `sampling`, kein Server→Client-Streaming).
- **Stateless-Modus**: jeder POST auf `/mcp` trägt den Bearer-Token und wird eigenständig beantwortet — keine `Mcp-Session-Id`-Verwaltung, kein SSE nötig.
- Vorteile: **null neue Runtime-Dependencies** (passt zum Dep-minimalen, self-hosted, sicherheitsbewussten Projektethos), keine Supply-Chain-Fläche, `import`/`export`-konform.
- **Fallback**, falls Protokoll-Drift zum Wartungsproblem wird: `@modelcontextprotocol/sdk` (ESM) nachrüsten. Als Backend-Dependency erlaubt (die „No external frontend dependencies"-Regel gilt nur fürs Frontend). Entscheidung dokumentieren, falls gewechselt wird.

### 2.2 Auth: bestehende Bearer-Token wiederverwenden
- `/mcp` hinter `requireAuth` mounten. Damit funktioniert `Authorization: Bearer <oik_...>` sofort, und der bestehende CSRF-Bypass für `api_token` greift automatisch.
- **Wichtig — Reihenfolge in [server/index.js:319](../../server/index.js):** Aktuell ist `app.use('/api/v1', requireAuth)` gefolgt vom Guest-Guard und `csrfMiddleware`. Zwei Optionen:
  - (a) `/mcp` als **eigene** Top-Level-Route außerhalb von `/api/v1` mounten und explizit nur `requireAuth` davorsetzen (CSRF überspringen, da MCP-Clients keinen CSRF-Token haben und Bearer-Auth CSRF-immun ist). **Empfohlen.**
  - (b) Unter `/api/v1/mcp` mounten — dann greift die `/api/v1`-Kette inkl. `csrfMiddleware`; da MCP nur mit `api_token` genutzt wird, wird CSRF ohnehin übersprungen. Funktioniert, aber vermischt Protokoll-Namespaces.
- Der Guest-Guard (`split_expense_guest_users`) muss für `/mcp` **nicht** gelten → Option (a) umgeht ihn sauber.

### 2.3 Wiederverwendung der Geschäftslogik (DRY + Verhaltensparität)
Jeder Tool-Handler soll **nicht** die Route-Handler mit Fake-`req`/`res` aufrufen. Stattdessen:
- **Bevorzugt:** gemeinsame Logik der jeweiligen Route in eine Service-Funktion extrahieren (z. B. `createTask(db, userId, input)`), die sowohl der Express-Handler als auch der MCP-Handler aufruft. Bei den einfachen v1-Tools ist die Logik meist ein Validierungs-Block + `better-sqlite3`-Insert → gut extrahierbar.
- **Alternative (maximale Parität, mehr Overhead):** interner Loopback-HTTP-Call gegen das eigene `/api/v1/*` mit demselben Bearer-Token. Nur wählen, wenn eine Route viele Seiteneffekte hat (Recurrence, Reminder-Scheduling) und Extraktion zu riskant ist.
- Validierung: dieselben Regeln wie in der Referenz-Route spiegeln (`server/middleware/validate.js`-Helfer `str()`, `num()`, `date()` … wo möglich wiederverwenden).

## 3. Schritt-für-Schritt-Umsetzung

1. **Neue Datei `server/mcp/server.js`** (ESM, `import`/`export`):
   - Reiner JSON-RPC-2.0-Dispatcher: parst `{ jsonrpc, id, method, params }`, routet auf `initialize` / `tools/list` / `tools/call`.
   - `initialize` → antwortet mit `protocolVersion` (aktuelle MCP-Spec-Version verwenden), `capabilities: { tools: {} }`, `serverInfo: { name: "yuvomi", version }` (Version aus `package.json`).
   - `tools/list` → gibt die v1-Tool-Definitionen (Name, Beschreibung, `inputSchema` als JSON-Schema) zurück.
   - `tools/call` → dispatcht auf den Handler, gibt Ergebnis als MCP-`content` (Typ `text`, JSON-stringifiziert) zurück; Fehler als JSON-RPC-Error-Objekt bzw. `isError: true`-Content.
   - **Jeder Handler in `try/catch`** (Hard Constraint), Fehler geloggt via `createLogger()`, nie unhandled rejection.
2. **Neue Datei `server/mcp/tools.js`**: die sechs Tool-Definitionen + je eine Handler-Funktion, die die extrahierten Service-Funktionen aufruft. `req.authUserId` als Actor durchreichen.
3. **Service-Extraktion** in `server/routes/tasks.js`, `shopping.js`, `calendar.js`: gemeinsame Create-/List-Logik in aufrufbare Funktionen ziehen (Route-Handler ruft sie danach ebenfalls auf — Verhalten unverändert, per bestehenden Suites absichern).
4. **Mount in [server/index.js](../../server/index.js)**: `app.use('/mcp', requireAuth, mcpRouter)` (Option a), platziert **vor** der `/api/v1`-Kette oder als eigener Block. Sicherstellen: kein CSRF, kein Guest-Guard.
5. **`server/openapi.js`**: `/mcp` als authentifizierten Endpoint dokumentieren (Bearer). Optional, aber konsistent mit dem Rest.
6. **Frontend-Hinweis (minimal)**: in [public/settings/pages/admin-api.js](../../public/settings/pages/admin-api.js) einen kurzen Hinweis ergänzen, dass ein erzeugtes Token auch für den MCP-Endpoint (`<origin>/mcp`) nutzbar ist. Neue UI-Strings via `/locale-add` (de = kanonisch, alle `public/locales/*.json` pflegen). `esc()` für alle dynamischen Werte, kein `innerHTML`.

## 4. Tests (`npm run test:mcp`)

- Neue Datei `test/test-mcp.js`, Skript `test:mcp` in `package.json` (Muster siehe bestehende Suites; `import` von App-Code via `../`).
- In-Memory-SQLite, Route-Handler direkt importieren (kein laufender Server).
- Abdecken:
  - `initialize` liefert korrekte Capabilities/Version.
  - `tools/list` listet genau die v1-Tools.
  - `tools/call create_task` legt Task an (per DB verifizieren) und gibt korrekten Content zurück.
  - `tools/call` ohne/mit ungültigem Bearer → 401 bzw. JSON-RPC-Error.
  - Widerrufenes/abgelaufenes Token → abgelehnt (nutzt bestehende `authenticateApiToken`-Pfade).
  - Ungültige Tool-Argumente → sauberer Error, kein Crash.
  - CSRF wird für den MCP-Pfad nicht verlangt.

## 5. Doku, Deploy, Release (Reihenfolge am Ende)

- **`/docs-sync`**: MCP ist ein user-facing Feature → README, `docs/SPEC.md`, `docs/installation.md`, GitHub-Pages, ggf. `docs/integrations/` aktualisieren. **Kein** neuer Env-Var/Port/Volume nötig → `deploy-targets`-Regel wird voraussichtlich nicht ausgelöst (prüfen).
- **`/locale-add`** für alle neuen `t('…')`-Keys; danach optional `i18n-auditor`-Agent zur Vollständigkeitsprüfung.
- **`public/sw.js`**: `APP_RELEASE` == `package.json`-Version halten (sonst rote CI) — wird im Release-Schritt gebumpt.
- **`/release-prep`** (Default `minor`, da neues Feature): CHANGELOG, Version-Bump, Commit, Tag, Push, GitHub-Release. **Keine** Claude-Attribution in Commits/PRs.

## 6. Sicherheit & offene Punkte

- **Blast Radius**: v1-Token erben Admin-Rolle → MCP-Client kann alles, was der Ersteller darf. Für v1 akzeptabel (bewusst kleines, unkritisches Tool-Set). Später erwägen: gescopte/rollenbeschränkte Token oder ein „nur diese Tools"-Flag pro Token (neue Spalte → dann via `/add-migration`, append-only).
- **Rate-Limiting**: bestehenden `apiLimiter` auf `/mcp` anwenden.
- **HTTPS**: MCP-Clients sollten den Endpoint nur über TLS ansprechen (in Doku betonen).
- **Sensible Entitäten** (Budget, Kontakte, Health, Dokumente) bewusst aus v1 heraushalten.
- **Protokoll-Version**: aktuelle MCP-Spec-Version zum Implementierungszeitpunkt verifizieren (Streamable HTTP, `initialize`-Handshake). Bei Bedarf `@modelcontextprotocol/sdk` als Referenz/Backend-Dep evaluieren.

## 7. Abgrenzung zu Issue #280 (getrennt lassen!)

[Issue #280](https://github.com/ulsklyc/yuvomi/issues/280) („Hardening: gate first-run setup with a logged setup token") ist ein **anderes Thema** und teilt keine Implementierung mit MCP:

| | Issue #280 | MCP (#429) |
|---|---|---|
| Problem | unauthentifizierter Erst-Setup (`POST /auth/setup`) — TOCTOU-Fenster vor dem ersten Admin | laufender programmatischer Zugriff durch Agents |
| „Token" | einmaliges Setup-Gate, in Container-Logs gedruckt, beim Install einmal konsumiert | langlebiges Personal Access Token (**existiert bereits**, `api_tokens`) |
| Code-Pfad | unauth. Bootstrap-Route in `server/auth.js` | `requireAuth`-Bearer-Pfad (bereits vorhanden) |
| Speicher | env/Log/`sync_config` | `api_tokens`-Tabelle |

Beide berühren „Auth", aber die Umsetzung des einen bringt für das andere nichts. **Empfehlung: als zwei unabhängige Arbeitspakete führen.** MCP benötigt #280 nicht und umgekehrt.
