import test from 'node:test';
import assert from 'node:assert/strict';
import { createPasskey, usePasskey, decodeBase64url, encodeBase64url, passkeysSupported } from '../public/utils/passkeys.js';

const bytes = new Uint8Array([0, 255, 250, 1, 2, 3]);
const encoded = 'AP_6AQID';
globalThis.window = { isSecureContext: true };
globalThis.PublicKeyCredential = class {};
let received;
const credential = {
  id: encoded, rawId: bytes.buffer, type: 'public-key',
  response: { clientDataJSON: bytes.buffer, attestationObject: bytes.buffer, getTransports: () => ['internal'] },
  getClientExtensionResults: () => ({}),
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  credentials: { create: async value => { received = value; return credential; }, get: async value => { received = value; return credential; } },
} });

test('base64url bytes round-trip without losing zero or high bytes', () => {
  assert.equal(encodeBase64url(bytes), encoded);
  assert.deepEqual(decodeBase64url(encoded), bytes);
});
test('registration converts challenge, handle and exclusion IDs and serializes the result', async () => {
  const response = await createPasskey({ challenge: encoded, user: { id: encoded, name: 'name' }, excludeCredentials: [{ id: encoded, type: 'public-key' }] });
  assert.deepEqual(received.publicKey.challenge, bytes);
  assert.deepEqual(received.publicKey.user.id, bytes);
  assert.deepEqual(received.publicKey.excludeCredentials[0].id, bytes);
  assert.equal(response.response.clientDataJSON, encoded);
  assert.deepEqual(response.response.transports, ['internal']);
});
test('sign-in keeps discoverable credentials and serializes nullable handles', async () => {
  credential.response = { clientDataJSON: bytes.buffer, authenticatorData: bytes.buffer, signature: bytes.buffer, userHandle: bytes.buffer };
  const response = await usePasskey({ challenge: encoded, userVerification: 'required' });
  assert.deepEqual(received.publicKey.allowCredentials, []);
  assert.equal(received.publicKey.userVerification, 'required');
  assert.equal(response.response.signature, encoded);
  assert.equal(response.response.userHandle, encoded);
});
test('insecure or unsupported browsers do not advertise passkey support', () => {
  assert.equal(passkeysSupported(), true);
  window.isSecureContext = false; assert.equal(passkeysSupported(), false);
  window.isSecureContext = true; delete globalThis.PublicKeyCredential;
  assert.equal(passkeysSupported(), false);
});

// Exercise the real account-card handlers and dialog with controlled DOM/API
// boundaries. No authenticator is created when confirmation is cancelled.
function node(extra = {}) {
  return { disabled:false, value:'', handlers:{}, addEventListener(type, fn) { this.handlers[type] = fn; }, ...extra };
}
async function inlineFixture() {
  globalThis.HTMLElement ??= class {};
  globalThis.customElements ??= { define() {}, get() {} };
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const { installMiniDom } = await import('./mini-dom.js'); installMiniDom();
  window.isSecureContext = true; globalThis.PublicKeyCredential = class {};
  const { renderPasskeyCard } = await import('../public/settings/passkeys.js');
  const name = node({ value:'My Bitwarden key' }); const button = node(); const status = node();
  const form = node({ querySelector: selector => selector === 'button' ? button : name });
  const container = { replaceChildren() {}, insertAdjacentHTML() {}, querySelectorAll: () => [],
    querySelector: selector => selector === '#passkey-add-form' ? form : status };
  let modal;
  globalThis.__openModal = options => {
    const password = node({ required:true }); const code = node(); const modalStatus = node();
    const modalForm = node(); const confirm = node(); const passkey = node();
    const fields = { '#passkey-reauth-form':modalForm, '#passkey-reauth-password':password,
      '#passkey-reauth-code':code, '#passkey-reauth-status':modalStatus, '#passkey-reauth-use':passkey };
    modal = { ...options, password, code, status:modalStatus, form:modalForm, passkey };
    options.onSave({ querySelector: key => fields[key], querySelectorAll: () => [confirm, passkey] });
  };
  globalThis.__closeModal = () => modal.onClose();
  await renderPasskeyCard(container);
  const submit = () => form.handlers.submit({ preventDefault() {}, currentTarget:form });
  const settle = async () => { for (let n=0; n<10; n++) await new Promise(resolve => setImmediate(resolve)); };
  return { name, button, status, submit, settle, get modal() { return modal; } };
}
const stale = () => Object.assign(new Error('stale'), { data:{reason:'passkey_reauth_required'}, status:403 });
const ownState = { enabled:true, enrollment_allowed:true, passkeys:[], second_factor_required:false };

