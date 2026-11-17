/**
 * Modul: Such-Service (FTS5)
 * Zweck: Reine Suchlogik gegen den FTS5-Index `search_index` (Migration 44).
 *        Keine Abhängigkeit auf db.js - die Datenbank wird hereingereicht, damit
 *        die Logik direkt mit node:sqlite getestet werden kann.
 *
 * Phase 2, section D: each hit type (bucket) reads in a search slice of its module
 * (`<module>SearchSlice(db, actor, query, options?)` in services/<module>-slices.ts).
 * This file keeps what all of them share - the MATCH query, the bucket -> module
 * and bucket -> nav tables, the empty answer - and the orchestration: runSearch,
 * runTableSearch and searchEverything call the slices in the old order and write
 * the old keys in the old order. The text helpers live in services/search-text.ts
 * and the event helpers in services/search-events.ts (the slices import them, so
 * they cannot live here without a cycle); this file re-exports every name it used
 * to export.
 *
 * Abhaengigkeiten: services/search-text.ts, services/search-events.ts, the search
 *        slices in services/*-slices.ts (which take their row rules from
 *        server/authorize/index.ts). None of them may reach server/db.js:
 *        suites load this file without DB_PATH (test:db-isolation), which is
 *        why the birthday hits live in calendar-slices.ts and the recipe hits
 *        in recipes-slices.ts.
 */
/** @typedef {import('../authorize/index.ts').Database} Database */
/** @typedef {{ hiddenModules?: Set<string> | null, disabledNav?: Set<string> | null }} SearchAxes */
import { foldLikeIndex, foldSearchText, queryTokens } from './search-text.ts';
import { tasksSearchSlice } from './tasks-slices.ts';
import { birthdaysSearchSlice, calendarSearchSlice } from './calendar-slices.ts';
import { notesSearchSlice } from './notes-slices.ts';
import { contactsSearchSlice } from './contacts-slices.ts';
import { shoppingSearchSlice } from './shopping-slices.ts';
import { healthActivitiesSearchSlice, healthMedsSearchSlice } from './health-slices.ts';
import { wasteSearchSlice } from './waste-slices.ts';
import { recipesSearchSlice } from './recipes-slices.ts';
import { pantrySearchSlice } from './pantry-slices.ts';
import { inventorySearchSlice } from './inventory-slices.ts';
import { documentsSearchSlice } from './documents-slices.ts';
import { budgetSearchSlice } from './budget-slices.ts';

export { SEARCH_LIMIT, foldSearchText, searchExcerpt } from './search-text.ts';
export {
  PAST_SINGLE_EVENT_SQL, eventSearchWindow, resolveEventSearchRows, upcomingEventsFirst,
} from './search-events.ts';

/**
 * Erzeugt die ß↔ss-Schreibvarianten eines Tokens. Der FTS-Tokenizer faltet
 * Akzente (unicode61 remove_diacritics 2, Migration 77), aber NICHT das Eszett —
 * „strasse" fände „Straße" sonst nicht (und umgekehrt). Beide Richtungen werden
 * als OR-Zweige gematcht: ss→ß ist mehrdeutig, die überzähligen Varianten treffen
 * aber schlicht nichts (harmlos). Menge dedupliziert; ohne ß/ss bleibt es 1 Token.
 */
function eszettVariants(token) {
  return new Set([
    token,
    token.replace(/ß/g, 'ss').replace(/ẞ/g, 'ss'),
    token.replace(/ss/gi, 'ß'),
  ]);
}

/* WORTTEILE (Re-Critique 2026-09-27, A1 P2-6): "Milch" fand die "Vollmilch"
 * nicht. FTS5 sucht Praefixe - ein Wort, das mitten im Wort steht, erreicht der
 * Index nie. Zwei Wege standen offen, beide ohne Umbau der Tabelle waere keiner:
 *   - ein Trigramm-Tokenizer: neue Tabelle, alle 24 Trigger neu (Migration),
 *     und er faltet die Akzente erst ab SQLite 3.45 - "muller" -> "Müller" (#471)
 *     haenge dann an der Version der eingebauten Bibliothek;
 *   - ein LIKE-Nachgang ueber die Zeilen: ASCII-Grossschreibung, keine Akzente,
 *     und jede Trefferart braeuchte ihn einzeln.
 * Gewaehlt ist ein dritter: das VOKABULAR des Index. `fts5vocab` listet jedes
 * Wort, das im Index steht, schon gefaltet (klein, ohne Akzente). Wer "milch"
 * sucht, bekommt alle Woerter, die "milch" ENTHALTEN, als zusaetzliche
 * ODER-Zweige der MATCH-Abfrage - Besitzerfilter, Sortierung und Deckel jeder
 * Trefferart bleiben, wie sie sind, und keine Migration ist noetig: die
 * Vokabel-Tabelle ist `temp`, lebt je Verbindung und kostet nichts auf der
 * Platte. Gemessen (27.09.2026, ganze Suche inkl. Tabellen-Trefferarten): Demo-
 * Haushalt ~1 ms; kuenstlich aufgeblaeht auf 12 000 Index-Woerter und 20 000
 * Budgetzeilen ~17 ms, davon Index samt Vokabular ~2 ms.
 *
 * GRENZEN, BEWUSST: erst ab drei Zeichen (zwei Buchstaben stecken in jedem
 * zweiten Wort), und hoechstens INFIX_TERM_CAP Woerter je Suchwort, kuerzeste
 * zuerst - sie liegen dem Suchwort am naechsten. Das Vokabular kennt auch
 * Woerter aus Zeilen, die der Betrachter nicht sehen darf; es erweitert nur die
 * Abfrage, die Zeilen laufen danach durch dieselben Filter wie vorher. */
