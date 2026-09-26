/**
 * Filterknopf "Filter (n)" und Filterblatt - der geteilte Baustein zur
 * Kopfregel mobil (2026-09-26, Regel 3).
 *
 * WARUM GETEILT: Filter-Chipreihen standen in Notizen, Kontakten und Vorrat
 * FEST zwischen Kopf und Scrollport und kosteten dauerhaft 60-65px, die auch
 * der Kopf-Kollaps nicht zurueckholte (A8). Der Kalender hatte die Antwort
 * schon (2026-08-28): EIN Knopf mit der ZAHL der aktiven Filter im Kopf, die
 * Filter selbst beschriftet in einem Blatt. Das war dort lokal gebaut
 * (calendar.js `toolbarHtml`/`openCalendarFilters`, calendar.css); ein zweites
 * Modul haette die dritte Handschrift derselben Sache geschrieben. Die Regeln
 * stehen deshalb in layout.css (global), nicht im Modul-Stylesheet - dieselbe
 * Lehre wie bei `.toggle-row`: eine geteilte Form, deren CSS in einem Modul
 * wohnt, ist nur dort eine Form.
 *
 * WANN KNOPF, WANN CHIPS IM PORT: Der Knopf ist fuer Filter, die man
 * einstellt und stehen laesst (Personen, Status, Gruppierung). Wenige
 * Facetten, die man staendig wechselt (Notiz-Kategorien), duerfen als
 * `.page-chip-row` IM Scrollport bleiben und scrollen weg. Beides zugleich
 * fuer dieselbe Achse ist verboten - zwei Wege zu demselben Filter.
 *
 * Verdrahtung:
 *   const btn = filterButtonHtml({ id: 'tasks-filters', count });
 *   ... bar.insertAdjacentHTML(...); bar.querySelector('#tasks-filters')
 *        .addEventListener('click', () => openFilterSheet({...}));
 *   Nach jeder Aenderung `syncFilterButton(btn, count)` - der Knopf
 *   wird nicht neu gebaut, damit Fokus und Kollaps-Messung stehen bleiben.
 */

import { esc } from '/utils/html.js';
import { t } from '/i18n.js';
import { openModal, closeModal } from '/components/modal.js';

/**
 * @typedef {object} FilterLabels
 * @property {string} title   Sichtbarer Blatt-Titel und `title`-Tooltip, z.B. t('common.filters').
 * @property {string} open    Zugaenglicher Name ohne aktive Filter, z.B. t('common.filtersOpen').
 * @property {(count: number) => string} active  Zugaenglicher Name mit Zaehler,
 *   z.B. `(n) => t('common.filtersActive', { count: n })`.
 * @property {string} [reset] „Alle Filter aufheben".
 */

/**
 * Die geteilten Beschriftungen (`common.filters*`). Ein Modul, das sein Blatt
 * anders nennen muss, reicht eigene Labels herein; sonst diese.
 *
 * @returns {FilterLabels}
 */
export function defaultFilterLabels() {
  return {
    title: t('common.filters'),
    open: t('common.filtersOpen'),
    active: (count) => t('common.filtersActive', { count }),
    reset: t('common.filtersReset'),
  };
}

function accessibleName(count, labels) {
  return count > 0 ? labels.active(count) : labels.open;
}

/**
 * Der Knopf. Icon plus Zaehler-Badge in der EINEN Buttonform (`.btn--icon`).
 *
 * Der Zustand ist eine ZAHL, keine Farbe: lesbar auch dort, wo eine Tönung
 * nicht traegt (Begruendung am Kalender-Vorbild, calendar.css
 * „Filter-Knopf und Filter-Blatt"). `showLabel` zeigt zusaetzlich das Wort -
 * fuer Zeile 2 eines Kopfes, in der Platz ist und das Icon allein fuer
 * Oma Ingrid ein Raetsel waere.
 *
 * @param {object} opts
 * @param {string} opts.id
 * @param {number} [opts.count=0]
 * @param {FilterLabels} [opts.labels=defaultFilterLabels()]
 * @param {boolean} [opts.showLabel=false]
 * @param {string} [opts.className='']
 * @returns {string}
 */
