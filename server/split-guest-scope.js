/**
 * Modul: Reichweite eines Ausgaben-Gasts (GHSA-q7gc-2cc9-w8fj)
 * Zweck: Die EINE Liste dessen, was ein Konto aus `split_expense_guest_users`
 *        unter `/api/v1` erreicht. Zwei Riegel fragen sie: das Gast-Gate in
 *        server/index.js und das Eingangs-Gate des Auth-Routers in
 *        server/auth.js.
 *
 * WARUM ZWEI RIEGEL UND EINE LISTE. Der Auth-Router ist VOR `requireAuth` und
 * vor dem Gast-Gate gemountet, damit Anmeldung, Einrichtung und OIDC ohne
 * Sitzung erreichbar sind. Jede `/auth`-Anfrage wird darin beantwortet und
 * kommt beim Gast-Gate nie an - dessen Eintraege fuer `/auth/me` und
 * `/auth/logout` waren deshalb toter Code, und ein Gast las ueber
 * `GET /auth/users` die ganze Kontoliste des Haushalts. Dieselbe Luecke, die
 * GHSA-xcv5-6w6x-x5q2 fuer gescopte Tokens und #1208 fuer Displays am
 * Router-Eingang geschlossen haben, hier fuer die dritte eingeschraenkte Art
 * von Konto. Stuende die Liste an beiden Stellen, waeren es zwei Wahrheiten
 * darueber, was ein Gast darf, und die zweite ist die, die man vergisst.
 *
 * EINE ALLOWLIST, KEINE SPERRLISTE: eine neue Konto-Route ist fuer einen Gast
 * zu, bis jemand sie hier eintraegt. Ein Fehler in dieser Liste kostet einen
 * Gast eine Funktion, nicht den Haushalt seine Daten.
 *
 * DER PFAD IST `/api/v1`-RELATIV, wie bei `displayMayRead`
 * (server/display-scopes.js). Im Gast-Gate (montiert auf `/api/v1`) steht in
 * `req.path` `/auth/me`, im Auth-Router (montiert auf `/api/v1/auth`) nur
 * `/me` - der Auth-Router reicht deshalb `/auth${req.path}` herein. Ein anders
 * verankerter Pfad trifft nichts und bekommt die geschlossene Antwort.
 * Verglichen wird exakt und mit Methode: Express nimmt `/Users` und `/users/`
 * als `/users`, diese Liste nicht - auch das faellt auf die geschlossene Seite.
 */

/**
 * Konto-Routen, die ein Gast mit Sitzung braucht. Mehr ruft der Gast-Client
 * nicht: die schmale Navigation (public/router.js, `navItems`) fuehrt nur zu
 * den geteilten Ausgaben, Einstellungen erreicht er nicht.
 *
 *   - `GET /auth/me` startet die App: der Auth-Guard in public/router.js fragt
 *     sie als erstes. Sie liefert die EIGENE Zeile, die Namensliste des
 *     Haushalts ist fuer einen Gast leer (`initialsRoster`).
 *   - `POST /auth/logout` beendet die eigene Sitzung.
 *   - `POST /auth/changelog-seen` schreibt die eigenen Changelog-Merker. Den
 *     Changelog selbst bekommt jedes angemeldete Konto (server/index.js,
 *     `/api/v1/changelog` vor dem Gast-Gate), und das Konto-Menue bietet ihn
 *     auch dem Gast an; ohne den Merker stuende der Punkt nach jedem Lesen
 *     wieder da.
 *
 * Bewusst NICHT darin: die Kontoliste und jede Verwaltung fremder Konten,
 * Tokens, Einladungen, Geraete, OIDC-Verknuepfung, Profil (E-Mail und Telefon
 * eines Gasts sind Sache des Gruppenverwalters, routes/split-expenses.js) und
 * die Selbstbedienung an Passwort, Sitzungen und zweitem Faktor - fuer keine
 * davon gibt es im Gast-Client eine Oberflaeche. Das Passwort eines Gasts
 * setzt der Verwalter seiner Gruppe neu.
 */
const SPLIT_GUEST_SESSION_ROUTES = [
  ['GET', '/auth/me'],
  ['POST', '/auth/logout'],
  ['POST', '/auth/changelog-seen'],
];

/**
 * Die oeffentlichen Routen des Auth-Routers - die, die ohne Sitzung gehen.
 * Sie stehen hier, weil das Gate am Router-Eingang die Sitzung schon sieht:
 * wer im Browser noch als Gast angemeldet ist, soll sich trotzdem als jemand
 * anderes anmelden, ein Passwort zuruecksetzen oder eine Einladung annehmen
 * koennen. Keine davon liest die Identitaet der Sitzung; was sie tun, tun sie
 * fuer einen Gast genauso wie ohne Anmeldung. Die OIDC-Verknuepfung, die den
 * Rueckweg `/oidc/callback` an ein Konto bindet, beginnt mit
 * `POST /oidc/link/start` - und die steht nicht hier.
 */
const AUTH_PUBLIC_ROUTES = [
  ['POST', '/auth/login'],
  ['POST', '/auth/2fa/verify'],
  ['POST', '/auth/setup'],
  ['GET', '/auth/oidc/config'],
  ['GET', '/auth/oidc/start'],
  ['GET', '/auth/oidc/callback'],
  ['POST', '/auth/forgot-password'],
  ['POST', '/auth/reset-password/check'],
  ['POST', '/auth/reset-password'],
  ['GET', '/auth/invites/preview'],
  ['POST', '/auth/invites/accept'],
  ['POST', '/auth/devices/pair/redeem'],
];

export const SPLIT_GUEST_AUTH_ROUTES = Object.freeze(
  [...SPLIT_GUEST_SESSION_ROUTES, ...AUTH_PUBLIC_ROUTES].map((route) => Object.freeze(route)),
);

/**
 * Darf ein Ausgaben-Gast diesen Pfad mit dieser Methode erreichen?
 *
 * Die geteilten Ausgaben ganz, mit jeder Methode - welche Gruppe er darin
 * sieht, entscheidet routes/split-expenses.js. Von `/auth` nur die Liste oben.
 * `/version` und `/changelog` stehen nicht hier: server/index.js beantwortet
 * sie fuer jedes Konto VOR dem Gast-Gate, ein Eintrag waere toter Code.
 *
 * @param {string} method HTTP-Methode
 * @param {string} path   `/api/v1`-relativer Pfad
 * @returns {boolean}
 */
export function splitGuestMayReach(method, path) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '');
  if (p === '/split-expenses' || p.startsWith('/split-expenses/')) return true;
  return SPLIT_GUEST_AUTH_ROUTES.some(([allowed, route]) => allowed === m && route === p);
}

/**
 * Ist dieses Konto ein Ausgaben-Gast? Ein Fehler beim Nachsehen zaehlt als ja:
 * beide Riegel weisen dann ab, statt einen moeglichen Gast durchzulassen.
 *
 * @param {object} database better-sqlite3-Handle
 * @param {number|null|undefined} userId
 * @returns {boolean}
 */
export function isSplitGuestAccount(database, userId) {
  if (userId == null) return false;
  try {
    return Boolean(database.prepare('SELECT 1 FROM split_expense_guest_users WHERE user_id = ?').get(userId));
  } catch {
    return true;
  }
}
