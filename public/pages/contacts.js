/**
 * Modul: Kontakte (Contacts)
 * Zweck: Kontaktliste mit Kategorie-Filter, Suche, CRUD, tel:/mailto:/maps-Links
 * Abhängigkeiten: /api.js, /router.js (window.oikos)
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal } from '/components/modal.js';
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

// Liefert das Lucide-Placeholder-Markup für eine Kategorie; aria-hidden, da stets
// von einem Text-Label begleitet. lucide.createIcons() ersetzt den Platzhalter.
function categoryIcon(cat, size = 16) {
  const name = CATEGORY_ICONS[cat] || 'tag';
  return `<i data-lucide="${name}" class="contact-cat-icon" style="width:${size}px;height:${size}px;" aria-hidden="true"></i>`;
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
      <div class="contacts-filters" id="contacts-filters">
        <button class="contact-filter-chip contact-filter-chip--active" data-cat="">${t('contacts.filterAll')}</button>
        ${CATEGORIES.map((c) => `
          <button class="contact-filter-chip" data-cat="${esc(c)}">${categoryIcon(c)} ${CATEGORY_LABELS()[c] || esc(c)}</button>
        `).join('')}
      </div>
      <div id="contacts-list" class="contacts-list" aria-busy="true">${renderSkeletonList({ rows: 6, lines: 2 })}</div>
      <button class="page-fab" id="fab-new-contact" aria-label="${t('contacts.newContactLabel')}">
        <i data-lucide="plus" style="width:24px;height:24px" aria-hidden="true"></i>
      </button>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: container });

  const res        = await api.get('/contacts');
  state.contacts   = res.data;
  renderList();

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
    _container.querySelectorAll('.contact-filter-chip').forEach((c) =>
      c.classList.toggle('contact-filter-chip--active', c === chip)
    );
    state.activeCategory = chip.dataset.cat || null;
    renderList();
  });

  // Neu
  const addHandler = () => openContactModal({ mode: 'create' });
  _container.querySelector('#contacts-add-btn').addEventListener('click', addHandler);
  _container.querySelector('#fab-new-contact').addEventListener('click', addHandler);

  // vCard-Import
  _container.querySelector('#contacts-import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    try {
      const text    = await file.text();
      const contact = parseVCard(text);
      if (!contact.name) { window.oikos?.showToast(t('contacts.vcardNoName'), 'warning'); return; }
      const res = await api.post('/contacts', contact);
      state.contacts.push(res.data);
      renderList();
      window.oikos?.showToast(t('contacts.importedToast', { name: res.data.name }), 'success');
    } catch (err) {
      window.oikos?.showToast(t('contacts.importError', { error: err.message }), 'danger');
    }
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

function renderList() {
  const container = _container.querySelector('#contacts-list');
  if (!container) return;
  container.removeAttribute('aria-busy');

  const contacts = filterContacts();

  if (!contacts.length) {
    container.replaceChildren();
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
        <button class="btn btn--primary empty-state__cta" id="empty-cta-contacts">
          <i data-lucide="plus" aria-hidden="true" class="icon-md"></i>
          ${t('contacts.emptyAction')}
        </button>
      </div>
    `);
    if (window.lucide) lucide.createIcons({ el: container });
    container.querySelector('#empty-cta-contacts')?.addEventListener('click', () => {
      document.querySelector('.page-fab')?.click();
    });
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
      <div class="contact-group">
        <div class="contact-group__header">${categoryIcon(cat)} ${CATEGORY_LABELS()[cat] || esc(cat)}</div>
        ${items.map((c) => renderContactItem(c)).join('')}
      </div>
    `).join(''));

  if (window.lucide) lucide.createIcons({ el: container });
  stagger(container.querySelectorAll('.contact-item'));

  // Event-Delegation
  container.addEventListener('click', async (e) => {
    if (e.target.closest('[data-action="delete"]')) {
      const id = parseInt(e.target.closest('[data-action="delete"]').dataset.id, 10);
      await deleteContact(id);
      return;
    }
    const item = e.target.closest('.contact-item[data-id]');
    if (item && !e.target.closest('a') && !e.target.closest('[data-action]')) {
      const c = state.contacts.find((c) => c.id === parseInt(item.dataset.id, 10));
      if (c) openContactModal({ mode: 'edit', contact: c });
    }
  });
}

function renderContactItem(c) {
  const phone   = c.phone  ? `<a href="tel:${esc(c.phone)}"   class="contact-action-btn contact-action-btn--call"  aria-label="${t('contacts.callLabel')}"><i data-lucide="phone" style="width:16px;height:16px;" aria-hidden="true"></i></a>` : '';
  const email   = c.email  ? `<a href="mailto:${esc(c.email)}" class="contact-action-btn contact-action-btn--mail contact-action-btn--desktop-extra" aria-label="${t('contacts.emailActionLabel')}"><i data-lucide="mail" style="width:16px;height:16px;" aria-hidden="true"></i></a>` : '';
  const mobileEmail = c.email ? `<a href="mailto:${esc(c.email)}" class="contact-action-btn contact-action-btn--mail contact-action-btn--mobile-menu" aria-label="${t('contacts.emailActionLabel')}"><i data-lucide="mail" style="width:16px;height:16px;" aria-hidden="true"></i></a>` : '';
  const maps    = c.address ? `<a href="https://maps.google.com/?q=${encodeURIComponent(c.address)}" target="_blank" rel="noopener" class="contact-action-btn contact-action-btn--maps contact-action-btn--desktop-extra" aria-label="${t('contacts.mapsLabel')}"><i data-lucide="map-pin" style="width:16px;height:16px;" aria-hidden="true"></i></a>` : '';
  const mobileMaps = c.address ? `<a href="https://maps.google.com/?q=${encodeURIComponent(c.address)}" target="_blank" rel="noopener" class="contact-action-btn contact-action-btn--maps contact-action-btn--mobile-menu" aria-label="${t('contacts.mapsLabel')}"><i data-lucide="map-pin" style="width:16px;height:16px;" aria-hidden="true"></i></a>` : '';
  const exportAction = `<a href="/api/v1/contacts/${c.id}/vcard" download="${esc(c.name)}.vcf"
           class="contact-action-btn contact-action-btn--desktop-extra" aria-label="${t('contacts.exportLabel')}" title="${t('contacts.exportTooltip')}">
          <i data-lucide="download" style="width:16px;height:16px;" aria-hidden="true"></i>
        </a>`;
  const mobileExportAction = `<a href="/api/v1/contacts/${c.id}/vcard" download="${esc(c.name)}.vcf"
           class="contact-action-btn contact-action-btn--mobile-menu" aria-label="${t('contacts.exportLabel')}" title="${t('contacts.exportTooltip')}">
          <i data-lucide="download" style="width:16px;height:16px;" aria-hidden="true"></i>
        </a>`;
  const deleteAction = !c.family_user_id ? `
          <button class="contact-action-btn contact-action-btn--delete contact-action-btn--desktop-extra" data-action="delete" data-id="${c.id}" aria-label="${t('contacts.deleteLabel')}">
            <i data-lucide="trash-2" style="width:16px;height:16px;" aria-hidden="true"></i>
          </button>
        ` : '';
  const mobileDeleteAction = !c.family_user_id ? `
          <button class="contact-action-btn contact-action-btn--delete contact-action-btn--mobile-menu" data-action="delete" data-id="${c.id}" aria-label="${t('contacts.deleteLabel')}">
            <i data-lucide="trash-2" style="width:16px;height:16px;" aria-hidden="true"></i>
          </button>
        ` : '';
  const hasMobileMenu = Boolean(c.id);
  const meta    = [c.phone, c.email].filter(Boolean).join(' · ');

  return `
    <div class="contact-item" data-id="${c.id}">
      <div class="contact-item__icon">${categoryIcon(c.category, 20)}</div>
      <div class="contact-item__body">
        <div class="contact-item__name">${esc(c.name)}</div>
        ${meta ? `<div class="contact-item__meta">${esc(meta)}</div>` : ''}
      </div>
      <div class="contact-item__actions">
        ${phone}${email}${maps}
        ${exportAction}
        ${deleteAction}
        ${hasMobileMenu ? `
        <details class="contact-more-menu">
          <summary class="contact-action-btn" data-action="more" aria-label="${t('contacts.moreActions')}">
            <i data-lucide="more-horizontal" style="width:16px;height:16px;" aria-hidden="true"></i>
          </summary>
          <div class="contact-more-menu__panel">
            ${mobileEmail}
            ${mobileMaps}
            ${mobileExportAction}
            ${mobileDeleteAction}
          </div>
        </details>` : ''}
      </div>
    </div>
  `;
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

  const content = `
    <div class="form-group">
      <label class="form-label" for="cm-name">${t('contacts.nameLabel')}</label>
      <input type="text" class="form-input" id="cm-name" placeholder="${t('contacts.namePlaceholder')}" value="${v('name')}" autocomplete="name">
    </div>
    <div class="form-group">
      <label class="form-label" for="cm-category">${t('contacts.categoryLabel')}</label>
      <select class="form-input" id="cm-category">${catOpts}</select>
    </div>
    <div class="form-group">
      <label class="form-label" for="cm-phone">${t('contacts.phoneLabel')}</label>
      <input type="tel" class="form-input" id="cm-phone" placeholder="${t('contacts.phonePlaceholder')}" value="${v('phone')}" autocomplete="tel">
    </div>
    <div class="form-group">
      <label class="form-label" for="cm-email">${t('contacts.emailLabel')}</label>
      <input type="email" class="form-input" id="cm-email" placeholder="${t('contacts.emailPlaceholder')}" value="${v('email')}" autocomplete="email">
    </div>
    <div class="form-group">
      <label class="form-label" for="cm-address">${t('contacts.addressLabel')}</label>
      <input type="text" class="form-input" id="cm-address" placeholder="${t('contacts.addressPlaceholder')}" value="${v('address')}" autocomplete="street-address">
    </div>
    <div class="form-group">
      <label class="form-label" for="cm-notes">${t('contacts.notesLabel')}</label>
      <textarea class="form-input" id="cm-notes" rows="2" placeholder="${t('contacts.notesPlaceholder')}">${v('notes')}</textarea>
    </div>

    <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
      ${isEdit && !contact.family_user_id ? `<button class="btn btn--danger btn--icon" id="cm-delete" aria-label="${t('contacts.deleteLabel')}">
        <i data-lucide="trash-2" style="width:16px;height:16px;" aria-hidden="true"></i>
      </button>` : '<div></div>'}
      <div style="display:flex;gap:var(--space-3);">
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

        if (!name) { window.oikos?.showToast(t('common.nameRequired'), 'error'); return; }

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
          window.oikos?.showToast(mode === 'create' ? t('contacts.savedToast') : t('contacts.updatedToast'), 'success');
        } catch (err) {
          window.oikos?.showToast(err.data?.error ?? t('common.unknownError'), 'error');
          saveBtn.disabled    = false;
          saveBtn.textContent = isEdit ? t('common.save') : t('common.create');
        }
      });
    },
  });
}

async function deleteContact(id) {
  const contact = state.contacts.find((c) => c.id === id);
  state.contacts = state.contacts.filter((c) => c.id !== id);
  renderList();
  vibrate([30, 50, 30]);

  let undone = false;
  window.oikos?.showToast(t('contacts.deletedToast'), 'default', 5000, () => {
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
      window.oikos?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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
