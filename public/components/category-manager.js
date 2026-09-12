/**
 * Modul: Generischer Category-Manager Web Component
 * Zweck: Wiederverwendbare Verwaltung von Kategorien (und optional Subkategorien)
 *        für Budget, Tasks, Contacts. Konfiguration per configure().
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 *
 * Verhalten:
 *   - configure({ basePath, groups, groupField, supportsSubcategories, labelResolver, titleKey, hintKey,
 *                 addMaxLength,
 *                 deleteConfirmKey, deleteDetailKey, subDeleteDetailKey })
 *   - Lädt via api.get(basePath); mutiert über post/put/patch/delete relativ zu basePath
 *   - Dispatcht nach jeder Mutation `category-manager-changed`
 *   - Zeigt Server-Guard-Fehler (in-use/last) als Toast
 *   - Räumt Listener in disconnectedCallback() auf
 *
 * VERTRAG FUER AUFRUFER: die Auffrischung gehoert in den Ereignis-Handler, nicht
 * in ein onClose des Modals, und niemand meldet sich beim Schliessen ab. Grund
 * steht bei `_notifyChanged()`.
 */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { makeSortable, isDragActive } from '/utils/sortable.js';
import { wireTablist } from '/utils/tablist.js';

/** Platzhalter-Id fuer den Eintrag ohne Ton: eine leere `data-tab-id` waere kein Knopf. */
const NO_COLOR_ID = '__none__';

/**
 * Die Beschriftungen der Palette, in der Reihenfolge der Toene, die der Server
 * unter `categoryColors` ausliefert. Eine Farbe ohne Namen ist fuer einen
 * Screenreader ein Knopf ohne Aussage - und `aria-label` ist hier der EINZIGE
 * Traeger, weil ein Farbfeld keinen Text hat.
 */
const COLOR_LABEL_KEYS = [
  'category.colorGreen',
  'category.colorOcher',
  'category.colorViolet',
  'category.colorTeal',
  'category.colorOrange',
  'category.colorRed',
  'category.colorGrey',
];

/** Shared by the manager and the Notes editor; listeners belong to their root. */
export function wireCategoryScopeHelp(root) {
  const button = root.querySelector('.category-scope-help');
  if (!button) return () => {};
  const controller = new AbortController();
  const { signal } = controller;
  let pinned = false;
  const setOpen = (open) => button.setAttribute('aria-expanded', String(open));
  setOpen(false);
  button.addEventListener('mouseenter', () => setOpen(true), { signal });
  button.addEventListener('focus', () => setOpen(true), { signal });
  button.addEventListener('mouseleave', () => {
    if (!pinned && document.activeElement !== button) setOpen(false);
  }, { signal });
  button.addEventListener('blur', () => { pinned = false; setOpen(false); }, { signal });
  button.addEventListener('click', () => { pinned = !pinned; setOpen(pinned); }, { signal });
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  }, { signal });
  // Hover does not move focus: Escape can originate in a different form field.
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') {
      event.stopPropagation();
      pinned = false;
      setOpen(false);
    }
  }, { signal, capture: true });
  return () => controller.abort();
}

class CategoryManagerElement extends HTMLElement {
  constructor() {
    super();
    this._basePath = '';
    this._groups = [{ key: '', labelKey: '', addLabelKey: 'common.add' }];
    // Existing category APIs use `type`; callers with another canonical field
    // (Notes uses `scope`) opt in without changing the legacy contract.
    this._groupField = 'type';
    this._supportsSub = false;
    this._labelResolver = (item) => item.label ?? item.name; // Server liefert lokalisiertes `label`
    this._titleKey = 'category.manageTitle';
    this._hintKey = 'category.manageHint';
    // Der Vorrat verwaltet mit derselben Komponente Lagerorte, keine
    // Kategorien - dort las das Eingabefeld „Neue Kategorie" in einem Dialog
    // mit dem Titel „Lagerorte verwalten" (Critique). titleKey/hintKey waren
    // schon konfigurierbar, das Feld selbst nicht.
    this._addPlaceholderKey = 'category.addPlaceholder';
    // Was das Loeschen anrichtet, entscheidet der Server des jeweiligen Moduls,
    // nicht diese Komponente: Budget/Tasks/Kontakte weisen benutzte Kategorien
    // mit 409 ab, Einkauf schiebt die Artikel auf eine Ersatzkategorie und der
    // Vorrat laesst sie unzugeordnet zurueck. Ein geteilter Folgentext waere
    // fuer zwei der fuenf Aufrufer schlicht falsch - dieselbe Falle wie beim
    // Platzhalter oben, nur folgenreicher.
    // Auch die FRAGE gehoert dem Aufrufer, nicht nur die Folgenbeschreibung:
    // wer Laeden verwaltet, liest sonst "Kategorie „Rewe" loeschen?" in einem
    // Dialog, der "Laeden verwalten" heisst.
    this._deleteConfirmKey = 'category.deleteConfirm';
    this._deleteDetailKey = 'category.deleteConfirmDetail';
    this._subDeleteDetailKey = 'category.deleteSubConfirmDetail';
    // OPT-IN: nur wer eine Palette mitgibt, bekommt die Farbwahl. Fuenf der
    // sechs Aufrufer zeigen ihre Kategorien nirgends als farbige Marke - dort
    // waere ein Farbknopf eine Einstellung ohne Wirkung.
    this._colors = [];
    // Optional note-category presentation: one shared name+scope form instead
    // of one add form per group, plus a caller-provided row glyph.
    this._unifiedAdd = false;
    this._rowIconResolver = null;
    this._addScopeLabelKey = 'noteCategories.scopeLabel';
    this._addScopeHelpKey = '';
    this._addMaxLength = 60;
    this._cats = [];
    this._sortables = [];
    this._onClick = this._onClick.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
  }

