/**
 * Modul: Haushaltsreihenfolge der Mitglieder (#1644)
 * Zweck: Der EINE Vergleich, nach dem der Browser Personen ordnet - der
 *        Zwilling von `memberOrderSql()` in server/services/household-members.js.
 * Abhaengigkeiten: keine
 *
 * WARUM ES IHN GIBT, OBWOHL DER SERVER SCHON SORTIERT. Jede Personenliste der
 * API kommt in der Haushaltsreihenfolge an, und eine Seite, die sie nur
 * zeichnet, braucht diese Datei nicht. Sie ist fuer die Stellen, an denen der
 * Browser Personen selbst zusammenstellt: zwei Listen mischt, eine nach dem
 * Ziehen neu einreiht, Personen aus Datensaetzen einsammelt. Dort stand vorher
 * je ein eigenes `localeCompare` - mit der Sprache des Geraets, also auf zwei
 * Geraeten desselben Haushalts verschieden, und an der Haushaltsreihenfolge
 * vorbei.
 *
 * DIE REGEL, wortgleich zum Server:
 *   1. Platzierte vor Unplatzierten (`sort_order` null = nicht platziert).
 *   2. Platzierte nach ihrer Position; Luecken sind erlaubt.
 *   3. Unplatzierte nach Anzeigename, wie SQLite `COLLATE NOCASE` ihn ordnet:
 *      nur A-Z wird gefaltet, sonst gilt die Reihenfolge der Codepunkte. Ein
 *      Umlaut steht damit hinter Z - das ist die Reihenfolge von vor #1644,
 *      und sie bleibt, damit ein Haushalt ohne Positionen nichts wandern sieht.
 *      KEIN `localeCompare`: das ordnete "Ömer" vor "Zoe" ein, der Server
 *      dahinter, und dieselbe Liste stuende je nach Herkunft anders da.
 *   4. Bei Gleichstand die id.
 *
 * `sort_order` kommt vom Server schon als "Position eines Mitglieds, sonst
 * null" (`memberPositionSql()`); hier wird sie nur gelesen.
 * `npm run test:member-order` faehrt beide Seiten gegen dieselben Personen.
 */

/** Position in der Haushaltsreihenfolge, oder `null` fuer "nicht platziert". */
export function memberPosition(person) {
  const value = person?.sort_order;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function foldAscii(codePoint) {
  return codePoint >= 65 && codePoint <= 90 ? codePoint + 32 : codePoint;
}

/**
 * Vergleicht zwei Namen wie SQLite `COLLATE NOCASE`: Codepunkt fuer Codepunkt
 * (das ist die Bytefolge in UTF-8), nur ASCII-Grossbuchstaben gefaltet; ist
 * einer der Anfang des anderen, steht der kuerzere vorn.
 */
export function compareNamesNoCase(a, b) {
  const left = Array.from(String(a ?? ''), (char) => foldAscii(char.codePointAt(0)));
  const right = Array.from(String(b ?? ''), (char) => foldAscii(char.codePointAt(0)));
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

function idOf(person) {
  const id = Number(person?.id ?? person?.user_id);
  return Number.isFinite(id) ? id : 0;
}

/**
 * Der Vergleich fuer `Array.prototype.sort`: zwei Personen in der
 * Haushaltsreihenfolge. Liest `sort_order`, `display_name` und `id` (ersatzweise
 * `user_id`, wo ein Datensatz die Person so nennt).
 */
export function compareMembers(a, b) {
  const pa = memberPosition(a);
  const pb = memberPosition(b);
  if (pa !== null || pb !== null) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    if (pa !== pb) return pa - pb;
  }
  return compareNamesNoCase(a?.display_name, b?.display_name) || idOf(a) - idOf(b);
}

/** Eine neue Liste in der Haushaltsreihenfolge; die uebergebene bleibt, wie sie ist. */
export function sortMembers(people) {
  return [...(Array.isArray(people) ? people : [])].sort(compareMembers);
}

/**
 * Rang je Person fuer Stellen, die nicht Personen ordnen, sondern etwas, das
 * an Personen haengt (die Spalten eines Stundenplans, die Termine einer
 * Ueberlappung in #1633): `rank.get(userId)` ist die Stelle in der
 * Haushaltsreihenfolge, 0 zuerst. Wer in `people` nicht vorkommt, hat keinen
 * Rang - `memberRankOf()` stellt ihn ans Ende.
 *
 * @param {Array<object>} people  Personen mit `id`, `display_name`, `sort_order`
 * @returns {Map<number, number>}
 */
export function memberRanks(people) {
  return new Map(sortMembers(people).map((person, index) => [idOf(person), index]));
}

/** Der Rang einer id aus `memberRanks()`; Unbekannte hinter allen Bekannten. */
export function memberRankOf(ranks, userId) {
  const rank = ranks?.get(Number(userId));
  return rank === undefined ? Number.MAX_SAFE_INTEGER : rank;
}
