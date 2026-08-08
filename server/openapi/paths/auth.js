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
    '/api/v1/auth/logout': {
      post: op({ summary: 'Logout current session', tag: 'Auth', stateChanging: true }),
    },
    '/api/v1/auth/oidc/config': {
      get: op({
        summary: 'Get OIDC login availability',
        tag: 'Auth',
        auth: false,
        description: 'Public login-page bootstrap endpoint. Returns whether OIDC is configured and enabled.',
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
        description: 'Consumes the OIDC callback, validates state/nonce/PKCE, creates or finds the linked user, establishes a session, and redirects back to the app.',
        responses: {
          302: { description: 'Redirect to app or login error page' },
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
        description: 'Authenticated endpoint used for assignment pickers. Returns public user fields for all family members.',
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
