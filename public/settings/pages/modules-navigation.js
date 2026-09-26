import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import { bindDisclosure, createRetryState, thirdPartyStatusLabel } from '/settings/components.js';
import {
  BUILT_IN_MODULES,
  DEFAULT_MODULE_ACCENT,
  KITCHEN_CHILD_IDS,
  KITCHEN_CHILD_LABEL_KEYS,
  NAV_SECTION,
  NAV_SECTIONS,
  NAV_SECTION_LABEL_KEYS,
  expandModuleOrder,
  moduleSection,
  normalizeModuleOrder,
  normalizeMobileNavOrder,
  resolveMobileNavOrder,
  sortNavigationItems,
} from '/settings/module-order.js';
import { MODULE_ICON, moduleIconHTML } from '/nav-icons.js';
import { moduleAccentVar } from '/utils/module-accent.js';
import { moduleDisplayLabel } from '/utils/extension-i18n.js';
import { emptyStateHTML } from '/utils/empty-state.js';

// Baut die geordnete Liste der Navigations-Rows: gesperrte, gewöhnliche, Kitchen
// (als ein expandierbarer Eintrag) und Drittanbieter-Module — sortiert nach der
// normalisierten Modul-Reihenfolge der Preferences.
function buildRows(preferences, thirdPartyModules) {
  const disabled = new Set(Array.isArray(preferences.disabled_modules) ? preferences.disabled_modules : []);
  // Zwei Mengen, zwei Fragen (#673): `disabled` = gibt es im Haushalt nicht,
  // `hidden` = will ich nicht in meiner Navigation sehen. Siehe parseHiddenModules
  // in server/routes/preferences.js.
  const hidden = new Set(Array.isArray(preferences.hidden_modules) ? preferences.hidden_modules : []);
  const kitchenChildren = KITCHEN_CHILD_IDS.map((id) => ({
    id,
    label: t(KITCHEN_CHILD_LABEL_KEYS[id]),
    icon: MODULE_ICON[id],
    enabled: !disabled.has(id),
    hidden: hidden.has(id),
  }));

  const rows = [];
  let kitchenInserted = false;

  for (const module of BUILT_IN_MODULES) {
    if (KITCHEN_CHILD_IDS.includes(module.id)) continue;
    rows.push({
      type: 'built-in',
      id: module.id,
      orderId: module.id,
      section: moduleSection(module.id),
      label: t(module.labelKey),
      icon: MODULE_ICON[module.id],
      enabled: module.locked || !disabled.has(module.id),
      hidden: hidden.has(module.id),
      locked: module.locked === true,
      sortable: module.locked !== true,
    });
  }

  const kitchenEnabledChildren = kitchenChildren.filter((child) => child.enabled).length;
  const kitchenRow = {
    type: 'kitchen',
    id: 'kitchen',
    orderId: 'kitchen',
    section: NAV_SECTION.household,
    label: t('nav.kitchen'),
    icon: MODULE_ICON.kitchen,
    children: kitchenChildren,
    enabledChildren: kitchenEnabledChildren,
    enabled: kitchenEnabledChildren > 0,
    // Die Kueche ist EIN Eintrag in der mobilen Navigation, aber vier in der
    // Seitenleiste. Ihr Ausblenden-Knopf steht deshalb fuer die Gruppe: er gilt
    // als gedrueckt, wenn kein aktives Kind mehr sichtbar ist, und die einzelnen
    // Kinder bleiben im aufgeklappten Feld getrennt schaltbar.
    hidden: kitchenGroupHidden(kitchenChildren),
    locked: false,
    sortable: true,
  };

  const thirdPartyRows = thirdPartyModules.map((module) => {
    const menuHidden = module.menu?.show === false;
    return {
      type: 'third-party',
      id: module.id,
      orderId: `third-party-${module.id}`,
      section: NAV_SECTION.customModules,
      label: moduleDisplayLabel(module),
      icon: module.menu?.icon || module.icon || 'box',
      enabled: module.enabled && module.status === 'enabled',
      status: menuHidden ? t('settings.modulesMenuDisabled') : thirdPartyStatusLabel(module),
      error: module.error,
      toggleDisabled: module.status === 'error',
      hasError: module.status === 'error',
      menuHidden,
      sortable: !menuHidden,
      accent: module.accent,
      locked: false,
    };
  });

  // Kitchen an erster Definitionsposition einfügen (vor das erste Haushalts-Modul),
  // damit es konsistent mit der globalen Navigation erscheint.
  const ordered = [];
  for (const row of rows) {
    if (!kitchenInserted && ['housekeeping', 'documents', 'rewards', 'contacts', 'birthdays', 'health', 'budget'].includes(row.id)) {
      ordered.push(kitchenRow);
      kitchenInserted = true;
    }
    ordered.push(row);
  }
  if (!kitchenInserted) ordered.push(kitchenRow);
  ordered.push(...thirdPartyRows);

  // Die gespeicherte Reihenfolge gilt nur innerhalb der drei Navigationsgruppen.
  // Dashboard und Settings bleiben an ihren festen Positionen.
  const normalizedOrder = normalizeModuleOrder(preferences.module_order || []);
  return sortNavigationItems(ordered, normalizedOrder);
}

