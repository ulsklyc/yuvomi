import { api, auth } from '/api.js';
import {
  formatDate,
  isDateInputValid,
  parseDateInput,
  t,
} from '/i18n.js';
import { esc } from '/utils/html.js';
import { initials } from '/utils/initials.js';
import { prefersInkText } from '/utils/contrast.js';
import { AVATAR_COLORS } from '/utils/color.js';
import { sortMembers } from '/utils/member-order.js';
import { makeSortable } from '/utils/sortable.js';
import { vibrate } from '/utils/ux.js';
import { openModal, closeModal, confirmModal, refocusAfterRender } from '/components/modal.js';
import { createRetryState, toggleRowHtml } from '/settings/components.js';
import {
  renderUserMultiSelect, getSelectedUserIds, bindUserMultiSelect,
} from '/components/user-multi-select.js';

const FAMILY_ROLES = ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'];

const randomAvatarColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

/**
 * Ist auf diesem Server SSO konfiguriert? (#847)
 *
 * Entscheidet, ob die Verwaltung ueberhaupt anbietet, ein Konto ohne Passwort
 * zu fuehren - ohne SSO waere das ein Konto, in das niemand hineinkaeme, und
 * der Server weist es aus demselben Grund ab. Eine Modulvariable statt eines
 * vierten Parameters durch renderPage/bindEvents/bindEditButtons: es ist eine
 * Eigenschaft des Servers, die sich waehrend eines Seitenaufrufs nicht aendert,
 * und keine Angabe zu einem einzelnen Mitglied.
 */
let ssoAvailable = false;

/**
 * Rechte-Katalog fuer die Startrechte einer Einladung (#869).
 *
 * Modulvariable aus demselben Grund wie `ssoAvailable`: eine Eigenschaft des
 * Servers, keine eines Mitglieds. Bleibt sie leer, weil die Abfrage
 * fehlschlaegt, verliert der Hinweis unter dem Feld seine Modulnamen - die
 * Wahl selbst funktioniert weiter, denn aufgeloest wird sie ohnehin
 * serverseitig.
 */
let permissionCatalog = null;

/** Angezeigter Name eines Permissions-Moduls, sonst der Schluessel als Notnagel. */
function moduleLabel(key) {
  const found = permissionCatalog?.modules?.find((m) => m.key === key);
  return found ? t(found.labelKey) : key;
}

/** Die Module, die eine Rechte-Karte ganz sperrt, als lesbare Aufzaehlung. */
function deniedModuleNames(modules) {
  return Object.entries(modules || {})
    .filter(([, access]) => access === 'none')
    .map(([key]) => moduleLabel(key))
    .sort((a, b) => a.localeCompare(b));
}

/** Lesbarer effektiver Zustand einer Capability in einer Einladungs-Vorlage. */
function capabilityStateText(key, profile = null, moduleBlocked = false) {
  const item = permissionCatalog?.capabilities?.find((entry) => entry.key === key);
  if (!item) return '';
  const access = moduleBlocked
    ? 'none'
    : (profile?.capabilities?.[key] ?? item.default ?? permissionCatalog?.defaults?.capability ?? 'none');
  return `${t(item.labelKey)}: ${t(access === 'allow' ? 'settings.permCapabilityAllowed' : 'settings.permCapabilityBlocked')}`;
}

function appendCapabilityState(text, state) {
  return state ? `${text} · ${state}` : text;
}

function familyRoleLabel(role) {
  return t(`settings.familyRole${String(role || 'other').replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())}`);
}

function buildFamilyRoleOptions(selected = 'other') {
  return FAMILY_ROLES.map((role) => `
    <option value="${role}"${role === selected ? ' selected' : ''}>${familyRoleLabel(role)}</option>
  `).join('');
}

function showError(element, message) {
  if (!element) return;
  element.textContent = message || t('common.errorGeneric');
  element.hidden = false;
}

function clearError(element) {
  if (!element) return;
  element.textContent = '';
  element.hidden = true;
}

function avatarHtml(user, className = 'settings-avatar') {
  const safeName = esc(user?.display_name || '');
  const fallback = esc(initials(user?.display_name, '?'));
  const background = esc(user?.avatar_color) || 'var(--color-accent)';
  // Die Farbe waehlt das Mitglied selbst; auf hellen Toenen lagen die weissen
  // Initialen bei 3,5:1 und 2,8:1 (Critique 2026-07-27).
  const inkClass = prefersInkText(user?.avatar_color) ? ' settings-avatar--ink' : '';
  return `
    <div class="${className}${inkClass}" style="background:${background}" title="${safeName}">
      ${user?.avatar_data ? `<img src="${esc(user.avatar_data)}" alt="${safeName}" loading="lazy">` : fallback}
    </div>
  `;
}

function avatarEditorHtml(user, prefix) {
  return `
    <div class="settings-avatar-editor">
      <button type="button" class="settings-avatar-button" id="${prefix}-avatar-preview" aria-label="${t('settings.profilePictureLabel')}">
        ${avatarHtml(user, 'settings-avatar settings-avatar--lg')}
      </button>
      <input class="sr-only" type="file" id="${prefix}-avatar-file" accept="image/png,image/jpeg,image/webp"
        aria-label="${t('settings.profilePictureLabel')}" tabindex="-1" />
      <div class="settings-avatar-actions">
        <button type="button" class="settings-avatar-action" id="${prefix}-avatar-edit" aria-label="${t('settings.profilePictureLabel')}" title="${t('settings.profilePictureLabel')}">
          <i data-lucide="edit-2" aria-hidden="true"></i>
        </button>
        <button type="button" class="settings-avatar-action settings-avatar-action--danger" id="${prefix}-avatar-remove" aria-label="${t('settings.profilePictureRemove')}" title="${t('settings.profilePictureRemove')}">
          <i data-lucide="trash-2" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `;
}

function setAvatarPreview(container, selector, user) {
  const preview = container.querySelector(selector);
  if (!preview) return;
  preview.replaceChildren();
  preview.insertAdjacentHTML('beforeend', avatarHtml(user, 'settings-avatar settings-avatar--lg'));
  window.lucide?.createIcons({ el: preview });
}

function bindAvatarPicker(container, prefix) {
  const fileInput = container.querySelector(`#${prefix}-avatar-file`);
  [
    container.querySelector(`#${prefix}-avatar-preview`),
    container.querySelector(`#${prefix}-avatar-edit`),
  ].forEach((picker) => {
    picker?.addEventListener('click', () => fileInput?.click());
  });
}

