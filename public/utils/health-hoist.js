/**
 * Modul: Was in der Gesundheit vor die Bereichsliste und in die Koepfe gehoert
 * (Re-Critique 2026-09-28, R14 P3/P6; A6 P2-2, A8 P3-3/P2-2).
 *
 * DIE PERSONENWAHL STAND IN EINER EIGENEN ZEILE. Mobil kostete sie auf jeder
 * Bereichsseite y122-170 (22 % des Viewports vor der ersten Karte), auf der
 * Uebersicht stand sie bei y=594 HINTER der Bereichsliste, obwohl deren
 * Untertitel personenbezogen sind. „Heute faellig" folgte bei y=658, „Schnell
 * erfassen" erst nach ~1900px Scroll. Am Desktop fehlte der Detailspalte ein
 * Kopf, der den Bereich nennt.
 *
 * Jetzt zieht die Pille in einen Kopf, ohne eigene Zeile:
 *   - Liste + Detail (Desktop): in den Detailkopf neben den Bereichstitel,
 *   - schmal in einem Bereich: in die Zeile „‹ Gesundheit" des Seitenkopfs
 *     (Apples Navigationsleiste: Zurueck links, Aktion rechts),
 *   - Telefon-Uebersicht: in den Streifen VOR der Bereichsliste, zusammen mit
 *     dem Hinweis auf die fremde Ansicht, „Heute faellig" und „Schnell
 *     erfassen" - das, was man heute tut, vor dem, wohin man geht.
 *
 * UMZIEHEN STATT NEU BAUEN: die Panels bauen ihren Inhalt selbst (Person,
 * Zeitraum, Verdrahtung). Diese Datei haengt fertige, verdrahtete Knoten nur
 * um und merkt sich ihr Zuhause - zurueck, wenn die Darstellung wechselt, und
 * weg, wenn ihr Panel inzwischen einen frischen Knoten gebaut hat.
 */

/** Die umziehenden Teile, in der Reihenfolge, in der sie im Ziel stehen. */
export const HOIST_PARTS = {
  person: '.health-person-switcher',
  banner: '.health-readonly-banner',
  due: '.health-overview__card--due',
  quick: '.health-overview__card--quick',
};

/**
 * Wohin was gehoert - reine Entscheidung, ohne DOM.
 * @param {{ split: boolean, overview: boolean, phone: boolean }} s
 * @returns {Array<{ part: keyof HOIST_PARTS, slot: 'detail'|'toolbar'|'priority' }>}
 */
export function hoistPlan({ split, overview, phone }) {
  if (split) return [{ part: 'person', slot: 'detail' }];
  if (!overview) return [{ part: 'person', slot: 'toolbar' }];
  if (!phone) return [];
  return ['person', 'banner', 'due', 'quick'].map((part) => ({ part, slot: 'priority' }));
}

const homes = new WeakMap();

/** Den Knoten eines Teils finden, der zu diesem Panel gehoert - im Panel oder umgezogen. */
function ownedPart(panel, selector, placed) {
  const inside = panel.querySelector(selector);
  if (inside) return inside;
  return placed.find((el) => el.matches?.(selector) && homes.get(el)?.home?.isConnected
    && panel.contains(homes.get(el).home)) ?? null;
}

/**
 * Den Plan anwenden. `slots` nennt die Ziele ({ detail, toolbar, priority }),
 * `panel` ist das aktive Panel. Alles, was vorher umgezogen war und jetzt
 * nicht mehr gewollt ist, geht nach Hause - oder weg, wenn sein Panel schon
 * einen frischen Knoten derselben Art traegt (neu gerendert).
 */
export function applyHoistPlan(plan, { panel, slots }) {
  const placed = Object.values(slots).filter(Boolean).flatMap((slot) => [...slot.children]);
  const wanted = new Map();
  if (panel) {
    for (const { part, slot } of plan) {
      const target = slots[slot];
      const el = target && ownedPart(panel, HOIST_PARTS[part], placed);
      if (el) wanted.set(el, target);
    }
  }
  for (const el of placed) {
    if (wanted.has(el)) continue;
    const record = homes.get(el);
    homes.delete(el);
    const selector = record?.selector;
    if (!record?.home?.isConnected || (selector && record.home.querySelector(selector))) { el.remove(); continue; }
    // Vor den alten Nachbarn, wenn der noch dort steht - sonst ans Ende (er
    // war der letzte, oder er ist selbst gerade umgezogen).
    record.home.insertBefore(el, record.next?.parentElement === record.home ? record.next : null);
  }
  // Je Ziel in Planreihenfolge; ein Ziel, das schon stimmt, bleibt unberuehrt
  // (ein Umhaengen nimmt einem fokussierten Knopf den Fokus).
  for (const target of new Set(wanted.values())) {
    const order = [...wanted].filter(([, t]) => t === target).map(([el]) => el);
    const inPlace = order.every((el, i) => target.children[i] === el) && target.children.length === order.length;
    if (inPlace) continue;
    for (const el of order) {
      if (!homes.has(el)) {
        const selector = Object.values(HOIST_PARTS).find((sel) => el.matches?.(sel));
        homes.set(el, { home: el.parentElement, next: el.nextSibling, selector });
      }
      target.appendChild(el);
    }
  }
}
