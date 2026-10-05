// --------------------------------------------------------
// Owner-basierte Sichtbarkeit für Budget-Objekte (Einträge/Loans/Subscriptions).
//
// Lean-Modell (#476/#505). Anders als services/visibility.js (assignment-basiert,
// mehrere Zugewiesene pro Objekt) hat jedes Budget-Objekt genau eine:n
// Eigentümer:in (owner_id, fix = Ersteller:in). Es gibt KEINEN Admin-Bypass —
// auch Admins sehen/bearbeiten keine fremden privaten Objekte (konsistent mit
// #474). Privatsphäre wird allein über visibility + owner-Enforcement geschützt,
// nicht über Rollen.
//
// Zwei Achsen:
//   visibility ('private' | 'shared' | 'shared_amount')  – wer darf was SEHEN
//   Ansichts-Scope ('mine' | 'household') – reiner Anzeige-Filter im Personal-Modus
//
// Der Haushalts-Modus (budget_mode: 'shared' | 'personal') entscheidet, ob die
// Sichtbarkeit überhaupt greift: im 'shared'-Modus sehen alle alles (Altverhalten).
//
// DREI STUFEN, ZWEI FRAGEN (#659). 'private' und 'shared' beantworteten bisher
// zwei Fragen mit einem Wort: ob ein Eintrag in die SUMMEN einfliesst und ob er
// seine DETAILS zeigt. Für geteilte Konten ist das zu grob - wer eine private
// Ausgabe bucht, verschweigt meist den Zweck, nicht den Abfluss, und der
// Kontostand der anderen ist dadurch schlicht falsch. 'shared_amount' trennt die
// beiden Fragen:
//
//              zählt in Summen?      zeigt Details?
//   private    nur bei Owner         nur Owner
//   shared     bei allen             bei allen
//   amount     bei allen             nur Owner
//
// Fremde sehen eine 'shared_amount'-Zeile also mit Datum und Betrag, aber ohne
// Titel, Kategorie und Belege. Der Saldo bleibt so aus der Liste nachvollziehbar,
// statt um einen unerklärten Betrag daneben zu liegen.
// --------------------------------------------------------

export const BUDGET_VISIBILITY_VALUES = ['private', 'shared', 'shared_amount'];

/**
 * Die Stufen, die Darlehen und Abos kennen. 'shared_amount' sitzt bewusst nur
 * am einzelnen Eintrag (#659): dort fällt die Ausgabe an, dort wirkt sie auf
 * den Kontostand, und nur budget_entries hat den erweiterten CHECK bekommen.
 * Ein Darlehen wirkt ohnehin über die Einträge, die es beim Bezahlen erzeugt.
 */
export const BUDGET_OBJECT_VISIBILITY_VALUES = ['private', 'shared'];

/**
 * Kategorie-Schlüssel, unter dem maskierte Einträge in Aggregationen laufen.
 * Bewusst ein eigener Sammel-Bucket statt der echten Kategorie: sonst verriete
 * die Kategorie-Statistik genau den Zweck, den 'shared_amount' schützt. Das
 * Frontend übersetzt den Schlüssel, der Server liefert kein fertiges Label.
 */
export const BUDGET_MASKED_CATEGORY = '__private__';

/**
 * Liest den Haushalts-Budget-Modus aus sync_config. DB wird injiziert, damit
 * dieses Modul DB-frei/testbar bleibt und alle Call-Sites (budget.js,
 * subscriptions.js, dashboard.js) denselben Wert ohne Drift nutzen (#476/#505).
 * @param {{ prepare: Function }} database  better-sqlite3/node:sqlite-Instanz
 * @returns {'shared'|'personal'}
 */
export function resolveBudgetMode(database) {
  const row = database.prepare("SELECT value FROM sync_config WHERE key = 'budget_mode'").get();
  return row && row.value === 'personal' ? 'personal' : 'shared';
}

