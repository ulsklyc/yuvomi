/**
 * Modul: Einstellungen (Settings) — Controller
 * Zweck: Dünner Controller für die Settings-Sektion. Löst Auth-Refresh,
 *        State-Migration, Rollen-Guards und die Wahl des Ziel-Blatts auf und
 *        delegiert das Rendern vollständig an die Settings-Shell. Jede
 *        seitenspezifische Logik (inkl. API-Endpunkte) lebt in den Blatt-Modulen.
 * Abhängigkeiten: /api.js, /settings/registry.js, /settings/shell.js
 */

import { auth } from '/api.js';
import { getLocale } from '/i18n.js';
import {
  SETTINGS_STORAGE_KEY,
  filterSettingsDomains,
  findSettingsLeaf,
  readStoredSettingsDestination,
} from '/settings/registry.js';
import { renderSettingsShell } from '/settings/shell.js';

const SETTINGS_ROOT = '/settings';
const ACCOUNT_LEAF = '/settings/personal/account';
const SYNC_CALENDAR_LEAF = '/settings/sync/calendar';
const OVERVIEW_VIEWS = new Set(['domains', 'domain']);

// Container der zuletzt gemounteten Shell — Basis für das Soft-Update (update()).
let mountedContainer = null;
// Sprache der zuletzt gerenderten Shell; ein Wechsel erzwingt vollen Re-Render.
let renderedLocale = null;

async function refreshUser(user) {
  if (user) return user;

  try {
    const me = await auth.me();
    if (me?.user) return me.user;
  } catch {
    // Non-critical: the router owns the auth redirect if no user is available.
  }
  return user;
}

// Wir werden aus render() heraus aufgerufen, während der Router noch mitten in
// seiner navigate()-Schleife steckt (isNavigating === true). Ein direkter
// navigate()-Aufruf wäre dort ein No-op. Daher wird die History sofort
// korrigiert, die eigentliche Navigation aber auf den nächsten Macrotask
// verschoben — nach dem finally des laufenden navigate().
function redirectTo(target) {
  history.replaceState({ path: target }, '', target);
  setTimeout(() => {
    window.oikos?.navigate(target, false);
  }, 0);
}

export async function render(container, { user } = {}) {
  try {
    mountedContainer = container;
    renderedLocale = getLocale();
    const currentUser = await refreshUser(user);

    const path = window.location.pathname;
    const query = new URLSearchParams(window.location.search);
    const view = query.get('view');

    // OAuth-Callback (?sync_ok / ?sync_error) landet auf /settings und gehört in
    // das Kalender-Sync-Blatt, das den Banner aus der Query rendert.
    const hasOAuthResult = query.has('sync_ok') || query.has('sync_error');

    if (path === SETTINGS_ROOT) {
      if (hasOAuthResult) {
        const target = `${SYNC_CALENDAR_LEAF}?${query.toString()}`;
        if (findSettingsLeaf(SYNC_CALENDAR_LEAF, currentUser)) {
          await redirectTo(target);
          return;
        }
      }

      // Explizite Übersicht (Domänen oder einzelne Domäne) wird direkt gerendert.
      if (OVERVIEW_VIEWS.has(view)) {
        const domainId = view === 'domain' ? query.get('domain') : null;
        const domains = filterSettingsDomains(currentUser);
        const resolvedView = view === 'domain' && domains.some((domain) => domain.id === domainId)
          ? 'domain'
          : 'domains';
        await renderSettingsShell(container, {
          user: currentUser,
          view: resolvedView,
          domainId: resolvedView === 'domain' ? domainId : null,
          query,
        });
        return;
      }

      // Standard: zuletzt besuchtes (erlaubtes) Blatt wiederherstellen.
      const destination = readStoredSettingsDestination(currentUser);
      await redirectTo(destination);
      return;
    }

    // Direkter Aufruf eines Blatts: Rollen-Guard + Persistenz.
    const leaf = findSettingsLeaf(path, currentUser);
    if (!leaf) {
      sessionStorage.setItem('oikos:settings:notice', 'accessRedirected');
      await redirectTo(ACCOUNT_LEAF);
      return;
    }

    try {
      sessionStorage.setItem(SETTINGS_STORAGE_KEY, leaf.path);
    } catch {
      // Persistenz ist optional; ein fehlschlagender Storage darf nichts blockieren.
    }

    await renderSettingsShell(container, { user: currentUser, leaf, query });
  } catch (error) {
    container.replaceChildren();
    throw error;
  }
}

// Soft-Navigation innerhalb der Einstellungen (vom Router aufgerufen): tauscht
// nur den Detailbereich der bestehenden Shell aus — Sidebar bleibt montiert,
// keine Slide-Transition, kein erneuter Auth-Refresh. Rückgabe false signalisiert
// dem Router, regulär (voll) zu rendern (Root-Redirect, OAuth, unbekanntes Blatt).
export async function update({ user, path, query } = {}) {
  if (!mountedContainer?.isConnected) return false;

  // Bei locale-changed bliebe inkrementell die Sidebar/der Seitenkopf in der alten
  // Sprache — ein Locale-Wechsel erzwingt daher ein volles Neu-Rendern der Shell.
  const currentLocale = getLocale();
  const localeChanged = renderedLocale !== currentLocale;
  renderedLocale = currentLocale;

  const search = query ?? new URLSearchParams();
  const view = search.get('view');
  const hasOAuthResult = search.has('sync_ok') || search.has('sync_error');

  if (path === SETTINGS_ROOT) {
    if (hasOAuthResult || !OVERVIEW_VIEWS.has(view)) return false;
    const domainId = view === 'domain' ? search.get('domain') : null;
    const domains = filterSettingsDomains(user);
    const resolvedView = view === 'domain' && domains.some((domain) => domain.id === domainId)
      ? 'domain'
      : 'domains';
    await renderSettingsShell(mountedContainer, {
      user,
      view: resolvedView,
      domainId: resolvedView === 'domain' ? domainId : null,
      query: search,
      incremental: !localeChanged,
    });
    return true;
  }

  const leaf = findSettingsLeaf(path, user);
  if (!leaf) return false;

  try {
    sessionStorage.setItem(SETTINGS_STORAGE_KEY, leaf.path);
  } catch {
    // Persistenz ist optional; ein fehlschlagender Storage darf nichts blockieren.
  }

  await renderSettingsShell(mountedContainer, { user, leaf, query: search, incremental: !localeChanged });
  return true;
}
