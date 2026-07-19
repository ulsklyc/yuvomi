/**
 * Modul: Kontakte (Contacts)
 * Zweck: Kontaktliste mit Kategorie-Filter, Suche, CRUD, tel:/mailto:/maps-Links
 * Abhängigkeiten: /api.js, /router.js (window.yuvomi)
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, advancedSection } from '/components/modal.js';
import { stagger, vibrate, wireScrollFade, scheduleUndoableDelete } from '/utils/ux.js';
import { t, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { parseVCards } from '/utils/vcard.js';
import { composeDisplayName, contactSortKey, splitDisplayName } from '/utils/contact-name.js';
import '/components/category-manager.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

// Kategorien sind seit #357 benutzer-verwaltbar und werden aus
// /contacts/categories in state.categories geladen. Bestands-Kategorien tragen
// label_key (i18n) + icon; benutzerdefinierte tragen name + Default-Icon 'tag'.
// Der stabile key dient zugleich als CSS-Farb-Slug (.contact-group--<key>).
const FALLBACK_CATEGORY = 'misc';

function catByKey(key) {
  return state.categories.find((c) => c.key === key) || null;
}

// Label auflösen: Seed → i18n via label_key, Custom → name; unbekannt → key.
function catLabel(key) {
  const c = catByKey(key);
  if (!c) return key;
  return c.label_key ? t(c.label_key) : (c.name || c.key);
}

// Sortier-Index einer Kategorie (folgt sort_order); Unbekannte ans Ende.
function catSortIndex(key) {
  const i = state.categories.findIndex((c) => c.key === key);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

// Namens-Sortierung wie der Server: Nachname zuerst, sonst der Anzeigename (#535).
function byName(a, b) {
  return contactSortKey(a).localeCompare(contactSortKey(b));
}

// Liefert das Lucide-Placeholder-Markup für eine Kategorie; aria-hidden, da stets
// von einem Text-Label begleitet. lucide.createIcons() ersetzt den Platzhalter.
function categoryIcon(key, size = 16) {
  const name = catByKey(key)?.icon || 'tag';
  return `<i data-lucide="${esc(name)}" class="contact-cat-icon" style="width:${size}px;height:${size}px;" aria-hidden="true"></i>`;
}

// CSS-Farbton-Klasse aus dem Key. Seed-Keys sind bereits Slugs und matchen
// .contact-group--<key>; migrierte Freitext-Keys (z. B. aus CardDAV, mit
// Leerzeichen) werden auf ein EINZELNES gültiges class-Token normalisiert, damit
// sie die class-Liste nicht spalten — unbekannte Slugs matchen keine Farb-Regel
// und fallen neutral zurück.
function catTintClass(key) {
  const slug = String(key).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `contact-group--${slug}` : '';
}

// Initialen aus dem Namen (max. 2 Buchstaben): Vorname + letzter Namensteil.
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] || '';
  const last  = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

// Avatar einer Zeile: Familien-/Personen-Kontakte zeigen Initialen im Modul-Ton,
// alle anderen das Kategorie-Icon im Kategorie-Ton (--cat der Gruppe).
function contactAvatar(c, size = 20) {
  if (c.family_user_id) {
    return `<span class="contact-item__icon contact-item__icon--initials" aria-hidden="true">${esc(initials(c.name))}</span>`;
  }
  return `<span class="contact-item__icon">${categoryIcon(c.category, size)}</span>`;
}

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = {
  contacts:       [],
  categories:     [],
  activeCategory: null,
  searchQuery:    '',
  selectMode:     false,
  selected:       new Set(),
};
let _container = null;
let contactsSearch = null;

// --------------------------------------------------------
// Entry Point
// --------------------------------------------------------

export async function render(container, { user }) {
  _container = container;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="contacts-page">
      <div class="page-toolbar page-toolbar--wrap contacts-toolbar">
        <h1 class="page-toolbar__title">${t('contacts.title')}</h1>
        ${renderPageSearch({ id: 'contacts-search', label: t('contacts.searchPlaceholder'), placeholder: t('contacts.searchPlaceholder'), value: state.searchQuery, clearLabel: t('common.searchClear'), className: 'contacts-toolbar__search page-toolbar__center' })}
        <div class="page-toolbar__actions">
          <button class="btn btn--icon btn--ghost" id="contacts-manage-cats" aria-label="${t('contacts.manageCategories')}" title="${t('contacts.manageCategories')}">
            <i data-lucide="tags" style="width:16px;height:16px;" aria-hidden="true"></i>
          </button>
          <button class="btn btn--secondary" id="contacts-select-btn" aria-pressed="false">
            <i data-lucide="list-checks" style="width:16px;height:16px;margin-right:4px;" aria-hidden="true"></i>
            ${t('contacts.selectButton')}
          </button>
          <label class="btn btn--secondary" title="${t('contacts.importTooltip')}" aria-label="${t('contacts.importLabel')}">
            <i data-lucide="upload" style="width:16px;height:16px;margin-right:4px;" aria-hidden="true"></i>
            ${t('contacts.importButton')}
            <input type="file" id="contacts-import-input" accept=".vcf,text/vcard" style="display:none">
          </label>
          <button class="btn btn--primary toolbar-new-btn" id="contacts-add-btn">
            <i data-lucide="plus" style="width:16px;height:16px;margin-right:4px;" aria-hidden="true"></i>
            ${t('contacts.addButton')}
          </button>
        </div>
      </div>
      <div class="contacts-selectbar" id="contacts-selectbar" role="toolbar" aria-label="${t('contacts.selectButton')}" hidden>
        <button class="btn btn--secondary" data-action="select-cancel">${t('common.cancel')}</button>
        <span class="contacts-selectbar__count" id="contacts-select-count" aria-live="polite"></span>
        <div class="contacts-selectbar__actions">
          <button class="btn btn--secondary" data-action="select-all">${t('contacts.selectAll')}</button>
          <button class="btn btn--danger" data-action="select-delete">${t('common.delete')}</button>
        </div>
      </div>
      <div class="contacts-filters" id="contacts-filters" role="group" aria-label="${t('contacts.filterAll')}"></div>
      <div id="contacts-status" class="sr-only" role="status" aria-live="polite"></div>
      <div id="contacts-list" class="contacts-list" aria-busy="true">${renderSkeletonList({ rows: 6, lines: 2 })}</div>
      <button class="page-fab" id="fab-new-contact" aria-label="${t('contacts.newContactLabel')}">
        <i data-lucide="plus" style="width:24px;height:24px" aria-hidden="true"></i>
      </button>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: container });

  // Listen-Interaktionen EINMALIG delegieren (der #contacts-list-Container bleibt
  // über alle renderList()-Aufrufe hinweg bestehen; nur seine Kinder werden ersetzt).
  const listEl = _container.querySelector('#contacts-list');
  listEl.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-action="delete"]');
    if (del) { await deleteContact(parseInt(del.dataset.id, 10)); return; }
    if (e.target.closest('[data-action="empty-cta"]')) {
      document.querySelector('.page-fab')?.click();
      return;
    }
    if (e.target.closest('[data-action="reset-filters"]')) {
      contactsSearch?.clear();
      state.searchQuery    = '';
      state.activeCategory = null;
      _container.querySelectorAll('.contact-filter-chip').forEach((chip) => {
        const on = chip.dataset.cat === '';
        chip.classList.toggle('contact-filter-chip--active', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      renderList();
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      const c = state.contacts.find((x) => x.id === parseInt(open.dataset.open, 10));
      if (c) openContactModal({ mode: 'edit', contact: c });
    }
  });
  listEl.addEventListener('beforetoggle', onPanelBeforeToggle, true);
  listEl.addEventListener('toggle', onPanelToggle, true);

  // Auswahl-Modus: Checkbox-Änderungen sammeln.
  listEl.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-select]');
    if (!cb) return;
    const id = parseInt(cb.dataset.select, 10);
    if (cb.checked) state.selected.add(id); else state.selected.delete(id);
    cb.closest('.contact-item')?.classList.toggle('contact-item--selected', cb.checked);
    updateSelectUI();
  });

  const [res, catRes] = await Promise.all([
    api.get('/contacts'),
    api.get('/contacts/categories'),
  ]);
  state.categories = catRes.data ?? [];
  // Der Server sortiert mit SQLite-NOCASE (ASCII-only); nach jeder lokalen
  // Änderung sortiert die Seite dagegen mit localeCompare. Damit die Reihenfolge
  // nicht zwischen Reload und Bearbeiten springt (Umlaut-Nachnamen), gilt hier
  // durchgehend die Locale-Sortierung (#535).
  state.contacts   = [...res.data].sort((a, b) =>
    catSortIndex(a.category) - catSortIndex(b.category) || byName(a, b)
  );
  renderCategoryFilters();
  renderList({ animate: true });

  _container.querySelector('#contacts-manage-cats')
    ?.addEventListener('click', openContactCategoryManager);

  // Deep-Link: ?open=<id> öffnet direkt das Edit-Modal
  const openId = new URLSearchParams(window.location.search).get('open');
  if (openId) {
    const contact = state.contacts.find((c) => c.id === parseInt(openId, 10));
    if (contact) openContactModal({ mode: 'edit', contact });
  }

  // Suche
  contactsSearch = wirePageSearch(_container, {
    id: 'contacts-search',
    onQuery: (value) => {
      state.searchQuery = value.trim();
      renderList();
    },
  });

  // Kategorie-Filter: Rand-Fade-Affordanz für die scrollende Chipzeile
  // (geteilte has-fade-*-Konvention, Audit F-06 — Scrollbalken ist versteckt).
  wireScrollFade(_container.querySelector('#contacts-filters'));
  _container.querySelector('#contacts-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    _container.querySelectorAll('.contact-filter-chip').forEach((c) => {
      const on = c === chip;
      c.classList.toggle('contact-filter-chip--active', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    state.activeCategory = chip.dataset.cat || null;
    renderList();
  });

  // Neu
  const addHandler = () => openContactModal({ mode: 'create' });
  _container.querySelector('#contacts-add-btn').addEventListener('click', addHandler);
  _container.querySelector('#fab-new-contact').addEventListener('click', addHandler);

  // Auswahl-Modus (opt-in): Toggle in der Toolbar + Aktionen in der Auswahl-Leiste.
  _container.querySelector('#contacts-select-btn').addEventListener('click', () => {
    if (state.selectMode) exitSelectMode(); else enterSelectMode();
  });
  _container.querySelector('#contacts-selectbar').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="select-cancel"]')) { exitSelectMode(); return; }
    if (e.target.closest('[data-action="select-all"]'))    { toggleSelectAll(); return; }
    if (e.target.closest('[data-action="select-delete"]')) { deleteSelected(); return; }
  });

  // vCard-Import: parsen, dann eine Auswahl-Vorstufe zeigen (nichts wird
  // ungefragt angelegt). Die eigentliche Anlage passiert in openImportSelectionModal.
  _container.querySelector('#contacts-import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    let text;
    try {
      text = await file.text();
    } catch (err) {
      window.yuvomi?.showToast(t('contacts.importError', { error: err.message }), 'danger');
      return;
    }
    const parsed  = parseVCards(text, {
      resolveCategory: resolveVCardCategory,
      fallbackCategory: FALLBACK_CATEGORY,
    });
    const named   = parsed.filter((c) => c.name);
    const skipped = parsed.length - named.length;
    if (named.length === 0) { window.yuvomi?.showToast(t('contacts.vcardNoName'), 'warning'); return; }
    openImportSelectionModal(named, skipped);
  });

  // Tastatur-Shortcuts (Power-User): „/" fokussiert die Suche, „n" legt neu an.
  // document-Level, weil sie auch ohne Fokus in der Liste greifen sollen. Der
  // Router bietet keinen Page-Teardown — daher meldet sich der Listener selbst ab,
  // sobald sein Seiten-Container (Closure) aus dem DOM entfernt wurde.
  const pageRoot = container;
  const onKey = (e) => {
    if (!pageRoot.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.getElementById('shared-modal-overlay')) return; // Modal offen
    if (state.selectMode && e.key === 'Escape') { exitSelectMode(); return; }
    const el = e.target;
    const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
      || el.tagName === 'SELECT' || el.isContentEditable);
    if (typing) return;
    if (e.key === '/') {
      e.preventDefault();
      pageRoot.querySelector('#contacts-search')?.focus();
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      openContactModal({ mode: 'create' });
    }
  };
  document.addEventListener('keydown', onKey);
}

// --------------------------------------------------------
// Kategorie-Filterleiste (aus state.categories aufgebaut) + Verwaltung (#357)
// --------------------------------------------------------

function renderCategoryFilters() {
  const bar = _container?.querySelector('#contacts-filters');
  if (!bar) return;
  const active = state.activeCategory;
  const allChip = `<button class="contact-filter-chip${active ? '' : ' contact-filter-chip--active'}" data-cat="" aria-pressed="${active ? 'false' : 'true'}">${esc(t('contacts.filterAll'))}</button>`;
  const catChips = state.categories.map((c) => {
    const on = active === c.key;
    return `<button class="contact-filter-chip${on ? ' contact-filter-chip--active' : ''}" data-cat="${esc(c.key)}" aria-pressed="${on ? 'true' : 'false'}">${categoryIcon(c.key)} ${esc(catLabel(c.key))}</button>`;
  }).join('');
  bar.replaceChildren();
  bar.insertAdjacentHTML('beforeend', allChip + catChips);
  if (window.lucide) lucide.createIcons({ el: bar });
}

function openContactCategoryManager() {
  let manager = null;
  const onChanged = async () => {
    try {
      const res = await api.get('/contacts/categories');
      state.categories = res.data ?? [];
      renderCategoryFilters();
      renderList();
    } catch { /* Fehler wurde bereits vom Manager als Toast angezeigt */ }
  };
  openSharedModal({
    title: t('contacts.manageCategories'),
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    size: 'lg',
    onSave: (panel) => {
      manager = panel.querySelector('yuvomi-category-manager');
      manager.addEventListener('category-manager-changed', onChanged);
      manager.configure({
        basePath: '/contacts/categories',
        groups: [{ key: '', addLabelKey: 'contacts.addCategory' }],
        labelResolver: (item) => (item.label_key ? t(item.label_key) : (item.name || item.key)),
        titleKey: 'contacts.manageCategories',
        hintKey: 'category.manageHint',
      });
    },
    onClose: () => manager?.removeEventListener('category-manager-changed', onChanged),
  });
}

