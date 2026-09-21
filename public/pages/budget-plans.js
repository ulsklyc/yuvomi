/**
 * Modul: Budgetplan-View (geplantes/geschätztes Budget, Discussion #468)
 * Zweck: Plan-Tab — Monats-Sparziel als Fortschrittsring, Ausgabenkategorien als
 *        Soll/Ist-Balken, Set/Edit/Delete via Modal. Monatsgebunden über die
 *        globale Budget-Monatsnavigation (ctx.month).
 */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { openModal, closeModal, reportFieldError, refocusAfterRender } from '/components/modal.js';
import { vibrate } from '/utils/ux.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { emptyStateHTML, mountLoadError } from '/utils/empty-state.js';
import { amountPlaceholder, amountStep, amountIsSavable, smallestUnitLabel } from '/utils/money.js';
import { isNavModuleReadOnly } from '/permissions.js';

const view = { month: '', data: null, error: false, ctx: null, root: null };

/**
 * Darf dieser Nutzer Budgets setzen? (#1265 P7)
 *
 * Derselbe Modulname wie in budget.js - der Plan-Tab ist ein Teil davon, nur in
 * eigener Datei. Jede Zeile dieses Tabs war ein Knopf, der den Bearbeiten-Dialog
 * oeffnete, und jeder Weg darin schreibt (setzen, aendern, loeschen). Bei
 * `budget: read` bleibt der Tab eine Auskunft: Soll, Ist und Auslastung.
 */
function readOnly() {
  return isNavModuleReadOnly('budget');
}

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
  // Gleiche Ladewahrnehmung wie im Budget-Tab statt leerer Fläche.
  if (body) {
    body.replaceChildren();
    body.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 4, lines: 2 }));
  }
  try {
    const res = await api.get(`/budget/plans?month=${view.month}`);
    view.data = res.data;
    view.error = false;
  } catch (err) {
    console.error('[Budget] plans load error:', err);
    view.data = null;
    // Das Fehlerobjekt selbst, nicht nur `true`: `mountLoadError` liest daraus
    // den Statuscode - die einzige Angabe, die dem Selbsthoster hier weiterhilft.
    view.error = err;
  }
  renderBody(body);
}

function renderShell() {
  view.root.replaceChildren();
  view.root.insertAdjacentHTML('beforeend', `
    <div class="budget-plan app-page app-page--reading page-measure--narrow" data-composition="reading">
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
    mountLoadError(body, {
      title: t('budget.statsError'),
      description: t('budget.statsErrorDescription'),
      error: view.error,
      retryLabel: t('budget.statsRetry'),
      onRetry: () => load(),
    });
    return;
  }

  const d = view.data;
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    ${d.isCurrentMonth ? '' : `
      <p class="budget-plan__historic-note">
        <i data-lucide="info" class="icon-md" aria-hidden="true"></i>${t('budget.planHistoricNote')}
      </p>`}
    ${renderSavingsCard(d.savings)}
    <div class="budget-plan__section">
      <div class="budget-plan__section-head">
        <h3 class="budget-plan__section-title">${t('budget.planCategoryBudgets')}</h3>
        ${readOnly() ? '' : `<button class="btn btn--secondary btn--sm" id="budget-plan-add">
          <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>${t('budget.planAddBudget')}
        </button>`}
      </div>
      <div id="budget-plan-rows" class="row-carrier">${renderRows(d.plans)}</div>
    </div>
  `);
  if (window.lucide) lucide.createIcons({ el: body });
  wire(body);
}

