/**
 * Module: the query options of GET /dashboard (phase 2, section D)
 * Purpose: reads the widget options of the overview from `req.query` as one pure
 *          function, so the input check is testable without HTTP and the reasons
 *          stand next to the code that follows them.
 *
 * Pure: no database, no clock, no logger. The calendar selection needs the catalog
 * (services/calendar-selection.js); only its raw query value leaves here, the route
 * resolves it.
 *
 * Dependencies: services/task-scope.js, services/notes-slices.ts, authorize/index.ts,
 * public/utils/dashboard-event-limit.js (shared with the tile). Erasable TS syntax only.
 */

import { normalizeCategoryFilter } from './task-scope.js';
import { normalizeNoteCategoryFilter } from './notes-slices.ts';
import { asksHouseholdAudience } from '../authorize/index.ts';
import { clampEventLimit } from '../../public/utils/dashboard-event-limit.js';

/** The query of the request (`req.query`): Express hands strings, arrays or nested objects. */
export type OverviewQuery = Record<string, unknown> | null | undefined;

/** Who asks: the user id of the request and whether it is a paired display. */
export type OverviewViewer = { readonly userId: number | null; readonly display: boolean };

/** The options of the overview, read once from the query. */
export type OverviewQueryOptions = Readonly<{
  taskCategories: string[];
  noteCategories: number[];
  householdAudience: boolean;
  eventsAssignedTo: number | null;
  includeBirthdays: boolean;
  eventsLimit: number;
  /** The raw `events_calendar` value; resolveCalendarSelection() checks it against the catalog. */
  eventsCalendar: unknown;
  shoppingListSelection: number[];
}>;

/**
 * `?shopping_list=` als Liste von Listen-Ids (#1818): einzeln oder mehrfach
 * angegeben, nur positive ganze Zahlen, ohne Doppelte, hoechstens 50 - dieselbe
 * Form und Grenze wie `notes_category` und wie die gespeicherten Optionen
 * (preferences.js). Alles andere faellt weg, nie ein Fehler.
 */
export function normalizeShoppingListFilter(raw: unknown): number[] {
  if (raw === undefined || raw === null) return [];
  return [...new Set(
    (Array.isArray(raw) ? raw : [raw])
      .filter((value): value is string => typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value))
      .map(Number),
  )].slice(0, 50);
}

/**
 * The query options of GET /dashboard, in the order the route read them.
 *
 * @param query  `req.query`
 * @param viewer the user id of the request and whether it is a paired display
 * @returns a frozen object; nothing here reads the database, the clock or logs
 */
