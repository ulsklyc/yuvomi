/** The same interval and toggle controls for ordinary entries and transfers. */
import { t } from '/i18n.js';
import { formSwitchRowHtml } from '/settings/components.js';
import { intervalUnitLabel } from '/rrule-ui.js';
import { MAX_INTERVAL_COUNT } from '/utils/budget-recurrence.js';

/** Ein Schalter der Budget-Dialoge: die Schalterzeile der Moduldialoge (R23, D8). */
export function budgetToggleHtml(id, label, { checked = false, disabled = false } = {}) {
  return formSwitchRowHtml({ label: t(label), checked, disabled, attrs: { id } });
}

export function budgetIntervalFieldsHtml(prefix, interval = 'monthly', count = 1) {
  return `<label class="form-label" for="${prefix}-interval">${t('budget.recurringIntervalLabel')}</label>
    <select class="form-input" id="${prefix}-interval">
      ${[['weekly', 'budget.intervalWeekly'], ['monthly', 'budget.intervalMonthly'], ['yearly', 'budget.intervalYearly']].map(([value, key]) => `<option value="${value}"${interval === value ? ' selected' : ''}>${t(key)}</option>`).join('')}
    </select>
    <div class="rrule-interval-wrap" style="margin-top:var(--space-3)">
      <label class="form-label" for="${prefix}-interval-count" style="margin:0">${t('rrule.labelEvery')}</label>
      <input class="form-input" type="number" id="${prefix}-interval-count" min="1" max="${MAX_INTERVAL_COUNT}"
        value="${count}" inputmode="numeric" style="width:64px;text-align:center">
      <span class="rrule-interval-unit" id="${prefix}-interval-unit">${intervalUnitLabel(interval, count)}</span>
    </div>`;
}

export function wireBudgetIntervalFields(panel, prefix) {
  const interval = panel.querySelector(`#${prefix}-interval`);
  const count = panel.querySelector(`#${prefix}-interval-count`);
  const unit = panel.querySelector(`#${prefix}-interval-unit`);
  const sync = () => { unit.textContent = intervalUnitLabel(interval.value, parseInt(count.value, 10) || 1); };
  interval.addEventListener('change', sync);
  count.addEventListener('input', sync);
}
