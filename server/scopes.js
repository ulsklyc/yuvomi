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
 * Modul-Schlüssel + benötigtes Zugriffsniveau für eine Session-Anfrage
 * (`moduleAccessVerdict()`'s zweites/drittes Argument). Anders als
 * `moduleForPath()` + `requiredAccess()` allein senkt dies das Niveau auf
 * `read` für genau `/schedule/preferences` (S-12, UX-Audit: die eigene
 * Erinnerungsvorlaufzeit/Wochenstunden hängen an der EIGENEN users-Zeile,
 * kein Admin-Gate) — ohne den Modul-Schlüssel selbst auf `null` zu setzen,
 * was `moduleAccessVerdict()` unconditional auf "erlaubt" zwingen würde,
 * auch für `none`-Zugriff. Exaktes `===`, kein `startsWith`, damit
 * `/schedule/preferencesX` nicht mitgemeint ist.
 * @param {string} path z. B. "/schedule/preferences"
 * @param {string} method HTTP-Methode
 * @returns {{ moduleKey: string|null, access: 'read'|'write' }}
 */
function sessionModuleAccessRequirement(path, method) {
  const moduleKey = moduleForPath(path);
  const access = path === '/schedule/preferences' || isRecipeToShoppingTransfer(path, method)
    ? 'read'
    : requiredAccess(method);
  return { moduleKey, access };
}

/**
 * REZEPT -> EINKAUF LIEST DIE QUELLE UND SCHREIBT DAS ZIEL (#1290, entschieden
 * am 22.09.2026). `POST /recipes/:id/to-shopping-list` legt `shopping_items`
 * an und aendert am Rezept nichts - der Pfad-Guard verlangte trotzdem
 * `meals: write`, weil `/recipes` dem Modul `meals` gehoert. Fuer GENAU diese
 * Route reicht deshalb `meals: read`; das Schreibrecht auf das Ziel verlangt
 * die Route selbst (`mayWriteModule(req, 'shopping')` in routes/recipes.js).
 *
 * SCHMAL MIT ABSICHT. Nur POST, nur dieser Pfad mit numerischer ID: jeder
 * andere Schreibweg unter `/recipes` braucht weiter `meals: write`. Der
 * Modul-Schluessel bleibt `meals`, damit `none` weiter verweigert. Schreibweise
 * und Schlussstrich werden gefaltet, weil Express beides beim Routen ignoriert
 * (GHSA-cvwj: ein woertlicher Vergleich waere hier STRENGER als die Route und
 * damit nur ein Fehlalarm - gefaltet urteilt der Guard fuer jede Schreibweise,
 * die die Route erreicht, gleich). Mahlzeit -> Einkauf faellt NICHT darunter:
 * jene Route setzt `meal_ingredients.on_shopping_list` und schreibt damit in
 * den Essensplan.
 *
 * Gilt fuer BEIDE Gates in server/index.js - Mitgliedsrechte hier ueber
 * `sessionModuleAccessRequirement()`, Token-Scopes ueber
 * `tokenAccessRequirement()`.
 * @param {string} path
 * @param {string} method
 * @returns {boolean}
 */
function isRecipeToShoppingTransfer(path, method) {
  return String(method || '').toUpperCase() === 'POST'
    && /^\/recipes\/\d+\/to-shopping-list\/?$/i.test(String(path || ''));
}

/**
 * Modul-Schluessel + benoetigtes Niveau fuer ein gescoptes Zugangsmittel
 * (Token, Display). Anders als die Session-Variante OHNE die
 * `/schedule/preferences`-Ausnahme (die bleibt an `schedule:write` gebunden),
 * aber MIT der Rezept-Ausnahme: dort ist die Regel fuer beide Achsen dieselbe.
 * @param {string} path
 * @param {string} method
 * @returns {{ moduleKey: string|null, access: 'read'|'write' }}
 */
function tokenAccessRequirement(path, method) {
  return {
    moduleKey: moduleForPath(path),
    access: isRecipeToShoppingTransfer(path, method) ? 'read' : requiredAccess(method),
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
  isRecipeToShoppingTransfer,
  tokenAllows,
  getModuleKeys,
  getAllScopes,
};
