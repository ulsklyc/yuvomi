/**
 * Modul: Dashboard
 * Zweck: Aggregierter Endpoint - liefert Daten aller Dashboard-Widgets in einem Request
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { resolveCalendarSelection } from '../services/calendar-selection.js';
import { emptyTasksOverview, tasksOverviewSlice } from '../services/tasks-slices.ts';
import { emptyShoppingOverview, shoppingOverviewSlice } from '../services/shopping-slices.ts';
import { emptyMealsOverview, mealsOverviewSlice } from '../services/meals-slices.ts';
import { emptyNotesOverview, notesOverviewSlice } from '../services/notes-slices.ts';
import { birthdaysOverviewSlice, emptyBirthdaysOverview } from '../services/birthdays-slices.ts';
import {
  budgetOverviewSlice, emptyBudgetOverview, emptySplitBalanceOverview, splitBalanceOverviewSlice,
} from '../services/budget-slices.ts';
import { emptyRewardsOverview, rewardsOverviewSlice } from '../services/rewards-slices.ts';
import { emptyHealthOverview, healthOverviewSlice } from '../services/health-slices.ts';
import { emptyHousekeepingOverview, housekeepingOverviewSlice } from '../services/housekeeping-slices.ts';
import { calendarOverviewSlice, emptyCalendarOverview, familyEventsOverviewSlice } from '../services/calendar-slices.ts';
import { countdownsOverviewSlice, emptyCountdownsOverview } from '../services/countdowns-slices.ts';
import { emptyScheduleOverview, scheduleOverviewSlice } from '../services/schedule-slices.ts';
import { emptyWasteOverview, wasteOverviewSlice } from '../services/waste-slices.ts';
import { emptyMembersOverview, membersOverviewSlice } from '../services/members-slices.ts';
import { sliceRunner } from '../services/slice-runner.ts';
import { COUNTDOWN_MODULES } from '../services/countdowns.js';
import { listQuickLinksFor } from './quick-links.js';
import {
  hiddenModulesFor,
  requestHasCapability,
  householdAudienceAnswer,
  householdAudienceShows,
  modulesOutsideHouseholdAudience,
  openDisplayWallModules,
  rowReader,
  wallMeals,
  wallPantryExpiring,
} from '../authorize/index.ts';
import { birthdaysSwitchedOff, modulesLeftOut } from '../services/household-modules.js';
import { documentViewer } from '../services/document-links.js';
import { emptyPantryExpiring, pantryExpiringSlice } from '../services/pantry-expiring.js';
import { householdTimeZone, utcToWall } from '../utils/timezone.js';
import { serializeEvents } from './calendar/helpers.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { moneyReader } from '../services/reward-money.js';
import { overviewQueryOptions } from '../services/overview-query.ts';

const log = createLogger('Dashboard');

/**
 * Die eine Fehlerisolation der Ausschnitte (Phase 2, Abschnitt D): ein Block,
 * der wirft, loggt `<name> error:` und antwortet mit seinem Fehlerwert, der Rest
 * der Antwort laeuft weiter.
 */
const runSlice = sliceRunner(log);

