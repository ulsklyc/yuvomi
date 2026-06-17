/**
 * Modul: Passwort-zuruecksetzen-Seite
 * Zweck: Token aus der URL lesen, neues Passwort setzen.
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
  const token = new URLSearchParams(window.location.search).get('token') || '';
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <main class="login-page" id="main-content">
      <div class="login-card card card--padded">
        <h1 class="login-card__title">${esc(t('resetPassword.title'))}</h1>
        <form class="login-form" id="reset-form" novalidate>
          <div class="form-group">
            <label class="label" for="password">${esc(t('resetPassword.passwordLabel'))}</label>
            <input class="input" type="password" id="password" name="password"
              autocomplete="new-password" required />
          </div>
          <div class="form-group">
            <label class="label" for="confirm">${esc(t('resetPassword.confirmLabel'))}</label>
            <input class="input" type="password" id="confirm" name="confirm"
              autocomplete="new-password" required />
          </div>
          <div class="login-error" id="reset-error" role="alert" aria-live="polite" hidden></div>
          <div class="login-success" id="reset-success" role="status" aria-live="polite" hidden></div>
          <button type="submit" class="btn btn--primary login-form__submit" id="reset-btn">
            ${esc(t('resetPassword.submit'))}
          </button>
        </form>
        <p class="login-form__forgot"><a href="/login" data-link>${esc(t('forgotPassword.backToLogin'))}</a></p>
      </div>
    </main>
  `);

  const form = container.querySelector('#reset-form');
  const errorEl = container.querySelector('#reset-error');
  const successEl = container.querySelector('#reset-success');
  const btn = container.querySelector('#reset-btn');
  wireLinks(container);

  const show = (el, msg) => { el.textContent = msg; el.hidden = false; };

  if (!token) { show(errorEl, t('resetPassword.missingToken')); btn.disabled = true; return; }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const password = form.password.value;
    const confirm = form.confirm.value;
    if (password.length < 8) { show(errorEl, t('resetPassword.tooShort')); return; }
    if (password !== confirm) { show(errorEl, t('resetPassword.mismatch')); return; }
    btn.disabled = true;
    try {
      await auth.resetPassword(token, password);
      form.hidden = true;
      show(successEl, t('resetPassword.success'));
      setTimeout(() => window.oikos.navigate('/login'), 1500);
    } catch (err) {
      show(errorEl, t('resetPassword.invalidToken'));
      btn.disabled = false;
    }
  });
}
