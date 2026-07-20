import { wireScrollFade } from '/utils/ux.js';

/**
 * Modul: Tablist-Verhalten — geteilte WAI-ARIA-Tab-Navigation
 *
 * EINE Verhaltens-Quelle (Klick + Pfeiltasten/Home/End + Roving-Tabindex + ARIA)
 * für modul-eigene Tab-Leisten, die aus Layout-Gründen NICHT die volle
 * `sub-tabs-bar`-Struktur (renderSubTabs) nutzen, sondern ihre Tabs im
 * kanonischen `page-toolbar`-Kopf tragen (rewards, housekeeping, …).
 *
 * `renderSubTabs` bleibt die Variante für eigenständige sticky Sub-Tab-Leisten
 * (health, kitchen, settings); `wireTablist` ist die Verhaltens-Variante für
 * bereits im Markup vorhandene Tab-Buttons. So teilen beide dieselbe
 * Interaktions-Grammatik, ohne dass ein Modul die Tastatur-Navigation erneut
 * von Hand nachbaut.
 *
 * Erwartetes Markup:
 *   - Container: role="tablist"
 *   - Buttons:   role="tab", data-tab-id="<id>"
 * Der Helper setzt aria-selected, aria-current, tabindex und die aktive Klasse
 * und ruft onChange(id) beim Wechsel.
 *
 * @param {HTMLElement} container            - die Tablist (role="tablist")
 * @param {object}      opts
 * @param {string}      opts.activeId         - initial aktive Tab-id
 * @param {Function}    opts.onChange         - onChange(id) beim Wechsel
 * @param {string}      [opts.activeClass='sub-tab--active']
 * @returns {{ setActive: (id: string, opts?: { focus?: boolean }) => void }}
 */
export function wireTablist(container, { activeId, onChange, activeClass = 'sub-tab--active' } = {}) {
  if (!container) return { setActive() {} };
  let current = activeId;

  const buttons = () => [...container.querySelectorAll('[data-tab-id]')];

  const paint = () => {
    let activeBtn = null;
    buttons().forEach((b) => {
      const on = b.dataset.tabId === current;
      b.classList.toggle(activeClass, on);
      b.setAttribute('aria-selected', String(on));
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      b.tabIndex = on ? 0 : -1;
      if (on) activeBtn = b;
    });
    // Überlaufende Leisten (Mobil): der aktive Tab muss im sichtbaren
    // Scroll-Bereich liegen (Audit A2-18). block:'nearest' lässt den
    // vertikalen Seiten-Scroll in Ruhe.
    activeBtn?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  };

  const setActive = (id, { focus = false } = {}) => {
    if (!id || id === current) return;
    current = id;
    paint();
    if (focus) buttons().find((b) => b.dataset.tabId === id)?.focus();
    onChange?.(id);
  };

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab-id]');
    if (btn) setActive(btn.dataset.tabId);
  });

  container.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const b = buttons();
    if (!b.length) return;
    const focusedIndex = b.indexOf(document.activeElement);
    const currentIndex = Math.max(0, b.findIndex((x) => x.dataset.tabId === current));
    const index = focusedIndex >= 0 ? focusedIndex : currentIndex;
    let next = index;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % b.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + b.length) % b.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = b.length - 1;
    e.preventDefault();
    setActive(b[next]?.dataset.tabId, { focus: true });
  });

  // Aktiven Tab extern synchronisieren (ohne onChange) — für Zustandswechsel,
  // die NICHT über die Leiste ausgelöst werden (z. B. Kalender: Klick auf einen
  // Tag wechselt in die Tagesansicht).
  const sync = (id) => { current = id; paint(); };

  // Scroll-Affordanz für überlaufende Leisten: geteilte has-fade-Masken
  // (filter-chip.css) auf jeder wireTablist-Leiste, nicht nur im Budget.
  wireScrollFade(container);

  paint(); // initiale Roving-Tabindex/ARIA-Zustände setzen
  return { setActive, sync };
}
