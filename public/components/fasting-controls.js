/** Fasting preferences and record dialog, on Health and Settings. */
import { api } from '/api.js';
import { t, formatDate, formatTime } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, confirmModal, refocusAfterRender, captureModalContext, isModalContextCurrent } from '/components/modal.js';
import { FASTING_PRESETS, normalizeGoalHours, fastingDisplayModel, fastingNotificationAvailability, fastingServerDate, fastingServerClock, formatFastingClock } from '/utils/health-fasting.js';
import { wallTimeValue, wallTimeInstant, wallTimeCandidates } from '/utils/timezone.js';
import { moduleAccess } from '/permissions.js';
import { fastingDialMarkup } from '/components/fasting-dial.js';
import { fastingHelpHtml } from '/components/fasting-help.js';

export function fastingError(error) {
  if (error?.message === 'FASTING_OFFLINE') return t('health.fasting.offline');
  return error?.status === 409 ? t('health.fasting.conflict') : t('health.fasting.saveError');
}

export function fastingStamp(value, zone = 'UTC') {
  if (!value) return '-';
  const wall = wallTimeValue(value, zone);
  if (!editableWallTime(wall)) return `${wall} (${zone})`;
  return `${formatDate(wall)} · ${formatTime(wall)}`;
}

// Native datetime-local cannot represent astronomical year zero or BCE.
const editableWallTime = (wall) => /^\d{4}-/.test(wall) && !wall.startsWith('0000-');

export function requireFastingWrite() {
  if (navigator.onLine === false) throw new Error('FASTING_OFFLINE');
  if (moduleAccess('health') !== 'write') throw new Error('FASTING_READ_ONLY');
}

export function fastingPreferencesHtml(settings = {}) {
  const hours = settings.default_goal_minutes ? settings.default_goal_minutes / 60 : null;
  const custom = hours !== null && !FASTING_PRESETS.includes(hours);
  const available = fastingNotificationAvailability(settings.default_goal_minutes);
  const choice = (value, label, selected) => `<button type="button" class="btn ${selected ? 'btn--primary' : 'btn--secondary'} btn--sm" data-fasting-preset="${value}" aria-pressed="${selected}">${esc(label)}</button>`;
  return `<div class="fasting-preferences">
    <section><h3 class="u-section-title fasting-help-heading">${esc(t('health.fasting.goalTitle'))}${fastingHelpHtml(t('health.fasting.goalTitle'), [t('health.fasting.goalHint'), t('health.fasting.goalNextHint')])}</h3>
      <div class="fasting-presets" role="group" aria-label="${esc(t('health.fasting.goalTitle'))}">
        ${choice('', t('health.fasting.noGoal'), hours === null)}
        ${FASTING_PRESETS.map((h) => choice(String(h), `${h}:${24 - h}`, hours === h)).join('')}
        ${choice('custom', t('health.fasting.custom'), custom)}
      </div>
      <div class="form-group fasting-custom" data-fasting-custom ${custom ? '' : 'hidden'}>
        <label class="form-label" for="fasting-goal-hours">${esc(t('health.fasting.goalHours'))}</label>
        <input class="form-input" id="fasting-goal-hours" type="number" min="1" max="336" step="1" value="${custom ? hours : ''}" data-fasting-goal>
      </div>
    </section>
    <section class="fasting-notifications"><h3 class="u-section-title fasting-help-heading">${esc(t('health.fasting.notifications'))}${fastingHelpHtml(t('health.fasting.notifications'), [t('health.fasting.reminderHint')])}</h3>
      <label class="form-check"><input type="checkbox" data-fasting-remind-goal ${settings.remind_goal ? 'checked' : ''} ${available.goal ? '' : 'disabled'}>${esc(t('health.fasting.remindGoalToggle'))}</label>
      <label class="form-check"><input type="checkbox" data-fasting-remind-next ${settings.remind_next_start ? 'checked' : ''} ${available.next ? '' : 'disabled'}>${esc(t('health.fasting.remindNextToggle'))}</label>
    </section>
    <section class="form-group"><label class="form-label" for="fasting-clock-default">${esc(t('health.fasting.clockDefault'))}</label>
      <select class="form-input" id="fasting-clock-default" data-fasting-clock-default>${['auto', 'elapsed', 'remaining'].map((mode) => `<option value="${mode}" ${(settings.clock_mode || 'auto') === mode ? 'selected' : ''}>${esc(t(`health.fasting.clock${mode[0].toUpperCase() + mode.slice(1)}`))}</option>`).join('')}</select>
    </section><section class="form-group"><label class="form-label" for="fasting-zone-mode">${esc(t('health.fasting.zoneMode'))}</label><select class="form-input" id="fasting-zone-mode" data-fasting-zone-mode>${['timer', 'educational'].map((mode) => `<option value="${mode}" ${settings.zone_mode === mode ? 'selected' : ''}>${esc(t(`health.fasting.zone${mode === 'timer' ? 'Timer' : 'Educational'}`))}</option>`).join('')}</select></section><p class="form-hint" role="status" data-fasting-preferences-status></p>
  </div>`;
}

