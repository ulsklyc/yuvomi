import { op, idParam, withCaseReasons, withValidationRefusal } from '../helpers.js';
import { MAX_TITLE, MAX_URL } from '../../api/formats.ts';
import { SUPPORTED_PROVIDERS } from '../../services/recipe-providers/index.js';

/**
 * The address check of server/routes/recipe-providers.js as a schema pattern
 * (#2810): the route trims the value and tests `/^https?:\/\//i`. `\s` and
 * String.prototype.trim() remove the same characters (WhiteSpace and
 * LineTerminator), the letters are spelled in both cases instead of the `i`
 * flag (a pattern carries none). Empty or only spaces passes here: the route
 * answers that itself ("is required", "must not be empty", no reason) or reads
 * it as "none" (`external_url`). So the pattern fails exactly where the route
 * answers `recipe_providers_url_invalid` / `..._external_url_invalid`, and only
 * the pattern carries that reason: a value that is not text was read through
 * String() there (a list with one address was accepted, `null` was "required").
 */
const PROVIDER_URL_PATTERN = '^(?:\\s*[Hh][Tt][Tt][Pp][Ss]?://|\\s*$)';

const API_TOKEN_MAX = 500;
const ACCOUNT_ID = 'Account ID, plain decimal digits.';

/** A request body that may be left out or sent as `{}` (the app sends `{}`). */
const OPTIONAL_EMPTY_BODY = {
  required: false,
  description: 'No fields are read; the app sends `{}`. Left out is the same.',
  content: { 'application/json': { schema: { type: 'object' } } },
};

