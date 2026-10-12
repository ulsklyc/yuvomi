import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { confirmModal, refocusAfterRender } from '/components/modal.js';
import { rowMenuHtml } from '/utils/row-action.js';
import { installPopoverMenus } from '/utils/popover-menu.js';
import { emptyStateEl } from '/utils/empty-state.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import {
  bindDisclosure,
  createDisclosure,
  createInfoList,
  thirdPartyStatusLabel,
  toggleRowHtml,
} from '/settings/components.js';
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
import { deleteErrorText, installErrorText } from '/settings/module-install-errors.js';

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
 *
 * EIN DRITTMODUL WIRD HIER GEPRUEFT, BEVOR ES ANGEHT. Seit Module aus den
 * Einstellungen installiert werden (modules-install.js), kommen sie
 * ausgeschaltet an; ihre Zeile traegt deshalb Details (Kennung, Version,
 * Quelle, Installationszeitpunkt, wer installiert hat, Ordner) und - nur bei
 * einem Modul, das die Oberflaeche selbst installiert hat, und nur solange
 * der Server das Loeschen auch annimmt - einen Loeschen-Knopf. Einen von Hand
 * kopierten Ordner loescht der Server nicht (Review zu PR #1671: er kann ein
 * Checkout mit offener Arbeit sein), und mit ausgeschaltetem
 * MODULES_ALLOW_WEB_INSTALL lehnt er jedes Loeschen ab (deleteOffered).
 */

const INSTALL_MODULE_PATH = '/settings/modules/install';

// Dieselbe Regel wie MODULE_ID_RE in server/services/module-capabilities.js.
// Ein Ordner, dessen Name keine gueltige Kennung ist, erscheint als Fehlerzeile
// unter seinem Ordnernamen - und den lehnt DELETE als `bad_id` ab. Ein Knopf,
// der nur scheitern kann, wird gar nicht erst angeboten.
const DELETABLE_MODULE_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Ob die Kennung eine ist, die DELETE ueberhaupt annimmt (sonst 400 bad_id). */
export function isDeletableModuleId(id) {
  return typeof id === 'string' && DELETABLE_MODULE_ID_RE.test(id);
}

/** Ob ein Modul einen Installationsdatensatz (`.yuvomi-install.json`) traegt. */
function hasInstallRecord(module) {
  return Boolean(module?.install) && typeof module.install === 'object';
}

/**
 * Ob ein Drittmodul von sich aus loeschbar ist: eine gueltige Kennung UND ein
 * Installationsdatensatz. Die Oberflaeche loescht nur, was sie selbst
 * installiert hat; einen von Hand kopierten Ordner lehnt DELETE mit 409
 * `not_web_installed` ab (seit Review Runde 4 auch jedes Ersetzen ueber die
 * Install-Routen), und einen Knopf, der nur scheitern kann, gibt es nicht.
 * Die Details sagen stattdessen "Auf den Server kopiert". Ob der Server das
 * Loeschen gerade ueberhaupt annimmt, entscheidet dazu deleteOffered().
 */
export function isDeletableModule(module) {
  return isDeletableModuleId(module?.id) && hasInstallRecord(module);
}

/**
 * Ob der Server ein Loeschen aus den Einstellungen gerade annimmt - aus
 * GET /modules/install/info, derselben Antwort, nach der das Install-Blatt
 * seine Knoepfe richtet (Review Runde 4 zu PR #1671): mit nicht gesetztem
 * MODULES_ALLOW_WEB_INSTALL (`webInstall: false`, der Normalfall, und der
 * Zustand, nachdem ein Betreiber den Schalter wieder zurueckgenommen hat)
 * endet jeder Klick in 403 `module_web_install_disabled`, bei einem
 * schreibgeschuetzten Ordner (`writable: false`) in 503. Nur ein sicheres
 * `webInstall: true` zaehlt; eine fehlende oder gescheiterte Antwort (`null`,
 * aelterer Server) heisst "unbekannt" und damit: kein Knopf. `persistent`
 * spielt hier keine Rolle - loeschen geht auch im Container-Layer.
 */
export function deleteOffered(info) {
  return info?.webInstall === true && info?.writable !== false;
}

/**
 * Zeilen in derselben Reihenfolge und Gruppierung wie die Navigation - nur
 * ohne Sortierung. `info` ist die Antwort von GET /modules/install/info oder
 * null.
 */