export function wireFastingPreferences(root, initial, onSaved = () => {}, active = null) {
  let settings = { ...initial };
  let pending = false;
  const status = root.querySelector('[data-fasting-preferences-status]');
  async function save(patch) {
    if (pending) return;
    const focused = document.activeElement;
    const context = captureModalContext();
    const focusSelector = focused?.id ? `#${CSS.escape(focused.id)}` : focused?.hasAttribute('data-fasting-preset') ? `[data-fasting-preset="${CSS.escape(focused.dataset.fastingPreset)}"]` : focused?.hasAttribute('data-fasting-remind-goal') ? '[data-fasting-remind-goal]' : focused?.hasAttribute('data-fasting-remind-next') ? '[data-fasting-remind-next]' : null;
    pending = true;
    root.querySelectorAll('input, button, select').forEach((el) => { el.disabled = true; });
    try {
      requireFastingWrite();
      if (Object.hasOwn(patch, 'default_goal_minutes')) Object.assign(patch, { active_id: active?.id ?? null, expected_revision: active?.revision });
      settings = (await api.put('/health/fasting/settings', patch)).data;
      const restoreFocus = document.activeElement === focused || document.activeElement === document.body;
      const savedRoot = await onSaved(settings) || root;
      if (savedRoot.isConnected) {
        savedRoot.querySelector('[data-fasting-preferences-status]').textContent = t('settings.feedExportSaved');
        const focusUnchanged = document.activeElement === focused || document.activeElement === document.body;
        if (restoreFocus && focusUnchanged && focusSelector && isModalContextCurrent(context)) savedRoot.querySelector(focusSelector)?.focus({ preventScroll: true });
      }
    } catch (error) {
      status.textContent = fastingError(error);
    } finally {
      pending = false;
      root.querySelectorAll('input, button, select').forEach((el) => { el.disabled = false; });
      const available = fastingNotificationAvailability(settings.default_goal_minutes);
      root.querySelector('[data-fasting-remind-goal]').disabled = !available.goal;
      root.querySelector('[data-fasting-remind-next]').disabled = !available.next;
      root.querySelector('[data-fasting-clock-default]').value = settings.clock_mode || 'auto';
      root.querySelector('[data-fasting-remind-goal]').checked = !!settings.remind_goal;
      root.querySelector('[data-fasting-remind-next]').checked = !!settings.remind_next_start;
      const hours = settings.default_goal_minutes ? settings.default_goal_minutes / 60 : null;
      const selected = hours === null ? '' : FASTING_PRESETS.includes(hours) ? String(hours) : 'custom';
      root.querySelectorAll('[data-fasting-preset]').forEach((button) => {
        const active = button.dataset.fastingPreset === selected;
        button.setAttribute('aria-pressed', String(active));
        button.classList.toggle('btn--primary', active);
        button.classList.toggle('btn--secondary', !active);
      });
      root.querySelector('[data-fasting-custom]').hidden = selected !== 'custom';
      root.querySelector('[data-fasting-goal]').value = selected === 'custom' ? hours : '';
    }
  }
  root.querySelectorAll('[data-fasting-preset]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.fastingPreset === 'custom') {
      root.querySelectorAll('[data-fasting-preset]').forEach((choice) => {
        const active = choice === button;
        choice.setAttribute('aria-pressed', String(active));
        choice.classList.toggle('btn--primary', active);
        choice.classList.toggle('btn--secondary', !active);
      });
      root.querySelector('[data-fasting-custom]').hidden = false;
      root.querySelector('[data-fasting-goal]').focus();
      return;
    }
    void save({ default_goal_minutes: normalizeGoalHours(button.dataset.fastingPreset) });
  }));
  root.querySelector('[data-fasting-goal]').addEventListener('change', (event) => {
    if (!event.target.value || !event.target.reportValidity()) return;
    void save({ default_goal_minutes: normalizeGoalHours(event.target.value) });
  });
  root.querySelector('[data-fasting-remind-goal]').addEventListener('change', (event) => void save({ remind_goal: event.target.checked }));
  root.querySelector('[data-fasting-remind-next]').addEventListener('change', (event) => void save({ remind_next_start: event.target.checked }));
  root.querySelector('[data-fasting-clock-default]').addEventListener('change', (event) => void save({ clock_mode: event.target.value }));
  root.querySelector('[data-fasting-zone-mode]').addEventListener('change', (event) => void save({ zone_mode: event.target.value }));
}

