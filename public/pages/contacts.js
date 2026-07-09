/**
 * Modul: Kontakte (Contacts)
 * Zweck: Kontaktliste mit Kategorie-Filter, Suche, CRUD, tel:/mailto:/maps-Links
 * Abhängigkeiten: /api.js, /router.js (window.yuvomi)
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, advancedSection } from '/components/modal.js';
import { stagger, vibrate } from '/utils/ux.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const CATEGORIES = ['Arzt', 'Schule/Kita', 'Behörde', 'Versicherung',
                    'Handwerker', 'Notfall', 'Sonstiges'];

// Kategorie → Lucide-Iconname (Linien-Stil, konsistent mit übrigen UI-Icons)
const CATEGORY_ICONS = {
  'Arzt':         'stethoscope',
  'Schule/Kita':  'graduation-cap',
  'Behörde':      'landmark',
  'Versicherung': 'shield',
  'Handwerker':   'wrench',
  'Notfall':      'siren',
  'Sonstiges':    'tag',
};

// Kategorie → CSS-Slug für den abgeleiteten Farbton (siehe .contact-group--* in
// contacts.css). Kein neuer Modul-Akzent, nur eine dezente Tint-Schicht.
const CATEGORY_SLUG = {
  'Arzt':         'doctor',
  'Schule/Kita':  'school',
  'Behörde':      'authority',
  'Versicherung': 'insurance',
  'Handwerker':   'craftsman',
  'Notfall':      'emergency',
  'Sonstiges':    'misc',
};

// Liefert das Lucide-Placeholder-Markup für eine Kategorie; aria-hidden, da stets
// von einem Text-Label begleitet. lucide.createIcons() ersetzt den Platzhalter.
function categoryIcon(cat, size = 16) {
  const name = CATEGORY_ICONS[cat] || 'tag';
  return `<i data-lucide="${name}" class="contact-cat-icon" style="width:${size}px;height:${size}px;" aria-hidden="true"></i>`;
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

function CATEGORY_LABELS() {
  return {
    'Arzt':         t('contacts.categoryDoctor'),
    'Schule/Kita':  t('contacts.categorySchool'),
    'Behörde':      t('contacts.categoryAuthority'),
    'Versicherung': t('contacts.categoryInsurance'),
    'Handwerker':   t('contacts.categoryCraftsman'),
    'Notfall':      t('contacts.categoryEmergency'),
    'Sonstiges':    t('contacts.categoryOther'),
  };
}

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = {
  contacts:       [],
  activeCategory: null,
  searchQuery:    '',
  selectMode:     false,
  selected:       new Set(),
};
let _container = null;

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
        <label class="contacts-toolbar__search page-toolbar__center" for="contacts-search">
          <span class="contacts-toolbar__search-label sr-only">${t('contacts.searchPlaceholder')}</span>
          <span class="contacts-toolbar__search-control">
            <i data-lucide="search" class="contacts-toolbar__search-icon" aria-hidden="true"></i>
            <input type="search" class="contacts-toolbar__search-input"
                   id="contacts-search" placeholder="${t('contacts.searchPlaceholder')}"
                   autocomplete="off">
          </span>
        </label>
        <div class="page-toolbar__actions">
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
      <div class="contacts-filters" id="contacts-filters" role="group" aria-label="${t('contacts.filterAll')}">
        <button class="contact-filter-chip contact-filter-chip--active" data-cat="" aria-pressed="true">${t('contacts.filterAll')}</button>
        ${CATEGORIES.map((c) => `
          <button class="contact-filter-chip" data-cat="${esc(c)}" aria-pressed="false">${categoryIcon(c)} ${CATEGORY_LABELS()[c] || esc(c)}</button>
        `).join('')}
      </div>
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
      const search = _container.querySelector('#contacts-search');
      if (search) search.value = '';
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

  const res        = await api.get('/contacts');
  state.contacts   = res.data;
  renderList({ animate: true });

  // Deep-Link: ?open=<id> öffnet direkt das Edit-Modal
  const openId = new URLSearchParams(window.location.search).get('open');
  if (openId) {
    const contact = state.contacts.find((c) => c.id === parseInt(openId, 10));
    if (contact) openContactModal({ mode: 'edit', contact });
  }

  // Suche
  let searchTimer;
  _container.querySelector('#contacts-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.searchQuery = e.target.value.trim();
      renderList();
    }, 200);
  });

  // Kategorie-Filter
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

  // vCard-Import
  _container.querySelector('#contacts-import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    try {
      const text    = await file.text();
      const contact = parseVCard(text);
      if (!contact.name) { window.yuvomi?.showToast(t('contacts.vcardNoName'), 'warning'); return; }
      const res = await api.post('/contacts', contact);
      state.contacts.push(res.data);
      renderList();
      window.yuvomi?.showToast(t('contacts.importedToast', { name: res.data.name }), 'success');
    } catch (err) {
      window.yuvomi?.showToast(t('contacts.importError', { error: err.message }), 'danger');
    }
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
    .sort(([a], [b]) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b))
    .map(([cat, items]) => `
      <div class="contact-group contact-group--${CATEGORY_SLUG[cat] || 'misc'}">
        <div class="contact-group__header">${categoryIcon(cat)} ${CATEGORY_LABELS()[cat] || esc(cat)}</div>
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
    ? `<a href="tel:${esc(c.phone)}" class="contact-action-btn contact-action-btn--call" aria-label="${t('contacts.callLabel')}">
         <i data-lucide="phone" style="width:16px;height:16px;" aria-hidden="true"></i>
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
      <div class="contact-item__actions">
        ${callBtn}
        <button type="button" class="contact-action-btn contact-more-menu__trigger"
                popovertarget="${menuId}" aria-label="${t('contacts.moreActions')}">
          <i data-lucide="more-horizontal" style="width:16px;height:16px;" aria-hidden="true"></i>
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

  const catLabels = CATEGORY_LABELS();
  const catOpts = CATEGORIES.map((c) =>
    `<option value="${c}" ${isEdit && contact.category === c ? 'selected' : ''}>${catLabels[c] || esc(c)}</option>`
  ).join('');

  const advancedOpen = isEdit && (!!contact.address || !!contact.notes);

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
    <div class="form-group">
      <label class="form-label" for="cm-name">${t('contacts.nameLabel')}</label>
      <input type="text" class="form-input" id="cm-name" placeholder="${t('contacts.namePlaceholder')}" value="${v('name')}" autocomplete="name">
    </div>
    <div class="form-group">
      <label class="form-label" for="cm-category">${t('contacts.categoryLabel')}</label>
      <div class="contacts-cat-select">
        <span class="contacts-cat-select__icon" id="cm-cat-icon" aria-hidden="true">${categoryIcon(isEdit && contact.category ? contact.category : CATEGORIES[0], 18)}</span>
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

      panel.querySelector('#cm-save').addEventListener('click', async () => {
        const saveBtn  = panel.querySelector('#cm-save');
        const name     = panel.querySelector('#cm-name').value.trim();
        const category = panel.querySelector('#cm-category').value;
        const phone    = panel.querySelector('#cm-phone').value.trim() || null;
        const email    = panel.querySelector('#cm-email').value.trim() || null;
        const address  = panel.querySelector('#cm-address').value.trim() || null;
        const notes    = panel.querySelector('#cm-notes').value.trim() || null;

        if (!name) { window.yuvomi?.showToast(t('common.nameRequired'), 'error'); return; }

        saveBtn.disabled    = true;
        saveBtn.textContent = '…';

        try {
          const body = { name, category, phone, email, address, notes };
          if (mode === 'create') {
            const res = await api.post('/contacts', body);
            state.contacts.push(res.data);
            state.contacts.sort((a, b) =>
              CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
              a.name.localeCompare(b.name)
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
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'error');
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

  let undone = false;
  const restore = () => {
    state.contacts = [...state.contacts, ...removed].sort((a, b) => a.name.localeCompare(b.name));
    renderList();
  };
  window.yuvomi?.showToast(t('contacts.bulkDeletedToast', { count: ids.length }), 'default', 5000, () => {
    undone = true;
    restore();
  });

  setTimeout(async () => {
    if (undone) return;
    try {
      await Promise.all(ids.map((id) => api.delete(`/contacts/${id}`)));
    } catch (err) {
      restore();
      window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    }
  }, 5000);
}

async function deleteContact(id) {
  const contact = state.contacts.find((c) => c.id === id);
  state.contacts = state.contacts.filter((c) => c.id !== id);
  renderList();
  vibrate([30, 50, 30]);

  let undone = false;
  window.yuvomi?.showToast(t('contacts.deletedToast'), 'default', 5000, () => {
    undone = true;
    if (contact) {
      state.contacts = [...state.contacts, contact].sort((a, b) => a.name.localeCompare(b.name));
      renderList();
    }
  });

  setTimeout(async () => {
    if (undone) return;
    try {
      await api.delete(`/contacts/${id}`);
    } catch (err) {
      if (contact) {
        state.contacts = [...state.contacts, contact].sort((a, b) => a.name.localeCompare(b.name));
        renderList();
      }
      window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    }
  }, 5000);
}


/**
 * Minimaler vCard 3.0/4.0 Parser.
 * Gibt { name, phone, email, address, notes, category } zurück.
 */
function parseVCard(text) {
  const unescapeVCard = (s) => String(s || '')
    .replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

  // Zeilenfortsetzungen entfalten (RFC 6350 §3.2)
  const unfolded = text.replace(/\r?\n[ \t]/g, '');

  const get = (prop) => {
    const re = new RegExp(`^${prop}(?:;[^:]*)?:(.*)$`, 'im');
    const m  = re.exec(unfolded);
    return m ? unescapeVCard(m[1].trim()) : null;
  };

  const name    = get('FN') || get('N')?.split(';')[0] || null;
  const phone   = get('TEL') || null;
  const email   = get('EMAIL') || null;

  // ADR: ;;street;city;region;postal;country
  const adrRaw  = get('ADR');
  let address   = null;
  if (adrRaw) {
    const parts = adrRaw.split(';').map((p) => p.trim()).filter(Boolean);
    address = parts.join(', ') || null;
  }

  const notes    = get('NOTE') || null;
  const catRaw   = get('CATEGORIES') || null;
  const category = CATEGORIES.find((c) => catRaw?.toLowerCase().includes(c.toLowerCase())) || 'Sonstiges';

  return { name, phone, email, address, notes, category };
}
