// Delegated panel composition: dashboard (the owning Health page provides the shell).
// data-composition="dashboard"
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { formatFastingDuration } from '/utils/health-fasting.js';
import { openModal, refocusAfterRender } from '/components/modal.js';
import { moduleAccess } from '/permissions.js';
import { scheduleUndoableDelete } from '/utils/ux.js';
import { fastingEducationMarkup } from '/components/fasting-dial.js';
import { renderFastingStats } from '/pages/health-fasting-insights.js';
import { fastingPreferencesHtml, wireFastingPreferences, startFasting, finishFasting, openFastingCreator, openFastingEditor, startFastingClock, fastingClockSwitchHtml, fastingStamp, fastingError, requireFastingWrite } from '/components/fasting-controls.js';

const panels = new WeakMap();
// Undo timers outlive page roots. Suppression follows the signed-in owner.
const pendingDeletes = new Map();
const currentOwners = new Map();
const deleteKey = (owner, id) => `${owner}:${id}`;

export async function mountFasting(root, { userId } = {}) {
  if (!root) return;
  let view = panels.get(root);
  if (!view) {
    view = { root, self: userId, subject: userId, members: [], from: '', to: '', generation: 0, stop: null, state: null };
    panels.set(root, view);
    root.replaceChildren();
    root.insertAdjacentHTML('beforeend', `<div class="fasting-container"><div data-fasting-shell></div><p role="alert" data-fasting-load-error></p><div class="fasting-panel" data-fasting-body><p role="status">${esc(t('common.loading'))}</p></div></div>`);
  }
  await refresh(view);
}

function query(view, cursor = null) {
  const params = new URLSearchParams();
  if (view.subject && view.subject !== view.self) params.set('user_id', view.subject);
  if (view.from) params.set('from', view.from);
  if (view.to) params.set('to', view.to);
  if (cursor) { params.set('before_at', cursor.before_at); params.set('before_id', cursor.before_id); }
  return params.size ? `?${params}` : '';
}

function shell(view) {
  const el = view.root.querySelector('[data-fasting-shell]');
  el.replaceChildren();
  el.insertAdjacentHTML('beforeend', `<label class="form-label" for="fasting-person">${esc(t('health.fasting.person'))}</label><select id="fasting-person" data-fasting-person class="form-input">${view.members.map((member) => `<option value="${member.id}" ${member.id === view.subject ? 'selected' : ''}>${esc(member.display_name)}</option>`).join('')}</select>`);
  if (!view.state) {
    el.insertAdjacentHTML('beforeend', filtersMarkup(view));
    wireFilters(view, el);
  }
  el.querySelector('select').addEventListener('change', (event) => {
    view.subject = Number(event.target.value);
    view.state = null; view.generation++; view.stop?.(); view.stop = null;
    const body = view.root.querySelector('[data-fasting-body]');
    body.replaceChildren();
    body.insertAdjacentHTML('beforeend', `<p role="status">${esc(t('common.loading'))}</p>`);
    shell(view);
    void refresh(view);
  });
}

function filtersMarkup(view) {
  return `<form class="fasting-history-filters" data-fasting-filters><label class="form-label">${esc(t('health.fasting.completedFrom'))}<input class="form-input" type="date" data-fasting-from value="${esc(view.from)}"></label><label class="form-label">${esc(t('health.fasting.completedTo'))}<input class="form-input" type="date" data-fasting-to value="${esc(view.to)}"></label><button type="submit" class="btn btn--secondary">${esc(t('health.fasting.applyFilter'))}</button><p class="form-hint" role="alert" data-fasting-filter-error></p></form>`;
}

function wireFilters(view, container) {
  container.querySelector('[data-fasting-filters]').addEventListener('submit', (event) => {
    event.preventDefault();
    const from = container.querySelector('[data-fasting-from]').value, to = container.querySelector('[data-fasting-to]').value;
    if (from && to && from > to) { container.querySelector('[data-fasting-filter-error]').textContent = t('health.fasting.rangeError'); return; }
    view.from = from; view.to = to; void refresh(view);
  });
}

