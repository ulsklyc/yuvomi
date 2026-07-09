/**
 * Settings-Blatt: Rollen & Rechte (#467)
 * Admin konfiguriert pro Familienrolle (Standard) und pro Mitglied (Override),
 * welche Module sichtbar/lesbar/voll nutzbar sind und welche Dashboard-Widgets
 * verfügbar sind. Die verbindliche Durchsetzung liegt im Server; diese Seite
 * pflegt nur die Konfiguration über /api/v1/permissions.
 *
 * Craft-Rework: fokussierte schmale Spalte, Widgets sitzen unter ihrem Modul,
 * ein Abweichungs-Überblick zeigt die Form einer Rolle auf einen Blick, und die
 * Zugriffsstufe wird über Icon-Segmente mit gleitender Aktiv-Pille gesetzt.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { confirmModal } from '/components/modal.js';
import { createRetryState } from '/settings/components.js';

// ── Statik ───────────────────────────────────────────────────────────────────

const MODULE_ACCENT = {
  calendar: 'var(--module-calendar)',
  tasks: 'var(--module-tasks)',
  notes: 'var(--module-notes)',
  contacts: 'var(--module-contacts)',
  meals: 'var(--module-meals)',
  shopping: 'var(--module-shopping)',
  budget: 'var(--module-budget)',
  documents: 'var(--module-documents)',
  housekeeping: 'var(--module-housekeeping)',
  rewards: 'var(--module-rewards)',
  health: 'var(--module-health)',
};

const WIDGET_LABEL_KEYS = {
  tasks: 'nav.tasks',
  calendar: 'nav.calendar',
  meals: 'nav.meals',
  shopping: 'nav.shopping',
  birthdays: 'nav.birthdays',
  budget: 'nav.budget',
  rewards: 'nav.rewards',
  health: 'nav.health',
  cycle: 'settings.permWidgetCycle',
  housekeeping: 'nav.housekeeping',
  notes: 'nav.notes',
  family: 'settings.permWidgetFamily',
  weather: 'settings.permWidgetWeather',
};

// Icon je Zugriffsstufe (Icon-Segmente statt langer Textlabels). Tooltip/aria
// tragen weiterhin den Klartext, damit Bedienung UND a11y stimmen.
const MODULE_OPT_ICONS = { none: 'eye-off', read: 'eye', write: 'pencil', inherit: 'corner-down-right' };
const WIDGET_OPT_ICONS = { none: 'eye-off', allow: 'eye', inherit: 'corner-down-right' };

const widgetLabel = (id) => t(WIDGET_LABEL_KEYS[id] || id);

const familyRoleLabel = (role) =>
  t(`settings.familyRole${String(role || 'other').replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())}`);

// ── Modul-State ──────────────────────────────────────────────────────────────

const state = {
  catalog: null,       // { modules, widgets, roles, members, defaults }
  mode: 'role',        // 'role' | 'user'
  subjectId: null,     // familyRole (role) | userId (user)
  draft: { modules: {}, widgets: {} },     // aktuell editierte Werte
  inherited: { modules: {}, widgets: {} }, // Rollen-Effektivwerte (nur user-Modus)
  dirty: false,
};

const moduleLabel = (key) => {
  const m = state.catalog?.modules.find((x) => x.key === key);
  return m ? t(m.labelKey) : key;
};

const widgetsForModule = (moduleKey) => state.catalog.widgets.filter((w) => w.module === moduleKey);
const generalWidgets = () => state.catalog.widgets.filter((w) => !w.module);

// Effektiver Modul-Zugriff (Draft ?? geerbt ?? Standard 'write').
function effectiveModuleAccess(moduleKey) {
  const d = state.draft.modules[moduleKey];
  if (d && d !== 'inherit') return d;
  if (state.mode === 'user') return state.inherited.modules[moduleKey] ?? 'write';
  return 'write';
}

// Effektiver Widget-Zustand ('none' | 'allow'); Modulsperre schlägt durch.
function effectiveWidgetAccess(w) {
  if (w.module && effectiveModuleAccess(w.module) === 'none') return 'none';
  const d = state.draft.widgets[w.id];
  if (d && d !== 'inherit') return d;
  if (state.mode === 'user') return state.inherited.widgets[w.id] ?? 'allow';
  return 'allow';
}

// ── Zugriffs-Optionen ────────────────────────────────────────────────────────

function moduleOptions() {
  const base = [
    { value: 'none', label: t('settings.permAccessNone'), icon: MODULE_OPT_ICONS.none },
    { value: 'read', label: t('settings.permAccessRead'), icon: MODULE_OPT_ICONS.read },
    { value: 'write', label: t('settings.permAccessWrite'), icon: MODULE_OPT_ICONS.write },
  ];
  if (state.mode === 'user') return [{ value: 'inherit', label: t('settings.permInherit'), icon: MODULE_OPT_ICONS.inherit }, ...base];
  return base;
}

function widgetOptions() {
  const base = [
    { value: 'none', label: t('settings.permWidgetBlocked'), icon: WIDGET_OPT_ICONS.none },
    { value: 'allow', label: t('settings.permWidgetAllowed'), icon: WIDGET_OPT_ICONS.allow },
  ];
  if (state.mode === 'user') return [{ value: 'inherit', label: t('settings.permInherit'), icon: WIDGET_OPT_ICONS.inherit }, ...base];
  return base;
}

function accessShort(value) {
  switch (value) {
    case 'none': return t('settings.permAccessNone');
    case 'read': return t('settings.permAccessRead');
    case 'allow': return t('settings.permWidgetAllowed');
    default: return t('settings.permAccessWrite');
  }
}

// ── Segment-Control (Icon + Tooltip + gleitende Aktiv-Pille) ───────────────────

function segControl({ group, label, current, options, disabled = false }) {
  const activeIdx = Math.max(0, options.findIndex((o) => o.value === current));
  const opts = options.map((o) => {
    const checked = o.value === current;
    return `
      <button type="button" class="perm-seg__opt${checked ? ' is-active' : ''}"
        role="radio" aria-checked="${checked ? 'true' : 'false'}" title="${esc(o.label)}"
        data-group="${esc(group)}" data-value="${esc(o.value)}"
        aria-label="${esc(label || group)}: ${esc(o.label)}"
        tabindex="${checked ? '0' : '-1'}"${disabled ? ' disabled' : ''}>
        <i data-lucide="${esc(o.icon)}" aria-hidden="true"></i>
      </button>
    `;
  }).join('');
  return `<div class="perm-seg" role="radiogroup" aria-label="${esc(label || group)}"
    style="--seg-count:${options.length};--seg-index:${activeIdx}"${disabled ? ' data-disabled="true"' : ''}>
    <span class="perm-seg__thumb" aria-hidden="true"></span>${opts}</div>`;
}

// Aktivzustand einer Segmentgruppe in-place setzen (bewahrt die Slide-Animation).
function updateSegActive(group, opt) {
  const opts = [...group.querySelectorAll('.perm-seg__opt')];
  const idx = opts.indexOf(opt);
  if (idx >= 0) group.style.setProperty('--seg-index', String(idx));
  opts.forEach((o) => {
    const active = o === opt;
    o.classList.toggle('is-active', active);
    o.setAttribute('aria-checked', active ? 'true' : 'false');
    o.tabIndex = active ? 0 : -1;
  });
}

// ── Zeilen-Markup ──────────────────────────────────────────────────────────────

function moduleRowHtml(mod) {
  const current = state.draft.modules[mod.key] ?? (state.mode === 'user' ? 'inherit' : 'write');
  const inheritedHint = state.mode === 'user'
    ? `<span class="perm-row__hint">${esc(t('settings.permInheritedHint', {
        value: accessShort(state.inherited.modules[mod.key] ?? 'write'),
      }))}</span>`
    : '';
  return `
    <div class="perm-row perm-row--module" data-module="${esc(mod.key)}">
      <div class="perm-row__label">
        <span class="perm-row__dot" style="background:${MODULE_ACCENT[mod.key] || 'var(--color-accent)'}"></span>
        <i data-lucide="${esc(mod.icon)}" aria-hidden="true"></i>
        <span class="perm-row__name">${esc(moduleLabel(mod.key))}</span>
        ${inheritedHint}
      </div>
      ${segControl({ group: `module:${mod.key}`, label: moduleLabel(mod.key), current, options: moduleOptions() })}
    </div>
  `;
}

function widgetRowHtml(w) {
  const current = state.draft.widgets[w.id] ?? (state.mode === 'user' ? 'inherit' : 'allow');
  const moduleLocked = w.module && effectiveModuleAccess(w.module) === 'none';
  const meta = moduleLocked
    ? `<span class="perm-row__hint perm-row__hint--warn">${esc(t('settings.permModuleLockedHint'))}</span>`
    : '';
  return `
    <div class="perm-row perm-row--widget${moduleLocked ? ' is-locked' : ''}" data-widget="${esc(w.id)}">
      <div class="perm-row__label">
        <i data-lucide="layout-dashboard" class="perm-row__wicon" aria-hidden="true"></i>
        <span class="perm-row__name">${esc(widgetLabel(w.id))}</span>
        ${meta}
      </div>
      ${segControl({ group: `widget:${w.id}`, label: widgetLabel(w.id), current, options: widgetOptions(), disabled: moduleLocked })}
    </div>
  `;
}

// Ein Modul mit seinen Widgets (genestet) — die Beziehung wird strukturell sichtbar.
function moduleGroupHtml(mod) {
  const widgets = widgetsForModule(mod.key);
  const widgetsHtml = widgets.length
    ? `<div class="perm-modgroup__widgets">${widgets.map(widgetRowHtml).join('')}</div>`
    : '';
  return `<div class="perm-modgroup" data-module="${esc(mod.key)}">${moduleRowHtml(mod)}${widgetsHtml}</div>`;
}

// ── Abweichungs-Überblick (auf einen Blick) ────────────────────────────────────

function deviationChips() {
  const chips = [];
  for (const m of state.catalog.modules) {
    const acc = effectiveModuleAccess(m.key);
    if (acc !== 'write') {
      chips.push(`<span class="perm-summary__chip"><span class="perm-summary__dot" style="background:${MODULE_ACCENT[m.key] || 'var(--color-accent)'}"></span>${esc(moduleLabel(m.key))} · ${esc(accessShort(acc))}</span>`);
    }
  }
  for (const w of state.catalog.widgets) {
    // Nur eigenständige Widget-Sperren zählen (Modulsperre ist schon oben abgebildet).
    if (w.module && effectiveModuleAccess(w.module) === 'none') continue;
    if (effectiveWidgetAccess(w) === 'none') {
      chips.push(`<span class="perm-summary__chip perm-summary__chip--widget"><i data-lucide="eye-off" aria-hidden="true"></i>${esc(widgetLabel(w.id))}</span>`);
    }
  }
  return chips;
}

function summaryHtml() {
  const chips = deviationChips();
  if (!chips.length) {
    return `<div class="perm-summary perm-summary--full">
      <i data-lucide="check" aria-hidden="true"></i><span>${esc(t('settings.permSummaryFull'))}</span>
    </div>`;
  }
  return `<div class="perm-summary">
    <span class="perm-summary__lead">${esc(t('settings.permDeviationsLead'))}</span>
    <div class="perm-summary__chips">${chips.join('')}</div>
  </div>`;
}

function renderSummary(container) {
  const host = container.querySelector('#perm-summary');
  if (!host) return;
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', summaryHtml());
  window.lucide?.createIcons({ el: host });
}

// ── Matrix ─────────────────────────────────────────────────────────────────────

function subjectTitle() {
  if (state.mode === 'role') return familyRoleLabel(state.subjectId);
  const member = state.catalog.members.find((m) => String(m.id) === String(state.subjectId));
  return member ? member.display_name : '';
}

function renderMatrix(container) {
  const panel = container.querySelector('#perm-matrix');
  if (!panel) return;

  if (state.subjectId == null) {
    panel.replaceChildren();
    panel.insertAdjacentHTML('beforeend', `<p class="form-hint perm-empty">${esc(
      state.mode === 'role' ? t('settings.permSelectRolePrompt') : t('settings.permSelectMemberPrompt'),
    )}</p>`);
    return;
  }

  // Admin-Mitglied: keine Einschränkung möglich.
  if (state.mode === 'user') {
    const member = state.catalog.members.find((m) => String(m.id) === String(state.subjectId));
    if (member?.role === 'admin') {
      panel.replaceChildren();
      panel.insertAdjacentHTML('beforeend', `
        <div class="perm-adminnote">
          <i data-lucide="shield-check" aria-hidden="true"></i>
          <p>${esc(t('settings.permAdminBadgeHint'))}</p>
        </div>
      `);
      window.lucide?.createIcons({ el: panel });
      return;
    }
  }

  const groupsHtml = state.catalog.modules.map(moduleGroupHtml).join('');
  const general = generalWidgets();
  const generalHtml = general.length
    ? `<div class="perm-modgroup perm-modgroup--general">
        <div class="perm-modgroup__general-title">${esc(t('settings.permWidgetsHeading'))}</div>
        <div class="perm-modgroup__widgets">${general.map(widgetRowHtml).join('')}</div>
      </div>`
    : '';

  panel.replaceChildren();
  panel.insertAdjacentHTML('beforeend', `
    <div class="perm-matrix__head">
      <h3 class="perm-matrix__subject">${esc(subjectTitle())}</h3>
      <p class="perm-matrix__hint">${esc(
        state.mode === 'role' ? t('settings.permRoleLegend') : t('settings.permMemberLegend'),
      )}</p>
    </div>
    <div id="perm-summary"></div>
    <div class="perm-list">${groupsHtml}${generalHtml}</div>
    <div class="perm-actions">
      <span class="perm-actions__status" id="perm-dirty" hidden>
        <i data-lucide="circle-dot" aria-hidden="true"></i>${esc(t('settings.permUnsaved'))}
      </span>
      <button type="button" class="btn btn--secondary" id="perm-reset">${esc(t('settings.permResetSubject'))}</button>
      <button type="button" class="btn btn--primary" id="perm-save" disabled>${esc(t('settings.permSave'))}</button>
    </div>
  `);
  window.lucide?.createIcons({ el: panel });
  renderSummary(container);
  updateSaveState(panel);
}

function updateSaveState(panel) {
  const save = panel.querySelector('#perm-save');
  if (save) save.disabled = !state.dirty;
  const dirty = panel.querySelector('#perm-dirty');
  if (dirty) dirty.hidden = !state.dirty;
}

// Widgets eines Moduls neu rendern (nach Modul-Änderung: Sperr-Zustände hängen daran).
function rebuildModuleWidgets(container, moduleKey) {
  const group = container.querySelector(`.perm-modgroup[data-module="${moduleKey}"] .perm-modgroup__widgets`);
  if (!group) return;
  const widgets = widgetsForModule(moduleKey);
  group.replaceChildren();
  group.insertAdjacentHTML('beforeend', widgets.map(widgetRowHtml).join(''));
  window.lucide?.createIcons({ el: group });
}

// Verwerfen-Schutz (#467-Critique P1): warnt vor Datenverlust, bevor ein anderes
// Subjekt/Modus gewählt wird, solange ungespeicherte Änderungen bestehen.
async function confirmDiscardIfDirty() {
  if (!state.dirty) return true;
  return confirmModal(t('settings.permDiscardConfirm'), { confirmLabel: t('settings.permDiscard') });
}

// ── Subjekt-Auswahl ──────────────────────────────────────────────────────────

function renderSubjectSelector(container) {
  const host = container.querySelector('#perm-subjects');
  if (!host) return;
  host.replaceChildren();

  if (state.mode === 'role') {
    const chips = state.catalog.roles.map((role) => `
      <button type="button" class="perm-chip${String(role) === String(state.subjectId) ? ' is-active' : ''}"
        data-role="${esc(role)}">${esc(familyRoleLabel(role))}</button>
    `).join('');
    host.insertAdjacentHTML('beforeend', chips);
  } else {
    const members = state.catalog.members.filter((m) => m.access_scope !== 'split_guest');
    if (!members.length) {
      host.insertAdjacentHTML('beforeend', `<p class="form-hint">${esc(t('settings.permNoMembers'))}</p>`);
      return;
    }
    const chips = members.map((m) => {
      const badge = m.role === 'admin' ? `<span class="perm-chip__badge">${esc(t('settings.systemAdminBadge'))}</span>` : '';
      return `
        <button type="button" class="perm-chip${String(m.id) === String(state.subjectId) ? ' is-active' : ''}"
          data-user="${esc(m.id)}">
          <span class="perm-chip__avatar" style="background:${esc(m.avatar_color) || 'var(--color-accent)'}">${
            m.avatar_data ? `<img src="${esc(m.avatar_data)}" alt="">` : esc(initials(m.display_name))
          }</span>
          <span class="perm-chip__name">${esc(m.display_name)}</span>${badge}
        </button>
      `;
    }).join('');
    host.insertAdjacentHTML('beforeend', chips);
  }
}

function initials(name) {
  if (!name) return '?';
  return name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

// ── Laden ────────────────────────────────────────────────────────────────────

async function selectSubject(container, mode, id) {
  state.mode = mode;
  state.subjectId = id;
  state.dirty = false;
  state.draft = { modules: {}, widgets: {} };
  state.inherited = { modules: {}, widgets: {} };

  if (id != null) {
    try {
      if (mode === 'role') {
        const res = await api.get(`/permissions/role/${encodeURIComponent(id)}`);
        state.draft = { modules: { ...res.data.modules }, widgets: { ...res.data.widgets } };
      } else {
        const member = state.catalog.members.find((m) => String(m.id) === String(id));
        const [ov, roleRes] = await Promise.all([
          api.get(`/permissions/user/${encodeURIComponent(id)}`),
          member && member.role !== 'admin'
            ? api.get(`/permissions/role/${encodeURIComponent(member.family_role)}`)
            : Promise.resolve({ data: { modules: {}, widgets: {} } }),
        ]);
        state.draft = { modules: { ...ov.data.modules }, widgets: { ...ov.data.widgets } };
        state.inherited = { modules: { ...roleRes.data.modules }, widgets: { ...roleRes.data.widgets } };
      }
    } catch (err) {
      window.yuvomi?.showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  }

  renderSubjectSelector(container);
  renderMatrix(container);
}

async function save(container) {
  const payload = { modules: {}, widgets: {} };
  for (const [k, v] of Object.entries(state.draft.modules)) if (v && v !== 'inherit') payload.modules[k] = v;
  for (const [k, v] of Object.entries(state.draft.widgets)) if (v && v !== 'inherit') payload.widgets[k] = v;

  const url = state.mode === 'role'
    ? `/permissions/role/${encodeURIComponent(state.subjectId)}`
    : `/permissions/user/${encodeURIComponent(state.subjectId)}`;

  const saveBtn = container.querySelector('#perm-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await api.put(url, payload);
    state.draft = { modules: { ...res.data.modules }, widgets: { ...res.data.widgets } };
    state.dirty = false;
    renderMatrix(container);
    window.yuvomi?.showToast(t('settings.permSaved', { name: subjectTitle() }), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.message || t('common.errorGeneric'), 'danger');
    if (saveBtn) saveBtn.disabled = false;
  }
}

// ── Interaktion ──────────────────────────────────────────────────────────────

function bindEvents(container) {
  // Modus umschalten
  container.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.mode;
      if (next === state.mode) return;
      if (!(await confirmDiscardIfDirty())) return;
      container.querySelectorAll('[data-mode]').forEach((b) => {
        const active = b.dataset.mode === next;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      selectSubject(container, next, null);
    });
  });

  // Subjekt-Auswahl (Event-Delegation)
  container.querySelector('#perm-subjects')?.addEventListener('click', async (e) => {
    const chip = e.target.closest('.perm-chip');
    if (!chip) return;
    const same = (chip.dataset.role != null && state.mode === 'role' && String(chip.dataset.role) === String(state.subjectId))
      || (chip.dataset.user != null && state.mode === 'user' && String(chip.dataset.user) === String(state.subjectId));
    if (same) return;
    if (!(await confirmDiscardIfDirty())) return;
    if (chip.dataset.role != null) selectSubject(container, 'role', chip.dataset.role);
    else if (chip.dataset.user != null) selectSubject(container, 'user', chip.dataset.user);
  });

  // Matrix: Segment-Auswahl + Aktionen (Delegation)
  const matrix = container.querySelector('#perm-matrix');
  matrix?.addEventListener('click', (e) => {
    const opt = e.target.closest('.perm-seg__opt');
    if (opt && !opt.disabled) return applySegment(container, opt);
    if (e.target.closest('#perm-save')) return save(container);
    if (e.target.closest('#perm-reset')) return resetSubject(container);
  });
  // Pfeiltasten innerhalb einer Segment-Gruppe (Roving)
  matrix?.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const opt = e.target.closest('.perm-seg__opt');
    if (!opt) return;
    const group = opt.closest('.perm-seg');
    const opts = [...group.querySelectorAll('.perm-seg__opt:not([disabled])')];
    const idx = opts.indexOf(opt);
    const nextIdx = e.key === 'ArrowRight' ? Math.min(idx + 1, opts.length - 1) : Math.max(idx - 1, 0);
    if (opts[nextIdx] && opts[nextIdx] !== opt) {
      e.preventDefault();
      applySegment(container, opts[nextIdx]);
      opts[nextIdx].focus();
    }
  });
}

function applySegment(container, opt) {
  const [type, key] = String(opt.dataset.group).split(':');
  const value = opt.dataset.value;
  if (type === 'module') state.draft.modules[key] = value;
  else state.draft.widgets[key] = value;
  state.dirty = true;

  // Segment in-place aktualisieren (Slide bleibt erhalten).
  updateSegActive(opt.closest('.perm-seg'), opt);

  // Modul-Änderung: nur die Widgets DIESES Moduls neu (Sperr-Zustände).
  if (type === 'module') rebuildModuleWidgets(container, key);

  renderSummary(container);
  updateSaveState(container.querySelector('#perm-matrix'));
}

async function resetSubject(container) {
  const ok = await confirmModal(t('settings.permResetConfirm', { name: subjectTitle() }), {
    confirmLabel: t('settings.permResetSubject'),
  });
  if (!ok) return;
  state.draft = { modules: {}, widgets: {} };
  state.dirty = true;
  renderMatrix(container);
}

// ── Render-Einstieg ──────────────────────────────────────────────────────────

function renderShell(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section perm-page">
      <h2 class="settings-section__title">${esc(t('settings.permTitle'))}</h2>
      <p class="settings-section__intro">${esc(t('settings.permIntro'))}</p>

      <div class="perm-modeswitch" role="tablist" aria-label="${esc(t('settings.permTitle'))}">
        <button type="button" class="perm-modeswitch__btn is-active" role="tab" aria-selected="true" data-mode="role">
          <i data-lucide="users-round" aria-hidden="true"></i>${esc(t('settings.permByRole'))}
        </button>
        <button type="button" class="perm-modeswitch__btn" role="tab" aria-selected="false" data-mode="user">
          <i data-lucide="user" aria-hidden="true"></i>${esc(t('settings.permByMember'))}
        </button>
      </div>

      <div class="perm-subjects" id="perm-subjects"></div>
      <div class="perm-matrix" id="perm-matrix"></div>
    </section>
  `);
}

export async function render(container, { user } = {}) {
  renderShell(container);

  let catalog;
  try {
    const res = await api.get('/permissions/catalog');
    catalog = res.data;
  } catch (err) {
    container.querySelector('#perm-matrix')?.replaceChildren(createRetryState({
      message: err.message || t('common.errorGeneric'),
      onRetry: () => render(container, { user }),
    }));
    return;
  }

  state.catalog = catalog;
  state.mode = 'role';
  state.subjectId = null;
  state.draft = { modules: {}, widgets: {} };
  state.inherited = { modules: {}, widgets: {} };
  state.dirty = false;

  renderSubjectSelector(container);
  renderMatrix(container);
  bindEvents(container);
  window.lucide?.createIcons({ el: container });
}
