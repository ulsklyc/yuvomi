/**
 * Modul: VTODO-Tags (Aufgaben und Einkaufsposten)
 * Zweck: Lesen, Schreiben und Normalisieren der freien Tags einer Aufgabe (#586).
 *        Einkaufsposten teilen die Speicherschicht, weil eine
 *        CalDAV-Erinnerungsliste auf beide Module zeigen kann (#617) und dort
 *        dieselbe Eigenschaft CATEGORIES ankommt. Die Verwaltung (umbenennen,
 *        löschen, Bulk) gibt es nur für Aufgaben - siehe unten.
 *        Gegenstück zu VTODO CATEGORIES - bewusst getrennt von der Kategorie:
 *        eine Aufgabe liegt in genau einer Kategorie, trägt aber beliebig viele
 *        Tags.
 *
 * Die Normalisierung liegt hier und nicht in der Route, weil Tags aus zwei
 * Richtungen kommen: aus der Oberfläche und aus fremden CalDAV-Servern. Zwei
 * Kopien derselben Regel wären eine wandernde Annahme - fiele eine Seite zurück,
 * unterschieden sich die Tags derselben Aufgabe je nach Herkunft.
 *
 * Abhängigkeiten: server/authorize/rows/assignees.ts (reiner SQL-Fragment-Bauer ohne
 * eigene Abhängigkeiten - die Sichtbarkeitsregel gehört zu jeder Tag-Abfrage,
 * die eine Liste an eine Person ausliefert).
 */

import { visibleWhere } from '../authorize/index.ts';

// Identisch zu den Grenzen im Parser (server/services/ics-parser.js): was von
// dort hereinkommt, ist bereits gedeckelt, was aus der Oberfläche kommt, wird es
// hier. Ein Wert, der eine Grenze reißt, wird gekürzt statt abgelehnt - ein
// Sync-Lauf darf an einem zu langen Fremd-Tag nicht scheitern.
export const MAX_TAGS = 32;
export const MAX_TAG_LEN = 64;

/**
 * Vergleichsschlüssel eines Tags: NFC-normalisiert und kleingeschrieben.
 *
 * Der Grund, warum es diese Spalte in der Datenbank überhaupt gibt: SQLites
 * eingebautes `COLLATE NOCASE` faltet ausschließlich ASCII. „Äpfel" wird damit
 * über „äpfel" **nicht** gefunden, über „ÄPFEL" schon - in einer deutschen App
 * mit Tags aus fremden Kalendern ist das keine Randnotiz. `lower()` in SQLite
 * hat dieselbe Grenze, und eine eigene Collation zu registrieren ginge nur in
 * einem der beiden verwendeten Treiber.
 *
 * Also fällt die Entscheidung dort, wo Unicode wirklich verstanden wird: in JS.
 * Geschrieben wird beides, die Schreibweise für die Anzeige und dieser Schlüssel
 * für jeden Vergleich. NFC zuerst, damit ein vorkomponiertes „Ä" und ein „A" mit
 * kombinierendem Trema denselben Schlüssel ergeben.
 */
export function tagKey(tag) {
  return String(tag).normalize('NFC').toLowerCase();
}

/**
 * Beliebige Eingabe auf eine saubere Tag-Liste bringen: trimmen, leere weg,
 * kürzen, deckeln, und Groß-/Kleinschreibung eint (erste Schreibweise gewinnt,
 * damit „Garten" und „garten" nicht zweimal in der Filterleiste stehen).
 *
 * Nimmt ein Array oder einen kommaseparierten String - die Oberfläche schickt
 * das eine, ein direkter API-Aufruf gern das andere.
 */
