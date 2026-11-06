/**
 * Settings-Blatt: Rollen & Rechte (#467)
 * Admin konfiguriert pro Familienrolle (Standard) und pro Mitglied (Override),
 * welche Module sichtbar/lesbar/voll nutzbar sind und welche Dashboard-Widgets
 * verfügbar sind. Die verbindliche Durchsetzung liegt im Server; diese Seite
 * pflegt nur die Konfiguration über /api/v1/permissions.
 *
 * Craft-Rework: fokussierte schmale Spalte, Widgets sitzen unter ihrem Modul,
 * ein Abweichungs-Überblick zeigt die Form einer Rolle auf einen Blick.
 *
 * EINE ZEILE JE MODUL, EIN WERT RECHTS (R24, E11; Critique G6-Familie-P2-2).
 * Je Modul stand ein Dreier-Segment (Kein Zugriff / Nur lesen / Voll), darunter
 * je Widget ein Zweier und je Zusatzrecht noch einer - drei Segmentformen,
 * 4166px am Laptop, 4989px am Telefon, und „Speichern" klebte ohne Aenderung
 * blass unten. Jetzt ist jedes Modul eine Optionszeile der Einstellungen: Name
 * links, die Stufe als Auswahl rechts („Voll ⌄"). Widgets und Zusatzrechte
 * stehen in derselben Form in der aufgeklappten Zeile („Widgets und weitere
 * Rechte"). Eine Wahl wirkt sofort (Einstellungsregel „Auswahl wirkt sofort")
 * und meldet sich mit Rueckgaengig - der Speichern-Knopf, der Entwurf und die
 * Verwerfen-Rueckfrage entfallen.
 */

import { api, auth } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { initials } from '/utils/initials.js';
import { prefersInkText } from '/utils/contrast.js';
import { confirmModal, refocusAfterRender } from '/components/modal.js';
import { attachSegmentIndicator } from '/utils/segment-indicator.js';
import { wireScrollFade } from '/utils/ux.js';
import { createRetryState, hintFoldHtml, settingRowHtml } from '/settings/components.js';
import { resolveExtensionLabel } from '/utils/extension-i18n.js';
import {
  effectiveCapabilityAccess as resolveCapabilityAccess,
  isPermissionDeviation,
  parsePermissionGroup,
} from '/utils/permission-group.js';

// ── Statik ───────────────────────────────────────────────────────────────────

const MODULE_ACCENT = {
  calendar: 'var(--module-calendar)',
  schedule: 'var(--module-schedule)',
  tasks: 'var(--module-tasks)',
  notes: 'var(--module-notes)',
  contacts: 'var(--module-contacts)',
  meals: 'var(--module-meals)',
  shopping: 'var(--module-shopping)',
  pantry: 'var(--module-pantry)',
  budget: 'var(--module-budget)',
  inventory: 'var(--module-inventory)',
  documents: 'var(--module-documents)',
  housekeeping: 'var(--module-housekeeping)',
  waste: 'var(--module-waste)',
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
  fasting: 'health.fasting.title',
  // Wie das Fasten aus dem Wort des Tabs selbst: die Kachel heisst im
  // Anpassen-Panel schon "Naehrwerte", ein eigener settings.*-Schluessel
  // waere ein zweiter Name fuer dieselbe Sache.
  nutrition: 'health.nutrition.title',
  cycle: 'settings.permWidgetCycle',
  housekeeping: 'nav.housekeeping',
  schedule: 'nav.schedule',
  waste: 'nav.waste',
  // Der Name der Kachel selbst, wie beim Countdown: „Vorrat" hiesse hier das
  // Modul, gesperrt wird aber nur die eine Kachel darueber.
  pantry: 'dashboard.pantryExpiringTitle',
  notes: 'nav.notes',
  family: 'settings.permWidgetFamily',
  weather: 'settings.permWidgetWeather',
  clock: 'dashboard.clock',
  // Wie die Uhr aus dem Wort des Widgets selbst, nicht aus einem eigenen
  // settings.*-Schluessel: die Kennzahlreihe heisst im Anpassen-Panel schon
  // „Kennzahlen", und zwei Woerter fuer dieselbe Kachel waeren zwei Namen.
  metrics: 'dashboard.metrics',
  countdown: 'dashboard.countdownTitle',
  quicklinks: 'dashboard.quickLinksTitle',
};

// Icon je Zugriffsstufe (Icon-Segmente statt langer Textlabels). Tooltip/aria
// tragen weiterhin den Klartext, damit Bedienung UND a11y stimmen.

const widgetLabel = (id) => {
  const w = state.catalog?.widgets.find((x) => x.id === id);
  if (w?.labelKey && id.includes(':')) {
    const moduleId = id.split(':')[0];
    return resolveExtensionLabel(moduleId, { labelKey: w.labelKey, label: w.label, fallback: id });
  }
  if (w?.label) return w.label;
  return t(WIDGET_LABEL_KEYS[id] || id);
};

