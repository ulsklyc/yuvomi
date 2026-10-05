/**
 * Modul: Bewegung neu gezeichneter Listen (list-motion)
 * Zweck: DER Standard fuer Listen, die ihre Zeilen bei jeder Aenderung neu
 *        bauen (`replaceChildren` + `insertAdjacentHTML`): die entfernte Zeile
 *        klappt aus, die eingefuegte klappt ein, eine umsortierte gleitet an
 *        ihre Stelle (FLIP), und nur der erste Aufbau blendet gestaffelt ein.
 * Abhaengigkeiten: /utils/ux.js (collapseOut, expandIn, stagger), /utils/flip.js
 *
 * WARUM (Critique R16, P2 Bewegung): jedes der Bauteile gab es genau einmal -
 * FLIP nur im Einkauf, `collapseOut`/`expandIn` nur in den Aufgaben.
 * Haushaltshilfe, Entsorgung, Belohnungen und Vorrat bauten jede Aenderung
 * hart neu: eine erledigte oder geloeschte Zeile war weg, die Nachbarn
 * sprangen nach.
 *
 * DIE REGELN:
 * - Wiedererkannt wird eine Zeile an einem Datenattribut (`keyAttr`): die
 *   Listen bauen neue Knoten, das alte Element gibt es danach nicht mehr.
 * - EINE Bewegung je Neuzeichnen, nie zwei uebereinander: kommt eine Zeile
 *   hinzu, zieht sie ihre Hoehe auf und die Nachbarn folgen dem Layout - ein
 *   FLIP darueber wuerde sie doppelt versetzen. FLIP laeuft nur, wenn sich
 *   allein die Reihenfolge geaendert hat.
 * - Eine entfernte Zeile kann erst ausklappen, solange es sie noch gibt:
 *   `collapseRow()` VOR dem Neuzeichnen awaiten.
 * - Kein Endzustand haengt an einer Animation. `render()` laeuft immer und
 *   synchron; die Helfer aus ux.js schweigen unter reduzierter Bewegung und
 *   loesen auch ohne `finish` auf (verdeckter Tab).
 */
// Relativ importiert (wie utils/sortable.js): im Browser dieselbe Modul-URL wie
// '/utils/ux.js', und die Unit-Tests laden die Datei ohne Loader.
import { collapseOut, expandIn, stagger } from './ux.js';
import { flipSnapshot, flipPlay } from './flip.js';

/**
 * Zeichnet eine Liste neu und bewegt, was sich geaendert hat.
 *
 * Standen VOR dem Neuzeichnen keine Zeilen im Traeger (Skelett, Leerzustand,
 * ein anderer Reiter desselben Traegers), ist es ein AUFBAU: die Zeilen blenden
 * gestaffelt ein, und das nur einmal je Traeger (`stagger` merkt ihn sich).
 * Erst danach vergleicht der Helfer vorher und nachher.
 *
 * @param {Element|null} host        Traeger, der das Neuzeichnen ueberlebt
 * @param {() => void} render        baut die Zeilen neu (synchron)
 * @param {object} opts
 * @param {string} opts.selector     die Zeilen (z. B. '.swipe-row[data-swipe-id]')
 * @param {string} opts.keyAttr      Attribut, an dem eine Zeile wiedererkannt wird
 * @returns {{ first: boolean, entered: number, moved: number }}
 */
export function redrawList(host, render, { selector, keyAttr }) {
  const before = flipSnapshot(host, selector, keyAttr);
  render();
  const result = { first: false, entered: 0, moved: 0 };
  if (!host?.querySelectorAll) return result;
  const rows = [...host.querySelectorAll(selector)];
  if (!rows.length) return result;

  if (!before.size) {
    stagger(rows, { host });
    result.first = true;
    return result;
  }

  const fresh = rows.filter((el) => {
    const key = el.getAttribute?.(keyAttr);
    return key != null && key !== '' && !before.has(key);
  });
  if (fresh.length) {
    for (const el of fresh) expandIn(el);
    result.entered = fresh.length;
    return result;
  }
  result.moved = flipPlay(host, selector, keyAttr, before);
  return result;
}

/**
 * Laesst eine Zeile ausklappen, BEVOR die Liste ohne sie neu gezeichnet wird.
 * Ist sie die letzte ihrer Gruppe, geht die Gruppe mit (`group`).
 *
 * @param {Element|null} row
 * @param {object} [opts]
 * @param {Element|null} [opts.group]  Gruppe, die mit ihrer letzten Zeile geht
 * @param {string} [opts.selector]     Zeilen der Gruppe (zum Zaehlen)
 * @returns {Promise<void>}
 */
export function collapseRow(row, { group = null, selector = null } = {}) {
  if (!row) return Promise.resolve();
  const last = group && selector ? group.querySelectorAll(selector).length <= 1 : false;
  return collapseOut(last ? group : row);
}
