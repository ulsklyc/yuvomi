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
 * NUR LESEN IN DIESEM SCHRITT. Die beiden Aktionen (abhaken, Einloesung
 * anfragen) sind #1209 und kommen mit ihren eigenen Schreib-Scopes; bis dahin
 * ist ein Display ein Schaufenster. `write` schliesst `read` ein, ein spaeteres
 * `tasks:write` ersetzt hier also einen Eintrag, statt einen hinzuzufuegen.
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

/** Die Module daraus, ohne Zugriffsart - fuer die Rechteaufloesung. */
export const DISPLAY_SCOPE_MODULES = Object.freeze(
  [...new Set(DISPLAY_SCOPES.map((scope) => scope.split(':')[0]))],
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
 * demselben Grund. Nur LESEN, und nur diese drei: die Liste ist exakt, nicht
 * praefixbasiert, damit `/preferences-irgendwas` nicht mitgemeint ist.
 *
 * `/auth/logout` steht NICHT dabei. Ein Display meldet sich nicht ab - es wird
 * widerrufen, und das ist die Handlung eines Administrators, nicht die eines
 * Vorbeigehenden an der Kuechenwand.
 */
export const DISPLAY_READ_PATHS = Object.freeze([
  '/auth/me',
  '/preferences',
  '/modules',
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
 * Darf ein Display diesen Pfad mit dieser Methode lesen? Exakter Vergleich,
 * ausschliesslich GET.
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
export function displayMayRead(method, path) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  return DISPLAY_READ_PATHS.includes(String(path || ''));
}