  configure(opts) {
    this._basePath = opts.basePath;
    if (Array.isArray(opts.groups) && opts.groups.length) this._groups = opts.groups;
    if (typeof opts.groupField === 'string' && opts.groupField) this._groupField = opts.groupField;
    this._supportsSub = !!opts.supportsSubcategories;
    if (typeof opts.labelResolver === 'function') this._labelResolver = opts.labelResolver;
    if (opts.titleKey) this._titleKey = opts.titleKey;
    if (opts.hintKey) this._hintKey = opts.hintKey;
    if (opts.addPlaceholderKey) this._addPlaceholderKey = opts.addPlaceholderKey;
    if (Array.isArray(opts.colors)) this._colors = opts.colors;
    this._unifiedAdd = !!opts.unifiedAdd;
    this._rowIconResolver = typeof opts.rowIconResolver === 'function' ? opts.rowIconResolver : null;
    if (opts.addScopeLabelKey) this._addScopeLabelKey = opts.addScopeLabelKey;
    if (opts.addScopeHelpKey) this._addScopeHelpKey = opts.addScopeHelpKey;
    if (Number.isInteger(opts.addMaxLength) && opts.addMaxLength > 0) {
      this._addMaxLength = opts.addMaxLength;
    }
    if (opts.deleteConfirmKey) this._deleteConfirmKey = opts.deleteConfirmKey;
    if (opts.deleteDetailKey) this._deleteDetailKey = opts.deleteDetailKey;
    if (opts.subDeleteDetailKey) this._subDeleteDetailKey = opts.subDeleteDetailKey;
    this._renderShell();
    this._load();
  }

  disconnectedCallback() {
    this._disposeScopeHelp?.();
    this._root?.removeEventListener('click', this._onClick);
    this._root?.removeEventListener('submit', this._onSubmit);
    this._destroySortables();
  }

  _renderShell() {
    this.replaceChildren();
    // Der Titel wird bewusst NICHT gerendert: die Komponente lebt stets in einem
    // Modal, dessen Kopfzeile denselben Titel (titleKey) bereits zeigt — ein
    // eigenes <h3> wäre eine sicht- und vorlesbare Dopplung. titleKey bleibt in
    // configure() akzeptiert (Aufrufer unverändert), steuert aber nur den Modal-Titel.
    this.insertAdjacentHTML('beforeend', `
      <div class="cat-manager">
        <p class="cat-manager__hint">${esc(t(this._hintKey))}</p>
        <div class="sr-only" role="status" aria-live="polite" id="cat-manager-announce"></div>
        <div class="cat-manager__groups" id="cat-manager-groups"></div>
      </div>`);
    this._root = this.querySelector('.cat-manager');
    this._groupsEl = this.querySelector('#cat-manager-groups');
    this._announceEl = this.querySelector('#cat-manager-announce');
    this._root.addEventListener('click', this._onClick);
    this._root.addEventListener('submit', this._onSubmit);
  }

  // GET ohne Render: setzt this._cats aus der Server-Antwort. Wirft weiter,
  // damit der aufrufende Mutations-Handler (mit eigenem try/catch) selbst
  // entscheidet, welchen Ausschnitt er danach neu zeichnet.
  async _fetch() {
    const res = await api.get(this._basePath);
    this._cats = res.data ?? [];
  }

  // Voll-Load: Erstbefüllung (configure) und generischer Refresh — lädt und
  // baut die gesamte Komponente neu auf.
  async _load() {
    try {
      await this._fetch();
      this._render();
    } catch (err) {
      window.yuvomi?.showToast(this._errMsg(err), 'danger');
    }
  }

  _inGroup(groupKey) {
    if (!groupKey) return this._cats;
    return this._cats.filter((c) => this._groupOf(c) === groupKey);
  }

  _groupOf(item) {
    return item?.[this._groupField] ?? item?.type ?? item?.group ?? '';
  }

  /* Stabiler Zeilen-Schlüssel: Budget/Tasks/Kontakte liefern `key`,
   * Einkauf numerische `id` (Audit F-15 — eine Komponente für alle vier). */
  _keyOf(item) {
    return String(item.key ?? item.id);
  }

  // Markup einer Gruppen-Sektion (cat-list + Add-Form; Sublists stecken in den
  // Zeilen via _rowHtml→_subListHtml). Geteilt von Voll- und Teil-Render.
  _groupSectionHtml(g) {
    const items = this._inGroup(g.key);
    return `
      <section class="cat-group" data-group="${esc(g.key)}">
        ${g.labelKey ? `<h4 class="cat-group__title">${esc(t(g.labelKey))}</h4>` : ''}
        <ul class="cat-list">
          ${items.map((c, i) => this._rowHtml(c, g, i === 0, i === items.length - 1)).join('')}
        </ul>
        ${this._unifiedAdd ? '' : `<form class="cat-add-form" data-group="${esc(g.key)}" novalidate autocomplete="off">
          <input class="form-input" type="text" maxlength="${this._addMaxLength}"
                 placeholder="${esc(t(this._addPlaceholderKey))}"
                 aria-label="${esc(t(this._addPlaceholderKey))}" />
          <button type="submit" class="btn btn--primary">${esc(t(g.addLabelKey || 'common.add'))}</button>
        </form>`}
      </section>`;
  }

  _unifiedAddFormHtml() {
    if (!this._unifiedAdd) return '';
    const hasScopeChoice = this._groups.length > 1;
    const help = hasScopeChoice && this._addScopeHelpKey
      ? `<button type="button" class="category-scope-help" aria-expanded="false" aria-label="${esc(t(this._addScopeHelpKey))}">
          <i data-lucide="info" aria-hidden="true"></i>
          <span class="category-scope-help__tooltip u-meta" id="cat-manager-scope-help" role="tooltip">${esc(t(this._addScopeHelpKey))}</span>
        </button>`
      : '';
    return `<form class="cat-add-form cat-add-form--unified" data-group="${esc(this._groups[0]?.key ?? '')}"
                  novalidate autocomplete="off">
      <input class="form-input" type="text" maxlength="${this._addMaxLength}"
             placeholder="${esc(t(this._addPlaceholderKey))}"
             aria-label="${esc(t(this._addPlaceholderKey))}" />
      ${hasScopeChoice ? `<div class="cat-add-form__scope">
        <select class="form-input" name="category-scope" aria-label="${esc(t(this._addScopeLabelKey))}"
                ${help ? 'aria-describedby="cat-manager-scope-help"' : ''}>
          ${this._groups.map((group) => `<option value="${esc(group.key)}">${esc(t(group.labelKey))}</option>`).join('')}
        </select>${help}
      </div>` : ''}
      <button type="submit" class="btn btn--primary">${esc(t(this._groups[0]?.addLabelKey || 'common.add'))}</button>
    </form>`;
  }

