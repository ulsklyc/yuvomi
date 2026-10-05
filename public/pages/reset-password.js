/**
 * Modul: Passwort-zuruecksetzen-Seite
 * Zweck: Token aus der URL lesen, neues Passwort setzen.
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 */
import { auth } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { authHeroHtml, authErrorHtml, wirePasswordToggle } from '/utils/auth-ui.js';

function wireLinks(container) {
  container.querySelectorAll('a[data-link]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); window.yuvomi.navigate(a.getAttribute('href')); }));
}

/**
 * Zeigt, dass dieser Server keinen Passwort-Reset anbieten kann, und schickt
 * den Weg zurueck mit. Geteilt von beiden Reset-Seiten (#847).
 * @param {HTMLElement} container
 */
function renderUnavailable(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <main class="auth-page" id="main-content">
      ${authHeroHtml({ heading: false })}
      <div class="auth-card card card--padded">
        <h1 class="auth-card__title">${esc(t('forgotPassword.title'))}</h1>
        <p class="auth-card__intro">${esc(t('forgotPassword.unavailable'))}</p>
        <p class="auth-form__forgot"><a href="/login" data-link>${esc(t('forgotPassword.backToLogin'))}</a></p>
      </div>
    </main>
  `);
  wireLinks(container);
}

export async function render(container) {
  // Hier zaehlt NICHT die Zustellbarkeit einer Mail, sondern ob es ueberhaupt
  // Passwoerter gibt (#847). Der Unterschied ist der eigentliche Zweck dieser
  // Seite: wer sie aufruft, hat seine Mail bereits bekommen. Haetten wir wie
  // die Vorgaengerseite auf `password_reset_enabled` geprueft, sperrte eine
  // zwischenzeitlich abgeschaltete oder kurz nicht erreichbare SMTP einen
  // gueltigen Token aus, den der Server bereitwillig eingeloest haette.
  //
  // Bewusst eine Auskunft und kein `navigate('/login')`: der Router verwirft
  // eine Navigation, die aus einem laufenden `render()` heraus startet
  // (`isNavigating`), und zurueck bliebe eine leere Seite.
  if (!(await auth.passwordLoginEnabled())) {
    renderUnavailable(container);
    return;
  }

  const token = new URLSearchParams(window.location.search).get('token') || '';
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <main class="auth-page" id="main-content">
      ${authHeroHtml({ heading: false })}
      <div class="auth-card card card--padded">
        <h1 class="auth-card__title">${esc(t('resetPassword.title'))}</h1>
        <!-- Beide Meldungen stehen außerhalb des Formulars: der Erfolgsfall
             blendet das Formular aus, und ein Kind davon wäre mit ihm weg. -->
        ${authErrorHtml('reset-error')}
        <div class="form-success" id="reset-success" role="status" aria-live="polite" hidden></div>
        <form class="auth-form" id="reset-form" novalidate>
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
          <button type="submit" class="btn btn--primary auth-form__submit" id="reset-btn">
            ${esc(t('resetPassword.submit'))}
          </button>
        </form>
        <p class="auth-form__forgot"><a href="/login" data-link>${esc(t('forgotPassword.backToLogin'))}</a></p>
      </div>
    </main>
  `);

  const form = container.querySelector('#reset-form');
  const errorEl = container.querySelector('#reset-error');
  const successEl = container.querySelector('#reset-success');
  const btn = container.querySelector('#reset-btn');
  // Das Auge an beiden Passwortfeldern (utils/auth-ui.js).
  const eye = { show: t('login.showPassword'), hide: t('login.hidePassword') };
  wirePasswordToggle(form.querySelector('#password'), eye);
  wirePasswordToggle(form.querySelector('#confirm'), eye);
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
      setTimeout(() => window.yuvomi.navigate('/login'), 1500);
    } catch (err) {
      show(errorEl, t('resetPassword.invalidToken'));
      btn.disabled = false;
    }
  });
}