const familyRoleLabel = (role) =>
  t(`settings.familyRole${String(role || 'other').replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())}`);

// ── Modul-State ──────────────────────────────────────────────────────────────

const state = {
  catalog: null,       // { modules, widgets, roles, members, defaults }
  mode: 'role',        // 'role' | 'user'
  subjectId: null,     // familyRole (role) | userId (user)
  draft: { modules: {}, widgets: {}, capabilities: {} },
  inherited: { modules: {}, widgets: {}, capabilities: {} },
  loadedFor: null,     // subjectKey(), dessen Rechte in draft/inherited stehen
  expanded: new Set(), // aufgeklappte Modulzeilen (Widgets + Zusatzrechte)
  loadFailed: false,   // das Laden der Rechte fuer das aktuelle Subjekt scheiterte
};

/* EINE VERALTETE ANTWORT SCHRIEB IN DAS NEUE SUBJEKT (Codex an #1485, P1).
 * Mitglieder -> Rollen startet das Laden der ersten Rolle, die Mitglieds-Chips
 * standen bis zur Antwort noch klickbar da. Kam die Rollen-Antwort NACH der
 * eines inzwischen gewaehlten Mitglieds, landete sie in dessen Entwurf, und der
 * naechste Tipp auf Speichern schrieb sie ueber seine Overrides. Jede Ladung
 * traegt deshalb eine Generation, nur die juengste darf schreiben; und
 * Speichern/Bearbeiten gelten nur fuer einen Entwurf, der zum aktuellen
 * Subjekt geladen ist. */
let loadGeneration = 0;
const subjectKey = () => `${state.mode}:${state.subjectId}`;
const draftIsCurrent = () => state.loadedFor === subjectKey();

const moduleLabel = (key) => {
  const m = state.catalog?.modules.find((x) => x.key === key);
  if (!m) return key;
  if (m.labelKey) return t(m.labelKey);
  if (m.label) return m.label;
  return key;
};

const widgetsForModule = (moduleKey) => state.catalog.widgets.filter((w) => w.module === moduleKey);
const generalWidgets = () => state.catalog.widgets.filter((w) => !w.module);
const capabilitiesForModule = (moduleKey) => (state.catalog.capabilities || []).filter((item) => item.module === moduleKey);
const capabilityLabel = (item) => t(item.labelKey);

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

function effectiveCapabilityAccess(item, view = {}) {
  const mode = view.mode ?? state.mode;
  const draft = view.draft ?? state.draft.capabilities;
  const inherited = view.inherited ?? state.inherited.capabilities;
  return resolveCapabilityAccess(item, {
    mode,
    draft: draft[item.key],
    inherited: inherited[item.key],
  });
}

// ── Zugriffs-Optionen ────────────────────────────────────────────────────────

function moduleOptions(mode = state.mode) {
  const base = [
    { value: 'none', label: t('settings.permAccessNone') },
    { value: 'read', label: t('settings.permAccessRead') },
    { value: 'write', label: t('settings.permAccessWrite') },
  ];
  if (mode === 'user') return [{ value: 'inherit', label: t('settings.permInherit') }, ...base];
  return base;
}

function widgetOptions(mode = state.mode) {
  const base = [
    { value: 'none', label: t('settings.permWidgetBlocked') },
    { value: 'allow', label: t('settings.permWidgetAllowed') },
  ];
  if (mode === 'user') return [{ value: 'inherit', label: t('settings.permInherit') }, ...base];
  return base;
}

