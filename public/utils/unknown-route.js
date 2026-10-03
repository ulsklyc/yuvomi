/**
 * Modul: Unbekannte Adresse
 * Zweck: Wohin ein Pfad ohne Route fuehrt (#1607), und wie die tote Adresse
 *        die History verlaesst. Aus router.js herausgehalten, damit beides ohne
 *        Browser pruefbar ist: test/test-unknown-route.js.
 * Abhaengigkeiten: keine
 *
 * VORHER fiel `/settings/xyz` in `navigate()` still auf die Uebersicht zurueck:
 * die Adresse blieb stehen, der Titel hiess "App-Name · App-Name". Jetzt fuehrt
 * der Pfad auf den naechsten bekannten Vorfahren (`/settings`, sonst `/`).
 *
 * WAS HIER NIE ALS UNBEKANNT GILT - und damit bleibt, wie es war:
 *
 *   - Pfade, die der Server beantwortet. Der Router sieht sie trotzdem: offline
 *     liefert der Service Worker fuer JEDE Navigation die Shell (`sw.js`,
 *     networkFirst), also auch fuer `/docs` oder einen Feed. Eine Umleitung
 *     ersetzte dort die Adresse, die nach dem naechsten Neuladen wieder stimmt.
 *   - Der Erweiterungsraum `/m/<id>` (server/services/modules.js), solange
 *     keine aktive Modulroute darueber steht. Die Modulliste kommt erst mit der
 *     Anmeldung, ein abgeschaltetes Modul steht nicht in `allRoutes()`, und ein
 *     gescheitertes `/modules` ist keine Aussage, dass es das Modul nicht gibt.
 */

/** Erstes Pfadsegment der Routen, die `server/index.js` selbst bedient. */
const SERVER_SEGMENTS = new Set(['api', 'docs', 'feed', 'mcp']);
/** Erstes Pfadsegment der Erweiterungsrouten. */
const EXTENSION_SEGMENT = 'm';

/**
 * @param {unknown} path - Pfad, wie `navigate()` ihn bekommt (Query/Hash erlaubt)
 * @param {{ known: Iterable<string>, landable?: Iterable<string> }} routes
 *   `known`: jede Route, die der Router kennt. `landable`: die davon als Ziel
 *   taugen (ohne abgeschaltete und gesperrte Module); fehlt es, gilt `known`.
 * @returns {{ target: string, notify: boolean } | null} null: kein Umweg
 */
export function unknownPathDetour(path, { known, landable = known } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  const clean = path.split(/[?#]/)[0];
  const knownSet = new Set(known);
  if (knownSet.has(clean)) return null;

  const segments = clean.split('/').filter(Boolean);
  if (!segments.length) return null;
  if (SERVER_SEGMENTS.has(segments[0])) return null;
  // Eine Datei (`/sw.js`, `/index.html`, `/openapi.json`) ist keine Seite.
  if (segments[segments.length - 1].includes('.')) return null;

  // Nur ein Schraegstrich zu viel: dieselbe Seite, also kein Hinweis.
  const trimmed = `/${segments.join('/')}`;
  if (trimmed !== clean && knownSet.has(trimmed)) return { target: trimmed, notify: false };

  const landableSet = new Set(landable);
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    const ancestor = `/${segments.slice(0, depth).join('/')}`;
    if (landableSet.has(ancestor)) return { target: ancestor, notify: true };
  }
  if (segments[0] === EXTENSION_SEGMENT) return null;
  return { target: '/', notify: true };
}

/**
 * Folgt dem Umweg.
 *
 * `pushState === false` heisst Kaltstart oder Zurueck/Vor: die tote Adresse IST
 * der laufende History-Eintrag und wird ersetzt - Zurueck fuehrt danach nicht
 * wieder auf sie. Bei einem Wechsel innerhalb der App steht sie noch gar nicht
 * in der History; der laufende Eintrag gehoert der Seite davor und bleibt.
 *
 * Der Hinweis kommt NACH der Seite: beim Kaltstart gibt es die Toast-Flaeche
 * erst mit der Shell.
 *
 * @param {{ target: string, notify: boolean }} detour
 * @param {{ pushState: boolean, history: History, navigate: Function, notify: Function }} deps
 */
export async function followUnknownPathDetour(detour, { pushState, history, navigate, notify }) {
  if (!pushState) history.replaceState({ path: detour.target }, '', detour.target);
  await navigate(detour.target, pushState);
  if (detour.notify) notify();
}
