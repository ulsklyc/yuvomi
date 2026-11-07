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

test('existing UV passkey confirmation sends its assertion without a second-factor code', async () => {
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
  ui.modal.code.value = '';
  globalThis.__constraintErrors = form => {
    if (form === ui.modal.form) {
      assert.equal(ui.modal.code.required, false, 'the TOTP field is optional for UV passkey proof');
      assert.equal(ui.modal.password.required, false);
    }
    return [];
  };
  try { ui.modal.passkey.handlers.click(); await pending; }
  finally { delete globalThis.__constraintErrors; }
  assert.equal(assertionProof.method, 'passkey'); assert.equal(assertionProof.code, undefined, 'UV confirmation does not send a TOTP code');
  assert.equal(assertionProof.credential.id, encoded); assert.equal(assertionProof.password, undefined);
  assert.equal(creations, 1);
});


test('password submission works while passkey config is pending and the late button stays after the form', async () => {
  const { render } = await import('../public/pages/login.js');
  const element = () => ({
    handlers:{}, value:'', hidden:true, disabled:false, isConnected:true,
    classList:{toggle(){}, remove(){}, add(){}},
    addEventListener(name, handler) { this.handlers[name] = handler; },
    setAttribute(){}, removeAttribute(){}, focus(){}, select(){}, remove(){},
    closest() { return {classList:this.classList}; },
    insertBefore(){}, querySelectorAll(){ return []; },
  });
  const username = element(); username.value = 'member';
  const password = element(); password.value = 'private-password';
  const label = element(); const submit = element(); submit.querySelector = () => label;
  const form = element(); form.username = username; form.password = password;
  form.querySelector = key => ({'#username':username, '#password':password}[key] ?? null);
  const error = element(); const caps = element(); const button = element(); const passkeyError = element();
  const card = element(); let visible = false;
  card.classList.remove = name => { if (name === 'auth-passkeys--pending') visible = true; };
  card.querySelector = key => ({'#passkey-login':button, '#passkey-login-error':passkeyError}[key]);
  const container = element();
  let markup = '';
  container.replaceChildren = () => {}; container.insertAdjacentHTML = (_position, html) => { markup = html; };
  container.querySelector = key => ({'#auth-form':form, '#auth-btn':submit, '#form-error':error, '#auth-capslock':caps, '#username':username, '.auth-card':card, '#passkey-login-slot':card}[key] ?? null);
  globalThis.localStorage = {getItem:()=>null};
  globalThis.location = {search:'', pathname:'/login'};
  globalThis.document = {querySelector:()=>null, createElement:element};
  let navigated = false;
  globalThis.window = {isSecureContext:true, location:globalThis.location, yuvomi:{navigate:()=>{navigated=true;}}};
  globalThis.PublicKeyCredential = class {};
  globalThis.fetch = async () => ({json:async()=>({enabled:false})});
  let resolveConfig; let loginArgs;
  globalThis.__apiStub = {
    get:()=>new Promise(resolve=>{resolveConfig=resolve;}),
    login:async (...args)=>{loginArgs=args; return {user:{id:1}};},
  };
  let timer;
  try {
    await Promise.race([render(container), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('render waited for passkey config')), 500); })]);
  } finally { clearTimeout(timer); }
  assert.equal(typeof form.handlers.submit, 'function', 'the handler is attached without waiting for config');
  let prevented = false;
  await form.handlers.submit({preventDefault(){prevented=true;}});
  assert.equal(prevented, true);
  assert.deepEqual(loginArgs, ['member','private-password']);
  assert.equal(navigated, true);
  resolveConfig({data:{enabled:true, login_enabled:true}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(markup.indexOf('id="passkey-login-slot"') > markup.indexOf('</form>'), 'the reserved slot starts after the password form');
  assert.equal(visible, true);
  assert.equal(button.disabled, false);
  assert.equal(typeof button.handlers.click, 'function');
  delete globalThis.__apiStub;
});