function memberHtml(u, currentUserId, { orderable = false, aligned = false } = {}) {
  // Der Griff der Haushaltsreihenfolge (#1644). Ein BUTTON wie in der
  // Einkaufsliste: er traegt den Tastaturpfad selbst (Pfeiltasten bei Fokus),
  // statt ein Auf/Ab-Paar neben Bearbeiten und Entfernen zu stellen. Nur an
  // Zeilen, die eine Position haben koennen - Hauspersonal, Gaeste und
  // Ehemalige stehen in dieser Verwaltung, aber nicht in der Reihenfolge.
  const handle = orderable ? `
      <button type="button" class="row-action settings-member__drag" data-member-handle="${u.id}"
              aria-label="${esc(t('shopping.reorderHandle', { name: u.display_name }))}"
              title="${esc(t('shopping.reorderHandleHint'))}">
        <i data-lucide="grip-vertical" class="icon-md" aria-hidden="true"></i>
      </button>`
    // Eine Zeile ohne Position (Personal, Gast, ehemalig) haelt den Platz des
    // Griffs frei, solange die Liste Griffe zeigt - sonst stuende ihr Avatar
    // links neben der Flucht der anderen. Ein leerer Platz, kein toter Knopf.
    : aligned ? `
      <span class="row-action settings-member__drag settings-member__drag--none" aria-hidden="true">
        <i data-lucide="grip-vertical" class="icon-md"></i>
      </span>` : '';
  // Konten der Haushaltshilfe sind keine Familienmitglieder: sie tragen das
  // Label ihrer Rolle statt einer Familienrolle (Audit A2-25e). Ein eigener
  // Schluessel: der Reiter im Modul nennt die Mehrzahl, der Ersatz fuer einen
  // fehlenden Namen ist kein Rollenname (#1723).
  const familyRole = u.is_worker ? t('housekeeping.workerRole') : familyRoleLabel(u.family_role);
  const systemRole = u.role === 'admin' ? ` · ${esc(t('settings.systemAdminBadge'))}` : '';
  // Ein ehemaliges Konto (#1381): die Zeile bleibt, damit sichtbar ist, wen
  // die Verwaltung deaktiviert hat - Eintraege nennen die Person weiter.
  // Bearbeiten laesst sich so ein Konto hier nicht mehr; entfernen schon, das
  // loescht es, sobald nichts Geteiltes mehr auf es zeigt.
  const former = Boolean(u.deactivated_at);
  const formerBadge = former ? ` · ${esc(t('settings.memberFormerBadge'))}` : '';
  const profileMeta = [
    u.phone ? t('settings.memberPhoneMeta', { value: u.phone }) : '',
    u.email || '',
    u.birth_date ? t('settings.memberBirthdayMeta', { date: formatDate(u.birth_date) }) : '',
  ].filter(Boolean).map(esc).join(' · ');
  // Row-Action-Grammatik statt dauerhaft rotem Outline-Button: Löschen wird
  // erst bei Hover/Fokus laut. Der eigene Account bekommt keine Lösch-Aktion
  // in der Mitgliederliste (Audit A2-25d).
  const deleteBtn = u.id === currentUserId ? '' : `
      <button class="row-action row-action--danger" data-delete-user="${u.id}" data-name="${esc(u.display_name)}" aria-label="${esc(t('settings.removeMemberNamed', { name: u.display_name }))}" title="${esc(t('settings.removeMemberLabel'))}">
        <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
      </button>`;
  const editBtn = former ? '' : `
      <button class="row-action" data-edit-user="${u.id}" aria-label="${esc(t('common.editNamed', { name: u.display_name }))}" title="${t('settings.editMemberLabel')}">
        <i data-lucide="edit-2" class="icon-md" aria-hidden="true"></i>
      </button>`;
  return `
    <li class="settings-member${former ? ' settings-member--former' : ''}${orderable ? ' settings-member--orderable' : ''}" data-id="${u.id}">${handle}
      ${avatarHtml(u, 'settings-avatar settings-avatar--sm')}
      <div class="settings-member__info">
        <span class="settings-member__name" data-member-name>${esc(u.display_name)}</span>
        <span class="settings-member__meta">@${esc(u.username)} · ${esc(familyRole)}${systemRole}${formerBadge}</span>
        ${profileMeta ? `<span class="settings-member__meta">${profileMeta}</span>` : ''}
      </div>${editBtn}${deleteBtn}
    </li>
  `;
}

/* FAMILIE SPRICHT DEN KANON (R14, A7 P2-4). "Mitglied hinzufuegen" und
 * "Einladung erstellen" oeffneten 850px Inline-Formular unter der Liste, mit
 * [Erstellen][Abbrechen] - die einzige Stelle der App mit der Primaeraktion
 * links. Jetzt ist es ein Blatt-Dialog wie jedes Anlegen, Fuss
 * [Abbrechen][Primaer] (`.modal-panel__footer`, von mountFooter an den
 * Blattrand gehoben), und der Fokus kehrt beim Schliessen von selbst zum
 * Knopf zurueck (modal.js). Der Knopf selbst ist kein violetter Balken ueber
 * die volle Breite mehr, sondern ein ruhiger Knopf unter der Liste. */
function addMemberFormHtml() {
  return `
        <form id="add-member-form" class="settings-form">
          <div class="form-group">
            <label class="form-label" for="new-username">${t('settings.usernameLabel')}</label>
            <input class="form-input" type="text" id="new-username" required autocomplete="off" />
          </div>
          <div class="settings-name-color-row">
            <div class="form-group settings-name-color-row__name">
              <label class="form-label" for="new-display-name">${t('settings.displayNameLabel')}</label>
              <input class="form-input" type="text" id="new-display-name" required />
            </div>
            <div class="form-group settings-color-field">
              <label class="form-label" for="new-avatar-color">${t('settings.colorLabel')}</label>
              <input class="settings-color-button" type="color" id="new-avatar-color" value="${randomAvatarColor()}" />
            </div>
          </div>
          ${ssoAvailable ? `
          ${toggleRowHtml({
            control: 'switch',
            label: t('settings.memberSsoOnlyLabel'),
            attrs: { id: 'new-member-sso-only' },
          })}
          <p class="form-hint">${t('settings.memberSsoOnlyHint')}</p>
          ` : ''}
          <div class="form-group" id="new-member-password-group">
            <label class="form-label" for="new-member-password">${t('settings.memberPasswordLabel')}</label>
            <input class="form-input" type="password" id="new-member-password" minlength="8" required autocomplete="new-password" />
          </div>
          <div class="form-group">
            <label class="form-label" for="new-family-role">${t('settings.familyRoleLabel')}</label>
            <select class="form-input" id="new-family-role">
              ${buildFamilyRoleOptions()}
            </select>
          </div>
          <div class="modal-grid modal-grid--2">
            <div class="form-group">
              <label class="form-label" for="new-member-phone">${t('settings.memberPhoneLabel')}</label>
              <input class="form-input" type="tel" id="new-member-phone" autocomplete="tel" />
            </div>
            <div class="form-group">
              <label class="form-label" for="new-member-email">${t('settings.memberEmailLabel')}</label>
              <input class="form-input" type="email" id="new-member-email" autocomplete="email" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="new-member-birth-date">${t('settings.memberBirthDateLabel')}</label>
            <yuvomi-datepicker type="date" id="new-member-birth-date"></yuvomi-datepicker>
            <p class="form-hint">${t('settings.memberContactBirthdayHint')}</p>
          </div>
          ${toggleRowHtml({
            control: 'switch',
            label: t('settings.systemAdminLabel'),
            attrs: { id: 'new-system-admin' },
          })}
          <p class="form-hint">${t('settings.systemAdminHint')}</p>
          <div id="member-error" class="form-error" role="alert" hidden></div>
          <div class="modal-panel__footer modal-panel__footer--plain">
            <button type="button" class="btn btn--secondary" id="cancel-add-member">${t('settings.cancelAddMember')}</button>
            <button type="submit" class="btn btn--primary">${t('settings.createMember')}</button>
          </div>
        </form>`;
}

