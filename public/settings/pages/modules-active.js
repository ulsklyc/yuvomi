import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import { bindDisclosure, thirdPartyStatusLabel, toggleRowHtml } from '/settings/components.js';
import {
  BUILT_IN_MODULES,
  DEFAULT_MODULE_ACCENT,
  KITCHEN_CHILD_IDS,
  KITCHEN_CHILD_LABEL_KEYS,
  NAV_SECTION,
  NAV_SECTIONS,
  NAV_SECTION_LABEL_KEYS,
  moduleSection,
} from '/settings/module-order.js';
import { MODULE_ICON, moduleIconHTML } from '/nav-icons.js';
import { moduleAccentVar } from '/utils/module-accent.js';
import { moduleDisplayLabel } from '/utils/extension-i18n.js';

/**
 * Blatt: Einstellungen -> Module -> Aktive Module (adminOnly)
 *
 * WARUM ES DIESES BLATT GIBT (Critique 2026-08-16, P0).
 * Die Schalter standen bis dahin auf `Persoenlich -> Navigation`, inline hinter
 * `isAdmin` versteckt. Das war ein Rest aus der Zeit, als das ganze Blatt unter
 * *Module* lag: als die Reihenfolge per-user wurde, zog das Blatt zu den
 * persoenlichen Einstellungen um und nahm den haushaltweiten Schalter mit.
 *
 * Ertraeglich war das, solange eine Zeile genau ein Bedienelement trug. Mit dem
 * persoenlichen Ausblenden (#673) standen darin ZWEI - zwoelf Pixel
 * auseinander, beide unbeschriftet, mit sehr verschiedener Reichweite: der eine
 * raeumt meine Navigation auf, der andere nimmt sechs Personen ein Modul weg,
 * ohne Rueckfrage und ohne Ruecknahme. Der Unterschied stand nirgends in der
 * Oberflaeche, nur im Quelltext.
 *
 * Die Trennung loest das an der Wurzel statt mit Beschriftung: ein Blatt, eine
 * Reichweite. Hier entscheidet der Haushalt, was es gibt; drueben entscheidet
 * jede Person, was sie sehen will.
 */

/** Zeilen in derselben Reihenfolge und Gruppierung wie die Navigation - nur ohne Sortierung. */
function buildRows(preferences, thirdPartyModules) {
  const disabled = new Set(Array.isArray(preferences.disabled_modules) ? preferences.disabled_modules : []);
  const rows = [];

  for (const module of BUILT_IN_MODULES) {
    if (KITCHEN_CHILD_IDS.includes(module.id) || module.locked) continue;
    rows.push({
      type: 'built-in',
      id: module.id,
      section: moduleSection(module.id),
      label: t(module.labelKey),
      icon: MODULE_ICON[module.id],
      enabled: !disabled.has(module.id),
    });
  }

  const children = KITCHEN_CHILD_IDS.map((id) => ({
    id,
    label: t(KITCHEN_CHILD_LABEL_KEYS[id]),
    icon: MODULE_ICON[id],
    enabled: !disabled.has(id),
  }));
  const enabledChildren = children.filter((child) => child.enabled).length;
  rows.push({
    type: 'kitchen',
    id: 'kitchen',
    section: NAV_SECTION.household,
    label: t('nav.kitchen'),
    icon: MODULE_ICON.kitchen,
    children,
    enabledChildren,
    enabled: enabledChildren > 0,
  });

  for (const module of thirdPartyModules) {
    rows.push({
      type: 'third-party',
      id: module.id,
      section: NAV_SECTION.customModules,
      label: moduleDisplayLabel(module),
      icon: module.menu?.icon || module.icon || 'box',
      enabled: module.enabled && module.status === 'enabled',
      status: module.menu?.show === false ? t('settings.modulesMenuDisabled') : thirdPartyStatusLabel(module),
      error: module.error,
      toggleDisabled: module.status === 'error',
      hasError: module.status === 'error',
      accent: module.accent,
    });
  }

  return rows;
}

/**
 * Das Statuswort einer Modulzeile - nur fuer die ABWEICHUNG (Komponenten-Kanon,
 * 2026-09-26). Bis dahin trug jede eingeschaltete Zeile ein gruenes
 * „Aktiviert" neben ihrem gehakten Schalter: vierzehnmal dieselbe Aussage in
 * zwei Formen, und die eine Zeile, die anders war, ging darin unter. Der
 * Schalter sagt „an"; ein Wort steht nur, wo er etwas nicht sagt - ein
 * abgeschaltetes Modul (der Schalter allein ist mobil ein kleiner grauer
 * Strich), ein Fehler oder ein Drittmodul, das an ist, aber nicht im Menue.
 */