function buildRows(preferences, thirdPartyModules, info) {
  const disabled = new Set(Array.isArray(preferences.disabled_modules) ? preferences.disabled_modules : []);
  const offerDelete = deleteOffered(info);
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
      deletable: offerDelete && isDeletableModule(module),
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

  // Loeschen gibt es nur fuer Drittmodule, die von hier aus installiert wurden
  // (isDeletableModule), und nur solange der Server es annimmt
  // (deleteOffered): eingebaute sind Teil der App, von Hand kopierte gehoeren
  // dem Server.
  // EIN MEHR-KNOPF (Komponenten-Kanon, row-danger-visible): Loeschen ist ein
  // Eintrag mit Wort hinter dem Mehr-Knopf der Zeile, kein sichtbarer
  // Papierkorb - wie Geburtstage. Der Eintrag traegt dieselben Attribute wie
  // vorher der Knopf; der delegierte Handler in bindEvents bleibt.
  const deletable = row.type === 'third-party' && row.deletable === true;
  const rowMenu = deletable ? `
      <div class="row-actions settings-module-row__actions">
        ${rowMenuHtml({
    id: moduleMenuId(row.id),
    label: t('common.moreActionsNamed', { name: row.label }),
    items: [
      {
        action: 'delete-module',
        icon: 'trash-2',
        label: t('common.delete'),
        danger: true,
        attrs: { 'data-module-delete': row.id, 'data-module-name': row.label },
      },
    ],
  })}
      </div>` : '';
  const menuClass = deletable ? ' settings-module-row--menu' : '';

  return `
    <div class="settings-module-row settings-module-row--fixed${menuClass} ${stateClass}${row.hasError ? ' settings-module-row--error' : ''}" data-module-row-id="${esc(row.id)}">
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
      ${rowMenu}
    </div>
  `;
}

function installedAtText(install) {
  const date = install?.installedAt ? new Date(install.installedAt) : null;
  if (!date || Number.isNaN(date.getTime())) return t('settings.moduleDetailUnknown');
  return `${formatDate(date)} ${formatTime(date)}`.trim();
}

/**
 * Wer installiert hat - die Spur, die eine Logrotation ueberlebt (Review zu
 * PR #1671). Der Datensatz traegt die Nutzer-Id; der Server loest sie in der
 * Admin-Liste zu `installedByName` auf: ein Name, `null` fuer ein geloeschtes
 * Konto ("Ein ehemaliges Mitglied"). Fehlt das Feld ganz (aelterer Server,
 * kein Datensatz), gibt es keine Zeile.
 * @returns {string|null}
 */
export function installedByText(install) {
  if (!install || typeof install !== 'object' || install.installedByName === undefined) return null;
  if (install.installedByName === null) return t('settings.moduleDetailFormerMember');
  const name = String(install.installedByName).trim();
  return name || t('settings.moduleDetailFormerMember');
}

/** Woher ein Drittmodul kommt: GitHub-Adresse, ZIP-Upload oder von Hand kopiert. */
export function moduleSourceText(install) {
  if (!install || typeof install !== 'object') return t('settings.moduleSourceManual');
  if (install.source === 'github') {
    const url = String(install.url || '').trim();
    const ref = String(install.ref || '').trim();
    if (!url) return 'GitHub';
    return t('settings.moduleSourceGithub', { url: ref ? `${url} @ ${ref}` : url });
  }
  if (install.source === 'zip') return t('settings.moduleSourceZip');
  return t('settings.moduleSourceManual');
}

/**
 * Die Details einer Drittmodul-Zeile, aufklappbar unter ihrer Titelzeile.
 *
 * Ein eigenes Kind der Zeile, nicht Teil des Textblocks: im Textblock bekam das
 * Feld auf dem Telefon nur dessen Spalte (gemessen 127px bei 375px Breite),
 * Werte wurden abgeschnitten, und die Zeile wuchs um rund 700px, waehrend
 * Schalter und Loeschen-Knopf auf halber Hoehe schwebten. Als eigene Rasterzeile
 * (settings.css, `.settings-module-row__details`) nimmt es die Breite unter dem
 * Titel, und die Bedienelemente bleiben neben dem Titel. In der DOM-Reihenfolge
 * steht es damit auch hinter Schalter und Knopf - wie auf dem Bildschirm.
 */
