/**
 * Module: the module verdict (phase 2, section B2; until then server/permissions.js)
 * Purpose: what an actor MAY do with a module. The module -> access map of a
 *          session, the modules denied to or hidden from a request, read and write
 *          per module across both axes (role rights and token scopes), the
 *          capability questions, and the refusal for a record someone else
 *          created. What rights exist and how they are stored lives in catalog.ts.
 *          authorize() (B2) answers read, write and receive per module for an actor.
 *
 * Dependencies: catalog.ts, types.ts, server/scopes.js,
 * server/middleware/require-admin.js
 * (none of them loads server/db.js; see actor.ts). The connection is a parameter.
 * Erasable TS syntax only (runs through type stripping, no build).
 */

import { tokenAllows } from '../scopes.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { resolvePermissions } from './catalog.ts';
import type { Database, PermissionUser, ResolvedPermissions } from './catalog.ts';
import type { Actor } from './types.ts';

/** A module -> access map as requireAuth leaves it on a request; null = unrestricted. */
type ModuleAccessInput = Readonly<Record<string, string>> | null | undefined;

/** The request fields read here; requireAuth sets them (server/auth.js). */
type PermissionRequest = {
  authRole?: string | null;
  authMethod?: string;
  authUserId?: number | null;
  authDeviceId?: number | null;
  // tokenAllows() (scopes.js) takes undefined like null; its JSDoc says `string[]|null`,
  // hence the two casts below.
  authScopes?: readonly string[] | null;
  sessionModuleAccess?: ModuleAccessInput;
  session?: { userId?: number | null } | null;
};

/**
 * Baut die Modul→Access-Map für die /api/v1-Session-Durchsetzung.
 * Nur abweichende (eingeschränkte) Module werden gelistet; fehlt ein Modul,
 * gilt Vollzugriff. Gibt `null` zurück, wenn nichts eingeschränkt ist
 * (Fast-Path: Middleware ohne Arbeit) oder der Nutzer Admin ist.
 * @returns {Record<string,'none'|'read'>|null}
 */
export function buildSessionModuleAccess(
  resolved: { admin: boolean; modules: Readonly<Record<string, string>> } | null | undefined,
): Record<string, 'none' | 'read'> | null {
  if (!resolved || resolved.admin) return null;
  const map: Record<string, 'none' | 'read'> = {};
  let restricted = false;
  for (const [key, access] of Object.entries(resolved.modules)) {
    if (access !== 'write') {
      map[key] = access as 'none' | 'read';
      restricted = true;
    }
  }
  return restricted ? map : null;
}

/**
 * Die Module, die einem Betrachter GANZ entzogen sind — als Set.
 *
 * Eingabe ist `req.sessionModuleAccess`, also genau das, was die Middleware in
 * server/index.js schon aufgelöst hat: null (Admin oder unbeschränkt) oder eine
 * Karte der abweichenden Module. Kein zweiter DB-Zugriff, keine zweite
 * Auflösung — eine zweite Wahrheit über Rechte wäre die teuerste Sorte Fehler.
 *
 * NUR 'none' ZÄHLT, NICHT 'read'. Wer nur lesen darf, darf lesen; ein Filter,
 * der ihm die Daten wegnimmt, hätte aus der Leseberechtigung eine Sperre
 * gemacht.
 *
 * Gedacht für aggregierende Endpunkte, die die Pfad-Middleware nicht abdeckt:
 * /dashboard trägt Inhalte aus einem Dutzend Modulen, sein eigener Pfad löst
 * aber auf das Scope-Modul `dashboard` auf, das gar kein Permissions-Modul ist.
 * Der Guard lässt die Anfrage deshalb immer durch, und das Aussortieren muss in
 * der Route passieren.
 *
 * @param {Record<string,'none'|'read'>|null|undefined} sessionModuleAccess
 * @returns {Set<string>}
 */
export function deniedModules(sessionModuleAccess: ModuleAccessInput): Set<string> {
  const out = new Set<string>();
  for (const [key, level] of Object.entries(sessionModuleAccess || {})) {
    if (level === 'none') out.add(key);
  }
  return out;
}

