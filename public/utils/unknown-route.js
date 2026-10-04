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
 *     Die Ausnahme reicht so weit wie der Server (server/index.js) und nicht
 *     weiter: `/api` und `/mcp` sind ganze Unterbaeume, `/docs` gibt es nur
 *     genau so, und alles andere (Feeds, Shell, Statisches) ist eine DATEI -
 *     ein Punkt im letzten Segment, solange keine App-Route darueber steht.
 *     `/settings/missing.js` liegt unter einer Route und ist ein Tippfehler.
 *   - Der Erweiterungsraum `/m/<id>` (server/services/modules.js), solange
 *     keine aktive Modulroute darueber steht. Die Modulliste kommt erst mit der
 *     Anmeldung, ein abgeschaltetes Modul steht nicht in `allRoutes()`, und ein
 *     gescheitertes `/modules` ist keine Aussage, dass es das Modul nicht gibt.
 */

/** Erstes Pfadsegment der Unterbaeume, die `server/index.js` ganz bedient. */
const SERVER_SUBTREES = new Set(['api', 'mcp']);
/** Pfade, die der Server nur genau so bedient. */
const SERVER_PATHS = new Set(['/docs']);
/** Erstes Pfadsegment der Erweiterungsrouten. */
const EXTENSION_SEGMENT = 'm';

/** Der Pfad ohne Query und Hash. */
function barePath(path) {
  return path.split(/[?#]/)[0];
}

/**
 * @param {unknown} path - Pfad, wie `navigate()` ihn bekommt (Query/Hash erlaubt)
 * @param {{ known: Iterable<string>, landable?: Iterable<string> }} routes
 *   `known`: jede Route, die der Router kennt. `landable`: die davon als Ziel
 *   taugen (ohne abgeschaltete und gesperrte Module); fehlt es, gilt `known`.
 * @returns {{ target: string, notify: boolean } | null} null: kein Umweg
 */
export function unknownPathDetour(path, { known, landable = known } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  const clean = barePath(path);
  const knownSet = new Set(known);
  if (knownSet.has(clean)) return null;

  const segments = clean.split('/').filter(Boolean);
  if (!segments.length) return null;
  if (SERVER_SUBTREES.has(segments[0])) return null;
  const trimmed = `/${segments.join('/')}`;
  if (SERVER_PATHS.has(trimmed)) return null;

  // Nur ein Schraegstrich zu viel: dieselbe Seite, also kein Hinweis.
  if (trimmed !== clean && knownSet.has(trimmed)) return { target: trimmed, notify: false };

  const ancestors = [];
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    ancestors.push(`/${segments.slice(0, depth).join('/')}`);
  }
  // Eine Datei (`/sw.js`, `/index.html`, `/feed/calendar/x.ics`) ist keine
  // Seite - es sei denn, sie laege unter einer Route der App.
  const underAppRoute = ancestors.some((ancestor) => knownSet.has(ancestor));
  if (!underAppRoute && segments[segments.length - 1].includes('.')) return null;

  const landableSet = new Set(landable);
  const target = ancestors.find((ancestor) => landableSet.has(ancestor));
  if (target) return { target, notify: true };
  if (segments[0] === EXTENSION_SEGMENT) return null;
  return { target: '/', notify: true };
}

/**
 * Was aus dem Umweg in `navigate()` wird: der Pfad, mit dem die Navigation
 * weiterlaeuft, und die Adresse fuer die History.
 *
 * Eine ECHT unbekannte Adresse verliert Query und Hash - sie gehoerten zu einer
 * Seite, die es nicht gibt. Bei einem blossen Schraegstrich zu viel ist die
 * Seite die gemeinte, und ihre Parameter bleiben: `/settings/?view=domain`
 * waehlt eine Ansicht, `?sync_ok` traegt die Rueckmeldung eines OAuth-Rundwegs.
 *
 * Woher die Parameter kommen, haengt am Weg: Kaltstart und Zurueck/Vor reichen
 * nur `location.pathname` herein, sie stehen in der Adresszeile; bei einem
 * Wechsel innerhalb der App stehen sie im Pfad, und die Adresszeile gehoert
 * noch der Seite davor.
 *
 * @param {{ target: string, notify: boolean }} detour
 * @param {string} path - der Pfad, der zum Umweg fuehrte
 * @param {{ pushState: boolean, location: { search: string, hash: string } }} context
 * @returns {{ path: string, address: string }}
 */
export function detourPaths(detour, path, { pushState, location }) {
  if (detour.notify) return { path: detour.target, address: detour.target };
  const suffix = path.slice(barePath(path).length);
  const query = suffix.split('#')[0];
  return {
    path: `${detour.target}${query}`,
    address: pushState ? `${detour.target}${suffix}` : `${detour.target}${location.search}${location.hash}`,
  };
}
