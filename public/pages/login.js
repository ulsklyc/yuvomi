/**
 * Modul: Login-Seite
 * Zweck: Anmeldeformular mit Username/Passwort, Fehlerbehandlung, Session-Start
 * Abhängigkeiten: /api.js
 */

import { auth } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

const VERSION_URL = '/api/v1/version';
const DEFAULT_APP_NAME = 'Yuvomi';
const APP_NAME_STORAGE_KEY = 'oikos-app-name';

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
 * Rendert die Login-Seite in den gegebenen Container.
 * @param {HTMLElement} container
 */
export async function render(container) {
  const storedAppName = getStoredAppName();
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <main class="login-page" id="main-content">
      <div class="login-hero">
        <h1 class="login-hero__title">${esc(storedAppName)}</h1>
        <p class="login-hero__tagline">${esc(t('login.tagline'))}</p>
      </div>
      <div class="login-card card card--padded">

        <form class="login-form" id="login-form" novalidate>
          <div class="form-group">
            <label class="label" for="username">${esc(t('login.usernameLabel'))}</label>
            <input
              class="input"
              type="text"
              id="username"
              name="username"
              autocomplete="username"
              autocapitalize="none"
              autocorrect="off"
              placeholder="${esc(t('login.usernamePlaceholder'))}"
              required
            />
          </div>

          <div class="form-group">
            <label class="label" for="password">${esc(t('login.passwordLabel'))}</label>
            <input
              class="input"
              type="password"
              id="password"
              name="password"
              autocomplete="current-password"
              placeholder="${esc(t('login.passwordPlaceholder'))}"
              required
            />
          </div>

          <div class="login-error" id="login-error" role="alert" aria-live="polite" hidden></div>

          <button type="submit" class="btn btn--primary login-form__submit" id="login-btn">
            <span class="login-btn__label">${esc(t('login.loginButton'))}</span>
          </button>
          <p class="login-form__forgot">
            <a href="/forgot-password" data-link>${esc(t('login.forgotPassword'))}</a>
          </p>
        </form>
      </div>
      <p class="login-version" id="login-version"></p>
    </main>
  `);

  const form = container.querySelector('#login-form');
  const errorEl = container.querySelector('#login-error');
  const submitBtn = container.querySelector('#login-btn');
  const versionEl = container.querySelector('#login-version');

  container.querySelectorAll('a[data-link]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); window.oikos.navigate(a.getAttribute('href')); }));

  // OIDC-Fehlermeldung aus URL-Parameter anzeigen (z.B. ?error=oidc_failed nach gescheitertem Callback)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('error')?.startsWith('oidc_')) {
    showError(errorEl, t('login.ssoError'));
  }

  // K3: Passwort-Sichtbarkeits-Toggle
  const passwordInput = form.querySelector('#password');
  const passwordWrapper = document.createElement('div');
  passwordWrapper.className = 'input-password-wrapper';
  passwordInput.parentNode.insertBefore(passwordWrapper, passwordInput);
  passwordWrapper.appendChild(passwordInput);

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'password-toggle';
  toggleBtn.setAttribute('aria-label', t('login.showPassword'));
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
    toggleBtn.setAttribute('aria-label', t(isPassword ? 'login.hidePassword' : 'login.showPassword'));
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

  // OIDC/SSO: SSO-Button anzeigen wenn Backend OIDC aktiviert hat
  fetch('/api/v1/auth/oidc/config', { cache: 'no-store' })
    .then(r => r.json())
    .then(data => {
      if (!data?.enabled) return;

      const card = container.querySelector('.login-card');

      const divider = document.createElement('div');
      divider.className = 'login-divider';
      divider.textContent = t('login.orDivider');

      const ssoBtn = document.createElement('a');
      ssoBtn.href = '/api/v1/auth/oidc/start';
      ssoBtn.className = 'btn btn--secondary login-form__submit';
      ssoBtn.textContent = t('login.loginWithSso');

      card.appendChild(divider);
      card.appendChild(ssoBtn);
    })
    .catch(() => {});

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    const username = form.username.value.trim();
    const password = form.password.value;

    const usernameInput = form.querySelector('#username');
    const usernameGroup = usernameInput.closest('.form-group');
    const passwordGroup = passwordInput.closest('.form-group');

    usernameGroup.classList.toggle('form-group--error', !username);
    passwordGroup.classList.toggle('form-group--error', !password);
    usernameInput.setAttribute('aria-invalid', String(!username));
    passwordInput.setAttribute('aria-invalid', String(!password));

    if (!username || !password) {
      if (!username) usernameInput.focus();
      else passwordInput.focus();
      return;
    }

    const labelEl = submitBtn.querySelector('.login-btn__label');

    submitBtn.disabled = true;
    labelEl.textContent = t('login.loggingIn');
    const spinner = document.createElement('span');
    spinner.className = 'login-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    submitBtn.insertBefore(spinner, labelEl);

    try {
      const result = await auth.login(username, password);
      window.oikos.navigate('/', result.user);
    } catch (err) {
      showError(errorEl, err.status === 429
        ? t('login.tooManyAttempts')
        : t('login.invalidCredentials')
      );
    } finally {
      submitBtn.disabled = false;
      labelEl.textContent = t('login.loginButton');
      spinner.remove();
    }
  });

  form.querySelector('#username').addEventListener('input', (e) => {
    e.currentTarget.closest('.form-group').classList.remove('form-group--error');
    e.currentTarget.removeAttribute('aria-invalid');
  });
  form.querySelector('#password').addEventListener('input', (e) => {
    e.currentTarget.closest('.form-group').classList.remove('form-group--error');
    e.currentTarget.removeAttribute('aria-invalid');
  });
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}
