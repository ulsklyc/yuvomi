/**
 * Modul: Zugriffsrechte (Client-Store)
 * Zweck: Hält die vom Server aufgelösten Modul-/Widget-Rechte des angemeldeten
 *        Nutzers (aus /auth/me bzw. /auth/login) und stellt Helfer bereit, mit
 *        denen Router-Nav, Routen-Guard und Dashboard gesperrte Elemente
 *        ausblenden. Die VERBINDLICHE Durchsetzung bleibt serverseitig — dies ist
 *        reine UX (nichts anzeigen, was ohnehin 403 liefern würde). Siehe #467.
 *
 * Fail-open by design: Ohne geladene Rechte gilt Vollzugriff (leere Maps →
 * Standard 'write'/'allow'), passend zum serverseitigen Sparse-Modell. Der Server
 * bleibt das Gate, daher ist das clientseitige Default-Offen unkritisch.
 * Extension-Keys (`ext:{id}`) nutzen dieselben Maps und denselben Default: ein
 * noch nicht geladener Katalog sperrt nichts, das der Server nicht ohnehin
 * durchlässt.
 */

// Navigations-/Widget-Modul → Permissions-Modulschlüssel. Muss zu
// server/permissions.js (PERMISSION_MODULES.navIds) passen. Nicht gelistete
// Nav-Module (dashboard, settings) sind nie gesperrt. third-party-{id} ist
// gated nur wenn das Modul permissionModuleKey deklariert hat und
// setExtensionNavMap die Karte injiziert hat — sonst fail-open wie zuvor.
const NAV_TO_MODULE = Object.freeze({
  calendar: 'calendar',
  schedule: 'schedule',
  birthdays: 'calendar',
  tasks: 'tasks',
  notes: 'notes',
  contacts: 'contacts',
  meals: 'meals',
  recipes: 'meals',
  shopping: 'shopping',
  pantry: 'pantry',
  budget: 'budget',
  inventory: 'inventory',
  documents: 'documents',
  housekeeping: 'housekeeping',
  waste: 'waste',
  rewards: 'rewards',
  health: 'health',
});

/** third-party-{id} → ext:{id} */
let _extensionNavMap = Object.freeze({});

/** Übernimmt die Nav-Zuordnung aus enabled extension modules (runtime catalog). */
export function setExtensionNavMap(modules) {
  const map = {};
  for (const mod of Array.isArray(modules) ? modules : []) {
    if (mod?.capabilities?.permissionModuleKey) {
      map[`third-party-${mod.id}`] = mod.capabilities.permissionModuleKey;
    }
  }
  _extensionNavMap = Object.freeze(map);
}

function navPermissionKey(navModule) {
  return NAV_TO_MODULE[navModule] || _extensionNavMap[navModule] || null;
}

let _perms = { admin: false, modules: {}, widgets: {} };

/** Übernimmt die Rechte-Payload aus einer Auth-Antwort (/me, /login). */
export function setPermissions(payload) {
  if (payload && typeof payload === 'object') {
    _perms = {
      admin: payload.admin === true,
      modules: payload.modules && typeof payload.modules === 'object' ? payload.modules : {},
      widgets: payload.widgets && typeof payload.widgets === 'object' ? payload.widgets : {},
    };
  }
}

/** Setzt den Store zurück (Logout). */
export function clearPermissions() {
  _perms = { admin: false, modules: {}, widgets: {} };
}

export function getPermissions() {
  return _perms;
}

export function isPermAdmin() {
  return _perms.admin === true;
}

/** Effektiver Zugriff auf ein Permissions-Modul: 'none' | 'read' | 'write'. */
export function moduleAccess(moduleKey) {
  if (_perms.admin) return 'write';
  return _perms.modules?.[moduleKey] ?? 'write';
}

/** Darf ein Navigations-Modul (nav id) überhaupt geöffnet werden? */
export function canAccessNavModule(navModule) {
  if (_perms.admin) return true;
  const key = navPermissionKey(navModule);
  if (!key) return true;
  return (_perms.modules?.[key] ?? 'write') !== 'none';
}

/** Effektiver Zugriff für ein Navigations-Modul (write, wenn nicht gated). */
export function navModuleAccess(navModule) {
  const key = navPermissionKey(navModule);
  if (!key) return 'write';
  return moduleAccess(key);
}

/** Ist ein Nav-Modul nur lesend? (steuert z. B. FAB/Anlege-Aktionen) */
export function isNavModuleReadOnly(navModule) {
  return navModuleAccess(navModule) === 'read';
}

/** Darf ein Dashboard-Widget angezeigt werden? */
export function canSeeWidget(widgetId) {
  if (_perms.admin) return true;
  return (_perms.widgets?.[widgetId] ?? 'allow') !== 'none';
}