function capabilityOptions(mode = state.mode) {
  const base = [
    { value: 'none', label: t('settings.permCapabilityBlocked') },
    { value: 'allow', label: t('settings.permCapabilityAllowed') },
  ];
  if (mode === 'user') return [{ value: 'inherit', label: t('settings.permInherit') }, ...base];
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

// ── Die Auswahl als Wert der Zeile ───────────────────────────────────────────
//
// Die Stufen waren Icon-Segmente mit gleitender Pille (bis R24). Jetzt ist jede
// Zeile eine Optionszeile der Einstellungen (settingRowHtml) mit der Stufe als
// randloser Auswahl rechts - dieselbe Form wie „Gueltigkeit 90 Tage ⌄" im
// API-Zugriff. Das Wort steht in jeder Breite (der Wert IST das Wort), die
// Optionen nennt das native Menue; Tastatur und Screenreader bringt `<select>`
// mit.
const domId = (group) => `perm-${String(group).replace(/[^a-z0-9_-]/gi, '-')}`;

function accessSelectHtml({ group, label, current, options, disabled = false }) {
  return `<select class="form-input perm-select" id="${esc(domId(group))}" data-group="${esc(group)}"
    aria-label="${esc(label)}"${disabled ? ' disabled' : ''}>${options.map((o) => `
      <option value="${esc(o.value)}"${o.value === current ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>`;
}

// ── Zeilen-Markup ──────────────────────────────────────────────────────────────

function moduleRowHtml(mod, expand = '') {
  const current = state.draft.modules[mod.key] ?? (state.mode === 'user' ? 'inherit' : 'write');
  const group = `module:${mod.key}`;
  return settingRowHtml({
    label: moduleLabel(mod.key),
    labelFor: domId(group),
    description: state.mode === 'user'
      ? t('settings.permInheritedHint', { value: accessShort(state.inherited.modules[mod.key] ?? 'write') })
      : '',
    extra: expand,
    control: accessSelectHtml({ group, label: moduleLabel(mod.key), current, options: moduleOptions() }),
    className: 'perm-row perm-row--module',
    attrs: { 'data-module': mod.key },
  });
}

function widgetRowHtml(w) {
  const current = state.draft.widgets[w.id] ?? (state.mode === 'user' ? 'inherit' : 'allow');
  const moduleLocked = Boolean(w.module) && effectiveModuleAccess(w.module) === 'none';
  const group = `widget:${w.id}`;
  return settingRowHtml({
    label: widgetLabel(w.id),
    labelFor: domId(group),
    description: moduleLocked ? t('settings.permModuleLockedHint') : '',
    control: accessSelectHtml({ group, label: widgetLabel(w.id), current, options: widgetOptions(), disabled: moduleLocked }),
    className: `perm-row perm-row--widget${moduleLocked ? ' is-locked' : ''}`,
    attrs: { 'data-widget': w.id },
  });
}

export function capabilityRowHtml(item, view = {}) {
  const mode = view.mode ?? state.mode;
  const draft = view.draft ?? state.draft.capabilities;
  const inherited = view.inherited ?? state.inherited.capabilities;
  const label = view.label ?? capabilityLabel(item);
  const current = draft[item.key]
    ?? (mode === 'user' ? 'inherit' : resolveCapabilityAccess(item, {
      mode, inherited: inherited[item.key],
    }));
  const group = `capability:${item.key}`;
  return settingRowHtml({
    label,
    labelFor: domId(group),
    control: accessSelectHtml({ group, label, current, options: capabilityOptions(mode) }),
    className: 'perm-row perm-row--capability',
    attrs: { 'data-capability': item.key },
  });
}

/** Was in der aufgeklappten Zeile eines Moduls steht: Widgets, dann Zusatzrechte. */
function moduleMoreHtml(moduleKey) {
  const widgets = widgetsForModule(moduleKey);
  const capabilities = capabilitiesForModule(moduleKey);
  return `${widgets.length ? `<div class="settings-group perm-modgroup__widgets">${widgets.map(widgetRowHtml).join('')}</div>` : ''}${
    capabilities.length ? `<div class="settings-group perm-modgroup__capabilities">
      <p class="perm-modgroup__capabilities-title">${esc(t('settings.permCapabilitiesHeading'))}</p>
      ${capabilities.map((item) => capabilityRowHtml(item)).join('')}
    </div>` : ''}`;
}

// Ein Modul mit seinen Widgets und Zusatzrechten - eingeklappt nur die Zeile.
function moduleGroupHtml(mod) {
  const count = widgetsForModule(mod.key).length + capabilitiesForModule(mod.key).length;
  const moreId = `perm-more-${String(mod.key).replace(/[^a-z0-9_-]/gi, '-')}`;
  const open = state.expanded.has(mod.key);
  const expand = count
    ? `<button type="button" class="perm-row__more" data-perm-expand="${esc(mod.key)}"
        aria-expanded="${open ? 'true' : 'false'}" aria-controls="${esc(moreId)}">${esc(t('settings.permDetails'))}<i data-lucide="chevron-down" aria-hidden="true"></i></button>`
    : '';
  return `<div class="settings-group perm-modgroup" data-module="${esc(mod.key)}">${moduleRowHtml(mod, expand)}${
    count ? `<div class="perm-modgroup__more" id="${esc(moreId)}"${open ? '' : ' hidden'}>${moduleMoreHtml(mod.key)}</div>` : ''}</div>`;
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
  for (const item of state.catalog.capabilities || []) {
    const chip = capabilityDeviationHtml(item);
    if (chip) chips.push(chip);
  }
  return chips;
}

export function capabilityDeviationHtml(item, view = {}) {
  const access = effectiveCapabilityAccess(item, view);
  if (!isPermissionDeviation(item, access)) return '';
  const label = view.label ?? capabilityLabel(item);
  const icon = access === 'allow' ? 'tags' : 'eye-off';
  return `<span class="perm-summary__chip perm-summary__chip--widget"><i data-lucide="${icon}" aria-hidden="true"></i>${esc(label)} · ${esc(accessShort(access))}</span>`;
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

/**
 * Was ein NEUES Kinderkonto zusaetzlich zum Rollenprofil bekommt (R23, D5) -
 * als eine Zeile aus dem Katalog (`childStart`), nicht als zweite Liste. Ohne
 * sie zeigte das Profil "Kind" "Voller Zugriff", waehrend jedes neu angelegte
 * Kind mit gesperrtem Budget startete. Leer, wenn der Katalog nichts nennt.
 */
export function childStartSummary(catalog = state.catalog) {
  const start = catalog?.childStart;
  if (!start) return '';
  // Nach Stufe gebuendelt ("Nur lesen: Haushaltshilfe, Entsorgung"), nicht je
  // Eintrag mit eigener Stufe: zehn mal "Nicht erlaubt" las sich mobil als
  // Wand.
  const groups = new Map();
  const add = (level, name) => { if (!groups.has(level)) groups.set(level, []); groups.get(level).push(name); };
  for (const [key, access] of Object.entries(start.modules || {})) {
    if (!(catalog.modules || []).some((m) => m.key === key)) continue;
    add(accessShort(access), moduleLabel(key));
  }
  for (const [key, access] of Object.entries(start.capabilities || {})) {
    const item = (catalog.capabilities || []).find((entry) => entry.key === key);
    if (!item) continue;
    add(t(access === 'allow' ? 'settings.permCapabilityAllowed' : 'settings.permCapabilityBlocked'), capabilityLabel(item));
  }
  const list = [...groups].map(([level, names]) => `${level}: ${names.join(', ')}`).join('; ');
  return list ? t('settings.permChildRoleHint', { list }) : '';
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

  /* EIN GESCHEITERTES LADEN SAH AUS WIE EINE BEARBEITBARE VOREINSTELLUNG
   * (Codex an #1485): der Entwurf blieb leer, die Matrix zeigte fuer jedes
   * Modul „Bearbeiten", Klicks wurden still verworfen und Zuruecksetzen tat
   * nichts. Ohne geladene Rechte steht keine Matrix da, sondern die Meldung
   * mit „Erneut versuchen" - derselbe Baustein wie beim Katalog. */
  if (state.loadFailed) {
    const { mode, subjectId } = state;
    panel.replaceChildren(createRetryState({
      message: t('settings.permLoadError'),
      onRetry: () => selectSubject(container, mode, subjectId),
    }));
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
    ? `<div class="settings-group perm-modgroup perm-modgroup--general">
        <p class="perm-modgroup__general-title">${esc(t('settings.permWidgetsHeading'))}</p>
        <div class="settings-group perm-modgroup__widgets">${general.map(widgetRowHtml).join('')}</div>
      </div>`
    : '';

  panel.replaceChildren();
  // Die Matrix-Ueberschrift ist die erste unter dem h1 des Blatts, also h2 -
  // als h3 stand sie seit dem Blatt je Modul (R10) ohne sichtbares h2 davor.
  panel.insertAdjacentHTML('beforeend', `
    <div class="perm-matrix__head">
      <h2 class="perm-matrix__subject">${esc(subjectTitle())}</h2>
      <p class="perm-matrix__hint">${esc(
        state.mode === 'role' ? t('settings.permRoleLegend') : t('settings.permMemberLegend'),
      )}</p>
      ${state.mode === 'role' && state.subjectId === 'child' && childStartSummary()
        ? `<p class="perm-matrix__hint perm-matrix__hint--child" id="perm-child-start">${esc(childStartSummary())}</p>`
        : ''}
    </div>
    <div id="perm-summary"></div>
    <div class="row-carrier settings-group perm-list">${groupsHtml}${generalHtml}</div>
    ${/* Kein Speichern mehr (R24, E11): jede Wahl wirkt sofort. Zuruecksetzen
         bleibt - als Handlung mit Rueckfrage, nicht als Entwurf. */ ''}
    <div class="perm-actions">
      <button type="button" class="btn btn--secondary" id="perm-reset">${esc(t('settings.permResetSubject'))}</button>
    </div>
  `);
  window.lucide?.createIcons({ el: panel });
  renderSummary(container);
}

// Die aufgeklappte Zeile eines Moduls neu zeichnen (nach Modul-Aenderung: die
// Sperr-Zustaende der Widgets haengen daran).
function rebuildModuleWidgets(container, moduleKey) {
  const moduleGroup = container.querySelector(`.perm-modgroup[data-module="${moduleKey}"]`);
  const more = moduleGroup?.querySelector('.perm-modgroup__more');
  if (!more) return;
  more.replaceChildren();
  more.insertAdjacentHTML('beforeend', moduleMoreHtml(moduleKey));
  window.lucide?.createIcons({ el: more });
}

// ── Subjekt-Auswahl ──────────────────────────────────────────────────────────

function renderSubjectSelector(container) {
  const host = container.querySelector('#perm-subjects');
  if (!host) return;
  host.replaceChildren();

  if (state.mode === 'role') {
    // DER GEWAEHLTE CHIP SAGT ES AUCH OHNE FARBE (Re-Critique 2026-09-27,
    // A7 P2-13): `is-active` war nur ein Farbwechsel, ein Screenreader hoerte
    // fuenf gleiche Knoepfe und keinen Hinweis, wessen Rechte darunter stehen.
    const chips = state.catalog.roles.map((role) => {
      const active = String(role) === String(state.subjectId);
      return `
      <button type="button" class="perm-chip${active ? ' is-active' : ''}" aria-pressed="${active ? 'true' : 'false'}"
        data-role="${esc(role)}">${esc(familyRoleLabel(role))}</button>
    `;
    }).join('');
    host.insertAdjacentHTML('beforeend', chips);
  } else {
    const members = state.catalog.members.filter((m) => !['split_guest', 'display'].includes(m.access_scope));
    if (!members.length) {
      host.insertAdjacentHTML('beforeend', `<p class="form-hint">${esc(t('settings.permNoMembers'))}</p>`);
      return;
    }
    const chips = members.map((m) => memberChipHtml(m, String(m.id) === String(state.subjectId))).join('');
    host.insertAdjacentHTML('beforeend', chips);
  }
}

/** Der Chip eines Mitglieds in der Subjekt-Auswahl. Exportiert fuer test:initials. */
export function memberChipHtml(m, active = false) {
  const badge = m.role === 'admin' ? `<span class="perm-chip__badge">${esc(t('settings.systemAdminBadge'))}</span>` : '';
  return `
        <button type="button" class="perm-chip${active ? ' is-active' : ''}" aria-pressed="${active ? 'true' : 'false'}"
          data-user="${esc(m.id)}">
          <span class="perm-chip__avatar${prefersInkText(m.avatar_color) ? ' perm-chip__avatar--ink' : ''}"
            style="background:${esc(m.avatar_color) || 'var(--color-accent)'}">${
            m.avatar_data ? `<img src="${esc(m.avatar_data)}" alt="">` : esc(initials(m.display_name, '?'))
          }</span>
          <span class="perm-chip__name">${esc(m.display_name)}</span>${badge}
        </button>
      `;
}

// ── Laden ────────────────────────────────────────────────────────────────────

/* OHNE VORWAHL STAND UNTER DEN ROLLEN EINE LEERE FLAECHE (Re-Critique
 * 2026-09-27, A7 P2-13). Die Rollen sind eine feste, kurze Liste, und jede ist
 * eine sinnvolle erste Antwort - also steht die erste gewaehlt da, wie ein
 * Segment immer einen Wert hat. Die Mitglieder bleiben ohne Vorwahl: dort ist
 * das erste in der Liste oft die Admin-Person selbst, deren Rechte gar nicht
 * einschraenkbar sind. */
export function initialSubject(mode, catalog) {
  if (mode !== 'role') return null;
  const [first] = catalog?.roles ?? [];
  return first ?? null;
}

async function selectSubject(container, mode, id) {
  const generation = ++loadGeneration;
  state.mode = mode;
  state.subjectId = id;
  state.loadedFor = null;
  state.loadFailed = false;
  state.draft = { modules: {}, widgets: {}, capabilities: {} };
  state.inherited = { modules: {}, widgets: {}, capabilities: {} };
  // Bis die Rechte da sind, ist die stehende Matrix nicht bedienbar: sie zeigt
  // noch das vorige Subjekt, und ein Klick liefe ins Leere.
  lockMatrix(container);

  if (id != null) {
    try {
      if (mode === 'role') {
        const res = await api.get(`/permissions/role/${encodeURIComponent(id)}`);
        if (generation !== loadGeneration) return;
        state.draft = { modules: { ...res.data.modules }, widgets: { ...res.data.widgets }, capabilities: { ...res.data.capabilities } };
      } else {
        const member = state.catalog.members.find((m) => String(m.id) === String(id));
        const [ov, roleRes] = await Promise.all([
          api.get(`/permissions/user/${encodeURIComponent(id)}`),
          member && member.role !== 'admin'
            ? api.get(`/permissions/role/${encodeURIComponent(member.family_role)}`)
            : Promise.resolve({ data: { modules: {}, widgets: {}, capabilities: {} } }),
        ]);
        if (generation !== loadGeneration) return;
        state.draft = { modules: { ...ov.data.modules }, widgets: { ...ov.data.widgets }, capabilities: { ...ov.data.capabilities } };
        state.inherited = { modules: { ...roleRes.data.modules }, widgets: { ...roleRes.data.widgets }, capabilities: { ...roleRes.data.capabilities } };
      }
      markLoaded();
    } catch (err) {
      if (generation !== loadGeneration) return;
      console.error('[Permissions] subject load failed:', err);
      state.loadFailed = true;
    }
  } else {
    markLoaded();
  }

  renderSubjectSelector(container);
  renderMatrix(container);
}

function lockMatrix(container) {
  const panel = container.querySelector('#perm-matrix');
  panel?.querySelectorAll('.perm-select, #perm-reset').forEach((el) => { el.disabled = true; });
}

/** Was ein PUT fuer diesen Entwurf schickt: nur eigene Eintraege, kein `inherit`. */
function payloadOf(draft) {
  const payload = { modules: {}, widgets: {}, capabilities: {} };
  for (const [k, v] of Object.entries(draft.modules)) if (v && v !== 'inherit') payload.modules[k] = v;
  for (const [k, v] of Object.entries(draft.widgets)) if (v && v !== 'inherit') payload.widgets[k] = v;
  for (const [k, v] of Object.entries(draft.capabilities)) if (v && v !== 'inherit') payload.capabilities[k] = v;
  return payload;
}

/* WAS DER SERVER HAELT, JE ENTWURF (Codex an #2364, P1). Der PUT ersetzt die
 * Rechte des Subjekts als Ganzes, also steht auf dem Server genau der Stand des
 * letzten gelungenen PUT (oder der geladene). Ein gescheiterter Schritt legt
 * seine Zeile auf DIESEN Wert zurueck, nicht auf den Wert vor dem Klick: der
 * stammte womoeglich von einer Wahl, deren PUT selbst scheiterte. */
const savedOf = new WeakMap();
function markLoaded() {
  state.loadedFor = subjectKey();
  savedOf.set(state.draft, payloadOf(state.draft));
}

/* WER EINE ZEILE ZULETZT GESETZT HAT. Jede Wahl und jedes Rueckgaengig zieht
 * eine laufende Nummer; zuruecklegen oder rueckgaengig machen darf nur, wer
 * die Zeile noch besitzt. Sonst legte ein gescheiterter erster PUT die schon
 * getroffene zweite Wahl derselben Zeile zurueck (Vorgabe -> read -> none:
 * Server none, Entwurf ohne Einschraenkung - die naechste Wahl hob die Sperre auf). */
let writeSeq = 0;
const rowWriter = new WeakMap(); // Bucket des Entwurfs -> Map(Schluessel -> Nummer)
function claimRow(bucket, key) {
  let owners = rowWriter.get(bucket);
  if (!owners) rowWriter.set(bucket, owners = new Map());
  writeSeq += 1;
  owners.set(key, writeSeq);
  return writeSeq;
}
const ownsRow = (bucket, key, seq) => rowWriter.get(bucket)?.get(key) === seq;

/**
 * SPEICHERT SOFORT, NACHEINANDER (R24, E11). Jede Wahl schreibt die Rechte des
 * Subjekts als Ganzes (PUT, wie bisher der Knopf); Wahlen kurz hintereinander
 * laufen in einer Reihe, damit die spaetere nie von einer frueheren Antwort
 * ueberholt wird. Der Entwurf bleibt der lokale Stand - eine Antwort schreibt
 * ihn nicht zurueck (eine inzwischen getroffene Wahl ginge sonst verloren).
 *
 * Der Stand wird erst gelesen, wenn der PUT an der Reihe ist, und `onFail`
 * laeuft IN der Reihe, bevor der naechste ihn liest: ein wartender PUT schickt
 * so nie eine Wahl mit, die ein frueherer Schritt schon zurueckgelegt hat.
 * @param {() => void} [onFail]
 * @returns {Promise<boolean>} gespeichert
 */
let saveQueue = Promise.resolve(true);
function persist(onFail) {
  if (!draftIsCurrent()) return Promise.resolve(false);
  const key = subjectKey();
  const draft = state.draft;
  const url = state.mode === 'role'
    ? `/permissions/role/${encodeURIComponent(state.subjectId)}`
    : `/permissions/user/${encodeURIComponent(state.subjectId)}`;
  const run = async () => {
    const payload = payloadOf(draft);
    try {
      await api.put(url, payload);
      savedOf.set(draft, payload);
      // Neue Rechte koennen neue Mitleser eines Moduls schaffen: `othersCanRead`
      // neu holen, damit die Schutzfelder in derselben Sitzung stimmen.
      await auth.me().catch(() => {});
      return true;
    } catch (err) {
      onFail?.();
      window.yuvomi?.showToast(err.message || t('common.errorGeneric'), 'danger');
      return false;
    }
  };
  saveQueue = saveQueue.then(run, run);
  return saveQueue.then((ok) => ok && subjectKey() === key);
}

const BUCKET = { module: 'modules', widget: 'widgets', capability: 'capabilities' };

/** Den Wert einer Zeile setzen, wie er im Entwurf steht (Rueckgaengig, Fehler). */
function syncSelect(container, group) {
  const select = container.querySelector(`#${domId(group)}`);
  if (!select) return;
  const { type, key } = parsePermissionGroup(group);
  const value = state.draft[BUCKET[type]]?.[key];
  if (value !== undefined) { select.value = value; return; }
  // Ohne eigenen Eintrag steht, was die Zeile beim Zeichnen zeigt: erben
  // (Mitglied) bzw. die Vorgabe der Rolle.
  if (state.mode === 'user') { select.value = 'inherit'; return; }
  if (type === 'module') select.value = 'write';
  else if (type === 'widget') select.value = 'allow';
  else {
    const item = (state.catalog.capabilities || []).find((entry) => entry.key === key);
    if (item) select.value = resolveCapabilityAccess(item, { mode: 'role', inherited: state.inherited.capabilities[key] });
  }
}

async function applyChange(container, select) {
  // Am ERSTEN Doppelpunkt trennen, nicht an allen (#1009): der Schluessel eines
  // Fremdmoduls ist selbst `ext:<modulId>` und eine Fremd-Widget-Id
  // `<modulId>:<widgetId>`. Ein destrukturierendes split(':') behielt davon nur
  // `ext` bzw. die Modul-Id, und der Server wies das zu Recht ab.
  const group = select.dataset.group;
  const { type, key } = parsePermissionGroup(select.dataset.group);
  if (!key || !draftIsCurrent() || !BUCKET[type]) return;
  const draft = state.draft;
  const bucket = draft[BUCKET[type]];
  const before = Object.hasOwn(bucket, key) ? bucket[key] : undefined;
  const value = select.value;
  const subject = subjectKey();
  const title = subjectTitle();
  const set = (next) => {
    if (next === undefined) delete bucket[key]; else bucket[key] = next;
    // Inzwischen ein anderes Subjekt oder ein neuer Entwurf: dessen Zeilen
    // zeichnen sich selbst, hier gibt es nichts zu zeigen.
    if (subjectKey() !== subject || state.draft !== draft) return;
    syncSelect(container, group);
    // Modul-Aenderung: nur die aufgeklappte Zeile DIESES Moduls neu (Sperr-Zustaende).
    if (type === 'module') rebuildModuleWidgets(container, key);
    renderSummary(container);
  };
  // Setzen und speichern; scheitert der PUT, legt er die Zeile auf den Stand
  // des Servers zurueck - aber nur, solange keine neuere Wahl sie besitzt.
  const write = (next) => {
    const seq = claimRow(bucket, key);
    set(next);
    const ok = persist(() => {
      if (ownsRow(bucket, key, seq)) set(savedOf.get(draft)?.[BUCKET[type]]?.[key]);
    });
    return ok.then((saved) => ({ saved, seq }));
  };
  const first = await write(value);
  if (!first.saved) return;
  window.yuvomi?.showToast(t('settings.permSaved', { name: title }), 'success', 5000, {
    label: t('common.undo'),
    onClick: async () => {
      // Inzwischen ein anderes Subjekt: dessen Entwurf ist nicht der, der sich
      // geaendert hat. Eine neuere Wahl derselben Zeile: sie gilt, ein spaetes
      // Rueckgaengig dieser aelteren nahm sie sonst still zurueck.
      if (subjectKey() !== subject || state.draft !== draft || !ownsRow(bucket, key, first.seq)) return;
      await write(before);
    },
  });
}

// ── Interaktion ──────────────────────────────────────────────────────────────

function bindEvents(container) {
  // Geteilte gleitende Kapsel (Re-Critique 2026-09-27, D8): sie folgt dem
  // Klassenwechsel unten von selbst.
  const modeSwitch = container.querySelector('.perm-mode');
  if (modeSwitch) attachSegmentIndicator(modeSwitch);
  // Modus umschalten
  container.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.mode;
      if (next === state.mode) return;
      container.querySelectorAll('[data-mode]').forEach((b) => {
        const active = b.dataset.mode === next;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      selectSubject(container, next, initialSubject(next, state.catalog));
    });
  });

  // Subjekt-Auswahl (Event-Delegation). Eine scrollende Zeile (R24 S13):
  // die Fade-Kanten sagen, dass es weitergeht (settings.css, .perm-subjects).
  wireScrollFade(container.querySelector('#perm-subjects'));
  container.querySelector('#perm-subjects')?.addEventListener('click', async (e) => {
    const chip = e.target.closest('.perm-chip');
    if (!chip) return;
    const same = (chip.dataset.role != null && state.mode === 'role' && String(chip.dataset.role) === String(state.subjectId))
      || (chip.dataset.user != null && state.mode === 'user' && String(chip.dataset.user) === String(state.subjectId));
    if (same) return;
    if (chip.dataset.role != null) selectSubject(container, 'role', chip.dataset.role);
    else if (chip.dataset.user != null) selectSubject(container, 'user', chip.dataset.user);
  });

  // Matrix: Auswahl je Zeile, Aufklappen, Zuruecksetzen (Delegation).
  const matrix = container.querySelector('#perm-matrix');
  matrix?.addEventListener('change', (e) => {
    const select = e.target?.closest?.('.perm-select');
    if (select && !select.disabled) applyChange(container, select);
  });
  matrix?.addEventListener('click', (e) => {
    const expand = e.target.closest('[data-perm-expand]');
    if (expand) return toggleModule(container, expand);
    if (e.target.closest('#perm-reset')) return resetSubject(container);
  });
}