export function filterButtonHtml({ id, count = 0, labels = defaultFilterLabels(), showLabel = false, className = '' }) {
  const n = Math.max(0, Number(count) || 0);
  const cls = [
    'btn',
    showLabel ? 'btn--secondary page-filter-btn--labeled' : 'btn--secondary btn--icon',
    'page-filter-btn',
    n ? 'page-filter-btn--active' : '',
    className,
  ].filter(Boolean).join(' ');
  return `
    <button type="button" class="${esc(cls)}" id="${esc(id)}"
            aria-label="${esc(accessibleName(n, labels))}" title="${esc(labels.title)}"
            aria-haspopup="dialog">
      <i data-lucide="sliders-horizontal" class="icon-md" aria-hidden="true"></i>
      ${showLabel ? `<span class="page-filter-btn__label">${esc(labels.title)}</span>` : ''}
      <span class="page-filter-btn__count" aria-hidden="true"${n ? '' : ' hidden'}>${n || ''}</span>
    </button>`;
}

/**
 * Zieht Zaehler, Aktiv-Klasse und zugaenglichen Namen nach.
 *
 * @param {HTMLElement|null} button
 * @param {number} count
 * @param {FilterLabels} [labels=defaultFilterLabels()]
 */
export function syncFilterButton(button, count, labels = defaultFilterLabels()) {
  if (!button) return;
  const n = Math.max(0, Number(count) || 0);
  button.classList.toggle('page-filter-btn--active', n > 0);
  button.setAttribute('aria-label', accessibleName(n, labels));
  const badge = button.querySelector('.page-filter-btn__count');
  if (badge) {
    badge.hidden = n === 0;
    badge.textContent = n ? String(n) : '';
  }
}

/**
 * Das Blatt: benannte Gruppen, darunter in der Fusszeile „Alle Filter
 * aufheben". Ein ANSICHTSBLATT, kein Formular - jeder Schalter wirkt beim
 * Umlegen sofort (`onChange`), deshalb ohne Speichern-Knopf und ohne
 * „Aenderungen verwerfen?"-Waechter (Begruendung an openCalendarFilters).
 *
 * Gruppen-HTML baut der Aufrufer, fuer Schalter mit `toggleRowHtml()`
 * (settings/components.js), fuer eine Einfachauswahl (Gruppierung) mit dem
 * `.segmented`-Segment. Werte darin sind vom Aufrufer escaped.
 *
 * @param {object} opts
 * @param {string} [opts.title=t('common.filters')]
 * @param {Array<{heading: string, html: string}>} opts.groups
 * @param {string|null} [opts.resetLabel=t('common.filtersReset')]  `null`
 *        laesst die Fusszeile weg.
 * @param {(target: HTMLElement, panel: HTMLElement) => void} [opts.onChange]
 *        `change`-Ereignis aus dem Blatt (Checkbox, Radio, Select).
 * @param {(panel: HTMLElement) => void} [opts.onReset]  Nach dem Aufheben
 *        schliesst das Blatt selbst.
 * @returns {HTMLElement|null} das Panel, fuer weitere Verdrahtung
 */
export function openFilterSheet({
  title = t('common.filters'), groups = [], resetLabel = t('common.filtersReset'), onChange, onReset,
}) {
  const body = groups
    .filter((g) => g && g.html)
    .map((g) => `
      <section class="filter-sheet__group">
        <h3 class="filter-sheet__heading">${esc(g.heading)}</h3>
        ${g.html}
      </section>`)
    .join('');
  const footer = resetLabel ? `
    <div class="modal-panel__footer">
      <button type="button" class="btn btn--secondary" data-filter-sheet-reset>${esc(resetLabel)}</button>
    </div>` : '';
  openModal({
    title,
    content: `<div class="filter-sheet">${body}</div>${footer}`,
    size: 'sm',
    initialFocus: 'none',
    dirtyGuard: false,
  });
  const panel = document.querySelector('#shared-modal-overlay .modal-panel');
  if (!panel) return null;
  if (onChange) {
    panel.addEventListener('change', (e) => {
      if (e.target instanceof HTMLElement) onChange(e.target, panel);
    });
  }
  panel.querySelector('[data-filter-sheet-reset]')?.addEventListener('click', () => {
    onReset?.(panel);
    closeModal({ force: true });
  });
  window.lucide?.createIcons?.({ el: panel });
  return panel;
}
