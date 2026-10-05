/**
 * Modul: Login-Seite
 * Zweck: Anmeldeformular mit Username/Passwort, Fehlerbehandlung, Session-Start
 * Abhängigkeiten: /api.js
 */

import { auth } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { authHeroHtml, authErrorHtml, wirePasswordToggle } from '/utils/auth-ui.js';

const VERSION_URL = '/api/v1/version';
const DEFAULT_APP_NAME = 'Yuvomi';
const APP_NAME_STORAGE_KEY = 'yuvomi-app-name';

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
 * Rendert die Login-Seite in den gegebenen Container.
 * @param {HTMLElement} container
 */
export async function render(container) {
  const storedAppName = getStoredAppName();

  // SSO-Kapabilität VOR dem ersten Paint ermitteln, damit der SSO-Block nicht
  // nachträglich einspringt und das zentrierte Formular verschiebt (Layout-Shift).
  // Gebändigt per Timeout, sodass ein langsamer/nicht erreichbarer Server das
  // Passwort-Login nie blockiert – dann wird ohne SSO gerendert.
  const oidc = await fetchOidcConfig();
  const ssoEnabled = oidc?.enabled === true;
  // SSO als einziger Weg hinein (#847). Bewusst an `ssoEnabled` gekoppelt: eine
  // Anmeldeseite ganz ohne Weg hinein waere schlimmer als eine mit einem zu
  // viel. Der Server haelt dieselbe Regel, hier ist sie nur die Anzeige davon -
  // faellt der Aufruf aus (`oidc === null`), bleibt es beim Formular.
  const passwordLoginEnabled = !(ssoEnabled && oidc?.password_login_enabled === false);
  // Der zweite Weg hinein gilt AUSSCHLIESSLICH den Gaesten aus den geteilten
  // Ausgaben (#847). Ein Haushalt ohne einen einzigen solchen Gast sah ihn
  // trotzdem und las ihn als Loch im Riegel, den er gerade zugemacht hatte
  // (#962). Die Frage stellt der Server, weil nur er sie beantworten kann - und
  // er beantwortet sie mit einem Bit, nicht mit einer Gaesteliste.
  const guestPasswordLoginEnabled = oidc?.guest_password_login_enabled === true;

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <main class="auth-page" id="main-content">
      ${authHeroHtml({ appName: storedAppName, tagline: t('login.tagline') })}
      <div class="auth-card card card--padded">
        ${!passwordLoginEnabled ? `
        <div class="auth-form" id="sso-only-block">
          <p class="auth-form__sso-only">${esc(t('login.ssoOnlyHint'))}</p>
          <a href="/api/v1/auth/oidc/start" class="btn btn--primary auth-form__submit">${esc(t('login.loginWithSso'))}</a>
          ${guestPasswordLoginEnabled ? `
          <p class="auth-form__forgot">
            <button type="button" class="auth-linkish" id="show-password-form">${esc(t('login.guestPasswordLogin'))}</button>
          </p>
          ` : ''}
        </div>
        ` : ''}
        <form class="auth-form" id="auth-form" novalidate ${!passwordLoginEnabled ? 'hidden' : ''}>
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
              required
            />
            <p class="auth-capslock" id="auth-capslock" role="status" hidden>
              <i data-lucide="arrow-up" aria-hidden="true"></i>
              <span>${esc(t('login.capsLockWarning'))}</span>
            </p>
          </div>

          ${authErrorHtml('form-error')}

          <button type="submit" class="btn btn--primary auth-form__submit" id="auth-btn">
            <span class="auth-btn__label">${esc(t('login.loginButton'))}</span>
          </button>
          ${ssoEnabled && passwordLoginEnabled ? `
          <div class="auth-divider">${esc(t('login.orDivider'))}</div>
          <a href="/api/v1/auth/oidc/start" class="btn btn--secondary auth-form__submit">${esc(t('login.loginWithSso'))}</a>
          ` : ''}
          <p class="auth-form__forgot" hidden>
            <a href="/forgot-password" data-link>${esc(t('login.forgotPassword'))}</a>
          </p>
        </form>
      </div>
      <p class="auth-version" id="auth-version"></p>
    </main>
  `);

  // Der SSO-Weg landet mit `?two_factor=1` hier: der Provider hat den Browser
  // umgeleitet, es gibt noch keine Sitzung, aber einen Wartezustand auf dem
  // Server (#672). Ohne diesen Zweig staende der Nutzer vor einem leeren
  // Anmeldeformular und wuesste nicht, dass ihm nur noch der Code fehlt.
  if (new URLSearchParams(location.search).has('two_factor')) {
    // Die Marke aus der Adresszeile nehmen, damit ein Neuladen sie nicht wiederholt.
    history.replaceState(null, '', location.pathname);
    renderSecondFactor(container, { recoveryAvailable: true });
    return;
  }

  const form = container.querySelector('#auth-form');
  const errorEl = container.querySelector('#form-error');
  const submitBtn = container.querySelector('#auth-btn');

  container.querySelectorAll('a[data-link]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); window.yuvomi.navigate(a.getAttribute('href')); }));

  // OIDC-Fehlermeldung aus URL-Parameter anzeigen (z.B. ?error=oidc_failed nach gescheitertem Callback)
  const urlParams = new URLSearchParams(window.location.search);
  const ssoError = urlParams.get('error');
  if (ssoError?.startsWith('oidc_')) {
    // Ein abgewiesenes Anlegen ist KEIN Fehlschlag der Anmeldung (#654): beim
    // Anbieter hat alles funktioniert, hier fehlt nur das Konto. Die
    // Sammelmeldung schickt den Nutzer sonst zu seinem Passwort, statt zu dem,
    // der ihm ein Konto anlegen kann.
    // Ebenso ein Konto, das sich nicht anmelden darf (#243): dieselbe Absage
    // wie beim Passwort-Login. "Bitte erneut versuchen" liesse den Nutzer einen
    // Weg wiederholen, der nie aufgeht.
    // Zwei Absagen, bei denen die Adresse kein Konto eindeutig und sicher
    // benennt (GHSA-6pmj-w42g-g6qv): beide nennen den Weg, der weiterhilft,
    // statt "bitte erneut versuchen" - ein neuer Versuch endet genauso.
    const ssoMessage = new Map([
      ['oidc_signup_disabled', () => t('login.ssoNoAccount')],
      ['oidc_sign_in_blocked', () => t('login.accountCannotSignIn')],
      ['oidc_email_ambiguous', () => t('login.ssoEmailAmbiguous')],
      ['oidc_link_required', () => t('login.ssoLinkRequired')],
    ]).get(ssoError);
    showError(errorEl, ssoMessage ? ssoMessage() : t('login.ssoError'));
  }

  // Mit SSO als Hauptweg tritt das Formular zurueck, verschwindet aber NICHT
  // (#847): der Schalter gilt dem Haushalt, und die Gaeste aus den geteilten
  // Ausgaben sind keine - der Server laesst sie ausdruecklich weiter herein,
  // also braucht die Oberflaeche einen Weg fuer sie. Ein zweiter Klick ist der
  // Preis dafuer, dass der Haushalt SSO als DEN Weg sieht.
  container.querySelector('#show-password-form')?.addEventListener('click', (e) => {
    const form = container.querySelector('#auth-form');
    if (form) form.hidden = false;
    e.currentTarget.closest('p')?.remove();
    form?.querySelector('#username')?.focus();
  });

  // K3: Passwort-Sichtbarkeits-Toggle - der geteilte Baustein (utils/auth-ui.js).
  const passwordInput = form.querySelector('#password');
  wirePasswordToggle(passwordInput, { show: t('login.showPassword'), hide: t('login.hidePassword') });

  // Caps-Lock-Hinweis: eine aktive Feststelltaste ist die häufigste Ursache für
  // vermeintlich falsche Passwörter. Nur am Passwortfeld, nur solange aktiv.
  const capslockEl = container.querySelector('#auth-capslock');
  if (window.lucide) lucide.createIcons({ el: capslockEl });
  const updateCapsLock = (e) => {
    if (typeof e.getModifierState !== 'function') return;
    capslockEl.hidden = !e.getModifierState('CapsLock');
  };
  passwordInput.addEventListener('keydown', updateCapsLock);
  passwordInput.addEventListener('keyup', updateCapsLock);
  passwordInput.addEventListener('blur', () => { capslockEl.hidden = true; });

  setAppBranding(storedAppName);

  // Autofocus nur auf Zeigegeräten (Desktop): spart Rückkehrern den Klick, ohne
  // auf Touch sofort die virtuelle Tastatur hochzureißen und Hero/Branding zu
  // verdecken, bevor der Nutzer sich orientiert hat.
  if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
    container.querySelector('#username').focus();
  }

  hydrateFromVersion(container, storedAppName);

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
      // Nicht nur rote Rahmen: einen angesagten Grund nennen (auch für SR).
      showError(errorEl, t('login.fillAllFields'));
      if (!username) usernameInput.focus();
      else passwordInput.focus();
      return;
    }

    const labelEl = submitBtn.querySelector('.auth-btn__label');

    submitBtn.disabled = true;
    usernameInput.disabled = true;
    passwordInput.disabled = true;
    labelEl.textContent = t('login.loggingIn');
    const spinner = document.createElement('span');
    spinner.className = 'auth-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    submitBtn.insertBefore(spinner, labelEl);

    try {
      const result = await auth.login(username, password);
      // Zweiter Faktor (#672): der Server hat noch keine Sitzung angelegt und
      // schickt statt des Nutzers nur diese Marke. Das Formular tritt zurueck
      // und macht der Code-Eingabe Platz.
      if (result?.twoFactorRequired) {
        renderSecondFactor(container, { recoveryAvailable: result.recoveryAvailable === true });
        return;
      }
      window.yuvomi.navigate('/', result.user);
    } catch (err) {
      // Die Seite hat sich fuer das Formular entschieden, der Server lehnt es
      // ab: dann lagen ihr die Anmeldewege beim Zeichnen nicht vor (#847). Das
      // passiert, wenn `/auth/oidc/config` in ihr Zeitfenster nicht geantwortet
      // hat - sie faellt dann bewusst auf das Formular zurueck, was ohne SSO
      // richtig ist und mit SSO-only einen Weg zeigt, den es nicht gibt.
      //
      // Statt das im Voraus zu erraten, heilt die Antwort des Servers die
      // Anzeige: neu zeichnen holt die Konfiguration erneut und baut die
      // richtige Fassung. Keine Schleife - das passiert nur auf ein Absenden
      // hin, und der zweite Versuch fragt eine Adresse, die gerade geantwortet
      // hat.
      // NUR dieser eine Grund. `POST /login` antwortet auch mit 403, wenn ein
      // Konto der Haushaltshilfe gehoert - das ist eine dauerhafte Absage, und
      // ein Neuzeichnen wuerde sie verschlucken und den Nutzer vor dasselbe
      // Formular stellen, ohne ihm je zu sagen, warum es nicht geht.
      if (err.status === 403 && /password login is disabled/i.test(err.message || '')) {
        return render(container);
      }

      // Fehler-Ehrlichkeit: nur 401 heißt „falsche Zugangsdaten". 429 ist die
      // Sperre; alles andere (Status 0 = offline, 5xx = Serverfehler) ist ein
      // Verbindungsproblem – der Nutzer darf nicht fälschlich an sich zweifeln.
      let message;
      if (err.status === 429) message = t('login.tooManyAttempts');
      else if (err.status === 401) message = t('login.invalidCredentials');
      // Eine Absage ist kein Verbindungsproblem: wer „Verbindung fehlgeschlagen"
      // liest, versucht es weiter, statt sich an seine Verwaltung zu wenden.
      else if (err.status === 403) message = t('login.accountCannotSignIn');
      else message = t('login.networkError');
      showError(errorEl, message);

      if (err.status === 401) {
        // Beide Felder markieren (welches falsch ist, verrät der Server aus
        // Sicherheitsgründen nicht) und den Recovery-Weg sichtbar betonen.
        usernameGroup.classList.add('form-group--error');
        passwordGroup.classList.add('form-group--error');
        usernameInput.setAttribute('aria-invalid', 'true');
        passwordInput.setAttribute('aria-invalid', 'true');
        const forgot = container.querySelector('.auth-form__forgot');
        if (forgot && !forgot.hidden) forgot.classList.add('auth-form__forgot--emphasis');
      }

      // Fokus auf die Fehlermeldung, damit auch sehende Tastaturnutzer sie
      // bemerken (nicht nur Screenreader über role="alert").
      errorEl.focus();
    } finally {
      submitBtn.disabled = false;
      usernameInput.disabled = false;
      passwordInput.disabled = false;
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

/**
 * Zweiter Schritt der Anmeldung: die Code-Eingabe.
 *
 * Bewusst eine eigene Ansicht statt eines eingeblendeten Feldes im selben
 * Formular. Benutzername und Passwort sind an dieser Stelle bereits angenommen;
 * blieben sie sichtbar und aenderbar, waere unklar, worauf ein erneutes
 * Absenden sich bezieht - und der Passwortmanager wuerde ein zweites Mal
 * anbieten, dieselben Zugangsdaten zu speichern.
 *
 * @param {HTMLElement} container
 * @param {{ recoveryAvailable: boolean }} options
 */
function renderSecondFactor(container, { recoveryAvailable }) {
  const card = container.querySelector('.auth-card');
  if (!card) return;

  card.replaceChildren();
  card.insertAdjacentHTML('beforeend', `
    <form class="auth-form" id="two-factor-form" novalidate>
      <p class="auth-form__lead">${esc(t('login.twoFactorLead'))}</p>
      <div class="form-group">
        <label class="label" for="two-factor-code">${esc(t('login.twoFactorCodeLabel'))}</label>
        <input
          class="input auth-form__code"
          type="text"
          id="two-factor-code"
          name="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          autocapitalize="characters"
          spellcheck="false"
          maxlength="24"
          required
          aria-describedby="two-factor-hint"
        >
        <p class="form-hint" id="two-factor-hint">${esc(t(recoveryAvailable ? 'login.twoFactorHintRecovery' : 'login.twoFactorHint'))}</p>
      </div>
      ${authErrorHtml('two-factor-error')}
      <button type="submit" class="btn btn--primary auth-form__submit" id="two-factor-btn">
        <span class="auth-btn__label">${esc(t('login.twoFactorSubmit'))}</span>
      </button>
      <p class="auth-form__forgot">
        <a href="/login" data-link>${esc(t('login.twoFactorCancel'))}</a>
      </p>
    </form>
  `);

  const form   = card.querySelector('#two-factor-form');
  const input  = card.querySelector('#two-factor-code');
  const error  = card.querySelector('#two-factor-error');
  const button = card.querySelector('#two-factor-btn');
  const label  = button.querySelector('.auth-btn__label');

  input.focus();
  input.addEventListener('input', () => {
    error.hidden = true;
    input.removeAttribute('aria-invalid');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;

    const code = input.value.trim();
    if (!code) {
      showError(error, t('login.twoFactorMissing'));
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }

    button.disabled = true;
    input.disabled = true;
    label.textContent = t('login.twoFactorChecking');
    const spinner = document.createElement('span');
    spinner.className = 'auth-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    button.insertBefore(spinner, label);

    try {
      const result = await auth.verifyTwoFactor(code);
      window.yuvomi.navigate('/', result.user);
    } catch (err) {
      // 401 heisst hier zweierlei: falscher Code oder abgelaufener Wartezustand.
      // Der Unterschied zaehlt, weil das zweite nur durch einen neuen Anlauf
      // von vorn zu beheben ist.
      let message;
      if (err.status === 429) message = t('login.tooManyAttempts');
      else if (err.status === 401 && /pending/i.test(err.message || '')) message = t('login.twoFactorExpired');
      else if (err.status === 401) message = t('login.twoFactorInvalid');
      else message = t('login.networkError');
      showError(error, message);
      input.setAttribute('aria-invalid', 'true');
      error.focus();
    } finally {
      button.disabled = false;
      input.disabled = false;
      label.textContent = t('login.twoFactorSubmit');
      spinner.remove();
    }
  });
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

/**
 * Traegt Anwendungsname, Version und die Verfuegbarkeit des Passwort-Resets
 * nach, sobald `/version` geantwortet hat. Nicht blockierend: die Anmeldung
 * funktioniert auch, wenn dieser Aufruf ausbleibt.
 *
 * Geteilt von beiden Fassungen der Seite - der mit Formular und der mit
 * ausschliesslich SSO (#847). Der Reset-Link existiert in der zweiten gar
 * nicht, das `if` unten faellt dort schlicht ins Leere.
 *
 * @param {HTMLElement} container
 * @param {string} storedAppName  bereits angewandter Name, gegen Titel-Flackern
 */
function hydrateFromVersion(container, storedAppName) {
  fetch(VERSION_URL, { cache: 'no-store' })
    .then((r) => r.json())
    .then((d) => {
      if (d?.app_name) {
        try { localStorage.setItem(APP_NAME_STORAGE_KEY, d.app_name); } catch (_) {}
        // Nur neu anwenden, wenn sich der Name tatsächlich geändert hat –
        // verhindert ein sichtbares Titel-Flackern bei jedem Aufruf.
        if (d.app_name !== storedAppName) setAppBranding(d.app_name);
      }
      // „Passwort vergessen?" wie SSO gaten: nur anbieten, wenn der Server eine
      // Reset-Mail tatsächlich zustellen kann (SMTP + BASE_URL). Sonst Sackgasse.
      if (d?.password_reset_enabled) {
        const forgot = container.querySelector('.auth-form__forgot');
        if (forgot) forgot.hidden = false;
      }
      const versionEl = container.querySelector('#auth-version');
      if (versionEl) {
        versionEl.textContent = d?.version ? t('login.version', { version: d.version }) : '';
      }
    })
    .catch(() => {});
}

/**
 * Holt die OIDC/SSO-Kapabilität, bevor das Formular gerendert wird, damit der
 * SSO-Block bereits beim ersten Paint an Ort und Stelle ist (kein Layout-Shift).
 * Per AbortController-Timeout gebändigt: schlägt der Request fehl oder hängt er,
 * wird ohne SSO gerendert – das Passwort-Login darf nie am OIDC-Endpunkt hängen.
 * @param {number} timeoutMs
 * @returns {Promise<{enabled?: boolean}|null>}
 */
function fetchOidcConfig(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    fetch('/api/v1/auth/oidc/config', { cache: 'no-store', signal: controller.signal })
      .then((r) => r.json())
      .then((data) => { clearTimeout(timer); resolve(data); })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
}