function addInviteFormHtml() {
  return `
        <form id="add-invite-form" class="settings-form">
          <div class="form-group">
            <label class="form-label" for="invite-username">${t('settings.usernameLabel')}</label>
            <input class="form-input" type="text" id="invite-username" autocomplete="off" />
            <p class="form-hint">${t('settings.invites.usernameHint')}</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="invite-display-name">${t('settings.displayNameLabel')}</label>
            <input class="form-input" type="text" id="invite-display-name" maxlength="128" />
          </div>
          <div class="form-group">
            <label class="form-label" for="invite-family-role">${t('settings.familyRoleLabel')}</label>
            <select class="form-input" id="invite-family-role">
              ${buildFamilyRoleOptions()}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="invite-permission-preset">${t('settings.invites.presetLabel')}</label>
            <select class="form-input" id="invite-permission-preset">
              <option value="restricted" selected>${t('settings.invites.presetRestricted')}</option>
              <option value="role">${t('settings.invites.presetRole')}</option>
            </select>
            <p class="form-hint" id="invite-preset-hint"></p>
          </div>
          <div class="form-group">
            <label class="form-label" for="invite-email">${t('settings.memberEmailLabel')}</label>
            <input class="form-input" type="email" id="invite-email" autocomplete="email" />
          </div>
          ${toggleRowHtml({
            control: 'switch',
            label: t('settings.invites.sendEmail'),
            attrs: { id: 'invite-send-email' },
          })}
          ${toggleRowHtml({
            control: 'switch',
            label: t('settings.systemAdminLabel'),
            attrs: { id: 'invite-system-admin' },
          })}
          <p class="form-hint">${t('settings.systemAdminHint')}</p>
          <div id="invite-error" class="form-error" role="alert" hidden></div>
        </form>
        <div id="invite-link-output" class="settings-token-output" hidden>
          <label class="form-label" for="invite-link-value">${t('settings.invites.linkTitle')}</label>
          <div class="settings-token-output__row">
            <input class="form-input" id="invite-link-value" type="text" readonly />
            <button type="button" class="btn btn--secondary btn--sm" id="invite-link-copy">
              <i data-lucide="copy" class="icon-sm" aria-hidden="true"></i>
              ${t('settings.invites.copy')}
            </button>
          </div>
          <p class="form-hint">${t('settings.invites.linkOnce')}</p>
          <p class="form-hint" id="invite-email-note" hidden></p>
        </div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" id="cancel-add-invite">${t('settings.cancelAddMember')}</button>
          <button type="submit" class="btn btn--primary" form="add-invite-form">${t('settings.invites.submit')}</button>
        </div>`;
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionFamily')}</h2>
      <div class="settings-card" id="members-card">
        <ul class="settings-members row-divided" id="members-list"></ul>
        <p class="form-hint" id="members-order-hint" hidden>${t('settings.memberOrderHint')}</p>
        <div class="sr-only" role="status" aria-live="polite" id="members-order-announce"></div>
        <button class="btn btn--secondary settings-add-btn" id="add-member-btn" hidden>${t('settings.addMember')}</button>
      </div>

      <div class="settings-card" id="two-factor-household-card">
        <h3 class="settings-card__title">${t('settings.twoFactorTitle')}</h3>
        <p class="form-hint">${t('settings.twoFactorHouseholdHint')}</p>
        ${toggleRowHtml({
          control: 'switch',
          label: t('settings.twoFactorRequireLabel'),
          attrs: { id: 'two-factor-require' },
          disabled: true,
        })}
        <ul class="settings-2fa__members" id="two-factor-members"></ul>
        <div id="two-factor-household-error" class="form-error" role="alert" hidden></div>
      </div>

      <div class="settings-card" id="invites-card">
        <h3 class="settings-card__title">${t('settings.invites.title')}</h3>
        <p class="form-hint">${t('settings.invites.intro')}</p>
        <ul class="settings-members row-divided" id="invites-list"></ul>
        <button class="btn btn--secondary settings-add-btn" id="add-invite-btn" hidden>${t('settings.invites.add')}</button>
      </div>

    </section>
  `);
}

/**
 * Leerzustand oder Fehlerkarte einer der beiden `<ul>` (Mitglieder,
 * Einladungen). Eine Liste traegt nur `<li>`: ein `<p>` oder `<div>` direkt
 * darin ist ungueltiges Markup, und Screenreader zaehlen die Liste falsch
 * (axe `list`, a11y-Runde). Ein Text wird zum Hinweis, ein Knoten kommt so,
 * wie er ist, in die Zeile.
 * @param {string|Node} content
 * @returns {HTMLLIElement}
 */
function listNotice(content) {
  const item = document.createElement('li');
  if (typeof content === 'string') {
    item.className = 'form-hint';
    item.textContent = content;
  } else {
    item.appendChild(content);
  }
  return item;
}

/** Die Zeilen in der Folge, in der die Liste sie zeigt: Aktive, dann Ehemalige, je in der Haushaltsreihenfolge. */
function orderedMembers(users) {
  return [...sortMembers(users.filter((u) => !u.deactivated_at)), ...sortMembers(users.filter((u) => u.deactivated_at))];
}

/**
 * Welche Zeilen lassen sich ordnen? (#1644)
 *
 * Nur ein Administrator ordnet, und nur Haushaltsmitglieder haben eine
 * Position - `is_household_member` kommt vom Server und ist dieselbe Menge,
 * die `PATCH /family/members/reorder` annimmt. Ein einzelnes Mitglied hat
 * keine Reihenfolge: dann gibt es keinen Griff, statt eine folgenlose
 * Handlung anzubieten.
 */
function orderableIds(users, currentUser) {
  if (currentUser?.role !== 'admin') return [];
  const ids = users.filter((u) => u.is_household_member && !u.deactivated_at).map((u) => u.id);
  return ids.length > 1 ? ids : [];
}

/** Die id-Folge nach einem Schritt um einen Platz; unveraendert, wenn es dort nicht weitergeht. */
function movedOrder(ids, id, delta) {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

function renderMemberList(container, users, currentUserId, currentUser = null) {
  const list = container.querySelector('#members-list');
  if (!list) return;
  list.replaceChildren();
  const canOrder = new Set(orderableIds(users, currentUser));
  const hint = container.querySelector('#members-order-hint');
  if (hint) hint.hidden = canOrder.size === 0;
  if (!users.length) {
    list.appendChild(listNotice(t('settings.familyEmpty')));
  } else {
    // Ehemalige ans Ende, davor und darin die Haushaltsreihenfolge (#1644).
    // Der Server liefert die Liste schon so; sortiert wird hier, weil sie
    // zwischen zwei Abrufen lokal weiterlebt - ein eben angelegtes Mitglied
    // haengt am Ende des Arrays und gehoert ins Alphabet der Unplatzierten.
    const ordered = orderedMembers(users);
    list.insertAdjacentHTML('beforeend', ordered.map((u) => memberHtml(u, currentUserId, { orderable: canOrder.has(u.id), aligned: canOrder.size > 0 })).join(''));
  }
  window.lucide?.createIcons({ el: list });
}

// --------------------------------------------------------
// Haushaltsreihenfolge: Ziehen und Pfeiltasten (#1644)
// --------------------------------------------------------

/** Die laufende Sortable-Instanz der Mitgliederliste; ein Neuaufbau raeumt sie ab. */
let memberSortable = null;
/** Was der delegierte Tastaturpfad braucht - je Aufbau der Liste neu gesetzt. */
let memberOrderCtx = null;
/** Laufende Sicherung: `{ again }`, solange eine Anfrage unterwegs ist. */
let memberOrderRun = null;

function orderableRows(list) {
  return [...list.querySelectorAll(':scope > .settings-member--orderable')];
}

/** Position und Gesamtzahl in die Griff-Beschriftung: die einzige Rueckmeldung am fokussierten Griff. */
function refreshMemberHandles(list) {
  const rows = orderableRows(list);
  rows.forEach((row, idx) => {
    const name = row.querySelector('[data-member-name]')?.textContent?.trim() ?? '';
    row.querySelector('.settings-member__drag')?.setAttribute('aria-label',
      `${t('shopping.reorderHandle', { name })}, ${t('shopping.reorderPosition', { index: idx + 1, total: rows.length })}`);
  });
}

function announceMemberMove(container, row) {
  const el = container.querySelector('#members-order-announce');
  const list = row?.parentElement;
  if (!el || !list) return;
  const rows = orderableRows(list);
  const idx = rows.indexOf(row);
  if (idx === -1) return;
  // Derselbe Satz wie im Kategorie-Manager und in der Einkaufsliste - eine
  // zweite Fassung derselben Aussage waeren 26 Uebersetzungen mehr.
  el.textContent = t('category.reorderAnnounce', {
    name: row.querySelector('[data-member-name]')?.textContent?.trim() ?? '',
    position: idx + 1,
    total: rows.length,
  });
}

/** Liste neu zeichnen und alles daran wieder verdrahten; der Fokus kehrt zum Griff von `focusId` zurueck. */
function repaintMembers(container, currentUser, users, focusId = null) {
  renderMemberList(container, users, currentUser?.id, currentUser);
  bindDeleteButtons(container, currentUser, users);
  bindEditButtons(container, currentUser, users);
  wireMemberOrder(container, currentUser, users);
  if (focusId != null) container.querySelector(`[data-member-handle="${Number(focusId)}"]`)?.focus();
}

/**
 * Einen Sicherungslauf: liest die Reihenfolge JETZT aus dem DOM und schickt
 * die vollstaendige Liste - die Route nimmt nur alle Mitglieder zusammen.
 */
async function sendMemberOrder(container, currentUser, users) {
  const list = container.querySelector('#members-list');
  if (!list) return true;
  const order = orderableRows(list).map((row) => Number(row.dataset.id)).filter(Number.isInteger);
  try {
    const res = await api.patch('/family/members/reorder', { order });
    // Die Positionen aus der Antwort in den lokalen Stand: die Liste lebt
    // zwischen zwei Abrufen weiter, und die naechste Zeichnung sortiert danach.
    const positions = new Map((res?.data ?? []).map((member) => [member.id, member.sort_order ?? null]));
    users.forEach((u, idx) => {
      if (positions.has(u.id)) users[idx] = { ...u, sort_order: positions.get(u.id) };
    });
    return true;
  } catch {
    // Der Satz der App und nicht der englische der API: was nicht geklappt
    // hat, ist hier immer dasselbe. Die Liste geht auf den Stand von vorher.
    window.yuvomi?.showToast(t('quickLinks.orderError'), 'danger');
    return false;
  }
}

/**
 * Die neue Reihenfolge sichern - der EINE Weg fuer Ziehen und Pfeiltasten,
 * beide haben das DOM vorher schon umgestellt.
 *
 * IMMER NUR EINE LAUFENDE ANFRAGE. Zwei schnell gedrueckte Pfeiltasten
 * schickten sonst zwei PATCHes parallel, und es entschiede die Ankunft beim
 * Server statt die Bedienung. Weitere Zuege waehrend eines Laufs werden zu
 * EINER Nachfolge: die liest die dann aktuelle Reihenfolge.
 */
function persistMemberOrder(container, currentUser, users, movedRow) {
  const list = container.querySelector('#members-list');
  if (!list) return;
  refreshMemberHandles(list);
  announceMemberMove(container, movedRow);
  if (memberOrderRun) { memberOrderRun.again = true; return; }

  const run = { again: false };
  memberOrderRun = run;
  (async () => {
    let ok = true;
    try {
      do {
        run.again = false;
        ok = await sendMemberOrder(container, currentUser, users);
      } while (run.again && ok);
    } finally {
      memberOrderRun = null;
    }
    // Der Griff, auf dem der Fokus JETZT steht, bekommt ihn nach dem
    // Neuzeichnen zurueck - mitten in einer Tastaturbedienung waere ein
    // verlorener Fokus das Ende der Bedienkette.
    const focused = Number(document.activeElement?.dataset?.memberHandle) || null;
    const shown = [...list.querySelectorAll(':scope > .settings-member')].map((row) => Number(row.dataset.id));
    const wanted = orderedMembers(users).map((u) => u.id);
    // Nach einem Fehler zurueck auf den gespeicherten Stand. Nach einem Erfolg
    // nur, wenn die Liste anders dasteht als sie sortiert stuende: beim ersten
    // Ordnen ruecken Konten ohne Position (Hauspersonal) hinter die Mitglieder.
    if (!ok || shown.join(',') !== wanted.join(',')) repaintMembers(container, currentUser, users, focused);
  })();
}

/** Verschiebt eine Zeile um einen Platz unter den ordenbaren und haelt den Fokus auf ihrem Griff. */
function moveMemberRow(row, delta, ctx) {
  const list = row?.parentElement;
  if (!list) return;
  const rows = orderableRows(list);
  const ids = rows.map((r) => Number(r.dataset.id));
  const id = Number(row.dataset.id);
  const next = movedOrder(ids, id, delta);
  if (next === ids) return;
  const target = rows[ids.indexOf(id) + delta];
  if (delta < 0) list.insertBefore(row, target);
  else list.insertBefore(row, target.nextSibling);
  vibrate(15);
  row.querySelector('.settings-member__drag')?.focus();
  persistMemberOrder(ctx.container, ctx.currentUser, ctx.users, row);
}

/**
 * Verdrahtet Ziehen und Pfeiltasten an der Mitgliederliste.
 *
 * Wer nicht ordnen darf, bekommt weder Griff noch Sortable noch Tastaturpfad:
 * die Reihenfolge bleibt sichtbar, die Handlung entfaellt (Nur-lesen-Regel).
 */
function wireMemberOrder(container, currentUser, users) {
  const list = container.querySelector('#members-list');
  if (!list) return;
  try { memberSortable?.destroy?.(); } catch { /* schon abgeraeumt */ }
  memberSortable = null;
  memberOrderCtx = { container, currentUser, users };
  if (!orderableIds(users, currentUser).length) return;
  refreshMemberHandles(list);

  makeSortable(list, {
    handle: '.settings-member__drag',
    draggable: '.settings-member--orderable',
    onEnd: (evt) => persistMemberOrder(container, currentUser, users, evt?.item),
  }).then((instance) => {
    // Die Liste kann waehrend des lazy Imports neu gebaut worden sein.
    if (instance && memberOrderCtx?.users === users && list.isConnected) memberSortable = instance;
    else instance?.destroy?.();
  }).catch(() => { /* ohne SortableJS bleibt der Tastaturpfad */ });

  // Tastaturpfad, delegiert und einmal je Listenelement: `renderMemberList`
  // tauscht nur den Inhalt, ein Listener je Aufbau haette sich gestapelt.
  if (list.dataset.orderWired) return;
  list.dataset.orderWired = '1';
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const handle = e.target.closest?.('.settings-member__drag');
    if (!handle || !memberOrderCtx) return;
    e.preventDefault();
    moveMemberRow(handle.closest('.settings-member'), e.key === 'ArrowUp' ? -1 : 1, memberOrderCtx);
  });
}

function inviteHtml(invite) {
  // Eine Einladung muss weder Namen noch Adresse tragen: dann benennt sie die
  // Familienrolle, damit die Zeile nicht namenlos in der Liste steht.
  const roleLabel = familyRoleLabel(invite.family_role);
  const primary = invite.display_name || invite.username || invite.email || roleLabel;
  const meta = [
    invite.username && invite.username !== primary ? `@${invite.username}` : '',
    roleLabel === primary ? '' : roleLabel,
    invite.role === 'admin' ? t('settings.systemAdminBadge') : '',
  ].filter(Boolean).map(esc).join(' · ');
  return `
    <li class="settings-member" data-invite-id="${invite.id}">
      <div class="settings-member__info">
        <span class="settings-member__name">${esc(primary)}</span>
        ${meta ? `<span class="settings-member__meta">${meta}</span>` : ''}
        <span class="settings-member__meta">${esc(t('settings.invites.expires', { date: formatDate(invite.expires_at) }))}</span>
      </div>
      <button class="row-action row-action--danger" data-revoke-invite="${invite.id}" data-name="${esc(primary)}"
        aria-label="${esc(primary)} ${t('settings.invites.revoke')}" title="${t('settings.invites.revoke')}">
        <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
      </button>
    </li>
  `;
}

function renderInviteList(container, invites) {
  const list = container.querySelector('#invites-list');
  if (!list) return;
  list.replaceChildren();
  if (!invites.length) {
    list.appendChild(listNotice(t('settings.invites.empty')));
  } else {
    list.insertAdjacentHTML('beforeend', invites.map(inviteHtml).join(''));
  }
  window.lucide?.createIcons({ el: list });
}

/**
 * Kopiert den Link und meldet ehrlich, ob es geklappt hat. Ohne HTTPS gibt es
 * navigator.clipboard gar nicht - dann bleibt das markierte Feld plus der alte
 * execCommand-Weg, und genau das ist der Normalfall einer selbstgehosteten
 * Instanz im Heimnetz.
 */
async function copyInviteLink(input) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(input.value);
      return true;
    } catch { /* auf den Auswahl-Weg zurückfallen */ }
  }
  try {
    input.focus();
    input.select();
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

function bindInviteEvents(container, initialInvites) {
  const list = container.querySelector('#invites-list');
  const addBtn = container.querySelector('#add-invite-btn');
  if (!list || !addBtn) return;

  let invites = [...initialInvites];

  addBtn.hidden = false;
  addBtn.addEventListener('click', () => openInviteModal());

  function openInviteModal() {
    openModal({
      title: t('settings.invites.submit'),
      size: 'md',
      content: addInviteFormHtml(),
      onSave(panel) {
        const form = panel.querySelector('#add-invite-form');
        const output = panel.querySelector('#invite-link-output');
        const outputValue = panel.querySelector('#invite-link-value');
        const emailNote = panel.querySelector('#invite-email-note');
        const errorEl = panel.querySelector('#invite-error');

        // Startrechte (#869): das Feld waehlt eine Vorlage, der Hinweis darunter sagt,
        // was sie im MOMENT bedeutet. Ohne ihn waere "wie das Rollenprofil" eine
        // Angabe ueber etwas, das man nur auf einem anderen Blatt nachsehen kann -
        // und genau das Nachsehen unterbleibt beim Einladen.
        const presetSelect = panel.querySelector('#invite-permission-preset');
        const roleSelect = panel.querySelector('#invite-family-role');
        const presetHint = panel.querySelector('#invite-preset-hint');
        // Ein Rollenprofil aendert sich waehrend eines Formularaufrufs nicht, und
        // jeder Wechsel zwischen zwei Rollen wuerde es sonst erneut holen.
        const roleProfiles = new Map();

        async function updatePresetHint() {
          if (!presetSelect || !presetHint) return;
          const role = roleSelect?.value || 'other';
          if (presetSelect.value === 'restricted') {
            const names = (permissionCatalog?.invitePresets?.restrictedModules || []).map(moduleLabel);
            const base = names.length
              ? t('settings.invites.presetHintRestricted', { modules: names.join(', ') })
              : t('settings.invites.presetHintUnavailable');
            presetHint.textContent = appendCapabilityState(base, capabilityStateText('health_use_fasting', null, true));
            return;
          }
          if (!roleProfiles.has(role)) {
            try {
              roleProfiles.set(role, (await api.get(`/permissions/role/${encodeURIComponent(role)}`))?.data || null);
            } catch {
              // Kein Profil zu holen heisst nicht "kein Profil vorhanden": eine
              // Behauptung waere hier schlimmer als keine.
              roleProfiles.set(role, null);
            }
          }
          // Zwischen Anfrage und Antwort kann eine andere Rolle gewaehlt worden sein.
          if ((roleSelect?.value || 'other') !== role || presetSelect.value !== 'role') return;
          const profile = roleProfiles.get(role);
          const roleName = familyRoleLabel(role);
          if (!profile) {
            presetHint.textContent = t('settings.invites.presetHintUnavailable');
            return;
          }
          const denied = deniedModuleNames(profile.modules);
          const base = denied.length
            ? t('settings.invites.presetHintRoleLimited', { role: roleName, modules: denied.join(', ') })
            : t('settings.invites.presetHintRoleOpen', { role: roleName });
          presetHint.textContent = appendCapabilityState(
            base,
            capabilityStateText('health_use_fasting', profile, profile.modules?.health === 'none'),
          );
        }

        presetSelect?.addEventListener('change', updatePresetHint);
        roleSelect?.addEventListener('change', updatePresetHint);
        updatePresetHint();

        panel.querySelector('#cancel-add-invite')?.addEventListener('click', () => closeModal());

        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          errorEl.hidden = true;
          output.hidden = true;
          const sendEmail = panel.querySelector('#invite-send-email')?.checked === true;
          const payload = {
            username: panel.querySelector('#invite-username').value.trim(),
            display_name: panel.querySelector('#invite-display-name').value.trim(),
            email: panel.querySelector('#invite-email').value.trim(),
            family_role: panel.querySelector('#invite-family-role').value,
            permission_preset: panel.querySelector('#invite-permission-preset').value,
            system_admin: panel.querySelector('#invite-system-admin')?.checked === true,
            send_email: sendEmail,
          };

          const btn = panel.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            const res = await auth.createInvite(payload);
            invites.unshift(res.data.invite);
            renderInviteList(container, invites);
            form.reset();
            updatePresetHint();
            // Der Klartext-Token kommt nur aus dieser einen Antwort. Der Dialog
            // bleibt deshalb offen: wuerde er sich wie beim Mitglied-Anlegen
            // schliessen, waere der Link im selben Moment weg, in dem er entsteht.
            outputValue.value = `${window.location.origin}/join?token=${encodeURIComponent(res.data.token)}`;
            output.hidden = false;
            if (sendEmail) {
              emailNote.textContent = res.data.email_sent
                ? t('settings.invites.emailSent')
                : t('settings.invites.emailNotSent');
              emailNote.hidden = false;
            } else {
              emailNote.hidden = true;
            }
            window.lucide?.createIcons({ el: output });
            outputValue.focus();
            outputValue.select();
            window.yuvomi?.showToast(t('settings.invites.created'), 'success');
          } catch (err) {
            showError(errorEl, err.message);
          } finally {
            btn.disabled = false;
          }
        });

        panel.querySelector('#invite-link-copy')?.addEventListener('click', async () => {
          if (!outputValue.value) return;
          const copied = await copyInviteLink(outputValue);
          window.yuvomi?.showToast(
            copied ? t('settings.invites.copied') : t('settings.invites.copyFailed'),
            copied ? 'success' : 'danger',
          );
        });
      },
    });
  }

  list.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-revoke-invite]');
    if (!btn) return;
    const id = Number(btn.dataset.revokeInvite);
    if (!await confirmModal(t('settings.invites.revokeConfirm'), {
      danger: true,
      confirmLabel: t('settings.invites.revoke'),
      detail: t('settings.invites.revokeConfirmDetail'),
    })) return;
    try {
      await auth.revokeInvite(id);
      invites = invites.filter((i) => i.id !== id);
      renderInviteList(container, invites);
      refocusAfterRender();
      window.yuvomi?.showToast(t('settings.invites.revoked'), 'default');
    } catch (err) {
      window.yuvomi?.showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
}

async function loadInvites(container) {
  const list = container.querySelector('#invites-list');
  if (!list) return;

  let invites;
  try {
    const res = await auth.getInvites();
    invites = res.data?.invites ?? [];
  } catch (err) {
    list.replaceChildren(listNotice(createRetryState({
      message: err.message || t('common.errorGeneric'),
      onRetry: () => loadInvites(container),
    })));
    return;
  }

  renderInviteList(container, invites);
  bindInviteEvents(container, invites);
}

function bindDeleteButtons(container, currentUser, users) {
  container.querySelectorAll('[data-delete-user]').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  container.querySelectorAll('[data-delete-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.deleteUser, 10);
      const name = btn.dataset.name;
      // Die Folgen stehen im Dialog, nicht in der Dokumentation. Was geschieht,
      // entscheidet der Server (#1381): ein Konto mit Spuren in geteilten Daten
      // wird deaktiviert, eines ohne wird geloescht. Der Dialog sagt beides,
      // statt die Kaskade als sichere Folge zu beschreiben. In einer
      // selbstgehosteten Instanz gibt es weder Support noch Undo.
      if (!await confirmModal(t('settings.removeMemberConfirm', { name }), {
        danger: true,
        confirmLabel: t('settings.removeMemberLabel'),
        detail: t('settings.removeMemberConfirmDetail', { name }),
      })) return;
      try {
        const res = await auth.deleteUser(id);
        const idx = users.findIndex((u) => u.id === id);
        if (res?.outcome === 'deactivated') {
          // Die Zeile bleibt und traegt die Marke. Rolle und Zeitpunkt wie der
          // Server sie gesetzt hat; die Liste liest sie beim naechsten Laden neu.
          if (idx !== -1) users[idx] = { ...users[idx], role: 'member', deactivated_at: new Date().toISOString() };
          window.yuvomi?.showToast(t('settings.memberDeactivatedToast', { name }), 'default');
        } else {
          if (idx !== -1) users.splice(idx, 1);
          window.yuvomi?.showToast(t('settings.memberDeletedToast', { name }), 'default');
        }
        repaintMembers(container, currentUser, users);
        // Der Knopf, an den der Dialog den Fokus zurueckgibt, ist eben
        // weggerendert worden.
        refocusAfterRender();
      } catch (err) {
        window.yuvomi?.showToast(err.message, 'danger');
      }
    });
  });
}

function bindEditButtons(container, currentUser, users) {
  container.querySelectorAll('[data-edit-user]').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  container.querySelectorAll('[data-edit-user]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.editUser, 10);
      const member = users.find((u) => u.id === id);
      if (member) openEditMemberModal(member, currentUser, users, container);
    });
  });
}

/**
 * Betreuende einer Person laden (#584). `null` heißt "nicht ermittelbar" und ist
 * absichtlich von "niemand" unterschieden: bei einem Ladefehler blendet das
 * Modal das Feld aus und rührt die gespeicherte Betreuung beim Speichern nicht
 * an - ein leer gerendertes Feld würde sie sonst kommentarlos entziehen.
 */
async function loadCaregiverIds(memberId) {
  try {
    const res = await api.get('/health/caregivers');
    return res?.data?.[memberId] ?? [];
  } catch {
    return null;
  }
}

async function openEditMemberModal(member, currentUser, users, container) {
  const state = { avatarData: member.avatar_data ?? null };
  const caregiverIds = await loadCaregiverIds(member.id);
  openModal({
    title: t('settings.editMemberTitle'),
    size: 'md',
    content: `
      <form id="edit-member-form" class="settings-form">
        <div class="settings-profile-editor">
          ${avatarEditorHtml(member, 'edit-member')}
          <div class="settings-profile-editor__fields">
            <div class="form-group">
              <label class="form-label" for="edit-member-username">${t('settings.usernameLabel')}</label>
              <input class="form-input" type="text" id="edit-member-username" value="${esc(member.username)}" required autocomplete="off" />
            </div>
            <div class="settings-name-color-row">
              <div class="form-group settings-name-color-row__name">
                <label class="form-label" for="edit-member-display-name">${t('settings.displayNameLabel')}</label>
                <input class="form-input" type="text" id="edit-member-display-name" value="${esc(member.display_name)}" required maxlength="128" />
              </div>
              <div class="form-group settings-color-field">
                <label class="form-label" for="edit-member-avatar-color">${t('settings.colorLabel')}</label>
                <input class="settings-color-button" type="color" id="edit-member-avatar-color" value="${esc(member.avatar_color || '#007AFF')}" />
              </div>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="edit-member-family-role">${t('settings.familyRoleLabel')}</label>
          <select class="form-input" id="edit-member-family-role">
            ${buildFamilyRoleOptions(member.family_role)}
          </select>
        </div>
        ${caregiverIds === null ? '' : `
        <div class="form-group">
          ${renderUserMultiSelect(
            users.filter((u) => u.id !== member.id),
            caregiverIds,
            'member_caregivers',
            'settings.healthCaregiversLabel',
          )}
          <p class="form-hint">${t('settings.healthCaregiversHint')}</p>
        </div>`}
        <div class="modal-grid modal-grid--2">
          <div class="form-group">
            <label class="form-label" for="edit-member-phone">${t('settings.memberPhoneLabel')}</label>
            <input class="form-input" type="tel" id="edit-member-phone" value="${esc(member.phone || '')}" autocomplete="tel" />
          </div>
          <div class="form-group">
            <label class="form-label" for="edit-member-email">${t('settings.memberEmailLabel')}</label>
            <input class="form-input" type="email" id="edit-member-email" value="${esc(member.email || '')}" autocomplete="email" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="edit-member-birth-date">${t('settings.memberBirthDateLabel')}</label>
          <yuvomi-datepicker type="date" id="edit-member-birth-date" value="${esc(member.birth_date || '')}"></yuvomi-datepicker>
          <p class="form-hint">${t('settings.memberContactBirthdayHint')}</p>
        </div>
        ${ssoAvailable ? `
        ${toggleRowHtml({
          control: 'switch',
          label: t('settings.memberSsoOnlyLabel'),
          checked: member.sso_only === true,
          attrs: { id: 'edit-member-sso-only' },
        })}
        <p class="form-hint">${t('settings.memberSsoOnlyEditHint')}</p>
        ` : ''}
        <div class="form-group" id="edit-member-password-group">
          <label class="form-label" for="edit-member-password">${t('settings.resetPasswordLabel')}</label>
          <input class="form-input" type="password" id="edit-member-password" minlength="8" autocomplete="new-password" placeholder="${t('settings.resetPasswordPlaceholder')}" />
          <p class="form-hint">${t('settings.resetPasswordHint')}</p>
        </div>
        ${toggleRowHtml({
          control: 'switch',
          label: t('settings.systemAdminLabel'),
          checked: member.role === 'admin',
          attrs: { id: 'edit-member-system-admin' },
        })}
        <p class="form-hint">${t('settings.systemAdminHint')}</p>
        <div id="edit-member-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" id="edit-member-cancel">${t('common.cancel')}</button>
          <button type="submit" class="btn btn--primary">${t('settings.saveMember')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      const fileInput = panel.querySelector('#edit-member-avatar-file');
      const errorEl = panel.querySelector('#edit-member-error');
      bindAvatarPicker(panel, 'edit-member');
      fileInput?.addEventListener('change', async () => {
        errorEl.hidden = true;
        const file = fileInput.files?.[0];
        // Das Feld ist ein Transportmittel, kein Zustand - sofort leeren, wie
        // beim Kachelbild (`quick-links-manager.js`). Bleibt der Dateiname
        // stehen, feuert `change` beim nächsten Griff zu DERSELBEN Datei nicht
        // mehr, und „nochmal anders zuschneiden" täte gar nichts.
        fileInput.value = '';
        try {
          const { pickCroppedImage } = await import('/utils/avatar-crop.js');
          const avatarData = await pickCroppedImage(file);
          if (avatarData === undefined) return; // abgebrochen: bisheriges Bild bleibt
          state.avatarData = avatarData;
          setAvatarPreview(panel, '#edit-member-avatar-preview', {
            display_name: panel.querySelector('#edit-member-display-name')?.value || member.display_name,
            avatar_color: panel.querySelector('#edit-member-avatar-color')?.value || member.avatar_color,
            avatar_data: avatarData,
          });
        } catch (err) {
          showError(errorEl, err.message ?? t('common.errorGeneric'));
        }
      });

      panel.querySelector('#edit-member-avatar-remove')?.addEventListener('click', () => {
        state.avatarData = null;
        if (fileInput) fileInput.value = '';
        setAvatarPreview(panel, '#edit-member-avatar-preview', {
          display_name: panel.querySelector('#edit-member-display-name')?.value || member.display_name,
          avatar_color: panel.querySelector('#edit-member-avatar-color')?.value || member.avatar_color,
          avatar_data: null,
        });
      });

      if (caregiverIds !== null) bindUserMultiSelect(panel, 'member_caregivers');

      // Der Umschalter fuehrt das Passwortfeld in beide Richtungen (#847): an
      // versteckt es, aus macht es zur Pflicht - aber nur, wenn das Konto
      // gerade wirklich keines hat. Sonst verlangte das Formular ein neues
      // Passwort dafuer, dass man einen Umschalter zweimal beruehrt hat.
      const ssoToggle = panel.querySelector('#edit-member-sso-only');
      const pwGroup = panel.querySelector('#edit-member-password-group');
      const pwField = panel.querySelector('#edit-member-password');
      const syncSsoOnly = () => {
        const on = ssoToggle?.checked === true;
        if (pwGroup) pwGroup.hidden = on;
        if (pwField) {
          pwField.required = !on && member.sso_only === true;
          if (on) pwField.value = '';
        }
      };
      ssoToggle?.addEventListener('change', syncSsoOnly);
      syncSsoOnly();

      panel.querySelector('#edit-member-cancel')?.addEventListener('click', closeModal);
      panel.querySelector('#edit-member-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submitBtn = panel.querySelector('[type=submit]');
        errorEl.hidden = true;
        const birthDateRaw = panel.querySelector('#edit-member-birth-date')?.value || '';
        if (!isDateInputValid(birthDateRaw)) {
          showError(errorEl, t('settings.memberBirthDateInvalid'));
          submitBtn.disabled = false;
          return;
        }
        const newPassword = panel.querySelector('#edit-member-password')?.value || '';
        submitBtn.disabled = true;
        try {
          const res = await auth.updateUser(member.id, {
            username: panel.querySelector('#edit-member-username').value.trim(),
            display_name: panel.querySelector('#edit-member-display-name').value.trim(),
            avatar_color: panel.querySelector('#edit-member-avatar-color').value,
            avatar_data: state.avatarData,
            family_role: panel.querySelector('#edit-member-family-role').value,
            system_admin: panel.querySelector('#edit-member-system-admin').checked,
            phone: panel.querySelector('#edit-member-phone')?.value.trim() || null,
            email: panel.querySelector('#edit-member-email')?.value.trim() || null,
            birth_date: parseDateInput(birthDateRaw) || null,
            ...(newPassword ? { password: newPassword } : {}),
            ...(ssoToggle ? { sso_only: ssoToggle.checked } : {}),
          });
          // Betreuung getrennt speichern: sie lebt im Gesundheitsmodul, nicht am
          // Nutzerdatensatz (#584).
          if (caregiverIds !== null) {
            await api.put(`/health/caregivers/${member.id}`, {
              caregiver_ids: getSelectedUserIds(panel, 'member_caregivers'),
            });
          }
          const idx = users.findIndex((u) => u.id === member.id);
          if (idx !== -1) users[idx] = res.user;
          if (currentUser?.id === member.id) Object.assign(currentUser, res.user);
          closeModal({ force: true });
          window.yuvomi?.showToast(t('settings.memberUpdatedToast', { name: res.user.display_name }), 'success');
          repaintMembers(container, currentUser, users);
        } catch (err) {
          showError(errorEl, err.message ?? t('common.errorGeneric'));
        } finally {
          submitBtn.disabled = false;
        }
      });
    },
  });
}

