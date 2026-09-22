/**
 * Modul: Lebensdauer einer Sitzung (#1356, entschieden in D#1242)
 * Zweck: EINE Zahl fuer alles, was an einer angemeldeten Sitzung ablaeuft -
 *        das Session-Cookie, sein Eintrag im Session-Store und das CSRF-Cookie.
 * Abhaengigkeiten: keine.
 *
 * GLEITEND, NICHT FEST. Die Sitzung endet nach 90 Tagen OHNE BENUTZUNG, nicht
 * 90 Tage nach der Anmeldung. Vorher stand hier eine feste Woche, und sie lief
 * in die falsche Richtung: der Store verlaengerte sich bei jedem Request, das
 * Cookie im Browser nie. Eine gestohlene Session-ID, die einmal pro Woche
 * benutzt wurde, lief also nie ab, waehrend der rechtmaessige Browser am
 * siebten Tag abgemeldet wurde.
 *
 * WARUM 90 TAGE. Yuvomi ist fuer den ganzen Haushalt, auch fuer die, die es
 * einmal im Monat oeffnen; die sollen sich nicht bei jedem Besuch anmelden. Der
 * Preis: ein gestohlenes, unbenutztes Cookie gilt laenger. Das Gegenstueck, das
 * ihn bezahlt, ist "auf anderen Geraeten abmelden" (#1354).
 *
 * EINE KONSTANTE, KEINE UMGEBUNGSVARIABLE, KEIN "ANGEMELDET BLEIBEN". Die
 * Woche stand vorher sieben Mal ausgeschrieben, das CSRF-Cookie eingeschlossen.
 * Laeuft das CSRF-Cookie vor der Sitzung ab, scheitert der erste Schreibzugriff
 * danach mit einem 403, das wie ein fehlendes Recht aussieht.
 */
export const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Wie selten das Session-Cookie neu datiert wird - dieselbe Drossel wie beim
 * Wandtablett (`DISPLAY_COOKIE_REFRESH_AFTER_MS`, services/display-accounts.js).
 *
 * NICHT `rolling: true`. Die Session-Middleware haengt in server/index.js VOR
 * den statischen Dateien; `rolling` schriebe die Session-ID also in den
 * `Set-Cookie`-Kopf jeder Asset-Antwort, auch der oeffentlich cachebaren. Ein
 * Proxy mit `proxy_ignore_headers Set-Cookie` legte sie dann fuer den naechsten
 * Abholer in den Cache. Deshalb frischt nur `requireAuth` auf, und das hoechstens
 * alle zwoelf Stunden: das Cookie steht in rund zwei Antworten am Tag statt in
 * jeder, und die 90-Tage-Zusage verschiebt sich dadurch um hoechstens einen
 * halben Tag.
 */
export const SESSION_COOKIE_REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * Ist die Auffrischung faellig? Gemessen am Ablauf, den der Browser zuletzt
 * bekommen hat: sind davon weniger als 90 Tage minus zwoelf Stunden uebrig,
 * liegt die letzte Ausstellung mindestens zwoelf Stunden zurueck. Ohne Ablauf
 * ist sie sofort faellig; eine Sitzung von vor #1356 (alte Woche) ebenso - so
 * rueckt jede bestehende Sitzung beim ersten Request auf die 90 Tage vor.
 * @param {number|null} expiresAt Ablauf des zuletzt ausgestellten Cookies, ms seit Epoch
 * @param {number} now Millisekunden seit Epoch
 */
export function sessionCookieRefreshDue(expiresAt, now) {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return true;
  return expiresAt - now <= SESSION_MAX_AGE_MS - SESSION_COOKIE_REFRESH_AFTER_MS;
}