function statusChipHtml(row) {
  if (row.type === 'third-party') {
    if (row.hasError) return `<span class="settings-module-status settings-module-status--error">${esc(row.status)}</span>`;
    if (row.enabled && row.status === t('settings.thirdPartyModulesStatusEnabled')) return '';
    return `<span class="settings-module-status settings-module-status--disabled">${esc(row.status)}</span>`;
  }
  if (row.enabled) return '';
  return `<span class="settings-module-status settings-module-status--disabled">${esc(t('settings.thirdPartyModulesStatusDisabled'))}</span>`;
}

function rowHtml(row) {
  const stateClass = row.enabled ? 'settings-module-row--enabled' : 'settings-module-row--disabled';
  // Ein Drittanbieter-Modul bringt seine Farbe als Wert mit, ein eingebautes
  // holt sie aus dem geteilten Auflöser - beide landen in derselben Property.
  // Ohne den zweiten Zweig fiel jede eingebaute Zeile auf --color-accent
  // zurück, siehe utils/module-accent.js.
  const accent = row.type === 'third-party'
    ? (esc(row.accent) || DEFAULT_MODULE_ACCENT)
    : moduleAccentVar(row.id);
  const accentStyle = accent ? ` style="--module-row-accent:${accent}"` : '';
  // Die Kueche traegt keinen eigenen Schalter: sie IST ihre vier Kinder, und ein
  // fuenfter Schalter darueber koennte nur wiederholen, was sie zusammen sagen.
  const toggleAttr = row.type === 'third-party'
    ? { 'data-third-party-module-toggle': row.id }
    : { 'data-built-in-module-toggle': row.id };

  const kitchenPanel = row.type === 'kitchen' ? `
    <button type="button" class="settings-disclosure__trigger settings-module-kitchen__trigger" aria-expanded="false" data-kitchen-expand>
      <span>${t('settings.kitchenActiveCount', { count: row.enabledChildren })}</span>
      <i data-lucide="chevron-down" class="settings-disclosure__icon" aria-hidden="true"></i>
    </button>
    <div class="settings-disclosure__panel settings-module-kitchen__children" data-kitchen-children hidden>
      ${row.children.map((child) => toggleRowHtml({
    control: 'switch',
    label: child.label,
    checked: child.enabled,
    className: 'settings-module-kitchen__child',
    icon: child.icon,
    attrs: { 'data-kitchen-child-toggle': child.id },
  })).join('')}
    </div>` : '';

  return `
    <div class="settings-module-row settings-module-row--fixed ${stateClass}${row.hasError ? ' settings-module-row--error' : ''}" data-module-row-id="${esc(row.id)}">
      <div class="settings-module-row__icon vivid-mark"${accentStyle}>
        ${moduleIconHTML(row.icon)}
      </div>
      <div class="settings-module-row__body">
        <div class="settings-module-row__title">
          <strong>${esc(row.label)}</strong>
          ${row.type === 'third-party' ? `<span class="settings-module-origin">${esc(t('settings.modulesExternalBadge'))}</span>` : ''}
          ${statusChipHtml(row)}
        </div>
        ${row.error ? `<p class="form-error" role="alert">${esc(row.error)}</p>` : ''}
        ${kitchenPanel}
      </div>
      ${row.type === 'kitchen' ? '' : toggleRowHtml({
    control: 'switch',
    label: t('settings.modulesEnableForHousehold', { module: row.label }),
    checked: row.enabled,
    disabled: row.toggleDisabled,
    className: 'settings-module-row__toggle',
    labelVisible: false,
    attrs: toggleAttr,
  })}
    </div>
  `;
}

function sectionHtml(section, rows) {
  const inSection = rows.filter((row) => row.section === section);
  if (!inSection.length) return '';
  return `
    <section class="settings-navigation-group" data-module-section="${esc(section)}">
      <h3 class="settings-navigation-group__title">${t(NAV_SECTION_LABEL_KEYS[section])}</h3>
      <div class="row-carrier settings-modules-list">${inSection.map(rowHtml).join('')}</div>
    </section>
  `;
}