export function overviewQueryOptions(query: OverviewQuery, viewer: OverviewViewer): OverviewQueryOptions {
  const q = query ?? {};
  /* WIDGET-OPTIONEN KOMMEN ALS QUERY-PARAMETER, NICHT AUS DEM GESPEICHERTEN
   * LAYOUT (#814). Der Server kennt die Widget-Ids bewusst nicht - sie gehören
   * dem Frontend, und ein neues Widget soll keine Backend-Änderung kosten. Er
   * speichert `options` deshalb nur als Form und versteht hier ausschliesslich
   * die zwei Achsen, die er ohnehin abfragen kann.
   *
   * SIE WIRKEN AUF DIE GANZE ÜBERSICHT, nicht auf eine Kachel. Aufgaben stehen
   * hier an vier Stellen (Liste, Kennzahl, „heute dran" je Mitglied, das
   * Kopfband) und Termine an dreien; würde eine Auswahl nur die Liste
   * einschränken, stünden zwei Zeilen unter einer Kachel, die sieben sagt -
   * derselbe Fehler wie in #647, eine Ebene höher.
   *
   * Und sie wirken VOR der Deckelung, weil jede dieser Abfragen ihr eigenes
   * LIMIT trägt.
   *
   * AUSGENOMMEN SIND DIE COUNTDOWNS (#647), und zwar bewusst: dort steht keine
   * Aufgabe, weil sie in einer Liste vorkommt, sondern weil jemand sie
   * ausdrücklich markiert hat. Eine Kategorie-Auswahl, die eine markierte
   * Aufgabe wieder verschwinden lässt, nähme eine Entscheidung zurück, die
   * jemand ausdrücklich getroffen hat. */
  const taskCategories = normalizeCategoryFilter(q.tasks_category);
  // Die Notizkategorien-Auswahl (services/notes-slices.ts): hoechstens 50 Ids,
  // Unsinn faellt weg.
  const noteCategories = normalizeNoteCategoryFilter(q.notes_category);
  /* FUER WEN DIE ANTWORT IST (#1817). `audience=household` fragt die Fassung
   * fuer eine GETEILTE FLAECHE ab - die Wand. Dort gilt nicht „was darf die
   * angemeldete Person sehen", sondern „was darf jeder sehen": Aufgaben und
   * Termine nur mit Sichtbarkeit `all`, Termine aus ICS-Abos nur aus geteilten.
   * Wer die Wand aus seiner eigenen Sitzung oeffnet, stellt damit nicht seine
   * privaten Zeilen in die Kueche.
   *
   * DURCHGESETZT WIRD ES HIER, AM LESER, nicht im Browser: was die Antwort
   * nicht traegt, liegt auch nicht im Speicher des Tabletts. Der Parameter
   * VERENGT nur - die Haushaltsfassung ist eine Teilmenge dessen, was dieselbe
   * Person ohnehin bekaeme -, er braucht deshalb kein eigenes Recht.
   *
   * UND SIE TRAEGT NUR, WAS DIE WAND ZEICHNET. Welche Schluessel das sind,
   * steht als Allowlist an einer Stelle (`HOUSEHOLD_AUDIENCE_SHOWS` in
   * authorize/rows/household.ts); alles andere kommt in der leeren Fassung einer
   * Modulsperre - Notizen, Budget, geteilte Ausgaben, Schnellzugriffe,
   * Countdowns, der offene Lohn der Haushaltshilfe, und was nur dem Betrachter
   * gilt (Dosen, die eigene Schicht, wartende Freigaben: „2 zu bestaetigen"
   * und „Eisen 20:00" standen aus der Sitzung eines Mitglieds in der Kueche).
   * Durchgesetzt wird es am Ende der Route (`householdAudienceAnswer`); ein
   * Modul, von dem die Wand nichts zeichnet, wird vorher gar nicht gelesen
   * (`leftOut` unten).
   *
   * Die normale Uebersicht derselben Sitzung fragt ohne ihn und bleibt
   * persoenlich. */
  const householdAudience = asksHouseholdAudience(q);
  // `mine` ist die Auslegung des Kalendermoduls: zugewiesen an mich.
  // EIN DISPLAY HAT KEIN "MIR" (#1808): es folgt der Vorgabe des Haushalts, sein
  // Browser schickt deren Option mit, und dem Display-Konto weist nie jemand
  // einen Termin zu (#1207) - das Tablett stuende leer da. Gelesen wird die
  // Option deshalb HIER als "alle", statt sie beim Speichern der Vorgabe zu
  // streichen: dieselbe Vorgabe gilt auch fuer Mitglieder, und dort stimmt sie.
  // DIESELBE ANTWORT GILT FUER JEDE WAND (#1817): mit `audience=household` gibt
  // es kein "mich", auch nicht aus der Sitzung eines Mitglieds.
  const eventsAssignedTo = q.events_scope === 'mine' && !viewer.display && !householdAudience
    ? viewer.userId : null;
  /* GEBURTSTAGE IM TERMIN-WIDGET (#927). Wer sie auf der Uebersicht schon als
   * eigene Kachel stehen hat, las sie zweimal - einmal bei den Geburtstagen,
   * einmal zwischen den naechsten Terminen. Abwaehlbar ist deshalb der EINE
   * Ort, an dem sie mitlaufen, statt dass die Kachel danebensteht.
   *
   * NICHT UEBERNOMMEN WIRD DER FILTER DES KALENDERMODULS, obwohl die Anfrage
   * dorthin zeigte: der Ebenen-Schalter dort liegt im localStorage und gilt
   * fuer das Geraet, die Widget-Optionen liegen in den Einstellungen und gelten
   * fuer das Konto. Ein Wert an zwei Orten mit zwei Reichweiten waere die
   * teurere Antwort - am Wandtablet haette das Abwaehlen am Telefon gewirkt
   * oder eben nicht, je nachdem, welchen der beiden man liest.
   *
   * Der Standard bleibt „mit Geburtstagen": ein Filter wirkt nur, wo jemand ihn
   * gesetzt hat. Der Parameter reist deshalb nur in seiner einen Richtung. */
  // Den Haushaltsschalter (#1660) kennt der geteilte Leser selbst: sind die
  // Geburtstage abgeschaltet, laufen sie nicht mit, was immer hier steht.
  const includeBirthdays = q.events_birthdays !== 'hide';
  // Wie viele Kommende die Kachel listet (#1680): 5, 8 oder 12 aus einer
  // Allowlist, die der Browser mit dieser Route teilt. Alles andere - fehlend,
  // leer, `7`, `500`, `abc`, doppelt angegeben - ist die Vorgabe fuenf.
  const eventsLimit = clampEventLimit(q.events_limit);
  // The calendar selection (#2062) is checked against the catalog in the route;
  // the reasons stand there, next to resolveCalendarSelection().
  const eventsCalendar = q.events_calendar;
  // The shopping tile selection (#1818); the reasons stand in the route, where
  // the shopping slice reads it.
  const shoppingListSelection = normalizeShoppingListFilter(q.shopping_list);
  return Object.freeze({
    taskCategories,
    noteCategories,
    householdAudience,
    eventsAssignedTo,
    includeBirthdays,
    eventsLimit,
    eventsCalendar,
    shoppingListSelection,
  });
}
