/**
 * Modul: Such-Service (FTS5)
 * Zweck: Reine Suchlogik gegen den FTS5-Index `search_index` (Migration 44).
 *        Keine Abhängigkeit auf db.js - die Datenbank wird hereingereicht, damit
 *        die Logik direkt mit node:sqlite getestet werden kann.
 * Abhaengigkeiten: server/services/visibility.js, document-access.js und
 *        budget-visibility.js (reine SQL-Bausteine, kein db.js)
 */
import { visibilityWhere } from './visibility.js';
import { documentVisibleSql } from './document-access.js';
import { budgetDetailsVisibleWhere, resolveBudgetMode } from './budget-visibility.js';

import {
  expandRecurringEvents, loadEventExceptions,
} from './calendar-events.js';
import { eventProjectionSql, resolveProjectedEventRows } from './calendar-event-reader.js';

export const SEARCH_LIMIT = 5;

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

/**
 * Die Faltung, die der FTS-Tokenizer (unicode61 remove_diacritics 2) an jedem
 * Wort vornimmt, fuer JS nachgebaut: klein, ohne Akzente. Das Eszett bleibt -
 * der Tokenizer faltet es auch nicht (siehe eszettVariants).
 */
function foldLikeIndex(text) {
  return String(text ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/**
 * Dieselbe Faltung plus ß->ss: der Vergleichsschluessel fuer Trefferarten ohne
 * FTS-Index (runTableSearch). Beide Seiten laufen hindurch, deshalb findet
 * "strasse" die "Straße" und "muller" den "Müller" wie im Index.
 */
export function foldSearchText(text) {
  return foldLikeIndex(text).replace(/ß/g, 'ss');
}

/** Die Woerter der Eingabe, wie buildMatchQuery sie sieht - ohne Satzzeichen. */
function queryTokens(q) {
  return String(q || '')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]+/gu, ''))
    .filter(Boolean);
}

/* AUSSCHNITT FUER TREFFER AUSSERHALB DES TITELS (Re-Critique 2026-09-28, A1
 * P2-2). "sch" fand "Klavier ueben" ohne jeden Grund im Bild: das Wort stand in
 * der Beschreibung, und die Palette zeigte nur Titel und Datum. Steht die
 * Eingabe nicht vollstaendig im Titel, bekommt der Treffer `excerpt` - ein
 * Stueck des ersten Felds, das ein Suchwort enthaelt, um die Fundstelle herum.
 * Nur Felder, die der Betrachter auf der Zielseite ohnehin sieht; die Zeilen
 * sind zu diesem Zeitpunkt schon durch ihre Sichtbarkeitsfilter gelaufen. */
export const EXCERPT_RADIUS = 36;

/** Faltung je Zeichen samt Rueckweg: folded[i] stammt aus original[map[i]]. */
function foldWithMap(text) {
  const chars = [...String(text ?? '')];
  let folded = '';
  const map = [];
  let offset = 0;
  for (const ch of chars) {
    const f = foldSearchText(ch);
    for (let i = 0; i < f.length; i += 1) map.push(offset);
    folded += f;
    offset += ch.length;
  }
  map.push(offset);
  return { folded, map };
}

/**
 * @param {string} q        die Eingabe
 * @param {string} title    was die Palette als Titel zeigt
 * @param {Array<string|null|undefined>} texts  weitere sichtbare Felder, in Vorrang
 * @returns {string|null}
 */
export function searchExcerpt(q, title, texts) {
  const tokens = queryTokens(q).map(foldSearchText).filter(Boolean);
  if (!tokens.length) return null;
  const inTitle = foldSearchText(title);
  const missing = tokens.filter((tok) => !inTitle.includes(tok));
  if (!missing.length) return null;
  for (const raw of texts) {
    if (raw == null || raw === '') continue;
    const text = String(raw).replace(/\s+/g, ' ').trim();
    const { folded, map } = foldWithMap(text);
    const at = missing.map((tok) => ({ i: folded.indexOf(tok), len: tok.length })).filter((m) => m.i >= 0)
      .sort((a, b) => a.i - b.i)[0];
    if (!at) continue;
    const from = map[at.i];
    const to = map[at.i + at.len];
    let start = Math.max(0, from - EXCERPT_RADIUS);
    let end = Math.min(text.length, to + EXCERPT_RADIUS);
    // An Wortgrenzen schneiden, nicht mitten im Wort.
    if (start > 0) { const sp = text.indexOf(' ', start); if (sp >= 0 && sp < from) start = sp + 1; }
    if (end < text.length) { const sp = text.lastIndexOf(' ', end); if (sp > to) end = sp; }
    return `${start > 0 ? '\u2026' : ''}${text.slice(start, end).trim()}${end < text.length ? '\u2026' : ''}`;
  }
  return null;
}

