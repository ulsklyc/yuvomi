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
 * Jetzt zieht die Pille in den Seitenkopf, ohne eigene Zeile - und seit R23
 * IMMER DORTHIN (Critique G5 P2 "Personenwahl an drei Orten"). Sie stand im
 * Detailkopf (Desktop), in der Zeile „‹ Gesundheit" (schmal im Bereich) und im
 * Streifen vor der Bereichsliste (Telefon-Uebersicht); der Bereichskopf war
 * dafuer zweizeilig, und der Tipp in einen Bereich hob ihn von 65 auf 113px
 * (Layout-Shift 0,97). Eine Personenwahl je Sitzung (D4) hat jetzt EINEN Ort:
 * rechts in der Titelzeile, auf der Uebersicht wie in jedem Bereich, am
 * Telefon als Gesicht (health.css). Auf der Telefon-Uebersicht stehen
 * weiterhin der Hinweis auf die fremde Ansicht, der Satz, „Heute faellig" und
 * „Bei Bedarf" (R24) VOR der Bereichsliste - das, was man heute tut, vor dem,
 * wohin man geht.
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
  // Der Satz der Uebersicht (R21, D6) steht vor "Heute faellig".
  brief: '.health-brief',
  due: '.health-overview__card--due',
  // "Bei Bedarf" steht neben "Heute faellig" (R24, Critique G5 P2-7): beides
  // ist, was man heute einnimmt - vorher lag es mobil in der Falte unter der
  // Bereichsliste. "Schnell erfassen" ist weg (E9: der FAB traegt das Menue).
  prn: '.health-overview__card--prn',
};

/**
 * Wohin was gehoert - reine Entscheidung, ohne DOM.
 * @param {{ split: boolean, overview: boolean, phone: boolean }} s
 * @returns {Array<{ part: keyof HOIST_PARTS, slot: 'toolbar'|'priority' }>}
 */
export function hoistPlan({ split, overview, phone }) {
  const person = [{ part: 'person', slot: 'toolbar' }];
  if (split || !overview || !phone) return person;
  return [...person, ...['banner', 'brief', 'due', 'prn'].map((part) => ({ part, slot: 'priority' }))];
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
 * Den Plan anwenden. `slots` nennt die Ziele ({ toolbar, priority }),
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