  // Läuft irgendwo ein Drag (z. B. eine zweite Zeile, die gezogen wird, während
  // der vorige Drag noch auf _persistOrder wartet)? Dann den Render bis zum
  // nächsten Frame verschieben, statt die aktive Sortable-Instanz mitten im Zug
  // zu zerstören und den laufenden Drag kommentarlos abzubrechen. Teil-Renderer
  // fallen in diesem seltenen Fall bewusst auf den (deferten) Voll-Render zurück.
  _deferForDrag() {
    if (!isDragActive()) return false;
    if (!this._renderDeferred) {
      this._renderDeferred = true;
      requestAnimationFrame(() => { this._renderDeferred = false; this._render(); });
    }
    return true;
  }

  // Voll-Render: baut alle Gruppen neu auf. Erstbefüllung + Fallback, wenn ein
  // Teil-Render sein Ziel nicht findet.
  _render() {
    if (!this._groupsEl) return;
    if (this._deferForDrag()) return;
    this._destroySortables();
    this._groupsEl.replaceChildren();
    this._groups.forEach((g) => {
      const tmp = document.createElement('div');
      tmp.insertAdjacentHTML('beforeend', this._groupSectionHtml(g));
      this._groupsEl.appendChild(tmp.firstElementChild);
    });
    this._groupsEl.insertAdjacentHTML('beforeend', this._unifiedAddFormHtml());
    this._wireScopeHelp();
    if (window.lucide) window.lucide.createIcons({ el: this._groupsEl });
    this._wireSortableIn(this._groupsEl);
  }

  _wireScopeHelp() {
    this._disposeScopeHelp?.();
    this._disposeScopeHelp = wireCategoryScopeHelp(this.closest?.('.modal-panel') || this._groupsEl);
  }

  // Teil-Render einer einzelnen Gruppe: baut nur deren Sektion (cat-list +
  // Add-Form + eigene Sublists) neu und verdrahtet ausschließlich deren
  // Sortable-Instanzen neu — andere Gruppen (samt Instanzen) bleiben unberührt.
  // Fällt bei laufendem Drag oder fehlender Sektion auf den Voll-Render zurück.
  _renderGroup(groupKey) {
    if (!this._groupsEl) return;
    if (this._deferForDrag()) return;
    const g = this._groups.find((gr) => gr.key === groupKey);
    const oldSection = this._groupsEl.querySelector(`.cat-group[data-group="${CSS.escape(groupKey ?? '')}"]`);
    if (!g || !oldSection) { this._render(); return; }
    this._destroySortablesIn(oldSection);
    const tmp = document.createElement('div');
    tmp.insertAdjacentHTML('beforeend', this._groupSectionHtml(g));
    const newSection = tmp.firstElementChild;
    oldSection.replaceWith(newSection);
    if (window.lucide) window.lucide.createIcons({ el: newSection });
    this._wireSortableIn(newSection);
  }

  // Teil-Render einer einzelnen Sublist: ersetzt nur die cat-sublist eines
  // Parents und verdrahtet deren Sub-Sortable neu; die cat-list-Instanz des
  // Parents bleibt bestehen (die Sublist ist Enkel der Liste, kein direktes
  // Listen-Kind). Fällt bei Drag oder fehlendem Ziel auf den Voll-Render zurück.
  _renderSublist(parentKey) {
    if (!this._groupsEl || !this._supportsSub) return;
    if (this._deferForDrag()) return;
    const cat = this._cats.find((c) => this._keyOf(c) === parentKey);
    const groupKey = cat ? this._groupOf(cat) : '';
    const g = this._groups.find((gr) => gr.key === groupKey);
    const row = this._groupsEl.querySelector(`.cat-row[data-key="${CSS.escape(parentKey ?? '')}"]`);
    if (!cat || !g || !row) { this._render(); return; }
    const oldSub = row.querySelector(`:scope > .cat-sublist[data-parent="${CSS.escape(parentKey ?? '')}"]`);
    const tmp = document.createElement('div');
    tmp.insertAdjacentHTML('beforeend', this._subListHtml(cat, g));
    const newSub = tmp.firstElementChild; // null, wenn die Gruppe keine Sublists führt
    if (oldSub) this._destroySortablesIn(oldSub);
    if (oldSub && newSub) oldSub.replaceWith(newSub);
    else if (oldSub) oldSub.remove();
    else if (newSub) row.appendChild(newSub);
    else return;
    if (newSub) {
      if (window.lucide) window.lucide.createIcons({ el: newSub });
      this._wireSortableIn(row);
    }
  }

  /* Drag ist nie der einzige Weg: die Auf/Ab-Buttons in _rowHtml/_subListHtml
   * bleiben der tastaturbedienbare Reorder-Pfad und rufen denselben
   * _persistOrder/_persistSubOrder-Handler wie das Drag-Ende auf.
   *
   * Scope-fähig: `root` ist beim Voll-Render der Groups-Container, beim
   * Teil-Render nur die neu gebaute Gruppen-Sektion bzw. Parent-Zeile — so
   * werden ausschließlich die Listen des neu gezeichneten Ausschnitts verdrahtet. */
  _wireSortableIn(root) {
    root.querySelectorAll('.cat-list').forEach((listEl) => {
      const groupKey = listEl.closest('.cat-group')?.dataset.group ?? '';
      makeSortable(listEl, {
        handle: '.cat-row__handle',
        onEnd: (evt) => {
          const movedKey = evt.item?.dataset.key;
          const orderedKeys = Array.from(listEl.children).map((el) => el.dataset.key);
          // Nur der Drag-Pfad hat das DOM schon optimistisch umgestellt (SortableJS
          // verschiebt vor dem PATCH); ein Fehler braucht daher hier einen
          // Rollback-Render. Der Button-Pfad (_move) mutiert das DOM nie vorab.
          this._persistOrder(groupKey, orderedKeys, movedKey, { rollbackRender: true });
        },
      }).then((instance) => this._trackSortable(instance, listEl)).catch((err) => this._warnDragUnavailable(err));
    });
    if (!this._supportsSub) return;
    root.querySelectorAll('.cat-sublist').forEach((subListEl) => {
      const parentKey = subListEl.dataset.parent;
      makeSortable(subListEl, {
        handle: '.cat-subrow__handle',
        draggable: '.cat-subrow',
        onEnd: (evt) => {
          const movedSubKey = evt.item?.dataset.subkey;
          const orderedSubKeys = Array.from(subListEl.children)
            .filter((el) => el.matches('.cat-subrow'))
            .map((el) => el.dataset.subkey);
          this._persistSubOrder(parentKey, orderedSubKeys, movedSubKey, { rollbackRender: true });
        },
      }).then((instance) => this._trackSortable(instance, subListEl)).catch((err) => this._warnDragUnavailable(err));
    });
  }