/** Normalisiert einen eingehenden Wert auf eine gültige Stufe. */
export function normalizeBudgetVisibility(value, fallback = 'shared') {
  return BUDGET_VISIBILITY_VALUES.includes(value) ? value : fallback;
}

/**
 * Normalisierung für Darlehen und Abos, die nur zwei Stufen kennen.
 *
 * 'shared_amount' fällt hier bewusst auf 'private' statt auf den Standard
 * 'shared': wer die Stufe schickt, will den Zweck gerade NICHT zeigen. Auf die
 * offenere Stufe zu runden würde aus einem Privatsphäre-Wunsch stillschweigend
 * das Gegenteil machen - die restriktivere Antwort ist die einzige, die keinen
 * Schaden anrichten kann.
 */
export function normalizeObjectVisibility(value, fallback = 'shared') {
  if (value === 'shared_amount') return 'private';
  return BUDGET_OBJECT_VISIBILITY_VALUES.includes(value) ? value : fallback;
}

/**
 * WHERE-Fragment für die Lese-Durchsetzung (ohne führendes AND). KEIN Admin-Bypass.
 *
 * Deckt die erste Frage ab: FLIESST das Objekt ein - in Listen wie in Summen.
 * 'shared_amount' ist hier bewusst mit 'shared' gleichgestellt; sein Betrag soll
 * ja gerade zählen. Was es von 'shared' unterscheidet, entscheidet nicht dieser
 * Filter, sondern die Maskierung unten.
 *
 * @param {string} alias   Tabellen-Alias des Budget-Objekts (z. B. 'b')
 * @param {string} meBind  Platzhalter der betrachtenden User-ID (z. B. '@me')
 * @param {object} opts    { mode: 'shared' | 'personal' }
 * @returns {string} SQL-Fragment
 */
export function budgetVisibilityWhere(alias, meBind, { mode } = {}) {
  if (mode !== 'personal') return '1=1'; // 'shared'/undefined: Altverhalten, alle sehen alles
  return `(${alias}.visibility <> 'private' OR ${alias}.owner_id = ${meBind})`;
}

/**
 * WHERE-Fragment für Lesepfade, in denen es NUR um den Zweck geht und gar
 * nicht um Beträge - etwa die Inventar-Verknüpfungen, die eine Buchung einem
 * Gegenstand zuordnen. Dort ist 'shared_amount' wie 'private' zu behandeln:
 * eine Verknüpfung ist eine Aussage darüber, WOFÜR das Geld war, also genau
 * das, was die Stufe verbirgt. Es gibt dort auch keinen Saldo, den ein
 * Weglassen verfälschen könnte.
 *
 * Faustregel für neue Call-Sites: geht es um den BETRAG, nimm
 * budgetVisibilityWhere(); geht es um den ZWECK, nimm dieses hier.
 *
 * @param {string} alias   Tabellen-Alias
 * @param {string} meBind  Platzhalter der betrachtenden User-ID
 * @param {object} opts    { mode: 'shared' | 'personal' }
 * @returns {string} SQL-Fragment (ohne führendes AND)
 */
export function budgetDetailsVisibleWhere(alias, meBind, { mode } = {}) {
  if (mode !== 'personal') return '1=1';
  return `(${alias}.visibility = 'shared' OR ${alias}.owner_id = ${meBind})`;
}

/**
 * WHERE-Fragment für die zweite Frage: sind die DETAILS verborgen (ohne
 * führendes AND). Wahr genau für fremde 'shared_amount'-Objekte - 'private'
 * fremder Leute ist durch budgetVisibilityWhere() ohnehin schon draussen.
 *
 * Gedacht zum Aufteilen einer Aggregation in "echte Kategorie" und
 * "Sammel-Bucket", nicht zum Ausschliessen: die Zeile bleibt sichtbar.
 *
 * @param {string} alias   Tabellen-Alias
 * @param {string} meBind  Platzhalter der betrachtenden User-ID
 * @param {object} opts    { mode: 'shared' | 'personal' }
 * @returns {string} SQL-Fragment
 */
