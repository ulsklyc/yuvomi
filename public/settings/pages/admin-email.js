/**
 * Modul: Settings – E-Mail (SMTP)
 * Zweck: Admin-Konfiguration des SMTP-Servers inkl. Verbindungstest.
 * Abhängigkeiten: /api.js (email), /i18n.js, /utils/html.js
 */
import { email } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { createInlineError, settingRowHtml } from '/settings/components.js';
import { reportFieldError, reportFieldErrors } from '/components/modal.js';
import { errorSentence } from '/utils/friendly-error.js';

// Dieselbe Pruefung wie server/routes/email.js (emailConfigRefusal): der
// Server lehnt ab, die Seite sagt es schon vorher und am Feld.
const PORT_MIN = 1;
const PORT_MAX = 65535;
const FROM_ADDRESS_RE = /^[^\s@]+@[^\s@]+$/;

/** Fall der fehlgeschlagenen Testmail (services/email.js smtpFailureReason) -> Satz. */
const TEST_FAILURE_KEYS = {
  not_configured: 'email.testFailedNotConfigured',
  auth: 'email.testFailedAuth',
  connection: 'email.testFailedConnection',
  tls: 'email.testFailedTls',
  rejected: 'email.testFailedRejected',
};

/** Absage des Servers (server/routes/email.js) -> [Feld, Schluessel]. */
const REFUSAL_FIELDS = {
  email_port_invalid: ['port', 'email.portInvalid'],
  email_from_invalid: ['fromAddress', 'common.emailInvalid'],
};

const fieldMessage = (key) => t(key, { min: PORT_MIN, max: PORT_MAX });

/**
 * Was die Seite nicht schicken darf, als `[feld, schluessel]`. Der Port ist
 * eine ganze Zahl von 1 bis 65535 (auch leer ist er falsch: ohne Port gibt es
 * keine Verbindung), der Absender leer oder eine Adresse. Gesperrte Felder
 * (Umgebung) prueft sie nicht - sie werden nicht geschickt.
 * @returns {Array<['port'|'fromAddress', string]>}
 */
function emailConfigProblems({ port, fromAddress }, envControlled = {}) {
  const problems = [];
  const portRaw = String(port ?? '').trim();
  const portNum = Number(portRaw);
  if (envControlled.port !== true
    && (portRaw === '' || !Number.isInteger(portNum) || portNum < PORT_MIN || portNum > PORT_MAX)) {
    problems.push(['port', 'email.portInvalid']);
  }
  const from = String(fromAddress ?? '').trim();
  if (envControlled.fromAddress !== true && from !== '' && !FROM_ADDRESS_RE.test(from)) {
    problems.push(['fromAddress', 'common.emailInvalid']);
  }
  return problems;
}

/** Fall der fehlgeschlagenen Testmail -> Schluessel; ein unbekannter Fall bekommt den allgemeinen Satz. */
function testFailureKey(reason) {
  return Object.prototype.hasOwnProperty.call(TEST_FAILURE_KEYS, reason ?? '') ? TEST_FAILURE_KEYS[reason] : 'email.testFailedUnknown';
}

export const __test = { emailConfigProblems, testFailureKey, REFUSAL_FIELDS };

