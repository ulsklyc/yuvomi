/**
 * Modul: Kontakte (Contacts)
 * Zweck: Kontaktliste mit Kategorie-Filter, Suche, CRUD, tel:/mailto:/maps-Links
 * Abhängigkeiten: /api.js, /router.js (window.yuvomi)
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, advancedSection } from '/components/modal.js';
import { openDetailView } from '/components/detail-view.js';
import { stagger, vibrate, wireScrollFade, scheduleUndoableDelete } from '/utils/ux.js';
import { t, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { setBulkPill, clearBulkPill } from '/utils/bulk-pill.js';
import { parseVCards } from '/utils/vcard.js';
import { getReadableTextColor, AVATAR_FALLBACK_COLOR } from '/utils/color.js';
import { composeDisplayName, contactSortKey, splitDisplayName } from '/utils/contact-name.js';
import { getPhoneFormatter, createAsYouType, countryFromRegion } from '/utils/phone.js';
import { emptyStateHTML } from '/utils/empty-state.js';
import '/components/category-manager.js';
import { findPageFab } from '/utils/fab.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

// Kategorien sind seit #357 benutzer-verwaltbar und werden aus
// /contacts/categories in state.categories geladen. Bestands-Kategorien tragen
// label_key (i18n) + icon; benutzerdefinierte tragen name + Default-Icon 'tag'.
// Der stabile key bleibt der Bezug auf die Kategorie; ihr Ton steht seit
// Migration 152 in der Kategorie selbst (siehe catTintStyle unten).
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
function categoryIcon(key, sizeClass = 'icon-md') {
  const name = catByKey(key)?.icon || 'tag';
  return `<i data-lucide="${esc(name)}" class="contact-cat-icon ${sizeClass}" aria-hidden="true"></i>`;
}

// DER TON EINER KATEGORIE STEHT IN IHREN DATEN, seit Migration 152.
//
// Hier stand `catTintClass()`: aus dem Key wurde ein Klassenname, und
// contacts.css führte sieben Regeln `.contact-group--<key>`. Das konnte per
// Konstruktion nur die SEED-Kategorien treffen - eine selbst angelegte
// Kategorie (seit #357) matchte keine Regel und fiel auf den Modulton zurück,
// weshalb im Demo-Haushalt „Familie" und „Dienstleistungen" gleich aussahen.
// Dieselbe Bauart, die die Vollton-Regel schon einmal eingeholt hat: ein
// Zusammenhang, der über einen Namen läuft, deckt N Namen ab, nicht die Regel.
//
// `--cat-ink` begleitet den Ton, weil die Tinte nur auf einer gefüllten Scheibe
// gilt; ohne Ton bleibt die Marke neutral (contacts.css).
function catTintStyle(key) {
  const color = catByKey(key)?.color;
  return color
    ? ` style="--cat:${esc(color)};--cat-ink:var(--color-ink-on-vivid)"`
    : '';
}

// Initialen aus dem Namen (max. 2 Buchstaben): Vorname + letzter Namensteil.
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] || '';
  const last  = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

// Avatar einer Zeile. Zwei Faelle, zwei Sprecher:
//
// EIN VERKNUEPFTER KONTAKT IST EIN MENSCH DES HAUSHALTS, und der traegt ueberall
// SEINE Farbe (Identitaetsfarben-Regel, DESIGN.md) - dasselbe Bild und dieselbe
// Scheibe wie im Kalender, in den Aufgaben und auf dem Dashboard. Hier stand
// bis 2026-08-18 der Modul-Ton, also dieselbe rosa Scheibe fuer jedes Mitglied.
// Die Tinte kommt aus `getReadableTextColor`, weil eine Avatarfarbe frei
// gewaehlt ist und ihre Helligkeit deshalb unbestimmt.
//
// ALLE ANDEREN nennen ihre KATEGORIE, und die traegt ihren kuratierten Ton als
// Vollton-Scheibe; hat sie keinen (benutzerdefinierte Kategorie), bleibt die
// Marke neutral. Beides steht in contacts.css an den Kategorie-Toenen.
function contactAvatar(c) {
  if (!c.family_user_id) {
    return `<span class="contact-item__icon vivid-mark">${categoryIcon(c.category, 'icon-lg')}</span>`;
  }
  const color = c.family_avatar_color || AVATAR_FALLBACK_COLOR;
  const name  = c.family_display_name || c.name;
  const inner = c.family_avatar_data
    ? `<img src="${esc(c.family_avatar_data)}" alt="" loading="lazy">`
    : esc(initials(name));
  return `<span class="contact-item__icon contact-item__icon--member"
    style="background-color:${esc(color)};color:${getReadableTextColor(color)}"
    aria-hidden="true">${inner}</span>`;
}

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = {
  contacts:       [],
  categories:     [],
  // Die waehlbaren Kategorie-Toene, wie der Server sie ausliefert.
  categoryColors: [],
  activeCategory: null,
  searchQuery:    '',
  selectMode:     false,
  selected:       new Set(),
  // Default-Land (ISO-3166-Alpha-2) für die Telefon-Anzeige/-Hilfe. Aus der
  // haushaltweiten Region abgeleitet; null → libphonenumber-js nutzt nur
  // explizite Ländervorwahlen (führendes +). Rein Anzeige, nie Speicher-Logik.
  defaultCountry: null,
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
    <div class="contacts-page app-page app-page--reading page-measure--narrow" data-composition="reading">
      <div class="page-toolbar page-toolbar--wrap page-toolbar--narrow contacts-toolbar">
        <h1 class="page-toolbar__title">${t('contacts.title')}</h1>
        ${renderPageSearch({ id: 'contacts-search', label: t('contacts.searchPlaceholder'), placeholder: t('contacts.searchPlaceholder'), value: state.searchQuery, clearLabel: t('common.searchClear'), className: 'contacts-toolbar__search page-toolbar__center' })}
        <div class="page-toolbar__actions">
          <button class="btn btn--icon btn--ghost" id="contacts-manage-cats" aria-label="${t('contacts.manageCategories')}" title="${t('contacts.manageCategories')}">
            <i data-lucide="tags" class="icon-md" aria-hidden="true"></i>
          </button>
          <button class="btn btn--secondary" id="contacts-select-btn" aria-pressed="false">
            <i data-lucide="list-checks" class="icon-md" aria-hidden="true"></i>
            ${t('contacts.selectButton')}
          </button>
          <label class="btn btn--secondary" title="${t('contacts.importTooltip')}" aria-label="${t('contacts.importLabel')}">
            <i data-lucide="upload" class="icon-md" aria-hidden="true"></i>
            ${t('contacts.importButton')}
            <input type="file" id="contacts-import-input" accept=".vcf,text/vcard" style="display:none">
          </label>
          <button class="btn btn--primary toolbar-new-btn" id="contacts-add-btn" aria-label="${t('contacts.newContactLabel')}">
            <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
            <span class="toolbar-new-btn__label">${t('newLabel.contacts')}</span>
          </button>
        </div>
      </div>
      <div class="contacts-filters" id="contacts-filters" role="group" aria-label="${t('contacts.filterAll')}"></div>
      <div id="contacts-status" class="sr-only" role="status" aria-live="polite"></div>
      <div id="contacts-list" class="contacts-list page-scrollport" aria-busy="true">${renderSkeletonList({ rows: 6, lines: 2 })}</div>
      <button class="page-fab" id="fab-new-contact" aria-label="${t('contacts.newContactLabel')}" data-dock-label="${t('newLabel.contacts')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
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
        chip.classList.toggle('filter-chip--active', on);
        chip.classList.toggle('contact-filter-chip--active', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      renderList();
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      const c = state.contacts.find((x) => x.id === parseInt(open.dataset.open, 10));
      if (c) openContactDetail(c);
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

  const [res, catRes, metaRes, prefsRes] = await Promise.all([
    api.get('/contacts'),
    api.get('/contacts/categories'),
    // Die waehlbaren Kategorie-Toene kommen vom Server, damit Auswahl und
    // Annahme dieselbe Liste sind (Begruendung am Endpoint).
    api.get('/contacts/meta').catch(() => null),
    // Region → Default-Land für die Telefon-Anzeige. Fehlschlag ist unkritisch:
    // ohne Default-Land werden nur +-Vorwahl-Nummern formatiert, Rest bleibt roh.
    api.get('/preferences').catch(() => null),
  ]);
  state.defaultCountry = countryFromRegion(prefsRes?.data?.region);
  state.categories = catRes.data ?? [];
  state.categoryColors = metaRes?.data?.categoryColors ?? [];
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

  // Deep-Link: ?open=<id> öffnet die Detailansicht. Aus der globalen Suche
  // kommend will man den Treffer zuerst sehen, nicht bearbeiten - derselbe
  // Grund wie beim Antippen in der Liste.
  const openId = new URLSearchParams(window.location.search).get('open');
  if (openId) {
    const contact = state.contacts.find((c) => c.id === parseInt(openId, 10));
    if (contact) openContactDetail(contact);
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
      c.classList.toggle('filter-chip--active', on);
      c.classList.toggle('contact-filter-chip--active', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    state.activeCategory = chip.dataset.cat || null;
    renderList();
  });

  // Neu
  const addHandler = () => openContactModal({ mode: 'create' });
  _container.querySelector('#contacts-add-btn').addEventListener('click', addHandler);
  findPageFab('fab-new-contact').addEventListener('click', addHandler);

  // Auswahl-Modus (opt-in): Toggle in der Toolbar + Aktionen in der Auswahl-Leiste.
  _container.querySelector('#contacts-select-btn').addEventListener('click', () => {
    if (state.selectMode) exitSelectMode(); else enterSelectMode();
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
  const allChip = `<button class="filter-chip contact-filter-chip${active ? '' : ' filter-chip--active contact-filter-chip--active'}" data-cat="" aria-pressed="${active ? 'false' : 'true'}">${esc(t('contacts.filterAll'))}</button>`;
  const catChips = state.categories.map((c) => {
    const on = active === c.key;
    return `<button class="filter-chip contact-filter-chip${on ? ' filter-chip--active contact-filter-chip--active' : ''}" data-cat="${esc(c.key)}" aria-pressed="${on ? 'true' : 'false'}">${categoryIcon(c.key)} ${esc(catLabel(c.key))}</button>`;
  }).join('');
  bar.replaceChildren();
  bar.insertAdjacentHTML('beforeend', allChip + catChips);
  if (window.lucide) lucide.createIcons({ el: bar });
}

function openContactCategoryManager() {
  // Die Auffrischung haengt am Ereignis, nicht am Schliessen: beim Loeschen
  // raeumt `confirmOverModal` das Modal darunter ab, bevor `api.delete` laeuft
  // (siehe `_notifyChanged` in components/category-manager.js).
  const onChanged = async () => {
    try {
      const res = await api.get('/contacts/categories');
      state.categories = res.data ?? [];
      // Der aktive Filter kann auf die eben geloeschte Kategorie zeigen -
      // loeschbar ist genau die UNBENUTZTE, also gerade die, nach der jemand
      // gefiltert haben kann. `renderCategoryFilters` faende dann keinen Chip
      // zum Hervorheben (auch „Alle" nicht, denn `activeCategory` ist gesetzt),
      // waehrend `filterContacts` weiter jeden Kontakt wegfiltert: eine leere
      // Seite, der man nicht ansieht, warum sie leer ist.
      if (state.activeCategory && !state.categories.some((c) => c.key === state.activeCategory)) {
        state.activeCategory = null;
      }
      renderCategoryFilters();
      renderList();
    } catch (err) {
      // NICHT „meldet der Manager selbst": der quittiert nur seine eigene
      // Mutation, und `_notifyChanged()` kommt erst nach deren Erfolg. Was hier
      // ankommt, ist immer ein Fehler DIESER Auffrischung - und der erklaert als
      // einziger, warum die Seite den alten Stand behaelt.
      console.error('[Contacts] Auffrischen nach Kategorie-Aenderung fehlgeschlagen:', err);
      window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    }
  };
  openSharedModal({
    title: t('contacts.manageCategories'),
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    size: 'lg',
    onSave: (panel) => {
      const manager = panel.querySelector('yuvomi-category-manager');
      manager.addEventListener('category-manager-changed', onChanged);
      manager.configure({
        basePath: '/contacts/categories',
        groups: [{ key: '', addLabelKey: 'contacts.addCategory' }],
        labelResolver: (item) => (item.label_key ? t(item.label_key) : (item.name || item.key)),
        titleKey: 'contacts.manageCategories',
        hintKey: 'category.manageHint',
        deleteDetailKey: 'category.deleteConfirmDetail',
        colors: state.categoryColors,
      });
    },
    // Bewusst KEIN onClose, das den Listener abmeldet - es liefe vor dem
    // Loeschen. Das Element entsteht je Oeffnen neu und geht mit dem Overlay.
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
      container.insertAdjacentHTML('beforeend', emptyStateHTML({
        variant: 'no-results',
        icon: 'search',
        title: t('contacts.noResultsTitle'),
        description: t('contacts.noResultsDescription'),
        action: {
          label: t('contacts.resetSearch'),
          icon: 'x',
          attrs: { 'data-action': 'reset-filters' },
        },
      }));
    } else {
      container.insertAdjacentHTML('beforeend', emptyStateHTML({
        icon: 'users',
        title: t('contacts.emptyTitle'),
        description: t('contacts.emptyDescription'),
        hint: t('emptyHint.contacts'),
        action: {
          label: t('contacts.emptyAction'),
          icon: 'plus',
          attrs: { 'data-action': 'empty-cta' },
        },
      }));
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
      <div class="contact-group"${catTintStyle(cat)}>
        <div class="contact-group__header">${categoryIcon(cat)} ${esc(catLabel(cat))}</div>
        <div class="contact-group__list row-carrier">${items.map((c) => renderContactItem(c)).join('')}</div>
      </div>
    `).join(''));

  if (window.lucide) lucide.createIcons({ el: container });
  // Entrance-Stagger nur beim echten Erst-Load — nicht bei jedem Such-/Filter-
  // Render (sonst flackert die Liste bei jeder Tastatureingabe).
  if (animate) stagger(container.querySelectorAll('.contact-item'));
  enhancePhones(container);
}

// Progressive Enhancement der Telefon-Anzeige: formatiert sichtbare Nummern und
// hebt tel:-Links auf E.164. Läuft NACH dem Rohwert-Render (der Rohwert bleibt bis
// dahin sichtbar) und ist rein additiv - schlägt das Laden der Vendor-Lib fehl
// (offline vor Erstbesuch), bleibt jede Nummer 1:1 als Rohwert stehen.
async function enhancePhones(root) {
  if (!root) return;
  const els = root.querySelectorAll('[data-phone-raw]');
  if (!els.length) return;
  // Lib EINMAL laden, dann synchron über alle Elemente mappen (kein await pro
  // Nummer). Offline/Ladefehler → Rohwerte bleiben unverändert stehen.
  const fmt = await getPhoneFormatter();
  if (!fmt) return;
  const country = state.defaultCountry;
  for (const el of els) {
    const raw = el.dataset.phoneRaw;
    if (el.tagName === 'A') {
      // href aktualisieren; textContent (Icon) bleibt unangetastet.
      el.href = fmt.tel(raw, country);
    } else {
      const display = fmt.display(raw, country);
      // Nummer ist immer LTR - in RTL-Locales (ar/fa) sonst Bidi-Umbruch bei '+'.
      el.setAttribute('dir', 'ltr');
      // Nur den ANZEIGETEXT setzen - der Rohwert lebt weiter in data-phone-raw.
      if (display !== raw) el.textContent = display;
    }
  }
}

// Telefon-Tipphilfe im Formular: unverbindliche AsYouType-Vorschau, sobald ein
// Telefonfeld fokussiert/getippt wird, plus ein nicht-blockierender Hinweis, wenn
// die Nummer unplausibel wirkt. Ein gemeinsamer Hinweis pro Telefon-Gruppe folgt
// dem aktiven Feld. Die Felder selbst werden NIE umgeschrieben - gespeichert wird
// ausschließlich der rohe Feldinhalt (kein Datenverlust, auch bei aktiver Eingabe).
async function wirePhoneHints(panel) {
  const group    = panel.querySelector('[data-mv-group="phone"]');
  const previewEl = group?.querySelector('[data-mv-preview]');
  const warnEl    = group?.querySelector('[data-mv-warn]');
  if (!group || !previewEl || !warnEl) return;
  const country = state.defaultCountry;
  const [ay, fmt] = await Promise.all([createAsYouType(country), getPhoneFormatter()]);
  if (!ay || !fmt) return; // Lib nicht ladbar → keine Hilfe (Feld bleibt nutzbar)

  const HINT_ID = 'cm-phone-hint';
  let activeInput = null;
  // Aktives Feld ↔ Hint verknüpfen: aria-describedby (Screenreader-Bezug) + dezenter
  // Zeilen-Anker, damit bei mehreren Telefonzeilen klar ist, worauf der Hint zielt.
  const detach = (inp) => {
    if (!inp) return;
    inp.removeAttribute('aria-describedby');
    inp.closest('[data-mv-row]')?.classList.remove('contact-mv-row--active');
  };
  const setActive = (inp) => {
    if (activeInput !== inp) detach(activeInput);
    activeInput = inp;
    inp.setAttribute('aria-describedby', HINT_ID);
    inp.closest('[data-mv-row]')?.classList.add('contact-mv-row--active');
  };
  const clear = () => { previewEl.replaceChildren(); warnEl.textContent = ''; };
  // Vorschau RTL-sicher aufbauen: Label in Locale-Richtung, Nummer in <bdi>
  // isoliert (sonst kippt '+'/Gruppen in ar/fa). Sentinel trennt Label vom Wert.
  const PH = '\uE000'; // Private-Use-Sentinel, in keiner Locale-Beschriftung
  const setPreview = (formatted) => {
    previewEl.replaceChildren();
    if (!formatted) return;
    const [pre, post = ''] = t('contacts.phonePreview', { value: PH }).split(PH);
    const bdi = document.createElement('bdi');
    bdi.textContent = formatted;
    previewEl.append(document.createTextNode(pre), bdi, document.createTextNode(post));
  };
  const update = () => {
    const val = activeInput?.value.trim() || '';
    if (!val) { clear(); return; }
    ay.reset();
    const preview = ay.input(val);
    if (fmt.plausible(val, country)) {
      warnEl.textContent = '';
      setPreview(preview && preview !== val ? preview : '');
    } else {
      // Unplausibel: Vorschau raus, nur die Warnung (wird per aria-live angesagt).
      previewEl.replaceChildren();
      warnEl.textContent = t('contacts.phoneImplausible');
    }
  };

  group.addEventListener('focusin', (e) => {
    const inp = e.target.closest('[data-mv-value]');
    if (inp) { setActive(inp); update(); }
  });
  group.addEventListener('input', (e) => {
    const inp = e.target.closest('[data-mv-value]');
    if (inp) { setActive(inp); update(); }
  });
  group.addEventListener('focusout', (e) => {
    if (!group.contains(e.relatedTarget)) { detach(activeInput); activeInput = null; clear(); }
  });
}

// Meta-Zeile: Telefon (schrumpft nicht) · E-Mail (wird gekürzt), damit die
// Telefonnummer auf schmalem Viewport nie verschwindet.
function renderMeta(c) {
  if (!c.phone && !c.email) return '';
  // Rohwert steht im Markup UND in data-phone-raw: enhancePhones() ersetzt danach
  // nur den Anzeigetext (textContent) - der gespeicherte Wert bleibt unberührt.
  const phone = c.phone ? `<span class="contact-item__meta-phone" data-phone-raw="${esc(c.phone)}">${esc(c.phone)}</span>` : '';
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
      <div class="list-row list-row--tight contact-item contact-item--select${selected ? ' contact-item--selected' : ''}" data-id="${c.id}">
        <label class="contact-item__open list-row__main--interactive contact-item__select">
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
    ? `<a href="tel:${esc(c.phone)}" data-phone-raw="${esc(c.phone)}" class="row-action row-action--success" aria-label="${t('contacts.callLabel')}">
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
    <div class="list-row list-row--tight contact-item" data-id="${c.id}">
      <button type="button" class="contact-item__open list-row__main--interactive" data-open="${c.id}">
        ${contactAvatar(c)}
        <span class="contact-item__body">
          <span class="contact-item__name">${esc(c.name)}</span>
          ${renderMeta(c)}
        </span>
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
// Detailansicht
// --------------------------------------------------------

/**
 * Mehrere antippbare Werte in einer Zeile.
 *
 * Bewusst eine Zeile je Gruppe statt eine je Wert: Icon und Beschriftung
 * wiederholen sich sonst drei Mal untereinander, und der Blick verliert, wo die
 * Telefonnummern aufhören und die Mails anfangen.
 *
 * Baut ausschließlich über die DOM-API - `textContent` statt Markup, damit
 * Kontaktdaten aus CardDAV nirgends als HTML landen können.
 */