/**
 * WAS EIN GESPERRTES MODUL LIEFERT — und warum das hier steht und nicht in
 * fünfzehn verstreuten Zweigen.
 *
 * Diese Route filterte jede Zeile über `visibilityWhere`, also über die
 * ZEILEN-Privatsphäre (all/assignees/private). Die zweite Achse fehlte: die
 * Modulrechte pro Rolle und Mitglied (#467). Ein Kind, dem der Kalender auf
 * `none` steht, bekam über /dashboard weiterhin Termintitel, Beschreibung, Ort
 * und Anhangsnamen geliefert — die App fiel nicht auf, weil der Browser die
 * Kachel über `canSeeWidget` ausblendet, aber die Daten lagen auf der Leitung,
 * im Netzwerk-Tab und im Service-Worker-Cache. Die SPEC sagt zu #467
 * „Enforcement is server-side"; für diesen Endpoint stimmte das nicht.
 *
 * DIE PFAD-MIDDLEWARE KANN ES NICHT ÜBERNEHMEN. Der Guard in server/index.js
 * schlägt den Pfad in scopes.js nach; /dashboard ergibt den Schlüssel
 * `dashboard`, und der ist kein Permissions-Modul. Der Guard lässt die Anfrage
 * also immer durch — er kennt keinen Endpunkt, der ein Dutzend Module auf
 * einmal ausliefert. Genau deshalb muss die Route selbst aussortieren.
 *
 * ALS TABELLE UND NICHT ALS FALLUNTERSCHEIDUNG JE ZWEIG: welcher Teil der
 * Antwort zu welchem Modul gehört, ist die eigentliche Aussage dieses Fixes,
 * und sie gehört an EINE Stelle, an der sie sich lesen und prüfen lässt. Wer
 * ein Feld hinzufügt, sieht hier, dass es eine Modulzuordnung braucht.
 *
 * Der Wert ist jeweils die LEERE Fassung, nicht das fehlende Feld: die Antwort
 * behält damit ihre Form (`/api/v1` ist zugesagte Oberfläche für Drittmodule),
 * und kein Client stolpert über ein undefined, wo er eine Liste erwartet. Es
 * ist dieselbe Fassung, die auch der Fehlerpfad jedes Blocks schreibt.
 */
const DENIED_PAYLOAD = Object.freeze({
  // Geburtstage gehören zum Kalender-Modul, nicht zu einem eigenen — dieselbe
  // Zuordnung wie in PERMISSION_MODULES (navIds) und im Client (NAV_TO_MODULE).
  calendar: () => ({ ...emptyCalendarOverview(), ...emptyBirthdaysOverview() }),
  tasks: () => emptyTasksOverview(),
  meals: () => emptyMealsOverview(),
  notes: () => emptyNotesOverview(),
  shopping: () => emptyShoppingOverview(),
  // Der Monat bleibt stehen: er ist keine Budgetzahl, sondern der Zeitraum, auf
  // den die Kachel beschriftet ist — und er steht ohnehin im Kalender.
  // Geteilte Ausgaben gehoeren zum Budget-Modul (server/scopes.js fuehrt
  // `split-expenses` als zweiten Praefix von `budget`).
  budget: ({ month }) => ({ ...emptyBudgetOverview(month), ...emptySplitBalanceOverview() }),
  rewards: () => emptyRewardsOverview(),
  health: () => emptyHealthOverview(),
  housekeeping: () => emptyHousekeepingOverview(),
  // Die zwei Felder des Heute-Blatts (Critique 23.09.2026, P1). Eigene Namen
  // statt `waste`/`schedule`: unter diesen Namen legt der Browser die Slices
  // der Kacheln ab (`ensureWasteSlice`, `ensureScheduleSlice`), und ein
  // gleichnamiges Feld hier liesse sie nie mehr laden.
  waste: () => emptyWasteOverview(),
  schedule: () => emptyScheduleOverview(),
  // Vorrat „läuft bald ab": Chargennamen sind Haushaltsdaten des Moduls pantry.
  pantry: () => ({ pantryExpiring: emptyPantryExpiring() }),
});

/**
 * Die leere Fassung der GANZEN Antwort: jedes Modul aus `DENIED_PAYLOAD`, dazu
 * die Schluessel, die keinem Modul gehoeren. Von ihr aus baut die
 * Haushaltsfassung (`householdAudienceAnswer`) - was die Wand nicht zeichnet,
 * bleibt in genau dieser Form stehen.
 *
 * `shoppingTile` fehlt hier, und das ist seine leere Fassung: das Feld gibt es
 * nur bei einer Listen-Auswahl, und ein Konto ohne den Einkauf bekommt es nie.
 */
function emptyAnswer(context) {
  const empty = { ...emptyMembersOverview(), ...emptyCountdownsOverview(), quicklinks: [] };
  for (const build of Object.values(DENIED_PAYLOAD)) Object.assign(empty, build(context));
  return empty;
}

// Re-exported for the callers that import it from this route (test:dashboard-shopping-selection).
export { normalizeShoppingListFilter } from '../services/overview-query.ts';

const router = express.Router();

