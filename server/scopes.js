/**
 * Modul: Token-Scopes
 * Zweck: Geteiltes Berechtigungsmodell für API-/MCP-Tokens. Ein Token kann auf
 *        einzelne Module und die Zugriffsart (lesen/schreiben) eingeschränkt
 *        werden — vor allem für MCP-Tokens, die an externe LLM-Clients ausgegeben
 *        werden und sonst den kompletten Familien-Datenbestand erreichen könnten
 *        (siehe Discussion #455).
 *
 * Vertrag:
 *   - `scopes === null` (oder undefined) → KEIN Scoping, voller rollenbasierter
 *     Zugriff. So verhalten sich alle vor Migration v72 erstellten Tokens.
 *   - `scopes` ist ein Array aus `"<modul>:read"` / `"<modul>:write"`. Nur die
 *     gelisteten Kombinationen sind erlaubt; alles andere wird verweigert.
 *   - `write` schließt `read` mit ein (wer schreiben darf, darf zurücklesen).
 *
 * Diese Datei hat bewusst keine Abhängigkeiten (kein express/db), damit sie sowohl
 * in der REST-Middleware als auch in der reinen MCP-Tool-Schicht nutzbar ist.
 */

// Kanonische, scopebare Module. `key` = Scope-Modul, `prefixes` = die ersten
// Pfadsegmente unter /api/v1, die dieses Modul besitzt (mehrere Router können sich
// ein Modul teilen, z. B. calendar + reminders + birthdays).
const SCOPE_MODULES = [
  { key: 'tasks',        prefixes: ['tasks'] },
  { key: 'shopping',     prefixes: ['shopping'] },
  { key: 'meals',        prefixes: ['meals', 'recipes', 'recipe-providers'] },
  { key: 'pantry',       prefixes: ['pantry'] },
  { key: 'inventory',    prefixes: ['inventory'] },
  { key: 'calendar',     prefixes: ['calendar', 'reminders', 'birthdays'] },
  { key: 'notes',        prefixes: ['notes'] },
  { key: 'contacts',     prefixes: ['contacts'] },
  { key: 'schedule',     prefixes: ['schedule'] },
  { key: 'budget',       prefixes: ['budget', 'split-expenses'] },
  { key: 'documents',    prefixes: ['documents'] },
  { key: 'health',       prefixes: ['health'] },
  { key: 'rewards',      prefixes: ['rewards'] },
  { key: 'housekeeping', prefixes: ['housekeeping'] },
  { key: 'waste',        prefixes: ['waste'] },
  { key: 'weather',      prefixes: ['weather'] },
  { key: 'family',       prefixes: ['family'] },
  // `quick-links` teilt sich den Schluessel mit `dashboard`: die Kachelreihe ist
  // kein eigenes Modul (#469), aber ihre Route braucht eine Zuordnung - ohne
  // eine waere sie fuer JEDES gescopte Token gesperrt (tokenAllows verweigert
  // unbekannte Module) und damit auch fuer das, das die Uebersicht lesen darf.
  { key: 'dashboard',    prefixes: ['dashboard', 'quick-links'] },
  { key: 'search',       prefixes: ['search'] },
];

const MODULE_KEYS = SCOPE_MODULES.map((m) => m.key);

/** Extension scope modules registered at runtime from third-party manifests. */
let _extensionScopeModules = [];

export function setExtensionScopeModules(modules) {
  _extensionScopeModules = Array.isArray(modules)
    ? modules.filter((m) => m && typeof m.key === 'string' && Array.isArray(m.prefixes))
    : [];
  rebuildScopeMaps();
}

function allScopeModules() {
  return [...SCOPE_MODULES, ..._extensionScopeModules];
}

let MODULE_KEY_SET = new Set(MODULE_KEYS);
let PREFIX_TO_MODULE = new Map();
let ALL_SCOPES = MODULE_KEYS.flatMap((key) => [`${key}:read`, `${key}:write`]);
let ALL_SCOPE_SET = new Set(ALL_SCOPES);