async function refresh(view) {
  if (!view.root.isConnected) return;
  const generation = ++view.generation, subject = view.subject;
  const current = () => view.root.isConnected && view.generation === generation && view.subject === subject;
  const q = query(view);
  try {
    const [stateResult, statsResult, membersResult, filtered] = await Promise.all([
      api.get(`/health/fasting/state${q}`), api.get(`/health/fasting/stats${q}`),
      view.members.length ? null : api.get('/family/members'),
      view.from || view.to ? api.get(`/health/fasting/history${q}`) : null,
    ]);
    if (!current()) return;
    const state = stateResult.data;
    view.self ??= state.settings?.user_id;
    view.subject ??= view.self;
    if (membersResult) view.members = membersResult.data || [];
    currentOwners.set(view.self, view);
    view.state = state;
    view.rows = filtered ? filtered.data : state.history || [];
    view.cursor = filtered ? filtered.next_cursor : state.history_next_cursor;
    view.more = filtered ? filtered.has_more : state.history_has_more;
    view.stop?.();
    shell(view);
    view.root.querySelector('[data-fasting-load-error]').replaceChildren();
    renderBody(view, statsResult.data);
  } catch {
    if (!current()) return;
    if (!view.members.length) {
      try { view.members = (await api.get('/family/members')).data || []; } catch { /* retry remains available */ }
      if (!current()) return;
    }
    shell(view);
    const error = view.root.querySelector('[data-fasting-load-error]');
    error.replaceChildren();
    error.insertAdjacentHTML('beforeend', `${esc(t('health.fasting.loadError'))} <button class="btn btn--secondary" data-fasting-retry>${esc(t('common.retry'))}</button>`);
    error.querySelector('button').addEventListener('click', () => void refresh(view));
  }
}

function renderBody(view, stats) {
  const { root, state } = view;
  const writable = view.subject === view.self && state.canWrite && moduleAccess('health') === 'write';
  const active = state.active, last = state.history?.[0];
  const body = root.querySelector('[data-fasting-body]');
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `<section class="metric-card fasting-hero">
    <h3 class="u-section-title" data-fasting-clock-label></h3>${fastingClockSwitchHtml()}
    <div class="fasting-dial fasting-dial--segmented" data-fasting-progress><div data-fasting-segments></div><div class="fasting-dial__content"><div class="fasting-hero__timer" data-fasting-timer>00:00:00</div><span class="fasting-dial__days" data-fasting-days></span></div></div>
    <p class="sr-only" role="status" aria-live="polite" data-fasting-announcement></p>
    ${active ? `<p class="fasting-hero__remaining" data-fasting-remaining></p><p class="fasting-hero__meta">${esc(t('health.fasting.startedAt', { date: fastingStamp(active.start_at, active.start_tzid) }))}</p>${active.goal_minutes ? `<p class="fasting-hero__meta" data-fasting-target>${esc(t('health.fasting.targetAt', { date: fastingStamp(new Date(Date.parse(active.start_at) + active.goal_minutes * 60000).toISOString(), active.start_tzid) }))}</p>` : ''}` : ''}
    ${writable ? `<div class="fasting-hero__actions"><button class="btn btn--primary" type="button" data-fasting-action>${esc(t(active ? 'health.fasting.finish' : 'health.fasting.start'))}</button><button class="btn btn--secondary" type="button" ${active ? 'data-fasting-edit-start' : 'data-fasting-earlier'}>${esc(t(active ? 'health.fasting.editStart' : 'health.fasting.earlier'))}</button></div>` : `<p class="form-hint">${esc(t('health.fasting.readOnly'))}</p>`}
    <p class="form-hint" role="alert" data-fasting-error></p>
    ${state.settings?.zone_mode === 'educational' ? fastingEducationMarkup() : ''}
  </section>
  ${writable ? `<div class="fasting-card" data-fasting-preferences>${fastingPreferencesHtml(state.settings || {})}</div>` : ''}
  ${renderFastingStats(stats)}
  <section id="history"><div class="fasting-card__heading"><h3 class="u-section-title">${esc(t('health.fasting.history'))}</h3><a href="/api/v1/health/export/fasting${esc(query(view))}" class="btn btn--secondary btn--sm" download>${esc(t('health.fasting.export'))}</a>${writable ? `<button class="btn btn--secondary" data-fasting-backfill>${esc(t('health.fasting.backfill'))}</button>` : ''}</div>
    ${filtersMarkup(view)}
    <div class="fasting-card" data-fasting-history></div><div class="fasting-history-more"><button class="btn btn--secondary" type="button" data-fasting-more ${view.more ? '' : 'hidden'}>${esc(t('health.fasting.loadMore'))}</button><p class="form-hint" role="alert" data-fasting-history-error></p></div>
  </section>`);
  const reload = () => refresh(view);
  if (writable) {
    wireFastingPreferences(root.querySelector('[data-fasting-preferences]'), state.settings, async () => { await reload(); return root.querySelector('[data-fasting-preferences]'); }, active);
    root.querySelector('[data-fasting-action]').addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try {
        if (active) await finishFasting(active, reload, () => root.isConnected && view.subject === view.self);
        else if (await startFasting()) { await reload(); refocusAfterRender(); }
      } catch (error) {
        const message = root.isConnected && view.subject === view.self && root.querySelector('[data-fasting-error]');
        if (message) message.textContent = fastingError(error);
      } finally { if (button.isConnected) button.disabled = false; }
    });
    root.querySelector('[data-fasting-edit-start]')?.addEventListener('click', () => openFastingEditor(active, reload));
    const creator = async (completed) => { try { await openFastingCreator(reload, completed); } catch (error) { window.yuvomi?.showToast(fastingError(error), 'danger'); } };
    root.querySelector('[data-fasting-earlier]')?.addEventListener('click', () => void creator(false));
    root.querySelector('[data-fasting-backfill]').addEventListener('click', () => void creator(true));
  }
  root.querySelector('[data-fasting-education]')?.addEventListener('click', () => openModal({ title: t('health.fasting.zoneDetails'), content: `<p>${esc(t('health.fasting.zoneVariability'))}</p><ul>${['zoneMeal', 'zoneStored', 'zoneKetones', 'zoneLater'].map((key) => `<li>${esc(t(`health.fasting.${key}`))}</li>`).join('')}</ul><p>${esc(t('health.fasting.safetyDialog'))}</p>`, size: 'lg' }));
  wireFilters(view, body);
  renderHistory(view, writable);
  root.querySelector('[data-fasting-more]').addEventListener('click', async (event) => {
    const button = event.currentTarget, generation = view.generation;
    if (!view.cursor || button.disabled) return;
    button.disabled = true;
    try {
      const response = await api.get(`/health/fasting/history${query(view, view.cursor)}`);
      if (!root.isConnected || generation !== view.generation) return;
      const seen = new Set(view.rows.map((row) => row.id));
      view.rows.push(...response.data.filter((row) => !seen.has(row.id)));
      view.cursor = response.next_cursor; view.more = response.has_more;
      renderHistory(view, writable); button.hidden = !view.more;
    } catch { if (button.isConnected) root.querySelector('[data-fasting-history-error]').textContent = t('health.fasting.loadError'); }
    finally { button.disabled = false; }
  });
  view.stop = startFastingClock(root, active, last, state.settings || {}, { refresh: reload, writable });
  window.lucide?.createIcons({ el: body });
  if (location.hash === '#history') root.querySelector('#history').scrollIntoView();
}

