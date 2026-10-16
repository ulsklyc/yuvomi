/**
 * Modul: Routines
 * Zweck: Morgendliche und abendliche Checklisten pro Haushaltsmitglied.
 *        Mitglieder haken Schritte ab; Admins verwalten Routinen und Schritte.
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js, /components/modal.js
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { openModal, closeModal, confirmModal, refocusAfterRender, captureModalContext } from '/components/modal.js';
import { rowMenuHtml } from '/utils/row-action.js';
import { installPopoverMenus } from '/utils/popover-menu.js';
import { emptyStateHTML, mountLoadError } from '/utils/empty-state.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { isPermAdmin, isNavModuleReadOnly } from '/permissions.js';
import { wireScrollFade } from '/utils/ux.js';

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = {
  routines: null, // null = loading
  members: null,  // [{id, name}] admin only
};

function readOnly() { return isNavModuleReadOnly('routines'); }

// --------------------------------------------------------
// Data loading
// --------------------------------------------------------

async function loadData() {
  const calls = [api.get('/routines')];
  if (isPermAdmin()) calls.push(api.get('/family/members'));
  try {
    const [routinesRes, membersRes] = await Promise.all(calls);
    state.routines = routinesRes?.data ?? [];
    state.members = membersRes?.data ?? null;
    render();
  } catch (err) {
    const el = document.getElementById('routines-content');
    if (el) mountLoadError(el, { error: err, onRetry: () => { state.routines = null; render(); loadData(); } });
  }
}

// --------------------------------------------------------
// Rendering
// --------------------------------------------------------

function render() {
  const el = document.getElementById('routines-content');
  if (!el) return;

  if (state.routines === null) {
    el.replaceChildren();
    el.insertAdjacentHTML('beforeend', renderSkeletonList());
    return;
  }

  if (state.routines.length === 0 && !isPermAdmin()) {
    el.replaceChildren();
    el.insertAdjacentHTML('beforeend', emptyStateHTML({ icon: 'list-checks', title: t('routines.emptyTitle'), description: t('routines.emptyDescription') }));
    refocusAfterRender(el);
    return;
  }

  const morning = state.routines.filter((r) => r.slot === 'morning');
  const evening = state.routines.filter((r) => r.slot === 'evening');

  el.replaceChildren();
  el.insertAdjacentHTML('beforeend', `
    <div class="routines-page">
      ${isPermAdmin() && !readOnly() ? `
        <div class="routines-toolbar">
          <button class="btn btn--primary btn--sm" id="btn-add-routine" type="button">
            + ${esc(t('routines.addRoutine'))}
          </button>
        </div>` : ''}
      ${renderSlotSection('morning', morning)}
      ${renderSlotSection('evening', evening)}
    </div>
  `);

  wireEvents(el);
  wireScrollFade(el);
  refocusAfterRender(el);
}

function renderSlotSection(slot, routines) {
  const label = t(`routines.slot.${slot}`);
  const admin = isPermAdmin() && !readOnly();

  if (routines.length === 0 && !admin) return '';

  return `
    <section class="routines-section" data-slot="${esc(slot)}">
      <h2 class="routines-section__heading">${esc(label)}</h2>
      ${routines.length === 0 && admin
        ? `<p class="routines-section__empty">${esc(t('routines.noRoutinesInSlot'))}</p>`
        : routines.map(renderRoutine).join('')}
    </section>
  `;
}

function renderRoutine(routine) {
  const admin = isPermAdmin() && !readOnly();
  const steps = routine.steps ?? [];
  const total = steps.length;
  const done = steps.filter((s) => s.checked).length;
  const memberLabel = routine.user_id != null
    ? (state.members?.find((m) => m.id === routine.user_id)?.name ?? `#${routine.user_id}`)
    : t('routines.allMembers');

  return `
    <div class="routine-card" data-id="${routine.id}">
      <div class="routine-card__header">
        <div class="routine-card__title-row">
          <span class="routine-card__name">${esc(routine.name)}</span>
          <span class="routine-card__member">${esc(memberLabel)}</span>
        </div>
        <div class="routine-card__progress">${done}/${total}</div>
        ${admin ? rowMenuHtml({
          id: `routine-menu-${routine.id}`,
          label: t('common.moreActionsNamed', { name: routine.name }),
          items: [
            { action: 'edit-routine', id: routine.id, icon: 'pencil', label: t('common.edit') },
            { action: 'delete-routine', id: routine.id, icon: 'trash-2', label: t('common.delete'), danger: true },
          ],
        }) : ''}
      </div>
      <ul class="routine-steps" role="list">
        ${steps.map((s) => renderStep(s, routine.id, admin)).join('')}
      </ul>
      ${admin ? `
        <button class="btn btn--ghost btn--sm routine-card__add-step" data-routine-id="${routine.id}" type="button">
          + ${esc(t('routines.addStep'))}
        </button>` : ''}
    </div>
  `;
}

function renderStep(step, routineId, admin) {
  return `
    <li class="routine-step${step.checked ? ' routine-step--checked' : ''}" data-step-id="${step.id}" data-routine-id="${routineId}">
      <label class="routine-step__label">
        <input type="checkbox" class="routine-step__checkbox" data-step-id="${step.id}" data-routine-id="${routineId}"
               ${step.checked ? 'checked' : ''}>
        <span class="routine-step__text">${esc(step.label)}</span>
      </label>
      ${admin ? rowMenuHtml({
        id: `step-menu-${step.id}`,
        label: t('common.moreActionsNamed', { name: step.label }),
        items: [
          { action: 'edit-step', icon: 'pencil', label: t('common.edit'), attrs: { 'data-step-id': step.id, 'data-routine-id': routineId } },
          { action: 'delete-step', icon: 'trash-2', label: t('common.delete'), danger: true, attrs: { 'data-step-id': step.id, 'data-routine-id': routineId } },
        ],
      }) : ''}
    </li>
  `;
}

// --------------------------------------------------------
// Event wiring
// --------------------------------------------------------

function wireEvents(el) {
  el.querySelector('#btn-add-routine')?.addEventListener('click', () => openRoutineModal(null));

  el.querySelectorAll('[data-action="edit-routine"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const routine = state.routines.find((r) => r.id === id);
      if (routine) openRoutineModal(routine);
    });
  });

  el.querySelectorAll('[data-action="delete-routine"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const routine = state.routines.find((r) => r.id === id);
      if (!routine) return;
      const ok = await confirmModal(t('routines.deleteRoutineConfirm', { name: routine.name }));
      if (!ok) return;
      try {
        await api.delete(`/routines/${id}`);
        state.routines = state.routines.filter((r) => r.id !== id);
        render();
      } catch {
        window.yuvomi?.showToast?.(t('common.errorGeneric'), 'error');
      }
    });
  });

  el.querySelectorAll('[data-action="edit-step"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const stepId = Number(btn.dataset.stepId);
      const routineId = Number(btn.dataset.routineId);
      const routine = state.routines.find((r) => r.id === routineId);
      const step = routine?.steps?.find((s) => s.id === stepId);
      if (step) openStepModal(routineId, step);
    });
  });

  el.querySelectorAll('[data-action="delete-step"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const stepId = Number(btn.dataset.stepId);
      const routineId = Number(btn.dataset.routineId);
      const ok = await confirmModal(t('routines.deleteStepConfirm'));
      if (!ok) return;
      try {
        await api.delete(`/routines/${routineId}/steps/${stepId}`);
        const routine = state.routines.find((r) => r.id === routineId);
        if (routine) routine.steps = routine.steps.filter((s) => s.id !== stepId);
        render();
      } catch {
        window.yuvomi?.showToast?.(t('common.errorGeneric'), 'error');
      }
    });
  });

  el.querySelectorAll('.routine-card__add-step').forEach((btn) => {
    btn.addEventListener('click', () => openStepModal(Number(btn.dataset.routineId), null));
  });

  installPopoverMenus(el);

  el.querySelectorAll('.routine-step__checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async (e) => {
      const stepId = Number(checkbox.dataset.stepId);
      const routineId = Number(checkbox.dataset.routineId);
      const checked = checkbox.checked;
      try {
        if (checked) {
          await api.post(`/routines/${routineId}/steps/${stepId}/check`, {});
        } else {
          await api.delete(`/routines/${routineId}/steps/${stepId}/check`);
        }
        const routine = state.routines.find((r) => r.id === routineId);
        const step = routine?.steps?.find((s) => s.id === stepId);
        if (step) step.checked = checked;
        const li = checkbox.closest('.routine-step');
        if (li) li.classList.toggle('routine-step--checked', checked);
        const card = checkbox.closest('.routine-card');
        if (card) {
          const steps = state.routines.find((r) => r.id === routineId)?.steps ?? [];
          const done = steps.filter((s) => s.checked).length;
          const prog = card.querySelector('.routine-card__progress');
          if (prog) prog.textContent = `${done}/${steps.length}`;
        }
      } catch {
        checkbox.checked = !checked;
        window.yuvomi?.showToast?.(t('common.errorGeneric'), 'error');
      }
    });
  });
}

// --------------------------------------------------------
// Routine modal (create / edit)
// --------------------------------------------------------

function memberOptions(selectedId) {
  const members = state.members ?? [];
  const opts = [`<option value="">${esc(t('routines.allMembers'))}</option>`];
  for (const m of members) {
    opts.push(`<option value="${m.id}"${selectedId === m.id ? ' selected' : ''}>${esc(m.name)}</option>`);
  }
  return opts.join('');
}

async function openRoutineModal(routine) {
  const isEdit = routine != null;
  const title = isEdit ? t('routines.editRoutine') : t('routines.addRoutine');

  openModal({
    id: 'routine-modal',
    title,
    body: `
      <form id="routine-form" class="form-stack">
        <label class="form-label" for="routine-name">${esc(t('routines.fields.name'))} ${REQUIRED_MARK}</label>
        <input id="routine-name" name="name" type="text" class="form-input" maxlength="100"
               value="${esc(routine?.name ?? '')}" required autocomplete="off">

        <label class="form-label" for="routine-slot">${esc(t('routines.fields.slot'))}</label>
        <select id="routine-slot" name="slot" class="form-input">
          <option value="morning"${(!routine || routine.slot === 'morning') ? ' selected' : ''}>${esc(t('routines.slot.morning'))}</option>
          <option value="evening"${routine?.slot === 'evening' ? ' selected' : ''}>${esc(t('routines.slot.evening'))}</option>
        </select>

        <label class="form-label" for="routine-member">${esc(t('routines.fields.member'))}</label>
        <select id="routine-member" name="user_id" class="form-input">
          ${memberOptions(routine?.user_id ?? null)}
        </select>
      </form>
    `,
    actions: [
      { label: t('common.cancel'), variant: 'ghost', onClick: () => closeModal('routine-modal') },
      { label: isEdit ? t('common.save') : t('common.add'), variant: 'primary', onClick: () => submitRoutineModal(routine?.id) },
    ],
  });

  document.getElementById('routine-name')?.focus();
}

async function submitRoutineModal(routineId) {
  const form = document.getElementById('routine-form');
  if (!form?.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  const body = {
    name: data.name.trim(),
    slot: data.slot,
    user_id: data.user_id ? Number(data.user_id) : null,
  };
  const context = captureModalContext();
  try {
    if (routineId) {
      const res = await api.put(`/routines/${routineId}`, body);
      const idx = state.routines.findIndex((r) => r.id === routineId);
      if (idx >= 0) state.routines[idx] = { ...state.routines[idx], ...res.data };
    } else {
      const res = await api.post('/routines', body);
      state.routines.push(res.data);
    }
    closeModal({ force: true, context });
    render();
  } catch {
    window.yuvomi?.showToast?.(t('common.errorGeneric'), 'error');
  }
}

// --------------------------------------------------------
// Step modal (create / edit)
// --------------------------------------------------------

async function openStepModal(routineId, step) {
  const isEdit = step != null;
  const title = isEdit ? t('routines.editStep') : t('routines.addStep');

  openModal({
    id: 'step-modal',
    title,
    body: `
      <form id="step-form" class="form-stack">
        <label class="form-label" for="step-label">${esc(t('routines.fields.label'))} ${REQUIRED_MARK}</label>
        <input id="step-label" name="label" type="text" class="form-input" maxlength="200"
               value="${esc(step?.label ?? '')}" required autocomplete="off">
      </form>
    `,
    actions: [
      { label: t('common.cancel'), variant: 'ghost', onClick: () => closeModal('step-modal') },
      { label: isEdit ? t('common.save') : t('common.add'), variant: 'primary', onClick: () => submitStepModal(routineId, step?.id) },
    ],
  });

  document.getElementById('step-label')?.focus();
}

async function submitStepModal(routineId, stepId) {
  const form = document.getElementById('step-form');
  if (!form?.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  const body = { label: data.label.trim() };
  const context = captureModalContext();
  try {
    const routine = state.routines.find((r) => r.id === routineId);
    if (!routine) return;
    if (stepId) {
      const res = await api.put(`/routines/${routineId}/steps/${stepId}`, body);
      const idx = routine.steps.findIndex((s) => s.id === stepId);
      if (idx >= 0) routine.steps[idx] = { ...routine.steps[idx], ...res.data };
    } else {
      const res = await api.post(`/routines/${routineId}/steps`, body);
      routine.steps.push(res.data);
    }
    closeModal({ force: true, context });
    render();
  } catch {
    window.yuvomi?.showToast?.(t('common.errorGeneric'), 'error');
  }
}

// --------------------------------------------------------
// Page entry point
// --------------------------------------------------------

export function mount(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="page-layout app-page--reading">
      <header class="page-header">
        <h1 class="page-title">${esc(t('nav.routines'))}</h1>
      </header>
      <main id="routines-content" class="page-content"></main>
    </div>
  `);

  state = { routines: null, members: null };
  render();
  loadData();
}

export function unmount() {
  state = { routines: null, members: null };
}