function rebuildScopeMaps() {
  const keys = allScopeModules().map((m) => m.key);
  MODULE_KEY_SET = new Set(keys);
  PREFIX_TO_MODULE = new Map();
  for (const mod of allScopeModules()) {
    for (const prefix of mod.prefixes) PREFIX_TO_MODULE.set(prefix, mod.key);
  }
  ALL_SCOPES = keys.flatMap((key) => [`${key}:read`, `${key}:write`]);
  ALL_SCOPE_SET = new Set(ALL_SCOPES);
}

rebuildScopeMaps();

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Parst den DB-Wert der `scopes`-Spalte in ein Array oder `null`.
 * NULL/leerer String/ungültiges JSON → `null` (= kein Scoping, voller Zugriff).
 * @param {string|null|undefined|string[]} raw
 * @returns {string[]|null}
 */
function parseScopes(raw) {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return normalizeScopes(raw);
  const text = String(raw).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return normalizeScopes(parsed);
  } catch {
    return null;
  }
}

/**
 * Bereinigt eine Scope-Liste: nur bekannte `modul:read`/`modul:write`-Strings,
 * dedupliziert, stabil sortiert. Ungültige Einträge werden verworfen.
 * @param {unknown[]} list
 * @returns {string[]}
 */
function normalizeScopes(list) {
  const out = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const scope = String(entry || '').trim().toLowerCase();
    if (ALL_SCOPE_SET.has(scope)) out.add(scope);
  }
  return [...out].sort();
}

/**
 * Serialisiert eine (bereits normalisierte) Scope-Liste für die DB.
 * @param {string[]|null} scopes
 * @returns {string|null} JSON-String oder null (= kein Scoping).
 */
function serializeScopes(scopes) {
  if (scopes === null || scopes === undefined) return null;
  return JSON.stringify(normalizeScopes(scopes));
}

/** Lese- oder Schreibzugriff für eine HTTP-Methode. */
function requiredAccess(method) {
  return READ_METHODS.has(String(method || '').toUpperCase()) ? 'read' : 'write';
}

/**
 * Ermittelt den Modul-Schlüssel für einen /api/v1-Pfad (ohne führendes /api/v1).
 *
 * GROSS-/KLEINSCHREIBUNG WIRD HIER GEFALTET, WEIL EXPRESS SIE BEIM ROUTEN
 * IGNORIERT. Express matcht Mount-Pfade und Routen standardmaessig ohne
 * Beachtung der Schreibweise: `/Notes` landet im Notiz-Router wie `/notes`.
 * Ohne das Falten fand diese Funktion fuer `/Notes` keinen Praefix und gab
 * `null` zurueck - und die Modul-Deny-Liste in server/index.js laesst `null`
 * durch. Ein Mitglied mit `notes: none` las so jede sichtbare Notiz, eines
 * mit `tasks: read` schrieb Aufgaben. Alle Praefixe sind klein geschrieben
 * (Kern-Module hier oben, Erweiterungen per `MODULE_ID_RE`).
 * @param {string} path z. B. "/health/cycle" oder "health/cycle"
 * @returns {string|null} Modul-Schlüssel oder null (unbekannt/nicht scopebar).
 */
function moduleForPath(path) {
  const cleaned = String(path || '').replace(/^\/+/, '').toLowerCase();
  const parts = cleaned.split('/').filter(Boolean);
  if (parts[0] === 'extensions' && parts[1]) {
    const extKey = PREFIX_TO_MODULE.get(`extensions/${parts[1]}`);
    if (extKey) return extKey;
  }
  if (parts.length >= 2) {
    const compound = `${parts[0]}/${parts[1]}`;
    const compoundKey = PREFIX_TO_MODULE.get(compound);
    if (compoundKey) return compoundKey;
  }
  return PREFIX_TO_MODULE.get(parts[0]) || null;
}

