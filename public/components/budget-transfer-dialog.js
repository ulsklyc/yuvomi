/** The fourth budget entry type, using the shared dialog and field controls. */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { openModal, closeModal, reportFieldErrors, refocusAfterRender, captureModalContext, captureOpenContext, isModalContextCurrent, advancedSection } from '/components/modal.js';
import { budgetCategoryLabel } from '/utils/category-labels.js';
import { todayKey, monthPeriodKeys, defaultDateInPeriod } from '/utils/date.js';
import { parseAmountInput, amountToInput } from '/utils/money.js';
import { amountFieldHtml, setAmountUnit, amountFieldError } from '/utils/amount-field.js';
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
  /* DIE UMBUCHUNG IM GELDGERUEST (Critique R24 G4-Budget-P2-1, D9). Bis R24
   * wuchs der Dialog beim Wechsel Ausgabe -> Umbuchung von 632 auf 852px, der
   * Betrag hatte kein Waehrungszeichen, der Titel einen Stern ohne Pflicht, Von
   * und Auf standen untereinander und die Kategorie "Sparen" war Pflicht im
   * Blick. Jetzt: der Betrag mit dem Zeichen des Quellkontos (amountFieldHtml),
   * Von -> Auf in EINER Zeile, der Titel darf leer bleiben (er heisst dann
   * "Umbuchung Von -> Auf", der Platzhalter zeigt es), und was selten
   * geaendert wird - Kategorie, Sichtbarkeit, Wiederholung - liegt hinter
   * "Weitere Angaben" und nennt sich dort; offen, sobald die Umbuchung eine
   * Serie ist. */
  const fromName = accounts.find(a => a.id === transfer?.from_account_id)?.name;
  const toName = accounts.find(a => a.id === transfer?.to_account_id)?.name;
  return `
    <div class="form-group">
      <label class="form-label" for="bt-amount">${t('budget.amountLabel')}${REQUIRED_MARK}</label>
      ${amountFieldHtml({ id: 'bt-amount', currency: sourceCurrency, value: transfer ? Math.abs(transfer.amount) : '' })}
    </div>
    <div class="budget-transfer-route">
      ${field('bt-from', 'budget.transferFromAccount', `<select class="form-input" id="bt-from" required>${options(transfer?.from_account_id, 'budget.transferFromAccount')}</select>`)}
      <i data-lucide="arrow-right" class="budget-transfer-route__arrow" aria-hidden="true"></i>
      ${field('bt-to', 'budget.transferToAccount', `<select class="form-input" id="bt-to" required>${options(transfer?.to_account_id, 'budget.transferToAccount')}</select>`)}
    </div>
    <div class="form-group"><label class="form-label" for="bt-title">${t('budget.titleLabel')}</label><input class="form-input" id="bt-title" value="${esc(transfer?.title ?? '')}" placeholder="${esc(transferTitle(fromName, toName))}"></div>
    ${field('bt-date', 'budget.dateLabel', `<yuvomi-datepicker id="bt-date" type="date" value="${date}"></yuvomi-datepicker>`)}
    ${recurring ? field('bt-scope', 'budget.recurringSeriesScope', `<select class="form-input" id="bt-scope"><option value="this">${t('budget.recurringThisOnly')}</option><option value="series">${t('budget.recurringEditSeries')}</option></select>`) : ''}
    ${advancedSection(`
    ${field('bt-category', 'budget.categoryLabel', `<select class="form-input" id="bt-category">${categoryOptions}</select>`)}
    <div class="form-group" id="bt-subcategory-group" hidden><label class="form-label" for="bt-subcategory">${t('budget.subcategoryLabel')}</label><select class="form-input" id="bt-subcategory"></select></div>
    ${budgetMode === 'personal' ? field('bt-visibility', 'budget.visibilityLabel', `<select class="form-input" id="bt-visibility">${['private', 'shared', 'shared_amount'].map(v => `<option value="${v}"${v === (transfer?.visibility ?? 'private') ? ' selected' : ''}>${t(`budget.visibility_${v}`)}</option>`).join('')}</select>`) : ''}
    <div class="form-group">${budgetToggleHtml('bt-recurring', 'budget.recurringLabel', { checked: recurring, disabled: Boolean(transfer) })}</div>
    <div class="form-group" id="bt-recurrence"${recurring ? '' : ' hidden'}>
      ${budgetIntervalFieldsHtml('bt', schedule?.recurrence_interval ?? 'monthly', schedule?.recurrence_interval_count ?? 1)}
      <div class="form-group">${budgetToggleHtml('bt-confirm', 'budget.confirmFirstLabel', { checked: Boolean(schedule?.recurrence_confirm) })}</div>
    </div>`, { hint: t('budget.transferMoreDetailsHint'), open: recurring })}
`;
}