/** Reads acknowledgement from the server so all entry points share the same gate. */
export async function startFasting() {
  requireFastingWrite();
  const context = captureModalContext();
  const state = (await api.get('/health/fasting/state')).data;
  if (!isModalContextCurrent(context)) return false;
  if (!state.acknowledged && !await confirmModal(t('health.fasting.safetyTitle'), {
    detail: t('health.fasting.safetyDialog'), confirmLabel: t('common.confirm'),
  })) return false;
  await api.post('/health/fasting', {
    start_tzid: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    goal_minutes: state.settings.default_goal_minutes,
    acknowledge_safety: !state.acknowledged,
  });
  return true;
}

export async function openFastingCreator(refresh, completed = false) {
  requireFastingWrite();
  const context = captureModalContext();
  const state = (await api.get('/health/fasting/state')).data;
  const visibility = (await api.get('/health/visibility-defaults')).data.defaults.fasting;
  if (!isModalContextCurrent(context)) return;
  if (!state.acknowledged && !await confirmModal(t('health.fasting.safetyTitle'), {
    detail: t('health.fasting.safetyDialog'), confirmLabel: t('common.confirm'),
  })) return;
  // Never fall back to the device clock: a phone may be minutes ahead and its
  // local time would submit a future end_at that the server correctly rejects.
  const end = fastingServerDate(state.server_now);
  openFastingEditor({ start_at: new Date(end.getTime() - 3600000).toISOString(),
    end_at: completed ? end.toISOString() : null,
    server_now: state.server_now,
    start_tzid: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    goal_minutes: state.settings?.default_goal_minutes, visibility: visibility || 'private',
    acknowledge_safety: !state.acknowledged,
  }, refresh);
}

/** Stop is persisted first; closing the optional review never resumes the fast. */
export async function finishFasting(row, refresh, isCurrent = () => true) {
  requireFastingWrite();
  const context = captureModalContext();
  const { data } = await api.post(`/health/fasting/${row.id}/finish`, {
    expected_revision: row.revision,
  });
  if (!isCurrent()) return;
  const canOpenReview = isModalContextCurrent(context);
  const path = location.pathname;
  await refresh();
  window.yuvomi?.showToast(t('health.fasting.finishedTitle'), 'default', 5000, {
    label: t('health.fasting.undoEnd'), onClick: async () => {
      try {
        requireFastingWrite();
        await api.patch(`/health/fasting/${data.id}`, { end_at: null, expected_revision: data.revision });
        if (isModalContextCurrent({ ...context, pageRoot: null })) await closeModal({ force: true });
        await refresh(); refocusAfterRender();
      } catch (error) { window.yuvomi?.showToast(fastingError(error), 'danger'); }
    },
  });
  // refresh intentionally replaces the dashboard page root, but must not
  // replace a dialog opened while that refresh was in flight.
  if (canOpenReview && location.pathname === path && isModalContextCurrent({ ...context, pageRoot: null })) openFastingEditor(data, refresh, true);
}

