/**
 * Modul: Settings – E-Mail (SMTP)
 * Zweck: Admin-Konfiguration des SMTP-Servers inkl. Verbindungstest.
 * Abhängigkeiten: /api.js (email), /i18n.js, /utils/html.js
 */
import { email } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

const DEFAULTS = {
  host: '', port: 587, secure: 'starttls', user: '',
  fromAddress: '', fromName: 'Yuvomi', passwordSet: false,
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
      <h2 class="settings-section__title">${esc(t('settings.pageEmail'))}</h2>
      <div class="settings-card">
        <form class="settings-form" id="email-form" novalidate>
          <div class="form-group">
            <label class="label" for="email-host">${esc(t('email.host'))}</label>
            <input class="input" id="email-host" name="host" value="${esc(cfg.host)}" autocomplete="off" />
          </div>
          <div class="form-group">
            <label class="label" for="email-port">${esc(t('email.port'))}</label>
            <input class="input" id="email-port" name="port" type="number" inputmode="numeric"
              value="${esc(String(cfg.port))}" />
          </div>
          <div class="form-group">
            <label class="label" for="email-secure">${esc(t('email.security'))}</label>
            <select class="input" id="email-secure" name="secure">
              <option value="ssl">${esc(t('email.securitySsl'))}</option>
              <option value="starttls">${esc(t('email.securityStarttls'))}</option>
              <option value="none">${esc(t('email.securityNone'))}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="label" for="email-user">${esc(t('email.user'))}</label>
            <input class="input" id="email-user" name="user" value="${esc(cfg.user)}" autocomplete="off" />
          </div>
          <div class="form-group">
            <label class="label" for="email-pass">${esc(t('email.password'))}</label>
            <input class="input" id="email-pass" name="pass" type="password" autocomplete="new-password"
              placeholder="${cfg.passwordSet ? '••••••••' : ''}" />
            <p class="form-hint">${esc(t('email.passwordKeep'))}</p>
          </div>
          <div class="form-group">
            <label class="label" for="email-from">${esc(t('email.fromAddress'))}</label>
            <input class="input" id="email-from" name="fromAddress" type="email" value="${esc(cfg.fromAddress)}" />
          </div>
          <div class="form-group">
            <label class="label" for="email-fromname">${esc(t('email.fromName'))}</label>
            <input class="input" id="email-fromname" name="fromName" value="${esc(cfg.fromName)}" />
          </div>
          <div class="settings-notice" id="email-notice" role="status" aria-live="polite" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary" id="email-save">${esc(t('email.save'))}</button>
            <button type="button" class="btn btn--secondary" id="email-test">${esc(t('email.test'))}</button>
          </div>
        </form>
      </div>
    </section>
  `);

  const form = container.querySelector('#email-form');
  form.secure.value = cfg.secure;
  const notice = container.querySelector('#email-notice');
  const saveBtn = container.querySelector('#email-save');
  const testBtn = container.querySelector('#email-test');

  const show = (msg) => { notice.textContent = msg; notice.hidden = false; };

  function collect() {
    const body = {
      host: form.host.value.trim(),
      secure: form.secure.value,
      user: form.user.value.trim(),
      fromAddress: form.fromAddress.value.trim(),
      fromName: form.fromName.value.trim(),
    };
    const port = Number.parseInt(form.port.value, 10);
    if (Number.isFinite(port)) body.port = port;
    if (form.pass.value) body.pass = form.pass.value;
    return body;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    try {
      await email.saveConfig(collect());
      form.pass.value = '';
      show(t('email.saved'));
    } catch (_) {
      show(t('email.testFailed', { error: '' }));
    } finally {
      saveBtn.disabled = false;
    }
  });

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    try {
      await email.saveConfig(collect()); // persist before testing
      const res = (await email.test())?.data;
      show(res?.ok ? t('email.testSuccess') : t('email.testFailed', { error: res?.error || '' }));
    } catch (_) {
      show(t('email.testFailed', { error: '' }));
    } finally {
      testBtn.disabled = false;
    }
  });
}