/**
 * Haelt Passwortfeld und SSO-Umschalter im Neu-Formular im Einklang (#847).
 *
 * Vor allem `required`: ein ausgeblendetes Pflichtfeld laesst der Browser nicht
 * absenden und kann den Grund auch nicht anzeigen - das Formular waere ohne
 * sichtbare Ursache tot. Modul-Funktion und nicht lokal in `bindEvents`, weil
 * auch der Abbrechen-Weg das Formular zuruecksetzt und denselben Abgleich
 * braucht, dort aber weiter oben steht.
 *
 * @param {HTMLElement} container
 */
function syncSsoOnlyField(container) {
  const on = container.querySelector('#new-member-sso-only')?.checked === true;
  const group = container.querySelector('#new-member-password-group');
  const field = container.querySelector('#new-member-password');
  if (group) group.hidden = on;
  if (field) {
    field.required = !on;
    if (on) field.value = '';
  }
  // Ohne Passwort ist die E-Mail der einzige Weg, auf dem die erste
  // SSO-Anmeldung dieses Konto findet - ein gleicher Benutzername verknuepft
  // bewusst nicht. Der Server weist es sonst ab; das hier sagt es vorher.
  const email = container.querySelector('#new-member-email');
  if (email) email.required = on;
}

function openAddMemberModal(container, currentUser, users) {
  openModal({
    title: t('settings.newMemberTitle'),
    size: 'md',
    content: addMemberFormHtml(),
    onSave(panel) {
      const form = panel.querySelector('#add-member-form');
      form.querySelector('#new-member-sso-only')
        ?.addEventListener('change', () => syncSsoOnlyField(panel));
      syncSsoOnlyField(panel);
      panel.querySelector('#cancel-add-member')?.addEventListener('click', () => closeModal());

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const errorEl = panel.querySelector('#member-error');
        errorEl.hidden = true;
        const birthDateRaw = panel.querySelector('#new-member-birth-date')?.value || '';
        if (!isDateInputValid(birthDateRaw)) {
          showError(errorEl, t('settings.memberBirthDateInvalid'));
          return;
        }

        const ssoOnly = panel.querySelector('#new-member-sso-only')?.checked === true;
        const data = {
          username: panel.querySelector('#new-username').value.trim(),
          display_name: panel.querySelector('#new-display-name').value.trim(),
          // Beides zugleich weist der Server ab - er kann nicht raten, welches
          // von beidem gemeint war.
          ...(ssoOnly ? { sso_only: true } : { password: panel.querySelector('#new-member-password').value }),
          avatar_color: panel.querySelector('#new-avatar-color').value,
          family_role: panel.querySelector('#new-family-role').value,
          system_admin: panel.querySelector('#new-system-admin')?.checked === true,
          phone: panel.querySelector('#new-member-phone')?.value.trim() || null,
          email: panel.querySelector('#new-member-email')?.value.trim() || null,
          birth_date: parseDateInput(birthDateRaw) || null,
        };

        const btn = panel.querySelector('[type=submit]');
        btn.disabled = true;
        try {
          const res = await auth.createUser(data);
          users.push(res.user);
          repaintMembers(container, currentUser, users);
          // Der Dialog gibt den Fokus beim Schliessen an "Mitglied hinzufuegen"
          // zurueck (modal.js) - kein Fall auf BODY wie beim Inline-Formular.
          closeModal({ force: true });
          window.yuvomi?.showToast(t('settings.memberAddedToast', { name: res.user.display_name }), 'success');
        } catch (err) {
          showError(errorEl, err.message);
        } finally {
          btn.disabled = false;
        }
      });
    },
  });
}