test('inline password confirmation retains the name and resumes registration once', async () => {
  let confirmed = false; const requests = []; let creations = 0;
  navigator.credentials.create = async () => { creations++; return credential; };
  globalThis.__apiStub = {
    get: async () => ({ data:ownState }),
    post: async (path, body) => {
      requests.push({ path, body });
      if (path.endsWith('/reauth/verify')) { assert.equal(body.password, 'test-only'); confirmed = true; return {data:{ok:true}}; }
      if (path.endsWith('/register/options')) { if (!confirmed) throw stale(); return {data:{challenge:encoded, user:{id:encoded}}}; }
      return {data:{ok:true}};
    },
  };
  const ui = await inlineFixture(); const pending = ui.submit(); await ui.settle();
  assert.equal(ui.modal.title, 'passkeys.reauthTitle'); assert.equal(creations, 0);
  assert.equal(ui.name.value, 'My Bitwarden key');
  ui.modal.password.value = 'test-only'; ui.modal.form.handlers.submit({preventDefault(){}});
  await pending;
  assert.equal(creations, 1);
  assert.equal(requests.find(r => r.path.endsWith('/register/verify')).body.name, 'My Bitwarden key');
  assert.equal(ui.modal.password.value, '', 'entered password is cleared');
});

test('cancelling inline confirmation keeps input and never creates a credential', async () => {
  let creations = 0; navigator.credentials.create = async () => { creations++; return credential; };
  const paths = [];
  globalThis.__apiStub = { get:async () => ({data:ownState}), post:async path => { paths.push(path); throw stale(); } };
  const ui = await inlineFixture(); const pending = ui.submit(); await ui.settle();
  ui.modal.onClose(); await pending;
  assert.equal(creations, 0); assert.equal(paths.length, 1);
  assert.equal(ui.name.value, 'My Bitwarden key'); assert.equal(ui.button.disabled, false);
});

test('wrong confirmation stays in the dialog; closing during verification does not resume the change', async () => {
  let resolveProof; let creations = 0;
  navigator.credentials.create = async () => { creations++; return credential; };
  globalThis.__apiStub = {
    get:async () => ({data:ownState}),
    post:async path => {
      if (path.endsWith('/reauth/verify')) throw Object.assign(new Error(), {data:{reason:'passkey_failed'},status:400});
      throw stale();
    },
  };
  const ui = await inlineFixture(); const pending = ui.submit(); await ui.settle();
  ui.modal.password.value = 'wrong'; ui.modal.form.handlers.submit({preventDefault(){}}); await ui.settle();
  assert.equal(ui.modal.status.textContent, 'passkeys.reauthFailed'); assert.equal(creations, 0);
  globalThis.__apiStub.post = async () => new Promise(resolve => { resolveProof = resolve; });
  ui.modal.password.value = 'correct'; ui.modal.form.handlers.submit({preventDefault(){}}); await ui.settle();
  ui.modal.onClose(); resolveProof({data:{ok:true}}); await pending; await ui.settle();
  assert.equal(creations, 0); assert.equal(ui.name.value, 'My Bitwarden key');
});

test('existing passkey confirmation sends its assertion and second factor before resuming', async () => {
  let confirmed = false; let assertionProof; let creations = 0;
  navigator.credentials.create = async () => { creations++; return credential; };
  navigator.credentials.get = async () => credential;
  globalThis.__apiStub = {
    get:async () => ({data:{...ownState, passkeys:[{id:7,name:'Existing key'}], second_factor_required:true}}),
    post:async (path, body) => {
      if (path.endsWith('/reauth/options')) return {data:{challenge:encoded,allowCredentials:[{id:encoded}]}};
      if (path.endsWith('/reauth/verify')) { assertionProof = body; confirmed = true; return {data:{ok:true}}; }
      if (path.endsWith('/register/options')) { if (!confirmed) throw stale(); return {data:{challenge:encoded,user:{id:encoded}}}; }
      return {data:{ok:true}};
    },
  };
  const ui = await inlineFixture(); const pending = ui.submit(); await ui.settle();
  assert.match(ui.modal.content, /passkeys.confirmWithPasskey/);
  ui.modal.code.value = '123456'; ui.modal.passkey.handlers.click(); await pending;
  assert.equal(assertionProof.method, 'passkey'); assert.equal(assertionProof.code, '123456');
  assert.equal(assertionProof.credential.id, encoded); assert.equal(assertionProof.password, undefined);
  assert.equal(creations, 1);
});
