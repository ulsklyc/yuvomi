/** Browser WebAuthn API, without a runtime frontend dependency. */
import { t } from '/i18n.js';

export function passkeysSupported() {
  return window.isSecureContext && typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials;
}
/** @param {string} value */
export function decodeBase64url(value) {
  const normal = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(normal + '='.repeat((4 - normal.length % 4) % 4)), c => c.charCodeAt(0));
}
/** @param {ArrayBuffer | Uint8Array<ArrayBuffer>} value */
export function encodeBase64url(value) {
  return btoa(Array.from(new Uint8Array(value), byte => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** @param {Credential|null} result */
function serialize(result) {
  if (!result) throw new Error(t('passkeys.cancelled'));
  const credential = /** @type {PublicKeyCredential} */ (result);
  const source = /** @type {AuthenticatorAttestationResponse | AuthenticatorAssertionResponse} */ (credential.response);
  /** @type {Record<string, string | string[]>} */
  const response = {};
  response.clientDataJSON = encodeBase64url(source.clientDataJSON);
  if ('attestationObject' in source) {
    response.attestationObject = encodeBase64url(source.attestationObject);
    if (source.getTransports) response.transports = source.getTransports();
  } else {
    response.authenticatorData = encodeBase64url(source.authenticatorData);
    response.signature = encodeBase64url(source.signature);
    if (source.userHandle != null) response.userHandle = encodeBase64url(source.userHandle);
  }
  return { id: credential.id, rawId: encodeBase64url(credential.rawId), type: credential.type,
    response, clientExtensionResults: credential.getClientExtensionResults() };
}
/** @typedef {{ id: string, type: PublicKeyCredentialType, transports?: AuthenticatorTransport[] }} CredentialDescriptorJSON */
/** @param {Omit<PublicKeyCredentialCreationOptions, 'challenge'|'user'|'excludeCredentials'> & { challenge: string, user: Omit<PublicKeyCredentialUserEntity, 'id'> & {id: string}, excludeCredentials?: CredentialDescriptorJSON[] }} options */
export async function createPasskey(options) {
  const publicKey = { ...options, challenge: decodeBase64url(options.challenge),
    user: { ...options.user, id: decodeBase64url(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map(c => ({ ...c, id: decodeBase64url(c.id) })) };
  return serialize(await navigator.credentials.create({ publicKey }));
}
/** @param {Omit<PublicKeyCredentialRequestOptions, 'challenge'|'allowCredentials'> & {challenge: string, allowCredentials?: CredentialDescriptorJSON[]}} options */
export async function usePasskey(options) {
  const publicKey = { ...options, challenge: decodeBase64url(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map(c => ({ ...c, id: decodeBase64url(c.id) })) };
  return serialize(await navigator.credentials.get({ publicKey }));
}
/** @param {unknown} value */
export function passkeyErrorText(value) {
  const error = /** @type {{name?: string, status?: number, data?: {reason?: string}} | null} */ (value);
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') return t('passkeys.cancelled');
  if (error?.name === 'InvalidStateError') return t('passkeys.alreadyRegistered');
  if (error?.data?.reason === 'passkey_reauth_required') return t('passkeys.reauthenticate');
  if (error?.data?.reason === 'passkey_policy') return t('passkeys.policy');
  if (error?.status === 429) return t('passkeys.tooManyAttempts');
  return t('passkeys.failed');
}