function rowControlsHtml(row) {
  if (!row.sortable) return '';
  return `
    <button type="button" class="settings-module-drag" aria-label="${esc(t('settings.modulesDragHandle'))}" title="${esc(t('settings.modulesDragHandle'))}">
      <i data-lucide="grip-vertical" aria-hidden="true"></i>
    </button>
    <div class="settings-module-move-buttons">
      <button type="button" class="settings-module-move" data-module-move="up" aria-label="${esc(t('settings.modulesMoveUp'))}" title="${esc(t('settings.modulesMoveUp'))}">
        <i data-lucide="chevron-up" aria-hidden="true"></i>
      </button>
      <button type="button" class="settings-module-move" data-module-move="down" aria-label="${esc(t('settings.modulesMoveDown'))}" title="${esc(t('settings.modulesMoveDown'))}">
        <i data-lucide="chevron-down" aria-hidden="true"></i>
      </button>
    </div>
  `;
}

/* EIN BLATT, EINE REICHWEITE (#673, nachgeschärft nach der Critique vom 2026-08-16).
 *
 * Dieses Blatt gehört seit dem Umzug des Haushalts-Schalters nach
 * `modules-active` ganz der Person, die es öffnet: Reihenfolge, mobile Plätze
 * und dieser Knopf wirken ausschliesslich für sie. Deshalb steht hier nur noch
 * EIN Bedienelement je Zeile, und der Knopf muss keinen Nachbarn mehr von sich
 * abgrenzen.
 *
 * DREI DINGE, DIE DIE CRITIQUE GEMESSEN HAT UND DIE HIER JETZT ANDERS STEHEN:
 *
 * 1. Das Symbol ist FEST `eye-off`. Vorher wechselte es zwischen `eye` und
 *    `eye-off` und drehte damit das Register der ganzen App um: `eye` heisst in
 *    Yuvomi überall "zeig mir das" (Dokumentenvorschau, Gesundheit, Backup), es
 *    ist eine HANDLUNG. Als Zustandsanzeige auf einem Knopf, dessen Beschriftung
 *    eine Handlung ansagt, war es rückwärts lesbar.
 * 2. Der zugängliche Name ist STABIL und nennt sein Modul. Vorher trug der Knopf
 *    gleichzeitig `aria-pressed="true"` und "Für mich einblenden" - eine Ansage,
 *    die sich selbst widerspricht ("einblenden, gedrückt"). Ein Umschaltknopf
 *    trägt seinen Zustand in `aria-pressed`, nie zusätzlich im Namen. Und sechzehn
 *    wortgleiche "Für mich ausblenden" machten die Rotorliste unbrauchbar.
 * 3. Ein deaktivierter Knopf nennt seinen Grund über `aria-describedby` auf den
 *    Status-Chip derselben Zeile, statt nur "nicht verfügbar" zu sagen.
 *
 * Drittanbieter-Module tragen ihn nicht: `hidden_modules` prüft serverseitig
 * gegen dieselbe Allowlist wie der Haushalts-Schalter, und die kennt nur die
 * eingebauten Slugs; ein Knopf, dessen Wert der Server verwirft, wäre eine
 * Zusage, die niemand einhält.
 */
function hideToggleHtml(row, { hasStatusChip = true } = {}) {
  const label = row.groupLabelKey
    ? t(row.groupLabelKey)
    : t('settings.modulesHideForMe', { module: row.label });
  // Nur verweisen, wo es auch etwas zu lesen gibt: die Kuechen-Kinder tragen
  // keinen Status-Chip, ein `aria-describedby` auf eine Id, die es nicht gibt,
  // sagt der Hilfstechnik NICHTS - genau der Zustand, den dieser Verweis
  // beheben sollte (Review zu PR #790).
  const describedBy = (!row.enabled && hasStatusChip)
    ? ` aria-describedby="module-status-${esc(row.id)}"`
    : '';
  return `
    <button type="button" class="settings-module-hide" data-module-hide="${esc(row.id)}"
            aria-pressed="${row.hidden ? 'true' : 'false'}" ${row.enabled ? '' : 'disabled'}
            aria-label="${esc(label)}" title="${esc(label)}"${describedBy}>
      <i data-lucide="eye-off" aria-hidden="true"></i>
    </button>
  `;
}

/* EIN STATUSKANAL JE ZEILE (Critique 2026-08-16, P0).
 *
 * Vorher trug eine ausgeblendete Zeile ZWEI Statusworte nebeneinander -
 * "Aktiviert · Für mich ausgeblendet" -, und das betonte davon war das falsche:
 * "Aktiviert" ist eine gefüllte grüne Pille, "Für mich ausgeblendet" war grauer
 * Text. Als Endzustand des Ablaufs sagte die Zeile gleichzeitig "an" und "weg".
 *
 * Seit der Haushalts-Schalter drüben auf `modules-active` steht, ist "Aktiviert"
 * hier ohnehin keine Nachricht mehr: was hier steht, ist aktiv, sonst stünde es
 * nicht in der Navigation. Ein Chip erscheint deshalb nur noch, wenn er etwas
 * erklärt - meine Ausblendung, oder das Fehlen im Haushalt, das den Knopf
 * sperrt und über `aria-describedby` auch angesagt wird.
 */
function statusChipHtml(row) {
  if (!row.enabled) {
    return `<span class="settings-module-status settings-module-status--disabled" id="module-status-${esc(row.id)}">${esc(t('settings.thirdPartyModulesStatusDisabled'))}</span>`;
  }
  if (row.hidden) {
    return `<span class="settings-module-status settings-module-status--hidden">${esc(t('settings.modulesHiddenForMe'))}</span>`;
  }
  return '';
}

