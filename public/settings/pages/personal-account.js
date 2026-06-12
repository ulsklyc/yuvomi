import { api, auth } from '/api.js';
import {
  isDateInputValid,
  parseDateInput,
  t,
} from '/i18n.js';
import { esc } from '/utils/html.js';

const MAX_AVATAR_DATA_LENGTH = 768 * 1024;

function initials(name) {
  if (!name) return '?';
  return name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
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

function avatarEditorHtml(user) {
  return `
    <div class="settings-avatar-editor">
      <button type="button" class="settings-avatar-button" id="profile-avatar-preview" aria-label="${t('settings.profilePictureLabel')}">
        ${avatarHtml(user, 'settings-avatar settings-avatar--lg')}
      </button>
      <input class="sr-only" type="file" id="profile-avatar-file" accept="image/png,image/jpeg,image/webp" aria-label="${t('settings.profilePictureLabel')}" aria-describedby="profile-error" tabindex="-1">
      <div class="settings-avatar-actions">
        <button type="button" class="settings-avatar-action" id="profile-avatar-edit" aria-label="${t('settings.profilePictureLabel')}" title="${t('settings.profilePictureLabel')}">
          <i data-lucide="edit-2" aria-hidden="true"></i>
        </button>
        <button type="button" class="settings-avatar-action settings-avatar-action--danger" id="profile-avatar-remove" aria-label="${t('settings.profilePictureRemove')}" title="${t('settings.profilePictureRemove')}">
          <i data-lucide="trash-2" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `;
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

function setAvatarPreview(container, user) {
  const preview = container.querySelector('#profile-avatar-preview');
  if (!preview) return;
  preview.replaceChildren();
  preview.insertAdjacentHTML(
    'beforeend',
    avatarHtml(user, 'settings-avatar settings-avatar--lg'),
  );
  window.lucide?.createIcons({ el: preview });
}

function updateAccountSummary(container, user) {
  const currentAvatar = container.querySelector('.settings-user-info > .settings-avatar');
  if (currentAvatar) {
    currentAvatar.insertAdjacentHTML('afterend', avatarHtml(user));
    currentAvatar.remove();
  }
  const name = container.querySelector('#account-summary-name');
  if (name) name.textContent = user?.display_name || '';
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

const SETTINGS_NOTICE_KEY = 'oikos:settings:notice';

// Einmaliger Zugriffs-Hinweis: wurde ein Mitglied von einem unzulässigen Blatt
// hierher umgeleitet, hinterlässt der Controller eine Notiz, die wir genau
// einmal konsumieren und als barrierefreien Banner anzeigen.
function consumeAccessNotice() {
  let notice = null;
  try {
    notice = sessionStorage.getItem(SETTINGS_NOTICE_KEY);
    if (notice) sessionStorage.removeItem(SETTINGS_NOTICE_KEY);
  } catch {
    return null;
  }
  return notice === 'accessRedirected' ? t('settings.accessRedirected') : null;
}

function renderPage(container, user, refreshFailed, accessNotice) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    ${accessNotice ? `
      <div class="settings-banner settings-banner--info" role="status">${esc(accessNotice)}</div>
    ` : ''}

    ${refreshFailed ? `
      <div class="settings-card">
        <p class="form-error" role="alert">${t('settings.loadError')}</p>
        <div class="settings-form-actions">
          <button type="button" class="btn btn--secondary" id="account-retry">${t('settings.retry')}</button>
        </div>
      </div>
    ` : ''}

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionAccount')}</h2>

      <div class="settings-card">
        <div class="settings-user-info">
          ${avatarHtml(user)}
          <div>
            <div class="settings-user-info__name" id="account-summary-name">${esc(user?.display_name || '')}</div>
            <div class="settings-user-info__username">@${esc(user?.username || '')}</div>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.profilePictureTitle')}</h3>
        <form id="profile-form" class="settings-form">
          <div class="settings-profile-editor">
            ${avatarEditorHtml(user)}
            <div class="settings-profile-editor__fields">
              <div class="settings-name-color-row">
                <div class="form-group settings-name-color-row__name">
                  <label class="form-label" for="profile-display-name">${t('settings.displayNameLabel')}</label>
                  <input class="form-input" type="text" id="profile-display-name" maxlength="128" value="${esc(user?.display_name || '')}" aria-describedby="profile-error" required>
                </div>
                <div class="form-group settings-color-field">
                  <label class="form-label" for="profile-avatar-color">${t('settings.colorLabel')}</label>
                  <input class="settings-color-button" type="color" id="profile-avatar-color" value="${esc(user?.avatar_color || '')}" aria-describedby="profile-error">
                </div>
              </div>
            </div>
          </div>
          <div class="modal-grid modal-grid--2">
            <div class="form-group">
              <label class="form-label" for="profile-phone">${t('settings.memberPhoneLabel')}</label>
              <input class="form-input" type="tel" id="profile-phone" value="${esc(user?.phone || '')}" autocomplete="tel" aria-describedby="profile-error">
            </div>
            <div class="form-group">
              <label class="form-label" for="profile-email">${t('settings.memberEmailLabel')}</label>
              <input class="form-input" type="email" id="profile-email" value="${esc(user?.email || '')}" autocomplete="email" aria-describedby="profile-error">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="profile-birth-date">${t('settings.memberBirthDateLabel')}</label>
            <input class="form-input" type="date" id="profile-birth-date" value="${esc(user?.birth_date || '')}" aria-describedby="profile-error">
            <p class="form-hint">${t('settings.memberContactBirthdayHint')}</p>
          </div>
          <div id="profile-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary">${t('common.save')}</button>
          </div>
        </form>
      </div>

      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.changePassword')}</h3>
        <form id="password-form" class="settings-form">
          <div class="form-group">
            <label class="form-label" for="current-password">${t('settings.currentPasswordLabel')}</label>
            <input class="form-input" type="password" id="current-password" autocomplete="current-password" aria-describedby="password-error" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="new-password">${t('settings.newPasswordLabel')}</label>
            <input class="form-input" type="password" id="new-password" autocomplete="new-password" minlength="8" aria-describedby="password-error" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="confirm-password">${t('settings.confirmPasswordLabel')}</label>
            <input class="form-input" type="password" id="confirm-password" autocomplete="new-password" minlength="8" aria-describedby="password-error" required>
          </div>
          <div id="password-error" class="form-error" role="alert" hidden></div>
          <button type="submit" class="btn btn--primary">${t('settings.savePassword')}</button>
        </form>
      </div>
    </section>

    <section class="settings-section">
      <button class="btn btn--danger-outline settings-logout-btn" id="logout-btn">${t('settings.logout')}</button>
    </section>
  `);
}

function bindEvents(container, user, profileState) {
  const profileError = container.querySelector('#profile-error');
  const avatarFile = container.querySelector('#profile-avatar-file');
  const displayName = container.querySelector('#profile-display-name');
  const avatarColor = container.querySelector('#profile-avatar-color');

  const updatePreview = () => {
    setAvatarPreview(container, {
      display_name: displayName?.value || user?.display_name,
      avatar_color: avatarColor?.value || user?.avatar_color,
      avatar_data: profileState.avatarData,
    });
  };

  container.querySelector('#profile-avatar-preview')?.addEventListener('click', () => avatarFile?.click());
  container.querySelector('#profile-avatar-edit')?.addEventListener('click', () => avatarFile?.click());
  displayName?.addEventListener('input', updatePreview);
  avatarColor?.addEventListener('input', updatePreview);

  avatarFile?.addEventListener('change', async () => {
    clearError(profileError);
    try {
      const avatarData = await readImageAsDataUrl(avatarFile.files?.[0]);
      if (avatarData !== undefined) {
        profileState.avatarData = avatarData;
        updatePreview();
      } else {
        avatarFile.value = '';
      }
    } catch (error) {
      avatarFile.value = '';
      showError(profileError, error.message);
    }
  });

  container.querySelector('#profile-avatar-remove')?.addEventListener('click', () => {
    profileState.avatarData = null;
    if (avatarFile) avatarFile.value = '';
    updatePreview();
  });

  const profileForm = container.querySelector('#profile-form');
  profileForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError(profileError);

    const birthDateRaw = container.querySelector('#profile-birth-date')?.value || '';
    if (!isDateInputValid(birthDateRaw)) {
      showError(profileError, t('settings.memberBirthDateInvalid'));
      return;
    }

    const submitButton = profileForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    try {
      const response = await auth.updateProfile({
        display_name: displayName.value.trim(),
        avatar_color: avatarColor.value,
        avatar_data: profileState.avatarData,
        phone: container.querySelector('#profile-phone')?.value.trim() || null,
        email: container.querySelector('#profile-email')?.value.trim() || null,
        birth_date: parseDateInput(birthDateRaw) || null,
      });
      if (response?.user) {
        Object.assign(user, response.user);
        profileState.avatarData = response.user.avatar_data ?? null;
        updatePreview();
      }
      updateAccountSummary(container, user);
      window.oikos?.showToast(t('settings.profileSavedToast'), 'success');
    } catch (error) {
      showError(profileError, error.message);
    } finally {
      submitButton.disabled = false;
    }
  });

  const passwordForm = container.querySelector('#password-form');
  passwordForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const passwordError = container.querySelector('#password-error');
    clearError(passwordError);

    const currentPassword = container.querySelector('#current-password').value;
    const newPassword = container.querySelector('#new-password').value;
    const confirmPassword = container.querySelector('#confirm-password').value;
    if (newPassword !== confirmPassword) {
      showError(passwordError, t('settings.passwordMismatch'));
      return;
    }

    const submitButton = passwordForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    try {
      await api.patch('/auth/me/password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      passwordForm.reset();
      window.oikos?.showToast(t('settings.passwordSavedToast'), 'success');
    } catch (error) {
      showError(passwordError, error.message);
    } finally {
      submitButton.disabled = false;
    }
  });

  container.querySelector('#logout-btn')?.addEventListener('click', async () => {
    try {
      await auth.logout();
    } finally {
      window.oikos?.navigate('/login');
    }
  });
}

export async function render(container, { user }) {
  let currentUser = user || {};
  let refreshFailed = false;

  try {
    const response = await auth.me();
    if (response?.user && user) Object.assign(user, response.user);
    else if (response?.user) currentUser = response.user;
  } catch {
    refreshFailed = true;
  }

  const accessNotice = consumeAccessNotice();

  try {
    renderPage(container, currentUser, refreshFailed, accessNotice);
    bindEvents(container, currentUser, {
      avatarData: currentUser?.avatar_data ?? null,
    });
    container.querySelector('#account-retry')?.addEventListener('click', () => {
      render(container, { user: currentUser });
    });
    window.lucide?.createIcons({ el: container });
  } catch (error) {
    container.replaceChildren();
    throw error;
  }
}