/** Die Zeile eines Moduls auf- oder zuklappen; der Zustand ueberlebt den Neubau. */
function toggleModule(container, button) {
  const key = button.dataset.permExpand;
  const open = button.getAttribute('aria-expanded') !== 'true';
  if (open) state.expanded.add(key); else state.expanded.delete(key);
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
  const more = container.querySelector(`#${button.getAttribute('aria-controls')}`);
  if (more) more.hidden = !open;
}

async function resetSubject(container) {
  // Ohne geladenen Entwurf gibt es nichts zurueckzusetzen - auch keine Frage.
  if (!draftIsCurrent()) return;
  // War der einzige Confirm ohne `danger`, obwohl er Zugriffsbeschraenkungen
  // aufhebt - und bei einer Rolle gleich fuer mehrere Personen.
  const ok = await confirmModal(t('settings.permResetConfirm', { name: subjectTitle() }), {
    danger: true,
    confirmLabel: t('settings.permResetSubject'),
    detail: t('settings.permResetConfirmDetail'),
  });
  if (!ok || !draftIsCurrent()) return;
  const before = state.draft;
  const title = subjectTitle();
  const cleared = { modules: {}, widgets: {}, capabilities: {} };
  // Bis der PUT gelingt, haelt der Server noch die alten Rechte: eine Wahl im
  // geleerten Entwurf, deren PUT scheitert, legt sich darauf zurueck.
  savedOf.set(cleared, savedOf.get(before));
  state.draft = cleared;
  renderMatrix(container);
  refocusAfterRender();
  if (await persist()) {
    window.yuvomi?.showToast(t('settings.permSaved', { name: title }), 'success');
  } else if (state.draft === cleared) {
    // Nur zurueck, solange der geleerte Entwurf noch DERSELBE ist: inzwischen
    // ein anderes Subjekt gewaehlt (persist() meldet dann false, auch wenn der
    // PUT gelang), stuenden dessen Zeilen sonst mit den alten Rechten da, und
    // die naechste Wahl speicherte sie dort (Codex an #2364).
    state.draft = before;
    renderMatrix(container);
    refocusAfterRender();
  }
}