function builtInRowHtml(row) {
  const stateClass = row.enabled ? 'settings-module-row--enabled' : 'settings-module-row--disabled';
  const lockedClass = row.locked ? ' settings-module-row--locked' : '';
  const hiddenClass = row.hidden && row.enabled ? ' settings-module-row--hidden' : '';
  return `
    <div class="settings-module-row settings-module-row--sortable ${stateClass}${lockedClass}${hiddenClass}${row.sortable ? '' : ' settings-module-row--fixed'}" data-module-row-id="${esc(row.orderId)}"${row.sortable ? ` draggable="true" data-module-order-id="${esc(row.orderId)}"` : ''}>
      ${rowControlsHtml(row)}
      <div class="settings-module-row__icon vivid-mark" style="--module-row-accent:${moduleAccentVar(row.id)}">
        ${moduleIconHTML(row.icon)}
      </div>
      <div class="settings-module-row__body">
        <div class="settings-module-row__title">
          <strong>${esc(row.label)}</strong>
          ${row.locked ? `<span class="settings-module-origin">${esc(t('settings.modulesBuiltInBadge'))}</span>` : ''}
          ${statusChipHtml(row)}
        </div>
      </div>
      ${row.locked ? '' : hideToggleHtml(row)}
    </div>
  `;
}

/* DIE KÜCHE IST EIN EINTRAG UND VIER STATIONEN (Critique 2026-08-16, P2).
 *
 * Drei gemessene Befunde stehen hier jetzt anders: der Gruppen-Knopf stand am
 * Desktop 42px rechts der Augenspalte aller anderen Zeilen (die Küchenzeile
 * füllt die letzte Rasterspalte nicht, `auto` kollabierte dort auf 0), er trug
 * denselben Namen wie die Einzelknöpfe, obwohl er vier Module auf einmal
 * betrifft, und in den Kindzeilen lag er auf der ANDEREN Seite als in der
 * Elternzeile - dieselben zwei Entscheidungen tauschten innerhalb einer
 * aufgeklappten Karte die Seite.
 *
 * Die Kinder liegen deshalb jetzt in derselben Ordnung wie ihre Elternzeile
 * (Symbol und Beschriftung links, Ausblenden rechts), der Gruppen-Knopf hat
 * seinen eigenen Namen, und die Spalte wird im Stylesheet erzwungen statt
 * dem Raster überlassen.
 */
function kitchenRowHtml(row) {
  const stateClass = row.enabled ? 'settings-module-row--enabled' : 'settings-module-row--disabled';
  const hiddenClass = row.hidden && row.enabled ? ' settings-module-row--hidden' : '';
  return `
    <div class="settings-module-row settings-module-row--sortable settings-module-row--kitchen ${stateClass}${hiddenClass}" data-module-row-id="${esc(row.orderId)}" draggable="true" data-module-order-id="${esc(row.orderId)}">
      ${rowControlsHtml(row)}
      <div class="settings-module-row__icon vivid-mark" style="--module-row-accent:${moduleAccentVar('kitchen')}">
        ${moduleIconHTML(row.icon)}
      </div>
      <div class="settings-module-row__body">
        <div class="settings-module-row__title">
          <strong>${esc(row.label)}</strong>
          ${statusChipHtml(row)}
        </div>
        <button type="button" class="settings-disclosure__trigger settings-module-kitchen__trigger" aria-expanded="false" data-kitchen-expand>
          <span>${t('settings.kitchenActiveCount', { count: row.enabledChildren })}</span>
          <i data-lucide="chevron-down" class="settings-disclosure__icon" aria-hidden="true"></i>
        </button>
        <div class="settings-disclosure__panel settings-module-kitchen__children" data-kitchen-children hidden>
          ${row.children.map((child) => `
            <div class="settings-module-kitchen__child-row${child.hidden && child.enabled ? ' settings-module-kitchen__child-row--hidden' : ''}">
              <div class="settings-module-kitchen__child">
                ${moduleIconHTML(child.icon)}
                <span>${esc(child.label)}</span>
              </div>
              ${hideToggleHtml(child, { hasStatusChip: false })}
            </div>`).join('')}
        </div>
      </div>
      ${hideToggleHtml({ ...row, id: 'kitchen', groupLabelKey: 'settings.modulesHideKitchenForMe' })}
    </div>
  `;
}

function thirdPartyRowHtml(row) {
  // Statuswort nur fuer die Abweichung, wie auf `modules-active` (Kanon
  // 2026-09-26): ein laufendes Drittmodul braucht kein gruenes „Aktiviert".
  const statusClass = row.hasError ? 'settings-module-status--error' : 'settings-module-status--disabled';
  const showStatus = row.hasError || !row.enabled || row.status !== t('settings.thirdPartyModulesStatusEnabled');
  const stateClass = row.enabled ? 'settings-module-row--enabled' : 'settings-module-row--disabled';
  const errorClass = row.hasError ? ' settings-module-row--error' : '';
  return `
    <div class="settings-module-row settings-module-row--sortable ${stateClass}${errorClass}${row.sortable ? '' : ' settings-module-row--fixed'}" data-module-row-id="${esc(row.orderId)}"${row.sortable ? ` draggable="true" data-module-order-id="${esc(row.orderId)}"` : ''}>
      ${rowControlsHtml(row)}
      <div class="settings-module-row__icon vivid-mark" style="--module-row-accent:${esc(row.accent) || DEFAULT_MODULE_ACCENT}">
        ${moduleIconHTML(row.icon)}
      </div>
      <div class="settings-module-row__body">
        <div class="settings-module-row__title">
          <strong>${esc(row.label)}</strong>
          <span class="settings-module-origin">${esc(t('settings.modulesExternalBadge'))}</span>
          ${showStatus ? `<span class="settings-module-status ${statusClass}">${esc(row.status)}</span>` : ''}
        </div>
        ${row.error ? `<p class="form-error" role="alert">${esc(row.error)}</p>` : ''}
      </div>
    </div>
  `;
}

