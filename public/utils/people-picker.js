/**
 * Modul: Personen-Auswahl
 * Zweck: Welche Personen eine Auswahl anbietet (#1207).
 *
 * Eine Auswahl von Personen zeigt Haushaltsmitglieder - Hauspersonal und
 * Geteilte-Ausgaben-Gaeste nicht (docs/DECISIONS.md, Eintrag 4). Der Server
 * liefert die Mitglieder schon so; hier wird nichts gefiltert, denn eine zweite
 * Fassung der Regel im Browser waere genau die uneinheitliche Sichtbarkeit, die
 * das eine Praedikat verhindern soll.
 *
 * WER AN DIESEM DATENSATZ SCHON STEHT, STEHT AUCH IN DER AUSWAHL. Eine Aufgabe
 * von frueher kann einer Haushaltskraft zugewiesen sein. Fehlte sie in der
 * Auswahl, bekaeme sie kein Haekchen, und das naechste Speichern nahme sie still
 * heraus - obwohl der Server einen gespeicherten Verweis ausdruecklich weiter
 * annimmt. Neu hinzufuegen laesst sie sich trotzdem nicht: angeboten wird sie nur
 * dort, wo sie schon steht.
 *
 * Reines Modul ohne Importe, damit es sich ohne Browser pruefen laesst.
 */

/**
 * Die Mitglieder in ihrer Reihenfolge, dahinter jede schon gewaehlte Person, die
 * keine ist - einmal. Die Datensaetze nennen die Farbe teils `color`
 * (`assigned_users`), die Auswahl liest `avatar_color`; beides wird angeglichen.
 *
 * @param {Array<{id: number}>} members
 * @param {Array<{id: number, display_name?: string, color?: string, avatar_color?: string}>|null|undefined} chosen
 * @returns {Array<object>}
 */
export function withChosenPeople(members, chosen) {
  const list = Array.isArray(members) ? [...members] : [];
  const seen = new Set(list.map((person) => Number(person?.id)));
  for (const person of Array.isArray(chosen) ? chosen : []) {
    const id = Number(person?.id);
    if (!Number.isInteger(id) || id < 1 || seen.has(id)) continue;
    seen.add(id);
    list.push({ ...person, id, avatar_color: person.avatar_color ?? person.color ?? null });
  }
  return list;
}
