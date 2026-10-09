/**
 * Modul: Was ein Wandtablett darf (#1208) - die reinen Listen.
 * Zweck: Die Scope-Liste eines gekoppelten Displays und die Geruestpfade, die es
 *        zusaetzlich lesen darf.
 * Abhaengigkeiten: KEINE. Absichtlich.
 *
 * WARUM DIESE DATEI NEBEN services/display-accounts.js STEHT. Dort liegt alles,
 * was die Datenbank braucht - Kopplungscodes, Credentials, Widerruf. Hier liegt
 * nur, was ein Display DARF, und das ist eine Tatsache ueber das Produkt, keine
 * ueber eine Zeile in einer Tabelle.
 *
 * Der Unterschied ist teuer bezahlt: `server/permissions.js` bekam die Regel
 * zuerst per Import aus dem Dienst, und der zieht `server/db.js` mit. Damit
 * oeffnete jede Suite, die nur Rechte aufloeste, eine echte `yuvomi.db` im Repo
 * - `test:db-isolation` meldete vier davon namentlich. `server/scopes.js` traegt
 * denselben Hinweis aus demselben Grund im Kopf.
 */

/**
 * Was ein gekoppeltes Geraet erreichen darf.
 *
 * SIE IST NICHT KONFIGURIERBAR, UND DAS IST DER PUNKT. Ein Display haengt
 * oeffentlich in der Kueche; wer daran vorbeigeht, hat es bedient. Eine
 * Scope-Liste, die ein Administrator aufbohren kann, waere genau die Einladung,
 * die dieses Konto vermeiden soll. Wer mehr braucht, meldet sich als Mensch an.
 *
 * SIE BLEIBT AUCH MIT #1209 EINE LESELISTE - DIE VORPLANUNG SAGTE ETWAS
 * ANDERES, UND SIE WAR FALSCH. Hier stand, die beiden Aktionen kaemen „mit
 * ihren eigenen Schreib-Scopes", `tasks:write` ersetze also spaeter einen
 * Eintrag. Ein Scope ist aber die Erlaubnis fuer ein GANZES Modul: `tasks:write`
 * heisst anlegen, aendern, loeschen, Kategorien umbauen - 14 weitere
 * Schreibrouten neben der einen, die #1209 will. Die Absage im Ticket („no
 * creating, editing or deleting") waere dann nicht mehr die Regel, sondern
 * etwas, das jede einzelne Route selbst nachtragen muesste: eine Denylist, bei
 * der jede kuenftig hinzukommende Route erst einmal JA sagt.
 *
 * Deshalb tragen die zwei Handlungen eine exakte Route-Allowlist
 * (`DISPLAY_WRITE_ROUTES`) statt eines Scopes - dieselbe Bauart wie
 * `DISPLAY_READ_PATHS` darunter, aus demselben Grund. Was dort fehlt, faellt
 * weg, und das ist die richtige Richtung fuer einen Irrtum.
 */
export const DISPLAY_SCOPES = Object.freeze([
  'dashboard:read',
  'calendar:read',
  'tasks:read',
  'rewards:read',
  // Wetter kam am 16.09.2026 dazu, bewusst und ueber die vier des Tickets
  // hinaus (Entscheidung Ulas): ein Kuechentablett ohne Wetter ist der eine
  // Fall, fuer den solche Geraete ueberhaupt aufgehaengt werden, und die Route
  // liefert keine Haushaltsdaten - eine Ortsvorhersage zu einer Einstellung,
  // die ohnehin haushaltweit gilt. Ohne sie fragte die Uebersicht bei jedem
  // Laden und bekam 403 (im Browser gemessen).
  'weather:read',
]);