  // Instanzen einer inzwischen überholten _render()-Runde (Element schon aus
  // dem DOM entfernt, bevor der lazy SortableJS-Import fertig war) sofort
  // wieder freigeben statt sie in _sortables mitzuführen.
  _trackSortable(instance, el) {
    if (!instance) return;
    if (el.isConnected) this._sortables.push(instance);
    else instance.destroy();
  }

  _destroySortables() {
    this._sortables.forEach((s) => s?.destroy?.());
    this._sortables = [];
  }

  // Nur die Sortable-Instanzen freigeben, deren Liste (s.el) innerhalb von
  // `container` liegt — für Teil-Render, der andere Listen unangetastet lässt.
  // Vor dem DOM-Austausch aufrufen, solange s.el noch Nachfahre von container ist.
  _destroySortablesIn(container) {
    this._sortables = this._sortables.filter((s) => {
      if (s?.el && container.contains(s.el)) { s.destroy?.(); return false; }
      return true;
    });
  }

  // Nach einem erfolgreichen Button-Reorder den Fokus auf der bewegten Zeile
  // halten: der Teil-Render hat den geklickten Auf/Ab-Button neu gebaut, sonst
  // fiele der Fokus auf <body>. Bevorzugt die gedrückte Richtung; ist dieser
  // Button am Listenrand nun deaktiviert, auf die Gegenrichtung ausweichen,
  // sonst auf den Umbenennen-Button (letzter Rückfall, nie <body>). Nur der
  // Button-Pfad ruft das auf — der Drag-Pfad übergibt bewusst keine Fokus-Absicht.
  _restoreReorderFocus(rowSelector, dir, prefix = '') {
    const row = this._groupsEl?.querySelector(rowSelector);
    if (!row) return;
    const pick = (action) => {
      const el = row.querySelector(`[data-action="${action}"]`);
      return el && !el.disabled ? el : null;
    };
    const opposite = dir === 'down' ? 'up' : 'down';
    const target = pick(`${prefix}${dir}`)
      || pick(`${prefix}${opposite}`)
      || row.querySelector(`[data-action="${prefix}rename"]`);
    target?.focus();
  }

  // Einmalig warnen, wenn der lazy SortableJS-Import scheitert (statt bei jedem
  // Render still zu schlucken): Drag bleibt unverfügbar, die Auf/Ab-Buttons
  // funktionieren unbeeinflusst weiter. Diagnose-Log, kein Nutzer-Toast.
  _warnDragUnavailable(err) {
    if (this._dragWarned) return;
    this._dragWarned = true;
    console.warn('[yuvomi-category-manager] Drag-and-Drop nicht verfügbar (SortableJS-Import fehlgeschlagen); Auf/Ab-Buttons bleiben nutzbar.', err);
  }

  _announce(message) {
    if (this._announceEl) this._announceEl.textContent = message;
  }

  // Ungespeicherten Text in offenen „Kategorie hinzufügen"-Feldern über einen
  // (Rollback-)Rebuild retten: der Teil-Render verwirft die Formulare des neu
  // gebauten Ausschnitts, also die Werte vorher pro Gruppe/Elternschlüssel
  // einsammeln und danach zurückschreiben (nicht neu gebaute Felder bleiben
  // unberührt, das Zurückschreiben ist für sie ein No-op).
  _snapshotAddInputs() {
    const snapshot = [];
    this._groupsEl?.querySelectorAll('.cat-add-form, .cat-subadd-form').forEach((form) => {
      const input = form.querySelector('input');
      if (input?.value) {
        snapshot.push({
          isSub: form.classList.contains('cat-subadd-form'),
          match: form.dataset.parent ?? form.dataset.group ?? '',
          value: input.value,
        });
      }
    });
    return snapshot;
  }

  _restoreAddInputs(snapshot) {
    if (!snapshot?.length) return;
    snapshot.forEach(({ isSub, match, value }) => {
      const sel = isSub
        ? `.cat-subadd-form[data-parent="${CSS.escape(match)}"]`
        : `.cat-add-form[data-group="${CSS.escape(match)}"]`;
      const input = this._groupsEl?.querySelector(sel)?.querySelector('input');
      if (input) input.value = value;
    });
  }

  _rowHtml(cat, group, isFirst, isLast) {
    return `
      <li class="cat-row" data-key="${esc(this._keyOf(cat))}">
        <span class="cat-row__handle" role="img" aria-label="${esc(t('category.dragHandle'))}" title="${esc(t('category.dragHandle'))}">
          <i data-lucide="grip-vertical" class="icon-sm" aria-hidden="true"></i>
        </span>
        ${this._markHtml(cat)}
        <button type="button" class="cat-row__name" data-action="rename"
              title="${esc(t('category.renameHint'))}">${esc(this._labelResolver(cat))}</button>
        <div class="cat-row__actions">
          <button class="btn btn--icon btn--ghost" data-action="rename"
                  aria-label="${esc(t('category.renameHint'))}" title="${esc(t('category.renameHint'))}">
            <i data-lucide="pencil" class="icon-sm" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon btn--ghost" data-action="up"
                  aria-label="${esc(t('category.moveUp'))}" ${isFirst ? 'disabled' : ''}>
            <i data-lucide="chevron-up" class="icon-md" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon btn--ghost" data-action="down"
                  aria-label="${esc(t('category.moveDown'))}" ${isLast ? 'disabled' : ''}>
            <i data-lucide="chevron-down" class="icon-md" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon btn--danger-outline" data-action="delete"
                  aria-label="${esc(t('category.delete'))}">
            <i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i>
          </button>
        </div>
        ${this._colorStripHtml(cat)}
        ${this._subListHtml(cat, group)}
      </li>`;
  }

