/**
 * Modul: Liste + Detail (Master/Detail im Mac-Stil)
 * Zweck: Der geteilte Baustein des Breitenregimes „Liste + Detail"
 *        (DESIGN.md, Breitenregel). Ab einer Modulflaeche von 75rem steht links
 *        die Liste, rechts das Detail der AUSGEWAEHLTEN Zeile - wie in Mail,
 *        Erinnerungen und Kontakte. Darunter bleibt alles, wie es ist: die
 *        Zeile oeffnet ihr Modal, Sheet oder ihren Aufklapper.
 * Abhaengigkeiten: utils/empty-state.js, i18n.js
 *
 * WER WAS BESITZT
 *   - Die GEOMETRIE gehoert der Shell (`.split-view` in layout.css): eine
 *     Container Query auf die Modulflaeche entscheidet, ob die Detailspalte
 *     steht. Ein Modul setzt keine Breite und keinen Breakpoint.
 *   - Der ZUSTAND gehoert diesem Baustein: welche Zeile ausgewaehlt ist, die
 *     Adresse (`?open=`), Zurueck-Taste, Pfeiltasten, Enter/Esc, Leerzustand.
 *   - Der INHALT gehoert dem Modul: `renderDetail()` zeichnet das Detail in
 *     den Koerper der Spalte - am besten ueber `openDetailView({ pane })` aus
 *     components/detail-view.js, dasselbe Markup wie im Popover und im Sheet.
 *
 * OB DIE SPALTE STEHT, ENTSCHEIDET DAS CSS, NICHT DIESE DATEI. `matchMedia`
 * kennt keine Container Queries, und eine zweite Schwelle hier liefe der im
 * Stylesheet davon. Der Baustein fragt deshalb die gerechnete Darstellung der
 * Detailspalte ab (`display: none` unter der Schwelle) und hoert per
 * ResizeObserver auf Wechsel.
 *
 * API
 *   splitViewDetailHtml({ id, label, empty })  -> Markup der rechten Spalte
 *   mountMasterDetail({ root, list, ... })     -> Handle, siehe dort
 *   handleMasterDetailPopstate()               -> vom Router (popstate)
 *   detailPaneHeaderEl({ title, actions })     -> Kopf der Detailspalte
 */

import { esc } from '/utils/html.js';
import { emptyStateEl } from '/utils/empty-state.js';

/** Die eine lebende Instanz. Es gibt je Seite hoechstens eine Liste + Detail. */
let active = null;

/**
 * Markup der rechten Spalte: Leerzustand und (leerer) Detail-Koerper.
 *
 * Der Leerzustand ist ruhig und kurz („Waehle einen Kontakt") - er steht nur,
 * solange nichts ausgewaehlt ist, und sagt, was die Spalte tut.
 *
 * @param {object} opts
 * @param {string} opts.id                 Praefix fuer IDs, z.B. `contacts`
 * @param {string} opts.label              Zugaenglicher Name der Spalte
 * @param {{icon?: string, title: string, hint?: string}} opts.empty
 * @returns {string}
 */
export function splitViewDetailHtml({ id, label, empty = {} }) {
  const emptyBox = emptyStateEl({
    icon: empty.icon,
    title: empty.title,
    description: empty.hint,
    className: 'split-view__empty-state',
  });
  return `
    <section class="split-view__detail" id="${esc(id)}-detail" aria-label="${esc(label)}" tabindex="-1">
      <div class="split-view__empty" data-md-empty>${emptyBox.outerHTML}</div>
      <div class="split-view__detail-body" data-md-body hidden></div>
    </section>`;
}

/**
 * Kopf der Detailspalte: Titel links, Aktionen rechts - der eigene Kopf, den
 * Mail ueber der Nachricht fuehrt. Per DOM-API, weil der Titel Nutzerdaten ist.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {Array<{label: string, icon?: string, variant?: string, id?: string,
 *   iconOnly?: boolean, onClick?: Function}>} [opts.actions]
 * @returns {HTMLElement}
 */