/**
 * DIE BENANNTEN AUSNAHMEN VOM PFAD-GUARD - EINE TABELLE FUER ALLE LESER.
 *
 * Der Pfad-Guard verlangt fuer jeden schreibenden Aufruf das Schreibrecht auf
 * das Modul des Pfads. Genau diese Eintraege senken das noetige Niveau auf
 * `read`, ohne den Modul-Schluessel anzufassen (`none` bleibt verweigert - ein
 * `null`-Schluessel wuerde `moduleAccessVerdict()` bedingungslos erlauben
 * lassen). Gelesen wird die Tabelle von beiden Gates in server/index.js (ueber
 * die beiden Funktionen darunter), und `public/utils/module-access.js` fuehrt
 * eine Kopie, die `npm run test:module-write-access` Eintrag fuer Eintrag
 * dagegen haelt. Eine neue Ausnahme entsteht HIER und nur hier.
 *
 *   - `schedule-preferences` (S-12, UX-Audit): Vorlaufzeit und Wochenstunden
 *     haengen an der EIGENEN users-Zeile, kein Admin-Gate. Exakt dieser Pfad,
 *     kein `startsWith` (`/schedule/preferencesX` ist nicht mitgemeint), jede
 *     Methode, nur fuer Sitzungen - ein Token bleibt an `schedule:write`
 *     gebunden.
 *   - `recipe-to-shopping` (#1290, entschieden am 22.09.2026): die Route liest
 *     das Rezept und legt nur `shopping_items` an; `shopping: write` verlangt
 *     sie selbst (`mayWriteModule`). Nur POST, numerische ID, fuer Sitzungen
 *     UND Tokens. Schreibweise und Schlussstrich werden gefaltet, weil Express
 *     beides beim Routen ignoriert (GHSA-cvwj). Mahlzeit -> Einkauf faellt
 *     NICHT darunter: jene Route kippt `on_shopping_list` im Essensplan.
 *
 * `pattern`/`flags` sind die Teile eines RegExp als Text, damit die Kopie im
 * Client vergleichbar bleibt; `methods: null` heisst jede Methode.
 */
const READ_LEVEL_WRITES = Object.freeze([
  Object.freeze({
    id: 'schedule-preferences',
    // OHNE Falten von Schreibweise und Schlussstrich - mit Absicht, und es
    // schliesst: `/Schedule/Preferences` oder `/schedule/preferences/` erreicht
    // dieselbe Route, faellt hier aber nicht unter die Ausnahme und verlangt
    // `schedule: write`. Strenger als die Route ist nur ein Fehlalarm, nie eine
    // Umgehung. Nicht an den Rezept-Eintrag darunter "angleichen", ohne es zu
    // entscheiden: die Oberflaeche schickt nur die kleine Form.
    pattern: '^\\/schedule\\/preferences$',
    flags: '',
    methods: null,
    axes: Object.freeze(['session']),
  }),
  Object.freeze({
    id: 'recipe-to-shopping',
    pattern: '^\\/recipes\\/\\d+\\/to-shopping-list\\/?$',
    flags: 'i',
    methods: Object.freeze(['POST']),
    axes: Object.freeze(['session', 'token']),
  }),
]);

const READ_LEVEL_MATCHERS = READ_LEVEL_WRITES.map((entry) => ({
  ...entry,
  re: new RegExp(entry.pattern, entry.flags),
}));

/** Senkt eine benannte Ausnahme fuer diese Achse das Niveau auf `read`? */
function readLevelWrite(axis, path, method) {
  const verb = String(method || '').toUpperCase();
  const p = String(path || '');
  return READ_LEVEL_MATCHERS.some((entry) => entry.axes.includes(axis)
    && (entry.methods === null || entry.methods.includes(verb))
    && entry.re.test(p));
}

