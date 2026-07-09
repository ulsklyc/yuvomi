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
 */

// Navigations-/Widget-Modul → Permissions-Modulschlüssel. Muss zu
// server/permissions.js (PERMISSION_MODULES.navIds) passen. Nicht gelistete
// Nav-Module (dashboard, settings, third-party) sind nie gesperrt.
const NAV_TO_MODULE = Object.freeze({
  calendar: 'calendar',
  birthdays: 'calendar',
  tasks: 'tasks',
  notes: 'notes',
  contacts: 'contacts',
  meals: 'meals',
  recipes: 'meals',
  shopping: 'shopping',
  budget: 'budget',
  documents: 'documents',
  housekeeping: 'housekeeping',
  rewards: 'rewards',
  health: 'health',
});

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
  const key = NAV_TO_MODULE[navModule];
  if (!key) return true; // nicht gated
  return (_perms.modules?.[key] ?? 'write') !== 'none';
}

/** Effektiver Zugriff für ein Navigations-Modul (write, wenn nicht gated). */
export function navModuleAccess(navModule) {
  const key = NAV_TO_MODULE[navModule];
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