export function detailPaneHeaderEl({ title = '', actions = [] } = {}) {
  const head = document.createElement('header');
  head.className = 'split-view__detail-head';
  const h = document.createElement('h2');
  h.className = 'split-view__detail-title';
  h.textContent = title;
  head.appendChild(h);
  const visible = actions.filter((a) => a && !a.hidden);
  if (visible.length) {
    const bar = document.createElement('div');
    bar.className = 'split-view__detail-actions';
    for (const action of visible) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn btn--${action.variant ?? 'secondary'}${action.iconOnly ? ' btn--icon' : ''}`;
      if (action.id) btn.id = action.id;
      if (action.icon) {
        const i = document.createElement('i');
        i.className = 'icon-md';
        i.dataset.lucide = action.icon;
        i.setAttribute('aria-hidden', 'true');
        btn.appendChild(i);
      }
      if (action.iconOnly) {
        btn.setAttribute('aria-label', action.label ?? '');
        btn.setAttribute('title', action.label ?? '');
      } else {
        btn.append(document.createTextNode(action.label ?? ''));
      }
      if (typeof action.onClick === 'function') btn.addEventListener('click', () => action.onClick({ button: btn }));
      bar.appendChild(btn);
    }
    head.appendChild(bar);
  }
  return head;
}

/** Adresse mit gesetztem oder entferntem Parameter, alle anderen bleiben. */
function urlWith(param, id) {
  const url = new URL(location.href);
  if (id == null || id === '') url.searchParams.delete(param);
  else url.searchParams.set(param, String(id));
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Alles an der Adresse AUSSER der Auswahl: die uebrigen Parameter und der
 * Anker. Unterscheidet sich das zwischen zwei Eintraegen, ist Zurueck/Vor
 * keine Auswahl-Geste mehr, sondern ein anderer Zustand der Seite.
 */
function addressRest(param) {
  const params = new URLSearchParams(location.search);
  params.delete(param);
  return `${params.toString()}${location.hash}`;
}

function writeHistory(mode, param, id) {
  if (mode === 'none') return;
  const path = urlWith(param, id);
  if (path === `${location.pathname}${location.search}${location.hash}`) return;
  // `path` im State: der Router liest ihn bei popstate (router.js).
  if (mode === 'push') history.pushState({ path }, '', path);
  else history.replaceState({ ...(history.state ?? {}), path }, '', path);
}

/**
 * Haengt Liste + Detail an eine Seite.
 *
 * Markup (vom Modul gebaut, Geometrie aus layout.css):
 *
 *   <div class="split-view">
 *     <div class="split-view__list"> ... die bestehende Liste ... </div>
 *     ${splitViewDetailHtml({...})}
 *   </div>
 *
 * Jede auswaehlbare Zeile traegt `data-md-id="<id>"`. Fokussiert wird bei
 * Pfeiltasten das Element mit `data-md-focus` in der Zeile, sonst die Zeile
 * selbst (die ist dann ein Knopf oder hat tabindex).
 *
 * @param {object} opts
 * @param {HTMLElement} opts.root         `.split-view`
 * @param {HTMLElement} [opts.list]       Ereignis-Wurzel der Tastatur; Standard `.split-view__list`
 * @param {string} [opts.param='open']    Name des Adress-Parameters. EIN Name fuer
 *        alle Liste-+-Detail-Seiten: `?open=<id>` ist der Deep-Link, den globale
 *        Suche und Essenskarten schon setzten - ein zweiter hiesse zwei Adressen
 *        fuer dieselbe Sache.
 * @param {(id: string, body: HTMLElement, ctx: {signal: AbortSignal}) => (void|false|Promise<void|false>)} opts.renderDetail
 *        Zeichnet das Detail in `body`. `false` heisst: diese ID gibt es nicht
 *        (mehr) - die Auswahl faellt dann auf den Leerzustand zurueck.
 * @param {(id: string, trigger?: HTMLElement) => void} opts.openNarrow
 *        Unter der Schwelle: der bisherige Weg (Modal/Sheet/Aufklapper).
 * @param {(id: string) => void} [opts.onEnter]
 *        Enter auf der ausgewaehlten Zeile in der Spalte (z.B. Bearbeiten);
 *        ohne Angabe fokussiert Enter das Detail.
 * @param {(state: {split: boolean, selectedId: string|null}) => void} [opts.onModeChange]
 *        Die Darstellung hat gewechselt (Fenster, Seitenleiste). Gerufen BEVOR
 *        der Baustein eine gemerkte Auswahl in die Spalte zeichnet - ein Modul,
 *        das die Zeile erst zeigen muss (Inventar: Kategorie oeffnen), tut das
 *        hier, damit Markierung und `refresh()` sie finden.
 * @param {boolean} [opts.deepLinkNarrow=false]
 *        `?open=` auch unter der Schwelle einloesen (oeffnet `openNarrow`).
 * @param {AbortSignal} [opts.signal]     Router-Signal; Abbruch baut ab.
 * @returns {{open: Function, select: Function, clear: Function, selectedId: Function,
 *   isSplit: Function, refresh: Function, destroy: Function}}
 */
export function mountMasterDetail({
  root, list, param = 'open', renderDetail, openNarrow, onEnter, onModeChange,
  deepLinkNarrow = false, signal,
} = {}) {
  if (!root) throw new TypeError('mountMasterDetail: root fehlt');
  const listEl = list ?? root.querySelector('.split-view__list');
  const detailEl = root.querySelector('.split-view__detail');
  const emptyEl = root.querySelector('[data-md-empty]');
  const bodyEl = root.querySelector('[data-md-body]');
  if (!listEl || !detailEl || !emptyEl || !bodyEl) {
    throw new TypeError('mountMasterDetail: .split-view braucht __list und die Spalte aus splitViewDetailHtml()');
  }

  let selected = null;
  let renderSeq = 0;
  let renderAbort = null;
  let lastSplit = null;
  const pathname = location.pathname;
  // Der Rest der Adresse, auf dem diese Seite gezeichnet ist (Aufgaben:
  // `?view=`). Der Baustein schreibt nur `param` - aendert Zurueck/Vor etwas
  // anderes, gehoert die Geste dem Router.
  const rest = addressRest(param);
  const teardown = new AbortController();

  const isSplit = () => root.isConnected && getComputedStyle(detailEl).display !== 'none';

  const rows = () => [...listEl.querySelectorAll('[data-md-id]')]
    .filter((row) => !row.hidden && row.getClientRects().length > 0);
  const rowFor = (id) => listEl.querySelector(`[data-md-id="${CSS.escape(String(id))}"]`);
  const focusTarget = (row) => row?.querySelector('[data-md-focus]') ?? row;

  function markSelection() {
    for (const row of listEl.querySelectorAll('[data-md-id].is-selected, [data-md-id] [aria-current="true"]')) {
      const host = row.closest('[data-md-id]') ?? row;
      host.classList.remove('is-selected');
      focusTarget(host)?.removeAttribute('aria-current');
    }
    if (selected == null) return;
    const row = rowFor(selected);
    if (!row) return;
    row.classList.add('is-selected');
    // `aria-current` statt `aria-selected`: die Zeilen sind Knoepfe in einer
    // Liste, keine Optionen einer Listbox - „aktuell" ist die ehrliche Ansage.
    focusTarget(row)?.setAttribute('aria-current', 'true');
  }

  /**
   * Waehrend ein Renderer laedt, gehoert die Spalte schon der NEUEN Auswahl.
   * Der alte Inhalt bleibt stehen (kein Flackern bei schnellen Antworten),
   * nimmt aber keine Klicks und keinen Fokus mehr: Bearbeiten oder Loeschen
   * traefe sonst den vorigen Eintrag, waehrend links der neue markiert ist.
   */
  function setBusy(on) {
    bodyEl.inert = on;
    if (on) bodyEl.setAttribute('aria-busy', 'true');
    else bodyEl.removeAttribute('aria-busy');
  }

  function showEmpty() {
    renderAbort?.abort();
    renderAbort = null;
    setBusy(false);
    bodyEl.replaceChildren();
    bodyEl.hidden = true;
    emptyEl.hidden = false;
  }

  async function paint(id) {
    const seq = ++renderSeq;
    renderAbort?.abort();
    renderAbort = new AbortController();
    emptyEl.hidden = true;
    bodyEl.hidden = false;
    bodyEl.scrollTop = 0;
    setBusy(true);
    let result;
    try {
      result = await renderDetail?.(String(id), bodyEl, { signal: renderAbort.signal });
    } catch (err) {
      // Ein Fehler im Modul-Renderer darf die Liste nicht mitreissen - aber er
      // darf auch nicht still verschwinden (reference: stilles catch).
      console.error('[master-detail] renderDetail fehlgeschlagen:', err);
      result = false;
    }
    // Eine spaetere Auswahl hat diese ueberholt: ihr Ergebnis gilt nicht mehr -
    // und sie gibt die Spalte auch nicht frei, die gehoert der neueren.
    if (seq !== renderSeq) return;
    setBusy(false);
    if (result === false) {
      selected = null;
      markSelection();
      showEmpty();
      writeHistory('replace', param, null);
      return;
    }
    if (window.lucide) window.lucide.createIcons({ el: bodyEl });
  }

  /**
   * Waehlt eine Zeile aus (nur in der Spalten-Darstellung sinnvoll).
   * @param {string|number} id
   * @param {{history?: 'push'|'replace'|'none', focus?: 'row'|'detail'|false}} [opts]
   */
  function select(id, { history: mode = 'push', focus = false } = {}) {
    if (id == null || id === '') { clear({ history: mode }); return; }
    const same = selected != null && String(selected) === String(id);
    selected = String(id);
    markSelection();
    writeHistory(same ? 'none' : mode, param, selected);
    if (!same || bodyEl.hidden) paint(selected);
    if (focus === 'row') focusTarget(rowFor(selected))?.focus();
    else if (focus === 'detail') detailEl.focus();
  }

  function clear({ history: mode = 'replace' } = {}) {
    selected = null;
    renderSeq += 1;
    markSelection();
    showEmpty();
    writeHistory(mode, param, null);
  }

  /**
   * Der eine Einstieg fuer einen Klick auf eine Zeile: in der Spalte waehlt er
   * aus, darunter oeffnet er den bisherigen Weg.
   */
  function open(id, trigger) {
    if (isSplit()) select(id, { history: 'push' });
    else openNarrow?.(String(id), trigger);
  }

  /** Nach einem Neuaufbau der Liste: Markierung neu setzen, Verschwundenes raeumen. */
  function refresh({ repaint = false } = {}) {
    if (selected != null && !rowFor(selected)) {
      clear({ history: 'replace' });
      return;
    }
    markSelection();
    if (repaint && selected != null && isSplit()) paint(selected);
  }

  function onKeydown(event) {
    if (!isSplit()) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const row = event.target.closest?.('[data-md-id]');
    if (!row || !listEl.contains(row)) return;
    // Nur von der Zeile selbst, nicht aus Feldern oder Knoepfen IN ihr heraus
    // (Abhaken, Menue): dort gehoeren die Tasten dem Element.
    if (event.target !== focusTarget(row)) return;
    const all = rows();
    const index = all.indexOf(row);
    let next = null;
    if (event.key === 'ArrowDown') next = all[Math.min(all.length - 1, index + 1)];
    else if (event.key === 'ArrowUp') next = all[Math.max(0, index - 1)];
    else if (event.key === 'Home') next = all[0];
    else if (event.key === 'End') next = all[all.length - 1];
    if (next) {
      event.preventDefault();
      // Pfeile schreiben KEINE neuen History-Eintraege: wer durch zwanzig
      // Kontakte blaettert, will mit einem Zurueck nicht zwanzigmal zurueck.
      select(next.dataset.mdId, { history: selected == null ? 'push' : 'replace', focus: 'row' });
      next.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter' && String(row.dataset.mdId) === selected) {
      // Enter auf der schon gewaehlten Zeile: wie in Mail „oeffnen". Die erste
      // Aktivierung (Klick/Enter auf eine andere Zeile) waehlt nur aus - das
      // uebernimmt der Klick-Handler des Moduls ueber open().
      event.preventDefault();
      if (typeof onEnter === 'function') onEnter(selected);
      else detailEl.focus();
      return;
    }
    if (event.key === 'Escape' && selected != null) {
      event.preventDefault();
      clear({ history: 'replace' });
    }
  }

  function onDetailKeydown(event) {
    if (event.key !== 'Escape' || selected == null) return;
    // Esc im Detail fuehrt zur Zeile zurueck (Fokus), die Auswahl bleibt -
    // dieselbe Richtung wie ein Schliessen, ohne das Gelesene wegzuwerfen.
    // Ein offenes Menue oder Feld im Detail hat Esc schon selbst verbraucht.
    if (event.defaultPrevented) return;
    const row = rowFor(selected);
    if (!row) return;
    event.preventDefault();
    focusTarget(row)?.focus();
  }

  listEl.addEventListener('keydown', onKeydown, { signal: teardown.signal });
  detailEl.addEventListener('keydown', onDetailKeydown, { signal: teardown.signal });

  // Moduswechsel (Fenster schmaler/breiter, Seitenleiste ein-/ausgeklappt).
  // Breiter mit einer Auswahl in der Adresse: das Detail zeichnen. Schmaler:
  // nichts oeffnen - ein Modal, das beim Ziehen am Fensterrand aufspringt,
  // waere eine Handlung, die niemand ausgeloest hat.
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
      const split = isSplit();
      if (split === lastSplit) return;
      lastSplit = split;
      onModeChange?.({ split, selectedId: selected });
      if (split && selected != null) {
        markSelection();
        paint(selected);
      }
    })
    : null;
  ro?.observe(root);

  function destroy() {
    teardown.abort();
    renderAbort?.abort();
    ro?.disconnect();
    if (active === handle) active = null;
  }
  signal?.addEventListener('abort', destroy, { once: true });

  /** Zurueck/Vor innerhalb derselben Seite: Auswahl aus der Adresse. */
  function syncFromUrl() {
    const id = new URLSearchParams(location.search).get(param);
    if (!id) {
      if (selected != null) clear({ history: 'none' });
      return;
    }
    if (isSplit()) { select(id, { history: 'none' }); return; }
    selected = String(id);
    // Unter der Schwelle gilt dieselbe Regel wie beim Laden: wer den Link
    // einloesen laesst, bekommt auch bei Vor/Zurueck auf `?open=` das Blatt -
    // sonst nennt die Adresse einen Eintrag, und zu sehen ist die Liste. Das
    // Zurueck AUS dem Blatt faengt der Router vorher ab (overlay-history).
    if (deepLinkNarrow) openNarrow?.(String(id));
  }

  const handle = {
    open,
    select,
    clear,
    refresh,
    destroy,
    isSplit,
    selectedId: () => selected,
    // Fuer handleMasterDetailPopstate(); kein Teil der Modul-API.
    _pathname: pathname,
    _root: root,
    _syncFromUrl: syncFromUrl,
    _ownsAddress: () => addressRest(param) === rest,
  };
  active?.destroy();
  active = handle;

  // Deep-Link: `?open=` beim Aufbau einloesen.
  lastSplit = isSplit();
  const initial = new URLSearchParams(location.search).get(param);
  if (initial) {
    if (lastSplit) select(initial, { history: 'none' });
    else {
      // ERST merken, dann oeffnen: die Adresse nennt eine Auswahl, auch
      // wenn sie unter der Schwelle als Blatt erscheint. Wird das Fenster
      // danach breiter, zeichnet der ResizeObserver genau diesen Eintrag -
      // ohne den Merker stuende neben `?open=` der Leerzustand.
      selected = String(initial);
      if (deepLinkNarrow) openNarrow?.(selected);
    }
  }

  return handle;
}

/**
 * Vom Router bei popstate gerufen, BEVOR er die Seite neu zeichnet.
 *
 * Eine Auswahl ist ein Zustand derselben Seite. Ohne diesen Haken zeichnete
 * jedes Zurueck die ganze Seite neu (Skelett, Seitenuebergang, Scrollstand) -
 * fuer einen Wechsel der rechten Spalte.
 *
 * @returns {boolean} true, wenn die Geste hier verbraucht wurde
 */
export function handleMasterDetailPopstate() {
  if (!active) return false;
  if (!active._root.isConnected) { active.destroy(); return false; }
  if (location.pathname !== active._pathname) return false;
  // NUR die Auswahl. Aufgaben fuehren `?view=list|kanban|history` in der
  // Adresse; nimmt Zurueck die Ansicht mit, muss die Seite neu zeichnen - ein
  // verbrauchtes popstate liesse das Brett unter einer Listen-Adresse stehen.
  if (!active._ownsAddress()) return false;
  active._syncFromUrl();
  return true;
}