/**
 * Die beiden Schreibrouten, die ein gekoppeltes Display erreichen darf (#1209).
 *
 * WAS DAS DISPLAY DAMIT TUN KANN, und nichts sonst: eine Aufgabe fuer eine am
 * Geraet gewaehlte Person abhaken, und fuer sie eine Einloesung beantragen. Beide
 * Routen tragen die eigentliche Regel selbst - dass eine Person benannt sein
 * muss, dass sie ein Haushaltsmitglied ist, dass sie das Modul ueberhaupt darf
 * und dass die Aufgabe haushaltssichtbar ist. Diese Liste beantwortet nur die
 * vorgelagerte Frage, ob der Pfad ueberhaupt zu erreichen ist.
 *
 * DIE MUSTER SIND ENG, NICHT BEQUEM. `\d+` und nicht `[^/]+`: eine Kennung ist
 * eine Zahl, und was keine ist, hat an dieser Stelle nichts verloren. Kein
 * `startsWith`: `/tasks/1/status` ist gemeint, `/tasks/1/status-irgendwas` nicht
 * - derselbe Fehler, gegen den DISPLAY_READ_PATHS exakt vergleicht.
 *
 * WARUM DIE EINLOESUNG EIN POST AUF DIE SAMMELROUTE IST UND KEIN EIGENER PFAD:
 * das Beantragen ist genau diese Route, fuer jeden Menschen auch. Ein zweiter
 * Pfad nur fuer Displays waere eine zweite Stelle, an der dieselbe Buchung
 * entsteht - und die beiden liefen mit der Zeit auseinander. Das ENTSCHEIDEN
 * einer Einloesung (`PATCH /rewards/redemptions/:id`) steht bewusst nicht hier:
 * die Freigabe bleibt, wo der Haushalt sie hingelegt hat.
 */
export const DISPLAY_WRITE_ROUTES = Object.freeze([
  Object.freeze({ method: 'PATCH', pattern: /^\/tasks\/\d+\/status$/ }),
  Object.freeze({ method: 'POST', pattern: /^\/rewards\/redemptions$/ }),
]);

/** Die Module daraus, ohne Zugriffsart - fuer die Rechteaufloesung. */
export const DISPLAY_SCOPE_MODULES = Object.freeze(
  [...new Set(DISPLAY_SCOPES.map((scope) => scope.split(':')[0]))],
);

/**
 * Die BEREICHE, die ein Display zeigt (#1808): seine Lesemodule ohne die
 * Uebersicht selbst. `dashboard` ist der Ort, an dem die anderen stehen, kein
 * Bereich daneben. Der Hinweis unter Einstellungen > Wandtabletts zaehlt genau
 * diese Liste auf - er bekommt sie mit `GET /displays`, damit es keine zweite
 * Handliste im Browser gibt, die beim naechsten Scope stehen bleibt.
 */
export const DISPLAY_AREA_MODULES = Object.freeze(
  DISPLAY_SCOPES
    .filter((scope) => scope.endsWith(':read'))
    .map((scope) => scope.split(':')[0])
    .filter((key) => key !== 'dashboard'),
);

/**
 * Die Geruestpfade, die ein Display LESEN darf, zusaetzlich zu seinen Modulen.
 *
 * WARUM ES SIE BRAUCHT, gemessen im Browser: die App beantwortet beim Start
 * „wer bin ich" (`/auth/me`), „wie will dieser Haushalt es dargestellt haben"
 * (`/preferences`) und „welche Module gibt es" (`/modules`). Ohne sie faellt der
 * Auth-Guard in `public/router.js` in seinen catch und schickt das Tablett auf
 * die Anmeldeseite - also genau dorthin, wo ein Display nichts zu suchen hat.
 * Das Credential war dabei gueltig, die Kopplung hatte geklappt, und trotzdem
 * blieb die Wand leer. Kein Test haette das gefunden: jeder einzelne Endpunkt
 * verhielt sich wie vorgesehen.
 *
 * WARUM DAS KEINE AUFWEICHUNG IST. Keiner der drei liefert Haushaltsdaten: die
 * eigene Zeile, die Darstellungseinstellungen und die Modulliste. Es ist
 * dasselbe Zugestaendnis, das ein Ausgaben-Gast schon hat - dessen Gate in
 * server/index.js laesst ausdruecklich `/auth/me` und `/auth/logout` durch, aus
 * demselben Grund. Nur LESEN, und nur diese Pfade: die Liste ist exakt, nicht
 * praefixbasiert, damit `/preferences-irgendwas` nicht mitgemeint ist. Die
 * Fotos des Bildschirmschoners stehen nicht hier, sondern in
 * DISPLAY_READ_ROUTES darunter - als Muster, und nur fuer ein Display, das ein
 * Administrator dafuer eingeschaltet hat.
 *
 * `/auth/logout` steht NICHT dabei. Ein Display meldet sich nicht ab - es wird
 * widerrufen, und das ist die Handlung eines Administrators, nicht die eines
 * Vorbeigehenden an der Kuechenwand.
 */
