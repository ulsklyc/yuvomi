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
import { durationToken } from '/utils/ux.js';

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
 * @param {() => (HTMLElement|null)} [opts.anchor]  Der Filterknopf. Mit ihm
 *        haengen die Filter am Zeigergeraet-Desktop als POPOVER am Knopf statt
 *        als Blatt (siehe `filtersAsPopover`). Eine Funktion, weil ein Kopf
 *        seinen Knopf neu bauen darf, waehrend das Popover offen ist.
 * @returns {HTMLElement|null} das Panel, fuer weitere Verdrahtung - in beiden
 *        Formen derselbe Vertrag: `querySelector`, `change`- und
 *        `click`-Ereignisse, `isConnected` solange es offen ist.
 */
export function openFilterSheet({
  title = t('common.filters'), groups = [], resetLabel = t('common.filtersReset'), onChange, onReset, anchor = null,
}) {
  // ZWEI ANGABEN JE GRUPPE (Critique 2026-10-05, R16):
  // - `fold: 'closed' | 'open'` macht die Gruppe zum Aufklapper (<details>),
  //   fuer lange, seltene Achsen. Der Aufrufer oeffnet sie, sobald darin etwas
  //   gewaehlt ist - eine wirkende Wahl steht nie hinter einem Aufklapper.
  // - `variant: 'view'` setzt die Gruppe ab: Ansichtsoptionen (Gruppierung,
  //   „Geplante anzeigen") engen nichts ein und stehen hinter den Filtern.
  const body = groups
    .filter((g) => g && g.html)
    .map((g) => {
      const cls = `filter-sheet__group${g.variant ? ` filter-sheet__group--${esc(g.variant)}` : ''}`;
      if (g.fold) {
        return `
      <details class="${cls} filter-sheet__fold"${g.fold === 'open' ? ' open' : ''}>
        <summary class="filter-sheet__summary">
          <h3 class="filter-sheet__heading">${esc(g.heading)}</h3>
          <i data-lucide="chevron-down" class="icon-md filter-sheet__chevron" aria-hidden="true"></i>
        </summary>
        ${g.html}
      </details>`;
      }
      return `
      <section class="${cls}">
        <h3 class="filter-sheet__heading">${esc(g.heading)}</h3>
        ${g.html}
      </section>`;
    })
    .join('');
  const footer = resetLabel ? `
    <div class="modal-panel__footer">
      <button type="button" class="btn btn--secondary" data-filter-sheet-reset>${esc(resetLabel)}</button>
    </div>` : '';
  const content = `<div class="filter-sheet">${body}</div>${footer}`;
  let panel;
  let close;
  if (typeof anchor === 'function' && filtersAsPopover()) {
    // Ein Klick auf den Knopf bei offenem Popover schliesst es zuerst per
    // Light-Dismiss (pointerdown) - derselbe Klick oeffnete es sonst sofort
    // wieder. So wirkt der Knopf wie ein Umschalter.
    if (Date.now() - popoverClosedAt < 300) return null;
    panel = openFilterPopover({ title, content, anchor });
    close = () => panel.hidePopover?.();
  } else {
    openModal({ title, content, size: 'sm', initialFocus: 'none', dirtyGuard: false });
    panel = document.querySelector('#shared-modal-overlay .modal-panel');
    close = () => closeModal({ force: true });
  }
  if (!panel) return null;
  if (onChange) {
    panel.addEventListener('change', (e) => {
      if (e.target instanceof HTMLElement) onChange(e.target, panel);
    });
  }
  panel.querySelector('[data-filter-sheet-reset]')?.addEventListener('click', () => {
    onReset?.(panel);
    close();
  });
  window.lucide?.createIcons?.({ el: panel });
  return panel;
}

// --------------------------------------------------------
// AM DESKTOP EIN POPOVER AM KNOPF (Critique R17, E13)
//
// Das Blatt ist eine Modal-Schicht: Overlay, Unschaerfe, zentriert. Am Desktop
// verdeckte es genau die Liste, die ein Chip darin live filtert - man stellte
// ein, schloss, sah nach, oeffnete wieder. Ab 1024px haengen die Filter ohne
// Abdunkeln am Filterknopf, die Liste dahinter bleibt sichtbar und bedienbar
// (Light-Dismiss). Schmaler bleibt das Blatt: dort ist der Daumen unten und
// die Liste ohnehin verdeckt.
//
// Das Vokabular ist das des Kalender-Filters (calendar.js,
// `openFiltersPopover`), der diese Form zuerst hatte: natives `popover`
// (Top-Layer, Esc und Light-Dismiss vom Browser), Position per JS wie
// utils/popover-menu.js (rechtsbuendig unter dem Ausloeser, im Fenster
// gehalten), Ein- und Ausgang in layout.css (`.filter-popover`).
// --------------------------------------------------------

const FILTER_POPOVER_QUERY = '(min-width: 1024px)';
const FILTER_POPOVER_ID = 'filter-popover';
let popoverClosedAt = 0;

/** Popover statt Blatt? Nur wo der Browser `popover` kennt und das Fenster breit ist. */
export function filtersAsPopover() {
  if (typeof HTMLElement === 'undefined' || !('popover' in HTMLElement.prototype)) return false;
  return globalThis.window?.matchMedia?.(FILTER_POPOVER_QUERY)?.matches === true;
}

