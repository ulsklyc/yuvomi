/**
 * Geteiltes Überlaufmenü über die native Popover-API.
 *
 * WARUM GETEILT: Der Kopf der Einkaufsliste trug mobil fünf Bedienelemente in
 * 173px Höhe, drei davon unbeschriftete Icons - darunter „Liste löschen" für die
 * Liste des ganzen Haushalts (Critique 2026-07-30). Ein Überlaufmenü löst beides
 * auf einmal: eine Zeile Chrome statt drei, und jeder Eintrag trägt sein Label.
 *
 * WARUM HIER UND NICHT IN shopping.js: Kontakte und Dokumente
 * (`.documents-context-menu`) hatten je eine private Kopie derselben Sache -
 * gleiche Popover-Mechanik, gleiche Positionierungsrechnung, gleiche
 * Eintrags-Geometrie, drei Klassennamen. Eine dritte Kopie in der Küche wäre
 * genau der Befund, den dieser Umbau abstellt („inkonsistentes
 * Komponenten-Vokabular"). Die Kontakte nutzen seit R16 (Re-Critique
 * 2026-09-28) dieses Menü; die Kopie der Dokumente steht noch. Wer sie
 * nachzieht, löscht dort das CSS, und diese Datei bleibt unverändert.
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
 *   checked?: boolean, disabled?: boolean, attrs?: Record<string, string|number|boolean|null>}
 *   | {separator: true} | {group: string, items: Array}>} opts.items
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
/**
 * Weitere Attribute eines Eintrags (`data-from`, `data-loan-id` ...), escaped.
 * Ein Zeilenmenue ist eine zweite Darstellung der Knoepfe, die vorher in der
 * Zeile standen - der delegierte Handler liest dieselben Attribute am Eintrag,
 * die er am Knopf las. `role`, `class` und `data-action` gehoeren dem Menue.
 */
function itemAttrs(attrs) {
  if (!attrs) return '';
  return Object.entries(attrs)
    .filter(([name, value]) => value !== false && value != null && !/^(?:role|class|type|data-action)$/.test(name))
    .map(([name, value]) => (value === true ? ` ${esc(name)}` : ` ${esc(name)}="${esc(String(value))}"`))
    .join('');
}

export function popoverMenuHtml({ id, label, items = [], triggerClass = 'btn btn--ghost btn--icon', icon = 'ellipsis' }) {
  const entry = (item, index) => {
    if (item.separator) return '\n    <div class="popover-menu__separator" role="separator"></div>';
    // EINE GRUPPE MIT NAMEN (Critique 2026-10-05, R16): `{ group, items }`.
    // Die Ueberschrift ist kein Eintrag - sie traegt die Eintragsklasse nicht
    // und faellt damit aus Pfeiltasten und Fokus -, die Gruppe verweist per
    // `aria-labelledby` auf sie (dasselbe Vokabular wie das Sortier-Menue der
    // Dokumente, layout.css `.popover-menu__group`).
    if (item.group) {
      const labelId = `${id}-group-${index}`;
      return `
    <div class="popover-menu__group" role="group" aria-labelledby="${esc(labelId)}">
      <div class="popover-menu__label" id="${esc(labelId)}">${esc(item.group)}</div>${(item.items ?? []).map(entry).join('')}
    </div>`;
    }
    const checkable = typeof item.checked === 'boolean';
    const role = checkable ? 'menuitemcheckbox' : 'menuitem';
    const checkedAttr = checkable ? ` aria-checked="${item.checked}"` : '';
    const trail = checkable
      ? `<i data-lucide="check" class="icon-md popover-menu__item-trail popover-menu__item-check${item.checked ? '' : ' popover-menu__item-check--hidden'}" aria-hidden="true"></i>`
      : '';
    return `
    <button type="button" role="${role}"${checkedAttr}${item.disabled ? ' disabled' : ''}
            class="popover-menu__item${item.danger ? ' popover-menu__item--danger' : ''}"
            data-action="${esc(item.action)}"${item.id == null ? '' : ` data-id="${esc(String(item.id))}"`}${itemAttrs(item.attrs)}>
      <i data-lucide="${esc(item.icon)}" class="icon-md" aria-hidden="true"></i>
      <span>${esc(item.label)}</span>${trail}
    </button>`;
  };
  const entries = items.map(entry).join('');

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
  // EIN EINTRAG IST EIN KNOPF, KEIN MENUE (Critique 2026-10-05, R16; DESIGN.md
  // Kopfregel). Der Vorrat fuehrte "..." mit genau einem Eintrag ("Lagerorte
  // verwalten"): zwei Tipps und ein Auslassungszeichen fuer eine Handlung.
  // Ein Menue beginnt bei zwei Eintraegen; darunter steht die Handlung selbst
  // im Kopf - mit ihrem Icon, ihrem Namen als aria-label/title und demselben
  // `data-action`, auf das der delegierte Handler der Seite schon hoert. Ein
  // Schalter (`checked`) bleibt im Menue: sein Zustand braucht den Haken.
  const real = items.flatMap((item) => (item?.group ? item.items ?? [] : [item])).filter((item) => item && !item.separator);
  if (real.length === 1 && typeof real[0].checked !== 'boolean') {
    const [item] = real;
    return `
    <button type="button" class="btn btn--secondary btn--icon page-tools-btn page-tools-btn--direct"
            data-action="${esc(item.action)}"${item.id == null ? '' : ` data-id="${esc(String(item.id))}"`}${item.disabled ? ' disabled' : ''}
            aria-label="${esc(item.label)}" title="${esc(item.label)}">
      <i data-lucide="${esc(item.icon)}" class="icon-md" aria-hidden="true"></i>
    </button>`;
  }
  return popoverMenuHtml({
    id,
    label,
    items,
    triggerClass: 'btn btn--secondary btn--icon page-tools-btn',
    icon: 'ellipsis',
  });
}