export const DISPLAY_READ_PATHS = Object.freeze([
  '/auth/me',
  '/preferences',
  '/modules',
  // Die Personen, fuer die dieses Tablett handeln darf (#1209). Sie steht hier
  // und nicht unter einem Modul, weil `/displays` keines ist - dasselbe, was
  // schon fuer die drei darueber gilt. Die Route selbst laesst nur ein Display
  // hinein und liefert Name, Farbe, Bild und die zwei Flaggen; die
  // Kontaktdaten, die `/family/members` mitgibt, bleiben draussen.
  '/displays/people',
]);

/**
 * Die Fotos des Bildschirmschoners, die ein Display LESEN darf (#1766).
 *
 * WARUM ES SIE BRAUCHT. `components/photo-screensaver.js` laedt auf jeder Seite
 * aus `index.html`, also auch auf dem Tablett - aber `/screensaver` ist kein
 * Modul, das Scope-Gate in server/index.js lehnte beide Abrufe ab, und `start()`
 * schluckt das 403. Die Wand, fuer die der Schoner gegen Einbrennen gebaut
 * wurde (#693), war das eine Geraet, auf dem er nie lief.
 *
 * WAS EIN DISPLAY DAMIT SIEHT. Dieselben Fotos, die jedes angemeldete Geraet
 * im Haushalt zeigt, sobald es ruht - keine engere Grenze: die Liste ist eine
 * Zufallsauswahl aus dem gewaehlten Album oder, ohne Album, aus allem, was der
 * Immich-Schluessel lesen darf, und sie traegt je Foto Datum, Stadt und Land;
 * `/screensaver/photos/:id` reicht die Vorschau jeder Kennung durch, ohne das
 * Album zu pruefen. Der Immich-Schluessel verlaesst den Server auch hier
 * nicht. Verbindung und Test (`/screensaver/config`, `/screensaver/test`)
 * bleiben gesperrt.
 *
 * NUR WENN EIN ADMINISTRATOR ES FUER DIESES DISPLAY EINGESCHALTET HAT
 * (`display_accounts.show_screensaver`, Migration 238, Standard aus). Ein
 * Display aendert keine Einstellungen: die Wartezeit kennt kein "nie", und die
 * Display-Oberflaeche hat keine Einstellungen. Ohne den Schalter faenge jedes
 * gekoppelte Tablett nach fuenf Minuten an, Fotos ueber den Kalender zu legen.
 * Bei "aus" sperrt das Gate beide Routen, nicht erst die Seite.
 *
 * MUSTER STATT EXAKTER PFADE, ABER ENG - DIESELBE BAUART WIE DISPLAY_WRITE_ROUTES.
 * Das Foto traegt seine Kennung im Pfad, und die Kennung ist dieselbe UUID, die
 * die Route selbst verlangt (`SCREENSAVER_PHOTO_ID`, von routes/screensaver.js
 * importiert, damit die beiden nicht auseinanderlaufen). Was keine ist, faellt
 * schon am Gate durch. Nur GET.
 */
export const SCREENSAVER_PHOTO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DISPLAY_READ_ROUTES = Object.freeze([
  /^\/screensaver\/photos$/,
  new RegExp(`^\\/screensaver\\/photos\\/${SCREENSAVER_PHOTO_ID.source.slice(1)}`, 'i'),
]);

/**
 * Was ein Display aus `/preferences` sehen darf.
 *
 * DIE AUSNAHME OBEN TRAEGT IHRE EIGENE VERENGUNG. `/preferences` steht in
 * DISPLAY_READ_PATHS, weil die App ohne sie nicht startet - die Antwort selbst
 * ist aber die Sammelstelle des ganzen Haushalts: die genauen Koordinaten des
 * Wohnorts (`weather_lat`/`weather_lon`), die Budget-Betriebsart, die
 * Zyklus-Einstellungen des Gesundheitsmoduls, die Haushaltshilfe-Schalter und
 * die Standard-Sync-Ziele. Ein Tablett haengt oeffentlich; es soll darstellen
 * koennen, nicht Auskunft geben.
 *
 * ALLOWLIST, KEINE DENYLIST: eine Denylist sagt zu jedem kuenftigen Schluessel
 * erst einmal ja, und genau dieser Antwortrumpf waechst mit jedem neuen Modul.
 * Was hier fehlt, faellt weg - das ist die richtige Richtung fuer einen Irrtum.
 *
 * Aufgenommen ist Darstellung (Sprache, Formate, Zone, Waehrung, Name der App),
 * Anordnung (welche Module es gibt, Reihenfolge, Uebersichts-Kacheln) und das,
 * was die vier erreichbaren Seiten zum ZEICHNEN brauchen. Nicht aufgenommen ist
 * alles, was nur beim Anlegen zaehlt - ein Display legt nichts an.
 */