export function openFastingEditor(row, refresh, finished = false) {
  const creating = !row.id;
  const completed = row.end_at !== null;
  const currentTime = row.server_now ? fastingServerClock(row.server_now) : null;
  const inputStamp = (value) => wallTimeValue(value, row.start_tzid);
  const editableDate = (name) => editableWallTime(inputStamp(row[`${name}_at`]));
  const field = (name, label, type, value, attrs = '') => `<div class="form-group"><label class="form-label" for="fast-${name}">${esc(label)}</label><input class="form-input" id="fast-${name}" name="${name}" type="${type}" value="${esc(String(value))}" ${attrs}></div>`;
  const dateField = (name, label) => editableDate(name)
    ? field(name, label, 'datetime-local', inputStamp(row[`${name}_at`]), 'required step="1"')
    : `${field(name, label, 'text', row[`${name}_at`], `readonly aria-describedby="fast-${name}-readonly"`)}<p class="form-hint" id="fast-${name}-readonly" data-fasting-date-readonly>${esc(t('health.fasting.dateReadOnly'))}</p>`;
  openModal({
    title: t(finished ? 'health.fasting.finishedTitle' : creating ? completed ? 'health.fasting.backfill' : 'health.fasting.earlier' : 'health.fasting.editTitle'),
    size: 'lg',
    content: `<form data-fasting-edit-form>
      ${finished ? `<p class="form-hint">${esc(t('health.fasting.finishedHint'))}</p>` : ''}
      <p class="form-hint">${esc(row.start_tzid)}</p>
      <div class="fasting-editor-grid">
        ${dateField('start', t('health.fasting.startDate'))}
        ${completed ? dateField('end', t('health.fasting.endDate')) : ''}
        ${field('goal', t('health.fasting.goalHours'), 'number', row.goal_minutes ? row.goal_minutes / 60 : '', 'min="1" max="336" step="1"')}
        <div class="form-group"><label class="form-label" for="fast-visibility">${esc(t('common.visibility.label'))}</label><select class="form-input" id="fast-visibility" name="visibility"><option value="private" ${row.visibility === 'private' ? 'selected' : ''}>${esc(t('health.vitals.visibility.private'))}</option><option value="family" ${row.visibility === 'family' ? 'selected' : ''}>${esc(t('health.vitals.visibility.family'))}</option></select></div>
      </div>
      <div data-fasting-offsets></div>
      <fieldset class="fasting-rating"><legend class="form-label">${esc(t('health.fasting.rating'))}</legend>
        ${[1, 2, 3, 4, 5].map((n) => `<label class="fasting-rating__choice"><input type="radio" name="rating" value="${n}" ${Number(row.rating) === n ? 'checked' : ''} aria-label="${esc(t('health.fasting.ratingValue', { value: n }))}"><span aria-hidden="true">${Number(row.rating) >= n ? '★' : '☆'}</span></label>`).join('')}
        <button type="button" class="btn btn--ghost btn--sm" data-rating-clear>${esc(t('health.fasting.clearRating'))}</button>
      </fieldset>
      <div class="form-group"><label class="form-label" for="fast-note">${esc(t('health.fasting.note'))}</label><textarea class="form-input" id="fast-note" name="note" maxlength="2000" rows="3">${esc(row.note || '')}</textarea></div>
      <p class="form-hint" data-fasting-edit-error role="alert"></p>
      <div class="modal-panel__footer"><button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button><button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button></div>
    </form>`,
    onSave(panel) {
      const context = captureModalContext();
      const form = panel.querySelector('form');
      const updateOffsets = () => {
        const root = form.querySelector('[data-fasting-offsets]');
        root.replaceChildren();
        for (const name of completed ? ['start', 'end'] : ['start']) {
          if (!editableDate(name)) continue;
          const candidates = wallTimeCandidates(form.elements[name].value, row.start_tzid);
          if (candidates.length < 2) continue;
          const original = row[`${name}_at`];
          const selected = wallTimeInstant(form.elements[name].value, row.start_tzid, original);
          root.insertAdjacentHTML('beforeend', `<div class="form-group"><label class="form-label" for="fast-${name}-offset">${esc(t(name === 'start' ? 'health.fasting.startDate' : 'health.fasting.endDate'))} - ${esc(t('health.fasting.utcOffset'))}</label><select id="fast-${name}-offset" name="${name}_offset" class="form-input">${candidates.map((candidate) => `<option value="${candidate.offsetMinutes}" ${Date.parse(candidate.instant) === Date.parse(selected) - Date.parse(selected) % 1000 ? 'selected' : ''}>UTC${candidate.offsetMinutes >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(candidate.offsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(candidate.offsetMinutes) % 60).padStart(2, '0')}</option>`).join('')}</select></div>`);
        }
      };
      form.querySelectorAll('[type="datetime-local"]').forEach((input) => input.addEventListener('change', updateOffsets));
      updateOffsets();
      const updateStars = () => {
        const value = Number(form.querySelector('[name="rating"]:checked')?.value || 0);
        form.querySelectorAll('.fasting-rating__choice').forEach((label) => {
          label.querySelector('span').textContent = Number(label.querySelector('input').value) <= value ? '★' : '☆';
        });
      };
      form.querySelectorAll('[name="rating"]').forEach((input) => input.addEventListener('change', updateStars));
      form.querySelector('[data-rating-clear]').addEventListener('click', () => {
        form.querySelectorAll('[name="rating"]').forEach((input) => { input.checked = false; }); updateStars();
      });
      let saving = false;
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (saving || !form.reportValidity()) return;
        const fields = new FormData(form);
        const startValue = fields.get('start');
        const endValue = fields.get('end');
        if ((completed ? ['start', 'end'] : ['start']).some((name) => !editableDate(name) && fields.get(name) !== row[`${name}_at`])) {
          form.querySelector('[data-fasting-edit-error]').textContent = t('health.fasting.dateReadOnly'); return;
        }
        // Preserve sub-second instants and the original timezone when unchanged.
        let startAt, endAt;
        try {
          const resolve = (name, value) => {
            const original = row[`${name}_at`];
            if (!editableDate(name)) return original;
            const candidates = wallTimeCandidates(value, row.start_tzid);
            const offset = fields.has(`${name}_offset`) ? Number(fields.get(`${name}_offset`)) : null;
            if (original && (value.length === 16 ? `${value}:00` : value) === inputStamp(original)
              && (offset === null || candidates.some((candidate) => candidate.offsetMinutes === offset && Math.floor(Date.parse(candidate.instant) / 1000) === Math.floor(Date.parse(original) / 1000)))) return original;
            return wallTimeInstant(value, row.start_tzid, original, offset);
          };
          startAt = resolve('start', startValue);
          endAt = completed ? resolve('end', endValue) : null;
        } catch {
          form.querySelector('[data-fasting-edit-error]').textContent = t('health.fasting.wallTimeError'); return;
        }
        const now = currentTime?.();
        if ((now !== undefined && Date.parse(startAt) > now)
          || (endAt && (Date.parse(endAt) <= Date.parse(startAt) || (now !== undefined && Date.parse(endAt) > now)))) {
          form.querySelector('[data-fasting-edit-error]').textContent = t('health.fasting.rangeError'); return;
        }
        saving = true;
        const submit = panel.querySelector('[type="submit"]');
        submit.disabled = true;
        try {
          requireFastingWrite();
          const payload = {
            expected_revision: row.revision, start_at: startAt, end_at: endAt,
            start_tzid: row.start_tzid,
            goal_minutes: normalizeGoalHours(fields.get('goal')), rating: fields.get('rating') ? Number(fields.get('rating')) : null,
            note: fields.get('note'), visibility: fields.get('visibility'),
          };
          if (creating) await api.post('/health/fasting', { ...payload, acknowledge_safety: row.acknowledge_safety });
          else await api.patch(`/health/fasting/${row.id}`, payload);
          if (panel.isConnected && isModalContextCurrent({ ...context, pageRoot: null })) {
            await closeModal({ force: true }); await refresh(); refocusAfterRender();
          }
        } catch (error) { form.querySelector('[data-fasting-edit-error]').textContent = fastingError(error); }
        finally { saving = false; submit.disabled = false; }
      });
    },
  });
}