function renderHistory(view, writable) {
  const list = view.root.querySelector('[data-fasting-history]');
  const rows = view.rows.filter((row) => !pendingDeletes.has(deleteKey(view.self, row.id)));
  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', rows.length ? `<ul class="fasting-history">${rows.map((row) => `<li class="fasting-history__row"><div class="fasting-history__dates"><strong>${esc(fastingStamp(row.start_at, row.start_tzid))}</strong><span>${esc(fastingStamp(row.end_at, row.start_tzid))}</span><span>${esc(row.start_tzid)}</span>${row.note ? `<p>${esc(row.note)}</p>` : ''}</div><div class="fasting-history__summary"><strong>${esc(formatFastingDuration((Date.parse(row.end_at) - Date.parse(row.start_at)) / 60000))}</strong>${row.rating ? `<span aria-label="${esc(t('health.fasting.ratingValue', { value: row.rating }))}">${'★'.repeat(row.rating)}${'☆'.repeat(5 - row.rating)}</span>` : ''}</div>${writable ? `<div class="fasting-history__actions"><button class="btn btn--secondary btn--sm" data-fast-edit="${row.id}">${esc(t('common.edit'))}</button><button class="btn btn--ghost btn--sm" data-fast-delete="${row.id}">${esc(t('common.delete'))}</button></div>` : ''}</li>`).join('')}</ul>` : `<p class="empty-hint">${esc(t('health.fasting.noHistory'))}</p>`);
  list.querySelectorAll('[data-fast-edit]').forEach((button) => button.addEventListener('click', () => openFastingEditor(view.rows.find((row) => row.id === Number(button.dataset.fastEdit)), () => refresh(view))));
  list.querySelectorAll('[data-fast-delete]').forEach((button) => button.addEventListener('click', () => {
    try { requireFastingWrite(); } catch (error) { window.yuvomi?.showToast(fastingError(error), 'danger'); return; }
    const row = view.rows.find((entry) => entry.id === Number(button.dataset.fastDelete));
    const owner = view.self, key = deleteKey(owner, row.id);
    pendingDeletes.set(key, true); renderHistory(view, writable);
    const settled = (error) => {
      pendingDeletes.delete(key);
      if (error) window.yuvomi?.showToast(fastingError(error), 'danger');
      const current = currentOwners.get(owner);
      if (current?.root.isConnected) void refresh(current);
    };
    scheduleUndoableDelete({ message: t('health.fasting.deleted'), restoreOnKeepaliveError: true,
      commit: async ({ keepalive }) => { await api.delete(`/health/fasting/${row.id}?expected_revision=${row.revision}`, { keepalive }); settled(); },
      restore: settled,
    });
  }));
}