  /**
   * Das Zeichen der Zeile - als Vollton-Marke, wo eine Palette konfiguriert ist.
   *
   * Die Marke IST die Vorschau: sie zeigt Ton und Glyph genau so, wie die
   * Kategorie danach in der Liste steht (Vollton-Regel, DESIGN.md). Ohne
   * kuratierten Ton bleibt sie neutral - auch das ist die Vorschau, nicht ein
   * Fehlen.
   */
  _markHtml(cat) {
    const icon = this._rowIconResolver?.(cat) || cat.icon;
    // Ohne Palette bleibt es beim nackten Zeichen - fuenf der sechs Aufrufer
    // zeigen ihre Kategorien nirgends als farbige Marke.
    if (!this._colors.length) {
      return icon
        ? `<i data-lucide="${esc(icon)}" class="cat-row__icon icon-md" aria-hidden="true"></i>`
        : '';
    }
    const glyph = icon
      ? `<i data-lucide="${esc(icon)}" class="icon-md" aria-hidden="true"></i>`
      : '';
    const vivid = cat.color ? ' vivid-mark' : '';
    const style = cat.color ? ` style="--seal-accent:${esc(cat.color)}"` : '';
    return `
      <button type="button" class="cat-row__mark${vivid}" data-action="color"
              aria-expanded="false" aria-label="${esc(t('category.colorPick'))}"
              title="${esc(t('category.colorPick'))}"${style}>${glyph}</button>`;
  }

  /**
   * Die Palette einer Zeile, eingeklappt bis jemand die Marke drueckt.
   *
   * Immer sichtbar waeren es acht Punkte MAL sieben Zeilen in einem kleinen
   * Dialog; als Aufklapper zeigt die Zeile ihren Ton und die Wahl erscheint
   * dort, wo sie gebraucht wird. `radiogroup`, weil genau einer gilt.
   */
  _colorStripHtml(cat) {
    if (!this._colors.length) return '';
    // `data-tab-id` statt eines eigenen Attributs: den Streifen bedient
    // `wireTablist(mode: 'select')`, und der liefert Pfeiltasten,
    // Roving-Tabindex und aria-checked - das vorgeschriebene Muster fuer eine
    // radiogroup. Eine handgeschriebene Tastaturschleife waere hier die zweite
    // Fassung derselben zwanzig Zeilen (der Kalender hat eine aeltere).
    const swatch = (value, labelKey) => {
      const on = (cat.color ?? '') === value;
      return `<button type="button" role="radio" aria-checked="${on}"
        class="cat-color-swatch${on ? ' cat-color-swatch--active' : ''}${value ? ' vivid-mark' : ''}"
        data-tab-id="${esc(value || NO_COLOR_ID)}"
        tabindex="${on ? '0' : '-1'}"
        aria-label="${esc(t(labelKey))}" title="${esc(t(labelKey))}"
        ${value ? `style="--seal-accent:${esc(value)}"` : ''}></button>`;
    };
    return `
      <div class="cat-row__colors" role="radiogroup"
           aria-label="${esc(t('category.colorPick'))}" hidden>
        ${swatch('', 'category.colorNone')}
        ${this._colors.map((c, i) => swatch(c, COLOR_LABEL_KEYS[i] ?? 'category.colorPick')).join('')}
      </div>`;
  }

  _subListHtml(cat, group) {
    if (!this._supportsSub || !group?.subcategories) return '';
    const subs = cat.subcategories || [];
    return `
      <ul class="cat-sublist" data-parent="${esc(this._keyOf(cat))}">
        ${subs.map((s, j, arr) => `
          <li class="cat-subrow" data-subkey="${esc(this._keyOf(s))}" data-parent="${esc(this._keyOf(cat))}">
            <span class="cat-subrow__handle" role="img" aria-label="${esc(t('category.dragHandle'))}" title="${esc(t('category.dragHandle'))}">
              <i data-lucide="grip-vertical" class="icon-sm" aria-hidden="true"></i>
            </span>
            <button type="button" class="cat-subrow__name" data-action="sub-rename">${esc(this._labelResolver(s))}</button>
            <div class="cat-row__actions">
              <button class="btn btn--icon btn--ghost" data-action="sub-rename" aria-label="${esc(t('category.renameHint'))}" title="${esc(t('category.renameHint'))}">
                <i data-lucide="pencil" class="icon-sm" aria-hidden="true"></i></button>
              <button class="btn btn--icon btn--ghost" data-action="sub-up" aria-label="${esc(t('category.moveUp'))}" ${j === 0 ? 'disabled' : ''}>
                <i data-lucide="chevron-up" class="icon-sm" aria-hidden="true"></i></button>
              <button class="btn btn--icon btn--ghost" data-action="sub-down" aria-label="${esc(t('category.moveDown'))}" ${j === arr.length - 1 ? 'disabled' : ''}>
                <i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i></button>
              <button class="btn btn--icon btn--danger-outline" data-action="sub-delete" aria-label="${esc(t('category.delete'))}">
                <i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i></button>
            </div>
          </li>`).join('')}
        <li><form class="cat-subadd-form" data-parent="${esc(this._keyOf(cat))}" novalidate autocomplete="off">
          <input class="form-input" type="text" maxlength="60" placeholder="${esc(t('category.addSubPlaceholder'))}" aria-label="${esc(t('category.addSubPlaceholder'))}" />
          <button type="submit" class="btn btn--secondary">${esc(t('common.add'))}</button>
        </form></li>
      </ul>`;
  }