/** Zeile mit Ausschnitt (falls einer faellt), ohne interne Hilfsfelder (`_body`). */
function withExcerpt(row, q, texts) {
  const { _body, ...rest } = row;
  const excerpt = searchExcerpt(q, rest.title, texts);
  return excerpt ? { ...rest, excerpt } : rest;
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

/** Welche Trefferart bleibt - Rechte-Achse UND Haushalts-Schalter. */
function bucketFilter({ hiddenModules = null, disabledNav = null } = {}) {
  return (bucket) => !hiddenModules?.has(BUCKET_MODULE[bucket])
    && !disabledNav?.has(BUCKET_NAV[bucket]);
}

/**
 * Die leere Antwort - eine Trefferart je Schlüssel, Form bleibt stabil.
 * Exportiert, damit die Route für „Suchbegriff zu kurz" dieselbe Form schreibt
 * und nicht eine zweite, von Hand gepflegte Liste derselben sieben Schlüssel.
 */
export function emptySearchResults() {
  return Object.fromEntries(Object.keys(BUCKET_MODULE).map((k) => [k, []]));
}

/**
 * Resolves event search hits through the same linked-occurrence contract as
 * calendar reads. When a display window is supplied, recurring master hits are
 * represented by their first occurrence in that window, preserving the
 * calendar-search behavior without expanding one FTS hit into many results.
 */
export function resolveEventSearchRows(database, rows, from = null, to = null, options = {}) {
  const recurringIds = rows.filter((row) => row.recurrence_rule).map((row) => row.id);
  const exceptions = loadEventExceptions(database, recurringIds);
  const displayRows = rows.map((row) => {
    if (!row.recurrence_rule || !from || !to) return row;
    return expandRecurringEvents(
      [row],
      from,
      to,
      exceptions,
      { includeRecurrenceIdentity: true },
    )[0] || row;
  });
  return resolveProjectedEventRows(database, displayRows, options)
    .sort((a, b) => String(a.start_datetime).localeCompare(String(b.start_datetime)));
}

/**
 * Führt die Suche aus und liefert dieselbe Ergebnis-Form wie zuvor, erweitert
 * um Gesundheitsdaten: { tasks, events, notes, contacts, items, meds, activities }.
 * Pro Entität wird der FTS-Treffer auf die Quelltabelle zurückgejoined,
 * um exakt die alten Felder, Besitzer-Filter und Sortierung zu erhalten.
 * Gesundheitsdaten sind sensibel: nur eigene Zeilen ODER visibility='family'
 * sind sichtbar (spiegelt das Lese-Scoping der Health-List-Routen).
 *
 * @param {object} database
 * @param {string} q
 * @param {number} userId
 * @param {object} [opts]
 * @param {Set<string>|null} [opts.hiddenModules] Module, die dem Betrachter
 *        entzogen sind (`access_permissions`, #467) oder die sein API-Token
 *        nicht lesen darf (`hiddenModulesFor` in permissions.js). Aus der
 *        Rollenachse gehört nur `'none'` hinein - `'read'` ist eine
 *        Leseberechtigung, keine Sperre. Ihre Trefferart wird gar nicht erst
 *        abgefragt und bleibt leer.
 * @param {Set<string>|null} [opts.disabledNav] haushaltweit abgeschaltete
 *        Navigationseintraege (householdDisabledModules) - siehe BUCKET_NAV.
 *
 * Die Trefferarten OHNE FTS-Index (Rezepte, Vorrat, Inventar, Dokumente,
 * Geburtstage, Budget) fuellt runTableSearch; beide zusammen: searchEverything.
 */
export function runSearch(database, q, userId, { hiddenModules = null, disabledNav = null } = {}) {
  const match = buildMatchQuery(q, { database });
  if (!match) return emptySearchResults();
  const limit = SEARCH_LIMIT;

  // Leere Fassung als Ausgangspunkt: eine gesperrte Trefferart bleibt damit
  // eine leere Liste und wird nicht zu einem fehlenden Feld, über das ein
  // Client stolpert (`/api/v1` ist zugesagte Oberfläche für Drittmodule).
  const results = emptySearchResults();
  const allows = bucketFilter({ hiddenModules, disabledNav });

  if (allows('tasks')) results.tasks = database.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date, s.body AS _body
    FROM search_index s
    JOIN tasks t ON t.id = s.entity_id
    WHERE s.entity = 'task' AND s.search_index MATCH @match
      AND t.parent_task_id IS NULL
      AND (t.created_by = @userId OR t.assigned_to = @userId)
    ORDER BY CASE t.status WHEN 'done' THEN 1 ELSE 0 END,
             t.due_date ASC NULLS LAST
    LIMIT @limit
  `).all({ match, userId, limit }).map((row) => withExcerpt(row, q, [row._body]));

  // Termine sind Familienbesitz (die Kalenderliste zeigt alle Termine, nicht nur
  // eigene) - daher KEIN created_by-Filter, konsistent mit GET /calendar und der
  // Kalender-Suche (#471). Was die beiden aber seit #474 haben und diese Abfrage
  // bis zum Review von #1055 nicht: die Zeilen-Sichtbarkeit (`all` / Ersteller /
  // Zugewiesene) und den Abo-Filter (ICS-Termine nur aus geteilten oder eigenen
  // Abos). Ohne beides fand jedes Mitglied Titel und Datum fremder PRIVATER
  // Termine ueber ein Stichwort. Es sind dieselben zwei Klauseln wie in
  // routes/calendar/read.js, damit globale und Kalender-Suche fuers gleiche
  // Stichwort dieselben Treffer liefern - das war der Sinn von #471. Beide
  // Filter müssen vor ORDER/LIMIT greifen, damit verborgene Treffer sichtbare
  // nicht aus dem Ergebnisfenster verdrängen.
  if (allows('events')) {
    const eventRows = resolveEventSearchRows(database, database.prepare(`
      SELECT ${eventProjectionSql(database)}
      FROM search_index s
      JOIN calendar_events e ON e.id = s.entity_id
      WHERE s.entity = 'event' AND s.search_index MATCH @match
        AND (
          e.external_source <> 'ics'
          OR e.subscription_id IN (
            SELECT id FROM ics_subscriptions WHERE shared = 1 OR created_by = @userId
          )
        )
        AND ${visibilityWhere('e', 'event_assignments', 'event_id', '@userId')}
      ORDER BY e.start_datetime ASC
      LIMIT @limit
    `).all({ match, userId, limit }), null, null, { lightweight: true });
    // Preserve the compact global-search payload. The resolver-capable
    // projection supplies linked inheritance without loading attachment bodies
    // or unrelated sync metadata into this result bucket.
    results.events = eventRows.map((event) => withExcerpt({
      id: event.id,
      title: event.title,
      start_datetime: event.start_datetime,
      all_day: event.all_day,
      ...(event.is_occurrence_override ? {
        series_id: event.series_id,
        recurrence_id: event.recurrence_id,
        is_occurrence_override: true,
        assignment_owner_id: event.assignment_owner_id,
        attachment_owner_id: event.attachment_owner_id,
        reminder_owner_id: event.reminder_owner_id,
        reminder_anchor_start: event.reminder_anchor_start,
      } : {}),
    }, q, [event.description, event.location]));
  }

  if (allows('notes')) results.notes = database.prepare(`
    SELECT n.id, n.title, n.content
    FROM search_index s
    JOIN notes n ON n.id = s.entity_id
    WHERE s.entity = 'note' AND s.search_index MATCH @match
      AND n.created_by = @userId
    ORDER BY n.pinned DESC, n.updated_at DESC
    LIMIT @limit
  `).all({ match, userId, limit }).map((row) => withExcerpt(row, q, [row.content]));

  if (allows('contacts')) results.contacts = database.prepare(`
    SELECT c.id, c.name AS title, s.body AS _body
    FROM search_index s
    JOIN contacts c ON c.id = s.entity_id
    WHERE s.entity = 'contact' AND s.search_index MATCH @match
    ORDER BY c.name ASC
    LIMIT @limit
  `).all({ match, limit }).map((row) => withExcerpt(row, q, [row._body]));

  if (allows('items')) results.items = database.prepare(`
    SELECT i.id, i.name AS title, i.list_id, s.body AS _body
    FROM search_index s
    JOIN shopping_items i ON i.id = s.entity_id
    WHERE s.entity = 'item' AND s.search_index MATCH @match
    ORDER BY i.name ASC
    LIMIT @limit
  `).all({ match, limit }).map((row) => withExcerpt(row, q, [row._body]));

  // Health: Medikamente — Treffer auf Name/Dosistext, Sichtbarkeits-Scoping.
  if (allows('meds')) results.meds = database.prepare(`
    SELECT m.id, m.name AS title, m.dosage_text, m.active
    FROM search_index s
    JOIN medications m ON m.id = s.entity_id
    WHERE s.entity = 'medication' AND s.search_index MATCH @match
      AND (m.user_id = @userId OR m.visibility = 'family')
    ORDER BY m.active DESC, m.name ASC
    LIMIT @limit
  `).all({ match, userId, limit });

  // Health: Aktivitäten — Treffer auf Typ/Notiz, Sichtbarkeits-Scoping.
  if (allows('activities')) results.activities = database.prepare(`
    SELECT a.id, a.type AS title, a.note, a.performed_at
    FROM search_index s
    JOIN health_activities a ON a.id = s.entity_id
    WHERE s.entity = 'activity' AND s.search_index MATCH @match
      AND (a.user_id = @userId OR a.visibility = 'family')
    ORDER BY a.performed_at DESC
    LIMIT @limit
  `).all({ match, userId, limit }).map((row) => withExcerpt(row, q, [row.note]));

  // Waste: nur der Typ-Katalog ist indiziert (Migration 206) - nie die von
  // waste-domain.js berechneten, potenziell unbegrenzten Termine (siehe dortige
  // Migrationsnotiz). Kein Besitzer-Filter (Haushaltseigentum, wie Kontakte),
  // archivierte Typen bleiben ausgeblendet wie überall sonst in Waste.
  if (allows('waste')) results.waste = database.prepare(`
    SELECT wt.id, wt.name AS title, wt.icon, wt.color
    FROM search_index s
    JOIN waste_types wt ON wt.id = s.entity_id
    WHERE s.entity = 'waste_type' AND s.search_index MATCH @match
      AND wt.archived = 0
    ORDER BY wt.sort_order ASC, wt.name ASC
    LIMIT @limit
  `).all({ match, limit });

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

/** Die ersten `limit` Zeilen, deren Felder passen - Reihenfolge aus dem SQL. */
function firstMatches(rows, matches, fieldsOf, limit) {
  const out = [];
  for (const row of rows) {
    if (matches(...fieldsOf(row))) out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row[k]]));

/**
 * @param {object} database
 * @param {string} q
 * @param {number} userId
 * @param {{ hiddenModules?: Set<string>|null, disabledNav?: Set<string>|null }} [opts]
 */
export function runTableSearch(database, q, userId, { hiddenModules = null, disabledNav = null } = {}) {
  const results = emptySearchResults();
  const matches = tableMatcher(q);
  if (!matches) return results;
  const limit = SEARCH_LIMIT;
  const allows = bucketFilter({ hiddenModules, disabledNav });

  // Rezepte: Haushaltsbesitz wie die Liste (GET /recipes filtert nicht),
  // gespiegelte Mealie/Tandoor-Rezepte eingeschlossen.
  if (allows('recipes')) {
    results.recipes = firstMatches(database.prepare(`
      SELECT r.id, r.title, r.notes FROM recipes r
      ORDER BY r.title COLLATE NOCASE ASC, r.id DESC
    `).all(), matches, (r) => [r.title, r.notes], limit)
      .map((r) => withExcerpt(pick(r, ['id', 'title']), q, [r.notes]));
  }

  if (allows('pantry')) {
    results.pantry = firstMatches(database.prepare(`
      SELECT p.id, p.name AS title, p.quantity, p.unit, p.expires_on, p.notes
      FROM pantry_items p
      ORDER BY p.name COLLATE NOCASE ASC, p.id ASC
    `).all(), matches, (p) => [p.title, p.notes], limit)
      .map((p) => withExcerpt(pick(p, ['id', 'title', 'quantity', 'unit', 'expires_on']), q, [p.notes]));
  }

  // Inventar: aktive Gegenstaende zuerst, verkaufte/entsorgte bleiben
  // auffindbar (die Liste zeigt sie ueber den Statusfilter).
  if (allows('inventory')) {
    results.inventory = firstMatches(database.prepare(`
      SELECT i.id, i.name AS title, i.brand, i.model, i.status, i.notes
      FROM inventory_items i
      ORDER BY CASE i.status WHEN 'active' THEN 0 ELSE 1 END, i.name COLLATE NOCASE ASC
    `).all(), matches, (i) => [i.title, i.brand, i.model, i.notes], limit)
      .map((i) => withExcerpt(pick(i, ['id', 'title', 'brand', 'model', 'status']), q, [i.brand, i.model, i.notes]));
  }

  // Dokumente: dieselbe Sichtbarkeit wie GET /documents (eigen, Familie oder
  // ausdruecklich freigegeben) und nur der aktive Bestand, den die Liste zeigt.
  if (allows('documents')) {
    results.documents = firstMatches(database.prepare(`
      SELECT d.id, d.name AS title, d.description, d.category, d.updated_at
      FROM family_documents d
      WHERE ${documentVisibleSql('d', 'userId')} AND d.status = 'active'
      ORDER BY d.updated_at DESC, d.id DESC
    `).all({ userId }), matches, (d) => [d.title, d.description], limit)
      .map((d) => withExcerpt(pick(d, ['id', 'title', 'category']), q, [d.description]));
  }

  // Geburtstage: Haushaltsbesitz, Rechte-Modul `calendar` (siehe BUCKET_MODULE).
  if (allows('birthdays')) {
    results.birthdays = firstMatches(database.prepare(`
      SELECT b.id, b.name AS title, b.birth_date, b.notes
      FROM birthdays b
      ORDER BY b.name COLLATE NOCASE ASC, b.id ASC
    `).all(), matches, (b) => [b.title, b.notes], limit)
      .map((b) => withExcerpt(pick(b, ['id', 'title', 'birth_date']), q, [b.notes]));
  }

  // Budget: gesucht wird im TITEL, also nur dort, wo der Betrachter den Titel
  // sieht - budgetDetailsVisibleWhere, nicht budgetVisibilityWhere. Eine
  // 'shared_amount'-Zeile eines anderen zeigt ihm Datum und Betrag, aber nicht
  // den Zweck (#659); fand die Suche sie ueber den Zweck, verriete schon der
  // Treffer, was die Stufe verschweigt. Neueste zuerst.
  if (allows('budget')) {
    const mode = resolveBudgetMode(database);
    results.budget = firstMatches(database.prepare(`
      SELECT b.id, b.title, b.amount, b.date
      FROM budget_entries b
      WHERE ${budgetDetailsVisibleWhere('b', '@userId', { mode })}
      ORDER BY b.date DESC, b.id DESC
    `).all(mode === 'personal' ? { userId } : {}), matches, (b) => [b.title], limit)
      .map((b) => pick(b, ['id', 'title', 'amount', 'date']));
  }

  return results;
}

/** Die ganze Suche: Index-Trefferarten und Tabellen-Trefferarten in einer Antwort. */
export function searchEverything(database, q, userId, opts = {}) {
  const indexed = runSearch(database, q, userId, opts);
  const tables = runTableSearch(database, q, userId, opts);
  const out = { ...indexed };
  for (const bucket of TABLE_BUCKETS) out[bucket] = tables[bucket];
  return out;
}

/** Die Trefferarten, die runTableSearch fuellt - runSearch laesst sie leer. */
export const TABLE_BUCKETS = Object.freeze(['recipes', 'pantry', 'inventory', 'documents', 'birthdays', 'budget']);
