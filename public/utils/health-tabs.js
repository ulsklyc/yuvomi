// Gesundheit ist EIN Seitenmodul mit einer Adresse je Bereich (Muster wie
// Settings), nicht - wie die Kueche - mehrere eigenstaendige Top-Level-Module.
// Seit der Re-Critique 2026-09-27 (A6 P1-1, R10 G1) gibt es keine Tab-Leiste
// mehr: neun Tabs, mobil fuenf davon unsichtbar hinter einem Querscroll. Die
// Uebersicht ist die Startflaeche und traegt die Liste "Alle Bereiche" (Muster
// Apple Health "Durchsuchen"); jeder Bereich hat seine eigene Adresse. Mobil
// schiebt ein Bereich die Uebersicht weg (Zurueck fuehrt zu ihr), am Desktop
// stehen Uebersicht + Bereiche links und der Bereich rechts (Liste + Detail,
// utils/master-detail.js). Das Seitenmodul tauscht nur das aktive Panel aus
// (Soft-Navigation, kein Full-Reload).
//
// HEALTH_ROUTES bleibt das ERSTE `Object.freeze([` dieser Datei: der
// Push-Ziel-Guard in test-frontend-audit.js liest die Routen per Textscan aus
// genau diesem Array.
export const HEALTH_ROUTES = Object.freeze([
  '/health',
  '/health/vitals',
  '/health/cycle',
  '/health/fasting',
  '/health/meds',
  '/health/prevention',
  '/health/labs',
  '/health/activity',
  '/health/nutrition',
]);
export const HEALTH_STORAGE_KEY = 'yuvomi-health-tab';

/** Die Kennung der Uebersicht in der Bereichsliste - sie wohnt unter `/health`. */
export const HEALTH_OVERVIEW_ID = 'overview';

// Der Zyklus ist ein haushaltweiter Opt-in (Settings -> Module -> Gesundheit),
// Fasten eine Faehigkeit je Konto. Ist einer aus, entfaellt sein Bereich; die
// Route leitet auf die Uebersicht um (health.js, normalizeHealthPath).
export const HEALTH_AREAS = ({ cycleEnabled = true, fastingEnabled = false } = {}) => [
  { id: HEALTH_OVERVIEW_ID, route: '/health', labelKey: 'health.tabs.overview', icon: 'heart-pulse' },
  { id: 'vitals', route: '/health/vitals', labelKey: 'health.tabs.vitals', icon: 'activity' },
  ...(cycleEnabled ? [{ id: 'cycle', route: '/health/cycle', labelKey: 'health.tabs.cycle', icon: 'droplet' }] : []),
  ...(fastingEnabled ? [{ id: 'fasting', route: '/health/fasting', labelKey: 'health.tabs.fasting', icon: 'timer' }] : []),
  { id: 'meds', route: '/health/meds', labelKey: 'health.tabs.meds', icon: 'pill' },
  { id: 'prevention', route: '/health/prevention', labelKey: 'health.tabs.prevention', icon: 'syringe' },
  { id: 'labs', route: '/health/labs', labelKey: 'health.tabs.labs', icon: 'flask-conical' },
  { id: 'activity', route: '/health/activity', labelKey: 'health.tabs.activity', icon: 'dumbbell' },
  { id: 'nutrition', route: '/health/nutrition', labelKey: 'health.tabs.nutrition', icon: 'salad' },
];

export function isHealthRoute(path) {
  return HEALTH_ROUTES.includes(path);
}

/** Bereichskennung einer Health-Route (`/health` -> 'overview'), sonst null. */
export function healthAreaId(path) {
  if (!isHealthRoute(path)) return null;
  return path === '/health' ? HEALTH_OVERVIEW_ID : path.slice('/health/'.length);
}

/** Adresse eines Bereichs; unbekannte Kennungen und null landen auf der Uebersicht. */
export function healthAreaRoute(id) {
  if (!id || id === HEALTH_OVERVIEW_ID) return '/health';
  const route = `/health/${id}`;
  return isHealthRoute(route) ? route : '/health';
}

/**
 * Die ALTE Adresse eines Bereichs: `/health?tab=<bereich>` (Lesezeichen und
 * Links aus der Zeit vor den Pfad-Adressen). Liefert die neue Adresse samt
 * uebriger Parameter und Anker - oder null, wenn nichts umzuleiten ist. Ein
 * unbekannter Wert faellt auf die Uebersicht, der Parameter geht in jedem Fall:
 * eine Adresse, die einen Tab nennt, den es nicht gibt, soll nicht stehen
 * bleiben.
 *
 * @param {{pathname: string, search: string, hash?: string}} loc
 * @returns {string|null}
 */
export function legacyHealthTabPath(loc) {
  if (!loc || (loc.pathname !== '/health' && loc.pathname !== '/health/')) return null;
  const params = new URLSearchParams(loc.search || '');
  if (!params.has('tab')) return null;
  const raw = String(params.get('tab') || '').trim().toLowerCase().replace(/^\/?health\/?/, '');
  params.delete('tab');
  const route = healthAreaRoute(raw);
  const rest = params.toString();
  return `${route}${rest ? `?${rest}` : ''}${loc.hash || ''}`;
}

/**
 * Die Pfad-Adresse fuer den Liste-+-Detail-Baustein (`address` in
 * mountMasterDetail): die Auswahl IST der Pfad. `/health` waehlt die
 * Uebersicht - die Seite hat damit nie "keine Auswahl", und die Vorwahl des
 * Bausteins bleibt aus. Eine Adresse ausserhalb der Gesundheit gehoert nicht zu
 * dieser Seite (undefined: der Router zeichnet neu).
 */
export const healthAddress = Object.freeze({
  read: (loc) => healthAreaId(loc.pathname) ?? undefined,
  href: (id) => healthAreaRoute(id),
});

export function rememberHealthRoute(route) {
  try {
    if (typeof sessionStorage !== 'undefined' && isHealthRoute(route)) sessionStorage.setItem(HEALTH_STORAGE_KEY, route);
  } catch { /* privater Modus: kein Merker, kein Fehler */ }
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
