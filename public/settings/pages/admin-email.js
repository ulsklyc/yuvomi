/**
 * Modul: Settings – E-Mail (SMTP)
 * Zweck: Admin-Konfiguration des SMTP-Servers inkl. Verbindungstest.
 * Abhängigkeiten: /api.js (email), /i18n.js, /utils/html.js
 */
import { email } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { createInlineError } from '/settings/components.js';

const DEFAULTS = {
  host: '', port: 587, secure: 'starttls', user: '',
  fromAddress: '', fromName: 'Yuvomi', passwordSet: false, envControlled: {},
};

// Formularfeld je Konfigurationsfeld. Dieselben Namen wie CONFIG_KEYS in
// server/services/email.js, damit env_controlled 1:1 zuzuordnen ist.
const FIELD_IDS = {
  host: 'email-host',
  port: 'email-port',
  secure: 'email-secure',
  user: 'email-user',
  pass: 'email-pass',
  fromAddress: 'email-from',
  fromName: 'email-fromname',
};

export async function render(container, { user } = {}) {
  let cfg = { ...DEFAULTS };
  try {
    const res = await email.getConfig();
    cfg = { ...DEFAULTS, ...(res?.data ?? {}) };
  } catch (_) {
    // Fall back to an empty form if the config cannot be loaded.
  }

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <div class="settings-card">
        <p class="form-hint">${esc(t('email.purposeHint'))}</p>
        <form class="settings-form" id="email-form" novalidate>
          <div class="form-group">
            <label class="label" for="email-host">${esc(t('email.host'))}</label>
            <input class="input" id="email-host" name="host" value="${esc(cfg.host)}" autocomplete="off" />
            <p class="form-hint" data-env-hint="host" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>
          </div>
          <div class="form-group">
            <label class="label" for="email-port">${esc(t('email.port'))}</label>
            <input class="input" id="email-port" name="port" type="number" inputmode="numeric"
              value="${esc(String(cfg.port))}" />
            <p class="form-hint" data-env-hint="port" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>
          </div>
          <div class="form-group">
            <label class="label" for="email-secure">${esc(t('email.security'))}</label>
            <select class="input" id="email-secure" name="secure">
              <option value="ssl">${esc(t('email.securitySsl'))}</option>
              <option value="starttls">${esc(t('email.securityStarttls'))}</option>
              <option value="none">${esc(t('email.securityNone'))}</option>
            </select>
            <p class="form-hint" data-env-hint="secure" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>
          </div>
          <div class="form-group">
            <label class="label" for="email-user">${esc(t('email.user'))}</label>
            <input class="input" id="email-user" name="user" value="${esc(cfg.user)}" autocomplete="off" />
            <p class="form-hint" data-env-hint="user" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>
          </div>
          <div class="form-group">
            <label class="label" for="email-pass">${esc(t('email.password'))}</label>
            <input class="input" id="email-pass" name="pass" type="password" autocomplete="new-password"
              placeholder="${cfg.passwordSet ? '••••••••' : ''}" />
            <p class="form-hint">${esc(t('email.passwordKeep'))}</p>
            <p class="form-hint" data-env-hint="pass" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>
          </div>
          <div class="form-group">
            <label class="label" for="email-from">${esc(t('email.fromAddress'))}</label>
            <input class="input" id="email-from" name="fromAddress" type="email" value="${esc(cfg.fromAddress)}" />
            <p class="form-hint" data-env-hint="fromAddress" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>
          </div>
          <div class="form-group">
            <label class="label" for="email-fromname">${esc(t('email.fromName'))}</label>
            <input class="input" id="email-fromname" name="fromName" value="${esc(cfg.fromName)}" />
            <p class="form-hint" data-env-hint="fromName" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>
          </div>
          <div id="email-notice"></div>
          <div class="settings-form-actions">
            <button type="button" class="btn btn--secondary" id="email-test">${esc(t('email.test'))}</button>
            <button type="submit" class="btn btn--primary" id="email-save">${esc(t('email.save'))}</button>
          </div>
        </form>
      </div>
    </section>
  `);

  const form = container.querySelector('#email-form');
  form.secure.value = cfg.secure;

  // env gewinnt über die Datenbank (server/services/email.js:resolve). Vorher
  // stand das nur im Code: die Seite zeigte Eingabefelder, speicherte in die
  // Datenbank, und der Wert wirkte nie - ohne jeden Hinweis. Was die Umgebung
  // bestimmt, ist jetzt sichtbar gesperrt, Feld für Feld.
  const envControlled = cfg.envControlled ?? {};
  for (const [field, id] of Object.entries(FIELD_IDS)) {
    const controlled = envControlled[field] === true;
    const input = container.querySelector(`#${id}`);
    if (input) {
      input.readOnly = controlled && input.tagName !== 'SELECT';
      input.disabled = controlled;
    }
    const hint = container.querySelector(`[data-env-hint="${field}"]`);
    if (hint) hint.hidden = !controlled;
  }

  const notice = container.querySelector('#email-notice');
  const saveBtn = container.querySelector('#email-save');
  const testBtn = container.querySelector('#email-test');

  // Vorher trug dieses Feld die Klasse `settings-notice`, die in
  // `public/styles/` nie existiert hat: für Screenreader ein `role="status"`,
  // für Sehende ein nackter Textknoten mitten im Formular (Critique
  // 2026-07-27). Erfolg meldet jetzt der Toast wie in jedem anderen Blatt,
  // Fehler bleiben als `createInlineError` am Formular stehen.
  const showError = (msg) => notice.replaceChildren(createInlineError(msg));
  const showSuccess = (msg) => {
    notice.replaceChildren();
    window.yuvomi?.showToast(msg, 'success');
  };

  function collect() {
    // Gesperrte Felder gar nicht erst mitschicken. Der Server ignoriert sie
    // ohnehin; sie wegzulassen hält die Absicht des Formulars ehrlich.
    const free = field => envControlled[field] !== true;
    const body = {};
    if (free('host')) body.host = form.host.value.trim();
    if (free('secure')) body.secure = form.secure.value;
    if (free('user')) body.user = form.user.value.trim();
    if (free('fromAddress')) body.fromAddress = form.fromAddress.value.trim();
    if (free('fromName')) body.fromName = form.fromName.value.trim();
    if (free('port')) {
      const port = Number.parseInt(form.port.value, 10);
      if (Number.isFinite(port)) body.port = port;
    }
    if (free('pass') && form.pass.value) body.pass = form.pass.value;
    return body;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    try {
      await email.saveConfig(collect());
      form.pass.value = '';
      showSuccess(t('email.saved'));
    } catch (error) {
      // Eigener Key: hier ist nichts getestet worden, nur gespeichert.
      showError(t('email.saveFailed', { error: error?.message || t('common.errorGeneric') }));
    } finally {
      saveBtn.disabled = false;
    }
  });

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    try {
      await email.saveConfig(collect()); // persist before testing
      const res = (await email.test())?.data;
      if (res?.ok) showSuccess(t('email.testSuccess'));
      else showError(t('email.testFailed', { error: res?.error || t('common.errorGeneric') }));
    } catch (error) {
      showError(t('email.testFailed', { error: error?.message || t('common.errorGeneric') }));
    } finally {
      testBtn.disabled = false;
    }
  });
}