// ── Render-Einstieg ──────────────────────────────────────────────────────────

function renderShell(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section perm-page">
      ${/* Ein Satz vor dem ersten Feld, der Rest hinter "Mehr dazu" (R23 D14). */ ''}
      ${hintFoldHtml({ lead: t('settings.permIntro'), moreHtml: `<p>${esc(t('settings.permIntroMore'))}</p>`, className: 'settings-section__intro' })}

      <!-- Trug bis zum Copy-Durchgang den Seitentitel als Label: der beschreibt
           die Seite, nicht die Umschaltung (Critique 2026-07-27). -->
      <!-- DER KANON-UMSCHALTER (R14, A7 P2-4/Konsistenz): segmented wie Design
           und Wochenstart, statt einer eigenen Pille mit eigenem Daumen. -->
      <div class="segmented settings-segmented perm-mode" role="tablist" aria-label="${esc(t('settings.permModeLabel'))}">
        <button type="button" class="segmented__item is-active" role="tab" aria-selected="true" data-mode="role">
          <i data-lucide="users-round" aria-hidden="true"></i>${esc(t('settings.permByRole'))}
        </button>
        <button type="button" class="segmented__item" role="tab" aria-selected="false" data-mode="user">
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
  state.draft = { modules: {}, widgets: {}, capabilities: {} };
  state.inherited = { modules: {}, widgets: {}, capabilities: {} };
  state.expanded = new Set();

  bindEvents(container);
  await selectSubject(container, 'role', initialSubject('role', catalog));
  window.lucide?.createIcons({ el: container });
}