function renderSavingsCard(savings) {
  // DIE ANTWORT FOLGT DEM DATENSATZ (#1253): ein gesetztes Sparziel ist Zustand
  // und bleibt - als Karte, nicht als Knopf. Ein nicht gesetztes ist nur die
  // Aufforderung, eines zu setzen, und die faellt bei `budget: read` weg.
  const ro = readOnly();
  if (!savings) {
    if (ro) return '';
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
  const tone = savings.met == null
    ? 'near'
    : savings.met ? 'under' : (savings.actual < 0 ? 'over' : 'near');
  const R = 52, C = 2 * Math.PI * R;
  const dash = (ratio * C).toFixed(2);

  const status = savings.met == null
    ? ''
    : savings.met
      ? t('budget.planSavingsMet')
      : savings.actual < 0
        ? t('budget.planSavingsNegative')
        : t('budget.planSavingsShort', { amount: fmt(Math.max(0, savings.remaining)) });

  const Tag = ro ? 'div' : 'button';
  return `
    <${Tag} ${ro ? '' : 'type="button" '}class="budget-plan-savings budget-plan-savings--tone-${tone}${ro ? ' budget-plan-savings--static' : ''}"${ro ? '' : ' id="budget-plan-savings"'}>
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
        ${status ? `<div class="budget-plan-savings__status budget-plan-savings__status--${tone}">${status}</div>` : ''}
      </div>
      ${ro ? '' : `<i data-lucide="pencil" class="budget-plan-savings__edit" aria-hidden="true"></i>
      <span class="sr-only">${t('budget.planEditAction')}</span>`}
    </${Tag}>`;
}

function renderRows(plans) {
  const ro = readOnly();
  if (!plans.length) {
    // „Lege pro Kategorie ein Budget fest" ist eine Anleitung zu einem Weg,
    // den es bei `budget: read` nicht gibt - der Titel allein ist die Auskunft.
    return emptyStateHTML({
      className: 'budget-plan__empty',
      icon: 'target',
      title: t('budget.planEmptyTitle'),
      description: ro ? '' : t('budget.planEmptyDesc'),
    });
  }
  // Die Zeile wird bei `budget: read` vom Knopf zum Kasten: Soll, Ist und Rest
  // sind die Auskunft, das „Bearbeiten" dahinter ist der Schreibweg.
  const Tag = ro ? 'div' : 'button';
  return plans.map((p) => {
    const tone = toneForRatio(p.ratio, p.over);
    const pct = Math.max(0, Math.min(100, Math.round(p.ratio * 100)));
    // over === null: vergangener Monat, kein Urteil (#1005). Ein „noch X uebrig"
    // waere hier falsch - der Plan von heute galt damals nicht.
    const foot = p.over === null
      ? ''
      : p.over
        ? t('budget.planOverBy', { amount: fmt(Math.abs(p.remaining)) })
        : t('budget.planLeft', { amount: fmt(Math.max(0, p.remaining)) });
    return `
      <${Tag} ${ro ? '' : 'type="button" '}class="budget-plan-row budget-plan-row--tone-${tone}${ro ? ' budget-plan-row--static' : ''}" data-category="${view.ctx.esc(p.category)}">
        <div class="budget-plan-row__top">
          <span class="budget-plan-row__label">${view.ctx.esc(view.ctx.categoryLabel(p.category))}</span>
          <span class="budget-plan-row__amounts"><strong>${fmt(p.actual)}</strong> / ${fmt(p.planned)}</span>
        </div>
        <div class="budget-plan-row__track">
          <div class="budget-plan-row__fill" style="--plan-scale:${pct / 100}"></div>
        </div>
        ${foot ? `<div class="budget-plan-row__foot">${foot}</div>` : ''}
        ${ro ? '' : `<span class="sr-only">${t('budget.planEditAction')}</span>`}
      </${Tag}>`;
  }).join('');
}

function wire(body) {
  // Alle drei Verdrahtungen hier schreiben - ein `return` nimmt nichts Lesendes
  // mit. Das Markup oben traegt bei `read` ohnehin keinen Haken mehr; dies ist
  // der Riegel fuer einen Knoten aus einem aelteren Render.
  if (readOnly()) return;
  body.querySelector('#budget-plan-add')?.addEventListener('click', openAddPlan);
  body.querySelector('#budget-plan-savings')?.addEventListener('click', () =>
    openPlanEditor({ category: '__savings__', savings: true }));
  body.querySelectorAll('.budget-plan-row').forEach((row) =>
    row.addEventListener('click', () => openPlanEditor({ category: row.dataset.category })));
}

// Kategorie-Auswahl für einen neuen Plan (nur Kategorien ohne bestehenden Plan).
function openAddPlan() {
  if (readOnly()) return;
  const planned = new Set((view.data?.plans || []).map((p) => p.category));
  const options = (view.ctx.expenseCategories || []).filter((c) => !planned.has(c.key));
  if (!options.length) {
    // 'info' ist kein gestylter Toast-Typ (es gibt nur success/danger/warning) —
    // der Aufruf landete stumm im Default-Stil. Neutrale Meldung, also 'default'.
    window.yuvomi?.showToast(t('budget.planAllCategoriesBudgeted'), 'default');
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
      <div class="modal-panel__footer modal-panel__footer--plain">
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
  if (readOnly()) return;
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
      <div class="modal-panel__footer modal-panel__footer--plain">
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
      panel.querySelector('#plan-save').addEventListener('click', () => savePlan(panel, category, hasCurrent ? current : null));
      panel.querySelector('#plan-delete')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;        // Doppel-Klick-Schutz gegen doppeltes DELETE
        btn.disabled = true;
        deletePlan(category).finally(() => { btn.disabled = false; });
      });
      bindEnter(panel, () => savePlan(panel, category, hasCurrent ? current : null));
    },
  });
}

