/**
 * Module: what a shared surface (the wall) may show (phase 2, section B3; until then
 *         server/services/visibility.js)
 * Purpose: the row fragment for a reader without a viewer, the one place that
 *          recognises the wall audience, and the allowlist of the dashboard answer the
 *          wall receives.
 *
 * Dependencies: none. Erasable TS syntax only (runs through type stripping, no build).
 */

/** The query fields asksHouseholdAudience() reads (`req.query`). */
type AudienceQuery = { audience?: unknown } | null | undefined;

/**
 * WHERE-Fragmente fuer eine GETEILTE FLAECHE (die Wand, #1817).
 *
 * Die beiden Fragmente oben fragen „was darf DIESE PERSON sehen" - sie lassen
 * durch, was die Person selbst angelegt hat oder was ihr zugewiesen ist. Eine
 * Wand ist keine Person: sie haengt in der Kueche, und wer sie aus seiner
 * Sitzung oeffnet, stellt nicht seinen Bildschirm an die Wand, sondern den des
 * Haushalts. Dort gilt deshalb die engere Frage „was darf JEDER sehen", und sie
 * hat keinen Betrachter - die Fragmente nehmen keinen Bind.
 *
 * Beide sind Teilmengen ihrer Geschwister oben: was hier durchgeht, saehe jeder
 * Betrachter ohnehin. Die Fassung gibt also nie etwas frei.
 *
 * @param {string} alias Tabellen-Alias der Aufgaben/Termine
 * @returns {string} SQL-Fragment (ohne fuehrendes AND, ohne Bind)
 */
// "The two fragments above" are visibilityWhere() (rows/assignees.ts) and
// icsSubscriptionVisibleWhere() (rows/ics-subscriptions.ts); the second fragment of the
// pair is icsSubscriptionSharedWhere() there.
export function householdVisibleWhere(alias: string): string {
  return `${alias}.visibility = 'all'`;
}

/**
 * Fragt diese Anfrage die Fassung fuer eine geteilte Flaeche ab?
 *
 * DIE EINE STELLE, DIE DAS WAND-PUBLIKUM ERKENNT. `audience=household` schickt
 * die Wand an jeden Abruf, dessen Antwort davon abhaengt, wer fragt (die
 * Uebersicht, die faelligen Erinnerungen); jede Route, die ihn versteht, fragt
 * hier.
 *
 * Doppelt in der Adresse kommt der Parameter als Liste an. Ein Schalter, der
 * nur verengt, faellt dann nicht still auf die persoenliche Fassung zurueck.
 *
 * @param {object} query `req.query`
 * @returns {boolean}
 */
export function asksHouseholdAudience(query: AudienceQuery): boolean {
  return ([] as unknown[]).concat(query?.audience ?? []).includes('household');
}