function rowHtml(row) {
  if (row.type === 'kitchen') return kitchenRowHtml(row);
  // Drittanbieter-Zeilen erreichen Mitglieder nie: /modules?admin=1 wird für sie
  // gar nicht abgefragt, thirdPartyModules bleibt leer.
  if (row.type === 'third-party') return thirdPartyRowHtml(row);
  return builtInRowHtml(row);
}

function mobileCandidateRows(rows) {
  return rows.filter((row) => (
    row.enabled
    // Wer ein Modul aus seiner Navigation nimmt, will es auch nicht als
    // Mobil-Favorit angeboten bekommen (#673).
    && !row.hidden
    && !row.locked
    && row.sortable
    && !row.menuHidden
  ));
}

function mobileSlotHtml(rows, selectedIds, index) {
  const selectedId = selectedIds[index] ?? '';
  const selectedElsewhere = new Set(selectedIds.filter((_, slot) => slot !== index));
  const label = t('settings.mobileNavigationSlotLabel', { position: index + 1 });

  return `
    <label class="settings-mobile-nav-slot">
      <span class="settings-mobile-nav-slot__label">${esc(label)}</span>
      <select class="form-input" data-mobile-nav-slot aria-label="${esc(label)}"${selectedId ? '' : ' disabled'}>
        ${selectedId ? '' : `<option value="" selected>${esc(t('settings.mobileNavigationEmptyOption'))}</option>`}
        ${rows.map((row) => `
          <option value="${esc(row.orderId)}"${row.orderId === selectedId ? ' selected' : ''}${selectedElsewhere.has(row.orderId) ? ' disabled' : ''}>
            ${esc(row.label)}
          </option>
        `).join('')}
      </select>
    </label>
  `;
}

function desktopGroupHtml(section, rows) {
  const sectionRows = rows.filter((row) => row.section === section);
  if (!sectionRows.length) return '';

  return `
    <section class="settings-navigation-group" data-module-section="${section}">
      <h3 class="settings-navigation-group__title">${esc(t(NAV_SECTION_LABEL_KEYS[section]))}</h3>
      <div class="row-carrier settings-modules-list settings-modules-list--sortable" data-module-list>
        ${sectionRows.map((row) => rowHtml(row)).join('')}
      </div>
    </section>
  `;
}

