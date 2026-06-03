/**
 * Modul: Setup-Seite (First-Run)
 * Zweck: Anlegen des ersten Admin-Accounts in der Web-GUI beim erstmaligen Start.
 *        Visuell konsistent mit der Login-Seite (gleiche login.css-Klassen).
 * Abhängigkeiten: /api.js
 */

import { auth, ApiError } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

const VERSION_URL = '/api/v1/version';
const DEFAULT_APP_NAME = 'Oikos';
const APP_NAME_STORAGE_KEY = 'oikos-app-name';
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,64}$/;

function getStoredAppName() {
  return localStorage.getItem(APP_NAME_STORAGE_KEY) || DEFAULT_APP_NAME;
}

function setAppBranding(appName) {
  const name = String(appName || '').trim() || DEFAULT_APP_NAME;
  document.title = name;
  const titleEl = document.querySelector('.login-hero__title');
  if (titleEl) titleEl.textContent = name;
}

/**
 * Rendert die Setup-Seite in den gegebenen Container.
 * @param {HTMLElement} container
 */
export async function render(container) {
  const storedAppName = getStoredAppName();
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <main class="login-page" id="main-content">
      <div class="login-hero">
        <h1 class="login-hero__title">${esc(storedAppName)}</h1>
        <p class="login-hero__tagline">${esc(t('setup.tagline'))}</p>
      </div>
      <div class="login-card card card--padded">
        <form class="login-form" id="setup-form" novalidate>
          <div class="form-group">
            <label class="label" for="username">${esc(t('setup.usernameLabel'))}</label>
            <input class="input" type="text" id="username" name="username"
              autocomplete="username" autocapitalize="none" autocorrect="off"
              placeholder="${esc(t('setup.usernamePlaceholder'))}" required />
          </div>
          <div class="form-group">
            <label class="label" for="display_name">${esc(t('setup.displayNameLabel'))}</label>
            <input class="input" type="text" id="display_name" name="display_name"
              autocomplete="name"
              placeholder="${esc(t('setup.displayNamePlaceholder'))}" required />
          </div>
          <div class="form-group">
            <label class="label" for="password">${esc(t('setup.passwordLabel'))}</label>
            <input class="input" type="password" id="password" name="password"
              autocomplete="new-password"
              placeholder="${esc(t('setup.passwordPlaceholder'))}" required />
          </div>
          <div class="form-group">
            <label class="label" for="confirm_password">${esc(t('setup.confirmPasswordLabel'))}</label>
            <input class="input" type="password" id="confirm_password" name="confirm_password"
              autocomplete="new-password"
              placeholder="${esc(t('setup.confirmPasswordPlaceholder'))}" required />
          </div>
          <div class="login-error" id="setup-error" role="alert" aria-live="polite" hidden></div>
          <button type="submit" class="btn btn--primary login-form__submit" id="setup-btn">
            <span class="login-btn__label">${esc(t('setup.submitButton'))}</span>
          </button>
        </form>
      </div>
      <p class="login-version" id="setup-version"></p>
    </main>
  `);

  const form = container.querySelector('#setup-form');
  const errorEl = container.querySelector('#setup-error');
  const submitBtn = container.querySelector('#setup-btn');
  const versionEl = container.querySelector('#setup-version');
  const passwordInput = form.querySelector('#password');

  // Passwort-Sichtbarkeits-Toggle (wie Login)
  const passwordWrapper = document.createElement('div');
  passwordWrapper.className = 'input-password-wrapper';
  passwordInput.parentNode.insertBefore(passwordWrapper, passwordInput);
  passwordWrapper.appendChild(passwordInput);
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'password-toggle';
  toggleBtn.setAttribute('aria-label', t('setup.showPassword'));
  const toggleIcon = document.createElement('i');
  toggleIcon.setAttribute('data-lucide', 'eye');
  toggleIcon.setAttribute('aria-hidden', 'true');
  toggleBtn.appendChild(toggleIcon);
  passwordWrapper.appendChild(toggleBtn);
  if (window.lucide) lucide.createIcons({ el: toggleBtn });
  toggleBtn.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    toggleIcon.setAttribute('data-lucide', isPassword ? 'eye-off' : 'eye');
    toggleBtn.setAttribute('aria-label', t(isPassword ? 'setup.hidePassword' : 'setup.showPassword'));
    if (window.lucide) lucide.createIcons({ el: toggleBtn });
  });

  setAppBranding(storedAppName);

  fetch(VERSION_URL, { cache: 'no-store' })
    .then((r) => r.json())
    .then((d) => {
      if (d?.app_name) {
        try { localStorage.setItem(APP_NAME_STORAGE_KEY, d.app_name); } catch (_) {}
        setAppBranding(d.app_name);
      }
      versionEl.textContent = d?.version ? t('login.version', { version: d.version }) : '';
    })
    .catch(() => {});

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    const username = form.username.value.trim();
    const displayName = form.display_name.value.trim();
    const password = form.password.value;
    const confirm = form.confirm_password.value;

    if (!username || !displayName || !password) {
      showError(errorEl, t('setup.errorGeneric'));
      return;
    }
    if (!USERNAME_RE.test(username)) {
      showError(errorEl, t('setup.errorUsernameInvalid'));
      return;
    }
    if (password.length < 8) {
      showError(errorEl, t('setup.errorPasswordTooShort'));
      return;
    }
    if (password !== confirm) {
      showError(errorEl, t('setup.errorPasswordMismatch'));
      return;
    }

    const labelEl = submitBtn.querySelector('.login-btn__label');
    submitBtn.disabled = true;
    labelEl.textContent = t('setup.creating');
    const spinner = document.createElement('span');
    spinner.className = 'login-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    submitBtn.insertBefore(spinner, labelEl);

    try {
      await auth.setup(username, displayName, password);
      // Setup erfolgreich -> direkt einloggen
      const result = await auth.login(username, password);
      window.oikos.navigate('/', result.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        showError(errorEl, t('setup.errorUsernameTaken'));
      } else if (err instanceof ApiError && err.status === 403) {
        // Setup wurde zwischenzeitlich abgeschlossen
        window.oikos.navigate('/login');
        return;
      } else if (err instanceof ApiError && err.status === 429) {
        showError(errorEl, t('login.tooManyAttempts'));
      } else {
        showError(errorEl, t('setup.errorGeneric'));
      }
    } finally {
      submitBtn.disabled = false;
      labelEl.textContent = t('setup.submitButton');
      spinner.remove();
    }
  });

  for (const id of ['username', 'display_name', 'password', 'confirm_password']) {
    form.querySelector(`#${id}`).addEventListener('input', () => { errorEl.hidden = true; });
  }
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}
