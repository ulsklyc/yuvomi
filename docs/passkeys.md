# Sign in with a passkey

Passkeys let you sign in with your device's fingerprint, face recognition, PIN or
security key, without running an external identity provider. Each household member
adds their own passkeys. Yuvomi stores the public credential, not the private key
or biometric data. Your authenticator or password manager manages the private key.

## Set up

1. Use a stable, browser-trusted HTTPS address and set `BASE_URL` to that origin,
   for example `https://planner.example.com`. Keep the usual HTTPS reverse-proxy
   settings (`SESSION_SECURE=true`, appropriate `TRUST_PROXY`). Development on
   `http://localhost:<port>` is supported, but plain HTTP on a LAN address is not.
2. Sign in to your existing account using its password or SSO.
3. Open **Settings > Account > Passkeys**, give the passkey a name and add it.
   Confirm on your device. Changes require a sign-in within the last five minutes;
   if asked, confirm your password or an existing passkey directly in the dialog.
   Enter a fresh TOTP or unused recovery code too if two-factor authentication is
   enabled. Your name input is kept and the pending action continues after confirmation.
   SSO-only accounts must still use their normal SSO sign-in.
4. Sign out and choose **Sign in with a passkey**. No username is needed. If your
   account already has a TOTP second factor, the existing second step still applies.

You can register up to ten passkeys per account. Use more than one authenticator
or a passkey provider with a recovery mechanism you understand. Keep your existing
password or linked SSO as a recovery path; this first version does not create
passkey-only accounts or change the invitation flow. The account page lists names
and last-use dates, and lets you remove your own keys after a recent sign-in.

## Existing household policies

`AUTH_ALLOW_PASSWORD_LOGIN=false` is the existing SSO-only policy. While it is
effective, native passkey sign-in and enrollment are disabled for household members,
just as native password sign-in is; the existing external-expense guest exception
still applies. Accounts explicitly configured as SSO-only also cannot enroll or
use native passkeys, independently of the household-wide switch. A passkey does not
bypass account deactivation, access restrictions or the existing two-factor gate. Scoped API tokens and paired displays cannot
manage passkeys, nor can an unscoped API token enroll a key on someone's behalf.
`PASSKEYS_ENABLED=false` disables the feature on an installation.

## Addresses and recovery

A passkey belongs to a relying party (the hostname). A hostname change requires
registering new keys at the new address; a database restore cannot change that
binding. `BASE_URL` is the authority, never a request's Host header. A backup of
Yuvomi retains the public credentials but cannot replace a lost authenticator.
Sign in using your retained password or SSO to add a replacement.

For a browser without WebAuthn support, password and SSO keep working. A cancelled
or timed-out prompt is retryable. If your device says the key is already registered,
use another authenticator or remove the existing registration first.

## Implementation

The server uses `@simplewebauthn/server`; the browser uses the native WebAuthn API
without a runtime frontend package. Discoverable credentials and user verification
are required. Registration and assertion challenges last five minutes, are bound
to the browser session and purpose, and are consumed in SQLite before verification.
Sign-in regenerates the session using the same helper as password and OIDC sign-in.
Registration and removal require session authentication, CSRF and recent sign-in;
all WebAuthn POSTs require the configured Origin.

Inline confirmation preserves the signed-in identity, session ID and CSRF token.
Its passkey challenge is bound to the current account as well as the session;
it cannot be exchanged with an anonymous sign-in challenge. Failed or cancelled
confirmation never resumes the pending change. Password and passkey confirmation
share the existing sign-in rate limit and enforce the current native sign-in policy.
