import { op, jsonBody, idParam, stringPathParam } from '../helpers.js';

export function contactsPaths() {
  return {
    '/api/v1/contacts': {
      get: op({ summary: 'List contacts', tag: 'Contacts' }),
      post: op({ summary: 'Create contact with multi-value fields', tag: 'Contacts', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/meta': { get: op({ summary: 'Get contact metadata', tag: 'Contacts' }) },
    '/api/v1/contacts/categories': {
      get: op({ summary: 'List contact categories', tag: 'Contacts' }),
      post: op({ summary: 'Create contact category', tag: 'Contacts', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/categories/reorder': {
      patch: op({ summary: 'Reorder contact categories', tag: 'Contacts', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/categories/{key}': {
      put: op({ summary: 'Rename or recolor contact category', tag: 'Contacts', params: [stringPathParam('key', 'Category key')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete contact category', tag: 'Contacts', params: [stringPathParam('key', 'Category key')], stateChanging: true }),
    },
    '/api/v1/contacts/cardav/accounts': {
      get: op({ summary: 'List CardDAV accounts', tag: 'Contacts', admin: true }),
      post: op({ summary: 'Add CardDAV account', tag: 'Contacts', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/cardav/accounts/{id}': {
      put: op({
        summary: 'Update CardDAV account credentials',
        tag: 'Contacts',
        admin: true,
        description: 'An empty `password` keeps the stored one, but only while the server (scheme, host and port) and the `username` stay the same. A different server or username without a new password is refused with 400 and `errorCode: password_required`, and nothing is saved. A different path on the same server needs no password.',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
      delete: op({ summary: 'Delete CardDAV account', tag: 'Contacts', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/test': {
      post: op({ summary: 'Test CardDAV connection', tag: 'Contacts', admin: true, params: [idParam()] }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/addressbooks': {
      get: op({ summary: 'List addressbooks for account', tag: 'Contacts', admin: true, params: [idParam()] }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/addressbooks/refresh': {
      post: op({ summary: 'Refresh addressbooks for account', tag: 'Contacts', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/cardav/addressbooks/{id}': {
      put: op({ summary: 'Toggle addressbook enabled state', tag: 'Contacts', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/sync': {
      post: op({ summary: 'Sync CardDAV account', tag: 'Contacts', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/{id}': {
      get: op({ summary: 'Get contact with multi-value fields', tag: 'Contacts', params: [idParam()] }),
      put: op({
        summary: 'Update contact with multi-value fields',
        tag: 'Contacts',
        description: 'On a contact linked to an account (`family_user_id`), `email` and `emails` can only be changed by that member or an admin, in a session or with an unscoped token; anyone else, and any token scoped to modules, is refused with 403. Addresses are compared without regard to letter case; sending them unchanged or only in another case is not a change, and the stored spelling is kept. When the member edits their own linked contact, a newly added address that already belongs to another account (split-expense guests excluded) is refused with 409 and `reason: "email_in_use"`; an admin may assign it. All other fields stay editable for anyone with write access to contacts.',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        responses: {
          200: { description: 'Successful response' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { description: 'A newly added email address already belongs to another account (`reason: "email_in_use"`)' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({ summary: 'Delete contact', tag: 'Contacts', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/{id}/vcard': { get: op({ summary: 'Download contact as vCard', tag: 'Contacts', params: [idParam()] }) },
  };
}
