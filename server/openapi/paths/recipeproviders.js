import { op, jsonBody, idParam } from '../helpers.js';

export function recipeProvidersPaths() {
  return withCaseReasons({
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
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/recipe-providers/accounts/{id}': {
      patch: op({
        summary: 'Update a recipe provider account',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        params: [idParam()],
        requestBody: jsonBody(null),
      }),
      delete: op({
        summary: 'Remove a recipe provider account',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        params: [idParam()],
      }),
    },
    '/api/v1/recipe-providers/accounts/{id}/test': {
      post: op({
        summary: 'Test one provider connection',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        params: [idParam()],
        description: 'Contacts the provider once and reports whether the credentials work, so a '
          + 'wrong token surfaces here rather than as a sync that quietly imports nothing. A failed test is '
          + 'stored on the account like a failed sync and answers with `reason` and `params` next to `error` '
          + `(#1909): ${SYNC_FAILURE_REASONS}`,
      }),
    },
    '/api/v1/recipe-providers/accounts/{id}/sync': {
      post: op({
        summary: 'Sync one provider account now',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        params: [idParam()],
        description: 'A provider that cannot be read answers 200 with `failed: true`, `error` (the raw message) '
          + `and, since #1909, \`reason\` and \`params\`: ${SYNC_FAILURE_REASONS}`,
      }),
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

function withCaseReasons(paths) {
  for (const [path, operations] of Object.entries(CASE_REASONS)) {
    for (const [method, reasons] of Object.entries(operations)) {
      const operation = paths[path]?.[method];
      if (!operation) throw new Error(`openapi recipe-providers: ${method} ${path} is not documented`);
      const note = `A refusal a user can reach carries a \`reason\` next to \`error\` (#1909): ${reasons}.`;
      operation.description = operation.description ? `${operation.description}\n\n${note}` : note;
    }
  }
  return paths;
}
