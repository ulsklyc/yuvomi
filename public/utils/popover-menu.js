/**
 * Geteiltes Überlaufmenü über die native Popover-API.
 *
 * WARUM GETEILT: Der Kopf der Einkaufsliste trug mobil fünf Bedienelemente in
 * 173px Höhe, drei davon unbeschriftete Icons - darunter „Liste löschen" für die
 * Liste des ganzen Haushalts (Critique 2026-07-30). Ein Überlaufmenü löst beides
 * auf einmal: eine Zeile Chrome statt drei, und jeder Eintrag trägt sein Label.
 *
 * WARUM HIER UND NICHT IN shopping.js: Kontakte (`.contact-more-menu__panel`)
 * und Dokumente (`.documents-context-menu`) haben je eine private Kopie derselben
 * Sache - gleiche Popover-Mechanik, gleiche Positionierungsrechnung, gleiche
 * Eintrags-Geometrie, drei Klassennamen. Eine dritte Kopie in der Küche wäre
 * genau der Befund, den dieser Umbau abstellt („inkonsistentes
 * Komponenten-Vokabular"). Die beiden Bestandskopien sind hier bewusst NICHT
 * mitmigriert: das sind zwei fremde Module, und der Auftrag ist die Küche. Wer
 * sie nachzieht, löscht rund 60 Zeilen CSS und diese Datei bleibt unverändert.
 *
 * WARUM NATIVE POPOVER UND KEIN EIGENES OVERLAY: Top-Layer, Light-Dismiss (Klick
 * daneben) und Esc kommen vom Browser, inklusive Fokusrückgabe an den Trigger.
 * Ein Eigenbau müsste all das nachbauen - und der Focus-Trap des Modals in diesem
 * Repo ist der Beweis, wie viel daran hängt.
 *
 * WARUM DIE POSITION PER JS: `position: fixed` im Top-Layer kennt den Trigger
 * nicht. CSS-Anchor-Positioning (`anchor-name`/`position-anchor`) wäre der
 * richtige Weg, ist aber in Safari noch nicht überall da - und dieses Projekt
 * hat mit WebKit schon zwei Layout-Bugs bezahlt (siehe overflow:clip in
 * shopping.css). Die Rechnung unten ist dieselbe wie in contacts.js.
 */

import { esc } from '/utils/html.js';

/**
 * Baut Trigger und Panel als HTML-String.
 *
 * Die Einträge tragen `data-action`, also genau die Attribute, die der
 * delegierte Klick-Handler der Seite schon kennt: das Menü braucht keine eigene
 * Verdrahtung, es ist eine zweite Darstellung derselben Aktionen.
 *
 * @param {object}   opts
 * @param {string}   opts.id             Eindeutige Panel-ID (popovertarget).
 * @param {string}   opts.label          Zugänglicher Name des Triggers.
 * @param {Array<{action: string, label: string, icon: string, id?: string|number, danger?: boolean,
 *   checked?: boolean, disabled?: boolean} | {separator: true}>} opts.items
 *        `checked` macht aus dem Eintrag einen Schalter (`menuitemcheckbox`,
 *        Haken am Ende) - fuer Ansichts-Schalter wie „Verlauf zeigen", die im
 *        Werkzeugmenue stehen statt als loses Icon im Kopf. `{ separator: true }`
 *        trennt Gruppen (Ansicht | Verwalten | Destruktiv).
 * @param {string}   [opts.triggerClass] Zusätzliche Klassen für den Trigger.
 * @param {string}   [opts.icon]         Lucide-Name für den Trigger. Standard
 *        `ellipsis` - das Überlaufmenü, für das diese Datei gebaut wurde. Ein
 *        anderer Name ist für ein Menü gedacht, das nicht „mehr davon" heißt,
 *        sondern eine bestimmte Frage stellt (die Personenauswahl beim Abhaken,
 *        #1205); dort wäre das Auslassungszeichen eine Falschauskunft.
 * @returns {string}
 */