function contactLinksNode(entries) {
  // Leere Gruppe → kein Knoten. detailRowEl wirft die Zeile dann selbst weg;
  // ein leeres <div> wäre ein gültiges Element und ließe eine Zeile mit
  // Beschriftung und ohne Wert stehen.
  if (!entries.length) return null;

  const wrap = document.createElement('div');
  wrap.className = 'contact-detail__values';
  entries.forEach(({ href, text, sub, phoneRaw, external }) => {
    const line = document.createElement('div');
    line.className = 'contact-detail__value';

    const a = document.createElement('a');
    a.className = 'contact-detail__link';
    a.href = href;
    a.textContent = text;
    // enhancePhones() ersetzt danach nur den Anzeigetext; der Rohwert im href
    // und im data-Attribut bleibt unberührt.
    if (phoneRaw) a.dataset.phoneRaw = phoneRaw;
    if (external) { a.target = '_blank'; a.rel = 'noopener'; }
    line.appendChild(a);

    if (sub) {
      const s = document.createElement('span');
      s.className = 'contact-detail__sub';
      s.textContent = sub;
      line.appendChild(s);
    }
    wrap.appendChild(line);
  });
  return wrap;
}

/** Strukturierte Adresse zu einer Zeile. Fehlende Teile fallen weg. */
function formatAddress(a) {
  if (typeof a === 'string') return a;
  return [
    a.street,
    [a.postalCode, a.city].filter(Boolean).join(' '),
    [a.state, a.country].filter(Boolean).join(', '),
  ].filter(Boolean).join(', ');
}