export function fastingClockSwitchHtml() {
  return `<div class="fasting-clock-switch" role="group" aria-label="${esc(t('health.fasting.clockDefault'))}">${['elapsed', 'remaining'].map((mode) => `<button class="btn btn--ghost btn--sm" type="button" data-fasting-clock-mode="${mode}" aria-pressed="false">${esc(t(`health.fasting.clock${mode[0].toUpperCase() + mode.slice(1)}`))}</button>`).join('')}</div>`;
}

export function updateFastingClock(root, active, last, settings = {}) {
  const model = fastingDisplayModel(active, last, settings.clock_mode);
  const timer = root.querySelector('[data-fasting-timer]');
  if (timer) timer.textContent = model.hasAnchor ? formatFastingClock(model.displaySeconds) : '00:00:00';
  const label = root.querySelector('[data-fasting-clock-label]');
  if (label) label.textContent = t(active ? model.mode === 'remaining' ? 'health.fasting.remaining' : 'health.fasting.elapsed' : last ? 'health.fasting.sinceLast' : 'health.fasting.ready');
  const days = root.querySelector('[data-fasting-days]');
  if (days) days.textContent = t('health.fasting.elapsedDays', { days: model.days });
  const remaining = root.querySelector('[data-fasting-remaining]');
  if (remaining) remaining.textContent = model.reached ? `${t('health.fasting.goalReached')} · +${formatFastingClock(model.overtime)}` : model.remaining !== null ? `${t(model.mode === 'remaining' ? 'health.fasting.elapsed' : 'health.fasting.remaining')}: ${formatFastingClock(model.mode === 'remaining' ? model.seconds : model.remaining)}` : t('health.fasting.noGoal');
  root.querySelectorAll('[data-fasting-clock-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.fastingClockMode === model.mode));
    if (button.dataset.fastingClockMode === 'remaining') button.disabled = model.remaining === null;
  });
  root.querySelector('[data-fasting-progress]')?.style.setProperty('--fasting-progress', `${model.progress}%`);
  const dial = root.querySelector('[data-fasting-segments]');
  const minute = Math.floor(model.seconds / 60);
  if (dial && dial.dataset.minute !== String(minute)) {
    dial.dataset.minute = String(minute);
    dial.replaceChildren();
    dial.insertAdjacentHTML('beforeend', fastingDialMarkup(active ? minute : 0, active?.goal_minutes, settings.zone_mode));
  }
  const announcement = root.querySelector('[data-fasting-announcement]');
  if (announcement && announcement.dataset.minute !== String(minute)) {
    announcement.dataset.minute = String(minute);
    announcement.textContent = `${t(active ? 'health.fasting.elapsed' : 'health.fasting.sinceLast')}: ${formatFastingClock(minute * 60)}`;
  }
}