/** Der Titel einer Umbuchung ohne eigenen: "Umbuchung Girokonto -> Sparkonto". */
function transferTitle(from, to) {
  return from && to ? t('budget.transferDefaultTitle', { from, to }) : t('budget.typeTransfer');
}

export function wireTransferForm(panel, { transfer = null, accounts = [], currency, subcategories = {}, readOnly, onSaved, onDelete, onError }) {
  const syncAmountCurrency = () => {
    const sourceId = Number(panel.querySelector('#bt-from').value);
    const sourceCurrency = accounts.find(a => a.id === sourceId)?.currency || currency;
    setAmountUnit(panel.querySelector('#bt-amount'), sourceCurrency);
  };
  // Der Platzhalter des Titels nennt den Titel, den eine Umbuchung ohne
  // eigenen bekommt - er folgt den beiden Konten.
  const syncTitlePlaceholder = () => {
    const name = (id) => accounts.find(a => a.id === Number(panel.querySelector(id).value))?.name;
    panel.querySelector('#bt-title').placeholder = transferTitle(name('#bt-from'), name('#bt-to'));
  };
  panel.querySelector('#bt-from').addEventListener('change', () => { syncAmountCurrency(); syncTitlePlaceholder(); });
  panel.querySelector('#bt-to').addEventListener('change', syncTitlePlaceholder);
  syncAmountCurrency();
  syncTitlePlaceholder();
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
    const sourceOf = (object) => accounts.find(a => a.id === object.from_account_id)?.currency || currency;
    const text = (object, key) => String(key === 'amount' ? amountToInput(Math.abs(object.amount), sourceOf(object)) : object[key] ?? '');
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
    const body = { title: value('title').trim(), amount: parseAmountInput(value('amount')), category: value('category'), subcategory: value('subcategory'),
      date: value('date'), from_account_id: Number(value('from')), to_account_id: Number(value('to')) };
    // ALLE FEHLER AUF EINMAL, Fokus aufs erste im Bild (R23, D8 - wie der
    // Buchungsdialog seit R19): vorher meldete der Dialog einen Fehler je Klick.
    const sourceCurrency = accounts.find(a => a.id === body.from_account_id)?.currency || currency;
    const current = scope?.value === 'series' ? transfer?.series : transfer;
    const original = current?.from_account_id === body.from_account_id ? Math.abs(current.amount) : null;
    if (reportFieldErrors([
      !body.category && [panel.querySelector('#bt-category'), t('budget.categoryRequired')],
      panel.querySelector('#bt-subcategory').required && !body.subcategory && [panel.querySelector('#bt-subcategory'), t('budget.subcategoryRequired')],
      amountFieldError(panel.querySelector('#bt-amount'), sourceCurrency, { required: true, original }),
      (!body.from_account_id || !body.to_account_id || body.from_account_id === body.to_account_id)
        && [panel.querySelector('#bt-to'), t('budget.transferChooseAccounts')],
    ])) return;
    // Ohne eigenen Titel heisst die Umbuchung nach ihren Konten (der Platzhalter
    // hat es gezeigt).
    if (!body.title) body.title = transferTitle(accounts.find(a => a.id === body.from_account_id)?.name, accounts.find(a => a.id === body.to_account_id)?.name);
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
  // Laedt die Umbuchung erst, kann der Nutzer inzwischen einen anderen Dialog
  // geoeffnet oder die Seite verlassen haben: dann geht dieser nicht mehr auf
  // und verdraengt nichts (#1997).
  const context = captureOpenContext();
  let transfer = null;
  try { if (entry) transfer = (await api.get(`/budget/transfers/${entry.id}`)).data; }
  catch (err) { onError(err); return; }
  if (!isModalContextCurrent(context)) return;
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
