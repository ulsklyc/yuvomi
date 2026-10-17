/** The fourth budget entry type, using the shared dialog and field controls. */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { openModal, closeModal, reportFieldError, refocusAfterRender, captureModalContext } from '/components/modal.js';
import { budgetCategoryLabel } from '/utils/category-labels.js';
import { todayKey, monthPeriodKeys, defaultDateInPeriod } from '/utils/date.js';
import { amountStep, amountMin, amountIsSavable, smallestUnitLabel } from '/utils/money.js';
import { budgetToggleHtml, budgetIntervalFieldsHtml, wireBudgetIntervalFields } from '/components/budget-recurrence-fields.js';

export function transferFieldsHtml({ transfer = null, accounts, categories, month, currency, budgetMode }) {
  const { from, to } = monthPeriodKeys(month);
  const date = transfer?.date ?? defaultDateInPeriod(from, to, todayKey());
  const options = (selected, label) => `<option value="" disabled${selected ? '' : ' selected'}>${t(label)}</option>` + accounts.map(a =>
    `<option value="${a.id}"${a.id === selected ? ' selected' : ''}${a.archived && a.id !== selected ? ' disabled' : ''}>${esc(a.name)}</option>`).join('');
  const field = (id, label, control) => `<div class="form-group"><label class="form-label" for="${id}">${t(label)}${REQUIRED_MARK}</label>${control}</div>`;
  const cat = transfer?.category ?? (categories.some(c => c.key === 'financial_other') ? 'financial_other' : categories[0]?.key ?? '');
  const categoryOptions = `<option value="" disabled${cat ? '' : ' selected'}>${esc(t('budget.categoryPlaceholder'))}</option>` + categories.map(c => `<option value="${esc(c.key)}"${c.key === cat ? ' selected' : ''}>${esc(budgetCategoryLabel(c.key, c.name, t))}</option>`).join('');
  const recurring = Boolean(transfer?.is_recurring || transfer?.recurrence_parent_id);
  const schedule = transfer?.series ?? transfer;
  const sourceCurrency = accounts.find(a => a.id === transfer?.from_account_id)?.currency || currency;
  return `
    ${field('bt-amount', 'budget.amountLabel', `<input class="form-input budget-amount-input" id="bt-amount" type="number" step="${amountStep(sourceCurrency, transfer?.amount)}" min="${amountMin(sourceCurrency, transfer?.amount)}" inputmode="decimal" value="${transfer ? Math.abs(transfer.amount) : ''}">`)}
    ${field('bt-title', 'budget.titleLabel', `<input class="form-input" id="bt-title" value="${esc(transfer?.title ?? '')}">`)}
    ${field('bt-from', 'budget.transferFromAccount', `<select class="form-input" id="bt-from" required>${options(transfer?.from_account_id, 'budget.transferFromAccount')}</select>`)}
    ${field('bt-to', 'budget.transferToAccount', `<select class="form-input" id="bt-to" required>${options(transfer?.to_account_id, 'budget.transferToAccount')}</select>`)}
    ${field('bt-category', 'budget.categoryLabel', `<select class="form-input" id="bt-category">${categoryOptions}</select>`)}
    <div class="form-group" id="bt-subcategory-group" hidden><label class="form-label" for="bt-subcategory">${t('budget.subcategoryLabel')}</label><select class="form-input" id="bt-subcategory"></select></div>
    ${field('bt-date', 'budget.dateLabel', `<yuvomi-datepicker id="bt-date" type="date" value="${date}"></yuvomi-datepicker>`)}
    ${budgetMode === 'personal' ? field('bt-visibility', 'budget.visibilityLabel', `<select class="form-input" id="bt-visibility">${['private', 'shared', 'shared_amount'].map(v => `<option value="${v}"${v === (transfer?.visibility ?? 'private') ? ' selected' : ''}>${t(`budget.visibility_${v}`)}</option>`).join('')}</select>`) : ''}
    ${recurring ? field('bt-scope', 'budget.recurringSeriesScope', `<select class="form-input" id="bt-scope"><option value="this">${t('budget.recurringThisOnly')}</option><option value="series">${t('budget.recurringEditSeries')}</option></select>`) : ''}
    <div class="form-group">${budgetToggleHtml('bt-recurring', 'budget.recurringLabel', { checked: recurring, disabled: Boolean(transfer) })}</div>
    <div class="form-group" id="bt-recurrence"${recurring ? '' : ' hidden'}>
      ${budgetIntervalFieldsHtml('bt', schedule?.recurrence_interval ?? 'monthly', schedule?.recurrence_interval_count ?? 1)}
      <div class="form-group">${budgetToggleHtml('bt-confirm', 'budget.confirmFirstLabel', { checked: Boolean(schedule?.recurrence_confirm) })}</div>
    </div>
`;
}