/**
 * Das Werkzeug des Kopfs, auf das geklickt wurde - in BEIDEN Bauarten.
 *
 * `pageToolsMenuHtml` baut einen einzelnen Eintrag als direkten Knopf
 * (`.page-tools-btn--direct`) und erst ab zweien ein Menue
 * (`.popover-menu__item`). Ein Handler, der nur den Eintrag fragt, laesst den
 * Knopf stumm: so standen "Kategorien verwalten" (Notizen) und "Aus Kontakten
 * importieren" (Geburtstage) im Kopf und taten nichts. Wie viele Eintraege ein
 * Menue hat, weiss der Handler nicht - Rechte koennen es kuerzen -, also fragt
 * er immer beide.
 *
 * @param {EventTarget|null} target  `event.target` des delegierten Klicks.
 * @param {string} [action]          `data-action`; ohne ihn jedes Werkzeug.
 * @returns {HTMLElement|null}
 */
export function pageToolsActionEl(target, action) {
  if (typeof target?.closest !== 'function') return null;
  const attr = action ? `[data-action="${action}"]` : '[data-action]';
  return target.closest(`.popover-menu__item${attr}, .page-tools-btn--direct${attr}`) ?? null;
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
  if (event.newState === 'open') { panel.style.opacity = '0'; return; }
  // SCHLIESSEN: die Inline-Werte gehen JETZT, nicht erst im `toggle` danach.
  // Der Ausgang (layout.css: `overlay`/`display` diskret, Blende, Schrumpfen)
  // beginnt mit dem Schliessen; blieben Deckkraft und Groesse bis zum spaeter
  // zugestellten `toggle` inline stehen, liefe die Uhr des Ausgangs schon,
  // waehrend das Panel noch in voller Deckung stuende.
  panel.style.opacity = '';
  panel.style.transform = '';
}

/**
 * Der Ausloeser eines Menues. EIN Menue darf ZWEI Ausloeser haben, von denen
 * je Breite einer steht (Aufteilung, R17: das Gruppen-Werkzeug im Gruppenkopf
 * am Desktop, in der Salden-Zeile am Telefon) - `popovertarget` erlaubt das,
 * und ids im Menue blieben so einmalig. Gemeint ist dann der SICHTBARE: am
 * ersten Treffer im Dokument richtete sich das Menue sonst an einem
 * verborgenen Knopf aus (Rechteck 0/0) und meldete dort seinen Zustand.
 */
function triggerOf(id) {
  const selector = `[popovertarget="${id}"]`;
  const all = typeof document.querySelectorAll === 'function' ? [...document.querySelectorAll(selector)] : [];
  if (all.length < 2) return all[0] ?? document.querySelector(selector);
  return all.find((el) => (typeof el.getClientRects === 'function' ? el.getClientRects().length > 0 : false)) ?? all[0];
}