function bindEvents(container, currentUser, users) {
  const addMemberBtn = container.querySelector('#add-member-btn');
  if (addMemberBtn) {
    addMemberBtn.hidden = false;
    addMemberBtn.addEventListener('click', () => openAddMemberModal(container, currentUser, users));
  }

  bindDeleteButtons(container, currentUser, users);
  bindEditButtons(container, currentUser, users);
}

async function loadMembers(container, currentUser) {
  const list = container.querySelector('#members-list');
  if (!list) return;

  const reload = () => loadMembers(container, currentUser);

  let users;
  try {
    const res = await auth.getUsers();
    users = res.data ?? [];
  } catch (err) {
    list.replaceChildren(listNotice(createRetryState({
      message: err.message || t('common.errorGeneric'),
      onRetry: reload,
    })));
    return;
  }

  renderMemberList(container, users, currentUser?.id, currentUser);
  bindEvents(container, currentUser, users);
  wireMemberOrder(container, currentUser, users);
  window.lucide?.createIcons({ el: container });
}

/**
 * Wer hat den zweiten Faktor, und verlangt der Haushalt ihn (#672)?
 *
 * Die Liste steht neben dem Schalter, weil beides zusammen erst eine
 * Entscheidung ergibt: eine Pflicht einzuschalten, ohne zu sehen, wen sie
 * trifft, ist ein Blindflug. Sie sperrt niemanden aus - sie verbietet das
 * Abschalten und stellt allen anderen einen Hinweis auf ihre Kontoseite.
 *
 * @param {HTMLElement} container
 */
