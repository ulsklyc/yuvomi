import { api, auth } from '/api.js';
import {
  formatDate,
  isDateInputValid,
  parseDateInput,
  t,
} from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';
import { createRetryState } from '/settings/components.js';

const FAMILY_ROLES = ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'];
const AVATAR_COLORS = ['#007AFF', '#34C759', '#FF9500', '#FF3B30', '#AF52DE', '#FF2D55'];
const MAX_AVATAR_DATA_LENGTH = 768 * 1024;
const randomAvatarColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

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

function avatarHtml(user, className = 'settings-avatar') {
  const safeName = esc(user?.display_name || '');
  const fallback = esc(initials(user?.display_name || ''));
  const background = esc(user?.avatar_color) || 'var(--color-accent)';
  return `
    <div class="${className}" style="background:${background}" title="${safeName}">
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

async function readImageAsDataUrl(file) {
  if (!file) return undefined;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error(t('settings.profilePictureTypeError'));
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error(t('settings.profilePictureFileTooLarge'));
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(t('settings.profilePictureReadError')));
    reader.readAsDataURL(file);
  });

  const { openCropDialog } = await import('/utils/avatar-crop.js');
  const cropped = await openCropDialog(dataUrl);
  if (cropped === null) return undefined;
  if (cropped.length > MAX_AVATAR_DATA_LENGTH) {
    throw new Error(t('settings.profilePictureTooLarge'));
  }
  return cropped;
}

function memberHtml(u) {
  const familyRole = familyRoleLabel(u.family_role);
  const systemRole = u.role === 'admin' ? ` · ${esc(t('settings.systemAdminBadge'))}` : '';
  const profileMeta = [
    u.phone ? t('settings.memberPhoneMeta', { value: u.phone }) : '',
    u.email || '',
    u.birth_date ? t('settings.memberBirthdayMeta', { date: formatDate(u.birth_date) }) : '',
  ].filter(Boolean).map(esc).join(' · ');
  return `
    <li class="settings-member" data-id="${u.id}">
      ${avatarHtml(u, 'settings-avatar settings-avatar--sm')}
      <div class="settings-member__info">
        <span class="settings-member__name">${esc(u.display_name)}</span>
        <span class="settings-member__meta">@${esc(u.username)} · ${esc(familyRole)}${systemRole}</span>
        ${profileMeta ? `<span class="settings-member__meta">${profileMeta}</span>` : ''}
      </div>
      <button class="btn btn--icon btn--secondary" data-edit-user="${u.id}" aria-label="${esc(u.display_name)} ${t('settings.editMemberLabel')}" title="${t('settings.editMemberLabel')}">
        <i data-lucide="edit-2" aria-hidden="true"></i>
      </button>
      <button class="btn btn--icon btn--danger-outline" data-delete-user="${u.id}" data-name="${esc(u.display_name)}" aria-label="${esc(u.display_name)} ${t('settings.deleteMemberLabel')}" title="${t('settings.deleteMemberLabel')}">
        <i data-lucide="trash-2" aria-hidden="true"></i>
      </button>
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
          <div class="form-group">
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
            <input class="form-input" type="date" id="new-member-birth-date" />
            <p class="form-hint">${t('settings.memberContactBirthdayHint')}</p>
          </div>
          <label class="toggle-row">
            <input type="checkbox" id="new-system-admin" />
            <span>${t('settings.systemAdminLabel')}</span>
          </label>
          <p class="form-hint">${t('settings.systemAdminHint')}</p>
          <div id="member-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary">${t('settings.createMember')}</button>
            <button type="button" class="btn btn--secondary" id="cancel-add-member">${t('settings.cancelAddMember')}</button>
          </div>
        </form>
      </div>
    </section>
  `);
}

function renderMemberList(container, users) {
  const list = container.querySelector('#members-list');
  if (!list) return;
  list.replaceChildren();
  if (!users.length) {
    const empty = document.createElement('p');
    empty.className = 'form-hint';
    empty.textContent = t('settings.familyEmpty');
    list.appendChild(empty);
  } else {
    list.insertAdjacentHTML('beforeend', users.map(memberHtml).join(''));
  }
  window.lucide?.createIcons({ el: list });
}

function bindDeleteButtons(container) {
  container.querySelectorAll('[data-delete-user]').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  container.querySelectorAll('[data-delete-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.deleteUser, 10);
      const name = btn.dataset.name;
      if (!await confirmModal(t('settings.deleteMemberConfirm', { name }), {
        danger: true,
        confirmLabel: t('common.delete'),
      })) return;
      try {
        await auth.deleteUser(id);
        btn.closest('.settings-member').remove();
        window.oikos?.showToast(t('settings.memberDeletedToast', { name }), 'default');
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
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

function openEditMemberModal(member, currentUser, users, container) {
  const state = { avatarData: member.avatar_data ?? null };
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
          <input class="form-input" type="date" id="edit-member-birth-date" value="${esc(member.birth_date || '')}" />
          <p class="form-hint">${t('settings.memberContactBirthdayHint')}</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="edit-member-password">${t('settings.resetPasswordLabel')}</label>
          <input class="form-input" type="password" id="edit-member-password" minlength="8" autocomplete="new-password" placeholder="${t('settings.resetPasswordPlaceholder')}" />
          <p class="form-hint">${t('settings.resetPasswordHint')}</p>
        </div>
        <label class="toggle-row">
          <input type="checkbox" id="edit-member-system-admin" ${member.role === 'admin' ? 'checked' : ''} />
          <span>${t('settings.systemAdminLabel')}</span>
        </label>
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
        try {
          const avatarData = await readImageAsDataUrl(fileInput.files?.[0]);
          if (avatarData !== undefined) {
            state.avatarData = avatarData;
            setAvatarPreview(panel, '#edit-member-avatar-preview', {
              display_name: panel.querySelector('#edit-member-display-name')?.value || member.display_name,
              avatar_color: panel.querySelector('#edit-member-avatar-color')?.value || member.avatar_color,
              avatar_data: avatarData,
            });
          } else {
            fileInput.value = '';
          }
        } catch (err) {
          fileInput.value = '';
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
          });
          const idx = users.findIndex((u) => u.id === member.id);
          if (idx !== -1) users[idx] = res.user;
          if (currentUser?.id === member.id) Object.assign(currentUser, res.user);
          closeModal({ force: true });
          window.oikos?.showToast(t('settings.memberUpdatedToast', { name: res.user.display_name }), 'success');
          renderMemberList(container, users);
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
      container.querySelector('#new-avatar-color').value = randomAvatarColor();
      container.querySelector('#member-error').hidden = true;
    });
  }

  const addMemberForm = container.querySelector('#add-member-form');
  if (addMemberForm) {
    addMemberForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const errorEl = container.querySelector('#member-error');
      errorEl.hidden = true;
      const birthDateRaw = container.querySelector('#new-member-birth-date')?.value || '';
      if (!isDateInputValid(birthDateRaw)) {
        showError(errorEl, t('settings.memberBirthDateInvalid'));
        return;
      }

      const data = {
        username: container.querySelector('#new-username').value.trim(),
        display_name: container.querySelector('#new-display-name').value.trim(),
        password: container.querySelector('#new-member-password').value,
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
        renderMemberList(container, users);
        addMemberForm.reset();
        container.querySelector('#new-avatar-color').value = randomAvatarColor();
        container.querySelector('#add-member-form-card').classList.add('settings-card--hidden');
        container.querySelector('#add-member-btn').hidden = false;
        window.oikos?.showToast(t('settings.memberAddedToast', { name: res.user.display_name }), 'success');
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

  renderMemberList(container, users);
  bindEvents(container, currentUser, users);
  window.lucide?.createIcons({ el: container });
}

export async function render(container, { user } = {}) {
  renderPage(container);
  await loadMembers(container, user || {});
  window.lucide?.createIcons({ el: container });
}
