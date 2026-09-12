/**
 * Modul: Such-Service (FTS5)
 * Zweck: Reine Suchlogik gegen den FTS5-Index `search_index` (Migration 44).
 *        Keine Abhängigkeit auf db.js - die Datenbank wird hereingereicht, damit
 *        die Logik direkt mit node:sqlite getestet werden kann.
 * Abhaengigkeiten: server/services/visibility.js (reiner SQL-Baustein, kein db.js)
 */
import { visibilityWhere } from './visibility.js';

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
 * Wandelt eine rohe Nutzereingabe in eine sichere FTS5-MATCH-Query um.
 * Jedes Token wird als Phrase in doppelte Anführungszeichen gesetzt (eingebettete
 * Anführungszeichen verdoppelt) und als Präfix (`*`) gematcht, damit Teiltreffer
 * wie bei der alten LIKE-Suche funktionieren. Tokens werden mit AND verknüpft;
 * ß↔ss-Varianten je Token mit OR. Gibt null zurück, wenn nichts Suchbares bleibt.
 */
export function buildMatchQuery(q) {
  const tokens = String(q || '')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]+/gu, ''))
    .filter(Boolean);
  if (!tokens.length) return null;
  return tokens.map((t) => {
    const clause = [...eszettVariants(t)]
      .map((v) => `"${v.replace(/"/g, '""')}"*`)
      .join(' OR ');
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
});

/** Die Module, aus denen die Suche liest - die Menge, gegen die Token-Scopes geprüft werden. */
export const SEARCH_MODULES = Object.freeze([...new Set(Object.values(BUCKET_MODULE))]);

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
 */
export function runSearch(database, q, userId, { hiddenModules = null } = {}) {
  const match = buildMatchQuery(q);
  if (!match) return emptySearchResults();
  const limit = SEARCH_LIMIT;

  // Leere Fassung als Ausgangspunkt: eine gesperrte Trefferart bleibt damit
  // eine leere Liste und wird nicht zu einem fehlenden Feld, über das ein
  // Client stolpert (`/api/v1` ist zugesagte Oberfläche für Drittmodule).
  const results = emptySearchResults();
  const allows = (bucket) => !hiddenModules?.has(BUCKET_MODULE[bucket]);

  if (allows('tasks')) results.tasks = database.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date
    FROM search_index s
    JOIN tasks t ON t.id = s.entity_id
    WHERE s.entity = 'task' AND s.search_index MATCH @match
      AND t.parent_task_id IS NULL
      AND (t.created_by = @userId OR t.assigned_to = @userId)
    ORDER BY CASE t.status WHEN 'done' THEN 1 ELSE 0 END,
             t.due_date ASC NULLS LAST
    LIMIT @limit
  `).all({ match, userId, limit });

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
    results.events = eventRows.map((event) => ({
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
    }));
  }

  if (allows('notes')) results.notes = database.prepare(`
    SELECT n.id, n.title, n.content
    FROM search_index s
    JOIN notes n ON n.id = s.entity_id
    WHERE s.entity = 'note' AND s.search_index MATCH @match
      AND n.created_by = @userId
    ORDER BY n.pinned DESC, n.updated_at DESC
    LIMIT @limit
  `).all({ match, userId, limit });

  if (allows('contacts')) results.contacts = database.prepare(`
    SELECT c.id, c.name AS title
    FROM search_index s
    JOIN contacts c ON c.id = s.entity_id
    WHERE s.entity = 'contact' AND s.search_index MATCH @match
    ORDER BY c.name ASC
    LIMIT @limit
  `).all({ match, limit });

  if (allows('items')) results.items = database.prepare(`
    SELECT i.id, i.name AS title, i.list_id
    FROM search_index s
    JOIN shopping_items i ON i.id = s.entity_id
    WHERE s.entity = 'item' AND s.search_index MATCH @match
    ORDER BY i.name ASC
    LIMIT @limit
  `).all({ match, limit });

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
  `).all({ match, userId, limit });

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