/**
 * Offene Filter-Popover abraeumen - fuer den Seitenwechsel (router.js).
 *
 * Sie haengen an `document.body` und ueberleben den Tausch des Seiteninhalts.
 * Ein Klick auf ein Nav-Ziel schliesst sie per Light-Dismiss, ein Wechsel ohne
 * Zeigerereignis (Zurueck des Browsers, Tastenkuerzel, programmatisch) nicht:
 * das Popover stuende ueber der Zielseite, mit Handlern auf einen abgehaengten
 * Container. Entfernt wird der Knoten selbst, nicht nur `hidePopover()` - der
 * Abbau im `toggle` laeuft erst nach der Ausgangsdauer.
 */
export function dismissFilterPopovers() {
  releaseResize();
  for (const id of [FILTER_POPOVER_ID, 'cal-filters-popover']) {
    document.getElementById(id)?.remove();
  }
}

// Der `resize`-Lauscher des offenen Popovers. Wer den Knoten entfernt, ohne
// dass `toggle` feuert (Seitenwechsel, ein zweites Oeffnen), haengt ihn hier
// ab - sonst hielte das Fenster das abgehaengte Popover samt der alten Seite
// fest, bis jemand zufaellig die Fenstergroesse aendert (#1775, Review).
let resizeHandler = null;
function releaseResize() {
  if (resizeHandler) window.removeEventListener('resize', resizeHandler);
  resizeHandler = null;
}

function openFilterPopover({ title, content, anchor }) {
  releaseResize();
  document.getElementById(FILTER_POPOVER_ID)?.remove();
  const pop = document.createElement('div');
  pop.id = FILTER_POPOVER_ID;
  pop.className = 'filter-popover';
  pop.setAttribute('popover', 'auto');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-labelledby', `${FILTER_POPOVER_ID}-title`);
  pop.insertAdjacentHTML('beforeend',
    `<h2 class="filter-popover__title" id="${FILTER_POPOVER_ID}-title">${esc(title)}</h2>${content}`);
  document.body.appendChild(pop);
  // DER FOKUS GEHT AN DEN KNOPF ZURUECK, und zwar VOR dem Schliessen: nach
  // Esc fiel er sonst aus dem verschwindenden Popover auf den Scrollport,
  // bevor `toggle` ueberhaupt lief. Ein Klick daneben auf ein anderes
  // Bedienelement setzt seinen Fokus danach trotzdem selbst - der
  // Light-Dismiss laeuft auf pointerdown, der Fokus erst mit mousedown.
  pop.addEventListener('beforetoggle', (event) => {
    if (event.newState === 'closed' && pop.contains(document.activeElement)) anchor()?.focus();
  });
  // DAS FENSTER AENDERT SICH, DAS POPOVER ZIEHT MIT (#1775). Platziert wurde
  // es einmal, mit festem `left`/`top`: beim Schmalerziehen oder Drehen aendert
  // das Blatt seine Breite per CSS, sein Ort blieb stehen - am rechten Rand
  // verankert ragte es aus dem Fenster, bis man es schloss und neu oeffnete.
  // Faellt die Breite unter die Schwelle, gibt es diese Form dort gar nicht
  // (darunter ist es das Blatt): dann schliesst es, statt als Popover in einem
  // Fenster zu stehen, das keines mehr zeigt. Der Lauscher geht mit dem
  // Schliessen; `dismissFilterPopovers()` entfernt den Knoten ohne `toggle`
  // und haengt ihn deshalb selbst ab (releaseResize).
  const onResize = () => {
    if (!pop.isConnected) { releaseResize(); return; }
    if (!filtersAsPopover()) { pop.hidePopover(); return; }
    positionFilterPopover(pop, anchor());
  };
  pop.addEventListener('toggle', (event) => {
    const open = event.newState === 'open';
    anchor()?.setAttribute('aria-expanded', String(open));
    if (open) return;
    if (resizeHandler === onResize) releaseResize();
    popoverClosedAt = Date.now();
    // Erst NACH dem Ausgang aus dem Baum (layout.css: --duration-xs, das
    // Popover bleibt per `allow-discrete` so lange im Top-Layer). Ein
    // erneutes Oeffnen davor raeumt den alten Knoten selbst (oben).
    setTimeout(() => pop.remove(), durationToken('--duration-xs', 120) + 40);
  });
  pop.showPopover();
  positionFilterPopover(pop, anchor());
  window.addEventListener('resize', onResize);
  resizeHandler = onResize;
  anchor()?.setAttribute('aria-expanded', 'true');
  // Der Fokus geht INS Popover (Tastatur: Tab laeuft durch die Filter, Esc
  // schliesst); ohne Ziel bleibt er am Knopf.
  pop.querySelector('button, input, summary')?.focus();
  return pop;
}

function positionFilterPopover(pop, anchorEl) {
  if (!anchorEl) return;
  const rect = anchorEl.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const width = pop.offsetWidth || 360;
  const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin);
  const top = rect.bottom + gap;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  pop.style.maxHeight = `${Math.round(window.innerHeight - top - margin)}px`;
  // Es waechst aus der Ecke am Knopf: der Ursprung ist die Stelle des
  // Popovers, unter der die Knopfkante steht - auch wenn das Fenster es von
  // dort weggeschoben hat. Per JS statt als physische Seite im Blatt, die in
  // RTL nicht stimmen muss.
  pop.style.transformOrigin = `${Math.round(Math.min(Math.max(0, rect.right - left), width))}px 0`;
}