/** Der komplette Satz abgeschalteter Slugs aus dem gerenderten Blatt. */
export function collectDisabledModuleIds(list) {
  const ids = new Set();
  for (const input of list.querySelectorAll('[data-built-in-module-toggle]')) {
    if (!input.checked) ids.add(input.dataset.builtInModuleToggle);
  }
  for (const input of list.querySelectorAll('[data-kitchen-child-toggle]')) {
    if (!input.checked) ids.add(input.dataset.kitchenChildToggle);
  }
  return [...ids];
}

/**
 * Save-Payload dieses Blatts: NUR der haushaltweite Schalter.
 *
 * Weder `module_order` noch `hidden_modules` gehoeren hierher - beide sind
 * per-user, und ein adminOnly-Blatt, das sie schreibt, ist genau der Fall, den
 * `test:settings-admin-gate` sucht: jeder darf sie setzen, nur erreicht sie
 * niemand ausser der Adminin.
 */
export function buildActiveModulesPayload(disabledIds) {
  return { disabled_modules: [...new Set(disabledIds)] };
}

/**
 * Schalter-Persistenz mit Ruecknahme: sperrt den Input waehrend des Speicherns,
 * stellt bei Fehlschlag den vorherigen Zustand wieder her und rendert NUR nach
 * erfolgreichem Speichern neu.
 *
 * Die Trennung der beiden Fehlerfaelle ist der Punkt: ein fehlgeschlagener
 * Re-Render darf den Schalter NICHT zuruecksetzen, denn gespeichert ist da
 * bereits. Diese Funktion zog mit dem Haushalts-Schalter von der Navigation
 * hierher und verlor beim Umzug ihre drei Tests - der Fehlerpfad des einzigen
 * Blatts, das ein Modul fuer alle abschaltet, stand danach ungeprueft da
 * (Review zu PR #790).
 */
export async function persistHouseholdToggle(input, enabled, save, rerender) {
  input.disabled = true;
  try {
    await save();
  } catch (error) {
    input.checked = !enabled;
    input.disabled = false;
    throw error;
  }
  await rerender();
}

async function saveActiveModules(list) {
  const payload = buildActiveModulesPayload(collectDisabledModuleIds(list));
  const response = await savePreferences(payload);
  const saved = response?.data?.disabled_modules ?? payload.disabled_modules;
  window.yuvomi?.setDisabledModules?.(saved);
}

function bindEvents(container, user) {
  const list = container.querySelector('#module-toggles');
  if (!list) return;

  list.addEventListener('change', async (event) => {
    const input = event.target.closest(
      '[data-built-in-module-toggle], [data-third-party-module-toggle], [data-kitchen-child-toggle]',
    );
    if (!input) return;
    const enabled = input.checked;
    try {
      await persistHouseholdToggle(input, enabled, async () => {
        if (input.dataset.thirdPartyModuleToggle) {
          await api.patch(`/modules/${encodeURIComponent(input.dataset.thirdPartyModuleToggle)}`, { enabled });
          await window.yuvomi?.refreshThirdPartyModules?.();
        }
        await saveActiveModules(list);
        window.yuvomi?.showToast(t('settings.thirdPartyModulesSaved'), 'success');
      }, () => render(container, { user }));
    } catch (error) {
      window.yuvomi?.showToast(error.message ?? t('common.errorGeneric'), 'danger');
    }
  });
}

export async function render(container, { user }) {
  container.replaceChildren();

  let preferences = {};
  let thirdPartyModules = [];
  try {
    const [prefs, modules] = await Promise.all([
      getPreferences(),
      api.get('/modules?admin=1').then((res) => res?.data ?? []).catch(() => []),
    ]);
    preferences = prefs ?? {};
    thirdPartyModules = Array.isArray(modules) ? modules : [];
  } catch (error) {
    container.insertAdjacentHTML('beforeend',
      `<p class="form-error" role="alert">${esc(error.message ?? t('common.errorGeneric'))}</p>`);
    return;
  }

  const rows = buildRows(preferences, thirdPartyModules);

  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <section class="settings-navigation-panel">
        <h2 class="settings-navigation-panel__title">${t('settings.activeModulesTitle')}</h2>
        <p class="form-hint">${t('settings.activeModulesHint')}</p>
        <div class="settings-navigation-groups" id="module-toggles">
          ${NAV_SECTIONS.map((section) => sectionHtml(section, rows)).join('')}
        </div>
      </section>
    </section>
  `);

  bindDisclosure(container, { triggerSelector: '[data-kitchen-expand]', panelSelector: '[data-kitchen-children]', id: 'kitchen-children-active' });
  bindEvents(container, user);
  window.lucide?.createIcons({ el: container });
}
