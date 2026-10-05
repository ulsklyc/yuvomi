/**
 * Modul: Passwort-vergessen-Seite
 * Zweck: Benutzername/E-Mail entgegennehmen und Reset-Link anfordern (anti-enumeration).
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 */
import { auth } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { authHeroHtml } from '/utils/auth-ui.js';

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
  // Ein Reset, den dieser Server nicht durchfuehren kann, ist eine Sackgasse -
  // ohne SMTP/BASE_URL ebenso wie mit SSO als einzigem Anmeldeweg (#847). Die
  // Anmeldeseite blendet den Link dann schon aus; wer die Adresse direkt
  // aufruft, bekommt hier den Grund statt eines Formulars, dessen Absenden
  // folgenlos bliebe.
  //
  // Bewusst eine Auskunft und kein `navigate('/login')`: der Router verwirft
  // eine Navigation, die aus einem laufenden `render()` heraus startet
  // (`isNavigating`), und zurueck bliebe eine leere Seite. Ein Weiterschicken
  // ohne Begruendung waere hier ohnehin das schlechtere Verhalten - wer auf
  // "Passwort vergessen" geklickt hat, will wissen, warum das nicht geht.
  if (!(await auth.passwordResetAvailable())) {
    renderUnavailable(container);
    return;
  }

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <main class="auth-page" id="main-content">
      ${authHeroHtml({ heading: false })}
      <div class="auth-card card card--padded">
        <h1 class="auth-card__title">${esc(t('forgotPassword.title'))}</h1>
        <p class="auth-card__intro">${esc(t('forgotPassword.intro'))}</p>
        <form class="auth-form" id="forgot-form" novalidate>
          <div class="form-group">
            <label class="label" for="identifier">${esc(t('forgotPassword.identifierLabel'))}</label>
            <input class="input" type="text" id="identifier" name="identifier"
              autocomplete="username" autocapitalize="none" autocorrect="off" required />
          </div>
          <div class="form-success" id="forgot-success" role="status" aria-live="polite" hidden></div>
          <button type="submit" class="btn btn--primary auth-form__submit" id="forgot-btn">
            ${esc(t('forgotPassword.submit'))}
          </button>
        </form>
        <p class="auth-form__forgot"><a href="/login" data-link>${esc(t('forgotPassword.backToLogin'))}</a></p>
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
