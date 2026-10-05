/**
 * Modul: Einhaengepunkt der Seite
 * Zweck: Wohin `renderPage()` (router.js) die naechste Seite haengt. Aus
 *        router.js herausgehalten, damit es ohne Browser pruefbar ist:
 *        test/test-page-mount.js.
 * Abhaengigkeiten: keine
 *
 * ZWEI SORTEN SEITEN, ZWEI EINHAENGEPUNKTE:
 *
 *   - Seiten mit Anmeldung stehen in der App-Shell. Ihr Platz ist deren
 *     Scrollport `#main-content`; ihn baut `renderAppShell()`, bevor die Seite
 *     rendert.
 *   - Seiten ohne Anmeldung (Login, Setup, Passwort vergessen/zuruecksetzen,
 *     Einladung, Display-Kopplung) sind vollflaechig und bringen ihr EIGENES
 *     `<main id="main-content">` mit. Ihr Platz ist die App-Wurzel.
 *
 * VORHER suchte der Router fuer beide `#main-content` und fand beim Wechsel
 * von einer Seite ohne Anmeldung zur naechsten das `main` der VORIGEN: die neue
 * Seite landete darin. Zwei verschachtelte `main` mit derselben id, und weil
 * das aeussere ein zentrierender Flex-Container ist, schrumpfte die innere
 * Seite auf ihre Inhaltsbreite - die Karte mass 338px (Login) bzw. 307px
 * (Passwort zuruecksetzen) statt 380px.
 */

/**
 * @param {{ requiresAuth?: boolean }} route
 * @param {Element} app - die App-Wurzel
 * @param {{ getElementById: (id: string) => Element|null }} [doc]
 * @returns {Element}
 */
export function pageMountTarget(route, app, doc = document) {
  if (!route.requiresAuth) return app;
  return doc.getElementById('main-content') || app;
}
