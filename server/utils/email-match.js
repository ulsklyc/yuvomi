/**
 * Modul: E-Mail-Abgleich
 * Zweck: EINE Regel dafuer, wann eine eingegebene oder vom Anbieter gemeldete
 *        Adresse dieselbe ist wie eine gespeicherte. Drei Stellen fragen das:
 *        die SSO-Verknuepfung, die Pruefung vor einem Konto ohne Passwort
 *        (sie muss genau das vorhersagen, woran die Verknuepfung scheitert)
 *        und "Passwort vergessen".
 *
 * Normalisiert wird in JS, auf beiden Seiten mit derselben Funktion. SQLites
 * `trim()` entfernt nur Leerzeichen - ein Tab, ein CR oder ein geschuetztes
 * Leerzeichen (NBSP) aus einem Import blieben stehen, und `lower()` kennt nur
 * ASCII. Zwei Regeln, eine je Seite, wuerden sich genau dort widersprechen.
 */

/**
 * Vergleichsschluessel einer Adresse: Leerraum an beiden Enden weg (`\s` deckt
 * Tab, CR, LF und NBSP ab), dann klein geschrieben. Leer ergibt ''.
 * @param {unknown} value
 * @returns {string}
 */
export function emailMatchKey(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/^\s+|\s+$/g, '').toLowerCase();
}

/**
 * Konten, deren Kontakt diese Adresse fuehrt. Gezaehlt werden nur Kontakte,
 * die wirklich auf ein bestehendes Konto zeigen (JOIN auf `users`).
 *
 * @param {object} database
 * @param {unknown} address
 * @param {object} [opts]
 * @param {boolean} [opts.secondary=false] - auch `contact_emails.value` pruefen
 * @param {boolean} [opts.unlinkedOnly=false] - nur Konten ohne `oidc_sub`
 * @param {number|null} [opts.excludeUserId=null] - dieses Konto auslassen
 * @returns {number[]} eindeutige Konto-IDs
 */
export function accountIdsByEmail(database, address, {
  secondary = false,
  unlinkedOnly = false,
  excludeUserId = null,
} = {}) {
  const key = emailMatchKey(address);
  if (!key) return [];
  const rows = database.prepare(`
    SELECT u.id AS id, c.email AS email${secondary ? ', ce.value AS alt' : ''}
    FROM users u
    JOIN contacts c ON c.family_user_id = u.id
    ${secondary ? 'LEFT JOIN contact_emails ce ON ce.contact_id = c.id' : ''}
    ${unlinkedOnly ? 'WHERE u.oidc_sub IS NULL' : ''}
  `).all();
  const ids = new Set();
  for (const row of rows) {
    if (excludeUserId !== null && excludeUserId !== undefined && row.id === excludeUserId) continue;
    if (emailMatchKey(row.email) === key || (secondary && emailMatchKey(row.alt) === key)) {
      ids.add(row.id);
    }
  }
  return [...ids];
}