// 'other' ist der neutrale Server-Default und trägt keine Information - als
// Untertitel gelesen behauptet er eine Einordnung, die niemand vorgenommen hat.
const mvSubLabel = (label) => (!label || label === 'other' ? '' : label);

/**
 * Die Leseansicht eines Kontakts.
 *
 * Führt bewusst ALLE Telefonnummern, Mails und Adressen auf, nicht nur die
 * primären: Die Liste zeigt je genau einen Legacy-Einzelwert, ein Kontakt mit
 * Dienst- und Mobilnummer bot also bisher nur eine davon zum Antippen an,
 * obwohl die Zweitnummer längst gespeichert war.
 *
 * Organisation, Position, Website und Spitzname kommen über CardDAV herein und
 * hatten in der App bislang überhaupt keine Anzeige - das Formular führt sie
 * nicht. Sie stehen hier als reine Leseinformation.
 */
function renderContactDetail(contact) {
  // Solange der Einzelabruf läuft, speist der Legacy-Einzelwert die Gruppe -
  // besser eine Nummer sofort als drei nach dem Roundtrip.
  const phones = contact.phones?.length
    ? contact.phones
    : (contact.phone ? [{ value: contact.phone, label: '' }] : []);
  const emails = contact.emails?.length
    ? contact.emails
    : (contact.email ? [{ value: contact.email, label: '' }] : []);
  const addresses = (contact.addresses?.length
    ? contact.addresses.map((a) => ({ text: formatAddress(a), sub: mvSubLabel(a.label) }))
    : (contact.address ? [{ text: contact.address, sub: '' }] : [])
  ).filter((a) => a.text);

  // Beschreibungs-Objekte, keine fertigen Zeilen: detailBodyEl schickt sie
  // selbst durch detailRowEl und wirft dabei alles ohne Wert weg. Deshalb
  // brauchen die Textzeilen hier keine Fallunterscheidung.
  return [
    {
      icon: 'phone',
      label: t('contacts.phoneLabel'),
      node: contactLinksNode(phones.map((p) => ({
        href: `tel:${p.value}`, text: p.value, sub: mvSubLabel(p.label), phoneRaw: p.value,
      }))),
    },
    {
      icon: 'mail',
      label: t('contacts.emailLabel'),
      node: contactLinksNode(emails.map((e) => ({
        href: `mailto:${e.value}`, text: e.value, sub: mvSubLabel(e.label),
      }))),
    },
    {
      icon: 'map-pin',
      label: t('contacts.addressLabel'),
      node: contactLinksNode(addresses.map((a) => ({
        href: `https://www.openstreetmap.org/search?query=${encodeURIComponent(a.text)}`,
        text: a.text, sub: a.sub, external: true,
      }))),
    },
    {
      icon: 'building-2',
      label: t('contacts.organizationLabel'),
      value: [contact.organization, contact.job_title].filter(Boolean).join(' · '),
    },
    {
      icon: 'cake',
      label: t('contacts.birthdayLabel'),
      value: contact.birthday ? formatDate(contact.birthday) : '',
    },
    {
      icon: 'globe',
      label: t('contacts.websiteLabel'),
      node: contactLinksNode(contact.website
        ? [{ href: contact.website, text: contact.website, external: true }]
        : []),
    },
    { icon: 'quote',      label: t('contacts.nicknameLabel'), value: contact.nickname || '' },
    { icon: 'folder',     label: t('contacts.categoryLabel'), value: catLabel(contact.category) || '' },
    { icon: 'align-left', label: t('contacts.notesLabel'),    value: contact.notes || '', multiline: true },
  ];
}

