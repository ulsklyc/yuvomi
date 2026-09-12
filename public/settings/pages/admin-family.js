import { api, auth } from '/api.js';
import {
  formatDate,
  isDateInputValid,
  parseDateInput,
  t,
} from '/i18n.js';
import { esc } from '/utils/html.js';
import { prefersInkText } from '/utils/contrast.js';
import { AVATAR_COLORS } from '/utils/color.js';
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

function initials(name) {
  if (!name) return '?';
  return name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
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
  const fallback = esc(initials(user?.display_name || ''));
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
      <input class="sr-only" type="file" id="${prefix}-avatar-file" accept="image/png,image/jpeg,image/webp" />
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

function memberHtml(u, currentUserId) {
  // Konten der Haushaltshilfe sind keine Familienmitglieder: sie tragen das
  // Personal-Label statt einer Familienrolle (Audit A2-25e).
  const familyRole = u.is_worker ? t('housekeeping.staff') : familyRoleLabel(u.family_role);
  const systemRole = u.role === 'admin' ? ` · ${esc(t('settings.systemAdminBadge'))}` : '';
  const profileMeta = [
    u.phone ? t('settings.memberPhoneMeta', { value: u.phone }) : '',
    u.email || '',
    u.birth_date ? t('settings.memberBirthdayMeta', { date: formatDate(u.birth_date) }) : '',
  ].filter(Boolean).map(esc).join(' · ');
  // Row-Action-Grammatik statt dauerhaft rotem Outline-Button: Löschen wird
  // erst bei Hover/Fokus laut. Der eigene Account bekommt keine Lösch-Aktion
  // in der Mitgliederliste (Audit A2-25d).
  const deleteBtn = u.id === currentUserId ? '' : `
      <button class="row-action row-action--danger" data-delete-user="${u.id}" data-name="${esc(u.display_name)}" aria-label="${esc(u.display_name)} ${t('settings.deleteMemberLabel')}" title="${t('settings.deleteMemberLabel')}">
        <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
      </button>`;
  return `
    <li class="settings-member" data-id="${u.id}">
      ${avatarHtml(u, 'settings-avatar settings-avatar--sm')}
      <div class="settings-member__info">
        <span class="settings-member__name">${esc(u.display_name)}</span>
        <span class="settings-member__meta">@${esc(u.username)} · ${esc(familyRole)}${systemRole}</span>
        ${profileMeta ? `<span class="settings-member__meta">${profileMeta}</span>` : ''}
      </div>
      <button class="row-action" data-edit-user="${u.id}" aria-label="${esc(u.display_name)} ${t('settings.editMemberLabel')}" title="${t('settings.editMemberLabel')}">
        <i data-lucide="edit-2" class="icon-md" aria-hidden="true"></i>
      </button>${deleteBtn}
    </li>
  `;
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionFamily')}</h2>
      <div class="settings-card" id="members-card">
        <ul class="settings-members" id="members-list"></ul>
        <button class="btn btn--primary settings-add-btn" id="add-member-btn" hidden>${t('settings.addMember')}</button>
      </div>

      <div class="settings-card" id="two-factor-household-card">
        <h3 class="settings-card__title">${t('settings.twoFactorTitle')}</h3>
        <p class="form-hint">${t('settings.twoFactorHouseholdHint')}</p>
        ${toggleRowHtml({
          label: t('settings.twoFactorRequireLabel'),
          attrs: { id: 'two-factor-require' },
          disabled: true,
        })}
        <ul class="settings-2fa__members" id="two-factor-members"></ul>
        <div id="two-factor-household-error" class="form-error" role="alert" hidden></div>
      </div>

      <div class="settings-card settings-card--hidden" id="add-member-form-card">
        <h3 class="settings-card__title">${t('settings.newMemberTitle')}</h3>
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
            label: t('settings.systemAdminLabel'),
            attrs: { id: 'new-system-admin' },
          })}
          <p class="form-hint">${t('settings.systemAdminHint')}</p>
          <div id="member-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary">${t('settings.createMember')}</button>
            <button type="button" class="btn btn--secondary" id="cancel-add-member">${t('settings.cancelAddMember')}</button>
          </div>
        </form>
      </div>

      <div class="settings-card" id="invites-card">
        <h3 class="settings-card__title">${t('settings.invites.title')}</h3>
        <p class="form-hint">${t('settings.invites.intro')}</p>
        <ul class="settings-members" id="invites-list"></ul>
        <button class="btn btn--primary settings-add-btn" id="add-invite-btn" hidden>${t('settings.invites.add')}</button>
      </div>

      <div class="settings-card settings-card--hidden" id="add-invite-form-card">
        <h3 class="settings-card__title">${t('settings.invites.submit')}</h3>
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
            label: t('settings.invites.sendEmail'),
            attrs: { id: 'invite-send-email' },
          })}
          ${toggleRowHtml({
            label: t('settings.systemAdminLabel'),
            attrs: { id: 'invite-system-admin' },
          })}
          <p class="form-hint">${t('settings.systemAdminHint')}</p>
          <div id="invite-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary">${t('settings.invites.submit')}</button>
            <button type="button" class="btn btn--secondary" id="cancel-add-invite">${t('settings.cancelAddMember')}</button>
          </div>
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
      </div>
    </section>
  `);
}

function renderMemberList(container, users, currentUserId) {
  const list = container.querySelector('#members-list');
  if (!list) return;
  list.replaceChildren();
  if (!users.length) {
    const empty = document.createElement('p');
    empty.className = 'form-hint';
    empty.textContent = t('settings.familyEmpty');
    list.appendChild(empty);
  } else {
    list.insertAdjacentHTML('beforeend', users.map((u) => memberHtml(u, currentUserId)).join(''));
  }
  window.lucide?.createIcons({ el: list });
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
    const empty = document.createElement('p');
    empty.className = 'form-hint';
    empty.textContent = t('settings.invites.empty');
    list.appendChild(empty);
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
  const card = container.querySelector('#add-invite-form-card');
  const form = container.querySelector('#add-invite-form');
  const list = container.querySelector('#invites-list');
  const addBtn = container.querySelector('#add-invite-btn');
  if (!card || !form || !list || !addBtn) return;

  let invites = [...initialInvites];
  const output = container.querySelector('#invite-link-output');
  const outputValue = container.querySelector('#invite-link-value');
  const emailNote = container.querySelector('#invite-email-note');
  const errorEl = container.querySelector('#invite-error');

  // Startrechte (#869): das Feld waehlt eine Vorlage, der Hinweis darunter sagt,
  // was sie im MOMENT bedeutet. Ohne ihn waere "wie das Rollenprofil" eine
  // Angabe ueber etwas, das man nur auf einem anderen Blatt nachsehen kann -
  // und genau das Nachsehen unterbleibt beim Einladen.
  const presetSelect = container.querySelector('#invite-permission-preset');
  const roleSelect = container.querySelector('#invite-family-role');
  const presetHint = container.querySelector('#invite-preset-hint');
  // Ein Rollenprofil aendert sich waehrend eines Formularaufrufs nicht, und
  // jeder Wechsel zwischen zwei Rollen wuerde es sonst erneut holen.
  const roleProfiles = new Map();

  async function updatePresetHint() {
    if (!presetSelect || !presetHint) return;
    const role = roleSelect?.value || 'other';
    if (presetSelect.value === 'restricted') {
      const names = (permissionCatalog?.invitePresets?.restrictedModules || []).map(moduleLabel);
      presetHint.textContent = names.length
        ? t('settings.invites.presetHintRestricted', { modules: names.join(', ') })
        : t('settings.invites.presetHintUnavailable');
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
    presetHint.textContent = denied.length
      ? t('settings.invites.presetHintRoleLimited', { role: roleName, modules: denied.join(', ') })
      : t('settings.invites.presetHintRoleOpen', { role: roleName });
  }

  presetSelect?.addEventListener('change', updatePresetHint);
  roleSelect?.addEventListener('change', updatePresetHint);

  addBtn.hidden = false;
  addBtn.addEventListener('click', () => {
    card.classList.remove('settings-card--hidden');
    addBtn.hidden = true;
    updatePresetHint();
    container.querySelector('#invite-username')?.focus();
  });

  container.querySelector('#cancel-add-invite')?.addEventListener('click', () => {
    card.classList.add('settings-card--hidden');
    addBtn.hidden = false;
    form.reset();
    updatePresetHint();
    errorEl.hidden = true;
    output.hidden = true;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    output.hidden = true;
    const sendEmail = container.querySelector('#invite-send-email')?.checked === true;
    const payload = {
      username: container.querySelector('#invite-username').value.trim(),
      display_name: container.querySelector('#invite-display-name').value.trim(),
      email: container.querySelector('#invite-email').value.trim(),
      family_role: container.querySelector('#invite-family-role').value,
      permission_preset: container.querySelector('#invite-permission-preset').value,
      system_admin: container.querySelector('#invite-system-admin')?.checked === true,
      send_email: sendEmail,
    };

    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const res = await auth.createInvite(payload);
      invites.unshift(res.data.invite);
      renderInviteList(container, invites);
      form.reset();
      updatePresetHint();
      // Der Klartext-Token kommt nur aus dieser einen Antwort. Die Karte bleibt
      // deshalb offen: würde sie sich wie beim Mitglied-Anlegen schließen, wäre
      // der Link im selben Moment weg, in dem er entsteht.
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

  container.querySelector('#invite-link-copy')?.addEventListener('click', async () => {
    if (!outputValue.value) return;
    const copied = await copyInviteLink(outputValue);
    window.yuvomi?.showToast(
      copied ? t('settings.invites.copied') : t('settings.invites.copyFailed'),
      copied ? 'success' : 'danger',
    );
  });

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
    list.replaceChildren(createRetryState({
      message: err.message || t('common.errorGeneric'),
      onRetry: () => loadInvites(container),
    }));
    return;
  }

  renderInviteList(container, invites);
  bindInviteEvents(container, invites);
}

function bindDeleteButtons(container) {
  container.querySelectorAll('[data-delete-user]').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  container.querySelectorAll('[data-delete-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.deleteUser, 10);
      const name = btn.dataset.name;
      // Die Folgen stehen im Dialog, nicht in der Dokumentation: `created_by`
      // kaskadiert (server/db.js), `assigned_to` wird auf NULL gesetzt. In
      // einer selbstgehosteten Instanz gibt es weder Support noch Undo.
      if (!await confirmModal(t('settings.deleteMemberConfirm', { name }), {
        danger: true,
        confirmLabel: t('common.delete'),
        detail: t('settings.deleteMemberConfirmDetail', { name }),
      })) return;
      try {
        await auth.deleteUser(id);
        btn.closest('.settings-member').remove();
        window.yuvomi?.showToast(t('settings.memberDeletedToast', { name }), 'default');
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
          label: t('settings.systemAdminLabel'),
          checked: member.role === 'admin',
          attrs: { id: 'edit-member-system-admin' },
        })}
        <p class="form-hint">${t('settings.systemAdminHint')}</p>
        <div id="edit-member-error" class="form-error" role="alert" hidden></div>
        <div class="settings-form-actions">
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
          renderMemberList(container, users, currentUser?.id);
          bindDeleteButtons(container);
          bindEditButtons(container, currentUser, users);
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

function bindEvents(container, currentUser, users) {
  const addMemberBtn = container.querySelector('#add-member-btn');
  if (addMemberBtn) {
    addMemberBtn.hidden = false;
    addMemberBtn.addEventListener('click', () => {
      container.querySelector('#add-member-form-card').classList.remove('settings-card--hidden');
      addMemberBtn.hidden = true;
    });
  }

  const cancelAddMember = container.querySelector('#cancel-add-member');
  if (cancelAddMember) {
    cancelAddMember.addEventListener('click', () => {
      container.querySelector('#add-member-form-card').classList.add('settings-card--hidden');
      container.querySelector('#add-member-btn').hidden = false;
      container.querySelector('#add-member-form').reset();
      syncSsoOnlyField(container);
      container.querySelector('#new-avatar-color').value = randomAvatarColor();
      container.querySelector('#member-error').hidden = true;
    });
  }

  const addMemberForm = container.querySelector('#add-member-form');
  if (addMemberForm) {
    addMemberForm.querySelector('#new-member-sso-only')
      ?.addEventListener('change', () => syncSsoOnlyField(container));
    syncSsoOnlyField(container);

    addMemberForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const errorEl = container.querySelector('#member-error');
      errorEl.hidden = true;
      const birthDateRaw = container.querySelector('#new-member-birth-date')?.value || '';
      if (!isDateInputValid(birthDateRaw)) {
        showError(errorEl, t('settings.memberBirthDateInvalid'));
        return;
      }

      const ssoOnly = container.querySelector('#new-member-sso-only')?.checked === true;
      const data = {
        username: container.querySelector('#new-username').value.trim(),
        display_name: container.querySelector('#new-display-name').value.trim(),
        // Beides zugleich weist der Server ab - er kann nicht raten, welches
        // von beidem gemeint war.
        ...(ssoOnly ? { sso_only: true } : { password: container.querySelector('#new-member-password').value }),
        avatar_color: container.querySelector('#new-avatar-color').value,
        family_role: container.querySelector('#new-family-role').value,
        system_admin: container.querySelector('#new-system-admin')?.checked === true,
        phone: container.querySelector('#new-member-phone')?.value.trim() || null,
        email: container.querySelector('#new-member-email')?.value.trim() || null,
        birth_date: parseDateInput(birthDateRaw) || null,
      };

      const btn = addMemberForm.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        const res = await auth.createUser(data);
        users.push(res.user);
        renderMemberList(container, users, currentUser?.id);
        addMemberForm.reset();
        syncSsoOnlyField(container);
        container.querySelector('#new-avatar-color').value = randomAvatarColor();
        container.querySelector('#add-member-form-card').classList.add('settings-card--hidden');
        container.querySelector('#add-member-btn').hidden = false;
        window.yuvomi?.showToast(t('settings.memberAddedToast', { name: res.user.display_name }), 'success');
        bindDeleteButtons(container);
        bindEditButtons(container, currentUser, users);
      } catch (err) {
        showError(errorEl, err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  bindDeleteButtons(container);
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
    list.replaceChildren(createRetryState({
      message: err.message || t('common.errorGeneric'),
      onRetry: reload,
    }));
    return;
  }

  renderMemberList(container, users, currentUser?.id);
  bindEvents(container, currentUser, users);
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