/**
 * Was ein aggregierender Endpunkt für DIESE Anfrage auslassen muss — beide
 * Achsen in einem Aufruf.
 *
 * `deniedModules` kennt nur die Rollenachse. Ein API-Token trägt eine zweite
 * Grenze, seine Scopes (`req.authScopes`), und die prüft die Pfad-Middleware
 * ebenfalls nur am ersten Pfadsegment: ein Token mit `search:read` oder
 * `dashboard:read` kam dort durch und bekam Treffer und Kacheln aus Modulen,
 * die seine Scopes gar nicht nennen. Über die Rechte seines Subjekts kam es nie
 * hinaus, über die eigene Allow-Liste schon — und die ist genau für Tokens da,
 * die an einen fremden Client gehen (Discussion #455).
 *
 * `moduleKeys` sind die Module, aus denen der Endpunkt liest: eine Allow-Liste
 * braucht die Menge, gegen die sie prüft. Lesen verlangt `read` (`write`
 * schließt es ein); `authScopes === null` ist ungescopt und nimmt nichts weg.
 *
 * @param {{ sessionModuleAccess?: object|null, authScopes?: string[]|null }} req
 * @param {Iterable<string>} moduleKeys
 * @returns {Set<string>}
 */
export function hiddenModulesFor(req: PermissionRequest, moduleKeys: Iterable<string>): Set<string> {
  const hidden = deniedModules(req.sessionModuleAccess);
  for (const key of moduleKeys) {
    if (!tokenAllows(req.authScopes as string[] | null, key, 'read')) hidden.add(key);
  }
  return hidden;
}

/**
 * Darf dieses Credential in diesem Modul SCHREIBEN? Beide Achsen in einem Aufruf.
 *
 * Fuer die Handvoll GET-Routen, die es nur wegen einer Schreibgeste gibt: die
 * Sync-Ziel-Listen fuellen ein Feld im Aufgaben- und im Termindialog, und wer
 * dort nichts speichern darf, braucht die Auswahl nicht - wohl aber traegt sie
 * Kontonamen und Sammlungs-URLs der angebundenen Konten. Der Pfad-Guard in
 * server/index.js verlangt bei GET nur `read` (`requiredAccess`), diese Stellen
 * schulden die haertere Frage deshalb selbst.
 *
 * Gemessen am RECHT, nicht am Kontotyp: ein Wandtablett faellt heraus, weil es
 * nur Leserechte hat, und ein Mitglied mit `tasks: read` aus demselben Grund.
 */
export function mayWriteModule(req: PermissionRequest | null | undefined, moduleKey: string): boolean {
  return tokenAllows(req?.authScopes as string[] | null, moduleKey, 'write')
    && moduleAccessVerdict(req?.sessionModuleAccess, moduleKey, 'write') === MODULE_ACCESS_ALLOW;
}

/**
 * Darf dieses Credential in diesem Modul LESEN? Das Gegenstueck zu
 * `mayWriteModule()`, beide Achsen in einem Aufruf.
 *
 * Fuer jede Stelle, deren Pfad einem Modul gehoert und die Daten eines
 * ANDEREN liest: die Importe zwischen Vorrat und Einkauf, die Kontakt- und
 * Geburtstagsfelder der Split-Kandidaten, Buchungen am Inventar, Vorratszeilen
 * am Rezept, Belege, Geburtstags-Importkandidaten. Der Pfad-Guard in
 * server/index.js misst nur das eigene Modul.
 *
 * EINE REGEL: gebaut auf `hiddenModulesFor()`, damit "lesen darf" und "wird
 * ausgeblendet" nie auseinanderlaufen. Kein Nachbau aus `tokenAllows()` und
 * `deniedModules()` an der Aufrufstelle.
 */
export function mayReadModule(req: PermissionRequest, moduleKey: string): boolean {
  return !hiddenModulesFor(req, [moduleKey]).has(moduleKey);
}

// Urteil der Modulrechte-Prüfung. 'allow' = durchlassen, 'none' = Modul ganz
// gesperrt, 'read-only' = nur Lesen erlaubt, Schreibversuch abgewiesen.
export const MODULE_ACCESS_ALLOW = 'allow';
export const MODULE_ACCESS_DENIED = 'none';
export const MODULE_ACCESS_READ_ONLY = 'read-only';

