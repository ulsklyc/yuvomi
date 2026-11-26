/**
 * Modul: Aufgaben-Auswahl (geteilte Abfrage-Logik)
 * Zweck: Welche Aufgaben überhaupt in eine Liste gehören - zentral, damit
 *        Aufgaben-Route und Dashboard exakt dieselbe Auswahl treffen.
 * Abhängigkeiten: server/utils/sql-in-list.ts
 *
 * WARUM ALS SERVICE: `GET /api/v1/tasks` und `GET /api/v1/dashboard` beantworten
 * dieselbe Frage („welche Aufgaben stehen an?") und hatten dafür zwei Kopien der
 * Regeln, die auseinandergelaufen sind. Das Modul schloss Unteraufgaben und noch
 * nicht begonnene Aufgaben aus, das Dashboard nicht - eine Unteraufgabe stand
 * dort als kontextlose eigene Zeile, und eine Aufgabe mit Startdatum nächste
 * Woche stand heute schon da (Discussion #825). Dieselbe Sorte Divergenz hat
 * schon #467 (Modulrechte) und #769 (Sichtbarkeit beim Ablegen) verursacht.
 * Vorbild ist `calendar-events.js`, das Kalender-Route und Dashboard seit jeher
 * teilen.
 *
 * WAS HIER NICHT HINEINGEHÖRT: die Filter, die nur eine Seite kennt - Status,
 * Priorität, Person, Tags und die Archiv-Achse (#688) mit ihrer Verschränkung
 * von `?archived` und `?status=archived`. Das sind Wünsche des Betrachters an
 * eine Liste, keine Aussage darüber, was eine Liste überhaupt enthalten darf.
 *
 * DIE KATEGORIE HAT DIESE GRENZE MIT #814 GEWECHSELT, und zwar aus genau dem
 * Grund, der oben steht: seit die Übersicht ihre Kategorien einschränken kann,
 * ist sie ein Wunsch, den BEIDE Seiten kennen - und damit eine Regel, die zwei
 * Fassungen haben könnte. Sie steht deshalb hier, als Fragment wie das Scope
 * darüber, statt ein zweites Mal in der Dashboard-Route.
 *
 * Guards: test/test-task-scope.js
 */

import { sqlInList } from '../utils/sql-in-list.ts';

/**
 * WHERE-Fragment für die Grundauswahl einer Aufgabenliste.
 *
 * Gebaut wie `visibilityWhere()`: ein Fragment ohne führendes AND, mit
 * konfigurierbarem Platzhalter. WER `includeFuture` NICHT SETZT, MUSS DEN
 * TAGESSCHLÜSSEL BINDEN - bei `bind: '?'` an genau der Stelle, an der das
 * Fragment in die Anweisung eingesetzt wird.
 *
 * Der Tag kommt bewusst als Parameter und nicht als `date('now')` aus SQLite:
 * das wäre der UTC-Tag, während `start_date` ein lokal eingegebener Kalendertag
 * ist. Westlich von UTC hätte eine Aufgabe damit am Abend vor ihrem Startdatum
 * schon angefangen, östlich davon am Morgen danach noch nicht. Die CI läuft in
 * UTC, wo beide Tage gleich sind - genau deshalb fällt so etwas dort nie auf
 * (CLAUDE.md führt diese Falle, `dashboard.js` erklärt sie an `todayLocalKey`).
 *
 * @param {string} alias  Tabellen-Alias der Aufgaben (z. B. 't')
 * @param {object} [opts]
 * @param {boolean} [opts.includeFuture]   true = auch Aufgaben, die erst später
 *                                         beginnen (kein Bind nötig)
 * @param {boolean} [opts.includeSubtasks] true = auch Unteraufgaben als eigene Zeilen
 * @param {string}  [opts.bind]            Platzhalter des lokalen Tagesschlüssels:
 *                                         '?' (positional) oder benannt wie '@today'
 * @returns {string} SQL-Fragment (ohne führendes AND), nie leer
 */
