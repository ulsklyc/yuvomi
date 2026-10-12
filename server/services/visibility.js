// --------------------------------------------------------
// Sichtbarkeit pro Aufgabe/Termin (#474): all | assignees | private.
//
//   all       – für alle Familienmitglieder sichtbar (Default, Altverhalten)
//   assignees – nur für Ersteller:in und zugewiesene Personen
//   private   – nur für die Ersteller:in
//
// Die Durchsetzung ist rein serverseitig (kein Admin-Bypass): jeder Lesepfad,
// der Aufgaben/Termine an eine betrachtende Person ausliefert, hängt das
// entsprechende WHERE-Fragment an. Der Kalender-Export (ICS-Feed) bleibt bewusst
// ungefiltert — Sichtbarkeit ist eine In-App-Kontrolle (#474, bestätigt).
// --------------------------------------------------------

export const VISIBILITY_VALUES = ['all', 'assignees', 'private'];

/** Normalisiert einen eingehenden Wert auf eine gültige Stufe. */
export function normalizeVisibility(value, fallback = 'all') {
  return VISIBILITY_VALUES.includes(value) ? value : fallback;
}

/**
 * WHERE-Fragment für die Sichtbarkeits-Durchsetzung.
 *
 * @param {string} alias        Tabellen-Alias der Aufgaben/Termine (z. B. 't' oder 'e')
 * @param {string} assignTable  Zuweisungs-Tabelle ('task_assignments' | 'event_assignments')
 * @param {string} assignCol    FK-Spalte darin ('task_id' | 'event_id')
 * @param {string} bind         Parameter-Platzhalter der betrachtenden User-ID.
 *                              '?' (positional, zwei Binds nötig) oder benannt wie '@me'
 *                              (dann genügt ein einzelner benannter Bind).
 * @returns {string} SQL-Fragment (ohne führendes AND)
 */
export function visibilityWhere(alias, assignTable, assignCol, bind = '?') {
  return `(
    ${alias}.visibility = 'all'
    OR ${alias}.created_by = ${bind}
    OR (${alias}.visibility = 'assignees' AND EXISTS (
          SELECT 1 FROM ${assignTable} vx
          WHERE vx.${assignCol} = ${alias}.id AND vx.user_id = ${bind}))
  )`;
}

/**
 * WHERE-Fragment fuer die ZWEITE Regel, die ein Termin traegt: ein Termin aus
 * einem ICS-Abo ist nur da, wenn das Abo geteilt ist oder der betrachtenden
 * Person gehoert. Die Zeilen-Sichtbarkeit oben deckt das nicht - ein
 * importierter Termin steht auf `all`.
 *
 * EINE STELLE, weil die Klausel an acht Stellen wortgleich stand und an den
 * Wegen fehlte, die eine Kennung aus dem Pfad nehmen (GET/PUT/DELETE
 * /calendar/:id): die Liste verbarg den Termin, die Kennung lieferte ihn. Wer
 * Termine an eine Person ausliefert oder auf ihre Kennung hin aendert, haengt
 * BEIDE Fragmente an - dieses und `visibilityWhere()`.
 *
 * @param {string} alias  Tabellen-Alias der Termine (z. B. 'e')
 * @param {string} bind   Platzhalter der betrachtenden User-ID: '?' (ein
 *                        positionaler Bind), benannt wie '@userId', oder ein
 *                        SQL-Ausdruck
 * @returns {string} SQL-Fragment (ohne fuehrendes AND)
 */
export function icsSubscriptionVisibleWhere(alias, bind = '?') {
  return `(
    ${alias}.external_source <> 'ics'
    OR ${alias}.subscription_id IN (
      SELECT id FROM ics_subscriptions WHERE shared = 1 OR created_by = ${bind}
    )
  )`;
}

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
export function householdVisibleWhere(alias) {
  return `${alias}.visibility = 'all'`;
}

/** Wie `icsSubscriptionVisibleWhere`, ohne den Zweig „oder das Abo gehoert mir". */
export function icsSubscriptionSharedWhere(alias) {
  return `(
    ${alias}.external_source <> 'ics'
    OR ${alias}.subscription_id IN (
      SELECT id FROM ics_subscriptions WHERE shared = 1
    )
  )`;
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
export function asksHouseholdAudience(query) {
  return [].concat(query?.audience ?? []).includes('household');
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
export function householdAudienceShows(key) {
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
export function householdAudienceAnswer(answer, empty) {
  const shown = { ...empty };
  for (const [key, fields] of Object.entries(HOUSEHOLD_AUDIENCE_SHOWS)) {
    if (!Object.hasOwn(answer, key)) continue;
    const value = answer[key];
    if (fields === true) { shown[key] = value; continue; }
    // Eine Scheibe, deren Abfrage scheiterte (`null`), hat keine Felder.
    if (!value || typeof value !== 'object') continue;
    const slice = { ...empty[key] };
    for (const field of fields) if (Object.hasOwn(value, field)) slice[field] = value[field];
    shown[key] = slice;
  }
  return shown;
}