function moduleDetailsElement(module) {
  const install = module.install && typeof module.install === 'object' ? module.install : null;
  const installedBy = installedByText(install);
  const content = createInfoList([
    { label: t('settings.moduleDetailId'), value: module.id, code: true },
    { label: t('settings.moduleDetailVersion'), value: module.version || t('settings.moduleDetailUnknown') },
    module.description ? { label: t('settings.moduleDetailDescription'), value: module.description } : null,
    { label: t('settings.moduleDetailSource'), value: moduleSourceText(install) },
    install ? { label: t('settings.moduleDetailInstalledAt'), value: installedAtText(install) } : null,
    installedBy ? { label: t('settings.moduleDetailInstalledBy'), value: installedBy } : null,
    { label: t('settings.moduleDetailFolder'), value: `modules/${module.id}`, code: true },
    // Kein Fehler-Eintrag hier: die Zeile selbst zeigt ihn schon als Alert, und
    // ein zweites Mal im aufgeklappten Detail las ein Screenreader ihn doppelt.
  ]);
  const disclosure = createDisclosure({
    id: `module-details-${String(module.id).replace(/[^\w-]/g, '_')}`,
    summary: t('settings.moduleDetailsToggle'),
    content,
  });
  disclosure.classList.add('settings-module-row__details');
  return disclosure;
}

/**
 * Noch kein Drittmodul: statt einer fehlenden Gruppe ein Hinweis mit dem Weg
 * zum Installieren. Kompakt und ohne eigene Ueberschrift - die Gruppe nennt den
 * Zusammenhang schon ("Eigene Module").
 */
function emptyCustomModulesElement() {
  const section = document.createElement('section');
  section.className = 'settings-navigation-group';
  section.dataset.moduleSection = String(NAV_SECTION.customModules);
  const title = document.createElement('h3');
  title.className = 'settings-navigation-group__title';
  title.textContent = t(NAV_SECTION_LABEL_KEYS[NAV_SECTION.customModules]);
  section.append(title, emptyStateEl({
    compact: true,
    description: t('settings.installModuleEmptyHint'),
    action: {
      label: t('settings.pageInstallModule'),
      icon: 'package-plus',
      tone: 'secondary',
      onClick: () => {
        if (window.yuvomi?.navigate) window.yuvomi.navigate(INSTALL_MODULE_PATH);
        else window.location.assign(INSTALL_MODULE_PATH);
      },
    },
  }));
  return section;
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
  // Mehr-Knopf der Zeile: Position, Esc, Pfeiltasten, Schliessen beim Klick.
  // Die Wurzel ueberlebt den Neuaufbau; installPopoverMenus ist idempotent.
  installPopoverMenus(container);

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
      // Einschalten kann mit einem `reason` scheitern, den die Install-Saetze
      // schon kennen (Review Runde 4 zu PR #1671): 409 `busy`, solange eine
      // Installation oder ein Loeschen laeuft (die Freigabe nimmt dieselbe
      // Sperre), 503 `not_writable`, wenn der Datensatz im Modulordner nicht
      // geschrieben werden kann, 403 `module_session_required` fuer ein Token.
      // Ohne reason bleibt es beim Servertext.
      window.yuvomi?.showToast(error?.data?.reason ? installErrorText(error) : (error?.message ?? t('common.errorGeneric')), 'danger');
    }
  });

  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-module-delete]');
    if (!button) return;
    deleteThirdPartyModule(container, user, button);
  });
}

/**
 * Wohin der Fokus nach dem Loeschen geht. Die Zeile samt Knopf ist weg, und der
 * allgemeine Rueckfall (`refocusAfterRender()`) kennt nur die Seitenwurzel - von
 * dort muesste man sich durch das ganze Blatt zurueckarbeiten. Also explizit:
 * der Mehr-Knopf der naechsten loeschbaren Drittmodul-Zeile (sonst der
 * vorigen) - der Eintrag selbst steht im geschlossenen Menue und nimmt keinen
 * Fokus an -, und war es das letzte, die Ueberschrift der Gruppe "Eigene Module".
 */
export function focusAfterModuleDelete(container, neighbourIds) {
  for (const id of neighbourIds) {
    const target = container.querySelector(`[popovertarget="${moduleMenuId(id)}"]`);
    if (target) {
      target.focus();
      return target;
    }
  }
  const heading = container.querySelector(`[data-module-section="${NAV_SECTION.customModules}"] h3`);
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }
  return heading;
}

/** Panel-ID des Zeilenmenues; die Kennung ist geprueft (isDeletableModuleId). */
function moduleMenuId(id) {
  return `module-menu-${id}`;
}

/** Die Drittmodule neben `id`, in der Reihenfolge, in der der Fokus sie versucht. */
function deleteNeighbours(container, id) {
  const ids = [...container.querySelectorAll('[data-module-delete]')].map((el) => el.dataset.moduleDelete);
  const at = ids.indexOf(id);
  if (at < 0) return [];
  return [...ids.slice(at + 1, at + 2), ...ids.slice(Math.max(0, at - 1), at)];
}

