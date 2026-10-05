/**
 * Modul: E-Mail-Abgleich
 * Zweck: EINE Regel dafuer, wann eine eingegebene oder vom Anbieter gemeldete
 *        Adresse dieselbe ist wie eine gespeicherte. Das fragen die
 *        SSO-Verknuepfung, die Pruefung vor einem Konto ohne Passwort
 *        (sie muss genau das vorhersagen, woran die Verknuepfung scheitert),
 *        "Passwort vergessen" und die Pruefung, ob eine neue Adresse schon an
 *        einem anderen Konto steht (services/contact-identity.js).
 *
 * Eine Adresse, die ein Mitglied selbst setzen kann, ist kein Beweis, wem ein
 * Konto gehoert. Die SSO-Verknuepfung fragt deshalb nicht nur diese Regel,
 * sondern auch, wer die Adresse gesetzt haben kann (`ssoLinkCandidates()` in
 * server/auth.js, GHSA-6pmj-w42g-g6qv).
 *
 * Normalisiert wird in JS, auf beiden Seiten mit derselben Funktion. SQLites
 * `trim()` entfernt nur Leerzeichen - ein Tab, ein CR oder ein geschuetztes
 * Leerzeichen (NBSP) aus einem Import blieben stehen. Klein geschrieben wird
 * dagegen bewusst nur ASCII, genau wie SQLites `lower()`: `toLowerCase()`
 * faltet auch Zeichen wie das Kelvin-Zeichen U+212A zu "k" und verknuepfte
 * damit eine Adresse, die nicht die gespeicherte ist.
 */

/**
 * Vergleichsschluessel einer Adresse: Leerraum an beiden Enden weg
 * (`String#trim`: Tab, CR, LF, NBSP, U+FEFF), dann nur A-Z klein geschrieben.
 * Leer ergibt ''.
 *
 * Bewusst `trim()` und kein Regex wie `/^\s+|\s+$/`: der probiert die rechte
 * Alternative an jeder Position neu und laeuft bei langem Leerraum im INNEREN
 * quadratisch - auf "Passwort vergessen", einem Pfad ohne Anmeldung.
 * @param {unknown} value
 * @returns {string}
 */
export function emailMatchKey(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
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
 * @param {boolean} [opts.withoutSplitGuests=false] - Gaeste der geteilten
 *   Ausgaben auslassen. Ihre Adresse setzt jedes Mitglied, das eine Gruppe
 *   verwaltet, frei - sie darf weder ein Konto finden noch eines verdecken.
 * @returns {number[]} eindeutige Konto-IDs
 */
export function accountIdsByEmail(database, address, {
  secondary = false,
  unlinkedOnly = false,
  excludeUserId = null,
  withoutSplitGuests = false,
} = {}) {
  const key = emailMatchKey(address);
  if (!key) return [];
  const where = [];
  if (unlinkedOnly) where.push('u.oidc_sub IS NULL');
  if (withoutSplitGuests) {
    where.push('NOT EXISTS (SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = u.id)');
  }
  const rows = database.prepare(`
    SELECT u.id AS id, c.email AS email${secondary ? ', ce.value AS alt' : ''}
    FROM users u
    JOIN contacts c ON c.family_user_id = u.id
    ${secondary ? 'LEFT JOIN contact_emails ce ON ce.contact_id = c.id' : ''}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
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