// --------------------------------------------------------
// Liste rendern
// --------------------------------------------------------

function filterContacts() {
  let list = state.contacts;

  if (state.activeCategory) {
    list = list.filter((c) => c.category === state.activeCategory);
  }

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    list = list.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      (c.phone  && c.phone.toLowerCase().includes(q)) ||
      (c.email  && c.email.toLowerCase().includes(q))
    );
  }

  return list;
}

function renderList({ animate = false } = {}) {
  const container = _container.querySelector('#contacts-list');
  if (!container) return;
  container.removeAttribute('aria-busy');

  const contacts = filterContacts();

  // Ergebniszahl leise für Screenreader ansagen (Suche/Filter geben sonst
  // keine hörbare Rückmeldung über die Trefferzahl).
  const statusEl = _container.querySelector('#contacts-status');
  if (statusEl) {
    const n = contacts.length;
    statusEl.textContent = n === 0 ? t('contacts.noResultsTitle')
      : n === 1 ? t('contacts.countOne')
      : t('contacts.countMany', { count: n });
  }

  if (!contacts.length) {
    // „Keine Treffer" (Suche/Filter aktiv) vom „Noch keine Kontakte"-Zustand
    // (0 Gesamtkontakte) trennen — unterschiedliche Botschaft und Aktion.
    const filtered = Boolean(state.searchQuery || state.activeCategory);
    container.replaceChildren();
    if (filtered) {
      container.insertAdjacentHTML('beforeend', `
        <div class="empty-state">
          <svg class="empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/>
            <path d="M21 21l-4.35-4.35"/>
          </svg>
          <div class="empty-state__title">${t('contacts.noResultsTitle')}</div>
          <div class="empty-state__description">${t('contacts.noResultsDescription')}</div>
          <button class="btn btn--secondary empty-state__cta" data-action="reset-filters">
            <i data-lucide="x" aria-hidden="true" class="icon-md"></i>
            ${t('contacts.resetSearch')}
          </button>
        </div>
      `);
    } else {
      container.insertAdjacentHTML('beforeend', `
        <div class="empty-state">
          <svg class="empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <div class="empty-state__title">${t('contacts.emptyTitle')}</div>
          <div class="empty-state__description">${t('contacts.emptyDescription')}</div>
          <p class="empty-state__hint">${t('emptyHint.contacts')}</p>
          <button class="btn btn--primary empty-state__cta" data-action="empty-cta">
            <i data-lucide="plus" aria-hidden="true" class="icon-md"></i>
            ${t('contacts.emptyAction')}
          </button>
        </div>
      `);
    }
    if (window.lucide) lucide.createIcons({ el: container });
    return;
  }

  // Nach Kategorie gruppieren
  const groups = {};
  for (const c of contacts) {
    if (!groups[c.category]) groups[c.category] = [];
    groups[c.category].push(c);
  }

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', Object.entries(groups)
    .sort(([a], [b]) => catSortIndex(a) - catSortIndex(b))
    .map(([cat, items]) => `
      <div class="contact-group ${catTintClass(cat)}">
        <div class="contact-group__header">${categoryIcon(cat)} ${esc(catLabel(cat))}</div>
        ${items.map((c) => renderContactItem(c)).join('')}
      </div>
    `).join(''));

  if (window.lucide) lucide.createIcons({ el: container });
  // Entrance-Stagger nur beim echten Erst-Load — nicht bei jedem Such-/Filter-
  // Render (sonst flackert die Liste bei jeder Tastatureingabe).
  if (animate) stagger(container.querySelectorAll('.contact-item'));
}

