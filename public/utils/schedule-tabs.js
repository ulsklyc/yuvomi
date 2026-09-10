// Schedule ist - wie Settings und Gesundheit - EIN Seitenmodul mit einer
// Wurzel (/schedule) und je einer exakten Route pro Sub-Tab (S-10). Alle
// Routen laden dasselbe Seitenmodul; die Soft-Navigation zwischen den Tabs
// laeuft ueber dessen update()-Funktion (siehe router.js' Registrierung und
// schedule.js#update()). Anders als Gesundheit (renderSubTabs, alle Panels
// gleichzeitig im DOM) authort Schedule seine Tab-Leiste weiterhin selbst
// (wireTablist) - diese Datei traegt nur die Routen-Wahrheit, keinen
// gemeinsamen Leisten-Renderer.
export const SCHEDULE_ROUTES = Object.freeze([
  '/schedule',
  '/schedule/shifts',
  '/schedule/patterns',
  '/schedule/statistics',
  '/schedule/overview',
]);

const TAB_IDS = new Set(['shifts', 'patterns', 'statistics', 'overview']);

/**
 * Tab-Id aus einem Pfad, oder null fuer die nackte Wurzel bzw. einen
 * unbekannten Pfad - beide Faelle entscheidet der Aufrufer (schedule.js:
 * S-07s Datenlage-Vorgabe fuer den allerersten Besuch, sonst der aktuell
 * aktive Tab unveraendert).
 */
export function scheduleViewFromPath(path) {
  if (typeof path !== 'string') return null;
  const tab = path.slice('/schedule'.length).replace(/^\/+/, '');
  return TAB_IDS.has(tab) ? tab : null;
}

export function scheduleRouteForView(view) {
  return `/schedule/${view}`;
}
