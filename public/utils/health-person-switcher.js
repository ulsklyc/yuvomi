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
import { initials } from '/utils/initials.js';
import { getReadableTextColor, safeHexColor } from '/utils/color.js';

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
  const colorOf = (m) => safeHexColor(m.avatar_color, null);
  const dotOf = (m) => `<span class="health-person-chip__dot" aria-hidden="true"
          style="background:${colorOf(m) || 'var(--module-health)'}"></span>`;
  // Am Knopf traegt der Punkt die Initialen: im Seitenkopf des Telefons waechst
  // er zum Gesicht (health.css, R23). Ohne Farbe bleibt die Schrift die des
  // Moduls auf seiner Toenung.
  const faceOf = (m) => `<span class="health-person-chip__dot" aria-hidden="true"
          style="background:${colorOf(m) || 'var(--module-health)'}${colorOf(m) ? `;color:${getReadableTextColor(colorOf(m))}` : ''}"><span class="health-person-chip__initials">${esc(initials(m.display_name, '?'))}</span></span>`;
  const active = list.find((m) => m.id === activeId) ?? list[0];
  // „ICH" ZUERST (R24, Critique G5 P3-1): die Mitgliederliste kam in
  // Haushaltsreihenfolge, die eigene Ansicht stand zuletzt - sie ist die,
  // zu der man am haeufigsten zurueckkehrt.
  const ordered = [...list.filter((m) => m.id === meId), ...list.filter((m) => m.id !== meId)];
  return `
    <div class="health-person-switcher">
      <button type="button" class="health-person-switcher__trigger popover-menu__trigger"
              popovertarget="${esc(menuId)}" aria-haspopup="menu" aria-expanded="false"
              aria-label="${esc(label)}: ${esc(nameOf(active))}">
        ${faceOf(active)}
        <span class="health-person-switcher__name">${esc(nameOf(active))}</span>
        <i data-lucide="chevron-down" class="icon-sm health-person-switcher__chevron" aria-hidden="true"></i>
      </button>
      <div class="popover-menu" id="${esc(menuId)}" popover role="menu" aria-label="${esc(label)}">
        ${ordered.map((m) => `
          <button type="button" role="menuitemradio" aria-checked="${m.id === activeId}"
                  class="popover-menu__item" data-person-id="${esc(m.id)}">
            <i data-lucide="check" class="icon-md popover-menu__item-check${m.id === activeId ? '' : ' popover-menu__item-check--hidden'}" aria-hidden="true"></i>
            ${dotOf(m)}
            <span>${esc(nameOf(m))}</span>
          </button>`).join('')}
        ${active.id === meId ? whoSeesItem() : ''}
      </div>
    </div>`;
}

/** Die Adresse der Freigabe-Stelle: die Standard-Sichtbarkeit im Gesundheitsblatt. */
export const WHO_SEES_HREF = '/settings/modules/health?option=settings.healthVisibilityTitle';

/**
 * "WER SIEHT DAS?" AN DER PERSONENWAHL (Critique R21, D7; a5 P2). Freigaben
 * standen drei Tipps tief in den Einstellungen, ohne einen Weg aus der
 * Gesundheit - wer hier eintraegt, fragt sich genau an dieser Stelle, wer es
 * zu sehen bekommt. Nur in der EIGENEN Ansicht: die Frage gilt den eigenen
 * Eintraegen, und die Standard-Sichtbarkeit ist die eigene. Ein echter Link
 * (Mittelklick, Adresse kopieren); `wireWhoSees` faengt den Klick fuer die App.
 */
function whoSeesItem() {
  return `
        <div class="popover-menu__separator" role="separator"></div>
        <a role="menuitem" class="popover-menu__item health-person-switcher__who" href="${WHO_SEES_HREF}" data-health-who>
          <i data-lucide="eye" class="icon-md" aria-hidden="true"></i>
          <span>${esc(t('health.whoSees'))}</span>
        </a>`;
}

/** Faengt den Klick auf "Wer sieht das?" ab: Navigation in der App statt Neuladen. */
export function wireWhoSees(root) {
  root?.querySelector('[data-health-who]')?.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
    event.preventDefault();
    globalThis.window?.yuvomi?.navigate?.(WHO_SEES_HREF);
  });
}