export function taskScopeWhere(alias, { includeFuture = false, includeSubtasks = false, bind = '?' } = {}) {
  const parts = [];

  // Eine Unteraufgabe ist ein Punkt ihrer Elternaufgabe, kein eigener
  // Listeneintrag: allein gezeigt fehlt ihr der Satz, zu dem sie gehört.
  if (!includeSubtasks) parts.push(`${alias}.parent_task_id IS NULL`);

  // `start_date` ist Yuvomis „ab wann taucht das auf" - eine Aufgabe ohne
  // Startdatum gilt als sofort begonnen.
  if (!includeFuture) parts.push(`(${alias}.start_date IS NULL OR ${alias}.start_date <= ${bind})`);

  // Beide Schalter zugleich gesetzt: das Fragment ist dann bedingungslos wahr.
  // Ein leerer String würde beim Aufrufer zu `AND ` und damit zu einem
  // Syntaxfehler - `1=1` hält die Verkettung an jeder Aufrufstelle gültig.
  return parts.length ? parts.join(' AND ') : '1=1';
}

/**
 * Braucht diese Konfiguration einen gebundenen Tagesschlüssel?
 * Für Aufrufer mit positionalen Platzhaltern, die ihre Parameterliste selbst
 * führen und sonst raten müssten, ob sie einen Wert nachschieben.
 *
 * @param {object} [opts] dieselben Optionen wie `taskScopeWhere`
 * @returns {boolean}
 */
export function taskScopeNeedsToday({ includeFuture = false } = {}) {
  return !includeFuture;
}

/**
 * WHERE-Fragment für eine Einschränkung auf bestimmte Kategorien.
 *
 * Mehrere Werte verbinden sich ODER, aus demselben Grund wie bei Status und
 * Priorität (#671): eine Aufgabe trägt genau EINE Kategorie, ein UND über zwei
 * Werte wäre garantiert leer. Zwischen den Achsen bleibt es UND.
 *
 * Leere Liste = keine Einschränkung, und das ist die wichtigere Hälfte: ein
 * Filter, der ohne Auswahl alles wegschneidet, macht aus „ich habe nichts
 * gewählt" ein leeres Dashboard.
 *
 * BENANNTE ODER POSITIONALE PLATZHALTER, nicht beides gemischt: die Aufrufer
 * sind sich darin uneinig, und node:sqlite lässt eine Mischung in einer
 * Anweisung nicht zu. Die Aufgabenroute zählt ihre Parameter selbst durch und
 * bindet `categoryParam()` an der Stelle des Fragments, die Übersicht bindet
 * @today und @me namentlich - mit `named` bekommt sie `@cat` und dazu das
 * passende Objekt aus `categoryBindings()`. Die Liste ist EIN Parameter, ein
 * JSON-Array für json_each (server/utils/sql-in-list.ts, Refs #2810).
 *
 * @param {string} alias        Tabellen-Alias der Aufgaben
 * @param {string[]} categories Kategorie-Schlüssel (normalisiert)
 * @param {object} [opts]
 * @param {string} [opts.named] Präfix für benannte Platzhalter, z. B. 'cat'
 * @returns {string|null} Fragment ohne führendes AND, oder null wenn nichts einzuschränken ist
 */
export function taskCategoryWhere(alias, categories, { named = null } = {}) {
  if (!Array.isArray(categories) || categories.length === 0) return null;
  return `${alias}.category IN (${sqlInList(categories, named ?? undefined).sql})`;
}

/**
 * Der positionale Wert zum Fragment oben: EIN Parameter für die ganze Liste.
 *
 * @param {string[]} categories
 * @returns {string}
 */
export function categoryParam(categories) {
  return sqlInList(categories).param;
}

/**
 * Der benannte Wert zum Fragment oben - derselbe Name. Leer ohne Kategorien,
 * dann steht im Fragment auch kein Platzhalter.
 *
 * @param {string[]} categories
 * @param {string} [named]
 * @returns {Record<string, string>}
 */
export function categoryBindings(categories, named = 'cat') {
  return categories.length ? { [named]: sqlInList(categories).param } : {};
}

/**
 * Kategorie-Parameter einer Anfrage auf eine saubere Liste bringen.
 *
 * Express liefert `?category=a` als String und `?category=a&category=b` als
 * Array - wer den Rohwert bindet, schiebt im zweiten Fall ein Array in einen
 * Platzhalter, und die Anweisung kommt gar nicht erst durch. Doppelte fliegen
 * raus, und die Obergrenze haelt eine Anfrage mit tausend Werten klein (die
 * Liste selbst geht seit #2810 als EIN Parameter an SQLite).
 *
 * @param {unknown} raw   req.query.<name>
 * @param {number} [max]  Obergrenze (default 50)
 * @returns {string[]}
 */
export function normalizeCategoryFilter(raw, max = 50) {
  if (raw === undefined || raw === null) return [];
  const list = [raw].flat().filter((v) => typeof v === 'string' && v !== '');
  return [...new Set(list)].slice(0, max);
}
