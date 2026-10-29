/**
 * DER GEPINNTE EINTRAG DER SEITENLEISTE - EINMAL, AUCH NACH DEM NEUAUFBAU (#2324).
 *
 * Die Einstellungen stehen nicht im Scroller `.nav-sidebar__items`, sondern als
 * Geschwister dahinter in der Sidebar-Spalte (Critique 2026-08-10, router.js
 * `renderAppShell`): was nicht im Scroller liegt, scrollt nicht weg.
 *
 * `renderAppShell()` hob den Eintrag deshalb aus der Liste heraus.
 * `rebuildNavigation()` (Modul-Schalter, Sprache, Kontowechsel) tat es nicht:
 * es legte ALLE Elemente in den Scroller, auch den gepinnten - und der alte
 * Geschwister-Eintrag blieb stehen. Gemeldet als „Einstellungen erscheint
 * doppelt", sobald jemand ein Modul an- oder abschaltet.
 *
 * Beide Wege laufen jetzt hier durch. Die Funktion ist idempotent: wie oft
 * sie auch laeuft, danach steht jeder gepinnte Eintrag genau einmal hinter dem
 * Scroller, und der Scroller haelt nur die Liste.
 */

export const PINNED_CLASS = 'nav-item--pinned-end';

function isPinned(el) {
  return Boolean(el?.classList?.contains(PINNED_CLASS));
}

/**
 * Teilt die gebauten Nav-Elemente in Liste und gepinnte Eintraege.
 * @param {Element[]} elements
 * @returns {{ listed: Element[], pinned: Element[] }}
 */
export function splitPinnedNavItems(elements) {
  const listed = [];
  const pinned = [];
  for (const el of elements) (isPinned(el) ? pinned : listed).push(el);
  return { listed, pinned };
}

/**
 * Setzt die Liste in den Scroller und die gepinnten Eintraege direkt dahinter;
 * gepinnte Eintraege eines frueheren Aufbaus in der Spalte fallen weg.
 *
 * @param {Element} scroller  `.nav-sidebar__items`
 * @param {Element[]} elements  Ergebnis von `sidebarNavItems()`
 */
export function placeSidebarNavItems(scroller, elements) {
  const { listed, pinned } = splitPinnedNavItems(elements);
  scroller.replaceChildren(...listed);
  const column = scroller.parentElement;
  if (!column) return;
  for (const stale of [...column.children]) {
    if (stale !== scroller && isPinned(stale)) stale.remove();
  }
  scroller.after(...pinned);
}
