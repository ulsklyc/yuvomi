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
  { key: 'calendar',     prefixes: ['calendar', 'reminders', 'birthdays'] },
  { key: 'notes',        prefixes: ['notes'] },
  { key: 'contacts',     prefixes: ['contacts'] },
  { key: 'budget',       prefixes: ['budget', 'split-expenses'] },
  { key: 'documents',    prefixes: ['documents'] },
  { key: 'health',       prefixes: ['health'] },
  { key: 'rewards',      prefixes: ['rewards'] },
  { key: 'housekeeping', prefixes: ['housekeeping'] },
  { key: 'weather',      prefixes: ['weather'] },
  { key: 'family',       prefixes: ['family'] },
  { key: 'dashboard',    prefixes: ['dashboard'] },
  { key: 'search',       prefixes: ['search'] },
];

const MODULE_KEYS = SCOPE_MODULES.map((m) => m.key);
const MODULE_KEY_SET = new Set(MODULE_KEYS);

// Pfadsegment → Modul-Schlüssel (aus SCOPE_MODULES abgeleitet, keine Doppelpflege).
const PREFIX_TO_MODULE = new Map();
for (const mod of SCOPE_MODULES) {
  for (const prefix of mod.prefixes) PREFIX_TO_MODULE.set(prefix, mod.key);
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Alle gültigen Einzel-Scope-Strings (`modul:read` + `modul:write`). */
const ALL_SCOPES = MODULE_KEYS.flatMap((key) => [`${key}:read`, `${key}:write`]);
const ALL_SCOPE_SET = new Set(ALL_SCOPES);

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
 * @param {string} path z. B. "/health/cycle" oder "health/cycle"
 * @returns {string|null} Modul-Schlüssel oder null (unbekannt/nicht scopebar).
 */
function moduleForPath(path) {
  const segment = String(path || '').replace(/^\/+/, '').split('/')[0];
  return PREFIX_TO_MODULE.get(segment) || null;
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

export {
  SCOPE_MODULES,
  MODULE_KEYS,
  ALL_SCOPES,
  parseScopes,
  normalizeScopes,
  serializeScopes,
  requiredAccess,
  moduleForPath,
  tokenAllows,
};
