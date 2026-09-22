import { op, jsonBody, idParam } from '../helpers.js';

export function authPaths() {
  return {
    '/api/v1/auth/login': {
      post: op({
        summary: 'Login with username and password',
        tag: 'Auth',
        auth: false,
        requestBody: jsonBody('#/components/schemas/LoginRequest'),
        responses: {
          200: {
            description: 'Authenticated user and CSRF token',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      }),
    },
    '/api/v1/auth/2fa/verify': {
      post: op({
        summary: 'Complete sign-in with a second factor',
        tag: 'Auth',
        auth: false,
        stateChanging: true,
        description: 'Second step after POST /auth/login answered with `twoFactorRequired`. '
          + 'Accepts either the six-digit TOTP code or one of the recovery codes; '
          + 'the response says which one was used. The pending sign-in expires after five minutes.',
        responses: {
          200: {
            description: 'Authenticated user and CSRF token',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } },
          },
          401: { description: 'Invalid code, or no pending sign-in' },
          429: { description: 'Too many attempts' },
        },
      }),
    },
    '/api/v1/auth/2fa': {
      get: op({
        summary: 'Two-factor state of the current user',
        tag: 'Auth',
        description: 'Returns `{ enabled, pending, recovery_remaining, required }`.',
      }),
    },
    '/api/v1/auth/2fa/setup': {
      post: op({
        summary: 'Begin two-factor setup',
        tag: 'Auth',
        stateChanging: true,
        description: 'Creates a TOTP secret and returns it as an otpauth URI plus an SVG QR code (data URL). '
          + 'Not active until confirmed via /auth/2fa/enable. Fails with 409 if two-factor is already enabled.',
        responses: {
          200: { description: 'Secret, otpauth URI and QR code' },
          409: { description: 'Two-factor authentication is already enabled' },
        },
      }),
    },
    '/api/v1/auth/2fa/enable': {
      post: op({
        summary: 'Confirm and activate two-factor authentication',
        tag: 'Auth',
        stateChanging: true,
        description: 'Confirms the pending setup with a code from the authenticator app and returns the '
          + 'recovery codes in plain text - the only time they are readable. All other sessions of this user are ended.',
        responses: {
          200: { description: 'Recovery codes' },
          400: { description: 'Invalid code' },
          409: { description: 'No pending setup, or already enabled' },
        },
      }),
    },
    '/api/v1/auth/2fa/disable': {
      post: op({
        summary: 'Turn off two-factor authentication',
        tag: 'Auth',
        stateChanging: true,
        description: 'Requires a valid second factor (TOTP or recovery code), not the password: '
          + 'OIDC accounts have none, and against a hijacked session only the factor itself helps. '
          + 'Blocked with 403 while the household requires two-factor authentication.',
        responses: {
          200: { description: 'New two-factor state' },
          400: { description: 'Invalid code' },
          403: { description: 'The household requires two-factor authentication' },
          409: { description: 'Two-factor authentication is not enabled' },
        },
      }),
    },
    '/api/v1/auth/2fa/recovery-codes': {
      post: op({
        summary: 'Replace the recovery codes',
        tag: 'Auth',
        stateChanging: true,
        description: 'Discards every existing recovery code, used or not, and returns a fresh set. '
          + 'Requires a valid second factor.',
        responses: {
          200: { description: 'New recovery codes' },
          400: { description: 'Invalid code' },
          409: { description: 'Two-factor authentication is not enabled' },
        },
      }),
    },
    '/api/v1/auth/2fa/require': {
      put: op({
        summary: 'Require two-factor authentication household-wide (admin)',
        tag: 'Auth',
        admin: true,
        stateChanging: true,
        description: 'Blocks turning two-factor authentication off and shows a notice on every account '
          + 'page without one. Deliberately does not reject existing sessions: in a household where '
          + 'nobody has set it up yet, that would lock everyone out, including the admin. '
          + 'A separate route rather than a field on PUT /preferences, so the admin gate is middleware '
          + 'rather than a branch inside the handler.',
      }),
    },
    '/api/v1/auth/2fa/overview': {
      get: op({
        summary: 'Who in the household has two-factor authentication (admin)',
        tag: 'Auth',
        admin: true,
        description: 'Per member the plain yes/no state, plus whether the household requires it. '
          + 'Deliberately a separate endpoint from /auth/users, which every member may read.',
      }),
    },
    '/api/v1/auth/logout': {
      post: op({ summary: 'Logout current session', tag: 'Auth', stateChanging: true }),
    },
    '/api/v1/auth/logout-others': {
      post: op({
        summary: 'Sign out all other sessions',
        tag: 'Auth',
        stateChanging: true,
        description: 'Ends every browser session of the signed-in user except the calling one (#1354) and '
          + 'answers `{ ok: true, ended }` with the number of sessions ended. Only a browser session may call '
          + 'it: an API token or a wall display has no current session to keep and gets 403. API tokens and '
          + 'paired wall displays are not sessions and stay valid; revoke them under API tokens and Displays.',
        responses: {
          200: { description: 'Other sessions ended; `ended` is their number' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          429: { description: 'Too many requests' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/auth/oidc/config': {
      get: op({
        summary: 'Get sign-in availability',
        tag: 'Auth',
        auth: false,
        description: 'Public login-page bootstrap endpoint. Returns which ways in this server offers: '
          + 'whether OIDC is configured and enabled, and whether password login is allowed '
          + '(AUTH_ALLOW_PASSWORD_LOGIN, ignored unless OIDC is fully configured). The login page waits '
          + 'for this single answer before painting, so it never shows a form that then disappears. '
          + 'guest_password_login_enabled is true only where password login is off AND the household '
          + 'actually has split-expense guests, who are exempt from the switch (#847) because they are '
          + 'external people with no account in the household identity provider. It is one bit and says '
          + 'nothing about who or how many; where password login is open the question is moot and the '
          + 'field is false.',
      }),
    },
    '/api/v1/auth/oidc/start': {
      get: op({
        summary: 'Start OIDC login',
        tag: 'Auth',
        auth: false,
        description: 'Redirects the browser to the configured OIDC provider. State, nonce, and PKCE verifier are stored in the session.',
        responses: {
          302: { description: 'Redirect to OIDC provider' },
          404: { description: 'OIDC is not configured' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/auth/oidc/callback': {
      get: op({
        summary: 'Handle OIDC callback',
        tag: 'Auth',
        auth: false,
        description: 'Consumes the OIDC callback, validates state/nonce/PKCE, creates or finds the linked user, establishes a session, and redirects back to the app. With OIDC_ALLOW_SIGNUP=false an identity that matches no existing account is redirected to /login?error=oidc_signup_disabled instead of being provisioned.',
        responses: {
          302: { description: 'Redirect to app or login error page' },
        },
      }),
    },
    '/api/v1/auth/oidc/link': {
      get: op({
        summary: 'Get OIDC link status of the current account',
        tag: 'Auth',
        description: 'Whether OIDC is configured, whether this account is linked, which provider it is linked to, and whether the link may be removed. Removal is refused while the link is the only way into the account (an account created through SSO carries no password).',
      }),
      delete: op({
        summary: 'Remove the OIDC link of the current account',
        tag: 'Auth',
        stateChanging: true,
        responses: {
          409: { description: 'Not linked, or the account has no password and would lose its only way in' },
        },
      }),
    },
    '/api/v1/auth/oidc/link/start': {
      post: op({
        summary: 'Start linking an OIDC account to the current account',
        tag: 'Auth',
        stateChanging: true,
        description: 'Returns the provider authorization URL for the browser to follow. Deliberately a POST with CSRF protection: as a plain link, a forged request could attach an attacker-owned identity to the signed-in session.',
        responses: {
          200: { description: 'Authorization URL to follow' },
          404: { description: 'OIDC is not configured' },
          409: { description: 'Account is already linked' },
        },
      }),
    },
    '/api/v1/auth/setup': {
      post: op({
        summary: 'Initial setup: create first admin',
        tag: 'Auth',
        auth: false,
        requestBody: jsonBody('#/components/schemas/SetupRequest'),
        responses: {
          201: { description: 'Admin user created' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { description: 'Username already taken' },
        },
      }),
    },
    '/api/v1/auth/forgot-password': {
      post: op({
        summary: 'Request a password-reset link',
        description: 'Always responds 200 with a generic body to prevent account enumeration. '
          + 'A reset email is sent only when the account exists, has a linked email, SMTP is configured, and BASE_URL is set.',
        tag: 'Auth',
        auth: false,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['identifier'],
                properties: { identifier: { type: 'string', description: 'Username or email address.' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Generic acknowledgement (sent regardless of whether the account exists).' },
        },
      }),
    },
    '/api/v1/auth/reset-password': {
      post: op({
        summary: 'Set a new password using a reset token',
        tag: 'Auth',
        auth: false,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token', 'password'],
                properties: {
                  token: { type: 'string' },
                  password: { type: 'string', minLength: 8 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Password updated.' },
          400: { $ref: '#/components/responses/BadRequest' },
        },
      }),
    },
    '/api/v1/auth/invites': {
      get: op({
        summary: 'List pending invitations',
        tag: 'Auth',
        admin: true,
        description: 'Returns invitations that are still open: neither accepted, nor revoked, nor expired. Token hashes are never included.',
        responses: {
          200: {
            description: 'Pending invitations',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/InvitesResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Create an invitation',
        tag: 'Auth',
        admin: true,
        stateChanging: true,
        description: 'Creates an invite link so a new member can set their own password. Role and family role are fixed here and are taken from the invitation when it is accepted.',
        requestBody: jsonBody('#/components/schemas/InviteCreateRequest'),
        responses: {
          201: {
            description: 'Invitation created. The plaintext token is returned only once.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/InviteCreateResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { description: 'Username already taken' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/auth/invites/{id}': {
      delete: op({
        summary: 'Revoke an invitation',
        tag: 'Auth',
        admin: true,
        stateChanging: true,
        description: 'Revokes a pending invitation. The row is kept as a record of who invited whom; only invitations that are still open can be revoked.',
        params: [idParam('id', 'Invite ID')],
        responses: {
          200: { description: 'Invitation revoked.' },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'No pending invitation with this ID' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/auth/invites/preview': {
      get: op({
        summary: 'Preview an invitation',
        tag: 'Auth',
        auth: false,
        description: 'Public bootstrap endpoint for the /join page. Rate-limited. Unknown, expired, accepted, and revoked tokens all return valid: false rather than an error, so the endpoint reveals nothing beyond whether the token can still be used.',
        params: [{
          name: 'token',
          in: 'query',
          required: true,
          description: 'Plaintext invite token from the invitation link.',
          schema: { type: 'string' },
        }],
        responses: {
          200: {
            description: 'Invitation state plus the names it pre-assigns.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/InvitePreviewResponse' } } },
          },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/auth/invites/accept': {
      post: op({
        summary: 'Accept an invitation and create the account',
        tag: 'Auth',
        auth: false,
        description: 'Public endpoint, rate-limited, no CSRF: the token is the secret. Role and family role come from the invitation and cannot be raised through the request body. No session is established; the client redirects to the login page.',
        requestBody: jsonBody('#/components/schemas/InviteAcceptRequest'),
        responses: {
          201: { description: 'Account created.' },
          400: { $ref: '#/components/responses/BadRequest' },
          409: { description: 'Username already taken' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/auth/me': {
      get: op({
        summary: 'Get current authenticated user',
        tag: 'Auth',
        responses: {
          200: {
            description: 'Current user',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MeResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      }),
    },
    '/api/v1/auth/onboarding-seen': {
      post: op({
        summary: 'Mark the onboarding walkthrough as seen',
        tag: 'Auth',
        stateChanging: true,
        description: 'Records the current onboarding version on the calling account, so the '
          + 'walkthrough does not reappear on another device or in a private window. Affects only '
          + 'the calling account and takes no body.',
      }),
    },
    '/api/v1/auth/changelog-seen': {
      post: op({
        summary: 'Mark the changelog as seen by the calling account',
        tag: 'Auth',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Records two marks on the calling account: the INSTALLED version, taken from '
          + 'the server rather than the body because a client could claim the wrong one, and the '
          + 'last known PUBLISHED version from the optional `{ latest }` body. They answer different '
          + 'questions - what changed in this installation since the last look, and whether '
          + 'something newer exists at all. An absent `latest` leaves the stored value alone rather '
          + 'than clearing it. Affects only the calling account.',
      }),
    },
    '/api/v1/auth/me/password': {
      patch: op({
        summary: 'Change current user password',
        tag: 'Auth',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/PasswordChangeRequest'),
      }),
    },
    '/api/v1/auth/me/profile': {
      patch: op({
        summary: 'Update current user profile',
        tag: 'Auth',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/ProfileUpdateRequest'),
      }),
    },
    '/api/v1/auth/users': {
      get: op({
        summary: 'List family users',
        tag: 'Auth',
        description: 'Authenticated endpoint used for assignment pickers. Returns public user fields for all family members. '
          + 'Administrators additionally get sso_only per member; how someone else signs in is not a detail every '
          + 'member needs, for the same reason the 2FA overview is a separate admin endpoint.',
      }),
      post: op({
        summary: 'Create user',
        tag: 'Auth',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/UserCreateRequest'),
        responses: {
          201: { description: 'User created' },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { description: 'Username already taken' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/auth/users/{id}': {
      patch: op({
        summary: 'Update user',
        tag: 'Auth',
        admin: true,
        stateChanging: true,
        params: [idParam('id', 'User ID')],
        requestBody: jsonBody('#/components/schemas/UserUpdateRequest'),
      }),
      delete: op({
        summary: 'Delete user',
        tag: 'Auth',
        admin: true,
        stateChanging: true,
        params: [idParam('id', 'User ID')],
      }),
    },
    '/api/v1/auth/api-tokens': {
      get: op({ summary: 'List API tokens', tag: 'Auth', admin: true }),
      post: op({
        summary: 'Create API token',
        description: 'Creates a credential whose creator remains the audit owner. An administrator may select a non-guest family member as its subject; token requests then use that member identity and permissions.',
        tag: 'Auth',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/ApiTokenCreateRequest'),
        responses: {
          201: {
            description: 'API token created. The plaintext token is returned only once.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiTokenCreateResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/auth/api-tokens/{id}': {
      delete: op({
        summary: 'Revoke API token',
        tag: 'Auth',
        admin: true,
        stateChanging: true,
        params: [idParam('id', 'API token ID')],
      }),
    },
  };
}