export function recipeProvidersPaths() {
  return withCaseReasons('recipe-providers', CASE_REASONS, {
    '/api/v1/recipe-providers/accounts': {
      get: op({
        summary: 'List recipe provider accounts',
        tag: 'Recipe providers',
        admin: true,
        description: 'External recipe sources (e.g. Tandoor). The API token of an account is never '
          + 'part of the response.',
      }),
      post: op({
        summary: 'Add a recipe provider account',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        description: 'Admin only; the admin check comes first, so a member gets 403 for any body. The body is then checked against the schema: '
          + '`provider` one of the supported providers (left out: `mealie`), `name`, `base_url` and `api_token` text, `external_url` text or null. '
          + 'A base or external URL that does not start with `http://` or `https://` after trimming answers 400 with its reason and `fields` naming it; '
          + 'a missing or empty field, or a text over its length, answers 400 without a reason.',
        requestBody: {
          required: true,
          description: 'JSON request body',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'base_url', 'api_token'],
                properties: {
                  provider: { type: 'string', enum: [...SUPPORTED_PROVIDERS], description: 'Left out, `mealie`.' },
                  name: { type: 'string', maxLength: MAX_TITLE, description: `At most ${MAX_TITLE} characters as sent.` },
                  base_url: {
                    type: 'string',
                    maxLength: MAX_URL,
                    pattern: PROVIDER_URL_PATTERN,
                    'x-reason': { pattern: 'recipe_providers_url_invalid' },
                    description: `The provider's address as this server reaches it, \`http://\` or \`https://\`, at most ${MAX_URL} characters as sent.`,
                  },
                  external_url: {
                    type: ['string', 'null'],
                    maxLength: MAX_URL,
                    pattern: PROVIDER_URL_PATTERN,
                    'x-reason': { pattern: 'recipe_providers_external_url_invalid' },
                    description: 'An address the browser reaches for "open at the provider" links, `http://` or `https://`. `""` or `null` means none: `base_url` serves.',
                  },
                  api_token: { type: 'string', maxLength: API_TOKEN_MAX, description: `Write-only, at most ${API_TOKEN_MAX} characters as sent; stored trimmed.` },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Account created' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { description: 'An account with this base URL already exists' },
          500: { $ref: '#/components/responses/InternalServerError' },
          502: { description: 'The provider did not accept the connection with these credentials' },
        },
      }),
    },
    '/api/v1/recipe-providers/accounts/{id}': {
      patch: withValidationRefusal(op({
        summary: 'Update a recipe provider account',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        params: [idParam('id', ACCOUNT_ID)],
        description: 'Admin only, checked first. Only the fields sent change; `{}` changes nothing. `provider`, `base_url` and `api_token` cannot be changed here and are ignored. '
          + 'The body is checked against the schema before the account is looked up: `enabled` must be a real boolean (`"false"` used to switch an account ON), `name` text, `external_url` text or null.',
        requestBody: {
          required: true,
          description: 'JSON request body',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean', description: 'Whether the account takes part in the sync.' },
                  name: { type: 'string', maxLength: MAX_TITLE, description: `At most ${MAX_TITLE} characters as sent; empty is refused.` },
                  external_url: {
                    type: ['string', 'null'],
                    maxLength: MAX_URL,
                    pattern: PROVIDER_URL_PATTERN,
                    'x-reason': { pattern: 'recipe_providers_external_url_invalid' },
                    description: '`http://` or `https://`; `""` or `null` clears it.',
                  },
                },
              },
            },
          },
        },
      })),
      delete: op({
        summary: 'Remove a recipe provider account',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        params: [idParam('id', ACCOUNT_ID)],
        description: 'Admin only. Removes the account and every recipe mirrored from it.',
        responses: {
          204: { description: 'Account removed' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'No such account' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/recipe-providers/accounts/{id}/test': {
      post: withValidationRefusal(op({
        summary: 'Test one provider connection',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        params: [idParam('id', ACCOUNT_ID)],
        requestBody: OPTIONAL_EMPTY_BODY,
        description: 'Contacts the provider once and reports whether the credentials work, so a '
          + 'wrong token surfaces here rather than as a sync that quietly imports nothing. A failed test is '
          + 'stored on the account like a failed sync and answers with `reason` and `params` next to `error` '
          + `(#1909): ${SYNC_FAILURE_REASONS}`,
      })),
    },
    '/api/v1/recipe-providers/accounts/{id}/sync': {
      post: withValidationRefusal(op({
        summary: 'Sync one provider account now',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        params: [idParam('id', ACCOUNT_ID)],
        requestBody: OPTIONAL_EMPTY_BODY,
        description: 'A provider that cannot be read answers 200 with `failed: true`, `error` (the raw message) '
          + `and, since #1909, \`reason\` and \`params\`: ${SYNC_FAILURE_REASONS}`,
      })),
    },
    '/api/v1/recipe-providers/sync': {
      post: op({
        summary: 'Sync all provider accounts now',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
      }),
    },
    '/api/v1/recipe-providers/status': {
      get: op({
        summary: 'Get sync status per provider account',
        tag: 'Recipe providers',
        description: 'Readable by every member, unlike the account endpoints: the recipes page shows '
          + '"last synchronised" per account, and this answer never carries the API token. '
          + '`lastError` is the raw message of the last failed sync or connection test, for logs and API '
          + 'clients. Since #1909 an account also carries `lastErrorReason` (string or null) and '
          + '`lastErrorParams` (object or null): the case of that failure, which the settings page turns into '
          + `its own sentence. ${SYNC_FAILURE_REASONS} Both are null without \`lastError\`, and for a failure `
          + 'stored before the update until the next sync writes its case.',
        responses: {
          200: {
            description: 'One entry per provider account, sorted by name.',
            content: { 'application/json': { schema: STATUS_RESPONSE } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
  });
}

// #1909: die Faelle eines gescheiterten Abgleichs oder Verbindungstests
// (server/services/recipe-providers/failure.js). Vor den Pfaden definiert:
// recipeProvidersPaths() liest sie beim Aufruf, nicht beim Laden.
const SYNC_FAILURE_REASONS = 'The case is one of `recipe_providers_sync_auth_failed` (the provider answered 401 or 403), '
  + '`recipe_providers_sync_wrong_url` (404, no provider API at this address), '
  + '`recipe_providers_sync_http_status` (any other status, `params.status`), '
  + '`recipe_providers_sync_timeout`, `recipe_providers_sync_unreachable` (DNS, refused or reset connection), '
  + '`recipe_providers_sync_certificate` (the TLS certificate is not trusted), '
  + '`recipe_providers_sync_bad_response` (unreadable or too large), '
  + '`recipe_providers_private_network` (the address resolves to a private network and '
  + 'RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK is not set), or null when the failure has no known case.';

const STATUS_RESPONSE = {
  type: 'object',
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          provider: { type: 'string', enum: ['mealie', 'tandoor'] },
          name: { type: 'string' },
          baseUrl: { type: 'string' },
          externalUrl: { type: ['string', 'null'] },
          enabled: { type: 'boolean' },
          lastSync: { type: ['string', 'null'], format: 'date-time' },
          lastError: { type: ['string', 'null'], description: 'The raw message of the last failed sync or connection test, for logs and API clients.' },
          lastErrorReason: { type: ['string', 'null'], description: 'The case of that failure (#1909), see the operation description. null without lastError or without a known case.' },
          lastErrorParams: {
            type: ['object', 'null'],
            additionalProperties: { type: 'integer' },
            description: 'The numbers of that case: `{ "status": 502 }` for recipe_providers_sync_http_status, otherwise null.',
          },
          recipeCount: { type: 'integer' },
        },
      },
    },
  },
};

// #1909: die Faelle, die ein Admin im Formular erreicht, tragen einen `reason`
// neben dem englischen `error` - je Operation der Satz, der sie nennt.
const ACCOUNT_GONE = '`recipe_providers_account_not_found` (404, the account was removed)';
const EXTERNAL_URL = '`recipe_providers_external_url_invalid` (400, the external URL does not start with http:// or https://)';
const CASE_REASONS = {
  '/api/v1/recipe-providers/accounts': {
    post: [
      '`recipe_providers_url_invalid` (400, the base URL does not start with http:// or https://)',
      EXTERNAL_URL,
      '`recipe_providers_private_network` (400, the base URL points to a private or local network address '
        + 'and RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK is not set)',
      '`recipe_providers_connection_failed` (502, the provider did not accept the connection with these credentials)',
      '`recipe_providers_account_exists` (409, an account with this base URL already exists)',
    ].join(', '),
  },
  '/api/v1/recipe-providers/accounts/{id}': { patch: `${ACCOUNT_GONE}, ${EXTERNAL_URL}`, delete: ACCOUNT_GONE },
  '/api/v1/recipe-providers/accounts/{id}/test': { post: ACCOUNT_GONE },
  '/api/v1/recipe-providers/accounts/{id}/sync': { post: ACCOUNT_GONE },
};
