/**
 * Modul: Dokumente - Suche, Facetten-Zaehler und Sortierung
 * Zweck: Die reinen Rechnungen hinter der Dokumentliste, ohne DOM und ohne
 *        Seitenzustand, damit sie als Programm laufen und nicht nur als Text
 *        geprueft werden koennen.
 *
 * WARUM DIE ZAEHLER DIE SUCHE KENNEN (Critique 2026-09-25, P2): Die Liste
 * rechts filterte nach der Suche, die Zahlen an Kategorie-Chips und Ordnern
 * nicht. Bei "Keine Treffer" stand links weiter "Versicherung 3" - ein Zaehler,
 * der auf eine Liste zeigt, die es unter dieser Suche gar nicht gibt. Eine
 * Zahl muss dasselbe meinen wie die Ansicht, die ein Klick darauf oeffnet.
 */

/** Suchbegriff so, wie `matchesDocumentQuery` ihn vergleicht. */
export function normalizeDocumentQuery(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Trifft die Suche dieses Dokument? Name, Beschreibung und Dateiname.
 * @param {object} doc
 * @param {string} query  bereits normalisiert (`normalizeDocumentQuery`)
 */
export function matchesDocumentQuery(doc, query) {
  if (!query) return true;
  return String(doc?.name ?? '').toLowerCase().includes(query)
    || String(doc?.description ?? '').toLowerCase().includes(query)
    || String(doc?.original_name ?? '').toLowerCase().includes(query);
}

/**
 * Zaehler der Kategorie-Facette. `inScope` ist die jeweils ANDERE Achse
 * (der gewaehlte Ordner): jede Achse zaehlt unter der anderen, nie unter sich
 * selbst - sonst schrumpfte die eigene Wahl die eigene Liste auf einen Eintrag.
 *
 * @returns {Map<string, number>}  `''` = alle Kategorien zusammen
 */
export function categoryFacetCounts(docs, { query = '', inScope = () => true } = {}) {
  const scope = docs.filter((doc) => inScope(doc) && matchesDocumentQuery(doc, query));
  const counts = new Map([['', scope.length]]);
  for (const doc of scope) counts.set(doc.category, (counts.get(doc.category) || 0) + 1);
  return counts;
}

/**
 * Zaehler der Ordner-Facette. Ein Ordner zaehlt seinen ganzen Teilbaum, weil
 * ein Klick darauf auch die Unterordner zeigt (#785).
 *
 * @param {object[]} docs
 * @param {object[]} folders
 * @param {object}   opts
 * @param {string}   [opts.query]
 * @param {Function} [opts.inScope]    die andere Achse (die gewaehlte Kategorie)
 * @param {Function} opts.subtreeOf    (folderId) => Set der ids im Teilbaum
 * @returns {Map<string, number>}  `''` = alle, `'__none'` = ohne Ordner, sonst die Ordner-id
 */
export function folderFacetCounts(docs, folders, { query = '', inScope = () => true, subtreeOf } = {}) {
  const scope = docs.filter((doc) => inScope(doc) && matchesDocumentQuery(doc, query));
  const counts = new Map([
    ['', scope.length],
    ['__none', scope.filter((doc) => !doc.folder_id).length],
  ]);
  const own = new Map();
  for (const doc of scope) {
    if (doc.folder_id) own.set(doc.folder_id, (own.get(doc.folder_id) || 0) + 1);
  }
  for (const folder of folders) {
    let total = 0;
    for (const id of subtreeOf(folder.id)) total += own.get(id) || 0;
    counts.set(String(folder.id), total);
  }
  return counts;
}

/** Sortierschluessel der Liste. `updated` spiegelt die Server-Reihenfolge. */
export const DOCUMENT_SORTS = ['updated', 'name', 'size', 'expiring'];

/**
 * Die Richtung, in der ein Schluessel natuerlich gelesen wird: das Neueste und
 * das Groesste zuerst, Namen von A nach Z, das bald Ablaufende zuerst. Ein
 * Wechsel des Schluessels setzt die Richtung hierauf zurueck - "Name" soll mit
 * A beginnen, auch wenn vorher "Groesse" absteigend stand.
 */
export function defaultSortDirection(sort) {
  return sort === 'updated' || sort === 'size' ? 'desc' : 'asc';
}

/**
 * Sortiert eine Kopie. Dokumente ohne Ablaufdatum stehen bei `expiring` in
 * BEIDEN Richtungen am Ende: eine Sortierung nach etwas, das nicht existiert,
 * waere sonst Zufall - und umgedreht stuenden sie oben und verdraengten genau
 * die Dokumente, nach denen man sortiert hat.
 *
 * @param {object[]} docs
 * @param {object}   opts
 * @param {string}   opts.sort       einer aus DOCUMENT_SORTS
 * @param {'asc'|'desc'} [opts.direction]  Standard: `defaultSortDirection(sort)`
 * @param {string}   [opts.locale]
 */
export function sortDocuments(docs, { sort = 'updated', direction, locale } = {}) {
  const key = DOCUMENT_SORTS.includes(sort) ? sort : 'updated';
  const sign = (direction || defaultSortDirection(key)) === 'desc' ? -1 : 1;
  const ascending = {
    updated: (a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')),
    name: (a, b) => String(a.name || '').localeCompare(String(b.name || ''), locale),
    size: (a, b) => (a.file_size || 0) - (b.file_size || 0),
    expiring: (a, b) => a.expires_at.localeCompare(b.expires_at),
  }[key];
  return [...docs].sort((a, b) => {
    if (key === 'expiring' && (!a.expires_at || !b.expires_at)) {
      if (!a.expires_at && !b.expires_at) return 0;
      return a.expires_at ? -1 : 1;
    }
    return sign * ascending(a, b);
  });
}

/**
 * Wiederholt der Ordnername die Kategorie? Dann steht die Angabe nur einmal da -
 * "Schule · Schule" sagte dasselbe zweimal (Critique 2026-08-27, P3), und
 * "Versicherung · Versicherungen" tat es auch, nur im Plural (Re-Critique
 * 2026-09-25). EINE Regel fuer Zeile, Karte und Betrachter - der Betrachter
 * zeigte die Dopplung noch, als die Zeile sie laengst unterdrueckte.
 *
 * Singular und Plural erkennt die Regel sprachneutral: das kuerzere Wort ist
 * Anfang des laengeren, und es fehlt nur eine Endung von hoechstens drei
 * Zeichen (de -n/-en/-e, en/es/fr -s/-es/-x, tr -lar/-ler). Der Stamm braucht
 * mindestens drei Zeichen, sonst traegt der Vergleich keine Aussage. Ein
 * eigenes Wort ("Arbeitsvertrag" unter "Arbeit", "Schulbus" unter "Schule")
 * bleibt eine Nutzerentscheidung und bleibt sichtbar.
 */
const PLURAL_SUFFIX_MAX = 3;
const PLURAL_STEM_MIN = 3;

export function folderRepeatsCategory(folderName, categoryLabel) {
  const folder = String(folderName ?? '').trim().toLowerCase();
  const category = String(categoryLabel ?? '').trim().toLowerCase();
  if (folder === '' || category === '') return false;
  if (folder === category) return true;
  const [shorter, longer] = folder.length < category.length ? [folder, category] : [category, folder];
  return shorter.length >= PLURAL_STEM_MIN
    && longer.length - shorter.length <= PLURAL_SUFFIX_MAX
    && longer.startsWith(shorter);
}

/**
 * Traegt die Zeile den Ordner-Chip? Nicht, wenn der Ordner die Kategorie
 * wiederholt (folderRepeatsCategory), und nicht im gewaehlten Ordner selbst:
 * dort sagte "Belege" auf jeder Zeile, was die Breadcrumb schon sagt
 * (Re-Critique 2026-09-25). Dokumente aus Unterordnern - der Ordnerfilter
 * zeigt sie mit - behalten ihren Ordner, er ist dort Auskunft.
 */
export function showsFolderChip(doc, categoryLabel, selectedFolderId) {
  if (!doc?.folder_name || doc.folder_id == null) return false;
  if (String(doc.folder_id) === String(selectedFolderId ?? '')) return false;
  return !folderRepeatsCategory(doc.folder_name, categoryLabel);
}

/**
 * Was vor dem Ordnersymbol einer Zeile der Ordnerleiste steht: der Pfeil
 * (`toggle`), ein leerer Platz in Pfeilbreite (`slot`) oder nichts (`none`).
 * Die festen Zeilen ("Alle Dokumente", "Kein Ordner") sind keine Ordner und
 * bekommen nie einen Pfeil, aber denselben Platz, sobald ein Baum neben ihnen
 * steht - sonst standen ihre Symbole 32px links von denen der eigenen Ordner
 * (Re-Critique 2026-09-25). Ohne eigene Ordner gibt es keine Spalte, mit der
 * sie fluchten muessten, und damit keinen Grund einzuruecken.
 */
export function folderRowLead(item, treeHasFolders) {
  if (item.managed) return item.branch ? 'toggle' : 'slot';
  return treeHasFolders ? 'slot' : 'none';
}

/**
 * Die Sichtbarkeit, die ein neues Dokument ohne Zutun traegt. EINE Stelle fuer
 * das Formular und die Frage, ob eine Zeile die Sichtbarkeit nennt.
 */
export const DOCUMENT_DEFAULT_VISIBILITY = 'family';

/**
 * Nennt eine Zeile die Sichtbarkeit? Nur, wenn sie vom Standard abweicht.
 * "Ganze Familie" stand auf jeder Zeile (Re-Critique 2026-09-25) - eine Angabe,
 * die ueberall gleich ist, sagt nichts und verdeckt die Ausnahmen, die zaehlen:
 * privat und ausgewaehlte Personen.
 */
export function showsVisibility(visibility) {
  return (visibility || DOCUMENT_DEFAULT_VISIBILITY) !== DOCUMENT_DEFAULT_VISIBILITY;
}