/**
 * Antippen zeigt den Kontakt, bevor es ihn bearbeiten lässt.
 *
 * Kein Anker, also auch am Desktop ein zentriertes Panel: Adressen und mehrere
 * Nummern passen nicht in die 320px eines verankerten Popovers.
 *
 * Die Ansicht erscheint sofort mit dem, was die Liste schon trägt; der
 * Einzelabruf reicht Zweitnummern, Adressen und die CardDAV-Felder nach. Das
 * `ready`-Promise sperrt solange den Wechsel ins Formular - und das ist keine
 * Kosmetik: `buildContactForm` liest die Mehrfachwerte aus `contact.phones`
 * und fällt ohne sie auf den Legacy-Einzelwert zurück. Ein Formular, das vor
 * der Antwort entsteht, schriebe beim Speichern genau eine Nummer zurück und
 * verlöre alle weiteren.
 */
function openContactDetail(contact) {
  let full = contact;
  // `view` wird weiter unten synchron zugewiesen, dieser Callback läuft
  // frühestens im nächsten Microtask - der Optional-Chain ist trotzdem da,
  // damit die Reihenfolge nicht stillschweigend zur Voraussetzung wird.
  let view = null;
  const ready = fetchFullContact(contact).then((loaded) => {
    full = loaded;
    if (view?.update(renderContactDetail(full))) enhanceDetailPhones();
  });

  const actions = [{
    id: 'contact-detail-export',
    label: t('contacts.exportLabel'),
    variant: 'ghost',
    icon: 'download',
    onClick: () => window.open(`/api/v1/contacts/${contact.id}/vcard`, '_blank', 'noopener'),
  }];

  // Verknüpfte Familienmitglieder werden über die Familie verwaltet, nicht hier
  // - die Liste blendet ihren Löschen-Eintrag aus demselben Grund aus.
  if (!contact.family_user_id) {
    actions.unshift({
      id: 'contact-detail-delete',
      label: t('common.delete'),
      variant: 'danger-ghost',
      icon: 'trash-2',
      align: 'start',
      // force + await wie überall in dieser Grammatik: Löschen entscheidet über
      // die Eingaben mit, und das Formular bleibt beim Zurückwechseln versteckt
      // im DOM stehen, zählt also weiter in den Dirty-Check.
      onClick: async ({ close }) => {
        await close({ force: true });
        await deleteContact(contact.id);
      },
    });
  }

  view = openDetailView({
    title: contact.name,
    size: 'md',
    sections: renderContactDetail(full),
    actions,
    edit: {
      label: t('common.edit'),
      title: t('contacts.editContact'),
      ready,
      mount: (panel, pane) => {
        const form = buildContactForm({ mode: 'edit', contact: full });
        pane.insertAdjacentHTML('beforeend', form.content);
        form.wire(panel);
      },
    },
  });

  enhanceDetailPhones();
  return view;
}

