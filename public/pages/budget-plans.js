/**
 * Modul: Budgetplan-View (geplantes/geschätztes Budget, Discussion #468)
 * Zweck: Plan-Tab — Monats-Sparziel als Fortschrittsring, Ausgabenkategorien als
 *        Soll/Ist-Balken, Set/Edit/Delete via Modal. Monatsgebunden über die
 *        globale Budget-Monatsnavigation (ctx.month).
 */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';
import { vibrate } from '/utils/ux.js';

const view = { month: '', data: null, error: false, ctx: null, root: null };

export async function renderPlans(panel, ctx) {
  view.ctx = ctx;
  view.root = panel;
  view.month = ctx.month;
  renderShell();
  await load();
}

function fmt(v) { return view.ctx.formatAmount(v); }

async function load() {
  const body = view.root.querySelector('#budget-plan-body');
  try {
    const res = await api.get(`/budget/plans?month=${view.month}`);
    view.data = res.data;
    view.error = false;
  } catch (err) {
    console.error('[Budget] plans load error:', err);
    view.data = null;
    view.error = true;
  }
  renderBody(body);
}

function renderShell() {
  view.root.replaceChildren();
  view.root.insertAdjacentHTML('beforeend', `
    <div class="budget-plan">
      <div id="budget-plan-body"></div>
    </div>
  `);
}

// Auslastung → Ton: unter Plan grün, knapp (>85 %) amber, über Plan rot.
function toneForRatio(ratio, over) {
  if (over) return 'over';
  if (ratio > 0.85) return 'near';
  return 'under';
}

