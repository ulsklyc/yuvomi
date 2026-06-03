/**
 * Modul: Pinnwand / Notizen (Notes)
 * Zweck: Masonry-Grid mit farbigen Sticky Notes, Pin-Toggle, CRUD
 * Abhängigkeiten: /api.js, /router.js (window.oikos)
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, btnError } from '/components/modal.js';
import { stagger, vibrate } from '/utils/ux.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const NOTE_COLORS = [
  '#FFEB3B', '#FFD54F', '#A5D6A7', '#80DEEA',
  '#90CAF9', '#CE93D8', '#FFAB91', '#FFFFFF',
];

const NOTE_COLOR_NAMES = () => ({
  '#FFEB3B': t('notes.colorYellow'),
  '#FFD54F': t('notes.colorAmber'),
  '#A5D6A7': t('notes.colorGreen'),
  '#80DEEA': t('notes.colorTeal'),
  '#90CAF9': t('notes.colorBlue'),
  '#CE93D8': t('notes.colorPurple'),
  '#FFAB91': t('notes.colorOrange'),
  '#FFFFFF': t('notes.colorWhite'),
});

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = { notes: [], user: null, filterQuery: '' };
let _container = null;

// --------------------------------------------------------
// Markdown-Light Renderer
// --------------------------------------------------------

function renderMarkdownLight(text) {
  if (!text) return '';
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/^- (.+)$/gm,     '• $1')
    .replace(/\n/g,            '<br>');
}

// --------------------------------------------------------
// Entry Point
// --------------------------------------------------------

export async function render(container, { user }) {
  _container = container;
  state.user = user;

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="notes-page">
      <div class="notes-toolbar">
        <h1 class="notes-toolbar__title">${t('notes.title')}</h1>
        <div class="notes-toolbar__search">
          <i data-lucide="search" class="notes-toolbar__search-icon" aria-hidden="true"></i>
          <input type="search" id="notes-search" class="notes-toolbar__search-input"
                 placeholder="${t('notes.searchPlaceholder')}" autocomplete="off"
                 value="${esc(state.filterQuery)}">
        </div>
        <button class="btn btn--primary toolbar-new-btn" id="notes-add-btn">
          <i data-lucide="plus" style="width:16px;height:16px;margin-right:4px;" aria-hidden="true"></i>
          ${t('notes.addNoteLabel')}
        </button>
      </div>
      <div id="notes-grid" class="notes-grid"></div>
      <button class="page-fab" id="fab-new-note" aria-label="${t('notes.addNoteLabel')}">
        <i data-lucide="plus" style="width:24px;height:24px" aria-hidden="true"></i>
      </button>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: container });

  try {
    const res  = await api.get('/notes');
    state.notes = res.data;
  } catch (err) {
    console.error('[Notes] Laden fehlgeschlagen:', err);
    state.notes = [];
    window.oikos?.showToast(t('notes.loadError'), 'danger');
  }
  const grid = container.querySelector('#notes-grid');
  grid.addEventListener('click', async (e) => {
    const pinBtn = e.target.closest('[data-action="pin"]');
    if (pinBtn) { e.stopPropagation(); await togglePin(parseInt(pinBtn.dataset.id, 10)); return; }

    const delBtn = e.target.closest('[data-action="delete"]');
    if (delBtn) { e.stopPropagation(); await deleteNote(parseInt(delBtn.dataset.id, 10)); return; }

    const card = e.target.closest('.note-card[data-id]');
    if (card) {
      const note = state.notes.find((n) => n.id === parseInt(card.dataset.id, 10));
      if (note) openNoteModal({ mode: 'edit', note });
    }
  });

  renderGrid();

  const addHandler = () => openNoteModal({ mode: 'create' });
  _container.querySelector('#notes-add-btn').addEventListener('click', addHandler);
  _container.querySelector('#fab-new-note').addEventListener('click', addHandler);

  _container.querySelector('#notes-search').addEventListener('input', (e) => {
    state.filterQuery = e.target.value;
    renderGrid();
  });
}

// --------------------------------------------------------
// Grid
// --------------------------------------------------------

function renderGrid() {
  const grid = _container.querySelector('#notes-grid');
  if (!grid) return;

  const q = state.filterQuery.trim().toLowerCase();
  const visible = q
    ? state.notes.filter((n) =>
        (n.title   || '').toLowerCase().includes(q) ||
        (n.content || '').toLowerCase().includes(q)
      )
    : state.notes;

  if (!visible.length) {
    const isFiltered = q.length > 0;
    grid.replaceChildren();
    grid.insertAdjacentHTML('beforeend', `
      <div class="empty-state" style="column-span:all;">
        <svg class="empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
        <div class="empty-state__title">${isFiltered ? t('notes.noResultsTitle') : t('notes.emptyTitle')}</div>
        <div class="empty-state__description">${isFiltered ? t('notes.noResultsDescription', { query: state.filterQuery }) : t('notes.emptyDescription')}</div>
        ${!isFiltered ? `<p class="empty-state__hint">${t('emptyHint.notes')}</p>
        <button class="btn btn--primary empty-state__cta" id="empty-cta-notes">
          <i data-lucide="plus" aria-hidden="true" class="icon-md"></i>
          ${t('notes.emptyAction')}
        </button>` : ''}
      </div>
    `);
    if (window.lucide) lucide.createIcons({ el: grid });
    grid.querySelector('#empty-cta-notes')?.addEventListener('click', () => {
      document.querySelector('.page-fab')?.click();
    });
    return;
  }

  grid.replaceChildren();
  grid.insertAdjacentHTML('beforeend', visible.map((n) => renderNoteCard(n)).join(''));
  if (window.lucide) lucide.createIcons({ el: grid });
  stagger(grid.querySelectorAll('.note-card'));
}

function renderNoteCard(note) {
  const initials = note.creator_name
    ? note.creator_name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)
    : '?';

  const textColor = isLightColor(note.color) ? 'rgba(0,0,0,0.8)' : '#ffffff';

  return `
    <div class="note-card ${note.pinned ? 'note-card--pinned' : ''}"
         data-id="${note.id}"
         style="background-color:${esc(note.color)};color:${textColor};">
      <button class="note-card__pin" data-action="pin" data-id="${note.id}"
              aria-label="${note.pinned ? t('notes.unpinAction') : t('notes.pinAction')}">
        <i data-lucide="${note.pinned ? 'pin-off' : 'pin'}" style="width:12px;height:12px;" aria-hidden="true"></i>
      </button>
      ${note.title ? `<div class="note-card__title">${esc(note.title)}</div>` : ''}
      <div class="note-card__content">${renderMarkdownLight(note.content)}</div>
      <div class="note-card__footer">
        <div class="note-card__creator">
          <span class="note-card__avatar"
                style="background-color:${esc(note.creator_color || '#8E8E93')}">${initials}</span>
          <span>${esc(note.creator_name || '')}</span>
        </div>
        <button class="note-card__delete" data-action="delete" data-id="${note.id}" aria-label="${t('notes.deleteLabel')}">
          <i data-lucide="trash-2" style="width:12px;height:12px;" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `;
}

// --------------------------------------------------------
// Formatierungs-Helfer
// --------------------------------------------------------

function applyFormat(textarea, format) {
  const start = textarea.selectionStart;
  const end   = textarea.selectionEnd;
  const text  = textarea.value;
  const sel   = text.slice(start, end);

  let before, after, insert;
  switch (format) {
    case 'bold':
      before = '**'; after = '**';
      insert = sel || 'Text';
      break;
    case 'italic':
      before = '*'; after = '*';
      insert = sel || 'Text';
      break;
    case 'underline':
      before = '<u>'; after = '</u>';
      insert = sel || 'Text';
      break;
    case 'strikethrough':
      before = '~~'; after = '~~';
      insert = sel || 'Text';
      break;
    case 'code':
      before = '`'; after = '`';
      insert = sel || 'Code';
      break;
    case 'link':
      if (sel) {
        textarea.setRangeText(`[${sel}](url)`, start, end, 'select');
        textarea.selectionStart = start + sel.length + 3;
        textarea.selectionEnd   = start + sel.length + 6;
      } else {
        textarea.setRangeText('[Linktext](url)', start, end, 'select');
        textarea.selectionStart = start + 1;
        textarea.selectionEnd   = start + 9;
      }
      return;
    case 'heading': {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const lineEnd   = text.indexOf('\n', start);
      const line      = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      const match     = line.match(/^(#{1,3})\s/);
      if (match && match[1].length < 3) {
        textarea.setRangeText('#' + line, lineStart, lineEnd === -1 ? text.length : lineEnd, 'end');
      } else if (match && match[1].length >= 3) {
        textarea.setRangeText(line.replace(/^#{1,3}\s/, ''), lineStart, lineEnd === -1 ? text.length : lineEnd, 'end');
      } else {
        textarea.setRangeText('## ' + line, lineStart, lineEnd === -1 ? text.length : lineEnd, 'end');
      }
      return;
    }
    case 'list': {
      if (sel) {
        const lines = sel.split('\n').map((l) => l.startsWith('- ') ? l : `- ${l}`);
        textarea.setRangeText(lines.join('\n'), start, end, 'end');
        return;
      }
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const currentLine = text.slice(lineStart, start);
      if (currentLine.trim() === '') {
        textarea.setRangeText('- ', start, start, 'end');
      } else {
        textarea.setRangeText('\n- ', start, start, 'end');
      }
      return;
    }
    case 'ordered-list': {
      if (sel) {
        const lines = sel.split('\n').map((l, i) => `${i + 1}. ${l.replace(/^\d+\.\s/, '')}`);
        textarea.setRangeText(lines.join('\n'), start, end, 'end');
        return;
      }
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const currentLine = text.slice(lineStart, start);
      if (currentLine.trim() === '') {
        textarea.setRangeText('1. ', start, start, 'end');
      } else {
        textarea.setRangeText('\n1. ', start, start, 'end');
      }
      return;
    }
    case 'checklist': {
      if (sel) {
        const lines = sel.split('\n').map((l) => l.startsWith('- [ ] ') ? l : `- [ ] ${l}`);
        textarea.setRangeText(lines.join('\n'), start, end, 'end');
        return;
      }
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const currentLine = text.slice(lineStart, start);
      if (currentLine.trim() === '') {
        textarea.setRangeText('- [ ] ', start, start, 'end');
      } else {
        textarea.setRangeText('\n- [ ] ', start, start, 'end');
      }
      return;
    }
    case 'quote': {
      if (sel) {
        const lines = sel.split('\n').map((l) => l.startsWith('> ') ? l : `> ${l}`);
        textarea.setRangeText(lines.join('\n'), start, end, 'end');
        return;
      }
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const currentLine = text.slice(lineStart, start);
      if (currentLine.trim() === '') {
        textarea.setRangeText('> ', start, start, 'end');
      } else {
        textarea.setRangeText('\n> ', start, start, 'end');
      }
      return;
    }
    case 'divider':
      textarea.setRangeText('\n\n---\n\n', start, end, 'end');
      return;
    default: return;
  }

  const replacement = `${before}${insert}${after}`;
  textarea.setRangeText(replacement, start, end, 'select');
  // Selektion auf den eingefügten Text setzen (ohne Marker)
  textarea.selectionStart = start + before.length;
  textarea.selectionEnd   = start + before.length + insert.length;
}

// --------------------------------------------------------
// Modal
// --------------------------------------------------------

function openNoteModal({ mode, note = null }) {
  const isEdit    = mode === 'edit';
  const selColor  = isEdit ? note.color : NOTE_COLORS[0];

  const content = `
    <div class="form-group">
      <label class="form-label" for="note-title">${t('notes.titleLabel')}</label>
      <input type="text" class="form-input" id="note-title"
             placeholder="${t('notes.titlePlaceholder')}" value="${esc(isEdit && note.title ? note.title : '')}">
    </div>
    <div class="form-group">
      <label class="form-label" for="note-content">${t('notes.contentLabel')} <span style="font-weight:400;color:var(--text-tertiary);font-size:.85em;">${t('notes.contentMarkdownHint')}</span></label>
      <div class="note-format-toolbar">
        <button type="button" class="note-format-btn" data-format="bold" title="${t('notes.formatBold')}">
          <i data-lucide="bold" style="width:14px;height:14px;" aria-hidden="true"></i>
        </button>
        <button type="button" class="note-format-btn" data-format="italic" title="${t('notes.formatItalic')}">
          <i data-lucide="italic" style="width:14px;height:14px;" aria-hidden="true"></i>
        </button>
        <button type="button" class="note-format-btn" data-format="underline" title="${t('notes.formatUnderline')}">
          <i data-lucide="underline" style="width:14px;height:14px;" aria-hidden="true"></i>
        </button>
        <button type="button" class="note-format-btn" data-format="strikethrough" title="${t('notes.formatStrikethrough')}">
          <i data-lucide="strikethrough" style="width:14px;height:14px;" aria-hidden="true"></i>
        </button>
        <span class="note-format-btn--sep"></span>
        <button type="button" class="note-format-btn" data-format="heading" title="${t('notes.formatHeading')}">
          <i data-lucide="heading" style="width:14px;height:14px;" aria-hidden="true"></i>
        </button>
        <button type="button" class="note-format-btn" data-format="list" title="${t('notes.formatList')}">
          <i data-lucide="list" style="width:14px;height:14px;" aria-hidden="true"></i>
        </button>
        <button type="button" class="note-format-btn" data-format="ordered-list" title="${t('notes.formatOrderedList')}">
          <i data-lucide="list-ordered" style="width:14px;height:14px;" aria-hidden="true"></i>
        </button>
        <button type="button" class="note-format-btn" data-format="checklist" title="${t('notes.formatChecklist')}">
          <i data-lucide="list-checks" style="width:14px;height:14px;" aria-hidden="true"></i>
        </button>
        <span class="note-format-btn--sep"></span>
        <button type="button" class="note-format-btn" data-format="link" title="${t('notes.formatLink')}">
          <i data-lucide="link" style="width:14px;height:14px;" aria-hidden="true"></i>
        </button>
        <button type="button" class="note-format-btn" data-format="code" title="${t('notes.formatCode')}">
          <i data-lucide="code" style="width:14px;height:14px;" aria-hidden="true"></i>
        </button>
        <button type="button" class="note-format-btn" data-format="quote" title="${t('notes.formatQuote')}">
          <i data-lucide="quote" style="width:14px;height:14px;" aria-hidden="true"></i>
        </button>
        <button type="button" class="note-format-btn" data-format="divider" title="${t('notes.formatDivider')}">
          <i data-lucide="minus" style="width:14px;height:14px;" aria-hidden="true"></i>
        </button>
      </div>
      <textarea class="form-input" id="note-content" rows="6"
                placeholder="${t('notes.contentPlaceholder')}"
                style="resize:vertical;">${esc(isEdit ? note.content : '')}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label" id="note-color-label">${t('notes.colorLabel')}</label>
      <div class="note-color-picker" role="radiogroup" aria-labelledby="note-color-label">
        ${NOTE_COLORS.map((c) => `
          <div class="note-color-swatch ${c === selColor ? 'note-color-swatch--active' : ''}"
               data-color="${c}"
               style="background-color:${c};border:2px solid ${c === '#FFFFFF' ? '#E5E5EA' : c};"
               role="radio"
               tabindex="${c === selColor ? '0' : '-1'}"
               aria-checked="${c === selColor ? 'true' : 'false'}"
               aria-label="${NOTE_COLOR_NAMES()[c] ?? c}"></div>
        `).join('')}
      </div>
    </div>
    <div class="form-group">
      <label class="toggle">
        <input type="checkbox" id="note-pinned" ${isEdit && note.pinned ? 'checked' : ''}>
        <span class="toggle__track"></span>
        <span>${t('notes.pinnedLabel')}</span>
      </label>
    </div>

    <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
      <button class="btn btn--secondary" id="note-modal-cancel">${t('common.cancel')}</button>
      <button class="btn btn--primary" id="note-modal-save">${isEdit ? t('common.save') : t('common.create')}</button>
    </div>`;

  openSharedModal({
    title: isEdit ? t('notes.editNote') : t('notes.newNote'),
    content,
    size: 'md',
    onSave(panel) {
      // Farb-Swatch: Auswahl + ARIA + Keyboard (Roving Tabindex)
      function selectSwatch(target) {
        panel.querySelectorAll('.note-color-swatch').forEach((s) => {
          s.classList.remove('note-color-swatch--active');
          s.setAttribute('aria-checked', 'false');
          s.setAttribute('tabindex', '-1');
        });
        target.classList.add('note-color-swatch--active');
        target.setAttribute('aria-checked', 'true');
        target.setAttribute('tabindex', '0');
      }
      panel.querySelectorAll('.note-color-swatch').forEach((sw) => {
        sw.addEventListener('click', () => { selectSwatch(sw); sw.focus(); });
        sw.addEventListener('keydown', (e) => {
          const swatches = [...panel.querySelectorAll('.note-color-swatch')];
          const idx = swatches.indexOf(sw);
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = swatches[(idx + 1) % swatches.length];
            selectSwatch(next); next.focus();
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = swatches[(idx - 1 + swatches.length) % swatches.length];
            selectSwatch(prev); prev.focus();
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectSwatch(sw);
          }
        });
      });

      // Formatierungs-Toolbar
      const textarea = panel.querySelector('#note-content');
      panel.querySelectorAll('.note-format-btn[data-format]').forEach((btn) => {
        btn.addEventListener('click', () => {
          applyFormat(textarea, btn.dataset.format);
          textarea.focus();
        });
      });

      textarea.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) {
          if (e.key === 'b') { e.preventDefault(); applyFormat(textarea, 'bold'); }
          if (e.key === 'i') { e.preventDefault(); applyFormat(textarea, 'italic'); }
          if (e.key === 'u') { e.preventDefault(); applyFormat(textarea, 'underline'); }
        }
      });

      panel.querySelector('#note-modal-cancel').addEventListener('click', closeModal);

      panel.querySelector('#note-modal-save').addEventListener('click', async () => {
        const saveBtn = panel.querySelector('#note-modal-save');
        const title   = panel.querySelector('#note-title').value.trim() || null;
        const cnt     = panel.querySelector('#note-content').value.trim();
        const color   = panel.querySelector('.note-color-swatch--active')?.dataset.color || NOTE_COLORS[0];
        const pinned  = panel.querySelector('#note-pinned').checked ? 1 : 0;

        if (!cnt) { window.oikos?.showToast(t('common.contentRequired'), 'error'); return; }

        saveBtn.disabled    = true;
        saveBtn.textContent = '…';

        try {
          if (mode === 'create') {
            const res = await api.post('/notes', { title, content: cnt, color, pinned });
            state.notes.unshift(res.data);
          } else {
            const res = await api.put(`/notes/${note.id}`, { title, content: cnt, color, pinned });
            const idx = state.notes.findIndex((n) => n.id === note.id);
            if (idx !== -1) state.notes[idx] = res.data;
            state.notes.sort((a, b) => b.pinned - a.pinned);
          }
          closeModal({ force: true });
          renderGrid();
          window.oikos?.showToast(mode === 'create' ? t('notes.createdToast') : t('notes.savedToast'), 'success');
        } catch (err) {
          window.oikos?.showToast(err.data?.error ?? t('common.unknownError'), 'error');
          btnError(saveBtn);
          saveBtn.disabled    = false;
          saveBtn.textContent = isEdit ? t('common.save') : t('common.create');
        }
      });
    },
  });
}

// --------------------------------------------------------
// Aktionen
// --------------------------------------------------------

async function togglePin(id) {
  try {
    const res  = await api.patch(`/notes/${id}/pin`, {});
    const note = state.notes.find((n) => n.id === id);
    if (note) note.pinned = res.data.pinned;
    state.notes.sort((a, b) => b.pinned - a.pinned);
    renderGrid();
  } catch (err) {
    window.oikos?.showToast(err.data?.error ?? t('common.unknownError'), 'error');
  }
}

async function deleteNote(id) {
  closeModal({ force: true });
  const note = state.notes.find((n) => n.id === id);
  state.notes = state.notes.filter((n) => n.id !== id);
  renderGrid();
  vibrate([30, 50, 30]);

  let undone = false;
  window.oikos?.showToast(t('notes.deletedToast'), 'default', 5000, () => {
    undone = true;
    if (note) {
      state.notes = [...state.notes, note].sort((a, b) => b.pinned - a.pinned);
      renderGrid();
    }
  });

  setTimeout(async () => {
    if (undone) return;
    try {
      await api.delete(`/notes/${id}`);
    } catch (err) {
      if (note) {
        state.notes = [...state.notes, note].sort((a, b) => b.pinned - a.pinned);
        renderGrid();
      }
      window.oikos?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    }
  }, 5000);
}

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

function isLightColor(hex) {
  if (!hex) return true;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}