/**
 * Modul-Schlüssel + benötigtes Zugriffsniveau für eine Session-Anfrage
 * (`moduleAccessVerdict()`'s zweites/drittes Argument): `moduleForPath()` +
 * `requiredAccess()`, abgesenkt auf `read` fuer die Eintraege aus
 * `READ_LEVEL_WRITES` mit der Achse `session`.
 * @param {string} path z. B. "/schedule/preferences"
 * @param {string} method HTTP-Methode
 * @returns {{ moduleKey: string|null, access: 'read'|'write' }}
 */
function sessionModuleAccessRequirement(path, method) {
  return {
    moduleKey: moduleForPath(path),
    access: readLevelWrite('session', path, method) ? 'read' : requiredAccess(method),
  };
}

/**
 * Dasselbe fuer ein gescoptes Zugangsmittel (Token, Display): abgesenkt nur
 * fuer die Eintraege mit der Achse `token`.
 * @param {string} path
 * @param {string} method
 * @returns {{ moduleKey: string|null, access: 'read'|'write' }}
 */
function tokenAccessRequirement(path, method) {
  return {
    moduleKey: moduleForPath(path),
    access: readLevelWrite('token', path, method) ? 'read' : requiredAccess(method),
  };
}

/** All scope module keys including runtime extension modules. */
function getModuleKeys() {
  return allScopeModules().map((m) => m.key);
}

/** All valid scope strings including extension modules. */
function getAllScopes() {
  return ALL_SCOPES;
}

/**
 * Kernprüfung: Erlaubt die Scope-Liste den Zugriff auf ein Modul in einer
 * Zugriffsart? `write` schließt `read` ein. `scopes === null` = voller Zugriff.
 * Unbekanntes Modul bei gesetzten Scopes → verweigert (Least Privilege).
 * @param {string[]|null} scopes
 * @param {string|null} moduleKey
 * @param {'read'|'write'} access
 * @returns {boolean}
 */
function tokenAllows(scopes, moduleKey, access) {
  if (scopes === null || scopes === undefined) return true;
  if (!moduleKey || !MODULE_KEY_SET.has(moduleKey)) return false;
  if (scopes.includes(`${moduleKey}:write`)) return true;
  if (access === 'read') return scopes.includes(`${moduleKey}:read`);
  return false;
}

/**
 * Darf dieses Credential die VERWALTUNGSDETAILS einer Integration sehen?
 *
 * Gemeint sind Server-Adressen, Benutzernamen und Kontomailadressen der
 * angebundenen Konten - `GET /calendar/caldav/status`, `/calendar/outlook/status`.
 * Der Pfad-Guard urteilt am ersten Segment, `calendar:read` reicht also bis in
 * diese Statusrouten hinein. Ein Wandtablett hat genau diesen Scope, haengt
 * oeffentlich und braucht von alldem nichts (#1241 Runde 3); dasselbe gilt fuer
 * ein Integrationstoken, das fuer einen fremden Client ausgestellt wurde.
 *
 * AN DEN SCOPES GEMESSEN, NICHT AM KONTOTYP - dieselbe Entscheidung wie bei den
 * Abo-Quell-URLs in Runde 1: die Luecke ist keine Eigenheit des Displays,
 * sondern die jedes gescopten Credentials. Eine Sitzung (`authScopes === null`)
 * sieht unveraendert alles; fuer sie aendert sich nichts.
 */
function integrationDetailsVisible(req) {
  return req?.authScopes == null;
}

export {
  integrationDetailsVisible,
  SCOPE_MODULES,
  MODULE_KEYS,
  ALL_SCOPES,
  parseScopes,
  normalizeScopes,
  serializeScopes,
  requiredAccess,
  moduleForPath,
  sessionModuleAccessRequirement,
  tokenAccessRequirement,
  READ_LEVEL_WRITES,
  tokenAllows,
  getModuleKeys,
  getAllScopes,
};