/**
 * WAS DIE WAND ZEICHNET - die Allowlist der Haushaltsfassung von `GET /dashboard`.
 *
 * Die Haushaltsfassung traegt genau diese Schluessel der Antwort. Jeder andere
 * kommt in der LEEREN Fassung, die ein Konto ohne das Modulrecht bekommt - auch
 * einer, den es heute noch nicht gibt.
 *
 * WARUM EINE ALLOWLIST. Bis hierher stand an dieser Stelle die Umkehrung: drei
 * Module, die ausgelassen wurden, und alles andere ging mit. Gemessen trug die
 * Antwort fuer die Wand damit weiter angepinnte Notizen, das Budget, den Stand
 * geteilter Ausgaben, Schnellzugriffe (auch private), Countdowns und den
 * offenen Lohn der Haushaltshilfe - nichts davon zeichnet die Wand, alles davon
 * lag auf dem Geraet in der Kueche. Eine Denylist sagt zu einem Schluessel, den
 * sie nicht kennt, JA; ein neues Modul der Uebersicht waere von selbst an die
 * Wand gereist. Diese Liste sagt NEIN, bis jemand ihn hier eintraegt.
 *
 * DER MASSSTAB IST DIE FLAECHE, nicht die Harmlosigkeit: hier steht, was das
 * Programm, „Wer heute dran ist" und ihre Zeilen LESEN (public/pages/
 * dashboard.js `renderWallSurface`, public/utils/today-sheet.js). Der
 * Wochenstreifen, die Familienkarte und die Zahlen der Kacheln sind
 * Haushaltsdaten und stehen trotzdem nicht hier - die Wand zeichnet sie nicht.
 *
 * `true` laesst den Schluessel ganz durch. Eine Liste nennt die FELDER einer
 * Scheibe, die die Wand liest; die uebrigen kommen leer:
 *   housekeeping   - dass die Hilfe da ist, seit wann und wer. Der offene Lohn
 *                    (`unpaidAmount`) ist Geld, und Geld steht an keiner Wand;
 *   pantryExpiring - was HEUTE ablaeuft. Die Kachelliste der naechsten Tage
 *                    und ihre Zahlen zeichnet die Wand nicht.
 *
 * Was fehlt, weil es nur dem BETRACHTER gilt (#1900): Dosen, Fasten und
 * Naehrwerte, die eigene Schicht, wartende Freigaben - sie haben keine Stufe
 * „alle". Eine weitere Quelle hat eine eigene Route und fragt dort dieselbe
 * Stelle: die faelligen Erinnerungen (`GET /reminders/pending`).
 *
 * WER HIER ETWAS EINTRAEGT, entscheidet, dass es an einer Wand haengt, die
 * jeder im Raum liest. `test:wall-tasks` gleicht diese Liste mit den
 * Schluesseln der echten Antwort ab und wird rot, sobald die Route einen
 * liefert, ueber den niemand entschieden hat.
 */
export const HOUSEHOLD_AUDIENCE_SHOWS = Object.freeze({
  // Die Gesichter unter „Wer heute dran ist" und am Koch einer Mahlzeit.
  users: true,
  // Das Programm: Termine, Aufgaben, die Mahlzeit, der Geburtstag von heute.
  upcomingEvents: true,
  birthdays: true,
  urgentTasks: true,
  tasksDoneToday: true,
  todayMeals: true,
  // Die Titel unter jeder Person (#1817).
  wallTasks: true,
  // Die Schlusszeile „n Artikel offen" - die Zahl, nicht die Listen.
  shoppingOpenCount: true,
  wastePickups: true,
  pantryExpiring: Object.freeze(['todayItems', 'todayCount']),
  housekeeping: Object.freeze(['present', 'presentSince', 'workerName']),
});

/** Traegt die Haushaltsfassung diesen Schluessel der Antwort (ganz oder in Feldern)? */
export function householdAudienceShows(key: string): boolean {
  return Object.hasOwn(HOUSEHOLD_AUDIENCE_SHOWS, key);
}

/**
 * Die Antwort der Uebersicht fuer eine geteilte Flaeche.
 *
 * GEBAUT WIRD VON DER LEEREN FASSUNG AUS, nicht von der vollen: jeder
 * Schluessel beginnt leer, und nur was die Allowlist nennt, wird aus der
 * Antwort uebernommen. Ein Schluessel, den weder die Liste noch die leere
 * Fassung kennt, kommt deshalb gar nicht vor - es gibt keinen Zweig, durch den
 * er durchfallen koennte. Die Form bleibt: was leer ist, steht in derselben
 * Fassung da wie bei einer Modulsperre, kein Client stolpert ueber ein
 * fehlendes Feld.
 *
 * @param {object} answer die fertige Antwort der Route
 * @param {object} empty  die leere Fassung der GANZEN Antwort
 * @returns {object}
 */
export function householdAudienceAnswer(
  answer: Record<string, unknown>,
  empty: Record<string, unknown>,
): Record<string, unknown> {
  const shown = { ...empty };
  for (const [key, fields] of Object.entries(HOUSEHOLD_AUDIENCE_SHOWS)) {
    if (!Object.hasOwn(answer, key)) continue;
    const value = answer[key];
    if (fields === true) { shown[key] = value; continue; }
    // Eine Scheibe, deren Abfrage scheiterte (`null`), hat keine Felder.
    if (!value || typeof value !== 'object') continue;
    const slice = { ...empty[key] as Record<string, unknown> };
    for (const field of fields) if (Object.hasOwn(value, field)) slice[field] = (value as Record<string, unknown>)[field];
    shown[key] = slice;
  }
  return shown;
}