/**
 * GET /api/v1/dashboard
 * Liefert aggregierte Daten für alle Dashboard-Widgets.
 * Jedes Widget-Objekt hat ein eigenes `error`-Feld falls die Abfrage fehlschlägt -
 * so bricht ein fehlerhaftes Widget nicht das gesamte Dashboard.
 *
 * Response: {
 *   upcomingEvents: CalendarEvent[],   // Nächste 5 Termine (`events_limit`: 8 oder 12)
 *   familyEvents:   CalendarEvent[],   // Termine je Mitglied fuer die Familienkarte (#1449)
 *   weekEvents:     WeekEvent[],       // Termine, die die Woche ab heute berühren (schlank)
 *   urgentTasks:    Task[],            // Max. 5 offene, sichtbare, begonnene Aufgaben jeder Prioritaet: Ueberfaellige zuerst, dann nach Faelligkeit (ohne Datum zuletzt), dann Prioritaet (tasksOverviewSlice)
 *   todayMeals:     Meal[],            // Mahlzeiten für heute
 *   pinnedNotes:    Note[],            // Angepinnte Notizen (max. 3)
 *   users:          User[],            // Alle User (für Avatar-Farben)
 *   memberTodayTasks: {user_id, open_count}[], // Heute fällige/überfällige offene Aufgaben je Mitglied
 *   tasksDoneToday: number,            // Heute fällige, bereits erledigte Aufgaben
 *   wallTasks:      {user_id, open_count, done_count, open: {id,title,due_date}[], done: {id,title}[]}[], // Haushaltssichtbare Aufgaben von heute je Mitglied (#1817)
 *   countdowns:     Countdown[]        // Markierte Termine + Aufgaben, bald ablaufende Dokumente (#647, #1705)
 *   quicklinks:      QuickLink[]        // Haushaltslinks der Kachelreihe (#469)
 * }
 */