/**
 * Nummern in der offenen Detailansicht lesbar formatieren - dieselbe
 * AsYouType-Aufbereitung, die die Liste nutzt. Der gespeicherte Wert bleibt
 * unberührt, ersetzt wird nur der Anzeigetext.
 *
 * Die Ansicht liegt ohne Anker immer im geteilten Modal-Overlay; ein Popover
 * gäbe es nur mit `anchor`, den diese Seite bewusst nicht übergibt.
 */
function enhanceDetailPhones() {
  enhancePhones(document.getElementById('shared-modal-overlay'));
}

// --------------------------------------------------------
// Modal
// --------------------------------------------------------

/**
 * Lädt die Felder nach, die nur der Einzelabruf führt: Mehrfach-Telefon und
 * -Mail, Geburtstag und die CardDAV-Zusatzfelder. Die Listen-API kennt sie
 * nicht - ohne Nachladen wären CardDAV-Zweitnummern unsichtbar (Audit R2,
 * A2-11).
 *
 * Scheitert der Abruf, arbeiten Formular und Detailansicht mit den
 * Listenfeldern weiter, statt leer dazustehen.
 */
async function fetchFullContact(contact) {
  try { return (await api.get(`/contacts/${contact.id}`)).data ?? contact; }
  catch { return contact; }
}

