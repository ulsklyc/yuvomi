/**
 * Modul: Einladung-annehmen-Seite
 * Zweck: Einladungstoken aus der URL prüfen und das eigene Konto anlegen.
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 */
import { auth } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { authHeroHtml, authErrorHtml, wirePasswordToggle } from '/utils/auth-ui.js';

// Dieselbe Regel wie im Server (POST /auth/invites/accept). Sie hier zu spiegeln
// erspart dem Nutzer ein 400, das sich sonst nicht von einem toten Token
// unterscheiden ließe.
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,64}$/;
// Ebenfalls aus dem Server gespiegelt. Ohne diese Prüfung käme ein zu langer
// Anzeigename als 400 zurück und sähe unten aus wie ein toter Token.
const MAX_DISPLAY_NAME = 128;

function wireLinks(container) {
  container.querySelectorAll('a[data-link]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); window.yuvomi.navigate(a.getAttribute('href')); }));
}

export async function render(container) {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <main class="auth-page" id="main-content">
      ${authHeroHtml({ heading: false })}
      <div class="auth-card card card--padded">
        <h1 class="auth-card__title">${esc(t('join.title'))}</h1>
        <p class="auth-card__intro" id="join-intro">${esc(t('join.intro'))}</p>
        ${authErrorHtml('join-error')}
        <div class="form-success" id="join-success" role="status" aria-live="polite" hidden></div>
        <form class="auth-form" id="join-form" novalidate>
          <div class="form-group">
            <label class="label" for="join-username">${esc(t('join.usernameLabel'))}</label>
            <input class="input" type="text" id="join-username" name="username"
              autocomplete="username" autocapitalize="none" spellcheck="false" required />
            <p class="auth-form__hint" id="join-username-hint" hidden>${esc(t('join.fieldFixed'))}</p>
          </div>
          <div class="form-group">
            <label class="label" for="join-display-name">${esc(t('join.displayNameLabel'))}</label>
            <input class="input" type="text" id="join-display-name" name="displayName"
              autocomplete="name" maxlength="128" />
            <p class="auth-form__hint" id="join-display-name-hint" hidden>${esc(t('join.fieldFixed'))}</p>
          </div>
          <div class="form-group" id="join-password-group">
            <label class="label" for="join-password">${esc(t('join.passwordLabel'))}</label>
            <input class="input" type="password" id="join-password" name="password"
              autocomplete="new-password" required />
          </div>
          <div class="form-group" id="join-confirm-group">
            <label class="label" for="join-confirm">${esc(t('join.confirmLabel'))}</label>
            <input class="input" type="password" id="join-confirm" name="confirm"
              autocomplete="new-password" required />
          </div>
          <button type="submit" class="btn btn--primary auth-form__submit" id="join-btn">
            ${esc(t('join.submit'))}
          </button>
        </form>
        <p class="auth-form__forgot"><a href="/login" data-link>${esc(t('forgotPassword.backToLogin'))}</a></p>
      </div>
    </main>
  `);

  const intro = container.querySelector('#join-intro');
  const form = container.querySelector('#join-form');
  const errorEl = container.querySelector('#join-error');
  const successEl = container.querySelector('#join-success');
  const btn = container.querySelector('#join-btn');
  const usernameEl = container.querySelector('#join-username');
  // Das Auge an beiden Passwortfeldern (utils/auth-ui.js): ein NEUES Passwort
  // tippte man hier zweimal blind.
  const eye = { show: t('login.showPassword'), hide: t('login.hidePassword') };
  wirePasswordToggle(container.querySelector('#join-password'), eye);
  wirePasswordToggle(container.querySelector('#join-confirm'), eye);
  const usernameHint = container.querySelector('#join-username-hint');
  const displayNameEl = container.querySelector('#join-display-name');
  const displayNameHint = container.querySelector('#join-display-name-hint');
  wireLinks(container);

  const show = (el, msg) => { el.textContent = msg; el.hidden = false; };
  // Der Fokus wandert in die Fehlermeldung, damit auch sehende Tastaturnutzer
  // sie bemerken und nicht nur Screenreader über role="alert" (wie login.js).
  const fail = (msg) => { show(errorEl, msg); errorEl.focus(); };
  // Ein toter Token macht das Formular sinnlos: nur die Meldung bleibt stehen.
  const dead = (msg) => { fail(msg); form.hidden = true; intro.hidden = true; };

  if (!token) { dead(t('join.missingToken')); return; }

  // Bis die Vorschau da ist, steht noch nicht fest, ob und mit welchen Vorgaben
  // die Einladung gilt.
  btn.disabled = true;
  let preview;
  try {
    preview = (await auth.previewInvite(token))?.data;
  } catch {
    // Nur `valid: false` heißt "Token unbrauchbar". Ein Rate-Limit (429), ein
    // Serverfehler oder eine abgerissene Verbindung sind vorübergehend, und wer
    // dann "Einladung ungültig" liest, wirft einen intakten Link weg. Das
    // Formular bleibt trotzdem zu: ohne Vorschau sind die Vorgaben unbekannt.
    dead(t('join.previewFailed'));
    return;
  }
  if (!preview?.valid) { dead(t('join.invalidToken')); return; }
  btn.disabled = false;

  // Was die Einladung vorgibt, steht fest: der Server nimmt ohnehin ihre Werte.
  // Das Feld wird deshalb schreibgeschützt UND sichtbar als vorgegeben markiert -
  // ein Feld, das aussieht wie ein Eingabefeld und keins annimmt, ist eine Falle.
  const fix = (field, hint, value) => {
    field.value = value;
    field.readOnly = true;
    field.classList.add('input--fixed');
    hint.hidden = false;
  };
  // Mit SSO als einzigem Anmeldeweg vergibt die Annahme kein Passwort (#847).
  // Zwei Pflichtfelder, deren Inhalt der Server verwirft, waeren schlimmer als
  // keine: der Eingeladene daechte, er haette eines gesetzt.
  const passwordRequired = preview.password_required !== false;
  if (!passwordRequired) {
    for (const id of ['#join-password-group', '#join-confirm-group']) {
      const group = container.querySelector(id);
      if (group) group.hidden = true;
    }
    for (const id of ['#join-password', '#join-confirm']) {
      const field = container.querySelector(id);
      if (field) { field.required = false; field.value = ''; }
    }
  }

  if (preview.username) fix(usernameEl, usernameHint, preview.username);
  if (preview.display_name) fix(displayNameEl, displayNameHint, preview.display_name);
  (preview.username ? displayNameEl : usernameEl).focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const username = usernameEl.value.trim();
    const displayName = displayNameEl.value.trim();
    const password = form.password.value;
    const confirm = form.confirm.value;

    if (!username) { fail(t('join.usernameRequired')); return; }
    if (!USERNAME_PATTERN.test(username)) { fail(t('join.usernameInvalid')); return; }
    if (displayName.length > MAX_DISPLAY_NAME) { fail(t('join.displayNameTooLong')); return; }
    if (passwordRequired) {
      // Wie der Server (normalizePassword): auf macOS/Firefox kommen Umlaute als
      // NFD an und zählen roh doppelt, nach NFC bleibt weniger übrig (#608).
      if (password.normalize('NFC').length < 8) { fail(t('join.tooShort')); return; }
      if (password !== confirm) { fail(t('join.mismatch')); return; }
    }

    btn.disabled = true;
    try {
      await auth.acceptInvite({
        token, username, display_name: displayName,
        ...(passwordRequired ? { password } : {}),
      });
      form.hidden = true;
      intro.hidden = true;
      show(successEl, t('join.success'));
      setTimeout(() => window.yuvomi.navigate('/login'), 1500);
    } catch (err) {
      if (err?.status === 409) {
        fail(t('join.usernameTaken'));
        btn.disabled = false;
        return;
      }
      // Ein 400 kann die Einladung meinen oder die Eingabe. Die Vorschau sagt,
      // welches von beidem: nur bei totem Token das Formular ausblenden, sonst
      // sperrte eine abgelehnte Eingabe den Eingeladenen dauerhaft aus.
      // Scheitert die Rückfrage selbst, gilt der Token als intakt: ein 429 darf
      // nicht dieselbe Wirkung haben wie ein abgelaufener Link.
      if (err?.status === 400) {
        const stillValid = await auth.previewInvite(token).then((r) => r?.data?.valid).catch(() => true);
        if (!stillValid) { dead(t('join.invalidToken')); return; }
      }
      fail(t('join.error'));
      btn.disabled = false;
    }
  });
}