export const INFIX_MIN_LENGTH = 3;
export const INFIX_TERM_CAP = 50;

const vocabReady = new WeakSet();

function ensureSearchVocab(database) {
  if (vocabReady.has(database)) return;
  database.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.search_vocab USING fts5vocab(main, search_index, 'row')");
  vocabReady.add(database);
}

/** `%`, `_` und der Fluchtwert selbst sind in LIKE Steuerzeichen - hier Text. */
export function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Index-Woerter, die das Suchwort (in einer seiner ß/ss-Schreibungen) enthalten. */
function infixTerms(database, token) {
  const folded = foldLikeIndex(token);
  if ([...folded].length < INFIX_MIN_LENGTH) return [];
  ensureSearchVocab(database);
  const stmt = database.prepare(`
    SELECT term FROM temp.search_vocab
    WHERE term LIKE @pattern ESCAPE '\\'
    ORDER BY length(term) ASC, term ASC
    LIMIT @cap
  `);
  const terms = new Set();
  for (const variant of eszettVariants(folded)) {
    for (const row of stmt.all({ pattern: `%${escapeLike(variant)}%`, cap: INFIX_TERM_CAP })) {
      if (terms.size >= INFIX_TERM_CAP) break;
      terms.add(row.term);
    }
  }
  return [...terms];
}

/**
 * Wandelt eine rohe Nutzereingabe in eine sichere FTS5-MATCH-Query um.
 * Jedes Token wird als Phrase in doppelte Anführungszeichen gesetzt (eingebettete
 * Anführungszeichen verdoppelt) und als Präfix (`*`) gematcht, damit Teiltreffer
 * wie bei der alten LIKE-Suche funktionieren. Tokens werden mit AND verknüpft;
 * ß↔ss-Varianten je Token mit OR. Gibt null zurück, wenn nichts Suchbares bleibt.
 *
 * Mit `database` kommen die Index-Woerter dazu, die das Token ENTHALTEN
 * (infixTerms) - erst damit findet "milch" die "Vollmilch". Ohne bleibt es
 * beim reinen Praefix (reine Syntax-Tests, Aufrufer ohne Verbindung).
 *
 * @param {string} q
 * @param {{ database?: Database | null }} [options]
 */
export function buildMatchQuery(q, { database = null } = {}) {
  const tokens = queryTokens(q);
  if (!tokens.length) return null;
  const phrase = (v) => `"${v.replace(/"/g, '""')}"`;
  return tokens.map((t) => {
    const branches = [...eszettVariants(t)].map((v) => `${phrase(v)}*`);
    if (database) branches.push(...infixTerms(database, t).map(phrase));
    const clause = branches.join(' OR ');
    return clause.includes(' OR ') ? `(${clause})` : clause;
  }).join(' AND ');
}

/**
 * Welches Modul jede Trefferart durchsucht (#467).
 *
 * DIE SUCHE IST DER ZWEITE ENDPUNKT, DER EIN DUTZEND MODULE AUF EINMAL
 * AUSLIEFERT, und wie /dashboard kann der Pfad-Guard in server/index.js sie
 * nicht abdecken: `moduleForPath('/search')` ergibt das Scope-Modul `search`,
 * und das ist kein Permissions-Modul - der Guard lässt die Anfrage immer durch.
 *
 * Die Besitzerfilter weiter unten sind eine ANDERE Achse und decken das nicht
 * ab; bei Terminen, Kontakten und Einkaufsartikeln gibt es sie mit Absicht gar
 * nicht (Familienbesitz, #471). Ein Mitglied ohne Kalenderzugriff fand seinen
 * Termin also über die Suche, ein Kind ohne Kontakte die Telefonnummern.
 *
 * Als Tabelle und nicht als Bedingung an jeder Abfrage: die Zuordnung ist die
 * eigentliche Aussage, und wer eine achte Trefferart ergänzt, sieht hier, dass
 * sie eine braucht.
 */
