/**
 * Test: Feldfehler im Konto-Blatt und im E-Mail-Server-Blatt (Re-Critique 2026-10-17)
 * Zweck: Drei Befunde, ein Muster - der Fehler gehoert ans Feld:
 *        1. Ein falsches aktuelles Passwort warf zur Anmeldung (Server 401 ->
 *           api.js auth:expired). Der Server antwortet 400 `wrong_password`
 *           (test:password-normalization), die Seite stellt den Satz ans Feld.
 *        2. Das Konto-Blatt meldete nur ueber native Browser-Blasen
 *           (`required`/`minlength` ohne `novalidate`).
 *        3. Das SMTP-Blatt speicherte Port 99999 und den Absender "keine-mail"
 *           und zeigte den englischen Text von nodemailer.
 *        Gemessen werden die reinen Regeln (als Programm) und ihre Verdrahtung.
 * Ausfuehren: npm run test:account-form-errors
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };
const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();

const { __test: account } = await import('../public/settings/pages/personal-account.js');
const { __test: smtp } = await import('../public/settings/pages/admin-email.js');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const accountSrc = read('../public/settings/pages/personal-account.js');
const smtpSrc = read('../public/settings/pages/admin-email.js');
const de = JSON.parse(read('../public/locales/de.json'));
const keyIn = (key) => key.split('.').reduce((node, part) => node?.[part], de);

test('Passwort: alle Probleme zugleich, je am richtigen Feld', () => {
  assert.deepEqual(account.passwordProblems('', '', ''), [
    ['current', 'common.required'], ['next', 'common.required'], ['confirm', 'common.required'],
  ]);
  assert.deepEqual(account.passwordProblems('alt', 'kurz', 'kurz'), [['next', 'settings.passwordTooShort']]);
  assert.deepEqual(account.passwordProblems('alt', 'lang-genug', 'anders-lang'), [['confirm', 'settings.passwordMismatch']]);
  assert.deepEqual(account.passwordProblems('alt', 'lang-genug', 'lang-genug'), []);
  // Wie der Server: Zeichen der NFC-Form. 'Bär1234' sind in NFD 8 Codepoints, in NFC 7.
  assert.deepEqual(account.passwordProblems('alt', 'Bär1234'.normalize('NFD'), 'Bär1234'.normalize('NFD')),
    [['next', 'settings.passwordTooShort']]);
});

test('Passwort: nur wrong_password gehoert ans Feld, nichts anderes wird dort behauptet', () => {
  assert.equal(account.passwordRefusalKey({ status: 400, data: { reason: 'wrong_password' } }), 'settings.currentPasswordWrong');
  assert.equal(account.passwordRefusalKey({ status: 400, data: {} }), null);
  assert.equal(account.passwordRefusalKey({ status: 429 }), null);
  const handler = accountSrc.slice(accountSrc.indexOf("passwordForm?.addEventListener('submit'"));
  const body = handler.slice(0, handler.indexOf('\n  });') + 6);
  assert.doesNotMatch(body, /error\.message/, 'der Text des Servers stand englisch in der Karte');
  assert.match(body, /reportFieldError\(currentInput, t\(atField\)\)/);
  assert.match(body, /showError\(passwordError, errorSentence\(error\)\)/);
});

test('Konto-Blatt: keine Browser-Blasen - novalidate, Zeilen tragen den Feldfehler', () => {
  for (const id of ['profile-form', 'password-form', 'two-factor-enable-form', 'two-factor-confirm-form']) {
    assert.match(accountSrc, new RegExp(`<form id="${id}" class="[^"]*" novalidate>`), `${id} ohne novalidate zeigte native Blasen`);
  }
  for (const id of ['profile-display-name', 'profile-email', 'profile-birth-date', 'current-password', 'new-password', 'confirm-password']) {
    // Ein Pflichtfeld traegt dazwischen den Stern (`labelExtra: REQUIRED_MARK`).
    assert.match(accountSrc, new RegExp(`labelFor: '${id}',(?: labelExtra: REQUIRED_MARK,)? field: true`), `${id}: die Zeile traegt den Feldfehler`);
  }
  assert.match(accountSrc, /emailValue && !isEmailAddress\(emailValue\) && \[emailInput, t\('common\.emailInvalid'\)\]/);
  assert.ok(account.isEmailAddress('linda@example.org'));
  assert.ok(account.isEmailAddress('yuvomi@nas'));
  assert.equal(account.isEmailAddress('keine-mail'), false);
  assert.equal(account.isEmailAddress('a@b@c'), false);
  assert.match(accountSrc, /if \(error\?\.data\?\.reason === 'email_in_use'\) reportFieldError\(emailInput, t\('common\.emailInUse'\)\)/);
  const codeChecks = accountSrc.match(/reportFieldError\(input, t\('settings\.twoFactorCodeMissing'\)\)/g) ?? [];
  assert.equal(codeChecks.length, 2, 'beide Code-Formulare melden den fehlenden Code am Feld');
});

test('SMTP: Port 1-65535 und ein Absender mit Adresse, gesperrte Felder bleiben ungeprueft', () => {
  assert.deepEqual(smtp.emailConfigProblems({ port: '587', fromAddress: 'yuvomi@example.org' }), []);
  assert.deepEqual(smtp.emailConfigProblems({ port: '99999', fromAddress: 'keine-mail' }), [
    ['port', 'email.portInvalid'], ['fromAddress', 'common.emailInvalid'],
  ]);
  for (const port of ['0', '', '25.5', 'abc', '-1']) {
    assert.deepEqual(smtp.emailConfigProblems({ port, fromAddress: '' }), [['port', 'email.portInvalid']], `Port "${port}"`);
  }
  assert.deepEqual(smtp.emailConfigProblems({ port: '65535', fromAddress: '' }), [], 'ein leerer Absender heisst "nicht eingerichtet"');
  assert.deepEqual(smtp.emailConfigProblems({ port: '99999', fromAddress: 'x' }, { port: true, fromAddress: true }), []);
  assert.deepEqual(smtp.REFUSAL_FIELDS.email_port_invalid, ['port', 'email.portInvalid']);
  assert.deepEqual(smtp.REFUSAL_FIELDS.email_from_invalid, ['fromAddress', 'common.emailInvalid']);
});

test('SMTP: der Test nennt den Fall in der Sprache der Seite, nie den Text von nodemailer', () => {
  for (const reason of ['not_configured', 'auth', 'connection', 'tls', 'rejected']) {
    const key = smtp.testFailureKey(reason);
    assert.notEqual(key, 'email.testFailedUnknown', reason);
    assert.equal(typeof keyIn(key), 'string', `${key} fehlt in de.json`);
  }
  assert.equal(smtp.testFailureKey('__proto__'), 'email.testFailedUnknown');
  assert.equal(smtp.testFailureKey(undefined), 'email.testFailedUnknown');
  assert.doesNotMatch(smtpSrc, /res\?\.error|error\?\.message/, 'der Text des Servers kam bis auf die Seite');
  assert.match(smtpSrc, /error\?\.data\?\.reason === 'email_no_recipient'\) showNoRecipient\(\)/,
    'ohne eigene Adresse verweist der Test auf Konto -> E-Mail');
  assert.match(smtpSrc, /link\.href = ACCOUNT_PATH;/);
  assert.match(smtpSrc, /const ACCOUNT_PATH = '\/settings\/personal\/account';/);
  // Vor dem Speichern UND vor dem Test geprueft.
  assert.equal((smtpSrc.match(/if \(!validate\(\)\) return;/g) ?? []).length, 2);
});
