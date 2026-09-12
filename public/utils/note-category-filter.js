/** Returns true when a note contains every selected category (AND filter). */
export function noteMatchesCategories(note, selectedCategoryIds) {
  if (!selectedCategoryIds?.length) return true;
  const assigned = new Set((note.categories || []).map((category) => Number(category.id)));
  return selectedCategoryIds.every((id) => assigned.has(Number(id)));
}

/** Kategorie-IDs, die in der aktuellen Notizmenge tatsaechlich vorkommen. */
export function occupiedNoteCategoryIds(notes) {
  return new Set(
    (notes || []).flatMap((note) => (note.categories || []).map((category) => Number(category.id))),
  );
}

/** Drops filters whose category disappeared since the previous page visit. */
export function pruneMissingNoteCategoryIds(selectedCategoryIds, categories) {
  const visibleIds = new Set((categories || []).map((category) => Number(category.id)));
  return (selectedCategoryIds || []).filter((id) => visibleIds.has(Number(id)));
}

/**
 * Entfernt eine serverseitig gelöschte Kategorie sofort aus allen Notes-
 * Ansichten. Der anschließende GET bleibt die autoritative Reconciliation,
 * aber ein vorübergehender Ladefehler darf keine gelöschten Badges konservieren.
 */
export function removeNoteCategoryFromState(state, categoryId) {
  const id = Number(categoryId);
  state.categories = (state.categories || []).filter((category) => Number(category.id) !== id);
  state.filterCategoryIds = (state.filterCategoryIds || []).filter((selectedId) => Number(selectedId) !== id);
  state.notes = (state.notes || []).map((note) => {
    const categories = (note.categories || []).filter((category) => Number(category.id) !== id);
    return categories.length === (note.categories || []).length ? note : { ...note, categories };
  });
}
