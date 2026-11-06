# Sign in with a passkey

Passkeys let you sign in with your device's fingerprint, face recognition, PIN or
security key, without running an external identity provider. Each household member
adds their own passkeys. Yuvomi stores the public credential, not the private key
or biometric data. Your authenticator or password manager manages the private key.

## Set up

1. Use a stable, browser-trusted HTTPS address and set `BASE_URL` to that origin,
   for example `https://planner.example.com`. Keep the usual HTTPS reverse-proxy
   settings (`SESSION_SECURE=true`, a correctly restricted `TRUST_PROXY`). Development
   on
   `http://localhost:<port>` is supported, but plain HTTP on a LAN address is not.
   Behind a reverse proxy, configuring `TRUST_PROXY` for the actual trusted proxy
   hops or addresses is required: the options limiter and anonymous challenge cap
   use `req.ip`. Otherwise everyone shares the proxy's bucket (five requests per
   minute by default, including cancelled prompts). Clients sharing a public IP
   still share a bucket even with correct proxy configuration.
2. Sign in to your existing account using its password or SSO.
3. Open **Settings > Account > Passkeys**, give the passkey a name and add it.
   Confirm on your device. Changes require a sign-in within the last five minutes;
   if asked, confirm your password or an existing passkey directly in the dialog.
   With password confirmation, enter a fresh TOTP or unused recovery code too if
   two-factor authentication is enabled. An existing UV-verified passkey needs no
   additional TOTP code. Your name input is kept and the pending action continues
   after confirmation.
   SSO-only accounts must still use their normal SSO sign-in.
4. Sign out and choose **Sign in with a passkey**. No username is needed. If your
   account has TOTP configured, password sign-in still needs that second step; a
   UV-verified passkey satisfies MFA by itself.

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
bypass account deactivation, access restrictions or the SSO-only policy. Required
user verification makes passkey sign-in an alternative MFA method alongside
password plus TOTP; it does not turn off TOTP for password or SSO sign-in.
Shared-expense guests cannot manage passkeys. A browser with an existing guest
session can still start a fresh passkey sign-in, which requires valid credential
proof before changing the signed-in identity. Native device credentials, scoped
API tokens and paired displays cannot use the passkey routes; an unscoped API
token cannot enroll a key on someone's behalf.
`PASSKEYS_ENABLED=false` disables the feature on an installation.

## Credential changes and account recovery

Changing or resetting your password, an administrator setting a password, or the
administrator's emergency device sign-out removes
all your passkeys and pending registrations. Add replacement passkeys after recovery.
This also blocks a registration already being verified when recovery happens.
Enabling TOTP keeps your passkeys and ends other sessions. It adds a parallel
authentication method, so it does not neutralize a previously planted passkey;
use the revocation or recovery flows for compromised credentials.
Removing one passkey ends your other browser sessions and native device credentials,
while keeping the current browser and remaining passkeys. Ordinary “sign out other
devices” retains passkeys; for a compromised credential use password recovery or ask
an administrator for the emergency sign-out.

Anonymous sign-in options are limited per IP, including successful responses (at
most 20/minute). New anonymous sessions and challenges expire after five minutes.
A bucket can evict only its own anonymous challenges; user-bound registration
and confirmation are never evicted by anonymous traffic.

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
Enrollment requires a current, recent browser proof; when TOTP is enabled, a
password-only proof from before setup is insufficient. Failed verification is
logged with IP and a stable reason, without passwords, codes or credential payloads;
unexpected internal failures are logged separately and return 500.

## Why a passkey can satisfy MFA

This application's policy accepts two parallel methods: password plus configured
TOTP, or a passkey with mandatory server-verified user verification. The latter
combines cryptographic key possession with local activation such as PIN or biometrics
and is bound to the relying party's origin. NIST describes the verified UV flag as
what distinguishes multi-factor from single-factor WebAuthn authenticators;
Microsoft Entra likewise recognizes PIN/biometric-activated passkeys as MFA.
This policy requires verified UV but does not require authenticator attestation.
Registering a credential
requires fresh proof through an already trusted method. A key planted before TOTP
was enabled must still be revoked; user verification authenticates its holder,
not the provenance of its original enrollment.

References: [NIST SP 800-63B-4, Syncable Authenticators](https://pages.nist.gov/800-63-4/sp800-63b/syncable/),
[Microsoft Entra passkeys](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-authentication-passkeys-fido2).
