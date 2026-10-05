/**
 * Shared page-toolbar search field (persistent, leading-icon, labeled).
 *
 * The canonical search affordance for list/filter modules (notes, contacts,
 * documents, birthdays, split-expenses ...). A persistent input keeps the
 * visible (sr-only) label and one-tap reachability that the audit's R4 and the
 * "search fields keep visible labels" a11y guard require. Calendar keeps its
 * reveal-on-demand bar as a documented exception (the field inside is this
 * capsule): its search is a heavyweight server-FTS results view that replaces
 * the view, not a client-side list filter.
 *
 * Visual/behaviour live here once; modules pass an id + labels and wire a
 * single onQuery callback. Toolbar positioning (flex/max-width/margin) stays a
 * thin per-module layout class passed via `className`.
 *
 * @param {object} opts
 * @param {string} opts.id           - input id (also the label's `for`)
 * @param {string} opts.label        - accessible label (sr-only)
 * @param {string} [opts.placeholder] - visible placeholder (defaults to label)
 * @param {string} [opts.value='']   - initial query value (user data, escaped)
 * @param {string} opts.clearLabel   - accessible label for the clear button
 * @param {string} [opts.className='']- extra class(es) on the .page-search root
 * @returns {string} markup for insertAdjacentHTML
 */
import { esc } from '/utils/html.js';

export function renderPageSearch({ id, label, placeholder, value = '', clearLabel = '', className = '' } = {}) {
  const ph = placeholder ?? label ?? '';
  const lbl = label ?? placeholder ?? '';
  const cls = ['page-search', className].filter(Boolean).join(' ');
  return `
    <label class="${cls}" for="${esc(id)}">
      <span class="page-search__label sr-only">${esc(lbl)}</span>
      <span class="page-search__control">
        <i data-lucide="search" class="page-search__icon" aria-hidden="true"></i>
        <input type="search" id="${esc(id)}" class="page-search__input"
               placeholder="${esc(ph)}" value="${esc(value)}" autocomplete="off"
               enterkeyhint="search" spellcheck="false">
        <button type="button" class="page-search__clear" data-page-search-clear
                aria-label="${esc(clearLabel)}"${value ? '' : ' hidden'}>
          <i data-lucide="x" aria-hidden="true"></i>
        </button>
      </span>
    </label>`;
}

/**
 * Wire a rendered page-search field: debounced input, clear button visibility,
 * and clear-on-click. Returns a small handle for programmatic control.
 *
 * @param {ParentNode} container
 * @param {object} opts
 * @param {string} opts.id
 * @param {(query: string) => void} opts.onQuery - called with the trimmed-as-is value
 * @param {number} [opts.delay=200] - debounce ms; 0 fires synchronously
 * @returns {{input: HTMLInputElement, setValue: (v: string) => void, clear: () => void} | null}
 */
export function wirePageSearch(container, { id, onQuery, delay = 200 } = {}) {
  const input = container.querySelector(`#${id}`);
  if (!input) return null;
  const control = input.closest('.page-search__control');
  const clearBtn = control?.querySelector('[data-page-search-clear]');
  const syncClear = () => { if (clearBtn) clearBtn.hidden = !input.value; };
  let timer;
  input.addEventListener('input', () => {
    syncClear();
    if (delay > 0) {
      clearTimeout(timer);
      timer = setTimeout(() => onQuery(input.value), delay);
    } else {
      onQuery(input.value);
    }
  });
  clearBtn?.addEventListener('click', () => {
    input.value = '';
    syncClear();
    onQuery('');
    input.focus();
  });
  return {
    input,
    setValue(v) { input.value = v; syncClear(); },
    clear() { input.value = ''; syncClear(); },
  };
}
