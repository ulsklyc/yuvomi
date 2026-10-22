/**
 * Modul: Kalender-Metadaten einer CalDAV-Sammlung
 * Zweck: Farbe und Name, wie tsdav sie aus PROPFIND liest, in die Form bringen,
 *        die Yuvomi speichert. Geteilt von CalDAV, Apple und den
 *        Erinnerungslisten - vorher stand normalizeCalColor zweimal da.
 *        `calendarDisplayName` liest auch die Namen der CardDAV-Adressbuecher
 *        (#2160): derselbe tsdav-Pfad, dieselbe Regel.
 *
 * tsdav reicht Textknoten ungetrimmt durch (#2157): Synology schickt
 * `<calendar-color>#008E9E\n</calendar-color>` und einen `displayname` mit
 * Newline am Ende. Ohne trim fiel jede Farbe auf den Fallback, und der Name
 * trug den Umbruch bis in die Oberflaeche.
 */

/**
 * `#RRGGBB` oder `#RRGGBBAA` (Alpha wird abgeschnitten) zu `#RRGGBB`, sonst null.
 * @param {unknown} c
 * @returns {string|null}
 */
export function normalizeCalColor(c) {
  if (typeof c !== 'string') return null;
  const color = c.trim();
  if (/^#[0-9a-fA-F]{8}$/.test(color)) return color.slice(0, 7);
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  return null;
}

/**
 * Der getrimmte Anzeigename, oder `fallback`, wenn danach nichts uebrig ist.
 * @param {unknown} name
 * @param {string} fallback
 * @returns {string}
 */
export function calendarDisplayName(name, fallback) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed || fallback;
}