export function wireTransferForm(panel, { transfer = null, accounts = [], currency, subcategories = {}, readOnly, onSaved, onDelete, onError }) {
  const syncAmountCurrency = () => {
    const sourceId = Number(panel.querySelector('#bt-from').value);
    const sourceCurrency = accounts.find(a => a.id === sourceId)?.currency || currency;
    const current = panel.querySelector('#bt-scope')?.value === 'series' ? transfer?.series : transfer;
    const original = sourceId === current?.from_account_id ? current.amount : undefined;
    const amount = panel.querySelector('#bt-amount');
    amount.step = amountStep(sourceCurrency, original);
    amount.min = amountMin(sourceCurrency, original);
  };
  panel.querySelector('#bt-from').addEventListener('change', syncAmountCurrency);
  syncAmountCurrency();
  wireBudgetIntervalFields(panel, 'bt');
  const syncSubcategory = (selected = '') => {
    const subs = subcategories[panel.querySelector('#bt-category').value] ?? [];
    const select = panel.querySelector('#bt-subcategory');
    const value = subs.some(s => s.key === selected) ? selected : (subs.length === 1 ? subs[0].key : '');
    select.replaceChildren();
    select.insertAdjacentHTML('beforeend', (subs.length > 1 ? `<option value="" disabled${value ? '' : ' selected'}>${esc(t('budget.subcategoryPlaceholder'))}</option>` : '')
      + subs.map(s => `<option value="${esc(s.key)}"${s.key === value ? ' selected' : ''}>${esc(s.key === 'saving' ? t('budget.catSaving') : s.name)}</option>`).join(''));
    select.value = value;
    select.required = subs.length > 1;
    panel.querySelector('#bt-subcategory-group').hidden = subs.length === 0;
  };
  panel.querySelector('#bt-category').addEventListener('change', () => syncSubcategory());
  syncSubcategory(transfer?.subcategory ?? 'saving');
  const scope = panel.querySelector('#bt-scope');
  const syncRecurrenceEditing = () => {
    for (const id of ['interval', 'interval-count', 'confirm']) {
      const input = panel.querySelector('#bt-' + id);
      if (input) input.disabled = Boolean(transfer) && scope?.value !== 'series';
    }
  };
  if (transfer?.series && scope) {
    let defaults = transfer;
    const text = (object, key) => String(key === 'amount' ? Math.abs(object.amount) : object[key] ?? '');
    scope.addEventListener('change', () => {
      const target = scope.value === 'series' ? transfer.series : transfer;
      const subcategory = panel.querySelector('#bt-subcategory').value;
      for (const [id, key] of [['title', 'title'], ['amount', 'amount'], ['date', 'date'], ['from', 'from_account_id'],
        ['to', 'to_account_id'], ['category', 'category'], ['visibility', 'visibility']]) {
        const input = panel.querySelector('#bt-' + id);
        // Keep edits made before the user chose the scope; replace only untouched defaults.
        if (input && input.value === text(defaults, key)) input.value = text(target, key);
      }
      syncSubcategory(subcategory === (defaults.subcategory ?? '') ? target.subcategory : subcategory);
      defaults = target;
      syncAmountCurrency();
      syncRecurrenceEditing();
    });
  }
  syncRecurrenceEditing();
  panel.querySelector('#bt-recurring').addEventListener('change', e => { panel.querySelector('#bt-recurrence').hidden = !e.target.checked; });
  panel.querySelector('#bt-delete')?.addEventListener('click', async () => { await onDelete(transfer.id); refocusAfterRender(); });
  return async (button = panel.querySelector('#bt-save')) => {
    if (readOnly()) return;
    const value = id => panel.querySelector('#bt-' + id).value;
    const body = { title: value('title').trim(), amount: Number(value('amount')), category: value('category'), subcategory: value('subcategory'),
      date: value('date'), from_account_id: Number(value('from')), to_account_id: Number(value('to')) };
    if (!body.category) return reportFieldError(panel.querySelector('#bt-category'), t('budget.categoryRequired'));
    if (panel.querySelector('#bt-subcategory').required && !body.subcategory) return reportFieldError(panel.querySelector('#bt-subcategory'), t('budget.subcategoryRequired'));
    if (!body.title) return reportFieldError(panel.querySelector('#bt-title'), t('common.titleRequired'));
    if (!(body.amount > 0)) return reportFieldError(panel.querySelector('#bt-amount'), t('budget.validAmountRequired'));
    const sourceCurrency = accounts.find(a => a.id === body.from_account_id)?.currency || currency;
    const current = scope?.value === 'series' ? transfer?.series : transfer;
    const original = current?.from_account_id === body.from_account_id ? Math.abs(current.amount) : null;
    if (!amountIsSavable(body.amount, sourceCurrency, { original })) return reportFieldError(panel.querySelector('#bt-amount'),
      t('common.amountPrecisionRequired', { currency: sourceCurrency, step: smallestUnitLabel(sourceCurrency) }));
    if (!body.from_account_id || !body.to_account_id || body.from_account_id === body.to_account_id) return reportFieldError(panel.querySelector('#bt-to'), t('budget.transferChooseAccounts'));
    if (panel.querySelector('#bt-visibility')) body.visibility = value('visibility');
    const suffix = panel.querySelector('#bt-scope')?.value === 'series' ? '/series' : '';
    if (!transfer || suffix) Object.assign(body, { is_recurring: panel.querySelector('#bt-recurring').checked,
      recurrence_interval: value('interval'), recurrence_interval_count: Number(value('interval-count')),
      recurrence_confirm: panel.querySelector('#bt-confirm').checked });
    const context = captureModalContext();
    button.disabled = true;
    try {
      if (transfer) await api.put(`/budget/transfers/${transfer.id}${suffix}`, body);
      else await api.post('/budget/transfers', body);
      await closeModal({ force: true, context }); await onSaved(); refocusAfterRender();
    } catch (err) { onError(err, panel); button.disabled = false; }
  };
}

export async function openTransferDialog(options) {
  const { entry, readOnly, onError } = options;
  if (readOnly()) return;
  let transfer = null;
  try { if (entry) transfer = (await api.get(`/budget/transfers/${entry.id}`)).data; }
  catch (err) { onError(err); return; }
  const content = transferFieldsHtml({ ...options, transfer }) + `
    <div class="modal-panel__footer">
      ${transfer ? `<button class="btn btn--danger-outline" id="bt-delete">${t('common.delete')}</button>` : ''}
      <button class="btn btn--secondary" id="bt-cancel">${t('common.cancel')}</button>
      <button class="btn btn--primary" id="bt-save">${t(transfer ? 'common.save' : 'common.add')}</button>
    </div>`;
  openModal({ title: t('budget.typeTransfer'), content, size: 'md', onSave(panel) {
    panel.querySelector('#bt-cancel').addEventListener('click', closeModal);
    const save = wireTransferForm(panel, { ...options, transfer });
    panel.querySelector('#bt-save').addEventListener('click', () => save());
  } });
}
