/**
 * Modul: Das Profilbild einer Person als Adresse
 * Zweck: Die eine Stelle fuer `/api/v1/people/:id/avatar`: der SQL-Ausdruck,
 *        den Listen statt der Data-URL ausgeben, das Pfadmuster fuer die Gates
 *        in server/index.js und das Zerlegen der gespeicherten Data-URL.
 * Abhaengigkeiten: keine
 *
 * WARUM EINE ADRESSE STATT DES BILDES. `users.avatar_data` ist eine Data-URL
 * bis 768 KB (normalizeAvatarData in server/auth.js). In jeder Zeile einer
 * Liste haengend kam dasselbe Bild so oft mit, wie die Person zustaendig ist -
 * gemessen am 18.10.2026: 200 Aufgaben bei fuenf Bildern zu je rund 40 KB
 * machten `GET /tasks` 17 MB gross (430 Data-URLs), und gzip entdoppelt in
 * seinem 32-KB-Fenster kein 40-KB-Bild. Die Adresse ist rund 40 Zeichen lang;
 * das Bild laedt der Browser einmal je Person und haelt es per ETag.
 *
 * DIE FELDER BLEIBEN, NUR IHR WERT WECHSELT. Die Oberflaeche setzt jeden dieser
 * Werte als `<img src>`, und dort funktioniert eine Adresse wie eine Data-URL.
 *
 * WAS DABEI BLEIBT: Mitgliederlisten (`/family/members`, `users` in
 * `/dashboard`, die Konten in den Einstellungen) tragen jede Person EINMAL und
 * weiter die Data-URL - die Bearbeitungsmasken schicken genau diesen Wert
 * zurueck, eine Adresse kaeme als ungueltiges Bild an.
 *
 * `?v=` IST DIE LAENGE DER DATA-URL. Sie wechselt mit fast jedem neuen Bild,
 * und eine neue Adresse laedt der Browser neu, auch innerhalb derselben
 * Sitzung, in der er Bilder sonst ohne Rueckfrage wiederverwendet. Fuer den
 * seltenen Fall gleicher Laenge revalidiert das ETag (`Cache-Control:
 * no-cache`).
 */

/**
 * SQL-Ausdruck fuer die Bildadresse einer Person, `NULL` ohne Bild.
 * @param {string} alias Tabellenalias der `users`-Zeile, z. B. 'u'
 * @returns {string}
 */
export function personAvatarUrlSql(alias) {
  return `CASE WHEN ${alias}.avatar_data IS NOT NULL AND ${alias}.avatar_data <> ''
    THEN '/api/v1/people/' || ${alias}.id || '/avatar?v=' || length(${alias}.avatar_data) END`;
}

/** Der Pfad der Route, so wie die Gates in server/index.js ihn sehen (ohne /api/v1). */
export const PERSON_AVATAR_PATH = /^\/people\/\d+\/avatar\/?$/i;

/** Darf diese Anfrage das Bild lesen, ohne ein Modulrecht zu brauchen? Nur GET. */
export function isPersonAvatarRead(method, path) {
  return String(method || '').toUpperCase() === 'GET' && PERSON_AVATAR_PATH.test(String(path || ''));
}

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/i;

/**
 * Zerlegt eine gespeicherte Data-URL in Typ und Bytes.
 * @param {string|null|undefined} value
 * @returns {{ mime: string, bytes: Buffer }|null}
 */
export function parseAvatarDataUrl(value) {
  const match = DATA_URL_RE.exec(String(value ?? ''));
  if (!match) return null;
  return { mime: match[1].toLowerCase(), bytes: Buffer.from(match[2], 'base64') };
}
