/**
 * Modul: Spalten für sich überlappende Einträge im Zeitraster
 * Zweck: EINE Stelle, die entscheidet, wer in Tages- und Wochenansicht neben
 *        wem steht. Zwei Packungen über derselben Gruppenbildung: nach Zeit
 *        (Schichtplan-Blöcke) und nach Person (Termine, #1633).
 * Ausfuehren: node --test test/test-overlap-lanes.js
 * Dependencies: keine.
 *
 * Reine Funktionen: kein DOM, kein Zustand, keine Uhr. Was ein Eintrag ist, wie
 * lang er dauert und wem er gehört, sagen die Aufrufer über `rangeFn`,
 * `peopleFn` und `rank`.
 */

/**
 * Gruppiert sich überlappende Einträge (per `rangeFn` bestimmt) in Cluster,
 * innerhalb derer sie sich Spalten teilen müssen - unabhängig von der Frage,
 * WAS ein Eintrag ist (Termin oder Schichtplan-Block). Hälfte-offen: ein
 * Eintrag, der genau dort endet, wo der nächste beginnt, überlappt nicht.
 * Die Gruppe ist die transitive Hülle: A-B und B-C überlappen heißt eine
 * Gruppe, auch wenn A und C sich nie berühren.
 */
export function overlapGroups(items, rangeFn) {
  const groups = [];
  const sorted = [...items].sort((a, b) => {
    const aRange = rangeFn(a);
    const bRange = rangeFn(b);
    return aRange.start - bRange.start || aRange.end - bRange.end;
  });

  let current = [];
  let currentEnd = -1;
  for (const item of sorted) {
    const range = rangeFn(item);
    if (!current.length || range.start < currentEnd) {
      current.push(item);
      currentEnd = current.length === 1 ? range.end : Math.max(currentEnd, range.end);
    } else {
      groups.push(current);
      current = [item];
      currentEnd = range.end;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Packung NACH ZEIT: nach Start, dann Ende, jeder Eintrag nimmt die erste
 * Spalte, die an seinem Start frei ist. So schmal wie möglich, aber wer wo
 * steht, hängt nur an den Uhrzeiten. Das ist die Packung der Schichtplan-Blöcke.
 *
 * `keyFn` bestimmt den Map-Schlüssel: Schichtplan-Einträge haben nicht zwingend
 * eine stabile `id` (Muster-Einträge tragen nur pattern_id+position), und zwei
 * Einträge können legitim denselben Schichttyp und dieselbe Zeit an einem Tag
 * teilen (Muster + Extra-Schicht). Deshalb reicht der Aufrufer das
 * Eintrags-Objekt selbst als Schlüssel: jede sichtbare Instanz bekommt ihren
 * eigenen Platz, auch bei inhaltsgleichen Werten.
 */
export function assignLanes(items, rangeFn, keyFn) {
  const layout = new Map();
  for (const group of overlapGroups(items, rangeFn)) {
    const columns = [];
    const placements = [];
    for (const item of group) {
      const range = rangeFn(item);
      let colIndex = columns.findIndex((end) => end <= range.start);
      if (colIndex === -1) {
        colIndex = columns.length;
        columns.push(range.end);
      } else {
        columns[colIndex] = range.end;
      }
      placements.push({ item, colIndex });
    }
    const totalCols = Math.max(columns.length, 1);
    for (const placement of placements) {
      layout.set(keyFn(placement.item), {
        colIndex: placement.colIndex,
        totalCols,
      });
    }
  }
  return layout;
}

/**
 * Rang aus einer Mitgliederliste: Person-ID -> Position IN DER LISTE, WIE SIE
 * KOMMT. Hier wird nichts sortiert und kein Name verglichen - die Reihenfolge
 * gehört dem, der die Liste hält. Ändert sich dort die Reihenfolge (eine vom
 * Haushalt gewählte, #1644), folgt die Platzierung ohne Änderung an dieser Datei.
 *
 * @param {Array<{id:number|string}>} members
 * @returns {Map<string, number>}
 */
export function memberRank(members) {
  const rank = new Map();
  (members ?? []).forEach((member, index) => {
    const key = String(member?.id);
    if (member?.id != null && !rank.has(key)) rank.set(key, index);
  });
  return rank;
}

// Drei Stufen, in dieser Reihenfolge von links nach rechts.
const TIER_MEMBER = 0;
const TIER_OTHER = 1;
const TIER_NOBODY = 2;

/** Zahlen als Zahlen, alles andere als Text - nie über die Ladereihenfolge. */
function compareIds(a, b) {
  const aNum = Number(a);
  const bNum = Number(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
  const aText = String(a ?? '');
  const bText = String(b ?? '');
  return aText < bText ? -1 : aText > bText ? 1 : 0;
}

/**
 * Wem ein Eintrag für die Platzierung gehört: der Person mit dem KLEINSTEN Rang
 * unter seinen Zugewiesenen - nicht der ersten in seinem eigenen Array, dessen
 * Reihenfolge nichts aussagt (siehe event-color.js).
 */
function ownerOf(people, rank) {
  let best = null;
  for (const id of people ?? []) {
    if (id == null) continue;
    const position = rank.get(String(id));
    const candidate = position === undefined
      ? { tier: TIER_OTHER, value: id }
      : { tier: TIER_MEMBER, value: position };
    if (!best || compareOwners(candidate, best) < 0) best = candidate;
  }
  return best ?? { tier: TIER_NOBODY, value: 0 };
}

function compareOwners(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  return a.tier === TIER_OTHER ? compareIds(a.value, b.value) : a.value - b.value;
}

/**
 * Packung NACH PERSON (#1633): innerhalb EINER Überlappungsgruppe bekommt jede
 * Person ihre eigene Spalte, und die Spalten stehen in der Reihenfolge der
 * Mitgliederliste. Wer um neun links von jemandem steht, steht auch um elf
 * links von ihm.
 *
 * DIE REGEL
 * - Ein Eintrag gehört der Person mit dem kleinsten Rang unter seinen
 *   Zugewiesenen. Mehrere Zugewiesene heißt: die erste von ihnen in der
 *   Mitgliederliste.
 * - Reihenfolge der Spalten: Mitglieder nach Rang; dann Personen, die NICHT in
 *   der Liste stehen (Hauspersonal, stillgelegte Konten, eine ID, die es nicht
 *   mehr gibt), aufsteigend nach ID; zuletzt Einträge ohne Person. Eine
 *   unbekannte Person ist trotzdem JEMAND: ihre Einträge bleiben beieinander und
 *   mischen sich nicht unter "niemand", und die ID ist das Einzige an ihr, das
 *   nicht von der Ladereihenfolge abhängt.
 * - Überlappen sich zwei Einträge DERSELBEN Person, bekommt sie so viele
 *   Spalten nebeneinander, wie gleichzeitig laufen. Innerhalb der Person wird
 *   nach Zeit gepackt: Start, Ende, dann ID.
 * - Breite der Gruppe = Summe der Spalten ihrer Personen. Wer in der Gruppe
 *   nicht vorkommt, bekommt keine Spalte; ein Eintrag, der nichts überlappt,
 *   ist seine eigene Gruppe und behält die volle Breite.
 *
 * DER PREIS, BEKANNT UND GEWOLLT. Eine Kette wird breiter als nach Zeit
 * gepackt: A 9:00-10:00, B 9:30-11:00, C 10:30-12:00 war zwei breit, weil C den
 * frei gewordenen Platz von A nahm; hier ist es drei breit, weil C nicht auf
 * dem Platz von A stehen darf. Je länger die Kette verschiedener Personen,
 * desto mehr Spalten.
 *
 * Das Ergebnis hängt nur an Zeiten, Personen, Rang und ID - nie daran, in
 * welcher Reihenfolge die Einträge geladen wurden.
 *
 * @param {Array<object>} items
 * @param {object} opts
 * @param {(item:object) => {start:number, end:number}} opts.rangeFn
 * @param {(item:object) => Array<number|string>} opts.peopleFn  IDs der Zugewiesenen
 * @param {Map<string, number>} opts.rank  aus memberRank()
 * @param {(item:object) => number|string} [opts.idFn]  letzter Tie-Breaker
 * @returns {Map<object, {colIndex:number, totalCols:number}>}  Schlüssel ist das Eintrags-Objekt
 */
export function assignLanesByPerson(items, { rangeFn, peopleFn, rank, idFn = (item) => item?.id }) {
  const order = rank ?? new Map();
  const layout = new Map();

  for (const group of overlapGroups(items, rangeFn)) {
    // Eigentümer der Gruppe einsammeln, jeder mit seinen Einträgen.
    const owners = [];
    for (const item of group) {
      const owner = ownerOf(peopleFn(item), order);
      let bucket = owners.find((entry) => compareOwners(entry.owner, owner) === 0);
      if (!bucket) {
        bucket = { owner, items: [] };
        owners.push(bucket);
      }
      bucket.items.push(item);
    }
    owners.sort((a, b) => compareOwners(a.owner, b.owner));

    const placements = [];
    let offset = 0;
    for (const bucket of owners) {
      const sorted = bucket.items
        .map((item) => ({ item, range: rangeFn(item) }))
        .sort((a, b) => a.range.start - b.range.start
          || a.range.end - b.range.end
          || compareIds(idFn(a.item), idFn(b.item)));
      const columns = [];
      for (const { item, range } of sorted) {
        let sub = columns.findIndex((end) => end <= range.start);
        if (sub === -1) {
          sub = columns.length;
          columns.push(range.end);
        } else {
          columns[sub] = range.end;
        }
        placements.push({ item, colIndex: offset + sub });
      }
      offset += columns.length;
    }

    const totalCols = Math.max(offset, 1);
    for (const { item, colIndex } of placements) layout.set(item, { colIndex, totalCols });
  }
  return layout;
}
