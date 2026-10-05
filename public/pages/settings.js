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
  movedSettingsUrl,
  readStoredSettingsDestination,
} from '/settings/registry.js';
import { renderSettingsShell } from '/settings/shell.js';

const SETTINGS_ROOT = '/settings';
const ACCOUNT_LEAF = '/settings/personal/account';
const SYNC_CALENDAR_LEAF = '/settings/modules/calendar';
const SYNC_CALENDAR_SECTION = 'sync-calendar'; // seit R10 ein Abschnitt im Blatt Kalender
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

// Aufgerufen aus render(), waehrend der Router noch in navigate() steckt (dort
// waere ein direkter navigate()-Aufruf ein No-op): History sofort korrigieren,
// die Navigation auf den naechsten Macrotask verschieben.
function redirectTo(target) {
  history.replaceState({ path: target }, '', target);
  setTimeout(() => {
    window.yuvomi?.navigate(target, false);
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
        const target = `${SYNC_CALENDAR_LEAF}?section=${SYNC_CALENDAR_SECTION}&${query.toString()}`;
        if (findSettingsLeaf(SYNC_CALENDAR_LEAF, currentUser)) {
          await redirectTo(target);
          return;
        }
      }

      // Zuletzt besuchtes Blatt wiederherstellen; ohne gespeichertes Ziel bleibt
      // es bei der Übersicht, statt den ersten Besuch wortlos in einem Formular
      // landen zu lassen (Critique 2026-07-27).
      const destination = OVERVIEW_VIEWS.has(view)
        ? null
        : readStoredSettingsDestination(currentUser);
      if (destination) { await redirectTo(destination); return; }

      const domainId = view === 'domain' ? query.get('domain') : null;
      const known = filterSettingsDomains(currentUser).some((d) => d.id === domainId);
      await renderSettingsShell(container, {
        user: currentUser,
        view: known ? 'domain' : 'domains',
        domainId: known ? domainId : null,
        query,
      });
      return;
    }

    // Direkter Aufruf eines Blatts: Rollen-Guard + Persistenz.
    const leaf = findSettingsLeaf(path, currentUser);
    if (!leaf) {
      sessionStorage.setItem('yuvomi:settings:notice', 'accessRedirected');
      await redirectTo(ACCOUNT_LEAF);
      return;
    }
    // Verschobenes Blatt oder ausgemusterte Option: aufs heutige Blatt samt
    // Abschnitt (S2); die uebrigen Parameter (OAuth-Ergebnis) reisen mit.
    const moved = movedSettingsUrl(path, window.location.search);
    if (leaf.path !== path || moved) { await redirectTo(moved ?? leaf.path); return; }

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
  // Verschoben (Blatt oder Option): nicht inkrementell, der reguläre Pfad leitet um.
  if (!leaf || leaf.path !== path || movedSettingsUrl(path, search)) return false;

  try {
    sessionStorage.setItem(SETTINGS_STORAGE_KEY, leaf.path);
  } catch {
    // Persistenz ist optional; ein fehlschlagender Storage darf nichts blockieren.
  }

  await renderSettingsShell(mountedContainer, { user, leaf, query: search, incremental: !localeChanged });
  return true;
}