async function removalFixture(confirm = true) {
  globalThis.HTMLElement ??= class {};
  globalThis.customElements ??= {define(){},get(){}};
  const {installMiniDom}=await import('./mini-dom.js');installMiniDom();
  const {renderPasskeyCard}=await import('../public/settings/passkeys.js');
  let keys=[{id:7,name:'Lost phone'}]; const requests=[]; const events=[]; const status=node(); const button=node({dataset:{removePasskey:'7'}});
  const container={replaceChildren(){},insertAdjacentHTML(){},dispatchEvent(event){events.push(event);},
    querySelector:selector=>selector==='#passkey-status'?status:null,
    querySelectorAll:()=>keys.length?[button]:[]};
  globalThis.__confirmModal=async(message,options)=>{
    assert.equal(message,'passkeys.remove');
    assert.equal(options.detail,'passkeys.removeConfirm');
    assert.equal(options.danger,true);
    return confirm;
  };
  globalThis.__apiStub={get:async()=>({data:{enabled:true,enrollment_allowed:false,passkeys:keys}}),
    delete:async path=>{requests.push(path);keys=[];return {data:{ok:true,ended:3}};}};
  await renderPasskeyCard(container);
  await button.handlers.click();
  return {requests,events,status};
}

test('passkey removal shows the ended count and notifies the surrounding device cards', async () => {
  const ui=await removalFixture();
  assert.deepEqual(ui.requests,['/auth/passkeys/7']);
  assert.equal(ui.events.length,1);
  assert.equal(ui.events[0].type,'other-sessions-ended');
  assert.equal(ui.events[0].bubbles,true);
  assert.match(ui.status.textContent,/passkeys.removed/);
  assert.match(ui.status.textContent,/settings.otherSessionsEnded.*"count":3/);
});

test('cancelling passkey removal does not delete or notify other device cards', async () => {
  const ui=await removalFixture(false);
  assert.equal(ui.requests.length,0);assert.equal(ui.events.length,0);
});

async function passwordFixture(fail = false) {
  const {installMiniDom}=await import('./mini-dom.js');installMiniDom();
  const {__test:account}=await import('../public/settings/pages/personal-account.js');
  const form=node({reset(){this.wasReset=true;},dispatchEvent(event){this.event=event;}});const button=node();
  form.querySelector=()=>button;
  const current=node({value:'Current-password!',select(){}});const next=node({value:'Replacement-password!'});const confirm=node({value:next.value});
  const error=node({hidden:true,replaceChildren(){},classList:{remove(){},add(){}},querySelector:()=>null});
  const cardStatus=node();let markup='Stale deleted passkey';let refreshed=0;
  const card={replaceChildren(){markup='';},insertAdjacentHTML(_where,html){markup+=html;},querySelector:selector=>selector==='#passkey-status'?cardStatus:null,querySelectorAll:()=>[]};
  const fields={'#password-form':form,'#password-error':error,'#current-password':current,'#new-password':next,'#confirm-password':confirm,'#passkeys-card':card};
  const container={querySelector:selector=>fields[selector]??null,querySelectorAll:()=>[]};
  globalThis.__apiStub={patch:async()=>{if(fail)throw Object.assign(new Error('wrong'),{status:400,data:{reason:'wrong_password'}});return {ok:true};},
    get:async()=>{refreshed++;assert.equal(markup,'','stale keys are cleared before the refresh');return {data:{enabled:true,enrollment_allowed:false,passkeys:[]}};}};
  window.yuvomi={showToast(){}};
  account.bindEvents(container,{}, {avatarData:null});
  await form.handlers.submit({preventDefault(){}});
  return {form,markup,refreshed,html:account.passwordCardHtml({sso_only:false})};
}

test('password changes warn before saving and immediately clear and reload the passkey card', async () => {
  const ui=await passwordFixture();
  assert.match(ui.html,/passkeys.passwordChangeWarning/);
  assert.equal(ui.form.wasReset,true);
  assert.equal(ui.form.event.type,'other-sessions-ended');
  assert.equal(ui.refreshed,1);
  assert.equal(ui.markup.includes('Stale deleted passkey'),false);
  assert.match(ui.markup,/passkeys.empty/);
});

test('a rejected password change keeps the passkey card and emits no device event', async () => {
  const ui=await passwordFixture(true);
  assert.equal(ui.refreshed,0);
  assert.equal(ui.form.event,undefined);
  assert.equal(ui.markup,'Stale deleted passkey');
});
