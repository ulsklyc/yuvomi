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
