/**
 * Modul: Passwort-vergessen-Seite
 * Zweck: Benutzername/E-Mail entgegennehmen und Reset-Link anfordern (anti-enumeration).
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 */
import { auth } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

function wireLinks(container) {
  container.querySelectorAll('a[data-link]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); window.oikos.navigate(a.getAttribute('href')); }));
}

export async function render(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <main class="login-page" id="main-content">
      <div class="login-card card card--padded">
        <h1 class="login-card__title">${esc(t('forgotPassword.title'))}</h1>
        <p class="login-card__intro">${esc(t('forgotPassword.intro'))}</p>
        <form class="login-form" id="forgot-form" novalidate>
          <div class="form-group">
            <label class="label" for="identifier">${esc(t('forgotPassword.identifierLabel'))}</label>
            <input class="input" type="text" id="identifier" name="identifier"
              autocomplete="username" autocapitalize="none" autocorrect="off" required />
          </div>
          <div class="login-success" id="forgot-success" role="status" aria-live="polite" hidden></div>
          <button type="submit" class="btn btn--primary login-form__submit" id="forgot-btn">
            ${esc(t('forgotPassword.submit'))}
          </button>
        </form>
        <p class="login-form__forgot"><a href="/login" data-link>${esc(t('forgotPassword.backToLogin'))}</a></p>
      </div>
    </main>
  `);

  const form = container.querySelector('#forgot-form');
  const successEl = container.querySelector('#forgot-success');
  const btn = container.querySelector('#forgot-btn');
  wireLinks(container);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const identifier = form.identifier.value.trim();
    if (!identifier) { form.identifier.focus(); return; }
    btn.disabled = true;
    try {
      await auth.forgotPassword(identifier);
    } catch (_) {
      // Anti-enumeration: surface the same message regardless of result.
    } finally {
      successEl.textContent = t('forgotPassword.sent');
      successEl.hidden = false;
      btn.disabled = false;
    }
  });
}
