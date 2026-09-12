/**
 * Pure helpers for the note-category autocomplete.
 * Search is forgiving (case and accents), while exact identity preserves
 * accents so client-side duplicate prevention follows the server contract.
 */

import { categoryNameKey } from './note-category-name.js';

export const categoryIdentityKey = (value) => categoryNameKey(value ?? '');

function identityKey(value) {
  return categoryIdentityKey(String(value ?? '').trim());
}

function searchKey(value) {
  return identityKey(value).normalize('NFD').replace(/\p{M}/gu, '');
}

export function findCategorySuggestions(categories, selectedIds, query, limit = 8) {
  const selected = new Set((selectedIds || []).map(Number));
  const needle = searchKey(query);
  return (categories || [])
    .filter((category) => !selected.has(Number(category.id)))
    .filter((category) => !needle || searchKey(category.name).includes(needle))
    .slice(0, Math.max(0, Number(limit) || 0));
}

export function findExactCategory(categories, query, scope = null) {
  const needle = identityKey(query);
  if (!needle) return null;
  return (categories || []).find((category) => (
    (!scope || category.scope === scope) && identityKey(category.name) === needle
  )) || null;
}

export function categoryCreationState(categories, query, scope, canChooseScope) {
  const canCreate = !!String(query ?? '').trim()
    && !findExactCategory(categories, query, scope);
  return {
    canCreate,
    // Authorized users must be able to switch scope even when the current
    // scope already contains this name; the other scope may not contain it.
    showControls: !!canChooseScope || canCreate,
  };
}

/** Closes the popup and clears virtual focus shared by Escape and selection. */
export function closeCategoryPicker({ categoryList, categorySearch }) {
  categoryList.hidden = true;
  categorySearch.setAttribute('aria-expanded', 'false');
  categorySearch.removeAttribute('aria-activedescendant');
  return -1;
}

/**
 * Reopens a closed ARIA combobox popup and moves its virtual focus. Escape and
 * successful selection both close the same popup; the next arrow key must make
 * the active descendant visible again before announcing it.
 */
export function moveCategoryPickerOption({
  categoryList,
  categorySearch,
  renderSuggestions,
  activeIndex,
  direction,
}) {
  if (categoryList.hidden) renderSuggestions();
  const options = [...categoryList.querySelectorAll('[role="option"]')];
  if (!options.length) return { options, activeIndex: -1 };

  const nextIndex = activeIndex < 0
    ? (direction > 0 ? 0 : options.length - 1)
    : (activeIndex + direction + options.length) % options.length;
  options.forEach((option, index) => {
    const active = index === nextIndex;
    option.classList.toggle('is-active', active);
    option.setAttribute('aria-selected', String(active));
  });
  const active = options[nextIndex];
  categoryList.hidden = false;
  categorySearch.setAttribute('aria-expanded', 'true');
  categorySearch.setAttribute('aria-activedescendant', active.id);
  active.scrollIntoView({ block: 'nearest' });
  return { options, activeIndex: nextIndex };
}