async function loadTwoFactorHousehold(container) {
  const card   = container.querySelector('#two-factor-household-card');
  const toggle = container.querySelector('#two-factor-require');
  const list   = container.querySelector('#two-factor-members');
  const error  = container.querySelector('#two-factor-household-error');
  if (!card || !toggle || !list) return;

  let overview;
  try {
    overview = await api.get('/auth/2fa/overview');
  } catch (err) {
    // Kein Admin (403) heisst: die Karte geht diesen Nutzer nichts an.
    card.remove();
    if (err?.status !== 403) showError(error, err?.message || t('settings.loadError'));
    return;
  }

  toggle.checked  = overview.required === true;
  toggle.disabled = false;

  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', overview.data.map((member) => `
    <li class="settings-2fa__member">
      <i data-lucide="${member.enabled ? 'shield-check' : 'shield-off'}" aria-hidden="true"
         class="settings-2fa__member-icon settings-2fa__member-icon--${member.enabled ? 'on' : 'off'}"></i>
      <span class="settings-2fa__member-name">${esc(member.display_name)}</span>
      <span class="settings-2fa__member-state">${member.enabled
        ? t('settings.twoFactorMemberOn')
        : t('settings.twoFactorMemberOff')}</span>
    </li>
  `).join(''));
  window.lucide?.createIcons({ el: list });

  toggle.addEventListener('change', async () => {
    const next = toggle.checked;
    toggle.disabled = true;
    clearError(error);
    try {
      await api.put('/auth/2fa/require', { required: next });
    } catch (err) {
      toggle.checked = !next;
      showError(error, err?.message || t('settings.loadError'));
    } finally {
      toggle.disabled = false;
    }
  });
}

export async function render(container, { user } = {}) {
  // Ein Ausfall dieser Abfrage darf die Verwaltung nicht kosten: ohne Antwort
  // bleibt es beim bisherigen Formular mit Pflicht-Passwort.
  try {
    ssoAvailable = (await api.get('/auth/oidc/config'))?.enabled === true;
  } catch {
    ssoAvailable = false;
  }
  // Derselbe Grundsatz wie darueber: faellt der Katalog aus, bleibt der Hinweis
  // unter den Startrechten ohne Modulnamen, aber das Formular funktioniert.
  try {
    permissionCatalog = (await api.get('/permissions/catalog'))?.data || null;
  } catch {
    permissionCatalog = null;
  }

  renderPage(container);
  await loadMembers(container, user || {});
  await loadTwoFactorHousehold(container);
  await loadInvites(container);
  window.lucide?.createIcons({ el: container });
}

// Der Avatar als Programm (test:initials): welche Zeichen ohne Bild auf der
// Scheibe stehen.
export const __test = { avatarHtml, memberHtml, orderableIds, movedOrder, orderedMembers, wireMemberOrder, renderMemberList };