function renderBody(body) {
  if (view.error) {
    body.replaceChildren();
    body.insertAdjacentHTML('beforeend', `
      <div class="empty-state">
        <i data-lucide="cloud-off" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${t('budget.statsError')}</div>
        <div class="empty-state__description">${t('budget.statsErrorDescription')}</div>
        <button class="btn btn--primary empty-state__cta" id="budget-plan-retry">
          <i data-lucide="refresh-cw" class="icon-md" aria-hidden="true"></i>
          ${t('budget.statsRetry')}
        </button>
      </div>`);
    if (window.lucide) lucide.createIcons({ el: body });
    body.querySelector('#budget-plan-retry')?.addEventListener('click', () => load());
    return;
  }

  const d = view.data;
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    ${renderSavingsCard(d.savings)}
    <div class="budget-plan__section">
      <div class="budget-plan__section-head">
        <h3 class="budget-plan__section-title">${t('budget.planCategoryBudgets')}</h3>
        <button class="btn btn--secondary btn--sm" id="budget-plan-add">
          <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>${t('budget.planAddBudget')}
        </button>
      </div>
      <div id="budget-plan-rows">${renderRows(d.plans)}</div>
    </div>
  `);
  if (window.lucide) lucide.createIcons({ el: body });
  wire(body);
}

function renderSavingsCard(savings) {
  if (!savings) {
    return `
      <button type="button" class="budget-plan-savings budget-plan-savings--empty" id="budget-plan-savings">
        <div class="budget-plan-savings__prompt">
          <i data-lucide="piggy-bank" aria-hidden="true"></i>
          <div>
            <div class="budget-plan-savings__prompt-title">${t('budget.planSavingsSetTitle')}</div>
            <div class="budget-plan-savings__prompt-desc">${t('budget.planSavingsSetDesc')}</div>
          </div>
        </div>
        <span class="budget-plan-savings__prompt-cta">${t('budget.planSetGoal')} <i data-lucide="chevron-right" aria-hidden="true"></i></span>
      </button>`;
  }

  const ratio = Math.max(0, Math.min(1, savings.ratio));
  const pct = Math.round(savings.ratio * 100);
  // Sparziel: erreichen/übertreffen ist gut (grün), knapp darunter amber, im Minus rot.
  const tone = savings.met ? 'under' : (savings.actual < 0 ? 'over' : 'near');
  const R = 52, C = 2 * Math.PI * R;
  const dash = (ratio * C).toFixed(2);

  const status = savings.met
    ? t('budget.planSavingsMet')
    : savings.actual < 0
      ? t('budget.planSavingsNegative')
      : t('budget.planSavingsShort', { amount: fmt(Math.max(0, savings.remaining)) });

  return `
    <button type="button" class="budget-plan-savings budget-plan-savings--tone-${tone}" id="budget-plan-savings">
      <div class="budget-plan-savings__ring">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="budget-plan-savings__ring-track" cx="60" cy="60" r="${R}" fill="none" stroke-width="10" />
          <circle class="budget-plan-savings__ring-fill" cx="60" cy="60" r="${R}" fill="none" stroke-width="10"
                  stroke-linecap="round" stroke-dasharray="${dash} ${C.toFixed(2)}"
                  transform="rotate(-90 60 60)" />
        </svg>
        <span class="budget-plan-savings__ring-pct">${pct}%</span>
      </div>
      <div class="budget-plan-savings__detail">
        <div class="budget-plan-savings__label">${t('budget.planSavingsGoal')}</div>
        <div class="budget-plan-savings__amounts">
          <strong>${fmt(savings.actual)}</strong>
          <span>/ ${fmt(savings.planned)}</span>
        </div>
        <div class="budget-plan-savings__status budget-plan-savings__status--${tone}">${status}</div>
      </div>
      <i data-lucide="pencil" class="budget-plan-savings__edit" aria-hidden="true"></i>
      <span class="sr-only">${t('budget.planEditAction')}</span>
    </button>`;
}

function renderRows(plans) {
  if (!plans.length) {
    return `
      <div class="empty-state budget-plan__empty">
        <i data-lucide="target" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${t('budget.planEmptyTitle')}</div>
        <div class="empty-state__description">${t('budget.planEmptyDesc')}</div>
      </div>`;
  }
  return plans.map((p) => {
    const tone = toneForRatio(p.ratio, p.over);
    const pct = Math.max(0, Math.min(100, Math.round(p.ratio * 100)));
    const foot = p.over
      ? t('budget.planOverBy', { amount: fmt(Math.abs(p.remaining)) })
      : t('budget.planLeft', { amount: fmt(Math.max(0, p.remaining)) });
    return `
      <button type="button" class="budget-plan-row budget-plan-row--tone-${tone}" data-category="${view.ctx.esc(p.category)}">
        <div class="budget-plan-row__top">
          <span class="budget-plan-row__label">${view.ctx.esc(view.ctx.categoryLabel(p.category))}</span>
          <span class="budget-plan-row__amounts"><strong>${fmt(p.actual)}</strong> / ${fmt(p.planned)}</span>
        </div>
        <div class="budget-plan-row__track">
          <div class="budget-plan-row__fill" style="--plan-scale:${pct / 100}"></div>
        </div>
        <div class="budget-plan-row__foot">${foot}</div>
        <span class="sr-only">${t('budget.planEditAction')}</span>
      </button>`;
  }).join('');
}

function wire(body) {
  body.querySelector('#budget-plan-add')?.addEventListener('click', openAddPlan);
  body.querySelector('#budget-plan-savings')?.addEventListener('click', () =>
    openPlanEditor({ category: '__savings__', savings: true }));
  body.querySelectorAll('.budget-plan-row').forEach((row) =>
    row.addEventListener('click', () => openPlanEditor({ category: row.dataset.category })));
}

// Kategorie-Auswahl für einen neuen Plan (nur Kategorien ohne bestehenden Plan).
function openAddPlan() {
  const planned = new Set((view.data?.plans || []).map((p) => p.category));
  const options = (view.ctx.expenseCategories || []).filter((c) => !planned.has(c.key));
  if (!options.length) {
    window.yuvomi?.showToast(t('budget.planAllCategoriesBudgeted'), 'info');
    return;
  }
  const optHtml = options.map((c) =>
    `<option value="${view.ctx.esc(c.key)}">${view.ctx.esc(view.ctx.categoryLabel(c))}</option>`).join('');
  openModal({
    title: t('budget.planAddBudget'),
    content: `
      <div class="form-group">
        <label class="form-label" for="plan-category">${t('budget.categoryLabel')}</label>
        <select class="form-input" id="plan-category">${optHtml}</select>
      </div>
      ${amountFieldHtml('')}
      <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
        <div></div>
        <div style="display:flex;gap:var(--space-3)">
          <button class="btn btn--secondary" data-action="close-modal">${t('common.cancel')}</button>
          <button class="btn btn--primary" id="plan-save">${t('common.add')}</button>
        </div>
      </div>`,
    onSave: (panel) => {
      panel.querySelector('#plan-amount')?.focus();
      panel.querySelector('#plan-save').addEventListener('click', () =>
        savePlan(panel, panel.querySelector('#plan-category').value));
      bindEnter(panel, () => savePlan(panel, panel.querySelector('#plan-category').value));
    },
  });
}

// Bestehenden Plan bzw. Sparziel bearbeiten (mit Löschen).
function openPlanEditor({ category, savings = false }) {
  const current = savings
    ? view.data?.savings?.planned
    : view.data?.plans?.find((p) => p.category === category)?.planned;
  const title = savings ? t('budget.planSavingsGoal') : view.ctx.categoryLabel(category);
  const hasCurrent = current != null;
  openModal({
    title,
    content: `
      ${savings ? `<p class="form-hint" style="margin-bottom:var(--space-3)">${t('budget.planSavingsHint')}</p>` : ''}
      ${amountFieldHtml(hasCurrent ? current : '')}
      <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
        ${hasCurrent ? `<button class="btn btn--danger btn--icon" id="plan-delete" aria-label="${t('common.delete')}">
          <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
        </button>` : '<div></div>'}
        <div style="display:flex;gap:var(--space-3)">
          <button class="btn btn--secondary" data-action="close-modal">${t('common.cancel')}</button>
          <button class="btn btn--primary" id="plan-save">${t('common.save')}</button>
        </div>
      </div>`,
    onSave: (panel) => {
      const input = panel.querySelector('#plan-amount');
      input?.focus();
      input?.select();
      panel.querySelector('#plan-save').addEventListener('click', () => savePlan(panel, category));
      panel.querySelector('#plan-delete')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;        // Doppel-Klick-Schutz gegen doppeltes DELETE
        btn.disabled = true;
        confirmDelete(category, savings, title).finally(() => { btn.disabled = false; });
      });
      bindEnter(panel, () => savePlan(panel, category));
    },
  });
}

function amountFieldHtml(value) {
  return `
    <div class="form-group">
      <label class="form-label" for="plan-amount">${t('budget.planMonthlyAmount')}</label>
      <input id="plan-amount" class="form-input" type="number" inputmode="decimal" min="0" step="0.01"
             value="${value === '' ? '' : String(value)}" placeholder="${t('budget.amountPlaceholder')}" />
    </div>`;
}

function bindEnter(panel, fn) {
  panel.querySelector('#plan-amount')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); fn(); }
  });
}

async function savePlan(panel, category) {
  const raw = panel.querySelector('#plan-amount').value;
  const amount = parseFloat(raw);
  if (isNaN(amount) || amount <= 0) {
    window.yuvomi?.showToast(t('budget.validAmountRequired'), 'error');
    return;
  }
  const btn = panel.querySelector('#plan-save');
  btn.disabled = true;
  try {
    await api.put(`/budget/plans/${encodeURIComponent(category)}`, { amount });
    vibrate(10);
    closeModal({ force: true });
    await load();
    window.yuvomi?.showToast(t('budget.planSavedToast'), 'success');
  } catch (err) {
    console.error('[Budget] plan save error:', err);
    btn.disabled = false;
    window.yuvomi?.showToast(t('budget.loadError'), 'error');
  }
}

// Löschen erst nach Standard-Bestätigung (destruktiv, kein Undo).
async function confirmDelete(category, savings, title) {
  const message = savings
    ? t('budget.planSavingsDeleteConfirm')
    : t('budget.planDeleteConfirm', { category: title });
  const ok = await confirmModal(message, { confirmLabel: t('common.delete'), danger: true });
  if (ok) await deletePlan(category);
}

async function deletePlan(category) {
  try {
    await api.delete(`/budget/plans/${encodeURIComponent(category)}`);
    vibrate(10);
    closeModal({ force: true });
    await load();
    window.yuvomi?.showToast(t('budget.planRemovedToast'), 'success');
  } catch (err) {
    console.error('[Budget] plan delete error:', err);
    window.yuvomi?.showToast(t('budget.loadError'), 'error');
  }
}
