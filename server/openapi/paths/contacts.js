import { op, jsonBody, idParam } from '../helpers.js';

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
      put: op({ summary: 'Rename contact category', tag: 'Contacts', params: [idParam('key', 'Category key')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete contact category', tag: 'Contacts', params: [idParam('key', 'Category key')], stateChanging: true }),
    },
    '/api/v1/contacts/cardav/accounts': {
      get: op({ summary: 'List CardDAV accounts', tag: 'Contacts' }),
      post: op({ summary: 'Add CardDAV account', tag: 'Contacts', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/cardav/accounts/{id}': {
      put: op({ summary: 'Update CardDAV account credentials', tag: 'Contacts', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete CardDAV account', tag: 'Contacts', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/test': {
      post: op({ summary: 'Test CardDAV connection', tag: 'Contacts', params: [idParam()] }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/addressbooks': {
      get: op({ summary: 'List addressbooks for account', tag: 'Contacts', params: [idParam()] }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/addressbooks/refresh': {
      post: op({ summary: 'Refresh addressbooks for account', tag: 'Contacts', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/cardav/addressbooks/{id}': {
      put: op({ summary: 'Toggle addressbook enabled state', tag: 'Contacts', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/sync': {
      post: op({ summary: 'Sync CardDAV account', tag: 'Contacts', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/{id}': {
      get: op({ summary: 'Get contact with multi-value fields', tag: 'Contacts', params: [idParam()] }),
      put: op({ summary: 'Update contact with multi-value fields', tag: 'Contacts', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete contact', tag: 'Contacts', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/{id}/vcard': { get: op({ summary: 'Download contact as vCard', tag: 'Contacts', params: [idParam()] }) },
  };
}