router.get('/', (req, res) => {
  try {
  const d = db.get();
  const result = {};
  const userId = req.authUserId || req.session.userId;

  // The widget options of the query (services/overview-query.ts): read once, as a
  // pure function; the reasons for each one stand there with its code.
  const options = overviewQueryOptions(req.query, { userId, display: req.authMethod === 'display' });
  const {
    taskCategories, noteCategories, householdAudience, eventsAssignedTo, includeBirthdays, eventsLimit,
  } = options;
  // A paired display reads the task and event parts under the wall rule with or
  // without the parameter (rowReader): the personal answer of a display is the wall
  // too, and audience=household is the wall for every account. Only the task and
  // event parts follow it here; the other blocks keep their own rules.
  const rowsReader = rowReader(req, { household: householdAudience });
  /* WELCHE KALENDER DIE KACHEL ZEIGT (#2062, aus D#2037). `events_calendar`
   * nennt Kalender-Schluessel (`local:N`, `cal:N`, `sub:N`, die des
   * Kalendermoduls); ohne den Parameter bleibt alles, wie es war.
   *
   * DIE ACHSE DER ANDEREN KALENDER-OPTIONEN, nicht die der Einkaufs-Kachel:
   * „nur meine" und die Geburtstage wirken auf die Termine der ganzen
   * Uebersicht (Liste, Wochenstreifen, Heute-Blatt), und die Wand liest
   * dieselbe Einstellung aus der Vorgabe des Haushalts. Eine Kalender-Auswahl,
   * die nur die Liste traefe, liesse den Streifen derselben Kachel Termine
   * zeigen, die die Liste verschweigt. Die Familienkarte bleibt ungefiltert:
   * sie ist eine eigene Kachel und zeigt je Mitglied, was ansteht.
   *
   * GEPRUEFT WIRD GEGEN DEN KATALOG (services/calendar-selection.js), nicht nur
   * die Form: ein Kalender, den es nicht mehr gibt, faellt aus der Auswahl, und
   * bleibt keiner uebrig, gilt die Anfrage als ungefiltert - keine Auswahl
   * heisst „alle", nie eine leere Kachel. Ohne Zugang zum Kalender laeuft
   * keiner der Leser, die Auswahl bleibt also folgenlos. */
  let eventCalendars = null;
  try {
    eventCalendars = resolveCalendarSelection(d, options.eventsCalendar, userId);
  } catch (err) {
    log.error('calendar selection error:', err.message);
  }

  const now = new Date();

  // Lokaler Datumsschlüssel: die Fälligkeit einer Dosis hängt am lokalen
  // Kalendertag (nicht UTC), sonst driftet die days_mask westlich von UTC um einen
  // Tag; den Wochentag leitet der Gesundheits-Ausschnitt aus diesem Schluessel ab.
  //
  // Dieser Schlüssel gilt für ALLES, was der Nutzer als Kalendertag eingegeben hat -
  // Mahlzeitendatum, Fälligkeiten, Budget-Monat. Bis 2026-08-18 zog sich die Route
  // daneben ein zweites `todayStr` aus `toISOString()`, also den UTC-Tag, und verglich
  // ihn mit lokal gespeicherten Werten. Östlich von UTC lieferte das Dashboard dadurch
  // in den frühen Morgenstunden die Mahlzeiten des VORTAGS (in CEST zwischen 00:00 und
  // 02:00), westlich davon am späten Abend die von morgen; am Monatsersten traf es
  // zusätzlich den Budget-Monat. Die CI läuft in UTC, wo beide Schlüssel gleich sind -
  // deshalb war der Fehler dort nie zu sehen (CLAUDE.md führt genau diese Falle).
  //
  // Seit #829 ist "lokal" nicht mehr die Zone des Containers, sondern die des
  // HAUSHALTS (sync_config `household_timezone`, Rueckfall `TZ`). Der Unterschied
  // zaehlt genau dann, wenn beide auseinanderfallen - und `TZ` ist auf Umbrel,
  // TrueNAS oder Unraid nichts, was ein Nutzer erreicht. Datum, Uhrzeit und
  // Wochentag kommen deshalb aus EINER Ablesung dieser einen Zone; drei getrennte
  // Ableitungen waeren drei Gelegenheiten, an einer Tagesgrenze auseinanderzulaufen.
  const householdWall = utcToWall(now.toISOString(), householdTimeZone(d));
  const todayLocalKey = householdWall?.date
    ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const currentMonth = todayLocalKey.slice(0, 7);

  // Modulrechte des Betrachters (#467, siehe DENIED_PAYLOAD oben). Gelesen aus
  // dem, was die Auth-Schicht schon aufgelöst hat: null für Admins und für
  // unbeschränkte Mitglieder. Was gesperrt ist, steht vor der ersten Abfrage
  // fest und wird gar nicht erst geholt - ein nachgelagerter Filter hätte die
  // Daten erst gelesen und dann weggeworfen.
  //
  // Dazu die Scopes eines API-Tokens: `dashboard:read` öffnet die Übersicht,
  // nicht die Module darin. Eine Kachel, deren Modul das Token nicht lesen darf,
  // kommt in derselben leeren Fassung wie bei einer Rollensperre. Die Quellen der
  // Countdowns gehoeren dazu: Dokumente haben keine eigene Kachel in dieser Antwort.
  const denied = hiddenModulesFor(req, [...Object.keys(DENIED_PAYLOAD), ...COUNTDOWN_MODULES]);
  // The wall rules of this answer (authorize/rows/household.ts) ask who it is for.
  const wallAudience = { display: req.authMethod === 'display', household: householdAudience };
  // The display wall reads its today sheet sources without module access (#1903),
  // before modulesLeftOut so the household switch still applies.
  openDisplayWallModules(denied, wallAudience);
  // UND DER HAUSHALTSSCHALTER (#1660, docs/DECISIONS.md 11). Bis dahin fragte
  // diese Stelle nur nach Rechten und Scopes: ein haushaltsweit abgeschaltetes
  // Modul lieferte seine Termine, Aufgaben, Buchungen und Medikamente weiter
  // aus, und nur der Browser liess die Kachel weg. Abschalten ist keine Sperre -
  // die eigenen Routen des Moduls bleiben offen -, aber was der Server
  // ungefragt in eine gemischte Antwort legt, folgt dem Schalter. Beide Achsen
  // in EINEM Set, damit jede Abfrage unten dieselbe Frage stellt; die leere
  // Fassung ist dieselbe wie bei einer Sperre, die Form der Antwort bleibt.
  const leftOut = modulesLeftOut(d, denied);
  // The third axis (#1817): a module the household audience carries no key of is
  // not read at all, in the same set.
  const emptyModules = () => Object.fromEntries(
    Object.entries(DENIED_PAYLOAD).map(([key, build]) => [key, build({ month: currentMonth })]),
  );
  for (const key of modulesOutsideHouseholdAudience(wallAudience, emptyModules)) leftOut.add(key);
  for (const key of leftOut) Object.assign(result, DENIED_PAYLOAD[key]?.({ month: currentMonth }));
  const allows = (moduleKey) => !leftOut.has(moduleKey);
  // Dasselbe fuer die Schluessel, die keinem Modul gehoeren (Countdowns,
  // Schnellzugriffe, die Auswahl der Einkaufs-Kachel).
  const wants = (key) => !householdAudience || householdAudienceShows(key);
  // GEBURTSTAGE HABEN ZWEI WEGE. Als RECHT gehoeren sie zum Kalender (siehe
  // DENIED_PAYLOAD), als SCHALTER sind sie ein eigenes Modul - dieselbe
  // Unterscheidung wie bei den Erinnerungen (reminder-origins.js). Ein
  // abgeschalteter Kalender nimmt einem Haushalt mit eingeschalteten
  // Geburtstagen die Kachel deshalb nicht weg; die leere Fassung, die der
  // Kalender-Eintrag oben eben geschrieben hat, ueberschreibt der Block unten.
  const birthdaysLeftOut = denied.has('calendar') || birthdaysSwitchedOff(d);
  if (birthdaysLeftOut) Object.assign(result, emptyBirthdaysOverview());

  // EIN TAG, EINE ZONE, EIN JETZT fuer jeden Ausschnitt der Uebersicht.
  const overviewCtx = { today: todayLocalKey, zone: householdTimeZone(d), now };

  // serializeEvents() (routes/calendar/helpers.js) an diese Anfrage gebunden:
  // Dokumentrechte des Betrachters. Bleibt in der Route - ein Dienst,
  // der eine Route importiert, ist der Schichtbruch, den die Lint-Baseline zaehlt.
  const serializeForViewer = (events) => serializeEvents(events, {
    database: d, viewer: documentViewer(req), actorId: userId,
  });

  // Die naechsten Termine der Kachel und die Woche des Streifens
  // (services/calendar-slices.ts). Jeder der beiden Bloecke faellt ueber
  // runSlice() einzeln auf seine leere Liste zurueck; die Familienkarte steht
  // weiter unten, hinter den Mitgliedern, die sie liest.
  if (allows('calendar')) {
    Object.assign(result, calendarOverviewSlice(d, rowsReader, overviewCtx, {
      userId, limit: eventsLimit, assignedTo: eventsAssignedTo, includeBirthdays,
      household: householdAudience, calendars: eventCalendars, serialize: serializeForViewer,
    }, runSlice));
  }

  // DIE AUFGABEN-BLOECKE (services/tasks-slices.ts): dringende Aufgaben, die zwei
  // Zahlen der Kachel, „heute dran" je Mitglied, die Wandtitel und „heute
  // erledigt". Ein Tag, eine Zone, ein Jetzt fuer alle; jeder Block faellt ueber
  // runSlice() einzeln auf seinen alten Fehlerwert zurueck. Die Schluessel stehen
  // an ihren alten Stellen der Antwort: drei hier, drei weiter unten.
  const tasks = allows('tasks')
    ? tasksOverviewSlice(d, rowsReader, overviewCtx, { categories: taskCategories }, runSlice)
    : null;
  if (tasks) {
    result.urgentTasks = tasks.urgentTasks;
    result.openTaskCount = tasks.openTaskCount;
    result.overdueTaskCount = tasks.overdueTaskCount;
  }

  /* WELCHE EINKAUFSLISTEN DIE KACHEL ZEIGT (#1818, aus D#1624). `shopping_list`
   * nennt eine Auswahl von Listen-Ids; ohne den Parameter bleibt alles, wie es
   * war.
   *
   * DIE AUSWAHL GILT NUR DER KACHEL, und zwar an der Quelle: sie fuellt ein
   * EIGENES Feld der Antwort (`shoppingTile`) und laesst `shoppingLists`,
   * `shoppingOpenCount` und `shoppingOpenLists` unberuehrt. Anders als bei
   * Aufgaben und Notizen, wo eine Auswahl die ganze Uebersicht meint: der
   * Einkauf spricht ausserhalb der Kachel als ZAHL ("n offen" im Heute-Blatt,
   * an der Wand, in der Navigation), und die liest dieselben Daten. Die erste
   * Fassung filterte die geteilten Felder - das Wandtablet eines Haushalts,
   * dessen Vorgabe eine Liste waehlt, zeigte "1 offen" bei vierzehn. Kein
   * Leser der ungefilterten Felder haengt jetzt von einer Kachel-Option ab,
   * und der Parameter aendert keine Zahl der Navigation.
   *
   * In der Kachel wirkt die Auswahl VOR der Deckelung und auf Liste UND Zahl:
   * eine Kachel, die eine Liste zeigt und ueber allen "23" zaehlt,
   * widerspraeche sich.
   *
   * GEPRUEFT WIRD GEGEN DIE TABELLE, nicht nur die Form. Eine Liste, die es
   * nicht (mehr) gibt, faellt aus der Auswahl; bleibt KEINE uebrig, gilt die
   * Anfrage als ungefiltert - derselbe Satz wie bei den anderen Kacheln: keine
   * Auswahl heisst "alle". So macht eine geloeschte Liste in einer gespeicherten
   * Anordnung die Kachel weder leer noch kaputt, und Unsinn (`abc`, `-1`, eine
   * erfundene Id) antwortet wie gar kein Parameter. Listen-Ids sind
   * AUTOINCREMENT, eine geloeschte Id kehrt nie als andere Liste zurueck.
   *
   * RECHTE: Einkaufslisten haben keine Zeilen-Sichtbarkeit, das Modul ist ganz
   * sichtbar oder gar nicht. Die Auswahl wird deshalb NUR gelesen, wenn das
   * Modul fuer diese Person offen ist - sonst bleibt es bei der leeren Fassung
   * von oben, was immer der Parameter nennt. */
  //
  // DIE EINKAUFS-BLOECKE (services/shopping-slices.ts): die Auswahl, die offene
  // Zahl, die Listen mit Vorschau und die Kachel-Fassung. Gelesen wird alles hier
  // (nur Lesezugriffe dazwischen); die Schluessel stehen an ihren alten Stellen
  // der Antwort: die zwei Zahlen hier, Listen und Kachel weiter unten.
  const shopping = allows('shopping')
    ? shoppingOverviewSlice(d, rowsReader, overviewCtx, {
      listSelection: options.shoppingListSelection,
      withTile: wants('shoppingTile'),
    }, runSlice)
    : null;
  if (shopping) {
    result.shoppingOpenCount = shopping.shoppingOpenCount;
    result.shoppingOpenLists = shopping.shoppingOpenLists;
  }

  // Heutiges Essen (services/meals-slices.ts), gefiltert nach haushaltweiten
  // Mahlzeit-Typ-Einstellungen.
  if (allows('meals')) {
    result.todayMeals = mealsOverviewSlice(d, rowsReader, overviewCtx, {}, runSlice).todayMeals;
  }
  // The display wall gets the fields of the wall line only (#1903).
  Object.assign(result, { todayMeals: wallMeals(result.todayMeals, wallAudience) });

  // Neueste Notizen (services/notes-slices.ts): gepinnte zuerst, dann aktuellste,
  // dazu die echte Pin-Zahl und die Menge, aus der die Vorschau schoepft.
  if (allows('notes')) {
    Object.assign(result, notesOverviewSlice(d, rowsReader, overviewCtx, { categories: noteCategories }, runSlice));
  }

  // Einkaufslisten mit offenen Artikeln und die Fassung der Kachel (#1818), aus
  // dem Einkaufs-Ausschnitt oben. Scheitert die Kachel, fehlt das Feld, und die
  // Kachel zeigt alle Listen.
  if (shopping) {
    result.shoppingLists = shopping.shoppingLists;
    if (shopping.shoppingTile) result.shoppingTile = shopping.shoppingTile;
  }

  // Die Haushaltsmitglieder (services/members-slices.ts) fuer die Avatar-Farben
  // der Widgets und die Familienkarte darunter. Ein Fehler setzt `[]` und loggt
  // `users error:` wie jeder andere Block.
  Object.assign(result, membersOverviewSlice(d, rowsReader, overviewCtx, {}, runSlice));

  // Die Familienkarte (services/calendar-slices.ts, #1449): je Mitglied die
  // beendeten von heute und die naechsten kommenden, ohne „nur meine" und ohne
  // die Kalender-Auswahl der Kachel.
  if (allows('calendar')) {
    Object.assign(result, familyEventsOverviewSlice(d, rowsReader, overviewCtx, {
      userId, members: result.users, includeBirthdays, household: householdAudience, serialize: serializeForViewer,
    }, runSlice));
  }

  // Die Geburtstags-Kachel (services/birthdays-slices.ts). Ob sie gelesen wird,
  // entscheidet `birthdaysLeftOut` oben, an der Stelle, an der die leere Fassung
  // in die Antwort kommt.
  if (!birthdaysLeftOut) {
    Object.assign(result, birthdaysOverviewSlice(d, rowsReader, overviewCtx, {}, runSlice));
  }

  // Countdowns (services/countdowns-slices.ts, #647, #1705): markierte Termine
  // und Aufgaben und bald ablaufende Dokumente. Der einzige Teil der Antwort, der
  // mehreren Modulen gehoert: seine Sperre ist `denied` als Argument, keine Zeile
  // in DENIED_PAYLOAD.
  if (wants('countdowns')) {
    Object.assign(result, countdownsOverviewSlice(d, rowsReader, overviewCtx, {
      userId, hiddenModules: denied,
    }, runSlice));
  }

  // Schnellzugriffe (#469): die Kachelreihe kommt mit der Uebersichts-Antwort
  // mit, statt einen zweiten Request beim Seitenaufbau zu kosten - es ist eine
  // kurze Liste, die genau hier gebraucht wird.
  //
  // KEINE ZEILE IN DENIED_PAYLOAD, und das ist kein Vergessen: ein Schnellzugriff
  // gehoert keinem Modul (siehe PERMISSION_WIDGETS). Die Achse, die er hat, ist
  // geteilt gegen privat, und die setzt `listQuickLinksFor` ueber die anfragende
  // Person durch - eine fremde private Kachel liegt also auch dann nicht auf der
  // Leitung, wenn der Browser sie nie zeichnen wuerde.
  //
  // Kein eigener Ausschnitt: listQuickLinksFor() liegt in routes/quick-links.js,
  // und ein Dienst, der eine Route importiert, ist der Schichtbruch, den die
  // Lint-Baseline zaehlt. Hineingereicht bliebe vom Ausschnitt nur eine Huelle um
  // diesen einen Aufruf; die Route ruft ihn deshalb selbst, unter runSlice().
  if (wants('quicklinks')) {
    result.quicklinks = runSlice('quick links', () => listQuickLinksFor(userId, isAdminRequest(req)), []);
  }

  // Das Budget des Monats (services/budget-slices.ts): Einnahmen, Ausgaben,
  // Saldo, groesste Ausgabenkategorien und Sparziel. Persoenlich oder geteilt
  // entscheidet der Ausschnitt ueber authorize (resolveBudgetMode).
  if (allows('budget')) {
    Object.assign(result, budgetOverviewSlice(d, rowsReader, overviewCtx, { month: currentMonth }, runSlice));
  }

  // Geteilte Ausgaben (services/budget-slices.ts): was der Betrachter offen hat
  // (Kennzahl „Ausgleich offen"), aus derselben Funktion wie die
  // Ausgleichs-Ansicht des Moduls. Die Haushaltswaehrung liest der Ausschnitt
  // unter seinem eigenen Guard.
  if (allows('budget')) {
    Object.assign(result, splitBalanceOverviewSlice(d, rowsReader, overviewCtx, { userId }, runSlice));
  }

  // Belohnungen (services/rewards-slices.ts): Fortschritt statt Rangliste - wer
  // freigibt, sieht alle, wer sammelt, nur sich, alle anderen die Namen. Ob
  // jemand freigibt und wessen Geld-Anfragen zaehlen, weiss nur die Anfrage.
  if (allows('rewards')) {
    Object.assign(result, rewardsOverviewSlice(d, rowsReader, overviewCtx, {
      approver: isAdminRequest(req), moneyReader: moneyReader(req),
    }, runSlice));
  }

  // Gesundheit (services/health-slices.ts): heute faellige Dosen der EIGENEN
  // Medikamente mit Nachbestell-Hinweis, der Fastenstand und die Naehrwert-Bilanz
  // des Tages. Jeder der drei Bloecke faellt ueber runSlice() einzeln auf seinen
  // alten Fehlerwert zurueck.
  if (allows('health')) {
    Object.assign(result, healthOverviewSlice(d, rowsReader, overviewCtx, {}, runSlice));
  }

  // Haushaltshilfe (services/housekeeping-slices.ts): Anwesenheit, Besuche im
  // laufenden Monat, offener Zahlbetrag und letzter Besuch. Ob der Betrachter
  // Betraege sehen darf, weiss nur die Anfrage; gefragt wird im Ausschnitt.
  if (allows('housekeeping')) {
    Object.assign(result, housekeepingOverviewSlice(d, rowsReader, overviewCtx, {
      viewsAmounts: () => requestHasCapability(d, req, 'housekeeping_view_amounts'),
    }, runSlice));
  }
  // Abfuhr fuer das Heute-Blatt (services/waste-slices.ts): heute (Tonne raus)
  // und morgen (heute Abend rausstellen).
  if (allows('waste')) {
    Object.assign(result, wasteOverviewSlice(d, rowsReader, overviewCtx, {}, runSlice));
  }

  // Die EIGENE Schicht von heute (services/schedule-slices.ts) - nicht die des
  // Haushalts, die zeigt die Schichtplan-Kachel.
  if (allows('schedule')) {
    Object.assign(result, scheduleOverviewSlice(d, rowsReader, overviewCtx, { userId }, runSlice));
  }

  // Vorrat „läuft bald ab" (Critique 2026-09-23): Chargen mit abgelaufenem oder
  // bald erreichtem MHD, haushaltsweit wie der Vorrat selbst (kein
  // Eigentuemer-Gate, siehe routes/pantry.js). Der Tag ist `todayLocalKey`, also
  // derselbe Haushaltstag wie fuer Mahlzeiten und Aufgaben dieser Antwort. Ein
  // Fehler setzt `null` - die Kachel zeigt dann „erneut versuchen" statt einer
  // leeren Liste, die „nichts laeuft ab" behaupten wuerde.
  if (allows('pantry')) {
    result.pantryExpiring = runSlice('pantryExpiring', () => pantryExpiringSlice(d, todayLocalKey), null);
  }
  // The display wall gets the name of an expiring item only (#1903).
  Object.assign(result, { pantryExpiring: wallPantryExpiring(result.pantryExpiring, wallAudience) });

  // Die zweite Haelfte der Aufgaben-Bloecke, an der Stelle, die diese Schluessel
  // in der Antwort immer hatten (die Reihenfolge haelt der Golden Master fest).
  if (tasks) {
    result.memberTodayTasks = tasks.memberTodayTasks;
    result.wallTasks = tasks.wallTasks;
    result.tasksDoneToday = tasks.tasksDoneToday;
  }

  // DIE HAUSHALTSFASSUNG (#1817): von der leeren Fassung aus, nur was die Wand
  // zeichnet. Hier, hinter jeder Abfrage - ein Block, den jemand oben ergaenzt,
  // erreicht die Wand erst ueber die Allowlist.
  res.json(householdAudience ? householdAudienceAnswer(result, emptyAnswer({ month: currentMonth })) : result);
  } catch (err) {
    log.error('Critical error:', err.message);
    res.status(500).json({ error: 'Dashboard could not be loaded.', code: 500 });
  }
});

export default router;