const BUCKET_MODULE = Object.freeze({
  tasks: 'tasks',
  events: 'calendar',
  notes: 'notes',
  contacts: 'contacts',
  items: 'shopping',
  meds: 'health',
  activities: 'health',
  waste: 'waste',
  // Ohne FTS-Index, ueber runTableSearch (Re-Critique 2026-09-27, A1 P2-6).
  // Rezepte gehoeren zum Rechte-Modul `meals` (Kueche), Geburtstage zu
  // `calendar` - dieselbe Zuordnung wie PERMISSION_MODULES.navIds.
  recipes: 'meals',
  pantry: 'pantry',
  inventory: 'inventory',
  documents: 'documents',
  birthdays: 'calendar',
  budget: 'budget',
});

/**
 * Die zweite Achse neben den Rechten: der Navigationseintrag, den ein Admin
 * haushaltweit abschalten kann (`sync_config.disabled_modules`, Werte aus
 * TOGGLEABLE_MODULES). Ein abgeschaltetes Modul gibt es in diesem Haushalt
 * nicht - die Suche fuehrte sonst auf eine Seite, die die Navigation gar nicht
 * anbietet (Inventar und Entsorgung sind ab Werk aus). Rezepte und Geburtstage
 * sind hier eigene Eintraege, obwohl ihr Rechte-Modul `meals` bzw. `calendar`
 * heisst.
 */
const BUCKET_NAV = Object.freeze({
  tasks: 'tasks',
  events: 'calendar',
  notes: 'notes',
  contacts: 'contacts',
  items: 'shopping',
  meds: 'health',
  activities: 'health',
  waste: 'waste',
  recipes: 'recipes',
  pantry: 'pantry',
  inventory: 'inventory',
  documents: 'documents',
  birthdays: 'birthdays',
  budget: 'budget',
});

/** Die Module, aus denen die Suche liest - die Menge, gegen die Token-Scopes geprüft werden. */
export const SEARCH_MODULES = Object.freeze([...new Set(Object.values(BUCKET_MODULE))]);

/**
 * Welche Trefferart bleibt - Rechte-Achse UND Haushalts-Schalter.
 * @param {SearchAxes} [axes]
 */
function bucketFilter({ hiddenModules = null, disabledNav = null } = {}) {
  return (bucket) => !hiddenModules?.has(BUCKET_MODULE[bucket])
    && !disabledNav?.has(BUCKET_NAV[bucket]);
}

/**
 * Die leere Antwort - eine Trefferart je Schlüssel, Form bleibt stabil.
 * Exportiert, damit die Route für „Suchbegriff zu kurz" dieselbe Form schreibt
 * und nicht eine zweite, von Hand gepflegte Liste derselben sieben Schlüssel.
 * @returns {Record<string, any[]>}
 */
export function emptySearchResults() {
  return Object.fromEntries(Object.keys(BUCKET_MODULE).map((k) => [k, []]));
}

/**
 * Führt die Suche aus und liefert dieselbe Ergebnis-Form wie zuvor, erweitert
 * um Gesundheitsdaten: { tasks, events, notes, contacts, items, meds, activities }.
 * Pro Entität wird der FTS-Treffer auf die Quelltabelle zurückgejoined,
 * um exakt die alten Felder, Besitzer-Filter und Sortierung zu erhalten.
 * Gesundheitsdaten sind sensibel: nur eigene Zeilen ODER visibility='family'
 * sind sichtbar (spiegelt das Lese-Scoping der Health-List-Routen).
 *
 * @param {Database} database
 * @param {string} q
 * @param {number} userId
 * @param {object} [opts]
 * @param {Set<string>|null} [opts.hiddenModules] Module, die dem Betrachter
 *        entzogen sind (`access_permissions`, #467) oder die sein API-Token
 *        nicht lesen darf (`hiddenModulesFor` in server/authorize/modules.ts). Aus der
 *        Rollenachse gehört nur `'none'` hinein - `'read'` ist eine
 *        Leseberechtigung, keine Sperre. Ihre Trefferart wird gar nicht erst
 *        abgefragt und bleibt leer.
 * @param {Set<string>|null} [opts.disabledNav] haushaltweit abgeschaltete
 *        Navigationseintraege (householdDisabledModules) - siehe BUCKET_NAV.
 *
 * Die Trefferarten OHNE FTS-Index (Rezepte, Vorrat, Inventar, Dokumente,
 * Geburtstage, Budget) fuellt runTableSearch; beide zusammen: searchEverything.
 *
 * No error isolation, as before: a slice that throws ends the whole search
 * (the route answers 500). Each slice runs only when its bucket is allowed.
 */