function amountFieldHtml(value) {
  return `
    <div class="form-group">
      <label class="form-label" for="plan-amount">${t('budget.planMonthlyAmount')}</label>
      <input id="plan-amount" class="form-input" type="number" inputmode="decimal" min="0"
             step="${amountStep(view.ctx.currency, value)}"
             value="${value === '' ? '' : String(value)}" placeholder="${amountPlaceholder(view.ctx.currency)}" />
    </div>`;
}

function bindEnter(panel, fn) {
  panel.querySelector('#plan-amount')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); fn(); }
  });
}

async function savePlan(panel, category, original = null) {
  if (readOnly()) return;
  const raw = panel.querySelector('#plan-amount').value;
  const amount = parseFloat(raw);
  if (isNaN(amount) || amount <= 0) {
    // Fehler am Feld statt als ortloser Toast (geteiltes Muster, Critique P1).
    reportFieldError(panel.querySelector('#plan-amount'), t('budget.validAmountRequired'));
    return;
  }
  // Der Dialog ist kein <form>: gespeichert wird über einen Button-Handler, die
  // native step-Prüfung läuft also nie. Ohne diese Zeile nähme ein Feld mit
  // step="1" trotzdem 12,5 JPY entgegen. Ein unangetasteter Bestandswert, der
  // schon vorher neben dem Raster lag, bleibt speicherbar.
  if (!amountIsSavable(amount, view.ctx.currency, { original })) {
    reportFieldError(panel.querySelector('#plan-amount'), t('common.amountPrecisionRequired', {
      currency: view.ctx.currency,
      step: smallestUnitLabel(view.ctx.currency),
    }));
    return;
  }
  const btn = panel.querySelector('#plan-save');
  btn.disabled = true;
  try {
    await api.put(`/budget/plans/${encodeURIComponent(category)}`, { amount });
    vibrate(10);
    closeModal({ force: true });
    await load();
    refocusAfterRender();
    window.yuvomi?.showToast(t('budget.planSavedToast'), 'success');
  } catch (err) {
    console.error('[Budget] plan save error:', err);
    btn.disabled = false;
    window.yuvomi?.showToast(t('budget.loadError'), 'danger');
  }
}

// Löschen mit Undo statt Bestätigungsdialog: ein Plan ist eine Zahl, kein Datum
// mit Verlauf — er ist in zwei Klicks wieder gesetzt und reißt nichts mit sich.
// Damit folgt der Plan-Tab demselben Modell wie Einträge, Darlehen und Raten;
// eine Vorab-Bestätigung bleibt nur, wo Löschen kaskadiert (Konten).
async function deletePlan(category) {
  if (readOnly()) return;
  const previous = category === '__savings__'
    ? view.data?.savings?.planned
    : view.data?.plans?.find((p) => p.category === category)?.planned;
  try {
    await api.delete(`/budget/plans/${encodeURIComponent(category)}`);
    vibrate(10);
    closeModal({ force: true });
    await load();
    refocusAfterRender();
    window.yuvomi?.showToast(t('budget.planRemovedToast'), 'default', 5000, async () => {
      if (previous == null) return;
      try {
        await api.put(`/budget/plans/${encodeURIComponent(category)}`, { amount: previous });
        await load();
        refocusAfterRender();
      } catch (err) {
        console.error('[Budget] plan restore error:', err);
        window.yuvomi?.showToast(t('common.unknownError'), 'danger');
      }
    });
  } catch (err) {
    console.error('[Budget] plan delete error:', err);
    window.yuvomi?.showToast(t('budget.loadError'), 'danger');
  }
}

/**
 * Messflaeche fuer die Nur-lesen-Regel (#1265 P7): die drei Renderer sind reine
 * Funktionen ueber `view`, das der Test mit `ctx` fuellt.
 */
export const __test = { readOnly, renderSavingsCard, renderRows, view };