function renderPage(container, rows, mobileOrder) {
  container.replaceChildren();
  const desktopGroups = rows.length
    ? `<div class="settings-navigation-groups" id="module-toggles">${NAV_SECTIONS.map((section) => desktopGroupHtml(section, rows)).join('')}</div>`
    : emptyStateHTML({
      compact: true,
      title: t('settings.thirdPartyModulesEmptyTitle'),
      description: t('settings.thirdPartyModulesEmptyHint'),
    });
  const mobileRows = mobileCandidateRows(rows);

  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <section class="settings-navigation-panel">
        <h2 class="settings-navigation-panel__title">${t('settings.mobileNavigationTitle')}</h2>
        <p class="form-hint">${t('settings.mobileNavigationHint')}</p>
        <div class="settings-mobile-nav-slots">
          ${[0, 1, 2].map((index) => mobileSlotHtml(mobileRows, mobileOrder, index)).join('')}
        </div>
      </section>
      <section class="settings-navigation-panel">
        <h2 class="settings-navigation-panel__title">${t('settings.desktopNavigationTitle')}</h2>
        <p class="form-hint">${t('settings.desktopNavigationHint')}</p>
        <p class="form-hint">${t('settings.modulesDragHint')}</p>
        <p class="form-hint">${t('settings.modulesHiddenScopeHint')}</p>
        ${desktopGroups}
      </section>
    </section>
  `);
  window.lucide?.createIcons({ el: container });
}

// Reihenfolge der sichtbaren, sortierbaren Order-IDs (inkl. dem einen Kitchen-
// Eintrag). Wird vor dem Speichern via expandModuleOrder zurück auf die
// kanonischen Kitchen-Kinder erweitert.
function collectVisibleGlobalOrder(list) {
  return [...list.querySelectorAll('[data-module-order-id]')]
    .map((rowEl) => rowEl.dataset.moduleOrderId)
    .filter(Boolean);
}

/**
 * Die persönlich ausgeblendeten Module aus dem gerenderten Blatt lesen (#673).
 *
 * Der Gruppenknopf der Küche wird ÜBERSPRUNGEN, obwohl er `kitchen` trägt. Er
 * hier auf seine vier Kinder aufzulösen sah nach derselben Regel aus wie
 * `expandModuleOrder` bei der Reihenfolge, schrieb aber Kinder mit, die niemand
 * gewählt hatte: die Gruppe gilt als versteckt, sobald jedes Kind versteckt
 * ODER haushaltweit abgeschaltet ist - ein abgeschaltetes Kind landete damit in
 * `hidden_modules` und wäre nach dem Wiedereinschalten für dieses Mitglied
 * versteckt gewesen, über einen Knopf, den es gar nicht drücken konnte
 * (Gegenprüfung zur Review von #790).
 *
 * Nötig ist die Auflösung ohnehin nicht: die vier Kind-Knöpfe stehen immer im
 * DOM - das Feld ist nur `hidden` - und der Gruppenklick legt sie selbst um.
 */
function collectHiddenModuleIds(buttons) {
  const ids = new Set();
  for (const btn of buttons) {
    if (btn.getAttribute('aria-pressed') !== 'true') continue;
    const id = btn.dataset.moduleHide;
    if (!id || id === 'kitchen') continue;
    ids.add(id);
  }
  return [...ids];
}

/**
 * Save-Payload dieses Blatts: ausschliesslich Persönliches.
 *
 * Bis zur Critique vom 2026-08-16 gab es hier zwei Payloads - eine für
 * Mitglieder (nur Reihenfolge) und eine für Admins (Reihenfolge PLUS
 * `disabled_modules`), weil der haushaltweite Schalter auf demselben Blatt
 * stand. Beides ist weg: der Schalter wohnt auf `modules-active`, und damit
 * schickt dieses Blatt für JEDE Rolle denselben Satz Schlüssel. Eine Payload,
 * die nicht mehr wissen muss, wer sie absendet, kann auch nicht mehr die
 * falsche sein.
 *
 * Verwaiste IDs sind unkritisch: normalizeModuleOrder filtert nicht gegen die
 * aktivierten Module, aber buildRows sortiert nur - eine ID ohne passende Zeile
 * bleibt wirkungslos.
 */
export function buildOrderPayload(visibleGlobalOrder, unrenderedIds = []) {
  const visible = expandModuleOrder(visibleGlobalOrder);
  // Was das Blatt nie gezeigt hat, darf es auch nicht loeschen: ein Mitglied
  // bekommt `/modules?admin=1` nicht, also stehen Drittanbieter-Module gar
  // nicht in seiner Liste. Ohne diesen Anhang wuerfe schon das Ausblenden
  // EINES eingebauten Moduls die gespeicherte Reihenfolge seiner eigenen
  // Zusatzmodule weg - still, denn sichtbar war sie hier nie (Codex-Review zu
  // PR #790).
  const missing = unrenderedIds.filter((id) => !visible.includes(id));
  return {
    module_order: [...visible, ...missing],
  };
}

export function buildMobileNavigationPayload(order) {
  return {
    mobile_nav_order: normalizeMobileNavOrder(order),
  };
}

async function saveNavigationState(list, unrenderedOrderIds = [], mobileOrder = null) {
  const payload = {
    ...buildOrderPayload(collectVisibleGlobalOrder(list), unrenderedOrderIds),
    hidden_modules: collectHiddenModuleIds(list.querySelectorAll('[data-module-hide]')),
    // Die drei Mobil-Plaetze fahren mit, wenn ein Ausblenden sie verschoben hat.
    // Ohne das behauptete der Toast eine Verschiebung, die der Server nicht
    // kennt: die Regel dieses Blatts ist "was die Leiste zeigt, ist was
    // gespeichert wird", und sie galt fuer den Ausblende-Pfad nicht
    // (Codex-Review zu PR #790).
    ...(mobileOrder ? { mobile_nav_order: mobileOrder } : {}),
  };
  const response = await savePreferences(payload);
  window.yuvomi?.setHiddenModules?.(response?.data?.hidden_modules ?? payload.hidden_modules);
  window.yuvomi?.setModuleOrder?.(response?.data?.module_order ?? payload.module_order);
  if (mobileOrder) {
    window.yuvomi?.setMobileNavOrder?.(response?.data?.mobile_nav_order ?? payload.mobile_nav_order);
  }
}

function bindModuleListEvents(container, user, rows, unrenderedOrderIds = []) {
  const list = container.querySelector('#module-toggles');
  if (!list) return;
  let dragged = null;
  let dragStartOrder = '';

  /* EINE SPERRE FUER BEIDE SCHREIBWEGE, UND SIE VERSCHLUCKT NICHTS.
   *
   * Sortieren und Ausblenden schicken denselben Payload aus demselben DOM
   * (`module_order` UND `hidden_modules`), also darf nicht beides gleichzeitig
   * laufen. Zwei getrennte Flags hatten das Problem nur halbiert: eine
   * Ausblendung konnte waehrend eines Sortier-Saves starten, und ein Klick auf
   * einen Pfeil waehrend einer Ausblendung fiel STILL heraus - die Zeile war im
   * DOM schon verschoben, gespeichert wurde nichts, und niemand erfuhr davon
   * (Gegenpruefung zur Review von #790).
   *
   * Statt zu verwerfen wird jetzt gemerkt: wer waehrend eines laufenden Saves
   * etwas aendert, bekommt seinen Save danach. */
  let saving = false;
  let queued = false;
  let busy = false;

  const flush = async (toastKey) => {
    if (saving) { queued = true; return; }
    saving = true;
    try {
      await saveNavigationState(list, unrenderedOrderIds);
      window.yuvomi?.showToast(t(toastKey), 'success');
    } catch (error) {
      window.yuvomi?.showToast(error.message ?? t('common.errorGeneric'), 'danger');
      await render(container, { user });
      return;
    } finally {
      saving = false;
    }
    if (queued) {
      queued = false;
      await flush(toastKey);
    }
  };

  const saveIfChanged = async (previousOrder) => {
    const currentOrder = collectVisibleGlobalOrder(list).join('|');
    if (currentOrder === previousOrder) return;
    await flush('settings.modulesOrderSaved');
  };

  list.addEventListener('dragstart', (event) => {
    const row = event.target.closest('[data-module-order-id]');
    if (!row) return;
    dragged = row;
    dragStartOrder = collectVisibleGlobalOrder(list).join('|');
    row.classList.add('settings-module-row--dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', row.dataset.moduleOrderId);
  });

  list.addEventListener('dragend', async () => {
    const previousOrder = dragStartOrder;
    dragged?.classList.remove('settings-module-row--dragging');
    dragged = null;
    dragStartOrder = '';
    await saveIfChanged(previousOrder);
  });

  list.addEventListener('dragover', (event) => {
    if (!dragged) return;
    const row = event.target.closest('[data-module-order-id]');
    if (!row || row === dragged) return;
    const draggedGroup = dragged.closest('[data-module-section]');
    const targetGroup = row.closest('[data-module-section]');
    if (!draggedGroup || draggedGroup !== targetGroup) return;
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    row.parentElement.insertBefore(dragged, before ? row : row.nextSibling);
  });

  list.addEventListener('drop', (event) => {
    if (!dragged) return;
    event.preventDefault();
  });

  list.addEventListener('click', async (event) => {
    if (event.target.closest('[data-kitchen-expand]')) return;
    const btn = event.target.closest('[data-module-move]');
    if (!btn || btn.disabled) return;
    const row = btn.closest('[data-module-order-id]');
    if (!row) return;
    const previousOrder = collectVisibleGlobalOrder(list).join('|');
    if (btn.dataset.moduleMove === 'up') {
      const prev = row.previousElementSibling;
      if (prev?.matches('[data-module-order-id]')) row.parentElement.insertBefore(row, prev);
    } else {
      const next = row.nextElementSibling;
      if (next?.matches('[data-module-order-id]')) row.parentElement.insertBefore(next, row);
    }
    await saveIfChanged(previousOrder);
  });

  /* AUSBLENDEN OHNE DEN FOKUS ZU VERLIEREN (Critique 2026-08-16, P1).
   *
   * Vorher rief dieser Pfad im Erfolgs- UND im Fehlerfall `render()` und baute
   * damit das ganze Blatt neu. Gemessen war der Tastaturfokus danach auf
   * `document.body`: wer drei Module ausblenden will, tabbt sich dreimal durch
   * bis zu 53 Bedienelemente zurück - bei einer Funktion, die man typischerweise
   * mehrfach hintereinander benutzt.
   *
   * Der Zustand wird deshalb in der Zeile getauscht statt neu gebaut. Der
   * Vollrender bleibt genau dort, wo er hingehört: im Fehlerfall, wo der
   * Serverstand die Wahrheit ist und der Fokus das kleinere Problem.
   */
  list.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-module-hide]');
    if (!btn || btn.disabled || busy) return;
    const wasHidden = btn.getAttribute('aria-pressed') === 'true';
    const previousMobile = readMobileSlotValues(container);

    applyHiddenState(btn, !wasHidden);
    markRowHidden(rows, btn.dataset.moduleHide, !wasHidden);
    // Der Gruppenknopf der Kueche zieht seine vier Kinder mit, sonst laese
    // collectHiddenModuleIds gleich darauf einen Zustand, den niemand gesetzt hat.
    if (btn.dataset.moduleHide === 'kitchen') {
      for (const child of list.querySelectorAll('[data-module-hide]')) {
        if (child !== btn && KITCHEN_CHILD_IDS.includes(child.dataset.moduleHide) && !child.disabled) {
          applyHiddenState(child, !wasHidden);
        }
      }
    } else if (KITCHEN_CHILD_IDS.includes(btn.dataset.moduleHide)) {
      // Umgekehrte Richtung: vier einzeln ausgeblendete Kinder SIND die
      // ausgeblendete Gruppe, und der Gruppenknopf muss das sagen.
      syncKitchenGroupState(list, rows);
    }
    // NICHT `disabled` waehrend des Speicherns: ein deaktivierter Knopf gibt den
    // Fokus ab, und genau den sollte dieser Pfad behalten (gemessen: sonst
    // landet er trotz In-place-Update auf `body`). Entprellt wird ueber eine
    // Sperre im Closure; `aria-busy` sagt der Hilfstechnik, dass gerade
    // geschrieben wird.
    busy = true;
    btn.setAttribute('aria-busy', 'true');

    // Erst die Plaetze neu aufloesen, dann speichern: was gleich in der Leiste
    // steht, ist der Wert, der mitgeschrieben werden muss.
    refreshMobileSlots(container, rows, user);
    const nextMobile = readMobileSlotValues(container);
    const mobileChanged = nextMobile.join('|') !== previousMobile.join('|');

    try {
      if (saving) { queued = true; } else {
        saving = true;
        try {
          await saveNavigationState(list, unrenderedOrderIds, mobileChanged ? nextMobile : null);
        } finally {
          saving = false;
        }
        if (queued) { queued = false; await flush('settings.modulesOrderSaved'); }
      }
      window.yuvomi?.showToast(hideToastMessage(container, previousMobile), 'success');
    } catch (error) {
      window.yuvomi?.showToast(error.message ?? t('common.errorGeneric'), 'danger');
      await render(container, { user });
    } finally {
      busy = false;
      btn.removeAttribute('aria-busy');
    }
  });
}

/* EIN AUFRÄUM-KLICK, DER DIE UNTERE LEISTE UMSCHREIBT, SAGT ES (Critique 2026-08-16, P1).
 *
 * Gemessen: wer den Kalender ausblendet, dessen drei Mobil-Plätze springen von
 * [Kalender, Aufgaben, Küche] auf [Aufgaben, Küche, Notizen] - Notizen hat
 * niemand gewählt. `resolveMobileNavOrder` füllt aus den Voreinstellungen nach,
 * sobald ein gewähltes Ziel nicht mehr zur Verfügung steht, und das ist auch
 * richtig so: eine leere Position wäre schlechter. Falsch war das Schweigen.
 *
 * WAS DIE LEISTE ZEIGT, IST WAS GESPEICHERT WIRD - und das ist eine Entscheidung,
 * keine Nachlässigkeit. Hier stand vorübergehend die Zusage, die eigene Wahl
 * überlebe das Ausblenden und kehre beim Wieder-Einblenden zurück. Sie liess
 * sich nicht halten: `resolveMobileNavOrder` VERDICHTET (module-order.js), also
 * fallen Anzeige-Platz und gespeicherter Platz auseinander, sobald ein Ziel
 * fehlt - und der Versuch, die übrigen Plätze aus dem gespeicherten Stand zu
 * ergänzen, warf beim nächsten Wechsel ein anderes, unberührtes Ziel heraus
 * (Gegenprüfung zur Review von PR #790). Drei Plätze können nicht beides:
 * einen versteckten Favoriten bewahren UND die sichtbare Anordnung speichern.
 * Für einen Haushalt ist die zweite Regel die verständlichere - man sieht, was
 * gilt. Der Toast nennt deshalb den Platz, der sich verschoben hat.
 */
function readMobileSlotValues(container) {
  return [...container.querySelectorAll('[data-mobile-nav-slot]')].map((select) => select.value);
}

function slotLabel(container, index) {
  const select = container.querySelectorAll('[data-mobile-nav-slot]')[index];
  return select?.selectedOptions?.[0]?.textContent?.trim() ?? '';
}

function hideToastMessage(container, previousMobile) {
  const current = readMobileSlotValues(container);
  const changed = current.findIndex((value, index) => value !== previousMobile[index]);
  if (changed === -1) return t('settings.modulesSaved');
  return t('settings.modulesHiddenSavedSlot', {
    position: changed + 1,
    module: slotLabel(container, changed),
  });
}

/**
 * Die drei Auswahlfelder neu aufbauen, ohne das übrige Blatt anzufassen.
 *
 * Aufgelöst wird gegen das, was gerade in den Feldern steht: die Anzeige ist
 * die Wahrheit (siehe den Block über `hideToastMessage`). Ein ausgeblendetes
 * Ziel fällt heraus, der Rest rückt nach, und der Toast sagt, welcher Platz
 * sich dadurch geändert hat.
 */
function refreshMobileSlots(container, rows, user) {
  const wrap = container.querySelector('.settings-mobile-nav-slots');
  if (!wrap) return;
  const candidates = mobileCandidateRows(rows);
  const order = resolveMobileNavOrder(readMobileSlotValues(container), candidates.map((row) => row.orderId));
  wrap.replaceChildren();
  wrap.insertAdjacentHTML('beforeend',
    [0, 1, 2].map((index) => mobileSlotHtml(candidates, order, index)).join(''));
  bindMobileNavigationEvents(container, user);
}

/** Den Zustand auch im Datenmodell nachziehen - die Mobil-Kandidaten lesen ihn. */
function markRowHidden(rows, id, hidden) {
  if (!Array.isArray(rows) || !id) return;
  for (const row of rows) {
    if (row.id === id) row.hidden = hidden;
    if (id === 'kitchen' && Array.isArray(row.children)) {
      row.children.forEach((child) => { if (child.enabled) child.hidden = hidden; });
    }
    if (Array.isArray(row.children) && row.children.some((child) => child.id === id)) {
      row.children.forEach((child) => { if (child.id === id) child.hidden = hidden; });
      row.hidden = kitchenGroupHidden(row.children);
    }
  }
}

/* ZUSTAND UMLEGEN, OHNE DAS BLATT NEU ZU BAUEN.
 *
 * `closest('.settings-module-row')` war hier falsch, und zwar genau fuer die
 * vier Kuechen-Kinder: ihre Knoepfe liegen IM aufgeklappten Feld der
 * Elternzeile, also traf `closest` die Kueche. Ein einzeln ausgeblendetes
 * Rezepte-Modul toente damit die ganze Kuechenzeile und haengte ihr den Chip an
 * - waehrend das Datenmodell korrekt sagte, die Gruppe sei noch sichtbar. Der
 * gespeicherte Wert stimmte; die Zeile behauptete etwas ueber sich, das nicht
 * galt (Review zu PR #790).
 *
 * Ein Kind traegt seine eigene Zeile (`.settings-module-kitchen__child-row`),
 * und die Gruppe rechnet ihren Zustand aus ihren Kindern - nicht aus dem Klick.
 */
function applyHiddenState(btn, hidden) {
  btn.setAttribute('aria-pressed', String(hidden));
  const childRow = btn.closest('.settings-module-kitchen__child-row');
  if (childRow) {
    childRow.classList.toggle('settings-module-kitchen__child-row--hidden', hidden);
    return;
  }

  const row = btn.closest('.settings-module-row');
  if (!row) return;
  const disabled = row.classList.contains('settings-module-row--disabled');
  row.classList.toggle('settings-module-row--hidden', hidden && !disabled);
  const title = row.querySelector('.settings-module-row__title');
  const chip = title?.querySelector('.settings-module-status--hidden');
  if (hidden && title && !chip && !disabled) {
    title.insertAdjacentHTML('beforeend',
      `<span class="settings-module-status settings-module-status--hidden">${esc(t('settings.modulesHiddenForMe'))}</span>`);
  } else if (!hidden && chip) {
    chip.remove();
  }
}

/**
 * Die Kuechenzeile aus ihren vier Kindern nachziehen.
 *
 * Die Gruppe ist kein eigener Zustand, sondern eine Aussage ueber die Kinder:
 * sie gilt als ausgeblendet, wenn kein sichtbares Kind mehr uebrig ist. Wer
 * alle vier einzeln ausblendet, hat die Gruppe ausgeblendet - der Knopf sagte
 * bis zur Review trotzdem weiter "nicht gedrueckt", und der naechste Klick
 * darauf las sich als "ausblenden", obwohl er einblendet.
 */
/**
 * Gilt die Kueche als ausgeblendet? Die eine Regel, an zwei Stellen gelesen.
 *
 * Exportiert und rein, damit sie eine Zusicherung tragen kann: `buildRows` und
 * `syncKitchenGroupState` stimmten nur ueberein, solange beide dieselbe Zeile
 * von Hand wiederholten - und die Gegenpruefung zur Review von #790 hat genau
 * an dieser Doppelung zwei Fehler gefunden.
 */
export function kitchenGroupHidden(children = []) {
  const relevant = children.filter((child) => child.enabled);
  if (!relevant.length) return false;
  return relevant.every((child) => child.hidden);
}

function syncKitchenGroupState(list, rows) {
  const groupBtn = list.querySelector('[data-module-hide="kitchen"]');
  const kitchen = rows?.find((row) => row.id === 'kitchen');
  if (!groupBtn || !kitchen) return;
  const hidden = kitchenGroupHidden(kitchen.children);
  if (groupBtn.getAttribute('aria-pressed') === String(hidden)) return;
  applyHiddenState(groupBtn, hidden);
}

function bindMobileNavigationEvents(container, user) {
  const selects = [...container.querySelectorAll('[data-mobile-nav-slot]')];
  if (!selects.length) return;

  selects.forEach((changedSelect) => {
    changedSelect.addEventListener('change', async () => {
      // Alle drei Plaetze so, wie sie dastehen. Die Anzeige ist die Wahrheit -
      // ein Wert aus dem gespeicherten Stand daneben zu mischen, verschob beim
      // Verdichten ein unberuehrtes Ziel (Gegenpruefung zur Review von #790).
      const payload = buildMobileNavigationPayload(selects.map((select) => select.value));
      selects.forEach((select) => { select.disabled = true; });

      try {
        const response = await savePreferences(payload);
        const savedOrder = response?.data?.mobile_nav_order ?? payload.mobile_nav_order;
        window.yuvomi?.setMobileNavOrder?.(savedOrder);
        window.yuvomi?.showToast(t('settings.mobileNavigationSaved'), 'success');
        await render(container, { user });
      } catch (error) {
        selects.forEach((select) => { select.disabled = false; });
        window.yuvomi?.showToast(error.message ?? t('common.errorGeneric'), 'danger');
      }
    });
  });
}

export async function render(container, { user }) {
  const isAdmin = user?.role === 'admin';
  const [preferencesResult, modulesResult] = await Promise.allSettled([
    getPreferences(),
    isAdmin ? api.get('/modules?admin=1') : Promise.resolve({ data: [] }),
  ]);

  /* OHNE PRAEFERENZEN WIRD HIER NICHT GERENDERT (Codex-Review zu PR #790).
   *
   * Vorher fuhr dieses Blatt bei einem gescheiterten `GET /preferences` mit
   * `{}` fort: jeder Ausblenden-Knopf stand auf "nicht gedrueckt", die
   * Reihenfolge kam aus den Voreinstellungen. Erholte sich die Verbindung, bevor
   * jemand klickte, schrieb der erste Klick genau diesen erfundenen Zustand als
   * Wahrheit zurueck - und loeschte damit die uebrigen Ausblendungen und die
   * gespeicherte Reihenfolge. Ein Blatt, das seinen Ausgangszustand nicht kennt,
   * darf ihn nicht speichern; es bietet einen zweiten Versuch an.
   *
   * Die Drittanbieter-Liste ist der andere Fall und bleibt tolerant: fehlt sie,
   * fehlen ein paar Zeilen, aber nichts wird falsch geschrieben - ihre Ids
   * ueberleben ueber `unrenderedOrderIds`. */
  if (preferencesResult.status !== 'fulfilled' || !preferencesResult.value) {
    container.replaceChildren();
    container.appendChild(createRetryState({
      message: preferencesResult.reason?.message ?? t('common.errorGeneric'),
      onRetry: () => render(container, { user }),
    }));
    return;
  }
  // getPreferences() liefert bereits das entpackte Preferences-Objekt (kein
  // `{ data }`-Envelope wie api.get). Ein zusätzliches `?.data` machte
  // `preferences` dauerhaft leer: disabled_modules war nie gesetzt, jeder
  // Re-Render nach einem Toggle hakte die Checkbox wieder an (#615).
  const preferences = preferencesResult.value;
  const thirdPartyModules = modulesResult.status === 'fulfilled' ? (modulesResult.value?.data ?? []) : [];

  const rows = buildRows(preferences, thirdPartyModules);
  /* Was in der gespeicherten Reihenfolge steht, hier aber keine Zeile hat.
   * Fuer ein Mitglied sind das seine Drittanbieter-Module: `/modules?admin=1`
   * beantwortet ihm der Server nicht, also kennt dieses Blatt sie nicht - und
   * duerfte sie deshalb erst recht nicht aus seiner Reihenfolge streichen. */
  const renderedOrderIds = new Set(expandModuleOrder(rows.map((row) => row.orderId)));
  const unrenderedOrderIds = (Array.isArray(preferences.module_order) ? preferences.module_order : [])
    .filter((id) => !renderedOrderIds.has(id));
  const availableMobileIds = mobileCandidateRows(rows).map((row) => row.orderId);
  const mobileOrder = resolveMobileNavOrder(preferences.mobile_nav_order, availableMobileIds);
  renderPage(container, rows, mobileOrder);
  bindDisclosure(container, { triggerSelector: '[data-kitchen-expand]', panelSelector: '[data-kitchen-children]', id: 'kitchen-children-navigation' });
  bindModuleListEvents(container, user, rows, unrenderedOrderIds);
  bindMobileNavigationEvents(container, user);
}