/**
 * Erlaubt die aufgelöste Modulrechte-Karte diesen Zugriff?
 *
 * DIE Prüfung für jede Oberfläche, die Haushaltsdaten herausgibt — REST wie
 * MCP. Sie stand vorher nur inline in der /api/v1-Middleware, und genau das war
 * der Fehler aus #823: die MCP-Kern-Tools laufen in-process an express vorbei,
 * hatten damit keine Modulprüfung und gaben einem Mitglied mit `tasks: none`
 * die Aufgaben trotzdem heraus. Eine zweite Schreibweise derselben Regel wäre
 * dieselbe Falle noch einmal — deshalb ein Aufruf, kein Nachbau.
 *
 * DENY-Liste, keine Allow-Liste: `null` (Admin/unbeschränkt) und jedes nicht
 * gelistete Modul sind erlaubt. Nur was ausdrücklich eingeschränkt wurde, wird
 * abgewiesen.
 *
 * @param {Record<string,'none'|'read'>|null|undefined} sessionModuleAccess
 * @param {string|null} moduleKey - Scope-Modulschlüssel (scopes.js)
 * @param {'read'|'write'} access
 * @returns {'allow'|'none'|'read-only'}
 */
export function moduleAccessVerdict(
  sessionModuleAccess: ModuleAccessInput,
  moduleKey: string | null | undefined,
  access: string,
): 'allow' | 'none' | 'read-only' {
  if (!sessionModuleAccess) return MODULE_ACCESS_ALLOW;
  if (!moduleKey || !(moduleKey in sessionModuleAccess)) return MODULE_ACCESS_ALLOW;
  const level = sessionModuleAccess[moduleKey];
  if (level === 'none') return MODULE_ACCESS_DENIED;
  if (level === 'read' && access === 'write') return MODULE_ACCESS_READ_ONLY;
  return MODULE_ACCESS_ALLOW;
}

type Action = 'read' | 'write' | 'manage' | 'receive';
type Verdict = Readonly<{ allowed: boolean; reason: string | null }>;

const NO_ACTOR: Verdict = Object.freeze({ allowed: false, reason: 'no_actor' });
const ALLOWED: Verdict = Object.freeze({ allowed: true, reason: null });
const SCOPE: Verdict = Object.freeze({ allowed: false, reason: 'scope' });
const MODULE_NONE: Verdict = Object.freeze({ allowed: false, reason: 'module_none' });
const MODULE_READ_ONLY: Verdict = Object.freeze({ allowed: false, reason: 'module_read_only' });

/**
 * May this actor read, write or receive from this module? The ONE answer to the
 * module question (phase 2, section B2); before B2 it stood in MCP's toolAllowed,
 * in the delivery and the feeds (deniedModules() of the recipient) and in seven
 * reminder sources that compared the resolved module level with 'none' themselves.
 *
 *   - `actor == null` (an account that does not exist any more): nothing.
 *   - 'read' / 'write': first the token scopes, then the module rights - both must
 *     agree. A scope can only narrow the rights, never widen them.
 *   - 'receive': a message, a feed, a push. Allowed unless the module is denied
 *     entirely (`none`); `read` is enough - whoever may read a module may hear
 *     from it. NO token scopes: a scope belongs to a request, and a delivery is
 *     not one (see withoutModulesDeniedToRecipient() in
 *     services/reminder-origins.js). An admin (`moduleAccess: null`) always
 *     receives.
 *
 * The channel rules of /mcp (a display or an unresolved actor reaches no tool, a
 * guest no core tool) are not module verdicts; they stay in toolAllowed.
 *
 * 'manage' and resources other than a module come with B3/B4/C; until then they
 * throw, so nobody uses them silently.
 */
export function authorize(actor: Actor | null, action: Action, resource: { module: string }): Verdict {
  if (action === 'manage' || typeof resource?.module !== 'string') {
    throw new Error(`authorize: ${action} on ${JSON.stringify(resource)} is not implemented in B2`);
  }
  if (actor == null) return NO_ACTOR;
  const key = resource.module;
  if (action === 'receive') {
    return moduleAccessVerdict(actor.moduleAccess, key, 'read') === MODULE_ACCESS_DENIED ? MODULE_NONE : ALLOWED;
  }
  if (action !== 'read' && action !== 'write') {
    throw new Error(`authorize: action ${String(action)} is not implemented in B2`);
  }
  // Cast as in hiddenModulesFor(): tokenAllows() only reads the list.
  if (!tokenAllows(actor.scopes as string[] | null, key, action)) return SCOPE;
  const verdict = moduleAccessVerdict(actor.moduleAccess, key, action);
  if (verdict === MODULE_ACCESS_ALLOW) return ALLOWED;
  return verdict === MODULE_ACCESS_DENIED ? MODULE_NONE : MODULE_READ_ONLY;
}

/**
 * Nur-Lese-Payload für Clients (/auth/me, /login): die aufgelösten Maps plus
 * Admin-Flag. Der Client blendet damit Nav-Einträge, Settings-Ziele und
 * Dashboard-Widgets aus — die verbindliche Durchsetzung bleibt serverseitig.
 */