// Meta-Zeile: Telefon (schrumpft nicht) · E-Mail (wird gekürzt), damit die
// Telefonnummer auf schmalem Viewport nie verschwindet.
function renderMeta(c) {
  if (!c.phone && !c.email) return '';
  const phone = c.phone ? `<span class="contact-item__meta-phone">${esc(c.phone)}</span>` : '';
  const email = c.email ? `<span class="contact-item__meta-email">${esc(c.email)}</span>` : '';
  const sep   = c.phone && c.email ? `<span class="contact-item__meta-sep" aria-hidden="true">·</span>` : '';
  return `<span class="contact-item__meta">${phone}${sep}${email}</span>`;
}

function renderContactItem(c) {
  const menuId  = `contact-more-${c.id}`;

  // Auswahl-Modus: Zeile wird zur Checkbox (Familien-Kontakte deaktiviert,
  // da einzeln nicht löschbar). Aktionen/Öffnen entfallen.
  if (state.selectMode) {
    const selected = state.selected.has(c.id);
    return `
      <div class="contact-item contact-item--select${selected ? ' contact-item--selected' : ''}" data-id="${c.id}">
        <label class="contact-item__open contact-item__select">
          <input type="checkbox" class="contact-item__checkbox" data-select="${c.id}"${selected ? ' checked' : ''}${c.family_user_id ? ' disabled' : ''} aria-label="${esc(c.name)}">
          ${contactAvatar(c)}
          <span class="contact-item__body">
            <span class="contact-item__name">${esc(c.name)}</span>
            ${renderMeta(c)}
          </span>
        </label>
      </div>
    `;
  }

  // Primäre, stets sichtbare Zeilenaktion: Anrufen (falls Telefon vorhanden).
  const callBtn = c.phone
    ? `<a href="tel:${esc(c.phone)}" class="row-action row-action--success" aria-label="${t('contacts.callLabel')}">
         <i data-lucide="phone" aria-hidden="true"></i>
       </a>`
    : '';

  // Sekundäre Aktionen als beschriftetes Menü (Icon + Textlabel), identisch auf
  // Desktop und Mobile. Export ist immer verfügbar → das Menü ist nie leer.
  const mapsUrl = c.address ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(c.address)}` : '';
  const menuItems = [
    c.email ? `<a href="mailto:${esc(c.email)}" class="contact-menu-item" role="menuitem">
        <i data-lucide="mail" class="contact-menu-item__icon" aria-hidden="true"></i><span>${t('contacts.emailActionLabel')}</span>
      </a>` : '',
    c.address ? `<a href="${mapsUrl}" target="_blank" rel="noopener" class="contact-menu-item" role="menuitem">
        <i data-lucide="map-pin" class="contact-menu-item__icon" aria-hidden="true"></i><span>${t('contacts.mapsLabel')}</span>
      </a>` : '',
    `<a href="/api/v1/contacts/${c.id}/vcard" download="${esc(c.name)}.vcf" class="contact-menu-item" role="menuitem">
        <i data-lucide="download" class="contact-menu-item__icon" aria-hidden="true"></i><span>${t('contacts.exportLabel')}</span>
      </a>`,
    !c.family_user_id ? `<button type="button" class="contact-menu-item contact-menu-item--danger" data-action="delete" data-id="${c.id}" role="menuitem">
        <i data-lucide="trash-2" class="contact-menu-item__icon" aria-hidden="true"></i><span>${t('common.delete')}</span>
      </button>` : '',
  ].join('');

  return `
    <div class="contact-item" data-id="${c.id}">
      <button type="button" class="contact-item__open" data-open="${c.id}">
        ${contactAvatar(c)}
        <span class="contact-item__body">
          <span class="contact-item__name">${esc(c.name)}</span>
          ${renderMeta(c)}
        </span>
        <i data-lucide="chevron-right" class="contact-item__chevron" aria-hidden="true"></i>
      </button>
      <div class="row-actions contact-item__actions">
        ${callBtn}
        <button type="button" class="row-action contact-more-menu__trigger"
                popovertarget="${menuId}" aria-label="${t('contacts.moreActions')}">
          <i data-lucide="more-horizontal" aria-hidden="true"></i>
        </button>
        <div class="contact-more-menu__panel" id="${menuId}" popover role="menu">
          ${menuItems}
        </div>
      </div>
    </div>
  `;
}

// Popover (mobiles „Mehr"-Menü) im Top-Layer positionieren — nahe dem Trigger,
// nach oben gekippt, wenn unten kein Platz ist. beforetoggle/toggle bubbeln nicht,
// daher werden die Listener in render() mit { capture:true } am Listen-Container
// registriert (Capture-Phase erreicht auch nicht-bubbelnde Events).
function onPanelBeforeToggle(e) {
  const panel = e.target;
  if (!(panel instanceof HTMLElement) || !panel.matches('.contact-more-menu__panel')) return;
  if (e.newState === 'open') panel.style.opacity = '0'; // Flash vor Positionierung vermeiden
}

function onPanelToggle(e) {
  const panel = e.target;
  if (!(panel instanceof HTMLElement) || !panel.matches('.contact-more-menu__panel')) return;
  if (e.newState !== 'open') { panel.style.opacity = ''; return; }
  const trigger = _container?.querySelector(`[popovertarget="${panel.id}"]`);
  if (trigger) {
    const r    = trigger.getBoundingClientRect();
    const pw   = panel.offsetWidth  || 200;
    const ph   = panel.offsetHeight || 48;
    const gap  = 4;
    let left = Math.min(Math.max(8, r.right - pw), window.innerWidth  - pw - 8);
    let top  = r.bottom + gap;
    if (top + ph > window.innerHeight - 8) top = r.top - ph - gap; // nach oben kippen
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top  = `${Math.round(Math.max(8, top))}px`;
  }
  panel.style.opacity = '1';
}

// --------------------------------------------------------
// Modal
// --------------------------------------------------------

function openContactModal({ mode, contact = null }) {
  const isEdit = mode === 'edit';
  const v      = (field) => esc(isEdit && contact[field] ? contact[field] : '');

  const defaultCat = state.categories[0]?.key ?? FALLBACK_CATEGORY;

  // Ein Kontakt kann eine Kategorie tragen, die nicht (mehr) in der verwalteten
  // Liste steht - z. B. aus einem Fremd-Import direkt in die DB. Ohne passende
  // Option zeigte das Select stumm die erste Kategorie an und schrieb sie beim
  // Speichern fest: der Kontakt wechselte die Kategorie, ohne dass jemand das
  // angefasst hätte. Die Ist-Kategorie bekommt deshalb eine eigene Option und
  // wird beim Speichern nur dann mitgeschickt, wenn der Nutzer sie ändert.
  const orphanCat = isEdit && contact.category && !catByKey(contact.category)
    ? contact.category
    : null;
  const catOpts = [
    ...(orphanCat ? [`<option value="${esc(orphanCat)}" selected>${esc(orphanCat)}</option>`] : []),
    ...state.categories.map((c) =>
      `<option value="${esc(c.key)}" ${isEdit && contact.category === c.key ? 'selected' : ''}>${esc(catLabel(c.key))}</option>`
    ),
  ].join('');

  const advancedOpen = isEdit && (!!contact.address || !!contact.notes);

  // Vor-/Nachname (#535). Kontakte ohne gespeicherte Struktur (Altbestand,
  // lokal angelegt vor diesem Feld) werden heuristisch aus dem Anzeigenamen
  // vorbelegt - gespeichert wird erst, was der Nutzer bestätigt.
  const hadStructure = isEdit && !!(contact.first_name || contact.last_name);
  const prefill = { firstName: '', lastName: '' };
  if (isEdit) {
    const parts = hadStructure
      ? { firstName: contact.first_name, lastName: contact.last_name }
      : splitDisplayName(contact.name);
    prefill.firstName = parts.firstName || '';
    prefill.lastName  = parts.lastName  || '';
  }

  const advancedFieldsHtml = `
    <div class="form-group">
      <label class="form-label" for="cm-address">${t('contacts.addressLabel')}</label>
      <input type="text" class="form-input" id="cm-address" placeholder="${t('contacts.addressPlaceholder')}" value="${v('address')}" autocomplete="street-address">
    </div>
    <div class="form-group">
      <label class="form-label" for="cm-notes">${t('contacts.notesLabel')}</label>
      <textarea class="form-input" id="cm-notes" rows="2" placeholder="${t('contacts.notesPlaceholder')}">${v('notes')}</textarea>
    </div>`;

  const content = `
    <fieldset class="contact-modal__name-group">
      <legend class="form-label">${t('contacts.nameGroupLabel')}</legend>
      <div class="modal-grid modal-grid--2 contact-modal__name-grid">
        <div class="form-group">
          <label class="form-label" for="cm-first-name">${t('contacts.firstNameLabel')}</label>
          <input type="text" class="form-input" id="cm-first-name" placeholder="${t('contacts.firstNamePlaceholder')}" value="${esc(prefill.firstName)}" autocomplete="given-name">
        </div>
        <div class="form-group">
          <label class="form-label" for="cm-last-name">${t('contacts.lastNameLabel')}</label>
          <input type="text" class="form-input" id="cm-last-name" placeholder="${t('contacts.lastNamePlaceholder')}" value="${esc(prefill.lastName)}" autocomplete="family-name">
        </div>
      </div>
    </fieldset>
    <div class="form-group">
      <label class="form-label" for="cm-category">${t('contacts.categoryLabel')}</label>
      <div class="contacts-cat-select">
        <span class="contacts-cat-select__icon" id="cm-cat-icon" aria-hidden="true">${categoryIcon(isEdit && contact.category ? contact.category : defaultCat, 18)}</span>
        <select class="form-input" id="cm-category">${catOpts}</select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="cm-phone">${t('contacts.phoneLabel')}</label>
      <input type="tel" class="form-input" id="cm-phone" placeholder="${t('contacts.phonePlaceholder')}" value="${v('phone')}" autocomplete="tel">
    </div>
    <div class="form-group">
      <label class="form-label" for="cm-email">${t('contacts.emailLabel')}</label>
      <input type="email" class="form-input" id="cm-email" placeholder="${t('contacts.emailPlaceholder')}" value="${v('email')}" autocomplete="email">
    </div>

    ${advancedSection(advancedFieldsHtml, { open: advancedOpen })}

    <div class="modal-panel__footer contact-modal__footer">
      ${isEdit && !contact.family_user_id ? `<button class="btn btn--danger btn--icon" id="cm-delete" aria-label="${t('contacts.deleteLabel')}">
        <i data-lucide="trash-2" style="width:16px;height:16px;" aria-hidden="true"></i>
      </button>` : '<div></div>'}
      <div class="contact-modal__footer-actions">
        <button class="btn btn--secondary" id="cm-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="cm-save">${isEdit ? t('common.save') : t('common.create')}</button>
      </div>
    </div>`;

  openSharedModal({
    title: isEdit ? t('contacts.editContact') : t('contacts.newContact'),
    content,
    size: 'md',
    onSave(panel) {
      panel.querySelector('#cm-cancel').addEventListener('click', closeModal);

      // Kategorie-Vorschau live aktualisieren (Icon links neben dem Select).
      const catSel  = panel.querySelector('#cm-category');
      const catIcon = panel.querySelector('#cm-cat-icon');
      catSel?.addEventListener('change', () => {
        catIcon.replaceChildren();
        catIcon.insertAdjacentHTML('beforeend', categoryIcon(catSel.value, 18));
        if (window.lucide) lucide.createIcons({ el: catIcon });
      });

      panel.querySelector('#cm-delete')?.addEventListener('click', async () => {
        closeModal({ force: true });
        await deleteContact(contact.id);
      });

      // Bei Kontakten ohne gespeicherte Struktur ist die Aufteilung nur geraten
      // (letztes Wort = Nachname). Sie darf erst gespeichert werden, wenn der
      // Nutzer sie bestätigt hat - sonst bekäme "AutoHaus König" beim Ändern
      // einer Telefonnummer stillschweigend den Nachnamen "König" und würde in
      // der Liste umsortiert (#535).
      let nameTouched = false;
      panel.querySelectorAll('#cm-first-name, #cm-last-name').forEach((input) => {
        input.addEventListener('input', () => { nameTouched = true; });
      });

      panel.querySelector('#cm-save').addEventListener('click', async () => {
        const saveBtn  = panel.querySelector('#cm-save');
        const firstName = panel.querySelector('#cm-first-name').value.trim();
        const lastName  = panel.querySelector('#cm-last-name').value.trim();
        // Struktur wird nur übertragen, wenn sie gespeichert war oder der Nutzer
        // sie angefasst hat; sonst bleibt der Anzeigename unverändert bestehen.
        const structured = !isEdit || hadStructure || nameTouched;
        const name      = structured
          ? (composeDisplayName({ firstName, lastName }) || '')
          : contact.name;
        const category = panel.querySelector('#cm-category').value;
        const phone    = panel.querySelector('#cm-phone').value.trim() || null;
        const email    = panel.querySelector('#cm-email').value.trim() || null;
        const address  = panel.querySelector('#cm-address').value.trim() || null;
        const notes    = panel.querySelector('#cm-notes').value.trim() || null;

        if (!name) {
          window.yuvomi?.showToast(t('contacts.nameRequiredHint'), 'danger');
          panel.querySelector('#cm-first-name').focus();
          return;
        }

        saveBtn.disabled    = true;
        saveBtn.textContent = '…';

        try {
          // firstName/lastName sind führend; der Server leitet `name` daraus ab (#535).
          const body = { name, category, phone, email, address, notes };
          if (structured) { body.firstName = firstName; body.lastName = lastName; }
          // Eine unverändert gebliebene Fremd-Kategorie würde der Server (zu Recht)
          // mit 400 ablehnen; sie wird deshalb weggelassen und bleibt serverseitig
          // per COALESCE erhalten.
          if (orphanCat && category === orphanCat) delete body.category;
          if (mode === 'create') {
            const res = await api.post('/contacts', body);
            state.contacts.push(res.data);
            state.contacts.sort((a, b) =>
              catSortIndex(a.category) - catSortIndex(b.category) || byName(a, b)
            );
          } else {
            const res = await api.put(`/contacts/${contact.id}`, body);
            const idx = state.contacts.findIndex((c) => c.id === contact.id);
            if (idx !== -1) state.contacts[idx] = res.data;
          }
          closeModal({ force: true });
          renderList();
          window.yuvomi?.showToast(mode === 'create' ? t('contacts.savedToast') : t('contacts.updatedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
          saveBtn.disabled    = false;
          saveBtn.textContent = isEdit ? t('common.save') : t('common.create');
        }
      });
    },
  });
}

// --------------------------------------------------------
// Auswahl-Modus (opt-in Bulk)
// --------------------------------------------------------

function enterSelectMode() {
  state.selectMode = true;
  state.selected.clear();
  _container.querySelector('#contacts-select-btn')?.setAttribute('aria-pressed', 'true');
  _container.querySelector('#contacts-selectbar').hidden = false;
  _container.querySelector('.contacts-page')?.classList.add('is-selecting');
  renderList();
  updateSelectUI();
}

function exitSelectMode() {
  state.selectMode = false;
  state.selected.clear();
  _container.querySelector('#contacts-select-btn')?.setAttribute('aria-pressed', 'false');
  _container.querySelector('#contacts-selectbar').hidden = true;
  _container.querySelector('.contacts-page')?.classList.remove('is-selecting');
  renderList();
}

function updateSelectUI() {
  const n = state.selected.size;
  const countEl = _container.querySelector('#contacts-select-count');
  if (countEl) countEl.textContent = t('contacts.selectCount', { count: n });
  const delBtn = _container.querySelector('[data-action="select-delete"]');
  if (delBtn) delBtn.disabled = n === 0;
}

// Nur nicht-verknüpfte Kontakte sind wählbar (Familien-Kontakte lassen sich
// einzeln nicht löschen). „Alle" schaltet zwischen komplett aus/an um.
function toggleSelectAll() {
  const selectable = filterContacts().filter((c) => !c.family_user_id);
  const allOn = selectable.length > 0 && selectable.every((c) => state.selected.has(c.id));
  selectable.forEach((c) => allOn ? state.selected.delete(c.id) : state.selected.add(c.id));
  renderList();
  updateSelectUI();
}

async function deleteSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  const idSet   = new Set(ids);
  const removed = state.contacts.filter((c) => idSet.has(c.id));
  state.contacts = state.contacts.filter((c) => !idSet.has(c.id));
  exitSelectMode();
  vibrate([30, 50, 30]);

  scheduleUndoableDelete({
    message: t('contacts.bulkDeletedToast', { count: ids.length }),
    commit: ({ keepalive }) => Promise.all(ids.map((id) => api.delete(`/contacts/${id}`, { keepalive }))),
    restore: (err) => {
      state.contacts = [...state.contacts, ...removed].sort(byName);
      renderList();
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}

async function deleteContact(id) {
  const contact = state.contacts.find((c) => c.id === id);
  state.contacts = state.contacts.filter((c) => c.id !== id);
  renderList();
  vibrate([30, 50, 30]);

  scheduleUndoableDelete({
    message: t('contacts.deletedToast'),
    commit: ({ keepalive }) => api.delete(`/contacts/${id}`, { keepalive }),
    restore: (err) => {
      if (contact) {
        state.contacts = [...state.contacts, contact].sort(byName);
        renderList();
      }
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}

// --------------------------------------------------------
// vCard-Import: Auswahl-Vorstufe (#518-Muster) + Anlage
// --------------------------------------------------------

/** Ordnet einen rohen vCard-CATEGORIES-Wert einer bestehenden Kategorie zu (sonst null). */
function resolveVCardCategory(rawCategories) {
  const lower = String(rawCategories || '').toLowerCase();
  if (!lower) return null;
  const matched = state.categories.find((c) =>
    lower.includes(c.key.toLowerCase()) || lower.includes(catLabel(c.key).toLowerCase()));
  return matched?.key || null;
}

/**
 * Namensvarianten eines Kontakts für den Dubletten-Abgleich (#535). Nötig, weil
 * Quellen unterschiedlich formatieren: ein bereits synchronisierter Kontakt kann
 * noch "Doe, John" heißen, während die frisch geparste vCard "John Doe" liefert.
 * Verglichen werden Anzeigename, seine Komma-Umkehrung und - wo Namensteile
 * vorliegen - beide Reihenfolgen.
 */
function nameVariants(c) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const out = new Set();

  const display = norm(c.name);
  if (display) {
    out.add(display);
    const swapped = norm(display.replace(/^([^,]+),\s*(.+)$/, '$2 $1'));
    if (swapped) out.add(swapped);
  }

  const first = norm(c.first_name ?? c.firstName);
  const last  = norm(c.last_name  ?? c.lastName);
  if (first || last) {
    out.add(norm(`${first} ${last}`));
    out.add(norm(`${last} ${first}`));
  }

  out.delete('');
  return out;
}

/** Prüft, ob bereits ein Kontakt mit diesem Namen existiert (Dedup-Hinweis, NOCASE). */
function contactExistsByName(contact) {
  const variants = nameVariants(contact);
  if (!variants.size) return false;
  return state.contacts.some((c) => [...nameVariants(c)].some((v) => variants.has(v)));
}

/** Eine Auswahl-Zeile im Import-Modal. Bereits vorhandene Namen sind vorab abgewählt + markiert. */
function importSelectionRowHtml(contact, index) {
  const exists = contactExistsByName(contact);
  const detail = contact.phone || contact.email || '';
  return `
    <label class="vcard-import-row${exists ? ' vcard-import-row--exists' : ''}">
      <input type="checkbox" value="${index}"${exists ? '' : ' checked'}>
      <span class="vcard-import-row__name">${esc(contact.name)}</span>
      ${detail ? `<span class="vcard-import-row__detail">${esc(detail)}</span>` : ''}
      ${contact.birthday
        ? `<span class="vcard-import-row__bday" title="${esc(formatDate(contact.birthday))}"><i data-lucide="cake" aria-hidden="true"></i></span>`
        : ''}
      ${exists ? `<span class="vcard-import-row__badge">${t('contacts.importExistsBadge')}</span>` : ''}
    </label>`;
}

/** Öffnet die Auswahl-Vorstufe: der Nutzer entscheidet, welche Kontakte angelegt werden. */
function openImportSelectionModal(named, skipped) {
  const skippedHtml = skipped > 0
    ? `<p class="vcard-import__skipped">${t('contacts.importSkippedNote', { count: skipped })}</p>`
    : '';

  openSharedModal({
    title: t('contacts.importTitle'),
    size: 'md',
    content: `
      <div class="vcard-import">
        <p class="vcard-import__intro">${t('contacts.importIntro')}</p>
        <div class="vcard-import__bar">
          <button type="button" class="vcard-import__toggle" id="vcard-import-toggle">${t('contacts.importDeselectAll')}</button>
          <span class="sr-only" role="status" aria-live="polite" id="vcard-import-status"></span>
        </div>
        <div class="vcard-import__list">${named.map(importSelectionRowHtml).join('')}</div>
        ${skippedHtml}
        <div class="vcard-import__footer">
          <button class="btn btn--secondary" type="button" id="vcard-import-cancel">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="button" id="vcard-import-submit">${t('contacts.importSubmit', { count: 0 })}</button>
        </div>
      </div>
    `,
    onSave(panel) {
      const submitBtn = panel.querySelector('#vcard-import-submit');
      const toggleBtn = panel.querySelector('#vcard-import-toggle');
      const status    = panel.querySelector('#vcard-import-status');
      const boxes     = [...panel.querySelectorAll('.vcard-import__list input[type="checkbox"]')];

      const selectedIndices = () => boxes.filter((b) => b.checked).map((b) => Number(b.value));

      const refresh = (announce = false) => {
        const n = selectedIndices().length;
        submitBtn.textContent = t('contacts.importSubmit', { count: n });
        submitBtn.disabled = n === 0;
        toggleBtn.textContent = boxes.every((b) => b.checked)
          ? t('contacts.importDeselectAll')
          : t('contacts.importSelectAll');
        if (announce && status) status.textContent = t('contacts.importSelectedStatus', { count: n });
      };
      boxes.forEach((b) => b.addEventListener('change', () => refresh(true)));
      refresh();

      toggleBtn.addEventListener('click', () => {
        const allChecked = boxes.every((b) => b.checked);
        boxes.forEach((b) => { b.checked = !allChecked; });
        refresh(true);
      });

      panel.querySelector('#vcard-import-cancel').addEventListener('click', closeModal);

      submitBtn.addEventListener('click', async () => {
        const chosen = selectedIndices().map((i) => named[i]);
        if (chosen.length === 0) return;
        submitBtn.disabled = true;
        toggleBtn.disabled = true;
        submitBtn.textContent = t('contacts.importImporting');
        await importParsedContacts(chosen);
        closeModal({ force: true });
      });
    },
  });
}

/** Springt ins Geburtstagsmodul und öffnet dort direkt das Kandidaten-Modal. */
function openBirthdayImport() {
  try { sessionStorage.setItem('yuvomi:birthdays:autoImport', '1'); } catch { /* egal */ }
  window.yuvomi?.navigate('/birthdays');
}

/**
 * Legt die ausgewählten Kontakte an und meldet das Ergebnis als einen
 * zusammengesetzten Toast. Fehlgeschlagene Anlagen können per Toast-Aktion
 * gezielt erneut versucht werden; sonst führt die Aktion ins Geburtstagsmodul.
 */
async function importParsedContacts(list) {
  let imported = 0;
  let withBirthday = 0;
  let lastName = null;
  let lastError = null;
  const failedList = [];
  for (const contact of list) {
    try {
      const res = await api.post('/contacts', contact);
      state.contacts.push(res.data);
      imported++;
      if (res.data.birthday) withBirthday++;
      lastName = res.data.name;
    } catch (err) {
      failedList.push(contact);
      lastError = err;
    }
  }
  renderList();
  const failed = failedList.length;

  // Detail-Segmente im agreement-freien „phrase: n"-Muster (korrekt bei jeder Anzahl).
  const details = [];
  if (withBirthday > 0) details.push(t('contacts.importDetailBirthday', { count: withBirthday }));
  if (failed > 0)       details.push(t('contacts.importDetailFailed',   { count: failed }));

  // Nur ein Aktions-Slot: Fehler-Recovery (Retry der Fehlgeschlagenen) hat Vorrang
  // vor dem Geburtstags-Sprung.
  const action = failed > 0
    ? { label: t('contacts.importRetry'), onClick: () => importParsedContacts(failedList) }
    : (withBirthday > 0 ? { label: t('contacts.importOpenBirthdays'), onClick: openBirthdayImport } : null);

  let message;
  let type;
  if (imported === 0) {
    // Alles fehlgeschlagen: konkrete Ursache nennen (Recovery), Retry via Aktion.
    const reason = window.yuvomi?.friendlyError?.(lastError) || lastError?.message || '';
    message = t('contacts.importError', { error: reason });
    type = 'danger';
  } else if (imported === 1 && details.length === 0) {
    // Persönlicher Einzel-Import: Name statt Zähler (Prinzip „persönlich").
    message = t('contacts.importedToast', { name: lastName });
    type = 'success';
  } else {
    const base = imported === 1
      ? t('contacts.importedCountToastSingular', { count: imported })
      : t('contacts.importedCountToast', { count: imported });
    message = [base, ...details].join(' · ');
    type = failed > 0 ? 'warning' : 'success';
  }
  window.yuvomi?.showToast(message, type, action ? 6000 : 3000, action);
}
