/**
 * Modul: Schichtart-Etikett (shift-label)
 * Zweck: DIE EINE Schreibweise einer Schichtart - "Kuerzel · Name" - fuer
 *        Schichtplan, Kalender, Uebersicht und das Heute-Blatt.
 * Abhaengigkeiten: keine
 *
 * WARUM (Critique R22, a3 Klein, D5): `${short_code} · ${name}` stand an
 * fuenfzehn Stellen ausgeschrieben, und die Vorlage "24-Stunden-Schicht" mit
 * dem Kuerzel "24" las sich ueberall als "24 · 24-Stunden-Schicht", die erste
 * Schulstunde als "1 · 1. Stunde". Das Kuerzel steht nur noch da, wo es etwas
 * sagt, was der Name nicht schon sagt: beginnt der Name mit dem Kuerzel (gross
 * oder klein, gefolgt von etwas anderem als einem Buchstaben), traegt der Name
 * allein.
 *
 * Das Ergebnis ist TEXT, kein Markup - wer es in HTML setzt, schickt es durch
 * `esc()`.
 */

/**
 * Sagt das Kuerzel etwas, das der Name nicht schon sagt?
 * @param {string} code
 * @param {string} name
 * @returns {boolean}
 */
export function shortCodeAddsToName(code, name) {
  const c = String(code ?? '').trim();
  const n = String(name ?? '').trim();
  if (!c) return false;
  if (!n) return true;
  if (c.toLocaleLowerCase() === n.toLocaleLowerCase()) return false;
  if (!n.toLocaleLowerCase().startsWith(c.toLocaleLowerCase())) return true;
  // "F" vor "Frühschicht" sagt etwas (der Name beginnt nur zufaellig mit dem
  // Buchstaben), "24" vor "24-Stunden-Schicht" und "1" vor "1. Stunde" nicht:
  // dort endet das Kuerzel an einer Wortgrenze des Namens.
  const next = n.charAt(c.length);
  return /\p{L}/u.test(next);
}

/**
 * "Kuerzel · Name", oder der Name allein, wenn das Kuerzel fehlt oder ihn nur
 * wiederholt.
 * @param {{ short_code?: string|null, name?: string|null }|null|undefined} type
 * @returns {string}
 */
export function shiftTypeLabel(type) {
  if (!type) return '';
  const name = String(type.name ?? '');
  return shortCodeAddsToName(type.short_code, name) ? `${String(type.short_code).trim()} · ${name}` : name;
}
