/** A chart bucket is distinct from a household-created category named saving. */
export const SAVINGS_CHART_CATEGORY = '__saving__';

export function budgetChartCategory(entry) {
  return entry.category === 'financial_other' && entry.subcategory === 'saving'
    ? SAVINGS_CHART_CATEGORY : entry.category;
}
