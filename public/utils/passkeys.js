/** Browser WebAuthn API, without a runtime frontend dependency. */
import { t } from '/i18n.js';

export function passkeysSupported() {
  return window.isSecureContext && typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials;
}
export function decodeBase64url(value) {
  const normal = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(normal + '='.repeat((4 - normal.length % 4) % 4)), c => c.charCodeAt(0));
}
export function encodeBase64url(value) {
  return btoa(Array.from(new Uint8Array(value), byte => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function serialize(credential) {
  if (!credential) throw new Error(t('passkeys.cancelled'));
  const response = {};
  for (const key of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']) {
    if (credential.response[key] != null) response[key] = encodeBase64url(credential.response[key]);
  }
  if (credential.response.getTransports) response.transports = credential.response.getTransports();
  return { id: credential.id, rawId: encodeBase64url(credential.rawId), type: credential.type,
    response, clientExtensionResults: credential.getClientExtensionResults() };
}
export async function createPasskey(options) {
  const publicKey = { ...options, challenge: decodeBase64url(options.challenge),
    user: { ...options.user, id: decodeBase64url(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map(c => ({ ...c, id: decodeBase64url(c.id) })) };
  return serialize(await navigator.credentials.create({ publicKey }));
}
export async function usePasskey(options) {
  const publicKey = { ...options, challenge: decodeBase64url(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map(c => ({ ...c, id: decodeBase64url(c.id) })) };
  return serialize(await navigator.credentials.get({ publicKey }));
}
export function passkeyErrorText(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') return t('passkeys.cancelled');
  if (error?.name === 'InvalidStateError') return t('passkeys.alreadyRegistered');
  if (error?.data?.reason === 'passkey_reauth_required') return t('passkeys.reauthenticate');
  if (error?.data?.reason === 'passkey_policy') return t('passkeys.policy');
  if (error?.data?.reason === 'passkey_last_method') return t('passkeys.lastMethod');
  if (error?.status === 429) return t('passkeys.tooManyAttempts');
  return t('passkeys.failed');
}