export function budgetDetailsHiddenWhere(alias, meBind, { mode } = {}) {
  if (mode !== 'personal') return '0=1'; // shared-Modus maskiert nie
  return `(${alias}.visibility = 'shared_amount' AND ${alias}.owner_id <> ${meBind})`;
}

/**
 * Ansichts-Filter (Mein Budget vs. Haushalt). Reiner Filter, additiv zur
 * Sichtbarkeit.
 *   'mine'      → owner_id = me   (meine privaten + meine geteilten)
 *   'household' → alles, was nicht rein privat ist (der gemeinsame Topf)
 *
 * 'shared_amount' gehört in den Haushalts-Topf: sein Betrag ist Teil des
 * gemeinsamen Bildes, das ist der ganze Zweck der Stufe.
 *
 * @param {string} scope  'mine' | 'household'
 * @param {string} alias  Tabellen-Alias
 * @param {string} meBind Platzhalter der betrachtenden User-ID
 * @returns {string} SQL-Fragment (ohne führendes AND)
 */
export function budgetScopeWhere(scope, alias, meBind) {
  if (scope === 'mine') return `${alias}.owner_id = ${meBind}`;
  return `${alias}.visibility <> 'private'`;
}

/**
 * JS-Pendant zu budgetDetailsHiddenWhere() für bereits geladene Zeilen.
 * @param {{ visibility?: string, owner_id?: number } | null} row
 * @param {number} viewerId
 * @param {'shared'|'personal'} mode
 */
export function hidesBudgetDetails(row, viewerId, mode) {
  if (mode !== 'personal' || !row) return false;
  return row.visibility === 'shared_amount' && row.owner_id !== viewerId;
}

/**
 * Entfernt die Zweck-Felder eines Eintrags für fremde Augen (#659). Betrag,
 * Datum und Konto bleiben stehen - sie sind der Grund, warum die Stufe
 * existiert. Der Aufrufer liefert `details_hidden`, das Frontend setzt daraus
 * ein übersetztes Ersatzlabel; der Server schickt bewusst keinen fertigen Text,
 * damit die Maske nicht an einer Sprache klebt.
 *
 * Gibt die Zeile unverändert zurück, wenn nichts zu verbergen ist.
 * @param {object} row       Eintrag aus budget_entries (bereits serialisiert)
 * @param {number} viewerId
 * @param {'shared'|'personal'} mode
 */
export function maskBudgetEntry(row, viewerId, mode) {
  if (!hidesBudgetDetails(row, viewerId, mode)) return row;
  const masked = {
    ...row,
    title: '',
    category: BUDGET_MASKED_CATEGORY,
    subcategory: '',
    details_hidden: true,
  };
  // Verknüpfungen verraten den Zweck genauso wie der Titel: ein Beleg heisst
  // nach dem, wofür er ausgestellt wurde, und ein verknüpfter Gegenstand ist
  // der Zweck selbst. Beide fallen deshalb mit weg.
  delete masked.attachments;
  delete masked.documents;
  delete masked.inventory_items;
  delete masked.recurrence_rule;
  // Eine Darlehensrate ist dieselbe Art Verknuepfung: Titel und Partner des
  // Darlehens nennen den Zweck woertlich, die IDs fuehren zu ihm. Eine Rate
  // erbt die Stufe ihres Darlehens, laesst sich aber einzeln auf
  // 'shared_amount' stellen - dann darf ein privates Darlehen nicht ueber die
  // Buchungsliste herausfallen.
  delete masked.loan_payment_id;
  delete masked.loan_id;
  delete masked.loan_installment_number;
  delete masked.loan_title;
  delete masked.loan_borrower;
  return masked;
}

/**
 * Schreib-Berechtigung für PUT/DELETE (KEIN Admin-Bypass).
 * @param {{ owner_id?: number, created_by?: number } | null} entry
 * @param {{ id: number }} user
 */
export function canEditEntry(entry, user) {
  if (!entry || !user) return false;
  return entry.owner_id === user.id || entry.created_by === user.id;
}