/** Der Pfad des Kontoblatts, auf das die Testmail ohne eigene Adresse verweist. */
const ACCOUNT_PATH = '/settings/personal/account';

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
      ${/* EIN FORMULAR-DIALEKT (R19, Critique 2026-10-16, Einstellungen B7):
           hier standen sieben Felder UNTER ihren Etiketten in einer Karte -
           der zweite Dialekt neben den gruppierten Zeilen der anderen Blaetter
           (Kueche, Darstellung). Jetzt Zeilen im Traeger: Etikett links, Feld
           rechts, Hinweise darunter; der Zweck steht als Fuss der Gruppe. */ ''}
      <form class="settings-form" id="email-form" novalidate>
        <div class="row-carrier settings-group">
          ${settingRowHtml({
            label: t('email.host'), labelFor: 'email-host',
            control: `<input class="form-input" id="email-host" name="host" value="${esc(cfg.host)}" autocomplete="off" />`,
            extra: `<p class="form-hint" data-env-hint="host" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>`,
          })}
          ${settingRowHtml({
            label: t('email.port'), labelFor: 'email-port', field: true,
            control: `<input class="form-input" id="email-port" name="port" type="number" inputmode="numeric" min="${PORT_MIN}" max="${PORT_MAX}" step="1" value="${esc(String(cfg.port))}" />`,
            extra: `<p class="form-hint" data-env-hint="port" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>`,
          })}
          ${settingRowHtml({
            label: t('email.security'), labelFor: 'email-secure',
            control: `<select class="form-input" id="email-secure" name="secure">
              <option value="ssl">${esc(t('email.securitySsl'))}</option>
              <option value="starttls">${esc(t('email.securityStarttls'))}</option>
              <option value="none">${esc(t('email.securityNone'))}</option>
            </select>`,
            extra: `<p class="form-hint" data-env-hint="secure" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>`,
          })}
          ${settingRowHtml({
            label: t('email.user'), labelFor: 'email-user',
            control: `<input class="form-input" id="email-user" name="user" value="${esc(cfg.user)}" autocomplete="off" />`,
            extra: `<p class="form-hint" data-env-hint="user" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>`,
          })}
          ${settingRowHtml({
            label: t('email.password'), labelFor: 'email-pass',
            description: t('email.passwordKeep'),
            descriptionId: 'email-pass-hint',
            control: `<input class="form-input" id="email-pass" name="pass" type="password" autocomplete="new-password" aria-describedby="email-pass-hint" placeholder="${cfg.passwordSet ? '••••••••' : ''}" />`,
            extra: `<p class="form-hint" data-env-hint="pass" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>`,
          })}
          ${settingRowHtml({
            label: t('email.fromAddress'), labelFor: 'email-from', field: true,
            control: `<input class="form-input" id="email-from" name="fromAddress" type="email" value="${esc(cfg.fromAddress)}" />`,
            extra: `<p class="form-hint" data-env-hint="fromAddress" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>`,
          })}
          ${settingRowHtml({
            label: t('email.fromName'), labelFor: 'email-fromname',
            control: `<input class="form-input" id="email-fromname" name="fromName" value="${esc(cfg.fromName)}" />`,
            extra: `<p class="form-hint" data-env-hint="fromName" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>`,
          })}
        </div>
        <p class="form-hint settings-group__footer">${esc(t('email.purposeHint'))}</p>
        <div id="email-notice"></div>
        <div class="settings-form-actions">
          <button type="button" class="btn btn--secondary" id="email-test">${esc(t('email.test'))}</button>
          <button type="submit" class="btn btn--primary" id="email-save">${esc(t('email.save'))}</button>
        </div>
      </form>
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

  /**
   * Prueft, was die Seite schicken wuerde (Re-Critique 2026-10-17: Port 99999
   * und der Absender "keine-mail" wurden mit "gespeichert" quittiert). Meldet
   * am Feld und gibt false zurueck, wenn etwas nicht stimmt. Gesperrte Felder
   * (Umgebung) prueft sie nicht - sie werden nicht geschickt.
   */
  function validate() {
    const problems = emailConfigProblems({ port: form.port.value, fromAddress: form.fromAddress.value }, envControlled);
    return !reportFieldErrors(problems.map(([field, key]) => [form[field], fieldMessage(key)]));
  }

  /** Eine Absage des Servers zum Feld - true, wenn sie dort steht. */
  function refusalAtField(error) {
    const field = REFUSAL_FIELDS[error?.data?.reason];
    if (!field) return false;
    reportFieldError(form[field[0]], fieldMessage(field[1]));
    return true;
  }

  /** Testmail ohne eigene Adresse: der Satz und der Weg dorthin. */
  function showNoRecipient() {
    const error = createInlineError(t('email.testNoRecipient'));
    const link = document.createElement('a');
    link.href = ACCOUNT_PATH;
    link.setAttribute('data-nav', '');
    link.textContent = t('email.testNoRecipientLink');
    error.append(' ', link);
    notice.replaceChildren(error);
  }

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
    notice.replaceChildren();
    if (!validate()) return;
    saveBtn.disabled = true;
    try {
      await email.saveConfig(collect());
      form.pass.value = '';
      showSuccess(t('email.saved'));
    } catch (error) {
      // Eigener Key: hier ist nichts getestet worden, nur gespeichert. Der
      // Satz der App, nie der englische Text des Servers.
      if (!refusalAtField(error)) showError(t('email.saveFailed', { error: errorSentence(error) }));
    } finally {
      saveBtn.disabled = false;
    }
  });

  testBtn.addEventListener('click', async () => {
    notice.replaceChildren();
    if (!validate()) return;
    testBtn.disabled = true;
    try {
      await email.saveConfig(collect()); // persist before testing
      const res = (await email.test())?.data;
      // Der Fall, nicht der Text von nodemailer ("Invalid login: 535 ..."):
      // er stand englisch auf einer deutschen Seite (Re-Critique 2026-10-17).
      if (res?.ok) showSuccess(t('email.testSuccess'));
      else showError(t(testFailureKey(res?.reason)));
    } catch (error) {
      if (refusalAtField(error)) return;
      if (error?.data?.reason === 'email_no_recipient') showNoRecipient();
      else showError(t('email.testFailed', { error: errorSentence(error) }));
    } finally {
      testBtn.disabled = false;
    }
  });
}