export function startFastingClock(root, active, last, initial = {}, options = {}) {
  const settings = { ...initial };
  const writable = options.writable !== false && moduleAccess('health') === 'write';
  const controller = new AbortController();
  let saving = false;
  const current = () => !controller.signal.aborted && root.isConnected;
  const tick = () => { if (current() && !saving) updateFastingClock(root, active, last, settings); };
  root.querySelectorAll('[data-fasting-clock-mode]').forEach((button) => button.addEventListener('click', async () => {
    if (!writable) {
      settings.clock_mode = button.dataset.fastingClockMode; tick(); return;
    }
    if (saving) return;
    saving = true;
    root.querySelectorAll('[data-fasting-clock-mode]').forEach((el) => { el.disabled = true; });
    try {
      requireFastingWrite();
      const result = await api.put('/health/fasting/settings', { clock_mode: button.dataset.fastingClockMode });
      if (!current()) return;
      settings.clock_mode = result.data.clock_mode;
      const select = root.querySelector('[data-fasting-clock-default]');
      if (select) select.value = settings.clock_mode;
    } catch (error) { if (current()) window.yuvomi?.showToast(fastingError(error), 'danger'); }
    finally { saving = false; if (current()) { root.querySelectorAll('[data-fasting-clock-mode]').forEach((el) => { el.disabled = false; }); tick(); } }
  }, { signal: controller.signal }));
  tick();
  if (options.refresh) {
    const resume = () => { if (!document.hidden && root.isConnected) void options.refresh(); };
    document.addEventListener('visibilitychange', resume, { signal: controller.signal });
    window.addEventListener('pageshow', resume, { signal: controller.signal });
  }
  const handle = setInterval(() => {
    if (!root.isConnected) { clearInterval(handle); controller.abort(); return; }
    tick();
  }, 1000);
  return () => { clearInterval(handle); controller.abort(); };
}
