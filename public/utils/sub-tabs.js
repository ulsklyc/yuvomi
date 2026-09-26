/**
 * Shared sticky sub-tab bar (pill-style).
 *
 * ZWEI SEMANTIKEN, EINE OPTIK. Die Leiste sieht in beiden Fällen gleich aus und
 * ist es nicht:
 *
 *   `semantics: 'nav'`   Die Einträge sind ZIELORTE. Ein Klick wechselt das
 *                        Modul (Küche: /meals, /recipes, /shopping, /pantry -
 *                        vier eigene `module:`-Werte in router.js, einzeln
 *                        abschaltbar). Gebaut als `<nav>` mit echten `<a href>`
 *                        und `aria-current="page"`. Damit funktionieren
 *                        cmd-Klick, Mittelklick und „Link kopieren" - dasselbe
 *                        Hausmuster wie die Shell-Navigation (router.js,
 *                        navItemEl).
 *
 *   `semantics: 'tabs'`  Die Einträge sind SICHTEN im selben Dokument
 *                        (Gesundheit: alle sechs Routen tragen
 *                        `module: 'health'`, alle sechs Panels stehen
 *                        gleichzeitig im DOM). Gebaut als WAI-ARIA-Tablist.
 *
 * WARUM DER AUFRUFER DAS SAGT UND NICHT DER HELFER: ein geteilter Helfer kann
 * nicht wissen, ob unter ihm ein Panel liegt oder eine Route. Vorher schrieb er
 * unbesehen `role="tab"` und ein `aria-controls` auf eine Panel-ID, die nur
 * `syncTabPanels` vergeben hätte - und die suchte `[data-panel]`, ein Attribut,
 * das der eigene Frontend-Guard verbietet. Ergebnis waren zehn Tabs, die auf
 * nichts zeigten (Audit 2026-08-08, P1-1). Deshalb ist `semantics` PFLICHT und
 * hat keinen Default: ein Default ist genau der Weg, auf dem sich die falsche
 * Variante still verbreitet.
 *
 * @param {HTMLElement} anchorEl  - element relative to which the bar is inserted
 * @param {object}      opts
 * @param {'nav'|'tabs'} opts.semantics        - PFLICHT, siehe oben
 * @param {Array<{id: string, label: string, icon?: string, separatorBefore?: boolean}>} opts.tabs
 * @param {string}      opts.activeId          - initially active tab id
 * @param {Function}    opts.onChange          - called with new id on tab switch
 * @param {Function}    [opts.panelFor]        - nur bei 'tabs': (id) => Element|null.
 *                                               Liefert das Panel zu einem Tab. Ohne
 *                                               Treffer bleibt `aria-controls` WEG statt
 *                                               ins Leere zu zeigen.
 * @param {Function}    [opts.hrefFor]         - nur bei 'nav': (id) => string; Default ist
 *                                               die id selbst (beide Nutzer führen Routen als id)
 * @param {string}      [opts.storageKey]      - sessionStorage key for persistence
 * @param {string}      [opts.extraClass]      - additional CSS class on bar element
 * @param {string}      [opts.ariaLabel]
 * @param {string}      [opts.title]           - optional visible module title (left of the tabs).
 *                                               Decorative (aria-hidden): the bar's ariaLabel
 *                                               already names the cluster for assistive tech.
 * @param {Function}    [opts.sealIcon]        - nur bei 'nav': Icon-Fabrik (moduleIconEl) für das
 *                                               Absender-Siegel links des Titels. Siehe unten.
 * @param {InsertPosition} [opts.insertPosition='afterbegin']
 * @returns {HTMLElement} the rendered bar element
 */
import { wireScrollFade } from '/utils/ux.js';

let subTabsCounter = 0;