export function clientPermissions(
  database: Database,
  user: PermissionUser | null | undefined,
  { isDisplay = false }: { isDisplay?: boolean } = {},
): ResolvedPermissions {
  const { admin, modules, widgets, capabilities } = resolvePermissions(database, user, { isDisplay });
  return { admin, modules, widgets, capabilities };
}

/**
 * Darf diese Anfrage die Capability nutzen? Admin immer; sonst die Aufloesung
 * des Subjekts (Rollenprofil, Mitglied-Zeilen) - dieselbe wie im Rechte-Blatt.
 * Ohne aufloesbares Subjekt: nein. Fuer Felder, die eine Antwort WEGLAESST,
 * ist "im Zweifel weglassen" die sichere Seite.
 */
export function requestHasCapability(database: Database, req: PermissionRequest | null | undefined, key: string): boolean {
  if (!req) return false;
  if (isAdminRequest(req)) return true;
  const id = req.authUserId ?? req.session?.userId;
  if (id == null) return false;
  return userHasCapability(database, id, key, {
    isDisplay: req.authMethod === 'display',
    actingAsMember: req.authDeviceId != null,
  });
}

/**
 * Die Rolle, mit der ein Konto in DIESER Anfrage aufgeloest wird. Ein Admin ist
 * auf einem angemeldeten Geraet ein Mitglied (server/auth.js, `requireAuth`) -
 * auch dort, wo eine Regel die Zeile aus `users` liest statt `req.authRole`.
 * Sonst behielte ein verlorenes Telefon ueber die Rechte-Aufloesung, was ihm
 * `isAdminRequest()` eben genommen hat.
 */
export function userForRequest<User extends object>(req: PermissionRequest | null | undefined, user: User): User {
  return req?.authDeviceId != null && user ? { ...user, role: 'member' } : user;
}

/**
 * Darf das Konto die Capability nutzen - ohne Anfrage, aus der gespeicherten
 * Rolle und den Rechte-Zeilen? Admin immer, ein unbekanntes Konto nie. Die
 * Frage hinter `requestHasCapability()`, und die, die ein Nachtrag ueber ein
 * ANDERES Konto stellt als das anfragende (Zahlungsaufgaben,
 * services/payment-task-audience.js). Eine Migration ruft sie NIE auf: die
 * friert ihre Regel ein (Migration 250 in server/db.js).
 */
export function userHasCapability(
  database: Database,
  userId: number | null | undefined,
  key: string,
  { isDisplay = false, actingAsMember = false }: { isDisplay?: boolean; actingAsMember?: boolean } = {},
): boolean {
  if (userId == null) return false;
  const row = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(userId) as
    | { id: number; role: string; family_role: string | null }
    | undefined;
  if (!row) return false;
  const user = actingAsMember ? { ...row, role: 'member' } : row;
  if (user.role === 'admin') return true;
  return resolvePermissions(database, user, { isDisplay }).capabilities[key] === 'allow';
}

/**
 * Darf diese Anfrage einen Datensatz AENDERN oder LOESCHEN (R23, D5)?
 *
 * `own` sagt der Aufrufer, weil "eigen" je Modul etwas anderes heisst: die
 * Notiz und der Gegenstand, die ich angelegt habe; im Kalender zusaetzlich der
 * Termin, dem ich zugewiesen bin. Eigenes immer; Fremdes nur mit der
 * Capability des Moduls. Das Modulrecht selbst (`read` = gar nicht schreiben)
 * prueft weiter die Pfad-Middleware, diese Frage kommt danach.
 *
 * EINE Stelle fuer REST, API-Tokens und die MCP-Bruecke: `call_api_operation`
 * laeuft per Loopback durch dieselben Routen, und `requestHasCapability()`
 * liest das Subjekt aus `req.authUserId` wie aus der Sitzung.
 */
export function mayChangeRecord(
  database: Database,
  req: PermissionRequest | null | undefined,
  capabilityKey: string,
  own: unknown,
): boolean {
  if (own) return true;
  return requestHasCapability(database, req, capabilityKey);
}

/** Die Absage zu `mayChangeRecord()`: 403 mit festem Grund, den die Oberflaeche benennt. */
export function sendNotOwner<Sent>(res: { status(code: number): { json(body: unknown): Sent } }): Sent {
  return res.status(403).json({
    error: 'You can only change entries you created.',
    code: 403,
    reason: 'not_owner',
  });
}
