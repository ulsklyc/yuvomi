/**
 * Modul: User Multi-Select
 * Zweck: Wiederverwendbare Mehrfachauswahl-Komponente für Benutzer (Tasks & Kalender)
 * Abhängigkeiten: public/utils/html.js, public/i18n.js
 */

import { esc } from '/utils/html.js';
import { t } from '/i18n.js';
import { getReadableTextColor } from '/utils/color.js';

/**
 * Rendert einen Avatar-Stack für mehrere zugewiesene Benutzer.
 * @param {Array<{id, display_name, color}>} users
 * @param {object} opts
 * @param {number} [opts.size=28]      Avatar-Größe in px
 * @param {number} [opts.maxVisible=3] Maximale Avatare vor "+N"-Anzeige
 * @returns {string} HTML-String
 */
export function renderAvatarStack(users, { size = 28, maxVisible = 3 } = {}) {
  if (!users?.length) return '';
  const visible = users.slice(0, maxVisible);
  const overflow = users.length - visible.length;
  const fs = Math.round(size * 0.4);
  const avatars = visible.map((u) => {
    const initials = (u.display_name ?? '')
      .split(' ')
      .map((w) => w[0] ?? '')
      .join('')
      .toUpperCase()
      .slice(0, 2);
    const inner = u.avatar_data
      ? `<img src="${esc(u.avatar_data)}" alt="${esc(u.display_name ?? '')}" loading="lazy">`
      : esc(initials);
    return `<span class="avatar-stack__item"
      style="width:${size}px;height:${size}px;font-size:${fs}px;background-color:${esc(u.color ?? '#8E8E93')};color:${getReadableTextColor(u.color ?? '#8E8E93')}"
      title="${esc(u.display_name ?? '')}">
      ${inner}
    </span>`;
  });
  if (overflow > 0) {
    avatars.push(`<span class="avatar-stack__item avatar-stack__overflow"
      style="width:${size}px;height:${size}px;font-size:${fs}px"
      title="${overflow} ${t('userMultiSelect.moreUsers')}">+${overflow}</span>`);
  }
  return `<span class="avatar-stack">${avatars.join('')}</span>`;
}

/**
 * Rendert das Multi-Select-Widget als Dropdown-Checkbox-Liste.
 * @param {Array<{id, display_name, avatar_color}>} allUsers  Alle verfügbaren Benutzer
 * @param {number[]} selectedIds                               Bereits ausgewählte IDs
 * @param {string}   inputName                                 Name-Attribut des Widgets
 * @param {string}   labelKey                                  i18n-Schlüssel für das Label
 * @returns {string} HTML-String
 */
export function renderUserMultiSelect(allUsers, selectedIds, inputName, labelKey) {
  const selectedSet = new Set(selectedIds ?? []);
  const items = allUsers.map((u) => {
    const checked = selectedSet.has(u.id) ? 'checked' : '';
    const initials = (u.display_name ?? '')
      .split(' ')
      .map((w) => w[0] ?? '')
      .join('')
      .toUpperCase()
      .slice(0, 2);
    const inner = u.avatar_data
      ? `<img src="${esc(u.avatar_data)}" alt="${esc(u.display_name ?? '')}" loading="lazy">`
      : esc(initials);
    return `
      <label class="user-ms__option">
        <input type="checkbox" class="user-ms__checkbox" value="${u.id}" ${checked}
               data-ms-input="${esc(inputName)}">
        <span class="user-ms__avatar" style="background-color:${esc(u.avatar_color ?? '#8E8E93')};color:${getReadableTextColor(u.avatar_color ?? '#8E8E93')}">
          ${inner}
        </span>
        <span class="user-ms__name">${esc(u.display_name)}</span>
      </label>`;
  });

  const noneLabel = t('userMultiSelect.nobody');
  return `
    <div class="user-ms" data-ms-name="${esc(inputName)}">
      <label class="label">${t(labelKey)}</label>
      <div class="user-ms__options">
        <label class="user-ms__option">
          <input type="checkbox" class="user-ms__checkbox user-ms__none" value=""
                 data-ms-input="${esc(inputName)}" ${selectedSet.size === 0 ? 'checked' : ''}>
          <span class="user-ms__avatar user-ms__avatar--none">–</span>
          <span class="user-ms__name">${noneLabel}</span>
        </label>
        ${items.join('')}
      </div>
    </div>`;
}

/**
 * Liest die ausgewählten User-IDs aus einem gerenderten Multi-Select-Widget.
 * @param {Element} container  DOM-Element, das das Widget enthält
 * @param {string}  inputName  Name-Attribut des Widgets
 * @returns {number[]}
 */
export function getSelectedUserIds(container, inputName) {
  const checkboxes = container.querySelectorAll(
    `[data-ms-input="${CSS.escape(inputName)}"]:not(.user-ms__none):checked`
  );
  return Array.from(checkboxes).map((cb) => Number(cb.value)).filter(Boolean);
}

/**
 * Bindet die Checkbox-Logik:
 * - "Niemand" deselektiert alle anderen
 * - Andere Auswahl deselektiert "Niemand"
 * @param {Element} container
 * @param {string}  inputName
 */
export function bindUserMultiSelect(container, inputName) {
  const widget = container.querySelector(`.user-ms[data-ms-name="${CSS.escape(inputName)}"]`);
  if (!widget) return;

  widget.addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb.matches('.user-ms__checkbox')) return;

    if (cb.classList.contains('user-ms__none') && cb.checked) {
      widget.querySelectorAll('.user-ms__checkbox:not(.user-ms__none)').forEach((c) => { c.checked = false; });
    } else if (!cb.classList.contains('user-ms__none') && cb.checked) {
      const none = widget.querySelector('.user-ms__none');
      if (none) none.checked = false;
    }
  });
}
