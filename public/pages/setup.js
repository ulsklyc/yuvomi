/**
 * Modul: Setup-Seite (First-Run)
 * Zweck: Anlegen des ersten Admin-Accounts in der Web-GUI beim erstmaligen Start.
 *        Visuell konsistent mit der Login-Seite (gleiche auth.css-Klassen).
 * Abhängigkeiten: /api.js
 */

import { auth, ApiError } from '/api.js';
import { getLocale, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { authHeroHtml, authErrorHtml, wirePasswordToggle, passwordRuleHtml, flagField, hideAuthError, showAuthError } from '/utils/auth-ui.js';
import { browserTimeZone } from '/utils/timezone.js';

const VERSION_URL = '/api/v1/version';
const DEFAULT_APP_NAME = 'Yuvomi';
const APP_NAME_STORAGE_KEY = 'yuvomi-app-name';
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,64}$/;

function getStoredAppName() {
  return localStorage.getItem(APP_NAME_STORAGE_KEY) || DEFAULT_APP_NAME;
}

function setAppBranding(appName) {
  const name = String(appName || '').trim() || DEFAULT_APP_NAME;
  document.title = name;
  const titleEl = document.querySelector('.auth-hero__title');
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
    <main class="auth-page" id="main-content">
      ${authHeroHtml({ appName: storedAppName, tagline: t('setup.tagline') })}
      <div class="auth-card card card--padded">
        <form class="auth-form" id="setup-form" novalidate>
          <div class="form-group">
            <label class="label" for="username">${esc(t('setup.usernameLabel'))}</label>
            <input class="input" type="text" id="username" name="username"
              autocomplete="username" autocapitalize="none" autocorrect="off" required />
          </div>
          <div class="form-group">
            <label class="label" for="display_name">${esc(t('setup.displayNameLabel'))}</label>
            <input class="input" type="text" id="display_name" name="display_name"
              autocomplete="name" required />
          </div>
          <div class="form-group">
            <label class="label" for="password">${esc(t('setup.passwordLabel'))}</label>
            <input class="input" type="password" id="password" name="password"
              autocomplete="new-password" minlength="8" aria-describedby="setup-password-rule"
              required />
            ${passwordRuleHtml('setup-password-rule', t('common.passwordMinLength'))}
          </div>
          <div class="form-group">
            <label class="label" for="confirm_password">${esc(t('setup.confirmPasswordLabel'))}</label>
            <input class="input" type="password" id="confirm_password" name="confirm_password"
              autocomplete="new-password"
              required />
          </div>
          ${authErrorHtml('setup-error')}
          <button type="submit" class="btn btn--primary auth-form__submit" id="setup-btn">
            <span class="auth-btn__label">${esc(t('setup.submitButton'))}</span>
          </button>
        </form>
      </div>
      <p class="auth-version" id="setup-version"></p>
    </main>
  `);

  const form = container.querySelector('#setup-form');
  const errorEl = container.querySelector('#setup-error');
  const submitBtn = container.querySelector('#setup-btn');
  const versionEl = container.querySelector('#setup-version');
  const passwordInput = form.querySelector('#password');

  // Das Auge an BEIDEN Feldern - der geteilte Baustein (utils/auth-ui.js). Bis
  // R16 trug es nur das erste; die Wiederholung tippte man blind.
  const eye = { show: t('setup.showPassword'), hide: t('setup.hidePassword') };
  wirePasswordToggle(passwordInput, eye);
  wirePasswordToggle(form.querySelector('#confirm_password'), eye);

  setAppBranding(storedAppName);

  // Der erste Schritt ohne Klick (R23 S10, Critique G6 P2), wie die Anmeldung:
  // nur auf Zeigegeraeten - am Telefon riss der Fokus sofort die Tastatur hoch.
  if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
    form.querySelector('#username')?.focus();
  }

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
    hideAuthError(form, errorEl);

    const username = form.username.value.trim();
    const displayName = form.display_name.value.trim();
    const password = form.password.value;
    const confirm = form.confirm_password.value;

    // Jede Pruefung markiert das Feld, das sie meint, die Meldung steht an
    // ihm und der Fokus geht hin (R23 D14, showAuthError). Leere Felder: alle
    // markiert, Meldung und Fokus am ersten. Vorher hiess das "Account konnte
    // nicht erstellt werden" - als waere etwas schiefgegangen.
    if (!username || !displayName || !password) {
      const empty = [!username && form.username, !displayName && form.display_name, !password && form.password].filter(Boolean);
      for (const field of empty.slice(1)) flagField(field, errorEl);
      showAuthError(errorEl, t('setup.errorRequired'), empty[0]);
      return;
    }
    if (!USERNAME_RE.test(username)) {
      showAuthError(errorEl, t('setup.errorUsernameInvalid'), form.username);
      return;
    }
    if (password.length < 8) {
      showAuthError(errorEl, t('setup.errorPasswordTooShort'), form.password);
      return;
    }
    if (password !== confirm) {
      showAuthError(errorEl, t('setup.errorPasswordMismatch'), form.confirm_password);
      return;
    }

    const labelEl = submitBtn.querySelector('.auth-btn__label');
    submitBtn.disabled = true;
    labelEl.textContent = t('setup.creating');
    const spinner = document.createElement('span');
    spinner.className = 'auth-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    submitBtn.insertBefore(spinner, labelEl);

    try {
      // Die Sprache, in der diese Seite gerade steht: der Server macht daraus
      // die Datensprache des Haushalts, statt still auf Englisch zu fallen.
      // Dazu die Zone dieses Browsers als Haushaltszone, sonst rechnet der
      // Server "heute" in der Zone des Containers (im Container meist UTC, und
      // "heute" liegt oestlich davon stundenlang auf gestern). Nennt der
      // Browser keine brauchbare, fehlt das Feld ganz: `undefined` laesst
      // JSON.stringify weg, ein `null` reiste als Wert mit.
      const language = getLocale();
      const timezone = browserTimeZone() ?? undefined;
      try {
        await auth.setup(username, displayName, password, language, timezone);
      } catch (err) {
        // Der Server prueft die Zone gegen SEINE ICU-Daten und lehnt eine
        // unbekannte mit 400 und `reason: invalid_timezone` ab. Das darf kein
        // Admin-Konto kosten: einmal ohne Zone wiederholen, sie ist in den
        // Einstellungen nachtraeglich waehlbar. NUR an diesem Anker, nicht an
        // jedem 400: Setup haengt am Login-Limiter, und eine Wiederholung je
        // Fehleingabe verbrauchte die fuenf Versuche doppelt so schnell.
        const zoneRejected = err instanceof ApiError && err.status === 400
          && err.data?.reason === 'invalid_timezone';
        if (!zoneRejected) throw err;
        await auth.setup(username, displayName, password, language);
      }
      // Setup erfolgreich -> direkt einloggen
      const result = await auth.login(username, password);
      window.yuvomi.navigate('/', result.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        showAuthError(errorEl, t('setup.errorUsernameTaken'), form.username);
      } else if (err instanceof ApiError && err.status === 403) {
        // Setup wurde zwischenzeitlich abgeschlossen
        window.yuvomi.navigate('/login');
        return;
      } else if (err instanceof ApiError && err.status === 429) {
        showAuthError(errorEl, t('login.tooManyAttempts'));
      } else {
        showAuthError(errorEl, t('setup.errorGeneric'));
      }
    } finally {
      submitBtn.disabled = false;
      labelEl.textContent = t('setup.submitButton');
      spinner.remove();
    }
  });

  for (const id of ['username', 'display_name', 'password', 'confirm_password']) {
    form.querySelector(`#${id}`).addEventListener('input', () => hideAuthError(form, errorEl));
  }
}