export const DISPLAY_PREFERENCE_KEYS = Object.freeze([
  'app_name',
  'language', 'language_effective', 'language_auto',
  'date_format', 'time_format', 'week_start', 'region', 'currency',
  'timezone', 'timezone_effective',
  'disabled_modules', 'hidden_modules', 'module_order', 'mobile_nav_order',
  'dashboard_widgets', 'dashboard_today_glance',
  'tasks_subtasks_expanded',
  'holiday_show_public', 'holiday_show_school', 'holiday_public_color', 'holiday_school_color',
]);

/** Die Antwort auf das, was ein Display sehen darf - Reihenfolge egal. */
export function pickDisplayPreferences(data) {
  const out = {};
  for (const key of DISPLAY_PREFERENCE_KEYS) {
    if (data && Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
  }
  return out;
}

/**
 * Darf ein Display diesen Pfad mit dieser Methode lesen? Exakter Vergleich gegen
 * DISPLAY_READ_PATHS, ausschliesslich GET. Die Muster aus DISPLAY_READ_ROUTES
 * gelten nur mit `{ screensaver: true }` - die Wahl des Administrators fuer
 * dieses Display, die `requireAuth` als `req.displayShowsScreensaver` ablegt.
 * Ohne Option bleibt es bei den exakten Pfaden (der Riegel im Auth-Router).
 *
 * DER PFAD IST IMMER `/api/v1`-RELATIV, und der Aufrufer schuldet das. Express
 * setzt `req.path` relativ zum MOUNT: im Gate von server/index.js (montiert auf
 * `/api/v1`) steht dort `/auth/me`, im Auth-Router (montiert auf
 * `/api/v1/auth`) dagegen nur `/me`. Der erste Anlauf uebergab beides
 * ungeprueft - im Browser gemessen: der Auth-Riegel verglich `/me` gegen
 * `/auth/me`, traf nie, und wies die eigene Ausnahme ab. Wer hier einen
 * anders verankerten Pfad hereingibt, bekommt `false`, also die geschlossene
 * Antwort - das ist die richtige Richtung fuer einen Fehler dieser Art.
 */
export function displayMayRead(method, path, { screensaver = false } = {}) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  const p = String(path || '');
  if (DISPLAY_READ_PATHS.includes(p)) return true;
  return screensaver === true && DISPLAY_READ_ROUTES.some((pattern) => pattern.test(p));
}

/**
 * Darf ein Display diesen Pfad mit dieser Methode SCHREIBEN? (#1209)
 *
 * Derselbe Vertrag wie bei `displayMayRead`: der Pfad ist `/api/v1`-relativ,
 * und der Aufrufer schuldet das. Wer einen anders verankerten Pfad hereingibt,
 * bekommt `false`.
 */
export function displayMayWrite(method, path) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '');
  return DISPLAY_WRITE_ROUTES.some((route) => route.method === m && route.pattern.test(p));
}

/**
 * Die EINE Frage, die beide Gates in server/index.js stellen: darf dieses
 * Display hier durch?
 *
 * WARUM SIE ZUSAMMENGEFASST IST. Ein Display passiert zwei Riegel
 * hintereinander - das Scope-Gate und das Modulrechte-Gate -, und beide muessen
 * dieselbe Ausnahme kennen. Zweimal dieselbe Bedingung hingeschrieben heisst
 * zweimal pflegen, und der zweite Ort ist der, den man beim naechsten Mal
 * vergisst. Der Riegel im Auth-Router (`server/auth.js`) fragt weiterhin nur
 * `displayMayRead`: dort geht es um die Konto-Routen, an denen ein Display
 * nichts zu schreiben hat.
 */
export function displayMayAct(method, path, options = {}) {
  return displayMayRead(method, path, options) || displayMayWrite(method, path);
}