export function popoverMenuHtml({ id, label, items = [], triggerClass = 'btn btn--ghost btn--icon', icon = 'ellipsis' }) {
  const entries = items.map((item) => {
    if (item.separator) return '\n    <div class="popover-menu__separator" role="separator"></div>';
    const checkable = typeof item.checked === 'boolean';
    const role = checkable ? 'menuitemcheckbox' : 'menuitem';
    const checkedAttr = checkable ? ` aria-checked="${item.checked}"` : '';
    const trail = checkable
      ? `<i data-lucide="check" class="icon-md popover-menu__item-trail popover-menu__item-check${item.checked ? '' : ' popover-menu__item-check--hidden'}" aria-hidden="true"></i>`
      : '';
    return `
    <button type="button" role="${role}"${checkedAttr}${item.disabled ? ' disabled' : ''}
            class="popover-menu__item${item.danger ? ' popover-menu__item--danger' : ''}"
            data-action="${esc(item.action)}"${item.id == null ? '' : ` data-id="${esc(String(item.id))}"`}>
      <i data-lucide="${esc(item.icon)}" class="icon-md" aria-hidden="true"></i>
      <span>${esc(item.label)}</span>${trail}
    </button>`;
  }).join('');

  return `
    <button type="button" class="${triggerClass} popover-menu__trigger"
            popovertarget="${esc(id)}" aria-haspopup="menu" aria-expanded="false"
            aria-label="${esc(label)}" title="${esc(label)}">
      <i data-lucide="${esc(icon)}" class="icon-md" aria-hidden="true"></i>
    </button>
    <div class="popover-menu" id="${esc(id)}" popover role="menu">${entries}</div>`;
}

/**
 * Das EINE Werkzeugmenue eines Modulkopfs (Kopfregel mobil, 2026-09-26).
 *
 * Zeile 1 eines Modulkopfs traegt Titel, Such-Icon und genau EINEN
 * „..."-Knopf; alles, was ein Modul verwaltet statt zeigt (Kategorien, Tags,
 * Lagerorte, Mehrfachauswahl, Import, Verlauf, „Plan zufaellig fuellen"),
 * steht darin als Eintrag mit Icon UND Text - nie als loses Icon daneben.
 * Vorbild ist das Kopf-Menue der Dokumente (`documents-tools-btn`).
 *
 * Der Trigger ist ein `.btn--secondary.btn--icon` wie dort, mit der
 * Kennklasse `page-tools-btn`: an ihr erkennt der Guard (test:mobile-chrome)
 * das Werkzeugmenue, und die Shell muss ihn nicht per Modulname suchen.
 * Verdrahtung wie jedes popover-menu: `installPopoverMenus(root)` einmal an
 * der Modulwurzel, die Klicks laufen ueber `data-action` in den delegierten
 * Handler der Seite. Einen Schalter (`checked`) zieht die Seite nach dem
 * Umlegen per `syncPopoverMenuItem()` nach, ohne das Menue neu zu bauen.
 *
 * @param {object} opts
 * @param {string} opts.id     Eindeutige Panel-ID, z.B. `tasks-tools-menu`.
 * @param {string} opts.label  Zugaenglicher Name, meist t('common.moreActions').
 * @param {Array}  opts.items  Eintraege wie bei popoverMenuHtml.
 * @returns {string}
 */
export function pageToolsMenuHtml({ id, label, items = [] }) {
  return popoverMenuHtml({
    id,
    label,
    items,
    triggerClass: 'btn btn--secondary btn--icon page-tools-btn',
    icon: 'ellipsis',
  });
}

/**
 * Zieht Haken und `aria-checked` eines Schalter-Eintrags nach.
 *
 * @param {ParentNode} root
 * @param {string} action   Der `data-action`-Wert des Eintrags.
 * @param {boolean} checked
 */
export function syncPopoverMenuItem(root, action, checked) {
  const item = root?.querySelector?.(`.popover-menu__item[data-action="${CSS.escape(action)}"]`);
  if (!item) return;
  item.setAttribute('aria-checked', String(Boolean(checked)));
  item.querySelector('.popover-menu__item-check')
    ?.classList.toggle('popover-menu__item-check--hidden', !checked);
}

/** Verhindert das Aufblitzen an der Standardposition, bevor die Rechnung greift. */
function onBeforeToggle(event) {
  const panel = event.target;
  if (!(panel instanceof HTMLElement) || !panel.matches('.popover-menu')) return;
  if (event.newState === 'open') panel.style.opacity = '0';
}