export function renderSubTabs(anchorEl, {
  semantics,
  tabs,
  activeId,
  onChange,
  panelFor,
  hrefFor = (id) => id,
  storageKey,
  extraClass,
  ariaLabel,
  title,
  sealIcon,
  insertPosition = 'afterbegin',
}) {
  if (semantics !== 'nav' && semantics !== 'tabs') {
    throw new Error(`renderSubTabs: semantics muss 'nav' oder 'tabs' sein (bekam: ${semantics}).`);
  }
  // DAS ABSENDER-SIEGEL GEHÖRT DER LEISTE, DIE DAS MODUL WECHSELT.
  //
  // Das ist die Leisten-Regel, in der Sprache dieses Helfers: wechselt die
  // Leiste den `module:`-Wert - genau das heisst `semantics: 'nav'` -, dann ist
  // SIE die Kopf-Navigation, führt den Modulnamen und damit auch den Absender.
  // Wechselt sie ihn nicht ('tabs', Gesundheit), liegt sie im kanonischen Kopf,
  // und der trägt sein Siegel bereits. Ein zweites wäre die Siegel-Inflation,
  // gegen die die Herkunfts-Regel geschrieben ist - deshalb ein Fehler und kein
  // stilles Ignorieren: still übergangen käme es beim nächsten Nutzer wieder.
  if (sealIcon && semantics !== 'nav') {
    throw new Error("renderSubTabs: sealIcon gehört nur einer Leiste, die das Modul wechselt (semantics 'nav') - im Modulkopf trägt der Kopf das Siegel.");
  }
  // Eine Tablist ohne Panels ist genau der Zustand, den dieser Umbau beseitigt:
  // `role="tab"` verspricht ein Panel, und wer keins anmelden kann, meint 'nav'.
  if (semantics === 'tabs' && typeof panelFor !== 'function') {
    throw new Error("renderSubTabs: semantics 'tabs' braucht panelFor(id) - ohne Panels ist es eine Navigation.");
  }
  const isNav = semantics === 'nav';
  let current = activeId;

  if (storageKey) {
    try { sessionStorage.setItem(storageKey, current); } catch { /* ignore */ }
  }

  const bar = document.createElement(isNav ? 'nav' : 'div');
  const barId = `sub-tabs-${++subTabsCounter}`;
  bar.className = 'sub-tabs-bar' + (extraClass ? ' ' + extraClass : '');
  if (!isNav) bar.setAttribute('role', 'tablist');
  if (ariaLabel) bar.setAttribute('aria-label', ariaLabel);

  // Das Absender-Siegel steht VOR dem Titel und bleibt auch dort stehen, wo der
  // Titel weicht: mobil blendet die Küchen-Leiste ihr Wort aus, weil die
  // Bottom-Nav es bereits führt (kitchen-tabs.css). Das MARK ersetzt es dort
  // nicht - es weist den Raum aus, während das Wort eine Leiste tiefer steht.
  if (sealIcon) {
    const sealEl = document.createElement('span');
    sealEl.className = 'module-seal module-seal--head';
    sealEl.setAttribute('aria-hidden', 'true');
    sealEl.appendChild(sealIcon());
    bar.appendChild(sealEl);
  }

  // Optionaler Modul-Titel links der Tabs (Canonical Page Head). Dekorativ:
  // aria-hidden, da die Leiste via aria-label denselben Namen bereits trägt;
  // eine Tablist exponiert dadurch weiterhin nur die Tabs.
  if (title) {
    const titleEl = document.createElement('span');
    titleEl.className = 'sub-tabs-bar__title';
    titleEl.setAttribute('aria-hidden', 'true');
    titleEl.textContent = title;
    bar.appendChild(titleEl);
  }

  for (const { id, label, icon, separatorBefore } of tabs) {
    if (separatorBefore) {
      const sep = document.createElement('span');
      sep.className = 'sub-tabs-separator';
      sep.setAttribute('aria-hidden', 'true');
      bar.appendChild(sep);
    }

    const btn = document.createElement(isNav ? 'a' : 'button');
    const safeId = safeDomId(id);
    btn.id = `${barId}-tab-${safeId}`;
    btn.className = 'sub-tab' + (id === current ? ' sub-tab--active' : '');
    btn.dataset.tabId = id;

    if (isNav) {
      btn.href = hrefFor(id);
      // `aria-current="page"` ist die Ansage für „hier stehst du" in einer
      // Navigation - das Gegenstück zu `aria-selected` in einer Tablist. Alle
      // Links bleiben per Tab erreichbar (Roving-Tabindex gehört zur Tablist,
      // nicht zur Navigation).
      if (id === current) btn.setAttribute('aria-current', 'page');
    } else {
      btn.type = 'button';
      // Vorschlag einer Panel-ID - vergeben wird sie nur, wenn das Panel noch
      // keine hat (syncTabPanels). Ein Panel, das schon eine ID trug, behält sie.
      btn.dataset.panelId = `${barId}-panel-${safeId}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', id === current ? 'true' : 'false');
      btn.tabIndex = id === current ? 0 : -1;
    }

    if (icon) {
      const i = document.createElement('i');
      i.dataset.lucide = icon;
      i.className = 'sub-tab__icon';
      i.setAttribute('aria-hidden', 'true');
      btn.appendChild(i);
    }

    const span = document.createElement('span');
    span.className = 'sub-tab__label';
    span.textContent = label;
    btn.appendChild(span);

    // Zustands-Slot. Immer angelegt, auch leer: die Zahl kommt asynchron nachgeladen
    // (siehe setSubTabBadge), und ein Slot, der erst dann entsteht, würde die Leiste
    // nachträglich verbreitern und den aktiven Tab wegschieben.
    const badge = document.createElement('span');
    badge.className = 'sub-tab__badge';
    badge.hidden = true;
    btn.appendChild(badge);

    bar.appendChild(btn);
  }

  // Auf schmalen Viewports überläuft die Leiste; der aktive Tab muss dann
  // sichtbar sein, sonst wirkt die Seite tab-los (Audit A2-18). block:'nearest'
  // hält den vertikalen Seiten-Scroll unangetastet.
  const scrollActiveIntoView = () => {
    bar.querySelector('.sub-tab--active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  };

  // Waehlt einen Tab OHNE onChange - fuer eine Leiste, die ueber einen
  // Seitenwechsel stehen bleibt und vom Router erfaehrt, wo sie jetzt steht
  // (selectSubTab, genutzt von der Kuechen-Leiste). Aendert auch `current`:
  // wer nur die Klassen setzte, hielte hier einen alten Stand, und der naechste
  // Klick auf genau diesen Tab verpuffte als „schon aktiv".
  const markTab = (tabId, { focus = false } = {}) => {
    current = tabId;

    if (storageKey) {
      try { sessionStorage.setItem(storageKey, current); } catch { /* ignore */ }
    }

    bar.querySelectorAll('[data-tab-id]').forEach((b) => {
      const active = b.dataset.tabId === current;
      b.classList.toggle('sub-tab--active', active);
      if (isNav) {
        if (active) b.setAttribute('aria-current', 'page');
        else b.removeAttribute('aria-current');
      } else {
        b.setAttribute('aria-selected', String(active));
        b.tabIndex = active ? 0 : -1;
      }
      if (active && focus) b.focus();
    });
    scrollActiveIntoView();
    syncTabPanels(bar, current, panelFor);
  };

  const activateTab = (tabId, { focus = false } = {}) => {
    if (!tabId || tabId === current) return;
    markTab(tabId, { focus });
    onChange(current);
  };

  selectors.set(bar, (tabId) => {
    if (tabId && tabId !== current) markTab(tabId);
  });

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab-id]');
    if (!btn) return;

    // In der Navigations-Variante sind die Einträge echte Links. Ein Klick mit
    // Modifier (oder der mittleren Maustaste) gehört dem Browser: neuer Tab,
    // neues Fenster, Download. Nur der schlichte Linksklick wird zur
    // SPA-Navigation abgefangen - dasselbe Verhalten wie in der Shell-Nav.
    if (isNav) {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
    }

    activateTab(btn.dataset.tabId);
  });

  bar.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;

    const buttons = [...bar.querySelectorAll('[data-tab-id]')];
    const focusedIndex = buttons.indexOf(document.activeElement);
    const currentIndex = Math.max(0, buttons.findIndex((btn) => btn.dataset.tabId === current));
    const index = focusedIndex >= 0 ? focusedIndex : currentIndex;
    let nextIndex = index;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = (index + 1) % buttons.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIndex = (index - 1 + buttons.length) % buttons.length;
    if (e.key === 'Home') nextIndex = 0;
    if (e.key === 'End') nextIndex = buttons.length - 1;

    e.preventDefault();

    // Tablist: Pfeiltaste WÄHLT (APG „automatic activation") - der Wechsel ist
    // ein Panel-Tausch im selben Dokument und damit folgenlos.
    // Navigation: Pfeiltaste bewegt nur den FOKUS. Aktivieren würde bei jedem
    // Tastendruck ein Modul laden; ausgelöst wird mit Enter bzw. Klick.
    if (isNav) buttons[nextIndex]?.focus();
    else activateTab(buttons[nextIndex]?.dataset.tabId, { focus: true });
  });

  anchorEl.insertAdjacentElement(insertPosition, bar);
  syncTabPanels(bar, current, panelFor);
  // Scroll-Affordanz (geteilte has-fade-Masken, filter-chip.css) + der via
  // storageKey restaurierte Tab kann jenseits des sichtbaren Bereichs liegen.
  wireScrollFade(bar);
  scrollActiveIntoView();

  if (window.lucide) window.lucide.createIcons({ el: bar });

  return bar;
}

/** Auswahl je Leiste, ohne onChange - siehe markTab in renderSubTabs. */
const selectors = new WeakMap();

/**
 * Setzt den aktiven Tab einer bestehenden Leiste, OHNE `onChange` auszuloesen.
 *
 * Fuer eine Leiste, die einen Seitenwechsel ueberlebt: die Kuechen-Leiste ist
 * vorher und nachher derselbe Knoten (utils/kitchen-tabs.js), und kommt der
 * Wechsel nicht von ihrem eigenen Klick (Browser-Zurueck, Bottom-Nav), muss
 * sie nachziehen, ohne selbst noch einmal zu navigieren.
 *
 * @param {HTMLElement} bar
 * @param {string}      tabId
 */
export function selectSubTab(bar, tabId) {
  selectors.get(bar)?.(tabId);
}

/**
 * Holt den aktiven Tab ins Bild.
 *
 * Muss von außen aufrufbar sein, weil die Leiste NACH dem ersten Einscrollen noch
 * breiter werden kann: die Zustandszahlen kommen asynchron und kosten je 22px.
 * Gemessen bei 320px auf /pantry - der aktive Tab („Vorrat", der letzte) lag danach
 * teilweise außerhalb, obwohl beim Rendern korrekt gescrollt worden war.
 *
 * `block: 'nearest'` hält den vertikalen Seiten-Scroll unangetastet.
 *
 * @param {HTMLElement} bar
 */
export function scrollActiveSubTabIntoView(bar) {
  bar?.querySelector('.sub-tab--active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

/**
 * Setzt oder entfernt die Zustandszahl eines Tabs.
 *
 * WARUM EINE ZAHL UND EIN SEPARATES LABEL: „12" allein ist im Tab nicht
 * selbsterklärend („12 was?"), ein ausgeschriebenes „12 offene Artikel" sprengt
 * eine Leiste, die vier Tabs tragen muss. Die Zahl trägt also die Sichtbarkeit, das
 * `aria-label` des Tabs die Bedeutung - dasselbe Muster wie `.list-tab__count` in
 * der Einkaufsliste, nur dass dort der Kontext aus dem Chip selbst hervorgeht.
 *
 * Das Label wird an den TAB gehängt, nicht an das Badge: ein Screenreader liest den
 * Namen des Tabs, nicht den seiner Kinder. Ohne `aria-label` hörte man
 * „Einkaufen 12", was genau die Ambiguität ist, die das Badge visuell noch tragen
 * darf und akustisch nicht.
 *
 * @param {HTMLElement} bar     von renderSubTabs zurückgegebene Leiste
 * @param {string}      tabId
 * @param {object|null} state   { count, label, tone } - null/0 entfernt das Badge
 */
export function setSubTabBadge(bar, tabId, state) {
  const btn = bar?.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`);
  if (!btn) return;
  const badge = btn.querySelector('.sub-tab__badge');
  if (!badge) return;

  const count = Number(state?.count ?? 0);
  if (!Number.isFinite(count) || count <= 0) {
    badge.hidden = true;
    badge.textContent = '';
    badge.className = 'sub-tab__badge';
    btn.removeAttribute('aria-label');
    return;
  }

  badge.hidden = false;
  badge.textContent = String(count);
  badge.className = `sub-tab__badge${state.tone ? ` sub-tab__badge--${state.tone}` : ''}`;
  // Der Zähler ist für Screenreader redundant, sobald das Label ihn nennt.
  badge.setAttribute('aria-hidden', 'true');
  if (state.label) btn.setAttribute('aria-label', state.label);
}

function safeDomId(value) {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'tab';
}

/**
 * Verknüpft Tabs und Panels in beide Richtungen - Tab → `aria-controls`,
 * Panel → `aria-labelledby`.
 *
 * DER AUFRUFER REICHT DIE PANELS HEREIN, DER HELFER SUCHT SIE NICHT. Die
 * Vorgängerfassung sammelte `[data-panel]` aus dem Seitenbaum; dieses Attribut
 * ist im Repo per Frontend-Guard verboten, die Suche traf also nie etwas, und
 * jeder Tab trug trotzdem ein `aria-controls` auf eine ID, die niemand vergab
 * (Audit 2026-08-08, P1-1). Ohne Panel bleibt das Attribut jetzt WEG: ein
 * Screenreader kündigt lieber keinen Zielort an als einen, den es nicht gibt.
 *
 * Die Sichtbarkeit gehört ebenfalls hierher, damit sie nicht zweimal geregelt
 * wird - wer Panels anmeldet, gibt das Verstecken mit ab.
 */
function syncTabPanels(bar, current, panelFor) {
  if (typeof panelFor !== 'function') return;

  bar.querySelectorAll('[data-tab-id]').forEach((btn) => {
    const panel = panelFor(btn.dataset.tabId);
    if (!panel) {
      btn.removeAttribute('aria-controls');
      return;
    }

    if (!panel.id) panel.id = btn.dataset.panelId;
    btn.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', btn.id);
    // `aria-labelledby` gewinnt gegen `aria-label`; beide stehen zu lassen hieße,
    // eine tote Zweitbeschriftung im Markup zu führen. Bis die Leiste steht, ist
    // das `aria-label` aus dem Panel-Markup der Name - danach der Tab.
    panel.removeAttribute('aria-label');
    panel.hidden = btn.dataset.tabId !== current;
  });
}