  /**
   * BEIM LOESCHEN KOMMT DIESES EREIGNIS, WENN DAS ELEMENT SCHON AUS DEM DOKUMENT
   * IST (gemessen 08.09.2026 im laufenden Browser: `document.contains(el)` ist
   * dann false).
   *
   * `_delete()` fragt ueber `confirmOverModal`, und das schliesst nach einem Ja
   * das Modal darunter gleich mit ab (`closeModal({ force: true })`), BEVOR es
   * zurueckkehrt - `api.delete` laeuft also erst danach. Fuer die Aufrufer folgen
   * daraus zwei Dinge, und beide gelten fuer JEDEN von ihnen:
   *
   *   - Kein `removeEventListener` in onClose. Wer beim Schliessen abmeldet,
   *     verpasst genau die Loeschung - und behaelt einen lokalen Stand, der eine
   *     Kategorie anbietet, die der Server nicht mehr kennt. Ein Leck entsteht
   *     dadurch nicht: das Element entsteht je Oeffnen neu und wird mit dem
   *     Overlay verworfen, der Listener geht mit ihm.
   *   - Kein `changed`-Merker, der in onClose ausgewertet wird. Er stuende beim
   *     Loeschen auf false. Die Auffrischung gehoert in den Handler selbst.
   */
  _notifyChanged(detail = {}) {
    this.dispatchEvent(new CustomEvent('category-manager-changed', { bubbles: true, detail }));
  }

  // Server-Guard-Fehler in die UI-Sprache übersetzen: die Route liefert einen
  // stabilen `reason`-Code (+ optional `count`) in err.data; unbekannte Fehler
  // fallen auf die (englische) Server-Meldung zurück.
  _errMsg(err) {
    const reason = err?.data?.reason;
    const count = err?.data?.count;
    switch (reason) {
      case 'category_in_use':    return t('category.errorInUse', { count });
      case 'category_last':      return t('category.errorLast');
      case 'category_exists':    return t('category.errorExists');
      case 'subcategory_in_use': return t('category.errorSubInUse', { count });
      case 'subcategory_last':   return t('category.errorSubLast');
      case 'subcategory_exists': return t('category.errorSubExists');
      default:                   return err?.message ?? '';
    }
  }

  async _onSubmit(e) {
    e.preventDefault();
    const subForm = e.target.closest('.cat-subadd-form');
    if (subForm) {
      const input = subForm.querySelector('input');
      const name = input.value.trim();
      if (!name) return;
      await this._subAdd(subForm.dataset.parent, name);
      return;
    }
    const form = e.target.closest('.cat-add-form');
    if (!form) return;
    const input = form.querySelector('input');
    const name = input.value.trim();
    if (!name) return;
    const group = form.querySelector('[name="category-scope"]')?.value || form.dataset.group;
    try {
      const body = { name };
      if (group) body[this._groupField] = group;
      const res = await api.post(this._basePath, body);
      this._cats.push(res.data);
      this._renderGroup(group ?? '');
      if (this._unifiedAdd) input.value = '';
      window.yuvomi?.showToast(t('category.added'), 'success');
      this._notifyChanged();
    } catch (err) {
      window.yuvomi?.showToast(this._errMsg(err), 'danger');
    }
  }

  async _onClick(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (action.startsWith('sub-')) {
      const subRow = target.closest('[data-subkey]');
      if (!subRow) return;
      const parent = subRow.dataset.parent;
      const subKey = subRow.dataset.subkey;
      if (action === 'sub-rename') await this._subRename(parent, subKey);
      else if (action === 'sub-up') await this._subMove(parent, subKey, -1);
      else if (action === 'sub-down') await this._subMove(parent, subKey, 1);
      else if (action === 'sub-delete') await this._subDelete(parent, subKey);
      return;
    }
    const row = target.closest('[data-key]');
    if (!row) return;
    const key = row.dataset.key;
    if (action === 'color') { this._toggleColors(row); return; }
    if (action === 'rename') await this._rename(key);
    else if (action === 'up') await this._move(key, -1);
    else if (action === 'down') await this._move(key, 1);
    else if (action === 'delete') await this._delete(key);
  }

