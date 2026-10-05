/**
 * Modul: Personen-Umschalter der Gesundheit - EINE Pille fuer alle Tabs.
 *
 * Herausgeloest aus pages/health.js (Runde 7, D6): das Fasten waehlte die
 * Person bis dahin in einem nativen Vollbreit-Select mit eigenem Label
 * (1156px am Desktop), waehrend jeder andere Gesundheits-Tab diese Pille
 * zeigt. Ein Baustein, damit es bei einer Bauart bleibt.
 */
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

// Geteilter Personen-Umschalter: EIN Knopf mit der aktiven Person statt einer
// Dauer-Pillenzeile (Critique 2026-08-31: 6 Ansichts-Tabs + 4 Personen-Pillen
// = 10 Wahlmoeglichkeiten vor dem ersten Inhalt, mobil eine volle 48px-Zeile).
// Die aktive Person bleibt am Knopf sichtbar (Wiedererkennen statt Erinnern);
// das Menue ist das geteilte popover-menu-Vokabular mit role=menuitemradio -
// dieselbe Bauart wie der Rezepte-Quellenfilter. Ein Haushalt mit nur einer
// sichtbaren Person bekommt keinen Umschalter: die eigene Ansicht ist die
// einzige, und ein Menue mit einem Eintrag waere Chrome ohne Auskunft.
export function personSwitcherMarkup(members, activeId, meId, { menuId, label }) {
  const list = members || [];
  if (list.length <= 1) return '';
  const nameOf = (m) => (m.id === meId
    ? `${m.display_name} · ${t('health.vitals.you')}`
    : m.display_name);
  const dotOf = (m) => `<span class="health-person-chip__dot" aria-hidden="true"
          style="background:${esc(m.avatar_color) || 'var(--module-health)'}"></span>`;
  const active = list.find((m) => m.id === activeId) ?? list[0];
  return `
    <div class="health-person-switcher">
      <button type="button" class="health-person-switcher__trigger popover-menu__trigger"
              popovertarget="${esc(menuId)}" aria-haspopup="menu" aria-expanded="false"
              aria-label="${esc(label)}: ${esc(nameOf(active))}">
        ${dotOf(active)}
        <span class="health-person-switcher__name">${esc(nameOf(active))}</span>
        <i data-lucide="chevron-down" class="icon-sm health-person-switcher__chevron" aria-hidden="true"></i>
      </button>
      <div class="popover-menu" id="${esc(menuId)}" popover role="menu" aria-label="${esc(label)}">
        ${list.map((m) => `
          <button type="button" role="menuitemradio" aria-checked="${m.id === activeId}"
                  class="popover-menu__item" data-person-id="${esc(m.id)}">
            <i data-lucide="check" class="icon-md popover-menu__item-check${m.id === activeId ? '' : ' popover-menu__item-check--hidden'}" aria-hidden="true"></i>
            ${dotOf(m)}
            <span>${esc(nameOf(m))}</span>
          </button>`).join('')}
      </div>
    </div>`;
}