export function runSearch(database, q, userId, { hiddenModules = null, disabledNav = null } = {}) {
  const match = buildMatchQuery(q, { database });
  if (!match) return emptySearchResults();

  // Leere Fassung als Ausgangspunkt: eine gesperrte Trefferart bleibt damit
  // eine leere Liste und wird nicht zu einem fehlenden Feld, über das ein
  // Client stolpert (`/api/v1` ist zugesagte Oberfläche für Drittmodule).
  const results = emptySearchResults();
  const allows = bucketFilter({ hiddenModules, disabledNav });
  // The search knows the viewer only by id; the slices bind it as `@userId`
  // (or positionally for the health clause), as the queries did here.
  const actor = { userId };
  const query = { text: q, match };

  if (allows('tasks')) results.tasks = tasksSearchSlice(database, actor, query);
  if (allows('events')) results.events = calendarSearchSlice(database, actor, query, { disabledNav });
  if (allows('notes')) results.notes = notesSearchSlice(database, actor, query);
  if (allows('contacts')) results.contacts = contactsSearchSlice(database, actor, query);
  if (allows('items')) results.items = shoppingSearchSlice(database, actor, query);
  if (allows('meds')) results.meds = healthMedsSearchSlice(database, actor, query);
  if (allows('activities')) results.activities = healthActivitiesSearchSlice(database, actor, query);
  if (allows('waste')) results.waste = wasteSearchSlice(database, actor, query);

  return results;
}

/* TREFFERARTEN OHNE FTS-INDEX (Re-Critique 2026-09-27, A1 P2-6: "nur 6
 * Domaenen"). Rezepte, Vorrat, Inventar, Dokumente, Geburtstage und Budget
 * standen nie im Index. Sie dort aufzunehmen hiesse eine Migration mit je drei
 * Triggern pro Tabelle und einem Backfill - fuer Tabellen, die in einem
 * Haushalt Dutzende bis wenige Tausend Zeilen tragen. Stattdessen liest jede
 * Trefferart ihre Kandidaten mit GENAU dem Sichtbarkeitsfilter ihrer
 * Listenroute (die SQL-Bausteine sind dieselben) und vergleicht in JS ueber
 * foldSearchText: Wortteile, Akzente und ß/ss wie im Index. Gemessen: 20 000
 * Budgetzeilen, 500 Rezepte in ~14 ms, der Demo-Haushalt unter 1 ms.
 *
 * Nur Felder, die die Zielseite selbst zeigt und durchsucht - Seriennummern,
 * Kontonamen oder Dateiinhalte bleiben aussen vor. */

/** Trifft die Eingabe diese Felder? Jedes Wort muss irgendwo stehen (UND). */
function tableMatcher(q) {
  const tokens = queryTokens(q).map(foldSearchText).filter(Boolean);
  if (!tokens.length) return null;
  return (...fields) => {
    const hay = foldSearchText(fields.filter((f) => f != null && f !== '').join(' '));
    return tokens.every((tok) => hay.includes(tok));
  };
}

/**
 * @param {Database} database
 * @param {string} q
 * @param {number} userId
 * @param {SearchAxes} [opts]
 *
 * No error isolation, as before: a slice that throws ends the whole search.
 */
export function runTableSearch(database, q, userId, { hiddenModules = null, disabledNav = null } = {}) {
  const results = emptySearchResults();
  const matches = tableMatcher(q);
  if (!matches) return results;
  const allows = bucketFilter({ hiddenModules, disabledNav });
  const actor = { userId };
  const query = { text: q, matches };

  if (allows('recipes')) results.recipes = recipesSearchSlice(database, actor, query);
  if (allows('pantry')) results.pantry = pantrySearchSlice(database, actor, query);
  if (allows('inventory')) results.inventory = inventorySearchSlice(database, actor, query);
  if (allows('documents')) results.documents = documentsSearchSlice(database, actor, query);
  if (allows('birthdays')) results.birthdays = birthdaysSearchSlice(database, actor, query);
  if (allows('budget')) results.budget = budgetSearchSlice(database, actor, query);

  return results;
}

/**
 * Die ganze Suche: Index-Trefferarten und Tabellen-Trefferarten in einer Antwort.
 * @param {Database} database
 * @param {string} q
 * @param {number} userId
 * @param {SearchAxes} [opts]
 */
export function searchEverything(database, q, userId, opts = {}) {
  const indexed = runSearch(database, q, userId, opts);
  const tables = runTableSearch(database, q, userId, opts);
  const out = { ...indexed };
  for (const bucket of TABLE_BUCKETS) out[bucket] = tables[bucket];
  return out;
}

/** Die Trefferarten, die runTableSearch fuellt - runSearch laesst sie leer. */
export const TABLE_BUCKETS = Object.freeze(['recipes', 'pantry', 'inventory', 'documents', 'birthdays', 'budget']);