function onToggle(event) {
  const panel = event.target;
  if (!(panel instanceof HTMLElement) || !panel.matches('.popover-menu')) return;

  // `aria-expanded` gehoert dem Trigger, und die Popover-API pflegt es nicht:
  // sie kennt nur `popovertarget`, kein ARIA. Ohne diese Zeile meldet der
  // Screenreader ein Menue, das nie aufgeht.
  // ALLE Ausloeser zuruecksetzen, nur der sichtbare meldet "offen": wechselt
  // die Breite bei offenem Menue, ist beim Schliessen ein ANDERER sichtbar als
  // beim Oeffnen - der erste bliebe sonst auf "true" stehen und meldete nach
  // dem Zurueckwechseln ein geschlossenes Menue als offen.
  const trigger = triggerOf(panel.id);
  if (typeof document.querySelectorAll === 'function') {
    for (const el of document.querySelectorAll(`[popovertarget="${panel.id}"]`)) el.setAttribute('aria-expanded', 'false');
  }
  trigger?.setAttribute('aria-expanded', String(event.newState === 'open'));

  if (event.newState !== 'open') { panel.style.opacity = ''; panel.style.transform = ''; return; }

  if (trigger) {
    const rect = trigger.getBoundingClientRect();
    const width = panel.offsetWidth || 200;
    const height = panel.offsetHeight || 48;
    const gap = 4;
    // `data-placement="top-start"`: ueber dem Trigger, an seiner LINKEN Kante.
    // Fuer einen Ausloeser am Fuss einer linken Leiste (Konto-Menue der
    // Seitenleiste) - rechtsbuendig haenge das Menue sonst halb ueber dem
    // Inhalt daneben, und nach unten ist dort nie Platz.
    const topStart = panel.dataset?.placement === 'top-start';
    // Rechtskante am Trigger, aber niemals außerhalb des Viewports.
    const left = Math.min(Math.max(8, topStart ? rect.left : rect.right - width), window.innerWidth - width - 8);
    let top = topStart ? rect.top - height - gap : rect.bottom + gap;
    // Nach oben kippen, wenn unten kein Platz ist - der Kopf der Einkaufsliste
    // sitzt oben, das Zeilenmenü kann überall stehen. Die obere Variante kippt
    // umgekehrt nach unten, wenn ueber ihr kein Platz ist.
    if (topStart && top < 8) top = rect.bottom + gap;
    else if (!topStart && top + height > window.innerHeight - 8) top = rect.top - height - gap;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(Math.max(8, top))}px`;
    // DAS MENUE WAECHST VOM AUSLOESER AUS (R14, A1 P3-4): der Ursprung der
    // Skalierung ist die Ecke, die am Ausloeser liegt - oben, wenn es darunter
    // steht, unten, wenn es darueber steht; rechts beim rechtsbuendigen, links
    // bei `top-start`. Nur diese Rechnung kennt die Ecke (layout.css `.popover-menu`).
    const above = top < rect.top;
    panel.style.transformOrigin = `${above ? 'bottom' : 'top'} ${topStart ? 'left' : 'right'}`;
  }
  panel.style.opacity = '1';
  panel.style.transform = 'none';

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

/**
 * Die bedienbaren Eintraege eines Panels in DOM-Reihenfolge - nur die, die
 * GERENDERT sind (Review zu #1475). Ein Modul darf einen Eintrag per CSS
 * ausblenden, der unter einer Breite nichts bewirkt (Mahlzeiten: der
 * Rezeptspalten-Schalter unter 1024px, meals.css). Im DOM steht er weiter,
 * und als Ziel von End/ArrowUp nahm er den Fokus nicht an - die Tastatur hing
 * am Menueende. Die Frage gehoert hierher und nicht in jedes Modul: welche
 * Regel einen Eintrag verbirgt, weiss nur das Rendering.
 */
function itemsOf(panel) {
  return [...panel.querySelectorAll('.popover-menu__item:not([disabled])')].filter(isRendered);
}

function isRendered(item) {
  if (typeof item.checkVisibility === 'function') return item.checkVisibility();
  if (typeof item.getClientRects === 'function') return item.getClientRects().length > 0;
  return true;
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
