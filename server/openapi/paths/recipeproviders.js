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
          + 'wrong token surfaces here rather than as a sync that quietly imports nothing.',
      }),
    },
    '/api/v1/recipe-providers/accounts/{id}/sync': {
      post: op({
        summary: 'Sync one provider account now',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        params: [idParam()],
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
          + '"last synchronised" per account, and this answer never carries the API token.',
      }),
    },
  });
}

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