export function normalizeTags(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string' ? input.split(',') : [];

  const out  = [];
  const seen = new Set();
  for (const item of raw) {
    if (item === null || item === undefined) continue;
    const tag = String(item).trim().slice(0, MAX_TAG_LEN).trim();
    if (!tag) continue;
    // "." und ".." fallen raus. Sie tragen als Etikett nichts, und die
    // Verwaltungsrouten adressieren einen Tag über ein Pfadsegment: der
    // URL-Parser löst genau diese beiden vorher auf, sodass
    // `/tasks/tags/..` zu `/tasks/` wird und ein Umbenennen still auf einer
    // fremden Route landet. Prozentkodieren hilft nicht, %2E wird ebenso
    // aufgelöst. Jeder andere Wert übersteht das Segment unbeschadet.
    if (tag === '.' || tag === '..') continue;
    const key = tagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Kanonische Fassung einer Tag-Liste für Vergleiche (sortiert).
 * Die Rückrichtung (#617) entscheidet damit, ob sich die Tags einer Aufgabe
 * wirklich geändert haben - eine bloße Umsortierung ist keine Änderung und darf
 * keinen Push auslösen.
 *
 * Die Schreibweise zählt dagegen sehr wohl. Sie zu ignorieren hieße, dass ein
 * Umbenennen von "garten" auf "Garten" den Server nie erreicht: lokal stünde die
 * neue Schreibweise, der Vergleich sähe keine Änderung, und der nächste
 * Sync-Lauf holte die alte zurück. Innerhalb einer Aufgabe kann dabei nichts
 * kollidieren - normalizeTags eint Groß-/Kleinschreibung ohnehin.
 *
 * Trenner ist U+0000, weil ein Tag Leerzeichen enthalten darf: mit einem Space
 * verbunden wären ["a b", "c"] und ["a", "b c"] derselbe Schlüssel und eine
 * echte Änderung bliebe unbemerkt. Das Zeichen steht bewusst als Escape-Sequenz
 * und nicht als rohes Byte in der Datei - ein literales NUL macht die Datei für
 * git zu einer Binärdatei, die in keinem Diff und keinem Review mehr auftaucht.
 */
export function tagsKey(tags) {
  return normalizeTags(tags).slice().sort().join('\u0000');
}

// --------------------------------------------------------
// Speicherschicht
//
// Zwei Tabellen, eine Regel: Aufgaben und Einkaufsposten spiegeln dieselbe
// VTODO-Eigenschaft, weil eine CalDAV-Erinnerungsliste auf beide Module zeigen
// kann (#617). Die Ablage ist deshalb einmal geschrieben und über den Store
// parametriert - zwei Kopien liefen beim ersten Sonderfall auseinander.
// --------------------------------------------------------

const STORES = {
  task:     { table: 'task_tags',          fk: 'task_id' },
  shopping: { table: 'shopping_item_tags', fk: 'item_id' },
};

/** Tags einer Zeile, alphabetisch. */
function load(database, { table, fk }, id) {
  return database
    .prepare(`SELECT tag FROM ${table} WHERE ${fk} = ? ORDER BY tag COLLATE NOCASE ASC`)
    .all(id)
    .map((r) => r.tag);
}

/**
 * Tags mehrerer Zeilen in einer Abfrage. Die Listen-Routen hängen an jede Zeile
 * ihre Tags - einzeln abgefragt wäre das ein Statement pro Zeile.
 *
 * @returns {Map<number, string[]>}
 */
function loadFor(database, { table, fk }, ids) {
  const map = new Map();
  if (!ids?.length) return map;

  const placeholders = ids.map(() => '?').join(',');
  const rows = database.prepare(`
    SELECT ${fk} AS owner_id, tag FROM ${table}
    WHERE ${fk} IN (${placeholders})
    ORDER BY tag COLLATE NOCASE ASC
  `).all(...ids);

  for (const { owner_id, tag } of rows) {
    if (!map.has(owner_id)) map.set(owner_id, []);
    map.get(owner_id).push(tag);
  }
  return map;
}

/**
 * Setzt die Tags einer Zeile neu (Replace-Set).
 * @returns {string[]} die tatsächlich gespeicherten Tags
 */
function set(database, { table, fk }, id, tags) {
  const normalized = normalizeTags(tags);
  database.prepare(`DELETE FROM ${table} WHERE ${fk} = ?`).run(id);
  const ins = database.prepare(
    `INSERT OR IGNORE INTO ${table} (${fk}, tag, tag_key) VALUES (?, ?, ?)`);
  for (const tag of normalized) ins.run(id, tag, tagKey(tag));
  return normalized;
}

/** Tags einer Aufgabe, alphabetisch. */
export function loadTags(database, taskId) {
  return load(database, STORES.task, taskId);
}

/** Tags mehrerer Aufgaben in einer Abfrage. */
export function loadTagsFor(database, taskIds) {
  return loadFor(database, STORES.task, taskIds);
}

/** Setzt die Tags einer Aufgabe neu (Replace-Set). */
export function setTags(database, taskId, tags) {
  return set(database, STORES.task, taskId, tags);
}

/** Tags eines Einkaufspostens, alphabetisch. */
export function loadItemTags(database, itemId) {
  return load(database, STORES.shopping, itemId);
}

/** Tags mehrerer Einkaufsposten in einer Abfrage. */
export function loadItemTagsFor(database, itemIds) {
  return loadFor(database, STORES.shopping, itemIds);
}

/** Setzt die Tags eines Einkaufspostens neu (Replace-Set). */
export function setItemTags(database, itemId, tags) {
  return set(database, STORES.shopping, itemId, tags);
}

/**
 * Die für eine Person sichtbaren Tags mit ihrer Häufigkeit - Grundlage der
 * Filterleiste und der Vorschläge im Bearbeiten-Dialog.
 *
 * Die Sichtbarkeitsprüfung ist hier kein Beiwerk. Ein Tag ist Freitext und trägt
 * damit selbst Inhalt: ohne die Prüfung stünde das Etikett einer privaten
 * Aufgabe ("Überraschung Nina") mitsamt Zähler in der Filterleiste jedes
 * Haushaltsmitglieds, obwohl die Aufgabe selbst nirgends auftaucht. Die Regel
 * aus #474 gilt auf jedem Lesepfad, und eine Tag-Liste ist einer.
 *
 * Fehlt `me`, bleibt nur übrig, was ohnehin für alle sichtbar ist - ein
 * vergessener Parameter zeigt also zu wenig statt zu viel.
 *
 * @param {number|null} me betrachtende User-ID
 */
export function allTags(database, me = null) {
  return database.prepare(`
    SELECT MIN(tt.tag) AS tag, COUNT(*) AS count
    FROM task_tags tt
    JOIN tasks t ON t.id = tt.task_id
    WHERE ${visibleWhere('tasks', 't', '@me')}
    GROUP BY tt.tag_key
    ORDER BY count DESC, tag COLLATE NOCASE ASC
  `).all({ me });
}

// --------------------------------------------------------
// Verwaltung: umbenennen, entfernen, mehrere auf einmal ändern
//
// Alle drei arbeiten ausschließlich auf Aufgaben, die die handelnde Person sehen
// darf. Eine Umbenennung lässt den Tag auf einer fremden privaten Aufgabe also
// stehen. Das ist Absicht und keine Lücke: die Alternative wäre, Zeilen zu
// ändern, deren Existenz die handelnde Person nicht kennen soll - dann verriete
// schon die gemeldete Trefferzahl, dass es sie gibt.
//
// Jede Änderung geht durch setTags und damit durch normalizeTags. Ein UPDATE auf
// task_tags wäre kürzer, würde aber am Regelwerk vorbeigehen: die Primärschlüssel
// vergleichen Bytes, "Haus" und "haus" wären zwei Zeilen, und eine Umbenennung,
// die zwei Tags derselben Aufgabe zusammenführt, hinterließe beide.
// --------------------------------------------------------

/** Sichtbare Aufgaben, die `tag` tragen (ohne Rücksicht auf Schreibweise). */
export function taskIdsWithTag(database, tag, me = null) {
  return database.prepare(`
    SELECT DISTINCT t.id AS id
    FROM task_tags tt
    JOIN tasks t ON t.id = tt.task_id
    WHERE tt.tag_key = ?
      AND ${visibleWhere('tasks', 't', '@me')}
    ORDER BY t.id
  `).all(tagKey(tag), { me }).map((r) => r.id);
}

/**
 * Wendet `mutate` auf die Tag-Liste jeder Aufgabe an und speichert das Ergebnis.
 *
 * Liefert je wirklich geänderter Aufgabe den Stand davor und danach zurück - der
 * Aufrufer braucht beides, um den CalDAV-Push vorzumerken, und die Zeilen, die
 * sich nicht geändert haben, dürfen dabei nicht als Änderung durchgehen.
 *
 * @param {(tags: string[]) => string[]} mutate
 * @returns {{ id: number, before: string[], after: string[] }[]}
 */
export function mutateTags(database, taskIds, mutate) {
  const changed = [];
  for (const id of taskIds) {
    const before = loadTags(database, id);
    const after  = normalizeTags(mutate(before));
    // Exakter Vergleich, nicht tagsKey: eine reine Änderung der Schreibweise
    // ("garten" → "Garten") ist genau der Fall, den das Umbenennen abdeckt.
    if (before.length === after.length && before.every((v, i) => v === after[i])) continue;
    setTags(database, id, after);
    changed.push({ id, before, after });
  }
  return changed;
}

/**
 * Benennt einen Tag auf allen sichtbaren Aufgaben um. Zielt der neue Name auf
 * einen Tag, den es schon gibt, ist das Ergebnis eine Zusammenführung - normale
 * Tag-Semantik und der übliche Weg, ein versehentliches Duplikat einzusammeln.
 *
 * Angefasst werden dabei auch die Aufgaben, die nur den Zieltag tragen: die
 * getippte Schreibweise gilt hinterher überall. Ohne das führte ein Umbenennen
 * von "alt" auf "ZIEL" bei vorhandenem "ziel" zu zwei Schreibweisen desselben
 * Etiketts - in der Filterleiste steht dann ein Eintrag (allTags gruppiert
 * NOCASE) mit einer Beschriftung, die davon abhängt, welche Zeile SQLite zuerst
 * greift.
 */
export function renameTag(database, { from, to, me = null, ids = null }) {
  const fromKey = tagKey(from);
  const toKey   = tagKey(to);
  // `ids` vorgeben heisst: die Auswahl ist schon getroffen. Die Aufgaben-Route
  // nutzt das, um gesperrte Aufgaben auszunehmen (#830) - sie kennt die
  // Berechtigungsregel, diese Datei soll sie nicht kennen muessen.
  const targets = ids ?? [...new Set([
    ...taskIdsWithTag(database, from, me),
    ...taskIdsWithTag(database, to, me),
  ])];
  return mutateTags(database, targets, (tags) =>
    tags.map((tag) => {
      const key = tagKey(tag);
      return key === fromKey || key === toKey ? to : tag;
    }));
}

/** Entfernt einen Tag von allen sichtbaren Aufgaben. */
export function removeTagEverywhere(database, { tag, me = null, ids = null }) {
  const key = tagKey(tag);
  return mutateTags(database, ids ?? taskIdsWithTag(database, tag, me), (tags) =>
    tags.filter((existing) => tagKey(existing) !== key));
}

/**
 * Hängt an mehrere Aufgaben Tags an bzw. nimmt welche weg (Bulk-Vergabe).
 * `add` wird hinten angefügt, damit der Deckel aus normalizeTags im Zweifel den
 * neuen Tag verwirft und nicht einen bestehenden.
 */
export function applyTagChanges(database, { taskIds, add = [], remove = [] }) {
  const removeKeys = new Set(normalizeTags(remove).map(tagKey));
  const addList    = normalizeTags(add);
  return mutateTags(database, taskIds, (tags) =>
    [...tags.filter((tag) => !removeKeys.has(tagKey(tag))), ...addList]);
}