function onToggle(event) {
  const panel = event.target;
  if (!(panel instanceof HTMLElement) || !panel.matches('.popover-menu')) return;

  // `aria-expanded` gehoert dem Trigger, und die Popover-API pflegt es nicht:
  // sie kennt nur `popovertarget`, kein ARIA. Ohne diese Zeile meldet der
  // Screenreader ein Menue, das nie aufgeht.
  const trigger = document.querySelector(`[popovertarget="${panel.id}"]`);
  trigger?.setAttribute('aria-expanded', String(event.newState === 'open'));

  if (event.newState !== 'open') { panel.style.opacity = ''; return; }

  if (trigger) {
    const rect = trigger.getBoundingClientRect();
    const width = panel.offsetWidth || 200;
    const height = panel.offsetHeight || 48;
    const gap = 4;
    // Rechtskante am Trigger, aber niemals außerhalb des Viewports.
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    let top = rect.bottom + gap;
    // Nach oben kippen, wenn unten kein Platz ist - der Kopf der Einkaufsliste
    // sitzt oben, das Zeilenmenü kann überall stehen.
    if (top + height > window.innerHeight - 8) top = rect.top - height - gap;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(Math.max(8, top))}px`;
  }
  panel.style.opacity = '1';

  // DER FOKUS ZIEHT MIT INS MENUE. `role="menu"` sagt der assistiven Technik
  // eine Menue-Bedienung zu, und die Popover-API haelt davon nichts: sie
  // oeffnet das Panel im Top-Layer und laesst den Fokus am Trigger stehen. Wer
  // per Tastatur oeffnet, stuende sonst vor einer Liste, die er nur mit Tab
  // erreicht - und in einem Menue fuehrt Tab hinaus, nicht hindurch.
  const items = itemsOf(panel);
  if (!items.length) return;
  // Nur eine EINFACHAUSWAHL zieht den Fokus auf ihren gewaehlten Eintrag -
  // bei Schaltern (menuitemcheckbox) waere der erste angehakte eine
  // zufaellige Stelle mitten im Menue.
  const checked = items.findIndex((item) => item.getAttribute('role') !== 'menuitemcheckbox'
    && item.getAttribute('aria-checked') === 'true');
  focusItem(items, checked === -1 ? 0 : checked);
}

/** Die bedienbaren Eintraege eines Panels in DOM-Reihenfolge. */
function itemsOf(panel) {
  return [...panel.querySelectorAll('.popover-menu__item:not([disabled])')];
}

/**
 * Roving Tabindex: im Menue fuehren die Pfeiltasten, Tab fuehrt hinaus.
 *
 * Ohne das traegt jeder Eintrag seinen Button-Standard `tabindex=0`, und ein
 * Sechs-Personen-Menue kostet sechs Tabs zum Verlassen - das Gegenteil dessen,
 * was `role="menu"` ankuendigt.
 */
function focusItem(items, index) {
  const target = items[(index + items.length) % items.length];
  for (const item of items) item.tabIndex = item === target ? 0 : -1;
  target.focus();
}

/**
 * Pfeiltasten, Home und End - die Menue-Bedienung aus der ARIA-Praxis.
 *
 * WARUM HIER UND NICHT JE SEITE: Der Personen-Umschalter der Gesundheit war
 * bis 2026-08-31 ein `role="tablist"` und bekam seine Pfeiltasten von
 * `wireTablistKeys`. Als Menue erbte er die Rollen - aber keine Bedienung, und
 * das fiel erst im Review auf. Rezepte-Quellenfilter und Einkaufs-Ueberlaufmenue
 * hatten dieselbe Luecke laenger. Ein geteiltes Vokabular, das nur das Aussehen
 * teilt, verteilt den Fehler, statt ihn zu loesen.
 */
function onKeydown(event) {
  const panel = event.target?.closest?.('.popover-menu');
  if (!panel) return;
  const items = itemsOf(panel);
  if (!items.length) return;

  const current = items.indexOf(event.target.closest('.popover-menu__item'));
  const next = {
    ArrowDown: current + 1,
    ArrowUp: current === -1 ? items.length - 1 : current - 1,
    Home: 0,
    End: items.length - 1,
  }[event.key];
  if (next === undefined) return;

  event.preventDefault();
  focusItem(items, next);
}

/**
 * Ein Klick auf einen Eintrag schließt das Menü.
 *
 * Capture-Phase, damit das Panel zu ist, bevor der delegierte Handler der Seite
 * einen Dialog öffnet - zwei Elemente im Top-Layer streiten sich sonst um
 * Light-Dismiss und Esc. Der Knoten bleibt dabei im DOM (Popover blendet nur
 * aus), `closest('[data-action]')` findet ihn in der Bubble-Phase also weiter.
 */
function onItemClick(event) {
  const item = event.target?.closest?.('.popover-menu__item');
  if (!item) return;
  item.closest('.popover-menu')?.hidePopover?.();
}

/**
 * Verdrahtet Positionierung und Schließen an einer stabilen Wurzel.
 *
 * `toggle` und `beforetoggle` steigen NICHT auf; sie erreichen einen Vorfahren
 * nur in der Capture-Phase. Genau daran hing der erste Versuch in contacts.js.
 *
 * Idempotent über ein data-Attribut: die Wurzel überlebt Re-Renders, der
 * Listener darf nicht mehrfach hängen.
 *
 * @param {HTMLElement} root
 */
export function installPopoverMenus(root) {
  if (!root || root.dataset.popoverMenus) return;
  root.dataset.popoverMenus = 'true';
  root.addEventListener('beforetoggle', onBeforeToggle, { capture: true });
  root.addEventListener('toggle', onToggle, { capture: true });
  root.addEventListener('click', onItemClick, { capture: true });
  root.addEventListener('keydown', onKeydown);
}