/**
 * Ein Drittmodul loeschen: Rueckfrage, DELETE, Katalog neu laden, Blatt neu bauen.
 *
 * `data-busy` haelt einen zweiten Klick auf denselben Knopf fern, solange der
 * erste laeuft (Doppelklick, Enter-Wiederholung): sonst stuenden zwei
 * Rueckfragen uebereinander, und die zweite schickte ein DELETE fuer ein
 * Modul, das es nicht mehr gibt. Kein `disabled`: ein deaktivierter Knopf nimmt
 * den Fokus nicht an, den die Rueckfrage beim Abbrechen zurueckgibt.
 */
async function deleteThirdPartyModule(container, user, button) {
  if (button.dataset.busy === 'true') return;
  button.dataset.busy = 'true';
  button.setAttribute('aria-disabled', 'true');
  const release = () => {
    delete button.dataset.busy;
    button.removeAttribute('aria-disabled');
  };
  const id = button.dataset.moduleDelete;
  const name = button.dataset.moduleName || id;
  const neighbours = deleteNeighbours(container, id);
  const ok = await confirmModal(t('settings.moduleDeleteConfirm', { name }), {
    danger: true,
    confirmLabel: t('common.delete'),
    detail: t('settings.moduleDeleteDetail', { id }),
  });
  if (!ok) {
    release();
    return;
  }
  try {
    await api.delete(`/modules/${encodeURIComponent(id)}`);
  } catch (error) {
    release();
    // Dieselbe Abbildung wie beim Installieren, bis auf den Satz zu
    // not_web_installed: not_found, not_a_module, not_web_installed,
    // module_session_required und module_web_install_disabled sagen dem Admin
    // etwas, der Servertext nur auf Englisch.
    window.yuvomi?.showToast(error?.data?.reason ? deleteErrorText(error) : (error?.message || t('common.errorGeneric')), 'danger');
    return;
  }
  try {
    await window.yuvomi?.refreshThirdPartyModules?.();
  } catch (error) {
    console.warn('[Settings] Module catalog refresh failed:', error);
  }
  // Der Neuaufbau ersetzt den Knopf; seine Sperre geht mit ihm.
  await renderActiveModules(container, user);
  // Erst das eigene Ziel: der Nachbar ist naeher als alles, was der allgemeine
  // Rueckfall kennt. Danach refocusAfterRender() als Netz - es tut nichts,
  // solange der Fokus sitzt, und faengt nur den Fall, dass er doch auf <body>
  // gelandet ist (keine Ueberschrift, weil das Laden scheiterte).
  focusAfterModuleDelete(container, neighbours);
  refocusAfterRender();
  window.yuvomi?.showToast(t('settings.moduleDeleted', { name }), 'success');
}

export async function render(container, { user }) {
  await renderActiveModules(container, user);
}

async function renderActiveModules(container, user) {
  container.replaceChildren();

  let preferences = {};
  let thirdPartyModules = [];
  // Die Antwort von GET /modules/install/info (Admin-Route, Admin-Blatt) oder
  // null: sie entscheidet, ob Loeschen-Knoepfe stehen (deleteOffered). Ein
  // Fehler dort ist kein Ladefehler des Blatts - nur kein Knopf.
  let installInfo = null;
  // Der Leerzustand "noch kein eigenes Modul" nur nach einer ERFOLGREICHEN,
  // leeren Antwort - ein Ladefehler ist kein leerer Bestand (utils/empty-state.js).
  let modulesLoaded = false;
  try {
    const [prefs, modules, info] = await Promise.all([
      getPreferences(),
      api.get('/modules?admin=1').then((res) => res?.data ?? []).catch(() => null),
      api.get('/modules/install/info').then((res) => res?.data ?? null).catch(() => null),
    ]);
    preferences = prefs ?? {};
    modulesLoaded = Array.isArray(modules);
    thirdPartyModules = modulesLoaded ? modules : [];
    installInfo = info;
  } catch (error) {
    container.insertAdjacentHTML('beforeend',
      `<p class="form-error" role="alert">${esc(error.message ?? t('common.errorGeneric'))}</p>`);
    return;
  }

  const rows = buildRows(preferences, thirdPartyModules, installInfo);

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

  const groups = container.querySelector('#module-toggles');
  for (const module of thirdPartyModules) {
    const row = [...(groups?.querySelectorAll('[data-module-row-id]') ?? [])]
      .find((el) => el.dataset.moduleRowId === module.id);
    row?.appendChild(moduleDetailsElement(module));
  }
  if (modulesLoaded && !thirdPartyModules.length) groups?.appendChild(emptyCustomModulesElement());

  bindDisclosure(container, { triggerSelector: '[data-kitchen-expand]', panelSelector: '[data-kitchen-children]', id: 'kitchen-children-active' });
  bindEvents(container, user);
  window.lucide?.createIcons({ el: container });
}
