import { t } from '/i18n.js';
import { renderSubTabs } from '/utils/sub-tabs.js';

// Gesundheit ist EIN Seitenmodul mit fünf Deep-Link-Routen (Muster wie Settings),
// nicht — wie die Küche — drei eigenständige Top-Level-Module. Die Sub-Tab-Leiste
// navigiert zwischen den Routen; das Seitenmodul tauscht via update() nur das
// aktive Panel aus (Soft-Navigation, kein Full-Reload).
export const HEALTH_ROUTES = Object.freeze([
  '/health',
  '/health/vitals',
  '/health/cycle',
  '/health/fasting',
  '/health/meds',
  '/health/labs',
  '/health/activity',
]);
export const HEALTH_STORAGE_KEY = 'yuvomi-health-tab';

// Der Zyklus-Tab ist ein haushaltweiter Opt-in (Settings → Module → Gesundheit).
// Ist er deaktiviert, entfällt der Tab; die Route leitet auf die Übersicht um.
export const HEALTH_TABS = ({ cycleEnabled = true, fastingEnabled = false } = {}) => [
  { route: '/health',          labelKey: 'health.tabs.overview', icon: 'heart-pulse'    },
  { route: '/health/vitals',   labelKey: 'health.tabs.vitals',   icon: 'activity'       },
  ...(cycleEnabled ? [{ route: '/health/cycle', labelKey: 'health.tabs.cycle', icon: 'droplet' }] : []),
  ...(fastingEnabled ? [{ route: '/health/fasting', labelKey: 'health.tabs.fasting', icon: 'timer' }] : []),
  { route: '/health/meds',     labelKey: 'health.tabs.meds',     icon: 'pill'           },
  { route: '/health/labs',     labelKey: 'health.tabs.labs',     icon: 'flask-conical'  },
  { route: '/health/activity', labelKey: 'health.tabs.activity', icon: 'dumbbell'       },
];

export function isHealthRoute(path) {
  return HEALTH_ROUTES.includes(path);
}

export function getLastHealthRoute() {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const stored = sessionStorage.getItem(HEALTH_STORAGE_KEY);
      if (HEALTH_ROUTES.includes(stored)) return stored;
    }
  } catch { /* ignore */ }
  // Fallback: Übersicht. Gesundheit ist ein einziges Modul — wird es deaktiviert,
  // leitet der Router die Route ohnehin auf das Dashboard um.
  return '/health';
}

/**
 * Haengt die Sub-Tab-Leiste als zweite Zeile in den Modulkopf der Gesundheit.
 *
 * WARUM IN DEN KOPF UND NICHT DARUEBER: die Leiste wechselt keinen `module:`-Wert
 * (alle Health-Routen tragen `module: 'health'`, router.js), sie wechselt eine
 * SICHT innerhalb des Moduls. Damit gehoert sie unter den Large Title in den
 * kanonischen `page-toolbar`-Kopf - dieselbe Rollenverteilung wie in Budget,
 * Belohnungen und Haushaltshilfe. Sticky-Position, Seitengrund und Trennlinie
 * kommen dort vom Kopf; die Leiste gibt sie ab (Traegerregel in sub-tabs.css).
 *
 * Kein `title:` mehr: den Modulnamen fuehrt der `page-toolbar__title` des Kopfes.
 *
 * @param {HTMLElement} container - der Seiten-Container; muss die `.page-toolbar`
 *                                  der Gesundheit enthalten.
 */
export function renderHealthTabsBar(container, activeRoute, { cycleEnabled = true, fastingEnabled = false } = {}) {
  const toolbar = container.querySelector('.page-toolbar');
  if (!toolbar) return;

  renderSubTabs(toolbar, {
    // Sichten, keine Zielorte: alle sechs Routen tragen `module: 'health'` und
    // alle sechs Panels stehen gleichzeitig im DOM (health.js, panelMarkup) -
    // der Tabwechsel tauscht ein Panel, er laedt keine Seite. Die Route ist ein
    // Deep-Link in den Tab-Zustand; das macht die Leiste nicht zur Navigation.
    semantics: 'tabs',
    // Die Panels kommen vom Aufrufer, nicht aus einer Attributsuche im Baum:
    // ein `aria-controls` entsteht nur dort, wo es wirklich ein Panel gibt.
    panelFor: (route) => container.querySelector(`[data-health-panel="${CSS.escape(route)}"]`),
    tabs: HEALTH_TABS({ cycleEnabled, fastingEnabled }).map(({ route, labelKey, icon }) => ({ id: route, label: t(labelKey), icon })),
    activeId: activeRoute,
    storageKey: HEALTH_STORAGE_KEY,
    // page-toolbar__bar: die Bar-Zeile des Canonical Page Head (layout.css,
    // Werkzeugzeilen-Regel) - volle Kopfbreite statt Restbreite neben dem
    // Titel; mobil waren sonst nur 3 von 6 Tabs sichtbar.
    extraClass: 'health-tabs-bar page-toolbar__bar',
    ariaLabel: t('nav.health'),
    insertPosition: 'beforeend',
    onChange: (route) => window.yuvomi?.navigate(route),
  });
}