  _toggleColors(row) {
    const strip = row.querySelector('.cat-row__colors');
    const btn = row.querySelector('.cat-row__mark');
    if (!strip || !btn) return;
    const open = strip.hidden;
    // Erst beim Aufklappen verdrahten: der Streifen wird bei jedem
    // Gruppen-Render neu gebaut, und eine Verdrahtung im Voraus waere N
    // Listener fuer eine Palette, die meistens niemand oeffnet.
    if (open && !strip.dataset.wired) {
      strip.dataset.wired = '1';
      const cat = this._cats.find((c) => this._keyOf(c) === row.dataset.key);
      wireTablist(strip, {
        activeId: cat?.color || NO_COLOR_ID,
        activeClass: 'cat-color-swatch--active',
        mode: 'select',
        onChange: (id) => this._setColor(row.dataset.key, id === NO_COLOR_ID ? '' : id),
      });
    }
    // Nur eine Palette gleichzeitig: zwei offene Streifen in einer kurzen
    // Liste lesen sich als Mehrfachauswahl.
    for (const other of this.querySelectorAll('.cat-row__colors')) other.hidden = true;
    for (const other of this.querySelectorAll('.cat-row__mark')) other.setAttribute('aria-expanded', 'false');
    strip.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) strip.querySelector('[aria-checked="true"], .cat-color-swatch')?.focus();
  }

  async _setColor(key, color) {
    const cat = this._cats.find((c) => this._keyOf(c) === key);
    if (!cat || (cat.color ?? '') === color) return;
    try {
      // NUR die Farbe schicken: der Name der sieben Seed-Kategorien lebt als
      // `label_key` und wuerde beim Mitschicken auf die Sprache dieses
      // Klienten festgenagelt (siehe die Route).
      const res = await api.put(`${this._basePath}/${encodeURIComponent(key)}`, { color: color || null });
      const idx = this._cats.findIndex((c) => this._keyOf(c) === key);
      if (idx >= 0) this._cats[idx] = res.data;
      // KEIN Re-Render der Gruppe, und das ist keine Optimierung: eine
      // radiogroup wechselt bei JEDER Pfeiltaste ihren Wert. Ein Neubau der
      // Zeilen nimmt dabei den Fokus mit und schliesst den Streifen - nach
      // genau einem Schritt waere die Tastaturbedienung zu Ende. Geaendert hat
      // sich ohnehin nur die Marke.
      this._paintMark(key, res.data.color);
      this._notifyChanged();
    } catch (err) {
      window.yuvomi?.showToast(this._errMsg(err), 'danger');
    }
  }

  /** Die Marke einer Zeile auf einen neuen Ton setzen, ohne die Zeile neu zu bauen. */
  _paintMark(key, color) {
    const mark = this.querySelector(`[data-key="${CSS.escape(String(key))}"] .cat-row__mark`);
    if (!mark) return;
    mark.classList.toggle('vivid-mark', !!color);
    if (color) mark.style.setProperty('--seal-accent', color);
    else mark.style.removeProperty('--seal-accent');
  }

  async _rename(key) {
    const cat = this._cats.find((c) => this._keyOf(c) === key);
    if (!cat) return;
    const { promptModal, captureModalContext, isModalContextCurrent } = await import('/components/modal.js');
    const current = this._labelResolver(cat);
    let promptValue = current;
    while (true) {
      const newName = await promptModal(t('category.renamePrompt'), promptValue);
      if (!newName || newName === current) return;
      const modalContext = captureModalContext();
      try {
        const res = await api.put(`${this._basePath}/${encodeURIComponent(key)}`, { name: newName });
        const idx = this._cats.findIndex((c) => this._keyOf(c) === key);
        if (idx >= 0) this._cats[idx] = res.data;
        this._renderGroup(this._groupOf(cat));
        window.yuvomi?.showToast(t('category.renamed'), 'success');
        this._notifyChanged();
        return;
      } catch (err) {
        window.yuvomi?.showToast(this._errMsg(err), 'danger');
        if (err?.status !== 409) return;
        // Der 409 darf nur den Prompt wiederholen, aus dem diese Anfrage kam.
        // Ein inzwischen geoeffnetes (selbst schon wieder geschlossenes)
        // Modal oder eine neue Seiteninstanz besitzt den Shared-Slot; dort
        // wuerde promptModal() den fremden Dialog sonst mit force wegraeumen.
        if (!isModalContextCurrent(modalContext)) return;
        promptValue = newName;
      }
    }
  }

  async _move(key, delta) {
    const cat = this._cats.find((c) => this._keyOf(c) === key);
    if (!cat) return;
    const groupKey = this._groupOf(cat);
    // Auf einer Kopie arbeiten: _inGroup('') liefert bei gruppenlosen Modulen
    // (z. B. Kontakte) die LIVE-this._cats-Referenz zurück. Ein In-place-Swap
    // würde den State schon vor der Persistenz optimistisch umstellen — bei einem
    // fehlgeschlagenen Reorder (Button-Pfad rendert dann bewusst nicht) bliebe
    // this._cats in der ungespeicherten Reihenfolge zurück und der nächste
    // _render() zeigte sie an. Nur die berechnete Schlüsselliste zählt hier.
    const group = this._inGroup(groupKey).slice();
    const idx = group.findIndex((c) => this._keyOf(c) === key);
    const nextIdx = idx + delta;
    if (idx < 0 || nextIdx < 0 || nextIdx >= group.length) return;
    [group[idx], group[nextIdx]] = [group[nextIdx], group[idx]];
    // Fokus-Absicht mitgeben: nur der Button-Pfad (nicht Drag) soll den Fokus
    // nach dem Teil-Render auf der bewegten Zeile halten.
    await this._persistOrder(groupKey, group.map((c) => this._keyOf(c)), key, {
      focusKey: key,
      focusDir: delta > 0 ? 'down' : 'up',
    });
  }

  // Gemeinsamer Persistenz-Pfad für Auf/Ab-Buttons UND Drag-Ende (_wireSortableIn):
  // beide berechnen nur die neue Reihenfolge, dieser Handler übernimmt PATCH +
  // Refresh + Ansage. Bei Erfolg ersetzt die volle Server-Liste (contacts/tasks/
  // shopping liefern sie im PATCH bereits mit) den State direkt; nur Antworten
  // ohne Liste (budget: {data:true}) holen den Stand per zusätzlichem GET nach.
  // Bei Fehlern rollt NUR der Drag-Pfad zurück (rollbackRender): SortableJS hat
  // das DOM schon optimistisch umgestellt, ein Rebuild aus dem unveränderten
  // State stellt die servergültige Reihenfolge wieder her. Der Button-Pfad
  // rendert bewusst NICHT (sonst Fokusverlust auf dem gerade geklickten Auf/Ab-
  // Button und Verlust ungespeicherten Texts in offenen Add-Feldern).
  async _persistOrder(groupKey, orderedKeys, movedKey, { rollbackRender = false, focusKey = null, focusDir = null } = {}) {
    try {
      const body = { order: orderedKeys };
      if (groupKey) body[this._groupField] = groupKey;
      const res = await api.patch(`${this._basePath}/reorder`, body);
      if (Array.isArray(res?.data)) this._cats = res.data;
      else await this._fetch();
      this._renderGroup(groupKey);
      if (focusKey) this._restoreReorderFocus(`.cat-row[data-key="${CSS.escape(focusKey)}"]`, focusDir);
      if (movedKey) this._announceMove(movedKey, { groupKey });
      this._notifyChanged();
    } catch (err) {
      window.yuvomi?.showToast(this._errMsg(err), 'danger');
      if (rollbackRender) {
        const inputs = this._snapshotAddInputs();
        this._renderGroup(groupKey);
        this._restoreAddInputs(inputs);
      }
    }
  }

  // Position/Gesamtzahl NACH dem Refresh aus dem frischen State neu bestimmen
  // (nicht aus dem vor dem await berechneten orderedKeys-Array): bei einer
  // nebenläufigen Änderung könnte die lokal berechnete Liste sonst von der
  // tatsächlich gerenderten abweichen.
  _announceMove(key, { groupKey = null, parentKey = null } = {}) {
    let list;
    let cat;
    if (parentKey != null) {
      const found = this._findSub(parentKey, key);
      if (!found) return;
      cat = found.sub;
      list = found.cat.subcategories || [];
    } else {
      list = this._inGroup(groupKey);
      cat = list.find((c) => this._keyOf(c) === key);
    }
    const idx = list.findIndex((c) => this._keyOf(c) === key);
    if (idx < 0) return;
    this._announce(t('category.reorderAnnounce', {
      name: cat ? this._labelResolver(cat) : '',
      position: idx + 1,
      total: list.length,
    }));
  }

  async _delete(key) {
    const cat = this._cats.find((c) => this._keyOf(c) === key);
    if (!cat) return;
    const { confirmOverModal } = await import('/components/modal.js');
    const confirmed = await confirmOverModal(
      t(this._deleteConfirmKey, { name: this._labelResolver(cat) }),
      { danger: true, confirmLabel: t('common.delete'), detail: t(this._deleteDetailKey) }
    );
    if (!confirmed) return;
    try {
      await api.delete(`${this._basePath}/${encodeURIComponent(key)}`);
      this._cats = this._cats.filter((c) => this._keyOf(c) !== key);
      this._renderGroup(this._groupOf(cat));
      window.yuvomi?.showToast(t('category.deleted'), 'default');
      this._notifyChanged({ action: 'delete', key, item: cat });
    } catch (err) {
      window.yuvomi?.showToast(this._errMsg(err), 'danger');
    }
  }

  _findSub(parent, subKey) {
    const cat = this._cats.find((c) => this._keyOf(c) === parent);
    if (!cat) return null;
    const sub = (cat.subcategories || []).find((s) => this._keyOf(s) === subKey);
    return sub ? { cat, sub } : null;
  }

  async _subAdd(parent, name) {
    try {
      const res = await api.post(
        `${this._basePath}/${encodeURIComponent(parent)}/subcategories`,
        { name }
      );
      await this._fetch();
      this._renderSublist(parent);
      window.yuvomi?.showToast(t('category.added'), 'success');
      this._notifyChanged();
      return res;
    } catch (err) {
      window.yuvomi?.showToast(this._errMsg(err), 'danger');
    }
  }

  async _subRename(parent, subKey) {
    const found = this._findSub(parent, subKey);
    if (!found) return;
    const { promptModal } = await import('/components/modal.js');
    const current = this._labelResolver(found.sub);
    const newName = await promptModal(t('category.renamePrompt'), current);
    if (!newName || newName === current) return;
    try {
      await api.put(
        `${this._basePath}/${encodeURIComponent(parent)}/subcategories/${encodeURIComponent(subKey)}`,
        { name: newName }
      );
      await this._fetch();
      this._renderSublist(parent);
      window.yuvomi?.showToast(t('category.renamed'), 'success');
      this._notifyChanged();
    } catch (err) {
      window.yuvomi?.showToast(this._errMsg(err), 'danger');
    }
  }

  async _subMove(parent, subKey, delta) {
    const cat = this._cats.find((c) => this._keyOf(c) === parent);
    if (!cat) return;
    const subs = (cat.subcategories || []).slice();
    const idx = subs.findIndex((s) => this._keyOf(s) === subKey);
    const nextIdx = idx + delta;
    if (idx < 0 || nextIdx < 0 || nextIdx >= subs.length) return;
    [subs[idx], subs[nextIdx]] = [subs[nextIdx], subs[idx]];
    await this._persistSubOrder(parent, subs.map((s) => this._keyOf(s)), subKey, {
      focusSubKey: subKey,
      focusDir: delta > 0 ? 'down' : 'up',
    });
  }

  // Sub-Pendant zu _persistOrder, gleicher Vertrag (Auf/Ab-Buttons + Drag-Ende
  // in _wireSortableIn rufen beide diesen Handler mit der neuen Reihenfolge auf;
  // nur der Drag-Pfad rollt bei Fehlern per rollbackRender zurück).
  async _persistSubOrder(parent, orderedSubKeys, movedSubKey, { rollbackRender = false, focusSubKey = null, focusDir = null } = {}) {
    try {
      const res = await api.patch(
        `${this._basePath}/${encodeURIComponent(parent)}/subcategories/reorder`,
        { order: orderedSubKeys }
      );
      if (Array.isArray(res?.data)) this._cats = res.data;
      else await this._fetch();
      this._renderSublist(parent);
      if (focusSubKey) this._restoreReorderFocus(`.cat-subrow[data-subkey="${CSS.escape(focusSubKey)}"]`, focusDir, 'sub-');
      if (movedSubKey) this._announceMove(movedSubKey, { parentKey: parent });
      this._notifyChanged();
    } catch (err) {
      window.yuvomi?.showToast(this._errMsg(err), 'danger');
      if (rollbackRender) {
        const inputs = this._snapshotAddInputs();
        this._renderSublist(parent);
        this._restoreAddInputs(inputs);
      }
    }
  }

  async _subDelete(parent, subKey) {
    const found = this._findSub(parent, subKey);
    if (!found) return;
    const { confirmOverModal } = await import('/components/modal.js');
    const confirmed = await confirmOverModal(
      t('category.deleteSubConfirm', { name: this._labelResolver(found.sub) }),
      { danger: true, confirmLabel: t('common.delete'), detail: t(this._subDeleteDetailKey) }
    );
    if (!confirmed) return;
    try {
      await api.delete(
        `${this._basePath}/${encodeURIComponent(parent)}/subcategories/${encodeURIComponent(subKey)}`
      );
      await this._fetch();
      this._renderSublist(parent);
      window.yuvomi?.showToast(t('category.deleted'), 'default');
      this._notifyChanged();
    } catch (err) {
      window.yuvomi?.showToast(this._errMsg(err), 'danger');
    }
  }
}

customElements.define('yuvomi-category-manager', CategoryManagerElement);
export { CategoryManagerElement };