async function openContactModal({ mode, contact = null }) {
  if (mode === 'edit') contact = await fetchFullContact(contact);
  const form = buildContactForm({ mode, contact });
  openSharedModal({ title: form.title, content: form.content, size: 'md', onSave: form.wire });
}

/**
 * Baut Titel, Markup und Verdrahtung des Kontaktformulars in einem Stück.
 *
 * Eigene Funktion, weil dasselbe Formular an zwei Stellen entsteht: im
 * regulären Modal (Neuanlage) und nachträglich gemountet im Formular-Pane der
 * Detailansicht. Die Verdrahtung bleibt bewusst im selben Closure wie das
 * Markup - sie liest `isEdit`, `hadStructure`, `orphanCat` und `mvRow`, und
 * eine Trennung müsste die alle durchreichen.
 *
 * @returns {{title: string, content: string, wire: (panel: HTMLElement) => void}}
 */
function buildContactForm({ mode, contact = null }) {
  const isEdit = mode === 'edit';
  const v      = (field) => esc(isEdit && contact[field] ? contact[field] : '');

  // Mehrwert-Zeilen: bestehende Arrays; sonst speist das Legacy-Einzelfeld die
  // erste Zeile. Mindestens eine (ggf. leere) Zeile pro Gruppe.
  const mvRows = (arr, single) => {
    const rows = Array.isArray(arr) && arr.length
      ? arr.map((r) => ({ label: r.label === 'other' ? '' : (r.label || ''), value: r.value || '' }))
      : (single ? [{ label: '', value: single }] : []);
    return rows.length ? rows : [{ label: '', value: '' }];
  };
  const phoneRows = mvRows(isEdit ? contact.phones : null, isEdit ? contact.phone : '');
  const emailRows = mvRows(isEdit ? contact.emails : null, isEdit ? contact.email : '');

  const mvRow = (kind, row, isFirst) => `
    <div class="contact-mv-row" data-mv-row>
      <input type="${kind === 'phone' ? 'tel' : 'email'}" class="form-input" data-mv-value
             ${isFirst ? `id="cm-${kind}"` : ''} value="${esc(row.value)}"
             placeholder="${t(kind === 'phone' ? 'contacts.phonePlaceholder' : 'contacts.emailPlaceholder')}"
             autocomplete="${kind === 'phone' ? 'tel' : 'email'}">
      <input type="text" class="form-input contact-mv-row__label" data-mv-label maxlength="50"
             value="${esc(row.label)}" placeholder="${t('contacts.mvLabelPlaceholder')}"
             aria-label="${t('contacts.mvLabel')}">
      <button type="button" class="row-action row-action--danger" data-mv-remove ${isFirst ? 'hidden' : ''}
              aria-label="${t('contacts.mvRemove')}">
        <i data-lucide="x" class="icon-sm" aria-hidden="true"></i>
      </button>
    </div>`;

  const mvSection = (kind, rows, labelKey, addKey) => `
    <div class="form-group" data-mv-group="${kind}">
      <label class="form-label" for="cm-${kind}">${t(labelKey)}</label>
      <div class="contact-mv-list" data-mv-list>${rows.map((r, i) => mvRow(kind, r, i === 0)).join('')}</div>
      <button type="button" class="btn btn--ghost contact-mv-add" data-mv-add>
        <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>${t(addKey)}
      </button>
      ${kind === 'phone'
        // Unverbindliche Tipphilfe (AsYouType-Vorschau) + Plausibilitäts-Hinweis.
        // Rein visuell: die Eingabefelder werden NIE programmatisch umgeschrieben,
        // gespeichert wird ausschließlich der rohe Feldinhalt.
        // Zwei Zonen: Vorschau ist STILL (keine Live-Region, sonst würde jeder
        // Tastendruck vorgelesen); nur die Warnung wird per aria-live angesagt.
        ? `<p class="contact-phone-hint" id="cm-phone-hint" data-mv-hint>
             <span class="contact-phone-hint__preview" data-mv-preview></span>
             <span class="contact-phone-hint__warn" data-mv-warn aria-live="polite"></span>
           </p>`
        : ''}
    </div>`;

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
      <label class="form-label" for="cm-birthday">${t('contacts.birthdayLabel')}</label>
      <yuvomi-datepicker id="cm-birthday" type="date" value="${v('birthday')}"></yuvomi-datepicker>
      <p class="form-hint">${t('contacts.birthdayHint')}</p>
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
        <span class="contacts-cat-select__icon vivid-mark" id="cm-cat-icon" aria-hidden="true">${categoryIcon(isEdit && contact.category ? contact.category : defaultCat, 'icon-lg')}</span>
        <select class="form-input" id="cm-category">${catOpts}</select>
      </div>
    </div>
    ${mvSection('phone', phoneRows, 'contacts.phoneLabel', 'contacts.mvAddPhone')}
    ${mvSection('email', emailRows, 'contacts.emailLabel', 'contacts.mvAddEmail')}

    ${advancedSection(advancedFieldsHtml, { open: advancedOpen })}

    <div class="modal-panel__footer contact-modal__footer">
      ${isEdit && !contact.family_user_id ? `<button class="btn btn--danger btn--icon" id="cm-delete" aria-label="${t('contacts.deleteLabel')}">
        <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
      </button>` : '<div></div>'}
      <div class="contact-modal__footer-actions">
        <button class="btn btn--secondary" id="cm-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="cm-save">${isEdit ? t('common.save') : t('common.create')}</button>
      </div>
    </div>`;

  return {
    title: isEdit ? t('contacts.editContact') : t('contacts.newContact'),
    content,
    wire(panel) {
      panel.querySelector('#cm-cancel').addEventListener('click', closeModal);

      // Mehrwert-Gruppen: Zeile ergänzen/entfernen (Telefon + E-Mail).
      panel.querySelectorAll('[data-mv-group]').forEach((group) => {
        const kind = group.dataset.mvGroup;
        const list = group.querySelector('[data-mv-list]');
        group.querySelector('[data-mv-add]')?.addEventListener('click', () => {
          list.insertAdjacentHTML('beforeend', mvRow(kind, { label: '', value: '' }, false));
          if (window.lucide) lucide.createIcons({ el: list });
          list.lastElementChild?.querySelector('[data-mv-value]')?.focus();
        });
        group.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-mv-remove]');
          if (btn) btn.closest('[data-mv-row]')?.remove();
        });
      });

      // Telefon-Tipphilfe: unverbindliche AsYouType-Vorschau + Plausibilitäts-
      // Hinweis. REIN VISUELL - die Eingabefelder werden nie umgeschrieben, es wird
      // ausschließlich der rohe Feldinhalt gespeichert (kein Datenverlust).
      wirePhoneHints(panel);

      // Kategorie-Vorschau live aktualisieren (Icon links neben dem Select).
      const catSel  = panel.querySelector('#cm-category');
      const catIcon = panel.querySelector('#cm-cat-icon');
      catSel?.addEventListener('change', () => {
        catIcon.replaceChildren();
        catIcon.insertAdjacentHTML('beforeend', categoryIcon(catSel.value, 'icon-lg'));
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
        // Mehrwert-Gruppen einsammeln: leere Zeilen fallen weg, die erste Zeile
        // ist primär und spiegelt sich in die Legacy-Einzelspalte (phone/email).
        const collectMv = (kind) => [...panel.querySelectorAll(`[data-mv-group="${kind}"] [data-mv-row]`)]
          .map((row) => ({
            label: row.querySelector('[data-mv-label]').value.trim(),
            value: row.querySelector('[data-mv-value]').value.trim(),
          }))
          .filter((r) => r.value);
        const phoneEntries = collectMv('phone');
        const emailEntries = collectMv('email');
        const phone    = phoneEntries[0]?.value || null;
        const email    = emailEntries[0]?.value || null;
        const address  = panel.querySelector('#cm-address').value.trim() || null;
        const birthday = panel.querySelector('#cm-birthday')?.value || null;
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
          const body = { name, category, phone, email, address, notes, birthday };
          // Replace-Set: das Formular hält alle Werte, Label-Pflicht des Servers
          // deckt 'other' als neutrales Default ab.
          body.phones = phoneEntries.map((r, i) => ({ label: r.label || 'other', value: r.value, isPrimary: i === 0 }));
          body.emails = emailEntries.map((r, i) => ({ label: r.label || 'other', value: r.value, isPrimary: i === 0 }));
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
  };
}

// --------------------------------------------------------
// Auswahl-Modus (opt-in Bulk)
// --------------------------------------------------------

/* DIE SAMMELAKTION IST DIE GETEILTE PILLE (Critique 2026-08-13).
 *
 * Hier stand eine eigene Auswahlleiste im Fluss der Seite: „Abbrechen" links,
 * die Zahl in der Mitte, „Alle auswählen" und ein vollflächig rotes „Löschen"
 * in einer ZWEITEN Zeile. Gemessen bei 390x844 schob sie rund 120px Chrome über
 * die Liste - zusammen mit Kopf und Filterzeile standen im Auswahlmodus 334 von
 * 844px als Kopf, bevor der erste Kontakt kam.
 *
 * Genau dieser Defekt ist der dokumentierte Anlass der Pille (list-row.css:
 * „103 von 552px Listenfläche, ausgelöst von einem einzigen abgehakten
 * Artikel"). Er stand hier unverändert, während seine Lösung eine Datei weiter
 * lag: die Küche hatte sie bekommen, die Kontakte nicht.
 *
 * Was der Umzug MITBRINGT, statt es hier ein zweites Mal zu bauen: die
 * Rückfrage vor dem Löschen, den Fokus, der danach auf einem lebenden Knopf
 * landet, die Zahl als Marke, wenn die Pille für den ganzen Satz zu schmal
 * wird, und Escape. Und er nimmt die zweite destruktive Sprache mit: rot
 * gefüllt hier gegen rot umrandet auf dem Shell-Material dort.
 *
 * Der AUSSTIEG bleibt, wo er war - beim Umschalter im Kopf, der `aria-pressed`
 * trägt, und auf Escape. Die Pille bekommt ihn nicht als dritte Kapsel: sie
 * bleibt einzeilig, und ein Auswahlmodus, den man nur unten verlassen kann,
 * hätte den Knopf oben zur Attrappe gemacht.
 */
function enterSelectMode() {
  state.selectMode = true;
  state.selected.clear();
  _container.querySelector('#contacts-select-btn')?.setAttribute('aria-pressed', 'true');
  _container.querySelector('.contacts-page')?.classList.add('is-selecting');
  renderList();
  updateSelectUI();
}

function exitSelectMode() {
  state.selectMode = false;
  state.selected.clear();
  _container.querySelector('#contacts-select-btn')?.setAttribute('aria-pressed', 'false');
  _container.querySelector('.contacts-page')?.classList.remove('is-selecting');
  clearBulkPill();
  renderList();
}

function updateSelectUI() {
  if (!state.selectMode) { clearBulkPill(); return; }
  const n = state.selected.size;
  const actions = [{ label: t('contacts.selectAll'), onClick: () => toggleSelectAll() }];
  // Ohne Auswahl gibt es nichts zu löschen, und die Kapsel steht dann gar nicht
  // da - dieselbe Sprache wie in der Küche, wo die ganze Pille erst mit dem
  // ersten Haken erscheint. Ein abgeschalteter Knopf wäre die dritte Antwort
  // auf „hier ist gerade nichts zu tun", neben Weglassen und Verschwinden.
  if (n > 0) {
    actions.push({
      label: t('common.delete'),
      ariaLabel: t('contacts.bulkDeleteConfirm', { count: n }),
      // Die Zahl als Marke: sie wird sichtbar, wo das Subjekt links wegfällt.
      // „Löschen" ohne genanntes Objekt über einer Kontaktliste ist der Satz,
      // den man am wenigsten raten möchte.
      count: n,
      danger: true,
      confirm: { question: t('contacts.bulkDeleteConfirm', { count: n }) },
      onClick: () => deleteSelected(),
    });
  }
  setBulkPill({ label: t('contacts.selectCount', { count: n }), actions });
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
  // Ohne Neusortierung würden importierte Kontakte einfach ans Ende ihrer
  // Kategorie-Gruppe angehängt statt alphabetisch einsortiert (renderList()
  // verlässt sich auf bereits sortierte state.contacts, siehe Anlage/Edit oben).
  state.contacts.sort((a, b) =>
    catSortIndex(a.category) - catSortIndex(b.category) || byName(a, b)
  );
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
