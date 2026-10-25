/**
 * Modul: Leerer Rumpf statt `undefined` (#2209)
 * Zweck: Express 5 laesst `req.body` undefined, wenn eine Anfrage keinen Rumpf
 *        traegt oder keiner der Body-Parser ihren Content-Type liest (Express 4
 *        setzte `{}`). Die meisten Schreibrouten destrukturieren `req.body`
 *        direkt, und ein POST/PUT/PATCH ohne Rumpf endete als TypeError und 500
 *        statt mit der Validierungsantwort der Route. Diese Middleware haengt in
 *        server/index.js direkt hinter den Body-Parsern und setzt dort EINMAL
 *        `{}` - statt eines Guards je Route.
 *
 * Wer "kein Rumpf" von "leerer Rumpf" unterscheiden muss, fragt `hadNoBody()`:
 * der MCP-Endpunkt (ohne Rumpf ein JSON-RPC-Parse-Error, keine leere Methode)
 * und der Fingerabdruck der Idempotenz-Middleware (ein Schluessel, der vor dem
 * Fix ohne Rumpf gespeichert wurde, behaelt denselben Hash). Die Markierung
 * sitzt in einer WeakSet, nicht als Feld am Request: sie haengt an keinem
 * Objekt, das eine Route weiterreicht oder serialisiert.
 *
 * Multipart-Routen (multer) setzen `req.body` selbst neu; das `{}` von hier
 * stoert sie nicht.
 */

const bodiless = new WeakSet();

/** Express-Middleware: `req.body ??= {}` und merkt sich, dass keiner kam. */
export function defaultEmptyBody(req, _res, next) {
  if (req.body === undefined || req.body === null) {
    bodiless.add(req);
    req.body = {};
  }
  next();
}

/**
 * Kam die Anfrage ohne (gelesenen) Rumpf an?
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function hadNoBody(req) {
  return bodiless.has(req);
}
